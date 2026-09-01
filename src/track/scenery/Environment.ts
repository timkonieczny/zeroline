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
import { WaterMesh } from 'three/addons/objects/WaterMesh.js';
import { createWaterNormals, waterNormalsTexture } from './WaterNormals';
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial, PMREMGenerator, type WebGPURenderer } from 'three/webgpu';
import {
  atan,
  color,
  float,
  mix,
  normalize,
  positionLocal,
  pow,
  smoothstep,
  texture,
  vec2,
  vec3,
} from 'three/tsl';
import type { TrackDefinition } from '../TrackTypes';
import type { Track } from '../Track';
import { skyTexture } from './SkyTexture';
import { shadowTexelSize, snapToShadowTexels } from './ShadowSnap';

/** Radius of the sky dome. Must sit inside the camera's far plane. */
const SKY_RADIUS = 4200;
/** Height of the sea below the circuit's datum, in metres. */
export const SEA_LEVEL = -26;
/** Shadow map resolution per cascade. */
const SHADOW_SIZE = 2048;
/** Half-extent of the sun's shadow frustum around the player, in metres. */
const SHADOW_EXTENT = 190;
/**
 * World size of one shadow-map texel, in metres.
 *
 * 380 metres of frustum over 2048 texels: about nineteen centimetres, or five
 * and a half texels to the metre. The frustum only ever moves in whole
 * multiples of this.
 */
