import { BoxGeometry, CircleGeometry, Group, Matrix4, Mesh, Vector3, type BufferGeometry } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { color, float, vec3 } from 'three/tsl';
import { buildWordmark3D } from '@/ui/Wordmark3D';
import { paintMaterial, paintText, stripe } from './RoadPaint';
import type { Track } from '../Track';
import { clamp } from '@/core/math';
import { BEAM_HEIGHT } from '../TrackGeometry';

/** Metres of road the gantry stands clear of the barrier on each side. */
const PYLON_CLEARANCE = 2.2;
/** Height of the underside of the cross beam, in metres. */

/** Height and depth of the sign board carried above the beam, in metres. */
const BOARD_HEIGHT = 4.2;
const BOARD_DEPTH = 0.7;
/** Metres of air between the beam and the board it carries. */
const BOARD_GAP = 0.6;

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

/** Metres ahead of its slot a grid number is painted, and how it is cut. */
const NUMERAL_AHEAD = 5.7;
const NUMERAL = { height: 3.4, width: 2, stroke: 0.4 };

/** Half the width of the bar across the road at the line, in metres. */
const LINE_HALF_LENGTH = 0.9;

/**
 * Boxes painted on the grid.
 *
 * The full field, not however many craft happen to be entered: a circuit's grid
 * is painted once and a time trial runs over the same paint everyone else does.
 */
const GRID_SLOTS = 8;

const _origin = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _tangent = new Vector3();
const _basis = new Matrix4();

