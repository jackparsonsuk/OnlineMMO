// Babylon's ES-module build tree-shakes shader source out of the bundle and
// fetches it at runtime instead. Under Vite's dev server that request hits the
// SPA fallback and comes back as index.html, so the "GLSL" starts with
// <!doctype html> and every material fails to compile — a black screen with the
// clear colour showing through. Importing the shader modules puts them in the
// ShaderStore up front, so nothing is ever fetched.
import "@babylonjs/core/Shaders/default.vertex.js";
import "@babylonjs/core/Shaders/default.fragment.js";

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
import { Engine } from "@babylonjs/core/Engines/engine.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { Color3, Color4, Vector3 } from "@babylonjs/core/Maths/math.js";
import { Ray } from "@babylonjs/core/Culling/ray.js";
import "@babylonjs/core/Culling/ray.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";

import { Scene } from "@babylonjs/core/scene.js";
import {
  GATE_RADIUS,
  getOstra,
  heightAt,
  lakeLevel,
  lakeReach,
  regionOf,
  ruinParts,
  settlementsIn,
  WAYSTONE_RADIUS,
  type LakeDefinition,
  type OstraDefinition,
  type Rarity,
  type RuinDefinition,
  type SeaDefinition,
  type Spell,
  type WaystoneDefinition,
} from "@mmo/shared";
import {
  buildCastArc,
  buildGroundItem,
  buildObstacle,
  facet,
  flatMaterial,
  hexColour,
} from "./lowpoly.js";
import { SceneryStreamer } from "./scenery.js";
import { animateVillager, buildSettlement, buildVillager, type VillagerLife } from "./settlement.js";
import { TerrainStreamer } from "./terrain.js";

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
   * Everything belonging to the current Ostra — walls, Gates, towns. Replaced
   * wholesale on arrival rather than rebuilding the engine, which would drop
   * the WebGL context and re-show a loading flash on every trip.
   */
  ostraRoot: TransformNode | undefined;
  /** The ground and what grows on it, streamed around the camera. */
  terrain: TerrainStreamer | undefined;
  scenery: SceneryStreamer | undefined;
  /** Towns and lakes not built yet, until you come near (`DEFERRED_RANGE`). */
  deferred: Array<{ x: number; z: number; reach: number; build: () => void }>;
  deferredStarted: boolean;
  /** Everyone standing in the towns built so far, to bring to life. */
  villagers: Array<{ name: string; life: VillagerLife }>;
  ostra: OstraDefinition | undefined;
  sky: Mesh;
  /** Dimmed per Ostra (`OstraPalette.light`) along with the ambient. */
  sun: DirectionalLight;
}

export const AMBIENT_INTENSITY = 0.85;
export const SUN_INTENSITY = 0.8;
/** The daytime sun; daylight.ts moves it round from here. */
const SUN_DIRECTION = new Vector3(-0.55, -0.85, -0.4);
const SUN_COLOUR = new Color3(1, 0.96, 0.87);

