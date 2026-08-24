import {
  doublePrecision,
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
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull();

/**
 * Dispute avoidance & resolution (spec Vol II Domain E / module M15).
 * Timetable deadlines materialize as assurance Obligations; bundles are
 * evidence-pack style: an ordered manifest whose file hashes roll up to a
 * merkle root, so a produced bundle is tamper-evident.
 */
export const disputes = pgTable(
  "disputes",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    kind: text("kind").notNull(), // DisputeKind
    forum: text("forum"), // e.g. "TCC", "ICC", "RICS adjudicator nomination"
    rules: text("rules"), // institutional rules reference (#337)
    contractId: text("contract_id"),
    /** claims referred into the dispute */
    claimIds: jsonb("claim_ids").$type<string[]>().default([]).notNull(),
    counterpartyEntityId: text("counterparty_entity_id"),
    amountInDispute: doublePrecision("amount_in_dispute"),
    currency: text("currency").default("GBP").notNull(),
    status: text("status").default("notified").notNull(), // DisputeStatus
    /** procedural timetable (#338): [{ id, name, dueDate, obligationId?, done }] */
    timetable: jsonb("timetable").$type<unknown[]>().default([]).notNull(),
    outcome: text("outcome"),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "string" }),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("disputes_uq").on(t.projectId, t.number),
    index("disputes_project_idx").on(t.projectId),
  ],
);

/** Pleadings / submissions register (#339). */
export const disputeSubmissions = pgTable(
  "dispute_submissions",
  {
    id: text("id").primaryKey(),
    disputeId: text("dispute_id").notNull(),
    companyId: text("company_id").notNull(),
    kind: text("kind").notNull(), // SubmissionKind
    title: text("title").notNull(),
    party: text("party").notNull(), // claimant | respondent | tribunal
    servedAt: text("served_at").notNull(), // ISO date
    fileId: text("file_id"),
    note: text("note"),
    recordedBy: text("recorded_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("dispute_submissions_dispute_idx").on(t.disputeId)],
);

/**
 * Hearing bundles (#343-344): ordered items drawn from any platform record
 * or file; generation freezes a manifest with sequential tab numbering and
 * a merkle root over the content hashes.
 */
export const disputeBundles = pgTable(
  "dispute_bundles",
  {
    id: text("id").primaryKey(),
    disputeId: text("dispute_id").notNull(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    status: text("status").default("draft").notNull(), // BundleStatus
    /** ordered items: [{ id, tab?, title, date?, recordType?, recordId?, fileId?, sha256? }] */
    items: jsonb("items").$type<unknown[]>().default([]).notNull(),
    /** frozen at generation: { generatedAt, itemCount, merkleRoot, index: [...] } */
    manifest: jsonb("manifest").$type<Record<string, unknown>>(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("dispute_bundles_dispute_idx").on(t.disputeId)],
);

/** Settlement offer register (#350-352). */
export const settlementOffers = pgTable(
  "settlement_offers",
  {
    id: text("id").primaryKey(),
    disputeId: text("dispute_id").notNull(),
    companyId: text("company_id").notNull(),
    direction: text("direction").notNull(), // made | received
    basis: text("basis").notNull(), // SettlementOfferBasis
    amount: doublePrecision("amount").notNull(),
    currency: text("currency").default("GBP").notNull(),
    terms: text("terms"),
    offeredAt: text("offered_at").notNull(),
    expiresAt: text("expires_at"),
    status: text("status").default("open").notNull(), // open | accepted | rejected | lapsed | withdrawn
    recordedBy: text("recorded_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("settlement_offers_dispute_idx").on(t.disputeId)],
);
