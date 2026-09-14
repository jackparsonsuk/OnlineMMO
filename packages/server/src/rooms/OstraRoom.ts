import { matchMaker, Room, ServerError, type Client, type Rewind } from "@colyseus/core";
import {
  addXp,
  applyInput,
  armourReduction,
  deathXpLoss,
  findGatherSpot,
  GATHER_RANGE,
  GATHER_RESPAWN_MS,
  levelGapEffect,
  BATTLE_CRY_HOLD_MS,
  buildingColliders,
  campsIn,
  canWear,
  characterStats,
  COMBAT_LINGER_MS,
  COMBO_FINISHER_KNOCKBACK,
  COMBO_FINISHER_MULTIPLIER,
  critChanceFor,
  CRIT_MULTIPLIER,
  canTake,
  CREDIT_DAMAGE_SHARE,
  CREDIT_TAKEN_SHARE,
  describeItem,
  eliteLevel,
  elitesIn,
  ENRAGE_COOLDOWN,
  ENRAGE_DAMAGE,
  Enemy,
  ENEMY_RESPAWN_MS,
  EnemyState,
  FERVOUR_DRAIN_PER_SECOND,
  FERVOUR_PER_SECOND,
  fervourMultiplier,
  findGate,
  findVillager,
  getClass,
  getQuest,
  killXpFor,
  knowsSpell,
  MAX_LEVEL,
  maxResourceFor,
  objectiveTarget,
  questReady,
  questRewardItems,
  questXp,
  settlementsIn,
  TALK_RANGE,
  type QuestLog,
  getArchetype,
  groundHeight,
  GROUND_ITEM_TTL_MS,
  GroundItem,
  LOOT_CLAIM_MS,
  HEALTH_REGEN_FRACTION_PER_SECOND,
  INVENTORY_SIZE,
  isEquipSlot,
  isInSpellShape,
  GATE_ARRIVAL_OFFSET,
  GATE_RADIUS,
  getOstra,
  getVariant,
  isEnemyKind,
  isOstraId,
  leechFraction,
  levelDamageScale,
  levelHealthScale,
  manaRegenFor,
  maxHealthFor,
  MoveInput,
  PICKUP_RADIUS,
  PLAYER_MAX_HEALTH,
  PLAYER_RADIUS,
  PLAYER_RESPAWN_MS,
  preferredSlot,
  RARITIES,
  recoveryMultiplier,
  regionOf,
  respawnPoint,
  scaledArchetype,
  findWaystone,
  isAttuned,
  waystoneArrival,
  waystoneKey,
  WAYSTONE_ATTUNE_RANGE,
  WAYSTONE_USE_RANGE,
  sceneryIndex,
  slotsFor,
  spellDamage,
  spellFromWire,
  DEFAULT_CLASS,
  buyPrice,
  packValue,
  vendorStock,
  addGoods,
  GOOD_IDS,
  goodsCount,
  goodsValue,
  isGoodId,
  type Goods,
  addTradeXp,
  isTradeId,
  MAX_TRADE_LEVEL,
  tradeXpToNext,
  type TradeId,
  type Trades,
  biteDelayMs,
  biteWindowMs,
  castPoint,
  catchChances,
  FISHING_BITE,
  FISHING_NONE,
  FISHING_WAITING,
  gatherXpFor,
  lowestCatchLevel,
  RECAST_MS,
  tradeLevel,
  type WatersId,
  castSteps,
  cooldownSteps,
  holdCost,
  holdPower,
  msToSteps,
  PERFECT_BLOCK_MS,
  SPELLS,
  isMoving,
  isDashing,
  isDodging,
  BLOCK_ARC,
  BLOCK_REDUCTION,
  SPRINT_GRACE_MS,
  HEAL_COOLDOWN_MS,
  HEAL_FRACTION,
  STRIKE_COMBO_LENGTH,
  STRIKE_COMBO_WINDOW_MS,
  wear,
  type CampDefinition,
  type CharacterStats,
  type ClassId,
  type Collider,
  type EliteAbility,
  type EliteDefinition,
  type EnemyKind,
  type EnemyArchetype,
  type MoveWorld,
  type GateDefinition,
  type ItemKey,
  type OstraDefinition,
  type OstraId,
  PATCH_RATE_MS,
  Player,
  DUNGEON_ROOM_NAME,
  PARTY_SIZE,
  ROOM_NAME,
  TICK_RATE,
  type BoxCollider,
  type Equipment,
  type Spell,
  type SpellId,
  WorldState,
} from "@mmo/shared";
import { dropDanger, rollDebugItem, rollDrop } from "../loot.js";
import {
  calmDown,
  createBrain,
  rally,
  stepEnemy,
  takeHit,
  taunt,
  type AITarget,
  type EnemyBrain,
} from "../ai/enemyAI.js";
import { issueTransferToken, verifyToken } from "../auth.js";
import { getServerContext } from "../context.js";
import { isCharacterId } from "../identity.js";
import * as parties from "../parties.js";
import type { CharacterStore } from "../store/CharacterStore.js";

export interface OstraRoomOptions {
  /** Which Ostra this room is. Rooms are matched on it, so it is required. */
  ostraId: OstraId;
  /** Which copy of a dungeon — see `parties.dungeonInstanceFor`. Required
   *  for a dungeon, and meaningless anywhere else. */
  instance?: string;
  /**
   * Which of the account's characters to play. Not a credential — the join is
   * authorised by the session token, and this only selects among the
   * characters that token already owns.
   */
  characterId: string;
}

/** What `onAuth` resolves and hands to `onJoin` as `client.auth`. */
interface JoinAuth {
  accountId: string;
}

/** Per-connection bookkeeping that doesn't belong in replicated state. */
interface Session {
  characterId: string;
  /** Whose character this is — needed to reserve their seat through a Gate. */
  accountId: string;
  /**
   * A Gate the player is standing in that must NOT fire — either the one they
   * just arrived through, or one they happened to log in on top of. Cleared
   * the moment they step out of it, which is what re-arms the Gate.
   */
  suppressedGate: string | undefined;
  /** Set once a transfer is under way; their input stops being simulated. */
  transferring: boolean;
  /**
   * Inputs applied so far. Cooldowns, holds and channels are counted in these
   * rather than in milliseconds, and the client counts the same inputs as it
   * sends them — so it agrees with us about when Charge is ready, which is the
   * difference between a charge and a rubber band. See `cooldownSteps`.
   */
  step: number;
  /** The step at which each spell may be cast again. */
  readyAt: Partial<Record<SpellId, number>>;
  /** A hold being wound up: steps held so far, and the latest aim. */
  holding: { spell: Spell; steps: number; aim: number } | undefined;
  /** A channel under way: steps since it started. */
  channel: { spell: Spell; steps: number } | undefined;
  /** A dash admitted and not yet landed, and for a Charge, what it is at. */
  dash: { spell: Spell; target: string | undefined } | undefined;
  /** Wall-clock ms when the guard went up, for a perfect block. */
  guardUpAt: number;
  classId: ClassId;
  /** Live level and XP; written back to the store on save. `level` is also
   *  replicated on the player, for everyone's nametags. */
  level: number;
  xp: number;
  /** Carried items, and what is worn. Private: nobody else sees a bag. */
  inventory: ItemKey[];
  equipment: Equipment;
  /** What this character adds up to: class and level, and the worn set.
   *  Recomputed whenever either changes, read on every blow. */
  stats: CharacterStats;
  /** Fractional resource and health carried between ticks, so a change of a
   *  few points a second is not rounded away to nothing at 30Hz. */
  resourceCarry: number;
  healthCarry: number;
  /** Wall-clock ms until which Fervour does not drain (Battle Cry). */
  fervourHoldUntil: number;
  /** Wall-clock ms when the heal is ready again (see HEAL_COOLDOWN_MS). */
  healReadyAt: number;
  /** A cast with a cast time under way: inputs left until it lands, and the
   *  latest aim. Moving cancels it (see `stepCast`). */
  pendingCast: { spell: Spell; stepsLeft: number; aim: number } | undefined;
  /** Wall-clock ms when a fallen player wakes at a waystone. */
  respawnAt: number;
  /** Where they fell, to pick the nearest waystone. */
  diedAtX: number;
  diedAtZ: number;
  /** Wall-clock ms until which they count as fighting. */
  combatUntil: number;
  /** When they last went into combat, for the sprint grace. */
  combatStartedAt: number;
  /** Where they are in the Strike chain, and when the last link landed. */
  comboStep: number;
  comboAt: number;
  /** The creature they have selected. Spells that hit one thing prefer it. */
  targetId: string | undefined;
  /** Development only: blows land but take no health. */
  god: boolean;
  quests: QuestLog;
  /** Gather spots this player emptied, as `quest:objective:spot`, and when
   *  each is back (GATHER_RESPAWN_MS). Not saved: a relog refills them. */
  gathered: Map<string, number>;
  gold: number;
  /** Waystones woken, as `waystoneKey` keys — across every Ostra, because
   *  this is the character's list and it is saved whole. */
  waystones: string[];
  /** The satchel. Private, like the pack. */
  goods: Goods;
  /** Total XP in each trade. */
  trades: Trades;
  /** A line in the water: what lives there, when it bites, and when the
   *  bite is gone. `Player.fishing` says which of those it is at. */
  fishing: { waters: WatersId; biteAt: number; windowEnd: number } | undefined;
  /** Wall-clock ms when another cast may start. */
  fishReadyAt: number;
  /** When their recent chat lines were sent, for the flood limit. */
  chatTimes: number[];
}

/** One live elite, and the fight it is in. Reset when the fight ends. */
interface EliteFight {
  elite: EliteDefinition;
  /** Something is fighting it — abilities run, and a reset has work to do. */
  engaged: boolean;
  /** Damage each player has taken from it this fight: holding its attention
   *  counts towards credit (see CREDIT_TAKEN_SHARE). */
  taken: Map<string, number>;
  /** Summon thresholds already spent, as "summon:0.5". */
  spent: Set<string>;
  /** What it summoned, still alive. */
  adds: Set<string>;
  enraged: boolean;
  nextSlamAt: number;
  /** A slam winding up: where it lands, when, and how hard. */
  slam: { at: number; x: number; z: number; radius: number; damage: number } | undefined;
}

/** A camp whose creatures currently exist. */
interface ActiveCamp {
  camp: CampDefinition;
  enemyIds: string[];
  /** Last time a player was close enough to want it. */
  wantedAt: number;
}

/** How long to wait for a client to act on a gate handoff before evicting it. */
const TRANSFER_TIMEOUT_MS = 10_000;

/**
 * Camps are only populated while somebody is near them.
 *
 * Terra holds ~5000 camps and ~21000 creatures. Simulating and replicating all of
 * them for a map where everyone is standing in one corner would be the most
 * expensive thing the server does, for nothing anyone can see. A camp wakes
 * when a player comes within ACTIVATE of it — well beyond draw distance, so
 * nobody sees one pop in — and is removed once nobody has been within DORMANT
 * for CAMP_SLEEP_MS and nothing in it is still fighting.
 */
const CAMP_ACTIVATE = 190;
const CAMP_DORMANT = 280;
const CAMP_SLEEP_MS = 20_000;
/** Ticks between camp checks. Twice a second is plenty for something that
 *  cares about hundreds of metres. */
const CAMP_CHECK_TICKS = 15;

/** Combat events are only sent to players this close to them. On a map this
 *  size, a fight three kilometres away is none of your business. */
const EVENT_RANGE = 180;

/** A hit on one creature brings camp-mates this close to join in. */
const RALLY_RADIUS = 7;

/**
 * A Charge is admitted if something alive, as the charger saw it, stands
 * within this many metres of the surface of where the run ends. The client
 * aims the end a little past the creature's middle, and a creature turning to
 * meet you keeps coming, so this is roomy; it is only there to stop a Charge
 * at nothing being a free eighteen-metre dash.
 */
const CHARGE_END_SLACK = 3;

/** A fallen elite lies this long before its body is gone. */
const ELITE_CORPSE_MS = 15_000;

/**
 * When each elite may next wake, by realm and elite id. Module-level rather
 * than on the room, deliberately: a room is torn down when its last player
 * leaves, and a timer that died with it would let anyone kill an elite, log
 * out, log back in and find it fresh. This survives that; a server restart
 * still resets it (persisting it is a job for when elites matter more).
 */
const eliteTimers = new Map<string, number>();

/**
 * Who may walk into which dungeon instance, and where they stand when they
 * do. Written by the room whose Gate they stepped into, read once by the
 * dungeon's `onJoin`.
 *
 * A dungeon's matchmaking is open to any client that names an instance, so
 * this is what stops someone joining a stranger's by guessing — and it is
 * also what carries the arrival point, because a character is never saved
 * inside a dungeon (see `beginTransfer`).
 */
const dungeonGrants = new Map<string, { instance: string; x: number; z: number; yaw: number }>();

/** A kill is shared with party members this close to it, even if they never
 *  touched it — the one healing a friend is part of the fight too, and there
 *  will be healers. */
const PARTY_SHARE_RANGE = 60;

/** Speaking aloud carries this far — across a clearing or a dungeon hall. */
const SAY_RANGE = 60;
const CHAT_MAX_LENGTH = 200;
/** At most this many lines in any CHAT_WINDOW_MS. */
const CHAT_LINES_PER_WINDOW = 5;
const CHAT_WINDOW_MS = 6_000;

/** Where you step out of a Gate: in front of it, facing away. */
function gateArrival(gate: GateDefinition): { x: number; z: number; yaw: number } {
  return {
    x: gate.x + Math.sin(gate.exitYaw) * GATE_ARRIVAL_OFFSET,
    z: gate.z + Math.cos(gate.exitYaw) * GATE_ARRIVAL_OFFSET,
    yaw: gate.exitYaw,
  };
}

/**
 * Where a character in a dungeon is saved: outside the Gate they came in by,
 * on the Ostra it stands in. An instance ends when its last player leaves, so
 * logging out inside, or the server stopping, must leave you somewhere that
 * will still exist.
 */
function dungeonExit(dungeon: OstraDefinition): { ostraId: OstraId; x: number; z: number; yaw: number } {
  const inside = dungeon.gates.find((gate) => gate.targetGate === dungeon.dungeon?.entrance) ?? dungeon.gates[0]!;
  const outside = getOstra(inside.target);
  const gate = findGate(outside, inside.targetGate);
  if (!gate) return { ostraId: outside.id, ...outside.spawn, yaw: 0 };
  return { ostraId: outside.id, ...gateArrival(gate) };
}

export class OstraRoom extends Room<{ state: WorldState; input: MoveInput }> {
  /**
   * Declaring the input here is what turns this into a timed room: clients get
   * the server clock and the tick rate through the join handshake, and each
   * client's frames land in a per-session buffer we drain on our own schedule
   * instead of applying them the instant they arrive.
   */
  inputs = this.defineInput(MoveInput, {
    // ~2s of frames at 30Hz. Enough to ride out a stall without letting a
    // client bank inputs and then spend them all in one burst of speed.
    bufferMaxSize: 64,
  });

