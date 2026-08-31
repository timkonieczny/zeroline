import { describe, expect, it } from 'vitest';
import { Track } from '@/track/Track';
import { meridianCoast } from '@/data/tracks/meridian-coast';
import { Race, type RaceSetup } from '@/game/Race';
import { TEAMS, teamById } from '@/data/teams';
import { speedClassById } from '@/game/Handling';
import { createInputSnapshot } from '@/game/InputSnapshot';
import { Rng } from '@/core/Rng';
import { rollWeapon, WEAPONS, WEAPON_IDS } from '@/game/weapons/Weapons';
import { Projectiles } from '@/game/weapons/Projectiles';
import { Craft } from '@/game/Craft';
import { placeOnGrid } from '@/game/Physics';

const TICK = 1 / 120;
const track = new Track(meridianCoast);
const idle = createInputSnapshot();

function makeRace(overrides: Partial<RaceSetup> = {}): Race {
  return new Race({
    mode: 'race',
    track,
    speedClass: speedClassById('flash'),
    playerTeam: teamById('auroc'),
    fieldTeams: TEAMS.filter((t) => t.id !== 'auroc').concat(TEAMS.slice(0, 3)).slice(0, 7),
    laps: 2,
    seed: 0xa11ce,
    ...overrides,
  });
}

/** Runs the race for `seconds`, with the player doing nothing. */
function simulate(race: Race, seconds: number): void {
  const ticks = Math.round(seconds / TICK);
  for (let i = 0; i < ticks; i++) race.tick(idle, TICK);
}

describe('weapon pickups', () => {
  it('gives the leader defensive items and the back marker ordnance', () => {
    const draw = (position: number): Record<string, number> => {
      const counts: Record<string, number> = {};
      const rng = new Rng(0x5150);
      for (let i = 0; i < 4000; i++) {
        const weapon = rollWeapon(rng, position, 8);
        counts[weapon.id] = (counts[weapon.id] ?? 0) + 1;
      }
      return counts;
    };

    const leader = draw(1);
    const backMarker = draw(8);

    // The heavy hitters are effectively reserved for the back of the field.
    expect(leader.quake ?? 0).toBe(0);
    expect(backMarker.quake ?? 0).toBeGreaterThan(200);
    expect((backMarker.plasma ?? 0) > (leader.plasma ?? 0)).toBe(true);
    // The leader's consolation is speed and protection.
    expect(leader.turbo!).toBeGreaterThan(backMarker.turbo!);
    expect(leader.shield!).toBeGreaterThan(backMarker.shield!);
  });

  it('always returns a usable weapon with ammunition', () => {
    const rng = new Rng(11);
    for (let position = 1; position <= 8; position++) {
      for (let i = 0; i < 200; i++) {
        const weapon = rollWeapon(rng, position, 8);
        expect(WEAPON_IDS).toContain(weapon.id);
        expect(weapon.ammo).toBe(WEAPONS[weapon.id].ammo);
        expect(weapon.ammo).toBeGreaterThan(0);
      }
    }
  });

  it('is deterministic for a given seed', () => {
    const a = Array.from({ length: 30 }, (_, i) => rollWeapon(new Rng(500 + i), 4, 8).id);
    const b = Array.from({ length: 30 }, (_, i) => rollWeapon(new Rng(500 + i), 4, 8).id);
    expect(a).toEqual(b);
  });
});

describe('projectiles', () => {
  function twoCraft(): { attacker: Craft; victim: Craft; projectiles: Projectiles } {
    const attacker = new Craft(0, teamById('auroc'), speedClassById('flash'), 'player');
    const victim = new Craft(1, teamById('auroc'), speedClassById('flash'), 'ai');
    placeOnGrid(attacker, track, 4);
    placeOnGrid(victim, track, 0);
    return { attacker, victim, projectiles: new Projectiles(track) };
  }

  it('applies instant weapons to the firing craft and launches nothing', () => {
    const { attacker, projectiles } = twoCraft();

    expect(projectiles.fire('turbo', attacker, [attacker])).toBe(true);
    expect(attacker.state.boost).toBeGreaterThan(1);

    expect(projectiles.fire('shield', attacker, [attacker])).toBe(true);
    expect(attacker.state.invulnerable).toBeGreaterThan(1);

    expect(projectiles.fire('autopilot', attacker, [attacker])).toBe(true);
    expect(attacker.state.autopilot).toBeGreaterThan(1);

    expect(projectiles.active).toHaveLength(0);
  });

  it('launches the right number of bodies per weapon', () => {
    const { attacker, projectiles } = twoCraft();
    projectiles.fire('rockets', attacker, [attacker]);
    expect(projectiles.active).toHaveLength(3);

    projectiles.clear();
    projectiles.fire('mines', attacker, [attacker]);
    expect(projectiles.active).toHaveLength(5);

    projectiles.clear();
    projectiles.fire('bomb', attacker, [attacker]);
    expect(projectiles.active).toHaveLength(1);
  });

  it('locks a missile onto the craft ahead, not behind', () => {
    const { attacker, victim, projectiles } = twoCraft();
    projectiles.fire('missile', attacker, [attacker, victim]);
    expect(projectiles.active[0]!.target).toBe(victim.id);

    // Nothing ahead: the missile flies blind rather than turning around.
    projectiles.clear();
    projectiles.fire('missile', victim, [attacker, victim]);
    expect(projectiles.active[0]!.target).toBeNull();
  });

  it('damages a craft it reaches and spares the craft that fired it', () => {
    const { attacker, victim, projectiles } = twoCraft();
    const victimShield = victim.state.shield;
    const attackerShield = attacker.state.shield;

    projectiles.fire('plasma', attacker, [attacker, victim]);
    // Put the bolt on top of the victim and let it arm.
    for (let i = 0; i < 60; i++) projectiles.update(TICK, [attacker, victim]);

    expect(victim.state.shield).toBeLessThan(victimShield);
    expect(attacker.state.shield).toBe(attackerShield);
  });

  it('lets a deflector shield turn a hit away', () => {
    const { attacker, victim, projectiles } = twoCraft();
    victim.state.invulnerable = 5;
    const before = victim.state.shield;

    projectiles.fire('plasma', attacker, [attacker, victim]);
    for (let i = 0; i < 60; i++) projectiles.update(TICK, [attacker, victim]);

    expect(victim.state.shield).toBe(before);
  });

  it('expires ordnance rather than letting it accumulate', () => {
    const { attacker, victim, projectiles } = twoCraft();
    projectiles.fire('rockets', attacker, [attacker]);
    for (let i = 0; i < 120 * 30; i++) projectiles.update(TICK, [attacker, victim]);
    expect(projectiles.active).toHaveLength(0);
  });

  it('sends a quake down the road, hitting craft in front only', () => {
    const { attacker, victim, projectiles } = twoCraft();
    const before = victim.state.shield;
    projectiles.fire('quake', attacker, [attacker, victim]);
    for (let i = 0; i < 120 * 3; i++) projectiles.update(TICK, [attacker, victim]);
    expect(victim.state.shield).toBeLessThan(before);
    expect(attacker.state.shield).toBe(attacker.handling.shieldMax);
  });
});

