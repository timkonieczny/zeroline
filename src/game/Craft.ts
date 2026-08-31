import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Team } from '@/data/teams';
import { buildHandling, type HandlingProfile, type SpeedClass } from './Handling';
import { createInputSnapshot, type InputSnapshot } from './InputSnapshot';
import type { HeldWeapon } from './weapons/Weapons';

/** Half-extents of the collision box, in metres. */
export const CRAFT_HALF_WIDTH = 2.4;
export const CRAFT_HALF_LENGTH = 4.0;

export type CraftControl = 'player' | 'ai' | 'remote';

/**
 * Everything that must be identical across two runs of the same race for the
 * result to be identical. Kept flat and copyable so it can be snapshotted for
 * ghosts, rewind and, later, network reconciliation.
 */
export interface CraftSimState {
  position: Vector3;
  velocity: Vector3;
  /** Unit heading, always perpendicular to `up`. */
  forward: Vector3;
  /** Unit hull normal, damped toward the road normal. */
  up: Vector3;
  /** Yaw rate about `up`, rad/s, positive turning right. */
  yawRate: number;
  /** Cosmetic roll about `forward`, rad. Also drives the barrel roll. */
  roll: number;

  /** Arc length along the centreline, wrapped into [0, track length). */
  s: number;
  /** Signed offset from the centreline, metres. */
  lateral: number;
  /** Height above the road surface, metres. */
  height: number;
  /** True while the hover field has purchase on the road. */
  grounded: boolean;

  shield: number;
  /** Seconds of boost remaining. */
  boost: number;
  /** Seconds of weapon-shield remaining. */
  invulnerable: number;
  /** Seconds of autopilot remaining. */
  autopilot: number;
  /** Counts down while a barrel roll is in progress. */
  rollTimer: number;
  /** Direction of the barrel roll in progress, 0 when not rolling. */
  rollDir: -1 | 0 | 1;
  /** Seconds until the craft can be hit again after a respawn. */
  respawnGrace: number;
  /** True once shield energy has run out. */
  eliminated: boolean;
}

export function createCraftSimState(): CraftSimState {
  return {
    position: new Vector3(),
    velocity: new Vector3(),
    forward: new Vector3(0, 0, 1),
    up: new Vector3(0, 1, 0),
    yawRate: 0,
    roll: 0,
    s: 0,
    lateral: 0,
    height: 0,
    grounded: true,
    shield: 100,
    boost: 0,
    invulnerable: 0,
    autopilot: 0,
    rollTimer: 0,
    rollDir: 0,
    respawnGrace: 0,
    eliminated: false,
  };
}

export function copyCraftSimState(from: CraftSimState, to: CraftSimState): void {
  to.position.copy(from.position);
  to.velocity.copy(from.velocity);
  to.forward.copy(from.forward);
  to.up.copy(from.up);
  to.yawRate = from.yawRate;
  to.roll = from.roll;
  to.s = from.s;
  to.lateral = from.lateral;
  to.height = from.height;
  to.grounded = from.grounded;
  to.shield = from.shield;
  to.boost = from.boost;
  to.invulnerable = from.invulnerable;
  to.autopilot = from.autopilot;
  to.rollTimer = from.rollTimer;
  to.rollDir = from.rollDir;
  to.respawnGrace = from.respawnGrace;
  to.eliminated = from.eliminated;
}

/** Per-tick readouts the renderer, HUD and audio consume. None of it feeds back. */
export interface CraftTelemetry {
  /** Forward speed in m/s. */
  speed: number;
  /** Speed as a fraction of top speed, including boost. */
  speedFraction: number;
  /** Lateral slip in m/s, signed. Drives skid effects and audio. */
  slip: number;
  /** Impact magnitude registered this tick, 0 when clean. */
  impact: number;
  /** True on the tick the craft crossed onto a speed pad. */
  hitBoostPad: boolean;
  /** True while scraping a wall. */
  scraping: boolean;
}

/**
 * One racing craft: identity, tuning, simulation state and the interpolation
 * buffer the renderer reads.
 *
 * The sim runs at a fixed rate while the renderer runs at display rate, so each
 * craft keeps its previous state and the renderer blends between the two. That
 * is what stops a 120 Hz sim from looking like 120 Hz stutter on a 144 Hz panel.
 */
