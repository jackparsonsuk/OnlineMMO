import { GATE_RADIUS } from "./constants.js";
import {
  getArchetype,
  MAX_ENEMY_LEVEL,
  type EnemyKind,
} from "./enemies.js";
import type { BoxCollider, Collider, SceneryIndex } from "./movement.js";
import { fbm, gradientNoise, hash2, hashUnit, rehash, smoothstep } from "./noise.js";
import {
  OSTRAS,
  settlementsIn,
  waystoneArrival,
  type OstraDefinition,
  type OstraId,
  type RegionDefinition,
  type RoadDefinition,
  type RuinDefinition,
} from "./ostras.js";
import { heightAt, lakeLevel, lakeReach, regionAt, waterDepthAt } from "./terrain.js";

/**
 * Everything on a big Ostra that nobody placed by hand.
 *
 * Eight kilometres of Terra is tens of thousands of trees, hundreds of creature
 * camps and a network of roads. None of it is stored or sent: it is all a pure
 * function of the Ostra's data, evaluated lazily wherever someone is standing.
 * The server asks for colliders; the client asks for the same cells to draw
 * them. Because `noise.ts` is bit-identical everywhere and nothing here uses
 * Math.random or a trig function, the tree you see is the tree you hit.
 *
 * The rules that place things are mostly rules about where NOT to: nothing on
 * a road or in a lake, nothing in a town, no camp where you might wake up.
 */

/** Scenery is generated and bucketed in squares this wide. Must exceed the
 *  biggest collider radius plus the biggest body radius — it does, by a lot. */
export const SCENERY_CELL = 64;

/** Plots per cell side: one candidate tree or rock per 8 m square. */
const PLOTS = 8;
const PLOT = SCENERY_CELL / PLOTS;

export type SceneryKind = "pine" | "oak" | "birch" | "dead" | "rock";

export interface SceneryItem {
  kind: SceneryKind;
  /** Rocks only: which region's stone. */
  tint?: RegionDefinition["rock"];
  x: number;
  z: number;
  /** Collision radius — the trunk for a tree, the whole stone for a rock. */
  radius: number;
  height: number;
  yaw: number;
}

export interface SceneryCell {
  /** Generated things to draw. Hand-placed scenery is drawn by its owner. */
  items: readonly SceneryItem[];
  /** Everything solid in the cell, generated or not. */
  colliders: readonly Collider[];
}

export interface CampDefinition {
  id: string;
  kind: EnemyKind;
  count: number;
  x: number;
  z: number;
  radius: number;
  level: number;
}

/** Straight-line distance. Written out rather than `Math.hypot` or `**`,
 *  neither of which is required to round identically in every engine. */
function dist(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
}

function cellKey(cx: number, cz: number): number {
  return (cx + 32768) * 65536 + (cz + 32768);
}

// --- regions -------------------------------------------------------------------

/** The region a point belongs to, or undefined on an Ostra without them. */
export function regionOf(ostra: OstraDefinition, x: number, z: number): RegionDefinition | undefined {
  if (ostra.regions.length === 0) return undefined;
  return ostra.regions[regionAt(ostra.terrain, x, z).primary];
}

// --- roads ---------------------------------------------------------------------

/** Roads are routed over a grid this fine. Coarse enough to be quick, fine
 *  enough to thread a valley. */
const ROUTE_CELL = 32;
/** After routing, how far the drawn line wanders either side, and over what
 *  length. The route already bends around the land; this is the wobble of
 *  feet on top of it. */
const ROAD_MEANDER = 16;
const ROAD_MEANDER_WAVELENGTH = 260;

interface RouteGrid {
  n: number;
  origin: number;
  heights: Float32Array;
  /** Broad "bad going" — scrub, bog, broken ground — that a road swings
   *  round. Invisible; it exists so that across gentle country, where the
   *  slopes give a route nothing to avoid, roads still sweep and bend rather
   *  than run ruler-straight between stones. */
  rough: Float32Array;
  /** 1 where standing water, 0 dry, 2 not yet computed. */
  wet: Uint8Array;
  /** 1 where an earlier road already runs. */
  road: Uint8Array;
}

function makeRouteGrid(ostra: OstraDefinition): RouteGrid {
  const n = Math.floor(ostra.size / ROUTE_CELL) + 1;
  const heights = new Float32Array(n * n).fill(NaN);
  const rough = new Float32Array(n * n).fill(NaN);
  const wet = new Uint8Array(n * n).fill(2);
  return { n, origin: -ostra.size / 2, heights, rough, wet, road: new Uint8Array(n * n) };
}

function gridRough(ostra: OstraDefinition, grid: RouteGrid, i: number, j: number): number {
  const k = j * grid.n + i;
  let r = grid.rough[k]!;
  if (r !== r) {
    const x = grid.origin + i * ROUTE_CELL;
    const z = grid.origin + j * ROUTE_CELL;
    r = 2.2 * smoothstep((fbm(x / 520, z / 520, (ostra.wilds?.seed ?? 0) + 83, 2) + 0.05) / 0.35);
    grid.rough[k] = r;
  }
  return r;
}

