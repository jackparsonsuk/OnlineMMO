import { Color3 } from "@babylonjs/core/Maths/math.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { RARITY, type GatherThing, type Rarity, type Spell } from "@mmo/shared";

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
 * circle it collides with. Bodies that animate live in `rigs.ts`; streamed
 * trees, rocks and grass in `scenery.ts`.
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

  // A line is a band out ahead: a plane laid flat, pushed forward by half its
  // length so it starts at your feet. A full ring would be a disc with a seam;
  // drawing it as a complete circle avoids the arc parameter entirely.
  const full = spell.arc >= Math.PI * 2;
  const sector = spell.line !== undefined
    ? MeshBuilder.CreatePlane(`cast:${spell.id}`, { width: spell.line, height: spell.range }, scene)
    : MeshBuilder.CreateDisc(
      `cast:${spell.id}`,
      {
        radius: spell.range,
        tessellation: full ? 24 : 10,
        ...(full ? {} : { arc: spell.arc / (Math.PI * 2) }),
      },
      scene,
    );
  sector.rotation.x = Math.PI / 2;
  if (spell.line !== undefined) sector.position.z = spell.range / 2;
  else if (!full) sector.rotation.z = Math.PI / 2 - spell.arc / 2;
  sector.isPickable = false;
  sector.parent = pivot;

  const material = new StandardMaterial(`castMaterial:${spell.id}`, scene);
  material.diffuseColor = Color3.Black();
  material.specularColor = Color3.Black();
  material.emissiveColor = hexColour(colour);
  // Faint: the slash and the numbers are the show now. This is the ruler —
  // it shows exactly what the server tested, so a miss is still legible.
  material.alpha = 0.14;
  material.backFaceCulling = false;
  sector.material = material;

  pivot.setEnabled(false);
  return pivot;
}

/**
 * Something a quest wants picked up (`gathering.ts`): a small model of the
 * thing, with one part of it lit in its colour — the moonwort's flower, the
 * sack's tie, the heartwood's grey core, the candle flames — so it catches
 * the eye among the grass once you are looking in the right place.
 * Not an octahedron — that is loot, and loot is picked up by walking over it;
 * these want E, so they must not look the same.
 */
