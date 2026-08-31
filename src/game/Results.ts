import { Group, Mesh, PlaneGeometry } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { color, uniform } from 'three/tsl';
import { TextMesh, panelMaterial } from '@/ui/Text';
import type { Race } from './Race';
import type { Craft } from './Craft';
import { clamp01, lerp } from '@/core/math';

/** Widest field the table is built for. */
const MAX_ROWS = 8;
/** Table width in layout pixels. */
const TABLE_WIDTH = 760;
const ROW_HEIGHT = 46;
/** Padding inside the backing panel. */
const PAD_X = 34;
const PAD_TOP = 96;
const PAD_BOTTOM = 74;

/** Column anchors, measured from the left edge of the table. */
const COL_POSITION = 62;
const COL_TEAM = 96;
const COL_TIME = TABLE_WIDTH - 34;

/** Seconds the whole table takes to fly in, and the delay between rows. */
const REVEAL_TIME = 0.5;
const ROW_STAGGER = 0.055;
/** Dismissal is quicker than arrival — leaving should not be a ceremony. */
const DISMISS_TIME = 0.26;
/** Distance a row slides in from, in pixels. */
const ROW_SLIDE = 64;

const INK = 0xf2f6fa;
const DIM = 0x7d8894;
const ACCENT = 0x24d4ff;
const GOLD = 0xffd76b;

/** `M:SS.mmm`, or a placeholder for a time that does not exist yet. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--.---';
  // Round to milliseconds first: formatting the seconds on their own turns
  // 119.9996 into "1:60.000" rather than "2:00.000".
  const ms = Math.round(seconds * 1000);
  const m = Math.floor(ms / 60_000);
  const s = (ms - m * 60_000) / 1000;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

/** A time interval, to the millisecond, as broadcast timing would show it. */
function formatGap(seconds: number): string {
  return `+${seconds.toFixed(3)}`;
}

interface Row {
  group: Group;
  position: TextMesh;
  team: TextMesh;
  tag: TextMesh;
  time: TextMesh;
  highlight: Mesh;
}

/** One line of the classification, as text ready to be drawn. */
export interface ClassificationRow {
  /** Finishing position, 1-based. */
  position: number;
  teamName: string;
  /** Craft designation and nation, e.g. "AUR 01 · FR". */
  tag: string;
  /** Absolute finishing time, or a live interval to the leader. */
  time: string;
  /** False while the craft is still out on track. */
  finished: boolean;
  isPlayer: boolean;
}

/**
 * The classification as plain data.
 *
 * Kept separate from the drawing so the rules — who is where, whose time is
 * whose, and how a gap is written — can be tested without a GPU.
 *
 * A finisher shows its own time to the millisecond. Anyone still out there
 * shows a live interval to the leader, converted from the distance gap at that
 * craft's current pace, or a lap count once it is that far back.
 */
export function classify(race: Race): ClassificationRow[] {
  const leader = race.standings[0];
  return race.standings.map((craft, index) => ({
    position: index + 1,
    teamName: craft.team.name,
    tag: `${craft.name} · ${craft.team.nation}`,
    time: classifyTime(craft, leader, race),
    finished: craft.finishTime !== null,
    isPlayer: craft === race.player,
  }));
}

function classifyTime(craft: Craft, leader: Craft | undefined, race: Race): string {
  if (craft.finishTime !== null) return formatTime(craft.finishTime);
  if (!leader || craft === leader) return '—';

  // A leader who has taken the flag keeps driving, so its live distance is no
  // longer the finish line. Measure against where the line actually was, and
  // add the time that has passed since — which is what makes the interval
  // resolve into the craft's real deficit as it crosses.
  const finished = leader.finishTime !== null;
  const reference = finished ? leader.finishDistance : leader.distance;
  const sinceFlag = finished ? Math.max(0, race.time - leader.finishTime!) : 0;

  const behind = reference - craft.distance;
  if (behind <= 0 && !finished) return '—';

  const remaining = Math.max(0, behind);
  const lapsBehind = Math.floor(remaining / race.track.length);
  if (lapsBehind >= 1) return `+${lapsBehind} lap${lapsBehind > 1 ? 's' : ''}`;

  // Convert the distance gap into a time gap at the craft's own pace.
  const pace = Math.max(20, craft.telemetry.speed);
  return formatGap(sinceFlag + remaining / pace);
}

