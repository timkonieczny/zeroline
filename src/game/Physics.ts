import { Vector3 } from 'three';
import { CRAFT_HALF_WIDTH, type Craft, copyCraftSimState } from './Craft';
import type { InputSnapshot } from './InputSnapshot';
import type { Track } from '@/track/Track';
import { TAU, clamp, clamp01, lerp } from '@/core/math';

/** Downforce along the road normal while the hover field has purchase, m/s^2. */
const GRAVITY_TRACK = 30;
/** True gravity once the craft leaves the road, m/s^2. Heavier than Earth on purpose: air time should be short. */
const GRAVITY_AIR = 26;
/** Height above the road past which the hover field lets go, in metres. */
const HOVER_REACH = 7;
/** Height below the road at which the craft is considered lost. */
const FALL_LIMIT = -30;
/** Cap on hover spring acceleration so a hard landing cannot launch the craft. */
const HOVER_CLAMP = 520;
/** Lateral closing speed treated as a maximum-severity impact, m/s. */
const IMPACT_REFERENCE = 45;
/** Shield cost of a barrel roll. */
const BARREL_ROLL_COST = 9;
/** Seconds a barrel roll takes. */
const BARREL_ROLL_TIME = 0.55;
/** Seconds of boost a completed barrel roll pays out. */
const BARREL_ROLL_BOOST = 1.1;

const WORLD_UP = new Vector3(0, 1, 0);

const _accel = new Vector3();
const _right = new Vector3();
const _targetUp = new Vector3();

/**
 * Advances one craft by one fixed sim tick.
 *
 * The model is a magnetically coupled hover craft, not a rigid body. The road's
 * own frame supplies "down", so banking, corkscrews and full loops need no
 * special cases: while the hover field has purchase, gravity points into the
 * road rather than at the world floor. Lose contact and true gravity takes over.
 *
 * Deterministic: same craft state plus same input plus same dt gives the same
 * result on every machine. No wall-clock reads, no unseeded randomness.
 */
