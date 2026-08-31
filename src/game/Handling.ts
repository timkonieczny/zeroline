import { lerp } from '@/core/math';
import type { Team } from '@/data/teams';

export type SpeedClassId = 'vector' | 'venom' | 'flash' | 'rapier';

export interface SpeedClass {
  id: SpeedClassId;
  name: string;
  /** Short description shown on the class selector. */
  blurb: string;
  /** Multiplies top speed. */
  speed: number;
  /** Multiplies acceleration. */
  accel: number;
  /** Baseline AI competence, 0..1. */
  aiSkill: number;
  /** Multiplies damage taken, so the fast classes are also the brittle ones. */
  damage: number;
}

/** Named after the classes every AG pilot learns in, slowest first. */
export const SPEED_CLASSES: readonly SpeedClass[] = [
  {
    id: 'vector',
    name: 'VECTOR',
    blurb: 'Licence class. Learn the circuit before it learns you.',
    speed: 0.72,
    accel: 0.82,
    aiSkill: 0.68,
    damage: 0.8,
  },
  {
    id: 'venom',
    name: 'VENOM',
    blurb: 'Club racing. Fast enough to hurt, slow enough to think.',
    speed: 0.85,
    accel: 0.9,
    aiSkill: 0.8,
    damage: 0.9,
  },
  {
    id: 'flash',
    name: 'FLASH',
    blurb: 'League standard. The class the records are set in.',
    speed: 1.0,
    accel: 1.0,
    aiSkill: 0.9,
    damage: 1.0,
  },
  {
    id: 'rapier',
    name: 'RAPIER',
    blurb: 'Open class. Nothing is forgiven at this speed.',
    speed: 1.18,
    accel: 1.12,
    aiSkill: 1.0,
    damage: 1.15,
  },
];

export function speedClassById(id: SpeedClassId): SpeedClass {
  const c = SPEED_CLASSES.find((s) => s.id === id);
  if (!c) throw new Error(`Unknown speed class: ${id}`);
  return c;
}

/**
 * Physics constants for one craft, derived from its constructor's ratings and
 * the speed class being raced. Units are metres, seconds, radians, kilograms.
 *
 * Everything the hover model reads lives here, so tuning the game means editing
 * one file rather than hunting magic numbers through the integrator.
 */
export interface HandlingProfile {
  /** Terminal speed under full thrust, in m/s. */
  topSpeed: number;
  /** Forward acceleration at standstill, in m/s^2. */
  thrust: number;
  /** Quadratic drag, solved so full thrust converges on `topSpeed`. */
  dragK: number;
  /** Linear drag applied always, in 1/s. Keeps the craft from coasting forever. */
  dragLinear: number;
  /** Extra drag while an airbrake is held, in 1/s. */
  brakeDrag: number;

  /** Yaw rate at a standstill, rad/s. */
  turnRateLow: number;
  /** Yaw rate at top speed, rad/s. High-speed steering is deliberately heavy. */
  turnRateHigh: number;
  /** How quickly yaw rate reaches its target, in 1/s. */
  turnResponse: number;
  /** Yaw added by a fully held airbrake, rad/s. */
  airbrakeYaw: number;
  /** Sideways force from a held airbrake, m/s^2. */
  airbrakeSlide: number;
  /** Instant lateral velocity change from a sideshift, m/s. */
  sideshiftImpulse: number;

  /** Rate at which sideways velocity is scrubbed off, 1/s. */
  grip: number;
  /** Lateral speed past which grip falls away and the craft slides, m/s. */
  slideThreshold: number;

  mass: number;
  shieldMax: number;
  /** Multiplies all incoming damage. */
  damageTaken: number;
  /** Shield regenerated per second while on a recharge strip. */
  rechargeRate: number;

  /** Resting height above the road, in metres. */
  rideHeight: number;
  /** Hover spring stiffness, 1/s^2. */
  hoverStiffness: number;
  /** Hover damping, 1/s. */
  hoverDamping: number;
  /** Rate at which the hull aligns to the road normal, 1/s. */
  alignResponse: number;

  /** Speed multiplier while boosting. */
  boostSpeed: number;
  /** Extra acceleration while boosting, m/s^2. */
  boostThrust: number;

  /** Fraction of speed kept after a square hit on a wall. */
  wallRetain: number;
  /** Fraction of speed kept after a glancing scrape. */
  scrapeRetain: number;
}

/** Top speed of the reference craft in FLASH class, in m/s (~522 km/h). */
const BASE_TOP_SPEED = 145;

export function buildHandling(team: Team, speedClass: SpeedClass): HandlingProfile {
  const { speed, thrust, handling, shield } = team.stats;

  const topSpeed = BASE_TOP_SPEED * lerp(0.86, 1.16, speed) * speedClass.speed;
  const thrustAccel = lerp(40, 78, thrust) * speedClass.accel;

  return {
    topSpeed,
    thrust: thrustAccel,
    // Solving a = dragK * v^2 at v = topSpeed makes full thrust converge
    // exactly on top speed, so the rating means what the meter says.
    dragK: thrustAccel / (topSpeed * topSpeed),
    dragLinear: 0.18,
    brakeDrag: lerp(0.9, 1.7, handling),

    turnRateLow: lerp(1.7, 2.9, handling),
    turnRateHigh: lerp(0.62, 1.15, handling),
    turnResponse: lerp(6, 12, handling),
    airbrakeYaw: lerp(0.9, 1.7, handling),
    airbrakeSlide: lerp(16, 30, handling),
    sideshiftImpulse: lerp(13, 22, handling),

    grip: lerp(3.2, 6.4, handling),
    slideThreshold: lerp(26, 15, handling),

    mass: lerp(760, 1240, shield),
    shieldMax: lerp(70, 145, shield),
    damageTaken: speedClass.damage / lerp(0.85, 1.35, shield),
    rechargeRate: 26,

    rideHeight: 1.5,
    hoverStiffness: 190,
    hoverDamping: 21,
    alignResponse: lerp(7, 12, handling),

    boostSpeed: 1.34,
    boostThrust: lerp(48, 84, thrust),

    wallRetain: lerp(0.42, 0.66, shield),
    scrapeRetain: lerp(0.9, 0.965, handling),
  };
}
