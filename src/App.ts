import { Renderer } from '@/core/Renderer';
import { Loop } from '@/core/Loop';
import { Input } from '@/core/Input';
import { PostFX, QUALITY_PRESETS, type PostFXQuality } from '@/core/PostFX';
import { MenuStage, type MenuSelection } from '@/menu/MenuStage';
import { RaceStage } from '@/game/RaceStage';
import { TEAMS, type Team } from '@/data/teams';
import { Audio } from '@/core/Audio';
import { AudioDirector } from '@/game/AudioDirector';
import { loadSettings, saveSettings, type GameSettings } from '@/core/Settings';
import type { OptionRow } from '@/ui/OptionList';
import { loadUiFont } from '@/ui/Fonts';

type Mode = 'menu' | 'race';

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

/** The menu does not need motion blur or speed streaks; it is not moving fast. */
const MENU_QUALITY: PostFXQuality = {
  antialias: 'smaa',
  motionBlur: false,
  motionBlurSamples: 8,
  speedEffects: false,
  bloomStrength: 0.3,
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
  /** True once the classification is animating away and the menu is next. */
  private leavingRace = false;

  private readonly perf: HTMLElement;
  private perfTimer = 0;

  constructor(private readonly onStatus: (text: string) => void) {
    this.settings = loadSettings();
    this.audio.setMix(this.settings.mix);

    this.perf = document.createElement('div');
    this.perf.id = 'perf';
    this.perf.hidden = true;

    this.loop = new Loop(
      (step) => this.tick(step),
      (alpha, frameTime) => this.render(alpha, frameTime),
    );
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

    this.onStatus('Building front end');
    this.menu = new MenuStage(this.pixelRatio(), this.buildSettingRows());
    this.menu.onStart = (selection) => this.startRace(selection);
    this.menu.onSettingChanged = (row) => this.onSettingChanged(row);
    this.menu.attachRenderer(this.renderer.renderer);
    this.menuPost = new PostFX(this.renderer.renderer, this.menu.scene, this.menu.camera, MENU_QUALITY, {
      scene: this.menu.overlay,
      camera: this.menu.overlayCamera,
    });

    document.body.appendChild(this.perf);
    this.input.attach();
    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.onKeyDown);
    this.onResize();

    this.renderer.setAdaptive(this.settings.adaptiveResolution, this.settings.targetFps);
    this.loop.start();
  }

  private readonly onResize = (): void => {
    const ratio = this.pixelRatio();
    this.menu.resize(window.innerWidth, window.innerHeight, ratio);
    this.race?.resize(window.innerWidth, window.innerHeight, ratio);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'F3') {
      event.preventDefault();
      this.perf.hidden = !this.perf.hidden;
    }
  };

  /** Builds the race stage on first use, then reuses it. */
  private startRace(selection: MenuSelection): void {
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
      this.race = new RaceStage(selection.track, this.renderer, setup, this.pixelRatio());
      this.race.resize(window.innerWidth, window.innerHeight, this.pixelRatio());
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
    this.audio.startEngine();
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
    this.mode = 'menu';
    this.leavingRace = false;
    this.input.clearMenuActions();
    this.audio.stopEngine();
  }

  private tick(step: number): void {
    if (this.mode !== 'race' || !this.race) return;

    const race = this.race.race;
    this.race.tick(this.input.snapshot, step);

    if (race.finished) {
      this.finishedFor += step;
      // The world keeps moving underneath — as a looping replay now, not a live
      // race — so there is something to watch while the table is up.
      if (this.finishedFor > RESULTS_HOLD && !this.leavingRace) this.dismissResults();
    }
  }

  private render(alpha: number, frameTime: number): void {
    this.input.update(frameTime);

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
      } else if (action === 'pause' || action === 'back') {
        this.audio.menuBack();
        this.returnToMenu();
      }
      action = this.input.nextMenuAction();
    }

    if (this.mode === 'menu' || !this.race || !this.racePost) {
      this.menu.update(frameTime);
      this.menuPost?.render();
    } else {
      const player = this.race.race.player;
      if (player.telemetry.impact > 0) this.input.rumble(player.telemetry.impact, 140);
      this.race.render(alpha, frameTime, this.input.snapshot.lookBack, this.renderer.camera);
      this.director?.update(frameTime);
      this.racePost.setDrive(player.telemetry.speedFraction, player.state.boost > 0, frameTime);
      this.racePost.render();

      // Only leave once the table has actually finished animating away.
      if (this.leavingRace && this.race.hud.resultsDismissed) this.returnToMenu();
    }

    this.renderer.reportFrame(frameTime);
    this.updatePerf(frameTime);
  }

  private updatePerf(frameTime: number): void {
    if (this.perf.hidden) return;
    this.perfTimer += frameTime;
    if (this.perfTimer < 0.25) return;
    this.perfTimer = 0;

    const stats = this.renderer.stats;
    const info = this.renderer.renderer.info;
    const player = this.race?.race.player;

    this.perf.textContent = [
      `${(1 / Math.max(frameTime, 1e-6)).toFixed(0).padStart(3)} fps   ${(frameTime * 1000).toFixed(2)} ms`,
      `mode       ${this.mode}`,
      `backend    ${stats.backend}`,
      `buffer     ${stats.drawingBufferWidth}x${stats.drawingBufferHeight}`,
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
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKeyDown);
    this.menu.dispose();
    this.race?.dispose();
    this.menuPost?.dispose();
    this.racePost?.dispose();
    this.renderer.dispose();
  }
}
