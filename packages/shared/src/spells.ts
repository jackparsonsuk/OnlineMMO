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
 * you actually cast, each spell separately, up to a ceiling that is yours.
 */

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
  /** Damage before proficiency scaling. */
  damage: number;
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

// --- proficiency ------------------------------------------------------------

/** The highest ceiling anyone can be born with. */
export const MAX_AFFINITY = 100;

/** Nobody is born with none — the lore is explicit that everyone has some. */
export const MIN_AFFINITY = 55;

/** Proficiency added by one landed cast, before the slowdown near the cap. */
const PROFICIENCY_PER_CAST = 1.6;

/** Damage bonus at a proficiency of 100. */
const PROFICIENCY_DAMAGE_BONUS = 0.6;

export type SpellProficiency = Partial<Record<SpellId, number>>;

/**
 * How much better a landed cast makes you.
 *
 * Growth slows as you approach your ceiling, so the last few points cost far
 * more casts than the first — a muscle, not a progress bar. Returns the NEW
 * proficiency, never above `affinity`.
 */
export function grownProficiency(current: number, affinity: number): number {
  const headroom = Math.max(0, 1 - current / affinity);
  return Math.min(affinity, current + PROFICIENCY_PER_CAST * headroom);
}

/**
 * Damage multiplier for a given proficiency. 1.0 untrained, up to 1.6 at 100.
 *
 * Deliberately scaled against MAX_AFFINITY rather than the caster's own
 * ceiling: someone born with an affinity of 55 who maxes it should be weaker
 * than someone born with 100 who maxes theirs. The ceiling has to mean
 * something or it is just a slower bar.
 */
export function proficiencyMultiplier(proficiency: number): number {
  return 1 + PROFICIENCY_DAMAGE_BONUS * (proficiency / MAX_AFFINITY);
}

export function spellDamage(spell: Spell, proficiency: number): number {
  return Math.round(spell.damage * proficiencyMultiplier(proficiency));
}
