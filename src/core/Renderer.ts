import { nearestRung, resolutionLadder, type ResolutionRung } from './ResolutionLadder';
import { ACESFilmicToneMapping, PerspectiveCamera, WebGPURenderer } from 'three/webgpu';
import { clamp } from './math';

export interface RendererStats {
  /** Backbuffer width in real device pixels. */
  drawingBufferWidth: number;
  drawingBufferHeight: number;
  /** The OS/browser scaling factor for the display the window is on. */
  devicePixelRatio: number;
  /** Dynamic resolution multiplier applied on top of `devicePixelRatio`. */
  resolutionScale: number;
  /** 'webgpu' or 'webgl', whichever the browser gave us. */
  backend: string;
  /** What the GPU we ended up on calls itself, so the answer is not a guess. */
  adapter: string;
}

/** Never render below this fraction of native resolution. */
const MIN_SCALE = 0.55;
/** Frames the frame-time average is taken over before the scale is adjusted. */
const ADAPT_WINDOW = 45;

/**
 * Owns the canvas, the renderer and the resolution policy.
 *
 * The game renders at the display's real pixel density: the backbuffer is the
 * canvas's CSS size multiplied by `devicePixelRatio`, so a 150% Windows scale
 * or a Retina panel gets true native pixels rather than a stretched 1x image.
 * Moving the window to a monitor with a different scale factor fires a
 * `matchMedia` change and the backbuffer is rebuilt, which a plain resize
 * listener would miss entirely — the CSS size does not change when only the
 * density does.
 *
 * Dynamic resolution is a separate multiplier layered on top of native. It only
 * ever trades sharpness for frame rate under load; at rest it sits at 1 and the
 * image is exactly native.
 */
