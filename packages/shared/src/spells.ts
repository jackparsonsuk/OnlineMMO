/**
 * Abilities: everything on the bar, from a sword swing to a war cry.
 *
 * In code they are all "spells" — the wire, the cast step and the server's
 * resolver treat a swing and a leap the same way — but which ones a character
 * has comes from their class (`classes.ts`), and each is learned at a level.
 * The only class so far is the Warrior, so every entry here is a Warrior's.
 *
 * What a spell costs is paid in its class's resource. A Warrior's is Fervour,
 * which builds the longer a fight goes on and makes everything hit harder
 * while it is high — so the spenders here are a trade: power later for a
 * burst now. See the Fervour section of `classes.ts`.
 *
 * The Warrior's first kit (Heroic Throw, Sunder, Shield Bash as a button) was
 * built for tab-targeting and standing casts. This one is built for action
 * combat: nothing roots you, Charge replaced Throw as the way to reach
 * something, Whirlwind replaced Sunder as the answer to a crowd, and Shield
 * Bash is a well-timed block rather than a key. See the README, The Warrior.
 */

import { TICK_RATE } from "./constants.js";
import type { StatTotals } from "./stats.js";

export type SpellId =
  | "strike"
  | "charge"
  | "cleave"
  | "shockwave"
  | "crushingBlow"
  | "shieldBash"
  | "heroicLeap"
  | "execute"
  | "whirlwind"
  | "battleCry";

/**
 * How an ability is performed.
 *
 *   instant — lands the step it is pressed (or after `castMs`, standing)
 *   hold    — winds up while the key is held and lands on release: the
 *             longer the wind-up, the harder, and the dearer (`hold`)
 *   channel — pulses for as long as the key is held and it can be paid for
 *             (`channel`)
 *   dash    — moves you, predicted like a dodge, and lands a blow where it
 *             ends (`dash`)
 *   passive — never cast; while learned, it changes a rule
 */
export type SpellKind = "instant" | "hold" | "channel" | "dash" | "passive";

/** How a spell picks what it hits. */
export type SpellTargeting =
  /** One creature — the closest inside the shape. */
  | "nearest"
  /** Everything inside the shape. */
  | "all"
  /** Nothing: the spell does something to its caster instead. */
  | "self";

export interface HoldRule {
  /** Held this long, the wind-up is full. */
  fullMs: number;
  /** Held this much longer than full, it lets go by itself: a full swing
   *  carried about indefinitely would be a second guard. */
  graceMs: number;
  /** Cost at a full wind-up; `cost` is what the lightest one takes. */
  fullCost: number;
  /** Damage multiplier at full; nothing held is 1. */
  fullDamage: number;
  /** Knockback at full; nothing held is `knockback`. Only a full one staggers. */
  fullKnockback: number;
}

export interface ChannelRule {
  /** Between pulses. Each pulse pays `cost` and hits the shape; the first
   *  lands as the key goes down. */
  pulseMs: number;
}

export interface DashRule {
  /** The shortest and longest it goes. The client asks for a distance; the
   *  step clamps it, so asking for more gains nothing. */
  minRange: number;
  maxRange: number;
  /** Metres a second along the ground, for one that runs. */
  speed?: number;
  /** A leap instead: always this long in the air, however far, so it lands
   *  where it was aimed on level ground. */
  airMs?: number;
}

export interface ExecuteRule {
  /** Health, as a share of the creature's, at or below which it is finished
   *  rather than struck. */
  below: number;
  /** Damage multiplier on something that far gone. */
  multiplier: number;
  /** Fervour given back when it kills: the reason to save it for the end. */
  refund: number;
}

export interface Spell {
  id: SpellId;
  name: string;
  kind: SpellKind;
  /** Paid in the class's resource when the cast lands. Zero is free. A hold
   *  pays more the longer it was held; a channel pays this every pulse. */
  cost: number;
  /** From when the cast lands; for a hold, from release; for a channel, from
   *  when it ends. Counted in input steps (`cooldownSteps`). */
  cooldownMs: number;
  /**
   * How long an instant takes to perform, standing still; 0 is instant, and
   * works on the move. Moving during a cast cancels it. No Warrior ability has
   * one any more — rooting a Warrior fought the action controls — but the
   * rule waits for the first caster. See `castSteps`.
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
  /** Reach, measured to the target's surface: the wedge's radius, or a line's
   *  length. For a dash, the reach of the blow where it ends. */
  range: number;
  /** Total width of a wedge, centred on your aim. Math.PI * 2 is a ring
   *  around you, where facing stops mattering. Ignored for a line. */
  arc: number;
  /** A straight band `range` long and this wide, out from you along your aim,
   *  instead of a wedge. */
  line?: number;
  targeting: SpellTargeting;
  /** Metres a struck creature is shoved away from the caster. Weight, mostly —
   *  a hit that moves nothing reads as a miss. */
  knockback: number;
  /** Interrupts a creature's windup. */
  stagger: boolean;
  /** Fervour it gives when it lands, rather than spending it. */
  builds?: number;
  hold?: HoldRule;
  channel?: ChannelRule;
  dash?: DashRule;
  execute?: ExecuteRule;
  /** Creatures within this many metres turn on the caster. */
  taunt?: number;
  /** One line, shown on the bar and in the spellbook. */
  description: string;
}

