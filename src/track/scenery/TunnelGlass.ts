import { DoubleSide, Group, Mesh, type BufferGeometry } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { abs, float, fract, max, min, mix, normalView, positionViewDirection, smoothstep, uv, vec3 } from 'three/tsl';
import { buildRibbon, type ProfilePoint } from '../TrackRibbon';
import { TUNNEL_RADIUS, TUNNEL_THICKNESS } from '../TrackGeometry';
import type { Track } from '../Track';

/**
 * Metres the pane hangs below the road.
 *
 * Far enough that the road's own sheet never fights it in the depth buffer,
 * close enough that the tube still reads as one object from outside.
 */
const DROP = 1.1;
/** Metres of arc length per glazing panel, and panels across the pane. */
const PANEL_LENGTH = 7;
const PANELS_ACROSS = 6;
/**
 * Width of a seam, as a fraction of a panel.
 *
 * Wider than a glazing bar really is. At a tenth of a metre it was physically
 * right and visually a hairline, which at any distance is not a frame but an
 * aliasing artefact — the pane read as wireframe rather than as glass.
 */
const SEAM = 0.035;

/** How much of the pane the road slab covers overhead, as a fraction of its half-width. */
const ROAD_SHARE = 0.78;

/** Opacity face-on and at a grazing angle. */
const CLEAR = 0.34;
const GRAZING = 0.82;

/**
 * The glass floor that closes a tunnel underneath the road.
 *
 * The tunnel is swept as a full tube but the road runs through the middle of
 * it, so from anywhere off the circuit — the establishing shot at the portal,
 * the run along the seawall opposite — the bore was an arch resting on nothing
 * with daylight under it. This is the pane that makes it a tube: laid across
 * the full outer width, a metre under the road, seamed into glazing panels.
 *
 * It is glass rather than more concrete because the circuit stands in the sea
 * and the one thing worth seeing under a tunnel is the water going past.
 */
export class TunnelGlass {
  readonly group = new Group();

  constructor(track: Track) {
    this.group.name = 'tunnel-glass';
    if (track.tunnels.length === 0) return;

    const pieces: BufferGeometry[] = [];
    const half = TUNNEL_RADIUS + TUNNEL_THICKNESS;

    for (const tunnel of track.tunnels) {
      const profile: ProfilePoint[] = [
        { anchor: 'centre', offset: -half, up: -DROP, u: 0 },
        { anchor: 'centre', offset: half, up: -DROP, u: 1 },
      ];
      pieces.push(
        buildRibbon(track, {
          profile,
          step: 3,
          vScale: PANEL_LENGTH,
          range: { fromS: tunnel.fromS, toS: tunnel.toS },
        }),
      );
    }

    const mesh = new Mesh(mergeGeometries(pieces, false)!, TunnelGlass.material());
    mesh.name = 'tunnel-floor';
    // Behind the ocean in the transparent pass: the water is what shows through
    // it, and a pane that wrote depth would cut the water out from under itself.
    mesh.renderOrder = 4;
    this.group.add(mesh);
  }

  dispose(): void {
    for (const object of this.group.children) {
      if (!(object instanceof Mesh)) continue;
      object.geometry.dispose();
      (object.material as { dispose(): void }).dispose();
    }
  }

  /**
   * Glass, and what it is holding up.
   *
   * Two things are happening. The pane is a dielectric at almost no roughness,
   * so the sky probe gives it a real specular reflection, and a Fresnel term
   * takes it from nearly clear face-on to nearly mirrored at a glancing angle —
   * which is the angle it is almost always seen from, sitting under a road.
   *
   * The second is the reflection of the structure above it, which is not a
   * reflection at all. What is overhead is a flat white slab of road in the
   * middle and the arch's flanks at the edges, and a mirror of a flat uniform
   * slab is that slab's colour: so it is drawn as a broad pale band across the
   * middle of the pane, softened at the edge where the road ends and the sky
   * takes back over, and scaled by the same Fresnel. Reflecting it honestly
   * would mean a second render of the whole scene per frame, which on this
   * circuit's budget buys nothing the band does not.
   */
  private static material(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();

    const coords = uv();
    // Seams: the glazing bars between panels, in both directions.
    const acrossSeam = TunnelGlass.seam(coords.x.mul(PANELS_ACROSS));
    const alongSeam = TunnelGlass.seam(coords.y);
    const bar = max(acrossSeam, alongSeam);

    // 1 face-on, 0 edge-on.
    const facing = normalView.dot(positionViewDirection).abs().clamp(0, 1);
    const fresnel = facing.oneMinus().pow(2.6);

    // How much of the road slab is overhead at this point across the pane.
    const fromCentre = abs(coords.x.sub(0.5)).mul(2);
    const underRoad = smoothstep(float(ROAD_SHARE), float(ROAD_SHARE - 0.16), fromCentre);

    const glass = vec3(0.42, 0.62, 0.68);
    const slab = vec3(0.86, 0.89, 0.9);
    const tinted = mix(glass, slab, underRoad.mul(fresnel).mul(0.75));

    material.colorNode = mix(tinted, vec3(0.14, 0.17, 0.19), bar);
    material.roughnessNode = mix(float(0.04), float(0.42), bar);
    material.metalnessNode = float(0);
    material.opacityNode = min(
      float(1),
      mix(float(CLEAR), float(GRAZING), fresnel).add(bar.mul(0.62)),
    );
    material.transparent = true;
    // The pane is seen from below as often as from above, and it is one sheet.
    material.side = DoubleSide;
    material.depthWrite = false;
    return material;
  }

  /** A dark line wherever `t` crosses a whole number. */
  private static seam(t: ReturnType<typeof uv>['x']): ReturnType<typeof uv>['x'] {
    const within = fract(t);
    return smoothstep(float(SEAM), float(0), min(within, within.oneMinus()));
  }
}
