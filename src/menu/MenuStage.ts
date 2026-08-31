import {
  CylinderGeometry,
  FogExp2,
  Group,
  Mesh,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Scene,
  SpotLight,
  Vector3,
} from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { color, float, fract, mix, oneMinus, smoothstep, time, uv } from 'three/tsl';
import { TextMesh, panelMaterial } from '@/ui/Text';
import { ListMenu, StatBar } from '@/ui/Widgets';
import { OptionList, type OptionRow } from '@/ui/OptionList';
import { GliderModel } from '@/game/GliderModel';
import { TEAMS, type Team } from '@/data/teams';
import { SPEED_CLASSES, type SpeedClass } from '@/game/Handling';
import { meridianCoast } from '@/data/tracks/meridian-coast';
import type { TrackDefinition } from '@/track/TrackTypes';
import type { MenuAction } from '@/core/Input';
import type { RaceMode } from '@/game/Race';
import { lerp } from '@/core/math';

export type MenuScreen = 'title' | 'main' | 'track' | 'craft' | 'class' | 'controls' | 'settings';

export interface MenuSelection {
  mode: RaceMode;
  track: TrackDefinition;
  team: Team;
  speedClass: SpeedClass;
}

const MARGIN = 74;
const INK = 0xf2f6fa;
const DIM = 0x76828e;
const ACCENT = 0x24d4ff;

/**
 * Where the plinth stands. Off to the right so the type, which is set flush
 * left, never has to fight the craft for the same pixels.
 */
const PLINTH = new Vector3(9, 0, 0);

/**
 * Camera stations, one per screen, given as an offset from the plinth. The
 * camera flies between them rather than cutting.
 */
const STATIONS: Record<MenuScreen, { position: [number, number, number]; look: [number, number, number]; fov: number }> = {
  // The look targets sit left of the plinth on purpose: aiming straight at it
  // would centre the craft, and the type is set flush left.
  title: { position: [10, 4.0, 15], look: [-5.5, 2.4, 0], fov: 40 },
  main: { position: [8, 3.4, 13], look: [-4.5, 2.2, 0], fov: 42 },
  track: { position: [7, 6.5, 12], look: [-4.5, 1.8, 0], fov: 44 },
  craft: { position: [0.5, 2.6, 11], look: [-3.4, 2.3, 0], fov: 34 },
  class: { position: [5, 3.0, 12], look: [-4, 2.3, 0], fov: 38 },
  controls: { position: [9, 3.6, 14], look: [-4.5, 2.3, 0], fov: 44 },
  settings: { position: [9, 5.2, 14], look: [-4.5, 2.6, 0], fov: 44 },
};

const TRACKS: readonly TrackDefinition[] = [meridianCoast];

const _from = new Vector3();
const _to = new Vector3();
const _stationPosition = new Vector3();
const _stationLook = new Vector3();
const _currentLook = new Vector3();

/**
 * The front end: a hangar, the selected craft on a plinth, and a flat UI layer
 * on top.
 *
 * Split deliberately. The 3D scene sells the fiction — dramatic key light, the
 * craft turning slowly, the wordmark reflected in a wet floor — while the
 * readable parts live in an orthographic overlay measured in pixels, so the type
 * is pin-sharp and the layout survives any aspect ratio.
 *
 * Everything moves. The camera flies between a station per screen rather than
 * cutting, lists slide their highlight, stat meters fill, and the craft on the
 * plinth swaps with a spin. Nothing in here snaps.
 */
export class MenuStage {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(44, 1, 0.1, 400);
  readonly overlay = new Scene();
  readonly overlayCamera = new OrthographicCamera(0, 1, 1, 0, -100, 100);

  /** Fires when the player confirms a race. */
  onStart: ((selection: MenuSelection) => void) | null = null;
  /** Fires when a settings row is changed. */
  onSettingChanged: ((row: OptionRow) => void) | null = null;

  screen: MenuScreen = 'title';

  private readonly plinth: Group;
  private readonly craftHolder = new Group();
  private craftModel: GliderModel | null = null;
  private craftSpin = 0;
  /** Counts down while a newly selected craft spins into place. */
  private craftSwapTimer = 0;

