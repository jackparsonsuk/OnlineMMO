import { Color3 } from "@babylonjs/core/Maths/math.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import type { Scene } from "@babylonjs/core/scene.js";
import {
  getArchetype,
  type EnemyKind,
  PLAYER_SIZE,
  type Rarity,
  type Spell,
} from "@mmo/shared";

/**
 * The game's art style, in one place.
 *
 * Low poly means two things here, and they have to go together: very few
 * triangles, and *flat* shading so every one of those triangles reads as a
 * distinct facet. A coarse mesh with smooth normals just looks like a badly
 * made smooth object; the same mesh faceted looks deliberate.
 *
 * Everything is built from primitives at runtime. No model files to load, no
 * exporter in the pipeline, and a creature's proportions live next to the
 * numbers the simulation uses — so a spider cannot be drawn wider than the
 * circle it collides with.
 */

/**
 * Flat, unshiny material. Specular highlights are the fastest way to make a
 * low-poly scene look like untextured plastic, so there are none.
 */
export function flatMaterial(scene: Scene, name: string, colour: Color3 | number): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = typeof colour === "number" ? hexColour(colour) : colour;
  material.specularColor = Color3.Black();
  return material;
}

export function hexColour(rgb: number): Color3 {
  return Color3.FromHexString(`#${rgb.toString(16).padStart(6, "0")}`);
}

/**
 * Facet a mesh, and tolerate a Babylon build where the helper isn't reachable.
 *
 * `convertToFlatShadedMesh` duplicates vertices so each face gets its own
 * normal. It is the entire low-poly look. Primitives built from boxes are
 * already faceted, so if this is ever unavailable only the rounded shapes lose
 * their edges — worth degrading rather than throwing.
 */
export function facet<T extends Mesh>(mesh: T): T {
  if (typeof mesh.convertToFlatShadedMesh === "function") mesh.convertToFlatShadedMesh();
  return mesh;
}

/**
 * A player. A blocky humanoid rather than a cube: at a glance you can tell
 * which way it faces and roughly how big it is, and it sets the scale
 * everything else is drawn against.
 */
export function buildPlayer(scene: Scene, colour: number): TransformNode {
  const root = new TransformNode("player", scene);
  const body = flatMaterial(scene, "playerBody", colour);
  // Limbs a shade darker so the silhouette still reads when a player is lit
  // from directly above.
  const limb = flatMaterial(scene, "playerLimb", hexColour(colour).scale(0.62));
  const face = flatMaterial(scene, "playerFace", hexColour(colour).scale(1.45));

  const part = (
    name: string,
    size: { width: number; height: number; depth: number },
    x: number,
    y: number,
    z: number,
    material: StandardMaterial,
  ): void => {
    const mesh = MeshBuilder.CreateBox(name, size, scene);
    mesh.position.set(x, y, z);
    mesh.material = material;
    mesh.parent = root;
  };

  // Proportions are in units of PLAYER_SIZE so the whole figure scales with the
  // one constant the simulation knows about.
  const u = PLAYER_SIZE;
  part("torso", { width: 0.52 * u, height: 0.52 * u, depth: 0.32 * u }, 0, 0.62 * u, 0, body);
  part("head", { width: 0.34 * u, height: 0.34 * u, depth: 0.34 * u }, 0, 1.05 * u, 0, body);
  // A pale block on the front of the head: the facing cue, and cheaper to read
  // than eyes at this size.
  part("visor", { width: 0.22 * u, height: 0.1 * u, depth: 0.06 * u }, 0, 1.07 * u, 0.17 * u, face);
  part("armL", { width: 0.14 * u, height: 0.46 * u, depth: 0.16 * u }, -0.33 * u, 0.6 * u, 0, limb);
  part("armR", { width: 0.14 * u, height: 0.46 * u, depth: 0.16 * u }, 0.33 * u, 0.6 * u, 0, limb);
  part("legL", { width: 0.18 * u, height: 0.38 * u, depth: 0.18 * u }, -0.14 * u, 0.19 * u, 0, limb);
  part("legR", { width: 0.18 * u, height: 0.38 * u, depth: 0.18 * u }, 0.14 * u, 0.19 * u, 0, limb);

  return root;
}

/**
 * A creature. Both kinds are assembled from the same primitives and coloured
 * from their archetype, so the table in `@mmo/shared` stays the single source
 * of truth for how big and what colour a thing is.
 */
export function buildEnemy(scene: Scene, kind: EnemyKind): TransformNode {
  return kind === "spider" ? buildSpider(scene) : buildZombie(scene);
}