function gridHeight(ostra: OstraDefinition, grid: RouteGrid, i: number, j: number): number {
  const k = j * grid.n + i;
  let h = grid.heights[k]!;
  if (h !== h) {
    const x = grid.origin + i * ROUTE_CELL;
    const z = grid.origin + j * ROUTE_CELL;
    h = heightAt(x, z, ostra.terrain);
    grid.heights[k] = h;
    grid.wet[k] = waterDepthAt(x, z, ostra.terrain) > -0.4 ? 1 : 0;
  }
  return h;
}

const NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, 1.4142135623730951], [1, -1, 1.4142135623730951],
  [-1, 1, 1.4142135623730951], [-1, -1, 1.4142135623730951],
];

/**
 * The cheapest way across the land from a to b, as grid cells.
 *
 * Cost climbs steeply with gradient, so a road goes round a mountain rather
 * than over it; water is nearly forbidden, so it goes round a lake; ground an
 * earlier road already covers is cheap, so roads join up into a network
 * instead of running side by side. A little hashed noise in the cost stops a
 * route across open ground being a ruler line.
 *
 * A* with a plain binary heap. Ties break on node index, so the same inputs
 * produce the same road in every engine.
 */
function route(ostra: OstraDefinition, grid: RouteGrid, ax: number, az: number, bx: number, bz: number): number[] {
  const n = grid.n;
  const clampCell = (v: number): number => Math.max(0, Math.min(n - 1, Math.round((v - grid.origin) / ROUTE_CELL)));
  const start = clampCell(az) * n + clampCell(ax);
  const goal = clampCell(bz) * n + clampCell(bx);
  const gi = goal % n;
  const gj = Math.floor(goal / n);
  const seed = ostra.wilds?.seed ?? 0;

  const g = new Float64Array(n * n).fill(Infinity);
  const came = new Int32Array(n * n).fill(-1);
  const closed = new Uint8Array(n * n);
  const heap: number[] = [];
  const f = new Float64Array(n * n);

  const less = (a: number, b: number): boolean => f[a]! < f[b]! || (f[a] === f[b] && a < b);
  const push = (node: number): void => {
    heap.push(node);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (!less(heap[c]!, heap[p]!)) break;
      [heap[c], heap[p]] = [heap[p]!, heap[c]!];
      c = p;
    }
  };
  const pop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let c = 0;
      for (;;) {
        const l = c * 2 + 1;
        const r = l + 1;
        let m = c;
        if (l < heap.length && less(heap[l]!, heap[m]!)) m = l;
        if (r < heap.length && less(heap[r]!, heap[m]!)) m = r;
        if (m === c) break;
        [heap[c], heap[m]] = [heap[m]!, heap[c]!];
        c = m;
      }
    }
    return top;
  };
  const heuristic = (i: number, j: number): number => {
    const di = i - gi;
    const dj = j - gj;
    return Math.sqrt(di * di + dj * dj) * ROUTE_CELL * 0.9;
  };

  g[start] = 0;
  f[start] = heuristic(start % n, Math.floor(start / n));
  push(start);

  while (heap.length > 0) {
    const node = pop();
    if (closed[node]) continue;
    closed[node] = 1;
    if (node === goal) break;
    const i = node % n;
    const j = Math.floor(node / n);
    const h = gridHeight(ostra, grid, i, j);

    for (const [di, dj, step] of NEIGHBOURS) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
      const next = nj * n + ni;
      if (closed[next]) continue;
      const nh = gridHeight(ostra, grid, ni, nj);
      const length = step * ROUTE_CELL;
      const grade = Math.abs(nh - h) / length;
      const steep = grade * 11;
      let cost = length * (1 + steep * steep + gridRough(ostra, grid, ni, nj) + 0.25 * hashUnit(ni, nj, seed + 71));
      if (grid.wet[next] === 1) cost *= 30;
      if (grid.road[next] === 1) cost *= 0.45;
      const total = g[node]! + cost;
      if (total >= g[next]!) continue;
      g[next] = total;
      came[next] = node;
      f[next] = total + heuristic(ni, nj);
      push(next);
    }
  }

  const cells: number[] = [];
  for (let at = goal; at !== -1; at = came[at]!) {
    cells.push(at);
    if (at === start) break;
  }
  return cells.reverse();
}

/** Round the corners off a polyline, keeping its ends. */
function chaikin(points: Array<{ x: number; z: number }>, passes: number): Array<{ x: number; z: number }> {
  let line = points;
  for (let pass = 0; pass < passes; pass++) {
    const next = [line[0]!];
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i]!;
      const b = line[i + 1]!;
      next.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 });
      next.push({ x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 });
    }
    next.push(line[line.length - 1]!);
    line = next;
  }
  return line;
}

