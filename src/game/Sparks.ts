import { AdditiveBlending, BoxGeometry, Group, InstancedMesh, Object3D, Vector3 } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { color, mix, positionLocal, smoothstep } from 'three/tsl';
import type { Craft } from './Craft';
import { Rng } from '@/core/Rng';
import { clamp01 } from '@/core/math';

/**
 * Sparks alive at once. Beyond this the oldest are recycled.
 *
 * Twice the count for twice as long is four times the pool, and each one is a
 * matrix write on a frame it is visible — still nothing next to a scene pass,
 * and the mesh only draws the live ones.
 */
const CAPACITY = 540;

/** Seconds a spark lives, before the per-spark spread. */
const LIFE = 0.84;
/** Metres per second downward. Well over gravity: sparks should fall, visibly. */
const FALL = 26;
/** How fast a spark bleeds speed, per second. */
const DRAG = 3.4;

/** Cross-section of a spark, and how many metres long one metre per second draws. */
const THICKNESS = 0.07;
const STREAK = 0.055;

/** Sparks thrown by a clean hit, at the lightest and heaviest contact. */
const BURST_MIN = 10;
const BURST_MAX = 68;
/** And per second while a hull is grinding along something. */
const SCRAPE_RATE = 110;

/** Below this, an impact is not worth a spark. */
const IMPACT_FLOOR = 0.04;
/** Metres per second under which a scrape stops throwing anything. */
const SCRAPE_FLOOR = 12;

const _velocity = new Vector3();
const _tangent = new Vector3();
const _target = new Vector3();

/**
 * The sparks a hull throws when it hits something.
 *
 * Purely a renderer: it reads each craft's telemetry, which already carries
 * where the contact was and which way the surface pushed, and never writes a
 * thing back. The simulation cannot tell whether this exists, which is what
 * keeps a replay identical to the race it recorded.
 *
 * One instanced mesh, one draw call, a fixed pool. A spark is a stretched box
 * pointed along its own velocity — the streak is the shape, not a texture — and
 * it fades by shrinking, which under additive blending is the same thing and
 * costs no per-instance colour.
 */
export class Sparks {
  readonly group = new Group();

  private readonly mesh: InstancedMesh;
  private readonly dummy = new Object3D();
  private readonly rng = new Rng(0x5c1a7b);

  private readonly position: Float32Array;
  private readonly velocity: Float32Array;
  /** Seconds left, and the length that life started at. */
  private readonly life: Float32Array;
  private readonly span: Float32Array;
  /** Where the next spark is written. The pool is a ring. */
  private cursor = 0;
  /** Carried between frames so a slow grind still emits whole sparks. */
  private scrapeDebt = 0;

  constructor() {
    this.group.name = 'sparks';

    this.position = new Float32Array(CAPACITY * 3);
    this.velocity = new Float32Array(CAPACITY * 3);
    this.life = new Float32Array(CAPACITY);
    this.span = new Float32Array(CAPACITY);

    // Origin at the tail, so scaling in z stretches the spark backwards from
    // where it is rather than about its middle.
    const geometry = new BoxGeometry(1, 1, 1);
    geometry.translate(0, 0, 0.5);

    this.mesh = new InstancedMesh(geometry, Sparks.material(), CAPACITY);
    this.mesh.name = 'spark-pool';
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.group.add(this.mesh);
  }