/**
 * The final classification.
 *
 * Position, constructor and time to the millisecond, with the player's row
 * picked out. It keeps updating while it is on screen: the race carries on
 * behind it, so an AI still on its last lap shows a live interval that turns
 * into a real finishing time the moment it crosses the line.
 *
 * Rows fly in from the right on a stagger rather than all at once, which reads
 * as a classification being counted up rather than a dialog appearing.
 */
export class ResultsTable {
  readonly group = new Group();

  private readonly panel: Mesh;
  private readonly title: TextMesh;
  private readonly subtitle: TextMesh;
  private readonly headerPosition: TextMesh;
  private readonly headerTeam: TextMesh;
  private readonly headerTime: TextMesh;
  private readonly rule: Mesh;
  private readonly footer: TextMesh;
  private readonly rows: Row[] = [];

  /** Drives the backing panel's fade without rebuilding its material. */
  private readonly panelOpacity = uniform(0);
  private readonly ruleOpacity = uniform(0);

  /** 0 hidden, 1 fully shown. Eased toward the effective target. */
  private reveal = 0;
  private rowCount = 0;
  /** True once the race has finished and the table has been asked for. */
  private wanted = false;
  /**
   * True while the player has tucked the table away to watch the replay. Unlike
   * a dismissal this is reversible, so it is tracked separately.
   */
  private concealed = false;
  /**
   * Set once the player has dismissed the table, and cleared only by `reset`.
   *
   * Without it `show()` — which the HUD calls on every frame the race is
   * finished — immediately undoes `hide()`, so the dismissal never completes
   * and the race never hands back to the menu.
   */
  private dismissRequested = false;

  constructor(pixelRatio: number) {
    this.group.visible = false;

    const text = (
      value: string,
      size: number,
      tracking: number,
      align: 'left' | 'right' | 'centre',
      italic = false,
    ): TextMesh => new TextMesh(value, { size, tracking, align, italic }, pixelRatio);

    this.panel = new Mesh(new PlaneGeometry(1, 1), ResultsTable.fadeMaterial(0x070b0f, this.panelOpacity));
    this.panel.renderOrder = 4;

    this.title = text('Final classification', 15, 0.5, 'left');
    this.title.setColour(ACCENT);
    this.subtitle = text('', 32, 0.16, 'left', true);

    this.headerPosition = text('Pos', 11, 0.44, 'right');
    this.headerTeam = text('Constructor', 11, 0.44, 'left');
    this.headerTime = text('Time', 11, 0.44, 'right');
    for (const header of [this.headerPosition, this.headerTeam, this.headerTime]) header.setColour(DIM);

    this.rule = new Mesh(new PlaneGeometry(1, 1), ResultsTable.fadeMaterial(0x2c3945, this.ruleOpacity));
    this.rule.renderOrder = 5;

    this.footer = text('Tab hide  ·  Enter continue', 11, 0.42, 'centre');
    this.footer.setColour(DIM);

    this.group.add(
      this.panel,
      this.title,
      this.subtitle,
      this.headerPosition,
      this.headerTeam,
      this.headerTime,
      this.rule,
      this.footer,
    );

    for (let i = 0; i < MAX_ROWS; i++) {
      const group = new Group();
      const highlight = new Mesh(new PlaneGeometry(TABLE_WIDTH - PAD_X, ROW_HEIGHT - 6), panelMaterial(ACCENT, 0.14));
      highlight.position.x = (TABLE_WIDTH - PAD_X) / 2;
      highlight.renderOrder = 5;
      highlight.visible = false;

      const row: Row = {
        group,
        highlight,
        position: text('', 28, 0.04, 'right', true),
        team: text('', 19, 0.2, 'left'),
        // Constructor tag and nation: genuine abbreviations, so genuinely shouted.
        tag: new TextMesh('', { size: 11, tracking: 0.4, align: 'left', upper: true }, pixelRatio),
        time: text('', 20, 0.08, 'right'),
      };
      row.position.position.set(COL_POSITION, 0, 0);
      row.team.position.set(COL_TEAM, 5, 0);
      row.tag.position.set(COL_TEAM, -15, 0);
      row.time.position.set(COL_TIME, 0, 0);
      row.tag.setColour(DIM);

      group.add(highlight, row.position, row.team, row.tag, row.time);
      group.visible = false;
      this.rows.push(row);
      this.group.add(group);
    }
  }

