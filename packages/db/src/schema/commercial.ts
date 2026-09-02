import {
  boolean,
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
  (t) => [
    index("boqs_project_idx").on(t.projectId),
    index("boqs_company_status_idx").on(t.companyId, t.status),
    index("boqs_contract_idx").on(t.contractId),
  ],
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
    index("boq_items_code_idx").on(t.boqId, t.code),
  ],
);

/**
 * Taking-off lines: dimension-sheet rows behind a BQ item quantity
 * (#135-140). quantity = timesing × length × width × depth over the non-null
 * dims, unless manually overridden. drawingSheetId records provenance.
 * `deduct` models the deduction convention of dimension paper: the line is
 * measured positive and subtracted, so a negative quantity never has to be
 * typed (and is refused).
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
    deduct: boolean("deduct").default(false).notNull(),
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
    currency: text("currency").default("USD").notNull(),
    retentionPercent: doublePrecision("retention_percent").default(0).notNull(),
    /** cumulative cap on retention held, copied from the contract at creation */
    retentionCap: doublePrecision("retention_cap"),
    workDoneToDate: doublePrecision("work_done_to_date").default(0).notNull(),
    materialsOnSite: doublePrecision("materials_on_site").default(0).notNull(),
    materialsOffSite: doublePrecision("materials_off_site").default(0).notNull(),
    /** Σ of typed valuation sections (variations, dayworks, claims, contras…) */
    sectionsTotal: doublePrecision("sections_total").default(0).notNull(),
    /** Σ of retention-exempt sections (contra charges are never retained on) */
    grossTotal: doublePrecision("gross_total").default(0).notNull(),
    retentionHeld: doublePrecision("retention_held").default(0).notNull(),
    retentionReleased: doublePrecision("retention_released").default(0).notNull(),
    /** net certified on all previous valuations of this BQ */
    previousNet: doublePrecision("previous_net").default(0).notNull(),
    netDue: doublePrecision("net_due").default(0).notNull(),
    /** statutory due date for payment, computed from the contract clause */
    dueDate: text("due_date"),
    dueDateBasis: text("due_date_basis"),
    submittedBy: text("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "string" }),
    paidAt: timestamp("paid_at", { withTimezone: true, mode: "string" }),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("valuations_uq").on(t.boqId, t.number),
    index("valuations_project_idx").on(t.projectId),
    index("valuations_company_status_idx").on(t.companyId, t.status),
    index("valuations_boq_status_idx").on(t.boqId, t.status),
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
    index("valuation_lines_item_idx").on(t.boqItemId),
  ],
);

/**
 * Typed valuation sections — everything in an application that is NOT a BQ
 * line (#166-167, #132): agreed variations pulled from the register, daywork
 * sheets, claims / loss-and-expense, fluctuations, materials on and off site
 * with their vesting evidence, and contra charges (negative, never retained
 * on). Each row names the record it came from, so the gross is auditable.
 */
export const valuationSections = pgTable(
  "valuation_sections",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    valuationId: text("valuation_id").notNull(),
    kind: text("kind").notNull(), // ValuationSectionKind
    description: text("description").notNull(),
    /** source record: variation | daywork_sheet | claim | fluctuation_calculation | … */
    sourceType: text("source_type"),
    sourceId: text("source_id"),
    amountToDate: doublePrecision("amount_to_date").default(0).notNull(),
    previousAmount: doublePrecision("previous_amount").default(0).notNull(),
    thisPeriod: doublePrecision("this_period").default(0).notNull(),
    /** contra charges and some claims are excluded from the retention base */
    retentionApplies: boolean("retention_applies").default(true).notNull(),
    /** vesting certificate / off-site bond evidence for materials (#166-167) */
    evidenceRef: text("evidence_ref"),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("valuation_sections_valuation_idx").on(t.valuationId),
    index("valuation_sections_project_idx").on(t.projectId, t.kind),
  ],
);

/**
 * Payment certificates (#179-180): the certifier's determination against the
 * application, with the variance statement persisted. `dueDate` is derived
 * from the contract's payment clause so late-payment interest and suspension
 * rights are computable rather than guessed.
 */
