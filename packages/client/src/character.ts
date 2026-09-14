import { Matrix, Vector3, Viewport } from "@babylonjs/core/Maths/math.js";
import type { Scene } from "@babylonjs/core/scene.js";
import {
  armourReduction,
  canWear,
  characterStats,
  classCanUse,
  CLASSES,
  critChanceFor,
  DEFAULT_CLASS,
  describeItem,
  EQUIP_SLOTS,
  FAMILY_NAMES,
  FERVOUR_DAMAGE_BONUS,
  GEAR_NAMES,
  GOOD_IDS,
  GOODS,
  goodsValue,
  INVENTORY_SIZE,
  leechFraction,
  maxHealthFor,
  maxResourceFor,
  percent,
  preferredSlot,
  RARITY,
  rarityHex,
  recoveryMultiplier,
  SLOT_NAMES,
  slotsFor,
  SPELLS,
  STAT_ORDER,
  STATS,
  wear,
  type ClassId,
  type EquipSlot,
  type Equipment,
  type GearSlot,
  type GoodKind,
  type Goods,
  TRADE_IDS,
  TRADES,
  tradeProgress,
  type TradeId,
  type Trades,
  type Item,
  type ItemFamily,
  type ItemKey,
  type StatTotals,
  type Wearer,
} from "@mmo/shared";
import type { Rig } from "./rigs.js";

/**
 * The character screen: your body, everything on it, and your pack.
 *
 * Pressing I swings the camera round to face you and closes in (the session
 * owns that; see `setPortrait`), and the slots fly out of your body along the
 * lines that tie each one to where it is worn — the helm to the head, the
 * rings to each hand, the blade to the blade. The pack slides in from the
 * right. It is the same body you walk around in, not a portrait of it, so
 * whatever you are wearing and whatever pose you are in is what you see.
 *
 * The lines are re-projected from the rig's joints every frame, so they stay
 * attached through the camera's swing, your idle sway, and any orbiting you
 * do by dragging the empty space around you.
 */

export interface CharacterProfile {
  classId: ClassId;
  level: number;
  inventory: ItemKey[];
  equipment: Equipment;
  goods: Goods;
  trades: Trades;
}

export interface CharacterScreenHooks {
  equip(item: ItemKey, slot?: EquipSlot): void;
  unequip(slot: EquipSlot): void;
  destroy(item: ItemKey): void;
  /** The screen opened or closed; `shift` is how far left to frame the body. */
  openChanged(open: boolean, shift: number): void;
}

/** Where a slot sits and which bit of the body its line runs to. */
interface SlotPlacement {
  slot: EquipSlot;
  side: "left" | "right" | "bottom";
  row: number;
  joint: string;
  /** Offset from the joint, in the joint's own space. */
  at: [number, number, number];
}

/**
 * The body faces you, so its right hand is on YOUR left. The weapon hand's
 * slots go on the left column and the off hand's on the right, and each
 * column runs top to bottom in the order its anchors do, so no two lines
 * cross on the way in.
 */
const PLACEMENTS: SlotPlacement[] = [
  { slot: "head", side: "left", row: 0, joint: "head", at: [0, 0.3, 0.06] },
  { slot: "cloak", side: "left", row: 1, joint: "chest", at: [0.2, 0.46, -0.14] },
  { slot: "body", side: "left", row: 2, joint: "chest", at: [0.1, 0.24, 0.17] },
  { slot: "weapon", side: "left", row: 3, joint: "blade", at: [0, 0, 0.42] },
  { slot: "ring2", side: "left", row: 4, joint: "armR", at: [0, -0.43, 0.06] },
  { slot: "legs", side: "left", row: 5, joint: "legR", at: [0, -0.1, 0.1] },
  { slot: "neck", side: "right", row: 0, joint: "chest", at: [0, 0.5, 0.15] },
  { slot: "sigil", side: "right", row: 1, joint: "chest", at: [-0.13, 0.36, 0.17] },
  { slot: "hands", side: "right", row: 2, joint: "armL", at: [0, -0.36, 0.08] },
  { slot: "ring1", side: "right", row: 3, joint: "armL", at: [0, -0.44, 0.06] },
  { slot: "offhand", side: "right", row: 4, joint: "armL", at: [-0.08, -0.3, 0.1] },
  { slot: "feet", side: "right", row: 5, joint: "legL", at: [0, -0.34, 0.1] },
  { slot: "soul", side: "bottom", row: 0, joint: "chest", at: [0, 0.2, 0] },
];

const ROWS = 6;
const SLOT_SIZE = 58;
/** How long each slot takes to fly out, and how far apart they leave. */
const FLY_MS = 420;
const FLY_STAGGER_MS = 38;
/** Slots wait for the camera to be most of the way round before leaving. */
const FLY_DELAY_MS = 260;
const CLOSE_MS = 240;

/**
 * Little line drawings for each kind of thing, on a 24-unit grid, stroked in
 * the item's colour. Nothing is loaded from a file — the same rule the rest of
 * the art follows.
 */
