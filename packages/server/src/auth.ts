import { randomBytes } from "node:crypto";
import { Hash, JWT } from "@colyseus/auth";
import type { AccountRecord, AccountStore } from "./store/AccountStore.js";

/**
 * Accounts and sessions.
 *
 * This replaces the previous scheme, where the character id in localStorage
 * *was* the credential and anyone who learned one could play as that character.
 *
 * Nothing here invents cryptography. `Hash` is `@colyseus/auth`'s scrypt-based
 * password hashing — the salt and parameters are encoded into the stored string
 * and `Hash.verify` compares in constant time — and `JWT` is `jsonwebtoken`.
 * Hand-rolled auth is how people end up storing passwords they can read.
 */

/** Sessions last a week. Long enough not to nag, short enough that a leaked
 *  token stops working. */
const TOKEN_LIFETIME = "7d";

/** Below this, a password is not worth the storage. Deliberately a floor on
 *  length rather than a composition rule: length is what actually helps, and
 *  "must contain a symbol" mostly produces `Password1!`. */
const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 200;

export interface SessionClaims {
  /** Account id. */
  sub: string;
  email: string;
}

export class AuthError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * Configure signing, and fail loudly in production if no secret was provided.
 *
 * A default secret that ships in the repository is the same as no secret at
 * all: anyone could mint a token for any account. In development we generate a
 * random one per boot, which invalidates existing sessions on restart — an
 * inconvenience, and the correct one.
 */
export function configureAuth(secret: string | undefined, isProduction: boolean): void {
  if (!secret && isProduction) {
    throw new Error(
      "JWT_SECRET must be set in production. Without it, anyone can forge a session token.",
    );
  }

  if (!secret) {
    console.warn(
      "[auth] No JWT_SECRET set — using a random one for this process. " +
      "Sessions will not survive a restart.",
    );
  }

  JWT.settings.secret = secret ?? randomBytes(32).toString("hex");
}

function validateEmail(raw: unknown): string {
  if (typeof raw !== "string") throw new AuthError(400, "An email address is required.");
  const email = raw.trim().toLowerCase();
  // Deliberately loose. Strict email regexes reject valid addresses, and the
  // only real proof an address works is sending to it — which is a later job.
  if (email.length < 3 || email.length > 254 || !email.includes("@")) {
    throw new AuthError(400, "That does not look like an email address.");
  }
  return email;
}

function validatePassword(raw: unknown): string {
  if (typeof raw !== "string") throw new AuthError(400, "A password is required.");
  if (raw.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError(400, `Passwords must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (raw.length > MAX_PASSWORD_LENGTH) {
    throw new AuthError(400, "That password is unreasonably long.");
  }
  return raw;
}

export async function registerAccount(
  store: AccountStore,
  email: unknown,
  password: unknown,
): Promise<{ token: string; account: AccountRecord }> {
  const cleanEmail = validateEmail(email);
  const cleanPassword = validatePassword(password);

  if (store.findAccountByEmail(cleanEmail)) {
    // Telling the truth here leaks who has an account. That is a real
    // trade-off, and this side of it is chosen deliberately: a registration
    // form that cannot say "already taken" is genuinely confusing, and the
    // membership of a hobby game's account list is not worth the confusion.
    throw new AuthError(409, "There is already an account with that email.");
  }

  const account: AccountRecord = {
    id: randomBytes(16).toString("hex"),
    email: cleanEmail,
    password: await Hash.make(cleanPassword),
    createdAt: Date.now(),
    lastLoginAt: Date.now(),
  };

  store.createAccount(account);
  return { token: await issueToken(account), account };
}

export async function loginAccount(
  store: AccountStore,
  email: unknown,
  password: unknown,
): Promise<{ token: string; account: AccountRecord }> {
  const cleanEmail = validateEmail(email);
  if (typeof password !== "string") throw new AuthError(400, "A password is required.");

  const account = store.findAccountByEmail(cleanEmail);

  // Hash even when the account does not exist. Skipping it would return in
  // microseconds instead of milliseconds, and that difference is enough to
  // enumerate which addresses are registered.
  const stored = account?.password ?? DUMMY_HASH;
  const ok = await Hash.verify(password, stored);

  if (!account || !ok) throw new AuthError(401, "Wrong email or password.");

  store.touchLogin(account.id);
  return { token: await issueToken(account), account };
}

/** A real hash of a value nobody knows, so the failure path costs the same as
 *  the success path. Computed once at import. */
const DUMMY_HASH = await Hash.make(randomBytes(24).toString("hex"));

/**
 * A token good for two minutes, for carrying a player through a Gate.
 *
 * The server reserves the seat in the next Ostra itself, and Colyseus only
 * runs `onAuth` for a reservation that brings an auth context — without one
 * the seat arrives with no account, the destination's `onJoin` refuses it, and
 * the player is stranded in the old Ostra with their save already moved.
 */
export async function issueTransferToken(accountId: string): Promise<string> {
  const claims: SessionClaims = { sub: accountId, email: "" };
  return JWT.sign(claims, { expiresIn: "2m" });
}

async function issueToken(account: AccountRecord): Promise<string> {
  const claims: SessionClaims = { sub: account.id, email: account.email };
  return JWT.sign(claims, { expiresIn: TOKEN_LIFETIME });
}

/** Verify a bearer token and return its claims, or undefined if it is not
 *  valid — expired, tampered with, or signed by a different secret. */
export async function verifyToken(token: unknown): Promise<SessionClaims | undefined> {
  if (typeof token !== "string" || token.length === 0) return undefined;
  try {
    return await JWT.verify<SessionClaims>(token);
  } catch {
    return undefined;
  }
}

/** Pull a bearer token out of an Authorization header. */
export function bearerFrom(header: unknown): string | undefined {
  if (typeof header !== "string") return undefined;
  const match = /^Bearer (.+)$/i.exec(header.trim());
  return match?.[1];
}
