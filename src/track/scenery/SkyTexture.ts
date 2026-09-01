import { EquirectangularReflectionMapping, SRGBColorSpace, TextureLoader, type Texture } from 'three';

/**
 * The painted sky, as an equirectangular panorama.
 *
 * The only file in the game that is not generated from numbers. Everything else
 * here — circuits, craft, scenery, the water's normals, the interface — is built
 * at load time on purpose, and this is a deliberate exception rather than the
 * start of a pipeline: a hand-painted sky sets a mood that a gradient and a noise
 * function cannot, and it is the one asset the player looks at for the whole
 * race. If a second one ever turns up, it needs a better reason than this.
 *
 * It is 8-bit sRGB, not an HDR probe, so it carries no sun energy. The
 * directional sun stays exactly where it was; the panorama supplies the look of
 * the sky and the structure in every reflection, not the light.
 */
const SKY_URL = 'sky/sky-42-2k.png';

let cached: Promise<Texture> | null = null;
let loaded: Texture | null = null;

/** Loads the sky once and hands the same texture to everyone who asks. */
export function loadSkyTexture(): Promise<Texture> {
  cached ??= new Promise<Texture>((resolve, reject) => {
    new TextureLoader().load(
      SKY_URL,
      (texture) => {
        // Equirectangular, so it works as a background, as a reflection source
        // and as the input to the pre-filtered probe without three re-encodings.
        texture.mapping = EquirectangularReflectionMapping;
        texture.colorSpace = SRGBColorSpace;
        texture.name = 'sky-panorama';
        loaded = texture;
        resolve(texture);
      },
      undefined,
      reject,
    );
  });
  return cached;
}

/**
 * The sky, if it has finished loading, and null if it has not.
 *
 * Scene construction is synchronous and the load is not, so everything that
 * wants the panorama has to be able to carry on without it. In practice the
 * load is awaited during start-up, before any scene exists.
 */
export function skyTexture(): Texture | null {
  return loaded;
}
