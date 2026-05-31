import {Uniform1i} from '../uniform_binding';

import type {Context} from '../../webgl/context';
import type {UniformValues, UniformLocations} from '../uniform_binding';

export type PresentUniformsType = {
    'u_texture': Uniform1i;
};

const presentUniforms = (context: Context, locations: UniformLocations): PresentUniformsType => ({
    'u_texture': new Uniform1i(context, locations.u_texture)
});

const presentUniformValues = (textureUnit: number): UniformValues<PresentUniformsType> => ({
    'u_texture': textureUnit
});

export {presentUniforms, presentUniformValues};
