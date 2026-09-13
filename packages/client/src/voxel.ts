import { Color3 } from "@babylonjs/core/Maths/math.js";
import type { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { hash2 } from "@mmo/shared";
import { flatMaterial } from "./lowpoly.js";

/**
 * Voxel models, and the mesher that turns them into something drawable.
 *
 * The old bodies were a handful of stretched boxes each — the wolf was
 * thirteen — which is not an art style so much as the absence of one. Voxels
 * keep everything that made that approach worth having and fix the part that
 * did not: a model is still *data in a source file*, so there is no exporter
 * in the pipeline, no asset to download and no loading screen, and a
 * creature's proportions still sit next to the numbers the simulation uses.
 * But where a box could only ever be a box, a grid can have a jaw, an ear, a
 * strap and a notch, and it can be shaded across its surface instead of being
 * one flat colour.
 *
 * Three things do the work of making this look deliberate rather than cheap,
 * and they have to go together:
 *
 *   Resolution. A leg is 6x12x6 cells rather than one box. See VOXEL.
 *   Ambient occlusion. Concave corners darkened by the neighbours that occlude
 *     them, baked into the vertex colours at mesh time. This is the signature
 *     voxel look and it costs nothing at runtime.
 *   Speckle. Three or four shades of one hue scattered over a surface, so fur
 *     and bark and stone have grain instead of reading as painted plastic.
 *
 * Nothing here is shared with the server and nothing here decides anything:
 * this is how the world is drawn, not what it is.
 */

/**
 * One voxel, in metres.
 *
 * 1/32 m is a little over three centimetres, which puts a 1.6 m player at 51
 * voxels tall. The number that matters is not the total but the smallest part:
 * at 1/16 m a leg is three cells wide and a head is five, and five cells
 * cannot hold a face — you would have spent the whole rewrite arriving back at
 * boxes. At 1/32 m a leg is 6x12x6 and a head 11x11x11, which is the classic
 * MagicaVoxel character resolution and has room for detail.
 *
 * Everything in the world is authored against this one number. Changing it
 * later means re-authoring every model, so it is the decision to get right
 * first. Greedy meshing means resolution is close to free for large simple
 * shapes — a trunk of one colour is a handful of quads however fine the grid —
 * so the cost of a finer voxel is authoring time, not frame time.
 */
export const VOXEL = 1 / 32;

export interface VoxelModel {
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  /** Palette index per cell, 1-based; 0 is empty. Indexed x + sx * (y + sy * z). */
  readonly cells: Uint8Array;
  /** Packed 0xrrggbb per entry. Cell value n is `palette[n - 1]`. */
  readonly palette: readonly number[];
}

/** Scale a packed colour's channels, for deriving the shades of one hue. */
export function tint(rgb: number, factor: number): number {
  const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v * factor)));
  return (clamp((rgb >> 16) & 255) << 16) | (clamp((rgb >> 8) & 255) << 8) | clamp(rgb & 255);
}

/**
 * The authoring surface. Models are written as code — filled boxes, ellipsoids
 * and single cells — because that is what the rest of the art in this game is,
 * and because a shape defined by its dimensions can be checked against the
 * collision circle it has to fit inside.
 */
export class Carve {
  readonly cells: Uint8Array;
  readonly palette: number[] = [];
  private readonly interned = new Map<number, number>();

  constructor(readonly sx: number, readonly sy: number, readonly sz: number) {
    this.cells = new Uint8Array(sx * sy * sz);
  }

  /** A palette slot for this colour, reusing one the model already has. */
  private index(rgb: number): number {
    let slot = this.interned.get(rgb);
    if (slot === undefined) {
      // 0 means empty, so 255 colours is the ceiling. No model comes close.
      if (this.palette.length >= 255) throw new Error("voxel model: over 255 colours");
      this.palette.push(rgb);
      slot = this.palette.length;
      this.interned.set(rgb, slot);
    }
    return slot;
  }

