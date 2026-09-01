import { BoxGeometry, Color, Group, InstancedMesh, Matrix4, Object3D, Vector3 } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  color,
  float,
  floor,
  fract,
  instanceIndex,
  mix,
  sin,
  smoothstep,
  step,
  uv,
  vec3,
} from 'three/tsl';
import type { Track } from '../Track';
import type { SceneryTheme } from '../TrackTypes';
import { SEA_LEVEL } from './Environment';
import { LANE_CLEARANCE, LANE_HALF_WIDTH, skyHighwayLanes, type SkyLane } from './SkyHighway';
import { Rng } from '@/core/Rng';
import { lerp } from '@/core/math';

/** Metres between placement attempts along the circuit. */
const STRIDE = 26;
/** Instances reserved for the skyline. */
const CAPACITY = 900;
/** Instances reserved for platforms and bridges. */
const DECK_CAPACITY = 220;
/** Windows across and up a facade. Scaled by the box's UV, so it is per-face. */
const WINDOWS_ACROSS = 7;
const WINDOWS_UP = 16;
/** A window is lit when its hash lands above this. */
const LIT_FRACTION = 0.72;
/** Fraction of the skyline clad in glass rather than concrete. */
const GLASS_FRACTION = 0.5;

/** Metres between road-clearance samples along the centreline. */
const CLEARANCE_STRIDE = 9;
/** Metres of air demanded between the road edge and the nearest facade. */
const ROAD_CLEARANCE = 16;
/** Above this much vertical separation, the road passes over and nothing clashes. */
const VERTICAL_CLEARANCE = 12;
/** Chance a placement starts a platform rather than standing in the water. */
const PLATFORM_CHANCE = 0.22;
/** Buildings sharing one platform. */
const PLATFORM_GROUP = 4;
/** How far apart two towers may be and still be worth bridging, in metres. */
const BRIDGE_SPAN: [min: number, max: number] = [16, 74];
/** Bridges built at most. */
const BRIDGE_LIMIT = 22;

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
  harbour: { density: 0.55, offset: [26, 130], footprint: [16, 42], height: [28, 124], glass: 0.4 },
  canyon: { density: 0.85, offset: [12, 46], footprint: [12, 26], height: [100, 310], glass: 0.25 },
  terminal: { density: 0.7, offset: [18, 70], footprint: [30, 70], height: [20, 52], glass: 0.15 },
  towers: { density: 0.5, offset: [34, 180], footprint: [18, 40], height: [140, 440], glass: 0.75 },
  stadium: { density: 0.6, offset: [22, 90], footprint: [26, 60], height: [36, 92], glass: 0.3 },
};

const _dummy = new Object3D();
const _matrix = new Matrix4();
const _position = new Vector3();

/** One placed building, kept so platforms and bridges can be fitted afterwards. */
interface Block {
  /** Which instance in the skyline mesh this is. */
  index: number;
  position: Vector3;
  /** Half the footprint's diagonal — the radius that must stay clear. */
  radius: number;
  height: number;
  /** Deck the block stands on: sea level, or the top of its platform. */
  baseY: number;
}

/** A road sample, flattened for the clearance test. */
interface RoadSample {
  x: number;
  y: number;
  z: number;
  /** Half the road width plus the clearance margin. */
  keepOut: number;
}

/**
 * The city the circuit runs through.
 *
 * One instanced mesh for the towers, a second for the platforms and bridges
 * between them, both placed once at load time by walking the centreline and
 * offsetting sideways past the barrier. There is no per-frame cost at all: the
 * buildings never move, and their windows are animated in the shader from the
 * instance index rather than from the CPU.
 *
 * Everything stands in the sea. Buildings that meet the water directly get a
 * reflection for free from the ocean shader, and the ones raised on shared
 * concrete platforms give the waterline something to break against — a city of
 * uniformly floating slabs reads as a mistake, and a city entirely on decks
 * reads as a car park.
 *
 * Colour is per-instance, biased white with a little variation, which is what
 * keeps the Mirror's Edge read: a bright, near-monochrome city with the
 * circuit's accent colours as the only saturation in frame.
 */
export class Skyline {
  readonly group = new Group();
  private readonly mesh: InstancedMesh;
  private readonly decks: InstancedMesh;

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

    const deckGeometry = new BoxGeometry(1, 1, 1);
    this.decks = new InstancedMesh(deckGeometry, Skyline.deckMaterial(), DECK_CAPACITY);
    this.decks.name = 'skyline-decks';
    this.decks.castShadow = true;
    this.decks.receiveShadow = true;
    this.decks.count = 0;

