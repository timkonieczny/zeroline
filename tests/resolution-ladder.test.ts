import { describe, expect, it } from 'vitest';
import { nearestRung, resolutionLadder } from '@/core/ResolutionLadder';

/**
 * The ladder is the player's largest performance lever and it is built out of
 * arithmetic that is easy to get subtly wrong — an off-by-one in the rung
 * spacing, or a floor that collapses on a display without scaling. None of that
 * would throw; it would just quietly offer the wrong resolutions.
 */
describe('resolution ladder', () => {
  it('runs from the logical size to the native one', () => {
    // 1272x588 CSS at 150% scaling: 1908x882 of real pixels.
    const rungs = resolutionLadder(1272, 588, 1.5);

    expect(rungs).toHaveLength(5);
    expect(rungs[0]!.width).toBe(1272);
    expect(rungs[0]!.height).toBe(588);
    expect(rungs[4]!.width).toBe(1908);
    expect(rungs[4]!.height).toBe(882);
  });

  it('climbs, and only climbs', () => {
    for (const dpr of [1, 1.25, 1.5, 2, 3]) {
      const rungs = resolutionLadder(1600, 900, dpr);
      for (let i = 1; i < rungs.length; i++) {
        expect(rungs[i]!.scale, `dpr ${dpr}`).toBeGreaterThan(rungs[i - 1]!.scale);
        expect(rungs[i]!.width, `dpr ${dpr}`).toBeGreaterThan(rungs[i - 1]!.width);
      }
      expect(rungs[rungs.length - 1]!.scale).toBeCloseTo(1, 6);
    }
  });

  it('does not collapse on a display without scaling', () => {
    // At dpr 1 the logical and native sizes are the same number, so anchoring
    // the bottom rung to `1 / dpr` would give five identical choices.
    const rungs = resolutionLadder(1920, 1080, 1);

    expect(rungs[0]!.width).toBeLessThan(rungs[4]!.width);
    expect(rungs[0]!.width).toBe(1152);
    expect(rungs[4]!.width).toBe(1920);
  });

  it('labels each rung with the pixels it actually renders', () => {
    const rungs = resolutionLadder(1272, 588, 1.5);
    for (const rung of rungs) {
      expect(rung.label).toBe(`${rung.width} × ${rung.height}`);
    }
  });

  it('finds the nearest rung to a saved scale', () => {
    const rungs = resolutionLadder(1272, 588, 1.5);

    // A scale saved on this display lands on its own rung.
    for (let i = 0; i < rungs.length; i++) {
      expect(nearestRung(rungs, rungs[i]!.scale)).toBe(i);
    }

    // One saved on a different display lands somewhere sensible rather than
    // throwing the setting away.
    expect(nearestRung(rungs, 0.2)).toBe(0);
    expect(nearestRung(rungs, 5)).toBe(rungs.length - 1);
  });
});