export function stepCraft(craft: Craft, input: InputSnapshot, track: Track, dt: number): void {
  const st = craft.state;
  const h = craft.handling;
  const tele = craft.telemetry;

  st.boost = Math.max(0, st.boost - dt);
  st.invulnerable = Math.max(0, st.invulnerable - dt);
  st.autopilot = Math.max(0, st.autopilot - dt);
  st.respawnGrace = Math.max(0, st.respawnGrace - dt);

  // --- Where are we on the road? ------------------------------------------
  let hit = track.collision.query(st.position, st.s);
  let frame = hit.frame;
  st.s = hit.s;
  st.lateral = hit.lateral;
  st.height = hit.height;

  const inLane = hit.edgeDistance > -8;
  const grounded = inLane && st.height < h.rideHeight + HOVER_REACH && st.height > FALL_LIMIT;
  st.grounded = grounded;

  if (st.height < FALL_LIMIT) {
    respawn(craft, track);
    return;
  }

  // --- Attitude ------------------------------------------------------------
  _targetUp.copy(grounded ? frame.up : WORLD_UP);
  const alignK = 1 - Math.exp(-h.alignResponse * dt);
  st.up.lerp(_targetUp, alignK).normalize();
  // Heading must stay in the hull's plane or the basis degenerates.
  st.forward.addScaledVector(st.up, -st.forward.dot(st.up)).normalize();
  _right.crossVectors(st.forward, st.up).normalize();

  // --- Steering ------------------------------------------------------------
  const forwardSpeed = st.velocity.dot(st.forward);
  const speedT = clamp01(Math.abs(forwardSpeed) / h.topSpeed);
  const turnRate = lerp(h.turnRateLow, h.turnRateHigh, speedT);
  const brakeBias = input.brakeRight - input.brakeLeft;
  const targetYaw = input.steer * turnRate + brakeBias * h.airbrakeYaw;
  st.yawRate += (targetYaw - st.yawRate) * (1 - Math.exp(-h.turnResponse * dt));
  // Positive yawRate turns right; a right turn is clockwise seen from above,
  // which is a negative rotation about `up` in a right-handed basis.
  st.forward.applyAxisAngle(st.up, -st.yawRate * dt).normalize();
  _right.crossVectors(st.forward, st.up).normalize();

  // --- Forces --------------------------------------------------------------
  _accel.set(0, 0, 0);

  const thrust = clamp01(input.thrust);
  _accel.addScaledVector(st.forward, h.thrust * thrust);
  if (st.boost > 0) _accel.addScaledVector(st.forward, h.boostThrust);

  // Quadratic drag written as dragK*|v|*v so it stays a vector operation.
  const speedAbs = st.velocity.length();
  const dragScale = h.dragK * speedAbs + h.dragLinear;
  _accel.addScaledVector(st.velocity, -dragScale);

  const brakeAmount = (input.brakeLeft + input.brakeRight) * 0.5;
  if (brakeAmount > 0) {
    _accel.addScaledVector(st.velocity, -h.brakeDrag * brakeAmount);
    // An airbrake also drags the craft toward the side being braked, which is
    // what lets a held brake tighten a line instead of only slowing it.
    _accel.addScaledVector(_right, brakeBias * h.airbrakeSlide);
  }

  if (grounded) {
    _accel.addScaledVector(frame.up, -GRAVITY_TRACK);
    const heightError = st.height - h.rideHeight;
    const verticalSpeed = st.velocity.dot(frame.up);
    const spring = clamp(
      -h.hoverStiffness * heightError - h.hoverDamping * verticalSpeed,
      -HOVER_CLAMP,
      HOVER_CLAMP,
    );
    _accel.addScaledVector(frame.up, spring);
  } else {
    _accel.addScaledVector(WORLD_UP, -GRAVITY_AIR);
    // Pitch authority in the air, so a jump can be landed nose-first.
    if (input.pitch !== 0) {
      st.forward.applyAxisAngle(_right, input.pitch * 1.4 * dt).normalize();
      st.up.crossVectors(_right, st.forward).normalize();
    }
  }

  st.velocity.addScaledVector(_accel, dt);

  // --- Grip ----------------------------------------------------------------
  if (grounded) {
    const lateralSpeed = st.velocity.dot(_right);
    const slide = clamp01((Math.abs(lateralSpeed) - h.slideThreshold) / h.slideThreshold);
    // Past the slide threshold grip falls away, so overcooking a corner keeps
    // the craft sliding instead of snapping it straight.
    const gripRate = h.grip * lerp(1, 0.25, slide);
    st.velocity.addScaledVector(_right, -lateralSpeed * (1 - Math.exp(-gripRate * dt)));
    tele.slip = lateralSpeed;
  } else {
    tele.slip = 0;
  }

  // --- Sideshift and barrel roll -------------------------------------------
  if (input.sideshift !== 0 && grounded) {
    st.velocity.addScaledVector(_right, input.sideshift * h.sideshiftImpulse);
  }

  if (st.rollTimer > 0) {
    st.rollTimer -= dt;
    st.roll += st.rollDir * (TAU / BARREL_ROLL_TIME) * dt;
    if (st.rollTimer <= 0) {
      st.roll = 0;
      st.rollDir = 0;
      st.boost = Math.max(st.boost, BARREL_ROLL_BOOST);
    }
  } else if (input.barrelRoll !== 0 && !grounded && st.shield > BARREL_ROLL_COST) {
    st.rollTimer = BARREL_ROLL_TIME;
    st.rollDir = input.barrelRoll;
    st.shield -= BARREL_ROLL_COST;
  } else {
    // Cosmetic bank into the turn, plus a lean with lateral slip.
    const targetRoll = clamp(st.yawRate * 0.22 + tele.slip * 0.006, -0.45, 0.45);
    st.roll += (targetRoll - st.roll) * (1 - Math.exp(-8 * dt));
  }

  // --- Speed limit ---------------------------------------------------------
  const maxSpeed = h.topSpeed * (st.boost > 0 ? h.boostSpeed : 1);
  const newForwardSpeed = st.velocity.dot(st.forward);
  if (newForwardSpeed > maxSpeed) {
    st.velocity.addScaledVector(st.forward, maxSpeed - newForwardSpeed);
  }

  // --- Integrate and resolve walls -----------------------------------------
  st.position.addScaledVector(st.velocity, dt);

  hit = track.collision.query(st.position, st.s);
  frame = hit.frame;
  const limit = hit.width * 0.5 - CRAFT_HALF_WIDTH;
  if (Math.abs(hit.lateral) > limit) {
    const side = Math.sign(hit.lateral);
    const penetration = Math.abs(hit.lateral) - limit;
    st.position.addScaledVector(frame.right, -side * penetration);

    const closing = st.velocity.dot(frame.right) * side;
    if (closing > 0) {
      // Kill the component into the wall and add a small push out, so a craft
      // pinned against the barrier peels off rather than grinding along it.
      st.velocity.addScaledVector(frame.right, -side * closing * 1.15);
      const severity = clamp01(closing / IMPACT_REFERENCE);
      const retain = lerp(h.scrapeRetain, h.wallRetain, severity);
      st.velocity.multiplyScalar(retain);
      st.yawRate *= lerp(1, 0.3, severity);
      tele.impact = severity;
      tele.scraping = severity < 0.25;
      if (severity > 0.05) craft.applyDamage(severity * severity * 26);
    } else {
      tele.scraping = true;
    }
    hit = track.collision.query(st.position, st.s);
  }

  st.s = hit.s;
  st.lateral = hit.lateral;
  st.height = hit.height;

  // Never let the craft sink through the road.
  if (st.height < 0 && hit.edgeDistance > -CRAFT_HALF_WIDTH) {
    st.position.addScaledVector(hit.frame.up, -st.height);
    const into = st.velocity.dot(hit.frame.up);
    if (into < 0) st.velocity.addScaledVector(hit.frame.up, -into);
    st.height = 0;
  }

  tele.speed = st.velocity.dot(st.forward);
  tele.speedFraction = clamp01(tele.speed / h.topSpeed);
}

