import { Vector3 } from 'three';

const _forward = new Vector3();
const _right = new Vector3();
const _up = new Vector3();

/** Fallback axis for the degenerate case of a sun directly overhead. */
const _aside = new Vector3(1, 0, 0);

/**
 * Quantises a shadow frustum's centre to whole shadow-map texels.
 *
 * A directional shadow map is a grid pinned to the light, and the frustum here
 * is refitted around the player every frame. Slide it by a fraction of a texel
 * and every depth sample lands somewhere slightly different than it did last
 * frame, so every shadow edge crawls against the geometry it belongs to. The
 * fix is as old as the problem: move the frustum in whole texels only.
 *
 * The quantisation has to happen in the light's own basis, and it has to be the
 * same basis three builds the shadow camera from, or it is snapping to a grid
 * that is not the one being sampled. `Matrix4.lookAt(eye, target, up)` — which
 * is what the shadow camera ends up using — takes
 *
 *     z = normalize(eye − target)      (here, the direction the sun shines from)
 *     x = normalize(cross(up, z))
 *     y = cross(z, x)
 *
 * so those are the axes rounded along. The component along `z` is left alone:
 * depth into the light does not move the texel grid, and rounding it would only
 * shift the near and far planes for nothing.
 *
 * @param focus Where the frustum wants to be centred.
 * @param sunDirection Unit vector pointing from the target toward the sun.
 * @param cameraUp The shadow camera's up axis. Three defaults it to +Y.
 * @param texel World size of one shadow-map texel, in metres.
 * @param out Receives the snapped centre. May be `focus`.
 */
export function snapToShadowTexels(
  focus: Vector3,
  sunDirection: Vector3,
  cameraUp: Vector3,
  texel: number,
  out: Vector3,
): Vector3 {
  _forward.copy(sunDirection).normalize();
  _right.crossVectors(cameraUp, _forward);

  // A sun exactly overhead leaves the cross product with no length and no
  // direction to snap along. Any perpendicular axis will do — the grid is
  // arbitrary in that case, it just has to be consistent between frames.
  if (_right.lengthSq() < 1e-8) _right.crossVectors(_aside, _forward);
  _right.normalize();
  _up.crossVectors(_forward, _right).normalize();

  const across = focus.dot(_right);
  const along = focus.dot(_up);

  out.copy(focus)
    .addScaledVector(_right, Math.round(across / texel) * texel - across)
    .addScaledVector(_up, Math.round(along / texel) * texel - along);

  return out;
}

/** World size of one texel, for a square orthographic shadow of this extent. */
export function shadowTexelSize(halfExtent: number, mapSize: number): number {
  return (halfExtent * 2) / mapSize;
}
