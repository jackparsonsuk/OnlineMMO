import "@babylonjs/core/Shaders/default.vertex.js";
import "@babylonjs/core/Shaders/default.fragment.js";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera.js";
import { Engine } from "@babylonjs/core/Engines/engine.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { Color3, Color4, Vector3 } from "@babylonjs/core/Maths/math.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { Scene } from "@babylonjs/core/scene.js";
import { getOstra, heightAt, PLAYER_SIZE, settlementsIn } from "@mmo/shared";
import { flatMaterial, hexColour } from "./lowpoly.js";
import { Animator, buildEnemyRig, buildPlayerRig } from "./rigs.js";
import { SceneryStreamer } from "./scenery.js";
import { buildSettlement, buildVillager, PROP_MODELS } from "./settlement.js";
import { TERRAIN_RADIUS, TerrainStreamer } from "./terrain.js";
import { voxelMaterial, voxelMesh } from "./voxel.js";

/**
 * A bench for the art, not part of the game.
 *
 * Served at /voxel-preview.html by the client's own dev server, with no
 * account, no room and no server. Everything in it is the real thing at its
 * real place: Daso where Daso stands on Terra, its ground through the real
 * terrain streamer, its trees through the real scenery streamer. Mocking any
 * of that up would only prove the mock-up looks right.
 *
 * The two things that are staged are the ones you cannot otherwise get side by
 * side: every creature in a row, and the old box player standing next to the
 * voxel one.
 */

const canvas = document.getElementById("preview") as HTMLCanvasElement;
const engine = new Engine(canvas, true, { stencil: true }, true);
engine.useReverseDepthBuffer = true;
const scene = new Scene(engine);
scene.clearColor = new Color4(0.075, 0.09, 0.11, 1);

const camera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 2.6, 12, new Vector3(0, 1, 0), scene);
camera.attachControl(canvas, true);
camera.wheelDeltaPercentage = 0.02;
camera.lowerRadiusLimit = 1;
camera.upperRadiusLimit = 400;
camera.minZ = 0.25;
camera.maxZ = 14000;

// The same two lights, at the same strengths, as scene.ts.
const ambient = new HemisphericLight("ambient", new Vector3(0, 1, 0), scene);
ambient.intensity = 0.85;
const sun = new DirectionalLight("sun", new Vector3(-0.55, -0.85, -0.4), scene);
sun.intensity = 0.8;
sun.diffuse = new Color3(1, 0.96, 0.87);

const terra = getOstra("terra");
const daso = settlementsIn(terra)[0]!;
const HOME = { x: daso.x, z: daso.z + daso.radius + 14 };
const ground = (x: number, z: number): number => heightAt(x, z, terra.terrain);

// Real ground and real scenery, streamed the way the game streams them. The
// scenery streamer is the terrain's chunk listener, exactly as in scene.ts.
const scenery = new SceneryStreamer(scene, terra);
const terrain = new TerrainStreamer(scene, terra, scenery);
terrain.prime(HOME.x, HOME.z, TERRAIN_RADIUS);
scenery.update(HOME.x, HOME.z);

buildSettlement(scene, terra, daso);
for (const villager of daso.villagers ?? []) buildVillager(scene, terra, villager);

const COLOUR = 0x4a6fa5;

