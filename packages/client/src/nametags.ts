import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera.js";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.js";
import { Viewport } from "@babylonjs/core/Maths/math.viewport.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { PLAYER_SIZE } from "@mmo/shared";

/**
 * Names floating above players, drawn as HTML rather than in the 3D scene.
 *
 * Babylon's GUI package would work, but it renders text into a texture: another
 * dependency, and text that goes soft when the camera is close. Projecting the
 * world position to screen coordinates and moving a `<div>` keeps the text at
 * native resolution, styles with ordinary CSS, and costs one transform per
 * player per frame.
 */

/** Beyond this the label is clutter rather than information. */
const MAX_DISTANCE = 45;

/** A quest mark over a villager is seen from much further than a name. */
const MARKER_DISTANCE = 140;

/** Default height above a body's feet to float the label. Creatures pass
 *  their own, since a spider is a fraction of a player's height. */
const DEFAULT_HEIGHT = PLAYER_SIZE + 0.55;

export interface NametagTarget {
  sessionId: string;
  x: number;
  y: number;
  z: number;
  /** Overrides DEFAULT_HEIGHT. */
  height?: number;
  /** Overrides MAX_DISTANCE — landmarks want to be readable from further. */
  maxDistance?: number;
}

/** Which styling a label gets. `hunting` is how you tell, at a glance,
 *  that something has noticed you. */
export type NametagVariant = "self" | "player" | "hostile" | "hunting" | "dead" | "villager" | "waystone" | "targeted";

export class Nametags {
  private readonly container: HTMLElement;
  private readonly tags = new Map<string, HTMLElement>();
  private readonly bars = new Map<string, HTMLElement>();
  // Reused every frame; projecting allocates otherwise, 60 times a second.
  private readonly scratch = new Vector3();
  private readonly viewport = new Viewport(0, 0, 0, 0);
  /** Labels drawn this frame; reused. */
  private readonly seen = new Set<string>();

  constructor(container: HTMLElement) {
    this.container = container;
  }

  add(
    sessionId: string,
    name: string,
    colour: number,
    variant: NametagVariant,
    withHealth = false,
    /** A rare elite: drawn gold, and kept that way through variant changes. */
    elite = false,
  ): void {
    this.remove(sessionId);

    const tag = document.createElement("div");
    tag.className = `nametag ${variant}`;
    if (elite) tag.dataset["elite"] = "";
    tag.style.setProperty("--tag-colour", `#${colour.toString(16).padStart(6, "0")}`);
    tag.hidden = true;

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = name;
    tag.appendChild(label);

    if (withHealth) {
      const bar = document.createElement("span");
      bar.className = "bar";
      const fill = document.createElement("i");
      bar.appendChild(fill);
      tag.appendChild(bar);
      this.bars.set(sessionId, fill);
    }

    this.container.appendChild(tag);
    this.tags.set(sessionId, tag);
  }

  /**
   * A quest's "!" or "?", large, over the name. Empty removes it.
   *
   * It used to be a 14px character before the name, visible from as far as
   * the name was — 45 m — which in a town of lit windows and lanterns is a
   * mark you find by reading every label. Now it floats over the head, bobs,
   * and is seen from `MARKER_DISTANCE`, alone, before the name is readable:
   * the thing to walk towards should be what you see first.
   */
  setMarker(sessionId: string, marker: string): void {
    const tag = this.tags.get(sessionId);
    if (!tag) return;
    let mark = tag.querySelector<HTMLElement>(".marker");
    if (!marker) {
      mark?.remove();
      delete tag.dataset["marked"];
      return;
    }
    if (!mark) {
      mark = document.createElement("span");
      mark.className = "marker";
      tag.prepend(mark);
    }
    mark.textContent = marker;
    const kind = marker === "?" ? "ready" : marker === "!" ? "offer" : "underway";
    mark.dataset["kind"] = kind;
    // Only work to take or hand in is worth seeing from across town.
    if (kind === "underway") delete tag.dataset["marked"];
    else tag.dataset["marked"] = "";
  }

