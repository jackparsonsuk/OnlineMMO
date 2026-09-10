/**
 * Names and a line or three of history for every generated item.
 *
 * Built from the setting rather than generically — "Greywood Bascinet of the
 * Cairn" is worth reading in a way that "Helm +3" is not, and the lore is the
 * point of the game. Everything is picked from fragments by the item's own
 * seed, so an item is named the same on every client and on the server without
 * the name ever travelling.
 *
 * Rarer things get longer stories: a common item gets one plain line, a rare
 * one an origin and a detail, and anything mythic or above a coined name, an
 * epithet, and a history.
 *
 * Only names that already exist in the world are used — places from the Ostra
 * table, people from Daso and Fanshona, the creatures that actually roam — so
 * the lore points at things a player can go and find.
 */

import type { PrimaryStat } from "./stats.js";
import type { ItemBase, Rarity } from "./items.js";

type Rng = () => number;

function pick<T>(list: readonly T[], rng: Rng): T {
  return list[Math.floor(rng() * list.length) % list.length]!;
}

// --- fragments ----------------------------------------------------------------

const COMMON_ADJECTIVES = [
  "Worn", "Plain", "Patched", "Dented", "Sturdy", "Simple", "Old", "Rough", "Scuffed",
  "Serviceable", "Faded", "Heavy", "Crude", "Honest", "Borrowed", "Weathered",
] as const;

const SUFFIXES: Record<PrimaryStat, readonly string[]> = {
  might: ["of Striking", "of the Breaker", "of Cleaving", "of the Anvil", "of Ruin", "of the Felling", "of Iron Will"],
  focus: ["of the Void", "of Channelling", "of the Aequum", "of Far Sight", "of the Spark", "of Cinders", "of the Library"],
  vigour: ["of the Wall", "of Endurance", "of the Cairn", "of Deep Roots", "of the Warden", "of the Oak", "of Standing Fast"],
  spirit: ["of Stillness", "of the Well", "of Brightwater", "of Quiet Hours", "of the Tide", "of the Lantern", "of Long Breath"],
};

/** Places, as adjectives. */
const PLACE_ADJECTIVES = [
  "Dasoan", "Fanshonan", "Greywood", "Highmoor", "Lowfen", "Ashfall", "Redstep", "Sunward",
  "Westwood", "Heartland", "Brightwater", "Barrow", "Gatewarden's", "Weighhouse", "Crownbreaker's",
  "Anvil-forged", "Cinderborn", "Sunken",
] as const;

const EVOCATIVE = [
  "Ashen", "Wolfbitten", "Moonlit", "Stormworn", "Gravebound", "Tidemarked", "Emberlit", "Hollow",
  "Oathsworn", "Duskwoven", "Voidtouched", "Rimefast", "Thornbound", "Webspun", "Kindled",
] as const;

/** People who live in the world, for "Osk's Greataxe". */
const PEOPLE = [
  "Osk", "Basan", "Herla", "Wen", "Ilda", "Maera", "Tobin", "Ysolde", "Caddo", "Pell",
] as const;

/** Towns and regions: made IN them. */
const PLACES_IN = [
  "Daso", "Fanshona", "the Heartland", "Westwood", "Greywood", "Highmoor",
  "Brightwater", "Sunward", "Redstep", "Ashfall", "Lowfen",
] as const;
/** Landmarks and ruins: made AT them. */
const PLACES_AT = [
  "the Gate Circle", "the Broken Crown", "Greywood Watch", "the Old Barrow", "Cinder Spire",
  "the Anvil", "the Sunken Hall", "the Sunward Ring",
] as const;
const PLACES = [...PLACES_IN, ...PLACES_AT] as const;

const TIMES = [
  "before the Gates were shut", "the year the Gates first opened", "the winter the lake froze",
  "long before Daso had a name", "when the Black Tide came", "during the Phase Lords' war",
  "three generations ago", "last spring", "in Y0, or so it is claimed", "the summer the Anvil went cold",
] as const;

