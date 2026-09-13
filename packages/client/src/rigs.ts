import { Color3 } from "@babylonjs/core/Maths/math.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { getArchetype, JUMP_SPEED, PLAYER_SIZE, type EnemyKind, type SpellId } from "@mmo/shared";
import { hexColour } from "./lowpoly.js";
import {
  build, sculpt, tint, voxelMaterial, voxelMesh, VOXEL,
  type Anchor, type Carve, type Sculpted, type VoxelModel,
} from "./voxel.js";

/**
 * Bodies that move.
 *
 * Every figure in the game used to be a rigid statue that slid across the
 * ground and swelled slightly when hit. That is most of why combat felt like
 * nothing: there was no wind-up to read, no swing to watch land, no flinch, no
 * fall. These rigs are the same blocky, faceted models, but built around
 * pivots — shoulders, hips, a waist — so procedural animation can move them.
 *
 * No skeletal animation, no clips, no files: each pose is a handful of angles
 * computed from time, speed and whatever the body is doing. It suits the art
 * style (stiff, deliberate, readable), and it means the animation can be timed
 * to the exact numbers the simulation uses — a Risen's arms come down at the
 * moment its blow actually lands.
 */

export type RigKind = "player" | EnemyKind;

export interface Rig {
  kind: RigKind;
  /** Placed at the feet, rotated to face. The caller owns its transform. */
  root: TransformNode;
  /** Child of root. Bob, lean, fall — anything the whole body does. */
  body: TransformNode;
  /** Named pivots. Which exist depends on the kind. */
  joints: Record<string, TransformNode>;
  /** Everything that should flash white on a hit. */
  materials: StandardMaterial[];
  /** Base emissive of each material, to restore after a flash. */
  baseEmissive: Color3[];
  /** Meshes a click can land on. */
  pickables: AbstractMesh[];
}


/**
 * A voxel part, hung off a joint exactly where a `box` used to be.
 *
 * The model is centred on the position it is given, so a part can be swapped
 * for the box it replaces without moving a single pivot — which is the whole
 * reason the rigs could be redrawn without touching the animation, or the
 * timings it shares with the simulation.
 */
function part(
  scene: Scene,
  rig: Rig,
  parent: TransformNode,
  model: VoxelModel,
  x: number,
  y: number,
  z: number,
  material: StandardMaterial,
  anchor: Anchor = "centre",
): AbstractMesh {
  const mesh = voxelMesh(scene, "part", model, anchor);
  mesh.position.set(x, y, z);
  mesh.material = material;
  mesh.parent = parent;
  rig.pickables.push(mesh);
  return mesh;
}

function joint(scene: Scene, name: string, parent: TransformNode, x: number, y: number, z: number): TransformNode {
  const node = new TransformNode(name, scene);
  node.position.set(x, y, z);
  node.parent = parent;
  return node;
}

function newRig(scene: Scene, kind: RigKind): Rig {
  const root = new TransformNode(kind, scene);
  const body = new TransformNode("body", scene);
  body.parent = root;
  return { kind, root, body, joints: {}, materials: [], baseEmissive: [], pickables: [] };
}

function track(rig: Rig, ...materials: StandardMaterial[]): void {
  for (const material of materials) {
    rig.materials.push(material);
    rig.baseEmissive.push(material.emissiveColor.clone());
  }
}

/** Gear and skin look the same on everyone. Only the tunic takes the player's
 *  own colour — that is the thing that has to tell two of you apart across a
 *  field, and it reads better as one strong block than as a whole recoloured
 *  body. */
const LEATHER = 0x4a3524;
const BRASS = 0x9a7b3f;
const SKIN = 0xd8a77c;
const HAIR = 0x3a2a1e;
const EYE = 0x1e1c1a;
const STEEL = 0xc9d4dc;

interface PlayerParts {
  leg: VoxelModel;
  arm: VoxelModel;
  chest: VoxelModel;
  head: VoxelModel;
  sword: VoxelModel;
  rod: VoxelModel;
}

/** The rod's length, in metres: 44 cells at 1/32 m. */
const ROD_LENGTH = 44 / 32;
/** How far the rod's butt sits behind the hand, so the fist closes on the grip. */
const ROD_BUTT = 0.09;

/**
 * The player's parts, at 1/32 m to a voxel.
 *
 * Every model here occupies exactly the box it replaced, so the joints it
 * hangs from did not move: 6x12x6 to a leg, 17x17x10 to a chest, 11x11x12 to a
 * head. What the extra cells buy is everything a box could not have — a boot
 * with a sole and a cuff, a belt with a buckle, a baldric stepped across the
 * chest, a face that is a face rather than a pale block glued to the front.
 *
 * Each surface is speckled with two or three shades of its own colour. It is a
 * couple of lines per part and it is most of the difference between cloth and
 * painted plastic.
 */
function playerParts(colour: number): PlayerParts {
  const tunic = colour;
  const trouser = tint(colour, 0.5);
  const yoke = tint(colour, 0.78);
  const cuff = tint(LEATHER, 1.25);
  // The arms sit barely clear of a 17-cell chest, so a sleeve in the tunic's
  // own colour vanishes into it from the front. A shade down separates them
  // the way the old darker limbs did, without going back to two-tone limbs.
  const sleeve = tint(colour, 0.84);

  const leg = build(6, 12, 6, (v) => {
    v.fill(0, 0, 0, 6, 1, 6, tint(LEATHER, 0.65));
    v.fill(0, 1, 0, 6, 3, 6, LEATHER);
    v.fill(0, 4, 0, 6, 1, 6, cuff);
    v.fill(0, 5, 0, 6, 7, 6, trouser);
    v.speckle(trouser, 11, [tint(trouser, 0.86), tint(trouser, 1.12)], 0.34);
    v.speckle(LEATHER, 12, [tint(LEATHER, 0.82), tint(LEATHER, 1.14)], 0.3);
  });

  const arm = build(5, 15, 5, (v) => {
    v.fill(0, 0, 0, 5, 3, 5, LEATHER);
    v.fill(0, 3, 0, 5, 3, 5, cuff);
    v.fill(0, 6, 0, 5, 7, 5, sleeve);
    v.fill(0, 13, 0, 5, 2, 5, tint(sleeve, 0.9));
    v.speckle(sleeve, 13, [tint(sleeve, 0.88), tint(sleeve, 1.1)], 0.34);
    v.speckle(LEATHER, 14, [tint(LEATHER, 0.82), tint(LEATHER, 1.14)], 0.3);
  });

  const chest = build(17, 17, 10, (v) => {
    v.fill(0, 0, 0, 17, 17, 10, tunic);
    v.fill(0, 15, 0, 17, 2, 10, yoke);
    // The belt, and its buckle on the front — +z is where the body faces.
    v.fill(0, 0, 0, 17, 3, 10, LEATHER);
    v.fill(6, 0, 8, 5, 3, 2, BRASS);
    // A baldric over the left shoulder, stepped down across the chest. Stairs
    // are how a voxel draws a diagonal, and at this resolution they read as one.
    for (let s = 0; s < 6; s++) v.fill(3 + s * 2, 13 - s * 2, 8, 3, 3, 2, cuff);
    v.speckle(tunic, 21, [tint(tunic, 0.88), tint(tunic, 1.1), tint(tunic, 0.96)], 0.4);
    v.speckle(LEATHER, 22, [tint(LEATHER, 0.82), tint(LEATHER, 1.14)], 0.3);
    // Shaped last, so nothing fills the corners back in. Square corners on a
    // 17-cell block are the thing we are trying to stop looking like: the
    // waist comes in, the shoulders are clipped and the four vertical edges
    // are chamfered. It costs nothing, and the AO does the rest.
    for (const x of [0, 16]) {
      v.clear(x, 0, 0, 1, 5, 10);
      v.clear(x, 16, 0, 1, 1, 10);
      for (const z of [0, 9]) v.clear(x, 0, z, 1, 17, 1);
    }
    for (const z of [0, 9]) v.clear(1, 16, z, 15, 1, 1);
  });

  // One cell deeper than it is wide, so the nose can stand proud of the face.
  const head = build(11, 11, 12, (v) => {
    v.fill(0, 0, 0, 11, 11, 11, SKIN);
    v.fill(0, 8, 0, 11, 3, 11, HAIR);
    v.fill(0, 3, 0, 11, 8, 4, HAIR);
    v.fill(0, 7, 9, 11, 1, 2, HAIR);
    v.fill(2, 5, 10, 2, 2, 1, EYE);
    v.fill(7, 5, 10, 2, 2, 1, EYE);
    v.fill(4, 2, 10, 3, 1, 1, tint(SKIN, 0.66));
    v.fill(5, 4, 11, 1, 2, 1, SKIN);
    v.speckle(SKIN, 31, [tint(SKIN, 0.94), tint(SKIN, 1.05)], 0.22);
    v.speckle(HAIR, 32, [tint(HAIR, 0.8), tint(HAIR, 1.25)], 0.35);
    // Corners off the crown and the jaw, for the same reason as the chest.
    for (const x of [0, 10]) {
      v.clear(x, 10, 0, 1, 1, 11);
      v.clear(x, 0, 0, 1, 1, 11);
      for (const z of [0, 10]) v.clear(x, 0, z, 1, 11, 1);
    }
  });

  // The blade is what makes a swing readable at a distance — an arm moving is
  // a gesture, a blade moving is an attack — so it keeps its old length.
  const sword = build(7, 4, 25, (v) => {
    v.fill(2, 0, 0, 3, 4, 2, BRASS);
    v.fill(2, 1, 2, 3, 2, 4, LEATHER);
    v.fill(0, 0, 6, 7, 4, 2, BRASS);
    v.fill(2, 0, 8, 3, 4, 16, STEEL);
    v.fill(3, 1, 24, 1, 2, 1, STEEL);
    v.fill(2, 0, 8, 3, 1, 16, tint(STEEL, 1.14));
    v.fill(2, 3, 8, 3, 1, 16, tint(STEEL, 1.14));
    v.speckle(STEEL, 41, [tint(STEEL, 0.9)], 0.18);
  });

  // A rod, only out while fishing: a cork grip, a brass reel hung beneath it,
  // and a cane that thins to a red-whipped tip. Long, because the line leaving
  // the tip is most of what says "fishing" from across a lake.
  const CORK = 0xb08a5a;
  const CANE = 0x7a5530;
  const rod = build(3, 4, 44, (v) => {
    v.fill(0, 1, 0, 3, 3, 9, CORK);
    v.fill(1, 0, 3, 1, 1, 3, BRASS);
    v.fill(0, 1, 9, 3, 3, 1, BRASS);
    v.fill(1, 2, 10, 2, 2, 16, CANE);
    v.fill(1, 2, 26, 1, 1, 17, tint(CANE, 1.15));
    v.fill(1, 2, 43, 1, 1, 1, 0xb03a2a);
    v.speckle(CORK, 51, [tint(CORK, 0.86), tint(CORK, 1.1)], 0.4);
  });

  return { leg, arm, chest, head, sword, rod };
}