  private inside(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz;
  }

  at(x: number, y: number, z: number): number {
    if (!this.inside(x, y, z)) return 0;
    return this.cells[x + this.sx * (y + this.sy * z)]!;
  }

  set(x: number, y: number, z: number, rgb: number): this {
    if (this.inside(x, y, z)) this.cells[x + this.sx * (y + this.sy * z)] = this.index(rgb);
    return this;
  }

  /** A filled box, from a corner, in cells. The workhorse. */
  fill(x: number, y: number, z: number, w: number, h: number, d: number, rgb: number): this {
    const slot = this.index(rgb);
    for (let cz = z; cz < z + d; cz++) {
      for (let cy = y; cy < y + h; cy++) {
        for (let cx = x; cx < x + w; cx++) {
          if (this.inside(cx, cy, cz)) this.cells[cx + this.sx * (cy + this.sy * cz)] = slot;
        }
      }
    }
    return this;
  }

  /** Hollow out a box. Ears, eye sockets, the gap under a table. */
  clear(x: number, y: number, z: number, w: number, h: number, d: number): this {
    for (let cz = z; cz < z + d; cz++) {
      for (let cy = y; cy < y + h; cy++) {
        for (let cx = x; cx < x + w; cx++) {
          if (this.inside(cx, cy, cz)) this.cells[cx + this.sx * (cy + this.sy * cz)] = 0;
        }
      }
    }
    return this;
  }

  /**
   * A filled ellipsoid, centred on a point in cell space. Centres may be
   * halves, so a shape can sit between two cells and come out symmetric on an
   * even width.
   */
  ellipsoid(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, rgb: number): this {
    const slot = this.index(rgb);
    for (let z = Math.floor(cz - rz); z <= Math.ceil(cz + rz); z++) {
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
        for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
          if (!this.inside(x, y, z)) continue;
          const dx = (x + 0.5 - cx) / rx;
          const dy = (y + 0.5 - cy) / ry;
          const dz = (z + 0.5 - cz) / rz;
          if (dx * dx + dy * dy + dz * dz <= 1) this.cells[x + this.sx * (y + this.sy * z)] = slot;
        }
      }
    }
    return this;
  }

  /** An upright cylinder: posts, trunks, barrels, lamp stems. */
  cylinder(cx: number, cz: number, radius: number, y: number, h: number, rgb: number): this {
    const slot = this.index(rgb);
    for (let z = Math.floor(cz - radius); z <= Math.ceil(cz + radius); z++) {
      for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
        const dx = (x + 0.5 - cx) / radius;
        const dz = (z + 0.5 - cz) / radius;
        if (dx * dx + dz * dz > 1) continue;
        for (let cy = y; cy < y + h; cy++) {
          if (this.inside(x, cy, z)) this.cells[x + this.sx * (cy + this.sy * z)] = slot;
        }
      }
    }
    return this;
  }

  /** The same lying along z — a felled log, a fence rail, a rung. */
  cylinderZ(cx: number, cy: number, radius: number, z: number, len: number, rgb: number): this {
    const slot = this.index(rgb);
    for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
      for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
        const dx = (x + 0.5 - cx) / radius;
        const dy = (y + 0.5 - cy) / radius;
        if (dx * dx + dy * dy > 1) continue;
        for (let cz = z; cz < z + len; cz++) {
          if (this.inside(x, y, cz)) this.cells[x + this.sx * (y + this.sy * cz)] = slot;
        }
      }
    }
    return this;
  }

  /**
   * Scatter shades of a colour over the cells that already have it.
   *
   * This is what stops a surface reading as one flat plastic face, and it is
   * the cheapest of the three techniques by a distance: no extra geometry, no
   * extra draw call, just different palette indices. Which cell gets which
   * shade comes from a hash of its position, so a model looks the same every
   * time it is built.
   */
  speckle(rgb: number, seed: number, shades: readonly number[], chance = 0.5): this {
    const base = this.interned.get(rgb);
    if (base === undefined || shades.length === 0) return this;
    const slots = shades.map((shade) => this.index(shade));
    for (let z = 0; z < this.sz; z++) {
      for (let y = 0; y < this.sy; y++) {
        for (let x = 0; x < this.sx; x++) {
          const i = x + this.sx * (y + this.sy * z);
          if (this.cells[i] !== base) continue;
          // Two axes into hash2 with the third folded into both, which is
          // plenty of scatter for a grid this small.
          const h = hash2(x + z * 8191, y + z * 131, seed);
          if ((h & 1023) / 1024 >= chance) continue;
          this.cells[i] = slots[(h >>> 10) % slots.length]!;
        }
      }
    }
    return this;
  }

  /**
   * Knock the twelve edges off a box region.
   *
   * A filled box is still a box however finely it is voxelled, and a body made
   * of them reads as crates however good the shading is. Taking one cell off
   * every edge is the cheapest thing that turns a block into a form — the
   * occlusion then does the rest, because the new faces are all concave.
   */
  bevel(x: number, y: number, z: number, w: number, h: number, d: number): this {
    for (const dx of [0, w - 1]) {
      for (const dy of [0, h - 1]) this.clear(x + dx, y + dy, z, 1, 1, d);
      for (const dz of [0, d - 1]) this.clear(x + dx, y, z + dz, 1, h, 1);
    }
    for (const dy of [0, h - 1]) {
      for (const dz of [0, d - 1]) this.clear(x, y + dy, z + dz, w, 1, 1);
    }
    return this;
  }

  /** Bevel the whole grid. What most parts want. */
  bevelAll(): this {
    return this.bevel(0, 0, 0, this.sx, this.sy, this.sz);
  }

  /** Mirror the low half of x onto the high half. Most bodies are symmetric,
   *  and authoring one side halves both the work and the mistakes. */
  mirrorX(): this {
    for (let z = 0; z < this.sz; z++) {
      for (let y = 0; y < this.sy; y++) {
        for (let x = 0; x < Math.floor(this.sx / 2); x++) {
          this.cells[this.sx - 1 - x + this.sx * (y + this.sy * z)] =
            this.cells[x + this.sx * (y + this.sy * z)]!;
        }
      }
    }
    return this;
  }

  model(): VoxelModel {
    return { sx: this.sx, sy: this.sy, sz: this.sz, cells: this.cells, palette: this.palette };
  }
}

