import { desc, eq } from "drizzle-orm";
import { ledgerEntries } from "@constructos/db";
import { appendEntry, hashPayload, verifyChain, type ChainedEntry } from "@constructos/ledger";
import type { LedgerAction } from "@constructos/shared";
import type { Db } from "./db.js";

export interface LedgerWrite {
  companyId: string;
  actorId: string | null;
  action: LedgerAction;
  objectType: string;
  objectId: string;
  /** the state being recorded; hashed canonically, optionally stored */
  payload?: unknown;
  /** store the full payload snapshot alongside the hash (high-value objects) */
  storePayload?: boolean;
  /**
   * Optional project attribution for the emitted event (Vol I §0.7 #121).
   * Purely advisory: the ledger row has no project column, and callers that
   * omit it lose nothing. When absent the emitter falls back to a `projectId`
   * on the payload, and failing that the event is company-scoped.
   */
  projectId?: string | null;
}

/**
 * What a webhook subscriber is told happened. Deliberately identity + hashes,
 * never the ledger payload: `payload` is frequently unstored and can hold
 * commercially sensitive state, so a subscriber receives what changed and the
 * hash that proves it, then fetches detail through the authenticated API.
 */
export interface LedgerEvent {
  seq: number;
  companyId: string;
  projectId: string | null;
  actorId: string | null;
  action: LedgerAction;
  objectType: string;
  objectId: string;
  payloadHash: string;
  entryHash: string;
  at: string;
}

export type LedgerEmitHook = (event: LedgerEvent) => void | Promise<void>;

/**
 * Emit hooks are registered per database handle, not per process: a test file
 * may hold several apps at once and an event must never reach another app's
 * tables. `Db` is one object per app, so a WeakMap keyed on it is both the
 * right scope and self-cleaning.
 */
const emitHooks = new WeakMap<object, LedgerEmitHook>();

/** Register the webhook emitter for one database handle (Vol I §0.7 #121). */
export function setLedgerEmitHook(db: Db, hook: LedgerEmitHook | null): void {
  if (hook) emitHooks.set(db as object, hook);
  else emitHooks.delete(db as object);
}

function eventProjectId(write: LedgerWrite): string | null {
  if (write.projectId !== undefined) return write.projectId;
  const p = write.payload;
  if (p && typeof p === "object" && !Array.isArray(p)) {
    const v = (p as Record<string, unknown>)["projectId"];
    if (typeof v === "string" && v !== "") return v;
  }
  return null;
}

/**
 * Append a state change to the company's hash-chained ledger.
 *
 * The chain invariant: each entry's hash covers its content plus the previous
 * entry's hash. Appends run inside a transaction that reads the current head,
 * so concurrent writers serialize on the head row.
 *
 * Call this AFTER the operational write, inside the same request. A failed
 * ledger append fails the request — an unledgered mutation is worse than a
 * rolled-back one on a platform whose product is the trustworthiness of its
 * record.
 */
export async function appendLedger(db: Db, write: LedgerWrite): Promise<void> {
  const at = new Date().toISOString();
  const payloadHash = hashPayload(write.payload ?? null);
  const emitted = await db.transaction(async (tx): Promise<LedgerEvent> => {
    const head = await tx
      .select({ entryHash: ledgerEntries.entryHash })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.companyId, write.companyId))
      .orderBy(desc(ledgerEntries.seq))
      .limit(1);
    const prev = head[0]?.entryHash ?? null;
    const chained = appendEntry(
      {
        companyId: write.companyId,
        actorId: write.actorId,
        action: write.action,
        objectType: write.objectType,
        objectId: write.objectId,
        payloadHash,
        at,
      },
      prev,
    );
    const inserted = await tx
      .insert(ledgerEntries)
      .values({
        companyId: chained.companyId,
        actorId: chained.actorId,
        action: chained.action,
        objectType: chained.objectType,
        objectId: chained.objectId,
        payloadHash: chained.payloadHash,
        payload: write.storePayload ? (write.payload ?? null) : null,
        prevHash: chained.prevHash,
        entryHash: chained.entryHash,
        at,
      })
      .returning({ seq: ledgerEntries.seq });
    return {
      seq: Number(inserted[0]?.seq ?? 0),
      companyId: chained.companyId,
      projectId: eventProjectId(write),
      actorId: chained.actorId,
      action: write.action,
      objectType: chained.objectType,
      objectId: chained.objectId,
      payloadHash: chained.payloadHash,
      entryHash: chained.entryHash,
      at,
    };
  });

  /*
   * Vol I §0.7 #121 — the webhook emitter hangs off the append path because
   * this is the one place that already sees every consequential mutation, so
   * a subscriber is subscribing to the record rather than to a hand-kept
   * event taxonomy that drifts away from it.
   *
   * Three rules keep appendLedger's contract intact:
   *  1. It runs AFTER the chain transaction has committed. An event is never
   *     emitted for an entry that was rolled back, and the emitter's own
   *     writes can never widen or abort the chain transaction.
   *  2. It cannot fail the caller. Every throw and every rejection is
   *     swallowed here; recording the failure is the emitter's job (it
   *     writes a failed delivery row, and falls back to stderr if even that
   *     is impossible), because a business transaction must not be lost to a
   *     webhook subscriber's bookkeeping.
   *  3. It is awaited rather than fire-and-forget. The enqueue is one indexed
   *     SELECT on webhook_endpoints plus, at most, one INSERT batch — cheap,
   *     and cheapest of all (a single indexed SELECT returning nothing) for
   *     the overwhelming majority of tenants that have no endpoints at all.
   *     Awaiting buys two things worth more than those microseconds: an event
   *     is never lost to a dropped promise when the process exits, and the
   *     emission is deterministic under test. Actual HTTP delivery is NOT on
   *     this path — the dispatcher drains the queue separately.
   */
  const hook = emitHooks.get(db as object);
  if (hook) {
    try {
      await hook(emitted);
    } catch {
      /* deliberately swallowed — see rule 2 above */
    }
  }
}

/** Verify the integrity of a company's full chain. */
export async function verifyCompanyLedger(db: Db, companyId: string) {
  const rows = await db
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.companyId, companyId))
    .orderBy(ledgerEntries.seq);
  const entries: ChainedEntry[] = rows.map((r) => ({
    companyId: r.companyId,
    actorId: r.actorId,
    action: r.action,
    objectType: r.objectType,
    objectId: r.objectId,
    payloadHash: r.payloadHash,
    at: typeof r.at === "string" ? r.at : new Date(r.at as unknown as string).toISOString(),
    prevHash: r.prevHash,
    entryHash: r.entryHash,
  }));
  return { count: entries.length, ...verifyChain(entries) };
}
