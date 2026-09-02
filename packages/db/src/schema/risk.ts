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
 * Quantitative risk (spec Vol II Domain H / module M13).
 * Risks carry both qualitative scoring (probability × impact, pre/post
 * mitigation, #450) and quantitative inputs: an occurrence probability plus
 * a cost-impact distribution for QCRA (#458-460), and an optional link to a
 * schedule task with a duration distribution for QSRA (#457).
 */
export const risks = pgTable(
  "risks",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    category: text("category").notNull(), // RiskCategory
    status: text("status").default("open").notNull(), // RiskStatus
    ownerId: text("owner_id"),
    /* qualitative 1-5 scoring */
    probabilityScore: integer("probability_score").default(3).notNull(),
    impactScore: integer("impact_score").default(3).notNull(),
    postProbabilityScore: integer("post_probability_score"),
    postImpactScore: integer("post_impact_score"),
    /* quantitative (QCRA) */
    occurrenceProbability: doublePrecision("occurrence_probability"), // 0..1
    /** Distribution JSON (lib/montecarlo.ts shape) for cost impact */
    costImpact: jsonb("cost_impact").$type<Record<string, unknown>>(),
    /* quantitative (QSRA) */
    scheduleTaskId: text("schedule_task_id"),
    /** Distribution JSON for the linked task's duration under this risk */
    durationImpact: jsonb("duration_impact").$type<Record<string, unknown>>(),
    /** mitigation actions: [{ description, ownerId?, dueDate?, cost?, done }] */
    mitigations: jsonb("mitigations").$type<unknown[]>().default([]).notNull(),
    mitigationCost: doublePrecision("mitigation_cost"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("risks_uq").on(t.projectId, t.number),
    index("risks_project_idx").on(t.projectId),
  ],
);

/** Persisted simulation runs (#464-466): reproducible via stored seed. */
export const riskSimulations = pgTable(
  "risk_simulations",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    kind: text("kind").notNull(), // SimulationKind
    seed: integer("seed").notNull(),
    iterations: integer("iterations").notNull(),
    /** inputs captured at run time (risk ids / schedule id + distributions) */
    inputs: jsonb("inputs").$type<Record<string, unknown>>().notNull(),
    /** SimulationSummary + perRisk/perTask + contingencyAt */
    results: jsonb("results").$type<Record<string, unknown>>().notNull(),
    runBy: text("run_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("risk_simulations_project_idx").on(t.projectId)],
);

/**
 * Contingency register with drawdown discipline (#469-473): a budget set at
 * a stated confidence level, drawn down against realised risks.
 */
export const contingencies = pgTable(
  "contingencies",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    currency: text("currency").default("GBP").notNull(),
    amount: doublePrecision("amount").notNull(),
    /** confidence the amount was set at (e.g. "p80") + source simulation */
    confidenceLevel: text("confidence_level"),
    simulationId: text("simulation_id"),
    /** management reserve is held apart from risk contingency (#474) */
    isManagementReserve: integer("is_management_reserve").default(0).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("contingencies_project_idx").on(t.projectId)],
);

export const contingencyDrawdowns = pgTable(
  "contingency_drawdowns",
  {
    id: text("id").primaryKey(),
    contingencyId: text("contingency_id").notNull(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    amount: doublePrecision("amount").notNull(),
    reason: text("reason").notNull(),
    riskId: text("risk_id"),
    drawnAt: text("drawn_at").notNull(), // ISO date
    approvedBy: text("approved_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("contingency_drawdowns_contingency_idx").on(t.contingencyId)],
);
