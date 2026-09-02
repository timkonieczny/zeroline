import { Color, Group, Mesh, PlaneGeometry } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { uniform } from 'three/tsl';
import { TextMesh } from '@/ui/Text';
import type { Craft } from './Craft';

/** Width and height of one bar, in pixels. */
const BAR_WIDTH = 152;
const BAR_HEIGHT = 7;
/** Pixels between the label and its bar, and between one row and the next. */
const LABEL_GAP = 10;
const LABEL_WIDTH = 74;
const ROW_HEIGHT = 21;

/** Below this many seconds left, the bar starts flashing. */
const WARN_SECONDS = 1;
/** Flashes per second while it is warning. */
const WARN_RATE = 5;

/**
 * The three things a craft can be under that run on a clock.
 *
 * Everything else an item does is instant or is a projectile in the air. These
 * are the ones where the useful question is not what you are holding but how
 * much longer it lasts.
 *
 * Boost is not only an item — a speed pad and a good getaway grant it too — and
 * the bar makes no distinction, because from behind the wheel there is none.
 */
const EFFECTS = [
  { key: 'boost', label: 'Boost', tint: 0xffb03c },
  { key: 'invulnerable', label: 'Deflector', tint: 0xb98cff },
  { key: 'autopilot', label: 'Autopilot', tint: 0x5cf09a },
] as const;

interface Row {
  label: TextMesh;
  track: Mesh;
  fill: Mesh;
  /** The longest this effect has had left since it started running. */
  peak: number;
}

/**
 * A draining bar for every timed effect the player is under.
 *
 * The remaining seconds are in the craft's own state; what is not there is what
 * they started at, because nothing in the simulation needs to know. A turbo, a
 * speed pad and a clean getaway all set the same field to different values, and
 * a deflector picked up while one is still running extends it. So the bar takes
 * its full scale from the highest value it has seen since the effect began, and
 * forgets it the moment the effect ends — which is right for every source
 * without the simulation carrying a number for the HUD's benefit.
 */
export class EffectBars {
  readonly group = new Group();

  private readonly rows: Row[] = [];
  private readonly opacity = uniform(1);
  private readonly trackMaterial: MeshBasicNodeMaterial;
  private height = 1;
  /** Seconds since the stage began, for the expiry flash. */
  private clock = 0;

  constructor(pixelRatio: number) {
    this.group.name = 'effect-bars';

    this.trackMaterial = new MeshBasicNodeMaterial();
    this.trackMaterial.colorNode = uniform(new Color(0x0a1015));
    this.trackMaterial.opacityNode = this.opacity.mul(0.8);
    this.trackMaterial.transparent = true;
    this.trackMaterial.depthTest = false;
    this.trackMaterial.depthWrite = false;

    for (const effect of EFFECTS) {
      const label = new TextMesh(
        effect.label,
        { size: 12, tracking: 0.3, align: 'right', shadow: 0.26 },
        pixelRatio,
      );
      label.setColour(effect.tint);

      const track = new Mesh(new PlaneGeometry(BAR_WIDTH, BAR_HEIGHT + 4), this.trackMaterial);
      track.renderOrder = 8;

      const fillMaterial = new MeshBasicNodeMaterial();
      fillMaterial.colorNode = uniform(new Color(effect.tint));
      fillMaterial.opacityNode = this.opacity;
      // Transparent though it is opaque: three empties the opaque draw list
      // first, so an opaque fill behind a transparent track is painted over.
      fillMaterial.transparent = true;
      fillMaterial.depthTest = false;
      fillMaterial.depthWrite = false;

      const fill = new Mesh(new PlaneGeometry(1, BAR_HEIGHT), fillMaterial);
      fill.renderOrder = 9;

      const row: Row = { label, track, fill, peak: 0 };
      this.rows.push(row);
      this.group.add(label, track, fill);
    }
  }

  /**
   * The stack is centred horizontally, so only the height matters: it is what
   * turns a distance from the bottom of the frame into a plane-local one.
   */
  layout(height: number): void {
    this.height = height;
  }

  /**
   * @param baseY Where the bottom row goes, in pixels from the bottom of the
   *   frame. The stack grows upward from there.
   */
  update(craft: Craft, dt: number, baseY: number): void {
    this.clock += dt;

    // Rows pack from the bottom, so a lone deflector does not sit in mid-air
    // with a gap where the boost bar would have been.
    let shown = 0;

    for (let i = 0; i < EFFECTS.length; i++) {
      const row = this.rows[i]!;
      const left = craft.state[EFFECTS[i]!.key];

      if (left <= 0) {
        row.peak = 0;
        row.label.visible = false;
        row.track.visible = false;
        row.fill.visible = false;
        continue;
      }

      row.peak = Math.max(row.peak, left);
      const fraction = Math.min(1, left / row.peak);

      // A flash over the last second, so the end of a deflector is something
      // you feel coming rather than something you notice afterwards.
      const flashing = left < WARN_SECONDS && Math.sin(this.clock * Math.PI * 2 * WARN_RATE) < 0;
      const y = baseY + shown * ROW_HEIGHT - this.height / 2;
      // The row is label, gap, bar, centred as a whole on the frame's middle —
      // which puts the bar itself off to the right of it by half the label.
      const barCentre = (LABEL_WIDTH + LABEL_GAP) / 2;
      const barLeft = barCentre - BAR_WIDTH / 2;

      row.label.position.set(barLeft - LABEL_GAP, y + 5, 0);
      row.track.position.set(barCentre, y, 0);

      const fillWidth = Math.max(1, BAR_WIDTH * fraction);
      row.fill.scale.x = fillWidth;
      row.fill.position.set(barLeft + fillWidth / 2, y, 0);

      row.label.visible = true;
      row.track.visible = true;
      row.fill.visible = !flashing;
      shown++;
    }
  }

  setOpacity(value: number): void {
    this.opacity.value = value;
    for (const row of this.rows) row.label.setOpacity(value);
  }

  dispose(): void {
    this.trackMaterial.dispose();
    for (const row of this.rows) {
      row.label.dispose();
      row.track.geometry.dispose();
      row.fill.geometry.dispose();
      (row.fill.material as { dispose(): void }).dispose();
    }
  }
}
