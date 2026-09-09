import { matchMaker, Room, ServerError, type Client, type Rewind } from "@colyseus/core";
import {
  applyInput,
  Enemy,
  ENEMY_RESPAWN_MS,
  EnemyState,
  findGate,
  getArchetype,
  grownProficiency,
  isInArc,
  GATE_ARRIVAL_OFFSET,
  GATE_RADIUS,
  getOstra,
  isEnemyKind,
  isOstraId,
  MoveInput,
  MANA_REGEN_PER_SECOND,
  PLAYER_MAX_HEALTH,
  PLAYER_MAX_MANA,
  PLAYER_RADIUS,
  PLAYER_RESPAWN_MS,
  spellDamage,
  spellFromWire,
  staticColliders,
  type Collider,
  type EnemyArchetype,
  type GateDefinition,
  type OstraDefinition,
  type OstraId,
  PATCH_RATE_MS,
  Player,
  ROOM_NAME,
  TICK_RATE,
  type Spell,
  type SpellId,
  type SpellProficiency,
  WorldState,
} from "@mmo/shared";
import { createBrain, stepEnemy, type AITarget, type EnemyBrain } from "../ai/enemyAI.js";
import { getServerContext } from "../context.js";
import { isCharacterId } from "../identity.js";
import type { CharacterStore } from "../store/CharacterStore.js";

export interface OstraRoomOptions {
  /** Which Ostra this room is. Rooms are matched on it, so it is required. */
  ostraId: OstraId;
  /**
   * The character the client claims. Always required — characters are minted
   * over HTTP before the first join, so there is no "new player" path here.
   */
  characterId: string;
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
  /** Fractional mana carried between ticks, so a 30Hz regen of 5/s is not
   *  rounded away to nothing every step. */
  manaCarry: number;
  /** Wall-clock ms when a fallen player wakes at the spawn point. */
  respawnAt: number;
}

