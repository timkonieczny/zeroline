import { BoxGeometry, Color, Group, InstancedMesh, Object3D, Vector3 } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { color, float, floor, fract, instanceIndex, mix, sin, smoothstep, step, uv, vec3 } from 'three/tsl';
import type { Track } from '../Track';
import type { SceneryTheme } from '../TrackTypes';
import { Rng } from '@/core/Rng';
import { lerp } from '@/core/math';

/** Metres between placement attempts along the circuit. */
const STRIDE = 26;
/** Instances reserved for the skyline. */
const CAPACITY = 900;
/** Windows across and up a facade. Scaled by the box's UV, so it is per-face. */
const WINDOWS_ACROSS = 7;
const WINDOWS_UP = 16;
/** A window is lit when its hash lands above this. */
const LIT_FRACTION = 0.72;
/** Fraction of the skyline clad in glass rather than concrete. */
const GLASS_FRACTION = 0.5;

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
   * Concrete with a grid of windows, some of them lit.
   *
   * The hash has to be taken on the *cell* the pixel falls in, not on the pixel.
   * Feeding a continuous UV into a `fract(sin(...))` hash is a white-noise
   * generator — an earlier version did exactly that and every facade came out
   * looking like an untuned television. Flooring the scaled UV first gives one
   * random value per window, which is what makes it read as a building.
   */
  private static material(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    const seed = instanceIndex.toFloat();

    // One value per building, used to decide what it is clad in.
    const buildingHash = fract(sin(seed.mul(91.7)).mul(24634.6543));
    const glass = step(float(1 - GLASS_FRACTION), buildingHash);

    const grid = uv().mul(vec3(WINDOWS_ACROSS, WINDOWS_UP, 1).xy);
    const cell = floor(grid);
    const within = fract(grid);

    // The window itself: a rectangle inset within its cell, leaving the mullion.
    const pane = smoothstep(float(0.12), float(0.2), within.x)
      .mul(smoothstep(float(0.88), float(0.8), within.x))
      .mul(smoothstep(float(0.2), float(0.3), within.y))
      .mul(smoothstep(float(0.82), float(0.72), within.y));

    // One value per window, per building.
    const hash = fract(sin(cell.x.mul(12.9898).add(cell.y.mul(78.233)).add(seed.mul(37.719))).mul(43758.5453));
    const lit = step(float(LIT_FRACTION), hash).mul(pane);

    // Gentle: glass is a little darker than the concrete around it, not a hole.
    // A hard pane-to-wall contrast turns a facade into a checkerboard, which is
    // as wrong as the noise it replaced.
    const concrete = mix(vec3(0.9, 0.91, 0.93), vec3(0.62, 0.67, 0.72), pane.mul(0.8));

    // Half the skyline is curtain glass. It reflects the sky rather than the
    // circuit: a real probe per building is out of the question, and at these
    // distances the sky is most of what a facade would show anyway.
    // Light enough to read as glass. At full metalness a facade turned away
    // from the sky has nothing to reflect and goes almost black, which put a
    // row of dark slabs through the middle of a bright city.
    const tint = mix(vec3(0.62, 0.72, 0.8), vec3(0.78, 0.87, 0.93), pane);

    material.colorNode = mix(concrete, tint, glass);
    // Barely there. Lit windows are a detail on a daylit facade; turned up they
    // make a shadowed street read as night, which the canyon district does more
    // than enough of on its own.
    material.emissiveNode = color(0xfff2dc).mul(lit).mul(mix(float(0.13), float(0.07), glass));
    material.roughnessNode = mix(mix(float(0.74), float(0.2), pane), mix(float(0.22), float(0.06), pane), glass);
    material.metalnessNode = mix(float(0.05), float(0.6), glass);
    material.vertexColors = true;
    return material;
  }
}
