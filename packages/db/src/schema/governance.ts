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