/** Author a model. `build(6, 12, 6, (v) => v.fill(...))`. */
export function build(sx: number, sy: number, sz: number, paint: (v: Carve) => void): VoxelModel {
  const carve = new Carve(sx, sy, sz);
  paint(carve);
  return carve.model();
}

/** One block of a sculpted part: a centre and a size, in metres, relative to
 *  the joint the part hangs from — the same numbers the old boxes used. */
export interface Piece {
  readonly at: readonly [number, number, number];
  readonly size: readonly [number, number, number];
  readonly colour: number;
  /** An ellipsoid inscribed in the box rather than the box itself. */
  readonly round?: boolean;
}

export interface Sculpted {
  readonly model: VoxelModel;
  readonly anchor: Anchor;
}

/**
 * Build a body part from blocks measured in metres about its joint.
 *
 * A wolf's torso used to be three boxes hung off one pivot. As one voxel model
 * it is one mesh, and the occlusion runs across the joins instead of stopping
 * at them — but only if the grid is big enough to hold all three and the
 * pivot lands back on the joint. Working that out by hand for every part of
 * every creature is where the mistakes would be, so it is worked out here:
 * give the same centres and sizes the boxes had, and get back a model and the
 * anchor that puts it where they were.
 *
 * `detail` runs afterwards with the grid open and a metres-to-cells mapper,
 * for the eyes, notches and speckle that make it more than its blocks.
 */
