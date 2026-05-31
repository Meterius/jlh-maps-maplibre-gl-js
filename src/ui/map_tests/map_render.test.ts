import {beforeEach, afterEach, test, expect, vi} from 'vitest';
import {createMap, beforeMapTest, createStyle, sleep} from '../../util/test/util';
import {fakeServer, type FakeServer} from 'nise';
import {browser} from '../../util/browser';

let server: FakeServer;

beforeEach(() => {
    beforeMapTest();
    global.fetch = null;
    server = fakeServer.create();
});

afterEach(() => {
    server.restore();
});

test('render stabilizes', async () => {
    const style = createStyle();
    style.sources.maplibre = {
        type: 'vector',
        minzoom: 1,
        maxzoom: 10,
        tiles: ['http://example.com/{z}/{x}/{y}.png']
    };
    style.layers.push({
        id: 'layerId',
        type: 'circle',
        source: 'maplibre',
        'source-layer': 'sourceLayer'
    });

    let timer;
    const map = createMap({style});
    const spy = vi.fn();
    map.on('render', () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            map.off('render', undefined);
            map.on('render', () => {
                throw new Error('test failed');
            });
            expect((map as any)._frameId).toBeFalsy();
            spy();
        }, 100);
    });
    await sleep(700);
    expect(spy).toHaveBeenCalled();
});

test('no render after idle event', async () => {
    const style = createStyle();
    const map = createMap({style});
    await map.once('idle');
    const spy = vi.fn();
    map.on('render', spy);
    await sleep(100);
    expect(spy).not.toHaveBeenCalled();
});

test('no render before style loaded', async () => {
    server.respondWith('/styleUrl', JSON.stringify(createStyle()));
    const map = createMap({style: '/styleUrl'});

    vi.spyOn(map, 'triggerRepaint').mockImplementationOnce(() => {
        if (!map.style._loaded) {
            throw new Error('test failed');
        }
    });

    let loaded = true;
    map.on('render', () => {
        loaded = map.style._loaded;
    });

    // Force a update should not call triggerRepaint till style is loaded.
    // Once style is loaded, it will trigger the update.
    map._update();
    expect(loaded).toBeTruthy();
    server.respond();
    expect(loaded).toBeTruthy();
});

test('redraw', async () => {
    const map = createMap();

    await map.once('idle');
    const renderPromise = map.once('render');

    map.redraw();
    await renderPromise;
});

test('renderCompositeHook defers present until hook resolves', async () => {
    const map = createMap({style: createStyle()});
    await map.once('idle');

    let resolveHook!: () => void;
    const hookPromise = new Promise<void>(resolve => { resolveHook = resolve; });
    const renderCompositeHook = vi.fn((_transform: unknown) => hookPromise);
    map.setRenderCompositeHook(renderCompositeHook);

    const renderSpy = vi.spyOn(map.painter, 'render').mockImplementation((_style, options) => {
        expect(options.deferPresent).toBe(true);
        map.painter.renderTargetFramebuffers = [{destroy: vi.fn()} as any];
    });
    const presentSpy = vi.spyOn(map.painter, 'present').mockImplementation(() => {});

    map._render(0);

    expect(renderCompositeHook).toHaveBeenCalledTimes(1);
    expect(renderCompositeHook.mock.calls[0][0]).not.toBe(map.transform);
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(presentSpy).not.toHaveBeenCalled();

    resolveHook();
    await sleep(0);

    expect(presentSpy).toHaveBeenCalled();

    map.remove();
});

test('redraw aborts pending composite present and starts a new render', async () => {
    const map = createMap({style: createStyle()});
    await map.once('idle');

    const hookResolves: Array<() => void> = [];
    map.setRenderCompositeHook(vi.fn(() => new Promise<void>(resolve => {
        hookResolves.push(resolve);
    })));

    const renderSpy = vi.spyOn(map.painter, 'render').mockImplementation((_style, options) => {
        expect(options.deferPresent).toBe(true);
        map.painter.renderTargetFramebuffers = [{destroy: vi.fn()} as any];
    });
    const presentSpy = vi.spyOn(map.painter, 'present').mockImplementation(() => {});

    map._render(0);
    map.redraw();

    expect(renderSpy).toHaveBeenCalledTimes(2);

    hookResolves[0]();
    await sleep(0);
    expect(presentSpy).not.toHaveBeenCalled();

    hookResolves[1]();
    await sleep(0);
    expect(presentSpy).toHaveBeenCalledTimes(1);

    map.remove();
});

