import {
  DIFFICULTY_COLOUR,
  difficultyOf,
  getOstra,
  heightAt,
  levelAt,
  regionOf,
  roadPaths,
  settlementsIn,
  waystoneKey,
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
 * A map of eight kilometres is only useful if it answers questions, so the
 * world map carries the three a player actually has: what is this symbol (a
 * legend), how far is that (a scale bar, and the view's width in the hint),
 * and can I survive there (every region's level band, coloured against your
 * own level the way a nameplate is). Labels are placed in priority order and
 * a label that would sit on top of one already drawn is dropped instead —
 * eight kilometres of names at once was a wall of text.
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
  /** A rare elite: also drawn on the world map. */
  elite?: boolean;
}

/**
 * Where a quest wants you, drawn on the maps and the compass: an area to hunt
 * in (a kill or collect whose creature lives in one place), a point to go to
 * (a visit, an elite), the person to hand it back to — or someone with work
 * to offer, which is how a new arrival finds their first quest.
 */
export interface QuestMark {
  kind: "area" | "point" | "turnin" | "offer";
  x: number;
  z: number;
  /** Metres, for an area. */
  radius?: number;
  /** The quest's title, for the world map. */
  label: string;
}

interface Landmark {
  name: string;
  x: number;
  z: number;
  /** A vendor is a coin where they stand: a town's shop should be findable
   *  without walking up to everyone in it. */
  kind: "waystone" | "settlement" | "gate" | "ruin" | "vendor";
  colour: string;
  /**
   * The waystone at this place, if there is one — its own id for a waystone,
   * and the town's stone for a settlement that has one. Towns draw one glyph
   * for the place rather than two on top of each other, so the town's glyph
   * is what has to say whether its stone is woken.
   */
  stone?: string;
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
        groundTone(this.ostra, this.palette, x, z, h, Math.min(1, Math.sqrt(dx * dx + dz * dz)), tone, true);
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

/** One line of a world-map label: what it says, in what colour, in what font. */
interface LabelLine {
  text: string;
  colour: string;
  font: string;
}

const REGION_FONT = "italic 600 15px ui-serif, Georgia, serif";
const BAND_FONT = "600 11px ui-sans-serif, system-ui, sans-serif";
const SEA_FONT = "italic 600 14px ui-serif, Georgia, serif";
const LANDMARK_FONT = "600 12px ui-sans-serif, system-ui, sans-serif";
const QUEST_FONT = "italic 600 12px ui-serif, Georgia, serif";
const AREA_FONT = "italic 11px ui-serif, Georgia, serif";
/** Enough for the tallest of the fonts above, plus a little air. */
const LABEL_LINE_HEIGHT = 14;

/**
 * Zoom at which the lesser names appear.
 *
 * Fourteen stones, two towns, eight ruins, the hunting grounds, nine regions
 * and whatever your quests want are far too many names for one screen of
 * eight kilometres. The places you steer by are always named; the rest wait
 * until you have zoomed in and asked about that corner specifically.
 */
const RUIN_LABEL_ZOOM = 1.6;
const AREA_LABEL_ZOOM = 2.2;
const VENDOR_ZOOM = 4;

/** Round distances a scale bar is allowed to be. */
const SCALE_STEPS = [25, 50, 100, 200, 500, 1000, 2000, 4000];

/** "700 m", "1.4 km" — the same rounding the compass uses. */
function distanceWord(metres: number): string {
  return metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres)} m`;
}

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
  private readonly worldHint = document.getElementById("worldmap-help") as HTMLElement;
  private readonly worldAcross = document.getElementById("worldmap-across") as HTMLElement;
  private readonly defaultHint: string;
  private shownAcross = "";
  /** Development: while set, a click on the world map is a place, not nothing. */
  private picker: ((x: number, z: number) => void) | undefined;
  private readonly onPickMove = (event: MouseEvent) => this.describePick(event);
  private readonly onPickClick = (event: MouseEvent) => this.pick(event);
  private readonly onWheel = (event: WheelEvent) => this.zoomAt(event);
  private readonly onDragStart = (event: MouseEvent) => this.startDrag(event);
  private readonly onDragMove = (event: MouseEvent) => this.moveDrag(event);
  private readonly onDragEnd = () => { this.drag = undefined; };
  /** The world map's view: how far in (1 = the whole Ostra), and the point at
   *  its centre. Kept between openings; recentred on you when zoomed in. */
  private zoom = 1;
  private centreX = 0;
  private centreZ = 0;
  private drag: { x: number; y: number; moved: boolean } | undefined;
  /** Set on a drag that moved, so the click that ends it is not a pick. */
  private dragged = false;
  private questMarks: QuestMark[] = [];
  private questCompass: HTMLElement[] = [];
  private lastX = 0;
  private lastZ = 0;
  /** Stones this character has woken, by id in this Ostra. */
  private attuned = new Set<string>();
  /** The player's level, for colouring every region's band against it. */
  private level = 1;
  /** Label boxes already drawn this frame, for the overlap test. */
  private placed: Array<{ x: number; y: number; w: number; h: number }> = [];

  constructor(ostra: OstraDefinition) {
    this.ostra = ostra;
    const palette = groundPalette(ostra);
    // Big enough for the world map zoomed right in, as well as the minimap.
    this.local = new TileCache(ostra, palette, Math.min(3, ostra.size / 180), 3000);
    this.world = new TileCache(ostra, palette, Math.max(0.12, ostra.size / 520), 4096);

    const settlements = settlementsIn(ostra);
    /** Which town each stone stands in, if any. A town's own waystone is the
     *  town, as far as a map is concerned — drawing both put Daso on the map
     *  twice — so the town's glyph inherits the stone. */
    const townStone = new Map<string, string>();
    for (const stone of ostra.waystones) {
      const town = settlements.find((s) => Math.hypot(s.x - stone.x, s.z - stone.z) < s.radius + 60);
      if (town) {
        townStone.set(town.id, stone.id);
        continue;
      }
      this.landmarks.push({
        name: stone.name, x: stone.x, z: stone.z, kind: "waystone", colour: "#9fd8ff", stone: stone.id,
      });
    }
    for (const settlement of settlements) {
      this.landmarks.push({
        name: settlement.name, x: settlement.x, z: settlement.z, kind: "settlement", colour: "#ffc46b",
        ...(townStone.has(settlement.id) ? { stone: townStone.get(settlement.id)! } : {}),
      });
      for (const villager of settlement.villagers) {
        if (!villager.vendor) continue;
        this.landmarks.push({ name: `${villager.name} · Shop`, x: villager.x, z: villager.z, kind: "vendor", colour: "#e8c23f" });
      }
    }
    for (const ruin of ostra.ruins) {
      this.landmarks.push({ name: ruin.name, x: ruin.x, z: ruin.z, kind: "ruin", colour: "#cdbb8c" });
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
    this.defaultHint = this.worldHint.innerHTML;
    this.worldCanvas.addEventListener("mousemove", this.onPickMove);
    this.worldCanvas.addEventListener("click", this.onPickClick);
    this.worldCanvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.worldCanvas.addEventListener("mousedown", this.onDragStart);
    window.addEventListener("mousemove", this.onDragMove);
    window.addEventListener("mouseup", this.onDragEnd);
  }

  /** Which waystones this character has woken: a woken stone is a door, and
   *  the map draws it as a solid diamond rather than an empty one. */
  setAttuned(attuned: readonly string[]): void {
    this.attuned = new Set(
      this.ostra.waystones
        .filter((stone) => attuned.includes(waystoneKey(this.ostra.id, stone.id)))
        .map((stone) => stone.id),
    );
  }

  /** Your level, which is what every region's band is read against. */
  setLevel(level: number): void {
    this.level = level;
  }

  /** Where your quests want you. Replaces the last set. */
  setQuestMarks(marks: QuestMark[]): void {
    this.questMarks = marks;
    for (const mark of this.questCompass) mark.remove();
    this.questCompass = [];
    for (const mark of marks) {
      const el = document.createElement("span");
      el.className = `landmark quest ${mark.kind}`;
      el.title = mark.label;
      el.dataset["x"] = String(mark.x);
      el.dataset["z"] = String(mark.z);
      this.compass.appendChild(el);
      this.questCompass.push(el);
    }
  }

  // --- the world map's view ------------------------------------------------------

  /** Metres of the Ostra across the world map at the current zoom. */
  private get viewMetres(): number {
    return this.ostra.size / this.zoom;
  }

  /**
   * Which painted cache the world map draws its detail from at this zoom:
   * zoomed well in, the minimap's fine tiles take over from the world map's
   * own, which would only be stretched.
   *
   * `update` asks too, so the cache actually being drawn from is the one that
   * gets the painting budget.
   */
  private get detailCache(): TileCache {
    const size = Math.max(1, this.worldCanvas.width);
    return this.viewMetres / size < this.world.mpp / 2.5 ? this.local : this.world;
  }

  /** Keep the view over the Ostra: never scrolled off into nothing. */
  private clampView(): void {
    const half = this.ostra.size / 2;
    const reach = Math.max(0, half - this.viewMetres / 2);
    this.centreX = Math.max(-reach, Math.min(reach, this.centreX));
    this.centreZ = Math.max(-reach, Math.min(reach, this.centreZ));
  }

  /** Scroll: in or out about the point under the cursor, which stays put. */
  private zoomAt(event: WheelEvent): void {
    event.preventDefault();
    const before = this.worldPointAt(event);
    const factor = Math.exp(-event.deltaY * 0.0015);
    this.zoom = Math.max(1, Math.min(24, this.zoom * factor));
    const after = this.worldPointAt(event);
    this.centreX += before.x - after.x;
    this.centreZ += before.z - after.z;
    this.clampView();
  }

  private startDrag(event: MouseEvent): void {
    if (event.button !== 0) return;
    this.drag = { x: event.clientX, y: event.clientY, moved: false };
    this.dragged = false;
  }

  private moveDrag(event: MouseEvent): void {
    const drag = this.drag;
    if (!drag || !this.worldOpen) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    this.dragged = true;
    const mpp = this.viewMetres / Math.max(1, this.worldCanvas.getBoundingClientRect().width);
    this.centreX -= dx * mpp;
    this.centreZ += dy * mpp;
    drag.x = event.clientX;
    drag.y = event.clientY;
    this.clampView();
  }

  get worldOpen(): boolean {
    return !this.worldPanel.hidden;
  }

  toggleWorld(): void {
    this.worldPanel.hidden = !this.worldPanel.hidden;
    // Opening zoomed in: start where you are, not wherever you left it.
    if (!this.worldPanel.hidden && this.zoom > 1) {
      this.centreX = this.lastX;
      this.centreZ = this.lastZ;
      this.clampView();
    }
    // Closing the map by any route ends a pick.
    if (this.worldPanel.hidden && this.picker) this.setPicker(undefined);
  }

  /**
   * Development: open the world map and hand the next click on it to
   * `picker`, as a point in the world. Undefined cancels.
   */
  setPicker(picker: ((x: number, z: number) => void) | undefined): void {
    this.picker = picker;
    this.worldPanel.classList.toggle("picking", picker !== undefined);
    if (picker) {
      if (!this.worldOpen) this.worldPanel.hidden = false;
      this.worldHint.textContent = "Click anywhere to go there · Esc to cancel";
    } else {
      this.worldHint.innerHTML = this.defaultHint;
    }
  }

  get picking(): boolean {
    return this.picker !== undefined;
  }

  /** A pointer position on the world map, as a place in the world: the
   *  current view fitted to a square canvas, north up. */
  private worldPointAt(event: MouseEvent): { x: number; z: number } {
    const rect = this.worldCanvas.getBoundingClientRect();
    const metresPerPixel = this.viewMetres / Math.max(1, rect.width);
    return {
      x: this.centreX - this.viewMetres / 2 + (event.clientX - rect.left) * metresPerPixel,
      z: this.centreZ + this.viewMetres / 2 - (event.clientY - rect.top) * metresPerPixel,
    };
  }

  private describePick(event: MouseEvent): void {
    if (!this.picker) return;
    const { x, z } = this.worldPointAt(event);
    const region = regionOf(this.ostra, x, z)?.name ?? "the wilds";
    this.worldHint.textContent =
      `${Math.round(x)}, ${Math.round(z)} · ${region} · level ${levelAt(this.ostra, x, z)} — click to go there`;
  }

  private pick(event: MouseEvent): void {
    const picker = this.picker;
    if (!picker || this.dragged) return;
    const { x, z } = this.worldPointAt(event);
    this.setPicker(undefined);
    this.worldPanel.hidden = true;
    picker(x, z);
  }

  /** The canvases outlive the session; their listeners must not. */
  dispose(): void {
    this.worldCanvas.removeEventListener("mousemove", this.onPickMove);
    this.worldCanvas.removeEventListener("click", this.onPickClick);
    this.worldCanvas.removeEventListener("wheel", this.onWheel);
    this.worldCanvas.removeEventListener("mousedown", this.onDragStart);
    window.removeEventListener("mousemove", this.onDragMove);
    window.removeEventListener("mouseup", this.onDragEnd);
    for (const mark of this.questCompass) mark.remove();
    this.setPicker(undefined);
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
      // The town is on the compass; its shop would only crowd it.
      if (landmark.kind === "vendor") continue;
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
    this.lastX = x;
    this.lastZ = z;
    this.drawMinimap(x, z, heading, blips);
    this.drawCompass(x, z, heading, targetBearing);
    this.updateInfo(x, z);
    if (this.worldOpen) {
      this.drawWorld(x, z, heading, blips);
      // Whichever cache the map is drawing from gets the budget. Handing it
      // to the coarse one unconditionally spent it on tiles that were long
      // since finished, while the detailed tiles a zoomed-in view actually
      // needed waited behind the minimap's 4 ms — which is why zooming right
      // in used to sit on black ground for half a minute.
      this.detailCache.work(12);
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
    for (const { points } of roadPaths(this.ostra)) {
      ctx.beginPath();
      points.forEach((p, i) => {
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
      drawLandmark(ctx, landmark, px, py, 1, this.woken(landmark));
    }

    // Quests: areas and points where they are, and anything beyond the
    // edge as a gold notch on the rim, pointing the way.
    for (const mark of this.questMarks) {
      const px = (mark.x - left) / mpp;
      const py = (top - mark.z) / mpp;
      const radius = (mark.radius ?? 0) / mpp;
      const dx = px - size / 2;
      const dy = py - size / 2;
      const distance = Math.hypot(dx, dy);
      const rim = size / 2 - 9;
      if (distance - radius > rim) {
        drawRimNotch(ctx, size / 2 + (dx / distance) * rim, size / 2 + (dy / distance) * rim, Math.atan2(dx, -dy), mark.kind);
        continue;
      }
      drawQuestMark(ctx, mark, px, py, radius, 1);
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

    // North, on the rim. The minimap never rotates, which is worth saying
    // once in the corner rather than leaving anyone to work out from the
    // terrain that the top of the circle is always north.
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "700 10px ui-sans-serif, system-ui, sans-serif";
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillText("N", size / 2 + 1, 10);
    ctx.fillStyle = "rgba(230,237,243,0.85)";
    ctx.fillText("N", size / 2, 9);
    ctx.textBaseline = "alphabetic";
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
    const mpp = this.viewMetres / size;
    const cache = this.detailCache;
    const left = this.centreX - this.viewMetres / 2;
    const top = this.centreZ + this.viewMetres / 2;
    ctx.fillStyle = "#12161c";
    ctx.fillRect(0, 0, size, size);
    // The coarse whole-Ostra tiles underneath, always: they were painted
    // during the loading screen, so there is ground under everything from the
    // first frame. Zoomed in they are stretched and soft, and the detailed
    // tiles above them sharpen the picture as they arrive — a blurry map is
    // worth a great deal more than a black one.
    if (cache !== this.world) {
      this.drawTiles(ctx, this.world, left, top, size, size, this.world.mpp / mpp);
    }
    this.drawTiles(ctx, cache, left, top, size, size, cache.mpp / mpp);

    const toPx = (wx: number, wz: number): [number, number] => [(wx - left) / mpp, (top - wz) / mpp];

    ctx.strokeStyle = "rgba(190, 160, 110, 0.95)";
    ctx.lineWidth = 2;
    for (const { points } of roadPaths(this.ostra)) {
      ctx.beginPath();
      points.forEach((p, i) => {
        const [px, py] = toPx(p.x, p.z);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.stroke();
    }

    // Every glyph is drawn first and every name afterwards, so a name can
    // never land on top of a symbol — and so the names can be placed in
    // priority order, which is what keeps eight kilometres of them readable.
    ctx.textAlign = "center";
    this.placed = [];
    const labels: Array<{ lines: LabelLine[]; x: number; y: number }> = [];

    // Region names and their level bands are drawn straight away rather than
    // queued: they are the backdrop everything else is read against, and the
    // band — coloured against your own level the way a nameplate is — is the
    // whole answer to "can I go there yet". Drawing them before the marker
    // that says where you are is deliberate; otherwise the one region you
    // most want named, the one you are standing in, is the one that loses.
    for (const region of this.ostra.regions) {
      const [rx, ry] = toPx(region.x, region.z + 260);
      const band = this.ostra.wilds ? region.levels : undefined;
      this.drawLabel(ctx, [
        { text: region.name.toUpperCase(), colour: "rgba(255,248,230,0.78)", font: REGION_FONT },
        ...(band ? [{
          text: `levels ${band[0]}–${band[1]}`,
          colour: DIFFICULTY_COLOUR[difficultyOf(Math.round((band[0] + band[1]) / 2), this.level)],
          font: BAND_FONT,
        }] : []),
      ], rx, ry);
    }

    // The sea, named out in the open water and turned to run along the coast:
    // an eight-kilometre coast has room for the name, and the strip of water
    // beside it does not have room for it lying flat.
    const sea = this.ostra.terrain.sea;
    if (sea) {
      const half = this.ostra.size / 2;
      const out = sea.from + sea.wander + (half - sea.from - sea.wander) * 0.5;
      const sideways = sea.side === "east" || sea.side === "west";
      const [sx, sy] = toPx(sea.side === "east" ? out : sea.side === "west" ? -out : 0,
        sea.side === "north" ? out : sea.side === "south" ? -out : 0);
      const text = sea.name.toUpperCase().split("").join(" ");
      ctx.save();
      ctx.font = SEA_FONT;
      const width = ctx.measureText(text).width;
      ctx.translate(sx, sy);
      if (sideways) ctx.rotate(sea.side === "east" ? Math.PI / 2 : -Math.PI / 2);
      ctx.fillStyle = "rgba(214, 236, 250, 0.7)";
      ctx.textBaseline = "middle";
      ctx.fillText(text, 0, 0);
      ctx.restore();
      this.placed.push(sideways
        ? { x: sx - 9, y: sy - width / 2, w: 18, h: width }
        : { x: sx - width / 2, y: sy - 9, w: width, h: 18 });
    }

    // A hunting ground's name, under the gold ring of a quest that sends you
    // there — and only then. Every ground used to be ringed and named whether
    // or not you had business in it, and a ring on the map reads as "you have
    // something to do here": the Webbed Thicket showed for players who had
    // never met Osk. Names are the first thing to give way when it is crowded.
    for (const area of this.ostra.areas ?? []) {
      if (!this.questMarks.some((mark) => mark.kind === "area" && mark.x === area.x && mark.z === area.z)) continue;
      const [ax, ay] = toPx(area.x, area.z);
      const radius = Math.max(8, area.radius / mpp);
      if (this.zoom >= AREA_LABEL_ZOOM) {
        labels.push({
          x: ax, y: ay + radius + 13,
          lines: [{ text: area.name, colour: "rgba(240, 228, 200, 0.85)", font: AREA_FONT }],
        });
      }
    }

    for (const landmark of this.landmarks) {
      // A shop is a speck inside its town until the map is close enough to
      // show the town's streets.
      if (landmark.kind === "vendor" && this.zoom < VENDOR_ZOOM) continue;
      const [px, py] = toPx(landmark.x, landmark.z);
      drawLandmark(ctx, landmark, px, py, 1.4, this.woken(landmark));
      // A Gate is named by the world it opens on, which the zone banner and
      // the walk-up prompt both say better than a word on a map would.
      if (landmark.kind === "gate") continue;
      if (landmark.kind === "ruin" && this.zoom < RUIN_LABEL_ZOOM) continue;
      labels.push({
        x: px, y: py - 10,
        lines: [{
          text: landmark.name,
          colour: landmark.kind === "settlement" ? "#ffe2a8" : landmark.kind === "ruin" ? "#e8dcc0" : "#e6edf3",
          font: LANDMARK_FONT,
        }],
      });
    }

    for (const mark of this.questMarks) {
      const [qx, qy] = toPx(mark.x, mark.z);
      const radius = Math.max(mark.kind === "area" ? 8 : 0, (mark.radius ?? 0) / mpp);
      drawQuestMark(ctx, mark, qx, qy, radius, 1.4);
      labels.push({
        x: qx, y: qy - radius - 8,
        lines: [{ text: mark.label, colour: "#f7e3a0", font: QUEST_FONT }],
      });
    }

    // Your target, and every living elite — gold, ringed, a little larger.
    for (const blip of blips) {
      if (!blip.ring && !blip.elite) continue;
      const [px, py] = toPx(blip.x, blip.z);
      ctx.beginPath();
      ctx.arc(px, py, blip.elite ? 4.5 : 3, 0, Math.PI * 2);
      ctx.fillStyle = blip.colour;
      ctx.fill();
      if (blip.elite) {
        ctx.strokeStyle = "#1a1408";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    // You: a ring under the arrow, because on a map of the whole Ostra a
    // nine-pixel arrow is one speck among a dozen other specks.
    const [px, py] = toPx(x, z);
    ctx.beginPath();
    ctx.arc(px, py, 13, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    drawArrow(ctx, px, py, heading, 9);
    // A box over you that nothing draws in, so no name sits on your head.
    this.placed.push({ x: px - 15, y: py - 15, w: 30, h: 30 });

    // Quest marks, then towns and stones, then ruins: the order they were
    // queued in, which is the order that survives a crowded map.
    for (const label of labels) this.drawLabel(ctx, label.lines, label.x, label.y);

    this.drawScale(ctx, size, mpp);

    // How much world is on screen. The scale bar answers "how far is that";
    // this answers "how much of the map am I looking at", which is the other
    // half of not being lost in a zoomed-in corner.
    const across = `${distanceWord(this.viewMetres)} across`;
    if (across !== this.shownAcross) {
      this.shownAcross = across;
      this.worldAcross.textContent = across;
    }
  }

  /** Is this landmark's waystone woken? Undefined where there is no stone. */
  private woken(landmark: Landmark): boolean | undefined {
    return landmark.stone === undefined ? undefined : this.attuned.has(landmark.stone);
  }

  /**
   * Draw a stack of lines centred on (x, y) — unless the block would overlap
   * one already drawn, in which case it is dropped.
   *
   * Dropping a name is much kinder than printing it over another: a map with
   * a name missing is still a map, and the name comes back the moment you
   * zoom in far enough for it to have room.
   */
  private drawLabel(ctx: CanvasRenderingContext2D, lines: LabelLine[], x: number, y: number): void {
    let width = 0;
    for (const line of lines) {
      ctx.font = line.font;
      width = Math.max(width, ctx.measureText(line.text).width);
    }
    // A label whose anchor is off the canvas is not drawn at all: half a word
    // clinging to the edge reads as a mistake, not as information.
    const size = ctx.canvas.width;
    if (x < 0 || y < 0 || x > size || y > size) return;
    const box = {
      x: x - width / 2 - 2,
      y: y - LABEL_LINE_HEIGHT,
      w: width + 4,
      h: lines.length * LABEL_LINE_HEIGHT + 2,
    };
    for (const other of this.placed) {
      if (box.x < other.x + other.w && box.x + box.w > other.x
        && box.y < other.y + other.h && box.y + box.h > other.y) return;
    }
    this.placed.push(box);
    lines.forEach((line, index) => {
      const ly = y + index * LABEL_LINE_HEIGHT;
      ctx.font = line.font;
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillText(line.text, x + 1, ly + 1);
      ctx.fillStyle = line.colour;
      ctx.fillText(line.text, x, ly);
    });
  }

  /**
   * A bar and a round distance, bottom left.
   *
   * Without one, nothing on the map says whether two places are a stroll
   * apart or a quarter of an hour — and at twenty-four times zoom the very
   * same picture means two hundred metres instead of eight kilometres.
   */
  private drawScale(ctx: CanvasRenderingContext2D, size: number, mpp: number): void {
    // The largest round distance that still fits the quarter of the canvas it
    // is given, rather than the first one over it — which drew a "4 km" bar
    // half the map wide.
    const want = size * 0.28 * mpp;
    const metres = SCALE_STEPS.filter((step) => step <= want).pop() ?? SCALE_STEPS[0]!;
    const length = metres / mpp;
    const x = 14;
    const y = size - 16;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + length, y); ctx.lineTo(x + length, y - 5);
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.font = LANDMARK_FONT;
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillText(distanceWord(metres), x + length / 2 + 1, y - 8);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fillText(distanceWord(metres), x + length / 2, y - 9);
    ctx.restore();
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

  /** "Westroad Stone · levels 5-10", updated only when it changes. The band
   *  is the region's, so it answers "am I ready to be here" at a glance. */
  private updateInfo(x: number, z: number): void {
    let nearest: Landmark | undefined;
    let best = Infinity;
    for (const landmark of this.landmarks) {
      // You are in Daso, not "North of Mott".
      if (landmark.kind === "gate" || landmark.kind === "vendor") continue;
      const d = Math.hypot(landmark.x - x, landmark.z - z);
      if (d < best) {
        best = d;
        nearest = landmark;
      }
    }
    let place = this.ostra.name;
    if (nearest && best < 90) place = nearest.name;
    else if (nearest && best < 900) place = `${compassWord(Math.atan2(x - nearest.x, z - nearest.z))} of ${nearest.name}`;
    const region = regionOf(this.ostra, x, z);
    if (!(nearest && best < 900)) place = region?.name ?? place;

    // At a dungeon's Gate, the band that matters is the dungeon's, not the
    // woods it stands in: "The Hollow Barrow · levels 1–5" read as a promise.
    const dungeonGate = this.ostra.gates.find((gate) =>
      getOstra(gate.target).dungeon && Math.hypot(gate.x - x, gate.z - z) < 40);
    const band = this.ostra.dungeon?.levels
      ?? (dungeonGate ? getOstra(dungeonGate.target).dungeon?.levels : undefined)
      ?? (this.ostra.wilds ? region?.levels : undefined);
    const danger = band ? ` · levels ${band[0]}–${band[1]}` : "";
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

/** A quest's mark: a hunting ground, a place, or a "?" to hand it in. */
function drawQuestMark(ctx: CanvasRenderingContext2D, mark: QuestMark, x: number, y: number, radius: number, scale: number): void {
  ctx.save();
  if (mark.kind === "area") {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(240, 200, 70, 0.18)";
    ctx.fill();
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = "rgba(247, 214, 110, 0.95)";
    ctx.stroke();
  } else if (mark.kind === "point") {
    const s = 5 * scale;
    ctx.beginPath();
    ctx.moveTo(x, y - s * 1.3); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s * 1.3); ctx.lineTo(x - s, y);
    ctx.closePath();
    ctx.fillStyle = "#f7d66e";
    ctx.strokeStyle = "#1a1408";
    ctx.lineWidth = 1.6;
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(x, y, 6.5 * scale, 0, Math.PI * 2);
    ctx.fillStyle = "#1a1408";
    ctx.fill();
    ctx.strokeStyle = "#f7d66e";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = "#f7d66e";
    ctx.font = `800 ${Math.round(10 * scale)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(mark.kind === "offer" ? "!" : "?", x, y + 0.5);
  }
  ctx.restore();
}

