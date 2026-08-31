import { clamp, lerp, wrap } from '@/core/math';

/**
 * A corner of the circuit: where the road would turn if it turned instantly,
 * plus the radius it actually turns at.
 *
 * A circuit is authored as a closed polygon of these. The road runs straight
 * between them and arcs through each one, exactly the way a real circuit is
 * surveyed. The payoff is that the lap closes by construction — there is no
 * numerical solve, no drift, and moving one corner cannot silently rewrite the
 * rest of the track.
 */
export interface TrackVertex {
  /** Apex position in the XZ plane, in metres. */
  x: number;
  z: number;
  /** Corner radius in metres. Reduced automatically if two corners crowd each other. */
  radius: number;
  /** Road height at this corner, in metres. */
  height: number;
  /** Road width at this corner, in metres. */
  width: number;
  /** Bank override in degrees. Omit to derive it from the radius. */
  bank?: number;
  /** Corner name, e.g. "T6 HAIRPIN". */
  name?: string;
}

/** What the builder worked out about one corner, for the tuning report. */
export interface CornerInfo {
  name: string;
  /** Radius actually used, after crowding is resolved. */
  radius: number;
  /** Turn angle in degrees. Positive turns right. */
  turn: number;
  /** Arc length of the corner itself, in metres. */
  arcLength: number;
  /** Length of the straight leading into this corner, in metres. */
  entryStraight: number;
  /** Arc length at which the corner begins. */
  fromS: number;
  /** Arc length at which the corner ends. */
  toS: number;
}

export interface PathBuildResult {
  points: [number, number, number][];
  widths: number[];
  /** Bank per point, in radians. */
  banks: number[];
  length: number;
  corners: CornerInfo[];
}

/**
 * Bank in degrees for a corner of the given radius.
 *
 * Tight corners get more camber, up to a limit: past about 24 degrees the road
 * reads as a wall rather than a banked turn, and the hover model starts fighting
 * the player rather than helping.
 */
function autoBank(radius: number, direction: number): number {
  return direction * clamp(4600 / radius, 0, 24);
}

/** Metres over which bank eases in and out around a corner. */
const BANK_BLEND = 26;

function signedTurn(inX: number, inZ: number, outX: number, outZ: number): number {
  // Positive when the outgoing direction is clockwise of the incoming one,
  // which is a right-hand turn looking down at the XZ plane from +Y.
  return Math.atan2(inX * outZ - inZ * outX, inX * outX + inZ * outZ);
}

/**
 * Turns a closed polygon of corners into a drivable centreline.
 *
 * Each corner is cut by an arc of its radius, tangent to both adjoining
 * straights. The tangent length `r * tan(theta/2)` is what a road surveyor
 * uses; where two corners are close enough that their tangents would overlap,
 * both radii are scaled down until they fit, so an over-ambitious radius
 * degrades gracefully instead of producing a broken track.
 */
