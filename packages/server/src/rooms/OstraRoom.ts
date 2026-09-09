import { matchMaker, Room, ServerError, type Client } from "@colyseus/core";
import {
  applyInput,
  findGate,
  GATE_ARRIVAL_OFFSET,
  GATE_RADIUS,
  getOstra,
  isOstraId,
  MoveInput,
  type GateDefinition,
  type OstraDefinition,
  type OstraId,
  PATCH_RATE_MS,
  Player,
  ROOM_NAME,
  TICK_RATE,
  WorldState,
} from "@mmo/shared";
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

    // The authoritative simulation. Nothing else in this room is allowed to
    // move a player: positions change here, from buffered input, or not at all.
    this.setFixedTimestep((ctx) => {
      const halfExtent = this.ostra.size / 2;

      for (const [sessionId, player] of this.state.players) {
        const session = this.sessions.get(sessionId);
        // A player mid-handoff is already saved at their destination; simulating
        // them further here would overwrite that with a stale position.
        if (!session || session.transferring) continue;

        // Consuming one at a time (rather than draining to an array) is what
        // keeps the server's ack aligned with the client's pending-input list,
        // so its rollback replays exactly the frames we haven't applied yet.
        for (const input of this.inputs.get(sessionId)) {
          applyInput(player, input, ctx.dt, halfExtent);
        }

        this.checkGates(sessionId, session, player);
      }
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
    }));

    this.sessions.set(client.sessionId, {
      characterId: character.id,
      // Covers arriving through a Gate and logging in on top of one alike.
      suppressedGate: this.gateContaining(character.x, character.z)?.id,
      transferring: false,
    });
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
