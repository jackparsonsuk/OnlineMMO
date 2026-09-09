import type { CharacterStore } from "./store/CharacterStore.js";

/**
 * Process-wide services the rooms need. Rooms are constructed by Colyseus's
 * matchmaker, so they can't be handed dependencies through a constructor, and
 * `define()`'s default options travel through matchmaking as JSON — no place
 * for a live database handle. A tiny module-scoped context is the honest way
 * to bridge that.
 */
export interface ServerContext {
  /** Identifies this server ("realm" in MMO terms). Characters are scoped to it. */
  realmId: string;
  store: CharacterStore;
}

let context: ServerContext | undefined;

export function setServerContext(next: ServerContext): void {
  context = next;
}

export function getServerContext(): ServerContext {
  if (!context) throw new Error("Server context used before it was set");
  return context;
}