export function sculpt(
  pieces: readonly Piece[],
  detail?: (v: Carve, cell: (x: number, y: number, z: number) => readonly [number, number, number]) => void,
): Sculpted {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const piece of pieces) {
    for (let d = 0; d < 3; d++) {
      lo[d] = Math.min(lo[d]!, piece.at[d]! - piece.size[d]! / 2);
      hi[d] = Math.max(hi[d]!, piece.at[d]! + piece.size[d]! / 2);
    }
  }

  const span = (d: number): number => Math.max(1, Math.round((hi[d]! - lo[d]!) / VOXEL));
  const carve = new Carve(span(0), span(1), span(2));
  // Metres about the joint to cells in this grid.
  const cell = (x: number, y: number, z: number): readonly [number, number, number] => [
    (x - lo[0]!) / VOXEL,
    (y - lo[1]!) / VOXEL,
    (z - lo[2]!) / VOXEL,
  ];

  for (const piece of pieces) {
    const [x, y, z] = cell(
      piece.at[0]! - piece.size[0]! / 2,
      piece.at[1]! - piece.size[1]! / 2,
      piece.at[2]! - piece.size[2]! / 2,
    );
    const w = piece.size[0]! / VOXEL;
    const h = piece.size[1]! / VOXEL;
    const d = piece.size[2]! / VOXEL;
    if (piece.round) {
      carve.ellipsoid(x + w / 2, y + h / 2, z + d / 2, w / 2, h / 2, d / 2, piece.colour);
    } else {
      carve.fill(Math.round(x), Math.round(y), Math.round(z), Math.round(w), Math.round(h), Math.round(d), piece.colour);
    }
  }

  detail?.(carve, cell);

  return {
    model: carve.model(),
    anchor: { x: -lo[0]! / VOXEL, y: -lo[1]! / VOXEL, z: -lo[2]! / VOXEL },
  };
}

/**
 * How much each ambient-occlusion level darkens a corner.
 *
 * 3 is open air, 0 is a corner boxed in on three sides. The range is wide on
 * purpose: this is doing the job the old flat facets did, and then some, and a
 * timid curve just makes a model look grubby rather than solid.
 */
const AO_SHADE = [0.46, 0.66, 0.84, 1];

/**
 * Where the model's local origin sits.
 *
 * "centre" drops a model in exactly where a box used to be, and "base" stands
 * it on the ground. A cell says *this* point in the grid is the origin, which
 * is what a body part wants: one model can hold what used to be four boxes —
 * a wolf's torso, its shoulders, its belly — and still hang off its joint in
 * the right place, without anyone working out where the union of four boxes
 * has its centre. Cells may be halves.
 */
export type Anchor = "centre" | "base" | { readonly x: number; readonly y: number; readonly z: number };

/**
 * Greedy meshing.
 *
 * One cube per voxel would be unaffordable — a player is some thousands of
 * cells — and most of those faces are either buried inside the model or part
 * of a large flat wall. So: throw away every face with a filled neighbour in
 * front of it, then merge what is left into the largest rectangles that share
 * a colour *and* the same four corner AO values. Requiring the AO to match
 * costs a few merges and saves the gradient artefacts you get from stretching
 * one corner's shading across a merged quad.
 *
 * The result for a limb is tens of quads rather than hundreds of cubes, and
 * every model in the game can share one material, because the colour travels
 * in the vertex data.
 */
const meshCache = new WeakMap<VoxelModel, Map<string, VertexData>>();

