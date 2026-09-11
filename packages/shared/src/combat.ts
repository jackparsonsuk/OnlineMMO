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
export const STRIKE_COMBO_WINDOW_MS = 2600;
export const STRIKE_COMBO_LENGTH = 3;
export const COMBO_FINISHER_MULTIPLIER = 1.5;
export const COMBO_FINISHER_KNOCKBACK = 1.7;

/** A staggered creature drops whatever it was winding up and cannot attack
 *  again for this long. The reward for landing the heavy hit at the right
 *  moment: an interrupted Risen overhead is a blow you never take. */
export const STAGGER_MS = 700;

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
