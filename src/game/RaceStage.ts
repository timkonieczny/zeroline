import { Quaternion, Scene, Vector3, type Object3D, type PerspectiveCamera } from 'three';
import { Track } from '@/track/Track';
import type { LoadedTrack } from '@/track/TrackLoader';
import { TrackMesh } from '@/track/TrackMesh';
import { Environment } from '@/track/scenery/Environment';
import { Skyline } from '@/track/scenery/Skyline';
import { SkyHighway } from '@/track/scenery/SkyHighway';
import { TrackPillars } from '@/track/scenery/TrackPillars';
import { Grandstands } from '@/track/scenery/Grandstands';
import { StartLine } from '@/track/scenery/StartLine';
import { TrackMarkings } from '@/track/scenery/TrackMarkings';
import { TunnelGlass } from '@/track/scenery/TunnelGlass';
import type { TrackDefinition } from '@/track/TrackTypes';
import { COUNTDOWN, Race, type RaceSetup } from './Race';
import { GliderModel } from './GliderModel';
import { WeaponVisuals } from './weapons/WeaponVisuals';
import { Sparks } from './Sparks';
import { ChaseCamera } from './ChaseCamera';
import { RaceIntro } from './RaceIntro';
import { Hud } from './Hud';
import { Replay } from './Replay';
import { createInputSnapshot } from './InputSnapshot';
import type { Craft } from './Craft';
import type { Renderer } from '@/core/Renderer';
import { clamp01 } from '@/core/math';
import { advanceSimTime } from '@/core/Clock';

const _position = new Vector3();
const _rotation = new Quaternion();
/** Simulated seconds allowed for the rest of the field to take the flag. */
const SETTLE_LIMIT = 90;
const SETTLE_STEP = 1 / 120;
const _idle = createInputSnapshot();

/**
 * Everything needed to run a race on one circuit: the world, the field and the
 * HUD.
 *
 * The heavy work — building the road mesh, the collision grid, the racing line
 * and the scenery — happens once per circuit in the constructor. Starting a new
 * race only rebuilds the field, which is why restarting is instant.
 */
export class RaceStage {
  readonly scene = new Scene();
  readonly track: Track;
  readonly hud: Hud;
  readonly chase = new ChaseCamera();

  race: Race;
  /** The race as it happened, played back on a loop once the flag is out. */
  readonly replay: Replay;
  /** Seconds into the looping replay, or -1 while the race is still live. */
  private replayTime = -1;
  /** True once the rest of the field has been run to the flag. */
  private settled = false;

  private readonly trackMesh: TrackMesh;
  private readonly environment: Environment;
  private readonly skyline: Skyline;
  private readonly highway: SkyHighway;
  private readonly pillars: TrackPillars;
  readonly grandstands: Grandstands;
  private readonly startLine: StartLine;
  private readonly markings: TrackMarkings;
  private readonly tunnelGlass: TunnelGlass;
  private readonly ordnance = new WeaponVisuals();
  private readonly sparks = new Sparks();
  /** The shots before the lights, or null once they are done. */
  private intro: RaceIntro | null = null;
  private readonly models = new Map<Craft, GliderModel>();

