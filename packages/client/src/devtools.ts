import {
  LEVEL_SCALE,
  levelAt,
  MAX_LEVEL,
  RARITIES,
  RARITY,
  rarityHex,
  regionOf,
  settlementsIn,
  type OstraDefinition,
} from "@mmo/shared";
import type { World } from "./scene.js";
import type { OstraSession } from "./session.js";

/**
 * The dev menu, on the backtick key: cheats for testing.
 *
 * Only ever built in a development build (`import.meta.env.DEV`), and every
 * command it sends is one the server only listens for outside production — the
 * menu is a convenience, never the lock. Everything here goes through the
 * server like any other intent; the menu decides nothing itself, so a teleport
 * or a god mode is exactly as authoritative as walking or being hit.
 */

export interface DevHooks {
  send(command: Record<string, unknown>): void;
  session(): OstraSession | undefined;
  ostra(): OstraDefinition | undefined;
}

/** One elite, as the server reports it for the dev menu. */
export interface EliteStatus {
  id: string;
  name: string;
  level: number;
  alive: boolean;
  x: number;
  z: number;
  wakesInMs: number;
}

interface Place {
  label: string;
  x: number;
  z: number;
  /** Stand on it with the Gate armed, so it takes you through. */
  travel?: boolean;
}

/** The normal zoom-out limit, and the one the far camera allows. */
const NORMAL_FAR = 26;
const DEV_FAR = 600;

export class DevMenu {
  private readonly root: HTMLElement;
  private readonly readout: HTMLElement;
  private readonly perf: HTMLElement;
  private readonly places: HTMLSelectElement;
  private readonly lootLevel: HTMLInputElement;
  private open = false;
  private placesFor: OstraDefinition | undefined;
  private placeList: Place[] = [];
  private nextReadout = 0;

  constructor(private readonly world: World, private readonly hooks: DevHooks) {
    this.root = document.createElement("div");
    this.root.id = "dev";
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="dev-head"><b>Dev</b><span>\` to close · development builds only</span></div>
      <section>
        <h4>Where</h4>
        <div class="dev-readout"></div>
        <button type="button" data-act="pick" class="wide primary">Teleport — click the map</button>
        <div class="row"><select class="dev-places"></select><button type="button" data-act="place">Go</button></div>
        <div class="row">
          <input type="number" class="dev-x" placeholder="x" step="10">
          <input type="number" class="dev-z" placeholder="z" step="10">
          <button type="button" data-act="xz">Go</button>
        </div>
        <button type="button" data-act="copy" class="wide">Copy position</button>
      </section>
      <section>
        <h4>You</h4>
        <div class="row">
          <button type="button" data-act="heal">Heal</button>
          <label><input type="checkbox" data-act="god"> God mode</label>
        </div>
        <div class="row">
          <input type="number" class="dev-char-level" value="10" min="1" max="${MAX_LEVEL}" step="1">
          <button type="button" data-act="setLevel">Set level</button>
        </div>
        <div class="row">
          <input type="number" class="dev-xp" value="1000" min="1" step="100">
          <button type="button" data-act="giveXp" title="As if earned: levels up, with the banner">Give XP</button>
        </div>
      </section>
      <section>
        <h4>Loot</h4>
        <div class="row">
          <label>Item level <input type="number" class="dev-level" value="30" min="1" max="1000" step="5"></label>
          <button type="button" data-act="here" title="The level creatures drop where you stand">Here</button>
        </div>
        <div class="dev-rarities"></div>
        <div class="row">
          <button type="button" data-act="scatter">Scatter one of each</button>
          <button type="button" data-act="clear">Empty bag</button>
          <button type="button" data-act="goods">Ten of every good</button>
        </div>
      </section>
      <section>
        <h4>Quests</h4>
        <div class="row">
          <button type="button" data-act="questsFinish" title="Complete every objective of every quest under way">Finish objectives</button>
          <button type="button" data-act="questsReset" title="Forget every quest, done or not">Reset all</button>
        </div>
      </section>
      <section>
        <h4>Elites</h4>
        <div class="row">
          <button type="button" data-act="elites">Refresh</button>
          <button type="button" data-act="respawnElites" title="Fallen elites wake on the next check">Respawn fallen</button>
        </div>
        <div class="dev-elites"></div>
      </section>
      <section>
        <h4>World</h4>
        <button type="button" data-act="kill" class="wide">Kill everything within 25 m</button>
        <div class="row">
          <label><input type="checkbox" data-act="far"> Far camera</label>
          <label><input type="checkbox" data-act="nohud"> Hide HUD</label>
        </div>
        <div class="dev-perf"></div>
      </section>
    `;
    document.body.appendChild(this.root);

    this.readout = this.root.querySelector(".dev-readout") as HTMLElement;
    this.perf = this.root.querySelector(".dev-perf") as HTMLElement;
    this.places = this.root.querySelector(".dev-places") as HTMLSelectElement;
    this.lootLevel = this.root.querySelector(".dev-level") as HTMLInputElement;

    const rarities = this.root.querySelector(".dev-rarities") as HTMLElement;
    for (const rarity of RARITIES) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = RARITY[rarity].name;
      button.title = `Put one ${RARITY[rarity].name.toLowerCase()} item in your bag`;
      button.style.setProperty("--rarity", rarityHex(rarity));
      button.onclick = () => this.hooks.send({ cmd: "give", rarity, level: this.level(), count: 1 });
      rarities.appendChild(button);
    }

