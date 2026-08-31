import { describe, expect, it } from 'vitest';
import { Rng } from '@/core/Rng';
import { angleDelta, catmullRomLoop, clamp, damp, lerp, moveTowards, smoothstep, wrap, wrapDelta } from '@/core/math';

describe('math', () => {
  it('wraps into range from either direction', () => {
    expect(wrap(5, 4)).toBe(1);
    expect(wrap(-1, 4)).toBe(3);
    expect(wrap(-9, 4)).toBe(3);
    expect(wrap(0, 4)).toBe(0);
  });

  it('takes the short way round a loop', () => {
    // Forward across the seam is shorter than three quarters backwards.
    expect(wrapDelta(9, 1, 10)).toBe(2);
    expect(wrapDelta(1, 9, 10)).toBe(-2);
    expect(wrapDelta(0, 5, 10)).toBe(5);
  });

  it('measures the short angular difference', () => {
    expect(angleDelta(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2, 9);
    expect(angleDelta(0, -Math.PI / 2)).toBeCloseTo(-Math.PI / 2, 9);
    // Just past half a turn should come back as a small negative angle.
    expect(angleDelta(0, Math.PI + 0.1)).toBeCloseTo(-Math.PI + 0.1, 9);
  });

  it('damps at the same rate regardless of step size', () => {
    // One second of damping in one step and in a hundred must agree.
    const coarse = damp(10, 0, 0.25, 1);
    let fine = 10;
    for (let i = 0; i < 100; i++) fine = damp(fine, 0, 0.25, 0.01);
    expect(fine).toBeCloseTo(coarse, 9);
    // A quarter-second half-life means four halvings in a second.
    expect(coarse).toBeCloseTo(10 / 16, 9);
  });

  it('moves toward a target without overshooting it', () => {
    expect(moveTowards(0, 10, 3)).toBe(3);
    expect(moveTowards(0, 2, 3)).toBe(2);
    expect(moveTowards(0, -2, 3)).toBe(-2);
  });

  it('clamps, lerps and smoothsteps to their endpoints', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(lerp(10, 20, 0.25)).toBe(12.5);
    expect(smoothstep(0, 1, 0)).toBe(0);
    expect(smoothstep(0, 1, 1)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 9);
  });

  it('interpolates a closed loop of scalars without a seam', () => {
    const values = [0, 10, 20, 10];
    // Sampling either side of the wrap point must agree.
    expect(catmullRomLoop(values, 0)).toBeCloseTo(catmullRomLoop(values, 1), 9);
    expect(catmullRomLoop(values, 0.9999)).toBeCloseTo(catmullRomLoop(values, 0), 1);
    expect(catmullRomLoop(values, 0.25)).toBeCloseTo(10, 9);
  });
});

describe('Rng', () => {
  it('is deterministic for a given seed', () => {
    const a = new Rng(1234);
    const b = new Rng(1234);
    for (let i = 0; i < 50; i++) expect(a.next()).toBe(b.next());
  });

  it('gives different streams for different seeds', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    const differ = Array.from({ length: 20 }, () => a.next() !== b.next());
    expect(differ.filter(Boolean).length).toBeGreaterThan(18);
  });

  it('stays inside the unit interval and covers it', () => {
    const rng = new Rng(99);
    let min = 1;
    let max = 0;
    for (let i = 0; i < 20000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    expect(min).toBeLessThan(0.001);
    expect(max).toBeGreaterThan(0.999);
  });

  it('picks weighted indices in proportion', () => {
    const rng = new Rng(7);
    const weights = [1, 3, 0, 6];
    const counts = [0, 0, 0, 0];
    const trials = 40000;
    for (let i = 0; i < trials; i++) counts[rng.weighted(weights)]!++;

    expect(counts[2]).toBe(0);
    expect(counts[0]! / trials).toBeCloseTo(0.1, 1);
    expect(counts[1]! / trials).toBeCloseTo(0.3, 1);
    expect(counts[3]! / trials).toBeCloseTo(0.6, 1);
  });

  it('handles a degenerate weight set rather than throwing', () => {
    const rng = new Rng(3);
    expect(rng.weighted([0, 0, 0])).toBe(0);
    expect(rng.weighted([])).toBe(0);
  });

  it('forks into independent but reproducible streams', () => {
    const parent = new Rng(42);
    const first = parent.fork(1).next();
    const second = new Rng(42).fork(1).next();
    expect(first).toBe(second);
    expect(new Rng(42).fork(2).next()).not.toBe(first);
  });
});
