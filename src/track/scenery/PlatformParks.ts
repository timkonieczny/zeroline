import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Object3D,
  Vector3,
  type BufferGeometry,
} from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rng } from '@/core/Rng';
import type { Track } from '../Track';
import type { Platform } from './Skyline';

// --- Trees -----------------------------------------------------------------

/**
 * Height of a tree, trunk and crown together, in metres.
 *
 * Set against the buildings rather than picked: the towers beside them are 30
 * to 70 m across the base, so a tree has to be small enough that the slab
 * still reads as a city block. Nine metres is a mature street tree.
 */
const TREE_HEIGHT = 9;
/** How far a tree may vary from that, as a fraction. */
const SIZE_SPREAD = 0.28;
/** Where the crown starts up the trunk, as a fraction of the height. */
const CROWN_BASE = 0.38;
/** Radius of the crown, as a fraction of the height. */
const CROWN_RADIUS = 0.31;
/** Trunk radius at the ground and at the crown, in metres. */
const TRUNK_FOOT = 0.34;
const TRUNK_TOP = 0.2;
/** Metres between one tree and the next, and from the edge of its lawn. */
const TREE_SPACING = 7.5;
const TREE_INSET = 2.4;
/**
 * Metres of air left between the tallest tree and the road above it.
 *
 * The platforms are laid at the waterline and the circuit runs anything from
 * ten to forty metres over them, so a slab is allowed to sit directly under
 * the road — it is thirty metres down and reads as the city the circuit is
 * threaded through. A nine-metre tree on top of one is a different matter: the
 * closest planting spot on this circuit has eleven metres of headroom, and a
 * tree at the top of its size range is eleven and a half.
 */
const ROAD_HEADROOM = 4;

// --- Ground ----------------------------------------------------------------

/** How far a lawn stands proud of the deck, in metres. A kerbed bed, not turf. */
const LAWN_RISE = 0.22;
/** How far a path stands proud of the deck. Enough to catch an edge shadow. */
const PATH_RISE = 0.05;
/** Width of a footpath, in metres. Wide: this is a promenade, not a garden path. */
const PATH_WIDTH = 4.5;
/** Metres of bare deck left at the waterline edge, outside the promenade. */
const EDGE_MARGIN = 5;
/** Metres of clear deck between anything laid out and a building. */
const BUILDING_CLEARANCE = 3.5;

/** Range of a lawn's side, in metres. */
const LAWN_MIN = 12;
const LAWN_MAX = 46;
/**
 * Attempts per platform at finding somewhere for a lawn.
 *
 * Generous, because by this point the deck is criss-crossed with paving and a
 * lawn has to land in one of the blocks between it. Most darts miss, and the
 * cost of throwing one is two rectangle tests.
 */
const LAWN_ATTEMPTS = 160;
/** Cross paths tried per platform, in each direction. */
const CROSS_ATTEMPTS = 5;
/** Shortest run of paving worth laying, in metres. */
const MIN_PATH_RUN = 12;

const LAWN_CAPACITY = 200;
const PATH_CAPACITY = 200;
const TREE_CAPACITY = 1100;

const _dummy = new Object3D();
const _spot = new Vector3();

/** An axis-aligned patch of deck. Platforms are axis-aligned, so these are too. */
interface Patch {
  x: number;
  z: number;
  width: number;
  depth: number;
}

/**
 * Cuts a straight run into the segments that actually clear the buildings.
 *
 * A cross path is only worth having if it goes somewhere, and on a deck with
 * four towers on it a full-width strip hits one almost every time — which is
 * why the first attempt at this laid nothing but the perimeter. So the line is
 * threaded instead: each building blocks the span of it that its footprint
 * covers, and what is left between them is paved.
 */
function runsBetween(
  from: number,
  to: number,
  blockers: readonly { at: number; across: number; radius: number }[],
  line: number,
): { from: number; to: number }[] {
  const blocked: { from: number; to: number }[] = [];
  for (const blocker of blockers) {
    const offset = Math.abs(blocker.across - line);
    if (offset >= blocker.radius) continue;
    const half = Math.sqrt(blocker.radius * blocker.radius - offset * offset);
    blocked.push({ from: blocker.at - half, to: blocker.at + half });
  }
  blocked.sort((a, b) => a.from - b.from);

  const runs: { from: number; to: number }[] = [];
  let cursor = from;
  for (const span of blocked) {
    if (span.from > cursor && span.from - cursor >= MIN_PATH_RUN) {
      runs.push({ from: cursor, to: span.from });
    }
    cursor = Math.max(cursor, span.to);
  }
  if (to - cursor >= MIN_PATH_RUN) runs.push({ from: cursor, to });
  return runs;
}

