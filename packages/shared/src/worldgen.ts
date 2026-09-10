import { GATE_RADIUS } from "./constants.js";
import {
  getArchetype,
  MAX_ENEMY_LEVEL,
  type EnemyKind,
} from "./enemies.js";
import type { Collider, SceneryIndex } from "./movement.js";
import { fbm, gradientNoise, hash2, rehash, smoothstep } from "./noise.js";
import {
  OSTRAS,
  settlementsIn,
  waystoneArrival,
  type OstraDefinition,
  type OstraId,
  type RoadDefinition,
} from "./ostras.js";
import { heightAt } from "./terrain.js";

/**
 * Everything on a big Ostra that nobody placed by hand.
 *
 * Eight kilometres of Terra is tens of thousands of trees and hundreds of
 * creature camps. None of it is stored or sent: it is all a pure function of
 * the Ostra's `wilds.seed`, evaluated lazily, cell by cell, wherever someone is
 * standing. The server asks for colliders; the client asks for the same cells
 * to draw them. Because `noise.ts` is bit-identical everywhere and nothing here
 * uses Math.random or a trig function, the tree you see is the tree you hit.
 *
 * The rules that place things are mostly rules about where NOT to: nothing on
 * a road, nothing in a town, no camp where you might wake up.
 */

/** Scenery is generated and bucketed in squares this wide. Must exceed the
 *  biggest collider radius plus the biggest body radius — it does, by a lot. */
export const SCENERY_CELL = 64;

/** Plots per cell side: one candidate tree or rock per 8 m square. */
const PLOTS = 8;
const PLOT = SCENERY_CELL / PLOTS;

export type SceneryKind = "pine" | "oak" | "rock";

export interface SceneryItem {
  kind: SceneryKind;
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

// --- roads ------------------------------------------------------------------

interface RoadSegment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  halfWidth: number;
}

/** Roads are drawn this finely. */
const ROAD_STEP = 36;
/** How far a road wanders from the straight line between its control points. */
const ROAD_MEANDER = 22;

const roadPathCache = new WeakMap<RoadDefinition, Array<{ x: number; z: number }>>();

/**
 * A road's drawn line: its control points, with the straight runs between
 * them bent by noise so it looks walked rather than surveyed. Endpoints are
 * never moved — they are where the road has to arrive.
 */
export function roadPath(road: RoadDefinition): Array<{ x: number; z: number }> {
  let path = roadPathCache.get(road);
  if (path) return path;
  path = [];
  let travelled = 0;
  const seed = hash2(road.id.length, road.points.length, 77);

  for (let i = 0; i < road.points.length - 1; i++) {
    const a = road.points[i]!;
    const b = road.points[i + 1]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.sqrt(dx * dx + dz * dz);
    const steps = Math.max(1, Math.round(length / ROAD_STEP));
    // Perpendicular, for the sideways wander.
    const px = -dz / length;
    const pz = dx / length;

    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      // Taper the wander to zero at each control point, so the road still
      // passes through every one of them exactly.
      const taper = 4 * t * (1 - t);
      const wander = gradientNoise((travelled + t * length) / 170, 0.5, seed) * ROAD_MEANDER * taper;
      path.push({ x: a.x + dx * t + px * wander, z: a.z + dz * t + pz * wander });
    }
    travelled += length;
  }
  path.push(road.points[road.points.length - 1]!);
  roadPathCache.set(road, path);
  return path;
}

const ROAD_GRID = 128;

interface RoadGrid {
  cells: Map<number, RoadSegment[]>;
}

const roadGridCache = new Map<OstraId, RoadGrid>();

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

/** Road segments bucketed by area, so "how far to the nearest road" does not
 *  have to look at every segment on the map. */
