/**
 * Dungeons: small Ostras built as rooms and passages cut into rock, entered
 * through a Gate, and instanced — each party gets its own copy, which empties
 * and resets when the last of them leaves.
 *
 * A dungeon is an ordinary `OstraDefinition` with a `dungeon` block, so it
 * gets everything a Gate and a room already do (the transfer, the camps, the
 * elites, loot) for free. What makes it a dungeon rather than a small Ostra:
 *
 *   - the server matches it by party as well as by Ostra (see `OstraRoom`);
 *   - nothing killed in it stands back up until the instance resets, and its
 *     boss does not come back at all;
 *   - its walls are solid rock, as box colliders shared by both sides, so a
 *     passage predicts exactly like walking round a house in Daso does.
 *
 * Laid out along one straight spine, rooms and passages alternating. Creatures
 * walk straight at their quarry and slide along whatever they hit (there is no
 * pathfinding), so a straight run of doorways is what lets a pull come to you
 * rather than wedge itself in a corner.
 */

/** A block of solid rock. Axis-aligned; collided as a box, drawn as stone. */
export interface WallBlock {
  x: number;
  z: number;
  width: number;
  depth: number;
  /** Drawn only. Collision is two-dimensional. */
  height: number;
}

/** A torch in a bracket on a wall, burning towards `yaw`. Drawn only. */
export interface TorchDefinition {
  x: number;
  z: number;
  yaw: number;
}

/** One open space on the spine: a room, or the passage between two. */
export interface DungeonSpace {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export interface DungeonDefinition {
  /** The creature levels inside, lowest to highest, for the Gate's label and
   *  the map. The camps carry their own. */
  levels: [number, number];
  /** Where you are put back on the Ostra you came from if the instance ends
   *  under you — logging out inside, or the server going down. The Gate you
   *  entered by, on that Ostra. */
  entrance: string;
  walls: WallBlock[];
  torches: TorchDefinition[];
}

/** Rooms narrower than this are passages: no torches, nothing lives there. */
const ROOM_WIDTH = 10;

/**
 * Cut a run of spaces out of solid rock filling a square of half-width
 * `extent`: a block either side of each space, reaching out to the edge, and a
 * cap at each end. Neighbouring spaces share their boundary, so a narrow
 * passage's blocks are the end walls of the wide rooms either side of it —
 * nothing needs to be worked out where they meet.
 *
 * Plain arithmetic only: these become colliders on both sides.
 */
export function carve(spaces: readonly DungeonSpace[], extent: number, height: number): {
  walls: WallBlock[];
  torches: TorchDefinition[];
} {
  const walls: WallBlock[] = [];
  const torches: TorchDefinition[] = [];
  // A little height to each block, so the skyline of the rock is broken
  // rather than one ruled line. Visual only.
  const rise = (i: number): number => height + ((i * 37) % 5) * 0.45;
  const block = (x0: number, x1: number, z0: number, z1: number): void => {
    if (x1 - x0 <= 0 || z1 - z0 <= 0) return;
    walls.push({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, width: x1 - x0, depth: z1 - z0, height: rise(walls.length) });
  };

  const first = spaces[0];
  const last = spaces[spaces.length - 1];
  if (!first || !last) return { walls, torches };
  block(-extent, extent, -extent, first.z0);
  for (const space of spaces) {
    block(-extent, space.x0, space.z0, space.z1);
    block(space.x1, extent, space.z0, space.z1);
    if (space.x1 - space.x0 < ROOM_WIDTH) continue;
    // A torch either side, a third and two thirds of the way along: enough to
    // light the room's walls, and a pair reads as placed rather than scattered.
    for (const t of [1 / 3, 2 / 3]) {
      const z = space.z0 + (space.z1 - space.z0) * t;
      torches.push({ x: space.x0 + 0.15, z, yaw: Math.PI / 2 });
      torches.push({ x: space.x1 - 0.15, z, yaw: -Math.PI / 2 });
    }
  }
  block(-extent, extent, last.z1, extent);
  return { walls, torches };
}
