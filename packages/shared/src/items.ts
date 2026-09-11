/**
 * Things you can pick up and wear.
 *
 * Items are GENERATED, not listed. An item is four numbers —
 *
 *   { base, level, rarity, seed }
 *
 * — and everything else about it (its name, its stats, its line of history)
 * is derived from those by the functions in this file, identically on both
 * sides of the wire. That keeps an item small enough to store as a short string
 * in a JSON column and to replicate on the ground, gives effectively endless
 * variety, and means the client can show a full tooltip for something it has
 * never been told anything about but the key. The server is still the only one
 * that ROLLS items (see `loot.ts`); the client only ever describes them.
 *
 * Every item asks a character level of whoever would wear it (see
 * `requiredLevel`): a lucky drop from something tougher than you is one you
 * carry until you have grown into it.
 */

import { baseStats, CLASSES, classUsesFamily, isClassId, type ClassId } from "./classes.js";
import { hashUnit } from "./noise.js";
import { itemLore, itemName } from "./itemNames.js";
import { LEVEL_SCALE, MAX_LEVEL } from "./levels.js";
import {
  emptyTotals,
  STATS,
  STAT_ORDER,
  type PrimaryStat,
  type SecondaryStat,
  type StatBlock,
  type StatTotals,
} from "./stats.js";

// --- slots ----------------------------------------------------------------------

/** What kind of thing an item is, by where it goes. */
export type GearSlot =
  | "head" | "neck" | "cloak" | "body" | "hands" | "ring" | "legs" | "feet"
  | "weapon" | "offhand" | "sigil" | "soul";

/** A place on the body. Two hands means two rings. */
export type EquipSlot = Exclude<GearSlot, "ring"> | "ring1" | "ring2";

export const EQUIP_SLOTS: EquipSlot[] = [
  "head", "neck", "cloak", "body", "hands", "ring1", "ring2", "legs", "feet",
  "weapon", "offhand", "sigil", "soul",
];

export function isEquipSlot(value: unknown): value is EquipSlot {
  return typeof value === "string" && (EQUIP_SLOTS as string[]).includes(value);
}

export const SLOT_NAMES: Record<EquipSlot, string> = {
  head: "Head", neck: "Neck", cloak: "Cloak", body: "Body", hands: "Hands",
  ring1: "Ring", ring2: "Ring", legs: "Legs", feet: "Feet",
  weapon: "Weapon", offhand: "Off hand", sigil: "Sigil", soul: "Soul",
};

export const GEAR_NAMES: Record<GearSlot, string> = {
  head: "Head", neck: "Neck", cloak: "Cloak", body: "Body", hands: "Hands", ring: "Ring",
  legs: "Legs", feet: "Feet", weapon: "Weapon", offhand: "Off hand", sigil: "Sigil", soul: "Soul",
};

/**
 * Share of a full item's stat budget each kind of piece carries. The body and
 * the weapon are the big pieces; a ring is half of one. Two-handed weapons get
 * TWO_HANDED_WEIGHT instead, because they cost you the off hand.
 */
const SLOT_WEIGHT: Record<GearSlot, number> = {
  head: 0.85, neck: 0.55, cloak: 0.55, body: 1, hands: 0.7, ring: 0.5, legs: 0.9, feet: 0.7,
  weapon: 1, offhand: 0.6, sigil: 0.7, soul: 1,
};
const TWO_HANDED_WEIGHT = 1.7;

// --- rarity ---------------------------------------------------------------------

export type Rarity = "common" | "uncommon" | "rare" | "mythic" | "legendary" | "world" | "ostra";

export const RARITIES: Rarity[] = ["common", "uncommon", "rare", "mythic", "legendary", "world", "ostra"];

/**
 * Where a drop came from. Ordinary creatures never drop anything above rare —
 * mythic and up must be EARNED from something that is itself rare, or from a
 * dungeon or raid, or the top of the table stops meaning anything.
 */
export type LootSource = "creature" | "elite" | "dungeon" | "raid";

export interface RarityDefinition {
  name: string;
  /** Drawn in this colour everywhere: on the ground, in the bag, in a name. */
  colour: number;
  /** Multiplier on the stat budget. */
  budget: number;
  /** How many primary and secondary stats an item of this rarity rolls. */
  primaries: number;
  secondaries: number;
  /** One line for the tooltip. */
  description: string;
}

