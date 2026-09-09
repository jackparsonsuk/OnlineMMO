import type { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import type { Data } from "@colyseus/schema";
import { getStateCallbacks, Predict, type Reconciler, type Room } from "@colyseus/sdk";
import {
  applyInput,
  INTERP_DELAY_MS,
  MoveInput,
  type OstraDefinition,
  type Player,
  PLAYER_HALF,
  TICK_RATE,
  type WorldState,
} from "@mmo/shared";
import type { Hud } from "./hud.js";
import type { KeyboardInput } from "./input.js";
import { createPlayerMesh, type World } from "./scene.js";

/**
 * Everything tied to being inside one Ostra's room: prediction, the input
 * pump, and the meshes. A Gate transfer disposes one of these and builds
 * another against the new room, so none of it may outlive the connection.
 */
export interface OstraSession {
  /** One render/network frame. Takes `now` so tests can drive it on their own
   *  clock — requestAnimationFrame stops entirely in a background tab. */
  frame(now: number): void;
  dispose(): void;
}

/** Show the Gate label from a little further out than the Gate actually fires. */
const GATE_PROMPT_RANGE = 6;

export function createSession(
  world: World,
  room: Room<unknown, WorldState>,
  ostra: OstraDefinition,
  hud: Hud,
  keyboard: KeyboardInput,
  cameraYaw: () => number,
): OstraSession {
  const halfExtent = ostra.size / 2;

  // One Predict per room drives everything visual: remote players are
  // interpolated ~INTERP_DELAY_MS in the past (so we always have two real
  // samples to move between), while the local player is reconciled below.
  const predict = Predict.get(room, { mode: "lerp", delay: INTERP_DELAY_MS });

  // Reliable is the right channel here: every WebSocket transport lacks a
  // datagram path, so "unreliable" would only add redundant frames the
  // ordered channel already guarantees.
  const input = room.input({ type: MoveInput, mode: "reliable" });

  predict.attachAll("players", {
    x: "lerp",
    y: "lerp",
    z: "lerp",
    // Without `angle`, interpolating across the ±π seam spins the cube the
    // long way round.
    yaw: { mode: "lerp", angle: true },
  });

  const meshes = new Map<string, TransformNode>();
  let selfPlayer: Player | undefined;
  // The reconciler works on a plain-data mirror of the input, not the Schema
  // instance itself — `Data<MoveInput>` is that view.
  let reconciler: Reconciler<Player, Data<MoveInput>> | undefined;

  const $ = getStateCallbacks(room);

  const offAdd = $(room.state).players.onAdd((player: Player, sessionId: string) => {
    meshes.set(sessionId, createPlayerMesh(world.scene, player.colour));

    if (sessionId === room.sessionId) {
      selfPlayer = player;
      // Active rollback for the cube we control: apply input immediately, and
      // when the server's authoritative position arrives, snap to it and replay
      // every input it hasn't acknowledged yet. `step` is the *same* function
      // the server runs — that's what makes the replay land in the same place.
      reconciler = predict.reconciler(player, {
        input,
        fields: ["x", "y", "z", "yaw"],
        step: (ctx, state, command) => applyInput(state, command, ctx.dt, halfExtent),
      });
    }

    hud.setRoster(room.state, room.sessionId);
  });

  const offRemove = $(room.state).players.onRemove((_player: Player, sessionId: string) => {
    meshes.get(sessionId)?.dispose(false, true);
    meshes.delete(sessionId);
    if (sessionId === room.sessionId) {
      reconciler?.dispose();
      reconciler = undefined;
      selfPlayer = undefined;
    }
    hud.setRoster(room.state, room.sessionId);
  });

  // --- fixed-step input ---------------------------------------------------
  // The server advertises its own step rate through the join handshake; using
  // it (rather than our own constant) is what keeps prediction and replay on
  // exactly the same dt as the authoritative sim.
  const stepMs = input.stepMs ?? 1000 / TICK_RATE;
  let accumulator = 0;
  let lastFrame = performance.now();

  function pumpInput(now: number): void {
    // Cap the catch-up after a tab-switch or a long stall: replaying a
    // multi-second backlog of inputs at once would teleport the player.
    accumulator = Math.min(accumulator + (now - lastFrame), stepMs * 5);
    lastFrame = now;

    while (accumulator >= stepMs) {
      accumulator -= stepMs;
      const axes = keyboard.axes();
      input.data.moveX = axes.x;
      input.data.moveZ = axes.z;
      input.data.yaw = cameraYaw();
      // The reconciler is subscribed to this handle, so sending is also what
      // advances the local prediction — there's no second call to make.
      input.send();
    }
  }

  /** Name the Gate you are walking toward, so stepping into one is a choice. */
  function nearestGateLabel(x: number, z: number): string | undefined {
    let closest: { label: string; distance: number } | undefined;
    for (const gate of ostra.gates) {
      const distance = Math.hypot(gate.x - x, gate.z - z);
      if (distance > GATE_PROMPT_RANGE) continue;
      if (!closest || distance < closest.distance) closest = { label: gate.label, distance };
    }
    return closest?.label;
  }

  function frame(now: number): void {
    // Order matters: advance prediction to `now`, then send this frame's due
    // inputs (which step the prediction forward), and only then read poses.
    // Reading before the sends renders one fixed step stale, which shows up as
    // stutter whenever a frame runs late.
    predict.tick(now);
    pumpInput(now);

    room.state.players.forEach((player: Player, sessionId: string) => {
      const mesh = meshes.get(sessionId);
      if (!mesh) return;
      // One read idiom for everyone: `value()` returns the reconciled pose for
      // our own cube and the interpolated pose for everybody else's.
      mesh.position.set(
        predict.value(player, "x"),
        predict.value(player, "y") + PLAYER_HALF,
        predict.value(player, "z"),
      );
      mesh.rotation.y = predict.value(player, "yaw");
    });

    if (selfPlayer) {
      const x = predict.value(selfPlayer, "x");
      const y = predict.value(selfPlayer, "y");
      const z = predict.value(selfPlayer, "z");
      // Follow the *rendered* position, not the raw schema one, or the camera
      // judders by exactly the correction the reconciler is smoothing out.
      world.camera.target.set(x, y + PLAYER_HALF, z);
      hud.setGatePrompt(nearestGateLabel(x, z));
    }

    hud.setStats(room.clock.smoothedRtt(), input.tickRate ?? TICK_RATE, input.pendingCount);
    world.scene.render();
  }

  function dispose(): void {
    offAdd();
    offRemove();
    reconciler?.dispose();
    predict.dispose();
    for (const mesh of meshes.values()) mesh.dispose(false, true);
    meshes.clear();
    hud.setGatePrompt(undefined);
  }

  return { frame, dispose };
}
