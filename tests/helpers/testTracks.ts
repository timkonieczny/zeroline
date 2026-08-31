import { Track } from '@/track/Track';
import type { TrackDefinition } from '@/track/TrackTypes';
import type { TrackVertex } from '@/track/TrackPath';

/**
 * A long, wide, almost featureless loop.
 *
 * Physics tests need somewhere a craft can be driven flat out in a straight line
 * for half a minute without meeting a corner — which no real circuit provides.
 * The straights here are long enough for the fastest class to reach terminal
 * velocity and stay there, and the road is wide enough that lateral tests do not
 * accidentally become wall tests.
 */
export function provingGround(): Track {
  const corners: TrackVertex[] = [
    { name: 'A', x: 0, z: 0, radius: 220, height: 0, width: 80 },
    { name: 'B', x: 6000, z: 0, radius: 220, height: 0, width: 80 },
    { name: 'C', x: 6000, z: 900, radius: 220, height: 0, width: 80 },
    { name: 'D', x: 0, z: 900, radius: 220, height: 0, width: 80 },
  ];

  const definition: TrackDefinition = {
    id: 'proving-ground',
    name: 'PROVING GROUND',
    subtitle: 'TEST',
    region: 'PG',
    laps: 1,
    spacing: 4,
    // Just past the first corner, so the grid and everything that follows sits
    // on the 5.5 km straight rather than trailing back into the banking.
    startLine: 0.075,
    corners,
    tunnels: [],
    boostPads: [{ at: 0.2, offset: 0 }],
    pickupPads: [{ at: 0.1, offset: 0 }],
    districts: [{ from: 0, to: 1, theme: 'harbour', accent: 0x24d4ff }],
    sun: { azimuth: 130, elevation: 50, colour: 0xffffff, intensity: 3 },
    sky: { horizon: 0xe6eef6, zenith: 0x4c8fd8, ground: 0xa9b6c2, fogDensity: 0.0002 },
  };

  return new Track(definition);
}
