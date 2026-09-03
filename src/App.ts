import { Quaternion, Vector3 } from 'three';
import { clamp } from '@/core/math';
import { Renderer } from '@/core/Renderer';
import { Loop } from '@/core/Loop';
import { Input } from '@/core/Input';
import { PostFX, QUALITY_PRESETS, type PostFXQuality } from '@/core/PostFX';
import { MenuStage, type MenuSelection } from '@/menu/MenuStage';
import { RaceStage } from '@/game/RaceStage';
import { loadTrack, type LoadedTrack } from '@/track/TrackLoader';
import { TEAMS, type Team } from '@/data/teams';
import { consumeInputEdges } from '@/game/InputSnapshot';
import { Audio } from '@/core/Audio';
import { IS_TOUCH_DEVICE } from '@/core/Platform';
import { Touch, type TouchMode } from '@/core/Touch';
import { AudioDirector } from '@/game/AudioDirector';
import { hasStoredSettings, loadSettings, saveSettings, type GameSettings } from '@/core/Settings';
import type { OptionRow } from '@/ui/OptionList';
import { loadUiFont } from '@/ui/Fonts';
import { loadSkyTexture } from '@/track/scenery/SkyTexture';

type Mode = 'menu' | 'race';

/** Where the camera was before the pipeline warm-up borrowed it. */
const _warmPosition = new Vector3();
const _warmRotation = new Quaternion();

/** Seconds the classification stays up before it dismisses itself. */
const RESULTS_HOLD = 20;
/**
 * Seconds after the flag before a dismissal is accepted.
 *
 * `Space` is both fire and confirm, so without this a shot fired as the line
 * goes by throws the classification away before it has finished arriving.
 */
const RESULTS_GRACE = 0.8;

/**
 * Quality levels in the order the settings row offers them.
 *
 * The row's labels are display strings now, so the index is what maps back to
 * the setting rather than the text.
 */
const QUALITY_ORDER: readonly GameSettings['quality'][] = ['low', 'medium', 'high', 'ultra'];

/**
 * The viewport the interface was drawn for, in logical pixels.
 *
 * Every layout constant in the menu and the HUD was chosen against a desktop
 * window: the menu's detail column starts 544 px in and the longest craft blurb
 * runs about 575 px past it, so the front end wants a little over eleven
 * hundred pixels across. A landscape phone has about eight hundred and fifty.
 */
const REFERENCE_WIDTH = 1120;
const REFERENCE_HEIGHT = 560;
/** Below this the type stops being readable, so the layout is left to crowd. */
const MIN_UI_SCALE = 0.62;

/**
 * How many logical pixels one CSS pixel is worth.
 *
 * Exactly 1 for any window at least the reference size, which is every desktop
 * window worth the name — so this is a no-op on the platform that must not
 * change, and that is the property that makes it the right lever.
 */
function uiScale(width: number, height: number): number {
  return clamp(Math.min(1, width / REFERENCE_WIDTH, height / REFERENCE_HEIGHT), MIN_UI_SCALE, 1);
}

/** Longest the loading screen waits on the driver's compile, in ms. */
const PRECOMPILE_HOLD = 900;

/**
 * The menu does not need motion blur or speed streaks; it is not moving fast.
 *
 * It does get the lens flare, though: the showroom's overhead strips are the
 * brightest things in it, and a hangar full of lights is exactly where a flare
 * earns its keep.
 */
const MENU_QUALITY: PostFXQuality = {
  antialias: 'smaa',
  motionBlur: false,
  motionBlurSamples: 8,
  speedEffects: false,
  bloomStrength: 0.3,
  lensflare: true,
  // No occlusion in the showroom: it is a white room lit by soft boxes, which
  // is the one lighting setup that has almost none to find.
  gtao: false,
};

/**
 * The application: one renderer, one loop, two stages.
 *
 * The menu and the race each own a scene and a post chain, and the app switches
 * which pair is being driven. Building a race stage is expensive — road mesh,
 * collision grid, racing line, skyline — so it is built once for a circuit and
 * only its field is rebuilt between races.
 */
export class App {
  private readonly renderer = new Renderer();
  private readonly input = new Input();
  /**
   * Built in `start`, not in the constructor: every label is rasterised into a
   * canvas at construction, so the typeface has to be loaded first or the whole
   * interface is drawn in the fallback and never redrawn.
   */
  private menu!: MenuStage;
  private readonly loop: Loop;
  private readonly audio = new Audio();
  private readonly settings: GameSettings;
  private director: AudioDirector | null = null;