export const paymentCertificates = pgTable(
  "payment_certificates",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    valuationId: text("valuation_id").notNull(),
    number: integer("number").notNull(),
    currency: text("currency").default("USD").notNull(),
    certifiedWorkDone: doublePrecision("certified_work_done").default(0).notNull(),
    certifiedMaterials: doublePrecision("certified_materials").default(0).notNull(),
    certifiedSections: doublePrecision("certified_sections").default(0).notNull(),
    retentionHeld: doublePrecision("retention_held").default(0).notNull(),
    retentionReleased: doublePrecision("retention_released").default(0).notNull(),
    previousCertified: doublePrecision("previous_certified").default(0).notNull(),
    netCertified: doublePrecision("net_certified").default(0).notNull(),
    varianceFromApplication: doublePrecision("variance_from_application").default(0).notNull(),
    varianceReason: text("variance_reason"),
    dueDate: text("due_date"), // statutory payment deadline, ISO date
    /** how dueDate was derived, e.g. "FIDIC 14.7(b): 56 days from Statement" */
    dueDateBasis: text("due_date_basis"),
    status: text("status").default("issued").notNull(), // CertificateStatus
    withdrawnReason: text("withdrawn_reason"),
    withdrawnBy: text("withdrawn_by"),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true, mode: "string" }),
    /** the certificate that replaced a withdrawn one */
    supersededById: text("superseded_by_id"),
    paidAmount: doublePrecision("paid_amount"),
    paidAt: timestamp("paid_at", { withTimezone: true, mode: "string" }),
    paymentReference: text("payment_reference"),
    issuedBy: text("issued_by").notNull(),
    issuedAt: createdAt(),
  },
  (t) => [
    uniqueIndex("payment_certificates_uq").on(t.projectId, t.number),
    index("payment_certificates_valuation_idx").on(t.valuationId),
    index("payment_certificates_due_idx").on(t.status, t.dueDate),
    index("payment_certificates_company_idx").on(t.companyId, t.projectId),
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
    currency: text("currency").default("USD").notNull(),
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
    index("variations_status_idx").on(t.companyId, t.projectId, t.status),
  ],
);

/**
 * Persisted variation build-up (#171). The ledger already stores the derivation
 * for audit; this table makes it queryable — star rates can be listed, reused
 * and benchmarked instead of being archaeology in a hash chain.
 */
export const variationBuildUpLines = pgTable(
  "variation_build_up_lines",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    variationId: text("variation_id").notNull(),
    sequence: integer("sequence").default(0).notNull(),
    boqItemId: text("boq_item_id"),
    description: text("description").notNull(),
    unit: text("unit"),
    qty: doublePrecision("qty").notNull(),
    rate: doublePrecision("rate").notNull(),
    amount: doublePrecision("amount").notNull(),
    /** bq_rates | pro_rata | star_rate | daywork — per line, not per variation */
    basis: text("basis").notNull(),
    /** for pro_rata: the factor applied to the parent BQ rate */
    factor: doublePrecision("factor"),
    createdAt: createdAt(),
  },
  (t) => [index("variation_build_up_variation_idx").on(t.variationId)],
);

/* ------------------------------------------------------------------ */
/* Dayworks (#150-161)                                                 */
/* ------------------------------------------------------------------ */

/**
 * A daywork sheet is a site record signed by two parties: the contractor
 * records resources, the administrator verifies them. Percentage additions
 * come from the contract's daywork schedule (#132), so labour/plant/material
 * carry their own uplift.
 */
