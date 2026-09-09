// Babylon's ES-module build tree-shakes shader source out of the bundle and
// fetches it at runtime instead. Under Vite's dev server that request hits the
// SPA fallback and comes back as index.html, so the "GLSL" starts with
// <!doctype html> and every material fails to compile — a black screen with the
// clear colour showing through. Importing the shader modules puts them in the
// ShaderStore up front, so nothing is ever fetched.
import "@babylonjs/core/Shaders/default.vertex.js";
import "@babylonjs/core/Shaders/default.fragment.js";
import "@babylonjs/materials/grid/grid.vertex.js";
import "@babylonjs/materials/grid/grid.fragment.js";

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera.js";
import { Engine } from "@babylonjs/core/Engines/engine.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { Color3, Color4, Vector3 } from "@babylonjs/core/Maths/math.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { GridMaterial } from "@babylonjs/materials/grid/gridMaterial.js";
import { Scene } from "@babylonjs/core/scene.js";
import { GATE_RADIUS, getOstra, PLAYER_SIZE, type OstraDefinition } from "@mmo/shared";

export interface World {
  engine: Engine;
  scene: Scene;
  camera: ArcRotateCamera;
  /** Ambient light, retinted per Ostra. */
  ambient: HemisphericLight;
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
  ambient.intensity = 0.65;

  const sun = new DirectionalLight("sun", new Vector3(-0.5, -1, -0.35), scene);
  sun.intensity = 0.75;

  window.addEventListener("resize", () => engine.resize());

  return { engine, scene, camera, ambient, ostraRoot: undefined };
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

  const ground = MeshBuilder.CreateGround(
    "ground",
    { width: ostra.size, height: ostra.size },
    scene,
  );
  ground.parent = root;

  // A grid makes movement legible: without a texture, a flat plane gives no
  // sense of speed or direction at all.
  const grid = new GridMaterial("groundMaterial", scene);
  grid.majorUnitFrequency = 5;
  grid.minorUnitVisibility = 0.4;
  grid.gridRatio = 1;
  grid.mainColor = Color3.FromHexString(palette.ground);
  grid.lineColor = Color3.FromHexString(palette.grid);
  ground.material = grid;

  addWorldEdges(scene, root, ostra);
  for (const gate of ostra.gates) addGate(scene, root, gate.x, gate.z, gate.target);
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

  for (const [x, z, width, depth] of walls) {
    const wall = MeshBuilder.CreateBox("edge", { width, depth, height: 0.5 }, scene);
    wall.position.set(x, 0.25, z);
    wall.material = material;
    wall.parent = root;
  }
}

/**
 * A Gate: a ring on the ground and a column of light above it, both painted in
 * the destination Ostra's colour so you can tell at a glance where one leads.
 */
function addGate(
  scene: Scene,
  root: TransformNode,
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
    { diameter: GATE_RADIUS * 2, thickness: 0.28, tessellation: 40 },
    scene,
  );
  ring.position.set(x, 0.14, z);
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
    { diameter: GATE_RADIUS * 1.8, height: 7, tessellation: 28 },
    scene,
  );
  beam.position.set(x, 3.5, z);
  beam.material = beamMaterial;
  beam.isPickable = false;
  beam.parent = root;
}

export function createPlayerMesh(scene: Scene, colour: number): TransformNode {
  const root = new TransformNode("player", scene);

  const body = MeshBuilder.CreateBox("body", { size: PLAYER_SIZE }, scene);
  body.parent = root;

  const material = new StandardMaterial("playerMaterial", scene);
  material.diffuseColor = Color3.FromHexString(`#${colour.toString(16).padStart(6, "0")}`);
  material.specularColor = new Color3(0.15, 0.15, 0.15);
  body.material = material;

  // A nose on the front face — a bare cube gives no clue which way it's facing,
  // which makes the whole camera-relative movement scheme impossible to read.
  const nose = MeshBuilder.CreateBox(
    "nose",
    { width: PLAYER_SIZE * 0.28, height: PLAYER_SIZE * 0.28, depth: PLAYER_SIZE * 0.35 },
    scene,
  );
  nose.parent = root;
  nose.position.z = PLAYER_SIZE * 0.6;

  const noseMaterial = new StandardMaterial("noseMaterial", scene);
  noseMaterial.diffuseColor = Color3.White();
  noseMaterial.emissiveColor = new Color3(0.25, 0.25, 0.25);
  nose.material = noseMaterial;

  return root;
}
