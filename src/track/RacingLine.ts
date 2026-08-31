import { Vector3 } from 'three';
import { createTrackFrame, type TrackFrame } from './TrackSpline';
import type { Track } from './Track';
import { CRAFT_HALF_WIDTH } from '@/game/Craft';
import { clamp, lerp, wrap } from '@/core/math';

/** Metres of road left unused on each side, beyond the craft's own half-width. */
const EDGE_MARGIN = 1.2;
/** Relaxation passes. Convergence is geometric; a few hundred is plenty. */
const RELAX_PASSES = 600;
/** How far each pass moves toward the locally straightest offset. */
const RELAX_RATE = 0.35;
/** Lateral acceleration the reference car can hold, m/s^2. */
const REFERENCE_GRIP = 46;
/** Braking deceleration the reference car can hold, m/s^2. */
const REFERENCE_BRAKE = 62;
/** Acceleration used when propagating the speed profile forwards, m/s^2. */
const REFERENCE_ACCEL = 48;

export interface LinePoint {
  /** Lateral offset from the centreline, in metres. */
  offset: number;
  /** Curvature magnitude, 1/m. */
  curvature: number;
  /** Target speed for the reference car, m/s. */
  speed: number;
}

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _mid = new Vector3();
const _frame = createTrackFrame();

/**
 * The line the AI drives and the speed it tries to carry.
 *
 * The path comes from rubber-band relaxation: each point is repeatedly nudged
 * toward the midpoint of its neighbours and clamped inside the road. That
 * converges on the shortest path through the corridor, which is a good enough
 * racing line for AG racing and — unlike a hand-authored line — updates itself
 * for free whenever the circuit's geometry or width changes.
 *
 * The speed profile is the standard three-pass solve: cornering limit from
 * curvature, then a backwards pass so the car is already slowing before the
 * corner, then a forwards pass so it cannot accelerate faster than it can.
 */
export class RacingLine {
  private readonly track: Track;
  private readonly count: number;
  private readonly step: number;
  private readonly offsets: Float32Array;
  private readonly curvatures: Float32Array;
  private readonly speeds: Float32Array;
  /** World positions of the line, flattened xyz. */
  private readonly points: Float32Array;

  constructor(track: Track) {
    this.track = track;
    const spline = track.spline;
    this.count = spline.count;
    this.step = spline.step;
    this.offsets = new Float32Array(this.count);
    this.curvatures = new Float32Array(this.count);
    this.speeds = new Float32Array(this.count);
    this.points = new Float32Array(this.count * 3);

    this.relax();
    this.computePositions();
    this.computeCurvature();
    this.computeSpeeds();
  }

  private limitAt(index: number): number {
    const half = this.track.spline.widthAtS(index * this.step) * 0.5;
    return Math.max(0, half - CRAFT_HALF_WIDTH - EDGE_MARGIN);
  }

  /** Pull the line toward the locally straightest path, inside the road. */
  private relax(): void {
    const n = this.count;
    const positionOf = (i: number, offset: number, out: Vector3): Vector3 => {
      const f = this.track.spline.sample(wrap(i, n) * this.step, _frame);
      return out.copy(f.position).addScaledVector(f.right, offset);
    };

    for (let pass = 0; pass < RELAX_PASSES; pass++) {
      for (let i = 0; i < n; i++) {
        const prev = (i - 1 + n) % n;
        const next = (i + 1) % n;
        positionOf(prev, this.offsets[prev]!, _a);
        positionOf(next, this.offsets[next]!, _b);
        _mid.addVectors(_a, _b).multiplyScalar(0.5);

        const f: TrackFrame = this.track.spline.sample(i * this.step, _frame);
        _c.subVectors(_mid, f.position);
        const target = _c.dot(f.right);
        const limit = this.limitAt(i);
        this.offsets[i] = clamp(lerp(this.offsets[i]!, target, RELAX_RATE), -limit, limit);
      }
    }
  }

  private computePositions(): void {
    for (let i = 0; i < this.count; i++) {
      const f = this.track.spline.sample(i * this.step, _frame);
      _a.copy(f.position).addScaledVector(f.right, this.offsets[i]!);
      this.points[i * 3] = _a.x;
      this.points[i * 3 + 1] = _a.y;
      this.points[i * 3 + 2] = _a.z;
    }
  }

