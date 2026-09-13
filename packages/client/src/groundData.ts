import { Color3 } from "@babylonjs/core/Maths/math.js";
import {
  fbm,
  forestAt,
  lakeLevel,
  lakeReach,
  heightAt,
  MAX_WADE_DEPTH,
  regionAt,
  roadDistance,
  SAND_HEIGHT,
  seaRamp,
  settlementsIn,
  terrainRelief,
  type OstraDefinition,
} from "@mmo/shared";

/**
 * The ground's colour and a chunk's geometry, as plain arrays.
 *
 * Apart from the rest of `terrain.ts` because it has to run in a worker
 * (`chunkWorker.ts`): building a chunk is 15-20 ms of height samples and
 * ground tones, and on the main thread that was every frame of the first few
 * seconds in a new place. Nothing here touches a scene, a mesh or the page —
 * only `@mmo/shared` and Babylon's colour maths.
 */

/** Skirts hang this far below each chunk's edge, hiding the sliver of sky that
 *  would otherwise show where a detailed chunk meets the coarser horizon. */
const SKIRT_DEPTH = 6;

/** Metres across one repeat of the ground grain. */
export const GRAIN_TILE = 8;

// --- colour ------------------------------------------------------------------

export interface GroundPalette {
  low: Color3;
  high: Color3;
  /** Per region, in the Ostra's region order. Empty without regions. */
  regionLow: Color3[];
  regionHigh: Color3[];
  lakebed: Color3;
  water: Color3;
  /** Beach, and the seabed under the shallows. */
  sand: Color3;
  /** Open sea, on the map. */
  deepWater: Color3;
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
    // A dungeon's floor is earth, whatever colour its Gate glows.
    high: ostra.dungeon ? low.scale(1.3) : Color3.Lerp(low, grid, 0.55),
    regionLow: ostra.regions.map((r) => Color3.FromHexString(r.ground)),
    regionHigh: ostra.regions.map((r) => Color3.Lerp(Color3.FromHexString(r.ground), Color3.FromHexString(r.crest), 0.6)),
    lakebed: Color3.FromHexString("#4a4a36"),
    water: Color3.FromHexString("#3f7ea6"),
    sand: Color3.FromHexString("#cbb98c"),
    deepWater: Color3.FromHexString("#28577c"),
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
  // A dungeon's rock, so the map draws its rooms rather than a field. (The
  // 3D ground under the rock is never seen.)
  const walls = ostra.dungeon?.walls;
  if (walls?.some((w) => Math.abs(x - w.x) <= w.width / 2 && Math.abs(z - w.z) <= w.depth / 2)) {
    return out.copyFrom(palette.rock).scaleInPlace(0.45);
  }
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
    // Clumps a few metres across, between the kilometre-wide dry patches above
    // and the half-metre cells of the grain below — the scale a hillside is
    // actually uneven at. Not on the map, which is a kilometre to the inch and
    // would only look noisy for it.
    if (!asMap) out.scaleToRef(1 + fbm(x / 26, z / 26, 11, 2) * 0.085, out);
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

  const sea = ostra.terrain.sea;
  if (sea && seaRamp(sea, x, z, ostra.terrain.seed) > 0) {
    const above = height - sea.level;
    if (asMap && above < 0) {
      // The shallows you can wade pale, the open sea dark, so the map says
      // where the shore can be walked.
      Color3.LerpToRef(palette.water, palette.deepWater, Math.min(1, -above / (MAX_WADE_DEPTH * 3)), out);
    } else if (above < SAND_HEIGHT) {
      // Sand up the last metre and a half, faded in over its top half-metre;
      // under the water it darkens with depth, which is most of what makes
      // the water mesh on top read as shallow or deep.
      Color3.LerpToRef(out, palette.sand, Math.min(1, (SAND_HEIGHT - above) / 0.5), out);
      if (above < 0) out.scaleToRef(Math.max(0.45, 1 + above * 0.12), out);
    }
  }

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

// --- geometry ----------------------------------------------------------------

/**
 * Flat-shaded triangles over a rectangular grid of samples, as arrays for
 * `meshFromGrid` in `terrain.ts`.
 *
 * Written directly into typed arrays rather than via CreateGround and
 * convertToFlatShadedMesh: that route allocates several intermediate copies
 * per chunk, and chunks are built continually while you move.
 *
 * Each triangle gets its own three vertices, one normal and one colour (the
 * average of its corners), which is what makes the facets read.
 */
export interface GridData {
  /** The mesh's origin: positions are local to it. */
  x0: number;
  z0: number;
  positions: Float32Array;
  normals: Float32Array;
  colours: Float32Array;
  uvs: Float32Array;
}

export function gridData(
  ostra: OstraDefinition,
  palette: GroundPalette,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  maxStep: number,
  skirt: boolean,
): GridData {
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
  // In world metres over the grain's tile, not in the mesh's own space: the
  // pattern then belongs to the ground rather than to the chunk, and two
  // chunks meeting have no seam between them.
  const uvs = new Float32Array(triangles * 6);
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
      uvs[v * 2] = (x0 + verts[k * 3]!) / GRAIN_TILE;
      uvs[v * 2 + 1] = (z0 + verts[k * 3 + 2]!) / GRAIN_TILE;
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

  return { x0, z0, positions, normals, colours: vertexColours, uvs };
}
