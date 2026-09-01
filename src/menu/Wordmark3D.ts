import { BoxGeometry, Color, Group, Mesh } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { color, float } from 'three/tsl';

/**
 * One stroke of a letter, in em units.
 *
 * `x`/`y` are the bar's centre, `w`/`h` its size, and `angle` rotates it about
 * that centre. The em box runs 0..GLYPH_WIDTH across and 0..1 up.
 */
interface Bar {
  x: number;
  y: number;
  w: number;
  h: number;
  angle?: number;
}

/** Width of one glyph's em box, as a fraction of the cap height. */
const GLYPH_WIDTH = 0.62;
/** Stroke weight, same fraction. */
const STROKE = 0.13;
/** Space between glyph boxes. */
const TRACKING = 0.3;

const HALF = STROKE / 2;
const RIGHT = GLYPH_WIDTH - HALF;

/**
 * A squared-off geometric alphabet, drawn as bars.
 *
 * Only the eight letters the wordmark needs. Extruding the real typeface would
 * mean shipping a font file to parse, and this game has no binary assets — so
 * the letterforms are numbers like everything else. They are cut to match Geo:
 * one weight, flat terminals, no optical correction anywhere.
 */
const GLYPHS: Record<string, Bar[]> = {
  Z: [
    { x: GLYPH_WIDTH / 2, y: 1 - HALF, w: GLYPH_WIDTH, h: STROKE },
    { x: GLYPH_WIDTH / 2, y: HALF, w: GLYPH_WIDTH, h: STROKE },
    // The diagonal is sized to span corner to corner, so its ends meet the bars.
    { x: GLYPH_WIDTH / 2, y: 0.5, w: Math.hypot(GLYPH_WIDTH, 1 - STROKE * 2) + STROKE, h: STROKE, angle: Math.atan2(1 - STROKE * 2, GLYPH_WIDTH) },
  ],
  E: [
    { x: HALF, y: 0.5, w: STROKE, h: 1 },
    { x: GLYPH_WIDTH / 2, y: 1 - HALF, w: GLYPH_WIDTH, h: STROKE },
    { x: GLYPH_WIDTH / 2 - 0.02, y: 0.5, w: GLYPH_WIDTH - 0.04, h: STROKE },
    { x: GLYPH_WIDTH / 2, y: HALF, w: GLYPH_WIDTH, h: STROKE },
  ],
  R: [
    { x: HALF, y: 0.5, w: STROKE, h: 1 },
    { x: GLYPH_WIDTH / 2, y: 1 - HALF, w: GLYPH_WIDTH, h: STROKE },
    { x: GLYPH_WIDTH / 2, y: 0.54, w: GLYPH_WIDTH, h: STROKE },
    { x: RIGHT, y: 0.77, w: STROKE, h: 0.46 },
    { x: GLYPH_WIDTH * 0.62, y: 0.27, w: 0.62, h: STROKE, angle: -0.95 },
  ],
  O: [
    { x: HALF, y: 0.5, w: STROKE, h: 1 },
    { x: RIGHT, y: 0.5, w: STROKE, h: 1 },
    { x: GLYPH_WIDTH / 2, y: 1 - HALF, w: GLYPH_WIDTH, h: STROKE },
    { x: GLYPH_WIDTH / 2, y: HALF, w: GLYPH_WIDTH, h: STROKE },
  ],
  L: [
    { x: HALF, y: 0.5, w: STROKE, h: 1 },
    { x: GLYPH_WIDTH / 2, y: HALF, w: GLYPH_WIDTH, h: STROKE },
  ],
  I: [{ x: GLYPH_WIDTH / 2, y: 0.5, w: STROKE, h: 1 }],
  N: [
    { x: HALF, y: 0.5, w: STROKE, h: 1 },
    { x: RIGHT, y: 0.5, w: STROKE, h: 1 },
    { x: GLYPH_WIDTH / 2, y: 0.5, w: Math.hypot(GLYPH_WIDTH, 1) - STROKE, h: STROKE, angle: -Math.atan2(1, GLYPH_WIDTH) },
  ],
};

/**
 * The wordmark as extruded letters, for mounting on a wall.
 *
 * Returns a group whose origin is the baseline at the centre of the word, so
 * the caller only has to place it. `split` is the index the colour changes at —
 * four, for ZERO in the accent and LINE in the ink.
 */
export function buildWordmark3D(options: {
  text: string;
  /** Cap height, in metres. */
  height: number;
  /** How far the letters stand off the wall, in metres. */
  depth: number;
  split: number;
  first: number;
  second: number;
}): Group {
  const group = new Group();
  const materials = [material(options.first), material(options.second)];

  const advance = (GLYPH_WIDTH + TRACKING) * options.height;
  const letters = [...options.text];
  const width = letters.length * advance - TRACKING * options.height;
  let pen = -width / 2;

  letters.forEach((letter, index) => {
    const bars = GLYPHS[letter];
    if (bars) {
      const face = materials[index < options.split ? 0 : 1]!;
      for (const bar of bars) {
        const mesh = new Mesh(
          new BoxGeometry(bar.w * options.height, bar.h * options.height, options.depth),
          face,
        );
        mesh.position.set(pen + bar.x * options.height, bar.y * options.height, 0);
        mesh.rotation.z = bar.angle ?? 0;
        mesh.castShadow = true;
        group.add(mesh);
      }
    }
    pen += advance;
  });

  return group;
}

function material(hex: number): MeshStandardNodeMaterial {
  const face = new MeshStandardNodeMaterial();
  face.colorNode = color(new Color(hex));
  // Painted metal: enough sheen to catch the ceiling strips as they cross it,
  // not enough to mirror the room and lose the colour.
  face.roughnessNode = float(0.34);
  face.metalnessNode = float(0.25);
  return face;
}
