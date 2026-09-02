/**
 * Server-side storage for the two short-lived correlations an authorization
 * code flow needs, and for nothing else.
 *
 *   the FLOW    opened by /auth/sso/:provider/start, closed by
 *               /auth/sso/callback. It holds the PKCE verifier, the nonce and
 *               the browser binding. The `state` parameter that travels
 *               through the identity provider is a lookup key and nothing
 *               more: it carries no user input, encodes no claim, and is
 *               worthless to anyone who does not also hold the record.
 *   the TICKET  opened by a successful callback in redirect mode, closed by
 *               POST /auth/sso/ticket. It exists so that a browser
 *               redirect never carries a refresh token in a URL, where it
 *               would land in history, in the Referer header and in every
 *               proxy log between here and the user.
 *
 * Both are single-use and short-lived, and both are swept lazily on access —
 * never on a timer. That is the house rule for expiry everywhere on this
 * platform, and it happens to be the right one here too: a cron that clears
 * login state is a cron that can fail silently while sign-ins keep working,
 * so nobody notices until the map has a million dead entries in it.
 *
 * WHERE THIS LIVES, AND THE LIMIT THAT IMPOSES
 * --------------------------------------------
 * In process memory, keyed by database handle. The schema this module was
 * given has no table for in-flight authorization state, and inventing one is
 * outside this module's ownership, so the store is an interface with an
 * in-memory implementation behind it. The consequence is honest and must be
 * stated rather than discovered: **a multi-instance deployment needs either a
 * shared implementation of `SsoFlowStore` (Redis, or a table) or sticky
 * routing on /api/v1/auth/sso/***, because the callback must land on the
 * instance that issued the state. A restart mid-sign-in fails closed — the
 * user is asked to start again, which is the correct failure.
 */
import { randomBytes } from "node:crypto";
import { sha256Hex } from "@constructos/ledger";
import type { Db } from "../../lib/db.js";

/** The in-flight authorization code flow. */
export interface SsoFlowRecord {
  providerId: string;
  companyId: string;
  /** the value the id_token must echo back in its `nonce` claim */
  nonce: string;
  /** RFC 7636 code_verifier; the challenge derived from it went to the IdP */
  codeVerifier: string;
  /** exactly the redirect_uri sent to the authorize endpoint; replayed at token exchange */
  redirectUri: string;
  /** how the callback answers: JSON body, or a redirect carrying a ticket */
  mode: "json" | "redirect";
  /** same-site relative path to return the browser to; never an absolute URL */
  returnTo: string | null;
  /**
   * set when the flow was opened by an ALREADY AUTHENTICATED user asking to
   * link this provider to their account. Its presence is the whole reason
   * account linking is safe: the account being linked to was fixed at start
   * time, from a verified bearer token, and cannot be influenced by anything
   * the identity provider later asserts.
   */
  linkUserId: string | null;
  /** sha256 of the browser-binding cookie value; null when no cookie was set */
  bindingHash: string | null;
  createdAtMs: number;
  expiresAtMs: number;
}

/** A successful sign-in, parked for one single-use exchange. */
export interface SsoTicketRecord<T = unknown> {
  payload: T;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface SsoStateStore {
  putFlow(state: string, record: SsoFlowRecord): void;
  /** Returns the record and DELETES it. A second call with the same state
   *  returns null — that is what makes state single-use. */
  consumeFlow(state: string, nowMs: number): SsoFlowRecord | null;
  putTicket(ticket: string, record: SsoTicketRecord): void;
  consumeTicket(ticket: string, nowMs: number): SsoTicketRecord | null;
  /** for tests and diagnostics */
  size(): { flows: number; tickets: number };
}

class MemorySsoStateStore implements SsoStateStore {
  private readonly flows = new Map<string, SsoFlowRecord>();
  private readonly tickets = new Map<string, SsoTicketRecord>();

  putFlow(state: string, record: SsoFlowRecord): void {
    this.sweep(record.createdAtMs);
    this.flows.set(sha256Hex(state), record);
  }

  consumeFlow(state: string, nowMs: number): SsoFlowRecord | null {
    this.sweep(nowMs);
    const key = sha256Hex(state);
    const record = this.flows.get(key);
    if (!record) return null;
    // Deleted whether or not it is still live: a state presented after expiry
    // is spent as surely as one presented twice.
    this.flows.delete(key);
    if (record.expiresAtMs <= nowMs) return null;
    return record;
  }

  putTicket(ticket: string, record: SsoTicketRecord): void {
    this.sweep(record.createdAtMs);
    this.tickets.set(sha256Hex(ticket), record);
  }

  consumeTicket(ticket: string, nowMs: number): SsoTicketRecord | null {
    this.sweep(nowMs);
    const key = sha256Hex(ticket);
    const record = this.tickets.get(key);
    if (!record) return null;
    this.tickets.delete(key);
    if (record.expiresAtMs <= nowMs) return null;
    return record;
  }

  size(): { flows: number; tickets: number } {
    return { flows: this.flows.size, tickets: this.tickets.size };
  }

  /** Lazy and idempotent: every access pays a little, nothing pays a timer. */
  private sweep(nowMs: number): void {
    for (const [key, record] of this.flows) {
      if (record.expiresAtMs <= nowMs) this.flows.delete(key);
    }
    for (const [key, record] of this.tickets) {
      if (record.expiresAtMs <= nowMs) this.tickets.delete(key);
    }
  }
}

const stores = new WeakMap<object, SsoStateStore>();

export function getStateStore(db: Db): SsoStateStore {
  let store = stores.get(db as object);
  if (!store) {
    store = new MemorySsoStateStore();
    stores.set(db as object, store);
  }
  return store;
}

/** Replace the store for one database handle (a shared/Redis implementation). */
export function setStateStore(db: Db, store: SsoStateStore): void {
  stores.set(db as object, store);
}

/** 256 bits, URL-safe. Used for state, nonce, tickets and the browser binding. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
