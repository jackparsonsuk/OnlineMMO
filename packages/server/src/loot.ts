/**
 * Rolling drops. Server-only, because it is the one place in the game that
 * uses `Math.random` on an item: the client never rolls anything, it only
 * describes keys it is sent (see `describeItem` in @mmo/shared).
 */

import {
  basesFor,
  encodeItem,
  getBase,
  isItemKey,
  itemLevelFor,
  MAX_ITEM_LEVEL,
  RARITIES,
  type EquipSlot,
  type GearSlot,
  type ItemBase,
  type ItemKey,
  type LootSource,
  type Rarity,
} from "@mmo/shared";

/**
 * Base rarity odds for each kind of source, before danger tilts them.
 *
 * Ordinary creatures stop at rare. Mythic and above come only from something
 * that is itself rare — an elite, a dungeon, a raid — because a top tier that
 * any wolf might drop is not a top tier. Nothing in the world is an elite yet;
 * the rows exist so adding one is a data change.
 */
const SOURCE_ODDS: Record<LootSource, Partial<Record<Rarity, number>>> = {
  creature: { common: 70, uncommon: 25, rare: 5 },
  elite: { uncommon: 30, rare: 50, mythic: 17, legendary: 3 },
  dungeon: { rare: 55, mythic: 38, legendary: 7 },
  raid: { rare: 25, mythic: 50, legendary: 20, world: 2.5, ostra: 2.5 },
};

/**
 * Pick a rarity.
 *
 * A dangerous place paying the same as a safe one would make Barals pure
 * downside, so `danger` multiplies each rarer tier's weight by one more power
 * of itself. At danger 1.0 a creature drops 70/25/5; at Barals' 1.5, nearer
 * 59/32/9.
 */
export function rollRarity(random: () => number, source: LootSource, danger: number): Rarity {
  const odds = SOURCE_ODDS[source];
  const tiers = RARITIES.filter((rarity) => odds[rarity] !== undefined);
  const weights = tiers.map((rarity, index) => odds[rarity]! * Math.pow(Math.max(1, danger), index));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let point = random() * total;
  for (let i = 0; i < tiers.length; i++) {
    point -= weights[i]!;
    if (point < 0) return tiers[i]!;
  }
  return tiers[tiers.length - 1]!;
}

/**
 * Item level for a drop: the creature's level on the item scale, a nudge for a
 * dangerous Ostra, a little spread — and, rarely, a lot more. The long upward
 * tail is what makes a drop worth looking at: most are about what you'd
 * expect, one in a dozen is noticeably better, and one in a hundred is gear
 * you will grow into for a long time.
 */
export function rollItemLevel(random: () => number, creatureLevel: number, ostraDanger: number): number {
  let level = itemLevelFor(creatureLevel) + Math.round((ostraDanger - 1) * 20);
  level += Math.round((random() * 2 - 1) * 4);
  const luck = random();
  if (luck < 0.01) level += 40 + Math.floor(random() * 81);
  else if (luck < 0.09) level += 10 + Math.floor(random() * 21);
  return Math.max(1, Math.min(MAX_ITEM_LEVEL, level));
}

/**
 * How often each kind of piece drops, relative to the others. Weighting by
 * slot rather than by base keeps armour — eighteen bases — from burying the
 * nine weapons and three trinkets.
 */
const SLOT_DROP_WEIGHT: Partial<Record<GearSlot, number>> = {
  head: 1, body: 1, legs: 1, feet: 1, hands: 1, cloak: 0.8,
  weapon: 1.4, offhand: 0.7, neck: 0.6, ring: 0.9, sigil: 0.6,
};

function pickBase(random: () => number, rarity: Rarity): ItemBase | undefined {
  const pool = basesFor(rarity);
  const slots = [...new Set(pool.map((base) => base.gear))];
  const weights = slots.map((slot) => SLOT_DROP_WEIGHT[slot] ?? 0);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return undefined;

  let point = random() * total;
  let slot = slots[slots.length - 1]!;
  for (let i = 0; i < slots.length; i++) {
    point -= weights[i]!;
    if (point < 0) {
      slot = slots[i]!;
      break;
    }
  }
  const candidates = pool.filter((base) => base.gear === slot);
  return candidates[Math.floor(random() * candidates.length)];
}

