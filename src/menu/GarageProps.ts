import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  TorusGeometry,
  Vector3,
} from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { color, float } from 'three/tsl';
import { Rng } from '@/core/Rng';

/**
 * How much larger everything is than the first pass.
 *
 * At the original size the props read as models of props: correctly shaped and
 * far too small to be equipment a person works with. Everything here is scaled
 * by this and spaced to match, rather than tuned twice.
 */
const SCALE = 2;

/**
 * The clutter that makes a garage a garage.
 *
 * All of it is boxes, cylinders and torus sections — nothing here is modelled,
 * and nothing here is precious. The point is silhouettes at the edge of frame:
 * a bay reads as a working garage because of the flight cases stacked against
 * the wall and the hoses hanging over the bay, not because any one of them
 * stands up to inspection.
 *
 * Everything is placed relative to the plinth and kept out of the camera's
 * stations, which all look across the bay rather than down it.
 */
export class GarageProps {
  readonly group = new Group();

  constructor(plinth: Vector3) {
    const rng = new Rng(0x9a12bc);

    const shell = GarageProps.material(0xdfe5ea, 0.42, 0.1);
    const dark = GarageProps.material(0x39424a, 0.35, 0.5);
    const metal = GarageProps.material(0xb9c3cb, 0.18, 0.85);
    const accent = GarageProps.material(0x0072a8, 0.3, 0.2);
    const hose = GarageProps.material(0x2c333a, 0.75, 0.05);

    // --- Toolboxes and flight cases, stacked along the back wall ----------
    for (let i = 0; i < 5; i++) {
      const cabinet = new Group();
      const width = rng.range(1.5, 2.3) * SCALE;
      const height = rng.range(1.1, 1.9) * SCALE;
      const depth = rng.range(0.8, 1.1) * SCALE;

      const body = new Mesh(new BoxGeometry(width, height, depth), shell);
      body.position.y = height / 2;
      body.castShadow = true;
      cabinet.add(body);

      // Drawer fronts, so it is not a plain box.
      const drawers = Math.round(rng.range(2, 4));
      for (let d = 0; d < drawers; d++) {
        const face = new Mesh(
          new BoxGeometry(width * 0.86, height / drawers - 0.16, 0.12),
          dark,
        );
        face.position.set(0, (d + 0.5) * (height / drawers), depth / 2);
        cabinet.add(face);
      }

      const stripe = new Mesh(new BoxGeometry(width * 0.9, 0.14, 0.14), accent);
      stripe.position.set(0, height + 0.08, depth / 2 - 0.2);
      cabinet.add(stripe);

      // Along the far end of the bay on the type's side. They are low enough
      // that at that distance they sit under the menu rather than through it,
      // which is the whole reason the taller equipment lives opposite.
      // Spaced by the widest cabinet plus a gangway, so doubling the size did
      // not leave them growing into one another.
      cabinet.position.set(
        plinth.x - 32 + i * 5.6 + rng.range(-0.4, 0.4),
        0,
        -52 + rng.range(-1.2, 1.2),
      );
      cabinet.rotation.y = rng.range(-0.12, 0.12);
      this.group.add(cabinet);
    }

    // --- Spare hull panels, and the thruster rack beside them --------------
    // Both stand together at the back of the bay, on the plinth's side of the
    // room. Everything left of that projects straight through the type: the
    // camera looks left of the plinth on every screen, so the left half of the
    // room is where the interface lives, not where the props go.
    const panelX = plinth.x + 7;
    for (let i = 0; i < 4; i++) {
      const panel = new Mesh(new BoxGeometry(3.4 * SCALE, 0.22 * SCALE, 1.9 * SCALE), shell);
      panel.position.set(panelX, 0.2 + i * 0.5, -50 + rng.range(-0.6, 0.6));
      panel.rotation.y = rng.range(-0.1, 0.1);
      panel.castShadow = true;
      this.group.add(panel);
    }

    const rack = new Group();
    const rail = new Mesh(new BoxGeometry(7.2 * SCALE, 0.16 * SCALE, 0.5 * SCALE), metal);
    rail.position.y = 1.5 * SCALE;
    rack.add(rail);
    for (const x of [-2.6, 0, 2.6]) {
      const leg = new Mesh(new BoxGeometry(0.16 * SCALE, 1.5 * SCALE, 0.5 * SCALE), metal);
      leg.position.set(x * SCALE, 0.75 * SCALE, 0);
      rack.add(leg);
    }
    for (let i = 0; i < 4; i++) {
      const nozzle = new Group();
      const bell = new Mesh(
        new CylinderGeometry(0.52 * SCALE, 0.34 * SCALE, 1.5 * SCALE, 16, 1, true),
        metal,
      );
      bell.rotation.z = Math.PI / 2;
      nozzle.add(bell);
      const throat = new Mesh(new TorusGeometry(0.5 * SCALE, 0.07 * SCALE, 8, 20), accent);
      throat.rotation.y = Math.PI / 2;
      throat.position.x = 0.74 * SCALE;
      nozzle.add(throat);
      nozzle.position.set((-2.7 + i * 1.8) * SCALE, 1.85 * SCALE, 0);
      nozzle.rotation.z = rng.range(-0.08, 0.08);
      rack.add(nozzle);
    }
    // Turned to face across the bay, so the bells read as bells rather than as
    // a row of discs.
    rack.position.set(panelX + 3, 0, -44);
    // Turned to run away from the lens rather than across it: broadside, the
    // rail is as wide as the craft and fights it for the right of frame.
    rack.rotation.y = 1.15;
    this.group.add(rack);

    // --- Service hoses, hung in loops over the bay -------------------------
    for (let i = 0; i < 5; i++) {
      const drop = rng.range(2.2, 3.8) * SCALE;
      const loop = new Mesh(new TorusGeometry(drop * 0.42, 0.075 * SCALE, 6, 24, Math.PI), hose);
      // A hanging hose is a catenary; half a torus is close enough at this size
      // and costs nothing to build.
      loop.rotation.z = Math.PI;
      loop.position.set(
        plinth.x - 12 + i * 7 + rng.range(-0.8, 0.8),
        12.4,
        -20 - rng.range(0, 14),
      );
      loop.rotation.y = rng.range(-0.4, 0.4);
      this.group.add(loop);

      const feed = new Mesh(new CylinderGeometry(0.075 * SCALE, 0.075 * SCALE, 2.6, 6), hose);
      feed.position.copy(loop.position).setY(13.7);
      this.group.add(feed);
    }

    // --- A gantry over the bay ---------------------------------------------
    const gantry = new Mesh(new BoxGeometry(0.35 * SCALE, 0.35 * SCALE, 34), metal);
    gantry.position.set(plinth.x, 11.6, -20);
    this.group.add(gantry);

    // --- Bollards marking the bay ------------------------------------------
    for (const side of [-1, 1] as const) {
      for (let i = 0; i < 3; i++) {
        const post = new Mesh(
          new CylinderGeometry(0.13 * SCALE, 0.16 * SCALE, 0.95 * SCALE, 10),
          metal,
        );
        post.position.set(plinth.x + side * 11, 0.48 * SCALE, -5 + i * 7);
        this.group.add(post);
        const cap = new Mesh(
          new CylinderGeometry(0.15 * SCALE, 0.15 * SCALE, 0.1 * SCALE, 10),
          accent,
        );
        cap.position.copy(post.position).setY(0.98 * SCALE);
        this.group.add(cap);
      }
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

  private static material(hex: number, roughness: number, metalness: number): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();
    material.colorNode = color(hex);
    material.roughnessNode = float(roughness);
    material.metalnessNode = float(metalness);
    return material;
  }
}
