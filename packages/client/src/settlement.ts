import { Color3 } from "@babylonjs/core/Maths/math.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import type { Scene } from "@babylonjs/core/scene.js";
import {
  heightAt,
  lakeLevel,
  lakeReach,
  type BuildingDefinition,
  type OstraDefinition,
  type PropDefinition,
  type SettlementDefinition,
  type VillagerDefinition,
} from "@mmo/shared";
import { facet, flatMaterial, hexColour } from "./lowpoly.js";

/**
 * Towns, drawn.
 *
 * Daso is timber everywhere, because that is what the town is for; Fanshona is
 * stone and slate, because it is a market that has been there long enough to
 * build in stone. Both are deliberately warmer than the wilds around them — a
 * lit window and a woodpile should read as somewhere people are, from a
 * distance, against ground that is all greens and greys.
 */

const TIMBER = 0x6b4c30;
const TIMBER_DARK = 0x4a3421;
const THATCH = 0x8a6a3a;
const SHINGLE = 0x53412f;
const PLASTER = 0xc2b394;
const LAMPLIGHT = 0xffc46b;
const STONE = 0x9a958a;
const SLATE = 0x4a525c;
/** Footings and chimneys: darker than wall stone, so a stone house still has
 *  a base. */
const FOOTING = 0x6e6a62;
const DOOR = 0x5a3a22;
/** An unlit window: dark, a little blue, so it reads as glass not a hole. */
const GLASS = 0x2a3440;
/** The inside of an open shed. Emissive black, so no light makes it grey. */
const SHADOW = 0x0e0c0a;

/** Everything for one settlement, under a single node so arrival can replace
 *  it wholesale. */
export function buildSettlement(
  scene: Scene,
  ostra: OstraDefinition,
  settlement: SettlementDefinition,
): TransformNode {
  const root = new TransformNode(`settlement:${settlement.id}`, scene);

  const glow = (name: string, colour: number): StandardMaterial => {
    const material = new StandardMaterial(name, scene);
    material.diffuseColor = Color3.Black();
    material.specularColor = Color3.Black();
    material.emissiveColor = hexColour(colour);
    return material;
  };
  const materials: Materials = {
    timber: flatMaterial(scene, "timber", TIMBER),
    timberDark: flatMaterial(scene, "timberDark", TIMBER_DARK),
    thatch: flatMaterial(scene, "thatch", THATCH),
    shingle: flatMaterial(scene, "shingle", SHINGLE),
    plaster: flatMaterial(scene, "plaster", PLASTER),
    stone: flatMaterial(scene, "stone", STONE),
    slate: flatMaterial(scene, "slate", SLATE),
    footing: flatMaterial(scene, "footing", FOOTING),
    door: flatMaterial(scene, "door", DOOR),
    glass: flatMaterial(scene, "glass", GLASS),
    lamplight: glow("lamplight", LAMPLIGHT),
    shadow: glow("shadow", SHADOW),
  };

  const stoneTown = !settlement.woodland;
  for (const building of settlement.buildings) {
    buildBuilding(scene, ostra, building, materials, stoneTown).parent = root;
  }
  for (const prop of settlement.props) {
    buildProp(scene, ostra, settlement, prop, materials).parent = root;
  }
  for (const tree of settlement.trees) {
    buildTree(scene, ostra, tree.x, tree.z, tree.radius, tree.height).parent = root;
  }

  return root;
}

type Materials = Record<
  | "timber" | "timberDark" | "thatch" | "shingle" | "plaster" | "stone" | "slate"
  | "footing" | "door" | "glass" | "lamplight" | "shadow",
  StandardMaterial
>;

/**
 * A closed triangular prism: the roof's body, whose two ends are the gables.
 *
 * Built by hand rather than from a three-sided cylinder, whose length axis and
 * cross-section swap places under rotation — which is how every house once
 * got a roof the wrong size. Each face's winding is checked against the way it
 * should face and flipped if wrong, so the mesh cannot come out inside-out
 * whichever order the corners are listed in.
 *
 * The triangle is in the building's y-z plane: base from z = -halfDepth to
 * +halfDepth at y = 0, apex at (z = 0, y = rise); it runs x = -halfWidth to
 * +halfWidth.
 */
