import { attribute, float, mix, vec3 } from 'three/tsl';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import type { BufferGeometry } from 'three';
import { buildRibbon, type ProfilePoint } from '../TrackRibbon';
import type { Track } from '../Track';
import { wrap } from '@/core/math';

/** Height of plain paint above the road surface, in metres. */
export const PAINT_LIFT = 0.035;
/** And of the lit paint, which is always drawn over it. */
export const GLOW_LIFT = 0.05;

/**
 * Which of the seven segments each character lights, as a bit field.
 *
 * Bits run A (top), B (upper right), C (lower right), D (bottom), E (lower
 * left), F (upper left), G (middle) — the order every seven-segment part has
 * used since the 1970s, which is worth keeping even here, where the segments
 * are quads of road paint rather than a display.
 *
 * Sixteen characters, because seven segments can draw hexadecimal and nothing
 * else: the panel codes painted along the circuit are hex for the same reason a
 * real one would be, which is that it is what the hardware can say.
 */
const SEGMENT_A = 1;
const SEGMENT_B = 2;
const SEGMENT_C = 4;
const SEGMENT_D = 8;
const SEGMENT_E = 16;
const SEGMENT_F = 32;
const SEGMENT_G = 64;
const GLYPHS: Record<string, number> = {
  '0': 63,
  '1': 6,
  '2': 91,
  '3': 79,
  '4': 102,
  '5': 109,
  '6': 125,
  '7': 7,
  '8': 127,
  '9': 111,
  A: 119,
  B: 124,
  C: 57,
  D: 94,
  E: 121,
  F: 113,
};

/** How a run of characters is cut. All metres. */
export interface TextOptions {
  /** Cap height, measured along the road. */
  height: number;
  /** Width of one character, measured across it. */
  width: number;
  stroke: number;
  /** Gap between characters. */
  spacing?: number;
}

/**
 * One painted rectangle: `halfLength` metres of road either side of `s`,
 * between two lateral offsets.
 *
 * Swept along the centreline rather than laid out flat, so the paint banks and
 * crests with the surface it is painted on — a flat quad on a rise sinks into
 * the road at both ends. An infinite offset means the road edge, so a bar drawn
 * edge to edge stays edge to edge wherever the road happens to be widest.
 */
export function stripe(
  track: Track,
  s: number,
  halfLength: number,
  from: number,
  to: number,
  accent: number,
): BufferGeometry {
  const up = accent > 0 ? GLOW_LIFT : PAINT_LIFT;
  const profile: ProfilePoint[] = [
    from === -Infinity
      ? { anchor: 'left', offset: 0, up, u: 0, accent }
      : { anchor: 'centre', offset: from, up, u: 0, accent },
    to === Infinity
      ? { anchor: 'right', offset: 0, up, u: 1, accent }
      : { anchor: 'centre', offset: to, up, u: 1, accent },
  ];

  return buildRibbon(track, {
    profile,
    step: 1.2,
    colourByDistrict: true,
    range: {
      fromS: wrap(s - halfLength, track.length),
      toS: wrap(s + halfLength, track.length),
    },
  });
}

/**
 * A run of characters, drawn as seven segments each.
 *
 * Reads upright to whoever is coming up the road behind it, which is also the
 * chase camera's view: the character's own up axis is the direction of travel
 * and the run advances across the road to the right.
 */
export function paintText(
  track: Track,
  s: number,
  lateral: number,
  text: string,
  options: TextOptions,
  accent = 1,
): BufferGeometry[] {
  const spacing = options.spacing ?? options.width * 0.3;
  const advance = options.width + spacing;
  const halfHeight = options.height * 0.5;
  const halfWidth = options.width * 0.5;
  const characters = [...text.toUpperCase()];
  const pieces: BufferGeometry[] = [];

  // Centred on `lateral`, so a code sits where it is asked to sit whatever it
  // happens to say.
  let pen = lateral - ((characters.length - 1) * advance) / 2;

  for (const character of characters) {
    const mask = GLYPHS[character];
    if (mask === undefined) {
      pen += advance;
      continue;
    }
    const centre = pen;

    /** A segment across the character: a bar of paint at height `at`. */
    const across = (at: number): BufferGeometry =>
      stripe(track, s + at, options.stroke * 0.5, centre - halfWidth, centre + halfWidth, accent);

    /** A segment up one side, from `fromV` to `toV`. */
    const along = (side: number, fromV: number, toV: number): BufferGeometry => {
      const edge = centre + side * halfWidth;
      const inner = edge - side * options.stroke;
      return stripe(
        track,
        s + (fromV + toV) * 0.5,
        (toV - fromV) * 0.5,
        Math.min(edge, inner),
        Math.max(edge, inner),
        accent,
      );
    };

    const half = options.stroke * 0.5;
    if (mask & SEGMENT_A) pieces.push(across(halfHeight - half));
    if (mask & SEGMENT_D) pieces.push(across(-halfHeight + half));
    if (mask & SEGMENT_G) pieces.push(across(0));
    if (mask & SEGMENT_F) pieces.push(along(-1, half, halfHeight));
    if (mask & SEGMENT_B) pieces.push(along(1, half, halfHeight));
    if (mask & SEGMENT_E) pieces.push(along(-1, -halfHeight, -half));
    if (mask & SEGMENT_C) pieces.push(along(1, -halfHeight, -half));

    pen += advance;
  }

  return pieces;
}

/**
 * White paint, with the accent channel switching a stripe over to the
 * district's colour and lighting it.
 *
 * Lettering glows and plain paint does not. A grid box is paint; a position or
 * a panel code is signage, and on a white circuit under a white sun paint alone
 * would not survive the bloom.
 */
export function paintMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  const accent = attribute<'vec4'>('color', 'vec4');

  material.colorNode = mix(vec3(0.95, 0.96, 0.97), accent.xyz.mul(0.35), accent.w);
  material.emissiveNode = accent.xyz.mul(accent.w).mul(1.5);
  material.roughnessNode = mix(float(0.6), float(0.34), accent.w);
  material.metalnessNode = float(0.02);
  material.vertexColors = true;
  return material;
}
