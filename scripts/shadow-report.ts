/**
 * How much of the lap the city shades, corner by corner.
 *
 * The skyline's shadows are the circuit's best feature and there is no way to
 * judge their coverage by driving: you see one stretch at a time. This walks
 * the open road, casts each point at the sun, and prints the fraction in shade
 * — the number `Skyline.raiseForShadows` is aiming at.
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import { Track } from '@/track/Track';
import { meridianCoast } from '@/data/tracks/meridian-coast';
import { Skyline } from '@/track/scenery/Skyline';
import { Grandstands } from '@/track/scenery/Grandstands';

const track = new Track(meridianCoast);
// The way the stage builds it: the stands first, the city around them.
const skyline = new Skyline(track, new Grandstands(track).footprints);

const { azimuth, elevation } = meridianCoast.sun;
const radians = (azimuth * Math.PI) / 180;
const shadeX = -Math.cos(radians);
const shadeZ = -Math.sin(radians);
const reach = 1 / Math.tan((elevation * Math.PI) / 180);

interface Tower { x: number; z: number; top: number; radius: number }
const towers: Tower[] = [];
const position = new Vector3();
const scale = new Vector3();
const quaternion = new Quaternion();
const mesh = (skyline as never as { mesh: import('three').InstancedMesh }).mesh;
const matrix = new Matrix4();
for (let i = 0; i < mesh.count; i++) {
  mesh.getMatrixAt(i, matrix);
  matrix.decompose(position, quaternion, scale);
  towers.push({
    x: position.x,
    z: position.z,
    top: position.y + scale.y,
    radius: Math.hypot(scale.x, scale.z) * 0.5,
  });
}

let open = 0;
let shaded = 0;
const bars: string[] = [];
for (let s = 0; s < track.length; s += 9) {
  if (track.isInTunnel(s)) {
    bars.push('=');
    continue;
  }
  open++;
  const point = track.frameAt(s).position;
  const hit = towers.some((tower) => {
    const dx = point.x - tower.x;
    const dz = point.z - tower.z;
    const along = dx * shadeX + dz * shadeZ;
    if (along <= 0) return false;
    if (Math.abs(dx * shadeZ - dz * shadeX) > tower.radius * 0.8) return false;
    return along <= (tower.top - point.y) * reach;
  });
  if (hit) shaded++;
  bars.push(hit ? '#' : '.');
}

// Why the gaps are gaps: a point with nothing standing between it and the sun
// cannot be shaded by raising anything, and needs a building placed instead.
let noCandidate = 0;
for (let s = 0; s < track.length; s += 9) {
  if (track.isInTunnel(s)) continue;
  const point = track.frameAt(s).position;
  const lit = !towers.some((tower) => {
    const dx = point.x - tower.x;
    const dz = point.z - tower.z;
    const along = dx * shadeX + dz * shadeZ;
    if (along <= 0) return false;
    if (Math.abs(dx * shadeZ - dz * shadeX) > tower.radius * 0.8) return false;
    return along <= (tower.top - point.y) * reach;
  });
  if (!lit) continue;
  const inLine = towers.some((tower) => {
    const dx = point.x - tower.x;
    const dz = point.z - tower.z;
    const along = dx * shadeX + dz * shadeZ;
    return along > 0 && Math.abs(dx * shadeZ - dz * shadeX) <= tower.radius * 0.8;
  });
  if (!inLine) noCandidate++;
}
console.log(`${noCandidate} lit samples have nothing at all between them and the sun`);

const heights = towers.map((t) => t.top).sort((a, b) => a - b);
console.log(`${mesh.count} buildings, tallest ${heights.at(-1)!.toFixed(0)} m, median ${heights[heights.length >> 1]!.toFixed(0)} m`);
console.log(`shade ${((shaded / open) * 100).toFixed(1)}% of ${open} open samples`);
console.log(bars.join(''));