export const RARITY: Record<Rarity, RarityDefinition> = {
  common: {
    name: "Common", colour: 0xc4ccd4, budget: 1, primaries: 1, secondaries: 0,
    description: "Everywhere, and worth about that.",
  },
  uncommon: {
    name: "Uncommon", colour: 0x5fd068, budget: 1.15, primaries: 2, secondaries: 1,
    description: "A cut above what most people carry.",
  },
  rare: {
    name: "Rare", colour: 0x4a9cf0, budget: 1.32, primaries: 2, secondaries: 2,
    description: "Worth remembering where you found it.",
  },
  mythic: {
    name: "Mythic", colour: 0xb06cf0, budget: 1.52, primaries: 2, secondaries: 3,
    description: "Only from dungeons, raids, or something very rare.",
  },
  legendary: {
    name: "Legendary", colour: 0xf28c28, budget: 1.75, primaries: 2, secondaries: 3,
    description: "Spoken of. Rarely seen.",
  },
  world: {
    name: "World", colour: 0xf5d76e, budget: 2, primaries: 2, secondaries: 4,
    description: "There is only one of it in the realm.",
  },
  ostra: {
    name: "Ostra", colour: 0x4fe0d0, budget: 2, primaries: 2, secondaries: 4,
    description: "A piece of an Ostra itself.",
  },
};

export function isRarity(value: unknown): value is Rarity {
  return typeof value === "string" && (RARITIES as string[]).includes(value);
}

/** `#rrggbb`, for CSS. */
export function rarityHex(rarity: Rarity): string {
  return `#${RARITY[rarity].colour.toString(16).padStart(6, "0")}`;
}

// --- families -------------------------------------------------------------------

/**
 * What sort of thing an item is within its slot: the weight of a piece of
 * armour, the family of a weapon. Used for names, glyphs, and the rules that
 * care about weight — heavy armour slowing mana.
 */
export type ArmourWeight = "cloth" | "light" | "heavy";
export type WeaponFamily = "swords" | "axes" | "maces" | "daggers" | "staves" | "wands";
export type ItemFamily = ArmourWeight | WeaponFamily | "shields" | "foci" | "jewellery";

export const FAMILY_NAMES: Record<ItemFamily, string> = {
  cloth: "Cloth Armour", light: "Light Armour", heavy: "Heavy Armour",
  swords: "Sword", axes: "Axe", maces: "Mace", daggers: "Dagger", staves: "Staff", wands: "Wand",
  shields: "Shield", foci: "Focus", jewellery: "Jewellery",
};

// --- bases ----------------------------------------------------------------------

/**
 * A kind of item: what it is, what family it belongs to, what it tends to
 * roll. Each generated item picks its nouns and stats from its base.
 */
export interface ItemBase {
  id: string;
  gear: GearSlot;
  /** Undefined for a Soul, which belongs to nothing but you. */
  family: ItemFamily | undefined;
  /** A one-handed weapon that can go in the off hand as well. */
  offhand?: boolean;
  /** Takes both hands: nothing may be worn in the off hand beside it. */
  twoHanded?: boolean;
  /** Primary stats it may roll. Repeats weight the pick. */
  primaries: readonly PrimaryStat[];
  /** Secondary stats it may roll. Repeats weight the pick. */
  secondaries: readonly SecondaryStat[];
  /** Inherent armour, as a fraction of a heavy piece's. */
  armour?: number;
  /** Multiplier on the stat budget. Cloth rolls more stats because it rolls
   *  far less armour; heavy the reverse. */
  budget?: number;
  nouns: readonly string[];
  materials: readonly string[];
  /** A named item: always this name and this lore, whatever the seed. */
  name?: string;
  lore?: string;
  /** Only ever dropped by one creature; kept out of the random pool. */
  signature?: boolean;
  /** Always this rarity, whatever was rolled. Named items only. */
  rarity?: Rarity;
}

const CLOTH = { family: "cloth", armour: 0.3, budget: 1.15,
  primaries: ["focus", "focus", "spirit", "spirit", "vigour"],
  secondaries: ["recovery", "recovery", "crit", "leech"],
  materials: ["Linen", "Woollen", "Silken", "Felt", "Spun", "Embroidered", "Lakeweave"] } as const;
