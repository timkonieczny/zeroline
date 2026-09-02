import { BoxGeometry, CircleGeometry, Group, Matrix4, Mesh, Vector3, type BufferGeometry } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { attribute, color, float, mix, vec3 } from 'three/tsl';
import { buildRibbon, type ProfilePoint } from '../TrackRibbon';
import type { Track } from '../Track';
import { clamp, wrap } from '@/core/math';

/** Metres of road the gantry stands clear of the barrier on each side. */
const PYLON_CLEARANCE = 2.2;
/** Height of the underside of the cross beam, in metres. */
const BEAM_HEIGHT = 11.4;

/** Light columns, and lamps stacked in each. Five by two, as in Formula 1. */
const COLUMNS = 5;
const LAMPS_PER_COLUMN = 2;
const LAMP_RADIUS = 0.44;
const COLUMN_SPACING = 2.1;
const LAMP_SPACING = 1.2;

/**
 * Fraction of the countdown the full set of lights is held before it goes out.
 *
 * The lights fill over the rest of it, one column at a time. Formula 1 holds
 * for somewhere between a fifth of a second and three seconds, deliberately
 * unpredictable; a race here has to be reproducible, so the hold is fixed and
 * the tension comes from its being the only part of the sequence that is.
 */
const LIGHT_HOLD = 0.2;
/** Seconds the green stays lit after the flag. */
const GREEN_HOLD = 2.4;

/** Metres of grid box, along the road and across it. */
const BOX_HALF_LENGTH = 3.6;
const BOX_HALF_WIDTH = 2.3;
/** Width of a painted stroke, in metres. */
const STROKE = 0.3;
/** Height of the paint above the road surface, in metres. */
const PAINT_LIFT = 0.035;
const NUMERAL_LIFT = 0.05;

/** Metres ahead of its slot a grid number is painted. */
const NUMERAL_AHEAD = 5.7;
const NUMERAL_HEIGHT = 3.4;
const NUMERAL_WIDTH = 2;
const NUMERAL_STROKE = 0.4;

/** Half the width of the bar across the road at the line, in metres. */
const LINE_HALF_LENGTH = 0.9;

/**
 * Boxes painted on the grid.
 *
 * The full field, not however many craft happen to be entered: a circuit's grid
 * is painted once and a time trial runs over the same paint everyone else does.
 */
const GRID_SLOTS = 8;

/**
 * Which of the seven segments each digit lights, as a bit field.
 *
 * Bits run A (top), B (upper right), C (lower right), D (bottom), E (lower
 * left), F (upper left), G (middle) — the order every seven-segment part has
 * used since the 1970s, which is worth keeping even here, where the segments
 * are quads of road paint rather than a display.
 */
const SEGMENT_A = 1;
const SEGMENT_B = 2;
const SEGMENT_C = 4;
const SEGMENT_D = 8;
const SEGMENT_E = 16;
const SEGMENT_F = 32;
const SEGMENT_G = 64;
const DIGITS = [63, 6, 91, 79, 102, 109, 125, 7, 127, 111];

const _origin = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _tangent = new Vector3();
const _basis = new Matrix4();

/**
 * The start of a race, painted on the road and hung over it.
 *
 * Two things that only make sense together: a gantry across the line carrying
 * the lights, and a box on the road for every slot on the grid with its
 * position painted in front of it. Both are generated from the same grid the
 * physics places craft on, so a circuit with a wider road or a different field
 * size gets a start line that fits it without a number being touched.
 *
 * The paint is swept with the road rather than laid out flat and lifted, which
 * matters at the one circuit feature it is most likely to meet: a start line on
 * a crest. Flat quads there sink into the surface at both ends.
 */
export class StartLine {
  readonly group = new Group();

  /** One mesh per lamp, shown as the columns fill. */
  private readonly lamps: Mesh[] = [];
  /** The bar under the lights, lit for a moment once the race is away. */
  private readonly green: Mesh;

