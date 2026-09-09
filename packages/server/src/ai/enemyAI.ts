import {
  EnemyState,
  moveBody,
  type EnemyArchetype,
  type MoveState,
  type MoveWorld,
} from "@mmo/shared";

/**
 * Creature behaviour. Runs only on the server: clients never predict enemies,
 * they interpolate whatever arrives, so none of this needs to be deterministic
 * across machines — which buys the freedom to use randomness here.
 *
 * The state machine is deliberately small. Idle → Wander gives the world some
 * life; Chase is the interesting bit; Return is what stops a creature being
 * dragged across the whole Ostra by a player who keeps running.
 */

/** Server-only memory for one creature. Nothing here is replicated. */
export interface EnemyBrain {
  /** Where it spawned. It always comes back here. */
  homeX: number;
  homeZ: number;
  /** Where it is currently walking, in world space. */
  targetX: number;
  targetZ: number;
  /** Seconds left before it picks a new idea. */
  timer: number;
  /** Session id of the player being hunted, if any. */
  quarry: string | undefined;
  /**
   * Walking home and refusing to be distracted.
   *
   * This has to be a latch rather than a "am I currently too far?" test. Leash
   * on distance alone and the creature yo-yos: it steps back inside the radius,
   * instantly re-acquires the player still standing there, walks out, trips the
   * leash again. The two states alternate every tick and it grinds in place
   * instead of going anywhere. Once the latch is set, nothing is hunted until
   * it actually gets home.
   */
  returning: boolean;
  /** Wall-clock ms when this creature may swing again. */
  nextAttackAt: number;
  /** Wall-clock ms when a felled creature gets back up. */
  respawnAt: number;
}

/** Just enough of a player for the AI to hunt it. */
export interface AITarget {
  sessionId: string;
  x: number;
  z: number;
}

/** How close it tries to get. Collision stops it sooner; this stops it
 *  jittering as it grinds against the player's collider. */
const CONTACT_SLACK = 0.25;

/** Close enough to home to call the walk back finished and start living again. */
const HOME_ARRIVAL = 1.2;

/** Radians per second it can turn. Creatures swing round to face where they
 *  are going rather than snapping, which reads as weight. */
const TURN_RATE = 7;

export function createBrain(x: number, z: number): EnemyBrain {
  return {
    homeX: x,
    homeZ: z,
    targetX: x,
    targetZ: z,
    timer: 0,
    quarry: undefined,
    returning: false,
    nextAttackAt: 0,
    respawnAt: 0,
  };
}

/**
 * Advance one creature.
 *
 * @returns the session id it just hit, if it did. Damage is applied by the
 *   room rather than here: death, respawn and persistence all live together
 *   there, and threading them through the AI would spread that logic across
 *   two files for no gain.
 */
export function stepEnemy(
  enemy: MoveState & { health: number; state: number },
  brain: EnemyBrain,
  archetype: EnemyArchetype,
  dt: number,
  world: MoveWorld,
  targets: readonly AITarget[],
  now: number,
): string | undefined {
  // The dead do nothing. The room decides when they get back up.
  if (enemy.state === EnemyState.Dead) return undefined;

  brain.timer -= dt;

  const fromHome = distance(enemy.x, enemy.z, brain.homeX, brain.homeZ);

  // Too far from home. Drop everything and walk back — a creature that can be
  // kited across the whole Ostra makes the world feel like it has no places.
  if (fromHome > archetype.leashRadius) brain.returning = true;
  if (brain.returning && fromHome <= HOME_ARRIVAL) {
    brain.returning = false;
    enemy.state = EnemyState.Idle;
    brain.timer = archetype.idleSeconds;
  }

  if (brain.returning) {
    brain.quarry = undefined;
    enemy.state = EnemyState.Return;
    brain.targetX = brain.homeX;
    brain.targetZ = brain.homeZ;
  } else {
    const quarry = pickQuarry(enemy, brain, archetype, targets);
    if (quarry) {
      brain.quarry = quarry.sessionId;
      enemy.state = EnemyState.Chase;
      brain.targetX = quarry.x;
      brain.targetZ = quarry.z;
    } else {
      brain.quarry = undefined;
      if (enemy.state === EnemyState.Chase) {
        // Lost them. Settle down where it stands.
        enemy.state = EnemyState.Idle;
        brain.timer = archetype.idleSeconds;
      }
      if (brain.timer <= 0) chooseIdleGoal(enemy, brain, archetype);
    }
  }

  advance(enemy, brain, archetype, dt, world);

  return tryAttack(enemy, brain, archetype, targets, now);
}

