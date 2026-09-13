import { Color3 } from "@babylonjs/core/Maths/math.js";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { hash2, SCENERY_CELL, type OstraDefinition } from "@mmo/shared";
import { GRAIN_TILE, gridData, groundPalette, type GridData, type GroundPalette } from "./groundData.js";

// The map paints from the same tones; it imports them from here.
export { groundPalette, groundTone, type GroundPalette } from "./groundData.js";

/**
 * The ground you can see, built from the ground the simulation uses.
 *
 * Both come from `heightAt`, so what is drawn and what you walk on are the
 * same surface by construction — there is no heightmap to sample differently
 * on each side, and no chance of standing visibly inside a hill.
 *
 * Terra is eight kilometres across, far too much to build as one mesh at
 * walking detail. So the ground near you is streamed in 64 m chunks at 2 m per
 * quad, worked out nearest-first on background workers and turned into meshes
 * a few per frame, and everything else is one
 * coarse mesh of the whole Ostra at 64 m per quad — the horizon, which is what
 * lets you see a mountain range four kilometres away and walk to it. Where a
 * detailed chunk is loaded, the horizon's matching quad is cut out, so the two
 * never fight over the same pixels.
 */

/** Detailed chunks, and the quads of the horizon mesh, are this wide. The same
 *  as a scenery cell, so a chunk and the trees on it load together. */
export const CHUNK = SCENERY_CELL;

/** Metres per quad up close. Two is chunky enough to read as facets rather
 *  than as a failed attempt at smooth. */
const QUAD = 2;

/**
 * Metres per quad on the horizon, which must divide CHUNK. It was a whole
 * chunk, 64 m, when the far country was low hills; with mountains four
 * hundred metres tall that cut every ridge into a few flat slabs, and the
 * skyline is most of what a mountain range is.
 */
const HORIZON_QUAD = 32;

/** Detailed ground out to here. Fog is thick enough by this range that the
 *  swap to the horizon mesh is hard to spot. */
export const TERRAIN_RADIUS = 330;

/**
 * How long turning finished chunks into meshes may take out of one frame, in
 * ms. At least one is always placed while any are ready.
 *
 * A chunk used to be built whole on the main thread, two a frame: twelve
 * hundred height samples and a ground tone for every corner, 15-20 ms each,
 * so every frame of the first few seconds in a new place ran at 30-45 ms.
 * The samples and tones are now worked out on workers (`chunkWorker.ts`), and
 * all that is left here is handing their arrays to the GPU and placing the
 * chunk's trees — a few milliseconds.
 */
const BUILD_BUDGET_MS = 6;

/** Chunks asked of the workers at once. Enough to keep both busy; few enough
 *  that walking away does not leave a queue of ground nobody will see. */
const MAX_IN_FLIGHT = 6;

/** The horizon is re-cut at most this often while chunks stream in, and at
 *  once when the last of them is placed. Cutting it rewrote an index buffer
 *  across the whole Ostra after every chunk. */
const HORIZON_CUT_MS = 250;

// --- workers --------------------------------------------------------------------

interface ChunkJob { id: number; ostra: string; x0: number; z0: number; x1: number; z1: number; step: number; skirt: boolean }

/**
 * Two workers for the whole session, shared by every streamer: each one routes
 * the roads once when it starts (the ground carves valleys along them), so
 * starting them again at every Gate would pay that again. If workers cannot be
 * made at all, chunks are built on the main thread as they always were.
 */
let workers: Worker[] | undefined | null;
let nextJob = 1;
const jobs = new Map<number, (data: GridData) => void>();

