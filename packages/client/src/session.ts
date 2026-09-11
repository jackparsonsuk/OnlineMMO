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
  CLASSES,
  type ClassId,
  DIFFICULTY_COLOUR,
  difficultyOf,
  type Enemy,
  type EnemyArchetype,
  type EnemyKind,
  EnemyState,
  scaledArchetype,
  INTERP_DELAY_MS,
  describeItem,
  type GroundItem,
  heightAt,
  isEnemyKind,
  isInArc,
  isSpellId,
  castSteps,
  isMoving,
  knowsSpell,
  SPELLS,
  spellToWire,
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
  /**
   * The character screen's camera: swing round to face your own body and
   * close in, framed `shift` (a fraction of the screen's width) to the left
   * so the pack has room on the right. Closing swings back to exactly where
   * the camera was.
   */
  setPortrait(open: boolean, shift: number): void;
  /** Your own body, for the character screen to draw its lines to. */
  selfRig(): Rig | undefined;
  /** Where your body is drawn this frame. */
  selfPosition(): { x: number; y: number; z: number };
  /** The villager close enough to talk to, if any. */
  nearestVillager(): VillagerDefinition | undefined;
  /** Mark villagers' nametags with what they have for you ("!", "?", "…"). */
  setQuestMarkers(markerFor: (id: string) => string): void;
  /** Development: open the world map and hand the next click to `picker`. */
  pickOnMap(picker: ((x: number, z: number) => void) | undefined): void;
  /** Who is in your party, by session id: their names go green, and they
   *  show on the maps in green too. */
  setParty(sessionIds: ReadonlySet<string>): void;
  /** A line said aloud by the player with this session id, over their head. */
  say(sessionId: string, text: string): void;
  /** Called when another player is clicked, with where on screen. */
  onPlayerClick: ((sessionId: string, name: string, x: number, y: number) => void) | undefined;
  readonly picking: boolean;
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

/** Without a target, a blow leans toward anything within this angle of
 *  where you are looking; a Heroic Throw, much less. */
const SOFT_AIM_MELEE = 1.3;
const SOFT_AIM_RANGED = 0.3;

/** Past this reach, an ability aims like a thrown one. */
const RANGED_REACH = 6;

/** The character screen looks at you from this far off your facing, in
 *  radians — a three-quarter view reads a blocky body far better than face-on. */
const PORTRAIT_ANGLE = 0.42;
/** A little above eye level: low enough to read as looking AT you, high
 *  enough that the grass at your feet does not stand in front of your legs. */
const PORTRAIT_BETA = 1.2;
const PORTRAIT_RADIUS = 3.6;
/** Aim a little above the waist, so the head is not cut off at the top. */
const PORTRAIT_LIFT = 0.22;
const PORTRAIT_OPEN_MS = 560;
const PORTRAIT_CLOSE_MS = 440;
/**
 * While the screen is up, nothing nearer the camera than this far short of
 * your body is drawn. Low and close, the camera otherwise looks through a
 * curtain of grass blades a metre tall on screen; clipping them is cheaper
 * and more honest than hiding scenery. The blade held out in front reaches
 * about 0.7 m, so this leaves it whole.
 */
const PORTRAIT_CLEARANCE = 0.85;
/** ...and no grass grows this close to your feet. */
const PORTRAIT_CLEARING = 1.5;

interface CameraPose {
  alpha: number;
  beta: number;
  radius: number;
  /** Metres the camera's target is raised above the body's usual follow point. */
  lift: number;
  /** Fraction of the screen width the body is framed left of centre. */
  shift: number;
}

/** Shortest signed difference between two angles. */
function angleDelta(from: number, to: number): number {
  const d = (to - from) % (Math.PI * 2);
  return d > Math.PI ? d - Math.PI * 2 : d < -Math.PI ? d + Math.PI * 2 : d;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

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
  /** The level on their nametag, to notice when it changes. */
  level: number;
}

