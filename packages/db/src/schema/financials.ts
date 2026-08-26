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
 * FINANCIAL SUITE — the money spine (spec Vol I §3, modules M2-M6).
 *
 * Five tools, one ledger. Every dollar on a project follows the same path and
 * the schema is shaped around that path rather than around five separate
 * screens:
 *
 *   BUDGET        A cost-code-bound plan. `original` is frozen at lock;
 *                 everything after that is an auditable delta — transfers
 *                 between lines (`budget_changes`) and owner-funded increases
 *                 pushed down from executed change orders. `revised` is
 *                 therefore derived, never typed.
 *
 *   PRIME         What the owner owes us. A schedule of values whose lines
 *   CONTRACT      are the billing unit; executed change orders append lines
 *                 rather than editing them, so a G703 continuation sheet
 *                 always reconciles to the original contract.
 *
 *   COMMITMENTS   What we owe our subs and suppliers. Subcontracts and
 *                 purchase orders share one table because every rollup —
 *                 committed cost, retainage held, invoiced-to-date — treats
 *                 them identically; only tax, delivery and lien-waiver
 *                 handling differ, and those are nullable columns.
 *
 *   CHANGE        The real chain, modelled end to end:
 *   MANAGEMENT      change_event  (an RFI answer, a field condition)
 *                     -> potential_change_order   (our cost position)
 *                     -> change_quote_request     (RFQ out to the sub)
 *                     -> change_order_request     (COR priced to the owner)
 *                     -> change_order_package     (executed)
 *                          -> prime_contract_changes  (revenue up)
 *                          -> commitment_changes      (cost up)
 *                          -> budget_changes          (budget up)
 *                 One executed package touches BOTH sides. That is the whole
 *                 point: a change that raises the contract sum without
 *                 raising the commitment is margin, and a change that raises
 *                 the commitment without raising the contract sum is a loss.
 *                 The schema makes both visible in the same row.
 *
 *   INVOICING     Billing in both directions off the same SOV lines: owner
 *                 applications (AIA G702/G703 arithmetic materialized on the
 *                 invoice) and subcontractor invoices, gated by billing
 *                 periods, retainage and lien waivers.
 *
 * CONVENTIONS THROUGHOUT
 *  - `companyId` + `projectId` on every table: tenancy and project scoping are
 *    filter predicates, never joins.
 *  - `number` (integer) + `reference` (text): the integer is what the
 *    `record_counters` sequence hands out, the text is the human label
 *    ("PCCO-004"). Both are persisted so renumbering is impossible.
 *  - `createdBy` / `submittedBy` / `approvedBy` are ALWAYS distinct columns.
 *    Segregation of duties is not enforceable if one column holds both, and
 *    self-approval is the single most common financial control failure on a
 *    construction project. The API refuses `approvedBy === requestedBy` on
 *    budget changes; the columns exist so the refusal is provable afterwards.
 *  - Money is `doublePrecision`, matching the rest of the platform.
 *  - `detail` jsonb on every table: extension point for tenant-specific
 *    fields without a migration.
 *  - Rollup columns (committed, invoiced, retainage held) are MATERIALIZED,
 *    not computed on read. A budget view over 4,000 lines cannot afford six
 *    aggregate subqueries per row; the API recomputes them on write and
 *    stamps `totalsCalculatedAt`.
 */

/* ------------------------------------------------------------------ */
/* Budget                                                              */
/* ------------------------------------------------------------------ */

/**
 * A budget is a versioned, cost-code-bound plan for one project. Several may
 * coexist (baseline plus scenarios); `isActive` marks the one every other
 * tool rolls up against. Locking is the meaningful transition: after
 * `lockedAt` the line amounts may only move through `budget_changes`, which
 * is what makes original-vs-revised defensible instead of an edit log.
 */
export const budgets = pgTable(
  "budgets",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").default("draft").notNull(), // BudgetStatus
    version: integer("version").default(1).notNull(),
    /** exactly one active budget per project drives every rollup */
    isActive: integer("is_active").default(0).notNull(),
    currency: text("currency").default("USD").notNull(),
    /** ordered wbs_segments.id list this budget is broken down by */
    wbsSegmentIds: jsonb("wbs_segment_ids").$type<string[]>().default([]).notNull(),
    /** after lock, line amounts move only through approved budget_changes */
    lockedAt: timestamp("locked_at", { withTimezone: true, mode: "string" }),
    lockedBy: text("locked_by"),
    /* materialized rollups over budget_line_items */
    originalBudgetTotal: doublePrecision("original_budget_total").default(0).notNull(),
    budgetModificationsTotal: doublePrecision("budget_modifications_total").default(0).notNull(),
    approvedChangesTotal: doublePrecision("approved_changes_total").default(0).notNull(),
    pendingChangesTotal: doublePrecision("pending_changes_total").default(0).notNull(),
    revisedBudgetTotal: doublePrecision("revised_budget_total").default(0).notNull(),
    committedTotal: doublePrecision("committed_total").default(0).notNull(),
    pendingCommitmentsTotal: doublePrecision("pending_commitments_total").default(0).notNull(),
    directCostsTotal: doublePrecision("direct_costs_total").default(0).notNull(),
    jobToDateCostsTotal: doublePrecision("job_to_date_costs_total").default(0).notNull(),
    forecastToCompleteTotal: doublePrecision("forecast_to_complete_total").default(0).notNull(),
    forecastFinalTotal: doublePrecision("forecast_final_total").default(0).notNull(),
    varianceTotal: doublePrecision("variance_total").default(0).notNull(),
    /** stamped whenever the rollups above are recomputed */
    totalsCalculatedAt: timestamp("totals_calculated_at", { withTimezone: true, mode: "string" }),
    /** column visibility, forecast defaults, grouping — the saved budget view */
    settings: jsonb("settings").$type<Record<string, unknown>>().default({}).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("budgets_uq").on(t.projectId, t.number),
    index("budgets_project_idx").on(t.projectId, t.status),
    index("budgets_company_idx").on(t.companyId),
  ],
);

/**
 * The budget line — one row per WBS coordinate (cost code × cost type). This
 * is the table every other financial tool points at: a commitment SOV line, a
 * change line item and an invoice line all carry `budgetLineItemId`, which is
 * how "committed", "direct costs" and "forecast" become one row instead of
 * three reports.
 *
 * The amount columns are the classic construction cost report, left to right:
 *   original + modifications + approvedChanges = revisedBudget
 *   committed + pendingCommitments             = obligated
 *   directCosts                                = spent
 *   forecastToComplete + jobToDateCosts        = forecastFinal
 *   revisedBudget - forecastFinal              = projectedOverUnder
 * Each is stored because the budget view is the hottest read on the platform.
 */
