/**
 * Tuning shared by the authoritative simulation and the client's prediction.
 * Both sides MUST read these from here — a value that differs across the wire
 * shows up as constant, unexplainable rubber-banding.
 */

/** Fixed simulation/input rate, in Hz. One input frame per step, both sides. */
export const TICK_RATE = 30;

/** How often the server broadcasts state patches (and therefore reconcile acks). */
export const PATCH_RATE_MS = 50;

/** Metres per second at full stick. */
export const MOVE_SPEED = 6;

/** The playable area is a WORLD_SIZE x WORLD_SIZE square centred on the origin. */
export const WORLD_SIZE = 60;
export const WORLD_HALF = WORLD_SIZE / 2;

/** Player cube dimensions. */
export const PLAYER_SIZE = 1;
export const PLAYER_HALF = PLAYER_SIZE / 2;

/**
 * How far in the past remote players are rendered. Covers one patch interval
 * plus jitter, so the interpolator always has two samples to work between.
 */
export const INTERP_DELAY_MS = 120;

export const ROOM_NAME = "world";
