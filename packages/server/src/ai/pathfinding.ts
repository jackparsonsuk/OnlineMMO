import { heightAt, MAX_CLIMB_GRADE, MAX_WADE_DEPTH, seaDepthAt, type MoveWorld } from "@mmo/shared";

/**
 * Finding a way round, for creatures.
 *
 * Creatures walked straight at their quarry and slid along whatever they hit,
 * which a forest and a cliff both turn into a creature standing still. So a
 * level-20 Risen could be beaten from behind a tree trunk, or from two metres
 * up a slope it could not climb — the level gap made fights hard, and this
 * made them optional.
 *
 * Server-only, like the rest of the AI, so none of it needs to agree with any
 * other machine. It is a small A* over a one-metre grid around the creature
 * and its goal, asking the same questions `moveBody` answers when it refuses
 * a step: is there a tree, a rock or a building here, is this uphill too
 * steep to walk, is this sea too deep to wade. Bodies are left out on
 * purpose — another creature in the way moves, a tree does not.
 */

/** Metres per grid step. A body is at least a metre across, so a gap a creature
 *  cannot fit through is never found as a way through. */
const CELL = 1;

/** How much ground a search may cover beyond the box round start and goal. */
const PADDING = 12;

/** The most cells a search may look at before giving up. A chase is at most
 *  some thirty metres, and a way round through a thick wood was found in two
 *  milliseconds on average; searches that fail are what reach this, so it is
 *  what keeps a hopeless one from costing a tick. */
const MAX_EXPANDED = 2500;

/** Is a body of `radius` blocked by scenery or a building at (x, z)? */
export function blockedAt(world: MoveWorld, x: number, z: number, radius: number): boolean {
  const scenery = world.scenery;
  if (scenery) {
    const size = scenery.cellSize;
    const cx = Math.floor(x / size);
    const cz = Math.floor(z / size);
    for (let oz = -1; oz <= 1; oz++) {
      for (let ox = -1; ox <= 1; ox++) {
        for (const c of scenery.cell(cx + ox, cz + oz)) {
          const reach = c.radius + radius;
          const dx = x - c.x;
          const dz = z - c.z;
          if (dx * dx + dz * dz < reach * reach) return true;
        }
      }
    }
  }
  for (const box of world.boxes ?? []) {
    const sin = Math.sin(box.yaw);
    const cos = Math.cos(box.yaw);
    const relX = x - box.x;
    const relZ = z - box.z;
    const localX = relX * cos - relZ * sin;
    const localZ = relX * sin + relZ * cos;
    if (Math.abs(localX) < box.halfWidth + radius && Math.abs(localZ) < box.halfDepth + radius) return true;
  }
  const limit = world.halfExtent - radius;
  return x < -limit || x > limit || z < -limit || z > limit;
}

/** Can a step go from a point at `fromHeight` to (x, z), `distance` away? */
function footingOk(world: MoveWorld, fromHeight: number, x: number, z: number, distance: number): boolean {
  const terrain = world.terrain;
  if (!terrain) return true;
  const height = heightAt(x, z, terrain);
  if (height - fromHeight > MAX_CLIMB_GRADE * distance) return false;
  if (terrain.sea && seaDepthAt(x, z, terrain) > MAX_WADE_DEPTH) return false;
  return true;
}

/**
 * Could a body walk straight from A to B? Sampled every half metre: nothing
 * solid in the way, and no step of it uphill steeper than can be climbed.
 */
export function clearLine(world: MoveWorld, ax: number, az: number, bx: number, bz: number, radius: number): boolean {
  const dx = bx - ax;
  const dz = bz - az;
  const length = Math.sqrt(dx * dx + dz * dz);
  const steps = Math.max(1, Math.ceil(length / 0.5));
  let lastHeight = world.terrain ? heightAt(ax, az, world.terrain) : 0;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = ax + dx * t;
    const z = az + dz * t;
    // The last half metre is where the quarry stands; being next to a tree
    // does not make someone unreachable.
    if (i < steps && blockedAt(world, x, z, radius)) return false;
    if (world.terrain) {
      if (!footingOk(world, lastHeight, x, z, length / steps)) return false;
      lastHeight = heightAt(x, z, world.terrain);
    }
  }
  return true;
}

interface Node { i: number; j: number; g: number; f: number; parent: number }

/**
 * A walkable way from A to B for a body of `radius`, as waypoints (B last), or
 * undefined if there is none near enough to find.
 */
