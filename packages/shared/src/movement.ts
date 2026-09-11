import {
  COLLISION_ITERATIONS,
  DODGE_COOLDOWN_STEPS,
  DODGE_SPEED,
  DODGE_STEPS,
  GRAVITY,
  JUMP_SPEED,
  MOVE_SPEED,
  PLAYER_RADIUS,
  SPRINT_MULTIPLIER,
  STEP_DOWN,
} from "./constants.js";
import { heightAt, type TerrainSettings } from "./terrain.js";

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

/** A player's body: a position, plus what a jump and a dodge carry from one
 *  step to the next. Creatures are only `MoveState`. */
export interface PlayerMoveState extends MoveState {
  vy: number;
  dodgeLeft: number;
  dodgeX: number;
  dodgeZ: number;
  dodgeCooldown: number;
}

/** Structural view of `MoveInput`, so the sim doesn't depend on the schema. */
export interface MoveCommand {
  moveX: number;
  moveZ: number;
  yaw: number;
  /** Asking to run. Only honoured out of combat — see `applyInput`. */
  sprint?: boolean;
  jump?: boolean;
  dodge?: boolean;
}

/**
 * Static scenery, bucketed into square cells.
 *
 * An eight-kilometre Ostra holds tens of thousands of trees and rocks. Testing
 * every body against every one of them each step would cost more than the rest
 * of the simulation combined, so a body only looks at the 3x3 block of cells
 * around it. The cell must be wider than any collider's radius plus the
 * largest body's, or a contact straddling two cells could be missed.
 *
 * Both sides build the index from the same deterministic data and visit cells
 * in the same fixed order, so the summed push-out stays identical.
 */
export interface SceneryIndex {
  cellSize: number;
  /** Everything whose centre lies in cell (cx, cz). Never null. */
  cell(cx: number, cz: number): readonly Collider[];
}

/** A circle you cannot walk into: a rock, a pillar, a creature or a player. */
export interface Collider {
  /** Stable identity, so a body can be excluded from colliding with itself.
   *  Session id for players, `obstacle:N` for scenery. */
  id: string;
  x: number;
  z: number;
  radius: number;
}

/**
 * A rectangle you cannot walk into — a building.
 *
 * Circles were fine while everything was a rock. A twelve-metre inn
 * approximated by a circle either blocks the street outside it or lets you
 * stand inside its corners, and both read as broken. Rotation is supported so
 * a town isn't forced onto a grid.
 */
export interface BoxCollider {
  id: string;
  /** Centre. */
  x: number;
  z: number;
  /** Half-extents along the box's own axes, before rotation. */
  halfWidth: number;
  halfDepth: number;
  /** Rotation about Y, radians. */
  yaw: number;
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
  /** Rocks, trees and pillars, looked up by cell. Identical on both sides, so
   *  walking into a tree predicts perfectly. */
  scenery?: SceneryIndex;
  /** Buildings. Identical on both sides, so they predict perfectly. */
  boxes?: readonly BoxCollider[];
  /** The collider representing the body being simulated, skipped so nobody
   *  pushes themselves. */
  selfId?: string;
  /**
   * The ground. Bodies are placed on it after every step, so `y` finally means
   * something. Omitted leaves `y` untouched, which is what a flat Ostra wants.
   */
  terrain?: TerrainSettings;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * @param canSprint Whether a sprint request is honoured this step. The server
 *   passes "not in combat"; the client passes its latest copy of the same
 *   replicated flag. They disagree only for the round trip after combat starts
 *   or ends, which the reconciler absorbs as a small correction — the price of
 *   not letting anyone outrun a spider by holding Shift.
 */
export function applyInput(
  state: PlayerMoveState,
  command: MoveCommand,
  dt: number,
  world: MoveWorld,
  canSprint = false,
): void {
  // Facing is client-driven (it follows their camera) but still sanitised:
  // a NaN from a malformed packet would poison the position permanently.
  const yaw = Number.isFinite(command.yaw) ? command.yaw : state.yaw;
  state.yaw = yaw;

  const moveX = clamp(Number.isFinite(command.moveX) ? command.moveX : 0, -1, 1);
  const moveZ = clamp(Number.isFinite(command.moveZ) ? command.moveZ : 0, -1, 1);

  // Babylon is left-handed with +Y up: a mesh at rotation.y = yaw faces
  // (sin yaw, 0, cos yaw), and its right is (cos yaw, 0, -sin yaw).
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);