const LIGHT = { family: "light", armour: 0.6, budget: 1.05,
  primaries: ["might", "might", "focus", "vigour", "vigour"],
  secondaries: ["crit", "crit", "leech", "leech", "recovery"],
  materials: ["Leather", "Hide", "Wolfhide", "Boarhide", "Studded", "Oiled", "Webbed"] } as const;
const HEAVY = { family: "heavy", armour: 1, budget: 0.95,
  // Leans Might: heavy already rolls the most armour, and a suit that also
  // rolled mostly Vigour would be a wall that never kills anything.
  primaries: ["might", "might", "might", "vigour", "vigour"],
  secondaries: ["armour", "armour", "recovery", "crit"],
  materials: ["Iron", "Steel", "Bronze", "Voidsteel", "Blackiron", "Warded", "Cairnstone"] } as const;

const METALS = ["Iron", "Steel", "Bronze", "Voidsteel", "Blackiron", "Bone", "Ashwood"] as const;
const WOODS = ["Ashwood", "Yew", "Driftwood", "Bone", "Crystal", "Oak", "Blackthorn"] as const;
const JEWELS = ["Silver", "Gold", "Copper", "Bone", "Amber", "Jet", "Glass", "Voidglass"] as const;
const TRINKET_PRIMARIES = ["might", "focus", "vigour", "spirit"] as const;
const TRINKET_SECONDARIES = ["crit", "recovery", "leech", "armour"] as const;

