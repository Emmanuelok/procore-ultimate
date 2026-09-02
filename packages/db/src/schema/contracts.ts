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
 * Structured Particular Condition (#201-202). The overlay is authoritative:
 * where a PC states a different time bar the engine uses it, and every event
 * records which source its deadline came from. `amendment` stays the human
 * text; the optional fields are what the machine may act on.
 */
export interface ParticularCondition {
  clauseRef: string;
  amendment: string;
  /** replaces the library time bar for this clause (null = bar removed) */
  timeBarDays?: number | null;
  noticeRequired?: boolean;
  /** calendar (default) or working days for the bar */
  calendarBasis?: "calendar" | "working";
  /** days before the deadline at which the platform warns (#229) */
  warnDaysBefore?: number;
  /** true when the PC deletes the clause outright */
  deleted?: boolean;
}

/**
 * Contract intelligence (spec Vol II Domain C / module M8).
 * A contract instantiates a standard form (FIDIC/NEC/JCT) whose clause
 * library lives in code (apps/api/src/modules/contracts/clause-library.ts);
 * `particularConditions` records clause-level amendments against the
 * standard form (#201-202) and — unlike the first cut — actually drives the
 * time-bar engine. Time-barred clauses fix notice deadlines on contract
 * events, materialized as assurance Obligations.
 */
export const contracts = pgTable(
  "contracts",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    form: text("form").notNull(), // ContractForm
    necOption: text("nec_option"), // NecOption, NEC forms only
    /** { employer, contractor, administrator } — administrator is the
     *  Engineer (FIDIC) / Project Manager (NEC) / CA (JCT) */
    parties: jsonb("parties").$type<Record<string, string>>().default({}).notNull(),
    baseDate: text("base_date"),
    commencementDate: text("commencement_date"),
    completionDate: text("completion_date"),
    /** actual taking-over / practical completion (#244) — stops LD accrual */
    takingOverDate: text("taking_over_date"),
    actualCompletionDate: text("actual_completion_date"),
    currency: text("currency").default("USD").notNull(),
    contractSum: doublePrecision("contract_sum"),
    retentionPercent: doublePrecision("retention_percent").default(0).notNull(),
    retentionCap: doublePrecision("retention_cap"),
    /** fraction of retention released at taking-over (FIDIC 14.9 = 0.5) */
    retentionReleaseAtTakingOver: doublePrecision("retention_release_at_taking_over")
      .default(0.5)
      .notNull(),
    defectsPeriodMonths: integer("defects_period_months"),
    ldRatePerDay: doublePrecision("ld_rate_per_day"),
    ldCap: doublePrecision("ld_cap"),
    /** days from receipt of a Statement to the due date for payment (FIDIC 14.7) */
    paymentDueDays: integer("payment_due_days"),
    /** calendar vs working days for every computed deadline on this contract */
    calendarBasis: text("calendar_basis").default("calendar").notNull(), // CalendarBasis
    /** ISO dates treated as non-working days when calendarBasis = working */
    holidays: jsonb("holidays").$type<string[]>().default([]).notNull(),
    jurisdiction: text("jurisdiction"),
    /** [{ clauseRef, amendment, timeBarDays?, noticeRequired?, … }] */
    particularConditions: jsonb("particular_conditions")
      .$type<ParticularCondition[]>()
      .default([])
      .notNull(),
    status: text("status").default("draft").notNull(), // ContractStatus
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("contracts_project_idx").on(t.projectId),
    index("contracts_company_status_idx").on(t.companyId, t.status),
  ],
);

/**
 * Contract event / notice register (#225-236): early warnings, compensation
 * events, claim notices, payment notices. `noticeDeadline` is computed from
 * the EFFECTIVE clause (library merged with the Particular Conditions) at
 * creation; `obligationId` links the materialized assurance Obligation that
 * tracks the deadline. Late service is a persisted fact on the row, not a
 * detail buried in a ledger payload.
 */
