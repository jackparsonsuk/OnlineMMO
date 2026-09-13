import { Color3 } from "@babylonjs/core/Maths/math.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
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
import { build, tint, voxelMaterial, voxelMesh, VOXEL, type Carve, type VoxelModel } from "./voxel.js";

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
    voxel: voxelMaterial(scene, "propVoxel"),
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
  | "footing" | "door" | "glass" | "lamplight" | "shadow" | "voxel",
  StandardMaterial
>;

/**
 * The props you walk past, as voxel models.
 *
 * Built once at module scope and reused: the models are pure data with no
 * scene in them, and meshing is the only part that costs anything, so a town
 * with thirty barrels pays for one barrel. Sizes are the same metres the boxes
 * occupied, in cells of 1/32 m.
 *
 * The four big set pieces — the well, the market stall, Fanshona's 36 m dock
 * and its boat — are still built from boxes below. A dense grid is the wrong
 * tool for a structure that long, and they want a repeating module instead;
 * they are the next thing to do here rather than something left out.
 */
const IRON = 0x3d3a36;
/** Skin, hair and belt leather are the same on every villager; only their
 *  cloth takes their own colour. */
const SKIN_TONE = 0xd8a77c;
const HAIR_TONE = 0x3a2a1e;
const LEATHER_BELT = 0x4a3524;

/** A barrel, bellied out in the middle and bound with four hoops. */
const BARREL = build(16, 26, 16, (v) => {
  for (let y = 0; y < 26; y++) {
    // Widest at the waist: a straight cylinder reads as a bin, not a barrel.
    const t = (y - 12.5) / 13;
    v.cylinder(8, 8, 7.6 - t * t * 1.8, y, 1, TIMBER_DARK);
  }
  for (const y of [1, 7, 17, 23]) v.cylinder(8, 8, 7.7, y, 2, IRON);
  v.cylinder(8, 8, 5.6, 25, 1, tint(TIMBER, 1.15));
  v.speckle(TIMBER_DARK, 51, [tint(TIMBER_DARK, 0.84), tint(TIMBER_DARK, 1.16)], 0.4);
});

/** A crate: planks, with the frame darker along all twelve edges. */
const CRATE = build(21, 21, 21, (v) => {
  v.fill(0, 0, 0, 21, 21, 21, TIMBER);
  v.speckle(TIMBER, 52, [tint(TIMBER, 0.86), tint(TIMBER, 1.12)], 0.4);
  for (const a of [0, 20]) {
    for (const b of [0, 20]) {
      v.fill(a, b, 0, 1, 1, 21, TIMBER_DARK);
      v.fill(a, 0, b, 1, 21, 1, TIMBER_DARK);
      v.fill(0, a, b, 21, 1, 1, TIMBER_DARK);
    }
  }
});

/** A felled log, built along z and turned a quarter when it is placed. Bark
 *  all over, pale cut ends with the grain showing. */
function logModel(diameter: number, length: number): VoxelModel {
  const d = Math.round(diameter * 32);
  const len = Math.round(length * 32);
  const r = d / 2;
  return build(d, d, len, (v) => {
    v.cylinderZ(r, r, r, 0, len, TIMBER_DARK);
    // Speckle is the one thing here with a real cost: two neighbouring cells
    // of different colours cannot be merged into one quad, so scattering it
    // over a three-metre trunk shatters the mesh. At 0.45 this log came out at
    // 10,500 triangles — more than three players. Big surfaces get it sparse.
    v.speckle(TIMBER_DARK, 53, [tint(TIMBER_DARK, 0.85), tint(TIMBER_DARK, 1.15)], 0.12);
    for (const z of [0, len - 2]) {
      v.cylinderZ(r, r, r - 1.2, z, 2, tint(TIMBER, 1.2));
      v.cylinderZ(r, r, r * 0.5, z, 2, tint(TIMBER, 1.0));
      v.cylinderZ(r, r, r * 0.22, z, 2, tint(TIMBER, 1.25));
    }
  });
}

const LOG = logModel(0.62, 3.4);
const PILE_LOG = logModel(0.46, 2.6);

/** A stump: bark round the outside, a pale cut face with growth rings. */
const STUMP = build(29, 16, 29, (v) => {
  v.cylinder(14.5, 14.5, 14, 0, 16, TIMBER_DARK);
  v.speckle(TIMBER_DARK, 54, [tint(TIMBER_DARK, 0.85), tint(TIMBER_DARK, 1.15)], 0.22);
  v.cylinder(14.5, 14.5, 12.5, 14, 2, tint(TIMBER, 1.2));
  v.cylinder(14.5, 14.5, 8, 15, 1, tint(TIMBER, 1.0));
  v.cylinder(14.5, 14.5, 4, 15, 1, tint(TIMBER, 1.28));
});

