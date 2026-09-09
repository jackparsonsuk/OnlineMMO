import { createServer } from "node:http";
import cors from "cors";
import express from "express";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { OSTRA_IDS, ROOM_NAME } from "@mmo/shared";
import { setServerContext } from "./context.js";
import { createCharacter, isCharacterId } from "./identity.js";
import { OstraRoom } from "./rooms/OstraRoom.js";
import { SqliteCharacterStore } from "./store/SqliteCharacterStore.js";

const port = Number(process.env["PORT"] ?? 2567);

/**
 * The realm this process serves. Characters are scoped to it, so pointing two
 * deployments at the same database still gives players two separate worlds —
 * which is how the "different servers" model is meant to work.
 */
const realmId = process.env["REALM_ID"] ?? "local";
const databaseFile = process.env["DATABASE_FILE"] ?? "data/ostracon.db";

const store = new SqliteCharacterStore(databaseFile);
setServerContext({ realmId, store });

const app = express();
// The Vite dev server runs on a different origin, so the matchmaking HTTP
// calls that precede the websocket upgrade need CORS.
app.use(cors());
app.use(express.json({ limit: "4kb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, realmId, ostras: OSTRA_IDS });
});

/**
 * Character creation and lookup happen over HTTP, before any room is joined.
 *
 * This is what a character-select screen would talk to. It also solves a
 * concrete problem: a returning player has to know which Ostra their character
 * is standing in before it can ask to join that Ostra's room, and the answer
 * lives in the database, not the browser.
 *
 * ⚠ Unauthenticated and unthrottled — anyone can create characters in a loop.
 * Fine while this is a prototype; both are listed in the README as things that
 * must land before it is public.
 */
app.post("/characters", (req, res) => {
  const body = req.body as { name?: unknown } | undefined;
  const character = createCharacter(store, realmId, body?.name);
  res.status(201).json({
    id: character.id,
    name: character.name,
    ostraId: character.ostraId,
  });
});

app.get("/characters/:id", (req, res) => {
  const id = req.params.id;
  if (!isCharacterId(id)) {
    res.status(400).json({ error: "Malformed character id." });
    return;
  }
  const character = store.find(realmId, id);
  if (!character) {
    res.status(404).json({ error: "Unknown character." });
    return;
  }
  // The id is itself the credential, so anyone who can ask this already has
  // everything it returns. Still: no position, no timestamps, nothing extra.
  res.json({ id: character.id, name: character.name, ostraId: character.ostraId });
});

const httpServer = createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

// One room class, one room instance per Ostra. `filterBy` is what makes
// joinOrCreate("ostra", { ostraId: "barals" }) land in the Barals room rather
// than whichever room happens to have a free seat.
gameServer.define(ROOM_NAME, OstraRoom).filterBy(["ostraId"]);

await gameServer.listen(port);
console.log(
  `[server] realm "${realmId}" on ws://localhost:${port} ` +
  `— ${OSTRA_IDS.length} Ostras, saving to ${databaseFile}`,
);

// Rooms dispose when their last player leaves, and each disposal has already
// written that player's position. This closes the file handle cleanly so WAL
// checkpoints on the way out.
gameServer.onShutdown(() => {
  store.close();
});
