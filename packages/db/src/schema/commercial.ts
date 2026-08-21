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
 * Measurement & valuation engine (spec Vol II Domain B / module M7).
 * The Bill of Quantities is a first-class contractual object (#115): items
 * carry a measurement-standard method, quantities trace to taking-off lines
 * (#139-140 quantity provenance), and interim valuations certify work in
 * place against the BQ.
 */

export const boqs = pgTable(
  "boqs",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    contractId: text("contract_id"),
    name: text("name").notNull(),
    method: text("method").default("nrm2").notNull(), // BoqMethod
    currency: text("currency").default("USD").notNull(),
    status: text("status").default("draft").notNull(), // BoqStatus
    version: integer("version").default(1).notNull(),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("boqs_project_idx").on(t.projectId)],
);

/**
 * BQ hierarchy: bill > section > item (#116). Leaf items carry unit,
 * quantity, rate; `amount` is persisted as quantity × rate at write time.
 * `rateBuildUp` holds the rate build-up sheet components (#145-149):
 * [{ kind: labour|material|plant|overhead|profit, description, qty, unit,
 *    rate, amount }].
 */
export const boqItems = pgTable(
  "boq_items",
  {
    id: text("id").primaryKey(),
    boqId: text("boq_id").notNull(),
    parentId: text("parent_id"),
    /** materialized path of ids for ordered subtree queries */
    path: text("path").notNull(),
    level: text("level").notNull(), // BoqLevel
    code: text("code").notNull(),
    description: text("description").notNull(),
    unit: text("unit"),
    quantity: doublePrecision("quantity"),
    rate: doublePrecision("rate"),
    amount: doublePrecision("amount"),
    itemType: text("item_type").default("measured").notNull(), // BoqItemType
    rateBuildUp: jsonb("rate_build_up").$type<unknown[]>(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("boq_items_boq_idx").on(t.boqId, t.path),
    index("boq_items_parent_idx").on(t.parentId),
  ],
);

/**
 * Taking-off lines: dimension-sheet rows behind a BQ item quantity
 * (#135-140). quantity = timesing × length × width × depth over the non-null
 * dims, unless manually overridden. drawingSheetId records provenance.
 */
export const takeoffLines = pgTable(
  "takeoff_lines",
  {
    id: text("id").primaryKey(),
    boqItemId: text("boq_item_id").notNull(),
    projectId: text("project_id").notNull(),
    drawingSheetId: text("drawing_sheet_id"),
    description: text("description").notNull(),
    timesing: doublePrecision("timesing").default(1).notNull(),
    length: doublePrecision("length"),
    width: doublePrecision("width"),
    depth: doublePrecision("depth"),
    quantity: doublePrecision("quantity").notNull(),
    isManual: integer("is_manual").default(0).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("takeoff_lines_item_idx").on(t.boqItemId)],
);

/** Interim valuations / payment applications (#162-167). */
export const valuations = pgTable(
  "valuations",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    contractId: text("contract_id"),
    boqId: text("boq_id").notNull(),
    number: integer("number").notNull(),
    valuationDate: text("valuation_date").notNull(), // ISO date
    basis: text("basis").default("remeasure").notNull(), // ValuationBasis
    status: text("status").default("draft").notNull(), // ValuationStatus
    retentionPercent: doublePrecision("retention_percent").default(0).notNull(),
    workDoneToDate: doublePrecision("work_done_to_date").default(0).notNull(),
    materialsOnSite: doublePrecision("materials_on_site").default(0).notNull(),
    materialsOffSite: doublePrecision("materials_off_site").default(0).notNull(),
    retentionHeld: doublePrecision("retention_held").default(0).notNull(),
    /** net certified on all previous valuations of this BQ */
    previousNet: doublePrecision("previous_net").default(0).notNull(),
    netDue: doublePrecision("net_due").default(0).notNull(),
    submittedBy: text("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "string" }),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("valuations_uq").on(t.boqId, t.number),
    index("valuations_project_idx").on(t.projectId),
  ],
);

/** Per-item progress on a valuation (remeasured qty or % of BQ item). */
export const valuationLines = pgTable(
  "valuation_lines",
  {
    id: text("id").primaryKey(),
    valuationId: text("valuation_id").notNull(),
    boqItemId: text("boq_item_id").notNull(),
    qtyToDate: doublePrecision("qty_to_date"),
    percentToDate: doublePrecision("percent_to_date"),
    amountToDate: doublePrecision("amount_to_date").default(0).notNull(),
    previousAmount: doublePrecision("previous_amount").default(0).notNull(),
    thisPeriod: doublePrecision("this_period").default(0).notNull(),
  },
  (t) => [
    uniqueIndex("valuation_lines_uq").on(t.valuationId, t.boqItemId),
    index("valuation_lines_valuation_idx").on(t.valuationId),
  ],
);

/**
 * Payment certificates (#179-180): the certifier's determination against the
 * application, with the variance statement persisted.
 */
export const paymentCertificates = pgTable(
  "payment_certificates",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    valuationId: text("valuation_id").notNull(),
    number: integer("number").notNull(),
    certifiedWorkDone: doublePrecision("certified_work_done").default(0).notNull(),
    certifiedMaterials: doublePrecision("certified_materials").default(0).notNull(),
    retentionHeld: doublePrecision("retention_held").default(0).notNull(),
    previousCertified: doublePrecision("previous_certified").default(0).notNull(),
    netCertified: doublePrecision("net_certified").default(0).notNull(),
    varianceFromApplication: doublePrecision("variance_from_application").default(0).notNull(),
    varianceReason: text("variance_reason"),
    dueDate: text("due_date"), // statutory payment deadline, ISO date
    status: text("status").default("issued").notNull(), // CertificateStatus
    issuedBy: text("issued_by").notNull(),
    issuedAt: createdAt(),
  },
  (t) => [
    uniqueIndex("payment_certificates_uq").on(t.projectId, t.number),
    index("payment_certificates_valuation_idx").on(t.valuationId),
  ],
);

/** Variation register with valuation basis (#168-171, Vol I §3.4 subset). */
export const variations = pgTable(
  "variations",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    contractId: text("contract_id"),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").default("proposed").notNull(), // VariationStatus
    basis: text("basis").default("bq_rates").notNull(), // VariationBasis
    clauseRef: text("clause_ref"),
    instructionRef: text("instruction_ref"),
    instructedAt: text("instructed_at"), // ISO date
    costEstimate: doublePrecision("cost_estimate"),
    agreedValue: doublePrecision("agreed_value"),
    timeImpactDays: integer("time_impact_days"),
    /** BQ items referenced when valuing at bq_rates / pro-rata */
    boqItemRefs: jsonb("boq_item_refs").$type<string[]>().default([]).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("variations_uq").on(t.projectId, t.number),
    index("variations_project_idx").on(t.projectId),
  ],
);
