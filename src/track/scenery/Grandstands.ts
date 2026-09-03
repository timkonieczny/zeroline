import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Object3D,
  Vector3,
} from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  Fn,
  attribute,
  cos,
  float,
  mix,
  positionLocal,
  sin,
  smoothstep,
  step,
  uniform,
  vec3,
} from 'three/tsl';
import type { BufferGeometry } from 'three';
import { Rng } from '@/core/Rng';
import type { Track } from '../Track';
import type { Footprint } from './Skyline';
import { SEA_LEVEL } from './Environment';

// --- The stands ------------------------------------------------------------

/** Metres of road a single stand runs along. */
const STAND_LENGTH = 108;
/** Sections a stand is cut into, so it follows the road instead of cutting it. */
const STAND_SEGMENTS = 9;
/** Gap between the edge of the road and the front row, in metres. */
const STAND_SETBACK = 9;
/** Rows of seating. */
const TIERS = 11;
/** Depth and rise of one row, in metres. A steep continental rake. */
const TIER_DEPTH = 1.15;
const TIER_RISE = 0.82;
/** Height of the debris fence in front of the first row, in metres. */
const BARRIER_HEIGHT = 2.2;
/** Height of the canopy above the back row, in metres. */
const ROOF_CLEAR = 5.4;
/** How far the canopy oversails the front row, in metres. */
const ROOF_OVERHANG = 3.4;
/** Thickness of the deck the seating rests on, in metres. */
const APRON_DEPTH = 1.6;
/** Side of one square column under the stand, in metres. */
const COLUMN_SIDE = 2.4;
/** Boxes each section of a stand is built from: the tiers, plus seven. */
const PARTS_PER_SECTION = TIERS + 7;

/**
 * Straightness a section must hold to carry a stand, in radians per metre.
 *
 * A stand is a rigid run of boxes; put it on a corner and either it cuts the
 * apex or it fans away from the road. This is about a 400 m radius.
 */
const STRAIGHT_ENOUGH = 0.0026;
/** Metres between stands, so they read as separate structures. */
const STAND_GAP = 70;
const MAX_STANDS = 6;

// --- The crowd -------------------------------------------------------------

/**
 * Figures in the whole circuit's crowd.
 *
 * One instanced draw for the lot of them and no per-frame CPU at all: the
 * cheering is a sine in the vertex shader off a per-figure phase, so a full
 * house costs exactly what an empty one does. The cap is a triangle budget
 * rather than a memory one — forty triangles a head, and a phone has to draw
 * every one of them.
 */
const CROWD_CAPACITY = 2600;
/** Metres between seats along a row. */
const SEAT_PITCH = 1.25;
/** Fraction of seats taken. Nobody fills the back rows. */
const OCCUPANCY = 0.74;
/** Rows that get anybody in them — the top two are gangway. */
const OCCUPIED_TIERS = TIERS - 2;

/** Seated height of a figure, in metres. */
const FIGURE_HEIGHT = 0.92;
/** Local height above which a vertex belongs to the helmet, in metres. */
const HELMET_LINE = 0.66;
/** How far a figure rises out of its seat at the top of a cheer, in metres. */
const CHEER_LIFT = 0.115;
/** Cheers a second, for the most placid spectator and the most excitable. */
const CHEER_RATE_LOW = 1.1;
const CHEER_RATE_HIGH = 2.3;
/** How far a figure's head leans sideways, in metres. */
const CHEER_SWAY = 0.055;

const _dummy = new Object3D();
const _basis = new Matrix4();
const _right = new Vector3();
const _up = new Vector3();
const _forward = new Vector3();

/** A scalar uniform. Named through a call because TSL does not export the type. */
function scalar(value: number) {
  return uniform(value);
}
type Scalar = ReturnType<typeof scalar>;

