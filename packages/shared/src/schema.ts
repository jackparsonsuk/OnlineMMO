import { schema, t, type SchemaType } from "@colyseus/schema";
import { PLAYER_MAX_HEALTH, PLAYER_MAX_MANA } from "./combat.js";

/**
 * One frame of player intent. The client never sends a position — only what
 * the player asked for — so the server stays the sole authority on where
 * anyone actually is.
 *
 * The `-1 | 0 | 1` refinement is type-level only: a peer can put any int8 on
 * the wire, so `applyInput` clamps before using these.
 */
export const MoveInput = schema({
  /** Strafe: -1 left, +1 right. */
  moveX: t.int8<-1 | 0 | 1>().default(0),
  /** Forward/back: +1 forward, -1 back. */
  moveZ: t.int8<-1 | 0 | 1>().default(0),
  /** Heading the player wants to face, radians. Driven by the camera. */
  yaw: t.angle().default(0),
  /**
   * Which spell is being cast this tick, as a wire index; 0 for none. Held
   * rather than edge-triggered — the server gates each spell on its own
   * cooldown and mana, so holding a key auto-repeats and a client that sets
   * this every tick gains nothing.
   */
  cast: t.uint8().default(0),
  /**
   * Which way a cast is aimed, separate from `yaw`.
   *
   * `yaw` follows the camera and steers movement; aim follows your target. Kept
   * apart so attacking something off to one side doesn't bend the direction
   * you are walking in, which would make kiting feel like fighting the
   * controls. Only read on a frame that casts.
   */
  aim: t.angle().default(0),
  /** Shift held. Honoured only out of combat. */
  sprint: t.boolean().default(false),
}, "MoveInput");
export type MoveInput = SchemaType<typeof MoveInput>;

export const Player = schema({
  name: t.string().default(""),
  /** 0xRRGGBB, assigned server-side so every client agrees on the colour. */
  colour: t.uint32().default(0xffffff),
  x: t.float32().default(0),
  /** Ground contact point, not the cube's centre — the renderer adds the half
   *  height. Always 0 while the world is flat; here so terrain doesn't need a
   *  schema change. */
  y: t.float32().default(0),
  z: t.float32().default(0),
  yaw: t.angle().default(0),
  /** Zero means dead and awaiting respawn. */
  health: t.uint16().default(PLAYER_MAX_HEALTH),
  mana: t.uint16().default(PLAYER_MAX_MANA),
  /**
   * Base plus whatever is worn. Replicated rather than derived client-side
   * because equipment is private — without these the client could not draw
   * its own bars, let alone anyone else's.
   */
  maxHealth: t.uint16().default(PLAYER_MAX_HEALTH),
  maxMana: t.uint16().default(PLAYER_MAX_MANA),
  /**
   * Dealt or took damage recently. Replicated because the client's movement
   * prediction needs it — sprint is denied in combat, and predicting a sprint
   * the server refuses is a rubber-band — and because the HUD shows it.
   */
  inCombat: t.boolean().default(false),
}, "Player");
export type Player = SchemaType<typeof Player>;

/**
 * A creature. Entirely server-driven — clients never predict these, they just
 * interpolate whatever arrives, the same way they treat other players.
 */
export const Enemy = schema({
  /** An `EnemyKind`. Sent once on spawn and never changed, so the readability
   *  of a string is worth more than the bytes an enum id would save. */
  kind: t.string().default("zombie"),
  x: t.float32().default(0),
  y: t.float32().default(0),
  z: t.float32().default(0),
  yaw: t.angle().default(0),
  health: t.uint16().default(1),
  /** Scaled by Ostra and level, so the client cannot derive it from the
   *  archetype — which is exactly the bug that let a Barals creature's bar
   *  start at 150% and look untouched for its first few hits. */
  maxHealth: t.uint16().default(1),
  /** See `levelHealthScale`. Shown on the label as a warning. */
  level: t.uint8().default(1),
  /** An `EnemyState`. The client lights a creature that is hunting, so you can
   *  tell at a glance whether it has seen you. */
  state: t.uint8().default(0),
}, "Enemy");
export type Enemy = SchemaType<typeof Enemy>;

/**
 * An item lying on the ground.
 *
 * Public state rather than a private message, because everyone in the Ostra
 * can see it — that is the point of loot dropping where a thing died.
 */
export const GroundItem = schema({
  /** An `ItemKey`. The whole item: every client derives its name, rarity and
   *  stats from this alone. */
  item: t.string().default(""),
  /** Session id of whoever earned it, while the claim lasts; empty once it is
   *  free for anyone. Replicated so the client can dim what isn't yours. */
  claimedBy: t.string().default(""),
  x: t.float32().default(0),
  y: t.float32().default(0),
  z: t.float32().default(0),
}, "GroundItem");
export type GroundItem = SchemaType<typeof GroundItem>;

export const WorldState = schema({
  /** Which Ostra this room is. One room per Ostra, so it never changes for
   *  the lifetime of the room — the client reads it to pick the palette. */
  ostraId: t.string().default(""),
  players: t.map(Player),
  enemies: t.map(Enemy),
  ground: t.map(GroundItem),
}, "WorldState");
export type WorldState = SchemaType<typeof WorldState>;
