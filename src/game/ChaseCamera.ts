import { Quaternion, Vector3, type PerspectiveCamera } from 'three';
import type { Craft } from './Craft';
import { clamp, clamp01, lerp } from '@/core/math';

/** Where the camera sits relative to the craft, in metres. */
const BASE_DISTANCE = 13.5;
const BASE_HEIGHT = 4.2;
/** Extra distance and height at full speed, in metres. */
const SPEED_DISTANCE = 4.5;
const SPEED_HEIGHT = 1.1;
/** Metres ahead of the craft the camera looks. */
const LOOK_AHEAD = 16;
/** Field of view at a standstill and at full boost, in degrees. */
const FOV_REST = 66;
const FOV_FLAT_OUT = 86;
/** Half-life of the positional follow, in seconds. Lower is tighter. */
const FOLLOW_HALF_LIFE = 0.055;
/** Half-life of the roll follow. Slower than position, so banking reads. */
const ROLL_HALF_LIFE = 0.13;
/**
 * Half-life of the boom's own heading, in seconds.
 *
 * Much slower than the position it drives. The camera hangs behind where the
 * craft *was* pointed while the craft has already turned, so a corner shows its
 * flank before the camera comes round — which is the whole difference between a
 * camera bolted to the tail and one on a boom.
 */
const HEADING_HALF_LIFE = 0.2;
/**
 * The furthest the boom may trail the craft's heading, in radians.
 *
 * Without a limit a long corner winds the lag up until the camera is looking at
 * the side of the craft and the road has left the frame. Twenty degrees is
 * enough to see down the flank and not enough to lose the corner.
 */
const HEADING_LAG_LIMIT = 0.35;
/** Peak camera displacement from a full-severity impact, in metres. */
const SHAKE_AMPLITUDE = 0.85;
/** How quickly impact shake decays, per second. */
const SHAKE_DECAY = 5.5;

const _craftPosition = new Vector3();
const _craftRotation = new Quaternion();
const _forward = new Vector3();
const _up = new Vector3();
const _right = new Vector3();
const _desired = new Vector3();
const _look = new Vector3();
const _shake = new Vector3();
const _axis = new Vector3();

/**
 * The chase camera.
 *
 * It follows position tightly and orientation loosely. That split is the whole
 * trick: a camera rigidly bolted to the craft makes the world rotate around a
 * static ship and reads as nothing happening, while a camera that lags in
 * rotation lets the ship visibly yaw and bank inside the frame.
 *
 * The lag is in the boom, not in the aim. Where the camera *sits* is behind a
 * heading that eases toward the craft's own and is capped at twenty degrees
 * behind it; where it *looks* is straight down the craft's real nose. Turn in,
 * and for as long as the craft is rotating the camera is off to the outside of
 * it and you are looking down the flank; hold a steady line and the two come
 * back together.
 *
 * Field of view opens with speed and snaps wider under boost, which does more
 * for the sense of velocity than any post effect.
 */
export class ChaseCamera {
  /** 0 when following normally, 1 when fully reversed. */
  private lookBack = 0;
  /** Current impact shake energy, 0..1. */
  private shake = 0;
  /** Smoothed roll, so the horizon eases rather than snapping. */
  private roll = 0;
  private initialised = false;

  private readonly position = new Vector3();
  private readonly up = new Vector3(0, 1, 0);
  /** Where the boom is pointed, which trails where the craft is pointed. */
  private readonly heading = new Vector3(0, 0, -1);

  /** Places the camera behind the craft with no easing, for a race start or a cut. */
  reset(): void {
    this.initialised = false;
    this.shake = 0;
    this.lookBack = 0;
  }

  /** Adds impact shake. `severity` is 0..1. */
  impact(severity: number): void {
    this.shake = clamp01(Math.max(this.shake, severity));
  }

  update(camera: PerspectiveCamera, craft: Craft, alpha: number, dt: number, lookingBack: boolean): void {
    craft.sampleRender(alpha, _craftPosition, _craftRotation);

    _forward.set(0, 0, -1).applyQuaternion(_craftRotation);
    _up.set(0, 1, 0).applyQuaternion(_craftRotation);
    _right.crossVectors(_forward, _up).normalize();

    const speedFraction = clamp01(craft.telemetry.speed / craft.handling.topSpeed);
    const boost = craft.state.boost > 0 ? 1 : 0;

    this.lookBack += ((lookingBack ? 1 : 0) - this.lookBack) * (1 - Math.exp(-dt * 14));
    const behind = lerp(1, -1, this.lookBack);

    const distance = BASE_DISTANCE + SPEED_DISTANCE * speedFraction;
    const height = BASE_HEIGHT + SPEED_HEIGHT * speedFraction;

    if (this.initialised) {
      this.heading.lerp(_forward, 1 - Math.pow(2, -dt / HEADING_HALF_LIFE)).normalize();

      // Cap the trail. `angleTo` is the whole answer; the axis to swing back
      // about is the one the two headings already define.
      const trailing = this.heading.angleTo(_forward);
      if (trailing > HEADING_LAG_LIMIT) {
        _axis.crossVectors(this.heading, _forward);
        if (_axis.lengthSq() > 1e-8) {
          this.heading.applyAxisAngle(_axis.normalize(), trailing - HEADING_LAG_LIMIT).normalize();
        }
      }
    } else {
      this.heading.copy(_forward);
    }

    _desired
      .copy(_craftPosition)
      .addScaledVector(this.heading, -distance * behind)
      .addScaledVector(_up, height);

    if (!this.initialised) {
      this.position.copy(_desired);
      this.up.copy(_up);
      this.initialised = true;
    } else {
      // Frame-rate independent approach: the same feel at 60 and 240 Hz.
      const k = 1 - Math.pow(2, -dt / FOLLOW_HALF_LIFE);
      this.position.lerp(_desired, k);
      this.up.lerp(_up, 1 - Math.pow(2, -dt / ROLL_HALF_LIFE)).normalize();
    }

    // Lean the camera into the turn, on top of the craft's own roll.
    const targetRoll = clamp(-craft.state.yawRate * 0.09, -0.16, 0.16);
    this.roll += (targetRoll - this.roll) * (1 - Math.exp(-dt * 6));

    this.shake = Math.max(0, this.shake - SHAKE_DECAY * dt * this.shake - dt * 0.2);
    if (this.shake > 0.001) {
      // Deterministic wobble: two incommensurate frequencies so it never loops.
      const t = performance.now() * 0.001;
      _shake
        .copy(_right)
        .multiplyScalar(Math.sin(t * 47) * this.shake * SHAKE_AMPLITUDE)
        .addScaledVector(_up, Math.sin(t * 31.7) * this.shake * SHAKE_AMPLITUDE * 0.7);
    } else {
      _shake.set(0, 0, 0);
    }

    camera.position.copy(this.position).add(_shake);

    _look.copy(_craftPosition).addScaledVector(_forward, LOOK_AHEAD * behind).addScaledVector(_up, 1.2);
    camera.up.copy(this.up).applyAxisAngle(_forward, this.roll);
    camera.lookAt(_look);

    const targetFov = lerp(FOV_REST, FOV_FLAT_OUT, clamp01(speedFraction * 0.85 + boost * 0.3));
    if (Math.abs(camera.fov - targetFov) > 0.01) {
      camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-dt * 5));
      camera.updateProjectionMatrix();
    }
  }
}
