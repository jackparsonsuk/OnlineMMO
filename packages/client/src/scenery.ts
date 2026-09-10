import { Color3, Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import "@babylonjs/core/Meshes/thinInstanceMesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import {
  GATE_RADIUS,
  hash2,
  heightAt,
  roadDistance,
  sceneryCell,
  settlementsIn,
  slopeAt,
  type OstraDefinition,
  type SceneryItem,
} from "@mmo/shared";
import { flatMaterial } from "./lowpoly.js";
import { CHUNK, chunkKey, type ChunkListener } from "./terrain.js";

/**
 * Trees, boulders and grass for the streamed ground.
 *
 * Where each tree stands comes from `sceneryCell` in `@mmo/shared` — the same
 * deterministic cells the server collides against, so the trunk you see is the
 * trunk that stops you. This file only decides how they look.
 *
 * A dense wood is a few thousand trees in view. As individual meshes that would
 * be thousands of draw calls; instead each kind is ONE mesh drawn many times
 * with thin instances, and the per-chunk matrix lists are concatenated into its
 * buffer whenever a chunk arrives or leaves.
 */

/** Grass is small and there is a lot of it, so it only grows near you. */
const GRASS_RADIUS = 110;

/** Candidate tufts per chunk, before the rules thin them out. */
const GRASS_PER_CHUNK = 90;

type PoolKind = "pineDark" | "pineLight" | "oakDark" | "oakLight" | "rock" | "grass" | "grassTall";

/** One mesh, drawn once per matrix, fed from per-chunk lists. */
class InstancePool {
  private readonly chunks = new Map<number, Float32Array>();
  private dirty = false;

  constructor(readonly mesh: Mesh) {
    mesh.isPickable = false;
    // Instances are spread over the whole view; per-mesh culling would only
    // ever throw them all away at once or keep them all.
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.setEnabled(false);
  }

  set(key: number, matrices: Float32Array): void {
    if (matrices.length === 0) {
      if (this.chunks.delete(key)) this.dirty = true;
      return;
    }
    this.chunks.set(key, matrices);
    this.dirty = true;
  }

  delete(key: number): void {
    if (this.chunks.delete(key)) this.dirty = true;
  }

  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    let total = 0;
    for (const list of this.chunks.values()) total += list.length;
    if (total === 0) {
      this.mesh.setEnabled(false);
      return;
    }
    const buffer = new Float32Array(total);
    let offset = 0;
    for (const list of this.chunks.values()) {
      buffer.set(list, offset);
      offset += list.length;
    }
    this.mesh.thinInstanceSetBuffer("matrix", buffer, 16, true);
    this.mesh.setEnabled(true);
  }

  dispose(): void {
    this.mesh.dispose();
  }
}

/** Paint every vertex of a part one colour, so parts can be merged into one
 *  mesh and still read as bark and leaves. */
function paint(mesh: Mesh, colour: Color3): Mesh {
  const count = mesh.getTotalVertices();
  const colours = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    colours[i * 4] = colour.r;
    colours[i * 4 + 1] = colour.g;
    colours[i * 4 + 2] = colour.b;
    colours[i * 4 + 3] = 1;
  }
  mesh.setVerticesData(VertexBuffer.ColorKind, colours);
  return mesh;
}

function merge(name: string, parts: Mesh[], scene: Scene): Mesh {
  const merged = Mesh.MergeMeshes(parts, true, true) ?? new Mesh(name, scene);
  merged.name = name;
  merged.convertToFlatShadedMesh();
  merged.useVertexColors = true;
  merged.material = flatMaterial(scene, `${name}Material`, Color3.White());
  return merged;
}

/** Templates are built at unit height with a trunk radius of TRUNK, then
 *  scaled per tree so the drawn trunk matches its collision circle. */
const TRUNK = 0.07;

function buildPine(scene: Scene, name: string, leaf: Color3): Mesh {
  const bark = Color3.FromHexString("#4f3a26");
  const trunk = MeshBuilder.CreateCylinder("t", {
    height: 0.32, diameterTop: TRUNK * 1.3, diameterBottom: TRUNK * 2, tessellation: 5,
  }, scene);
  trunk.position.y = 0.16;
  const tiers = [
    { width: 0.8, height: 0.44, y: 0.5, shade: 0.82 },
    { width: 0.6, height: 0.38, y: 0.68, shade: 1 },
    { width: 0.4, height: 0.3, y: 0.85, shade: 1.14 },
  ].map((tier) => {
    const cone = MeshBuilder.CreateCylinder("c", {
      height: tier.height, diameterTop: 0, diameterBottom: tier.width, tessellation: 7,
    }, scene);
    cone.position.y = tier.y;
    return paint(cone, leaf.scale(tier.shade));
  });
  return merge(name, [paint(trunk, bark), ...tiers], scene);
}

