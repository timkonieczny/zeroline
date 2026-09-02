import { Quaternion, Vector3, type PerspectiveCamera } from 'three';
import type { Track } from '@/track/Track';
import { clamp01, wrap } from '@/core/math';

/** Seconds each establishing shot holds. */
const SHOT_TIME = 3;
/** Seconds the camera takes to orbit in and hand over to the chase. */
const ORBIT_TIME = 2.6;
/** Radians the orbit sweeps before settling behind the craft. */
const ORBIT_SWEEP = 2.3;
/** Where the orbit starts, relative to the craft: metres out and up. */
const ORBIT_RADIUS = 26;
const ORBIT_HEIGHT = 11;
/** Seconds of orbit left when the intro is skipped, so it still settles. */
const SKIP_TAIL = 0.4;
/**
 * Metres behind the start line the front row sits.
 *
 * `Track.gridSlot` lays eight craft two abreast in rows sixteen metres apart,
 * starting here, so the field runs from twenty-two metres back to seventy.
 */
const GRID_FRONT = 22;

/**
 * One camera move: two placements relative to a point on the circuit, eased
 * between over the length of the shot.
 *
 * Offsets are in the track's own frame at that arc length — right, up, and
 * along the tangent — so a shot composes itself against the road rather than
 * against the world, and the same numbers frame a banked corner and a flat
 * straight alike.
 */
interface Shot {
  /** Arc length the shot is composed around. */
  s: number;
  from: [right: number, up: number, along: number];
  to: [right: number, up: number, along: number];
  /** Where the camera looks, in the same frame. */
  target: [right: number, up: number, along: number];
}

const _position = new Vector3();
const _target = new Vector3();
const _chasePosition = new Vector3();
const _chaseQuaternion = new Quaternion();
const _craft = new Vector3();
const _look = new Vector3();
const _orbit = new Vector3();

/** Nothing allocates on the per-frame path. */
const WORLD_UP = new Vector3(0, 1, 0);