export const dayworkSheets = pgTable(
  "daywork_sheets",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    contractId: text("contract_id"),
    variationId: text("variation_id"),
    number: integer("number").notNull(),
    reference: text("reference"),
    workDate: text("work_date").notNull(), // ISO date
    description: text("description").notNull(),
    location: text("location"),
    instructionRef: text("instruction_ref"),
    basis: text("basis").default("schedule_rates").notNull(), // DayworkBasis
    status: text("status").default("draft").notNull(), // DayworkStatus
    currency: text("currency").default("USD").notNull(),
    /** { labour: 80, material: 15, plant: 10 } — percent uplift per class */
    percentAdditions: jsonb("percent_additions")
      .$type<Record<string, number>>()
      .default({})
      .notNull(),
    netTotal: doublePrecision("net_total").default(0).notNull(),
    additionTotal: doublePrecision("addition_total").default(0).notNull(),
    grossTotal: doublePrecision("gross_total").default(0).notNull(),
    submittedBy: text("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "string" }),
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" }),
    rejectionReason: text("rejection_reason"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("daywork_sheets_uq").on(t.projectId, t.number),
    index("daywork_sheets_project_idx").on(t.projectId, t.status),
    index("daywork_sheets_variation_idx").on(t.variationId),
  ],
);

export const dayworkItems = pgTable(
  "daywork_items",
  {
    id: text("id").primaryKey(),
    sheetId: text("sheet_id").notNull(),
    kind: text("kind").notNull(), // DayworkResourceKind
    description: text("description").notNull(),
    unit: text("unit"),
    qty: doublePrecision("qty").notNull(),
    rate: doublePrecision("rate").notNull(),
    amount: doublePrecision("amount").notNull(),
    /** the uplift actually applied to this line, resolved from the sheet */
    percentAddition: doublePrecision("percent_addition").default(0).notNull(),
    amountWithAddition: doublePrecision("amount_with_addition").default(0).notNull(),
    /** worker/plant record this line claims, for reconciliation with timecards */
    resourceRef: text("resource_ref"),
    sequence: integer("sequence").default(0).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("daywork_items_sheet_idx").on(t.sheetId)],
);

/* ------------------------------------------------------------------ */
/* Remeasurement (#141-144)                                            */
/* ------------------------------------------------------------------ */

/**
 * A remeasurement is a proposed change to a BQ item quantity with the
 * measurement record behind it. Agreement is a different actor from the
 * proposer (the assurance rule: an assertion and its test are not authored by
 * the same person through the same pathway); only an agreed record may be
 * applied to the BQ.
 */
export const remeasurements = pgTable(
  "remeasurements",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    boqId: text("boq_id").notNull(),
    boqItemId: text("boq_item_id").notNull(),
    originalQuantity: doublePrecision("original_quantity"),
    remeasuredQuantity: doublePrecision("remeasured_quantity").notNull(),
    method: text("method").notNull(), // RemeasurementMethod
    status: text("status").default("proposed").notNull(), // RemeasurementStatus
    measuredAt: text("measured_at").notNull(), // ISO date
    measuredBy: text("measured_by").notNull(),
    witnessedBy: text("witnessed_by"),
    agreedBy: text("agreed_by"),
    agreedAt: timestamp("agreed_at", { withTimezone: true, mode: "string" }),
    appliedAt: timestamp("applied_at", { withTimezone: true, mode: "string" }),
    disputeReason: text("dispute_reason"),
    note: text("note"),
    /** drawing sheet / survey record the measure came off */
    evidenceRef: text("evidence_ref"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("remeasurements_item_idx").on(t.boqItemId),
    index("remeasurements_project_idx").on(t.projectId, t.status),
  ],
);

/* ------------------------------------------------------------------ */
/* Provisional sums & prime cost (#125-127)                            */
/* ------------------------------------------------------------------ */

export const provisionalSums = pgTable(
  "provisional_sums",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    boqId: text("boq_id").notNull(),
    boqItemId: text("boq_item_id").notNull(),
    kind: text("kind").notNull(), // ProvisionalSumKind
    title: text("title").notNull(),
    allowance: doublePrecision("allowance").default(0).notNull(),
    currency: text("currency").default("USD").notNull(),
    status: text("status").default("open").notNull(), // ProvisionalSumStatus
    instructionRef: text("instruction_ref"),
    instructedAt: text("instructed_at"),
    expendedTotal: doublePrecision("expended_total").default(0).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("provisional_sums_item_uq").on(t.boqItemId),
    index("provisional_sums_project_idx").on(t.projectId, t.status),
  ],
);

export const provisionalSumExpenditures = pgTable(
  "provisional_sum_expenditures",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    provisionalSumId: text("provisional_sum_id").notNull(),
    description: text("description").notNull(),
    amount: doublePrecision("amount").notNull(),
    spentOn: text("spent_on").notNull(), // ISO date
    /** variation | commitment | invoice | daywork_sheet | manual */
    sourceType: text("source_type"),
    sourceId: text("source_id"),
    approvedBy: text("approved_by"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("ps_expenditures_ps_idx").on(t.provisionalSumId)],
);

/* ------------------------------------------------------------------ */
/* Fluctuations / price adjustment (#178)                              */
/* ------------------------------------------------------------------ */

/** A published index series (CPI, steel, fuel, labour) with dated values. */
export const fluctuationSeries = pgTable(
  "fluctuation_series",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    source: text("source"),
    country: text("country"),
    /** [{ period: "2025-01", value: 118.4 }] — ordered ascending by period */
    values: jsonb("values")
      .$type<Array<{ period: string; value: number }>>()
      .default([])
      .notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("fluctuation_series_uq").on(t.companyId, t.code)],
);

