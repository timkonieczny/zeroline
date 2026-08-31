import { describe, expect, it } from 'vitest';
import { Track } from '@/track/Track';
import { meridianCoast } from '@/data/tracks/meridian-coast';
import { Race } from '@/game/Race';
import { TEAMS, teamById } from '@/data/teams';
import { speedClassById } from '@/game/Handling';
import { createInputSnapshot } from '@/game/InputSnapshot';
import { classify } from '@/game/Results';

const TICK = 1 / 120;
const track = new Track(meridianCoast);
const idle = createInputSnapshot();

function makeRace(laps = 1): Race {
  return new Race({
    mode: 'race',
    track,
    speedClass: speedClassById('flash'),
    playerTeam: teamById('auroc'),
    fieldTeams: TEAMS.filter((t) => t.id !== 'auroc').concat(TEAMS.slice(0, 3)).slice(0, 7),
    laps,
    seed: 0xc1a55,
  });
}

function simulate(race: Race, seconds: number): void {
  const ticks = Math.round(seconds / TICK);
  for (let i = 0; i < ticks; i++) race.tick(idle, TICK);
}

/** `M:SS.mmm` — exactly three decimal places on the seconds. */
const ABSOLUTE_TIME = /^\d+:[0-5]\d\.\d{3}$/;
/** `+S.mmm`, an interval to the leader. */
const INTERVAL = /^\+\d+\.\d{3}$/;

describe('classification', () => {
  it('lists the whole field in finishing order', () => {
    const race = makeRace();
    simulate(race, 60);
    const rows = classify(race);

    expect(rows).toHaveLength(race.craft.length);
    rows.forEach((row, i) => expect(row.position).toBe(i + 1));
  });

  it('marks exactly one row as the player, and it is their own craft', () => {
    const race = makeRace();
    simulate(race, 60);
    const rows = classify(race);

    const mine = rows.filter((row) => row.isPlayer);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.teamName).toBe(race.player.team.name);
    expect(mine[0]!.position).toBe(race.player.position);
  });

  it('gives every finisher a time to the millisecond', () => {
    const race = makeRace();
    // Long enough for the whole field to take the flag.
    simulate(race, 120);
    const rows = classify(race);

    const finishers = rows.filter((row) => row.finished);
    expect(finishers.length).toBeGreaterThan(0);
    for (const row of finishers) expect(row.time).toMatch(ABSOLUTE_TIME);
  });

  it('keeps finishing times in ascending order down the table', () => {
    const race = makeRace();
    simulate(race, 120);

    const finishTimes = race.standings
      .filter((craft) => craft.finishTime !== null)
      .map((craft) => craft.finishTime!);
    for (let i = 1; i < finishTimes.length; i++) {
      expect(finishTimes[i]!).toBeGreaterThanOrEqual(finishTimes[i - 1]!);
    }
  });

  it('shows a live interval for craft still out on track', () => {
    const race = makeRace(2);
    // Mid-race: nobody has finished, so everyone behind the leader has a gap.
    simulate(race, 25);
    const rows = classify(race);

    expect(rows.every((row) => !row.finished)).toBe(true);
    expect(rows[0]!.time).toBe('—');
    for (const row of rows.slice(1)) {
      expect(row.time === '—' || INTERVAL.test(row.time) || /^\+\d+ laps?$/.test(row.time)).toBe(true);
    }
  });

  it('writes a lapped craft as laps rather than a meaningless interval', () => {
    const race = makeRace(3);
    simulate(race, 20);

    // Drag one craft a full lap backwards and re-sort.
    const victim = race.craft[3]!;
    victim.distance -= track.length * 1.4;
    race.tick(idle, TICK);

    const row = classify(race).find((entry) => entry.teamName === victim.team.name && !entry.finished);
    expect(row).toBeDefined();
    expect(classify(race).at(-1)!.time).toMatch(/^\+\d+ laps?$/);
  });

  it('carries the craft designation and nation for every row', () => {
    const race = makeRace();
    simulate(race, 30);
    for (const row of classify(race)) {
      expect(row.tag).toMatch(/^[A-Z0-9]{3} \d{2} · [A-Z]{2}$/);
    }
  });

  it('has a single winner on the top row', () => {
    const race = makeRace();
    simulate(race, 120);
    const rows = classify(race);
    expect(rows[0]!.position).toBe(1);
    expect(rows[0]!.finished).toBe(true);
    expect(race.standings[0]!.finishTime).toBeLessThanOrEqual(race.standings[1]!.finishTime ?? Infinity);
  });
});