function buildOak(scene: Scene, name: string, leaf: Color3): Mesh {
  const bark = Color3.FromHexString("#5a4128");
  const trunk = MeshBuilder.CreateCylinder("t", {
    height: 0.48, diameterTop: TRUNK * 1.4, diameterBottom: TRUNK * 2, tessellation: 6,
  }, scene);
  trunk.position.y = 0.24;
  const crown = MeshBuilder.CreateIcoSphere("c", { radius: 0.4, subdivisions: 1 }, scene);
  crown.position.y = 0.64;
  crown.scaling.y = 0.78;
  const lobe = MeshBuilder.CreateIcoSphere("l", { radius: 0.27, subdivisions: 1 }, scene);
  lobe.position.set(0.2, 0.76, 0.06);
  const lobe2 = MeshBuilder.CreateIcoSphere("l2", { radius: 0.24, subdivisions: 1 }, scene);
  lobe2.position.set(-0.17, 0.72, -0.12);
  return merge(name, [
    paint(trunk, bark),
    paint(crown, leaf),
    paint(lobe, leaf.scale(1.12)),
    paint(lobe2, leaf.scale(0.9)),
  ], scene);
}

function buildRock(scene: Scene, stone: Color3): Mesh {
  const rock = MeshBuilder.CreateIcoSphere("rock", { radius: 1, subdivisions: 1 }, scene);
  // Knock the vertices about, so it is a stone rather than a gem. Fixed
  // offsets by index — every rock is the same shape, rotated and squashed
  // differently, which is plenty.
  const positions = rock.getVerticesData(VertexBuffer.PositionKind);
  if (positions) {
    for (let i = 0; i < positions.length; i += 3) {
      const wobble = 0.78 + ((hash2(Math.round(positions[i]! * 100), Math.round(positions[i + 2]! * 100), 3) & 255) / 255) * 0.4;
      positions[i] = positions[i]! * wobble;
      positions[i + 1] = positions[i + 1]! * wobble;
      positions[i + 2] = positions[i + 2]! * wobble;
    }
    rock.updateVerticesData(VertexBuffer.PositionKind, positions);
  }
  return merge("rock", [paint(rock, stone)], scene);
}

function buildTuft(scene: Scene, name: string, colour: Color3, height: number): Mesh {
  const blades = [-1, 0, 1].map((i) => {
    const blade = MeshBuilder.CreateBox("b", { width: 0.07, height, depth: 0.07 }, scene);
    blade.position.set(i * 0.09, height / 2, (i === 0 ? 0.05 : -0.03));
    blade.rotation.z = i * 0.3;
    return paint(blade, colour.scale(i === 0 ? 1.1 : 0.92));
  });
  return merge(name, blades, scene);
}

export class SceneryStreamer implements ChunkListener {
  private readonly pools: Record<PoolKind, InstancePool>;
  private readonly grassChunks = new Set<number>();
  private readonly loaded = new Set<number>();
  private readonly composed = new Matrix();
  private readonly scale = new Vector3();
  private readonly position = new Vector3();
  private readonly rotation = new Quaternion();

  constructor(scene: Scene, private readonly ostra: OstraDefinition) {
    const palette = ostra.palette;
    const leaf = Color3.FromHexString("#3f6b3a");
    const grass = Color3.FromHexString(palette.grid);
    this.pools = {
      pineDark: new InstancePool(buildPine(scene, "pineDark", Color3.FromHexString("#2c5230"))),
      pineLight: new InstancePool(buildPine(scene, "pineLight", Color3.FromHexString("#3a6334"))),
      oakDark: new InstancePool(buildOak(scene, "oakDark", leaf)),
      oakLight: new InstancePool(buildOak(scene, "oakLight", Color3.FromHexString("#5a8a3c"))),
      rock: new InstancePool(buildRock(scene, Color3.FromHexString(palette.edge).scale(1.15))),
      grass: new InstancePool(buildTuft(scene, "grass", grass.scale(0.8), 0.45)),
      grassTall: new InstancePool(buildTuft(scene, "grassTall", grass.scale(1.1), 0.8)),
    };
  }

  onChunkLoaded(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    this.loaded.add(key);
    const lists: Record<string, number[]> = {};
    const push = (kind: PoolKind, values: Float32Array | number[]): void => {
      (lists[kind] ??= []).push(...values);
    };

    for (const item of sceneryCell(this.ostra, cx, cz).items) {
      const [kind, matrix] = this.itemMatrix(item);
      push(kind, matrix);
    }

    for (const kind of ["pineDark", "pineLight", "oakDark", "oakLight", "rock"] as const) {
      this.pools[kind].set(key, Float32Array.from(lists[kind] ?? []));
    }
  }

  onChunkUnloaded(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    this.loaded.delete(key);
    for (const pool of Object.values(this.pools)) pool.delete(key);
    this.grassChunks.delete(key);
  }

