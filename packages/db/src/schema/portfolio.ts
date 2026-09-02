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
 * Owner / portfolio workspace and commercial structures.
 * Spec Vol I §7 (#776–789), Vol II Domain G (#423–434), Domain Z (#1053–1066).
 *
 * The grouping of projects into portfolios already exists (`portfolios` and
 * `projects.portfolio_id` in core.ts, owned by the projects module); nothing
 * here duplicates it. What lives here is everything an OWNER needs on top of
 * that grouping:
 *
 *   money authority   funding sources → multi-year appropriations →
 *                     per-project allocations, with capital/revenue
 *                     classification, carry-forward and virement control
 *   affordability     an envelope per fiscal year that portfolio demand is
 *                     measured against
 *   prioritisation    an MCDA model (criteria + weights) and the scores that
 *                     rank projects under it
 *   buying structures frameworks → lots → appointed suppliers →
 *                     mini-competitions → call-off orders; term contracts
 *                     with a schedule of rates and measured term orders
 *   sharing structures joint ventures / consortia / SPVs / alliances with
 *                     partner shares, contributions, distributions and deed
 *                     governance; target-cost pain/gain share
 *   verification      open-book verification of defined cost against the
 *                     Schedule of Cost Components, the disallowed cost
 *                     register and the audit-rights execution log
 *
 * Currency discipline: every money column carries a sibling `currency`, and
 * nothing in this area ever sums across currencies — the roll-up engine
 * buckets and returns a reason instead of a total.
 */

/* ================================================================== */
/* Funding, appropriation, affordability (#426–#434, #779–#780)        */
/* ================================================================== */

/**
 * A facility the owner may spend from (#427, #779). Company-scoped and
 * optionally attached to one portfolio; a source with no portfolio is
 * available to the whole company.
 */
export const portfolioFundingSources = pgTable(
  "portfolio_funding_sources",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** portfolios.id — null means company-wide */
    portfolioId: text("portfolio_id"),
    reference: text("reference"),
    name: text("name").notNull(),
    kind: text("kind").notNull(), // PortfolioFundingSourceKind
    provider: text("provider"),
    currency: text("currency").notNull(),
    /** the size of the facility in its own currency */
    amount: doublePrecision("amount").default(0).notNull(),
    availableFrom: text("available_from"), // ISO date
    availableTo: text("available_to"),
    status: text("status").default("proposed").notNull(), // PortfolioFundingSourceStatus
    /** default expenditure classification for allocations from this source */
    expenditureClass: text("expenditure_class").default("capital").notNull(),
    /** grant conditions to be complied with (#432): [{ id, text, dueDate?, obligationId?, met }] */
    conditions: jsonb("conditions").$type<unknown[]>().default([]).notNull(),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("portfolio_funding_sources_company_idx").on(t.companyId, t.status),
    index("portfolio_funding_sources_portfolio_idx").on(t.companyId, t.portfolioId),
    index("portfolio_funding_sources_currency_idx").on(t.companyId, t.currency),
  ],
);

/**
 * A multi-year appropriation: money authorised for a fiscal year (#428–#429,
 * #433). Carry-forward is explicit — an appropriation names the one it was
 * carried forward FROM, so the chain across years is auditable rather than
 * inferred from arithmetic.
 */
export const portfolioAppropriations = pgTable(
  "portfolio_appropriations",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    portfolioId: text("portfolio_id"),
    fundingSourceId: text("funding_source_id"),
    /** the fiscal year label as the owner writes it, e.g. "2026/27" */
    fiscalYear: text("fiscal_year").notNull(),
    periodStart: text("period_start"), // ISO date
    periodEnd: text("period_end"),
    name: text("name").notNull(),
    currency: text("currency").notNull(),
    /** the sum authorised for this year, excluding anything carried in */
    appropriatedAmount: doublePrecision("appropriated_amount").default(0).notNull(),
    /** balance brought in from the prior year's appropriation */
    carriedForwardIn: doublePrecision("carried_forward_in").default(0).notNull(),
    /** balance released to the next year when this one closed */
    carriedForwardOut: doublePrecision("carried_forward_out").default(0).notNull(),
    /** net effect of approved virements: positive = received, negative = given */
    virementNet: doublePrecision("virement_net").default(0).notNull(),
    expenditureClass: text("expenditure_class").default("capital").notNull(),
    carryForwardPolicy: text("carry_forward_policy").default("request").notNull(),
    status: text("status").default("draft").notNull(), // PortfolioAppropriationStatus
    /** the appropriation this one's carried_forward_in came from */
    carriedForwardFromId: text("carried_forward_from_id"),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "string" }),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("portfolio_appropriations_company_idx").on(t.companyId, t.fiscalYear, t.status),
    index("portfolio_appropriations_source_idx").on(t.companyId, t.fundingSourceId),
    index("portfolio_appropriations_portfolio_idx").on(t.companyId, t.portfolioId),
    index("portfolio_appropriations_carry_idx").on(t.carriedForwardFromId),
  ],
);