  /**
   * @param loaded The circuit's arithmetic, already done — usually in a worker.
   *   Everything from here on is materials, meshes and scene graph, which is
   *   main-thread work by definition.
   */
  constructor(
    definition: TrackDefinition,
    renderer: Renderer,
    setup: Omit<RaceSetup, 'track'>,
    pixelRatio: number,
    loaded?: LoadedTrack,
  ) {
    this.track = loaded?.track ?? new Track(definition);

    this.trackMesh = new TrackMesh(this.track, loaded?.geometry);
    this.scene.add(this.trackMesh.group);

    this.environment = new Environment(this.track, loaded?.waterNormals);
    this.environment.applyTo(this.scene, renderer.renderer);

    // Before the skyline, which is then told to build around them.
    this.grandstands = new Grandstands(this.track);
    this.scene.add(this.grandstands.group);

    this.skyline = new Skyline(this.track, this.grandstands.footprints);
    this.scene.add(this.skyline.group);

    this.highway = new SkyHighway(this.track);
    this.scene.add(this.highway.group);

    this.pillars = new TrackPillars(this.track);
    this.scene.add(this.pillars.group);

    this.startLine = new StartLine(this.track);
    this.scene.add(this.startLine.group);

    this.markings = new TrackMarkings(this.track);
    this.scene.add(this.markings.group);

    this.tunnelGlass = new TunnelGlass(this.track);
    this.scene.add(this.tunnelGlass.group);

    this.scene.add(this.ordnance.group);
    this.scene.add(this.sparks.group);

    this.race = new Race({ ...setup, track: this.track });
    this.intro = new RaceIntro(this.track, this.track.startS);
    this.hud = new Hud(pixelRatio, this.track, this.race.craft.length);
    this.replay = new Replay(this.race.craft.length);
    this.buildField();
  }

  /** Tears down the current field and starts a fresh race. */
  restart(setup: Omit<RaceSetup, 'track'>): void {
    for (const model of this.models.values()) {
      this.scene.remove(model.object);
      model.dispose();
    }
    this.models.clear();
    this.race = new Race({ ...setup, track: this.track });
    this.replay.reset();
    this.replayTime = -1;
    this.settled = false;
    this.buildField();
    this.chase.reset();
    this.intro = new RaceIntro(this.track, this.track.startS);
    this.hud.resetResults();
  }

  private buildField(): void {
    for (const craft of this.race.craft) {
      const model = new GliderModel(craft.team);
      this.models.set(craft, model);
      this.scene.add(model.object);
    }
  }

  /** True once the race is over and the world is showing a replay. */
  get replaying(): boolean {
    return this.replayTime >= 0;
  }

  /**
   * Advances the world by one tick.
   *
   * While the race is live this drives the simulation and records it. Once the
   * flag is out the simulation stops entirely — the controls go dead and the
   * classification's numbers stop moving — and the recording plays back on a
   * loop underneath instead.
   */
  tick(input: Parameters<Race['tick']>[0], dt: number): void {
    if (this.race.finished && !this.replay.isEmpty) {
      if (!this.settled) this.settleField();
      if (this.replayTime < 0) this.replayTime = 0;
      const duration = this.replay.duration;
      this.replayTime = duration > 0 ? (this.replayTime + dt) % duration : 0;
      this.replay.apply(this.replayTime, this.race.craft);
      return;
    }

    this.race.tick(input, dt);
    this.replay.record(this.race.craft, this.race.time);
  }

  /**
   * Runs whoever is still out on track through to the flag, in one go.
   *
   * The race ends the moment the player crosses, but the classification is
   * about the whole field: leaving the rest unfinished would freeze their rows
   * on projected intervals, which do not even sort in the same order as the
   * positions beside them. A few hundred milliseconds under the finishing
   * placard buys a table of real times.
   *
   * The extra laps go into the recording too, so the replay covers the whole
   * race rather than stopping the instant the player was done with it.
   */
  private settleField(): void {
    this.settled = true;
    const ticks = Math.round(SETTLE_LIMIT / SETTLE_STEP);
    for (let i = 0; i < ticks; i++) {
      if (this.race.craft.every((craft) => craft.finishTime !== null)) break;
      // Idle input: the player has finished, so their craft simply coasts.
      this.race.tick(_idle, SETTLE_STEP);
      this.replay.record(this.race.craft, this.race.time);
    }
  }

  /** True while the intro owns the camera and the race is held. */
  get introducing(): boolean {
    return this.intro !== null;
  }

  /** Establishing shots the intro will cut to, or zero once it is done. */
  get introShots(): number {
    return this.intro?.shotCount ?? 0;
  }

  /** Places the camera where shot `index` will put it, for warming pipelines. */
  previewIntroShot(index: number, camera: PerspectiveCamera, at = 0.5): void {
    this.intro?.preview(index, camera, this.track, at);
  }