/**
 * A player. The colours all travel in the vertex data, so the whole body is
 * one material — which is also the one thing that flashes white when hit.
 */
export function buildPlayerRig(scene: Scene, colour: number): Rig {
  const rig = newRig(scene, "player");
  const u = PLAYER_SIZE;
  const skin = voxelMaterial(scene, "player");
  track(rig, skin);
  const parts = playerParts(colour);

  const hips = 0.38 * u;
  const legL = joint(scene, "legL", rig.body, -0.14 * u, hips, 0);
  const legR = joint(scene, "legR", rig.body, 0.14 * u, hips, 0);
  part(scene, rig, legL, parts.leg, 0, -0.19 * u, 0, skin);
  part(scene, rig, legR, parts.leg, 0, -0.19 * u, 0, skin);

  // The waist: leaning and twisting happen here, so the legs stay planted.
  const chest = joint(scene, "chest", rig.body, 0, hips, 0);
  part(scene, rig, chest, parts.chest, 0, 0.24 * u, 0, skin);
  const head = joint(scene, "head", chest, 0, 0.5 * u, 0);
  part(scene, rig, head, parts.head, 0, 0.17 * u, 0, skin);

  const armL = joint(scene, "armL", chest, -0.33 * u, 0.45 * u, 0);
  const armR = joint(scene, "armR", chest, 0.33 * u, 0.45 * u, 0);
  part(scene, rig, armL, parts.arm, 0, -0.21 * u, 0, skin);
  part(scene, rig, armR, parts.arm, 0, -0.21 * u, 0, skin);

  // Held forward from the fist, so it points where the arm swings. Unlike the
  // old bare blade this one has a grip and a pommel behind the guard, so it is
  // pushed forward until the grip — not the butt — sits in the hand.
  const blade = joint(scene, "blade", armR, 0, -0.42 * u, 0.04 * u);
  part(scene, rig, blade, parts.sword, 0, 0, 0.266, skin);

  // In the same hand as the blade, which is put away while the rod is out
  // (see `Animator.angling`). `rodTip` is where the line leaves it.
  const rod = joint(scene, "rod", armR, 0, -0.42 * u, 0.04 * u);
  part(scene, rig, rod, parts.rod, 0, 0, ROD_LENGTH / 2 - ROD_BUTT, skin);
  const rodTip = joint(scene, "rodTip", rod, 0, 0, ROD_LENGTH - ROD_BUTT);
  rod.setEnabled(false);

  Object.assign(rig.joints, { legL, legR, chest, head, armL, armR, blade, rod, rodTip });
  return rig;
}

/**
 * The creatures, as voxel models.
 *
 * Every joint below sits exactly where it did when these were boxes, because
 * the poses in `Animator` reach for them by name and their timings are the
 * simulation's — a Risen's arms still come down on the frame its blow lands.
 * What changed is only what hangs off them: `sculpt` takes the same centres
 * and sizes in metres the boxes had and returns one model per joint, so a
 * wolf's torso, shoulders and belly are a single mesh with the occlusion
 * running across the joins instead of stopping at them.
 *
 * Each creature gets two materials. One for the body, and one with an
 * emissive for the single thing on it that glows — eyes, a rune, a gullet.
 * That is down from the four or five each used to have, and both are tracked
 * so the whole body still flashes white when it is hit.
 */

/** A creature's body colour and the one thing on it that glows. */
function creatureSkin(
  scene: Scene,
  rig: Rig,
  name: string,
  glowColour: number,
): { skin: StandardMaterial; glow: StandardMaterial } {
  const skin = voxelMaterial(scene, `${name}Skin`);
  const glow = voxelMaterial(scene, `${name}Glow`);
  glow.emissiveColor = hexColour(glowColour);
  track(rig, skin, glow);
  return { skin, glow };
}

/** Hang a sculpted part on a joint. The anchor already holds the offsets the
 *  boxes used to carry, so the position is the joint itself. */
function sculpted(
  scene: Scene,
  rig: Rig,
  parent: TransformNode,
  s: Sculpted,
  material: StandardMaterial,
): AbstractMesh {
  return part(scene, rig, parent, s.model, 0, 0, 0, material, s.anchor);
}

/** Hunched, long-armed, head forward of its shoulders, arms reaching. */
function buildZombieRig(scene: Scene, colour?: number): Rig {
  const archetype = getArchetype("zombie");
  // A variant's own colour on the kind's body.
  const flesh = colour ?? archetype.colour;
  const rig = newRig(scene, "zombie");
  const rot = tint(flesh, 0.6);
  const rag = 0x54503f;
  const bone = 0xd8d2bc;
  const { skin, glow } = creatureSkin(scene, rig, "zombie", 0x7a8a20);

  const hips = 0.66;
  const legL = joint(scene, "legL", rig.body, -0.16, hips, 0);
  const legR = joint(scene, "legR", rig.body, 0.16, hips, 0);
  const leg = sculpt([{ at: [0, -0.33, 0], size: [0.2, 0.66, 0.2], colour: rot }], (v, cell) => {
    // Rags wound round the shin, and the bone showing through at the ankle.
    const [x, y, z] = cell(-0.1, -0.62, -0.1);
    v.fill(Math.round(x), Math.round(y) + 3, Math.round(z), 7, 6, 7, rag);
    v.fill(Math.round(x) + 1, Math.round(y), Math.round(z) + 1, 4, 3, 4, bone);
    v.speckle(rot, 61, [tint(rot, 0.82), tint(rot, 1.16)], 0.3);
  });
  sculpted(scene, rig, legL, leg, skin);
  sculpted(scene, rig, legR, leg, skin);

  const chest = joint(scene, "chest", rig.body, 0, hips, 0);
  sculpted(scene, rig, chest, sculpt(
    [{ at: [0, 0.36, 0], size: [0.58, 0.72, 0.36], colour: flesh }],
    (v, cell) => {
      // A torn tunic over the top, and the ribs bared under it on one side.
      const [x, y, z] = cell(-0.29, 0.0, -0.18);
      const bx = Math.round(x);
      const by = Math.round(y);
      const bz = Math.round(z);
      v.fill(bx, by + 10, bz, 19, 13, 12, rag);
      for (let r = 0; r < 4; r++) v.fill(bx + 2, by + 3 + r * 2, bz + 10, 7, 1, 2, bone);
      v.speckle(flesh, 62, [tint(flesh, 0.84), tint(flesh, 1.14)], 0.34);
      v.speckle(rag, 63, [tint(rag, 0.84), tint(rag, 1.16)], 0.3);
      v.bevelAll();
    },
  ), skin);

  const head = joint(scene, "head", chest, 0, 0.74, 0.1);
  sculpted(scene, rig, head, sculpt(
    [{ at: [0, 0.14, 0.06], size: [0.36, 0.36, 0.36], colour: flesh }],
    (v, cell) => {
      const [x, y, z] = cell(-0.18, -0.04, -0.12);
      const bx = Math.round(x);
      const by = Math.round(y);
      const bz = Math.round(z);
      // Sunken sockets, a hanging jaw, and what is left of its hair.
      v.fill(bx + 2, by + 6, bz + 10, 3, 3, 2, tint(flesh, 0.35));
      v.fill(bx + 7, by + 6, bz + 10, 3, 3, 2, tint(flesh, 0.35));
      v.fill(bx + 3, by + 1, bz + 10, 6, 3, 2, tint(flesh, 0.3));
      for (let t = 0; t < 3; t++) v.fill(bx + 3 + t * 2, by + 2, bz + 11, 1, 1, 1, bone);
      v.fill(bx, by + 9, bz, 12, 3, 8, tint(rot, 0.7));
      v.speckle(flesh, 64, [tint(flesh, 0.82), tint(flesh, 1.16)], 0.36);
      v.bevelAll();
    },
  ), skin);
  // The one bright note on the model, so a Risen is identifiable at distance.
  part(scene, rig, head, build(8, 2, 2, (v) => v.fill(0, 0, 0, 8, 2, 2, 0xd8e85a)), 0, 0.18, 0.25, glow);

  const armL = joint(scene, "armL", chest, -0.38, 0.62, 0.04);
  const armR = joint(scene, "armR", chest, 0.38, 0.62, 0.04);
  const arm = sculpt([{ at: [0, -0.3, 0], size: [0.16, 0.64, 0.18], colour: rot }], (v, cell) => {
    const [x, y, z] = cell(-0.08, -0.62, -0.09);
    const bx = Math.round(x);
    const by = Math.round(y);
    const bz = Math.round(z);
    // Fingers, so a reaching arm reads as reaching.
    for (const fx of [0, 2, 4]) v.fill(bx + fx, by - 2, bz + 2, 1, 3, 2, rot);
    v.fill(bx, by + 12, bz, 5, 5, 6, rag);
    v.speckle(rot, 65, [tint(rot, 0.82), tint(rot, 1.16)], 0.3);
  });
  sculpted(scene, rig, armL, arm, skin);
  sculpted(scene, rig, armR, arm, skin);

  Object.assign(rig.joints, { legL, legR, chest, head, armL, armR });
  return rig;
}