const GLYPHS: Record<string, string> = {
  head: "M5 14a7 7 0 0 1 14 0v5h-4v-3.5h-6V19H5z M9 11.5h6",
  neck: "M6 4c0 6 3 9 6 9s6-3 6-9 M12 13l-2.6 3.6L12 20.5l2.6-3.9z",
  cloak: "M8.5 4h7l1.5 4 3 12H4L7 8z M12 4v16",
  body: "M8 4 4 7l2 5 2-1v9h8v-9l2 1 2-5-4-3-2 2h-4z",
  hands: "M7.5 20v-7.5L5 9.5l1.5-1 2.5 2.5V5h2v6V4h2v7V5h2v7l1.2-3h2l-2 7.5V20z",
  ring: "M12 21a6 6 0 1 0 0-12 6 6 0 0 0 0 12z M10 6.5l2-3 2 3-2 2z",
  legs: "M7 3h10l-1 17h-3.2L12 9l-.8 11H8z",
  feet: "M8 3h5v10l6 3v4H5v-4l3-3z",
  swords: "M19.5 4.5 9 15 M14 4.5h5.5V10 M6.5 12.5l5 5 M4.5 19.5l3-3",
  axes: "M7 21 15.5 5 M13.5 4c4 0 6.5 3 6.5 6.5-3.5 0-5.5-1.5-7.5-3.5z",
  maces: "M5 20l8.5-8.5 M16 3.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z M16 2v3 M21.5 8h-3",
  daggers: "M16.5 4.5 20 5l-8.5 9.5-2-2z M7.5 13l3.5 3.5 M5 19.5l3.5-3.5",
  staves: "M5 21 16 7.5 M17.5 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  wands: "M5 19.5 15.5 9 M17.5 3v3 M21 6.5h-3 M20 4l-2 2",
  shields: "M12 3l7 3v5.5c0 5-3 8-7 9.5-4-1.5-7-4.5-7-9.5V6z",
  foci: "M12 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12z M8 20h8 M12 16v4 M10 8.5l2 1.5 2-1.5",
  sigil: "M12 3l2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4z",
  soul: "M12 3c3 4 6 6 6 10.5a6 6 0 0 1-12 0c0-3 2-4.5 3-6.5 0 2 1 3 2 3.2C11 7 11.5 5 12 3z",
};

/** The same, for goods: one drawing per kind. */
const GOOD_GLYPHS: Record<GoodKind, string> = {
  fish: "M6 12c2.5-3.5 6-5 9-5 3 0 5 2 6.5 5-1.5 3-3.5 5-6.5 5-3 0-6.5-1.5-9-5z M6 12 2.5 8.5v7z M17 10.8v.4",
};

function glyphFor(gear: GearSlot, family: ItemFamily | undefined): string {
  if ((gear === "weapon" || gear === "offhand") && family && GLYPHS[family]) return GLYPHS[family]!;
  return GLYPHS[gear] ?? GLYPHS.sigil!;
}

function glyphSvg(path: string): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char] as string));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function easeOutBack(t: number): number {
  const c = 1.4;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
}

function easeInCubic(t: number): number {
  return t * t * t;
}

interface SlotView {
  placement: SlotPlacement;
  el: HTMLElement;
  glyph: HTMLElement;
  level: HTMLElement;
  label: HTMLElement;
  line: SVGPathElement;
  dot: SVGCircleElement;
  /** Where it rests, in CSS pixels. */
  homeX: number;
  homeY: number;
  /** Where its line meets the body this frame. */
  anchorX: number;
  anchorY: number;
  anchorVisible: boolean;
}

export class CharacterScreen {
  private readonly root: HTMLElement;
  private readonly lines: SVGSVGElement;
  private readonly panel: HTMLElement;
  private readonly packGrid: HTMLElement;
  private readonly packCount: HTMLElement;
  private readonly abilityList: HTMLElement;
  private readonly satchel: HTMLElement;
  private readonly heading: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly tooltip: HTMLElement;
  private readonly menu: HTMLElement;
  private readonly tabs: HTMLElement[];
  private readonly slotViews = new Map<EquipSlot, SlotView>();

  private profile: CharacterProfile = { classId: DEFAULT_CLASS, level: 1, inventory: [], equipment: {}, goods: {}, trades: {} };
  private name = "";
  private open = false;
  private openedAt = 0;
  private closedAt = 0;
  /** Keys that arrived since the last profile — lit until looked at. */
  private readonly fresh = new Set<ItemKey>();
  private known: Set<ItemKey> | undefined;
  /** What the pointer is over, so tooltips and slot highlights agree. */
  private hovered: { item: Item; from: "pack" | EquipSlot } | undefined;
  private dragging: ItemKey | undefined;

  private readonly viewport = new Viewport(0, 0, 1, 1);
  private readonly scratch = new Vector3();
  private readonly local = new Vector3();

