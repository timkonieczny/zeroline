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
      const width = rng.range(1.5, 2.3);
      const height = rng.range(1.1, 1.9);
      const depth = rng.range(0.8, 1.1);

      const body = new Mesh(new BoxGeometry(width, height, depth), shell);
      body.position.y = height / 2;
      body.castShadow = true;
      cabinet.add(body);

      // Drawer fronts, so it is not a plain box.
      const drawers = Math.round(rng.range(2, 4));
      for (let d = 0; d < drawers; d++) {
        const face = new Mesh(new BoxGeometry(width * 0.86, height / drawers - 0.08, 0.06), dark);
        face.position.set(0, (d + 0.5) * (height / drawers), depth / 2);
        cabinet.add(face);
      }

      const stripe = new Mesh(new BoxGeometry(width * 0.9, 0.07, 0.07), accent);
      stripe.position.set(0, height + 0.04, depth / 2 - 0.1);
      cabinet.add(stripe);

      cabinet.position.set(plinth.x - 14 + i * 3.1 + rng.range(-0.3, 0.3), 0, -21 + rng.range(-0.8, 0.8));
      cabinet.rotation.y = rng.range(-0.12, 0.12);
      this.group.add(cabinet);
    }

    // --- Spare thruster nozzles on a rack ---------------------------------
    const rack = new Group();
    const rail = new Mesh(new BoxGeometry(7.2, 0.16, 0.5), metal);
    rail.position.y = 1.5;
    rack.add(rail);
    for (const x of [-2.6, 0, 2.6]) {
      const leg = new Mesh(new BoxGeometry(0.16, 1.5, 0.5), metal);
      leg.position.set(x, 0.75, 0);
      rack.add(leg);
    }
    for (let i = 0; i < 4; i++) {
      const nozzle = new Group();
      const bell = new Mesh(new CylinderGeometry(0.52, 0.34, 1.5, 16, 1, true), metal);
      bell.rotation.z = Math.PI / 2;
      nozzle.add(bell);
      const throat = new Mesh(new TorusGeometry(0.5, 0.07, 8, 20), accent);
      throat.rotation.y = Math.PI / 2;
      throat.position.x = 0.74;
      nozzle.add(throat);
      nozzle.position.set(-2.7 + i * 1.8, 1.85, 0);
      nozzle.rotation.z = rng.range(-0.08, 0.08);
      rack.add(nozzle);
    }
    rack.position.set(plinth.x + 13, 0, -18);
    rack.rotation.y = -0.5;
    this.group.add(rack);

    // --- Service hoses, hung in loops over the bay -------------------------
    for (let i = 0; i < 5; i++) {
      const drop = rng.range(2.2, 3.8);
      const loop = new Mesh(new TorusGeometry(drop * 0.42, 0.075, 6, 24, Math.PI), hose);
      // A hanging hose is a catenary; half a torus is close enough at this size
      // and costs nothing to build.
      loop.rotation.z = Math.PI;
      loop.position.set(plinth.x - 9 + i * 4.4 + rng.range(-0.5, 0.5), 11.9, -11 - rng.range(0, 8));
      loop.rotation.y = rng.range(-0.4, 0.4);
      this.group.add(loop);

      const feed = new Mesh(new CylinderGeometry(0.075, 0.075, 1.4, 6), hose);
      feed.position.copy(loop.position).setY(12.6);
      this.group.add(feed);
    }

    // --- A gantry over the bay, and a tyre-stack of spare hull panels ------
    const gantry = new Mesh(new BoxGeometry(0.35, 0.35, 26), metal);
    gantry.position.set(plinth.x, 10.8, -12);
    this.group.add(gantry);

    for (let i = 0; i < 4; i++) {
      const panel = new Mesh(new BoxGeometry(3.4, 0.22, 1.9), shell);
      panel.position.set(plinth.x - 18, 0.14 + i * 0.26, -14 + rng.range(-0.4, 0.4));
      panel.rotation.y = rng.range(-0.1, 0.1);
      panel.castShadow = true;
      this.group.add(panel);
    }

    // --- Bollards marking the bay ------------------------------------------
    for (const side of [-1, 1] as const) {
      for (let i = 0; i < 3; i++) {
        const post = new Mesh(new CylinderGeometry(0.13, 0.16, 0.95, 10), metal);
        post.position.set(plinth.x + side * 9.5, 0.48, -4 + i * 5.5);
        this.group.add(post);
        const cap = new Mesh(new CylinderGeometry(0.15, 0.15, 0.1, 10), accent);
        cap.position.copy(post.position).setY(0.98);
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