export function createSession(
  world: World,
  room: Room<unknown, WorldState>,
  ostra: OstraDefinition,
  hud: Hud,
  keyboard: KeyboardInput,
  cameraYaw: () => number,
  audio: SoundBoard,
  classId: ClassId,
): OstraSession {
  const scene = world.scene;
  const born = performance.now();
  /** Your bar, in order: key N casts `bar[N - 1]`. */
  const bar = CLASSES[classId].abilities.map((ability) => ability.spell);
  const resourceKind = CLASSES[classId].resource;

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

  /** One faint ground marker per ability that has a shape — the exact shape
   *  the server tests. Battle Cry hits nothing, so draws none. */
  const castArcs = new Map<SpellId, TransformNode>();
  const ARC_COLOURS: Record<SpellId, number> = {
    strike: 0xbfe4ff,
    throw: 0xd8e6f0,
    sunder: 0xffb066,
    cleave: 0xffd28a,
    bash: 0xbfe4ff,
    battleCry: 0xffc46b,
  };
  for (const id of bar) {
    if (SPELLS[id].targeting !== "self") castArcs.set(id, createCastArc(scene, SPELLS[id], ARC_COLOURS[id]));
  }

  let castShownAt = -Infinity;
  let castShownId: SpellId | undefined;
  let castShownYaw = 0;
  // The client mirrors each spell's cooldown so the effect draws on the
  // frame you press, not a round trip later. Both sides read the same
  // table; the server is still the only thing that deals damage or spends
  // Fervour, so a client that lies to itself only lies about a picture.
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

  // --- the character screen's camera ---------------------------------------------
  let portraitOpen = false;
  /**
   * Your facing while the character screen has the camera. Facing normally
   * reads the camera, so swinging it round to look at you would turn you to
   * face away from it — and orbiting to admire your gear would spin you like
   * a turntable. Held until the camera is all the way back.
   */
  let portraitYaw: number | undefined;
  let returnPose: CameraPose | undefined;
  let cameraTween: { from: CameraPose; to: CameraPose; start: number; duration: number; done?: () => void } | undefined;
  let cameraLift = 0;
  let cameraShift = 0;
  const baseNear = world.camera.minZ;
  const facingYaw = (): number => portraitYaw ?? cameraYaw();

  function currentPose(): CameraPose {
    const camera = world.camera;
    return { alpha: camera.alpha, beta: camera.beta, radius: camera.radius, lift: cameraLift, shift: cameraShift };
  }

  function setPortrait(open: boolean, shift: number): void {
    if (open === portraitOpen) return;
    portraitOpen = open;
    const now = performance.now();

    if (open) {
      // Reopened mid-close: keep the pose we were already returning to.
      if (portraitYaw === undefined || !returnPose) {
        portraitYaw = cameraYaw();
        returnPose = { ...currentPose(), lift: 0, shift: 0 };
      }
      // The near clip handles grass between the lens and you; this handles
      // the tufts you are standing in. Where you stood when it opened: walking
      // with the screen up is rare, and chasing you with it would regrow a
      // chunk every step.
      const self = selfPosition();
      world.scenery?.setClearing({ x: self.x, z: self.z, radius: PORTRAIT_CLEARING });
      // An ArcRotateCamera sits at target + r(cos α, ·, sin α) in x/z, and a
      // body faces (sin yaw, cos yaw); matching the two puts it in front.
      const front = Math.atan2(Math.cos(portraitYaw), Math.sin(portraitYaw));
      cameraTween = {
        from: currentPose(),
        to: { alpha: front + PORTRAIT_ANGLE, beta: PORTRAIT_BETA, radius: PORTRAIT_RADIUS, lift: PORTRAIT_LIFT, shift },
        start: now,
        duration: PORTRAIT_OPEN_MS,
      };
      return;
    }

    if (!returnPose) return;
    cameraTween = {
      from: currentPose(),
      to: returnPose,
      start: now,
      duration: PORTRAIT_CLOSE_MS,
      done: () => {
        portraitYaw = undefined;
        returnPose = undefined;
        world.scenery?.setClearing(undefined);
      },
    };
  }

  /** Advance the camera tween. Called once the follow target is set. */
  function stepPortrait(now: number): void {
    if (!cameraTween) return;
    const camera = world.camera;
    const { from, to } = cameraTween;
    const t = Math.min(1, (now - cameraTween.start) / cameraTween.duration);
    const e = easeInOutCubic(t);
    camera.alpha = from.alpha + angleDelta(from.alpha, to.alpha) * e;
    camera.beta = from.beta + (to.beta - from.beta) * e;
    camera.radius = from.radius + (to.radius - from.radius) * e;
    cameraLift = from.lift + (to.lift - from.lift) * e;
    cameraShift = from.shift + (to.shift - from.shift) * e;
    if (t >= 1) {
      const done = cameraTween.done;
      cameraTween = undefined;
      done?.();
    }
  }

  /**
   * Push the near clip plane out towards the body while the screen is up.
   * Every frame rather than only during the tween, so scrolling in while
   * admiring your gear moves it too. It follows the lift's curve, so it is
   * fully back at the default by the time the camera is.
   */
  function applyPortraitNear(): void {
    const camera = world.camera;
    const amount = cameraLift / PORTRAIT_LIFT;
    const near = amount <= 0
      ? baseNear
      : baseNear + (Math.max(baseNear, camera.radius - PORTRAIT_CLEARANCE) - baseNear) * amount;
    if (camera.minZ !== near) camera.minZ = near;
  }

  /** The screen-space offset that frames the body left of centre, in the
   *  view-space units `targetScreenOffset` takes. */
  function portraitOffsetX(): number {
    if (cameraShift === 0) return 0;
    const camera = world.camera;
    const aspect = world.engine.getAspectRatio(camera);
    return -cameraShift * camera.radius * Math.tan(camera.fov / 2) * aspect;
  }

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
    // Scaled for elites, exactly as the server reads it — see scaledArchetype.
    return scaledArchetype(isEnemyKind(enemy.kind) ? enemy.kind : "zombie", enemy.scale);
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
    const heading = facingYaw();
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
    const pick = scene.pick(
      scene.pointerX, scene.pointerY,
      (mesh) => mesh.metadata?.enemyId !== undefined || mesh.metadata?.playerId !== undefined,
    );
    const id = pick?.pickedMesh?.metadata?.enemyId as string | undefined;
    if (id && livingEnemy(id)) setTarget(id);
    // Another player: offer what can be done with them (for now, a party).
    const playerId = pick?.pickedMesh?.metadata?.playerId as string | undefined;
    const other = playerId ? room.state.players.get(playerId) : undefined;
    if (playerId && other) {
      const event = info.event as PointerEvent;
      api.onPlayerClick?.(playerId, other.name, event.clientX, event.clientY);
    }
  });

  /** Session ids of your party members in this room. */
  let partySessions: ReadonlySet<string> = new Set();
  function setParty(sessionIds: ReadonlySet<string>): void {
    for (const id of partySessions) if (!sessionIds.has(id)) nametags.setParty(id, false);
    for (const id of sessionIds) nametags.setParty(id, true);
    partySessions = sessionIds;
  }

  /**
   * Which way to aim a cast.
   *
   * Your target if you have one and it is near enough; otherwise, for a blow,
   * whatever is closest to where you are looking — a melee swing that whiffs
   * past something slightly off-centre feels like the game's fault, not
   * yours. Heroic Throw gets a much narrower nudge: reach is its reward, and
   * accuracy is its price. The server tests against the positions we drew, so
   * aiming at the picture is aiming at the truth.
   */
  function aimFor(spell: Spell | undefined): number {
    const camera = facingYaw();
    if (!spell || spell.arc >= Math.PI * 2 || spell.targeting === "self" || !selfPlayer) return camera;
    const self = selfPosition();

    const locked = livingEnemy(target);
    if (locked) {
      const x = predict.value(locked, "x");
      const z = predict.value(locked, "z");
      if (Math.hypot(x - self.x, z - self.z) <= spell.range + archetypeOf(locked).radius + AIM_ASSIST_SLACK) {
        return Math.atan2(x - self.x, z - self.z);
      }
    }

    const cone = spell.range > RANGED_REACH ? SOFT_AIM_RANGED : SOFT_AIM_MELEE;
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

  /** Draw a cast: body motion, slash or throw or ring. For our own and for
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

    if (spell.id === "strike" || spell.id === "bash") {
      play(combo === STRIKE_COMBO_LENGTH ? "swingHeavy" : "swing", start.x, start.z);
    } else if (spell.id === "cleave") {
      play("swingHeavy", start.x, start.z);
    } else if (spell.id === "throw") {
      play("throw", start.x, start.z);
    }

    later(now + castContact(spell.id, combo), () => {
      const at = origin();
      const t = performance.now();
      if (spell.id === "strike" || spell.id === "bash") {
        effects.slash(t, at.x, at.y, at.z, yaw, spell.range, combo === 2 ? -1 : 1, combo === STRIKE_COMBO_LENGTH);
        onContact();
      } else if (spell.id === "cleave") {
        // Heavy and wide: the finisher's slash, swept the other way.
        effects.slash(t, at.x, at.y, at.z, yaw, spell.range, -1, true);
        onContact();
      } else if (spell.id === "sunder") {
        effects.shockwave(t, at.x, at.y, at.z, spell.range);
        play("sunder", at.x, at.z);
        onContact();
      } else if (spell.id === "battleCry") {
        // A ring that goes out from you and hits nothing: it is the shout.
        effects.shockwave(t, at.x, at.y, at.z, 3.2, 0xffc46b, 6);
        play("cry", at.x, at.z);
        onContact();
      } else {
        // Heroic Throw: steel, tumbling, a little slower than a bolt of magic
        // would be, leaving sparks rather than light.
        const hand = new Vector3(at.x + Math.sin(yaw) * 0.55, at.y + 1.25, at.z + Math.cos(yaw) * 0.55);
        const end = boltTarget?.()
          ?? new Vector3(at.x + Math.sin(yaw) * spell.range, at.y + 0.9, at.z + Math.cos(yaw) * spell.range);
        effects.bolt(t, hand, end, onContact, 0xd8e0e8, 42, "spark");
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

  /** A creature's level in the colour of how it compares to yours. */
  function levelColour(level: number): string {
    return DIFFICULTY_COLOUR[difficultyOf(level, selfPlayer?.level ?? 1)];
  }

  /** Your level changed: every creature's badge means something new. */
  let colouredFor = 0;
  function recolourLevels(): void {
    const level = selfPlayer?.level ?? 1;
    if (level === colouredFor) return;
    colouredFor = level;
    room.state.enemies.forEach((enemy: Enemy, id: string) => nametags.setLevel(id, enemy.level, levelColour(enemy.level)));
  }

  // --- state callbacks ---------------------------------------------------------

  const $ = getStateCallbacks(room);

  const offAdd = $(room.state).players.onAdd((player: Player, sessionId: string) => {
    const rig = buildPlayerRig(scene, player.colour);
    // Others can be clicked; you clicking yourself would only get in the way.
    if (sessionId !== room.sessionId) for (const mesh of rig.pickables) mesh.metadata = { playerId: sessionId };
    players.set(sessionId, { rig, animator: new Animator(rig), castYaw: 0, dead: false, level: player.level });
    meshes.set(sessionId, rig.root);
    nametags.add(
      sessionId,
      player.name,
      player.colour,
      sessionId === room.sessionId ? "self" : "player",
    );
    nametags.setLevel(sessionId, player.level);
    // The roster can arrive before their body does.
    if (partySessions.has(sessionId)) nametags.setParty(sessionId, true);

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
    // An elite is its kind, bigger. The root carries the scale, so every
    // pose the animator puts the parts in scales with it.
    if (enemy.scale !== 1) rig.root.scaling.setAll(enemy.scale);
    enemies.set(enemyId, { swing: 0, rig, animator, archetype, state: enemy.state, health: enemy.health, variant: "hostile" });
    nametags.add(enemyId, enemy.name || archetype.name, archetype.colour, "hostile", true, enemy.name !== "");
    nametags.setLevel(enemyId, enemy.level, levelColour(enemy.level));
    nametags.setHealth(enemyId, enemy.health / Math.max(1, enemy.maxHealth));
  });

  const offEnemyRemove = $(room.state).enemies.onRemove((_enemy: Enemy, enemyId: string) => {
    enemies.get(enemyId)?.rig.root.dispose(false, true);
    enemies.delete(enemyId);
    nametags.remove(enemyId);
    if (target === enemyId) setTarget(undefined);
  });

  const offGroundAdd = $(room.state).ground.onAdd((dropped: GroundItem, groundId: string) => {
    const item = describeItem(dropped.item);
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
          if (payload.hits.length > 0) play(spell.id === "throw" ? "throwHit" : "hit", at.x, at.z, 0.6);
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

  const offSwing = room.onMessage("enemySwing", (payload: {
    id: string; yaw: number; ms: number; target: string;
    /** An elite's slam: its own reach and shape instead of the archetype's. */
    reach?: number; arc?: number; slam?: boolean;
  }) => {
    const view = enemies.get(payload.id);
    const enemy = room.state.enemies.get(payload.id);
    if (!view || !enemy) return;
    const now = performance.now();
    view.animator.play({ type: "windup", start: now, ms: payload.ms });
    const x = predict.value(enemy, "x");
    const z = predict.value(enemy, "z");
    const reach = payload.reach ?? view.archetype.attackReach;
    effects.telegraph(
      now, x, predict.value(enemy, "y"), z, payload.yaw,
      // The zone your CENTRE must leave: the server measures reach to your
      // surface, so the painted edge is reach plus your radius.
      reach + PLAYER_RADIUS,
      payload.arc ?? view.archetype.attackArc,
      payload.ms,
    );
    // Everyone near hears the warning; its target hears it loudest.
    play(WINDUP_SOUND[view.archetype.kind], x, z, payload.target === room.sessionId || payload.slam ? 0.95 : 0.5);

    const swing = ++view.swing;
    const y = predict.value(enemy, "y");
    later(now + payload.ms, () => {
      if (view.swing !== swing || !enemies.has(payload.id)) return;
      if (payload.slam) slamEffect(x, y, z, reach);
      else blowEffect(view, x, y, z, payload.yaw);
    });
  });

  /** An elite's slam landing: the whole ring goes up at once. */
  function slamEffect(x: number, y: number, z: number, reach: number): void {
    const t = performance.now();
    effects.shockwave(t, x, y, z, reach + PLAYER_RADIUS, 0xe8c23f, 28);
    effects.dust(x, y, z, 22);
    play("slam", x, z, 1);
    const self = selfPosition();
    const near = Math.hypot(self.x - x, self.z - z);
    if (near < reach * 2.5) shake(0.4 * (1 - near / (reach * 2.5)) + 0.1, 320, t);
  }

  // An elite's cry — "the pack answers!" — for everyone close enough to care.
  const offCry = room.onMessage("eliteCry", (payload: { text: string }) => {
    hud.flash(payload.text, "#e8c23f");
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
  // The dev menu's teleport lands the same way.
  const offTeleported = room.onMessage("teleported", (payload: { x: number; z: number }) => {
    world.terrain?.prime(payload.x, payload.z, 140);
  });

  // The server cancelled a cast of ours. Normally we already did, on the same
  // input; this covers the rare disagreement.
  const offCastCancelled = room.onMessage("castCancelled", () => cancelLocalCast());

  // Someone levelled — you or anyone nearby: a golden ring off them and the
  // news over their head. The banner and the sound for your own are the HUD's.
  const offLevelUp = room.onMessage("levelUp", (payload: { id: string; level: number }) => {
    const player = room.state.players.get(payload.id);
    if (!player) return;
    const now = performance.now();
    const x = predict.value(player, "x");
    const y = predict.value(player, "y");
    const z = predict.value(player, "z");
    effects.shockwave(now, x, y, z, 4.5, 0xf0d060, 10);
    later(now + 140, () => effects.shockwave(performance.now(), x, y, z, 2.6, 0xfff0b0, 0));
    combatText.spawn(now, x, y + PLAYER_HALF * 2 + 0.5, z, `Level ${payload.level}!`, "level");
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
      const wanted = bar[keyboard.castSlot() - 1];
      input.data.moveX = axes.x;
      input.data.moveZ = axes.z;
      input.data.yaw = facingYaw();
      // The key is a slot on your bar; the wire carries which ability that is.
      input.data.cast = wanted ? spellToWire(wanted) : 0;
      // A cast under way keeps aiming at its target until it lands, key held
      // or not — the server takes the latest aim.
      input.data.aim = aimFor(localCast?.spell ?? (wanted ? SPELLS[wanted] : undefined));
      input.data.sprint = keyboard.sprinting();
      // The same step the server will run on this input (`stepCast`).
      stepLocalCast(input.data, wanted, now);
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
  /** The villager you are close enough to hear, this frame. */
  let nearby: (typeof villagers)[number] | undefined;

  /** Put a quest mark over everyone who has one for you. */
  function setQuestMarkers(markerFor: (id: string) => string): void {
    for (const villager of villagers) {
      if (villager.id !== undefined) nametags.setMarker(villager.key, markerFor(villager.id));
    }
  }

  const waystones = ostra.waystones.map((stone) => {
    const key = `waystone:${stone.id}`;
    nametags.add(key, stone.name, 0x9fd8ff, "waystone");
    return { key, x: stone.x, z: stone.z, y: heightAt(stone.x, stone.z, ostra.terrain) };
  });

  const nametagTargets: NametagTarget[] = [];
  const blips: MapBlip[] = [];

  /** Our own cast with a cast time, under way: inputs left until it lands. */
  let localCast: { spell: Spell; stepsLeft: number } | undefined;

  function cancelLocalCast(): void {
    if (!localCast) return;
    // A cancelled cast does not start its cooldown — same as the server.
    nextCastAt.delete(localCast.spell.id);
    localCast = undefined;
    hud.endCast(true);
  }

  /**
   * One sent input's worth of our own casting — the same rule the server's
   * `stepCast` runs on the same input, so a swing lands or is cancelled at the
   * same step on both sides. Learned, off cooldown and affordable are checked
   * here too, so a cast the server is about to ignore draws nothing.
   */
  function stepLocalCast(command: { moveX: number; moveZ: number }, wanted: SpellId | undefined, now: number): void {
    if (!selfPlayer || selfPlayer.health === 0) {
      if (localCast) {
        localCast = undefined;
        hud.endCast(false);
      }
      return;
    }
    const moving = isMoving(command);
    if (localCast) {
      if (moving) {
        cancelLocalCast();
        return;
      }
      localCast.stepsLeft--;
      if (localCast.stepsLeft > 0) return;
      const spell = localCast.spell;
      localCast = undefined;
      hud.endCast(false);
      fireLocalCast(spell, now);
      return;
    }

    if (!wanted) return;
    const spell = SPELLS[wanted];
    if (!knowsSpell(classId, selfPlayer.level, wanted)) return;
    if (now < (nextCastAt.get(wanted) ?? 0) || selfPlayer.resource < spell.cost) return;
    const steps = castSteps(spell);
    // Nothing with a cast time starts on the move.
    if (steps > 0 && moving) return;
    nextCastAt.set(wanted, now + spell.cooldownMs);
    if (steps > 0) {
      localCast = { spell, stepsLeft: steps };
      hud.startCast(spell.name, spell.castMs);
      return;
    }
    fireLocalCast(spell, now);
  }

  /** Our own cast lands: the swing, and the impact predicted as the server
   *  will judge it. */
  function fireLocalCast(spell: Spell, now: number): void {
    const wanted = spell.id;
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
    const heavy = wanted === "sunder" || wanted === "cleave" || wanted === "bash" || combo === STRIKE_COMBO_LENGTH;
    const thrown = wanted === "throw";
    let thrownAt: string | undefined;
    if (thrown) {
      const self = selfPosition();
      thrownAt = predictHits(spell, self.x, self.z, yaw)[0];
    }

    showCast(view, spell, combo, yaw, now, selfPosition, () => {
      if (spell.targeting === "self") return;
      // The blade connects: judge it the way the server will, against what
      // we can see, and draw the result now rather than a round trip later.
      const self = selfPosition();
      const hits = thrown && thrownAt ? [thrownAt] : predictHits(spell, self.x, self.z, yaw);
      const t = performance.now();
      for (const id of hits) {
        predictedHits.add(id);
        strikeEnemy(id, self.x, self.z, heavy, t);
      }
      if (hits.length > 0) {
        audio.play(thrown ? "throwHit" : heavy ? "hitHeavy" : "hit", 1);
        shake(heavy ? 0.16 : 0.07, heavy ? 180 : 110, t);
      }
    }, thrownAt ? () => enemyPoint(thrownAt!) : undefined);
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
          // camera also removes a frame of turn latency. (Held still while
          // the character screen has the camera; see `portraitYaw`.)
          ? facingYaw()
          : predict.value(player, "yaw");

      const dead = player.health === 0;
      if (dead && !view.dead) view.animator.die(now);
      if (!dead && view.dead) view.animator.revive(now);
      view.dead = dead;
      view.animator.update(now, x, z, mine && keyboard.sprinting() && !player.inCombat);
      if (player.level !== view.level) {
        view.level = player.level;
        nametags.setLevel(sessionId, player.level);
      }

      // Party members' names read from further off: across a hall, or a field.
      const mate = partySessions.has(sessionId);
      nametagTargets.push({ sessionId, x, y, z, ...(mate ? { maxDistance: 160 } : {}) });
      if (!mine) {
        blips.push(mate
          ? { x, z, colour: "#6dcf7e", size: 4.4, ring: true }
          : { x, z, colour: `#${player.colour.toString(16).padStart(6, "0")}`, size: 3.5 });
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

      if (!dead && enemy.name !== "") {
        // A living elite shows gold on the minimap and the world map at any
        // range: it is announced to the whole Ostra, and worth crossing it for.
        blips.push({ x, z, size: 4.2, colour: "#e8c23f", ring: enemyId === target, elite: true });
      } else if (distance < 270 && !dead) {
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
          name: locked.name || view.archetype.name,
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
        hud.setDead(!alive, alive ? ""
          : ostra.dungeon ? "You will wake at the entrance…" : "You will wake at the nearest waystone…");
        if (!alive) audio.play("death", 1);
      }

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

      hud.setResource(resourceKind, selfPlayer.resource, selfPlayer.maxResource);
      hud.setCooldowns(now, nextCastAt);
      recolourLevels();
      // Follow the *rendered* position, not the raw schema one, or the camera
      // judders by exactly the correction the reconciler is smoothing out.
      stepPortrait(now);
      applyPortraitNear();
      world.camera.target.set(x, y + PLAYER_HALF + cameraLift, z);
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
      hud.setSpeech(closest?.name, closest?.line, closest?.id !== undefined);
      nearby = closest;
      cartographer.update(x, z, facingYaw(), blips, targetBearing);
    }

    // Camera shake: a jolt in screen space, decaying. Moves the view, never
    // the camera's target — the follow and the wall test stay exact.
    // The character screen's framing rides in the same offset, underneath.
    const shaking = now < shakeUntil;
    const framing = portraitOffsetX();
    if (shaking) {
      const s = shakeStrength * ((shakeUntil - now) / 200);
      world.camera.targetScreenOffset.set(framing + (Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    } else if (world.camera.targetScreenOffset.x !== framing || world.camera.targetScreenOffset.y !== 0) {
      world.camera.targetScreenOffset.set(framing, 0);
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
    offCry();
    offDamage();
    offEvade();
    offRespawned();
    offTeleported();
    offCastCancelled();
    hud.endCast(false);
    offLevelUp();
    cartographer.dispose();
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
    // Leaving mid-portrait (a Gate, say) puts the camera straight back where
    // it was, rather than handing the next Ostra a camera pointed at your face.
    if (returnPose) {
      world.camera.alpha = returnPose.alpha;
      world.camera.beta = returnPose.beta;
      world.camera.radius = returnPose.radius;
    }
    world.camera.minZ = baseNear;
    world.scenery?.setClearing(undefined);
    world.camera.targetScreenOffset.set(0, 0);
    hud.setDead(false);
    hud.setTarget(undefined);
    hud.setCombat(false);
    nametags.clear();
    hud.setGatePrompt(undefined);
    hud.setSpeech(undefined);
  }

  const api: OstraSession = {
    frame,
    cycleTarget,
    clearTarget: () => {
      const had = target !== undefined;
      setTarget(undefined);
      return had;
    },
    toggleMap: () => cartographer.toggleWorld(),
    get mapOpen() { return cartographer.worldOpen; },
    setPortrait,
    selfRig: () => players.get(room.sessionId)?.rig,
    selfPosition,
    nearestVillager: () => nearby,
    setQuestMarkers,
    pickOnMap: (picker) => cartographer.setPicker(picker),
    get picking() { return cartographer.picking; },
    setParty,
    say: (sessionId, text) => nametags.say(sessionId, text),
    onPlayerClick: undefined,
    dispose,
    debug: { predict, meshes, colliders, input, target: () => target },
  };
  return api;
}