  private menuPost: PostFX | null = null;
  private racePost: PostFX | null = null;
  /** The live race stage, exposed so a dev console can inspect it. */
  race: RaceStage | null = null;
  private mode: Mode = 'menu';
  /** Seconds since the race finished, used to hold the classification up. */
  private finishedFor = 0;
  /** Held so its choices can be rebuilt when the window changes. */
  private resolutionRow: OptionRow | null = null;
  /** True while the curtain is down, which suspends input and the sim. */
  private transitioning = false;
  /** True while the pause panel is up. */
  private paused = false;
  /** The phone's thumbs and tilt, or null on a desktop. */
  private touch: Touch | null = null;
  private fullscreenButton: HTMLButtonElement | null = null;
  private readonly motionGate = document.getElementById('motion');
  private readonly curtain = document.getElementById('curtain');
  private readonly curtainStatus = document.getElementById('curtain-status');
  /** True once the classification is animating away and the menu is next. */
  private leavingRace = false;

  private readonly perf: HTMLElement;
  private perfTimer = 0;

  /** What the last layout was built for, so an unchanged resize costs nothing. */
  private laidOutWidth = 0;
  private laidOutHeight = 0;
  private laidOutRatio = 0;
  /** Logical pixels per CSS pixel. 1 on any desktop window. */
  private uiScale = 1;
  /** True while the phone is the wrong way round and the card is over the game. */
  private portrait = false;
  /** True once the frame loop owns the renderer. */
  private running = false;

  constructor(private readonly onStatus: (text: string) => void) {
    this.settings = loadSettings();
    if (IS_TOUCH_DEVICE) this.seedPhoneDefaults();
    this.audio.setMix(this.settings.mix);

    this.perf = document.createElement('div');
    this.perf.id = 'perf';
    this.perf.hidden = true;

    this.loop = new Loop(
      (step) => this.tick(step),
      (alpha, frameTime) => this.render(alpha, frameTime),
    );
  }

  /**
   * What a phone should be running at until it says otherwise.
   *
   * Native density is the wrong default here and it is not close: a Pixel 8 in
   * landscape is 864 by 327 at a device ratio of 2.625, so "1" means two and a
   * quarter million pixels through the whole post chain — more than the desktop
   * this was tuned on renders at its *lowest* rung.
   *
   * Applied even over stored settings, but only where the stored value is the
   * default. Nobody on a phone chose native; they were handed it, and the
   * Resolution row is right there for anyone who disagrees.
   *
   * Adaptive resolution stays off deliberately. Every step it takes calls
   * `setSize`, which reallocates the backbuffer and every render target behind
   * it, and its 0.06-down / 0.03-up steps hunt rather than settle.
   */
  private seedPhoneDefaults(): void {
    const fresh = !hasStoredSettings();
    if (fresh) {
      this.settings.quality = 'low';
      this.settings.antialias = 'none';
    }
    if (fresh || this.settings.resolutionScale >= 1) {
      const density = window.devicePixelRatio || 1;
      this.settings.resolutionScale = density > 1.05 ? 1 / density : 0.6;
    }
    saveSettings(this.settings);
  }

  /**
   * The window as the overlays are laid out in, from the window as it is.
   *
   * Every stage has to be sized from this one set of numbers. A stage sized
   * from the window's own pixels lays itself out in a coordinate system that
   * `onTouchTap` does not convert taps into, and a HUD whose touch boxes are
   * built against the wrong scale is a set of buttons that are not where they
   * are drawn.
   */
  private static logicalViewport(
    width: number,
    height: number,
    ratio: number,
  ): { width: number; height: number; ratio: number; scale: number } {
    const scale = uiScale(width, height);
    // Rasterising at `ratio * scale` keeps every glyph exactly as sharp as it
    // was: a label covering fewer real pixels is drawn into fewer real pixels.
    return { width: width / scale, height: height / scale, ratio: Math.min(2.5, ratio * scale), scale };
  }

  private pixelRatio(): number {
    // Text is rasterised at device pixels, capped so a 3x phone-class display
    // does not quietly allocate nine times the canvas area for a label.
    return Math.min(2.5, window.devicePixelRatio || 1);
  }