export interface RoadPath {
  road: RoadDefinition;
  points: Array<{ x: number; z: number }>;
}

const roadPathCache = new Map<OstraId, readonly RoadPath[]>();

/**
 * Every road's drawn line, routed across the land in the order the roads are
 * listed — later roads lean on earlier ones, which is what makes junctions.
 */
export function roadPaths(ostra: OstraDefinition): readonly RoadPath[] {
  let paths = roadPathCache.get(ostra.id);
  if (paths) return paths;
  const grid = makeRouteGrid(ostra);
  const list: RoadPath[] = [];

  for (const road of ostra.roads) {
    let line: Array<{ x: number; z: number }> = [];
    for (let leg = 0; leg < road.points.length - 1; leg++) {
      const a = road.points[leg]!;
      const b = road.points[leg + 1]!;
      const cells = route(ostra, grid, a.x, a.z, b.x, b.z);
      for (const cell of cells) grid.road[cell] = 1;
      const points = cells.map((cell) => ({
        x: grid.origin + (cell % grid.n) * ROUTE_CELL,
        z: grid.origin + Math.floor(cell / grid.n) * ROUTE_CELL,
      }));
      // Arrive exactly where the road has to, not at the nearest cell.
      points[0] = { x: a.x, z: a.z };
      points[points.length - 1] = { x: b.x, z: b.z };
      if (points.length === 1) points.push({ x: b.x, z: b.z });
      line = line.concat(leg === 0 ? points : points.slice(1));
    }
    line = chaikin(line, 3);

    // The wobble of feet, tapered to nothing at the ends.
    const seed = hash2(road.id.length * 131, road.points.length, 77);
    let travelled = 0;
    const total = line.length;
    const wandering = line.map((p, i) => {
      if (i === 0 || i === total - 1) return p;
      const prev = line[i - 1]!;
      const next = line[i + 1]!;
      const tx = next.x - prev.x;
      const tz = next.z - prev.z;
      const length = Math.sqrt(tx * tx + tz * tz) || 1;
      travelled += dist(p.x, p.z, prev.x, prev.z);
      const taper = Math.min(1, i / 12, (total - 1 - i) / 12);
      const wander = gradientNoise(travelled / ROAD_MEANDER_WAVELENGTH, 0.5, seed) * ROAD_MEANDER * taper;
      return { x: p.x - (tz / length) * wander, z: p.z + (tx / length) * wander };
    });
    list.push({ road, points: wandering });
  }

  paths = list;
  roadPathCache.set(ostra.id, paths);
  return paths;
}

interface RoadSegment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  halfWidth: number;
}

const ROAD_GRID = 128;
const roadGridCache = new Map<OstraId, Map<number, RoadSegment[]>>();

/** Road segments bucketed by area, so "how far to the nearest road" does not
 *  have to look at every segment on the map. */
function roadGrid(ostra: OstraDefinition): Map<number, RoadSegment[]> {
  let grid = roadGridCache.get(ostra.id);
  if (grid) return grid;
  grid = new Map();
  const reach = 40;

  for (const { road, points } of roadPaths(ostra)) {
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i]!;
      const b = points[i + 1]!;
      const segment: RoadSegment = { ax: a.x, az: a.z, bx: b.x, bz: b.z, halfWidth: road.width / 2 };
      const minX = Math.floor((Math.min(a.x, b.x) - reach) / ROAD_GRID);
      const maxX = Math.floor((Math.max(a.x, b.x) + reach) / ROAD_GRID);
      const minZ = Math.floor((Math.min(a.z, b.z) - reach) / ROAD_GRID);
      const maxZ = Math.floor((Math.max(a.z, b.z) + reach) / ROAD_GRID);
      for (let cx = minX; cx <= maxX; cx++) {
        for (let cz = minZ; cz <= maxZ; cz++) {
          const key = cellKey(cx, cz);
          let list = grid.get(key);
          if (!list) grid.set(key, (list = []));
          list.push(segment);
        }
      }
    }
  }
  roadGridCache.set(ostra.id, grid);
  return grid;
}

/**
 * Distance from (x, z) to the nearest road's EDGE — negative on the road
 * itself. Infinity when no road is within about forty metres, which is as far
 * as anything cares to look.
 */
export function roadDistance(ostra: OstraDefinition, x: number, z: number): number {
  if (ostra.roads.length === 0) return Infinity;
  const list = roadGrid(ostra).get(cellKey(Math.floor(x / ROAD_GRID), Math.floor(z / ROAD_GRID)));
  if (!list) return Infinity;

  let best = Infinity;
  for (const s of list) {
    const vx = s.bx - s.ax;
    const vz = s.bz - s.az;
    const wx = x - s.ax;
    const wz = z - s.az;
    const lengthSq = vx * vx + vz * vz;
    let t = lengthSq > 0 ? (wx * vx + wz * vz) / lengthSq : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = wx - vx * t;
    const ez = wz - vz * t;
    const d = Math.sqrt(ex * ex + ez * ez) - s.halfWidth;
    if (d < best) best = d;
  }
  return best;
}