  /** Re-rasterises the table's text after a display or zoom change. */
  setPixelRatio(ratio: number): void {
    for (const text of [
      this.title,
      this.subtitle,
      this.headerPosition,
      this.headerTeam,
      this.headerTime,
      this.footer,
    ]) {
      text.setPixelRatio(ratio);
    }
    for (const row of this.rows) {
      row.position.setPixelRatio(ratio);
      row.team.setPixelRatio(ratio);
      row.tag.setPixelRatio(ratio);
      row.time.setPixelRatio(ratio);
    }
  }

  get shown(): boolean {
    return this.target > 0;
  }

  /** True once the dismissal animation has fully played out. */
  get dismissed(): boolean {
    return this.target === 0 && this.reveal < 0.01;
  }

  /** The table should be on screen unless something says otherwise. */
  private get target(): number {
    return this.wanted && !this.dismissRequested && !this.concealed ? 1 : 0;
  }

  show(): void {
    if (this.dismissRequested) return;
    this.wanted = true;
    this.group.visible = true;
  }

  /** Tucks the table away, reversibly. */
  conceal(): void {
    this.concealed = true;
  }

  /** Brings a concealed table back. */
  restore(): void {
    this.concealed = false;
    if (this.wanted && !this.dismissRequested) this.group.visible = true;
  }

  hide(): void {
    this.dismissRequested = true;
  }

  reset(): void {
    this.dismissRequested = false;
    this.concealed = false;
    this.wanted = false;
    this.reveal = 0;
    this.group.visible = false;
  }

  /**
   * Fills the table from the current standings and advances the animation.
   * Cheap to call every frame: `TextMesh` only re-rasterises when its string
   * actually changes, and a finished craft's row settles immediately.
   */
  update(race: Race, dt: number, width: number, height: number): void {
    const rate = this.target > this.reveal ? 1 / REVEAL_TIME : 1 / DISMISS_TIME;
    this.reveal = this.target > this.reveal
      ? Math.min(this.target, this.reveal + dt * rate)
      : Math.max(this.target, this.reveal - dt * rate);

    if (this.reveal <= 0.001 && this.target === 0) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;

    this.rowCount = Math.min(MAX_ROWS, race.standings.length);
    this.layout(width, height);
    this.fill(race);
    this.animate();
  }

  private layout(width: number, height: number): void {
    const tableHeight = PAD_TOP + this.rowCount * ROW_HEIGHT + PAD_BOTTOM;
    const left = (width - TABLE_WIDTH) / 2;
    const top = height / 2 + tableHeight / 2;

    this.group.position.set(left, top, 0);

    this.panel.scale.set(TABLE_WIDTH, tableHeight, 1);
    this.panel.position.set(TABLE_WIDTH / 2, -tableHeight / 2, 0);

    this.title.position.set(PAD_X, -34, 0);
    this.subtitle.position.set(PAD_X, -64, 0);

    const headerY = -PAD_TOP + 6;
    this.headerPosition.position.set(COL_POSITION, headerY, 0);
    this.headerTeam.position.set(COL_TEAM, headerY, 0);
    this.headerTime.position.set(COL_TIME, headerY, 0);

    this.rule.scale.set(TABLE_WIDTH - PAD_X * 2, 1, 1);
    this.rule.position.set(TABLE_WIDTH / 2, headerY - 16, 0);

    this.footer.position.set(TABLE_WIDTH / 2, -tableHeight + 34, 0);

    for (let i = 0; i < this.rows.length; i++) {
      this.rows[i]!.group.position.y = -PAD_TOP - 24 - i * ROW_HEIGHT;
    }
  }

