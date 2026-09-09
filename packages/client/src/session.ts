import type { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import type { Data } from "@colyseus/schema";
import {
  getStateCallbacks,
  type InputHandle,
  Predict,
  type Reconciler,
  type Room,
} from "@colyseus/sdk";
import {
  applyInput,
  type Enemy,
  EnemyState,
  getArchetype,
  INTERP_DELAY_MS,
  getItem,
  type GroundItem,
  isEnemyKind,
  SPELL_IDS,
  SPELLS,
  type SpellId,
  SWING_VISUAL_MS,
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
import { Nametags, type NametagTarget, type NametagVariant } from "./nametags.js";
import {
  createCastArc,
  createEnemyMesh,
  createGroundItemMesh,
  createPlayerMesh,
  type World,
} from "./scene.js";

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
    /** The live input handle — `sentCount` is the fastest way to tell
     *  "the server ignored me" from "nothing was ever sent". */
    input: InputHandle<Data<MoveInput>>;
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

  const smoothing = {
    x: "lerp",
    y: "lerp",
    z: "lerp",
    // Without `angle`, interpolating across the ±π seam spins the body the
    // long way round.
    yaw: { mode: "lerp", angle: true },
  } as const;

  predict.attachAll("players", smoothing);
  // Creatures are pure server output — nothing is predicted, so this is the
  // only thing standing between you and 20Hz stutter on every one of them.
  predict.attachAll("enemies", smoothing);

  const meshes = new Map<string, TransformNode>();
  const enemyMeshes = new Map<string, TransformNode>();
  /** Last variant pushed to each creature's label, so the DOM is only
   *  touched when the AI actually changes its mind. */
  const enemyVariants = new Map<string, NametagVariant>();
  /** Last health seen per creature, to spot a hit landing and to avoid
   *  rewriting the bar every frame. */
  const enemyHealth = new Map<string, number>();
  /** performance.now() when each creature was last struck, for the flash. */
  const enemyHitAt = new Map<string, number>();

  /** One arc per spell, built once and shown when that spell is cast. Each
   *  is drawn to its own range and width, so the ring and the bolt are
   *  visibly different reach rather than the same wedge recoloured. */
  const castArcs = new Map<SpellId, TransformNode>();
  const ARC_COLOURS: Record<SpellId, number> = {
    strike: 0xbfe4ff,
    voidbolt: 0xa987ff,
    sunder: 0xffb066,
  };
  for (const id of SPELL_IDS) {
    castArcs.set(id, createCastArc(world.scene, SPELLS[id], ARC_COLOURS[id]));
  }

  let castShownAt = -Infinity;
  let castShownId: SpellId | undefined;
  // The client mirrors each spell's cooldown so the effect draws on the
  // frame you press, not a round trip later. Both sides read the same
  // table; the server is still the only thing that deals damage or spends
  // mana, so a client that lies to itself only lies about a picture.
  const nextCastAt = new Map<SpellId, number>();
  let wasDead = false;

  /** Dropped items currently on the floor. */
  const groundMeshes = new Map<string, TransformNode>();
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
    room.state.enemies.forEach((enemy: Enemy, enemyId: string) => {
      colliders.push({
        id: enemyId,
        x: predict.value(enemy, "x"),
        z: predict.value(enemy, "z"),
        radius: archetypeOf(enemy).radius,
      });
    });
  }

  /** Falls back rather than throwing, so a creature kind this build doesn't
   *  know about is drawn wrong instead of breaking the frame. */
  function archetypeOf(enemy: Enemy) {
    return getArchetype(isEnemyKind(enemy.kind) ? enemy.kind : "zombie");
  }

  const $ = getStateCallbacks(room);

  const offAdd = $(room.state).players.onAdd((player: Player, sessionId: string) => {
    meshes.set(sessionId, createPlayerMesh(world.scene, player.colour));
    nametags.add(
      sessionId,
      player.name,
      player.colour,
      sessionId === room.sessionId ? "self" : "player",
    );

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

  const offEnemyAdd = $(room.state).enemies.onAdd((enemy: Enemy, enemyId: string) => {
    const archetype = archetypeOf(enemy);
    enemyMeshes.set(enemyId, createEnemyMesh(world.scene, archetype.kind));
    nametags.add(enemyId, archetype.name, archetype.colour, "hostile", true);
    enemyVariants.set(enemyId, "hostile");
    enemyHealth.set(enemyId, enemy.health);
    nametags.setHealth(enemyId, enemy.health / archetype.maxHealth);
  });

  const offEnemyRemove = $(room.state).enemies.onRemove((_enemy: Enemy, enemyId: string) => {
    enemyMeshes.get(enemyId)?.dispose(false, true);
    enemyMeshes.delete(enemyId);
    nametags.remove(enemyId);
    enemyVariants.delete(enemyId);
    enemyHealth.delete(enemyId);
    enemyHitAt.delete(enemyId);
  });

  const offGroundAdd = $(room.state).ground.onAdd((dropped: GroundItem, groundId: string) => {
    const item = getItem(dropped.itemId);
    if (!item) return;
    const mesh = createGroundItemMesh(world.scene, item.rarity);
    mesh.position.set(dropped.x, dropped.y + 0.62, dropped.z);
    groundMeshes.set(groundId, mesh);
  });

  const offGroundRemove = $(room.state).ground.onRemove((_dropped: GroundItem, groundId: string) => {
    groundMeshes.get(groundId)?.dispose(false, true);
    groundMeshes.delete(groundId);
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
    //
    // The lower clamp matters because `frame(now)` is a documented entry point
    // for driving on your own clock. A caller whose clock runs ahead of real
    // time hands us a NEGATIVE delta on the next call, and without the clamp
    // the accumulator goes deeply negative and silently stops sending input
    // for as long as it takes to climb back — the game looks connected and
    // simply ignores you. performance.now() is monotonic so the real client
    // never does this, but nothing here should depend on that.
    accumulator = Math.min(Math.max(0, accumulator + (now - lastFrame)), stepMs * 5);
    lastFrame = now;

    while (accumulator >= stepMs) {
      accumulator -= stepMs;
      const axes = keyboard.axes();
      input.data.moveX = axes.x;
      input.data.moveZ = axes.z;
      input.data.yaw = cameraYaw();
      input.data.cast = keyboard.castSlot();
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

    room.state.enemies.forEach((enemy: Enemy, enemyId: string) => {
      const mesh = enemyMeshes.get(enemyId);
      if (!mesh) return;
      const archetype = archetypeOf(enemy);

      const dead = enemy.state === EnemyState.Dead;

      mesh.position.set(
        predict.value(enemy, "x"),
        predict.value(enemy, "y"),
        predict.value(enemy, "z"),
      );
      mesh.rotation.y = predict.value(enemy, "yaw");
      // Corpses lie on their side and sink slightly. No animation system yet,
      // so a hard tip is the honest way to show it is down.
      mesh.rotation.z = dead ? Math.PI / 2 : 0;
      mesh.position.y += dead ? 0.12 : 0;

      const previous = enemyHealth.get(enemyId);
      if (previous !== enemy.health) {
        if (previous !== undefined && enemy.health < previous) enemyHitAt.set(enemyId, now);
        enemyHealth.set(enemyId, enemy.health);
        nametags.setHealth(enemyId, enemy.health / archetype.maxHealth);
      }

      // A brief swell on the frame a hit lands: with no skeleton to flinch,
      // scale is the cheapest thing that still reads as impact.
      const sinceHit = now - (enemyHitAt.get(enemyId) ?? -Infinity);
      const punch = sinceHit < 120 && !dead ? 1 + 0.16 * (1 - sinceHit / 120) : 1;
      mesh.scaling.setAll(punch);

      // The one piece of AI state the player can see. A creature that has
      // noticed you should say so before it reaches you.
      const wanted: NametagVariant = dead
        ? "dead"
        : enemy.state === EnemyState.Chase ? "hunting" : "hostile";
      if (enemyVariants.get(enemyId) !== wanted) {
        enemyVariants.set(enemyId, wanted);
        nametags.setVariant(enemyId, wanted);
      }

      nametagTargets.push({
        sessionId: enemyId,
        x: mesh.position.x,
        y: mesh.position.y,
        z: mesh.position.z,
        height: archetype.height + 0.35,
      });
    });

    if (selfPlayer) {
      const x = predict.value(selfPlayer, "x");
      const y = predict.value(selfPlayer, "y");
      const z = predict.value(selfPlayer, "z");

      const alive = selfPlayer.health > 0;
      hud.setHealth(selfPlayer.health, selfPlayer.maxHealth);
      if (alive === wasDead) {
        wasDead = !alive;
        hud.setDead(!alive, alive ? "" : "Returning to the Ostra's heart\u2026");
      }

      const slot = keyboard.castSlot();
      const wanted = slot > 0 ? SPELL_IDS[slot - 1] : undefined;
      if (alive && wanted) {
        const spell = SPELLS[wanted];
        // Mana is checked here too, so a cast you cannot afford doesn't draw an
        // effect the server is about to ignore.
        if (now >= (nextCastAt.get(wanted) ?? 0) && selfPlayer.mana >= spell.manaCost) {
          nextCastAt.set(wanted, now + spell.cooldownMs);
          castShownAt = now;
          castShownId = wanted;
        }
      }

      const showing = castShownId !== undefined && now - castShownAt < SWING_VISUAL_MS;
      for (const [id, arc] of castArcs) {
        const visible = showing && id === castShownId;
        arc.setEnabled(visible);
        if (!visible) continue;
        // Sits just off the ground so it doesn't fight the grid for depth.
        arc.position.set(x, y + 0.08, z);
        arc.rotation.y = cameraYaw();
      }

      hud.setMana(selfPlayer.mana, selfPlayer.maxMana);
      hud.setCooldowns(now, nextCastAt);
      // Follow the *rendered* position, not the raw schema one, or the camera
      // judders by exactly the correction the reconciler is smoothing out.
      world.camera.target.set(x, y + PLAYER_HALF, z);
      hud.setGatePrompt(nearestGateLabel(x, z));
    }

    // Turn and bob the drops. Cheap, and a moving thing on a still floor is
    // what makes loot noticeable without a marker.
    if (groundMeshes.size > 0) {
      const spin = now / 900;
      for (const mesh of groundMeshes.values()) {
        mesh.rotation.y = spin;
        mesh.position.y = mesh.position.y * 0 + 0.62 + Math.sin(spin * 2) * 0.09;
      }
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
    offEnemyAdd();
    offEnemyRemove();
    offGroundAdd();
    offGroundRemove();
    reconciler?.dispose();
    predict.dispose();
    for (const mesh of meshes.values()) mesh.dispose(false, true);
    meshes.clear();
    for (const mesh of enemyMeshes.values()) mesh.dispose(false, true);
    enemyMeshes.clear();
    enemyVariants.clear();
    enemyHealth.clear();
    enemyHitAt.clear();
    for (const arc of castArcs.values()) arc.dispose(false, true);
    castArcs.clear();
    for (const mesh of groundMeshes.values()) mesh.dispose(false, true);
    groundMeshes.clear();
    hud.setDead(false);
    nametags.clear();
    hud.setGatePrompt(undefined);
  }

  return { frame, dispose, debug: { predict, meshes, colliders, input } };
}