  constructor(host: HTMLElement, private readonly hooks: CharacterScreenHooks) {
    this.root = host;
    this.root.innerHTML = `
      <div class="char-backdrop"></div>
      <svg class="char-lines"></svg>
      <div class="char-heading"></div>
      <div class="char-slots"></div>
      <aside class="char-panel">
        <div class="char-summary"></div>
        <header>
          <button type="button" class="char-tab active" data-tab="pack">Pack</button>
          <button type="button" class="char-tab" data-tab="satchel">Satchel</button>
          <button type="button" class="char-tab" data-tab="abilities">Abilities</button>
          <button type="button" class="char-close" title="Close (I or Esc)">×</button>
        </header>
        <section class="char-pack" data-page="pack">
          <div class="pack-grid"></div>
          <footer><span class="pack-count"></span><span class="pack-hint">Click to wear · drag onto a slot · right-click for more</span></footer>
        </section>
        <section class="char-satchel" data-page="satchel" hidden></section>
        <section class="char-abilities" data-page="abilities" hidden></section>
      </aside>
      <div class="char-tooltip" hidden></div>
      <div class="char-menu" hidden></div>
    `;

    this.lines = this.root.querySelector(".char-lines") as SVGSVGElement;
    this.panel = this.root.querySelector(".char-panel") as HTMLElement;
    this.packGrid = this.root.querySelector(".pack-grid") as HTMLElement;
    this.packCount = this.root.querySelector(".pack-count") as HTMLElement;
    this.abilityList = this.root.querySelector(".char-abilities") as HTMLElement;
    this.satchel = this.root.querySelector(".char-satchel") as HTMLElement;
    this.heading = this.root.querySelector(".char-heading") as HTMLElement;
    this.summary = this.root.querySelector(".char-summary") as HTMLElement;
    this.tooltip = this.root.querySelector(".char-tooltip") as HTMLElement;
    this.menu = this.root.querySelector(".char-menu") as HTMLElement;
    this.tabs = [...this.root.querySelectorAll<HTMLElement>(".char-tab")];

    for (const tab of this.tabs) tab.onclick = () => this.showTab(tab.dataset["tab"] ?? "pack");
    (this.root.querySelector(".char-close") as HTMLElement).onclick = () => this.setOpen(false);

    this.buildSlots();
    this.buildPack();

    // Dropping a worn item anywhere on the panel takes it off.
    this.panel.addEventListener("dragover", (event) => {
      if (this.dragging && this.wornSlotOf(this.dragging)) event.preventDefault();
    });
    this.panel.addEventListener("drop", (event) => {
      const slot = this.dragging ? this.wornSlotOf(this.dragging) : undefined;
      if (!slot) return;
      event.preventDefault();
      this.hooks.unequip(slot);
    });

    // Any click that is not on the menu closes it.
    window.addEventListener("pointerdown", (event) => {
      if (!this.menu.hidden && !this.menu.contains(event.target as Node)) this.hideMenu();
    });
    window.addEventListener("resize", () => {
      if (this.open) this.layout();
    });
  }

  get isOpen(): boolean {
    return this.open;
  }

