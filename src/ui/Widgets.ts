import { Group, Mesh, PlaneGeometry } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { color, uniform } from 'three/tsl';
import { TextMesh, panelMaterial } from './Text';
import { clamp, lerp } from '@/core/math';

const INK = 0xf2f6fa;
const DIM = 0x76828e;
const ACCENT = 0x24d4ff;

export interface ListItem {
  /** Line shown in the list. */
  label: string;
  /** Optional right-hand annotation, e.g. a lap record or a class name. */
  detail?: string;
  /** Greyed out and unselectable. */
  locked?: boolean;
}

/**
 * A vertical list with an animated selection.
 *
 * The highlight bar slides rather than jumping, unselected rows sit dimmed and
 * slightly inset, and the selected row pushes right. That motion is doing real
 * work: at a glance it tells you which way the cursor just moved, which matters
 * when the only input is a d-pad.
 */
export class ListMenu extends Group {
  private readonly rows: { group: Group; label: TextMesh; detail: TextMesh | null; locked: boolean }[] = [];
  private readonly highlight: Mesh;
  private readonly rule: Mesh;

  /** Currently selected row. */
  index = 0;
  /** Eased position of the highlight, in rows. */
  private shownIndex = 0;

  readonly rowHeight: number;
  readonly width: number;

  constructor(items: readonly ListItem[], options: { width?: number; rowHeight?: number; pixelRatio?: number } = {}) {
    super();
    this.width = options.width ?? 460;
    this.rowHeight = options.rowHeight ?? 52;
    const pixelRatio = options.pixelRatio ?? 2;

    this.highlight = new Mesh(new PlaneGeometry(this.width, this.rowHeight - 8), panelMaterial(ACCENT, 0.13));
    this.highlight.renderOrder = 1;
    this.add(this.highlight);

    this.rule = new Mesh(new PlaneGeometry(3, this.rowHeight - 14), panelMaterial(ACCENT, 1));
    this.rule.renderOrder = 2;
    this.add(this.rule);

    items.forEach((item, i) => {
      const group = new Group();
      group.position.y = -i * this.rowHeight;

      const label = new TextMesh(item.label, { size: 22, weight: 300, tracking: 0.26, align: 'left' }, pixelRatio);
      label.position.set(24, 0, 0);
      group.add(label);

      let detail: TextMesh | null = null;
      if (item.detail) {
        detail = new TextMesh(item.detail, { size: 13, weight: 500, tracking: 0.3, align: 'right' }, pixelRatio);
        detail.position.set(this.width - 20, 0, 0);
        detail.setColour(DIM);
        group.add(detail);
      }

      this.rows.push({ group, label, detail, locked: item.locked ?? false });
      this.add(group);
    });

    this.applySelection(0);
  }

  get length(): number {
    return this.rows.length;
  }

  /** Moves the cursor by `delta`, skipping locked rows and wrapping. */
  move(delta: number): boolean {
    if (this.rows.length === 0) return false;
    let next = this.index;
    for (let attempt = 0; attempt < this.rows.length; attempt++) {
      next = (next + delta + this.rows.length) % this.rows.length;
      if (!this.rows[next]!.locked) {
        const changed = next !== this.index;
        this.index = next;
        return changed;
      }
    }
    return false;
  }

  select(index: number): void {
    if (index >= 0 && index < this.rows.length && !this.rows[index]!.locked) this.index = index;
  }

  get selectedLocked(): boolean {
    return this.rows[this.index]?.locked ?? true;
  }

  private applySelection(shown: number): void {
    this.highlight.position.y = -shown * this.rowHeight;
    this.highlight.position.x = this.width / 2;
    this.rule.position.set(1.5, -shown * this.rowHeight, 0);

    this.rows.forEach((row, i) => {
      const nearness = clamp(1 - Math.abs(i - shown), 0, 1);
      row.group.position.x = lerp(0, 14, nearness);
      const selected = i === this.index;
      row.label.setColour(row.locked ? 0x49525b : selected ? INK : DIM, 1);
      row.label.setOpacity(row.locked ? 0.5 : lerp(0.72, 1, nearness));
      row.detail?.setOpacity(lerp(0.55, 1, nearness));
    });
  }

  update(dt: number): void {
    this.shownIndex = lerp(this.shownIndex, this.index, 1 - Math.exp(-dt * 16));
    this.applySelection(this.shownIndex);
  }

  dispose(): void {
    for (const row of this.rows) {
      row.label.dispose();
      row.detail?.dispose();
    }
    this.highlight.geometry.dispose();
    this.rule.geometry.dispose();
  }
}

/**
 * A five-segment rating meter.
 *
 * Segments rather than a continuous bar because the numbers are ratings, not
 * measurements — and because five blocks is instantly comparable across a list
 * of constructors in a way that five bar lengths is not.
 */
export class StatBar extends Group {
  private readonly segments: { mesh: Mesh; opacity: ReturnType<typeof uniform> }[] = [];
  private readonly label: TextMesh;
  /** Eased fill, so switching craft animates the meters rather than cutting. */
  private shown = 0;
  private target = 0;

  constructor(name: string, options: { segments?: number; width?: number; pixelRatio?: number } = {}) {
    super();
    const count = options.segments ?? 5;
    const width = options.width ?? 150;
    const gap = 4;
    const segmentWidth = (width - gap * (count - 1)) / count;

    this.label = new TextMesh(name, { size: 11, weight: 500, tracking: 0.34, align: 'left' }, options.pixelRatio ?? 2);
    this.label.setColour(DIM);
    this.label.position.set(0, 14, 0);
    this.add(this.label);

    for (let i = 0; i < count; i++) {
      const opacity = uniform(0.16);
      const material = new MeshBasicNodeMaterial();
      material.colorNode = color(ACCENT);
      material.opacityNode = opacity;
      material.transparent = true;
      material.depthTest = false;
      material.depthWrite = false;

      const mesh = new Mesh(new PlaneGeometry(segmentWidth, 8), material);
      mesh.position.set(i * (segmentWidth + gap) + segmentWidth / 2, 0, 0);
      mesh.renderOrder = 2;
      this.segments.push({ mesh, opacity });
      this.add(mesh);
    }
  }

  /** Sets the rating, 0..1. The meter fills toward it rather than snapping. */
  setValue(value: number): void {
    this.target = clamp(value, 0, 1);
  }

  update(dt: number): void {
    this.shown = lerp(this.shown, this.target, 1 - Math.exp(-dt * 10));
    const filled = this.shown * this.segments.length;
    for (let i = 0; i < this.segments.length; i++) {
      const { mesh, opacity } = this.segments[i]!;
      // Partial fill on the leading segment, so the meter moves continuously
      // even though it reads as discrete blocks.
      const fill = clamp(filled - i, 0, 1);
      opacity.value = lerp(0.14, 1, fill);
      mesh.scale.y = lerp(0.45, 1, fill);
    }
  }

  dispose(): void {
    this.label.dispose();
    for (const { mesh } of this.segments) {
      mesh.geometry.dispose();
      (mesh.material as { dispose(): void }).dispose();
    }
  }
}
