import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera.js";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.js";
import { Viewport } from "@babylonjs/core/Maths/math.viewport.js";
import type { Scene } from "@babylonjs/core/scene.js";

/**
 * Numbers that pop off whatever was hit.
 *
 * Before these, the only sign a hit had landed was a health bar a few pixels
 * shorter. A number says how much, a big yellow one says it was a critical,
 * and "Evaded" under your own feet says the dodge worked — the fight explains
 * itself as it happens.
 *
 * HTML, like the nametags, and for the same reasons: crisp at any size, styled
 * with CSS, and one transform per label per frame. Elements are pooled.
 */

export type CombatTextStyle =
  /** Damage you dealt. */
  | "dealt"
  /** A critical you dealt. */
  | "crit"
  /** Damage you took. */
  | "taken"
  /** Damage someone else dealt or took — quieter. */
  | "other"
  /** A word rather than a number: Evaded, Staggered. */
  | "note";

interface Floater {
  el: HTMLElement;
  x: number;
  y: number;
  z: number;
  start: number;
  /** Sideways drift, so a flurry of hits fans out instead of stacking. */
  drift: number;
  active: boolean;
}

const LIFETIME = 900;
const RISE = 1.1;

export class CombatText {
  private readonly pool: Floater[] = [];
  private readonly scratch = new Vector3();
  private readonly viewport = new Viewport(0, 0, 0, 0);
  private flip = 1;

  constructor(private readonly container: HTMLElement) {}

  spawn(now: number, x: number, y: number, z: number, text: string, style: CombatTextStyle): void {
    let floater = this.pool.find((candidate) => !candidate.active);
    if (!floater) {
      const el = document.createElement("div");
      this.container.appendChild(el);
      floater = { el, x: 0, y: 0, z: 0, start: 0, drift: 0, active: false };
      this.pool.push(floater);
    }
    this.flip = -this.flip;
    floater.active = true;
    floater.x = x;
    floater.y = y;
    floater.z = z;
    floater.start = now;
    floater.drift = this.flip * (12 + Math.random() * 22);
    floater.el.className = `floater ${style}`;
    floater.el.textContent = text;
    floater.el.hidden = false;
  }

  update(now: number, scene: Scene, camera: ArcRotateCamera, canvas: HTMLCanvasElement): void {
    this.viewport.width = canvas.clientWidth;
    this.viewport.height = canvas.clientHeight;
    const transform = scene.getTransformMatrix();
    const cam = camera.position;
    const fx = camera.target.x - cam.x;
    const fy = camera.target.y - cam.y;
    const fz = camera.target.z - cam.z;

    for (const floater of this.pool) {
      if (!floater.active) continue;
      const t = (now - floater.start) / LIFETIME;
      if (t >= 1) {
        floater.active = false;
        floater.el.hidden = true;
        continue;
      }
      // Fast up, then hang: reads as a pop rather than a slow elevator.
      const rise = RISE * (1 - (1 - t) * (1 - t) * (1 - t));
      const wy = floater.y + rise;
      if ((floater.x - cam.x) * fx + (wy - cam.y) * fy + (floater.z - cam.z) * fz <= 0) {
        floater.el.hidden = true;
        continue;
      }
      this.scratch.set(floater.x, wy, floater.z);
      const p = Vector3.Project(this.scratch, Matrix.IdentityReadOnly, transform, this.viewport);
      const pop = t < 0.12 ? 1.35 - t * 2.9 : 1;
      floater.el.hidden = false;
      floater.el.style.opacity = t > 0.65 ? String(1 - (t - 0.65) / 0.35) : "1";
      floater.el.style.transform =
        `translate(-50%, -50%) translate(${(p.x + floater.drift * t).toFixed(1)}px, ${p.y.toFixed(1)}px) scale(${pop.toFixed(2)})`;
    }
  }

  clear(): void {
    for (const floater of this.pool) {
      floater.active = false;
      floater.el.hidden = true;
    }
  }
}