/**
 * Recorded movements of authority between appropriations (#433). Kept as
 * rows rather than folded into `virementNet` alone so that "who moved what,
 * when, under whose approval" survives.
 */
export const portfolioVirements = pgTable(
  "portfolio_virements",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    fromAppropriationId: text("from_appropriation_id").notNull(),
    toAppropriationId: text("to_appropriation_id").notNull(),
    currency: text("currency").notNull(),
    amount: doublePrecision("amount").default(0).notNull(),
    reason: text("reason").notNull(),
    status: text("status").default("proposed").notNull(), // PortfolioVirementStatus
    requestedBy: text("requested_by").notNull(),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "string" }),
    decisionNote: text("decision_note"),
    createdAt: createdAt(),
  },
  (t) => [
    index("portfolio_virements_company_idx").on(t.companyId, t.status),
    index("portfolio_virements_from_idx").on(t.fromAppropriationId),
    index("portfolio_virements_to_idx").on(t.toAppropriationId),
  ],
);

/** Allocation of an appropriation / funding source to one project (#427, #779). */
export const portfolioAllocations = pgTable(
  "portfolio_allocations",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    fundingSourceId: text("funding_source_id"),
    appropriationId: text("appropriation_id"),
    fiscalYear: text("fiscal_year"),
    currency: text("currency").notNull(),
    amount: doublePrecision("amount").default(0).notNull(),
    /** drawn against the allocation to date, recorded by the owner */
    drawnAmount: doublePrecision("drawn_amount").default(0).notNull(),
    expenditureClass: text("expenditure_class").default("capital").notNull(),
    status: text("status").default("planned").notNull(), // PortfolioAllocationStatus
    /** whole-life cost committed at approval (#434), in the same currency */
    wholeLifeCost: doublePrecision("whole_life_cost"),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("portfolio_allocations_company_idx").on(t.companyId, t.status),
    index("portfolio_allocations_project_idx").on(t.companyId, t.projectId),
    index("portfolio_allocations_source_idx").on(t.companyId, t.fundingSourceId),
    index("portfolio_allocations_appropriation_idx").on(t.appropriationId),
    index("portfolio_allocations_year_idx").on(t.companyId, t.fiscalYear),
  ],
);

/**
 * The affordability envelope a fiscal year's portfolio demand is measured
 * against (#426). One active envelope per (portfolio, fiscal year, currency)
 * — superseding one writes a new row and marks the old `superseded`, so the
 * ceiling that a past decision was taken against is still readable.
 */
export const portfolioEnvelopes = pgTable(
  "portfolio_envelopes",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    portfolioId: text("portfolio_id"),
    name: text("name").notNull(),
    fiscalYear: text("fiscal_year").notNull(),
    currency: text("currency").notNull(),
    envelopeAmount: doublePrecision("envelope_amount").default(0).notNull(),
    /** how the ceiling was arrived at — cited, not asserted */
    basis: text("basis"),
    expenditureClass: text("expenditure_class").default("capital").notNull(),
    status: text("status").default("draft").notNull(), // PortfolioEnvelopeStatus
    supersededById: text("superseded_by_id"),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("portfolio_envelopes_company_idx").on(t.companyId, t.fiscalYear, t.status),
    index("portfolio_envelopes_portfolio_idx").on(t.companyId, t.portfolioId),
  ],
);

