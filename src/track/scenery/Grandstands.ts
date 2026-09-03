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
import {
  Fn,
  attribute,
  float,
  mix,
  positionLocal,
  sin,
  smoothstep,
  uniform,
  vec3,
} from 'three/tsl';
import type { BufferGeometry } from 'three';
import { Rng } from '@/core/Rng';
import type { Track } from '../Track';
import type { Footprint } from './Skyline';
import { SEA_LEVEL } from './Environment';
import { WALL_HEIGHT } from '../TrackGeometry';

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
/**
 * Height of the rail in front of the first row, in metres.
 *
 * Low enough that the front row sees over it too. At 2.2 m it was taller than
 * the people behind it were sitting, which is a wall, not a rail.
 */
const BARRIER_HEIGHT = 1.2;

/** Eye height of a seated spectator above their own seat, in metres. */
const SEATED_EYE = 0.85;
/** How much the smallest spectator is scaled down; the worst case for a view. */
const FIGURE_SCALE_LOW = 0.9;
const FIGURE_SCALE_HIGH = 1.06;
/** Metres the front row's sight line clears the track's barrier by. */
const SIGHT_CLEARANCE = 0.65;
/**
 * How high the stand's own floor stands above the road, in metres.
 *
 * Derived, not chosen. The whole structure used to be built off the road
 * plane, which put the front rows below both barriers — a spectator on the
 * first tier had their eye at 1.67 m against a 3.4 m track wall. They could
 * see nothing, and from the cockpit they read as sitting under the circuit.
 *
 * So it comes off the sight line instead: the shortest person in the front row
 * has their eye at `STAND_LIFT + TIER_RISE + SEATED_EYE * FIGURE_SCALE_LOW`,
 * and that has to clear `WALL_HEIGHT` with room to spare. Every row behind is
 * higher again, so clearing the front row clears the house — and if the
 * barrier ever changes height, this follows it.
 */
const STAND_LIFT =
  WALL_HEIGHT + SIGHT_CLEARANCE - TIER_RISE - SEATED_EYE * FIGURE_SCALE_LOW;
/**
 * How much longer than its pitch each swept box is made.
 *
 * The stand is nine straight boxes following a road that climbs and turns, so
 * boxes cut exactly to the pitch meet only at their centrelines and leave a
 * wedge of daylight at every joint — the canopy in particular read as a flight
 * of steps with gaps in it. Overlapping them buries the joint inside the solid.
 */
const SECTION_OVERLAP = 1.1;
/**
 * How much every other section is shrunk, as a fraction.
 *
 * The overlap above is what closes the joints, but on a straight, level run two
 * adjacent sections are the *same box* offset along the road — so the 1.2 m
 * they share has coplanar faces, and the depth buffer cannot choose between
 * them. It showed worst on the apron, which is the one large horizontal slab in
 * the set. Shrinking alternate sections puts one strictly inside the other
 * wherever they meet. Four parts in a thousand: five centimetres on a
 * thirteen-metre box, well inside the overlap and far too little to see.
 */
const SECTION_BIAS = 0.004;
/**
 * How far a canopy panel is turned off the road, in radians.
 *
 * The canopy is a run of separate plates set at slightly different angles
 * rather than one long slab. That look arrived by accident — before the frame's
 * handedness was fixed, every box stood at its own wrong angle — and it is
 * better than the slab that replaced it: a shallow roof over a hundred metres
 * is a single flat rectangle in almost every shot, and turning the plates
 * against each other gives the whole structure an edge to catch the sun on.
 */
const PANEL_SKEW = 0.115;
/** Metres a panel is staggered up or down against its neighbours. */
const PANEL_STAGGER = 0.45;
/** How much longer a canopy panel is than its pitch, so the run never gaps. */
const PANEL_OVERLAP = 1.24;
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
/** Six straights' worth, plus the second one facing the grid. */
const MAX_STANDS = 7;

// --- The crowd -------------------------------------------------------------

