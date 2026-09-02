import type { Input } from './Input';
import { damp } from './math';
import {
  createTiltControls,
  createTiltNeutral,
  tiltToControls,
  type TiltReading,
} from './Tilt';

/** The five things a thumb can be on during a race. */
export type TouchControlId = 'brakeLeft' | 'brakeRight' | 'fire' | 'absorb' | 'pause';

/**
 * One control's hit rectangle, in CSS pixels with the origin at the top left.
 *
 * Browser coordinates, not the overlay's. The scene that draws these works
 * bottom-up in its own logical units, and converting once where the rectangle
 * is produced beats converting at every pointer event.
 */
export interface TouchRegion {
  id: TouchControlId;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Which surface the fingers are driving. */
export type TouchMode = 'menu' | 'race' | 'held';

/** How far the permission dance has got. */
export type MotionAccess = 'idle' | 'granted' | 'denied' | 'unavailable';

export interface TouchOptions {
  /** The canvas. Overlays above it already swallow taps, which is correct. */
  target: HTMLElement;
  input: Input;
  /** Run synchronously inside the first pointerdown, where iOS wants it. */
  onFirstGesture: () => void;
  /** A tap no race control claimed, in CSS pixels from the top left. */
  onTap: (x: number, y: number) => void;
  /** The race controls' hit rectangles, empty when not racing. */
  regions: () => readonly TouchRegion[];
  /** Visual feedback for a held control. */
  setPressed: (id: TouchControlId, pressed: boolean) => void;
}

/** Fingers tracked at once. Two thumbs, two forefingers, and two to spare. */
const MAX_POINTERS = 6;

/**
 * Seconds a pad tap stays recent enough for a second one to count as a double.
 *
 * Wider than the gamepad's 0.26 s. A thumb already resting on an airbrake has
 * to lift and land again, which is slower and less repeatable than clicking a
 * bumper with travel under it.
 */
const DOUBLE_TAP_WINDOW = 0.32;

/** Half-life of the touch airbrake ramp, in seconds. */
const BRAKE_RAMP = 0.09;
/**
 * Half-life of the tilt smoother, in seconds.
 *
 * `deviceorientation` fires at about 60 Hz while the simulation runs at 120, so
 * without this the craft sees a staircase; a hand's own tremor sits at 6–10 Hz
 * and lands in the same band. Three frames' worth is enough to erase both.
 *
 * Smoothing is latency, though, and this is the number that decides whether the
 * craft feels attached to the phone. Much past 80 ms and it feels like treacle.
 */
const TILT_SMOOTHING = 0.045;

/** Seconds without an orientation event before motion is declared unavailable. */
const MOTION_PROBE = 1.5;

/**
 * A phone, resolved into the same intent a keyboard produces.
 *
 * Owns every pointer and orientation listener and writes into `Input.touch`,
 * which `Input.update` folds into the snapshot alongside the keyboard and the
 * pad. Nothing downstream learns that a phone exists.
 *
 * It is constructed only on a touch device, so the desktop build pays one null
 * check per frame for all of this and nothing else.
 *
 * **Time comes from `update(dt)`, never from the clock.** The double-tap window
 * and the ramps are driven by the frame time handed in, the same way the
 * keyboard's ramps are. `Date.now()` is the obvious reach for a double tap and
 * it would make the touch path the one input that cannot be replayed.
 */
export class Touch {
  /** Set by the app each frame. Changing it releases every held finger. */
  mode: TouchMode = 'menu';
  /**
   * True while the lights are still on.
   *
   * The throttle is otherwise automatic, which would hand a phone player a
   * perfect getaway every time — the standing start pays out on *when* the
   * throttle opened, and one held from the first light scores nothing at all.
   * While this is set the fire button opens the throttle instead of firing,
   * and the timing is back in the player's hands.
   */
  launching = false;

  private readonly slotId = new Int32Array(MAX_POINTERS).fill(-1);
  private readonly slotControl: (TouchControlId | null)[] = new Array<TouchControlId | null>(
    MAX_POINTERS,
  ).fill(null);

  /** Eased airbrake pressure, so a binary screen still feathers. */
  private rampLeft = 0;
  private rampRight = 0;

  private tapAgeLeft = Infinity;
  private tapAgeRight = Infinity;
  private tappedLeft = false;
  private tappedRight = false;

  private unlocked = false;

