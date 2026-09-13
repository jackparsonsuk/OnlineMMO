/**
 * Fishing: face open water, press E, and wait for something to bite.
 *
 * Everything here is shared because both sides need to agree on *where* — the
 * client to say "E — fish" only when E will work, and to draw the bobber, the
 * server to decide it — but nothing here decides what bites. What is caught is
 * rolled on the server alone, like loot (`OstraRoom`, from `catchChances`).
 *
 * A cast lands on the first water deep enough to fish, straight ahead,
 * between CAST_NEAR and CAST_FAR. Which water it is sets what lives there:
 * every lake names its `waters` (a millpond is not a mere), and the sea is its
 * own. What your Fishing level decides:
 *
 *  - whether anything there will bite at all. Every water has a lowest fish,
 *    and below its level the cast is refused with the level it wants — a
 *    beginner is told to try a pond, not left waiting at the sea forever;
 *  - which of its fish you can catch, and how often the better ones come: a
 *    fish just within your level bites at a third of its usual rate, rising to
 *    all of it five levels on;
 *  - how long a bite waits for you (`biteWindowMs`), and how long you wait for
 *    a bite (`biteDelayMs`).
 *
 * Nothing about fishing touches movement, so none of it is predicted. The
 * state is replicated on the player (`fishing`, `bobberX/Z`) for everyone to
 * draw, and a bite is simply that state changing.
 */

import type { GoodId } from "./goods.js";
import { OSTRAS } from "./ostras.js";
import { heightAt, lakeLevel, lakeReach, seaRamp, type LakeDefinition, type TerrainSettings } from "./terrain.js";

/** `Player.fishing`. */
export const FISHING_NONE = 0;
/** Line in the water, nothing yet. */
export const FISHING_WAITING = 1;
/** Something has the bait: hook it now. */
export const FISHING_BITE = 2;

/** A cast reaches no nearer than this, and no further. */
export const CAST_NEAR = 3;
export const CAST_FAR = 12;
const CAST_STEP = 0.5;
/** Water shallower than this is not worth a line. */
export const FISHING_DEPTH = 0.35;

/** How long after a cast ends before another may start. */
export const RECAST_MS = 600;

export type WatersId = "pond" | "mere" | "lake" | "fanshona" | "sea";

export interface FishEntry {
  good: GoodId;
  /** The Fishing level it takes to catch it, and the level its XP is paid at. */
  level: number;
  /** How often it bites, against the rest of this water's fish. */
  weight: number;
}

export interface WatersDefinition {
  name: string;
  fish: readonly FishEntry[];
}

/**
 * What lives where. A pond is where anyone starts; the Lowfen's meres and the
 * Brightwater's lakes come next; Fanshona's own lake keeps the Lanternfin; and
 * the sea wants a fisher of ten before anything in it will look at a hook.
 */
export const WATERS: Record<WatersId, WatersDefinition> = {
  pond: {
    name: "Pond",
    fish: [
      { good: "minnow", level: 1, weight: 6 },
      { good: "perch", level: 3, weight: 4 },
      { good: "roach", level: 6, weight: 3 },
      { good: "carp", level: 18, weight: 0.6 },
    ],
  },
  mere: {
    name: "Mere",
    fish: [
      { good: "perch", level: 3, weight: 1 },
      { good: "roach", level: 6, weight: 2 },
      { good: "loach", level: 8, weight: 5 },
      { good: "eel", level: 14, weight: 3 },
    ],
  },
  lake: {
    name: "Lake",
    fish: [
      { good: "perch", level: 3, weight: 2 },
      { good: "roach", level: 6, weight: 2 },
      { good: "pike", level: 20, weight: 4 },
      { good: "carp", level: 25, weight: 2 },
    ],
  },
  fanshona: {
    name: "Fanshona's lake",
    fish: [
      { good: "perch", level: 3, weight: 2 },
      { good: "pike", level: 20, weight: 3 },
      { good: "carp", level: 25, weight: 3 },
      { good: "lanternfin", level: 35, weight: 0.8 },
    ],
  },
  sea: {
    name: "Sea",
    fish: [
      { good: "herring", level: 10, weight: 6 },
      { good: "mackerel", level: 18, weight: 4 },
      { good: "bream", level: 28, weight: 3 },
      { good: "cod", level: 36, weight: 2 },
      { good: "sunscale", level: 45, weight: 0.4 },
    ],
  },
};

export function isWatersId(value: unknown): value is WatersId {
  return typeof value === "string" && Object.hasOwn(WATERS, value);
}

/** Where a cast lands, and on what. */
export interface CastPoint {
  x: number;
  z: number;
  /** The water's surface there. */
  surface: number;
  waters: WatersId;
  /** What to call it: the sea's own name, or the kind of lake. */
  name: string;
}