  private fill(race: Race): void {
    this.subtitle.setText(race.setup.track.definition.name);
    this.subtitle.setColour(INK);

    const classification = classify(race);
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i]!;
      const entry = classification[i];
      row.group.visible = i < this.rowCount;
      if (!entry) continue;

      row.highlight.visible = entry.isPlayer;

      row.position.setText(String(entry.position));
      row.position.setColour(i === 0 ? GOLD : entry.isPlayer ? ACCENT : INK);

      row.team.setText(entry.teamName);
      row.team.setColour(entry.isPlayer ? ACCENT : INK);

      row.tag.setText(entry.tag);
      row.tag.setColour(entry.isPlayer ? ACCENT : DIM);

      row.time.setText(entry.time);
      row.time.setColour(!entry.finished ? DIM : entry.isPlayer ? ACCENT : INK);
    }
  }

  /** Staggered fly-in, and a straight fade on the way out. */
  private animate(): void {
    const dismissing = this.target === 0;
    const chrome = dismissing ? this.reveal : clamp01(this.reveal / 0.35);

    // The panel dims out with everything else rather than popping.
    this.panelOpacity.value = chrome * 0.86;
    this.ruleOpacity.value = clamp01((this.reveal - 0.2) * 3);

    this.title.setOpacity(chrome);
    this.subtitle.setOpacity(chrome);
    this.headerPosition.setOpacity(chrome * 0.9);
    this.headerTeam.setOpacity(chrome * 0.9);
    this.headerTime.setOpacity(chrome * 0.9);
    this.footer.setOpacity(clamp01((this.reveal - 0.75) * 4));

    for (let i = 0; i < this.rowCount; i++) {
      const row = this.rows[i]!;
      // On the way in each row waits its turn; on the way out they all go together.
      const t = dismissing
        ? this.reveal
        : clamp01((this.reveal - i * ROW_STAGGER) / Math.max(0.05, 1 - (this.rowCount - 1) * ROW_STAGGER));

      const eased = t * t * (3 - 2 * t);
      row.group.position.x = lerp(ROW_SLIDE, 0, eased);
      row.position.setOpacity(eased);
      row.team.setOpacity(eased);
      row.tag.setOpacity(eased * 0.85);
      row.time.setOpacity(eased);
      row.highlight.scale.x = eased;
      row.highlight.position.x = ((TABLE_WIDTH - PAD_X) / 2) * eased;
    }
  }

  /** A flat colour whose alpha is driven by a uniform, so fading costs nothing. */
  private static fadeMaterial(hex: number, opacity: ReturnType<typeof uniform>): MeshBasicNodeMaterial {
    const material = new MeshBasicNodeMaterial();
    material.colorNode = color(hex);
    material.opacityNode = opacity;
    material.transparent = true;
    material.depthTest = false;
    material.depthWrite = false;
    return material;
  }

  dispose(): void {
    this.panel.geometry.dispose();
    this.rule.geometry.dispose();
    for (const text of [
      this.title,
      this.subtitle,
      this.headerPosition,
      this.headerTeam,
      this.headerTime,
      this.footer,
    ]) {
      text.dispose();
    }
    for (const row of this.rows) {
      row.position.dispose();
      row.team.dispose();
      row.tag.dispose();
      row.time.dispose();
      row.highlight.geometry.dispose();
    }
  }
}