/** Where a stand stands, for the crowd noise. */
export interface StandSite {
  /** Centre of the structure, on the road. */
  position: Vector3;
  /** Arc length of its midpoint, in metres. */
  s: number;
  /** Which side of the road it is on: -1 left, 1 right, facing along `s`. */
  side: -1 | 1;
}

/**
 * Circles along a stand's rake that nothing else may be built in.
 *
 * Several small ones rather than one big one. A stand is a hundred metres long,
 * twenty deep and entirely on one side of the road; a single circle around its
 * midpoint reserves the far side of the circuit as well and costs the skyline
 * thirty buildings for nothing.
 */
const KEEP_OUT_CIRCLES = 6;

interface Run {
  /** Arc length of the first and last metre of the straight. */
  from: number;
  to: number;
}

/**
 * The grandstands, and the people in them.
 *
 * A circuit with nobody watching it reads as a test session, and this is meant
 * to be a league. The stands go on the straights — a stand is a rigid run of
 * boxes and a corner is where that shows — plus one at the grid whether the
 * grid qualifies or not, because that is the one the intro camera opens on.
 *
 * The crowd is deliberately not modelled. Every figure is a tapered cylinder
 * with a sphere on top, and the whole character comes from the helmet: silver,
 * metallic, with a dark band across it. At the distance a stand is ever seen
 * from that is a visored spectator, and it costs no rig, no texture and no
 * file — the same bargain the rest of the game's art makes.
 */
export class Grandstands {
  readonly group = new Group();
  /** Where the stands are, for the crowd noise. */
  readonly sites: readonly StandSite[];
  /** What the skyline has to build around. */
  readonly footprints: readonly Footprint[];

  private readonly structure: InstancedMesh;
  private readonly crowd: InstancedMesh;
  private readonly time: Scalar = scalar(0);

  constructor(track: Track) {
    const rng = new Rng(0xc0ffee1);
    const runs = Grandstands.findStraights(track);
    const sites: StandSite[] = [];

    this.structure = new InstancedMesh(
      new BoxGeometry(1, 1, 1),
      Grandstands.concrete(),
      MAX_STANDS * STAND_SEGMENTS * PARTS_PER_SECTION,
    );
    this.structure.name = 'grandstands';
    this.structure.castShadow = true;
    this.structure.receiveShadow = true;

    this.crowd = new InstancedMesh(
      Grandstands.figure(),
      Grandstands.crowdMaterial(this.time),
      CROWD_CAPACITY,
    );
    this.crowd.name = 'crowd';
    // Deliberately not a shadow caster. Two and a half thousand figures through
    // the sun's cascade costs far more than a stand full of speckle is worth,
    // and the canopy already puts the whole crowd in shadow anyway.
    this.crowd.castShadow = false;
    this.crowd.receiveShadow = true;

    const cheer = new InstancedBufferAttribute(new Float32Array(CROWD_CAPACITY * 2), 2);
    this.crowd.geometry.setAttribute('cheer', cheer);

    const footprints: Footprint[] = [];
    let structureCount = 0;
    let crowdCount = 0;
    const colour = new Color();
    const share = Math.floor(CROWD_CAPACITY / Math.max(1, Math.min(runs.length, MAX_STANDS)));

    for (const run of runs) {
      if (sites.length >= MAX_STANDS) break;

      const midS = (run.from + run.to) * 0.5;
      // Alternating sides, so the circuit never looks like it was built along
      // one edge of itself.
      const side: -1 | 1 = sites.length % 2 === 0 ? 1 : -1;

      structureCount = this.buildStand(track, midS, side, structureCount);
      crowdCount = this.seat(
        track,
        midS,
        side,
        crowdCount,
        Math.min(share, CROWD_CAPACITY - crowdCount),
        rng,
        cheer,
        colour,
      );

      sites.push({
        position: track.frameAt((midS + track.length) % track.length).position.clone(),
        s: (midS + track.length) % track.length,
        side,
      });

      const spacing = STAND_LENGTH / KEEP_OUT_CIRCLES;
      for (let i = 0; i < KEEP_OUT_CIRCLES; i++) {
        const s = midS - STAND_LENGTH * 0.5 + spacing * (i + 0.5);
        const frame = track.frameAt((s + track.length) % track.length);
        const depth = TIER_DEPTH * TIERS;
        footprints.push({
          position: frame.position
            .clone()
            .addScaledVector(frame.right, side * (frame.width * 0.5 + STAND_SETBACK + depth * 0.5)),
          radius: Math.hypot(spacing, depth) * 0.5,
        });
      }
    }

    this.structure.count = structureCount;
    this.structure.instanceMatrix.needsUpdate = true;
    this.crowd.count = crowdCount;
    this.crowd.instanceMatrix.needsUpdate = true;
    if (this.crowd.instanceColor) this.crowd.instanceColor.needsUpdate = true;
    cheer.needsUpdate = true;

    this.sites = sites;
    this.footprints = footprints;
    this.group.add(this.structure, this.crowd);
  }

