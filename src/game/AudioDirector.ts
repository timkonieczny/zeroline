import type { Audio } from '@/core/Audio';
import type { Race } from './Race';
import type { StandSite } from '@/track/scenery/Grandstands';
import { clamp01 } from '@/core/math';

/**
 * Metres of road either side of a stand over which its crowd is audible.
 *
 * Generous, because arriving at a full grandstand in silence and then having it
 * switch on is worse than hearing it early. The falloff is squared, so most of
 * this distance is very quiet.
 */
const EARSHOT = 280;
/**
 * Metres over which a stand swings from ahead of the listener to beside them.
 *
 * A stand on the right stays on the right the whole way past; what changes is
 * how far off-centre it sounds. Alongside it is hard over, and from the far end
 * of the straight it is ahead.
 */
const PAN_SPREAD = 90;

/** How loud the nearest stand is, and how far off-centre. */
export interface CrowdPlacement {
  level: number;
  pan: number;
}

/**
 * Where the crowd sits relative to a craft at arc length `s`.
 *
 * Pure, and worth being pure: the arc length wraps, so the stand at the grid is
 * beside a craft coming out of the last corner and not a whole lap away from
 * it. Get that wrong and the pit straight's crowd cuts out at the line, which
 * is the one place it must not.
 */
export function placeCrowd(
  s: number,
  length: number,
  stands: readonly StandSite[],
): CrowdPlacement {
  let nearest = Infinity;
  let side = 0;
  for (const stand of stands) {
    let delta = s - stand.s;
    if (delta > length * 0.5) delta -= length;
    if (delta < -length * 0.5) delta += length;
    if (Math.abs(delta) >= Math.abs(nearest)) continue;
    nearest = delta;
    side = stand.side;
  }
  if (side === 0) return { level: 0, pan: 0 };

  const distance = clamp01(1 - Math.abs(nearest) / EARSHOT);
  return {
    // Squared, so the roar is concentrated where the stand actually is rather
    // than washing over half the lap.
    level: distance * distance,
    pan: side * clamp01(1 - Math.abs(nearest) / PAN_SPREAD),
  };
}

/**
 * Turns race state into sound.
 *
 * The simulation deliberately knows nothing about audio — it exposes state, and
 * this watches that state change. Boosts, pickups, hits and detonations are all
 * detected as edges here rather than being fired from inside the physics, which
 * keeps the simulation deterministic and side-effect free and means a replay or
 * a rewind cannot double-trigger a sound.
 */
export class AudioDirector {
  private lastBoosting = false;
  private lastWeapon: string | null = null;
  private lastDetonations = 0;
  private lastCountdown = -1;
  private scrapeCooldown = 0;
  private stands: readonly StandSite[] = [];

  constructor(
    private readonly audio: Audio,
    private race: Race,
  ) {}

  /** Tells the director where the crowds are. Fixed for a circuit. */
  setStands(stands: readonly StandSite[]): void {
    this.stands = stands;
  }

  /** Points the director at a new race, e.g. after a restart. */
  attach(race: Race): void {
    this.race = race;
    this.lastBoosting = false;
    this.lastWeapon = null;
    this.lastDetonations = 0;
    this.lastCountdown = -1;
  }

  update(dt: number): void {
    if (!this.audio.ready) return;
    const race = this.race;
    const player = race.player;

    this.audio.updateEngine(
      clamp01(player.telemetry.speedFraction),
      player.input.thrust,
      player.state.boost > 0,
    );

    const boosting = player.state.boost > 0;
    if (boosting && !this.lastBoosting) this.audio.boost();
    this.lastBoosting = boosting;

    const weapon = player.weapon?.id ?? null;
    if (weapon && weapon !== this.lastWeapon) this.audio.pickup();
    // Losing a weapon without a detonation nearby means it was absorbed.
    if (!weapon && this.lastWeapon) this.audio.absorb();
    this.lastWeapon = weapon;

    // Detonations are a growing list within a tick; count the new ones.
    const detonations = race.projectiles.detonations;
    const fresh = detonations.filter((d) => d.age < dt * 2).length;
    if (fresh > 0 && detonations.length !== this.lastDetonations) {
      const biggest = detonations.reduce((max, d) => Math.max(max, d.radius), 0);
      this.audio.explosion(clamp01(biggest / 16));
      this.audio.duckMusic(0.35, 0.6);
    }
    this.lastDetonations = detonations.length;

    if (player.telemetry.impact > 0.06) {
      this.audio.impact(player.telemetry.impact);
      if (player.telemetry.impact > 0.4) this.audio.duckMusic(0.4, 0.7);
    }

    // Scraping is continuous, so it is rate-limited rather than edge-triggered.
    this.scrapeCooldown = Math.max(0, this.scrapeCooldown - dt);
    if (player.telemetry.scraping && this.scrapeCooldown <= 0) {
      this.audio.scrape(clamp01(player.telemetry.speedFraction));
      this.scrapeCooldown = 0.07;
    }

    this.updateCrowd(player.state.s, clamp01(player.telemetry.speedFraction), race.track.length);

    if (race.phase === 'countdown') {
      const remaining = Math.ceil(race.countdown);
      if (remaining !== this.lastCountdown && remaining > 0) {
        this.audio.countdownTick(false);
        this.lastCountdown = remaining;
      }
    } else if (this.lastCountdown > 0) {
      this.audio.countdownTick(true);
      this.lastCountdown = 0;
    }
  }

  /**
   * Points the crowd noise at whichever stand the player is nearest.
   *
   * One source for the lot of them rather than one per stand. They are far
   * enough apart that only one is ever in earshot, and a single panned bed is
   * both cheaper and steadier than several crossfading against each other.
   */
  private updateCrowd(s: number, speed: number, length: number): void {
    const crowd = placeCrowd(s, length, this.stands);
    this.audio.setCrowd(crowd.level, crowd.pan, speed);
  }
}