/**
 * One price-adjustment computation, kept whole: the formula, the weightings,
 * every index value used with its period, and the resulting adjustment. A
 * fluctuation that cannot be recomputed from its own record is not evidence.
 */
export const fluctuationCalculations = pgTable(
  "fluctuation_calculations",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    contractId: text("contract_id"),
    valuationId: text("valuation_id"),
    formula: text("formula").notNull(), // FluctuationFormula
    baseDate: text("base_date").notNull(),
    currentPeriod: text("current_period").notNull(),
    /** non-adjustable element as a fraction (FIDIC 13.8 "a") */
    nonAdjustable: doublePrecision("non_adjustable").default(0).notNull(),
    /** [{ seriesCode, weighting, baseIndex, currentIndex, contribution }] */
    components: jsonb("components").$type<unknown[]>().default([]).notNull(),
    workDoneAmount: doublePrecision("work_done_amount").default(0).notNull(),
    factor: doublePrecision("factor").default(1).notNull(),
    adjustment: doublePrecision("adjustment").default(0).notNull(),
    currency: text("currency").default("USD").notNull(),
    computedBy: text("computed_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("fluctuation_calcs_project_idx").on(t.projectId),
    index("fluctuation_calcs_valuation_idx").on(t.valuationId),
  ],
);

/* ------------------------------------------------------------------ */
/* Rate benchmarking (#145-149)                                        */
/* ------------------------------------------------------------------ */

export const rateBenchmarks = pgTable(
  "rate_benchmarks",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"),
    code: text("code"),
    description: text("description").notNull(),
    unit: text("unit").notNull(),
    rate: doublePrecision("rate").notNull(),
    currency: text("currency").default("USD").notNull(),
    region: text("region"),
    source: text("source").default("manual").notNull(), // RateBenchmarkSource
    asOfDate: text("as_of_date"),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("rate_benchmarks_company_idx").on(t.companyId, t.unit),
    index("rate_benchmarks_project_idx").on(t.projectId),
  ],
);

/* ------------------------------------------------------------------ */
/* CVR / WIP (#184-189)                                                */
/* ------------------------------------------------------------------ */

/**
 * A cost-value reconciliation for one period. The header carries the inputs
 * that were reachable when it was computed and the reasons anything is
 * missing; a CVR that silently treats "no cost data" as zero cost would be a
 * fabricated margin.
 */
export const cvrPeriods = pgTable(
  "cvr_periods",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    periodEnd: text("period_end").notNull(), // ISO date
    currency: text("currency").default("USD").notNull(),
    status: text("status").default("draft").notNull(), // CvrStatus
    valueToDate: doublePrecision("value_to_date").default(0).notNull(),
    certifiedToDate: doublePrecision("certified_to_date").default(0).notNull(),
    costToDate: doublePrecision("cost_to_date").default(0).notNull(),
    accruals: doublePrecision("accruals").default(0).notNull(),
    wip: doublePrecision("wip").default(0).notNull(),
    margin: doublePrecision("margin").default(0).notNull(),
    marginPercent: doublePrecision("margin_percent"),
    overUnderCertification: doublePrecision("over_under_certification").default(0).notNull(),
    /** what could not be measured and why — surfaced verbatim in the UI */
    gaps: jsonb("gaps").$type<string[]>().default([]).notNull(),
    basis: jsonb("basis").$type<Record<string, unknown>>().default({}).notNull(),
    preparedBy: text("prepared_by").notNull(),
    finalisedBy: text("finalised_by"),
    finalisedAt: timestamp("finalised_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("cvr_periods_uq").on(t.projectId, t.periodEnd),
    index("cvr_periods_company_idx").on(t.companyId, t.projectId),
  ],
);

export const cvrRows = pgTable(
  "cvr_rows",
  {
    id: text("id").primaryKey(),
    cvrPeriodId: text("cvr_period_id").notNull(),
    scope: text("scope").notNull(), // CvrScope
    label: text("label").notNull(),
    packageRef: text("package_ref"),
    valueToDate: doublePrecision("value_to_date").default(0).notNull(),
    certifiedToDate: doublePrecision("certified_to_date").default(0).notNull(),
    costToDate: doublePrecision("cost_to_date").default(0).notNull(),
    accruals: doublePrecision("accruals").default(0).notNull(),
    margin: doublePrecision("margin").default(0).notNull(),
    marginPercent: doublePrecision("margin_percent"),
    basis: jsonb("basis").$type<Record<string, unknown>>().default({}).notNull(),
  },
  (t) => [index("cvr_rows_period_idx").on(t.cvrPeriodId)],
);

