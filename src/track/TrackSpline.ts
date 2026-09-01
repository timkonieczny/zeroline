import { CatmullRomCurve3, Vector3 } from 'three';
import { catmullRomLoop, clamp, lerp, wrap } from '@/core/math';

/**
 * A resolved frame on the track centreline. All vectors are unit length and
 * mutually orthogonal: `right = tangent x up`.
 */
export interface TrackFrame {
  /** Arc length along the centreline, in metres, wrapped into [0, length). */
  s: number;
  position: Vector3;
  tangent: Vector3;
  up: Vector3;
  right: Vector3;
  /** Full road width in metres at this point. */
  width: number;
  /** Authored bank (roll about the tangent) in radians. */
  bank: number;
}

export function createTrackFrame(): TrackFrame {
  return {
    s: 0,
    position: new Vector3(),
    tangent: new Vector3(0, 0, 1),
    up: new Vector3(0, 1, 0),
    right: new Vector3(1, 0, 0),
    width: 1,
    bank: 0,
  };
}

export interface TrackSplineOptions {
  /** Centreline control points, in order, forming a closed loop. */
  points: readonly (readonly [number, number, number])[];
  /** Road width per control point, in metres. */
  widths: readonly number[];
  /** Bank angle per control point, in radians. Positive rolls the road right-side-down. */
  banks: readonly number[];
  /** Target spacing between resampled frames, in metres. */
  spacing?: number;
}

const _v1 = new Vector3();
const _v2 = new Vector3();
const _tmp = new Vector3();

/**
 * The centreline of a circuit, resampled to uniform arc length and carrying a
 * continuous, twist-free reference frame.
 *
 * Uniform arc-length sampling is what makes everything downstream cheap: a
 * distance `s` maps to a sample index by a single division, so lap progress,
 * AI waypoints, pickup placement and the surface query all become O(1) with no
 * curve evaluation at runtime.
 *
 * Frames come from the double-reflection rotation-minimising frame algorithm
 * (Wang et al. 2008) rather than a fixed world-up, so corkscrews and full rolls
 * work. Because a closed loop generally does not return to its starting frame,
 * the residual twist is measured once and distributed evenly around the lap.
 */
/**
 * A spline reduced to the arrays it is made of, ready to cross a worker
 * boundary. Every array is transferable, so handing one over copies nothing.
 */
export interface SplineData {
  length: number;
  count: number;
  step: number;
  /** px, py, pz, tx, ty, tz, ux, uy, uz, width, bank — in that order. */
  lanes: Float32Array[];
}

export class TrackSpline {
  /** Total centreline length in metres. */
  readonly length: number;
  /** Number of uniformly spaced samples around the loop. */
  readonly count: number;
  /** Distance between consecutive samples in metres. */
  readonly step: number;

  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly tx: Float32Array;
  private readonly ty: Float32Array;
  private readonly tz: Float32Array;
  private readonly ux: Float32Array;
  private readonly uy: Float32Array;
  private readonly uz: Float32Array;
  private readonly widthAt: Float32Array;
  private readonly bankAt: Float32Array;

