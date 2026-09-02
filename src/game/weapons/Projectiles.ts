import { Vector3 } from 'three';
import type { Craft } from '../Craft';
import { CRAFT_HALF_WIDTH } from '../Craft';
import type { Track } from '@/track/Track';
import { clamp01, wrapDelta } from '@/core/math';
import type { WeaponId } from './Weapons';

export type ProjectileKind = 'rocket' | 'missile' | 'mine' | 'bomb' | 'plasma' | 'quake';

export interface Projectile {
  kind: ProjectileKind;
  /** Craft id that fired it. Its own ordnance cannot hit it. */
  owner: number;
  position: Vector3;
  velocity: Vector3;
  /** Arc length, kept current so quake and mines can reason in track space. */
  s: number;
  lateral: number;
  /** Seconds left before it expires. */
  life: number;
  /** Seconds before it can hurt anyone. Stops a dropped mine killing its owner. */
  arming: number;
  /** Craft id being tracked, for the missile. */
  target: number | null;
  /** Set on the tick it dies, so the renderer can spawn a detonation. */
  detonated: boolean;
  /** Blast radius in metres when it goes off. */
  blastRadius: number;
  /** Damage at the centre of the blast. */
  damage: number;
}

export interface Detonation {
  position: Vector3;
  radius: number;
  /** Seconds since it happened. */
  age: number;
  kind: ProjectileKind;
}

/** How each projectile kind behaves. Speeds are m/s, lifetimes seconds. */
const SPEC: Record<ProjectileKind, { speed: number; life: number; arming: number; blast: number; damage: number }> = {
  rocket: { speed: 240, life: 3.2, arming: 0.05, blast: 6, damage: 16 },
  missile: { speed: 200, life: 6, arming: 0.1, blast: 9, damage: 30 },
  mine: { speed: 0, life: 22, arming: 0.6, blast: 5, damage: 14 },
  bomb: { speed: 0, life: 26, arming: 0.8, blast: 16, damage: 34 },
  plasma: { speed: 420, life: 2.4, arming: 0.02, blast: 5, damage: 52 },
  quake: { speed: 150, life: 5, arming: 0.15, blast: 0, damage: 26 },
};

/** How hard a missile can turn, in radians per second. */
const MISSILE_TURN_RATE = 2.6;
/** Seconds of stun a quake wave inflicts, felt as a hard yaw and a speed loss. */
const QUAKE_SPEED_LOSS = 0.55;
/** Metres the deflector shield pushes damage away — cosmetic, but it reads. */
const SHIELD_SECONDS = 6;
/** Seconds of autopilot one pickup grants. */
const AUTOPILOT_SECONDS = 5;
/** Seconds of boost a turbo grants. */
const TURBO_SECONDS = 2.1;

const _forward = new Vector3();
const _right = new Vector3();
const _delta = new Vector3();
const _desired = new Vector3();
const _axis = new Vector3();

/**
 * Every live piece of ordnance in the race.
 *
 * Projectiles are simulated in world space but resolved against the track's own
 * frame, which is what lets a mine sit flat on a banked corner and a quake wave
 * travel along the road rather than through the scenery.
 *
 * Like the rest of the simulation this is deterministic and allocation-free on
 * the hot path: the pool is reused, and nothing here reads the clock.
 */
export class Projectiles {
  readonly active: Projectile[] = [];
  /** Detonations from this tick onward, consumed by the renderer. */
  readonly detonations: Detonation[] = [];

  private readonly pool: Projectile[] = [];

  constructor(private readonly track: Track) {}

  private take(): Projectile {
    const p = this.pool.pop();
    if (p) return p;
    return {
      kind: 'rocket',
      owner: -1,
      position: new Vector3(),
      velocity: new Vector3(),
      s: 0,
      lateral: 0,
      life: 0,
      arming: 0,
      target: null,
      detonated: false,
      blastRadius: 0,
      damage: 0,
    };
  }

