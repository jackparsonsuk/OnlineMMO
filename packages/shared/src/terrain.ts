import { fbm, gradientNoise, ridged, ridgedMulti, smoothstep } from "./noise.js";

/**
 * The shape of the ground.
 *
 * Height has to be a pure function rather than a heightmap image, for the same
 * reason `applyInput` is shared: the server places you on the ground and the
 * client predicts where the ground will be, and if those two disagree by a
 * centimetre you get permanent vertical rubber-banding. A function both sides
 * call is identical by construction — there is no asset to load, no sampling
 * convention to get subtly wrong, and no image to fall out of sync with the
 * code.
 *
 * Built from `noise.ts`, which is bit-identical in every JS engine. That is
 * also why nothing below calls `Math.hypot` or a trig function: `Math.sqrt` is
 * exactly rounded by IEEE 754, and the others are not required to be.
 *
 * Layers, broadest first:
 *  - `continent`: rises and basins kilometres across, so a big Ostra reads as
 *    a country rather than a lawn;
 *  - `hills`: the rolling ground you actually walk over;
 *  - `mountains`: ridged ranges in patches, which give a huge map landmarks you
 *    can navigate by;
 *  - `rim`: a wall of peaks at the boundary, so the edge of the world is a
 *    place rather than an invisible fence.
 * Then `flats` blend all of it level under a settlement, `lakes` carve
 * shallow basins with a bank around them, and a `sea` tips one side of the
 * Ostra down under the water.
 *
 * `regions` reshape all of that per area: a moor lifted into an upland, a fen
 * pressed nearly flat, mesa country cut into terraces. A region is the nearest
 * of a set of centres, with the borders warped by noise so they meander, and
 * blended over a couple of hundred metres so no border is ever a line.
 */

/** An area blended flat, so a town does not sit on a hillside. */
export interface FlatZone {
  x: number;
  z: number;
  /** Fully flat inside this. */
  radius: number;
  /** Blends back to natural ground over this much further out. */
  falloff: number;
  /**
   * The height it flattens to. Omit to flatten at whatever the natural ground
   * is at the centre — on a big Ostra a hand-picked number would put the town
   * in a pit or on a plinth.
   */
  level?: number;
}

export interface NoiseLayer {
  /** Roughly the peak height this layer adds, in metres. */
  amplitude: number;
  /** Feature size in metres: the distance from one rise to the next. */
  wavelength: number;
}

export interface TerrainSettings {
  /** Picks the pattern, so two Ostras don't share a skyline. */
  seed: number;
  hills: NoiseLayer & { octaves: number };
  continent?: NoiseLayer;
  mountains?: NoiseLayer & {
    /** 0..1: how much of the Ostra is mountainous. */
    coverage: number;
  };
  rim?: {
    /** Half the Ostra's width — where the rim tops out. */
    halfExtent: number;
    /** How far in from the edge the rise begins. */
    width: number;
    height: number;
  };
  flats: FlatZone[];
  regions?: TerrainRegion[];
  /**
   * Ranges along the borders between regions, so each region is a country of
   * its own with walls round it — the way one zone of a big game ends at a
   * line of mountains and the next begins through a pass. Scaled per region
   * by `TerrainRegion.walls`; a border is the mean of its two sides, so a
   * gentle region is still walled off from a wild one, just less so.
   */
  borders?: {
    /** Height of a full range at the border itself. */
    height: number;
    /** How far either side of the border it rises from. */
    width: number;
  };
  /**
   * Valleys along the roads: mountains and border ranges fall away near each
   * line, so a road runs through low country with the heights either side of
   * it, and every place a road joins stays where a person can walk to it.
   */
  valleys?: {
    lines: ValleyLine[];
    /** Kept clear of mountains this far either side of a line... */
    floor: number;
    /** ...and they climb back to full height over this much further. */
    width: number;
  };
  lakes?: LakeDefinition[];
  sea?: SeaDefinition;
}