  private ostra!: OstraDefinition;
  private store!: CharacterStore;
  private realmId!: string;
  private readonly sessions = new Map<string, Session>();
  /** Server-only AI memory, keyed by the same id as `state.enemies`. */
  private readonly brains = new Map<string, EnemyBrain>();
  /** Reused each tick so the AI loop does not allocate a target list 30x a second. */
  private readonly aiTargets: AITarget[] = [];
  /** Players some creature is hunting this tick. Being hunted counts as
   *  combat — otherwise you could sprint away from a spider that has not
   *  landed a blow yet. */
  private readonly hunted = new Set<string>();
  /** Position history, so a swing is judged against the world the attacker
   *  actually saw rather than the one that exists by the time it arrives. */
  private rewind!: Rewind;
  /** Building footprints. Constant for the room's life. */
  private boxes!: readonly BoxCollider[];
  private camps!: readonly CampDefinition[];
  private readonly activeCamps = new Map<string, ActiveCamp>();
  private nextEnemyId = 0;
  private tick = 0;
  /** When each dropped item expires, keyed as `state.ground`. Server-only:
   *  clients have no use for the deadline, only for the item. */
  private readonly groundExpiry = new Map<string, number>();
  /** When each drop stops belonging to whoever earned it. */
  private readonly groundClaimUntil = new Map<string, number>();
  /** Which creatures are elites, by enemy id, and which elites are alive. */
  private readonly eliteOf = new Map<string, EliteFight>();
  private readonly liveElites = new Map<string, string>();
  /** Creatures an elite summoned, by enemy id, and whose they are. */
  private readonly addOf = new Map<string, string>();
  private nextGroundId = 0;
  /** Which copy of a dungeon this is; undefined anywhere else. */
  private instance: string | undefined;
  /** A dungeon's elite timers. Its boss is its own and never comes back, so
   *  it does not share the realm-wide `eliteTimers`. */
  private readonly instanceEliteTimers = new Map<string, number>();

  onCreate(options: OstraRoomOptions): void {
    if (!isOstraId(options.ostraId)) {
      throw new ServerError(400, `Unknown Ostra: ${String(options.ostraId)}`);
    }

    const context = getServerContext();
    this.store = context.store;
    this.realmId = context.realmId;
    this.ostra = getOstra(options.ostraId);
    this.boxes = buildingColliders(this.ostra);
    this.camps = campsIn(this.ostra);

    // A dungeon is only ever reached through `beginTransfer`, which names the
    // instance; one without it would be a copy nobody can be granted into.
    if (this.ostra.dungeon) {
      if (typeof options.instance !== "string" || options.instance.length === 0) {
        throw new ServerError(400, "A dungeon needs an instance.");
      }
      this.instance = options.instance;
    }

    this.state = new WorldState({ ostraId: this.ostra.id });
    // A dungeon instance holds one party.
    this.maxClients = this.ostra.dungeon ? PARTY_SIZE : 64;
    this.patchRate = PATCH_RATE_MS;
    void this.setMetadata({ ostraId: this.ostra.id, instance: this.instance });

    // Lag compensation. A client renders creatures INTERP_DELAY_MS in the past,
    // so a spider closing at 7.2 m/s is nearly a metre from where it is drawn by
    // the time the swing reaches us — most of the attack range. Recording their
    // positions lets the hit test ask where they were when the player swung.
    // The client's interpolation delay reaches us through the input handshake,
    // so neither side has to be told about the other's timing.
    this.rewind = this.allowRewindState({ maxRewindMs: 600 });
    this.rewind.attachAll(this.state.enemies, {
      fields: ["x", "z"],
      mode: "snapshot",
    });

    this.onMessage("requestProfile", (client) => this.onRequestProfile(client));
    this.onMessage("equip", (client, message: { item?: unknown; slot?: unknown }) =>
      this.onEquip(client, message?.item, message?.slot));
    this.onMessage("unequip", (client, message: { slot?: unknown }) =>
      this.onUnequip(client, message?.slot));
    this.onMessage("destroy", (client, message: { item?: unknown }) =>
      this.onDestroy(client, message?.item));
    this.onMessage("questAccept", (client, message: { quest?: unknown }) =>
      this.onQuestAccept(client, message?.quest));
    this.onMessage("questAbandon", (client, message: { quest?: unknown }) =>
      this.onQuestAbandon(client, message?.quest));
    this.onMessage("questComplete", (client, message: { quest?: unknown; choice?: unknown }) =>
      this.onQuestComplete(client, message?.quest, message?.choice));
    this.onMessage("gather", (client, message: { quest?: unknown; objective?: unknown; spot?: unknown }) =>
      this.onGather(client, message?.quest, message?.objective, message?.spot));
    this.onMessage("vendorSell", (client, message: { vendor?: unknown; item?: unknown }) =>
      this.onVendorSell(client, message?.vendor, message?.item));
    this.onMessage("vendorSellAll", (client, message: { vendor?: unknown }) =>
      this.onVendorSell(client, message?.vendor, undefined));
    this.onMessage("fishCast", (client) => this.onFishCast(client));
    this.onMessage("fishHook", (client) => this.onFishHook(client));
    this.onMessage("vendorSellGoods", (client, message: { vendor?: unknown; good?: unknown }) =>
      this.onVendorSellGoods(client, message?.vendor, message?.good));
    this.onMessage("vendorBuy", (client, message: { vendor?: unknown; index?: unknown }) =>
      this.onVendorBuy(client, message?.vendor, message?.index));
    // Parties live outside any one room (see parties.ts); the room only says
    // who is asking.
    this.onMessage("partyInvite", (client, message: { name?: unknown; sessionId?: unknown }) => {
      const session = this.sessions.get(client.sessionId);
      if (!session) return;
      const name = typeof message?.name === "string" ? message.name.slice(0, 40) : undefined;
      const other = typeof message?.sessionId === "string" ? this.sessions.get(message.sessionId) : undefined;
      if (name === undefined && !other) return;
      const text = parties.invite(session.characterId, other ? { characterId: other.characterId } : { name });
      client.send("partyNote", { text });
    });
    this.onMessage("partyRespond", (client, message: { accept?: unknown }) => {
      const session = this.sessions.get(client.sessionId);
      if (session) parties.respond(session.characterId, message?.accept === true);
    });
    this.onMessage("partyLeave", (client) => {
      const session = this.sessions.get(client.sessionId);
      if (session) parties.leave(session.characterId);
    });
    this.onMessage("partyKick", (client, message: { id?: unknown }) => {
      const session = this.sessions.get(client.sessionId);
      if (session && typeof message?.id === "string") parties.kick(session.characterId, message.id);
    });
    this.onMessage("waystoneTravel", (client, message: { id?: unknown }) =>
      this.onWaystoneTravel(client, message?.id));
    this.onMessage("chat", (client, message: { text?: unknown; channel?: unknown }) =>
      this.onChat(client, message?.text, message?.channel));
    // Cheats for testing. Registered at all only outside production, so no
    // amount of crafting a message reaches them on a real server.
    if (context.devTools) {
      this.onMessage("dev", (client, message: Record<string, unknown>) => this.onDev(client, message ?? {}));
    }
    this.onMessage("target", (client, message: { id?: unknown }) => {
      const session = this.sessions.get(client.sessionId);
      if (!session) return;
      const id = message?.id;
      session.targetId = typeof id === "string" && this.state.enemies.has(id) ? id : undefined;
    });

    const scenery = sceneryIndex(this.ostra);

    // The authoritative simulation. Nothing else in this room is allowed to
    // move a player or a creature: positions change here, from buffered input
    // or from the AI, or not at all.
    this.setFixedTimestep((ctx) => {
      const now = Date.now();
      const started = performance.now();
      this.tick++;

      // One snapshot for the whole tick, taken before anyone moves. Rebuilding
      // it per player would mean players simulated later collide against
      // already-moved positions, making the result depend on map iteration
      // order — and the client, which has no such order, could never match it.
      const colliders = this.collectColliders();
      const world = {
        halfExtent: this.ostra.size / 2,
        colliders,
        scenery,
        boxes: this.boxes,
        terrain: this.ostra.terrain,
        selfId: "",
      };
      // A player's own step sees only what the client's prediction can see
      // exactly: scenery, buildings, ground. Bodies are left to the creatures,
      // which keep out of players from their side. See the client's
      // `moveWorld` for why: colliding players against bodies the client only
      // knows ~150 ms late was the rubber-banding.
      const playerWorld = { ...world, colliders: [] as Collider[] };

      for (const [sessionId, player] of this.state.players) {
        const session = this.sessions.get(sessionId);
        // A player mid-handoff is already saved at their destination; simulating
        // them further here would overwrite that with a stale position.
        if (!session || session.transferring) continue;

        playerWorld.selfId = sessionId;

        // A fallen player is simulated no further; their inputs still drain so
        // the reconcile ack keeps advancing and their client doesn't stall.
        if (player.health === 0) {
          for (const _ of this.inputs.get(sessionId)) { /* discard */ }
          continue;
        }

        // Consuming one at a time (rather than draining to an array) is what
        // keeps the server's ack aligned with the client's pending-input list,
        // so its rollback replays exactly the frames we haven't applied yet.
        for (const input of this.inputs.get(sessionId)) {
          session.step++;
          // Before the step sees it: a dash that is not allowed never starts.
          this.admitDash(sessionId, session, player, input);
          const dashing = isDashing(player);
          applyInput(player, input, ctx.dt, playerWorld, this.canSprint(session, player, now));
          // A raised guard, for a class whose guard is a block. Set before the
          // cast step, which will not start a swing behind a shield.
          const blocking = input.block === true && getClass(session.classId).guard === "block";
          if (blocking && !player.blocking) session.guardUpAt = now;
          player.blocking = blocking;
          // Anything but standing still reels the line in: moving, jumping,
          // dodging, a raised guard (all `isMoving`), an ability or the heal.
          if (session.fishing && (isMoving(input) || input.cast || input.heal || input.dash)) {
            this.endFishing(sessionId, session, player, "cancelled", now);
          }
          this.stepCast(sessionId, session, player, input, now);
          // A dash that has come to its end — run out, halted, or down from a
          // leap — lands its blow.
          if (session.dash && (dashing || input.dash) && !isDashing(player)) this.landDash(sessionId, session, player, now);
          if (input.heal) this.tryHeal(sessionId, session, player, now);
        }

        this.checkGates(sessionId, session, player);
      }

      this.stepEnemies(ctx.dt, world, now);
      this.stepElites(now);
      this.updateCombatFlags(now);
      this.stepFishing(now);
      this.regenerate(ctx.dt, now);
      this.processRespawns(now);
      this.processGround(now);
      if (this.tick % CAMP_CHECK_TICKS === 0) {
        this.updateCamps(now);
        this.updateElites(now);
        this.questVisits();
        this.wakeWaystones();
      }
      this.recordTick(performance.now() - started);
    }, TICK_RATE);
  }

  /**
   * Authorise the connection before a seat is reserved.
   *
   * Static, and run during matchmaking, so an unauthenticated client never
   * reaches a room at all. Returning a value puts it on `client.auth`.
   */
  static override async onAuth(token: string): Promise<JoinAuth> {
    const claims = await verifyToken(token);
    if (!claims) throw new ServerError(401, "Sign in first.");
    return { accountId: claims.sub };
  }

  onJoin(client: Client, options: OstraRoomOptions): void {
    const auth = client.auth as JoinAuth | undefined;
    if (!auth?.accountId) throw new ServerError(401, "Sign in first.");

    if (!isCharacterId(options.characterId)) {
      throw new ServerError(400, "A character id is required.");
    }

    const character = this.store.find(this.realmId, options.characterId);
    // Same answer either way: a character that is not yours should be
    // indistinguishable from one that does not exist.
    if (!character || character.accountId !== auth.accountId) {
      throw new ServerError(404, "No such character.");
    }

    // Two live connections sharing one character would fight over the save and
    // show up as a ghost twin. Cheap to catch within a room; see the README for
    // the cross-Ostra case this does not cover.
    for (const session of this.sessions.values()) {
      if (session.characterId === character.id) {
        throw new ServerError(409, "That character is already playing.");
      }
    }

    let saved = { x: character.x, z: character.z, yaw: character.yaw };
    if (this.ostra.dungeon) {
      // Nobody is ever saved inside a dungeon, so the store cannot say who
      // belongs here; the Gate that sent them left a grant saying so.
      const grant = dungeonGrants.get(character.id);
      if (!grant || grant.instance !== this.instance) throw new ServerError(403, "That way is shut.");
      dungeonGrants.delete(character.id);
      saved = { x: grant.x, z: grant.z, yaw: grant.yaw };
    } else if (character.ostraId !== this.ostra.id) {
      // A character saved in another Ostra should never have been routed
      // here. Trust the store over the request and say where they actually are.
      throw new ServerError(409, `That character is on ${getOstra(character.ostraId).name}.`);
    }

    // A save from before an Ostra shrank could sit outside it now.
    const limit = this.ostra.size / 2 - PLAYER_RADIUS;
    const x = Math.max(-limit, Math.min(limit, saved.x));
    const z = Math.max(-limit, Math.min(limit, saved.z));

    this.state.players.set(client.sessionId, new Player({
      name: character.name,
      colour: character.colour,
      x,
      // Recomputed rather than restored: the ground may have been reshaped
      // since they logged out, and a saved height would bury or float them.
      y: groundHeight(this.ostra, x, z),
      z,
      yaw: saved.yaw,
      level: character.level,
      // A character stored at 0 HP died as the process went down; wake them
      // whole rather than dead on arrival with no respawn timer running.
      health: character.health > 0 ? character.health : PLAYER_MAX_HEALTH,
    }));

    // Gear is loaded before anything can read maxHealth, so the bars are right
    // on the first frame rather than a patch later.
    const stats = characterStats(character.equipment, { classId: character.classId, level: character.level });
    const resource = getClass(character.classId).resource;
    const joined = this.state.players.get(client.sessionId)!;
    joined.maxHealth = maxHealthFor(stats.totals);
    joined.maxResource = maxResourceFor(resource, stats.totals);
    if (joined.health > joined.maxHealth) joined.health = joined.maxHealth;
    // Mana starts full; Fervour starts cold, because it is earned by fighting.
    joined.resource = resource === "fervour" ? 0 : joined.maxResource;

    this.sessions.set(client.sessionId, {
      characterId: character.id,
      accountId: auth.accountId,
      // Covers arriving through a Gate and logging in on top of one alike.
      suppressedGate: this.gateContaining(x, z)?.id,
      transferring: false,
      step: 0,
      readyAt: {},
      holding: undefined,
      channel: undefined,
      dash: undefined,
      guardUpAt: 0,
      pendingCast: undefined,
      classId: character.classId,
      level: character.level,
      xp: character.xp,
      inventory: [...character.inventory],
      equipment: { ...character.equipment },
      stats,
      resourceCarry: 0,
      healthCarry: 0,
      fervourHoldUntil: 0,
      healReadyAt: 0,
      respawnAt: 0,
      diedAtX: x,
      diedAtZ: z,
      combatUntil: 0,
      combatStartedAt: 0,
      comboStep: 0,
      comboAt: 0,
      targetId: undefined,
      god: false,
      quests: { active: { ...character.quests.active }, done: [...character.quests.done] },
      gathered: new Map(),
      gold: character.gold,
      waystones: [...character.waystones],
      goods: { ...character.goods },
      trades: { ...character.trades },
      fishing: undefined,
      fishReadyAt: 0,
      chatTimes: [],
    });
    this.announcePresence(client.sessionId);

    // Wake the camps around them now rather than up to half a second later,
    // so arriving somewhere never shows an empty field filling up.
    this.updateCamps(Date.now());
  }

