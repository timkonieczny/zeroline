import {
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

/**
 * Height of a tree, trunk and crown together, in metres.
 *
 * The one number that decides whether this reads as landscaping or as
 * shrubbery, and it is set against the buildings rather than picked: the
 * towers beside them are between 30 and 70 m across their base, so a tree has
 * to be small enough that the slab still reads as a city block. Nine metres is
 * a mature street tree.
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

/** Metres of clear deck between a tree and the building it stands beside. */
const BUILDING_CLEARANCE = 3.5;
/** Metres of deck left bare at the waterline edge. */
const EDGE_MARGIN = 3;
/** Metres between one tree and the next. */
const SPACING = 7.5;
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
/**
 * Attempts per platform at finding somewhere for a tree.
 *
 * Dart-throwing rather than a grid: a grid on a rectangle with buildings
 * punched out of it reads as an orchard, and the whole point is that these
 * look planted rather than printed. Most of a platform is building, so most
 * darts miss — which is why the budget is generous and the cap is on trees.
 */
const ATTEMPTS = 90;
/** Most trees on any one platform, and across the whole circuit. */
const PER_PLATFORM = 26;
const CAPACITY = 620;

const _dummy = new Object3D();
const _spot = new Vector3();

/**
 * Street trees on the concrete platforms the towers stand on.
 *
 * The slabs are laid nine metres clear of the buildings on them, which leaves
 * a border of bare concrete standing out of the sea — read as a plaza, and an
 * empty one. Planting it is what turns a slab into a place.
 *
 * Two instanced draws and no per-frame cost, which is the whole reason this is
 * affordable: a tree is eighty triangles, there are a few hundred of them, and
 * that is a rounding error beside the crowd already in the stands. They are
 * deliberately not shadow casters — the sun's map is one texture fitted around
 * the player, and spending its resolution on trees a quarter of a mile out to
 * sea would cost the circuit its own shadows.
 *
 * Trunk and crown are separate meshes for the same reason the crowd's bodies
 * and helmets are: the instance colour multiplies the whole material, so one
 * mesh would give every tree a brown crown or a green trunk.
 */
export class PlatformTrees {
  readonly group = new Group();
  private readonly trunks: InstancedMesh;
  private readonly crowns: InstancedMesh;

  constructor(platforms: readonly Platform[], track: Track) {
    const rng = new Rng(0x7ee5);

    this.trunks = new InstancedMesh(PlatformTrees.trunk(), PlatformTrees.bark(), CAPACITY);
    this.trunks.name = 'platform-trees';
    this.trunks.castShadow = false;
    this.trunks.receiveShadow = true;

    this.crowns = new InstancedMesh(PlatformTrees.crown(), PlatformTrees.foliage(), CAPACITY);
    this.crowns.name = 'platform-tree-crowns';
    this.crowns.castShadow = false;
    this.crowns.receiveShadow = true;

    const colour = new Color();
    const planted: { x: number; z: number }[] = [];
    let count = 0;

    for (const platform of platforms) {
      if (count >= CAPACITY) break;
      const halfWidth = platform.width * 0.5 - EDGE_MARGIN;
      const halfDepth = platform.depth * 0.5 - EDGE_MARGIN;
      if (halfWidth <= 0 || halfDepth <= 0) continue;

      planted.length = 0;
      for (let attempt = 0; attempt < ATTEMPTS && planted.length < PER_PLATFORM; attempt++) {
        if (count >= CAPACITY) break;

        const x = platform.centreX + rng.range(-halfWidth, halfWidth);
        const z = platform.centreZ + rng.range(-halfDepth, halfDepth);

        if (platform.occupied.some((b) => Math.hypot(x - b.x, z - b.z) < b.radius + BUILDING_CLEARANCE)) {
          continue;
        }
        if (planted.some((t) => Math.hypot(x - t.x, z - t.z) < SPACING)) continue;

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
        _dummy.position.set(x, platform.topY, z);
        // Yaw only. A tree leaning off a level slab reads as damage, not as
        // variety, and the crown is close enough to round that a tilt buys
        // nothing a rotation does not.
        _dummy.rotation.set(0, rng.range(0, Math.PI * 2), 0);
        _dummy.scale.setScalar(scale);
        _dummy.updateMatrix();
        this.trunks.setMatrixAt(count, _dummy.matrix);
        this.crowns.setMatrixAt(count, _dummy.matrix);

        // Foliage varies toward yellow-green and toward blue-green, never past
        // either: a stand of trees in a dozen different hues reads as a
        // nursery, and this city is meant to be planted, not planned by
        // committee.
        colour.setHSL(rng.range(0.22, 0.34), rng.range(0.35, 0.62), rng.range(0.22, 0.4));
        this.crowns.setColorAt(count, colour);

        count++;
      }
    }

    this.trunks.count = count;
    this.crowns.count = count;
    this.trunks.instanceMatrix.needsUpdate = true;
    this.crowns.instanceMatrix.needsUpdate = true;
    if (this.crowns.instanceColor) this.crowns.instanceColor.needsUpdate = true;

    this.group.add(this.trunks, this.crowns);
  }

  dispose(): void {
    for (const mesh of [this.trunks, this.crowns]) {
      mesh.geometry.dispose();
      (mesh.material as { dispose(): void }).dispose();
    }
  }

  // --- Geometry -------------------------------------------------------------

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
