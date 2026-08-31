import { Group, InstancedMesh, OctahedronGeometry, Vector3 } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { color, cos, float, fract, instanceIndex, mix, positionLocal, sin, smoothstep, uniform, vec3 } from 'three/tsl';
import type { Track } from '../Track';

/** Lanes of traffic crossing the sky. */
const LANES = 5;
/** Craft per lane. */
const PER_LANE = 46;
/** Length of each lane, in metres. */
const LANE_LENGTH = 3400;

const _centre = new Vector3();

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
    // Rough centroid of the circuit, so the lanes span it.
    const sum = new Vector3();
    const point = new Vector3();
    const samples = 32;
    for (let i = 0; i < samples; i++) {
      sum.add(track.spline.positionOfSample(Math.floor((i / samples) * track.spline.count), point));
    }
    _centre.copy(sum).divideScalar(samples);
    this.centre.value.copy(_centre);

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
    const altitude = lane.mul(34).add(96);
    const sideways = lane.sub((LANES - 1) / 2).mul(210);
    const speed = lane.mul(7).add(34);

    const dirX = cos(heading);
    const dirZ = sin(heading);
    // Perpendicular to the lane, in the ground plane.
    const perpX = dirZ.negate();
    const perpZ = dirX;

    // Even spacing along the lane, scrolling with the clock and wrapping.
    const progress = fract(slot.div(float(PER_LANE)).add(this.clock.mul(speed).div(LANE_LENGTH)));
    const along = progress.sub(0.5).mul(LANE_LENGTH);

    // Rotate the hull to face down its lane.
    const localX = positionLocal.x.mul(dirZ).sub(positionLocal.z.mul(dirX));
    const localZ = positionLocal.x.mul(dirX).add(positionLocal.z.mul(dirZ));

    const worldX = this.centre.x.add(dirX.mul(along)).add(perpX.mul(sideways)).add(localX);
    const worldZ = this.centre.z.add(dirZ.mul(along)).add(perpZ.mul(sideways)).add(localZ);
    const worldY = altitude.add(positionLocal.y);

    material.positionNode = vec3(worldX, worldY, worldZ);

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
