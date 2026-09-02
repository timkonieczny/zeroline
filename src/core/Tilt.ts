import { clamp01 } from './math';

/**
 * Degrees of roll away from neutral that reach full lock.
 *
 * Wide enough that a hand resting on a bumpy train does not steer, narrow
 * enough to reach full lock without moving your elbows.
 */
export const STEER_RANGE = 28;
/** And degrees of nose tilt for full pitch authority, which only bites airborne. */
export const PITCH_RANGE = 22;
/**
 * Degrees around neutral that read as centred.
 *
 * Small. A phone is a far steadier instrument than a thumbstick, and a wide
 * deadzone on a tilt control reads as the craft ignoring you.
 */
export const TILT_DEADZONE = 2.5;

/** One frame of the device's orientation, as the browser reports it. */
export interface TiltReading {
  /** Rotation about the device's x axis, in degrees. */
  beta: number;
  /** Rotation about the device's y axis, in degrees. */
  gamma: number;
  /** `screen.orientation.angle`: 90 or 270 in landscape. */
  screenAngle: number;
}

/** The pose the phone was calibrated at, in the same units. */
export interface TiltNeutral {
  beta: number;
  gamma: number;
}

export interface TiltControls {
  /** -1 full left to 1 full right. */
  steer: number;
  /** -1 nose down to 1 nose up. */
  pitch: number;
}

export function createTiltControls(): TiltControls {
  return { steer: 0, pitch: 0 };
}

export function createTiltNeutral(): TiltNeutral {
  return { beta: 0, gamma: 0 };
}

/**
 * Turns a device's orientation into steering and pitch.
 *
 * Kept as arithmetic over four numbers, with no `window` in sight, because the
 * test suite runs in node and because this is the one piece of the phone build
 * whose bugs are invisible until somebody is holding a phone. Everything that
 * talks to `DeviceOrientationEvent` lives elsewhere.
 *
 * **Which axis is which.** The browser reports `beta` and `gamma` in the
 * device's own portrait frame, and the phone is being held in landscape — so
 * they arrive swapped relative to what the player is doing. Held like a tray:
 * tipping the left and right edges of the *screen* is rotation about the
 * screen's vertical axis, which in landscape is the device's x axis, which is
 * `beta`. That is steering. Tipping the far edge away and back is rotation
 * about the screen's horizontal axis — the device's y axis, `gamma` — which is
 * the nose.
 *
 * **Why the sign flips.** Landscape is two orientations, not one: 90 and 270
 * are the same pose rotated by half a turn, so both device axes point the
 * opposite way relative to the player and both controls invert. One flip
 * covers both, because a half turn in the screen plane reverses x and y
 * together.
 *
 * The absolute sense — whether tipping the right edge down steers right or
 * left — cannot be established without hardware in hand. It is `SENSE` below,
 * one constant, and the test pins the relationship between the two landscape
 * orientations rather than a physical truth it cannot observe.
 */
export function tiltToControls(reading: TiltReading, neutral: TiltNeutral, out: TiltControls): TiltControls {
  const flip = reading.screenAngle === 270 ? -SENSE : SENSE;

  out.steer = response(degreesDelta(neutral.beta, reading.beta) * flip, STEER_RANGE);
  out.pitch = response(degreesDelta(neutral.gamma, reading.gamma) * flip, PITCH_RANGE);
  return out;
}

/** Which way round the axes run. Flip this one number if the phone steers backwards. */
const SENSE = 1;

/**
 * Deadzoned and curved.
 *
 * Squared, so the middle of the range is gentle and the ends are not: a craft
 * at 500 km/h needs a hand's width of tilt to mean a small correction, and a
 * linear map makes the same movement a lane change.
 */
function response(degrees: number, range: number): number {
  const past = Math.abs(degrees) - TILT_DEADZONE;
  if (past <= 0) return 0;

  const t = clamp01(past / (range - TILT_DEADZONE));
  return Math.sign(degrees) * t * t;
}

/**
 * Shortest signed difference between two angles in degrees.
 *
 * `beta` runs to ±180 and wraps, and a neutral taken just off the wrap would
 * otherwise read as a full lock in the wrong direction the moment the phone
 * crossed it.
 */
function degreesDelta(from: number, to: number): number {
  let delta = (to - from) % 360;
  if (delta > 180) delta -= 360;
  if (delta <= -180) delta += 360;
  return delta;
}