/** Two rails and two posts, as one model. */
const FENCE = build(5, 34, 90, (v) => {
  v.fill(1, 22, 0, 3, 4, 90, TIMBER);
  v.fill(1, 11, 0, 3, 4, 90, TIMBER);
  v.speckle(TIMBER, 55, [tint(TIMBER, 0.88), tint(TIMBER, 1.1)], 0.16);
  for (const z of [0, 85]) {
    v.fill(0, 0, z, 5, 34, 5, TIMBER_DARK);
    v.fill(0, 33, z, 5, 1, 5, tint(TIMBER_DARK, 1.2));
  }
  v.speckle(TIMBER_DARK, 56, [tint(TIMBER_DARK, 0.84), tint(TIMBER_DARK, 1.16)], 0.35);
});

/** The lamp's post and its bracket. The lantern itself stays an emissive
 *  polyhedron — it is a light source, not a surface. */
const LAMP_POST = build(7, 80, 7, (v) => {
  v.cylinder(3.5, 3.5, 2.6, 0, 76, TIMBER_DARK);
  v.fill(2, 0, 2, 3, 3, 3, IRON);
  v.fill(1, 74, 1, 5, 3, 5, IRON);
  v.fill(3, 76, 3, 1, 4, 1, IRON);
  v.speckle(TIMBER_DARK, 57, [tint(TIMBER_DARK, 0.85), tint(TIMBER_DARK, 1.15)], 0.35);
});


/** The well: a laid stone ring with a shaft you cannot see the bottom of, two
 *  posts and a little slate roof. */
const WELL = build(51, 66, 51, (v) => {
  v.cylinder(25.5, 25.5, 25.5, 0, 24, STONE);
  // Courses round the outside, and the joints staggered between them.
  for (let y = 5; y < 24; y += 6) v.cylinder(25.5, 25.5, 25.5, y, 1, tint(STONE, 0.7));
  v.cylinder(25.5, 25.5, 18, 0, 24, 0x161c22);
  v.cylinder(25.5, 25.5, 18, 19, 2, 0x2a4a5a);
  for (const x of [2, 45]) {
    v.fill(x, 22, 23, 4, 39, 4, TIMBER_DARK);
    v.fill(x - 1, 59, 22, 6, 2, 6, TIMBER);
  }
  // The windlass between the posts, and the rope off it.
  v.cylinder(25.5, 25.5, 2.5, 0, 0, TIMBER);
  v.fill(6, 54, 24, 39, 4, 4, TIMBER);
  v.fill(24, 26, 25, 2, 28, 2, 0x8a7a5a);
  // A flat slate cap on top: a well roof is a lid, not a house.
  v.fill(0, 61, 5, 51, 4, 42, SLATE);
  for (let z = 8; z < 45; z += 9) v.fill(0, 64, z, 51, 1, 1, tint(SLATE, 0.72));
});

/** A market stall: a plank table on four legs, with goods on it. The awning is
 *  a separate model because it is tipped forward. */
const STALL_TABLE = build(64, 62, 29, (v) => {
  v.fill(0, 58, 0, 64, 4, 29, TIMBER);
  for (let x = 7; x < 64; x += 8) v.fill(x, 61, 0, 1, 1, 29, tint(TIMBER, 0.72));
  for (const x of [0, 61]) for (const z of [0, 26]) v.fill(x, 0, z, 3, 58, 3, TIMBER_DARK);
  // A rail between the legs, so the frame reads as built rather than balanced.
  v.fill(0, 20, 1, 64, 2, 2, TIMBER_DARK);
  v.fill(0, 20, 26, 64, 2, 2, TIMBER_DARK);
});

function stallAwning(cloth: number): VoxelModel {
  return build(74, 2, 42, (v) => {
    v.fill(0, 0, 0, 74, 2, 42, cloth);
    // Stripes down the cloth, which is what a market awning is.
    for (let x = 0; x < 74; x += 16) v.fill(x, 1, 0, 8, 1, 42, tint(cloth, 1.22));
  });
}

/** Goods on the stall: a sack and two crated things. */
const STALL_GOODS = build(13, 8, 11, (v) => {
  v.fill(0, 0, 0, 13, 8, 11, PLASTER);
  v.fill(0, 0, 0, 13, 1, 11, tint(PLASTER, 0.8));
  v.bevelAll();
});

/**
 * One three-and-a-half metre span of Fanshona's dock, repeated down its
 * length. Thirty-six metres as a single grid would be over a million cells
 * before a face was drawn; as a module it is fifty thousand, meshed once.
 */
const DOCK_SPAN = build(83, 108, 112, (v) => {
  v.fill(0, 103, 0, 83, 5, 112, TIMBER);
  // Boards across the walkway, the way a jetty is planked.
  for (let z = 9; z < 112; z += 10) v.fill(0, 107, z, 83, 1, 1, tint(TIMBER, 0.68));
  for (const x of [4, 73]) v.fill(x, 0, 50, 6, 103, 6, TIMBER_DARK);
});

/** A clinker-built rowing boat: a hull of overlapping strakes, a raised
 *  gunwale, and a bow that comes to a point. */
