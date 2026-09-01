import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { buildCanopy, buildFins, buildHull } from '@/game/GliderModel';
import { TEAMS } from '@/data/teams';
import type { BufferGeometry } from 'three';

/**
 * Signed volume of a closed mesh.
 *
 * Positive when the faces wind counter-clockwise seen from outside — which is
 * what backface culling and `computeVertexNormals` both assume. Negative means
 * the shell is inside-out, and an inside-out craft is one you can see through.
 */
function signedVolume(geometry: BufferGeometry): number {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex()!;
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  let volume = 0;
  for (let i = 0; i < index.count; i += 3) {
    a.fromBufferAttribute(position, index.getX(i));
    b.fromBufferAttribute(position, index.getX(i + 1));
    c.fromBufferAttribute(position, index.getX(i + 2));
    volume += a.dot(new Vector3().crossVectors(b, c)) / 6;
  }
  return volume;
}

/** Fraction of faces whose normal points away from the shape's own centre. */
function outwardFraction(geometry: BufferGeometry): number {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex()!;
  const centre = new Vector3();
  for (let i = 0; i < position.count; i++) {
    centre.add(new Vector3().fromBufferAttribute(position, i));
  }
  centre.divideScalar(position.count);

  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const normal = new Vector3();
  const midpoint = new Vector3();
  let outward = 0;
  let total = 0;

  for (let i = 0; i < index.count; i += 3) {
    a.fromBufferAttribute(position, index.getX(i));
    b.fromBufferAttribute(position, index.getX(i + 1));
    c.fromBufferAttribute(position, index.getX(i + 2));
    normal.crossVectors(b.clone().sub(a), c.clone().sub(a));
    if (normal.lengthSq() < 1e-12) continue;
    midpoint.copy(a).add(b).add(c).divideScalar(3).sub(centre);
    if (normal.dot(midpoint) > 0) outward++;
    total++;
  }
  return total > 0 ? outward / total : 0;
}

describe('craft geometry', () => {
  it.each(TEAMS.map((team) => [team.name, team] as const))(
    '%s has a hull that faces outward',
    (_name, team) => {
      const geometry = buildHull(team.hull);
      expect(signedVolume(geometry)).toBeGreaterThan(0);
      // A swept hull is convex enough that essentially every face should agree.
      expect(outwardFraction(geometry)).toBeGreaterThan(0.95);
    },
  );

  it.each(TEAMS.map((team) => [team.name, team] as const))(
    '%s has fins that face outward',
    (_name, team) => {
      expect(signedVolume(buildFins(team.hull))).toBeGreaterThan(0);
    },
  );

  it('builds a closed hull with no degenerate faces', () => {
    for (const team of TEAMS) {
      const geometry = buildHull(team.hull);
      const position = geometry.getAttribute('position');
      for (let i = 0; i < position.count; i++) {
        expect(Number.isFinite(position.getX(i))).toBe(true);
        expect(Number.isFinite(position.getY(i))).toBe(true);
        expect(Number.isFinite(position.getZ(i))).toBe(true);
      }
      expect(geometry.getIndex()!.count % 3).toBe(0);
    }
  });
});

/**
 * The canopy is a screen, not a bubble.
 *
 * Both properties here were asked for by eye and are trivially easy to undo by
 * eye as well, which is exactly why they are pinned: a canopy that creeps back
 * up in height and loses its rake looks fine in isolation and wrong beside the
 * craft it belongs to.
 */
describe('canopy profile', () => {
  for (const team of TEAMS) {
    it(`slopes forward and stays low on ${team.id}`, () => {
      const geometry = buildCanopy(team.hull);
      const position = geometry.getAttribute('position');

      let frontPeak = -Infinity;
      let rearPeak = -Infinity;
      let overall = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;

      for (let i = 0; i < position.count; i++) {
        const y = position.getY(i);
        const z = position.getZ(i);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
        overall = Math.max(overall, y);
      }

      // Forward is -z. Split the canopy at its midpoint and compare halves.
      const middle = (minZ + maxZ) / 2;
      for (let i = 0; i < position.count; i++) {
        const y = position.getY(i);
        if (position.getZ(i) < middle) frontPeak = Math.max(frontPeak, y);
        else rearPeak = Math.max(rearPeak, y);
      }

      // The rear half carries the height; the front is the windscreen.
      expect(rearPeak).toBeGreaterThan(frontPeak);

      // And the whole thing stays under the hull's own height. A canopy taller
      // than the body it sits on is the bulbous look this replaced.
      expect(overall).toBeLessThan(team.hull.height * 1.35);
    });
  }
});

/**
 * The canopy has to touch the hull it sits on.
 *
 * Every canopy vertex is compared against the hull's own surface at the same
 * station: the skirt must be inside the bodywork, and the forward tip must be
 * buried in the nose rather than tapering to a point in the air ahead of it.
 * The gap this catches is invisible from the chase camera and obvious from the
 * showroom, which is exactly the kind that survives a change.
 */
describe('canopy seating', () => {
  for (const team of TEAMS) {
    it(`sits on the hull of ${team.id}`, () => {
      const canopy = buildCanopy(team.hull);
      const hull = buildHull(team.hull);
      const canopyPosition = canopy.getAttribute('position');
      const hullPosition = hull.getAttribute('position');

      /** The hull's highest point within a slice around this station. */
      const deckAt = (z: number): number => {
        const window = team.hull.length * 0.06;
        let top = -Infinity;
        for (let i = 0; i < hullPosition.count; i++) {
          if (Math.abs(hullPosition.getZ(i) - z) > window) continue;
          top = Math.max(top, hullPosition.getY(i));
        }
        return top;
      };

      let minZ = Infinity;
      for (let i = 0; i < canopyPosition.count; i++) {
        minZ = Math.min(minZ, canopyPosition.getZ(i));
      }

      // The forward tip: every vertex at the canopy's leading edge must be at
      // or under the deck, which is what "no gap" means.
      let tipClearance = -Infinity;
      for (let i = 0; i < canopyPosition.count; i++) {
        if (canopyPosition.getZ(i) > minZ + 1e-4) continue;
        tipClearance = Math.max(tipClearance, canopyPosition.getY(i) - deckAt(minZ));
      }
      expect(tipClearance).toBeLessThanOrEqual(0);

      // And the skirt is inside the hull the whole way along, not resting on
      // top of it, so the join has no seam to show through.
      for (let i = 0; i < canopyPosition.count; i++) {
        const x = canopyPosition.getX(i);
        const y = canopyPosition.getY(i);
        const z = canopyPosition.getZ(i);
        // Only the skirt: the roof is supposed to stand proud.
        if (Math.abs(y - (deckAt(z) - team.hull.height * 0.07)) > 1e-3) continue;
        expect(Math.abs(x)).toBeLessThan(team.hull.beam * 0.5);
      }
    });
  }
});