/** Swing at the quarry if it is in reach and the cooldown has elapsed. */
function tryAttack(
  enemy: MoveState & { state: number },
  brain: EnemyBrain,
  archetype: EnemyArchetype,
  targets: readonly AITarget[],
  now: number,
): string | undefined {
  if (enemy.state !== EnemyState.Chase || brain.quarry === undefined) return undefined;
  if (now < brain.nextAttackAt) return undefined;

  const quarry = targets.find((target) => target.sessionId === brain.quarry);
  if (!quarry) return undefined;
  if (distance(enemy.x, enemy.z, quarry.x, quarry.z) > archetype.attackRange) return undefined;

  brain.nextAttackAt = now + archetype.attackCooldownMs;
  return quarry.sessionId;
}

/**
 * The nearest player worth chasing. An existing quarry is kept until it passes
 * `deaggroRadius`, which is wider than `aggroRadius` — without that gap, a
 * player standing exactly on the aggro line makes the creature start and stop
 * every tick.
 */
function pickQuarry(
  enemy: MoveState,
  brain: EnemyBrain,
  archetype: EnemyArchetype,
  targets: readonly AITarget[],
): AITarget | undefined {
  let best: AITarget | undefined;
  let bestDistance = Infinity;

  for (const target of targets) {
    const range = distance(enemy.x, enemy.z, target.x, target.z);
    const limit = target.sessionId === brain.quarry
      ? archetype.deaggroRadius
      : archetype.aggroRadius;
    if (range > limit) continue;
    if (range < bestDistance) {
      best = target;
      bestDistance = range;
    }
  }

  return best;
}

/** Stand still for a while, then amble somewhere near home. */
function chooseIdleGoal(
  enemy: MoveState & { state: number },
  brain: EnemyBrain,
  archetype: EnemyArchetype,
): void {
  if (enemy.state === EnemyState.Wander) {
    enemy.state = EnemyState.Idle;
    brain.targetX = enemy.x;
    brain.targetZ = enemy.z;
    // Vary the pause so a group spawned together doesn't move in lockstep.
    brain.timer = archetype.idleSeconds * (0.5 + Math.random());
    return;
  }

  const angle = Math.random() * Math.PI * 2;
  const reach = archetype.wanderRadius * Math.sqrt(Math.random());
  enemy.state = EnemyState.Wander;
  brain.targetX = brain.homeX + Math.cos(angle) * reach;
  brain.targetZ = brain.homeZ + Math.sin(angle) * reach;
  brain.timer = 6;
}

/** Walk toward the current goal and turn to face the way we're going. */
function advance(
  enemy: MoveState & { state: number },
  brain: EnemyBrain,
  archetype: EnemyArchetype,
  dt: number,
  world: MoveWorld,
): void {
  const toX = brain.targetX - enemy.x;
  const toZ = brain.targetZ - enemy.z;
  const range = Math.hypot(toX, toZ);

  // Close enough. Still face the quarry — a zombie that has caught you should
  // be looking at you, not at wherever it last walked.
  const stopAt = enemy.state === EnemyState.Chase
    ? archetype.radius + CONTACT_SLACK
    : 0.25;

  if (range > 1e-4) turnToward(enemy, Math.atan2(toX, toZ), dt);
  if (range <= stopAt) {
    // Nothing to move by, but still resolve overlaps: a player can walk into a
    // standing creature and it should be pushed apart rather than merged.
    moveBody(enemy, 0, 0, world, archetype.radius);
    return;
  }

  const speed = enemy.state === EnemyState.Chase
    ? archetype.chaseSpeed
    // Heading home is a purposeful walk, not an amble; at wander speed a
    // full-leash reset would take most of a minute.
    : enemy.state === EnemyState.Return
      ? (archetype.speed + archetype.chaseSpeed) / 2
      : archetype.speed;
  // Never overshoot the goal in a single step.
  const travel = Math.min(speed * dt, range);
  moveBody(enemy, (toX / range) * travel, (toZ / range) * travel, world, archetype.radius);
}

/** Rotate toward `desired` at a bounded rate, by the short way round. */
function turnToward(enemy: MoveState, desired: number, dt: number): void {
  // atan2 of the sin/cos of the difference folds it into (-π, π], which is what
  // makes this take the short arc instead of spinning the long way.
  const delta = Math.atan2(Math.sin(desired - enemy.yaw), Math.cos(desired - enemy.yaw));
  const step = TURN_RATE * dt;
  enemy.yaw = Math.abs(delta) <= step ? desired : enemy.yaw + Math.sign(delta) * step;
}

function distance(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}
