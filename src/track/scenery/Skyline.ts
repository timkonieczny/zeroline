import { BoxGeometry, Color, Group, InstancedMesh, Object3D, Vector3 } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { color, float, fract, instanceIndex, mix, sin, smoothstep, step, uv, vec3 } from 'three/tsl';
import type { Track } from '../Track';
import type { SceneryTheme } from '../TrackTypes';
import { Rng } from '@/core/Rng';
import { lerp } from '@/core/math';

/** Metres between placement attempts along the circuit. */
const STRIDE = 26;
/** Instances reserved for the skyline. */
const CAPACITY = 900;

interface ThemeRule {
  /** Chance a building is placed at all, per side per stride. */
  density: number;
  /** Distance from the road edge, in metres. */
  offset: [min: number, max: number];
  /** Footprint width and depth, in metres. */
  footprint: [min: number, max: number];
  height: [min: number, max: number];
  /** How much of the facade is lit glass, 0..1. */
  glass: number;
}

/**
 * What each district is built out of.
 *
 * The rules are deliberately extreme between themes — the canyon crowds the road
 * with tall slabs, the terminal is nothing but long low sheds — because at
 * 400 km/h a district only registers if its silhouette is unmistakable.
 */
const THEMES: Record<SceneryTheme, ThemeRule> = {
  harbour: { density: 0.55, offset: [26, 130], footprint: [16, 42], height: [14, 62], glass: 0.4 },
  canyon: { density: 0.85, offset: [12, 46], footprint: [12, 26], height: [50, 155], glass: 0.25 },
  terminal: { density: 0.7, offset: [18, 70], footprint: [30, 70], height: [10, 26], glass: 0.15 },
  towers: { density: 0.5, offset: [34, 180], footprint: [18, 40], height: [70, 220], glass: 0.75 },
  stadium: { density: 0.6, offset: [22, 90], footprint: [26, 60], height: [18, 46], glass: 0.3 },
};

const _dummy = new Object3D();
const _position = new Vector3();

/**
 * The city the circuit runs through.
 *
 * One instanced mesh, one draw call, a few hundred blocks placed once at load
 * time by walking the centreline and offsetting sideways past the barrier. There
 * is no per-frame cost at all: the buildings never move, and their windows are
 * animated in the shader from the instance index rather than from the CPU.
 *
 * Colour is per-instance, biased white with a little variation, which is what
 * keeps the Mirror's Edge read: a bright, near-monochrome city with the circuit's
 * accent colours as the only saturation in frame.
 */
export class Skyline {
  readonly group = new Group();
  private readonly mesh: InstancedMesh;

  constructor(track: Track) {
    const rng = new Rng(0xb0d1e5);
    const geometry = new BoxGeometry(1, 1, 1);
    // Origin at the base, so scaling a building grows it upward.
    geometry.translate(0, 0.5, 0);

    this.mesh = new InstancedMesh(geometry, Skyline.material(), CAPACITY);
    this.mesh.name = 'skyline';
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.count = 0;

    let count = 0;
    const colour = new Color();

    for (let s = 0; s < track.length && count < CAPACITY; s += STRIDE) {
      // The tunnel is buried; a tower growing out of its roof looks absurd.
      if (track.isInTunnel(s)) continue;

      const district = track.districtAt(s);
      const rule = THEMES[district.theme];
      const frame = track.frameAt(s);
      const halfWidth = frame.width * 0.5;

      for (const side of [-1, 1] as const) {
        if (count >= CAPACITY) break;
        if (rng.next() > rule.density) continue;

        const offset = rng.range(rule.offset[0], rule.offset[1]);
        const width = rng.range(rule.footprint[0], rule.footprint[1]);
        const depth = rng.range(rule.footprint[0], rule.footprint[1]);
        // Taller the further back, so the near buildings never wall off the view.
        const distanceFactor = (offset - rule.offset[0]) / Math.max(1, rule.offset[1] - rule.offset[0]);
        const height = rng.range(rule.height[0], lerp(rule.height[0] * 1.4, rule.height[1], distanceFactor));

        _position
          .copy(frame.position)
          .addScaledVector(frame.right, side * (halfWidth + offset))
          // Buildings sit on the ground plane, not on the banked road.
          .setY(Math.min(frame.position.y - 8, -6));

        _dummy.position.copy(_position);
        _dummy.rotation.set(0, Math.atan2(frame.tangent.x, frame.tangent.z) + rng.range(-0.14, 0.14), 0);
        _dummy.scale.set(width, height, depth);
        _dummy.updateMatrix();
        this.mesh.setMatrixAt(count, _dummy.matrix);

        const grey = rng.range(0.72, 0.95);
        colour.setRGB(grey, grey * 1.005, grey * 1.02);
        this.mesh.setColorAt(count, colour);
        count++;
      }
    }

    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.group.add(this.mesh);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as { dispose(): void }).dispose();
  }

  /**
   * Concrete with horizontal window bands.
   *
   * The lit-window pattern is a cheap hash of the instance index crossed with the
   * facade coordinate, so every building gets a different set of lights without
   * a texture and without a single byte of per-instance data beyond its colour.
   */
  private static material(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    const seed = instanceIndex.toFloat();

    const floors = fract(uv().y.mul(14));
    const band = smoothstep(float(0.62), float(0.5), floors).mul(smoothstep(float(0.14), float(0.26), floors));
    const bays = fract(uv().x.mul(9));
    const bay = smoothstep(float(0.7), float(0.55), bays);

    // Pseudo-random per window: a large-irrational product folded into 0..1.
    const noise = fract(sin(seed.mul(12.9898).add(uv().y.mul(78.233)).add(uv().x.mul(37.719))).mul(43758.5453));
    const lit = step(float(0.62), noise).mul(band).mul(bay);

    material.colorNode = mix(vec3(0.86, 0.87, 0.89), vec3(0.16, 0.2, 0.24), band.mul(0.8));
    material.emissiveNode = color(0xfff0d4).mul(lit).mul(0.9);
    material.roughnessNode = mix(float(0.72), float(0.18), band);
    material.metalnessNode = float(0.05);
    material.vertexColors = true;
    return material;
  }
}
