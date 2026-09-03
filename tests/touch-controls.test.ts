import { describe, expect, it } from 'vitest';
import { placeTouchControls, type PadPlacement } from '@/game/TouchPads';
import type { SafeAreaInsets } from '@/core/Platform';

const NO_INSETS: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/** A Pixel 8 held sideways, and the logical viewport the overlay gets for it. */
const PHONE = { width: 864, height: 327 };
/** `App.uiScale`, floor and all — below 0.62 the type stops being readable. */
const PHONE_SCALE = Math.max(0.62, Math.min(1, PHONE.width / 1120, PHONE.height / 560));
const LOGICAL = { width: PHONE.width / PHONE_SCALE, height: PHONE.height / PHONE_SCALE };

function place(insets = NO_INSETS): Map<string, PadPlacement> {
  const list = placeTouchControls(LOGICAL.width, LOGICAL.height, insets, PHONE_SCALE);
  return new Map(list.map((pad) => [pad.id, pad]));
}

/** Where a control is drawn, converted into the CSS pixels a tap arrives in. */
function drawnAt(pad: PadPlacement): { x: number; y: number } {
  return { x: pad.x * PHONE_SCALE, y: (LOGICAL.height - pad.y) * PHONE_SCALE };
}

function contains(pad: PadPlacement, point: { x: number; y: number }): boolean {
  const r = pad.region;
  return point.x >= r.x && point.x <= r.x + r.width && point.y >= r.y && point.y <= r.y + r.height;
}

/**
 * The two coordinate systems the touch controls straddle.
 *
 * They are drawn in the overlay's logical pixels — of which a phone is handed
 * more than it has real ones, so the layout the interface was authored for
 * still fits — and they are pressed in CSS pixels counted from the top of the
 * screen. Leaving a hit box in the first is not an offset, it is a different
 * size, and it has already shipped once: the right airbrake's box began 1320
 * pixels across an 864-pixel screen and the pause button's sat 280 pixels to
 * the right of the button.
 *
 * So what is pinned here is the only thing that actually matters — that where a
 * control is drawn is where pressing it works.
 */
describe('touch control placement', () => {
  it('puts every hit box where its control is drawn', () => {
    for (const pad of place().values()) {
      expect(contains(pad, drawnAt(pad)), `${pad.id} is not where it is drawn`).toBe(true);
    }
  });

  it('keeps every hit box on the screen', () => {
    for (const pad of place().values()) {
      const r = pad.region;
      expect(r.x, `${pad.id} left`).toBeGreaterThanOrEqual(0);
      expect(r.y, `${pad.id} top`).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width, `${pad.id} right`).toBeLessThanOrEqual(PHONE.width);
      expect(r.y + r.height, `${pad.id} bottom`).toBeLessThanOrEqual(PHONE.height);
    }
  });

  it('puts the pause button on the centre line', () => {
    const pause = place().get('pause')!;
    expect(drawnAt(pause).x).toBeCloseTo(PHONE.width / 2, 3);
    expect(contains(pause, { x: PHONE.width / 2, y: drawnAt(pause).y })).toBe(true);
  });

  it('keeps the thumbs apart and in their own corners', () => {
    const pads = place();
    const left = pads.get('brakeLeft')!.region;
    const right = pads.get('brakeRight')!.region;

    expect(left.x + left.width).toBeLessThan(right.x);
    // Both along the bottom, both clear of the screen edge where the system
    // keeps its own back-swipe.
    expect(left.x).toBeGreaterThan(0);
    expect(right.x + right.width).toBeLessThan(PHONE.width);
    expect(left.y + left.height).toBeGreaterThan(PHONE.height * 0.5);
  });

  it('gives every control at least the minimum touch target', () => {
    // A logical pixel is well under a CSS one here, so a box that is generous
    // where it is drawn can still arrive at the glass too small to hit.
    for (const pad of place().values()) {
      expect(pad.region.width, `${pad.id} width`).toBeGreaterThanOrEqual(44);
      expect(pad.region.height, `${pad.id} height`).toBeGreaterThanOrEqual(44);
    }
  });

  it('leaves the airbrakes live to the top of the pad and short of the edge', () => {
    for (const id of ['brakeLeft', 'brakeRight'] as const) {
      const pad = place().get(id)!;
      // The whole drawn circle presses, top included.
      const top = { x: pad.x * PHONE_SCALE, y: (LOGICAL.height - pad.y - pad.radius) * PHONE_SCALE };
      expect(contains(pad, top), `${id} top`).toBe(true);
      // And the very bottom corner does not, because the system wants it.
      expect(pad.region.y + pad.region.height, `${id} bottom`).toBeLessThan(PHONE.height);
    }
  });

  it('moves the controls in out of a notch', () => {
    // Landscape on a notched phone puts 59 px of inset on one side.
    const inset: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 59 };
    const plain = place().get('absorb')!.region;
    const notched = place(inset).get('absorb')!.region;

    expect(notched.x).toBeGreaterThan(plain.x);
    expect(notched.x).toBeGreaterThanOrEqual(59);
  });

  it('only flips the axis on a desktop, where the two systems are the same', () => {
    const desktop = placeTouchControls(1600, 900, NO_INSETS, 1);

    for (const pad of desktop) {
      // The airbrakes are the exception by design: their box is the corner they
      // sit in rather than the circle drawn in it, because a thumb arrives at
      // the corner. Everything else is boxed on its own centre.
      if (pad.id === 'brakeLeft' || pad.id === 'brakeRight') continue;
      expect(pad.region.y + pad.region.height / 2, pad.id).toBeCloseTo(900 - pad.y, 3);
      expect(pad.region.x + pad.region.width / 2, pad.id).toBeCloseTo(pad.x, 3);
    }
  });
});
