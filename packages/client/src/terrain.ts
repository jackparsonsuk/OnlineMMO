import { Color3 } from "@babylonjs/core/Maths/math.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import type { Scene } from "@babylonjs/core/scene.js";
import {
  fbm,
  forestAt,
  heightAt,
  lakeLevel,
  lakeReach,
  regionAt,
  roadDistance,
  SCENERY_CELL,
  settlementsIn,
  terrainRelief,
  type OstraDefinition,
} from "@mmo/shared";

/**
 * The ground you can see, built from the ground the simulation uses.
 *
 * Both come from `heightAt`, so what is drawn and what you walk on are the
 * same surface by construction — there is no heightmap to sample differently
 * on each side, and no chance of standing visibly inside a hill.
 *
 * Terra is eight kilometres across, far too much to build as one mesh at
 * walking detail. So the ground near you is streamed in 64 m chunks at 2 m per
 * quad, built nearest-first a couple per frame, and everything else is one
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

/** Detailed ground out to here. Fog is thick enough by this range that the
 *  swap to the horizon mesh is hard to spot. */
export const TERRAIN_RADIUS = 330;

/** How many chunks to build per frame. Each is a few milliseconds; more than
 *  two starts to show as a hitch when you sprint across a boundary. */
const BUILDS_PER_FRAME = 2;

/** Skirts hang this far below each chunk's edge, hiding the sliver of sky that
 *  would otherwise show where a detailed chunk meets the coarser horizon. */
const SKIRT_DEPTH = 6;

// --- colour ------------------------------------------------------------------

export interface GroundPalette {
  low: Color3;
  high: Color3;
  /** Per region, in the Ostra's region order. Empty without regions. */
  regionLow: Color3[];
  regionHigh: Color3[];
  lakebed: Color3;
  water: Color3;
  dry: Color3;
  rock: Color3;
  peak: Color3;
  dirt: Color3;
  relief: number;
  snowLine: number;
}

export function groundPalette(ostra: OstraDefinition): GroundPalette {
  const p = ostra.palette;
  const low = Color3.FromHexString(p.ground);
  const grid = Color3.FromHexString(p.grid);
  return {
    low,
    // Crests catch the light: the grid colour is the Ostra's brighter tone.
    high: Color3.Lerp(low, grid, 0.55),
    regionLow: ostra.regions.map((r) => Color3.FromHexString(r.ground)),
    regionHigh: ostra.regions.map((r) => Color3.Lerp(Color3.FromHexString(r.ground), Color3.FromHexString(r.crest), 0.6)),
    lakebed: Color3.FromHexString("#4a4a36"),
    water: Color3.FromHexString("#3f7ea6"),
    // Sun-bleached meadow, for variety across a big map.
    dry: Color3.Lerp(grid, Color3.FromHexString("#b5a55e"), 0.55),
    rock: Color3.FromHexString(p.edge),
    peak: Color3.FromHexString(p.peak ?? p.edge),
    dirt: Color3.Lerp(Color3.FromHexString("#8a7050"), low, 0.18),
    relief: Math.max(0.5, terrainRelief(ostra.terrain)),
    snowLine: ostra.terrain.mountains ? ostra.terrain.mountains.amplitude * 0.55 : Infinity,
  };
}

const scratch = new Color3();
const lowScratch = new Color3();
const highScratch = new Color3();

/**
 * The colour of the ground at a point. Shared by the 3D terrain and the map,
 * so the map looks like the place.
 *
 * Painted into vertex colours rather than a texture: each facet takes one flat
 * tone, which is exactly the look, and there is no image to load.
 */