  /** Advances the cheer. The only per-frame work the crowd does. */
  update(dt: number): void {
    this.time.value += dt;
  }

  dispose(): void {
    for (const mesh of [this.structure, this.crowd]) {
      mesh.geometry.dispose();
      (mesh.material as { dispose(): void }).dispose();
    }
  }

  // --- Placement ------------------------------------------------------------

  /**
   * Runs of road straight enough to carry a stand, the grid's first.
   *
   * The grid is included whether it qualifies or not: it is where the race
   * starts and where the intro camera lingers, and a start line with empty
   * concrete beside it is the one place a crowd is actually expected.
   */
  private static findStraights(track: Track): Run[] {
    const step = 6;
    const half = STAND_LENGTH * 0.5;
    const runs: Run[] = [{ from: track.startS - half, to: track.startS + half }];

    let openedAt = -1;
    const close = (at: number): void => {
      if (openedAt < 0) return;
      const length = at - openedAt;
      if (length >= STAND_LENGTH) {
        const midpoint = openedAt + length * 0.5;
        const clear = runs.every(
          (run) => Math.abs(midpoint - (run.from + run.to) * 0.5) > STAND_LENGTH + STAND_GAP,
        );
        if (clear) runs.push({ from: midpoint - half, to: midpoint + half });
      }
      openedAt = -1;
    };

    for (let s = 0; s + step < track.length; s += step) {
      if (!track.isInTunnel(s) && Grandstands.curvature(track, s, step) < STRAIGHT_ENOUGH) {
        if (openedAt < 0) openedAt = s;
      } else {
        close(s);
      }
    }
    close(track.length);
    return runs;
  }

  /** Radians of heading change per metre, at this point. */
  private static curvature(track: Track, s: number, step: number): number {
    const a = track.frameAt(s).tangent.clone();
    const b = track.frameAt((s + step) % track.length).tangent;
    return Math.acos(Math.min(1, Math.max(-1, a.dot(b)))) / step;
  }

  // --- Building -------------------------------------------------------------

