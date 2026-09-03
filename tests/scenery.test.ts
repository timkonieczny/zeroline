import { describe, expect, it } from 'vitest';
import { InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';
import { Track } from '@/track/Track';
import { meridianCoast } from '@/data/tracks/meridian-coast';
import { Skyline } from '@/track/scenery/Skyline';
import { Grandstands, type StandSite } from '@/track/scenery/Grandstands';
import { TrackPillars } from '@/track/scenery/TrackPillars';
import { SEA_LEVEL } from '@/track/scenery/Environment';
import { WALL_HEIGHT } from '@/track/TrackGeometry';

/** Eye height of a seated spectator above their seat, from `Grandstands`. */
const SEATED_EYE = 0.85;
import { LANE_CLEARANCE, LANE_HALF_WIDTH, skyHighwayLanes } from '@/track/scenery/SkyHighway';
import { placeCrowd } from '@/game/AudioDirector';

/**
 * The skyline is placed by a heuristic that pushes buildings out of the way of
 * the circuit and ducks them under the traffic lanes. Heuristics of that shape
 * are exactly the kind that quietly stop working, and the symptom — a tower
 * standing in the road — is only visible if you happen to drive that corner.
 * These tests read the placement back out of the instance matrices and check it.
 */

interface Box {
  centre: Vector3;
  /** Half the footprint's diagonal. */
  radius: number;
  base: number;
  top: number;
}

function readBoxes(mesh: InstancedMesh): Box[] {
  const matrix = new Matrix4();
  const position = new Vector3();
  const scale = new Vector3();
  const spin = new Quaternion();
  const boxes: Box[] = [];

  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, matrix);
    position.setFromMatrixPosition(matrix);
    matrix.decompose(new Vector3(), spin, scale);
    boxes.push({
      centre: position.clone(),
      radius: Math.hypot(scale.x, scale.z) * 0.5,
      // The tower geometry has its origin at the base.
      base: position.y,
      top: position.y + scale.y,
    });
  }
  return boxes;
}

function skylineMesh(skyline: Skyline): InstancedMesh {
  const mesh = skyline.group.children.find((child) => child.name === 'skyline');
  if (!(mesh instanceof InstancedMesh)) throw new Error('no skyline mesh');
  return mesh;
}

const track = new Track(meridianCoast);
const stands = new Grandstands(track);
// Built the way the stage builds it: the stands first, the city around them.
const skyline = new Skyline(track, stands.footprints);
const pillars = new TrackPillars(track);

function namedMesh(group: { children: { name: string }[] }, name: string): InstancedMesh {
  const mesh = group.children.find((child) => child.name === name);
  if (!(mesh instanceof InstancedMesh)) throw new Error(`no ${name} mesh`);
  return mesh;
}

