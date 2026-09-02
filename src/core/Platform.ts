/**
 * Whether this is a device you drive with your thumbs.
 *
 * Decided once, at import, and read everywhere else. One answer means the menu
 * and the race cannot disagree about it, and it means the desktop build takes
 * exactly one branch at startup and never thinks about phones again.
 *
 * **Both queries, not either.** A touch-screen laptop reports `pointer: coarse`
 * for its digitiser and would fail a test on that alone, but it still reports
 * `hover: hover` for its trackpad. A phone has neither. Requiring both is what
 * keeps the desktop build on the desktop, which is the whole requirement here —
 * a false positive costs a keyboard user their interface.
 *
 * Not a user-agent string, which lies, and not `navigator.maxTouchPoints`,
 * which counts a Wacom tablet.
 */
export const IS_TOUCH_DEVICE: boolean =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(pointer: coarse)').matches &&
  window.matchMedia('(hover: none)').matches;

/** Pixels of screen the hardware has taken: a notch, a home indicator, a curve. */
export interface SafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const _insets: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * What the phone's own hardware is covering, in CSS pixels.
 *
 * Read back out of the document rather than guessed at, by way of four custom
 * properties the stylesheet sets from `env(safe-area-inset-*)`. There is no way
 * to read `env()` from script directly, and a fire button under a notch is a
 * fire button that does not exist.
 *
 * The returned object is reused; copy from it rather than holding onto it.
 */
export function safeAreaInsets(): SafeAreaInsets {
  if (typeof window === 'undefined') return _insets;

  const style = getComputedStyle(document.documentElement);
  _insets.top = pixels(style.getPropertyValue('--safe-top'));
  _insets.right = pixels(style.getPropertyValue('--safe-right'));
  _insets.bottom = pixels(style.getPropertyValue('--safe-bottom'));
  _insets.left = pixels(style.getPropertyValue('--safe-left'));
  return _insets;
}

function pixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
