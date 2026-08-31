/** Small, allocation-free math helpers shared by the simulation. */

export const TAU = Math.PI * 2;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function inverseLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01(inverseLerp(edge0, edge1, x));
  return t * t * (3 - 2 * t);
}

/**
 * Frame-rate independent exponential approach. `halfLife` is the time in
 * seconds for the remaining distance to halve. Preferred over raw lerp
 * because the sim tick is fixed but the render tick is not.
 */
export function damp(current: number, target: number, halfLife: number, dt: number): number {
  if (halfLife <= 0) return target;
  return target + (current - target) * Math.pow(2, -dt / halfLife);
}

export function moveTowards(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/** Signed shortest angular difference, result in (-PI, PI]. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

/** Wraps a value into [0, range). Correct for negative inputs. */
export function wrap(v: number, range: number): number {
  const m = v % range;
  return m < 0 ? m + range : m;
}

/**
 * Shortest signed difference between two positions on a closed loop of
 * `range`. Used constantly for lap/position logic on a circuit.
 */
export function wrapDelta(from: number, to: number, range: number): number {
  let d = wrap(to - from, range);
  if (d > range * 0.5) d -= range;
  return d;
}

/** Cubic Catmull-Rom through p1,p2 with neighbours p0,p3. t in [0,1]. */
export function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/** Catmull-Rom over a closed array of scalars, sampled at t in [0,1). */
export function catmullRomLoop(values: readonly number[], t: number): number {
  const n = values.length;
  if (n === 0) return 0;
  if (n === 1) return values[0]!;
  const f = wrap(t, 1) * n;
  const i = Math.floor(f);
  const local = f - i;
  const v = (k: number) => values[wrap(k, n)]!;
  return catmullRom(v(i - 1), v(i), v(i + 1), v(i + 2), local);
}