export function groundTone(
  ostra: OstraDefinition,
  palette: GroundPalette,
  x: number,
  z: number,
  height: number,
  slope: number,
  out: Color3 = scratch,
  /** The map shows open water; the 3D ground shows the lakebed under the
   *  water mesh drawn on top of it. */
  asMap = false,
): Color3 {
  const lift = Math.min(1, Math.max(0, height / palette.relief * 0.5 + 0.5));
  let low = palette.low;
  let high = palette.high;
  if (palette.regionLow.length > 0) {
    // Blended across borders, so a region fades into the next.
    const r = regionAt(ostra.terrain, x, z);
    Color3.LerpToRef(palette.regionLow[r.secondary]!, palette.regionLow[r.primary]!, r.weight, lowScratch);
    Color3.LerpToRef(palette.regionHigh[r.secondary]!, palette.regionHigh[r.primary]!, r.weight, highScratch);
    low = lowScratch;
    high = highScratch;
  }
  Color3.LerpToRef(low, high, lift, out);

  if (ostra.wilds) {
    // Broad patches of drier grass, so a kilometre of meadow is not one green.
    const dryness = fbm(x / 520, z / 520, 7, 2);
    if (dryness > 0.1) Color3.LerpToRef(out, palette.dry, Math.min(0.35, (dryness - 0.1) * 1.2), out);
    // Darker under the trees: woods read from a distance, even on the horizon
    // mesh, which has no trees on it.
    const wooded = forestAt(ostra, x, z);
    if (wooded > 0.3) out.scaleToRef(1 - Math.min(0.28, (wooded - 0.3) * 0.45), out);
  }

  // Trodden earth in town yards.
  for (const settlement of settlementsIn(ostra)) {
    const d = Math.sqrt((x - settlement.x) ** 2 + (z - settlement.z) ** 2);
    if (d < settlement.radius * 0.8) Color3.LerpToRef(out, palette.dirt, 0.35, out);
  }

  // Where the ground is steep, soil gives way to stone.
  const bare = Math.min(1, Math.max(0, (slope - 0.35) / 0.45));
  if (bare > 0) Color3.LerpToRef(out, palette.rock, bare, out);

  // Snow on the peaks, unless it is too steep to hold.
  if (height > palette.snowLine) {
    const snow = Math.min(1, (height - palette.snowLine) / 12) * (1 - bare * 0.6);
    Color3.LerpToRef(out, palette.peak, snow, out);
  }

  // Roads over everything but water: a path should be visible in any region.
  const road = roadDistance(ostra, x, z);
  if (road < 1.2) Color3.LerpToRef(out, palette.dirt, road <= 0 ? 0.92 : 0.92 * (1 - road / 1.2), out);

  if (ostra.terrain.lakes) {
    for (const lake of ostra.terrain.lakes) {
      const reach = lakeReach(lake);
      const dx = x - lake.x;
      const dz = z - lake.z;
      if (dx * dx + dz * dz >= reach * reach) continue;
      const depth = lakeLevel(lake, ostra.terrain) - height;
      if (depth > -0.3) {
        const wet = Math.min(1, (depth + 0.3) / 0.5);
        Color3.LerpToRef(out, asMap ? palette.water : palette.lakebed, asMap ? wet : wet * 0.8, out);
      }
      break;
    }
  }

  return out;
}

// --- meshes ------------------------------------------------------------------

/**
 * Build flat-shaded triangles over a rectangular grid of samples.
 *
 * Written directly into typed arrays rather than via CreateGround and
 * convertToFlatShadedMesh: that route allocates several intermediate copies
 * per chunk, and chunks are built continually while you move.
 *
 * Each triangle gets its own three vertices, one normal and one colour (the
 * average of its corners), which is what makes the facets read.
 */
