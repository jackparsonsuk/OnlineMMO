import { PointerEventTypes } from "@babylonjs/core/Events/pointerEvents.js";
import { Vector3 } from "@babylonjs/core/Maths/math.js";
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
  buildingColliders,
  type Enemy,
  type EnemyArchetype,
  type EnemyKind,
  EnemyState,
  getArchetype,
  INTERP_DELAY_MS,
  getItem,
  type GroundItem,
  heightAt,
  isEnemyKind,
  isInArc,
  isSpellId,
  SPELL_IDS,
  SPELLS,
  type Spell,
  type SpellId,
  STRIKE_COMBO_LENGTH,
  STRIKE_COMBO_WINDOW_MS,
  SWING_VISUAL_MS,
  MoveInput,
  type Collider,
  type MoveWorld,
  type OstraDefinition,
  type Player,
  PLAYER_HALF,
  PLAYER_RADIUS,
  sceneryIndex,
  settlementsIn,
  TICK_RATE,
  type VillagerDefinition,
  type WorldState,
} from "@mmo/shared";
import type { Sound, SoundBoard } from "./audio.js";
import { CombatText } from "./combatText.js";
import { Effects, type ShardColour } from "./effects.js";
import type { Hud } from "./hud.js";
import type { KeyboardInput } from "./input.js";
import { Cartographer, type MapBlip } from "./map.js";
import { Nametags, type NametagTarget, type NametagVariant } from "./nametags.js";
import {
  Animator,
  buildEnemyRig,
  buildPlayerRig,
  castContact,
  type Rig,
} from "./rigs.js";
import {
  createCastArc,
  createGroundItemMesh,
  updateCameraCollision,
  updateWorld,
  type World,
} from "./scene.js";

/**
 * Everything tied to being inside one Ostra's room: prediction, the input
 * pump, the bodies and the fight. A Gate transfer disposes one of these and
 * builds another against the new room, so none of it may outlive the
 * connection.
 */
export interface OstraSession {
  /** One render/network frame. Takes `now` so tests can drive it on their own
   *  clock — requestAnimationFrame stops entirely in a background tab. */
  frame(now: number): void;
  /** Tab: the next creature in front of you. */
  cycleTarget(): void;
  /** Escape: let go of the target. Returns whether there was one. */
  clearTarget(): boolean;
  toggleMap(): void;
  readonly mapOpen: boolean;
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
    target(): string | undefined;
  };
}

/** Show the Gate label from a little further out than the Gate actually fires. */
const GATE_PROMPT_RANGE = 6;

/** Walk this close to a villager and they say their piece. Roughly the
 *  distance at which you would actually address someone. */
const SPEAKING_RANGE = 3.6;

/** Creatures further than this from the camera are not drawn at all. The
 *  server keeps camps awake well beyond it, so nothing pops in close. */
const ENEMY_DRAW_DISTANCE = 240;

/** Tab only considers creatures this close. */
const TARGET_RANGE = 36;

/** A target further than this is dropped. */
const TARGET_KEEP_RANGE = 70;

/** How far a spell will turn you toward your target to aim at it, beyond its
 *  own reach — enough to cover a creature stepping back as you swing. */
const AIM_ASSIST_SLACK = 2.5;

/** Without a target, a Strike leans toward anything within this angle of
 *  where you are looking; a Voidbolt, much less. */
const SOFT_AIM_MELEE = 1.3;
const SOFT_AIM_RANGED = 0.3;

/** Kinds of blood, by creature. */
const IMPACT_COLOUR: Record<EnemyKind, ShardColour> = {
  zombie: "ichor", spider: "void", wolf: "blood", boar: "blood", wretch: "bile", wisp: "ember", golem: "stone",
};

/** The warning each creature gives as it winds up. */
const WINDUP_SOUND: Record<EnemyKind, Sound> = {
  zombie: "windup", spider: "windup", wolf: "growl", boar: "snort", wretch: "gurgle", wisp: "crackle", golem: "rumble",
};

interface CastPayload {
  by: string;
  spell: string;
  yaw: number;
  combo: number;
  hits: Array<{ id: string; amount: number; crit: boolean; killed: boolean; staggered: boolean }>;
}

interface EnemyView {
  /** Bumped when a windup starts or is interrupted; a scheduled blow effect
   *  only plays if its token is still current. */
  swing: number;
  rig: Rig;
  animator: Animator;
  archetype: EnemyArchetype;
  state: number;
  health: number;
  variant: NametagVariant;
}

interface PlayerView {
  rig: Rig;
  animator: Animator;
  /** Facing during a cast, which overrides the body's usual yaw. */
  castYaw: number;
  dead: boolean;
}

