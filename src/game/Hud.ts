import { Box3, Color, Group, Mesh, OrthographicCamera, PlaneGeometry, Scene, Vector3 } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { float, pow, smoothstep, uniform, uv, vec3 } from 'three/tsl';
import { TextMesh, panelMaterial } from '@/ui/Text';
import type { Race } from './Race';
import { WEAPONS } from './weapons/Weapons';
import { ResultsTable, formatTime } from './Results';
import { Minimap } from './Minimap';
import type { Track } from '@/track/Track';
import { clamp, clamp01, lerp } from '@/core/math';

/** Layout margin from the screen edge, in pixels. */
const MARGIN = 46;
/** Width and height of the shield bar, in pixels. */
const BAR_WIDTH = 300;
const BAR_HEIGHT = 9;

/**
 * Scale of the whole overlay when stopped, and when flat out.
 *
 * The HUD is one rigid plane: it is laid out once, then scaled and shifted as a
 * single object. Scaling each cluster about its own corner grew the readouts
 * without moving the margins, which sounds better than it looks — the layout
 * changes shape as it grows, and the eye reads that as the interface coming
 * apart rather than as speed.
 *
 * Resting under 1 is what buys the range. A layout that touches all four
 * margins cannot be scaled about its centre by much before something leaves the
 * screen, so it sits a little small at a standstill and reaches its natural size
 * at speed. `maxPlaneScale` then clamps whatever this asks for to what actually
 * fits the viewport.
 */
const HUD_REST_SCALE = 0.92;
const HUD_FAST_SCALE = 1.16;
/** How fast the growth follows the speedometer. Slower than the number itself. */
const HUD_SCALE_RATE = 5;

/**
 * Pixels the plane slides at one radian per second of course change, and the
 * furthest it may ever slide.
 *
 * Driven by how the craft's direction of travel is changing rather than by the
 * stick: a craft can be pointed one way and moving another, and it is the
 * movement that the eye is bracing against. It also comes free in the vertical,
 * so cresting a rise pushes the interface up.
 */
const HUD_SWAY_GAIN = 26;
const HUD_SWAY_LIMIT = 34;
/** How fast the sway follows. Loose enough to feel like weight, not lag. */
const HUD_SWAY_RATE = 6;
/** Pixels kept between the plane and the edge of the frame at full scale. */
const HUD_GUARD = 6;

/**
 * Peak darkening of the scrims, against the screen edge.
 *
 * Raised once the painted sky arrived. The readouts are near-white and the old
 * backdrop was a gradient that stayed well under them; pale cloud at the top of
 * frame put the lap counter within a few percent of the type's own value and it
 * simply disappeared.
 */
const SCRIM_STRENGTH = 0.7;
/**
 * Seconds the finishing position is held on its own before the classification
 * arrives. The table is the detail; the placard is the answer.
 */
const PLACARD_TIME = 3;
/** Seconds the getaway verdict stays on screen after the lights. */
const GETAWAY_TIME = 1.6;