const BOAT = build(40, 22, 100, (v) => {
  for (let z = 0; z < 100; z++) {
    // Narrows to nothing at the bow and tucks in at the stern.
    const bow = z > 74 ? (100 - z) / 26 : 1;
    const stern = z < 10 ? 0.55 + z / 22 : 1;
    const half = 18 * Math.min(bow, stern);
    if (half < 1.5) continue;
    for (let y = 0; y < 14; y++) {
      // A rounded bottom rather than a box.
      const rise = 1 - (7 - Math.min(y, 7)) / 9;
      v.fill(Math.round(20 - half * rise), y, z, Math.max(1, Math.round(half * rise * 2)), 1, 1, TIMBER_DARK);
    }
    v.fill(Math.round(20 - half), 14, z, Math.max(1, Math.round(half * 2)), 2, 1, TIMBER);
  }
  // Two thwarts to sit on.
  for (const z of [34, 60]) v.fill(6, 15, z, 28, 2, 6, TIMBER);
});

/** The prop models, for the art bench in `voxelPreview.ts`. Nothing in the
 *  game reads this — the props are built through `buildProp` as they always
 *  were. */
export const PROP_MODELS: Readonly<Record<string, VoxelModel>> = {
  barrel: BARREL,
  crate: CRATE,
  stump: STUMP,
  fence: FENCE,
  lamp: LAMP_POST,
  log: LOG,
};

/**
 * Walls and roofs, as thin voxel panels.
 *
 * A building cannot be a solid grid: Daso's hall is twelve metres by five, and
 * at 1/32 m that is fifteen million cells before a single face is drawn. But
 * nobody ever sees the inside of a wall — only its surface — so each face is
 * built as a slab six cells thick, which is a quarter of a million cells and
 * meshes in a few milliseconds. That is also exactly where the grain belongs:
 * courses in the stone, planks in the timber, a plaster panel between studs.
 *
 * Panels are cached by size and kind, because a town is mostly the same few
 * walls over and over.
 */
export type WallKind = "stone" | "halfTimber" | "plank";

const WALL_CELLS = 6;
const panelCache = new Map<string, VoxelModel>();

/**
 * The grain of a wall face, painted over a whole rectangle. The gable carves
 * its triangle out of this afterwards, which is why the grain is drawn first
 * and the shape second: a course drawn onto empty cells would put stone back
 * outside the triangle.
 */
function paintWall(v: Carve, w: number, h: number, z: number, kind: WallKind): void {
  if (kind === "stone") {
    v.fill(0, 0, 0, w, h, z + 1, STONE);
    const mortar = tint(STONE, 0.68);
    for (let y = 12; y < h; y += 12) v.fill(0, y, z, w, 1, 1, mortar);
    for (let y = 0; y < h; y += 12) {
      for (let x = ((y / 12) & 1) === 0 ? 0 : 16; x < w; x += 32) {
        v.fill(x, y, z, 1, Math.min(12, h - y), 1, mortar);
      }
    }
  } else if (kind === "plank") {
    v.fill(0, 0, 0, w, h, z + 1, TIMBER_DARK);
    for (let x = 9; x < w; x += 10) v.fill(x, 0, z, 1, h, 1, tint(TIMBER_DARK, 0.7));
  } else {
    // Half-timbering: a plaster panel between a timber sill, head and studs.
    // It is the one thing that stops a row of brown boxes reading as a row
    // of brown boxes, and now it is in the wall rather than a box round it.
    const sill = Math.round(h * 0.3);
    const head = Math.round(h * 0.82);
    v.fill(0, 0, 0, w, h, z + 1, TIMBER);
    v.fill(0, sill, 0, w, head - sill, z + 1, PLASTER);
    v.fill(0, sill - 3, z, w, 3, 1, TIMBER_DARK);
    v.fill(0, head, z, w, 3, 1, TIMBER_DARK);
    // Studs at a bit over a metre, which is where they would really be.
    for (let x = 16; x < w - 8; x += 36) v.fill(x, sill, z, 4, head - sill, 1, TIMBER_DARK);
  }
}

function wallPanel(widthM: number, heightM: number, kind: WallKind): VoxelModel {
  const key = `${widthM.toFixed(2)}:${heightM.toFixed(2)}:${kind}`;
  const cached = panelCache.get(key);
  if (cached) return cached;

  const w = Math.max(2, Math.round(widthM / VOXEL));
  const h = Math.max(2, Math.round(heightM / VOXEL));
  // Only the outward face is detailed, and the caller turns the panel so that
  // face points out of the building. Detailing both doubled the cost of every
  // wall in the game to draw a course of stone on the inside of a room nobody
  // can enter.
  //
  // No speckle on architecture either. On a body it is a couple of hundred
  // cells and it is what makes cloth look like cloth; on a twelve-metre wall
  // it is five thousand, every one of them breaking a merge, and it cost more
  // triangles than the whole town put together. Walls get structured grain —
  // courses, planks, studs — which merges into long strips almost for free.
  const model = build(w, h, WALL_CELLS, (v) => paintWall(v, w, h, WALL_CELLS - 1, kind));
  panelCache.set(key, model);
  return model;
}