function roofPrism(scene: Scene, halfWidth: number, halfDepth: number, rise: number): Mesh {
  type P = [number, number, number];
  const corner = (x: number): P[] => [[x, 0, -halfDepth], [x, 0, halfDepth], [x, rise, 0]];
  const [a0, b0, c0] = corner(-halfWidth) as [P, P, P];
  const [a1, b1, c1] = corner(halfWidth) as [P, P, P];
  const middle: P = [0, rise / 3, 0];

  const positions: number[] = [];
  const normals: number[] = [];
  const tri = (a: P, b: P, c: P): void => {
    // Babylon's front face is the one whose normal is (c - a) x (b - a).
    const n = (p: P, q: P, r: P): P => {
      const u: P = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
      const w: P = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
      return [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
    };
    let normal = n(a, b, c);
    const centre: P = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const outward = (centre[0] - middle[0]) * normal[0] + (centre[1] - middle[1]) * normal[1]
      + (centre[2] - middle[2]) * normal[2];
    if (outward < 0) {
      [b, c] = [c, b];
      normal = n(a, b, c);
    }
    const length = Math.hypot(normal[0], normal[1], normal[2]) || 1;
    for (const p of [a, b, c]) {
      positions.push(p[0], p[1], p[2]);
      normals.push(normal[0] / length, normal[1] / length, normal[2] / length);
    }
  };

  tri(a0, b0, c0); // gable end
  tri(a1, b1, c1); // the other gable end
  tri(a0, a1, c1); tri(a0, c1, c0); // back slope
  tri(b0, c0, c1); tri(b0, c1, b1); // front slope
  tri(a0, b0, b1); tri(a0, b1, a1); // underside

  const mesh = new Mesh("roofBody", scene);
  const data = new VertexData();
  data.positions = positions;
  data.normals = normals;
  data.indices = Array.from({ length: positions.length / 3 }, (_, i) => i);
  data.applyToMesh(mesh, false);
  return mesh;
}

/** Stable per-building variety from its id: which houses have a lamp lit. */
function idHash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

function buildBuilding(
  scene: Scene,
  ostra: OstraDefinition,
  building: BuildingDefinition,
  materials: Materials,
  /** Fanshona builds in stone; Daso in timber. */
  stoneTown: boolean,
): TransformNode {
  const pivot = new TransformNode(`building:${building.id}`, scene);
  pivot.position.set(
    building.x,
    // Sunk very slightly, so a wall never floats over a dip in the flattened
    // ground.
    heightAt(building.x, building.z, ostra.terrain) - 0.12,
    building.z,
  );
  pivot.rotation.y = building.yaw;

  const { width, depth, height, style } = building;
  const box = (
    name: string,
    size: { width: number; height: number; depth: number },
    x: number, y: number, z: number,
    material: StandardMaterial,
    blocksCamera = false,
  ): Mesh => {
    const mesh = MeshBuilder.CreateBox(name, size, scene);
    mesh.position.set(x, y, z);
    mesh.material = material;
    if (blocksCamera) mesh.metadata = { blocksCamera: true };
    mesh.parent = pivot;
    return mesh;
  };

  // A stone footing, a little wider than the walls, so a building sits on the
  // ground rather than in it — and hides any seam where the flattened ground
  // is not quite flat.
  box("plinth", { width: width + 0.3, height: 0.5, depth: depth + 0.3 }, 0, 0.13, 0, materials.footing);

  // A hall is built in whatever its town builds in: timber in Daso, stone in
  // Fanshona.
  const wallMaterial = style === "shed" ? materials.timberDark
    : style === "stone" || (style === "hall" && stoneTown) ? materials.stone
    : materials.timber;
  box("walls", { width, depth, height }, 0, height / 2, 0, wallMaterial, true);

  // Half-timbering on the houses: a plaster band between dark corner posts.
  // It is the one thing that stops a row of brown boxes reading as a row of
  // brown boxes.
  if (style === "cottage") {
    box("band", { width: width + 0.06, height: height * 0.42, depth: depth + 0.06 }, 0, height * 0.44, 0, materials.plaster);
  }
  if (style === "cottage" || (style === "hall" && !stoneTown)) {
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      box("post", { width: 0.24, height, depth: 0.24 }, (x * width) / 2, height / 2, (z * depth) / 2, materials.timberDark);
    }
  }

  // --- the roof ---
  // Two slabs over a solid triangular body. The slabs' undersides lie exactly
  // on the body's slopes and run out past the walls, dipping below the wall
  // top at the eaves the way a real overhang does; the body's two ends are
  // the gables.
  const roofMaterial = style === "shed" ? materials.shingle
    : style === "stone" || (style === "hall" && stoneTown) ? materials.slate
    : materials.thatch;
  const overhang = style === "shed" ? 0.45 : 0.7;
  const pitch = style === "shed" ? 0.42 : style === "stone" ? 0.62 : 0.7;
  const thickness = style === "cottage" ? 0.22 : 0.14;
  const tan = Math.tan(pitch);
  const rise = (depth / 2) * tan;
  const eave = depth / 2 + overhang;
  const slope = eave / Math.cos(pitch);

  const body = roofPrism(scene, width / 2, depth / 2, rise);
  body.position.y = height;
  body.material = style === "cottage" ? materials.plaster
    : style === "stone" ? materials.stone
    : wallMaterial;
  body.metadata = { blocksCamera: true };
  body.parent = pivot;

  for (const side of [-1, 1]) {
    // Along the slope from the ridge (z = 0) to the eave (z = side * eave),
    // centred halfway, lifted by half its thickness so its underside is the
    // slope. Rotating about x by +pitch tips a slab's +z end down (Babylon is
    // left-handed); the far side mirrors it.
    const along = eave / 2;
    const slab = box(
      "roof",
      { width: width + overhang * 2, height: thickness, depth: slope },
      0,
      height + rise - along * tan + (thickness / 2) / Math.cos(pitch),
      side * along,
      roofMaterial,
      true,
    );
    slab.rotation.x = side * pitch;
  }
  // A ridge beam over the seam where the slabs meet.
  box("ridge", { width: width + overhang * 2 + 0.1, height: 0.2, depth: 0.26 }, 0, height + rise + thickness * 0.7, 0,
    style === "cottage" ? materials.timberDark : roofMaterial);

  // A chimney through the back slope of anything people live in.
  if (style !== "shed") {
    const x = width * 0.28 * (idHash(building.id) % 2 === 0 ? 1 : -1);
    const z = -depth * 0.18;
    const top = height + rise + 0.9;
    box("chimney", { width: 0.7, height: top - height + 0.2, depth: 0.7 }, x, (top + height) / 2, z, materials.footing);
  }

  // --- the front ---
  const front = depth / 2 + 0.03;
  if (style === "shed") {
    // Sheds are open: a wide dark doorway you can see the dark inside of.
    box("opening", { width: Math.min(width * 0.55, 3.2), height: Math.min(2.6, height * 0.72), depth: 0.1 },
      0, Math.min(2.6, height * 0.72) / 2 + 0.2, front, materials.shadow);
  } else {
    // A door, so the front is obvious and the building has a scale you can
    // read yourself against, in a frame so it reads as a door and not a stain.
    const doorHeight = Math.min(2.15, height * 0.62);
    box("doorFrame", { width: 1.25, height: doorHeight + 0.18, depth: 0.1 }, 0, (doorHeight + 0.18) / 2 + 0.2, front, materials.timberDark);
    box("door", { width: 0.95, height: doorHeight, depth: 0.12 }, 0, doorHeight / 2 + 0.2, front + 0.03, materials.door);
  }

  // Windows either side of the door and down the long sides. The halls are
  // lit; so, by a fixed pattern, are some of the houses — a town at dusk
  // should have a few warm windows, not all of them or none.
  if (style !== "shed") {
    const lit = style === "hall" || idHash(building.id) % 3 === 0;
    const pane = lit ? materials.lamplight : materials.glass;
    const sill = height * (style === "hall" ? 0.5 : 0.55);
    const size = style === "hall" ? 1.1 : 0.8;
    const frontOffsets = width >= 7 ? [-width * 0.3, width * 0.3] : width >= 4.5 ? [-width * 0.3, width * 0.3] : [];
    for (const x of frontOffsets) {
      box("windowFrame", { width: size + 0.2, height: size + 0.2, depth: 0.08 }, x, sill, front, materials.timberDark);
      box("window", { width: size, height: size, depth: 0.1 }, x, sill, front + 0.02, pane);
    }
    for (const side of [-1, 1]) {
      box("windowFrame", { width: 0.08, height: size + 0.2, depth: size + 0.2 }, side * (width / 2 + 0.03), sill, 0, materials.timberDark);
      box("window", { width: 0.1, height: size, depth: size }, side * (width / 2 + 0.05), sill, 0, pane);
    }
  }

  return pivot;
}