  /** Lays one stand's boxes along the road. Returns the new instance count. */
  private buildStand(track: Track, midS: number, side: number, start: number): number {
    let count = start;
    const section = STAND_LENGTH / STAND_SEGMENTS;

    /** One box, seated in the road's frame at this station. */
    const place = (
      s: number,
      across: number,
      up: number,
      width: number,
      height: number,
      length: number,
    ): void => {
      const frame = track.frameAt((s + track.length) % track.length);
      _right.copy(frame.right);
      _up.copy(frame.up);
      _forward.copy(frame.tangent);
      _basis.makeBasis(_right, _up, _forward);
      _dummy.quaternion.setFromRotationMatrix(_basis);
      _dummy.position
        .copy(frame.position)
        .addScaledVector(frame.right, across)
        .addScaledVector(frame.up, up);
      _dummy.scale.set(width, height, length);
      _dummy.updateMatrix();
      this.structure.setMatrixAt(count, _dummy.matrix);
      count++;
    };

    for (let i = 0; i < STAND_SEGMENTS; i++) {
      const s = midS - STAND_LENGTH * 0.5 + section * (i + 0.5);
      const frame = track.frameAt((s + track.length) % track.length);
      const front = frame.width * 0.5 + STAND_SETBACK;
      const depth = TIER_DEPTH * TIERS;
      const back = front + depth;
      const top = TIER_RISE * TIERS;

      // The rake: each row a step further back and a step higher, and tall
      // enough to be the backrest of the row in front of it.
      for (let tier = 0; tier < TIERS; tier++) {
        const rise = TIER_RISE * (tier + 1);
        place(s, side * (front + TIER_DEPTH * (tier + 0.5)), rise * 0.5 - 0.4, TIER_DEPTH, rise + 0.8, section);
      }

      // A debris fence along the front, a canopy over the back and the post
      // holding it up. The canopy is what makes a bank of steps a grandstand.
      place(s, side * (front - 0.35), BARRIER_HEIGHT * 0.5, 0.35, BARRIER_HEIGHT, section);
      place(s, side * (front + (depth - ROOF_OVERHANG) * 0.5), top + ROOF_CLEAR, depth + ROOF_OVERHANG, 0.55, section);
      place(s, side * (back - 0.6), top * 0.5 + ROOF_CLEAR * 0.5, 0.6, top + ROOF_CLEAR, 0.6);
      place(s, side * back, top * 0.5, 0.9, top + 1.2, section);

      // What holds it up. All of this is over open water, and a stand hanging
      // in the air beside a floating road doubles the problem the pillars
      // solve — but a solid pier is a hundred metres of blank concrete wall,
      // which from the circuit's own flyover reads as a cliff. A deck on
      // columns instead: the same answer the road itself gives.
      const drop = frame.position.y - SEA_LEVEL + 6;
      place(s, side * (front + depth * 0.5), -APRON_DEPTH * 0.5, depth, APRON_DEPTH, section);
      for (const at of [front + COLUMN_SIDE, back - COLUMN_SIDE]) {
        place(s, side * at, -drop * 0.5 - APRON_DEPTH, COLUMN_SIDE, drop, COLUMN_SIDE);
      }
    }

    return count;
  }

  /** Fills one stand's rows. Returns the new figure count. */
  private seat(
    track: Track,
    midS: number,
    side: number,
    start: number,
    budget: number,
    rng: Rng,
    cheer: InstancedBufferAttribute,
    colour: Color,
  ): number {
    let count = start;
    const limit = start + budget;
    const seats = Math.floor(STAND_LENGTH / SEAT_PITCH);

    for (let tier = 0; tier < OCCUPIED_TIERS && count < limit; tier++) {
      for (let seat = 0; seat < seats && count < limit; seat++) {
        if (rng.next() > OCCUPANCY) continue;

        const s = midS - STAND_LENGTH * 0.5 + SEAT_PITCH * (seat + 0.5);
        const frame = track.frameAt((s + track.length) % track.length);
        const front = frame.width * 0.5 + STAND_SETBACK;

        _right.copy(frame.right);
        _up.copy(frame.up);
        _forward.copy(frame.tangent);
        _basis.makeBasis(_right, _up, _forward);
        _dummy.quaternion.setFromRotationMatrix(_basis);
        // Everybody faces the road, give or take a neighbour being talked to.
        _dummy.rotateY(rng.range(-0.35, 0.35));
        _dummy.position
          .copy(frame.position)
          .addScaledVector(frame.right, side * (front + TIER_DEPTH * (tier + 0.75)) + rng.range(-0.12, 0.12))
          .addScaledVector(frame.up, TIER_RISE * (tier + 1) + 0.4);
        _dummy.scale.setScalar(rng.range(0.9, 1.06));
        _dummy.updateMatrix();
        this.crowd.setMatrixAt(count, _dummy.matrix);

        // Phase and rate, so no two neighbours are ever quite in time.
        cheer.setXY(count, rng.range(0, Math.PI * 2), rng.range(CHEER_RATE_LOW, CHEER_RATE_HIGH));

        // Clothing: muted, and kept off the circuit's accent hues. A stand of
        // orange shirts reads as a row of boost pads.
        colour.setHSL(rng.range(0.52, 0.68), rng.range(0.05, 0.3), rng.range(0.12, 0.46));
        this.crowd.setColorAt(count, colour);

        count++;
      }
    }
    return count;
  }