function roadGrid(ostra: OstraDefinition): RoadGrid {
  let grid = roadGridCache.get(ostra.id);
  if (grid) return grid;
  grid = { cells: new Map() };
  const reach = 40;

  for (const road of ostra.roads) {
    const path = roadPath(road);
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i]!;
      const b = path[i + 1]!;
      const segment: RoadSegment = { ax: a.x, az: a.z, bx: b.x, bz: b.z, halfWidth: road.width / 2 };
      const minX = Math.floor((Math.min(a.x, b.x) - reach) / ROAD_GRID);
      const maxX = Math.floor((Math.max(a.x, b.x) + reach) / ROAD_GRID);
      const minZ = Math.floor((Math.min(a.z, b.z) - reach) / ROAD_GRID);
      const maxZ = Math.floor((Math.max(a.z, b.z) + reach) / ROAD_GRID);
      for (let cx = minX; cx <= maxX; cx++) {
        for (let cz = minZ; cz <= maxZ; cz++) {
          const key = cellKey(cx, cz);
          let list = grid.cells.get(key);
          if (!list) grid.cells.set(key, (list = []));
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
  const list = roadGrid(ostra).cells.get(cellKey(Math.floor(x / ROAD_GRID), Math.floor(z / ROAD_GRID)));
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
 * How wooded a spot is, 0 (open meadow) to 1 (thick forest).
 *
 * Slow noise, so woods come in patches hundreds of metres across that you can
 * see the edge of — and thicker around settlements, because Daso is a logging
 * town and a logging town with no trees near it is a contradiction.
 */
export function forestAt(ostra: OstraDefinition, x: number, z: number): number {
  const wilds = ostra.wilds;
  if (!wilds) return 0;
  const w = wilds.forestWavelength;
  let density = smoothstep((fbm(x / w, z / w, wilds.seed + 5, 3) + 0.05) / 0.4);

  for (const settlement of settlementsIn(ostra)) {
    const dx = x - settlement.x;
    const dz = z - settlement.z;
    const d = Math.sqrt(dx * dx + dz * dz) - settlement.radius;
    if (d < 260) density = Math.max(density, 0.9 * smoothstep(1 - d / 260));
  }
  return density;
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

/**
 * Every creature camp in an Ostra: the hand-placed ones, then the generated.
 *
 * Generated camps get a level from their distance to the spawn — the map's
 * difficulty rises in rings from the Gate Circle, which is what gives a new
 * player somewhere to start and a reason to go further.
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
    level: group.level ?? 1,
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

        const fromSpawn = dist(x, z, ostra.spawn.x, ostra.spawn.z);
        const level = Math.min(MAX_ENEMY_LEVEL, 1 + Math.floor(fromSpawn / wilds.metresPerLevel));

        // Spiders keep to the woods; the Risen wander the open ground.
        const wooded = forestAt(ostra, x, z);
        h = rehash(h, 3);
        const roll = h / 4294967296;
        const kind: EnemyKind = wooded > 0.5 ? (roll < 0.7 ? "spider" : "zombie") : (roll < 0.25 ? "spider" : "zombie");

        h = rehash(h, 4);
        const count = 2 + Math.floor((h / 4294967296) * 3) + Math.floor(level / 4);
        const radius = 4 + count * 1.2;
        const aggro = getArchetype(kind).aggroRadius;

        if (safe.some((p) => dist(x, z, p.x, p.z) - radius <= aggro + 14)) continue;
        if (settlements.some((s) => dist(x, z, s.x, s.z) - radius - s.radius <= aggro + 16)) continue;
        if (ostra.gates.some((g) => dist(x, z, g.x, g.z) - radius <= aggro + 6)) continue;
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

/** Hand-placed solids — obstacles, town trees, waystones — bucketed by cell. */
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
      if (camps.some((c) => dist(x, z, c.x, c.z) < c.radius + 3)) continue;

      const ground = heightAt(x, z, ostra.terrain);
      h = rehash(h, 13);
      const size = h / 4294967296;
      h = rehash(h, 14);
      const yaw = (h / 4294967296) * 6.283185307179586;
      const id = `w:${cx}:${cz}:${a}:${b}`;

      if (isTree) {
        // Nothing grows on the peaks.
        if (ground > snowLine) continue;
        // Pines on high ground and in patches; broadleaf in the lowlands.
        const pine = ground > 22 || fbm(x / 900, z / 900, seed + 9, 2) > 0.1;
        const height = pine ? 7 + size * 5 : 6 + size * 3.5;
        const radius = pine ? 0.45 + size * 0.25 : 0.55 + size * 0.3;
        items.push({ kind: pine ? "pine" : "oak", x, z, radius, height, yaw });
        colliders.push({ id, x, z, radius });
      } else {
        const radius = 0.7 + size * 1.7;
        items.push({ kind: "rock", x, z, radius, height: radius * (0.8 + size * 0.5), yaw });
        colliders.push({ id, x, z, radius });
      }
    }
  }
}

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