const MAKERS = [
  "A Dasoan timberwright", "A Fanshona boatwright", "A smith at the Anvil", "The Weighhouse armourer",
  "An apprentice of the Library Ostracon", "Someone in Redstep who never signed their work",
  "A Highmoor shepherd with more patience than skill", "Old Caddo, in his younger days,",
  "Osk the timberwright", "A Gatewarden nobody remembers",
] as const;

const FOR_WHOM = [
  "", " for a son who never came back", " for a Gatewarden", " on a bet", " to settle a debt",
  " for someone who did not live to wear it", " as a gift nobody wanted", " and then sold it at once",
] as const;

const CREATURE_SOURCES = [
  "a Risen that would not stay down", "a Void Spider's web, still sticky", "a Greywood Wolf's den",
  "the chest of a Cairn Golem", "the bottom of a Fen Wretch's pool", "the ashes of a Cinder Wisp",
  "a Thornback that did not stop in time", "a camp nobody had cleared in years",
] as const;

const PRICES = [
  "a boat's worth of timber", "three nights' catch", "a debt nobody remembers", "less than it was worth",
  "a promise that was not kept", "a good knife and a bad map",
] as const;

const DETAILS = [
  "It hums when a Gate opens nearby.", "The rivets are stamped with an Aequum nobody uses now.",
  "It is always faintly warm.", "Wolves will not come near it.",
  "Someone scratched a name inside it. It has since been scratched out.",
  "Rain does not quite touch it.", "It is heavier at night.", "The Weighhouse refused to weigh it.",
  "Spiders leave it alone, which is somehow worse.", "It smells, very faintly, of the lake.",
  "There is ash in every seam, however often it is cleaned.", "It was buried once, and did not stay buried.",
  "The light inside it never quite settles.", "It remembers the shape of whoever wore it last.",
  "Risen turn their heads when it passes.", "It rings like a bell when struck, and it has been struck often.",
] as const;

const HISTORIES = [
  "It has changed hands more times than anyone has counted.", "The Phase Lords are said to have argued over it.",
  "It came through the Gate on the day the Gate first opened.",
  "The Library Ostracon has a page about it. The page is blank.",
  "Three owners died holding it. The fourth gave it away.", "Every Ostra it has been to claims it was made there.",
  "Dronas and Solnajar have both tried to break it. It is still here.",
  "It was lost in the Sunken Hall for a hundred years, and came back dry.",
] as const;

const COMMON_LINES = {
  any: [
    "Someone else's, once.", "Mended more times than it was made.", "It fits well enough.",
    "Bought cheap in Daso, and it shows.", "Smells of woodsmoke and the road.", "Plain work, honestly done.",
    "Better than nothing. Barely.", "It has seen worse than you.", "Serviceable, which is the kindest word for it.",
    "Still has mud from the Heartland on it.",
  ],
  armour: [
    "Dented where it did its job.", "The stitching is newer than the rest.", "Cut for someone a little broader.",
  ],
  weapon: [
    "Nicked along the edge from someone's first fight.", "The grip is worn to someone else's hand.",
    "Balanced, if you are generous.",
  ],
  trinket: [
    "Cheap, common, and the first thing every apprentice owns.", "Pretty, in a poor light.",
    "It hums, a little, if you listen for it.",
  ],
} as const;

const COINED_START = [
  "Vey", "Osk", "Mor", "Ael", "Dru", "Kha", "Ser", "Thal", "Iv", "Bran", "Cor", "Ul", "Ysm",
  "Fen", "Gar", "Hal", "Nym", "Quor", "Ris", "Sol", "Dron", "Ash", "Vel", "Orr",
] as const;
const COINED_MIDDLE = ["a", "e", "i", "o", "ae", "ya", "or", "en", "ul", "ith", "", ""] as const;
const COINED_END = [
  "loss", "mar", "dris", "wyn", "thal", "gar", "ric", "vane", "mere", "dun", "ros", "cael",
  "nor", "veth", "sk", "haim", "ard",
] as const;

