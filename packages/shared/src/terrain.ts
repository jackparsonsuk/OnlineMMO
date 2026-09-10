import { fbm, ridged, smoothstep } from "./noise.js";

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
 * Then `flats` blend all of it level under a settlement.
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
}

/** Mountains are kept this far clear of any flat zone's outer edge, so a town
 *  never has a cliff for a back wall. */
const MOUNTAIN_CLEARANCE = 320;

/** Everything except the flats. */
function naturalHeight(x: number, z: number, t: TerrainSettings): number {
  const s = t.seed;
  let height = fbm(x / t.hills.wavelength, z / t.hills.wavelength, s, t.hills.octaves) * t.hills.amplitude;

  if (t.continent) {
    const w = t.continent.wavelength;
    height += fbm(x / w, z / w, s + 101, 2) * t.continent.amplitude;
  }

  if (t.mountains) {
    const m = t.mountains;
    // A slow mask decides WHERE ranges are; the ridged layer decides their
    // shape. Without the mask, the whole map is uniformly craggy.
    const maskNoise = fbm(x / (m.wavelength * 3.1), z / (m.wavelength * 3.1), s + 211, 2) * 0.5 + 0.5;
    let mask = smoothstep((maskNoise - (1 - m.coverage)) / 0.18);
    if (mask > 0) {
      for (const flat of t.flats) {
        const dx = x - flat.x;
        const dz = z - flat.z;
        const clear = flat.radius + flat.falloff;
        const d = Math.sqrt(dx * dx + dz * dz) - clear;
        if (d < MOUNTAIN_CLEARANCE) mask *= smoothstep(d / MOUNTAIN_CLEARANCE);
      }
      if (mask > 0) {
        height += ridged(x / m.wavelength, z / m.wavelength, s + 307, 4) * m.amplitude * mask;
      }
    }
  }

  if (t.rim) {
    const r = t.rim;
    const ax = x < 0 ? -x : x;
    const az = z < 0 ? -z : z;
    const edge = ax > az ? ax : az;
    const into = (edge - (r.halfExtent - r.width)) / r.width;
    if (into > 0) {
      // Jagged, not a ramp: a ridged layer scaled up as you approach the edge.
      const crag = 0.55 + 0.45 * ridged(x / 260, z / 260, s + 401, 3);
      height += smoothstep(into) * r.height * crag;
    }
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

  return height;
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
