import { schema, t, type SchemaType } from "@colyseus/schema";

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
  /** An `EnemyState`. The client lights a creature that is hunting, so you can
   *  tell at a glance whether it has seen you. */
  state: t.uint8().default(0),
}, "Enemy");
export type Enemy = SchemaType<typeof Enemy>;

export const WorldState = schema({
  /** Which Ostra this room is. One room per Ostra, so it never changes for
   *  the lifetime of the room — the client reads it to pick the palette. */
  ostraId: t.string().default(""),
  players: t.map(Player),
  enemies: t.map(Enemy),
}, "WorldState");
export type WorldState = SchemaType<typeof WorldState>;
