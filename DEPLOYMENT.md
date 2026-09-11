# Deploying Ostracon

Everything needed to put this online, and the traps that will bite if you skip
a step.

---

## What this needs from a host

Four things. Miss any one and it either doesn't run or quietly loses data.

| Requirement | Why |
| --- | --- |
| **A long-running process** | The world lives in RAM and ticks at 30 Hz whether or not a request is in flight |
| **WebSocket support** | All game traffic; HTTP is only sign-in and the character list |
| **A persistent volume** | Characters and accounts are a SQLite file. Ephemeral disk = wiped on every deploy |
| **TLS termination** | Browsers refuse `wss://` from an HTTPS page |

### Why serverless can't host this

Not a configuration problem — a shape mismatch. Vercel, Netlify Functions,
Lambda and friends spin a function up per request and destroy it afterwards.
This server:

- holds WebSocket connections open for a whole session,
- keeps the entire world in memory — players, creatures, every creature's AI
  memory, the rewind history used for lag-compensated hits,
- runs a fixed 30 Hz simulation continuously.

There is nowhere to put a zombie's brain between invocations.

You *could* host the client on Vercel, since that's static files. But the server
serves the client from its own origin on purpose — that's what removes CORS and
removes the server URL baked into the bundle at build time. Splitting them
reintroduces both, for no gain at this scale.

---

## Option 1: Railway (easiest)

Docker, volumes, and TLS with no configuration.

1. Push this repository to GitHub.
2. **New Project → Deploy from GitHub repo.** Railway reads `railway.json` and
   builds the `Dockerfile`.
3. **Add a volume** mounted at `/app/data`. ← *Do not skip this.*
4. Set the variables below under **Variables**.
5. **Settings → Networking → Generate Domain.** TLS is automatic.

```bash
JWT_SECRET=<generate one, see below>
NODE_ENV=production
REALM_ID=eu-1
DATABASE_FILE=/app/data/ostracon.db
TRUST_PROXY=1
PORT=2567
```

## Option 2: Fly.io

Closer to a real deployment, still cheap. `fly.toml` is in the repository.

```bash
fly launch --no-deploy          # keeps the existing fly.toml
fly volumes create ostracon_data --size 1 --region lhr
fly secrets set JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
fly deploy
```

`fly.toml` already sets `auto_stop_machines = false`. Leave it that way — a
suspended machine is a stopped world, and the simulation must keep ticking.

Use the CLI rather than the dashboard's "Launch from GitHub": that path runs
`flyctl launch plan propose`, which proposes its own settings over yours. App
names are global on Fly — if `ostracon` is taken, change `app` in `fly.toml`.
Fly mounts volumes owned by root; the image's entrypoint hands `/app/data` to
the `node` user before starting, so the server can write its database.

## Option 3: A plain VPS with Docker

Most control, most work: TLS, updates and restarts are yours.

```bash
docker build -t ostracon .
docker volume create ostracon-data
docker run -d --name ostracon \
  --restart unless-stopped \
  -p 127.0.0.1:2567:2567 \
  -v ostracon-data:/app/data \
  --env-file .env \
  ostracon
```

Bind to `127.0.0.1` and put Caddy or nginx in front for TLS. With Caddy the
whole config is two lines:

```caddyfile
play.example.com {
    reverse_proxy 127.0.0.1:2567
}
```

Caddy handles certificates and WebSocket upgrades on its own. Set
`TRUST_PROXY=1` so the server reads the real client IP.

---

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `JWT_SECRET` | random per boot | **Required in production** — the server refuses to start without it |
| `NODE_ENV` | | `production` enables strict checks and static client serving |
| `REALM_ID` | `local` | Names this world. Characters are scoped to it |
| `DATABASE_FILE` | `data/ostracon.db` | Put this on the mounted volume |
| `PORT` | `2567` | |
| `TRUST_PROXY` | `0` | **Hop count, not a boolean.** `1` behind one reverse proxy |
| `ALLOWED_ORIGINS` | dev only | Leave empty in production; the client is same-origin |
| `CLIENT_DIST` | `packages/client/dist` | Where the built client lives |

Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Why `TRUST_PROXY` is a number

Behind a proxy every request appears to come from the proxy, which would rate
limit the entire internet as one client. Telling Express to read
`X-Forwarded-For` fixes that — but trusting the header blindly is worse, because
anyone can set it and mint themselves a fresh IP whenever they're throttled.

