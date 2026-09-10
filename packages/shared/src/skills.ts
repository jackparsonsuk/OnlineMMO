/**
 * Proficiency: getting better at the things you actually do.
 *
 * Everything you can train shares one scale, 0 to 1000 — each spell, each
 * weight of armour, each family of weapon, and attunement for the trinkets you
 * wear. There is still no XP bar. A skill rises only through use: a spell or a
 * weapon when it lands a blow, armour and shields when you take one.
 *
 * The scale is the same one items are measured on. An item of level 120 wants
 * 120 proficiency in its type; below that it gives progressively less (see
 * `effectiveness`). That is what makes the two axes meet without either making
 * the other pointless: a lucky drop is better today, and training is what lets
 * you have all of it.
 *
 * Nobody has a ceiling of their own any more. There used to be an innate
 * `affinity`, rolled at creation, that capped every spell — it went when the
 * scale grew to 1000, because a cap you were born with on every skill you will
 * ever train reads as "this character is worse", not as flavour. What limits
 * you now is what you train against (see `trainingCeiling`).
 */

import type { SpellId } from "./spells.js";

export type ArmourSkill = "cloth" | "light" | "heavy";
export type WeaponSkill = "swords" | "axes" | "maces" | "daggers" | "staves" | "wands";
export type OffhandSkill = "shields" | "foci";
/** Everything you can train by wearing or holding it. */
export type GearSkill = ArmourSkill | WeaponSkill | OffhandSkill | "attunement";
export type SkillId = SpellId | GearSkill;

/** How the skills are grouped wherever they are listed. */
export type SkillGroup = "spells" | "armour" | "weapons" | "trinkets";

export interface GearSkillDefinition {
  id: GearSkill;
  name: string;
  group: Exclude<SkillGroup, "spells">;
  /** One line, shown on the skills page: how you get better at it. */
  trainedBy: string;
}

export const GEAR_SKILLS: Record<GearSkill, GearSkillDefinition> = {
  cloth: { id: "cloth", name: "Cloth Armour", group: "armour", trainedBy: "Taking hits while wearing cloth." },
  light: { id: "light", name: "Light Armour", group: "armour", trainedBy: "Taking hits while wearing light armour." },
  heavy: { id: "heavy", name: "Heavy Armour", group: "armour", trainedBy: "Taking hits while wearing heavy armour." },
  swords: { id: "swords", name: "Swords", group: "weapons", trainedBy: "Landing blows with a sword in hand." },
  axes: { id: "axes", name: "Axes", group: "weapons", trainedBy: "Landing blows with an axe in hand." },
  maces: { id: "maces", name: "Maces", group: "weapons", trainedBy: "Landing blows with a mace in hand." },
  daggers: { id: "daggers", name: "Daggers", group: "weapons", trainedBy: "Landing blows with a dagger in either hand." },
  staves: { id: "staves", name: "Staves", group: "weapons", trainedBy: "Landing blows with a staff in hand." },
  wands: { id: "wands", name: "Wands", group: "weapons", trainedBy: "Landing blows with a wand in hand." },
  shields: { id: "shields", name: "Shields", group: "weapons", trainedBy: "Taking hits with a shield raised." },
  foci: { id: "foci", name: "Foci", group: "weapons", trainedBy: "Landing blows with a focus in your off hand." },
  attunement: {
    id: "attunement",
    name: "Attunement",
    group: "trinkets",
    trainedBy: "Landing spells that cost mana while wearing a neck, ring or sigil.",
  },
};

export const GEAR_SKILL_IDS = Object.keys(GEAR_SKILLS) as GearSkill[];

export function isGearSkill(value: unknown): value is GearSkill {
  return typeof value === "string" && Object.hasOwn(GEAR_SKILLS, value);
}

/** Every trained number a character has, by skill. Absent means untrained. */
export type Proficiency = Partial<Record<SkillId, number>>;

/** The top of every skill. Meant to take a very long time. */
export const MAX_PROFICIENCY = 1000;

/**
 * One creature level is ten points of item level and of proficiency.
 *
 * Creature levels stay small numbers you can read on a nameplate (Terra runs
 * 1 to 12) while items and training get a scale long enough to spend a very
 * long time climbing — a level-12 Greywood Wolf drops gear around item level
 * 120, and it takes about that much training to wear it well.
 */
export const LEVEL_SCALE = 10;

/** Proficiency one landed use adds, before the slowdown near the ceiling. */
const GAIN_PER_USE = 1.5;

/** How far past a creature's own level (in proficiency points) it can still
 *  teach you anything. */
const TRAINING_HEADROOM = 25;

/**
 * The most a creature of `level` can teach you.
 *
 * Without this, a thousand points of Swords would be a thousand-odd blows
 * against the rabbits outside the Gate Circle. Tying it to the level of what
 * you fight means training climbs with the world: to learn to wear the gear a
 * level-40 creature drops, you have to be fighting level-40 creatures.
 *
 * Deliberately not clamped to MAX_PROFICIENCY — see `grownProficiency`.
 */
export function trainingCeiling(level: number): number {
  return Math.max(1, level) * LEVEL_SCALE + TRAINING_HEADROOM;
}

/**
 * How much better one use makes you, against something of `level`.
 *
 * Growth slows as you approach what that creature can teach, so the last few
 * points against it cost far more than the first — a muscle, not a progress
 * bar. `share` splits one use between several skills (a blow landing on mixed
 * armour trains each weight by how much of it you wear).
 *
 * The headroom is measured against the unclamped ceiling and only the result
 * is clamped, so 1000 is actually reachable against the highest creatures
 * instead of being an asymptote nobody ever touches.
 */
export function grownProficiency(current: number, level: number, share = 1): number {
  const ceiling = trainingCeiling(level);
  if (current >= ceiling || current >= MAX_PROFICIENCY) return current;
  const headroom = 1 - current / ceiling;
  return Math.min(MAX_PROFICIENCY, ceiling, current + GAIN_PER_USE * share * headroom);
}

/** What an item gives when you have no training in it at all. Never nothing,
 *  or a lucky drop would be literally useless until you had trained for it. */
export const MIN_EFFECTIVENESS = 0.25;

/**
 * How much of an item's stats you actually get.
 *
 * Full when your proficiency in its type meets its level; below that it falls
 * away linearly towards MIN_EFFECTIVENESS. Nothing extra for being over-
 * trained: an item of level 10 is simply weak next to level 300 gear, which is
 * reason enough to replace it.
 */
export function effectiveness(proficiency: number, itemLevel: number): number {
  if (proficiency >= itemLevel) return 1;
  const fraction = Math.max(0, proficiency) / Math.max(1, itemLevel);
  return MIN_EFFECTIVENESS + (1 - MIN_EFFECTIVENESS) * fraction;
}

/** Spell damage bonus at MAX_PROFICIENCY: +150%, i.e. ×2.5. */
const SPELL_PROFICIENCY_BONUS = 1.5;

/** Damage multiplier for a spell at a given proficiency. 1.0 untrained. */
export function proficiencyMultiplier(proficiency: number): number {
  return 1 + SPELL_PROFICIENCY_BONUS * (Math.max(0, proficiency) / MAX_PROFICIENCY);
}

/** Anything that is not a finite number in [0, MAX] is dropped, so a hand-
 *  edited save costs a skill rather than a session. */
export function sanitiseProficiency(raw: unknown, isKnown: (id: string) => boolean): Proficiency {
  if (typeof raw !== "object" || raw === null) return {};
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isKnown(key)) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    result[key] = Math.max(0, Math.min(MAX_PROFICIENCY, value));
  }
  return result as Proficiency;
}
