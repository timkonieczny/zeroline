import { Group, Mesh, PlaneGeometry } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { color, uniform } from 'three/tsl';
import { TextMesh, panelMaterial } from '@/ui/Text';
import { DARK_UI } from '@/ui/Palette';
import { clamp01, lerp } from '@/core/math';

/** What the pause menu can be asked to do. */
export type PauseChoice = 'resume' | 'quit';

interface Row {
  choice: PauseChoice;
  label: TextMesh;
  detail: TextMesh;
  highlight: Mesh;
  rule: Mesh;
  group: Group;
}

/** Height of one row, in layout pixels. */
const ROW_HEIGHT = 64;
/** Width of the panel, in layout pixels. */
const PANEL_WIDTH = 520;
/** How far a row slides in from the left when selected. */
const ROW_SLIDE = 14;
/** Seconds the whole panel takes to arrive and leave. */
const FADE_RATE = 13;

const UI = DARK_UI;

/**
 * The pause panel.
 *
 * Built out of the same pieces as the hangar's menus and laid out the same way —
 * an italic headline, a flush-left list, a filled bar behind the selection and
 * an accent rule at its left edge — but in the dark palette. The showroom's
 * light scheme is a scheme for a white room; over a circuit at speed it would be
 * a sheet of white dropped onto the frame. What carries across is the layout and
 * the typography, which is what makes it recognisably the same interface.
 *
 * It lives in the HUD's scene rather than in the world, so it composites after
 * the post chain and stays pin-sharp whatever the blur is doing behind it.
 */
export class PauseMenu {
  readonly group = new Group();

  private readonly rows: Row[] = [];
  private readonly heading: TextMesh;
  private readonly hint: TextMesh;
  private readonly veil: Mesh;
  private readonly panel: Group = new Group();

  /** Drives the veil's fade without rebuilding its material. */
  private readonly veilOpacity = uniform(0);

  private index = 0;
  /** Eased 0..1 presence, so the panel arrives and leaves rather than blinking. */
  private shown = 0;
  private target = 0;
  private shownIndex = 0;
  private height = 1;

  constructor(pixelRatio: number) {
    // A full-frame darkening, so the circuit reads as "held" rather than as
    // still going on behind a widget. Its own material rather than a shared
    // panel, because this one has to fade and `panelMaterial` bakes its opacity
    // into the node graph.
    const veilMaterial = new MeshBasicNodeMaterial();
    veilMaterial.colorNode = color(0x05090d);
    veilMaterial.opacityNode = this.veilOpacity;
    veilMaterial.transparent = true;
    veilMaterial.depthTest = false;
    veilMaterial.depthWrite = false;
    this.veil = new Mesh(new PlaneGeometry(1, 1), veilMaterial);
    this.veil.renderOrder = 40;
    this.group.add(this.veil);

    this.heading = new TextMesh('Paused', { size: 46, tracking: 0.16, align: 'left', italic: true }, pixelRatio);
    this.heading.setColour(UI.ink);
    this.heading.renderOrder = 46;

    this.hint = new TextMesh('Up down choose · Enter select · Esc resume', { size: 12, tracking: 0.3, align: 'left' }, pixelRatio);
    this.hint.setColour(UI.dim);
    this.hint.renderOrder = 46;

    this.panel.add(this.heading, this.hint);

    const entries: { choice: PauseChoice; label: string; detail: string }[] = [
      { choice: 'resume', label: 'Resume', detail: 'Back to the race' },
      { choice: 'quit', label: 'Quit to hangar', detail: 'Abandon this race' },
    ];

    entries.forEach((entry, i) => {
      const group = new Group();

      const highlight = new Mesh(
        new PlaneGeometry(PANEL_WIDTH, ROW_HEIGHT - 10),
        // Softer than the palette's default. The HUD is composited after tone
        // mapping now, so an accent fill arrives at full strength rather than
        // rolled off, and 0.14 was reading closer to a third.
        panelMaterial(UI.highlight, UI.highlightAlpha * 0.7),
      );
      highlight.position.x = PANEL_WIDTH / 2;
      highlight.renderOrder = 42;

      const rule = new Mesh(new PlaneGeometry(3, ROW_HEIGHT - 18), panelMaterial(UI.accent, 1));
      rule.position.x = 1.5;
      rule.renderOrder = 43;

      const label = new TextMesh(entry.label, { size: 26, tracking: 0.14, align: 'left' }, pixelRatio);
      label.position.set(26, 6, 0);
      label.renderOrder = 44;

      const detail = new TextMesh(entry.detail, { size: 12, tracking: 0.26, align: 'left' }, pixelRatio);
      detail.setColour(UI.dim);
      detail.position.set(26, -16, 0);
      detail.renderOrder = 44;

      group.add(highlight, rule, label, detail);
      group.position.y = -i * ROW_HEIGHT;
      this.panel.add(group);

      this.rows.push({ choice: entry.choice, label, detail, highlight, rule, group });
    });

    this.group.add(this.panel);
    this.group.visible = false;
    this.applySelection();
  }