/** A straight stretch of valley, from (ax, az) to (bx, bz). */
export interface ValleyLine {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

/**
 * A sea along one edge of the Ostra.
 *
 * There is no drawn shoreline. From `from` outwards the land is tipped down,
 * slowly at first and then steeply, until by `from + width` it has fallen by
 * `fall` — and the coast is simply wherever that falling ground passes below
 * `level`. So the sea comes in up a valley and a hill stands out into it as a
 * headland, and the coast follows the country instead of a line someone
 * chose. `wander` moves where the tipping starts, so even a dead-flat plain
 * gets bays.
 *
 * `level` has to be below the ground all along where the tipping starts, or
 * a hollow there would be cut off by a straight edge of water. Check it with
 * the heights, not by eye.
 */
export interface SeaDefinition {
  name: string;
  /** Which edge of the Ostra it lies along. */
  side: "east" | "west" | "north" | "south";
  /** Distance from the centre where the land starts to fall towards it. */
  from: number;
  /** How far `from` wanders either way along the coast. */
  wander: number;
  /** Over how many metres the fall completes. */
  width: number;
  /** How far the land has fallen by then. */
  fall: number;
  /** Surface height. */
  level: number;
  /** The open seabed lies flat this far below the surface. */
  depth: number;
}

/** How one region bends the ground. Everything defaults to "no change". */
export interface TerrainRegion {
  id: string;
  /** Centre. The region is everything nearer this than any other centre. */
  x: number;
  z: number;
  /** Metres added across the region: a moor sits above the lowland. */
  lift?: number;
  /** Scales the hills: below 1 flattens (a fen), above 1 roughens. */
  relief?: number;
  /** Scales how much of the region is mountainous. */
  mountains?: number;
  /** Height of terrace steps, for mesa country. */
  terrace?: number;
  /** Scales the ranges along this region's borders (see `borders`). */
  walls?: number;
}

/**
 * A shallow lake. Knee-to-waist deep everywhere, so it is waded rather than
 * swum — there is no swimming, and water you could drown in would need it.
 */
export interface LakeDefinition {
  x: number;
  z: number;
  /** Open water out to about here; the shoreline wanders ±15% by noise. */
  radius: number;
  /** Width of the bank that rises out of the water. */
  shore: number;
  /** Water depth over the flat bottom. */
  depth: number;
  /** Surface height. Omit to use the natural ground at the centre. */
  level?: number;
  /** What lives in it — a `WatersId` in `fishing.ts`. Omit for a pond. */
  waters?: string;
}

/** Where a point falls among the regions: the nearest, the runner-up, and how
 *  much of the nearest's character applies (0.5 on a border, 1 deep inside). */
export interface RegionSample {
  primary: number;
  secondary: number;
  weight: number;
}

/** Regions blend into each other over this many metres either side of a border. */
const REGION_BLEND = 220;
/**
 * How far borders wander from the straight bisector between two centres, in
 * two sizes. Terra's centres sit near a three-by-three grid, and with one
 * gentle warp its regions were nearly squares — invisible while the ground
 * was flat, and a patchwork of tiles once it was not.
 */
const REGION_WARP = 650;
const REGION_WARP_FINE = 160;

const regionScratch: RegionSample = { primary: 0, secondary: 0, weight: 1 };
/** Distance from the warped point to each region's centre, for the last call
 *  to `regionDistances`. */
const regionDistance: number[] = [];

/** Fill `regionDistance` for (x, z), and return the nearest region's index. */
function regionDistances(regions: readonly TerrainRegion[], seed: number, x: number, z: number): number {
  const wx = x + gradientNoise(x / 1500, z / 1500, seed + 501) * REGION_WARP
    + gradientNoise(x / 380, z / 380, seed + 503) * REGION_WARP_FINE;
  const wz = z + gradientNoise(x / 1500 + 17.3, z / 1500 - 9.1, seed + 502) * REGION_WARP
    + gradientNoise(x / 380 - 4.2, z / 380 + 6.6, seed + 504) * REGION_WARP_FINE;
  let best = Infinity;
  let nearest = 0;
  for (let i = 0; i < regions.length; i++) {
    const dx = wx - regions[i]!.x;
    const dz = wz - regions[i]!.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    regionDistance[i] = d;
    if (d < best) {
      best = d;
      nearest = i;
    }
  }
  return nearest;
}

/**
 * Which region a point is in, and its runner-up. Returns a shared scratch
 * object — copy what you need before calling again. For colouring and naming;
 * the shape of the ground uses `regionWeights`, which never jumps.
 */
export function regionAt(terrain: TerrainSettings, x: number, z: number): RegionSample {
  const regions = terrain.regions;
  const out = regionScratch;
  if (!regions || regions.length === 0) {
    out.primary = 0;
    out.secondary = 0;
    out.weight = 1;
    return out;
  }
  const a = regionDistances(regions, terrain.seed, x, z);
  let b = a === 0 ? 1 : 0;
  for (let i = 0; i < regions.length; i++) {
    if (i !== a && regionDistance[i]! < regionDistance[b]!) b = i;
  }
  out.primary = a;
  out.secondary = regions.length > 1 ? b : a;
  // Roughly how far past the border between the two nearest centres, in metres.
  const margin = regions.length > 1 ? (regionDistance[b]! - regionDistance[a]!) / 2 : Infinity;
  out.weight = 0.5 + 0.5 * smoothstep(margin / REGION_BLEND);
  return out;
}

/**
 * How much of every region's character applies at a point, summing to 1.
 *
 * Each region counts fully on its own ground and fades out over REGION_BLEND
 * beyond its border. Blending only the nearest two used to jump wherever
 * the runner-up changed hands near a three-way junction — a step in the
 * ground nobody noticed while hills were seven metres tall, and a line of
 * cliffs once a moor stood thirty metres above its neighbours.
 */
export function regionWeights(terrain: TerrainSettings, x: number, z: number, out: number[]): void {
  const regions = terrain.regions ?? [];
  if (regions.length === 0) return;
  const nearest = regionDistances(regions, terrain.seed, x, z);
  const best = regionDistance[nearest]!;
  let total = 0;
  for (let i = 0; i < regions.length; i++) {
    const w = 1 - smoothstep((regionDistance[i]! - best) / 2 / REGION_BLEND);
    out[i] = w;
    total += w;
  }
  for (let i = 0; i < regions.length; i++) out[i] = out[i]! / total;
}

const weightScratch: number[] = [];

/** Mountains are kept this far clear of any flat zone's outer edge, so a town
 *  never has a cliff for a back wall. */
const MOUNTAIN_CLEARANCE = 320;

const rangeDistances: number[] = [];

/**
 * The border ranges' height at a point, before their crest is roughened.
 *
 * Measured against the region centres through a warp of their own, wilder
 * than the one that decides colours and creatures: Terra's centres sit near a
 * three-by-three grid, and ranges following those borders exactly were a
 * grid of embankments. So a range wanders a few hundred metres either side of
 * the line where the country changes, which is also how real ones sit.
 *
 * The height is the greatest over every neighbouring region, not only the
 * nearest one: which region is "next nearest" flips from one to another near
 * a three-way junction, and taking only that one put a crack in the ground
 * along every flip.
 */
export function borderRange(t: TerrainSettings, x: number, z: number): number {
  const regions = t.regions;
  const b = t.borders;
  if (!regions || regions.length < 2 || !b) return 0;
  const s = t.seed;
  const wx = x + gradientNoise(x / 1700, z / 1700, s + 811) * 700 + gradientNoise(x / 420, z / 420, s + 813) * 150;
  const wz = z + gradientNoise(x / 1700 + 5.1, z / 1700 - 3.3, s + 812) * 700 + gradientNoise(x / 420 + 2.7, z / 420 + 8.9, s + 814) * 150;
  let best = Infinity;
  let primary = 0;
  for (let i = 0; i < regions.length; i++) {
    const dx = wx - regions[i]!.x;
    const dz = wz - regions[i]!.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    rangeDistances[i] = d;
    if (d < best) {
      best = d;
      primary = i;
    }
  }
  const own = regions[primary]!.walls ?? 1;
  let height = 0;
  for (let i = 0; i < regions.length; i++) {
    if (i === primary) continue;
    const margin = (rangeDistances[i]! - best) / 2;
    if (margin >= b.width) continue;
    const scale = (own + (regions[i]!.walls ?? 1)) / 2;
    const h = (1 - smoothstep(margin / b.width)) * scale;
    if (h > height) height = h;
  }
  return height * b.height;
}

/**
 * Mountain country at `wavelength`, roughly 0 to 1: a ridged multifractal
 * over a warped copy of the plane. The warp bends the crests, so they branch
 * and wander instead of looping round in the same few shapes.
 */
function massif(x: number, z: number, wavelength: number, seed: number): number {
  const u = x / wavelength;
  const v = z / wavelength;
  const qu = u + fbm(u * 0.6, v * 0.6, seed + 31, 2) * 0.6;
  const qv = v + fbm(u * 0.6 + 7.7, v * 0.6 - 3.1, seed + 32, 2) * 0.6;
  return ridgedMulti(qu, qv, seed, 5) * 1.6;
}

/** 0 within `floor` of any valley line, rising to 1 by `width` further out. */
function valleyClearance(valleys: NonNullable<TerrainSettings["valleys"]>, x: number, z: number): number {
  const reach = valleys.floor + valleys.width;
  let nearestSq = reach * reach;
  for (const line of valleys.lines) {
    // Cheap rejection first: most lines are nowhere near.
    if (x < (line.ax < line.bx ? line.ax : line.bx) - reach || x > (line.ax > line.bx ? line.ax : line.bx) + reach) continue;
    if (z < (line.az < line.bz ? line.az : line.bz) - reach || z > (line.az > line.bz ? line.az : line.bz) + reach) continue;
    const lx = line.bx - line.ax;
    const lz = line.bz - line.az;
    const lengthSq = lx * lx + lz * lz;
    let u = lengthSq > 0 ? ((x - line.ax) * lx + (z - line.az) * lz) / lengthSq : 0;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const dx = x - (line.ax + lx * u);
    const dz = z - (line.az + lz * u);
    const dSq = dx * dx + dz * dz;
    if (dSq < nearestSq) nearestSq = dSq;
  }
  return smoothstep((Math.sqrt(nearestSq) - valleys.floor) / valleys.width);
}

/** 0 on or next to a flat zone, rising to 1 once MOUNTAIN_CLEARANCE clear of
 *  every one: how much of anything steep is allowed here. */
function flatClearance(t: TerrainSettings, x: number, z: number): number {
  let clearance = 1;
  for (const flat of t.flats) {
    const dx = x - flat.x;
    const dz = z - flat.z;
    const clear = flat.radius + flat.falloff;
    const reach = clear + MOUNTAIN_CLEARANCE;
    const dSq = dx * dx + dz * dz;
    if (dSq >= reach * reach) continue;
    clearance *= smoothstep((Math.sqrt(dSq) - clear) / MOUNTAIN_CLEARANCE);
    if (clearance === 0) return 0;
  }
  return clearance;
}

/** Everything except the flats and lakes. */
function naturalHeight(x: number, z: number, t: TerrainSettings): number {
  const s = t.seed;

  let lift = 0;
  let relief = 1;
  let mountainScale = 1;
  let terrace = 0;
  let terraceStep = 0;
  if (t.regions && t.regions.length > 0) {
    regionWeights(t, x, z, weightScratch);
    relief = 0;
    mountainScale = 0;
    for (let i = 0; i < t.regions.length; i++) {
      const w = weightScratch[i]!;
      const region = t.regions[i]!;
      lift += (region.lift ?? 0) * w;
      relief += (region.relief ?? 1) * w;
      mountainScale += (region.mountains ?? 1) * w;
      if (region.terrace && w > 0) {
        terrace += w;
        terraceStep = region.terrace;
      }
    }
  }
  // How clear of every flat zone and every valley this is (see
  // `flatClearance`, `valleyClearance`), worked out at most once each, and
  // only if something steep asks.
  let clearance = -1;
  let valley = -1;

  let height = fbm(x / t.hills.wavelength, z / t.hills.wavelength, s, t.hills.octaves) * t.hills.amplitude * relief;

  if (t.continent) {
    const w = t.continent.wavelength;
    height += fbm(x / w, z / w, s + 101, 2) * t.continent.amplitude;
  }

  if (t.mountains) {
    const m = t.mountains;
    // A slow mask decides WHERE ranges are; the ridged layer decides their
    // shape. Without the mask, the whole map is uniformly craggy.
    const maskNoise = fbm(x / (m.wavelength * 3.1), z / (m.wavelength * 3.1), s + 211, 2) * 0.5 + 0.5;
    const coverage = Math.min(0.95, m.coverage * mountainScale);
    // Two-octave noise sits between about 0.3 and 0.7, so it is spread over
    // 0..1 first; tested raw against `coverage`, almost nothing passed and
    // nothing reached full height.
    const spread = smoothstep((maskNoise - 0.3) / 0.4);
    // Brought in over nearly half of that range, and squared, so a range
    // rises out of long foothills. Over a narrow band the whole massif stood
    // up at once, and every range had a rampart of cliff round its edge.
    let mask = coverage <= 0 ? 0 : smoothstep((spread - (1 - coverage)) / 0.45);
    if (mask > 0) mask *= clearance = flatClearance(t, x, z);
    if (mask > 0 && t.valleys) mask *= valley = valleyClearance(t.valleys, x, z);
    if (mask > 0) {
      height += massif(x, z, m.wavelength, s + 307) * m.amplitude * mask * mask;
    }
  }

  let wall = t.borders ? borderRange(t, x, z) : 0;
  if (wall > 0) {
    // Not one even embankment: peaks, spurs and notches along the crest, and
    // long stretches where the range sinks away to hills of its own accord —
    // so the borders do not read as a grid of walls.
    wall *= 0.25 + 1.1 * massif(x, z, 520, s + 803);
    wall *= smoothstep((fbm(x / 1500, z / 1500, s + 801, 2) + 0.3) / 0.6);
    // Where a road crosses, the range comes down to a pass.
    if (wall > 0 && t.valleys) wall *= valley >= 0 ? valley : (valley = valleyClearance(t.valleys, x, z));
    if (wall > 0) height += wall * (clearance >= 0 ? clearance : flatClearance(t, x, z));
  }

  if (t.rim) {
    const r = t.rim;
    let ax = x < 0 ? -x : x;
    let az = z < 0 ? -z : z;
    if (t.sea) {
      // No wall of peaks along the shore: that side's edge is the sea.
      const side = t.sea.side;
      if (side === "east" && x > 0) ax = 0;
      else if (side === "west" && x < 0) ax = 0;
      else if (side === "north" && z > 0) az = 0;
      else if (side === "south" && z < 0) az = 0;
    }
    const edge = ax > az ? ax : az;
    const into = (edge - (r.halfExtent - r.width)) / r.width;
    // The rims of the two sides beside the sea sink as they near it, so they
    // run out into the water as headlands rather than stopping in a cliff at
    // the edge of the world.
    const fade = into > 0 && t.sea ? 1 - seaRamp(t.sea, x, z, s) : 1;
    if (into > 0 && fade > 0) {
      // Jagged, not a ramp: a ridged layer scaled up as you approach the edge.
      const crag = 0.55 + 0.45 * ridged(x / 260, z / 260, s + 401, 3);
      height += smoothstep(into) * r.height * crag * fade;
    }
  }

  height += lift;

  // Mesa country: flat treads and steep risers, blended in by region weight —
  // and smoothed away along the roads, whose valleys would otherwise climb a
  // flight of nine-metre steps nobody can walk up.
  if (terrace > 0 && terraceStep > 0 && t.valleys) terrace *= valley >= 0 ? valley : valleyClearance(t.valleys, x, z);
  if (terrace > 0 && terraceStep > 0) {
    const f = height / terraceStep;
    const floor = Math.floor(f);
    const stepped = (floor + smoothstep((f - floor - 0.72) / 0.28)) * terraceStep;
    height += (stepped - height) * terrace;
  }

  return height;
}

/** Natural height at each auto-levelled flat's centre, computed once. */
const flatLevels = new WeakMap<FlatZone, number>();

function levelOf(flat: FlatZone, t: TerrainSettings): number {
  if (flat.level !== undefined) return flat.level;
  let level = flatLevels.get(flat);
  if (level === undefined) {
    level = naturalHeight(flat.x, flat.z, t);
    flatLevels.set(flat, level);
  }
  return level;
}

/** Surface height of each auto-levelled lake, computed once. */
const lakeLevels = new WeakMap<LakeDefinition, number>();

export function lakeLevel(lake: LakeDefinition, t: TerrainSettings): number {
  if (lake.level !== undefined) return lake.level;
  let level = lakeLevels.get(lake);
  if (level === undefined) {
    level = naturalHeight(lake.x, lake.z, t);
    lakeLevels.set(lake, level);
  }
  return level;
}

/** How far out from a lake's centre its water can reach. The client draws
 *  water within this; beyond it the bank is always above the surface. */
export function lakeReach(lake: LakeDefinition): number {
  return lake.radius * 1.15 + lake.shore;
}

export function heightAt(x: number, z: number, terrain: TerrainSettings): number {
  let height = naturalHeight(x, z, terrain);

  for (const flat of terrain.flats) {
    const dx = x - flat.x;
    const dz = z - flat.z;
    const outer = flat.radius + flat.falloff;
    const distanceSq = dx * dx + dz * dz;
    if (distanceSq >= outer * outer) continue;

    const distance = Math.sqrt(distanceSq);
    // 0 at the centre (fully flattened) rising to 1 at the outer edge.
    const t = distance <= flat.radius ? 0 : (distance - flat.radius) / flat.falloff;
    const natural = smoothstep(t);
    height = height * natural + levelOf(flat, terrain) * (1 - natural);
  }

  if (terrain.sea) {
    const sea = terrain.sea;
    const t = seaRamp(sea, x, z, terrain.seed);
    if (t > 0) {
      // Squared, so the land leaves its natural shape without a crease and
      // steepens towards the water.
      height -= t * t * sea.fall;
      const floor = sea.level - sea.depth;
      if (height < floor) height = floor;
    }
  }

  if (terrain.lakes) {
    for (const lake of terrain.lakes) {
      const dx = x - lake.x;
      const dz = z - lake.z;
      const outer = lake.radius * 1.15 + lake.shore * 2;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq >= outer * outer) continue;

      const distance = Math.sqrt(distanceSq);
      // A wandering shoreline, so no lake is a circle.
      const r = lake.radius * (1 + 0.15 * gradientNoise(x / 45, z / 45, terrain.seed + 601));
      const level = lakeLevel(lake, terrain);
      const bottom = level - lake.depth;
      // The bank always rises above the water, whatever the ground around
      // does. That is what keeps the water in, and what hides the edge of the
      // client's water mesh.
      const crest = height > level + 0.8 ? height : level + 0.8;
      if (distance <= r) {
        height = bottom;
      } else if (distance <= r + lake.shore) {
        height = bottom + (crest - bottom) * smoothstep((distance - r) / lake.shore);
      } else {
        height = crest + (height - crest) * smoothstep((distance - r - lake.shore) / lake.shore);
      }
    }
  }

