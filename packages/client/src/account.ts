import { isOstraId, STARTING_OSTRA, type OstraId } from "@mmo/shared";

/**
 * Talking to the account and character endpoints.
 *
 * The session token lives in localStorage keyed by realm, so pointing the
 * client at a different server correctly means signing in again. The token is
 * what authorises everything; a character id is now just a selector among the
 * characters that token already owns.
 */

export interface CharacterSummary {
  id: string;
  name: string;
  ostraId: OstraId;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function tokenKey(realmId: string): string {
  return `ostracon:${realmId}:token`;
}

/** localStorage throws in some privacy modes; never let that stop the game. */
function read(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Non-fatal: they sign in again next reload.
  }
}

function clear(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Non-fatal.
  }
}

export class AccountClient {
  private token: string | undefined;

  constructor(private readonly endpoint: string, private readonly realmId: string) {
    this.token = read(tokenKey(realmId));
  }

  get sessionToken(): string | undefined {
    return this.token;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const headers = new Headers(init.headers);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);

    const response = await fetch(`${this.endpoint}${path}`, { ...init, headers });
    const body = await response.json().catch(() => undefined) as { error?: string } | undefined;

    if (!response.ok) {
      throw new ApiError(response.status, body?.error ?? `Request failed (${response.status}).`);
    }
    return body;
  }

  private keep(token: string): void {
    this.token = token;
    write(tokenKey(this.realmId), token);
  }

  signOut(): void {
    this.token = undefined;
    clear(tokenKey(this.realmId));
  }

  /** Is the stored token still good? Clears it if not, so a stale token does
   *  not cause a confusing failure three screens later. */
  async restore(): Promise<string | undefined> {
    if (!this.token) return undefined;
    try {
      const me = await this.request("/auth/me") as { email?: string };
      return me?.email;
    } catch {
      this.signOut();
      return undefined;
    }
  }

  async register(email: string, password: string): Promise<void> {
    const body = await this.request("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }) as { token: string };
    this.keep(body.token);
  }

  async signIn(email: string, password: string): Promise<void> {
    const body = await this.request("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }) as { token: string };
    this.keep(body.token);
  }

  async characters(): Promise<CharacterSummary[]> {
    const body = await this.request("/characters") as { characters?: unknown[] };
    return (body.characters ?? []).map(toSummary).filter((c): c is CharacterSummary => c !== undefined);
  }

  async createCharacter(name: string): Promise<CharacterSummary> {
    const body = await this.request("/characters", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    const summary = toSummary(body);
    if (!summary) throw new ApiError(500, "The server returned a character it could not describe.");
    return summary;
  }
}

function toSummary(value: unknown): CharacterSummary | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record["id"] !== "string" || typeof record["name"] !== "string") return undefined;
  return {
    id: record["id"],
    name: record["name"],
    // An Ostra this build doesn't know would leave us asking to join a room
    // that cannot exist; fall back rather than hanging on a failed join.
    ostraId: isOstraId(record["ostraId"]) ? record["ostraId"] : STARTING_OSTRA,
  };
}