/**
 * BQ item ↔ schedule task allocation, so BQ money can be spread over the
 * programme to produce an S-curve and earned value from measured quantities
 * (#189). A BQ item may be split across several tasks by percentage.
 */
export const boqScheduleLinks = pgTable(
  "boq_schedule_links",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    boqItemId: text("boq_item_id").notNull(),
    taskId: text("task_id").notNull(),
    allocationPercent: doublePrecision("allocation_percent").default(100).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("boq_schedule_links_uq").on(t.boqItemId, t.taskId),
    index("boq_schedule_links_project_idx").on(t.projectId),
  ],
);

/* ------------------------------------------------------------------ */
/* Retention releases (#254)                                           */
/* ------------------------------------------------------------------ */

export const retentionReleases = pgTable(
  "retention_releases",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    contractId: text("contract_id"),
    boqId: text("boq_id"),
    kind: text("kind").notNull(), // RetentionReleaseKind
    amount: doublePrecision("amount").notNull(),
    currency: text("currency").default("USD").notNull(),
    releasedOn: text("released_on").notNull(), // ISO date
    /** for bond_substitution: the retention bond replacing the cash */
    bondReference: text("bond_reference"),
    certificateId: text("certificate_id"),
    reason: text("reason"),
    approvedBy: text("approved_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("retention_releases_project_idx").on(t.projectId),
    index("retention_releases_boq_idx").on(t.boqId),
  ],
);

/* ------------------------------------------------------------------ */
/* Final account (#181-183, #187)                                      */
/* ------------------------------------------------------------------ */

/**
 * The final account: contract sum → adjustments → final contract sum,
 * reconciled against Σ certificates so the closing payment (or the
 * over-certification to recover) is a computed, traceable figure. Sign-off
 * needs two different users on opposite sides, like certification.
 */
export const finalAccounts = pgTable(
  "final_accounts",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    contractId: text("contract_id").notNull(),
    boqId: text("boq_id"),
    number: integer("number").notNull(),
    status: text("status").default("draft").notNull(), // FinalAccountStatus
    currency: text("currency").default("USD").notNull(),
    contractSum: doublePrecision("contract_sum").default(0).notNull(),
    finalContractSum: doublePrecision("final_contract_sum").default(0).notNull(),
    certifiedToDate: doublePrecision("certified_to_date").default(0).notNull(),
    balanceDue: doublePrecision("balance_due").default(0).notNull(),
    /** unresolved inputs (open variations, unagreed remeasures) at compute time */
    gaps: jsonb("gaps").$type<string[]>().default([]).notNull(),
    statement: jsonb("statement").$type<Record<string, unknown>>().default({}).notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true, mode: "string" }),
    issuedBy: text("issued_by"),
    issuedAt: timestamp("issued_at", { withTimezone: true, mode: "string" }),
    contractorSignedBy: text("contractor_signed_by"),
    contractorSignedAt: timestamp("contractor_signed_at", {
      withTimezone: true,
      mode: "string",
    }),
    employerSignedBy: text("employer_signed_by"),
    employerSignedAt: timestamp("employer_signed_at", { withTimezone: true, mode: "string" }),
    disputeReason: text("dispute_reason"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("final_accounts_uq").on(t.contractId, t.number),
    index("final_accounts_project_idx").on(t.projectId, t.status),
  ],
);

export const finalAccountLines = pgTable(
  "final_account_lines",
  {
    id: text("id").primaryKey(),
    finalAccountId: text("final_account_id").notNull(),
    sequence: integer("sequence").default(0).notNull(),
    category: text("category").notNull(), // FinalAccountCategory
    description: text("description").notNull(),
    amount: doublePrecision("amount").notNull(),
    sourceType: text("source_type"),
    sourceId: text("source_id"),
    /** ledger entry hash of the source record's last consequential write */
    sourceHash: text("source_hash"),
    manual: boolean("manual").default(false).notNull(),
    note: text("note"),
  },
  (t) => [index("final_account_lines_account_idx").on(t.finalAccountId)],
);
