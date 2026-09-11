import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera.js";
import type { ArcRotateCameraPointersInput } from "@babylonjs/core/Cameras/Inputs/arcRotateCameraPointersInput.js";

/**
 * Action-combat mouse: the camera follows the mouse all the time, with no
 * button held, and the buttons are free to attack (left) and guard (right).
 *
 * That is the browser's pointer lock: the cursor is hidden and held still,
 * and the page gets raw movement instead, which turns the camera here — one
 * browser mouse event, one turn. (Babylon's orbit camera can do it too, but
 * its device layer reports each move twice, so its drag input is switched
 * off while the mouse is held, and back on when a cursor is out: the
 * character screen still orbits on a drag.) The rest is deciding WHEN to
 * hold the lock: whenever you are in the world, except while
 * Alt is held (a cursor, for a moment) or a window is open (the pack, the
 * map, a dialogue — anything with things to click). Closing the window takes
 * the mouse back.
 *
 * Browsers only grant a lock on a user gesture, so it is requested on a
 * click on the canvas, or right after the key or click that closed a window
 * (which counts), and never on a timer. When the game wants the mouse but
 * does not have it, a line in the middle of the screen says to click.
 *
 * Esc is the browser's own way out of a lock and cannot be taken from it, so
 * losing the lock with nothing else to explain it is treated as Esc: the
 * game menu opens.
 */
export class MouseLook {
  private altHeld = false;
  private readonly prompt = document.getElementById("mouse-prompt") as HTMLElement;
  /** Set while the game itself is letting go, so the unlock is not taken for Esc. */
  private releasing = false;
  private lastEscape = 0;
  /** Babylon's drag input, switched off while the mouse is held. */
  private dragOff = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: ArcRotateCamera,
    private readonly wants: () => boolean,
    private readonly onEscape: () => void,
  ) {
    canvas.addEventListener("mousedown", () => this.take());
    // Right-click is a guard, never a browser menu.
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    window.addEventListener("keydown", (event) => {
      if (event.code === "AltLeft" || event.code === "AltRight") {
        // Alone, Alt would focus the browser's menu bar on some systems.
        event.preventDefault();
        this.altHeld = true;
        this.sync();
      }
      if (event.code === "Escape") this.lastEscape = performance.now();
    });
    window.addEventListener("keyup", (event) => {
      if (event.code === "AltLeft" || event.code === "AltRight") {
        this.altHeld = false;
        this.sync();
      }
    });
    // Alt-tabbing away leaves Alt "held" as far as the page knows.
    window.addEventListener("blur", () => { this.altHeld = false; });
    document.addEventListener("pointerlockchange", () => this.changed());
    document.addEventListener("mousemove", (event) => this.look(event));
  }

  /** Radians of turn per pixel of mouse movement: about a quarter-turn for
   *  a comfortable sweep of the hand. */
  private static readonly TURN = 1 / 420;
  private static readonly PITCH = 1 / 520;

  /** Mouse movement while held: turn and tilt the camera. Right turns right
   *  (alpha down, in Babylon's orbit), down looks down. */
  private look(event: MouseEvent): void {
    if (!this.locked) return;
    const camera = this.camera;
    camera.alpha -= event.movementX * MouseLook.TURN;
    const beta = camera.beta - event.movementY * MouseLook.PITCH;
    camera.beta = Math.max(camera.lowerBetaLimit ?? 0.1, Math.min(camera.upperBetaLimit ?? 3, beta));
  }

  get locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  /** Whether the game should have the mouse right now. */
  private get wanted(): boolean {
    return !this.altHeld && this.wants();
  }

  /** Once a frame, and after anything that opens or closes a window: take or
   *  release the mouse to match, and show the prompt if it cannot be taken. */
  sync(): void {
    const wanted = this.wanted;
    if (!wanted && this.locked) {
      this.releasing = true;
      document.exitPointerLock();
    } else if (wanted && !this.locked && navigator.userActivation?.isActive) {
      this.take();
    }
    const show = wanted && !this.locked;
    if (this.prompt.hidden === show) this.prompt.hidden = !show;
  }

  private take(): void {
    if (!this.wanted || this.locked) return;
    // A request can reject (too soon after an Esc, no gesture); the prompt
    // stays up and the next click tries again.
    const request = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
    request?.catch?.(() => undefined);
  }

  private changed(): void {
    const pointers = this.camera.inputs.attached["pointers"] as ArcRotateCameraPointersInput | undefined;
    // Only ever put back what was taken off: attaching twice would double
    // every drag.
    if (pointers && this.locked && !this.dragOff) {
      pointers.detachControl();
      this.dragOff = true;
    } else if (pointers && !this.locked && this.dragOff) {
      pointers.attachControl(true);
      this.dragOff = false;
    }
    // No coasting while aiming: the orbit camera's inertia is pleasant for
    // a drag and hopeless for a crosshair.
    this.camera.inertia = this.locked ? 0 : 0.9;
    if (this.locked) {
      this.releasing = false;
      this.prompt.hidden = true;
      return;
    }
    // Whatever let go, the buttons it was holding are up now.
    window.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
    window.dispatchEvent(new MouseEvent("mouseup", { button: 2 }));
    const expected = this.releasing || this.altHeld || !this.wants();
    this.releasing = false;
    if (expected) return;
    // Lost it without asking: Esc, or the window losing focus (Alt-Tab),
    // which also drops a lock. Give focus a moment to settle, and only treat
    // it as Esc if the window still has it — tabbing out is not asking for
    // the menu. If the page saw the Esc itself, its handler already acted.
    window.setTimeout(() => {
      if (!document.hasFocus() || this.locked || !this.wanted) return;
      if (performance.now() - this.lastEscape > 250) this.onEscape();
    }, 120);
  }
}