/** Hunched, long-armed, and a head that sits forward of its shoulders. */
function buildZombie(scene: Scene): TransformNode {
  const archetype = getArchetype("zombie");
  const root = new TransformNode("zombie", scene);
  const flesh = flatMaterial(scene, "zombieFlesh", archetype.colour);
  const dark = flatMaterial(scene, "zombieDark", hexColour(archetype.colour).scale(0.6));
  // The one bright note on the model, so a Risen is identifiable at distance.
  const eyes = flatMaterial(scene, "zombieEyes", 0xd8e85a);
  eyes.emissiveColor = hexColour(0x7a8a20);

  const part = (
    name: string,
    size: { width: number; height: number; depth: number },
    x: number,
    y: number,
    z: number,
    material: StandardMaterial,
    tilt = 0,
  ): void => {
    const mesh = MeshBuilder.CreateBox(name, size, scene);
    mesh.position.set(x, y, z);
    mesh.rotation.x = tilt;
    mesh.material = material;
    mesh.parent = root;
  };

  part("torso", { width: 0.58, height: 0.72, depth: 0.36 }, 0, 1.02, 0, flesh, 0.22);
  part("head", { width: 0.36, height: 0.36, depth: 0.36 }, 0, 1.52, 0.16, flesh);
  part("eyes", { width: 0.26, height: 0.07, depth: 0.05 }, 0, 1.56, 0.34, eyes);
  // Arms hang forward — the shape that says "coming for you" without animation.
  part("armL", { width: 0.16, height: 0.62, depth: 0.18 }, -0.38, 1.02, 0.22, dark, 1.15);
  part("armR", { width: 0.16, height: 0.62, depth: 0.18 }, 0.38, 1.02, 0.22, dark, 1.15);
  part("legL", { width: 0.2, height: 0.66, depth: 0.2 }, -0.16, 0.33, 0, dark);
  part("legR", { width: 0.2, height: 0.66, depth: 0.2 }, 0.16, 0.33, 0, dark);

  return root;
}

/** Low, wide, and eight-legged. Reads instantly from directly above, which is
 *  the angle the third-person camera mostly gives you. */
function buildSpider(scene: Scene): TransformNode {
  const archetype = getArchetype("spider");
  const root = new TransformNode("spider", scene);
  const shell = flatMaterial(scene, "spiderShell", archetype.colour);
  const dark = flatMaterial(scene, "spiderLeg", hexColour(archetype.colour).scale(0.55));
  const eyes = flatMaterial(scene, "spiderEyes", 0xd8506a);
  eyes.emissiveColor = hexColour(0x8a2038);

  // Two lumps: a big abdomen behind, a smaller head in front. `segments: 2`
  // keeps the triangle count in single figures per hemisphere.
  const abdomen = facet(MeshBuilder.CreateSphere("abdomen", { diameter: 0.78, segments: 2 }, scene));
  abdomen.position.set(0, 0.44, -0.26);
  abdomen.scaling.set(1, 0.82, 1.15);
  abdomen.material = shell;
  abdomen.parent = root;

  const head = facet(MeshBuilder.CreateSphere("cephalothorax", { diameter: 0.5, segments: 2 }, scene));
  head.position.set(0, 0.4, 0.24);
  head.scaling.set(1, 0.8, 1);
  head.material = shell;
  head.parent = root;

  const eyeBlock = MeshBuilder.CreateBox("eyes", { width: 0.22, height: 0.06, depth: 0.05 }, scene);
  eyeBlock.position.set(0, 0.45, 0.45);
  eyeBlock.material = eyes;
  eyeBlock.parent = root;

  // Four a side, splayed and angled down. Built as one thin box per leg with a
  // pivot at the body, so the whole limb swings from the shoulder.
  const spread = [0.85, 0.35, -0.2, -0.7];
  for (let side = 0; side < 2; side++) {
    const sign = side === 0 ? -1 : 1;
    for (const along of spread) {
      const pivot = new TransformNode("legPivot", scene);
      pivot.position.set(sign * 0.2, 0.42, along * 0.5);
      pivot.rotation.z = sign * 0.75;
      // Fan the legs fore and aft so they don't all point the same way.
      pivot.rotation.y = -sign * along * 0.6;
      pivot.parent = root;

      const leg = MeshBuilder.CreateBox("leg", { width: 0.09, height: 0.62, depth: 0.09 }, scene);
      // Offset by half its length so it hangs from the pivot rather than
      // straddling it.
      leg.position.y = -0.28;
      leg.material = dark;
      leg.parent = pivot;
    }
  }

  return root;
}

/** Scenery. A hewn pillar or a boulder, both faceted, both matching the circle
 *  the simulation actually collides against. */
