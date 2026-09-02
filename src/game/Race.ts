import type { Track } from '@/track/Track';
import { RacingLine } from '@/track/RacingLine';
import type { Team } from '@/data/teams';
import type { SpeedClass } from './Handling';
import { Craft, CRAFT_HALF_LENGTH, CRAFT_HALF_WIDTH } from './Craft';
import { placeOnGrid, respawn, stepCraft } from './Physics';
import { Driver, skillForGridSlot } from './AI';
import { copyInputSnapshot, createInputSnapshot, type InputSnapshot } from './InputSnapshot';
import { Rng } from '@/core/Rng';
import { clamp01, lerp, wrapDelta } from '@/core/math';
import { Vector3 } from 'three';
import { Projectiles } from './weapons/Projectiles';
import { rollWeapon, WEAPONS } from './weapons/Weapons';

export type RaceMode = 'race' | 'timeTrial';
export type RacePhase = 'countdown' | 'racing' | 'finished';

export interface RaceSetup {
  mode: RaceMode;
  track: Track;
  speedClass: SpeedClass;
  /** The team the player has chosen. */
  playerTeam: Team;
  /** Teams filling the rest of the grid, in order. Ignored in time trial. */
  fieldTeams: readonly Team[];
  laps: number;
  seed: number;
}

/** Seconds of countdown before the lights go out. */
export const COUNTDOWN = 4;
/** Seconds of boost a speed pad grants. */
const PAD_BOOST = 1.35;
/** Seconds before the same craft can trigger the same pad again. */
const PAD_COOLDOWN = 1.5;
/** Seconds before a craft may collect another weapon. */
const PICKUP_COOLDOWN = 2.5;
/**
 * How long before the lights go out the throttle has to be opened to earn a
 * getaway. Open it earlier than this and nothing is banked — there is no
 * penalty, because a standing start is punishing enough on its own.
 */
const START_WINDOW = 0.75;
/** Seconds of boost for the worst and best getaway inside that window. */
const START_BOOST_MIN = 0.7;
const START_BOOST_MAX = 2.2;
/** Throttle position that counts as opened. */
const THROTTLE_OPEN = 0.5;
/** Shield fraction below which the AI cashes a weapon in for energy. */
const AI_ABSORB_THRESHOLD = 0.45;
/** Metres within which the AI will take a shot at the craft ahead. */
const AI_FIRE_RANGE = 190;

const _delta = new Vector3();

/**
 * One race: the field, the clock, the rules.
 *
 * Everything here is deterministic given the setup's seed. The player's craft
 * is fed an `InputSnapshot` from the input layer and every other craft is fed
 * one by a `Driver`; beyond that the simulation cannot tell them apart, which
 * is what will make adding a network peer a matter of swapping the source.
 */
export class Race {
  readonly setup: RaceSetup;
  readonly track: Track;
  readonly line: RacingLine;
  readonly craft: Craft[] = [];
  readonly player: Craft;
  /** Ordered by race position, best first. Rebuilt each tick. */
  readonly standings: Craft[] = [];
  readonly projectiles: Projectiles;

  phase: RacePhase = 'countdown';
  /** Negative during the countdown, then counts up from zero. */
  time = -COUNTDOWN;
  /** Best lap set by anyone this race, in seconds. */
  fastestLap: number | null = null;
  fastestLapBy: Craft | null = null;

  private readonly drivers = new Map<Craft, Driver>();
  private readonly padCooldown = new Map<Craft, number>();
  /** Distance from each craft's grid slot to the start line, in metres. */
  private readonly startOffsets = new Map<Craft, number>();
  private readonly aiInput: InputSnapshot = createInputSnapshot();
  /** What a craft is actually fed while the lights are still on. */
  private readonly gridInput: InputSnapshot = createInputSnapshot();
  private readonly rng: Rng;

