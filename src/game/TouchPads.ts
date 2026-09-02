import { CircleGeometry, Color, Group, Mesh, PlaneGeometry, RingGeometry } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { uniform } from 'three/tsl';
import { TextMesh } from '@/ui/Text';
import { DARK_UI } from '@/ui/Palette';
import type { SafeAreaInsets } from '@/core/Platform';
import type { TouchControlId, TouchRegion } from '@/core/Touch';

/**
 * Radius of an airbrake pad, in pixels.
 *
 * Bigger than the buttons: a thumb on a pad is also bracing the phone, and it
 * lands where the corner is rather than where the circle is.
 */
const PAD_RADIUS = 58;
/** Radius of a tapped button. Ninety-two across, well past the 44 px minimum. */
const BUTTON_RADIUS = 46;
/** Half-extent of the pause glyph's box, in pixels. */
const PAUSE_HALF = 24;
/** Gap between a control and the edge of the safe area, in pixels. */
const CONTROL_GAP = 16;
/**
 * Pixels of the screen edge that look like a pad but do not brake.
 *
 * The bottom corners are where iOS keeps its back-swipe and its home
 * indicator. A thumb parked in the very corner is sitting on a system gesture,
 * and the browser will take it and hand back a `pointercancel`. The pad is
 * drawn into the corner and stops being live before it gets there.
 */
const EDGE_GUARD = 20;

/**
 * How far into the frame each corner's controls reach, in pixels.
 *
 * Exported so the HUD can lay its readouts out clear of them from the same
 * numbers. A speed readout under the airbrake is a readout you cannot see and a
 * pad you press by accident.
 */
export const PAD_REACH = PAD_RADIUS * 2 + CONTROL_GAP;
export const BUTTON_REACH = BUTTON_RADIUS * 2 + CONTROL_GAP;

/** How much of the frame a held control brightens by. */
const REST_ALPHA = 0.22;
const HELD_ALPHA = 0.5;

/** A scalar uniform. Named through a call because TSL does not export the type. */
function scalar(value: number) {
  return uniform(value);
}
type Scalar = ReturnType<typeof scalar>;

interface Pad {
  id: TouchControlId;
  group: Group;
  alpha: Scalar;
  /** Hit rectangle in CSS pixels, origin top left. Rebuilt by `layout`. */
  region: TouchRegion;
}

/**
 * The controls a phone drives a race with.
 *
 * Drawn in the HUD's own scene rather than as DOM, so they are the same
 * interface as everything beside them — the same palette, the same halo, the
 * same overlay pass after tone mapping — instead of a set of CSS boxes sitting
 * on top of one. Hit-testing is the cost, and it is a rectangle test in a
 * camera already measured in pixels.
 *
 * **They attach to the HUD's scene, not to its `root` or its `plane`.** Three
 * separate things would break otherwise: `root` fades out with `raceChrome`
 * when the classification arrives, and a pause button that fades is a menu you
 * cannot leave; `plane` grows by a quarter with speed, so a button's picture
 * and its hit box would part company; and `plane` also slides up to 34 px
 * against the direction of travel, which would walk a control out from under a
 * thumb already holding it. This is the same reason the pause panel and the
 * finishing placard are already on the scene.
 */
export class TouchPads {
  readonly group = new Group();

  private readonly pads: Pad[] = [];
  private readonly regionList: TouchRegion[] = [];
  private height = 1;

  constructor(pixelRatio: number) {
    this.group.name = 'touch-pads';
    this.group.renderOrder = 20;

    this.pads.push(this.buildDisc('brakeLeft', PAD_RADIUS, 'Brake', pixelRatio));
    this.pads.push(this.buildDisc('brakeRight', PAD_RADIUS, 'Brake', pixelRatio));
    this.pads.push(this.buildDisc('absorb', BUTTON_RADIUS, 'Absorb', pixelRatio));
    this.pads.push(this.buildDisc('fire', BUTTON_RADIUS, 'Fire', pixelRatio));
    this.pads.push(this.buildPause());

    for (const pad of this.pads) {
      this.group.add(pad.group);
      this.regionList.push(pad.region);
    }
  }

  /** The hit rectangles, in CSS pixels from the top left. */
  get regions(): readonly TouchRegion[] {
    return this.regionList;
  }

  setPressed(id: TouchControlId, pressed: boolean): void {
    for (const pad of this.pads) {
      if (pad.id === id) pad.alpha.value = pressed ? HELD_ALPHA : REST_ALPHA;
    }
  }

