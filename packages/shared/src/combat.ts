/**
 * Combat rules, shared so the client can draw exactly what the server will
 * resolve. Every one of these is read by both sides: the swing arc the client
 * paints is the same arc the server tests against.
 */

import { FERVOUR_MAX, type ResourceKind } from "./classes.js";
import {
  critBonus,
  HEALTH_PER_VIGOUR,
  MANA_PER_SPIRIT,
  MANA_REGEN_PER_SPIRIT,
  recoveryMultiplier,
  type StatTotals,
} from "./stats.js";

export const PLAYER_MAX_HEALTH = 100;
export const PLAYER_MAX_MANA = 100;

/** Mana per second while fighting. */
export const MANA_REGEN_PER_SECOND = 5;

/** Mana per second once the fight is over — nobody wants to stand and wait
 *  for a bar after every camp. */
export const MANA_REGEN_OUT_OF_COMBAT = 14;

/**
 * Health per second out of combat, as a fraction of the cap.
 *
 * There used to be no health regeneration at all, and health persists — so
 * the only way to heal was to die. Twenty seconds from empty to full once you
 * stop fighting, and nothing at all during.
 */
export const HEALTH_REGEN_FRACTION_PER_SECOND = 0.05;

/** You count as fighting for this long after you last dealt or took damage.
 *  Gates regeneration and sprint, and is shown on the HUD. */
export const COMBAT_LINGER_MS = 5000;

/** Odds any single hit is a critical, and what one is worth. Rare enough to
 *  notice, common enough that a fight usually has one. */
export const CRIT_CHANCE = 0.12;
export const CRIT_MULTIPLIER = 1.8;

/**
 * Strike chains. Three in a row, each inside this window of the last, and the
 * third is a heavy finisher that staggers.
 *
 * A single repeating swing has no rhythm to it; a three-beat chain gives the
 * free spell a shape — and a reason to keep pressing rather than holding.
 */
/** Longer than Strike's cooldown, with room for latency — or no chain could
 *  ever reach its third link. */
export const STRIKE_COMBO_WINDOW_MS = 1400;
export const STRIKE_COMBO_LENGTH = 3;
export const COMBO_FINISHER_MULTIPLIER = 1.5;
export const COMBO_FINISHER_KNOCKBACK = 1.7;

/** A staggered creature drops whatever it was winding up and cannot attack
 *  again for this long. The reward for landing the heavy hit at the right
 *  moment: an interrupted Risen overhead is a blow you never take. */
export const STAGGER_MS = 700;

// --- fighting above your level -------------------------------------------------

/**
 * What each level a creature stands above you costs you in a fight.
 *
 * Levels used to change only the numbers — health and damage — and a
 * telegraphed fight does not care about numbers: every blow is painted on the
 * ground, so a patient level-4 Warrior could step out of a level-20 Risen's
 * overhead for as long as it took, and did. What makes a level above you a
 * wall in WoW is that the level itself fights you, and so it does here:
 *
 * - your blows **miss** it more often, and those that land do less;
 * - its blows land **harder**, and your guard holds back less of them;
 * - it **winds up faster**, so the painted wedge gives you less time;
 * - from a few levels up, your heavy blows no longer **stagger** it;
 * - and it notices you from further off.
 *
 * One level up is a hard fight you should win; three is one you will
 * probably lose; five and up you run from. A creature below you gets nothing
 * back the other way — being out-levelled already pays less and hits less.
 */
export const LEVEL_GAP = {
  /** Chance per level that a blow misses outright, and the ceiling. */
  missPerLevel: 0.06,
  maxMiss: 0.45,
  /** Damage lost per level on the blows that land, and the floor. */
  damageLossPerLevel: 0.1,
  minDamage: 0.25,
  /** Its damage gained per level, and the ceiling. */
  incomingPerLevel: 0.15,
  maxIncoming: 2.5,
  /** Block's reduction lost per level, and the least a guard still takes. */
  blockLossPerLevel: 0.1,
  minBlock: 0.3,
  /** Windup lost per level, and the shortest it gets as a share of its own. */
  windupLossPerLevel: 0.06,
  minWindup: 0.55,
  /** From this many levels up, heavy blows no longer interrupt it. */
  unstaggerable: 3,
  /** Metres further it notices you per level, and the most. */
  aggroPerLevel: 1,
  maxAggro: 8,
} as const;

export interface LevelGapEffect {
  /** Chance a blow of yours misses it outright. */
  miss: number;
  /** Multiplier on the damage of your blows that land. */
  dealt: number;
  /** Multiplier on the damage its blows do you. */
  taken: number;
  /** What a raised guard takes off its blows (`BLOCK_REDUCTION` when even). */
  block: number;
  /** Multiplier on its windup. */
  windup: number;
  /** Whether your heavy blows still stagger it. */
  staggers: boolean;
  /** Metres added to its aggro radius. */
  aggro: number;
}

/** What a creature of `creatureLevel` has over a player of `playerLevel`. */
export function levelGapEffect(creatureLevel: number, playerLevel: number, blockReduction: number): LevelGapEffect {
  const gap = Math.max(0, creatureLevel - playerLevel);
  const g = LEVEL_GAP;
  return {
    miss: Math.min(g.maxMiss, g.missPerLevel * gap),
    dealt: Math.max(g.minDamage, 1 - g.damageLossPerLevel * gap),
    taken: Math.min(g.maxIncoming, 1 + g.incomingPerLevel * gap),
    block: Math.max(Math.min(g.minBlock, blockReduction), blockReduction - g.blockLossPerLevel * gap),
    windup: Math.max(g.minWindup, 1 - g.windupLossPerLevel * gap),
    staggers: gap < g.unstaggerable,
    aggro: Math.min(g.maxAggro, g.aggroPerLevel * gap),
  };
}

