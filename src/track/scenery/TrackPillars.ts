import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Object3D,
  Vector3,
} from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { Rng } from '@/core/Rng';
import type { Track } from '../Track';
import { LANE_CLEARANCE, LANE_HALF_WIDTH, skyHighwayLanes, type SkyLane } from './SkyHighway';
import { SEA_LEVEL } from './Environment';

/**
 * Metres of road between one pillar and the next.
 *
 * Deliberately far apart. The circuit is meant to read as held up by a magnetic
 * spine with the odd column where the span is longest, not as a viaduct — the
 * point is to answer "what is this resting on" once every few seconds, not to
 * put a leg under every metre of it.
 */
const PILLAR_SPACING = 235;
/** Metres of jitter either side of that, so the rhythm is not metronomic. */
const PILLAR_JITTER = 55;
/** Below this much clear water underneath, a pillar is a stub. Skip it. */
const MIN_SPAN = 22;
/** Metres of road either side of a tunnel mouth that stay clear of columns. */
const TUNNEL_MARGIN = 60;
/** Gap between the top of the capital and the road surface, in metres. */
const DECK_GAP = 1.1;

/** Half-thickness of the capital that spreads the load under the road, in metres. */
const CAPITAL_DEPTH = 2.6;
/** How much of the road's width the capital spans. */
const CAPITAL_SPAN = 0.72;
/** Length of the capital along the road, in metres. */
const CAPITAL_LENGTH = 9.5;

/** Shaft radius where it meets the capital, and where it meets the water. */
const SHAFT_TOP = 2.9;
const SHAFT_FOOT = 4.6;
/** Metres the shaft is sunk below the waterline, so it never floats on a swell. */
const SHAFT_DRAFT = 7;

const MAX_PILLARS = 32;

const _dummy = new Object3D();
const _basis = new Matrix4();
const _up = new Vector3();
/** The tangent, negated: `(right, up, tangent)` is left-handed. See below. */
const _back = new Vector3();
const _right = new Vector3();

/**
 * The columns the circuit stands on.
 *
 * The road is a ribbon in the air over open water, and from any camera that
 * sees under it that reads as unfinished rather than as anti-gravity — the
 * craft hover, the circuit does not. A handful of concrete columns is enough to
 * settle the question, and being handful-sized is the whole design: they are
 * placed on the long spans, never in a tunnel, and never where the sky highway
 * passes underneath.
 *
 * Two instanced meshes and no per-frame cost.
 */
export class TrackPillars {
  readonly group = new Group();
  private readonly shafts: InstancedMesh;
  private readonly capitals: InstancedMesh;

  constructor(track: Track) {
    const rng = new Rng(0x51dd0c);
    const lanes = skyHighwayLanes(track);

    // Tapered, and its origin at the top: a pillar is positioned by where it
    // meets the road and grows downward to whatever the water is.
    const shaft = new CylinderGeometry(SHAFT_TOP, SHAFT_FOOT, 1, 12, 1, true);
    shaft.translate(0, -0.5, 0);
    this.shafts = new InstancedMesh(shaft, TrackPillars.concrete(0.74), MAX_PILLARS);
    this.shafts.name = 'track-pillars';
    this.shafts.castShadow = true;
    this.shafts.receiveShadow = true;

    const capital = new BoxGeometry(1, 1, 1);
    this.capitals = new InstancedMesh(capital, TrackPillars.concrete(0.82), MAX_PILLARS);
    this.capitals.name = 'track-pillar-capitals';
    this.capitals.castShadow = true;
    this.capitals.receiveShadow = true;

    let count = 0;
    let next = rng.range(0, PILLAR_SPACING);
    for (let s = 0; s < track.length && count < MAX_PILLARS; s += 4) {
      if (s < next) continue;
      next = s + PILLAR_SPACING + rng.range(-PILLAR_JITTER, PILLAR_JITTER);

      if (TrackPillars.nearTunnel(track, s)) continue;

      const frame = track.frameAt(s);
      const top = frame.position.y - DECK_GAP - CAPITAL_DEPTH;
      if (top - SEA_LEVEL < MIN_SPAN) continue;
      if (TrackPillars.underLane(frame.position.x, frame.position.z, top, lanes)) continue;

      // The capital lies under the road and shares its bank, so a column on a
      // cambered corner meets the deck flush instead of cutting a wedge out.
      _up.copy(frame.up);
      // Negated, so the basis is right-handed. A track frame's `right` is
      // `tangent x up`, which makes `(right, up, tangent)` a reflection — and a
      // quaternion cannot hold one, so `setFromRotationMatrix` discards it and
      // returns an unrelated rotation instead.
      _back.copy(frame.tangent).negate();
      _right.copy(frame.right);
      _basis.makeBasis(_right, _up, _back);
      _dummy.quaternion.setFromRotationMatrix(_basis);
      _dummy.position.copy(frame.position).addScaledVector(frame.up, -DECK_GAP - CAPITAL_DEPTH * 0.5);
      _dummy.scale.set(frame.width * CAPITAL_SPAN, CAPITAL_DEPTH, CAPITAL_LENGTH);
      _dummy.updateMatrix();
      this.capitals.setMatrixAt(count, _dummy.matrix);

      // The shaft is plumb whatever the road above it is doing. A leaning
      // column reads as a mistake even when the road it holds up is banked.
      _dummy.quaternion.identity();
      _dummy.position.set(frame.position.x, top, frame.position.z);
      _dummy.scale.set(1, top - SEA_LEVEL + SHAFT_DRAFT, 1);
      _dummy.updateMatrix();
      this.shafts.setMatrixAt(count, _dummy.matrix);

      count++;
    }

    this.shafts.count = count;
    this.capitals.count = count;
    this.shafts.instanceMatrix.needsUpdate = true;
    this.capitals.instanceMatrix.needsUpdate = true;

    this.group.add(this.shafts, this.capitals);
  }

  dispose(): void {
    for (const mesh of [this.shafts, this.capitals]) {
      mesh.geometry.dispose();
      (mesh.material as { dispose(): void }).dispose();
    }
  }

  /** True inside a tunnel or within a margin of one's mouth. */
  private static nearTunnel(track: Track, s: number): boolean {
    for (let offset = -TUNNEL_MARGIN; offset <= TUNNEL_MARGIN; offset += 12) {
      const at = (s + offset + track.length) % track.length;
      if (track.isInTunnel(at)) return true;
    }
    return false;
  }

  /** True when a traffic lane passes through where the shaft would stand. */
  private static underLane(x: number, z: number, top: number, lanes: readonly SkyLane[]): boolean {
    for (const lane of lanes) {
      if (lane.altitude - LANE_CLEARANCE > top) continue;
      const across = Math.abs((x - lane.originX) * lane.dirZ - (z - lane.originZ) * lane.dirX);
      if (across <= SHAFT_FOOT + LANE_HALF_WIDTH) return true;
    }
    return false;
  }

  /** Poured concrete: bright, matt, and a touch warmer than the buildings. */
  private static concrete(value: number): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    material.color = new Color().setRGB(value, value * 0.995, value * 0.975);
    material.roughness = 0.86;
    material.metalness = 0;
    return material;
  }
}
