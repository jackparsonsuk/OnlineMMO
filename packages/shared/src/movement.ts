import {
  COLLISION_ITERATIONS,
  DODGE_COOLDOWN_STEPS,
  DODGE_SPEED,
  DODGE_STEPS,
  GRAVITY,
  JUMP_SPEED,
  MOVE_SPEED,
  ATTACK_MOVE_FACTOR,
  BLOCK_MOVE_FACTOR,
  PLAYER_RADIUS,
  SPRINT_MULTIPLIER,
  STEP_DOWN,
} from "./constants.js";
import { msToSteps, spellFromWire } from "./spells.js";
import { heightAt, MAX_CLIMB_GRADE, MAX_WADE_DEPTH, seaDepthAt, seaRamp, type TerrainSettings } from "./terrain.js";

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

/** A player's body: a position, plus what a jump, a dodge and a dash carry
 *  from one step to the next. Creatures are only `MoveState`. */
export interface PlayerMoveState extends MoveState {
  vy: number;
  dodgeLeft: number;
  dodgeX: number;
  dodgeZ: number;
  dodgeCooldown: number;
  dashLeft: number;
  dashKind: number;
  dashX: number;
  dashZ: number;
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
  /** An ability key held this step (its wire index; 0 for none): slows you. */
  cast?: number;
  /** A guard raised this step: slows you more. */
  block?: boolean;
  /** Which way a dash goes. */
  aim?: number;
  /** A dash to start this step (its wire index; 0 for none), and how far. */
  dash?: number;
  reach?: number;
  /** Stop a running dash. */
  halt?: boolean;
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
   * Bodies: players and creatures. Only a creature's step (server-side) is
   * given any — a player's own step gets none on either side, since the
   * client only knows other bodies late and colliding against them was the
   * rubber-banding (see the README, Collision).
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
 * @param canSprint Whether a sprint request is honoured this step. The client
 *   only asks while it believes it is out of combat and predicts as asked
 *   (true); the server honours it out of combat or within SPRINT_GRACE_MS of a
 *   fight starting, so the two agree across the round trip.
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

  startDash(state, command, yaw, dt);

  let deltaX = 0;
  let deltaZ = 0;
  if (state.dashLeft > 0) {
    // Committed: steering does nothing until it ends, and a tree stops it the
    // way it stops anything.
    state.dashLeft--;
    deltaX = state.dashX * dt;
    deltaZ = state.dashZ * dt;
  } else if (state.dodgeLeft > 0) {
    state.dodgeLeft--;
    deltaX = state.dodgeX * DODGE_SPEED * dt;
    deltaZ = state.dodgeZ * DODGE_SPEED * dt;
  } else if (magnitude > 0) {
    const guarding = command.block === true;
    const attacking = (command.cast ?? 0) !== 0;
    const speed = guarding ? MOVE_SPEED * BLOCK_MOVE_FACTOR
      : attacking ? MOVE_SPEED * ATTACK_MOVE_FACTOR
        : command.sprint === true && canSprint ? MOVE_SPEED * SPRINT_MULTIPLIER
          : MOVE_SPEED;
    deltaX = steerX * speed * dt;
    deltaZ = steerZ * speed * dt;
  }

  const lastY = state.y;
  moveBody(state, deltaX, deltaZ, world, PLAYER_RADIUS);
  if (world.terrain) fall(state, lastY, command.jump === true, dt);
  // Landed: forget which dash it was, or the next ordinary jump would read as
  // the leap still going.
  if (state.dashKind !== 0 && !isDashing(state)) state.dashKind = 0;
}

/**
 * Start or stop a dash (Charge, Heroic Leap) on this step's command.
 *
 * Everything the dash will do is decided here, from the command alone: which
 * way (`aim`), how far (`reach`, clamped to the ability's range) and so how
 * many steps, and for a leap, how hard it pushes off. So the client's replay
 * of an input reproduces the dash exactly, and nothing about the creature it
 * was aimed at — which the client only knows late — ever enters the step.
 * Whether it was allowed (learned, off cooldown, something to charge at) is
 * decided before the step sees the command; see the server's `admitDash`.
 */
function startDash(state: PlayerMoveState, command: MoveCommand, yaw: number, dt: number): void {
  if (command.halt === true && state.dashLeft > 0 && spellFromWire(state.dashKind)?.dash?.airMs === undefined) {
    state.dashLeft = 0;
  }
  const spell = command.dash ? spellFromWire(command.dash) : undefined;
  const rule = spell?.dash;
  if (!rule) return;
  const aim = command.aim !== undefined && Number.isFinite(command.aim) ? command.aim : yaw;
  const asked = command.reach !== undefined && Number.isFinite(command.reach) ? command.reach : rule.maxRange;
  const reach = clamp(asked, rule.minRange, rule.maxRange);
  const steps = rule.airMs !== undefined
    ? msToSteps(rule.airMs)
    : Math.max(1, Math.ceil(reach / ((rule.speed ?? DODGE_SPEED) * dt)));
  const speed = reach / (steps * dt);
  state.dashLeft = steps;
  state.dashKind = command.dash!;
  state.dashX = Math.sin(aim) * speed;
  state.dashZ = Math.cos(aim) * speed;
  // A dash overrides a dodge in progress rather than waiting for it.
  state.dodgeLeft = 0;
  // Up hard enough to come down, on level ground, as the steps run out.
  if (rule.airMs !== undefined) state.vy = (GRAVITY * steps * dt) / 2;
}