// --- woodland ---------------------------------------------------------------

/**
 * How wooded a spot is, 0 (open ground) to 1 (thick forest).
 *
 * Slow noise, so woods come in patches hundreds of metres across that you can
 * see the edge of, scaled by the region — Greywood is a forest with gaps,
 * Sunward is grass with the odd tree — and thicker round a logging town,
 * because a logging town with no trees near it is a contradiction.
 */
export function forestAt(ostra: OstraDefinition, x: number, z: number): number {
  const wilds = ostra.wilds;
  if (!wilds) return 0;
  const w = wilds.forestWavelength;
  let woods = 1;
  if (ostra.regions.length > 0) {
    const r = regionAt(ostra.terrain, x, z);
    woods = ostra.regions[r.primary]!.woods * r.weight + ostra.regions[r.secondary]!.woods * (1 - r.weight);
  }
  let density = smoothstep((fbm(x / w, z / w, wilds.seed + 5, 3) + 0.05) / 0.4) * woods;
  if (woods > 1) density = Math.min(1, density + (woods - 1) * 0.5);

  for (const settlement of settlementsIn(ostra)) {
    if (!settlement.woodland) continue;
    const d = dist(x, z, settlement.x, settlement.z) - settlement.radius;
    if (d < 260) density = Math.max(density, 0.9 * smoothstep(1 - d / 260));
  }
  return Math.min(1, density);
}

// --- ruins -------------------------------------------------------------------------

export interface RuinParts {
  /** Standing or fallen stones: circle colliders. */
  stones: Array<{ x: number; z: number; radius: number; height: number; fallen: boolean; yaw: number }>;
  /** Stretches of wall: box colliders. */
  walls: Array<{ x: number; z: number; width: number; depth: number; height: number }>;
  /** A barrow's mound, drawn as a low dome; solid like a stone. */
  mound?: { radius: number; height: number };
}

/** Unit directions round a circle in eighths — literal constants, for the
 *  reason at the top of this file. */
const EIGHTHS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [0.7071067811865476, 0.7071067811865476], [1, 0], [0.7071067811865476, -0.7071067811865476],
  [0, -1], [-0.7071067811865476, -0.7071067811865476], [-1, 0], [-0.7071067811865476, 0.7071067811865476],
];

const ruinCache = new WeakMap<RuinDefinition, RuinParts>();

/**
 * Exactly where a ruin's stones are. Shared: the server collides with them and
 * the client draws them, so a pillar cannot be drawn where you walk through
 * it. Which stones stand, lie or are missing is hashed from the ruin's
 * position, so the same ruin is equally broken for everyone.
 */
export function ruinParts(ruin: RuinDefinition): RuinParts {
  let parts = ruinCache.get(ruin);
  if (parts) return parts;
  parts = { stones: [], walls: [] };
  const seed = hash2(Math.round(ruin.x), Math.round(ruin.z), 911);
  const roll = (k: number): number => hashUnit(k, 3, seed);

  if (ruin.kind === "ring") {
    // Eight uprights; one gone, a couple fallen, the rest leaning heights.
    for (let k = 0; k < 8; k++) {
      if (roll(k) < 0.12) continue;
      const [sx, sz] = EIGHTHS[k]!;
      const fallen = roll(k + 20) < 0.25;
      parts.stones.push({
        x: ruin.x + sx * ruin.radius,
        z: ruin.z + sz * ruin.radius,
        radius: fallen ? 0.8 : 1.1,
        height: fallen ? 1.2 : 3.6 + roll(k + 40) * 3.2,
        fallen,
        yaw: roll(k + 60) * 6.283185307179586,
      });
    }
  } else if (ruin.kind === "tower") {
    // A square keep, broken to different heights, doorway on the south.
    const half = ruin.radius * 0.7;
    const t = 0.9;
    const h = (k: number): number => 2 + roll(k) * 4;
    parts.walls.push({ x: ruin.x, z: ruin.z + half, width: half * 2 + t, depth: t, height: h(1) });
    parts.walls.push({ x: ruin.x - half, z: ruin.z, width: t, depth: half * 2, height: h(2) });
    parts.walls.push({ x: ruin.x + half, z: ruin.z, width: t, depth: half * 2, height: h(3) });
    const gap = 1.4;
    const side = (half * 2 + t - gap * 2) / 2;
    parts.walls.push({ x: ruin.x - gap - side / 2, z: ruin.z - half, width: side, depth: t, height: h(4) });
    parts.walls.push({ x: ruin.x + gap + side / 2, z: ruin.z - half, width: side, depth: t, height: h(5) });
    // Rubble.
    for (let k = 0; k < 3; k++) {
      const [sx, sz] = EIGHTHS[(k * 3 + 1) % 8]!;
      parts.stones.push({
        x: ruin.x + sx * (half + 2.5), z: ruin.z + sz * (half + 2.5),
        radius: 0.7, height: 0.9, fallen: true, yaw: roll(k + 30) * 6.283185307179586,
      });
    }
  } else if (ruin.kind === "spire") {
    // One tall shard of rock, and its fallen pieces.
    parts.stones.push({
      x: ruin.x, z: ruin.z, radius: ruin.radius * 0.45, height: 16 + roll(1) * 10, fallen: false, yaw: roll(2) * 6.283185307179586,
    });
    for (let k = 0; k < 4; k++) {
      const [sx, sz] = EIGHTHS[(k * 2 + 1) % 8]!;
      const reach = ruin.radius * (0.9 + roll(k + 10) * 0.5);
      parts.stones.push({
        x: ruin.x + sx * reach, z: ruin.z + sz * reach,
        radius: 0.9 + roll(k + 20) * 0.8, height: 2 + roll(k + 30) * 3, fallen: roll(k + 40) < 0.5,
        yaw: roll(k + 50) * 6.283185307179586,
      });
    }
  } else {
    // A barrow: a turfed mound ringed by six standing stones.
    parts.mound = { radius: ruin.radius * 0.55, height: 2.6 };
    for (let k = 0; k < 8; k++) {
      if (k === 0 || k === 4) continue;
      const [sx, sz] = EIGHTHS[k]!;
      parts.stones.push({
        x: ruin.x + sx * ruin.radius, z: ruin.z + sz * ruin.radius,
        radius: 0.7, height: 2.2 + roll(k) * 1.8, fallen: roll(k + 20) < 0.2, yaw: roll(k + 40) * 6.283185307179586,
      });
    }
  }

  ruinCache.set(ruin, parts);
  return parts;
}

