import {
  BoxGeometry,
  Color,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Object3D,
  Vector3,
} from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  attribute,
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
  vec2,
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
/** Windows across a facade. Scaled by the box's UV, so it is per-face. */
const WINDOWS_ACROSS = 7;
/**
 * Metres per storey.
 *
 * The window grid used to be a fixed sixteen rows whatever the building, which
 * meant a four-hundred-metre tower and a thirty-metre block were drawn with the
 * same number of floors — twenty-five metre windows on one and two-metre
 * windows on the other. Rows are counted from the height now, so a taller
 * building is a building with more storeys in it rather than one with taller
 * windows, and raising one for the shadow it casts does not distort it.
 */
const STOREY_HEIGHT = 4.2;
/** Fewest and most storeys drawn, so the arithmetic cannot produce a stripe. */
const MIN_STOREYS = 3;
const MAX_STOREYS = 130;

/** Metres between samples when measuring how much of the lap sits in shadow. */
const SHADOW_SAMPLE_STEP = 9;
/**
 * How much of the lap the search will keep raising buildings to shade.
 *
 * It is a ceiling on the effort, not a promise. A quarter of the lap has no
 * building anywhere between it and the sun and another quarter has one that
 * cannot grow past the traffic lane over it, so the search runs out of
 * candidates at about 47% rather than stopping here.
 * `scripts/shadow-report.ts` prints where it actually lands.
 */
const SHADOW_TARGET = 0.6;
/**
 * Most a building may gain over what its district gave it, in metres.
 *
 * The knee in the curve. This shades 47% of the lap; lifting it to 450 buys
 * under a point, and past that the number does not move at all — what is left
 * is road with nothing between it and the sun, or with a traffic lane capping
 * whatever is. Raising it further only makes the city taller.
 */
const SHADOW_MAX_GAIN = 320;
/**
 * How much of a building's width has to be in line before it counts as shading.
 *
 * Under one, because the edge of a shadow is soft and a road only clipping the
 * corner of one does not read as being in it.
 */
const SHADOW_BITE = 0.8;
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
const _position = new Vector3();

/** One placed building, kept so platforms and bridges can be fitted afterwards. */
/**
 * A concrete deck standing out of the water, and what is already on it.
 *
 * Handed out so scenery can be put on the slabs without recomputing where they
 * are. Axis-aligned, because that is how they are built.
 */
export interface Platform {
  centreX: number;
  centreZ: number;
  width: number;
  depth: number;
  /** The walking surface, which is the top of the slab. */
  topY: number;
  /** Footprints already standing on it, as circles. */
  occupied: readonly { x: number; z: number; radius: number }[];
}

/** A circle on the water that a building has to stay out of. */
export interface Footprint {
  position: Vector3;
  radius: number;
}

interface Block {
  /** Footprint and turn, so a raised building's matrix can be rebuilt. */
  width: number;
  depth: number;
  rotation: number;
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
  /** The decks the clusters stand on, for anything that wants to dress them. */
  readonly platforms: readonly Platform[];
  /**
   * Every building on the circuit, as a circle on the water.
   *
   * The platforms carry their own clusters, but they overlap one another in
   * plan and plenty of towers stand in the sea on no platform at all — so a
   * deck's own list is not enough to keep anything laid on it out of a
   * neighbour's tower.
   */
  readonly footprints: readonly Footprint[];
  private readonly mesh: InstancedMesh;
  private readonly decks: InstancedMesh;
  private readonly storeys: InstancedBufferAttribute;