function gridMesh(
  name: string,
  scene: Scene,
  ostra: OstraDefinition,
  palette: GroundPalette,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  maxStep: number,
  skirt: boolean,
): Mesh {
  const nx = Math.max(1, Math.ceil((x1 - x0) / maxStep));
  const nz = Math.max(1, Math.ceil((z1 - z0) / maxStep));
  const sx = (x1 - x0) / nx;
  const sz = (z1 - z0) / nz;
  const t = ostra.terrain;

  // Heights with a one-sample border, so slope at the edge uses real
  // neighbours and adjacent chunks colour their shared edge identically.
  const w = nx + 3;
  const heights = new Float32Array(w * (nz + 3));
  for (let j = 0; j < nz + 3; j++) {
    for (let i = 0; i < w; i++) {
      heights[j * w + i] = heightAt(x0 + (i - 1) * sx, z0 + (j - 1) * sz, t);
    }
  }
  const h = (i: number, j: number): number => heights[(j + 1) * w + (i + 1)]!;

  // Corner colours.
  const cw = nx + 1;
  const colours = new Float32Array(cw * (nz + 1) * 3);
  const tone = new Color3();
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const here = h(i, j);
      const dx = (h(i + 1, j) - h(i - 1, j)) / (2 * sx);
      const dz = (h(i, j + 1) - h(i, j - 1)) / (2 * sz);
      const slope = Math.min(1, Math.sqrt(dx * dx + dz * dz));
      groundTone(ostra, palette, x0 + i * sx, z0 + j * sz, here, slope, tone);
      const k = (j * cw + i) * 3;
      colours[k] = tone.r;
      colours[k + 1] = tone.g;
      colours[k + 2] = tone.b;
    }
  }

  const skirtTris = skirt ? (nx + nz) * 4 : 0;
  const triangles = nx * nz * 2 + skirtTris;
  const positions = new Float32Array(triangles * 9);
  const normals = new Float32Array(triangles * 9);
  const vertexColours = new Float32Array(triangles * 12);
  let v = 0;

  // Positions are local to the mesh's origin (x0, z0): smaller numbers, so the
  // GPU's float32 has precision to spare four kilometres out.
  const tri = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    r: number, g: number, b: number,
  ): void => {
    // Outward face normal for Babylon's front-face winding: (c - a) x (b - a).
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const wx = cx - ax, wy = cy - ay, wz = cz - az;
    let nxv = wy * uz - wz * uy;
    let nyv = wz * ux - wx * uz;
    let nzv = wx * uy - wy * ux;
    const len = Math.sqrt(nxv * nxv + nyv * nyv + nzv * nzv) || 1;
    nxv /= len; nyv /= len; nzv /= len;
    const verts = [ax, ay, az, bx, by, bz, cx, cy, cz];
    for (let k = 0; k < 3; k++) {
      positions[v * 3] = verts[k * 3]!;
      positions[v * 3 + 1] = verts[k * 3 + 1]!;
      positions[v * 3 + 2] = verts[k * 3 + 2]!;
      normals[v * 3] = nxv;
      normals[v * 3 + 1] = nyv;
      normals[v * 3 + 2] = nzv;
      vertexColours[v * 4] = r;
      vertexColours[v * 4 + 1] = g;
      vertexColours[v * 4 + 2] = b;
      vertexColours[v * 4 + 3] = 1;
      v++;
    }
  };

  const colourAt = (i: number, j: number, channel: number): number => colours[(j * cw + i) * 3 + channel]!;

  /** One triangle between three grid corners, coloured by their average. */
  const face = (ai: number, aj: number, bi: number, bj: number, ci: number, cj: number): void => {
    tri(
      ai * sx, h(ai, aj), aj * sz,
      bi * sx, h(bi, bj), bj * sz,
      ci * sx, h(ci, cj), cj * sz,
      (colourAt(ai, aj, 0) + colourAt(bi, bj, 0) + colourAt(ci, cj, 0)) / 3,
      (colourAt(ai, aj, 1) + colourAt(bi, bj, 1) + colourAt(ci, cj, 1)) / 3,
      (colourAt(ai, aj, 2) + colourAt(bi, bj, 2) + colourAt(ci, cj, 2)) / 3,
    );
  };

  // Quad (i, j) is always triangles 2q and 2q+1 for q = j * nx + i — the
  // horizon relies on that to cut quads out by index.
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      // Alternate the diagonal so the facets don't all lean one way. Corner
      // order is Babylon's front-face winding, matching CreateGround's.
      if (((i + j) & 1) === 0) {
        face(i, j, i + 1, j, i, j + 1);
        face(i + 1, j, i + 1, j + 1, i, j + 1);
      } else {
        face(i, j, i + 1, j + 1, i, j + 1);
        face(i, j, i + 1, j, i + 1, j + 1);
      }
    }
  }

  if (skirt) {
    // A curtain along each edge, coloured like the ground above it.
    const curtain = (ia: number, ja: number, ib: number, jb: number): void => {
      const ax = ia * sx, az = ja * sz, bx = ib * sx, bz = jb * sz;
      const ha = h(ia, ja), hb = h(ib, jb);
      const r = colourAt(ia, ja, 0) * 0.8, g = colourAt(ia, ja, 1) * 0.8, b = colourAt(ia, ja, 2) * 0.8;
      // Wound to face out of the chunk, where the gap it hides would be.
      tri(ax, ha, az, ax, ha - SKIRT_DEPTH, az, bx, hb, bz, r, g, b);
      tri(bx, hb, bz, ax, ha - SKIRT_DEPTH, az, bx, hb - SKIRT_DEPTH, bz, r, g, b);
    };
    for (let i = 0; i < nx; i++) {
      curtain(i, 0, i + 1, 0);
      curtain(i + 1, nz, i, nz);
    }
    for (let j = 0; j < nz; j++) {
      curtain(nx, j, nx, j + 1);
      curtain(0, j + 1, 0, j);
    }
  }

  const mesh = new Mesh(name, scene);
  const data = new VertexData();
  data.positions = positions;
  data.normals = normals;
  data.colors = vertexColours;
  const indices = new Uint32Array(triangles * 3);
  for (let k = 0; k < indices.length; k++) indices[k] = k;
  data.indices = indices;
  data.applyToMesh(mesh, false);
  mesh.position.set(x0, 0, z0);
  mesh.useVertexColors = true;
  return mesh;
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
  private lastCentre = "";
  private wanted: Array<{ cx: number; cz: number; d: number }> = [];

  constructor(
    private readonly scene: Scene,
    private readonly ostra: OstraDefinition,
    private readonly listener: ChunkListener,
  ) {
    this.palette = groundPalette(ostra);
    this.material = new StandardMaterial("terrainMaterial", scene);
    this.material.diffuseColor = Color3.White();
    this.material.specularColor = Color3.Black();

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
    const mesh = gridMesh("horizon", this.scene, this.ostra, this.palette, lo, lo, hi, hi, CHUNK, false);
    mesh.material = this.material;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    this.horizon = mesh;
    this.horizonCols = (hi - lo) / CHUNK;
    const all = mesh.getIndices();
    this.horizonQuads = all ? Uint32Array.from(all) : undefined;
  }

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
          if (!this.chunks.has(key)) this.wanted.push({ cx, cz, d });
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

    for (let built = 0; built < BUILDS_PER_FRAME && this.wanted.length > 0; built++) {
      const next = this.wanted.shift()!;
      this.buildChunk(next.cx, next.cz);
    }

    if (this.horizonDirty) this.cutHorizon();
  }

  /** Force everything near (x, z) to exist now — on arrival, so you never
   *  see the ground assemble under your feet. */
  prime(x: number, z: number, radius: number): void {
    this.update(x, z);
    const keep: typeof this.wanted = [];
    for (const next of this.wanted) {
      if (next.d <= radius) this.buildChunk(next.cx, next.cz);
      else keep.push(next);
    }
    this.wanted = keep;
    if (this.horizonDirty) this.cutHorizon();
  }

  private buildChunk(cx: number, cz: number): void {
    const half = this.ostra.size / 2;
    const x0 = Math.max(-half, cx * CHUNK);
    const z0 = Math.max(-half, cz * CHUNK);
    const x1 = Math.min(half, (cx + 1) * CHUNK);
    const z1 = Math.min(half, (cz + 1) * CHUNK);
    const mesh = gridMesh(`chunk:${cx}:${cz}`, this.scene, this.ostra, this.palette, x0, z0, x1, z1, QUAD, true);
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
    const kept: number[] = [];
    const cols = this.horizonCols;
    for (let q = 0; q < cols * cols; q++) {
      const cx = (q % cols) + offset;
      const cz = Math.floor(q / cols) + offset;
      if (this.chunks.has(chunkKey(cx, cz))) continue;
      for (let k = 0; k < 6; k++) kept.push(quads[q * 6 + k]!);
    }
    horizon.setIndices(kept);
  }

  /** Is the detailed ground at (x, z) built yet? */
  isLoaded(x: number, z: number): boolean {
    return this.chunks.has(chunkKey(Math.floor(x / CHUNK), Math.floor(z / CHUNK)));
  }

  dispose(): void {
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