  /**
   * Places every control, and derives its hit rectangle from the same numbers.
   *
   * One pass for the picture and the region together, because the day they are
   * computed twice is the day a button stops being where it looks.
   */
  layout(width: number, height: number, insets: SafeAreaInsets): void {
    this.height = height;

    const left = insets.left + CONTROL_GAP;
    const right = width - insets.right - CONTROL_GAP;
    const bottom = insets.bottom + CONTROL_GAP;
    const top = height - insets.top - CONTROL_GAP;

    this.place('brakeLeft', left + PAD_RADIUS, bottom + PAD_RADIUS, PAD_RADIUS);
    this.place('brakeRight', right - PAD_RADIUS, bottom + PAD_RADIUS, PAD_RADIUS);
    this.place('absorb', left + BUTTON_RADIUS, top - BUTTON_RADIUS, BUTTON_RADIUS);
    this.place('fire', right - BUTTON_RADIUS, top - BUTTON_RADIUS, BUTTON_RADIUS);
    this.place('pause', width / 2, top - PAUSE_HALF, PAUSE_HALF);

    // The pads' live area is the corner they sit in, not the circle drawn in
    // it: a thumb arrives at the corner. It stops short of the screen edge,
    // where the system's own gestures live.
    this.widen('brakeLeft', {
      x: insets.left + EDGE_GUARD,
      y: height - (bottom + PAD_RADIUS * 2.2),
      width: PAD_RADIUS * 2.4,
      height: PAD_RADIUS * 2.2 - EDGE_GUARD,
    });
    this.widen('brakeRight', {
      x: width - insets.right - EDGE_GUARD - PAD_RADIUS * 2.4,
      y: height - (bottom + PAD_RADIUS * 2.2),
      width: PAD_RADIUS * 2.4,
      height: PAD_RADIUS * 2.2 - EDGE_GUARD,
    });
  }

  /** Fades the whole set, so it is absent under the classification and the intro. */
  setOpacity(value: number): void {
    this.group.visible = value > 0.02;
  }

  dispose(): void {
    this.group.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      object.geometry.dispose();
      (object.material as { dispose(): void }).dispose();
    });
  }

  // --- Building -----------------------------------------------------------

  private buildDisc(
    id: TouchControlId,
    radius: number,
    label: string,
    pixelRatio: number,
  ): Pad {
    const group = new Group();
    const alpha = scalar(REST_ALPHA);

    const fill = new Mesh(new CircleGeometry(radius, 40), TouchPads.wash(0x05090b, alpha));
    fill.renderOrder = 20;
    const rim = new Mesh(
      new RingGeometry(radius - 1.6, radius, 40),
      TouchPads.wash(DARK_UI.dim, alpha),
    );
    rim.renderOrder = 21;

    const text = new TextMesh(
      label,
      { size: 11, tracking: 0.3, align: 'centre', shadow: 0.26 },
      pixelRatio,
    );
    text.setColour(DARK_UI.dim);
    text.renderOrder = 22;

    group.add(fill, rim, text);
    return { id, group, alpha, region: { id, x: 0, y: 0, width: 0, height: 0 } };
  }

  /** Two bars: the one glyph everybody reads without a label. */
  private buildPause(): Pad {
    const group = new Group();
    const alpha = scalar(REST_ALPHA);
    const material = TouchPads.wash(DARK_UI.dim, alpha);

    for (const side of [-1, 1]) {
      const bar = new Mesh(new PlaneGeometry(7, 26), material);
      bar.position.x = side * 7;
      bar.renderOrder = 21;
      group.add(bar);
    }

    return {
      id: 'pause',
      group,
      alpha,
      region: { id: 'pause', x: 0, y: 0, width: 0, height: 0 },
    };
  }

  private place(id: TouchControlId, x: number, y: number, radius: number): void {
    const pad = this.pads.find((candidate) => candidate.id === id);
    if (!pad) return;

    pad.group.position.set(x, y, 0);
    // The label sits under the glyph rather than across it.
    const text = pad.group.children.find((child) => child instanceof TextMesh);
    if (text) text.position.set(0, -radius - 13, 0);

    // Screen pixels run down; the overlay's run up.
    pad.region.x = x - radius;
    pad.region.y = this.height - y - radius;
    pad.region.width = radius * 2;
    pad.region.height = radius * 2;
  }

  private widen(id: TouchControlId, box: { x: number; y: number; width: number; height: number }): void {
    const pad = this.pads.find((candidate) => candidate.id === id);
    if (!pad) return;
    pad.region.x = box.x;
    pad.region.y = box.y;
    pad.region.width = box.width;
    pad.region.height = box.height;
  }

  /** A flat wash with an opacity somebody else drives. */
  private static wash(hex: number, alpha: Scalar): MeshBasicNodeMaterial {
    const material = new MeshBasicNodeMaterial();
    material.colorNode = uniform(new Color(hex));
    material.opacityNode = alpha;
    material.transparent = true;
    material.depthTest = false;
    material.depthWrite = false;
    return material;
  }
}