const _heading = new Vector3();
const _turn = new Vector3();
const _right = new Vector3();

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
  /**
   * Everything that scales and sways as one piece.
   *
   * Laid out about its own centre so a uniform scale grows it in place. The
   * scrims stay outside: they are full-bleed gradients and have to reach the
   * edges whatever the plane is doing.
   */
  private readonly plane = new Group();
  /** Eased plane scale, driven by the player's fraction of top speed. */
  private planeScale = HUD_REST_SCALE;
  /** Largest scale that keeps the whole plane inside the frame. */
  private maxPlaneScale = 1;
  /** Eased plane offset in pixels, driven by the craft's change of course. */
  private readonly sway = new Vector3();
  /** Last frame's direction of travel, in world space. */
  private readonly lastHeading = new Vector3();
  private hasHeading = false;
  private readonly scrimTop: Mesh;
  private readonly scrimBottom: Mesh;

  /** Eased readouts, so nothing in the HUD flickers at the sim rate. */
  private shownSpeed = 0;
  private shownShield = 1;
  private weaponSlide = 0;
  private centreOpacity = 0;
  /** Point size the centre message is currently rasterised at. */
  private centreSize = 100;

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
    this.plane.add(this.minimap.group);

    this.speedValue = new TextMesh('0', { size: 80, tracking: 0.02, align: 'right', italic: true }, pixelRatio);
    this.speedUnit = new TextMesh('km/h', { size: 15, tracking: 0.42, align: 'right' }, pixelRatio);
    this.positionValue = new TextMesh('1', { size: 84, tracking: 0.02, align: 'left', italic: true }, pixelRatio);
    this.positionOf = new TextMesh('/ 8', { size: 17, tracking: 0.3, align: 'left' }, pixelRatio);
    this.lapLabel = new TextMesh('Lap', { size: 13, tracking: 0.42, align: 'left' }, pixelRatio);
    this.lapValue = new TextMesh('1 / 3', { size: 26, tracking: 0.14, align: 'left' }, pixelRatio);
    this.timeValue = new TextMesh('0:00.000', { size: 30, tracking: 0.08, align: 'right' }, pixelRatio);
    this.bestLabel = new TextMesh('Best --:--.---', { size: 13, tracking: 0.28, align: 'right' }, pixelRatio);
    this.weaponName = new TextMesh('', { size: 24, tracking: 0.24, align: 'centre', italic: true }, pixelRatio);
    this.weaponHint = new TextMesh('Space fire · Shift absorb', { size: 11, tracking: 0.3, align: 'centre' }, pixelRatio);
    this.centreMessage = new TextMesh('', { size: 100, tracking: 0.2, align: 'centre', italic: true }, pixelRatio);

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

    this.plane.add(
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

    this.root.add(this.scrimTop, this.scrimBottom, this.plane);

    // The placard lives outside the racing chrome. Everything in `root` is
    // hidden wholesale once the flag is out, and the finishing position is the
    // one thing that has to survive that.
    this.scene.add(this.centreMessage);
  }

  /**
   * Scales and shifts the whole overlay from how the craft is travelling.
   *
   * Two inputs, both about movement rather than intent. Speed sets the size, so
   * a pad or a turbo swells the interface for as long as it lasts. The change in
   * the *direction of travel* sets the offset: the plane slides against the turn,
   * the way a passenger leans against one. Steering would have been the easy
   * signal and the wrong one — a craft sliding through a corner is pointed
   * somewhere other than where it is going, and it is where it is going that the
   * eye braces for. Taking the direction as a world-space vector rather than an
   * angle means the vertical comes free, so cresting a rise pushes the readouts
   * up without a second rule for it.
   */
  private drivePlane(player: Race['player'], dt: number): void {
    const pace = clamp01(player.telemetry.speed / player.handling.topSpeed);
    const target = Math.min(lerp(HUD_REST_SCALE, HUD_FAST_SCALE, pace), this.maxPlaneScale);
    this.planeScale = lerp(this.planeScale, target, 1 - Math.exp(-dt * HUD_SCALE_RATE));
    this.plane.scale.setScalar(this.planeScale);

    const velocity = player.state.velocity;
    const moving = velocity.lengthSq() > 1e-4;
    _heading.copy(moving ? velocity : player.state.forward).normalize();

    if (this.hasHeading && dt > 0) {
      // How fast the direction of travel is swinging, in radians per second,
      // resolved onto the craft's own right and up axes.
      _turn.copy(_heading).sub(this.lastHeading).divideScalar(dt);
      _right.copy(player.state.forward).cross(player.state.up).normalize();

      const across = clamp(_turn.dot(_right) * HUD_SWAY_GAIN, -HUD_SWAY_LIMIT, HUD_SWAY_LIMIT);
      const vertical = clamp(_turn.dot(player.state.up) * HUD_SWAY_GAIN, -HUD_SWAY_LIMIT, HUD_SWAY_LIMIT);

      // Against the turn, not with it.
      const follow = 1 - Math.exp(-dt * HUD_SWAY_RATE);
      this.sway.x = lerp(this.sway.x, -across, follow);
      this.sway.y = lerp(this.sway.y, -vertical, follow);
    }
    this.lastHeading.copy(_heading);
    this.hasHeading = true;

    this.plane.position.set(this.width / 2 + this.sway.x, this.height / 2 + this.sway.y, 0);
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

  /**
   * Lays the readouts out about the centre of the screen.
   *
   * Every position here is written the obvious way — distance from an edge —
   * and then rebased onto the plane's centre, because the plane is scaled as a
   * whole and a uniform scale only grows a layout in place if the layout is
   * centred on the origin.
   */
  private layout(): void {
    const { width, height } = this;
    /** Screen coordinates to plane-local ones. */
    const at = (x: number, y: number): [number, number, number] => [x - width / 2, y - height / 2, 0];

    const scrimHeight = Math.min(230, height * 0.3);
    this.scrimTop.scale.set(width, scrimHeight, 1);
    this.scrimTop.position.set(width / 2, height - scrimHeight / 2, 0);
    this.scrimBottom.scale.set(width, scrimHeight, 1);
    this.scrimBottom.position.set(width / 2, scrimHeight / 2, 0);

    // Bottom right: the speed readout, the single most-watched number.
    this.speedValue.position.set(...at(width - MARGIN, MARGIN + 62));
    this.speedUnit.position.set(...at(width - MARGIN, MARGIN + 18));

    // Bottom left: position, then the shield bar under it.
    this.positionValue.position.set(...at(MARGIN, MARGIN + 74));
    this.positionOf.position.set(...at(MARGIN + this.positionValue.size.x - 8, MARGIN + 52));
    this.shieldTrack.position.set(...at(MARGIN + BAR_WIDTH / 2, MARGIN + 18));
    this.shieldFill.position.set(...at(MARGIN, MARGIN + 18));

    // Top left: lap counter.
    this.lapLabel.position.set(...at(MARGIN, height - MARGIN - 6));
    this.lapValue.position.set(...at(MARGIN, height - MARGIN - 34));

    // Top right: race clock, best lap, and the minimap under both.
    this.timeValue.position.set(...at(width - MARGIN, height - MARGIN - 12));
    this.bestLabel.position.set(...at(width - MARGIN, height - MARGIN - 42));
    this.minimap.group.position.set(
      ...at(width - MARGIN - this.minimap.extent.x / 2, height - MARGIN - 74 - this.minimap.extent.y / 2),
    );

    this.weaponPanel.position.set(...at(width / 2, MARGIN + 34));
    this.weaponName.position.set(0, 22, 0);
    this.weaponHint.position.set(0, -2, 0);

    this.centreMessage.position.set(width / 2, height * 0.56, 0);

    this.plane.position.set(width / 2, height / 2, 0);
    this.measurePlane();
  }

  /**
   * Works out how far the plane may be scaled before it leaves the frame.
   *
   * Measured from the geometry rather than assumed from the margin, so a longer
   * lap counter or a bigger minimap tightens the limit on its own instead of
   * silently pushing something off the edge. The sway is subtracted too: the
   * plane has to survive being at full size and fully deflected at once.
   */
  private measurePlane(): void {
    const scale = this.plane.scale.x;
    this.plane.scale.setScalar(1);
    this.plane.updateMatrixWorld(true);

    const box = new Box3().setFromObject(this.plane);
    this.plane.scale.setScalar(scale);

    const reachX = Math.max(Math.abs(box.min.x), Math.abs(box.max.x), 1);
    const reachY = Math.max(Math.abs(box.min.y), Math.abs(box.max.y), 1);
    const roomX = this.width / 2 - HUD_GUARD - HUD_SWAY_LIMIT;
    const roomY = this.height / 2 - HUD_GUARD - HUD_SWAY_LIMIT;

    this.maxPlaneScale = Math.max(HUD_REST_SCALE, Math.min(roomX / reachX, roomY / reachY));
  }

  /** Pulls this frame's values off the race and eases the display toward them. */
  update(race: Race, dt: number): void {
    const player = race.player;

    const targetSpeed = Math.max(0, player.telemetry.speed * 3.6);
    this.shownSpeed = lerp(this.shownSpeed, targetSpeed, 1 - Math.exp(-dt * 12));
    this.speedValue.setText(this.shownSpeed.toFixed(0));

    this.drivePlane(player, dt);

    this.shownShield = lerp(this.shownShield, clamp01(player.shieldFraction), 1 - Math.exp(-dt * 9));
    const fillWidth = Math.max(1, BAR_WIDTH * this.shownShield);
    this.shieldFill.scale.x = fillWidth;
    this.shieldFill.position.x = MARGIN + fillWidth / 2 - this.width / 2;
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
    this.bestLabel.setText(`Best ${formatTime(player.bestLap ?? -1)}`);

    // Weapon panel slides up when something is held.
    const held = player.weapon;
    const targetSlide = held ? 1 : 0;
    this.weaponSlide = lerp(this.weaponSlide, targetSlide, 1 - Math.exp(-dt * 11));
    this.weaponPanel.position.y = MARGIN + 34 - (1 - this.weaponSlide) * 46 - this.height / 2;
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
      message = remaining > 0 ? String(remaining) : 'Go';
    } else if (race.finished && this.finishedFor < PLACARD_TIME + 0.4 && !this.tableHidden) {
      message = ordinal(player.position);
      placard = true;
    } else if (race.time < GETAWAY_TIME && race.player.startRating !== null) {
      // A good getaway is worth saying out loud, or nobody discovers it exists.
      message = race.player.startRating > 0.6 ? 'Perfect start' : 'Good start';
    } else if (race.time < 1.2) {
      message = 'Go';
    }
    const targetOpacity = message ? 1 : 0;
    this.centreOpacity = lerp(this.centreOpacity, targetOpacity, 1 - Math.exp(-dt * 8));
    if (message) {
      // A word needs far less room than a single big numeral. `restyle` throws
      // away the raster, so it is only called when the size actually changes.
      const size = message.length > 3 ? 44 : 100;
      if (size !== this.centreSize) {
        this.centreSize = size;
        this.centreMessage.restyle({ size });
      }
      this.centreMessage.setText(message);
    }
    const getaway = !placard && player.startRating !== null && race.time < GETAWAY_TIME;
    this.centreMessage.setColour(
      placard ? (player.position === 1 ? 0xffd76b : INK) : getaway ? 0x6ce8ff : critical ? WARN : INK,
      1,
    );
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
    // Biased toward the edge, so the darkening is concentrated where the type
    // is rather than smeared halfway down the frame.
    material.opacityNode = pow(smoothstep(float(0), float(1), edgeDistance).oneMinus(), 1.6).mul(SCRIM_STRENGTH);
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
