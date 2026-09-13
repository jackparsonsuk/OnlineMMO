import { Color3, Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import "@babylonjs/core/Meshes/thinInstanceMesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import {
  GATE_RADIUS,
  hash2,
  heightAt,
  lakeLevel,
  lakeReach,
  regionOf,
  roadDistance,
  SAND_HEIGHT,
  sceneryCell,
  seaRamp,
  settlementsIn,
  slopeAt,
  type OstraDefinition,
  type RegionDefinition,
  type SceneryItem,
} from "@mmo/shared";
import { build, tint, voxelMaterial, voxelMesh, VOXEL, type VoxelModel } from "./voxel.js";
import { CHUNK, chunkKey, type ChunkListener, unkey } from "./terrain.js";

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

type TreePool = "pineDark" | "pineLight" | "oakDark" | "oakLight" | "birch" | "dead";
type RockPool =
  | "rockGrey0" | "rockGrey1" | "rockGrey2"
  | "rockRed0" | "rockRed1" | "rockRed2"
  | "rockDark0" | "rockDark1" | "rockDark2";
type GrassPool = "grass" | "dry" | "heather" | "reeds" | "ash";
type PoolKind = TreePool | RockPool | GrassPool;

const TREE_POOLS: readonly (TreePool | RockPool)[] = [
  "pineDark", "pineLight", "oakDark", "oakLight", "birch", "dead",
  "rockGrey0", "rockGrey1", "rockGrey2",
  "rockRed0", "rockRed1", "rockRed2",
  "rockDark0", "rockDark1", "rockDark2",
];

/** How squat each of the three rock templates is, as height over radius. */
const ROCK_SQUAT = [0.85, 1.05, 1.25] as const;
const GRASS_POOLS: readonly GrassPool[] = ["grass", "dry", "heather", "reeds", "ash"];
const ROCK_POOL: Record<RegionDefinition["rock"], readonly RockPool[]> = {
  grey: ["rockGrey0", "rockGrey1", "rockGrey2"],
  red: ["rockRed0", "rockRed1", "rockRed2"],
  dark: ["rockDark0", "rockDark1", "rockDark2"],
};

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

/**
 * Trees, rocks and grass, as voxel models.
 *
 * Two things had to change to get here. Templates used to be built at unit
 * height and scaled *non-uniformly* per instance — (radius, height, radius)
 * for a tree, (radius, height * 0.62, radius * 0.92) for a rock — which is
 * fine for a smooth cone and fatal for voxels, because it stretches every cell
 * into a brick. Every instance is now scaled uniformly, so a cell stays a cube.
 *
 * That works because the generator drives a tree's height and its trunk radius
 * from the same roll: a pine is 7-12 m tall with a 0.45-0.70 m trunk, so the
 * ratio only moves by a tenth across the whole range. Scaling by the RADIUS
 * makes the drawn trunk match the collision circle exactly — which is the one
 * that matters, since it is what the server stops you against — and leaves the
 * height within a few percent of what the generator asked for. Rocks are not
 * proportional (0.8 to 1.3 of their radius), so they get three templates of
 * different squatness instead, chosen by the same roll.
 *
 * And they are drawn on a coarser grid: SCENERY_CELL rather than VOXEL. A ten
 * metre pine at 1/32 m is thirteen million cells, and pointless — you look at a
 * tree from twenty metres and a face from three, so a voxel four times bigger
 * on it subtends the same angle. The grain matches; the grid does not.
 */
const SCENERY_CELL = 1 / 8;
const ROCK_CELL = 1 / 16;

/** Template trunk radius per species, in metres. An instance is scaled by
 *  `item.radius / this`, so the drawn trunk is the collision circle. */
const TEMPLATE_TRUNK: Record<TreePool, number> = {
  pineDark: 0.575, pineLight: 0.575, oakDark: 0.7, oakLight: 0.7, birch: 0.425, dead: 0.525,
};

const BARK = 0x4f3a26;
const BARK_OAK = 0x5a4128;

/** Cells for a length in metres, on the scenery grid. */
const sc = (metres: number): number => Math.round(metres / SCENERY_CELL);