/** Low, wide, eight-legged. Reads instantly from above, which is the angle the
 *  third-person camera mostly gives you. */
function buildSpiderRig(scene: Scene, colour?: number): Rig {
  const archetype = getArchetype("spider");
  // A variant's own colour on the kind's body.
  const shellColour = colour ?? archetype.colour;
  const rig = newRig(scene, "spider");
  const dark = tint(shellColour, 0.55);
  const pale = tint(shellColour, 1.5);
  const { skin, glow } = creatureSkin(scene, rig, "spider", 0x8a2038);

  // The body pivots at its middle, so rearing up tips it backwards.
  const thorax = joint(scene, "thorax", rig.body, 0, 0.42, 0);
  sculpted(scene, rig, thorax, sculpt(
    [
      { at: [0, 0.02, -0.26], size: [0.78, 0.64, 0.9], colour: shellColour, round: true },
      { at: [0, -0.02, 0.24], size: [0.5, 0.4, 0.5], colour: shellColour, round: true },
    ],
    (v, cell) => {
      // A pale mark down the abdomen, and the fangs under the head.
      const [mx, my, mz] = cell(-0.06, 0.24, -0.62);
      v.fill(Math.round(mx), Math.round(my), Math.round(mz), 4, 3, 14, pale);
      const [fx, fy, fz] = cell(-0.1, -0.2, 0.36);
      for (const dx of [0, 4]) v.fill(Math.round(fx) + dx, Math.round(fy), Math.round(fz), 2, 5, 3, dark);
      v.speckle(shellColour, 71, [tint(shellColour, 0.8), tint(shellColour, 1.2)], 0.35);
    },
  ), skin);
  part(scene, rig, thorax, build(7, 2, 2, (v) => v.fill(0, 0, 0, 7, 2, 2, 0xd8506a)), 0, 0.03, 0.45, glow);

  // Four a side, splayed and angled down, each swinging from the shoulder.
  const legModel = build(4, 20, 4, (v) => {
    v.fill(0, 0, 0, 4, 20, 4, dark);
    // A paler band at the knee, so eight legs in motion are legible.
    v.fill(0, 9, 0, 4, 2, 4, tint(dark, 1.5));
    v.fill(0, 0, 0, 4, 2, 4, tint(dark, 0.7));
  });
  const spread = [0.85, 0.35, -0.2, -0.7];
  let index = 0;
  for (let side = 0; side < 2; side++) {
    const sign = side === 0 ? -1 : 1;
    for (const along of spread) {
      const pivot = joint(scene, `leg${index}`, thorax, sign * 0.2, 0, along * 0.5);
      pivot.rotation.z = sign * 0.75;
      pivot.rotation.y = -sign * along * 0.6;
      // Remember the rest pose; the gait oscillates around it.
      pivot.metadata = { restZ: pivot.rotation.z, restY: pivot.rotation.y, sign, index };
      part(scene, rig, pivot, legModel, 0, -0.28, 0, skin);
      rig.joints[`leg${index}`] = pivot;
      index++;
    }
  }
  rig.joints["thorax"] = thorax;
  return rig;
}

/** Four legs at the corners of a body, each swinging from the hip. Shared by
 *  the wolf and the boar; the gait lives in `poseQuadruped`. */
function addLegs(
  scene: Scene, rig: Rig, parent: TransformNode,
  halfWidth: number, halfLength: number, hipY: number, length: number, thickness: number,
  model: VoxelModel, material: StandardMaterial,
): void {
  const corners: Array<[string, number, number]> = [
    ["legFL", -halfWidth, halfLength], ["legFR", halfWidth, halfLength],
    ["legBL", -halfWidth, -halfLength], ["legBR", halfWidth, -halfLength],
  ];
  for (const [name, x, z] of corners) {
    const leg = joint(scene, name, parent, x, hipY, z);
    part(scene, rig, leg, model, 0, -length / 2, 0, material);
    rig.joints[name] = leg;
  }
  void thickness;
}

/** A hoofed or padded leg: darker at the foot, so a stride reads. */
function legModel(thickness: number, length: number, colour: number, foot: number): VoxelModel {
  const t = Math.round(thickness / VOXEL);
  const h = Math.round(length / VOXEL);
  return build(t, h, t, (v) => {
    v.fill(0, 0, 0, t, h, t, colour);
    v.fill(0, 0, 0, t, Math.max(2, Math.round(h * 0.22)), t, foot);
    v.speckle(colour, 77, [tint(colour, 0.85), tint(colour, 1.15)], 0.2);
  });
}

/** Lean, long-snouted, tail up. Grey so it reads against both grass and pine. */
function buildWolfRig(scene: Scene, colour?: number): Rig {
  const archetype = getArchetype("wolf");
  // A variant's own colour on the kind's body.
  const fur = colour ?? archetype.colour;
  const rig = newRig(scene, "wolf");
  const dark = tint(fur, 0.62);
  const pale = tint(fur, 1.3);
  const { skin, glow } = creatureSkin(scene, rig, "wolf", 0x9a7a18);

  const torso = joint(scene, "torso", rig.body, 0, 0.58, 0);
  sculpted(scene, rig, torso, sculpt(
    [
      { at: [0, 0, 0], size: [0.4, 0.36, 0.95], colour: fur },
      { at: [0, 0.04, 0.3], size: [0.46, 0.42, 0.36], colour: fur },
      { at: [0, -0.2, 0.05], size: [0.3, 0.12, 0.7], colour: pale },
    ],
    (v, cell) => {
      // A darker saddle down the spine — a wolf seen from above is mostly back.
      const [sx, sy, sz] = cell(-0.1, 0.14, -0.4);
      v.fill(Math.round(sx), Math.round(sy), Math.round(sz), 7, 4, 24, dark);
      v.speckle(fur, 72, [tint(fur, 0.86), tint(fur, 1.14)], 0.3);
      v.speckle(dark, 73, [tint(dark, 0.86), tint(dark, 1.18)], 0.25);
      v.bevelAll();
    },
  ), skin);

  const head = joint(scene, "head", torso, 0, 0.16, 0.5);
  sculpted(scene, rig, head, sculpt(
    [
      { at: [0, 0, 0.08], size: [0.3, 0.28, 0.3], colour: fur },
      { at: [0, -0.05, 0.33], size: [0.17, 0.14, 0.26], colour: pale },
      { at: [-0.1, 0.19, 0.02], size: [0.07, 0.14, 0.06], colour: dark },
      { at: [0.1, 0.19, 0.02], size: [0.07, 0.14, 0.06], colour: dark },
    ],
    (v, cell) => {
      // A black nose on the end of the snout, and the mouth line under it.
      const [nx, ny, nz] = cell(-0.045, -0.055, 0.44);
      v.fill(Math.round(nx), Math.round(ny), Math.round(nz), 3, 3, 2, tint(dark, 0.4));
      const [mx, my, mz] = cell(-0.07, -0.1, 0.25);
      v.fill(Math.round(mx), Math.round(my), Math.round(mz), 5, 1, 6, tint(dark, 0.5));
      v.speckle(fur, 74, [tint(fur, 0.86), tint(fur, 1.14)], 0.3);
      v.bevelAll();
    },
  ), skin);
  part(scene, rig, head, build(7, 2, 2, (v) => v.fill(0, 0, 0, 7, 2, 2, 0xf0d060)), 0, 0.06, 0.24, glow);

  const tail = joint(scene, "tail", torso, 0, 0.1, -0.47);
  part(scene, rig, tail, build(4, 4, 15, (v) => {
    v.fill(0, 0, 0, 4, 4, 15, dark);
    v.fill(0, 0, 0, 4, 4, 4, tint(fur, 1.1));
    v.speckle(dark, 75, [tint(dark, 0.85), tint(dark, 1.2)], 0.3);
  }), 0, 0, -0.2, skin);
  tail.rotation.x = -0.5;

  addLegs(scene, rig, torso, 0.14, 0.33, -0.1, 0.5, 0.11, legModel(0.11, 0.5, dark, tint(dark, 0.6)), skin);
  Object.assign(rig.joints, { torso, head, tail });
  return rig;
}

/** Heavy, low-slung, all shoulder — with a crest of thorns down its back and
 *  tusks you can see from across a field. */
