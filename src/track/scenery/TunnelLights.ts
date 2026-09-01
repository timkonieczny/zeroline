import { Group, PointLight, Vector3 } from 'three';
import type { Track } from '../Track';

/**
 * How many lamps exist as actual lights at any moment.
 *
 * A circuit's tunnels hold well over a hundred lamp positions. Six real ones,
 * moved to whichever positions are nearest the camera, is indistinguishable from
 * lighting all of them and costs a fixed six shadowless lights instead of a
 * per-tunnel forward-lighting bill.
 */
const POOL = 6;
/** Metres of tunnel a single lamp reaches. */
const RANGE = 46;
/** Peak intensity of one lamp. */
const INTENSITY = 260;
/** Height above the road, in metres. Just under the crown of the arch. */
const HEIGHT = 12.5;
const _position = new Vector3();

/** One lamp position along the circuit, resolved once at load. */
interface Lamp {
  s: number;
  position: Vector3;
}

/**
 * The lights inside the tunnels, as light rather than as paint.
 *
 * The tunnel material still draws its emissive runs — that is what you see when
 * you look at the ceiling — but the runs alone lit nothing: craft drove into a
 * tunnel and went flat, because the sun cannot reach them in there and nothing
 * else was trying to. These are real point lights, so a craft passing under one
 * picks up a highlight along its flank and the road brightens under it.
 *
 * They are pooled and teleported rather than created per lamp. Nothing about a
 * point light remembers where it was last frame, so moving one is free, and the
 * player only ever sees a few metres of tunnel at a time.
 */
export class TunnelLights {
  readonly group = new Group();
  private readonly lamps: Lamp[] = [];
  private readonly pool: PointLight[] = [];

  constructor(track: Track) {
    for (const tunnel of track.tunnels) {
      const span = tunnel.toS > tunnel.fromS
        ? tunnel.toS - tunnel.fromS
        : tunnel.toS + track.length - tunnel.fromS;
      const count = Math.max(1, Math.round(span / tunnel.lightSpacing));

      for (let i = 0; i < count; i++) {
        const s = (tunnel.fromS + (i + 0.5) * (span / count)) % track.length;
        const frame = track.frameAt(s);
        // On the centreline between the two runs, so one light stands in for
        // both strips and throws to both walls at once.
        _position.copy(frame.position).addScaledVector(frame.up, HEIGHT);
        this.lamps.push({ s, position: _position.clone() });
      }
    }

    for (let i = 0; i < POOL; i++) {
      const light = new PointLight(0xbfe6ff, 0, RANGE, 1.6);
      light.castShadow = false;
      light.visible = false;
      this.pool.push(light);
      this.group.add(light);
    }
  }

  /**
   * Moves the pool onto the lamps nearest the camera.
   *
   * Distance is measured in world space rather than along the circuit: a tunnel
   * on the far side of a hairpin can be close in arc length and a long way away
   * in the only sense that matters to a light.
   */
  update(focus: Vector3): void {
    if (this.lamps.length === 0) return;

    // Partial selection: the pool is tiny, so finding the nearest few by
    // repeated scan beats sorting a hundred-odd candidates every frame.
    const chosen: { lamp: Lamp; distance: number }[] = [];
    for (const lamp of this.lamps) {
      const distance = lamp.position.distanceTo(focus);
      if (distance > RANGE * 1.6) continue;
      if (chosen.length < POOL) {
        chosen.push({ lamp, distance });
        continue;
      }
      let worst = 0;
      for (let i = 1; i < chosen.length; i++) {
        if (chosen[i]!.distance > chosen[worst]!.distance) worst = i;
      }
      if (distance < chosen[worst]!.distance) chosen[worst] = { lamp, distance };
    }

    for (let i = 0; i < POOL; i++) {
      const light = this.pool[i]!;
      const pick = chosen[i];
      if (!pick) {
        light.visible = false;
        continue;
      }
      light.visible = true;
      light.position.copy(pick.lamp.position);
      // Fades out toward the edge of its reach rather than switching off, or a
      // lamp being recycled onto a new position pops.
      const fade = 1 - Math.min(1, pick.distance / (RANGE * 1.6));
      light.intensity = INTENSITY * fade * fade;
    }
  }

  dispose(): void {
    for (const light of this.pool) light.dispose();
  }
}