  private readonly panels = new Map<MenuScreen, Group>();
  private readonly lists = new Map<MenuScreen, ListMenu>();
  private settingsList: OptionList | null = null;
  private readonly statBars: StatBar[] = [];
  private readonly craftBlurb: TextMesh;
  private readonly craftName: TextMesh;
  private readonly craftNation: TextMesh;
  private readonly trackTitle: TextMesh;
  private readonly trackSubtitle: TextMesh;
  private readonly trackFacts: TextMesh;
  private readonly classBlurb: TextMesh;
  private readonly breadcrumb: TextMesh;
  private readonly hint: TextMesh;
  private readonly wordmark: TextMesh;
  private readonly tagline: TextMesh;
  private readonly pressStart: TextMesh;

  private selection: MenuSelection = {
    mode: 'race',
    track: TRACKS[0]!,
    team: TEAMS[0]!,
    speedClass: SPEED_CLASSES[2]!,
  };

  private width = 1;
  private height = 1;
  private pixelRatio = 2;
  /** Eased station blend, 0 at the previous screen and 1 at the current one. */
  private stationBlend = 1;
  private fromStation = STATIONS.title;
  private toStation = STATIONS.title;
  private titlePulse = 0;

  constructor(pixelRatio: number, private readonly settingRows: readonly OptionRow[] = []) {
    this.pixelRatio = pixelRatio;

    // --- Hangar ---------------------------------------------------------
    // Fog rather than a backdrop: the hangar has no far wall, it just stops
    // existing, which is both cheaper and more convincing than painting one.
    this.scene.fog = new FogExp2(0x05080b, 0.021);

    const floor = new Mesh(new PlaneGeometry(400, 400), MenuStage.floorMaterial());
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;

    this.plinth = new Group();
    this.plinth.position.copy(PLINTH);
    const disc = new Mesh(new CylinderGeometry(5.4, 5.8, 0.5, 64), MenuStage.plinthMaterial());
    disc.position.y = 0.25;
    disc.receiveShadow = true;
    const ring = new Mesh(new CylinderGeometry(5.75, 5.75, 0.16, 64, 1, true), MenuStage.ringMaterial());
    ring.position.y = 0.36;
    this.plinth.add(disc, ring);

    this.craftHolder.position.y = 2.6;
    this.craftHolder.scale.setScalar(1.25);
    this.plinth.add(this.craftHolder);

    const key = new SpotLight(0xffffff, 850, 70, 0.5, 0.5, 1.6);
    key.position.copy(PLINTH).add(new Vector3(7, 14, 8));
    key.target.position.copy(PLINTH).setY(2);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0008;

    const rim = new SpotLight(ACCENT, 260, 60, 0.7, 0.6, 1.6);
    rim.position.copy(PLINTH).add(new Vector3(-10, 6, -8));
    rim.target.position.copy(PLINTH).setY(2);

    const fill = new PointLight(0x4b6a8a, 110, 70, 2);
    fill.position.copy(PLINTH).add(new Vector3(-6, 8, 12));

    this.scene.add(floor, this.plinth, key, key.target, rim, rim.target, fill);
    this.scene.add(MenuStage.buildStripLights());

    // --- Overlay --------------------------------------------------------
    const t = (text: string, size: number, weight: number, tracking: number, align: 'left' | 'right' | 'centre') =>
      new TextMesh(text, { size, weight, tracking, align }, pixelRatio);

    this.wordmark = t('ZEROLINE', 92, 200, 0.44, 'left');
    this.tagline = t('anti-gravity racing league · season 47', 13, 500, 0.42, 'left');
    this.pressStart = t('press enter or A to begin', 14, 500, 0.4, 'left');
    this.tagline.setColour(DIM);
    this.pressStart.setColour(ACCENT);

    this.breadcrumb = t('', 12, 500, 0.46, 'left');
    this.breadcrumb.setColour(DIM);
    this.hint = t('', 11, 500, 0.4, 'right');
    this.hint.setColour(DIM);

    this.craftName = t('', 34, 250, 0.24, 'left');
    this.craftNation = t('', 12, 500, 0.44, 'left');
    this.craftBlurb = t('', 15, 300, 0.1, 'left');
    this.craftNation.setColour(ACCENT);
    this.craftBlurb.setColour(0xb6c1cb);

    this.trackTitle = t('', 40, 250, 0.22, 'left');
    this.trackSubtitle = t('', 13, 500, 0.44, 'left');
    this.trackFacts = t('', 14, 400, 0.16, 'left');
    this.trackSubtitle.setColour(ACCENT);
    this.trackFacts.setColour(0xb6c1cb);

    this.classBlurb = t('', 15, 300, 0.1, 'left');
    this.classBlurb.setColour(0xb6c1cb);

    this.overlay.add(this.breadcrumb, this.hint);
    this.buildPanels();
    this.setScreen('title', true);
    this.setTeam(this.selection.team, true);
  }

