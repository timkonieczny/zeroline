import { Renderer } from '@/core/Renderer';
import { Loop } from '@/core/Loop';
import { Input } from '@/core/Input';
import { PostFX, QUALITY_PRESETS, type PostFXQuality } from '@/core/PostFX';
import { MenuStage, type MenuSelection } from '@/menu/MenuStage';
import { RaceStage } from '@/game/RaceStage';
import { TEAMS, type Team } from '@/data/teams';

type Mode = 'menu' | 'race';

/** The menu does not need motion blur or speed streaks; it is not moving fast. */
const MENU_QUALITY: PostFXQuality = {
  antialias: true,
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
  private readonly menu: MenuStage;
  private readonly loop: Loop;

  private menuPost: PostFX | null = null;
  private racePost: PostFX | null = null;
  private race: RaceStage | null = null;
  private mode: Mode = 'menu';
  /** Seconds since the race finished, used to hold the results before returning. */
  private finishedFor = 0;

  private readonly perf: HTMLElement;
  private perfTimer = 0;

  constructor(private readonly onStatus: (text: string) => void) {
    this.menu = new MenuStage(this.pixelRatio());
    this.menu.onStart = (selection) => this.startRace(selection);

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
    this.onStatus('REQUESTING DEVICE');
    await this.renderer.init();

    this.onStatus('BUILDING FRONT END');
    this.menuPost = new PostFX(this.renderer.renderer, this.menu.scene, this.menu.camera, MENU_QUALITY, {
      scene: this.menu.overlay,
      camera: this.menu.overlayCamera,
    });

    document.body.appendChild(this.perf);
    this.input.attach();
    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.onKeyDown);
    this.onResize();

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
      this.onStatus('BUILDING CIRCUIT');
      this.race = new RaceStage(selection.track, this.renderer, setup, this.pixelRatio());
      this.racePost = new PostFX(
        this.renderer.renderer,
        this.race.scene,
        this.renderer.camera,
        QUALITY_PRESETS.high,
        { scene: this.race.hud.scene, camera: this.race.hud.camera },
      );
      this.race.resize(window.innerWidth, window.innerHeight, this.pixelRatio());
    } else {
      this.race.restart(setup);
    }

    this.finishedFor = 0;
    this.mode = 'race';
    this.input.clearMenuActions();
  }

  /** Fills the other seven seats, avoiding a grid of identical craft where possible. */
  private static fillGrid(playerTeamId: string): Team[] {
    const others = TEAMS.filter((team) => team.id !== playerTeamId);
    const grid: Team[] = [];
    for (let i = 0; i < 7; i++) grid.push(others[i % others.length]!);
    return grid;
  }

  private returnToMenu(): void {
    this.mode = 'menu';
    this.input.clearMenuActions();
  }

  private tick(step: number): void {
    if (this.mode !== 'race' || !this.race) return;

    const race = this.race.race;
    this.race.tick(this.input.snapshot, step);

    if (race.finished) {
      this.finishedFor += step;
      // Hold on the result for a few seconds, then hand the player back.
      if (this.finishedFor > 6) this.returnToMenu();
    }
  }

  private render(alpha: number, frameTime: number): void {
    this.input.update(frameTime);

    let action = this.input.nextMenuAction();
    while (action) {
      if (this.mode === 'menu') {
        this.menu.handle(action);
      } else if (action === 'pause' || action === 'back') {
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
      this.racePost.setDrive(player.telemetry.speedFraction, player.state.boost > 0, frameTime);
      this.racePost.render();
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

  dispose(): void {
    this.loop.stop();
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
