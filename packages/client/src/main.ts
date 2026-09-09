import type { Room, SeatReservation } from "@colyseus/sdk";
import { Client } from "@colyseus/sdk";
import { getOstra, isOstraId, ROOM_NAME, type OstraDefinition, WorldState } from "@mmo/shared";
import { resolveCharacter } from "./characters.js";
import { Hud } from "./hud.js";
import { KeyboardInput } from "./input.js";
import { applyOstra, createWorld } from "./scene.js";
import { createSession, type OstraSession } from "./session.js";

const WS_ENDPOINT = import.meta.env.VITE_SERVER_URL ?? "ws://localhost:2567";
/** The character endpoints are plain HTTP on the same origin as the socket. */
const HTTP_ENDPOINT = WS_ENDPOINT.replace(/^ws/, "http");

const params = new URLSearchParams(location.search);
/** Two tabs need two characters to test with; see `characters.ts`. */
const slot = params.get("slot") ?? "1";
const requestedName = params.get("name") ?? undefined;

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

/** What the server sends when a player steps into a Gate. */
interface GateMessage {
  reservation: SeatReservation;
  ostraId: string;
  ostraName: string;
}

let session: OstraSession | undefined;
let room: Room<unknown, WorldState> | undefined;
let currentOstra: OstraDefinition | undefined;
let travelling = false;

async function main(): Promise<void> {
  hud.setStatus("connecting…");

  // The realm scopes stored character ids: point the client at a different
  // server and it correctly has a different character there.
  const health = await fetch(`${HTTP_ENDPOINT}/health`).then((r) => r.json() as Promise<{ realmId: string }>);
  const character = await resolveCharacter(HTTP_ENDPOINT, health.realmId, slot, requestedName);

  const client = new Client(WS_ENDPOINT);
  const joined = await client.joinOrCreate<WorldState>(
    ROOM_NAME,
    { ostraId: character.ostraId, characterId: character.id },
    WorldState,
  );

  enter(client, joined, getOstra(character.ostraId));

  world.engine.runRenderLoop(() => {
    // Mid-transfer there is no session; keep drawing so the canvas doesn't
    // freeze on the last frame while the new room connects.
    if (session) session.frame(performance.now());
    else world.scene.render();
  });

  if (import.meta.env.DEV) {
    // Poking at live netcode state from the console beats adding a print
    // statement and reloading every time something looks wrong.
    Object.assign(window, {
      mmo: {
        character,
        keyboard,
        world,
        get room() { return room; },
        get session() { return session; },
        frame: (now: number) => session?.frame(now),
      },
    });
  }
}

/** Wire the client up to an Ostra it has just joined. */
function enter(client: Client, next: Room<unknown, WorldState>, ostra: OstraDefinition): void {
  room = next;
  currentOstra = ostra;
  applyOstra(world, ostra);
  session = createSession(world, next, ostra, hud, keyboard, cameraYaw);

  hud.setOstra(ostra);
  hud.setStatus("connected");

  next.onMessage("gate", (payload: GateMessage) => {
    void travel(client, payload);
  });
  next.onMessage("gateFailed", (payload: { message: string }) => {
    hud.setStatus(payload.message, true);
  });

  next.onError((code, message) => hud.setStatus(`error ${code}: ${message}`, true));
  next.onLeave((code) => {
    // A consented leave is us stepping through a Gate, not a disconnection.
    if (!travelling && code !== 1000) hud.setStatus(`disconnected (${code})`, true);
  });
}

/**
 * Step through a Gate: consume the seat the server reserved for us in the
 * destination Ostra, then drop the old room.
 *
 * The new seat is claimed *before* leaving the old room. If it were the other
 * way round, a failure to connect would leave the player in no room at all,
 * with their save already moved — stranded. This way a failure just leaves
 * them where they were standing.
 */
async function travel(client: Client, payload: GateMessage): Promise<void> {
  if (travelling) return;
  if (!isOstraId(payload.ostraId)) return;
  travelling = true;

  const destination = getOstra(payload.ostraId);
  hud.setStatus(`stepping through to ${destination.name}…`);

  const previous = room;
  try {
    session?.dispose();
    session = undefined;

    const next = await client.consumeSeatReservation<WorldState>(payload.reservation, WorldState);
    // The old room already knows we're leaving and has stopped simulating us,
    // so a failure here is cosmetic — swallow it rather than losing the trip.
    await previous?.leave(true).catch(() => undefined);

    enter(client, next, destination);
  } catch (error) {
    console.error(error);
    hud.setStatus("The Gate would not hold.", true);
    // Rebuild the session we tore down so the player isn't left frozen. They
    // never left, so this is the Ostra they were already standing in.
    if (previous && room === previous && currentOstra) {
      session = createSession(world, previous, currentOstra, hud, keyboard, cameraYaw);
    }
  } finally {
    travelling = false;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  hud.setStatus(error instanceof Error ? error.message : "failed to connect", true);
});