/** A gold notch on the minimap's rim, pointing at a quest mark beyond it. */
function drawRimNotch(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, kind: QuestMark["kind"]): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, -6); ctx.lineTo(5, 3); ctx.lineTo(-5, 3);
  ctx.closePath();
  ctx.fillStyle = kind === "turnin" ? "#fff1b8" : "#f7d66e";
  ctx.strokeStyle = "#1a1408";
  ctx.lineWidth = 1.4;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/**
 * A landmark's glyph: a diamond for a waystone, a house for a town, broken
 * walls for a ruin, a disc for a Gate.
 *
 * `woken` says whether the waystone here has been walked to — solid means you
 * can travel to it, hollow means you cannot yet. A town shows its own stone
 * the same way, as a small diamond beside the roof, because a town and its
 * stone share one glyph (see `Landmark.stone`).
 */
function drawLandmark(
  ctx: CanvasRenderingContext2D,
  landmark: Landmark,
  x: number,
  y: number,
  scale: number,
  woken?: boolean,
): void {
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
    ctx.stroke();
    // Asleep: the outline in its own colour and nothing inside it, so the
    // stone is still plainly there and plainly not yet a door.
    if (woken) ctx.fill();
    else {
      ctx.strokeStyle = landmark.colour;
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
    ctx.restore();
    return;
  }
  if (landmark.kind === "settlement") {
    const s = 4.5 * scale;
    ctx.rect(-s, -s * 0.4, s * 2, s * 1.4);
    ctx.moveTo(-s * 1.2, -s * 0.4); ctx.lineTo(0, -s * 1.4); ctx.lineTo(s * 1.2, -s * 0.4);
    ctx.stroke();
    ctx.fill();
    // The town's own waystone, beside the roof.
    if (woken !== undefined) {
      const d = 2.4 * scale;
      ctx.beginPath();
      ctx.moveTo(s * 1.9, -s * 0.9 - d); ctx.lineTo(s * 1.9 + d * 0.7, -s * 0.9);
      ctx.lineTo(s * 1.9, -s * 0.9 + d); ctx.lineTo(s * 1.9 - d * 0.7, -s * 0.9);
      ctx.closePath();
      ctx.strokeStyle = "#9fd8ff";
      ctx.lineWidth = 1.2;
      ctx.stroke();
      if (woken) {
        ctx.fillStyle = "#9fd8ff";
        ctx.fill();
      }
    }
    ctx.restore();
    return;
  }
  if (landmark.kind === "vendor") {
    // A coin: gold, rimmed dark, with a struck ring inside.
    const r = 4 * scale;
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.5, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#6b4d0a";
    ctx.stroke();
    ctx.restore();
    return;
  }
  if (landmark.kind === "ruin") {
    const s = 3.6 * scale;
    ctx.rect(-s, -s * 0.2, s * 0.6, s * 1.2);
    ctx.rect(s * 0.4, -s, s * 0.6, s * 2);
    ctx.rect(-s * 0.2, -s * 0.6, s * 0.4, s * 1.6);
  } else {
    ctx.arc(0, 0, 3.5 * scale, 0, Math.PI * 2);
  }
  ctx.stroke();
  ctx.fill();
  ctx.restore();
}