function buildBoarRig(scene: Scene, colour?: number): Rig {
  const archetype = getArchetype("boar");
  // A variant's own colour on the kind's body.
  const hide = colour ?? archetype.colour;
  const rig = newRig(scene, "boar");
  const dark = tint(hide, 0.55);
  const bone = 0xe8e0c8;
  const { skin, glow } = creatureSkin(scene, rig, "boar", 0x7a1a0a);

  const torso = joint(scene, "torso", rig.body, 0, 0.66, 0);
  sculpted(scene, rig, torso, sculpt(
    [
      { at: [0, 0, -0.05], size: [0.72, 0.62, 1.25], colour: hide },
      { at: [0, 0.06, 0.32], size: [0.8, 0.72, 0.5], colour: hide },
      // The thorns: a ridge down the spine, stepped rather than pyramids.
      ...[0, 1, 2, 3, 4].map((k) => ({
        at: [0, 0.42, 0.42 - k * 0.24] as const,
        size: [0.12, 0.24 - k * 0.02, 0.12] as const,
        colour: dark,
      })),
    ],
    (v, cell) => {
      // A shaggy mantle over the shoulders, where a boar carries its bulk.
      const [mx, my, mz] = cell(-0.4, 0.18, 0.1);
      v.fill(Math.round(mx), Math.round(my), Math.round(mz), 26, 8, 22, tint(hide, 0.78));
      v.speckle(hide, 76, [tint(hide, 0.84), tint(hide, 1.16)], 0.18);
      v.speckle(dark, 78, [tint(dark, 0.85), tint(dark, 1.2)], 0.3);
      v.bevelAll();
    },
  ), skin);

  const head = joint(scene, "head", torso, 0, -0.02, 0.58);
  sculpted(scene, rig, head, sculpt(
    [
      { at: [0, 0, 0.12], size: [0.5, 0.46, 0.42], colour: hide },
      { at: [0, -0.1, 0.4], size: [0.3, 0.24, 0.2], colour: dark },
      { at: [-0.17, -0.02, 0.48], size: [0.07, 0.22, 0.07], colour: bone },
      { at: [0.17, -0.02, 0.48], size: [0.07, 0.22, 0.07], colour: bone },
    ],
    (v, cell) => {
      // Two nostrils in the snout, and the ears laid back.
      const [nx, ny, nz] = cell(-0.08, -0.08, 0.49);
      for (const dx of [0, 4]) v.fill(Math.round(nx) + dx, Math.round(ny), Math.round(nz), 2, 2, 1, tint(dark, 0.4));
      const [ex, ey, ez] = cell(-0.26, 0.16, -0.02);
      for (const dx of [0, 14]) v.fill(Math.round(ex) + dx, Math.round(ey), Math.round(ez), 3, 6, 5, tint(hide, 0.7));
      v.speckle(hide, 79, [tint(hide, 0.84), tint(hide, 1.16)], 0.32);
      v.bevelAll();
    },
  ), skin);
  part(scene, rig, head, build(9, 2, 2, (v) => v.fill(0, 0, 0, 9, 2, 2, 0xd84a2a)), 0, 0.1, 0.34, glow);

  addLegs(scene, rig, torso, 0.24, 0.42, -0.22, 0.42, 0.16, legModel(0.16, 0.42, dark, tint(dark, 0.5)), skin);
  Object.assign(rig.joints, { torso, head });
  return rig;
}

/** Squat, wide-mouthed, long-armed: a thing that sits in the mud and waits. */
function buildWretchRig(scene: Scene, colour?: number): Rig {
  const archetype = getArchetype("wretch");
  // A variant's own colour on the kind's body.
  const hideColour = colour ?? archetype.colour;
  const rig = newRig(scene, "wretch");
  const dark = tint(hideColour, 0.55);
  const belly = 0xa8a870;
  const { skin, glow } = creatureSkin(scene, rig, "wretch", 0x6a9a1a);

  const torso = joint(scene, "torso", rig.body, 0, 0.45, 0);
  sculpted(scene, rig, torso, sculpt(
    [
      { at: [0, 0, 0], size: [0.95, 0.75, 1.05], colour: hideColour, round: true },
      { at: [0, -0.12, 0.38], size: [0.6, 0.3, 0.2], colour: belly },
    ],
    (v, cell) => {
      // Warts across its back: a lump of a body needs something on it.
      const [bx, by, bz] = cell(-0.34, 0.2, -0.4);
      for (let k = 0; k < 6; k++) {
        v.fill(Math.round(bx) + (k % 3) * 8, Math.round(by) + (k % 2) * 3, Math.round(bz) + k * 4, 3, 3, 3, dark);
      }
      v.speckle(hideColour, 81, [tint(hideColour, 0.82), tint(hideColour, 1.18)], 0.16);
      v.speckle(belly, 82, [tint(belly, 0.88), tint(belly, 1.1)], 0.3);
    },
  ), skin);

  const head = joint(scene, "head", torso, 0, 0.3, 0.3);
  sculpted(scene, rig, head, sculpt(
    [{ at: [0, 0.05, 0.15], size: [0.62, 0.3, 0.5], colour: hideColour }],
    (v, cell) => {
      // Two bulging eye ridges on top, the way a toad's sit above the water.
      const [ex, ey, ez] = cell(-0.22, 0.18, 0.16);
      for (const dx of [0, 10]) v.fill(Math.round(ex) + dx, Math.round(ey), Math.round(ez), 4, 3, 5, tint(hideColour, 1.2));
      v.speckle(hideColour, 83, [tint(hideColour, 0.82), tint(hideColour, 1.18)], 0.24);
      v.bevelAll();
    },
  ), skin);
  part(scene, rig, head, build(13, 2, 2, (v) => v.fill(0, 0, 0, 13, 2, 2, 0xc8ff6a)), 0, 0.12, 0.41, glow);

  const jaw = joint(scene, "jaw", head, 0, -0.1, 0.02);
  sculpted(scene, rig, jaw, sculpt(
    [{ at: [0, -0.04, 0.16], size: [0.58, 0.12, 0.46], colour: dark }],
    (v, cell) => {
      // A row of little teeth along the lip.
      const [tx, ty, tz] = cell(-0.26, 0.0, 0.36);
      for (let k = 0; k < 6; k++) v.fill(Math.round(tx) + k * 3, Math.round(ty), Math.round(tz), 2, 2, 2, 0xd8d2bc);
      v.speckle(dark, 84, [tint(dark, 0.84), tint(dark, 1.18)], 0.3);
    },
  ), skin);

  // The gullet, which glows when it is about to spit.
  const throat = part(scene, rig, head, build(10, 3, 3, (v) => v.fill(0, 0, 0, 10, 3, 3, 0xc8ff6a)), 0, -0.04, 0.38, glow);
  throat.scaling.setAll(0.01);

  const armModel = build(5, 20, 5, (v) => {
    v.fill(0, 0, 0, 5, 20, 5, dark);
    // Three long fingers, for something that grabs.
    for (const fx of [0, 2, 4]) v.fill(fx, 0, 1, 1, 3, 4, dark);
    v.speckle(dark, 85, [tint(dark, 0.84), tint(dark, 1.18)], 0.3);
  });
  for (const side of [-1, 1]) {
    const arm = joint(scene, side < 0 ? "armL" : "armR", torso, side * 0.46, 0.08, 0.2);
    const limb = part(scene, rig, arm, armModel, 0, -0.28, 0, skin);
    limb.rotation.z = side * 0.35;
    rig.joints[side < 0 ? "armL" : "armR"] = arm;
  }
  Object.assign(rig.joints, { torso, head, jaw, throat });
  return rig;
}

/** A knot of embers that will not settle: a bright core and shards orbiting
 *  it. Glows, so it reads in the ash and the dark. */
function buildWispRig(scene: Scene, colour?: number): Rig {
  const archetype = getArchetype("wisp");
  // A variant's own colour on the kind's body.
  const emberColour = colour ?? archetype.colour;
  const rig = newRig(scene, "wisp");
  // A wisp is all glow, so unlike the others both of its materials are
  // emissive — there is no unlit part of it to stand for a body.
  const core = voxelMaterial(scene, "wispCore");
  core.emissiveColor = hexColour(0xff9a3a);
  const shard = voxelMaterial(scene, "wispShard");
  shard.emissiveColor = hexColour(0xc0441a);
  track(rig, core, shard);

  const heart = joint(scene, "heart", rig.body, 0, archetype.hover ?? 0.9, 0);
  // A ragged knot rather than a ball: embers do not come out round.
  part(scene, rig, heart, build(15, 15, 15, (v) => {
    v.ellipsoid(7.5, 7.5, 7.5, 7, 7, 7, 0xffd27a);
    v.ellipsoid(7.5, 7.5, 7.5, 4.5, 4.5, 4.5, 0xfff0c0);
    v.speckle(0xffd27a, 91, [0xffb454, 0xffe6a0, 0xff8c30], 0.55);
  }), 0, 0, 0, core);

  const orbit = joint(scene, "orbit", heart, 0, 0, 0);
  const shardModel = build(5, 5, 5, (v) => {
    v.ellipsoid(2.5, 2.5, 2.5, 2.5, 2.5, 2.5, emberColour);
    v.speckle(emberColour, 92, [tint(emberColour, 1.3), tint(emberColour, 0.7)], 0.5);
  });
  for (let k = 0; k < 4; k++) {
    const angle = (k / 4) * Math.PI * 2;
    part(
      scene, rig, orbit, shardModel,
      Math.sin(angle) * 0.55, k % 2 === 0 ? 0.15 : -0.15, Math.cos(angle) * 0.55,
      shard,
    );
  }
  Object.assign(rig.joints, { heart, orbit });
  return rig;
}