  async start(): Promise<void> {
    this.onStatus('Requesting device');
    await this.renderer.init();

    this.onStatus('Loading typeface');
    await loadUiFont();

    // Awaited here rather than lazily on the first race, so the circuit is
    // never built against a missing sky and then quietly relit afterwards.
    this.onStatus('Loading sky');
    await loadSkyTexture().catch(() => null);

    // Before the settings rows are built: they seed the resolution row's index
    // from the renderer's current ceiling, which is still 1 until this runs.
    this.renderer.setBaseScale(this.settings.resolutionScale);

    this.onStatus('Building front end');
    this.menu = new MenuStage(this.pixelRatio(), this.buildSettingRows());
    this.menu.onStart = (selection) => {
      void this.behindCurtain('Building circuit', async () => {
        // Only the first race pays for this; after that the stage is reused
        // and `startRace` just restarts it.
        const loaded = this.race ? undefined : await loadTrack(selection.track);
        this.startRace(selection, loaded);
        await this.warmPipelines();
      });
    };
    this.menu.onSettingChanged = (row) => this.onSettingChanged(row);
    this.menu.attachRenderer(this.renderer.renderer);
    this.menuPost = new PostFX(this.renderer.renderer, this.menu.scene, this.menu.camera, MENU_QUALITY, {
      scene: this.menu.overlay,
      camera: this.menu.overlayCamera,
    });

    document.body.appendChild(this.perf);
    // A phone has no F3. `?perf=1` is the way in, and it is worth having: the
    // sizes on this overlay are the first thing to read when the frame has a
    // hole in it, and asking somebody to attach a debugger to a handset is a
    // long way round.
    if (new URLSearchParams(window.location.search).get('perf') === '1') this.perf.hidden = false;
    this.input.attach();
    this.attachTouch();
    this.watchOrientation();
    // Not a second `resize` listener: the renderer owns the one measurement,
    // and calls back once it has resized the backbuffer to it. Two listeners
    // measured the same event twice, at different instants, and could size the
    // canvas and the overlays from different numbers.
    this.renderer.onViewportChange = this.onResize;
    window.addEventListener('keydown', this.onKeyDown);
    this.onResize();

    this.renderer.setAdaptive(this.settings.adaptiveResolution, this.settings.targetFps);
    this.running = true;
    this.loop.start();
  }

  private readonly onResize = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const ratio = this.pixelRatio();

    // iOS fires `resize` on every rotation and on every show and hide of the
    // URL bar, and each one below re-rasterises every label in the menu and the
    // HUD. Most of that storm ends exactly where it started.
    if (width === this.laidOutWidth && height === this.laidOutHeight && ratio === this.laidOutRatio) {
      return;
    }
    this.laidOutWidth = width;
    this.laidOutHeight = height;
    this.laidOutRatio = ratio;

    // The interface is authored against a desktop window and a phone is not
    // one, so it is handed *more logical pixels* rather than being squeezed:
    // the layout is unchanged and the camera covers more of it.
    const view = App.logicalViewport(width, height, ratio);

    this.menu.resize(view.width, view.height, view.ratio);
    this.race?.resize(view.width, view.height, view.ratio, view.scale);
    this.uiScale = view.scale;

    // The resolution row's choices are the window's own sizes, so they are
    // wrong the moment the window is not that size any more.
    this.refreshResolutionRow();

