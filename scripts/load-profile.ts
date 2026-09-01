import { performance } from 'node:perf_hooks';
import { Track } from '@/track/Track';
import { TrackMesh } from '@/track/TrackMesh';
import { Skyline } from '@/track/scenery/Skyline';
import { SkyHighway } from '@/track/scenery/SkyHighway';
import { TunnelLights } from '@/track/scenery/TunnelLights';
import { GliderModel } from '@/game/GliderModel';
import { createWaterNormals } from '@/track/scenery/WaterNormals';
import { meridianCoast } from '@/data/tracks/meridian-coast';
import { TEAMS } from '@/data/teams';

/**
 * Where the load time goes.
 *
 * Everything here runs on the main thread between the player pressing start and
 * the first frame of a race, and everything here is pure arithmetic — no GPU
 * calls, which is exactly why it can be measured off a GPU at all. That is also
 * the question this script exists to answer: what could be moved off the main
 * thread, and would it be worth the trouble.
 *
 * Run with `npx vite-node scripts/load-profile.ts`.
 */

interface Phase {
  name: string;
  ms: number;
  /**
   * Where this phase runs today: `moved` is already in the track worker,
   * `could` is arithmetic that has not been moved because it is not worth the
   * boundary yet, and `no` needs the main thread.
   */
  worker: 'moved' | 'could' | 'no';
  note: string;
}

const phases: Phase[] = [];

function time<T>(name: string, worker: Phase['worker'], note: string, work: () => T): T {
  const start = performance.now();
  const result = work();
  phases.push({ name, ms: performance.now() - start, worker, note });
  return result;
}

const track = time('Track (path, spline, collision)', 'moved', 'Spline is resampled in the worker and transferred', () =>
  new Track(meridianCoast),
);

time('TrackMesh (road, kerbs, barriers, tunnels, pads)', 'moved', 'Swept in the worker; buffers transferred, materials made here', () => {
  return new TrackMesh(track);
});

time('Skyline (placement, clearance, platforms, bridges)', 'could', 'Placement is maths; the InstancedMesh is not', () => new Skyline(track));

time('SkyHighway', 'could', 'Lane maths is trivial; the mesh is not', () => new SkyHighway(track));

time('TunnelLights', 'could', 'A list of positions', () => new TunnelLights(track));

time('Craft models (five teams)', 'could', 'Sweeps are maths; also built for the showroom', () => {
  return TEAMS.map((team) => new GliderModel(team));
});

time('Water normal map', 'moved', 'Bytes generated in the worker, wrapped in a texture here', () => createWaterNormals());

const total = phases.reduce((sum, phase) => sum + phase.ms, 0);

const pad = (text: string, width: number): string => text.padEnd(width);
const width = Math.max(...phases.map((phase) => phase.name.length));

console.log('');
console.log(`${pad('phase', width)}     ms    share  thread`);
console.log('-'.repeat(width + 34));
for (const phase of phases.sort((a, b) => b.ms - a.ms)) {
  console.log(
    `${pad(phase.name, width)} ${phase.ms.toFixed(1).padStart(6)}  ${((phase.ms / total) * 100).toFixed(1).padStart(5)}%  ${pad(phase.worker, 7)} ${phase.note}`,
  );
}
console.log('-'.repeat(width + 34));
console.log(`${pad('total', width)} ${total.toFixed(1).padStart(6)}`);
console.log('');
const moved = phases.filter((phase) => phase.worker === 'moved').reduce((sum, phase) => sum + phase.ms, 0);
console.log(`Off the main thread: ${moved.toFixed(1)} ms of ${total.toFixed(1)} (${((moved / total) * 100).toFixed(0)}%).`);
console.log('');
console.log('Not measured here, because it needs a GPU and cannot leave the main thread:');
console.log('  - PMREM pre-filtering of the sky panorama');
console.log('  - Shader compilation and pipeline creation for every material');
console.log('  - Geometry and texture upload');
