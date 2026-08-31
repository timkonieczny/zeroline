import { Quaternion, Scene, Vector3 } from 'three';
import { Renderer } from '@/core/Renderer';
import { Loop } from '@/core/Loop';
import { PostFX, QUALITY_PRESETS } from '@/core/PostFX';
import { Input } from '@/core/Input';
import { Track } from '@/track/Track';
import { TrackMesh } from '@/track/TrackMesh';
import { Environment } from '@/track/scenery/Environment';
import { meridianCoast } from '@/data/tracks/meridian-coast';
import { TEAMS, teamById } from '@/data/teams';
import { speedClassById } from '@/game/Handling';
import { Race } from '@/game/Race';
import { GliderModel } from '@/game/GliderModel';
import { ChaseCamera } from '@/game/ChaseCamera';
import { Hud } from '@/game/Hud';
import { WeaponVisuals } from '@/game/weapons/WeaponVisuals';
import { clamp01 } from '@/core/math';

const bootStatus = document.getElementById('boot-status');
const bootCard = document.getElementById('boot');

function status(text: string): void {
  if (bootStatus) bootStatus.textContent = text;
}

function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  bootStatus?.classList.add('error');
  status(`COULD NOT START — ${message}`);
  console.error(error);
}

async function boot(): Promise<void> {
  status('REQUESTING DEVICE');
  const renderer = new Renderer();
  await renderer.init();

  status('BUILDING CIRCUIT');
  const scene = new Scene();
  const track = new Track(meridianCoast);
  const trackMesh = new TrackMesh(track);
  scene.add(trackMesh.group);

  const environment = new Environment(track);
  environment.applyTo(scene, renderer.renderer);

  status('ROLLING OUT');
  const race = new Race({
    mode: 'race',
    track,
    speedClass: speedClassById('flash'),
    playerTeam: teamById('auroc'),
    fieldTeams: TEAMS.filter((t) => t.id !== 'auroc').concat(TEAMS.filter((t) => t.id !== 'auroc')).slice(0, 7),
    laps: meridianCoast.laps,
    seed: 0x2e01,
  });

  const models = new Map(race.craft.map((craft) => [craft, new GliderModel(craft.team)]));
  for (const model of models.values()) scene.add(model.object);

  const ordnance = new WeaponVisuals();
  scene.add(ordnance.group);

  const camera = new ChaseCamera();
  const input = new Input();
  input.attach();

  const hud = new Hud(window.devicePixelRatio || 1);
  const sizeHud = (): void =>
    hud.resize(window.innerWidth, window.innerHeight, Math.min(2.5, window.devicePixelRatio || 1));
  sizeHud();
  window.addEventListener('resize', sizeHud);

  status('COMPILING EFFECTS');
  const post = new PostFX(renderer.renderer, scene, renderer.camera, QUALITY_PRESETS.high, {
    scene: hud.scene,
    camera: hud.camera,
  });

  const perf = document.createElement('div');
  perf.id = 'perf';
  perf.hidden = true;
  document.body.appendChild(perf);
  window.addEventListener('keydown', (e) => {
    if (e.code === 'F3') {
      e.preventDefault();
      perf.hidden = !perf.hidden;
    }
  });

  const position = new Vector3();
  const rotation = new Quaternion();
  let perfTimer = 0;

  const loop = new Loop(
    (step) => {
      race.tick(input.snapshot, step);
    },
    (alpha, frameTime) => {
      input.update(frameTime);

      for (const [craft, model] of models) {
        craft.sampleRender(alpha, position, rotation);
        model.object.position.copy(position);
        model.object.quaternion.copy(rotation);
        model.setDrive(
          craft.telemetry.speedFraction,
          craft.state.boost > 0 ? 1 : 0,
          1 - clamp01(craft.shieldFraction),
        );
      }

      const player = race.player;
      if (player.telemetry.impact > 0) {
        camera.impact(player.telemetry.impact);
        input.rumble(player.telemetry.impact, 140);
      }
      camera.update(renderer.camera, player, alpha, frameTime, input.snapshot.lookBack);
      environment.update(renderer.camera.position);

      ordnance.update(race.projectiles);
      hud.update(race, frameTime);
      post.setDrive(player.telemetry.speedFraction, player.state.boost > 0, frameTime);
      post.render();

      // The HUD is drawn straight onto the finished frame, outside the post
      // chain, so the readouts never pick up motion blur or aberration.
      renderer.reportFrame(frameTime);

      perfTimer += frameTime;
      if (!perf.hidden && perfTimer > 0.25) {
        perfTimer = 0;
        const stats = renderer.stats;
        const info = renderer.renderer.info;
        perf.textContent = [
          `${(1 / Math.max(frameTime, 1e-6)).toFixed(0).padStart(3)} fps   ${(frameTime * 1000).toFixed(2)} ms`,
          `backend    ${stats.backend}`,
          `buffer     ${stats.drawingBufferWidth}x${stats.drawingBufferHeight}`,
          `dpr        ${stats.devicePixelRatio.toFixed(2)}  scale ${stats.resolutionScale.toFixed(2)}`,
          `draws      ${info.render.drawCalls}   tris ${info.render.triangles.toLocaleString()}`,
          `sim ticks  ${loop.ticksLastFrame}`,
          `speed      ${(player.telemetry.speed * 3.6).toFixed(0)} km/h`,
          `lap        ${Math.min(race.setup.laps, player.lap + 1)}/${race.setup.laps}   pos ${player.position}/${race.craft.length}`,
          `shield     ${(player.shieldFraction * 100).toFixed(0)}%`,
        ].join('\n');
      }
    },
  );

  camera.reset();
  loop.start();
  bootCard?.classList.add('hidden');
  window.setTimeout(() => bootCard?.remove(), 500);
}

boot().catch(fail);