export const ITEM_BASES: Record<string, ItemBase> = {
  // --- armour: three weights, six pieces each -----------------------------------
  clothHead: { id: "clothHead", gear: "head", ...CLOTH, nouns: ["Hood", "Cowl", "Coif", "Wrap", "Cap"] },
  clothBody: { id: "clothBody", gear: "body", ...CLOTH, nouns: ["Robe", "Vestments", "Tunic", "Garb", "Wrap"] },
  clothLegs: { id: "clothLegs", gear: "legs", ...CLOTH, nouns: ["Leggings", "Trousers", "Breeches", "Kilt"] },
  clothFeet: { id: "clothFeet", gear: "feet", ...CLOTH, nouns: ["Slippers", "Sandals", "Shoes", "Footwraps"] },
  clothHands: { id: "clothHands", gear: "hands", ...CLOTH, nouns: ["Gloves", "Handwraps", "Mitts"] },
  clothCloak: { id: "clothCloak", gear: "cloak", ...CLOTH, nouns: ["Cloak", "Shawl", "Cape"] },

  lightHead: { id: "lightHead", gear: "head", ...LIGHT, nouns: ["Cap", "Hood", "Mask", "Coif"] },
  lightBody: { id: "lightBody", gear: "body", ...LIGHT, nouns: ["Jerkin", "Tunic", "Vest", "Brigandine", "Jacket"] },
  lightLegs: { id: "lightLegs", gear: "legs", ...LIGHT, nouns: ["Leggings", "Chaps", "Breeches", "Trousers"] },
  lightFeet: { id: "lightFeet", gear: "feet", ...LIGHT, nouns: ["Boots", "Treads", "Striders"] },
  lightHands: { id: "lightHands", gear: "hands", ...LIGHT, nouns: ["Gloves", "Grips", "Handguards"] },
  lightCloak: { id: "lightCloak", gear: "cloak", ...LIGHT, nouns: ["Mantle", "Cloak", "Pelt"] },

  heavyHead: { id: "heavyHead", gear: "head", ...HEAVY, nouns: ["Helm", "Greathelm", "Sallet", "Bascinet", "Visor"] },
  heavyBody: { id: "heavyBody", gear: "body", ...HEAVY, nouns: ["Breastplate", "Hauberk", "Cuirass", "Mail"] },
  heavyLegs: { id: "heavyLegs", gear: "legs", ...HEAVY, nouns: ["Legplates", "Greaves", "Cuisses", "Chausses"] },
  heavyFeet: { id: "heavyFeet", gear: "feet", ...HEAVY, nouns: ["Sabatons", "Warboots", "Ironshod Boots"] },
  heavyHands: { id: "heavyHands", gear: "hands", ...HEAVY, nouns: ["Gauntlets", "Handplates", "Fists"] },
  heavyCloak: { id: "heavyCloak", gear: "cloak", ...HEAVY, nouns: ["Warcloak", "Mantle", "Drape"] },

  // --- weapons ----------------------------------------------------------------------
  sword: {
    id: "sword", gear: "weapon", family: "swords",
    primaries: ["might", "might", "vigour"], secondaries: ["crit", "leech"],
    nouns: ["Sword", "Blade", "Longsword", "Sabre", "Falchion"], materials: METALS,
  },
  greatsword: {
    id: "greatsword", gear: "weapon", family: "swords", twoHanded: true,
    primaries: ["might", "might", "vigour"], secondaries: ["crit", "leech"],
    nouns: ["Greatsword", "Warblade", "Claymore"], materials: METALS,
  },
  axe: {
    id: "axe", gear: "weapon", family: "axes",
    primaries: ["might"], secondaries: ["crit", "crit", "leech"],
    nouns: ["Axe", "Hatchet", "Cleaver", "Bearded Axe"], materials: METALS,
  },
  greataxe: {
    id: "greataxe", gear: "weapon", family: "axes", twoHanded: true,
    primaries: ["might", "might", "vigour"], secondaries: ["crit", "leech"],
    nouns: ["Greataxe", "Poleaxe", "Felling Axe"], materials: METALS,
  },
  mace: {
    id: "mace", gear: "weapon", family: "maces",
    primaries: ["might", "vigour"], secondaries: ["crit", "armour"],
    nouns: ["Mace", "Hammer", "Club", "Morningstar", "Flail"], materials: METALS,
  },
  maul: {
    id: "maul", gear: "weapon", family: "maces", twoHanded: true,
    primaries: ["might", "vigour"], secondaries: ["crit", "armour"],
    nouns: ["Maul", "Warhammer", "Great Club"], materials: METALS,
  },
  dagger: {
    id: "dagger", gear: "weapon", family: "daggers", offhand: true,
    primaries: ["might", "might", "focus"], secondaries: ["crit", "leech", "leech"],
    nouns: ["Dagger", "Knife", "Dirk", "Stiletto"], materials: METALS,
  },
  staff: {
    id: "staff", gear: "weapon", family: "staves", twoHanded: true,
    primaries: ["focus", "focus", "spirit"], secondaries: ["crit", "recovery"],
    nouns: ["Staff", "Stave", "Crook", "Spire"], materials: WOODS,
  },
  wand: {
    id: "wand", gear: "weapon", family: "wands",
    primaries: ["focus", "focus", "spirit"], secondaries: ["crit", "recovery"],
    nouns: ["Wand", "Rod", "Baton", "Switch"], materials: WOODS,
  },

  // --- off hand ---------------------------------------------------------------------
  shield: {
    id: "shield", gear: "offhand", family: "shields", armour: 1.2,
    primaries: ["vigour", "vigour", "might"], secondaries: ["armour", "recovery"],
    nouns: ["Shield", "Buckler", "Kite Shield", "Targe", "Heater"], materials: METALS,
  },
  focus: {
    id: "focus", gear: "offhand", family: "foci",
    primaries: ["focus", "spirit"], secondaries: ["recovery", "crit"],
    nouns: ["Orb", "Tome", "Lantern", "Codex", "Prism"], materials: JEWELS,
  },

  // --- trinkets -----------------------------------------------------------------------
  neck: {
    id: "neck", gear: "neck", family: "jewellery",
    primaries: TRINKET_PRIMARIES, secondaries: TRINKET_SECONDARIES,
    nouns: ["Amulet", "Pendant", "Torc", "Locket", "Chain"], materials: JEWELS,
  },
  ring: {
    id: "ring", gear: "ring", family: "jewellery",
    primaries: TRINKET_PRIMARIES, secondaries: TRINKET_SECONDARIES,
    nouns: ["Ring", "Band", "Signet", "Loop", "Seal"], materials: JEWELS,
  },
  sigil: {
    id: "sigil", gear: "sigil", family: "jewellery",
    primaries: TRINKET_PRIMARIES, secondaries: TRINKET_SECONDARIES,
    nouns: ["Sigil", "Glyph", "Rune", "Mark", "Emblem", "Token"], materials: JEWELS,
  },

  // --- named ----------------------------------------------------------------------------
  // Items from before gear was generated. Kept, by name, because "Gatecutter"
  // is worth finding in a way a generated sword never quite is. They roll level
  // and exact numbers like anything else; the name and story are fixed.
  gatecutter: {
    id: "gatecutter", gear: "weapon", family: "swords",
    primaries: ["might", "focus"], secondaries: ["crit", "leech", "recovery"],
    nouns: ["Sword"], materials: METALS,
    name: "Gatecutter", lore: "Older than the shutting of the Gates. It remembers.", rarity: "legendary",
  },
  phaseLordsTear: {
    id: "phaseLordsTear", gear: "sigil", family: "jewellery",
    primaries: ["focus", "vigour"], secondaries: ["crit", "recovery", "leech"],
    nouns: ["Tear"], materials: JEWELS,
    name: "Phase Lord's Tear", lore: "Dronas and Solnajar have been fighting since Y0. Something fell.",
    rarity: "legendary",
  },
  ashenPlate: {
    id: "ashenPlate", gear: "body", ...HEAVY,
    nouns: ["Plate"], name: "Ashen Plate", lore: "Pulled from the Black Tide's edge. Still warm.",
    rarity: "legendary",
  },

  // --- signatures -------------------------------------------------------------------------
  // One per creature, found nowhere else. Never in the random pool.
  greywolfMantle: {
    id: "greywolfMantle", gear: "cloak", ...LIGHT, primaries: ["vigour", "might"],
    nouns: ["Mantle"], name: "Greywolf Mantle", lore: "Still smells of the pack. So do you, now.",
    signature: true, rarity: "uncommon",
  },
  tuskCharm: {
    id: "tuskCharm", gear: "neck", family: "jewellery", primaries: ["might", "vigour"],
    secondaries: ["crit"], nouns: ["Charm"], materials: JEWELS,
    name: "Tusk Charm", lore: "Whittled from a Thornback that did not stop in time.",
    signature: true, rarity: "uncommon",
  },
  fenwaterPhial: {
    id: "fenwaterPhial", gear: "sigil", family: "jewellery", primaries: ["spirit", "focus"],
    secondaries: ["recovery"], nouns: ["Phial"], materials: JEWELS,
    name: "Fenwater Phial", lore: "Murky, faintly warm, and it hums when you cast.",
    signature: true, rarity: "uncommon",
  },
  emberheart: {
    id: "emberheart", gear: "sigil", family: "jewellery", primaries: ["focus", "might"],
    secondaries: ["crit", "leech"], nouns: ["Heart"], materials: JEWELS,
    name: "Emberheart", lore: "What is left when a wisp stops burning. It has not stopped.",
    signature: true, rarity: "rare",
  },
  cairnstoneMaul: {
    id: "cairnstoneMaul", gear: "weapon", family: "maces", twoHanded: true,
    primaries: ["might", "vigour"], secondaries: ["armour", "crit"], nouns: ["Maul"], materials: METALS,
    name: "Cairnstone Maul", lore: "A golem's fist, more or less. Heavy in a reassuring way.",
    signature: true, rarity: "rare",
  },
};

