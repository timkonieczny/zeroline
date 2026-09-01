import { DoubleSide, Group, Mesh } from 'three';
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
  uv,
  vec3,
} from 'three/tsl';
import { simTime } from '@/core/Clock';
import { buildTrackGeometry, type TrackGeometry } from './TrackGeometry';
import type { Track } from './Track';


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

  /**
   * @param prebuilt Geometry sweeps already done elsewhere. Materials always
   *   belong to the main thread — they compile shaders — but the sweeps behind
   *   them are arithmetic, and this is where a worker's output is handed back
   *   in. Omit it and the sweeps run here, exactly as they used to.
   */
  constructor(track: Track, prebuilt?: TrackGeometry) {
    this.group.name = 'track';
    const built = prebuilt ?? buildTrackGeometry(track);

    this.road = new Mesh(built.road, TrackMesh.roadMaterial());
    this.road.receiveShadow = true;
    this.road.name = 'road';

    this.kerbs = new Mesh(built.kerbs, TrackMesh.kerbMaterial());
    this.kerbs.receiveShadow = true;
    this.kerbs.name = 'kerbs';

    this.walls = new Mesh(built.walls, TrackMesh.wallMaterial());
    this.walls.receiveShadow = true;
    this.walls.castShadow = true;
    this.walls.name = 'walls';

    this.trim = new Mesh(built.trim, TrackMesh.trimMaterial());
    this.trim.name = 'trim';

    this.boostPads = new Mesh(built.boostPads, TrackMesh.boostPadMaterial());
    this.boostPads.name = 'boost-pads';

    this.pickupPads = new Mesh(built.pickupPads, TrackMesh.pickupPadMaterial());
    this.pickupPads.name = 'pickup-pads';

    this.tunnels = built.tunnels ? new Mesh(built.tunnels, TrackMesh.tunnelMaterial()) : null;
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
    const scroll = fract(along.mul(3).sub(simTime.mul(2.2)).add(across.mul(0.45)));
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
    const pulse = sin(simTime.mul(2.4)).mul(0.5).add(0.5).mul(0.4).add(0.6);

    // Cosine palette: three channels of the same wave, a third of a turn apart,
    // which is a full hue sweep in four cheap instructions and no texture.
    const phase = simTime.mul(0.28).sub(uv().y.mul(0.4));
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

    material.colorNode = mix(color(0x232a30), color(0x353e46), around.sub(0.5).abs().mul(2));
    // Brighter than they were, because they are now the only thing lighting a
    // tunnel. Real point lights in here cost the entire scene — a forward
    // renderer charges every lit fragment for every light, whether it is in the
    // tunnel or a mile away — so the strips went back to being the whole
    // effect. What sells the dark instead is the exposure adapting to it, and
    // an emissive run is exactly what a dark-adapted eye should find too
    // bright.
    material.emissiveNode = mix(accent.xyz.mul(0.6), vec3(1, 0.96, 0.9), float(0.7)).mul(lights).mul(9);
    material.roughnessNode = float(0.62);
    // Both sides: the road runs inside the tube, but the tube's outside is
    // visible on approach and from the elevated sections above it.
    material.side = DoubleSide;
    return material;
  }
}
