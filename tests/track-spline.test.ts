import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { TrackSpline, createTrackFrame } from '@/track/TrackSpline';
import { meridianCoast } from '@/data/tracks/meridian-coast';
import { buildPath } from '@/track/TrackPath';

/** A clean circle of radius 100 in the XZ plane: every property is known analytically. */
function circleSpline(radius = 100, points = 24): TrackSpline {
  const control: [number, number, number][] = [];
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2;
    control.push([Math.cos(a) * radius, 0, Math.sin(a) * radius]);
  }
  return new TrackSpline({
    points: control,
    widths: new Array(points).fill(30),
    banks: new Array(points).fill(0),
    spacing: 1,
  });
}

function meridianSpline(): TrackSpline {
  const path = buildPath(meridianCoast.corners);
  return new TrackSpline({
    points: path.points,
    widths: path.widths,
    banks: path.banks,
    spacing: meridianCoast.spacing,
  });
}

describe('TrackSpline', () => {
  it('measures arc length to within a fraction of a percent', () => {
    const spline = circleSpline(100, 24);
    const expected = 2 * Math.PI * 100;
    expect(spline.length).toBeGreaterThan(expected * 0.998);
    expect(spline.length).toBeLessThan(expected * 1.002);
  });

  it('spaces samples uniformly along the arc', () => {
    const spline = circleSpline();
    const a = createTrackFrame();
    const b = createTrackFrame();
    for (let s = 0; s < spline.length; s += spline.length / 37) {
      spline.sample(s, a);
      spline.sample(s + 10, b);
      // Chord over a 10 m arc on a 100 m circle: 2*R*sin(theta/2) = 9.9583.
      expect(a.position.distanceTo(b.position)).toBeCloseTo(9.9583, 1);
    }
  });

  it('produces an orthonormal frame everywhere on a real circuit', () => {
    const spline = meridianSpline();
    const f = createTrackFrame();
    for (let i = 0; i < 400; i++) {
      spline.sample((i / 400) * spline.length, f);
      expect(f.tangent.length()).toBeCloseTo(1, 5);
      expect(f.up.length()).toBeCloseTo(1, 5);
      expect(f.right.length()).toBeCloseTo(1, 5);
      expect(f.tangent.dot(f.up)).toBeCloseTo(0, 5);
      expect(f.tangent.dot(f.right)).toBeCloseTo(0, 5);
      expect(f.up.dot(f.right)).toBeCloseTo(0, 5);
    }
  });

  it('closes the loop without a seam in position or frame', () => {
    const spline = meridianSpline();
    const before = createTrackFrame();
    const after = createTrackFrame();
    spline.sample(spline.length - 0.05, before);
    spline.sample(0.05, after);
    expect(before.position.distanceTo(after.position)).toBeLessThan(0.5);
    expect(before.tangent.dot(after.tangent)).toBeGreaterThan(0.999);
    // The closure defect is distributed around the lap, so the joint itself
    // must not carry a visible twist.
    expect(before.up.dot(after.up)).toBeGreaterThan(0.999);
  });

  it('never flips the frame between neighbouring samples', () => {
    const spline = meridianSpline();
    const a = createTrackFrame();
    const b = createTrackFrame();
    const step = 2;
    let worst = 1;
    for (let s = 0; s < spline.length; s += step) {
      spline.sample(s, a);
      spline.sample(s + step, b);
      worst = Math.min(worst, a.up.dot(b.up));
    }
    // Over 2 m the reference frame should barely move at all.
    expect(worst).toBeGreaterThan(0.99);
  });

  it('wraps arc length in both directions', () => {
    const spline = circleSpline();
    expect(spline.wrapS(-1)).toBeCloseTo(spline.length - 1, 6);
    expect(spline.wrapS(spline.length + 1)).toBeCloseTo(1, 6);
  });

  it('applies authored bank as a roll about the tangent', () => {
    const points = 16;
    const control: [number, number, number][] = [];
    for (let i = 0; i < points; i++) {
      const a = (i / points) * Math.PI * 2;
      control.push([Math.cos(a) * 100, 0, Math.sin(a) * 100]);
    }
    const flat = new TrackSpline({
      points: control,
      widths: new Array(points).fill(30),
      banks: new Array(points).fill(0),
      spacing: 2,
    });
    const banked = new TrackSpline({
      points: control,
      widths: new Array(points).fill(30),
      banks: new Array(points).fill(Math.PI / 6),
      spacing: 2,
    });
    const a = createTrackFrame();
    const b = createTrackFrame();
    flat.sample(50, a);
    banked.sample(50, b);
    expect(a.up.angleTo(b.up)).toBeCloseTo(Math.PI / 6, 3);
    expect(b.up.dot(b.tangent)).toBeCloseTo(0, 6);
  });

  it('interpolates authored width between control points', () => {
    const points = 8;
    const control: [number, number, number][] = [];
    for (let i = 0; i < points; i++) {
      const a = (i / points) * Math.PI * 2;
      control.push([Math.cos(a) * 100, 0, Math.sin(a) * 100]);
    }
    const widths = [40, 40, 20, 20, 20, 40, 40, 40];
    const spline = new TrackSpline({
      points: control,
      widths,
      banks: new Array(points).fill(0),
      spacing: 2,
    });
    let min = Infinity;
    let max = -Infinity;
    for (let s = 0; s < spline.length; s += 2) {
      const w = spline.widthAtS(s);
      min = Math.min(min, w);
      max = Math.max(max, w);
    }
    expect(min).toBeGreaterThan(18);
    expect(max).toBeLessThan(42);
  });

  it('builds MERIDIAN COAST at the intended scale', () => {
    const spline = meridianSpline();
    expect(spline.length).toBeGreaterThan(3000);
    expect(spline.length).toBeLessThan(3500);
    // Uniform sampling at the authored spacing.
    expect(spline.step).toBeCloseTo(meridianCoast.spacing, 1);
    const p = new Vector3();
    spline.positionOfSample(0, p);
    expect(Number.isFinite(p.x)).toBe(true);
  });
});