  /** Whether the panel is up and taking input. */
  get open(): boolean {
    return this.target > 0.5;
  }

  /** Still animating out, so the caller should keep rendering it. */
  get busy(): boolean {
    return this.shown > 0.002;
  }

  show(): void {
    this.target = 1;
    this.index = 0;
    this.shownIndex = 0;
    this.applySelection();
    this.group.visible = true;
  }

  hide(): void {
    this.target = 0;
  }

  /** Moves the selection. Returns the choice when one is committed. */
  handle(action: 'up' | 'down' | 'confirm' | 'back' | string): PauseChoice | null {
    if (!this.open) return null;
    if (action === 'up') {
      this.index = (this.index + this.rows.length - 1) % this.rows.length;
      this.applySelection();
    } else if (action === 'down') {
      this.index = (this.index + 1) % this.rows.length;
      this.applySelection();
    } else if (action === 'confirm') {
      return this.rows[this.index]!.choice;
    } else if (action === 'back' || action === 'pause') {
      return 'resume';
    }
    return null;
  }

  setPixelRatio(ratio: number): void {
    this.heading.setPixelRatio(ratio);
    this.hint.setPixelRatio(ratio);
    for (const row of this.rows) {
      row.label.setPixelRatio(ratio);
      row.detail.setPixelRatio(ratio);
    }
  }

  resize(width: number, height: number): void {
    this.height = height;
    this.veil.scale.set(width, height, 1);
    this.veil.position.set(width / 2, height / 2, 0);

    // Flush left, a third of the way in, with the list hanging under the
    // headline — the same shape as every screen in the hangar.
    const left = Math.max(64, width * 0.12);
    const top = height * 0.62;
    this.panel.position.set(left, top, 0);
    this.heading.position.set(0, 74, 0);
    this.hint.position.set(0, -this.rows.length * ROW_HEIGHT - 4, 0);
  }

  update(dt: number): void {
    this.shown = lerp(this.shown, this.target, 1 - Math.exp(-dt * FADE_RATE));
    this.group.visible = this.busy;
    if (!this.group.visible) return;

    this.shownIndex = lerp(this.shownIndex, this.index, 1 - Math.exp(-dt * 16));

    const eased = clamp01(this.shown);
    this.veilOpacity.value = 0.62 * eased;

    this.heading.setOpacity(eased);
    this.hint.setOpacity(eased * 0.9);
    // Rises into place rather than fading on the spot.
    this.panel.position.y = this.height * 0.62 - (1 - eased) * 26;

    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i]!;
      const nearness = clamp01(1 - Math.abs(i - this.shownIndex));
      row.group.position.x = lerp(0, ROW_SLIDE, nearness);
      row.highlight.scale.x = nearness;
      row.highlight.position.x = (PANEL_WIDTH * nearness) / 2;
      row.rule.scale.y = nearness;
      row.label.setOpacity(eased);
      row.detail.setOpacity(eased * lerp(0.5, 0.95, nearness));
    }
  }

  private applySelection(): void {
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i]!;
      row.label.setColour(i === this.index ? UI.accent : UI.ink, 1);
    }
  }

  dispose(): void {
    this.group.traverse((object) => {
      if (object instanceof Mesh) {
        object.geometry.dispose();
        (object.material as { dispose(): void }).dispose();
      }
    });
  }
}
