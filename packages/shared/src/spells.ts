/**
 * Abilities: everything on the bar, from a sword swing to a war cry.
 *
 * In code they are all "spells" — the wire, the cast arc and the server's
 * resolver treat a swing and a bolt the same way — but which ones a character
 * has comes from their class (`classes.ts`), and each is learned at a level.
 * The only class so far is the Warrior, so every entry here is a Warrior's.
 *
 * What a spell costs is paid in its class's resource. A Warrior's is Fervour,
 * which builds the longer a fight goes on and makes everything hit harder
 * while it is high — so the spenders here are a trade: power later for a
 * burst now. See the Fervour section of `classes.ts`.
 *
 * The old caster kit (Voidbolt, and Sunder costing mana) went with
 * proficiency. Heroic Throw keeps Voidbolt's reach; Sunder kept its name.
 */

import { TICK_RATE } from "./constants.js";
import type { StatTotals } from "./stats.js";

export type SpellId = "strike" | "throw" | "sunder" | "cleave" | "bash" | "battleCry";

/** How a spell picks what it hits. */
export type SpellTargeting =
  /** One creature — the closest inside the shape. */
  | "nearest"
  /** Everything inside the shape. */
  | "all"
  /** Nothing: the spell does something to its caster instead. */
  | "self";

export interface Spell {
  id: SpellId;
  name: string;
  /** Paid in the class's resource when the cast completes. Zero is free. */
  cost: number;
  /** From the moment the cast starts. A cancelled cast gives it back. */
  cooldownMs: number;
  /**
   * How long it takes to perform, standing still; 0 is instant, and works on
   * the move. Moving during a cast cancels it, as in WoW — a heavy swing is a
   * commitment you time around a creature's windup, not something you do
   * while walking out of it. See `castSteps`.
   */
  castMs: number;
  /** Damage before gear, Fervour and crits. */
  damage: number;
  /** Which attribute adds to it: Might for blows, Focus for spells that cost
   *  mana. Every Warrior ability is a blow. */
  scaling: "might" | "focus";
  /** Damage per point of that attribute. Anything that hits a crowd has a
   *  lower one, because it lands on all of them at once. */
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
  /** Landing it builds the caster's resource (Fervour) rather than spending it. */
  builds?: boolean;
  /** One line, shown on the ability bar. */
  description: string;
}

