import { matchMaker, Room, ServerError, type Client, type Rewind } from "@colyseus/core";
import {
  applyInput,
  buildingColliders,
  campsIn,
  COMBAT_LINGER_MS,
  COMBO_FINISHER_KNOCKBACK,
  COMBO_FINISHER_MULTIPLIER,
  CRIT_CHANCE,
  CRIT_MULTIPLIER,
  Enemy,
  ENEMY_RESPAWN_MS,
  EnemyState,
  equipmentStats,
  EQUIP_SLOTS,
  findGate,
  getArchetype,
  getItem,
  groundHeight,
  GROUND_ITEM_TTL_MS,
  GroundItem,
  LOOT_CLAIM_MS,
  grownProficiency,
  HEALTH_REGEN_FRACTION_PER_SECOND,
  INVENTORY_SIZE,
  isInArc,
  isItemId,
  itemsOfRarity,
  GATE_ARRIVAL_OFFSET,
  GATE_RADIUS,
  getOstra,
  isEnemyKind,
  isOstraId,
  levelDamageScale,
  levelHealthScale,
  MoveInput,
  MANA_REGEN_OUT_OF_COMBAT,
  MANA_REGEN_PER_SECOND,
  PICKUP_RADIUS,
  PLAYER_MAX_HEALTH,
  PLAYER_MAX_MANA,
  PLAYER_RADIUS,
  PLAYER_RESPAWN_MS,
  respawnPoint,
  rollRarity,
  sceneryIndex,
  spellDamage,
  spellFromWire,
  STRIKE_COMBO_LENGTH,
  STRIKE_COMBO_WINDOW_MS,
  type CampDefinition,
  type Collider,
  type EnemyArchetype,
  type MoveWorld,
  type GateDefinition,
  type OstraDefinition,
  type OstraId,
  PATCH_RATE_MS,
  Player,
  ROOM_NAME,
  TICK_RATE,
  type BoxCollider,
  type EquipSlot,
  type Equipment,
  type Spell,
  type SpellId,
  type SpellProficiency,
  WorldState,
} from "@mmo/shared";
import {
  calmDown,
  createBrain,
  rally,
  stepEnemy,
  takeHit,
  type AITarget,
  type EnemyBrain,
} from "../ai/enemyAI.js";
import { verifyToken } from "../auth.js";
import { getServerContext } from "../context.js";
import { isCharacterId } from "../identity.js";
import type { CharacterStore } from "../store/CharacterStore.js";

export interface OstraRoomOptions {
  /** Which Ostra this room is. Rooms are matched on it, so it is required. */
  ostraId: OstraId;
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
  /**
   * A Gate the player is standing in that must NOT fire — either the one they
   * just arrived through, or one they happened to log in on top of. Cleared
   * the moment they step out of it, which is what re-arms the Gate.
   */
  suppressedGate: string | undefined;
  /** Set once a transfer is under way; their input stops being simulated. */
  transferring: boolean;
  /** Wall-clock ms when each spell may be cast again. */
  nextCastAt: Partial<Record<SpellId, number>>;
  /** Innate ceiling, from the character record. */
  affinity: number;
  /** Live proficiency; written back to the store on save. */
  spells: SpellProficiency;
  /** Carried items, and what is worn. Private: nobody else sees a bag. */
  inventory: string[];
  equipment: Equipment;
  /** Fractional mana and health carried between ticks, so a regen of a few
   *  points a second is not rounded away to nothing at 30Hz. */
  manaCarry: number;
  healthCarry: number;
  /** Wall-clock ms when a fallen player wakes at a waystone. */
  respawnAt: number;
  /** Where they fell, to pick the nearest waystone. */
  diedAtX: number;
  diedAtZ: number;
  /** Wall-clock ms until which they count as fighting. */
  combatUntil: number;
  /** Where they are in the Strike chain, and when the last link landed. */
  comboStep: number;
  comboAt: number;
  /** The creature they have selected. Spells that hit one thing prefer it. */
  targetId: string | undefined;
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
 * Terra holds ~700 camps and ~3000 creatures. Simulating and replicating all of
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
  private nextGroundId = 0;

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

    this.state = new WorldState({ ostraId: this.ostra.id });
    this.maxClients = 64;
    this.patchRate = PATCH_RATE_MS;

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
    this.onMessage("equip", (client, message: { itemId?: unknown }) =>
      this.onEquip(client, message?.itemId));
    this.onMessage("unequip", (client, message: { slot?: unknown }) =>
      this.onUnequip(client, message?.slot));
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