/**
 * The start of a race, painted on the road and hung over it.
 *
 * Three things that only make sense together: a gantry across the line carrying
 * the lights and the circuit's name, a box on the road for every slot on the
 * grid with its position painted in front of it, and the line itself. All of it
 * is generated from the same grid the physics places craft on, so a circuit
 * with a wider road or a different name gets a start line that fits it without
 * a number being touched.
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

    const paint = new Mesh(StartLine.buildPaint(track), paintMaterial());
    paint.name = 'grid-paint';
    paint.receiveShadow = true;
    this.group.add(paint);

    const gantry = new Group();
    gantry.position.copy(_origin);
    // `right` negated, not the tangent, and the choice matters.
    //
    // A track frame's `right` is `tangent × up`, so `(right, up, tangent)` is
    // left-handed: `makeBasis` on it is a reflection, a quaternion cannot hold
    // one, and `setFromRotationMatrix` quietly returns an unrelated rotation —
    // this gantry stood 25 degrees off the road. Either axis can be negated to
    // make it proper, but everything hung on this frame faces local -Z (the
    // trim, both lamp faces, the sign), so local +Z has to stay the direction
    // of travel. Negating the tangent instead turns the whole gantry around
    // and shows the field the back of the board.
    _basis.makeBasis(_right.clone().negate(), _up, _tangent);
    gantry.quaternion.setFromRotationMatrix(_basis);
    this.group.add(gantry);

    const structure = StartLine.structureMaterial();
    const housing = StartLine.housingMaterial();

    const span = (halfWidth + PYLON_CLEARANCE) * 2;
    const beam = new Mesh(new BoxGeometry(span, 1.05, 1.9), structure);
    beam.position.y = BEAM_HEIGHT + 0.52;
    gantry.add(beam);

    // Everything above the beam is the sign, so the pylons carry on to the top
    // of the board rather than stopping at the lights.
    const boardBase = BEAM_HEIGHT + 1.05 + BOARD_GAP;
    const pylonHeight = boardBase + BOARD_HEIGHT;

    for (const side of [-1, 1]) {
      const pylon = new Mesh(new BoxGeometry(1.1, pylonHeight, 1.7), structure);
      pylon.position.set(side * (halfWidth + PYLON_CLEARANCE), pylonHeight * 0.5, 0);
      gantry.add(pylon);

      // A brace back to the pylon's foot, so the beam does not read as balanced
      // on two posts. Leaned outward, clear of the barrier below it.
      const brace = new Mesh(new BoxGeometry(0.5, 3.4, 0.5), structure);
      brace.position.set(side * (halfWidth + PYLON_CLEARANCE + 0.9), BEAM_HEIGHT - 1.4, 0);
      brace.rotation.z = side * 0.42;
      gantry.add(brace);
    }

    StartLine.buildSign(track, gantry, span, boardBase, housing);

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

  // --- The sign ------------------------------------------------------------

  /**
   * The board above the beam, and the circuit's name standing off it.
   *
   * The same extruded bar alphabet as the wordmark on the hangar wall, for the
   * same reason: there is no font file here to extrude, and a sign meant to be
   * read at three hundred metres wants simple letterforms anyway.
   *
   * Mounted on the board's rear face and turned to look back down the road, so
   * it faces the grid. A welcome nobody arriving can read is a decoration.
   */
  private static buildSign(
    track: Track,
    gantry: Group,
    span: number,
    base: number,
    housing: MeshStandardNodeMaterial,
  ): void {
    const width = span * 0.9;
    const board = new Mesh(new BoxGeometry(width, BOARD_HEIGHT, BOARD_DEPTH), housing);
    board.position.set(0, base + BOARD_HEIGHT * 0.5, 0);
    gantry.add(board);

    const accent = track.districtAt(track.startS).accent;
    const name = track.definition.name.toUpperCase();

    // Sized so a longer circuit name still clears the board's ends: the
    // alphabet advances by 0.92 of the cap height per character.
    const nameHeight = Math.min(1.9, (width * 0.86) / (Math.max(name.length, 1) * 0.92));

    const lines = [
      { text: 'WELCOME TO', height: nameHeight * 0.46, y: base + BOARD_HEIGHT * 0.66, tint: 0xdbe3ea },
      { text: name, height: nameHeight, y: base + BOARD_HEIGHT * 0.17, tint: accent },
    ];

    for (const line of lines) {
      const letters = buildWordmark3D({
        text: line.text,
        height: line.height,
        depth: 0.26,
        split: line.text.length,
        first: line.tint,
        second: line.tint,
      });
      letters.position.set(0, line.y, -(BOARD_DEPTH * 0.5 + 0.13));
      letters.rotation.y = Math.PI;
      gantry.add(letters);
    }
  }

  // --- Paint ---------------------------------------------------------------

  /**
   * The bar across the line, a box for every grid slot, and the slot's number
   * painted ahead of it.
   */
  private static buildPaint(track: Track): BufferGeometry {
    const pieces: BufferGeometry[] = [];

    // The line itself, edge to edge, with the accent behind it.
    pieces.push(stripe(track, track.startS, LINE_HALF_LENGTH, -Infinity, Infinity, 0));
    pieces.push(stripe(track, track.startS - LINE_HALF_LENGTH - 0.22, 0.14, -Infinity, Infinity, 1));

    for (let slot = 0; slot < GRID_SLOTS; slot++) {
      const { s, lateral } = track.gridSlot(slot);

      // The box: two rails down the sides, two bars across the ends.
      for (const side of [-1, 1]) {
        const outer = lateral + side * BOX_HALF_WIDTH;
        const inner = outer - side * STROKE;
        pieces.push(
          stripe(track, s, BOX_HALF_LENGTH, Math.min(outer, inner), Math.max(outer, inner), 0),
        );
      }
      for (const end of [-1, 1]) {
        pieces.push(
          stripe(
            track,
            s + end * (BOX_HALF_LENGTH - STROKE * 0.5),
            STROKE * 0.5,
            lateral - BOX_HALF_WIDTH,
            lateral + BOX_HALF_WIDTH,
            0,
          ),
        );
      }

      pieces.push(...paintText(track, s + NUMERAL_AHEAD, lateral, String(slot + 1), NUMERAL));
    }

    return mergeGeometries(pieces, false)!;
  }

  // --- Materials -----------------------------------------------------------

  /** Brushed white metal, the same family as the barriers. */
  private static structureMaterial(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    material.colorNode = vec3(0.86, 0.88, 0.9);
    material.roughnessNode = float(0.34);
    material.metalnessNode = float(0.55);
    return material;
  }

  /** The dark blade the lamps are set into, and the board above the beam. */
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
