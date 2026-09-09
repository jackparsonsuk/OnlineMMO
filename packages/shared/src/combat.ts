/**
 * Combat rules, shared so the client can draw exactly what the server will
 * resolve. Every one of these is read by both sides: the swing arc the client
 * paints is the same arc the server tests against.
 */

export const PLAYER_MAX_HEALTH = 100;
export const PLAYER_MAX_MANA = 100;

/** Mana per second, regenerated server-side whether or not you are fighting. */
export const MANA_REGEN_PER_SECOND = 5;

/** How long a cast's effect is drawn for. Purely cosmetic. */
export const SWING_VISUAL_MS = 180;

/** A felled creature lies there this long before it comes back at its spawn. */
export const ENEMY_RESPAWN_MS = 12_000;

/** How long you lie dead before waking at the Ostra's spawn point. */
export const PLAYER_RESPAWN_MS = 4_000;

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
