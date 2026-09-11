import type { Room, SeatReservation } from "@colyseus/sdk";
import { Client } from "@colyseus/sdk";
import {
  CLASSES,
  classUsesFamily,
  type ItemFamily,
  type ClassId,
  DEFAULT_CLASS,
  describeItem,
  type Equipment,
  getOstra,
  getQuest,
  type QuestLog,
  questMarker,
  isClassId,
  isOstraId,
  type ItemKey,
  rarityHex,
  ROOM_NAME,
  type OstraDefinition,
  SPELLS,
  spellsLearnedAt,
  WorldState,
} from "@mmo/shared";
import { AccountClient } from "./account.js";
import { SoundBoard } from "./audio.js";
import { CharacterScreen } from "./character.js";
import { DevMenu, type EliteStatus } from "./devtools.js";
import { QuestUI } from "./questUI.js";
import { VendorUI } from "./vendorUI.js";
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

/** Set per room in `enter`, so the screen always talks to the room you are in. */
let sendToRoom: ((type: string, payload?: unknown) => void) | undefined;

const characterScreen = new CharacterScreen(document.getElementById("character") as HTMLElement, {
  equip: (item, slot) => sendToRoom?.("equip", { item, slot }),
  unequip: (slot) => sendToRoom?.("unequip", { slot }),
  destroy: (item) => sendToRoom?.("destroy", { item }),
  openChanged: (open, shift) => session?.setPortrait(open, shift),
});

const questUI = new QuestUI({
  accept: (quest) => sendToRoom?.("questAccept", { quest }),
  abandon: (quest) => sendToRoom?.("questAbandon", { quest }),
  complete: (quest, choice) => sendToRoom?.("questComplete", { quest, choice }),
  notify: (text) => hud.flash(text, "#f0d98a"),
});

const vendorUI = new VendorUI({
  buy: (vendor, index) => sendToRoom?.("vendorBuy", { vendor, index }),
  sell: (vendor, item) => sendToRoom?.("vendorSell", { vendor, item }),
  sellAll: (vendor) => sendToRoom?.("vendorSellAll", { vendor }),
});

/** Your class and where you are on the curve, as the server last said. */
let classId: ClassId = DEFAULT_CLASS;
let level = 1;

/** Put the right mark over every villager, and the right hint in the bubble.
 *  Level matters: a quest you are too low for is no "!" yet. */
function refreshQuestMarkers(): void {
  const log = questUI.currentLog;
  session?.setQuestMarkers((id) => questMarker(id, log, level));
  hud.refreshSpeech();
}

/** Level and XP from the server: the bar, and everything a level unlocks. */
function applyProgress(nextLevel: number, xp: number, gained: number): void {
  const before = level;
  level = nextLevel;
  hud.setXp(level, xp);
  hud.xpGain(gained);
  characterScreen.setLevel(level);
  questUI.setLevel(level);
  vendorUI.setLevel(level);
  if (level === before) return;
  refreshQuestMarkers();
  // One banner per level crossed, each with what it taught.
  for (let reached = before + 1; reached <= level && gained > 0; reached++) {
    hud.levelUp(reached, spellsLearnedAt(classId, reached).map((id) => SPELLS[id].name));
  }
  if (gained > 0) audio.play("levelUp", 1);
}

function applyQuests(log: QuestLog | undefined, gold: number | undefined): void {
  questUI.setLog(log ?? { active: {}, done: [] });
  hud.setGold(gold ?? 0);
  refreshQuestMarkers();
}

// Cheats, on the backtick key. Not even constructed in a production build;
// the server refuses the commands there regardless.
const devMenu = import.meta.env.DEV
  ? new DevMenu(world, {
    send: (command) => sendToRoom?.("dev", command),
    session: () => session,
    ostra: () => currentOstra,
  })
  : undefined;

// UI keys are deliberately NOT part of KeyboardInput: that class feeds the
// fixed-step simulation, and opening a bag or picking a target is a UI action
// with no place on the wire.
window.addEventListener("keydown", (event) => {
  // The title screen's inputs need their keys.
  if ((event.target as HTMLElement | null)?.tagName === "INPUT") return;
  if (event.repeat) return;
  switch (event.code) {
    case "KeyI":
    case "KeyC":
      if (session) characterScreen.toggle();
      break;
    case "Backquote":
      devMenu?.toggle();
      break;
    case "KeyE": {
      const villager = session?.nearestVillager();
      if (villager?.vendor) {
        questUI.close();
        vendorUI.open(villager);
      } else if (villager) {
        vendorUI.close();
        questUI.talkTo(villager);
      }
      break;
    }
    case "KeyJ":
      if (session) questUI.toggleJournal();
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
      else if (vendorUI.close()) break;
      else if (questUI.close()) break;
      else if (characterScreen.isOpen) characterScreen.setOpen(false);
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

/** Your own class, XP, bag and gear. Nobody else's business, so not in state. */
interface ProfileMessage {
  classId: string;
  level: number;
  xp: number;
  inventory: ItemKey[];
  equipment: Equipment;
  quests?: QuestLog;
  gold?: number;
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
  characterScreen.setName(character.name);
  // Known before the room is, so the ability bar is right on the first frame.
  classId = isClassId(character.classId) ? character.classId : DEFAULT_CLASS;
  level = character.level ?? 1;
  // Quest rewards are derived from the character's id and class; the server
  // does the same.
  questUI.setCharacter(character.id, classId);

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

  world.engine.runRenderLoop(() => frame(performance.now()));

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
        characterScreen,
        frame,
        devMenu,
        /** Scatter one item of every rarity around you (dev server only).
         *  A `spread` under 1.4 m drops them straight into the bag. */
        loot: (level?: number, spread?: number) => room?.send("dev", { cmd: "scatter", level, spread }),
      },
    });
  }
}