The hop count makes Express read the correct entry and ignore the spoofable
rest. Use `1` for Railway, Fly, and a single nginx or Caddy. Use `0` when
nothing sits in front.

---

## The trap that will actually get you

**Ephemeral filesystems.** Several hosts give you a container whose disk is
discarded on every deploy. Everything works perfectly — accounts, characters,
gear — right up until your first redeploy, when the entire realm vanishes.

The `Dockerfile` declares `VOLUME ["/app/data"]`, but declaring is not mounting.
You must attach a real volume:

- **Railway** — add a volume at `/app/data` in the service settings
- **Fly** — `fly volumes create ostracon_data` (already wired in `fly.toml`)
- **Docker** — `-v ostracon-data:/app/data`

Verify after your *second* deploy, not your first: sign in, confirm your
character is still there.

---

## Backups

The database is one file, but **do not copy it with `cp` while the server is
running.** It runs in WAL mode, so recent writes live in a separate `-wal` file
and a plain copy can catch the pair mid-transaction.

Ask SQLite for a consistent snapshot instead. Safe on a live database:

```bash
npm run backup                       # -> backups/ostracon-<timestamp>.db
npm run backup -- /app/data/ostracon.db /backups/nightly.db
```

Inside a container:

```bash
docker exec ostracon node scripts/backup.mjs /app/data/ostracon.db /app/data/backup.db
docker cp ostracon:/app/data/backup.db ./
```

A nightly cron of that, copied off the host, is a complete backup strategy at
this scale.

---

## Running more than one realm

One process serves one realm. Characters are scoped by `REALM_ID`, so two
deployments are two separate worlds and a player has a separate character in
each — with one account that works in both.

Run a second container with a different `REALM_ID` and `DATABASE_FILE`. They
share nothing and need to know nothing about each other.

**Do not run two processes for the *same* realm.** Room state lives in memory,
so they would be two separate worlds wearing one name, and both would write to
one SQLite file. That needs a Redis presence and driver, plus Postgres, first.

---

## When SQLite stops being enough

It is genuinely the right choice now, not a compromise — one process, hundreds
of concurrent players, one file to back up. Move to Postgres when you want:

- **more than one process per realm** (SQLite is single-writer),
- managed backups and point-in-time recovery rather than copying a file,
- queries *across* characters — leaderboards, analytics, "who owns a Gatecutter".

`CharacterStore` and `AccountStore` are interfaces for exactly this. Implement
them over Postgres and change the one line in `packages/server/src/index.ts`
that constructs the SQLite version. Nothing in the rooms knows the difference.

---

## Operating notes

**Boot warnings worth reading.** The server reports problems at startup rather
than failing silently:

- `[spawn] …` — a creature camp can reach a spawn point, so players will
  respawn into a fight. Level-design bug, fix the table.
- `[accounts] N character(s) predate accounts` — saves from before
  authentication existed. They belong to nobody and cannot be played. Assign an
  `account_id` by hand or delete them.
- `[auth] No JWT_SECRET set` — should never appear in production; if it does,
  `NODE_ENV` isn't `production`.

**Health check.** `GET /health` returns the realm id and Ostra list. It is
exempt from rate limiting, so an orchestrator polling every 30 s will never be
throttled into killing a healthy container.

**Rate limits** are in-memory and per-process: 10 failed sign-ins per IP per 15
minutes, 5 registrations per hour, 300 other API calls per 15 minutes.
Matchmaking and health are exempt. Note that ten wrong guesses locks that IP out
for fifteen minutes *even with the correct password* — that is the point, but
it's worth knowing before you lock yourself out testing.

**Upgrading.** Redeploy and the process restarts; players reconnect. Database
migrations run automatically at boot and are additive — new columns get
defaults, existing rows are left alone. Take a backup first anyway.

---

## Before you let strangers in

- [ ] `JWT_SECRET` set, and not the one from any example
- [ ] Volume mounted, **verified after a second deploy**
- [ ] TLS working — the page loads over `https://` and the socket over `wss://`
- [ ] `TRUST_PROXY` matches your actual proxy count
- [ ] `ALLOWED_ORIGINS` empty
- [ ] A backup taken, and a restore actually tested
- [ ] Boot logs clean of `[spawn]` and `[auth]` warnings

Still missing, and worth knowing you're accepting: **no email verification and
no password reset** — an address is never proved, and a forgotten password is a
lost account.