export function getBase(id: string): ItemBase | undefined {
  return Object.hasOwn(ITEM_BASES, id) ? ITEM_BASES[id] : undefined;
}

/** Bases a random drop may be, of a given rarity — for a class, only what it
 *  can use. Named items join the pool only at their own rarity; signatures
 *  never do. */
export function basesFor(rarity: Rarity, classId?: ClassId): ItemBase[] {
  return Object.values(ITEM_BASES).filter((base) =>
    !base.signature && base.gear !== "soul" && (base.rarity === undefined || base.rarity === rarity)
    && (classId === undefined || classUsesFamily(classId, base.family)));
}

// --- instances ----------------------------------------------------------------------

/** Ten item levels to a character level, all the way to the top. */
export const MAX_ITEM_LEVEL = MAX_LEVEL * LEVEL_SCALE;

export interface ItemInstance {
  base: string;
  /** 1 to MAX_ITEM_LEVEL. Sets its stat budget, and the character level it
   *  asks for (see `requiredLevel`). */
  level: number;
  rarity: Rarity;
  /** Everything else about it comes from here. */
  seed: number;
  /**
   * The class it was rolled for, which decides which primary stats it can
   * roll (`ClassDefinition.stats`). Absent on items from before classes,
   * which roll from their base's whole list as they always did.
   */
  classId?: ClassId;
}

