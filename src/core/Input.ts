import { clamp, clamp01 } from './math';
import type { InputSnapshot } from '@/game/InputSnapshot';
import { createInputSnapshot, resetInputSnapshot } from '@/game/InputSnapshot';

/** Discrete actions the menu listens for. */
export type MenuAction = 'up' | 'down' | 'left' | 'right' | 'confirm' | 'back' | 'pause';

/** Seconds a shoulder tap stays "recent" for a double-tap to register. */
const DOUBLE_TAP_WINDOW = 0.26;
/** Stick deflection below this is treated as centred. */
const STICK_DEADZONE = 0.16;
/** Trigger pull below this is treated as released. */
const TRIGGER_DEADZONE = 0.06;
/** Delay before a held menu direction starts repeating, in seconds. */
const REPEAT_DELAY = 0.4;
/** Interval between repeats once repeating, in seconds. */
const REPEAT_RATE = 0.11;

/** Standard-mapping gamepad button indices, named. */
const PAD = {
  south: 0,
  east: 1,
  west: 2,
  north: 3,
  leftShoulder: 4,
  rightShoulder: 5,
  leftTrigger: 6,
  rightTrigger: 7,
  select: 8,
  start: 9,
  dpadUp: 12,
  dpadDown: 13,
  dpadLeft: 14,
  dpadRight: 15,
} as const;

/**
 * The keyboard bindings, in one place so the controls screen can render them
 * without a second source of truth.
 */
export const KEY_BINDINGS = {
  thrust: ['KeyW', 'ArrowUp'],
  steerLeft: ['KeyA', 'ArrowLeft'],
  steerRight: ['KeyD', 'ArrowRight'],
  brakeLeft: ['KeyQ'],
  brakeRight: ['KeyE'],
  pitchUp: ['KeyR'],
  pitchDown: ['KeyF'],
  fire: ['Space'],
  absorb: ['ShiftLeft', 'ShiftRight'],
  lookBack: ['KeyC'],
  pause: ['Escape'],
  confirm: ['Enter', 'Space', 'NumpadEnter'],
  back: ['Escape', 'Backspace'],
} as const;

/**
 * Keyboard and gamepad, resolved into one intent per tick.
 *
 * Both devices feed the same `InputSnapshot` the AI writes, so nothing
 * downstream knows or cares which is in use — and a controller plugged in
 * mid-race just starts working.
 *
 * Analogue where the hardware allows it: the triggers give real partial thrust
 * and partial airbrake, which matters a lot for holding a line. The keyboard
 * ramps toward its targets instead of snapping, for the same reason.
 */
export class Input {
  readonly snapshot: InputSnapshot = createInputSnapshot();

  /** True when the most recent meaningful input came from a gamepad. */
  activeDevice: 'keyboard' | 'gamepad' = 'keyboard';

  private readonly held = new Set<string>();
  private readonly pressedThisFrame = new Set<string>();
  private readonly menuQueue: MenuAction[] = [];

  /** Previous frame's gamepad button states, for edge detection. */
  private padPrev = new Array<boolean>(20).fill(false);
  private padIndex: number | null = null;

  /** Time since the last tap of each shoulder, for double-tap detection. */
  private tapAge = { left: Infinity, right: Infinity };
  /** Direction currently held in the menu, and how long for. */
  private repeatAction: MenuAction | null = null;
  private repeatTimer = 0;
  private repeating = false;