/** Whether a body is mid-dash, or still in the air from a leap: its landing
 *  is what the dash's blow waits for. */
export function isDashing(state: { dashLeft: number; vy: number; dashKind: number }): boolean {
  if (state.dashLeft > 0) return true;
  return state.vy !== 0 && spellFromWire(state.dashKind)?.dash?.airMs !== undefined;
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
  const fromX = state.x;
  const fromZ = state.z;
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

  if (world.terrain) keepFooting(state, fromX, fromZ, world.terrain);

  // Then stand on the ground. Height is derived from the final position rather
  // than integrated, so there is no vertical velocity to drift out of sync —
  // where you are horizontally completely determines how high you are.
  if (world.terrain) state.y = heightAt(state.x, state.z, world.terrain);
}

/**
 * Ground a body cannot walk onto: uphill steeper than MAX_CLIMB_GRADE, or the
 * sea past wading depth. Both are walls, like the edge of the Ostra, and for
 * the same reason both are pure functions of where you are — the client knows
 * them exactly, so walking into a cliff predicts perfectly.
 *
 * Steepness is judged over the step itself, from where it starts to where it
 * ends, so it is the climb you would actually be making. Going down is never
 * refused, however steep: the mountains should keep you out, not keep you in,
 * and anyone who ends up high on a slope can always come down off it.
 *
 * A refused step keeps whichever half of it — the x or the z — is allowed, so
 * you slide along a cliff foot or a drop-off rather than sticking to it. Where
 * it runs on a diagonal both halves are refused, and then the step is turned
 * to run along the slope instead. A body already out too deep (knocked there,
 * or a coast that moved under a saved character) may always move somewhere
 * shallower, or it could never leave.
 */
function keepFooting(state: MoveState, fromX: number, fromZ: number, terrain: TerrainSettings): void {
  const toX = state.x;
  const toZ = state.z;
  if (toX === fromX && toZ === fromZ) return;
  const fromHeight = heightAt(fromX, fromZ, terrain);
  const fromDepth = terrain.sea ? seaDepthAt(fromX, fromZ, terrain) : -Infinity;
  const reason = footing(terrain, fromX, fromZ, fromHeight, fromDepth, toX, toZ);
  if (reason === FOOTING_OK) return;
  if (footing(terrain, fromX, fromZ, fromHeight, fromDepth, toX, fromZ) === FOOTING_OK) {
    state.z = fromZ;
    return;
  }
  if (footing(terrain, fromX, fromZ, fromHeight, fromDepth, fromX, toZ) === FOOTING_OK) {
    state.x = fromX;
    return;
  }

  const stepX = toX - fromX;
  const stepZ = toZ - fromZ;
  state.x = fromX;
  state.z = fromZ;
  // The way the step must not go: uphill for a cliff, downhill (deeper) for
  // the sea. Sampled either side of where the step began.
  const sign = reason === FOOTING_STEEP ? 1 : -1;
  const gx = sign * (heightAt(fromX + SLOPE_PROBE, fromZ, terrain) - heightAt(fromX - SLOPE_PROBE, fromZ, terrain));
  const gz = sign * (heightAt(fromX, fromZ + SLOPE_PROBE, terrain) - heightAt(fromX, fromZ - SLOPE_PROBE, terrain));
  const lengthSq = gx * gx + gz * gz;
  if (!(lengthSq > 0)) return;
  const into = (stepX * gx + stepZ * gz) / lengthSq;
  if (into <= 0) return;
  // The part of the step across the slope taken away, and a hair more, so a
  // cliff that curves towards you does not turn the slide back into it on the
  // next step.
  const length = Math.sqrt(lengthSq);
  const slideX = fromX + stepX - gx * into - (gx / length) * SLIDE_MARGIN;
  const slideZ = fromZ + stepZ - gz * into - (gz / length) * SLIDE_MARGIN;
  if (footing(terrain, fromX, fromZ, fromHeight, fromDepth, slideX, slideZ) === FOOTING_OK) {
    state.x = slideX;
    state.z = slideZ;
  }
}

const FOOTING_OK = 0;
const FOOTING_STEEP = 1;
const FOOTING_DEEP = 2;

/** Whether a step from (fromX, fromZ) to (x, z) may be taken, and if not, why. */
function footing(
  terrain: TerrainSettings,
  fromX: number,
  fromZ: number,
  fromHeight: number,
  fromDepth: number,
  x: number,
  z: number,
): number {
  const height = heightAt(x, z, terrain);
  const dx = x - fromX;
  const dz = z - fromZ;
  if (height - fromHeight > MAX_CLIMB_GRADE * Math.sqrt(dx * dx + dz * dz) + 1e-9) return FOOTING_STEEP;
  const sea = terrain.sea;
  if (sea && seaRamp(sea, x, z, terrain.seed) > 0) {
    const depth = sea.level - height;
    if (depth > MAX_WADE_DEPTH && depth > fromDepth) return FOOTING_DEEP;
  }
  return FOOTING_OK;
}

/** Half the distance the ground's slope is sampled across, in metres. */
const SLOPE_PROBE = 0.25;
/** How far a slide along a cliff or a drop-off also steps back from it. */
const SLIDE_MARGIN = 0.01;

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