export function buildGatherable(scene: Scene, thing: GatherThing): TransformNode {
  const pivot = new TransformNode("gatherable", scene);
  const body = flatMaterial(scene, `gather:${thing.name}`, thing.colour);
  const glow = hexColour(thing.glow);
  const lit = new StandardMaterial(`gatherGlow:${thing.name}`, scene);
  lit.diffuseColor = Color3.Black();
  lit.specularColor = Color3.Black();
  lit.emissiveColor = glow;
  lit.disableLighting = true;

  const part =<T extends Mesh>(mesh: T, material: StandardMaterial): T => {
    mesh.material = material;
    mesh.isPickable = false;
    mesh.parent = pivot;
    return mesh;
  };

  switch (thing.look) {
    case "herb": {
      // A clump of blades leaning out, and a pale flower head that glows.
      for (let i = 0; i < 5; i++) {
        const blade = part(facet(MeshBuilder.CreateCylinder("herbBlade", {
          height: 0.42, diameterTop: 0, diameterBottom: 0.1, tessellation: 3,
        }, scene)), body);
        const angle = (i / 5) * Math.PI * 2;
        blade.position.set(Math.sin(angle) * 0.08, 0.2, Math.cos(angle) * 0.08);
        blade.rotation.set(Math.cos(angle) * 0.45, 0, -Math.sin(angle) * 0.45);
      }
      const flower = part(MeshBuilder.CreatePolyhedron("herbFlower", { type: 0, size: 0.07 }, scene), lit);
      flower.position.y = 0.46;
      break;
    }
    case "sack": {
      const sack = part(facet(MeshBuilder.CreateSphere("sack", { diameter: 0.6, segments: 2 }, scene)), body);
      sack.scaling.set(1, 0.8, 0.85);
      sack.position.y = 0.24;
      const neck = part(facet(MeshBuilder.CreateCylinder("sackNeck", {
        height: 0.2, diameterTop: 0.2, diameterBottom: 0.12, tessellation: 5,
      }, scene)), body);
      neck.position.y = 0.55;
      const tie = part(MeshBuilder.CreateTorus("sackTie", { diameter: 0.15, thickness: 0.04, tessellation: 6 }, scene), lit);
      tie.position.y = 0.5;
      break;
    }
    case "wood": {
      const log = part(facet(MeshBuilder.CreateCylinder("heartwood", {
        height: 0.7, diameter: 0.26, tessellation: 6,
      }, scene)), body);
      log.rotation.z = Math.PI / 2;
      log.position.y = 0.14;
      // The grey heart, showing at the cut ends: that is what glows.
      for (const side of [-1, 1]) {
        const heart = part(MeshBuilder.CreateDisc("heartwoodCore", { radius: 0.08, tessellation: 6 }, scene), lit);
        heart.rotation.y = (side * Math.PI) / 2;
        heart.position.set(side * 0.356, 0.14, 0);
      }
      break;
    }
    case "candle": {
      for (const [dx, dz, h] of [[0, 0, 0.3], [0.13, 0.06, 0.2], [-0.09, 0.1, 0.16]] as const) {
        const stub = part(facet(MeshBuilder.CreateCylinder("candle", { height: h, diameter: 0.09, tessellation: 6 }, scene)), body);
        stub.position.set(dx, h / 2, dz);
        const flame = part(MeshBuilder.CreatePolyhedron("candleFlame", { type: 1, size: 0.035 }, scene), lit);
        flame.scaling.y = 1.8;
        flame.position.set(dx, h + 0.06, dz);
      }
      break;
    }
  }

  // A faint patch of its colour on the ground, readable once you are close.
  // No more than that: they first stood under a thread of light four metres
  // tall, which found every sprig in the glade from its edge and left nothing
  // to do but walk from beam to beam. The quest's circle on the map says
  // where to look; looking is the errand.
  const halo = part(MeshBuilder.CreateDisc("gatherHalo", { radius: 0.45, tessellation: 12 }, scene), new StandardMaterial(`gatherHalo:${thing.name}`, scene));
  halo.rotation.x = Math.PI / 2;
  halo.position.y = 0.04;
  const haloMaterial = halo.material as StandardMaterial;
  haloMaterial.diffuseColor = Color3.Black();
  haloMaterial.specularColor = Color3.Black();
  haloMaterial.emissiveColor = glow;
  haloMaterial.alpha = 0.16;
  haloMaterial.disableLighting = true;
  haloMaterial.backFaceCulling = false;

  return pivot;
}

/** Rarities that throw a beam of light into the sky where they fall. */
const BEAM_RARITIES: ReadonlySet<Rarity> = new Set(["mythic", "legendary", "world", "ostra"]);

/**
 * A dropped item: a small faceted crystal that hovers and turns.
 *
 * An octahedron rather than a box, because nothing else in the world is one —
 * loot has to be distinguishable from scenery at a glance, and silhouette does
 * that faster than colour. Colours are the shared rarity colours, deliberately
 * loud: rarity should be readable before you reach it.
 *
 * Mythic and above also stand a pillar of light over themselves. Those are
 * drops people will talk about, and one falling in a crowded fight should be
 * visible from across the field — to you, and to everyone else.
 */
export function buildGroundItem(scene: Scene, rarity: Rarity): TransformNode {
  const pivot = new TransformNode("groundItem", scene);

  const colour = hexColour(RARITY[rarity].colour);
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

  if (BEAM_RARITIES.has(rarity)) {
    const beam = MeshBuilder.CreateCylinder(
      "itemBeam",
      { height: 14, diameterTop: 0.05, diameterBottom: 0.34, tessellation: 8 },
      scene,
    );
    beam.position.y = 6.6;
    beam.isPickable = false;
    beam.parent = pivot;
    const beamMaterial = new StandardMaterial(`itemBeam:${rarity}`, scene);
    beamMaterial.diffuseColor = Color3.Black();
    beamMaterial.specularColor = Color3.Black();
    beamMaterial.emissiveColor = colour;
    beamMaterial.alpha = 0.3;
    beamMaterial.backFaceCulling = false;
    beamMaterial.disableLighting = true;
    beam.material = beamMaterial;
  }

  return pivot;
}