    this.root.addEventListener("click", (event) => {
      const act = (event.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset["act"];
      if (act) this.act(act, event.target as HTMLElement);
    });
    // Typing a number into a field must not also cast the spell on that key:
    // the simulation's keyboard listens on the window.
    this.root.addEventListener("keydown", (event) => {
      if (event.code !== "Backquote") event.stopPropagation();
    });
  }

  get isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    this.open = !this.open;
    this.root.hidden = !this.open;
    if (this.open) this.refreshPlaces();
  }

  /** Once per frame; cheap, and only does anything while open. */
  update(now: number): void {
    if (!this.open || now < this.nextReadout) return;
    this.nextReadout = now + 200;
    this.refreshPlaces();

    const session = this.hooks.session();
    const ostra = this.hooks.ostra();
    if (!session || !ostra) {
      this.readout.textContent = "Not in an Ostra.";
      return;
    }
    const { x, y, z } = session.selfPosition();
    const region = regionOf(ostra, x, z)?.name ?? "the wilds";
    this.readout.innerHTML =
      `<b>${Math.round(x)}, ${Math.round(z)}</b> · height ${y.toFixed(1)}<br>` +
      `${ostra.name} · ${region} · creature level ${levelAt(ostra, x, z)}`;

    const scene = this.world.scene;
    // Infinite when frames are being driven by hand rather than by the browser.
    const fps = this.world.engine.getFps();
    this.perf.textContent =
      `${Number.isFinite(fps) ? Math.round(fps) : "—"} fps · ${scene.getActiveMeshes().length} active / ${scene.meshes.length} meshes`;
  }

  private level(): number {
    const value = Number(this.lootLevel.value);
    return Number.isFinite(value) && value >= 1 ? Math.round(value) : 30;
  }

  private act(act: string, target: HTMLElement): void {
    const session = this.hooks.session();
    switch (act) {
      case "pick":
        session?.pickOnMap((x, z) => this.hooks.send({ cmd: "teleport", x, z }));
        break;
      case "place": {
        const place = this.placeList[Number(this.places.value)];
        if (place) this.hooks.send({ cmd: "teleport", x: place.x, z: place.z, travel: place.travel === true });
        break;
      }
      case "xz": {
        const x = Number((this.root.querySelector(".dev-x") as HTMLInputElement).value);
        const z = Number((this.root.querySelector(".dev-z") as HTMLInputElement).value);
        if (Number.isFinite(x) && Number.isFinite(z)) this.hooks.send({ cmd: "teleport", x, z });
        break;
      }
      case "copy": {
        const position = session?.selfPosition();
        if (position) void navigator.clipboard?.writeText(`${Math.round(position.x)}, ${Math.round(position.z)}`);
        break;
      }
      case "heal":
        this.hooks.send({ cmd: "heal" });
        break;
      case "god":
        this.hooks.send({ cmd: "god", on: (target as HTMLInputElement).checked });
        break;
      case "setLevel": {
        const value = Number((this.root.querySelector(".dev-char-level") as HTMLInputElement).value);
        if (Number.isFinite(value)) this.hooks.send({ cmd: "level", value });
        break;
      }
      case "giveXp": {
        const amount = Number((this.root.querySelector(".dev-xp") as HTMLInputElement).value);
        if (Number.isFinite(amount)) this.hooks.send({ cmd: "xp", amount });
        break;
      }
      case "here": {
        const ostra = this.hooks.ostra();
        const position = session?.selfPosition();
        if (ostra && position) this.lootLevel.value = String(levelAt(ostra, position.x, position.z) * LEVEL_SCALE);
        break;
      }
      case "scatter":
        this.hooks.send({ cmd: "scatter", level: this.level(), spread: 3 });
        break;
      case "clear":
        this.hooks.send({ cmd: "clearBag" });
        break;
      case "goods":
        this.hooks.send({ cmd: "goods", count: 10 });
        break;
      case "kill":
        this.hooks.send({ cmd: "killNear", radius: 25 });
        break;
      case "elites":
        this.hooks.send({ cmd: "elites" });
        break;
      case "questsFinish":
      case "questsReset":
        this.hooks.send({ cmd: act });
        break;
      case "respawnElites":
        this.hooks.send({ cmd: "respawnElites" });
        window.setTimeout(() => this.hooks.send({ cmd: "elites" }), 700);
        break;
      case "goElite": {
        const x = Number(target.dataset["x"]);
        const z = Number(target.dataset["z"]);
        // Beside it, not on top of it.
        if (Number.isFinite(x) && Number.isFinite(z)) this.hooks.send({ cmd: "teleport", x: x + 8, z: z + 8 });
        break;
      }
      case "far": {
        const far = (target as HTMLInputElement).checked;
        const camera = this.world.camera;
        camera.upperRadiusLimit = far ? DEV_FAR : NORMAL_FAR;
        if (!far && camera.radius > NORMAL_FAR) {
          camera.radius = NORMAL_FAR;
          this.world.preferredRadius = NORMAL_FAR;
        }
        break;
      }
      case "nohud":
        document.body.classList.toggle("no-hud", (target as HTMLInputElement).checked);
        break;
    }
  }

  /** The server's answer to "elites": each one, alive or how long until it wakes. */
  showElites(list: EliteStatus[]): void {
    const host = this.root.querySelector(".dev-elites") as HTMLElement;
    if (list.length === 0) {
      host.textContent = "None in this Ostra.";
      return;
    }
    host.innerHTML = list.map((elite) => {
      const seconds = Math.ceil(elite.wakesInMs / 1000);
      const status = elite.alive
        ? `<span class="alive">alive</span>`
        : `wakes in ${Math.floor(seconds / 60)}m ${seconds % 60}s`;
      return `<div class="dev-elite"><span>${escapeHtml(elite.name)} · ${elite.level}<small>${status}</small></span>` +
        `<button type="button" data-act="goElite" data-x="${elite.x}" data-z="${elite.z}">Go</button></div>`;
    }).join("");
  }

  /** Every named place in the current Ostra, rebuilt when the Ostra changes. */
  private refreshPlaces(): void {
    const ostra = this.hooks.ostra();
    if (!ostra || ostra === this.placesFor) return;
    this.placesFor = ostra;

    const list: Place[] = [{ label: "The spawn point", x: ostra.spawn.x, z: ostra.spawn.z }];
    for (const settlement of settlementsIn(ostra)) list.push({ label: settlement.name, x: settlement.x, z: settlement.z });
    for (const stone of ostra.waystones) list.push({ label: stone.name, x: stone.x, z: stone.z });
    for (const ruin of ostra.ruins) list.push({ label: `${ruin.name} (ruin)`, x: ruin.x, z: ruin.z });
    for (const gate of ostra.gates) list.push({ label: `${gate.label} — step through`, x: gate.x, z: gate.z, travel: true });

    this.placeList = list;
    this.places.innerHTML = list.map((place, index) => `<option value="${index}">${escapeHtml(place.label)}</option>`).join("");
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char] as string));
}
