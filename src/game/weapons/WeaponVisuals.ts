import {
  AdditiveBlending,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Object3D,
  PointLight,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import { color, float, mix, oneMinus, positionLocal, smoothstep, uv } from 'three/tsl';
import type { Projectiles, ProjectileKind } from './Projectiles';
import { clamp01 } from '@/core/math';

/** Instances reserved per projectile kind. Beyond this, extras are not drawn. */
const CAPACITY = 64;
/** Detonation flashes rendered at once. */
const FLASH_CAPACITY = 12;
/** How long a detonation flash lasts, in seconds. */
const FLASH_LIFE = 0.55;

/** Colour and size of each kind of ordnance. */
const LOOK: Record<ProjectileKind, { colour: number; radius: number }> = {
  rocket: { colour: 0xff9a4c, radius: 0.55 },
  missile: { colour: 0xff5c7a, radius: 0.75 },
  mine: { colour: 0xffd34c, radius: 1.1 },
  bomb: { colour: 0xff4cd8, radius: 1.6 },
  plasma: { colour: 0x8cf0ff, radius: 0.9 },
  quake: { colour: 0xffa832, radius: 2.2 },
};

const _matrix = new Matrix4();
const _position = new Vector3();
const _quaternion = new Quaternion();
const _scale = new Vector3();

/**
 * Draws whatever ordnance is currently in the air.
 *
 * One instanced mesh per kind, sized once and reused, so a full eight-car
 * firefight costs six draw calls rather than a hundred. The projectiles
 * themselves are emissive and sit well above 1.0 in linear space, which is what
 * puts them through the bloom threshold and makes a missile read as a light
 * source rather than a coloured pebble.
 *
 * A single moving point light is attached to the most recent detonation. One is
 * enough: the flash is over in half a second and nobody counts them.
 */
export class WeaponVisuals {
  readonly group = new Group();

  private readonly meshes = new Map<ProjectileKind, InstancedMesh>();
  private readonly flashes: InstancedMesh;
  private readonly flashLight: PointLight;
  private readonly dummy = new Object3D();

  constructor() {
    this.group.name = 'ordnance';

    for (const kind of Object.keys(LOOK) as ProjectileKind[]) {
      const look = LOOK[kind];
      const geometry = new IcosahedronGeometry(look.radius, kind === 'plasma' ? 2 : 1);
      const mesh = new InstancedMesh(geometry, WeaponVisuals.ordnanceMaterial(look.colour), CAPACITY);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.name = `ordnance:${kind}`;
      this.meshes.set(kind, mesh);
      this.group.add(mesh);
    }

    this.flashes = new InstancedMesh(new SphereGeometry(1, 16, 12), WeaponVisuals.flashMaterial(), FLASH_CAPACITY);
    this.flashes.count = 0;
    this.flashes.frustumCulled = false;
    this.group.add(this.flashes);

    this.flashLight = new PointLight(0xffb066, 0, 90, 2);
    this.group.add(this.flashLight);
  }

  /** Rebuilds the instance buffers from this frame's projectile state. */
  update(projectiles: Projectiles): void {
    const counts = new Map<ProjectileKind, number>();
    for (const kind of this.meshes.keys()) counts.set(kind, 0);

    for (const p of projectiles.active) {
      const mesh = this.meshes.get(p.kind);
      if (!mesh) continue;
      const index = counts.get(p.kind)!;
      if (index >= CAPACITY) continue;

      this.dummy.position.copy(p.position);
      // Stretch fast ordnance along its own velocity, which reads as a tracer.
      const speed = p.velocity.length();
      if (speed > 20) {
        this.dummy.quaternion.setFromUnitVectors(_position.set(0, 0, 1), _scale.copy(p.velocity).normalize());
        this.dummy.scale.set(1, 1, 1 + Math.min(4, speed / 90));
      } else {
        this.dummy.quaternion.identity();
        this.dummy.scale.setScalar(1);
      }
      this.dummy.updateMatrix();
      mesh.setMatrixAt(index, this.dummy.matrix);
      counts.set(p.kind, index + 1);
    }

    for (const [kind, mesh] of this.meshes) {
      mesh.count = counts.get(kind) ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
    }

    // Detonations: an expanding, fading shell.
    let flashCount = 0;
    let brightest = 0;
    for (const detonation of projectiles.detonations) {
      if (flashCount >= FLASH_CAPACITY) break;
      const t = clamp01(detonation.age / FLASH_LIFE);
      if (t >= 1) continue;
      const radius = detonation.radius * (0.35 + t * 1.5);
      _matrix.compose(
        _position.copy(detonation.position),
        _quaternion.identity(),
        _scale.setScalar(Math.max(0.01, radius)),
      );
      this.flashes.setMatrixAt(flashCount, _matrix);
      flashCount++;

      const power = (1 - t) * detonation.radius;
      if (power > brightest) {
        brightest = power;
        this.flashLight.position.copy(detonation.position);
      }
    }
    this.flashes.count = flashCount;
    this.flashes.instanceMatrix.needsUpdate = true;
    this.flashLight.intensity = brightest * 260;
  }

  dispose(): void {
    for (const mesh of this.meshes.values()) {
      mesh.geometry.dispose();
      (mesh.material as { dispose(): void }).dispose();
    }
    this.flashes.geometry.dispose();
    (this.flashes.material as { dispose(): void }).dispose();
  }

  /** Emissive core with a hotter rim, so it holds its shape through the bloom. */
  private static ordnanceMaterial(hex: number): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    const rim = smoothstep(float(0.2), float(0.9), oneMinus(positionLocal.normalize().z.abs()));
    material.colorNode = color(hex).mul(0.3);
    material.emissiveNode = mix(color(hex), color(0xffffff), rim.mul(0.55)).mul(6);
    material.roughnessNode = float(0.4);
    return material;
  }

  /** Additive shell that fades from white to the blast colour as it expands. */
  private static flashMaterial(): MeshBasicNodeMaterial {
    const material = new MeshBasicNodeMaterial();
    const edge = smoothstep(float(0.35), float(0.5), uv().y.sub(0.5).abs());
    material.colorNode = mix(color(0xfff0d0), color(0xff8840), edge);
    material.opacityNode = float(0.55);
    material.transparent = true;
    material.blending = AdditiveBlending;
    material.depthWrite = false;
    return material;
  }
}
