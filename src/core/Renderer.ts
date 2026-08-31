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

  /** Dynamic resolution multiplier, 0.55..1. */
  private scale = 1;
  /** Target frame time in seconds that the adaptive scaler aims for. */
  private budget = 1 / 60;
  private adaptive = false;
  private frameTimeSum = 0;
  private frameTimeCount = 0;

  private currentDpr = 1;
  private dprQuery: MediaQueryList | null = null;
  private readonly onDprChange = (): void => this.watchPixelRatio();

  private readonly onResize = (): void => this.applySize();

  constructor(canvas?: HTMLCanvasElement) {
    this.canvas = canvas ?? document.createElement('canvas');
    this.canvas.id = 'view';

    this.renderer = new WebGPURenderer({
      canvas: this.canvas,
      antialias: false, // Handled in the post chain by TRAA, which is cheaper here.
      powerPreference: 'high-performance',
      alpha: false,
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

  /** Boots the GPU device. Must be awaited before anything is rendered. */
  async init(): Promise<void> {
    await this.renderer.init();
    if (!this.canvas.isConnected) document.body.appendChild(this.canvas);
    this.watchPixelRatio();
    window.addEventListener('resize', this.onResize);
    this.applySize();
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
    this.renderer.setPixelRatio(this.currentDpr * this.scale);
    this.renderer.setSize(width, height, true);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /** Turns adaptive resolution on or off, and sets the frame-time target. */
  setAdaptive(enabled: boolean, targetFps = 60): void {
    this.adaptive = enabled;
    this.budget = 1 / targetFps;
    if (!enabled) this.setResolutionScale(1);
  }

  setResolutionScale(scale: number): void {
    const next = clamp(scale, MIN_SCALE, 1);
    if (Math.abs(next - this.scale) < 0.005) return;
    this.scale = next;
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

    if (average > this.budget * 1.12) this.setResolutionScale(this.scale - 0.06);
    else if (average < this.budget * 0.82) this.setResolutionScale(this.scale + 0.03);
  }

  get stats(): RendererStats {
    const context = this.renderer.getContext() as { drawingBufferWidth?: number; drawingBufferHeight?: number };
    return {
      drawingBufferWidth: context?.drawingBufferWidth ?? Math.round(window.innerWidth * this.currentDpr * this.scale),
      drawingBufferHeight:
        context?.drawingBufferHeight ?? Math.round(window.innerHeight * this.currentDpr * this.scale),
      devicePixelRatio: this.currentDpr,
      resolutionScale: this.scale,
      backend: (this.renderer.backend as { isWebGPUBackend?: boolean } | undefined)?.isWebGPUBackend
        ? 'webgpu'
        : 'webgl',
    };
  }
}