  constructor(setup: RaceSetup) {
    this.setup = setup;
    this.track = setup.track;
    this.line = new RacingLine(setup.track);
    this.rng = new Rng(setup.seed);
    this.projectiles = new Projectiles(setup.track);

    const teams = setup.mode === 'timeTrial' ? [setup.playerTeam] : [setup.playerTeam, ...setup.fieldTeams];
    teams.forEach((team, index) => {
      const control = index === 0 ? 'player' : 'ai';
      const craft = new Craft(index, team, setup.speedClass, control);
      this.craft.push(craft);
      if (control === 'ai') {
        this.drivers.set(
          craft,
          new Driver(
            craft,
            this.track,
            this.line,
            this.rng.fork(index),
            skillForGridSlot(index, teams.length, setup.speedClass.aiSkill),
          ),
        );
      }
    });
    this.player = this.craft[0]!;

    // Reverse grid: the player starts at the back, which is the only way a
    // single-player race has anything to do on lap one.
    this.craft.forEach((craft, index) => {
      const slot = setup.mode === 'timeTrial' ? 0 : this.craft.length - 1 - index;
      placeOnGrid(craft, this.track, slot);
      this.padCooldown.set(craft, 0);
      this.startOffsets.set(craft, wrapDelta(craft.state.s, this.track.startS, this.track.length));
    });
    this.updateStandings();
  }

  get finished(): boolean {
    return this.phase === 'finished';
  }

  /** Seconds remaining on the countdown, or 0 once racing. */
  get countdown(): number {
    return Math.max(0, -this.time);
  }

  /** Advances the whole race by one fixed tick. */
  tick(playerInput: InputSnapshot, dt: number): void {
    this.time += dt;
    const justStarted = this.phase === 'countdown' && this.time >= 0;
    if (justStarted) this.phase = 'racing';

    for (const craft of this.craft) {
      craft.beginTick();

      let input: InputSnapshot;
      if (craft.control === 'player' && craft.state.autopilot <= 0) {
        input = playerInput;
      } else {
        // AI craft, and any craft under autopilot, drive themselves.
        const driver = this.drivers.get(craft) ?? this.autopilotFor(craft);
        driver.update(this.aiInput, dt, this.craft, this.time);
        this.aiWeaponIntent(craft, this.aiInput);
        input = this.aiInput;
      }

      if (this.phase === 'countdown') {
        this.watchGetaway(craft, playerInput);
        // The intent has been recorded; now nothing on the grid actually moves.
        // Holding both airbrakes does not achieve that on its own, because
        // their drag is proportional to a speed that is still zero — an earlier
        // version did exactly that and the whole field crept off the line.
        copyInputSnapshot(input, this.gridInput);
        this.gridInput.thrust = 0;
        this.gridInput.steer = 0;
        this.gridInput.brakeLeft = 1;
        this.gridInput.brakeRight = 1;
        this.gridInput.sideshift = 0;
        this.gridInput.barrelRoll = 0;
        input = this.gridInput;
      }

      stepCraft(craft, input, this.track, dt);
      // Keep the resolved intent on the craft. Audio, effects and the HUD all
      // want to know what a craft was asked to do, not just what it did.
      copyInputSnapshot(input, craft.input);
      this.applyPads(craft, dt);
      this.applyWeapons(craft, input, dt);
      this.trackProgress(craft);
    }

    if (justStarted) this.awardGetaways();

    this.projectiles.update(dt, this.craft);
    this.resolveContacts();
    this.updateStandings();

    if (this.phase === 'racing' && this.player.finishTime !== null) this.phase = 'finished';
  }

  /**
   * Notes when a craft opens its throttle during the countdown.
   *
   * Only the moment the throttle was *opened* matters, so releasing and
   * re-applying resets the clock and a player cannot simply hold it down from
   * the first light and collect the bonus anyway.
   */
  private watchGetaway(craft: Craft, playerInput: InputSnapshot): void {
    const thrust = craft.control === 'player' ? playerInput.thrust : this.aiInput.thrust;
    if (thrust >= THROTTLE_OPEN) {
      if (craft.throttleOpenedAt === null) craft.throttleOpenedAt = this.time;
    } else {
      craft.throttleOpenedAt = null;
    }
  }

  /**
   * Pays out the standing start.
   *
   * The later inside the window the throttle came up, the better the getaway —
   * which rewards timing the lights rather than reacting to them.
   */
  private awardGetaways(): void {
    for (const craft of this.craft) {
      const openedAt = craft.throttleOpenedAt;
      if (openedAt === null || openedAt < -START_WINDOW) continue;
      const rating = clamp01(1 + openedAt / START_WINDOW);
      craft.startRating = rating;
      craft.state.boost = Math.max(craft.state.boost, lerp(START_BOOST_MIN, START_BOOST_MAX, rating));
    }
  }

