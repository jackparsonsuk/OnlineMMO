import { createServer } from "node:http";
import cors from "cors";
import express from "express";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { ROOM_NAME } from "@mmo/shared";
import { WorldRoom } from "./rooms/WorldRoom.js";

const port = Number(process.env.PORT ?? 2567);

const app = express();
// The Vite dev server runs on a different origin, so the matchmaking HTTP
// calls that precede the websocket upgrade need CORS.
app.use(cors());
app.get("/health", (_req, res) => {
  res.json({ ok: true, room: ROOM_NAME });
});

const httpServer = createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define(ROOM_NAME, WorldRoom);

await gameServer.listen(port);
console.log(`[server] listening on ws://localhost:${port} (room: "${ROOM_NAME}")`);