export function findPath(
  world: MoveWorld, ax: number, az: number, bx: number, bz: number, radius: number,
): Array<{ x: number; z: number }> | undefined {
  const minX = Math.min(ax, bx) - PADDING;
  const minZ = Math.min(az, bz) - PADDING;
  const cols = Math.ceil((Math.max(ax, bx) + PADDING - minX) / CELL) + 1;
  const rows = Math.ceil((Math.max(az, bz) + PADDING - minZ) / CELL) + 1;
  if (cols * rows > 40000) return undefined;

  const index = (i: number, j: number): number => j * cols + i;
  const centreX = (i: number): number => minX + i * CELL;
  const centreZ = (j: number): number => minZ + j * CELL;
  const startI = Math.round((ax - minX) / CELL);
  const startJ = Math.round((az - minZ) / CELL);
  const goalI = Math.round((bx - minX) / CELL);
  const goalJ = Math.round((bz - minZ) / CELL);
  const goal = index(goalI, goalJ);

  const terrain = world.terrain;
  const heights = new Float32Array(cols * rows).fill(NaN);
  const heightOf = (k: number, i: number, j: number): number => {
    let h = heights[k]!;
    if (Number.isNaN(h)) heights[k] = h = terrain ? heightAt(centreX(i), centreZ(j), terrain) : 0;
    return h;
  };
  // 0 unknown, 1 open, 2 blocked.
  const walk = new Uint8Array(cols * rows);
  const walkable = (k: number, i: number, j: number): boolean => {
    if (walk[k] === 0) walk[k] = blockedAt(world, centreX(i), centreZ(j), radius) ? 2 : 1;
    return walk[k] === 1;
  };

  const best = new Float32Array(cols * rows).fill(Infinity);
  const parents = new Int32Array(cols * rows).fill(-1);
  const closed = new Uint8Array(cols * rows);
  const open: Node[] = [];
  const h = (i: number, j: number): number => Math.hypot(i - goalI, j - goalJ) * CELL;
  const start = index(startI, startJ);
  best[start] = 0;
  push(open, { i: startI, j: startJ, g: 0, f: h(startI, startJ), parent: -1 });

  let expanded = 0;
  while (open.length > 0 && expanded < MAX_EXPANDED) {
    const node = pop(open);
    const k = index(node.i, node.j);
    if (closed[k]) continue;
    closed[k] = 1;
    expanded++;
    if (k === goal) return smooth(world, ax, az, bx, bz, radius, route(parents, goal, cols, centreX, centreZ));

    const here = heightOf(k, node.i, node.j);
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue;
        const ni = node.i + di;
        const nj = node.j + dj;
        if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
        const nk = index(ni, nj);
        if (closed[nk]) continue;
        // The goal is where the quarry stands, whatever stands beside it.
        if (nk !== goal && !walkable(nk, ni, nj)) continue;
        // No cutting a corner between two blocked cells.
        if (di !== 0 && dj !== 0 && (!walkable(index(node.i + di, node.j), node.i + di, node.j) || !walkable(index(node.i, node.j + dj), node.i, node.j + dj))) continue;
        const step = di !== 0 && dj !== 0 ? Math.SQRT2 * CELL : CELL;
        if (terrain && heightOf(nk, ni, nj) - here > MAX_CLIMB_GRADE * step) continue;
        if (terrain?.sea && seaDepthAt(centreX(ni), centreZ(nj), terrain) > MAX_WADE_DEPTH) continue;
        const g = node.g + step;
        if (g >= best[nk]!) continue;
        best[nk] = g;
        parents[nk] = k;
        push(open, { i: ni, j: nj, g, f: g + h(ni, nj), parent: k });
      }
    }
  }
  return undefined;
}

function route(
  parents: Int32Array, goal: number, cols: number,
  centreX: (i: number) => number, centreZ: (j: number) => number,
): Array<{ x: number; z: number }> {
  const points: Array<{ x: number; z: number }> = [];
  for (let k = goal; k !== -1; k = parents[k]!) {
    points.push({ x: centreX(k % cols), z: centreZ(Math.floor(k / cols)) });
  }
  return points.reverse();
}

/** Drop every waypoint that can be walked past in a straight line. */
function smooth(
  world: MoveWorld, ax: number, az: number, bx: number, bz: number, radius: number,
  points: Array<{ x: number; z: number }>,
): Array<{ x: number; z: number }> {
  points[points.length - 1] = { x: bx, z: bz };
  const out: Array<{ x: number; z: number }> = [];
  let fromX = ax;
  let fromZ = az;
  let k = 0;
  while (k < points.length) {
    let far = k;
    for (let n = points.length - 1; n > k; n--) {
      if (clearLine(world, fromX, fromZ, points[n]!.x, points[n]!.z, radius)) {
        far = n;
        break;
      }
    }
    out.push(points[far]!);
    fromX = points[far]!.x;
    fromZ = points[far]!.z;
    k = far + 1;
  }
  return out;
}

// A binary heap on f.
function push(heap: Node[], node: Node): void {
  heap.push(node);
  let n = heap.length - 1;
  while (n > 0) {
    const up = (n - 1) >> 1;
    if (heap[up]!.f <= heap[n]!.f) break;
    [heap[up], heap[n]] = [heap[n]!, heap[up]!];
    n = up;
  }
}

function pop(heap: Node[]): Node {
  const top = heap[0]!;
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    let n = 0;
    for (;;) {
      const l = n * 2 + 1;
      const r = l + 1;
      let least = n;
      if (l < heap.length && heap[l]!.f < heap[least]!.f) least = l;
      if (r < heap.length && heap[r]!.f < heap[least]!.f) least = r;
      if (least === n) break;
      [heap[least], heap[n]] = [heap[n]!, heap[least]!];
      n = least;
    }
  }
  return top;
}