function meshOf(model: VoxelModel, anchor: Anchor, cellSize: number): VertexData {
  const { sx, sy, sz, cells, palette } = model;
  const dims = [sx, sy, sz];

  const solid = (x: number, y: number, z: number): number =>
    x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz ? 0 : cells[x + sx * (y + sy * z)]!;

  const positions: number[] = [];
  const normals: number[] = [];
  const colours: number[] = [];
  const indices: number[] = [];

  // Centred in x and z so a model drops in where a box used to sit; y depends
  // on whether the caller thinks of the thing as hanging off a joint or
  // standing on the ground. A cell anchor overrides all three.
  const offset = typeof anchor === "object"
    ? [-anchor.x, -anchor.y, -anchor.z]
    : [-sx / 2, anchor === "base" ? 0 : -sy / 2, -sz / 2];

  const cell = [0, 0, 0];
  const front = [0, 0, 0];
  const probe = [0, 0, 0];

  /** The classic three-neighbour corner test, in the layer in front of the face. */
  const cornerAo = (u: number, v: number, du: number, dv: number): number => {
    const occupied = (au: number, av: number): number => {
      probe[0] = front[0]!;
      probe[1] = front[1]!;
      probe[2] = front[2]!;
      probe[u] = probe[u]! + au;
      probe[v] = probe[v]! + av;
      return solid(probe[0]!, probe[1]!, probe[2]!) === 0 ? 0 : 1;
    };
    const side1 = occupied(du, 0);
    const side2 = occupied(0, dv);
    // Boxed in on both sides: whatever is behind the corner cannot matter.
    if (side1 === 1 && side2 === 1) return 0;
    return 3 - (side1 + side2 + occupied(du, dv));
  };

  for (let d = 0; d < 3; d++) {
    // u and v taken cyclically, so (u, v, d) is right-handed throughout and
    // the winding below can be decided once rather than per axis.
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;
    const du = dims[u]!;
    const dv = dims[v]!;
    const mask = new Int32Array(du * dv);
    const shade = new Uint8Array(du * dv * 4);

    const same = (a: number, b: number): boolean =>
      mask[a] === mask[b] &&
      shade[a * 4] === shade[b * 4] &&
      shade[a * 4 + 1] === shade[b * 4 + 1] &&
      shade[a * 4 + 2] === shade[b * 4 + 2] &&
      shade[a * 4 + 3] === shade[b * 4 + 3];

    for (const positive of [false, true]) {
      const step = positive ? 1 : -1;

      for (let s = 0; s < dims[d]!; s++) {
        mask.fill(0);

        for (let j = 0; j < dv; j++) {
          for (let i = 0; i < du; i++) {
            cell[d] = s;
            cell[u] = i;
            cell[v] = j;
            const here = solid(cell[0]!, cell[1]!, cell[2]!);
            if (here === 0) continue;
            front[0] = cell[0]!;
            front[1] = cell[1]!;
            front[2] = cell[2]!;
            front[d] = front[d]! + step;
            // Buried: the neighbour in front hides this face entirely.
            if (solid(front[0]!, front[1]!, front[2]!) !== 0) continue;
            const m = i + j * du;
            mask[m] = here;
            shade[m * 4] = cornerAo(u, v, -1, -1);
            shade[m * 4 + 1] = cornerAo(u, v, 1, -1);
            shade[m * 4 + 2] = cornerAo(u, v, 1, 1);
            shade[m * 4 + 3] = cornerAo(u, v, -1, 1);
          }
        }

        for (let j = 0; j < dv; j++) {
          for (let i = 0; i < du; ) {
            const m = i + j * du;
            const slot = mask[m]!;
            if (slot === 0) {
              i++;
              continue;
            }

            let w = 1;
            while (i + w < du && same(m, m + w)) w++;
            let h = 1;
            grow: while (j + h < dv) {
              for (let k = 0; k < w; k++) if (!same(m, i + k + (j + h) * du)) break grow;
              h++;
            }

            // The face plane: the far side of the cell going one way, the near
            // side going the other.
            const base = [0, 0, 0];
            base[d] = s + (positive ? 1 : 0);
            base[u] = i;
            base[v] = j;

            const first = positions.length / 3;
            const spans: readonly (readonly [number, number])[] = [[0, 0], [w, 0], [w, h], [0, h]];
            const rgb = palette[slot - 1]!;
            const r = ((rgb >> 16) & 255) / 255;
            const g = ((rgb >> 8) & 255) / 255;
            const b = (rgb & 255) / 255;

            for (let c = 0; c < 4; c++) {
              const span = spans[c]!;
              const p = [base[0]!, base[1]!, base[2]!];
              p[u] = p[u]! + span[0];
              p[v] = p[v]! + span[1];
              positions.push(
                (p[0]! + offset[0]!) * cellSize,
                (p[1]! + offset[1]!) * cellSize,
                (p[2]! + offset[2]!) * cellSize,
              );
              normals.push(d === 0 ? step : 0, d === 1 ? step : 0, d === 2 ? step : 0);
              const lit = AO_SHADE[shade[m * 4 + c]!]!;
              colours.push(r * lit, g * lit, b * lit, 1);
            }

            // Split the quad along whichever diagonal keeps the two darkest
            // corners apart; the other way puts a visible crease across what
            // should have read as smooth shading.
            const flip = shade[m * 4]! + shade[m * 4 + 2]! > shade[m * 4 + 1]! + shade[m * 4 + 3]!;
            const quad = flip ? [1, 2, 3, 1, 3, 0] : [0, 1, 2, 0, 2, 3];
            for (let t = 0; t < 6; t += 3) {
              const q0 = first + quad[t]!;
              const q1 = first + quad[t + 1]!;
              const q2 = first + quad[t + 2]!;
              // (u, v, d) is right-handed, so the natural corner order already
              // faces along -d; the far side of the cell has to be reversed.
              if (positive) indices.push(q0, q2, q1);
              else indices.push(q0, q1, q2);
            }

            for (let cleared = 0; cleared < h; cleared++) {
              for (let a = 0; a < w; a++) mask[i + a + (j + cleared) * du] = 0;
            }
            i += w;
          }
        }
      }
    }
  }

  const data = new VertexData();
  data.positions = positions;
  data.normals = normals;
  data.colors = colours;
  data.indices = indices;
  return data;
}

