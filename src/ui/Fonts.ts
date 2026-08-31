/**
 * The interface typeface.
 *
 * Geo ships one weight in roman and italic, so hierarchy comes from size,
 * tracking and the italic — not from weight. Anything asking for bold would get
 * a synthesised faux-bold from the canvas rasteriser, which looks exactly as bad
 * as it sounds, so every style in the game specifies 400.
 */
export const UI_FONT = "'Geo', 'Segoe UI', 'SF Pro Display', system-ui, sans-serif";

/** The only weight Geo has. */
export const UI_WEIGHT = 400;

/**
 * Waits for the typeface to be usable by the canvas rasteriser.
 *
 * A `<link>` in the document is not enough: canvas silently falls back to the
 * next family in the stack if the face has not finished loading when `fillText`
 * runs, and every label built before then would be rasterised in the wrong font
 * and never redrawn.
 */
export async function loadUiFont(): Promise<boolean> {
  if (!('fonts' in document)) return false;
  try {
    await Promise.all([
      document.fonts.load(`${UI_WEIGHT} 32px 'Geo'`),
      document.fonts.load(`italic ${UI_WEIGHT} 32px 'Geo'`),
    ]);
    await document.fonts.ready;
    return document.fonts.check(`${UI_WEIGHT} 32px 'Geo'`);
  } catch {
    // Offline, or the font service is unreachable. The fallback stack is fine.
    return false;
  }
}
