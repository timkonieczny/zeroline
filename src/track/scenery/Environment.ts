import {
  BackSide,
  Color,
  DirectionalLight,
  FogExp2,
  Group,
  HemisphereLight,
  Mesh,
  PlaneGeometry,
  Scene,
  SphereGeometry,
  Vector3,
  type Texture,
} from 'three';
import { MeshStandardNodeMaterial, PMREMGenerator, type WebGPURenderer } from 'three/webgpu';
import { color, float, mix, normalize, positionLocal, pow, smoothstep, uv, vec3 } from 'three/tsl';
import type { TrackDefinition } from '../TrackTypes';
import type { Track } from '../Track';

/** Radius of the sky dome. Must sit inside the camera's far plane. */
const SKY_RADIUS = 4200;
/** Height of the sea below the circuit's datum, in metres. */
const SEA_LEVEL = -26;
/** Shadow map resolution per cascade. */
const SHADOW_SIZE = 2048;
/** Half-extent of the sun's shadow frustum around the player, in metres. */
const SHADOW_EXTENT = 190;

const _sunDirection = new Vector3();
const _target = new Vector3();

/**
 * Sky, sun and sea.
 *
 * One hard directional light does all the shaping — the Mirror's Edge look is a
 * single bright sun and almost no fill — with a hemisphere light standing in for
 * bounce. The shadow frustum is refitted around the player every frame rather
 * than being stretched over the whole circuit, which buys sharp contact shadows
 * from a single 2k map instead of a cascade rig.
 */
export class Environment {
  readonly group = new Group();
  readonly sun: DirectionalLight;
  readonly ambient: HemisphereLight;
  readonly sky: Mesh;
  readonly sea: Mesh;

  private readonly definition: TrackDefinition;
  private environmentMap: Texture | null = null;

  constructor(track: Track) {
    this.definition = track.definition;
    const { sun, sky } = track.definition;

    const azimuth = (sun.azimuth * Math.PI) / 180;
    const elevation = (sun.elevation * Math.PI) / 180;
    _sunDirection.set(
      Math.cos(elevation) * Math.cos(azimuth),
      Math.sin(elevation),
      Math.cos(elevation) * Math.sin(azimuth),
    );

    this.sun = new DirectionalLight(new Color(sun.colour), sun.intensity);
    this.sun.position.copy(_sunDirection).multiplyScalar(600);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_SIZE, SHADOW_SIZE);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 1400;
    this.sun.shadow.camera.left = -SHADOW_EXTENT;
    this.sun.shadow.camera.right = SHADOW_EXTENT;
    this.sun.shadow.camera.top = SHADOW_EXTENT;
    this.sun.shadow.camera.bottom = -SHADOW_EXTENT;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.05;

    // Fill only. The sun does the shaping; this stops surfaces facing away from
    // it from going to black, which is what an unlit barrier looked like.
    this.ambient = new HemisphereLight(new Color(sky.zenith), new Color(sky.ground), 0.75);

    this.sky = new Mesh(new SphereGeometry(SKY_RADIUS, 32, 20), Environment.skyMaterial(track.definition));
    this.sky.name = 'sky';
    this.sky.frustumCulled = false;

    this.sea = new Mesh(new PlaneGeometry(9000, 9000, 1, 1), Environment.seaMaterial(track.definition));
    this.sea.rotation.x = -Math.PI / 2;
    this.sea.position.y = SEA_LEVEL;
    this.sea.receiveShadow = false;
    this.sea.name = 'sea';

    this.group.add(this.sun, this.sun.target, this.ambient, this.sky, this.sea);
  }

  /**
   * Installs the environment into a scene.
   *
   * The sky dome is pre-filtered into an image-based lighting probe, which is
   * what stops every glossy surface — canopies, hull metal, the sea — from
   * rendering as a black hole. Without a probe those materials have nothing to
   * reflect, and physically the correct answer is "nothing".
   */
  applyTo(scene: Scene, renderer: WebGPURenderer): void {
    const { sky } = this.definition;
    scene.background = new Color(sky.horizon);
    scene.fog = new FogExp2(new Color(sky.horizon), sky.fogDensity);
    scene.add(this.group);

    const probeScene = new Scene();
    const probeSky = new Mesh(this.sky.geometry, this.sky.material);
    probeScene.add(probeSky);
    const pmrem = new PMREMGenerator(renderer);
    this.environmentMap = pmrem.fromScene(probeScene, 0, 1, SKY_RADIUS * 2).texture;
    pmrem.dispose();
    probeScene.remove(probeSky);

    scene.environment = this.environmentMap;
    scene.environmentIntensity = 0.6;
  }

  /**
   * Re-centres the sky, the sea and the sun's shadow frustum on the camera.
   *
   * The sun is a directional light, so moving it changes nothing about the
   * lighting — only which slice of the world lands in the shadow map.
   */
  update(focus: Vector3): void {
    this.sky.position.set(focus.x, 0, focus.z);
    this.sea.position.set(focus.x, SEA_LEVEL, focus.z);
    _target.copy(focus);
    this.sun.target.position.copy(_target);
    this.sun.position.copy(_target).addScaledVector(_sunDirection, 600);
    this.sun.target.updateMatrixWorld();
  }

  /** Direction the sun shines from, as a unit vector. */
  get sunDirection(): Vector3 {
    return _sunDirection;
  }

  dispose(): void {
    this.environmentMap?.dispose();
    this.sky.geometry.dispose();
    this.sea.geometry.dispose();
    (this.sky.material as { dispose(): void }).dispose();
    (this.sea.material as { dispose(): void }).dispose();
  }

  /** Vertical gradient with a hot band at the horizon, drawn on the inside of a dome. */
  private static skyMaterial(definition: TrackDefinition): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    const height = normalize(positionLocal).y;

    const horizon = color(definition.sky.horizon);
    const zenith = color(definition.sky.zenith);
    const ground = color(definition.sky.ground);

    const up = smoothstep(float(0), float(0.42), height);
    const down = smoothstep(float(0), float(-0.12), height);
    const dome = mix(horizon, zenith, pow(up, float(0.75)));

    material.colorNode = vec3(0, 0, 0);
    material.emissiveNode = mix(dome, ground, down);
    material.roughnessNode = float(1);
    material.side = BackSide;
    material.depthWrite = false;
    material.fog = false;
    return material;
  }

  /** Flat, bright, faintly banded water. It only ever appears in the distance. */
  private static seaMaterial(definition: TrackDefinition): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    const distance = uv().sub(0.5).length().mul(2);
    const deep = color(0x274a63);
    const far = color(definition.sky.horizon).mul(0.82);
    material.colorNode = mix(deep, far, smoothstep(float(0.03), float(0.5), distance));
    // Kept non-metallic on purpose: there is no environment map to reflect, and
    // a metal without one renders as a black hole where the sea should be.
    material.roughnessNode = float(0.2);
    material.metalnessNode = float(0.0);
    return material;
  }
}