/**
 * A material for voxel meshes. White diffuse, no specular: every colour in a
 * model arrives in the vertex data, so one of these can serve any number of
 * models — which is how a whole town ends up costing a handful of draw calls.
 *
 * Bodies that flash white when hit want one each, since the flash is a change
 * to the material and would otherwise light up every voxel in the world.
 */
export function voxelMaterial(scene: Scene, name: string): StandardMaterial {
  return flatMaterial(scene, name, Color3.White());
}

/**
 * Build the drawable mesh for a model. The caller owns its transform.
 *
 * `cell` is how big one voxel is in metres, and it is VOXEL for everything you
 * stand next to. Scenery is the exception: a pine is ten metres tall, which at
 * 1/32 m is thirteen million cells before a face is drawn — and pointlessly,
 * because you look at a tree from twenty metres and a face from three. A voxel
 * four times larger on something seen four times further away subtends the
 * same angle on screen, so the grain matches even though the grid does not.
 */
export function voxelMesh(
  scene: Scene,
  name: string,
  model: VoxelModel,
  anchor: Anchor = "centre",
  cell: number = VOXEL,
): Mesh {
  const mesh = new Mesh(name, scene);
  // Meshed once per model, anchor and grain, however many times it is placed.
  // A town is the same few wall panels, barrels and fence runs over and over,
  // and re-meshing each copy cost seven of the nine seconds it took to arrive
  // in Terra. `applyToMesh` copies the arrays into the mesh's own buffers, so
  // the shared data is never written to.
  const key = `${typeof anchor === "object" ? `${anchor.x},${anchor.y},${anchor.z}` : anchor}:${cell}`;
  let meshes = meshCache.get(model);
  if (!meshes) meshCache.set(model, (meshes = new Map()));
  let data = meshes.get(key);
  if (!data) meshes.set(key, (data = meshOf(model, anchor, cell)));
  data.applyToMesh(mesh, false);
  mesh.useVertexColors = true;
  return mesh;
}