/** How long to wait for a client to act on a gate handoff before evicting it. */
const TRANSFER_TIMEOUT_MS = 10_000;

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
  /** Position history, so a swing is judged against the world the attacker
   *  actually saw rather than the one that exists by the time it arrives. */
  private rewind!: Rewind;

  onCreate(options: OstraRoomOptions): void {
    if (!isOstraId(options.ostraId)) {
      throw new ServerError(400, `Unknown Ostra: ${String(options.ostraId)}`);
    }

    const context = getServerContext();
    this.store = context.store;
    this.realmId = context.realmId;
    this.ostra = getOstra(options.ostraId);

    this.state = new WorldState({ ostraId: this.ostra.id });
    this.maxClients = 64;
    this.patchRate = PATCH_RATE_MS;

    this.spawnEnemies();

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

    // The authoritative simulation. Nothing else in this room is allowed to
    // move a player or a creature: positions change here, from buffered input
    // or from the AI, or not at all.
    this.onMessage("requestProfile", (client) => this.onRequestProfile(client));

    this.setFixedTimestep((ctx) => {
      // One snapshot for the whole tick, taken before anyone moves. Rebuilding
      // it per player would mean players simulated later collide against
      // already-moved positions, making the result depend on map iteration
      // order — and the client, which has no such order, could never match it.
      const colliders = this.collectColliders();
      const world = { halfExtent: this.ostra.size / 2, colliders, selfId: "" };

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
          applyInput(player, input, ctx.dt, world);
          if (input.cast) this.tryCast(sessionId, session, player, input.cast);
        }

        this.checkGates(sessionId, session, player);
      }

      this.regenerateMana(ctx.dt);
      this.stepEnemies(ctx.dt, world);
      this.processRespawns();
    }, TICK_RATE);
  }

  onJoin(client: Client, options: OstraRoomOptions): void {
    if (!isCharacterId(options.characterId)) {
      throw new ServerError(400, "A character id is required.");
    }

    const character = this.store.find(this.realmId, options.characterId);
    if (!character) {
      // A wiped database, or a character from another realm.
      throw new ServerError(401, "Unknown character.");
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

    this.state.players.set(client.sessionId, new Player({
      name: character.name,
      colour: character.colour,
      x: character.x,
      y: character.y,
      z: character.z,
      yaw: character.yaw,
      // A character stored at 0 HP died as the process went down; wake them
      // whole rather than dead on arrival with no respawn timer running.
      health: character.health > 0 ? character.health : PLAYER_MAX_HEALTH,
    }));

    this.sessions.set(client.sessionId, {
      characterId: character.id,
      // Covers arriving through a Gate and logging in on top of one alike.
      suppressedGate: this.gateContaining(character.x, character.z)?.id,
      transferring: false,
      nextCastAt: {},
      affinity: character.affinity,
      spells: { ...character.spells },
      manaCarry: 0,
      respawnAt: 0,
    });
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
      });
    }

    this.sessions.delete(client.sessionId);
    this.state.players.delete(client.sessionId);
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

  /** Scenery, every player, and every creature, as circles. */
  private collectColliders(): Collider[] {
    const colliders: Collider[] = [...staticColliders(this.ostra)];
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

  /**
   * Populate the Ostra from its spawn table. Creatures live and die with the
   * room and are never persisted, so an emptied Ostra repopulates the moment
   * somebody walks back into it.
   */
  private spawnEnemies(): void {
    let index = 0;
    for (const group of this.ostra.spawns) {
      const archetype = getArchetype(group.kind);
      for (let n = 0; n < group.count; n++) {
        // Scatter over the camp's area rather than its circumference: the sqrt
        // spreads them evenly instead of bunching them at the edge.
        const angle = Math.random() * Math.PI * 2;
        const reach = group.radius * Math.sqrt(Math.random());
        const x = group.x + Math.cos(angle) * reach;
        const z = group.z + Math.sin(angle) * reach;

        const id = `e${index++}`;
        this.state.enemies.set(id, new Enemy({
          kind: archetype.kind,
          x,
          y: 0,
          z,
          yaw: Math.random() * Math.PI * 2,
          health: this.scaledHealth(archetype.maxHealth),
          state: EnemyState.Idle,
        }));
        this.brains.set(id, createBrain(x, z));
      }
    }
  }

  private stepEnemies(
    dt: number,
    world: { halfExtent: number; colliders: Collider[]; selfId: string },
  ): void {
    if (this.state.enemies.size === 0) return;
    const now = Date.now();

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
      const struck = stepEnemy(
        enemy,
        brain,
        this.archetypeFor(enemy.kind),
        dt,
        world,
        this.aiTargets,
        now,
      );
      if (struck) {
        // The same creature hits harder in a harder place.
        this.damagePlayer(
          struck,
          Math.max(1, Math.round(
            this.archetypeFor(enemy.kind).attackDamage * this.ostra.difficulty.damage,
          )),
        );
      }
    }
  }

  /**
   * Resolve one cast.
   *
   * Every spell runs through the same shape test — a ring is just an arc of
   * 2*PI — so adding a spell is a table entry rather than a new code path.
   */
  private tryCast(sessionId: string, session: Session, player: Player, wire: number): void {
    const spell = spellFromWire(wire);
    if (!spell) return;

    const now = Date.now();
    if (now < (session.nextCastAt[spell.id] ?? 0)) return;
    if (player.mana < spell.manaCost) return;

    session.nextCastAt[spell.id] = now + spell.cooldownMs;
    player.mana -= spell.manaCost;

    const hits = this.resolveSpell(sessionId, player, spell, session);

    // Tell the caster either way: the client draws the effect on its own, and
    // silence on a miss is indistinguishable from a dropped packet.
    this.clients.getById(sessionId)?.send("cast", { spell: spell.id, hits: hits.length });

    if (hits.length === 0) return;

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

  /** Apply a spell to whatever it catches, and return what it hit. */
  private resolveSpell(
    sessionId: string,
    player: Player,
    spell: Spell,
    session: Session,
  ): string[] {
    // Where this player saw the world when they cast, not where it is now.
    const seen = this.rewind.lastSeenBy(sessionId);
    const damage = spellDamage(spell, session.spells[spell.id] ?? 0);

    const caught: Array<{ id: string; enemy: Enemy; range: number }> = [];

    for (const [enemyId, enemy] of this.state.enemies) {
      if (enemy.state === EnemyState.Dead) continue;
      const archetype = this.archetypeFor(enemy.kind);

      const x = seen.value(enemy, "x");
      const z = seen.value(enemy, "z");
      const inside = isInArc(
        player.x, player.z, player.yaw,
        x, z, archetype.radius,
        spell.range, spell.arc,
      );
      if (!inside) continue;

      caught.push({ id: enemyId, enemy, range: Math.hypot(x - player.x, z - player.z) });
    }

    if (caught.length === 0) return [];

    const struck = spell.targeting === "all"
      ? caught
      : [caught.reduce((closest, next) => (next.range < closest.range ? next : closest))];

    for (const { id, enemy } of struck) {
      enemy.health = Math.max(0, enemy.health - damage);
      this.broadcast("damage", { id, amount: damage, by: sessionId });

      if (enemy.health === 0) {
        enemy.state = EnemyState.Dead;
        const brain = this.brains.get(id);
        if (brain) {
          brain.quarry = undefined;
          brain.returning = false;
          brain.respawnAt = Date.now() + ENEMY_RESPAWN_MS;
        }
      }
    }

    return struck.map((entry) => entry.id);
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
      maxMana: PLAYER_MAX_MANA,
      manaNow: player.mana,
    });
  }

  /** Mana ticks back up whether or not you are fighting. */
  private regenerateMana(dt: number): void {
    for (const [sessionId, session] of this.sessions) {
      const player = this.state.players.get(sessionId);
      if (!player || player.health === 0 || player.mana >= PLAYER_MAX_MANA) {
        if (player && player.health === 0) session.manaCarry = 0;
        continue;
      }

      // Accumulate the fraction: at 5/s and 30Hz each step is 0.167 mana, and
      // rounding that per-tick would regenerate exactly nothing.
      session.manaCarry += MANA_REGEN_PER_SECOND * dt;
      const whole = Math.floor(session.manaCarry);
      if (whole <= 0) continue;
      session.manaCarry -= whole;
      player.mana = Math.min(PLAYER_MAX_MANA, player.mana + whole);
    }
  }

  private damagePlayer(sessionId: string, amount: number): void {
    const player = this.state.players.get(sessionId);
    const session = this.sessions.get(sessionId);
    if (!player || !session || player.health === 0) return;

    player.health = Math.max(0, player.health - amount);
    this.broadcast("damage", { id: sessionId, amount });

    if (player.health === 0) {
      session.respawnAt = Date.now() + PLAYER_RESPAWN_MS;
      this.broadcast("died", { id: sessionId });
    }
  }

  /** Stand the dead back up once their timer is out. */
  private processRespawns(): void {
    const now = Date.now();

    for (const [enemyId, enemy] of this.state.enemies) {
      if (enemy.state !== EnemyState.Dead) continue;
      const brain = this.brains.get(enemyId);
      if (!brain || now < brain.respawnAt) continue;

      // Back at its spawn rather than where it fell, so a cleared camp
      // reassembles instead of drifting wherever players dragged it.
      enemy.x = brain.homeX;
      enemy.z = brain.homeZ;
      enemy.health = this.scaledHealth(this.archetypeFor(enemy.kind).maxHealth);
      enemy.state = EnemyState.Idle;
      brain.timer = 0;
      brain.returning = false;
    }

    for (const [sessionId, session] of this.sessions) {
      const player = this.state.players.get(sessionId);
      if (!player || player.health > 0 || now < session.respawnAt) continue;

      const spawn = this.ostra.spawn;
      player.x = spawn.x;
      player.z = spawn.z;
      player.health = PLAYER_MAX_HEALTH;
      player.mana = PLAYER_MAX_MANA;
      session.manaCarry = 0;
      // Whatever they were standing in when they died must not fire on arrival.
      session.suppressedGate = this.gateContaining(spawn.x, spawn.z)?.id;
      // Anything still locked onto them lets go. Without this a creature that
      // followed them keeps its quarry and resumes the moment they stand up.
      for (const brain of this.brains.values()) {
        if (brain.quarry === sessionId) brain.quarry = undefined;
      }
      this.clients.getById(sessionId)?.send("respawned", { x: spawn.x, z: spawn.z });
    }
  }

  private scaledHealth(base: number): number {
    return Math.max(1, Math.round(base * this.ostra.difficulty.health));
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
        y: player.y,
        z,
        yaw: arrivalGate.exitYaw,
        health: player.health,
        spells: session.spells,
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
