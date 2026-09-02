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

/**
 * The two multipliers compose, and their floors have to compose with them.
 *
 * `MIN_SCALE` is a floor on the picture, not on the scaler's own number: the
 * point past which dropping resolution costs more than the frame rate it buys.
 * Applied to the scaler alone it stops meaning that the moment a player picks a
 * ceiling — the bottom rung on a 2x display times a scaler at its floor is 0.275
 * of native, half as sharp again as the floor was ever meant to allow.
 *
 * This is arithmetic over the same numbers the ladder produces, so it is pinned
 * here rather than needing a renderer.
 */
describe('resolution floors', () => {
  const MIN_SCALE = 0.55;
  const effective = (base: number, adaptive: number): number =>
    base * Math.max(Math.min(1, MIN_SCALE / base), Math.min(adaptive, 1));

  it('never lets the picture fall below the floor', () => {
    for (const dpr of [1, 1.5, 2, 3]) {
      const bottom = resolutionLadder(1600, 900, dpr)[0]!.scale;
      // The scaler asking for everything it can get.
      const worst = effective(bottom, 0);
      expect(worst, `dpr ${dpr}`).toBeGreaterThanOrEqual(Math.min(bottom, MIN_SCALE) - 1e-9);
    }
  });

  it('leaves the scaler room under a high ceiling', () => {
    // At native, the scaler still has its full range.
    expect(effective(1, 0)).toBeCloseTo(MIN_SCALE, 6);
  });

  it('gives the scaler no room under a ceiling already past the floor', () => {
    // A rung below the floor is the player spending the budget by hand; the
    // scaler must not spend it twice.
    expect(effective(0.5, 0)).toBeCloseTo(0.5, 6);
    expect(effective(1 / 3, 0)).toBeCloseTo(1 / 3, 6);
  });
});
