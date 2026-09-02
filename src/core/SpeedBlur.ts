import { Fn, If, Loop, float, int, uv, vec2, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';

/** A resolved texture: the loop reads it directly, many times per pixel. */
type Samplable = Node<'vec4'> & { sample(coord: Node<'vec2'>): Node<'vec4'> };

/**
 * Below this much travel, in screen widths, the blur is skipped.
 *
 * Roughly a pixel across the frame — under which every tap would land in the
 * same texel and the loop would be an expensive way to copy a pixel.
 */
const SKIP_BELOW = 0.0006;

/**
 * Motion blur and speed streaks in one loop.
 *
 * They were two: three's `motionBlur` smearing along the velocity buffer, then
 * its `radialBlur` pulling a second set of samples toward the centre of the
 * screen. Both are plain TSL functions with no render targets of their own —
 * what made them two passes was the `convertToTexture` between them — and both
 * are directional blurs walking the same texture. So they are one walk now,
 * along the sum of the two directions: sixteen taps plus twelve, across two
 * full-screen passes with two resolves, becomes twelve taps in one.
 *
 * On the machine this was measured on, that pair was 42 of 115 milliseconds a
 * frame. The image differs only in how the streaks are weighted: three's radial
 * blur is a light-shaft function with an exposure and a decay curve, pressed
 * into service as a speed streak, and a linear weighting reads the same at
 * 400 km/h.
 */
export const speedBlur = /*@__PURE__*/ Fn(
  ([inputNode, velocity, streak, samples]: [Samplable, Node<'vec2'>, Node<'float'>, Node<'int'>]) => {
    const uvs = uv();
    const result = vec4(inputNode.sample(uvs)).toVar();

    // Outward from the centre of the screen, so the streaks read as forward
    // motion rather than as a camera shake.
    const radial = uvs.sub(vec2(0.5, 0.5)).mul(streak);
    const direction = velocity.add(radial).toVar();
    const count = float(samples);

    // Nothing to smear along: hold the base sample and skip the walk. The test
    // is on a vector built from two uniforms and a screen position, so whole
    // regions of the frame take the same branch — a standing start costs one
    // fetch instead of twelve, and so does every slow corner, where the streak
    // uniform is zero and the craft is barely moving on screen.
    If(direction.length().greaterThan(float(SKIP_BELOW)), () => {
      // Cleared first. The fetch above is the skip branch's answer, not a tap:
      // left in the sum it would be a `samples + 1`th sample divided by
      // `samples`, brightening the frame by a twelfth wherever the blur is
      // running and popping it as the branch flips at a slow corner exit.
      result.assign(vec4(0));

      Loop({ start: int(0), end: samples, type: 'int', condition: '<' }, ({ i }) => {
        // Centred on the pixel: `i` runs 0..samples-1, so `t` runs -0.5..0.5 and
        // half the taps trail while half lead, which keeps the blur on the
        // moving thing rather than only behind it. Starting at one instead
        // shifts every tap a step along the direction of travel.
        const t = float(i).div(count.sub(1)).sub(0.5);
        result.addAssign(inputNode.sample(uvs.add(direction.mul(t))));
      });

      result.divAssign(count);
    });

    return result;
  },
);