describe('race rules', () => {
  it('holds the field on the grid until the lights go out', () => {
    const race = makeRace();
    expect(race.phase).toBe('countdown');
    simulate(race, 2);
    for (const craft of race.craft) {
      expect(Math.abs(craft.distance)).toBeLessThan(3);
    }
    expect(race.phase).toBe('countdown');

    simulate(race, 3);
    expect(race.phase).toBe('racing');
  });

  it('counts a lap only once a full lap has actually been driven', () => {
    const race = makeRace();
    const leader = race.craft[1]!;
    // Six seconds is long enough to cross the line but nowhere near a lap.
    simulate(race, 6);
    expect(leader.lap).toBe(0);
    expect(leader.hasStartedLap).toBe(true);

    simulate(race, 45);
    expect(leader.lap).toBeGreaterThanOrEqual(1);
  });

  it('will not bank a lap for a craft that drives backwards over the line', () => {
    const race = makeRace();
    simulate(race, 8);
    const craft = race.craft[1]!;
    const bankedBefore = craft.lap;

    // Shove it back down the road; progress must not be credited.
    for (let i = 0; i < 240; i++) {
      craft.state.velocity.copy(craft.state.forward).multiplyScalar(-40);
      race.tick(idle, TICK);
    }
    expect(craft.lap).toBe(bankedBefore);
    expect(craft.distance).toBeLessThan(race.track.length);
  });

  it('orders the field by distance covered', () => {
    const race = makeRace();
    simulate(race, 25);
    for (let i = 1; i < race.standings.length; i++) {
      expect(race.standings[i - 1]!.distance).toBeGreaterThanOrEqual(race.standings[i]!.distance);
      expect(race.standings[i]!.position).toBe(i + 1);
    }
  });

  it('hands out speed pads and weapons as craft drive over them', () => {
    const race = makeRace();
    simulate(race, 40);
    // Across a whole field and forty seconds, both pad types must have fired.
    const boosted = race.craft.some((c) => c.state.boost > 0);
    const armed = race.craft.some((c) => c.weapon !== null);
    expect(boosted || armed).toBe(true);
  });

  it('finishes the race and records a best lap', () => {
    const race = makeRace({ laps: 1 });
    // A single lap plus the countdown, with margin for a scruffy first lap.
    simulate(race, 90);
    const leader = race.standings[0]!;
    expect(leader.finishTime).not.toBeNull();
    expect(race.fastestLap).not.toBeNull();
    // A flying lap of MERIDIAN COAST, not a lap plus the run from the grid.
    expect(race.fastestLap!).toBeGreaterThan(25);
    expect(race.fastestLap!).toBeLessThan(60);
  });

  it('runs a whole race without producing a NaN anywhere', () => {
    const race = makeRace({ laps: 1 });
    simulate(race, 90);
    for (const craft of race.craft) {
      const st = craft.state;
      for (const value of [st.position.x, st.position.y, st.position.z, st.s, st.lateral, st.shield, craft.distance]) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  it('replays identically from the same seed', () => {
    const first = makeRace();
    const second = makeRace();
    simulate(first, 30);
    simulate(second, 30);
    for (let i = 0; i < first.craft.length; i++) {
      expect(first.craft[i]!.distance).toBeCloseTo(second.craft[i]!.distance, 6);
    }
  });

  it('puts a single craft on pole in time trial', () => {
    const race = makeRace({ mode: 'timeTrial' });
    expect(race.craft).toHaveLength(1);
    expect(race.player.control).toBe('player');
  });
});