const boxColliderCache = new Map<OstraId, readonly BoxCollider[]>();

/** Buildings and ruined walls, as rectangles. Built once and reused;
 *  identical on both sides, so walking around a wall predicts perfectly. */
export function buildingColliders(ostra: OstraDefinition): readonly BoxCollider[] {
  let cached = boxColliderCache.get(ostra.id);
  if (!cached) {
    const boxes: BoxCollider[] = [];
    for (const settlement of settlementsIn(ostra)) {
      for (const building of settlement.buildings) {
        boxes.push({
          id: building.id,
          x: building.x,
          z: building.z,
          halfWidth: building.width / 2,
          halfDepth: building.depth / 2,
          yaw: building.yaw,
        });
      }
    }
    for (const ruin of ostra.ruins) {
      ruinParts(ruin).walls.forEach((wall, index) => {
        boxes.push({
          id: `${ruin.id}:wall:${index}`,
          x: wall.x,
          z: wall.z,
          halfWidth: wall.width / 2,
          halfDepth: wall.depth / 2,
          yaw: 0,
        });
      });
    }
    cached = boxes;
    boxColliderCache.set(ostra.id, cached);
  }
  return cached;
}

// --- camps ------------------------------------------------------------------

const campCache = new Map<OstraId, readonly CampDefinition[]>();

/** Places where nothing hostile may be close enough to notice you. */
function safePoints(ostra: OstraDefinition): Array<{ x: number; z: number; label: string }> {
  const points = [{ ...ostra.spawn, label: "the spawn point" }];
  for (const stone of ostra.waystones) {
    points.push({ ...waystoneArrival(stone), label: stone.name });
  }
  return points;
}

/** Level from distance to the spawn: the map's difficulty rises in rings. */
function levelAt(ostra: OstraDefinition, x: number, z: number): number {
  const wilds = ostra.wilds;
  if (!wilds) return 1;
  const fromSpawn = dist(x, z, ostra.spawn.x, ostra.spawn.z);
  return Math.min(MAX_ENEMY_LEVEL, 1 + Math.floor(fromSpawn / wilds.metresPerLevel));
}

/** Pick a creature by the region's weights, from a unit roll. */
function pickCreature(region: RegionDefinition | undefined, roll: number, wooded: number): EnemyKind {
  if (!region) return wooded > 0.5 ? (roll < 0.7 ? "spider" : "zombie") : (roll < 0.25 ? "spider" : "zombie");
  const entries = Object.entries(region.creatures) as Array<[EnemyKind, number]>;
  let total = 0;
  for (const [, weight] of entries) total += weight;
  let point = roll * total;
  for (const [kind, weight] of entries) {
    point -= weight;
    if (point < 0) return kind;
  }
  return entries[entries.length - 1]![0];
}