    // And draw one frame at the new size straight away.
    //
    // Resizing the backbuffer clears it, and the loop's own frame for this tick
    // may already have gone — so without this the newly exposed part of the
    // canvas is the clear colour until the next one. On a desktop that is a
    // frame nobody catches. On a phone, where the URL bar slides in and out
    // while you play, it is a black rectangle that comes and goes.
    //
    // Only once the loop is running. The first call to this happens during
    // `start`, where the chain has never been compiled and drawing it here
    // would move that whole cost in front of the boot card rather than behind
    // the first frame.
    if (this.running && !this.portrait) {
      if (this.mode === 'menu') this.menuPost?.render();
      else this.racePost?.render();
    }
  };

  /** Rebuilds the resolution row's choices from the window as it is now. */
  private refreshResolutionRow(): void {
    if (!this.resolutionRow) return;
    const ladder = this.renderer.ladder();
    this.resolutionRow.choices = ladder.map((rung) => rung.label);
    this.resolutionRow.index = this.renderer.currentRung();
    this.menu?.updateSettingRow(this.resolutionRow);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'F3') {
      event.preventDefault();
      this.perf.hidden = !this.perf.hidden;
    }
  };

  /** Builds the race stage on first use, then reuses it. */
  /**
   * Drops the curtain, does the work, and lifts it again.
   *
   * The work is synchronous and slow — building a circuit is tens of
   * milliseconds of mesh generation and a racing-line relaxation on top — so it
   * has to happen with the overlay already painted. Two animation frames is
   * what that costs: one for the class change to take effect and one for the
   * compositor to show it.
   */
  private async behindCurtain(label: string, work: () => void | Promise<void>): Promise<void> {
    this.transitioning = true;
    if (this.curtainStatus) this.curtainStatus.textContent = label;
    this.curtain?.classList.remove('hidden');

    await App.nextFrame();
    await App.nextFrame();
    // And a beat longer, so the fade in is seen rather than skipped over.
    await new Promise((resolve) => window.setTimeout(resolve, 260));

    await work();

    // One more frame so the first frame of the new scene is on screen before
    // the curtain starts to lift, rather than a stale one from behind it.
    await App.nextFrame();
    await App.nextFrame();
    this.curtain?.classList.add('hidden');
    this.transitioning = false;
    this.input.clearMenuActions();
  }

  /**
   * One animation frame, or a tenth of a second, whichever comes first.
   *
   * A backgrounded tab can go a long time between animation frames, and the
   * curtain must not be able to strand the game behind it waiting for one.
   */
  private static nextFrame(): Promise<unknown> {
    return Promise.race([
      new Promise(requestAnimationFrame),
      new Promise((resolve) => window.setTimeout(resolve, 100)),
    ]);
  }

  private startRace(selection: MenuSelection, loaded?: LoadedTrack): void {
    const setup = {
      mode: selection.mode,
      speedClass: selection.speedClass,
      playerTeam: selection.team,
      fieldTeams: App.fillGrid(selection.team.id),
      laps: selection.track.laps,
      seed: (Date.now() & 0xffff) ^ 0x2e01,
    };

    if (!this.race) {
      this.onStatus('Building circuit');
      this.race = new RaceStage(selection.track, this.renderer, setup, this.pixelRatio(), loaded);
      // `onResize` will not fire again just because a race started, so this is
      // the layout the HUD keeps for the whole race unless the window moves.
      const view = App.logicalViewport(window.innerWidth, window.innerHeight, this.pixelRatio());
      this.race.resize(view.width, view.height, view.ratio, view.scale);
    } else {
      this.race.restart(setup);
    }

    // Rebuilt when missing, which is also how a graphics-quality change is
    // picked up: the chain is compiled once, so it is thrown away rather than
    // reconfigured.
    if (!this.racePost) {
      this.racePost = new PostFX(
        this.renderer.renderer,
        this.race.scene,
        this.renderer.camera,
        { ...QUALITY_PRESETS[this.settings.quality], antialias: this.settings.antialias },
        { scene: this.race.hud.scene, camera: this.race.hud.camera },
      );
    }

    this.finishedFor = 0;
    this.leavingRace = false;
    this.mode = 'race';
    this.input.clearMenuActions();

    if (this.director) this.director.attach(this.race.race);
    else this.director = new AudioDirector(this.audio, this.race.race);
    this.director.setStands(this.race.grandstands.sites);
    this.audio.startEngine();
    this.audio.startCrowd();
  }

  /**
   * Compiles every pipeline the race needs while the curtain is still down.
   *
   * This is the part of a load that is not in the profile and is bigger than
   * all of it: a material's shader is not built until something is drawn with
   * it, so without this the first seconds of a race compile the road, then the
   * barriers, then the first craft to come into view, one hitch at a time. It
   * is also the only piece of the load that has to be on the main thread and
   * cannot be made to go faster — so the least it can do is happen behind the
   * curtain, where nobody is watching.
   *
   * The post chain's own passes are warmed by rendering one frame through it,
   * which `compileAsync` on the scene alone does not cover.
   */
  private async warmPipelines(): Promise<void> {
    if (!this.race || !this.racePost) return;
    if (this.curtainStatus) this.curtainStatus.textContent = 'Compiling shaders';

    // Kicked off and raced against a deadline, not simply awaited.
    //
    // `compileAsync` hands off to the driver and resolves when the driver feels
    // like it; waiting on that alone puts the loading screen at the mercy of
    // something with no upper bound. So it gets the hold and no more. Anything
    // still uncompiled compiles when it is first drawn, which is exactly the
    // behaviour this replaces — the difference is that most of it is done.
    const compiled = this.renderer.renderer
      .compileAsync(this.race.scene, this.renderer.camera)
      .catch(() => undefined);
    await Promise.race([compiled, App.wait(PRECOMPILE_HOLD)]);

    // And then draw a frame from each shot the intro will cut to.
    //
    // Compiling a material is not the same as having drawn with it. Every pass
    // the frame is made of — the shadow map, the water's own reflection of the
    // scene, the post chain reading a depth buffer it has not seen this shape
    // of — builds its state the first time it is asked for, and a camera that
    // teleports across the circuit asks for all of it at once. That is the
    // second-long stall on each cut. Paying it here costs three frames behind a
    // curtain that is already up.
    const camera = this.renderer.camera;
    _warmPosition.copy(camera.position);
    _warmRotation.copy(camera.quaternion);

    for (let shot = 0; shot < this.race.introShots; shot++) {
      this.race.previewIntroShot(shot, camera);
      this.racePost.render();
      await App.nextFrame();
    }

    camera.position.copy(_warmPosition);
    camera.quaternion.copy(_warmRotation);
  }

  private static wait(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  /** Fills the other seven seats, avoiding a grid of identical craft where possible. */
  private static fillGrid(playerTeamId: string): Team[] {
    const others = TEAMS.filter((team) => team.id !== playerTeamId);
    const grid: Team[] = [];
    for (let i = 0; i < 7; i++) grid.push(others[i % others.length]!);
    return grid;
  }

  /** Plays the classification out, then hands the player back to the menu. */
  private dismissResults(): void {
    if (this.leavingRace || !this.race) return;
    this.leavingRace = true;
    this.race.hud.hideResults();
  }

  private returnToMenu(): void {
    if (this.transitioning) return;
    void this.behindCurtain('Returning to the hangar', () => {
      this.mode = 'menu';
      this.leavingRace = false;
      this.race?.hud.pause.hide();
      this.paused = false;
      this.input.clearMenuActions();
      this.audio.stopEngine();
      this.audio.stopCrowd();
    });
  }

  private tick(step: number): void {
    if (this.portrait) return;
    if (this.mode !== 'race' || !this.race) return;
    // Frozen, not slowed: the simulation is deterministic and stepping it at
    // all while nobody is driving would put the field somewhere the player
    // did not leave it. The intro is the same case — the countdown waits for
    // the camera, so a shot of the circuit is a shot of the circuit and not of
    // a race quietly getting under way behind it.
    if (this.paused || this.transitioning || this.race.introducing) return;

    const race = this.race.race;
    this.race.tick(this.input.snapshot, step);
    // One tick got the edges; the other five in this frame must not.
    consumeInputEdges(this.input.snapshot);

    if (race.finished) {
      this.finishedFor += step;
      // The world keeps moving underneath — as a looping replay now, not a live
      // race — so there is something to watch while the table is up.
      if (this.finishedFor > RESULTS_HOLD && !this.leavingRace) this.dismissResults();
    }
  }

  private render(alpha: number, frameTime: number): void {
    // Nothing to draw behind an opaque card, and no GPU work worth doing.
    if (this.portrait) return;

    // Explicitly, rather than relying on three's own animation loop to do it.
    // That loop is started unconditionally by `renderer.init()` and does reset
    // the counters every frame, so the overlay's figures were already per-frame
    // and not session totals — but the game never asked for that loop and does
    // not drive its rendering from it, so leaning on its bookkeeping is a
    // dependency waiting to be surprised by.
    this.renderer.renderer.info.reset();
    this.armTouch();
    this.touch?.update(frameTime);
    this.input.update(frameTime);

    if (this.transitioning) this.input.clearMenuActions();

    let action = this.input.nextMenuAction();
    while (action) {
      // The first input of the session is also the gesture that lets the audio
      // context start; browsers will not allow it any earlier.
      void this.audio.resume().then(() => this.audio.startAmbience());

      if (this.mode === 'menu') {
        if (action === 'confirm') this.audio.menuConfirm();
        else if (action === 'back') this.audio.menuBack();
        else this.audio.menuMove();
        this.menu.handle(action);
      } else if (this.race?.race.finished) {
        // Tab or H tucks the classification away so the replay can be watched,
        // and brings it back.
        if (action === 'toggle') {
          this.audio.menuMove();
          this.race.hud.toggleResults();
        } else if (
          this.finishedFor > RESULTS_GRACE &&
          (action === 'confirm' || action === 'back' || action === 'pause')
        ) {
          // Any of confirm, back or pause takes it away for good, once it has
          // had a moment to arrive.
          this.audio.menuConfirm();
          this.dismissResults();
        }
      } else if (this.race?.introducing) {
        // Any of the menu keys cuts the intro short. It is three seconds a shot
        // and nobody wants to sit through it on the twentieth attempt at a lap.
        if (action === 'confirm' || action === 'back' || action === 'pause') {
          this.audio.menuConfirm();
          this.race.skipIntro();
        }
      } else if (this.paused) {
        const choice = this.race?.hud.pause.handle(action) ?? null;
        if (action === 'up' || action === 'down') this.audio.menuMove();
        if (choice === 'resume') {
          this.audio.menuBack();
          this.race?.hud.pause.hide();
          this.paused = false;
        } else if (choice === 'quit') {
          this.audio.menuConfirm();
          this.returnToMenu();
        }
      } else if (action === 'pause' || action === 'back') {
        this.audio.menuBack();
        this.race?.hud.pause.show();
        this.paused = true;
      }
      action = this.input.nextMenuAction();
    }

    if (this.mode === 'menu' || !this.race || !this.racePost) {
      this.menu.update(frameTime);
      this.menuPost?.render();
    } else {
      const player = this.race.race.player;
      if (player.telemetry.impact > 0) this.input.rumble(player.telemetry.impact, 140);
      // The panel still animates while the world is held, so the render step is
      // passed through even when the simulation is not — but not behind the
      // curtain. That is a second of real time with nobody watching, and the
      // intro was spending it: by the time the curtain lifted, a third of the
      // first establishing shot had already been played to an empty room.
      this.race.render(
        alpha,
        this.paused || this.transitioning ? 0 : frameTime,
        this.input.snapshot.lookBack,
        this.renderer.camera,
        this.transitioning ? 0 : frameTime,
      );
      // The world is held but the loop is not, so the engine would otherwise
      // keep sounding whatever speed the craft stopped at.
      this.audio.setEngineMuted(this.paused);
      this.director?.update(frameTime);
      this.racePost.setDrive(
        player.telemetry.speedFraction,
        player.state.boost > 0,
        frameTime,
        this.race.track.isInTunnel(player.state.s),
      );
      this.racePost.render();

      // Only leave once the table has actually finished animating away.
      if (this.leavingRace && this.race.hud.resultsDismissed) this.returnToMenu();
    }

    this.renderer.reportFrame(frameTime);
    this.updatePerf(frameTime);
  }

  private updatePerf(frameTime: number): void {
    this.perfTimer += frameTime;
    if (this.perfTimer < 0.25) return;
    this.perfTimer = 0;

    // Drained whether or not the overlay is up: at twenty-odd passes a frame
    // the pool's two thousand queries last about half a second, after which it
    // stops recording until someone empties it. A quarter-second tick keeps
    // comfortably ahead of that.
    const gpuMs = this.renderer.gpuTime();
    if (this.perf.hidden) return;

    const stats = this.renderer.stats;
    const info = this.renderer.renderer.info;
    const player = this.race?.race.player;

    this.perf.textContent = [
      `${(1 / Math.max(frameTime, 1e-6)).toFixed(0).padStart(3)} fps   ${(frameTime * 1000).toFixed(2)} ms`,
      `gpu        ${gpuMs.toFixed(2)} ms`,
      `mode       ${this.mode}`,
      `backend    ${stats.backend}`,
      `adapter    ${stats.adapter}`,
      `buffer     ${stats.drawingBufferWidth}x${stats.drawingBufferHeight}`,
      // The comparison that matters when part of the frame comes out black: a
      // canvas whose CSS box is wider than what was rendered into it shows the
      // clear colour in the difference, and the clear colour here is black.
      `window     ${window.innerWidth}x${window.innerHeight}`,
      `canvas     ${this.renderer.canvas.clientWidth}x${this.renderer.canvas.clientHeight}`,
      `dpr        ${stats.devicePixelRatio.toFixed(2)}  scale ${stats.resolutionScale.toFixed(2)}`,
      `draws      ${info.render.drawCalls}   tris ${info.render.triangles.toLocaleString()}`,
      `sim ticks  ${this.loop.ticksLastFrame}`,
      player ? `speed      ${(player.telemetry.speed * 3.6).toFixed(0)} km/h` : '',
      player ? `shield     ${(player.shieldFraction * 100).toFixed(0)}%` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** The settings screen's rows, seeded from what was last saved. */
  /** Builds the phone's input layer, on a phone. */
  private attachTouch(): void {
    if (!IS_TOUCH_DEVICE) return;

    this.touch = new Touch({
      target: this.renderer.canvas,
      input: this.input,
      onFirstGesture: () => this.onFirstGesture(),
      onTap: (x, y) => this.onTouchTap(x, y),
      regions: () => this.race?.hud.touchRegions ?? [],
      setPressed: (id, pressed) => this.race?.hud.setTouchPressed(id, pressed),
    });
    this.touch.attach();

    this.setupFullscreen();
    this.setupMotionGate();
  }

  /**
   * The one place iOS will grant anything.
   *
   * Both of these have to happen inside the gesture's own call stack. The
   * action loop's `audio.resume()` runs in a frame callback, which Safari
   * refuses — so on a phone this is what actually unlocks the sound.
   */
  private onFirstGesture(): void {
    void this.audio.resume().then(() => this.audio.startAmbience());
    this.touch?.requestMotion();
  }

  /** A tap that no race control claimed, in CSS pixels from the top left. */
  private onTouchTap(x: number, y: number): void {
    // The action loop already throws queued actions away behind the curtain,
    // and a tap dispatched straight at the menu would walk through that guard.
    if (this.transitioning) return;

    // Both overlays put the origin at the bottom left, and both work in the
    // logical pixels the scale handed them rather than in the screen's own.
    const overlayX = x / this.uiScale;
    const overlayY = (window.innerHeight - y) / this.uiScale;

    if (this.mode === 'menu') {
      this.menu.tap(overlayX, overlayY);
      return;
    }
    if (this.paused) {
      const choice = this.race?.hud.pause.tap(overlayX, overlayY) ?? null;
      if (choice === 'resume') {
        this.audio.menuBack();
        this.race?.hud.pause.hide();
        this.paused = false;
      } else if (choice === 'quit') {
        this.audio.menuConfirm();
        this.returnToMenu();
      }
      return;
    }
    if (this.race?.race.finished) {
      if (this.finishedFor > RESULTS_GRACE) this.input.pushMenuAction('confirm');
      return;
    }
    if (this.race?.introducing) this.input.pushMenuAction('confirm');
  }

  /**
   * Points the touch layer at whatever surface is in front of the player.
   *
   * A change releases every held finger: a thumb still on the brake when the
   * pause panel opens must not still be braking when it closes.
   */
  private armTouch(): void {
    const touch = this.touch;
    if (!touch) return;

    const racing = this.mode === 'race' && !!this.race && !this.paused && !this.race.race.finished;
    const next: TouchMode = this.transitioning
      ? 'held'
      : racing && !this.race?.introducing
        ? 'race'
        : this.mode === 'menu'
          ? 'menu'
          : 'held';

    if (next !== touch.mode) {
      touch.releaseAll();
      // The lights are the moment the phone is settled in the player's hands,
      // and the last moment before any of this matters.
      if (next === 'race') touch.recentre();
      touch.mode = next;
    }

    touch.launching = this.race?.race.phase === 'countdown';

    // No motion, no steering. The card is up and nothing is driving until it
    // is granted — which is the choice that was made over a touch fallback.
    this.showFullscreenButton();

    const blocked = touch.motion === 'denied' || touch.motion === 'unavailable';
    this.gate(this.motionGate, blocked);
    if (blocked) touch.mode = 'held';
  }

  /**
   * Holds the game while the phone is upright.
   *
   * The card itself is pure CSS, so it is right on the first paint and cannot
   * fall out of step with the real orientation. This is only the other half:
   * rendering WebGPU frames nobody can see is the one place on a phone where
   * the battery is genuinely worth saving. Kept separate deliberately — if this
   * listener ever fails, it costs power rather than correctness.
   */
  private watchOrientation(): void {
    if (!IS_TOUCH_DEVICE) return;

    const query = window.matchMedia('(orientation: portrait)');
    const apply = (): void => {
      this.portrait = query.matches;
      if (this.portrait) this.audio.setEngineMuted(true);
    };
    query.addEventListener('change', apply);
    apply();
  }

  /** The two buttons on the motion card, which must ask from a real gesture. */
  private setupMotionGate(): void {
    document.getElementById('motion-retry')?.addEventListener('click', () => {
      this.touch?.requestMotion();
    });
    document.getElementById('motion-reload')?.addEventListener('click', () => {
      window.location.reload();
    });
  }

  /** Shows or hides one of the shell's full-frame cards. */
  private gate(element: HTMLElement | null, shown: boolean): void {
    element?.classList.toggle('hidden', !shown);
  }

  /**
   * The fullscreen control.
   *
   * A DOM button rather than something in the overlay, because it has to work
   * before a race exists and it is chrome rather than game. iPhone Safari does
   * not implement the Fullscreen API at all, so where it is missing the button
   * says the one thing that does work there instead.
   */
  private setupFullscreen(): void {
    const button = document.getElementById('fullscreen') as HTMLButtonElement | null;
    if (!button) return;

    const supported = typeof document.documentElement.requestFullscreen === 'function';
    button.hidden = false;
    button.textContent = supported ? 'Fullscreen' : 'Add to Home Screen';
    button.disabled = !supported;

    if (supported) {
      button.addEventListener('click', () => {
        void document.documentElement
          .requestFullscreen()
          // Only Chromium honours this, and only once the document is already
          // fullscreen — which is why it is chained rather than called on its
          // own. WebKit has no `lock` at all, so the rejection is expected.
          .then(() => {
            const orientation = screen.orientation as ScreenOrientation & {
              lock?: (to: string) => Promise<void>;
            };
            return orientation?.lock?.('landscape');
          })
          .catch(() => undefined);
      });
      document.addEventListener('fullscreenchange', () => this.showFullscreenButton());
    }
    this.fullscreenButton = button;
  }

  /** The control belongs to the hangar. A race has its own corners spoken for. */
  private showFullscreenButton(): void {
    const button = this.fullscreenButton;
    if (!button) return;
    button.hidden = document.fullscreenElement !== null || this.mode !== 'menu';
  }

  private buildSettingRows(): OptionRow[] {
    const qualities = ['Low', 'Medium', 'High', 'Ultra'];
    // Percentages in tens: fine enough to be useful, coarse enough to reach the
    // end of the range in a couple of presses.
    const volumes = Array.from({ length: 11 }, (_, i) => `${i * 10}%`);
    const volumeIndex = (value: number): number => Math.round(value * 10);

    return [
      {
        label: 'Graphics',
        choices: qualities,
        index: Math.max(0, QUALITY_ORDER.indexOf(this.settings.quality)),
      },
      (this.resolutionRow = {
        label: 'Resolution',
        choices: this.renderer.ladder().map((rung) => rung.label),
        index: this.renderer.currentRung(),
      }),
      {
        label: 'Antialiasing',
        // SMAA stays shouted: it is an acronym, not a word.
        choices: ['Off', 'SMAA', 'Temporal'],
        index: this.settings.antialias === 'none' ? 0 : this.settings.antialias === 'smaa' ? 1 : 2,
      },
      { label: 'Adaptive resolution', choices: ['Off', 'On'], index: this.settings.adaptiveResolution ? 1 : 0 },
      { label: 'Frame target', choices: ['60 fps', '120 fps'], index: this.settings.targetFps === 120 ? 1 : 0 },
      { label: 'Master volume', choices: volumes, index: volumeIndex(this.settings.mix.master) },
      { label: 'Effects volume', choices: volumes, index: volumeIndex(this.settings.mix.effects) },
      { label: 'Music volume', choices: volumes, index: volumeIndex(this.settings.mix.music) },
    ];
  }

  private onSettingChanged(row: OptionRow): void {
    const value = row.choices[row.index] ?? '';
    switch (row.label) {
      case 'Graphics':
        // The post chain is compiled at construction, so a quality change takes
        // effect on the next race rather than mid-frame.
        this.applySettings({ quality: QUALITY_ORDER[row.index] ?? 'high' });
        this.racePost?.dispose();
        this.racePost = null;
        break;
      case 'Antialiasing':
        // Compiled into the chain, so it takes effect on the next race.
        this.applySettings({ antialias: row.index === 0 ? 'none' : row.index === 1 ? 'smaa' : 'traa' });
        this.racePost?.dispose();
        this.racePost = null;
        break;
      case 'Adaptive resolution':
        this.applySettings({ adaptiveResolution: value === 'On' });
        break;
      case 'Frame target':
        this.applySettings({ targetFps: value === '120 fps' ? 120 : 60 });
        break;
      case 'Master volume':
        this.applySettings({ mix: { ...this.settings.mix, master: row.index / 10 } });
        break;
      case 'Effects volume':
        this.applySettings({ mix: { ...this.settings.mix, effects: row.index / 10 } });
        break;
      case 'Resolution': {
        const rung = this.renderer.ladder()[row.index];
        if (rung) {
          this.renderer.setBaseScale(rung.scale);
          this.applySettings({ resolutionScale: rung.scale });
        }
        break;
      }
      case 'Music volume':
        this.applySettings({ mix: { ...this.settings.mix, music: row.index / 10 } });
        break;
    }
  }

  /** Applies and persists a settings change. */
  applySettings(change: Partial<GameSettings>): void {
    Object.assign(this.settings, change);
    if (change.mix) this.audio.setMix(this.settings.mix);
    if (change.adaptiveResolution !== undefined || change.targetFps !== undefined) {
      this.renderer.setAdaptive(this.settings.adaptiveResolution, this.settings.targetFps);
    }
    saveSettings(this.settings);
  }

  dispose(): void {
    this.loop.stop();
    this.audio.dispose();
    this.input.detach();
    this.renderer.onViewportChange = null;
    window.removeEventListener('keydown', this.onKeyDown);
    this.menu.dispose();
    this.race?.dispose();
    this.menuPost?.dispose();
    this.racePost?.dispose();
    this.renderer.dispose();
  }
}