export function createWorld(canvas: HTMLCanvasElement): World {
  const engine = new Engine(canvas, true, { stencil: true }, true);
  // Terra is seen from one end to the other; a conventional depth buffer runs
  // out of precision long before eight kilometres and distant hills shimmer
  // through each other. Reversed depth spends the precision evenly.
  engine.useReverseDepthBuffer = true;
  const scene = new Scene(engine);

  // Classic third-person orbit: behind and slightly above, mouse-look on drag.
  const camera = new ArcRotateCamera(
    "camera",
    -Math.PI / 2,   // alpha — horizontal angle; drives the player's heading
    Math.PI / 3.2,  // beta  — pitch
    9,              // radius
    new Vector3(0, 1, 0),
    scene,
  );
  camera.attachControl(canvas, true);
  camera.lowerRadiusLimit = 1.6;
  camera.upperRadiusLimit = 26;
  // Down to nearly overhead, and a little below the horizon so you can look
  // up at a mountain — the ground check in updateCameraCollision keeps the
  // camera out of the hill behind you.
  camera.lowerBetaLimit = 0.15;
  camera.upperBetaLimit = 1.66;
  camera.wheelDeltaPercentage = 0.02;
  camera.panningSensibility = 0; // right-drag panning would desync the follow
  camera.minZ = 0.25;
  camera.maxZ = 14000;

  const ambient = new HemisphericLight("ambient", new Vector3(0, 1, 0), scene);
  // Lifted from 0.65: faceted low-poly geometry loses its shape in shadow,
  // and the whole point of the facets is that you can read the form.
  ambient.intensity = AMBIENT_INTENSITY;

  const sun = new DirectionalLight("sun", SUN_DIRECTION.clone(), scene);
  sun.intensity = SUN_INTENSITY;
  // Warm, so the light has a direction and a time of day rather than being
  // a neutral wash.
  sun.diffuse = SUN_COLOUR.clone();

  window.addEventListener("resize", () => engine.resize());

  return {
    engine,
    scene,
    camera,
    ambient,
    preferredRadius: camera.radius,
    cameraBlocked: false,
    ostraRoot: undefined,
    terrain: undefined,
    scenery: undefined,
    deferred: [],
    deferredStarted: false,
    villagers: [],
    ostra: undefined,
    sky: buildSky(scene),
    sun,
  };
}

/** A dome, horizon to zenith, that follows the camera. Its horizon colour is
 *  the fog colour, so the far ground fades into the sky instead of meeting it
 *  at a line. */
function buildSky(scene: Scene): Mesh {
  const sky = MeshBuilder.CreateSphere("sky", { diameter: 24000, segments: 12, sideOrientation: 1 }, scene);
  const material = new StandardMaterial("skyMaterial", scene);
  material.disableLighting = true;
  material.emissiveColor = Color3.White();
  material.diffuseColor = Color3.Black();
  material.specularColor = Color3.Black();
  material.fogEnabled = false;
  material.backFaceCulling = false;
  sky.material = material;
  // Follows the camera by hand rather than with `infiniteDistance`, which
  // pushes the dome's depth to 1 — the FAR plane normally, but the NEAR plane
  // under a reversed depth buffer, where it paints over the whole world.
  scene.onBeforeRenderObservable.add(() => {
    const camera = scene.activeCamera;
    if (camera) sky.position.copyFrom(camera.globalPosition);
  });
  sky.isPickable = false;
  sky.useVertexColors = true;
  return sky;
}

export function paintSky(sky: Mesh, horizon: Color3, zenith: Color3): void {
  const positions = sky.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) return;
  const colours = new Float32Array((positions.length / 3) * 4);
  for (let i = 0; i < positions.length / 3; i++) {
    const up = positions[i * 3 + 1]! / 12000;
    const t = Math.min(1, Math.max(0, up * 2.2));
    const c = Color3.Lerp(horizon, zenith, t);
    colours[i * 4] = c.r;
    colours[i * 4 + 1] = c.g;
    colours[i * 4 + 2] = c.b;
    colours[i * 4 + 3] = 1;
  }
  sky.setVerticesData(VertexBuffer.ColorKind, colours);
}

/**
 * Swap the world over to a different Ostra. Called on first join and again on
 * every Gate arrival — the palette change is most of what sells the trip as
 * having actually gone somewhere.
 */
