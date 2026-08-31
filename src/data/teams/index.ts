/**
 * The ZEROLINE grid. Five constructors, five philosophies.
 *
 * Ratings are 0..1 and feed `Handling.ts`, which turns them into physics
 * constants. The menu shows them as five-bar meters, so keep them spread across
 * the range: a team that is average at everything is boring to pick.
 */

export interface TeamStats {
  /** Top speed. */
  speed: number;
  /** Acceleration and boost recovery. */
  thrust: number;
  /** Cornering authority and airbrake bite. */
  handling: number;
  /** Shield capacity and impact resistance. */
  shield: number;
}

/** Parameters for the procedural hull. See `game/GliderModel.ts`. */
export interface HullSpec {
  /** Overall length in metres. */
  length: number;
  /** Widest beam in metres. */
  beam: number;
  /** Hull height in metres, excluding the canopy. */
  height: number;
  /** 0 = blunt wedge, 1 = needle nose. */
  nose: number;
  /** Span of the rear fins as a fraction of beam. */
  finSpan: number;
  /** Rake of the rear fins in degrees. */
  finRake: number;
  /** 0 = flat deck, 1 = tall bubble canopy. */
  canopy: number;
  /** Number of thruster nozzles at the stern. */
  thrusters: number;
}

export interface Team {
  id: string;
  /** Constructor name, as it is set in the interface. */
  name: string;
  /** Short tag for the HUD and results table. */
  tag: string;
  /** Registered nation, for flavour. */
  nation: string;
  /** One-line character summary shown on the select screen. */
  blurb: string;
  stats: TeamStats;
  hull: HullSpec;
  colours: {
    /** Body base, usually near-white in this league. */
    primary: number;
    /** Livery block colour. */
    secondary: number;
    /** Emissive trim, engine glow and HUD accent. */
    accent: number;
  };
}

export const TEAMS: readonly Team[] = [
  {
    id: 'auroc',
    name: 'Auroc',
    tag: 'AUR',
    nation: 'FR',
    blurb: 'No weaknesses, no excuses. The car every other car is measured against.',
    stats: { speed: 0.6, thrust: 0.6, handling: 0.62, shield: 0.6 },
    hull: { length: 8.2, beam: 4.6, height: 1.15, nose: 0.55, finSpan: 0.5, finRake: 24, canopy: 0.5, thrusters: 2 },
    colours: { primary: 0xf2f4f7, secondary: 0x14203a, accent: 0x24d4ff },
  },
  {
    id: 'kestrel',
    name: 'Kestrel Dynamics',
    tag: 'KES',
    nation: 'UK',
    blurb: 'Fastest thing on the grid in a straight line. Ask it to turn and it argues.',
    stats: { speed: 0.96, thrust: 0.52, handling: 0.34, shield: 0.3 },
    hull: { length: 9.4, beam: 4.0, height: 0.95, nose: 0.92, finSpan: 0.34, finRake: 12, canopy: 0.28, thrusters: 2 },
    colours: { primary: 0xeef1f4, secondary: 0x9a1b2f, accent: 0xff3d5e },
  },
  {
    id: 'ionflux',
    name: 'Ionflux',
    tag: 'ION',
    nation: 'JP',
    blurb: 'Violent off the line and out of corners. Runs out of legs on the long straights.',
    stats: { speed: 0.54, thrust: 0.96, handling: 0.7, shield: 0.44 },
    hull: { length: 7.4, beam: 4.8, height: 1.05, nose: 0.42, finSpan: 0.62, finRake: 34, canopy: 0.44, thrusters: 4 },
    colours: { primary: 0xf5f6f2, secondary: 0x1d3a2a, accent: 0x2fff9e },
  },
  {
    id: 'sabre9',
    name: 'Sabre-9',
    tag: 'SB9',
    nation: 'DE',
    blurb: 'Armoured, heavy, unbothered. Wins by still being there on the last lap.',
    stats: { speed: 0.5, thrust: 0.36, handling: 0.46, shield: 1.0 },
    hull: { length: 8.8, beam: 5.4, height: 1.45, nose: 0.3, finSpan: 0.7, finRake: 18, canopy: 0.62, thrusters: 3 },
    colours: { primary: 0xe9ebec, secondary: 0x3a3f45, accent: 0xffb020 },
  },
  {
    id: 'halcyon',
    name: 'Halcyon Motiv',
    tag: 'HAL',
    nation: 'SE',
    blurb: 'Goes exactly where you point it. Forgives everything except impatience.',
    stats: { speed: 0.46, thrust: 0.62, handling: 0.96, shield: 0.6 },
    hull: { length: 7.8, beam: 5.0, height: 1.0, nose: 0.5, finSpan: 0.58, finRake: 30, canopy: 0.55, thrusters: 2 },
    colours: { primary: 0xf4f6f8, secondary: 0x2b2f7a, accent: 0xa66cff },
  },
];

export function teamById(id: string): Team {
  const team = TEAMS.find((t) => t.id === id);
  if (!team) throw new Error(`Unknown team: ${id}`);
  return team;
}
