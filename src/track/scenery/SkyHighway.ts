import { Group, InstancedMesh, OctahedronGeometry, Vector3 } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { mrt, output, vec4 } from 'three/tsl';
import { color, cos, float, fract, instanceIndex, mix, positionLocal, sin, smoothstep, uniform, vec3 } from 'three/tsl';
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

const _centre = new Vector3();

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
 * Where the traffic lanes run, on the CPU.
 *
 * The shader derives this arithmetically from the instance index; this returns
 * the same lattice so the skyline can be built around it. Lowering the highway
 * to where it is actually visible put it straight through the tops of the tall
 * towers, and the cheapest honest fix is to let the city know where the traffic
 * is and duck under it.
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

/**
 * Commuter traffic in the sky above the circuit.
 *
 * Pure set dressing — it has no collision, no gameplay effect and no CPU cost.
 * Every craft's position along its lane is computed in the vertex shader from
 * its instance index and the clock, so two hundred and thirty moving objects are
 * one draw call and zero JavaScript per frame.
 *
 * The lanes are straight because they are meant to be: a city's freight lanes
 * would be, and a straight line of lights crossing the sky reads instantly as
 * "somewhere else, going somewhere else" without ever competing with the racing
 * line for attention.
 */
export class SkyHighway {
  readonly group = new Group();
  private readonly mesh: InstancedMesh;
  private readonly clock = uniform(0);
  /** Where the lanes are centred, so they follow the circuit rather than the origin. */
  private readonly centre = uniform(new Vector3());

  constructor(track: Track) {
    this.centre.value.copy(trackCentre(track, _centre));

    // A squashed octahedron reads as a distant craft from any angle.
    const geometry = new OctahedronGeometry(1, 0);
    geometry.scale(1.6, 0.55, 4.2);

    this.mesh = new InstancedMesh(geometry, this.material(), LANES * PER_LANE);
    this.mesh.name = 'sky-highway';
    this.mesh.frustumCulled = false;
    // They are far away and never in the shadow frustum; skip both.
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.group.add(this.mesh);
  }

  update(dt: number): void {
    this.clock.value += dt;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as { dispose(): void }).dispose();
  }

  /**
   * Places and shades one craft entirely on the GPU.
   *
   * Lane parameters are derived arithmetically from the lane index rather than
   * looked up, which keeps the whole thing to a handful of instructions and
   * avoids shipping a per-instance buffer for data that never changes.
   */
  private material(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();

    const index = instanceIndex.toFloat();
    const lane = index.mod(float(LANES));
    const slot = index.div(float(LANES)).floor();

    // Heading, altitude and lateral offset spread the lanes into a lattice.
    const heading = lane.mul(0.74).add(0.35);
    // Low enough to be part of the city rather than a detail in the sky. The
    // skyline is clipped out of these corridors rather than the other way
    // round — see `skyHighwayLanes`.
    const altitude = lane.mul(LANE_RISE).add(BASE_ALTITUDE);
    const sideways = lane.sub((LANES - 1) / 2).mul(LANE_SPACING);
    const speed = lane.mul(7).add(34);

    const dirX = cos(heading);
    const dirZ = sin(heading);
    // Perpendicular to the lane, in the ground plane.
    const perpX = dirZ.negate();
    const perpZ = dirX;

    // Spacing along the lane, scrolling with the clock and wrapping. The slots
    // are evenly divided and then jittered by a per-craft hash: perfectly even
    // spacing is the one thing that reads instantly as a shader rather than as
    // traffic. The jitter stays under half a slot, so nothing overtakes.
    const jitter = fract(sin(slot.mul(12.9898).add(lane.mul(78.233))).mul(43758.5453))
      .sub(0.5)
      .mul(0.8)
      .div(float(PER_LANE));
    const progress = fract(slot.div(float(PER_LANE)).add(jitter).add(this.clock.mul(speed).div(LANE_LENGTH)));
    const along = progress.sub(0.5).mul(LANE_LENGTH);

    // Rotate the hull to face down its lane.
    const localX = positionLocal.x.mul(dirZ).sub(positionLocal.z.mul(dirX));
    const localZ = positionLocal.x.mul(dirX).add(positionLocal.z.mul(dirZ));

    const worldX = this.centre.x.add(dirX.mul(along)).add(perpX.mul(sideways)).add(localX);
    const worldZ = this.centre.z.add(dirZ.mul(along)).add(perpZ.mul(sideways)).add(localZ);
    const worldY = altitude.add(positionLocal.y);

    material.positionNode = vec3(worldX, worldY, worldZ);

    // Zero velocity, deliberately.
    //
    // Three computes the velocity buffer from `positionLocal` and the object's
    // previous world matrix. This material throws `positionLocal` away and
    // derives each craft's position from its index and the clock, so the
    // velocity three computes is for a stationary octahedron at the group's
    // origin — a vector with nothing to do with where the craft is drawn.
    // Motion blur followed it and the traffic smeared across the sky.
    //
    // The honest fix would be to evaluate the same formula one frame back, which
    // needs the matrices the velocity node keeps to itself. These are specks at
    // two kilometres: no blur is a far better answer than the wrong blur.
    material.mrtNode = mrt({ output, velocity: vec4(0, 0, 0, 0) });

    // Dark body, hot tail. The tail is what actually reads at this distance.
    const tail = smoothstep(float(-1), float(-3.4), positionLocal.z);
    const hue = fract(slot.mul(0.31));
    const lights = mix(color(0xff5a4a), color(0x7ad8ff), hue);
    material.colorNode = vec3(0.06, 0.07, 0.09);
    material.emissiveNode = lights.mul(tail).mul(3.4);
    material.roughnessNode = float(0.55);
    return material;
  }
}
