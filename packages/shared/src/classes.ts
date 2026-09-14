/**
 * Classes: what a character is, and so what a level gives them.
 *
 * A class decides three things: which abilities sit on your bar and at what
 * level each is learned, what resource they are paid in, and which attributes
 * grow as you level. Everything else — gear, stats, the fight itself — is
 * shared by everyone.
 *
 * There is one class so far, the Warrior. Characters carry a class id from the
 * start regardless, so the second class is a table entry and a picker on the
 * title screen, not a migration.
 */

import type { Item, ItemFamily } from "./items.js";
import { MAX_LEVEL } from "./levels.js";
import { isSpellId, SPELLS, type SpellId } from "./spells.js";
import type { PrimaryStat, StatBlock } from "./stats.js";

export type ClassId = "warrior";

/**
 * What a class pays for its abilities with.
 *
 *   fervour — builds while you fight and makes you hit harder while it is
 *             high; spenders trade it for a burst (see below)
 *   mana    — a pool that returns over time, fed by Spirit. No class uses it
 *             yet; the rules in `combat.ts` wait for the first caster.
 */
export type ResourceKind = "fervour" | "mana";

export interface ClassAbility {
  spell: SpellId;
  /** Learned on reaching this level. */
  level: number;
}

export interface ClassDefinition {
  id: ClassId;
  name: string;
  /** One line for the character screen. */
  description: string;
  resource: ResourceKind;
  /**
   * Primary attributes gained every level after the first. Level 1 gives
   * nothing, so a new character is exactly what the game was tuned around —
   * and so are creatures of level 1. The rate is what keeps a character of
   * level N in gear of level N about as many blows from killing a creature of
   * level N as a new one is from a Risen, since creatures grow too
   * (`levelHealthScale`).
   */
  growth: Partial<Record<PrimaryStat, number>>;
  /** In bar order: key 1 is the first. */
  abilities: readonly ClassAbility[];
  /**
   * The kinds of gear it can use. Nothing else drops for it, is offered to it
   * as a quest reward or by a vendor, or can be put on — a Warrior finding a
   * wand is not loot, it is litter. A Soul belongs to no family and fits
   * everyone.
   */
  families: readonly ItemFamily[];
  /**
   * The primary attributes it gets anything from. Gear rolled for this class
   * rolls only these (and any secondaries): Focus on a Warrior's ring is a
   * wasted line. See `describeItem`.
   */
  stats: readonly PrimaryStat[];
  /**
   * What right-click does: raise a guard, or dodge. A Warrior blocks — it
   * stands its ground behind a shield — and a lighter class would roll out
   * of the way instead. Q dodges for everyone either way.
   */
  guard: "block" | "dodge";
}

export const CLASSES: Record<ClassId, ClassDefinition> = {
  warrior: {
    id: "warrior",
    name: "Warrior",
    description: "Steel and nerve. Grows stronger the longer a fight lasts.",
    resource: "fervour",
    // It stands its ground behind a shield rather than rolling away.
    guard: "block",
    growth: { might: 2, vigour: 2 },
    // Something new every couple of levels through the first twenty, where
    // most of the world is: a way in, a crowd, an interrupt, a big blow, a
    // timing to learn, a way over, a finisher, a spin, and a shout.
    abilities: [
      { spell: "strike", level: 1 },
      { spell: "charge", level: 2 },
      { spell: "cleave", level: 4 },
      { spell: "shockwave", level: 6 },
      { spell: "crushingBlow", level: 8 },
      { spell: "shieldBash", level: 10 },
      { spell: "heroicLeap", level: 12 },
      { spell: "execute", level: 14 },
      { spell: "whirlwind", level: 17 },
      { spell: "battleCry", level: 20 },
    ],
    // Plate and leather, anything with an edge or a weight, a shield, and
    // jewellery. Cloth, staves, wands and foci are a caster's.
    families: ["heavy", "light", "swords", "axes", "maces", "daggers", "shields", "jewellery"],
    // Might hits harder, Vigour keeps you standing. Focus and Spirit feed
    // mana, which a Warrior does not have.
    stats: ["might", "vigour"],
  },
};

export const CLASS_IDS = Object.keys(CLASSES) as ClassId[];

/** Where a character begins. The only choice there is, for now. */
export const DEFAULT_CLASS: ClassId = "warrior";

export function isClassId(value: unknown): value is ClassId {
  return typeof value === "string" && Object.hasOwn(CLASSES, value);
}

export function getClass(id: ClassId): ClassDefinition {
  return CLASSES[id];
}

/** The attributes a class has at a level, before gear. */
export function baseStats(classId: ClassId, level: number): StatBlock {
  const growth = CLASSES[classId].growth;
  const levels = Math.max(0, Math.min(MAX_LEVEL, Math.floor(level)) - 1);
  const stats: StatBlock = {};
  for (const [stat, perLevel] of Object.entries(growth) as Array<[PrimaryStat, number]>) {
    stats[stat] = Math.round(perLevel * levels);
  }
  return stats;
}

