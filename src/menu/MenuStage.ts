import {
  BackSide,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Fog,
  Group,
  DoubleSide,
  Mesh,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SphereGeometry,
  SpotLight,
  Vector3,
  type Texture,
} from 'three';
import { MeshStandardNodeMaterial, PMREMGenerator, type WebGPURenderer } from 'three/webgpu';
import {
  color,
  float,
  fract,
  mix,
  mul,
  normalMap,
  oneMinus,
  positionLocal,
  reflector,
  smoothstep,
  texture,
  time,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { createFloorSurface } from './FloorSurface';
import { GarageProps } from './GarageProps';
import { buildWordmark3D } from './Wordmark3D';
import { LIGHT_UI } from '@/ui/Palette';
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
const UI = LIGHT_UI;

/** The garage's walls and haze. */
const ROOM_WHITE = 0xeef3f7;
/**
 * Interior size of the bay, in metres.
 *
 * Wider and deeper than the plinth needs, and pushed left of it: the type is
 * set flush left, and the camera looks that way. At the first size the frame
 * ran off the end of the left-hand wall and the room stopped being a room.
 */
const ROOM_WIDTH = 84;
const ROOM_DEPTH = 74;
const ROOM_HEIGHT = 15;
/** Centre of the room's plan, offset from the plinth. */
const ROOM_X = 9 - 14;
const ROOM_Z = -ROOM_DEPTH / 2 + 12;
/** Where the back wall stands, and what the logo is mounted on. */
const BACK_WALL_Z = ROOM_Z - ROOM_DEPTH / 2;
/** Padding between a ceiling strip's ends and the walls. */
const STRIP_PADDING = 5;
/** Ceiling strips, laid diagonally across the bay. */
const STRIP_COUNT = 4;
/** Strip width in metres. Half what the old overhead runs were. */
const STRIP_WIDTH = 1.2;
/**
 * How much of the floor is mirror at the plinth, dry and wet. Both fall off
 * with distance: a mirror running to the horizon reads as a bug.
 */
const FLOOR_MIRROR_DRY = 0.3;
const FLOOR_MIRROR_WET = 0.75;
/** How many times the floor's surface map repeats across the plane. */
const FLOOR_TILING = 26;
/** How much larger the puddles are than the tiles. */
const PUDDLE_SCALE = 5.5;

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
  title: { position: [13, 4.6, 21], look: [-9, 2.4, 0], fov: 32 },
  main: { position: [10, 3.8, 18], look: [-6.5, 2.2, 0], fov: 34 },
  track: { position: [9, 7.0, 17], look: [-6.5, 1.8, 0], fov: 36 },
  // Further back and less biased than the others: this is the only screen
  // where the whole hull has to fit, and it was running off the right edge.
  craft: { position: [5.5, 3.6, 31], look: [-4.5, 2.3, 0], fov: 25 },
  class: { position: [7, 3.4, 17], look: [-5.6, 2.3, 0], fov: 32 },
  controls: { position: [11, 4.0, 19], look: [-6.5, 2.3, 0], fov: 36 },
  settings: { position: [11, 5.6, 19], look: [-6.5, 2.6, 0], fov: 36 },
};

const TRACKS: readonly TrackDefinition[] = [meridianCoast];

/** Radians either side of the station the idle orbit swings through. */
const PAN_ANGLE = 0.085;
/** Radians per second of that swing. One full cycle takes about half a minute. */
const PAN_RATE = 0.21;
/** Metres the camera rises and falls across the swing. */
const PAN_RISE = 0.16;

const WORLD_UP = new Vector3(0, 1, 0);
const _from = new Vector3();
const _to = new Vector3();
/**
 * How long a line at the given perpendicular offset is inside the ceiling.
 *
 * The ceiling is a rectangle and the strips run across it at an angle, so the
 * span available shrinks as a strip moves out towards a corner.
 */
