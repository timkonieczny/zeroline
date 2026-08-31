import { BackSide, Group, Mesh, type BufferGeometry } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  abs,
  attribute,
  clamp,
  color,
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
    return buildRibbon(this.track, { profile, step: 2, vScale: ROAD_V_SCALE });
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

  private buildTunnels(): BufferGeometry | null {
    if (this.track.tunnels.length === 0) return null;
    const pieces = this.track.tunnels.map((tunnel) => {
      const segments = 14;
      const radius = 19;
      const profile: ProfilePoint[] = [];
      for (let i = 0; i <= segments; i++) {
        const angle = Math.PI - (i / segments) * Math.PI;
        profile.push({
          anchor: 'centre',
          offset: Math.cos(angle) * radius,
          // Squashed arch: wider than it is tall, so the road stays the subject.
          up: Math.sin(angle) * tunnel.height,
          u: i / segments,
          accent: 1,
        });
      }
      return buildRibbon(this.track, {
        profile,
        step: 3,
        vScale: tunnel.lightSpacing,
        colourByDistrict: true,
        range: { fromS: tunnel.fromS, toS: tunnel.toS },
      });
    });
    return mergeGeometries(pieces, false);
  }

  // --- Materials ----------------------------------------------------------

  /** Pale concrete with crisp painted edge lines and expansion joints. */
  private static roadMaterial(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    const across = uv().x;
    const along = uv().y;

    const edgeDistance = oneMinus(abs(across));
    const paint = smoothstep(float(0.07), float(0.055), edgeDistance).mul(
      smoothstep(float(0.018), float(0.03), edgeDistance),
    );

    const seam = fract(along);
    const joint = smoothstep(float(0.022), float(0), min(seam, oneMinus(seam)));

    const surface = mix(color(0x9aa1a8), color(0x767d84), abs(across).mul(0.6));
    const withJoint = mix(surface, color(0x5c6167), joint.mul(0.7));
    material.colorNode = mix(withJoint, color(0xf4f6f8), paint);
    material.roughnessNode = mix(float(0.72), float(0.45), paint);
    material.metalnessNode = float(0.02);
    return material;
  }

  /** Alternating accent and white blocks, the way a real kerb is painted. */
  private static kerbMaterial(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    const accent = attribute<'vec4'>('color', 'vec4');
    const blocks = step(float(0.5), fract(uv().y));
    material.colorNode = mix(accent.xyz.mul(0.9), vec3(0.95, 0.96, 0.97), blocks);
    material.emissiveNode = accent.xyz.mul(oneMinus(blocks)).mul(0.5);
    material.roughnessNode = float(0.55);
    return material;
  }

  /** White barrier panels with a recessed seam every panel width. */
  private static wallMaterial(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    const height = uv().x;
    const along = uv().y;

    const seam = fract(along);
    const panel = smoothstep(float(0.03), float(0), min(seam, oneMinus(seam)));
    const base = mix(color(0xe8ecef), color(0xbcc3c9), height.mul(0.35));
    material.colorNode = mix(base, color(0x8d959c), panel.mul(0.8));
    material.roughnessNode = float(0.5);
    material.metalnessNode = float(0.05);
    return material;
  }

  /** The lit cap along the barrier, coloured by district. */
  private static trimMaterial(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
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

  /** Weapon pad: a slow breathing glow, so it reads as available rather than urgent. */
  private static pickupPadMaterial(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    const across = uv().x.sub(0.5).abs().mul(2);
    const along = uv().y.sub(0.5).abs().mul(2);
    const frame = max(across, along);
    const ring = smoothstep(float(0.55), float(0.75), frame).mul(smoothstep(float(1.0), float(0.9), frame));
    const pulse = sin(time.mul(2.4)).mul(0.5).add(0.5).mul(0.4).add(0.6);
    material.colorNode = mix(color(0x11181d), color(0xdfe8ee), ring);
    material.emissiveNode = color(0xa8d8ff).mul(ring).mul(pulse).mul(2.6);
    material.roughnessNode = float(0.35);
    return material;
  }

  /** Tunnel shell: dark, with emissive strip lights running the ceiling. */
  private static tunnelMaterial(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    const accent = attribute<'vec4'>('color', 'vec4');
    const around = uv().x;
    const along = uv().y;

    // Two light runs, at a quarter and three quarters around the arch.
    const runA = smoothstep(float(0.035), float(0), abs(around.sub(0.26)));
    const runB = smoothstep(float(0.035), float(0), abs(around.sub(0.74)));
    const gap = smoothstep(float(0.12), float(0.3), fract(along));
    const lights = clamp(runA.add(runB), float(0), float(1)).mul(gap);

    material.colorNode = mix(color(0x1a1f24), color(0x2b3239), around.sub(0.5).abs().mul(2));
    material.emissiveNode = mix(accent.xyz.mul(0.6), vec3(1, 0.96, 0.9), float(0.7)).mul(lights).mul(5);
    material.roughnessNode = float(0.62);
    material.side = BackSide; // We are inside the tube.
    return material;
  }
}