/* ================================================================== */
/* Prioritisation / MCDA (#424–#425)                                   */
/* ================================================================== */

/**
 * A multi-criteria decision analysis model (#425): the criteria, their
 * weights and their direction. Weights are stored as given and normalised at
 * scoring time, so an owner may enter 1–5 importance values or percentages
 * without either being wrong.
 */
export const portfolioScoringModels = pgTable(
  "portfolio_scoring_models",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    portfolioId: text("portfolio_id"),
    name: text("name").notNull(),
    description: text("description"),
    /**
     * criteria: [{ key, label, description?, weight, direction, min, max }]
     * `direction` is benefit|cost; min/max bound the raw entry scale.
     */
    criteria: jsonb("criteria").$type<unknown[]>().default([]).notNull(),
    normalisation: text("normalisation").default("fixed_scale").notNull(),
    status: text("status").default("draft").notNull(), // PortfolioScoringModelStatus
    version: integer("version").default(1).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("portfolio_scoring_models_company_idx").on(t.companyId, t.status),
    index("portfolio_scoring_models_portfolio_idx").on(t.companyId, t.portfolioId),
  ],
);

/**
 * One project's raw scores under a model (#424). The ranked list is computed
 * from these on demand — a stored rank goes stale the moment another project
 * is scored, and a stale rank is worse than no rank.
 */
export const portfolioScores = pgTable(
  "portfolio_scores",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    modelId: text("model_id").notNull(),
    projectId: text("project_id").notNull(),
    /** raw per-criterion entries: { [criterionKey]: number } */
    scores: jsonb("scores").$type<Record<string, number>>().default({}).notNull(),
    /** per-criterion justification: { [criterionKey]: string } */
    rationale: jsonb("rationale").$type<Record<string, string>>().default({}).notNull(),
    notes: text("notes"),
    scoredBy: text("scored_by").notNull(),
    scoredAt: timestamp("scored_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("portfolio_scores_uq").on(t.modelId, t.projectId),
    index("portfolio_scores_company_idx").on(t.companyId, t.modelId),
    index("portfolio_scores_project_idx").on(t.companyId, t.projectId),
  ],
);

/* ================================================================== */
/* Frameworks, lots, mini-competitions, call-offs (#1053–#1056)        */
/* ================================================================== */

/** A framework agreement the owner may call work off (#1053). */
export const frameworkAgreements = pgTable(
  "framework_agreements",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    portfolioId: text("portfolio_id"),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    /** the buying authority when the framework is someone else's to call off */
    contractingAuthority: text("contracting_authority"),
    startDate: text("start_date"), // ISO date
    endDate: text("end_date"),
    /** optional extension the owner may exercise */
    extensionToDate: text("extension_to_date"),
    currency: text("currency").notNull(),
    /** ceiling across the whole framework; null = uncapped, which is stated, not assumed */
    maximumValue: doublePrecision("maximum_value"),
    awardMode: text("award_mode").default("mini_competition").notNull(), // FrameworkAwardMode
    /** direct award permitted up to this value (per the framework rules) */
    directAwardThreshold: doublePrecision("direct_award_threshold"),
    status: text("status").default("draft").notNull(), // FrameworkStatus
    rulesReference: text("rules_reference"),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("framework_agreements_uq").on(t.companyId, t.reference),
    index("framework_agreements_company_idx").on(t.companyId, t.status),
    index("framework_agreements_end_idx").on(t.companyId, t.status, t.endDate),
  ],
);

/** A lot within a framework — its own ceiling and its own supplier list. */
export const frameworkLots = pgTable(
  "framework_lots",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    frameworkId: text("framework_id").notNull(),
    lotNumber: text("lot_number").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    currency: text("currency").notNull(),
    ceilingValue: doublePrecision("ceiling_value"),
    awardMode: text("award_mode"), // overrides the framework's mode when set
    status: text("status").default("live").notNull(), // FrameworkStatus
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("framework_lots_uq").on(t.frameworkId, t.lotNumber),
    index("framework_lots_company_idx").on(t.companyId, t.frameworkId),
  ],
);