  private spawn(kind: ProjectileKind, craft: Craft, offsetLateral: number, backwards: boolean): Projectile {
    const spec = SPEC[kind];
    const p = this.take();
    const st = craft.state;

    _forward.copy(st.forward);
    _right.crossVectors(st.forward, st.up).normalize();

    p.kind = kind;
    p.owner = craft.id;
    p.position
      .copy(st.position)
      .addScaledVector(_forward, backwards ? -6 : 6)
      .addScaledVector(_right, offsetLateral);
    p.velocity.copy(_forward).multiplyScalar(backwards ? -spec.speed : spec.speed);
    if (spec.speed === 0) p.velocity.copy(st.velocity).multiplyScalar(0.2);
    p.s = st.s;
    p.lateral = st.lateral + offsetLateral;
    p.life = spec.life;
    p.arming = spec.arming;
    p.target = null;
    p.detonated = false;
    p.blastRadius = spec.blast;
    p.damage = spec.damage;

    this.active.push(p);
    return p;
  }

  /**
   * Fires `weapon` from `craft`. Returns true if anything was actually launched;
   * instant effects like turbo and autopilot apply themselves and return true.
   */
  fire(weapon: WeaponId, craft: Craft, field: readonly Craft[]): boolean {
    const st = craft.state;
    switch (weapon) {
      case 'turbo':
        st.boost = Math.max(st.boost, TURBO_SECONDS);
        st.boostFromTurbo = true;
        return true;

      case 'shield':
        st.invulnerable = Math.max(st.invulnerable, SHIELD_SECONDS);
        return true;

      case 'autopilot':
        st.autopilot = Math.max(st.autopilot, AUTOPILOT_SECONDS);
        return true;

      case 'rockets':
        // A spread, so a near miss still threatens the craft alongside.
        for (const offset of [-2.2, 0, 2.2]) this.spawn('rocket', craft, offset, false);
        return true;

      case 'missile': {
        const p = this.spawn('missile', craft, 0, false);
        p.target = this.pickTarget(craft, field);
        return true;
      }

      case 'mines': {
        const halfWidth = this.track.spline.widthAtS(st.s) * 0.5 - 3;
        for (let i = 0; i < 5; i++) {
          // Spread across the road, not around the craft: a mine field should
          // deny the whole lane rather than shadow the car that laid it.
          const lateral = ((i / 4) * 2 - 1) * halfWidth - st.lateral;
          this.spawn('mine', craft, lateral, true);
        }
        return true;
      }

      case 'bomb':
        this.spawn('bomb', craft, 0, true);
        return true;

      case 'plasma':
        this.spawn('plasma', craft, 0, false);
        return true;

      case 'quake':
        this.spawn('quake', craft, 0, false);
        return true;

      default:
        return false;
    }
  }

  /** Nearest craft ahead of `craft` on the road, or null. */
  private pickTarget(craft: Craft, field: readonly Craft[]): number | null {
    let best: number | null = null;
    let bestGap = Infinity;
    for (const other of field) {
      if (other.id === craft.id || other.state.eliminated) continue;
      const gap = wrapDelta(craft.state.s, other.state.s, this.track.length);
      if (gap <= 0 || gap > 320) continue;
      if (gap < bestGap) {
        bestGap = gap;
        best = other.id;
      }
    }
    return best;
  }

  /** Advances every projectile and resolves hits. */
  update(dt: number, field: readonly Craft[]): void {
    for (const d of this.detonations) d.age += dt;
    // Detonations are visual only; drop them once the effect has played out.
    for (let i = this.detonations.length - 1; i >= 0; i--) {
      if (this.detonations[i]!.age > 1.4) this.detonations.splice(i, 1);
    }

    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i]!;
      p.life -= dt;
      p.arming = Math.max(0, p.arming - dt);

      if (p.kind === 'missile' && p.target !== null) this.steerMissile(p, field, dt);
      if (p.kind === 'quake') this.advanceQuake(p, field, dt);
      else p.position.addScaledVector(p.velocity, dt);

      const hit = this.track.collision.query(p.position, p.s);
      p.s = hit.s;
      p.lateral = hit.lateral;

      // Mines and bombs settle onto the road; everything else flies through.
      if (p.kind === 'mine' || p.kind === 'bomb') {
        this.track.collision.toWorld(p.s, p.lateral, 1.1, p.position);
        p.velocity.multiplyScalar(Math.exp(-dt * 6));
      }

