import { describe, expect, it } from 'vitest';
import {
  PITCH_RANGE,
  STEER_RANGE,
  TILT_DEADZONE,
  createTiltControls,
  createTiltNeutral,
  tiltToControls,
} from '@/core/Tilt';

const out = createTiltControls();
const neutral = createTiltNeutral();

/** Steering and pitch for a phone tilted `beta`/`gamma` degrees from flat. */
function at(beta: number, gamma: number, screenAngle = 90) {
  return { ...tiltToControls({ beta, gamma, screenAngle }, neutral, out) };
}

/**
 * The tilt mapping.
 *
 * This is the one piece of the phone build that cannot be checked by looking at
 * it: a sign error steers the craft into the wall and looks, in the code,
 * exactly like a sign that is right. What can be pinned without hardware is the
 * *relationships* — that the two landscape orientations are mirror images, that
 * the deadzone holds zero, that the ends of the range are reachable and the
 * middle is gentle — and those are what break when somebody edits the axes.
 */
describe('tilt to controls', () => {
  it('is centred when the phone is at the pose it was calibrated in', () => {
    expect(at(0, 0)).toEqual({ steer: 0, pitch: 0 });
  });

  it('reaches full lock at the end of its range, and no further', () => {
    expect(at(STEER_RANGE, 0).steer).toBeCloseTo(1, 6);
    expect(at(-STEER_RANGE, 0).steer).toBeCloseTo(-1, 6);
    // Past the range is still full lock, not more than full lock.
    expect(at(STEER_RANGE * 3, 0).steer).toBeCloseTo(1, 6);
    expect(at(0, PITCH_RANGE).pitch).toBeCloseTo(1, 6);
  });

  it('holds zero inside the deadzone and moves outside it', () => {
    expect(at(TILT_DEADZONE - 0.01, 0).steer).toBe(0);
    expect(at(-(TILT_DEADZONE - 0.01), 0).steer).toBe(0);
    expect(Math.abs(at(TILT_DEADZONE + 3, 0).steer)).toBeGreaterThan(0);
  });

  it('is gentle in the middle and steep at the end', () => {
    // A squared response: half the tilt is a quarter of the lock, which is the
    // whole point — a hand's width of movement has to mean a small correction.
    const half = at(TILT_DEADZONE + (STEER_RANGE - TILT_DEADZONE) * 0.5, 0).steer;
    expect(half).toBeCloseTo(0.25, 6);
  });

  it('mirrors between the two landscape orientations', () => {
    // 90 and 270 are the same pose turned through half a turn, so the same
    // physical tilt must steer the other way. Getting this wrong means the game
    // is uncontrollable in one of the two ways a phone can be held, and fine in
    // the other — which is exactly the bug that ships.
    const upright = at(12, 7, 90);
    const inverted = at(12, 7, 270);

    expect(inverted.steer).toBeCloseTo(-upright.steer, 6);
    expect(inverted.pitch).toBeCloseTo(-upright.pitch, 6);
    expect(Math.abs(upright.steer)).toBeGreaterThan(0);
  });

  it('separates the two axes', () => {
    // Rolling must not pitch, and pitching must not steer. They come off the
    // same event and are trivially crossed over.
    expect(at(STEER_RANGE, 0).pitch).toBe(0);
    expect(at(0, PITCH_RANGE).steer).toBe(0);
  });

  it('takes the short way round the wrap', () => {
    // `beta` runs to ±180 and wraps. A neutral taken at 178° and a reading at
    // -178° is four degrees of movement, not three hundred and fifty-six.
    const wrapped = createTiltNeutral();
    wrapped.beta = 178;

    const crossed = tiltToControls({ beta: -178, gamma: 0, screenAngle: 90 }, wrapped, out);
    expect(Math.abs(crossed.steer)).toBeLessThan(0.05);
  });

  it('measures from the neutral it was given, not from flat', () => {
    // The phone is calibrated wherever the player happens to be holding it.
    const held = createTiltNeutral();
    held.beta = 40;

    expect(tiltToControls({ beta: 40, gamma: 0, screenAngle: 90 }, held, out).steer).toBe(0);
    expect(
      tiltToControls({ beta: 40 + STEER_RANGE, gamma: 0, screenAngle: 90 }, held, out).steer,
    ).toBeCloseTo(1, 6);
  });
});

/**
 * The logical viewport the interface is laid out in.
 *
 * A phone is handed more logical pixels rather than a squeezed layout, and the
 * one property that must never break is that a desktop window is handed exactly
 * what it always was. A scale of 0.999 on a 1080p monitor would re-rasterise
 * every label in the game for no reason anybody could see.
 */
describe('ui scale', () => {
  const REFERENCE_WIDTH = 1120;
  const REFERENCE_HEIGHT = 560;
  const MIN_UI_SCALE = 0.62;
  const uiScale = (w: number, h: number): number =>
    Math.max(MIN_UI_SCALE, Math.min(1, w / REFERENCE_WIDTH, h / REFERENCE_HEIGHT));

  it('is exactly 1 on every desktop window', () => {
    for (const [w, h] of [
      [1920, 1080],
      [1280, 720],
      [1512, 982],
      [1120, 560],
    ]) {
      expect(uiScale(w!, h!), `${w}x${h}`).toBe(1);
    }
  });

  it('gives a landscape phone room the layout needs', () => {
    // An iPhone 15 Pro on its side. The menu's detail column wants about 1120
    // logical pixels across; this is what buys them.
    const scale = uiScale(852, 393);
    expect(852 / scale).toBeGreaterThanOrEqual(REFERENCE_WIDTH);
    expect(scale).toBeLessThan(1);
  });

  it('stops before the type stops being readable', () => {
    expect(uiScale(320, 180)).toBe(MIN_UI_SCALE);
  });
});