/** Suppliers appointed to a framework (optionally to one lot), with rank. */
export const frameworkSuppliers = pgTable(
  "framework_suppliers",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    frameworkId: text("framework_id").notNull(),
    /** null = appointed to the whole framework */
    lotId: text("lot_id"),
    vendorId: text("vendor_id"),
    supplierName: text("supplier_name").notNull(),
    /** cascade position; 1 = first-ranked for direct award */
    rank: integer("rank"),
    status: text("status").default("appointed").notNull(), // FrameworkSupplierStatus
    appointedAt: text("appointed_at"), // ISO date
    suspendedReason: text("suspended_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("framework_suppliers_framework_idx").on(t.companyId, t.frameworkId, t.status),
    index("framework_suppliers_lot_idx").on(t.lotId),
    index("framework_suppliers_vendor_idx").on(t.companyId, t.vendorId),
  ],
);

/** A mini-competition run within a lot (#1054). */
export const frameworkMiniCompetitions = pgTable(
  "framework_mini_competitions",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    frameworkId: text("framework_id").notNull(),
    lotId: text("lot_id"),
    /** the project the work is for, when it is known at competition time */
    projectId: text("project_id"),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    scope: text("scope"),
    currency: text("currency").notNull(),
    estimatedValue: doublePrecision("estimated_value"),
    /** invited framework_suppliers.id list */
    invitedSupplierIds: jsonb("invited_supplier_ids").$type<string[]>().default([]).notNull(),
    /** evaluation criteria: [{ key, label, weight }] */
    evaluationCriteria: jsonb("evaluation_criteria").$type<unknown[]>().default([]).notNull(),
    /** responses: [{ supplierId, supplierName, price, scores?, submittedAt?, withdrawn? }] */
    responses: jsonb("responses").$type<unknown[]>().default([]).notNull(),
    issuedAt: text("issued_at"), // ISO date
    responsesDueAt: text("responses_due_at"),
    status: text("status").default("draft").notNull(), // MiniCompetitionStatus
    awardedSupplierId: text("awarded_supplier_id"),
    awardedSupplierName: text("awarded_supplier_name"),
    awardValue: doublePrecision("award_value"),
    awardedAt: timestamp("awarded_at", { withTimezone: true, mode: "string" }),
    awardedBy: text("awarded_by"),
    decisionNote: text("decision_note"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("framework_mini_competitions_uq").on(t.companyId, t.reference),
    index("framework_mini_competitions_framework_idx").on(t.companyId, t.frameworkId, t.status),
    index("framework_mini_competitions_project_idx").on(t.companyId, t.projectId),
    index("framework_mini_competitions_due_idx").on(t.companyId, t.status, t.responsesDueAt),
  ],
);

/**
 * A term contract with a schedule of rates (#1055). Measured term orders
 * (#1056) are call-offs whose route is `measured_term` and whose lines price
 * against this contract's rates.
 */
export const termContracts = pgTable(
  "term_contracts",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    portfolioId: text("portfolio_id"),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    vendorId: text("vendor_id"),
    supplierName: text("supplier_name").notNull(),
    currency: text("currency").notNull(),
    startDate: text("start_date"),
    endDate: text("end_date"),
    maximumValue: doublePrecision("maximum_value"),
    /** contractor's percentage addition to schedule rates, +/- */
    adjustmentPercent: doublePrecision("adjustment_percent").default(0).notNull(),
    adjustmentBasis: text("adjustment_basis").default("none").notNull(),
    indexReference: text("index_reference"),
    priceBaseDate: text("price_base_date"),
    status: text("status").default("draft").notNull(), // TermContractStatus
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("term_contracts_uq").on(t.companyId, t.reference),
    index("term_contracts_company_idx").on(t.companyId, t.status),
    index("term_contracts_vendor_idx").on(t.companyId, t.vendorId),
  ],
);

/** One priced item in a term contract's schedule of rates (#1055). */
export const scheduleOfRatesItems = pgTable(
  "schedule_of_rates_items",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    termContractId: text("term_contract_id").notNull(),
    code: text("code").notNull(),
    description: text("description").notNull(),
    category: text("category"),
    unit: text("unit").notNull(),
    currency: text("currency").notNull(),
    rate: doublePrecision("rate").default(0).notNull(),
    active: integer("active").default(1).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("schedule_of_rates_items_uq").on(t.termContractId, t.code),
    index("schedule_of_rates_items_contract_idx").on(t.companyId, t.termContractId, t.active),
  ],
);