/** The surface of whatever lake (x, z) is in, if any. */
function waterSurface(ostra: OstraDefinition, x: number, z: number): number | undefined {
  for (const lake of ostra.terrain.lakes ?? []) {
    if (Math.hypot(x - lake.x, z - lake.z) < lakeReach(lake)) return lakeLevel(lake, ostra.terrain);
  }
  return undefined;
}

function buildProp(
  scene: Scene,
  ostra: OstraDefinition,
  settlement: SettlementDefinition,
  prop: PropDefinition,
  materials: Materials,
): TransformNode {
  const pivot = new TransformNode(`prop:${prop.kind}`, scene);
  pivot.position.set(prop.x, heightAt(prop.x, prop.z, ostra.terrain), prop.z);
  pivot.rotation.y = prop.yaw;

  const log = (length: number, diameter: number, y: number, z = 0): void => {
    const mesh = facet(MeshBuilder.CreateCylinder("log", {
      diameter, height: length, tessellation: 6,
    }, scene));
    mesh.rotation.z = Math.PI / 2;
    mesh.position.set(0, y, z);
    mesh.material = materials.timber;
    mesh.parent = pivot;
  };

  switch (prop.kind) {
    case "log":
      log(3.4, 0.62, 0.31);
      break;

    case "woodpile":
      // Three, two, one — stacked the way anyone actually stacks logs.
      log(2.6, 0.46, 0.23, -0.5);
      log(2.6, 0.46, 0.23, 0);
      log(2.6, 0.46, 0.23, 0.5);
      log(2.6, 0.46, 0.69, -0.25);
      log(2.6, 0.46, 0.69, 0.25);
      log(2.6, 0.46, 1.15, 0);
      break;

    case "stump": {
      const stump = facet(MeshBuilder.CreateCylinder("stump", {
        diameterTop: 0.78, diameterBottom: 0.9, height: 0.5, tessellation: 7,
      }, scene));
      stump.position.y = 0.25;
      stump.material = materials.timber;
      stump.parent = pivot;
      break;
    }

    case "barrel": {
      const barrel = facet(MeshBuilder.CreateCylinder("barrel", {
        diameterTop: 0.5, diameterBottom: 0.5, height: 0.8, tessellation: 8,
      }, scene));
      barrel.position.y = 0.4;
      barrel.material = materials.timberDark;
      barrel.parent = pivot;
      break;
    }

    case "crate": {
      const crate = MeshBuilder.CreateBox("crate", { size: 0.65 }, scene);
      crate.position.y = 0.33;
      crate.material = materials.timber;
      crate.parent = pivot;
      break;
    }

    case "fence": {
      const rail = MeshBuilder.CreateBox("rail", {
        width: 0.1, height: 0.12, depth: 2.8,
      }, scene);
      rail.position.y = 0.78;
      rail.material = materials.timber;
      rail.parent = pivot;

      const rail2 = rail.clone("rail2");
      rail2.position.y = 0.44;
      rail2.parent = pivot;

      for (const z of [-1.35, 1.35]) {
        const post = MeshBuilder.CreateBox("post", {
          width: 0.14, height: 1.05, depth: 0.14,
        }, scene);
        post.position.set(0, 0.52, z);
        post.material = materials.timberDark;
        post.parent = pivot;
      }
      break;
    }

    case "lamp": {
      const post = facet(MeshBuilder.CreateCylinder("lampPost", {
        diameter: 0.14, height: 2.4, tessellation: 5,
      }, scene));
      post.position.y = 1.2;
      post.material = materials.timberDark;
      post.parent = pivot;

      const glow = new StandardMaterial("lampGlow", scene);
      glow.diffuseColor = Color3.Black();
      glow.specularColor = Color3.Black();
      glow.emissiveColor = hexColour(LAMPLIGHT);

      const lantern = facet(MeshBuilder.CreatePolyhedron("lantern", {
        type: 1, size: 0.19,
      }, scene));
      lantern.position.y = 2.5;
      lantern.material = glow;
      lantern.parent = pivot;
      break;
    }

    case "well": {
      const ring = facet(MeshBuilder.CreateCylinder("well", {
        diameterTop: 1.5, diameterBottom: 1.6, height: 0.75, tessellation: 8,
      }, scene));
      ring.position.y = 0.37;
      ring.material = materials.stone;
      ring.parent = pivot;
      const water = MeshBuilder.CreateDisc("wellWater", { radius: 0.55, tessellation: 8 }, scene);
      water.rotation.x = Math.PI / 2;
      water.position.y = 0.6;
      water.material = flatMaterial(scene, "wellWater", 0x2a4a5a);
      water.parent = pivot;
      for (const x of [-0.7, 0.7]) {
        const post = MeshBuilder.CreateBox("wellPost", { width: 0.12, height: 1.9, depth: 0.12 }, scene);
        post.position.set(x, 0.95, 0);
        post.material = materials.timberDark;
        post.parent = pivot;
      }
      const roof = MeshBuilder.CreateBox("wellRoof", { width: 1.9, height: 0.12, depth: 1.3 }, scene);
      roof.position.y = 1.95;
      roof.material = materials.slate;
      roof.parent = pivot;
      break;
    }

    case "stall": {
      const table = MeshBuilder.CreateBox("stallTable", { width: 2, height: 0.12, depth: 0.9 }, scene);
      table.position.y = 0.85;
      table.material = materials.timber;
      table.parent = pivot;
      for (const [x, z] of [[-0.9, -0.38], [0.9, -0.38], [-0.9, 0.38], [0.9, 0.38]] as const) {
        const leg = MeshBuilder.CreateBox("stallLeg", { width: 0.08, height: 1.9, depth: 0.08 }, scene);
        leg.position.set(x, 0.95, z);
        leg.material = materials.timberDark;
        leg.parent = pivot;
      }
      // Cloth in one of a few colours, by position, so a row of stalls isn't
      // one stall repeated.
      const cloths = [0xb8483a, 0x3a6ab8, 0xc89a3a, 0x5a8a4a];
      const cloth = cloths[Math.abs(Math.round(prop.x * 3 + prop.z * 7)) % cloths.length]!;
      const awning = MeshBuilder.CreateBox("stallAwning", { width: 2.3, height: 0.06, depth: 1.3 }, scene);
      awning.position.set(0, 1.95, 0.1);
      awning.rotation.x = 0.2;
      awning.material = flatMaterial(scene, "stallCloth", cloth);
      awning.parent = pivot;
      for (let k = 0; k < 3; k++) {
        const good = MeshBuilder.CreateBox("goods", { width: 0.4, height: 0.25, depth: 0.35 }, scene);
        good.position.set(-0.6 + k * 0.6, 1.03, 0);
        good.material = k === 1 ? materials.timberDark : materials.plaster;
        good.parent = pivot;
      }
      break;
    }

    case "dock": {
      // Level with the town, running out over the water; its posts go down
      // into the lake. Scenery: you wade beside it, not along it.
      const deck = settlement.level ?? heightAt(settlement.x, settlement.z, ostra.terrain);
      pivot.position.y = deck + 0.25;
      const length = 36;
      const planks = MeshBuilder.CreateBox("dockDeck", { width: 2.6, height: 0.16, depth: length }, scene);
      planks.material = materials.timber;
      planks.parent = pivot;
      for (let z = -length / 2 + 1; z <= length / 2; z += 3.5) {
        for (const x of [-1.15, 1.15]) {
          const post = MeshBuilder.CreateBox("dockPost", { width: 0.2, height: 3.2, depth: 0.2 }, scene);
          post.position.set(x, -1.5, z);
          post.material = materials.timberDark;
          post.parent = pivot;
        }
      }
      break;
    }

    case "boat": {
      const surface = waterSurface(ostra, prop.x, prop.z) ?? pivot.position.y;
      pivot.position.y = surface - 0.12;
      const hull = MeshBuilder.CreateBox("hull", { width: 1.2, height: 0.4, depth: 3 }, scene);
      hull.position.y = 0.1;
      hull.material = materials.timberDark;
      hull.parent = pivot;
      for (const x of [-0.62, 0.62]) {
        const side = MeshBuilder.CreateBox("gunwale", { width: 0.1, height: 0.3, depth: 3.1 }, scene);
        side.position.set(x, 0.35, 0);
        side.material = materials.timber;
        side.parent = pivot;
      }
      const bow = MeshBuilder.CreateCylinder("bow", { diameterTop: 0, diameterBottom: 1.2, height: 0.8, tessellation: 3 }, scene);
      bow.rotation.x = Math.PI / 2;
      bow.position.set(0, 0.12, 1.85);
      bow.scaling.set(1, 1, 0.45);
      bow.material = materials.timberDark;
      bow.parent = pivot;
      break;
    }
  }

  return pivot;
}

