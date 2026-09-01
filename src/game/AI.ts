import { Vector3 } from 'three';
import type { Craft } from './Craft';
import type { InputSnapshot } from './InputSnapshot';
import { resetInputSnapshot } from './InputSnapshot';
import type { Track } from '@/track/Track';
import type { RacingLine } from '@/track/RacingLine';
import type { Rng } from '@/core/Rng';
import { clamp, clamp01, lerp, wrapDelta } from '@/core/math';

export interface DriverSkill {
  /** Fraction of the ideal corner speed this driver dares to carry, 0..1. */
  pace: number;
  /** Steering lag in seconds. Higher is sloppier and more human. */
  lag: number;
  /** Amplitude of the slow lateral drift off the ideal line, in metres. */
  wander: number;
  /** Willingness to fight for position rather than yield, 0..1. */
  aggression: number;
}

/** Skill for grid slot `index` at a given speed class, best driver on pole. */
export function skillForGridSlot(index: number, fieldSize: number, classSkill: number): DriverSkill {
  const t = fieldSize > 1 ? index / (fieldSize - 1) : 0;
  return {
    pace: classSkill * lerp(1.0, 0.9, t),
    lag: lerp(0.05, 0.16, t),
    wander: lerp(0.5, 2.2, t),
    aggression: lerp(0.85, 0.35, t),
  };
}

/** How far ahead the driver aims, as a multiple of current speed, in seconds. */
const LOOKAHEAD_TIME = 0.55;
const LOOKAHEAD_MIN = 22;
const LOOKAHEAD_MAX = 85;
/** Steering gain applied to the heading error, per radian. */
const STEER_GAIN = 1.9;
/** Heading error past which the driver starts using an airbrake to rotate. */
const AIRBRAKE_THRESHOLD = 0.22;
/** Distance ahead within which an opponent is worth avoiding, in metres. */
const AVOID_RANGE = 70;
/** Lateral clearance the driver tries to keep from an opponent, in metres. */
const AVOID_CLEARANCE = 7;

const _target = new Vector3();
const _delta = new Vector3();
const _right = new Vector3();

/**
 * Drives one craft round the circuit.
 *
 * Pure pursuit on the racing line, with the speed target coming from the
 * precomputed profile rather than from reacting to the corner as it arrives —
 * an AI that brakes only when it sees the corner is an AI that misses it.
 *
 * The driver writes an `InputSnapshot`, exactly like the keyboard does, so it
 * can hand control to a human (or a network peer) without the simulation
 * noticing. That is also what makes the autopilot weapon a two-line feature.
 */
export class Driver {
  readonly craft: Craft;
  readonly skill: DriverSkill;
  private readonly track: Track;
  private readonly line: RacingLine;
  private readonly rng: Rng;

  /** Smoothed steering, so the craft does not twitch at the sim rate. */
  private steer = 0;
  /** Phase of this driver's wander, so the field does not drift in unison. */
  private wanderPhase: number;
  private wanderRate: number;

  constructor(craft: Craft, track: Track, line: RacingLine, rng: Rng, skill: DriverSkill) {
    this.craft = craft;
    this.track = track;
    this.line = line;
    this.rng = rng;
    this.skill = skill;
    this.wanderPhase = rng.range(0, Math.PI * 2);
    this.wanderRate = rng.range(0.15, 0.35);
  }

