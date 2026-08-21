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
  await db.transaction(async (tx) => {
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
    await tx.insert(ledgerEntries).values({
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
    });
  });
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