export const contractEvents = pgTable(
  "contract_events",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    contractId: text("contract_id").notNull(),
    number: integer("number").notNull(),
    kind: text("kind").notNull(), // ContractEventKind
    clauseRef: text("clause_ref"),
    title: text("title").notNull(),
    description: text("description"),
    eventDate: text("event_date").notNull(), // ISO date the event occurred
    /** date the claiming party became aware — the bar usually runs from here */
    awarenessDate: text("awareness_date"),
    noticeDeadline: text("notice_deadline"), // ISO date, from the effective clause
    /** the time bar actually applied, after the PC overlay */
    effectiveTimeBarDays: integer("effective_time_bar_days"),
    deadlineSource: text("deadline_source"), // DeadlineSource
    calendarBasis: text("calendar_basis").default("calendar").notNull(), // CalendarBasis
    warnDaysBefore: integer("warn_days_before"),
    warnedAt: timestamp("warned_at", { withTimezone: true, mode: "string" }),
    noticeServedAt: timestamp("notice_served_at", { withTimezone: true, mode: "string" }),
    noticeMethod: text("notice_method"), // email | letter | portal | registered_post
    noticeReference: text("notice_reference"),
    /** persisted breach record (#230): served after the bar had elapsed */
    noticeServedLate: boolean("notice_served_late").default(false).notNull(),
    deadlineAtService: text("deadline_at_service"),
    lateReason: text("late_reason"),
    serviceEvidenceRef: text("service_evidence_ref"),
    status: text("status").default("open").notNull(), // ContractEventStatus
    obligationId: text("obligation_id"),
    /** chained deadlines: the event whose service spawned this one */
    chainParentId: text("chain_parent_id"),
    chainStage: text("chain_stage"),
    /** NEC compensation-event sub-state (#206-211) */
    ceState: text("ce_state"), // CeState
    quotationDueDate: text("quotation_due_date"),
    replyDueDate: text("reply_due_date"),
    deemedAcceptedAt: timestamp("deemed_accepted_at", { withTimezone: true, mode: "string" }),
    costImpactEstimate: doublePrecision("cost_impact_estimate"),
    timeImpactDaysEstimate: integer("time_impact_days_estimate"),
    raisedBy: text("raised_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("contract_events_uq").on(t.contractId, t.number),
    index("contract_events_project_idx").on(t.projectId),
    index("contract_events_deadline_idx").on(t.status, t.noticeDeadline),
    index("contract_events_company_status_idx").on(t.companyId, t.status),
    index("contract_events_ce_idx").on(t.contractId, t.ceState),
  ],
);

/**
 * Which contract (and event) an assurance Obligation belongs to.
 *
 * `obligations` lives in schema/assurance.ts, owned by another work package,
 * so the contract link is modelled here as an explicit join rather than by
 * adding columns to a table this package does not own. Counting obligations
 * by contract goes through this table — the previous `sourceClause LIKE
 * '<form> %'` match merged every contract of the same form on a project.
 */
export const contractObligationLinks = pgTable(
  "contract_obligation_links",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    contractId: text("contract_id").notNull(),
    contractEventId: text("contract_event_id"),
    obligationId: text("obligation_id").notNull(),
    /** standing | notice | chain | compliance */
    kind: text("kind").notNull(),
    clauseRef: text("clause_ref"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("contract_obligation_links_uq").on(t.obligationId),
    index("contract_obligation_links_contract_idx").on(t.contractId),
    index("contract_obligation_links_event_idx").on(t.contractEventId),
  ],
);

/**
 * NEC compensation-event quotations (#207-208): a Defined Cost build-up by
 * Schedule of Cost Components head plus the Fee, with the reply clock the
 * time-bar engine watches for deemed acceptance (62.6 / 64.4).
 */
