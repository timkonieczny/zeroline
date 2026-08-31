import { Color, Group, Mesh, OrthographicCamera, PlaneGeometry, Scene } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { float, smoothstep, uniform, uv, vec3 } from 'three/tsl';
import { TextMesh, panelMaterial } from '@/ui/Text';
import type { Race } from './Race';
import { WEAPONS } from './weapons/Weapons';
import { ResultsTable, formatTime } from './Results';
import { Minimap } from './Minimap';
import type { Track } from '@/track/Track';
import { clamp01, lerp } from '@/core/math';

/** Layout margin from the screen edge, in pixels. */
const MARGIN = 46;
/** Width and height of the shield bar, in pixels. */
const BAR_WIDTH = 300;
const BAR_HEIGHT = 9;

/** Peak darkening of the scrims, against the screen edge. */
const SCRIM_STRENGTH = 0.6;
/**
 * Seconds the finishing position is held on its own before the classification
 * arrives. The table is the detail; the placard is the answer.
 */
const PLACARD_TIME = 3;

const INK = 0xf2f6fa;
const DIM = 0x8b97a3;
const WARN = 0xff3d5e;

/** "1ST", "2ND", "3RD"... for the finishing placard. */
function ordinal(position: number): string {
  const tens = position % 100;
  if (tens >= 11 && tens <= 13) return `${position}th`;
  const suffix = ['th', 'st', 'nd', 'rd'][position % 10] ?? 'th';
  return `${position}${suffix}`;
}

/**
 * The in-race HUD, drawn as a flat scene on top of the finished frame.
 *
 * It lives in its own orthographic scene measured in CSS pixels, rendered after
 * the post chain rather than through it. That is deliberate: motion blur and
 * chromatic aberration are exactly what you do not want smeared across a speed
 * readout, and keeping the HUD out of the chain also keeps it pin-sharp at any
 * resolution scale.
 *
 * Everything animates. Values ease toward their targets rather than snapping,
 * the shield bar drains rather than jumping, and the weapon panel slides in when
 * something is collected.
 */
export class Hud {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(0, 1, 1, 0, -100, 100);

  private readonly root = new Group();
  private readonly results: ResultsTable;
  private readonly minimap: Minimap;
  /** Fades the racing readouts down while the classification is up. */
  private raceChrome = 1;

  private readonly speedValue: TextMesh;
  private readonly speedUnit: TextMesh;
  private readonly positionValue: TextMesh;
  private readonly positionOf: TextMesh;
  private readonly lapLabel: TextMesh;
  private readonly lapValue: TextMesh;
  private readonly timeValue: TextMesh;
  private readonly bestLabel: TextMesh;
  private readonly weaponName: TextMesh;
  private readonly weaponHint: TextMesh;
  private readonly centreMessage: TextMesh;

  private readonly shieldTrack: Mesh;
  private readonly shieldFill: Mesh;
  /** Drives the shield bar's colour without rebuilding its material. */
  private readonly shieldColour = uniform(new Color(0x24d4ff));
  private readonly weaponPanel: Group;
  private readonly scrimTop: Mesh;
  private readonly scrimBottom: Mesh;

  /** Eased readouts, so nothing in the HUD flickers at the sim rate. */
  private shownSpeed = 0;
  private shownShield = 1;
  private weaponSlide = 0;
  private centreOpacity = 0;

  private width = 1;
  private height = 1;
  /** Seconds since the flag fell, used to time the finishing sequence. */
  private finishedFor = 0;
  /** Set while the player has asked for the table to be out of the way. */
  private tableHidden = false;