/** A tree: trunk plus two stacked canopy tiers, both faceted. */
export function buildTree(
  scene: Scene,
  ostra: OstraDefinition,
  x: number,
  z: number,
  radius: number,
  height: number,
): TransformNode {
  const pivot = new TransformNode("tree", scene);
  pivot.position.set(x, heightAt(x, z, ostra.terrain), z);
  // Deterministic from position, so every client sees the same wood and no
  // tree spins on a reload.
  pivot.rotation.y = ((x * 37.1 + z * 19.7) % Math.PI) * 2;

  const bark = flatMaterial(scene, "bark", 0x4f3a26);
  const leaf = flatMaterial(scene, "leaf", 0x3f6b3a);
  const leafDark = flatMaterial(scene, "leafDark", 0x2f5230);

  const trunk = facet(MeshBuilder.CreateCylinder("trunk", {
    diameterTop: radius * 0.7,
    diameterBottom: radius * 1.05,
    height: height * 0.45,
    tessellation: 6,
  }, scene));
  trunk.position.y = height * 0.225;
  trunk.material = bark;
  trunk.parent = pivot;

  const lower = facet(MeshBuilder.CreateCylinder("canopyLower", {
    diameterTop: radius * 2.1,
    diameterBottom: radius * 3.4,
    height: height * 0.34,
    tessellation: 7,
  }, scene));
  lower.position.y = height * 0.56;
  lower.material = leafDark;
  lower.parent = pivot;

  const upper = facet(MeshBuilder.CreateCylinder("canopyUpper", {
    diameterTop: 0,
    diameterBottom: radius * 2.5,
    height: height * 0.42,
    tessellation: 7,
  }, scene));
  upper.position.y = height * 0.8;
  upper.material = leaf;
  upper.parent = pivot;

  return pivot;
}

