/**
 * Rare elites: one named creature per region, much tougher than anything
 * around it, that comes back only long after it falls.
 *
 * They give each region a goal and the loot table a top. Ordinary creatures
 * stop at rare (see `SOURCE_ODDS` in the server's `loot.ts`); an elite is the
 * first thing in the world that can drop mythic and legendary gear, and it
 * always drops something. Each waits by a ruin or deep in its region, so
 * finding one is part of hunting it, and the whole Ostra hears when one wakes
 * and when one falls.
 *
 * Pure data plus one level rule, read by the server to spawn them and by the
 * client to name them. Their spatial size travels on the wire as
 * `Enemy.scale` (see `scaledArchetype`); health and damage stay server-side.
 */

import { MAX_ENEMY_LEVEL, scaledArchetype, type EnemyKind } from "./enemies.js";
import { getOstra, settlementsIn, type OstraDefinition, type OstraId } from "./ostras.js";
import { levelAt, safePoints } from "./worldgen.js";

/**
 * What makes an elite a fight rather than a bigger creature. Each is a trigger
 * and an effect, resolved by the server; the client only draws what it is
 * told (a slam's ring is an ordinary telegraph with a wider shape).
 */
export type EliteAbility =
  /** At each health fraction in `at`, `count` of `creature` join the fight.
   *  They drop nothing and vanish when the fight ends. */
  | { kind: "summon"; creature: EnemyKind; count: number; at: number[]; cry: string }
  /** Every `everyMs`, it roots itself and slams: everyone within `radius` when
   *  `windupMs` runs out takes `damage` times its usual blow. Step out. */
  | { kind: "slam"; radius: number; windupMs: number; everyMs: number; damage: number; cry: string }
  /** Below `at` of its health, it hits harder and faster for the rest of the fight. */
  | { kind: "enrage"; at: number; cry: string };

/** Enraged: blows this much harder, and this much less time between them. */
export const ENRAGE_DAMAGE = 1.35;
export const ENRAGE_COOLDOWN = 0.55;

export interface EliteDefinition {
  id: string;
  ostra: OstraId;
  /** Shown on its nametag instead of the creature's own name. */
  name: string;
  /** Announced with the name: "Old Greymuzzle, Alpha of the Greywood". */
  title: string;
  kind: EnemyKind;
  /** Where it spawns and returns to. */
  x: number;
  z: number;
  /** Drawn and collided this many times bigger. */
  scale: number;
  /** Multipliers on what an ordinary creature of its kind and level has. */
  health: number;
  damage: number;
  /** It comes back somewhere in this window after it falls, in minutes. */
  respawnMinutes: [number, number];
  /** Items it drops for each player who earned a share (see `CREDIT_*`),
   *  each rolled from the elite loot table. */
  drops: number;
  abilities: EliteAbility[];
}

/**
 * Who gets loot and credit when an elite falls: anyone who dealt at least
 * CREDIT_DAMAGE_SHARE of its health, or who took at least CREDIT_TAKEN_SHARE
 * of their own health in its blows — holding its attention is a share of the
 * work too. One hit, or the killing blow alone, earns nothing; the fight has
 * to have been partly yours. Each of them gets their own drops.
 */
export const CREDIT_DAMAGE_SHARE = 0.1;
export const CREDIT_TAKEN_SHARE = 0.25;

/** How much tougher than the ground it stands on an elite is. */
const ELITE_LEVEL_BONUS = 3;