/**
 * A gable: the triangle of wall between the two slopes of a roof.
 *
 * These were the last smooth surface on a building — the roof used to be a
 * solid prism whose ends showed as two flat grey triangles above all that
 * stonework. The slopes of that prism were never visible (the slabs lie on
 * them and overhang past them) and neither was its underside, so the prism is
 * gone and only its two ends remain, as panels the same six cells thick as the
 * walls, wearing the same grain.
 */
function gablePanel(depthM: number, riseM: number, kind: WallKind): VoxelModel {
  const key = `gable:${depthM.toFixed(2)}:${riseM.toFixed(2)}:${kind}`;
  const cached = panelCache.get(key);
  if (cached) return cached;

  const w = Math.max(2, Math.round(depthM / VOXEL));
  const h = Math.max(2, Math.round(riseM / VOXEL));
  const model = build(w, h, WALL_CELLS, (v) => {
    paintWall(v, w, h, WALL_CELLS - 1, kind);
    // Then cut the triangle out of it: base the full depth, apex at the ridge.
    // The steps this leaves down each slope are covered by the roof slabs.
    for (let y = 0; y < h; y++) {
      const half = (w / 2) * (1 - y / h);
      const left = Math.round(w / 2 - half);
      const right = Math.round(w / 2 + half);
      v.clear(0, y, 0, left, 1, WALL_CELLS);
      v.clear(right, y, 0, w - right, 1, WALL_CELLS);
    }
  });

  panelCache.set(key, model);
  return model;
}

/** The beam capping the seam where the two roof slabs meet. */
function ridgeBeam(lengthM: number, thatched: boolean): VoxelModel {
  const key = `ridge:${lengthM.toFixed(2)}:${thatched}`;
  const cached = panelCache.get(key);
  if (cached) return cached;
  const w = Math.max(2, Math.round(lengthM / VOXEL));
  const base = thatched ? TIMBER_DARK : SLATE;
  const model = build(w, 7, 9, (v) => {
    v.fill(0, 0, 0, w, 7, 9, base);
    // Pegged along its length if it is timber, ridged if it is slate.
    for (let x = 6; x < w; x += thatched ? 24 : 10) v.fill(x, 6, 0, 2, 1, 9, tint(base, 0.72));
    v.bevelAll();
  });
  panelCache.set(key, model);
  return model;
}

/** A chimney: laid stone with a wider course at the top, seen against the sky
 *  from anywhere in the town. */
function chimneyStack(heightM: number): VoxelModel {
  const key = `chimney:${heightM.toFixed(2)}`;
  const cached = panelCache.get(key);
  if (cached) return cached;
  const h = Math.max(8, Math.round(heightM / VOXEL));
  const model = build(24, h, 24, (v) => {
    v.fill(2, 0, 2, 20, h, 20, FOOTING);
    for (let y = 10; y < h - 6; y += 10) v.fill(2, y, 2, 20, 1, 20, tint(FOOTING, 0.72));
    // The cap, oversailing the stack, and the flue down the middle of it.
    v.fill(0, h - 5, 0, 24, 4, 24, tint(FOOTING, 0.86));
    v.fill(8, h - 4, 8, 8, 4, 8, 0x11100f);
    v.bevel(2, 0, 2, 20, h - 5, 20);
  });
  panelCache.set(key, model);
  return model;
}

/** A plank door with a brace across it and an iron ring. */
function doorLeaf(widthM: number, heightM: number): VoxelModel {
  const key = `door:${widthM.toFixed(2)}:${heightM.toFixed(2)}`;
  const cached = panelCache.get(key);
  if (cached) return cached;
  const w = Math.max(4, Math.round(widthM / VOXEL));
  const h = Math.max(4, Math.round(heightM / VOXEL));
  const model = build(w, h, 4, (v) => {
    v.fill(0, 0, 0, w, h, 4, DOOR);
    for (let x = 7; x < w; x += 8) v.fill(x, 0, 3, 1, h, 1, tint(DOOR, 0.66));
    // Two rails and the ring, at the height a hand would find it.
    for (const y of [Math.round(h * 0.18), Math.round(h * 0.76)]) {
      v.fill(0, y, 3, w, 3, 1, tint(DOOR, 0.5));
    }
    v.fill(w - 9, Math.round(h * 0.45), 3, 5, 5, 1, 0x3d3a36);
    v.fill(w - 8, Math.round(h * 0.45) + 1, 3, 3, 3, 1, DOOR);
  });
  panelCache.set(key, model);
  return model;
}

/** A roof slab: thatch runs down the slope in streaks, slate lies in courses
 *  across it. Both are read from above, which is where the camera mostly is. */
