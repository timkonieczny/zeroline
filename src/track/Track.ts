import { TrackSpline, type TrackFrame, createTrackFrame } from './TrackSpline';
import { TrackCollision } from './TrackCollision';
import { buildPath, type CornerInfo } from './TrackPath';
import {
  type PadPlacement,
  type SceneryDistrict,
  type TrackDefinition,
  type TunnelSection,
} from './TrackTypes';
import { wrap } from '@/core/math';

/** A pad resolved to absolute track coordinates. */
export interface ResolvedPad {
  s: number;
  /** Lateral offset in metres from the centreline. */
  lateral: number;
  /** Half the pad's width, in metres. */
  halfWidth: number;
  /** Half the pad's length along the track, in metres. */
  halfLength: number;
}

export interface ResolvedRange {
  fromS: number;
  toS: number;
}

export type ResolvedTunnel = TunnelSection & ResolvedRange;
export type ResolvedDistrict = SceneryDistrict & ResolvedRange;

const PAD_HALF_WIDTH = 4.4;
const PAD_HALF_LENGTH = 7;

/**
 * A playable circuit: the centreline, the collision query, and every authored
 * feature resolved from lap fractions into absolute arc lengths.
 *
 * Everything downstream — the mesh builder, AI, pickups, HUD — reads from here
 * rather than from the raw definition, so a track's authored numbers stay
 * resolution-independent while the runtime works in metres.
 */
export class Track {
  readonly definition: TrackDefinition;
  readonly spline: TrackSpline;
  readonly collision: TrackCollision;
  readonly length: number;
  readonly startS: number;

  readonly boostPads: readonly ResolvedPad[];
  readonly pickupPads: readonly ResolvedPad[];
  readonly tunnels: readonly ResolvedTunnel[];
  readonly districts: readonly ResolvedDistrict[];

  /** Scratch frame for callers that need a one-off sample. */
  private readonly scratch: TrackFrame = createTrackFrame();

  /** What the builder made of each authored corner. Used by the tuning report. */
  readonly corners: readonly CornerInfo[];

  constructor(definition: TrackDefinition) {
    this.definition = definition;
    const path = buildPath(definition.corners);
    this.corners = path.corners;
    this.spline = new TrackSpline({
      points: path.points,
      widths: path.widths,
      banks: path.banks,
      spacing: definition.spacing,
    });
    this.collision = new TrackCollision(this.spline);
    this.length = this.spline.length;
    this.startS = definition.startLine * this.length;

    this.boostPads = definition.boostPads.map((p) => this.resolvePad(p));
    this.pickupPads = definition.pickupPads.map((p) => this.resolvePad(p));
    this.tunnels = definition.tunnels.map((t) => ({
      ...t,
      fromS: t.from * this.length,
      toS: t.to * this.length,
    }));
    this.districts = definition.districts.map((d) => ({
      ...d,
      fromS: d.from * this.length,
      toS: d.to * this.length,
    }));
  }

  private resolvePad(p: PadPlacement): ResolvedPad {
    const s = wrap(p.at * this.length, this.length);
    const halfWidth = this.spline.widthAtS(s) * 0.5;
    return {
      s,
      lateral: p.offset * (halfWidth - PAD_HALF_WIDTH - 1.5),
      halfWidth: PAD_HALF_WIDTH,
      halfLength: PAD_HALF_LENGTH,
    };
  }

  /** Frame at arc length `s`. The returned object is reused between calls. */
  frameAt(s: number): TrackFrame {
    return this.spline.sample(s, this.scratch);
  }

  isInTunnel(s: number): boolean {
    const w = wrap(s, this.length);
    for (const t of this.tunnels) {
      if (t.fromS <= t.toS ? w >= t.fromS && w <= t.toS : w >= t.fromS || w <= t.toS) return true;
    }
    return false;
  }

  districtAt(s: number): ResolvedDistrict {
    const w = wrap(s, this.length);
    for (const d of this.districts) {
      if (d.fromS <= d.toS ? w >= d.fromS && w < d.toS : w >= d.fromS || w < d.toS) return d;
    }
    return this.districts[0]!;
  }

  /**
   * Starting grid position for slot `index` (0 = pole), in track space.
   * Two-by-two, staggered, laid out behind the start line.
   */
  gridSlot(index: number): { s: number; lateral: number } {
    const row = Math.floor(index / 2);
    const side = index % 2 === 0 ? -1 : 1;
    const s = wrap(this.startS - 22 - row * 16, this.length);
    const halfWidth = this.spline.widthAtS(s) * 0.5;
    return { s, lateral: side * halfWidth * 0.42 };
  }
}