describe('skyline placement', () => {
  const buildings = readBoxes(skylineMesh(skyline));

  it('places a city', () => {
    expect(buildings.length).toBeGreaterThan(120);
  });

  it('keeps every facade clear of the road, anywhere on the lap', () => {
    // Not just clear of the section that spawned it: the circuit doubles back,
    // and the overlaps that shipped were buildings hit by a *different* corner.
    const offenders: string[] = [];

    for (const building of buildings) {
      for (let s = 0; s < track.length; s += 6) {
        const frame = track.frameAt(s);
        // A road far above the roof or below the footings cannot clash.
        if (frame.position.y > building.top + 6) continue;
        if (frame.position.y < building.base - 6) continue;

        const gap = Math.hypot(
          building.centre.x - frame.position.x,
          building.centre.z - frame.position.z,
        ) - building.radius - frame.width * 0.5;

        if (gap < 0) {
          offenders.push(`s=${s.toFixed(0)} overlaps by ${(-gap).toFixed(1)} m`);
          break;
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('builds around the grandstands rather than through them', () => {
    for (const building of buildings) {
      for (const stand of stands.footprints) {
        const gap = Math.hypot(
          building.centre.x - stand.position.x,
          building.centre.z - stand.position.z,
        );
        expect(gap).toBeGreaterThanOrEqual(building.radius + stand.radius);
      }
    }
  });

  it('ducks under the sky highway rather than through it', () => {
    // Also the check on the shadow pass, which raises buildings and then rounds
    // up to a whole storey. The rounding is where the clearance gets lost.
    const lanes = skyHighwayLanes(track);
    const offenders: string[] = [];

    for (const building of buildings) {
      for (const lane of lanes) {
        const offsetX = building.centre.x - lane.originX;
        const offsetZ = building.centre.z - lane.originZ;
        const across = Math.abs(offsetX * lane.dirZ - offsetZ * lane.dirX);
        if (across > building.radius + LANE_HALF_WIDTH) continue;
        // A millimetre of slack: the clip puts roofs exactly at the clearance
        // on purpose, and instance matrices are stored as float32.
        if (building.top - (lane.altitude - LANE_CLEARANCE) > 0.01) {
          offenders.push(`top ${building.top.toFixed(0)} into lane at ${lane.altitude}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('stands the city in the water, not floating above it', () => {
    // Every building either meets the sea or sits on a platform deck a few
    // metres above it. None of them hang in mid-air, which is what the old
    // road-relative base did wherever the circuit climbed.
    for (const building of buildings) {
      expect(building.base).toBeGreaterThanOrEqual(-26);
      expect(building.base).toBeLessThan(-26 + 14);
    }
  });

  it('builds platforms and bridges', () => {
    const decks = skyline.group.children.find((child) => child.name === 'skyline-decks');
    expect(decks).toBeInstanceOf(InstancedMesh);
    expect((decks as InstancedMesh).count).toBeGreaterThan(8);
  });

  it('never lays a platform across the road', () => {
    // A platform is wider than the buildings standing on it, so a cluster that
    // cleared the circuit could still have its deck run over the racing line.
    const decks = skyline.group.children.find((child) => child.name === 'skyline-decks') as InstancedMesh;
    const matrix = new Matrix4();
    const position = new Vector3();
    const scale = new Vector3();
    const spin = new Quaternion();
    const offenders: string[] = [];

    for (let i = 0; i < decks.count; i++) {
      decks.getMatrixAt(i, matrix);
      position.setFromMatrixPosition(matrix);
      matrix.decompose(new Vector3(), spin, scale);
      // Bridges are long and thin and sit high; platforms are wide slabs at the
      // waterline. Only the slabs are tested here.
      if (position.y > -10) continue;

      for (let s = 0; s < track.length; s += 6) {
        const frame = track.frameAt(s);
        if (Math.abs(frame.position.y - (position.y + scale.y / 2)) > 12) continue;
        const dx = Math.max(0, Math.abs(frame.position.x - position.x) - scale.x / 2);
        const dz = Math.max(0, Math.abs(frame.position.z - position.z) - scale.z / 2);
        if (Math.hypot(dx, dz) < frame.width * 0.5) {
          offenders.push(`deck ${i} crosses the road at s=${s.toFixed(0)}`);
          break;
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

/**
 * The stands, the columns holding them up, and the crowd in them.
 *
 * Same argument as the skyline above: a grandstand fanning away from a corner,
 * a pillar through a traffic lane and a spectator seated in the middle of the
 * road all look plausible from the cockpit and are only visible from an angle
 * nobody drives at.
 */
/**
 * Everything seated in a track frame is oriented through a basis matrix, and a
 * track frame's `right` is `tangent x up` — so `(right, up, tangent)` is
 * left-handed and `makeBasis` on it has determinant -1. A quaternion cannot
 * represent a reflection, so `setFromRotationMatrix` discards it and hands back
 * an unrelated rotation: the stands shipped 25 degrees off the road at the grid
 * and 92 degrees off at half distance, with backfaces showing through.
 *
 * The determinant is the whole test. It cannot be seen from the cockpit on a
 * straight, it is not an assertion any placement test would have made, and the
 * next thing built against a frame will reach for the same three vectors.
 */
describe('orientation', () => {
  it('is handed the wrong way round by a track frame', () => {
    // The trap itself, stated once. Anybody reaching for these three vectors
    // to seat something on the road needs to negate one of them first, and
    // there is nothing about the names that says so.
    const frame = track.frameAt(track.startS);
    const asGiven = new Matrix4().makeBasis(frame.right, frame.up, frame.tangent);
    const corrected = new Matrix4().makeBasis(
      frame.right,
      frame.up,
      frame.tangent.clone().negate(),
    );

    expect(asGiven.determinant()).toBeLessThan(0);
    expect(corrected.determinant()).toBeGreaterThan(0);
  });

  it('points every piece of scenery along the road it sits on', () => {
    // A reflection cannot survive into a quaternion, so the determinant of the
    // instance matrix is no help — `setFromRotationMatrix` quietly drops it and
    // returns an unrelated rotation instead. Only the resulting *direction*
    // shows the fault, and it showed it plainly: the stands shipped 25 degrees
    // off the road at the grid and 92 degrees off at half distance.
    const matrix = new Matrix4();
    const spin = new Quaternion();
    const along = new Vector3();

    /** The closest any instance comes to running along the road at `s`. */
    const bestAlignment = (mesh: InstancedMesh, s: number): number => {
      const tangent = track.frameAt(s).tangent.clone();
      let best = 0;
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, matrix);
        matrix.decompose(new Vector3(), spin, new Vector3());
        along.set(0, 0, 1).applyQuaternion(spin);
        best = Math.max(best, Math.abs(along.dot(tangent)));
      }
      return best;
    };

    const stand = namedMesh(stands.group, 'grandstands');
    for (const site of stands.sites) {
      expect(bestAlignment(stand, site.s), `stand at s=${site.s.toFixed(0)}`).toBeGreaterThan(0.99);
    }

    // The capitals are banked with the road, so they carry the same fault.
    const capitals = namedMesh(pillars.group, 'track-pillar-capitals');
    for (const shaft of readBoxes(namedMesh(pillars.group, 'track-pillars'))) {
      const at = track.collision.query(shaft.centre).s;
      expect(bestAlignment(capitals, at), `capital at s=${at.toFixed(0)}`).toBeGreaterThan(0.99);
    }
  });
});

describe('grandstands', () => {
  it('keeps them off each other', () => {
    // The tight pair is the two at the grid, which face each other across the
    // road. Everything else is a straight apart.
    for (const a of stands.sites) {
      for (const b of stands.sites) {
        if (a === b) continue;
        expect(a.position.distanceTo(b.position)).toBeGreaterThan(40);
      }
    }
  });

  it('faces a second stand across the grid', () => {
    const atGrid = stands.sites.filter((site) => Math.abs(site.s - track.startS) < 1);
    expect(atGrid).toHaveLength(2);
    expect(atGrid[0]!.side).toBe(-atGrid[1]!.side);
  });

  it('alternates which side of the road they are on', () => {
    // Otherwise the circuit reads as having been built along one edge of itself.
    const sides = stands.sites.map((site) => site.side);
    for (let i = 1; i < sides.length; i++) expect(sides[i]).toBe(-sides[i - 1]!);
  });

  it('seats a crowd, all of it clear of the racing surface', () => {
    const crowd = namedMesh(stands.group, 'crowd');
    expect(crowd.count).toBeGreaterThan(1000);

    const matrix = new Matrix4();
    const seat = new Vector3();
    for (let i = 0; i < crowd.count; i++) {
      crowd.getMatrixAt(i, matrix);
      seat.setFromMatrixPosition(matrix);
      const at = track.collision.query(seat);
      expect(Math.abs(at.lateral)).toBeGreaterThan(track.frameAt(at.s).width * 0.5);
      expect(seat.y).toBeGreaterThan(SEA_LEVEL);
    }
  });

  it('gives every spectator a view over the barrier', () => {
    // The whole stand used to be built off the road plane, which sat the front
    // rows below both the track's wall and the stand's own rail: they were
    // looking at concrete, and from the cockpit they read as being under the
    // circuit. The stand's lift is derived from this sight line, so this is the
    // assertion the number exists to satisfy.
    const crowd = namedMesh(stands.group, 'crowd');
    const matrix = new Matrix4();
    const seat = new Vector3();
    const scale = new Vector3();
    const spin = new Quaternion();
    let lowest = Infinity;

    for (let i = 0; i < crowd.count; i++) {
      crowd.getMatrixAt(i, matrix);
      matrix.decompose(seat, spin, scale);
      // `height` is measured from the road surface, which is what the barrier
      // stands on — so the two are directly comparable.
      const eye = track.collision.query(seat).height + SEATED_EYE * scale.y;
      lowest = Math.min(lowest, eye);
    }

    expect(lowest).toBeGreaterThan(WALL_HEIGHT);
  });
});

describe('track pillars', () => {
  const shafts = readBoxes(namedMesh(pillars.group, 'track-pillars'));

  it('puts up a few, not a viaduct', () => {
    expect(shafts.length).toBeGreaterThan(2);
    expect(shafts.length).toBeLessThan(14);
  });

  it('stands every one of them in the water and under the road', () => {
    for (const shaft of shafts) {
      // The shaft's origin is its top, so `readBoxes` reports base as the top
      // and top as one span above it.
      expect(shaft.base).toBeGreaterThan(SEA_LEVEL);
      expect(shaft.base - (shaft.top - shaft.base)).toBeLessThan(SEA_LEVEL);
    }
  });

  it('never spears a traffic lane', () => {
    const lanes = skyHighwayLanes(track);
    for (const shaft of shafts) {
      for (const lane of lanes) {
        if (lane.altitude - LANE_CLEARANCE > shaft.base) continue;
        const across = Math.abs(
          (shaft.centre.x - lane.originX) * lane.dirZ - (shaft.centre.z - lane.originZ) * lane.dirX,
        );
        expect(across).toBeGreaterThan(LANE_HALF_WIDTH);
      }
    }
  });

  it('never stands one inside a tunnel', () => {
    for (const shaft of shafts) {
      expect(track.isInTunnel(track.collision.query(shaft.centre).s)).toBe(false);
    }
  });
});

/**
 * The crowd noise's one piece of real arithmetic.
 *
 * The lap wraps, so the stand at the grid is beside a craft coming out of the
 * last corner rather than a full lap away from it. Get that wrong and the pit
 * straight's crowd cuts out at the line, which is the one place it must not.
 */
describe('crowd placement', () => {
  const LENGTH = 3000;
  const site = (s: number, side: -1 | 1): StandSite => ({ position: new Vector3(), s, side });

  it('is silent with nothing to hear', () => {
    expect(placeCrowd(100, LENGTH, [])).toEqual({ level: 0, pan: 0 });
  });

  it('is loudest alongside the stand', () => {
    const at = placeCrowd(300, LENGTH, [site(300, 1)]);
    expect(at.level).toBeCloseTo(1, 6);
    expect(at.pan).toBeCloseTo(1, 6);
  });

  it('hears the grid stand from the last corner', () => {
    // Forty metres short of the line, with the stand ten metres past it.
    const wrapped = placeCrowd(LENGTH - 40, LENGTH, [site(10, -1)]);
    const same = placeCrowd(60, LENGTH, [site(10, -1)]);
    expect(wrapped.level).toBeCloseTo(same.level, 6);
    expect(wrapped.level).toBeGreaterThan(0.6);
  });

  it('centres a stand that is still ahead and swings it out on the way past', () => {
    const stand = [site(1500, 1)];
    const far = placeCrowd(1300, LENGTH, stand);
    const close = placeCrowd(1470, LENGTH, stand);

    expect(far.pan).toBe(0);
    expect(close.pan).toBeGreaterThan(far.pan);
    expect(close.level).toBeGreaterThan(far.level);
  });

  it('picks the nearest of several', () => {
    const many = [site(200, 1), site(1200, -1), site(2400, 1)];
    expect(placeCrowd(1250, LENGTH, many).pan).toBeLessThan(0);
    expect(placeCrowd(2350, LENGTH, many).pan).toBeGreaterThan(0);
  });

  it('goes quiet between stands', () => {
    expect(placeCrowd(750, LENGTH, [site(0, 1), site(1500, -1)]).level).toBe(0);
  });
});