function overlaps(a: Patch, b: Patch, margin = 0): boolean {
  return (
    Math.abs(a.x - b.x) < (a.width + b.width) * 0.5 + margin &&
    Math.abs(a.z - b.z) < (a.depth + b.depth) * 0.5 + margin
  );
}

/** Nearest distance from a circle's centre to a patch, negative when inside. */
function clearOf(patch: Patch, x: number, z: number, radius: number): boolean {
  const dx = Math.max(0, Math.abs(x - patch.x) - patch.width * 0.5);
  const dz = Math.max(0, Math.abs(z - patch.z) - patch.depth * 0.5);
  return Math.hypot(dx, dz) > radius;
}

/**
 * The parks on the concrete platforms the towers stand on.
 *
 * The slabs are laid nine metres clear of their buildings, which leaves a
 * border of bare concrete standing out of the sea. Scattering trees over it
 * made it green but not *designed* — trees dotted across an expanse of
 * concrete read as weeds. This lays the ground out first and then plants it:
 * a promenade around the edge of every deck, a cross path or two through it,
 * lawns in the space that is left, and trees only ever on a lawn.
 *
 * Four instanced draws, no per-frame cost, and around a hundred and fifty
 * boxes on top of the trees that were already there — which is nothing beside
 * the crowd in the stands. The tree count is unchanged; they are simply
 * gathered into the parks instead of spread over the slab.
 */
export class PlatformParks {
  readonly group = new Group();
  private readonly lawns: InstancedMesh;
  private readonly paths: InstancedMesh;
  private readonly trunks: InstancedMesh;
  private readonly crowns: InstancedMesh;

