import {
  COLLISION_ITERATIONS,
  MOVE_SPEED,
  PLAYER_HALF,
  PLAYER_RADIUS,
} from "./constants.js";

/**
 * The single movement simulation, run in two places:
 *
 *  - the server, once per fixed step, over each client's buffered inputs;
 *  - the client, predicting its own cube and replaying pending inputs after
 *    every server correction.
 *
 * It has to be deterministic and identical on both sides, which is the whole
 * reason it lives in `@mmo/shared` rather than being written twice. Keep it
 * pure: same state + same command + same dt + same world must give the same
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

/** A circle you cannot walk into: a rock, a pillar, or another player. */
export interface Collider {
  /** Stable identity, so a player can be excluded from colliding with itself.
   *  Session id for players, `obstacle:N` for scenery. */
  id: string;
  x: number;
  z: number;
  radius: number;
}

/** Everything about the surroundings that the step needs. */
export interface MoveWorld {
  /** Half the width of the Ostra you are standing in. Ostras differ in size,
   *  so this is a parameter rather than a constant — and the client must pass
   *  the same value the server does, or prediction disagrees at the boundary. */
  halfExtent: number;
  /**
   * Obstacles and other players. The server passes exact positions; the client
   * passes its best estimate of where everyone is, which is necessarily a
   * little behind. Player-vs-player collision is therefore APPROXIMATE on the
   * client by construction — the reconciler exists to absorb exactly that.
   * Scenery is identical on both sides and so predicts perfectly.
   */
  colliders: readonly Collider[];
  /** The collider representing the player being simulated, skipped so nobody
   *  pushes themselves. */
  selfId?: string;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function applyInput(
  state: MoveState,
  command: MoveCommand,
  dt: number,
  world: MoveWorld,
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
  if (magnitude > 0) {
    const inputX = moveX / magnitude;
    const inputZ = moveZ / magnitude;

    // Babylon is left-handed with +Y up: a mesh at rotation.y = yaw faces
    // (sin yaw, 0, cos yaw), and its right is (cos yaw, 0, -sin yaw).
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    state.x += (inputX * cos + inputZ * sin) * MOVE_SPEED * dt;
    state.z += (inputZ * cos - inputX * sin) * MOVE_SPEED * dt;
  }

  // Resolve overlaps even on a stationary step: something else may have moved
  // into us, and standing still is no reason to be left inside a rock.
  resolveCollisions(state, world);

  // Bounds last, so being pushed out of a collider can never push you through
  // the Ostra's edge.
  const limit = world.halfExtent - PLAYER_HALF;
  state.x = clamp(state.x, -limit, limit);
  state.z = clamp(state.z, -limit, limit);
}

/**
 * Push the player out of anything it overlaps.
 *
 * Displacements from every contact are summed and applied together rather than
 * one collider at a time. Sequential resolution depends on the order the
 * colliders happen to arrive in, and client and server build that list from
 * different sources — order-independence is what keeps the two agreeing.
 */
function resolveCollisions(state: MoveState, world: MoveWorld): void {
  for (let iteration = 0; iteration < COLLISION_ITERATIONS; iteration++) {
    let pushX = 0;
    let pushZ = 0;
    let contacts = 0;

    for (const collider of world.colliders) {
      if (collider.id === world.selfId) continue;

      const dx = state.x - collider.x;
      const dz = state.z - collider.z;
      const minimum = collider.radius + PLAYER_RADIUS;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq >= minimum * minimum) continue;

      const distance = Math.sqrt(distanceSq);
      let normalX: number;
      let normalZ: number;
      if (distance < 1e-6) {
        // Exactly concentric — there is no separating direction to compute, so
        // pick a fixed one. Arbitrary, but both sides must pick the SAME
        // arbitrary answer or they drift apart.
        normalX = 1;
        normalZ = 0;
      } else {
        normalX = dx / distance;
        normalZ = dz / distance;
      }

      const overlap = minimum - distance;
      pushX += normalX * overlap;
      pushZ += normalZ * overlap;
      contacts++;
    }

    if (contacts === 0) return;
    state.x += pushX;
    state.z += pushZ;
  }
}