  // --- Screens ----------------------------------------------------------

  private buildPanels(): void {
    const titlePanel = new Group();
    titlePanel.add(this.wordmark, this.tagline, this.pressStart);
    this.panels.set('title', titlePanel);

    const mainList = new ListMenu(
      [
        { label: 'race', detail: 'eight craft · three laps' },
        { label: 'time trial', detail: 'solo · best lap' },
        { label: 'settings', detail: 'quality · audio' },
        { label: 'controls', detail: 'keyboard · gamepad' },
      ],
      { pixelRatio: this.pixelRatio, width: 480 },
    );
    const mainPanel = new Group();
    mainPanel.add(mainList);
    this.lists.set('main', mainList);
    this.panels.set('main', mainPanel);

    const trackList = new ListMenu(
      TRACKS.map((track) => ({ label: track.name, detail: track.subtitle })),
      { pixelRatio: this.pixelRatio, width: 480 },
    );
    const trackPanel = new Group();
    trackPanel.add(trackList, this.trackTitle, this.trackSubtitle, this.trackFacts);
    this.lists.set('track', trackList);
    this.panels.set('track', trackPanel);

    const craftList = new ListMenu(
      TEAMS.map((team) => ({ label: team.name, detail: team.nation })),
      { pixelRatio: this.pixelRatio, width: 420 },
    );
    const craftPanel = new Group();
    craftPanel.add(craftList, this.craftName, this.craftNation, this.craftBlurb);
    for (const name of ['speed', 'thrust', 'handling', 'shield']) {
      const bar = new StatBar(name, { pixelRatio: this.pixelRatio, width: 210 });
      this.statBars.push(bar);
      craftPanel.add(bar);
    }
    this.lists.set('craft', craftList);
    this.panels.set('craft', craftPanel);

    const classList = new ListMenu(
      SPEED_CLASSES.map((speedClass) => ({
        label: speedClass.name,
        detail: `${Math.round(145 * speedClass.speed * 3.6)} km/h`,
      })),
      { pixelRatio: this.pixelRatio, width: 480 },
    );
    classList.select(2);
    const classPanel = new Group();
    classPanel.add(classList, this.classBlurb);
    this.lists.set('class', classList);
    this.panels.set('class', classPanel);

    const controlsPanel = new Group();
    const rows = [
      'thrust                W  ·  right trigger',
      'steer                 A D  ·  left stick',
      'airbrakes             Q E  ·  bumpers',
      'sideshift             double-tap an airbrake',
      'barrel roll           double-tap, airborne',
      'fire                  space  ·  A',
      'absorb weapon         shift  ·  B',
      'look back             C  ·  left trigger',
      'pause                 esc  ·  start',
    ];
    rows.forEach((row, i) => {
      const line = new TextMesh(row, { size: 15, weight: 400, tracking: 0.16, align: 'left' }, this.pixelRatio);
      line.position.y = -i * 30;
      line.setColour(i % 2 === 0 ? INK : 0xb6c1cb);
      controlsPanel.add(line);
    });
    this.panels.set('controls', controlsPanel);

    this.settingsList = new OptionList(this.settingRows, { pixelRatio: this.pixelRatio, width: 520 });
    this.settingsList.onChange = (row) => this.onSettingChanged?.(row);
    const settingsPanel = new Group();
    settingsPanel.add(this.settingsList);
    this.panels.set('settings', settingsPanel);

    for (const panel of this.panels.values()) {
      panel.visible = false;
      this.overlay.add(panel);
    }
  }