  constructor(platforms: readonly Platform[], track: Track) {
    const rng = new Rng(0x7ee5);

    this.lawns = new InstancedMesh(PlatformParks.slab(), PlatformParks.grass(), LAWN_CAPACITY);
    this.lawns.name = 'platform-lawns';
    this.lawns.castShadow = false;
    this.lawns.receiveShadow = true;

    this.paths = new InstancedMesh(PlatformParks.slab(), PlatformParks.paving(), PATH_CAPACITY);
    this.paths.name = 'platform-paths';
    this.paths.castShadow = false;
    this.paths.receiveShadow = true;

    this.trunks = new InstancedMesh(PlatformParks.trunk(), PlatformParks.bark(), TREE_CAPACITY);
    this.trunks.name = 'platform-trees';
    this.trunks.castShadow = false;
    this.trunks.receiveShadow = true;

    this.crowns = new InstancedMesh(PlatformParks.crown(), PlatformParks.foliage(), TREE_CAPACITY);
    this.crowns.name = 'platform-tree-crowns';
    this.crowns.castShadow = false;
    this.crowns.receiveShadow = true;

    const colour = new Color();
    let lawnCount = 0;
    let pathCount = 0;
    let treeCount = 0;

    /**
     * Lays one slab flat on the deck, `rise` metres thick.
     *
     * The geometry's origin is its base, not its centre, so the position is
     * the deck surface itself — the top then lands at `topY + rise`, which is
     * exactly where a tree on a lawn has to stand.
     */
    const lay = (mesh: InstancedMesh, index: number, patch: Patch, topY: number, rise: number) => {
      _dummy.position.set(patch.x, topY, patch.z);
      _dummy.rotation.set(0, 0, 0);
      _dummy.scale.set(patch.width, rise, patch.depth);
      _dummy.updateMatrix();
      mesh.setMatrixAt(index, _dummy.matrix);
    };

    for (const platform of platforms) {
      const usable = {
        x: platform.centreX,
        z: platform.centreZ,
        width: platform.width - EDGE_MARGIN * 2,
        depth: platform.depth - EDGE_MARGIN * 2,
      };
      if (usable.width < PATH_WIDTH * 3 || usable.depth < PATH_WIDTH * 3) continue;

      // What a lawn has to stay out of, and — separately — the cross paths, so
      // a new one does not land on top of an old one. The promenade is left out
      // of that second list on purpose: a cross path is *supposed* to run into
      // it at both ends, and testing against it rejected almost every one.
      const laid: Patch[] = [];
      const crossings: Patch[] = [];
      const clearOfBuildings = (patch: Patch): boolean =>
        platform.occupied.every((b) => clearOf(patch, b.x, b.z, b.radius + BUILDING_CLEARANCE));

      // 1. The promenade: a walk right around the deck, inside the bare margin.
      //    Every platform gets one, whatever else fits, because it is the thing
      //    that makes the slab read as somewhere rather than as a surface.
      const ring: Patch[] = [
        { x: usable.x, z: usable.z - usable.depth * 0.5, width: usable.width, depth: PATH_WIDTH },
        { x: usable.x, z: usable.z + usable.depth * 0.5, width: usable.width, depth: PATH_WIDTH },
        { x: usable.x - usable.width * 0.5, z: usable.z, width: PATH_WIDTH, depth: usable.depth },
        { x: usable.x + usable.width * 0.5, z: usable.z, width: PATH_WIDTH, depth: usable.depth },
      ];
      for (const strip of ring) {
        if (pathCount >= PATH_CAPACITY) break;
        lay(this.paths, pathCount++, strip, platform.topY, PATH_RISE);
        laid.push(strip);
      }

      // 2. Cross paths, threaded between the towers rather than through them.
      for (const across of [true, false]) {
        for (let attempt = 0; attempt < CROSS_ATTEMPTS; attempt++) {
          if (pathCount >= PATH_CAPACITY) break;

          const line = across
            ? usable.z + rng.range(-usable.depth * 0.4, usable.depth * 0.4)
            : usable.x + rng.range(-usable.width * 0.4, usable.width * 0.4);
          const span = across ? usable.width : usable.depth;
          const centre = across ? usable.x : usable.z;
          const blockers = platform.occupied.map((b) => ({
            at: across ? b.x : b.z,
            across: across ? b.z : b.x,
            radius: b.radius + BUILDING_CLEARANCE + PATH_WIDTH * 0.5,
          }));

          const runs = runsBetween(centre - span * 0.5, centre + span * 0.5, blockers, line);
          const strips = runs.map((run) =>
            across
              ? { x: (run.from + run.to) * 0.5, z: line, width: run.to - run.from, depth: PATH_WIDTH }
              : { x: line, z: (run.from + run.to) * 0.5, width: PATH_WIDTH, depth: run.to - run.from },
          );
          // All or nothing per line: half a cross path is a stub.
          if (strips.length === 0) continue;
          if (strips.some((strip) => crossings.some((other) => overlaps(strip, other, PATH_WIDTH)))) {
            continue;
          }
          for (const strip of strips) {
            if (pathCount >= PATH_CAPACITY) break;
            lay(this.paths, pathCount++, strip, platform.topY, PATH_RISE);
            laid.push(strip);
            crossings.push(strip);
          }
        }
      }

      // 3. Lawns in what is left, each one bounded by the paths around it.
      const parks: Patch[] = [];
      for (let attempt = 0; attempt < LAWN_ATTEMPTS; attempt++) {
        if (lawnCount >= LAWN_CAPACITY) break;
        const width = rng.range(LAWN_MIN, Math.min(LAWN_MAX, usable.width * 0.5));
        const depth = rng.range(LAWN_MIN, Math.min(LAWN_MAX, usable.depth * 0.5));
        const lawn: Patch = {
          x: usable.x + rng.range(-1, 1) * (usable.width - width) * 0.5,
          z: usable.z + rng.range(-1, 1) * (usable.depth - depth) * 0.5,
          width,
          depth,
        };
        if (!clearOfBuildings(lawn)) continue;
        // A hair of overlap with the paving is deliberate: a lawn whose kerb
        // meets the path has an edge, and one floating in concrete does not.
        if (laid.some((other) => overlaps(lawn, other, -0.4))) continue;

        lay(this.lawns, lawnCount++, lawn, platform.topY, LAWN_RISE);
        laid.push(lawn);
        parks.push(lawn);
      }

      // 4. Trees, and only ever on a lawn.
      for (const park of parks) {
        const halfWidth = park.width * 0.5 - TREE_INSET;
        const halfDepth = park.depth * 0.5 - TREE_INSET;
        if (halfWidth <= 0 || halfDepth <= 0) continue;

        const planted: { x: number; z: number }[] = [];
        const attempts = Math.ceil((park.width * park.depth) / 40);
        for (let attempt = 0; attempt < attempts; attempt++) {
          if (treeCount >= TREE_CAPACITY) break;
          const x = park.x + rng.range(-halfWidth, halfWidth);
          const z = park.z + rng.range(-halfDepth, halfDepth);
          if (planted.some((t) => Math.hypot(x - t.x, z - t.z) < TREE_SPACING)) continue;

          const scale = TREE_HEIGHT * (1 + rng.range(-SIZE_SPREAD, SIZE_SPREAD));

          // Nothing grows up through the circuit. Measured against the actual
          // road above this spot rather than a blanket keep-out, because the
          // platforms are meant to run under it where it is high enough.
          _spot.set(x, platform.topY, z);
          const road = track.collision.query(_spot);
          const half = track.frameAt(road.s).width * 0.5;
          const under = Math.abs(road.lateral) < half + ROAD_HEADROOM;
          if (under && -road.height < scale + ROAD_HEADROOM) continue;

          planted.push({ x, z });
          _dummy.position.set(x, platform.topY + LAWN_RISE, z);
          // Yaw only. A tree leaning off a level lawn reads as damage, not as
          // variety, and the crown is round enough that a tilt buys nothing.
          _dummy.rotation.set(0, rng.range(0, Math.PI * 2), 0);
          _dummy.scale.setScalar(scale);
          _dummy.updateMatrix();
          this.trunks.setMatrixAt(treeCount, _dummy.matrix);
          this.crowns.setMatrixAt(treeCount, _dummy.matrix);

          // Foliage varies toward yellow-green and toward blue-green, never
          // past either: a park in a dozen different hues reads as a nursery.
          colour.setHSL(rng.range(0.22, 0.34), rng.range(0.35, 0.62), rng.range(0.22, 0.4));
          this.crowns.setColorAt(treeCount, colour);
          treeCount++;
        }
      }
    }

    this.lawns.count = lawnCount;
    this.paths.count = pathCount;
    this.trunks.count = treeCount;
    this.crowns.count = treeCount;
    for (const mesh of [this.lawns, this.paths, this.trunks, this.crowns]) {
      mesh.instanceMatrix.needsUpdate = true;
    }
    if (this.crowns.instanceColor) this.crowns.instanceColor.needsUpdate = true;

    this.group.add(this.lawns, this.paths, this.trunks, this.crowns);
  }

