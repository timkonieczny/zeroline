import { Vector3 } from 'three';
import type { Craft } from './Craft';
import { lerp } from '@/core/math';

/** Samples per second stored. The gap between them is interpolated on playback. */
const SAMPLE_RATE = 30;
/** Floats kept per craft per sample: position, forward, up, roll, speed. */
const STRIDE = 12;

const _forward = new Vector3();
const _up = new Vector3();

/**
 * Records the race as it happens, then plays it back on a loop.
 *
 * Only what the camera and the models need is stored — pose and speed — at 30 Hz
 * rather than the simulation's 120, with playback interpolating between samples.
 * A three-lap race with eight craft comes to about a megabyte, and re-simulating
 * instead was never an option: the replay has to be able to start from the
 * beginning while the finished race state stays exactly as the classification
 * left it.
 *
 * Playback writes straight into the craft's own state, so the chase camera, the
 * models and the engine note all work unchanged — they cannot tell the
 * difference between being driven and being replayed.
 */
export class Replay {
  private readonly craftCount: number;
  private frames: Float32Array;
  private frameCount = 0;
  private capacity: number;
  /** Simulated time already committed to a sample, in seconds. */
  private nextSampleAt = 0;

  constructor(craftCount: number, expectedSeconds = 180) {
    this.craftCount = craftCount;
    this.capacity = Math.max(64, Math.ceil(expectedSeconds * SAMPLE_RATE));
    this.frames = new Float32Array(this.capacity * craftCount * STRIDE);
  }

  /** Length of the recording in seconds. */
  get duration(): number {
    return this.frameCount > 1 ? (this.frameCount - 1) / SAMPLE_RATE : 0;
  }

  get isEmpty(): boolean {
    return this.frameCount < 2;
  }

  reset(): void {
    this.frameCount = 0;
    this.nextSampleAt = 0;
  }

  /**
   * Takes a sample if enough simulated time has passed. Call every tick with
   * the race's own clock; it decides when to store.
   */
  record(craft: readonly Craft[], raceTime: number): void {
    // The clock starts negative during the countdown; the recording starts at
    // the lights, so a replay opens on the start rather than on eight craft
    // sitting still.
    if (raceTime < 0) return;
    if (this.frameCount > 0 && raceTime < this.nextSampleAt) return;

    if (this.frameCount >= this.capacity) this.grow();

    let offset = this.frameCount * this.craftCount * STRIDE;
    for (let i = 0; i < this.craftCount; i++) {
      const c = craft[i];
      if (!c) {
        offset += STRIDE;
        continue;
      }
      const st = c.state;
      this.frames[offset] = st.position.x;
      this.frames[offset + 1] = st.position.y;
      this.frames[offset + 2] = st.position.z;
      this.frames[offset + 3] = st.forward.x;
      this.frames[offset + 4] = st.forward.y;
      this.frames[offset + 5] = st.forward.z;
      this.frames[offset + 6] = st.up.x;
      this.frames[offset + 7] = st.up.y;
      this.frames[offset + 8] = st.up.z;
      this.frames[offset + 9] = st.roll;
      this.frames[offset + 10] = c.telemetry.speed;
      this.frames[offset + 11] = st.boost > 0 ? 1 : 0;
      offset += STRIDE;
    }

    this.frameCount++;
    this.nextSampleAt = raceTime + 1 / SAMPLE_RATE;
  }

  private grow(): void {
    this.capacity *= 2;
    const bigger = new Float32Array(this.capacity * this.craftCount * STRIDE);
    bigger.set(this.frames);
    this.frames = bigger;
  }

  /**
   * Poses every craft as it was at `time` seconds into the recording.
   *
   * Both the current and previous state are written, so the renderer's
   * interpolation has nothing left to blend and the playback runs at exactly the
   * rate asked for rather than lagging a tick behind.
   */
  apply(time: number, craft: readonly Craft[]): void {
    if (this.isEmpty) return;

    const position = Math.max(0, Math.min(time, this.duration)) * SAMPLE_RATE;
    const index = Math.min(this.frameCount - 2, Math.floor(position));
    const blend = position - index;

    const strideAll = this.craftCount * STRIDE;
    const a = index * strideAll;
    const b = (index + 1) * strideAll;

    for (let i = 0; i < this.craftCount; i++) {
      const c = craft[i];
      if (!c) continue;
      const oa = a + i * STRIDE;
      const ob = b + i * STRIDE;
      const st = c.state;

      st.position.set(
        lerp(this.frames[oa]!, this.frames[ob]!, blend),
        lerp(this.frames[oa + 1]!, this.frames[ob + 1]!, blend),
        lerp(this.frames[oa + 2]!, this.frames[ob + 2]!, blend),
      );

      _forward.set(
        lerp(this.frames[oa + 3]!, this.frames[ob + 3]!, blend),
        lerp(this.frames[oa + 4]!, this.frames[ob + 4]!, blend),
        lerp(this.frames[oa + 5]!, this.frames[ob + 5]!, blend),
      );
      _up.set(
        lerp(this.frames[oa + 6]!, this.frames[ob + 6]!, blend),
        lerp(this.frames[oa + 7]!, this.frames[ob + 7]!, blend),
        lerp(this.frames[oa + 8]!, this.frames[ob + 8]!, blend),
      );
      // Interpolating two unit vectors shortens them; re-normalise, and keep the
      // pair orthogonal or the model's basis degenerates.
      if (_forward.lengthSq() > 1e-8) st.forward.copy(_forward).normalize();
      if (_up.lengthSq() > 1e-8) st.up.copy(_up).normalize();
      st.up.addScaledVector(st.forward, -st.up.dot(st.forward)).normalize();

      st.roll = lerp(this.frames[oa + 9]!, this.frames[ob + 9]!, blend);
      st.boost = this.frames[oa + 11]! > 0.5 ? 1 : 0;

      const speed = lerp(this.frames[oa + 10]!, this.frames[ob + 10]!, blend);
      c.telemetry.speed = speed;
      c.telemetry.speedFraction = Math.min(1, Math.max(0, speed / c.handling.topSpeed));
      c.telemetry.impact = 0;
      c.telemetry.scraping = false;

      // The renderer blends between ticks; giving it identical states means the
      // pose it draws is exactly the one asked for.
      c.previous.position.copy(st.position);
      c.previous.forward.copy(st.forward);
      c.previous.up.copy(st.up);
      c.previous.roll = st.roll;
    }
  }
}
