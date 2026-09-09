/**
 * Combat rules, shared so the client can draw exactly what the server will
 * resolve. Every one of these is read by both sides: the swing arc the client
 * paints is the same arc the server tests against.
 */

export const PLAYER_MAX_HEALTH = 100;

/** Reach measured from the attacker's centre to the target's *surface*, so a
 *  wide creature is easier to hit than a narrow one — as it should be. */
export const ATTACK_RANGE = 2.4;

/**
 * Total width of the swing, centred on where you are facing. Generous by
 * design: a narrow cone punishes camera micro-movement rather than aim, and
 * this is a third-person game where the camera is also your aim.
 */
export const ATTACK_ARC = Math.PI * 0.62;

export const ATTACK_COOLDOWN_MS = 600;
export const ATTACK_DAMAGE = 18;

/** How long the swing effect is drawn for. Purely cosmetic. */
export const SWING_VISUAL_MS = 180;

/** A felled creature lies there this long before it comes back at its spawn. */
export const ENEMY_RESPAWN_MS = 12_000;

/** How long you lie dead before waking at the Ostra's spawn point. */
export const PLAYER_RESPAWN_MS = 4_000;

/**
 * Is `target` inside the swing?
 *
 * Shared rather than written twice because the client draws the arc and the
 * server judges it — if those two ever disagreed, the game would look like it
 * was cheating you.
 *
 * @param yaw Where the attacker is facing.
 * @param targetRadius Reach extends to the target's surface, not its centre.
 */
export function isInSwing(
  attackerX: number,
  attackerZ: number,
  yaw: number,
  targetX: number,
  targetZ: number,
  targetRadius: number,
): boolean {
  const toX = targetX - attackerX;
  const toZ = targetZ - attackerZ;
  const distance = Math.hypot(toX, toZ);
  if (distance > ATTACK_RANGE + targetRadius) return false;

  // Standing inside someone is always a hit; there is no meaningful direction
  // to test, and failing here would make point-blank swings whiff.
  if (distance < 1e-4) return true;

  // Babylon's left-handed frame again: facing yaw means (sin yaw, cos yaw).
  const facingX = Math.sin(yaw);
  const facingZ = Math.cos(yaw);
  const cosAngle = (toX * facingX + toZ * facingZ) / distance;
  // Clamp before acos — floating point can hand it 1.0000000002 and get NaN.
  const angle = Math.acos(Math.min(1, Math.max(-1, cosAngle)));
  return angle <= ATTACK_ARC / 2;
}
