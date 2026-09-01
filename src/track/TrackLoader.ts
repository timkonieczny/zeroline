import { Track } from './Track';
import { TrackSpline } from './TrackSpline';
import { buildTrackGeometry } from './TrackGeometry';
import { createWaterNormalsData } from './scenery/WaterNormals';
import { fromGeometryData, type TrackPayload } from './TrackPayload';
import type { TrackGeometry } from './TrackGeometry';
import type { TrackDefinition } from './TrackTypes';

/** A circuit, ready for materials to be hung on it. */
export interface LoadedTrack {
  track: Track;
  geometry: TrackGeometry;
  waterNormals: Uint8Array;
  /** Whether the work actually happened off the main thread. */
  threaded: boolean;
}

/**
 * Builds a circuit, off the main thread when the browser allows it.
 *
 * Three quarters of a load is arithmetic: resampling the centreline to uniform
 * arc length, sweeping the road and barriers and tunnels along it, and
 * generating the sea's normal map. None of it needs a GPU, so none of it needs
 * to be on the thread that is drawing.
 *
 * The fallback is not a degraded path — it is the original one. If workers are
 * unavailable, or the module fails to load, or the worker throws, everything is
 * built here instead and the only difference is that the frame stalls while it
 * happens, which is exactly what happened before any of this existed.
 */
export async function loadTrack(definition: TrackDefinition): Promise<LoadedTrack> {
  const started = performance.now();
  try {
    const payload = await runWorker(definition);
    report(definition, started, 'worker');
    return {
      track: new Track(definition, new TrackSpline(payload.spline)),
      geometry: {
        road: fromGeometryData(payload.geometry.road),
        kerbs: fromGeometryData(payload.geometry.kerbs),
        walls: fromGeometryData(payload.geometry.walls),
        trim: fromGeometryData(payload.geometry.trim),
        boostPads: fromGeometryData(payload.geometry.boostPads),
        pickupPads: fromGeometryData(payload.geometry.pickupPads),
        tunnels: payload.geometry.tunnels ? fromGeometryData(payload.geometry.tunnels) : null,
      },
      waterNormals: payload.waterNormals,
      threaded: true,
    };
  } catch (error) {
    if (import.meta.env.DEV) console.warn('[zeroline] track worker unavailable, building inline', error);
    const track = new Track(definition);
    const inline = {
      track,
      geometry: buildTrackGeometry(track),
      waterNormals: createWaterNormalsData(),
      threaded: false,
    };
    report(definition, started, 'main thread');
    return inline;
  }
}

/** Says which path was taken and what it cost. Dev builds only. */
function report(definition: TrackDefinition, started: number, where: 'worker' | 'main thread'): void {
  if (!import.meta.env.DEV) return;
  console.info(`[zeroline] ${definition.id} built on the ${where} in ${(performance.now() - started).toFixed(0)} ms`);
}

/** One circuit, one worker, torn down as soon as it has answered. */
function runWorker(definition: TrackDefinition): Promise<TrackPayload> {
  if (typeof Worker === 'undefined') return Promise.reject(new Error('no workers'));

  return new Promise<TrackPayload>((resolve, reject) => {
    const worker = new Worker(new URL('./TrackWorker.ts', import.meta.url), { type: 'module' });
    // A circuit takes a fraction of a second to build. Anything past this and
    // something is wrong, and waiting longer will not fix it — build it here.
    const timeout = window.setTimeout(() => {
      worker.terminate();
      reject(new Error('track worker timed out'));
    }, 8000);

    const finish = (): void => {
      window.clearTimeout(timeout);
      worker.terminate();
    };

    worker.onmessage = (event: MessageEvent<TrackPayload>) => {
      finish();
      resolve(event.data);
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || 'track worker failed'));
    };

    // The definition is plain data — numbers, strings and arrays of them — so
    // it structured-clones without any help.
    worker.postMessage(definition);
  });
}