/** Smootherstep: zero velocity at both ends, so a shot never starts abruptly. */
function ease(t: number): number {
  const x = clamp01(t);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/**
 * The shots before a race.
 *
 * Two of the circuit — its tunnel and its tightest corner, both found from the
 * track's own data rather than authored per circuit, so a new track gets an
 * intro for free — then the grid, then an orbit that hands the camera to the
 * chase.
 *
 * The simulation is held for the whole of it, so nothing moves in these shots
 * except the camera. That is deliberate: it is the circuit being introduced,
 * and a field creeping forward under a cinematic would give the countdown away.
 */
export class RaceIntro {
  private elapsed = 0;
  private readonly shots: Shot[];

  constructor(track: Track, startS: number) {
    this.shots = RaceIntro.compose(track, startS);
  }

  /** True while the intro still owns the camera. */
  get active(): boolean {
    return this.elapsed < SHOT_TIME * this.shots.length + ORBIT_TIME;
  }

  /** True while the establishing shots are running, so the HUD stays away. */
  get cinematic(): boolean {
    return this.elapsed < SHOT_TIME * this.shots.length;
  }

  /** Cuts to the end of the orbit, leaving just enough to settle. */
  skip(): void {
    this.elapsed = Math.max(this.elapsed, SHOT_TIME * this.shots.length + ORBIT_TIME - SKIP_TAIL);
  }

  /**
   * Places the camera for this frame.
   *
   * Called after the chase camera has had its turn, so what is already on the
   * camera is where the race wants it — the orbit blends into that rather than
   * aiming at a position computed twice and disagreeing at the handover.
   */
  update(camera: PerspectiveCamera, track: Track, craftPosition: Vector3, dt: number): void {
    this.elapsed += dt;

    _chasePosition.copy(camera.position);
    _chaseQuaternion.copy(camera.quaternion);
    _craft.copy(craftPosition);

    const shotsEnd = SHOT_TIME * this.shots.length;
    if (this.elapsed < shotsEnd) {
      const index = Math.min(this.shots.length - 1, Math.floor(this.elapsed / SHOT_TIME));
      RaceIntro.placeShot(camera, track, this.shots[index]!, (this.elapsed - index * SHOT_TIME) / SHOT_TIME);
      return;
    }

    // The orbit: a slow arc around the craft, unwinding onto the chase camera's
    // own position as it goes.
    const t = ease((this.elapsed - shotsEnd) / ORBIT_TIME);
    const angle = ORBIT_SWEEP * (1 - t);

    _orbit
      .copy(_craft)
      .add(
        _position
          .subVectors(_chasePosition, _craft)
          .setLength(ORBIT_RADIUS)
          .applyAxisAngle(WORLD_UP, angle),
      );
    _orbit.y = _craft.y + ORBIT_HEIGHT;

    // Aimed on the camera itself, not on a helper object whose quaternion is
    // then copied across: `Object3D.lookAt` puts +Z on its target and a camera
    // looks down -Z, so the copy points the shot exactly backwards.
    camera.position.copy(_orbit);
    camera.up.copy(WORLD_UP);
    camera.lookAt(_craft);

    camera.position.lerpVectors(_orbit, _chasePosition, t);
    camera.quaternion.slerp(_chaseQuaternion, t);
  }

  /** Frames one establishing shot at its point along the circuit. */
  private static placeShot(camera: PerspectiveCamera, track: Track, shot: Shot, progress: number): void {
    const frame = track.frameAt(shot.s);
    const t = ease(progress);

    const at = (offset: [number, number, number], out: Vector3): Vector3 =>
      out
        .copy(frame.position)
        .addScaledVector(frame.right, offset[0])
        .addScaledVector(frame.up, offset[1])
        .addScaledVector(frame.tangent, offset[2]);

    at(shot.from, _position);
    at(shot.to, _target);
    camera.position.lerpVectors(_position, _target, t);

    camera.up.copy(WORLD_UP);
    camera.lookAt(at(shot.target, _look));
  }

  /**
   * Picks what to show, from the circuit's own geometry.
   *
   * The tunnel and the tightest corner are the two features every circuit in
   * this game has and every circuit makes something of — one is the only place
   * the sky disappears, the other the only place the road doubles back. If a
   * circuit has no tunnel, the second-tightest corner stands in.
   */
  private static compose(track: Track, startS: number): Shot[] {
    const shots: Shot[] = [];
    const corners = [...track.corners].sort((a, b) => a.radius - b.radius);

    const tunnel = track.tunnels
      .slice()
      .sort((a, b) => wrap(b.toS - b.fromS, track.length) - wrap(a.toS - a.fromS, track.length))[0];

    if (tunnel) {
      // Outside the mouth, off to one side and above the road, drifting in
      // toward the portal: the one shot on the circuit with a silhouette.
      const s = wrap(tunnel.fromS - 34, track.length);
      shots.push({
        s,
        from: [42, 20, -30],
        to: [26, 13, 6],
        target: [0, 6, 46],
      });
    }

    // Two features. With a tunnel that is the tunnel and the tightest corner;
    // without one, the two tightest corners.
    for (const corner of corners.slice(0, tunnel ? 1 : 2)) {
      // High on the outside, looking down into the apex, easing round and down.
      // The outside of a right-hander is its left, so the sign follows the turn.
      const side = corner.turn >= 0 ? -1 : 1;
      shots.push({
        s: wrap((corner.fromS + corner.toS) / 2, track.length),
        from: [side * 40, 22, -34],
        to: [side * 26, 12, -6],
        target: [0, 1, 14],
      });
    }

    // The grid, from ahead of the front row and low, rising as it draws back.
    //
    // Composed on the front row rather than on the field's middle or the start
    // line. Both of those put the camera among the craft, where the near ones
    // pass underneath the frame and the far ones are fifty metres off: the
    // whole grid was in shot and none of it was worth looking at.
    shots.push({
      s: wrap(startS - GRID_FRONT, track.length),
      from: [8, 3.2, 12],
      to: [15, 9, 26],
      target: [0, 1.5, -24],
    });

    return shots;
  }
}