const SHADOW_TEXEL = shadowTexelSize(SHADOW_EXTENT, SHADOW_SIZE);

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
  readonly sea: WaterMesh;
  private readonly waterNormals: Texture;

  private readonly definition: TrackDefinition;
  private environmentMap: Texture | null = null;

  /**
   * @param waterNormals Bytes for the sea's normal map, if a worker has
   *   already generated them. They are half a megabyte of value noise and
   *   about a sixth of a load.
   */
  constructor(track: Track, waterNormals?: Uint8Array) {
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
    //
    // The fill is a washed-out version of the sky rather than the sky itself. A
    // saturated zenith makes a beautiful backdrop and a terrible bounce light:
    // taken literally it puts a blue cast on every white surface in the world,
    // and the circuit stops reading as white concrete.
    const fill = new Color(sky.zenith).lerp(new Color(0xffffff), 0.55);
    this.ambient = new HemisphereLight(fill, new Color(sky.ground), 1.0);

    // Always a mesh, painted or procedural.
    //
    // `scene.background` was cheaper and looked identical standing still, but a
    // background is drawn by its own pass and never writes to the velocity
    // buffer. Motion blur then smeared the sky along whatever geometry happened
    // to leave velocity in those pixels the frame before, which is why it
    // flickered and folded into itself through fast corners. A dome is ordinary
    // geometry: it writes velocity like everything else, and because it is
    // pinned to the camera that velocity is pure rotation, which is exactly what
    // a sky should contribute to the blur.
    const panorama = skyTexture();
    this.sky = new Mesh(
      new SphereGeometry(SKY_RADIUS, 48, 32),
      panorama ? Environment.panoramaMaterial(panorama) : Environment.skyMaterial(track.definition),
    );
    this.sky.name = 'sky';
    this.sky.frustumCulled = false;

    // Three's own ocean shader, fed a normal map generated at load rather
    // than a downloaded JPEG. It renders its own planar reflection, so the
    // resolution scale is kept low: the water is always far away and always
    // moving, and nobody is going to read its reflection for detail.
    this.waterNormals = waterNormals ? waterNormalsTexture(waterNormals) : createWaterNormals();
    this.sea = new WaterMesh(new PlaneGeometry(9000, 9000), {
      resolutionScale: 0.25,
      waterNormals: this.waterNormals,
      sunDirection: _sunDirection.clone(),
      sunColor: sun.colour,
      waterColor: 0x0d5f86,
      distortionScale: 6,
      size: 3.2,
    });
    this.sea.rotation.x = -Math.PI / 2;
    this.sea.position.y = SEA_LEVEL;
    this.sea.receiveShadow = false;
    this.sea.name = 'sea';

    this.group.add(this.sun, this.sun.target, this.ambient, this.sky, this.sea);
  }

  /**
   * Installs the environment into a scene.
   *
   * The sky is pre-filtered into an image-based lighting probe, which is what
   * stops every glossy surface — canopies, hull metal, the sea, the glass on the
   * skyline — from rendering as a black hole. Without a probe those materials
   * have nothing to reflect, and physically the correct answer is "nothing".
   *
   * The probe now comes from the painted panorama rather than from the gradient
   * dome, so reflections carry cloud shapes instead of a smooth wash. That is
   * the whole reason the panorama earns its place: a reflection is only worth
   * having if there is something in it to recognise.
   */
  applyTo(scene: Scene, renderer: WebGPURenderer): void {
    const { sky } = this.definition;
    const panorama = skyTexture();
    const pmrem = new PMREMGenerator(renderer);

    scene.fog = new FogExp2(new Color(sky.horizon), sky.fogDensity);
    scene.add(this.group);

    // Nothing is assigned to `scene.background`: the dome is the background, and
    // it is the only version of it that motion blur can see.
    scene.background = null;

    if (panorama) {
      this.environmentMap = pmrem.fromEquirectangular(panorama).texture;
      // A little stronger than the gradient probe was. That one was turned down
      // because a smooth blue wash on every white surface reads as a colour
      // cast; this one has structure, so it reads as a reflection.
      scene.environmentIntensity = 0.62;
    } else {
      const probeScene = new Scene();
      const probeSky = new Mesh(this.sky.geometry, this.sky.material);
      probeScene.add(probeSky);
      this.environmentMap = pmrem.fromScene(probeScene, 0, 1, SKY_RADIUS * 2).texture;
      probeScene.remove(probeSky);
      scene.environmentIntensity = 0.42;
    }

    pmrem.dispose();
    scene.environment = this.environmentMap;
  }

  /**
   * Re-centres the sky, the sea and the sun's shadow frustum on the camera.
   *
   * The sun is a directional light, so moving it changes nothing about the
   * lighting — only which slice of the world lands in the shadow map.
   */
  update(focus: Vector3): void {
    // The dome follows the camera in all three axes. Leaving it on the ground
    // plane gave it parallax as the circuit climbed, and parallax on a sky is
    // both wrong and a source of translation in the velocity buffer.
    this.sky.position.copy(focus);
    this.sea.position.set(focus.x, SEA_LEVEL, focus.z);
    // Snapped to whole texels. The frustum follows the player, and following
    // by fractions of a texel is what makes every shadow edge crawl: the depth
    // samples land somewhere slightly different each frame even where nothing
    // has moved. Nothing else uses this — the sun is directional, so where its
    // frustum sits changes which slice of the world is in the shadow map and
    // nothing about the lighting.
    snapToShadowTexels(focus, _sunDirection, this.sun.shadow.camera.up, SHADOW_TEXEL, _target);
    this.sun.target.position.copy(_target);
    this.sun.position.copy(_target).addScaledVector(_sunDirection, 600);
    this.sun.target.updateMatrixWorld();
  }

  /**
   * The painted sky, mapped onto the dome.
   *
   * Sampled by direction rather than by the sphere's own UVs, so the seam and
   * the pole pinching of the geometry cost nothing — the lookup is the same
   * equirectangular one the lighting probe uses, and the two therefore agree.
   */
  private static panoramaMaterial(panorama: Texture): MeshBasicNodeMaterial {
    const material = new MeshBasicNodeMaterial();
    const direction = normalize(positionLocal);
    // TSL's two-argument atan, which is atan2 under a shorter name.
    const u = atan(direction.z, direction.x).mul(1 / (Math.PI * 2)).add(0.5);
    // No flip on v: three uploads images with `flipY`, so v = 1 is the top of
    // the picture. Inverting it here put the panorama's plain lower half
    // overhead and hid every cloud in it.
    const v = direction.y.clamp(-1, 1).asin().mul(1 / Math.PI).add(0.5);

    // 8-bit sRGB against a linear HDR scene, so it arrives dimmer than the
    // sunlit geometry in front of it. Lifting it is a display decision.
    material.colorNode = texture(panorama, vec2(u, v)).rgb.mul(1.15);
    material.side = BackSide;
    material.fog = false;
    material.depthWrite = false;
    return material;
  }

  /** Direction the sun shines from, as a unit vector. */
  get sunDirection(): Vector3 {
    return _sunDirection;
  }

  dispose(): void {
    this.environmentMap?.dispose();
    this.waterNormals.dispose();
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

}