function roofPanel(widthM: number, thicknessM: number, slopeM: number, thatched: boolean): VoxelModel {
  const key = `roof:${widthM.toFixed(2)}:${thicknessM.toFixed(2)}:${slopeM.toFixed(2)}:${thatched}`;
  const cached = panelCache.get(key);
  if (cached) return cached;

  const w = Math.max(2, Math.round(widthM / VOXEL));
  const t = Math.max(3, Math.round(thicknessM / VOXEL));
  const d = Math.max(2, Math.round(slopeM / VOXEL));
  const base = thatched ? THATCH : SLATE;

  // Structured grain only, and only on the top: a roof is the largest surface
  // on a building and it is seen from above, so it is also the easiest place
  // to spend a hundred thousand triangles by accident.
  const model = build(w, t, d, (v) => {
    v.fill(0, 0, 0, w, t, d, base);
    if (thatched) {
      // Bundles down the slope, and a ragged line where they overhang.
      for (let x = 0; x < w; x += 8) {
        v.fill(x, t - 1, 0, 3, 1, d, ((x / 8) & 1) === 0 ? tint(THATCH, 0.84) : tint(THATCH, 1.12));
        v.clear(x, 0, d - 1 - ((x / 8) % 3), 8, t, 1 + ((x / 8) % 3));
      }
    } else {
      for (let z = 0; z < d; z += 10) {
        v.fill(0, t - 1, z, w, 1, 1, tint(SLATE, 0.7));
        // Every other course offset, so the slates overlap like slates.
        const offset = ((z / 10) & 1) === 0 ? 0 : 12;
        for (let x = offset; x < w; x += 24) v.fill(x, t - 1, z, 1, 1, Math.min(10, d - z), tint(SLATE, 0.78));
      }
    }
  });

  panelCache.set(key, model);
  return model;
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
  const wallKind: WallKind = style === "shed" ? "plank"
    : style === "stone" || (style === "hall" && stoneTown) ? "stone"
    : "halfTimber";

  /** One face of the building, turned so its detailed side points out. */
  const panel = (name: string, panelWidth: number, x: number, z: number, yaw: number): void => {
    const mesh = voxelMesh(scene, name, wallPanel(panelWidth, height, wallKind), "centre");
    mesh.position.set(x, height / 2, z);
    mesh.rotation.y = yaw;
    mesh.material = materials.voxel;
    mesh.metadata = { blocksCamera: true };
    mesh.parent = pivot;
  };

  // Four faces rather than one solid block: a wall's inside is never seen, and
  // a slab six cells thick is a grid small enough to hold the grain. The
  // half-timbering lives inside the panel now rather than in a box round it.
  const inset = (WALL_CELLS * VOXEL) / 2;
  panel("wallFront", width, 0, depth / 2 - inset, 0);
  panel("wallBack", width, 0, -depth / 2 + inset, Math.PI);
  panel("wallLeft", depth - inset * 2, -width / 2 + inset, 0, -Math.PI / 2);
  panel("wallRight", depth - inset * 2, width / 2 - inset, 0, Math.PI / 2);

  // Corner posts, where the town builds in timber.
  if (style === "cottage" || (style === "hall" && !stoneTown)) {
    const tall = Math.round(height / VOXEL);
    const post = build(8, tall, 8, (v) => {
      v.fill(0, 0, 0, 8, tall, 8, TIMBER_DARK);
      v.bevelAll();
    });
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      const mesh = voxelMesh(scene, "post", post, "centre");
      mesh.position.set((x * width) / 2, height / 2, (z * depth) / 2);
      mesh.material = materials.voxel;
      mesh.parent = pivot;
    }
  }

  // --- the roof ---
  // Two slabs over a solid triangular body. The slabs' undersides lie exactly
  // on the body's slopes and run out past the walls, dipping below the wall
  // top at the eaves the way a real overhang does; the body's two ends are
  // the gables.
  const thatched = !(style === "shed" || style === "stone" || (style === "hall" && stoneTown));
  const overhang = style === "shed" ? 0.45 : 0.7;
  const pitch = style === "shed" ? 0.42 : style === "stone" ? 0.62 : 0.7;
  const thickness = style === "cottage" ? 0.22 : 0.14;
  const tan = Math.tan(pitch);
  const rise = (depth / 2) * tan;
  const eave = depth / 2 + overhang;
  const slope = eave / Math.cos(pitch);

  // The two gable ends. There is no prism between them any more: its slopes
  // were always hidden under the slabs and its underside was never visible, so
  // all the solid body did was show two smooth triangles above a voxel wall.
  for (const side of [-1, 1]) {
    const gable = voxelMesh(scene, "gable", gablePanel(depth, rise, wallKind), "base");
    gable.position.set((side * width) / 2, height, 0);
    gable.rotation.y = (side * Math.PI) / 2;
    gable.material = materials.voxel;
    gable.metadata = { blocksCamera: true };
    gable.parent = pivot;
  }

  for (const side of [-1, 1]) {
    // Along the slope from the ridge (z = 0) to the eave (z = side * eave),
    // centred halfway, lifted by half its thickness so its underside is the
    // slope. Rotating about x by +pitch tips a slab's +z end down (Babylon is
    // left-handed); the far side mirrors it.
    const along = eave / 2;
    const slab = voxelMesh(scene, "roof", roofPanel(width + overhang * 2, thickness, slope, thatched), "centre");
    slab.position.set(0, height + rise - along * tan + (thickness / 2) / Math.cos(pitch), side * along);
    slab.material = materials.voxel;
    slab.metadata = { blocksCamera: true };
    slab.parent = pivot;
    // The slope runs down the model's +z, so the far slab is turned about
    // rather than mirrored — a thatch bundle must still run downhill on both
    // sides. Babylon composes Y * X, and Ry(pi) * Rx(t) is Rx(-t) * Ry(pi), so
    // the half-turn flips the tilt as well: the local tilt is the same sign on
    // both slabs and the turn is what makes the far one lean the other way.
    slab.rotation.x = pitch;
    if (side < 0) slab.rotation.y = Math.PI;
  }
  // A ridge beam over the seam where the slabs meet.
  const ridge = voxelMesh(scene, "ridge", ridgeBeam(width + overhang * 2 + 0.1, thatched), "centre");
  ridge.position.set(0, height + rise + thickness * 0.7, 0);
  ridge.material = materials.voxel;
  ridge.parent = pivot;

  // A chimney through the back slope of anything people live in.
  if (style !== "shed") {
    const x = width * 0.28 * (idHash(building.id) % 2 === 0 ? 1 : -1);
    const z = -depth * 0.18;
    const top = height + rise + 0.9;
    const stack = voxelMesh(scene, "chimney", chimneyStack(top - height + 0.2), "base");
    stack.position.set(x, height - 0.2, z);
    stack.material = materials.voxel;
    stack.metadata = { blocksCamera: true };
    stack.parent = pivot;
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
    const leaf = voxelMesh(scene, "door", doorLeaf(0.95, doorHeight), "base");
    leaf.position.set(0, 0.2, front + 0.03);
    leaf.material = materials.voxel;
    leaf.parent = pivot;
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

  /** A voxel model hung on this prop's pivot, standing on the ground. */
  const voxel = (
    name: string,
    model: VoxelModel,
    y = 0,
    z = 0,
    yaw = 0,
  ): void => {
    const mesh = voxelMesh(scene, name, model, "base");
    mesh.position.set(0, y, z);
    mesh.rotation.y = yaw;
    mesh.material = materials.voxel;
    mesh.parent = pivot;
  };

  // Logs are modelled along z and turned a quarter to lie across the pivot,
  // the way the old rotated cylinders did.
  const log = (model: VoxelModel, y: number, z = 0): void =>
    voxel("log", model, y, z, Math.PI / 2);

  switch (prop.kind) {
    case "log":
      log(LOG, 0);
      break;

    case "woodpile":
      // Three, two, one — stacked the way anyone actually stacks logs.
      log(PILE_LOG, 0, -0.5);
      log(PILE_LOG, 0, 0);
      log(PILE_LOG, 0, 0.5);
      log(PILE_LOG, 0.46, -0.25);
      log(PILE_LOG, 0.46, 0.25);
      log(PILE_LOG, 0.92, 0);
      break;

    case "stump":
      voxel("stump", STUMP);
      break;

    case "barrel":
      voxel("barrel", BARREL);
      break;

    case "crate":
      voxel("crate", CRATE);
      break;

    case "fence":
      voxel("fence", FENCE);
      break;

    case "lamp": {
      voxel("lampPost", LAMP_POST);

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
      voxel("well", WELL);
      break;
    }

    case "stall": {
      voxel("stallTable", STALL_TABLE);
      // Cloth in one of a few colours, by position, so a row of stalls isn't
      // one stall repeated.
      const cloths = [0xb8483a, 0x3a6ab8, 0xc89a3a, 0x5a8a4a];
      const cloth = cloths[Math.abs(Math.round(prop.x * 3 + prop.z * 7)) % cloths.length]!;
      const awning = voxelMesh(scene, "stallAwning", stallAwning(cloth), "base");
      awning.position.set(0, 1.95, 0.1);
      awning.rotation.x = 0.2;
      awning.material = materials.voxel;
      awning.parent = pivot;
      for (let k = 0; k < 3; k++) {
        const good = voxelMesh(scene, "goods", STALL_GOODS, "base");
        good.position.set(-0.6 + k * 0.6, 0.94, 0);
        good.material = materials.voxel;
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
      const span = 3.5;
      for (let z = -length / 2; z < length / 2; z += span) {
        const piece = voxelMesh(scene, "dockSpan", DOCK_SPAN, "base");
        piece.position.set(0, -3.22, z + span / 2);
        piece.material = materials.voxel;
        piece.parent = pivot;
      }
      break;
    }

    case "boat": {
      const surface = waterSurface(ostra, prop.x, prop.z) ?? pivot.position.y;
      pivot.position.y = surface - 0.12;
      voxel("boat", BOAT, -0.1);
      break;
    }
  }

  return pivot;
}

/** A tree: trunk plus two stacked canopy tiers, both faceted. */
/**
 * A tree in a town square, on the same coarse grid as the wilds. It is built
 * per size rather than instanced — a town has a dozen, not a thousand — and
 * cached, because most of them are the same size.
 */
const townTrees = new Map<string, VoxelModel>();

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

  const cell = 1 / 8;
  const key = `${radius.toFixed(2)}:${height.toFixed(2)}`;
  let model = townTrees.get(key);
  if (!model) {
    const c = (metres: number): number => Math.max(1, Math.round(metres / cell));
    const w = c(radius * 3.6);
    const h = c(height);
    const bark = 0x4f3a26;
    const leaf = 0x3f6b3a;
    model = build(w, h, w, (v) => {
      const mid = w / 2;
      v.cylinder(mid, mid, c(radius * 0.5), 0, c(height * 0.5), bark);
      v.speckle(bark, 131, [tint(bark, 0.82), tint(bark, 1.18)], 0.28);
      // Two stepped tiers, wide then narrow, the way the cones used to be.
      for (const tier of [
        { y: height * 0.4, tall: height * 0.34, radius: radius * 1.7, shade: 0.86 },
        { y: height * 0.62, tall: height * 0.4, radius: radius * 1.25, shade: 1.08 },
      ]) {
        const steps = c(tier.tall);
        for (let k = 0; k < steps; k++) {
          const r = c(tier.radius) * (1 - k / steps);
          if (r < 0.6) continue;
          v.cylinder(mid, mid, r, c(tier.y) + k, 1, tint(leaf, tier.shade));
        }
      }
      v.speckle(leaf, 132, [tint(leaf, 0.84), tint(leaf, 1.16)], 0.22);
    });
    townTrees.set(key, model);
  }

  const mesh = voxelMesh(scene, "tree", model, "base", cell);
  mesh.material = townTreeMaterial ??= voxelMaterial(scene, "townTree");
  mesh.parent = pivot;
  return pivot;
}

