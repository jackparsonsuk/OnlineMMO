import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { matchMaker, Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { OSTRA_IDS, ROOM_NAME, settlementProblems, unsafeElites, unsafeSpawns } from "@mmo/shared";
import { setServerContext } from "./context.js";
import {
  AuthError,
  bearerFrom,
  configureAuth,
  loginAccount,
  registerAccount,
  verifyToken,
} from "./auth.js";
import { createCharacter, isCharacterId } from "./identity.js";
import { apiLimiter, loginLimiter, registerLimiter } from "./rateLimit.js";
import { OstraRoom } from "./rooms/OstraRoom.js";
import { SqliteCharacterStore } from "./store/SqliteCharacterStore.js";

const port = Number(process.env["PORT"] ?? 2567);

/**
 * The realm this process serves. Characters are scoped to it, so pointing two
 * deployments at the same database still gives players two separate worlds —
 * which is how the "different servers" model is meant to work.
 */
const realmId = process.env["REALM_ID"] ?? "local";

/** Per account, per realm. */
const MAX_CHARACTERS_PER_ACCOUNT = 5;
const databaseFile = process.env["DATABASE_FILE"] ?? "data/ostracon.db";
const isProduction = process.env["NODE_ENV"] === "production";

/**
 * How many reverse proxies sit in front of this server.
 *
 * Behind a proxy, every request appears to come from the proxy unless Express
 * is told to read `X-Forwarded-For` — which would rate-limit the whole world as
 * one client. But trusting that header blindly is worse: anyone can set it and
 * become a fresh IP whenever they are throttled. So this is a HOP COUNT, not a
 * boolean: Express then reads the correct entry and ignores the spoofable rest.
 *
 * 0 (the default) means no proxy — correct for local development and for
 * running the container directly. Railway, Fly and most managed hosts put
 * exactly one in front, so set TRUST_PROXY=1 there.
 */
const trustProxy = Number(process.env["TRUST_PROXY"] ?? 0);

/**
 * Origins allowed to call the HTTP endpoints, comma separated.
 *
 * Empty means same-origin only, which is the production shape: the server
 * serves the built client itself, so there is no cross-origin call to allow.
 * In development Vite runs on its own port and needs naming.
 */
const allowedOrigins = (process.env["ALLOWED_ORIGINS"] ?? (isProduction ? "" : "http://localhost:5173"))
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

const store = new SqliteCharacterStore(databaseFile);
setServerContext({ realmId, store, devTools: !isProduction });

configureAuth(process.env["JWT_SECRET"], isProduction);

const app = express();
if (trustProxy > 0) app.set("trust proxy", trustProxy);
// Pinned rather than wide open. In development the Vite dev server is a
// different origin and must be named; in production the client is served from
// this same origin and the list is empty, which denies everyone else.
app.use(cors({
  origin: allowedOrigins.length > 0 ? allowedOrigins : false,
  credentials: true,
}));
app.use(express.json({ limit: "4kb" }));
app.use(apiLimiter());

/** Wrap a handler so a thrown AuthError becomes its status rather than a 500. */
function handle(fn: (req: express.Request, res: express.Response) => Promise<void> | void) {
  return (req: express.Request, res: express.Response): void => {
    void (async () => {
      try {
        await fn(req, res);
      } catch (error) {
        if (error instanceof AuthError) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        console.error("[http]", error);
        res.status(500).json({ error: "Something went wrong." });
      }
    })();
  };
}

/** Resolve the caller's account from their bearer token, or 401. */
async function requireAccount(req: express.Request): Promise<string> {
  const claims = await verifyToken(bearerFrom(req.headers.authorization));
  if (!claims) throw new AuthError(401, "Sign in first.");
  return claims.sub;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, realmId, ostras: OSTRA_IDS });
});

/**
 * Live room census. Exists to answer one question quickly: does a room hold
 * more players than it holds connections? A mismatch means state and clients
 * have diverged; equal counts mean every player on screen is a real socket.
 */
app.get("/debug/rooms", async (_req, res) => {
  const rooms = await matchMaker.query({});
  res.json(rooms.map((room) => {
    const local = matchMaker.getLocalRoomById(room.roomId);
    return {
      roomId: room.roomId,
      ostraId: (room.metadata as { ostraId?: string } | undefined)?.ostraId
        ?? (local?.state as { ostraId?: string } | undefined)?.ostraId,
      clients: local ? local.clients.length : room.clients,
      players: (local?.state as { players?: { size: number } } | undefined)?.players?.size,
      names: local
        ? [...((local.state as { players: Map<string, { name: string; health: number }> }).players)
            .values()].map((p) => `${p.name}:${p.health}`)
        : undefined,
    };
  }));
});