/** Stacked stone the size of a doorway, with a rune for a face. */
function buildGolemRig(scene: Scene, colour?: number): Rig {
  const archetype = getArchetype("golem");
  // A variant's own colour on the kind's body.
  const stone = colour ?? archetype.colour;
  const rig = newRig(scene, "golem");
  const dark = tint(stone, 0.68);
  const moss = 0x5a7a44;
  const { skin, glow } = creatureSkin(scene, rig, "golem", 0x2a9a88);

  /**
   * Stone wants its speckle coarse and its corners knocked off — but sparse.
   * A golem is the biggest body in the game, and scattering shades over a
   * 45x38x29 chest breaks every greedy merge: at 0.45 this rig came out at
   * 28,000 triangles, nine times the player's. Grain has to thin out as a
   * surface grows.
   */
  const weathered = (v: Carve, base: number, seed: number, chance = 0.12): void => {
    v.speckle(base, seed, [tint(base, 0.8), tint(base, 1.15), tint(base, 0.92)], chance);
  };

  const hips = 1.05;
  const legL = joint(scene, "legL", rig.body, -0.36, hips, 0);
  const legR = joint(scene, "legR", rig.body, 0.36, hips, 0);
  const leg = sculpt([{ at: [0, -0.52, 0], size: [0.5, 1.05, 0.55], colour: dark }], (v) => {
    // Split into two blocks with a seam, because it is stacked stone.
    v.clear(0, 17, 0, 16, 1, 18);
    weathered(v, dark, 93, 0.18);
  });
  sculpted(scene, rig, legL, leg, skin);
  sculpted(scene, rig, legR, leg, skin);

  const chest = joint(scene, "chest", rig.body, 0, hips, 0);
  sculpted(scene, rig, chest, sculpt(
    [
      { at: [0, 0.62, 0], size: [1.4, 1.2, 0.9], colour: stone },
      { at: [0, 1.28, -0.05], size: [1.0, 0.2, 0.95], colour: moss },
    ],
    (v, cell) => {
      // Courses, so the torso reads as blocks piled up rather than one slab.
      for (const y of [0.35, 0.75]) {
        const [cx, cy, cz] = cell(-0.7, y, -0.45);
        v.fill(Math.round(cx), Math.round(cy), Math.round(cz), 45, 1, 29, tint(stone, 0.7));
      }
      weathered(v, stone, 94);
      v.speckle(moss, 95, [tint(moss, 0.75), tint(moss, 1.25)], 0.5);
      // The corners off the whole block: a boulder, not a crate.
      for (const x of [0, 44]) for (const z of [0, 28]) v.clear(x, 0, z, 1, 45, 1);
    },
  ), skin);
  part(scene, rig, chest, build(7, 12, 2, (v) => v.fill(0, 0, 0, 7, 12, 2, 0x8ff0e0)), 0, 0.7, 0.46, glow);

  const head = joint(scene, "head", chest, 0, 1.3, 0.2);
  sculpted(scene, rig, head, sculpt(
    [{ at: [0, 0.15, 0.05], size: [0.55, 0.45, 0.5], colour: dark }],
    (v) => {
      weathered(v, dark, 96, 0.2);
      for (const x of [0, 17]) for (const z of [0, 15]) v.clear(x, 0, z, 1, 15, 1);
    },
  ), skin);
  part(scene, rig, head, build(11, 3, 2, (v) => v.fill(0, 0, 0, 11, 3, 2, 0x8ff0e0)), 0, 0.2, 0.31, glow);

  for (const side of [-1, 1]) {
    const name = side < 0 ? "armL" : "armR";
    const arm = joint(scene, name, chest, side * 0.9, 1.05, 0);
    sculpted(scene, rig, arm, sculpt(
      [
        { at: [0, -0.45, 0], size: [0.42, 0.95, 0.45], colour: stone },
        { at: [0, -1.1, 0.05], size: [0.6, 0.55, 0.6], colour: dark },
      ],
      (v) => {
        weathered(v, stone, 97);
        weathered(v, dark, 98);
      },
    ), skin);
    rig.joints[name] = arm;
  }
  Object.assign(rig.joints, { legL, legR, chest, head });
  return rig;
}
/** A creature's body. `colour` overrides its kind's, for a variant. */
export function buildEnemyRig(scene: Scene, kind: EnemyKind, colour?: number): Rig {
  switch (kind) {
    case "spider": return buildSpiderRig(scene, colour);
    case "wolf": return buildWolfRig(scene, colour);
    case "boar": return buildBoarRig(scene, colour);
    case "wretch": return buildWretchRig(scene, colour);
    case "wisp": return buildWispRig(scene, colour);
    case "golem": return buildGolemRig(scene, colour);
    default: return buildZombieRig(scene, colour);
  }
}

// --- animation -----------------------------------------------------------------

/** What a body is doing beyond moving. One at a time; a new one replaces the old. */
export type Action =
  | { type: "cast"; spell: SpellId; combo: number; start: number }
  | { type: "windup"; start: number; ms: number }
  | { type: "blow"; start: number };

/** Strides per metre-per-second: how fast each kind's legs cycle for its size. */
const STRIDE: Partial<Record<RigKind, number>> = { spider: 3.4, wolf: 2.6, boar: 2.4, golem: 1.3, wretch: 1.8 };

const ease = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const easeOut = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : 1 - (1 - t) * (1 - t));

/** Blend between keyed values at times (ms). Clamped at the ends. */
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/** A dodge's pose: in at once, held through the dash (~0.27 s), and out. */
const DODGE_POSE: ReadonlyArray<readonly [number, number]> = [[0, 0], [50, 1], [240, 1], [360, 0]];
const DODGE_POSE_MS = 360;
const LANDING_MS = 200;
/** When, into a cast, the line leaves the rod — where the bobber starts to fly. */
export const CAST_RELEASE_MS = 360;
/** Reeling in, after the line comes out of the water. */
const REEL_MS = 380;

function keys(t: number, frames: ReadonlyArray<readonly [number, number]>): number {
  if (t <= frames[0]![0]) return frames[0]![1];
  for (let i = 1; i < frames.length; i++) {
    const [t1, v1] = frames[i]!;
    const [t0, v0] = frames[i - 1]!;
    if (t <= t1) return v0 + (v1 - v0) * ease((t - t0) / (t1 - t0));
  }
  return frames[frames.length - 1]![1];
}

/** How long each cast's body motion lasts, in ms. Also how long the body
 *  faces the aim rather than the camera. */
export function castDuration(spell: SpellId, combo: number): number {
  switch (spell) {
    case "sunder": return 520;
    case "throw": return 380;
    case "cleave": return 420;
    case "bash": return 300;
    case "battleCry": return 700;
    default: return combo === 3 ? 440 : 330;
  }
}

/** When the blow of a cast visibly connects, ms after it starts. */
export function castContact(spell: SpellId, combo: number): number {
  switch (spell) {
    case "sunder": return 190;
    case "throw": return 110;
    case "cleave": return 150;
    case "bash": return 90;
    case "battleCry": return 160;
    default: return combo === 3 ? 150 : 95;
  }
}

/**
 * Drives one rig from what the simulation says: where it is, how fast it is
 * going, and the discrete things that happen to it.
 */
export class Animator {
  private phase = 0;
  private lastX = NaN;
  private lastZ = NaN;
  private speed = 0;
  private action: Action | undefined;
  private flinchAt = -Infinity;
  private flinchPower = 0;
  private flashAt = -Infinity;
  private diedAt = -Infinity;
  private dead = false;
  private spawnAt = -Infinity;
  /** Hitstop: time freezes on this body for a moment when a blow lands. */
  private frozenUntil = -Infinity;
  private clock = 0;
  private lastNow = NaN;
  /** A player with their guard raised: arms up across the body, set each
   *  frame by whoever knows (the input for our own, the server for others). */
  guarding = false;
  /** Vertical speed, and exactly 0 standing (as in `applyInput`); set each
   *  frame by whoever knows, like `guarding`. */
  vy = 0;
  /** 0 on the ground to 1 in the air, eased, so leaving and meeting the
   *  ground blend rather than snap. */
  private air = 0;
  private landedAt = -Infinity;
  private dodgeAt = -Infinity;
  private dodgeX = 0;
  private dodgeZ = 0;
  /**
   * A player fishing: FISHING_NONE, FISHING_WAITING or FISHING_BITE, set each
   * frame from the replicated state. The rod comes out, the cast is thrown,
   * and a bite tugs at the arm; when it goes back to none the line is
   * reeled in before the rod is put away.
   */
  angling = 0;
  private lastAngling = 0;
  private castAt = -Infinity;
  private biteAt = -Infinity;
  private reelAt = -Infinity;

  constructor(readonly rig: Rig) {}

  /** When the current cast was thrown, on the frame clock; -Infinity if none. */
  get castStartedAt(): number {
    return this.angling > 0 ? this.castAt : -Infinity;
  }

  /** A dodge starting, along world (x, z). */
  dodge(now: number, x: number, z: number): void {
    const length = Math.hypot(x, z) || 1;
    this.dodgeAt = now;
    this.dodgeX = x / length;
    this.dodgeZ = z / length;
  }

  play(action: Action): void {
    this.action = action;
  }

  /** Cancel whatever it was winding up — it was staggered. */
  interrupt(): void {
    if (this.action?.type === "windup") this.action = undefined;
  }

  /** Is it mid-cast, and if so which way should it face? */
  casting(now: number): boolean {
    const action = this.action;
    return action?.type === "cast" && now - action.start < castDuration(action.spell, action.combo);
  }

  hit(now: number, power = 1): void {
    this.flinchAt = now;
    this.flinchPower = power;
    this.flashAt = now;
    this.frozenUntil = now + 55 * power;
  }

  die(now: number): void {
    if (this.dead) return;
    this.dead = true;
    this.diedAt = now;
    this.action = undefined;
    // The dead are not posed any further, so the rod is put away here.
    this.rig.joints["rod"]?.setEnabled(false);
    this.rig.joints["blade"]?.setEnabled(true);
  }

  /** Back up (a respawn) — rise out of the ground. */
  revive(now: number): void {
    this.dead = false;
    this.spawnAt = now;
    this.action = undefined;
  }

  /** Rise out of the ground on first appearance. */
  emerge(now: number): void {
    this.spawnAt = now;
  }

  get isDead(): boolean {
    return this.dead;
  }

