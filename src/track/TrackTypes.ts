import type { TrackVertex } from './TrackPath';

/** A range of the lap expressed as fractions of total arc length, in [0,1]. */
export interface LapRange {
  from: number;
  to: number;
}

export interface TunnelSection extends LapRange {
  /** Interior height of the tube above the road, in metres. */
  height: number;
  /** Spacing of the emissive ceiling strips, in metres. */
  lightSpacing: number;
}

/** A pad embedded in the road surface. */
export interface PadPlacement {
  /** Position along the lap, as a fraction of total arc length. */
  at: number;
  /** Lateral offset from the centreline as a fraction of usable half-width, in [-1,1]. */
  offset: number;
}

export type SceneryTheme = 'harbour' | 'towers' | 'canyon' | 'terminal' | 'stadium';

export interface SceneryDistrict extends LapRange {
  theme: SceneryTheme;
  /** Accent colour for emissive trim in this district, as a hex integer. */
  accent: number;
}

export interface TrackDefinition {
  id: string;
  /** Display name, shown uppercase in menus. */
  name: string;
  /** Circuit designation, e.g. "CIRCUIT 01". */
  subtitle: string;
  /** Two-letter region tag used in the results table. */
  region: string;
  laps: number;
  /** Spacing of resampled centreline frames, in metres. */
  spacing: number;
  /** The circuit itself, as a closed polygon of corners. */
  corners: readonly TrackVertex[];
  tunnels: readonly TunnelSection[];
  boostPads: readonly PadPlacement[];
  pickupPads: readonly PadPlacement[];
  districts: readonly SceneryDistrict[];
  /** Fraction of the lap where the start/finish line sits. */
  startLine: number;
  sun: {
    /** Compass bearing in degrees. */
    azimuth: number;
    /** Height above the horizon in degrees. */
    elevation: number;
    colour: number;
    intensity: number;
  };
  sky: {
    horizon: number;
    zenith: number;
    ground: number;
    fogDensity: number;
  };
}
