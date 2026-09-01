import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { shadowTexelSize, snapToShadowTexels } from '@/track/scenery/ShadowSnap';

/**
 * The snapping is a few lines of dot products and rounding, and it is exactly
 * the kind of thing that looks right, compiles, and quietly snaps to the wrong
 * basis — at which point the shadows carry on shimmering and nobody can say
 * why. What follows checks the two properties that matter: the result lands on
 * the grid, and it never moves further than it has to.
 */

const UP = new Vector3(0, 1, 0);

/** A sun over the shoulder, the way a circuit is actually lit. */
function sunAt(azimuthDeg: number, elevationDeg: number): Vector3 {
  const azimuth = (azimuthDeg * Math.PI) / 180;
  const elevation = (elevationDeg * Math.PI) / 180;
  return new Vector3(
    Math.cos(elevation) * Math.cos(azimuth),
    Math.sin(elevation),
    Math.cos(elevation) * Math.sin(azimuth),
  );
}

/** The light-space axes the snap is supposed to be quantising along. */
function basis(sun: Vector3): { right: Vector3; up: Vector3 } {
  const forward = sun.clone().normalize();
  const right = new Vector3().crossVectors(UP, forward).normalize();
  const up = new Vector3().crossVectors(forward, right).normalize();
  return { right, up };
}

describe('shadow texel snapping', () => {
  const texel = shadowTexelSize(190, 2048);

  it('is nineteen centimetres for the circuit rig', () => {
    expect(texel).toBeCloseTo(0.1855, 4);
  });

  for (const [azimuth, elevation] of [
    [35, 42],
    [-120, 18],
    [0, 70],
    [200, 5],
  ] as const) {
    it(`lands on the grid with the sun at ${azimuth}/${elevation}`, () => {
      const sun = sunAt(azimuth, elevation);
      const { right, up } = basis(sun);
      const out = new Vector3();

      for (let i = 0; i < 40; i++) {
        // Positions strewn across a circuit's worth of ground, at odd offsets
        // so nothing lands on a texel boundary by luck.
        const focus = new Vector3(
          Math.sin(i * 1.7) * 900 + 0.037,
          Math.cos(i * 0.9) * 40,
          Math.cos(i * 2.3) * 900 - 0.019,
        );
        snapToShadowTexels(focus, sun, UP, texel, out);

        // On the grid, in the light's own basis.
        for (const axis of [right, up]) {
          const projected = out.dot(axis) / texel;
          expect(Math.abs(projected - Math.round(projected))).toBeLessThan(1e-3);
        }

        // And never further than half a texel along either axis, or the
        // frustum would be lurching rather than settling.
        expect(Math.abs(out.dot(right) - focus.dot(right))).toBeLessThanOrEqual(texel / 2 + 1e-6);
        expect(Math.abs(out.dot(up) - focus.dot(up))).toBeLessThanOrEqual(texel / 2 + 1e-6);

        // Depth into the light is left exactly alone: it does not move the
        // texel grid, and shifting it would only slide the near and far planes.
        const forward = sun.clone().normalize();
        expect(out.dot(forward)).toBeCloseTo(focus.dot(forward), 6);
      }
    });
  }

  it('holds still while the focus wanders within one texel', () => {
    // The whole point. A player creeping across a fraction of a texel must not
    // move the frustum at all.
    const sun = sunAt(35, 42);
    const { right } = basis(sun);
    const anchor = new Vector3(120, 8, -46);
    const snapped = snapToShadowTexels(anchor, sun, UP, texel, new Vector3()).clone();

    const nudged = new Vector3();
    for (let i = 1; i <= 6; i++) {
      nudged.copy(anchor).addScaledVector(right, (texel * i) / 40);
      const out = snapToShadowTexels(nudged, sun, UP, texel, new Vector3());
      expect(out.distanceTo(snapped)).toBeLessThan(1e-6);
    }
  });

  it('survives a sun directly overhead', () => {
    // `cross(up, forward)` has no length there, and a NaN in the shadow target
    // takes the whole shadow map with it.
    const out = snapToShadowTexels(
      new Vector3(31.4, 2, -17.9),
      new Vector3(0, 1, 0),
      UP,
      texel,
      new Vector3(),
    );
    expect(Number.isFinite(out.x)).toBe(true);
    expect(Number.isFinite(out.y)).toBe(true);
    expect(Number.isFinite(out.z)).toBe(true);
  });
});
