/**
 * Prints the geometric health of a circuit: length, curvature, gradient, and
 * the sharpest frame transitions, each mapped back to the control point that
 * caused it. Run after editing control points.
 *
 *   npx vite-node scripts/inspect-track.ts
 */
import { createTrackFrame } from '@/track/TrackSpline';
import { Track } from '@/track/Track';
import { meridianCoast } from '@/data/tracks/meridian-coast';


const track = new Track(meridianCoast);
const spline = track.spline;
const a = createTrackFrame();
const b = createTrackFrame();
const step = 2;

const samples: { s: number; radius: number; roll: number; slope: number }[] = [];
for (let s = 0; s < spline.length; s += step) {
  spline.sample(s, a);
  spline.sample(s + step, b);
  const turn = Math.acos(Math.min(1, Math.max(-1, a.tangent.dot(b.tangent))));
  samples.push({
    s,
    radius: turn > 1e-6 ? step / turn : Infinity,
    roll: Math.acos(Math.min(1, a.up.dot(b.up))),
    slope: Math.asin(Math.abs(a.tangent.y)),
  });
}

const segmentAt = (s: number): string => {
  const c = track.corners.find((k) => s >= k.fromS && s <= k.toS);
  return c ? c.name : 'straight';
};

const pct = (s: number) => `${((s / spline.length) * 100).toFixed(1)}%`;
const deg = (r: number) => (r * 57.2958).toFixed(2);

/** Worst `n` entries by `key`, keeping only one per 40 m so a single corner does not fill the list. */
function worst(
  key: (x: (typeof samples)[number]) => number,
  n: number,
  ascending: boolean,
): typeof samples {
  const sorted = samples.slice().sort((x, y) => (ascending ? key(x) - key(y) : key(y) - key(x)));
  const out: typeof samples = [];
  for (const s of sorted) {
    if (out.length >= n) break;
    if (out.every((o) => Math.abs(o.s - s.s) > 40)) out.push(s);
  }
  return out;
}

console.log(`${meridianCoast.name} — ${meridianCoast.subtitle}`);
console.log(`  length        ${spline.length.toFixed(1)} m, ${spline.count} samples @ ${spline.step.toFixed(2)} m`);
console.log(`  boost pads    ${track.boostPads.length}`);
console.log(`  pickup pads   ${track.pickupPads.length}`);
console.log(`  tunnel metres ${track.tunnels.reduce((n, t) => n + (t.toS - t.fromS), 0).toFixed(0)}`);
console.log('');
console.log('  corners as built');
for (const c of track.corners) {
  console.log(
    `    ${c.name.padEnd(20)} ${c.turn > 0 ? 'right' : 'left '} ${Math.abs(c.turn).toFixed(0).padStart(3)} deg  r ${c.radius.toFixed(0).padStart(4)} m  arc ${c.arcLength.toFixed(0).padStart(3)} m  entry straight ${c.entryStraight.toFixed(0).padStart(4)} m  lap ${pct(c.fromS).padStart(6)}-${pct(c.toS).padStart(6)}`,
  );
}

const describe = (s: number): string => segmentAt(s);

console.log('');
console.log('  tightest corners');
for (const x of worst((v) => v.radius, 6, true)) {
  console.log(`    ${x.radius.toFixed(0).padStart(5)} m at ${pct(x.s).padStart(6)}  ${describe(x.s)}`);
}

console.log('');
console.log(`  sharpest roll (deg per ${step} m)`);
for (const x of worst((v) => v.roll, 5, false)) {
  console.log(`    ${deg(x.roll).padStart(7)} at ${pct(x.s).padStart(6)}  ${describe(x.s)}`);
}

console.log('');
console.log('  steepest gradient (deg)');
for (const x of worst((v) => v.slope, 3, false)) {
  console.log(`    ${deg(x.slope).padStart(7)} at ${pct(x.s).padStart(6)}  ${describe(x.s)}`);
}