  /**
   * Fills `input` with this tick's intent. `field` is every craft in the race,
   * including this one, used for avoidance.
   */
  update(input: InputSnapshot, dt: number, field: readonly Craft[], raceTime: number): void {
    resetInputSnapshot(input);
    const craft = this.craft;
    const st = craft.state;
    if (st.eliminated) return;

    const speed = Math.max(0, st.velocity.dot(st.forward));
    const lookahead = clamp(speed * LOOKAHEAD_TIME, LOOKAHEAD_MIN, LOOKAHEAD_MAX);
    const aimS = st.s + lookahead;

    this.wanderPhase += this.wanderRate * dt;
    const wander = Math.sin(this.wanderPhase) * this.skill.wander;
    const avoid = this.avoidance(field);

    // Aim at the racing line, shifted by wander and by whatever it takes to
    // miss the car in front.
    this.line.positionAt(aimS, _target);
    const frame = this.track.frameAt(aimS);
    _target.addScaledVector(frame.right, wander + avoid);

    _delta.subVectors(_target, st.position);
    _right.crossVectors(st.forward, st.up).normalize();
    const headingError = Math.atan2(_delta.dot(_right), _delta.dot(st.forward));

    const targetSteer = clamp(headingError * STEER_GAIN, -1, 1);
    const responsiveness = 1 - Math.exp(-dt / Math.max(0.01, this.skill.lag));
    this.steer += (targetSteer - this.steer) * responsiveness;
    input.steer = this.steer;

    // Airbrake on the inside of the turn once steering alone is not rotating
    // the craft fast enough. This is what a human does, and it is the only way
    // to make the tight corners at speed.
    const over = Math.abs(headingError) - AIRBRAKE_THRESHOLD;
    if (over > 0) {
      const amount = clamp01(over * 2.2);
      if (headingError > 0) input.brakeRight = amount;
      else input.brakeLeft = amount;
    }

    const target = this.targetSpeed();
    if (speed < target) {
      input.thrust = 1;
    } else if (speed > target * 1.04) {
      // Straight-line braking: both airbrakes, on top of any cornering brake.
      const excess = clamp01((speed - target) / 25);
      input.brakeLeft = Math.max(input.brakeLeft, excess);
      input.brakeRight = Math.max(input.brakeRight, excess);
    } else {
      input.thrust = 0.35;
    }

    // The countdown: sit on the brakes, then bring the throttle up shortly
    // before the lights so the field earns its own getaway bonus. A sharper
    // driver times it later and gets more of it.
    if (raceTime < 0) {
      const opensAt = -lerp(0.62, 0.12, this.skill.pace);
      input.thrust = raceTime >= opensAt ? 1 : 0;
      input.brakeLeft = 1;
      input.brakeRight = 1;
      input.steer = 0;
    }
  }

  /** Speed this driver wants to be doing right now, in m/s. */
  private targetSpeed(): number {
    const craft = this.craft;
    const st = craft.state;
    // Look far enough ahead to be slowing before the corner arrives.
    let limit = Infinity;
    for (let ahead = 0; ahead <= 140; ahead += 10) {
      const s = st.s + ahead;
      const cornerSpeed = this.line.speedAt(s);
      // What must we be doing now to be at `cornerSpeed` by then?
      const feasible = Math.sqrt(cornerSpeed * cornerSpeed + 2 * 55 * ahead);
      limit = Math.min(limit, feasible);
    }
    const boostMax = st.boost > 0 ? craft.handling.boostSpeed : 1;
    return Math.min(craft.handling.topSpeed * boostMax, limit * this.skill.pace);
  }

  /** Lateral shift, in metres, needed to miss the craft ahead. */
  private avoidance(field: readonly Craft[]): number {
    const st = this.craft.state;
    let shift = 0;
    for (const other of field) {
      if (other === this.craft || other.state.eliminated) continue;
      const gap = wrapDelta(st.s, other.state.s, this.track.length);
      if (gap <= 0 || gap > AVOID_RANGE) continue;
      const lateralGap = other.state.lateral - st.lateral;
      if (Math.abs(lateralGap) > AVOID_CLEARANCE) continue;
      // Closer in front means a stronger shift; pick the side with more room.
      const urgency = 1 - gap / AVOID_RANGE;
      const side = lateralGap === 0 ? (this.rng.next() < 0.5 ? -1 : 1) : -Math.sign(lateralGap);
      shift += side * urgency * AVOID_CLEARANCE * lerp(0.6, 1.0, this.skill.aggression);
    }
    const half = this.track.spline.widthAtS(st.s) * 0.5 - 4;
    return clamp(shift, -half - st.lateral, half - st.lateral);
  }
}
