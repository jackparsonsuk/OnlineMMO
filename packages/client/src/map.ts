import {
  getOstra,
  heightAt,
  roadPath,
  settlementsIn,
  type OstraDefinition,
} from "@mmo/shared";
import { groundPalette, groundTone, type GroundPalette } from "./terrain.js";
import { Color3 } from "@babylonjs/core/Maths/math.js";

/**
 * Finding your way.
 *
 * At eighty metres across, Terra needed no map: you could see all of it. At
 * eight kilometres you can't, and a big world you can't navigate is just a
 * long walk in fog. Three instruments, all drawn from the same `groundTone`
 * the 3D terrain uses, so the map looks like the place:
 *
 *  - a minimap, north up, with creatures, players and your heading;
 *  - a compass strip with bearings to landmarks;
 *  - a world map on M, which paints itself in tiles in the background so it
 *    is ready by the time anyone asks for it.
 *
 * North is +Z and east is +X, which puts Daso — "Terra's west" in the lore —
 * on the left of the map, where a reader would look for it.
 */

export interface MapBlip {
  x: number;
  z: number;
  colour: string;
  /** Radius in CSS pixels. */
  size: number;
  ring?: boolean;
}

interface Landmark {
  name: string;
  x: number;
  z: number;
  kind: "waystone" | "settlement" | "gate";
  colour: string;
}

/** Pixels per tile edge. Tiles are painted one at a time between frames. */
const TILE = 16;

/** A painted cache of the ground at one scale. */
class TileCache {
  private readonly tiles = new Map<string, HTMLCanvasElement>();
  private readonly queue: Array<{ key: string; tx: number; tz: number }> = [];
  private readonly queued = new Set<string>();

  constructor(
    private readonly ostra: OstraDefinition,
    private readonly palette: GroundPalette,
    /** Metres per pixel. */
    readonly mpp: number,
    private readonly limit: number,
  ) {}

  get tileMetres(): number {
    return TILE * this.mpp;
  }

  /** The tile, if painted; otherwise ask for it and return undefined. */
  get(tx: number, tz: number): HTMLCanvasElement | undefined {
    const key = `${tx},${tz}`;
    const tile = this.tiles.get(key);
    if (tile) return tile;
    if (!this.queued.has(key)) {
      this.queued.add(key);
      this.queue.push({ key, tx, tz });
    }
    return undefined;
  }

  /** Paint up to `budgetMs` worth of queued tiles, newest requests first. */
  work(budgetMs: number): void {
    const until = performance.now() + budgetMs;
    while (this.queue.length > 0 && performance.now() < until) {
      const next = this.queue.pop()!;
      this.queued.delete(next.key);
      this.tiles.set(next.key, this.paint(next.tx, next.tz));
      if (this.tiles.size > this.limit) {
        // Oldest first; Map iteration is insertion order.
        const oldest = this.tiles.keys().next().value;
        if (oldest !== undefined) this.tiles.delete(oldest);
      }
    }
  }

  private paint(tx: number, tz: number): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = TILE;
    canvas.height = TILE;
    const ctx = canvas.getContext("2d")!;
    const image = ctx.createImageData(TILE, TILE);
    const m = this.mpp;
    const half = this.ostra.size / 2;
    const tone = new Color3();
    // Light from the north-west, the cartographer's convention.
    const lx = -0.5, ly = 0.7, lz = 0.5;

