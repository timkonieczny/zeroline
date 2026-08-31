import { Vector3 } from 'three';
import { createTrackFrame, type TrackFrame, type TrackSpline } from './TrackSpline';
import { clamp } from '@/core/math';

/**
 * Where a world point sits relative to the road, expressed in track space.
 * This is the only collision primitive the game needs: the road is an implicit
 * surface swept along the centreline, so "am I on the track, how far from the
 * wall, and how high above the tarmac" is three dot products once the nearest
 * frame is known.
 */
export interface SurfaceHit {
  /** Arc length of the nearest point on the centreline. */
  s: number;
  /** Signed offset along the frame's right vector, in metres. */
  lateral: number;
  /** Signed offset along the frame's up vector from the road surface. */
  height: number;
  /** Full road width at `s`. */
  width: number;
  /** Positive inside the road, negative past the wall. */
  edgeDistance: number;
  /** Resolved frame at `s`. Owned by the query object; copy if retained. */
  frame: TrackFrame;
}

const _delta = new Vector3();
const _seg = new Vector3();

/**
 * Nearest-point queries against a track centreline.
 *
 * Two strategies, in order:
 *  1. A windowed scan around a caller-supplied hint (the craft's arc length on
 *     the previous tick). This hits on essentially every gameplay query.
 *  2. A uniform XZ hash grid over the samples, for cold queries: spawning,
 *     prop placement, respawn after falling off, editor tooling.
 */
export class TrackCollision {
  private readonly spline: TrackSpline;
  private readonly cellSize: number;
  private readonly minX: number;
  private readonly minZ: number;
  private readonly cols: number;
  private readonly rows: number;
  /** Flattened CSR-style buckets: `cellStart[c]..cellStart[c+1]` index `cellItems`. */
  private readonly cellStart: Int32Array;
  private readonly cellItems: Int32Array;

  readonly hit: SurfaceHit = {
    s: 0,
    lateral: 0,
    height: 0,
    width: 0,
    edgeDistance: 0,
    frame: createTrackFrame(),
  };

  constructor(spline: TrackSpline, cellSize = 16) {
    this.spline = spline;
    this.cellSize = cellSize;

    const n = spline.count;
    const p = new Vector3();
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      spline.positionOfSample(i, p);
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    this.minX = minX - cellSize;
    this.minZ = minZ - cellSize;
    this.cols = Math.max(1, Math.ceil((maxX - minX) / cellSize) + 3);
    this.rows = Math.max(1, Math.ceil((maxZ - minZ) / cellSize) + 3);

    // Two-pass counting sort into the flattened buckets.
    const cellCount = this.cols * this.rows;
    const counts = new Int32Array(cellCount + 1);
    const cellOf = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      spline.positionOfSample(i, p);
      const c = this.cellIndex(p.x, p.z);
      cellOf[i] = c;
      counts[c + 1]!++;
    }
    for (let c = 0; c < cellCount; c++) counts[c + 1]! += counts[c]!;
    this.cellStart = counts;
    this.cellItems = new Int32Array(n);
    const cursor = Int32Array.from(counts.subarray(0, cellCount));
    for (let i = 0; i < n; i++) {
      this.cellItems[cursor[cellOf[i]!]!++] = i;
    }
  }

  private cellIndex(x: number, z: number): number {
    const cx = clamp(Math.floor((x - this.minX) / this.cellSize), 0, this.cols - 1);
    const cz = clamp(Math.floor((z - this.minZ) / this.cellSize), 0, this.rows - 1);
    return cz * this.cols + cx;
  }

  /** Squared distance from `point` to sample `i`. */
  private distSqToSample(point: Vector3, i: number): number {
    this.spline.positionOfSample(i, _seg);
    return _seg.distanceToSquared(point);
  }

  /**
   * Resolve `point` into track space.
   *
   * `hint` is the arc length the caller expects to be near. Pass the previous
   * tick's value for craft; pass `undefined` for cold lookups.
   */
  query(point: Vector3, hint?: number): SurfaceHit {
    const n = this.spline.count;
    let best = -1;

    if (hint !== undefined) {
      // Window wide enough to cover a full tick of travel at any speed, with
      // margin for the craft being thrown sideways by a collision.
      const window = Math.max(8, Math.ceil(60 / this.spline.step));
      const centre = this.spline.sampleIndexAt(hint);
      let bestD = Infinity;
      for (let k = -window; k <= window; k++) {
        const i = (((centre + k) % n) + n) % n;
        const d = this.distSqToSample(point, i);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      // Landing on the window edge means the hint was stale; fall through.
      const offset = Math.abs(((best - centre + n + n / 2) % n) - n / 2);
      if (offset >= window) best = -1;
    }

    if (best < 0) best = this.nearestSampleByGrid(point);

    return this.resolve(point, best);
  }

  private nearestSampleByGrid(point: Vector3): number {
    let best = 0;
    let bestD = Infinity;
    const cx = clamp(Math.floor((point.x - this.minX) / this.cellSize), 0, this.cols - 1);
    const cz = clamp(Math.floor((point.z - this.minZ) / this.cellSize), 0, this.rows - 1);

    for (let ring = 0; ring < Math.max(this.cols, this.rows); ring++) {
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          // Only walk the perimeter of each ring; the interior was covered.
          if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dz) !== ring) continue;
          const x = cx + dx;
          const z = cz + dz;
          if (x < 0 || z < 0 || x >= this.cols || z >= this.rows) continue;
          const c = z * this.cols + x;
          const start = this.cellStart[c]!;
          const end = this.cellStart[c + 1]!;
          for (let k = start; k < end; k++) {
            const i = this.cellItems[k]!;
            const d = this.distSqToSample(point, i);
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
        }
      }
      // One extra ring past the first hit, so a sample just over a cell
      // boundary cannot win by being searched first.
      if (bestD < Infinity && ring > 0) break;
    }
    return best;
  }

  /** Refine to the exact point on the polyline, then project into track space. */
  private resolve(point: Vector3, index: number): SurfaceHit {
    const n = this.spline.count;
    const step = this.spline.step;
    let bestS = index * step;
    let bestD = Infinity;

    const a = new Vector3();
    const b = new Vector3();
    for (let k = -1; k <= 0; k++) {
      const i = (((index + k) % n) + n) % n;
      const j = (i + 1) % n;
      this.spline.positionOfSample(i, a);
      this.spline.positionOfSample(j, b);
      _seg.subVectors(b, a);
      const lenSq = _seg.lengthSq();
      if (lenSq < 1e-12) continue;
      const t = clamp(_delta.subVectors(point, a).dot(_seg) / lenSq, 0, 1);
      const d = a.addScaledVector(_seg, t).distanceToSquared(point);
      if (d < bestD) {
        bestD = d;
        bestS = (i + t) * step;
      }
    }

    const hit = this.hit;
    const frame = this.spline.sample(bestS, hit.frame);
    _delta.subVectors(point, frame.position);
    hit.s = frame.s;
    hit.lateral = _delta.dot(frame.right);
    hit.height = _delta.dot(frame.up);
    hit.width = frame.width;
    hit.edgeDistance = frame.width * 0.5 - Math.abs(hit.lateral);
    return hit;
  }

  /**
   * World position of a point given in track space. Inverse of `query`, and the
   * workhorse for placing pickups, props, grid slots and AI targets.
   */
  toWorld(s: number, lateral: number, height: number, out: Vector3, frame?: TrackFrame): Vector3 {
    const f = this.spline.sample(s, frame ?? this.hit.frame);
    return out.copy(f.position).addScaledVector(f.right, lateral).addScaledVector(f.up, height);
  }
}
