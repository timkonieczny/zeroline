import { BufferAttribute, BufferGeometry, DoubleSide, Group, Mesh, Vector3 } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  abs,
  attribute,
  clamp,
  color,
  cos,
  float,
  fract,
  max,
  min,
  mix,
  oneMinus,
  sin,
  smoothstep,
  step,
  time,
  uv,
  vec3,
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildRibbon, type ProfilePoint } from './TrackRibbon';
import type { ResolvedPad, Track } from './Track';
import { wrap } from '@/core/math';

/** Half-width of the tunnel bore, in metres. */
const TUNNEL_RADIUS = 19;
/** Rings around the bore. */
const TUNNEL_SEGMENTS = 14;
/** How thick the tunnel's walls are, in metres. */
const TUNNEL_THICKNESS = 2.4;

const _portal = new Vector3();

/** Height of the barrier above the road, in metres. */
const WALL_HEIGHT = 3.4;
/** How far the barrier leans away from the road over its height, in metres. */
const WALL_LEAN = 0.5;
/** Width of the kerb strip at each edge, in metres. */
const KERB_WIDTH = 1.4;
/** Height of the kerb lip, in metres. */
const KERB_RISE = 0.14;
/** Metres of arc length per V texture unit on the road. */
const ROAD_V_SCALE = 12;

/**
 * The visible circuit.
 *
 * All of it is swept from the same centreline the physics uses, and all of it is
 * shaded procedurally in TSL rather than from textures: painted lines stay
 * pin-sharp at any resolution, the emissive trim picks its colour up from the
 * district it runs through, and there is not a single image to download.
 *
 * The palette is deliberately Mirror's Edge — near-white concrete, one saturated
 * accent per district, almost nothing in between — because that is what makes
 * the bloom and the sun read at 500 km/h.
 */
export class TrackMesh {
  readonly group = new Group();
  readonly road: Mesh;
  readonly kerbs: Mesh;
  readonly walls: Mesh;
  readonly trim: Mesh;
  readonly boostPads: Mesh;
  readonly pickupPads: Mesh;
  readonly tunnels: Mesh | null;

  constructor(private readonly track: Track) {
    this.group.name = 'track';

    this.road = new Mesh(this.buildRoad(), TrackMesh.roadMaterial());
    this.road.receiveShadow = true;
    this.road.name = 'road';

    this.kerbs = new Mesh(this.buildKerbs(), TrackMesh.kerbMaterial());
    this.kerbs.receiveShadow = true;
    this.kerbs.name = 'kerbs';

    this.walls = new Mesh(this.buildWalls(), TrackMesh.wallMaterial());
    this.walls.receiveShadow = true;
    this.walls.castShadow = true;
    this.walls.name = 'walls';

    this.trim = new Mesh(this.buildTrim(), TrackMesh.trimMaterial());
    this.trim.name = 'trim';

    this.boostPads = new Mesh(this.buildPads(track.boostPads), TrackMesh.boostPadMaterial());
    this.boostPads.name = 'boost-pads';

    this.pickupPads = new Mesh(this.buildPads(track.pickupPads), TrackMesh.pickupPadMaterial());
    this.pickupPads.name = 'pickup-pads';

    const tunnelGeometry = this.buildTunnels();
    this.tunnels = tunnelGeometry ? new Mesh(tunnelGeometry, TrackMesh.tunnelMaterial()) : null;
    if (this.tunnels) {
      this.tunnels.name = 'tunnels';
      this.tunnels.castShadow = true;
      this.tunnels.receiveShadow = true;
    }

    this.group.add(this.road, this.kerbs, this.walls, this.trim, this.boostPads, this.pickupPads);
    if (this.tunnels) this.group.add(this.tunnels);
  }

  dispose(): void {
    this.group.traverse((object) => {
      if (object instanceof Mesh) {
        object.geometry.dispose();
        (object.material as { dispose(): void }).dispose();
      }
    });
  }

  // --- Geometry -----------------------------------------------------------