/**
 * Figures in the whole circuit's crowd.
 *
 * One instanced draw for the lot of them and no per-frame CPU at all: the
 * cheering is a sine in the vertex shader off a per-figure phase, so a full
 * house costs exactly what an empty one does. The cap is a triangle budget
 * rather than a memory one — forty triangles a head, and a phone has to draw
 * every one of them. It is shared out evenly, so the stands fill from the
 * front rows back and the gods stay empty, which is where a crowd thins first
 * anyway.
 */
const CROWD_CAPACITY = 3000;
/** Metres between seats along a row. */
const SEAT_PITCH = 1.25;
/** Fraction of seats taken. Nobody fills the back rows. */
const OCCUPANCY = 0.74;
/** Rows that get anybody in them — the top two are gangway. */
const OCCUPIED_TIERS = TIERS - 2;

/** Where the visor band sits on a helmet, in local metres. */
const HELMET_VISOR_LOW = 0.7;
const HELMET_VISOR_HIGH = 0.8;
/** How far a figure rises out of its seat at the top of a cheer, in metres. */
const CHEER_LIFT = 0.17;
/** Cheers a second, for the most placid spectator and the most excitable. */
const CHEER_RATE_LOW = 1.1;
const CHEER_RATE_HIGH = 2.3;


const _dummy = new Object3D();
const _basis = new Matrix4();
const _right = new Vector3();
const _up = new Vector3();
/**
 * The road's tangent, negated.
 *
 * A track frame's `right` is `tangent × up`, so `(right, up, tangent)` is
 * *left*-handed and `makeBasis` on it has determinant -1. A quaternion cannot
 * represent a reflection, so `setFromRotationMatrix` silently throws the
 * reflection away and hands back some unrelated rotation — 25 degrees off the
 * road at the grid here, and 92 at half distance. Negating one axis makes it
 * right-handed, which is the same thing `Craft` does with its own `_back`.
 */
const _back = new Vector3();
const _tone = new Color();

/**
 * The stand's values. All of them anodised steel.
 *
 * The canopy is the lightest of the four rather than the darkest: it is the
 * largest flat plane on the structure and the one most often seen against the
 * sky, and near-black there turns the whole grid straight into a silhouette.
 */
const RAKE = 0x343a3f;
const FENCE = 0x525a61;
const FRAME = 0x424951;
const CANOPY = 0x6d777e;

/** A scalar uniform. Named through a call because TSL does not export the type. */
function scalar(value: number) {
  return uniform(value);
}
type Scalar = ReturnType<typeof scalar>;

/** Where a stand stands, for the crowd noise. */
export interface StandSite {
  /** Centre of the rake, out beside the road rather than on it. */
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
  /** Stands on both sides of the road, facing each other. The grid does. */
  facing?: boolean;
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
  private readonly helmets: InstancedMesh;
  private readonly time: Scalar = scalar(0);

