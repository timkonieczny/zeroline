import type { Camera, Scene } from 'three';
import {
  ACESFilmicToneMapping,
  NoToneMapping,
  PostProcessing,
  SRGBColorSpace,
  type Node,
  type WebGPURenderer,
} from 'three/webgpu';
import {
  convertToTexture,
  float,
  mix,
  mrt,
  output,
  pass,
  renderOutput,
  uniform,
  vec2,
  vec3,
  velocity,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { motionBlur } from 'three/addons/tsl/display/MotionBlur.js';
import { lensflare } from 'three/addons/tsl/display/LensflareNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { chromaticAberration } from 'three/addons/tsl/display/ChromaticAberrationNode.js';
import { radialBlur } from 'three/addons/tsl/display/radialBlur.js';
import { clamp01 } from './math';

/** Linear luminance above which a pixel is treated as a light source. */
const BLOOM_THRESHOLD = 1.6;

export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';

/**
 * Which antialiasing to run, if any.
 *
 * `smaa` is the default rather than `traa`. Temporal antialiasing jitters the
 * projection every frame and resolves against a history buffer, which on this
 * game's content — thin white kerb stripes and barrier trim crossing the frame
 * at 500 km/h — reads as a permanently soft image, and its jitter lands in the
 * velocity buffer that the motion blur then smears along, so the blur wobbles
 * from frame to frame. SMAA is purely spatial: sharper, stable, and it leaves
 * the velocity buffer alone.
 */
export type AntialiasMode = 'none' | 'smaa' | 'traa';

export interface PostFXQuality {
  antialias: AntialiasMode;
  /** Velocity-buffer motion blur. */
  motionBlur: boolean;
  /** Samples the motion blur takes along the velocity vector. */
  motionBlurSamples: number;
  /** Ghosts and streaks pivoted around the centre from every bright spot. */
  lensflare: boolean;
  /** Ground-truth ambient occlusion: contact darkening where surfaces meet. */
  gtao: boolean;
  /** Speed-driven radial streaks and chromatic fringing. */
  speedEffects: boolean;
  bloomStrength: number;
}

export const QUALITY_PRESETS: Record<QualityLevel, PostFXQuality> = {
  low: { antialias: 'none', motionBlur: false, motionBlurSamples: 8, speedEffects: false, bloomStrength: 0.2, lensflare: false, gtao: false },
  medium: { antialias: 'smaa', motionBlur: true, motionBlurSamples: 10, speedEffects: true, bloomStrength: 0.26, lensflare: true, gtao: false },
  high: { antialias: 'smaa', motionBlur: true, motionBlurSamples: 16, speedEffects: true, bloomStrength: 0.32, lensflare: true, gtao: true },
  ultra: { antialias: 'smaa', motionBlur: true, motionBlurSamples: 24, speedEffects: true, bloomStrength: 0.36, lensflare: true, gtao: true },
};

/**
 * Frame time the motion blur is calibrated for, in seconds.
 *
 * The velocity buffer holds motion *since the last rendered frame*, so its
 * length scales with frame time: at 30 fps every smear is twice as long as at
 * 60, and an uneven frame rate makes the blur pulse. Normalising against a
 * fixed reference turns it into a shutter angle — blur length then tracks
 * speed, which is what it is supposed to communicate, and nothing else.
 */
const BLUR_REFERENCE_FRAME = 1 / 60;
/** Hard cap on the normalising factor, so one long frame cannot smear the world. */
/**
 * What the exposure climbs to inside a tunnel.
 *
 * Enough to lift the strip lights and the road under them out of the gloom, and
 * enough that daylight on the way out is well past the bloom threshold. Higher
 * and the tunnel stops being dark at all, which costs the exit its contrast.
 */
const TUNNEL_EXPOSURE = 2.15;
/** How fast the eye opens up in the dark, and closes again in the light. */
const ADAPT_TO_DARK = 1.1;
const ADAPT_TO_LIGHT = 2.4;

/**
 * Radius the occlusion is gathered over, in metres.
 *
 * Wide. Tried at two metres first, which is the usual advice and is meant for
 * rooms: on a thirty-metre road under an open sky it darkened a hairline at the
 * foot of each barrier and nothing else. At fourteen it reads as sky occlusion
 * rather than contact shading — the road along the barriers, the underside of
 * the elevated sections, one building against the next — which is the half of a
 * bake's look that is worth having outdoors.
 */
const GTAO_RADIUS = 14;
/** Half resolution. The term is low frequency and the upsample is free. */
const GTAO_SCALE = 0.5;
/**
 * Samples per pixel. Twice the node's default.
 *
 * At sixteen the term carries a visible crosshatch grain over flat road, which
 * on white concrete is worse than the occlusion is good. Thirty-two clears it
 * without a denoise pass, which would have cost another dependent full-screen
 * read to fix something the sample count fixes directly.
 */
const GTAO_SAMPLES = 32;

const BLUR_SCALE_MAX = 1.6;

/**
 * The post chain, and the only place the game's sense of speed actually comes
 * from.
 *
 * The scene pass writes colour and a velocity buffer in one go via MRT, which
 * is what makes both the motion blur and the temporal antialiasing possible
 * without re-rendering anything. Everything after that is a graph of TSL nodes
 * compiled once at startup:
 *
 *   scene -> antialias -> motion blur -> radial streaks -> + bloom -> aberration
 *
 * Three uniforms are driven every frame from the player's craft — speed, boost
 * and impact — so the picture reacts to the driving rather than sitting at a
 * fixed intensity. At a standstill the chain is nearly invisible; flat out in
 * RAPIER class with a boost lit, the frame tears forward.
 */
export class PostFX {
  private readonly post: PostProcessing;

  /** 0..1 fraction of top speed. */
  private readonly speed = uniform(0);
  /** 1 while boosting, eased. */
  private readonly boost = uniform(0);
  private readonly aberrationStrength = uniform(0);
  private readonly radialAmount = uniform(0);
  private readonly bloomStrength = uniform(0.65);
  /**
   * How much of the lens flare is mixed in.
   *
   * Low. It is added on top of a frame that already has bloom in it, and the
   * ghosts land on white concrete, where anything stronger reads as a smear on
   * the road rather than as an artefact of the lens.
   */
  private readonly flareStrength = uniform(0.32);
  /** How much of the occlusion term is applied. */
  private readonly aoStrength = uniform(0.62);
  /** Scene exposure, eased by `setDrive` to stand in for the eye adapting. */
  private readonly exposure = uniform(1);
  private smoothedExposure = 1;

  /** Normalises the velocity buffer against a fixed reference frame time. */
  private readonly blurScale = uniform(1);
  private smoothedBlurScale = 1;

  private smoothedSpeed = 0;
  private smoothedBoost = 0;

  constructor(
    renderer: WebGPURenderer,
    scene: Scene,
    camera: Camera,
    quality: PostFXQuality = QUALITY_PRESETS.high,
    overlay?: { scene: Scene; camera: Camera },
  ) {
    this.post = new PostProcessing(renderer);
    this.bloomStrength.value = quality.bloomStrength;

    const scenePass = pass(scene, camera);
    // One geometry pass, two targets: shaded colour and screen-space motion.
    scenePass.setMRT(mrt({ output, velocity }));

    const colour = scenePass.getTextureNode('output');
    const velocityTexture = scenePass.getTextureNode('velocity');
    const depthTexture = scenePass.getTextureNode('depth');

    // The addon nodes each return their own subclass; the chain only ever cares
    // that the value is a vec4, so it is normalised to that as it is threaded
    // through. `asColour` exists purely to keep the pipeline readable.
    const asColour = (value: unknown): Node<'vec4'> => value as Node<'vec4'>;

    let node = asColour(colour);
    if (quality.antialias === 'traa') node = asColour(traa(colour, depthTexture, velocityTexture, camera));
    else if (quality.antialias === 'smaa') node = asColour(smaa(colour));

    if (quality.gtao) {
      // Ground-truth ambient occlusion, from depth alone.
      //
      // The node will take a normal target if the scene pass writes one, and
      // reconstructs normals from depth when it does not. A third full-screen
      // attachment written every frame is real bandwidth on an integrated GPU —
      // which is the part of this frame that is actually scarce — so it starts
      // without one. If the road's grazing angles turn out to need real
      // normals, the fix is `normal: normalView` in the MRT above and passing
      // the texture in here.
      // The node's own documentation says normals may be omitted and the
      // shader will reconstruct them from depth. Only its type declaration
      // disagrees, so the null goes in through a cast rather than the
      // decision being made by a `.d.ts`.
      const withoutNormals = null as unknown as Parameters<typeof ao>[1];
      const occlusion = ao(depthTexture, withoutNormals, camera);
      occlusion.resolutionScale = GTAO_SCALE;
      occlusion.radius.value = GTAO_RADIUS;
      occlusion.samples.value = GTAO_SAMPLES;

      // Mixed toward 1 rather than multiplied outright. Occlusion belongs on
      // indirect light, and a post pass has only the finished colour, so a raw
      // multiply darkens direct sunlight too — which on white concrete reads as
      // dirt rather than as shade. The scene's indirect is one hemisphere fill,
      // so a partial term is a fair approximation of darkening that and leaving
      // the sun alone.
      node = asColour(node.mul(mix(float(1), occlusion.getTextureNode().r, this.aoStrength)));
    }

    // Exposure goes here: after the antialiasing, which both branches feed from
    // the raw scene texture, and before everything that reacts to brightness.
    //
    // It was above the antialiasing to begin with, which meant SMAA — the
    // default — overwrote it with the unexposed image and the adaptation never
    // reached the frame at all. That is the whole mechanism behind a tunnel
    // exit: the exposure the eye settled on in the dark is far too much for
    // daylight, so half the frame lands over the bloom threshold for a second
    // and blows out.
    node = asColour(node.mul(this.exposure));

    // Motion blur runs before bloom, and on a resolved texture. Several of the
    // addon nodes sample their input directly, so anything handed to them has to
    // be a texture rather than an arbitrary expression — `convertToTexture`
    // resolves the chain so far into one.
    if (quality.motionBlur) {
      // `.xy` explicitly: the velocity target is a vec4 and the blur adds the
      // offset to a vec2 UV.
      const motion = velocityTexture.xy.mul(this.blurScale);
      node = asColour(motionBlur(convertToTexture(node), motion, float(quality.motionBlurSamples)));
    }

    if (quality.speedEffects) {
      // Streaks pull outward from the centre of the screen, so they read as
      // forward motion rather than as a camera shake.
      const streaks = asColour(
        radialBlur(convertToTexture(node), {
          center: vec2(0.5, 0.5),
          weight: float(0.55),
          decay: float(0.94),
          count: float(12),
          exposure: float(1),
        }),
      );
      node = asColour(mix(node, streaks, this.radialAmount));
    }

    // Bloom is added rather than mixed: the emissive trim, the pad chevrons and
    // the thruster glow are already over 1.0, and adding keeps them reading as
    // light sources instead of washing the concrete out with them.
    // The scene pass is linear HDR, not tone-mapped, so the threshold has to sit
    // well above 1: sunlit white concrete is already brighter than that, and a
    // low threshold blooms the entire circuit into a white sheet.
    const glow = asColour(bloom(node, this.bloomStrength, 0.7, BLOOM_THRESHOLD));
    node = asColour(node.add(glow));

    if (quality.lensflare) {
      // Driven by the bloom rather than by a list of light sources, which is why
      // it costs nothing to have it apply to all of them at once: the sun, the
      // strip lights running a tunnel's ceiling, the showroom's overheads and a
      // craft's exhaust are all just bright spots by the time the chain gets
      // here. A flare rig that took a light's world position would have needed
      // one entry per lamp and would still have missed the exhausts.
      //
      // The threshold sits high on purpose. Everything about this circuit is
      // white in bright sun, and a low threshold puts ghosts around the road.
      node = asColour(
        node.add(
          asColour(
            lensflare(glow, {
              ghostTint: vec3(0.72, 0.86, 1),
              threshold: float(0.78),
              ghostSamples: float(3),
              ghostSpacing: float(0.32),
              ghostAttenuationFactor: float(26),
            }),
          ).mul(this.flareStrength),
        ),
      );
    }

    if (quality.speedEffects) {
      // The centre must be given explicitly: the addon defaults it to null and
      // then tries to compile that as a shader input.
      node = asColour(chromaticAberration(node, this.aberrationStrength, vec2(0.5, 0.5), float(1.06)));
    }

    if (overlay) {
      // The HUD is composited here rather than drawn in a second render call:
      // on WebGPU a second pass to the canvas begins with its own clear, which
      // wipes the frame the post chain just produced. Bringing it in as a pass
      // also keeps it out of the blur, which is the point of a separate layer.
      // The overlay scene has no background, so its pass clears to the
      // renderer's clear colour — which `Renderer` sets to fully transparent
      // precisely so this composite works.
      //
      // Tone mapping is applied by hand here, to the scene only, and the
      // composite happens after it. Left to the pipeline it ran over the
      // finished frame including the interface, and ACES does to a saturated
      // interface colour exactly what it is designed to do to a saturated
      // highlight: desaturates it and rolls it off. The shield bar was authored
      // as a bright cyan and arrived on screen as a muddy teal. White text
      // survives it unharmed, which is why this went unnoticed for so long.
      const overlayPass = pass(overlay.scene, overlay.camera);
      const hudColour = overlayPass.getTextureNode('output');

      const scene = asColour(renderOutput(node, ACESFilmicToneMapping, SRGBColorSpace));
      const hud = asColour(renderOutput(hudColour, NoToneMapping, SRGBColorSpace));
      node = asColour(mix(scene, hud, hudColour.a));
      this.post.outputColorTransform = false;
    }

    this.post.outputNode = node;
  }

  /**
   * Feeds this frame's driving state into the chain.
   *
   * The inputs are smoothed here rather than at the call site because the sim
   * ticks faster than the display: an unsmoothed boost flag would make the
   * effects flicker on and off between frames.
   */
  /**
   * @param enclosed True while the camera is inside a tunnel.
   *
   * There is no luminance pass behind this and there does not need to be: the
   * simulation already knows exactly when the player is under cover, which is
   * both cheaper than measuring the frame and, unlike measuring it,
   * deterministic — a replay adapts at the same rate as the race it recorded.
   */
  setDrive(speedFraction: number, boosting: boolean, dt: number, enclosed = false): void {
    // Keep the smear a fixed shutter rather than a fixed number of frames, and
    // ease it so a single long frame does not produce a visible lurch.
    const target = Math.min(BLUR_SCALE_MAX, BLUR_REFERENCE_FRAME / Math.max(dt, 1e-4));
    this.smoothedBlurScale += (target - this.smoothedBlurScale) * (1 - Math.exp(-dt * 8));
    this.blurScale.value = this.smoothedBlurScale;

    const k = 1 - Math.exp(-dt * 6);
    this.smoothedSpeed += (clamp01(speedFraction) - this.smoothedSpeed) * k;
    this.smoothedBoost += ((boosting ? 1 : 0) - this.smoothedBoost) * (1 - Math.exp(-dt * 9));

    this.speed.value = this.smoothedSpeed;
    this.boost.value = this.smoothedBoost;

    // Dark adaptation is slow and light adaptation is quick, the way an eye
    // actually works. Entering a tunnel, the picture lifts over about a second;
    // leaving one, the world arrives already over-exposed and recovers in
    // rather less — which is the moment the whole effect exists for.
    const targetExposure = enclosed ? TUNNEL_EXPOSURE : 1;
    const adaptRate = enclosed ? ADAPT_TO_DARK : ADAPT_TO_LIGHT;
    this.smoothedExposure += (targetExposure - this.smoothedExposure) * (1 - Math.exp(-dt * adaptRate));
    this.exposure.value = this.smoothedExposure;

    // Both effects stay at zero until well past half speed, so normal driving
    // is clean and only the top of the range feels dangerous.
    const intensity = clamp01((this.smoothedSpeed - 0.55) / 0.45);
    this.aberrationStrength.value = intensity * 0.0022 + this.smoothedBoost * 0.004;
    this.radialAmount.value = intensity * 0.22 + this.smoothedBoost * 0.34;
  }

  render(): void {
    this.post.render();
  }

  dispose(): void {
    this.post.dispose();
  }
}
