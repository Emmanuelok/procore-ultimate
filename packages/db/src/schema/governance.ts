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
 * Capital programme governance (spec Vol II Domain G / module M12).
 * Business cases follow the HM Treasury five-case model (#395); options
 * carry CBA inputs computed to NPV/BCR by the API (#398-399) with optimism
 * bias uplift applied per category (#402).
 */
export const businessCases = pgTable(
  "business_cases",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    stage: text("stage").notNull(), // BusinessCaseStage (SOC/OBC/FBC)
    status: text("status").default("draft").notNull(), // BusinessCaseStatus
    title: text("title").notNull(),
    /** five-case narratives: { strategic, economic, commercial, financial, management } */
    cases: jsonb("cases").$type<Record<string, string>>().default({}).notNull(),
    /** appraisal config: { discountRatePercent, appraisalYears, optimismBiasPercent } */
    appraisal: jsonb("appraisal").$type<Record<string, unknown>>().default({}).notNull(),
    /** options: [{ id, name, isCounterfactual, capex, annualBenefits[], annualCosts[],
     *   computed: { npv, bcr, paybackYear } }] */
    options: jsonb("options").$type<unknown[]>().default([]).notNull(),
    preferredOptionId: text("preferred_option_id"),
    /**
     * Logic model (#418): { nodes: [{ id, level, label, note, benefitId? }],
     * edges: [{ from, to }] } — inputs → outputs → outcomes → impacts, the
     * chain a benefit claim has to hang from.
     */
    logicModel: jsonb("logic_model").$type<Record<string, unknown>>(),
    /**
     * Reference class forecasting position (#403-405):
     * { category, upperPercent, lowerPercent, position, mitigations[],
     *   outside: { references, p50Uplift, p80Uplift } | null }
     */
    referenceClass: jsonb("reference_class").$type<Record<string, unknown>>(),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("business_cases_project_idx").on(t.projectId)],
);

/** Stage gate definitions (#408) — Gateway 0-5 style, per project. */
export const stageGates = pgTable(
  "stage_gates",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    gateNumber: integer("gate_number").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** criteria: [{ id, text, evidenceRequired }] */
    criteria: jsonb("criteria").$type<unknown[]>().default([]).notNull(),
    plannedDate: text("planned_date"),
    status: text("status").default("pending").notNull(), // pending | in_review | decided
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("stage_gates_uq").on(t.projectId, t.gateNumber),
    index("stage_gates_project_idx").on(t.projectId),
  ],
);

/** Gate reviews (#409-415): independent decision with conditions tracked to closure. */
export const gateReviews = pgTable(
  "gate_reviews",
  {
    id: text("id").primaryKey(),
    gateId: text("gate_id").notNull(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    reviewDate: text("review_date").notNull(),
    /** delivery confidence assessment (#414) */
    rag: text("rag").notNull(), // RagRating
    decision: text("decision").notNull(), // GateDecision
    narrative: text("narrative"),
    /** per-criterion findings: [{ criterionId, met, note }] */
    findings: jsonb("findings").$type<unknown[]>().default([]).notNull(),
    /** conditions of approval: [{ id, text, dueDate?, obligationId?, closed }] (#413) */
    conditions: jsonb("conditions").$type<unknown[]>().default([]).notNull(),
    /**
     * Frozen evidence pack (#410-411): { root, builtAt, items: [{ criterionId,
     * kind, id, sha256, title }] } — the Merkle commitment to exactly what the
     * reviewer saw, so the decision is reproducible.
     */
    evidencePack: jsonb("evidence_pack").$type<Record<string, unknown>>(),
    evidencePackRoot: text("evidence_pack_root"),
    /** { independent: boolean, basis: string } — why this reviewer could decide (#415) */
    independence: jsonb("independence").$type<Record<string, unknown>>(),
    reviewedBy: text("reviewed_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("gate_reviews_gate_idx").on(t.gateId)],
);

/** Benefits register (#416-421). */
export const benefits = pgTable(
  "benefits",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    ownerId: text("owner_id"),
    measurementMethod: text("measurement_method"),
    unit: text("unit").notNull(),
    baselineValue: doublePrecision("baseline_value").notNull(),
    targetValue: doublePrecision("target_value").notNull(),
    targetDate: text("target_date"),
    /** disbenefits are negative-direction benefits (#420) */
    isDisbenefit: integer("is_disbenefit").default(0).notNull(),
    status: text("status").default("planned").notNull(), // BenefitStatus
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("benefits_uq").on(t.projectId, t.number),
    index("benefits_project_idx").on(t.projectId),
  ],
);

/** Benefit realisation readings over time (#418). */
export const benefitReadings = pgTable(
  "benefit_readings",
  {
    id: text("id").primaryKey(),
    benefitId: text("benefit_id").notNull(),
    companyId: text("company_id").notNull(),
    readingDate: text("reading_date").notNull(),
    value: doublePrecision("value").notNull(),
    note: text("note"),
    recordedBy: text("recorded_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("benefit_readings_benefit_idx").on(t.benefitId)],
);

/* ================================================================== */
/* Platform upgrade wave — governance depth (#405, #415, #418-422)     */
/* ================================================================== */

/**
 * Benefit dependency network (#418-419). A benefit that depends on an
 * at-risk predecessor is itself at risk whether or not its own readings say
 * so — the edge is what makes that inference possible.
 */
export const benefitDependencies = pgTable(
  "benefit_dependencies",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    fromBenefitId: text("from_benefit_id").notNull(),
    toBenefitId: text("to_benefit_id").notNull(),
    depType: text("dep_type").default("contributes").notNull(), // BenefitDependencyType
    note: text("note"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("benefit_dependencies_uq").on(t.fromBenefitId, t.toBenefitId),
    index("benefit_dependencies_project_idx").on(t.projectId),
  ],
);

/**
 * Optimism-bias uplift challenge (#405). Departing from the published Green
 * Book range is permitted; doing it unrecorded is not. Proposer ≠ decider.
 */
export const upliftChallenges = pgTable(
  "uplift_challenges",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    businessCaseId: text("business_case_id").notNull(),
    category: text("category").notNull(), // OptimismBiasCategory
    /** the published bound the case would otherwise have used */
    tablePercent: doublePrecision("table_percent").notNull(),
    /** what the team wants to use instead */
    proposedPercent: doublePrecision("proposed_percent").notNull(),
    justification: text("justification").notNull(),
    status: text("status").default("proposed").notNull(), // UpliftChallengeStatus
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "string" }),
    decisionNote: text("decision_note"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("uplift_challenges_bc_idx").on(t.businessCaseId),
    index("uplift_challenges_project_idx").on(t.projectId),
  ],
);

/**
 * Assurance actions (#415): the recommendations a gate review or an
 * independent assurance review leaves behind, owned by a named person with
 * a due date carried on the obligation register.
 */
export const assuranceActions = pgTable(
  "assurance_actions",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    /** the review that raised it, when there was one */
    gateReviewId: text("gate_review_id"),
    source: text("source").notNull(), // gate_review | assurance_review | audit | other
    title: text("title").notNull(),
    description: text("description"),
    priority: text("priority").default("recommended").notNull(), // AssuranceActionPriority
    ownerId: text("owner_id"),
    dueDate: text("due_date"),
    status: text("status").default("open").notNull(), // AssuranceActionStatus
    obligationId: text("obligation_id"),
    evidenceIds: jsonb("evidence_ids").$type<string[]>().default([]).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "string" }),
    closedBy: text("closed_by"),
    closeNote: text("close_note"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("assurance_actions_uq").on(t.projectId, t.number),
    index("assurance_actions_project_idx").on(t.projectId),
    index("assurance_actions_status_idx").on(t.companyId, t.status),
    index("assurance_actions_due_idx").on(t.dueDate),
  ],
);
