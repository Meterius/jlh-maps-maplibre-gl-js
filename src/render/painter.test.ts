import {describe, beforeEach, test, expect, vi} from 'vitest';
import {Painter} from './painter';
import {MercatorTransform} from '../geo/projection/mercator_transform';
import {Style} from '../style/style';
import {StubMap} from '../util/test/util';
import {Texture} from '../webgl/texture';
import {ColorMode} from '../webgl/color_mode';

describe('render', () => {
    let painter: Painter;
    let map: any;
    let style: Style;
    const renderOptions = {
        fadeDuration: 0,
        moving: false,
        rotating: false,
        showOverdrawInspector: false,
        showPadding: false,
        showTileBoundaries: false,
        zooming: false,
        anisotropicFilterPitch: 20,
    };

    beforeEach(() => {
        const gl = document.createElement('canvas').getContext('webgl');
        const transform = new MercatorTransform({minZoom: 0, maxZoom: 22, minPitch: 0, maxPitch: 60, renderWorldCopies: true});
        transform.resize(512, 512);
        painter = new Painter(gl, transform);
        map = new StubMap() as any;
        style = new Style(map);
        style._setProjectionInternal('mercator');
        style._updatePlacement(transform, false, 0, false);
        painter.style = style;
    });

    test('must not fail with incompletely loaded style', () => {
        painter.render(style, renderOptions);
    });

    test('calls terrainDepth but not terrainCoords', () => {
        const terrainDepth = vi.spyOn(painter.drawFunctions, 'terrainDepth').mockImplementation(() => {});
        const terrainCoords = vi.spyOn(painter.drawFunctions, 'terrainCoords').mockImplementation(() => {});
        map.terrain = {tileManager: {anyTilesAfterTime: () => false}};

        painter.render(style, renderOptions);

        expect(terrainDepth).toHaveBeenCalled();
        expect(terrainCoords).not.toHaveBeenCalled();
    });

    test('deferred present uses a fallback render target without composite layers', () => {
        vi.spyOn(painter.context.gl, 'checkFramebufferStatus').mockReturnValue(painter.context.gl.FRAMEBUFFER_COMPLETE);

        painter.render(style, {...renderOptions, deferPresent: true});

        expect(painter.renderTargetFramebuffers).toHaveLength(1);
        expect(painter.nextPresentOptions).toEqual({
            renderOptions: {isRenderingToTexture: false, isRenderingGlobe: false},
            compositeLayersToRenderTarget: [[]],
        });
    });

    test('syncs render target framebuffers to required composite segment count', () => {
        vi.spyOn(painter.context.gl, 'checkFramebufferStatus').mockReturnValue(painter.context.gl.FRAMEBUFFER_COMPLETE);
        painter.resize(64, 32, 2);

        painter._syncRenderTargetFramebuffers(2);

        expect(painter.renderTargetFramebuffers).toHaveLength(2);
        expect(painter.renderTargetFramebuffers[0].width).toBe(128);
        expect(painter.renderTargetFramebuffers[0].height).toBe(64);
        expect(painter.renderTargetFramebuffer).toBe(painter.renderTargetFramebuffers[0]);

        painter.resize(32, 16, 1);

        expect(painter.renderTargetFramebuffers[0].width).toBe(32);
        expect(painter.renderTargetFramebuffers[0].height).toBe(16);

        painter._syncRenderTargetFramebuffers(0);

        expect(painter.renderTargetFramebuffers).toHaveLength(0);
        expect(painter.renderTargetFramebuffer).toBeNull();
    });

    test('includes hidden composite separators when preparing present options', () => {
        const hiddenSeparator = {
            type: 'custom',
            implementation: {compositeSeperator: true},
            isHidden: () => true,
        };
        painter.style = {
            _layers: {
                hiddenSeparator,
            },
        } as any;

        expect((painter as any)._createPresentOptions(['hiddenSeparator'], {isRenderingToTexture: false, isRenderingGlobe: false}, false)).toEqual({
            renderOptions: {isRenderingToTexture: false, isRenderingGlobe: false},
            compositeLayersToRenderTarget: [[], []],
        });
    });

    test('prepares a single render target when present is deferred without composite layers', () => {
        painter.style = {
            _layers: {},
        } as any;

        expect((painter as any)._createPresentOptions([], {isRenderingToTexture: false, isRenderingGlobe: false}, true)).toEqual({
            renderOptions: {isRenderingToTexture: false, isRenderingGlobe: false},
            compositeLayersToRenderTarget: [[]],
        });
    });

    test('assigns non-separator composite layers to the current render target', () => {
        const separator = {
            type: 'custom',
            implementation: {compositeSeperator: true},
        };
        const beforeSeparatorComposite = {
            type: 'custom',
            implementation: {renderComposite: () => {}},
        };
        const afterSeparatorComposite = {
            type: 'custom',
            implementation: {renderComposite: () => {}},
        };
        painter.style = {
            _layers: {
                beforeSeparatorComposite,
                separator,
                afterSeparatorComposite,
            },
        } as any;

        expect((painter as any)._createPresentOptions([
            'beforeSeparatorComposite',
            'separator',
            'afterSeparatorComposite',
        ], {isRenderingToTexture: false, isRenderingGlobe: false}, false)).toEqual({
            renderOptions: {isRenderingToTexture: false, isRenderingGlobe: false},
            compositeLayersToRenderTarget: [['beforeSeparatorComposite'], ['afterSeparatorComposite']],
        });
    });

    test('present composites render targets with the present program and alpha blending', () => {
        const texture = {} as WebGLTexture;
        const drawSpy = vi.fn();
        const useProgramSpy = vi.spyOn(painter, 'useProgram').mockReturnValue({draw: drawSpy} as any);

        painter._drawRenderTargetFramebuffer({
            colorAttachment: {
                get: () => texture,
            },
        } as any);

        expect(useProgramSpy).toHaveBeenCalledWith('present', null, true);
        expect(drawSpy.mock.calls[0][4]).toBe(ColorMode.alphaBlended);
    });

    test('present throws without prepared present options', () => {
        expect(() => painter.present()).toThrow('Cannot present without prepared present options');
    });

    test('present consumes prepared present options', () => {
        painter.nextPresentOptions = {
            renderOptions: {isRenderingToTexture: false, isRenderingGlobe: false},
            compositeLayersToRenderTarget: [],
        };

        painter.present();

        expect(painter.nextPresentOptions).toBeNull();
    });
});

describe('tile texture pool', () => {
    function createPainterWithPool() {
        const gl = document.createElement('canvas').getContext('webgl');
        const transform = new MercatorTransform({minZoom: 0, maxZoom: 22, minPitch: 0, maxPitch: 60, renderWorldCopies: true});
        return new Painter(gl, transform);
    }

    function createTexture(painter: Painter, size: number): Texture {
        const gl = painter.context.gl;
        const image = {width: size, height: size, data: new Uint8Array(size * size * 4)} as any;
        return new Texture(painter.context, image, gl.RGBA);
    }

    test('saveTileTexture caps pool size and destroys excess', () => {
        const painter = createPainterWithPool();
        const cap = Painter.MAX_TEXTURE_POOL_SIZE_PER_BUCKET;

        const textures: Texture[] = [];
        for (let i = 0; i < cap + 100; i++) {
            const tex = createTexture(painter, 256);
            textures.push(tex);
            painter.saveTileTexture(tex);
        }

        let reused = 0;
        while (painter.getTileTexture(256)) reused++;
        expect(reused).toBe(cap);

        const destroyed = textures.filter(t => t.texture === null).length;
        expect(destroyed).toBe(100);

        painter.destroy();
    });
});
