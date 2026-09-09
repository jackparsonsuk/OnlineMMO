import { Color3, Color4 } from "@babylonjs/core/Maths/math.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { heightAt, type OstraDefinition } from "@mmo/shared";

/**
 * Building the ground you can see from the ground the simulation uses.
 *
 * Both come from `heightAt`, so what is drawn and what you walk on are the
 * same surface by construction — there is no heightmap to sample differently
 * on each side, and no chance of standing visibly inside a hill.
 */

/** Metres per quad. Two is chunky enough to read as facets rather than as a
 *  failed attempt at smooth, and cheap enough to rebuild on every arrival. */
const QUAD_SIZE = 2;

/**
 * Colour by height and steepness, painted into the mesh's vertex colours.
 *
 * A texture would be the usual answer, but vertex colours suit a faceted mesh
 * better: each facet takes one flat tone, which is exactly the look, and it
 * needs no image to load.
 */
function groundTone(
  height: number,
  slope: number,
  amplitude: number,
  low: Color3,
  high: Color3,
  rock: Color3,
): Color3 {
  // Where the ground is steep, soil gives way to stone.
  const bare = Math.min(1, Math.max(0, (slope - 0.35) / 0.45));
  const lift = amplitude > 0
    ? Math.min(1, Math.max(0, height / amplitude * 0.5 + 0.5))
    : 0.5;

  const grass = Color3.Lerp(low, high, lift);
  return Color3.Lerp(grass, rock, bare);
}

/**
 * The visible ground for an Ostra.
 *
 * Returns a flat-shaded mesh whose vertices sit exactly on `heightAt`. Rebuilt
 * whenever you arrive somewhere new, which is rare enough that the cost never
 * shows.
 */
export function buildTerrain(scene: Scene, ostra: OstraDefinition): Mesh {
  const size = ostra.size;
  const subdivisions = Math.max(8, Math.round(size / QUAD_SIZE));

  const ground = MeshBuilder.CreateGround(
    "terrain",
    { width: size, height: size, subdivisions, updatable: true },
    scene,
  );

  const positions = ground.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) return ground;

  const palette = ostra.palette;
  const low = Color3.FromHexString(palette.ground);
  // Crests catch the light: the grid colour is the Ostra's brighter tone.
  const high = Color3.Lerp(low, Color3.FromHexString(palette.grid), 0.55);
  const rock = Color3.FromHexString(palette.edge);

  const colours: number[] = [];
  const step = 0.9;

  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!;
    const z = positions[i + 2]!;
    const height = heightAt(x, z, ostra.terrain);
    positions[i + 1] = height;

    // Sampled here rather than reusing slopeAt, because the two neighbours are
    // needed anyway and this avoids three more height evaluations per vertex.
    const dx = heightAt(x + step, z, ostra.terrain) - height;
    const dz = heightAt(x, z + step, ostra.terrain) - height;
    const slope = Math.min(1, Math.hypot(dx, dz) / step);

    const tone = groundTone(height, slope, ostra.terrain.amplitude, low, high, rock);
    colours.push(tone.r, tone.g, tone.b, 1);
  }

  ground.updateVerticesData(VertexBuffer.PositionKind, positions);
  ground.setVerticesData(VertexBuffer.ColorKind, colours);

  // Normals must be recomputed or every facet is still lit as if flat.
  const indices = ground.getIndices();
  const normals: number[] = [];
  if (indices) {
    VertexData.ComputeNormals(positions, indices, normals);
    ground.setVerticesData(VertexBuffer.NormalKind, normals);
  }

  // The whole point: one normal per face, so the hills read as cut planes.
  if (typeof ground.convertToFlatShadedMesh === "function") {
    ground.convertToFlatShadedMesh();
  }

  const material = new StandardMaterial("terrainMaterial", scene);
  material.diffuseColor = Color3.White();
  material.specularColor = Color3.Black();
  ground.material = material;
  // Hills should hide the camera the same way a wall does.
  ground.metadata = { blocksCamera: true };
  // A mesh property, not a material one. Without it the colours written above
  // are ignored and the ground renders flat white.
  ground.useVertexColors = true;
  ground.receiveShadows = false;

  return ground;
}

/** A colour with its alpha, for callers that want the Ostra's ground tone. */
export function groundColour4(ostra: OstraDefinition): Color4 {
  const base = Color3.FromHexString(ostra.palette.ground);
  return new Color4(base.r, base.g, base.b, 1);
}
