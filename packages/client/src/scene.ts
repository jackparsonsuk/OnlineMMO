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
import { buildSettlement, buildVillager } from "./settlement.js";
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
  ostra: OstraDefinition | undefined;
  sky: Mesh;
}

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
    terrain: undefined,
    scenery: undefined,
    ostra: undefined,
    sky: buildSky(scene),
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

function paintSky(sky: Mesh, horizon: Color3, zenith: Color3): void {
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
  paintSky(world.sky, sky, sky.scale(ostra.wilds ? 0.62 : 0.5));

  // Haze. On a big Ostra it is what gives distance its depth; on a small one
  // it keeps the edge of the world soft.
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogColor = sky;
  scene.fogDensity = ostra.size > 1000 ? 0.0008 : 0.012;

  // The ground is built from the same height function the simulation walks on,
  // so what you see and what you stand on cannot drift apart.
  world.scenery = new SceneryStreamer(scene, ostra);
  world.terrain = new TerrainStreamer(scene, ostra, world.scenery);

  // A rim of mountains is boundary enough; the low wall is for small Ostras.
  if (!ostra.terrain.rim) addWorldEdges(scene, root, ostra);
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
    for (const lake of ostra.terrain.lakes) addLake(scene, root, ostra, lake, water);
  }

  for (const settlement of settlementsIn(ostra)) {
    buildSettlement(scene, ostra, settlement).parent = root;
    for (const villager of settlement.villagers) {
      buildVillager(scene, ostra, villager).parent = root;
    }
  }
}

/** Stream the ground around where the camera is looking. Once per frame. */
export function updateWorld(world: World, x: number, z: number): void {
  world.terrain?.update(x, z);
  world.scenery?.update(x, z);
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