  constructor(pixelRatio: number, track: Track, fieldSize: number) {
    this.scene.add(this.root);
    this.results = new ResultsTable(pixelRatio);
    this.scene.add(this.results.group);

    this.minimap = new Minimap(track, fieldSize);
    this.root.add(this.minimap.group);

    this.speedValue = new TextMesh('0', { size: 78, weight: 200, tracking: 0.02, align: 'right' }, pixelRatio);
    this.speedUnit = new TextMesh('km/h', { size: 15, weight: 500, tracking: 0.42, align: 'right' }, pixelRatio);
    this.positionValue = new TextMesh('1', { size: 82, weight: 200, tracking: 0.02, align: 'left' }, pixelRatio);
    this.positionOf = new TextMesh('/ 8', { size: 17, weight: 400, tracking: 0.3, align: 'left' }, pixelRatio);
    this.lapLabel = new TextMesh('lap', { size: 13, weight: 500, tracking: 0.42, align: 'left' }, pixelRatio);
    this.lapValue = new TextMesh('1 / 3', { size: 26, weight: 300, tracking: 0.14, align: 'left' }, pixelRatio);
    this.timeValue = new TextMesh('0:00.000', { size: 30, weight: 250, tracking: 0.08, align: 'right' }, pixelRatio);
    this.bestLabel = new TextMesh('best --:--.---', { size: 13, weight: 500, tracking: 0.28, align: 'right' }, pixelRatio);
    this.weaponName = new TextMesh('', { size: 24, weight: 300, tracking: 0.28, align: 'centre' }, pixelRatio);
    this.weaponHint = new TextMesh('space fire · shift absorb', { size: 11, weight: 500, tracking: 0.3, align: 'centre' }, pixelRatio);
    this.centreMessage = new TextMesh('', { size: 96, weight: 200, tracking: 0.24, align: 'centre' }, pixelRatio);

    this.positionValue.setColour(INK);
    this.positionOf.setColour(DIM);
    this.lapLabel.setColour(DIM);
    this.speedUnit.setColour(DIM);
    this.bestLabel.setColour(DIM);
    this.weaponHint.setColour(DIM);

    this.shieldTrack = new Mesh(new PlaneGeometry(BAR_WIDTH, BAR_HEIGHT), panelMaterial(0x1b242c, 0.75));
    const fillMaterial = new MeshBasicNodeMaterial();
    fillMaterial.colorNode = this.shieldColour;
    fillMaterial.depthTest = false;
    fillMaterial.depthWrite = false;
    this.shieldFill = new Mesh(new PlaneGeometry(1, BAR_HEIGHT), fillMaterial);
    this.shieldTrack.renderOrder = 8;
    this.shieldFill.renderOrder = 9;

    // Soft gradients top and bottom. The circuit is white concrete under a
    // bright sun; without these the readouts vanish into the road.
    this.scrimTop = new Mesh(new PlaneGeometry(1, 1), Hud.scrimMaterial(false));
    this.scrimBottom = new Mesh(new PlaneGeometry(1, 1), Hud.scrimMaterial(true));
    this.scrimTop.renderOrder = 0;
    this.scrimBottom.renderOrder = 0;

    this.weaponPanel = new Group();
    this.weaponPanel.add(this.weaponName, this.weaponHint);

    this.root.add(
      this.scrimTop,
      this.scrimBottom,
      this.speedValue,
      this.speedUnit,
      this.positionValue,
      this.positionOf,
      this.lapLabel,
      this.lapValue,
      this.timeValue,
      this.bestLabel,
      this.shieldTrack,
      this.shieldFill,
      this.weaponPanel,
    );

    // The placard lives outside the racing chrome. Everything in `root` is
    // hidden wholesale once the flag is out, and the finishing position is the
    // one thing that has to survive that.
    this.scene.add(this.centreMessage);
  }

  /** Sizes the overlay to the viewport, in CSS pixels. */
  resize(width: number, height: number, pixelRatio: number): void {
    this.width = width;
    this.height = height;
    this.camera.left = 0;
    this.camera.right = width;
    this.camera.top = height;
    this.camera.bottom = 0;
    this.camera.updateProjectionMatrix();

    for (const mesh of [
      this.speedValue,
      this.speedUnit,
      this.positionValue,
      this.positionOf,
      this.lapLabel,
      this.lapValue,
      this.timeValue,
      this.bestLabel,
      this.weaponName,
      this.weaponHint,
      this.centreMessage,
    ]) {
      mesh.setPixelRatio(pixelRatio);
    }
    this.results.setPixelRatio(pixelRatio);

    this.layout();
  }