const EPITHET_ADJECTIVES = [
  "Last", "Quiet", "Unbroken", "Hollow", "Burning", "Drowned", "Patient", "Nameless", "Sleepless",
  "Grey", "Weeping", "First", "Hungry", "Faithful",
] as const;
const EPITHET_TITLES = [
  "Warden", "Lantern", "Oath", "Answer", "Tide", "Vigil", "Crown", "Witness", "Promise",
  "Reckoning", "Keeper", "Ember", "Gate", "Silence",
] as const;
const GRAND_TITLES = [
  "Breaker of the Seventh Gate", "Heir to Nothing", "the Ostracon's Own", "Last Word of the Phase Lords",
  "What the Black Tide Left", "the Gods' Unfinished Work", "Sorrow of the Ascendant",
] as const;
const OSTRA_NAMES = ["Terra", "the Ascendant", "Barals"] as const;

// --- names --------------------------------------------------------------------

function coined(rng: Rng): string {
  return pick(COINED_START, rng) + pick(COINED_MIDDLE, rng) + pick(COINED_END, rng);
}

function epithet(rng: Rng): string {
  return rng() < 0.5
    ? `the ${pick(EPITHET_ADJECTIVES, rng)} ${pick(EPITHET_TITLES, rng)}`
    : `${pick(EPITHET_TITLES, rng)} of ${pick(PLACES, rng)}`;
}

/**
 * Name one item. `primaries` are its primary stats in order of weight, so the
 * suffix describes what it actually does — "of the Wall" is always Vigour.
 */
export function itemName(base: ItemBase, rarity: Rarity, primaries: readonly PrimaryStat[], rng: Rng): string {
  if (base.name) return base.name;

  const noun = pick(base.nouns, rng);
  const material = pick(base.materials, rng);
  const suffix = pick(SUFFIXES[primaries[0] ?? "vigour"], rng);

  switch (rarity) {
    case "common":
      return rng() < 0.5 ? `${pick(COMMON_ADJECTIVES, rng)} ${noun}` : `${material} ${noun}`;
    case "uncommon":
      return `${material} ${noun} ${suffix}`;
    case "rare": {
      const roll = rng();
      if (roll < 0.4) return `${pick(PLACE_ADJECTIVES, rng)} ${noun} ${suffix}`;
      if (roll < 0.7) return `${pick(PEOPLE, rng)}'s ${material} ${noun}`;
      return `${pick(EVOCATIVE, rng)} ${noun} ${suffix}`;
    }
    case "mythic":
      return `${coined(rng)}, ${epithet(rng)}`;
    case "legendary":
      return `${coined(rng)}, ${epithet(rng)}`;
    case "world":
      return `${coined(rng)}, ${pick(GRAND_TITLES, rng)}`;
    case "ostra":
      return `${coined(rng)}, Shard of ${pick(OSTRA_NAMES, rng)}`;
  }
}

// --- lore -----------------------------------------------------------------------

function origin(rng: Rng): string {
  const roll = rng();
  if (roll < 0.3) {
    const where = rng() < 0.6 ? `in ${pick(PLACES_IN, rng)}` : `at ${pick(PLACES_AT, rng)}`;
    return `Made ${where} ${pick(TIMES, rng)}.`;
  }
  if (roll < 0.55) return `Taken from ${pick(CREATURE_SOURCES, rng)}.`;
  if (roll < 0.85) return `${pick(MAKERS, rng)} made it${pick(FOR_WHOM, rng)}.`;
  return `Traded across the Weighhouse scales for ${pick(PRICES, rng)}.`;
}

function commonLine(base: ItemBase, rng: Rng): string {
  const own = base.skill === "cloth" || base.skill === "light" || base.skill === "heavy" || base.skill === "shields"
    ? COMMON_LINES.armour
    : base.skill === "attunement" ? COMMON_LINES.trinket : COMMON_LINES.weapon;
  return rng() < 0.4 ? pick(own, rng) : pick(COMMON_LINES.any, rng);
}

/** One to three sentences, longer the rarer the item. */
export function itemLore(base: ItemBase, rarity: Rarity, rng: Rng): string {
  if (base.lore) return base.lore;

  switch (rarity) {
    case "common":
      return commonLine(base, rng);
    case "uncommon":
      return origin(rng);
    case "rare":
      return `${origin(rng)} ${pick(DETAILS, rng)}`;
    default: {
      const detail = pick(DETAILS, rng);
      return `${origin(rng)} ${pick(HISTORIES, rng)} ${detail}`;
    }
  }
}
