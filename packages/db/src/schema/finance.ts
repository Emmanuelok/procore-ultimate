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
 * Project finance & disbursement (spec Vol II Domain O / module M14).
 * The core discipline: money moves only when conditions are verifiably
 * satisfied. Facility conditions materialize as assurance Obligations;
 * disbursement requests are gated on open condition precedents; covenant
 * breaches raise integrity signals.
 */
export const fundingFacilities = pgTable(
  "funding_facilities",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    lender: text("lender").notNull(),
    instrument: text("instrument").notNull(), // FacilityInstrument
    currency: text("currency").default("GBP").notNull(),
    committedAmount: doublePrecision("committed_amount").notNull(),
    availabilityEndDate: text("availability_end_date"), // closing date (#741)
    /** allocation categories with limits (#739): [{ id, name, limit }] */
    categories: jsonb("categories").$type<unknown[]>().default([]).notNull(),
    /* cost of finance (#748-751) — interest during construction and fees */
    baseRatePercent: doublePrecision("base_rate_percent"),
    marginPercent: doublePrecision("margin_percent"),
    commitmentFeePercent: doublePrecision("commitment_fee_percent"),
    dayCountConvention: text("day_count_convention").default("actual_365").notNull(),
    /** 1 = interest is capitalised into the loan rather than paid in cash */
    capitaliseInterest: integer("capitalise_interest").default(0).notNull(),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("funding_facilities_project_idx").on(t.projectId)],
);