  private setScreen(screen: MenuScreen, immediate = false): void {
    this.screen = screen;
    for (const [name, panel] of this.panels) panel.visible = name === screen;

    this.fromStation = immediate ? STATIONS[screen] : this.toStation;
    this.toStation = STATIONS[screen];
    this.stationBlend = immediate ? 1 : 0;

    const trail: Record<MenuScreen, string> = {
      title: '',
      main: 'zeroline',
      track: 'zeroline / circuit',
      craft: 'zeroline / circuit / craft',
      class: 'zeroline / circuit / craft / class',
      controls: 'zeroline / controls',
      settings: 'zeroline / settings',
    };
    this.breadcrumb.setText(trail[screen]);
    this.breadcrumb.visible = screen !== 'title';

    const hints: Record<MenuScreen, string> = {
      title: '',
      main: 'enter select',
      track: 'enter select   ·   esc back',
      craft: 'enter select   ·   esc back',
      class: 'enter start   ·   esc back',
      controls: 'esc back',
      settings: 'left right adjust   ·   esc back',
    };
    this.hint.setText(hints[screen]);
    this.hint.visible = screen !== 'title';

    this.layout();
  }

  // --- Input ------------------------------------------------------------

  /** Handles one queued menu action. Returns true if it was consumed. */
  handle(action: MenuAction): boolean {
    const list = this.lists.get(this.screen);

    if (this.screen === 'settings' && this.settingsList) {
      if (action === 'up' || action === 'down') {
        this.settingsList.move(action === 'up' ? -1 : 1);
        return true;
      }
      if (action === 'left' || action === 'right') {
        this.settingsList.adjust(action === 'left' ? -1 : 1);
        return true;
      }
    }

    if (action === 'up' || action === 'down') {
      if (!list) return false;
      list.move(action === 'up' ? -1 : 1);
      this.onListMoved();
      return true;
    }

    if (action === 'back') {
      const backTo: Record<MenuScreen, MenuScreen | null> = {
        title: null,
        main: 'title',
        track: 'main',
        craft: 'track',
        class: 'craft',
        controls: 'main',
        settings: 'main',
      };
      const target = backTo[this.screen];
      if (target) this.setScreen(target);
      return true;
    }

    if (action !== 'confirm') return false;

    switch (this.screen) {
      case 'title':
        this.setScreen('main');
        return true;

      case 'main': {
        const index = list?.index ?? 0;
        if (index === 2) this.setScreen('settings');
        else if (index === 3) this.setScreen('controls');
        else {
          this.selection.mode = index === 1 ? 'timeTrial' : 'race';
          this.setScreen('track');
          this.onListMoved();
        }
        return true;
      }

      case 'track':
        this.selection.track = TRACKS[list?.index ?? 0]!;
        this.setScreen('craft');
        this.onListMoved();
        return true;

      case 'craft':
        this.setTeam(TEAMS[list?.index ?? 0]!);
        this.setScreen('class');
        this.onListMoved();
        return true;

      case 'class':
        this.selection.speedClass = SPEED_CLASSES[list?.index ?? 2]!;
        this.onStart?.({ ...this.selection });
        return true;

      case 'controls':
      case 'settings':
        this.setScreen('main');
        return true;
    }
  }

  /** Refreshes the detail panel for whatever the cursor is now on. */
  private onListMoved(): void {
    const list = this.lists.get(this.screen);
    if (!list) return;

    if (this.screen === 'craft') {
      this.setTeam(TEAMS[list.index]!);
    } else if (this.screen === 'track') {
      const track = TRACKS[list.index]!;
      this.trackTitle.setText(track.name);
      this.trackSubtitle.setText(`${track.subtitle} · ${track.region}`);
      this.trackFacts.setText(`${track.corners.length} corners · ${track.laps} laps · sea level start`);
      this.layout();
    } else if (this.screen === 'class') {
      this.classBlurb.setText(SPEED_CLASSES[list.index]!.blurb);
      this.layout();
    }
  }

