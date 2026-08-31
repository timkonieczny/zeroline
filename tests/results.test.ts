import { describe, expect, it } from 'vitest';
import { Track } from '@/track/Track';
import { meridianCoast } from '@/data/tracks/meridian-coast';
import { Race } from '@/game/Race';
import { TEAMS, teamById } from '@/data/teams';
import { speedClassById } from '@/game/Handling';
import { createInputSnapshot } from '@/game/InputSnapshot';
import { classify, formatTime } from '@/game/Results';
import type { Craft } from '@/game/Craft';

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

describe('time formatting', () => {
  it('writes minutes, seconds and milliseconds', () => {
    expect(formatTime(0)).toBe('0:00.000');
    expect(formatTime(33.525)).toBe('0:33.525');
    expect(formatTime(93.667)).toBe('1:33.667');
  });

  it('rolls over instead of printing a sixtieth second', () => {
    // Formatting the seconds independently turns this into "1:60.000".
    expect(formatTime(119.9996)).toBe('2:00.000');
    expect(formatTime(59.9999)).toBe('1:00.000');
    expect(formatTime(119.9994)).toBe('1:59.999');
  });

  it('shows a placeholder for a time that does not exist yet', () => {
    expect(formatTime(-1)).toBe('--:--.---');
    expect(formatTime(NaN)).toBe('--:--.---');
  });
});

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

  /**
   * The interval rule, exercised directly.
   *
   * A finisher keeps driving — nothing in the simulation stops it — so its live
   * `distance` is not the finish line any more. Measuring against it inflates
   * every gap, and if the winner instead stops (a player letting off the
   * throttle to watch the table) the others overtake its frozen distance and
   * every interval blanks to an em dash.
   */
  describe('once the winner has taken the flag', () => {
    /**
     * A real race run until the flag falls, then pinned to round numbers.
     *
     * The standings have to come from the simulation — `classify` reads the
     * sorted order, and that is only rebuilt inside a tick — but the distances
     * and times are overridden afterwards so the expected intervals are exact.
     */
    function scenario(): { race: Race; winner: Craft; chaser: Craft; tag: string } {
      const race = makeRace(3);
      for (let i = 0; i < 120 * 300 && race.standings[0]!.finishTime === null; i++) race.tick(idle, TICK);

      const winner = race.standings[0]!;
      const chaser = race.standings[1]!;
      expect(winner.finishTime).not.toBeNull();
      expect(chaser.finishTime).toBeNull();

      // The winner crossed 10 s ago, 200 m up the road from the chaser.
      race.time = 100;
      winner.finishTime = 90;
      winner.finishDistance = 3000;
      winner.distance = 3000;
      chaser.distance = 2800;
      chaser.telemetry.speed = 100;
      return { race, winner, chaser, tag: `${chaser.name} · ${chaser.team.nation}` };
    }

    const intervalFor = (race: Race, tag: string): string =>
      classify(race).find((entry) => entry.tag === tag)!.time;

    it('measures from the line, not from where the winner has got to since', () => {
      const { race, winner, tag } = scenario();
      // 10 s elapsed since the flag, 200 m still to run at 100 m/s.
      expect(intervalFor(race, tag)).toBe('+12.000');

      // The winner drives another two kilometres. The gap must not move.
      winner.distance += 2000;
      expect(intervalFor(race, tag)).toBe('+12.000');
    });

    it('does not blank when the winner stops and the field drives past', () => {
      const { race, chaser, tag } = scenario();
      // The winner sits still; the chaser runs beyond its frozen distance.
      chaser.distance = 3100;
      const shown = intervalFor(race, tag);
      expect(shown).not.toBe('—');
      expect(shown).toMatch(INTERVAL);
    });

    it('converges on the gap that actually happened', () => {
      const { race, chaser, tag } = scenario();
      // Right on the line: nothing left to run, so the interval is the elapsed
      // time since the winner crossed.
      chaser.distance = 3000;
      expect(intervalFor(race, tag)).toBe('+10.000');
    });
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