export function applyOstra(world: World, ostra: OstraDefinition): void {
  world.ostraRoot?.dispose(false, true);
  world.terrain?.dispose();
  world.scenery?.dispose();

  const scene = world.scene;
  const palette = ostra.palette;
  const root = new TransformNode(`ostra:${ostra.id}`, scene);
  world.ostraRoot = root;
  world.ostra = ostra;

  const sky = Color3.FromHexString(palette.sky);
  scene.clearColor = Color4.FromColor3(sky, 1);
  world.ambient.groundColor = Color3.FromHexString(palette.bounce);
  world.ambient.intensity = AMBIENT_INTENSITY * (palette.light ?? 1);
  world.sun.intensity = SUN_INTENSITY * (palette.light ?? 1);
  // Daytime, which a dungeon keeps; out in the open daylight.ts takes over.
  world.sun.direction.copyFrom(SUN_DIRECTION);
  world.sun.diffuse.copyFrom(SUN_COLOUR);
  world.ambient.diffuse.set(1, 1, 1);
  paintSky(world.sky, sky, sky.scale(ostra.wilds ? 0.62 : 0.5));

  // Haze. On a big Ostra it is what gives distance its depth, and it hides the
  // seam where detailed chunks end: trees appear at ~330 m. It has swung both
  // ways. At 0.0008 that band was 7% fog and the trees popped; at 0.0018 it was
  // a third, which hid them, but past a kilometre everything was sky — which
  // did not matter while Terra was flat and does now it has mountains, whose
  // whole point is being seen from the next valley. 0.0012 keeps a range in
  // sight to a kilometre and a half, at the price of the trees showing a
  // little more as they arrive. On a small Ostra it keeps the edge soft.
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogColor = sky;
  // A dungeon closer still: the next room should be a shape in the dark, not
  // something you can read from the door.
  scene.fogDensity = ostra.dungeon ? 0.026 : ostra.size > 1000 ? 0.0012 : 0.012;

  // The ground is built from the same height function the simulation walks on,
  // so what you see and what you stand on cannot drift apart.
  world.scenery = new SceneryStreamer(scene, ostra);
  world.terrain = new TerrainStreamer(scene, ostra, world.scenery);
  world.deferred = [];
  world.villagers = [];

  // A rim of mountains is boundary enough, and a dungeon's rock more than
  // enough; the low wall is for the small open Ostras.
  if (ostra.dungeon) addDungeon(scene, root, ostra);
  else if (!ostra.terrain.rim) addWorldEdges(scene, root, ostra);
  addObstacles(scene, root, ostra);
  for (const gate of ostra.gates) addGate(scene, root, ostra, gate.x, gate.z, gate.target);
  for (const stone of ostra.waystones) addWaystone(scene, root, ostra, stone);
  for (const ruin of ostra.ruins) addRuin(scene, root, ostra, ruin);
  if (ostra.terrain.lakes && ostra.terrain.lakes.length > 0) {
    const water = new StandardMaterial("water", scene);
    water.diffuseColor = Color3.FromHexString("#3f7ea6");
    water.specularColor = new Color3(0.35, 0.4, 0.45);
    water.specularPower = 48;
    water.emissiveColor = Color3.FromHexString("#0e2a3a");
    water.alpha = 0.78;
    water.backFaceCulling = false;
    for (const lake of ostra.terrain.lakes) {
      world.deferred.push({ x: lake.x, z: lake.z, reach: lakeReach(lake), build: () => addLake(scene, root, ostra, lake, water) });
    }
  }
  if (ostra.terrain.sea) addSea(scene, root, ostra, ostra.terrain.sea);

  for (const settlement of settlementsIn(ostra)) {
    world.deferred.push({
      x: settlement.x, z: settlement.z, reach: settlement.radius,
      build: () => {
        buildSettlement(scene, ostra, settlement).parent = root;
        for (const villager of settlement.villagers) {
          const body = buildVillager(scene, ostra, villager);
          body.parent = root;
          const life = (body.metadata as { villagerLife?: VillagerLife } | undefined)?.villagerLife;
          if (life) world.villagers.push({ name: villager.name, life });
        }
      },
    });
  }
  world.deferredStarted = false;
}

/**
 * Towns and lakes are built when you come within this of their edge, not on
 * arrival. Building every one of them up front was most of the wait to enter
 * Terra — Fanshona alone is a second of meshing, four kilometres from where
 * everyone starts, and past the fog from anywhere near Daso.
 */
const DEFERRED_RANGE = 1500;

let lastVillagerFrame = 0;

/** Once per frame: villagers breathe, glance about, and turn to whoever is
 *  near — `talkingTo` (a villager's name) gestures as it speaks. */