  /**
   * Pose the rig for this frame.
   *
   * @param x,z The drawn position, to measure speed from.
   * @param sprinting Leans further forward.
   */
  update(now: number, x: number, z: number, sprinting = false): void {
    const realDt = Number.isNaN(this.lastNow) ? 0 : Math.min(0.1, (now - this.lastNow) / 1000);
    this.lastNow = now;
    // Hitstop freezes this body's own clock, not the world's.
    const dt = now < this.frozenUntil ? 0 : realDt;
    this.clock += dt * 1000;

    if (!Number.isNaN(this.lastX) && realDt > 0) {
      const moved = Math.hypot(x - this.lastX, z - this.lastZ) / realDt;
      // Smoothed, because interpolated positions arrive a little unevenly.
      this.speed += (Math.min(moved, 14) - this.speed) * Math.min(1, realDt * 10);
    }
    this.lastX = x;
    this.lastZ = z;
    this.phase += dt * this.speed * (STRIDE[this.rig.kind] ?? 2.1);

    const airborne = this.vy !== 0;
    if (!airborne && this.air > 0.5) this.landedAt = now;
    this.air += ((airborne ? 1 : 0) - this.air) * Math.min(1, realDt * 16);
    if (!airborne && this.air < 0.01) this.air = 0;

    this.flash(now);

    switch (this.rig.kind) {
      case "player": this.posePlayer(now, sprinting); break;
      case "zombie": this.poseZombie(now); break;
      case "spider": this.poseSpider(now); break;
      case "wolf": this.poseQuadruped(now, 0.8, 5.5); break;
      case "boar": this.poseQuadruped(now, 0.6, 4.5); break;
      case "wretch": this.poseWretch(now); break;
      case "wisp": this.poseWisp(now); break;
      case "golem": this.poseGolem(now); break;
    }
  }

  private flash(now: number): void {
    const t = (now - this.flashAt) / 130;
    const rig = this.rig;
    const strength = t >= 0 && t < 1 ? (1 - t) * 0.85 : 0;
    for (let i = 0; i < rig.materials.length; i++) {
      const base = rig.baseEmissive[i]!;
      const material = rig.materials[i]!;
      material.emissiveColor.set(
        base.r + (1 - base.r) * strength,
        base.g + (1 - base.g) * strength,
        base.b + (1 - base.b) * strength,
      );
    }
  }

  /** Common: a flinch backward, and the fall or rise. Returns false if the
   *  body is down and the rest of the pose should be skipped. */
  private poseCommon(now: number, fallDirection: 1 | -1, fallAxis: "x" | "z"): boolean {
    const body = this.rig.body;
    body.position.set(0, 0, 0);
    body.rotation.set(0, 0, 0);

    if (this.dead) {
      const t = (now - this.diedAt) / 480;
      const fall = easeOut(t) * (Math.PI / 2) * fallDirection;
      if (fallAxis === "x") body.rotation.x = fall;
      else body.rotation.z = fall;
      // A little bounce as it lands, then after a while it sinks away.
      body.position.y = t > 0.8 && t < 1.2 ? Math.sin((t - 0.8) * Math.PI * 2.5) * 0.06 : 0;
      const sink = (now - this.diedAt - 4500) / 2500;
      if (sink > 0) body.position.y -= Math.min(1, sink) * 1.4;
      return false;
    }

    const rise = (now - this.spawnAt) / 650;
    if (rise < 1) body.position.y = -(1 - easeOut(rise)) * 1.6;

    const f = (now - this.flinchAt) / 220;
    if (f >= 0 && f < 1) {
      const kick = Math.sin(f * Math.PI) * 0.28 * this.flinchPower;
      body.rotation.x -= kick;
      body.position.z -= kick * 0.3;
    }
    return true;
  }

  private posePlayer(now: number, sprinting: boolean): void {
    const j = this.rig.joints;
    const legL = j["legL"]!, legR = j["legR"]!, chest = j["chest"]!;
    const armL = j["armL"]!, armR = j["armR"]!, head = j["head"]!;

    for (const node of [legL, legR, chest, armL, armR, head]) node.rotation.set(0, 0, 0);
    if (!this.poseCommon(now, -1, "x")) return;

    const stride = Math.min(1, this.speed / 6);
    const swing = Math.sin(this.phase) * 0.75 * stride;
    legL.rotation.x = swing;
    legR.rotation.x = -swing;
    armL.rotation.x = -swing * 0.8;
    armR.rotation.x = swing * 0.5;
    this.rig.body.position.y += Math.abs(Math.cos(this.phase)) * 0.06 * stride;
    chest.rotation.x = stride * (sprinting ? 0.28 : 0.1) + Math.sin(this.clock / 500) * 0.02;
    const body = this.rig.body;

    // In the air: a knee up and arms out for balance. Rising, the leading leg
    // tucks; falling, the legs reach for the ground and the arms lift.
    const air = this.air;
    if (air > 0) {
      const fall = (1 - Math.max(-1, Math.min(1, this.vy / JUMP_SPEED))) / 2;
      legL.rotation.x = mix(legL.rotation.x, -1 + fall * 0.6, air);
      legR.rotation.x = mix(legR.rotation.x, 0.3 - fall * 0.4, air);
      armL.rotation.x = mix(armL.rotation.x, -0.45 - fall * 0.55, air);
      armR.rotation.x = mix(armR.rotation.x, -0.3 - fall * 0.55, air);
      armL.rotation.z = (0.3 + fall * 0.45) * air;
      armR.rotation.z = -(0.3 + fall * 0.45) * air;
      chest.rotation.x = mix(chest.rotation.x, 0.14 - fall * 0.2, air);
    }

    // Meeting the ground: a quick dip at the knees.
    const land = (now - this.landedAt) / LANDING_MS;
    if (land >= 0 && land < 1) {
      const dip = Math.sin(land * Math.PI);
      body.position.y -= dip * 0.07;
      legL.rotation.x -= dip * 0.35;
      legR.rotation.x += dip * 0.2;
      chest.rotation.x += dip * 0.18;
    }

    // A dodge: low, and leaning hard into the dash — forward, back or to the
    // side, whichever way it goes relative to where you face — legs split,
    // arms flung out behind the motion.
    const dodgeT = now - this.dodgeAt;
    if (dodgeT >= 0 && dodgeT < DODGE_POSE_MS) {
      const k = keys(dodgeT, DODGE_POSE);
      const yaw = this.rig.root.rotation.y;
      const ahead = this.dodgeX * Math.sin(yaw) + this.dodgeZ * Math.cos(yaw);
      const side = this.dodgeX * Math.cos(yaw) - this.dodgeZ * Math.sin(yaw);
      // Hard into a forward dash, only a little back from a backstep (the
      // torso stays over the feet, or it reads as falling over).
      body.rotation.x += (ahead > 0 ? ahead * 0.5 : ahead * 0.16) * k;
      body.rotation.z -= side * 0.4 * k;
      body.position.y -= 0.16 * k;
      legL.rotation.x = mix(legL.rotation.x, -0.9, k);
      legR.rotation.x = mix(legR.rotation.x, 0.8, k);
      armL.rotation.x = mix(armL.rotation.x, 0.85 * ahead, k);
      armR.rotation.x = mix(armR.rotation.x, 0.7 * ahead, k);
      armL.rotation.z = mix(armL.rotation.z, 0.6, k);
      armR.rotation.z = mix(armR.rotation.z, -0.6, k);
      chest.rotation.x = mix(chest.rotation.x, 0.12 + 0.2 * Math.max(0, ahead), k);
    }

    const action = this.action;
    if (this.poseAngling(now, swing)) return;
    if (this.guarding && action?.type !== "cast") {
      // Both forearms up across the chest, the blade held crosswise in front,
      // leaning into it: a shield wall of one. The legs keep walking.
      armL.rotation.x = -1.5;
      armL.rotation.z = 0.55;
      armR.rotation.x = -1.35;
      armR.rotation.z = -0.45;
      chest.rotation.x = 0.16;
      head.rotation.x = 0.12;
      return;
    }
    if (action?.type !== "cast") return;
    const t = now - action.start;
    if (t > castDuration(action.spell, action.combo)) {
      this.action = undefined;
      return;
    }

    if (action.spell === "strike" && action.combo !== 3) {
      // A flat slash across the body: wind the waist one way, whip it the
      // other. Alternate links swing opposite ways, so a chain reads as one.
      const dir = action.combo === 2 ? -1 : 1;
      chest.rotation.y = keys(t, [[0, 0], [60, 0.75 * dir], [130, -0.95 * dir], [330, 0]]);
      armR.rotation.x = keys(t, [[0, swing * 0.5], [60, -1.25], [130, -1.55], [330, 0]]);
      armR.rotation.z = keys(t, [[0, 0], [60, -0.5 * dir], [130, 0.35 * dir], [330, 0]]);
      armL.rotation.x = keys(t, [[0, 0], [90, -0.5], [330, 0]]);
      legL.rotation.x = keys(t, [[0, swing], [100, -0.35], [330, 0]]);
    } else if (action.spell === "strike") {
      // The finisher: both hands overhead, lean back, bring it down.
      armR.rotation.x = keys(t, [[0, 0], [110, -2.95], [165, -0.65], [440, 0]]);
      armL.rotation.x = keys(t, [[0, 0], [110, -2.7], [165, -0.8], [440, 0]]);
      chest.rotation.x = keys(t, [[0, 0], [110, -0.3], [165, 0.45], [440, 0]]);
      this.rig.body.position.y += keys(t, [[0, 0], [110, 0.12], [165, -0.1], [440, 0]]);
      legL.rotation.x = keys(t, [[0, 0], [165, -0.45], [440, 0]]);
      legR.rotation.x = keys(t, [[0, 0], [165, 0.35], [440, 0]]);
    } else if (action.spell === "throw") {
      // Wind the arm back over the shoulder and hurl: the weapon leaves from
      // the hand at the top of the arc.
      armR.rotation.x = keys(t, [[0, 0], [70, -2.7], [120, -1.4], [240, -0.9], [380, 0]]);
      armL.rotation.x = keys(t, [[0, 0], [70, -0.9], [380, 0]]);
      chest.rotation.y = keys(t, [[0, 0], [70, -0.45], [120, 0.4], [380, 0]]);
      chest.rotation.x = keys(t, [[0, 0], [70, -0.15], [130, 0.18], [380, 0]]);
      legL.rotation.x = keys(t, [[0, swing], [120, -0.4], [380, 0]]);
    } else if (action.spell === "cleave") {
      // One huge sweep across the whole front, turning the body with it.
      chest.rotation.y = keys(t, [[0, 0], [90, 1.15], [170, -1.25], [420, 0]]);
      armR.rotation.x = keys(t, [[0, swing * 0.5], [90, -1.4], [170, -1.45], [420, 0]]);
      armR.rotation.z = keys(t, [[0, 0], [90, -0.8], [170, 0.6], [420, 0]]);
      armL.rotation.x = keys(t, [[0, 0], [90, -0.7], [170, -0.4], [420, 0]]);
      legL.rotation.x = keys(t, [[0, swing], [150, -0.45], [420, 0]]);
      legR.rotation.x = keys(t, [[0, -swing], [150, 0.25], [420, 0]]);
    } else if (action.spell === "bash") {
      // A short shove with the off hand, shoulder behind it.
      armL.rotation.x = keys(t, [[0, 0], [50, -0.4], [95, -1.55], [300, 0]]);
      chest.rotation.y = keys(t, [[0, 0], [50, 0.3], [95, -0.35], [300, 0]]);
      chest.rotation.x = keys(t, [[0, 0], [95, 0.25], [300, 0]]);
      legL.rotation.x = keys(t, [[0, swing], [95, -0.5], [300, 0]]);
    } else if (action.spell === "battleCry") {
      // Chest out, head back, arms flung wide.
      armR.rotation.z = keys(t, [[0, 0], [160, -1.3], [520, -1.1], [700, 0]]);
      armL.rotation.z = keys(t, [[0, 0], [160, 1.3], [520, 1.1], [700, 0]]);
      armR.rotation.x = keys(t, [[0, 0], [160, -0.9], [700, 0]]);
      armL.rotation.x = keys(t, [[0, 0], [160, -0.9], [700, 0]]);
      chest.rotation.x = keys(t, [[0, 0], [160, -0.35], [520, -0.3], [700, 0]]);
      head.rotation.x = keys(t, [[0, 0], [160, -0.4], [520, -0.35], [700, 0]]);
    } else {
      // Sunder: hop, arms up, and slam both fists into the ground.
      armR.rotation.x = keys(t, [[0, 0], [140, -2.9], [200, -0.5], [520, 0]]);
      armL.rotation.x = keys(t, [[0, 0], [140, -2.9], [200, -0.5], [520, 0]]);
      chest.rotation.x = keys(t, [[0, 0], [140, -0.22], [200, 0.55], [520, 0]]);
      this.rig.body.position.y += keys(t, [[0, 0], [140, 0.28], [200, -0.16], [520, 0]]);
      legL.rotation.x = keys(t, [[0, 0], [200, -0.5], [520, 0]]);
      legR.rotation.x = keys(t, [[0, 0], [200, -0.5], [520, 0]]);
    }
  }

