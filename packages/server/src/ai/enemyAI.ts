import {
  EnemyState,
  isInArc,
  moveBody,
  PLAYER_RADIUS,
  STAGGER_MS,
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
 *
 * Attacks are telegraphed: a creature in reach commits to a direction, winds
 * up, and only then does the blow land — on whoever is still inside the wedge.
 * The client paints that wedge on the ground for the length of the windup.
 * Everything that makes the fight readable lives in that pause.
 */

/** Server-only memory for one creature. Nothing here is replicated. */
export interface EnemyBrain {
  /** The camp it belongs to; it is despawned along with it. */
  campId: string;
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
  /** Wall-clock ms when this creature may start another attack. */
  nextAttackAt: number;
  /** Wall-clock ms when a felled creature gets back up. */
  respawnAt: number;
  /** Its cap, for healing on a leash reset. */
  maxHealth: number;
  /**
   * Damage taken from each player since it last reset. The biggest threat is
   * hunted, not the nearest — so the player doing the damage is the one being
   * chased, and a friend can't pull aggro just by standing closer.
   */
  threat: Map<string, number>;
  /** Mid-attack: when the blow lands (0 when not attacking), the direction it
   *  committed to, and at whom. */
  windupUntil: number;
  windupYaw: number;
  windupTarget: string | undefined;
  /** Interrupted by a heavy hit; does nothing until this passes. */
  staggerUntil: number;
  /** Knockback velocity still to be spent, decaying each tick. */
  knockX: number;
  knockZ: number;
}

/** Just enough of a player for the AI to hunt it. */
export interface AITarget {
  sessionId: string;
  x: number;
  z: number;
}

/** What a creature did this tick that the room needs to act on. */
export type EnemyEvent =
  /** Started an attack. Broadcast so clients can telegraph it. */
  | { type: "windup"; target: string; yaw: number; ms: number }
  /** The blow landed. The room applies damage. */
  | { type: "hit"; target: string }
  /** The target stepped out of the wedge in time. */
  | { type: "miss"; target: string };

/** How close it tries to get. Collision stops it sooner; this stops it
 *  jittering as it grinds against the player's collider. */
const CONTACT_SLACK = 0.25;

/** Close enough to home to call the walk back finished and start living again. */
const HOME_ARRIVAL = 1.2;

/** Radians per second it can turn. Creatures swing round to face where they
 *  are going rather than snapping, which reads as weight. */
const TURN_RATE = 7;

/** Per-second decay of knockback velocity. A shove that ends in ~a third of a
 *  second reads as impact; slower reads as ice. */
const KNOCK_DECAY = 9;

/** A player who has hurt it is chased this much further than one who hasn't,
 *  so a Voidbolt from the edge of range is never free. */
const PROVOKED_REACH = 4;

export function createBrain(x: number, z: number, campId: string, maxHealth: number): EnemyBrain {
  return {
    campId,
    homeX: x,
    homeZ: z,
    targetX: x,
    targetZ: z,
    timer: 0,
    quarry: undefined,
    returning: false,
    nextAttackAt: 0,
    respawnAt: 0,
    maxHealth,
    threat: new Map(),
    windupUntil: 0,
    windupYaw: 0,
    windupTarget: undefined,
    staggerUntil: 0,
    knockX: 0,
    knockZ: 0,
  };
}

/** Forget everything about the fight — on death, respawn, or a leash reset. */
export function calmDown(brain: EnemyBrain): void {
  brain.quarry = undefined;
  brain.threat.clear();
  brain.windupUntil = 0;
  brain.windupTarget = undefined;
  brain.staggerUntil = 0;
  brain.knockX = 0;
  brain.knockZ = 0;
}

/**
 * Being hit. Adds threat, turns it on the attacker, shoves it, and maybe
 * interrupts whatever it was winding up.
 *
 * @param dirX,dirZ Unit direction from the attacker to the creature.
 */
export function takeHit(
  brain: EnemyBrain,
  archetype: EnemyArchetype,
  attacker: string,
  damage: number,
  dirX: number,
  dirZ: number,
  knockback: number,
  stagger: boolean,
  now: number,
): void {
  brain.threat.set(attacker, (brain.threat.get(attacker) ?? 0) + damage);
  if (!brain.returning && brain.quarry === undefined) brain.quarry = attacker;

  // Velocity whose decaying integral is `knockback` metres.
  const shove = knockback * (archetype.knockbackScale ?? 1) * KNOCK_DECAY;
  brain.knockX += dirX * shove;
  brain.knockZ += dirZ * shove;

  // A golem does not flinch. That is most of what makes it a golem.
  if (!stagger || archetype.staggerImmune) return;
  brain.windupUntil = 0;
  brain.windupTarget = undefined;
  brain.staggerUntil = now + STAGGER_MS;
  brain.nextAttackAt = Math.max(brain.nextAttackAt, brain.staggerUntil);
}

/** A camp-mate got hit nearby: come and help, without stealing the threat. */
export function rally(brain: EnemyBrain, attacker: string): void {
  if (brain.returning || brain.quarry !== undefined) return;
  brain.threat.set(attacker, Math.max(brain.threat.get(attacker) ?? 0, 1));
  brain.quarry = attacker;
}

/**
 * Advance one creature.
 *
 * @returns something the room must act on, if anything happened. Damage is
 *   applied by the room rather than here: death, respawn and persistence all
 *   live together there, and threading them through the AI would spread that
 *   logic across two files for no gain.
 */
export function stepEnemy(
  enemy: MoveState & { health: number; state: number },
  brain: EnemyBrain,
  archetype: EnemyArchetype,
  dt: number,
  world: MoveWorld,
  targets: readonly AITarget[],
  now: number,
): EnemyEvent | undefined {
  // The dead do nothing. The room decides when they get back up.
  if (enemy.state === EnemyState.Dead) return undefined;

  brain.timer -= dt;
  applyKnockback(enemy, brain, archetype, dt, world);

  const fromHome = distance(enemy.x, enemy.z, brain.homeX, brain.homeZ);

  // Too far from home. Drop everything and walk back — a creature that can be
  // kited across the whole Ostra makes the world feel like it has no places.
  if (fromHome > archetype.leashRadius && !brain.returning) {
    brain.returning = true;
    calmDown(brain);
  }
  if (brain.returning && fromHome <= HOME_ARRIVAL) {
    brain.returning = false;
    enemy.state = EnemyState.Idle;
    brain.timer = archetype.idleSeconds;
    // Evade: a reset creature is whole again. Otherwise it could be chipped
    // down from the edge of its leash for free, one pull at a time.
    enemy.health = brain.maxHealth;
  }

  // An attack in progress: committed, rooted, facing where it chose.
  if (brain.windupUntil > 0) {
    enemy.yaw = brain.windupYaw;
    if (now < brain.windupUntil) return undefined;
    return resolveBlow(enemy, brain, archetype, targets);
  }

  if (now < brain.staggerUntil) return undefined;

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

  return beginAttack(enemy, brain, archetype, targets, now);
}

/** Start winding up on the quarry if it is in reach and the cooldown is done. */
function beginAttack(
  enemy: MoveState & { state: number },
  brain: EnemyBrain,
  archetype: EnemyArchetype,
  targets: readonly AITarget[],
  now: number,
): EnemyEvent | undefined {
  if (enemy.state !== EnemyState.Chase || brain.quarry === undefined) return undefined;
  if (now < brain.nextAttackAt) return undefined;

  const quarry = targets.find((target) => target.sessionId === brain.quarry);
  if (!quarry) return undefined;
  if (distance(enemy.x, enemy.z, quarry.x, quarry.z) > archetype.attackRange) return undefined;

  // Committed: this direction, this target, no tracking. That is what makes
  // it dodgeable.
  brain.windupYaw = Math.atan2(quarry.x - enemy.x, quarry.z - enemy.z);
  brain.windupTarget = quarry.sessionId;
  brain.windupUntil = now + archetype.windupMs;
  brain.nextAttackAt = now + archetype.windupMs + archetype.attackCooldownMs;
  enemy.yaw = brain.windupYaw;
  return { type: "windup", target: quarry.sessionId, yaw: brain.windupYaw, ms: archetype.windupMs };
}

/** The windup is over: did the target get out of the way? */
function resolveBlow(
  enemy: MoveState,
  brain: EnemyBrain,
  archetype: EnemyArchetype,
  targets: readonly AITarget[],
): EnemyEvent | undefined {
  const target = brain.windupTarget;
  brain.windupUntil = 0;
  brain.windupTarget = undefined;
  if (target === undefined) return undefined;

  const victim = targets.find((candidate) => candidate.sessionId === target);
  // Died, left, or stepped through a Gate mid-swing.
  if (!victim) return undefined;

  // The same shape the client painted — see `attackArc`.
  const landed = isInArc(
    enemy.x, enemy.z, brain.windupYaw,
    victim.x, victim.z, PLAYER_RADIUS,
    archetype.attackReach, archetype.attackArc,
  );

  // A charger runs on through, hit or miss. Spent like knockback, so it
  // stops at a tree the way anything shoved into one does.
  if (archetype.dash) {
    brain.knockX += Math.sin(brain.windupYaw) * archetype.dash * KNOCK_DECAY;
    brain.knockZ += Math.cos(brain.windupYaw) * archetype.dash * KNOCK_DECAY;
  }
  return { type: landed ? "hit" : "miss", target };
}

/**
 * Who to chase. Anyone who has hurt it outranks anyone who hasn't; among
 * those, the most damage wins, with a 10% edge to the current quarry so two
 * players trading blows don't make it flip-flop between them. With no threat
 * at all, it is the nearest inside aggro range.
 *
 * An existing quarry is kept until it passes `deaggroRadius`, which is wider
 * than `aggroRadius` — without that gap, a player standing exactly on the aggro
 * line makes the creature start and stop every tick.
 */
function pickQuarry(
  enemy: MoveState,
  brain: EnemyBrain,
  archetype: EnemyArchetype,
  targets: readonly AITarget[],
): AITarget | undefined {
  let best: AITarget | undefined;
  let bestScore = -Infinity;

  for (const target of targets) {
    const range = distance(enemy.x, enemy.z, target.x, target.z);
    const threat = brain.threat.get(target.sessionId) ?? 0;
    const current = target.sessionId === brain.quarry;
    const limit = threat > 0
      ? archetype.deaggroRadius + PROVOKED_REACH
      : current ? archetype.deaggroRadius : archetype.aggroRadius;
    if (range > limit) continue;

    const score = (threat > 0 ? 1000 + threat * (current ? 1.1 : 1) : 0) - range;
    if (score > bestScore) {
      best = target;
      bestScore = score;
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

/** Spend some of the knockback velocity, through collision like any move. */
function applyKnockback(
  enemy: MoveState,
  brain: EnemyBrain,
  archetype: EnemyArchetype,
  dt: number,
  world: MoveWorld,
): void {
  if (Math.abs(brain.knockX) < 0.05 && Math.abs(brain.knockZ) < 0.05) {
    brain.knockX = 0;
    brain.knockZ = 0;
    return;
  }
  moveBody(enemy, brain.knockX * dt, brain.knockZ * dt, world, archetype.radius);
  const decay = Math.exp(-KNOCK_DECAY * dt);
  brain.knockX *= decay;
  brain.knockZ *= decay;
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
  const chasing = enemy.state === EnemyState.Chase;
  const preferred = chasing ? archetype.preferredRange : undefined;
  const stopAt = chasing
    ? preferred ?? archetype.radius + CONTACT_SLACK
    : 0.25;

  if (range > 1e-4) turnToward(enemy, Math.atan2(toX, toZ), dt);

  // A spitter backs off when you close on it, still facing you — so the way
  // to fight one is to commit to chasing it down.
  if (preferred !== undefined && range < preferred - 3 && range > 1e-4) {
    const retreat = archetype.chaseSpeed * 0.75 * dt;
    moveBody(enemy, (-toX / range) * retreat, (-toZ / range) * retreat, world, archetype.radius);
    return;
  }

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
