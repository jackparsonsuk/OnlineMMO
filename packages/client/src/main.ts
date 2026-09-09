import type { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { Client, getStateCallbacks, Predict } from "@colyseus/sdk";
import type { Reconciler } from "@colyseus/sdk";
import type { Data } from "@colyseus/schema";
import {
  applyInput,
  INTERP_DELAY_MS,
  MoveInput,
  type Player,
  PLAYER_HALF,
  ROOM_NAME,
  TICK_RATE,
  WorldState,
} from "@mmo/shared";
import { Hud } from "./hud.js";
import { KeyboardInput } from "./input.js";
import { createPlayerMesh, createWorld } from "./scene.js";

const ENDPOINT = import.meta.env.VITE_SERVER_URL ?? "ws://localhost:2567";

const canvas = document.getElementById("game") as HTMLCanvasElement;
const hud = new Hud();
const world = createWorld(canvas);
const keyboard = new KeyboardInput();

/**
 * Heading the player should face, derived from where the camera is looking.
 *
 * Babylon puts an ArcRotateCamera at `target + r·(cos α·sin β, cos β, sin α·sin β)`,
 * so the horizontal direction from camera to target is `(-cos α, -sin α)`. A mesh
 * at `rotation.y = yaw` faces `(sin yaw, cos yaw)`, so matching the two gives
 * `yaw = atan2(-cos α, -sin α)` — i.e. the cube always faces away from the camera.
 */
function cameraYaw(): number {
  const alpha = world.camera.alpha;
  return Math.atan2(-Math.cos(alpha), -Math.sin(alpha));
}

async function main(): Promise<void> {
  hud.setStatus("connecting…");

  const client = new Client(ENDPOINT);
  const room = await client.joinOrCreate<WorldState>(
    ROOM_NAME,
    { name: pickName() },
    WorldState,
  );

  hud.setStatus("connected");

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

  $(room.state).players.onAdd((player: Player, sessionId: string) => {
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
        step: (ctx, state, command) => applyInput(state, command, ctx.dt),
      });
    }

    hud.setRoster(room.state, room.sessionId);
  });

  $(room.state).players.onRemove((_player: Player, sessionId: string) => {
    meshes.get(sessionId)?.dispose();
    meshes.delete(sessionId);
    if (sessionId === room.sessionId) {
      reconciler?.dispose();
      reconciler = undefined;
      selfPlayer = undefined;
    }
    hud.setRoster(room.state, room.sessionId);
  });

  room.onError((code, message) => hud.setStatus(`error ${code}: ${message}`, true));
  room.onLeave((code) => hud.setStatus(`disconnected (${code})`, true));

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

  // --- render -------------------------------------------------------------
  // Kept as a named function taking `now` rather than an inline closure over
  // performance.now(), so a test (or the console) can drive frames on its own
  // clock — requestAnimationFrame stops entirely in a background tab.
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
      // Follow the *rendered* position, not the raw schema one, or the camera
      // judders by exactly the correction the reconciler is smoothing out.
      world.camera.target.set(
        predict.value(selfPlayer, "x"),
        predict.value(selfPlayer, "y") + PLAYER_HALF,
        predict.value(selfPlayer, "z"),
      );
    }

    hud.setStats(room.clock.smoothedRtt(), input.tickRate ?? TICK_RATE, input.pendingCount);
    world.scene.render();
  }

  world.engine.runRenderLoop(() => frame(performance.now()));

  if (import.meta.env.DEV) {
    // Poking at live netcode state from the console beats adding a print
    // statement and reloading every time something looks wrong.
    Object.assign(window, { mmo: { room, predict, input, keyboard, meshes, frame } });
  }
}

function pickName(): string {
  const stored = localStorage.getItem("mmo:name");
  if (stored) return stored;
  const name = `Cube-${Math.floor(Math.random() * 900 + 100)}`;
  localStorage.setItem("mmo:name", name);
  return name;
}

main().catch((error: unknown) => {
  console.error(error);
  hud.setStatus(error instanceof Error ? error.message : "failed to connect", true);
});