      let dead = p.life <= 0;

      // Fast projectiles die on the barrier; slow ones just stop.
      if (!dead && p.kind !== 'quake' && Math.abs(hit.lateral) > hit.width * 0.5) dead = true;

      if (!dead && p.arming <= 0 && p.kind !== 'quake') {
        const struck = this.findVictim(p, field);
        if (struck) {
          this.applyBlast(p, field);
          dead = true;
        }
      }

      if (dead) {
        if (p.kind !== 'quake' && p.blastRadius > 0) this.applyBlast(p, field);
        this.detonations.push({ position: p.position.clone(), radius: p.blastRadius, age: 0, kind: p.kind });
        this.active.splice(i, 1);
        this.pool.push(p);
      }
    }
  }

  private steerMissile(p: Projectile, field: readonly Craft[], dt: number): void {
    const target = field.find((c) => c.id === p.target);
    if (!target || target.state.eliminated) {
      p.target = null;
      return;
    }
    _desired.subVectors(target.state.position, p.position).normalize();
    _forward.copy(p.velocity).normalize();
    const angle = Math.acos(Math.min(1, Math.max(-1, _forward.dot(_desired))));
    if (angle > 1e-4) {
      _axis.crossVectors(_forward, _desired).normalize();
      const turn = Math.min(angle, MISSILE_TURN_RATE * dt);
      _forward.applyAxisAngle(_axis, turn);
      p.velocity.copy(_forward).multiplyScalar(SPEC.missile.speed);
    }
  }

  /**
   * The quake is not really a projectile: it is a moving band of arc length that
   * hits everything on the road within it, which is why it cannot be dodged
   * sideways and why it does not care about walls.
   */
  private advanceQuake(p: Projectile, field: readonly Craft[], dt: number): void {
    const travelled = SPEC.quake.speed * dt;
    p.s = this.track.spline.wrapS(p.s + travelled);
    this.track.collision.toWorld(p.s, 0, 1, p.position);

    if (p.arming > 0) return;
    for (const craft of field) {
      if (craft.id === p.owner || craft.state.eliminated) continue;
      const gap = wrapDelta(p.s, craft.state.s, this.track.length);
      if (Math.abs(gap) > 12) continue;
      if (craft.state.height > 6) continue; // Jumped it.
      craft.applyDamage(SPEC.quake.damage * dt * 4);
      craft.state.velocity.multiplyScalar(1 - QUAKE_SPEED_LOSS * dt * 4);
      craft.telemetry.impact = Math.max(craft.telemetry.impact, 0.7);
    }
  }

  private findVictim(p: Projectile, field: readonly Craft[]): Craft | null {
    const reach = CRAFT_HALF_WIDTH + (p.kind === 'mine' ? 2 : 3);
    for (const craft of field) {
      if (craft.id === p.owner || craft.state.eliminated) continue;
      _delta.subVectors(craft.state.position, p.position);
      if (_delta.lengthSq() < reach * reach) return craft;
    }
    return null;
  }

  /** Damage falls off with distance from the blast centre. */
  private applyBlast(p: Projectile, field: readonly Craft[]): void {
    if (p.blastRadius <= 0) return;
    for (const craft of field) {
      if (craft.state.eliminated) continue;
      // A craft's own bomb can still catch it if it lingers.
      if (craft.id === p.owner && p.kind !== 'bomb' && p.kind !== 'mine') continue;
      const distance = craft.state.position.distanceTo(p.position);
      if (distance > p.blastRadius) continue;
      const falloff = clamp01(1 - distance / p.blastRadius);
      craft.applyDamage(p.damage * falloff);
      craft.telemetry.impact = Math.max(craft.telemetry.impact, falloff);
      _delta.subVectors(craft.state.position, p.position).normalize();
      craft.state.velocity.addScaledVector(_delta, falloff * 14);
    }
  }

  clear(): void {
    for (const p of this.active) this.pool.push(p);
    this.active.length = 0;
    this.detonations.length = 0;
  }
}