  private layout(): void {
    const { width, height } = this;

    // Top centre, clear of the lap counter and the race clock.
    this.minimap.group.position.set(width / 2, height - MARGIN - this.minimap.extent.y / 2 - 8, 0);

    const scrimHeight = Math.min(230, height * 0.3);
    this.scrimTop.scale.set(width, scrimHeight, 1);
    this.scrimTop.position.set(width / 2, height - scrimHeight / 2, 0);
    this.scrimBottom.scale.set(width, scrimHeight, 1);
    this.scrimBottom.position.set(width / 2, scrimHeight / 2, 0);

    // Bottom right: the speed readout, the single most-watched number.
    this.speedValue.position.set(width - MARGIN, MARGIN + 62, 0);
    this.speedUnit.position.set(width - MARGIN, MARGIN + 18, 0);

    // Bottom left: position, then the shield bar under it.
    this.positionValue.position.set(MARGIN, MARGIN + 74, 0);
    this.positionOf.position.set(MARGIN + this.positionValue.size.x - 8, MARGIN + 52, 0);
    this.shieldTrack.position.set(MARGIN + BAR_WIDTH / 2, MARGIN + 18, 0);
    this.shieldFill.position.set(MARGIN, MARGIN + 18, 0);

    // Top left: lap counter.
    this.lapLabel.position.set(MARGIN, height - MARGIN - 6, 0);
    this.lapValue.position.set(MARGIN, height - MARGIN - 34, 0);

    // Top right: race clock and best lap.
    this.timeValue.position.set(width - MARGIN, height - MARGIN - 12, 0);
    this.bestLabel.position.set(width - MARGIN, height - MARGIN - 42, 0);

    this.weaponPanel.position.set(width / 2, MARGIN + 34, 0);
    this.weaponName.position.set(0, 22, 0);
    this.weaponHint.position.set(0, -2, 0);

    this.centreMessage.position.set(width / 2, height * 0.56, 0);
  }

  /** Pulls this frame's values off the race and eases the display toward them. */
  update(race: Race, dt: number): void {
    const player = race.player;

    const targetSpeed = Math.max(0, player.telemetry.speed * 3.6);
    this.shownSpeed = lerp(this.shownSpeed, targetSpeed, 1 - Math.exp(-dt * 12));
    this.speedValue.setText(this.shownSpeed.toFixed(0));

    this.shownShield = lerp(this.shownShield, clamp01(player.shieldFraction), 1 - Math.exp(-dt * 9));
    const fillWidth = Math.max(1, BAR_WIDTH * this.shownShield);
    this.shieldFill.scale.x = fillWidth;
    this.shieldFill.position.x = MARGIN + fillWidth / 2;
    // Below a quarter the bar turns red and pulses, because at that point the
    // next clean hit ends the race.
    const critical = this.shownShield < 0.28;
    const pulse = critical ? 0.6 + 0.4 * Math.sin(race.time * 12) : 1;
    this.shieldColour.value.setHex(critical ? WARN : 0x24d4ff).multiplyScalar(pulse);
    this.shieldFill.visible = this.shownShield > 0.002;

    this.positionValue.setText(String(player.position));
    this.positionValue.setColour(player.position === 1 ? 0xffd76b : INK);
    this.positionOf.setText(`/ ${race.craft.length}`);
    this.lapValue.setText(`${Math.min(race.setup.laps, player.lap + 1)} / ${race.setup.laps}`);

    this.timeValue.setText(formatTime(Math.max(0, race.time)));
    this.bestLabel.setText(`best ${formatTime(player.bestLap ?? -1)}`);

    // Weapon panel slides up when something is held.
    const held = player.weapon;
    const targetSlide = held ? 1 : 0;
    this.weaponSlide = lerp(this.weaponSlide, targetSlide, 1 - Math.exp(-dt * 11));
    this.weaponPanel.position.y = MARGIN + 34 - (1 - this.weaponSlide) * 46;
    if (held) {
      const def = WEAPONS[held.id];
      this.weaponName.setText(def.ammo > 1 ? `${def.name} x${held.ammo}` : def.name);
      this.weaponName.setColour(def.kind === 'offensive' ? 0xff8a5c : def.kind === 'defensive' ? 0x6ce8ff : 0xffd76b);
    }

    this.minimap.update(race.craft, player);

    // The flag: the placard alone for a few seconds, then the classification.
    if (race.finished) {
      this.finishedFor += dt;
      if (this.finishedFor > PLACARD_TIME && !this.tableHidden) this.results.show();
    } else {
      this.finishedFor = 0;
    }
    this.results.update(race, dt, this.width, this.height);

    // Racing readouts fade out under the classification. The bars and scrims
    // are plain meshes with no text opacity, so the whole group is hidden once
    // the fade has run rather than being left at a residual alpha.
    // The readouts stay up through the placard — the scrims are what give it
    // contrast against a bright sky, and a driver who has just crossed the line
    // still wants to see the lap and the speed. They step aside only once the
    // table arrives, and come back if it is tucked away to watch the replay.
    const tableUp = race.finished && this.finishedFor > PLACARD_TIME && !this.tableHidden;
    const wantChrome = tableUp ? 0 : 1;
    this.raceChrome = lerp(this.raceChrome, wantChrome, 1 - Math.exp(-dt * 7));
    this.root.visible = this.raceChrome > 0.02;
    for (const mesh of [
      this.speedValue,
      this.speedUnit,
      this.positionValue,
      this.positionOf,
      this.lapLabel,
      this.lapValue,
      this.timeValue,
      this.bestLabel,
    ]) {
      mesh.setOpacity(this.raceChrome);
    }
    this.weaponName.setOpacity(this.weaponSlide * this.raceChrome);
    this.weaponHint.setOpacity(this.weaponSlide * 0.85 * this.raceChrome);

    // Centre message: the countdown, the lights going out, then the placard.
    let message = '';
    let placard = false;
    if (race.phase === 'countdown') {
      const remaining = Math.ceil(race.countdown);
      message = remaining > 0 ? String(remaining) : 'GO';
    } else if (race.finished && this.finishedFor < PLACARD_TIME + 0.4 && !this.tableHidden) {
      message = ordinal(player.position);
      placard = true;
    } else if (race.time < 1.2) {
      message = 'GO';
    }
    const targetOpacity = message ? 1 : 0;
    this.centreOpacity = lerp(this.centreOpacity, targetOpacity, 1 - Math.exp(-dt * 8));
    if (message) this.centreMessage.setText(message);
    this.centreMessage.setColour(placard ? (player.position === 1 ? 0xffd76b : INK) : critical ? WARN : INK, 1);
    // The placard is the one thing that must not fade with the racing chrome.
    this.centreMessage.setOpacity(this.centreOpacity * (placard ? 1 : this.raceChrome));
    const pop = 1 + (1 - this.centreOpacity) * 0.25;
    this.centreMessage.scale.setScalar(pop);
  }