  setName(name: string): void {
    this.name = name;
    this.renderHeading();
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  setOpen(open: boolean): void {
    if (open === this.open) return;
    this.open = open;
    const now = performance.now();
    this.hideMenu();
    this.hideTooltip();

    if (open) {
      this.openedAt = now;
      this.root.hidden = false;
      this.layout();
      // Fresh items are only fresh until you have seen the pack once.
      this.renderPack();
      // Force a layout of the closed state first, so the transition has
      // something to run from. (Not requestAnimationFrame: that never fires in
      // a hidden tab, and the screen would open with no panel.)
      void this.root.offsetWidth;
      this.root.classList.add("open");
      document.body.classList.add("portrait");
    } else {
      this.closedAt = now;
      this.root.classList.remove("open");
      document.body.classList.remove("portrait");
      this.fresh.clear();
    }
    this.hooks.openChanged(open, this.shift());
  }

  /** Everything private about this character, from the server. */
  setProfile(profile: CharacterProfile): void {
    // Anything you did not have last time is new — except on the very first
    // profile, when everything would be. Worn items count as had, so taking
    // something off does not announce it as a find.
    if (this.known) {
      for (const key of profile.inventory) if (!this.known.has(key)) this.fresh.add(key);
    }
    this.known = new Set([
      ...profile.inventory,
      ...Object.values(profile.equipment).filter((key): key is ItemKey => key !== undefined),
    ]);
    this.profile = profile;
    this.renderAll();
  }

  setLevel(level: number): void {
    if (level === this.profile.level) return;
    this.profile = { ...this.profile, level };
    this.renderAll();
  }

  /** A trade's total XP changed, between profiles. */
  setTrade(trade: TradeId, total: number): void {
    this.profile = { ...this.profile, trades: { ...this.profile.trades, [trade]: total } };
    this.renderSatchel();
  }

  /** Total power of what is worn. */
  get power(): number {
    return characterStats(this.profile.equipment, this.wearer).power;
  }

  /** What is carried, as the server last said. The level-up banner reads it
   *  to count what a new level just made wearable. */
  get pack(): readonly ItemKey[] {
    return this.profile.inventory;
  }

  private get wearer(): Wearer {
    return { classId: this.profile.classId, level: this.profile.level };
  }

  /**
   * Once per frame, after the scene has rendered: move the slots and redraw
   * the lines against where the body is now.
   */
  update(now: number, scene: Scene, canvas: HTMLCanvasElement, rig: Rig | undefined): void {
    if (this.root.hidden) return;

    const closing = !this.open;
    if (closing && now - this.closedAt > CLOSE_MS + FLY_STAGGER_MS * 4 + 60) {
      this.root.hidden = true;
      return;
    }

    this.viewport.width = canvas.clientWidth;
    this.viewport.height = canvas.clientHeight;
    const transform = scene.getTransformMatrix();

    let index = 0;
    for (const view of this.slotViews.values()) {
      const joint = rig?.joints[view.placement.joint];
      if (joint) {
        const [lx, ly, lz] = view.placement.at;
        this.local.set(lx, ly, lz);
        Vector3.TransformCoordinatesToRef(this.local, joint.getWorldMatrix(), this.scratch);
        const projected = Vector3.Project(this.scratch, Matrix.IdentityReadOnly, transform, this.viewport);
        view.anchorX = projected.x;
        view.anchorY = projected.y;
        view.anchorVisible = projected.z > 0 && projected.z < 1;
      } else {
        view.anchorVisible = false;
      }

      // Out along the line on open, back in along it on close.
      let t: number;
      if (closing) {
        t = 1 - easeInCubic(clamp((now - this.closedAt - index * FLY_STAGGER_MS * 0.4) / CLOSE_MS, 0, 1));
      } else {
        t = easeOutBack(clamp((now - this.openedAt - FLY_DELAY_MS - index * FLY_STAGGER_MS) / FLY_MS, 0, 1));
      }
      const fromX = view.anchorVisible ? view.anchorX : view.homeX;
      const fromY = view.anchorVisible ? view.anchorY : view.homeY;
      const x = fromX + (view.homeX - fromX) * t;
      const y = fromY + (view.homeY - fromY) * t;
      const shown = clamp(t * 1.8, 0, 1);

      view.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%) scale(${(0.35 + 0.65 * clamp(t, 0, 1.2)).toFixed(3)})`;
      view.el.style.opacity = shown.toFixed(3);

      if (view.anchorVisible && t > 0.01) {
        // A short elbow out of the box's inner edge, then straight to the body.
        const inward = view.placement.side === "left" ? 1 : view.placement.side === "right" ? -1 : 0;
        const edgeX = x + inward * (SLOT_SIZE / 2) * (0.35 + 0.65 * t);
        const edgeY = view.placement.side === "bottom" ? y - SLOT_SIZE / 2 : y;
        const elbowX = edgeX + inward * 22 * t;
        view.line.setAttribute("d",
          `M${edgeX.toFixed(1)} ${edgeY.toFixed(1)} L${elbowX.toFixed(1)} ${edgeY.toFixed(1)} ` +
          `L${view.anchorX.toFixed(1)} ${view.anchorY.toFixed(1)}`);
        view.line.style.opacity = shown.toFixed(3);
        view.dot.setAttribute("cx", view.anchorX.toFixed(1));
        view.dot.setAttribute("cy", view.anchorY.toFixed(1));
        view.dot.style.opacity = shown.toFixed(3);
      } else {
        view.line.style.opacity = "0";
        view.dot.style.opacity = "0";
      }
      index++;
    }
  }

  /** Fraction of the screen's width the panel covers. */
  private shift(): number {
    const width = window.innerWidth || 1;
    return clamp(this.panelWidth() / width, 0, 0.5);
  }

  private panelWidth(): number {
    return clamp(window.innerWidth * 0.3, 330, 430);
  }

  // --- building -----------------------------------------------------------------

  private buildSlots(): void {
    const host = this.root.querySelector(".char-slots") as HTMLElement;
    const ns = "http://www.w3.org/2000/svg";

    for (const placement of PLACEMENTS) {
      const el = document.createElement("div");
      el.className = `char-slot ${placement.side}`;
      el.innerHTML = `<span class="glyph"></span><span class="lvl"></span><span class="label"></span>`;
      host.appendChild(el);

      const line = document.createElementNS(ns, "path");
      line.classList.add("char-line");
      const dot = document.createElementNS(ns, "circle");
      dot.classList.add("char-dot");
      dot.setAttribute("r", "3");
      this.lines.append(line, dot);

      const view: SlotView = {
        placement,
        el,
        glyph: el.querySelector(".glyph") as HTMLElement,
        level: el.querySelector(".lvl") as HTMLElement,
        label: el.querySelector(".label") as HTMLElement,
        line,
        dot,
        homeX: 0,
        homeY: 0,
        anchorX: 0,
        anchorY: 0,
        anchorVisible: false,
      };
      this.slotViews.set(placement.slot, view);

      const slot = placement.slot;
      el.addEventListener("pointerenter", (event) => {
        const item = this.wornItem(slot);
        if (item) this.hover(item, slot, event);
        else this.showEmptyTooltip(slot, event);
      });
      el.addEventListener("pointermove", (event) => this.moveTooltip(event));
      el.addEventListener("pointerleave", () => this.unhover());
      el.addEventListener("click", () => {
        if (this.profile.equipment[slot] !== undefined) this.hooks.unequip(slot);
      });
      el.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        const item = this.wornItem(slot);
        if (item) this.showMenu(event, item, slot);
      });

      el.addEventListener("dragstart", (event) => {
        const key = this.profile.equipment[slot];
        if (key === undefined) {
          event.preventDefault();
          return;
        }
        this.dragging = key;
        event.dataTransfer?.setData("text/plain", key);
        this.hideTooltip();
      });
      el.addEventListener("dragend", () => this.endDrag());
      el.addEventListener("dragover", (event) => {
        const item = this.dragging ? describeItem(this.dragging) : undefined;
        if (item && slotsFor(item).includes(slot) && !this.wornSlotOf(item.key)) event.preventDefault();
      });
      el.addEventListener("drop", (event) => {
        const key = this.dragging;
        const item = key ? describeItem(key) : undefined;
        if (!item || !slotsFor(item).includes(slot)) return;
        event.preventDefault();
        this.hooks.equip(item.key, slot);
      });
    }
  }

  private buildPack(): void {
    this.ensureCells(INVENTORY_SIZE);
  }

  /**
   * At least `count` cells. A bag can be over its size — gear the rules
   * stopped you wearing goes into it rather than vanishing — and every item
   * in it must be reachable, or the overflow could never be worn or thrown out.
   */
  private ensureCells(count: number): void {
    for (let i = this.packGrid.children.length; i < count; i++) {
      const cell = document.createElement("div");
      cell.className = "pack-cell empty";
      cell.dataset["index"] = String(i);
      // Staggers the fill-in animation across the grid.
      cell.style.setProperty("--i", String(i));
      this.packGrid.appendChild(cell);

      const keyAt = () => this.profile.inventory[i];
      cell.addEventListener("pointerenter", (event) => {
        const key = keyAt();
        const item = key !== undefined ? describeItem(key) : undefined;
        if (!item) return;
        if (this.fresh.delete(item.key)) cell.classList.remove("fresh");
        this.hover(item, "pack", event);
      });
      cell.addEventListener("pointermove", (event) => this.moveTooltip(event));
      cell.addEventListener("pointerleave", () => this.unhover());
      cell.addEventListener("click", () => {
        const key = keyAt();
        if (key !== undefined) this.hooks.equip(key);
      });
      cell.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        const key = keyAt();
        const item = key !== undefined ? describeItem(key) : undefined;
        if (item) this.showMenu(event, item, "pack");
      });
      cell.addEventListener("dragstart", (event) => {
        const key = keyAt();
        if (key === undefined) {
          event.preventDefault();
          return;
        }
        this.dragging = key;
        event.dataTransfer?.setData("text/plain", key);
        this.hideTooltip();
        const item = describeItem(key);
        if (item) this.highlightSlots(item);
      });
      cell.addEventListener("dragend", () => this.endDrag());
    }
  }

  /** Recompute where every slot rests. Called on open and on resize. */
  private layout(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const stage = width - this.panelWidth();
    this.panel.style.width = `${this.panelWidth()}px`;

    const cx = stage / 2;
    const cy = height * 0.47;
    const column = clamp(stage * 0.25, 150, 300);
    const gap = clamp(height * 0.1, 62, 88);

    for (const view of this.slotViews.values()) {
      const { side, row } = view.placement;
      if (side === "bottom") {
        view.homeX = cx;
        view.homeY = cy + (ROWS / 2 + 0.55) * gap;
      } else {
        view.homeX = side === "left" ? cx - column : cx + column;
        view.homeY = cy + (row - (ROWS - 1) / 2) * gap - gap * 0.35;
      }
    }

    this.heading.style.left = `${cx}px`;
  }

  // --- rendering ------------------------------------------------------------------

  private renderAll(): void {
    this.renderSlots();
    this.renderPack();
    this.renderSatchel();
    this.renderAbilities();
    this.renderHeading();
    this.renderSummary();
    // A tooltip open over something that just changed would be describing
    // what used to be there.
    if (this.hovered) {
      const still = this.hovered.from === "pack"
        ? this.profile.inventory.includes(this.hovered.item.key)
        : this.profile.equipment[this.hovered.from] === this.hovered.item.key;
      if (!still) this.unhover();
    }
  }

  private renderSlots(): void {
    for (const [slot, view] of this.slotViews) {
      const item = this.wornItem(slot);
      const side = view.placement.side;
      view.el.className = `char-slot ${side}${item ? ` filled ${item.rarity}` : " empty"}`;
      view.el.draggable = item !== undefined;
      view.el.style.setProperty("--rarity", item ? rarityHex(item.rarity) : "");
      view.glyph.innerHTML = glyphSvg(item ? glyphFor(item.gear, item.family) : glyphFor(gearOf(slot), undefined));
      view.level.textContent = item ? String(item.requiredLevel) : "";
      view.label.innerHTML = item
        ? `<b>${escapeHtml(item.name)}</b><small>${SLOT_NAMES[slot]}</small>`
        : `<small>${SLOT_NAMES[slot]}</small>`;

      view.line.style.stroke = item ? rarityHex(item.rarity) : "";
      view.dot.style.fill = item ? rarityHex(item.rarity) : "";
    }
  }

  private renderPack(): void {
    // Grow for an overfull bag, and shrink back as it empties.
    const wanted = Math.max(INVENTORY_SIZE, this.profile.inventory.length);
    this.ensureCells(wanted);
    while (this.packGrid.children.length > wanted) this.packGrid.lastElementChild?.remove();
    const cells = this.packGrid.children;
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i] as HTMLElement;
      const key = this.profile.inventory[i];
      const item = key !== undefined ? describeItem(key) : undefined;
      if (!item) {
        cell.className = "pack-cell empty";
        cell.draggable = false;
        cell.innerHTML = "";
        cell.style.removeProperty("--rarity");
        continue;
      }
      // Too high to wear yet, or another class's: kept, dimmed, with its level
      // in red — something to grow into, or to sell.
      const tooHigh = !canWear(item, this.wearer);
      cell.className = `pack-cell ${item.rarity}${this.fresh.has(item.key) ? " fresh" : ""}${tooHigh ? " too-high" : ""}`;
      cell.draggable = true;
      cell.style.setProperty("--rarity", rarityHex(item.rarity));
      cell.innerHTML = `${glyphSvg(glyphFor(item.gear, item.family))}<span class="lvl">${item.requiredLevel}</span>`;
    }
    this.packCount.textContent = `${this.profile.inventory.length} / ${INVENTORY_SIZE}`;
    this.packCount.classList.toggle("full", this.profile.inventory.length >= INVENTORY_SIZE);
  }

  private renderHeading(): void {
    const power = this.power;
    const { level, classId } = this.profile;
    this.heading.innerHTML =
      `<div class="char-name">${escapeHtml(this.name)}</div>` +
      `<div class="char-class">Level ${level} ${escapeHtml(CLASSES[classId].name)}</div>` +
      `<div class="char-power"><span>Power</span> ${power}</div>`;
  }

  /** What the character adds up to — class and level, and gear — and what
   *  it is actually worth. */
  private renderSummary(): void {
    const { totals, heavyPieces } = characterStats(this.profile.equipment, this.wearer);
    const level = this.profile.level;
    const resource = CLASSES[this.profile.classId].resource;
    // Only the attributes this class gets anything from: its gear rolls
    // nothing else, so a row of zeros would only ask a question.
    const uses = CLASSES[this.profile.classId].stats;
    const rows: Array<[string, string, string?] | false> = [
      ["Health", String(maxHealthFor(totals))],
      resource === "fervour"
        ? ["Fervour", String(maxResourceFor(resource, totals)), `Up to +${Math.round(FERVOUR_DAMAGE_BONUS * 100)}% damage when full`]
        : ["Mana", String(maxResourceFor(resource, totals))],
      ["Might", String(totals.might), "Adds to weapon blows"],
      uses.includes("focus") && ["Focus", String(totals.focus), "Adds to spells that cost mana"],
      ["Vigour", String(totals.vigour), "Health, three per point"],
      uses.includes("spirit") && ["Spirit", String(totals.spirit), "Mana, and how fast it returns"],
      ["Critical", `${percent(critChanceFor(totals))}%`],
      ["Armour", `${totals.armour}`, `Stops ${percent(armourReduction(totals.armour, level))}% of a blow from a level-${level} creature`],
      ["Recovery", `+${percent(recoveryMultiplier(totals.recovery) - 1)}%`],
      ["Leech", `${percent(leechFraction(totals.leech))}%`],
    ];
    this.summary.innerHTML =
      rows.filter((row): row is [string, string, string?] => row !== false).map(([label, value, note]) =>
        `<div class="row"${note ? ` title="${escapeHtml(note)}"` : ""}><span>${label}</span><b>${value}</b></div>`).join("") +
      (heavyPieces > 0 && resource === "mana" ? `<div class="warn">${heavyPieces} heavy · mana −${heavyPieces * 5}%</div>` : "");
  }

  /**
   * Trades and the satchel, together: what you are good at gathering, and
   * what you have gathered. Goods are a list rather than a grid of cells,
   * because a good has no look worth a cell of its own and its count is the
   * thing you want to read.
   */
  private renderSatchel(): void {
    const trades = TRADE_IDS.map((id) => {
      const trade = TRADES[id];
      const { level, into, toNext } = tradeProgress(this.profile.trades[id] ?? 0);
      const share = toNext === 0 ? 1 : into / toNext;
      return `<div class="trade-row" title="${escapeHtml(trade.description)}">` +
        `<b>${escapeHtml(trade.name)}</b><span class="trade-level">${level}</span>` +
        `<div class="trade-bar"><i style="width:${(share * 100).toFixed(1)}%"></i></div>` +
        `<small>${toNext === 0 ? "Mastered" : `${into} / ${toNext}`}</small></div>`;
    }).join("");
    const head = `<h4 class="satchel-heading">Trades</h4>${trades}<h4 class="satchel-heading">Satchel</h4>`;

    const goods = this.profile.goods;
    const carried = GOOD_IDS.filter((id) => (goods[id] ?? 0) > 0);
    if (carried.length === 0) {
      this.satchel.innerHTML = `${head}<p class="abilities-note">Empty. Fish you catch go here, not in your pack, and any vendor will buy them.</p>`;
      return;
    }
    this.satchel.innerHTML = head + carried.map((id) => {
      const good = GOODS[id];
      const count = goods[id] ?? 0;
      const full = count >= good.stack;
      return `<div class="good-row">` +
        `<span class="good-glyph">${glyphSvg(GOOD_GLYPHS[good.kind])}</span>` +
        `<div><b>${escapeHtml(good.name)}</b><span class="good-count${full ? " full" : ""}">${count} / ${good.stack}</span>` +
        `<p>${escapeHtml(good.lore)}</p></div>` +
        `<span class="good-price">${good.price * count} gold</span></div>`;
    }).join("") +
      `<footer><span>Worth ${goodsValue(goods)} gold to any vendor</span></footer>`;
  }

  /**
   * The spellbook: every ability the class has, in bar order, and when each
   * is learned. The road ahead as much as what you have.
   */
  private renderAbilities(): void {
    const { classId, level } = this.profile;
    const definition = CLASSES[classId];
    const resource = definition.resource === "fervour" ? "Fervour" : "mana";
    this.abilityList.innerHTML =
      `<p class="abilities-note">${escapeHtml(definition.description)}</p>` +
      definition.abilities.map(({ spell: id, level: at }) => {
        const spell = SPELLS[id];
        const known = level >= at;
        const cost = spell.kind === "passive" ? "Passive"
          : spell.hold ? `${spell.cost}–${spell.hold.fullCost} ${resource}`
            : spell.cost > 0 ? `${spell.cost} ${resource}${spell.kind === "channel" ? " a pulse" : ""}` : "Free";
        const how = spell.kind === "passive" ? ""
          : spell.castMs > 0 ? ` · ${spell.castMs / 1000}s, standing`
            : spell.kind === "hold" ? " · hold" : spell.kind === "channel" ? " · channel" : "";
        const cooldown = how + (spell.cooldownMs >= 1000 ? ` · ${spell.cooldownMs / 1000}s cooldown` : "");
        return `<div class="ability-row${known ? "" : " locked"}">` +
          `<span class="key">${at}</span>` +
          `<div><b>${escapeHtml(spell.name)}</b>` +
          `<small>${known ? `${cost}${cooldown}` : `Learned at level ${at}`}</small>` +
          `<p>${escapeHtml(spell.description)}</p></div></div>`;
      }).join("");
  }

  private showTab(tab: string): void {
    for (const button of this.tabs) button.classList.toggle("active", button.dataset["tab"] === tab);
    for (const page of this.root.querySelectorAll<HTMLElement>("[data-page]")) {
      page.hidden = page.dataset["page"] !== tab;
    }
  }

  // --- hover, tooltips, menus -------------------------------------------------------

  private hover(item: Item, from: "pack" | EquipSlot, event: PointerEvent): void {
    if (this.dragging) return;
    this.hovered = { item, from };
    this.tooltip.innerHTML = this.tooltipHtml(item, from);
    this.tooltip.style.setProperty("--rarity", rarityHex(item.rarity));
    this.tooltip.hidden = false;
    this.moveTooltip(event);
    if (from === "pack") this.highlightSlots(item);
  }

  private unhover(): void {
    this.hovered = undefined;
    this.hideTooltip();
    if (!this.dragging) this.clearHighlights();
  }

  private showEmptyTooltip(slot: EquipSlot, event: PointerEvent): void {
    const note = slot === "soul"
      ? "Very rare. A Soul grows with you, and replacing one costs you what it had become."
      : "Empty.";
    this.tooltip.innerHTML = `<div class="tt-name">${SLOT_NAMES[slot]}</div><div class="tt-lore">${note}</div>`;
    this.tooltip.style.removeProperty("--rarity");
    this.tooltip.hidden = false;
    this.moveTooltip(event);
  }

  private hideTooltip(): void {
    this.tooltip.hidden = true;
  }

  /** Beside the pointer, flipped to whichever side has room. */
  private moveTooltip(event: PointerEvent): void {
    if (this.tooltip.hidden) return;
    const width = this.tooltip.offsetWidth;
    const height = this.tooltip.offsetHeight;
    const gap = 18;
    let x = event.clientX + gap;
    if (x + width > window.innerWidth - 8) x = event.clientX - gap - width;
    const y = clamp(event.clientY - 24, 8, window.innerHeight - height - 8);
    this.tooltip.style.transform = `translate(${Math.max(8, x)}px, ${y}px)`;
  }

  /** Light the slots an item can go in, and the one a click would use. */
  private highlightSlots(item: Item): void {
    const preferred = preferredSlot(this.profile.equipment, item);
    for (const [slot, view] of this.slotViews) {
      const fits = slotsFor(item).includes(slot);
      view.el.classList.toggle("fits", fits);
      view.el.classList.toggle("target", slot === preferred);
      view.line.classList.toggle("lit", fits);
    }
  }

  private clearHighlights(): void {
    for (const view of this.slotViews.values()) {
      view.el.classList.remove("fits", "target");
      view.line.classList.remove("lit");
    }
  }

  private endDrag(): void {
    this.dragging = undefined;
    this.clearHighlights();
  }

  private showMenu(event: MouseEvent, item: Item, from: "pack" | EquipSlot): void {
    this.hideTooltip();
    const actions: Array<{ label: string; run: () => void; danger?: boolean }> = [];

    if (from === "pack") {
      const slots = slotsFor(item);
      if (slots.length === 1) {
        actions.push({ label: "Wear", run: () => this.hooks.equip(item.key, slots[0]) });
      } else {
        for (const slot of slots) {
          actions.push({ label: `Wear — ${slotLabel(slot)}`, run: () => this.hooks.equip(item.key, slot) });
        }
      }
      actions.push({ label: "Destroy…", danger: true, run: () => this.confirmDestroy(item) });
    } else {
      actions.push({ label: "Take off", run: () => this.hooks.unequip(from) });
    }

    this.menu.innerHTML = `<div class="menu-title" style="color:${rarityHex(item.rarity)}">${escapeHtml(item.name)}</div>`;
    for (const action of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action.label;
      if (action.danger) button.classList.add("danger");
      button.onclick = () => {
        // Destroy swaps the menu for a confirmation instead of closing it.
        if (!action.danger) this.hideMenu();
        action.run();
      };
      this.menu.appendChild(button);
    }
    this.placeMenu(event.clientX, event.clientY);
  }

  /** Destroying is the one thing here that cannot be undone, so it asks. */
  private confirmDestroy(item: Item): void {
    this.menu.innerHTML =
      `<div class="menu-title">Destroy <span style="color:${rarityHex(item.rarity)}">${escapeHtml(item.name)}</span>?</div>` +
      `<div class="menu-note">It will be gone for good.</div>`;
    const yes = document.createElement("button");
    yes.type = "button";
    yes.className = "danger";
    yes.textContent = "Destroy it";
    yes.onclick = () => {
      this.hideMenu();
      this.hooks.destroy(item.key);
    };
    const no = document.createElement("button");
    no.type = "button";
    no.textContent = "Keep it";
    no.onclick = () => this.hideMenu();
    this.menu.append(yes, no);
  }

  private placeMenu(x: number, y: number): void {
    this.menu.hidden = false;
    const width = this.menu.offsetWidth;
    const height = this.menu.offsetHeight;
    this.menu.style.transform =
      `translate(${clamp(x, 8, window.innerWidth - width - 8)}px, ${clamp(y, 8, window.innerHeight - height - 8)}px)`;
  }

  private hideMenu(): void {
    this.menu.hidden = true;
  }

  /**
   * The tooltip: what it is, what it gives, what level it asks, and what
   * wearing it would change. An item you cannot compare is an item you
   * cannot choose between.
   */
  private tooltipHtml(item: Item, from: "pack" | EquipSlot): string {
    const tier = RARITY[item.rarity];
    const kind = item.family ? FAMILY_NAMES[item.family] : "";
    const where = GEAR_NAMES[item.gear] + (item.twoHanded ? ", two-handed" : "");

    const lines: string[] = [];
    lines.push(`<div class="tt-name">${escapeHtml(item.name)}</div>`);
    lines.push(`<div class="tt-kind">${tier.name} ${escapeHtml(kind)} · ${where}</div>`);
    lines.push(`<div class="tt-level"><span>Item level ${item.level}</span><span>Power ${item.power}</span></div>`);

    const stats = STAT_ORDER.filter((stat) => item.stats[stat]);
    if (stats.length > 0) {
      lines.push(`<div class="tt-stats">${stats.map((stat) => {
        const secondary = stat === "crit" || stat === "recovery" || stat === "leech";
        return `<div class="${secondary ? "secondary" : ""}">+${item.stats[stat]} ${STATS[stat].name}</div>`;
      }).join("")}</div>`);
    }

    const short = !canWear(item, this.wearer);
    const low = this.profile.level < item.requiredLevel;
    lines.push(`<div class="tt-req${low ? " short" : ""}">Requires level ${item.requiredLevel}` +
      (low ? ` — you are ${this.profile.level}` : "") + `</div>`);
    if (!classCanUse(this.profile.classId, item)) {
      lines.push(`<div class="tt-req short">${escapeHtml(CLASSES[this.profile.classId].name)}s cannot use this</div>`);
    }

    lines.push(`<div class="tt-lore">“${escapeHtml(item.lore)}”</div>`);
    if (item.rarity !== "common" && item.rarity !== "uncommon" && item.rarity !== "rare") {
      lines.push(`<div class="tt-rarity">${escapeHtml(tier.description)}</div>`);
    }

    if (from === "pack") {
      lines.push(this.comparisonHtml(item));
      lines.push(`<div class="tt-hint">${short ? "Cannot wear" : "Click to wear"} · right-click for more</div>`);
    } else {
      lines.push(`<div class="tt-hint">Click to take off</div>`);
    }
    return lines.join("");
  }

  /**
   * What wearing an item you do not have yet would change — for a quest's
   * reward choices, where a list of stats on its own leaves you opening the
   * character screen to remember what you are wearing. The same comparison
   * as the tooltip, so the two can never tell you different things.
   */
  compareWorn(key: ItemKey): string {
    const item = describeItem(key);
    if (!item) return "";
    return classCanUse(this.profile.classId, item) ? this.comparisonHtml(item) : "";
  }

  /** What wearing this would change, computed through the same `wear` and
   *  `characterStats` the server uses — including anything it would displace. */
  private comparisonHtml(item: Item): string {
    const { equipment } = this.profile;
    const slot = preferredSlot(equipment, item);
    const result = wear(equipment, item, slot);
    if (!result) return "";

    const before = characterStats(equipment, this.wearer);
    const after = characterStats(result.next, this.wearer);
    const changes: string[] = [];
    const push = (label: string, delta: number) => {
      if (delta === 0) return;
      changes.push(`<span class="${delta > 0 ? "up" : "down"}">${delta > 0 ? "+" : "−"}${Math.abs(delta)} ${label}</span>`);
    };
    push("Power", after.power - before.power);
    push("Health", maxHealthFor(after.totals) - maxHealthFor(before.totals));
    for (const stat of STAT_ORDER) {
      push(STATS[stat].name, (after.totals as StatTotals)[stat] - (before.totals as StatTotals)[stat]);
    }

    const replacing = result.removed
      .map((key) => describeItem(key))
      .filter((worn): worn is Item => worn !== undefined)
      .map((worn) => `<span style="color:${rarityHex(worn.rarity)}">${escapeHtml(worn.name)}</span>`);

    return `<div class="tt-compare"><div class="tt-compare-title">${replacing.length > 0 ? `Instead of ${replacing.join(" and ")}` : `In the empty ${slotLabel(slot).toLowerCase()} slot`}</div>` +
      (changes.length > 0 ? changes.join("") : `<span>No change</span>`) + `</div>`;
  }

  // --- small helpers ---------------------------------------------------------------

  private wornItem(slot: EquipSlot): Item | undefined {
    const key = this.profile.equipment[slot];
    return key !== undefined ? describeItem(key) : undefined;
  }

  private wornSlotOf(key: ItemKey): EquipSlot | undefined {
    return EQUIP_SLOTS.find((slot) => this.profile.equipment[slot] === key);
  }
}

function gearOf(slot: EquipSlot): GearSlot {
  return slot === "ring1" || slot === "ring2" ? "ring" : slot;
}

/** Rings and daggers need to say which hand. The body faces you, so "left
 *  hand" is the one on your right — but the words are the character's. */
function slotLabel(slot: EquipSlot): string {
  switch (slot) {
    case "ring1": return "Left hand ring";
    case "ring2": return "Right hand ring";
    case "weapon": return "Main hand";
    case "offhand": return "Off hand";
    default: return SLOT_NAMES[slot];
  }
}
