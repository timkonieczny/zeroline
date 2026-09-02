/**
 * One tick of intent for one craft.
 *
 * Everything that can drive a craft — the local player, the AI, a replay, and
 * later a network peer — produces one of these. The simulation reads nothing
 * else, which is what keeps it deterministic and re-playable.
 *
 * Continuous axes are already deadzoned and clamped by the input layer. The
 * three edge fields are set for exactly one tick by whatever produced them.
 */
export interface InputSnapshot {
  /** Forward thrust, 0..1. */
  thrust: number;
  /** Steering, -1 (full left) to 1 (full right). */
  steer: number;
  /** Left airbrake, 0..1. */
  brakeLeft: number;
  /** Right airbrake, 0..1. */
  brakeRight: number;
  /** Nose pitch while airborne, -1 (down) to 1 (up). */
  pitch: number;
  /** Edge: fire the held weapon this tick. */
  fire: boolean;
  /** Edge: convert the held weapon into shield energy this tick. */
  absorb: boolean;
  /** Edge: -1 shifts left, 1 shifts right, 0 for nothing. */
  sideshift: -1 | 0 | 1;
  /** Edge: -1 rolls left, 1 rolls right, 0 for nothing. */
  barrelRoll: -1 | 0 | 1;
  /** Held: swing the chase camera around to look behind. */
  lookBack: boolean;
}

export function createInputSnapshot(): InputSnapshot {
  return {
    thrust: 0,
    steer: 0,
    brakeLeft: 0,
    brakeRight: 0,
    pitch: 0,
    fire: false,
    absorb: false,
    sideshift: 0,
    barrelRoll: 0,
    lookBack: false,
  };
}

export function resetInputSnapshot(input: InputSnapshot): void {
  input.thrust = 0;
  input.steer = 0;
  input.brakeLeft = 0;
  input.brakeRight = 0;
  input.pitch = 0;
  input.fire = false;
  input.absorb = false;
  input.sideshift = 0;
  input.barrelRoll = 0;
  input.lookBack = false;
}

export function copyInputSnapshot(from: InputSnapshot, to: InputSnapshot): void {
  to.thrust = from.thrust;
  to.steer = from.steer;
  to.brakeLeft = from.brakeLeft;
  to.brakeRight = from.brakeRight;
  to.pitch = from.pitch;
  to.fire = from.fire;
  to.absorb = from.absorb;
  to.sideshift = from.sideshift;
  to.barrelRoll = from.barrelRoll;
  to.lookBack = from.lookBack;
}

/**
 * Clears the fields that mean "this tick and no other", once a tick has had them.
 *
 * The interface above promises the three edges are set for exactly one tick.
 * They were set for exactly one *frame*, which is not the same thing: the loop
 * runs up to six ticks between two renders, and every one of them saw the same
 * `fire`. A three-round weapon emptied itself in a single frame at thirty
 * frames a second and behaved perfectly at a hundred and twenty, which is the
 * shape of a bug nobody finds on a desktop.
 *
 * It is also a determinism fault, and that is the stronger reason: how far a
 * sideshift threw you depended on the frame rate of the machine watching.
 */
export function consumeInputEdges(input: InputSnapshot): void {
  input.fire = false;
  input.absorb = false;
  input.sideshift = 0;
  input.barrelRoll = 0;
}