function newSeed(random: () => number): number {
  return Math.floor(random() * 0x100000000) >>> 0;
}

export interface DropContext {
  creatureLevel: number;
  /** The Ostra's health multiplier: 1 on Terra, 1.5 on Barals. */
  ostraDanger: number;
  /** Rarity tilt: the Ostra's danger and the creature's level together. */
  danger: number;
  source: LootSource;
  /** The creature's own find, tried first. */
  signature?: { base: string; chance: number };
}

/** Roll one drop, or nothing. */
export function rollDrop(random: () => number, context: DropContext): ItemKey | undefined {
  const level = rollItemLevel(random, context.creatureLevel, context.ostraDanger);

  const signature = context.signature;
  if (signature && random() < signature.chance) {
    const base = getBase(signature.base);
    if (base?.rarity) return encodeItem({ base: base.id, level, rarity: base.rarity, seed: newSeed(random) });
  }

  const rarity = rollRarity(random, context.source, context.danger);
  const base = pickBase(random, rarity);
  if (!base) return undefined;
  return encodeItem({ base: base.id, level, rarity, seed: newSeed(random) });
}

/** Development only: one item of exactly this rarity and level. */
export function rollDebugItem(random: () => number, rarity: Rarity, level: number): ItemKey | undefined {
  const base = pickBase(random, rarity);
  if (!base) return undefined;
  return encodeItem({ base: base.id, level, rarity, seed: newSeed(random) });
}

// --- saves from before items were generated --------------------------------------

/** What each old fixed item becomes. Levels are generous: these were found by
 *  people who played the game before it changed under them. */
const LEGACY_ITEMS: Record<string, { base: string; rarity: Rarity; level: number }> = {
  chippedBlade: { base: "sword", rarity: "common", level: 10 },
  voidsteelEdge: { base: "sword", rarity: "uncommon", level: 20 },
  gatecutter: { base: "gatecutter", rarity: "legendary", level: 30 },
  travellersWrap: { base: "clothBody", rarity: "common", level: 10 },
  wardedMail: { base: "heavyBody", rarity: "uncommon", level: 20 },
  ashenPlate: { base: "ashenPlate", rarity: "legendary", level: 30 },
  manaBead: { base: "neck", rarity: "common", level: 10 },
  aequumFocus: { base: "sigil", rarity: "uncommon", level: 20 },
  phaseLordsTear: { base: "phaseLordsTear", rarity: "legendary", level: 30 },
  greywolfMantle: { base: "greywolfMantle", rarity: "uncommon", level: 20 },
  tuskCharm: { base: "tuskCharm", rarity: "uncommon", level: 20 },
  fenwaterPhial: { base: "fenwaterPhial", rarity: "uncommon", level: 20 },
  emberheart: { base: "emberheart", rarity: "rare", level: 30 },
  cairnstoneMaul: { base: "cairnstoneMaul", rarity: "rare", level: 30 },
};

/** Old equipment was three slots. */
export const LEGACY_SLOTS: Record<string, EquipSlot> = {
  weapon: "weapon",
  armour: "body",
  trinket: "sigil",
};

/** A stable seed from an old id, so a migrated item is the same item on every
 *  load until it is saved in the new form. */
function seedFromText(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** A valid key as it is; an old item id as its new form; anything else, nothing. */
export function migrateItem(value: unknown): ItemKey | undefined {
  if (isItemKey(value)) return value;
  if (typeof value !== "string" || !Object.hasOwn(LEGACY_ITEMS, value)) return undefined;
  const legacy = LEGACY_ITEMS[value]!;
  return encodeItem({ ...legacy, seed: seedFromText(value) });
}
