import { BufferAttribute, BufferGeometry } from 'three';
import type { SplineData } from './TrackSpline';

/**
 * A geometry reduced to its buffers.
 *
 * `BufferGeometry` itself is plain JavaScript and works perfectly well in a
 * worker — but it cannot be structured-cloned, and cloning is exactly what we
 * are trying to avoid. Stripping it to the arrays lets every byte be
 * transferred instead of copied, and rebuilding it on the far side is a handful
 * of `setAttribute` calls.
 */
export interface GeometryData {
  position: Float32Array;
  normal?: Float32Array;
  uv?: Float32Array;
  color?: Float32Array;
  index?: Uint32Array;
}

/** Everything the worker sends back, and nothing that needs a GPU to make. */
export interface TrackPayload {
  spline: SplineData;
  /** One entry per mesh the circuit is built from. */
  geometry: {
    road: GeometryData;
    kerbs: GeometryData;
    walls: GeometryData;
    trim: GeometryData;
    boostPads: GeometryData;
    pickupPads: GeometryData;
    tunnels: GeometryData | null;
  };
  /** RGBA payload for the sea's normal map. */
  waterNormals: Uint8Array;
}

/** Pulls a geometry apart into transferable buffers. */
export function toGeometryData(geometry: BufferGeometry): GeometryData {
  const attribute = (name: string): Float32Array | undefined => {
    const found = geometry.getAttribute(name);
    return found ? (found.array as Float32Array) : undefined;
  };
  const index = geometry.getIndex();
  return {
    position: attribute('position')!,
    normal: attribute('normal'),
    uv: attribute('uv'),
    color: attribute('color'),
    index: index ? Uint32Array.from(index.array) : undefined,
  };
}

/** Puts one back together. */
export function fromGeometryData(data: GeometryData): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(data.position, 3));
  if (data.normal) geometry.setAttribute('normal', new BufferAttribute(data.normal, 3));
  if (data.uv) geometry.setAttribute('uv', new BufferAttribute(data.uv, 2));
  if (data.color) geometry.setAttribute('color', new BufferAttribute(data.color, 4));
  if (data.index) geometry.setIndex(new BufferAttribute(data.index, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/** Every buffer in a payload, so the whole thing can be transferred at once. */
export function payloadTransfers(payload: TrackPayload): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];
  const take = (view: { buffer: ArrayBufferLike } | undefined): void => {
    if (view && view.buffer instanceof ArrayBuffer && !buffers.includes(view.buffer)) {
      buffers.push(view.buffer);
    }
  };

  for (const lane of payload.spline.lanes) take(lane);
  for (const data of Object.values(payload.geometry)) {
    if (!data) continue;
    take(data.position);
    take(data.normal);
    take(data.uv);
    take(data.color);
    take(data.index);
  }
  take(payload.waterNormals);
  return buffers;
}