/** Pack size for a generated camp. Wolves run in packs; golems alone. */
function campSize(kind: EnemyKind, roll: number, level: number): number {
  switch (kind) {
    case "golem": return 1 + (roll < 0.3 ? 1 : 0);
    // A pack grows with the danger: two or three by the Gate Circle, five out
    // in Greywood.
    case "wolf": return 2 + Math.floor(roll * 2) + Math.floor(level / 4);
    case "boar": return 1 + Math.floor(roll * 3);
    case "wretch": return 2 + Math.floor(roll * 2);
    default: return 2 + Math.floor(roll * 3) + Math.floor(level / 4);
  }
}

/**
 * Every creature camp in an Ostra: the hand-placed ones, then the generated.
 *
 * Generated camps take their creature from the region's odds and their level
 * from distance to the spawn — which is what gives a new player somewhere to
 * start and a reason to go further.
 */
export function campsIn(ostra: OstraDefinition): readonly CampDefinition[] {
  let camps = campCache.get(ostra.id);
  if (camps) return camps;

  const list: CampDefinition[] = ostra.spawns.map((group, index) => ({
    id: `h${index}`,
    kind: group.kind,
    count: group.count,
    x: group.x,
    z: group.z,
    radius: group.radius,
    level: group.level ?? levelAt(ostra, group.x, group.z),
  }));

  const wilds = ostra.wilds;
  if (wilds) {
    const half = ostra.size / 2;
    // Nothing lives on the rim; it is there to be looked at.
    const margin = (ostra.terrain.rim?.width ?? 0) + 60;
    const spacing = wilds.campSpacing;
    const first = Math.floor((-half + margin) / spacing);
    const last = Math.floor((half - margin) / spacing);
    const safe = safePoints(ostra);
    const settlements = settlementsIn(ostra);

    for (let i = first; i <= last; i++) {
      for (let j = first; j <= last; j++) {
        let h = hash2(i, j, wilds.seed + 17);
        if (h / 4294967296 >= wilds.campChance) continue;
        h = rehash(h, 1);
        const x = (i + 0.15 + 0.7 * (h / 4294967296)) * spacing;
        h = rehash(h, 2);
        const z = (j + 0.15 + 0.7 * (h / 4294967296)) * spacing;
        if (Math.abs(x) > half - margin || Math.abs(z) > half - margin) continue;

        const level = levelAt(ostra, x, z);
        h = rehash(h, 3);
        const kind = pickCreature(regionOf(ostra, x, z), h / 4294967296, forestAt(ostra, x, z));
        h = rehash(h, 4);
        const count = campSize(kind, h / 4294967296, level);
        const radius = 4 + count * 1.2;
        const aggro = getArchetype(kind).aggroRadius;

        if (safe.some((p) => dist(x, z, p.x, p.z) - radius <= aggro + 14)) continue;
        if (settlements.some((s) => dist(x, z, s.x, s.z) - radius - s.radius <= aggro + 16)) continue;
        if (ostra.gates.some((g) => dist(x, z, g.x, g.z) - radius <= aggro + 6)) continue;
        if (ostra.ruins.some((r) => dist(x, z, r.x, r.z) - radius - r.radius <= 30)) continue;
        if (ostra.terrain.lakes?.some((l) => dist(x, z, l.x, l.z) - radius * 0.5 <= lakeReach(l))) continue;
        if (roadDistance(ostra, x, z) - radius <= 10) continue;

        list.push({ id: `w${i}_${j}`, kind, count, x, z, radius, level });
      }
    }
  }

  camps = list;
  campCache.set(ostra.id, camps);
  return camps;
}

const campBuckets = new Map<OstraId, Map<number, CampDefinition[]>>();

/** Camps near a scenery cell, so the cell can leave them a clearing. */
function campsNearCell(ostra: OstraDefinition, cx: number, cz: number): readonly CampDefinition[] {
  let buckets = campBuckets.get(ostra.id);
  if (!buckets) {
    buckets = new Map();
    for (const camp of campsIn(ostra)) {
      const reach = camp.radius + 4;
      for (let x = Math.floor((camp.x - reach) / SCENERY_CELL); x <= Math.floor((camp.x + reach) / SCENERY_CELL); x++) {
        for (let z = Math.floor((camp.z - reach) / SCENERY_CELL); z <= Math.floor((camp.z + reach) / SCENERY_CELL); z++) {
          const key = cellKey(x, z);
          let list = buckets.get(key);
          if (!list) buckets.set(key, (list = []));
          list.push(camp);
        }
      }
    }
    campBuckets.set(ostra.id, buckets);
  }
  return buckets.get(cellKey(cx, cz)) ?? [];
}

// --- scenery cells ------------------------------------------------------------

/** Hand-placed solids — obstacles, town trees, waystones, ruins — by cell. */
const handPlacedCache = new Map<OstraId, Map<number, Collider[]>>();

