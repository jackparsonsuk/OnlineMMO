import { getOstra, isOstraId } from "@mmo/shared";
import { gridData, groundPalette, type GroundPalette } from "./groundData.js";

/**
 * Works out the ground's chunks off the main thread (see `TerrainStreamer`).
 *
 * The same `gridData` the main thread would run, from the same pure shared
 * functions, so a chunk from here is the chunk it would have built itself —
 * the height the simulation walks on, to the bit. Its arrays go back
 * transferred rather than copied.
 */

interface ChunkJob { id: number; ostra: string; x0: number; z0: number; x1: number; z1: number; step: number; skirt: boolean }

const palettes = new Map<string, GroundPalette>();

// Typed by hand rather than pulling the WebWorker lib into a DOM project.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ChunkJob>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
};

scope.onmessage = (event) => {
  const job = event.data;
  if (!isOstraId(job.ostra)) return;
  const ostra = getOstra(job.ostra);
  let palette = palettes.get(ostra.id);
  if (!palette) palettes.set(ostra.id, (palette = groundPalette(ostra)));
  const data = gridData(ostra, palette, job.x0, job.z0, job.x1, job.z1, job.step, job.skirt);
  scope.postMessage({ id: job.id, data }, [data.positions.buffer, data.normals.buffer, data.colours.buffer, data.uvs.buffer]);
};