  return height;
}

/** Ground less than this far above the sea is sand: nothing grows on it, and
 *  it is drawn as a beach. */
export const SAND_HEIGHT = 1.6;

/**
 * Water deeper than this is a wall (see `moveBody`). There is no swimming, and
 * a sea you could walk out into until it closed over your head would need it.
 * Waist-deep on a person — 1.3 m was nearly over their head — and still deeper
 * than any lake (0.9 at most), so only the sea ever stops anyone.
 */
export const MAX_WADE_DEPTH = 1;

/**
 * The steepest ground anyone walks up: a metre of rise to a metre across, 45°.
 * Anything steeper is a wall to the step (see `moveBody`), so a mountain is a
 * barrier to go round and a pass is a place that matters. Going down is never
 * refused. Roads are routed well under it (`roadProblems` checks they are).
 */
export const MAX_CLIMB_GRADE = 1;

/**
 * How far towards the sea's edge of the Ostra (x, z) is, from 0 where the land
 * starts to fall to 1 where it has finished. Zero for anywhere inland, which
 * is most of the map, and that is decided before any noise is sampled.
 */
export function seaRamp(sea: SeaDefinition, x: number, z: number, seed: number): number {
  const out = sea.side === "east" ? x : sea.side === "west" ? -x : sea.side === "north" ? z : -z;
  if (out <= sea.from - sea.wander) return 0;
  const along = sea.side === "east" || sea.side === "west" ? z : x;
  // A long swing of the whole coast, and broken ground in two dimensions on
  // top of it — so a bay can reach in behind a headland, and the odd hill out
  // in the shallows is left standing as an island.
  let wobble = gradientNoise(along / 1400, 0.37, seed + 701) * 0.55 + fbm(x / 380, z / 380, seed + 702, 2) * 0.45;
  // Noise only roughly keeps to [-1, 1], and the early return above counts on it.
  wobble = wobble < -1 ? -1 : wobble > 1 ? 1 : wobble;
  const t = (out - sea.from - sea.wander * wobble) / sea.width;
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

/** Depth of the sea at (x, z): positive in it, zero or less on land, and
 *  -Infinity anywhere the land has not started falling towards it. */
export function seaDepthAt(x: number, z: number, terrain: TerrainSettings): number {
  const sea = terrain.sea;
  if (!sea || seaRamp(sea, x, z, terrain.seed) <= 0) return -Infinity;
  return sea.level - heightAt(x, z, terrain);
}

/**
 * Depth of water standing at (x, z): positive in a lake or the sea, and on a
 * bank or a shore how far the ground stands above the water beside it, as a
 * negative number. -Infinity anywhere no water reaches.
 *
 * It used to answer 0 away from water, which reads as "right at the
 * waterline" — and the road router, asking "within 40 cm of water?", took
 * every field on Terra for a marsh and every lake bank for the one dry road in
 * the world.
 */
export function waterDepthAt(x: number, z: number, terrain: TerrainSettings): number {
  let depth = terrain.sea ? seaDepthAt(x, z, terrain) : -Infinity;
  for (const lake of terrain.lakes ?? []) {
    const dx = x - lake.x;
    const dz = z - lake.z;
    const reach = lakeReach(lake);
    if (dx * dx + dz * dz >= reach * reach) continue;
    const here = lakeLevel(lake, terrain) - heightAt(x, z, terrain);
    if (here > depth) depth = here;
    break;
  }
  return depth;
}

/**
 * The steepness at a point, as a 0..1 figure where 0 is level.
 *
 * Sampled rather than differentiated — the derivative of layered noise is easy
 * to write and easy to get wrong, and this only decides where grass grows.
 */
export function slopeAt(x: number, z: number, terrain: TerrainSettings): number {
  const step = 0.8;
  const here = heightAt(x, z, terrain);
  const dx = heightAt(x + step, z, terrain) - here;
  const dz = heightAt(x, z + step, terrain) - here;
  return Math.min(1, Math.sqrt(dx * dx + dz * dz) / step);
}

/** Roughly the tallest a normal stretch of ground gets, for colouring by
 *  height. Mountains and rim are excluded — they get their own tones. */
export function terrainRelief(terrain: TerrainSettings): number {
  return terrain.hills.amplitude + (terrain.continent?.amplitude ?? 0);
}
