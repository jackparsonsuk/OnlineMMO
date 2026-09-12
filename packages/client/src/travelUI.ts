import {
  attunedIn,
  DIFFICULTY_COLOUR,
  difficultyOf,
  regionOf,
  WAYSTONE_USE_RANGE,
  type OstraDefinition,
  type WaystoneDefinition,
} from "@mmo/shared";

/**
 * Waystone travel (E at a stone): the stones you have woken, and one click to
 * stand at any of them.
 *
 * It decides nothing. The server checks that you are at a stone, that the one
 * you asked for is woken, and that you are not in a fight; this window only
 * asks. The combat case is checked here too, because a request that vanishes
 * without explanation is worse than a greyed-out button that says why.
 *
 * Nearest first, so the list reads outwards from where you stand and the
 * distances make a road trip rather than a phone book.
 */

export interface TravelHooks {
  travel(id: string): void;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char] as string));
}

/** "700 m", "1.4 km" — the same rounding the compass uses. */
function distanceWord(metres: number): string {
  return metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres)} m`;
}

export class TravelUI {
  private readonly panel: HTMLElement;
  private ostra: OstraDefinition | undefined;
  private attuned: readonly string[] = [];
  private level = 1;
  /** The stone you are standing at, and where you stand — set on open and
   *  kept fresh, so walking away closes the window. */
  private at: WaystoneDefinition | undefined;
  private x = 0;
  private z = 0;
  private inCombat = false;

  constructor(private readonly hooks: TravelHooks) {
    this.panel = document.createElement("div");
    this.panel.id = "travel";
    this.panel.hidden = true;
    document.body.appendChild(this.panel);
    // A click in the panel must not also cast the spell on that key.
    this.panel.addEventListener("keydown", (event) => event.stopPropagation());
    this.panel.addEventListener("click", (event) => this.onClick(event));
  }

  get isOpen(): boolean {
    return !this.panel.hidden;
  }

  /** Which Ostra's stones these are. Cleared between rooms. */
  setOstra(ostra: OstraDefinition | undefined): void {
    this.ostra = ostra;
    this.close();
  }

  /** The woken list, whenever the server says it changed. */
  setAttuned(attuned: readonly string[]): void {
    this.attuned = attuned;
    if (this.isOpen) this.render();
  }

  setLevel(level: number): void {
    if (level === this.level) return;
    this.level = level;
    if (this.isOpen) this.render();
  }

  open(stone: WaystoneDefinition): void {
    if (!this.ostra) return;
    this.at = stone;
    this.panel.hidden = false;
    this.render();
  }

  /** Esc. Returns whether it was open. */
  close(): boolean {
    const was = this.isOpen;
    this.panel.hidden = true;
    this.at = undefined;
    return was;
  }

  /** Once per frame: walk away from the stone and the window closes, and a
   *  fight that starts while it is open greys it out rather than failing. */
  update(x: number, z: number, inCombat: boolean): void {
    this.x = x;
    this.z = z;
    if (!this.isOpen) {
      this.inCombat = inCombat;
      return;
    }
    const at = this.at;
    if (at && Math.hypot(at.x - x, at.z - z) > WAYSTONE_USE_RANGE + 1.5) {
      this.close();
      return;
    }
    if (inCombat !== this.inCombat) {
      this.inCombat = inCombat;
      this.render();
    }
  }

  private render(): void {
    const ostra = this.ostra;
    const at = this.at;
    if (!ostra || !at) return;

    const woken = attunedIn(ostra, this.attuned)
      .map((stone) => ({ stone, away: Math.hypot(stone.x - this.x, stone.z - this.z) }))
      .sort((a, b) => a.away - b.away);

    const rows = woken.map(({ stone, away }) => {
      const here = stone.id === at.id;
      const region = regionOf(ostra, stone.x, stone.z);
      const band = region?.levels;
      const colour = band
        ? DIFFICULTY_COLOUR[difficultyOf(Math.round((band[0] + band[1]) / 2), this.level)]
        : "#8b98a5";
      const where = region
        ? `${escapeHtml(region.name)}${band ? ` · levels ${band[0]}–${band[1]}` : ""}`
        : escapeHtml(ostra.name);
      const cannot = here || this.inCombat;
      return `<button type="button" class="travel-row${here ? " here" : ""}" data-id="${escapeHtml(stone.id)}"` +
        `${cannot ? " disabled" : ""}><i>◆</i>` +
        `<span><b>${escapeHtml(stone.name)}</b><small style="color:${colour}">${where}</small></span>` +
        `<em>${here ? "you are here" : distanceWord(away)}</em></button>`;
    }).join("");

    const total = ostra.waystones.length;
    const note = this.inCombat
      ? `<p class="travel-note warn">Not while you are fighting.</p>`
      : woken.length < total
        ? `<p class="travel-note">Stones wake when you walk up to them — ${woken.length} of ${total} so far.</p>`
        : `<p class="travel-note">Every stone on ${escapeHtml(ostra.name)} is woken.</p>`;

    this.panel.innerHTML =
      `<header><b>${escapeHtml(at.name)}</b><span>Waystone</span>` +
      `<button type="button" data-act="close" title="Close (Esc)">×</button></header>` +
      (woken.length > 0
        ? `<div class="travel-rows">${rows}</div>`
        : `<p class="quest-none">This is the first stone you have woken. Find others and you can return to them from here.</p>`) +
      note;
  }

  private onClick(event: Event): void {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-act], [data-id]");
    if (!target) return;
    if (target.dataset["act"] === "close") {
      this.close();
      return;
    }
    const id = target.dataset["id"];
    if (!id || this.inCombat) return;
    this.hooks.travel(id);
    this.close();
  }
}
