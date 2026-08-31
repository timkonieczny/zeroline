import { Group, Mesh, PlaneGeometry } from 'three';
import { TextMesh, panelMaterial } from './Text';
import { clamp, lerp } from '@/core/math';

const INK = 0xf2f6fa;
const DIM = 0x76828e;
const ACCENT = 0x24d4ff;

export interface OptionRow {
  /** Setting name, shown on the left. */
  label: string;
  /** The values this setting can take, in order. */
  choices: readonly string[];
  /** Index of the current choice. */
  index: number;
}

/**
 * A settings list: a name on the left, a value on the right, changed with left
 * and right rather than by opening a submenu.
 *
 * Chevrons appear beside the value only when there is somewhere to go in that
 * direction, which is the cheapest way to make a gamepad-only menu explain
 * itself without a legend.
 */
export class OptionList extends Group {
  private readonly rows: {
    group: Group;
    label: TextMesh;
    value: TextMesh;
    left: TextMesh;
    right: TextMesh;
    row: OptionRow;
  }[] = [];

  private readonly highlight: Mesh;
  private readonly rule: Mesh;

  index = 0;
  private shownIndex = 0;

  readonly rowHeight: number;
  readonly width: number;

  /** Called with the row and its new choice whenever a value changes. */
  onChange: ((row: OptionRow) => void) | null = null;

  constructor(rows: readonly OptionRow[], options: { width?: number; rowHeight?: number; pixelRatio?: number } = {}) {
    super();
    this.width = options.width ?? 520;
    this.rowHeight = options.rowHeight ?? 50;
    const pixelRatio = options.pixelRatio ?? 2;

    this.highlight = new Mesh(new PlaneGeometry(this.width, this.rowHeight - 8), panelMaterial(ACCENT, 0.13));
    this.highlight.renderOrder = 1;
    this.add(this.highlight);

    this.rule = new Mesh(new PlaneGeometry(3, this.rowHeight - 14), panelMaterial(ACCENT, 1));
    this.rule.renderOrder = 2;
    this.add(this.rule);

    rows.forEach((row, i) => {
      const group = new Group();
      group.position.y = -i * this.rowHeight;

      const label = new TextMesh(row.label, { size: 18, weight: 400, tracking: 0.28, align: 'left' }, pixelRatio);
      label.position.set(24, 0, 0);

      const value = new TextMesh(row.choices[row.index] ?? '', { size: 18, weight: 300, tracking: 0.22, align: 'right' }, pixelRatio);
      value.position.set(this.width - 44, 0, 0);
      value.setColour(ACCENT);

      const left = new TextMesh('‹', { size: 20, weight: 400, tracking: 0, align: 'centre' }, pixelRatio);
      const right = new TextMesh('›', { size: 20, weight: 400, tracking: 0, align: 'centre' }, pixelRatio);
      left.position.set(this.width - 200, 0, 0);
      right.position.set(this.width - 24, 0, 0);
      left.setColour(DIM);
      right.setColour(DIM);

      group.add(label, value, left, right);
      this.rows.push({ group, label, value, left, right, row: { ...row } });
      this.add(group);
    });

    this.refresh();
  }

  get length(): number {
    return this.rows.length;
  }

  /** Current state of every row, for persisting. */
  get values(): OptionRow[] {
    return this.rows.map((r) => ({ ...r.row }));
  }

  move(delta: number): void {
    if (this.rows.length === 0) return;
    this.index = (this.index + delta + this.rows.length) % this.rows.length;
  }

  /** Changes the selected row's value. Clamped, not wrapped: settings are ordered. */
  adjust(delta: number): boolean {
    const entry = this.rows[this.index];
    if (!entry) return false;
    const next = clamp(entry.row.index + delta, 0, entry.row.choices.length - 1);
    if (next === entry.row.index) return false;
    entry.row.index = next;
    this.refresh();
    this.onChange?.({ ...entry.row });
    return true;
  }

  private refresh(): void {
    for (const entry of this.rows) {
      entry.value.setText(entry.row.choices[entry.row.index] ?? '');
      // Only show a chevron where there is actually somewhere to go.
      entry.left.setOpacity(entry.row.index > 0 ? 1 : 0.15);
      entry.right.setOpacity(entry.row.index < entry.row.choices.length - 1 ? 1 : 0.15);
    }
  }

  update(dt: number): void {
    this.shownIndex = lerp(this.shownIndex, this.index, 1 - Math.exp(-dt * 16));
    this.highlight.position.set(this.width / 2, -this.shownIndex * this.rowHeight, 0);
    this.rule.position.set(1.5, -this.shownIndex * this.rowHeight, 0);

    this.rows.forEach((entry, i) => {
      const nearness = clamp(1 - Math.abs(i - this.shownIndex), 0, 1);
      entry.group.position.x = lerp(0, 14, nearness);
      entry.label.setColour(i === this.index ? INK : DIM, 1);
      entry.label.setOpacity(lerp(0.72, 1, nearness));
      entry.value.setOpacity(lerp(0.6, 1, nearness));
      const chevron = i === this.index ? 1 : 0;
      entry.left.scale.setScalar(lerp(0.85, 1, chevron));
      entry.right.scale.setScalar(lerp(0.85, 1, chevron));
    });
  }

  dispose(): void {
    for (const entry of this.rows) {
      entry.label.dispose();
      entry.value.dispose();
      entry.left.dispose();
      entry.right.dispose();
    }
    this.highlight.geometry.dispose();
    this.rule.geometry.dispose();
  }
}