  private buildRoad(): BufferGeometry {
    const profile: ProfilePoint[] = [
      { anchor: 'left', offset: KERB_WIDTH, up: 0, u: -1 },
      { anchor: 'centre', offset: 0, up: 0, u: 0 },
      { anchor: 'right', offset: KERB_WIDTH, up: 0, u: 1 },
    ];
    return buildRibbon(this.track, { profile, step: 2, vScale: ROAD_V_SCALE, colourByDistrict: true });
  }

  private buildKerbs(): BufferGeometry {
    // Two strips, one per edge, with the middle quad skipped.
    const profile: ProfilePoint[] = [
      { anchor: 'left', offset: 0, up: KERB_RISE, u: 0 },
      { anchor: 'left', offset: KERB_WIDTH, up: 0, u: 1 },
      { anchor: 'right', offset: KERB_WIDTH, up: 0, u: 1 },
      { anchor: 'right', offset: 0, up: KERB_RISE, u: 0 },
    ];
    return buildRibbon(this.track, {
      profile,
      step: 2,
      vScale: 2.4,
      colourByDistrict: true,
      skipQuads: [1],
    });
  }

  private buildWalls(): BufferGeometry {
    const profile: ProfilePoint[] = [
      { anchor: 'left', offset: -WALL_LEAN, up: WALL_HEIGHT, u: 1, accent: 1 },
      { anchor: 'left', offset: 0, up: KERB_RISE, u: 0 },
      { anchor: 'right', offset: 0, up: KERB_RISE, u: 0 },
      { anchor: 'right', offset: -WALL_LEAN, up: WALL_HEIGHT, u: 1, accent: 1 },
    ];
    return buildRibbon(this.track, {
      profile,
      step: 2,
      vScale: 6,
      colourByDistrict: true,
      skipQuads: [1],
    });
  }

  /** The emissive band capping each barrier — the circuit's edge light. */
  private buildTrim(): BufferGeometry {
    const profile: ProfilePoint[] = [
      { anchor: 'left', offset: -WALL_LEAN - 0.25, up: WALL_HEIGHT + 0.22, u: 0, accent: 1 },
      { anchor: 'left', offset: -WALL_LEAN, up: WALL_HEIGHT, u: 1, accent: 1 },
      { anchor: 'right', offset: -WALL_LEAN, up: WALL_HEIGHT, u: 1, accent: 1 },
      { anchor: 'right', offset: -WALL_LEAN - 0.25, up: WALL_HEIGHT + 0.22, u: 0, accent: 1 },
    ];
    return buildRibbon(this.track, {
      profile,
      step: 2,
      vScale: 6,
      colourByDistrict: true,
      skipQuads: [1],
    });
  }

  private buildPads(pads: readonly ResolvedPad[]): BufferGeometry {
    const pieces = pads.map((pad) => {
      const profile: ProfilePoint[] = [
        { anchor: 'centre', offset: pad.lateral - pad.halfWidth, up: 0.02, u: 0 },
        { anchor: 'centre', offset: pad.lateral + pad.halfWidth, up: 0.02, u: 1 },
      ];
      return buildRibbon(this.track, {
        profile,
        step: 1.2,
        vScale: pad.halfLength * 2,
        range: { fromS: wrap(pad.s - pad.halfLength, this.track.length), toS: wrap(pad.s + pad.halfLength, this.track.length) },
      });
    });
    return pieces.length ? mergeGeometries(pieces, false)! : pieces[0]!;
  }