let townTreeMaterial: StandardMaterial | undefined;

export function buildVillager(
  scene: Scene,
  ostra: OstraDefinition,
  villager: VillagerDefinition,
): TransformNode {
  const pivot = new TransformNode(`villager:${villager.name}`, scene);
  pivot.position.set(villager.x, heightAt(villager.x, villager.z, ostra.terrain), villager.z);
  pivot.rotation.y = villager.yaw;

  // One material for the whole body: every colour rides in the vertex data,
  // so a street of villagers costs one draw call each.
  const material = voxelMaterial(scene, "villager");
  const cloth = villager.colour;
  const trouser = tint(villager.colour, 0.55);
  const apron = tint(villager.colour, 1.25);

  const put = (name: string, model: VoxelModel, y: number, x: number, parent: TransformNode = pivot): Mesh => {
    const mesh = voxelMesh(scene, name, model, "centre");
    mesh.position.set(x, y, 0);
    mesh.material = material;
    mesh.parent = parent;
    return mesh;
  };
  /** A joint to turn a part about, rather than the part's own middle. */
  const joint = (name: string, x: number, y: number): TransformNode => {
    const node = new TransformNode(name, scene);
    node.position.set(x, y, 0);
    node.parent = pivot;
    return node;
  };

  // A working body: a smock with an apron over it, sleeves, and a face. They
  // stand in doorways all day and you talk to them from a metre away, so they
  // are the models seen closest of anything in the game.
  const body = put("villagerBody", build(16, 16, 10, (v) => {
    v.fill(0, 0, 0, 16, 16, 10, cloth);
    v.fill(3, 0, 8, 10, 11, 2, apron);
    v.fill(0, 0, 0, 16, 2, 10, tint(LEATHER_BELT, 1));
    v.fill(0, 14, 0, 16, 2, 10, tint(cloth, 0.8));
    v.speckle(cloth, 101, [tint(cloth, 0.88), tint(cloth, 1.1)], 0.3);
    v.speckle(apron, 102, [tint(apron, 0.92), tint(apron, 1.06)], 0.25);
    v.bevelAll();
  }), 0.6, 0);

  // The head turns about the neck, and the arms swing from the shoulder.
  const neck = joint("villagerNeck", 0, 0.86);
  put("villagerHead", build(10, 10, 11, (v) => {
    v.fill(0, 0, 0, 10, 10, 10, SKIN_TONE);
    v.fill(0, 7, 0, 10, 3, 10, HAIR_TONE);
    v.fill(0, 3, 0, 10, 5, 4, HAIR_TONE);
    v.fill(0, 6, 8, 10, 1, 2, HAIR_TONE);
    v.fill(2, 4, 9, 2, 2, 1, 0x1e1c1a);
    v.fill(6, 4, 9, 2, 2, 1, 0x1e1c1a);
    v.fill(4, 1, 9, 2, 1, 1, tint(SKIN_TONE, 0.66));
    v.fill(4, 3, 10, 2, 2, 1, SKIN_TONE);
    v.speckle(SKIN_TONE, 103, [tint(SKIN_TONE, 0.95), tint(SKIN_TONE, 1.04)], 0.2);
    v.bevelAll();
  }), 0.16, 0, neck);

  const arm = build(4, 14, 5, (v) => {
    v.fill(0, 0, 0, 4, 14, 5, cloth);
    v.fill(0, 0, 0, 4, 3, 5, SKIN_TONE);
    v.speckle(cloth, 104, [tint(cloth, 0.88), tint(cloth, 1.1)], 0.3);
  });
  const leftShoulder = joint("villagerShoulder", -0.31, 0.8);
  const rightShoulder = joint("villagerShoulder", 0.31, 0.8);
  put("villagerArm", arm, -0.22, 0, leftShoulder);
  put("villagerArm", arm, -0.22, 0, rightShoulder);

  const leg = build(5, 12, 5, (v) => {
    v.fill(0, 0, 0, 5, 12, 5, trouser);
    v.fill(0, 0, 0, 5, 3, 5, LEATHER_BELT);
    v.speckle(trouser, 105, [tint(trouser, 0.88), tint(trouser, 1.12)], 0.28);
  });
  put("villagerLeg", leg, 0.18, -0.13);
  put("villagerLeg", leg, 0.18, 0.13);

  const life: VillagerLife = {
    pivot, body, neck, leftShoulder, rightShoulder,
    x: villager.x, z: villager.z, homeYaw: villager.yaw,
    // Each on their own clock, so a street does not breathe in unison.
    phase: (villager.x * 12.9898 + villager.z * 78.233) % 6.283,
    lookUntil: 0, lookYaw: 0, talkUntil: 0,
  };
  pivot.metadata = { villagerLife: life };
  return pivot;
}

