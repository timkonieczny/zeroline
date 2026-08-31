import type { TrackDefinition } from '@/track/TrackTypes';

/**
 * MERIDIAN COAST — CIRCUIT 01
 *
 * The league's opening round, and the circuit every rookie learns on. It drops
 * off the start/finish viaduct into the Harbour Hook, sweeps along the sea wall
 * at water level, snaps through the chicane, dives under the freight terminal,
 * then climbs the banked Meridian Bend to the hairpin and the elevated back
 * straight. Sector three is one long right past the grandstands.
 *
 * 3.25 km, nine corners, 34 m of elevation change. Fast and wide early so the
 * pack is still fighting on lap one, tight and technical through the chicane
 * where a clean line actually pays, and one long right past the grandstands to
 * finish where a tow decides the order.
 *
 * Bank is left unspecified on every corner: it is derived from the radius, so
 * retuning a corner's speed cannot leave its camber behind.
 */
export const meridianCoast: TrackDefinition = {
  id: 'meridian-coast',
  name: 'Meridian Coast',
  subtitle: 'Circuit 01',
  region: 'MC',
  laps: 3,
  spacing: 2,
  // Far enough down the main straight that the whole grid sits on flat, level
  // road rather than trailing back into the banking at T9.
  startLine: 0.1,

  corners: [
    { name: 'T1 Harbour Hook', x: 520, z: 0, radius: 90, height: -6, width: 34 },
    { name: 'T2 Seawall Sweep', x: 461, z: 415, radius: 300, height: -12, width: 36 },
    { name: 'T3 Chicane In', x: 138, z: 553, radius: 80, height: -16, width: 30 },
    { name: 'T4 Chicane Out', x: -32, z: 459, radius: 80, height: -15, width: 30 },
    { name: 'T5 Meridian Bend', x: -431, z: 446, radius: 220, height: 8, width: 36 },
    { name: 'T6 Hairpin', x: -539, z: 38, radius: 55, height: 18, width: 30 },
    { name: 'T7 Terminal Kink', x: -291, z: -155, radius: 200, height: 16, width: 34 },
    { name: 'T8 Grandstand Sweep', x: -145, z: -447, radius: 260, height: 8, width: 36 },
    { name: 'T9 Stadium', x: 297, z: -475, radius: 130, height: 2, width: 38 },
  ],

  tunnels: [{ from: 0.425, to: 0.495, height: 15, lightSpacing: 22 }],

  boostPads: [
    { at: 0.06, offset: 0.0 },
    { at: 0.175, offset: -0.45 },
    { at: 0.325, offset: 0.45 },
    { at: 0.46, offset: 0.0 },
    { at: 0.62, offset: -0.4 },
    { at: 0.7, offset: 0.0 },
    { at: 0.92, offset: 0.4 },
  ],

  pickupPads: [
    { at: 0.1, offset: -0.5 },
    { at: 0.1, offset: 0.0 },
    { at: 0.1, offset: 0.5 },
    { at: 0.33, offset: -0.5 },
    { at: 0.33, offset: 0.0 },
    { at: 0.33, offset: 0.5 },
    { at: 0.5, offset: -0.5 },
    { at: 0.5, offset: 0.0 },
    { at: 0.5, offset: 0.5 },
    { at: 0.685, offset: -0.5 },
    { at: 0.685, offset: 0.0 },
    { at: 0.685, offset: 0.5 },
    { at: 0.9, offset: -0.45 },
    { at: 0.9, offset: 0.45 },
  ],

  districts: [
    { from: 0.0, to: 0.31, theme: 'harbour', accent: 0x24d4ff },
    { from: 0.31, to: 0.425, theme: 'canyon', accent: 0xff7a2f },
    { from: 0.425, to: 0.5, theme: 'terminal', accent: 0xff2f6e },
    { from: 0.5, to: 0.78, theme: 'towers', accent: 0x2fff9e },
    { from: 0.78, to: 1.0, theme: 'stadium', accent: 0xffb020 },
  ],

  sun: {
    azimuth: 132,
    elevation: 46,
    colour: 0xfff2dc,
    intensity: 3.3,
  },

  sky: {
    horizon: 0xdff0ff,
    // A deeper, more saturated zenith. This is a utopian league in high summer,
    // not an overcast test session.
    zenith: 0x1f6fd8,
    ground: 0x8fb4c9,
    fogDensity: 0.00032,
  },
};