function handPlaced(ostra: OstraDefinition): Map<number, Collider[]> {
  let buckets = handPlacedCache.get(ostra.id);
  if (buckets) return buckets;
  buckets = new Map();
  const add = (collider: Collider): void => {
    const key = cellKey(Math.floor(collider.x / SCENERY_CELL), Math.floor(collider.z / SCENERY_CELL));
    let list = buckets!.get(key);
    if (!list) buckets!.set(key, (list = []));
    list.push(collider);
  };

  ostra.obstacles.forEach((o, index) => add({ id: `obstacle:${index}`, x: o.x, z: o.z, radius: o.radius }));
  // Trees are circles like rocks. A wood you can walk through is not a wood,
  // and Daso is a logging town.
  for (const settlement of settlementsIn(ostra)) {
    settlement.trees.forEach((tree, index) => add({
      id: `${settlement.id}:tree:${index}`, x: tree.x, z: tree.z, radius: tree.radius,
    }));
  }
  for (const stone of ostra.waystones) {
    add({ id: `waystone:${stone.id}`, x: stone.x, z: stone.z, radius: WAYSTONE_RADIUS });
  }
  for (const ruin of ostra.ruins) {
    const parts = ruinParts(ruin);
    parts.stones.forEach((s, index) => add({ id: `${ruin.id}:stone:${index}`, x: s.x, z: s.z, radius: s.radius }));
    if (parts.mound) add({ id: `${ruin.id}:mound`, x: ruin.x, z: ruin.z, radius: parts.mound.radius });
  }
  handPlacedCache.set(ostra.id, buckets);
  return buckets;
}

/** Collision radius of a waystone's plinth. */
export const WAYSTONE_RADIUS = 0.9;

const cellCache = new Map<OstraId, Map<number, SceneryCell>>();
const EMPTY_CELL: SceneryCell = { items: [], colliders: [] };

/**
 * One cell's scenery. Cached: a server walks the same few cells every tick,
 * and the client asks again whenever it rebuilds a chunk.
 */
export function sceneryCell(ostra: OstraDefinition, cx: number, cz: number): SceneryCell {
  let cells = cellCache.get(ostra.id);
  if (!cells) cellCache.set(ostra.id, (cells = new Map()));
  const key = cellKey(cx, cz);
  let cell = cells.get(key);
  if (cell) return cell;

  const fixed = handPlaced(ostra).get(key) ?? [];
  const wilds = ostra.wilds;
  if (!wilds && fixed.length === 0) {
    cells.set(key, EMPTY_CELL);
    return EMPTY_CELL;
  }

  const items: SceneryItem[] = [];
  const colliders: Collider[] = [...fixed];
  if (wilds) generateWilds(ostra, wilds.seed, cx, cz, items, colliders);

  cell = { items, colliders };
  cells.set(key, cell);
  return cell;
}

function generateWilds(
  ostra: OstraDefinition,
  seed: number,
  cx: number,
  cz: number,
  items: SceneryItem[],
  colliders: Collider[],
): void {
  const wilds = ostra.wilds!;
  const half = ostra.size / 2 - 6;
  const x0 = cx * SCENERY_CELL;
  const z0 = cz * SCENERY_CELL;
  if (x0 > half || z0 > half || x0 + SCENERY_CELL < -half || z0 + SCENERY_CELL < -half) return;

  const camps = campsNearCell(ostra, cx, cz);
  const settlements = settlementsIn(ostra);
  const snowLine = ostra.terrain.mountains ? ostra.terrain.mountains.amplitude * 0.62 : Infinity;
  const lakes = (ostra.terrain.lakes ?? []).filter((l) => {
    const reach = lakeReach(l) + SCENERY_CELL;
    return Math.abs(l.x - (x0 + 32)) < reach && Math.abs(l.z - (z0 + 32)) < reach;
  });

  for (let a = 0; a < PLOTS; a++) {
    for (let b = 0; b < PLOTS; b++) {
      let h = hash2(cx * PLOTS + a, cz * PLOTS + b, seed);
      const pick = h / 4294967296;
      h = rehash(h, 11);
      const x = x0 + (a + 0.1 + 0.8 * (h / 4294967296)) * PLOT;
      h = rehash(h, 12);
      const z = z0 + (b + 0.1 + 0.8 * (h / 4294967296)) * PLOT;
      if (x < -half || x > half || z < -half || z > half) continue;

      const wooded = forestAt(ostra, x, z);
      const treeChance = 0.012 + wilds.forest * wooded;
      const isTree = pick < treeChance;
      const isRock = !isTree && pick < treeChance + wilds.rocks;
      if (!isTree && !isRock) continue;

      // Keep the paths, the towns, the camps and the standing places clear.
      if (roadDistance(ostra, x, z) < 2.5) continue;
      if (dist(x, z, ostra.spawn.x, ostra.spawn.z) < 40) continue;
      if (settlements.some((s) => dist(x, z, s.x, s.z) < s.radius + 9)) continue;
      if (ostra.waystones.some((w) => dist(x, z, w.x, w.z) < 9)) continue;
      if (ostra.gates.some((g) => dist(x, z, g.x, g.z) < GATE_RADIUS + 5)) continue;
      if (ostra.ruins.some((r) => dist(x, z, r.x, r.z) < r.radius + 7)) continue;
      if (camps.some((c) => dist(x, z, c.x, c.z) < c.radius + 3)) continue;

      const ground = heightAt(x, z, ostra.terrain);
      // Nothing grows in the water or on the drowned margin of it.
      if (lakes.some((l) => dist(x, z, l.x, l.z) < lakeReach(l) && ground < lakeLevel(l, ostra.terrain) + 0.3)) continue;

      h = rehash(h, 13);
      const size = h / 4294967296;
      h = rehash(h, 14);
      const yaw = (h / 4294967296) * 6.283185307179586;
      const id = `w:${cx}:${cz}:${a}:${b}`;
      const region = regionOf(ostra, x, z);

      if (isTree) {
        // Nothing grows on the peaks.
        if (ground > snowLine) continue;
        h = rehash(h, 15);
        const species = region ? region.trees[Math.floor((h / 4294967296) * region.trees.length)]! : "oak";
        // High ground turns any wood to pine.
        const kind = ground > 40 && species !== "dead" ? "pine" : species;
        const shape = TREE_SHAPES[kind];
        const height = shape.height + size * shape.heightRange;
        const radius = shape.radius + size * shape.radiusRange;
        items.push({ kind, x, z, radius, height, yaw });
        colliders.push({ id, x, z, radius });
      } else {
        const radius = 0.7 + size * 1.7;
        items.push({
          kind: "rock", tint: region?.rock ?? "grey", x, z, radius, height: radius * (0.8 + size * 0.5), yaw,
        });
        colliders.push({ id, x, z, radius });
      }
    }
  }
}