/** Babylon colour back to the packed integer the voxel palette wants. */
const packed = (colour: Color3): number =>
  (Math.round(colour.r * 255) << 16) | (Math.round(colour.g * 255) << 8) | Math.round(colour.b * 255);

/** Shared plumbing: one flat vertex-coloured material for everything that
 *  grows, and a mesh standing on its base. */
let sceneryMaterial: StandardMaterial | undefined;
function sceneryMesh(scene: Scene, name: string, model: VoxelModel, cell: number): Mesh {
  const mesh = voxelMesh(scene, name, model, "base", cell);
  sceneryMaterial ??= voxelMaterial(scene, "scenery");
  mesh.material = sceneryMaterial;
  return mesh;
}

/** A conifer: a bare trunk and three tiers of needles, each a stepped cone. */
function buildPine(scene: Scene, name: string, leaf: Color3): Mesh {
  const leafRgb = packed(leaf);
  const w = sc(6.6);
  const h = sc(9.5);
  const model = build(w, h, w, (v) => {
    const mid = w / 2;
    v.cylinder(mid, mid, sc(0.575), 0, sc(3.4), BARK);
    v.speckle(BARK, 121, [tint(BARK, 0.82), tint(BARK, 1.18)], 0.3);
    // Three tiers, each a cone stepped a cell at a time — which is what a
    // voxel conifer is, and it reads better than a smooth one ever did.
    const tiers = [
      { y: 2.4, height: 3.4, radius: 3.3, shade: 0.82 },
      { y: 4.6, height: 3.0, radius: 2.5, shade: 1.0 },
      { y: 6.6, height: 2.9, radius: 1.6, shade: 1.16 },
    ];
    for (const tier of tiers) {
      const steps = sc(tier.height);
      for (let k = 0; k < steps; k++) {
        const r = sc(tier.radius) * (1 - k / steps);
        if (r < 0.6) continue;
        v.cylinder(mid, mid, r, sc(tier.y) + k, 1, tint(leafRgb, tier.shade));
      }
    }
    v.speckle(leafRgb, 122, [tint(leafRgb, 0.84), tint(leafRgb, 1.14)], 0.22);
  });
  return sceneryMesh(scene, name, model, SCENERY_CELL);
}

/** A broadleaf: a short thick trunk under a lumpy crown. */
function buildOak(scene: Scene, name: string, leaf: Color3): Mesh {
  const leafRgb = packed(leaf);
  const w = sc(7.0);
  const h = sc(8.2);
  const model = build(w, h, w, (v) => {
    const mid = w / 2;
    v.cylinder(mid, mid, sc(0.7), 0, sc(4.6), BARK_OAK);
    // Two boughs out of the fork, so the crown has something holding it up.
    for (const [dx, dz] of [[-1, 0.6], [1, -0.6]] as const) {
      v.fill(Math.round(mid + dx * sc(0.8)), sc(3.2), Math.round(mid + dz * sc(0.8)), 3, sc(1.4), 3, BARK_OAK);
    }
    v.speckle(BARK_OAK, 123, [tint(BARK_OAK, 0.82), tint(BARK_OAK, 1.18)], 0.3);
    // Rounder than it is wide. An ellipsoid flatter than about 1.4 to 1 stops
    // reading as a canopy and starts reading as a mushroom cap.
    v.ellipsoid(mid, sc(5.5), mid, sc(3.0), sc(2.5), sc(3.0), leafRgb);
    v.ellipsoid(mid + sc(1.7), sc(6.3), mid + sc(0.5), sc(1.9), sc(1.7), sc(1.9), tint(leafRgb, 1.12));
    v.ellipsoid(mid - sc(1.5), sc(4.9), mid - sc(1.1), sc(1.8), sc(1.6), sc(1.8), tint(leafRgb, 0.88));
    v.speckle(leafRgb, 124, [tint(leafRgb, 0.84), tint(leafRgb, 1.16)], 0.24);
  });
  return sceneryMesh(scene, name, model, SCENERY_CELL);
}