export const ELITES: readonly EliteDefinition[] = [
  {
    id: "silkmother", ostra: "terra", name: "Silkmother", title: "Queen of the Westwood Webs",
    kind: "spider", x: -1750, z: 250, scale: 1.7, health: 7, damage: 1.5, respawnMinutes: [15, 25], drops: 2,
    abilities: [
      { kind: "summon", creature: "spider", count: 3, at: [0.6, 0.3], cry: "Silkmother's brood spills from the webs!" },
    ],
  },
  {
    id: "greymuzzle", ostra: "terra", name: "Old Greymuzzle", title: "Alpha of the Greywood",
    kind: "wolf", x: -1850, z: 1500, scale: 1.6, health: 8, damage: 1.6, respawnMinutes: [15, 25], drops: 2,
    abilities: [
      { kind: "summon", creature: "wolf", count: 2, at: [0.5], cry: "Old Greymuzzle howls, and the pack answers!" },
      { kind: "enrage", at: 0.25, cry: "Old Greymuzzle's hackles rise!" },
    ],
  },
  {
    id: "crownless", ostra: "terra", name: "The Crownless King", title: "Last Lord of the Broken Crown",
    kind: "zombie", x: -380, z: 2200, scale: 1.5, health: 9, damage: 1.6, respawnMinutes: [20, 30], drops: 2,
    abilities: [
      { kind: "summon", creature: "zombie", count: 3, at: [0.7, 0.4], cry: "The Crownless King raises his court!" },
    ],
  },
  {
    id: "silt", ostra: "terra", name: "Mother Silt", title: "She Who Waits in the Shallows",
    kind: "wretch", x: 2650, z: 2600, scale: 1.6, health: 8, damage: 1.6, respawnMinutes: [15, 25], drops: 2,
    abilities: [
      { kind: "slam", radius: 6, windupMs: 1400, everyMs: 9000, damage: 1.8, cry: "The shallows heave around Mother Silt!" },
    ],
  },
  {
    id: "tuskbreaker", ostra: "terra", name: "Old Tuskbreaker", title: "Terror of the Sunward Grass",
    kind: "boar", x: 1700, z: 570, scale: 1.6, health: 8, damage: 1.6, respawnMinutes: [15, 25], drops: 2,
    abilities: [
      { kind: "slam", radius: 4.5, windupMs: 1100, everyMs: 11000, damage: 1.5, cry: "Old Tuskbreaker stamps the ground!" },
      { kind: "enrage", at: 0.35, cry: "Old Tuskbreaker tears at the earth!" },
    ],
  },
  {
    id: "keeper", ostra: "terra", name: "The Anvil's Keeper", title: "Forged, and Never Finished",
    // A golem is already the toughest thing on Terra; a smaller multiplier
    // still makes it the longest fight.
    kind: "golem", x: 2200, z: -1900, scale: 1.3, health: 4, damage: 1.5, respawnMinutes: [25, 35], drops: 3,
    abilities: [
      { kind: "slam", radius: 7, windupMs: 1700, everyMs: 8000, damage: 2.2, cry: "The Anvil's Keeper raises both fists!" },
    ],
  },
  {
    id: "ember", ostra: "terra", name: "The Ember That Walks", title: "Last Fire of Cinder Spire",
    kind: "wisp", x: -2750, z: -2500, scale: 1.7, health: 8, damage: 1.6, respawnMinutes: [20, 30], drops: 2,
    abilities: [
      { kind: "summon", creature: "wisp", count: 3, at: [0.6, 0.3], cry: "The Ember That Walks splits into cinders!" },
    ],
  },
  {
    id: "abbot", ostra: "terra", name: "The Drowned Abbot", title: "Keeper of the Sunken Hall",
    kind: "wretch", x: -490, z: -2190, scale: 1.6, health: 8, damage: 1.6, respawnMinutes: [20, 30], drops: 2,
    abilities: [
      { kind: "summon", creature: "wretch", count: 2, at: [0.5], cry: "The drowned rise to the Abbot's call!" },
      { kind: "enrage", at: 0.3, cry: "The Drowned Abbot rises out of the water!" },
    ],
  },
];

export function elitesIn(ostra: OstraId): EliteDefinition[] {
  return ELITES.filter((elite) => elite.ostra === ostra);
}

export function getElite(id: string): EliteDefinition | undefined {
  return ELITES.find((elite) => elite.id === id);
}

/** A few levels above the ground it stands on. */
export function eliteLevel(ostra: OstraDefinition, elite: EliteDefinition): number {
  return Math.min(MAX_ENEMY_LEVEL, levelAt(ostra, elite.x, elite.z) + ELITE_LEVEL_BONUS);
}

/**
 * Elites that could notice someone standing somewhere meant to be safe — the
 * same rule `unsafeSpawns` holds camps to, measured from anywhere the elite
 * might have wandered. Hand-placed data drifts; this runs at boot.
 */
export function unsafeElites(): string[] {
  const problems: string[] = [];
  for (const elite of ELITES) {
    const ostra = getOstra(elite.ostra);
    const archetype = scaledArchetype(elite.kind, elite.scale);
    const half = ostra.size / 2;
    if (Math.abs(elite.x) > half || Math.abs(elite.z) > half) {
      problems.push(`${ostra.name}: ${elite.name} is outside the Ostra`);
      continue;
    }
    const safe: Array<{ x: number; z: number; label: string; radius: number }> = [
      ...safePoints(ostra).map((p) => ({ ...p, radius: 0 })),
      ...settlementsIn(ostra).map((s) => ({ x: s.x, z: s.z, label: s.name, radius: s.radius })),
    ];
    for (const point of safe) {
      const reach = Math.hypot(elite.x - point.x, elite.z - point.z) - point.radius - archetype.wanderRadius;
      if (reach <= archetype.aggroRadius) {
        problems.push(`${ostra.name}: ${elite.name} can wander within ${reach.toFixed(1)}m of ${point.label}`);
      }
    }
  }
  return problems;
}
