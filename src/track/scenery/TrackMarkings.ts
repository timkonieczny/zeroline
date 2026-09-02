import { Group, Mesh, type BufferGeometry } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { paintMaterial, paintText, stripe } from './RoadPaint';
import type { Track } from '../Track';
import { Rng } from '@/core/Rng';
import { wrap, wrapDelta } from '@/core/math';

/** Metres between one marking and the next, before the jitter. */
const GAP_MIN = 58;
const GAP_MAX = 190;

/**
 * Metres of clear road demanded around a speed pad or a weapon pad.
 *
 * Those two are the only paint on the circuit a driver has to read at speed, so
 * nothing else is allowed near enough to be mistaken for them or to clutter the
 * approach to one.
 */
const PAD_CLEARANCE = 30;
/**
 * And around the start line: the grid runs seventy metres back from it and is
 * already the busiest paint on the circuit.
 */
const START_CLEAR_BEHIND = 96;
const START_CLEAR_AHEAD = 26;

/** Width of a marking's stroke, in metres. */
const STROKE = 0.16;
/** How the panel codes are cut. All metres. */
const CODE = { height: 1.15, width: 0.62, stroke: 0.15, spacing: 0.24 };
/**
 * How strongly a code glows, 0..1.
 *
 * Under the grid numbers, which are signage a driver is meant to find. These
 * are stencilling: legible from a metre away and texture from a hundred.
 */
const CODE_GLOW = 0.5;

/** Hexadecimal, because seven segments cannot say anything else. */
const HEX = '0123456789ABCDEF';

/** One piece of stencilling, before it is any geometry. */
export interface Marking {
  s: number;
  lateral: number;
  kind: 'hatch' | 'run' | 'zone';
  code: string;
}

/**
 * Where the stencilling goes, and what it says.
 *
 * Separate from building it so the rules that matter — clear of both kinds of
 * pad, clear of the grid, spread across the road — can be checked without a
 * GPU. They are easy to break silently: a marking laid over a speed pad is not
 * an error, it just quietly makes the pad harder to read.
 */
export function planMarkings(track: Track): Marking[] {
  const rng = new Rng(0x4a1c2e);
  const out: Marking[] = [];

  for (let s = 0; s < track.length; s += rng.range(GAP_MIN, GAP_MAX)) {
    if (!clearOfPads(track, s)) continue;

    // Anywhere but the middle third, which is where the racing line lives on a
    // straight and where the eye is already busy.
    const halfWidth = track.frameAt(s).width * 0.5;
    const side = rng.next() < 0.5 ? -1 : 1;
    const lateral = side * rng.range(0.34, 0.82) * halfWidth;

    const kind = (['hatch', 'run', 'zone'] as const)[rng.int(3)]!;
    const length = rng.next() < 0.35 ? 3 : 4;
    let code = '';
    for (let i = 0; i < length; i++) code += HEX[rng.int(HEX.length)];

    out.push({ s, lateral, kind, code });
  }

  return out;
}

/** True where a marking may be laid: clear of both kinds of pad, and of the grid. */
function clearOfPads(track: Track, s: number): boolean {
  const behind = wrapDelta(track.startS, s, track.length);
  if (behind > -START_CLEAR_BEHIND && behind < START_CLEAR_AHEAD) return false;

  for (const pad of [...track.boostPads, ...track.pickupPads]) {
    const gap = Math.abs(wrapDelta(pad.s, s, track.length));
    if (gap < PAD_CLEARANCE + pad.halfLength) return false;
  }
  return true;
}

/**
 * The stencilling a circuit accumulates when people have to maintain it.
 *
 * Access hatches, cable runs and marked-out zones, each with a panel code
 * beside it — none of it means anything, and that is the point: a race circuit
 * that carries no evidence of being a real structure reads as a model of one.
 * It is laid at irregular intervals and at whatever lateral offset the seed
 * picks, because a service marking has no reason to line up with the racing.
 *
 * Everything here is paint swept along the centreline, exactly like the grid,
 * and it is placed from a fixed seed rather than from `Math.random`, so a
 * circuit looks the same every time it is loaded.
 */
export class TrackMarkings {
  readonly group = new Group();