/** The player as it was: ten stretched boxes, for the comparison. */
function buildBoxPlayer(): TransformNode {
  const root = new TransformNode("boxPlayer", scene);
  const u = PLAYER_SIZE;
  const bodyMat = flatMaterial(scene, "oldBody", COLOUR);
  const limbMat = flatMaterial(scene, "oldLimb", hexColour(COLOUR).scale(0.62));
  const faceMat = flatMaterial(scene, "oldFace", hexColour(COLOUR).scale(1.45));
  const steel = flatMaterial(scene, "oldBlade", 0xc9d4dc);

  const box = (
    size: { width: number; height: number; depth: number },
    x: number, y: number, z: number,
    material: typeof bodyMat,
  ): void => {
    const mesh = MeshBuilder.CreateBox("part", size, scene);
    mesh.position.set(x, y, z);
    mesh.material = material;
    mesh.parent = root;
  };

  const hips = 0.38 * u;
  for (const side of [-1, 1]) {
    box({ width: 0.18 * u, height: 0.38 * u, depth: 0.18 * u }, side * 0.14 * u, hips - 0.19 * u, 0, limbMat);
    box({ width: 0.14 * u, height: 0.46 * u, depth: 0.16 * u }, side * 0.33 * u, hips + 0.45 * u - 0.21 * u, 0, limbMat);
  }
  box({ width: 0.52 * u, height: 0.52 * u, depth: 0.32 * u }, 0, hips + 0.24 * u, 0, bodyMat);
  box({ width: 0.34 * u, height: 0.34 * u, depth: 0.34 * u }, 0, hips + 0.5 * u + 0.17 * u, 0, bodyMat);
  box({ width: 0.22 * u, height: 0.1 * u, depth: 0.06 * u }, 0, hips + 0.5 * u + 0.19 * u, 0.17 * u, faceMat);
  const bladeY = hips + 0.45 * u - 0.42 * u;
  box({ width: 0.05, height: 0.07, depth: 0.62 }, 0.33 * u, bladeY, 0.04 * u + 0.34, steel);
  box({ width: 0.2, height: 0.05, depth: 0.05 }, 0.33 * u, bladeY, 0.04 * u + 0.04, limbMat);
  return root;
}

const old = buildBoxPlayer();
old.position.set(HOME.x - 1.4, ground(HOME.x - 1.4, HOME.z), HOME.z);

const voxel = buildPlayerRig(scene, COLOUR);
voxel.root.position.set(HOME.x, ground(HOME.x, HOME.z), HOME.z);

// Every creature, in a row behind them, each walking on the spot.
const KINDS = ["zombie", "spider", "wolf", "boar", "wretch", "wisp", "golem"] as const;
const creatures = KINDS.map((kind, i) => {
  const rig = buildEnemyRig(scene, kind);
  const x = HOME.x - 7 + i * 2.4;
  const z = HOME.z + 7;
  rig.root.position.set(x, ground(x, z), z);
  return { kind, rig, animator: new Animator(rig) };
});

// The town props, in a row beside them, at the scale they are actually seen.
const propMaterial = voxelMaterial(scene, "props");
let slot = 0;
for (const [name, model] of Object.entries(PROP_MODELS)) {
  const mesh = voxelMesh(scene, name, model, "base");
  const x = HOME.x - 4 + slot * 1.4;
  const z = HOME.z + 3.4;
  mesh.material = propMaterial;
  mesh.position.set(x, ground(x, z), z);
  if (name === "log") mesh.rotation.y = Math.PI / 2;
  slot++;
}

camera.target.set(HOME.x, ground(HOME.x, HOME.z) + 1.2, HOME.z);

// The real animator, walking the voxel body in a circle: the rig swap is only
// safe if every joint the poses reach for is still where it was.
const animator = new Animator(voxel);
let walking = true;
scene.onBeforeRenderObservable.add(() => {
  const now = performance.now();
  old.rotation.y = now / 4000;

  // Standing still still feeds the animator — it has to be told where the body
  // is every frame to work out that it has stopped and settle into the idle.
  const angle = walking ? now / 1400 : 0;
  const x = HOME.x + (walking ? Math.sin(angle) * 2.2 : 0);
  const z = HOME.z + (walking ? Math.cos(angle) * 2.2 : 0);
  voxel.root.position.set(x, ground(x, z), z);
  voxel.root.rotation.y = walking ? angle + Math.PI / 2 : now / 4000;
  animator.update(now, x, z);

  for (const c of creatures) {
    c.rig.root.rotation.y = Math.sin(now / 2600) * 0.9;
    c.animator.update(now, now / 400, 0);
  }
});

(window as unknown as { setWalking: (on: boolean) => void }).setWalking = (on: boolean): void => {
  walking = on;
};

engine.runRenderLoop(() => scene.render());
window.addEventListener("resize", () => engine.resize());

// So the harness can be driven from the console when the pane pauses rAF.
(window as unknown as { preview: unknown }).preview = {
  scene, engine, camera, voxel, old, creatures, terrain, scenery, home: HOME, ground,
};
