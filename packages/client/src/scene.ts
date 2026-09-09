// Babylon's ES-module build tree-shakes shader source out of the bundle and
// fetches it at runtime instead. Under Vite's dev server that request hits the
// SPA fallback and comes back as index.html, so the "GLSL" starts with
// <!doctype html> and every material fails to compile — a black screen with the
// clear colour showing through. Importing the shader modules puts them in the
// ShaderStore up front, so nothing is ever fetched.
import "@babylonjs/core/Shaders/default.vertex.js";
import "@babylonjs/core/Shaders/default.fragment.js";

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera.js";
import { Engine } from "@babylonjs/core/Engines/engine.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { Color3, Color4, Vector3 } from "@babylonjs/core/Maths/math.js";
import { Ray } from "@babylonjs/core/Culling/ray.js";
import "@babylonjs/core/Culling/ray.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";

import { Scene } from "@babylonjs/core/scene.js";
import {
  GATE_RADIUS,
  getOstra,
  heightAt,
  PLAYER_SIZE,
  settlementsIn,
  type EnemyKind,
  type OstraDefinition,
  type Rarity,
  type Spell,
} from "@mmo/shared";
import {
  buildCastArc,
  buildEnemy,
  buildGroundCover,
  buildGroundItem,
  buildObstacle,
  buildPlayer,
  facet,
  flatMaterial,
} from "./lowpoly.js";
import { buildSettlement, buildVillager } from "./settlement.js";
import { buildTerrain } from "./terrain.js";

export interface World {
  engine: Engine;
  scene: Scene;
  camera: ArcRotateCamera;
  /** Ambient light, retinted per Ostra. */
  ambient: HemisphericLight;
  /** What the viewer last chose with the scroll wheel, kept separately so a
   *  wall pulling the camera in does not overwrite their preference. */
  preferredRadius: number;
  /** True while a wall or hill is holding the camera closer than asked. */
  cameraBlocked: boolean;
  /**
   * Everything belonging to the current Ostra — ground, walls, Gates. Replaced
   * wholesale on arrival rather than rebuilding the engine, which would drop
   * the WebGL context and re-show a loading flash on every trip.
   */
  ostraRoot: TransformNode | undefined;
}

export function createWorld(canvas: HTMLCanvasElement): World {
  const engine = new Engine(canvas, true, { stencil: true }, true);
  const scene = new Scene(engine);

  // Classic third-person orbit: behind and slightly above, mouse-look on drag.
  const camera = new ArcRotateCamera(
    "camera",
    -Math.PI / 2,   // alpha — horizontal angle; drives the player's heading
    Math.PI / 3.2,  // beta  — pitch
    9,              // radius
    new Vector3(0, PLAYER_SIZE, 0),
    scene,
  );
  camera.attachControl(canvas, true);
  camera.lowerRadiusLimit = 3;
  camera.upperRadiusLimit = 24;
  // Stop the camera swinging under the floor or snapping over the top.
  camera.lowerBetaLimit = 0.15;
  camera.upperBetaLimit = Math.PI / 2.05;
  camera.wheelDeltaPercentage = 0.02;
  camera.panningSensibility = 0; // right-drag panning would desync the follow

  const ambient = new HemisphericLight("ambient", new Vector3(0, 1, 0), scene);
  // Lifted from 0.65: faceted low-poly geometry loses its shape in shadow,
  // and the whole point of the facets is that you can read the form.
  ambient.intensity = 0.85;

  const sun = new DirectionalLight("sun", new Vector3(-0.55, -0.85, -0.4), scene);
  sun.intensity = 0.8;
  // Warm, so the light has a direction and a time of day rather than being
  // a neutral wash.
  sun.diffuse = new Color3(1, 0.96, 0.87);

  window.addEventListener("resize", () => engine.resize());

  return {
    engine,
    scene,
    camera,
    ambient,
    preferredRadius: camera.radius,
    cameraBlocked: false,
    ostraRoot: undefined,
  };
}

/**
 * Swap the world over to a different Ostra. Called on first join and again on
 * every Gate arrival — the palette change is most of what sells the trip as
 * having actually gone somewhere.
 */