// --- accounts ---------------------------------------------------------------

app.post("/auth/register", registerLimiter(), handle(async (req, res) => {
  const body = req.body as { email?: unknown; password?: unknown } | undefined;
  const { token, account } = await registerAccount(store, body?.email, body?.password);
  res.status(201).json({ token, email: account.email });
}));

app.post("/auth/login", loginLimiter(), handle(async (req, res) => {
  const body = req.body as { email?: unknown; password?: unknown } | undefined;
  const { token, account } = await loginAccount(store, body?.email, body?.password);
  res.json({ token, email: account.email });
}));

/** Confirms a token is still good, and says who it belongs to. */
app.get("/auth/me", handle(async (req, res) => {
  const accountId = await requireAccount(req);
  const account = store.findAccountById(accountId);
  if (!account) throw new AuthError(401, "That account no longer exists.");
  res.json({ email: account.email });
}));

// --- characters -------------------------------------------------------------

/**
 * The character list for the signed-in account, in this realm.
 *
 * This is what a character-select screen talks to. Ownership is checked here
 * and again on room join — a character id is no longer a credential, so
 * knowing one gets you nothing.
 */
app.get("/characters", handle(async (req, res) => {
  const accountId = await requireAccount(req);
  const characters = store
    .charactersForAccount(realmId, accountId)
    .map((id) => store.find(realmId, id))
    .filter((character) => character !== undefined)
    .map((character) => ({
      id: character.id,
      name: character.name,
      ostraId: character.ostraId,
      colour: character.colour,
    }));
  res.json({ characters });
}));

app.post("/characters", handle(async (req, res) => {
  const accountId = await requireAccount(req);

  // A cap, so one account cannot fill the table on its own.
  if (store.charactersForAccount(realmId, accountId).length >= MAX_CHARACTERS_PER_ACCOUNT) {
    throw new AuthError(409, `An account may hold ${MAX_CHARACTERS_PER_ACCOUNT} characters.`);
  }

  const body = req.body as { name?: unknown } | undefined;
  const character = createCharacter(store, realmId, accountId, body?.name);
  res.status(201).json({
    id: character.id,
    name: character.name,
    ostraId: character.ostraId,
  });
}));

app.get("/characters/:id", handle(async (req, res) => {
  const accountId = await requireAccount(req);
  const id = req.params.id;
  if (!isCharacterId(id)) throw new AuthError(400, "Malformed character id.");

  const character = store.find(realmId, id);
  if (!character || character.accountId !== accountId) {
    // Same answer for "does not exist" and "not yours", so the endpoint cannot
    // be used to discover which character ids are real.
    throw new AuthError(404, "No such character.");
  }
  res.json({ id: character.id, name: character.name, ostraId: character.ostraId });
}));

/**
 * Serve the built client from this same origin.
 *
 * This is what makes deployment one artifact instead of two. Same origin means
 * no CORS to configure, no server URL baked into the client bundle at build
 * time, and one certificate. A CDN would be faster, and at a few hundred
 * concurrent players that difference is not worth a second deployment.
 *
 * Skipped when the bundle is absent, which is the normal development case —
 * Vite is serving the client on its own port.
 */
const clientDist = process.env["CLIENT_DIST"]
  ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../client/dist");

if (existsSync(join(clientDist, "index.html"))) {
  app.use(express.static(clientDist, { index: false }));
  // Anything not matched above is the single page app.
  app.get(/.*/, (_req, res) => {
    res.sendFile(join(clientDist, "index.html"));
  });
  console.log(`[server] serving client from ${clientDist}`);
} else if (isProduction) {
  console.warn(
    `[server] no client bundle at ${clientDist} — API only. ` +
    "Run `npm run build` before starting in production.",
  );
}

const httpServer = createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

// One room class, one room instance per Ostra. `filterBy` is what makes
// joinOrCreate("ostra", { ostraId: "barals" }) land in the Barals room rather
// than whichever room happens to have a free seat.
gameServer.define(ROOM_NAME, OstraRoom).filterBy(["ostraId"]);

// Loud, not fatal: a badly placed camp makes the game miserable rather than
// broken, and refusing to boot over level design would be worse.
for (const problem of [...unsafeSpawns(), ...unsafeElites()]) {
  console.warn(`[spawn] ${problem}`);
}
for (const problem of settlementProblems()) {
  console.warn(`[town] ${problem}`);
}

const orphans = store.countOrphanedCharacters();
if (orphans > 0) {
  console.warn(
    `[accounts] ${orphans} character(s) predate accounts and have no owner. ` +
    "They are listed for nobody and cannot be played. Delete them, or assign " +
    "an account_id by hand.",
  );
}

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
