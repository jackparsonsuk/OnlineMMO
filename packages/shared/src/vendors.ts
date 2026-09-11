/**
 * Vendors: somewhere to turn a full pack into gold, and gold into gear.
 *
 * Loot drops far faster than it can be worn, and a pack of thirty fills in a
 * few camps. A vendor takes anything — one item or the whole bag at once — and
 * sells plain, common gear at your own level: nothing a lucky drop will not
 * beat, but always something, so a bad run of drops never leaves an empty slot.
 *
 * Like quest rewards, a vendor's stock is a pure function (of the vendor and
 * your level) — the client shows exactly what the server will sell, and
 * asking again cannot reroll it. Only the server ever moves gold or items.
 */

import type { ClassId } from "./classes.js";
import { basesFor, describeItem, encodeItem, type GearSlot, type Item, type ItemKey, type Rarity } from "./items.js";
import { LEVEL_SCALE, MAX_LEVEL } from "./levels.js";
import { hash2 } from "./noise.js";

/** What each rarity sells for, as a multiple of a common of the same power. */
const RARITY_VALUE: Record<Rarity, number> = {
  common: 1, uncommon: 1.6, rare: 2.5, mythic: 5, legendary: 8, world: 12, ostra: 12,
};

/** A vendor sells for this many times what it would pay you. */
export const VENDOR_MARKUP = 4;

/** Gold a vendor pays for an item: its power, weighted by rarity. Never
 *  nothing, or selling junk would not be worth the click. */
export function sellPrice(item: Item): number {
  return Math.max(1, Math.round((item.power / 8) * RARITY_VALUE[item.rarity]));
}

/** Gold a vendor asks for an item. */
export function buyPrice(item: Item): number {
  return sellPrice(item) * VENDOR_MARKUP;
}

/** What a whole pack fetches. */
export function packValue(inventory: readonly ItemKey[]): number {
  let total = 0;
  for (const key of inventory) {
    const item = describeItem(key);
    if (item) total += sellPrice(item);
  }
  return total;
}

/** The slots a vendor stocks, one item each, of whatever the buyer's class
 *  can use there. */
const STOCK: readonly GearSlot[] = [
  "head", "body", "legs", "feet", "hands", "cloak", "weapon", "offhand", "ring", "neck",
];

/** What vendors sell: always plain. Rarer gear is found, never bought. */
const STOCK_RARITY: Rarity = "common";

function mix(text: string, h = 0x811c9dc5): number {
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/**
 * Everything a vendor has for a character of this class and `level`: common
 * gear of that level that the class can use, one piece per slot. Integer
 * hashing only, so both sides agree on every item. It changes as you level —
 * the smith always has something that fits — and never otherwise.
 */
export function vendorStock(vendorId: string, level: number, classId: ClassId): ItemKey[] {
  const clamped = Math.max(1, Math.min(MAX_LEVEL, Math.floor(level)));
  const h = mix(`${vendorId}:${clamped}:${classId}`);
  const pool = basesFor(STOCK_RARITY, classId).filter((base) => base.name === undefined);
  const items: ItemKey[] = [];
  STOCK.forEach((gear, n) => {
    const candidates = pool.filter((base) => base.gear === gear);
    if (candidates.length === 0) return;
    const base = candidates[hash2(h, n, 0x5e11) % candidates.length]!;
    items.push(encodeItem({
      base: base.id,
      level: clamped * LEVEL_SCALE,
      rarity: STOCK_RARITY,
      seed: hash2(h, n, 0xb0b),
      classId,
    }));
  });
  return items;
}