export const SPELLS: Record<SpellId, Spell> = {
  /**
   * The baseline. Free, the best sustained damage there is, and every landed
   * blow stokes Fervour — so it is both what you do between the big moves
   * and what pays for them.
   *
   * A slow, heavy swing, like a WoW weapon's: one blow every 1.8 seconds, each
   * worth three of the old 0.6-second ones, so the damage over time is the
   * same. It takes most of a second to land, standing still, so it has to be
   * timed around a creature's windup rather than thrown while walking away.
   */
  strike: {
    id: "strike",
    name: "Strike",
    cost: 0,
    cooldownMs: 1800,
    castMs: 900,
    damage: 54,
    scaling: "might",
    coefficient: 3,
    range: 2.4,
    arc: Math.PI * 0.62,
    targeting: "nearest",
    knockback: 0.45,
    // The finisher staggers; see STRIKE_COMBO_LENGTH.
    stagger: false,
    builds: true,
    description: "Stand still to swing. Every third blow staggers. Builds Fervour.",
  },

  /** Reach. You can open on something before it has closed — which against a
   *  spider is most of the fight. Free, instant, thrown on the run, but slow
   *  to come round. */
  throw: {
    id: "throw",
    name: "Heroic Throw",
    cost: 0,
    cooldownMs: 5000,
    castMs: 0,
    damage: 14,
    scaling: "might",
    coefficient: 0.8,
    range: 13,
    // Narrow: reach is the reward, and it should cost you accuracy.
    arc: Math.PI * 0.16,
    targeting: "nearest",
    knockback: 0.7,
    stagger: false,
    builds: true,
    description: "Hits one foe at distance, even on the move. Builds Fervour.",
  },

  /**
   * The answer to being surrounded, which is how players die. Expensive, so
   * you have to have been fighting a while before you can afford it.
   */
  sunder: {
    id: "sunder",
    name: "Sunder",
    cost: 35,
    cooldownMs: 4000,
    // A breath to gather yourself: long enough that it has to be started
    // before the crowd's blows land, not as they do.
    castMs: 500,
    damage: 22,
    scaling: "might",
    coefficient: 0.7,
    range: 4.6,
    arc: Math.PI * 2,
    targeting: "all",
    // Throws the crowd off you. Buys the second the ring is for.
    knockback: 2.6,
    stagger: true,
    description: "Stand still: hits and hurls back everything near.",
  },

  /** A wide sweep in front: the pack-clearer, cheaper than Sunder but only
   *  what you are facing, and it moves nothing far. */
  cleave: {
    id: "cleave",
    name: "Cleave",
    cost: 20,
    cooldownMs: 2500,
    castMs: 700,
    damage: 16,
    scaling: "might",
    coefficient: 0.9,
    range: 3.2,
    arc: Math.PI,
    targeting: "all",
    knockback: 0.9,
    stagger: false,
    description: "Stand still: hits everything in front of you.",
  },

  /**
   * The interrupt. Telegraphs are the whole game against anything dangerous,
   * and this is the one sure way to cancel a blow you have seen coming,
   * rather than waiting for a Strike chain to reach its finisher.
   */
  bash: {
    id: "bash",
    name: "Shield Bash",
    cost: 15,
    cooldownMs: 7000,
    // Instant: an interrupt that took time would arrive after the blow.
    castMs: 0,
    damage: 8,
    scaling: "might",
    coefficient: 0.5,
    range: 2.6,
    arc: Math.PI * 0.5,
    targeting: "nearest",
    knockback: 1.4,
    stagger: true,
    description: "Staggers one foe, cancelling its blow.",
  },

  /** Skip the ramp: full Fervour now, and it holds for a while. The opener
   *  for a fight you mean to end quickly, once a minute. */
  battleCry: {
    id: "battleCry",
    name: "Battle Cry",
    cost: 0,
    cooldownMs: 60_000,
    castMs: 0,
    damage: 0,
    scaling: "might",
    coefficient: 0,
    range: 0,
    arc: Math.PI * 2,
    targeting: "self",
    knockback: 0,
    stagger: false,
    description: "Fills Fervour and holds it for 10 seconds.",
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

/**
 * A cast's length in input steps rather than milliseconds.
 *
 * The server advances a cast once per input it applies, and the client once
 * per input it sends — the same stream — so both finish it, or cancel it for
 * a step with movement in it, at exactly the same input. Counting wall-clock
 * time instead would let latency decide whether a swing landed.
 */
export function castSteps(spell: Spell): number {
  return spell.castMs <= 0 ? 0 : Math.max(1, Math.round((spell.castMs / 1000) * TICK_RATE));
}

/** A step with any movement in it — walking, a jump or a dodge: what cancels
 *  a cast, as it does in WoW. */
export function isMoving(input: { moveX: number; moveZ: number; jump?: boolean; dodge?: boolean }): boolean {
  return input.moveX !== 0 || input.moveZ !== 0 || input.jump === true || input.dodge === true;
}

/**
 * Catching your breath: a share of your health back at once, usable in a
 * fight, on a long cooldown. Every class has it — it is the stand-in for
 * potions until there are consumables to carry. Cooldown checked by the
 * server; the client only draws it.
 */
export const HEAL_FRACTION = 0.35;
export const HEAL_COOLDOWN_MS = 40_000;

// --- damage -----------------------------------------------------------------

/**
 * What one cast is worth, before crits, finishers and Fervour: its base, and
 * what your attribute adds to it. Your level shows up through that attribute
 * — every level gives a Warrior Might (see `classes.ts`) — and gear adds the
 * rest.
 */
export function spellDamage(spell: Spell, totals: StatTotals): number {
  return Math.round(spell.damage + totals[spell.scaling] * spell.coefficient);
}