    const road = Skyline.sampleRoad(track);
    const lanes = skyHighwayLanes(track);
    const blocks: Block[] = [];
    let count = 0;
    let deckCount = 0;
    const colour = new Color();

    // Buildings queued for the platform currently being assembled.
    let pending: Block[] = [];
    let pendingDeck = 0;

    const flushPlatform = (): void => {
      if (pending.length === 0) return;
      if (deckCount < DECK_CAPACITY) {
        // A platform is wider than the buildings that sit on it, so a cluster
        // that cleared the circuit individually could still have its deck laid
        // across the road. Checked here rather than at placement.
        if (Skyline.writePlatform(this.decks, deckCount, pending, pendingDeck, road)) {
          deckCount++;
        } else {
          // No deck, so the cluster cannot stand on one. Re-seat each building
          // on the water at the height it would have reached anyway, or they
          // hang in the air where their platform used to be.
          for (const block of pending) {
            block.baseY = SEA_LEVEL;
            block.position.setY(SEA_LEVEL);
            this.mesh.getMatrixAt(block.index, _matrix);
            _matrix.decompose(_dummy.position, _dummy.quaternion, _dummy.scale);
            _dummy.position.setY(SEA_LEVEL);
            _dummy.updateMatrix();
            this.mesh.setMatrixAt(block.index, _dummy.matrix);
          }
        }
      }
      pending = [];
    };

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

        const width = rng.range(rule.footprint[0], rule.footprint[1]);
        const depth = rng.range(rule.footprint[0], rule.footprint[1]);
        const radius = Math.hypot(width, depth) * 0.5;

        // Offset is measured to the *facade*, not to the centre. Ignoring the
        // footprint is what put buildings through the road in a couple of
        // places: a 40 m slab placed 12 m off the edge overlaps by 8 m before
        // the circuit even curves.
        const offset = rng.range(rule.offset[0], rule.offset[1]) + radius;
        const distanceFactor = (offset - rule.offset[0]) / Math.max(1, rule.offset[1] - rule.offset[0]);
        // Taller the further back, so the near buildings never wall off the view.
        const height = rng.range(rule.height[0], lerp(rule.height[0] * 1.4, rule.height[1], distanceFactor));

        _position.copy(frame.position).addScaledVector(frame.right, side * (halfWidth + offset));

        // The circuit doubles back on itself; being clear of the section that
        // spawned this building says nothing about the rest of the lap. Push
        // outward until the whole track is clear, and give up rather than
        // shove a tower into the sea a hundred metres out.
        const top = SEA_LEVEL + height;
        if (!Skyline.pushClear(_position, radius, top, road, frame.right, side)) continue;

        const onPlatform = pending.length > 0 || rng.next() < PLATFORM_CHANCE;
        if (pending.length === 0 && onPlatform) pendingDeck = SEA_LEVEL + rng.range(5, 13);
        const baseY = onPlatform ? pendingDeck : SEA_LEVEL;

        // Heights were tuned against the old floating base, which sat close to
        // the road. Dropping to the waterline without compensating would have
        // sunk the whole skyline by twenty-odd metres.
        const raw = height + (Math.min(frame.position.y - 8, -6) - baseY);
        // Duck under any traffic lane passing overhead. The highway sits low
        // enough to be part of the city now, which means the city has to give
        // way rather than spear a commuter craft.
        const rise = Math.max(10, Math.min(raw, Skyline.laneCeiling(_position.x, _position.z, radius, lanes) - baseY));

        _dummy.position.set(_position.x, baseY, _position.z);
        _dummy.rotation.set(0, Math.atan2(frame.tangent.x, frame.tangent.z) + rng.range(-0.14, 0.14), 0);
        _dummy.scale.set(width, rise, depth);
        _dummy.updateMatrix();
        this.mesh.setMatrixAt(count, _dummy.matrix);

        const grey = rng.range(0.72, 0.95);
        colour.setRGB(grey, grey * 1.005, grey * 1.02);
        this.mesh.setColorAt(count, colour);
        count++;