export function animateVillagers(world: World, now: number, x: number, z: number, talkingTo: string | undefined): void {
  const dt = Math.min(0.1, Math.max(0, (now - lastVillagerFrame) / 1000));
  lastVillagerFrame = now;
  for (const { name, life } of world.villagers) animateVillager(life, now, dt, x, z, name === talkingTo);
}

/** Stream the ground around where the camera is looking. Once per frame. */
export function updateWorld(world: World, x: number, z: number): void {
  world.terrain?.update(x, z);
  world.scenery?.update(x, z);

  // On the first frame, everything already in range is built at once: you are
  // standing in it. After that, one thing a frame, so walking towards a town
  // costs a hitch rather than a stall.
  const first = !world.deferredStarted;
  world.deferredStarted = true;
  for (let i = 0; i < world.deferred.length; i++) {
    const item = world.deferred[i]!;
    if (Math.hypot(item.x - x, item.z - z) - item.reach > DEFERRED_RANGE) continue;
    world.deferred.splice(i--, 1);
    item.build();
    if (!first) break;
  }
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
 * A dungeon: the rock its rooms are cut from, exactly where the shared box
 * colliders are, and torches along the walls of every room.
 *
 * No point lights — the standard material lights a mesh by four at most, and
 * a barrow has dozens of torches. Each is a flame that ignores lighting and a
 * faint halo round it, flickering, which reads as firelight in the dark
 * without asking the renderer for any.
 */
function addDungeon(scene: Scene, root: TransformNode, ostra: OstraDefinition): void {
  const dungeon = ostra.dungeon;
  if (!dungeon) return;

  const rock = flatMaterial(scene, "dungeonRock", Color3.FromHexString(ostra.palette.edge));
  for (const wall of dungeon.walls) {
    const block = MeshBuilder.CreateBox("dungeonRock", { width: wall.width, height: wall.height, depth: wall.depth }, scene);
    block.position.set(wall.x, heightAt(wall.x, wall.z, ostra.terrain) + wall.height / 2 - 0.3, wall.z);
    block.material = rock;
    block.metadata = { blocksCamera: true };
    block.parent = root;
  }

  const iron = flatMaterial(scene, "torchIron", 0x2e2a26);
  const wood = flatMaterial(scene, "torchWood", 0x5a3f28);
  const flame = new StandardMaterial("torchFlame", scene);
  flame.disableLighting = true;
  flame.emissiveColor = Color3.FromHexString("#ffb347");
  // Added to what is behind it rather than painted over it, so it brightens
  // the wall like light instead of hanging in front of it like a disc.
  const halo = new StandardMaterial("torchHalo", scene);
  halo.disableLighting = true;
  halo.emissiveColor = Color3.FromHexString("#ff8a2a");
  halo.alpha = 0.3;
  halo.alphaMode = Constants.ALPHA_ADD;
  halo.backFaceCulling = false;

  const flames: Mesh[] = [];
  for (const torch of dungeon.torches) {
    const pivot = new TransformNode("torch", scene);
    pivot.position.set(torch.x, heightAt(torch.x, torch.z, ostra.terrain), torch.z);
    // Local +z points away from the wall, into the room.
    pivot.rotation.y = torch.yaw;
    pivot.parent = root;

    const bracket = MeshBuilder.CreateBox("torchBracket", { width: 0.16, height: 0.5, depth: 0.22 }, scene);
    bracket.position.set(0, 2.3, 0.08);
    bracket.material = iron;
    bracket.parent = pivot;

    const stick = MeshBuilder.CreateCylinder("torchStick", { height: 0.75, diameter: 0.11, tessellation: 5 }, scene);
    stick.position.set(0, 2.5, 0.3);
    stick.rotation.x = 0.45;
    stick.material = wood;
    stick.parent = pivot;

    const fire = MeshBuilder.CreatePolyhedron("torchFlame", { type: 1, size: 0.15 }, scene);
    fire.position.set(0, 2.92, 0.46);
    fire.material = flame;
    fire.isPickable = false;
    fire.parent = pivot;
    flames.push(fire);

    const glow = MeshBuilder.CreateSphere("torchHalo", { diameter: 1.4, segments: 6 }, scene);
    glow.position.copyFrom(fire.position);
    glow.material = halo;
    glow.isPickable = false;
    glow.parent = pivot;
  }

  const flicker = scene.onBeforeRenderObservable.add(() => {
    const t = performance.now() / 1000;
    flames.forEach((fire, i) => {
      const s = 1 + Math.sin(t * 9 + i * 1.7) * 0.12 + Math.sin(t * 23 + i) * 0.06;
      fire.scaling.set(s * 0.9, s * 1.25, s * 0.9);
      fire.rotation.y = t * 2 + i;
    });
  });
  root.onDisposeObservable.add(() => scene.onBeforeRenderObservable.remove(flicker));
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

/**
 * A waystone: a tall faceted obelisk on a plinth with a glowing rune, and a
 * faint column of light above it so it can be found from a long way off.
 */
function addWaystone(scene: Scene, root: TransformNode, ostra: OstraDefinition, stone: WaystoneDefinition): void {
  const pivot = new TransformNode(`waystone:${stone.id}`, scene);
  pivot.position.set(stone.x, heightAt(stone.x, stone.z, ostra.terrain), stone.z);
  pivot.parent = root;

  const stoneMaterial = flatMaterial(scene, "waystoneStone", Color3.FromHexString("#8c8a80"));
  const plinth = facet(MeshBuilder.CreateCylinder("plinth", {
    diameterTop: WAYSTONE_RADIUS * 2.2, diameterBottom: WAYSTONE_RADIUS * 2.6, height: 0.5, tessellation: 6,
  }, scene));
  plinth.position.y = 0.2;
  plinth.material = stoneMaterial;
  plinth.parent = pivot;

  const obelisk = facet(MeshBuilder.CreateCylinder("obelisk", {
    diameterTop: 0.35, diameterBottom: WAYSTONE_RADIUS * 1.5, height: 4.2, tessellation: 4,
  }, scene));
  obelisk.position.y = 2.4;
  obelisk.rotation.y = Math.PI / 4;
  obelisk.material = stoneMaterial;
  obelisk.metadata = { blocksCamera: true };
  obelisk.parent = pivot;

  const rune = new StandardMaterial("waystoneRune", scene);
  rune.diffuseColor = Color3.Black();
  rune.specularColor = Color3.Black();
  rune.emissiveColor = hexColour(0x9fd8ff);
  const glyph = MeshBuilder.CreatePolyhedron("rune", { type: 1, size: 0.2 }, scene);
  glyph.position.set(0, 2.9, 0);
  glyph.material = rune;
  glyph.parent = pivot;

  const beamMaterial = new StandardMaterial("waystoneBeam", scene);
  beamMaterial.emissiveColor = hexColour(0x9fd8ff);
  beamMaterial.diffuseColor = Color3.Black();
  beamMaterial.specularColor = Color3.Black();
  beamMaterial.alpha = 0.09;
  beamMaterial.backFaceCulling = false;
  // A landmark has to survive the haze, or it is not much of a landmark.
  beamMaterial.fogEnabled = false;
  const beam = MeshBuilder.CreateCylinder("waystoneBeam", { diameter: 0.9, height: 60, tessellation: 6 }, scene);
  beam.position.y = 34;
  beam.material = beamMaterial;
  beam.isPickable = false;
  beam.parent = pivot;
}

/**
 * A lake's surface: a flat sheet at the water level, covering every cell of a
 * grid where the ground dips below it.
 *
 * Built from the height function rather than as a disc, so the water follows
 * the wandering shoreline the terrain carved. The bank always rises above the
 * surface (see `heightAt`), so the sheet's ragged edge is always under ground.
 */
function addLake(scene: Scene, root: TransformNode, ostra: OstraDefinition, lake: LakeDefinition, material: StandardMaterial): void {
  const level = lakeLevel(lake, ostra.terrain);
  const reach = lakeReach(lake);
  const step = 3;
  const n = Math.ceil((reach * 2) / step);
  const x0 = lake.x - reach;
  const z0 = lake.z - reach;
  const heights = new Float32Array((n + 1) * (n + 1));
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) heights[j * (n + 1) + i] = heightAt(x0 + i * step, z0 + j * step, ostra.terrain);
  }

  const positions: number[] = [];
  const indices: number[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const corners = [heights[j * (n + 1) + i]!, heights[j * (n + 1) + i + 1]!, heights[(j + 1) * (n + 1) + i]!, heights[(j + 1) * (n + 1) + i + 1]!];
      if (Math.min(...corners) >= level) continue;
      const cx = (i + 0.5) * step - reach;
      const cz = (j + 0.5) * step - reach;
      if (cx * cx + cz * cz > reach * reach) continue;
      const base = positions.length / 3;
      const ax = i * step - reach, az = j * step - reach;
      positions.push(ax, 0, az, ax + step, 0, az, ax, 0, az + step, ax + step, 0, az + step);
      indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }
  }
  if (indices.length === 0) return;

  const mesh = new Mesh("lake", scene);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.normals = positions.map((_, k) => (k % 3 === 1 ? 1 : 0));
  data.applyToMesh(mesh);
  mesh.position.set(lake.x, level, lake.z);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.parent = root;
}