  // Normalising the stick is what stops diagonals being ~41% faster; it also
  // means a client sending (1, 1) gains nothing over (0, 1).
  const magnitude = Math.hypot(moveX, moveZ);
  const inputX = magnitude > 0 ? moveX / magnitude : 0;
  const inputZ = magnitude > 0 ? moveZ / magnitude : 0;
  const steerX = inputX * cos + inputZ * sin;
  const steerZ = inputZ * cos - inputX * sin;

  if (state.dodgeCooldown > 0) state.dodgeCooldown--;
  // A dodge goes where you are steering, or straight back if you are not —
  // back is away from whatever is in front of you, which is usually the
  // thing you are dodging.
  if (command.dodge === true && state.dodgeCooldown === 0 && state.dodgeLeft === 0) {
    state.dodgeX = magnitude > 0 ? steerX : -sin;
    state.dodgeZ = magnitude > 0 ? steerZ : -cos;
    state.dodgeLeft = DODGE_STEPS;
    state.dodgeCooldown = DODGE_COOLDOWN_STEPS;
  }

  let deltaX = 0;
  let deltaZ = 0;
  if (state.dodgeLeft > 0) {
    state.dodgeLeft--;
    deltaX = state.dodgeX * DODGE_SPEED * dt;
    deltaZ = state.dodgeZ * DODGE_SPEED * dt;
  } else if (magnitude > 0) {
    const speed = command.sprint === true && canSprint ? MOVE_SPEED * SPRINT_MULTIPLIER : MOVE_SPEED;
    deltaX = steerX * speed * dt;
    deltaZ = steerZ * speed * dt;
  }

  const lastY = state.y;
  moveBody(state, deltaX, deltaZ, world, PLAYER_RADIUS);
  if (world.terrain) fall(state, lastY, command.jump === true, dt);
}

/**
 * Up and down, after `moveBody` has put the body on the ground at its new x/z.
 *
 * Height used to be purely derived — where you stand decides how high you
 * are — which is why nothing vertical could drift. A jump needs a velocity,
 * so it is carried in the state and reconciled like position; but on the
 * ground `vy` is exactly zero and `y` is exactly the ground, so walking is
 * still derived, and only a jump or a real drop is integrated.
 */
function fall(state: PlayerMoveState, lastY: number, jump: boolean, dt: number): void {
  const ground = state.y;
  let vy = state.vy;
  let y = lastY;
  if (vy === 0) {
    if (jump) vy = JUMP_SPEED;
    // Off an edge taller than a step: start falling. A hair below zero,
    // since zero means standing.
    else if (lastY - ground > STEP_DOWN) vy = -1e-6;
    else return;
  }
  vy -= GRAVITY * dt;
  y += vy * dt;
  if (y <= ground) {
    y = ground;
    vy = 0;
  } else if (vy === 0) {
    vy = -1e-6;
  }
  state.y = y;
  state.vy = vy;
}

/** Whether a player is in the middle of a dodge: blows miss them. */
export function isDodging(state: { dodgeLeft: number }): boolean {
  return state.dodgeLeft > 0;
}

/**
 * Displace a body, push it out of whatever it now overlaps, and keep it inside
 * the Ostra. Shared by players and by the creatures the server drives, so a
 * zombie is stopped by a rock in exactly the way a player is.
 *
 * @param radius The body's own collision radius — players and each creature
 *   kind differ, so it is a parameter rather than a constant.
 */
export function moveBody(
  state: MoveState,
  deltaX: number,
  deltaZ: number,
  world: MoveWorld,
  radius: number,
): void {
  state.x += deltaX;
  state.z += deltaZ;

  // Resolve overlaps even on a stationary step: something else may have moved
  // into us, and standing still is no reason to be left inside a rock.
  resolveCollisions(state, world, radius);

  // Bounds last, so being pushed out of a collider can never push you through
  // the Ostra's edge.
  const limit = world.halfExtent - radius;
  state.x = clamp(state.x, -limit, limit);
  state.z = clamp(state.z, -limit, limit);

  // Then stand on the ground. Height is derived from the final position rather
  // than integrated, so there is no vertical velocity to drift out of sync —
  // where you are horizontally completely determines how high you are.
  if (world.terrain) state.y = heightAt(state.x, state.z, world.terrain);
}