  /**
   * The tunnel shell, built as a shell rather than as a sheet.
   *
   * The cross-section runs up and over the inside of the arch, back down the
   * outside of a larger arch, and closes on itself, so the sweep produces
   * something with walls of an actual thickness. A single arch read as a
   * cardboard cut-out at the portals, which is where the tunnel is looked at
   * hardest — it is the one frame where you see its edge.
   */
  private buildTunnels(): BufferGeometry | null {
    if (this.track.tunnels.length === 0) return null;
    const pieces: BufferGeometry[] = [];

    for (const tunnel of this.track.tunnels) {
      const profile: ProfilePoint[] = [];

      // Inside, left springing to right springing.
      for (let i = 0; i <= TUNNEL_SEGMENTS; i++) {
        const angle = Math.PI - (i / TUNNEL_SEGMENTS) * Math.PI;
        profile.push({
          anchor: 'centre',
          offset: Math.cos(angle) * TUNNEL_RADIUS,
          // Squashed arch: wider than it is tall, so the road stays the subject.
          up: Math.sin(angle) * tunnel.height,
          u: i / TUNNEL_SEGMENTS,
          accent: 1,
        });
      }
      // Outside, back the other way. `u` runs past 1 so the shading knows it is
      // looking at the outside of the arch and not at the light runs.
      for (let i = TUNNEL_SEGMENTS; i >= 0; i--) {
        const angle = Math.PI - (i / TUNNEL_SEGMENTS) * Math.PI;
        profile.push({
          anchor: 'centre',
          offset: Math.cos(angle) * (TUNNEL_RADIUS + TUNNEL_THICKNESS),
          up: Math.sin(angle) * (tunnel.height + TUNNEL_THICKNESS),
          u: 1 + i / TUNNEL_SEGMENTS,
          accent: 1,
        });
      }
      // And back to the first point, closing the ring at the left springing.
      profile.push({ ...profile[0]!, u: 2 });

      pieces.push(
        buildRibbon(this.track, {
          profile,
          step: 3,
          vScale: tunnel.lightSpacing,
          colourByDistrict: true,
          range: { fromS: tunnel.fromS, toS: tunnel.toS },
        }),
      );

      pieces.push(this.buildTunnelPortal(tunnel.fromS, tunnel.height));
      pieces.push(this.buildTunnelPortal(tunnel.toS, tunnel.height));
    }

    return mergeGeometries(pieces, false);
  }

