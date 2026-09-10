import type { Room, SeatReservation } from "@colyseus/sdk";
import { Client } from "@colyseus/sdk";
import {
  type Equipment,
  getItem,
  getOstra,
  isOstraId,
  ROOM_NAME,
  type OstraDefinition,
  type SpellProficiency,
  WorldState,
} from "@mmo/shared";
import { AccountClient } from "./account.js";
import { SoundBoard } from "./audio.js";
import { showTitleScreen } from "./titleScreen.js";
import { Hud } from "./hud.js";
import { KeyboardInput } from "./input.js";
import { applyOstra, createWorld } from "./scene.js";
import { createSession, type OstraSession } from "./session.js";

/**
 * Where the server is.
 *
 * In production the server serves this very page, so the answer is "wherever
 * this came from" — which means no build-time configuration, no CORS, and one
 * deployable artifact. `import.meta.env` is inlined by Vite at BUILD time, so
 * anything baked in there would pin a single deployment forever.
 *
 * In development Vite serves the page on its own port while the game server is
 * elsewhere, so that case is named explicitly.
 */
function serverOrigin(): string {
  const override = import.meta.env.VITE_SERVER_URL;
  if (override) return override.replace(/\/$/, "");
  if (import.meta.env.DEV) return "http://localhost:2567";
  return location.origin;
}

const HTTP_ENDPOINT = serverOrigin();
const WS_ENDPOINT = HTTP_ENDPOINT.replace(/^http/, "ws");

const canvas = document.getElementById("game") as HTMLCanvasElement;
const hud = new Hud();
const world = createWorld(canvas);
const keyboard = new KeyboardInput();
const audio = new SoundBoard();
hud.setMuted(audio.isMuted);
hud.onToggleSound = () => audio.toggleMute();

// UI keys are deliberately NOT part of KeyboardInput: that class feeds the
// fixed-step simulation, and opening a bag or picking a target is a UI action
// with no place on the wire.
window.addEventListener("keydown", (event) => {
  // The title screen's inputs need their keys.
  if ((event.target as HTMLElement | null)?.tagName === "INPUT") return;
  if (event.repeat) return;
  switch (event.code) {
    case "KeyI":
      hud.toggleBag();
      break;
    case "KeyM":
      session?.toggleMap();
      break;
    case "Tab":
      // Otherwise the browser moves focus off the canvas.
      event.preventDefault();
      session?.cycleTarget();
      break;
    case "Escape":
      // Close whatever is open first; only then drop the target.
      if (session?.mapOpen) session.toggleMap();
      else if (hud.bagOpen) hud.toggleBag();
      else session?.clearTarget();
      break;
  }
});

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

/** The caster's own training. Nobody else's business, so it is not in state. */
interface ProfileMessage {
  affinity: number;
  spells: SpellProficiency;
  inventory: string[];
  equipment: Equipment;
  manaNow: number;
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

  // The realm scopes the stored session: point the client at a different
  // server and it correctly asks you to sign in again.
  const health = await fetch(`${HTTP_ENDPOINT}/health`)
    .then((r) => r.json() as Promise<{ realmId: string }>);

  const account = new AccountClient(HTTP_ENDPOINT, health.realmId);
  const character = await showTitleScreen(account);

  const client = new Client(WS_ENDPOINT);
  // What actually authorises the join. The room's static onAuth verifies this
  // before a seat is even reserved; the character id below only selects among
  // the characters this token already owns.
  client.auth.token = account.sessionToken ?? "";

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
        audio,
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
  session = createSession(world, next, ostra, hud, keyboard, cameraYaw, audio);

  hud.setOstra(ostra);
  hud.setStatus("connected");
  hud.buildAbilityBar();

  // Affinity and per-spell proficiency are private to this player, so they
  // arrive as a message rather than in replicated state. Asked for rather than
  // pushed: a send from the room's onJoin would race this handler being
  // registered, which is the same trap the character id fell into.
  next.onMessage("profile", (payload: ProfileMessage) => {
    hud.setProfile(payload.affinity, payload.spells);
    hud.setInventory(payload.inventory ?? [], payload.equipment ?? {});
  });
  next.onMessage("picked", (payload: { itemId: string }) => {
    hud.flash(`Picked up ${getItem(payload.itemId)?.name ?? "something"}`);
    audio.play("pickup");
  });
  next.onMessage("pickupFailed", () => hud.flash("Your pack is full."));

  hud.onEquip = (itemId) => next.send("equip", { itemId });
  hud.onUnequip = (slot) => next.send("unequip", { slot });
  next.send("requestProfile");

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
      session = createSession(world, previous, currentOstra, hud, keyboard, cameraYaw, audio);
    }
  } finally {
    travelling = false;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  hud.setStatus(error instanceof Error ? error.message : "failed to connect", true);
});
