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

/**
 * Shift, out of combat. Terra is eight kilometres across and walking it at 6 m/s
 * takes the best part of half an hour; this makes it fourteen minutes. Denied
 * in combat so it can never be used to outrun a Void Spider (7.2 m/s), which
 * is the whole point of the spider.
 */
export const SPRINT_MULTIPLIER = 1.6;

/** Player cube dimensions. */
export const PLAYER_SIZE = 1;
export const PLAYER_HALF = PLAYER_SIZE / 2;

/**
 * Collision radius. Players are cubes but collide as circles: a circle needs no
 * rotation in the maths, which keeps the shared simulation short enough to be
 * obviously identical on both sides.
 *
 * Sits between the cube's half-width (0.5) and its half-diagonal (0.707). Take
 * the half-width and two cubes meeting corner-first sink a third of their width
 * into each other; take the half-diagonal and they stop a visible gap apart when
 * meeting face-first. This leaves at most ~0.1 of overlap in the worst corner
 * case, which reads as contact rather than as a bug.
 */
export const PLAYER_RADIUS = 0.65;

/** How many push-out passes per step. Two settles most wedged-between-two
 *  cases without the cost of a real solver. */
export const COLLISION_ITERATIONS = 2;

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

/** Dungeons are matched by party as well as by Ostra, so they are defined
 *  under their own name — see `OstraRoom` and the server's index. */
export const DUNGEON_ROOM_NAME = "dungeon";

/** A party is at most this many, and so is a dungeon instance. */
export const PARTY_SIZE = 5;
