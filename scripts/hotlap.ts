/**
 * Runs the simulation headlessly and reports what actually happened: lap times,
 * top speed, where time is lost, how often the car touched a wall.
 *
 * This is the tuning loop for handling. Changing a number in `Handling.ts` and
 * re-running takes seconds; changing it and driving takes minutes and lies.
 *
 *   npx vite-node scripts/hotlap.ts               all teams, FLASH class
 *   npx vite-node scripts/hotlap.ts kestrel rapier
 */
import { Track } from '@/track/Track';
import { RacingLine } from '@/track/RacingLine';
import { meridianCoast } from '@/data/tracks/meridian-coast';
import { TEAMS, teamById } from '@/data/teams';
import { SPEED_CLASSES, speedClassById, type SpeedClassId } from '@/game/Handling';
import { Craft } from '@/game/Craft';
import { placeOnGrid, stepCraft } from '@/game/Physics';
import { Driver, skillForGridSlot } from '@/game/AI';
import { createInputSnapshot } from '@/game/InputSnapshot';
import { Rng } from '@/core/Rng';
import { wrapDelta } from '@/core/math';

const TICK = 1 / 120;
const LAPS = 4;

const teamArg = process.argv[2];
const classArg = (process.argv[3] as SpeedClassId | undefined) ?? 'flash';
const speedClass = speedClassById(classArg);
const teams = teamArg ? [teamById(teamArg)] : TEAMS;

const track = new Track(meridianCoast);
const line = new RacingLine(track);

console.log(`${meridianCoast.name} — ${speedClass.name} class`);
console.log(`  centreline ${track.length.toFixed(0)} m, racing line ${line.length.toFixed(0)} m`);
console.log('');
console.log(
  `  ${'TEAM'.padEnd(18)} ${'BEST'.padStart(8)} ${'AVG'.padStart(8)} ${'TOP'.padStart(8)} ${'AVG SPD'.padStart(8)} ${'WALL'.padStart(6)} ${'SHIELD'.padStart(7)}`,
);

for (const team of teams) {
  const craft = new Craft(0, team, speedClass, 'ai');
  placeOnGrid(craft, track, 0);
  const rng = new Rng(0x1ee7);
  const driver = new Driver(craft, track, line, rng, skillForGridSlot(0, 8, speedClass.aiSkill));
  const input = createInputSnapshot();
  const field = [craft];

  let time = 0;
  let lapStart = 0;
  let previousS = craft.state.s;
  const lapTimes: number[] = [];
  let topSpeed = 0;
  let speedSum = 0;
  let ticks = 0;
  let wallTicks = 0;

  while (lapTimes.length < LAPS && time < 400) {
    craft.beginTick();
    driver.update(input, TICK, field, time);
    stepCraft(craft, input, track, TICK);
    time += TICK;
    ticks++;

    const speed = craft.telemetry.speed;
    topSpeed = Math.max(topSpeed, speed);
    speedSum += speed;
    if (craft.telemetry.impact > 0 || craft.telemetry.scraping) wallTicks++;

    // Crossing the start line: progress wraps past `startS` going forwards.
    const before = wrapDelta(track.startS, previousS, track.length);
    const after = wrapDelta(track.startS, craft.state.s, track.length);
    if (before < 0 && after >= 0 && after < 100) {
      if (lapStart > 0) lapTimes.push(time - lapStart);
      lapStart = time;
    }
    previousS = craft.state.s;
  }

  const fmt = (t: number): string => {
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s.toFixed(3).padStart(6, '0')}`;
  };
  const best = lapTimes.length ? Math.min(...lapTimes) : NaN;
  const avg = lapTimes.length ? lapTimes.reduce((a, b) => a + b, 0) / lapTimes.length : NaN;

  console.log(
    `  ${team.name.padEnd(18)} ${(lapTimes.length ? fmt(best) : '   DNF').padStart(8)} ${(lapTimes.length ? fmt(avg) : '   DNF').padStart(8)} ` +
      `${(topSpeed * 3.6).toFixed(0).padStart(5)}kmh ${((speedSum / ticks) * 3.6).toFixed(0).padStart(5)}kmh ` +
      `${((wallTicks / ticks) * 100).toFixed(1).padStart(5)}% ${(craft.shieldFraction * 100).toFixed(0).padStart(6)}%`,
  );
}

if (!teamArg) {
  console.log('');
  console.log('  speed classes (AUROC)');
  for (const sc of SPEED_CLASSES) {
    const craft = new Craft(0, TEAMS[0]!, sc, 'ai');
    console.log(
      `    ${sc.name.padEnd(8)} top ${(craft.handling.topSpeed * 3.6).toFixed(0).padStart(4)} km/h  ` +
        `standstill to 95% of it in ${((craft.handling.topSpeed / craft.handling.thrust) * Math.atanh(0.95)).toFixed(1)} s`,
    );
  }
}
