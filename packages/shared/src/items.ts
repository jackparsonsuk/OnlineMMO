/**
 * Things you can pick up and wear.
 *
 * Gear is the FAST axis of progression and proficiency is the slow one: a
 * lucky drop changes your numbers today, while training a spell changes them
 * over an evening. Keeping them separate means neither makes the other
 * pointless — you cannot buy your way to a trained spell, and practice does
 * not substitute for a better blade.
 *
 * Stats are flat additions rather than percentages. Flat numbers stay legible
 * next to the ones already on screen ("+5 damage" against Strike's 18), and
 * they do not compound into nonsense once there are more slots.
 */

export type EquipSlot = "weapon" | "armour" | "trinket";

export const EQUIP_SLOTS: EquipSlot[] = ["weapon", "armour", "trinket"];

/** Drives drop odds and the colour it is drawn in. */
export type Rarity = "common" | "fine" | "rare";

export interface ItemStats {
  /** Added to every spell's damage, after proficiency scaling. */
  damage?: number;
  /** Added to maximum health. */
  health?: number;
  /** Added to maximum mana. */
  mana?: number;
}

export interface ItemDefinition {
  id: string;
  name: string;
  slot: EquipSlot;
  rarity: Rarity;
  stats: ItemStats;
  /** One line of flavour. The world is the point of the game. */
  description: string;
  /** Only ever dropped by one creature; kept out of the random pool. */
  signature?: boolean;
}

/**
 * Every item in the game. Named from the setting rather than generically —
 * "Gatecutter" is worth finding in a way that "Sword +3" is not.
 */
export const ITEMS: Record<string, ItemDefinition> = {
  // --- weapons -------------------------------------------------------------
  chippedBlade: {
    id: "chippedBlade",
    name: "Chipped Blade",
    slot: "weapon",
    rarity: "common",
    stats: { damage: 2 },
    description: "Someone else's, once.",
  },
  voidsteelEdge: {
    id: "voidsteelEdge",
    name: "Voidsteel Edge",
    slot: "weapon",
    rarity: "fine",
    stats: { damage: 5 },
    description: "Forged from something that fell between Ostras.",
  },
  gatecutter: {
    id: "gatecutter",
    name: "Gatecutter",
    slot: "weapon",
    rarity: "rare",
    stats: { damage: 9, mana: 10 },
    description: "Older than the shutting of the Gates. It remembers.",
  },

  // --- armour --------------------------------------------------------------
  travellersWrap: {
    id: "travellersWrap",
    name: "Traveller's Wrap",
    slot: "armour",
    rarity: "common",
    stats: { health: 15 },
    description: "Cloth, mostly. Better than nothing, barely.",
  },
  wardedMail: {
    id: "wardedMail",
    name: "Warded Mail",
    slot: "armour",
    rarity: "fine",
    stats: { health: 30, mana: 10 },
    description: "The rings are stamped with an Aequum nobody uses now.",
  },
  ashenPlate: {
    id: "ashenPlate",
    name: "Ashen Plate",
    slot: "armour",
    rarity: "rare",
    stats: { health: 55 },
    description: "Pulled from the Black Tide's edge. Still warm.",
  },

  // --- trinkets ------------------------------------------------------------
  manaBead: {
    id: "manaBead",
    name: "Mana Bead",
    slot: "trinket",
    rarity: "common",
    stats: { mana: 15 },
    description: "Cheap, common, and the first thing every apprentice owns.",
  },
  aequumFocus: {
    id: "aequumFocus",
    name: "Aequum Focus",
    slot: "trinket",
    rarity: "fine",
    stats: { mana: 30, damage: 2 },
    description: "Cut so the light inside it never quite settles.",
  },
  phaseLordsTear: {
    id: "phaseLordsTear",
    name: "Phase Lord's Tear",
    slot: "trinket",
    rarity: "rare",
    stats: { mana: 40, health: 20, damage: 4 },
    description: "Dronas and Solnajar have been fighting since Y0. Something fell.",
  },

  // --- signature drops ------------------------------------------------------
  // One per creature, found nowhere else. Never in the random pool — see
  // `itemsOfRarity`.
  greywolfMantle: {
    id: "greywolfMantle",
    name: "Greywolf Mantle",
    slot: "armour",
    rarity: "fine",
    stats: { health: 25, damage: 2 },
    description: "Still smells of the pack. So do you, now.",
    signature: true,
  },
  tuskCharm: {
    id: "tuskCharm",
    name: "Tusk Charm",
    slot: "trinket",
    rarity: "fine",
    stats: { damage: 4, health: 10 },
    description: "Whittled from a Thornback that did not stop in time.",
    signature: true,
  },
  fenwaterPhial: {
    id: "fenwaterPhial",
    name: "Fenwater Phial",
    slot: "trinket",
    rarity: "fine",
    stats: { mana: 35 },
    description: "Murky, faintly warm, and it hums when you cast.",
    signature: true,
  },
  emberheart: {
    id: "emberheart",
    name: "Emberheart",
    slot: "trinket",
    rarity: "rare",
    stats: { damage: 6, mana: 15 },
    description: "What is left when a wisp stops burning. It has not stopped.",
    signature: true,
  },
  cairnstoneMaul: {
    id: "cairnstoneMaul",
    name: "Cairnstone Maul",
    slot: "weapon",
    rarity: "rare",
    stats: { damage: 11, health: 15 },
    description: "A golem's fist, more or less. Heavy in a reassuring way.",
    signature: true,
  },
};

export const ITEM_IDS = Object.keys(ITEMS);

export function isItemId(value: unknown): value is string {
  return typeof value === "string" && Object.hasOwn(ITEMS, value);
}

export function getItem(id: string): ItemDefinition | undefined {
  return ITEMS[id];
}

/** What is worn, by slot. A missing or undefined slot is empty. */
export type Equipment = Partial<Record<EquipSlot, string>>;

/** How many items you can carry. Full means drops are left on the ground. */
export const INVENTORY_SIZE = 12;

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

/**
 * Everything the worn set adds up to.
 *
 * Shared because both sides need it: the server to resolve damage and cap
 * health, the client to show you what a piece would do before you wear it.
 */
export function equipmentStats(equipment: Equipment): Required<ItemStats> {
  const total = { damage: 0, health: 0, mana: 0 };

  for (const slot of EQUIP_SLOTS) {
    const id = equipment[slot];
    if (id === undefined) continue;
    const item = ITEMS[id];
    if (!item) continue;
    total.damage += item.stats.damage ?? 0;
    total.health += item.stats.health ?? 0;
    total.mana += item.stats.mana ?? 0;
  }

  return total;
}

// --- drops ------------------------------------------------------------------

/**
 * Rarity odds, before the Ostra's difficulty tilts them.
 *
 * A dangerous Ostra paying the same as a safe one would make Barals pure
 * downside, so `danger` (the Ostra's health multiplier) shifts weight from
 * common toward rare. Risk has to buy something.
 */
export function rollRarity(roll: number, danger: number): Rarity {
  // At danger 1.0 this is 70/25/5; at Barals' 1.5 it is nearer 55/32/13.
  const fine = 25 * danger;
  const rare = 5 * danger * danger;
  const common = Math.max(5, 100 - fine - rare);

  const total = common + fine + rare;
  const point = roll * total;
  if (point < common) return "common";
  if (point < common + fine) return "fine";
  return "rare";
}

/** Every item of a given rarity, for picking one at random. */
export function itemsOfRarity(rarity: Rarity): ItemDefinition[] {
  return ITEM_IDS.map((id) => ITEMS[id]!).filter((item) => item.rarity === rarity && !item.signature);
}