  // --- Tilt ---------------------------------------------------------------
  private motionState: MotionAccess = 'idle';
  private sinceRequest = 0;
  private heard = false;
  private readonly reading: TiltReading = { beta: 0, gamma: 0, screenAngle: 90 };
  private readonly neutral = createTiltNeutral();
  private readonly tilt = createTiltControls();
  private steer = 0;
  private pitch = 0;

  constructor(private readonly options: TouchOptions) {}

  get motion(): MotionAccess {
    return this.motionState;
  }

  attach(): void {
    const target = this.options.target;
    target.addEventListener('pointerdown', this.onPointerDown);
    target.addEventListener('pointerup', this.onPointerUp);
    target.addEventListener('pointercancel', this.onPointerUp);
    target.addEventListener('lostpointercapture', this.onPointerUp);
    window.addEventListener('blur', this.releaseAll);
    document.addEventListener('visibilitychange', this.onVisibility);
    // WebKit ignores `user-scalable=no`, and `touch-action` does not reliably
    // stop a pinch. This does.
    document.addEventListener('gesturestart', this.preventDefault);
  }

  detach(): void {
    const target = this.options.target;
    target.removeEventListener('pointerdown', this.onPointerDown);
    target.removeEventListener('pointerup', this.onPointerUp);
    target.removeEventListener('pointercancel', this.onPointerUp);
    target.removeEventListener('lostpointercapture', this.onPointerUp);
    window.removeEventListener('blur', this.releaseAll);
    document.removeEventListener('visibilitychange', this.onVisibility);
    document.removeEventListener('gesturestart', this.preventDefault);
    window.removeEventListener('deviceorientation', this.onOrientation);
    this.releaseAll();
  }

  /** Takes the phone's current pose as centre. Called when the lights come on. */
  recentre(): void {
    this.neutral.beta = this.reading.beta;
    this.neutral.gamma = this.reading.gamma;
  }

  /**
   * Asks iOS for the motion permission.
   *
   * Must be called from inside a real gesture, which is why it happens on the
   * first `pointerdown` and not when a race starts: the menu's confirm arrives
   * through a rAF callback, and Safari refuses a permission request from there.
   */
  requestMotion(): void {
    if (this.motionState === 'granted') return;

    window.addEventListener('deviceorientation', this.onOrientation);
    this.sinceRequest = 0;

    const api = (DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> })
      .requestPermission;
    if (typeof api !== 'function') {
      // Android and older iOS: nothing to ask. The first event grants it, and
      // the probe below decides it is missing if none arrives.
      return;
    }

    void api
      .call(DeviceOrientationEvent)
      .then((result: string) => {
        this.motionState = result === 'granted' ? 'granted' : 'denied';
      })
      .catch(() => {
        this.motionState = 'denied';
      });
  }

  /** Drops every held finger. Used on a mode change, a pause, or losing focus. */
  readonly releaseAll = (): void => {
    for (let i = 0; i < MAX_POINTERS; i++) {
      const control = this.slotControl[i];
      if (control) this.options.setPressed(control, false);
      this.slotId[i] = -1;
      this.slotControl[i] = null;
    }
    this.rampLeft = 0;
    this.rampRight = 0;
    this.tapAgeLeft = Infinity;
    this.tapAgeRight = Infinity;
    this.tappedLeft = false;
    this.tappedRight = false;
  };

  /** Folds this frame's fingers and tilt into `Input.touch`. */
  update(dt: number): void {
    const state = this.options.input.touch;
    state.active = true;

    if (this.motionState === 'idle') {
      this.sinceRequest += dt;
      if (this.heard) this.motionState = 'granted';
      else if (this.sinceRequest > MOTION_PROBE) this.motionState = 'unavailable';
    }

    this.tapAgeLeft += dt;
    this.tapAgeRight += dt;

    if (this.mode !== 'race') {
      state.thrust = 0;
      state.brakeLeft = false;
      state.brakeRight = false;
      state.steer = 0;
      state.pitch = 0;
      this.rampLeft = 0;
      this.rampRight = 0;
      this.tappedLeft = false;
      this.tappedRight = false;
      return;
    }

    const heldLeft = this.isHeld('brakeLeft');
    const heldRight = this.isHeld('brakeRight');
    this.rampLeft = damp(this.rampLeft, heldLeft ? 1 : 0, BRAKE_RAMP, dt);
    this.rampRight = damp(this.rampRight, heldRight ? 1 : 0, BRAKE_RAMP, dt);

    // A screen reports no pressure worth having, so an airbrake is binary at
    // source. The ramp gives a thumb the travel the hardware does not, for the
    // same reason the keyboard ramps rather than snapping.
    state.brakeLeft = this.rampLeft > 0.02;
    state.brakeRight = this.rampRight > 0.02;

    state.thrust = this.launching ? (this.isHeld('fire') ? 1 : 0) : 1;

    this.driveTilt(dt);
    state.steer = this.steer;
    state.pitch = this.pitch;

    // Consumed here rather than at the event, so the edge lands inside an
    // update the way a key press does.
    state.tapLeft = this.tappedLeft;
    state.tapRight = this.tappedRight;
    this.tappedLeft = false;
    this.tappedRight = false;
  }

