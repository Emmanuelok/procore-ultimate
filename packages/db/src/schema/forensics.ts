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
 * Delay & disruption forensics (spec Vol II Domain D / module M9).
 * Delay events are the atoms; claims assemble events into a
 * cause → effect → entitlement → quantum chain (#305) with evidence links.
 */
export const delayEvents = pgTable(
  "delay_events",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    cause: text("cause").notNull(), // DelayCause
    /** entitlement classification (#267) */
    excusable: integer("excusable").default(0).notNull(),
    compensable: integer("compensable").default(0).notNull(),
    status: text("status").default("open").notNull(), // DelayEventStatus
    /** the schedule task the delay strikes (fragnet insertion point) */
    taskId: text("task_id"),
    scheduleId: text("schedule_id"),
    startDate: text("start_date").notNull(), // ISO date
    durationDays: integer("duration_days").notNull(),
    /**
     * Who the delay is culpable to (CulpableParty). Entitlement follows from
     * this plus the excusable/compensable classification; the concurrency
     * engine needs it to tell owner delay from contractor delay.
     */
    party: text("party").default("neither").notNull(),
    /**
     * When this event is a PACING response, the id of the event it paces.
     * A paced event consumes float deliberately and carries no entitlement.
     */
    pacingOfEventId: text("pacing_of_event_id"),
    /** contract time-bar: the date a notice had to be served by */
    noticeDueDate: text("notice_due_date"),
    /** reason recorded on the last state change (withdrawals must say why) */
    statusReason: text("status_reason"),
    /** contract event (notice) raised for this delay, when any */
    contractEventId: text("contract_event_id"),
    /** assurance evidence ids substantiating the event (#306) */
    evidenceIds: jsonb("evidence_ids").$type<string[]>().default([]).notNull(),
    /** last TIA result for this event: { completionDeltaDays, computedAt } */
    tiaResult: jsonb("tia_result").$type<Record<string, unknown>>(),
    raisedBy: text("raised_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("delay_events_uq").on(t.projectId, t.number),
    index("delay_events_project_idx").on(t.projectId),
    index("delay_events_status_idx").on(t.projectId, t.status),
    index("delay_events_schedule_idx").on(t.scheduleId),
    index("delay_events_start_idx").on(t.projectId, t.startDate),
  ],
);

/**
 * Claims workspace (#304-320). `chain` holds the four narrative limbs
 * { cause, effect, entitlement, quantum }; chronology is assembled on demand
 * from platform records (#318) and cached here with its generation time.
 */
export const forensicClaims = pgTable(
  "forensic_claims",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    kind: text("kind").notNull(), // ClaimKind
    status: text("status").default("draft").notNull(), // ClaimStatus
    contractId: text("contract_id"),
    clauseRef: text("clause_ref"),
    delayEventIds: jsonb("delay_event_ids").$type<string[]>().default([]).notNull(),
    chain: jsonb("chain")
      .$type<{ cause?: string; effect?: string; entitlement?: string; quantum?: string }>()
      .default({})
      .notNull(),
    daysClaimed: integer("days_claimed"),
    amountClaimed: doublePrecision("amount_claimed"),
    daysAssessed: integer("days_assessed"),
    amountAssessed: doublePrecision("amount_assessed"),
    /** prolongation build-up: { prelimsRatePerDay, compensableDays, amount } */
    prolongation: jsonb("prolongation").$type<Record<string, unknown>>(),
    /** money is never currency-free: every quantum figure below is in this */
    currency: text("currency").default("USD").notNull(),
    /* Valuation range and provision (#312-313, #320) */
    quantumBest: doublePrecision("quantum_best"),
    quantumLikely: doublePrecision("quantum_likely"),
    quantumWorst: doublePrecision("quantum_worst"),
    /** 0..1 probability the claim succeeds, used for the provision */
    successProbability: doublePrecision("success_probability"),
    /** quantumLikely x successProbability, stamped when the range is set */
    provisionAmount: doublePrecision("provision_amount"),
    /** record sufficiency score card (#307-309) */
    sufficiency: jsonb("sufficiency").$type<Record<string, unknown>>(),
    sufficiencyAt: timestamp("sufficiency_at", { withTimezone: true, mode: "string" }),
    /** Scott Schedule rows (#317-319) */
    scottSchedule: jsonb("scott_schedule").$type<unknown[]>(),
    /** last generated submission package summary */
    packageAt: timestamp("package_at", { withTimezone: true, mode: "string" }),
    assessedAt: timestamp("assessed_at", { withTimezone: true, mode: "string" }),
    /** who agreed/rejected — must differ from createdBy and assessedBy */
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "string" }),
    /** how many times the claim has been revised back to draft after submission */
    revisionCount: integer("revision_count").default(0).notNull(),
    statusReason: text("status_reason"),
    chronology: jsonb("chronology").$type<unknown[]>(),
    chronologyAt: timestamp("chronology_at", { withTimezone: true, mode: "string" }),
    assessedBy: text("assessed_by"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("forensic_claims_uq").on(t.projectId, t.number),
    index("forensic_claims_project_idx").on(t.projectId),
    index("forensic_claims_status_idx").on(t.companyId, t.status),
  ],
);

