import { DoubleSide, Group, Mesh, type BufferGeometry } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { attribute, float, fract, max, min, mix, normalView, positionViewDirection, smoothstep, uv, vec3 } from 'three/tsl';
import { buildRibbon, type ProfilePoint } from '../TrackRibbon';
import { GLASS_MARGIN, TUNNEL_RADIUS, TUNNEL_SKIRT, TUNNEL_THICKNESS, glassSpans } from '../TrackGeometry';
import type { Track } from '../Track';

/**
 * Metres the pane hangs below the road.
 *
 * Derived from the shell's skirt rather than chosen, so the two cannot drift
 * apart: the pane's top sits this far above the foot of the walls, which is
 * what closes the section. Far enough below the road that its sheet never
 * fights the pane in the depth buffer.
 */
const OVERLAP = 0.35;
const DROP = TUNNEL_SKIRT - OVERLAP;
/**
 * How thick the pane is, in metres.
 *
 * The tunnel shell is swept as a shell rather than a sheet, for the reason its
 * own comment gives: at the portal you see its edge, and a sheet reads as a
 * cardboard cut-out there. The glass is seen edge-on far more often than the
 * shell is — it is the bottom of the tube — so it gets the same treatment.
 */
const THICKNESS = 0.55;
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
/** How much of a seam survives on the underside, where the bars are not. */
const UNDERSIDE_SEAM = 0.22;

/**
 * Metres the road-level panels sit below the surface around them.
 *
 * Just enough that the pane's top face never fights the concrete it is set
 * into for the depth buffer, and far too little to feel under a craft.
 */
const INSET = 0.02;
/** Width of the kerb strip, repeated from the road profile it is set into. */
const ROAD_KERB = 1.4;

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
 *
 * The same pane also lies in the road itself on the short low stretches
 * running down to the tunnel, where the swell is close enough under the
 * circuit to read. `buildRoad` cuts those holes from the same `glassSpans`
 * this fills, so the two cannot disagree about where the floor is.
 */
export class TunnelGlass {
  readonly group = new Group();

  constructor(track: Track) {
    this.group.name = 'tunnel-glass';

    const pieces: BufferGeometry[] = [];
    const half = TUNNEL_RADIUS + TUNNEL_THICKNESS;

    for (const tunnel of track.tunnels) {
      // A closed rectangle in section: across the top, down the far edge, back
      // across the underside, up the near edge and closed.
      //
      // `accent` marks which face a pixel is on. The glazing bars are fixed to
      // the top of the pane, and drawing them on the underside too put a second
      // grid half a metre below the first: seen through the glass at any angle
      // the two slide across each other and read as diagonals rather than as
      // structure.
      const profile: ProfilePoint[] = [
        { anchor: 'centre', offset: -half, up: -DROP, u: 0, accent: 1 },
        { anchor: 'centre', offset: half, up: -DROP, u: 1, accent: 1 },
        { anchor: 'centre', offset: half, up: -DROP - THICKNESS, u: 1, accent: 0 },
        { anchor: 'centre', offset: -half, up: -DROP - THICKNESS, u: 0, accent: 0 },
        { anchor: 'centre', offset: -half, up: -DROP, u: 0, accent: 1 },
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

    // The same pane, set into the road itself where the circuit runs low
    // enough over the water to be worth opening up. `buildRoad` cuts the hole
    // from the same spans, leaving a strip of concrete along each edge.
    for (const span of glassSpans(track)) {
      const edge = ROAD_KERB + GLASS_MARGIN;
      pieces.push(
        buildRibbon(track, {
          profile: [
            { anchor: 'left', offset: edge, up: -INSET, u: 0, accent: 1 },
            { anchor: 'right', offset: edge, up: -INSET, u: 1, accent: 1 },
            { anchor: 'right', offset: edge, up: -INSET - THICKNESS, u: 1, accent: 0 },
            { anchor: 'left', offset: edge, up: -INSET - THICKNESS, u: 0, accent: 0 },
            { anchor: 'left', offset: edge, up: -INSET, u: 0, accent: 1 },
          ],
          step: 3,
          vScale: PANEL_LENGTH,
          range: { fromS: span.fromS, toS: span.toS },
        }),
      );
    }

    if (pieces.length === 0) return;

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
   * Glass.
   *
   * A dielectric at almost no roughness, so the sky probe gives it a real
   * specular reflection, and a Fresnel term takes it from nearly clear face-on
   * to nearly mirrored at a glancing angle — which is the angle it is almost
   * always seen from, sitting under a road.
   *
   * It briefly also carried a pale band down the middle standing in for the
   * road slab reflected in it. That was an approximation of something a real
   * reflection would cost a second scene render to get, and at the sizes and
   * angles the pane is actually seen at it was invisible. Gone.
   */
  private static material(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();

    const coords = uv();
    // Seams: the glazing bars between panels, in both directions, and only
    // really on the face they are bolted to.
    const acrossSeam = TunnelGlass.seam(coords.x.mul(PANELS_ACROSS));
    const alongSeam = TunnelGlass.seam(coords.y);
    const onTop = attribute<'vec4'>('color', 'vec4').w;
    const bar = max(acrossSeam, alongSeam).mul(mix(float(UNDERSIDE_SEAM), float(1), onTop));

    // 1 face-on, 0 edge-on.
    const facing = normalView.dot(positionViewDirection).abs().clamp(0, 1);
    const fresnel = facing.oneMinus().pow(2.6);

    const glass = vec3(0.42, 0.62, 0.68);
    material.colorNode = mix(glass, vec3(0.14, 0.17, 0.19), bar);
    material.roughnessNode = mix(float(0.04), float(0.42), bar);
    material.metalnessNode = float(0);
    material.opacityNode = min(
      float(1),
      mix(float(CLEAR), float(GRAZING), fresnel).add(bar.mul(0.62)),
    );
    material.transparent = true;
    material.vertexColors = true;
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