/** Whether a class can use a kind of gear at all, whatever its level. */
export function classUsesFamily(classId: ClassId, family: ItemFamily | undefined): boolean {
  return family === undefined || CLASSES[classId].families.includes(family);
}

/** Whether a class can use this item at all, whatever its level. */
export function classCanUse(classId: ClassId, item: Item): boolean {
  return classUsesFamily(classId, item.family);
}

/** The level a class learns a spell at, or undefined if it never does. */
export function learnedAt(classId: ClassId, spell: SpellId): number | undefined {
  return CLASSES[classId].abilities.find((ability) => ability.spell === spell)?.level;
}

/** Whether a character of this class and level can cast it. The server asks
 *  this of every cast; the client, to grey out what you have not learned. */
export function knowsSpell(classId: ClassId, level: number, spell: SpellId): boolean {
  const at = learnedAt(classId, spell);
  return at !== undefined && level >= at;
}

/** Abilities learned on reaching exactly this level — for the level-up banner. */
export function spellsLearnedAt(classId: ClassId, level: number): SpellId[] {
  return CLASSES[classId].abilities.filter((ability) => ability.level === level).map((ability) => ability.spell);
}

// --- the ability bar --------------------------------------------------------------
//
// Yours to arrange, as in WoW: a row of slots, each holding one ability or
// nothing, dragged into place from the spellbook. The bar is only which key
// casts what — the wire carries the ability, never the slot — so the server
// keeps it for no reason but to give it back next time, and checks nothing
// about a cast against it.

/** Slots on the bar. The keys they sit on are the client's (`BAR_KEYS`). */
export const BAR_SIZE = 10;

/** Which ability each slot holds, in order; null for an empty one. */
export type Bar = Array<SpellId | null>;

/** Whether this class can put this ability on its bar: its own, and cast. */
export function canSlot(classId: ClassId, spell: SpellId): boolean {
  return learnedAt(classId, spell) !== undefined && SPELLS[spell].kind !== "passive";
}

/** A new character's bar: everything it will learn, in the order it learns
 *  it, so the bar is also the road ahead until it is rearranged. */
export function defaultBar(classId: ClassId): Bar {
  const bar: Bar = CLASSES[classId].abilities.map((ability) => ability.spell).filter((spell) => canSlot(classId, spell));
  while (bar.length < BAR_SIZE) bar.push(null);
  return bar.slice(0, BAR_SIZE);
}

/**
 * A bar as stored or sent, made safe: exactly `BAR_SIZE` slots, each this
 * class's own castable ability or empty, and none twice. Anything that is not
 * a list at all — a save from before bars — is the default.
 */
export function sanitiseBar(raw: unknown, classId: ClassId): Bar {
  if (!Array.isArray(raw)) return defaultBar(classId);
  const seen = new Set<SpellId>();
  const bar: Bar = [];
  for (let i = 0; i < BAR_SIZE; i++) {
    const value: unknown = raw[i];
    if (isSpellId(value) && canSlot(classId, value) && !seen.has(value)) {
      seen.add(value);
      bar.push(value);
    } else {
      bar.push(null);
    }
  }
  return bar;
}

// --- Fervour ------------------------------------------------------------------------
//
// Rage, rethought. It does not come from being hit or from hitting so much as
// from staying in the fight: while you are in combat it rises on its own, and
// while it is high everything you do hits harder. Landing a free blow stokes
// it a little faster. Out of combat it drains away.
//
// The big abilities spend it. That is the decision rage never asked of you:
// every Crushing Blow costs the damage bonus you had built up, so the question
// is whether to cash it in now or keep it for the long fight. Strike, Charge
// and a perfect block feed it (`Spell.builds`); Battle Cry skips the ramp once
// a minute.

export const FERVOUR_MAX = 100;
/** Per second in combat, from time alone: full in 25 seconds of fighting. */
export const FERVOUR_PER_SECOND = 4;
/** Per second out of combat. Gone a few seconds after the fight ends. */
export const FERVOUR_DRAIN_PER_SECOND = 20;
/** Extra damage at full Fervour; scales linearly from nothing at empty. */
export const FERVOUR_DAMAGE_BONUS = 0.35;
/** How long Battle Cry holds Fervour at full, draining nothing. */
export const BATTLE_CRY_HOLD_MS = 10_000;

/** Damage multiplier for this much Fervour. */
export function fervourMultiplier(fervour: number): number {
  return 1 + FERVOUR_DAMAGE_BONUS * Math.max(0, Math.min(1, fervour / FERVOUR_MAX));
}