  dispose(): void {
    for (const mesh of [this.lawns, this.paths, this.trunks, this.crowns]) {
      mesh.geometry.dispose();
      (mesh.material as { dispose(): void }).dispose();
    }
  }

  // --- Geometry -------------------------------------------------------------

  /** A unit box with its origin at the base, for anything laid on a deck. */
  private static slab(): BufferGeometry {
    const box = new BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    return box;
  }

  /**
   * The trunk, in units of the tree's own height.
   *
   * Built at height 1 and scaled per instance, so one number sizes the whole
   * tree and the trunk can never end up the wrong length for its crown.
   */
  private static trunk(): BufferGeometry {
    const trunk = new CylinderGeometry(TRUNK_TOP, TRUNK_FOOT, CROWN_BASE + 0.1, 5, 1);
    trunk.scale(1 / TREE_HEIGHT, 1, 1 / TREE_HEIGHT);
    trunk.translate(0, (CROWN_BASE + 0.1) * 0.5, 0);
    return trunk;
  }

  /**
   * The crown: three squashed lobes rather than one ball.
   *
   * A single sphere on a stick is a lollipop from every angle. Three of them,
   * offset and at different sizes, give the silhouette the lumpiness that
   * actually reads as a tree at the distance these are ever seen from — and it
   * is sixty triangles, because they are unsubdivided icosahedra.
   */
  private static crown(): BufferGeometry {
    const lobes = [
      { x: 0, y: 0.68, z: 0, r: 1, squash: 0.86 },
      { x: 0.42, y: 0.56, z: 0.2, r: 0.66, squash: 0.9 },
      { x: -0.3, y: 0.6, z: -0.34, r: 0.6, squash: 0.92 },
    ];
    const parts = lobes.map((lobe) => {
      const ball = new IcosahedronGeometry(CROWN_RADIUS * lobe.r, 0);
      ball.scale(1, lobe.squash, 1);
      ball.translate(CROWN_RADIUS * lobe.x, lobe.y, CROWN_RADIUS * lobe.z);
      return ball;
    });
    const merged = mergeGeometries(parts, false);
    if (!merged) return parts[0]!;
    for (const part of parts) part.dispose();
    return merged;
  }

  // --- Materials ------------------------------------------------------------

  /** Mown grass: darker and greyer than the canopies standing on it. */
  private static grass(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    material.color = new Color(0x4f7a45);
    material.roughness = 0.95;
    material.metalness = 0;
    return material;
  }

  /**
   * Paving: a shade lighter than the deck it is laid on.
   *
   * Only a shade. The whole city is white concrete under a hard sun, and a
   * path in a contrasting colour would read as a painted marking rather than
   * as a change of surface — the edge shadow off `PATH_RISE` does more work
   * than the tone does.
   */
  private static paving(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    material.color = new Color(0xd7dade);
    material.roughness = 0.7;
    material.metalness = 0.03;
    return material;
  }

  /** Bark: dark, matt, and the same on every tree. */
  private static bark(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    material.color = new Color(0x4a4038);
    material.roughness = 0.92;
    material.metalness = 0;
    return material;
  }

  /** Foliage. White, so the instance colour multiplying through it is the leaf. */
  private static foliage(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    material.color = new Color(0xffffff);
    material.roughness = 0.86;
    material.metalness = 0;
    // Faceted on purpose: a smoothed icosahedron reads as a balloon, and the
    // flat faces catch the sun the way a canopy's layers do.
    material.flatShading = true;
    return material;
  }
}
