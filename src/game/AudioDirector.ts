import type { Audio } from '@/core/Audio';
import type { Race } from './Race';
import { clamp01 } from '@/core/math';

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

  constructor(
    private readonly audio: Audio,
    private race: Race,
  ) {}

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
}
