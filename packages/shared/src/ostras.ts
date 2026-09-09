import { getArchetype, type SpawnGroup } from "./enemies.js";
import type { Collider } from "./movement.js";

/**
 * The Ostras the game currently knows about, and the Gates between them.
 *
 * In the fiction the Gates were shut down in Y1100 and the Ostracon has been
 * isolated ever since; this game is set at the moment they come back on, which
 * is why there are so few of them and why Terra is the only hub. Named Ostras
 * are hand-authored and persistent, like these. Unnamed Ostras — the small,
 * beast-ridden ones — are meant to be generated into this same shape later, so
 * keep this a plain data table rather than anything clever.
 */

export type OstraId = "terra" | "ascendant" | "barals";

export interface GateDefinition {
  /** Unique within its own Ostra. */
  id: string;
  /** Shown to the player when they are standing in range. */
  label: string;
  /** Where this Gate leads. */
  target: OstraId;
  /** The Gate on the far side you step out of. */
  targetGate: string;
  x: number;
  z: number;
  /**
   * Which way you face when arriving through this Gate, in radians. You step
   * out GATE_ARRIVAL_OFFSET metres along this heading, so it should point into
   * the Ostra rather than at a wall.
   */
  exitYaw: number;
}

/** Per-Ostra look. Travel only feels like travel if the place looks different. */
export interface OstraPalette {
  /** Background, behind everything. */
  sky: string;
  /** Ground fill and grid lines. */
  ground: string;
  grid: string;
  /** Boundary walls. */
  edge: string;
  /** Ambient bounce colour, tinting everything in shadow. */
  bounce: string;
}

/** A solid circular prop. Collided against by both sides, and identical on
 *  both, so it predicts perfectly — unlike another player. */
export interface ObstacleDefinition {
  x: number;
  z: number;
  radius: number;
  /** Purely visual; collision is a 2D circle. */
  height: number;
}

/** How an Ostra's scenery is drawn. Collision is a circle either way — this
 *  only decides which low-poly form sits on top of it. */
export type ObstacleStyle = "pillar" | "boulder";

export interface OstraDefinition {
  id: OstraId;
  /** "Terra Ostra" */
  name: string;
  /** The Common Tongue translation, per the lore. */
  subtitle: string;
  /** The playable area is a size x size square centred on the origin. */
  size: number;
  /** Where a brand-new character first opens their eyes. */
  spawn: { x: number; z: number };
  palette: OstraPalette;
  gates: GateDefinition[];
  obstacles: ObstacleDefinition[];
  obstacleStyle: ObstacleStyle;
  /** Creatures placed when the room is created. */
  spawns: SpawnGroup[];
}

/** Face the middle of the Ostra from a point on its edge. */
function facingCentre(x: number, z: number): number {
  return Math.atan2(-x, -z);
}