function chordLength(offset: number, angle: number): number {
  const dirX = Math.cos(angle);
  const dirZ = -Math.sin(angle);
  // A point on the line, offset perpendicular to it from the ceiling's centre.
  const baseX = -dirZ * offset;
  const baseZ = dirX * offset;

  let enter = -Infinity;
  let exit = Infinity;
  const slab = (position: number, direction: number, half: number): boolean => {
    if (Math.abs(direction) < 1e-6) return Math.abs(position) <= half;
    const a = (-half - position) / direction;
    const b = (half - position) / direction;
    enter = Math.max(enter, Math.min(a, b));
    exit = Math.min(exit, Math.max(a, b));
    return true;
  };
  if (!slab(baseX, dirX, ROOM_WIDTH / 2)) return 0;
  if (!slab(baseZ, dirZ, ROOM_DEPTH / 2)) return 0;
  return Math.max(0, exit - enter);
}

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
  /** Planar reflection of the room, mixed into the floor. */
  private readonly mirror: ReturnType<typeof reflector>;
  /** Normal map plus puddle mask for the floor. */
  private readonly floorSurface: Texture;
  private readonly props: GarageProps;
  /** Image-based lighting probe, so the craft has something to reflect. */
  private environmentMap: Texture | null = null;
  private readonly craftHolder = new Group();
  private craftModel: GliderModel | null = null;
  private craftSpin = 0;
  /** Counts down while a newly selected craft spins into place. */
  private craftSwapTimer = 0;

  private readonly panels = new Map<MenuScreen, Group>();
  private readonly lists = new Map<MenuScreen, ListMenu>();
  private settingsList: OptionList | null = null;

  /** Pushes a rebuilt settings row into the list, for any whose choices are not fixed. */
  updateSettingRow(row: OptionRow): void {
    this.settingsList?.setRow(row);
  }

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
  /** Phase of the idle camera orbit. */
  private panPhase = 0;

  constructor(pixelRatio: number, private readonly settingRows: readonly OptionRow[] = []) {
    this.pixelRatio = pixelRatio;

    // --- Showroom -------------------------------------------------------
    // Linear fog to white rather than exponential to black: the room has no
    // far wall, and everything simply dissolves into the light.
    this.scene.fog = new Fog(ROOM_WHITE, 60, 210);

    // A real room now: glossy white walls and ceiling, closed at the back.
    // The graded dome behind it still does the work of separating a white
    // craft from a white set — a closed box alone gives the hull no edge.
    const backdrop = new Mesh(new SphereGeometry(220, 32, 20), MenuStage.backdropMaterial());
    backdrop.frustumCulled = false;
    this.scene.add(backdrop);
    this.scene.add(MenuStage.buildRoom());

    // A planar reflection of the whole scene, which is what puts the craft
    // back on the floor underneath itself. Half resolution: it is a soft,
    // heavily tinted reflection and nobody will count its pixels.
    this.mirror = reflector({ resolutionScale: 0.5 });
    this.mirror.target.rotateX(-Math.PI / 2);
    this.scene.add(this.mirror.target);

    this.floorSurface = createFloorSurface();
    const floor = new Mesh(new PlaneGeometry(400, 400), this.floorMaterial(this.mirror));
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

    // A hard key for the shadow under the craft, and a broad directional
    // fill so nothing on a white set falls into darkness.
    // Softer than it was on the open set: white walls bounce most of it back.
    const key = new SpotLight(0xffffff, 620, 90, 0.62, 0.55, 1.4);
    // Behind the plinth rather than on the camera's side of it: a polished
    // podium mirrors a key light straight down the lens, and the hotspot was
    // blooming out everything under the craft.
    key.position.copy(PLINTH).add(new Vector3(9, 16, -7));
    key.target.position.copy(PLINTH).setY(2);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0008;

    const fill = new DirectionalLight(0xffffff, 0.85);
    fill.position.copy(PLINTH).add(new Vector3(-9, 7, 12));

    const back = new DirectionalLight(new Color(UI.accent), 0.55);
    back.position.copy(PLINTH).add(new Vector3(-8, 5, -12));

    this.props = new GarageProps(PLINTH);
    this.scene.add(floor, this.plinth, key, key.target, fill, back);
    this.scene.add(MenuStage.buildSoftboxes(), this.props.group);

    // --- Overlay --------------------------------------------------------
    const t = (
      text: string,
      size: number,
      tracking: number,
      align: 'left' | 'right' | 'centre',
      italic = false,
    ) => new TextMesh(text, { size, tracking, align, italic }, pixelRatio);

    this.wordmark = t('ZEROLINE', 96, 0.4, 'left', true);
    this.tagline = t('Anti-gravity racing league · Season 47', 13, 0.36, 'left');
    this.pressStart = t('Press Enter or A to begin', 14, 0.34, 'left');
    this.wordmark.setColour(UI.ink);
    this.tagline.setColour(UI.ink);
    // Dark grey like every other resting label. It pulses, which is what
    // draws the eye; colouring it as well only cost legibility.
    this.pressStart.setColour(UI.ink);

    this.breadcrumb = t('', 12, 0.4, 'left');
    this.breadcrumb.setColour(UI.ink);
    this.hint = t('', 11, 0.36, 'right');
    this.hint.setColour(UI.ink);

    this.craftName = t('', 36, 0.18, 'left', true);
    this.craftNation = new TextMesh('', { size: 12, tracking: 0.44, align: 'left', upper: true }, pixelRatio);
    this.craftBlurb = t('', 14, 0.04, 'left');
    this.craftName.setColour(UI.ink);
    this.craftNation.setColour(UI.ink);
    this.craftBlurb.setColour(UI.ink);

    this.trackTitle = t('', 42, 0.16, 'left', true);
    this.trackSubtitle = t('', 13, 0.4, 'left');
    this.trackFacts = t('', 14, 0.12, 'left');
    this.trackTitle.setColour(UI.ink);
    this.trackSubtitle.setColour(UI.ink);
    this.trackFacts.setColour(UI.ink);

    this.classBlurb = t('', 14, 0.04, 'left');
    this.classBlurb.setColour(UI.ink);

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
        { label: 'Race', detail: 'Eight craft · three laps' },
        { label: 'Time trial', detail: 'Solo · best lap' },
        { label: 'Settings', detail: 'Quality · audio' },
        { label: 'Controls', detail: 'Keyboard · gamepad' },
      ],
      { pixelRatio: this.pixelRatio, width: 480, palette: UI },
    );
    const mainPanel = new Group();
    mainPanel.add(mainList);
    this.lists.set('main', mainList);
    this.panels.set('main', mainPanel);

    const trackList = new ListMenu(
      TRACKS.map((track) => ({ label: track.name, detail: track.subtitle })),
      { pixelRatio: this.pixelRatio, width: 480, palette: UI },
    );
    const trackPanel = new Group();
    trackPanel.add(trackList, this.trackTitle, this.trackSubtitle, this.trackFacts);
    this.lists.set('track', trackList);
    this.panels.set('track', trackPanel);

    const craftList = new ListMenu(
      TEAMS.map((team) => ({ label: team.name, detail: team.nation })),
      { pixelRatio: this.pixelRatio, width: 420, palette: UI },
    );
    const craftPanel = new Group();
    craftPanel.add(craftList, this.craftName, this.craftNation, this.craftBlurb);
    for (const name of ['Speed', 'Thrust', 'Handling', 'Shield']) {
      const bar = new StatBar(name, { pixelRatio: this.pixelRatio, width: 210, palette: UI });
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
      { pixelRatio: this.pixelRatio, width: 480, palette: UI },
    );
    classList.select(2);
    const classPanel = new Group();
    classPanel.add(classList, this.classBlurb);
    this.lists.set('class', classList);
    this.panels.set('class', classPanel);

    const controlsPanel = new Group();
    const rows = [
      'Thrust                W  ·  right trigger',
      'Steer                 A D  ·  left stick',
      'Airbrakes             Q E  ·  bumpers',
      'Sideshift             double-tap an airbrake',
      'Barrel roll           double-tap, airborne',
      'Fire                  Space  ·  A',
      'Absorb weapon         Shift  ·  B',
      'Look back             C  ·  left trigger',
      'Hide results          Tab  ·  Y',
      'Pause                 Esc  ·  Start',
    ];
    rows.forEach((row, i) => {
      const line = new TextMesh(row, { size: 15, tracking: 0.12, align: 'left' }, this.pixelRatio);
      line.position.y = -i * 30;
      line.setColour(i % 2 === 0 ? UI.ink : UI.dim);
      controlsPanel.add(line);
    });
    this.panels.set('controls', controlsPanel);

    this.settingsList = new OptionList(this.settingRows, {
      pixelRatio: this.pixelRatio,
      width: 520,
      palette: UI,
    });
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
      main: 'Zeroline',
      track: 'Zeroline / Circuit',
      craft: 'Zeroline / Circuit / Craft',
      class: 'Zeroline / Circuit / Craft / Class',
      controls: 'Zeroline / Controls',
      settings: 'Zeroline / Settings',
    };
    this.breadcrumb.setText(trail[screen]);
    this.breadcrumb.visible = screen !== 'title';

    const hints: Record<MenuScreen, string> = {
      title: '',
      main: 'Enter select',
      track: 'Enter select   ·   Esc back',
      craft: 'Enter select   ·   Esc back',
      class: 'Enter start   ·   Esc back',
      controls: 'Esc back',
      settings: 'Left right adjust   ·   Esc back',
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

    if (action === 'back' || action === 'pause') {
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
      const laps = `${track.laps} lap${track.laps === 1 ? '' : 's'}`;
      this.trackFacts.setText(`${track.corners.length} corners · ${laps} · Sea level start`);
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

  /**
   * Builds the lighting probe. Needs a live renderer, so it cannot happen in
   * the constructor.
   */
  attachRenderer(renderer: WebGPURenderer): void {
    if (this.environmentMap) return;
    this.environmentMap = this.buildEnvironment(renderer);
    this.scene.environment = this.environmentMap;
    this.scene.environmentIntensity = 0.55;
  }

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

    // Above the horizon, where the wall is clean. Over the floor the tiles and
    // puddles compete with the type.
    this.wordmark.position.set(left, height * 0.74, 0);
    this.tagline.position.set(left + 6, height * 0.74 - 62, 0);
    this.pressStart.position.set(left + 6, height * 0.74 - 104, 0);

    const listTop = height * 0.66;
    for (const [screen, list] of this.lists) {
      list.position.set(left, listTop, 0);
      void screen;
    }

    // Track detail sits to the right of its list, and close enough to it that
    // the longest constructor blurb still fits on a 16:9 screen.
    const detailX = left + 470;
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

    // A very slow orbit around the subject, so the room has depth even when
    // nothing is being pressed. A sine has no turning point to notice: the
    // camera is always easing into or out of a direction change, never
    // arriving at one.
    this.panPhase += dt * PAN_RATE;
    const swing = Math.sin(this.panPhase) * PAN_ANGLE;
    _stationPosition.sub(_stationLook).applyAxisAngle(WORLD_UP, swing).add(_stationLook);
    _stationPosition.y += Math.sin(this.panPhase * 0.7) * PAN_RISE;

    this.camera.position.copy(_stationPosition);
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
    this.props.dispose();
    this.floorSurface.dispose();
    this.environmentMap?.dispose();
    this.craftModel?.dispose();
    this.settingsList?.dispose();
    for (const list of this.lists.values()) list.dispose();
    for (const bar of this.statBars) bar.dispose();
  }

  // --- Materials --------------------------------------------------------

  /**
   * Polished white floor with a faint grid and the room reflected in it.
   *
   * The reflection is mixed in rather than used as the colour, and it falls
   * away with distance from the plinth: a full mirror to the horizon reads as
   * a bug, and a showroom floor is polished, not wet.
   */
  private floorMaterial(mirror: ReturnType<typeof reflector>): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    const surface = this.floorSurface;

    // Tiled across a 400 m plane. Doubled in size from the first pass: at the
    // old scale the repeat was plainly visible as wallpaper.
    const tiled = uv().mul(FLOOR_TILING);
    const grid = uv().mul(40);
    const lineX = smoothstep(float(0.02), float(0), fract(grid.x).sub(0.5).abs().oneMinus().sub(0.985));
    const lineY = smoothstep(float(0.02), float(0), fract(grid.y).sub(0.5).abs().oneMinus().sub(0.985));
    const radius = uv().sub(0.5).length();
    const near = smoothstep(float(0.09), float(0.012), radius);

    // Blue channel of the surface map is the puddle mask: where it is wet the
    // floor is glass-smooth and mirrors the room, and where it is dry the
    // normal map's texture takes over. Coupling the two is what sells it —
    // a uniformly shiny floor reads as plastic, not as a washed garage.
    // Sampled at a far lower frequency than the tiles. Puddles are metres
    // across and tiles are not; taking both from the same repeat made the
    // water repeat every few metres and read as wallpaper.
    const wet = texture(surface, uv().mul(FLOOR_TILING / PUDDLE_SCALE)).b;

    material.normalNode = normalMap(texture(surface, tiled), vec2(0.7, 0.7));

    const dry = mix(
      color(0xd9e1e8),
      color(0xc3ced7),
      lineX.add(lineY).mul(smoothstep(float(0.2), float(0.01), radius)),
    );
    const base = mix(dry, color(0x9fb0bd), wet.mul(0.5));
    const mirrorAmount = mul(near, mix(float(FLOOR_MIRROR_DRY), float(FLOOR_MIRROR_WET), wet));
    material.colorNode = mix(base, mirror.rgb, mirrorAmount);
    material.roughnessNode = mix(float(0.42), float(0.04), wet);
    material.metalnessNode = float(0.12);
    return material;
  }

  private static plinthMaterial(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    // Polished enough to hold the strip lights and a smear of the craft above
    // it, via the studio probe.
    material.colorNode = color(0xb6c1cb);
    // Glossy, not a mirror. Once the room was closed in white, a near-perfect
    // plinth reflected the ceiling straight into the lens and bloomed half the
    // frame out.
    material.roughnessNode = float(0.22);
    material.metalnessNode = float(0.6);
    return material;
  }

  /** The lit ring around the plinth, chasing slowly. */
  private static ringMaterial(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    const chase = fract(uv().x.mul(3).sub(time.mul(0.18)));
    material.colorNode = color(0x9fb0bd);
    // Restrained on purpose. This ring sits under the bloom threshold's knee,
    // and an earlier, brighter version flooded the whole frame with cyan.
    material.emissiveNode = color(UI.accent).mul(smoothstep(float(0.55), float(0.05), chase)).mul(0.9);
    material.roughnessNode = float(0.4);
    return material;
  }

  /**
   * Overhead softboxes.
   *
   * These are the light sources the craft actually reflects — big, soft,
   * rectangular highlights sliding across the hull as it turns, which is what
   * a photographed car looks like and what an environment map alone cannot
   * give you. They are emissive geometry, so they show up in the floor's
   * reflection as well.
   */
  private static buildSoftboxes(): Group {
    const group = new Group();
    const material = new MeshStandardNodeMaterial();
    material.colorNode = color(0xffffff);
    // Brightest along the middle of the panel and softer at its edges.
    const across = oneMinus(uv().y.sub(0.5).abs().mul(2));
    material.emissiveNode = color(0xffffff).mul(smoothstep(float(0), float(0.45), across)).mul(2.2);
    material.fog = false;

    // Four runs laid diagonally across the bay, almost corner to corner. A
    // diagonal reads as a designed ceiling rather than as a corridor, and it
    // drags a long highlight across the hull as the camera pans.
    const angle = Math.atan2(ROOM_DEPTH, ROOM_WIDTH);
    for (let i = 0; i < STRIP_COUNT; i++) {
      // Spread perpendicular to the run, so the spacing is even on the ceiling
      // rather than even along one axis.
      const offset = (i - (STRIP_COUNT - 1) / 2) * (ROOM_WIDTH / STRIP_COUNT) * 1.5;
      // Each strip is cut to the chord it actually has. The outer two cross a
      // corner of the ceiling rather than the whole diagonal, and at one shared
      // length they ran straight out through the walls.
      const length = chordLength(offset, angle) - STRIP_PADDING * 2;
      if (length <= 1) continue;
      const panel = new Mesh(new PlaneGeometry(STRIP_WIDTH, length), material);
      panel.position.set(
        ROOM_X + Math.cos(angle) * offset,
        ROOM_HEIGHT - 0.35,
        ROOM_Z - Math.sin(angle) * offset,
      );
      panel.rotation.set(Math.PI / 2, 0, -angle);
      group.add(panel);
    }
    return group;
  }

  /**
   * The bay: floor-to-ceiling white, closed behind and to the sides.
   *
   * Drawn double-sided so the camera can sit outside a wall on the wider
   * stations without the room turning inside-out around it.
   */
  private static buildRoom(): Group {
    const group = new Group();
    const wall = new MeshStandardNodeMaterial();
    wall.colorNode = color(0xf1f5f8);
    wall.roughnessNode = float(0.16);
    wall.metalnessNode = float(0.06);
    wall.side = DoubleSide;

    const ceiling = new Mesh(new PlaneGeometry(ROOM_WIDTH, ROOM_DEPTH), wall);
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(ROOM_X, ROOM_HEIGHT, ROOM_Z);
    group.add(ceiling);

    const back = new Mesh(new PlaneGeometry(ROOM_WIDTH, ROOM_HEIGHT), wall);
    back.position.set(ROOM_X, ROOM_HEIGHT / 2, BACK_WALL_Z);
    group.add(back);

    for (const side of [-1, 1] as const) {
      const panel = new Mesh(new PlaneGeometry(ROOM_DEPTH, ROOM_HEIGHT), wall);
      panel.rotation.y = -side * Math.PI / 2;
      panel.position.set(ROOM_X + side * ROOM_WIDTH / 2, ROOM_HEIGHT / 2, ROOM_Z);
      group.add(panel);
    }

    group.add(MenuStage.buildWallLogo());
    return group;
  }

  /** ZEROLINE across the back wall, in relief. Blue for ZERO, ink for LINE. */
  private static buildWallLogo(): Group {
    const logo = buildWordmark3D({
      text: 'ZEROLINE',
      height: 4.5,
      depth: 0.7,
      split: 4,
      first: UI.accent,
      second: UI.ink,
    });
    // Sat on the wall's face, baseline above head height so the props along the
    // back of the bay never cut into it, and left of the room's centre: every
    // camera station looks left of the plinth, and centred on the wall the
    // wordmark ran off the right of frame.
    logo.position.set(ROOM_X - 17, 6.4, BACK_WALL_Z + 0.35);
    return logo;
  }

  /**
   * A studio probe for the craft to reflect.
   *
   * Built from its own throwaway scene rather than from the showroom, because
   * pre-filtering the showroom would bake the craft on the plinth into the
   * reflections of the craft on the plinth.
   */
  private buildEnvironment(renderer: WebGPURenderer): Texture {
    const studio = new Scene();

    const dome = new Mesh(new SphereGeometry(60, 24, 16), MenuStage.studioDomeMaterial());
    studio.add(dome);

    const boxMaterial = new MeshStandardNodeMaterial();
    boxMaterial.colorNode = vec3(0, 0, 0);
    boxMaterial.emissiveNode = color(0xffffff).mul(7);
    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2 + 0.4;
      const panel = new Mesh(new PlaneGeometry(16, 5), boxMaterial);
      panel.position.set(Math.cos(angle) * 20, 14, Math.sin(angle) * 20);
      panel.lookAt(0, 2, 0);
      studio.add(panel);
    }

    // The diagonal ceiling runs, so anything glossy carries them as long
    // streaks rather than as four anonymous blobs.
    const angle = Math.atan2(ROOM_DEPTH, ROOM_WIDTH);
    for (let i = 0; i < STRIP_COUNT; i++) {
      const offset = (i - (STRIP_COUNT - 1) / 2) * (ROOM_WIDTH / STRIP_COUNT) * 1.5;
      const strip = new Mesh(new PlaneGeometry(STRIP_WIDTH * 1.6, 70), boxMaterial);
      strip.position.set(Math.cos(angle) * offset, ROOM_HEIGHT - 0.35, -Math.sin(angle) * offset);
      strip.rotation.set(Math.PI / 2, 0, -angle);
      studio.add(strip);
    }

    const pmrem = new PMREMGenerator(renderer);
    const texture = pmrem.fromScene(studio, 0, 1, 120).texture;
    pmrem.dispose();
    dome.geometry.dispose();
    return texture;
  }

  /**
   * The room itself: bright ceiling, mid-grey at floor level.
   *
   * Drawn as an unlit dome rather than a background colour so there is a
   * gradient behind the craft. A flat white fill leaves a white craft with no
   * silhouette, which is exactly what the first version of this looked like.
   */
  private static backdropMaterial(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    const height = positionLocal.normalize().y;
    material.colorNode = vec3(0, 0, 0);
    material.emissiveNode = mix(
      color(0xb4c0ca),
      color(0xf6f9fb),
      smoothstep(float(-0.25), float(0.55), height),
    );
    material.side = BackSide;
    material.fog = false;
    return material;
  }

  /** Bright above, slightly grey below: a softbox tent. */
  private static studioDomeMaterial(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    const height = positionLocal.normalize().y;
    material.colorNode = vec3(0, 0, 0);
    material.emissiveNode = mix(color(0x9fadb8), color(0xffffff), smoothstep(float(-0.4), float(0.5), height));
    material.side = BackSide;
    return material;
  }
}

/** Convenience for building a flat backing panel in overlay space. */
export function overlayPanel(width: number, height: number, hex = 0x05080b, alpha = 0.4): Mesh {
  const mesh = new Mesh(new PlaneGeometry(width, height), panelMaterial(hex, alpha));
  mesh.renderOrder = 0;
  return mesh;
}
