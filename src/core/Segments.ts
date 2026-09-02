import type { Vector3 } from 'three';
import { clamp } from './math';

/** Below this, two axes count as parallel and the solve is degenerate. */
const PARALLEL = 1e-6;

/**
 * The closest pair of points on two segments, each given as a centre, a unit
 * axis and a half-length.
 *
 * This is what turns a sphere into a capsule. A craft is eight metres long and
 * under five wide; approximated by a sphere it either lets a nose sit three
 * metres inside the car ahead or refuses to let two cars run side by side, and
 * there is no radius that does both. Solved on the axes instead, one radius
 * covers the width and the segment covers the length.
 *
 * The solve is the usual one: minimise the squared distance over both
 * parameters, clamp each to its segment and re-solve the other, which is exact
 * for segments and cheap enough to run on every pair every tick.
 *
 * @returns The distance between the two closest points.
 */
export function closestOnAxes(
  centreA: Vector3,
  axisA: Vector3,
  halfA: number,
  centreB: Vector3,
  axisB: Vector3,
  halfB: number,
  outA: Vector3,
  outB: Vector3,
): number {
  const dx = centreA.x - centreB.x;
  const dy = centreA.y - centreB.y;
  const dz = centreA.z - centreB.z;

  const b = axisA.dot(axisB);
  const e = axisA.x * dx + axisA.y * dy + axisA.z * dz;
  const f = axisB.x * dx + axisB.y * dy + axisB.z * dz;

  const denominator = 1 - b * b;
  let s = denominator > PARALLEL ? clamp((f * b - e) / denominator, -halfA, halfA) : 0;

  // Clamp one, re-solve the other, clamp that, re-solve the first. Two passes
  // is enough: the second solve can only be pushed out of range by the clamp
  // that preceded it.
  const t = clamp(s * b + f, -halfB, halfB);
  s = clamp(t * b - e, -halfA, halfA);

  outA.copy(centreA).addScaledVector(axisA, s);
  outB.copy(centreB).addScaledVector(axisB, t);
  return outA.distanceTo(outB);
}
