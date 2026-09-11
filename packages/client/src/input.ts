/**
 * Keyboard state sampled once per simulation step. We track keys as a set of
 * held flags rather than reacting to keydown events directly, because the
 * simulation runs on a fixed step and needs to know what was held *at that
 * step* — not how many OS key-repeat events happened to fire in between.
 */

type Action = "forward" | "back" | "left" | "right" | "sprint"
  | "spell1" | "spell2" | "spell3" | "spell4" | "spell5" | "spell6";

/** How many slots the ability bar has keys for. */
export const ABILITY_KEYS = 6;

const BINDINGS: Record<string, Action> = {
  KeyW: "forward", ArrowUp: "forward",
  KeyS: "back", ArrowDown: "back",
  KeyA: "left", ArrowLeft: "left",
  KeyD: "right", ArrowRight: "right",
  // Space rather than a mouse button: left-drag already orbits the camera,
  // and a click-vs-drag distinction is a bad way to start a fight. Space
  // doubles as the first slot, Strike, so the free option is always under a
  // thumb, with 1-6 for the bar.
  Space: "spell1", Digit1: "spell1",
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
  private detach: () => void;

  constructor(target: Window = window) {
    const onKeyDown = (event: KeyboardEvent) => {
      // Typing a name into the party window is not walking. (Key-up still
      // counts, so a key held while clicking into a box is let go.)
      if ((event.target as HTMLElement | null)?.tagName === "INPUT") return;
      const action = BINDINGS[event.code];
      if (!action) return;
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

    target.addEventListener("keydown", onKeyDown as EventListener);
    target.addEventListener("keyup", onKeyUp as EventListener);
    target.addEventListener("blur", onBlur);

    this.detach = () => {
      target.removeEventListener("keydown", onKeyDown as EventListener);
      target.removeEventListener("keyup", onKeyUp as EventListener);
      target.removeEventListener("blur", onBlur);
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
   * still leaning on Space should cast Sunder.
   */
  castSlot(): number {
    for (let slot = ABILITY_KEYS; slot >= 1; slot--) {
      if (this.held.has(`spell${slot}` as Action)) return slot;
    }
    return 0;
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
