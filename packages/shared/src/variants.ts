/**
 * Creature variants: a kind's body and fight, with its own name, colour and
 * size, living in one hunting area and nowhere else (`HuntingArea` in
 * `ostras.ts`).
 *
 * A quest can only point at a place if what it asks for lives in one. "Kill
 * five wolves" on a map where wolves live everywhere is a quest with no
 * direction; "five Pathstalkers on the woodcutters' path" is somewhere to go,
 * and the map can draw it. So each variant has exactly one area, the area has
 * only that variant (the generated camps keep out of it), and quests ask for
 * variants.
 *
 * Nothing new to learn in a fight: a Thicket Weaver is a Void Spider, smaller
 * and green, and fights like one. The kind decides the body, the AI and the
 * effects; the variant is a name, a colour, a scale — which, like an elite's,
 * travels as `Enemy.scale`, so a bigger body is never a smaller hitbox — and
 * multipliers on health and damage.
 */

import type { EnemyKind } from "./enemies.js";

export interface CreatureVariant {
  id: string;
  /** Whose body, AI and effects it has. */
  kind: EnemyKind;
  name: string;
  /** 0xRRGGBB, in place of the kind's. */
  colour: number;
  /** Drawn and collided this many times the kind's size. */
  scale: number;
  /** Multipliers on what the kind has at the same level. */
  health: number;
  damage: number;
}

export const VARIANTS: Readonly<Record<string, CreatureVariant>> = {
  // The woodcutters' path, south-west of Daso: lean, hungry, brown.
  pathstalker: {
    id: "pathstalker", kind: "wolf", name: "Pathstalker",
    colour: 0x7d6a55, scale: 0.92, health: 0.95, damage: 1,
  },
  // The Webbed Thicket, north-west: small moss-green spiders, many of them.
  "thicket-weaver": {
    id: "thicket-weaver", kind: "spider", name: "Thicket Weaver",
    colour: 0x6b7b3c, scale: 0.8, health: 0.85, damage: 0.9,
  },
  // The Felled Ridge, east: Risen that climbed out of the roots of cut oaks.
  rootbound: {
    id: "rootbound", kind: "zombie", name: "Rootbound Risen",
    colour: 0x6a7a48, scale: 1.12, health: 1.15, damage: 1,
  },
  // Silkstrand Hollow, by the Westroad: the spiders taking the carts' crates.
  "silk-snatcher": {
    id: "silk-snatcher", kind: "spider", name: "Silk Snatcher",
    colour: 0x8c4a5c, scale: 1.08, health: 1.1, damage: 1.05,
  },
};

export function getVariant(id: string | undefined): CreatureVariant | undefined {
  return id !== undefined && Object.hasOwn(VARIANTS, id) ? VARIANTS[id] : undefined;
}