export function buildObstacle(
  scene: Scene,
  style: "pillar" | "boulder",
  radius: number,
  height: number,
  material: StandardMaterial,
): Mesh {
  if (style === "boulder") {
    const boulder = facet(
      MeshBuilder.CreateSphere("obstacle", { diameter: radius * 2, segments: 2 }, scene),
    );
    // Squashed and tipped, so a field of them doesn't look like a row of clones.
    boulder.scaling.y = Math.max(0.35, height / (radius * 2));
    boulder.rotation.y = Math.random() * Math.PI * 2;
    boulder.position.y = height * 0.34;
    boulder.material = material;
    return boulder;
  }

  const pillar = facet(
    MeshBuilder.CreateCylinder(
      "obstacle",
      // Six sides reads as hewn stone; more starts to look like a smooth column.
      { diameterTop: radius * 1.72, diameterBottom: radius * 2, height, tessellation: 6 },
      scene,
    ),
  );
  pillar.rotation.y = Math.random() * Math.PI * 2;
  pillar.position.y = height / 2;
  pillar.material = material;
  return pillar;
}

/**
 * A cast's effect: a flat sector on the ground showing exactly the shape the
 * server tests against. Drawing the real wedge rather than a generic flourish
 * means a miss is legible — you can see the creature was outside it.
 *
 * Returned as a pivot with the sector already oriented inside it, so the caller
 * only has to set `rotation.y` to the caster's yaw. Getting there needs one
 * fixed correction, worked out once here rather than fudged by eye:
 *
 *   CreateDisc lays a sector in the XY plane from local +X, sweeping toward +Y.
 *   Rotating +90 degrees about X maps local (x, y, 0) to world (x, 0, y), so a
 *   local angle phi (from +X toward +Y) lands at world yaw atan2(cos phi, sin phi)
 *   = PI/2 - phi. We want the sector's CENTRE at yaw 0, so phi_centre = PI/2.
 *   The sector spans [z, z + arc], centred at z + arc/2, giving z = PI/2 - arc/2.
 *   Babylon composes rotation as Y * X * Z, so that Z spin happens first, inside
 *   the sector's own plane — which is exactly where it needs to apply.
 */
export function buildCastArc(scene: Scene, spell: Spell, colour: number): TransformNode {
  const pivot = new TransformNode(`castPivot:${spell.id}`, scene);

  // A full ring would be a disc with a seam; drawing it as a complete circle
  // avoids the arc parameter entirely.
  const full = spell.arc >= Math.PI * 2;
  const sector = MeshBuilder.CreateDisc(
    `cast:${spell.id}`,
    {
      radius: spell.range,
      tessellation: full ? 24 : 10,
      ...(full ? {} : { arc: spell.arc / (Math.PI * 2) }),
    },
    scene,
  );
  sector.rotation.x = Math.PI / 2;
  if (!full) sector.rotation.z = Math.PI / 2 - spell.arc / 2;
  sector.isPickable = false;
  sector.parent = pivot;

  const material = new StandardMaterial(`castMaterial:${spell.id}`, scene);
  material.diffuseColor = Color3.Black();
  material.specularColor = Color3.Black();
  material.emissiveColor = hexColour(colour);
  material.alpha = 0.34;
  material.backFaceCulling = false;
  sector.material = material;

  pivot.setEnabled(false);
  return pivot;
}

/** Loot colours by rarity. Deliberately loud — a drop should catch the eye
 *  across an Ostra, and rarity should be readable before you reach it. */
export const RARITY_COLOURS: Record<Rarity, number> = {
  common: 0xb8c4d0,
  fine: 0x5ec2e8,
  rare: 0xe8b13f,
};

/**
 * A dropped item: a small faceted crystal that hovers and turns.
 *
 * An octahedron rather than a box, because nothing else in the world is one —
 * loot has to be distinguishable from scenery at a glance, and silhouette does
 * that faster than colour.
 */
export function buildGroundItem(scene: Scene, rarity: Rarity): TransformNode {
  const pivot = new TransformNode("groundItem", scene);

  const colour = hexColour(RARITY_COLOURS[rarity]);
  const material = new StandardMaterial(`itemMaterial:${rarity}`, scene);
  material.diffuseColor = colour.scale(0.4);
  material.emissiveColor = colour;
  material.specularColor = Color3.Black();

  // Polyhedron type 1 is the octahedron: eight flat faces, already faceted.
  const gem = MeshBuilder.CreatePolyhedron("itemGem", { type: 1, size: 0.22 }, scene);
  gem.material = material;
  gem.isPickable = false;
  gem.parent = pivot;

  // A flat glow beneath it, so a drop in long grass still reads from above.
  const halo = MeshBuilder.CreateDisc("itemHalo", { radius: 0.5, tessellation: 12 }, scene);
  halo.rotation.x = Math.PI / 2;
  halo.position.y = -0.42;
  halo.isPickable = false;
  halo.parent = pivot;

  const haloMaterial = new StandardMaterial(`itemHalo:${rarity}`, scene);
  haloMaterial.diffuseColor = Color3.Black();
  haloMaterial.specularColor = Color3.Black();
  haloMaterial.emissiveColor = colour;
  haloMaterial.alpha = 0.22;
  haloMaterial.backFaceCulling = false;
  halo.material = haloMaterial;

  return pivot;
}