/** Places a craft back on the road at its current arc length, stationary but pointed forward. */
export function respawn(craft: Craft, track: Track): void {
  const st = craft.state;
  const frame = track.frameAt(st.s);
  const halfWidth = frame.width * 0.5;

  st.position
    .copy(frame.position)
    .addScaledVector(frame.right, clamp(st.lateral, -halfWidth * 0.6, halfWidth * 0.6))
    .addScaledVector(frame.up, craft.handling.rideHeight + 1.5);
  st.forward.copy(frame.tangent);
  st.up.copy(frame.up);
  st.velocity.copy(frame.tangent).multiplyScalar(Math.min(40, craft.handling.topSpeed * 0.3));
  st.yawRate = 0;
  st.roll = 0;
  st.rollTimer = 0;
  st.rollDir = 0;
  st.height = craft.handling.rideHeight + 1.5;
  st.grounded = true;
  st.respawnGrace = 2;
  craft.telemetry.impact = 1;

  // A teleport, so the render must not blend across it: the craft would streak
  // from the crash site to the respawn point for one frame.
  copyCraftSimState(st, craft.previous);
}

/** Places a craft on its starting grid slot, stationary and on the line. */
export function placeOnGrid(craft: Craft, track: Track, slot: number): void {
  const st = craft.state;
  const { s, lateral } = track.gridSlot(slot);
  const frame = track.frameAt(s);

  st.position
    .copy(frame.position)
    .addScaledVector(frame.right, lateral)
    .addScaledVector(frame.up, craft.handling.rideHeight);
  st.forward.copy(frame.tangent);
  st.up.copy(frame.up);
  st.velocity.set(0, 0, 0);
  st.yawRate = 0;
  st.roll = 0;
  st.s = s;
  st.lateral = lateral;
  st.height = craft.handling.rideHeight;
  st.grounded = true;
  st.shield = craft.handling.shieldMax;
  st.boost = 0;
  st.eliminated = false;
  craft.lap = 0;
  craft.distance = 0;
  craft.finishTime = null;
  craft.finishDistance = 0;
  craft.bestLap = null;
  craft.lastLapAt = 0;
  craft.hasStartedLap = false;
  craft.throttleOpenedAt = null;
  craft.startRating = null;

  // Nothing has ticked when a race is built, so `previous` is still at its
  // defaults and the renderer would blend the whole field in from the world
  // origin. One tick used to hide it; the pre-race intro holds the simulation
  // for twelve seconds and does not.
  copyCraftSimState(st, craft.previous);
}