test('triggerRepaint waits for pending composite present before scheduling the next render', async () => {
    const map = createMap({style: createStyle()});
    await map.once('idle');

    let resolveFirstHook!: () => void;
    let hookCallCount = 0;
    map.setRenderCompositeHook(vi.fn(() => {
        hookCallCount++;
        if (hookCallCount === 1) {
            return new Promise<void>(resolve => { resolveFirstHook = resolve; });
        }
        return Promise.resolve();
    }));

    const renderSpy = vi.spyOn(map.painter, 'render').mockImplementation((_style, options) => {
        expect(options.deferPresent).toBe(true);
        map.painter.renderTargetFramebuffers = [{destroy: vi.fn()} as any];
    });
    const presentSpy = vi.spyOn(map.painter, 'present').mockImplementation(() => {});
    let scheduledFrame: ((paintStartTimestamp: number) => void) | undefined;
    const frameSpy = vi.spyOn(browser, 'frame').mockImplementation((_abortController, frame) => {
        scheduledFrame = frame;
    });

    map._render(0);
    map.triggerRepaint();

    expect(frameSpy).not.toHaveBeenCalled();
    expect(renderSpy).toHaveBeenCalledTimes(1);

    resolveFirstHook();
    await sleep(0);

    expect(presentSpy).toHaveBeenCalled();
    expect(frameSpy).toHaveBeenCalledTimes(1);
    expect(renderSpy).toHaveBeenCalledTimes(1);

    expect(scheduledFrame).toBeDefined();
    scheduledFrame(0);
    expect(renderSpy).toHaveBeenCalledTimes(2);

    frameSpy.mockRestore();
    map.remove();
});

test('triggerRepaint from render task queue waits for composite present', async () => {
    const map = createMap({style: createStyle()});
    await map.once('idle');

    let resolveHook!: () => void;
    map.setRenderCompositeHook(vi.fn(() => {
        return new Promise<void>(resolve => { resolveHook = resolve; });
    }));

    vi.spyOn(map.painter, 'render').mockImplementation((_style, options) => {
        expect(options.deferPresent).toBe(true);
        map.painter.renderTargetFramebuffers = [{destroy: vi.fn()} as any];
    });
    const presentSpy = vi.spyOn(map.painter, 'present').mockImplementation(() => {});
    const frameSpy = vi.spyOn(browser, 'frame').mockImplementation(() => {});

    map._renderTaskQueue.add(() => {
        map.triggerRepaint();
    });

    map._render(0);

    expect(frameSpy).not.toHaveBeenCalled();

    resolveHook();
    await sleep(0);

    expect(presentSpy).toHaveBeenCalled();
    expect(frameSpy).toHaveBeenCalledTimes(1);

    frameSpy.mockRestore();
    map.remove();
});

test('triggerRepaint from renderCompositeHook waits for pending composite present', async () => {
    const map = createMap({style: createStyle()});
    await map.once('idle');

    let resolveHook!: () => void;
    map.setRenderCompositeHook(vi.fn(() => {
        map.triggerRepaint();
        return new Promise<void>(resolve => { resolveHook = resolve; });
    }));

    vi.spyOn(map.painter, 'render').mockImplementation((_style, options) => {
        expect(options.deferPresent).toBe(true);
        map.painter.renderTargetFramebuffers = [{destroy: vi.fn()} as any];
    });
    const presentSpy = vi.spyOn(map.painter, 'present').mockImplementation(() => {});
    const frameSpy = vi.spyOn(browser, 'frame').mockImplementation(() => {});

    map._render(0);

    expect(frameSpy).not.toHaveBeenCalled();

    resolveHook();
    await sleep(0);

    expect(presentSpy).toHaveBeenCalled();
    expect(frameSpy).toHaveBeenCalledTimes(1);

    frameSpy.mockRestore();
    map.remove();
});