/**
 * Where a cast from (x, z), facing `yaw`, would land: the first water deep
 * enough to fish, straight ahead. Undefined if there is none in reach.
 */
export function castPoint(terrain: TerrainSettings, x: number, z: number, yaw: number): CastPoint | undefined {
  const dirX = Math.sin(yaw);
  const dirZ = Math.cos(yaw);
  for (let reach = CAST_NEAR; reach <= CAST_FAR; reach += CAST_STEP) {
    const px = x + dirX * reach;
    const pz = z + dirZ * reach;
    const found = waterAt(terrain, px, pz);
    if (found) return { x: px, z: pz, ...found };
  }
  return undefined;
}

/** The water at a point, if it is deep enough to fish. */
export function waterAt(
  terrain: TerrainSettings,
  x: number,
  z: number,
): { surface: number; waters: WatersId; name: string } | undefined {
  const sea = terrain.sea;
  const nearSea = sea !== undefined && seaRamp(sea, x, z, terrain.seed) > 0;
  let lake: LakeDefinition | undefined;
  for (const candidate of terrain.lakes ?? []) {
    const dx = x - candidate.x;
    const dz = z - candidate.z;
    const reach = lakeReach(candidate);
    if (dx * dx + dz * dz < reach * reach) {
      lake = candidate;
      break;
    }
  }
  if (!nearSea && !lake) return undefined;

  const ground = heightAt(x, z, terrain);
  if (sea && nearSea && sea.level - ground > FISHING_DEPTH) {
    return { surface: sea.level, waters: "sea", name: sea.name };
  }
  if (lake) {
    const surface = lakeLevel(lake, terrain);
    if (surface - ground > FISHING_DEPTH) {
      const waters = isWatersId(lake.waters) ? lake.waters : "pond";
      return { surface, waters, name: WATERS[waters].name };
    }
  }
  return undefined;
}

/** The lowest Fishing level anything in these waters bites for. */
export function lowestCatchLevel(waters: WatersId): number {
  let lowest = Infinity;
  for (const fish of WATERS[waters].fish) lowest = Math.min(lowest, fish.level);
  return lowest;
}

/** A fish just within reach bites this often, against its full weight... */
const NEW_FISH_SHARE = 1 / 3;
/** ...rising to all of it this many levels later. */
const FULL_WEIGHT_LEVELS = 5;

/**
 * What can bite here at this level, and the chance of each (summing to 1).
 * Empty if nothing will.
 */
export function catchChances(waters: WatersId, level: number): Array<FishEntry & { chance: number }> {
  const eligible = WATERS[waters].fish
    .filter((fish) => fish.level <= level)
    .map((fish) => {
      const grown = Math.min(1, NEW_FISH_SHARE + ((1 - NEW_FISH_SHARE) * (level - fish.level)) / FULL_WEIGHT_LEVELS);
      return { ...fish, chance: fish.weight * grown };
    });
  const total = eligible.reduce((sum, fish) => sum + fish.chance, 0);
  for (const fish of eligible) fish.chance /= total;
  return eligible;
}

/**
 * How long a bite waits for a click, in ms, as the server times it. The
 * server measures from when it decided the bite, and the click has to travel
 * there and back first, so the window carries a margin for a slow connection
 * on top of the reaction time a fisher is actually given.
 */
export function biteWindowMs(level: number): number {
  return 850 + 12 * Math.max(1, level) + HOOK_LATENCY_MS;
}

/** The part of the bite window that is only there for the network. */
export const HOOK_LATENCY_MS = 400;

/**
 * Lakes a fisher could never use: a `waters` nobody wrote a table for (it
 * would silently be a pond), or a middle too shallow to cast into. Logged at
 * boot as `[fishing]`, like the spawn checks.
 */
export function fishingProblems(): string[] {
  const problems: string[] = [];
  for (const ostra of Object.values(OSTRAS)) {
    for (const lake of ostra.terrain.lakes ?? []) {
      const where = `${ostra.name}: lake at (${lake.x}, ${lake.z})`;
      if (lake.waters !== undefined && !isWatersId(lake.waters)) problems.push(`${where} has unknown waters "${lake.waters}"`);
      if (!waterAt(ostra.terrain, lake.x, lake.z)) problems.push(`${where} is too shallow to fish at its middle`);
    }
  }
  return problems;
}

/** Waiting for a bite: four to twelve seconds, a third quicker at the top. */
export function biteDelayMs(level: number, roll: number): number {
  const quicker = 1 - 0.33 * Math.min(1, Math.max(0, (level - 1) / 49));
  return (4000 + roll * 8000) * quicker;
}
