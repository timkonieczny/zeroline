import { BufferAttribute, BufferGeometry, Vector3 } from 'three';
import { createTrackFrame } from './TrackSpline';
import type { Track } from './Track';
import { wrap } from '@/core/math';

/**
 * One vertex of a road cross-section.
 *
 * Positions are anchored to an edge or to the centreline rather than given as
 * absolute offsets, so a profile written once stays correct as the road widens
 * and narrows around the lap.
 */
export interface ProfilePoint {
  /** Which side of the road `offset` is measured from. */
  anchor: 'left' | 'right' | 'centre';
  /** Metres inward from that anchor. For 'centre', metres to the right. */
  offset: number;
  /** Height above the road plane, in metres. */
  up: number;
  /** Texture coordinate across the section. */
  u: number;
  /** Optional accent weight, 0..1, written to the vertex colour's alpha. */
  accent?: number;
}

export interface RibbonOptions {
  /** Cross-section, left to right. Consecutive pairs become quads. */
  profile: readonly ProfilePoint[];
  /** Sample spacing along the track, in metres. */
  step?: number;
  /** Restrict the ribbon to this arc-length range. Omit for the whole lap. */
  range?: { fromS: number; toS: number };
  /** Metres of arc length per unit of the V texture coordinate. */
  vScale?: number;
  /** Write per-vertex district accent colours. */
  colourByDistrict?: boolean;
  /**
   * Pairs of profile indices to skip, so a profile can carry a gap. Index `i`
   * refers to the quad between profile points `i` and `i+1`.
   */
  skipQuads?: readonly number[];
}

const _p = new Vector3();
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _ab = new Vector3();
const _ac = new Vector3();
const _n = new Vector3();

/**
 * Sweeps a cross-section along the track centreline into a single geometry.
 *
 * Everything the circuit is made of — road, kerbs, barriers, the emissive trim
 * along the top of the barriers, the tunnel shell — is one of these. Building it
 * from the same frames the physics queries means the thing you see and the thing
 * you collide with cannot drift apart.
 *
 * Normals are accumulated per face rather than taken from the track frame, so
 * kerbs and wall faces are shaded correctly without a separate normal pass.
 */
export function buildRibbon(track: Track, options: RibbonOptions): BufferGeometry {
  const { profile, step = 2, vScale = 12, colourByDistrict = false, skipQuads = [] } = options;
  const closed = !options.range;
  const fromS = options.range?.fromS ?? 0;
  const toS = options.range?.toS ?? track.length;
  const span = closed ? track.length : wrap(toS - fromS, track.length) || track.length;

  const rings = Math.max(2, Math.round(span / step)) + (closed ? 0 : 1);
  const across = profile.length;
  const vertexCount = rings * across;

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const colours = new Float32Array(vertexCount * 4);

  const frame = createTrackFrame();
  const ringStep = span / (closed ? rings : rings - 1);

  for (let r = 0; r < rings; r++) {
    const s = fromS + r * ringStep;
    track.spline.sample(s, frame);
    const halfWidth = frame.width * 0.5;
    const district = colourByDistrict ? track.districtAt(s) : null;
    const accentR = district ? ((district.accent >> 16) & 0xff) / 255 : 1;
    const accentG = district ? ((district.accent >> 8) & 0xff) / 255 : 1;
    const accentB = district ? (district.accent & 0xff) / 255 : 1;

    for (let c = 0; c < across; c++) {
      const point = profile[c]!;
      const lateral =
        point.anchor === 'left'
          ? -halfWidth + point.offset
          : point.anchor === 'right'
            ? halfWidth - point.offset
            : point.offset;

      _p.copy(frame.position).addScaledVector(frame.right, lateral).addScaledVector(frame.up, point.up);
      const i = r * across + c;
      positions[i * 3] = _p.x;
      positions[i * 3 + 1] = _p.y;
      positions[i * 3 + 2] = _p.z;
      uvs[i * 2] = point.u;
      uvs[i * 2 + 1] = s / vScale;
      colours[i * 4] = accentR;
      colours[i * 4 + 1] = accentG;
      colours[i * 4 + 2] = accentB;
      colours[i * 4 + 3] = point.accent ?? 0;
    }
  }

  const skip = new Set(skipQuads);
  const quadRings = closed ? rings : rings - 1;
  const indices: number[] = [];
  for (let r = 0; r < quadRings; r++) {
    const r0 = r * across;
    const r1 = ((r + 1) % rings) * across;
    for (let c = 0; c < across - 1; c++) {
      if (skip.has(c)) continue;
      const a = r0 + c;
      const b = r0 + c + 1;
      const d = r1 + c;
      const e = r1 + c + 1;
      // Wound so the face normal comes out as +up: cross(right, tangent).
      // The other winding lights the whole circuit from underneath.
      indices.push(a, b, d, b, e, d);
    }
  }

  // Face normals, accumulated to the corners and normalised at the end.
  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i]!;
    const ib = indices[i + 1]!;
    const ic = indices[i + 2]!;
    _a.fromArray(positions, ia * 3);
    _b.fromArray(positions, ib * 3);
    _c.fromArray(positions, ic * 3);
    _ab.subVectors(_b, _a);
    _ac.subVectors(_c, _a);
    _n.crossVectors(_ab, _ac);
    for (const index of [ia, ib, ic]) {
      normals[index * 3] += _n.x;
      normals[index * 3 + 1] += _n.y;
      normals[index * 3 + 2] += _n.z;
    }
  }
  for (let i = 0; i < vertexCount; i++) {
    _n.fromArray(normals, i * 3);
    if (_n.lengthSq() < 1e-12) _n.set(0, 1, 0);
    else _n.normalize();
    normals[i * 3] = _n.x;
    normals[i * 3 + 1] = _n.y;
    normals[i * 3 + 2] = _n.z;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new BufferAttribute(colours, 4));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}