/**
 * An item as a short string — `heavyHead.120.2.1k3j9a.warrior` — which is its
 * identity everywhere: in the bag, on the body, on the ground, in the save.
 * The class is a fifth part, so every four-part key from before it still
 * means exactly the item it always did.
 */
export type ItemKey = string;

export function encodeItem(item: ItemInstance): ItemKey {
  const key = `${item.base}.${item.level}.${RARITIES.indexOf(item.rarity)}.${(item.seed >>> 0).toString(36)}`;
  return item.classId ? `${key}.${item.classId}` : key;
}

/** Anything that is not exactly a valid key is refused: keys come from the
 *  wire and from saves, and neither is to be trusted. */
export function decodeItem(key: unknown): ItemInstance | undefined {
  if (typeof key !== "string" || key.length > 64) return undefined;
  const parts = key.split(".");
  if (parts.length !== 4 && parts.length !== 5) return undefined;
  const [baseId, levelText, rarityText, seedText, classText] = parts as [string, string, string, string, string?];

  const base = getBase(baseId);
  if (!base) return undefined;
  if (!/^\d{1,4}$/.test(levelText) || !/^\d$/.test(rarityText) || !/^[0-9a-z]{1,7}$/.test(seedText)) {
    return undefined;
  }
  if (classText !== undefined && !isClassId(classText)) return undefined;
  const level = Number(levelText);
  const rarity = RARITIES[Number(rarityText)];
  const seed = parseInt(seedText, 36);
  if (level < 1 || level > MAX_ITEM_LEVEL || !rarity || seed > 0xffffffff) return undefined;

  return classText === undefined ? { base: baseId, level, rarity, seed } : { base: baseId, level, rarity, seed, classId: classText };
}

export function isItemKey(value: unknown): value is ItemKey {
  return decodeItem(value) !== undefined;
}

// --- describing an item --------------------------------------------------------------

/** Everything about an item a player might want to know, derived from its key. */
export interface Item extends ItemInstance {
  key: ItemKey;
  def: ItemBase;
  name: string;
  lore: string;
  gear: GearSlot;
  family: ItemFamily | undefined;
  twoHanded: boolean;
  /** The character level it takes to wear it. */
  requiredLevel: number;
  /** Armour included. */
  stats: StatBlock;
  /** One number for "is this better": the budget it was rolled with. */
  power: number;
}

/** Stat points a full-weight common item of this level is rolled with. */
function itemBudget(level: number): number {
  return 3 + 0.12 * level;
}

/** Armour on a full-weight heavy common piece of this level. */
function inherentArmour(level: number): number {
  return 4 + 0.8 * level;
}

/** An independent stream of numbers from one seed. `hashUnit` is integer
 *  maths only, so every engine agrees on every value. */
function stream(seed: number, salt: number): () => number {
  let n = 0;
  return () => hashUnit(seed | 0, n++, salt);
}

/** Draw up to `count` distinct stats from a weighted list. */
function drawDistinct<T extends string>(from: readonly T[], count: number, rng: () => number, ordered: boolean): T[] {
  const chosen: T[] = [];
  const pool = [...from];
  while (chosen.length < count && pool.length > 0) {
    const index = ordered ? 0 : Math.floor(rng() * pool.length) % pool.length;
    const stat = pool[index]!;
    chosen.push(stat);
    for (let i = pool.length - 1; i >= 0; i--) if (pool[i] === stat) pool.splice(i, 1);
  }
  return chosen;
}

/**
 * The primaries an item may roll: its base's, narrowed to what the class it
 * was rolled for can use. Anything the class uses that the base does not list
 * is added once at the end, so a base that has lost most of its list — a
 * dagger without its Focus — can still roll two stats, and a named item keeps
 * its own stats first.
 */
function primaryPool(def: ItemBase, classId: ClassId | undefined): readonly PrimaryStat[] {
  if (!classId) return def.primaries;
  const allowed = CLASSES[classId].stats;
  const pool = def.primaries.filter((stat) => allowed.includes(stat));
  for (const stat of allowed) if (!pool.includes(stat)) pool.push(stat);
  return pool;
}