  /** Lazily builds a driver for a player craft that has picked up an autopilot. */
  private autopilotFor(craft: Craft): Driver {
    const driver = new Driver(craft, this.track, this.line, this.rng.fork(craft.id + 99), {
      pace: 0.98,
      lag: 0.04,
      wander: 0,
      aggression: 0.5,
    });
    this.drivers.set(craft, driver);
    return driver;
  }

  /** Speed pads, and the free boost they hand out. */
  private applyPads(craft: Craft, dt: number): void {
    const cooldown = (this.padCooldown.get(craft) ?? 0) - dt;
    this.padCooldown.set(craft, Math.max(0, cooldown));
    if (cooldown > 0 || craft.state.height > 3) return;

    for (const pad of this.track.boostPads) {
      const along = wrapDelta(pad.s, craft.state.s, this.track.length);
      if (Math.abs(along) > pad.halfLength + CRAFT_HALF_LENGTH) continue;
      if (Math.abs(craft.state.lateral - pad.lateral) > pad.halfWidth + CRAFT_HALF_WIDTH) continue;
      craft.state.boost = Math.max(craft.state.boost, PAD_BOOST);
      craft.telemetry.hitBoostPad = true;
      this.padCooldown.set(craft, PAD_COOLDOWN);
      return;
    }
  }

  /**
   * Pickup pads, firing and absorbing.
   *
   * A craft holds at most one weapon. Firing spends a shot; absorbing throws the
   * whole thing away for shield energy. Both are edge-triggered from the input
   * snapshot, so the AI and the player go through exactly the same path.
   */
  private applyWeapons(craft: Craft, input: InputSnapshot, dt: number): void {
    craft.pickupCooldown = Math.max(0, craft.pickupCooldown - dt);

    if (craft.weapon) craft.weapon.age += dt;

    if (!craft.weapon && craft.pickupCooldown <= 0 && craft.state.height < 3) {
      for (const pad of this.track.pickupPads) {
        const along = wrapDelta(pad.s, craft.state.s, this.track.length);
        if (Math.abs(along) > pad.halfLength + CRAFT_HALF_LENGTH) continue;
        if (Math.abs(craft.state.lateral - pad.lateral) > pad.halfWidth + CRAFT_HALF_WIDTH) continue;
        craft.weapon = rollWeapon(this.rng.fork(craft.id * 977 + Math.floor(this.time * 60)), craft.position, this.craft.length);
        craft.pickupCooldown = PICKUP_COOLDOWN;
        break;
      }
    }

    if (!craft.weapon || this.phase === 'countdown') return;

    if (input.absorb) {
      craft.addShield(WEAPONS[craft.weapon.id].absorb);
      craft.weapon = null;
      return;
    }

    if (input.fire) {
      if (this.projectiles.fire(craft.weapon.id, craft, this.craft)) {
        craft.weapon.ammo -= 1;
        if (craft.weapon.ammo <= 0) craft.weapon = null;
      }
    }
  }

  /**
   * Decides what an AI craft does with the weapon it is holding.
   *
   * Deliberately simple and deliberately imperfect: it takes a shot when
   * something is in front, cashes in for energy when it is hurt, and otherwise
   * holds. An AI that used every item optimally would be miserable to race.
   */
  private aiWeaponIntent(craft: Craft, input: InputSnapshot): void {
    const weapon = craft.weapon;
    if (!weapon || this.phase === 'countdown') return;
    const def = WEAPONS[weapon.id];

    if (craft.shieldFraction < AI_ABSORB_THRESHOLD && def.kind === 'offensive') {
      input.absorb = true;
      return;
    }

    if (def.kind !== 'offensive') {
      // Utility and defensive items are used as soon as they are worth using.
      if (weapon.age > 0.8) input.fire = true;
      return;
    }

    for (const other of this.craft) {
      if (other === craft || other.state.eliminated) continue;
      const gap = wrapDelta(craft.state.s, other.state.s, this.track.length);
      const behind = weapon.id === 'mines' || weapon.id === 'bomb';
      const inRange = behind ? gap < 0 && gap > -AI_FIRE_RANGE : gap > 0 && gap < AI_FIRE_RANGE;
      if (inRange && Math.abs(other.state.lateral - craft.state.lateral) < 14) {
        input.fire = true;
        return;
      }
    }
  }