  /** Grow and cut grass around (x, z), and push any changes to the GPU. */
  update(x: number, z: number): void {
    const reach = Math.ceil(GRASS_RADIUS / CHUNK);
    const ccx = Math.floor(x / CHUNK);
    const ccz = Math.floor(z / CHUNK);
    const wanted = new Set<number>();

    for (let cz = ccz - reach; cz <= ccz + reach; cz++) {
      for (let cx = ccx - reach; cx <= ccx + reach; cx++) {
        const mx = (cx + 0.5) * CHUNK - x;
        const mz = (cz + 0.5) * CHUNK - z;
        if (Math.sqrt(mx * mx + mz * mz) > GRASS_RADIUS + CHUNK * 0.7) continue;
        const key = chunkKey(cx, cz);
        // Only on ground that exists, or it floats over the horizon mesh.
        if (!this.loaded.has(key)) continue;
        wanted.add(key);
        if (!this.grassChunks.has(key)) {
          this.grassChunks.add(key);
          this.growGrass(cx, cz, key);
        }
      }
    }
    for (const key of [...this.grassChunks]) {
      if (wanted.has(key)) continue;
      this.grassChunks.delete(key);
      this.pools.grass.delete(key);
      this.pools.grassTall.delete(key);
    }

    for (const pool of Object.values(this.pools)) pool.flush();
  }

  private itemMatrix(item: SceneryItem): [PoolKind, Float32Array] {
    const y = heightAt(item.x, item.z, this.ostra.terrain);
    // Alternate shades by position, so a wood is not one flat green.
    const shade = (hash2(Math.floor(item.x * 10), Math.floor(item.z * 10), 5) & 1) === 0;
    let kind: PoolKind;
    if (item.kind === "rock") {
      kind = "rock";
      this.scale.set(item.radius, item.height * 0.62, item.radius * 0.92);
      this.position.set(item.x, y + item.height * 0.12, item.z);
    } else {
      kind = item.kind === "pine" ? (shade ? "pineDark" : "pineLight") : (shade ? "oakDark" : "oakLight");
      // Width from the trunk's collision radius; sunk a little so the root
      // never floats on a slope.
      const width = item.radius / TRUNK;
      this.scale.set(width, item.height, width);
      this.position.set(item.x, y - 0.2, item.z);
    }
    Quaternion.RotationYawPitchRollToRef(item.yaw, 0, 0, this.rotation);
    Matrix.ComposeToRef(this.scale, this.rotation, this.position, this.composed);
    const out = new Float32Array(16);
    this.composed.copyToArray(out);
    return [kind, out];
  }

  /**
   * Tufts for one chunk. Placed from a hash of the chunk, so everyone sees the
   * same meadow; none of it collides — you walk through long grass.
   */
  private growGrass(cx: number, cz: number, key: number): void {
    const ostra = this.ostra;
    const half = ostra.size / 2 - 1.5;
    const settlements = settlementsIn(ostra);
    const snowLine = ostra.terrain.mountains ? ostra.terrain.mountains.amplitude * 0.5 : Infinity;
    const short: number[] = [];
    const tall: number[] = [];
    const out = new Float32Array(16);

    for (let n = 0; n < GRASS_PER_CHUNK; n++) {
      const h = hash2(cx * 131 + n, cz * 71 - n, 0x6a55);
      const x = (cx + (h & 0xffff) / 65536) * CHUNK;
      const z = (cz + (h >>> 16) / 65536) * CHUNK;
      if (x < -half || x > half || z < -half || z > half) continue;

      if (roadDistance(ostra, x, z) < 0.4) continue;
      if (settlements.some((s) => Math.hypot(x - s.x, z - s.z) < s.radius * 0.72)) continue;
      if (ostra.obstacles.some((o) => Math.hypot(x - o.x, z - o.z) < o.radius + 0.6)) continue;
      if (ostra.gates.some((g) => Math.hypot(x - g.x, z - g.z) < GATE_RADIUS + 1.2)) continue;
      if (slopeAt(x, z, ostra.terrain) > 0.55) continue;
      const y = heightAt(x, z, ostra.terrain);
      if (y > snowLine) continue;

      const isTall = (h & 7) === 0;
      const size = 0.8 + ((h >>> 8) & 255) / 640;
      this.scale.set(size, size, size);
      this.position.set(x, y - 0.02, z);
      Quaternion.RotationYawPitchRollToRef(((h >>> 4) & 1023) / 163, 0, 0, this.rotation);
      Matrix.ComposeToRef(this.scale, this.rotation, this.position, this.composed);
      this.composed.copyToArray(out);
      (isTall ? tall : short).push(...out);
    }

    this.pools.grass.set(key, Float32Array.from(short));
    this.pools.grassTall.set(key, Float32Array.from(tall));
  }

  dispose(): void {
    for (const pool of Object.values(this.pools)) pool.dispose();
    this.loaded.clear();
    this.grassChunks.clear();
  }
}