        const block: Block = { index: count - 1, position: _dummy.position.clone(), radius, height: rise, baseY };
        blocks.push(block);
        if (onPlatform) {
          pending.push(block);
          if (pending.length >= PLATFORM_GROUP) flushPlatform();
        } else {
          flushPlatform();
        }
      }
    }
    flushPlatform();

    deckCount = Skyline.writeBridges(this.decks, deckCount, blocks, road, rng);

    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;

    this.decks.count = deckCount;
    this.decks.instanceMatrix.needsUpdate = true;

    this.group.add(this.mesh, this.decks);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as { dispose(): void }).dispose();
    this.decks.geometry.dispose();
    (this.decks.material as { dispose(): void }).dispose();
  }

  /**
   * The highest a building at this footprint may reach without fouling traffic.
   *
   * Infinity when no lane passes over it, which is most of them.
   */
  private static laneCeiling(x: number, z: number, radius: number, lanes: readonly SkyLane[]): number {
    let ceiling = Infinity;
    for (const lane of lanes) {
      // Distance from the point to the lane's line, in the ground plane.
      const offsetX = x - lane.originX;
      const offsetZ = z - lane.originZ;
      const across = Math.abs(offsetX * lane.dirZ - offsetZ * lane.dirX);
      if (across > radius + LANE_HALF_WIDTH) continue;
      ceiling = Math.min(ceiling, lane.altitude - LANE_CLEARANCE);
    }
    return ceiling;
  }

  /** Flattens the circuit into the few hundred points the clearance test needs. */
  private static sampleRoad(track: Track): RoadSample[] {
    const samples: RoadSample[] = [];
    for (let s = 0; s < track.length; s += CLEARANCE_STRIDE) {
      const frame = track.frameAt(s);
      samples.push({
        x: frame.position.x,
        y: frame.position.y,
        z: frame.position.z,
        keepOut: frame.width * 0.5 + ROAD_CLEARANCE,
      });
    }
    return samples;
  }

  /**
   * Slides a candidate sideways until no part of the circuit runs through it.
   *
   * Returns false if it would have to travel absurdly far, in which case the
   * caller drops the building — a gap in the skyline is invisible, a tower
   * through the racing line is not.
   */
  private static pushClear(
    position: Vector3,
    radius: number,
    top: number,
    road: readonly RoadSample[],
    right: Vector3,
    side: -1 | 1,
  ): boolean {
    for (let attempt = 0; attempt < 12; attempt++) {
      let worst = 0;
      for (const sample of road) {
        // Road well above the roof, or below the waterline: no conflict.
        if (sample.y - VERTICAL_CLEARANCE > top || sample.y + VERTICAL_CLEARANCE < SEA_LEVEL) continue;
        const dx = position.x - sample.x;
        const dz = position.z - sample.z;
        const overlap = sample.keepOut + radius - Math.hypot(dx, dz);
        if (overlap > worst) worst = overlap;
      }
      if (worst <= 0) return true;
      position.addScaledVector(right, side * (worst + 1));
    }
    return false;
  }

  /**
   * A shared concrete deck under a cluster, standing out of the water.
   *
   * Returns false if the slab would cross the circuit, in which case the
   * cluster simply stands in the water instead.
   */
  private static writePlatform(
    decks: InstancedMesh,
    index: number,
    group: readonly Block[],
    deckY: number,
    road: readonly RoadSample[],
  ): boolean {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const block of group) {
      minX = Math.min(minX, block.position.x - block.radius);
      maxX = Math.max(maxX, block.position.x + block.radius);
      minZ = Math.min(minZ, block.position.z - block.radius);
      maxZ = Math.max(maxZ, block.position.z + block.radius);
    }
    const margin = 9;
    const thickness = deckY - (SEA_LEVEL - 4);
    const centreX = (minX + maxX) / 2;
    const centreZ = (minZ + maxZ) / 2;
    const width = maxX - minX + margin * 2;
    const depth = maxZ - minZ + margin * 2;

    // Tested as the rectangle it is. A circumscribed disc rejected most of the
    // platforms on the circuit's inside, where the slab is long and thin and
    // its diagonal says nothing useful.
    for (const sample of road) {
      if (Math.abs(sample.y - deckY) > VERTICAL_CLEARANCE) continue;
      const dx = Math.max(0, Math.abs(sample.x - centreX) - width / 2);
      const dz = Math.max(0, Math.abs(sample.z - centreZ) - depth / 2);
      if (Math.hypot(dx, dz) < sample.keepOut) return false;
    }

    _dummy.position.set(centreX, SEA_LEVEL - 4 + thickness / 2, centreZ);
    _dummy.rotation.set(0, 0, 0);
    _dummy.scale.set(width, thickness, depth);
    _dummy.updateMatrix();
    decks.setMatrixAt(index, _dummy.matrix);
    return true;
  }

  /**
   * Skyways between neighbouring towers.
   *
   * Only pairs that are already close get one, and only where the bridge would
   * not cross the circuit. Connected towers read as a planned city rather than
   * as a field of independent boxes, and at speed the spans flick past the
   * camera as strong horizontal accents against all those verticals.
   */
  private static writeBridges(
    decks: InstancedMesh,
    start: number,
    blocks: readonly Block[],
    road: readonly RoadSample[],
    rng: Rng,
  ): number {
    let index = start;
    let built = 0;
    const bridged = new Set<number>();

    for (let i = 0; i < blocks.length && built < BRIDGE_LIMIT && index < DECK_CAPACITY; i++) {
      if (bridged.has(i)) continue;
      const a = blocks[i]!;
      if (a.height < 26) continue;

      for (let j = i + 1; j < blocks.length; j++) {
        if (bridged.has(j)) continue;
        const b = blocks[j]!;
        if (b.height < 26) continue;

        const dx = b.position.x - a.position.x;
        const dz = b.position.z - a.position.z;
        const gap = Math.hypot(dx, dz) - a.radius - b.radius;
        if (gap < BRIDGE_SPAN[0] || gap > BRIDGE_SPAN[1]) continue;
        if (rng.next() > 0.5) continue;

        // Somewhere in the upper half of the shorter tower.
        const ceiling = Math.min(a.baseY + a.height, b.baseY + b.height);
        const y = ceiling - rng.range(6, Math.max(8, Math.min(a.height, b.height) * 0.45));

        const midX = (a.position.x + b.position.x) / 2;
        const midZ = (a.position.z + b.position.z) / 2;
        if (Skyline.crossesRoad(midX, y, midZ, gap / 2, road)) continue;

        _dummy.position.set(midX, y, midZ);
        _dummy.rotation.set(0, Math.atan2(dx, dz), 0);
        // Long enough to bury both ends inside the towers it joins.
        _dummy.scale.set(rng.range(3.4, 6), rng.range(2.6, 4.2), gap + a.radius + b.radius);
        _dummy.updateMatrix();
        decks.setMatrixAt(index++, _dummy.matrix);

        bridged.add(i);
        bridged.add(j);
        built++;
        break;
      }
    }
    return index;
  }

  /** True if the circuit passes through the given horizontal disc at that height. */
  private static crossesRoad(x: number, y: number, z: number, radius: number, road: readonly RoadSample[]): boolean {
    for (const sample of road) {
      if (Math.abs(sample.y - y) > VERTICAL_CLEARANCE) continue;
      if (Math.hypot(x - sample.x, z - sample.z) < sample.keepOut + radius) return true;
    }
    return false;
  }

  /** Poured concrete: platforms, and the skyways between towers. */
  private static deckMaterial(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    // A shade under the towers, so a deck reads as ground rather than as the
    // bottom storey of whatever stands on it.
    material.colorNode = mix(color(0x9fa8b0), color(0xc6ced5), uv().y);
    material.roughnessNode = float(0.82);
    material.metalnessNode = float(0.04);
    return material;
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

    // --- What the glass actually shows ---------------------------------
    //
    // A curtain-wall tower is a mirror with a grid drawn on it, not a concrete
    // block with mirrors set into it. The first attempt reflected only inside
    // the window rectangles and left the mullions opaque, which at any distance
    // averages back out to a flat painted wall — the reflection was there and
    // there was no way to see it.
    //
    // So the whole facade is the glass now. It is also a real reflection rather
    // than an arithmetic one: `scene.environment` is the painted sky panorama,
    // and a metal surface with almost no roughness returns it with the clouds
    // still in it. That is what the earlier hand-written sky-and-sea function
    // was standing in for, back when the probe was a smooth gradient with
    // nothing to see.
    //
    // The mullion grid stays as a faint darkening, so the tower still reads as
    // storeys rather than as a mirrored slab.
    const mullion = pane.oneMinus().mul(0.12);
    const glazed = tint.mul(mullion.oneMinus());

    material.colorNode = mix(concrete, glazed, glass);
    // Barely there. Lit windows are a detail on a daylit facade; turned up they
    // make a shadowed street read as night, which the canyon district does more
    // than enough of on its own.
    material.emissiveNode = color(0xfff2dc).mul(lit).mul(mix(float(0.13), float(0.07), glass));
    // Near-mirror on the glass, with the mullions a shade rougher so the grid
    // survives in the reflection instead of being polished away.
    material.roughnessNode = mix(mix(float(0.74), float(0.2), pane), mix(float(0.16), float(0.04), pane), glass);
    // Full metal on the glass towers: that is the whole reflection, and it is
    // the sky probe that supplies it.
    material.metalnessNode = mix(float(0.05), float(1), glass);
    material.vertexColors = true;
    return material;
  }
}