/**
 * A call-off order (#1053, #1056). Project-scoped: a call-off buys work for
 * a project, and that is the scope the tool gate resolves against.
 */
export const callOffOrders = pgTable(
  "call_off_orders",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    scope: text("scope"),
    route: text("route").default("direct_award").notNull(), // CallOffRoute
    frameworkId: text("framework_id"),
    lotId: text("lot_id"),
    miniCompetitionId: text("mini_competition_id"),
    termContractId: text("term_contract_id"),
    vendorId: text("vendor_id"),
    supplierName: text("supplier_name").notNull(),
    currency: text("currency").notNull(),
    orderValue: doublePrecision("order_value").default(0).notNull(),
    /** value certified against the order to date */
    certifiedValue: doublePrecision("certified_value").default(0).notNull(),
    /** measured term orders: [{ sorItemId?, code, description, unit, quantity, rate, amount }] */
    lines: jsonb("lines").$type<unknown[]>().default([]).notNull(),
    /** commitments.id when the call-off was pushed into the commitment ledger */
    commitmentId: text("commitment_id"),
    status: text("status").default("draft").notNull(), // CallOffStatus
    issuedAt: text("issued_at"), // ISO date
    requiredBy: text("required_by"),
    completedAt: text("completed_at"),
    /** why a direct award was permissible, when the route is direct_award */
    justification: text("justification"),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("call_off_orders_uq").on(t.projectId, t.number),
    index("call_off_orders_project_idx").on(t.companyId, t.projectId, t.status),
    index("call_off_orders_framework_idx").on(t.companyId, t.frameworkId),
    index("call_off_orders_lot_idx").on(t.lotId),
    index("call_off_orders_term_idx").on(t.companyId, t.termContractId),
    index("call_off_orders_vendor_idx").on(t.companyId, t.vendorId),
  ],
);

/* ================================================================== */
/* Joint ventures, consortia, SPVs, alliances (#1057–#1060)            */
/* ================================================================== */

/** The venture itself (#1057, #1060). Project-scoped when it delivers one project. */
export const jointVentures = pgTable(
  "joint_ventures",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** null when the venture spans a programme rather than one project */
    projectId: text("project_id"),
    name: text("name").notNull(),
    structure: text("structure").default("joint_venture").notNull(), // JvStructure
    currency: text("currency").notNull(),
    formationDate: text("formation_date"), // ISO date
    endDate: text("end_date"),
    deedReference: text("deed_reference"),
    registeredNumber: text("registered_number"),
    jurisdiction: text("jurisdiction"),
    /** percentage of partner shares required for a board decision to be quorate */
    quorumPercent: doublePrecision("quorum_percent"),
    /** percentage required to carry a reserved matter (often unanimity) */
    reservedMatterThresholdPercent: doublePrecision("reserved_matter_threshold_percent"),
    status: text("status").default("forming").notNull(), // JvStatus
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("joint_ventures_company_idx").on(t.companyId, t.status),
    index("joint_ventures_project_idx").on(t.companyId, t.projectId),
  ],
);

/** A partner and its share (#1057). Shares are validated to total 100%. */
export const jvPartners = pgTable(
  "jv_partners",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    jvId: text("jv_id").notNull(),
    name: text("name").notNull(),
    /** entities.id (assurance mirror) when the partner has been screened */
    entityId: text("entity_id"),
    vendorId: text("vendor_id"),
    role: text("role").default("partner").notNull(), // JvPartnerRole
    sharePercent: doublePrecision("share_percent").default(0).notNull(),
    /** committed equity / capital in the venture currency */
    committedCapital: doublePrecision("committed_capital"),
    liabilityBasis: text("liability_basis").default("joint_and_several").notNull(),
    /** true for the tenant's own participation, so "our share" is computable */
    isSelf: integer("is_self").default(0).notNull(),
    boardSeats: integer("board_seats"),
    status: text("status").default("active").notNull(),
    joinedAt: text("joined_at"),
    leftAt: text("left_at"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("jv_partners_jv_idx").on(t.companyId, t.jvId),
    index("jv_partners_entity_idx").on(t.companyId, t.entityId),
  ],
);