  /**
   * @param dt Render seconds. Zero while the panel is up, which is what stops
   *   a paused crash from quietly finishing its shower.
   */
  update(craft: readonly Craft[], dt: number): void {
    if (dt > 0) {
      for (const one of craft) this.emit(one, dt);
      this.integrate(dt);
    }
    this.draw();
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as { dispose(): void }).dispose();
  }

  /** Turns one craft's contact telemetry into sparks. */
  private emit(craft: Craft, dt: number): void {
    const tele = craft.telemetry;
    const speed = Math.abs(tele.speed);

    if (tele.impact > IMPACT_FLOOR) {
      const count = Math.round(BURST_MIN + (BURST_MAX - BURST_MIN) * clamp01(tele.impact));
      for (let i = 0; i < count; i++) this.spawn(craft, 1 + tele.impact * 2.2);
    }

    // A grind throws a steady stream rather than a burst, and only while there
    // is speed to grind with: a craft resting against a barrier makes none.
    if (tele.scraping && speed > SCRAPE_FLOOR) {
      this.scrapeDebt += dt * SCRAPE_RATE * clamp01((speed - SCRAPE_FLOOR) / 120);
      while (this.scrapeDebt >= 1) {
        this.scrapeDebt -= 1;
        this.spawn(craft, 0.8);
      }
    } else if (!tele.scraping) {
      this.scrapeDebt = 0;
    }
  }

  /** One spark, thrown off the contact point away from the surface. */
  private spawn(craft: Craft, force: number): void {
    const tele = craft.telemetry;
    const normal = tele.contactNormal;
    const rng = this.rng;

    // Along the surface, which is where most of a spark's speed comes from: it
    // is the craft's own motion with the part going into the wall removed.
    _tangent.copy(craft.state.velocity).addScaledVector(normal, -craft.state.velocity.dot(normal));

    _velocity
      .copy(_tangent)
      .multiplyScalar(0.22 + rng.next() * 0.16)
      .addScaledVector(normal, (2.5 + rng.next() * 6) * force)
      .addScaledVector(craft.state.up, (rng.next() - 0.35) * 5 * force);
    // A little scatter in every direction, so the shower is not a fan.
    _velocity.x += (rng.next() - 0.5) * 4;
    _velocity.y += (rng.next() - 0.5) * 4;
    _velocity.z += (rng.next() - 0.5) * 4;

    const i = this.cursor;
    this.cursor = (this.cursor + 1) % CAPACITY;

    this.position[i * 3] = tele.contact.x;
    this.position[i * 3 + 1] = tele.contact.y;
    this.position[i * 3 + 2] = tele.contact.z;
    this.velocity[i * 3] = _velocity.x;
    this.velocity[i * 3 + 1] = _velocity.y;
    this.velocity[i * 3 + 2] = _velocity.z;

    const life = LIFE * (0.55 + rng.next() * 0.9);
    this.life[i] = life;
    this.span[i] = life;
  }

  private integrate(dt: number): void {
    const decay = Math.exp(-dt * DRAG);
    for (let i = 0; i < CAPACITY; i++) {
      if (this.life[i]! <= 0) continue;
      this.life[i] = this.life[i]! - dt;

      const v = i * 3;
      this.velocity[v] = this.velocity[v]! * decay;
      this.velocity[v + 1] = this.velocity[v + 1]! * decay - FALL * dt;
      this.velocity[v + 2] = this.velocity[v + 2]! * decay;

      this.position[v] = this.position[v]! + this.velocity[v]! * dt;
      this.position[v + 1] = this.position[v + 1]! + this.velocity[v + 1]! * dt;
      this.position[v + 2] = this.position[v + 2]! + this.velocity[v + 2]! * dt;
    }
  }

  /** Writes one matrix per live spark, packed to the front of the instance list. */
  private draw(): void {
    let drawn = 0;

    for (let i = 0; i < CAPACITY; i++) {
      const left = this.life[i]!;
      if (left <= 0) continue;

      const v = i * 3;
      _velocity.set(this.velocity[v]!, this.velocity[v + 1]!, this.velocity[v + 2]!);
      const speed = _velocity.length();
      if (speed < 1e-4) continue;

      this.dummy.position.set(this.position[v]!, this.position[v + 1]!, this.position[v + 2]!);
      // `Object3D.lookAt` puts +Z on the target, and the box's own length runs
      // down +Z from its origin — so this aims the streak along its travel.
      _target.copy(this.dummy.position).add(_velocity);
      this.dummy.lookAt(_target);

      // Shrinking is the fade: under additive blending a thinner, shorter spark
      // adds less light, which is what a cooling one does.
      const fade = clamp01(left / this.span[i]!);
      this.dummy.scale.set(THICKNESS * fade, THICKNESS * fade, speed * STREAK * fade + 0.05);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(drawn, this.dummy.matrix);
      drawn++;
    }

    this.mesh.count = drawn;
    if (drawn > 0) this.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * White at the head, falling to orange down the streak.
   *
   * Emissive well past 1 so the bloom catches it: a spark that does not glow is
   * an orange splinter. Additive and depth-tested but not depth-writing, so a
   * shower reads as light rather than as a pile of little boxes.
   */
  private static material(): MeshBasicNodeMaterial {
    const material = new MeshBasicNodeMaterial();
    const alongStreak = smoothstep(0, 1, positionLocal.z);

    material.colorNode = mix(color(0xfff6e0).mul(7), color(0xff6a12).mul(2.6), alongStreak);
    material.blending = AdditiveBlending;
    material.transparent = true;
    material.depthWrite = false;
    return material;
  }
}
