import { describe, expect, it } from 'vitest';
import { InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';
import { Track } from '@/track/Track';
import { meridianCoast } from '@/data/tracks/meridian-coast';
import { Skyline } from '@/track/scenery/Skyline';
import { LANE_CLEARANCE, LANE_HALF_WIDTH, skyHighwayLanes } from '@/track/scenery/SkyHighway';

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

describe('skyline placement', () => {
  const track = new Track(meridianCoast);
  const skyline = new Skyline(track);
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

  it('ducks under the sky highway rather than through it', () => {
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
});