// --- villagers living ----------------------------------------------------------

/** What animates one villager: the joints `buildVillager` made, and their mood. */
export interface VillagerLife {
  pivot: TransformNode;
  body: Mesh;
  neck: TransformNode;
  leftShoulder: TransformNode;
  rightShoulder: TransformNode;
  x: number;
  z: number;
  /** Where they face when nobody is about: out of their door. */
  homeYaw: number;
  phase: number;
  /** A glance to one side, now and then: until when, and how far. */
  lookUntil: number;
  lookYaw: number;
  /** Talking with their hands, until this. */
  talkUntil: number;
}

/** Within this, a villager turns to face you. */
const NOTICE_RANGE = 7;
/** Past this nobody can see them move, so they are left alone. */
const ANIMATE_RANGE = 70;

/**
 * One frame of a villager's life.
 *
 * They used to stand exactly still, facing out of their doors, and turn
 * nowhere when spoken to — the towns read as rows of statues. Now each
 * breathes, shifts its arms, glances about now and then, and turns to face
 * whoever comes near: body first, slowly, the head a little ahead of it. A
 * villager being talked to (`talking`) gestures as it speaks. All of it is
 * drawn only; a villager's place is fixed, and nothing about them is sent.
 */
export function animateVillager(life: VillagerLife, now: number, dt: number, playerX: number, playerZ: number, talking: boolean): void {
  const dx = playerX - life.x;
  const dz = playerZ - life.z;
  const range = Math.sqrt(dx * dx + dz * dz);
  if (range > ANIMATE_RANGE) return;
  const t = now / 1000 + life.phase;

  // Turn: to you when near, home again when you have gone.
  const noticed = range < NOTICE_RANGE;
  const facing = noticed ? Math.atan2(dx, dz) : life.homeYaw;
  const turn = wrapAngle(facing - life.pivot.rotation.y);
  life.pivot.rotation.y += turn * Math.min(1, dt * (noticed ? 3.2 : 1.2));

  // The head leads, and when nobody is near, glances about by itself.
  if (!noticed && now > life.lookUntil) {
    const glancing = Math.sin(t * 7.1) > 0.4;
    life.lookYaw = glancing ? Math.sin(t * 3.3) * 0.7 : 0;
    life.lookUntil = now + 1500 + ((Math.abs(Math.sin(t * 5.7)) * 3500) | 0);
  }
  const headTarget = noticed ? Math.max(-0.6, Math.min(0.6, wrapAngle(Math.atan2(dx, dz) - life.pivot.rotation.y))) : life.lookYaw;
  life.neck.rotation.y += (headTarget - life.neck.rotation.y) * Math.min(1, dt * 4);
  life.neck.rotation.x = Math.sin(t * 1.1) * 0.03;

  // Breathing, and a weight shifting from foot to foot.
  life.body.scaling.y = 1 + Math.sin(t * 1.7) * 0.015;
  life.pivot.rotation.z = Math.sin(t * 0.45) * 0.012;

  if (talking) life.talkUntil = now + 600;
  if (now < life.talkUntil) {
    // Hands out, making a point.
    life.rightShoulder.rotation.x = -0.55 + Math.sin(t * 5.2) * 0.25;
    life.rightShoulder.rotation.z = -0.15;
    life.leftShoulder.rotation.x = -0.2 + Math.sin(t * 3.9 + 1) * 0.12;
  } else {
    const ease = Math.min(1, dt * 3);
    life.rightShoulder.rotation.x += (Math.sin(t * 0.9) * 0.05 - life.rightShoulder.rotation.x) * ease;
    life.rightShoulder.rotation.z += (0 - life.rightShoulder.rotation.z) * ease;
    life.leftShoulder.rotation.x += (Math.sin(t * 0.9 + 2) * 0.05 - life.leftShoulder.rotation.x) * ease;
  }
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