  constructor(track: Track) {
    this.group.name = 'track-markings';

    const mesh = new Mesh(TrackMarkings.build(track), paintMaterial());
    mesh.name = 'maintenance-paint';
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  dispose(): void {
    for (const object of this.group.children) {
      if (!(object instanceof Mesh)) continue;
      object.geometry.dispose();
      (object.material as { dispose(): void }).dispose();
    }
  }

  private static build(track: Track): BufferGeometry {
    const pieces: BufferGeometry[] = [];

    for (const marking of planMarkings(track)) {
      const { s, lateral, code } = marking;
      if (marking.kind === 'hatch') pieces.push(...TrackMarkings.hatch(track, s, lateral, code));
      else if (marking.kind === 'run') pieces.push(...TrackMarkings.run(track, s, lateral, code));
      else pieces.push(...TrackMarkings.zone(track, s, lateral, code));
    }

    return mergeGeometries(pieces, false)!;
  }

  // --- The three kinds -----------------------------------------------------

  /** An access hatch: a square lid with its grating drawn as rungs. */
  private static hatch(track: Track, s: number, lateral: number, code: string): BufferGeometry[] {
    const halfLength = 1.35;
    const halfWidth = 1.15;
    const pieces = TrackMarkings.outline(track, s, lateral, halfLength, halfWidth);

    for (const at of [-0.62, 0, 0.62]) {
      pieces.push(
        stripe(
          track,
          s + at,
          STROKE * 0.4,
          lateral - halfWidth + 0.34,
          lateral + halfWidth - 0.34,
          0,
        ),
      );
    }

    pieces.push(
      ...paintText(track, s + halfLength + 1.15, lateral, code, CODE, CODE_GLOW),
    );
    return pieces;
  }

  /** A cable run: a long narrow duct with joints ticked off along it. */
  private static run(track: Track, s: number, lateral: number, code: string): BufferGeometry[] {
    const halfLength = 3.6;
    const halfWidth = 0.62;
    const pieces = TrackMarkings.outline(track, s, lateral, halfLength, halfWidth);

    for (const at of [-1.8, 0, 1.8]) {
      pieces.push(stripe(track, s + at, STROKE * 0.5, lateral - halfWidth, lateral + halfWidth, 0));
    }

    // Beside it rather than ahead of it: a duct is read along its length.
    const offset = lateral + Math.sign(lateral || 1) * -(halfWidth + 1.35);
    pieces.push(...paintText(track, s, offset, code, CODE, CODE_GLOW));
    return pieces;
  }

  /** A marked-out zone: four corner brackets with the code in the middle. */
  private static zone(track: Track, s: number, lateral: number, code: string): BufferGeometry[] {
    const halfLength = 2.6;
    const halfWidth = 1.9;
    const arm = 0.85;
    const pieces: BufferGeometry[] = [];

    for (const endSide of [-1, 1]) {
      for (const acrossSide of [-1, 1]) {
        const endS = s + endSide * halfLength;
        const edge = lateral + acrossSide * halfWidth;

        // The arm down the length of the zone, then the one across it.
        pieces.push(
          stripe(
            track,
            endS - endSide * arm * 0.5,
            arm * 0.5,
            Math.min(edge, edge - acrossSide * STROKE),
            Math.max(edge, edge - acrossSide * STROKE),
            0,
          ),
        );
        pieces.push(
          stripe(
            track,
            endS - endSide * STROKE * 0.5,
            STROKE * 0.5,
            Math.min(edge, edge - acrossSide * arm),
            Math.max(edge, edge - acrossSide * arm),
            0,
          ),
        );
      }
    }

    pieces.push(...paintText(track, s, lateral, code, CODE, CODE_GLOW));
    return pieces;
  }

  /** Four strokes making a rectangle: two rails and two end bars. */
  private static outline(
    track: Track,
    s: number,
    lateral: number,
    halfLength: number,
    halfWidth: number,
  ): BufferGeometry[] {
    const pieces: BufferGeometry[] = [];

    for (const side of [-1, 1]) {
      const outer = lateral + side * halfWidth;
      const inner = outer - side * STROKE;
      pieces.push(
        stripe(track, s, halfLength, Math.min(outer, inner), Math.max(outer, inner), 0),
      );
    }
    for (const end of [-1, 1]) {
      pieces.push(
        stripe(
          track,
          wrap(s + end * (halfLength - STROKE * 0.5), track.length),
          STROKE * 0.5,
          lateral - halfWidth,
          lateral + halfWidth,
          0,
        ),
      );
    }

    return pieces;
  }
}