/**
 * The sea's surface: one flat sheet at its level, from where the land starts
 * falling towards it out to well past the edge of the Ostra.
 *
 * Nothing like a lake's cell-by-cell sheet is needed. Everywhere the land has
 * not yet started to fall stands above the sea (`SeaDefinition` says why it
 * has to), and everywhere it has, ground below the level really is sea — so
 * the sheet can simply run on under the land, and the land hides it. Past the
 * edge it goes on until the haze has swallowed it, so the horizon is water
 * rather than the end of the world.
 */
function addSea(scene: Scene, root: TransformNode, ostra: OstraDefinition, sea: SeaDefinition): void {
  const half = ostra.size / 2;
  const beyond = half + 6000;
  const near = sea.from - sea.wander;
  // In the sea's own frame: `out` towards its edge, `along` the coast.
  const corner = (out: number, along: number): [number, number] =>
    sea.side === "east" ? [out, along] : sea.side === "west" ? [-out, along]
      : sea.side === "north" ? [along, out] : [along, -out];
  const positions: number[] = [];
  for (const [out, along] of [[near, -beyond], [beyond, -beyond], [near, beyond], [beyond, beyond]] as const) {
    const [x, z] = corner(out, along);
    positions.push(x, 0, z);
  }

  // Darker than a lake's colour for the same look: a flat sheet facing the sky
  // takes the whole of the sun and the sky light, and at a lake's colour a sea
  // this big came out a bright cyan that the haze could not pull back.
  const material = new StandardMaterial("sea", scene);
  material.diffuseColor = Color3.FromHexString("#1f4c69");
  material.specularColor = new Color3(0.4, 0.45, 0.5);
  material.specularPower = 64;
  material.emissiveColor = Color3.FromHexString("#061a26");
  material.alpha = 0.8;
  material.backFaceCulling = false;

  const mesh = new Mesh("sea", scene);
  const data = new VertexData();
  data.positions = positions;
  data.indices = [0, 1, 2, 1, 3, 2];
  data.normals = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
  data.applyToMesh(mesh);
  mesh.position.y = sea.level;
  mesh.material = material;
  mesh.isPickable = false;
  mesh.parent = root;
}

