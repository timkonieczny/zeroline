/**
 * The colours an interface surface is drawn with.
 *
 * Two schemes exist because the two surfaces sit on opposite backgrounds: the
 * HUD is drawn over a bright circuit under a hard sun, and the menu is a lit
 * showroom. Sharing one palette between them would leave one of the two
 * illegible, and hard-coding colours per widget makes changing either a
 * twenty-file edit.
 */
export interface UiPalette {
  /** Primary text. */
  ink: number;
  /** Secondary text: labels, annotations, anything supporting. */
  dim: number;
  /** Disabled or locked text. */
  muted: number;
  /** The one saturated colour, used for selection and emphasis. */
  accent: number;
  /** Fill behind a selected row. */
  highlight: number;
  /** Opacity of that fill. */
  highlightAlpha: number;
  /** Hairlines and dividers. */
  rule: number;
}

/** For anything drawn over the circuit: light type on a dark scrim. */
export const DARK_UI: UiPalette = {
  ink: 0xf2f6fa,
  dim: 0x8b97a3,
  muted: 0x49525b,
  accent: 0x24d4ff,
  highlight: 0x24d4ff,
  highlightAlpha: 0.14,
  rule: 0x2c3945,
};

/**
 * For the showroom: dark type on white.
 *
 * The accent is a deeper blue than the HUD's cyan on purpose — 0x24d4ff has
 * barely two-to-one contrast against a white floor, so selection would be
 * decorative rather than readable.
 */
export const LIGHT_UI: UiPalette = {
  // One dark grey for everything at rest, and the blue purely for what is
  // selected. Three tones on a white set meant a third of the interface was
  // always the least legible thing on screen for no reason anyone could see.
  ink: 0x243039,
  dim: 0x243039,
  muted: 0x9aa6b1,
  accent: 0x0072a8,
  highlight: 0x0072a8,
  highlightAlpha: 0.14,
  rule: 0xbac4cc,
};