/** Pale bark with dark bands, a narrow crown. Brightwater and the fens. */
function buildBirch(scene: Scene): Mesh {
  const w = sc(5.0);
  const h = sc(8.0);
  const bark = 0xddd8c8;
  const leafRgb = 0x8cb05a;
  const model = build(w, h, w, (v) => {
    const mid = w / 2;
    v.cylinder(mid, mid, sc(0.425), 0, sc(5.6), bark);
    // The bands, which are the whole point of a birch.
    for (const y of [1.1, 2.3, 3.1, 4.4]) v.cylinder(mid, mid, sc(0.46), sc(y), 1, 0x3a3530);
    v.speckle(bark, 125, [tint(bark, 0.92), tint(bark, 1.04)], 0.2);
    v.ellipsoid(mid, sc(6.2), mid, sc(2.1), sc(2.4), sc(2.1), leafRgb);
    v.ellipsoid(mid + sc(0.9), sc(4.9), mid - sc(0.5), sc(1.4), sc(1.2), sc(1.4), tint(leafRgb, 0.88));
    v.speckle(leafRgb, 126, [tint(leafRgb, 0.84), tint(leafRgb, 1.16)], 0.24);
  });
  return sceneryMesh(scene, "birch", model, SCENERY_CELL);
}

/** Bare, charred, crooked: Ashfall and the high moor. */
function buildDead(scene: Scene): Mesh {
  const w = sc(4.2);
  const h = sc(6.25);
  const wood = 0x3e3530;
  const model = build(w, h, w, (v) => {
    const mid = w / 2;
    // A trunk that leans as it climbs, rather than a straight post.
    for (let y = 0; y < h; y++) {
      const lean = Math.round((y / h) * sc(0.7));
      const r = sc(0.525) * (1 - (y / h) * 0.55);
      if (r < 0.5) break;
      v.cylinder(mid + lean, mid, r, y, 1, wood);
    }
    // Three limbs, each stepped outward and up.
    const limbs = [{ y: 3.4, dx: 1, dz: 0 }, { y: 4.3, dx: -1, dz: 0.5 }, { y: 5.0, dx: 0.3, dz: -1 }];
    for (const limb of limbs) {
      for (let k = 0; k < sc(1.6); k++) {
        v.fill(
          Math.round(mid + limb.dx * k), sc(limb.y) + Math.round(k * 0.7), Math.round(mid + limb.dz * k),
          2, 2, 2, tint(wood, 1.12),
        );
      }
    }
    v.speckle(wood, 127, [tint(wood, 0.8), tint(wood, 1.24)], 0.3);
  });
  return sceneryMesh(scene, "dead", model, SCENERY_CELL);
}

/**
 * A boulder, at one of three squatnesses. Rocks are the one kind whose height
 * is not proportional to its radius, so rather than stretch the cells the
 * streamer picks the template whose proportions already match.
 */
function buildRock(scene: Scene, name: string, stone: Color3, squat: number): Mesh {
  const stoneRgb = packed(stone);
  const r = Math.round(1 / ROCK_CELL);
  const h = Math.max(4, Math.round(r * squat));
  const model = build(r * 2, h, r * 2, (v) => {
    v.ellipsoid(r, h * 0.55, r, r - 0.5, h * 0.62, (r - 0.5) * 0.94, stoneRgb);
    // Knocked about by a hash of the cell, so it is a stone and not an egg.
    for (let z = 0; z < r * 2; z++) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < r * 2; x++) {
          if (v.at(x, y, z) === 0) continue;
          if ((hash2(x * 31 + y, z * 17 - y, 0x5a1d) & 15) === 0) v.clear(x, y, z, 1, 1, 1);
        }
      }
    }
    v.speckle(stoneRgb, 128, [tint(stoneRgb, 0.84), tint(stoneRgb, 1.14)], 0.2);
  });
  return sceneryMesh(scene, name, model, ROCK_CELL);
}

/** A tuft: three blades leaning apart. Grass is the most numerous thing in the
 *  world, so it stays as cheap as it looks. */