  /**
   * The flat ring of masonry you see when you look a tunnel in the face.
   *
   * Without it the shell is an open tube and the gap between its two skins is
   * visible from the road, which is worse than the sheet it replaced.
   */
  private buildTunnelPortal(s: number, height: number): BufferGeometry {
    const frame = this.track.frameAt(s);
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const colours: number[] = [];
    const indices: number[] = [];

    for (let i = 0; i <= TUNNEL_SEGMENTS; i++) {
      const angle = Math.PI - (i / TUNNEL_SEGMENTS) * Math.PI;
      for (const outer of [false, true]) {
        const across = Math.cos(angle) * (outer ? TUNNEL_RADIUS + TUNNEL_THICKNESS : TUNNEL_RADIUS);
        const up = Math.sin(angle) * (outer ? height + TUNNEL_THICKNESS : height);
        _portal
          .copy(frame.position)
          .addScaledVector(frame.right, across)
          .addScaledVector(frame.up, up);
        positions.push(_portal.x, _portal.y, _portal.z);
        normals.push(frame.tangent.x, frame.tangent.y, frame.tangent.z);
        uvs.push(outer ? 1.6 : 1.4, i / TUNNEL_SEGMENTS);
        colours.push(1, 1, 1, 1);
      }
    }

    for (let i = 0; i < TUNNEL_SEGMENTS; i++) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
    geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(colours), 4));
    geometry.setIndex(indices);
    return geometry;
  }

  // --- Materials ----------------------------------------------------------

  /**
   * Pale concrete, a white edge line, and a broad band of the district's colour
   * running just inboard of it.
   *
   * The band is the single biggest thing keeping the circuit from reading grey.
   * A league like this paints its surfaces; the road is the largest surface
   * there is, and leaving it bare concrete wastes it.
   */
  private static roadMaterial(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    // The road is seen from underneath wherever the circuit is elevated.
    material.side = DoubleSide;
    const accent = attribute<'vec4'>('color', 'vec4');
    const across = uv().x;
    const along = uv().y;

    const edgeDistance = oneMinus(abs(across));
    const paint = smoothstep(float(0.07), float(0.055), edgeDistance).mul(
      smoothstep(float(0.018), float(0.03), edgeDistance),
    );
    // Colour band sitting inboard of the white line. Paint, not a light strip:
    // the trim along the barrier tops is the circuit's light source, and a
    // second glowing line at road level flattens the whole picture.
    const band = smoothstep(float(0.16), float(0.14), edgeDistance).mul(
      smoothstep(float(0.08), float(0.095), edgeDistance),
    );

    const seam = fract(along);
    const joint = smoothstep(float(0.022), float(0), min(seam, oneMinus(seam)));

    // Lighter than before. Under a hard sun this reads as pale concrete rather
    // than as asphalt, and it gives the paint something to sit against.
    const surface = mix(color(0xb9c1c9), color(0x98a1a9), abs(across).mul(0.55));
    const withBand = mix(surface, accent.xyz.mul(0.5), band);
    const withJoint = mix(withBand, color(0x808990), joint.mul(0.55));
    material.colorNode = mix(withJoint, color(0xf6f8fa), paint);
    material.roughnessNode = mix(float(0.7), float(0.5), paint.add(band));
    material.metalnessNode = float(0.02);
    return material;
  }

  /** Alternating accent and white blocks, the way a real kerb is painted. */
  private static kerbMaterial(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    material.side = DoubleSide;
    const accent = attribute<'vec4'>('color', 'vec4');
    const blocks = step(float(0.5), fract(uv().y));
    material.colorNode = mix(accent.xyz.mul(0.9), vec3(0.95, 0.96, 0.97), blocks);
    material.emissiveNode = accent.xyz.mul(oneMinus(blocks)).mul(0.5);
    material.roughnessNode = float(0.55);
    return material;
  }

  /**
   * White barrier panels, seamed, with long blocks of the district's colour.
   *
   * The blocks run several panels at a time rather than alternating per panel:
   * at 500 km/h a fine pattern is a grey blur, and only a colour field big
   * enough to last half a second actually registers as colour.
   */
  private static wallMaterial(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    // A barrier is one sheet of geometry with no thickness, so culled to a
    // single side it disappears the moment you are outside the circuit —
    // which is most of the time, since the road ahead curves away from you.
    material.side = DoubleSide;
    const accent = attribute<'vec4'>('color', 'vec4');
    const height = uv().x;
    const along = uv().y;

    const seam = fract(along);
    const panel = smoothstep(float(0.03), float(0), min(seam, oneMinus(seam)));

    // One block every eight panels, covering the lower two thirds of the wall.
    const run = fract(along.mul(0.125));
    const block = smoothstep(float(0.46), float(0.4), run)
      .mul(smoothstep(float(0.04), float(0.1), run))
      .mul(smoothstep(float(0.72), float(0.64), height));

    const base = mix(color(0xeff3f6), color(0xc6cdd3), height.mul(0.3));
    const painted = mix(base, accent.xyz.mul(0.8), block);
    material.colorNode = mix(painted, color(0x8d959c), panel.mul(0.7));
    material.emissiveNode = accent.xyz.mul(block).mul(0.1);
    material.roughnessNode = mix(float(0.5), float(0.34), block);
    material.metalnessNode = float(0.05);
    return material;
  }

  /** The lit cap along the barrier, coloured by district. */
  private static trimMaterial(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    // Same sheet, same problem: the edge light has to cap the barrier from
    // whichever side the barrier is being seen.
    material.side = DoubleSide;
    const accent = attribute<'vec4'>('color', 'vec4');
    material.colorNode = accent.xyz.mul(0.2);
    material.emissiveNode = accent.xyz.mul(3.4);
    material.roughnessNode = float(0.35);
    return material;
  }

  /** Speed pad: chevrons running the way you are about to go, very fast. */
  private static boostPadMaterial(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    const across = uv().x.sub(0.5).abs().mul(2);
    const along = uv().y;
    // A chevron is just a V-shaped offset applied to the scrolling coordinate.
    const scroll = fract(along.mul(3).sub(time.mul(2.2)).add(across.mul(0.45)));
    const stripe = smoothstep(float(0.5), float(0.18), scroll);
    const inset = smoothstep(float(1.0), float(0.88), across);
    material.colorNode = mix(color(0x0d1418), color(0x0affc8), stripe).mul(inset);
    material.emissiveNode = color(0x0affc8).mul(stripe).mul(inset).mul(4.5);
    material.roughnessNode = float(0.3);
    return material;
  }

  /**
   * Weapon pad: a colour wheel turning under a lit frame.
   *
   * The first version lit only a thin border and left the middle near black,
   * which at racing speed read as a hole in the road rather than as something
   * worth driving over. The interior now cycles through the whole hue circle —
   * a weapon pad is a random draw, and the surface says so before you take it.
   */
  private static pickupPadMaterial(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    const across = uv().x.sub(0.5).abs().mul(2);
    const along = uv().y.sub(0.5).abs().mul(2);
    const frame = max(across, along);
    const ring = smoothstep(float(0.55), float(0.75), frame).mul(smoothstep(float(1.0), float(0.9), frame));
    const pulse = sin(time.mul(2.4)).mul(0.5).add(0.5).mul(0.4).add(0.6);

    // Cosine palette: three channels of the same wave, a third of a turn apart,
    // which is a full hue sweep in four cheap instructions and no texture.
    const phase = time.mul(0.28).sub(uv().y.mul(0.4));
    const wheel = vec3(0.5, 0.5, 0.5).add(
      vec3(0.5, 0.5, 0.5).mul(cos(vec3(phase, phase.add(0.33), phase.add(0.67)).mul(Math.PI * 2))),
    );

    // Lit edge to edge. The previous version masked the colour to a small
    // central diamond and left the rest of the quad at zero, so most of the pad
    // was a black rectangle painted on the road — which is exactly what it
    // looked like at racing speed.
    const glow = mix(float(0.55), float(1), smoothstep(float(1), float(0.3), frame));

    material.colorNode = mix(wheel.mul(0.5).add(0.1), color(0xeef4f8), ring);
    material.emissiveNode = wheel
      .mul(glow)
      .mul(pulse)
      .mul(2.2)
      .add(color(0xeef4f8).mul(ring).mul(pulse).mul(2.4));
    material.roughnessNode = float(0.3);
    return material;
  }

  /** Tunnel shell: dark, with emissive strip lights running the ceiling. */
  private static tunnelMaterial(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    const accent = attribute<'vec4'>('color', 'vec4');
    const around = uv().x;
    const along = uv().y;

    // `u` runs 0..1 around the inside of the arch, 1..2 back around the
    // outside, and lands on 1.4/1.6 across the portal rings. Only the inside
    // carries light runs; outside, a tunnel is a lump of concrete.
    const inside = smoothstep(float(1.02), float(0.98), around);

    // Two light runs, at a quarter and three quarters around the arch.
    const runA = smoothstep(float(0.035), float(0), abs(around.sub(0.26)));
    const runB = smoothstep(float(0.035), float(0), abs(around.sub(0.74)));
    const gap = smoothstep(float(0.12), float(0.3), fract(along));
    const lights = clamp(runA.add(runB), float(0), float(1)).mul(gap).mul(inside);

    material.colorNode = mix(color(0x1a1f24), color(0x2b3239), around.sub(0.5).abs().mul(2));
    material.emissiveNode = mix(accent.xyz.mul(0.6), vec3(1, 0.96, 0.9), float(0.7)).mul(lights).mul(5);
    material.roughnessNode = float(0.62);
    // Both sides: the road runs inside the tube, but the tube's outside is
    // visible on approach and from the elevated sections above it.
    material.side = DoubleSide;
    return material;
  }
}
