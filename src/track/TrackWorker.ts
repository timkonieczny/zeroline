import { Track } from './Track';
import { buildTrackGeometry } from './TrackGeometry';
import { createWaterNormalsData } from './scenery/WaterNormals';
import { toGeometryData, payloadTransfers, type TrackPayload } from './TrackPayload';
import type { TrackDefinition } from './TrackTypes';

/**
 * Builds a circuit off the main thread.
 *
 * Everything in here is arithmetic over typed arrays: resampling the centreline
 * to uniform arc length, sweeping the road, kerbs, barriers and tunnels along
 * it, and generating the sea's normal map. None of it touches a GPU, none of it
 * touches the DOM, and it is three quarters of what a load costs.
 *
 * `Track` and `TrackMesh` are used unchanged. `BufferGeometry` is plain
 * JavaScript and works here perfectly well — it is only at the boundary that it
 * has to be taken apart, because a geometry cannot be transferred and its
 * buffers can.
 *
 * The one thing that stays behind is materials: they compile shaders, which
 * needs a device, which a worker does not have.
 */
self.onmessage = (event: MessageEvent<TrackDefinition>): void => {
  const definition = event.data;

  const track = new Track(definition);
  const geometry = buildTrackGeometry(track);

  const payload: TrackPayload = {
    spline: track.spline.toData(),
    geometry: {
      road: toGeometryData(geometry.road),
      kerbs: toGeometryData(geometry.kerbs),
      walls: toGeometryData(geometry.walls),
      trim: toGeometryData(geometry.trim),
      boostPads: toGeometryData(geometry.boostPads),
      pickupPads: toGeometryData(geometry.pickupPads),
      tunnels: geometry.tunnels ? toGeometryData(geometry.tunnels) : null,
    },
    waterNormals: createWaterNormalsData(),
  };

  self.postMessage(payload, { transfer: payloadTransfers(payload) });
};
