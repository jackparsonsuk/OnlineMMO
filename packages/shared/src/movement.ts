import { MOVE_SPEED, PLAYER_HALF } from "./constants.js";

/**
 * The single movement simulation, run in two places:
 *
 *  - the server, once per fixed step, over each client's buffered inputs;
 *  - the client, predicting its own cube and replaying pending inputs after
 *    every server correction.
 *
 * It has to be deterministic and identical on both sides, which is the whole
 * reason it lives in `@mmo/shared` rather than being written twice. Keep it
 * pure: same state + same command + same dt + same bounds must give the same
 * result.
 */

/** Anything with a position and a heading — a `Player` schema, or the
 *  reconciler's local mirror of one. */
export interface MoveState {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** Structural view of `MoveInput`, so the sim doesn't depend on the schema. */
export interface MoveCommand {
  moveX: number;
  moveZ: number;
  yaw: number;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * @param halfExtent Half the width of the Ostra you are standing in. Ostras
 *   differ in size, so this is a parameter rather than a constant — and the
 *   client must pass the same value the server does, or its prediction will
 *   disagree at the boundary.
 */
export function applyInput(
  state: MoveState,
  command: MoveCommand,
  dt: number,
  halfExtent: number,
): void {
  // Facing is client-driven (it follows their camera) but still sanitised:
  // a NaN from a malformed packet would poison the position permanently.
  const yaw = Number.isFinite(command.yaw) ? command.yaw : state.yaw;
  state.yaw = yaw;

  const moveX = clamp(Number.isFinite(command.moveX) ? command.moveX : 0, -1, 1);
  const moveZ = clamp(Number.isFinite(command.moveZ) ? command.moveZ : 0, -1, 1);

  // Normalising the stick is what stops diagonals being ~41% faster; it also
  // means a client sending (1, 1) gains nothing over (0, 1).
  const magnitude = Math.hypot(moveX, moveZ);
  if (magnitude === 0) return;

  const inputX = moveX / magnitude;
  const inputZ = moveZ / magnitude;

  // Babylon is left-handed with +Y up: a mesh at rotation.y = yaw faces
  // (sin yaw, 0, cos yaw), and its right is (cos yaw, 0, -sin yaw).
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  const worldX = inputX * cos + inputZ * sin;
  const worldZ = inputZ * cos - inputX * sin;

  // Cubes stop at the world edge with their side flush against it.
  const limit = halfExtent - PLAYER_HALF;
  state.x = clamp(state.x + worldX * MOVE_SPEED * dt, -limit, limit);
  state.z = clamp(state.z + worldZ * MOVE_SPEED * dt, -limit, limit);
}
