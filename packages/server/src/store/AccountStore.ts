/**
 * Accounts, and the characters that belong to them.
 *
 * Accounts are GLOBAL; characters are per-realm. One login gets you into every
 * realm, and you have a separate character on each — which is how "different
 * servers" is supposed to feel, and why `realm_id` lives on the character and
 * not here.
 */

export interface AccountRecord {
  /** Random 128-bit id. Never leaves the server except inside a signed token. */
  id: string;
  /** Lower-cased and trimmed before storage, so logins are case-insensitive. */
  email: string;
  /**
   * The output of `Hash.make()` — a scrypt digest with its parameters and salt
   * encoded in the string. NEVER a password.
   */
  password: string;
  createdAt: number;
  lastLoginAt: number;
}

export interface AccountStore {
  findAccountByEmail(email: string): AccountRecord | undefined;
  findAccountById(id: string): AccountRecord | undefined;
  createAccount(account: AccountRecord): void;
  touchLogin(id: string): void;
  /** Every character this account owns in the given realm. */
  charactersForAccount(realmId: string, accountId: string): string[];
  /** How many characters exist with no owner, from before accounts existed. */
  countOrphanedCharacters(): number;
}
