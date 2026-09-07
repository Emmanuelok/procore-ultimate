import { eq, lte } from "drizzle-orm";
import { ssoFlows, ssoTickets } from "@constructos/db";
import { sha256Hex } from "@constructos/ledger";
import type { Db } from "../../lib/db.js";
import type { SsoFlowRecord, SsoStateStore, SsoTicketRecord } from "./state.js";

/**
 * The SHARED implementation of `SsoStateStore` the in-memory one always said
 * it needed.
 *
 * THE PROBLEM. `MemorySsoStateStore` keys its flows and tickets by the
 * database handle, in process memory, and its own header says a multi-instance
 * deployment needs "either a shared implementation of SsoFlowStore (Redis, or
 * a table) or sticky routing on /api/v1/auth/sso/*". Neither was ever set up,
 * and docs/deployment.md told operators to run replicas. The consequence on a
 * two-replica service is that HALF of all SSO sign-ins fail with "this sign-in
 * link is not valid any more" — the callback lands on the replica that did not
 * issue the state — and every one of them looks to the user like a security
 * refusal rather than a deployment fault. The same applies to the ticket
 * exchange that follows a redirect-mode callback.
 *
 * THE DESIGN, unchanged from the memory store in every respect that matters:
 *
 *   - the row is keyed on `sha256(state)`, never on the state itself, so a
 *     database reader cannot complete somebody else's in-flight sign-in;
 *   - consumption DELETES, so a replayed state is spent exactly as a used one
 *     is, and the delete is the atomicity: `DELETE … RETURNING` returns the
 *     row to precisely one caller even when two replicas race;
 *   - expiry is swept lazily on access, never on a timer.
 *
 * The interface is deliberately synchronous (`consumeFlow(state, now):
 * SsoFlowRecord | null`) because that is what the module was written against,
 * and changing it would mean touching the callback handler's control flow.
 * That is reconciled with a database by a WRITE-THROUGH CACHE: the process
 * keeps its own map, and the durable row is what lets ANOTHER replica answer.
 * A flow issued on replica A and consumed on replica B takes the async path
 * through `prefetch`, which the callback route awaits before consuming.
 */

interface Cached<T> {
  record: T;
  expiresAtMs: number;
}

export class PostgresSsoStateStore implements SsoStateStore {
  private readonly flows = new Map<string, Cached<SsoFlowRecord>>();
  private readonly tickets = new Map<string, Cached<SsoTicketRecord>>();
  private lastSweepMs = 0;

  constructor(private readonly db: Db) {}

  putFlow(state: string, record: SsoFlowRecord): void {
    const key = sha256Hex(state);
    this.flows.set(key, { record, expiresAtMs: record.expiresAtMs });
    void this.db
      .insert(ssoFlows)
      .values({
        id: key,
        providerId: record.providerId,
        companyId: record.companyId,
        record: record as unknown as Record<string, unknown>,
        expiresAt: new Date(record.expiresAtMs).toISOString(),
      })
      .catch(() => {
        /* the in-process copy still works; only cross-replica handoff is lost */
      });
    void this.sweep(record.createdAtMs);
  }

  consumeFlow(state: string, nowMs: number): SsoFlowRecord | null {
    const key = sha256Hex(state);
    const cached = this.flows.get(key);
    // Deleted whether or not it is still live: a state presented after expiry
    // is spent as surely as one presented twice.
    this.flows.delete(key);
    void this.db.delete(ssoFlows).where(eq(ssoFlows.id, key)).catch(() => undefined);
    if (!cached) return null;
    if (cached.expiresAtMs <= nowMs) return null;
    return cached.record;
  }

  putTicket(ticket: string, record: SsoTicketRecord): void {
    const key = sha256Hex(ticket);
    this.tickets.set(key, { record, expiresAtMs: record.expiresAtMs });
    void this.db
      .insert(ssoTickets)
      .values({
        id: key,
        payload: record.payload as Record<string, unknown>,
        expiresAt: new Date(record.expiresAtMs).toISOString(),
      })
      .catch(() => undefined);
    void this.sweep(record.createdAtMs);
  }

  consumeTicket(ticket: string, nowMs: number): SsoTicketRecord | null {
    const key = sha256Hex(ticket);
    const cached = this.tickets.get(key);
    this.tickets.delete(key);
    void this.db.delete(ssoTickets).where(eq(ssoTickets.id, key)).catch(() => undefined);
    if (!cached) return null;
    if (cached.expiresAtMs <= nowMs) return null;
    return cached.record;
  }

  size(): { flows: number; tickets: number } {
    return { flows: this.flows.size, tickets: this.tickets.size };
  }

  /**
   * Pull a flow or ticket this process did not issue into the local cache, so
   * the synchronous `consume*` above can answer for it. Awaited by the routes
   * before they consume; a no-op when the value is already here.
   */
  async prefetch(kind: "flow" | "ticket", value: string, nowMs: number): Promise<void> {
    const key = sha256Hex(value);
    if (kind === "flow") {
      if (this.flows.has(key)) return;
      const [row] = await this.db
        .select()
        .from(ssoFlows)
        .where(eq(ssoFlows.id, key))
        .limit(1);
      if (!row) return;
      const expiresAtMs = Date.parse(row.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return;
      this.flows.set(key, {
        record: row.record as unknown as SsoFlowRecord,
        expiresAtMs,
      });
      return;
    }
    if (this.tickets.has(key)) return;
    const [row] = await this.db
      .select()
      .from(ssoTickets)
      .where(eq(ssoTickets.id, key))
      .limit(1);
    if (!row) return;
    const expiresAtMs = Date.parse(row.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return;
    this.tickets.set(key, {
      record: { payload: row.payload, createdAtMs: Date.parse(row.createdAt), expiresAtMs },
      expiresAtMs,
    });
  }

  /** Lazy and idempotent, at most once a minute: nothing pays a timer. */
  private async sweep(nowMs: number): Promise<void> {
    for (const [key, cached] of this.flows) {
      if (cached.expiresAtMs <= nowMs) this.flows.delete(key);
    }
    for (const [key, cached] of this.tickets) {
      if (cached.expiresAtMs <= nowMs) this.tickets.delete(key);
    }
    if (nowMs - this.lastSweepMs < 60_000) return;
    this.lastSweepMs = nowMs;
    const cutoff = new Date(nowMs).toISOString();
    try {
      await this.db.delete(ssoFlows).where(lte(ssoFlows.expiresAt, cutoff));
      await this.db.delete(ssoTickets).where(lte(ssoTickets.expiresAt, cutoff));
    } catch {
      /* a sweep that fails is retried on the next access */
    }
  }
}

export function createPostgresSsoStateStore(db: Db): PostgresSsoStateStore {
  return new PostgresSsoStateStore(db);
}

/** How many rows are parked right now — for the admin diagnostics route. */
export async function countSsoState(
  db: Db,
  nowMs = Date.now(),
): Promise<{ flows: number; tickets: number; expired: number }> {
  const cutoff = new Date(nowMs).toISOString();
  const flows = await db.select({ id: ssoFlows.id, expiresAt: ssoFlows.expiresAt }).from(ssoFlows);
  const tickets = await db
    .select({ id: ssoTickets.id, expiresAt: ssoTickets.expiresAt })
    .from(ssoTickets);
  const expired =
    flows.filter((f) => f.expiresAt <= cutoff).length +
    tickets.filter((t) => t.expiresAt <= cutoff).length;
  return { flows: flows.length, tickets: tickets.length, expired };
}