/** One frame of everything: the world, then the character screen, which
 *  projects through the view the world was just drawn with. */
function frame(now: number): void {
  // Mid-transfer there is no session; keep drawing so the canvas doesn't
  // freeze on the last frame while the new room connects.
  if (session) session.frame(now);
  else world.scene.render();
  characterScreen.update(now, world.scene, canvas, session?.selfRig());
  devMenu?.update(now);
  if (session) {
    const self = session.selfPosition();
    questUI.update(self.x, self.z);
    vendorUI.update(self.x, self.z);
  }
}

/** Wire the client up to an Ostra it has just joined. */
function enter(client: Client, next: Room<unknown, WorldState>, ostra: OstraDefinition): void {
  room = next;
  currentOstra = ostra;
  applyOstra(world, ostra);
  session = createSession(world, next, ostra, hud, keyboard, cameraYaw, audio, classId);

  hud.setOstra(ostra);
  hud.setStatus("connected");
  hud.buildAbilityBar(classId);
  // A new Ostra is new villagers; mark them from what we already know.
  questUI.close();
  vendorUI.close();
  refreshQuestMarkers();

  // Class, XP, bag and gear are private to this player, so they arrive as a
  // message rather than in replicated state. Asked for rather than pushed: a
  // send from the room's onJoin would race this handler being registered,
  // which is the same trap the character id fell into.
  next.onMessage("profile", (payload: ProfileMessage) => {
    if (isClassId(payload.classId) && payload.classId !== classId) {
      classId = payload.classId;
      hud.buildAbilityBar(classId);
    }
    characterScreen.setProfile({
      classId,
      level: payload.level ?? level,
      inventory: payload.inventory ?? [],
      equipment: payload.equipment ?? {},
    });
    applyProgress(payload.level ?? level, payload.xp ?? 0, 0);
    hud.setPower(characterScreen.power);
    applyQuests(payload.quests, payload.gold);
    vendorUI.setProfile(payload.inventory ?? [], payload.gold ?? 0, level, classId);
  });
  next.onMessage("sold", (payload: { count: number; gold: number }) => {
    hud.flash(`Sold ${payload.count} item${payload.count === 1 ? "" : "s"} for ${payload.gold} gold`, "#f0c83c");
    audio.play("pickup");
  });
  next.onMessage("bought", (payload: { item: ItemKey; price: number }) => {
    const item = describeItem(payload.item);
    hud.flash(`Bought ${item?.name ?? "something"} for ${payload.price} gold`, item ? rarityHex(item.rarity) : undefined);
    audio.play("pickup");
  });
  next.onMessage("tooPoor", (payload: { price: number }) => hud.flash(`That costs ${payload.price} gold.`));
  next.onMessage("xp", (payload: { level: number; xp: number; gained: number }) => {
    applyProgress(payload.level, payload.xp, payload.gained);
  });
  next.onMessage("cannotWear", (payload: { level: number; family?: ItemFamily }) => {
    hud.flash(classUsesFamily(classId, payload.family)
      ? `You must be level ${payload.level} to wear that.`
      : `${CLASSES[classId].name}s cannot use that.`);
  });
  next.onMessage("quests", (payload: { quests: QuestLog; gold: number }) => applyQuests(payload.quests, payload.gold));
  next.onMessage("questDone", (payload: { quest: string; item?: ItemKey; xp?: number }) => {
    const quest = getQuest(payload.quest);
    if (!quest) return;
    const item = payload.item !== undefined ? describeItem(payload.item) : undefined;
    const xp = payload.xp ? ` · +${payload.xp.toLocaleString()} XP` : "";
    hud.announce("Quest complete", quest.title,
      `+${quest.rewards.gold} gold${xp}${item ? ` · ${item.name}` : ""}`, true);
    audio.play("pickup");
  });
  next.onMessage("picked", (payload: { item: ItemKey }) => {
    const item = describeItem(payload.item);
    hud.flash(`Picked up ${item?.name ?? "something"}`, item ? rarityHex(item.rarity) : undefined);
    audio.play("pickup");
  });
  next.onMessage("pickupFailed", () => hud.flash("Your pack is full."));
  next.onMessage("bagFull", () => hud.flash("No room in your pack for that."));
  // Rare elites: the whole Ostra hears when one wakes and when one falls.
  next.onMessage("elite", (payload: { event: string; name: string; title: string; region?: string; by?: string }) => {
    if (payload.event === "woke") {
      hud.announce("A rare foe stirs", payload.name, `${payload.title} — somewhere in ${payload.region}`, false);
    } else {
      hud.announce("Slain", payload.name, `Brought down by ${payload.by}`, true);
    }
  });
  next.onMessage("eliteStatus", (payload: EliteStatus[]) => devMenu?.showElites(payload));

  sendToRoom = (type, payload) => next.send(type, payload);
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
    // Stepping through a Gate with your pack open closes it; the session's
    // dispose puts the camera back.
    characterScreen.setOpen(false);
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
      session = createSession(world, previous, currentOstra, hud, keyboard, cameraYaw, audio, classId);
    }
  } finally {
    travelling = false;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  hud.setStatus(error instanceof Error ? error.message : "failed to connect", true);
});
