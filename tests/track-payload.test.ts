import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { Track } from '@/track/Track';
import { TrackSpline } from '@/track/TrackSpline';
import { buildTrackGeometry } from '@/track/TrackGeometry';
import { toGeometryData, fromGeometryData } from '@/track/TrackPayload';
import { meridianCoast } from '@/data/tracks/meridian-coast';
import { createTrackFrame } from '@/track/TrackSpline';

/**
 * The worker path has to produce the same circuit as the inline one.
 *
 * It is the same code either side of a `postMessage`, which is precisely why
 * this is worth pinning: nothing about the arithmetic changed, so any
 * difference would come from the serialisation — a dropped array, a lane in the
 * wrong order, an index buffer that lost its type. All of those would still
 * load, still render, and be wrong in ways that only show up as a craft
 * driving through a barrier.
 */
describe('track payload', () => {
  const inline = new Track(meridianCoast);
  const rebuilt = new Track(meridianCoast, new TrackSpline(inline.spline.toData()));

  it('rebuilds a spline that samples identically', () => {
    const a = createTrackFrame();
    const b = createTrackFrame();

    expect(rebuilt.length).toBeCloseTo(inline.length, 6);
    expect(rebuilt.spline.count).toBe(inline.spline.count);

    for (let s = 0; s < inline.length; s += 7) {
      inline.spline.sample(s, a);
      rebuilt.spline.sample(s, b);
      expect(b.position.distanceTo(a.position)).toBeLessThan(1e-6);
      expect(b.tangent.distanceTo(a.tangent)).toBeLessThan(1e-6);
      expect(b.up.distanceTo(a.up)).toBeLessThan(1e-6);
      expect(b.width).toBeCloseTo(a.width, 6);
    }
  });

  it('resolves the same pads, tunnels and grid slots', () => {
    expect(rebuilt.boostPads).toEqual(inline.boostPads);
    expect(rebuilt.pickupPads).toEqual(inline.pickupPads);
    expect(rebuilt.tunnels).toEqual(inline.tunnels);
    for (let i = 0; i < 8; i++) {
      expect(rebuilt.gridSlot(i)).toEqual(inline.gridSlot(i));
    }
  });

  it('answers collision queries the same way', () => {
    // The collision grid is rebuilt from the spline rather than transferred, so
    // this is the check that the spline it was rebuilt from is the right one.
    const point = new Vector3();
    for (let s = 0; s < inline.length; s += 23) {
      const frame = inline.frameAt(s);
      point.copy(frame.position).addScaledVector(frame.up, 3);

      const a = inline.collision.query(point, s);
      const b = rebuilt.collision.query(point, s);
      expect(b.s).toBeCloseTo(a.s, 4);
      expect(b.lateral).toBeCloseTo(a.lateral, 4);
      expect(b.height).toBeCloseTo(a.height, 4);
    }
  });

  it('round-trips every geometry buffer', () => {
    const geometry = buildTrackGeometry(inline);
    for (const [name, source] of Object.entries(geometry)) {
      if (!source) continue;
      const copy = fromGeometryData(toGeometryData(source));

      for (const attribute of ['position', 'normal', 'uv', 'color']) {
        const from = source.getAttribute(attribute);
        const to = copy.getAttribute(attribute);
        expect(Boolean(to), `${name}.${attribute}`).toBe(Boolean(from));
        if (from && to) expect(to.count, `${name}.${attribute}`).toBe(from.count);
      }
      expect(copy.getIndex()?.count, `${name}.index`).toBe(source.getIndex()?.count);
    }
  });
});
