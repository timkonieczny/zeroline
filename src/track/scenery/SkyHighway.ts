import { Color, Group, InstancedMesh, Object3D, OctahedronGeometry, Vector3 } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { float, fract, instanceIndex, positionLocal, smoothstep, vec3 } from 'three/tsl';
import type { Track } from '../Track';

/** Lanes of traffic crossing the sky. */
const LANES = 5;
/** Craft per lane. */
const PER_LANE = 46;
/** Length of each lane, in metres. */
const LANE_LENGTH = 3400;
/** Lowest lane's height above the circuit datum, in metres. */
const BASE_ALTITUDE = 74;
/** Metres between one lane and the next. */
const LANE_RISE = 20;
/** Metres between lanes, measured across the lattice. */
const LANE_SPACING = 210;
/**
 * Half-width of the corridor a lane needs kept clear, in metres.
 *
 * The craft themselves are a few metres across; the rest is the margin that
 * keeps a tower from appearing to clip one as it passes.
 */
export const LANE_HALF_WIDTH = 16;
/** Vertical air demanded between a lane and anything under it. */
export const LANE_CLEARANCE = 22;

const _dummy = new Object3D();
const _tint = new Color();
const _hot = new Color(0xff5a4a);
const _cool = new Color(0x7ad8ff);

/** One lane of sky traffic, as a straight line in the ground plane. */
export interface SkyLane {
  /** A point the lane passes through. */
  originX: number;
  originZ: number;
  /** Unit direction along the lane. */
  dirX: number;
  dirZ: number;
  /** Height above the circuit datum. */
  altitude: number;
}

/** Rough centroid of the circuit, so the lanes span it rather than the origin. */
function trackCentre(track: Track, out: Vector3): Vector3 {
  const sum = new Vector3();
  const point = new Vector3();
  const samples = 32;
  for (let i = 0; i < samples; i++) {
    sum.add(track.spline.positionOfSample(Math.floor((i / samples) * track.spline.count), point));
  }
  return out.copy(sum).divideScalar(samples);
}

/**
 * Where the traffic lanes run.
 *
 * Also what the skyline is built around. Lowering the highway to where it is
 * actually visible put it straight through the tops of the tall towers, and the
 * cheapest honest fix is to let the city know where the traffic is and duck
 * under it.
 */
export function skyHighwayLanes(track: Track): SkyLane[] {
  const centre = trackCentre(track, new Vector3());
  const lanes: SkyLane[] = [];
  for (let lane = 0; lane < LANES; lane++) {
    const heading = lane * 0.74 + 0.35;
    const dirX = Math.cos(heading);
    const dirZ = Math.sin(heading);
    const sideways = (lane - (LANES - 1) / 2) * LANE_SPACING;
    lanes.push({
      originX: centre.x + -dirZ * sideways,
      originZ: centre.z + dirX * sideways,
      dirX,
      dirZ,
      altitude: lane * LANE_RISE + BASE_ALTITUDE,
    });
  }
  return lanes;
}

/** Deterministic hash in [0, 1) from two small integers. */
function hash(a: number, b: number): number {
  const x = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Commuter traffic in the sky above the circuit.
 *
 * Pure set dressing: no collision, no gameplay effect, one draw call.
 *
 * The positions used to be derived in the vertex shader from the instance index
 * and a clock, which was cheaper still and quietly broke the motion blur. Three
 * builds the velocity buffer from `positionLocal` and the object's previous
 * matrix, and a material that computes its own position throws the first of
 * those away — so every craft reported the velocity of a stationary octahedron
 * at the group's origin and the blur smeared the traffic across the sky
 * accordingly. Writing real instance matrices costs a few hundred `compose`
 * calls a frame and buys correct velocity for nothing, because three keeps
 * previous instance matrices for exactly this case.
 *
 * The lanes are straight because they are meant to be: a city's freight lanes
 * would be, and a straight line of lights crossing the sky reads instantly as
 * "somewhere else, going somewhere else" without ever competing with the racing
 * line for attention.
 */
export class SkyHighway {
  readonly group = new Group();
  private readonly mesh: InstancedMesh;
  private clock = 0;
  private readonly lanes: SkyLane[];
  private readonly speeds: number[] = [];
  /** Each craft's place in its lane at time zero, as a fraction of the lane. */
  private readonly offsets: number[] = [];

  constructor(track: Track) {
    this.lanes = skyHighwayLanes(track);

    // A squashed octahedron reads as a distant craft from any angle.
    const geometry = new OctahedronGeometry(1, 0);
    geometry.scale(1.6, 0.55, 4.2);

    this.mesh = new InstancedMesh(geometry, SkyHighway.material(), LANES * PER_LANE);
    this.mesh.name = 'sky-highway';
    this.mesh.frustumCulled = false;
    // They are far away and never in the shadow frustum; skip both.
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;

    for (let i = 0; i < LANES * PER_LANE; i++) {
      const lane = i % LANES;
      const slot = Math.floor(i / LANES);
      this.speeds.push(lane * 7 + 34);
      // Evenly divided, then jittered by a per-craft hash. Perfectly even
      // spacing is the one thing that reads instantly as a mechanism rather
      // than as traffic. The jitter stays under half a slot, so nothing
      // overtakes and no lane bunches.
      this.offsets.push((slot + (hash(slot, lane) - 0.5) * 0.8) / PER_LANE);

      _tint.copy(_hot).lerp(_cool, hash(lane, slot));
      this.mesh.setColorAt(i, _tint);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;

    this.place();
    this.group.add(this.mesh);
  }

  update(dt: number): void {
    this.clock += dt;
    this.place();
  }

  /** Writes this frame's instance matrices. */
  private place(): void {
    for (let i = 0; i < LANES * PER_LANE; i++) {
      const lane = this.lanes[i % LANES]!;
      const progress = (this.offsets[i]! + (this.clock * this.speeds[i]!) / LANE_LENGTH) % 1;
      const along = (progress - 0.5) * LANE_LENGTH;

      _dummy.position.set(
        lane.originX + lane.dirX * along,
        lane.altitude,
        lane.originZ + lane.dirZ * along,
      );
      // Nose down the lane. The hull's long axis is z, so the yaw comes from the
      // lane's direction rather than from its heading angle.
      _dummy.rotation.set(0, Math.atan2(lane.dirX, lane.dirZ), 0);
      _dummy.updateMatrix();
      this.mesh.setMatrixAt(i, _dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as { dispose(): void }).dispose();
  }

  /**
   * A dark body with a hot tail.
   *
   * At two kilometres the tail is the only part that reads at all, so it is the
   * only part given any care: the hull is near-black and the glow behind it
   * carries the craft's own colour, written per instance.
   */
  private static material(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    const tail = smoothstep(float(-1), float(-3.4), positionLocal.z);
    // A slow shimmer, so a lane is not a line of identical lamps.
    const shimmer = fract(instanceIndex.toFloat().mul(0.618)).mul(0.35).add(0.8);

    material.colorNode = vec3(0.06, 0.07, 0.09);
    material.emissiveNode = tail.mul(shimmer).mul(3.4);
    material.roughnessNode = float(0.55);
    // The instance colour tints the emissive tail rather than the hull.
    material.vertexColors = true;
    return material;
  }
}
