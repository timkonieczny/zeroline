/**
 * Fixed-step simulation driving a variable-rate renderer.
 *
 * The physics runs at a constant tick no matter what the display is doing, so a
 * race plays out identically on a 60 Hz laptop and a 240 Hz monitor — which is
 * what makes ghosts, replays and eventually netcode agree with each other. The
 * renderer then blends between the last two simulation states, so a 120 Hz sim
 * does not read as 120 Hz stutter on a 144 Hz panel.
 *
 * Long frames are capped rather than caught up: after a stall, better to lose a
 * moment of simulated time than to spend a second running a hundred ticks and
 * stall again.
 */
/**
 * Longest step handed to the renderer, in seconds.
 *
 * The simulation already caps how much it will catch up; this does the same for
 * everything that eases on frame time. Without it, any hitch — a tab regaining
 * focus, a shader compiling, a race settling at the flag — arrives as a single
 * multi-second step and every animation in the game teleports to its end state.
 */
const MAX_RENDER_STEP = 0.1;

export class Loop {
  /** Simulation ticks per second. */
  readonly rate: number;
  /** Seconds per tick. */
  readonly step: number;
  /** Most ticks allowed in one frame before the remainder is discarded. */
  private readonly maxTicks: number;

  private accumulator = 0;
  private lastTime = 0;
  private running = false;
  private frameHandle = 0;

  /** Interpolation factor between the previous and current sim state, 0..1. */
  alpha = 0;
  /** Seconds the last rendered frame took, for the perf overlay. */
  frameTime = 0;
  /** Simulation ticks executed in the last frame. */
  ticksLastFrame = 0;
  /** Total elapsed simulated time in seconds. */
  time = 0;

  constructor(
    private readonly onTick: (step: number) => void,
    private readonly onRender: (alpha: number, frameTime: number) => void,
    rate = 120,
    maxTicks = 6,
  ) {
    this.rate = rate;
    this.step = 1 / rate;
    this.maxTicks = maxTicks;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.frameHandle = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frameHandle);
  }

  private readonly frame = (now: number): void => {
    if (!this.running) return;
    this.frameHandle = requestAnimationFrame(this.frame);

    const elapsed = (now - this.lastTime) / 1000;
    this.lastTime = now;
    this.frameTime = elapsed;

    this.accumulator += Math.min(elapsed, this.step * this.maxTicks);

    let ticks = 0;
    while (this.accumulator >= this.step && ticks < this.maxTicks) {
      this.onTick(this.step);
      this.accumulator -= this.step;
      this.time += this.step;
      ticks++;
    }
    this.ticksLastFrame = ticks;
    this.alpha = this.accumulator / this.step;

    // `frameTime` above keeps the true elapsed time for the perf overlay; what
    // the renderer animates against is clamped.
    this.onRender(this.alpha, Math.min(elapsed, MAX_RENDER_STEP));
  };
}
