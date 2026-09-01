/** One rung of the resolution ladder. */
export interface ResolutionRung {
  /** Multiplier applied on top of the display's pixel ratio. */
  scale: number;
  /** Backbuffer size this produces, in real device pixels. */
  width: number;
  height: number;
  /** What the settings row shows, e.g. `1526 × 706`. */
  label: string;
}

/** How many rungs the ladder has, ends included. */
const RUNGS = 5;
/**
 * Lowest rung when the display has no scaling of its own.
 *
 * The ladder normally runs from the logical size to the native one, and on a
 * display where those are the same value there is no ladder at all. It becomes
 * a plain downscale instead, from 60% to full.
 */
const FLAT_DISPLAY_FLOOR = 0.6;
/** Pixel ratios within this of 1 are treated as having no scaling. */
const FLAT_EPSILON = 0.05;

/**
 * The resolutions the player can choose between, lowest first.
 *
 * The rungs are multipliers on top of the display's pixel ratio, because that
 * is what the renderer takes: the top rung is 1, which is the display's real
 * pixel density, and the bottom is `1 / dpr`, which makes the backbuffer
 * exactly the CSS size — the resolution the page thinks it is, before the
 * operating system's scaling was applied to it.
 *
 * Those two are the ends worth naming. Everything on this circuit is fill-bound
 * — two thirds of a frame is full-screen passes — so the number of pixels is
 * the single largest lever the player has, and it is worth showing them what
 * they are actually choosing rather than a percentage.
 */
export function resolutionLadder(cssWidth: number, cssHeight: number, pixelRatio: number): ResolutionRung[] {
  const lowest = pixelRatio > 1 + FLAT_EPSILON ? 1 / pixelRatio : FLAT_DISPLAY_FLOOR;
  const rungs: ResolutionRung[] = [];

  for (let i = 0; i < RUNGS; i++) {
    const scale = lowest + ((1 - lowest) * i) / (RUNGS - 1);
    const width = Math.round(cssWidth * pixelRatio * scale);
    const height = Math.round(cssHeight * pixelRatio * scale);
    rungs.push({ scale, width, height, label: `${width} × ${height}` });
  }

  return rungs;
}

/** The rung nearest a saved scale, so a setting survives a change of display. */
export function nearestRung(rungs: readonly ResolutionRung[], scale: number): number {
  let best = rungs.length - 1;
  let bestDistance = Infinity;
  for (let i = 0; i < rungs.length; i++) {
    const distance = Math.abs(rungs[i]!.scale - scale);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}
