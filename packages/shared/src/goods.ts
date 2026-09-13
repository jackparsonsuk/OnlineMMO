/**
 * Goods: things you gather rather than wear — fish now, and timber, ore and
 * food as the other trades arrive.
 *
 * They are nothing like items. An item is one of a kind: a key with a seed, a
 * name rolled from it, stats, a place on the body. A perch is a perch. So goods
 * are plain counts by id, kept in the **satchel** beside the pack and never in
 * its thirty slots:
 *
 *  - Every pack operation — sell, wear, destroy, pick up — finds an item by its
 *    key, and a key whose count changed would stop being the same key. Stacks
 *    in the pack would have meant touching all of them.
 *  - A catch never fails because the pack is full of swords. The pack filling
 *    is the thing that sends you back to town; a trade should not be stopped by
 *    it. The same reason quests count what you collect rather than carry it.
 *
 * Each good has a `stack`: the most of it one character can carry. Past that a
 * catch is let go, which keeps anyone from hoarding a lake, and a vendor always
 * takes what you have.
 */

export type GoodKind = "fish";

export interface GoodDefinition {
  id: string;
  name: string;
  kind: GoodKind;
  /** One line, in the voice of the item lore. */
  lore: string;
  /** Gold a vendor pays for one. */
  price: number;
  /** The most one character can carry. */
  stack: number;
}

const FISH_STACK = 100;

const fish = (id: string, name: string, price: number, lore: string): GoodDefinition =>
  ({ id, name, kind: "fish", price, stack: FISH_STACK, lore });

export const GOODS = {
  // Ponds and millponds: what anyone catches first.
  minnow: fish("minnow", "Millpond Minnow", 1, "More bone than fish. The cats of Daso have never once complained."),
  perch: fish("perch", "Redfin Perch", 2, "Striped like a sunset, and about as easy to hold on to."),
  roach: fish("roach", "Silver Roach", 2, "Common as mud, and very nearly the same colour when it is dead."),
  // The Lowfen's meres.
  loach: fish("loach", "Mere Loach", 3, "Lives in the mud and tastes of it. Fen folk swear by it anyway."),
  eel: fish("eel", "Fen Eel", 5, "Slides out of the net, out of the bucket and, given half a chance, out of the pan."),
  // The Brightwater's lakes, and Fanshona's.
  pike: fish("pike", "Reed Pike", 6, "All teeth and grudges. It was eating the perch; now something is eating it."),
  carp: fish("carp", "Gate Carp", 7, "Said to have come through the Gate the day it opened, and to remember the other side."),
  lanternfin: fish("lanternfin", "Lanternfin", 14, "Its fins hold a little light for an hour after it leaves the water."),
  // The Morning Sea.
  herring: fish("herring", "Morning Herring", 3, "Caught at first light, by the shoal, off every shore that faces the sun."),
  mackerel: fish("mackerel", "Barred Mackerel", 5, "Fast, oily and blue as the water it came out of."),
  bream: fish("bream", "Sea Bream", 8, "Fanshona's traders ask where it came from, because the lake has none."),
  cod: fish("cod", "Drop-off Cod", 10, "Takes the bait right at the edge, where the shallows end and the dark begins."),
  sunscale: fish("sunscale", "Sunscale", 22, "Gold down its flank. Fishers say it only rises for someone the sea has taken a liking to."),
} satisfies Record<string, GoodDefinition>;

export type GoodId = keyof typeof GOODS;

export const GOOD_IDS = Object.keys(GOODS) as GoodId[];

export function isGoodId(value: unknown): value is GoodId {
  return typeof value === "string" && Object.hasOwn(GOODS, value);
}

/** What a character carries, by id. A missing id is none. */
export type Goods = Partial<Record<GoodId, number>>;

/**
 * Put some goods in the satchel, up to the good's stack. Returns how many went
 * in; the rest are let go.
 */
export function addGoods(goods: Goods, id: GoodId, count: number): number {
  const have = goods[id] ?? 0;
  const added = Math.max(0, Math.min(Math.floor(count), GOODS[id].stack - have));
  if (added > 0) goods[id] = have + added;
  return added;
}

/** What goods fetch at a vendor. */
export function goodsValue(goods: Goods): number {
  let total = 0;
  for (const id of GOOD_IDS) total += (goods[id] ?? 0) * GOODS[id].price;
  return total;
}

/** How many goods, of every kind, are carried. */
export function goodsCount(goods: Goods): number {
  let total = 0;
  for (const id of GOOD_IDS) total += goods[id] ?? 0;
  return total;
}

/**
 * A satchel from the wire or a save, trusted for nothing: unknown ids dropped
 * (a good a later build removed should vanish, not crash the load), counts
 * made whole numbers and held to the stack.
 */
export function sanitiseGoods(raw: unknown): Goods {
  const goods: Goods = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return goods;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isGoodId(id) || typeof value !== "number" || !Number.isFinite(value)) continue;
    const count = Math.min(GOODS[id].stack, Math.floor(value));
    if (count > 0) goods[id] = count;
  }
  return goods;
}