function chunkWorkers(): Worker[] | null {
  if (workers !== undefined) return workers;
  try {
    workers = [0, 1].map(() => {
      const worker = new Worker(new URL("./chunkWorker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<{ id: number; data: GridData }>) => {
        const done = jobs.get(event.data.id);
        jobs.delete(event.data.id);
        done?.(event.data.data);
      };
      return worker;
    });
  } catch {
    workers = null;
  }
  return workers;
}

/** A finished grid, as a mesh. */
function meshFromGrid(name: string, scene: Scene, grid: GridData): Mesh {
  const mesh = new Mesh(name, scene);
  const data = new VertexData();
  data.positions = grid.positions;
  data.normals = grid.normals;
  data.colors = grid.colours;
  data.uvs = grid.uvs;
  const indices = new Uint32Array(grid.positions.length / 3);
  for (let k = 0; k < indices.length; k++) indices[k] = k;
  data.indices = indices;
  data.applyToMesh(mesh, false);
  mesh.position.set(grid.x0, 0, grid.z0);
  mesh.useVertexColors = true;
  return mesh;
}


// --- grain --------------------------------------------------------------------

/** Texels per metre in it. */
const GRAIN_PX = 64;

/**
 * The ground's grain: cells, generated at runtime.
 *
 * Everything else in the world is voxels now, and the ground was the one
 * surface left reading as a smooth wash between two-metre facets. It cannot be
 * voxels itself — the height is a pure function the server also walks on, and
 * quantising it would put what you see and what you collide with a step apart
 * — so instead the *colour* is celled, and the geometry is left alone.
 *
 * Two scales, both aligned to the world rather than to the mesh, so the cells
 * do not swim when a chunk streams in and do not break at a chunk edge:
 * half-metre patches you can read as ground, and eighth-metre grain inside
 * them matching the scenery. Nothing is loaded — it is drawn into a canvas
 * from the same `hash2` the rest of the world is built with, so it is the same
 * ground on every machine.
 *
 * The texture only multiplies, so it can only darken; the mean it comes out at
 * is handed back for the material to divide out, or every field in the game
 * would go dim.
 */
function groundGrain(scene: Scene): { texture: DynamicTexture; mean: number } {
  const size = GRAIN_TILE * GRAIN_PX;
  const texture = new DynamicTexture("groundGrain", { width: size, height: size }, scene, true);
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;

  const context = texture.getContext() as unknown as CanvasRenderingContext2D;
  const image = context.createImageData(size, size);
  const data = image.data;

  const coarse = Math.round(GRAIN_PX * 0.5);
  const fine = Math.round(GRAIN_PX / 8);
  const cells = size / coarse;
  const grains = size / fine;
  let total = 0;

  for (let y = 0; y < size; y++) {
    // Wrapped cell indices, so the tile joins itself seamlessly.
    const cy = Math.floor(y / coarse) % cells;
    const fy = Math.floor(y / fine) % grains;
    for (let x = 0; x < size; x++) {
      const cx = Math.floor(x / coarse) % cells;
      const fx = Math.floor(x / fine) % grains;
      const patch = hash2(cx, cy, 0x9e37) / 4294967296;
      const grain = hash2(fx, fy, 0x85eb) / 4294967296;
      let value = 0.88 + (patch - 0.5) * 0.15 + (grain - 0.5) * 0.1;
      // One patch in thirty is a stone or a scrape of bare earth. It is the
      // thing that stops a meadow reading as graph paper.
      if ((hash2(cx, cy, 0x2f1d) & 63) < 2) value *= 0.8;
      value = Math.max(0, Math.min(1, value));
      total += value;
      // A grey multiplier can only ever darken; letting the channels drift
      // apart lets a patch go warmer or cooler as well, which is the
      // difference between grass that is dry in places and grass that is
      // merely dim in places. Small, because it has to sit under every
      // palette in the game without arguing with any of them.
      const warm = (hash2(cx, cy, 0x77a1) / 4294967296 - 0.5) * 0.1;
      const k = (y * size + x) * 4;
      data[k] = Math.round(Math.min(1, value * (1 + warm)) * 255);
      data[k + 1] = Math.round(Math.min(1, value * (1 + warm * 0.3)) * 255);
      data[k + 2] = Math.round(Math.min(1, value * (1 - warm)) * 255);
      data[k + 3] = 255;
    }
  }

  context.putImageData(image, 0, 0);
  texture.update(false);
  return { texture, mean: total / (size * size) };
}


// --- the streamer ----------------------------------------------------------------

export interface ChunkListener {
  /** A detailed chunk has been built; populate it. */
  onChunkLoaded(cx: number, cz: number): void;
  onChunkUnloaded(cx: number, cz: number): void;
}

export class TerrainStreamer {
  private readonly chunks = new Map<number, Mesh>();
  private readonly material: StandardMaterial;
  private readonly palette: GroundPalette;
  private horizon: Mesh | undefined;
  /** Per horizon quad: the six vertex indices of its two triangles. */
  private horizonQuads: Uint32Array | undefined;
  private horizonCols = 0;
  /** Chunk index of the horizon's first column and row. */
  private horizonOrigin = 0;
  private horizonDirty = false;
  /** Scratch for every cut, sized once. */
  private keptIndices: Uint32Array | undefined;
  private lastCentre = "";
  private wanted: Array<{ cx: number; cz: number; d: number }> = [];

  constructor(
    private readonly scene: Scene,
    private readonly ostra: OstraDefinition,
    private readonly listener: ChunkListener,
  ) {
    this.palette = groundPalette(ostra);
    this.material = new StandardMaterial("terrainMaterial", scene);
    this.material.specularColor = Color3.Black();
    const grain = groundGrain(scene);
    this.material.diffuseTexture = grain.texture;
    // The texture can only darken, so the mean it came out at is divided back
    // out here. Anything else and every field in the game loses a tenth of its
    // light the moment the grain is switched on.
    this.material.diffuseColor = new Color3(1, 1, 1).scaleInPlace(1 / grain.mean);

    // Only worth it where the Ostra is much bigger than the detailed radius.
    if (ostra.size > TERRAIN_RADIUS * 2.5) this.buildHorizon();
  }

  /**
   * The whole Ostra, coarse. Built once per arrival.
   *
   * Snapped outward to whole chunks, so each quad covers exactly one chunk and
   * can be cut out when that chunk loads. Terra's 4000 m half-width is not a
   * multiple of 64; unsnapped, every quad would straddle two chunks.
   */
  private buildHorizon(): void {
    const half = this.ostra.size / 2;
    this.horizonOrigin = Math.floor(-half / CHUNK);
    const lo = this.horizonOrigin * CHUNK;
    const hi = Math.ceil(half / CHUNK) * CHUNK;
    const started = performance.now();
    const mesh = meshFromGrid("horizon", this.scene, gridData(this.ostra, this.palette, lo, lo, hi, hi, HORIZON_QUAD, false));
    this.horizonBuildMs = performance.now() - started;
    mesh.material = this.material;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    this.horizon = mesh;
    this.horizonCols = (hi - lo) / HORIZON_QUAD;
    const all = mesh.getIndices();
    this.horizonQuads = all ? Uint32Array.from(all) : undefined;
  }

  /** How long the horizon took to build on arrival, for the console. */
  horizonBuildMs = 0;

  /** Call every frame with where the camera is looking. */
  update(x: number, z: number): void {
    const ccx = Math.floor(x / CHUNK);
    const ccz = Math.floor(z / CHUNK);
    const centre = `${ccx},${ccz}`;

    if (centre !== this.lastCentre) {
      this.lastCentre = centre;
      const reach = Math.ceil(TERRAIN_RADIUS / CHUNK) + 1;
      const half = this.ostra.size / 2;
      const needed = new Set<number>();
      this.needed = needed;
      this.wanted = [];

      for (let cz = ccz - reach; cz <= ccz + reach; cz++) {
        for (let cx = ccx - reach; cx <= ccx + reach; cx++) {
          // Outside the Ostra entirely.
          if ((cx + 1) * CHUNK <= -half || cx * CHUNK >= half) continue;
          if ((cz + 1) * CHUNK <= -half || cz * CHUNK >= half) continue;
          const mx = (cx + 0.5) * CHUNK - x;
          const mz = (cz + 0.5) * CHUNK - z;
          const d = Math.sqrt(mx * mx + mz * mz);
          if (d > TERRAIN_RADIUS + CHUNK * 0.75) continue;
          const key = chunkKey(cx, cz);
          needed.add(key);
          if (!this.chunks.has(key) && !this.pending.has(key)) this.wanted.push({ cx, cz, d });
        }
      }
      // Nearest first: the ground under your feet before the far hills.
      this.wanted.sort((a, b) => a.d - b.d);

      for (const [key, mesh] of this.chunks) {
        if (needed.has(key)) continue;
        mesh.dispose();
        this.chunks.delete(key);
        const { cx, cz } = unkey(key);
        this.listener.onChunkUnloaded(cx, cz);
        this.horizonDirty = true;
      }
    }

    const start = performance.now();
    const pool = chunkWorkers();
    if (!pool) {
      // No workers: build here, one a frame at least, within the budget.
      while (this.wanted.length > 0) {
        const next = this.wanted.shift()!;
        this.place(next.cx, next.cz, this.buildNow(next.cx, next.cz));
        if (performance.now() - start > BUILD_BUDGET_MS) break;
      }
    } else {
      // Ask the workers for the nearest chunks not yet asked for...
      while (this.wanted.length > 0 && this.pending.size < MAX_IN_FLIGHT) {
        const next = this.wanted.shift()!;
        const key = chunkKey(next.cx, next.cz);
        this.pending.add(key);
        const id = nextJob++;
        const bounds = this.bounds(next.cx, next.cz);
        jobs.set(id, (data) => {
          this.pending.delete(key);
          // Walked away, or left the Ostra, while it was being worked out.
          if (this.disposed || !this.needed.has(key) || this.chunks.has(key)) return;
          this.ready.push({ cx: next.cx, cz: next.cz, data });
        });
        const job: ChunkJob = { id, ostra: this.ostra.id, ...bounds, step: QUAD, skirt: true };
        pool[id % pool.length]!.postMessage(job);
      }
      // ...and place what has come back, within the budget.
      while (this.ready.length > 0) {
        const done = this.ready.shift()!;
        if (!this.needed.has(chunkKey(done.cx, done.cz))) continue;
        this.place(done.cx, done.cz, done.data);
        if (performance.now() - start > BUILD_BUDGET_MS) break;
      }
    }

    const settled = this.wanted.length === 0 && this.pending.size === 0 && this.ready.length === 0;
    if (this.horizonDirty && (settled || start - this.lastCut > HORIZON_CUT_MS)) {
      this.lastCut = start;
      this.cutHorizon();
    }
  }

  private lastCut = 0;
  /** Chunks within range of the last centre. */
  private needed = new Set<number>();
  /** Asked of a worker and not yet back. */
  private readonly pending = new Set<number>();
  /** Back from a worker, waiting for a frame with room to place them. */
  private ready: Array<{ cx: number; cz: number; data: GridData }> = [];
  private disposed = false;

  /** Force everything near (x, z) to exist now — on arrival, so you never
   *  see the ground assemble under your feet. */
  prime(x: number, z: number, radius: number): void {
    this.update(x, z);
    const keep: typeof this.wanted = [];
    for (const next of this.wanted) {
      if (next.d <= radius) this.place(next.cx, next.cz, this.buildNow(next.cx, next.cz));
      else keep.push(next);
    }
    this.wanted = keep;
    if (this.horizonDirty) this.cutHorizon();
  }

  private bounds(cx: number, cz: number): { x0: number; z0: number; x1: number; z1: number } {
    const half = this.ostra.size / 2;
    return {
      x0: Math.max(-half, cx * CHUNK),
      z0: Math.max(-half, cz * CHUNK),
      x1: Math.min(half, (cx + 1) * CHUNK),
      z1: Math.min(half, (cz + 1) * CHUNK),
    };
  }

  /** A chunk's grid, worked out here and now. */
  private buildNow(cx: number, cz: number): GridData {
    const { x0, z0, x1, z1 } = this.bounds(cx, cz);
    return gridData(this.ostra, this.palette, x0, z0, x1, z1, QUAD, true);
  }

  private place(cx: number, cz: number, grid: GridData): void {
    const mesh = meshFromGrid(`chunk:${cx}:${cz}`, this.scene, grid);
    mesh.material = this.material;
    // Camera collision uses the height function directly, not picking.
    mesh.isPickable = false;
    mesh.freezeWorldMatrix();
    this.chunks.set(chunkKey(cx, cz), mesh);
    this.listener.onChunkLoaded(cx, cz);
    this.horizonDirty = true;
  }

  /** Drop the horizon's quads wherever a detailed chunk now stands. */
  private cutHorizon(): void {
    this.horizonDirty = false;
    const horizon = this.horizon;
    const quads = this.horizonQuads;
    if (!horizon || !quads) return;

    const offset = this.horizonOrigin;
    const cols = this.horizonCols;
    // Several horizon quads to a chunk's side; a quad goes with the chunk it
    // lies in.
    const perChunk = CHUNK / HORIZON_QUAD;
    const kept = this.keptIndices ??= new Uint32Array(quads.length);
    let n = 0;
    for (let q = 0; q < cols * cols; q++) {
      const cx = Math.floor((q % cols) / perChunk) + offset;
      const cz = Math.floor(Math.floor(q / cols) / perChunk) + offset;
      if (this.chunks.has(chunkKey(cx, cz))) continue;
      for (let k = 0; k < 6; k++) kept[n++] = quads[q * 6 + k]!;
    }
    // A copy: the geometry keeps the array it is given, and this buffer is
    // written over by the next cut.
    horizon.setIndices(kept.slice(0, n));
  }

  /** Is the detailed ground at (x, z) built yet? */
  isLoaded(x: number, z: number): boolean {
    return this.chunks.has(chunkKey(Math.floor(x / CHUNK), Math.floor(z / CHUNK)));
  }

  dispose(): void {
    this.disposed = true;
    this.ready = [];
    for (const [key, mesh] of this.chunks) {
      mesh.dispose();
      const { cx, cz } = unkey(key);
      this.listener.onChunkUnloaded(cx, cz);
    }
    this.chunks.clear();
    this.horizon?.dispose();
    this.material.dispose();
  }
}

export function chunkKey(cx: number, cz: number): number {
  return (cx + 32768) * 65536 + (cz + 32768);
}

export function unkey(key: number): { cx: number; cz: number } {
  return { cx: Math.floor(key / 65536) - 32768, cz: (key % 65536) - 32768 };
}