  /** Starts the classification's dismissal animation. */
  hideResults(): void {
    this.results.hide();
  }

  /**
   * Toggles the classification out of the way so the replay can be watched,
   * and back again. Returns true if the table is now hidden.
   */
  toggleResults(): boolean {
    this.tableHidden = !this.tableHidden;
    if (this.tableHidden) this.results.conceal();
    else this.results.restore();
    return this.tableHidden;
  }

  get resultsConcealed(): boolean {
    return this.tableHidden;
  }

  /** True once the classification has finished animating away. */
  get resultsDismissed(): boolean {
    return this.results.dismissed;
  }

  /** Clears the classification for a fresh race. */
  resetResults(): void {
    this.results.reset();
    this.raceChrome = 1;
    this.finishedFor = 0;
    this.tableHidden = false;
  }

  /**
   * A one-sided vertical fade, used behind the readouts.
   *
   * `edgeDistance` is 0 against the edge of the screen this scrim hugs and 1 at
   * its inner side, so the darkening is strongest at the edge and gone by the
   * inner boundary. Getting this the wrong way round — as an earlier version
   * did — draws a hard-edged band across the middle of the frame instead.
   */
  private static scrimMaterial(fromBottom: boolean): MeshBasicNodeMaterial {
    const material = new MeshBasicNodeMaterial();
    const edgeDistance = fromBottom ? uv().y : uv().y.oneMinus();
    material.colorNode = vec3(0.02, 0.03, 0.04);
    material.opacityNode = smoothstep(float(0), float(1), edgeDistance).oneMinus().mul(SCRIM_STRENGTH);
    material.transparent = true;
    material.depthTest = false;
    material.depthWrite = false;
    return material;
  }

  dispose(): void {
    this.results.dispose();
    this.minimap.dispose();
    this.scene.traverse((object) => {
      if (object instanceof TextMesh) object.dispose();
      else if (object instanceof Mesh) {
        object.geometry.dispose();
        (object.material as { dispose(): void }).dispose();
      }
    });
  }
}