  private setTeam(team: Team, immediate = false): void {
    if (this.selection.team.id === team.id && this.craftModel && !immediate) return;
    this.selection.team = team;

    this.craftModel?.dispose();
    this.craftHolder.remove(...this.craftHolder.children);
    this.craftModel = new GliderModel(team);
    this.craftModel.setDrive(0.35, 0, 0);
    this.craftHolder.add(this.craftModel.object);
    // A newly selected craft arrives with a spin, so switching feels physical.
    this.craftSwapTimer = immediate ? 0 : 0.55;

    this.craftName.setText(team.name);
    this.craftNation.setText(`${team.tag} · ${team.nation}`);
    this.craftBlurb.setText(team.blurb);
    const stats = [team.stats.speed, team.stats.thrust, team.stats.handling, team.stats.shield];
    this.statBars.forEach((bar, i) => bar.setValue(stats[i]!));
    this.layout();
  }

  // --- Layout and animation --------------------------------------------

  resize(width: number, height: number, pixelRatio: number): void {
    this.width = width;
    this.height = height;
    this.pixelRatio = pixelRatio;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.overlayCamera.left = 0;
    this.overlayCamera.right = width;
    this.overlayCamera.top = height;
    this.overlayCamera.bottom = 0;
    this.overlayCamera.updateProjectionMatrix();
    this.overlay.traverse((object) => {
      if (object instanceof TextMesh) object.setPixelRatio(pixelRatio);
    });
    this.layout();
  }

  private layout(): void {
    const { width, height } = this;
    const left = MARGIN;
    const top = height - MARGIN;

    this.breadcrumb.position.set(left, top, 0);
    this.hint.position.set(width - MARGIN, MARGIN, 0);

    this.wordmark.position.set(left, height * 0.56, 0);
    this.tagline.position.set(left + 6, height * 0.56 - 62, 0);
    this.pressStart.position.set(left + 6, height * 0.56 - 108, 0);

    const listTop = height * 0.66;
    for (const [screen, list] of this.lists) {
      list.position.set(left, listTop, 0);
      void screen;
    }

    // Track detail sits to the right of its list.
    const detailX = left + 560;
    this.trackTitle.position.set(detailX, listTop + 6, 0);
    this.trackSubtitle.position.set(detailX, listTop - 34, 0);
    this.trackFacts.position.set(detailX, listTop - 70, 0);

    this.craftName.position.set(detailX, listTop + 6, 0);
    this.craftNation.position.set(detailX, listTop - 30, 0);
    this.craftBlurb.position.set(detailX, listTop - 64, 0);
    this.statBars.forEach((bar, i) => bar.position.set(detailX, listTop - 118 - i * 44, 0));

    this.classBlurb.position.set(detailX, listTop, 0);

    const controls = this.panels.get('controls');
    controls?.position.set(left, height * 0.68, 0);
    this.panels.get('settings')?.position.set(left, height * 0.68, 0);
  }

