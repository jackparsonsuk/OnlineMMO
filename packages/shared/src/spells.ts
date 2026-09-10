/**
 * Spells, and how using them makes you better at them.
 *
 * Built to the magic system already written in the vault rather than a generic
 * XP bar:
 *
 *   "Everyone has some amount of innate magical ability within them. Like a
 *    muscle the more you use magic the better you become, up to a set ceiling."
 *
 *   "The Spell Aequum (Level) is a vague way of putting each spell into a
 *    category. This is based on how much mana a spell takes to cost, not how
 *    powerful the spell is."
 *
 * So: Aequum is a mana bracket, not a power ranking — Strike is Aequum 0 not
 * because it is feeble but because it costs nothing. And you improve at what
 * you actually cast, each spell separately (see skills.ts). The "set ceiling"
 * is no longer one you are born with: it is what the creatures you fight can
 * teach you.
 */

import { proficiencyMultiplier } from "./skills.js";
import type { StatTotals } from "./stats.js";

export type SpellId = "strike" | "voidbolt" | "sunder";

/** How a spell picks what it hits. */
export type SpellTargeting =
  /** One creature — the closest inside the shape. */
  | "nearest"
  /** Everything inside the shape. */
  | "all";

export interface Spell {
  id: SpellId;
  name: string;
  /** Mana bracket, per the lore. Not a power ranking. */
  aequum: number;
  manaCost: number;
  cooldownMs: number;
  /** Damage before gear and proficiency. */
  damage: number;
  /** Which attribute adds to it: Might for blows, Focus for spells that cost
   *  mana. This is what makes a heavy-armoured brawler and a cloth-robed
   *  caster different builds rather than different colours. */
  scaling: "might" | "focus";
  /** Damage per point of that attribute. Sunder's is lower because it lands on
   *  everything around you at once. */
  coefficient: number;
  /** Reach, measured to the target's surface. */
  range: number;
  /** Total width of the effect, centred on your facing. Math.PI * 2 is a ring
   *  around you, where facing stops mattering. */
  arc: number;
  targeting: SpellTargeting;
  /** Metres a struck creature is shoved away from the caster. Weight, mostly —
   *  a hit that moves nothing reads as a miss. */
  knockback: number;
  /** Interrupts a creature's windup. */
  stagger: boolean;
  /** One line, shown under the ability bar. */
  description: string;
}

export const SPELLS: Record<SpellId, Spell> = {
  /**
   * The baseline everyone has. Free, so Aequum 0 — and it is still the highest
   * sustained damage in the kit, which keeps melee a real choice rather than
   * the thing you do when out of mana.
   */
  strike: {
    id: "strike",
    name: "Strike",
    aequum: 0,
    manaCost: 0,
    cooldownMs: 600,
    damage: 18,
    scaling: "might",
    coefficient: 1,
    range: 2.4,
    arc: Math.PI * 0.62,
    targeting: "nearest",
    knockback: 0.45,
    // The finisher staggers; see STRIKE_COMBO_LENGTH.
    stagger: false,
    description: "No mana. Every third blow staggers.",
  },

  /** Reach. Lower damage than Strike, but you can open on something before it
   *  has closed — which against a spider is most of the fight. */
  voidbolt: {
    id: "voidbolt",
    name: "Voidbolt",
    aequum: 1,
    manaCost: 12,
    cooldownMs: 900,
    damage: 14,
    scaling: "focus",
    coefficient: 1,
    range: 13,
    // Narrow: reach is the reward, and it should cost you accuracy.
    arc: Math.PI * 0.16,
    targeting: "nearest",
    knockback: 0.7,
    stagger: false,
    description: "Strikes one foe at distance.",
  },

  /**
   * The answer to being surrounded, which is currently the way players die.
   * Expensive and slow enough that it cannot be the opener.
   */
  sunder: {
    id: "sunder",
    name: "Sunder",
    aequum: 2,
    manaCost: 32,
    cooldownMs: 4000,
    damage: 22,
    scaling: "focus",
    coefficient: 0.7,
    range: 4.6,
    arc: Math.PI * 2,
    targeting: "all",
    // Throws the crowd off you. Buys the second the ring is for.
    knockback: 2.6,
    stagger: true,
    description: "Hits and hurls back everything near.",
  },
};

export const SPELL_IDS = Object.keys(SPELLS) as SpellId[];

export function isSpellId(value: unknown): value is SpellId {
  return typeof value === "string" && Object.hasOwn(SPELLS, value);
}

/** Wire form: spells travel as a small integer, not a string, because this
 *  rides on every input frame. Index 0 means "casting nothing". */
export function spellFromWire(value: number): Spell | undefined {
  const id = SPELL_IDS[value - 1];
  return id ? SPELLS[id] : undefined;
}

export function spellToWire(id: SpellId): number {
  return SPELL_IDS.indexOf(id) + 1;
}

// --- damage -----------------------------------------------------------------

/**
 * What one cast is worth, before crits and finishers.
 *
 * Gear adds to the spell's base, and training multiplies the lot. Two axes,
 * kept separate so neither makes the other pointless: an untrained caster in
 * good gear hits hard but plainly, a trained one in rags hits a little harder
 * than rags should allow, and both together are what the top of the game is.
 */
export function spellDamage(spell: Spell, proficiency: number, totals: StatTotals): number {
  const added = totals[spell.scaling] * spell.coefficient;
  return Math.round((spell.damage + added) * proficiencyMultiplier(proficiency));
}