export const ceQuotations = pgTable(
  "ce_quotations",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    contractId: text("contract_id").notNull(),
    eventId: text("event_id").notNull(),
    number: integer("number").notNull(),
    status: text("status").default("submitted").notNull(), // CeQuotationStatus
    currency: text("currency").default("USD").notNull(),
    /** [{ component: SccComponent, description, qty, unit, rate, amount }] */
    components: jsonb("components").$type<unknown[]>().default([]).notNull(),
    definedCost: doublePrecision("defined_cost").default(0).notNull(),
    feePercent: doublePrecision("fee_percent").default(0).notNull(),
    fee: doublePrecision("fee").default(0).notNull(),
    riskAllowance: doublePrecision("risk_allowance").default(0).notNull(),
    total: doublePrecision("total").default(0).notNull(),
    timeImpactDays: integer("time_impact_days").default(0).notNull(),
    assumptions: text("assumptions"),
    submittedBy: text("submitted_by").notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    replyDueDate: text("reply_due_date"),
    repliedBy: text("replied_by"),
    repliedAt: timestamp("replied_at", { withTimezone: true, mode: "string" }),
    replyReason: text("reply_reason"),
    deemedAcceptedAt: timestamp("deemed_accepted_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("ce_quotations_uq").on(t.eventId, t.number),
    index("ce_quotations_contract_idx").on(t.contractId, t.status),
    index("ce_quotations_reply_idx").on(t.status, t.replyDueDate),
  ],
);

/** NEC accepted-programme register (#209-210). */
export const acceptedProgrammes = pgTable(
  "accepted_programmes",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    contractId: text("contract_id").notNull(),
    number: integer("number").notNull(),
    revision: text("revision"),
    scheduleId: text("schedule_id"),
    submittedAt: text("submitted_at").notNull(), // ISO date
    submittedBy: text("submitted_by").notNull(),
    status: text("status").default("submitted").notNull(), // ProgrammeStatus
    decisionDueDate: text("decision_due_date"),
    decisionAt: text("decision_at"),
    decisionBy: text("decision_by"),
    rejectionReason: text("rejection_reason"), // ProgrammeRejectionReason
    rejectionDetail: text("rejection_detail"),
    plannedCompletion: text("planned_completion"),
    terminalFloatDays: integer("terminal_float_days"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("accepted_programmes_uq").on(t.contractId, t.number),
    index("accepted_programmes_project_idx").on(t.projectId, t.status),
  ],
);

/**
 * Insurance / bond / guarantee clause compliance (#251-253). One row per
 * requirement the contract imposes; the check engine re-evaluates it against
 * whatever evidence exists and records the verdict with its reason, never a
 * silent pass.
 */
export const contractComplianceChecks = pgTable(
  "contract_compliance_checks",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    contractId: text("contract_id").notNull(),
    kind: text("kind").notNull(), // ContractComplianceKind
    clauseRef: text("clause_ref"),
    requirement: text("requirement").notNull(),
    requiredAmount: doublePrecision("required_amount"),
    currency: text("currency").default("USD").notNull(),
    /** the cover must run at least until this date */
    requiredUntil: text("required_until"),
    /** insurance_policy | bond | document | manual */
    evidenceType: text("evidence_type"),
    evidenceId: text("evidence_id"),
    evidenceExpiry: text("evidence_expiry"),
    evidenceAmount: doublePrecision("evidence_amount"),
    status: text("status").default("unknown").notNull(), // ContractComplianceStatus
    reason: text("reason"),
    obligationId: text("obligation_id"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true, mode: "string" }),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("contract_compliance_contract_idx").on(t.contractId, t.status),
    index("contract_compliance_project_idx").on(t.projectId),
    index("contract_compliance_expiry_idx").on(t.status, t.requiredUntil),
  ],
);

/** Extension of time claims (#237-240). */
export const eotClaims = pgTable(
  "eot_claims",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    contractId: text("contract_id").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    clauseRef: text("clause_ref"),
    /** contract event ids supporting the claim */
    eventIds: jsonb("event_ids").$type<string[]>().default([]).notNull(),
    daysClaimed: integer("days_claimed").notNull(),
    daysAwarded: integer("days_awarded"),
    status: text("status").default("notified").notNull(), // EotStatus
    narrative: text("narrative"),
    /** assessment record: method, concurrency finding, float ownership, reasons */
    assessment: jsonb("assessment").$type<Record<string, unknown>>().default({}).notNull(),
    assessedBy: text("assessed_by"),
    assessedAt: timestamp("assessed_at", { withTimezone: true, mode: "string" }),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("eot_claims_uq").on(t.contractId, t.number),
    index("eot_claims_project_idx").on(t.projectId),
    index("eot_claims_status_idx").on(t.companyId, t.status),
  ],
);
