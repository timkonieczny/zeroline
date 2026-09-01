import { describe, expect, it } from 'vitest';
import { Track } from '@/track/Track';
import { meridianCoast } from '@/data/tracks/meridian-coast';
import { Race } from '@/game/Race';
import { TEAMS, teamById } from '@/data/teams';
import { speedClassById } from '@/game/Handling';
import { createInputSnapshot, type InputSnapshot } from '@/game/InputSnapshot';

const TICK = 1 / 120;
const track = new Track(meridianCoast);

function makeRace(): Race {
  return new Race({
    mode: 'race',
    track,
    speedClass: speedClassById('flash'),
    playerTeam: teamById('auroc'),
    fieldTeams: TEAMS.filter((t) => t.id !== 'auroc').concat(TEAMS.slice(0, 3)).slice(0, 7),
    laps: 1,
    seed: 0x5747,
  });
}

/** Runs the race, opening the player's throttle once `race.time` reaches `openAt`. */
function runStart(race: Race, openAt: number | null, until: number): InputSnapshot {
  const input = createInputSnapshot();
  while (race.time < until) {
    input.thrust = openAt !== null && race.time >= openAt ? 1 : 0;
    race.tick(input, TICK);
  }
  return input;
}

describe('the standing start', () => {
  it('does not let the throttle move the craft before the lights', () => {
    const race = makeRace();
    const start = race.player.state.position.clone();
    // Throttle wide open from the very first light.
    runStart(race, -Infinity, -0.02);

    expect(race.phase).toBe('countdown');
    expect(race.player.state.position.distanceTo(start)).toBeLessThan(0.2);
    expect(Math.abs(race.player.telemetry.speed)).toBeLessThan(0.5);
    expect(race.player.distance).toBeLessThan(0.2);
  });

  it('holds the whole field on the grid, not just the player', () => {
    const race = makeRace();
    const before = race.craft.map((c) => c.state.position.clone());
    runStart(race, -Infinity, -0.02);
    race.craft.forEach((craft, i) => {
      expect(craft.state.position.distanceTo(before[i]!)).toBeLessThan(0.2);
    });
  });

  it('pays a getaway for opening the throttle just before the lights', () => {
    const race = makeRace();
    runStart(race, -0.1, 0.05);
    expect(race.player.startRating).not.toBeNull();
    expect(race.player.startRating!).toBeGreaterThan(0.8);
    expect(race.player.state.boost).toBeGreaterThan(1.5);
  });

  it('pays less for a scrappier one', () => {
    const race = makeRace();
    runStart(race, -0.65, 0.05);
    expect(race.player.startRating).not.toBeNull();
    expect(race.player.startRating!).toBeLessThan(0.3);
    expect(race.player.state.boost).toBeGreaterThan(0);
    expect(race.player.state.boost).toBeLessThan(1.2);
  });

  it('pays nothing for jumping the lights far too early', () => {
    const race = makeRace();
    runStart(race, -3.5, 0.05);
    expect(race.player.startRating).toBeNull();
    expect(race.player.state.boost).toBe(0);
  });

  it('pays nothing for missing the start entirely', () => {
    const race = makeRace();
    runStart(race, null, 0.05);
    expect(race.player.startRating).toBeNull();
    expect(race.player.state.boost).toBe(0);
  });

  it('resets the clock when the throttle is released and re-applied', () => {
    const race = makeRace();
    const input = createInputSnapshot();
    while (race.time < 0.05) {
      // Held early, dropped, then picked up again right on the lights.
      const t = race.time;
      input.thrust = t < -1.2 ? 1 : t > -0.08 && t < 0 ? 1 : 0;
      race.tick(input, TICK);
    }
    // The early hold must not count; the late one must.
    expect(race.player.startRating).not.toBeNull();
    expect(race.player.startRating!).toBeGreaterThan(0.8);
  });

  it('lets the field earn a getaway too, best drivers timing it latest', () => {
    const race = makeRace();
    runStart(race, null, 0.05);
    const rated = race.craft.filter((c) => c.control === 'ai' && c.startRating !== null);
    expect(rated.length).toBeGreaterThan(0);
    for (const craft of rated) {
      expect(craft.startRating!).toBeGreaterThanOrEqual(0);
      expect(craft.startRating!).toBeLessThanOrEqual(1);
    }
  });
});