function buildTuft(scene: Scene, name: string, colour: Color3, height: number): Mesh {
  const rgb = packed(colour);
  const h = Math.max(4, Math.round(height / VOXEL));
  const model = build(9, h, 7, (v) => {
    for (const [x, z, lean, scale] of [[0, 2, 1, 0.8], [3, 0, 0, 1], [6, 3, -1, 0.72]] as const) {
      const tall = Math.max(2, Math.round(h * scale));
      for (let y = 0; y < tall; y++) {
        v.fill(x + Math.round((y / tall) * lean * 2), y, z, 2, 1, 2, tint(rgb, y > tall * 0.6 ? 1.12 : 0.9));
      }
    }
  });
  return sceneryMesh(scene, name, model, VOXEL);
}

export class SceneryStreamer implements ChunkListener {
  private readonly pools: Record<PoolKind, InstancePool>;
  private readonly grassChunks = new Set<number>();
  private readonly loaded = new Set<number>();
  /** A circle no grass grows in — see `setClearing`. */
  private clearing: { x: number; z: number; radius: number } | undefined;
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
      birch: new InstancePool(buildBirch(scene)),
      dead: new InstancePool(buildDead(scene)),
      ...(Object.fromEntries(
        ([
          ["rockGrey", Color3.FromHexString(palette.edge).scale(1.15)],
          ["rockRed", Color3.FromHexString("#a8603c")],
          ["rockDark", Color3.FromHexString("#45403c")],
        ] as const).flatMap(([base, colour]) =>
          ROCK_SQUAT.map((squat, i) =>
            [`${base}${i}`, new InstancePool(buildRock(scene, `${base}${i}`, colour, squat))] as const),
        ),
      ) as Record<RockPool, InstancePool>),
      grass: new InstancePool(buildTuft(scene, "grass", grass.scale(0.9), 0.5)),
      dry: new InstancePool(buildTuft(scene, "dry", Color3.FromHexString("#c2ad62"), 0.55)),
      heather: new InstancePool(buildTuft(scene, "heather", Color3.FromHexString("#8a5a7a"), 0.35)),
      reeds: new InstancePool(buildTuft(scene, "reeds", Color3.FromHexString("#8a9a52"), 0.85)),
      ash: new InstancePool(buildTuft(scene, "ash", Color3.FromHexString("#6e6a62"), 0.4)),
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