/** Contributions, calls and distributions between partner and venture (#1059). */
export const jvTransactions = pgTable(
  "jv_transactions",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    jvId: text("jv_id").notNull(),
    partnerId: text("partner_id").notNull(),
    kind: text("kind").notNull(), // JvTransactionKind
    currency: text("currency").notNull(),
    amount: doublePrecision("amount").default(0).notNull(),
    dueDate: text("due_date"), // ISO date
    settledDate: text("settled_date"),
    status: text("status").default("planned").notNull(), // JvTransactionStatus
    reference: text("reference"),
    /** obligations.id raised for a called-but-unpaid contribution */
    obligationId: text("obligation_id"),
    description: text("description"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("jv_transactions_jv_idx").on(t.companyId, t.jvId, t.status),
    index("jv_transactions_partner_idx").on(t.partnerId),
    index("jv_transactions_due_idx").on(t.companyId, t.status, t.dueDate),
  ],
);

/** Board / deed governance decisions and their compliance (#1058). */
export const jvDecisions = pgTable(
  "jv_decisions",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    jvId: text("jv_id").notNull(),
    reference: text("reference"),
    decisionType: text("decision_type").default("ordinary").notNull(), // JvDecisionType
    meetingDate: text("meeting_date").notNull(), // ISO date
    subject: text("subject").notNull(),
    narrative: text("narrative"),
    /** deed clause the matter is reserved under, when it is reserved */
    deedClause: text("deed_clause"),
    /** votes: [{ partnerId, sharePercent, vote: for|against|abstain }] */
    votes: jsonb("votes").$type<unknown[]>().default([]).notNull(),
    sharePresentPercent: doublePrecision("share_present_percent"),
    shareForPercent: doublePrecision("share_for_percent"),
    quorumMet: integer("quorum_met").default(0).notNull(),
    thresholdMet: integer("threshold_met").default(0).notNull(),
    outcome: text("outcome").default("deferred").notNull(), // JvDecisionOutcome
    /** obligations.id raised for an action the decision imposes */
    obligationId: text("obligation_id"),
    recordedBy: text("recorded_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("jv_decisions_jv_idx").on(t.companyId, t.jvId, t.meetingDate),
    index("jv_decisions_outcome_idx").on(t.companyId, t.outcome),
  ],
);

/* ================================================================== */
/* Target cost / pain-gain / alliance (#1061–#1062)                    */
/* ================================================================== */

/**
 * A target-cost or alliance commercial model on one project (#1061–#1062).
 * The share bands are stored as given; the calculation engine
 * (modules/portfolio/paingain.ts) is pure and every run is snapshotted.
 */
export const targetCostContracts = pgTable(
  "target_cost_contracts",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    contractReference: text("contract_reference"),
    /** true when the model is a multi-party alliance rather than a two-party target cost */
    isAlliance: integer("is_alliance").default(0).notNull(),
    currency: text("currency").notNull(),
    /** the original target */
    baseTargetCost: doublePrecision("base_target_cost").default(0).notNull(),
    /** net of agreed compensation events / target adjustments */
    targetAdjustments: doublePrecision("target_adjustments").default(0).notNull(),
    /** defined cost incurred to date (open-book verified where possible) */
    actualDefinedCost: doublePrecision("actual_defined_cost").default(0).notNull(),
    /** forecast defined cost at completion */
    forecastDefinedCost: doublePrecision("forecast_defined_cost"),
    /** the contractor's fee, expressed as a percentage of defined cost */
    feePercent: doublePrecision("fee_percent").default(0).notNull(),
    mechanism: text("mechanism").default("banded_share").notNull(), // PainGainMechanism
    /**
     * bands: [{ fromPercent, toPercent|null, contractorSharePercent }]
     * expressed as a percentage of the target; negative `fromPercent` is the
     * gain side. For flat/capped mechanisms one band suffices.
     */
    shareBands: jsonb("share_bands").$type<unknown[]>().default([]).notNull(),
    /** maximum contractor pain exposure, in currency; null = uncapped */
    painCap: doublePrecision("pain_cap"),
    gainCap: doublePrecision("gain_cap"),
    /**
     * alliance participants: [{ name, partyId?, sharePercent }] — how the
     * contractor side of pain/gain divides between alliance members.
     */
    participants: jsonb("participants").$type<unknown[]>().default([]).notNull(),
    status: text("status").default("draft").notNull(), // TargetCostStatus
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("target_cost_contracts_project_idx").on(t.companyId, t.projectId, t.status),
  ],
);