  constructor(track: Track) {
    const rng = new Rng(0xc0ffee1);
    // One entry per stand, so the grid's pair is two placements on one run.
    const placements: { midS: number; side: -1 | 1 }[] = [];
    for (const run of Grandstands.findStraights(track)) {
      if (placements.length >= MAX_STANDS) break;
      const midS = (run.from + run.to) * 0.5;
      // Alternating otherwise, so the circuit never looks like it was built
      // along one edge of itself.
      const side: -1 | 1 = placements.length % 2 === 0 ? 1 : -1;
      placements.push({ midS, side });
      if (run.facing && placements.length < MAX_STANDS) {
        placements.push({ midS, side: -side as -1 | 1 });
      }
    }

    const sites: StandSite[] = [];

    this.structure = new InstancedMesh(
      new BoxGeometry(1, 1, 1),
      Grandstands.steel(),
      MAX_STANDS * STAND_SEGMENTS * PARTS_PER_SECTION,
    );
    this.structure.name = 'grandstands';
    this.structure.castShadow = true;
    this.structure.receiveShadow = true;

    this.crowd = new InstancedMesh(
      Grandstands.body(),
      Grandstands.crowdMaterial(this.time, true),
      CROWD_CAPACITY,
    );
    this.crowd.name = 'crowd';
    // Deliberately not a shadow caster. Two and a half thousand figures through
    // the sun's cascade costs far more than a stand full of speckle is worth,
    // and the canopy already puts the whole crowd in shadow anyway.
    this.crowd.castShadow = false;
    this.crowd.receiveShadow = true;

    this.helmets = new InstancedMesh(
      Grandstands.helmet(),
      Grandstands.crowdMaterial(this.time, false),
      CROWD_CAPACITY,
    );
    this.helmets.name = 'crowd-helmets';
    this.helmets.castShadow = false;
    this.helmets.receiveShadow = true;

    // One attribute, shared by both halves of a figure so they cheer together.
    const cheer = new InstancedBufferAttribute(new Float32Array(CROWD_CAPACITY * 2), 2);
    this.crowd.geometry.setAttribute('cheer', cheer);
    this.helmets.geometry.setAttribute('cheer', cheer);

    const footprints: Footprint[] = [];
    let structureCount = 0;
    let crowdCount = 0;
    const colour = new Color();
    const share = Math.floor(CROWD_CAPACITY / Math.max(1, placements.length));

    for (const { midS, side } of placements) {
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

      const at = (midS + track.length) % track.length;
      const middle = track.frameAt(at);
      sites.push({
        position: middle.position
          .clone()
          .addScaledVector(
            middle.right,
            side * (middle.width * 0.5 + STAND_SETBACK + TIER_DEPTH * TIERS * 0.5),
          ),
        s: at,
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
    if (this.structure.instanceColor) this.structure.instanceColor.needsUpdate = true;
    this.crowd.count = crowdCount;
    this.crowd.instanceMatrix.needsUpdate = true;
    if (this.crowd.instanceColor) this.crowd.instanceColor.needsUpdate = true;
    this.helmets.count = crowdCount;
    this.helmets.instanceMatrix.needsUpdate = true;
    cheer.needsUpdate = true;

    this.sites = sites;
    this.footprints = footprints;
    this.group.add(this.structure, this.crowd, this.helmets);
  }

  /** Advances the cheer. The only per-frame work the crowd does. */
  update(dt: number): void {
    this.time.value += dt;
  }

  dispose(): void {
    for (const mesh of [this.structure, this.crowd, this.helmets]) {
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
    // The grid gets a stand on each side. It is the shot the intro camera
    // opens on and the one the classification cuts back to, and a start line
    // with a crowd on one side only reads as half a circuit.
    const runs: Run[] = [
      { from: track.startS - half, to: track.startS + half, facing: true },
    ];

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
    const run = section * SECTION_OVERLAP;
    /** Set per section, so `place` does not need the index threaded into it. */
    let bias = 1;

    /** One box, seated in the road's frame at this station. */
    const place = (
      s: number,
      across: number,
      up: number,
      width: number,
      height: number,
      length: number,
      tone: number,
      skew = 0,
    ): void => {
      const frame = track.frameAt((s + track.length) % track.length);
      _right.copy(frame.right);
      _up.copy(frame.up);
      _back.copy(frame.tangent).negate();
      _basis.makeBasis(_right, _up, _back);
      _dummy.quaternion.setFromRotationMatrix(_basis);
      // About the road's own up, after the basis: a panel turns in plan rather
      // than tipping, so a skewed roof still sheds toward the track.
      if (skew !== 0) _dummy.rotateY(skew);
      _dummy.position
        .copy(frame.position)
        .addScaledVector(frame.right, across)
        .addScaledVector(frame.up, up + STAND_LIFT);
      _dummy.scale.set(width * bias, height * bias, length * bias);
      _dummy.updateMatrix();
      this.structure.setMatrixAt(count, _dummy.matrix);
      this.structure.setColorAt(count, _tone.setHex(tone));
      count++;
    };

    for (let i = 0; i < STAND_SEGMENTS; i++) {
      bias = i % 2 === 0 ? 1 : 1 - SECTION_BIAS;
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
        place(s, side * (front + TIER_DEPTH * (tier + 0.5)), rise * 0.5 - 0.4, TIER_DEPTH, rise + 0.8, run, RAKE);
      }

      // A debris fence along the front, a canopy over the back and the post
      // holding it up. The canopy is what makes a bank of steps a grandstand.
      place(s, side * (front - 0.35), BARRIER_HEIGHT * 0.5, 0.35, BARRIER_HEIGHT, run, FENCE);
      // Alternating, so no two neighbours agree and the run reads as plates.
      const skew = (i % 2 === 0 ? 1 : -1) * PANEL_SKEW * (0.6 + (i % 3) * 0.2);
      place(
        s,
        side * (front + (depth - ROOF_OVERHANG) * 0.5),
        top + ROOF_CLEAR + (i % 2 === 0 ? PANEL_STAGGER : 0),
        depth + ROOF_OVERHANG,
        0.55,
        section * PANEL_OVERLAP,
        CANOPY,
        skew,
      );
      place(s, side * (back - 0.6), top * 0.5 + ROOF_CLEAR * 0.5, 0.6, top + ROOF_CLEAR, 0.6, FRAME);
      place(s, side * back, top * 0.5, 0.9, top + 1.2, run, RAKE);

      // What holds it up. All of this is over open water, and a stand hanging
      // in the air beside a floating road doubles the problem the pillars
      // solve — but a solid pier is a hundred metres of blank concrete wall,
      // which from the circuit's own flyover reads as a cliff. A deck on
      // columns instead: the same answer the road itself gives.
      const drop = frame.position.y - SEA_LEVEL + STAND_LIFT + 6;
      place(s, side * (front + depth * 0.5), -APRON_DEPTH * 0.5, depth, APRON_DEPTH, run, CANOPY);
      for (const at of [front + COLUMN_SIDE, back - COLUMN_SIDE]) {
        place(s, side * at, -drop * 0.5 - APRON_DEPTH, COLUMN_SIDE, drop, COLUMN_SIDE, FRAME);
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
        _back.copy(frame.tangent).negate();
        _basis.makeBasis(_right, _up, _back);
        _dummy.quaternion.setFromRotationMatrix(_basis);
        // Everybody faces the road, give or take a neighbour being talked to.
        _dummy.rotateY(rng.range(-0.35, 0.35));
        _dummy.position
          .copy(frame.position)
          .addScaledVector(frame.right, side * (front + TIER_DEPTH * (tier + 0.75)) + rng.range(-0.12, 0.12))
          // Exactly the top of their own tier box, which is at `rise`. Adding
          // clearance here is what had the whole crowd hovering 40 cm up.
          .addScaledVector(frame.up, STAND_LIFT + TIER_RISE * (tier + 1));
        _dummy.scale.setScalar(rng.range(FIGURE_SCALE_LOW, FIGURE_SCALE_HIGH));
        _dummy.updateMatrix();
        this.crowd.setMatrixAt(count, _dummy.matrix);
        this.helmets.setMatrixAt(count, _dummy.matrix);

        // Phase and rate, so no two neighbours are ever quite in time.
        cheer.setXY(count, rng.range(0, Math.PI * 2), rng.range(CHEER_RATE_LOW, CHEER_RATE_HIGH));

        // A crowd is the one place on this circuit where every colour in the
        // wheel turns up at once, and it is worth having: the city is white,
        // the road is white, and the stands are steel. Saturated, and kept off
        // the very light end so a figure never disappears into its own helmet.
        colour.setHSL(rng.next(), rng.range(0.55, 0.92), rng.range(0.3, 0.56));
        this.crowd.setColorAt(count, colour);

        count++;
      }
    }
    return count;
  }

  // --- Geometry and materials ----------------------------------------------

  /**
   * A spectator's body, and a spectator's helmet.
   *
   * Two meshes rather than one merged geometry, and the split is not about
   * triangles — it is the only way the helmet can keep its own colour. Three's
   * instance colour multiplies the *whole* of a material's `colorNode`, so a
   * figure in a red shirt got a red helmet as well; and moving the clothing
   * into a custom instanced attribute instead left whole stands rendering
   * without it. The body takes the instance colour, the helmet has no instance
   * colour at all, and neither needs an attribute that might not arrive.
   *
   * Both are as coarse as they can be — five sides on the body, an
   * unsubdivided icosahedron for the helmet — because this is forty triangles
   * multiplied by three thousand.
   */
  private static body(): BufferGeometry {
    const body = new CylinderGeometry(0.2, 0.27, 0.62, 5, 1);
    body.translate(0, 0.31, 0);
    return body;
  }

  private static helmet(): BufferGeometry {
    const head = new IcosahedronGeometry(0.145, 0);
    head.translate(0, 0.78, 0);
    return head;
  }

  /**
   * A spectator, cheering in the vertex stage.
   *
   * The animation has to live here rather than on the CPU. Three thousand
   * matrices rewritten every frame would cost more than the rest of the
   * scenery put together — and it would have to be fed the render's delta,
   * which is the one number simulation code must never see. Both halves of a
   * figure read the same `cheer` attribute, so they rise together.
   *
   * @param cloth Clothing, which takes its colour from the instance; otherwise
   *   the helmet, which is metal with a dark visor band across it and is
   *   deliberately given no instance colour to be tinted by.
   */
  private static crowdMaterial(time: Scalar, cloth: boolean): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    const cheer = attribute<'vec2'>('cheer', 'vec2');

    material.positionNode = Fn(() => {
      // Straight up and straight back down, and nothing else. An added sway
      // put every figure on its own little ellipse, and a stand of three
      // thousand people stirring in circles reads as a liquid rather than as a
      // crowd getting to its feet.
      const beat = time.mul(cheer.y).add(cheer.x);
      const local = positionLocal.toVar();
      // Squared, so the rise is quick and the settle slow — which is what a
      // cheer looks like, rather than a bounce.
      const lift = sin(beat).mul(0.5).add(0.5).pow(2).mul(CHEER_LIFT);
      return vec3(local.x, local.y.add(lift), local.z);
    })();

    if (cloth) {
      // White, so the instance colour multiplying through it *is* the shirt.
      material.color = new Color(0xffffff);
      material.roughness = 0.85;
      material.metalness = 0;
      return material;
    }

    material.colorNode = Fn(() => {
      // The visor: a dark band across the middle of the helmet. From the road
      // this is the entire character, and it is two smoothsteps.
      const visor = smoothstep(float(HELMET_VISOR_LOW), float(HELMET_VISOR_LOW + 0.02), positionLocal.y).mul(
        smoothstep(float(HELMET_VISOR_HIGH), float(HELMET_VISOR_HIGH - 0.02), positionLocal.y),
      );
      return mix(vec3(0.78, 0.79, 0.82), vec3(0.03, 0.04, 0.05), visor);
    })();
    material.roughness = 0.22;
    material.metalness = 0.85;
    return material;
  }

  /**
   * The stands: dark anodised steel, against a city that is all pale concrete.
   *
   * Deliberately the one built thing on the circuit that is not white. A stand
   * in the same precast as the skyline behind it has no silhouette at all —
   * which is the mistake the showroom already taught once — and the crowd is
   * the thing that has to read, so it needs a dark ground to sit against.
   * Rough enough to stay matte: a mirror-finish grandstand would fight the
   * craft for the only specular highlights in frame.
   *
   * White here, with every value coming from the per-instance colour. One
   * material and one draw call, and the canopy still reads as a plane in front
   * of the rake instead of merging into one dark mass with it.
   */
  private static steel(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    material.color = new Color(0xffffff);
    material.roughness = 0.42;
    material.metalness = 0.78;
    return material;
  }
}
