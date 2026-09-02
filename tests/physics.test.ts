import { beforeEach, describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { Track } from '@/track/Track';
import { meridianCoast } from '@/data/tracks/meridian-coast';
import { Craft } from '@/game/Craft';
import { placeOnGrid, respawn, stepCraft } from '@/game/Physics';
import { createInputSnapshot, type InputSnapshot } from '@/game/InputSnapshot';
import { teamById } from '@/data/teams';
import { speedClassById } from '@/game/Handling';
import { provingGround } from './helpers/testTracks';

const TICK = 1 / 120;
/** The real circuit, for anything that needs corners and barriers. */
const track = new Track(meridianCoast);
/** Long straights and a wide road, for anything that needs room to run. */
const flat = provingGround();

function makeCraft(where: Track = track, teamId = 'auroc'): Craft {
  const craft = new Craft(0, teamById(teamId), speedClassById('flash'), 'player');
  placeOnGrid(craft, where, 0);
  return craft;
}

/** Runs `seconds` of simulation with a fixed input. */
function run(craft: Craft, input: InputSnapshot, seconds: number, where: Track = track): void {
  const ticks = Math.round(seconds / TICK);
  for (let i = 0; i < ticks; i++) {
    craft.beginTick();
    stepCraft(craft, input, where, TICK);
  }
}

describe('hover physics', () => {
  let craft: Craft;
  let input: InputSnapshot;

  beforeEach(() => {
    craft = makeCraft();
    input = createInputSnapshot();
  });

  it('settles to its ride height and stays there', () => {
    run(craft, input, 3);
    expect(craft.state.height).toBeGreaterThan(craft.handling.rideHeight - 0.6);
    expect(craft.state.height).toBeLessThan(craft.handling.rideHeight + 0.6);
    expect(craft.state.grounded).toBe(true);
  });

  it('drops onto the road from a height without launching back off it', () => {
    craft.state.position.addScaledVector(new Vector3(0, 1, 0), 5);
    run(craft, input, 4);
    expect(craft.state.height).toBeLessThan(craft.handling.rideHeight + 1.2);
    expect(craft.state.height).toBeGreaterThan(-0.1);
  });

  it('converges on top speed under full thrust, and no further', () => {
    const runner = makeCraft(flat);
    run(runner, { ...input, thrust: 1 }, 30, flat);
    // Quadratic drag is solved against thrust, so this is the design target.
    expect(runner.telemetry.speed).toBeGreaterThan(runner.handling.topSpeed * 0.95);
    expect(runner.telemetry.speed).toBeLessThanOrEqual(runner.handling.topSpeed + 0.5);
  });

  it('never exceeds top speed unless boosting', () => {
    const runner = makeCraft(flat);
    run(runner, { ...input, thrust: 1 }, 20, flat);
    const cruising = runner.telemetry.speed;

    runner.state.boost = 5;
    run(runner, { ...input, thrust: 1 }, 4, flat);

    expect(runner.telemetry.speed).toBeGreaterThan(cruising);
    expect(runner.telemetry.speed).toBeLessThanOrEqual(
      runner.handling.topSpeed * runner.handling.boostSpeed + 0.5,
    );
  });

  it('steers right on positive input and left on negative', () => {
    const right = makeCraft(flat);
    run(right, { ...input, thrust: 1 }, 4, flat);
    run(right, { ...input, thrust: 1, steer: 1 }, 1, flat);
    expect(right.state.yawRate).toBeGreaterThan(0);

    const left = makeCraft(flat);
    run(left, { ...input, thrust: 1 }, 4, flat);
    run(left, { ...input, thrust: 1, steer: -1 }, 1, flat);
    expect(left.state.yawRate).toBeLessThan(0);
  });

  it('yaws toward the airbrake being held', () => {
    const runner = makeCraft(flat);
    run(runner, { ...input, thrust: 1 }, 4, flat);
    run(runner, { ...input, thrust: 1, brakeRight: 1 }, 0.8, flat);
    expect(runner.state.yawRate).toBeGreaterThan(0.2);
  });

  it('sheds speed when both airbrakes are held', () => {
    const runner = makeCraft(flat);
    run(runner, { ...input, thrust: 1 }, 20, flat);
    const before = runner.telemetry.speed;
    run(runner, { ...input, brakeLeft: 1, brakeRight: 1 }, 2, flat);
    expect(runner.telemetry.speed).toBeLessThan(before * 0.75);
  });

  it('kicks sideways on a sideshift without changing heading', () => {
    const runner = makeCraft(flat);
    run(runner, { ...input, thrust: 1 }, 4, flat);
    const heading = runner.state.forward.clone();
    const before = runner.state.lateral;

    runner.beginTick();
    stepCraft(runner, { ...input, thrust: 1, sideshift: 1 }, flat, TICK);
    // Let the impulse actually carry the craft sideways.
    run(runner, { ...input, thrust: 1 }, 0.25, flat);

    expect(runner.state.lateral).toBeGreaterThan(before + 0.5);
    expect(runner.state.forward.dot(heading)).toBeGreaterThan(0.97);
  });

  it('keeps the craft on the road however hard it is driven at a wall', () => {
    for (let i = 0; i < 120 * 25; i++) {
      craft.beginTick();
      stepCraft(craft, { ...input, thrust: 1, steer: 1 }, track, TICK);
      const halfWidth = track.spline.widthAtS(craft.state.s) * 0.5;
      expect(Math.abs(craft.state.lateral)).toBeLessThanOrEqual(halfWidth + 0.5);
    }
  });

  it('damages the craft on a hard wall impact', () => {
    const runner = makeCraft(flat);
    run(runner, { ...input, thrust: 1 }, 10, flat);
    const full = runner.state.shield;

    // Throw it sideways into the barrier from the middle of a wide straight.
    // Lateral grip bleeds the kick away quickly, so it has to be a big one to
    // actually cover the twenty metres to the wall.
    const frame = flat.frameAt(runner.state.s);
    runner.state.velocity.addScaledVector(frame.right, 240);
    run(runner, { ...input, thrust: 1 }, 1, flat);

    expect(runner.state.shield).toBeLessThan(full);
    expect(runner.state.shield).toBeGreaterThan(0);
  });

  it('leaves the shield alone when merely brushing the barrier', () => {
    const runner = makeCraft(flat);
    run(runner, { ...input, thrust: 1 }, 10, flat);
    const full = runner.state.shield;

    const frame = flat.frameAt(runner.state.s);
    runner.state.velocity.addScaledVector(frame.right, 3);
    run(runner, { ...input, thrust: 1 }, 2, flat);

    expect(runner.state.shield).toBeCloseTo(full, 5);
  });

  it('produces no NaN over a long run at full attack', () => {
    const drive = { ...input, thrust: 1 };
    for (let i = 0; i < 120 * 90; i++) {
      craft.beginTick();
      drive.steer = Math.sin(i * 0.01);
      drive.brakeLeft = i % 700 < 90 ? 1 : 0;
      stepCraft(craft, drive, track, TICK);
    }
    const st = craft.state;
    for (const value of [st.position.x, st.position.y, st.position.z, st.velocity.x, st.s, st.lateral, st.height]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(st.forward.length()).toBeCloseTo(1, 4);
    expect(st.up.length()).toBeCloseTo(1, 4);
  });

  it('is deterministic: identical inputs give identical results', () => {
    const inputs = Array.from({ length: 600 }, (_, i) => ({
      ...createInputSnapshot(),
      thrust: 1,
      steer: Math.sin(i * 0.03),
    }));

    const drive = (c: Craft): number[] => {
      for (const step of inputs) {
        c.beginTick();
        stepCraft(c, step, track, TICK);
      }
      return c.state.position.toArray();
    };

    expect(drive(makeCraft())).toEqual(drive(makeCraft()));
  });

  it('recovers a craft that falls off the world', () => {
    craft.state.position.y -= 200;
    craft.beginTick();
    stepCraft(craft, input, track, TICK);
    expect(craft.state.height).toBeGreaterThan(0);
    expect(craft.state.respawnGrace).toBeGreaterThan(0);
  });

  it('puts a respawned craft back on the road facing forwards', () => {
    run(craft, { ...input, thrust: 1 }, 6);
    const before = craft.state.s;
    respawn(craft, track);
    const frame = track.frameAt(craft.state.s);
    expect(craft.state.s).toBeCloseTo(before, 1);
    expect(craft.state.forward.dot(frame.tangent)).toBeGreaterThan(0.99);
    expect(craft.state.velocity.dot(frame.tangent)).toBeGreaterThan(0);
  });
});

describe('handling profiles', () => {
  it('gives each constructor the character its ratings promise', () => {
    const flash = speedClassById('flash');
    const kestrel = new Craft(0, teamById('kestrel'), flash, 'ai');
    const halcyon = new Craft(1, teamById('halcyon'), flash, 'ai');
    const sabre = new Craft(2, teamById('sabre9'), flash, 'ai');
    const ionflux = new Craft(3, teamById('ionflux'), flash, 'ai');

    expect(kestrel.handling.topSpeed).toBeGreaterThan(halcyon.handling.topSpeed);
    expect(halcyon.handling.turnRateLow).toBeGreaterThan(kestrel.handling.turnRateLow);
    expect(sabre.handling.shieldMax).toBeGreaterThan(kestrel.handling.shieldMax);
    expect(ionflux.handling.thrust).toBeGreaterThan(sabre.handling.thrust);
  });

  it('scales cleanly across the speed classes', () => {
    const team = teamById('auroc');
    const speeds = (['vector', 'venom', 'flash', 'rapier'] as const).map(
      (id) => new Craft(0, team, speedClassById(id), 'ai').handling.topSpeed,
    );
    for (let i = 1; i < speeds.length; i++) {
      expect(speeds[i]!).toBeGreaterThan(speeds[i - 1]!);
    }
  });
});

/**
 * The renderer blends `previous` into `state`, so anything that teleports a
 * craft has to move both. Unseeded on a fresh grid, the whole field draws
 * somewhere between the world origin and the start line — invisible while the
 * first tick was one frame away, obvious now the pre-race intro holds the
 * simulation for twelve seconds.
 */
describe('render state across a teleport', () => {
  it('seeds the previous state on the grid', () => {
    const craft = makeCraft();

    expect(craft.previous.position.distanceTo(craft.state.position)).toBe(0);
    expect(craft.previous.s).toBe(craft.state.s);

    // Which is the point: no blend, at any alpha.
    const out = new Vector3();
    craft.sampleRender(0, out, new Quaternion());
    expect(out.distanceTo(craft.state.position)).toBe(0);
  });

  it('seeds it again on respawn', () => {
    const craft = makeCraft();
    run(craft, { ...createInputSnapshot(), thrust: 1 }, 2);
    const before = craft.state.position.clone();

    respawn(craft, track);

    expect(craft.state.position.distanceTo(before)).toBeGreaterThan(0);
    expect(craft.previous.position.distanceTo(craft.state.position)).toBe(0);
  });
});
