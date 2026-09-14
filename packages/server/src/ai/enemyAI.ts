import {
  difficultyOf,
  EnemyState,
  isInArc,
  levelGapEffect,
  moveBody,
  PLAYER_RADIUS,
  STAGGER_MS,
  type EnemyArchetype,
  type MoveState,
  type MoveWorld,
} from "@mmo/shared";
import { clearLine, findPath } from "./pathfinding.js";

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
  /** A spitter its quarry has closed on: it stops backing off and fights
   *  where it stands until they walk clear (see CAUGHT_REACH). */
  cornered: boolean;
  /** The way round, when the straight line is blocked (see `pathfinding.ts`):
   *  waypoints, the goal they lead to, and when they were found. */
  path: { points: Array<{ x: number; z: number }>; goalX: number; goalZ: number; at: number } | undefined;
  /** When the straight line to the goal was last checked, and whether it was clear. */
  lineCheckedAt: number;
  lineClear: boolean;
  /** Since when no way to the quarry has been found; 0 while there is one. */
  unreachableSince: number;
  /** Going round: the nearest it has got to the goal, and when it last got nearer. */
  roundBest: number;
  roundBestAt: number;
}

/** Just enough of a player for the AI to hunt it. */
export interface AITarget {
  sessionId: string;
  x: number;
  z: number;
  /** A creature above this sees them sooner and swings faster (LEVEL_GAP). */
  level: number;
}

/** What the AI reads of a creature beyond where it stands. */
type Creature = MoveState & { health: number; state: number; level: number };

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

/**
 * Close a spitter to within this (centre to centre, beyond its own radius)
 * and it is caught: it stops backing off and fights where it stands.
 *
 * Without it a spitter retreated forever, and once blows took time to land —
 * Strike takes most of a second, standing — it had always stepped out of reach
 * before the swing arrived. Chasing it down is still the fight; this is what
 * makes catching it count. Strike's reach plus a little.
 */
const CAUGHT_REACH = 3;

/** Per-second decay of knockback velocity. A shove that ends in ~a third of a
 *  second reads as impact; slower reads as ice. */
const KNOCK_DECAY = 9;

/** A player who has hurt it is chased this much further than one who hasn't,
 *  so a blow from the edge of range is never free. */
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
    cornered: false,
    path: undefined,
    lineCheckedAt: 0,
    lineClear: true,
    unreachableSince: 0,
    roundBest: Infinity,
    roundBestAt: 0,
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
  brain.cornered = false;
  brain.path = undefined;
  brain.unreachableSince = 0;
  brain.roundBest = Infinity;
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

/**
 * A Battle Cry: turn on the one who shouted. Threat to beat everyone else's
 * by a margin, so it holds for a while against a friend still hitting it —
 * but only threat, so a friend who keeps on doing far more wins it back, as
 * a tank should have to keep earning it.
 */
export function taunt(brain: EnemyBrain, sessionId: string): void {
  if (brain.returning) return;
  let top = 0;
  for (const amount of brain.threat.values()) top = Math.max(top, amount);
  brain.threat.set(sessionId, Math.max(brain.threat.get(sessionId) ?? 0, top * 1.3 + 20));
  brain.quarry = sessionId;
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
  enemy: Creature,
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

  // A quarry there is no way to has been hunted long enough: give up, go home
  // and heal, as if leashed. Standing on a ledge it cannot climb and throwing
  // things at it is not a way to win a fight.
  if (brain.unreachableSince > 0 && now - brain.unreachableSince > UNREACHABLE_MS && enemy.state === EnemyState.Chase) {
    brain.returning = true;
    calmDown(brain);
    return undefined;
  }

  advance(enemy, brain, archetype, dt, world, now);

  return beginAttack(enemy, brain, archetype, targets, now);
}

