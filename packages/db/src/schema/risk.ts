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

/* ================================================================== */
/* Platform upgrade wave — quantified risk depth (#402-406, #451,      */
/* #464, #471-476)                                                     */
/* ================================================================== */

/**
 * Asynchronous simulation jobs (#464, #475-476). A Monte Carlo run of any
 * size is queued as a row, executed off the request path in batches, and
 * polled by the UI. The convergence series records the running P50/P80
 * after each batch so "is 5,000 iterations enough?" is answered with
 * evidence rather than a shrug.
 */
export const simulationJobs = pgTable(
  "simulation_jobs",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    kind: text("kind").notNull(), // SimulationKind
    status: text("status").default("queued").notNull(), // SimulationJobStatus
    /** the parsed request body, replayed by the runner */
    params: jsonb("params").$type<Record<string, unknown>>().notNull(),
    seed: integer("seed").notNull(),
    iterations: integer("iterations").notNull(),
    iterationsDone: integer("iterations_done").default(0).notNull(),
    /** [{ iterations, p50, p80, p80DeltaPercent }] — one entry per batch */
    convergence: jsonb("convergence").$type<unknown[]>().default([]).notNull(),
    converged: integer("converged").default(0).notNull(),
    /** riskSimulations.id once the run lands */
    simulationId: text("simulation_id"),
    /** { p50, p80, p90 } risk-adjusted cost EAC or completion dates */
    riskAdjusted: jsonb("risk_adjusted").$type<Record<string, unknown>>(),
    error: text("error"),
    requestedBy: text("requested_by").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("simulation_jobs_project_idx").on(t.projectId),
    index("simulation_jobs_status_idx").on(t.status),
  ],
);

/**
 * Planned contingency drawdown curve (#451, #471). Actual drawdown running
 * ahead of plan is the single earliest signal that a project is consuming
 * its risk cover faster than it is retiring risk.
 */
export const contingencyPlanPoints = pgTable(
  "contingency_plan_points",
  {
    id: text("id").primaryKey(),
    contingencyId: text("contingency_id").notNull(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    pointDate: text("point_date").notNull(), // ISO date
    /** planned REMAINING balance at this date (not the cumulative draw) */
    plannedRemaining: doublePrecision("planned_remaining").notNull(),
    source: text("source").default("manual").notNull(), // manual | <curve shape>
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("contingency_plan_points_uq").on(t.contingencyId, t.pointDate),
    index("contingency_plan_points_contingency_idx").on(t.contingencyId),
  ],
);

/**
 * Contingency release authority workflow (#471-472). Requested by one
 * person, approved by another; the drawdown row is only written inside the
 * approving transaction, which is where the over-draw check lives.
 */
export const contingencyReleases = pgTable(
  "contingency_releases",
  {
    id: text("id").primaryKey(),
    contingencyId: text("contingency_id").notNull(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    amount: doublePrecision("amount").notNull(),
    reason: text("reason").notNull(),
    riskId: text("risk_id"),
    drawnAt: text("drawn_at").notNull(), // ISO date the draw is dated
    status: text("status").default("requested").notNull(), // ContingencyReleaseStatus
    /** true when the amount exceeded the standard threshold and needed admin */
    requiresAdmin: integer("requires_admin").default(0).notNull(),
    requestedBy: text("requested_by").notNull(),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "string" }),
    decisionNote: text("decision_note"),
    /** contingencyDrawdowns.id created on approval */
    drawdownId: text("drawdown_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("contingency_releases_contingency_idx").on(t.contingencyId),
    index("contingency_releases_status_idx").on(t.companyId, t.status),
  ],
);

/**
 * Risk appetite / tolerance thresholds (#472). Exceeding an appetite is not
 * an error — it is a fact the board is entitled to be told, so it raises a
 * signal rather than blocking a write.
 */
export const riskAppetites = pgTable(
  "risk_appetites",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    scope: text("scope").default("project").notNull(), // RiskAppetiteScope
    /** null for the project-wide row; a RiskCategory otherwise */
    category: text("category"),
    /** maximum acceptable qualitative P×I score (1-25) */
    maxScore: integer("max_score"),
    /** maximum acceptable quantified expected value, in `currency` */
    maxExpectedValue: doublePrecision("max_expected_value"),
    currency: text("currency").default("GBP").notNull(),
    note: text("note"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("risk_appetites_uq").on(t.projectId, t.scope, t.category),
    index("risk_appetites_project_idx").on(t.projectId),
  ],
);

/**
 * Company-wide outturn database for reference class forecasting (#403-404).
 * The outside view is empirical: what did projects LIKE this one actually
 * cost, against what they were estimated to cost.
 */
export const referenceProjects = pgTable(
  "reference_projects",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    name: text("name").notNull(),
    /** OptimismBiasCategory — the reference class */
    category: text("category").notNull(),
    assetClass: text("asset_class"),
    country: text("country"),
    currency: text("currency").default("GBP").notNull(),
    estimatedCost: doublePrecision("estimated_cost"),
    outturnCost: doublePrecision("outturn_cost"),
    estimatedDurationDays: integer("estimated_duration_days"),
    outturnDurationDays: integer("outturn_duration_days"),
    completedAt: text("completed_at"), // ISO date
    source: text("source"),
    note: text("note"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("reference_projects_company_idx").on(t.companyId),
    index("reference_projects_category_idx").on(t.companyId, t.category),
  ],
);
