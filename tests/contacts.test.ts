import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { closestOnAxes } from '@/core/Segments';
import { CRAFT_HALF_LENGTH, CRAFT_HALF_WIDTH } from '@/game/Craft';

const HALF = CRAFT_HALF_LENGTH - CRAFT_HALF_WIDTH;
const outA = new Vector3();
const outB = new Vector3();

/** Distance between two craft-shaped capsules, given their centres and headings. */
function gap(a: Vector3, headingA: Vector3, b: Vector3, headingB: Vector3): number {
  return closestOnAxes(a, headingA, HALF, b, headingB, HALF, outA, outB) - CRAFT_HALF_WIDTH * 2;
}

const forward = new Vector3(0, 0, 1);

/**
 * The shape a craft is shoved with.
 *
 * A sphere cannot be both eight metres long and under five wide, and which way
 * it errs is not cosmetic: too small and a nose parks inside the car ahead, too
 * large and two craft cannot run abreast down a thirty-metre road. These pin
 * the cases that a single radius gets wrong.
 */
describe('craft contact shape', () => {
  it('touches nose to tail at the craft’s own length', () => {
    // Two craft in line, centres eight metres apart: hulls exactly meeting.
    expect(gap(new Vector3(0, 0, 0), forward, new Vector3(0, 0, 8), forward)).toBeCloseTo(0, 5);

    // Closer than that is an overlap, further is clear air.
    expect(gap(new Vector3(0, 0, 0), forward, new Vector3(0, 0, 6.5), forward)).toBeLessThan(0);
    expect(gap(new Vector3(0, 0, 0), forward, new Vector3(0, 0, 9), forward)).toBeGreaterThan(0);
  });

  it('lets two craft run abreast at their own width', () => {
    // Side by side, centres five metres apart: clear, if barely.
    expect(gap(new Vector3(0, 0, 0), forward, new Vector3(5, 0, 0), forward)).toBeGreaterThan(0);
    expect(gap(new Vector3(0, 0, 0), forward, new Vector3(4.5, 0, 0), forward)).toBeLessThan(0);
  });

  it('catches what a sphere let through', () => {
    // The model this replaced: one radius, centre to centre. At the separation
    // it had to use to let two craft run abreast, a nose could sit three metres
    // inside the car ahead and register nothing at all.
    const sphere = CRAFT_HALF_WIDTH * 2.1;
    const inLine = 6;

    expect(inLine).toBeGreaterThan(sphere);
    expect(gap(new Vector3(0, 0, 0), forward, new Vector3(0, 0, inLine), forward)).toBeLessThan(-1.9);
  });

  it('puts the contact points on the hulls that touched', () => {
    // A rear-end shunt: the points are the tail of one and the nose of the next,
    // so the shove that follows runs along the road rather than across it.
    closestOnAxes(
      new Vector3(0, 0, 0),
      forward,
      HALF,
      new Vector3(0, 0, 7),
      forward,
      HALF,
      outA,
      outB,
    );
    expect(outA.z).toBeCloseTo(HALF, 5);
    expect(outB.z).toBeCloseTo(7 - HALF, 5);
  });

  it('handles craft pointed different ways, and parallel ones', () => {
    const across = new Vector3(1, 0, 0);
    // A T-bone: the nose of one against the flank of the other.
    const t = gap(new Vector3(0, 0, 0), forward, new Vector3(0, 0, 6), across);
    expect(t).toBeLessThan(0);

    // Exactly parallel is the degenerate case in the solve; it must still give
    // a finite, sensible answer rather than dividing by zero.
    const parallel = gap(new Vector3(0, 0, 0), forward, new Vector3(20, 0, 0), forward);
    expect(Number.isFinite(parallel)).toBe(true);
    expect(parallel).toBeCloseTo(20 - CRAFT_HALF_WIDTH * 2, 5);
  });
});
