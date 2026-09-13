/**
 * Things a quest asks you to pick up off the ground: herbs in a glade, sacks
 * spilled along a road, heartwood from a dead grove.
 *
 * Every quest used to be a fight — kill these, or kill these until some of
 * them drop that — so the only way to do anything for anyone was to hit
 * something. A gather objective names a place and a thing, and the thing lies
 * about in that place, glowing, to be picked up with E. Creatures may well
 * live there too; the point is that they are in the way, not the errand.
 *
 * Where each one lies is a pure function of the quest (`gatherSpots`), so the
 * client draws exactly the spots the server will accept, and nothing about
 * them is stored or sent. Spots are for everyone: a picked spot comes back
 * after `GATHER_RESPAWN_MS` for whoever picked it, so two people on the same
 * errand never have to race each other for the last sack.
 */

import { hash2 } from "./noise.js";
import { getOstra, type OstraId } from "./ostras.js";
import { getQuest, type QuestDefinition } from "./quests.js";
import { heightAt, slopeAt, waterDepthAt } from "./terrain.js";
import { SCENERY_CELL, sceneryCell } from "./worldgen.js";

/** How close you must stand to pick something up. */
export const GATHER_RANGE = 2.6;

/** A spot you picked is empty for you for this long. */
export const GATHER_RESPAWN_MS = 60_000;

/** How a thing is drawn: the client has a small model for each. */
export type GatherLook = "herb" | "sack" | "wood" | "candle";

export interface GatherThing {
  name: string;
  look: GatherLook;
  /** 0xRRGGBB: the thing's own colour, and its glow. */
  colour: number;
  glow: number;
}

export const GATHER_THINGS = {
  moonwort: { name: "Moonwort", look: "herb", colour: 0x5f8f5a, glow: 0xb9a4ff },
  saltSack: { name: "Salt sack", look: "sack", colour: 0xd8c9a3, glow: 0xffe3a0 },
  heartwood: { name: "Blighted heartwood", look: "wood", colour: 0x5a4034, glow: 0xff7a5a },
  graveCandle: { name: "Grave-candle", look: "candle", colour: 0xe8dcc0, glow: 0xffc860 },
} as const satisfies Record<string, GatherThing>;

export type GatherThingId = keyof typeof GATHER_THINGS;

export function isGatherThing(value: unknown): value is GatherThingId {
  return typeof value === "string" && Object.hasOwn(GATHER_THINGS, value);
}

export interface GatherSpot {
  /** Index among the objective's spots: what the client names when it asks. */
  index: number;
  x: number;
  z: number;
  y: number;
}

const spotCache = new Map<string, readonly GatherSpot[]>();

/**
 * Where a quest's gather objective lies: `spots` points (twice the count if
 * unset) scattered over its circle, each on dry, gentle ground and clear of
 * every tree and rock — a herb inside a trunk is a herb nobody can reach.
 * Candidates are tried in a fixed order from a hash of the quest, so both
 * sides find the same spots; a place too wooded to hold them all just holds
 * fewer.
 */
export function gatherSpots(quest: QuestDefinition, objectiveIndex: number): readonly GatherSpot[] {
  const objective = quest.objectives[objectiveIndex];
  if (!objective || objective.kind !== "gather") return [];
  const key = `${quest.id}:${objectiveIndex}`;
  const cached = spotCache.get(key);
  if (cached) return cached;

  const ostra = getOstra((objective.ostra ?? "terra") as OstraId);
  const want = objective.spots ?? objective.count * 2;
  let seed = 0x2545f491;
  for (let i = 0; i < key.length; i++) seed = Math.imul(seed ^ key.charCodeAt(i), 0x01000193);

  const spots: GatherSpot[] = [];
  for (let attempt = 0; attempt < want * 12 && spots.length < want; attempt++) {
    // Uniform over the disc: the square root keeps them from bunching in
    // the middle.
    const u = hash2(attempt, 1, seed) / 4294967296;
    const v = hash2(attempt, 2, seed) / 4294967296;
    const r = objective.radius * Math.sqrt(u);
    // A point on the unit circle without trigonometry, for the reason in
    // noise.ts: the rational parametrisation of the circle.
    const t = v * 2 - 1;
    const cx = (1 - t * t) / (1 + t * t);
    const cz = (2 * t) / (1 + t * t);
    const flip = hash2(attempt, 3, seed) & 1 ? -1 : 1;
    const x = objective.x + r * cx * flip;
    const z = objective.z + r * cz;

    if (waterDepthAt(x, z, ostra.terrain) > -0.05) continue;
    if (slopeAt(x, z, ostra.terrain) > 0.45) continue;
    // Not on top of each other: a heap of sacks reads as one sack.
    if (spots.some((spot) => (spot.x - x) * (spot.x - x) + (spot.z - z) * (spot.z - z) < 36)) continue;
    const cell = sceneryCell(ostra, Math.floor(x / SCENERY_CELL), Math.floor(z / SCENERY_CELL));
    if (cell.colliders.some((c) => (c.x - x) * (c.x - x) + (c.z - z) * (c.z - z) < (c.radius + 1.2) * (c.radius + 1.2))) continue;
    spots.push({ index: spots.length, x, z, y: heightAt(x, z, ostra.terrain) });
  }
  spotCache.set(key, spots);
  return spots;
}

/** A spot by quest, objective and index, if it is one. */
export function findGatherSpot(questId: unknown, objectiveIndex: unknown, spotIndex: unknown):
  { quest: QuestDefinition; spot: GatherSpot } | undefined {
  const quest = getQuest(questId);
  if (!quest || typeof objectiveIndex !== "number" || typeof spotIndex !== "number") return undefined;
  const spot = gatherSpots(quest, objectiveIndex)[spotIndex];
  return spot ? { quest, spot } : undefined;
}
