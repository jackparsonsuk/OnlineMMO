/**
 * Keyboard state sampled once per simulation step. We track keys as a set of
 * held flags rather than reacting to keydown events directly, because the
 * simulation runs on a fixed step and needs to know what was held *at that
 * step* — not how many OS key-repeat events happened to fire in between.
 */

type Action = "forward" | "back" | "left" | "right" | "sprint" | "jump" | "dodge" | "heal" | "guard"
  | "spell1" | "spell2" | "spell3" | "spell4" | "spell5" | "spell6";

/** How many slots the ability bar has keys for. */
export const ABILITY_KEYS = 6;

const BINDINGS: Record<string, Action> = {
  KeyW: "forward", ArrowUp: "forward",
  KeyS: "back", ArrowDown: "back",
  KeyA: "left", ArrowLeft: "left",
  KeyD: "right", ArrowRight: "right",
  // Space jumps, as it does in every game with a jump. The mouse's left
  // button is Strike and its right the guard (see the mouse handlers below);
  // the rest of the bar is 2-6, under the fingers that are not steering, and
  // 1 still swings for anyone who reaches for it.
  Space: "jump",
  KeyQ: "dodge",
  KeyR: "heal",
  Digit1: "spell1",
  Digit2: "spell2",
  Digit3: "spell3",
  Digit4: "spell4",
  Digit5: "spell5",
  Digit6: "spell6",
  // Out of combat only — the server decides, the client predicts the same.
  ShiftLeft: "sprint", ShiftRight: "sprint",
};

export interface MoveAxes {
  /** -1 left, +1 right. */
  x: -1 | 0 | 1;
  /** -1 back, +1 forward. */
  z: -1 | 0 | 1;
}

export class KeyboardInput {
  private held = new Set<string>();
  /** A dodge is one press, not a held key: set on keydown, taken by the
   *  next input step. Holding Q should not dodge again the moment it can. */
  private dodgeQueued = false;
  /** A right-click since the last step asked, for a class that dodges on it. */
  private guardQueued = false;
  private detach: () => void;

  constructor(target: Window = window) {
    const onKeyDown = (event: KeyboardEvent) => {
      // Typing a name into the party window is not walking. (Key-up still
      // counts, so a key held while clicking into a box is let go.)
      if ((event.target as HTMLElement | null)?.tagName === "INPUT") return;
      const action = BINDINGS[event.code];
      if (!action) return;
      if (action === "dodge" && !event.repeat) this.dodgeQueued = true;
      this.held.add(action);
      // Stop the arrow keys scrolling the page out from under the canvas.
      event.preventDefault();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      const action = BINDINGS[event.code];
      if (action) this.held.delete(action);
    };

    // Losing focus mid-stride would otherwise leave a key stuck down and the
    // cube walking into a wall forever.
    const onBlur = () => this.held.clear();

    // The mouse's buttons are combat only while the game holds the mouse
    // (`MouseLook`): with a cursor out, a click is for the thing under it.
    // Let go whenever, though, so a button held as the lock drops is not
    // left down.
    const onMouseDown = (event: MouseEvent) => {
      if (!document.pointerLockElement) return;
      if (event.button === 0) this.held.add("spell1");
      if (event.button === 2) {
        this.held.add("guard");
        this.guardQueued = true;
      }
    };
    const onMouseUp = (event: MouseEvent) => {
      if (event.button === 0) this.held.delete("spell1");
      if (event.button === 2) this.held.delete("guard");
    };

    target.addEventListener("keydown", onKeyDown as EventListener);
    target.addEventListener("keyup", onKeyUp as EventListener);
    target.addEventListener("blur", onBlur);
    target.addEventListener("mousedown", onMouseDown as EventListener);
    target.addEventListener("mouseup", onMouseUp as EventListener);

    this.detach = () => {
      target.removeEventListener("keydown", onKeyDown as EventListener);
      target.removeEventListener("keyup", onKeyUp as EventListener);
      target.removeEventListener("blur", onBlur);
      target.removeEventListener("mousedown", onMouseDown as EventListener);
      target.removeEventListener("mouseup", onMouseUp as EventListener);
    };
  }

  axes(): MoveAxes {
    const x = (this.held.has("right") ? 1 : 0) - (this.held.has("left") ? 1 : 0);
    const z = (this.held.has("forward") ? 1 : 0) - (this.held.has("back") ? 1 : 0);
    return { x: x as -1 | 0 | 1, z: z as -1 | 0 | 1 };
  }

  /**
   * Which ability slot is held, 1-based; 0 for none. Held rather than
   * edge-triggered — the server gates each ability on its own cooldown and
   * cost, so holding a key auto-repeats and spamming it gains nothing.
   *
   * A higher slot wins when several are held: reaching for Sunder while
   * still leaning on 1 should cast Sunder.
   */
  castSlot(): number {
    for (let slot = ABILITY_KEYS; slot >= 1; slot--) {
      if (this.held.has(`spell${slot}` as Action)) return slot;
    }
    return 0;
  }

  jumping(): boolean {
    return this.held.has("jump");
  }

  healing(): boolean {
    return this.held.has("heal");
  }

  /** Right button held: a guard, for a class that blocks. */
  guardHeld(): boolean {
    return this.held.has("guard");
  }

  /** Whether the right button was pressed since the last step asked — a
   *  dodge, for a class whose guard is one. */
  takeGuard(): boolean {
    const queued = this.guardQueued;
    this.guardQueued = false;
    return queued;
  }

  /** Whether a dodge was pressed since the last step asked. */
  takeDodge(): boolean {
    const queued = this.dodgeQueued;
    this.dodgeQueued = false;
    return queued;
  }

  /** Shift held. Whether it is honoured is up to the simulation. */
  sprinting(): boolean {
    return this.held.has("sprint");
  }

  dispose(): void {
    this.detach();
    this.held.clear();
  }
}