  /** How long the last simulation ticks took, in ms: a rolling average and
   *  the worst in the last few seconds. A tick over 1000/TICK_RATE ms means
   *  the simulation is falling behind real time, and every client's
   *  prediction with it — the first thing to rule out behind rubber-banding. */
  readonly tickStats = { avgMs: 0, worstMs: 0, over: 0 };
  private worstAt = 0;

  private recordTick(ms: number): void {
    const stats = this.tickStats;
    stats.avgMs += (ms - stats.avgMs) * 0.05;
    const now = Date.now();
    if (ms > stats.worstMs || now - this.worstAt > 5000) {
      stats.worstMs = ms;
      this.worstAt = now;
    }
    if (ms > 1000 / TICK_RATE) {
      stats.over++;
      if (stats.over % 30 === 1) console.warn(`[${this.ostra.id}] slow tick: ${ms.toFixed(1)} ms (${stats.over} over budget)`);
    }
  }

  /** Tell the party registry this character is here, as they now are. */
  private announcePresence(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    const player = this.state.players.get(sessionId);
    if (!session || !player) return;
    parties.arrive({
      characterId: session.characterId,
      name: player.name,
      level: session.level,
      ostraId: this.ostra.id,
      instance: this.instance,
      sessionId,
      send: (type, payload) => this.clients.getById(sessionId)?.send(type, payload),
    });
  }

  /**
   * A line of chat. "say" reaches everyone in this room within SAY_RANGE, and
   * is drawn over the speaker's head; "party" reaches the whole party wherever
   * they are. Text is trimmed, stripped of control characters and capped, and
   * a flood of it is refused — this is the whole of moderation for now (see
   * TODO), so it is deliberately strict.
   */
  private onChat(client: Client, rawText: unknown, channel: unknown): void {
    const session = this.sessions.get(client.sessionId);
    const player = this.state.players.get(client.sessionId);
    if (!session || !player || typeof rawText !== "string") return;
    const text = rawText.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, CHAT_MAX_LENGTH);
    if (text.length === 0) return;

    const now = Date.now();
    session.chatTimes = session.chatTimes.filter((at) => now - at < CHAT_WINDOW_MS);
    if (session.chatTimes.length >= CHAT_LINES_PER_WINDOW) {
      client.send("chatRefused", { text: "Slow down — you are speaking too fast." });
      return;
    }
    session.chatTimes.push(now);