const cache = new Map<ItemKey, Item>();
const CACHE_LIMIT = 4096;

/**
 * Work out everything about an item from its key. Memoised: the server asks
 * this for every worn piece whenever stats are recomputed, and the client for
 * every tooltip.
 */
export function describeItem(key: ItemKey): Item | undefined {
  const hit = cache.get(key);
  if (hit) return hit;

  const instance = decodeItem(key);
  if (!instance) return undefined;
  const def = ITEM_BASES[instance.base]!;
  // A named item is always its own rarity, whatever the key says, so an edited
  // save cannot make a World-grade Tusk Charm.
  const rarity = def.rarity ?? instance.rarity;
  const tier = RARITY[rarity];
  const named = def.name !== undefined;

  const statRng = stream(instance.seed, 0x51a7);
  const nameRng = stream(instance.seed, 0x7a3e);

  const weight = def.twoHanded ? TWO_HANDED_WEIGHT : SLOT_WEIGHT[def.gear];
  const budget = itemBudget(instance.level) * weight * (def.budget ?? 1) * tier.budget;

  const primaries = drawDistinct(primaryPool(def, instance.classId), tier.primaries, statRng, named);
  const secondaries = drawDistinct(def.secondaries, tier.secondaries, statRng, named);

  // Most of the budget is primaries; secondaries take a growing share the
  // more of them there are, so a rare's extra lines are real, not garnish.
  const secondaryShare = secondaries.length === 0 ? 0 : 0.22 + 0.06 * secondaries.length;
  const stats: StatBlock = {};
  const add = (stat: PrimaryStat | SecondaryStat, points: number) => {
    const value = Math.max(1, Math.round(points * STATS[stat].perPoint));
    stats[stat] = (stats[stat] ?? 0) + value;
  };

  const primaryBudget = budget * (1 - secondaryShare);
  if (primaries.length === 1) {
    add(primaries[0]!, primaryBudget);
  } else if (primaries.length >= 2) {
    // The leading stat takes 55-75%, so two items of one base still differ.
    const lead = 0.55 + 0.2 * statRng();
    add(primaries[0]!, primaryBudget * lead);
    add(primaries[1]!, primaryBudget * (1 - lead));
  }

  if (secondaries.length > 0) {
    const secondaryBudget = budget * secondaryShare;
    const shares = secondaries.map(() => 0.7 + 0.6 * statRng());
    const total = shares.reduce((sum, share) => sum + share, 0);
    secondaries.forEach((stat, i) => add(stat, secondaryBudget * (shares[i]! / total)));
  }

  let armour = 0;
  if (def.armour) {
    armour = Math.round(def.armour * weight * inherentArmour(instance.level) * tier.budget);
    stats.armour = (stats.armour ?? 0) + armour;
  }

  const item: Item = {
    ...instance,
    rarity,
    key,
    def,
    name: itemName(def, rarity, primaries, nameRng),
    lore: itemLore(def, rarity, nameRng),
    gear: def.gear,
    family: def.family,
    twoHanded: def.twoHanded === true,
    requiredLevel: requiredLevel(instance.level),
    stats,
    power: Math.round(5 * (budget + armour / 16)),
  };

  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, item);
  return item;
}

/**
 * The character level an item of this item level asks for: its level on the
 * creature scale, so a level-12 wolf's ordinary drops are wearable at 12 and
 * the lucky one from the long tail (`rollItemLevel`) is something to grow into.
 */
export function requiredLevel(itemLevel: number): number {
  return Math.max(1, Math.min(MAX_LEVEL, Math.round(itemLevel / LEVEL_SCALE)));
}

/** Whether a character may put it on: their class uses it, and they are
 *  level enough. Checked by the server on every equip, and by the client to
 *  say why before you try. */
export function canWear(item: Item, wearer: Wearer): boolean {
  return wearer.level >= item.requiredLevel && classUsesFamily(wearer.classId, item.family);
}

/** Which body slots an item can go in, best first. */
export function slotsFor(item: Item): EquipSlot[] {
  if (item.gear === "ring") return ["ring1", "ring2"];
  if (item.gear === "weapon" && item.def.offhand) return ["weapon", "offhand"];
  return [item.gear as EquipSlot];
}

