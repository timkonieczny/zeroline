import { Quaternion, Scene, Vector3 } from 'three';
import { Track } from '@/track/Track';
import { TrackMesh } from '@/track/TrackMesh';
import { Environment } from '@/track/scenery/Environment';
import { Skyline } from '@/track/scenery/Skyline';
import { SkyHighway } from '@/track/scenery/SkyHighway';
import type { TrackDefinition } from '@/track/TrackTypes';
import { Race, type RaceSetup } from './Race';
import { GliderModel } from './GliderModel';
import { WeaponVisuals } from './weapons/WeaponVisuals';
import { ChaseCamera } from './ChaseCamera';
import { Hud } from './Hud';
import type { Craft } from './Craft';
import type { Renderer } from '@/core/Renderer';
import { clamp01 } from '@/core/math';

const _position = new Vector3();
const _rotation = new Quaternion();

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

  private readonly trackMesh: TrackMesh;
  private readonly environment: Environment;
  private readonly skyline: Skyline;
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

    this.highway = new SkyHighway(this.track);
    this.scene.add(this.highway.group);

    this.scene.add(this.ordnance.group);

    this.hud = new Hud(pixelRatio);
    this.race = new Race({ ...setup, track: this.track });
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
    this.buildField();
    this.chase.reset();
  }

  private buildField(): void {
    for (const craft of this.race.craft) {
      const model = new GliderModel(craft.team);
      this.models.set(craft, model);
      this.scene.add(model.object);
    }
  }

  tick(input: Parameters<Race['tick']>[0], dt: number): void {
    this.race.tick(input, dt);
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
    if (player.telemetry.impact > 0) this.chase.impact(player.telemetry.impact);

    this.chase.update(camera, player, alpha, dt, lookingBack);
    this.environment.update(camera.position);
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
    this.highway.dispose();
    this.ordnance.dispose();
    this.hud.dispose();
  }
}