/** Fervour a landed Strike gives. Strike lands once every 0.7 seconds, so it
 *  is the steady part of the ramp. */
export const FERVOUR_PER_BLOW = 4;

export const SPELLS: Record<SpellId, Spell> = {
  /**
   * The baseline. Free, the best sustained damage there is, and every landed
   * blow stokes Fervour — so it is both what you do between the big moves
   * and what pays for them.
   *
   * Left click: a quick swing you can throw on the move (slowed while you
   * swing — `ATTACK_MOVE_FACTOR`), three to a chain.
   */
  strike: {
    id: "strike",
    name: "Strike",
    kind: "instant",
    cost: 0,
    cooldownMs: 700,
    castMs: 0,
    damage: 21,
    scaling: "might",
    coefficient: 1.17,
    range: 2.4,
    arc: Math.PI * 0.62,
    targeting: "nearest",
    knockback: 0.45,
    // The finisher staggers; see STRIKE_COMBO_LENGTH.
    stagger: false,
    builds: FERVOUR_PER_BLOW,
    description: "Swing on the move — every third blow staggers. Builds Fervour.",
  },

  /**
   * The way in. Runs you at the creature the reticle is on and lands a blow
   * that staggers it, so a Charge into a windup is a blow you never take — and
   * a late one is running into it. It opens a fight with a good share of the
   * Fervour ramp, which is what makes it an opener rather than a gap-closer.
   */
  charge: {
    id: "charge",
    name: "Charge",
    kind: "dash",
    cost: 0,
    cooldownMs: 12_000,
    castMs: 0,
    damage: 10,
    scaling: "might",
    coefficient: 0.6,
    range: 2.4,
    arc: Math.PI * 2,
    targeting: "nearest",
    knockback: 0.6,
    stagger: true,
    builds: 20,
    // Not so short it is a second dodge; not so far it crosses a camp.
    dash: { minRange: 5, maxRange: 18, speed: 26 },
    description: "Rush the creature you are looking at and stagger it. Builds Fervour.",
  },

  /** A wide sweep in front: the first thing you learn for a crowd, cheap and
   *  quick, but only what you face, and it moves nothing far. */
  cleave: {
    id: "cleave",
    name: "Cleave",
    kind: "instant",
    cost: 20,
    cooldownMs: 4000,
    castMs: 0,
    damage: 16,
    scaling: "might",
    coefficient: 0.9,
    range: 3.2,
    arc: Math.PI,
    targeting: "all",
    knockback: 0.9,
    stagger: false,
    description: "Hits everything in front of you.",
  },

  /**
   * A slam that runs along the ground where you aim, staggering everything in
   * the line. The interrupt with reach: a pack in a corridor, or the one
   * winding up behind the one in your face.
   */
  shockwave: {
    id: "shockwave",
    name: "Shockwave",
    kind: "instant",
    cost: 25,
    cooldownMs: 10_000,
    castMs: 0,
    damage: 14,
    scaling: "might",
    coefficient: 0.7,
    range: 9,
    arc: 0,
    line: 2.2,
    targeting: "all",
    knockback: 1.4,
    stagger: true,
    description: "Sends a wave along the ground that staggers everything in its path.",
  },

  /**
   * The big single blow. Hold to raise it, let go to bring it down: a touch is
   * a heavy hit for a little Fervour, a full wind-up nearly three times that,
   * staggers, and costs more than twice as much — and all the while you are
   * slowed and in plain sight of whatever is winding up at you.
   */
  crushingBlow: {
    id: "crushingBlow",
    name: "Crushing Blow",
    kind: "hold",
    cost: 20,
    cooldownMs: 6000,
    castMs: 0,
    damage: 24,
    scaling: "might",
    coefficient: 1.2,
    range: 2.6,
    arc: Math.PI * 0.62,
    targeting: "nearest",
    knockback: 0.8,
    stagger: false,
    hold: { fullMs: 1000, graceMs: 600, fullCost: 45, fullDamage: 2.6, fullKnockback: 2.4 },
    description: "Hold to wind up, release to strike. A full wind-up staggers.",
  },

  /**
   * Block, done well. A guard raised just before a blow lands takes none of
   * it and staggers whatever struck — the old interrupt, as timing rather than
   * a key, which is what a telegraph is for. See PERFECT_BLOCK_MS.
   */
  shieldBash: {
    id: "shieldBash",
    name: "Shield Bash",
    kind: "passive",
    cost: 0,
    cooldownMs: 0,
    castMs: 0,
    damage: 0,
    scaling: "might",
    coefficient: 0,
    range: 0,
    arc: 0,
    targeting: "self",
    knockback: 1.5,
    stagger: true,
    builds: 15,
    description: "Passive. Block just as a blow lands: it does nothing, and its maker staggers. Builds Fervour.",
  },

  /** Up, over, and down on them: a leap to where the reticle meets the ground
   *  that throws back everything around where you land. The way into the
   *  middle of a crowd, or out of it. */
  heroicLeap: {
    id: "heroicLeap",
    name: "Heroic Leap",
    kind: "dash",
    cost: 0,
    cooldownMs: 20_000,
    castMs: 0,
    damage: 18,
    scaling: "might",
    coefficient: 0.8,
    range: 4.2,
    arc: Math.PI * 2,
    targeting: "all",
    knockback: 2.2,
    stagger: false,
    dash: { minRange: 4, maxRange: 16, airMs: 900 },
    description: "Leap to where you are looking, hurling back everything where you land.",
  },

  /** The finisher. An ordinary blow for its price against anything healthy;
   *  against something nearly dead, over three times that, and a kill gives
   *  back most of what it cost. */
  execute: {
    id: "execute",
    name: "Execute",
    kind: "instant",
    cost: 30,
    cooldownMs: 6000,
    castMs: 0,
    damage: 20,
    scaling: "might",
    coefficient: 1,
    range: 2.6,
    arc: Math.PI * 0.62,
    targeting: "nearest",
    knockback: 0.6,
    stagger: false,
    execute: { below: 0.3, multiplier: 3.2, refund: 20 },
    description: "Massive damage to a foe below 30% health. A kill refunds Fervour.",
  },

  /**
   * Spin, for as long as you hold it and can pay: a ring of blows every half
   * second, on the move. The crowd answer, and a Fervour sink — it burns the
   * bar faster than a fight fills it, so it is a burst, not a stance.
   */
  whirlwind: {
    id: "whirlwind",
    name: "Whirlwind",
    kind: "channel",
    cost: 9,
    cooldownMs: 8000,
    castMs: 0,
    damage: 11,
    scaling: "might",
    coefficient: 0.55,
    range: 3.6,
    arc: Math.PI * 2,
    targeting: "all",
    knockback: 0.4,
    stagger: false,
    channel: { pulseMs: 450 },
    description: "Hold to spin, striking everything around you. Drains Fervour.",
  },

  /** Skip the ramp: full Fervour now, and it holds for a while — and every
   *  creature near turns on you, which in a group is the point. Once a
   *  minute. */
  battleCry: {
    id: "battleCry",
    name: "Battle Cry",
    kind: "instant",
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
    taunt: 12,
    description: "Fills Fervour and holds it for 10 seconds. Everything near turns on you.",
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

/** Milliseconds as input steps. */
export function msToSteps(ms: number): number {
  return ms <= 0 ? 0 : Math.max(1, Math.round((ms / 1000) * TICK_RATE));
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
  return msToSteps(spell.castMs);
}

/**
 * A cooldown in input steps, for the same reason. It used to be wall-clock on
 * both sides, which was harmless while a disagreement only cost a picture;
 * Charge and Heroic Leap move you, and a dash the client predicted and the
 * server refused — pressed a round trip before the server thought it was
 * ready — is a rubber band.
 */
export function cooldownSteps(spell: Spell): number {
  return msToSteps(spell.cooldownMs);
}

/** A step with any movement in it — walking, a jump or a dodge: what cancels
 *  a cast with a cast time, as it does in WoW. */
export function isMoving(input: { moveX: number; moveZ: number; jump?: boolean; dodge?: boolean; block?: boolean }): boolean {
  return input.moveX !== 0 || input.moveZ !== 0 || input.jump === true || input.dodge === true || input.block === true;
}

/**
 * How far into a hold's wind-up, 0 to 1, after this many held steps. The
 * server and the client count the same steps, so they agree on the blow.
 */
export function holdPower(spell: Spell, steps: number): number {
  if (!spell.hold) return 0;
  return Math.min(1, steps / msToSteps(spell.hold.fullMs));
}

/** What a hold of this power costs: `cost` for a touch, up to `fullCost`. */
export function holdCost(spell: Spell, power: number): number {
  if (!spell.hold) return spell.cost;
  return Math.round(spell.cost + (spell.hold.fullCost - spell.cost) * power);
}

/**
 * Raise a guard this long before a blow lands and it is a perfect block —
 * with Shield Bash learned, the blow does nothing and its maker staggers.
 * Judged on the server's clock, where both the guard and the blow happen, so
 * latency moves the window rather than shrinking it: you raise it about a
 * round trip before the blow looks like it lands.
 */
export const PERFECT_BLOCK_MS = 350;

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
