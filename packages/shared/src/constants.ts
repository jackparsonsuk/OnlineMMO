/**
 * Tuning shared by the authoritative simulation and the client's prediction.
 * Both sides MUST read these from here — a value that differs across the wire
 * shows up as constant, unexplainable rubber-banding.
 *
 * Anything that varies per Ostra (size, palette, gates) lives in `ostras.ts`
 * instead; this file is only for what is true everywhere in the Ostracon.
 */

/** Fixed simulation/input rate, in Hz. One input frame per step, both sides. */
export const TICK_RATE = 30;

/** How often the server broadcasts state patches (and therefore reconcile acks). */
export const PATCH_RATE_MS = 50;

/** Metres per second at full stick. */
export const MOVE_SPEED = 6;

/** Player cube dimensions. */
export const PLAYER_SIZE = 1;
export const PLAYER_HALF = PLAYER_SIZE / 2;

/**
 * How far in the past remote players are rendered. Covers one patch interval
 * plus jitter, so the interpolator always has two samples to work between.
 */
export const INTERP_DELAY_MS = 120;

/** Step inside this distance of a Gate and it takes you. */
export const GATE_RADIUS = 1.75;

/**
 * How far from the destination Gate you materialise. Must exceed GATE_RADIUS,
 * or you would arrive already standing in the return Gate and bounce straight
 * back. (The room also suppresses the arrival Gate until you walk out of it —
 * this is the belt to that pair of braces.)
 */
export const GATE_ARRIVAL_OFFSET = 3.5;

export const ROOM_NAME = "ostra";
