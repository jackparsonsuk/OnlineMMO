import { Room, type Client } from "@colyseus/core";
import {
  applyInput,
  MoveInput,
  PATCH_RATE_MS,
  Player,
  PLAYER_HALF,
  TICK_RATE,
  WORLD_HALF,
  WorldState,
} from "@mmo/shared";

export interface JoinOptions {
  name?: string;
}

/** Distinct, readable cube colours, handed out round-robin as players join. */
const PALETTE = [
  0xe8563f, 0x3fa9e8, 0x5ec25e, 0xe8c23f, 0xa969e8,
  0x3fd6c4, 0xe86fb0, 0xf08f3c, 0x8ad04a, 0x6f7de8,
] as const;

const SPAWN_RADIUS = 8;

function sanitiseName(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim().slice(0, 16);
  return trimmed.length > 0 ? trimmed : fallback;
}

export class WorldRoom extends Room<{ state: WorldState; input: MoveInput }> {
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

  private nextColour = 0;
  private playerCount = 0;

  onCreate(): void {
    this.state = new WorldState();
    this.maxClients = 64;
    this.patchRate = PATCH_RATE_MS;

    // The authoritative simulation. Nothing else in this room is allowed to
    // move a player: positions change here, from buffered input, or not at all.
    this.setFixedTimestep((ctx) => {
      for (const [sessionId, player] of this.state.players) {
        // Consuming one at a time (rather than draining to an array) is what
        // keeps the server's ack aligned with the client's pending-input list,
        // so its rollback replays exactly the frames we haven't applied yet.
        for (const input of this.inputs.get(sessionId)) {
          applyInput(player, input, ctx.dt);
        }
      }
    }, TICK_RATE);
  }

  onJoin(client: Client, options: JoinOptions = {}): void {
    const index = this.nextColour++;
    const spawn = this.findSpawn();

    this.state.players.set(client.sessionId, new Player({
      name: sanitiseName(options.name, `Player ${++this.playerCount}`),
      colour: PALETTE[index % PALETTE.length]!,
      x: spawn.x,
      y: 0,
      z: spawn.z,
      yaw: Math.atan2(-spawn.x, -spawn.z), // face the middle of the world
    }));
  }

  onLeave(client: Client): void {
    this.state.players.delete(client.sessionId);
  }

  /** Spread joiners around a ring near the origin so nobody spawns inside
   *  somebody else. */
  private findSpawn(): { x: number; z: number } {
    const angle = Math.random() * Math.PI * 2;
    const radius = SPAWN_RADIUS * Math.sqrt(Math.random());
    const limit = WORLD_HALF - PLAYER_HALF;
    return {
      x: Math.max(-limit, Math.min(limit, Math.cos(angle) * radius)),
      z: Math.max(-limit, Math.min(limit, Math.sin(angle) * radius)),
    };
  }
}