      for (const [sessionId, player] of this.state.players) {
        const session = this.sessions.get(sessionId);
        // A player mid-handoff is already saved at their destination; simulating
        // them further here would overwrite that with a stale position.
        if (!session || session.transferring) continue;

        world.selfId = sessionId;

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
          applyInput(player, input, ctx.dt, world, !player.inCombat);
          if (input.cast) this.tryCast(sessionId, session, player, input.cast, input.aim, now);
        }

        this.checkGates(sessionId, session, player);
      }

      this.stepEnemies(ctx.dt, world, now);
      this.updateCombatFlags(now);
      this.regenerate(ctx.dt);
      this.processRespawns(now);
      this.processGround(now);
      if (this.tick % CAMP_CHECK_TICKS === 0) this.updateCamps(now);
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

    // A character saved in another Ostra should never have been routed here.
    // Trust the store over the request and say where they actually are.
    if (character.ostraId !== this.ostra.id) {
      throw new ServerError(409, `That character is on ${getOstra(character.ostraId).name}.`);
    }

    // A save from before an Ostra shrank could sit outside it now.
    const limit = this.ostra.size / 2 - PLAYER_RADIUS;
    const x = Math.max(-limit, Math.min(limit, character.x));
    const z = Math.max(-limit, Math.min(limit, character.z));

    this.state.players.set(client.sessionId, new Player({
      name: character.name,
      colour: character.colour,
      x,
      // Recomputed rather than restored: the ground may have been reshaped
      // since they logged out, and a saved height would bury or float them.
      y: groundHeight(this.ostra, x, z),
      z,
      yaw: character.yaw,
      // A character stored at 0 HP died as the process went down; wake them
      // whole rather than dead on arrival with no respawn timer running.
      health: character.health > 0 ? character.health : PLAYER_MAX_HEALTH,
    }));

    // Gear is loaded before anything can read maxHealth, so the bars are right
    // on the first frame rather than a patch later.
    const stats = equipmentStats(character.equipment);
    const joined = this.state.players.get(client.sessionId)!;
    joined.maxHealth = PLAYER_MAX_HEALTH + stats.health;
    joined.maxMana = PLAYER_MAX_MANA + stats.mana;
    if (joined.health > joined.maxHealth) joined.health = joined.maxHealth;
    joined.mana = joined.maxMana;

    this.sessions.set(client.sessionId, {
      characterId: character.id,
      // Covers arriving through a Gate and logging in on top of one alike.
      suppressedGate: this.gateContaining(x, z)?.id,
      transferring: false,
      nextCastAt: {},
      affinity: character.affinity,
      spells: { ...character.spells },
      inventory: [...character.inventory],
      equipment: { ...character.equipment },
      manaCarry: 0,
      healthCarry: 0,
      respawnAt: 0,
      diedAtX: x,
      diedAtZ: z,
      combatUntil: 0,
      comboStep: 0,
      comboAt: 0,
      targetId: undefined,
    });

    // Wake the camps around them now rather than up to half a second later,
    // so arriving somewhere never shows an empty field filling up.
    this.updateCamps(Date.now());
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
    if (session && player) this.sendProfile(client.sessionId, session, player);
  }

  onLeave(client: Client): void {
    const session = this.sessions.get(client.sessionId);
    const player = this.state.players.get(client.sessionId);

    // A transferring player was already saved at their arrival point. Saving
    // again here would write the position they left from and undo the trip.
    if (session && player && !session.transferring) {
      this.store.savePosition(this.realmId, session.characterId, {
        ostraId: this.ostra.id,
        x: player.x,
        y: player.y,
        z: player.z,
        yaw: player.yaw,
        health: player.health,
        spells: session.spells,
        inventory: session.inventory,
        equipment: session.equipment,
      });
    }

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
        radius: this.archetypeFor(enemy.kind).radius,
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
    const maxHealth = this.scaledHealth(archetype.maxHealth, camp.level);
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
      this.aiTargets.push({ sessionId, x: player.x, z: player.z });
    }

    for (const [enemyId, enemy] of this.state.enemies) {
      const brain = this.brains.get(enemyId);
      if (!brain) continue;
      world.selfId = enemyId;
      const archetype = this.archetypeFor(enemy.kind);
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
          break;
        case "hit":
          // The same creature hits harder in a harder place, and further out.
          this.damagePlayer(
            event.target,
            Math.max(1, Math.round(
              archetype.attackDamage * this.ostra.difficulty.damage * levelDamageScale(enemy.level),
            )),
            enemyId,
          );
          break;
        case "miss":
          this.broadcastNear(enemy.x, enemy.z, "evade", { id: event.target, by: enemyId });
          break;
      }
    }
  }

  /**
   * Resolve one cast.
   *
   * Every spell runs through the same shape test — a ring is just an arc of
   * 2*PI — so adding a spell is a table entry rather than a new code path.
   */
  private tryCast(
    sessionId: string,
    session: Session,
    player: Player,
    wire: number,
    aim: number,
    now: number,
  ): void {
    const spell = spellFromWire(wire);
    if (!spell) return;

    if (now < (session.nextCastAt[spell.id] ?? 0)) return;
    if (player.mana < spell.manaCost) return;

    session.nextCastAt[spell.id] = now + spell.cooldownMs;
    player.mana -= spell.manaCost;

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
    const hits = this.resolveSpell(sessionId, player, spell, session, yaw, combo, now);

    // Everyone nearby sees the cast, so a fight between other players and a
    // camp is something you can watch rather than a set of numbers changing.
    // The caster is told either way: silence on a miss is indistinguishable
    // from a dropped packet.
    this.broadcastNear(player.x, player.z, "cast", {
      by: sessionId, spell: spell.id, yaw, combo, hits,
    });

    if (hits.length === 0) return;
    session.combatUntil = now + COMBAT_LINGER_MS;

    // Proficiency only grows on a LANDED cast. "The more you use magic the
    // better you become" would otherwise mean facing a wall and holding a key,
    // which is training in the least interesting sense.
    const before = session.spells[spell.id] ?? 0;
    const after = grownProficiency(before, session.affinity);
    if (after !== before) {
      session.spells[spell.id] = after;
      this.sendProfile(sessionId, session, player);
    }
  }

  /** Apply a spell to whatever it catches, and describe what happened. */
  private resolveSpell(
    sessionId: string,
    player: Player,
    spell: Spell,
    session: Session,
    yaw: number,
    combo: number,
    now: number,
  ): CastHit[] {
    // Where this player saw the world when they cast, not where it is now.
    const seen = this.rewind.lastSeenBy(sessionId);
    // Training scales the spell; gear adds on top. Two axes, kept separate
    // so neither makes the other pointless.
    const base = spellDamage(spell, session.spells[spell.id] ?? 0)
      + equipmentStats(session.equipment).damage;
    const finisher = spell.id === "strike" && combo === STRIKE_COMBO_LENGTH;

    const caught: Array<{ id: string; enemy: Enemy; range: number }> = [];

    for (const [enemyId, enemy] of this.state.enemies) {
      if (enemy.state === EnemyState.Dead) continue;
      const archetype = this.archetypeFor(enemy.kind);

      const x = seen.value(enemy, "x");
      const z = seen.value(enemy, "z");
      const inside = isInArc(
        player.x, player.z, yaw,
        x, z, archetype.radius,
        spell.range, spell.arc,
      );
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
    for (const { id, enemy } of struck) {
      const crit = Math.random() < CRIT_CHANCE;
      const amount = Math.max(1, Math.round(
        base * (finisher ? COMBO_FINISHER_MULTIPLIER : 1) * (crit ? CRIT_MULTIPLIER : 1),
      ));
      enemy.health = Math.max(0, enemy.health - amount);
      const killed = enemy.health === 0;
      const brain = this.brains.get(id);

      let staggered = false;
      if (killed) {
        enemy.state = EnemyState.Dead;
        if (brain) {
          calmDown(brain);
          brain.returning = false;
          brain.respawnAt = now + ENEMY_RESPAWN_MS;
        }
        this.rollDrop(enemy, sessionId);
      } else if (brain) {
        // Shoved directly away from the caster — from where it is now, since
        // that is where the shove happens.
        const dx = enemy.x - player.x;
        const dz = enemy.z - player.z;
        const length = Math.hypot(dx, dz) || 1;
        const knockback = finisher ? COMBO_FINISHER_KNOCKBACK : spell.knockback;
        staggered = spell.stagger || finisher;
        const archetype = this.archetypeFor(enemy.kind);
        takeHit(brain, archetype, sessionId, amount, dx / length, dz / length, knockback, staggered, now);
        // A golem shrugs it off; tell the client so it doesn't claim otherwise.
        if (archetype.staggerImmune) staggered = false;
        this.rallyCampMates(id, brain, enemy, sessionId);
      }

      hits.push({ id, amount, crit, killed, staggered });
    }

    return hits;
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

  /** Being hunted or having traded blows recently both count as fighting. */
  private updateCombatFlags(now: number): void {
    for (const [sessionId, session] of this.sessions) {
      const player = this.state.players.get(sessionId);
      if (!player) continue;
      const fighting = player.health > 0 && (now < session.combatUntil || this.hunted.has(sessionId));
      if (player.inCombat !== fighting) player.inCombat = fighting;
    }
  }

  /**
   * Send a player their own affinity and proficiency.
   *
   * Private to the caster, so it goes by message rather than into replicated
   * state — nobody else needs to know how practised you are, and it changes
   * rarely enough that a message is cheaper than a synced field.
   */
  private sendProfile(sessionId: string, session: Session, player: Player): void {
    this.clients.getById(sessionId)?.send("profile", {
      affinity: session.affinity,
      spells: session.spells,
      inventory: session.inventory,
      equipment: session.equipment,
      manaNow: player.mana,
    });
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
    const archetype = this.archetypeFor(enemy.kind);
    if (Math.random() >= archetype.dropChance) return;

    // Each creature's own rare find, checked first. Found nowhere else.
    const signature = archetype.signature;
    let item = signature && Math.random() < signature.chance ? getItem(signature.itemId) : undefined;
    if (!item) {
      const danger = this.ostra.difficulty.health * (1 + 0.06 * (enemy.level - 1));
      const pool = itemsOfRarity(rollRarity(Math.random(), danger));
      item = pool[Math.floor(Math.random() * pool.length)];
    }
    if (!item) return;

    const id = `g${this.nextGroundId++}`;
    this.state.ground.set(id, new GroundItem({
      itemId: item.id,
      claimedBy: killerSessionId,
      x: enemy.x,
      y: groundHeight(this.ostra, enemy.x, enemy.z),
      z: enemy.z,
    }));
    this.groundExpiry.set(id, Date.now() + GROUND_ITEM_TTL_MS);
    this.groundClaimUntil.set(id, Date.now() + LOOT_CLAIM_MS);
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
        // Still someone else's.
        if (dropped.claimedBy !== "" && dropped.claimedBy !== sessionId) continue;

        // A full bag leaves it lying there rather than silently eating it.
        if (session.inventory.length >= INVENTORY_SIZE) {
          this.clients.getById(sessionId)?.send("pickupFailed", { itemId: dropped.itemId });
          continue;
        }

        session.inventory.push(dropped.itemId);
        this.state.ground.delete(groundId);
        this.groundExpiry.delete(groundId);
        this.groundClaimUntil.delete(groundId);
        this.clients.getById(sessionId)?.send("picked", { itemId: dropped.itemId });
        this.sendProfile(sessionId, session, player);
        break;
      }
    }
  }

  private onEquip(client: Client, itemId: unknown): void {
    const session = this.sessions.get(client.sessionId);
    const player = this.state.players.get(client.sessionId);
    if (!session || !player || !isItemId(itemId)) return;

    const index = session.inventory.indexOf(itemId);
    if (index === -1) return;
    const item = getItem(itemId);
    if (!item) return;

    session.inventory.splice(index, 1);
    // Whatever was in that slot goes back in the bag rather than vanishing.
    const displaced = session.equipment[item.slot];
    if (displaced !== undefined) session.inventory.push(displaced);
    session.equipment[item.slot] = itemId;

    this.applyEquipment(client.sessionId, session, player);
  }

  private onUnequip(client: Client, slot: unknown): void {
    const session = this.sessions.get(client.sessionId);
    const player = this.state.players.get(client.sessionId);
    if (!session || !player) return;
    if (typeof slot !== "string" || !EQUIP_SLOTS.includes(slot as EquipSlot)) return;

    const worn = session.equipment[slot as EquipSlot];
    if (worn === undefined) return;
    if (session.inventory.length >= INVENTORY_SIZE) {
      client.send("pickupFailed", { itemId: worn });
      return;
    }

    delete session.equipment[slot as EquipSlot];
    session.inventory.push(worn);
    this.applyEquipment(client.sessionId, session, player);
  }

  /**
   * Recompute the caps gear provides, and tell the owner.
   *
   * Current health and mana are clamped rather than scaled: taking off armour
   * should not kill you, but it must not leave you above your new ceiling
   * either.
   */
  private applyEquipment(sessionId: string, session: Session, player: Player): void {
    const stats = equipmentStats(session.equipment);
    player.maxHealth = PLAYER_MAX_HEALTH + stats.health;
    player.maxMana = PLAYER_MAX_MANA + stats.mana;
    if (player.health > player.maxHealth) player.health = player.maxHealth;
    if (player.mana > player.maxMana) player.mana = player.maxMana;
    this.sendProfile(sessionId, session, player);
  }

  /** Mana always comes back, faster at rest; health only at rest. */
  private regenerate(dt: number): void {
    for (const [sessionId, session] of this.sessions) {
      const player = this.state.players.get(sessionId);
      if (!player) continue;
      if (player.health === 0) {
        session.manaCarry = 0;
        session.healthCarry = 0;
        continue;
      }

      if (player.mana < player.maxMana) {
        // Accumulate the fraction: at 5/s and 30Hz each step is 0.167 mana, and
        // rounding that per-tick would regenerate exactly nothing.
        session.manaCarry += (player.inCombat ? MANA_REGEN_PER_SECOND : MANA_REGEN_OUT_OF_COMBAT) * dt;
        const whole = Math.floor(session.manaCarry);
        if (whole > 0) {
          session.manaCarry -= whole;
          player.mana = Math.min(player.maxMana, player.mana + whole);
        }
      } else {
        session.manaCarry = 0;
      }

      if (!player.inCombat && player.health < player.maxHealth) {
        session.healthCarry += player.maxHealth * HEALTH_REGEN_FRACTION_PER_SECOND * dt;
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

  private damagePlayer(sessionId: string, amount: number, byEnemyId: string): void {
    const player = this.state.players.get(sessionId);
    const session = this.sessions.get(sessionId);
    if (!player || !session || player.health === 0) return;

    const now = Date.now();
    player.health = Math.max(0, player.health - amount);
    session.combatUntil = now + COMBAT_LINGER_MS;
    this.broadcastNear(player.x, player.z, "damage", { id: sessionId, amount, by: byEnemyId });

    if (player.health === 0) {
      session.respawnAt = now + PLAYER_RESPAWN_MS;
      session.diedAtX = player.x;
      session.diedAtZ = player.z;
      session.combatUntil = 0;
      player.inCombat = false;
      this.broadcastNear(player.x, player.z, "died", { id: sessionId });
    }
  }

  /** Stand the dead back up once their timer is out. */
  private processRespawns(now: number): void {
    for (const [enemyId, enemy] of this.state.enemies) {
      if (enemy.state !== EnemyState.Dead) continue;
      const brain = this.brains.get(enemyId);
      if (!brain || now < brain.respawnAt) continue;

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
      player.health = player.maxHealth;
      player.mana = player.maxMana;
      session.manaCarry = 0;
      session.healthCarry = 0;
      session.comboStep = 0;
      // Whatever they were standing in when they died must not fire on arrival.
      session.suppressedGate = this.gateContaining(spot.x, spot.z)?.id;
      // Anything still locked onto them lets go. Without this a creature that
      // followed them keeps its quarry and resumes the moment they stand up.
      for (const brain of this.brains.values()) {
        brain.threat.delete(sessionId);
        if (brain.quarry === sessionId) brain.quarry = undefined;
        if (brain.windupTarget === sessionId) {
          brain.windupUntil = 0;
          brain.windupTarget = undefined;
        }
      }
      this.clients.getById(sessionId)?.send("respawned", { x: spot.x, z: spot.z });
      // A waystone in the wilds has camps around it that went to sleep while
      // they were away.
      this.updateCamps(now);
    }
  }

  private scaledHealth(base: number, level: number): number {
    return Math.max(1, Math.round(base * this.ostra.difficulty.health * levelHealthScale(level)));
  }

  /** Falls back rather than throwing: a stored kind this build no longer knows
   *  should not take the whole room's simulation down. */
  private archetypeFor(kind: string): EnemyArchetype {
    return isEnemyKind(kind) ? getArchetype(kind) : getArchetype("zombie");
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
    const x = arrivalGate.x + Math.sin(arrivalGate.exitYaw) * GATE_ARRIVAL_OFFSET;
    const z = arrivalGate.z + Math.cos(arrivalGate.exitYaw) * GATE_ARRIVAL_OFFSET;

    try {
      this.store.savePosition(this.realmId, session.characterId, {
        ostraId: destination.id,
        x,
        y: groundHeight(destination, x, z),
        z,
        yaw: arrivalGate.exitYaw,
        health: player.health,
        spells: session.spells,
        inventory: session.inventory,
        equipment: session.equipment,
      });

      const reservation = await matchMaker.joinOrCreate(ROOM_NAME, {
        ostraId: destination.id,
        characterId: session.characterId,
      });

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
}
