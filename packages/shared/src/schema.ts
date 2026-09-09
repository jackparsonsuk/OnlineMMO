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

export const WorldState = schema({
  players: t.map(Player),
}, "WorldState");
export type WorldState = SchemaType<typeof WorldState>;