  update(dt: number): void {
    this.stationBlend = Math.min(1, this.stationBlend + dt * 2.6);
    // Smootherstep on the blend: the camera leaves and arrives at rest.
    const b = this.stationBlend;
    const eased = b * b * b * (b * (b * 6 - 15) + 10);

    _from.set(...this.fromStation.position);
    _to.set(...this.toStation.position);
    _stationPosition.copy(_from).lerp(_to, eased).add(PLINTH);
    _from.set(...this.fromStation.look);
    _to.set(...this.toStation.look);
    _stationLook.copy(_from).lerp(_to, eased).add(PLINTH);

    // A slow drift keeps the frame alive even when nothing is being pressed.
    const drift = performance.now() * 0.00013;
    this.camera.position.copy(_stationPosition);
    this.camera.position.x += Math.sin(drift) * 0.5;
    this.camera.position.y += Math.cos(drift * 1.3) * 0.22;
    _currentLook.copy(_stationLook);
    this.camera.lookAt(_currentLook);

    const fov = lerp(this.fromStation.fov, this.toStation.fov, eased);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    // The craft turns slowly, and faster for a moment after being swapped.
    this.craftSwapTimer = Math.max(0, this.craftSwapTimer - dt);
    const swapBoost = this.craftSwapTimer > 0 ? (this.craftSwapTimer / 0.55) * 9 : 0;
    this.craftSpin += dt * (0.32 + swapBoost);
    this.craftHolder.rotation.y = this.craftSpin;
    this.craftHolder.position.y = 2.6 + Math.sin(this.craftSpin * 1.7) * 0.09;

    for (const list of this.lists.values()) list.update(dt);
    this.settingsList?.update(dt);
    for (const bar of this.statBars) bar.update(dt);

    // The title prompt breathes rather than blinking.
    this.titlePulse += dt;
    this.pressStart.setOpacity(0.55 + 0.45 * (0.5 + 0.5 * Math.sin(this.titlePulse * 2.4)));
  }

  dispose(): void {
    this.craftModel?.dispose();
    this.settingsList?.dispose();
    for (const list of this.lists.values()) list.dispose();
    for (const bar of this.statBars) bar.dispose();
  }

  // --- Materials --------------------------------------------------------

  /** Dark polished floor with a faint grid, fading out with distance. */
  private static floorMaterial(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    const grid = uv().mul(40);
    const lineX = smoothstep(float(0.02), float(0), fract(grid.x).sub(0.5).abs().oneMinus().sub(0.98));
    const lineY = smoothstep(float(0.02), float(0), fract(grid.y).sub(0.5).abs().oneMinus().sub(0.98));
    const fade = smoothstep(float(0.5), float(0.06), uv().sub(0.5).length());
    material.colorNode = mix(color(0x070a0d), color(0x121a21), lineX.add(lineY).mul(fade));
    // Rougher and less metallic than a showroom floor would really be: a mirror
    // here catches the key light and blows a hole in the middle of the frame.
    material.roughnessNode = float(0.42);
    material.metalnessNode = float(0.4);
    return material;
  }

  private static plinthMaterial(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    material.colorNode = color(0x161d23);
    material.roughnessNode = float(0.3);
    material.metalnessNode = float(0.85);
    return material;
  }

  /** The lit ring around the plinth, chasing slowly. */
  private static ringMaterial(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    const chase = fract(uv().x.mul(3).sub(time.mul(0.18)));
    material.colorNode = color(0x0a1216);
    // Restrained on purpose. This ring sits under the bloom threshold's knee,
    // and an earlier, brighter version flooded the whole frame with cyan.
    material.emissiveNode = color(ACCENT).mul(smoothstep(float(0.55), float(0.05), chase)).mul(1.15);
    material.roughnessNode = float(0.4);
    return material;
  }

  /** Two runs of ceiling strip lights, receding into the dark. */
  private static buildStripLights(): Group {
    const group = new Group();
    const material = new MeshStandardNodeMaterial();
    material.colorNode = color(0x0b0f13);
    material.emissiveNode = color(0xdfefff).mul(oneMinus(uv().y.sub(0.5).abs().mul(2)).mul(3.2));
    for (let i = 0; i < 8; i++) {
      for (const side of [-1, 1]) {
        const strip = new Mesh(new PlaneGeometry(0.55, 13), material);
        strip.position.set(side * 11, 9.5, -6 - i * 7);
        strip.rotation.x = Math.PI / 2;
        group.add(strip);
      }
    }
    return group;
  }
}

/** Convenience for building a flat backing panel in overlay space. */
export function overlayPanel(width: number, height: number, hex = 0x05080b, alpha = 0.4): Mesh {
  const mesh = new Mesh(new PlaneGeometry(width, height), panelMaterial(hex, alpha));
  mesh.renderOrder = 0;
  return mesh;
}
