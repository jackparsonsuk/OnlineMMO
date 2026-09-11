/**
 * What gear adds up to, and what those numbers do.
 *
 * Four primary attributes carry most of an item's weight, and a handful of
 * secondaries round it out:
 *
 *   Might   — adds to Strike (weapon blows)
 *   Focus   — adds to spells that cost mana
 *   Vigour  — maximum health
 *   Spirit  — maximum mana, and mana regeneration
 *
 *   Critical, Recovery, Leech — ratings, shown as flat numbers on the item and
 *   converted to a percentage with diminishing returns
 *   Armour  — mostly inherent to armour and shields; blunts every blow taken
 *
 * Flat numbers on the item, deliberately, for the reason the README gives:
 * "+12 Might" stays legible next to Strike's 18, where "+3.4% damage" on every
 * piece would compound into nonsense. Percentages only appear on the character
 * sheet, where they are the honest answer to "what does this do".
 */

export type PrimaryStat = "might" | "focus" | "vigour" | "spirit";
export type SecondaryStat = "crit" | "recovery" | "leech" | "armour";
export type Stat = PrimaryStat | SecondaryStat;

export const PRIMARY_STATS: PrimaryStat[] = ["might", "focus", "vigour", "spirit"];
export const SECONDARY_STATS: SecondaryStat[] = ["crit", "recovery", "leech", "armour"];
export const STAT_ORDER: Stat[] = [...PRIMARY_STATS, ...SECONDARY_STATS];

export interface StatDefinition {
  name: string;
  /** One line for the tooltip and the character sheet. */
  description: string;
  /**
   * How many of this stat one point of an item's budget buys. Armour is cheap
   * per point because it comes in hundreds; everything else is one-for-one so
   * the budget stays easy to reason about.
   */
  perPoint: number;
}

export const STATS: Record<Stat, StatDefinition> = {
  might: { name: "Might", description: "Adds to the damage of weapon blows.", perPoint: 1 },
  focus: { name: "Focus", description: "Adds to the damage of spells that cost mana.", perPoint: 1 },
  vigour: { name: "Vigour", description: "Raises maximum health.", perPoint: 1 },
  spirit: { name: "Spirit", description: "Raises maximum mana and how fast it returns.", perPoint: 1 },
  crit: { name: "Critical", description: "Chance for a blow to land as a critical.", perPoint: 1 },
  recovery: { name: "Recovery", description: "Health and mana return faster.", perPoint: 1 },
  leech: { name: "Leech", description: "Heals you for a share of the damage you deal.", perPoint: 1 },
  armour: { name: "Armour", description: "Blunts every blow you take.", perPoint: 4 },
};

export type StatBlock = Partial<Record<Stat, number>>;

/** Everything worn, added up. Every stat present, zero if nothing gives it. */
export type StatTotals = Record<Stat, number>;

export function emptyTotals(): StatTotals {
  return { might: 0, focus: 0, vigour: 0, spirit: 0, crit: 0, recovery: 0, leech: 0, armour: 0 };
}

// --- what the numbers do ------------------------------------------------------
//
// Every conversion lives here, and both sides read it: the server to resolve a
// fight, the client to show you on the character sheet what a stat is worth.

/** Tuned against creature damage: a full set of gear at a creature's item
 *  level should leave you about as many blows from death as a naked traveller
 *  is from a level-1 Risen — no more, or armour would make fights pointless. */
export const HEALTH_PER_VIGOUR = 3;
export const MANA_PER_SPIRIT = 3;
/** Mana per second each point of Spirit adds, in and out of combat alike. */
export const MANA_REGEN_PER_SPIRIT = 0.03;

/**
 * A rating converted with diminishing returns: `cap × r / (r + k)`.
 *
 * Half the cap at `r = k`, approaching the cap forever after. The first points
 * matter; stacking one stat into the thousands does not break anything.
 */
function rated(rating: number, cap: number, k: number): number {
  const r = Math.max(0, rating);
  return (cap * r) / (r + k);
}

/** Crit chance a Critical rating adds on top of the base CRIT_CHANCE. */
export function critBonus(rating: number): number {
  return rated(rating, 0.3, 120);
}

/** Fraction of damage dealt that comes back as health. */
export function leechFraction(rating: number): number {
  return rated(rating, 0.15, 150);
}

/** Multiplier on health and mana regeneration. */
export function recoveryMultiplier(rating: number): number {
  return 1 + rated(rating, 1.5, 100);
}

/** No amount of armour makes you immune. */
export const MAX_ARMOUR_REDUCTION = 0.75;

/**
 * Fraction of a blow that armour stops, against an attacker of `level`.
 *
 * Measured against the attacker's level rather than your own: the same
 * breastplate turns a Risen's swing by Daso into a bruise and does much less
 * against something at the edge of the world. Without that, armour would be
 * worth the same everywhere and every Ostra would feel the same once you had
 * enough of it — and levelling would quietly make old armour better.
 */
export function armourReduction(armour: number, attackerLevel: number): number {
  const a = Math.max(0, armour);
  const k = 80 + 50 * Math.max(1, attackerLevel);
  return Math.min(MAX_ARMOUR_REDUCTION, a / (a + k));
}

/** Rounded, for display as a whole percentage. */
export function percent(fraction: number): number {
  return Math.round(fraction * 1000) / 10;
}