/* ================================================================== */
/* WP-SCHED — forensic depth (platform upgrade wave)                   */
/*                                                                     */
/* The method suite (#270-277), float ownership doctrine (#278-281),   */
/* quantum formulae (#300-303) and disruption quantification           */
/* (#290-293) each produce a RECORD, not just a response: an expert    */
/* report has to be reproducible from what the platform stored.        */
/* ================================================================== */

/**
 * One run of a forensic delay-analysis method. `inputs` captures exactly what
 * was fed in (revision ids, event ids, party, window boundaries) so the run
 * can be re-executed; `output` holds the computed result. Every row is
 * ledgered on creation.
 */
export const forensicAnalyses = pgTable(
  "forensic_analyses",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    claimId: text("claim_id"),
    scheduleId: text("schedule_id"),
    baselineId: text("baseline_id"),
    /** ForensicMethod */
    method: text("method").notNull(),
    /** AACE 29R-03 MIP code, e.g. "3.7" */
    mipCode: text("mip_code"),
    /** SCL Delay & Disruption Protocol reference, e.g. "Part B, Core Principle 11" */
    sclReference: text("scl_reference"),
    title: text("title").notNull(),
    inputs: jsonb("inputs").$type<Record<string, unknown>>().default({}).notNull(),
    output: jsonb("output").$type<Record<string, unknown>>().default({}).notNull(),
    /** headline movement in days, when the method produces one */
    resultDays: doublePrecision("result_days"),
    summary: text("summary"),
    /** why this method was chosen (AACE selection factors) */
    rationale: text("rationale"),
    runBy: text("run_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("forensic_analyses_project_idx").on(t.projectId, t.createdAt),
    index("forensic_analyses_claim_idx").on(t.claimId),
    index("forensic_analyses_method_idx").on(t.projectId, t.method),
  ],
);

/**
 * Per-project float ownership and concurrency doctrine (#278-281). One row per
 * project; the concurrency engine cites it in every classification so the
 * answer is defensible rather than a preference expressed at analysis time.
 */
export const projectFloatRules = pgTable(
  "project_float_rules",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    /** FloatOwnershipRule */
    ownership: text("ownership").default("project").notNull(),
    /** ConcurrencyRule */
    concurrencyRule: text("concurrency_rule").default("sca_protocol").notNull(),
    /** overlap shorter than this is not treated as concurrency */
    concurrencyThresholdDays: integer("concurrency_threshold_days").default(1).notNull(),
    /** float consumption within this tolerance of the driver reads as pacing */
    pacingThresholdDays: integer("pacing_threshold_days").default(2).notNull(),
    /** contractual/clause basis for the doctrine above */
    basis: text("basis"),
    updatedBy: text("updated_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("project_float_rules_uq").on(t.projectId)],
);

/**
 * A quantum calculation (#300-303): Hudson / Emden / Eichleay head-office
 * formulae, site overhead allocation, finance charges and loss of profit.
 * Assumptions are stored separately from inputs because an assumption the
 * claimant made is exactly what a respondent attacks.
 */
export const quantumCalculations = pgTable(
  "quantum_calculations",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    claimId: text("claim_id"),
    /** QuantumMethod */
    method: text("method").notNull(),
    currency: text("currency").default("USD").notNull(),
    inputs: jsonb("inputs").$type<Record<string, unknown>>().default({}).notNull(),
    assumptions: jsonb("assumptions").$type<string[]>().default([]).notNull(),
    /** provenance of each input: which record it came from, or "manual" */
    sources: jsonb("sources").$type<Record<string, unknown>>().default({}).notNull(),
    amount: doublePrecision("amount"),
    formula: text("formula"),
    workings: text("workings"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("quantum_calculations_project_idx").on(t.projectId, t.createdAt),
    index("quantum_calculations_claim_idx").on(t.claimId),
  ],
);

/**
 * A disruption quantification (#290-293). The measured-mile method needs the
 * baseline (unimpacted) window and the impacted window; the earned-value
 * method needs planned vs earned hours; industry curves need a justification
 * because a curve is an assertion about someone else's projects.
 */
export const disruptionAnalyses = pgTable(
  "disruption_analyses",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    claimId: text("claim_id"),
    /** DisruptionMethod */
    method: text("method").notNull(),
    trade: text("trade"),
    title: text("title").notNull(),
    baselineFrom: text("baseline_from"),
    baselineTo: text("baseline_to"),
    impactedFrom: text("impacted_from"),
    impactedTo: text("impacted_to"),
    inputs: jsonb("inputs").$type<Record<string, unknown>>().default({}).notNull(),
    /** weekly series with the record ids each point was built from */
    series: jsonb("series").$type<unknown[]>().default([]).notNull(),
    output: jsonb("output").$type<Record<string, unknown>>().default({}).notNull(),
    lostHours: doublePrecision("lost_hours"),
    amount: doublePrecision("amount"),
    currency: text("currency").default("USD").notNull(),
    /** mandatory for industry-curve methods */
    justification: text("justification"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("disruption_analyses_project_idx").on(t.projectId, t.createdAt),
    index("disruption_analyses_claim_idx").on(t.claimId),
  ],
);