export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: WebGPURenderer;
  readonly camera: PerspectiveCamera;

  /**
   * The player's chosen ceiling, from the resolution setting.
   *
   * Kept apart from the adaptive multiplier so the two compose rather than
   * fight: this is the most the game will ever render at, and the scaler moves
   * underneath it.
   */
  private baseScale = 1;
  /** Dynamic resolution multiplier, 0.55..1, applied under `baseScale`. */
  private adaptiveScale = 1;
  /** Target frame time in seconds that the adaptive scaler aims for. */
  private budget = 1 / 60;
  private adaptive = false;
  private frameTimeSum = 0;
  private frameTimeCount = 0;

  /** GPU milliseconds for the most recent frame the pool could account for. */
  private lastGpuMs = 0;
  /** True while a timestamp resolve is in flight, so they do not stack up. */
  private resolvingGpuTime = false;
  /** False when the device cannot answer timestamp queries; see `init`. */
  private gpuTiming = false;

  /** What the GPU we ended up on calls itself. Shown on the F3 overlay. */
  private adapterName = 'unknown';

  /** What the backbuffer was last built for, so an idle resize costs nothing. */
  private sizedWidth = 0;
  private sizedHeight = 0;
  private sizedDensity = 0;

  private currentDpr = 1;
  private dprQuery: MediaQueryList | null = null;
  private readonly onDprChange = (): void => this.watchPixelRatio();

  private readonly onResize = (): void => this.applySize();

  constructor(canvas?: HTMLCanvasElement) {
    this.canvas = canvas ?? document.createElement('canvas');
    this.canvas.id = 'view';

    // The device is not created here. `init` asks for the adapter itself and
    // hands the finished device over, so this constructor only sets what does
    // not depend on it.
    this.renderer = new WebGPURenderer({
      canvas: this.canvas,
      antialias: false, // Handled in the post chain by TRAA, which is cheaper here.
      powerPreference: 'high-performance',
      alpha: false,
      // GPU timestamps. The frame time on the F3 overlay is wall clock, which
      // on a machine with anything else running says as much about the browser
      // as about the game — and says nothing at all in a tab the browser has
      // throttled. This is the number to tune against.
      trackTimestamp: true,
    });
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.82;
    this.renderer.shadowMap.enabled = true;
    // Transparent clear so overlay passes (the HUD, the menu) composite over the
    // frame instead of blacking it out. The main scene sets its own background,
    // so nothing behind the game is ever actually see-through.
    this.renderer.setClearColor(0x000000, 0);

    this.camera = new PerspectiveCamera(72, 1, 0.35, 6000);
  }

  /**
   * Boots the GPU device. Must be awaited before anything is rendered.
   *
   * The adapter is requested here rather than left to three, for one reason:
   * three asks for `featureLevel: 'compatibility'` alongside the power
   * preference, and on a laptop with two GPUs a compatibility request is
   * exactly the kind a driver is happy to satisfy with the integrated one. Ask
   * plainly for high performance, take the device that comes back, and hand it
   * over — three uses a supplied device as-is and never calls `requestAdapter`.
   *
   * This is a request, not a guarantee. Chrome and Windows still have the final
   * say, and a laptop on battery will often refuse. `stats.adapter` reports
   * what was actually handed over, so the answer is visible on F3 rather than
   * guessed at.
   */
  async init(): Promise<void> {
    await this.claimAdapter();
    await this.renderer.init();
    this.checkGpuTiming();
    if (!this.canvas.isConnected) document.body.appendChild(this.canvas);
    this.watchPixelRatio();
    window.addEventListener('resize', this.onResize);
    this.applySize();
  }

  /** Requests a discrete adapter and hands three the device it produces. */
  private async claimAdapter(): Promise<void> {
    const gpu = (navigator as unknown as { gpu?: GPU }).gpu;
    if (!gpu) return;

    try {
      const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return;

      const info = adapter.info as GPUAdapterInfo | undefined;
      this.adapterName = [info?.vendor, info?.architecture, info?.description]
        .filter((part) => part)
        .join(' ') || 'unnamed adapter';

      const device = await Renderer.claimDevice(adapter);
      (this.renderer as unknown as { backend: { parameters: { device?: GPUDevice } } }).backend.parameters.device =
        device;
    } catch {
      // Whatever went wrong, three's own path is a working fallback: it will
      // request an adapter itself on `init`.
      this.adapterName = 'default adapter';
    }
  }

  /**
   * A device carrying every feature its adapter offers, which is what three
   * asks for when it creates the device itself. Taking that job over and then
   * requesting nothing left the renderer without timestamp queries — and
   * without `core-features-and-limits`, which three reads as compatibility mode
   * and answers by turning multisampling off.
   *
   * Note that limits are a separate question: neither this nor three's own path
   * raises them, so the device gets the WebGPU defaults rather than everything
   * the adapter could do.
   *
   * If the full feature list is refused for any reason, a plain request is
   * tried before giving up. Falling out of here means falling back to three,
   * which asks for `featureLevel: 'compatibility'` — the integrated-GPU path
   * this whole method exists to avoid — so it is worth one more attempt.
   */
  private static async claimDevice(adapter: GPUAdapter): Promise<GPUDevice> {
    try {
      return await adapter.requestDevice({
        requiredFeatures: [...adapter.features] as GPUFeatureName[],
      });
    } catch {
      return adapter.requestDevice();
    }
  }

  /**
   * Turns timestamp tracking off unless the device can actually serve it.
   *
   * three attaches `timestampWrites` to every render pass as soon as
   * `trackTimestamp` is set and never checks the device's features. On a device
   * without `timestamp-query` the query set is invalid, so every pass it is
   * attached to fails validation and the frame comes out blank. The guard has
   * to be ours, and it has to cover three's own device as well as the one
   * `claimAdapter` hands over.
   */
  private checkGpuTiming(): void {
    const backend = this.renderer.backend as unknown as {
      device?: GPUDevice;
      trackTimestamp?: boolean;
    };
    this.gpuTiming = backend.device?.features?.has('timestamp-query') === true;
    if (!this.gpuTiming) backend.trackTimestamp = false;
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.renderer.dispose();
  }

  /**
   * Re-registers the density listener for the current `devicePixelRatio`.
   *
   * A media query can only test one value, so the query is rebuilt each time the
   * ratio changes — that is the standard way to be told about density changes,
   * because there is no `devicePixelRatiochange` event.
   */
  private watchPixelRatio(): void {
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.currentDpr = window.devicePixelRatio || 1;
    this.dprQuery = window.matchMedia(`(resolution: ${this.currentDpr}dppx)`);
    this.dprQuery.addEventListener('change', this.onDprChange);
    this.applySize();
  }

  private applySize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const density = this.currentDpr * this.baseScale * this.adaptiveScale;

    // A phone fires `resize` on every rotation and on every show and hide of
    // the URL bar, and most of that storm ends where it started. Reallocating
    // the backbuffer also reallocates every render target in the post chain
    // behind it, which is far too much to do for a number that has not moved.
    if (width === this.sizedWidth && height === this.sizedHeight && density === this.sizedDensity) {
      return;
    }
    this.sizedWidth = width;
    this.sizedHeight = height;
    this.sizedDensity = density;
    this.renderer.setPixelRatio(density);
    this.renderer.setSize(width, height, true);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /** Turns adaptive resolution on or off, and sets the frame-time target. */
  setAdaptive(enabled: boolean, targetFps = 60): void {
    this.adaptive = enabled;
    this.budget = 1 / targetFps;
    // Only the scaler's own multiplier is reset. The player's ceiling is not
    // the scaler's to give back.
    if (!enabled) this.setResolutionScale(1);
  }

  /**
   * Sets the resolution the game renders at, as a multiplier on the display's
   * pixel density. 1 is the display's real pixels; `1 / devicePixelRatio` is
   * the CSS size.
   */
  setBaseScale(scale: number): void {
    // Clamped to the ladder's own bottom rung, not to `MIN_SCALE`. The scaler's
    // floor is 0.55 and the ladder reaches `1 / dpr` — 0.5 on a 2x display, a
    // third on a 3x one — so clamping to 0.55 would render the lowest rungs at
    // a resolution their own labels deny, two of them identically.
    const floor = Math.min(this.ladder()[0]?.scale ?? MIN_SCALE, MIN_SCALE);
    const next = clamp(scale, floor, 1);
    if (Math.abs(next - this.baseScale) < 0.005) return;
    this.baseScale = next;
    // The scaler's room depends on the ceiling, so re-apply its own clamp
    // before resizing rather than leaving it stale for a frame.
    this.adaptiveScale = clamp(this.adaptiveScale, Math.min(1, MIN_SCALE / next), 1);
    this.applySize();
  }

  /**
   * Moves the adaptive multiplier, which rides under the player's ceiling.
   *
   * `MIN_SCALE` is a floor on the picture, not on this multiplier — it is the
   * point past which dropping resolution costs more than the frame rate is
   * worth. So the floor is applied to the product: the scaler may take the
   * frame down to 0.55 of native and no further, whatever rung the player
   * chose. Pick a rung at or below that and the scaler simply has no room,
   * which is the right answer — the budget has already been spent by hand.
   */
  setResolutionScale(scale: number): void {
    const floor = Math.min(1, MIN_SCALE / this.baseScale);
    const next = clamp(scale, floor, 1);
    if (Math.abs(next - this.adaptiveScale) < 0.005) return;
    this.adaptiveScale = next;
    this.applySize();
  }

  /**
   * Feeds the adaptive scaler one frame. Moves in small steps so the resolution
   * never visibly pumps, and recovers more slowly than it drops.
   */
  reportFrame(frameTime: number): void {
    if (!this.adaptive) return;
    this.frameTimeSum += frameTime;
    this.frameTimeCount++;
    if (this.frameTimeCount < ADAPT_WINDOW) return;

    const average = this.frameTimeSum / this.frameTimeCount;
    this.frameTimeSum = 0;
    this.frameTimeCount = 0;

    if (average > this.budget * 1.12) this.setResolutionScale(this.adaptiveScale - 0.06);
    else if (average < this.budget * 0.82) this.setResolutionScale(this.adaptiveScale + 0.03);
  }

  /**
   * GPU milliseconds for a recent frame.
   *
   * Resolving a timestamp query is asynchronous — the results are read back
   * from the device — so this returns the last answer and starts fetching the
   * next one. Called a few times a second from the perf overlay, that is a
   * reading a fraction of a second old, which is what a tuning number needs to
   * be and no more.
   *
   * It has to be called whether or not anyone is looking. three's query pool
   * holds 2048 timestamps and simply stops recording once it is full, which a
   * frame of twenty-odd passes reaches in about a second, so a pool nobody
   * drains warns to the console and then hands back a frame from the opening
   * seconds of the session.
   *
   * The value is one frame's worth, not the window's. The pool holds queries
   * for every frame since the last drain, but it tags each with the frame that
   * issued it and returns the sum for the most recent one only — so no
   * arithmetic is needed here, and any applied is wrong. A previous version
   * divided by the frames elapsed, on the strength of a doc comment that says
   * "resolves all pending queries and returns the total duration" without
   * mentioning the grouping. That made the reading a frame's cost over a frame
   * count, which is not a quantity, and it ranked the quality presets backwards
   * because a cheaper preset resolves sooner and so divides by less.
   */
  gpuTime(): number {
    if (this.gpuTiming && !this.resolvingGpuTime) {
      this.resolvingGpuTime = true;
      void this.renderer
        .resolveTimestampsAsync()
        .then((ms) => {
          // Undefined when there is no pool yet, i.e. before the first pass.
          if (typeof ms === 'number') this.lastGpuMs = ms;
        })
        .catch(() => undefined)
        .finally(() => {
          this.resolvingGpuTime = false;
        });
    }
    return this.lastGpuMs;
  }

  /** The resolutions this display can offer, lowest first. */
  ladder(): ResolutionRung[] {
    return resolutionLadder(window.innerWidth, window.innerHeight, this.currentDpr);
  }

  /** Which rung the current ceiling sits on. */
  currentRung(): number {
    return nearestRung(this.ladder(), this.baseScale);
  }

  get stats(): RendererStats {
    const context = this.renderer.getContext() as { drawingBufferWidth?: number; drawingBufferHeight?: number };
    return {
      drawingBufferWidth:
        context?.drawingBufferWidth ?? Math.round(window.innerWidth * this.currentDpr * this.baseScale * this.adaptiveScale),
      drawingBufferHeight:
        context?.drawingBufferHeight ?? Math.round(window.innerHeight * this.currentDpr * this.baseScale * this.adaptiveScale),
      devicePixelRatio: this.currentDpr,
      resolutionScale: this.baseScale * this.adaptiveScale,
      backend: (this.renderer.backend as { isWebGPUBackend?: boolean } | undefined)?.isWebGPUBackend
        ? 'webgpu'
        : 'webgl',
      adapter: this.adapterName,
    };
  }
}