/**
 * A villager: the same blocky figure as a player, in working clothes.
 *
 * Reusing the silhouette is deliberate — a person should read as a person
 * whether or not someone is driving them.
 */
export function buildVillager(
  scene: Scene,
  ostra: OstraDefinition,
  villager: VillagerDefinition,
): TransformNode {
  const pivot = new TransformNode(`villager:${villager.name}`, scene);
  pivot.position.set(villager.x, heightAt(villager.x, villager.z, ostra.terrain), villager.z);
  pivot.rotation.y = villager.yaw;

  const cloth = flatMaterial(scene, "villagerCloth", villager.colour);
  const skin = flatMaterial(scene, "villagerSkin", hexColour(villager.colour).scale(1.5));
  const dark = flatMaterial(scene, "villagerDark", hexColour(villager.colour).scale(0.6));

  const part = (
    size: { width: number; height: number; depth: number },
    y: number,
    x: number,
    material: StandardMaterial,
  ): void => {
    const mesh = MeshBuilder.CreateBox("part", size, scene);
    mesh.position.set(x, y, 0);
    mesh.material = material;
    mesh.parent = pivot;
  };

  part({ width: 0.5, height: 0.5, depth: 0.3 }, 0.6, 0, cloth);
  part({ width: 0.32, height: 0.32, depth: 0.32 }, 1.02, 0, skin);
  part({ width: 0.13, height: 0.44, depth: 0.15 }, 0.58, -0.31, cloth);
  part({ width: 0.13, height: 0.44, depth: 0.15 }, 0.58, 0.31, cloth);
  part({ width: 0.17, height: 0.36, depth: 0.17 }, 0.18, -0.13, dark);
  part({ width: 0.17, height: 0.36, depth: 0.17 }, 0.18, 0.13, dark);

  return pivot;
}
