/**
 * The things that live in the Ostras.
 *
 * The lore has plenty of gods and none of the small, dangerous things a new
 * traveller would actually meet — the Unnamed Ostras are described as
 * "inhabited by beasts and other mysteries", and this is the start of that.
 *
 * Archetypes are pure data, read by the server's AI and by the client's
 * renderer, so a creature's reach and its drawn size can never disagree.
 */

export type EnemyKind = "zombie" | "spider";

/** What an enemy is currently doing. On the wire as a uint8 so the client can
 *  react to it — a chasing creature is drawn lit. */
export const EnemyState = {
  Idle: 0,
  Wander: 1,
  Chase: 2,
  /** Leashed: walking back to where it started, ignoring everyone. */
  Return: 3,
  /** Killed. Stays in the state map so the client can play it falling, then
   *  comes back at its spawn — removing and re-adding would churn the map and
   *  rob the client of anything to animate. */
  Dead: 4,
} as const;
export type EnemyState = (typeof EnemyState)[keyof typeof EnemyState];

export interface EnemyArchetype {
  kind: EnemyKind;
  /** Shown on the label above it. */
  name: string;
  /** Metres per second when wandering. */
  speed: number;
  /** Metres per second when chasing. */
  chaseSpeed: number;
  /** Notices a player inside this range. */
  aggroRadius: number;
  /** Gives up once the target is beyond this. Wider than aggroRadius so a
   *  target hovering at the edge doesn't flicker in and out of the chase. */
  deaggroRadius: number;
  /** Never strays further than this from where it spawned. */
  leashRadius: number;
  /** How far it roams when picking somewhere to wander to. */
  wanderRadius: number;
  /** Collision radius, and the basis for the drawn size. */
  radius: number;
  /** Drawn height, for the label to float above. */
  height: number;
  maxHealth: number;
  /** Damage per hit on a player. */
  attackDamage: number;
  /** Reach from its centre to the player's, ignoring radii — creatures are
   *  already stopped by collision at roughly this distance. */
  attackRange: number;
  attackCooldownMs: number;
  /** 0xRRGGBB body colour. */
  colour: number;
  /** Seconds it stands around between wanders, roughly. */
  idleSeconds: number;
}

export const ENEMY_ARCHETYPES: Record<EnemyKind, EnemyArchetype> = {
  /**
   * Slow, relentless, and hard to shake — it notices you from a long way off
   * and keeps coming. The threat is that it does not stop, not that it is fast.
   */
  zombie: {
    kind: "zombie",
    name: "Risen",
    speed: 1.4,
    chaseSpeed: 3.2,
    aggroRadius: 13,
    deaggroRadius: 20,
    leashRadius: 26,
    wanderRadius: 7,
    radius: 0.6,
    height: 1.9,
    maxHealth: 60,
    // Hits hard but slowly: being cornered by three is the danger, not one.
    attackDamage: 11,
    attackRange: 1.9,
    attackCooldownMs: 1400,
    colour: 0x6f8f52,
    idleSeconds: 2.6,
  },

  /**
   * The opposite: short-sighted but faster than a player, so it is only a
   * problem once you are close — and then it is immediately a problem.
   */
  spider: {
    kind: "spider",
    name: "Void Spider",
    speed: 2.6,
    chaseSpeed: 7.2,
    aggroRadius: 8,
    deaggroRadius: 13,
    leashRadius: 20,
    wanderRadius: 11,
    radius: 0.7,
    height: 0.85,
    maxHealth: 35,
    // Fragile, but it lands three hits for every one a Risen manages.
    attackDamage: 6,
    attackRange: 1.6,
    attackCooldownMs: 500,
    colour: 0x4a4266,
    idleSeconds: 1.1,
  },
};

export const ENEMY_KINDS = Object.keys(ENEMY_ARCHETYPES) as EnemyKind[];

export function isEnemyKind(value: unknown): value is EnemyKind {
  return typeof value === "string" && Object.hasOwn(ENEMY_ARCHETYPES, value);
}

export function getArchetype(kind: EnemyKind): EnemyArchetype {
  return ENEMY_ARCHETYPES[kind];
}

/** A cluster of creatures placed in an Ostra when its room is created. */
export interface SpawnGroup {
  kind: EnemyKind;
  count: number;
  /** Centre of the camp. Individuals are scattered around it. */
  x: number;
  z: number;
  radius: number;
}
