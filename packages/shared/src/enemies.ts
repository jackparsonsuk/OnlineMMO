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
  /** Starts an attack once its centre is this close to the player's, ignoring
   *  radii — creatures are already stopped by collision at roughly this
   *  distance. */
  attackRange: number;
  /**
   * How long it telegraphs before the blow lands, in ms.
   *
   * This is what makes a fight something you play rather than something that
   * happens to you. The creature commits to a direction, the client draws the
   * danger zone on the ground, and a player who steps out of it takes nothing.
   * Before this, damage simply ticked off whenever something stood next to
   * you, and there was no decision to make.
   */
  windupMs: number;
  /** When the blow lands, it hits whatever of the player is inside this reach
   *  (measured to the player's surface, like spells) ... */
  attackReach: number;
  /** ... and inside this wedge, centred on where it faced at windup. Shared
   *  with the client, which paints exactly this shape as the telegraph. */
  attackArc: number;
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
    // A big, slow overhead. Plenty of time to see it and step back — the
    // Risen punishes standing still, not bad reflexes.
    windupMs: 560,
    attackReach: 1.6,
    attackArc: Math.PI * 0.62,
    attackCooldownMs: 1500,
    // Shifted grey-yellow: the old green was almost exactly Terra's grass,
    // and a creature you cannot pick out of the ground is not a threat, it
    // is an ambush the player never gets to answer.
    colour: 0xa8a86a,
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
    // Barely a flinch of warning. The spider is the one you cannot dance
    // around; you kill it or you pay.
    windupMs: 300,
    attackReach: 1.2,
    attackArc: Math.PI * 0.42,
    attackCooldownMs: 650,
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

/** A hand-placed cluster of creatures. Terra's wilds add generated camps of
 *  the same shape — see `worldgen.ts`. */
export interface SpawnGroup {
  kind: EnemyKind;
  count: number;
  /** Centre of the camp. Individuals are scattered around it. */
  x: number;
  z: number;
  radius: number;
  /** Defaults to 1. */
  level?: number;
}

// --- levels -----------------------------------------------------------------

/**
 * How dangerous one particular creature is, on top of its Ostra's difficulty.
 *
 * There is no XP in this game — proficiency grows by use — so a level here is
 * not a gate, it is a WARNING: it tells you, before you swing, how far out of
 * your depth you are. On an eight-kilometre Terra it rises with distance from
 * the Gate Circle, which is what gives the map a shape: the further you go,
 * the more it costs and the better it pays.
 */
export const MAX_ENEMY_LEVEL = 12;

export function levelHealthScale(level: number): number {
  return 1 + 0.3 * (level - 1);
}

export function levelDamageScale(level: number): number {
  return 1 + 0.2 * (level - 1);
}