  constructor(options: TrackSplineOptions | SplineData) {
    if ('lanes' in options) {
      // Rebuilt from a payload rather than resampled. The arrays are the whole
      // of the spline's state, so adopting them is the same object by a much
      // shorter route — which is what lets the resampling happen in a worker.
      this.length = options.length;
      this.count = options.count;
      this.step = options.step;
      const [px, py, pz, tx, ty, tz, ux, uy, uz, widthAt, bankAt] = options.lanes;
      this.px = px!;
      this.py = py!;
      this.pz = pz!;
      this.tx = tx!;
      this.ty = ty!;
      this.tz = tz!;
      this.ux = ux!;
      this.uy = uy!;
      this.uz = uz!;
      this.widthAt = widthAt!;
      this.bankAt = bankAt!;
      return;
    }

    const { points, widths, banks, spacing = 2 } = options;
    if (points.length < 4) {
      throw new Error('TrackSpline needs at least 4 control points');
    }

    const curve = new CatmullRomCurve3(
      points.map((p) => new Vector3(p[0], p[1], p[2])),
      true,
      'centripetal',
      0.5,
    );

    // Dense sample in curve parameter space to build an arc-length table.
    const dense = Math.max(2048, points.length * 64);
    const denseP: Vector3[] = new Array(dense + 1);
    const denseS = new Float64Array(dense + 1);
    for (let i = 0; i <= dense; i++) {
      denseP[i] = curve.getPoint(i / dense);
      if (i > 0) denseS[i] = denseS[i - 1]! + denseP[i]!.distanceTo(denseP[i - 1]!);
    }
    const total = denseS[dense]!;
    this.length = total;
    this.count = Math.max(16, Math.round(total / spacing));
    this.step = total / this.count;

    const n = this.count;
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.tx = new Float32Array(n);
    this.ty = new Float32Array(n);
    this.tz = new Float32Array(n);
    this.ux = new Float32Array(n);
    this.uy = new Float32Array(n);
    this.uz = new Float32Array(n);
    this.widthAt = new Float32Array(n);
    this.bankAt = new Float32Array(n);

    // Resample uniformly in arc length by walking the dense table.
    let cursor = 0;
    for (let i = 0; i < n; i++) {
      const target = i * this.step;
      while (cursor < dense - 1 && denseS[cursor + 1]! < target) cursor++;
      const s0 = denseS[cursor]!;
      const s1 = denseS[cursor + 1]!;
      const f = s1 > s0 ? (target - s0) / (s1 - s0) : 0;
      const a = denseP[cursor]!;
      const b = denseP[cursor + 1]!;
      this.px[i] = lerp(a.x, b.x, f);
      this.py[i] = lerp(a.y, b.y, f);
      this.pz[i] = lerp(a.z, b.z, f);

      // Curve parameter for this sample drives the authored scalars.
      const t = (cursor + f) / dense;
      this.widthAt[i] = catmullRomLoop(widths, t);
      this.bankAt[i] = catmullRomLoop(banks, t);
    }

    this.computeTangents();
    this.computeFrames();
  }