export class Craft {
  readonly id: number;
  readonly team: Team;
  readonly control: CraftControl;
  readonly handling: HandlingProfile;
  /** Display name, e.g. "AUR 07". */
  readonly name: string;

  readonly state: CraftSimState = createCraftSimState();
  /** State at the end of the previous sim tick, for render interpolation. */
  readonly previous: CraftSimState = createCraftSimState();
  readonly input: InputSnapshot = createInputSnapshot();
  readonly telemetry: CraftTelemetry = {
    speed: 0,
    speedFraction: 0,
    slip: 0,
    impact: 0,
    hitBoostPad: false,
    scraping: false,
  };

  /** Completed laps. Starts at 0 and increments crossing the line. */
  lap = 0;
  /** Monotonic progress in metres, used to sort the field. */
  distance = 0;
  /** Current race position, 1-based. Assigned by `Race`. */
  position = 1;
  /** Race time in seconds when the craft took the flag, or null. */
  finishTime: number | null = null;
  /** Best lap time in seconds, or null. */
  bestLap: number | null = null;
  /** Race time in seconds at the last line crossing. */
  lastLapAt = 0;
  /** The weapon currently held, or null. */
  weapon: HeldWeapon | null = null;
  /** Seconds until this craft can collect another weapon. */
  pickupCooldown = 0;

  constructor(id: number, team: Team, speedClass: SpeedClass, control: CraftControl) {
    this.id = id;
    this.team = team;
    this.control = control;
    this.handling = buildHandling(team, speedClass);
    this.state.shield = this.handling.shieldMax;
    this.previous.shield = this.handling.shieldMax;
    this.name = `${team.tag} ${String(id + 1).padStart(2, '0')}`;
  }

  /** Current forward speed in m/s. */
  get speed(): number {
    return this.state.velocity.dot(this.state.forward);
  }

  get shieldFraction(): number {
    return this.state.shield / this.handling.shieldMax;
  }

  get boosting(): boolean {
    return this.state.boost > 0;
  }

  /** Snapshot the current state so the renderer can interpolate from it. */
  beginTick(): void {
    copyCraftSimState(this.state, this.previous);
    this.telemetry.impact = 0;
    this.telemetry.hitBoostPad = false;
    this.telemetry.scraping = false;
  }

  /**
   * Position and orientation for rendering, blended `alpha` of the way from the
   * previous tick to the current one.
   */
  sampleRender(alpha: number, outPosition: Vector3, outQuaternion: Quaternion): void {
    outPosition.lerpVectors(this.previous.position, this.state.position, alpha);

    _fwd.copy(this.previous.forward).lerp(this.state.forward, alpha).normalize();
    _up.copy(this.previous.up).lerp(this.state.up, alpha).normalize();
    _up.addScaledVector(_fwd, -_up.dot(_fwd)).normalize();
    _right.crossVectors(_fwd, _up).normalize();

    const roll = this.previous.roll + (this.state.roll - this.previous.roll) * alpha;
    if (roll !== 0) {
      _up.applyAxisAngle(_fwd, roll);
      _right.crossVectors(_fwd, _up).normalize();
    }

    // Three.js meshes look down -Z, so the basis columns are (right, up, -forward).
    _back.copy(_fwd).negate();
    _basis.makeBasis(_right, _up, _back);
    outQuaternion.setFromRotationMatrix(_basis);
  }

  applyDamage(amount: number): void {
    if (this.state.invulnerable > 0 || this.state.respawnGrace > 0) return;
    this.state.shield = Math.max(0, this.state.shield - amount * this.handling.damageTaken);
    if (this.state.shield <= 0) this.state.eliminated = true;
  }

  addShield(amount: number): void {
    this.state.shield = Math.min(this.handling.shieldMax, this.state.shield + amount);
  }
}

const _fwd = new Vector3();
const _up = new Vector3();
const _right = new Vector3();
const _back = new Vector3();
const _basis = new Matrix4();