  /** Smoothed keyboard axes, so tapping a key is not a step function. */
  private keySteer = 0;
  private keyThrust = 0;

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    // Let the browser keep its own shortcuts; swallow only what the game uses.
    if (this.isGameKey(e.code)) e.preventDefault();
    this.held.add(e.code);
    this.pressedThisFrame.add(e.code);
    this.activeDevice = 'keyboard';
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
  };

  private readonly onBlur = (): void => {
    // Without this a key held while alt-tabbing stays held forever.
    this.held.clear();
    this.pressedThisFrame.clear();
  };

  private readonly onGamepadConnected = (e: GamepadEvent): void => {
    this.padIndex = e.gamepad.index;
  };

  private readonly onGamepadDisconnected = (e: GamepadEvent): void => {
    if (this.padIndex === e.gamepad.index) this.padIndex = null;
  };

  attach(target: Window = window): void {
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('blur', this.onBlur);
    target.addEventListener('gamepadconnected', this.onGamepadConnected as EventListener);
    target.addEventListener('gamepaddisconnected', this.onGamepadDisconnected as EventListener);
  }

  detach(target: Window = window): void {
    target.removeEventListener('keydown', this.onKeyDown);
    target.removeEventListener('keyup', this.onKeyUp);
    target.removeEventListener('blur', this.onBlur);
    target.removeEventListener('gamepadconnected', this.onGamepadConnected as EventListener);
    target.removeEventListener('gamepaddisconnected', this.onGamepadDisconnected as EventListener);
  }

  private isGameKey(code: string): boolean {
    for (const codes of Object.values(KEY_BINDINGS)) {
      if ((codes as readonly string[]).includes(code)) return true;
    }
    return false;
  }

  private anyHeld(codes: readonly string[]): boolean {
    for (const c of codes) if (this.held.has(c)) return true;
    return false;
  }

  private anyPressed(codes: readonly string[]): boolean {
    for (const c of codes) if (this.pressedThisFrame.has(c)) return true;
    return false;
  }

  private pad(): Gamepad | null {
    const pads = navigator.getGamepads?.() ?? [];
    if (this.padIndex !== null) {
      const p = pads[this.padIndex];
      if (p?.connected) return p;
    }
    for (const p of pads) {
      if (p?.connected && p.mapping === 'standard') {
        this.padIndex = p.index;
        return p;
      }
    }
    return null;
  }

  private static axis(value: number | undefined): number {
    const v = value ?? 0;
    if (Math.abs(v) < STICK_DEADZONE) return 0;
    // Rescale so the axis still reaches 1 after the deadzone is removed.
    return clamp((Math.abs(v) - STICK_DEADZONE) / (1 - STICK_DEADZONE), 0, 1) * Math.sign(v);
  }

  private static trigger(button: GamepadButton | undefined): number {
    const v = button?.value ?? (button?.pressed ? 1 : 0);
    return v < TRIGGER_DEADZONE ? 0 : clamp01((v - TRIGGER_DEADZONE) / (1 - TRIGGER_DEADZONE));
  }

  /**
   * Samples both devices and rebuilds `snapshot`. Call once per rendered
   * frame, before the simulation catches up.
   */
  update(dt: number): void {
    const s = this.snapshot;
    resetInputSnapshot(s);

    const pad = this.pad();
    const padButtons = pad?.buttons ?? [];
    const padPressed = (index: number): boolean => padButtons[index]?.pressed ?? false;
    const padEdge = (index: number): boolean => padPressed(index) && !this.padPrev[index];

    // --- Continuous axes ---
    const keySteerTarget =
      (this.anyHeld(KEY_BINDINGS.steerRight) ? 1 : 0) - (this.anyHeld(KEY_BINDINGS.steerLeft) ? 1 : 0);
    const keyThrustTarget = this.anyHeld(KEY_BINDINGS.thrust) ? 1 : 0;
    // Ramp rates chosen so a keyboard player can still feather a corner: full
    // lock takes about a fifth of a second, release about a tenth.
    this.keySteer += (keySteerTarget - this.keySteer) * (1 - Math.exp(-dt * (keySteerTarget === 0 ? 22 : 11)));
    this.keyThrust += (keyThrustTarget - this.keyThrust) * (1 - Math.exp(-dt * 14));

    const padSteer = Input.axis(pad?.axes[0]);
    const padThrust = Input.trigger(padButtons[PAD.rightTrigger]);
    const padBrakeLeft = padPressed(PAD.leftShoulder) ? 1 : 0;
    const padBrakeRight = padPressed(PAD.rightShoulder) ? 1 : 0;

    if (padSteer !== 0 || padThrust > 0 || padBrakeLeft > 0 || padBrakeRight > 0) {
      this.activeDevice = 'gamepad';
    }

    s.steer = clamp(this.keySteer + padSteer, -1, 1);
    s.thrust = clamp01(this.keyThrust + padThrust);
    s.brakeLeft = clamp01((this.anyHeld(KEY_BINDINGS.brakeLeft) ? 1 : 0) + padBrakeLeft);
    s.brakeRight = clamp01((this.anyHeld(KEY_BINDINGS.brakeRight) ? 1 : 0) + padBrakeRight);
    s.pitch = clamp(
      (this.anyHeld(KEY_BINDINGS.pitchUp) ? 1 : 0) -
        (this.anyHeld(KEY_BINDINGS.pitchDown) ? 1 : 0) -
        Input.axis(pad?.axes[1]),
      -1,
      1,
    );

    s.fire = this.anyPressed(KEY_BINDINGS.fire) || padEdge(PAD.south);
    s.absorb = this.anyPressed(KEY_BINDINGS.absorb) || padEdge(PAD.east);
    s.lookBack = this.anyHeld(KEY_BINDINGS.lookBack) || padPressed(PAD.leftTrigger);

    // --- Double tap: sideshift on the ground, barrel roll in the air ---
    this.tapAge.left += dt;
    this.tapAge.right += dt;
    const tappedLeft = this.pressedThisFrame.has('KeyQ') || padEdge(PAD.leftShoulder);
    const tappedRight = this.pressedThisFrame.has('KeyE') || padEdge(PAD.rightShoulder);

    if (tappedLeft) {
      if (this.tapAge.left < DOUBLE_TAP_WINDOW) {
        s.sideshift = -1;
        s.barrelRoll = -1;
        this.tapAge.left = Infinity;
      } else {
        this.tapAge.left = 0;
      }
    }
    if (tappedRight) {
      if (this.tapAge.right < DOUBLE_TAP_WINDOW) {
        s.sideshift = 1;
        s.barrelRoll = 1;
        this.tapAge.right = Infinity;
      } else {
        this.tapAge.right = 0;
      }
    }

    this.pumpMenuActions(dt, pad, padEdge);

    for (let i = 0; i < this.padPrev.length; i++) this.padPrev[i] = padPressed(i);
    this.pressedThisFrame.clear();
  }

  /** Queues menu actions, with hold-to-repeat on the four directions. */
  private pumpMenuActions(dt: number, pad: Gamepad | null, padEdge: (i: number) => boolean): void {
    const stickX = Input.axis(pad?.axes[0]);
    const stickY = Input.axis(pad?.axes[1]);
    const buttons = pad?.buttons ?? [];
    const down = (i: number): boolean => buttons[i]?.pressed ?? false;

    let direction: MenuAction | null = null;
    if (this.anyHeld(KEY_BINDINGS.steerLeft) || down(PAD.dpadLeft) || stickX < -0.5) direction = 'left';
    else if (this.anyHeld(KEY_BINDINGS.steerRight) || down(PAD.dpadRight) || stickX > 0.5) direction = 'right';
    else if (this.anyHeld(KEY_BINDINGS.thrust) || down(PAD.dpadUp) || stickY < -0.5) direction = 'up';
    else if (this.held.has('KeyS') || this.held.has('ArrowDown') || down(PAD.dpadDown) || stickY > 0.5) {
      direction = 'down';
    }

    if (direction !== this.repeatAction) {
      this.repeatAction = direction;
      this.repeatTimer = 0;
      this.repeating = false;
      if (direction) this.menuQueue.push(direction);
    } else if (direction) {
      this.repeatTimer += dt;
      const threshold = this.repeating ? REPEAT_RATE : REPEAT_DELAY;
      if (this.repeatTimer >= threshold) {
        this.menuQueue.push(direction);
        this.repeatTimer = 0;
        this.repeating = true;
      }
    }

    if (this.anyPressed(KEY_BINDINGS.confirm) || padEdge(PAD.south)) this.menuQueue.push('confirm');
    if (this.anyPressed(KEY_BINDINGS.back) || padEdge(PAD.east)) this.menuQueue.push('back');
    if (this.anyPressed(KEY_BINDINGS.pause) || padEdge(PAD.start)) this.menuQueue.push('pause');
  }

  /** Takes the next queued menu action, or null. */
  nextMenuAction(): MenuAction | null {
    return this.menuQueue.shift() ?? null;
  }

  clearMenuActions(): void {
    this.menuQueue.length = 0;
  }

  /**
   * Fires the gamepad's rumble. Silently does nothing where the pad or the
   * browser does not support it, which is most of them.
   */
  rumble(strength: number, durationMs: number): void {
    const pad = this.pad();
    const actuator = pad?.vibrationActuator;
    if (!actuator) return;
    const magnitude = clamp01(strength);
    void actuator
      .playEffect('dual-rumble', {
        duration: durationMs,
        strongMagnitude: magnitude,
        weakMagnitude: magnitude * 0.6,
      })
      .catch(() => undefined);
  }
}