// --- worn gear ------------------------------------------------------------------------

/** What is worn, by slot. A missing slot is empty. */
export type Equipment = Partial<Record<EquipSlot, ItemKey>>;

export interface CharacterStats {
  /** The class's base attributes at this level, plus everything worn. */
  totals: StatTotals;
  /** Sum of every worn item's power. Gear only: "is this better" is a
   *  question about the item, not about your level. */
  power: number;
  /** Pieces of heavy armour worn. They slow mana. */
  heavyPieces: number;
}

/** Armour slots: what "how much of each weight are you wearing" counts. */
export const ARMOUR_SLOTS: EquipSlot[] = ["head", "body", "legs", "feet", "hands", "cloak"];

/** Who is wearing the gear: what they start from before it. */
export interface Wearer {
  classId: ClassId;
  level: number;
}

/**
 * Everything a character adds up to: their class's base attributes at their
 * level, and the worn set on top.
 *
 * Shared because both sides need it: the server to resolve a fight and cap
 * health, the client to show you what a piece would do before you wear it.
 */
export function characterStats(equipment: Equipment, wearer: Wearer): CharacterStats {
  const totals = emptyTotals();
  let power = 0;
  let heavyPieces = 0;

  const base = baseStats(wearer.classId, wearer.level);
  for (const stat of STAT_ORDER) totals[stat] += base[stat] ?? 0;

  for (const slot of EQUIP_SLOTS) {
    const key = equipment[slot];
    if (key === undefined) continue;
    const item = describeItem(key);
    if (!item) continue;
    for (const stat of STAT_ORDER) {
      const value = item.stats[stat];
      if (value) totals[stat] += value;
    }
    power += item.power;
    if (item.family === "heavy") heavyPieces++;
  }

  return { totals, power, heavyPieces };
}

/**
 * Put an item on, returning what came off.
 *
 * Shared so the client can preview exactly what the server will do. Two-handed
 * weapons and off-hand items are mutually exclusive: wearing one takes the
 * other off. Returns undefined if the item cannot go in `slot` at all.
 */
export function wear(equipment: Equipment, item: Item, slot: EquipSlot): { next: Equipment; removed: ItemKey[] } | undefined {
  if (!slotsFor(item).includes(slot)) return undefined;
  const next: Equipment = { ...equipment };
  const removed: ItemKey[] = [];
  const takeOff = (from: EquipSlot) => {
    const worn = next[from];
    if (worn !== undefined) {
      removed.push(worn);
      delete next[from];
    }
  };

  takeOff(slot);
  if (slot === "weapon" && item.twoHanded) takeOff("offhand");
  if (slot === "offhand") {
    const main = next.weapon !== undefined ? describeItem(next.weapon) : undefined;
    if (main?.twoHanded) takeOff("weapon");
  }
  next[slot] = item.key;
  return { next, removed };
}

/** Where a click on an item should put it: the first empty slot it fits, or
 *  the first slot it fits if all are full. */
export function preferredSlot(equipment: Equipment, item: Item): EquipSlot {
  const slots = slotsFor(item);
  return slots.find((slot) => equipment[slot] === undefined) ?? slots[0]!;
}

// --- carrying ---------------------------------------------------------------------------

/** How many items you can carry. Full means drops are left on the ground. */
export const INVENTORY_SIZE = 30;

/** A dropped item lies there this long before the world reclaims it. */
export const GROUND_ITEM_TTL_MS = 90_000;

/** Walk this close and it is yours. No key to press — one less thing between
 *  killing something and being rewarded for it. */
export const PICKUP_RADIUS = 1.4;

/**
 * How long a drop belongs to whoever earned it.
 *
 * Without this the first person to walk over a drop takes it, whoever did the
 * killing — which is fine alone and immediately unfair the moment two people
 * fight the same camp. Short enough that a claimed item nobody collects still
 * becomes everyone's rather than rotting.
 */
export const LOOT_CLAIM_MS = 25_000;

/** Level of item a creature of `level` drops, before luck. */
export function itemLevelFor(creatureLevel: number): number {
  return Math.max(1, Math.round(creatureLevel * LEVEL_SCALE));
}
