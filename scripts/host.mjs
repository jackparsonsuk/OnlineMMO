/**
 * Host a realm from this machine for friends: `npm run host`.
 *
 * Runs the production server (the same thing a host would run: no dev menu,
 * the client served from the same origin) on PORT, keeping its database in
 * data/ and its session secret in data/host-secret so a restart does not sign
 * everyone out. Then, if Cloudflare's `cloudflared` is installed, opens a quick
 * tunnel — a free public https address that forwards to this machine, with
 * WebSockets, no account and no router settings — and prints the link to send.
 *
 * The link changes every time the tunnel starts; the realm is only up while
 * this is running and the machine is awake. Build first with `npm run build`
 * (the `host` script does).
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const port = process.env.PORT ?? "2567";
const dataDir = join(root, "data");
mkdirSync(dataDir, { recursive: true });

// A secret made once and kept, so sessions survive restarts.
const secretFile = join(dataDir, "host-secret");
if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32).toString("hex"));
const secret = readFileSync(secretFile, "utf8").trim();

if (!existsSync(join(root, "packages/server/dist/index.js")) || !existsSync(join(root, "packages/client/dist/index.html"))) {
  console.error("[host] No build found. Run `npm run build` first (or `npm run host`, which does).");
  process.exit(1);
}

const server = spawn(process.execPath, [join(root, "packages/server/dist/index.js")], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: port,
    JWT_SECRET: secret,
    REALM_ID: process.env.REALM_ID ?? "home",
    DATABASE_FILE: process.env.DATABASE_FILE ?? join(dataDir, "ostracon.db"),
    // cloudflared is one proxy in front; rate limits must see real addresses.
    TRUST_PROXY: "1",
  },
});

/** cloudflared on PATH, or where the Windows installer puts it. */
function findCloudflared() {
  const candidates = [
    "cloudflared",
    "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
    "C:\\Program Files\\cloudflared\\cloudflared.exe",
    join(homedir(), "AppData", "Local", "Microsoft", "WinGet", "Links", "cloudflared.exe"),
  ];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (probe.status === 0) return candidate;
  }
  return undefined;
}

let tunnel;
const cloudflared = process.argv.includes("--no-tunnel") ? undefined : findCloudflared();
if (!cloudflared) {
  console.log(`
[host] Realm running on http://localhost:${port} — only this machine can reach it.
[host] To let friends in over the internet, install Cloudflare's tunnel once:
         winget install --id Cloudflare.cloudflared
       then run \`npm run host\` again and send them the link it prints.
`);
} else {
  tunnel = spawn(cloudflared, ["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let announced = false;
  const watch = (chunk) => {
    const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(chunk));
    if (!match || announced) return;
    announced = true;
    console.log(`
[host] ─────────────────────────────────────────────────────────────
[host]  Friends can play at:  ${match[0]}
[host]  (The link lasts until this stops. Keep this window open.)
[host] ─────────────────────────────────────────────────────────────
`);
  };
  tunnel.stdout.on("data", watch);
  tunnel.stderr.on("data", watch);
  tunnel.on("exit", (code) => console.log(`[host] tunnel stopped (${code}).`));
}

const stop = () => {
  tunnel?.kill();
  server.kill("SIGINT");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
server.on("exit", (code) => {
  tunnel?.kill();
  process.exit(code ?? 0);
});
