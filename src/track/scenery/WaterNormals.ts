import { DataTexture, LinearMipmapLinearFilter, LinearFilter, RGBAFormat, RepeatWrapping, UnsignedByteType } from 'three';
import { Rng } from '@/core/Rng';

/** Edge length of the generated map. Power of two so it mipmaps cleanly. */
const SIZE = 256;
/** Octaves of value noise summed into the height field. */
const OCTAVES = 4;
/** How much the surface is bumped. Higher is choppier. */
const RELIEF = 3.4;

/**
 * Builds the tiling normal map the ocean shader samples.
 *
 * Three's `WaterMesh` expects a repeating water normal texture, and its own
 * example loads a JPEG for it. Generating it instead keeps the promise that the
 * repository has no binary assets, and costs a few milliseconds at load.
 *
 * The noise is periodic by construction — the lattice wraps modulo its own
 * period — so the map tiles seamlessly. A non-tiling noise would put a visible
 * grid across an ocean the size of this one.
 */
export function createWaterNormals(): DataTexture {
  const height = new Float32Array(SIZE * SIZE);

  for (let octave = 0; octave < OCTAVES; octave++) {
    // Each octave is a coarser lattice, interpolated up and added at half the
    // amplitude of the one before it.
    const period = 8 << octave;
    const amplitude = 1 / (1 << octave);
    const lattice = buildLattice(period, 0x0cea1 + octave * 977);

    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        height[y * SIZE + x]! += sampleLattice(lattice, period, (x / SIZE) * period, (y / SIZE) * period) * amplitude;
      }
    }
  }

  const data = new Uint8Array(SIZE * SIZE * 4);
  const at = (x: number, y: number): number => height[(((y % SIZE) + SIZE) % SIZE) * SIZE + (((x % SIZE) + SIZE) % SIZE)]!;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // Central differences give the slope; the normal is the cross product of
      // the two tangents, which for a height field reduces to (-dx, -dy, 1).
      const dx = (at(x + 1, y) - at(x - 1, y)) * RELIEF;
      const dy = (at(x, y + 1) - at(x, y - 1)) * RELIEF;
      const length = Math.hypot(dx, dy, 1);

      const i = (y * SIZE + x) * 4;
      data[i] = Math.round((-dx / length * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((1 / length * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((-dy / length * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }

  const texture = new DataTexture(data, SIZE, SIZE, RGBAFormat, UnsignedByteType);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** A periodic grid of random values, seeded so the map is identical every run. */
function buildLattice(period: number, seed: number): Float32Array {
  const rng = new Rng(seed);
  const lattice = new Float32Array(period * period);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng.next() * 2 - 1;
  return lattice;
}

/** Smoothstep-interpolated lattice lookup, wrapping at the period. */
function sampleLattice(lattice: Float32Array, period: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  // Smoothstep the weights: linear interpolation leaves visible lattice creases.
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);

  const wrap = (v: number): number => ((v % period) + period) % period;
  const ix0 = wrap(x0);
  const iy0 = wrap(y0);
  const ix1 = wrap(x0 + 1);
  const iy1 = wrap(y0 + 1);

  const v00 = lattice[iy0 * period + ix0]!;
  const v10 = lattice[iy0 * period + ix1]!;
  const v01 = lattice[iy1 * period + ix0]!;
  const v11 = lattice[iy1 * period + ix1]!;

  const top = v00 + (v10 - v00) * sx;
  const bottom = v01 + (v11 - v01) * sx;
  return top + (bottom - top) * sy;
}
