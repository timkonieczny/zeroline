import type { Rng } from '@/core/Rng';

export type WeaponId =
  | 'turbo'
  | 'rockets'
  | 'missile'
  | 'mines'
  | 'bomb'
  | 'plasma'
  | 'quake'
  | 'shield'
  | 'autopilot';

export type WeaponKind = 'offensive' | 'defensive' | 'utility';

export interface WeaponDef {
  id: WeaponId;
  /** Full name, as shown on pickup. */
  name: string;
  /** Three-letter tag for the HUD. */
  tag: string;
  /** One line of pilot-manual copy for the weapon list. */
  blurb: string;
  kind: WeaponKind;
  /** Shots before the weapon is spent. */
  ammo: number;
  /** Shield energy returned by absorbing this weapon instead of firing it. */
  absorb: number;
  /**
   * Draw weight for a craft at the front, in the middle, and at the back of the
   * field. This is the whole balance of the item game in one table.
   */
  weights: readonly [front: number, middle: number, back: number];
}

/**
 * The weapon set, lifted from WipEout Pure and tuned for a field of eight.
 *
 * The three-bucket weight table is the important part. A leader draws defensive
 * and utility items; a craft at the back draws the heavy ordnance. That is what
 * keeps a race close without rubber-banding the physics, and it is why absorbing
 * a weapon for shield energy is a real decision rather than a fallback — the
 * item you are holding is worth more the further back you are.
 */
export const WEAPONS: Record<WeaponId, WeaponDef> = {
  turbo: {
    id: 'turbo',
    name: 'Turbo',
    tag: 'TRB',
    blurb: 'A hard shove down the straight. Free speed, no risk.',
    kind: 'utility',
    ammo: 1,
    absorb: 12,
    weights: [26, 22, 12],
  },
  rockets: {
    id: 'rockets',
    name: 'Rockets',
    tag: 'RKT',
    blurb: 'Three unguided rockets. Aim yourself; the track will not help.',
    kind: 'offensive',
    ammo: 3,
    absorb: 14,
    weights: [10, 20, 20],
  },
  missile: {
    id: 'missile',
    name: 'Homing Missile',
    tag: 'MSL',
    blurb: 'Locks the craft ahead and follows it round the corner.',
    kind: 'offensive',
    ammo: 1,
    absorb: 18,
    weights: [4, 18, 24],
  },
  mines: {
    id: 'mines',
    name: 'Mines',
    tag: 'MIN',
    blurb: 'Five charges across the road behind you. Defensive, and unkind.',
    kind: 'offensive',
    ammo: 1,
    absorb: 14,
    weights: [20, 16, 8],
  },
  bomb: {
    id: 'bomb',
    name: 'Plasma Bomb',
    tag: 'BMB',
    blurb: 'One heavy charge with a wide blast. Drop it and drive away.',
    kind: 'offensive',
    ammo: 1,
    absorb: 20,
    weights: [8, 14, 16],
  },
  plasma: {
    id: 'plasma',
    name: 'Plasma Bolt',
    tag: 'PLS',
    blurb: 'Flat, fast and brutal. Hard to aim, ends a race when it lands.',
    kind: 'offensive',
    ammo: 1,
    absorb: 26,
    weights: [1, 6, 16],
  },
  quake: {
    id: 'quake',
    name: 'Quake',
    tag: 'QKE',
    blurb: 'A shockwave down the road ahead. Everything in the lane is hit.',
    kind: 'offensive',
    ammo: 1,
    absorb: 28,
    weights: [0, 4, 14],
  },
  shield: {
    id: 'shield',
    name: 'Deflector',
    tag: 'SHD',
    blurb: 'Six seconds of nothing touching you.',
    kind: 'defensive',
    ammo: 1,
    absorb: 22,
    weights: [18, 14, 10],
  },
  autopilot: {
    id: 'autopilot',
    name: 'Autopilot',
    tag: 'ATP',
    blurb: 'Hands off. The line is perfect and you cannot steer.',
    kind: 'utility',
    ammo: 1,
    absorb: 16,
    weights: [13, 12, 8],
  },
};

export const WEAPON_IDS = Object.keys(WEAPONS) as WeaponId[];

/** What a craft is currently holding. */
export interface HeldWeapon {
  id: WeaponId;
  /** Shots left. */
  ammo: number;
  /** Seconds since it was picked up, for the HUD's pickup flourish. */
  age: number;
}

/**
 * Rolls a weapon for a craft in `position` of `fieldSize`.
 *
 * The three authored weights are interpolated across the field rather than
 * bucketed, so an eight-car grid and a two-car time trial both behave sensibly
 * and there is no cliff between third and fourth.
 */
export function rollWeapon(rng: Rng, position: number, fieldSize: number): HeldWeapon {
  const t = fieldSize > 1 ? (position - 1) / (fieldSize - 1) : 0;
  const weights = WEAPON_IDS.map((id) => {
    const [front, middle, back] = WEAPONS[id].weights;
    return t < 0.5 ? front + (middle - front) * (t * 2) : middle + (back - middle) * ((t - 0.5) * 2);
  });
  const id = WEAPON_IDS[rng.weighted(weights)]!;
  return { id, ammo: WEAPONS[id].ammo, age: 0 };
}