  private pointAtIndex(i: number, out: Vector3): Vector3 {
    const k = wrap(i, this.count) * 3;
    return out.set(this.points[k]!, this.points[k + 1]!, this.points[k + 2]!);
  }

  /** Menger curvature of the three consecutive line points around `i`. */
  private computeCurvature(): void {
    const n = this.count;
    // Sample a few metres apart: adjacent points are too close to measure a
    // radius of several hundred metres without drowning in float noise.
    const span = Math.max(1, Math.round(6 / this.step));
    for (let i = 0; i < n; i++) {
      this.pointAtIndex(i - span, _a);
      this.pointAtIndex(i, _b);
      this.pointAtIndex(i + span, _c);
      const ab = _a.distanceTo(_b);
      const bc = _b.distanceTo(_c);
      const ca = _c.distanceTo(_a);
      const s = (ab + bc + ca) * 0.5;
      const area = Math.sqrt(Math.max(0, s * (s - ab) * (s - bc) * (s - ca)));
      const radius = area > 1e-6 ? (ab * bc * ca) / (4 * area) : Infinity;
      this.curvatures[i] = radius > 1e-6 ? 1 / radius : 0;
    }
  }

  private computeSpeeds(): void {
    const n = this.count;
    const topSpeed = 220;

    for (let i = 0; i < n; i++) {
      const k = this.curvatures[i]!;
      this.speeds[i] = k > 1e-6 ? Math.min(topSpeed, Math.sqrt(REFERENCE_GRIP / k)) : topSpeed;
    }

    // Backwards: arrive at every corner already slow enough.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = n - 1; i >= 0; i--) {
        const next = (i + 1) % n;
        const reachable = Math.sqrt(this.speeds[next]! ** 2 + 2 * REFERENCE_BRAKE * this.step);
        this.speeds[i] = Math.min(this.speeds[i]!, reachable);
      }
    }

    // Forwards: never ask for more speed than the car can actually build.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        const prev = (i - 1 + n) % n;
        const reachable = Math.sqrt(this.speeds[prev]! ** 2 + 2 * REFERENCE_ACCEL * this.step);
        this.speeds[i] = Math.min(this.speeds[i]!, reachable);
      }
    }
  }

  /** Line data at arc length `s`, interpolated between samples. */
  sample(s: number, out: LinePoint): LinePoint {
    const n = this.count;
    const f = wrap(s, this.track.length) / this.step;
    const i = Math.floor(f) % n;
    const j = (i + 1) % n;
    const k = f - Math.floor(f);
    out.offset = lerp(this.offsets[i]!, this.offsets[j]!, k);
    out.curvature = lerp(this.curvatures[i]!, this.curvatures[j]!, k);
    out.speed = lerp(this.speeds[i]!, this.speeds[j]!, k);
    return out;
  }

  /** World position of the line at arc length `s`. */
  positionAt(s: number, out: Vector3): Vector3 {
    const n = this.count;
    const f = wrap(s, this.track.length) / this.step;
    const i = Math.floor(f) % n;
    const j = (i + 1) % n;
    const k = f - Math.floor(f);
    this.pointAtIndex(i, _a);
    this.pointAtIndex(j, _b);
    return out.lerpVectors(_a, _b, k);
  }

  /** Lateral offset of the line at arc length `s`, in metres. */
  offsetAt(s: number): number {
    const n = this.count;
    const f = wrap(s, this.track.length) / this.step;
    const i = Math.floor(f) % n;
    const j = (i + 1) % n;
    return lerp(this.offsets[i]!, this.offsets[j]!, f - Math.floor(f));
  }

  /** Target speed at arc length `s` for the reference car, m/s. */
  speedAt(s: number): number {
    const n = this.count;
    const f = wrap(s, this.track.length) / this.step;
    const i = Math.floor(f) % n;
    const j = (i + 1) % n;
    return lerp(this.speeds[i]!, this.speeds[j]!, f - Math.floor(f));
  }

  /** Length of the line itself, which is shorter than the centreline. */
  get length(): number {
    let total = 0;
    for (let i = 0; i < this.count; i++) {
      this.pointAtIndex(i, _a);
      this.pointAtIndex(i + 1, _b);
      total += _a.distanceTo(_b);
    }
    return total;
  }
}