  // --- Geometry and materials ----------------------------------------------

  /**
   * One seated figure: a tapered body with a helmet on it.
   *
   * Merged into a single geometry rather than left as two meshes, so the crowd
   * is one draw call and one instance table. Both halves are as coarse as they
   * can be — five sides on the body, an unsubdivided icosahedron for the
   * helmet — because this is forty triangles multiplied by two and a half
   * thousand.
   */
  private static figure(): BufferGeometry {
    const body = new CylinderGeometry(0.2, 0.27, 0.62, 5, 1).toNonIndexed();
    body.translate(0, 0.31, 0);
    // Already non-indexed, which is why the body is flattened to match:
    // `mergeGeometries` refuses a mixed pair and returns null rather than throw.
    const head = new IcosahedronGeometry(0.145, 0);
    head.translate(0, 0.78, 0);
    const merged = mergeGeometries([body, head], false);
    head.dispose();
    if (!merged) return body;
    body.dispose();
    return merged;
  }

  /**
   * The crowd's material: cheering in the vertex stage, a visor in the fragment.
   *
   * The animation has to live here rather than on the CPU. Two and a half
   * thousand matrices rewritten every frame would cost more than the rest of
   * the scenery put together — and it would have to be fed the render's delta,
   * which is the one number simulation code must never see.
   */
  private static crowdMaterial(time: Scalar): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    const cheer = attribute<'vec2'>('cheer', 'vec2');
    const helmet = step(float(HELMET_LINE), positionLocal.y);

    material.positionNode = Fn(() => {
      const beat = time.mul(cheer.y).add(cheer.x);
      const local = positionLocal.toVar();
      // Out of the seat and back into it. Squared so the rise is quick and the
      // settle slow, which is what a cheer looks like rather than a bounce.
      const lift = sin(beat).mul(0.5).add(0.5).pow(2).mul(CHEER_LIFT);
      // The sway leans the figure rather than sliding it, so helmets travel
      // further than knees do and the stand reads as a crowd instead of a grid.
      const lean = cos(beat.mul(0.5)).mul(CHEER_SWAY).mul(local.y.div(FIGURE_HEIGHT));
      return vec3(local.x.add(lean), local.y.add(lift), local.z);
    })();

    material.colorNode = Fn(() => {
      // The visor: a dark band across the middle of the helmet. From the road
      // this is the entire character, and it is two smoothsteps.
      const visor = smoothstep(float(0.7), float(0.72), positionLocal.y).mul(
        smoothstep(float(0.8), float(0.78), positionLocal.y),
      );
      const shell = mix(vec3(0.78, 0.79, 0.82), vec3(0.03, 0.04, 0.05), visor);
      // White below the helmet line, so the per-instance clothing colour is
      // what shows through there and the helmet ignores it.
      return mix(vec3(1, 1, 1), shell, helmet);
    })();

    // Chrome above the shoulders, cloth below them.
    material.roughnessNode = mix(float(0.85), float(0.22), helmet);
    material.metalnessNode = helmet.mul(0.85);
    return material;
  }

  /** The stands themselves: pale precast, like everything else in this city. */
  private static concrete(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    material.color = new Color(0xd6d9dc);
    material.roughness = 0.83;
    material.metalness = 0;
    return material;
  }
}
