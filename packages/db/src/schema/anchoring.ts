import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull();

/**
 * M1 — Ledger anchoring & escrow (spec Vol II Domain S #860-861, #864, #873-874).
 *
 * The hash chain in `ledger_entries` is tamper-EVIDENT against edits: change an
 * entry and every subsequent hash stops matching. It is not tamper-evident
 * against two attacks available to whoever controls the database: truncating
 * the tail (delete the last N entries and the remainder still verifies) and
 * rewriting the chain wholesale from genesis. Both are closed the same way —
 * by periodically SEALING the head with a signature whose private key never
 * enters the database, chaining the seals to each other, and handing the seal
 * to someone else (escrow).
 *
 * See docs/adr/0017-ledger-anchoring-and-escrow.md.
 */
export const signingKeys = pgTable(
  "signing_keys",
  {
    id: text("id").primaryKey(),
    /** null = platform-wide key; otherwise the tenant this key seals for */
    companyId: text("company_id"),
    /** stable public identifier carried in every seal and receipt */
    keyId: text("key_id").notNull(),
    algorithm: text("algorithm").default("ed25519").notNull(),
    /**
     * PUBLIC half only. The private half lives in ANCHOR_SIGNING_KEY (env) and
     * is never written here — that is the entire security property. A row in
     * this table lets anyone verify a seal; it never lets anyone make one.
     */
    publicKeyPem: text("public_key_pem").notNull(),
    /** sha256 of the DER public key, for out-of-band comparison */
    fingerprint: text("fingerprint").notNull(),
    activeFrom: timestamp("active_from", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    retiredAt: timestamp("retired_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("signing_keys_key_id_idx").on(t.keyId),
    index("signing_keys_company_idx").on(t.companyId),
  ],
);

/**
 * A signed commitment to the state of one company's chain at a point in time.
 * Seals are themselves chained (prevSealHash) so a seal cannot be removed
 * without breaking the seal chain, and they record entryCount so a shorter
 * chain than the last seal is provable truncation rather than a judgement call.
 */
export const chainSeals = pgTable(
  "chain_seals",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** monotonic per company, starting at 1 */
    sequence: integer("sequence").notNull(),
    /** ledger sequence range this seal commits to (inclusive) */
    fromEntrySeq: integer("from_entry_seq").notNull(),
    toEntrySeq: integer("to_entry_seq").notNull(),
    /** total entries in the chain at seal time — the truncation tripwire */
    entryCount: integer("entry_count").notNull(),
    /** hash of the last entry at seal time */
    headHash: text("head_hash").notNull(),
    /** merkle root over every entry hash in the chain at seal time */
    merkleRoot: text("merkle_root").notNull(),
    /** hash of the previous seal's canonical body — seals form their own chain */
    prevSealHash: text("prev_seal_hash"),
    /** sha256 of the canonical seal body that was signed */
    bodyHash: text("body_hash").notNull(),
    signature: text("signature").notNull(),
    keyId: text("key_id").notNull(),
    algorithm: text("algorithm").default("ed25519").notNull(),
    /**
     * Self-asserted application-server time. Honest naming: without an
     * external timestamp authority this proves ordering, not wall-clock time.
     */
    sealedAt: timestamp("sealed_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    /** heartbeat seals are written on schedule even with no new entries */
    isHeartbeat: integer("is_heartbeat").default(0).notNull(),
    sealedBy: text("sealed_by"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("chain_seals_company_sequence_idx").on(t.companyId, t.sequence),
    index("chain_seals_company_idx").on(t.companyId),
  ],
);

/** An attempt to witness a seal outside this deployment entirely. */
export const anchorSubmissions = pgTable(
  "anchor_submissions",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    sealId: text("seal_id").notNull(),
    provider: text("provider").notNull(), // AnchorProvider
    status: text("status").default("pending").notNull(), // AnchorStatus
    /** provider-side identifier (TSA serial, txid, counterparty ack ref) */
    externalRef: text("external_ref"),
    /** whatever the provider returns that a third party can re-verify */
    proof: jsonb("proof").$type<Record<string, unknown>>().default({}).notNull(),
    /** why an unavailable provider is unavailable — shown to the operator verbatim */
    detail: text("detail"),
    requestedAt: createdAt(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    index("anchor_submissions_seal_idx").on(t.sealId),
    index("anchor_submissions_company_idx").on(t.companyId),
  ],
);

/**
 * A seal handed to a named counterparty (auditor, lender, regulator). The
 * receipt is self-contained: public key, seal body, signature and the
 * verification procedure. Escrow is what converts "we verified our own chain"
 * into "a third party can verify it" — the receipt holder can later prove the
 * chain they were shown is the chain that exists.
 */
export const escrowReceipts = pgTable(
  "escrow_receipts",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    sealId: text("seal_id").notNull(),
    /** who holds this receipt — free text plus optional platform user */
    recipientName: text("recipient_name").notNull(),
    recipientRef: text("recipient_ref"),
    recipientUserId: text("recipient_user_id"),
    /** sha256 of the canonical receipt document */
    receiptHash: text("receipt_hash").notNull(),
    /** the receipt document itself, exactly as handed over */
    document: jsonb("document").$type<Record<string, unknown>>().default({}).notNull(),
    purpose: text("purpose"),
    issuedBy: text("issued_by").notNull(),
    issuedAt: createdAt(),
    /** last time this receipt was presented back for verification */
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true, mode: "string" }),
    lastVerdict: text("last_verdict"), // ChainVerdict
  },
  (t) => [
    index("escrow_receipts_company_idx").on(t.companyId),
    index("escrow_receipts_seal_idx").on(t.sealId),
  ],
);

/**
 * Per-company verification watermark (platform upgrade wave).
 *
 * WHY. Verifying a chain by loading every entry is O(chain) on a hot read
 * path, and the chain grows with every mutation across 66 modules. The
 * watermark makes verification incremental: the link from entry N to entry
 * N+1 was checked once and cannot un-check itself unless the row changes, so
 * a later verify only has to walk `seq > lastVerifiedSeq` starting from
 * `lastVerifiedHash` — and a mismatch at the boundary is itself a finding
 * (someone edited a range that was already verified).
 *
 * `deepVerifiedSeq` tracks the separate, more expensive pass that re-hashes
 * stored payload SNAPSHOTS: the chain covers `payloadHash`, never the
 * snapshot, so an insider who rewrites what an entry SAYS while leaving the
 * hashes alone is only caught by reading the payloads. That pass runs in
 * bounded batches from the scheduler, never on a request.
 */
export const chainWatermarks = pgTable(
  "chain_watermarks",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** highest ledger seq whose link and content hash have been verified */
    lastVerifiedSeq: integer("last_verified_seq").default(0).notNull(),
    /** entryHash at that seq — the anchor the next incremental pass starts from */
    lastVerifiedHash: text("last_verified_hash"),
    /** entries verified so far (the running count, not a re-count) */
    verifiedCount: integer("verified_count").default(0).notNull(),
    /** highest seq whose stored payload snapshot was re-hashed */
    deepVerifiedSeq: integer("deep_verified_seq").default(0).notNull(),
    /** last verdict this watermark was left in: ok | broken */
    lastVerdict: text("last_verdict").default("ok").notNull(),
    /** when broken: where, and why, in words */
    brokenAtSeq: integer("broken_at_seq"),
    brokenReason: text("broken_reason"),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("chain_watermarks_company_uq").on(t.companyId)],
);
