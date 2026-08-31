import { describe, expect, it } from 'vitest';
import { buildPath, type TrackVertex } from '@/track/TrackPath';
import { Track } from '@/track/Track';
import { meridianCoast } from '@/data/tracks/meridian-coast';

/** A square with generous corner radii: every quantity is known by hand. */
function square(radius = 40): TrackVertex[] {
  return [
    { x: 0, z: 0, radius, height: 0, width: 30 },
    { x: 300, z: 0, radius, height: 0, width: 30 },
    { x: 300, z: 300, radius, height: 0, width: 30 },
    { x: 0, z: 300, radius, height: 0, width: 30 },
  ];
}

describe('buildPath', () => {
  it('closes the loop exactly, because the polygon does', () => {
    const path = buildPath(square());
    const first = path.points[0]!;
    const last = path.points[path.points.length - 1]!;
    // The final emitted point is one spacing step short of the start.
    const gap = Math.hypot(last[0] - first[0], last[2] - first[2]);
    expect(gap).toBeLessThan(10);
  });

  it('turns through exactly one full circle', () => {
    const path = buildPath(square());
    const total = path.corners.reduce((sum, corner) => sum + corner.turn, 0);
    expect(Math.abs(total)).toBeCloseTo(360, 4);
  });

  it('measures a square of known dimensions', () => {
    const radius = 40;
    const path = buildPath(square(radius));
    // Perimeter minus the corner cuts, plus the arcs that replace them.
    const straights = 4 * (300 - 2 * radius);
    const arcs = 2 * Math.PI * radius;
    expect(path.length).toBeCloseTo(straights + arcs, 0);
  });

  it('reports each corner it built', () => {
    const path = buildPath(square());
    expect(path.corners).toHaveLength(4);
    for (const corner of path.corners) {
      expect(Math.abs(corner.turn)).toBeCloseTo(90, 3);
      expect(corner.radius).toBeCloseTo(40, 6);
      expect(corner.arcLength).toBeGreaterThan(0);
      expect(corner.entryStraight).toBeGreaterThan(0);
    }
  });

  it('shrinks crowded corners rather than producing a broken track', () => {
    // A radius far too large for the 300 m legs it has to fit between.
    const path = buildPath(square(400));
    for (const corner of path.corners) {
      expect(corner.radius).toBeLessThan(400);
      expect(corner.entryStraight).toBeGreaterThanOrEqual(0);
    }
    expect(path.length).toBeGreaterThan(0);
    expect(path.points.every((p) => p.every(Number.isFinite))).toBe(true);
  });

  it('shrinks only the offending pair, not the whole circuit', () => {
    // A hexagon with one very short leg. Only the two corners on that leg are
    // over-subscribed; the other four have room and must be left alone.
    const vertices: TrackVertex[] = [
      { x: 0, z: 0, radius: 50, height: 0, width: 30 },
      { x: 200, z: 0, radius: 50, height: 0, width: 30 },
      { x: 215, z: 15, radius: 50, height: 0, width: 30 },
      { x: 200, z: 230, radius: 50, height: 0, width: 30 },
      { x: 0, z: 230, radius: 50, height: 0, width: 30 },
      { x: -60, z: 120, radius: 50, height: 0, width: 30 },
    ];
    const path = buildPath(vertices);
    const untouched = path.corners.filter((c) => Math.abs(c.radius - 50) < 0.01);
    const shrunk = path.corners.filter((c) => c.radius < 49.99);
    expect(shrunk.length).toBe(2);
    expect(untouched.length).toBe(4);
    for (const corner of path.corners) expect(corner.entryStraight).toBeGreaterThanOrEqual(0);
  });

  it('banks corners from their radius and eases the transitions', () => {
    const path = buildPath(square(40));
    const maxBank = Math.max(...path.banks.map(Math.abs));
    // A 40 m corner is tight enough to hit the camber ceiling.
    expect(maxBank).toBeGreaterThan((20 * Math.PI) / 180);
    expect(maxBank).toBeLessThanOrEqual((24.5 * Math.PI) / 180);

    // No sudden jump: bank must ramp rather than step at the corner entry.
    // Measured per metre, because the point spacing is what it is.
    const spacing = path.length / path.banks.length;
    let worst = 0;
    for (let i = 1; i < path.banks.length; i++) {
      worst = Math.max(worst, Math.abs(path.banks[i]! - path.banks[i - 1]!));
    }
    const degreesPerMetre = ((worst / spacing) * 180) / Math.PI;
    expect(degreesPerMetre).toBeLessThan(1.2);
  });

  it('rejects a degenerate polygon', () => {
    expect(() => buildPath([{ x: 0, z: 0, radius: 10, height: 0, width: 20 }])).toThrow();
    expect(() =>
      buildPath([
        { x: 0, z: 0, radius: 10, height: 0, width: 20 },
        { x: 0, z: 0, radius: 10, height: 0, width: 20 },
        { x: 10, z: 10, radius: 10, height: 0, width: 20 },
      ]),
    ).toThrow();
  });
});

describe('Track', () => {
  const track = new Track(meridianCoast);

  it('resolves every authored feature into arc lengths on the lap', () => {
    expect(track.boostPads).toHaveLength(meridianCoast.boostPads.length);
    expect(track.pickupPads).toHaveLength(meridianCoast.pickupPads.length);
    for (const pad of [...track.boostPads, ...track.pickupPads]) {
      expect(pad.s).toBeGreaterThanOrEqual(0);
      expect(pad.s).toBeLessThan(track.length);
      // A pad must fit inside the road it sits on, with room for a craft.
      const halfWidth = track.spline.widthAtS(pad.s) * 0.5;
      expect(Math.abs(pad.lateral) + pad.halfWidth).toBeLessThan(halfWidth);
    }
  });

  it('knows which district and tunnel any point belongs to', () => {
    const tunnel = track.tunnels[0]!;
    const inside = (tunnel.fromS + tunnel.toS) / 2;
    expect(track.isInTunnel(inside)).toBe(true);
    expect(track.isInTunnel(tunnel.fromS - 30)).toBe(false);

    for (let s = 0; s < track.length; s += 50) {
      expect(track.districtAt(s)).toBeDefined();
    }
  });

  it('lays out a grid that fits on the road behind the line', () => {
    for (let slot = 0; slot < 8; slot++) {
      const { s, lateral } = track.gridSlot(slot);
      const halfWidth = track.spline.widthAtS(s) * 0.5;
      expect(Math.abs(lateral)).toBeLessThan(halfWidth - 3);
    }
    // Slots run backwards from the line, two abreast.
    expect(track.gridSlot(0).lateral).toBeLessThan(0);
    expect(track.gridSlot(1).lateral).toBeGreaterThan(0);
  });

  it('keeps MERIDIAN COAST free of corners too tight to drive', () => {
    for (const corner of track.corners) {
      expect(corner.radius).toBeGreaterThan(45);
      expect(corner.entryStraight).toBeGreaterThan(20);
    }
  });
});