export function applyOstra(world: World, ostra: OstraDefinition): void {
  world.ostraRoot?.dispose(false, true);

  const scene = world.scene;
  const palette = ostra.palette;
  const root = new TransformNode(`ostra:${ostra.id}`, scene);
  world.ostraRoot = root;

  scene.clearColor = Color4.FromHexString(`${palette.sky}ff`);
  world.ambient.groundColor = Color3.FromHexString(palette.bounce);

  // The ground is now built from the same height function the simulation
  // walks on, so what you see and what you stand on cannot drift apart.
  buildTerrain(scene, ostra).parent = root;

  addWorldEdges(scene, root, ostra);
  addObstacles(scene, root, ostra);
  for (const gate of ostra.gates) addGate(scene, root, ostra, gate.x, gate.z, gate.target);

  // Towns first, so their footprints can be excluded from the scatter.
  const settlements = settlementsIn(ostra);
  const exclusions: Array<{ x: number; z: number; radius: number }> = [];

  for (const settlement of settlements) {
    buildSettlement(scene, ostra, settlement).parent = root;
    for (const villager of settlement.villagers) {
      buildVillager(scene, ostra, villager).parent = root;
    }
    // Grass stops at the edge of the yard; the trees are placed by hand.
    exclusions.push({ x: settlement.x, z: settlement.z, radius: settlement.radius * 0.72 });
  }

  for (const obstacle of ostra.obstacles) {
    exclusions.push({ x: obstacle.x, z: obstacle.z, radius: obstacle.radius + 0.6 });
  }
  for (const gate of ostra.gates) {
    exclusions.push({ x: gate.x, z: gate.z, radius: GATE_RADIUS + 1.2 });
  }

  buildGroundCover(scene, ostra, exclusions).parent = root;
}

/** A low wall marking where `applyInput` clamps you, so the boundary isn't an
 *  invisible surprise. */
function addWorldEdges(scene: Scene, root: TransformNode, ostra: OstraDefinition): void {
  const material = new StandardMaterial("edgeMaterial", scene);
  material.diffuseColor = Color3.FromHexString(ostra.palette.edge);
  material.specularColor = Color3.Black();

  const half = ostra.size / 2;
  const walls: Array<[number, number, number, number]> = [
    [0, -half, ostra.size, 0.3],
    [0, half, ostra.size, 0.3],
    [-half, 0, 0.3, ostra.size],
    [half, 0, 0.3, ostra.size],
  ];

  // Segmented so it steps down into valleys rather than floating over them.
  const segments = Math.max(4, Math.round(ostra.size / 6));
  for (const [x, z, width, depth] of walls) {
    const along = width > depth;
    for (let i = 0; i < segments; i++) {
      const t = (i + 0.5) / segments - 0.5;
      const px = along ? t * ostra.size : x;
      const pz = along ? z : t * ostra.size;
      // The tuple carries the wall's own thickness in whichever axis it is
      // thin on; segmenting replaces the LONG axis, never the thin one.
      // Getting these the wrong way round builds an 80m slab across the map.
      const thickness = along ? depth : width;
      const segment = ostra.size / segments + 0.1;
      const wall = MeshBuilder.CreateBox("edge", {
        width: along ? segment : thickness,
        depth: along ? thickness : segment,
        height: 1.1,
      }, scene);
      wall.position.set(px, heightAt(px, pz, ostra.terrain) + 0.35, pz);
      wall.material = material;
      wall.metadata = { blocksCamera: true };
      wall.parent = root;
    }
  }
}

/**
 * Solid scenery. Rendered as cylinders because collision treats them as
 * circles — a box would be a promise the simulation doesn't keep, and players
 * would scrape along an invisible curve at its corners.
 */
function addObstacles(scene: Scene, root: TransformNode, ostra: OstraDefinition): void {
  if (ostra.obstacles.length === 0) return;

  // Only a touch lighter than the palette's stone. The 1.4x this used to be
  // was tuned against a near-black ground and blows out to white now that
  // Terra is daylight.
  const material = flatMaterial(
    scene,
    "obstacleMaterial",
    Color3.FromHexString(ostra.palette.edge).scale(1.05),
  );

  for (const obstacle of ostra.obstacles) {
    const mesh = buildObstacle(
      scene,
      ostra.obstacleStyle,
      obstacle.radius,
      obstacle.height,
      material,
    );
    mesh.position.x = obstacle.x;
    mesh.position.y += heightAt(obstacle.x, obstacle.z, ostra.terrain);
    mesh.position.z = obstacle.z;
    mesh.metadata = { blocksCamera: true };
    mesh.parent = root;
  }
}

