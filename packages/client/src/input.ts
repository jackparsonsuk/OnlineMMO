/**
 * Keyboard state sampled once per simulation step. We track keys as a set of
 * held flags rather than reacting to keydown events directly, because the
 * simulation runs on a fixed step and needs to know what was held *at that
 * step* — not how many OS key-repeat events happened to fire in between.
 */

const BINDINGS: Record<string, "forward" | "back" | "left" | "right"> = {
  KeyW: "forward", ArrowUp: "forward",
  KeyS: "back", ArrowDown: "back",
  KeyA: "left", ArrowLeft: "left",
  KeyD: "right", ArrowRight: "right",
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

  dispose(): void {
    this.detach();
    this.held.clear();
  }
}
