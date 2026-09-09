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
import { PLAYER_SIZE, WORLD_SIZE } from "@mmo/shared";

export interface World {
  engine: Engine;
  scene: Scene;
  camera: ArcRotateCamera;
}

export function createWorld(canvas: HTMLCanvasElement): World {
  const engine = new Engine(canvas, true, { stencil: true }, true);
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.05, 0.06, 0.09, 1);

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
  ambient.groundColor = new Color3(0.12, 0.14, 0.2);

  const sun = new DirectionalLight("sun", new Vector3(-0.5, -1, -0.35), scene);
  sun.intensity = 0.75;

  const ground = MeshBuilder.CreateGround(
    "ground",
    { width: WORLD_SIZE, height: WORLD_SIZE },
    scene,
  );
  // A grid makes movement legible: without a texture, a flat plane gives no
  // sense of speed or direction at all.
  const grid = new GridMaterial("groundMaterial", scene);
  grid.majorUnitFrequency = 5;
  grid.minorUnitVisibility = 0.4;
  grid.gridRatio = 1;
  grid.mainColor = new Color3(0.09, 0.11, 0.15);
  grid.lineColor = new Color3(0.28, 0.34, 0.44);
  ground.material = grid;

  addWorldEdges(scene);

  window.addEventListener("resize", () => engine.resize());

  return { engine, scene, camera };
}

/** A low wall marking where `applyInput` clamps you, so the boundary isn't
 *  an invisible surprise. */
function addWorldEdges(scene: Scene): void {
  const material = new StandardMaterial("edgeMaterial", scene);
  material.diffuseColor = new Color3(0.22, 0.27, 0.36);
  material.specularColor = Color3.Black();

  const half = WORLD_SIZE / 2;
  const walls: Array<[number, number, number, number]> = [
    [0, -half, WORLD_SIZE, 0.3],
    [0, half, WORLD_SIZE, 0.3],
    [-half, 0, 0.3, WORLD_SIZE],
    [half, 0, 0.3, WORLD_SIZE],
  ];

  for (const [x, z, width, depth] of walls) {
    const wall = MeshBuilder.CreateBox("edge", { width, depth, height: 0.5 }, scene);
    wall.position.set(x, 0.25, z);
    wall.material = material;
  }
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