export const budgetLineItems = pgTable(
  "budget_line_items",
  {
    id: text("id").primaryKey(),
    budgetId: text("budget_id").notNull(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    /** cost_codes.id — the authoritative binding */
    costCodeId: text("cost_code_id"),
    /** denormalized code string so the budget view sorts without a join */
    costCode: text("cost_code").notNull(),
    /** CostType; not null (defaults "other") so the WBS unique index holds */
    costType: text("cost_type").default("other").notNull(),
    /** materialized WBS path for grouped/collapsed rendering, e.g. "03/03300" */
    wbsPath: text("wbs_path"),
    /** sub-job / phase segment when the project uses one */
    subJob: text("sub_job"),
    description: text("description").notNull(),
    lineKind: text("line_kind").default("standard").notNull(), // BudgetLineKind
    status: text("status").default("active").notNull(), // BudgetLineStatus
    /* unit basis — a line may be measured or lump sum */
    unit: text("unit"),
    quantity: doublePrecision("quantity"),
    unitRate: doublePrecision("unit_rate"),
    /* the cost report */
    originalBudget: doublePrecision("original_budget").default(0).notNull(),
    /** net of approved transfers in/out from budget_changes */
    budgetModifications: doublePrecision("budget_modifications").default(0).notNull(),
    /** owner-funded increases from executed prime contract change orders */
    approvedChanges: doublePrecision("approved_changes").default(0).notNull(),
    /** priced but not executed — the exposure line */
    pendingBudgetChanges: doublePrecision("pending_budget_changes").default(0).notNull(),
    revisedBudget: doublePrecision("revised_budget").default(0).notNull(),
    /** approved commitments incl. executed commitment change orders */
    committedCost: doublePrecision("committed_cost").default(0).notNull(),
    /** draft/pending commitment changes not yet executed */
    pendingCommitments: doublePrecision("pending_commitments").default(0).notNull(),
    /** costs booked outside a commitment (labour, equipment, expenses) */
    directCosts: doublePrecision("direct_costs").default(0).notNull(),
    /** everything actually incurred: invoiced commitments + direct costs */
    jobToDateCosts: doublePrecision("job_to_date_costs").default(0).notNull(),
    forecastMethod: text("forecast_method").default("remaining_budget").notNull(), // ForecastMethod
    forecastToComplete: doublePrecision("forecast_to_complete").default(0).notNull(),
    forecastFinal: doublePrecision("forecast_final").default(0).notNull(),
    /** revisedBudget - forecastFinal; negative is an overrun */
    projectedOverUnder: doublePrecision("projected_over_under").default(0).notNull(),
    percentComplete: doublePrecision("percent_complete").default(0).notNull(),
    /** free text the estimator leaves on the line — the "why" of a forecast */
    notes: text("notes"),
    sortOrder: integer("sort_order").default(0).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("budget_line_items_uq").on(t.budgetId, t.costCode, t.costType),
    index("budget_line_items_budget_idx").on(t.budgetId, t.sortOrder),
    index("budget_line_items_project_idx").on(t.projectId),
    index("budget_line_items_cost_code_idx").on(t.costCodeId),
  ],
);

/**
 * Immutable period capture. The whole line set and totals are frozen into
 * jsonb rather than re-derived, because "what did the budget say at month
 * end" must survive later edits to cost codes, line splits and forecasts.
 * `contentHash` is a sha-256 over the frozen payload so a silent edit to the
 * snapshot itself is detectable. There is deliberately no `updatedAt`.
 */
export const budgetSnapshots = pgTable(
  "budget_snapshots",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    budgetId: text("budget_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    name: text("name").notNull(),
    kind: text("kind").default("monthly_close").notNull(), // BudgetSnapshotKind
    billingPeriodId: text("billing_period_id"),
    periodStart: text("period_start"), // ISO date
    periodEnd: text("period_end"), // ISO date
    asOfDate: text("as_of_date").notNull(), // ISO date
    /** frozen line rows: [{ lineItemId, costCode, costType, description,
     *  originalBudget, revisedBudget, committedCost, directCosts,
     *  forecastToComplete, forecastFinal, projectedOverUnder }] */
    lines: jsonb("lines").$type<unknown[]>().default([]).notNull(),
    totals: jsonb("totals").$type<Record<string, number>>().default({}).notNull(),
    /** sha-256 over lines+totals — tamper evidence on the capture itself */
    contentHash: text("content_hash").notNull(),
    lineCount: integer("line_count").default(0).notNull(),
    notes: text("notes"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    capturedBy: text("captured_by").notNull(),
    capturedAt: createdAt(),
  },
  (t) => [
    uniqueIndex("budget_snapshots_uq").on(t.budgetId, t.number),
    index("budget_snapshots_project_idx").on(t.projectId, t.asOfDate),
  ],
);

/**
 * A budget change moves money. Transfers and contingency draws net to zero
 * across their legs; only `owner_change` alters the budget total, and only as
 * the downstream effect of an executed prime contract change order
 * (`sourceType` = "change_order_package").
 *
 * APPROVAL TRAIL. `requestedBy` and `approvedBy` are separate columns and the
 * API rejects a request where they are equal — a project manager cannot move
 * money out of contingency into his own overrun on his own signature. The
 * rejected path is recorded too (`rejectedBy`, `rejectionReason`) so a refused
 * transfer is evidence rather than a deleted row.
 */
export const budgetChanges = pgTable(
  "budget_changes",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    budgetId: text("budget_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    kind: text("kind").default("transfer").notNull(), // BudgetChangeKind
    title: text("title").notNull(),
    description: text("description"),
    reason: text("reason"),
    status: text("status").default("draft").notNull(), // BudgetChangeStatus
    /** transfer legs: [{ lineItemId, costCode, costType, amount }]; negative
     *  amounts are sources, positive are destinations. Must sum to zero
     *  unless kind = owner_change. */
    lines: jsonb("lines").$type<unknown[]>().default([]).notNull(),
    /** convenience for the common two-leg transfer; lines[] remains canonical */
    fromLineItemId: text("from_line_item_id"),
    toLineItemId: text("to_line_item_id"),
    /** absolute value moved */
    amount: doublePrecision("amount").default(0).notNull(),
    /** 0 for transfers/draws, non-zero only for owner_change */
    netEffect: doublePrecision("net_effect").default(0).notNull(),
    effectiveDate: text("effective_date"), // ISO date
    /** what caused this: change_order_package | prime_contract_change | manual */
    sourceType: text("source_type"),
    sourceId: text("source_id"),
    requestedBy: text("requested_by").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true, mode: "string" }),
    /** MUST NOT equal requestedBy — enforced by the API, provable here */
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    rejectedBy: text("rejected_by"),
    rejectedAt: timestamp("rejected_at", { withTimezone: true, mode: "string" }),
    rejectionReason: text("rejection_reason"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("budget_changes_uq").on(t.budgetId, t.number),
    index("budget_changes_project_idx").on(t.projectId, t.status),
    index("budget_changes_source_idx").on(t.sourceType, t.sourceId),
  ],
);

/**
 * Point-in-time forecast for one budget line. Kept as rows rather than a
 * column on the line so the forecast history — who moved the number, when,
 * on what basis — is queryable. `previousForecastFinal` and
 * `deltaFromPrevious` are stored so a forecast swing report needs no window
 * function. A row scoped to `lineItemId = null` is a project-level forecast.
 */
export const budgetForecasts = pgTable(
  "budget_forecasts",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    budgetId: text("budget_id").notNull(),
    /** null = whole-budget forecast */
    lineItemId: text("line_item_id"),
    billingPeriodId: text("billing_period_id"),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    asOfDate: text("as_of_date").notNull(), // ISO date
    method: text("method").default("manual").notNull(), // ForecastMethod
    status: text("status").default("draft").notNull(), // BudgetForecastStatus
    forecastToComplete: doublePrecision("forecast_to_complete").default(0).notNull(),
    forecastFinal: doublePrecision("forecast_final").default(0).notNull(),
    previousForecastFinal: doublePrecision("previous_forecast_final").default(0).notNull(),
    deltaFromPrevious: doublePrecision("delta_from_previous").default(0).notNull(),
    percentComplete: doublePrecision("percent_complete").default(0).notNull(),
    /** remaining spend distributed over time: [{ month: "2026-09", amount }] */
    curve: jsonb("curve").$type<unknown[]>().default([]).notNull(),
    assumptions: text("assumptions"),
    notes: text("notes"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    submittedBy: text("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "string" }),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("budget_forecasts_uq").on(t.budgetId, t.number),
    index("budget_forecasts_line_idx").on(t.lineItemId, t.asOfDate),
    index("budget_forecasts_project_idx").on(t.projectId, t.asOfDate),
  ],
);

/* ------------------------------------------------------------------ */
/* Prime contracts — what the owner owes us                            */
/* ------------------------------------------------------------------ */

/**
 * The owner-facing agreement. `contractId` optionally links the standard-form
 * contract record in `contracts` (FIDIC/NEC/JCT clause intelligence); this
 * table is the commercial ledger for it — sums, retainage, billing.
 *
 * `originalContractSum` is frozen at execution. `approvedChangeSum` is the
 * sum of executed `prime_contract_changes`; `revisedContractSum` is derived
 * from the two and never typed. `pendingChangeSum` carries priced-but-
 * unexecuted CORs, which is the number a forecast needs and a contract sum
 * must not include.
 */
export const primeContracts = pgTable(
  "prime_contracts",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    scopeOfWork: text("scope_of_work"),
    /** the paying party, as a directory vendor */
    ownerVendorId: text("owner_vendor_id"),
    ownerContactId: text("owner_contact_id"),
    /** the contracting entity (us) */
    contractorVendorId: text("contractor_vendor_id"),
    /** certifier on AIA-style applications for payment */
    architectVendorId: text("architect_vendor_id"),
    /** standard-form contract record carrying the clause set, when one exists */
    contractId: text("contract_id"),
    pricingType: text("pricing_type").default("lump_sum").notNull(), // ContractPricingType
    status: text("status").default("draft").notNull(), // PrimeContractStatus
    /** signed by both parties — only then may it be billed against */
    executed: integer("executed").default(0).notNull(),
    currency: text("currency").default("USD").notNull(),
    /* the contract sum, decomposed */
    originalContractSum: doublePrecision("original_contract_sum").default(0).notNull(),
    approvedChangeSum: doublePrecision("approved_change_sum").default(0).notNull(),
    pendingChangeSum: doublePrecision("pending_change_sum").default(0).notNull(),
    draftChangeSum: doublePrecision("draft_change_sum").default(0).notNull(),
    revisedContractSum: doublePrecision("revised_contract_sum").default(0).notNull(),
    /* billing position */
    totalBilled: doublePrecision("total_billed").default(0).notNull(),
    totalPaid: doublePrecision("total_paid").default(0).notNull(),
    /** default withheld on new SOV lines; a line may override */
    defaultRetainagePercent: doublePrecision("default_retainage_percent").default(0).notNull(),
    retainageHeld: doublePrecision("retainage_held").default(0).notNull(),
    retainageReleased: doublePrecision("retainage_released").default(0).notNull(),
    balanceToFinish: doublePrecision("balance_to_finish").default(0).notNull(),
    totalsCalculatedAt: timestamp("totals_calculated_at", { withTimezone: true, mode: "string" }),
    /* dates (ISO) */
    contractDate: text("contract_date"),
    startDate: text("start_date"),
    substantialCompletionDate: text("substantial_completion_date"),
    actualCompletionDate: text("actual_completion_date"),
    signedContractReceivedDate: text("signed_contract_received_date"),
    executionDate: text("execution_date"),
    terminationDate: text("termination_date"),
    paymentTermsDays: integer("payment_terms_days"),
    inclusions: text("inclusions"),
    exclusions: text("exclusions"),
    documentIds: jsonb("document_ids").$type<string[]>().default([]).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    executedBy: text("executed_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("prime_contracts_uq").on(t.projectId, t.number),
    index("prime_contracts_project_idx").on(t.projectId, t.status),
    index("prime_contracts_company_idx").on(t.companyId),
  ],
);

/**
 * Schedule of values — the AIA G703 continuation sheet, and the billing unit
 * for everything the owner pays. `budgetLineItemId` is the link that makes
 * revenue and cost comparable on one cost code.
 *
 * Executed change orders APPEND lines (`isChangeOrderLine` = 1, with
 * `changeOrderPackageId` set) rather than editing the originals, because a
 * G703 must always reconcile back to the original contract; `changeOrderValue`
 * on an original line carries any allocation that legitimately amends it.
 */
export const primeContractSovLines = pgTable(
  "prime_contract_sov_lines",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    primeContractId: text("prime_contract_id").notNull(),
    /** human line label on the G703, e.g. "03.1" */
    lineNumber: text("line_number").notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    costCodeId: text("cost_code_id"),
    costCode: text("cost_code"),
    costType: text("cost_type"),
    /** the budget line this revenue is earned against */
    budgetLineItemId: text("budget_line_item_id"),
    description: text("description").notNull(),
    billingMethod: text("billing_method").default("percent_complete").notNull(), // SovBillingMethod
    unit: text("unit"),
    quantity: doublePrecision("quantity"),
    unitRate: doublePrecision("unit_rate"),
    /* the G703 columns */
    scheduledValue: doublePrecision("scheduled_value").default(0).notNull(),
    changeOrderValue: doublePrecision("change_order_value").default(0).notNull(),
    revisedScheduledValue: doublePrecision("revised_scheduled_value").default(0).notNull(),
    previousBilled: doublePrecision("previous_billed").default(0).notNull(),
    previousStoredMaterials: doublePrecision("previous_stored_materials").default(0).notNull(),
    thisPeriodWork: doublePrecision("this_period_work").default(0).notNull(),
    thisPeriodStoredMaterials: doublePrecision("this_period_stored_materials").default(0).notNull(),
    /** materials on site but not yet incorporated (G703 column E) */
    materialsPresentlyStored: doublePrecision("materials_presently_stored").default(0).notNull(),
    totalCompletedAndStored: doublePrecision("total_completed_and_stored").default(0).notNull(),
    percentComplete: doublePrecision("percent_complete").default(0).notNull(),
    balanceToFinish: doublePrecision("balance_to_finish").default(0).notNull(),
    retainagePercent: doublePrecision("retainage_percent").default(0).notNull(),
    retainageHeld: doublePrecision("retainage_held").default(0).notNull(),
    retainageReleased: doublePrecision("retainage_released").default(0).notNull(),
    /** appended by an executed change order rather than in the original SOV */
    isChangeOrderLine: integer("is_change_order_line").default(0).notNull(),
    changeOrderPackageId: text("change_order_package_id"),
    notes: text("notes"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("prime_contract_sov_lines_uq").on(t.primeContractId, t.lineNumber),
    index("prime_contract_sov_lines_contract_idx").on(t.primeContractId, t.sortOrder),
    index("prime_contract_sov_lines_budget_idx").on(t.budgetLineItemId),
    index("prime_contract_sov_lines_project_idx").on(t.projectId),
  ],
);

/**
 * Prime contract change order (PCCO) — the executed revenue increase. Created
 * by executing a `change_order_packages` row of kind "prime_contract"; the
 * package id is kept so the COR chain behind the number is one join away.
 * `revisedContractSum` is the running contract sum AFTER this change, stored
 * so the change order log renders without a window function.
 */
export const primeContractChanges = pgTable(
  "prime_contract_changes",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    primeContractId: text("prime_contract_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    /** the package that executed this change */
    changeOrderPackageId: text("change_order_package_id"),
    title: text("title").notNull(),
    description: text("description"),
    reason: text("reason"), // ChangeReason
    status: text("status").default("draft").notNull(), // ChangeOrderStatus
    amount: doublePrecision("amount").default(0).notNull(),
    scheduleImpactDays: integer("schedule_impact_days").default(0).notNull(),
    /** SOV allocation: [{ sovLineId, costCode, costType, description, amount }] */
    lines: jsonb("lines").$type<unknown[]>().default([]).notNull(),
    /** contract sum after this change lands — running total for the CO log */
    revisedContractSum: doublePrecision("revised_contract_sum").default(0).notNull(),
    requestedDate: text("requested_date"), // ISO date
    dueDate: text("due_date"),
    executedDate: text("executed_date"),
    signedChangeOrderReceivedDate: text("signed_change_order_received_date"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    submittedBy: text("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "string" }),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    rejectedBy: text("rejected_by"),
    rejectedAt: timestamp("rejected_at", { withTimezone: true, mode: "string" }),
    rejectionReason: text("rejection_reason"),
    executedBy: text("executed_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("prime_contract_changes_uq").on(t.primeContractId, t.number),
    index("prime_contract_changes_project_idx").on(t.projectId, t.status),
    index("prime_contract_changes_package_idx").on(t.changeOrderPackageId),
  ],
);

/* ------------------------------------------------------------------ */
/* Commitments — what we owe subs and suppliers                        */
/* ------------------------------------------------------------------ */

/**
 * Subcontracts AND purchase orders, discriminated by `kind`. They share one
 * table because every rollup on the platform — committed cost, retainage
 * held, invoiced to date, remaining balance — treats them identically. Only
 * tax, shipping and lien-waiver handling differ, and those are nullable.
 *
 * `paymentHold` + `complianceHoldReason` are the teeth: a subcontractor whose
 * insurance certificate has lapsed or whose lien waiver is outstanding cannot
 * be paid, and the reason travels with the commitment rather than living in
 * someone's inbox.
 */
export const commitments = pgTable(
  "commitments",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    kind: text("kind").default("subcontract").notNull(), // CommitmentKind
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    scopeOfWork: text("scope_of_work"),
    /** the sub or supplier */
    vendorId: text("vendor_id"),
    vendorContactId: text("vendor_contact_id"),
    /** standard-form contract record carrying the clause set, when one exists */
    contractId: text("contract_id"),
    /** the prime contract this cost is ultimately earned under */
    primeContractId: text("prime_contract_id"),
    pricingType: text("pricing_type").default("lump_sum").notNull(), // ContractPricingType
    status: text("status").default("draft").notNull(), // FinancialCommitmentStatus
    executed: integer("executed").default(0).notNull(),
    currency: text("currency").default("USD").notNull(),
    /* the commitment sum, decomposed */
    originalCommitmentSum: doublePrecision("original_commitment_sum").default(0).notNull(),
    approvedChangeSum: doublePrecision("approved_change_sum").default(0).notNull(),
    pendingChangeSum: doublePrecision("pending_change_sum").default(0).notNull(),
    draftChangeSum: doublePrecision("draft_change_sum").default(0).notNull(),
    revisedCommitmentSum: doublePrecision("revised_commitment_sum").default(0).notNull(),
    /* payment position */
    totalInvoiced: doublePrecision("total_invoiced").default(0).notNull(),
    totalPaid: doublePrecision("total_paid").default(0).notNull(),
    defaultRetainagePercent: doublePrecision("default_retainage_percent").default(0).notNull(),
    retainageHeld: doublePrecision("retainage_held").default(0).notNull(),
    retainageReleased: doublePrecision("retainage_released").default(0).notNull(),
    balanceToFinish: doublePrecision("balance_to_finish").default(0).notNull(),
    totalsCalculatedAt: timestamp("totals_calculated_at", { withTimezone: true, mode: "string" }),
    /* dates (ISO) */
    contractDate: text("contract_date"),
    startDate: text("start_date"),
    estimatedCompletionDate: text("estimated_completion_date"),
    actualCompletionDate: text("actual_completion_date"),
    signedContractReceivedDate: text("signed_contract_received_date"),
    executionDate: text("execution_date"),
    terminationDate: text("termination_date"),
    paymentTermsDays: integer("payment_terms_days"),
    /* compliance gating — why a payment is blocked */
    requiresLienWaiver: integer("requires_lien_waiver").default(1).notNull(),
    paymentHold: integer("payment_hold").default(0).notNull(),
    complianceHoldReason: text("compliance_hold_reason"),
    /** insurance certificates / bonds satisfying the commitment's requirements */
    complianceDetail: jsonb("compliance_detail").$type<Record<string, unknown>>().default({}).notNull(),
    /* purchase-order specifics (null on subcontracts) */
    shipTo: text("ship_to"),
    shipVia: text("ship_via"),
    deliveryDate: text("delivery_date"),
    taxable: integer("taxable").default(0).notNull(),
    taxPercent: doublePrecision("tax_percent"),
    taxAmount: doublePrecision("tax_amount"),
    inclusions: text("inclusions"),
    exclusions: text("exclusions"),
    documentIds: jsonb("document_ids").$type<string[]>().default([]).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    executedBy: text("executed_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("commitments_uq").on(t.projectId, t.number),
    index("commitments_project_idx").on(t.projectId, t.kind, t.status),
    index("commitments_vendor_idx").on(t.vendorId),
    index("commitments_company_idx").on(t.companyId),
  ],
);

/**
 * Commitment schedule of values — how a sub bills us, mirroring the prime SOV
 * so the two sides reconcile line for line on a shared cost code. PO lines
 * add `taxable`/`taxCode`; subcontract lines add retainage.
 */
export const commitmentSovLines = pgTable(
  "commitment_sov_lines",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    commitmentId: text("commitment_id").notNull(),
    lineNumber: text("line_number").notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    costCodeId: text("cost_code_id"),
    costCode: text("cost_code"),
    costType: text("cost_type"),
    /** the budget line this cost is committed against */
    budgetLineItemId: text("budget_line_item_id"),
    description: text("description").notNull(),
    billingMethod: text("billing_method").default("percent_complete").notNull(), // SovBillingMethod
    unit: text("unit"),
    quantity: doublePrecision("quantity"),
    unitRate: doublePrecision("unit_rate"),
    scheduledValue: doublePrecision("scheduled_value").default(0).notNull(),
    changeOrderValue: doublePrecision("change_order_value").default(0).notNull(),
    revisedScheduledValue: doublePrecision("revised_scheduled_value").default(0).notNull(),
    previousBilled: doublePrecision("previous_billed").default(0).notNull(),
    previousStoredMaterials: doublePrecision("previous_stored_materials").default(0).notNull(),
    thisPeriodWork: doublePrecision("this_period_work").default(0).notNull(),
    thisPeriodStoredMaterials: doublePrecision("this_period_stored_materials").default(0).notNull(),
    materialsPresentlyStored: doublePrecision("materials_presently_stored").default(0).notNull(),
    totalCompletedAndStored: doublePrecision("total_completed_and_stored").default(0).notNull(),
    percentComplete: doublePrecision("percent_complete").default(0).notNull(),
    balanceToFinish: doublePrecision("balance_to_finish").default(0).notNull(),
    retainagePercent: doublePrecision("retainage_percent").default(0).notNull(),
    retainageHeld: doublePrecision("retainage_held").default(0).notNull(),
    retainageReleased: doublePrecision("retainage_released").default(0).notNull(),
    isChangeOrderLine: integer("is_change_order_line").default(0).notNull(),
    changeOrderPackageId: text("change_order_package_id"),
    taxable: integer("taxable").default(0).notNull(),
    taxCode: text("tax_code"),
    taxPercent: doublePrecision("tax_percent"),
    notes: text("notes"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("commitment_sov_lines_uq").on(t.commitmentId, t.lineNumber),
    index("commitment_sov_lines_commitment_idx").on(t.commitmentId, t.sortOrder),
    index("commitment_sov_lines_budget_idx").on(t.budgetLineItemId),
    index("commitment_sov_lines_project_idx").on(t.projectId),
  ],
);

/**
 * Commitment change order (CCO) — the executed cost increase against a sub or
 * supplier. Symmetric with `prime_contract_changes`; executing one
 * `change_order_packages` row of kind "commitment" writes exactly one of
 * these plus the budget effect.
 */
export const commitmentChanges = pgTable(
  "commitment_changes",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    commitmentId: text("commitment_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    changeOrderPackageId: text("change_order_package_id"),
    /** the PCO this change order settles, when the chain started there */
    potentialChangeOrderId: text("potential_change_order_id"),
    title: text("title").notNull(),
    description: text("description"),
    reason: text("reason"), // ChangeReason
    status: text("status").default("draft").notNull(), // ChangeOrderStatus
    amount: doublePrecision("amount").default(0).notNull(),
    scheduleImpactDays: integer("schedule_impact_days").default(0).notNull(),
    /** SOV allocation: [{ sovLineId, costCode, costType, description, amount }] */
    lines: jsonb("lines").$type<unknown[]>().default([]).notNull(),
    /** commitment sum after this change lands */
    revisedCommitmentSum: doublePrecision("revised_commitment_sum").default(0).notNull(),
    requestedDate: text("requested_date"),
    dueDate: text("due_date"),
    executedDate: text("executed_date"),
    signedChangeOrderReceivedDate: text("signed_change_order_received_date"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    submittedBy: text("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "string" }),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    rejectedBy: text("rejected_by"),
    rejectedAt: timestamp("rejected_at", { withTimezone: true, mode: "string" }),
    rejectionReason: text("rejection_reason"),
    executedBy: text("executed_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("commitment_changes_uq").on(t.commitmentId, t.number),
    index("commitment_changes_project_idx").on(t.projectId, t.status),
    index("commitment_changes_package_idx").on(t.changeOrderPackageId),
  ],
);

/**
 * Money actually leaving the building against a commitment. Separate from the
 * invoice because approval and disbursement are different acts by different
 * people on different days: `approvedBy` releases it, `issuedBy` cuts it.
 * `holdReason` records a payment that was scheduled and then stopped —
 * usually an outstanding lien waiver, which is why `lienWaiverId` is here.
 */
export const commitmentPayments = pgTable(
  "commitment_payments",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    commitmentId: text("commitment_id").notNull(),
    /** the invoice being paid; null for advances and standalone payments */
    invoiceId: text("invoice_id"),
    vendorId: text("vendor_id"),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    method: text("method").default("check").notNull(), // PaymentMethod
    status: text("status").default("scheduled").notNull(), // PaymentStatus
    amount: doublePrecision("amount").default(0).notNull(),
    /** retainage released as part of this payment */
    retainageReleasedAmount: doublePrecision("retainage_released_amount").default(0).notNull(),
    discountTaken: doublePrecision("discount_taken").default(0).notNull(),
    currency: text("currency").default("USD").notNull(),
    paymentDate: text("payment_date"), // ISO date
    clearedDate: text("cleared_date"),
    checkNumber: text("check_number"),
    transactionReference: text("transaction_reference"),
    bankAccountRef: text("bank_account_ref"),
    /** joint check payees, when method = joint_check: [{ name, vendorId }] */
    jointPayees: jsonb("joint_payees").$type<unknown[]>().default([]).notNull(),
    /** why a scheduled payment is not moving */
    holdReason: text("hold_reason"),
    lienWaiverId: text("lien_waiver_id"),
    notes: text("notes"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    issuedBy: text("issued_by"),
    issuedAt: timestamp("issued_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("commitment_payments_uq").on(t.commitmentId, t.number),
    index("commitment_payments_project_idx").on(t.projectId, t.status),
    index("commitment_payments_invoice_idx").on(t.invoiceId),
    index("commitment_payments_vendor_idx").on(t.vendorId),
  ],
);

/* ------------------------------------------------------------------ */
/* Change management — the chain from field condition to executed CO   */
/* ------------------------------------------------------------------ */

/**
 * THE ORIGIN. Something happened: an RFI came back with a different detail, a
 * trench hit rock, the owner wants a different finish. A change event is that
 * fact, recorded before anyone knows what it costs — which is exactly why it
 * exists. Unpriced exposure that only appears once it is priced is how
 * projects lose money quietly.
 *
 * `originType`/`originId` carry provenance back to the record that caused it
 * (an answered RFI, an observation, a drawing revision), so a claim two years
 * later can be traced to the document that created the entitlement.
 *
 * `roughOrderOfMagnitude` is the first guess; `estimatedCost` is the priced
 * position rolled up from PCOs; `latestCost` is the best current number
 * (executed where executed, priced where priced, ROM where nothing else).
 * Three columns because a change log that collapses them cannot show whether
 * exposure is hardening or softening.
 */
export const changeEvents = pgTable(
  "change_events",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").default("open").notNull(), // ChangeEventStatus
    eventType: text("event_type").default("other").notNull(), // ChangeEventType
    scope: text("scope").default("tbd").notNull(), // ChangeEventScope
    reason: text("reason"), // ChangeReason
    /** provenance: the record that caused this — ChangeEventOriginKind */
    originType: text("origin_type").default("manual").notNull(),
    originId: text("origin_id"),
    /** which prime contract this will (or will not) be billed to */
    primeContractId: text("prime_contract_id"),
    locationId: text("location_id"),
    /** one_tier | two_tier | three_tier, snapshotted from project settings */
    tier: text("tier"),
    /* the exposure, at three levels of confidence */
    roughOrderOfMagnitude: doublePrecision("rough_order_of_magnitude").default(0).notNull(),
    estimatedCost: doublePrecision("estimated_cost").default(0).notNull(),
    latestCost: doublePrecision("latest_cost").default(0).notNull(),
    estimatedRevenue: doublePrecision("estimated_revenue").default(0).notNull(),
    approvedRevenue: doublePrecision("approved_revenue").default(0).notNull(),
    scheduleImpactDays: integer("schedule_impact_days").default(0).notNull(),
    identifiedDate: text("identified_date"), // ISO date the condition arose
    dueDate: text("due_date"),
    notes: text("notes"),
    documentIds: jsonb("document_ids").$type<string[]>().default([]).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    closedBy: text("closed_by"),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("change_events_uq").on(t.projectId, t.number),
    index("change_events_project_idx").on(t.projectId, t.status),
    index("change_events_origin_idx").on(t.originType, t.originId),
    index("change_events_contract_idx").on(t.primeContractId),
  ],
);

/**
 * POTENTIAL CHANGE ORDER — our internal cost position, normally one per
 * affected commitment (plus one for self-performed work). This is where a
 * change event stops being a narrative and becomes money we will owe.
 *
 * `estimatedAmount` is our estimate, `quotedAmount` is what the sub came back
 * with on the RFQ, `amount` is the position we are taking forward. Keeping
 * the three apart is what lets a PM see that a sub quoted 40% over estimate
 * before it is baked into a COR to the owner.
 */
export const potentialChangeOrders = pgTable(
  "potential_change_orders",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    /** null for a PCO raised without a change event (rare, but legal) */
    changeEventId: text("change_event_id"),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").default("draft").notNull(), // PcoStatus
    reason: text("reason"), // ChangeReason
    scope: text("scope").default("tbd").notNull(), // ChangeEventScope
    /** the sub whose scope this prices; null for self-performed work */
    commitmentId: text("commitment_id"),
    vendorId: text("vendor_id"),
    primeContractId: text("prime_contract_id"),
    /** the COR this PCO was rolled into, once one exists */
    changeOrderRequestId: text("change_order_request_id"),
    /** the package that executed it into a commitment change order */
    changeOrderPackageId: text("change_order_package_id"),
    estimatedAmount: doublePrecision("estimated_amount").default(0).notNull(),
    quotedAmount: doublePrecision("quoted_amount").default(0).notNull(),
    /** the position being carried forward */
    amount: doublePrecision("amount").default(0).notNull(),
    scheduleImpactDays: integer("schedule_impact_days").default(0).notNull(),
    /** the sub absorbs it — recorded rather than deleted, so it is countable */
    noCharge: integer("no_charge").default(0).notNull(),
    dueDate: text("due_date"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    submittedBy: text("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "string" }),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    rejectedBy: text("rejected_by"),
    rejectedAt: timestamp("rejected_at", { withTimezone: true, mode: "string" }),
    rejectionReason: text("rejection_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("potential_change_orders_uq").on(t.projectId, t.number),
    index("potential_change_orders_event_idx").on(t.changeEventId),
    index("potential_change_orders_commitment_idx").on(t.commitmentId),
    index("potential_change_orders_project_idx").on(t.projectId, t.status),
  ],
);

/**
 * RFQ OUT TO THE SUB. A change quote request is how a PCO gets a real number:
 * the scope goes out to the subcontractor, a due date is set, and the answer
 * comes back as `quotedAmount` + `quotedScheduleImpactDays`. Accepting a quote
 * is what sets the parent PCO's amount.
 *
 * `sentAt`/`respondedAt`/`dueDate` exist because the commonest cause of a
 * change order stalling is a sub who never answered, and that must be visible
 * as a number of days, not a memory.
 */
export const changeQuoteRequests = pgTable(
  "change_quote_requests",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    changeEventId: text("change_event_id"),
    potentialChangeOrderId: text("potential_change_order_id"),
    commitmentId: text("commitment_id"),
    vendorId: text("vendor_id"),
    vendorContactId: text("vendor_contact_id"),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    scopeDescription: text("scope_description"),
    status: text("status").default("draft").notNull(), // QuoteRequestStatus
    dueDate: text("due_date"), // ISO date the quote is required by
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "string" }),
    sentBy: text("sent_by"),
    viewedAt: timestamp("viewed_at", { withTimezone: true, mode: "string" }),
    respondedAt: timestamp("responded_at", { withTimezone: true, mode: "string" }),
    quotedAmount: doublePrecision("quoted_amount"),
    quotedScheduleImpactDays: integer("quoted_schedule_impact_days"),
    quoteNotes: text("quote_notes"),
    quoteValidUntil: text("quote_valid_until"),
    quoteDocumentIds: jsonb("quote_document_ids").$type<string[]>().default([]).notNull(),
    /** accepting the quote is what sets the PCO amount */
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "string" }),
    acceptedBy: text("accepted_by"),
    declinedAt: timestamp("declined_at", { withTimezone: true, mode: "string" }),
    declineReason: text("decline_reason"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("change_quote_requests_uq").on(t.projectId, t.number),
    index("change_quote_requests_pco_idx").on(t.potentialChangeOrderId),
    index("change_quote_requests_vendor_idx").on(t.vendorId, t.status),
    index("change_quote_requests_project_idx").on(t.projectId, t.status),
  ],
);

/**
 * CHANGE ORDER REQUEST — the priced ask that goes to the owner. Rolls up one
 * or more PCOs (`pcoIds`), adds the markup schedule (overhead, profit, bond,
 * insurance) and becomes the number under negotiation.
 *
 * `amount` is what we asked for; `approvedAmount` is what the owner agreed.
 * They are different columns because the gap between them, aggregated across
 * a project, is the single most useful commercial metric a contractor has —
 * and because a partially approved COR must not silently rewrite what was
 * requested.
 */
export const changeOrderRequests = pgTable(
  "change_order_requests",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    primeContractId: text("prime_contract_id").notNull(),
    changeEventId: text("change_event_id"),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    reason: text("reason"), // ChangeReason
    status: text("status").default("draft").notNull(), // CorStatus
    /** potential_change_orders.id rolled into this request */
    pcoIds: jsonb("pco_ids").$type<string[]>().default([]).notNull(),
    /** markup schedule applied over the cost lines:
     *  [{ kind: MarkupKind, label, basis, rate, amount }] */
    markups: jsonb("markups").$type<unknown[]>().default([]).notNull(),
    subtotal: doublePrecision("subtotal").default(0).notNull(),
    markupTotal: doublePrecision("markup_total").default(0).notNull(),
    taxTotal: doublePrecision("tax_total").default(0).notNull(),
    /** total requested from the owner */
    amount: doublePrecision("amount").default(0).notNull(),
    /** what the owner actually approved — may be lower, may be zero */
    approvedAmount: doublePrecision("approved_amount").default(0).notNull(),
    scheduleImpactDays: integer("schedule_impact_days").default(0).notNull(),
    scheduleImpactApprovedDays: integer("schedule_impact_approved_days").default(0).notNull(),
    submittedDate: text("submitted_date"), // ISO date
    dueDate: text("due_date"),
    ownerResponseDate: text("owner_response_date"),
    /** the PCCO package this was executed under */
    changeOrderPackageId: text("change_order_package_id"),
    negotiationNotes: text("negotiation_notes"),
    documentIds: jsonb("document_ids").$type<string[]>().default([]).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    submittedBy: text("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "string" }),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    rejectedBy: text("rejected_by"),
    rejectedAt: timestamp("rejected_at", { withTimezone: true, mode: "string" }),
    rejectionReason: text("rejection_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("change_order_requests_uq").on(t.projectId, t.number),
    index("change_order_requests_contract_idx").on(t.primeContractId, t.status),
    index("change_order_requests_event_idx").on(t.changeEventId),
    index("change_order_requests_project_idx").on(t.projectId, t.status),
  ],
);

/**
 * THE EXECUTION POINT. A package groups what is being executed as one signed
 * change order — CORs on the prime side (a PCCO), PCOs on the commitment side
 * (a CCO) — and executing it is the transaction that writes:
 *
 *   kind = "prime_contract" -> one prime_contract_changes row
 *                           -> appended prime_contract_sov_lines
 *                           -> a budget_changes row of kind "owner_change"
 *   kind = "commitment"     -> one commitment_changes row
 *                           -> appended commitment_sov_lines
 *                           -> committed cost onto the budget lines
 *
 * `primeContractChangeId` / `commitmentChangeId` are stamped by that
 * transaction, so "has this been executed, and into what" is a column read
 * rather than a search. Numbering is per kind: a project has PCCO-001 and
 * CCO-001 at the same time.
 */
export const changeOrderPackages = pgTable(
  "change_order_packages",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    kind: text("kind").notNull(), // ChangeOrderPackageKind
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").default("draft").notNull(), // ChangeOrderStatus
    /** prime packages carry primeContractId; commitment packages carry commitmentId */
    primeContractId: text("prime_contract_id"),
    commitmentId: text("commitment_id"),
    changeEventId: text("change_event_id"),
    /** change_order_requests.id (prime) or potential_change_orders.id (commitment) */
    memberIds: jsonb("member_ids").$type<string[]>().default([]).notNull(),
    amount: doublePrecision("amount").default(0).notNull(),
    scheduleImpactDays: integer("schedule_impact_days").default(0).notNull(),
    /** stamped by the execution transaction */
    primeContractChangeId: text("prime_contract_change_id"),
    commitmentChangeId: text("commitment_change_id"),
    budgetChangeId: text("budget_change_id"),
    executedAt: timestamp("executed_at", { withTimezone: true, mode: "string" }),
    executedBy: text("executed_by"),
    signedDate: text("signed_date"), // ISO date
    dueDate: text("due_date"),
    documentIds: jsonb("document_ids").$type<string[]>().default([]).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    submittedBy: text("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "string" }),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    rejectedBy: text("rejected_by"),
    rejectedAt: timestamp("rejected_at", { withTimezone: true, mode: "string" }),
    rejectionReason: text("rejection_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("change_order_packages_uq").on(t.projectId, t.kind, t.number),
    index("change_order_packages_prime_idx").on(t.primeContractId, t.status),
    index("change_order_packages_commitment_idx").on(t.commitmentId, t.status),
    index("change_order_packages_event_idx").on(t.changeEventId),
  ],
);

/**
 * The cost lines that travel the whole chain. One polymorphic table rather
 * than five near-identical ones, because a line is copied forward unchanged
 * from change event to PCO to COR to executed package, and the copy has to
 * keep its cost code, its quantity basis and its provenance. `parentType` +
 * `parentId` say which stage a row belongs to; `changeEventId` is
 * denormalized so the event's full cost rollup is one indexed scan.
 *
 * `costAmount` (what it costs us) and `revenueAmount` (what we bill) are
 * separate on every line. That is where margin on a change lives, and a
 * single `amount` column would hide it.
 */
export const changeLineItems = pgTable(
  "change_line_items",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    /** change_event | potential_change_order | change_quote_request |
     *  change_order_request | change_order_package | prime_contract_change |
     *  commitment_change */
    parentType: text("parent_type").notNull(),
    parentId: text("parent_id").notNull(),
    /** denormalized for the change-event rollup */
    changeEventId: text("change_event_id"),
    lineNumber: text("line_number"),
    sortOrder: integer("sort_order").default(0).notNull(),
    costCodeId: text("cost_code_id"),
    costCode: text("cost_code"),
    costType: text("cost_type"), // CostType
    budgetLineItemId: text("budget_line_item_id"),
    description: text("description").notNull(),
    unit: text("unit"),
    quantity: doublePrecision("quantity"),
    unitRate: doublePrecision("unit_rate"),
    /** what it costs us */
    costAmount: doublePrecision("cost_amount").default(0).notNull(),
    /** what we bill the owner — costAmount + markup, or a negotiated figure */
    revenueAmount: doublePrecision("revenue_amount").default(0).notNull(),
    markupKind: text("markup_kind"), // MarkupKind
    markupPercent: doublePrecision("markup_percent"),
    markupAmount: doublePrecision("markup_amount").default(0).notNull(),
    taxPercent: doublePrecision("tax_percent"),
    taxAmount: doublePrecision("tax_amount").default(0).notNull(),
    /** the sub quoting this line, when it came from an RFQ */
    vendorId: text("vendor_id"),
    /** SOV lines this will amend on execution */
    commitmentSovLineId: text("commitment_sov_line_id"),
    primeContractSovLineId: text("prime_contract_sov_line_id"),
    notes: text("notes"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("change_line_items_parent_idx").on(t.parentType, t.parentId, t.sortOrder),
    index("change_line_items_event_idx").on(t.changeEventId),
    index("change_line_items_budget_idx").on(t.budgetLineItemId),
    index("change_line_items_project_idx").on(t.projectId),
  ],
);

/* ------------------------------------------------------------------ */
/* Invoicing — billing in both directions                              */
/* ------------------------------------------------------------------ */

/**
 * The month, as an object. A billing period defines the window subs may
 * submit in, the date work is billed through, and when the owner application
 * goes out. Closing it stops new invoices; locking it freezes the numbers for
 * reporting, which is what makes a monthly cost report reproducible.
 */
export const billingPeriods = pgTable(
  "billing_periods",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    name: text("name").notNull(),
    status: text("status").default("open").notNull(), // BillingPeriodStatus
    startDate: text("start_date").notNull(), // ISO date
    endDate: text("end_date").notNull(), // ISO date
    /** the date work is billed THROUGH — the number every SOV line measures to */
    billingDate: text("billing_date").notNull(),
    /* the subcontractor submission window */
    subcontractorSubmitStart: text("subcontractor_submit_start"),
    subcontractorSubmitEnd: text("subcontractor_submit_end"),
    /** when the owner application for this period is due out */
    ownerBillingDate: text("owner_billing_date"),
    dueDate: text("due_date"),
    /* rollups over the period */
    ownerBilledAmount: doublePrecision("owner_billed_amount").default(0).notNull(),
    subcontractorBilledAmount: doublePrecision("subcontractor_billed_amount").default(0).notNull(),
    retainageHeldAmount: doublePrecision("retainage_held_amount").default(0).notNull(),
    retainageReleasedAmount: doublePrecision("retainage_released_amount").default(0).notNull(),
    invoiceCount: integer("invoice_count").default(0).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "string" }),
    closedBy: text("closed_by"),
    lockedAt: timestamp("locked_at", { withTimezone: true, mode: "string" }),
    lockedBy: text("locked_by"),
    notes: text("notes"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("billing_periods_uq").on(t.projectId, t.number),
    index("billing_periods_project_idx").on(t.projectId, t.status),
    index("billing_periods_date_idx").on(t.projectId, t.billingDate),
  ],
);

/**
 * One table, both directions. `kind = "owner_billing"` is our application to
 * the owner against a prime contract; `kind = "subcontractor_invoice"` is a
 * sub billing us against a commitment. They carry the same arithmetic because
 * they ARE the same arithmetic — the AIA G702 summary, materialized:
 *
 *   originalContractSum + netChangeOrders            = revisedContractSum
 *   completedToDate + storedMaterials                = totalCompletedAndStored
 *   retainageWork + retainageMaterials               = totalRetainage
 *   totalCompletedAndStored - totalRetainage         = totalEarnedLessRetainage
 *   totalEarnedLessRetainage - previousPaymentsAmount = currentPaymentDue
 *   revisedContractSum - totalEarnedLessRetainage    = balanceToFinishPlusRetainage
 *
 * Every one of those is stored rather than computed on read, because an
 * invoice is a legal document: it must say tomorrow exactly what it said the
 * day it was certified, even if a change order lands in between.
 *
 * `reviewedBy` and `approvedBy` are distinct from `submittedBy`. A sub cannot
 * approve their own invoice, and a PM's review is not the same act as the
 * controller's approval.
 */
export const invoices = pgTable(
  "invoices",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    kind: text("kind").notNull(), // InvoiceKind
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    title: text("title"),
    status: text("status").default("draft").notNull(), // InvoiceStatus
    /** owner_billing: set. subcontractor_invoice: the prime it rolls up to */
    primeContractId: text("prime_contract_id"),
    /** subcontractor_invoice: set */
    commitmentId: text("commitment_id"),
    vendorId: text("vendor_id"),
    billingPeriodId: text("billing_period_id"),
    /** the vendor's own invoice number, as printed on their document */
    invoiceNumber: text("invoice_number"),
    currency: text("currency").default("USD").notNull(),
    /* dates (ISO) */
    billingDate: text("billing_date"),
    periodStart: text("period_start"),
    periodEnd: text("period_end"),
    dueDate: text("due_date"),
    receivedDate: text("received_date"),
    /* G702 summary — frozen arithmetic */
    originalContractSum: doublePrecision("original_contract_sum").default(0).notNull(),
    netChangeOrders: doublePrecision("net_change_orders").default(0).notNull(),
    revisedContractSum: doublePrecision("revised_contract_sum").default(0).notNull(),
    completedToDate: doublePrecision("completed_to_date").default(0).notNull(),
    storedMaterials: doublePrecision("stored_materials").default(0).notNull(),
    totalCompletedAndStored: doublePrecision("total_completed_and_stored").default(0).notNull(),
    retainagePercentWork: doublePrecision("retainage_percent_work").default(0).notNull(),
    retainageWork: doublePrecision("retainage_work").default(0).notNull(),
    retainagePercentMaterials: doublePrecision("retainage_percent_materials").default(0).notNull(),
    retainageMaterials: doublePrecision("retainage_materials").default(0).notNull(),
    totalRetainage: doublePrecision("total_retainage").default(0).notNull(),
    retainageReleased: doublePrecision("retainage_released").default(0).notNull(),
    totalEarnedLessRetainage: doublePrecision("total_earned_less_retainage").default(0).notNull(),
    previousPaymentsAmount: doublePrecision("previous_payments_amount").default(0).notNull(),
    currentPaymentDue: doublePrecision("current_payment_due").default(0).notNull(),
    balanceToFinishPlusRetainage: doublePrecision("balance_to_finish_plus_retainage").default(0).notNull(),
    /* invoice totals (POs and non-SOV billing use these directly) */
    subtotal: doublePrecision("subtotal").default(0).notNull(),
    taxAmount: doublePrecision("tax_amount").default(0).notNull(),
    total: doublePrecision("total").default(0).notNull(),
    amountPaid: doublePrecision("amount_paid").default(0).notNull(),
    paidDate: text("paid_date"),
    /* review trail */
    reviewNotes: text("review_notes"),
    rejectionReason: text("rejection_reason"),
    /** payment is blocked until the waiver is received */
    requiresLienWaiver: integer("requires_lien_waiver").default(0).notNull(),
    lienWaiverStatus: text("lien_waiver_status"), // LienWaiverStatus
    documentIds: jsonb("document_ids").$type<string[]>().default([]).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    submittedBy: text("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "string" }),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "string" }),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("invoices_uq").on(t.projectId, t.kind, t.number),
    index("invoices_project_idx").on(t.projectId, t.status),
    index("invoices_commitment_idx").on(t.commitmentId, t.status),
    index("invoices_prime_idx").on(t.primeContractId, t.status),
    index("invoices_period_idx").on(t.billingPeriodId),
    index("invoices_vendor_idx").on(t.vendorId),
  ],
);

/**
 * The G703 continuation sheet, one row per SOV line being billed. Exactly one
 * of `primeContractSovLineId` / `commitmentSovLineId` is set, matching the
 * invoice kind. `previousBilled` is snapshotted at creation rather than
 * summed from prior invoices, so an invoice cannot be retroactively changed
 * by a later correction upstream.
 */
export const invoiceLineItems = pgTable(
  "invoice_line_items",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    invoiceId: text("invoice_id").notNull(),
    lineNumber: text("line_number").notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    /** exactly one is set, matching invoices.kind */
    primeContractSovLineId: text("prime_contract_sov_line_id"),
    commitmentSovLineId: text("commitment_sov_line_id"),
    costCodeId: text("cost_code_id"),
    costCode: text("cost_code"),
    costType: text("cost_type"),
    budgetLineItemId: text("budget_line_item_id"),
    description: text("description").notNull(),
    source: text("source").default("contract_sov").notNull(), // InvoiceLineSource
    billingMethod: text("billing_method").default("percent_complete").notNull(), // SovBillingMethod
    unit: text("unit"),
    quantity: doublePrecision("quantity"),
    unitRate: doublePrecision("unit_rate"),
    scheduledValue: doublePrecision("scheduled_value").default(0).notNull(),
    /** snapshotted at creation — the invoice must not drift afterwards */
    previousBilled: doublePrecision("previous_billed").default(0).notNull(),
    previousStoredMaterials: doublePrecision("previous_stored_materials").default(0).notNull(),
    thisPeriodWork: doublePrecision("this_period_work").default(0).notNull(),
    thisPeriodStoredMaterials: doublePrecision("this_period_stored_materials").default(0).notNull(),
    materialsPresentlyStored: doublePrecision("materials_presently_stored").default(0).notNull(),
    totalCompletedAndStored: doublePrecision("total_completed_and_stored").default(0).notNull(),
    percentComplete: doublePrecision("percent_complete").default(0).notNull(),
    balanceToFinish: doublePrecision("balance_to_finish").default(0).notNull(),
    retainagePercent: doublePrecision("retainage_percent").default(0).notNull(),
    retainageThisPeriod: doublePrecision("retainage_this_period").default(0).notNull(),
    retainageHeldToDate: doublePrecision("retainage_held_to_date").default(0).notNull(),
    retainageReleased: doublePrecision("retainage_released").default(0).notNull(),
    /** net billed this period after retainage */
    amount: doublePrecision("amount").default(0).notNull(),
    taxPercent: doublePrecision("tax_percent"),
    taxAmount: doublePrecision("tax_amount").default(0).notNull(),
    /** set when the line bills an executed change order rather than base scope */
    changeOrderPackageId: text("change_order_package_id"),
    notes: text("notes"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("invoice_line_items_uq").on(t.invoiceId, t.lineNumber),
    index("invoice_line_items_invoice_idx").on(t.invoiceId, t.sortOrder),
    index("invoice_line_items_prime_sov_idx").on(t.primeContractSovLineId),
    index("invoice_line_items_commitment_sov_idx").on(t.commitmentSovLineId),
    index("invoice_line_items_budget_idx").on(t.budgetLineItemId),
  ],
);

/**
 * The AIA G702 cover sheet as its own record: the certified application for
 * payment. Separate from the invoice because certification is a THIRD PARTY'S
 * act — the architect or owner's representative certifies an amount that may
 * be lower than what was applied for, and that certified figure is what
 * statutory payment timelines run from.
 *
 * `certifiedByContractorName` / `contractorCertifiedAt` capture the sworn
 * contractor's certification (the notarized half of a G702);
 * `certifiedBy` / `certifiedAt` / `certifiedAmount` capture the certifier's.
 * Two parties, two sets of columns, no ambiguity about who said what.
 */
export const paymentApplications = pgTable(
  "payment_applications",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    primeContractId: text("prime_contract_id").notNull(),
    /** the owner_billing invoice this certifies */
    invoiceId: text("invoice_id"),
    billingPeriodId: text("billing_period_id"),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    status: text("status").default("draft").notNull(), // PaymentApplicationStatus
    applicationDate: text("application_date"), // ISO date
    periodTo: text("period_to"), // ISO date work is certified through
    currency: text("currency").default("USD").notNull(),
    /* G702 cover-sheet figures, frozen */
    originalContractSum: doublePrecision("original_contract_sum").default(0).notNull(),
    netChangeOrders: doublePrecision("net_change_orders").default(0).notNull(),
    contractSumToDate: doublePrecision("contract_sum_to_date").default(0).notNull(),
    totalCompletedAndStored: doublePrecision("total_completed_and_stored").default(0).notNull(),
    totalRetainage: doublePrecision("total_retainage").default(0).notNull(),
    totalEarnedLessRetainage: doublePrecision("total_earned_less_retainage").default(0).notNull(),
    lessPreviousCertificates: doublePrecision("less_previous_certificates").default(0).notNull(),
    currentPaymentDue: doublePrecision("current_payment_due").default(0).notNull(),
    balanceToFinishPlusRetainage: doublePrecision("balance_to_finish_plus_retainage").default(0).notNull(),
    /* the contractor's sworn certification */
    certifiedByContractorName: text("certified_by_contractor_name"),
    contractorCertifiedAt: timestamp("contractor_certified_at", { withTimezone: true, mode: "string" }),
    notaryReference: text("notary_reference"),
    /* the certifier's determination — may be lower than applied for */
    architectVendorId: text("architect_vendor_id"),
    certifiedAmount: doublePrecision("certified_amount"),
    certificationNotes: text("certification_notes"),
    certifiedBy: text("certified_by"),
    certifiedAt: timestamp("certified_at", { withTimezone: true, mode: "string" }),
    /* settlement */
    paidAmount: doublePrecision("paid_amount").default(0).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true, mode: "string" }),
    paymentReference: text("payment_reference"),
    documentIds: jsonb("document_ids").$type<string[]>().default([]).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    submittedBy: text("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "string" }),
    rejectedBy: text("rejected_by"),
    rejectedAt: timestamp("rejected_at", { withTimezone: true, mode: "string" }),
    rejectionReason: text("rejection_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("payment_applications_uq").on(t.projectId, t.number),
    index("payment_applications_contract_idx").on(t.primeContractId, t.status),
    index("payment_applications_invoice_idx").on(t.invoiceId),
    index("payment_applications_period_idx").on(t.billingPeriodId),
  ],
);

/**
 * Releasing retainage — in either direction (`scope`). This is a record, not a
 * calculation, because retainage release is an approval event with money
 * attached: someone asks, someone else agrees, and only then does the held
 * balance move. `retainageHeldBefore` / `retainageHeldAfter` bracket the
 * change so the release is self-auditing.
 *
 * `newRetainagePercent` supports the common step-down clause — 10% held until
 * 50% complete, 5% thereafter — where the release is a rate change rather
 * than a lump sum.
 */
export const retainageReleases = pgTable(
  "retainage_releases",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    scope: text("scope").notNull(), // RetainageScope
    /** set according to scope */
    primeContractId: text("prime_contract_id"),
    commitmentId: text("commitment_id"),
    vendorId: text("vendor_id"),
    invoiceId: text("invoice_id"),
    billingPeriodId: text("billing_period_id"),
    status: text("status").default("draft").notNull(), // RetainageReleaseStatus
    basis: text("basis").default("percent_work_completed").notNull(), // RetainageBasis
    retainageHeldBefore: doublePrecision("retainage_held_before").default(0).notNull(),
    amount: doublePrecision("amount").default(0).notNull(),
    retainageHeldAfter: doublePrecision("retainage_held_after").default(0).notNull(),
    /** step-down clause: the rate applying to future billings */
    newRetainagePercent: doublePrecision("new_retainage_percent"),
    /** per-SOV-line allocation: [{ sovLineId, costCode, amount }] */
    lines: jsonb("lines").$type<unknown[]>().default([]).notNull(),
    effectiveDate: text("effective_date"), // ISO date
    releaseDate: text("release_date"),
    reason: text("reason"),
    /** conditions that must hold before the money moves */
    conditions: text("conditions"),
    requiresLienWaiver: integer("requires_lien_waiver").default(0).notNull(),
    lienWaiverId: text("lien_waiver_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    requestedBy: text("requested_by"),
    requestedAt: timestamp("requested_at", { withTimezone: true, mode: "string" }),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    rejectedBy: text("rejected_by"),
    rejectedAt: timestamp("rejected_at", { withTimezone: true, mode: "string" }),
    rejectionReason: text("rejection_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("retainage_releases_uq").on(t.projectId, t.number),
    index("retainage_releases_commitment_idx").on(t.commitmentId, t.status),
    index("retainage_releases_prime_idx").on(t.primeContractId, t.status),
    index("retainage_releases_project_idx").on(t.projectId, t.status),
  ],
);

/**
 * Lien waivers. `waiverType` and `throughDate` are the two legally decisive
 * fields on the document and neither is ever inferred: an UNCONDITIONAL
 * waiver takes effect on signature whether or not the money arrives, and the
 * "through" date fixes exactly which work is waived. Getting either wrong
 * costs a subcontractor their lien rights, which is why both are required
 * columns rather than free text inside a PDF.
 *
 * `tier` records how far down the chain the waiver reaches — a general
 * contractor collecting only from direct subs while second-tier suppliers go
 * unwaived is the classic route to a lien on a paid-in-full project.
 *
 * The lifecycle is a chain of custody: requested -> sent -> signed ->
 * received -> verified, each with its own actor and timestamp, because
 * "we have it somewhere" is not a defence.
 */
export const lienWaivers = pgTable(
  "lien_waivers",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    waiverType: text("waiver_type").notNull(), // LienWaiverType
    status: text("status").default("draft").notNull(), // LienWaiverStatus
    commitmentId: text("commitment_id"),
    invoiceId: text("invoice_id"),
    /** commitment_payments.id this waiver is conditioned on */
    paymentId: text("payment_id"),
    billingPeriodId: text("billing_period_id"),
    vendorId: text("vendor_id"),
    vendorContactId: text("vendor_contact_id"),
    /** 1 = direct subcontractor, 2 = their supplier, and so on down */
    tier: integer("tier").default(1).notNull(),
    claimantName: text("claimant_name"),
    claimantAddress: text("claimant_address"),
    /** the amount the waiver covers */
    amount: doublePrecision("amount").default(0).notNull(),
    currency: text("currency").default("USD").notNull(),
    /** work performed through this date is waived — legally decisive */
    throughDate: text("through_date"), // ISO date
    /** disputed amounts expressly NOT waived */
    exceptionsNoted: text("exceptions_noted"),
    /** the statutory form depends on where the project sits */
    jurisdiction: text("jurisdiction"),
    statutoryForm: text("statutory_form"),
    /* chain of custody */
    requestedBy: text("requested_by"),
    requestedAt: timestamp("requested_at", { withTimezone: true, mode: "string" }),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "string" }),
    signedAt: timestamp("signed_at", { withTimezone: true, mode: "string" }),
    signedByName: text("signed_by_name"),
    signatureMethod: text("signature_method"), // wet_ink | e_signature | notarized
    signatureReference: text("signature_reference"),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "string" }),
    receivedBy: text("received_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" }),
    verifiedBy: text("verified_by"),
    rejectionReason: text("rejection_reason"),
    documentId: text("document_id"),
    notes: text("notes"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("lien_waivers_uq").on(t.projectId, t.number),
    index("lien_waivers_commitment_idx").on(t.commitmentId, t.status),
    index("lien_waivers_invoice_idx").on(t.invoiceId),
    index("lien_waivers_vendor_idx").on(t.vendorId, t.status),
    index("lien_waivers_through_idx").on(t.projectId, t.throughDate),
  ],
);