/** Sizes per species: base and random range, height and trunk radius. */
const TREE_SHAPES: Record<Exclude<SceneryKind, "rock">, {
  height: number; heightRange: number; radius: number; radiusRange: number;
}> = {
  pine: { height: 7, heightRange: 5, radius: 0.45, radiusRange: 0.25 },
  oak: { height: 6, heightRange: 3.5, radius: 0.55, radiusRange: 0.3 },
  birch: { height: 6.5, heightRange: 3, radius: 0.35, radiusRange: 0.15 },
  dead: { height: 4.5, heightRange: 3.5, radius: 0.4, radiusRange: 0.25 },
};

const indexCache = new Map<OstraId, SceneryIndex>();

/** The collision view of an Ostra's scenery. See `SceneryIndex`. */
export function sceneryIndex(ostra: OstraDefinition): SceneryIndex {
  let index = indexCache.get(ostra.id);
  if (!index) {
    index = {
      cellSize: SCENERY_CELL,
      cell: (cx, cz) => sceneryCell(ostra, cx, cz).colliders,
    };
    indexCache.set(ostra.id, index);
  }
  return index;
}

// --- checks -------------------------------------------------------------------

/**
 * Places where you could wake up inside something's aggro radius.
 *
 * Found the hard way: Barals put new arrivals 10m from a camp of Risen that
 * notice you at 13m, so dying meant respawning into the same creatures that
 * had just killed you. The layout is hand-authored data, and hand-authored
 * data drifts — so this is checked at boot rather than by eye. Generated camps
 * are placed by the same rule and so pass by construction; this is really a
 * check on the hand-placed ones.
 *
 * Returns a human-readable line per problem, empty when all is well.
 */
export function unsafeSpawns(): string[] {
  const problems: string[] = [];

  for (const ostra of Object.values(OSTRAS)) {
    const safe = safePoints(ostra);
    for (const camp of campsIn(ostra)) {
      const archetype = getArchetype(camp.kind);

      for (const point of safe) {
        // Worst case is a creature scattered to the near edge of its camp.
        const reach = Math.max(0, dist(camp.x, camp.z, point.x, point.z) - camp.radius);
        if (reach <= archetype.aggroRadius) {
          problems.push(
            `${ostra.name}: ${archetype.name} camp can reach within ${reach.toFixed(1)}m ` +
            `of ${point.label}, inside its ${archetype.aggroRadius}m aggro radius`,
          );
        }
      }

      // Towns are meant to be the safe part. A camp whose creatures can wander
      // into the streets makes the one calm place in the Ostra not calm.
      for (const settlement of settlementsIn(ostra)) {
        const reach = Math.max(0, dist(camp.x, camp.z, settlement.x, settlement.z)
          - camp.radius - settlement.radius);
        if (reach <= archetype.aggroRadius) {
          problems.push(
            `${ostra.name}: ${archetype.name} camp can reach within ${reach.toFixed(1)}m ` +
            `of ${settlement.name}, inside its ${archetype.aggroRadius}m aggro radius`,
          );
        }
      }
    }
  }

  return problems;
}