  /**
   * @param keepOut Footprints nothing may be built over — the grandstands.
   *   They are placed first because there are five of them and nine hundred
   *   candidate buildings; making the plentiful thing give way is cheaper than
   *   hunting for a straight with a gap in the city beside it.
   */
  constructor(track: Track, keepOut: readonly Footprint[] = []) {
    const rng = new Rng(0xb0d1e5);
    const geometry = new BoxGeometry(1, 1, 1);
    // One value per building: how many rows of windows its facade carries.
    this.storeys = new InstancedBufferAttribute(new Float32Array(CAPACITY), 1);
    geometry.setAttribute('storeys', this.storeys);
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
    const platforms: Platform[] = [];
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
        const platform = Skyline.writePlatform(this.decks, deckCount, pending, pendingDeck, road);
        if (platform) {
          platforms.push(platform);
          deckCount++;
        } else {
          // No deck, so the cluster cannot stand on one. Re-seat each building
          // on the water at the height it would have reached anyway, or they
          // hang in the air where their platform used to be.
          for (const block of pending) {
            block.baseY = SEA_LEVEL;
            block.position.setY(SEA_LEVEL);
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
        if (Skyline.fouls(_position, radius, keepOut)) continue;

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

        const rotation = Math.atan2(frame.tangent.x, frame.tangent.z) + rng.range(-0.14, 0.14);

        const grey = rng.range(0.72, 0.95);
        colour.setRGB(grey, grey * 1.005, grey * 1.02);
        this.mesh.setColorAt(count, colour);
        count++;

        const block: Block = {
          index: count - 1,
          position: new Vector3(_position.x, baseY, _position.z),
          radius,
          height: rise,
          baseY,
          width,
          depth,
          rotation,
        };
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

    Skyline.raiseForShadows(blocks, track, lanes);

    // Bridges span between the tops, so they are laid after the raise. Doing it
    // the other way round leaves a walkway a hundred metres down a facade.
    deckCount = Skyline.writeBridges(this.decks, deckCount, blocks, road, rng);

    for (const block of blocks) {
      _dummy.position.copy(block.position).setY(block.baseY);
      _dummy.rotation.set(0, block.rotation, 0);
      _dummy.scale.set(block.width, block.height, block.depth);
      _dummy.updateMatrix();
      this.mesh.setMatrixAt(block.index, _dummy.matrix);
      // Rows of windows, so a raised building gains storeys rather than
      // stretching the ones it had.
      this.storeys.setX(
        block.index,
        Math.max(MIN_STOREYS, Math.min(MAX_STOREYS, Math.round(block.height / STOREY_HEIGHT))),
      );
    }
    this.storeys.needsUpdate = true;

    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;

    this.decks.count = deckCount;
    this.decks.instanceMatrix.needsUpdate = true;

    this.platforms = platforms;
    this.footprints = blocks.map((block) => ({
      position: block.position.clone(),
      radius: block.radius,
    }));
    this.group.add(this.mesh, this.decks);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as { dispose(): void }).dispose();
    this.decks.geometry.dispose();
    (this.decks.material as { dispose(): void }).dispose();
  }

  /**
   * Grows existing buildings until the city shades most of the lap.
   *
   * The stretch before the tunnel is the best-looking part of the circuit, and
   * what makes it is the bars of shadow the towers throw across the road. That
   * happened by accident — the district drew tall buildings and the sun was on
   * the right side of them. This puts it everywhere on purpose.
   *
   * It only ever raises what is already standing, and only in whole storeys: no
   * new footprint appears, nothing is scaled, and a building that gains sixty
   * metres gains fourteen floors of windows rather than fourteen tall ones.
   * Growth is capped by the traffic lanes overhead and by `SHADOW_MAX_GAIN`, so
   * the skyline keeps its silhouette instead of turning into a wall.
   *
   * Cheapest-first: for each unshaded point, the building raised is whichever
   * one already stands in line with the sun and needs the fewest extra floors.
   */
  private static raiseForShadows(
    blocks: readonly Block[],
    track: Track,
    lanes: readonly SkyLane[],
  ): void {
    const { azimuth, elevation } = track.definition.sun;
    const radians = (azimuth * Math.PI) / 180;
    // The way a shadow runs along the ground: directly away from the sun.
    const shadeX = -Math.cos(radians);
    const shadeZ = -Math.sin(radians);
    // Ground metres a shadow covers per metre of height. 0.97 at 46 degrees.
    const reach = 1 / Math.tan((elevation * Math.PI) / 180);

    // Only the open road counts. A tunnel is shaded by its own roof, and no
    // amount of building will change that either way.
    const road: Vector3[] = [];
    for (let s = 0; s < track.length; s += SHADOW_SAMPLE_STEP) {
      if (track.isInTunnel(s)) continue;
      road.push(track.frameAt(s).position.clone());
    }
    if (road.length === 0) return;

    const shaded = new Uint8Array(road.length);
    let covered = 0;

    /** How far a block's shadow has to travel to reach a point, or -1. */
    const distanceTo = (block: Block, point: Vector3): number => {
      const dx = point.x - block.position.x;
      const dz = point.z - block.position.z;
      const along = dx * shadeX + dz * shadeZ;
      if (along <= 0) return -1;
      // Under the full width, because a shadow's edge is soft and a road
      // clipping the corner of one does not read as being in it.
      const across = Math.abs(dx * shadeZ - dz * shadeX);
      return across > block.radius * SHADOW_BITE ? -1 : along;
    };

    const markShade = (block: Block): void => {
      for (let i = 0; i < road.length; i++) {
        if (shaded[i]) continue;
        const point = road[i]!;
        const along = distanceTo(block, point);
        if (along < 0 || along > (block.baseY + block.height - point.y) * reach) continue;
        shaded[i] = 1;
        covered++;
      }
    };

    for (const block of blocks) markShade(block);


    const target = Math.ceil(road.length * SHADOW_TARGET);
    for (let i = 0; i < road.length && covered < target; i++) {
      if (shaded[i]) continue;
      const point = road[i]!;

      let best: Block | undefined;
      let bestHeight = 0;
      let bestGain = Infinity;
      for (const block of blocks) {
        const along = distanceTo(block, point);
        if (along < 0) continue;

        const needed = point.y + along / reach - block.baseY;
        // Cheapest by floors *added*, not by height reached: a tower already
        // most of the way there is a better answer than a low block that would
        // have to double. It is also what keeps the skyline's silhouette —
        // always growing the shortest candidate flattens the city into a slab.
        const gain = needed - block.height;
        if (gain <= 0 || gain >= bestGain) continue;
        if (gain > SHADOW_MAX_GAIN) continue;
        if (needed > MAX_STOREYS * STOREY_HEIGHT) continue;
        const ceiling = Skyline.laneCeiling(block.position.x, block.position.z, block.radius, lanes);
        if (block.baseY + needed > ceiling) continue;

        bestGain = gain;
        bestHeight = needed;
        best = block;
      }
      if (!best) continue;

      // Land on a whole storey. Rounding up is what actually reaches the road,
      // so the ceiling is re-checked rather than assumed to have room for it.
      const storeys = Math.ceil(bestHeight / STOREY_HEIGHT);
      const ceiling = Skyline.laneCeiling(best.position.x, best.position.z, best.radius, lanes);
      if (best.baseY + storeys * STOREY_HEIGHT > ceiling) continue;

      best.height = storeys * STOREY_HEIGHT;

      markShade(best);
    }
  }

  /** True when this footprint overlaps anything already standing there. */
  private static fouls(position: Vector3, radius: number, keepOut: readonly Footprint[]): boolean {
    for (const other of keepOut) {
      const dx = position.x - other.position.x;
      const dz = position.z - other.position.z;
      if (dx * dx + dz * dz < (radius + other.radius) ** 2) return true;
    }
    return false;
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
   * Returns null if the slab would cross the circuit, in which case the
   * cluster simply stands in the water instead.
   */
  private static writePlatform(
    decks: InstancedMesh,
    index: number,
    group: readonly Block[],
    deckY: number,
    road: readonly RoadSample[],
  ): Platform | null {
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
      if (Math.hypot(dx, dz) < sample.keepOut) return null;
    }

    _dummy.position.set(centreX, SEA_LEVEL - 4 + thickness / 2, centreZ);
    _dummy.rotation.set(0, 0, 0);
    _dummy.scale.set(width, thickness, depth);
    _dummy.updateMatrix();
    decks.setMatrixAt(index, _dummy.matrix);

    return {
      centreX,
      centreZ,
      width,
      depth,
      topY: deckY,
      occupied: group.map((block) => ({
        x: block.position.x,
        z: block.position.z,
        radius: block.radius,
      })),
    };
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

    // Rows from the building's own height, columns fixed: a facade is as many
    // storeys tall as it is, and about as many windows wide whatever its width.
    // Rows from the building's own height, columns fixed: a facade is as many
    // storeys tall as it is, and about as many windows wide whatever its width.
    const grid = uv().mul(vec2(float(WINDOWS_ACROSS), attribute<'float'>('storeys', 'float')));
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

    // A pane on a concrete building is glazing too, so it is tinted for what it
    // returns from the sky probe rather than painted a darker grey. The old
    // flat darkening was a hole in a wall; this one catches the clouds.
    const concrete = mix(vec3(0.9, 0.91, 0.93), vec3(0.72, 0.81, 0.88), pane);

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
    // Near-mirror on every pane, with the mullions and the concrete around them
    // rough, so the grid survives in the reflection instead of being polished
    // away and a plain block still reads as a plain block.
    material.roughnessNode = mix(mix(float(0.74), float(0.07), pane), mix(float(0.16), float(0.04), pane), glass);
    // Metal is what makes a pane a mirror: a dielectric at this roughness gets a
    // faint sheen and nothing else, which is why the windows on the concrete
    // half of the skyline used to look painted on. The wall between them stays
    // dielectric, so only the glazing reflects.
    material.metalnessNode = mix(pane.mul(0.92), float(1), glass);
    material.vertexColors = true;
    return material;
  }
}