  /** Central-difference tangents on the uniform samples. */
  private computeTangents(): void {
    const n = this.count;
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n;
      const b = (i + 1) % n;
      let x = this.px[b]! - this.px[a]!;
      let y = this.py[b]! - this.py[a]!;
      let z = this.pz[b]! - this.pz[a]!;
      const len = Math.hypot(x, y, z) || 1;
      x /= len;
      y /= len;
      z /= len;
      this.tx[i] = x;
      this.ty[i] = y;
      this.tz[i] = z;
    }
  }

  /**
   * Propagate a rotation-minimising frame around the loop, then remove the
   * closure defect so the frame at s=0 approached from behind matches the
   * frame at s=0 approached from ahead.
   */
  private computeFrames(): void {
    const n = this.count;
    const t0 = _v1.set(this.tx[0]!, this.ty[0]!, this.tz[0]!);

    // Seed: world up, made perpendicular to the tangent. Fall back to world
    // forward where the track points straight up or down.
    const seed = new Vector3(0, 1, 0);
    if (Math.abs(seed.dot(t0)) > 0.99) seed.set(0, 0, 1);
    seed.addScaledVector(t0, -seed.dot(t0)).normalize();

    const ux = this.ux;
    const uy = this.uy;
    const uz = this.uz;
    ux[0] = seed.x;
    uy[0] = seed.y;
    uz[0] = seed.z;

    const propagate = (i: number, j: number, out: Vector3): void => {
      // Double reflection: reflect the frame across the chord, then across the
      // plane that maps the old tangent onto the new one.
      const rx = ux[i]!;
      const ry = uy[i]!;
      const rz = uz[i]!;
      _v1.set(this.px[j]! - this.px[i]!, this.py[j]! - this.py[i]!, this.pz[j]! - this.pz[i]!);
      const c1 = _v1.lengthSq();
      let lrx = rx;
      let lry = ry;
      let lrz = rz;
      let ltx = this.tx[i]!;
      let lty = this.ty[i]!;
      let ltz = this.tz[i]!;
      if (c1 > 1e-12) {
        const k = (2 / c1) * (_v1.x * rx + _v1.y * ry + _v1.z * rz);
        lrx -= k * _v1.x;
        lry -= k * _v1.y;
        lrz -= k * _v1.z;
        const k2 = (2 / c1) * (_v1.x * ltx + _v1.y * lty + _v1.z * ltz);
        ltx -= k2 * _v1.x;
        lty -= k2 * _v1.y;
        ltz -= k2 * _v1.z;
      }
      _v2.set(this.tx[j]! - ltx, this.ty[j]! - lty, this.tz[j]! - ltz);
      const c2 = _v2.lengthSq();
      if (c2 > 1e-12) {
        const k = (2 / c2) * (_v2.x * lrx + _v2.y * lry + _v2.z * lrz);
        lrx -= k * _v2.x;
        lry -= k * _v2.y;
        lrz -= k * _v2.z;
      }
      out.set(lrx, lry, lrz).normalize();
    };

    for (let i = 0; i < n - 1; i++) {
      propagate(i, i + 1, _tmp);
      ux[i + 1] = _tmp.x;
      uy[i + 1] = _tmp.y;
      uz[i + 1] = _tmp.z;
    }

    // Measure the twist accumulated over the closing segment.
    propagate(n - 1, 0, _tmp);
    const start = new Vector3(ux[0]!, uy[0]!, uz[0]!);
    const tan0 = new Vector3(this.tx[0]!, this.ty[0]!, this.tz[0]!);
    const cross = new Vector3().crossVectors(_tmp, start);
    // `defect` is the rotation about the tangent that takes the frame arriving
    // from sample n-1 onto the frame at sample 0.
    const defect = Math.atan2(cross.dot(tan0), clamp(_tmp.dot(start), -1, 1));

    // Spreading a correction of `defect * i / (n-1)` over the loop makes the
    // frame arriving at sample 0 land exactly on it: the last sample carries a
    // full `defect` of correction, which is precisely what the closing segment
    // introduces. Anything else leaves a visible twist at the seam.
    const axis = new Vector3();
    const up = new Vector3();
    for (let i = 1; i < n; i++) {
      const angle = (defect * i) / (n - 1);
      axis.set(this.tx[i]!, this.ty[i]!, this.tz[i]!);
      up.set(ux[i]!, uy[i]!, uz[i]!).applyAxisAngle(axis, angle);
      ux[i] = up.x;
      uy[i] = up.y;
      uz[i] = up.z;
    }
  }

  /** Everything this spline is, as transferable arrays. */
  toData(): SplineData {
    return {
      length: this.length,
      count: this.count,
      step: this.step,
      lanes: [
        this.px,
        this.py,
        this.pz,
        this.tx,
        this.ty,
        this.tz,
        this.ux,
        this.uy,
        this.uz,
        this.widthAt,
        this.bankAt,
      ],
    };
  }

  /** Wraps an arc length into [0, length). */
  wrapS(s: number): number {
    return wrap(s, this.length);
  }

  /**
   * Resolve the frame at arc length `s`, writing into `out` to avoid
   * allocating on the hot path. Authored bank is applied here.
   */
  sample(s: number, out: TrackFrame): TrackFrame {
    const n = this.count;
    const w = this.wrapS(s);
    const f = w / this.step;
    const i = Math.floor(f) % n;
    const j = (i + 1) % n;
    const k = f - Math.floor(f);

    out.s = w;
    out.position.set(
      lerp(this.px[i]!, this.px[j]!, k),
      lerp(this.py[i]!, this.py[j]!, k),
      lerp(this.pz[i]!, this.pz[j]!, k),
    );
    out.tangent
      .set(lerp(this.tx[i]!, this.tx[j]!, k), lerp(this.ty[i]!, this.ty[j]!, k), lerp(this.tz[i]!, this.tz[j]!, k))
      .normalize();
    out.up
      .set(lerp(this.ux[i]!, this.ux[j]!, k), lerp(this.uy[i]!, this.uy[j]!, k), lerp(this.uz[i]!, this.uz[j]!, k))
      .normalize();

    out.width = lerp(this.widthAt[i]!, this.widthAt[j]!, k);
    out.bank = lerp(this.bankAt[i]!, this.bankAt[j]!, k);
    if (out.bank !== 0) out.up.applyAxisAngle(out.tangent, out.bank);

    // Re-orthogonalise: interpolation drags `up` off the tangent plane.
    out.up.addScaledVector(out.tangent, -out.up.dot(out.tangent)).normalize();
    out.right.crossVectors(out.tangent, out.up).normalize();
    return out;
  }

  /** Road width at arc length `s`. */
  widthAtS(s: number): number {
    const n = this.count;
    const f = this.wrapS(s) / this.step;
    const i = Math.floor(f) % n;
    const j = (i + 1) % n;
    return lerp(this.widthAt[i]!, this.widthAt[j]!, f - Math.floor(f));
  }

  /** Centreline position of sample `i`, written into `out`. */
  positionOfSample(i: number, out: Vector3): Vector3 {
    const k = wrap(i, this.count);
    return out.set(this.px[k]!, this.py[k]!, this.pz[k]!);
  }

  /** Raw sample index nearest to arc length `s`. */
  sampleIndexAt(s: number): number {
    return Math.round(this.wrapS(s) / this.step) % this.count;
  }
}