/** Start winding up on the quarry if it is in reach and the cooldown is done. */
function beginAttack(
  enemy: Creature,
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
  // it dodgeable — less so the further it stands above whoever it swings at.
  const windupMs = Math.round(archetype.windupMs * levelGapEffect(enemy.level, quarry.level, 0).windup);
  brain.windupYaw = Math.atan2(quarry.x - enemy.x, quarry.z - enemy.z);
  brain.windupTarget = quarry.sessionId;
  brain.windupUntil = now + windupMs;
  brain.nextAttackAt = now + windupMs + archetype.attackCooldownMs;
  enemy.yaw = brain.windupYaw;
  return { type: "windup", target: quarry.sessionId, yaw: brain.windupYaw, ms: windupMs };
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
  enemy: Creature,
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
    // Something grey to you leaves you be unless you start it: a level-12
    // walking home through the Westwood should not be nipped at by every
    // Pathstalker it passes. Hitting it — or its camp, which rallies — is
    // threat, and then it fights like anything else.
    if (threat === 0 && !current && difficultyOf(enemy.level, target.level) === "grey") continue;
    // Something well above you notices you from further off — and, so the
    // gap between noticing and giving up survives, lets go further off too.
    const sooner = levelGapEffect(enemy.level, target.level, 0).aggro;
    const limit = threat > 0
      ? archetype.deaggroRadius + sooner + PROVOKED_REACH
      : current ? archetype.deaggroRadius + sooner : archetype.aggroRadius + sooner;
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
  now: number,
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
  // to fight one is to commit to chasing it down. Once caught it stands, and
  // only starts keeping its distance again once you have walked well clear.
  if (preferred !== undefined) {
    if (range <= archetype.radius + CAUGHT_REACH) brain.cornered = true;
    else if (range >= preferred) brain.cornered = false;
  } else {
    brain.cornered = false;
  }
  if (preferred !== undefined && !brain.cornered && range < preferred - 3 && range > 1e-4) {
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
  // Straight at the goal when the way is clear; otherwise at the next point of
  // a way round. Wandering stays straight: an amble that bumps into a tree is
  // fine, and not worth a search.
  const purposeful = enemy.state === EnemyState.Chase || enemy.state === EnemyState.Return;
  const [aimX, aimZ] = purposeful ? steer(enemy, brain, archetype, world, now) : [brain.targetX, brain.targetZ];
  const aimDX = aimX - enemy.x;
  const aimDZ = aimZ - enemy.z;
  const aimRange = Math.hypot(aimDX, aimDZ);
  if (aimRange < 1e-4) return;
  if (aimRange !== range) turnToward(enemy, Math.atan2(aimDX, aimDZ), dt);
  // Never overshoot the goal (or the waypoint) in a single step.
  const travel = Math.min(speed * dt, range, aimRange);
  moveBody(enemy, (aimDX / aimRange) * travel, (aimDZ / aimRange) * travel, world, archetype.radius);
}

/** How often a chasing creature re-checks that its straight line is clear. */
const LINE_CHECK_MS = 300;
/** A way round is found again when the goal has moved this far, or it is this old. */
const REPATH_DISTANCE = 2.5;
const REPATH_MS = 1500;
/** No way to the quarry for this long, and the creature gives up and goes home. */
const UNREACHABLE_MS = 4000;
/** Close enough to a waypoint to make for the next. */
const WAYPOINT_REACHED = 0.7;

/** Where to walk towards this tick: the goal itself, or the next waypoint round to it. */
function steer(
  enemy: MoveState & { state: number },
  brain: EnemyBrain,
  archetype: EnemyArchetype,
  world: MoveWorld,
  now: number,
): [number, number] {
  const goalX = brain.targetX;
  const goalZ = brain.targetZ;
  if (now - brain.lineCheckedAt > LINE_CHECK_MS) {
    brain.lineCheckedAt = now;
    brain.lineClear = clearLine(world, enemy.x, enemy.z, goalX, goalZ, archetype.radius);
  }
  if (brain.lineClear) {
    brain.path = undefined;
    brain.unreachableSince = 0;
    brain.roundBest = Infinity;
    return [goalX, goalZ];
  }

  // Going round, and getting no nearer: a way the grid found but a body cannot
  // follow — a ledge a metre too steep between two cells — is no way at all.
  const distance = Math.hypot(goalX - enemy.x, goalZ - enemy.z);
  if (distance < brain.roundBest - 0.5) {
    brain.roundBest = distance;
    brain.roundBestAt = now;
    brain.unreachableSince = 0;
  } else if (brain.roundBest === Infinity) {
    brain.roundBest = distance;
    brain.roundBestAt = now;
  } else if (enemy.state === EnemyState.Chase && now - brain.roundBestAt > UNREACHABLE_MS && brain.unreachableSince === 0) {
    brain.unreachableSince = brain.roundBestAt;
  }

  const path = brain.path;
  const stale = !path || now - path.at > REPATH_MS
    || Math.hypot(path.goalX - goalX, path.goalZ - goalZ) > REPATH_DISTANCE;
  if (stale) {
    const points = findPath(world, enemy.x, enemy.z, goalX, goalZ, archetype.radius);
    if (!points) {
      brain.path = undefined;
      // Only a quarry can be out of reach; a way home that cannot be found is
      // walked straight, and the leash brings it back in the end.
      if (enemy.state === EnemyState.Chase && brain.unreachableSince === 0) brain.unreachableSince = now;
      return [goalX, goalZ];
    }
    brain.path = { points, goalX, goalZ, at: now };
  }

  const route = brain.path!.points;
  while (route.length > 1 && Math.hypot(route[0]!.x - enemy.x, route[0]!.z - enemy.z) < WAYPOINT_REACHED) route.shift();
  return [route[0]!.x, route[0]!.z];
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