  constructor(track: Track) {
    this.group.name = 'start-line';

    // Copied out before anything else samples the spline: `frameAt` hands back
    // one reused frame, and building the paint walks the whole start line.
    const frame = track.frameAt(track.startS);
    _origin.copy(frame.position);
    _right.copy(frame.right);
    _up.copy(frame.up);
    _tangent.copy(frame.tangent);
    const halfWidth = frame.width * 0.5;

    const paint = new Mesh(StartLine.buildPaint(track), StartLine.paintMaterial());
    paint.name = 'grid-paint';
    paint.receiveShadow = true;
    this.group.add(paint);

    const gantry = new Group();
    gantry.position.copy(_origin);
    _basis.makeBasis(_right, _up, _tangent);
    gantry.quaternion.setFromRotationMatrix(_basis);
    this.group.add(gantry);

    const structure = StartLine.structureMaterial();
    const housing = StartLine.housingMaterial();

    const span = (halfWidth + PYLON_CLEARANCE) * 2;
    const beam = new Mesh(new BoxGeometry(span, 1.05, 1.9), structure);
    beam.position.y = BEAM_HEIGHT + 0.52;
    gantry.add(beam);

    for (const side of [-1, 1]) {
      const pylon = new Mesh(new BoxGeometry(1.1, BEAM_HEIGHT + 1.04, 1.7), structure);
      pylon.position.set(side * (halfWidth + PYLON_CLEARANCE), (BEAM_HEIGHT + 1.04) * 0.5, 0);
      gantry.add(pylon);

      // A brace back to the pylon's foot, so the beam does not read as balanced
      // on two posts. Leaned outward, clear of the barrier below it.
      const brace = new Mesh(new BoxGeometry(0.5, 3.4, 0.5), structure);
      brace.position.set(side * (halfWidth + PYLON_CLEARANCE + 0.9), BEAM_HEIGHT - 1.4, 0);
      brace.rotation.z = side * 0.42;
      gantry.add(brace);
    }

    // The blade the lamps are set into, hung under the beam.
    const bladeWidth = COLUMNS * COLUMN_SPACING + 1.1;
    const bladeHeight = LAMPS_PER_COLUMN * LAMP_SPACING + 1;
    const bladeY = BEAM_HEIGHT - bladeHeight * 0.5;
    const blade = new Mesh(new BoxGeometry(bladeWidth, bladeHeight, 0.6), housing);
    blade.position.set(0, bladeY, 0);
    gantry.add(blade);

    // A line of the circuit's own accent along the beam, which is what stops
    // the gantry reading as a footbridge with lamps bolted to it.
    const trim = new Mesh(new BoxGeometry(span * 0.98, 0.16, 0.1), StartLine.trimMaterial(track));
    trim.position.set(0, BEAM_HEIGHT + 0.16, -0.98);
    gantry.add(trim);

    const lampGeometry = new CircleGeometry(LAMP_RADIUS, 24);
    const lit = StartLine.lampMaterial(0xff0705, 2.4);
    const dark = StartLine.lampMaterial(0x1b0705, 0);

    for (let column = 0; column < COLUMNS; column++) {
      const x = (column - (COLUMNS - 1) * 0.5) * COLUMN_SPACING;
      for (let row = 0; row < LAMPS_PER_COLUMN; row++) {
        const y = bladeY + ((LAMPS_PER_COLUMN - 1) * 0.5 - row) * LAMP_SPACING;

        // The unlit face sits behind the lit one and never moves, so a column
        // that has not come on yet is a dark lens rather than a hole.
        const off = new Mesh(lampGeometry, dark);
        off.position.set(x, y, -0.31);
        off.rotation.y = Math.PI;
        gantry.add(off);

        const lamp = new Mesh(lampGeometry, lit);
        lamp.position.set(x, y, -0.33);
        lamp.rotation.y = Math.PI;
        lamp.visible = false;
        gantry.add(lamp);
        this.lamps.push(lamp);
      }
    }

    this.green = new Mesh(
      new BoxGeometry(bladeWidth * 0.84, 0.3, 0.12),
      StartLine.lampMaterial(0x27ff9a, 6),
    );
    this.green.position.set(0, bladeY - bladeHeight * 0.5 - 0.2, -0.34);
    this.green.visible = false;
    gantry.add(this.green);

    gantry.traverse((object) => {
      if (object instanceof Mesh) object.castShadow = true;
    });
  }

