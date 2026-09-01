import { Quaternion, Scene, Vector3 } from 'three';
import { Track } from '@/track/Track';
import { TrackMesh } from '@/track/TrackMesh';
import { Environment } from '@/track/scenery/Environment';
import { TunnelLights } from '@/track/scenery/TunnelLights';
import { Skyline } from '@/track/scenery/Skyline';
import { SkyHighway } from '@/track/scenery/SkyHighway';
import type { TrackDefinition } from '@/track/TrackTypes';
import { Race, type RaceSetup } from './Race';
import { GliderModel } from './GliderModel';
import { WeaponVisuals } from './weapons/WeaponVisuals';
import { ChaseCamera } from './ChaseCamera';
import { Hud } from './Hud';
import { Replay } from './Replay';
import { createInputSnapshot } from './InputSnapshot';
import type { Craft } from './Craft';
import type { Renderer } from '@/core/Renderer';
import { clamp01 } from '@/core/math';

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
  private readonly tunnelLights: TunnelLights;
  private readonly highway: SkyHighway;
  private readonly ordnance = new WeaponVisuals();
  private readonly models = new Map<Craft, GliderModel>();

  constructor(definition: TrackDefinition, renderer: Renderer, setup: Omit<RaceSetup, 'track'>, pixelRatio: number) {
    this.track = new Track(definition);

    this.trackMesh = new TrackMesh(this.track);
    this.scene.add(this.trackMesh.group);

    this.environment = new Environment(this.track);
    this.environment.applyTo(this.scene, renderer.renderer);

    this.skyline = new Skyline(this.track);
    this.scene.add(this.skyline.group);

    this.tunnelLights = new TunnelLights(this.track);
    this.scene.add(this.tunnelLights.group);

    this.highway = new SkyHighway(this.track);
    this.scene.add(this.highway.group);

    this.scene.add(this.ordnance.group);

    this.race = new Race({ ...setup, track: this.track });
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

  /** Places everything for this frame. `alpha` blends between the last two ticks. */
  render(alpha: number, dt: number, lookingBack: boolean, camera: Parameters<ChaseCamera['update']>[0]): void {
    for (const [craft, model] of this.models) {
      craft.sampleRender(alpha, _position, _rotation);
      model.object.position.copy(_position);
      model.object.quaternion.copy(_rotation);
      model.setDrive(
        craft.telemetry.speedFraction,
        craft.state.boost > 0 ? 1 : 0,
        1 - clamp01(craft.shieldFraction),
      );
    }

    const player = this.race.player;
    // No impact shake during a replay: the recording carries poses, not hits.
    if (!this.replaying && player.telemetry.impact > 0) this.chase.impact(player.telemetry.impact);

    this.chase.update(camera, player, alpha, dt, lookingBack);
    this.environment.update(camera.position);
    this.tunnelLights.update(camera.position);
    this.highway.update(dt);
    this.ordnance.update(this.race.projectiles);
    this.hud.update(this.race, dt);
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.hud.resize(width, height, pixelRatio);
  }

  dispose(): void {
    for (const model of this.models.values()) model.dispose();
    this.models.clear();
    this.trackMesh.dispose();
    this.environment.dispose();
    this.skyline.dispose();
    this.tunnelLights.dispose();
    this.highway.dispose();
    this.ordnance.dispose();
    this.hud.dispose();
  }
}
