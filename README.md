# OnlineMMO

A browser MMO prototype: cubes walking around a shared world, on
[Babylon.js](https://www.babylonjs.com/) and [Colyseus](https://colyseus.io/).

Movement is **server-authoritative**. The client never sends a position — only
which keys are held and which way the camera is pointing. The server simulates
at a fixed 30 Hz and owns every coordinate.

## Running it

```bash
npm install
npm run dev
```

Then open http://localhost:5173. Open it a second time in another window to see
two players. The Colyseus server listens on `ws://localhost:2567`.

| Script | What it does |
| --- | --- |
| `npm run dev` | Builds `shared`, then runs the server and client together |
| `npm run dev:server` / `npm run dev:client` | One side only |
| `npm run typecheck` | Type-checks all three packages |

Point the client at another host with `VITE_SERVER_URL=ws://…`.

## Layout

```
packages/
  shared/   schema, tuning constants, and the movement simulation
  server/   Colyseus room — the authority
  client/   Babylon scene, camera, prediction
```

`shared` exists so the movement code is written **once**. `applyInput()` runs on
the server to advance the real state, and on the client to predict and to replay
after a correction. If those two ever diverge you get permanent rubber-banding,
so they are literally the same compiled function.

## How a step works

1. Once per fixed step, the client samples the keyboard and camera heading and
   sends a `MoveInput` (`moveX`, `moveZ`, `yaw`). Nothing else.
2. The server buffers each client's inputs and drains them in its own
   `setFixedTimestep` loop, applying `applyInput()` to the authoritative
   `Player`. Inputs are clamped there — a client that sends `moveX: 99` gains
   nothing.
3. State patches go out every 50 ms, carrying an ack of how many inputs the
   server has actually consumed.
4. The client predicts its own cube immediately, and on each patch rewinds to
   the server's position and replays the inputs that weren't acked yet. Other
   players are interpolated ~120 ms in the past, so they always move between two
   real samples rather than guessing.

Steps 3 and 4 are the SDK's `Predict` / `Reconciler`; step 2 is the room's
`defineInput` buffer. The tick rate is advertised by the server through the join
handshake, so both sides predict on exactly the same `dt`.

## Things deliberately left out

- **No collision.** Players walk through each other; the only limit is the world
  boundary that `applyInput` clamps to.
- **No persistence, accounts, or zones.** One room, everyone in it, state lives
  in memory and dies with the process.
- **Names are client-supplied** (trimmed and length-capped, but not unique).
- **`y` is always 0.** It is in the schema and the movement state so terrain and
  jumping don't need a wire format change, but nothing moves vertically yet.

## Debugging

In dev, `window.mmo` exposes `{ room, predict, input, keyboard, meshes, frame }`.
`frame(now)` runs a single render/network frame on a clock you supply — useful
because `requestAnimationFrame` stops in a background tab, which otherwise makes
the client look frozen when you are testing two windows at once.