    for (const kind of TREE_POOLS) {
      this.pools[kind].set(key, Float32Array.from(lists[kind] ?? []));
    }
  }

  onChunkUnloaded(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    this.loaded.delete(key);
    for (const pool of Object.values(this.pools)) pool.delete(key);
    this.grassChunks.delete(key);
  }

  /**
   * Keep grass out of a circle, or stop keeping it out.
   *
   * The character screen puts the camera low and close, where a tuft at your
   * feet stands in front of your legs like a hedge. Cutting the tufts nearest
   * you — and only those — keeps the meadow and clears the view. The chunks it
   * touches are regrown on the next `update`, which is the same path a chunk
   * coming into range takes.
   */
  setClearing(clearing: { x: number; z: number; radius: number } | undefined): void {
    const affected = [this.clearing, clearing];
    this.clearing = clearing;
    for (const circle of affected) {
      if (!circle) continue;
      for (const key of [...this.grassChunks]) {
        const { cx, cz } = unkey(key);
        const nearX = Math.max(cx * CHUNK, Math.min(circle.x, (cx + 1) * CHUNK));
        const nearZ = Math.max(cz * CHUNK, Math.min(circle.z, (cz + 1) * CHUNK));
        if (Math.hypot(nearX - circle.x, nearZ - circle.z) <= circle.radius) this.grassChunks.delete(key);
      }
    }
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
      for (const kind of GRASS_POOLS) this.pools[kind].delete(key);
    }

    for (const pool of Object.values(this.pools)) pool.flush();
  }

  private itemMatrix(item: SceneryItem): [PoolKind, Float32Array] {
    const y = heightAt(item.x, item.z, this.ostra.terrain);
    // Alternate shades by position, so a wood is not one flat green.
    const shade = (hash2(Math.floor(item.x * 10), Math.floor(item.z * 10), 5) & 1) === 0;
    let kind: PoolKind;
    if (item.kind === "rock") {
      // Which of the three squatnesses this stone is: its height over its
      // radius, which the generator rolls between 0.8 and 1.3.
      const ratio = item.height / item.radius;
      const band = ratio < 0.95 ? 0 : ratio < 1.15 ? 1 : 2;
      kind = ROCK_POOL[item.tint ?? "grey"][band]!;
      // Uniform, so the cells stay cubes. The template is a unit radius.
      this.scale.setAll(item.radius);
      this.position.set(item.x, y - item.height * 0.08, item.z);
    } else {
      const tree: TreePool = item.kind === "pine" ? (shade ? "pineDark" : "pineLight")
        : item.kind === "oak" ? (shade ? "oakDark" : "oakLight")
        : item.kind;
      kind = tree;
      // Uniform, from the trunk's collision radius: the drawn trunk is then
      // exactly the circle the server stops you against, and the height comes
      // out within a few percent because the generator rolls both from one
      // number. Sunk a little so the root never floats on a slope.
      this.scale.setAll(item.radius / TEMPLATE_TRUNK[tree]);
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
    const lists: Partial<Record<GrassPool, number[]>> = {};
    const out = new Float32Array(16);
    const lakes = ostra.terrain.lakes ?? [];
    const sea = ostra.terrain.sea;

    for (let n = 0; n < GRASS_PER_CHUNK; n++) {
      const h = hash2(cx * 131 + n, cz * 71 - n, 0x6a55);
      const x = (cx + (h & 0xffff) / 65536) * CHUNK;
      const z = (cz + (h >>> 16) / 65536) * CHUNK;
      if (x < -half || x > half || z < -half || z > half) continue;

      if (roadDistance(ostra, x, z) < 0.4) continue;
      if (settlements.some((s) => Math.hypot(x - s.x, z - s.z) < s.radius * 0.72)) continue;
      if (ostra.obstacles.some((o) => Math.hypot(x - o.x, z - o.z) < o.radius + 0.6)) continue;
      if (ostra.gates.some((g) => Math.hypot(x - g.x, z - g.z) < GATE_RADIUS + 1.2)) continue;
      const clearing = this.clearing;
      if (clearing && Math.hypot(x - clearing.x, z - clearing.z) < clearing.radius) continue;
      if (slopeAt(x, z, ostra.terrain) > 0.55) continue;
      const y = heightAt(x, z, ostra.terrain);
      if (y > snowLine) continue;

      // Under a dungeon's rock nothing much grows: a few grey tufts in the
      // dirt, and only a third as many.
      if (ostra.dungeon && n % 3 !== 0) continue;
      // Reeds at the water's edge, and in the shallows; nothing in the deep.
      let kind: GrassPool = ostra.dungeon ? "ash" : regionOf(ostra, x, z)?.grass ?? "grass";
      // Nothing on the sand, or under the sea.
      if (sea && y < sea.level + SAND_HEIGHT && seaRamp(sea, x, z, ostra.terrain.seed) > 0) continue;
      const lake = lakes.find((l) => Math.hypot(x - l.x, z - l.z) < lakeReach(l));
      if (lake) {
        const depth = lakeLevel(lake, ostra.terrain) - y;
        if (depth > 0.45) continue;
        if (depth > -0.7) kind = "reeds";
      }

      const isTall = (h & 7) === 0;
      const size = (0.8 + ((h >>> 8) & 255) / 640) * (isTall ? 1.6 : 1);
      this.scale.set(size, size, size);
      this.position.set(x, y - 0.02, z);
      Quaternion.RotationYawPitchRollToRef(((h >>> 4) & 1023) / 163, 0, 0, this.rotation);
      Matrix.ComposeToRef(this.scale, this.rotation, this.position, this.composed);
      this.composed.copyToArray(out);
      (lists[kind] ??= []).push(...out);
    }

    for (const kind of GRASS_POOLS) this.pools[kind].set(key, Float32Array.from(lists[kind] ?? []));
  }

  dispose(): void {
    for (const pool of Object.values(this.pools)) pool.dispose();
    this.loaded.clear();
    this.grassChunks.clear();
  }
}
