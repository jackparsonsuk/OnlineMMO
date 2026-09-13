import { fbm, gradientNoise, ridged, smoothstep } from "./noise.js";

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
  lakes?: LakeDefinition[];
  sea?: SeaDefinition;
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
/** How far borders wander from the straight bisector between two centres. */
const REGION_WARP = 420;

const regionScratch: RegionSample = { primary: 0, secondary: 0, weight: 1 };

/**
 * Which region a point is in. Returns a shared scratch object — copy what you
 * need before calling again.
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
  const s = terrain.seed;
  // One octave each: borders only need to wander, and this runs for every
  // height sample.
  const wx = x + gradientNoise(x / 1100, z / 1100, s + 501) * REGION_WARP;
  const wz = z + gradientNoise(x / 1100 + 17.3, z / 1100 - 9.1, s + 502) * REGION_WARP;
  let best = Infinity;
  let second = Infinity;
  let a = 0;
  let b = 0;
  for (let i = 0; i < regions.length; i++) {
    const dx = wx - regions[i]!.x;
    const dz = wz - regions[i]!.z;
    const d = dx * dx + dz * dz;
    if (d < best) {
      second = best;
      b = a;
      best = d;
      a = i;
    } else if (d < second) {
      second = d;
      b = i;
    }
  }
  out.primary = a;
  out.secondary = b;
  // Roughly how far past the border between the two nearest centres, in metres.
  const margin = (Math.sqrt(second) - Math.sqrt(best)) / 2;
  out.weight = 0.5 + 0.5 * smoothstep(margin / REGION_BLEND);
  return out;
}

/** Mountains are kept this far clear of any flat zone's outer edge, so a town
 *  never has a cliff for a back wall. */
const MOUNTAIN_CLEARANCE = 320;

/** Everything except the flats and lakes. */
function naturalHeight(x: number, z: number, t: TerrainSettings): number {
  const s = t.seed;

  let lift = 0;
  let relief = 1;
  let mountainScale = 1;
  let terrace = 0;
  let terraceStep = 0;
  if (t.regions && t.regions.length > 0) {
    const r = regionAt(t, x, z);
    const w = r.weight;
    const A = t.regions[r.primary]!;
    const B = t.regions[r.secondary]!;
    lift = (A.lift ?? 0) * w + (B.lift ?? 0) * (1 - w);
    relief = (A.relief ?? 1) * w + (B.relief ?? 1) * (1 - w);
    mountainScale = (A.mountains ?? 1) * w + (B.mountains ?? 1) * (1 - w);
    terrace = (A.terrace ? w : 0) + (B.terrace ? 1 - w : 0);
    terraceStep = A.terrace ?? B.terrace ?? 0;
  }

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
    let mask = coverage <= 0 ? 0 : smoothstep((maskNoise - (1 - coverage)) / 0.18);
    if (mask > 0) {
      for (const flat of t.flats) {
        const dx = x - flat.x;
        const dz = z - flat.z;
        const clear = flat.radius + flat.falloff;
        const reach = clear + MOUNTAIN_CLEARANCE;
        const dSq = dx * dx + dz * dz;
        if (dSq >= reach * reach) continue;
        mask *= smoothstep((Math.sqrt(dSq) - clear) / MOUNTAIN_CLEARANCE);
      }
      if (mask > 0) {
        height += ridged(x / m.wavelength, z / m.wavelength, s + 307, 4) * m.amplitude * mask;
      }
    }
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

  // Mesa country: flat treads and steep risers, blended in by region weight.
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
