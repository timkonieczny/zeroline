import { DataTexture, LinearMipmapLinearFilter, LinearFilter, RGBAFormat, RepeatWrapping, UnsignedByteType } from 'three';
import { Rng } from '@/core/Rng';
import { clamp01, smoothstep } from '@/core/math';

/** Edge length of the generated map. */
const SIZE = 512;
/** Tiles across one repeat of the map. */
const TILES = 4;
/** Width of the grout line, as a fraction of a tile. */
const GROUT = 0.022;
/** Depth of the grout, in normal-map terms. */
const GROUT_RELIEF = 2.6;
/** How pitted the tile faces are. */
const GRAIN_RELIEF = 0.35;
/** Fraction of the floor covered in standing water. */
const PUDDLE_COVERAGE = 0.2;

/**
 * The showroom floor's surface: a normal map with a puddle mask ridden along in
 * the blue channel.
 *
 * Packing the two together is not a trick, it is the point. A puddle is not a
 * separate decal on top of the tiles — it is the place where the tile relief is
 * flooded flat and the reflection takes over, and both facts come from the same
 * mask. Sampling one texture keeps them in register for free.
 *
 * Red and green carry the tangent-space normal; blue is wetness, 0 dry and 1
 * standing water. Generated at load, like everything else in this game.
 */
export function createFloorSurface(): DataTexture {
  const rng = new Rng(0xf100_1234);

  // Low-frequency field that decides where the water pools.
  const pondPeriod = 6;
  const pond = new Float32Array(pondPeriod * pondPeriod);
  for (let i = 0; i < pond.length; i++) pond[i] = rng.next();

  // Fine grain, so a dry tile is not glassy.
  const grainPeriod = 128;
  const grain = new Float32Array(grainPeriod * grainPeriod);
  for (let i = 0; i < grain.length; i++) grain[i] = rng.next() * 2 - 1;

  const height = new Float32Array(SIZE * SIZE);
  const wetness = new Float32Array(SIZE * SIZE);

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE;
      const v = y / SIZE;

      // Tile relief: flat faces separated by a recessed joint.
      const tu = (u * TILES) % 1;
      const tv = (v * TILES) % 1;
      const edge = Math.min(Math.min(tu, 1 - tu), Math.min(tv, 1 - tv));
      const joint = 1 - smoothstep(0, GROUT, edge);

      const speck = sampleTiling(grain, grainPeriod, u * grainPeriod, v * grainPeriod) * GRAIN_RELIEF;
      height[y * SIZE + x] = -joint * GROUT_RELIEF + speck;

      // Puddles: a smooth field thresholded, so they have soft, irregular edges.
      const pool = sampleTiling(pond, pondPeriod, u * pondPeriod, v * pondPeriod);
      wetness[y * SIZE + x] = smoothstep(1 - PUDDLE_COVERAGE - 0.12, 1 - PUDDLE_COVERAGE + 0.12, pool);
    }
  }

  const data = new Uint8Array(SIZE * SIZE * 4);
  const at = (x: number, y: number): number =>
    height[(((y % SIZE) + SIZE) % SIZE) * SIZE + (((x % SIZE) + SIZE) % SIZE)]!;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      const wet = clamp01(wetness[i]!);

      // Standing water flattens whatever is under it.
      const flatten = 1 - wet * 0.92;
      const dx = (at(x + 1, y) - at(x - 1, y)) * flatten;
      const dy = (at(x, y + 1) - at(x, y - 1)) * flatten;
      const length = Math.hypot(dx, dy, 1);

      const o = i * 4;
      data[o] = Math.round((-dx / length * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round((-dy / length * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round(wet * 255);
      data[o + 3] = 255;
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

/** Smoothstep-interpolated lookup into a periodic lattice. */
function sampleTiling(lattice: Float32Array, period: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
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