/**
 * A Gate: a ring on the ground and a column of light above it, both painted in
 * the destination Ostra's colour so you can tell at a glance where one leads.
 */
function addGate(
  scene: Scene,
  root: TransformNode,
  ostra: OstraDefinition,
  x: number,
  z: number,
  target: OstraDefinition["id"],
): void {
  const colour = Color3.FromHexString(getOstra(target).palette.grid);

  const ringMaterial = new StandardMaterial("gateRing", scene);
  ringMaterial.diffuseColor = colour.scale(0.3);
  ringMaterial.emissiveColor = colour;
  ringMaterial.specularColor = Color3.Black();

  const ring = MeshBuilder.CreateTorus(
    "gate",
    // Coarse on both axes: the ring should read as cut facets like everything
    // else, not as the one smooth object in the scene.
    { diameter: GATE_RADIUS * 2, thickness: 0.28, tessellation: 12 },
    scene,
  );
  facet(ring);
  const groundY = heightAt(x, z, ostra.terrain);
  ring.position.set(x, groundY + 0.14, z);
  ring.material = ringMaterial;
  ring.parent = root;

  const beamMaterial = new StandardMaterial("gateBeam", scene);
  beamMaterial.emissiveColor = colour;
  beamMaterial.diffuseColor = Color3.Black();
  beamMaterial.specularColor = Color3.Black();
  beamMaterial.alpha = 0.14;
  // Drawing the inside of the cylinder too stops the column looking like a
  // flat sheet when you orbit around it.
  beamMaterial.backFaceCulling = false;

  const beam = MeshBuilder.CreateCylinder(
    "gateBeam",
    { diameter: GATE_RADIUS * 1.8, height: 7, tessellation: 12 },
    scene,
  );
  beam.position.set(x, groundY + 3.5, z);
  beam.material = beamMaterial;
  beam.isPickable = false;
  beam.parent = root;
}

export function createPlayerMesh(scene: Scene, colour: number): TransformNode {
  return buildPlayer(scene, colour);
}

export function createEnemyMesh(scene: Scene, kind: EnemyKind): TransformNode {
  return buildEnemy(scene, kind);
}

export function createCastArc(scene: Scene, spell: Spell, colour: number): TransformNode {
  return buildCastArc(scene, spell, colour);
}

export function createGroundItemMesh(scene: Scene, rarity: Rarity): TransformNode {
  return buildGroundItem(scene, rarity);
}

/** How far in front of a wall the camera stops. Enough that the near clip
 *  plane never cuts into the geometry. */
const CAMERA_PADDING = 0.45;

/**
 * Pull the camera in when something solid is between it and the player.
 *
 * Without this, backing against a wall in Daso puts the camera inside the
 * building and you are looking at the inside of a roof. A ray from the player
 * outwards is the cheapest correct test, and only things tagged
 * `blocksCamera` are considered — grass, villagers, loot and creatures should
 * never shove the view around.
 *
 * The viewer's chosen distance is remembered separately, so walking away from
 * a wall returns the camera to where they had it. Scrolling *while* pressed
 * against a wall is the one case this handles imperfectly; it takes effect as
 * soon as you step clear.
 */
export function updateCameraCollision(world: World): void {
  const camera = world.camera;
  if (!world.cameraBlocked) world.preferredRadius = camera.radius;

  const target = camera.target;
  const direction = camera.position.subtract(target);
  const distance = direction.length();
  if (distance < 1e-3) return;
  direction.scaleInPlace(1 / distance);

  const ray = new Ray(target, direction, world.preferredRadius);
  const hit = world.scene.pickWithRay(
    ray,
    (mesh) => mesh.isEnabled() && mesh.metadata?.blocksCamera === true,
  );

  if (hit?.hit && hit.distance < world.preferredRadius) {
    camera.radius = Math.max(
      camera.lowerRadiusLimit ?? 1.5,
      hit.distance - CAMERA_PADDING,
    );
    world.cameraBlocked = true;
    return;
  }

  camera.radius = world.preferredRadius;
  world.cameraBlocked = false;
}