  /**
   * Fishing, if it is: the rod out, the cast, the wait, a bite, the reel. Owns
   * which of the rod and the blade is in the hand. Returns whether it posed
   * the arms, so nothing else does this frame.
   */
  private poseAngling(now: number, swing: number): boolean {
    const j = this.rig.joints;
    const rod = j["rod"], blade = j["blade"];
    if (!rod || !blade) return false;
    const armL = j["armL"]!, armR = j["armR"]!, chest = j["chest"]!, head = j["head"]!;

    if (this.angling !== this.lastAngling) {
      if (this.lastAngling === 0) this.castAt = now;
      if (this.angling === 2) this.biteAt = now;
      if (this.angling === 0) this.reelAt = now;
      this.lastAngling = this.angling;
    }

    const reel = now - this.reelAt;
    const reeling = this.angling === 0 && reel < REEL_MS && !this.dead;
    const out = (this.angling > 0 && !this.dead) || reeling;
    if (rod.isEnabled() !== out) {
      rod.setEnabled(out);
      blade.setEnabled(!out);
    }
    if (!out) return false;

    if (reeling) {
      // A sharp lift of the rod as the line comes in, then down to the side.
      armR.rotation.x = keys(reel, [[0, -0.75], [120, -1.7], [REEL_MS, swing * 0.5]]);
      armL.rotation.x = keys(reel, [[0, -0.5], [120, -0.9], [REEL_MS, 0]]);
      chest.rotation.x = keys(reel, [[0, 0.04], [120, -0.12], [REEL_MS, 0]]);
      return true;
    }

    // The throw: back over the shoulder and forward, the line leaving at
    // CAST_RELEASE_MS; then held out over the water, the off hand on the reel.
    const t = now - this.castAt;
    armR.rotation.x = keys(t, [[0, swing * 0.5], [180, -2.5], [CAST_RELEASE_MS, -0.45], [620, -0.75]]);
    armR.rotation.z = keys(t, [[0, 0], [180, -0.2], [620, -0.1]]);
    armL.rotation.x = keys(t, [[0, 0], [CAST_RELEASE_MS, -0.35], [620, -0.62]]);
    armL.rotation.z = keys(t, [[0, 0], [620, -0.35]]);
    chest.rotation.x = keys(t, [[0, 0], [180, -0.14], [CAST_RELEASE_MS, 0.12], [620, 0.05]]);
    // Breathing, while you wait: the tip nods.
    armR.rotation.x += Math.sin(this.clock / 700) * 0.025;
    head.rotation.x = 0.12;

    if (this.angling === 2) {
      // Something on the line: the arm is pulled at in jerks, and you lean into it.
      const b = now - this.biteAt;
      armR.rotation.x += 0.18 * Math.max(0, Math.sin(b / 55)) * Math.min(1, b / 90);
      chest.rotation.x += 0.08;
      head.rotation.x = 0.26;
    }
    return true;
  }

  private poseZombie(now: number): void {
    const j = this.rig.joints;
    const legL = j["legL"]!, legR = j["legR"]!, chest = j["chest"]!;
    const armL = j["armL"]!, armR = j["armR"]!, head = j["head"]!;

    for (const node of [legL, legR, chest, armL, armR, head]) node.rotation.set(0, 0, 0);
    if (!this.poseCommon(now, 1, "x")) return;

    // A shuffle: short stride, heavy sway, arms held out in front.
    const stride = Math.min(1, this.speed / 3);
    const swing = Math.sin(this.phase) * 0.5 * stride;
    legL.rotation.x = swing;
    legR.rotation.x = -swing;
    this.rig.body.rotation.z = Math.sin(this.phase) * 0.09 * stride;
    const idle = Math.sin(this.clock / 700);
    chest.rotation.x = 0.24 + idle * 0.03;
    head.rotation.z = Math.sin(this.clock / 1100) * 0.12;
    armL.rotation.x = -1.35 + Math.sin(this.phase + 0.6) * 0.15 * stride + idle * 0.05;
    armR.rotation.x = -1.35 - Math.sin(this.phase + 0.6) * 0.15 * stride + idle * 0.05;

    const action = this.action;
    if (!action) return;
    const t = now - action.start;

    if (action.type === "windup") {
      // Arms climb overhead for the whole windup and it rears back: the
      // longer you have been watching it, the closer the blow.
      const p = easeOut(t / action.ms);
      armL.rotation.x = -1.35 + (-1.6) * p;
      armR.rotation.x = -1.35 + (-1.6) * p;
      chest.rotation.x = 0.24 - 0.42 * p;
      // A tremble in the last third says "now".
      if (p > 0.66) this.rig.body.position.x = Math.sin(now / 18) * 0.025;
      if (t >= action.ms) this.action = { type: "blow", start: action.start + action.ms };
    } else if (action.type === "blow") {
      armL.rotation.x = keys(t, [[0, -2.95], [90, -0.55], [420, -1.35]]);
      armR.rotation.x = keys(t, [[0, -2.95], [90, -0.55], [420, -1.35]]);
      chest.rotation.x = keys(t, [[0, -0.18], [90, 0.75], [420, 0.24]]);
      if (t > 420) this.action = undefined;
    }
  }

  private poseSpider(now: number): void {
    const j = this.rig.joints;
    const thorax = j["thorax"]!;
    thorax.rotation.set(0, 0, 0);
    thorax.position.set(0, 0.42, 0);

    const alive = this.poseCommon(now, 1, "z");
    if (!alive) {
      // Legs curl in as it dies.
      const curl = easeOut((now - this.diedAt) / 400);
      for (let i = 0; i < 8; i++) {
        const leg = j[`leg${i}`]!;
        const rest = leg.metadata as { restZ: number; restY: number; sign: number };
        leg.rotation.z = rest.restZ * (1 - curl) - rest.sign * 0.9 * curl;
      }
      return;
    }

    // Alternating tetrapod gait: legs 0,2 on one side move with 1,3 on the
    // other. Skitter even when still, so it never looks like a model.
    const stride = Math.min(1, this.speed / 5);
    const jitter = 0.05 + 0.25 * stride;
    for (let i = 0; i < 8; i++) {
      const leg = j[`leg${i}`]!;
      const rest = leg.metadata as { restZ: number; restY: number; sign: number; index: number };
      const offset = ((i % 4) + (i >= 4 ? 1 : 0)) % 2 === 0 ? 0 : Math.PI;
      const beat = this.phase + offset + (stride < 0.1 ? this.clock / 260 : 0);
      leg.rotation.z = rest.restZ + rest.sign * Math.max(0, Math.sin(beat)) * 0.35 * jitter * 2;
      leg.rotation.y = rest.restY + Math.cos(beat) * 0.32 * jitter;
    }
    thorax.position.y = 0.42 + Math.abs(Math.sin(this.phase * 2)) * 0.03 * stride;

    const action = this.action;
    if (!action) return;
    const t = now - action.start;
    if (action.type === "windup") {
      // Rear up on the back legs, front legs raised.
      const p = easeOut(t / action.ms);
      thorax.rotation.x = -0.5 * p;
      thorax.position.z = -0.18 * p;
      for (const i of [0, 4]) {
        const leg = j[`leg${i}`]!;
        const rest = leg.metadata as { restZ: number; sign: number };
        leg.rotation.z = rest.restZ + rest.sign * 0.9 * p;
      }
      if (t >= action.ms) this.action = { type: "blow", start: action.start + action.ms };
    } else if (action.type === "blow") {
      // Lunge.
      thorax.rotation.x = keys(t, [[0, -0.5], [70, 0.3], [260, 0]]);
      thorax.position.z = keys(t, [[0, -0.18], [70, 0.4], [260, 0]]);
      if (t > 260) this.action = undefined;
    }
  }