/** A frozen pain/gain run: inputs, outputs and who asked for it (#1062). */
export const painGainCalculations = pgTable(
  "pain_gain_calculations",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    targetCostId: text("target_cost_id").notNull(),
    basis: text("basis").default("forecast").notNull(), // forecast | actual
    currency: text("currency").notNull(),
    adjustedTarget: doublePrecision("adjusted_target").default(0).notNull(),
    outturnCost: doublePrecision("outturn_cost").default(0).notNull(),
    variance: doublePrecision("variance").default(0).notNull(),
    contractorShare: doublePrecision("contractor_share").default(0).notNull(),
    clientShare: doublePrecision("client_share").default(0).notNull(),
    /** the whole computation: bands applied, caps hit, participant splits */
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    computedBy: text("computed_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("pain_gain_calculations_target_idx").on(t.companyId, t.targetCostId),
    index("pain_gain_calculations_project_idx").on(t.companyId, t.projectId),
  ],
);

/* ================================================================== */
/* Open-book verification, defined cost, disallowed cost (#1063–#1066) */
/* ================================================================== */

/** One open-book verification exercise over a period (#1063). */
export const openBookVerifications = pgTable(
  "open_book_verifications",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    targetCostId: text("target_cost_id"),
    periodStart: text("period_start"), // ISO date
    periodEnd: text("period_end"),
    currency: text("currency").notNull(),
    /** what the contractor claimed for the period */
    claimedAmount: doublePrecision("claimed_amount").default(0).notNull(),
    /* recomputed from defined_cost_items on every item change */
    verifiedAmount: doublePrecision("verified_amount").default(0).notNull(),
    queriedAmount: doublePrecision("queried_amount").default(0).notNull(),
    disallowedAmount: doublePrecision("disallowed_amount").default(0).notNull(),
    pendingAmount: doublePrecision("pending_amount").default(0).notNull(),
    totalsCalculatedAt: timestamp("totals_calculated_at", { withTimezone: true, mode: "string" }),
    /** the contract clause the exercise is carried out under */
    auditRightsClause: text("audit_rights_clause"),
    /** how the SoCC headings on this contract map onto DEFINED_COST_COMPONENTS */
    componentMapping: jsonb("component_mapping").$type<Record<string, string>>().default({}).notNull(),
    methodology: text("methodology"),
    /** sampling: { basis, populationCount, sampleCount, confidence } */
    sampling: jsonb("sampling").$type<Record<string, unknown>>().default({}).notNull(),
    verifierId: text("verifier_id"),
    verifierName: text("verifier_name"),
    plannedAt: text("planned_at"), // ISO date the exercise is due to start
    status: text("status").default("planned").notNull(), // OpenBookStatus
    reportedAt: timestamp("reported_at", { withTimezone: true, mode: "string" }),
    findings: text("findings"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("open_book_verifications_uq").on(t.projectId, t.number),
    index("open_book_verifications_project_idx").on(t.companyId, t.projectId, t.status),
    index("open_book_verifications_planned_idx").on(t.companyId, t.status, t.plannedAt),
  ],
);