  /**
   * Turns frustum culling off across the circuit, and hands back the undo.
   *
   * Only for the warm-up. A pipeline is built the first time its object is
   * actually drawn, so anything outside the frustum of a warm frame is a stall
   * still waiting to happen — and with the camera teleporting between shots,
   * most of the circuit is outside most of them. One unculled frame draws
   * everything in the scene that is visible; something hidden is skipped before
   * it is ever culled, so it is not covered by this.
   *
   * Only objects that were being culled are collected, so the undo restores
   * exactly them — the sky dome and the boost flames turn culling off for
   * themselves and must stay that way.
   */
  suspendCulling(): () => void {
    const suspended: Object3D[] = [];
    this.scene.traverse((object) => {
      if (!object.frustumCulled) return;
      suspended.push(object);
      object.frustumCulled = false;
    });
    return () => {
      for (const object of suspended) object.frustumCulled = true;
    };
  }

  /** Cuts the intro short, leaving it just enough to settle. */
  skipIntro(): void {
    this.intro?.skip();
  }

  /** Places everything for this frame. `alpha` blends between the last two ticks. */
  /**
   * Places everything for this frame.
   *
   * `dt` is the world's time step and `uiDt` the real one. They differ while the
   * game is paused: the circuit is held exactly where the player left it, and
   * the interface over the top of it still has to animate — a pause panel that
   * froze along with the world would never arrive.
   */
  render(
    alpha: number,
    dt: number,
    lookingBack: boolean,
    camera: Parameters<ChaseCamera['update']>[0],
    uiDt = dt,
  ): void {
    // The world's own shader clock, so the pads stop scrolling when the race is
    // held rather than animating on behind the pause panel.
    advanceSimTime(dt);
    for (const [craft, model] of this.models) {
      craft.sampleRender(alpha, _position, _rotation);
      model.object.position.copy(_position);
      model.object.quaternion.copy(_rotation);
      model.setDrive(
        craft.telemetry.speedFraction,
        craft.state.boost > 0 ? 1 : 0,
        1 - clamp01(craft.shieldFraction),
      );
      model.setShield(craft.state.invulnerable);
    }

    const player = this.race.player;
    // No impact shake during a replay: the recording carries poses, not hits.
    // And none while the world is held — the telemetry is frozen, so pausing
    // just after a hit would re-arm the same shake on every frame the panel is
    // up and let it out all at once on resume.
    if (!this.replaying && dt > 0 && player.telemetry.impact > 0) {
      this.chase.impact(player.telemetry.impact);
    }

    this.chase.update(camera, player, alpha, dt, lookingBack);

    // After the chase, not instead of it: the orbit ends by blending onto
    // wherever the chase camera has settled, so it has to know where that is.
    if (this.intro) {
      player.sampleRender(alpha, _position, _rotation);
      this.intro.update(camera, this.track, _position, uiDt);
      this.hud.cinematic = this.intro.cinematic;
      if (!this.intro.active) {
        this.intro = null;
        this.hud.cinematic = false;
      }
    }
    this.environment.update(camera.position);
    this.highway.update(dt);
    this.grandstands.update(dt);
    this.startLine.update(1 - this.race.countdown / COUNTDOWN, this.race.time >= 0 ? this.race.time : -1);
    this.ordnance.update(this.race.projectiles);
    this.sparks.update(this.race.craft, dt);
    this.hud.update(this.race, uiDt);
  }

  resize(width: number, height: number, pixelRatio: number, uiScale = 1): void {
    this.hud.resize(width, height, pixelRatio, uiScale);
  }

  dispose(): void {
    for (const model of this.models.values()) model.dispose();
    this.models.clear();
    this.trackMesh.dispose();
    this.environment.dispose();
    this.skyline.dispose();
    this.highway.dispose();
    this.pillars.dispose();
    this.grandstands.dispose();
    this.startLine.dispose();
    this.markings.dispose();
    this.tunnelGlass.dispose();
    this.ordnance.dispose();
    this.sparks.dispose();
    this.hud.dispose();
  }
}