    for (let py = 0; py < TILE; py++) {
      for (let px = 0; px < TILE; px++) {
        const x = (tx * TILE + px + 0.5) * m;
        // Tile rows run south as pixel y grows.
        const z = -(tz * TILE + py + 0.5) * m;
        const k = (py * TILE + px) * 4;
        if (Math.abs(x) > half || Math.abs(z) > half) {
          image.data[k] = 18; image.data[k + 1] = 22; image.data[k + 2] = 28; image.data[k + 3] = 255;
          continue;
        }
        const t = this.ostra.terrain;
        const h = heightAt(x, z, t);
        const dx = (heightAt(x + m, z, t) - h) / m;
        const dz = (heightAt(x, z + m, t) - h) / m;
        groundTone(this.ostra, this.palette, x, z, h, Math.min(1, Math.sqrt(dx * dx + dz * dz)), tone);
        const nl = Math.sqrt(dx * dx + 1 + dz * dz);
        const light = ((-dx) * lx + ly + (-dz) * lz) / nl;
        const shade = Math.max(0.45, Math.min(1.35, 0.35 + light * 0.9));
        image.data[k] = Math.min(255, tone.r * shade * 255);
        image.data[k + 1] = Math.min(255, tone.g * shade * 255);
        image.data[k + 2] = Math.min(255, tone.b * shade * 255);
        image.data[k + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    return canvas;
  }
}

const COMPASS_POINTS: Array<[number, string]> = [
  [0, "N"], [45, "NE"], [90, "E"], [135, "SE"], [180, "S"], [225, "SW"], [270, "W"], [315, "NW"],
];

export class Cartographer {
  private readonly ostra: OstraDefinition;
  private readonly local: TileCache;
  private readonly world: TileCache;
  private readonly landmarks: Landmark[] = [];
  private readonly miniCanvas = document.getElementById("minimap-canvas") as HTMLCanvasElement;
  private readonly miniInfo = document.getElementById("minimap-info") as HTMLElement;
  private readonly compass = document.getElementById("compass-strip") as HTMLElement;
  private readonly worldPanel = document.getElementById("worldmap") as HTMLElement;
  private readonly worldCanvas = document.getElementById("worldmap-canvas") as HTMLCanvasElement;
  private readonly worldTitle = document.getElementById("worldmap-title") as HTMLElement;
  private lastInfo = "";
  private compassMarks: HTMLElement[] = [];

  constructor(ostra: OstraDefinition) {
    this.ostra = ostra;
    const palette = groundPalette(ostra);
    this.local = new TileCache(ostra, palette, Math.min(3, ostra.size / 180), 900);
    this.world = new TileCache(ostra, palette, Math.max(0.12, ostra.size / 520), 4096);

    const settlements = settlementsIn(ostra);
    for (const stone of ostra.waystones) {
      // A town's own waystone is the town, as far as a map is concerned —
      // drawing both put Daso on the map twice.
      const inTown = settlements.some((s) => Math.hypot(s.x - stone.x, s.z - stone.z) < s.radius + 60);
      if (inTown) continue;
      this.landmarks.push({ name: stone.name, x: stone.x, z: stone.z, kind: "waystone", colour: "#9fd8ff" });
    }
    for (const settlement of settlements) {
      this.landmarks.push({ name: settlement.name, x: settlement.x, z: settlement.z, kind: "settlement", colour: "#ffc46b" });
    }
    for (const gate of ostra.gates) {
      this.landmarks.push({
        name: gate.label.replace(/^Gate to (the )?/, ""),
        x: gate.x, z: gate.z, kind: "gate",
        colour: getOstra(gate.target).palette.grid,
      });
    }

    // Queue the whole world map now, so it paints itself in the background
    // and is finished before anyone opens it.
    const tiles = Math.ceil(ostra.size / 2 / this.world.tileMetres);
    for (let tz = -tiles; tz < tiles; tz++) {
      for (let tx = -tiles; tx < tiles; tx++) this.world.get(tx, tz);
    }

    this.buildCompass();
    this.worldTitle.textContent = `${ostra.name} — ${ostra.subtitle}`;
  }

  get worldOpen(): boolean {
    return !this.worldPanel.hidden;
  }

  toggleWorld(): void {
    this.worldPanel.hidden = !this.worldPanel.hidden;
  }

  private buildCompass(): void {
    this.compass.innerHTML = "";
    this.compassMarks = [];
    for (const [degrees, label] of COMPASS_POINTS) {
      const mark = document.createElement("span");
      mark.className = label.length === 1 ? "point major" : "point";
      mark.textContent = label;
      mark.dataset["bearing"] = String((degrees * Math.PI) / 180);
      this.compass.appendChild(mark);
      this.compassMarks.push(mark);
    }
    for (let degrees = 15; degrees < 360; degrees += 15) {
      if (degrees % 45 === 0) continue;
      const tick = document.createElement("span");
      tick.className = "tick";
      tick.dataset["bearing"] = String((degrees * Math.PI) / 180);
      this.compass.appendChild(tick);
      this.compassMarks.push(tick);
    }
    for (const landmark of this.landmarks) {
      const mark = document.createElement("span");
      mark.className = `landmark ${landmark.kind}`;
      mark.style.setProperty("--mark", landmark.colour);
      mark.title = landmark.name;
      mark.dataset["x"] = String(landmark.x);
      mark.dataset["z"] = String(landmark.z);
      this.compass.appendChild(mark);
      this.compassMarks.push(mark);
    }
  }

  /**
   * Redraw the instruments.
   *
   * @param heading Where the camera faces, as a yaw (0 = north, π/2 = east).
   */
  update(x: number, z: number, heading: number, blips: readonly MapBlip[], targetBearing: number | undefined): void {
    this.drawMinimap(x, z, heading, blips);
    this.drawCompass(x, z, heading, targetBearing);
    this.updateInfo(x, z);
    if (this.worldOpen) {
      this.drawWorld(x, z, heading, blips);
      this.world.work(10);
    } else {
      // Paint the world map in the background, a little per frame.
      this.world.work(1.5);
    }
    this.local.work(4);
  }

  private drawMinimap(x: number, z: number, heading: number, blips: readonly MapBlip[]): void {
    const canvas = this.miniCanvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const size = canvas.width;
    const cache = this.local;
    const mpp = cache.mpp;
    ctx.fillStyle = "#12161c";
    ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = true;

    // World coordinate of the canvas's top-left pixel.
    const left = x - (size / 2) * mpp;
    const top = z + (size / 2) * mpp;
    this.drawTiles(ctx, cache, left, top, size, size, 1);

    ctx.save();
    ctx.strokeStyle = "rgba(170, 140, 100, 0.9)";
    ctx.lineWidth = 1.6;
    for (const road of this.ostra.roads) {
      ctx.beginPath();
      roadPath(road).forEach((p, i) => {
        const px = (p.x - left) / mpp;
        const py = (top - p.z) / mpp;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.stroke();
    }
    ctx.restore();

    for (const landmark of this.landmarks) {
      const px = (landmark.x - left) / mpp;
      const py = (top - landmark.z) / mpp;
      if (px < -6 || py < -6 || px > size + 6 || py > size + 6) continue;
      drawLandmark(ctx, landmark, px, py, 1);
    }

    for (const blip of blips) {
      const px = (blip.x - left) / mpp;
      const py = (top - blip.z) / mpp;
      if (px < 0 || py < 0 || px > size || py > size) continue;
      ctx.beginPath();
      ctx.arc(px, py, blip.size, 0, Math.PI * 2);
      ctx.fillStyle = blip.colour;
      ctx.fill();
      if (blip.ring) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    drawArrow(ctx, size / 2, size / 2, heading, 7);
  }

  private drawTiles(
    ctx: CanvasRenderingContext2D,
    cache: TileCache,
    left: number,
    top: number,
    width: number,
    height: number,
    scale: number,
  ): void {
    const mpp = cache.mpp;
    const tileMetres = cache.tileMetres;
    const firstX = Math.floor(left / tileMetres);
    const lastX = Math.floor((left + (width / scale) * mpp) / tileMetres);
    const firstZ = Math.floor(-top / tileMetres);
    const lastZ = Math.floor((-top + (height / scale) * mpp) / tileMetres);
    for (let tz = firstZ; tz <= lastZ; tz++) {
      for (let tx = firstX; tx <= lastX; tx++) {
        const tile = cache.get(tx, tz);
        if (!tile) continue;
        const px = ((tx * tileMetres - left) / mpp) * scale;
        const py = ((top + tz * tileMetres) / mpp) * scale;
        // A hair of overlap hides seams from subpixel placement.
        ctx.drawImage(tile, px, py, TILE * scale + 0.6, TILE * scale + 0.6);
      }
    }
  }

  private drawWorld(x: number, z: number, heading: number, blips: readonly MapBlip[]): void {
    const canvas = this.worldCanvas;
    const rect = canvas.getBoundingClientRect();
    const size = Math.floor(Math.min(rect.width, rect.height));
    if (size <= 0) return;
    if (canvas.width !== size) {
      canvas.width = size;
      canvas.height = size;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const cache = this.world;
    const half = this.ostra.size / 2;
    // The whole Ostra, fitted.
    const scale = size / (this.ostra.size / cache.mpp);
    const mpp = cache.mpp / scale;
    const left = -half;
    const top = half;
    ctx.fillStyle = "#12161c";
    ctx.fillRect(0, 0, size, size);
    this.drawTiles(ctx, cache, left, top, size, size, scale);

    const toPx = (wx: number, wz: number): [number, number] => [(wx - left) / mpp, (top - wz) / mpp];

    ctx.strokeStyle = "rgba(190, 160, 110, 0.95)";
    ctx.lineWidth = 2;
    for (const road of this.ostra.roads) {
      ctx.beginPath();
      roadPath(road).forEach((p, i) => {
        const [px, py] = toPx(p.x, p.z);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.stroke();
    }

    ctx.font = "600 12px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    for (const landmark of this.landmarks) {
      const [px, py] = toPx(landmark.x, landmark.z);
      drawLandmark(ctx, landmark, px, py, 1.4);
      if (landmark.kind === "gate") continue;
      ctx.fillStyle = "rgba(0,0,0,0.65)";
      ctx.fillText(landmark.name, px + 1, py - 9);
      ctx.fillStyle = landmark.kind === "settlement" ? "#ffe2a8" : "#e6edf3";
      ctx.fillText(landmark.name, px, py - 10);
    }

    for (const blip of blips) {
      if (!blip.ring) continue;
      const [px, py] = toPx(blip.x, blip.z);
      ctx.beginPath();
      ctx.arc(px, py, 3, 0, Math.PI * 2);
      ctx.fillStyle = blip.colour;
      ctx.fill();
    }

    const [px, py] = toPx(x, z);
    drawArrow(ctx, px, py, heading, 9);
  }

  private drawCompass(x: number, z: number, heading: number, targetBearing: number | undefined): void {
    const width = this.compass.clientWidth;
    // ±100° of arc across the strip.
    const span = (100 * Math.PI) / 180;
    for (const mark of this.compassMarks) {
      let bearing: number;
      if (mark.dataset["bearing"] !== undefined) {
        bearing = Number(mark.dataset["bearing"]);
      } else {
        const mx = Number(mark.dataset["x"]) - x;
        const mz = Number(mark.dataset["z"]) - z;
        bearing = Math.atan2(mx, mz);
        const distance = Math.hypot(mx, mz);
        // Far landmarks are only clutter; the nearest few are what you steer by.
        mark.hidden = distance > 2400 || distance < 6;
        if (!mark.hidden) mark.dataset["distance"] = distance > 1000
          ? `${(distance / 1000).toFixed(1)} km` : `${Math.round(distance)} m`;
        if (mark.hidden) continue;
      }
      const delta = Math.atan2(Math.sin(bearing - heading), Math.cos(bearing - heading));
      if (Math.abs(delta) > span) {
        mark.style.visibility = "hidden";
        continue;
      }
      mark.style.visibility = "visible";
      mark.style.transform = `translateX(${((delta / span) * 0.5 + 0.5) * width}px) translateX(-50%)`;
    }
    const target = document.getElementById("compass-target") as HTMLElement | null;
    if (target) {
      if (targetBearing === undefined) {
        target.hidden = true;
      } else {
        const delta = Math.atan2(Math.sin(targetBearing - heading), Math.cos(targetBearing - heading));
        target.hidden = Math.abs(delta) > span;
        target.style.transform = `translateX(${((delta / span) * 0.5 + 0.5) * width}px) translateX(-50%)`;
      }
    }
  }

  /** "Near Westroad Stone · danger 3", updated only when it changes. */
  private updateInfo(x: number, z: number): void {
    let nearest: Landmark | undefined;
    let best = Infinity;
    for (const landmark of this.landmarks) {
      if (landmark.kind === "gate") continue;
      const d = Math.hypot(landmark.x - x, landmark.z - z);
      if (d < best) {
        best = d;
        nearest = landmark;
      }
    }
    let place = this.ostra.name;
    if (nearest && best < 90) place = nearest.name;
    else if (nearest && best < 900) place = `${compassWord(Math.atan2(x - nearest.x, z - nearest.z))} of ${nearest.name}`;
    else if (this.ostra.wilds) place = "The wilds";

    let danger = "";
    const wilds = this.ostra.wilds;
    if (wilds) {
      const level = 1 + Math.floor(Math.hypot(x - this.ostra.spawn.x, z - this.ostra.spawn.z) / wilds.metresPerLevel);
      danger = ` · danger ${Math.min(12, level)}`;
    }
    const info = `${place}${danger}`;
    if (info !== this.lastInfo) {
      this.lastInfo = info;
      this.miniInfo.textContent = info;
    }
  }
}

function compassWord(bearing: number): string {
  const index = Math.round(((bearing + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
  return ["North", "Northeast", "East", "Southeast", "South", "Southwest", "West", "Northwest"][index]!;
}

function drawArrow(ctx: CanvasRenderingContext2D, x: number, y: number, heading: number, size: number): void {
  ctx.save();
  ctx.translate(x, y);
  // Canvas rotates clockwise with y down; heading is clockwise from north.
  ctx.rotate(heading);
  ctx.beginPath();
  ctx.moveTo(0, -size);
  ctx.lineTo(size * 0.7, size * 0.8);
  ctx.lineTo(0, size * 0.35);
  ctx.lineTo(-size * 0.7, size * 0.8);
  ctx.closePath();
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#0d1117";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fill();
  ctx.restore();
}

function drawLandmark(ctx: CanvasRenderingContext2D, landmark: Landmark, x: number, y: number, scale: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = landmark.colour;
  ctx.strokeStyle = "#0d1117";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (landmark.kind === "waystone") {
    const s = 4 * scale;
    ctx.moveTo(0, -s); ctx.lineTo(s * 0.7, 0); ctx.lineTo(0, s); ctx.lineTo(-s * 0.7, 0);
    ctx.closePath();
  } else if (landmark.kind === "settlement") {
    const s = 4.5 * scale;
    ctx.rect(-s, -s * 0.4, s * 2, s * 1.4);
    ctx.moveTo(-s * 1.2, -s * 0.4); ctx.lineTo(0, -s * 1.4); ctx.lineTo(s * 1.2, -s * 0.4);
  } else {
    ctx.arc(0, 0, 3.5 * scale, 0, Math.PI * 2);
  }
  ctx.stroke();
  ctx.fill();
  ctx.restore();
}