/**
 * Push the player out of anything it overlaps.
 *
 * Displacements from every contact are summed and applied together rather than
 * one collider at a time. Sequential resolution depends on the order the
 * colliders happen to arrive in, and client and server build that list from
 * different sources — order-independence is what keeps the two agreeing.
 */
function resolveCollisions(state: MoveState, world: MoveWorld, radius: number): void {
  for (let iteration = 0; iteration < COLLISION_ITERATIONS; iteration++) {
    let pushX = 0;
    let pushZ = 0;
    let contacts = 0;

    for (const box of world.boxes ?? []) {
      if (box.id === world.selfId) continue;

      // Work in the box's own frame, where it is axis-aligned and the nearest
      // point is a clamp. Rotating the answer back out is what lets a town be
      // laid out at angles instead of on a grid.
      const sin = Math.sin(box.yaw);
      const cos = Math.cos(box.yaw);
      const relX = state.x - box.x;
      const relZ = state.z - box.z;
      const localX = relX * cos - relZ * sin;
      const localZ = relX * sin + relZ * cos;

      const nearestX = clamp(localX, -box.halfWidth, box.halfWidth);
      const nearestZ = clamp(localZ, -box.halfDepth, box.halfDepth);
      let awayX = localX - nearestX;
      let awayZ = localZ - nearestZ;
      let gap = Math.hypot(awayX, awayZ);

      if (gap >= radius) continue;

      if (gap < 1e-6) {
        // Inside the box: push out through whichever wall is closest, or the
        // maths has no direction to work with and the body sticks.
        const toRight = box.halfWidth - localX;
        const toLeft = localX + box.halfWidth;
        const toFar = box.halfDepth - localZ;
        const toNear = localZ + box.halfDepth;
        const least = Math.min(toRight, toLeft, toFar, toNear);
        awayX = least === toRight ? 1 : least === toLeft ? -1 : 0;
        awayZ = least === toFar ? 1 : least === toNear ? -1 : 0;
        gap = 0;
      } else {
        awayX /= gap;
        awayZ /= gap;
      }

      const overlap = radius - gap;
      // Back out of the box's frame.
      pushX += (awayX * cos + awayZ * sin) * overlap;
      pushZ += (-awayX * sin + awayZ * cos) * overlap;
      contacts++;
    }

    const scenery = world.scenery;
    if (scenery) {
      const size = scenery.cellSize;
      const cx = Math.floor(state.x / size);
      const cz = Math.floor(state.z / size);
      // Fixed visiting order, so both sides sum contacts identically.
      for (let oz = -1; oz <= 1; oz++) {
        for (let ox = -1; ox <= 1; ox++) {
          for (const collider of scenery.cell(cx + ox, cz + oz)) {
            const push = circlePush(state, collider, radius);
            if (push === undefined) continue;
            pushX += push.x;
            pushZ += push.z;
            contacts++;
          }
        }
      }
    }

    for (const collider of world.colliders) {
      if (collider.id === world.selfId) continue;
      const push = circlePush(state, collider, radius);
      if (push === undefined) continue;
      pushX += push.x;
      pushZ += push.z;
      contacts++;
    }

    if (contacts === 0) return;
    state.x += pushX;
    state.z += pushZ;
  }
}

/** Reused result, so the hot loop allocates nothing. */
const pushScratch = { x: 0, z: 0 };

/** How far a body must move to stop overlapping one circle, if it overlaps. */
function circlePush(
  state: MoveState,
  collider: Collider,
  radius: number,
): { x: number; z: number } | undefined {
  const dx = state.x - collider.x;
  const dz = state.z - collider.z;
  const minimum = collider.radius + radius;
  const distanceSq = dx * dx + dz * dz;
  if (distanceSq >= minimum * minimum) return undefined;

  const distance = Math.sqrt(distanceSq);
  const overlap = minimum - distance;
  if (distance < 1e-6) {
    // Exactly concentric — there is no separating direction to compute, so
    // pick a fixed one. Arbitrary, but both sides must pick the SAME
    // arbitrary answer or they drift apart.
    pushScratch.x = overlap;
    pushScratch.z = 0;
  } else {
    pushScratch.x = (dx / distance) * overlap;
    pushScratch.z = (dz / distance) * overlap;
  }
  return pushScratch;
}