/** The stone for a place: whatever its region's rocks are made of. */
function stoneFor(ostra: OstraDefinition, x: number, z: number): Color3 {
  const rock = regionOf(ostra, x, z)?.rock ?? "grey";
  return Color3.FromHexString(rock === "red" ? "#a8603c" : rock === "dark" ? "#4a4440" : "#a39d8c");
}

/** A ruin: every stone exactly where `ruinParts` puts its collider. */
function addRuin(scene: Scene, root: TransformNode, ostra: OstraDefinition, ruin: RuinDefinition): void {
  const parts = ruinParts(ruin);
  const pivot = new TransformNode(`ruin:${ruin.id}`, scene);
  pivot.parent = root;
  const colour = stoneFor(ostra, ruin.x, ruin.z);
  const stone = flatMaterial(scene, "ruinStone", colour);
  const worn = flatMaterial(scene, "ruinWorn", colour.scale(0.78));

  for (const part of parts.stones) {
    const ground = heightAt(part.x, part.z, ostra.terrain);
    if (part.fallen) {
      const block = MeshBuilder.CreateBox("ruinFallen", {
        width: part.radius * 2, height: part.radius * 1.1, depth: Math.max(part.radius * 2.4, part.height),
      }, scene);
      block.position.set(part.x, ground + part.radius * 0.45, part.z);
      block.rotation.y = part.yaw;
      block.rotation.z = 0.12;
      block.material = worn;
      block.parent = pivot;
    } else {
      const upright = facet(MeshBuilder.CreateCylinder("ruinStone", {
        diameterTop: part.radius * 1.4, diameterBottom: part.radius * 2, height: part.height,
        tessellation: part.height > 12 ? 5 : 6,
      }, scene));
      upright.position.set(part.x, ground + part.height / 2 - 0.2, part.z);
      upright.rotation.y = part.yaw;
      // A slight lean: nothing this old stands straight.
      upright.rotation.z = (part.yaw % 0.1) - 0.05;
      upright.material = stone;
      upright.metadata = { blocksCamera: true };
      upright.parent = pivot;
    }
  }

  for (const wall of parts.walls) {
    const ground = heightAt(wall.x, wall.z, ostra.terrain);
    const block = MeshBuilder.CreateBox("ruinWall", { width: wall.width, height: wall.height, depth: wall.depth }, scene);
    block.position.set(wall.x, ground + wall.height / 2 - 0.2, wall.z);
    block.material = stone;
    block.metadata = { blocksCamera: true };
    block.parent = pivot;
  }

  if (parts.mound) {
    const mound = facet(MeshBuilder.CreateSphere("barrow", { diameter: parts.mound.radius * 2, segments: 3 }, scene));
    mound.scaling.y = (parts.mound.height * 2) / (parts.mound.radius * 2);
    mound.position.set(ruin.x, heightAt(ruin.x, ruin.z, ostra.terrain), ruin.z);
    mound.material = flatMaterial(scene, "barrowTurf", 0x4a4e3c);
    mound.metadata = { blocksCamera: true };
    mound.parent = pivot;
  }
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

/** The camera is kept at least this far above the ground beneath it. */
const CAMERA_GROUND_CLEARANCE = 0.6;

/**
 * Pull the camera in when something solid is between it and the player.
 *
 * Without this, backing against a wall in Daso puts the camera inside the
 * building and you are looking at the inside of a roof. Two tests: the ground
 * is checked by marching along the ray against `heightAt` directly — exact,
 * and far cheaper than picking against hundreds of terrain chunks — and
 * everything else by a ray pick against meshes tagged `blocksCamera`, so grass,
 * trees, villagers, loot and creatures never shove the view around.
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

  let limit = world.preferredRadius;

  const terrain = world.ostra?.terrain;
  if (terrain) {
    for (let d = 0.8; d <= limit; d += 0.4) {
      const x = target.x + direction.x * d;
      const y = target.y + direction.y * d;
      const z = target.z + direction.z * d;
      if (y < heightAt(x, z, terrain) + CAMERA_GROUND_CLEARANCE) {
        limit = Math.max(0, d - 0.3);
        break;
      }
    }
  }

  const ray = new Ray(target, direction, limit);
  const hit = world.scene.pickWithRay(
    ray,
    (mesh) => mesh.isEnabled() && mesh.metadata?.blocksCamera === true,
  );
  if (hit?.hit && hit.distance < limit) limit = hit.distance - CAMERA_PADDING;

  if (limit < world.preferredRadius) {
    camera.radius = Math.max(camera.lowerRadiusLimit ?? 1.5, limit);
    world.cameraBlocked = true;
    return;
  }

  camera.radius = world.preferredRadius;
  world.cameraBlocked = false;
}