/** How long a cast's ground marker is drawn for. Purely cosmetic. */
export const SWING_VISUAL_MS = 180;

/** Where in the swing the blade connects, in ms. The client plays impact
 *  effects at this moment rather than a round trip later. */
export const STRIKE_CONTACT_MS = 95;

/** A felled creature lies there this long before it comes back at its spawn. */
export const ENEMY_RESPAWN_MS = 12_000;

/** How long you lie dead before waking at the Ostra's spawn point. */
export const PLAYER_RESPAWN_MS = 4_000;

// --- what gear does to a body ---------------------------------------------------

/**
 * Each piece of heavy armour slows mana by this much.
 *
 * Heavy armour has to cost something, or everyone wears it: it rolls the most
 * armour and the most Vigour. This is the price — a full suit of plate returns
 * mana 30% slower — and it is why a caster wears cloth rather than just
 * wearing cloth-coloured plate.
 */
export const HEAVY_MANA_REGEN_PENALTY = 0.05;

export function maxHealthFor(totals: StatTotals): number {
  return PLAYER_MAX_HEALTH + totals.vigour * HEALTH_PER_VIGOUR;
}

export function maxManaFor(totals: StatTotals): number {
  return PLAYER_MAX_MANA + totals.spirit * MANA_PER_SPIRIT;
}

/** The cap on a class's resource. Fervour is always out of a hundred; mana
 *  grows with Spirit. */
export function maxResourceFor(resource: ResourceKind, totals: StatTotals): number {
  return resource === "fervour" ? FERVOUR_MAX : maxManaFor(totals);
}

/** Mana per second, for this set of stats. */
export function manaRegenFor(totals: StatTotals, heavyPieces: number, inCombat: boolean): number {
  const base = (inCombat ? MANA_REGEN_PER_SECOND : MANA_REGEN_OUT_OF_COMBAT) + totals.spirit * MANA_REGEN_PER_SPIRIT;
  const penalty = Math.max(0, 1 - HEAVY_MANA_REGEN_PENALTY * heavyPieces);
  return base * penalty * recoveryMultiplier(totals.recovery);
}

/** Crit chance with this Critical rating. */
export function critChanceFor(totals: StatTotals): number {
  return CRIT_CHANCE + critBonus(totals.crit);
}

/**
 * Is `target` inside a wedge of reach `range` and width `arc`, centred on `yaw`?
 *
 * Shared rather than written twice because the client draws the shape and the
 * server judges it — if those two ever disagreed, the game would look like it
 * was cheating you. Every spell resolves through this one function, so a ring
 * (`arc` of 2*PI) and a narrow bolt differ only by their numbers.
 *
 * @param yaw Where the caster is facing. Ignored when `arc` covers a full turn.
 * @param targetRadius Reach extends to the target's surface, not its centre.
 */
export function isInArc(
  originX: number,
  originZ: number,
  yaw: number,
  targetX: number,
  targetZ: number,
  targetRadius: number,
  range: number,
  arc: number,
): boolean {
  const toX = targetX - originX;
  const toZ = targetZ - originZ;
  const distance = Math.hypot(toX, toZ);
  if (distance > range + targetRadius) return false;

  // A full ring has no direction to test, and neither does standing exactly
  // inside something — failing either would make point-blank casts whiff.
  if (arc >= Math.PI * 2) return true;
  if (distance < 1e-4) return true;

  // Babylon's left-handed frame again: facing yaw means (sin yaw, cos yaw).
  const facingX = Math.sin(yaw);
  const facingZ = Math.cos(yaw);
  const cosAngle = (toX * facingX + toZ * facingZ) / distance;
  // Clamp before acos — floating point can hand it 1.0000000002 and get NaN.
  const angle = Math.acos(Math.min(1, Math.max(-1, cosAngle)));
  return angle <= arc / 2;
}

/**
 * Is `target` inside a straight band `length` long and `width` wide, running
 * out from the origin along `yaw`? Shockwave's shape. Like `isInArc`, measured
 * to the target's surface, so the band is as generous at its far end as at
 * its near one.
 */
export function isInLine(
  originX: number,
  originZ: number,
  yaw: number,
  targetX: number,
  targetZ: number,
  targetRadius: number,
  length: number,
  width: number,
): boolean {
  const toX = targetX - originX;
  const toZ = targetZ - originZ;
  const facingX = Math.sin(yaw);
  const facingZ = Math.cos(yaw);
  const along = toX * facingX + toZ * facingZ;
  if (along < -targetRadius || along > length + targetRadius) return false;
  const across = Math.abs(toX * facingZ - toZ * facingX);
  return across <= width / 2 + targetRadius;
}

/** Whether a spell cast from the origin along `yaw` reaches the target: the
 *  one test both the server's resolver and the client's prediction call. */
export function isInSpellShape(
  spell: { range: number; arc: number; line?: number },
  originX: number,
  originZ: number,
  yaw: number,
  targetX: number,
  targetZ: number,
  targetRadius: number,
): boolean {
  return spell.line !== undefined
    ? isInLine(originX, originZ, yaw, targetX, targetZ, targetRadius, spell.range, spell.line)
    : isInArc(originX, originZ, yaw, targetX, targetZ, targetRadius, spell.range, spell.arc);
}