  /**
   * @param progress How far the countdown has run, 0 at its start and 1 at the
   *   flag. Passed in rather than derived here so the circuit's furniture does
   *   not need to know how long a countdown is.
   * @param sinceGo Seconds since the flag, or negative while it is still held.
   */
  update(progress: number, sinceGo: number): void {
    const perColumn = (1 - LIGHT_HOLD) / COLUMNS;
    const columns = sinceGo >= 0 ? 0 : clamp(Math.floor(progress / perColumn), 0, COLUMNS);

    for (let i = 0; i < this.lamps.length; i++) {
      this.lamps[i]!.visible = Math.floor(i / LAMPS_PER_COLUMN) < columns;
    }
    this.green.visible = sinceGo >= 0 && sinceGo < GREEN_HOLD;
  }

  dispose(): void {
    const seen = new Set<BufferGeometry | { dispose(): void }>();
    this.group.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      for (const owned of [object.geometry, object.material as { dispose(): void }]) {
        if (seen.has(owned)) continue;
        seen.add(owned);
        owned.dispose();
      }
    });
  }

  // --- Paint ---------------------------------------------------------------

  /**
   * The bar across the line, a box for every grid slot, and the slot's number
   * painted ahead of it.
   *
   * All of it is ribbons swept along the centreline, which is the same
   * machinery the road, the kerbs and the speed pads are built from — so the
   * paint banks and crests with the surface it is painted on, and none of it
   * needs a texture.
   */
  private static buildPaint(track: Track): BufferGeometry {
    const pieces: BufferGeometry[] = [];

    // The line itself, edge to edge, with the accent behind it.
    pieces.push(StartLine.stripe(track, track.startS, LINE_HALF_LENGTH, -Infinity, Infinity, 0));
    pieces.push(
      StartLine.stripe(track, track.startS - LINE_HALF_LENGTH - 0.22, 0.14, -Infinity, Infinity, 1),
    );

    for (let slot = 0; slot < GRID_SLOTS; slot++) {
      const { s, lateral } = track.gridSlot(slot);

      // The box: two rails down the sides, two bars across the ends.
      for (const side of [-1, 1]) {
        const outer = lateral + side * BOX_HALF_WIDTH;
        pieces.push(
          StartLine.stripe(track, s, BOX_HALF_LENGTH, Math.min(outer, outer - side * STROKE), Math.max(outer, outer - side * STROKE), 0),
        );
      }
      for (const end of [-1, 1]) {
        pieces.push(
          StartLine.stripe(
            track,
            s + end * (BOX_HALF_LENGTH - STROKE * 0.5),
            STROKE * 0.5,
            lateral - BOX_HALF_WIDTH,
            lateral + BOX_HALF_WIDTH,
            0,
          ),
        );
      }

      pieces.push(...StartLine.numeral(track, s + NUMERAL_AHEAD, lateral, slot + 1));
    }

    return mergeGeometries(pieces, false)!;
  }

  /**
   * One painted rectangle: `halfLength` metres of road either side of `s`,
   * between two lateral offsets.
   *
   * An infinite offset means the road edge, so the bar across the line stays
   * edge to edge wherever the road happens to be widest.
   */
  private static stripe(
    track: Track,
    s: number,
    halfLength: number,
    from: number,
    to: number,
    accent: number,
  ): BufferGeometry {
    const up = accent > 0 ? NUMERAL_LIFT : PAINT_LIFT;
    const profile: ProfilePoint[] = [
      from === -Infinity
        ? { anchor: 'left', offset: 0, up, u: 0, accent }
        : { anchor: 'centre', offset: from, up, u: 0, accent },
      to === Infinity
        ? { anchor: 'right', offset: 0, up, u: 1, accent }
        : { anchor: 'centre', offset: to, up, u: 1, accent },
    ];

    return buildRibbon(track, {
      profile,
      step: 1.2,
      colourByDistrict: true,
      range: {
        fromS: wrap(s - halfLength, track.length),
        toS: wrap(s + halfLength, track.length),
      },
    });
  }

  /**
   * A grid position, drawn as seven segments.
   *
   * Reads upright to whoever is sitting in the box behind it, which is also the
   * chase camera's view: the digit's own up axis is the direction of travel.
   */
  private static numeral(track: Track, s: number, lateral: number, value: number): BufferGeometry[] {
    const mask = DIGITS[value % 10]!;
    const halfHeight = NUMERAL_HEIGHT * 0.5;
    const halfWidth = NUMERAL_WIDTH * 0.5;
    const pieces: BufferGeometry[] = [];

    /** A segment across the digit: a bar of paint at height `at`. */
    const across = (at: number): BufferGeometry =>
      StartLine.stripe(track, s + at, NUMERAL_STROKE * 0.5, lateral - halfWidth, lateral + halfWidth, 1);

    /** A segment up one side of the digit, from `fromV` to `toV`. */
    const along = (side: number, fromV: number, toV: number): BufferGeometry => {
      const edge = lateral + side * halfWidth;
      const inner = edge - side * NUMERAL_STROKE;
      return StartLine.stripe(
        track,
        s + (fromV + toV) * 0.5,
        (toV - fromV) * 0.5,
        Math.min(edge, inner),
        Math.max(edge, inner),
        1,
      );
    };

    if (mask & SEGMENT_A) pieces.push(across(halfHeight - NUMERAL_STROKE * 0.5));
    if (mask & SEGMENT_D) pieces.push(across(-halfHeight + NUMERAL_STROKE * 0.5));
    if (mask & SEGMENT_G) pieces.push(across(0));
    if (mask & SEGMENT_F) pieces.push(along(-1, NUMERAL_STROKE * 0.5, halfHeight));
    if (mask & SEGMENT_B) pieces.push(along(1, NUMERAL_STROKE * 0.5, halfHeight));
    if (mask & SEGMENT_E) pieces.push(along(-1, -halfHeight, -NUMERAL_STROKE * 0.5));
    if (mask & SEGMENT_C) pieces.push(along(1, -halfHeight, -NUMERAL_STROKE * 0.5));

    return pieces;
  }

  // --- Materials -----------------------------------------------------------

  /**
   * White paint, with the accent channel switching a stripe over to the
   * district's colour and lighting it.
   *
   * The numbers glow and the box does not. A grid box is paint; a position is
   * signage, and on a white circuit under a white sun paint alone would not
   * survive the bloom.
   */
  private static paintMaterial(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    const accent = attribute<'vec4'>('color', 'vec4');

    material.colorNode = mix(vec3(0.95, 0.96, 0.97), accent.xyz.mul(0.35), accent.w);
    material.emissiveNode = accent.xyz.mul(accent.w).mul(1.5);
    material.roughnessNode = mix(float(0.6), float(0.34), accent.w);
    material.metalnessNode = float(0.02);
    material.vertexColors = true;
    return material;
  }

  /** Brushed white metal, the same family as the barriers. */
  private static structureMaterial(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    material.colorNode = vec3(0.86, 0.88, 0.9);
    material.roughnessNode = float(0.34);
    material.metalnessNode = float(0.55);
    return material;
  }

  /** The dark blade the lamps are set into. */
  private static housingMaterial(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    material.colorNode = vec3(0.07, 0.08, 0.09);
    material.roughnessNode = float(0.45);
    material.metalnessNode = float(0.3);
    return material;
  }

  /** The accent strip along the beam, in the colour of the district it stands in. */
  private static trimMaterial(track: Track): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    const accent = color(track.districtAt(track.startS).accent);
    material.colorNode = accent.mul(0.2);
    material.emissiveNode = accent.mul(3);
    return material;
  }

  /**
   * A lamp face.
   *
   * Emissive well past 1, because the bloom threshold is above 1 and a start
   * light that does not bloom is a red circle rather than a light.
   */
  private static lampMaterial(tint: number, glow: number): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    material.colorNode = color(tint).mul(0.25);
    material.emissiveNode = color(tint).mul(glow);
    material.roughnessNode = float(0.3);
    return material;
  }
}