export const OSTRAS: Record<OstraId, OstraDefinition> = {
  terra: {
    id: "terra",
    name: "Terra Ostra",
    subtitle: "Earth Shard",
    size: 80,
    spawn: { x: 0, z: 0 },
    palette: {
      sky: "#0d1117",
      ground: "#111a16",
      grid: "#3f6b52",
      edge: "#2b4438",
      bounce: "#1a2620",
    },
    gates: [
      {
        id: "terra-ascendant",
        label: "Gate to the Ascendant Ostra",
        target: "ascendant",
        targetGate: "ascendant-terra",
        x: 20,
        z: 20,
        exitYaw: facingCentre(20, 20),
      },
      {
        id: "terra-barals",
        label: "Gate to Barals Ostra",
        target: "barals",
        targetGate: "barals-terra",
        x: -20,
        z: 20,
        exitYaw: facingCentre(-20, 20),
      },
    ],
    obstacles: [
      { x: 6, z: -9, radius: 1.4, height: 3.2 },
      { x: -8, z: -6, radius: 1.1, height: 2.4 },
      { x: -3, z: 11, radius: 1.8, height: 4.0 },
      { x: 13, z: 4, radius: 1.2, height: 2.8 },
      { x: -14, z: -14, radius: 2.2, height: 5.0 },
      { x: 24, z: -3, radius: 1.6, height: 3.6 },
    ],
    obstacleStyle: "pillar",
    // Kept away from spawn: a new traveller gets a moment before anything
    // notices them.
    // Spread wide on purpose. Packed tighter than a Risen's aggro radius,
    // every approach pulls the whole camp at once and a new player never gets
    // a winnable first fight.
    spawns: [
      { kind: "zombie", count: 4, x: 14, z: -26, radius: 12 },
      { kind: "spider", count: 3, x: -22, z: -8, radius: 8 },
    ],
  },

  ascendant: {
    id: "ascendant",
    name: "Ascendant Ostra",
    subtitle: "Realm of the Gods",
    size: 50,
    spawn: { x: 0, z: 0 },
    palette: {
      sky: "#12100a",
      ground: "#1e1a10",
      grid: "#b8963f",
      edge: "#5a4a22",
      bounce: "#2e2716",
    },
    gates: [
      {
        id: "ascendant-terra",
        label: "Gate to the Terra Ostra",
        target: "terra",
        targetGate: "terra-ascendant",
        x: 0,
        z: -16,
        exitYaw: facingCentre(0, -16),
      },
    ],
    // Tall, thin columns — the gods' realm reads as architecture, not rubble.
    obstacles: [
      { x: 5, z: 5, radius: 0.9, height: 7.0 },
      { x: -5, z: 5, radius: 0.9, height: 7.0 },
      { x: 5, z: -5, radius: 0.9, height: 7.0 },
      { x: -5, z: -5, radius: 0.9, height: 7.0 },
      { x: 0, z: 12, radius: 2.4, height: 9.0 },
    ],
    obstacleStyle: "pillar",
    // The gods' realm is guarded, not infested.
    spawns: [
      { kind: "spider", count: 2, x: 14, z: 10, radius: 4 },
    ],
  },

  barals: {
    id: "barals",
    name: "Barals Ostra",
    subtitle: "Realm of Fire and Pain",
    size: 60,
    // Deliberately north of every camp. At the origin this sat 10m from the
    // zombies, inside their 13m aggro — you respawned straight into a death
    // loop. `unsafeSpawns()` exists so that cannot come back unnoticed.
    spawn: { x: 0, z: 24 },
    palette: {
      sky: "#140a08",
      ground: "#1f0f0b",
      grid: "#a83c22",
      edge: "#5c2315",
      bounce: "#301410",
    },
    gates: [
      {
        id: "barals-terra",
        label: "Gate to the Terra Ostra",
        target: "terra",
        targetGate: "terra-barals",
        x: 0,
        z: -20,
        exitYaw: facingCentre(0, -20),
      },
    ],
    // Squat volcanic rock, scattered without pattern.
    obstacles: [
      { x: 8, z: 2, radius: 2.6, height: 2.2 },
      { x: -7, z: -4, radius: 1.9, height: 1.6 },
      { x: 2, z: -11, radius: 3.1, height: 2.8 },
      { x: -13, z: 9, radius: 2.2, height: 2.0 },
      { x: 15, z: -14, radius: 1.7, height: 1.4 },
      { x: -2, z: 16, radius: 2.8, height: 3.4 },
    ],
    obstacleStyle: "boulder",
    // The realm of fire and pain earns its name.
    spawns: [
      { kind: "zombie", count: 6, x: -8, z: -2, radius: 9 },
      { kind: "zombie", count: 3, x: 16, z: -6, radius: 5 },
      { kind: "spider", count: 4, x: -18, z: -12, radius: 7 },
    ],
  },
};

/** Where new characters begin. Terra is the mixing pot, per the lore. */
export const STARTING_OSTRA: OstraId = "terra";

export const OSTRA_IDS = Object.keys(OSTRAS) as OstraId[];

export function isOstraId(value: unknown): value is OstraId {
  return typeof value === "string" && Object.hasOwn(OSTRAS, value);
}

export function getOstra(id: OstraId): OstraDefinition {
  return OSTRAS[id];
}

/**
 * The scenery colliders for an Ostra, built once and reused. Both the server
 * room and the client's prediction call this every step, and they must get
 * identical values — deriving them from the same table is what guarantees it.
 */
const staticColliderCache = new Map<OstraId, readonly Collider[]>();

export function staticColliders(ostra: OstraDefinition): readonly Collider[] {
  let cached = staticColliderCache.get(ostra.id);
  if (!cached) {
    cached = ostra.obstacles.map((obstacle, index) => ({
      id: `obstacle:${index}`,
      x: obstacle.x,
      z: obstacle.z,
      radius: obstacle.radius,
    }));
    staticColliderCache.set(ostra.id, cached);
  }
  return cached;
}

/**
 * Ostras whose spawn point sits inside something's aggro radius.
 *
 * Found the hard way: Barals put new arrivals 10m from a camp of Risen that
 * notice you at 13m, so dying meant respawning into the same creatures that
 * had just killed you. The layout is hand-authored data, and hand-authored
 * data drifts — so this is checked at boot rather than by eye.
 *
 * Returns a human-readable line per problem, empty when all is well.
 */
export function unsafeSpawns(): string[] {
  const problems: string[] = [];

  for (const ostra of Object.values(OSTRAS)) {
    for (const group of ostra.spawns) {
      const archetype = getArchetype(group.kind);
      const centreDistance = Math.hypot(
        group.x - ostra.spawn.x,
        group.z - ostra.spawn.z,
      );
      // Worst case is a creature scattered to the near edge of its camp.
      const nearest = Math.max(0, centreDistance - group.radius);
      if (nearest <= archetype.aggroRadius) {
        problems.push(
          `${ostra.name}: ${archetype.name} camp can reach within ${nearest.toFixed(1)}m ` +
          `of the spawn point, inside its ${archetype.aggroRadius}m aggro radius`,
        );
      }
    }
  }

  return problems;
}

export function findGate(ostra: OstraDefinition, gateId: string): GateDefinition | undefined {
  return ostra.gates.find((gate) => gate.id === gateId);
}
