import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, DoubleSide, Group, Mesh, type Object3D } from 'three';
import { MeshBasicNodeMaterial, MeshPhysicalNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import {
  color,
  float,
  mix,
  mx_fractal_noise_float,
  oneMinus,
  positionLocal,
  sin,
  smoothstep,
  time,
  uniform,
  uv,
  vec3,
} from 'three/tsl';
import type { HullSpec, Team } from '@/data/teams';
import { clamp01, lerp } from '@/core/math';

/**
 * Length the plume geometry is built at, in metres.
 *
 * The shader stretches it from here; it is a reference, not the flame anyone
 * actually sees.
 */
const FLAME_REFERENCE = 2.6;

/** Cross-section of the hull, as fractions of half-beam and half-height. */
const SECTION: readonly (readonly [number, number])[] = [
  [1, 0.12],
  [0.82, 0.72],
  [0.3, 1],
  [-0.3, 1],
  [-0.82, 0.72],
  [-1, 0.12],
  [-0.86, -0.52],
  [-0.25, -0.8],
  [0.25, -0.8],
  [0.86, -0.52],
];

/** Stations along the hull, nose to tail. More near the nose, where it changes fastest. */
const STATIONS = 18;

interface Sweep {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

function emptySweep(): Sweep {
  return { positions: [], normals: [], uvs: [], indices: [] };
}

/** Copies one sweep onto the end of another, rebasing its indices. */
function appendSweep(target: Sweep, source: Sweep): void {
  const offset = target.positions.length / 3;
  target.positions.push(...source.positions);
  target.uvs.push(...source.uvs);
  for (const index of source.indices) target.indices.push(index + offset);
}

/**
 * Flips the winding of a closed shell if it came out inside-out.
 *
 * The signed volume of a closed mesh is positive when its faces wind
 * counter-clockwise seen from outside, and negative when they do not. Sweeps
 * are easy to get backwards — every hull in this game was built inside-out
 * for a while, which reads as a craft you can see straight through, because
 * the near wall is culled and the far wall's interior is not. Checking is two
 * dozen lines and removes the whole class of mistake.
 */
function ensureOutwardWinding(sweep: Sweep): void {
  const { positions, indices } = sweep;
  let volume = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]! * 3;
    const b = indices[i + 1]! * 3;
    const c = indices[i + 2]! * 3;
    const ax = positions[a]!, ay = positions[a + 1]!, az = positions[a + 2]!;
    const bx = positions[b]!, by = positions[b + 1]!, bz = positions[b + 2]!;
    const cx = positions[c]!, cy = positions[c + 1]!, cz = positions[c + 2]!;
    volume += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  if (volume >= 0) return;
  for (let i = 0; i < indices.length; i += 3) {
    const swap = indices[i + 1]!;
    indices[i + 1] = indices[i + 2]!;
    indices[i + 2] = swap;
  }
}

function toGeometry(sweep: Sweep): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(sweep.positions), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(sweep.uvs), 2));
  geometry.setIndex(sweep.indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** How wide the hull is at station `t`, 0 at the nose and 1 at the tail. */
function beamProfile(t: number, nose: number): number {
  const noseTaper = Math.pow(t, 0.45 + nose * 1.15);
  const tailTaper = 1 - 0.28 * Math.pow(t, 4);
  return noseTaper * tailTaper;
}

function heightProfile(t: number, nose: number): number {
  const noseTaper = Math.pow(t, 0.4 + nose * 0.7);
  const tailTaper = 1 - 0.18 * Math.pow(t, 5);
  return noseTaper * tailTaper;
}

/**
 * Builds the hull by sweeping the cross-section from nose to tail.
 *
 * Exported so the geometry audit can check its winding without a GPU.
 *
 * Craft point down -Z, matching the three.js convention, so the nose sits at
 * -length/2 and the thrusters at +length/2.
 */
export function buildHull(hull: HullSpec): BufferGeometry {
  const sweep = emptySweep();
  const across = SECTION.length;

  for (let i = 0; i < STATIONS; i++) {
    // Bias the stations toward the nose, where the silhouette does the work.
    const t = Math.pow(i / (STATIONS - 1), 0.78);
    const z = lerp(-hull.length * 0.5, hull.length * 0.5, t);
    const halfBeam = (hull.beam * 0.5) * beamProfile(t, hull.nose);
    const halfHeight = hull.height * heightProfile(t, hull.nose);

    for (let c = 0; c < across; c++) {
      const [sx, sy] = SECTION[c]!;
      sweep.positions.push(sx * halfBeam, sy * halfHeight, z);
      sweep.uvs.push(c / across, t);
    }
  }

  for (let i = 0; i < STATIONS - 1; i++) {
    for (let c = 0; c < across; c++) {
      const c2 = (c + 1) % across;
      const a = i * across + c;
      const b = i * across + c2;
      const d = (i + 1) * across + c;
      const e = (i + 1) * across + c2;
      sweep.indices.push(a, d, b, b, d, e);
    }
  }

  // Cap the tail so the hull is closed.
  const last = (STATIONS - 1) * across;
  const centre = sweep.positions.length / 3;
  sweep.positions.push(0, 0, hull.length * 0.5);
  sweep.uvs.push(0.5, 1);
  for (let c = 0; c < across; c++) {
    sweep.indices.push(last + c, centre, last + ((c + 1) % across));
  }

  ensureOutwardWinding(sweep);
  return toGeometry(sweep);
}

/** A swept fin plate, mirrored to both sides of the tail. */
export function buildFins(hull: HullSpec): BufferGeometry {
  const sweep = emptySweep();
  const span = hull.beam * hull.finSpan * 0.5;
  const rake = (hull.finRake * Math.PI) / 180;
  const rootZ = hull.length * 0.06;
  const tipZ = hull.length * 0.5;
  const thickness = 0.11;

  for (const side of [-1, 1] as const) {
    // Each plate is built and corrected on its own. Mirroring across X reverses
    // handedness, so emitting both from one loop leaves the second plate wound
    // inside-out — and a combined signed volume of nearly zero, which hides it.
    const plate = emptySweep();
    const rootX = side * hull.beam * 0.42;
    // Four corners of the plate, raked upward and outward toward the tail.
    const corners: [number, number, number][] = [
      [rootX, hull.height * 0.25, rootZ],
      [rootX + side * span, hull.height * 0.25 + Math.sin(rake) * span, tipZ * 0.72],
      [rootX + side * span, hull.height * 0.25 + Math.sin(rake) * span, tipZ],
      [rootX, hull.height * 0.1, tipZ],
    ];
    for (const offset of [-thickness, thickness]) {
      for (const [x, y, z] of corners) {
        plate.positions.push(x + side * offset, y, z);
        plate.uvs.push((z - rootZ) / (tipZ - rootZ), y / hull.height);
      }
    }
    // Two faces plus the four edges of the plate.
    const quads: [number, number, number, number][] = [
      [0, 1, 2, 3],
      [7, 6, 5, 4],
      [0, 4, 5, 1],
      [1, 5, 6, 2],
      [2, 6, 7, 3],
      [3, 7, 4, 0],
    ];
    for (const [a, b, c, d] of quads) {
      plate.indices.push(a, b, c, a, c, d);
    }

    ensureOutwardWinding(plate);
    appendSweep(sweep, plate);
  }

  return toGeometry(sweep);
}

/**
 * The canopy: a raked screen over the middle of the hull.
 *
 * Half the height it used to be, and its peak sits three-quarters of the way
 * back rather than near the middle, so the glass runs down to the nose in one
 * long slope instead of bulging over the cockpit. The old profile was a bubble
 * — correct for a canopy you climb into, wrong for something doing 400 km/h.
 *
 * Every ring is seated on the hull's own deck at that station rather than at
 * one fixed height. Sitting them all at 55% of the hull's height worked for the
 * craft whose noses stay tall and left the others with their screen tapering to
 * a point in mid-air ahead of the bodywork — the deck drops away toward the
 * nose and the canopy did not follow it down.
 */
export function buildCanopy(hull: HullSpec): BufferGeometry {
  const sweep = emptySweep();
  const rings = 12;
  const across = 9;
  // Forward is -z. Reaching further forward is what buys the rake.
  const fromZ = -hull.length * 0.26;
  const toZ = hull.length * 0.2;
  const rise = hull.height * (0.55 + hull.canopy * 1.35) * 0.5;
  const beam = hull.beam * 0.22;
  /** Where along the canopy the screen tops out, 0 at the nose end. */
  const peak = 0.74;
  /** How far the skirt is buried in the hull, in metres. */
  const sink = hull.height * 0.07;

  for (let i = 0; i < rings; i++) {
    const t = i / (rings - 1);
    const z = lerp(fromZ, toZ, t);
    // A long concave ramp up from the nose, then a short fastback to the tail.
    const shape = t <= peak
      ? Math.pow(t / peak, 1.4)
      : Math.cos(((t - peak) / (1 - peak)) * (Math.PI / 2));

    // The hull's own deck and beam at this station, from the same profiles the
    // hull sweep uses. Following them is what keeps the join closed.
    const station = clamp01(z / hull.length + 0.5);
    const deck = hull.height * heightProfile(station, hull.nose) - sink;
    const halfBeam = Math.min(beam, hull.beam * 0.5 * beamProfile(station, hull.nose) * 0.62);

    for (let c = 0; c < across; c++) {
      const a = (c / (across - 1)) * Math.PI;
      sweep.positions.push(
        Math.cos(a) * halfBeam * shape,
        deck + Math.sin(a) * rise * shape,
        z,
      );
      sweep.uvs.push(c / (across - 1), t);
    }
  }
  for (let i = 0; i < rings - 1; i++) {
    for (let c = 0; c < across - 1; c++) {
      const a = i * across + c;
      const b = a + 1;
      const d = a + across;
      const e = d + 1;
      sweep.indices.push(a, d, b, b, d, e);
    }
  }
  return toGeometry(sweep);
}

/** Thruster nozzles across the stern, as short open tubes. */
function buildThrusters(hull: HullSpec): BufferGeometry {
  const sweep = emptySweep();
  const count = hull.thrusters;
  const radius = Math.min(0.62, (hull.beam * 0.5) / (count * 1.7));
  const segments = 10;
  const z0 = hull.length * 0.36;
  const z1 = hull.length * 0.52;

  for (let n = 0; n < count; n++) {
    const spread = count === 1 ? 0 : (n / (count - 1) - 0.5) * hull.beam * 0.52;
    const base = sweep.positions.length / 3;
    for (let ring = 0; ring < 2; ring++) {
      const z = ring === 0 ? z0 : z1;
      const r = ring === 0 ? radius * 0.8 : radius;
      for (let c = 0; c < segments; c++) {
        const a = (c / segments) * Math.PI * 2;
        sweep.positions.push(spread + Math.cos(a) * r, hull.height * 0.05 + Math.sin(a) * r * 0.8, z);
        sweep.uvs.push(c / segments, ring);
      }
    }
    for (let c = 0; c < segments; c++) {
      const c2 = (c + 1) % segments;
      sweep.indices.push(base + c, base + segments + c, base + c2, base + c2, base + segments + c, base + segments + c2);
    }
    // Flat disc closing the back of the nozzle: this is what glows.
    const centre = sweep.positions.length / 3;
    sweep.positions.push(spread, hull.height * 0.05, z1);
    sweep.uvs.push(0.5, 1);
    for (let c = 0; c < segments; c++) {
      sweep.indices.push(base + segments + c, centre, base + segments + ((c + 1) % segments));
    }
  }
  return toGeometry(sweep);
}

/**
 * The exhaust plumes: one open cone behind each nozzle.
 *
 * Built at a reference length and stretched in the vertex stage, so the flame
 * grows with speed without touching a buffer. `uv().y` runs 0 at the nozzle
 * mouth to 1 at the tip, which is the only coordinate the shader needs — the
 * stretch, the colour ramp and the fade all key off it.
 */
function buildFlames(hull: HullSpec): BufferGeometry {
  const sweep = emptySweep();
  const count = hull.thrusters;
  const radius = Math.min(0.62, (hull.beam * 0.5) / (count * 1.7));
  const segments = 12;
  const rings = 8;
  const mouthZ = hull.length * 0.5;

  for (let n = 0; n < count; n++) {
    const spread = count === 1 ? 0 : (n / (count - 1) - 0.5) * hull.beam * 0.52;
    for (let ring = 0; ring < rings; ring++) {
      const t = ring / (rings - 1);
      // Swells just past the mouth, then necks down to a point.
      const taper = Math.sin(Math.PI * Math.pow(t, 0.45)) * (1 - t * 0.35) + 0.08;
      const r = radius * 0.92 * taper;
      for (let c = 0; c < segments; c++) {
        const a = (c / segments) * Math.PI * 2;
        sweep.positions.push(
          spread + Math.cos(a) * r,
          hull.height * 0.05 + Math.sin(a) * r * 0.8,
          mouthZ + t * FLAME_REFERENCE,
        );
        sweep.uvs.push(c / segments, t);
      }
    }
    const base = n * rings * segments;
    for (let ring = 0; ring < rings - 1; ring++) {
      for (let c = 0; c < segments; c++) {
        const c2 = (c + 1) % segments;
        const a = base + ring * segments + c;
        const b = base + ring * segments + c2;
        const d = a + segments;
        const e = b + segments;
        sweep.indices.push(a, d, b, b, d, e);
      }
    }
  }
  return toGeometry(sweep);
}

/**
 * One craft's visual model, built entirely from its team's `HullSpec`.
 *
 * Nothing here is loaded: the silhouette, the livery and the engine glow all
 * come out of a dozen numbers per team. That keeps the repository free of binary
 * assets, makes a new constructor a five-line change, and means the ships in the
 * menu and the ships on track are provably the same object.
 */
export class GliderModel {
  readonly group = new Group();
  private readonly thrustUniform = uniform(0);
  private readonly boostUniform = uniform(0);
  private readonly damageUniform = uniform(0);

  constructor(readonly team: Team) {
    const hull = team.hull;
    const primary = new Color(team.colours.primary);
    const secondary = new Color(team.colours.secondary);
    const accent = new Color(team.colours.accent);

    const body = new Mesh(buildHull(hull), this.bodyMaterial(primary, secondary, accent));
    const fins = new Mesh(buildFins(hull), this.bodyMaterial(primary, secondary, accent));
    const canopy = new Mesh(buildCanopy(hull), GliderModel.canopyMaterial());
    const thrusters = new Mesh(buildThrusters(hull), this.thrusterMaterial(accent));

    for (const mesh of [body, fins, canopy, thrusters]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }

    // The plume is additive and casts nothing. A flame that throws a shadow
    // reads as a solid object stuck to the back of the craft.
    const flames = new Mesh(buildFlames(hull), this.flameMaterial(accent));
    flames.castShadow = false;
    flames.receiveShadow = false;
    flames.frustumCulled = false;
    flames.renderOrder = 4;
    this.group.add(flames);

    this.group.name = `glider:${team.id}`;
  }

  /** Feeds the per-frame drive state into the material uniforms. */
  setDrive(thrust: number, boost: number, damage: number): void {
    this.thrustUniform.value = clamp01(thrust);
    this.boostUniform.value = clamp01(boost);
    this.damageUniform.value = clamp01(damage);
  }

  get object(): Object3D {
    return this.group;
  }

  dispose(): void {
    this.group.traverse((object) => {
      if (object instanceof Mesh) {
        object.geometry.dispose();
        (object.material as { dispose(): void }).dispose();
      }
    });
  }

  /**
   * The exhaust plume.
   *
   * Additive, depth-tested but not depth-writing, so plumes overlap cleanly and
   * never occlude the craft behind them. Length and brightness are driven by
   * the same speed fraction the livery uses; a craft on the grid has no flame
   * at all, and a craft off a speed pad has one about twice as long as cruise.
   *
   * The colour ramp is plasma rather than campfire: white at the throat, the
   * team's accent through the body of the flame, and a warm tip where it burns
   * out. Everything else on the craft is cold, and the exhaust is the only
   * place the eye is told there is energy involved.
   */
  private flameMaterial(accent: Color): MeshBasicNodeMaterial {
    const material = new MeshBasicNodeMaterial();
    const along = uv().y;
    const drive = this.thrustUniform.mul(0.75).add(this.boostUniform.mul(0.85)).clamp(0, 1.6);

    // Stretch along the plume's own axis. The geometry is built at
    // FLAME_REFERENCE metres, so this is a multiplier, not a length.
    const stretch = drive.mul(1.25).add(0.12);
    material.positionNode = positionLocal.add(
      vec3(0, 0, along.mul(stretch.sub(1)).mul(FLAME_REFERENCE)),
    );

    // Turbulence scrolling out of the nozzle, plus a faster flicker on top.
    const churn = mx_fractal_noise_float(
      vec3(uv().x.mul(6), along.mul(3).sub(time.mul(5.5)), time.mul(0.9)),
      3,
    ).mul(0.5).add(0.5);
    const flicker = sin(time.mul(31).add(along.mul(9))).mul(0.06).add(0.94);

    // Fades out along its length, and the edge of the cone is thinner than its
    // core, which is what keeps it from reading as a painted cardboard shape.
    const taper = smoothstep(float(1), float(0.15), along);
    const throat = smoothstep(float(0.18), float(0), along);

    const body = mix(color(accent), color(0xffb257), smoothstep(float(0.15), float(0.85), along));
    const tint = mix(body, color(0xffffff), throat);

    // Kept well under the bloom threshold's knee. The first version ran hot
    // enough that the plume bloomed into a white disc and stopped reading as a
    // flame at all.
    material.colorNode = tint.mul(flicker).mul(mix(float(0.35), float(0.85), churn));
    material.opacityNode = taper.mul(churn).mul(drive.clamp(0, 1)).mul(0.5);
    material.transparent = true;
    material.depthWrite = false;
    material.blending = AdditiveBlending;
    material.side = DoubleSide;
    material.fog = false;
    return material;
  }

  /**
   * Livery: a pale nose, the team's second colour over the rear two thirds, an
   * accent pinstripe on the join, and a dark underside.
   *
   * The split runs across the hull rather than along it because that is the only
   * one legible from the chase camera, which sees the top and the tail and
   * almost nothing else. `uv().x` walks around the section — the top sits near
   * 0.25, the belly near 0.75 — and `uv().y` runs nose to tail.
   */
  private bodyMaterial(base: Color, block: Color, accent: Color): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    // The fins are thin plates; from a grazing angle a single-sided one
    // disappears entirely.
    material.side = DoubleSide;
    const around = uv().x;
    const along = uv().y;

    const underside = smoothstep(float(0.52), float(0.64), around);
    // Dark over the nose, pale over the tail: the chase camera only ever sees
    // the back of the craft, and a dark tail turns every ship into a silhouette.
    const nose = smoothstep(float(0.46), float(0.38), along);
    const pinstripe = smoothstep(float(0.4), float(0.425), along).mul(smoothstep(float(0.462), float(0.44), along));

    const light = vec3(base.r, base.g, base.b);
    const dark = vec3(block.r, block.g, block.b);
    const upper = mix(light, dark, nose);
    const paint = mix(upper, light.mul(0.3), underside);

    material.colorNode = mix(paint, vec3(accent.r, accent.g, accent.b), pinstripe.mul(oneMinus(underside)));
    // The accent line glows as a heat bloom under boost.
    material.emissiveNode = vec3(accent.r, accent.g, accent.b)
      .mul(pinstripe)
      .mul(oneMinus(underside))
      .mul(this.boostUniform.mul(3).add(0.3));
    material.roughnessNode = mix(float(0.26), float(0.55), underside);
    material.metalnessNode = float(0.28);
    return material;
  }

  /**
   * A mirrored canopy rather than a glass one. Transmission would be more
   * physical, but the interior is empty and the reflection is what actually
   * reads at speed — a dark glass dome with nothing behind it renders as a hole
   * in the ship.
   */
  private static canopyMaterial(): MeshPhysicalNodeMaterial {
    const material = new MeshPhysicalNodeMaterial();
    // An open half-dome: there is no back face to cull, only a missing one.
    material.side = DoubleSide;
    material.colorNode = color(0x7d93a6);
    material.roughnessNode = float(0.05);
    material.metalnessNode = float(1);
    material.iridescence = 0.85;
    material.iridescenceIOR = 1.8;
    material.clearcoat = 1;
    material.clearcoatRoughness = 0.04;
    return material;
  }

  /** Nozzle glow, driven by thrust and blown out by boost. */
  private thrusterMaterial(accent: Color): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    // Open tubes. Culled to one side they were visible from inside the craft
    // and missing from behind it, which is the wrong way round.
    material.side = DoubleSide;
    const depth = uv().y;
    const heat = this.thrustUniform.mul(0.7).add(this.boostUniform.mul(3.4)).add(0.18);
    material.colorNode = mix(color(0x0b0d10), vec3(accent.r, accent.g, accent.b), depth);
    material.emissiveNode = mix(vec3(accent.r, accent.g, accent.b), vec3(1, 1, 1), this.boostUniform.mul(0.6))
      .mul(depth)
      .mul(heat)
      .mul(6);
    material.roughnessNode = float(0.4);
    material.metalnessNode = float(0.6);
    return material;
  }
}
