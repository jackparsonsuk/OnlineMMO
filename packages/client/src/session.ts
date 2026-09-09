import type { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import type { Data } from "@colyseus/schema";
import { getStateCallbacks, Predict, type Reconciler, type Room } from "@colyseus/sdk";
import {
  applyInput,
  INTERP_DELAY_MS,
  MoveInput,
  type Collider,
  type MoveWorld,
  type OstraDefinition,
  type Player,
  PLAYER_HALF,
  PLAYER_RADIUS,
  staticColliders,
  TICK_RATE,
  type WorldState,
} from "@mmo/shared";
import type { Hud } from "./hud.js";
import type { KeyboardInput } from "./input.js";
import { Nametags, type NametagTarget } from "./nametags.js";
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
  /** Render internals, for the console and for tests. Reading a pose two ways
   *  (predicted vs drawn) is how the yaw seam bug was pinned down. */
  debug: {
    predict: Predict<WorldState>;
    meshes: ReadonlyMap<string, TransformNode>;
    colliders: readonly Collider[];
  };
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
  const scenery = staticColliders(ostra);

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
  const nametags = new Nametags(document.getElementById("nametags") as HTMLElement);
  let selfPlayer: Player | undefined;
  // The reconciler works on a plain-data mirror of the input, not the Schema
  // instance itself — `Data<MoveInput>` is that view.
  let reconciler: Reconciler<Player, Data<MoveInput>> | undefined;

  // Rebuilt once per frame and read by every step of that frame, including
  // rollback replays, so a replay sees the same world the live step did.
  const colliders: Collider[] = [];
  const moveWorld: MoveWorld = {
    halfExtent: ostra.size / 2,
    colliders,
    selfId: room.sessionId,
  };

  function refreshColliders(): void {
    colliders.length = 0;
    for (const collider of scenery) colliders.push(collider);
    room.state.players.forEach((player: Player, sessionId: string) => {
      if (sessionId === room.sessionId) return;
      // The rendered position, not the raw one: colliding against where a
      // player is *drawn* is what makes the push feel like it matches the
      // picture, even though the server knows better.
      colliders.push({
        id: sessionId,
        x: predict.value(player, "x"),
        z: predict.value(player, "z"),
        radius: PLAYER_RADIUS,
      });
    });
  }

  const $ = getStateCallbacks(room);

  const offAdd = $(room.state).players.onAdd((player: Player, sessionId: string) => {
    meshes.set(sessionId, createPlayerMesh(world.scene, player.colour));
    nametags.add(sessionId, player.name, player.colour, sessionId === room.sessionId);

    if (sessionId === room.sessionId) {
      selfPlayer = player;
      // Active rollback for the cube we control: apply input immediately, and
      // when the server's authoritative position arrives, snap to it and replay
      // every input it hasn't acknowledged yet. `step` is the *same* function
      // the server runs — that's what makes the replay land in the same place.
      reconciler = predict.reconciler(player, {
        // `yaw` stays in the mirrored set because the step writes it, but it is
        // never *read* back for rendering — see the note in `frame`.
        fields: ["x", "y", "z", "yaw"],
        input,
        step: (ctx, state, command) => applyInput(state, command, ctx.dt, moveWorld),
      });
    }

    hud.setRoster(room.state, room.sessionId);
  });

  const offRemove = $(room.state).players.onRemove((_player: Player, sessionId: string) => {
    meshes.get(sessionId)?.dispose(false, true);
    meshes.delete(sessionId);
    nametags.remove(sessionId);
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

  const nametagTargets: NametagTarget[] = [];

  function frame(now: number): void {
    // Order matters: advance prediction to `now`, then send this frame's due
    // inputs (which step the prediction forward), and only then read poses.
    // Reading before the sends renders one fixed step stale, which shows up as
    // stutter whenever a frame runs late.
    predict.tick(now);
    refreshColliders();
    pumpInput(now);

    nametagTargets.length = 0;

    room.state.players.forEach((player: Player, sessionId: string) => {
      const mesh = meshes.get(sessionId);
      if (!mesh) return;

      // One read idiom for everyone: `value()` returns the reconciled pose for
      // our own cube and the interpolated pose for everybody else's.
      const x = predict.value(player, "x");
      const y = predict.value(player, "y");
      const z = predict.value(player, "z");
      mesh.position.set(x, y + PLAYER_HALF, z);

      mesh.rotation.y = sessionId === room.sessionId
        // Our own facing comes straight from the camera, never from the
        // network. The server only ever echoes back the yaw we sent it, so
        // there is nothing to reconcile — and reconciling it anyway is a bug:
        // the correction smoothing is linear and angle-blind, so any turn
        // across the 0/2π seam gets lerped the LONG way round, whipping the
        // cube through a half-turn to face the camera and back. Reading the
        // camera also removes a frame of turn latency.
        ? cameraYaw()
        : predict.value(player, "yaw");

      nametagTargets.push({ sessionId, x, y, z });
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

    // After render: the labels project through the view matrix this frame just
    // used, so they can't be a frame behind the cubes they sit above.
    const canvas = world.engine.getRenderingCanvas();
    if (canvas) nametags.update(world.scene, world.camera, canvas, nametagTargets);
  }

  function dispose(): void {
    offAdd();
    offRemove();
    reconciler?.dispose();
    predict.dispose();
    for (const mesh of meshes.values()) mesh.dispose(false, true);
    meshes.clear();
    nametags.clear();
    hud.setGatePrompt(undefined);
  }

  return { frame, dispose, debug: { predict, meshes, colliders } };
}