  /** A small sign under the name: what someone does ("Shop"). */
  setRole(sessionId: string, role: string): void {
    const tag = this.tags.get(sessionId);
    if (!tag) return;
    let badge = tag.querySelector<HTMLElement>(".role");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "role";
      tag.querySelector(".label")?.after(badge);
    }
    badge.textContent = role;
  }

  /**
   * The level after the name. `colour` is for creatures, whose level is a
   * warning — tinted by how it compares to yours (`difficultyOf`); players'
   * are left plain. Only call when it changes; this touches the DOM.
   */
  setLevel(sessionId: string, level: number, colour?: string): void {
    const tag = this.tags.get(sessionId);
    if (!tag) return;
    let badge = tag.querySelector<HTMLElement>(".level");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "level";
      tag.querySelector(".label")?.after(badge);
    }
    badge.textContent = String(level);
    badge.style.color = colour ?? "";
  }

  /** @param fraction 0..1. Only call when it changes; this touches the DOM. */
  setHealth(sessionId: string, fraction: number): void {
    const fill = this.bars.get(sessionId);
    if (fill) fill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  }

  /** Restyle an existing label. Cheap enough to call per frame, but the
   *  caller should only call it when the variant actually changed. */
  setVariant(sessionId: string, variant: NametagVariant): void {
    const tag = this.tags.get(sessionId);
    if (!tag) return;
    const targeted = tag.classList.contains("targeted");
    tag.className = `nametag ${variant}${targeted ? " targeted" : ""}`;
  }

  /** Mark the label of whatever you have selected. */
  setTargeted(sessionId: string, targeted: boolean): void {
    this.tags.get(sessionId)?.classList.toggle("targeted", targeted);
  }

  /**
   * Something said aloud, over the speaker's head for a few seconds. Longer
   * lines stay up longer; a new line replaces the last.
   */
  say(sessionId: string, text: string): void {
    const tag = this.tags.get(sessionId);
    if (!tag) return;
    tag.querySelector(".bubble")?.remove();
    const bubble = document.createElement("span");
    bubble.className = "bubble";
    bubble.textContent = text;
    tag.appendChild(bubble);
    window.setTimeout(() => bubble.remove(), 4000 + Math.min(6000, text.length * 60));
  }

  /** Mark a player who is in your party. */
  setParty(sessionId: string, inParty: boolean): void {
    this.tags.get(sessionId)?.classList.toggle("party", inParty);
  }

  remove(sessionId: string): void {
    this.tags.get(sessionId)?.remove();
    this.tags.delete(sessionId);
    this.bars.delete(sessionId);
  }

  clear(): void {
    for (const tag of this.tags.values()) tag.remove();
    this.tags.clear();
    this.bars.clear();
  }

  /**
   * Reposition every label. `targets` carries the same rendered positions the
   * meshes were just given, so a label never lags the cube it belongs to.
   */
  update(
    scene: Scene,
    camera: ArcRotateCamera,
    canvas: HTMLCanvasElement,
    targets: Iterable<NametagTarget>,
  ): void {
    // Project into CSS pixels, not render pixels: on a HiDPI screen the canvas
    // backing store is larger than its layout box, and using it here would put
    // every label at twice its correct offset.
    this.viewport.width = canvas.clientWidth;
    this.viewport.height = canvas.clientHeight;

    const transform = scene.getTransformMatrix();
    const cameraPosition = camera.position;
    // Camera forward, for the behind-us test. An ArcRotateCamera always looks
    // at its target, so this needs no trigonometry.
    const forwardX = camera.target.x - cameraPosition.x;
    const forwardY = camera.target.y - cameraPosition.y;
    const forwardZ = camera.target.z - cameraPosition.z;

    // A label nobody asked for this frame (its body is past draw distance —
    // after a teleport or waking at a far waystone, say) must go, not stay
    // pinned wherever it was last drawn.
    const seen = this.seen;
    seen.clear();
    for (const target of targets) {
      const tag = this.tags.get(target.sessionId);
      if (!tag) continue;
      seen.add(target.sessionId);

      const worldY = target.y + (target.height ?? DEFAULT_HEIGHT);
      const toX = target.x - cameraPosition.x;
      const toY = worldY - cameraPosition.y;
      const toZ = target.z - cameraPosition.z;

      // Points behind the camera still project to a screen position — a
      // mirrored, nonsensical one. Drop them before projecting.
      const facing = toX * forwardX + toY * forwardY + toZ * forwardZ;
      const range = Math.hypot(toX, toY, toZ);
      // Past the name's own reach, a quest mark still shows, alone.
      const distant = range > (target.maxDistance ?? MAX_DISTANCE);
      if (facing <= 0 || (distant && !(tag.dataset["marked"] !== undefined && range <= MARKER_DISTANCE))) {
        if (!tag.hidden) tag.hidden = true;
        continue;
      }
      if (tag.classList.contains("distant") !== distant) tag.classList.toggle("distant", distant);

      this.scratch.set(target.x, worldY, target.z);
      const projected = Vector3.Project(
        this.scratch,
        Matrix.IdentityReadOnly,
        transform,
        this.viewport,
      );

      if (tag.hidden) tag.hidden = false;
      tag.style.transform =
        `translate(-50%, -100%) translate(${projected.x.toFixed(1)}px, ${projected.y.toFixed(1)}px)`;
    }
    for (const [id, tag] of this.tags) {
      if (!seen.has(id) && !tag.hidden) tag.hidden = true;
    }
  }
}