/** A claimed cost item tested against the Schedule of Cost Components (#1065). */
export const definedCostItems = pgTable(
  "defined_cost_items",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    verificationId: text("verification_id").notNull(),
    component: text("component").notNull(), // DefinedCostComponent
    /** the contract's own SoCC heading, when it differs from the component */
    contractHeading: text("contract_heading"),
    description: text("description").notNull(),
    currency: text("currency").notNull(),
    claimedAmount: doublePrecision("claimed_amount").default(0).notNull(),
    verifiedAmount: doublePrecision("verified_amount").default(0).notNull(),
    verdict: text("verdict").default("pending").notNull(), // DefinedCostVerdict
    /** what the verifier looked at */
    evidenceRef: text("evidence_ref"),
    /** documents.id / evidence.id when the record is on the platform */
    evidenceId: text("evidence_id"),
    sourceType: text("source_type"), // invoice | timecard | commitment | manual …
    sourceId: text("source_id"),
    verifierNote: text("verifier_note"),
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" }),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("defined_cost_items_verification_idx").on(t.companyId, t.verificationId, t.verdict),
    index("defined_cost_items_project_idx").on(t.companyId, t.projectId),
    index("defined_cost_items_component_idx").on(t.companyId, t.verificationId, t.component),
  ],
);

/** The disallowed cost register (#1066). */
export const disallowedCosts = pgTable(
  "disallowed_costs",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    verificationId: text("verification_id"),
    definedCostItemId: text("defined_cost_item_id"),
    description: text("description").notNull(),
    category: text("category").notNull(), // DisallowedCostCategory
    /** the contract clause relied on — a disallowance without a ground is an opinion */
    groundClause: text("ground_clause"),
    currency: text("currency").notNull(),
    amount: doublePrecision("amount").default(0).notNull(),
    /** amount actually deducted once the disallowance was settled */
    deductedAmount: doublePrecision("deducted_amount").default(0).notNull(),
    status: text("status").default("raised").notNull(), // DisallowedCostStatus
    raisedBy: text("raised_by").notNull(),
    raisedAt: text("raised_at").notNull(), // ISO date
    /** the contractor's answer, if any */
    responseDueAt: text("response_due_at"),
    contractorResponse: text("contractor_response"),
    respondedAt: timestamp("responded_at", { withTimezone: true, mode: "string" }),
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "string" }),
    resolutionNote: text("resolution_note"),
    /** obligations.id for the contractor's response deadline */
    obligationId: text("obligation_id"),
    /** where the deduction landed: invoice / payment / commitment change */
    deductionRefType: text("deduction_ref_type"),
    deductionRefId: text("deduction_ref_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("disallowed_costs_uq").on(t.projectId, t.number),
    index("disallowed_costs_project_idx").on(t.companyId, t.projectId, t.status),
    index("disallowed_costs_verification_idx").on(t.verificationId),
    index("disallowed_costs_response_idx").on(t.companyId, t.status, t.responseDueAt),
  ],
);

/** The audit-rights execution log (#1064): notice, access, records, obstruction. */
export const auditRightsExecutions = pgTable(
  "audit_rights_executions",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** null for a company-wide audit of a framework or term contract */
    projectId: text("project_id"),
    verificationId: text("verification_id"),
    reference: text("reference").notNull(),
    subjectType: text("subject_type").default("commitment").notNull(), // commitment | framework | term_contract | jv | project
    subjectId: text("subject_id"),
    subjectName: text("subject_name").notNull(),
    contractReference: text("contract_reference"),
    clause: text("clause"),
    scope: text("scope").notNull(),
    auditorName: text("auditor_name"),
    auditorUserId: text("auditor_user_id"),
    noticeDate: text("notice_date").notNull(), // ISO date
    /** notice period the clause requires, in days */
    noticeDays: integer("notice_days"),
    scheduledDate: text("scheduled_date"),
    accessGrantedAt: timestamp("access_granted_at", { withTimezone: true, mode: "string" }),
    /** records requested: [{ id, description, requestedAt, providedAt?, refused?, note? }] */
    recordsRequested: jsonb("records_requested").$type<unknown[]>().default([]).notNull(),
    obstructionNote: text("obstruction_note"),
    status: text("status").default("notified").notNull(), // AuditRightsStatus
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
    outcome: text("outcome"),
    /** obligations.id for the counterparty's duty to give access by the date */
    obligationId: text("obligation_id"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("audit_rights_executions_company_idx").on(t.companyId, t.status),
    index("audit_rights_executions_project_idx").on(t.companyId, t.projectId),
    index("audit_rights_executions_subject_idx").on(t.companyId, t.subjectType, t.subjectId),
  ],
);
