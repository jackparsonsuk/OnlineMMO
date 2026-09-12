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
import { buildSettlement, buildVillager, PROP_MODELS } from "./settlement.js";
import { SceneryStreamer } from "./scenery.js";
import { CHUNK } from "./terrain.js";
import { voxelMaterial, voxelMesh } from "./voxel.js";

/**
 * A bench for the art, not part of the game.
 *
 * Served at /voxel-preview.html by the client's own dev server, with no
 * account, no room and no world — the point is to look at one body at a time
 * with the lighting the game actually uses, and to keep the thing it replaced
 * standing next to it so the comparison is honest.
 */

const canvas = document.getElementById("preview") as HTMLCanvasElement;
const engine = new Engine(canvas, true, { stencil: true }, true);
engine.useReverseDepthBuffer = true;
const scene = new Scene(engine);
scene.clearColor = new Color4(0.075, 0.09, 0.11, 1);

const camera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 2.6, 3.4, new Vector3(0, 0.6, 0), scene);
camera.attachControl(canvas, true);
camera.wheelDeltaPercentage = 0.02;
camera.lowerRadiusLimit = 1;
camera.upperRadiusLimit = 12;

// The same two lights, at the same strengths, as scene.ts.
const ambient = new HemisphericLight("ambient", new Vector3(0, 1, 0), scene);
ambient.intensity = 0.85;
const sun = new DirectionalLight("sun", new Vector3(-0.55, -0.85, -0.4), scene);
sun.intensity = 0.8;
sun.diffuse = new Color3(1, 0.96, 0.87);

const ground = MeshBuilder.CreateGround("ground", { width: 40, height: 40 }, scene);
ground.material = flatMaterial(scene, "ground", 0x4a5a3c);

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
old.position.x = -0.75;

const voxel = buildPlayerRig(scene, COLOUR);
voxel.root.position.x = 0.75;

// Daso itself, off to one side. Buildings and villagers are only honest when
// they are the real ones at their real sizes, so the bench builds the actual
// settlement out of the actual Ostra rather than a mock-up of one.
const terra = getOstra("terra");
const daso = settlementsIn(terra)[0];
if (daso) {
  const town = buildSettlement(scene, terra, daso);
  // Brought to the origin and dropped to the bench's flat ground.
  town.position.set(-daso.x + 16, -heightAt(daso.x, daso.z, terra.terrain), -daso.z - 22);
  for (const villager of daso.villagers ?? []) {
    const npc = buildVillager(scene, terra, villager);
    npc.position.addInPlace(town.position);
  }
}

// A patch of real wilds, through the real streamer, so the uniform per-instance
// scaling is exercised rather than described. Chunks are loaded by hand because
// there is no terrain here to stream against.
const scenery = new SceneryStreamer(scene, terra);
const WOOD = { x: -1180, z: 260 };
const wc = { x: Math.floor(WOOD.x / CHUNK), z: Math.floor(WOOD.z / CHUNK) };
for (let cz = wc.z - 2; cz <= wc.z + 2; cz++) {
  for (let cx = wc.x - 2; cx <= wc.x + 2; cx++) scenery.onChunkLoaded(cx, cz);
}
scenery.update(WOOD.x, WOOD.z);

// Every creature, in a row, each walking on the spot so the gait and the rig
// swap are both under the eye at once.
const KINDS = ["zombie", "spider", "wolf", "boar", "wretch", "wisp", "golem"] as const;
const creatures = KINDS.map((kind, i) => {
  const rig = buildEnemyRig(scene, kind);
  rig.root.position.set(-6 + i * 2, 0, -3.4);
  return { kind, rig, animator: new Animator(rig) };
});

// The town props, in a row behind the two bodies, at the scale they are
// actually seen from.
const propMaterial = voxelMaterial(scene, "props");
let slot = 0;
for (const [name, model] of Object.entries(PROP_MODELS)) {
  const mesh = voxelMesh(scene, name, model, "base");
  mesh.material = propMaterial;
  mesh.position.set(-3.2 + slot * 1.3, 0, 2.6);
  if (name === "log") mesh.rotation.y = Math.PI / 2;
  slot++;
}

// The real animator, walking the voxel body in a circle: the rig swap is only
// safe if every joint the poses reach for is still where it was.
const animator = new Animator(voxel);
let walking = true;
scene.onBeforeRenderObservable.add(() => {
  const now = performance.now();
  const spin = now / 4000;
  old.rotation.y = spin;
  // Standing still still feeds the animator — it has to be told where the body
  // is every frame to work out that it has stopped and settle into the idle.
  const angle = walking ? now / 1400 : 0;
  const x = walking ? 0.75 + Math.sin(angle) * 0.9 : 0.75;
  const z = walking ? Math.cos(angle) * 0.9 : 0;
  if (!walking) {
    voxel.root.position.set(x, 0, z);
    voxel.root.rotation.y = spin;
    animator.update(now, x, z);
    return;
  }
  voxel.root.position.set(x, 0, z);
  voxel.root.rotation.y = angle + Math.PI / 2;
  animator.update(now, x, z);
});

// Creatures walk on the spot: the animator reads speed from how far the body
// moved, so they are fed a position that creeps forward and is reset.
scene.onBeforeRenderObservable.add(() => {
  const now = performance.now();
  for (const { rig, animator } of creatures) {
    rig.root.rotation.y = Math.sin(now / 2600) * 0.9;
    animator.update(now, now / 400, 0);
  }
});

(window as unknown as { setWalking: (on: boolean) => void }).setWalking = (on: boolean): void => {
  walking = on;
  if (!on) voxel.root.position.set(0.75, 0, 0);
};

engine.runRenderLoop(() => scene.render());
window.addEventListener("resize", () => engine.resize());

// So the harness can be driven from the console when the pane pauses rAF.
(window as unknown as { preview: unknown }).preview = { scene, engine, camera, voxel, old, creatures, wood: WOOD };