  private driveTilt(dt: number): void {
    if (this.motionState !== 'granted') {
      this.steer = 0;
      this.pitch = 0;
      return;
    }

    tiltToControls(this.reading, this.neutral, this.tilt);
    this.steer = damp(this.steer, this.tilt.steer, TILT_SMOOTHING, dt);
    this.pitch = damp(this.pitch, this.tilt.pitch, TILT_SMOOTHING, dt);
  }

  private isHeld(control: TouchControlId): boolean {
    for (let i = 0; i < MAX_POINTERS; i++) {
      if (this.slotId[i] !== -1 && this.slotControl[i] === control) return true;
    }
    return false;
  }

  // --- Events -------------------------------------------------------------

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.unlocked) {
      this.unlocked = true;
      // Synchronously, inside the gesture: iOS grants an audio context and the
      // motion permission from here and refuses both from a frame callback.
      this.options.onFirstGesture();
    }

    if (this.mode === 'held') return;

    const control = this.mode === 'race' ? this.controlAt(event.clientX, event.clientY) : null;
    if (!control) {
      this.options.onTap(event.clientX, event.clientY);
      return;
    }

    const slot = this.freeSlot();
    if (slot < 0) return;
    this.slotId[slot] = event.pointerId;
    // The control a finger owns is decided here and never changes. A thumb that
    // slides off the brake keeps braking, and never wanders onto fire.
    this.slotControl[slot] = control;
    this.options.setPressed(control, true);

    if (this.options.target.setPointerCapture) {
      try {
        this.options.target.setPointerCapture(event.pointerId);
      } catch {
        // A pointer that has already gone. Nothing to capture, nothing to fix.
      }
    }

    if (control === 'brakeLeft') this.registerTap('left');
    else if (control === 'brakeRight') this.registerTap('right');
    else if (control === 'fire' && !this.launching) this.options.input.touch.fire = true;
    else if (control === 'absorb') this.options.input.touch.absorb = true;
    else if (control === 'pause') this.options.input.pushMenuAction('pause');
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    for (let i = 0; i < MAX_POINTERS; i++) {
      if (this.slotId[i] !== event.pointerId) continue;
      const control = this.slotControl[i];
      if (control) this.options.setPressed(control, false);
      this.slotId[i] = -1;
      this.slotControl[i] = null;
      return;
    }
  };

  private readonly onVisibility = (): void => {
    if (document.hidden) this.releaseAll();
  };

  private readonly preventDefault = (event: Event): void => event.preventDefault();

  private readonly onOrientation = (event: DeviceOrientationEvent): void => {
    if (event.beta === null || event.gamma === null) return;
    this.heard = true;
    this.reading.beta = event.beta;
    this.reading.gamma = event.gamma;
    this.reading.screenAngle = screen.orientation?.angle ?? 0;
  };

  private registerTap(side: 'left' | 'right'): void {
    if (side === 'left') {
      if (this.tapAgeLeft < DOUBLE_TAP_WINDOW) {
        this.tappedLeft = true;
        this.tapAgeLeft = Infinity;
      } else {
        this.tapAgeLeft = 0;
      }
      return;
    }
    if (this.tapAgeRight < DOUBLE_TAP_WINDOW) {
      this.tappedRight = true;
      this.tapAgeRight = Infinity;
    } else {
      this.tapAgeRight = 0;
    }
  }

  private controlAt(x: number, y: number): TouchControlId | null {
    for (const region of this.options.regions()) {
      if (
        x >= region.x &&
        x <= region.x + region.width &&
        y >= region.y &&
        y <= region.y + region.height
      ) {
        return region.id;
      }
    }
    return null;
  }

  private freeSlot(): number {
    for (let i = 0; i < MAX_POINTERS; i++) if (this.slotId[i] === -1) return i;
    return -1;
  }
}