  /**
   * Lap counting and total distance.
   *
   * Progress is tracked as a monotonic distance rather than by watching for a
   * line crossing, so a craft that gets spun round and briefly drives backwards
   * cannot bank a lap, and cutting the course cannot skip one.
   */
  private trackProgress(craft: Craft): void {
    const previous = craft.previous.s;
    const current = craft.state.s;
    const step = wrapDelta(previous, current, this.track.length);
    // Ignore teleports: a respawn moves `s` a long way in one tick.
    if (Math.abs(step) < this.track.length * 0.25) craft.distance += step;

    if (craft.state.eliminated) {
      respawn(craft, this.track);
      craft.state.shield = craft.handling.shieldMax * 0.35;
      craft.state.eliminated = false;
      return;
    }

    // The grid sits behind the line, and the first crossing starts lap one
    // rather than completing it. Real motorsport counts the other way, but a
    // three-lap race that is really two laps plus a run-up feels short, and
    // this is the convention the genre uses.
    const lapDistance = this.track.length;
    const progressed = craft.distance - (this.startOffsets.get(craft) ?? 0);
    if (progressed >= 0 && !craft.hasStartedLap) {
      // Lap timing starts at the line, so a best lap is a true flying lap
      // rather than a lap plus however far the grid slot sat back.
      craft.hasStartedLap = true;
      craft.lastLapAt = this.time;
    }
    const completed = progressed >= 0 ? Math.floor(progressed / lapDistance) : 0;
    if (completed > craft.lap && craft.finishTime === null) {
      craft.lap = completed;
      const lapTime = this.time - craft.lastLapAt;
      craft.lastLapAt = this.time;
      if (this.time > 0 && lapTime > 1) {
        if (craft.bestLap === null || lapTime < craft.bestLap) craft.bestLap = lapTime;
        if (this.fastestLap === null || lapTime < this.fastestLap) {
          this.fastestLap = lapTime;
          this.fastestLapBy = craft;
        }
      }
      if (craft.lap >= this.setup.laps) {
        craft.finishTime = this.time;
        craft.finishDistance = craft.distance;
      }
    }
  }

  /** Craft-versus-craft contact: a shove, not a crash. */
  private resolveContacts(): void {
    for (let i = 0; i < this.craft.length; i++) {
      for (let j = i + 1; j < this.craft.length; j++) {
        const a = this.craft[i]!;
        const b = this.craft[j]!;
        _delta.subVectors(b.state.position, a.state.position);
        const distance = _delta.length();
        const minimum = CRAFT_HALF_WIDTH * 2.1;
        if (distance > minimum || distance < 1e-4) continue;

        _delta.multiplyScalar(1 / distance);
        const overlap = minimum - distance;
        // Push apart by mass ratio, so the heavy car wins the argument.
        const total = a.handling.mass + b.handling.mass;
        a.state.position.addScaledVector(_delta, (-overlap * b.handling.mass) / total);
        b.state.position.addScaledVector(_delta, (overlap * a.handling.mass) / total);

        const relative = b.state.velocity.dot(_delta) - a.state.velocity.dot(_delta);
        if (relative < 0) {
          const impulse = -relative * 0.55;
          a.state.velocity.addScaledVector(_delta, (-impulse * b.handling.mass) / total);
          b.state.velocity.addScaledVector(_delta, (impulse * a.handling.mass) / total);
          const damage = Math.min(1, -relative / 40);
          a.applyDamage(damage * 6);
          b.applyDamage(damage * 6);
          a.telemetry.impact = Math.max(a.telemetry.impact, damage * 0.6);
          b.telemetry.impact = Math.max(b.telemetry.impact, damage * 0.6);
        }
      }
    }
  }

  private updateStandings(): void {
    this.standings.length = 0;
    for (const craft of this.craft) this.standings.push(craft);
    this.standings.sort((a, b) => {
      // Finishers first, in the order they finished.
      if (a.finishTime !== null || b.finishTime !== null) {
        if (a.finishTime === null) return 1;
        if (b.finishTime === null) return -1;
        return a.finishTime - b.finishTime;
      }
      return b.distance - a.distance;
    });
    this.standings.forEach((craft, index) => {
      craft.position = index + 1;
    });
  }
}