export function buildPath(vertices: readonly TrackVertex[], spacing = 4): PathBuildResult {
  const n = vertices.length;
  if (n < 3) throw new Error('A circuit needs at least three corners');

  const dirX = new Array<number>(n).fill(0);
  const dirZ = new Array<number>(n).fill(0);
  const legLength = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const a = vertices[i]!;
    const b = vertices[(i + 1) % n]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) throw new Error(`Corners ${i} and ${(i + 1) % n} are in the same place`);
    dirX[i] = dx / len;
    dirZ[i] = dz / len;
    legLength[i] = len;
  }

  // Turn angle and tangent length at each corner.
  const turn = new Array<number>(n).fill(0);
  const radius = vertices.map((v) => v.radius);
  const tangent = new Array<number>(n).fill(0);
  const computeTangents = (): void => {
    for (let i = 0; i < n; i++) {
      const p = (i - 1 + n) % n;
      turn[i] = signedTurn(dirX[p]!, dirZ[p]!, dirX[i]!, dirZ[i]!);
      tangent[i] = radius[i]! * Math.tan(Math.abs(turn[i]!) / 2);
    }
  };
  computeTangents();

  // Where two corners crowd each other, shrink only that pair until their
  // tangents fit the straight between them. Scaling every radius instead would
  // let one over-ambitious corner quietly flatten the whole circuit.
  const tangentOf = (i: number): number => radius[i]! * Math.tan(Math.abs(turn[i]!) / 2);
  for (let pass = 0; pass < 24; pass++) {
    let adjusted = false;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const needed = tangent[i]! + tangent[j]!;
      // Leave a metre of genuine straight so two arcs never meet tangentially.
      const available = legLength[i]! - 1;
      if (needed > available) {
        const k = available / needed;
        radius[i] = radius[i]! * k;
        radius[j] = radius[j]! * k;
        tangent[i] = tangentOf(i);
        tangent[j] = tangentOf(j);
        adjusted = true;
      }
    }
    if (!adjusted) break;
  }

  // Walk the polygon, emitting straight runs and corner arcs.
  const raw: { x: number; z: number; s: number; curvature: number }[] = [];
  const corners: CornerInfo[] = [];
  let s = 0;

  for (let i = 0; i < n; i++) {
    const v = vertices[i]!;
    const prev = (i - 1 + n) % n;
    const t = turn[i]!;
    const r = radius[i]!;
    const tan = tangent[i]!;

    // Straight from the previous corner's exit to this corner's entry.
    const straightLength = legLength[prev]! - tangent[prev]! - tan;
    const entryX = v.x - dirX[prev]! * tan;
    const entryZ = v.z - dirZ[prev]! * tan;
    const straightStartX = entryX - dirX[prev]! * straightLength;
    const straightStartZ = entryZ - dirZ[prev]! * straightLength;

    const straightSteps = Math.max(1, Math.round(straightLength / spacing));
    for (let k = 0; k < straightSteps; k++) {
      const f = k / straightSteps;
      raw.push({
        x: straightStartX + dirX[prev]! * straightLength * f,
        z: straightStartZ + dirZ[prev]! * straightLength * f,
        s: s + straightLength * f,
        curvature: 0,
      });
    }
    s += straightLength;

    // The arc itself.
    const arcLength = Math.abs(t) * r;
    const sign = Math.sign(t) || 1;
    const cx = entryX + Math.cos(Math.atan2(dirZ[prev]!, dirX[prev]!) + (sign * Math.PI) / 2) * r;
    const cz = entryZ + Math.sin(Math.atan2(dirZ[prev]!, dirX[prev]!) + (sign * Math.PI) / 2) * r;
    const start = Math.atan2(entryZ - cz, entryX - cx);
    const arcSteps = Math.max(2, Math.round(arcLength / spacing));
    for (let k = 0; k < arcSteps; k++) {
      const f = k / arcSteps;
      const a = start + t * f;
      raw.push({ x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r, s: s + arcLength * f, curvature: sign / r });
    }

    corners.push({
      name: v.name ?? `T${i}`,
      radius: r,
      turn: (t * 180) / Math.PI,
      arcLength,
      entryStraight: straightLength,
      fromS: s,
      toS: s + arcLength,
    });
    s += arcLength;
  }

  const total = s;

  // Height and width are authored at the corners and eased between them along
  // arc length, using each corner's mid-arc as its anchor.
  const anchors = corners.map((c, i) => ({
    s: (c.fromS + c.toS) * 0.5,
    height: vertices[i]!.height,
    width: vertices[i]!.width,
  }));

  const valueAt = (at: number, field: 'height' | 'width'): number => {
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i]!;
      const b = anchors[(i + 1) % anchors.length]!;
      const span = wrap(b.s - a.s, total);
      const along = wrap(at - a.s, total);
      if (along <= span) {
        const f = span > 1e-6 ? along / span : 0;
        // Smootherstep: zero first and second derivative at both ends, so a
        // crest or a width change never shows a crease.
        const e = f * f * f * (f * (f * 6 - 15) + 10);
        return lerp(a[field], b[field], e);
      }
    }
    return anchors[0]![field];
  };

  // Raw bank follows curvature, then gets blended so it ramps in and out.
  const rawBank = raw.map((p) => {
    const c = p.curvature;
    if (c === 0) return 0;
    const cornerIndex = corners.findIndex((k) => p.s >= k.fromS - 1e-6 && p.s <= k.toS + 1e-6);
    const override = cornerIndex >= 0 ? vertices[cornerIndex]!.bank : undefined;
    return override ?? autoBank(1 / Math.abs(c), Math.sign(c));
  });

  const banks = rawBank.map((_, i) => {
    // Moving average over BANK_BLEND metres either side.
    let sum = 0;
    let weight = 0;
    for (let k = -1; ; k--) {
      const j = wrap(i + k, raw.length);
      const d = wrap(raw[i]!.s - raw[j]!.s, total);
      if (d > BANK_BLEND) break;
      const w = 1 - d / BANK_BLEND;
      sum += rawBank[j]! * w;
      weight += w;
    }
    for (let k = 0; ; k++) {
      const j = wrap(i + k, raw.length);
      const d = wrap(raw[j]!.s - raw[i]!.s, total);
      if (d > BANK_BLEND) break;
      const w = 1 - d / BANK_BLEND;
      sum += rawBank[j]! * w;
      weight += w;
    }
    return weight > 0 ? ((sum / weight) * Math.PI) / 180 : 0;
  });

  const points: [number, number, number][] = raw.map((p) => [p.x, valueAt(p.s, 'height'), p.z]);
  const widths = raw.map((p) => valueAt(p.s, 'width'));

  return { points, widths, banks, length: total, corners };
}