/** Conditions precedent / subsequent (#730-731) — obligation-backed. */
export const facilityConditions = pgTable(
  "facility_conditions",
  {
    id: text("id").primaryKey(),
    facilityId: text("facility_id").notNull(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    kind: text("kind").notNull(), // FacilityConditionKind
    reference: text("reference"),
    description: text("description").notNull(),
    dueDate: text("due_date"),
    status: text("status").default("open").notNull(), // FacilityConditionStatus
    /** evidence substantiating satisfaction */
    evidenceIds: jsonb("evidence_ids").$type<string[]>().default([]).notNull(),
    obligationId: text("obligation_id"),
    satisfiedAt: timestamp("satisfied_at", { withTimezone: true, mode: "string" }),
    satisfiedBy: text("satisfied_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("facility_conditions_facility_idx").on(t.facilityId)],
);

/** Withdrawal applications / disbursement requests (#732-734, #740). */
export const disbursements = pgTable(
  "disbursements",
  {
    id: text("id").primaryKey(),
    facilityId: text("facility_id").notNull(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    amount: doublePrecision("amount").notNull(),
    categoryId: text("category_id"),
    purpose: text("purpose").notNull(),
    status: text("status").default("draft").notNull(), // DisbursementStatus
    /** expenditure evidence assembled with the request (#732, #735) */
    evidenceIds: jsonb("evidence_ids").$type<string[]>().default([]).notNull(),
    /**
     * Per-evidence eligibility classification (#736-737):
     * [{ evidenceId, eligibility, reason?, category?, amount?, note? }].
     * A request carrying an ineligible item cannot be submitted.
     */
    evidenceEligibility: jsonb("evidence_eligibility").$type<unknown[]>().default([]).notNull(),
    /** LTA / independent engineer certification step (#738) */
    certifiedAt: timestamp("certified_at", { withTimezone: true, mode: "string" }),
    certifiedBy: text("certified_by"),
    certificationNote: text("certification_note"),
    certificationEvidenceIds: jsonb("certification_evidence_ids")
      .$type<string[]>()
      .default([])
      .notNull(),
    /** conditionality verification snapshot at submission (#733):
     *  { verifiedAt, openConditions: [{id, reference, description}] } */
    conditionality: jsonb("conditionality").$type<Record<string, unknown>>(),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "string" }),
    submittedBy: text("submitted_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    approvedBy: text("approved_by"),
    disbursedAt: timestamp("disbursed_at", { withTimezone: true, mode: "string" }),
    rejectionReason: text("rejection_reason"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("disbursements_uq").on(t.facilityId, t.number),
    index("disbursements_project_idx").on(t.projectId),
  ],
);

/** Financial covenant definitions + periodic readings (#742-743). */
export const covenants = pgTable(
  "covenants",
  {
    id: text("id").primaryKey(),
    facilityId: text("facility_id").notNull(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** threshold test: reading value must be `operator` threshold */
    operator: text("operator").notNull(), // CovenantOperator
    threshold: doublePrecision("threshold").notNull(),
    unit: text("unit"),
    /**
     * Named formula computed from facility_cashflows inputs (#743). `custom`
     * (the default) keeps the manual-reading path; anything else makes the
     * reading derivable and auditable rather than typed in.
     */
    formula: text("formula").default("custom").notNull(), // CovenantFormula
    /** testing cadence in months, for the period sweep */
    testFrequencyMonths: integer("test_frequency_months"),
    createdAt: createdAt(),
  },
  (t) => [index("covenants_facility_idx").on(t.facilityId)],
);

export const covenantReadings = pgTable(
  "covenant_readings",
  {
    id: text("id").primaryKey(),
    covenantId: text("covenant_id").notNull(),
    companyId: text("company_id").notNull(),
    readingDate: text("reading_date").notNull(),
    value: doublePrecision("value").notNull(),
    /** computed at write: value vs threshold */
    compliant: integer("compliant").notNull(),
    headroom: doublePrecision("headroom").notNull(),
    note: text("note"),
    /** "manual" or the formula that produced it, plus the inputs used (#743) */
    basis: text("basis").default("manual").notNull(),
    computedFrom: jsonb("computed_from").$type<Record<string, unknown>>(),
    recordedBy: text("recorded_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("covenant_readings_covenant_idx").on(t.covenantId)],
);

/* ================================================================== */
/* Platform upgrade wave — lender disbursement discipline               */
/* (#736-741, #744-751)                                                 */
/* ================================================================== */

/**
 * Planned drawdown profile (#745-746). Forecast vs actual is the lender's
 * early-warning metric: a tranche tied to a milestone that has not been
 * reached is a draw that should not be requested.
 */
export const disbursementForecasts = pgTable(
  "disbursement_forecasts",
  {
    id: text("id").primaryKey(),
    facilityId: text("facility_id").notNull(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    periodStart: text("period_start").notNull(), // ISO date
    periodEnd: text("period_end").notNull(), // ISO date
    plannedAmount: doublePrecision("planned_amount").notNull(),
    categoryId: text("category_id"),
    /** schedule task whose completion releases the tranche, when milestone-linked */
    milestoneTaskId: text("milestone_task_id"),
    note: text("note"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("disbursement_forecasts_facility_idx").on(t.facilityId),
    index("disbursement_forecasts_period_idx").on(t.facilityId, t.periodEnd),
  ],
);

/**
 * Ineligible expenditure recovery register (#744). Money paid against an
 * item the financier will not fund is recoverable; the register is what the
 * audit asks for.
 */
export const ineligibleRecoveries = pgTable(
  "ineligible_recoveries",
  {
    id: text("id").primaryKey(),
    facilityId: text("facility_id").notNull(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    disbursementId: text("disbursement_id"),
    evidenceId: text("evidence_id"),
    amount: doublePrecision("amount").notNull(),
    currency: text("currency").default("GBP").notNull(),
    reason: text("reason").notNull(), // IneligibilityReason
    detail: text("detail"),
    status: text("status").default("open").notNull(), // IneligibleRecoveryStatus
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "string" }),
    resolvedBy: text("resolved_by"),
    resolutionNote: text("resolution_note"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("ineligible_recoveries_facility_idx").on(t.facilityId),
    index("ineligible_recoveries_status_idx").on(t.companyId, t.status),
  ],
);

/**
 * Period financial inputs a computed covenant reads (#743). One row per
 * facility per test period; the named keys are FACILITY_CASHFLOW_INPUTS.
 */
export const facilityCashflows = pgTable(
  "facility_cashflows",
  {
    id: text("id").primaryKey(),
    facilityId: text("facility_id").notNull(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    periodEnd: text("period_end").notNull(), // ISO date
    inputs: jsonb("inputs").$type<Record<string, number>>().notNull(),
    note: text("note"),
    recordedBy: text("recorded_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("facility_cashflows_uq").on(t.facilityId, t.periodEnd),
    index("facility_cashflows_facility_idx").on(t.facilityId),
  ],
);

/**
 * Lender waiver of a covenant breach (#747). Without one, a facility in
 * breach is under a draw-stop: nothing may be submitted or paid.
 */
export const covenantWaivers = pgTable(
  "covenant_waivers",
  {
    id: text("id").primaryKey(),
    covenantId: text("covenant_id").notNull(),
    facilityId: text("facility_id").notNull(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    reason: text("reason").notNull(),
    lenderReference: text("lender_reference"),
    effectiveFrom: text("effective_from").notNull(), // ISO date
    effectiveTo: text("effective_to"), // ISO date; null = open-ended
    evidenceIds: jsonb("evidence_ids").$type<string[]>().default([]).notNull(),
    grantedBy: text("granted_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("covenant_waivers_covenant_idx").on(t.covenantId),
    index("covenant_waivers_facility_idx").on(t.facilityId),
  ],
);

/* ================================================================== */
/* Designated (special) account discipline — DFI advance accounts      */
/* ================================================================== */

/**
 * A designated / special account (#735, #745): the advance a financier
 * places at the borrower's disposal, replenished on evidence of eligible
 * expenditure. Its whole purpose is that the balance is reconcilable at any
 * moment against what has been documented, so the account carries its own
 * ledger rather than borrowing the facility's.
 */
export const designatedAccounts = pgTable(
  "designated_accounts",
  {
    id: text("id").primaryKey(),
    facilityId: text("facility_id").notNull(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    bankName: text("bank_name"),
    /** last four digits / IBAN tail only — never the full number */
    accountRef: text("account_ref"),
    currency: text("currency").default("GBP").notNull(),
    /** the advance ceiling the financier has authorised */
    authorisedCeiling: doublePrecision("authorised_ceiling").notNull(),
    openingBalance: doublePrecision("opening_balance").default(0).notNull(),
    openedOn: text("opened_on"), // ISO date
    status: text("status").default("active").notNull(), // DesignatedAccountStatus
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("designated_accounts_facility_idx").on(t.facilityId),
    index("designated_accounts_project_idx").on(t.projectId),
  ],
);

/** One movement on a designated account. Amounts are stored positive; the
 *  kind decides the sign, so a data-entry slip cannot silently flip a
 *  withdrawal into a deposit. */
export const designatedAccountEntries = pgTable(
  "designated_account_entries",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    entryDate: text("entry_date").notNull(), // ISO date
    kind: text("kind").notNull(), // DesignatedAccountEntryKind
    amount: doublePrecision("amount").notNull(), // always >= 0
    description: text("description").notNull(),
    reference: text("reference"),
    /** the disbursement that funded an advance/replenishment, when there was one */
    disbursementId: text("disbursement_id"),
    evidenceId: text("evidence_id"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("designated_account_entries_account_idx").on(t.accountId, t.entryDate),
    index("designated_account_entries_project_idx").on(t.projectId),
  ],
);

/**
 * A period reconciliation of the account: what the bank says against what
 * the ledger says. An unexplained difference is a signal, not a rounding
 * note — this is the control the whole advance mechanism rests on.
 */
export const designatedAccountReconciliations = pgTable(
  "designated_account_reconciliations",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    periodEnd: text("period_end").notNull(), // ISO date
    /** balance per the bank statement at periodEnd */
    statementBalance: doublePrecision("statement_balance").notNull(),
    /** balance per this account's own ledger at periodEnd */
    computedBalance: doublePrecision("computed_balance").notNull(),
    difference: doublePrecision("difference").notNull(),
    /** ReconciliationOutcome — reconciled | unreconciled */
    outcome: text("outcome").notNull(),
    explanation: text("explanation"),
    evidenceIds: jsonb("evidence_ids").$type<string[]>().default([]).notNull(),
    /** the assurance reconciliations row this mirrors, when one was written */
    assuranceReconciliationId: text("assurance_reconciliation_id"),
    reconciledBy: text("reconciled_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("designated_account_recs_uq").on(t.accountId, t.periodEnd),
    index("designated_account_recs_account_idx").on(t.accountId),
  ],
);

/* ================================================================== */
/* PPP / availability payment mechanism                                */
/* ================================================================== */

/**
 * The payment mechanism of an availability-based concession: a unitary
 * charge earned in full only when the asset is available AND performing,
 * reduced by deductions when it is not. The weights and the cap are the
 * negotiated terms, so they live on the model rather than in code.
 */
export const availabilityPaymentModels = pgTable(
  "availability_payment_models",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    facilityId: text("facility_id"),
    name: text("name").notNull(),
    currency: text("currency").default("GBP").notNull(),
    /** the full charge for one period at full availability and performance */
    unitaryCharge: doublePrecision("unitary_charge").notNull(),
    periodMonths: integer("period_months").default(1).notNull(),
    /** share of the charge at risk on availability (%) */
    availabilityWeightPercent: doublePrecision("availability_weight_percent")
      .default(70)
      .notNull(),
    /** share of the charge at risk on performance (%) */
    performanceWeightPercent: doublePrecision("performance_weight_percent").default(30).notNull(),
    /** value of one performance failure point, as a % of the charge */
    performancePointValuePercent: doublePrecision("performance_point_value_percent")
      .default(0.1)
      .notNull(),
    /** maximum deduction in one period, as a % of the charge; null = uncapped */
    deductionCapPercent: doublePrecision("deduction_cap_percent"),
    /** failure points in a period that trigger a persistent-breach warning */
    persistentBreachPoints: doublePrecision("persistent_breach_points"),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("availability_payment_models_project_idx").on(t.projectId)],
);

/** One payment period under an availability mechanism. */
export const availabilityPeriods = pgTable(
  "availability_periods",
  {
    id: text("id").primaryKey(),
    modelId: text("model_id").notNull(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    periodStart: text("period_start").notNull(), // ISO date
    periodEnd: text("period_end").notNull(), // ISO date
    /** hours in the period the asset was contractually required to be available */
    requiredHours: doublePrecision("required_hours").notNull(),
    /** [{ area, hours, weight, note }] — unavailability, weighted by area */
    unavailabilityEvents: jsonb("unavailability_events").$type<unknown[]>().default([]).notNull(),
    /** performance failure points accrued in the period */
    performancePoints: doublePrecision("performance_points").default(0).notNull(),
    status: text("status").default("draft").notNull(), // AvailabilityPeriodStatus
    /** engine output frozen at certification */
    computed: jsonb("computed").$type<Record<string, unknown>>(),
    certifiedBy: text("certified_by"),
    certifiedAt: timestamp("certified_at", { withTimezone: true, mode: "string" }),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("availability_periods_uq").on(t.modelId, t.periodStart),
    index("availability_periods_model_idx").on(t.modelId),
    index("availability_periods_project_idx").on(t.projectId),
  ],
);