  /**
   * Wolves and boars. A trot on diagonal pairs; the windup and blow differ by
   * kind — a wolf crouches and lunges, a boar lowers its head and paws the
   * ground, then its charge is simply it running very fast, which the gait
   * already draws.
   */
  private poseQuadruped(now: number, swingAmount: number, fullSpeed: number): void {
    const j = this.rig.joints;
    const torso = j["torso"]!, head = j["head"]!;
    const legs = [j["legFL"]!, j["legFR"]!, j["legBL"]!, j["legBR"]!];
    const baseY = this.rig.kind === "boar" ? 0.66 : 0.58;
    torso.rotation.set(0, 0, 0);
    torso.position.set(0, baseY, 0);
    head.rotation.set(0, 0, 0);
    for (const leg of legs) leg.rotation.set(0, 0, 0);
    if (!this.poseCommon(now, 1, "z")) return;

    const stride = Math.min(1, this.speed / fullSpeed);
    const swing = Math.sin(this.phase) * swingAmount * stride;
    legs[0]!.rotation.x = swing;
    legs[3]!.rotation.x = swing;
    legs[1]!.rotation.x = -swing;
    legs[2]!.rotation.x = -swing;
    torso.position.y = baseY + Math.abs(Math.cos(this.phase)) * 0.05 * stride;
    head.rotation.x = Math.sin(this.clock / 900) * 0.06 + stride * 0.1;
    const tail = j["tail"];
    if (tail) tail.rotation.y = Math.sin(this.clock / 160) * 0.35 * (0.3 + stride);

    const action = this.action;
    if (!action) return;
    const t = now - action.start;
    if (action.type === "windup") {
      const p = easeOut(t / action.ms);
      if (this.rig.kind === "boar") {
        head.rotation.x = 0.45 * p;
        torso.rotation.x = 0.12 * p;
        // Paw the ground with a front foot, faster as it nears the charge.
        legs[0]!.rotation.x = Math.max(0, Math.sin(now / (70 - 30 * p))) * -0.7;
        this.rig.body.position.x = Math.sin(now / 25) * 0.02 * p;
      } else {
        torso.position.y = baseY - 0.14 * p;
        torso.rotation.x = 0.18 * p;
        head.rotation.x = 0.3 * p;
      }
      if (t >= action.ms) this.action = { type: "blow", start: action.start + action.ms };
    } else if (action.type === "blow") {
      if (this.rig.kind === "boar") {
        head.rotation.x = keys(t, [[0, 0.5], [500, 0.35], [800, 0]]);
        if (t > 800) this.action = undefined;
      } else {
        torso.position.z = keys(t, [[0, -0.1], [80, 0.45], [300, 0]]);
        head.rotation.x = keys(t, [[0, 0.3], [80, -0.35], [300, 0]]);
        if (t > 300) this.action = undefined;
      }
    }
  }

  /** The Fen Wretch: squats, breathes, and rears back to spit. */
  private poseWretch(now: number): void {
    const j = this.rig.joints;
    const torso = j["torso"]!, head = j["head"]!, jaw = j["jaw"]!, throat = j["throat"]!;
    const armL = j["armL"]!, armR = j["armR"]!;
    torso.rotation.set(0, 0, 0);
    torso.scaling.set(1, 1, 1);
    head.rotation.set(0, 0, 0);
    jaw.rotation.set(0, 0, 0);
    throat.scaling.setAll(0.01);
    if (!this.poseCommon(now, 1, "x")) return;

    const stride = Math.min(1, this.speed / 3);
    const breathe = Math.sin(this.clock / 600);
    torso.scaling.set(1 + breathe * 0.03, 1 - breathe * 0.04, 1);
    head.rotation.y = Math.sin(this.clock / 1300) * 0.25;
    // It moves in hops.
    this.rig.body.position.y += Math.abs(Math.sin(this.phase * 1.5)) * 0.14 * stride;
    armL.rotation.x = Math.sin(this.phase * 1.5) * 0.6 * stride;
    armR.rotation.x = Math.sin(this.phase * 1.5) * 0.6 * stride;

    const action = this.action;
    if (!action) return;
    const t = now - action.start;
    if (action.type === "windup") {
      const p = easeOut(t / action.ms);
      torso.rotation.x = -0.4 * p;
      jaw.rotation.x = 0.7 * p;
      throat.scaling.setAll(0.2 + p * 1.4);
      torso.scaling.set(1 + p * 0.12, 1 + p * 0.1, 1 + p * 0.12);
      if (t >= action.ms) this.action = { type: "blow", start: action.start + action.ms };
    } else if (action.type === "blow") {
      torso.rotation.x = keys(t, [[0, -0.4], [70, 0.35], [320, 0]]);
      jaw.rotation.x = keys(t, [[0, 0.7], [90, 0.9], [320, 0]]);
      head.rotation.x = keys(t, [[0, 0], [70, 0.3], [320, 0]]);
      if (t > 320) this.action = undefined;
    }
  }

  /** The Cinder Wisp: always moving, swells before it bursts, and gutters out
   *  rather than falling over. */
  private poseWisp(now: number): void {
    const j = this.rig.joints;
    const heart = j["heart"]!, orbit = j["orbit"]!;
    const hover = getArchetype("wisp").hover ?? 0.9;
    this.rig.body.position.set(0, 0, 0);
    this.rig.body.rotation.set(0, 0, 0);
    heart.position.set(0, hover + Math.sin(this.clock / 420) * 0.12, 0);
    heart.scaling.setAll(1);
    orbit.rotation.y = this.clock / 300;

    if (this.dead) {
      const t = (now - this.diedAt) / 700;
      // Drops, dims and shrinks to nothing.
      heart.position.y = hover * (1 - easeOut(t));
      heart.scaling.setAll(Math.max(0.01, 1 - t));
      return;
    }
    const rise = (now - this.spawnAt) / 650;
    if (rise < 1) heart.scaling.setAll(Math.max(0.01, easeOut(rise)));

    const f = (now - this.flinchAt) / 220;
    if (f >= 0 && f < 1) heart.position.z -= Math.sin(f * Math.PI) * 0.3 * this.flinchPower;

    const action = this.action;
    if (!action) return;
    const t = now - action.start;
    if (action.type === "windup") {
      const p = t / action.ms;
      // Swelling and spinning up — the whole windup says "get away".
      heart.scaling.setAll(1 + easeOut(p) * 0.8 + Math.sin(now / 30) * 0.05 * p);
      orbit.rotation.y = this.clock / (300 - 220 * p);
      orbit.scaling.setAll(1 + p * 0.9);
      if (t >= action.ms) this.action = { type: "blow", start: action.start + action.ms };
    } else if (action.type === "blow") {
      heart.scaling.setAll(keys(t, [[0, 1.8], [60, 2.3], [260, 1]]));
      orbit.scaling.setAll(keys(t, [[0, 1.9], [80, 3], [300, 1]]));
      if (t > 300) this.action = undefined;
    } else {
      orbit.scaling.setAll(1);
    }
  }

  /** The Cairn Golem: slow, heavy, and its slam comes from very high up. */
  private poseGolem(now: number): void {
    const j = this.rig.joints;
    const legL = j["legL"]!, legR = j["legR"]!, chest = j["chest"]!;
    const armL = j["armL"]!, armR = j["armR"]!, head = j["head"]!;
    for (const node of [legL, legR, chest, armL, armR, head]) node.rotation.set(0, 0, 0);
    if (!this.poseCommon(now, 1, "x")) return;

    const stride = Math.min(1, this.speed / 2.2);
    const swing = Math.sin(this.phase) * 0.4 * stride;
    legL.rotation.x = swing;
    legR.rotation.x = -swing;
    armL.rotation.x = -swing * 0.6;
    armR.rotation.x = swing * 0.6;
    this.rig.body.rotation.z = Math.sin(this.phase) * 0.06 * stride;
    chest.rotation.x = 0.08 + Math.sin(this.clock / 1400) * 0.02;
    head.rotation.y = Math.sin(this.clock / 2600) * 0.3;

    const action = this.action;
    if (!action) return;
    const t = now - action.start;
    if (action.type === "windup") {
      const p = easeOut(t / action.ms);
      armL.rotation.x = -3.0 * p;
      armR.rotation.x = -3.0 * p;
      chest.rotation.x = 0.08 - 0.35 * p;
      if (p > 0.7) this.rig.body.position.x = Math.sin(now / 22) * 0.03;
      if (t >= action.ms) this.action = { type: "blow", start: action.start + action.ms };
    } else if (action.type === "blow") {
      armL.rotation.x = keys(t, [[0, -3.0], [110, -0.3], [600, 0]]);
      armR.rotation.x = keys(t, [[0, -3.0], [110, -0.3], [600, 0]]);
      chest.rotation.x = keys(t, [[0, -0.27], [110, 0.55], [600, 0.08]]);
      this.rig.body.position.y += keys(t, [[0, 0], [110, -0.2], [600, 0]]);
      if (t > 600) this.action = undefined;
    }
  }
}
