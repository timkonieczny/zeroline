import { BufferAttribute, BufferGeometry, CircleGeometry, Color, Group, Mesh, PlaneGeometry, Vector2 } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { uniform } from 'three/tsl';
import { panelMaterial } from '@/ui/Text';
import type { Track } from '@/track/Track';
import type { Craft } from './Craft';

/** Size of the map's longest side, in layout pixels. */
const MAP_SIZE = 168;
/** Thickness of the drawn circuit, in pixels. */
const TRACK_WIDTH = 4;
/** Radius of a craft blip, in pixels. */
const BLIP_RADIUS = 5;
/** Blip radius for the player, which needs to be findable at a glance. */
const PLAYER_BLIP_RADIUS = 7;
/** Metres between the points the outline is drawn from. */
const OUTLINE_STEP = 8;
/** Margin between the circuit outline and the edge of its backing plate. */
const PLATE_PADDING = 12;

const INK = 0xdfe8ef;
const ACCENT = 0x24d4ff;

/**
 * The circuit seen from above, with a blip for every craft.
 *
 * The outline is built once as a flat ribbon rather than a line: `Line` is a
 * single device pixel wide on most hardware, which on a 150% display is a
 * hairline that all but disappears. Blips are separate small meshes because
 * there are at most eight of them and each wants its own colour — an instanced
 * mesh would save a handful of draw calls and cost the per-craft tint.
 *
 * Everything is laid out in the HUD's pixel space, so the map is the same
 * physical size whatever the resolution.
 */
export class Minimap {
  readonly group = new Group();

  /**
   * The `Color` is held rather than the uniform node: three reads the object
   * every frame, so recolouring a blip is a `setHex` on the instance it already
   * has, with no node plumbing and no typing gymnastics.
   */
  private readonly blips: { mesh: Mesh; colour: Color }[] = [];
  /** Track-space to map-space transform, worked out once from the circuit's extent. */
  private readonly scale: number;
  private readonly offset = new Vector2();
  private readonly size = new Vector2();

  constructor(track: Track, fieldSize: number) {
    const point = new Vector2();
    const points: Vector2[] = [];
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;

    for (let s = 0; s < track.length; s += OUTLINE_STEP) {
      const frame = track.frameAt(s);
      point.set(frame.position.x, frame.position.z);
      points.push(point.clone());
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minZ = Math.min(minZ, point.y);
      maxZ = Math.max(maxZ, point.y);
    }

    const spanX = Math.max(1, maxX - minX);
    const spanZ = Math.max(1, maxZ - minZ);
    this.scale = MAP_SIZE / Math.max(spanX, spanZ);
    // Centre the circuit's bounding box on the map's origin.
    this.offset.set(-(minX + maxX) / 2, -(minZ + maxZ) / 2);
    this.size.set(spanX * this.scale, spanZ * this.scale);

    // A dark plate behind the map. Without it the outline is a scribble drawn
    // over whatever the sky happens to be doing.
    const plate = new Mesh(
      new PlaneGeometry(this.size.x + PLATE_PADDING * 2, this.size.y + PLATE_PADDING * 2),
      panelMaterial(0x070b0f, 0.3),
    );
    plate.renderOrder = 5;
    this.group.add(plate);

    const outline = new Mesh(this.buildOutline(points), panelMaterial(INK, 0.85));
    outline.renderOrder = 6;
    this.group.add(outline);

    for (let i = 0; i < fieldSize; i++) {
      const colour = new Color(INK);
      const material = new MeshBasicNodeMaterial();
      material.colorNode = uniform(colour);
      material.transparent = true;
      material.depthTest = false;
      material.depthWrite = false;

      // Circles, not squares: a craft is a dot on a map, and at this size a
      // square reads as a UI element rather than as a position.
      const mesh = new Mesh(new CircleGeometry(BLIP_RADIUS, 16), material);
      mesh.renderOrder = 7;
      this.blips.push({ mesh, colour });
      this.group.add(mesh);
    }
  }

  /** Size of the map including its backing plate, so the HUD can position it. */
  get extent(): Vector2 {
    return new Vector2(this.size.x + PLATE_PADDING * 2, this.size.y + PLATE_PADDING * 2);
  }

  /** Sweeps the outline points into a thin closed ribbon. */
  private buildOutline(points: readonly Vector2[]): BufferGeometry {
    const count = points.length;
    const positions = new Float32Array(count * 2 * 3);
    const indices: number[] = [];
    const half = TRACK_WIDTH / 2;

    for (let i = 0; i < count; i++) {
      const previous = points[(i - 1 + count) % count]!;
      const next = points[(i + 1) % count]!;
      // Perpendicular to the local direction, in map space.
      let nx = -(next.y - previous.y);
      let ny = next.x - previous.x;
      const length = Math.hypot(nx, ny) || 1;
      nx = (nx / length) * half;
      ny = (ny / length) * half;

      const current = points[i]!;
      const x = (current.x + this.offset.x) * this.scale;
      const y = (current.y + this.offset.y) * this.scale;

      positions[i * 6] = x + nx;
      positions[i * 6 + 1] = y + ny;
      positions[i * 6 + 3] = x - nx;
      positions[i * 6 + 4] = y - ny;

      const a = i * 2;
      const b = ((i + 1) % count) * 2;
      indices.push(a, a + 1, b, b, a + 1, b + 1);
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    return geometry;
  }

  /** Moves every blip to where its craft is. */
  update(craft: readonly Craft[], player: Craft): void {
    for (let i = 0; i < this.blips.length; i++) {
      const blip = this.blips[i]!;
      const c = craft[i];
      if (!c) {
        blip.mesh.visible = false;
        continue;
      }
      blip.mesh.visible = true;
      blip.mesh.position.set(
        (c.state.position.x + this.offset.x) * this.scale,
        (c.state.position.z + this.offset.y) * this.scale,
        0,
      );

      const isPlayer = c === player;
      // The player is drawn on top, larger, and in the accent; everyone else
      // takes their constructor's colour so the field is readable at a glance.
      blip.mesh.scale.setScalar(isPlayer ? PLAYER_BLIP_RADIUS / BLIP_RADIUS : 1);
      blip.mesh.renderOrder = isPlayer ? 9 : 7;
      blip.colour.setHex(isPlayer ? ACCENT : c.team.colours.accent);
    }
  }

  dispose(): void {
    this.group.traverse((object) => {
      if (object instanceof Mesh) {
        object.geometry.dispose();
        (object.material as { dispose(): void }).dispose();
      }
    });
  }
}
