import { uniform } from 'three/tsl';

/**
 * The simulation's own shader clock.
 *
 * TSL's built-in `time` is driven by the renderer and advances with every frame
 * it draws, which is correct for anything cosmetic and wrong for anything that
 * belongs to the race. A paused game still renders — the panel has to animate —
 * so materials keyed off `time` carried on running: the speed pads kept
 * scrolling their chevrons and the weapon pads kept turning their colour wheel
 * behind a screen that says the race is held.
 *
 * Anything animated that is part of the world reads this instead, and it only
 * moves when the world does. Anything that belongs to the interface or to the
 * showroom keeps using `time`, because those should keep moving.
 */
export const simTime = uniform(0);

/** Advances the world's clock. Called once per rendered frame, with the world's step. */
export function advanceSimTime(dt: number): void {
  simTime.value += dt;
}
