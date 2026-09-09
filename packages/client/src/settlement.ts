import { Color3 } from "@babylonjs/core/Maths/math.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import type { Scene } from "@babylonjs/core/scene.js";
import {
  heightAt,
  type BuildingDefinition,
  type OstraDefinition,
  type PropDefinition,
  type SettlementDefinition,
  type VillagerDefinition,
} from "@mmo/shared";
import { facet, flatMaterial, hexColour } from "./lowpoly.js";

/**
 * Daso, drawn.
 *
 * Timber everywhere, because that is what the town is for. The palette is
 * deliberately warmer than the wilds around it — a lit window and a woodpile
 * should read as somewhere people are, from a distance, against ground that is
 * all greens and greys.
 */

const TIMBER = 0x6b4c30;
const TIMBER_DARK = 0x4a3421;
const THATCH = 0x8a6a3a;
const SHINGLE = 0x53412f;
const PLASTER = 0xc2b394;
const LAMPLIGHT = 0xffc46b;

/** Everything for one settlement, under a single node so arrival can replace
 *  it wholesale. */
export function buildSettlement(
  scene: Scene,
  ostra: OstraDefinition,
  settlement: SettlementDefinition,
): TransformNode {
  const root = new TransformNode(`settlement:${settlement.id}`, scene);

  const materials = {
    timber: flatMaterial(scene, "timber", TIMBER),
    timberDark: flatMaterial(scene, "timberDark", TIMBER_DARK),
    thatch: flatMaterial(scene, "thatch", THATCH),
    shingle: flatMaterial(scene, "shingle", SHINGLE),
    plaster: flatMaterial(scene, "plaster", PLASTER),
  };

  for (const building of settlement.buildings) {
    buildBuilding(scene, ostra, building, materials).parent = root;
  }
  for (const prop of settlement.props) {
    buildProp(scene, ostra, prop, materials).parent = root;
  }
  for (const tree of settlement.trees) {
    buildTree(scene, ostra, tree.x, tree.z, tree.radius, tree.height).parent = root;
  }

  return root;
}

type Materials = Record<"timber" | "timberDark" | "thatch" | "shingle" | "plaster", StandardMaterial>;

function buildBuilding(
  scene: Scene,
  ostra: OstraDefinition,
  building: BuildingDefinition,
  materials: Materials,
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

  const wallMaterial = building.style === "shed" ? materials.timberDark : materials.timber;
  const walls = MeshBuilder.CreateBox("walls", {
    width: building.width,
    depth: building.depth,
    height: building.height,
  }, scene);
  walls.position.y = building.height / 2;
  walls.material = wallMaterial;
  walls.metadata = { blocksCamera: true };
  walls.parent = pivot;

  // A band of plaster between the timbers, on the houses only. It is the one
  // thing that stops five brown boxes reading as five brown boxes.
  if (building.style === "cottage") {
    const band = MeshBuilder.CreateBox("band", {
      width: building.width + 0.06,
      depth: building.depth + 0.06,
      height: building.height * 0.42,
    }, scene);
    band.position.y = building.height * 0.44;
    band.material = materials.plaster;
    band.parent = pivot;
  }

  // Roof: two slabs leaning together into a gable.
  //
  // A three-sided cylinder is the obvious prism, but its length axis and its
  // cross-section swap places under rotation and it is easy to size one and
  // rotate the other — which is exactly the bug that put oversized roofs on
  // every house here. Two boxes have no such ambiguity.
  const roofMaterial = building.style === "shed" ? materials.shingle : materials.thatch;
  const overhang = building.style === "shed" ? 0.5 : 0.75;
  const pitch = building.style === "shed" ? 0.38 : 0.62;

  const halfDepth = (building.depth + overhang) / 2;
  const slope = halfDepth / Math.cos(pitch);
  const rise = halfDepth * Math.tan(pitch);

  for (const side of [-1, 1]) {
    const slab = MeshBuilder.CreateBox("roof", {
      width: building.width + overhang,
      height: 0.16,
      depth: slope,
    }, scene);
    // Each half spans from the eaves to the ridge, tilted to meet its twin.
    slab.rotation.x = -side * pitch;
    slab.position.set(0, building.height + rise / 2, (side * halfDepth) / 2);
    slab.material = roofMaterial;
    slab.metadata = { blocksCamera: true };
    slab.parent = pivot;
  }

  // The gable ends, so the triangle of wall under the roof isn't open sky.
  for (const end of [-1, 1]) {
    const gable = MeshBuilder.CreateBox("gable", {
      width: 0.14,
      height: rise,
      depth: building.depth,
    }, scene);
    gable.position.set((end * (building.width + overhang)) / 2 - end * 0.1,
      building.height + rise / 2, 0);
    gable.scaling.z = 0.5;
    gable.material = building.style === "cottage" ? materials.plaster : roofMaterial;
    gable.parent = pivot;
  }

  // A door, so the front is obvious and the building has a scale you can read
  // yourself against.
  const door = MeshBuilder.CreateBox("door", {
    width: 0.95,
    height: Math.min(2.1, building.height * 0.62),
    depth: 0.12,
  }, scene);
  door.position.set(0, Math.min(2.1, building.height * 0.62) / 2, building.depth / 2 + 0.02);
  door.material = materials.timberDark;
  door.parent = pivot;

  // The inn's windows are lit. Nothing else in the world glows warm.
  if (building.style === "hall") {
    const glow = new StandardMaterial("window", scene);
    glow.diffuseColor = Color3.Black();
    glow.specularColor = Color3.Black();
    glow.emissiveColor = hexColour(LAMPLIGHT);

    for (const offset of [-2.6, 2.6]) {
      const window = MeshBuilder.CreateBox("window", {
        width: 1.1, height: 0.9, depth: 0.1,
      }, scene);
      window.position.set(offset, building.height * 0.58, building.depth / 2 + 0.02);
      window.material = glow;
      window.parent = pivot;
    }
  }

  return pivot;
}

function buildProp(
  scene: Scene,
  ostra: OstraDefinition,
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
  trunk.metadata = { blocksCamera: true };
  trunk.parent = pivot;

  const lower = facet(MeshBuilder.CreateCylinder("canopyLower", {
    diameterTop: radius * 2.1,
    diameterBottom: radius * 3.4,
    height: height * 0.34,
    tessellation: 7,
  }, scene));
  lower.position.y = height * 0.56;
  lower.material = leafDark;
  lower.metadata = { blocksCamera: true };
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
