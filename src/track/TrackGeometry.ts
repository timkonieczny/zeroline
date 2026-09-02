import { BufferAttribute, BufferGeometry, Vector3 } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildRibbon, type ProfilePoint } from './TrackRibbon';
import type { ResolvedPad, Track } from './Track';
import { wrap } from '@/core/math';

/**
 * Every sweep a circuit is made of, with no material anywhere in sight.
 *
 * Kept apart from `TrackMesh` for one reason: materials import `three/webgpu`,
 * and this module is meant to run in a worker, where there is no device to
 * compile a shader against. Splitting the file is what makes the boundary
 * enforceable rather than merely intended.
 */

/** Half-width of the tunnel bore, in metres. */
export const TUNNEL_RADIUS = 19;
/** Rings around the bore. */
const TUNNEL_SEGMENTS = 14;
/** How thick the tunnel's walls are, in metres. */
export const TUNNEL_THICKNESS = 2.4;

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

/** The circuit's sweeps, before any of them has a material. */
export interface TrackGeometry {
  road: BufferGeometry;
  kerbs: BufferGeometry;
  walls: BufferGeometry;
  trim: BufferGeometry;
  boostPads: BufferGeometry;
  pickupPads: BufferGeometry;
  tunnels: BufferGeometry | null;
}

/**
 * Every sweep the circuit is made of, and nothing that touches a GPU.
 *
 * A free function taking a `Track`, so a worker can build a circuit's geometry
 * from a definition and post the buffers back without ever constructing a
 * `TrackMesh` — which would drag every material, and with it `three/webgpu`,
 * into a context that has no device.
 */
export function buildTrackGeometry(track: Track): TrackGeometry {
  return {
    road: buildRoad(track),
    kerbs: buildKerbs(track),
    walls: buildWalls(track),
    trim: buildTrim(track),
    boostPads: buildPads(track, track.boostPads),
    pickupPads: buildPads(track, track.pickupPads),
    tunnels: buildTunnels(track),
  };
}

function buildRoad(track: Track): BufferGeometry {
  const profile: ProfilePoint[] = [
    { anchor: 'left', offset: KERB_WIDTH, up: 0, u: -1 },
    { anchor: 'centre', offset: 0, up: 0, u: 0 },
    { anchor: 'right', offset: KERB_WIDTH, up: 0, u: 1 },
  ];
  return buildRibbon(track, { profile, step: 2, vScale: ROAD_V_SCALE, colourByDistrict: true });
}

function buildKerbs(track: Track): BufferGeometry {
  // Two strips, one per edge, with the middle quad skipped.
  const profile: ProfilePoint[] = [
    { anchor: 'left', offset: 0, up: KERB_RISE, u: 0 },
    { anchor: 'left', offset: KERB_WIDTH, up: 0, u: 1 },
    { anchor: 'right', offset: KERB_WIDTH, up: 0, u: 1 },
    { anchor: 'right', offset: 0, up: KERB_RISE, u: 0 },
  ];
  return buildRibbon(track, {
    profile,
    step: 2,
    vScale: 2.4,
    colourByDistrict: true,
    skipQuads: [1],
  });
}

function buildWalls(track: Track): BufferGeometry {
  const profile: ProfilePoint[] = [
    { anchor: 'left', offset: -WALL_LEAN, up: WALL_HEIGHT, u: 1, accent: 1 },
    { anchor: 'left', offset: 0, up: KERB_RISE, u: 0 },
    { anchor: 'right', offset: 0, up: KERB_RISE, u: 0 },
    { anchor: 'right', offset: -WALL_LEAN, up: WALL_HEIGHT, u: 1, accent: 1 },
  ];
  return buildRibbon(track, {
    profile,
    step: 2,
    vScale: 6,
    colourByDistrict: true,
    skipQuads: [1],
  });
}

/** The emissive band capping each barrier — the circuit's edge light. */
function buildTrim(track: Track): BufferGeometry {
  const profile: ProfilePoint[] = [
    { anchor: 'left', offset: -WALL_LEAN - 0.25, up: WALL_HEIGHT + 0.22, u: 0, accent: 1 },
    { anchor: 'left', offset: -WALL_LEAN, up: WALL_HEIGHT, u: 1, accent: 1 },
    { anchor: 'right', offset: -WALL_LEAN, up: WALL_HEIGHT, u: 1, accent: 1 },
    { anchor: 'right', offset: -WALL_LEAN - 0.25, up: WALL_HEIGHT + 0.22, u: 0, accent: 1 },
  ];
  return buildRibbon(track, {
    profile,
    step: 2,
    vScale: 6,
    colourByDistrict: true,
    skipQuads: [1],
  });
}

function buildPads(track: Track, pads: readonly ResolvedPad[]): BufferGeometry {
  const pieces = pads.map((pad) => {
    const profile: ProfilePoint[] = [
      { anchor: 'centre', offset: pad.lateral - pad.halfWidth, up: 0.02, u: 0 },
      { anchor: 'centre', offset: pad.lateral + pad.halfWidth, up: 0.02, u: 1 },
    ];
    return buildRibbon(track, {
      profile,
      step: 1.2,
      vScale: pad.halfLength * 2,
      range: { fromS: wrap(pad.s - pad.halfLength, track.length), toS: wrap(pad.s + pad.halfLength, track.length) },
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
function buildTunnels(track: Track): BufferGeometry | null {
  if (track.tunnels.length === 0) return null;
  const pieces: BufferGeometry[] = [];

  for (const tunnel of track.tunnels) {
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
      buildRibbon(track, {
        profile,
        step: 3,
        vScale: tunnel.lightSpacing,
        colourByDistrict: true,
        range: { fromS: tunnel.fromS, toS: tunnel.toS },
      }),
    );

    pieces.push(buildTunnelPortal(track, tunnel.fromS, tunnel.height));
    pieces.push(buildTunnelPortal(track, tunnel.toS, tunnel.height));
  }

  return mergeGeometries(pieces, false);
}

/**
 * The flat ring of masonry you see when you look a tunnel in the face.
 *
 * Without it the shell is an open tube and the gap between its two skins is
 * visible from the road, which is worse than the sheet it replaced.
 */
function buildTunnelPortal(track: Track, s: number, height: number): BufferGeometry {
  const frame = track.frameAt(s);
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