    const payload = { from: player.name, sessionId: client.sessionId, text };
    if (channel === "party") {
      if (!parties.partyChat(session.characterId, payload)) {
        client.send("chatRefused", { text: "You are not in a party. (/s to speak aloud.)" });
      }
      return;
    }
    for (const other of this.clients) {
      const listener = this.state.players.get(other.sessionId);
      if (!listener || Math.hypot(listener.x - player.x, listener.z - player.z) > SAY_RANGE) continue;
      other.send("chat", { ...payload, channel: "say" });
    }
  }

  /** Party members of this player who are in this room, alive, and within
   *  `range` of a point — the ones who share a kill there. */
  private partyNear(sessionId: string, x: number, z: number, range: number): string[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    const mates = parties.partyMates(session.characterId);
    if (mates.length === 0) return [];
    const near: string[] = [];
    for (const [otherId, other] of this.sessions) {
      if (!mates.includes(other.characterId) || other.transferring) continue;
      const player = this.state.players.get(otherId);
      if (!player || player.health === 0) continue;
      if (Math.hypot(player.x - x, player.z - z) <= range) near.push(otherId);
    }
    return near;
  }

  /**
   * The client asks for this rather than being pushed it on join.
   *
   * A message sent from onJoin races the client registering its handlers; the
   * character id had the same problem and went over HTTP for it. Letting the
   * client ask once it is ready removes the race for the price of one round
   * trip nobody is waiting on.
   */
  private onRequestProfile(client: Client): void {
    const session = this.sessions.get(client.sessionId);
    const player = this.state.players.get(client.sessionId);
    if (!session || !player) return;
    this.sendProfile(client.sessionId, session);
    // The same race as the profile: a party message sent from onJoin would
    // arrive before the client is listening.
    parties.greet(session.characterId);
  }

  onLeave(client: Client): void {
    const session = this.sessions.get(client.sessionId);
    const player = this.state.players.get(client.sessionId);

    // A transferring player was already saved at their arrival point. Saving
    // again here would write the position they left from and undo the trip.
    if (session && player && !session.transferring) {
      // Out of a dungeon by any door but its Gate, you are saved outside it.
      const exit = this.ostra.dungeon ? dungeonExit(this.ostra) : undefined;
      const at = exit ?? { ostraId: this.ostra.id, x: player.x, z: player.z, yaw: player.yaw };
      this.store.savePosition(this.realmId, session.characterId, {
        ostraId: at.ostraId,
        x: at.x,
        y: exit ? groundHeight(getOstra(exit.ostraId), exit.x, exit.z) : player.y,
        z: at.z,
        yaw: at.yaw,
        health: player.health,
        level: session.level,
        xp: session.xp,
        inventory: session.inventory,
        equipment: session.equipment,
        quests: session.quests,
        gold: session.gold,
        waystones: session.waystones,
        goods: session.goods,
        trades: session.trades,
      });
    }

    if (session) parties.depart(session.characterId, client.sessionId);
    this.sessions.delete(client.sessionId);
    this.state.players.delete(client.sessionId);
    for (const brain of this.brains.values()) {
      brain.threat.delete(client.sessionId);
      if (brain.quarry === client.sessionId) brain.quarry = undefined;
    }
  }

  /** Fire a Gate the moment a player steps into it, once per entry. */
  private checkGates(sessionId: string, session: Session, player: Player): void {
    const gate = this.gateContaining(player.x, player.z);

    if (!gate) {
      // Stepped clear — whatever was suppressed is armed again.
      session.suppressedGate = undefined;
      return;
    }
    if (gate.id === session.suppressedGate) return;

    session.suppressedGate = gate.id;
    const client = this.clients.getById(sessionId);
    if (client) void this.beginTransfer(client, session, player, gate);
  }

  /** Every player and every living creature, as circles. Scenery is looked up
   *  by cell through the world's `scenery` index instead. */
  private collectColliders(): Collider[] {
    const colliders: Collider[] = [];
    for (const [sessionId, player] of this.state.players) {
      colliders.push({
        id: sessionId,
        x: player.x,
        z: player.z,
        radius: PLAYER_RADIUS,
      });
    }
    for (const [enemyId, enemy] of this.state.enemies) {
      // You can walk over a corpse.
      if (enemy.state === EnemyState.Dead) continue;
      colliders.push({
        id: enemyId,
        x: enemy.x,
        z: enemy.z,
        radius: this.archetypeFor(enemy).radius,
      });
    }
    return colliders;
  }

  // --- camps -----------------------------------------------------------------

  /** Wake camps someone is near; put to sleep the ones nobody is. */
  private updateCamps(now: number): void {
    const watchers: Array<{ x: number; z: number }> = [];
    for (const [sessionId, player] of this.state.players) {
      const session = this.sessions.get(sessionId);
      if (session && !session.transferring) watchers.push({ x: player.x, z: player.z });
    }

    for (const camp of this.camps) {
      let nearest = Infinity;
      for (const watcher of watchers) {
        const d = Math.hypot(watcher.x - camp.x, watcher.z - camp.z) - camp.radius;
        if (d < nearest) nearest = d;
      }

      const active = this.activeCamps.get(camp.id);
      if (nearest <= CAMP_ACTIVATE) {
        if (active) active.wantedAt = now;
        else this.wakeCamp(camp, now);
        continue;
      }
      if (!active) continue;
      if (nearest <= CAMP_DORMANT) {
        active.wantedAt = now;
        continue;
      }

      // Never pull the rug out from under a fight in progress.
      const fighting = active.enemyIds.some((id) => this.brains.get(id)?.quarry !== undefined);
      if (!fighting && now - active.wantedAt > CAMP_SLEEP_MS) this.sleepCamp(active);
    }
  }

  private wakeCamp(camp: CampDefinition, now: number): void {
    const archetype = getArchetype(camp.kind);
    // A hunting area's variant: its kind's body at its own size and strength.
    const variant = getVariant(camp.variant);
    const maxHealth = Math.min(65535, Math.round(this.scaledHealth(archetype.maxHealth, camp.level) * (variant?.health ?? 1)));
    const enemyIds: string[] = [];

    for (let n = 0; n < camp.count; n++) {
      // Scatter over the camp's area rather than its circumference: the sqrt
      // spreads them evenly instead of bunching them at the edge.
      const angle = Math.random() * Math.PI * 2;
      const reach = camp.radius * Math.sqrt(Math.random());
      const x = camp.x + Math.cos(angle) * reach;
      const z = camp.z + Math.sin(angle) * reach;

      const id = `e${this.nextEnemyId++}`;
      this.state.enemies.set(id, new Enemy({
        kind: archetype.kind,
        x,
        y: groundHeight(this.ostra, x, z),
        z,
        yaw: Math.random() * Math.PI * 2,
        health: maxHealth,
        maxHealth,
        level: camp.level,
        state: EnemyState.Idle,
        variant: variant?.id ?? "",
        // Rounded to the float32 it travels as, like an elite's.
        scale: Math.fround(variant?.scale ?? 1),
      }));
      this.brains.set(id, createBrain(x, z, camp.id, maxHealth));
      enemyIds.push(id);
    }

    this.activeCamps.set(camp.id, { camp, enemyIds, wantedAt: now });
  }

  private sleepCamp(active: ActiveCamp): void {
    for (const id of active.enemyIds) {
      this.state.enemies.delete(id);
      this.brains.delete(id);
    }
    this.activeCamps.delete(active.camp.id);
  }

  // --- the fight -------------------------------------------------------------

  private stepEnemies(
    dt: number,
    world: MoveWorld & { selfId: string },
    now: number,
  ): void {
    this.hunted.clear();
    if (this.state.enemies.size === 0) return;

    // Players only — a zombie should not hunt another zombie, so this can't
    // just reuse the collider snapshot.
    this.aiTargets.length = 0;
    for (const [sessionId, player] of this.state.players) {
      const session = this.sessions.get(sessionId);
      // Nothing hunts a corpse — without this, creatures would stand over a
      // dead player swinging until they respawned somewhere else entirely.
      if (!session || session.transferring || player.health === 0) continue;
      this.aiTargets.push({ sessionId, x: player.x, z: player.z, level: session.level });
    }

    for (const [enemyId, enemy] of this.state.enemies) {
      const brain = this.brains.get(enemyId);
      if (!brain) continue;
      world.selfId = enemyId;
      const archetype = this.archetypeFor(enemy);
      const event = stepEnemy(enemy, brain, archetype, dt, world, this.aiTargets, now);
      if (brain.quarry !== undefined) this.hunted.add(brain.quarry);
      if (!event) continue;

      switch (event.type) {
        case "windup":
          // Everyone nearby sees it coming, not just the target: a friend
          // standing in the wedge should step out too.
          this.broadcastNear(enemy.x, enemy.z, "enemySwing", {
            id: enemyId, yaw: event.yaw, ms: event.ms, target: event.target,
          });
          // Enraged, the next blow comes sooner.
          if (this.eliteOf.get(enemyId)?.enraged) {
            brain.nextAttackAt -= archetype.attackCooldownMs * (1 - ENRAGE_COOLDOWN);
          }
          break;
        case "hit":
          // The same creature hits harder in a harder place, and further out.
          this.damagePlayer(
            event.target,
            archetype.attackDamage * this.ostra.difficulty.damage * levelDamageScale(enemy.level)
              * this.eliteDamageScale(enemyId),
            enemyId,
            enemy.level,
          );
          break;
        case "miss":
          this.broadcastNear(enemy.x, enemy.z, "evade", { id: event.target, by: enemyId });
          break;
      }
    }
  }

  /**
   * One input's worth of casting: advance or cancel a cast under way, or
   * start one if an ability key is held.
   *
   * Casts are counted in inputs, not milliseconds (`castSteps`), and the
   * client counts the same inputs as it sends them — so a swing lands, or is
   * cancelled by a step with movement in it, at the same input on both sides.
   */
  private stepCast(sessionId: string, session: Session, player: Player, input: MoveInput, now: number): void {
    const moving = isMoving(input);
    const wanted = spellFromWire(input.cast);
    // What breaks a wind-up or a spin: a dodge, a raised guard, or a dash.
    const broken = input.dodge === true || player.blocking || input.dash !== 0;

    const holding = session.holding;
    if (holding) {
      if (broken) {
        this.endHold(sessionId, session, player, false, now);
      } else if (wanted?.id === holding.spell.id && holding.steps < msToSteps(holding.spell.hold!.fullMs + holding.spell.hold!.graceMs)) {
        holding.steps++;
        if (Number.isFinite(input.aim)) holding.aim = input.aim;
        return;
      } else {
        // Let go, or held past full and its grace: bring it down.
        this.endHold(sessionId, session, player, true, now);
      }
      return;
    }

    const channel = session.channel;
    if (channel) {
      if (broken || wanted?.id !== channel.spell.id) {
        this.endChannel(sessionId, session, player);
        return;
      }
      channel.steps++;
      if (channel.steps % msToSteps(channel.spell.channel!.pulseMs) === 0) {
        this.pulseChannel(sessionId, session, player, input.aim, now);
      }
      return;
    }

    const pending = session.pendingCast;
    if (pending) {
      if (moving) {
        // Moved: the cast is lost, costs nothing, and can be tried again at
        // once — as in WoW, a cancelled cast does not start its cooldown.
        session.pendingCast = undefined;
        delete session.readyAt[pending.spell.id];
        this.clients.getById(sessionId)?.send("castCancelled", { spell: pending.spell.id });
        return;
      }
      // Aim follows the target for as long as the swing takes.
      if (Number.isFinite(input.aim)) pending.aim = input.aim;
      pending.stepsLeft--;
      if (pending.stepsLeft <= 0) {
        session.pendingCast = undefined;
        this.completeCast(sessionId, session, player, pending.spell, pending.aim, now);
      }
      return;
    }
    // No swinging from behind a raised shield, or out of a dodge: the guard is
    // the choice, and a dodge pressed with a key held is getting out of it.
    if (wanted && !player.blocking && !input.dodge) this.tryCast(sessionId, session, player, wanted, input.aim, moving, now);
  }

  /**
   * Start a cast: an instant one resolves now, one with a cast time waits for
   * `stepCast` to finish it, and a hold or a channel begins. Nothing with a
   * cast time starts on the move. Dashes are started by `admitDash`, before
   * the step, and passives are never cast.
   */
  private tryCast(
    sessionId: string,
    session: Session,
    player: Player,
    spell: Spell,
    aim: number,
    moving: boolean,
    now: number,
  ): void {
    if (spell.kind === "dash" || spell.kind === "passive") return;
    // Only what this class learns, and only once you are level enough. The
    // client greys the rest out; this is what makes that true.
    if (!knowsSpell(session.classId, session.level, spell.id)) return;
    if (session.step < (session.readyAt[spell.id] ?? 0)) return;
    if (player.resource < spell.cost) return;

    if (spell.kind === "hold") {
      session.holding = { spell, steps: 0, aim: Number.isFinite(aim) ? aim : player.yaw };
      this.broadcastNear(player.x, player.z, "channel", { by: sessionId, spell: spell.id, on: true });
      return;
    }
    if (spell.kind === "channel") {
      session.channel = { spell, steps: 0 };
      this.broadcastNear(player.x, player.z, "channel", { by: sessionId, spell: spell.id, on: true });
      // The first pulse lands as the key goes down.
      this.pulseChannel(sessionId, session, player, aim, now);
      return;
    }

    const steps = castSteps(spell);
    if (steps > 0 && moving) return;
    session.readyAt[spell.id] = session.step + cooldownSteps(spell);
    if (steps > 0) {
      session.pendingCast = { spell, stepsLeft: steps, aim: Number.isFinite(aim) ? aim : player.yaw };
      return;
    }
    this.completeCast(sessionId, session, player, spell, aim, now);
  }

  /**
   * A hold ends: brought down (`strike`), or broken by a dodge, a guard or a
   * dash, which costs nothing and starts no cooldown. The blow is as strong as
   * the steps it was held for, and costs to match — or whatever Fervour is
   * left, if that is less but still the price of the lightest.
   */
  private endHold(sessionId: string, session: Session, player: Player, strike: boolean, now: number): void {
    const holding = session.holding;
    if (!holding) return;
    session.holding = undefined;
    this.broadcastNear(player.x, player.z, "channel", { by: sessionId, spell: holding.spell.id, on: false });
    if (!strike || player.health === 0) {
      this.clients.getById(sessionId)?.send("castCancelled", { spell: holding.spell.id });
      return;
    }
    session.readyAt[holding.spell.id] = session.step + cooldownSteps(holding.spell);
    this.completeCast(sessionId, session, player, holding.spell, holding.aim, now, holdPower(holding.spell, holding.steps));
  }

  /** One pulse of a channel: pay for it and hit the shape, or end it if it
   *  cannot be paid for. */
  private pulseChannel(sessionId: string, session: Session, player: Player, aim: number, now: number): void {
    const channel = session.channel;
    if (!channel) return;
    if (player.resource < channel.spell.cost) {
      this.endChannel(sessionId, session, player);
      return;
    }
    this.completeCast(sessionId, session, player, channel.spell, aim, now);
  }

  /** A channel ends, however it ends; its cooldown starts now. */
  private endChannel(sessionId: string, session: Session, player: Player): void {
    const channel = session.channel;
    if (!channel) return;
    session.channel = undefined;
    session.readyAt[channel.spell.id] = session.step + cooldownSteps(channel.spell);
    this.broadcastNear(player.x, player.z, "channel", { by: sessionId, spell: channel.spell.id, on: false });
  }

  /**
   * Before the step sees an input: is the dash it asks for allowed? Learned,
   * off cooldown, not from behind a guard — and for a Charge, something alive
   * where it ends, as this player saw the world. If not, the step never hears
   * of it; the client, which only asks when it believes all that too, will be
   * corrected, which should only ever happen to a client that lied.
   */
  private admitDash(sessionId: string, session: Session, player: Player, input: MoveInput): void {
    // Only ever started, never trusted as a stop for anything but a dash.
    if (!input.dash) return;
    const spell = spellFromWire(input.dash);
    const rule = spell?.dash;
    const allowed = spell !== undefined && rule !== undefined && player.health > 0 && !input.block
      && knowsSpell(session.classId, session.level, spell.id)
      && session.step >= (session.readyAt[spell.id] ?? 0);
    let target: string | undefined;
    if (allowed && spell.id === "charge") target = this.chargeTarget(sessionId, player, input);
    if (!allowed || (spell.id === "charge" && target === undefined)) {
      input.dash = 0;
      return;
    }
    session.readyAt[spell.id] = session.step + cooldownSteps(spell);
    session.dash = { spell, target };
    // A dash breaks a wind-up or a spin; `stepCast` sees `input.dash` too.
    if (session.pendingCast) session.pendingCast = undefined;
  }

  /** The creature a Charge ends at: alive, and within reach of where it ends,
   *  measured where this player saw it. The nearest such, if several. */
  private chargeTarget(sessionId: string, player: Player, input: MoveInput): string | undefined {
    const rule = SPELLS.charge.dash!;
    const aim = Number.isFinite(input.aim) ? input.aim : player.yaw;
    const reach = Math.max(rule.minRange, Math.min(rule.maxRange, Number.isFinite(input.reach) ? input.reach : 0));
    const endX = player.x + Math.sin(aim) * reach;
    const endZ = player.z + Math.cos(aim) * reach;
    const seen = this.rewind.lastSeenBy(sessionId);
    let best: string | undefined;
    let bestRange = Infinity;
    for (const [enemyId, enemy] of this.state.enemies) {
      if (enemy.state === EnemyState.Dead) continue;
      const range = Math.hypot(seen.value(enemy, "x") - endX, seen.value(enemy, "z") - endZ)
        - this.archetypeFor(enemy).radius;
      if (range <= CHARGE_END_SLACK && range < bestRange) {
        best = enemyId;
        bestRange = range;
      }
    }
    return best;
  }

  /** A dash has ended: a Charge's blow on what it ran at, if it reached it;
   *  a leap's on everything around where it came down. */
  private landDash(sessionId: string, session: Session, player: Player, now: number): void {
    const dash = session.dash;
    if (!dash) return;
    session.dash = undefined;
    if (player.health === 0) return;
    const fervour = getClass(session.classId).resource === "fervour" ? player.resource : 0;
    const yaw = Math.atan2(player.dashX, player.dashZ);
    const hits = this.resolveSpell(sessionId, player, dash.spell, session, yaw, 0, fervour, now, {
      only: dash.spell.id === "charge" ? dash.target : undefined,
    });
    this.broadcastNear(player.x, player.z, "cast", { by: sessionId, spell: dash.spell.id, yaw, combo: 0, power: 0, hits });
    this.landed(session, player, dash.spell, hits, now);
  }

  /**
   * Resolve one cast: an instant, the end of a cast time, a hold let go
   * (`power`, 0 to 1), or one pulse of a channel.
   *
   * Every spell runs through the same shape test — a ring is just an arc of
   * 2*PI, a line a band — so adding a spell is a table entry rather than a new
   * code path.
   */
  private completeCast(
    sessionId: string,
    session: Session,
    player: Player,
    spell: Spell,
    aim: number,
    now: number,
    power = 0,
  ): void {
    // Paid on completion, as in WoW; something may have drained it since. A
    // hold costs more the longer it was held, but lands on what is left if
    // that still covers the lightest.
    if (player.resource < spell.cost) return;
    const cost = Math.min(player.resource, holdCost(spell, power));
    // A spender hits with the Fervour it is cashing in; what it costs is the
    // bonus on every blow after it. That is the whole trade.
    const fervour = getClass(session.classId).resource === "fervour" ? player.resource : 0;
    player.resource -= cost;

    if (spell.targeting === "self") {
      this.castOnSelf(sessionId, session, player, spell, now);
      return;
    }

    // The chain advances only if the last Strike was recent enough.
    let combo = 0;
    if (spell.id === "strike") {
      combo = now - session.comboAt <= STRIKE_COMBO_WINDOW_MS
        ? (session.comboStep % STRIKE_COMBO_LENGTH) + 1
        : 1;
      session.comboStep = combo;
      session.comboAt = now;
    }

    // Aim is client-supplied, like facing always was: it is only a direction,
    // and the shape test still bounds what it can reach.
    const yaw = Number.isFinite(aim) ? aim : player.yaw;
    const hits = this.resolveSpell(sessionId, player, spell, session, yaw, combo, fervour, now, { power });

    // Everyone nearby sees the cast, so a fight between other players and a
    // camp is something you can watch rather than a set of numbers changing.
    // The caster is told either way: silence on a miss is indistinguishable
    // from a dropped packet.
    this.broadcastNear(player.x, player.z, "cast", {
      by: sessionId, spell: spell.id, yaw, combo, power: Math.round(power * 100) / 100, hits,
    });
    this.landed(session, player, spell, hits, now);
  }

  /** What landing a blow does for the caster: they are fighting, and a blow
   *  that builds stokes Fervour. Only a landed one: otherwise the way to build
   *  it would be to stand in a field swinging at the air. */
  private landed(session: Session, player: Player, spell: Spell, hits: readonly CastHit[], now: number): void {
    if (hits.length === 0) return;
    session.combatUntil = now + COMBAT_LINGER_MS;
    if (getClass(session.classId).resource !== "fervour") return;
    let gained = spell.builds ?? 0;
    // Execute gives back for each kill it makes.
    if (spell.execute) gained += spell.execute.refund * hits.filter((hit) => hit.killed).length;
    if (gained > 0) player.resource = Math.min(player.maxResource, player.resource + gained);
  }

  /**
   * A spell with no target: something the caster does to themselves. Battle
   * Cry is the only one — Fervour to full, held there from draining for a
   * while, and everything near turned on the one who shouted — but it is
   * shaped like a table entry so the next is too.
   */
  private castOnSelf(sessionId: string, session: Session, player: Player, spell: Spell, now: number): void {
    if (spell.id === "battleCry") {
      player.resource = player.maxResource;
      session.fervourHoldUntil = now + BATTLE_CRY_HOLD_MS;
    }
    if (spell.taunt) {
      for (const [enemyId, enemy] of this.state.enemies) {
        const brain = this.brains.get(enemyId);
        if (!brain || enemy.state === EnemyState.Dead) continue;
        if (Math.hypot(enemy.x - player.x, enemy.z - player.z) > spell.taunt) continue;
        taunt(brain, sessionId);
        session.combatUntil = now + COMBAT_LINGER_MS;
      }
    }
    this.broadcastNear(player.x, player.z, "cast", {
      by: sessionId, spell: spell.id, yaw: player.yaw, combo: 0, power: 0, hits: [],
    });
  }

  /**
   * Apply a spell to whatever it catches, and describe what happened.
   * `fervour` is the caster's before paying for this cast; `power` how far a
   * hold was wound up; `only` restricts it to one creature (a Charge's).
   */
  private resolveSpell(
    sessionId: string,
    player: Player,
    spell: Spell,
    session: Session,
    yaw: number,
    combo: number,
    fervour: number,
    now: number,
    options: { power?: number; only?: string } = {},
  ): CastHit[] {
    // Where this player saw the world when they cast, not where it is now.
    const seen = this.rewind.lastSeenBy(sessionId);
    // Level and gear add to the spell through its attribute; Fervour
    // multiplies the lot, and so does a hold's wind-up.
    const totals = session.stats.totals;
    const power = options.power ?? 0;
    const hold = spell.hold;
    const base = spellDamage(spell, totals) * fervourMultiplier(fervour) * (hold ? 1 + (hold.fullDamage - 1) * power : 1);
    const critChance = critChanceFor(totals);
    const finisher = spell.id === "strike" && combo === STRIKE_COMBO_LENGTH;
    // Only a full wind-up staggers.
    const stagger = hold ? power >= 1 : spell.stagger;
    const knockback = finisher ? COMBO_FINISHER_KNOCKBACK
      : hold ? spell.knockback + (hold.fullKnockback - spell.knockback) * power
        : spell.knockback;

    const caught: Array<{ id: string; enemy: Enemy; range: number }> = [];

    for (const [enemyId, enemy] of this.state.enemies) {
      if (enemy.state === EnemyState.Dead) continue;
      if (options.only !== undefined && enemyId !== options.only) continue;
      const archetype = this.archetypeFor(enemy);

      const x = seen.value(enemy, "x");
      const z = seen.value(enemy, "z");
      const inside = isInSpellShape(spell, player.x, player.z, yaw, x, z, archetype.radius);
      if (!inside) continue;

      caught.push({ id: enemyId, enemy, range: Math.hypot(x - player.x, z - player.z) });
    }

    if (caught.length === 0) return [];

    // One-target spells take your selected target when it is in the shape,
    // and the nearest thing otherwise. Aiming at one creature and hitting the
    // one that wandered in front of it reads as the game ignoring you.
    const struck = spell.targeting === "all"
      ? caught
      : [caught.find((entry) => entry.id === session.targetId)
        ?? caught.reduce((closest, next) => (next.range < closest.range ? next : closest))];

    const hits: CastHit[] = [];
    let dealt = 0;
    for (const { id, enemy } of struck) {
      // A creature above you turns aside some blows and shrugs off part of
      // the rest (see LEVEL_GAP).
      const gap = levelGapEffect(enemy.level, session.level, BLOCK_REDUCTION);
      if (Math.random() < gap.miss) {
        const brain = this.brains.get(id);
        // A miss is still an attack: it knows who swung at it.
        if (brain) {
          takeHit(brain, this.archetypeFor(enemy), sessionId, 1, 0, 0, 0, false, now);
          this.rallyCampMates(id, brain, enemy, sessionId);
        }
        hits.push({ id, amount: 0, crit: false, killed: false, staggered: false, missed: true });
        continue;
      }
      const crit = Math.random() < critChance;
      // Execute: far more against something nearly finished.
      const finishing = spell.execute !== undefined && enemy.health <= enemy.maxHealth * spell.execute.below;
      const amount = Math.max(1, Math.round(
        base * gap.dealt * (finisher ? COMBO_FINISHER_MULTIPLIER : 1) * (crit ? CRIT_MULTIPLIER : 1)
          * (finishing ? spell.execute!.multiplier : 1),
      ));
      dealt += Math.min(amount, enemy.health);
      enemy.health = Math.max(0, enemy.health - amount);
      const killed = enemy.health === 0;
      const brain = this.brains.get(id);

      let staggered = false;
      if (killed) {
        this.killEnemy(id, enemy, sessionId, now);
      } else if (brain) {
        // Shoved directly away from the caster — from where it is now, since
        // that is where the shove happens.
        const dx = enemy.x - player.x;
        const dz = enemy.z - player.z;
        const length = Math.hypot(dx, dz) || 1;
        staggered = (stagger || finisher) && gap.staggers;
        const archetype = this.archetypeFor(enemy);
        takeHit(brain, archetype, sessionId, amount, dx / length, dz / length, knockback, staggered, now);
        // A golem shrugs it off; tell the client so it doesn't claim otherwise.
        if (archetype.staggerImmune) staggered = false;
        this.rallyCampMates(id, brain, enemy, sessionId);
      }

      hits.push({ id, amount, crit, killed, staggered });
    }

    // Leech heals by what the blow actually took, not what it would have —
    // overkill on a creature at 3 HP should not top you up.
    const healed = Math.floor(dealt * leechFraction(totals.leech));
    if (healed > 0 && player.health > 0) player.health = Math.min(player.maxHealth, player.health + healed);

    return hits;
  }

  /** Lay a creature down, start its respawn, pay out XP, and maybe leave
   *  something. */
  private killEnemy(id: string, enemy: Enemy, killerSessionId: string, now: number): void {
    enemy.state = EnemyState.Dead;
    const brain = this.brains.get(id);
    const fight = this.eliteOf.get(id);
    // Before calmDown: credit is read from the threat it forgets. Everyone
    // who fought it counts, not only the killing blow — a group should never
    // have to take turns at the last hit.
    const fighters = new Set<string>([killerSessionId, ...(brain?.threat.keys() ?? [])]);
    // ...and a party shares its kills: anyone in it close by counts as having
    // fought, for XP and for quests, so nobody in a group has to tag
    // everything to keep up.
    for (const sessionId of [...fighters]) {
      for (const mate of this.partyNear(sessionId, enemy.x, enemy.z, PARTY_SHARE_RANGE)) fighters.add(mate);
    }
    this.questKill(enemy, fighters, fight?.elite.id);
    if (fight) {
      this.eliteFell(id, fight, enemy, killerSessionId, now);
    } else if (!this.addOf.has(id)) {
      // Summoned creatures are part of the elite's fight, not a loot source,
      // and the elite's XP already covers them.
      this.rollDrop(enemy, killerSessionId);
      for (const sessionId of fighters) this.grantKillXp(sessionId, enemy.level, false);
    }
    if (brain) {
      calmDown(brain);
      brain.returning = false;
      brain.respawnAt = now + (fight ? ELITE_CORPSE_MS : ENEMY_RESPAWN_MS);
    }
  }

  /** Nothing killed in a dungeon gets back up: a cleared room stays cleared
   *  until the instance resets. */
  private get staysDead(): boolean {
    return this.ostra.dungeon !== undefined;
  }

  /** How much harder than its kind this creature hits: an elite's multiplier,
   *  and more once enraged, or a variant's. 1 for anything ordinary. */
  private eliteDamageScale(enemyId: string): number {
    const fight = this.eliteOf.get(enemyId);
    if (!fight) return getVariant(this.state.enemies.get(enemyId)?.variant)?.damage ?? 1;
    return fight.elite.damage * (fight.enraged ? ENRAGE_DAMAGE : 1);
  }

  /** Hit one of a camp and the others close by come too. Tight radius: pulling
   *  a whole camp with one bolt would make every fight the same fight. */
  private rallyCampMates(struckId: string, struck: EnemyBrain, enemy: Enemy, attacker: string): void {
    const camp = this.activeCamps.get(struck.campId);
    if (!camp) return;
    for (const id of camp.enemyIds) {
      if (id === struckId) continue;
      const mate = this.state.enemies.get(id);
      const brain = this.brains.get(id);
      if (!mate || !brain || mate.state === EnemyState.Dead) continue;
      if (Math.hypot(mate.x - enemy.x, mate.z - enemy.z) <= RALLY_RADIUS) rally(brain, attacker);
    }
  }

  /**
   * Whether a sprint request is honoured: out of combat, or in the first
   * moments of a fight, before the client can have heard of it. The client
   * only asks while it believes it is out of combat, so this makes the two
   * agree across the round trip (see SPRINT_GRACE_MS).
   */
  private canSprint(session: Session, player: Player, now: number): boolean {
    return !player.inCombat || now - session.combatStartedAt < SPRINT_GRACE_MS;
  }

  /** Being hunted or having traded blows recently both count as fighting. */
  private updateCombatFlags(now: number): void {
    for (const [sessionId, session] of this.sessions) {
      const player = this.state.players.get(sessionId);
      if (!player) continue;
      const fighting = player.health > 0 && (now < session.combatUntil || this.hunted.has(sessionId));
      if (player.inCombat !== fighting) {
        player.inCombat = fighting;
        if (fighting) session.combatStartedAt = now;
      }
    }
  }

  /**
   * Send a player their own class, XP, bag and gear.
   *
   * Private, so it goes by message rather than into replicated state — nobody
   * else needs to know what you carry. Stats are not sent: the client works
   * them out from the same keys with the same shared code, which is what lets
   * it preview an item before you wear it.
   */
  private sendProfile(sessionId: string, session: Session): void {
    this.clients.getById(sessionId)?.send("profile", {
      classId: session.classId,
      level: session.level,
      xp: session.xp,
      inventory: session.inventory,
      equipment: session.equipment,
      quests: session.quests,
      gold: session.gold,
      waystones: session.waystones,
      goods: session.goods,
      trades: session.trades,
    });
  }

  // --- experience ---------------------------------------------------------------

  private grantKillXp(sessionId: string, creatureLevel: number, elite: boolean): void {
    const session = this.sessions.get(sessionId);
    if (session) this.grantXp(sessionId, killXpFor(creatureLevel, session.level, elite));
  }

  /**
   * Add XP, and level up as many times as it pays for.
   *
   * A level-up refreshes everything that hangs off the level — base stats,
   * so the health cap; what can be worn and cast is read from `session.level`
   * wherever it is checked — and restores health, because the moment you
   * level should feel like one. Everyone nearby sees it happen.
   */
  private grantXp(sessionId: string, amount: number): void {
    const session = this.sessions.get(sessionId);
    const player = this.state.players.get(sessionId);
    if (!session || !player || amount <= 0 || session.level >= MAX_LEVEL) return;

    const result = addXp({ level: session.level, xp: session.xp }, amount);
    session.level = result.level;
    session.xp = result.xp;
    if (result.levelsGained > 0) {
      player.level = result.level;
      this.refreshStats(session, player);
      // Not for the dead: XP can arrive for a kill finished after you fell,
      // and a level-up is not a resurrection.
      if (player.health > 0) player.health = player.maxHealth;
      this.broadcastNear(player.x, player.z, "levelUp", { id: sessionId, level: result.level });
      parties.levelChanged(session.characterId, result.level);
    }
    this.clients.getById(sessionId)?.send("xp", { level: session.level, xp: session.xp, gained: amount });
  }

  // --- fishing ---------------------------------------------------------------------

  /**
   * Cast a line: straight ahead from where the player stands and faces, onto
   * the first water deep enough (`castPoint`). Refused out loud — no water,
   * in a fight, nothing here bites for you yet — so E never silently does
   * nothing.
   */
  private onFishCast(client: Client): void {
    const session = this.sessions.get(client.sessionId);
    const player = this.state.players.get(client.sessionId);
    const now = Date.now();
    if (!session || !player || session.transferring || player.health === 0) return;
    if (session.fishing || session.pendingCast || now < session.fishReadyAt) return;
    if (player.inCombat) {
      client.send("fishResult", { result: "combat" });
      return;
    }
    const point = castPoint(this.ostra.terrain, player.x, player.z, player.yaw);
    if (!point) {
      client.send("fishResult", { result: "noWater" });
      return;
    }
    const level = tradeLevel(session.trades, "fishing");
    const lowest = lowestCatchLevel(point.waters);
    if (level < lowest) {
      client.send("fishResult", { result: "tooLow", level: lowest, name: point.name, waters: point.waters });
      return;
    }
    session.fishing = { waters: point.waters, biteAt: now + biteDelayMs(level, Math.random()), windowEnd: 0 };
    player.fishing = FISHING_WAITING;
    player.bobberX = point.x;
    player.bobberZ = point.z;
  }

  /**
   * The click. Before a bite it only pulls the line in empty; during one it
   * lands whatever was on it, rolled here from what lives in that water at
   * this player's level.
   */
  private onFishHook(client: Client): void {
    const session = this.sessions.get(client.sessionId);
    const player = this.state.players.get(client.sessionId);
    const fishing = session?.fishing;
    if (!session || !player || !fishing) return;
    const now = Date.now();
    if (player.fishing !== FISHING_BITE) {
      this.endFishing(client.sessionId, session, player, "early", now);
      return;
    }
    if (now > fishing.windowEnd) {
      this.endFishing(client.sessionId, session, player, "missed", now);
      return;
    }

    const level = tradeLevel(session.trades, "fishing");
    const chances = catchChances(fishing.waters, level);
    let roll = Math.random();
    let fish = chances[chances.length - 1];
    for (const candidate of chances) {
      roll -= candidate.chance;
      if (roll <= 0) {
        fish = candidate;
        break;
      }
    }
    if (!fish) {
      this.endFishing(client.sessionId, session, player, "missed", now);
      return;
    }
    // A full satchel lets the fish go, but the catch still taught you something.
    const kept = addGoods(session.goods, fish.good, 1) > 0;
    this.endFishing(client.sessionId, session, player, "caught", now, { good: fish.good, kept });
    this.grantTradeXp(client.sessionId, session, "fishing", gatherXpFor(fish.level, level));
    if (kept) this.sendProfile(client.sessionId, session);
  }

  /** Once a tick: bites arrive, bites are missed, and a fight ends it all. */
  private stepFishing(now: number): void {
    for (const [sessionId, session] of this.sessions) {
      const fishing = session.fishing;
      if (!fishing) continue;
      const player = this.state.players.get(sessionId);
      if (!player) continue;
      if (player.health === 0 || player.inCombat || session.transferring) {
        this.endFishing(sessionId, session, player, "cancelled", now);
      } else if (player.fishing === FISHING_WAITING && now >= fishing.biteAt) {
        player.fishing = FISHING_BITE;
        fishing.windowEnd = now + biteWindowMs(tradeLevel(session.trades, "fishing"));
      } else if (player.fishing === FISHING_BITE && now > fishing.windowEnd) {
        this.endFishing(sessionId, session, player, "missed", now);
      }
    }
  }

  private endFishing(
    sessionId: string,
    session: Session,
    player: Player,
    result: "caught" | "missed" | "early" | "cancelled",
    now: number,
    detail: Record<string, unknown> = {},
  ): void {
    session.fishing = undefined;
    session.fishReadyAt = now + RECAST_MS;
    player.fishing = FISHING_NONE;
    this.clients.getById(sessionId)?.send("fishResult", { result, ...detail });
  }

  /**
   * Add XP to a trade. Only yours to know, like the pack: nobody nearby is
   * told, because a fishing level is not a moment the way a character level
   * is — but you are, with the level if it moved.
   */
  private grantTradeXp(sessionId: string, session: Session, trade: TradeId, amount: number): void {
    if (amount <= 0) return;
    const { from, to } = addTradeXp(session.trades, trade, amount);
    this.clients.getById(sessionId)?.send("trade", {
      trade, total: session.trades[trade] ?? 0, gained: amount, ...(to > from ? { levelUp: to } : {}),
    });
  }

  // --- quests ----------------------------------------------------------------------

  /** Close enough to a villager to be talking to them. */
  private nearVillager(player: Player, npc: string): boolean {
    const found = findVillager(npc);
    if (!found || !settlementsIn(this.ostra).includes(found.settlement)) return false;
    return Math.hypot(player.x - found.villager.x, player.z - found.villager.z) <= TALK_RANGE + 1;
  }

  private sendQuests(sessionId: string, session: Session): void {
    this.clients.getById(sessionId)?.send("quests", { quests: session.quests, gold: session.gold });
  }

  private onQuestAccept(client: Client, id: unknown): void {
    const session = this.sessions.get(client.sessionId);
    const player = this.state.players.get(client.sessionId);
    const quest = getQuest(id);
    if (!session || !player || !quest) return;
    if (!canTake(quest, session.quests, session.level) || !this.nearVillager(player, quest.giver)) return;
    session.quests.active[quest.id] = quest.objectives.map(() => 0);
    this.sendQuests(client.sessionId, session);
  }

  private onQuestAbandon(client: Client, id: unknown): void {
    const session = this.sessions.get(client.sessionId);
    const quest = getQuest(id);
    if (!session || !quest || session.quests.active[quest.id] === undefined) return;
    delete session.quests.active[quest.id];
    this.sendQuests(client.sessionId, session);
  }

  /**
   * Hand a quest in. The client names the item it chose (an index into the
   * choices `questRewardItems` gives this character — the same list the
   * client was shown); everything else is checked here: done, near whoever
   * takes it back, room in the bag.
   */
  private onQuestComplete(client: Client, id: unknown, choice: unknown): void {
    const session = this.sessions.get(client.sessionId);
    const player = this.state.players.get(client.sessionId);
    const quest = getQuest(id);
    if (!session || !player || !quest) return;
    const progress = session.quests.active[quest.id];
    if (!progress || !questReady(quest, progress) || !this.nearVillager(player, quest.turnIn)) return;

    const items = questRewardItems(quest, session.characterId, session.classId);
    const item = typeof choice === "number" && Number.isInteger(choice) ? items[choice] : undefined;
    if (items.length > 0 && item === undefined) return;
    if (item !== undefined && session.inventory.length >= INVENTORY_SIZE) {
      client.send("bagFull");
      return;
    }

    delete session.quests.active[quest.id];
    session.quests.done.push(quest.id);
    session.gold += quest.rewards.gold;
    if (item !== undefined) session.inventory.push(item);
    const xp = questXp(quest, session.level);

    this.sendProfile(client.sessionId, session);
    // Before the XP, so "quest complete" is on screen before any level-up
    // it pays for.
    this.clients.getById(client.sessionId)?.send("questDone", { quest: quest.id, item, xp });
    this.grantXp(client.sessionId, xp);
  }

  // --- vendors ---------------------------------------------------------------------

  /** A vendor, by villager id, that this player is standing close enough to. */
  private vendorNear(player: Player, id: unknown): string | undefined {
    if (typeof id !== "string") return undefined;
    const found = findVillager(id);
    if (!found?.villager.vendor || !this.nearVillager(player, id)) return undefined;
    return id;
  }

  /**
   * Sell one item from the bag, or — with no item — the whole bag. Worn gear
   * is never touched: selling is for what you are carrying, not wearing.
   */
  private onVendorSell(client: Client, vendor: unknown, key: unknown): void {
    const session = this.sessions.get(client.sessionId);
    const player = this.state.players.get(client.sessionId);
    if (!session || !player || !this.vendorNear(player, vendor)) return;

    let sold: ItemKey[];
    if (key === undefined) {
      sold = session.inventory;
      session.inventory = [];
    } else {
      const index = typeof key === "string" ? session.inventory.indexOf(key) : -1;
      if (index === -1) return;
      sold = session.inventory.splice(index, 1);
    }
    const gold = packValue(sold);
    if (sold.length === 0) return;
    session.gold += gold;
    this.sendProfile(client.sessionId, session);
    client.send("sold", { count: sold.length, gold });
  }

  /**
   * Sell goods from the satchel: all of one kind, or — with no kind — all of
   * it. Every vendor buys goods: a smith has no use for a pike, but a town
   * that trades in fish will always find one.
   */
  private onVendorSellGoods(client: Client, vendor: unknown, good: unknown): void {
    const session = this.sessions.get(client.sessionId);
    const player = this.state.players.get(client.sessionId);
    if (!session || !player || !this.vendorNear(player, vendor)) return;

    let sold: Goods;
    if (good === undefined) {
      sold = session.goods;
      session.goods = {};
    } else {
      if (!isGoodId(good) || !session.goods[good]) return;
      sold = { [good]: session.goods[good] };
      delete session.goods[good];
    }
    const count = goodsCount(sold);
    if (count === 0) return;
    const gold = goodsValue(sold);
    session.gold += gold;
    this.sendProfile(client.sessionId, session);
    client.send("sold", { count, gold, goods: true, ...(good !== undefined ? { good } : {}) });
  }

  /** Buy one piece of the vendor's stock — the same list `vendorStock` gives
   *  the client for this character's level. */
  private onVendorBuy(client: Client, vendor: unknown, index: unknown): void {
    const session = this.sessions.get(client.sessionId);
    const player = this.state.players.get(client.sessionId);
    const id = player ? this.vendorNear(player, vendor) : undefined;
    if (!session || !player || !id || typeof index !== "number" || !Number.isInteger(index)) return;
    const key = vendorStock(id, session.level, session.classId)[index];
    const item = key !== undefined ? describeItem(key) : undefined;
    if (!key || !item) return;
    const price = buyPrice(item);
    if (session.gold < price) {
      client.send("tooPoor", { price });
      return;
    }
    if (session.inventory.length >= INVENTORY_SIZE) {
      client.send("bagFull");
      return;
    }
    session.gold -= price;
    session.inventory.push(key);
    this.sendProfile(client.sessionId, session);
    client.send("bought", { item: key, price });
  }

  /**
   * A creature died: advance kill, slay and collect objectives for everyone
   * who fought it (anyone with threat on it, and whoever finished it).
   */
  private questKill(enemy: Enemy, fighters: ReadonlySet<string>, eliteId: string | undefined): void {
    for (const sessionId of fighters) {
      const session = this.sessions.get(sessionId);
      if (!session) continue;
      let changed = false;
      for (const [questId, progress] of Object.entries(session.quests.active)) {
        const quest = getQuest(questId);
        if (!quest) continue;
        quest.objectives.forEach((objective, i) => {
          const have = progress[i] ?? 0;
          if (have >= objectiveTarget(objective)) return;
          // A variant objective wants that variant; a plain one, the kind.
          const matches = (kind: string, variant: string | undefined): boolean =>
            variant !== undefined ? enemy.variant === variant : kind === enemy.kind;
          const counts = objective.kind === "kill" ? matches(objective.creature, objective.variant)
            : objective.kind === "slay" ? objective.elite === eliteId
              : objective.kind === "collect" ? matches(objective.from, objective.variant) && Math.random() < objective.chance
                : false;
          if (!counts) return;
          progress[i] = have + 1;
          changed = true;
        });
      }
      if (changed) this.sendQuests(sessionId, session);
    }
  }

  /**
   * Pick something up for a gather objective. The client names the spot; the
   * spot's place comes from `gatherSpots`, the same function the client drew
   * it from, and everything else is checked here: the quest is under way and
   * not yet done, you are standing at it, alive, and it is not one you
   * emptied in the last minute.
   */
  private onGather(client: Client, questId: unknown, objectiveIndex: unknown, spotIndex: unknown): void {
    const session = this.sessions.get(client.sessionId);
    const player = this.state.players.get(client.sessionId);
    const found = findGatherSpot(questId, objectiveIndex, spotIndex);
    if (!session || !player || !found || player.health === 0 || session.transferring) return;
    const { quest, spot } = found;
    const objective = quest.objectives[objectiveIndex as number];
    const progress = session.quests.active[quest.id];
    if (!progress || objective?.kind !== "gather" || (objective.ostra ?? "terra") !== this.ostra.id) return;
    const have = progress[objectiveIndex as number] ?? 0;
    if (have >= objective.count) return;
    if (Math.hypot(player.x - spot.x, player.z - spot.z) > GATHER_RANGE + 1) return;
    const key = `${quest.id}:${objectiveIndex as number}:${spot.index}`;
    const now = Date.now();
    if ((session.gathered.get(key) ?? 0) > now) return;

    session.gathered.set(key, now + GATHER_RESPAWN_MS);
    progress[objectiveIndex as number] = have + 1;
    client.send("gathered", { quest: quest.id, objective: objectiveIndex, spot: spot.index });
    this.sendQuests(client.sessionId, session);
  }

  /** Visit objectives, checked with the camps: twice a second is plenty for
   *  "are you standing at the stone yet". */
  private questVisits(): void {
    for (const [sessionId, session] of this.sessions) {
      const player = this.state.players.get(sessionId);
      if (!player || session.transferring) continue;
      let changed = false;
      for (const [questId, progress] of Object.entries(session.quests.active)) {
        const quest = getQuest(questId);
        quest?.objectives.forEach((objective, i) => {
          if (objective.kind !== "visit" || (progress[i] ?? 0) >= 1) return;
          if ((objective.ostra ?? "terra") !== this.ostra.id) return;
          if (Math.hypot(player.x - objective.x, player.z - objective.z) > objective.radius) return;
          progress[i] = 1;
          changed = true;
        });
      }
      if (changed) this.sendQuests(sessionId, session);
    }
  }

  // --- waystones -----------------------------------------------------------------

  /**
   * Wake any waystone a player has walked up to.
   *
   * Attunement is the unlock: you can only travel to stones you have stood
   * at, so the map opens up as you walk it rather than all at once. Checked
   * on the slow tick beside quest visits — a stone is 16 m wide to this and
   * nobody crosses that in a thirtieth of a second.
   */
  private wakeWaystones(): void {
    if (this.ostra.waystones.length === 0) return;
    for (const [sessionId, session] of this.sessions) {
      const player = this.state.players.get(sessionId);
      if (!player || session.transferring || player.health === 0) continue;
      const woke: string[] = [];
      for (const stone of this.ostra.waystones) {
        if (isAttuned(this.ostra, stone.id, session.waystones)) continue;
        if (Math.hypot(player.x - stone.x, player.z - stone.z) > WAYSTONE_ATTUNE_RANGE) continue;
        session.waystones.push(waystoneKey(this.ostra.id, stone.id));
        woke.push(stone.name);
      }
      if (woke.length > 0) this.sendWaystones(sessionId, session, woke);
    }
  }

  private sendWaystones(sessionId: string, session: Session, woke: readonly string[] = []): void {
    this.clients.getById(sessionId)?.send("waystones", { waystones: session.waystones, woke });
  }

  /**
   * Travel from the stone you are standing at to one you have woken.
   *
   * Free, and instant: Terra takes fourteen minutes to cross at a sprint, and
   * charging for the alternative would only mean walking. What it costs is
   * having been there — and being out of a fight, so it is never an escape.
   *
   * The stone you leave from does not have to be woken (you are standing in
   * front of it; there is nothing left to discover) but it does have to be a
   * stone: this is a waystone network, not a recall.
   */
  private onWaystoneTravel(client: Client, id: unknown): void {
    const session = this.sessions.get(client.sessionId);
    const player = this.state.players.get(client.sessionId);
    if (!session || !player || session.transferring || player.health === 0) return;
    if (Date.now() < session.combatUntil) return;

    const to = findWaystone(this.ostra, id);
    if (!to || !isAttuned(this.ostra, to.id, session.waystones)) return;

    const here = this.ostra.waystones.find((stone) =>
      Math.hypot(player.x - stone.x, player.z - stone.z) <= WAYSTONE_USE_RANGE);
    if (!here || here.id === to.id) return;

    const arrival = waystoneArrival(to);
    this.teleport(client, session, player, arrival.x, arrival.z, false);
    client.send("travelled", { id: to.id, name: to.name });
  }

  /** Send to everyone whose player is within EVENT_RANGE of a point. */
  private broadcastNear(x: number, z: number, type: string, payload: unknown): void {
    for (const client of this.clients) {
      const player = this.state.players.get(client.sessionId);
      if (!player) continue;
      if (Math.hypot(player.x - x, player.z - z) > EVENT_RANGE) continue;
      client.send(type, payload);
    }
  }

  /**
   * Maybe leave something behind.
   *
   * Rarity is tilted by danger — the Ostra's, and the creature's level — so
   * Barals pays better than Terra and the far wilds better than the Gate
   * Circle. Without that, a harder place is pure downside and nobody would go.
   */
  private rollDrop(enemy: Enemy, killerSessionId: string): void {
    const archetype = this.archetypeFor(enemy);
    if (Math.random() >= archetype.dropChance) return;

    const item = rollDrop(Math.random, {
      creatureLevel: enemy.level,
      ostraDanger: this.ostra.difficulty.health,
      danger: dropDanger(this.ostra.difficulty.health, enemy.level),
      // Elites pay out through `eliteFell`; see SOURCE_ODDS in loot.ts.
      source: "creature",
      // Only what whoever earned it can use.
      classId: this.sessions.get(killerSessionId)?.classId ?? DEFAULT_CLASS,
      signature: archetype.signature,
    });
    if (item !== undefined) this.dropOnGround(item, enemy.x, enemy.z, killerSessionId);
  }

  /** `claimMs`: how long only `claimedBy` may take it. An elite's drops are
   *  personal for as long as they lie there. */
  private dropOnGround(item: ItemKey, x: number, z: number, claimedBy: string, claimMs = LOOT_CLAIM_MS): void {
    const id = `g${this.nextGroundId++}`;
    this.state.ground.set(id, new GroundItem({
      item,
      claimedBy,
      x,
      y: groundHeight(this.ostra, x, z),
      z,
    }));
    this.groundExpiry.set(id, Date.now() + GROUND_ITEM_TTL_MS);
    this.groundClaimUntil.set(id, Date.now() + claimMs);
  }

  // --- development cheats ------------------------------------------------------

  /**
   * One entry point for every cheat, so there is exactly one message to leave
   * unregistered in production. Every argument is validated like any other
   * client input — dev tools are still a network surface on a shared dev box.
   */
  private onDev(client: Client, message: Record<string, unknown>): void {
    const session = this.sessions.get(client.sessionId);
    const player = this.state.players.get(client.sessionId);
    if (!session || !player || session.transferring) return;
    const number = (value: unknown, fallback: number, min: number, max: number): number =>
      typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
    const now = Date.now();

    switch (message["cmd"]) {
      case "teleport": {
        const limit = this.ostra.size / 2 - PLAYER_RADIUS;
        this.teleport(client, session, player,
          number(message["x"], player.x, -limit, limit),
          number(message["z"], player.z, -limit, limit),
          message["travel"] === true);
        break;
      }
      case "scatter": {
        // One of every rarity, and a few more, around the player. Inside
        // PICKUP_RADIUS it goes straight into the bag; further out, it lies
        // there to be looked at.
        const level = Math.round(number(message["level"], 30, 1, 1000));
        const radius = number(message["spread"], 3, 0, 20);
        const items = [...RARITIES, ...RARITIES.slice(0, 3)].map((rarity) => rollDebugItem(Math.random, rarity, level, session.classId));
        items.forEach((item, index) => {
          if (item === undefined) return;
          const angle = (index / items.length) * Math.PI * 2;
          this.dropOnGround(item, player.x + Math.sin(angle) * radius, player.z + Math.cos(angle) * radius, client.sessionId);
        });
        break;
      }
      case "give": {
        const rarity = RARITIES.find((r) => r === message["rarity"]);
        if (!rarity) return;
        const level = Math.round(number(message["level"], 30, 1, 1000));
        const count = Math.round(number(message["count"], 1, 1, INVENTORY_SIZE));
        for (let i = 0; i < count && session.inventory.length < INVENTORY_SIZE; i++) {
          const item = rollDebugItem(Math.random, rarity, level, session.classId);
          if (item !== undefined) session.inventory.push(item);
        }
        this.sendProfile(client.sessionId, session);
        break;
      }
      case "clearBag":
        session.inventory = [];
        this.sendProfile(client.sessionId, session);
        break;
      case "goods": {
        // Some of one good, or with none named, a few of every one.
        const count = Math.round(number(message["count"], 10, 1, 1000));
        const ids = isGoodId(message["good"]) ? [message["good"]] : GOOD_IDS;
        for (const id of ids) addGoods(session.goods, id, count);
        this.sendProfile(client.sessionId, session);
        break;
      }
      case "heal":
        player.health = player.maxHealth;
        player.resource = player.maxResource;
        break;
      case "god":
        session.god = message["on"] === true;
        break;
      case "level": {
        // Straight to a level, at the start of it. Gear above it stays on:
        // this is for trying things, not for testing the equip rules.
        session.level = Math.round(number(message["value"], session.level, 1, MAX_LEVEL));
        session.xp = 0;
        player.level = session.level;
        this.refreshStats(session, player);
        client.send("xp", { level: session.level, xp: session.xp, gained: 0 });
        parties.levelChanged(session.characterId, session.level);
        break;
      }
      case "xp":
        this.grantXp(client.sessionId, Math.round(number(message["amount"], 0, 0, 10_000_000)));
        break;
      case "trade": {
        // XP into a trade, as if earned; or with a level, straight to the start of it.
        const trade = isTradeId(message["trade"]) ? message["trade"] : "fishing";
        if (message["level"] === undefined) {
          this.grantTradeXp(client.sessionId, session, trade, Math.round(number(message["amount"], 0, 0, 1_000_000)));
          break;
        }
        const target = Math.round(number(message["level"], 1, 1, MAX_TRADE_LEVEL));
        let total = 0;
        for (let level = 1; level < target; level++) total += tradeXpToNext(level);
        session.trades[trade] = total;
        client.send("trade", { trade, total, gained: 0 });
        break;
      }
      case "elites": {
        // Every elite in this Ostra: alive and where, or how long until it wakes.
        client.send("eliteStatus", elitesIn(this.ostra.id).map((elite) => {
          const enemyId = this.liveElites.get(elite.id);
          const enemy = enemyId !== undefined ? this.state.enemies.get(enemyId) : undefined;
          const timer = this.timers.get(this.eliteKey(elite)) ?? 0;
          const alive = enemy !== undefined && enemy.state !== EnemyState.Dead;
          return {
            id: elite.id,
            name: elite.name,
            level: eliteLevel(this.ostra, elite),
            alive,
            x: enemy?.x ?? elite.x,
            z: enemy?.z ?? elite.z,
            // A corpse still lying there has already started its timer.
            wakesInMs: alive ? 0 : Math.max(0, timer - now),
          };
        }));
        break;
      }
      case "questsFinish":
        // Every objective of everything under way, done — hand-ins still
        // have to be walked to.
        for (const [id, progress] of Object.entries(session.quests.active)) {
          const quest = getQuest(id);
          quest?.objectives.forEach((objective, i) => { progress[i] = objectiveTarget(objective); });
        }
        this.sendQuests(client.sessionId, session);
        break;
      case "questsReset":
        session.quests = { active: {}, done: [] };
        this.sendQuests(client.sessionId, session);
        break;
      case "respawnElites":
        // Timers set to now, so the next check wakes them — with the
        // announcement, which is the point of testing it.
        for (const elite of elitesIn(this.ostra.id)) {
          if (this.timers.has(this.eliteKey(elite))) this.timers.set(this.eliteKey(elite), now);
        }
        break;
      case "killNear": {
        const radius = number(message["radius"], 25, 1, 200);
        for (const [id, enemy] of this.state.enemies) {
          if (enemy.state === EnemyState.Dead) continue;
          if (Math.hypot(enemy.x - player.x, enemy.z - player.z) > radius) continue;
          enemy.health = 0;
          this.killEnemy(id, enemy, client.sessionId, now);
        }
        break;
      }
    }
  }

  /**
   * Put a player somewhere else in this Ostra, instantly.
   *
   * The same shape as waking at a waystone: the server moves them, the client
   * is told so it can have ground under them on the first frame, and anything
   * that was chasing lets go. `travel` leaves a Gate under them armed, which
   * is how the dev menu steps through to another Ostra.
   */
  private teleport(client: Client, session: Session, player: Player, x: number, z: number, travel: boolean): void {
    player.x = x;
    player.z = z;
    player.y = groundHeight(this.ostra, x, z);
    this.standStill(player);
    if (session.fishing) this.endFishing(client.sessionId, session, player, "cancelled", Date.now());
    session.suppressedGate = travel ? undefined : this.gateContaining(x, z)?.id;
    this.releaseFrom(client.sessionId);
    client.send("teleported", { x, z });
    this.updateCamps(Date.now());
  }

  /** Put down mid-jump or mid-dodge (a teleport, a respawn): no velocity or
   *  dash carries across. The dodge's cooldown does. */
  private standStill(player: Player): void {
    player.vy = 0;
    player.dodgeLeft = 0;
    player.dashLeft = 0;
    player.dashKind = 0;
  }

  /**
   * The heal: a share of your health back at once, if it is ready and you
   * are standing. Everyone near sees it, so a party knows who just used theirs.
   */
  private tryHeal(sessionId: string, session: Session, player: Player, now: number): void {
    if (player.health === 0 || now < session.healReadyAt) return;
    session.healReadyAt = now + HEAL_COOLDOWN_MS;
    const amount = Math.min(player.maxHealth - player.health, Math.round(player.maxHealth * HEAL_FRACTION));
    player.health += amount;
    this.broadcastNear(player.x, player.z, "healed", { id: sessionId, amount, readyIn: HEAL_COOLDOWN_MS });
  }

  /** Every creature forgets this player: no threat, no quarry, no blow on
   *  its way to them. */
  private releaseFrom(sessionId: string): void {
    for (const brain of this.brains.values()) {
      brain.threat.delete(sessionId);
      if (brain.quarry === sessionId) brain.quarry = undefined;
      if (brain.windupTarget === sessionId) {
        brain.windupUntil = 0;
        brain.windupTarget = undefined;
      }
    }
  }

  /** Hand out anything a living player is standing on, and clear what has
   *  lain too long. */
  private processGround(now: number): void {
    if (this.state.ground.size === 0) return;

    for (const [groundId, dropped] of this.state.ground) {
      if ((this.groundExpiry.get(groundId) ?? 0) <= now) {
        this.state.ground.delete(groundId);
        this.groundExpiry.delete(groundId);
        this.groundClaimUntil.delete(groundId);
        continue;
      }

      // The claim lapses on its own, so a drop nobody collects still becomes
      // everyone's rather than lying there reserved forever.
      if (dropped.claimedBy !== "" && (this.groundClaimUntil.get(groundId) ?? 0) <= now) {
        dropped.claimedBy = "";
        this.groundClaimUntil.delete(groundId);
      }

      for (const [sessionId, player] of this.state.players) {
        if (player.health === 0) continue;
        const session = this.sessions.get(sessionId);
        if (!session || session.transferring) continue;
        if (Math.hypot(player.x - dropped.x, player.z - dropped.z) > PICKUP_RADIUS) continue;
        // Still someone else's. A party does not share claims: pickup is by
        // walking over, so a shared claim goes to whoever runs through first.
        // It shares the kill's XP and quest credit instead (see killEnemy).
        if (dropped.claimedBy !== "" && dropped.claimedBy !== sessionId) continue;

        // A full bag leaves it lying there rather than silently eating it.
        if (session.inventory.length >= INVENTORY_SIZE) {
          this.clients.getById(sessionId)?.send("pickupFailed", { item: dropped.item });
          continue;
        }

        session.inventory.push(dropped.item);
        this.state.ground.delete(groundId);
        this.groundExpiry.delete(groundId);
        this.groundClaimUntil.delete(groundId);
        this.clients.getById(sessionId)?.send("picked", { item: dropped.item });
        this.sendProfile(sessionId, session);
        break;
      }
    }
  }

  /**
   * Wear something from the bag. `slot` chooses between the places an item
   * can go (which ring finger, which hand for a dagger); without one it goes
   * wherever `preferredSlot` says, which is what a plain click means.
   */
  private onEquip(client: Client, key: unknown, requestedSlot: unknown): void {
    const session = this.sessions.get(client.sessionId);
    const player = this.state.players.get(client.sessionId);
    if (!session || !player || typeof key !== "string") return;

    const index = session.inventory.indexOf(key);
    if (index === -1) return;
    const item = describeItem(key);
    if (!item) return;
    // The client says so before you try; this is what makes it so.
    if (!canWear(item, { classId: session.classId, level: session.level })) {
      client.send("cannotWear", { level: item.requiredLevel, family: item.family });
      return;
    }

    const slot = isEquipSlot(requestedSlot) && slotsFor(item).includes(requestedSlot)
      ? requestedSlot
      : preferredSlot(session.equipment, item);
    const result = wear(session.equipment, item, slot);
    if (!result) return;

    // Everything displaced goes back in the bag rather than vanishing — so a
    // two-hander replacing a sword and a shield needs room for both. A bag
    // already over its size (gear spilled by a rules change) may still wear
    // things, as long as the bag does not grow: that is how it empties.
    const after = session.inventory.length - 1 + result.removed.length;
    if (after > INVENTORY_SIZE && after > session.inventory.length) {
      client.send("bagFull");
      return;
    }

    session.inventory.splice(index, 1);
    session.inventory.push(...result.removed);
    session.equipment = result.next;
    this.applyEquipment(client.sessionId, session, player);
  }

  private onUnequip(client: Client, slot: unknown): void {
    const session = this.sessions.get(client.sessionId);
    const player = this.state.players.get(client.sessionId);
    if (!session || !player || !isEquipSlot(slot)) return;

    const worn = session.equipment[slot];
    if (worn === undefined) return;
    if (session.inventory.length >= INVENTORY_SIZE) {
      client.send("bagFull");
      return;
    }

    delete session.equipment[slot];
    session.inventory.push(worn);
    this.applyEquipment(client.sessionId, session, player);
  }

  /** Throw something away for good. The client asks first; by the time this
   *  arrives the player has already said yes. */
  private onDestroy(client: Client, key: unknown): void {
    const session = this.sessions.get(client.sessionId);
    const player = this.state.players.get(client.sessionId);
    if (!session || !player || typeof key !== "string") return;

    const index = session.inventory.indexOf(key);
    if (index === -1) return;
    session.inventory.splice(index, 1);
    this.sendProfile(client.sessionId, session);
  }

  /** Recompute the caps gear provides, and tell the owner. */
  private applyEquipment(sessionId: string, session: Session, player: Player): void {
    this.refreshStats(session, player);
    this.sendProfile(sessionId, session);
  }

  /**
   * Work out what this character adds up to now — class and level, and the
   * worn set — and move the caps to match.
   *
   * Current health and resource are clamped rather than scaled: taking off
   * armour should not kill you, but it must not leave you above your new
   * ceiling either.
   */
  private refreshStats(session: Session, player: Player): void {
    session.stats = characterStats(session.equipment, { classId: session.classId, level: session.level });
    player.maxHealth = maxHealthFor(session.stats.totals);
    player.maxResource = maxResourceFor(getClass(session.classId).resource, session.stats.totals);
    if (player.health > player.maxHealth) player.health = player.maxHealth;
    if (player.resource > player.maxResource) player.resource = player.maxResource;
  }

  /** How the class's resource moves this tick, per second. */
  private resourceRate(session: Session, player: Player, now: number): number {
    if (getClass(session.classId).resource === "mana") {
      return manaRegenFor(session.stats.totals, session.stats.heavyPieces, player.inCombat);
    }
    // Fervour: rises while you fight, holds after a Battle Cry, drains once
    // the fight is over.
    // Holding a guard is not fighting back: Fervour drains while you do.
    if (player.blocking) return -FERVOUR_PER_SECOND;
    if (player.inCombat) return FERVOUR_PER_SECOND;
    return now < session.fervourHoldUntil ? 0 : -FERVOUR_DRAIN_PER_SECOND;
  }

  /** The resource moves by its own rules; health only comes back at rest. */
  private regenerate(dt: number, now: number): void {
    for (const [sessionId, session] of this.sessions) {
      const player = this.state.players.get(sessionId);
      if (!player) continue;
      if (player.health === 0) {
        session.resourceCarry = 0;
        session.healthCarry = 0;
        continue;
      }

      // Accumulate the fraction: at 4/s and 30Hz each step is 0.13 of a
      // point, and rounding that per-tick would move exactly nothing.
      const rate = this.resourceRate(session, player, now);
      const full = rate > 0 && player.resource >= player.maxResource;
      const empty = rate < 0 && player.resource <= 0;
      if (rate === 0 || full || empty) {
        session.resourceCarry = 0;
      } else {
        session.resourceCarry += rate * dt;
        const whole = Math.trunc(session.resourceCarry);
        if (whole !== 0) {
          session.resourceCarry -= whole;
          player.resource = Math.max(0, Math.min(player.maxResource, player.resource + whole));
        }
      }

      if (!player.inCombat && player.health < player.maxHealth) {
        session.healthCarry += player.maxHealth * HEALTH_REGEN_FRACTION_PER_SECOND
          * recoveryMultiplier(session.stats.totals.recovery) * dt;
        const whole = Math.floor(session.healthCarry);
        if (whole > 0) {
          session.healthCarry -= whole;
          player.health = Math.min(player.maxHealth, player.health + whole);
        }
      } else {
        session.healthCarry = 0;
      }
    }
  }

  /**
   * A creature's blow lands. `raw` is before armour; `attackerLevel` is what
   * armour is measured against.
   */
  private damagePlayer(sessionId: string, raw: number, byEnemyId: string, attackerLevel: number): void {
    const player = this.state.players.get(sessionId);
    const session = this.sessions.get(sessionId);
    if (!player || !session || player.health === 0) return;

    const now = Date.now();
    if (session.god) return;
    // Mid-dodge, the blow finds nothing there. Checked when it lands, like
    // every other test of a blow, against where the server has you.
    if (isDodging(player)) {
      this.broadcastNear(player.x, player.z, "evade", { id: sessionId, by: byEnemyId });
      return;
    }
    const reduction = armourReduction(session.stats.totals.armour, attackerLevel);
    const gap = levelGapEffect(attackerLevel, session.level, BLOCK_REDUCTION);
    // A raised guard takes most of a blow from the front. The front is judged
    // from where the blow came from — the creature, or a slam's centre — and
    // where you face, which is where your camera looks.
    const source = this.state.enemies.get(byEnemyId);
    let blocked = false;
    if (player.blocking && source) {
      const bearing = Math.atan2(source.x - player.x, source.z - player.z);
      const off = Math.abs(Math.atan2(Math.sin(bearing - player.yaw), Math.cos(bearing - player.yaw)));
      blocked = off <= BLOCK_ARC;
    }
    // Shield Bash: a guard raised just before the blow takes all of it, and
    // throws its maker off balance.
    if (blocked && source && now - session.guardUpAt <= PERFECT_BLOCK_MS
      && knowsSpell(session.classId, session.level, "shieldBash")) {
      this.perfectBlock(sessionId, session, player, byEnemyId, source, now);
      return;
    }
    const amount = Math.max(1, Math.round(raw * gap.taken * (1 - reduction) * (blocked ? 1 - gap.block : 1)));
    player.health = Math.max(0, player.health - amount);
    // Holding an elite's attention is a share of the fight (see eliteFell).
    const fight = this.eliteOf.get(byEnemyId);
    if (fight) fight.taken.set(sessionId, (fight.taken.get(sessionId) ?? 0) + amount);
    session.combatUntil = now + COMBAT_LINGER_MS;
    this.broadcastNear(player.x, player.z, "damage", { id: sessionId, amount, by: byEnemyId, blocked });

    if (player.health === 0) {
      session.respawnAt = now + PLAYER_RESPAWN_MS;
      player.blocking = false;
      session.pendingCast = undefined;
      this.endHold(sessionId, session, player, false, now);
      this.endChannel(sessionId, session, player);
      session.dash = undefined;
      session.diedAtX = player.x;
      session.diedAtZ = player.z;
      session.combatUntil = 0;
      player.inCombat = false;
      // Fervour is the fight's; the fight is over.
      if (getClass(session.classId).resource === "fervour") player.resource = 0;
      this.broadcastNear(player.x, player.z, "died", { id: sessionId });
      // And a share of the way through this level (see DEATH_XP_SHARE).
      const lost = deathXpLoss({ level: session.level, xp: session.xp });
      if (lost > 0) {
        session.xp -= lost;
        this.clients.getById(sessionId)?.send("xp", { level: session.level, xp: session.xp, gained: -lost });
      }
    }
  }

  /**
   * A perfect block, with Shield Bash learned: the blow does nothing, its
   * maker staggers and is shoved back, and the guard pays in Fervour — the one
   * time holding a shield builds it rather than draining it.
   */
  private perfectBlock(sessionId: string, session: Session, player: Player, enemyId: string, enemy: Enemy, now: number): void {
    const bash = SPELLS.shieldBash;
    const brain = this.brains.get(enemyId);
    let staggered = false;
    if (brain && enemy.state !== EnemyState.Dead) {
      const archetype = this.archetypeFor(enemy);
      const dx = enemy.x - player.x;
      const dz = enemy.z - player.z;
      const length = Math.hypot(dx, dz) || 1;
      staggered = levelGapEffect(enemy.level, session.level, BLOCK_REDUCTION).staggers && !archetype.staggerImmune;
      takeHit(brain, archetype, sessionId, 1, dx / length, dz / length, bash.knockback, staggered, now);
    }
    if (getClass(session.classId).resource === "fervour") {
      player.resource = Math.min(player.maxResource, player.resource + (bash.builds ?? 0));
    }
    session.combatUntil = now + COMBAT_LINGER_MS;
    this.broadcastNear(player.x, player.z, "damage", {
      id: sessionId, amount: 0, by: enemyId, blocked: true, perfect: true, staggered,
    });
  }

  /** Stand the dead back up once their timer is out. */
  private processRespawns(now: number): void {
    for (const [enemyId, enemy] of this.state.enemies) {
      if (enemy.state !== EnemyState.Dead) continue;
      const brain = this.brains.get(enemyId);
      if (!brain || now < brain.respawnAt) continue;

      // An elite does not get back up; it comes back, much later, as a new
      // spawn (see `updateElites`). What it summoned never comes back at all,
      // and nor does anything in a dungeon: the body is cleared away instead.
      const fight = this.eliteOf.get(enemyId);
      if (fight || this.addOf.has(enemyId) || this.staysDead) {
        this.state.enemies.delete(enemyId);
        this.brains.delete(enemyId);
        this.eliteOf.delete(enemyId);
        this.addOf.delete(enemyId);
        if (fight) this.liveElites.delete(fight.elite.id);
        continue;
      }

      // Back at its spawn rather than where it fell, so a cleared camp
      // reassembles instead of drifting wherever players dragged it.
      enemy.x = brain.homeX;
      enemy.z = brain.homeZ;
      enemy.y = groundHeight(this.ostra, brain.homeX, brain.homeZ);
      enemy.health = enemy.maxHealth;
      enemy.state = EnemyState.Idle;
      calmDown(brain);
      brain.timer = 0;
      brain.returning = false;
    }

    for (const [sessionId, session] of this.sessions) {
      const player = this.state.players.get(sessionId);
      if (!player || player.health > 0 || now < session.respawnAt) continue;

      // The nearest waystone to where they fell, not the far side of the map.
      const spot = respawnPoint(this.ostra, session.diedAtX, session.diedAtZ);
      player.x = spot.x;
      player.z = spot.z;
      player.y = groundHeight(this.ostra, spot.x, spot.z);
      this.standStill(player);
      player.health = player.maxHealth;
      player.resource = getClass(session.classId).resource === "fervour" ? 0 : player.maxResource;
      session.resourceCarry = 0;
      session.healthCarry = 0;
      session.fervourHoldUntil = 0;
      session.comboStep = 0;
      // Whatever they were standing in when they died must not fire on arrival.
      session.suppressedGate = this.gateContaining(spot.x, spot.z)?.id;
      // Anything still locked onto them lets go. Without this a creature that
      // followed them keeps its quarry and resumes the moment they stand up.
      this.releaseFrom(sessionId);
      this.clients.getById(sessionId)?.send("respawned", { x: spot.x, z: spot.z });
      // A waystone in the wilds has camps around it that went to sleep while
      // they were away.
      this.updateCamps(now);
    }
  }

  private scaledHealth(base: number, level: number): number {
    // Health travels as a uint16; past that it would wrap to nearly nothing.
    return Math.max(1, Math.min(65535, Math.round(base * this.ostra.difficulty.health * levelHealthScale(level))));
  }

  /** Falls back rather than throwing: a stored kind this build no longer knows
   *  should not take the whole room's simulation down. Elites get their kind
   *  scaled to their size, the same way the client reads them. */
  private archetypeFor(enemy: Enemy): EnemyArchetype {
    return scaledArchetype(isEnemyKind(enemy.kind) ? enemy.kind : "zombie", enemy.scale);
  }

  // --- rare elites -------------------------------------------------------------

  /** Wake any elite whose timer has run out. Checked with the camps. */
  private updateElites(now: number): void {
    for (const elite of elitesIn(this.ostra.id)) {
      if (this.liveElites.has(elite.id)) continue;
      const timer = this.timers.get(this.eliteKey(elite));
      if (timer !== undefined && now < timer) continue;
      // Only a return is news. The first spawn of a fresh room is just the
      // world being as it is — announcing eight at once would be noise.
      this.spawnElite(elite, timer !== undefined);
    }
  }

  private eliteKey(elite: EliteDefinition): string {
    return `${this.realmId}:${elite.id}`;
  }

  /** The realm's elite timers, or this dungeon instance's own. */
  private get timers(): Map<string, number> {
    return this.ostra.dungeon ? this.instanceEliteTimers : eliteTimers;
  }

  private spawnElite(elite: EliteDefinition, announce: boolean): void {
    const level = eliteLevel(this.ostra, elite);
    const maxHealth = Math.min(65535, Math.round(
      this.scaledHealth(getArchetype(elite.kind).maxHealth, level) * elite.health,
    ));
    const id = `e${this.nextEnemyId++}`;
    this.state.enemies.set(id, new Enemy({
      kind: elite.kind,
      name: elite.name,
      // Rounded to the float32 it travels as, so the server's scaled
      // archetype is bit-for-bit the one the client builds from the wire.
      scale: Math.fround(elite.scale),
      x: elite.x,
      y: groundHeight(this.ostra, elite.x, elite.z),
      z: elite.z,
      yaw: Math.random() * Math.PI * 2,
      health: maxHealth,
      maxHealth,
      level,
      state: EnemyState.Idle,
    }));
    this.brains.set(id, createBrain(elite.x, elite.z, `elite:${elite.id}`, maxHealth));
    this.eliteOf.set(id, {
      elite,
      engaged: false,
      taken: new Map(),
      spent: new Set(),
      adds: new Set(),
      enraged: false,
      nextSlamAt: 0,
      slam: undefined,
    });
    this.liveElites.set(elite.id, id);
    // The whole Ostra hears it, not just whoever is nearby: an elite is worth
    // crossing the map for.
    if (!announce) return;
    this.broadcast("elite", {
      event: "woke",
      name: elite.name,
      title: elite.title,
      region: regionOf(this.ostra, elite.x, elite.z)?.name ?? this.ostra.name,
    });
  }

  /**
   * An elite fell: start its long timer, tell everyone, and pay out — to every
   * player who earned a share of the fight, each their own drops, reserved
   * for them for as long as the drops lie there. The corpse is removed after
   * ELITE_CORPSE_MS rather than getting back up like an ordinary creature.
   *
   * Called before the brain calms down, because credit is read from its
   * threat, which is exactly the damage each player dealt it this fight.
   */
  private eliteFell(enemyId: string, fight: EliteFight, enemy: Enemy, killerSessionId: string, now: number): void {
    const elite = fight.elite;
    const [low, high] = elite.respawnMinutes;
    // A dungeon's boss is gone for the life of the instance.
    this.timers.set(this.eliteKey(elite), this.staysDead
      ? Infinity
      : now + (low + Math.random() * (high - low)) * 60_000);
    this.removeAdds(fight);

    const threat = this.brains.get(enemyId)?.threat;
    const credited: string[] = [];
    for (const [sessionId, player] of this.state.players) {
      const dealt = threat?.get(sessionId) ?? 0;
      const taken = fight.taken.get(sessionId) ?? 0;
      if (dealt >= enemy.maxHealth * CREDIT_DAMAGE_SHARE || taken >= player.maxHealth * CREDIT_TAKEN_SHARE) {
        credited.push(sessionId);
      }
    }
    // Nobody reached a share — a dev kill, or one blow finishing something no
    // one else fought. Whoever finished it still gets something.
    if (credited.length === 0) credited.push(killerSessionId);
    // A party earns together: anyone in a credited player's party who was
    // there, alive, shares it — the share rule is for strangers who happened
    // by, not for friends who came down together.
    for (const sessionId of [...credited]) {
      for (const mate of this.partyNear(sessionId, enemy.x, enemy.z, PARTY_SHARE_RANGE)) {
        if (!credited.includes(mate)) credited.push(mate);
      }
    }

    credited.forEach((sessionId, who) => {
      // The same credit rule as the loot: a share of the fight, not a touch.
      this.grantKillXp(sessionId, enemy.level, true);
      for (let i = 0; i < elite.drops; i++) {
        const item = rollDrop(Math.random, {
          creatureLevel: enemy.level,
          ostraDanger: this.ostra.difficulty.health,
          danger: dropDanger(this.ostra.difficulty.health, enemy.level),
          // A dungeon's boss pays from the dungeon table: the first place
          // mythic is the usual rather than the lucky.
          source: this.ostra.dungeon ? "dungeon" : "elite",
          // Each credited player's drops are for their own class.
          classId: this.sessions.get(sessionId)?.classId ?? DEFAULT_CLASS,
        });
        if (item === undefined) continue;
        // Spread round the body, each player's in their own arc, so a pile of
        // drops reads as several and yours are easy to tell apart.
        const angle = ((who + i / elite.drops) / credited.length) * Math.PI * 2;
        const reach = 1.2 + 0.4 * who;
        this.dropOnGround(item, enemy.x + Math.sin(angle) * reach, enemy.z + Math.cos(angle) * reach, sessionId,
          GROUND_ITEM_TTL_MS);
      }
    });

    if (this.staysDead) {
      this.broadcast("dungeonCleared", { name: this.ostra.name, boss: elite.name });
    }

    const names = credited.map((sessionId) => this.state.players.get(sessionId)?.name ?? "someone");
    this.broadcast("elite", {
      event: "fell",
      name: elite.name,
      title: elite.title,
      by: names.length <= 3 ? names.join(", ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} others`,
    });
  }

  /**
   * Each tick, for each live elite: notice whether it is in a fight, and if so
   * run its abilities. A fight that ends — everyone dead, gone, or the leash
   * snapped — resets it: summons vanish, spent triggers re-arm, and it walks
   * home to heal, so it cannot be worn down in shifts.
   */
  private stepElites(now: number): void {
    for (const [id, fight] of this.eliteOf) {
      const enemy = this.state.enemies.get(id);
      const brain = this.brains.get(id);
      if (!enemy || !brain || enemy.state === EnemyState.Dead) continue;

      const engaged = brain.threat.size > 0 && !brain.returning;
      if (!engaged) {
        if (fight.engaged) this.resetFight(fight, brain);
        continue;
      }
      fight.engaged = true;

      const health = enemy.health / Math.max(1, enemy.maxHealth);
      for (const ability of fight.elite.abilities) {
        switch (ability.kind) {
          case "summon":
            for (const at of ability.at) {
              const key = `summon:${at}`;
              if (health > at || fight.spent.has(key)) continue;
              fight.spent.add(key);
              this.summon(id, enemy, brain, fight, ability.creature, ability.count);
              this.eliteCry(enemy, ability.cry);
            }
            break;
          case "enrage":
            if (!fight.enraged && health <= ability.at) {
              fight.enraged = true;
              this.eliteCry(enemy, ability.cry);
            }
            break;
          case "slam":
            this.stepSlam(id, enemy, brain, fight, ability, now);
            break;
        }
      }
    }
  }

  private resetFight(fight: EliteFight, brain: EnemyBrain): void {
    this.removeAdds(fight);
    fight.engaged = false;
    fight.taken.clear();
    fight.spent.clear();
    fight.enraged = false;
    fight.nextSlamAt = 0;
    fight.slam = undefined;
    calmDown(brain);
    // Home to heal: the AI restores its health on arrival.
    brain.returning = true;
  }

  /** A slam: telegraphed as a ring for its windup, then it lands on everyone
   *  still inside. Rooted the whole time — the answer is to step out. */
  private stepSlam(
    id: string,
    enemy: Enemy,
    brain: EnemyBrain,
    fight: EliteFight,
    ability: Extract<EliteAbility, { kind: "slam" }>,
    now: number,
  ): void {
    const slam = fight.slam;
    if (slam) {
      if (now < slam.at) return;
      fight.slam = undefined;
      fight.nextSlamAt = now + ability.everyMs;
      for (const [sessionId, player] of this.state.players) {
        const session = this.sessions.get(sessionId);
        if (!session || session.transferring || player.health === 0) continue;
        // To the player's surface, as every other blow is measured.
        if (Math.hypot(player.x - slam.x, player.z - slam.z) > slam.radius + PLAYER_RADIUS) continue;
        this.damagePlayer(sessionId, slam.damage, id, enemy.level);
      }
      return;
    }

    // The first comes sooner than the rest, so every fight sees one.
    if (fight.nextSlamAt === 0) fight.nextSlamAt = now + ability.everyMs * 0.5;
    if (now < fight.nextSlamAt) return;

    // Drop whatever single blow it was winding up, and stand still.
    brain.windupUntil = 0;
    brain.windupTarget = undefined;
    brain.staggerUntil = Math.max(brain.staggerUntil, now + ability.windupMs);
    brain.nextAttackAt = Math.max(brain.nextAttackAt, now + ability.windupMs + 400);
    const archetype = this.archetypeFor(enemy);
    fight.slam = {
      at: now + ability.windupMs,
      x: enemy.x,
      z: enemy.z,
      radius: ability.radius,
      damage: archetype.attackDamage * this.ostra.difficulty.damage * levelDamageScale(enemy.level)
        * this.eliteDamageScale(id) * ability.damage,
    };
    this.broadcastNear(enemy.x, enemy.z, "enemySwing", {
      id, yaw: enemy.yaw, ms: ability.windupMs, target: "", reach: ability.radius, arc: Math.PI * 2, slam: true,
    });
    this.eliteCry(enemy, ability.cry);
  }

  /** Creatures joining an elite's fight, already hunting whoever it is. */
  private summon(eliteId: string, enemy: Enemy, brain: EnemyBrain, fight: EliteFight, kind: EnemyKind, count: number): void {
    let quarry: string | undefined;
    let most = -1;
    for (const [sessionId, amount] of brain.threat) {
      if (amount > most) {
        most = amount;
        quarry = sessionId;
      }
    }
    const level = Math.max(1, enemy.level - 2);
    const maxHealth = this.scaledHealth(getArchetype(kind).maxHealth, level);
    for (let n = 0; n < count; n++) {
      const angle = (n / count) * Math.PI * 2 + Math.random();
      const x = enemy.x + Math.sin(angle) * 3.5;
      const z = enemy.z + Math.cos(angle) * 3.5;
      const id = `e${this.nextEnemyId++}`;
      this.state.enemies.set(id, new Enemy({
        kind, x, y: groundHeight(this.ostra, x, z), z,
        yaw: angle, health: maxHealth, maxHealth, level, state: EnemyState.Chase,
      }));
      const addBrain = createBrain(x, z, `add:${eliteId}`, maxHealth);
      if (quarry) rally(addBrain, quarry);
      this.brains.set(id, addBrain);
      fight.adds.add(id);
      this.addOf.set(id, eliteId);
    }
  }

  private removeAdds(fight: EliteFight): void {
    for (const id of fight.adds) {
      this.state.enemies.delete(id);
      this.brains.delete(id);
      this.addOf.delete(id);
    }
    fight.adds.clear();
  }

  /** A line from an elite, to everyone near enough to see what it means. */
  private eliteCry(enemy: Enemy, text: string): void {
    this.broadcastNear(enemy.x, enemy.z, "eliteCry", { text });
  }

  private gateContaining(x: number, z: number): GateDefinition | undefined {
    return this.ostra.gates.find(
      (gate) => Math.hypot(gate.x - x, gate.z - z) <= GATE_RADIUS,
    );
  }

  /**
   * Hand a player to another Ostra's room.
   *
   * The destination room reads the character's position from the store, so the
   * save must land before the seat is reserved. That ordering is the whole
   * trick: the database, not a message payload, is what carries the player
   * across.
   */
  private async beginTransfer(
    client: Client,
    session: Session,
    player: Player,
    gate: GateDefinition,
  ): Promise<void> {
    const destination = getOstra(gate.target);
    const arrivalGate = findGate(destination, gate.targetGate);
    if (!arrivalGate) {
      // A broken topology shouldn't strand the player mid-step.
      console.error(`[${this.ostra.id}] gate ${gate.id} targets missing ${gate.targetGate}`);
      return;
    }

    session.transferring = true;

    // Step out of the far Gate rather than on top of it.
    const arrival = gateArrival(arrivalGate);

    // Going down into a dungeon: the copy your party is in, or a new one.
    // You are saved OUTSIDE it (see `dungeonExit`), and the grant carries
    // where you stand inside, and that you are allowed to.
    const instance = destination.dungeon
      ? parties.dungeonInstanceFor(session.characterId, destination.id)
      : undefined;
    const saveAt = destination.dungeon ? dungeonExit(destination) : { ostraId: destination.id, ...arrival };
    if (instance !== undefined) dungeonGrants.set(session.characterId, { instance, ...arrival });

    try {
      this.store.savePosition(this.realmId, session.characterId, {
        ostraId: saveAt.ostraId,
        x: saveAt.x,
        y: groundHeight(getOstra(saveAt.ostraId), saveAt.x, saveAt.z),
        z: saveAt.z,
        yaw: saveAt.yaw,
        health: player.health,
        level: session.level,
        xp: session.xp,
        inventory: session.inventory,
        equipment: session.equipment,
        quests: session.quests,
        gold: session.gold,
        waystones: session.waystones,
        goods: session.goods,
        trades: session.trades,
      });

      // With an auth context, so the reserved seat carries the account — see
      // `issueTransferToken`.
      const reservation = await matchMaker.joinOrCreate(instance !== undefined ? DUNGEON_ROOM_NAME : ROOM_NAME, {
        ostraId: destination.id,
        characterId: session.characterId,
        ...(instance !== undefined ? { instance } : {}),
      }, { token: await issueTransferToken(session.accountId), ip: "", headers: new Headers() });

      client.send("gate", {
        reservation,
        ostraId: destination.id,
        ostraName: destination.name,
      });

      // If the client never consumes the reservation, don't let it linger here
      // walking around an Ostra its save says it has left.
      this.clock.setTimeout(() => {
        if (this.sessions.get(client.sessionId)?.transferring) client.leave();
      }, TRANSFER_TIMEOUT_MS);
    } catch (error) {
      // Put the player back under their own control rather than freezing them.
      session.transferring = false;
      dungeonGrants.delete(session.characterId);
      console.error(`[${this.ostra.id}] transfer failed`, error);
      client.send("gateFailed", { message: "The Gate would not hold." });
    }
  }
}

/** One creature's share of a cast, as broadcast to everyone nearby. */
interface CastHit {
  id: string;
  amount: number;
  crit: boolean;
  killed: boolean;
  /** Interrupted — the client cancels its telegraph and plays a stagger. */
  staggered: boolean;
  /** Turned aside by a creature above your level: no damage. */
  missed?: boolean;
}