export function createSession(
  world: World,
  room: Room<unknown, WorldState>,
  ostra: OstraDefinition,
  hud: Hud,
  keyboard: KeyboardInput,
  cameraYaw: () => number,
  audio: SoundBoard,
): OstraSession {
  const scene = world.scene;
  const born = performance.now();

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

  const players = new Map<string, PlayerView>();
  const enemies = new Map<string, EnemyView>();
  const meshes = new Map<string, TransformNode>();
  const effects = new Effects(scene);
  const combatText = new CombatText(document.getElementById("combat-text") as HTMLElement);
  const cartographer = new Cartographer(ostra);

  /** One faint ground marker per spell — the exact shape the server tests. */
  const castArcs = new Map<SpellId, TransformNode>();
  const ARC_COLOURS: Record<SpellId, number> = {
    strike: 0xbfe4ff,
    voidbolt: 0xa987ff,
    sunder: 0xffb066,
  };
  for (const id of SPELL_IDS) {
    castArcs.set(id, createCastArc(scene, SPELLS[id], ARC_COLOURS[id]));
  }

  let castShownAt = -Infinity;
  let castShownId: SpellId | undefined;
  let castShownYaw = 0;
  // The client mirrors each spell's cooldown so the effect draws on the
  // frame you press, not a round trip later. Both sides read the same
  // table; the server is still the only thing that deals damage or spends
  // mana, so a client that lies to itself only lies about a picture.
  const nextCastAt = new Map<SpellId, number>();
  /** The Strike chain, mirrored the same way. */
  let comboStep = 0;
  let comboAt = -Infinity;
  let wasDead = false;

  /** Things to do at a moment in the near future — mostly "the blade
   *  connects now". */
  const scheduled: Array<{ at: number; run: () => void }> = [];
  const later = (at: number, run: () => void): void => {
    scheduled.push({ at, run });
  };

  /** Our own hits we already drew, so the server's confirmation only adds
   *  the numbers rather than playing the impact twice. */
  const predictedHits = new Set<string>();

  let target: string | undefined;
  let targetLostAt = 0;
  let shakeUntil = 0;
  let shakeStrength = 0;

  /** Dropped items currently on the floor. */
  const groundMeshes = new Map<string, TransformNode>();
  const nametags = new Nametags(document.getElementById("nametags") as HTMLElement);
  let selfPlayer: Player | undefined;
  // The reconciler works on a plain-data mirror of the input, not the Schema
  // instance itself — `Data<MoveInput>` is that view.
  let reconciler: Reconciler<Player, Data<MoveInput>> | undefined;

  // Rebuilt once per frame and read by every step of that frame, including
  // rollback replays, so a replay sees the same world the live step did.
  // Scenery comes from the same cell index the server uses; buildings and
  // the ground too, which the prediction used to leave out — so it guessed
  // wrong walking into a wall or up a hill and was corrected every patch.
  const colliders: Collider[] = [];
  const moveWorld: MoveWorld = {
    halfExtent: ostra.size / 2,
    colliders,
    scenery: sceneryIndex(ostra),
    boxes: buildingColliders(ostra),
    terrain: ostra.terrain,
    selfId: room.sessionId,
  };

  function refreshColliders(): void {
    colliders.length = 0;
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
      // You can walk over a corpse — on the server too.
      if (enemy.state === EnemyState.Dead) return;
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
  function archetypeOf(enemy: Enemy): EnemyArchetype {
    return getArchetype(isEnemyKind(enemy.kind) ? enemy.kind : "zombie");
  }

  function selfPosition(): { x: number; y: number; z: number } {
    if (!selfPlayer) return { x: 0, y: 0, z: 0 };
    return {
      x: predict.value(selfPlayer, "x"),
      y: predict.value(selfPlayer, "y"),
      z: predict.value(selfPlayer, "z"),
    };
  }

  /** Volume for a sound at a point: full within a few metres, nothing at 45. */
  function play(sound: Sound, x: number, z: number, volume = 1): void {
    const self = selfPosition();
    const distance = Math.hypot(x - self.x, z - self.z);
    audio.play(sound, volume * Math.max(0, Math.min(1, 1.15 - distance / 40)));
  }

  function shake(strength: number, ms: number, now: number): void {
    if (strength < shakeStrength && now < shakeUntil) return;
    shakeStrength = strength;
    shakeUntil = now + ms;
  }

  // --- targeting -------------------------------------------------------------

  function setTarget(id: string | undefined): void {
    if (id === target) return;
    if (target) nametags.setTargeted(target, false);
    target = id;
    if (id) nametags.setTargeted(id, true);
    room.send("target", { id: id ?? null });
    if (!id) {
      effects.hideTarget();
      hud.setTarget(undefined);
    }
  }

  function livingEnemy(id: string | undefined): Enemy | undefined {
    if (!id) return undefined;
    const enemy = room.state.enemies.get(id);
    return enemy && enemy.state !== EnemyState.Dead ? enemy : undefined;
  }

  /** Creatures in front of you, most-in-front first. */
  function targetCandidates(): string[] {
    const self = selfPosition();
    const heading = cameraYaw();
    const scored: Array<{ id: string; score: number }> = [];
    room.state.enemies.forEach((enemy: Enemy, id: string) => {
      if (enemy.state === EnemyState.Dead) return;
      const x = predict.value(enemy, "x");
      const z = predict.value(enemy, "z");
      const distance = Math.hypot(x - self.x, z - self.z);
      if (distance > TARGET_RANGE) return;
      const bearing = Math.atan2(x - self.x, z - self.z);
      const off = Math.abs(Math.atan2(Math.sin(bearing - heading), Math.cos(bearing - heading)));
      // Ahead beats near: Tab should pick what you are looking at.
      scored.push({ id, score: off * 1.6 + distance / 18 });
    });
    return scored.sort((a, b) => a.score - b.score).map((entry) => entry.id);
  }

  function cycleTarget(): void {
    const candidates = targetCandidates();
    if (candidates.length === 0) {
      setTarget(undefined);
      return;
    }
    const index = target ? candidates.indexOf(target) : -1;
    setTarget(candidates[(index + 1) % candidates.length]);
  }

  // Click a creature to select it. A tap, not a drag, so orbiting the camera
  // never changes your target.
  const pointer = scene.onPointerObservable.add((info) => {
    if (info.type !== PointerEventTypes.POINTERTAP) return;
    const pick = scene.pick(scene.pointerX, scene.pointerY, (mesh) => mesh.metadata?.enemyId !== undefined);
    const id = pick?.pickedMesh?.metadata?.enemyId as string | undefined;
    if (id && livingEnemy(id)) setTarget(id);
  });

  /**
   * Which way to aim a cast.
   *
   * Your target if you have one and it is near enough; otherwise, for a Strike,
   * whatever is closest to where you are looking — a melee swing that whiffs
   * past something slightly off-centre feels like the game's fault, not
   * yours. Voidbolt gets a much narrower nudge: reach is its reward, and
   * accuracy is its price. The server tests against the positions we drew, so
   * aiming at the picture is aiming at the truth.
   */
  function aimFor(spell: Spell | undefined): number {
    const camera = cameraYaw();
    if (!spell || spell.arc >= Math.PI * 2 || !selfPlayer) return camera;
    const self = selfPosition();

    const locked = livingEnemy(target);
    if (locked) {
      const x = predict.value(locked, "x");
      const z = predict.value(locked, "z");
      if (Math.hypot(x - self.x, z - self.z) <= spell.range + archetypeOf(locked).radius + AIM_ASSIST_SLACK) {
        return Math.atan2(x - self.x, z - self.z);
      }
    }

    const cone = spell.id === "strike" ? SOFT_AIM_MELEE : SOFT_AIM_RANGED;
    let best: number | undefined;
    let bestScore = Infinity;
    room.state.enemies.forEach((enemy: Enemy) => {
      if (enemy.state === EnemyState.Dead) return;
      const x = predict.value(enemy, "x");
      const z = predict.value(enemy, "z");
      const distance = Math.hypot(x - self.x, z - self.z);
      if (distance > spell.range + archetypeOf(enemy).radius + 0.6) return;
      const bearing = Math.atan2(x - self.x, z - self.z);
      const off = Math.abs(Math.atan2(Math.sin(bearing - camera), Math.cos(bearing - camera)));
      if (off > cone) return;
      const score = off + distance * 0.15;
      if (score < bestScore) {
        bestScore = score;
        best = bearing;
      }
    });
    return best ?? camera;
  }

  /** What a cast from (x, z) facing `yaw` will catch, by the same test the
   *  server runs — used to draw our own impacts before it confirms them. */
  function predictHits(spell: Spell, x: number, z: number, yaw: number): string[] {
    const caught: Array<{ id: string; range: number }> = [];
    room.state.enemies.forEach((enemy: Enemy, id: string) => {
      if (enemy.state === EnemyState.Dead) return;
      const ex = predict.value(enemy, "x");
      const ez = predict.value(enemy, "z");
      if (!isInArc(x, z, yaw, ex, ez, archetypeOf(enemy).radius, spell.range, spell.arc)) return;
      caught.push({ id, range: Math.hypot(ex - x, ez - z) });
    });
    if (caught.length === 0) return [];
    if (spell.targeting === "all") return caught.map((entry) => entry.id);
    const preferred = caught.find((entry) => entry.id === target);
    return [(preferred ?? caught.reduce((a, b) => (b.range < a.range ? b : a))).id];
  }

  /** The visible blow landing on a creature: flash, flinch, shards, sound. */
  function strikeEnemy(id: string, fromX: number, fromZ: number, heavy: boolean, now: number): void {
    const view = enemies.get(id);
    const enemy = room.state.enemies.get(id);
    if (!view || !enemy) return;
    const x = predict.value(enemy, "x");
    const y = predict.value(enemy, "y");
    const z = predict.value(enemy, "z");
    const length = Math.hypot(x - fromX, z - fromZ) || 1;
    view.animator.hit(now, heavy ? 1.7 : 1);
    effects.impact(
      x, y + view.archetype.height * 0.55, z,
      (x - fromX) / length, (z - fromZ) / length,
      IMPACT_COLOUR[view.archetype.kind] ?? "spark", heavy,
    );
  }

  /** Draw a cast: body motion, slash or bolt or ring. For our own and for
   *  everyone else's alike; only the prediction of hits is ours alone. */
  function showCast(
    view: PlayerView,
    spell: Spell,
    combo: number,
    yaw: number,
    now: number,
    origin: () => { x: number; y: number; z: number },
    onContact: () => void,
    boltTarget?: () => Vector3 | undefined,
  ): void {
    view.animator.play({ type: "cast", spell: spell.id, combo, start: now });
    view.castYaw = yaw;
    const start = origin();

    if (spell.id === "strike") {
      play(combo === STRIKE_COMBO_LENGTH ? "swingHeavy" : "swing", start.x, start.z);
    } else if (spell.id === "voidbolt") {
      play("bolt", start.x, start.z);
    }

    later(now + castContact(spell.id, combo), () => {
      const at = origin();
      const t = performance.now();
      if (spell.id === "strike") {
        effects.slash(t, at.x, at.y, at.z, yaw, spell.range, combo === 2 ? -1 : 1, combo === STRIKE_COMBO_LENGTH);
        onContact();
      } else if (spell.id === "sunder") {
        effects.shockwave(t, at.x, at.y, at.z, spell.range);
        play("sunder", at.x, at.z);
        onContact();
      } else {
        const hand = new Vector3(at.x + Math.sin(yaw) * 0.55, at.y + 0.95, at.z + Math.cos(yaw) * 0.55);
        const end = boltTarget?.()
          ?? new Vector3(at.x + Math.sin(yaw) * spell.range, at.y + 0.9, at.z + Math.cos(yaw) * spell.range);
        effects.bolt(t, hand, end, onContact);
      }
    });
  }

  function enemyPoint(id: string): Vector3 | undefined {
    const enemy = room.state.enemies.get(id);
    const view = enemies.get(id);
    if (!enemy || !view) return undefined;
    return new Vector3(
      predict.value(enemy, "x"),
      predict.value(enemy, "y") + view.archetype.height * 0.55,
      predict.value(enemy, "z"),
    );
  }

  // --- state callbacks ---------------------------------------------------------

  const $ = getStateCallbacks(room);

  const offAdd = $(room.state).players.onAdd((player: Player, sessionId: string) => {
    const rig = buildPlayerRig(scene, player.colour);
    players.set(sessionId, { rig, animator: new Animator(rig), castYaw: 0, dead: false });
    meshes.set(sessionId, rig.root);
    nametags.add(
      sessionId,
      player.name,
      player.colour,
      sessionId === room.sessionId ? "self" : "player",
    );

    if (sessionId === room.sessionId) {
      selfPlayer = player;
      // Build the ground under our feet now, before the first frame, rather
      // than watching it assemble a couple of chunks at a time.
      world.terrain?.prime(player.x, player.z, 140);
      // Active rollback for the body we control: apply input immediately, and
      // when the server's authoritative position arrives, snap to it and replay
      // every input it hasn't acknowledged yet. `step` is the *same* function
      // the server runs — that's what makes the replay land in the same place.
      reconciler = predict.reconciler(player, {
        // `yaw` stays in the mirrored set because the step writes it, but it is
        // never *read* back for rendering — see the note in `frame`.
        fields: ["x", "y", "z", "yaw"],
        input,
        step: (ctx, state, command) => {
          // The server discards a dead player's input; so do we.
          if (selfPlayer && selfPlayer.health === 0) return;
          applyInput(state, command, ctx.dt, moveWorld, !(selfPlayer?.inCombat ?? false));
        },
      });
    }

    hud.setRoster(room.state, room.sessionId);
  });

  const offEnemyAdd = $(room.state).enemies.onAdd((enemy: Enemy, enemyId: string) => {
    const archetype = archetypeOf(enemy);
    const rig = buildEnemyRig(scene, archetype.kind);
    for (const mesh of rig.pickables) mesh.metadata = { enemyId };
    const animator = new Animator(rig);
    // Camps wake as you approach. Anything arriving after the first moment
    // climbs out of the ground rather than blinking into existence.
    if (performance.now() - born > 1500) animator.emerge(performance.now());
    if (enemy.state === EnemyState.Dead) animator.die(performance.now() - 10_000);
    enemies.set(enemyId, { swing: 0, rig, animator, archetype, state: enemy.state, health: enemy.health, variant: "hostile" });
    nametags.add(enemyId, `${archetype.name} · ${enemy.level}`, archetype.colour, "hostile", true);
    nametags.setHealth(enemyId, enemy.health / Math.max(1, enemy.maxHealth));
  });

  const offEnemyRemove = $(room.state).enemies.onRemove((_enemy: Enemy, enemyId: string) => {
    enemies.get(enemyId)?.rig.root.dispose(false, true);
    enemies.delete(enemyId);
    nametags.remove(enemyId);
    if (target === enemyId) setTarget(undefined);
  });

  const offGroundAdd = $(room.state).ground.onAdd((dropped: GroundItem, groundId: string) => {
    const item = getItem(dropped.itemId);
    if (!item) return;
    const mesh = createGroundItemMesh(scene, item.rarity);
    mesh.position.set(dropped.x, dropped.y + 0.62, dropped.z);
    groundMeshes.set(groundId, mesh);
  });

  /** Someone else's drop, for as long as their claim lasts. */
  function claimedByOther(dropped: GroundItem): boolean {
    return dropped.claimedBy !== "" && dropped.claimedBy !== room.sessionId;
  }

  const offGroundRemove = $(room.state).ground.onRemove((_dropped: GroundItem, groundId: string) => {
    groundMeshes.get(groundId)?.dispose(false, true);
    groundMeshes.delete(groundId);
  });

  const offRemove = $(room.state).players.onRemove((_player: Player, sessionId: string) => {
    players.get(sessionId)?.rig.root.dispose(false, true);
    players.delete(sessionId);
    meshes.delete(sessionId);
    nametags.remove(sessionId);
    if (sessionId === room.sessionId) {
      reconciler?.dispose();
      reconciler = undefined;
      selfPlayer = undefined;
    }
    hud.setRoster(room.state, room.sessionId);
  });

  // --- combat messages -----------------------------------------------------------

  const offCast = room.onMessage("cast", (payload: CastPayload) => {
    if (!isSpellId(payload.spell)) return;
    const spell = SPELLS[payload.spell];
    const now = performance.now();
    const mine = payload.by === room.sessionId;

    if (!mine) {
      // Someone else's cast: play all of it, including impacts, now.
      const view = players.get(payload.by);
      const caster = room.state.players.get(payload.by);
      if (view && caster) {
        const origin = (): { x: number; y: number; z: number } => ({
          x: predict.value(caster, "x"), y: predict.value(caster, "y"), z: predict.value(caster, "z"),
        });
        const first = payload.hits[0]?.id;
        showCast(view, spell, payload.combo, payload.yaw, now, origin, () => {
          const at = origin();
          for (const hit of payload.hits) {
            strikeEnemy(hit.id, at.x, at.z, hit.crit || payload.combo === STRIKE_COMBO_LENGTH, performance.now());
          }
          if (payload.hits.length > 0) play(spell.id === "voidbolt" ? "boltHit" : "hit", at.x, at.z, 0.6);
        }, first ? () => enemyPoint(first) : undefined);
      }
    }

    for (const hit of payload.hits) {
      const point = enemyPoint(hit.id);
      if (point) {
        combatText.spawn(
          now, point.x, point.y + 0.4, point.z,
          hit.crit ? `${hit.amount}!` : String(hit.amount),
          mine ? (hit.crit ? "crit" : "dealt") : "other",
        );
        if (hit.staggered && !hit.killed) {
          combatText.spawn(now, point.x, point.y + 0.9, point.z, "Staggered", "note");
          effects.cancelTelegraphNear(point.x, point.z);
        }
      }
      if (hit.staggered) {
        const struck = enemies.get(hit.id);
        if (struck) {
          struck.animator.interrupt();
          struck.swing++;
        }
      }
      if (!mine) continue;

      // Our own: the impact was drawn at the moment of contact if we saw it
      // coming. If we did not — a prediction miss — draw it now.
      if (!predictedHits.delete(hit.id)) {
        const self = selfPosition();
        strikeEnemy(hit.id, self.x, self.z, hit.crit, now);
      }
      if (hit.crit) {
        audio.play("crit", 0.8);
        shake(0.14, 160, now);
      }
    }

    // Hitting something with nothing selected selects it, so the target frame
    // shows the fight you just started.
    if (mine && !target && payload.hits[0] && !payload.hits[0].killed) setTarget(payload.hits[0].id);
    if (mine) predictedHits.clear();
  });

  const offSwing = room.onMessage("enemySwing", (payload: { id: string; yaw: number; ms: number; target: string }) => {
    const view = enemies.get(payload.id);
    const enemy = room.state.enemies.get(payload.id);
    if (!view || !enemy) return;
    const now = performance.now();
    view.animator.play({ type: "windup", start: now, ms: payload.ms });
    const x = predict.value(enemy, "x");
    const z = predict.value(enemy, "z");
    effects.telegraph(
      now, x, predict.value(enemy, "y"), z, payload.yaw,
      // The zone your CENTRE must leave: the server measures reach to your
      // surface, so the painted edge is reach plus your radius.
      view.archetype.attackReach + PLAYER_RADIUS,
      view.archetype.attackArc,
      payload.ms,
    );
    // Everyone near hears the warning; its target hears it loudest.
    play(WINDUP_SOUND[view.archetype.kind], x, z, payload.target === room.sessionId ? 0.95 : 0.5);

    const swing = ++view.swing;
    const y = predict.value(enemy, "y");
    later(now + payload.ms, () => {
      if (view.swing !== swing || !enemies.has(payload.id)) return;
      blowEffect(view, x, y, z, payload.yaw);
    });
  });

  /** The moment a creature's blow lands: what it looks and sounds like
   *  depends on how it attacks. Damage, if any, arrives separately. */
  function blowEffect(view: EnemyView, x: number, y: number, z: number, yaw: number): void {
    const archetype = view.archetype;
    const t = performance.now();
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const self = selfPosition();
    const near = Math.hypot(self.x - x, self.z - z);
    switch (archetype.style) {
      case "spit": {
        const from = new Vector3(x + fx * 0.6, y + 0.8, z + fz * 0.6);
        const to = new Vector3(x + fx * archetype.attackReach, y + 0.7, z + fz * archetype.attackReach);
        effects.bolt(t, from, to, () => effects.impact(to.x, to.y, to.z, fx, fz, "bile", false), 0x9ad04a, 32, "bile");
        play("spit", x, z);
        break;
      }
      case "charge":
        effects.dust(x, y, z, 14);
        play("charge", x, z);
        break;
      case "pulse":
        effects.shockwave(t, x, y, z, archetype.attackReach + PLAYER_RADIUS, 0xff7a2e, 4);
        effects.impact(x, y + (archetype.hover ?? 0) + 0.5, z, 0, 0, "ember", true);
        play("burst", x, z);
        if (near < 6) shake(0.14, 160, t);
        break;
      case "slam":
        effects.shockwave(t, x + fx * 1.6, y, z + fz * 1.6, 3.2, 0xc8c0a8, 22);
        play("slam", x, z);
        if (near < 14) shake(0.3 * (1 - near / 14) + 0.08, 260, t);
        break;
      default:
        break;
    }
  }

  const offDamage = room.onMessage("damage", (payload: { id: string; amount: number; by?: string }) => {
    const now = performance.now();
    const victim = room.state.players.get(payload.id);
    const view = players.get(payload.id);
    if (!victim || !view) return;
    const x = predict.value(victim, "x");
    const y = predict.value(victim, "y");
    const z = predict.value(victim, "z");
    view.animator.hit(now, 1);
    const attacker = payload.by ? room.state.enemies.get(payload.by) : undefined;
    const fromX = attacker ? predict.value(attacker, "x") : x;
    const fromZ = attacker ? predict.value(attacker, "z") : z - 1;
    const length = Math.hypot(x - fromX, z - fromZ) || 1;
    effects.impact(x, y + 0.8, z, (x - fromX) / length, (z - fromZ) / length, "blood", false);

    if (payload.id === room.sessionId) {
      combatText.spawn(now, x, y + 1.5, z, `-${payload.amount}`, "taken");
      hud.hurt(payload.amount / Math.max(1, victim.maxHealth));
      shake(0.22, 220, now);
      audio.play("hurt", 1);
    } else {
      combatText.spawn(now, x, y + 1.5, z, `-${payload.amount}`, "other");
      play("hit", x, z, 0.5);
    }
  });

  const offEvade = room.onMessage("evade", (payload: { id: string }) => {
    if (payload.id !== room.sessionId) return;
    const self = selfPosition();
    combatText.spawn(performance.now(), self.x, self.y + 1.6, self.z, "Evaded", "note");
    audio.play("evade", 0.9);
  });

  const offRespawned = room.onMessage("respawned", (payload: { x: number; z: number }) => {
    // Waking at a waystone a kilometre away: have ground under you on the
    // first frame, not a few dozen frames later.
    world.terrain?.prime(payload.x, payload.z, 140);
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
      const slot = keyboard.castSlot();
      input.data.moveX = axes.x;
      input.data.moveZ = axes.z;
      input.data.yaw = cameraYaw();
      input.data.cast = slot;
      input.data.aim = aimFor(slot > 0 ? SPELLS[SPELL_IDS[slot - 1]!] : undefined);
      input.data.sprint = keyboard.sprinting();
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

  // Villagers stand still, so their labels are computed once. Everything else
  // about them is drawn by the scene; the session only owns their names and
  // whether you are close enough to hear one.
  const villagers: Array<VillagerDefinition & { key: string; y: number }> = [];
  for (const settlement of settlementsIn(ostra)) {
    for (const villager of settlement.villagers) {
      const key = `npc:${settlement.id}:${villager.name}`;
      villagers.push({
        ...villager,
        key,
        y: heightAt(villager.x, villager.z, ostra.terrain),
      });
      nametags.add(key, villager.name, villager.colour, "villager");
    }
  }

  const waystones = ostra.waystones.map((stone) => {
    const key = `waystone:${stone.id}`;
    nametags.add(key, stone.name, 0x9fd8ff, "waystone");
    return { key, x: stone.x, z: stone.z, y: heightAt(stone.x, stone.z, ostra.terrain) };
  });

  const nametagTargets: NametagTarget[] = [];
  const blips: MapBlip[] = [];

  /** Start our own cast the moment the key goes down, if it can be afforded. */
  function beginLocalCast(now: number): void {
    if (!selfPlayer || selfPlayer.health === 0) return;
    const slot = keyboard.castSlot();
    const wanted = slot > 0 ? SPELL_IDS[slot - 1] : undefined;
    if (!wanted) return;
    const spell = SPELLS[wanted];
    // Mana is checked here too, so a cast you cannot afford doesn't draw an
    // effect the server is about to ignore.
    if (now < (nextCastAt.get(wanted) ?? 0) || selfPlayer.mana < spell.manaCost) return;
    nextCastAt.set(wanted, now + spell.cooldownMs);

    let combo = 0;
    if (wanted === "strike") {
      combo = now - comboAt <= STRIKE_COMBO_WINDOW_MS ? (comboStep % STRIKE_COMBO_LENGTH) + 1 : 1;
      comboStep = combo;
      comboAt = now;
    }

    const yaw = aimFor(spell);
    castShownAt = now;
    castShownId = wanted;
    castShownYaw = yaw;

    const view = players.get(room.sessionId);
    if (!view) return;
    const heavy = wanted === "sunder" || combo === STRIKE_COMBO_LENGTH;
    let boltVictim: string | undefined;
    if (wanted === "voidbolt") {
      const self = selfPosition();
      boltVictim = predictHits(spell, self.x, self.z, yaw)[0];
    }

    showCast(view, spell, combo, yaw, now, selfPosition, () => {
      // The blade connects: judge it the way the server will, against what
      // we can see, and draw the result now rather than a round trip later.
      const self = selfPosition();
      const hits = wanted === "voidbolt" && boltVictim ? [boltVictim] : predictHits(spell, self.x, self.z, yaw);
      const t = performance.now();
      for (const id of hits) {
        predictedHits.add(id);
        strikeEnemy(id, self.x, self.z, heavy, t);
      }
      if (hits.length > 0) {
        audio.play(wanted === "voidbolt" ? "boltHit" : heavy ? "hitHeavy" : "hit", 1);
        shake(heavy ? 0.16 : 0.07, heavy ? 180 : 110, t);
      }
    }, boltVictim ? () => enemyPoint(boltVictim!) : undefined);
  }

  function frame(now: number): void {
    // Order matters: advance prediction to `now`, then send this frame's due
    // inputs (which step the prediction forward), and only then read poses.
    // Reading before the sends renders one fixed step stale, which shows up as
    // stutter whenever a frame runs late.
    predict.tick(now);
    refreshColliders();
    pumpInput(now);

    for (let i = scheduled.length - 1; i >= 0; i--) {
      const job = scheduled[i]!;
      if (now < job.at) continue;
      scheduled.splice(i, 1);
      job.run();
    }

    nametagTargets.length = 0;
    blips.length = 0;
    const self = selfPosition();

    room.state.players.forEach((player: Player, sessionId: string) => {
      const view = players.get(sessionId);
      if (!view) return;
      const mine = sessionId === room.sessionId;

      // One read idiom for everyone: `value()` returns the reconciled pose for
      // our own body and the interpolated pose for everybody else's.
      const x = predict.value(player, "x");
      const y = predict.value(player, "y");
      const z = predict.value(player, "z");
      view.rig.root.position.set(x, y, z);

      const casting = view.animator.casting(now);
      view.rig.root.rotation.y = casting
        // Mid-swing, the body faces what it is swinging at.
        ? view.castYaw
        : mine
          // Our own facing comes straight from the camera, never from the
          // network. The server only ever echoes back the yaw we sent it, so
          // there is nothing to reconcile — and reconciling it anyway is a bug:
          // the correction smoothing is linear and angle-blind, so any turn
          // across the 0/2π seam gets lerped the LONG way round, whipping the
          // body through a half-turn to face the camera and back. Reading the
          // camera also removes a frame of turn latency.
          ? cameraYaw()
          : predict.value(player, "yaw");

      const dead = player.health === 0;
      if (dead && !view.dead) view.animator.die(now);
      if (!dead && view.dead) view.animator.revive(now);
      view.dead = dead;
      view.animator.update(now, x, z, mine && keyboard.sprinting() && !player.inCombat);

      nametagTargets.push({ sessionId, x, y, z });
      if (!mine) {
        blips.push({ x, z, colour: `#${player.colour.toString(16).padStart(6, "0")}`, size: 3.5 });
      }
    });

    room.state.enemies.forEach((enemy: Enemy, enemyId: string) => {
      const view = enemies.get(enemyId);
      if (!view) return;
      const x = predict.value(enemy, "x");
      const y = predict.value(enemy, "y");
      const z = predict.value(enemy, "z");
      const distance = Math.hypot(x - self.x, z - self.z);
      const dead = enemy.state === EnemyState.Dead;
      const hunting = enemy.state === EnemyState.Chase;

      if (distance < 270 && !dead) {
        blips.push({
          x, z, size: enemyId === target ? 3.4 : 2.4,
          colour: hunting ? "#ff5a44" : "#b0564a",
          ring: enemyId === target,
        });
      }

      const visible = distance < ENEMY_DRAW_DISTANCE;
      view.rig.root.setEnabled(visible);

      // Death and rising again, from the state changing under us.
      if (dead && view.state !== EnemyState.Dead) {
        view.animator.die(now);
        effects.impact(x, y + view.archetype.height * 0.5, z, 0, 0, IMPACT_COLOUR[view.archetype.kind] ?? "spark", true);
        play("kill", x, z, 0.8);
        if (enemyId === target) targetLostAt = now + 1600;
      } else if (!dead && view.state === EnemyState.Dead) {
        view.animator.revive(now);
      }
      view.state = enemy.state;

      if (view.health !== enemy.health) {
        view.health = enemy.health;
        nametags.setHealth(enemyId, enemy.health / Math.max(1, enemy.maxHealth));
      }

      if (!visible) return;
      view.rig.root.position.set(x, y, z);
      view.rig.root.rotation.y = predict.value(enemy, "yaw");
      view.animator.update(now, x, z);

      // The one piece of AI state the player can see. A creature that has
      // noticed you should say so before it reaches you.
      const wanted: NametagVariant = dead ? "dead" : hunting ? "hunting" : "hostile";
      if (view.variant !== wanted) {
        view.variant = wanted;
        nametags.setVariant(enemyId, wanted);
      }

      nametagTargets.push({
        sessionId: enemyId,
        x, y, z,
        height: view.archetype.height + 0.35,
      });
    });

    // Villager labels float whether or not you are near; their lines do not.
    for (const villager of villagers) {
      nametagTargets.push({
        sessionId: villager.key,
        x: villager.x,
        y: villager.y,
        z: villager.z,
        height: 1.5,
      });
    }
    for (const stone of waystones) {
      nametagTargets.push({ sessionId: stone.key, x: stone.x, y: stone.y, z: stone.z, height: 4.9, maxDistance: 160 });
    }

    // The target: kept while it lives and is near, let go shortly after it
    // dies so you can see the kill land.
    let targetBearing: number | undefined;
    const locked = target ? room.state.enemies.get(target) : undefined;
    if (target && !locked) {
      setTarget(undefined);
    } else if (locked && target) {
      const view = enemies.get(target)!;
      const x = predict.value(locked, "x");
      const y = predict.value(locked, "y");
      const z = predict.value(locked, "z");
      const dead = locked.state === EnemyState.Dead;
      if (Math.hypot(x - self.x, z - self.z) > TARGET_KEEP_RANGE || (dead && now > targetLostAt && targetLostAt > 0)) {
        targetLostAt = 0;
        setTarget(undefined);
      } else {
        if (!dead) effects.showTarget(now, x, y, z, view.archetype.radius + 0.35, locked.state === EnemyState.Chase);
        else effects.hideTarget();
        hud.setTarget({
          name: view.archetype.name,
          level: locked.level,
          health: locked.health,
          maxHealth: locked.maxHealth,
          hunting: locked.state === EnemyState.Chase,
          dead,
        });
        targetBearing = Math.atan2(x - self.x, z - self.z);
      }
    }

    if (selfPlayer) {
      const { x, y, z } = self;

      const alive = selfPlayer.health > 0;
      hud.setHealth(selfPlayer.health, selfPlayer.maxHealth);
      hud.setCombat(alive && selfPlayer.inCombat);
      if (alive === wasDead) {
        wasDead = !alive;
        hud.setDead(!alive, alive ? "" : "You will wake at the nearest waystone…");
        if (!alive) audio.play("death", 1);
      }

      beginLocalCast(now);
      hud.setCombo(now - comboAt <= STRIKE_COMBO_WINDOW_MS ? comboStep : 0);

      const showing = castShownId !== undefined && now - castShownAt < SWING_VISUAL_MS;
      for (const [id, arc] of castArcs) {
        const visible = showing && id === castShownId;
        arc.setEnabled(visible);
        if (!visible) continue;
        // Sits just off the ground so it doesn't fight the terrain for depth.
        arc.position.set(x, y + 0.08, z);
        arc.rotation.y = castShownYaw;
      }

      hud.setMana(selfPlayer.mana, selfPlayer.maxMana);
      hud.setCooldowns(now, nextCastAt);
      // Follow the *rendered* position, not the raw schema one, or the camera
      // judders by exactly the correction the reconciler is smoothing out.
      world.camera.target.set(x, y + PLAYER_HALF, z);
      // After the target moves, so the ray starts from where the player
      // actually is this frame.
      updateCameraCollision(world);
      updateWorld(world, x, z);
      hud.setGatePrompt(nearestGateLabel(x, z));

      // Close enough to hear someone. Nearest wins, so standing between two
      // villagers is never ambiguous.
      let closest: (typeof villagers)[number] | undefined;
      let closestRange = SPEAKING_RANGE;
      for (const villager of villagers) {
        const range = Math.hypot(villager.x - x, villager.z - z);
        if (range < closestRange) {
          closestRange = range;
          closest = villager;
        }
      }
      hud.setSpeech(closest?.name, closest?.line);
      cartographer.update(x, z, cameraYaw(), blips, targetBearing);
    }

    // Camera shake: a jolt in screen space, decaying. Moves the view, never
    // the camera's target — the follow and the wall test stay exact.
    const shaking = now < shakeUntil;
    if (shaking) {
      const s = shakeStrength * ((shakeUntil - now) / 200);
      world.camera.targetScreenOffset.set((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    } else if (world.camera.targetScreenOffset.x !== 0 || world.camera.targetScreenOffset.y !== 0) {
      world.camera.targetScreenOffset.set(0, 0);
      shakeStrength = 0;
    }

    // Turn and bob the drops. Cheap, and a moving thing on a still floor is
    // what makes loot noticeable without a marker.
    if (groundMeshes.size > 0) {
      const spin = now / 900;
      room.state.ground.forEach((dropped: GroundItem, groundId: string) => {
        const mesh = groundMeshes.get(groundId);
        if (!mesh) return;
        mesh.rotation.y = spin;
        mesh.position.y = dropped.y + 0.62 + Math.sin(spin * 2) * 0.09;
        // Shrunk rather than hidden: you should see that something dropped and
        // that it is not yet yours, not wonder where it went.
        mesh.scaling.setAll(claimedByOther(dropped) ? 0.55 : 1);
      });
    }

    effects.update(now);
    hud.setStats(room.clock.smoothedRtt(), input.tickRate ?? TICK_RATE, input.pendingCount);
    scene.render();

    // After render: the labels project through the view matrix this frame just
    // used, so they can't be a frame behind the bodies they sit above.
    const canvas = world.engine.getRenderingCanvas();
    if (canvas) {
      nametags.update(scene, world.camera, canvas, nametagTargets);
      combatText.update(now, scene, world.camera, canvas);
    }
  }

  function dispose(): void {
    offAdd();
    offRemove();
    offEnemyAdd();
    offEnemyRemove();
    offGroundAdd();
    offGroundRemove();
    offCast();
    offSwing();
    offDamage();
    offEvade();
    offRespawned();
    scene.onPointerObservable.remove(pointer);
    reconciler?.dispose();
    predict.dispose();
    for (const view of players.values()) view.rig.root.dispose(false, true);
    players.clear();
    meshes.clear();
    for (const view of enemies.values()) view.rig.root.dispose(false, true);
    enemies.clear();
    for (const arc of castArcs.values()) arc.dispose(false, true);
    castArcs.clear();
    for (const mesh of groundMeshes.values()) mesh.dispose(false, true);
    groundMeshes.clear();
    effects.dispose();
    combatText.clear();
    world.camera.targetScreenOffset.set(0, 0);
    hud.setDead(false);
    hud.setTarget(undefined);
    hud.setCombat(false);
    nametags.clear();
    hud.setGatePrompt(undefined);
    hud.setSpeech(undefined);
  }

  return {
    frame,
    cycleTarget,
    clearTarget: () => {
      const had = target !== undefined;
      setTarget(undefined);
      return had;
    },
    toggleMap: () => cartographer.toggleWorld(),
    get mapOpen() { return cartographer.worldOpen; },
    dispose,
    debug: { predict, meshes, colliders, input, target: () => target },
  };
}
