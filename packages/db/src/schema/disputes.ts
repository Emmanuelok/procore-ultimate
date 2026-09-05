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
    /**
     * Statutory / contractual regime whose timetable was generated
     * (DisputeJurisdiction, #322-333), and the trigger date the offsets run
     * from — usually the date of the notice of adjudication.
     */
    jurisdiction: text("jurisdiction"),
    triggerDate: text("trigger_date"), // ISO date
    outcome: text("outcome"),
    /* ---- structured outcome database (#356-357) ---- */
    amountClaimed: doublePrecision("amount_claimed"),
    amountAwarded: doublePrecision("amount_awarded"),
    costsAwarded: doublePrecision("costs_awarded"),
    rootCause: text("root_cause"), // DisputeRootCause
    governingClause: text("governing_clause"),
    contractFamily: text("contract_family"), // FIDIC / NEC / JCT / bespoke
    resolvedAt: text("resolved_at"), // ISO date the matter ended
    /* ---- post-decision enforcement (#333) ---- */
    enforcementStatus: text("enforcement_status").default("not_applicable").notNull(),
    complianceDeadline: text("compliance_deadline"), // ISO date
    nodDeadline: text("nod_deadline"), // notice of dissatisfaction window
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

/* ================================================================== */
/* Platform upgrade wave — dispute depth (#322-333, #340-343, #351-357)  */
/* ================================================================== */

/**
 * Frozen content snapshot per bundle item (#343). Without this, `verify`
 * cannot tell tampering from an ordinary lifecycle change on the source
 * record, and a produced bundle cannot be re-rendered exactly as served.
 */
export const bundleSnapshots = pgTable(
  "bundle_snapshots",
  {
    id: text("id").primaryKey(),
    bundleId: text("bundle_id").notNull(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    itemId: text("item_id").notNull(),
    tab: text("tab").notNull(),
    kind: text("kind").notNull(), // record | file
    sha256: text("sha256").notNull(),
    /** canonical JSON of the record at generation; null for file-backed items */
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>(),
    /** page span within the produced bundle, when paginated */
    startPage: integer("start_page"),
    endPage: integer("end_page"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("bundle_snapshots_uq").on(t.bundleId, t.itemId),
    index("bundle_snapshots_bundle_idx").on(t.bundleId),
  ],
);

/**
 * Standing dispute board members (#331): FIDIC DAAB / NEC dispute avoidance
 * board. Independence disclosures are the whole point of the record.
 */
export const disputeBoardMembers = pgTable(
  "dispute_board_members",
  {
    id: text("id").primaryKey(),
    disputeId: text("dispute_id").notNull(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    boardRole: text("board_role").default("member").notNull(), // DisputeBoardRole
    nominatedBy: text("nominated_by"), // employer | contractor | agreed | institution
    appointedAt: text("appointed_at"), // ISO date
    independenceDisclosure: text("independence_disclosure"),
    /** 1 when a conflict was declared — a board with an undeclared conflict is challengeable */
    conflictDeclared: integer("conflict_declared").default(0).notNull(),
    feeBasis: text("fee_basis"),
    recordedBy: text("recorded_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("dispute_board_members_dispute_idx").on(t.disputeId)],
);

/** Standing board site visits and their reports (#331-332). */
export const disputeBoardVisits = pgTable(
  "dispute_board_visits",
  {
    id: text("id").primaryKey(),
    disputeId: text("dispute_id").notNull(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    visitDate: text("visit_date").notNull(), // ISO date
    attendees: jsonb("attendees").$type<string[]>().default([]).notNull(),
    summary: text("summary"),
    recommendations: text("recommendations"),
    reportFileId: text("report_file_id"),
    recordedBy: text("recorded_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("dispute_board_visits_dispute_idx").on(t.disputeId)],
);

/**
 * Cost of recovery (#354). A claim worth 200k pursued for 260k of fees is
 * a loss; nothing else on the platform can say so without these rows.
 */
export const disputeCosts = pgTable(
  "dispute_costs",
  {
    id: text("id").primaryKey(),
    disputeId: text("dispute_id").notNull(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    category: text("category").notNull(), // DisputeCostCategory
    supplier: text("supplier"),
    description: text("description").notNull(),
    incurredAt: text("incurred_at").notNull(), // ISO date
    budgetAmount: doublePrecision("budget_amount"),
    actualAmount: doublePrecision("actual_amount").notNull(),
    currency: text("currency").default("GBP").notNull(),
    /** 1 when the cost is recoverable from the other side if successful */
    recoverable: integer("recoverable").default(0).notNull(),
    recordedBy: text("recorded_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("dispute_costs_dispute_idx").on(t.disputeId),
    index("dispute_costs_project_idx").on(t.projectId),
  ],
);

/**
 * Persisted decision-tree settlement model (#351-353): outcome branches with
 * probabilities and awards, per-stage irrecoverable costs, discounting, and
 * Part 36 / Calderbank costs consequences.
 */
export const settlementModels = pgTable(
  "settlement_models",
  {
    id: text("id").primaryKey(),
    disputeId: text("dispute_id").notNull(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    currency: text("currency").default("GBP").notNull(),
    /** [{ id, kind, label, probability, award, note }] — probabilities sum to 1 */
    branches: jsonb("branches").$type<unknown[]>().default([]).notNull(),
    /** [{ id, name, ownCosts, opponentCosts, incurredByDate? }] */
    stages: jsonb("stages").$type<unknown[]>().default([]).notNull(),
    discountRatePercent: doublePrecision("discount_rate_percent").default(0).notNull(),
    yearsToResolution: doublePrecision("years_to_resolution").default(0).notNull(),
    /** Part 36 style: { enabled, indemnityCostsPercent, enhancedInterestPercent } */
    costsRules: jsonb("costs_rules").$type<Record<string, unknown>>(),
    /** engine output, recomputed on every write */
    computed: jsonb("computed").$type<Record<string, unknown>>(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("settlement_models_dispute_idx").on(t.disputeId)],
);
