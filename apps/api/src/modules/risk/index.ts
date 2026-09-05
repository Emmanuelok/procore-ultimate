import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  budgets,
  contingencies,
  contingencyDrawdowns,
  contingencyPlanPoints,
  contingencyReleases,
  referenceProjects,
  riskAppetites,
  riskSimulations,
  risks,
  scheduleDependencies,
  scheduleTasks,
  schedules,
  signals,
  simulationJobs,
} from "@constructos/db";
import {
  CONTINGENCY_CURVE_SHAPES,
  OPTIMISM_BIAS_CATEGORIES,
  RISK_CATEGORIES,
  RISK_STATUSES,
  SIMULATION_KINDS,
  type ContingencyCurveShape,
  type DependencyType,
  type RiskStatus,
  type TaskConstraintType,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { isoDateSchema, todayISO } from "../field/dates.js";
import { isoFromDay, type CpmDependencyInput } from "../../lib/cpm.js";
import {
  type Distribution,
  type QcraRiskInput,
  type QsraTaskInput,
  type SimulationSummary as McSummary,
} from "../../lib/montecarlo.js";
import { analyticMean, distributionSchema } from "./distributions.js";
import { checkRiskTransition } from "./transitions.js";
import { expectedValueOf, registerRiskJobs, toAppetiteRiskInput } from "./jobs.js";
import { companyToolGate, holdsToolLevel, visibleProjectIds } from "../governance/gates.js";
import {
  OPTIMISM_BIAS_TABLE,
  referenceClassForecast,
  upliftFor,
  type ReferenceProjectInput,
} from "./optimism.js";
import {
  assessDrift,
  evaluateAppetite,
  generatePlanCurve,
  type AppetiteRiskInput,
  type AppetiteRule,
  type PlanPoint,
} from "./contingency.js";
import { riskAdjustedCost } from "./simulation.js";
import { SimulationQueue, type SimulationJobParams } from "./runner.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const score = z.number().int().min(1).max(5);

const riskCreateSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(20000).nullable().optional(),
  category: z.enum(RISK_CATEGORIES),
  ownerId: z.string().min(1).nullable().optional(),
  probabilityScore: score,
  impactScore: score,
  postProbabilityScore: score.nullable().optional(),
  postImpactScore: score.nullable().optional(),
  occurrenceProbability: z.number().min(0).max(1).nullable().optional(),
  costImpact: distributionSchema.nullable().optional(),
  scheduleTaskId: z.string().min(1).nullable().optional(),
  durationImpact: distributionSchema.nullable().optional(),
  /** [{ description, ownerId?, dueDate?, cost?, done }] — free-form actions */
  mitigations: z.array(z.unknown()).max(200).optional(),
  mitigationCost: z.number().nonnegative().nullable().optional(),
});

const riskPatchSchema = riskCreateSchema.partial();

const riskListQuery = pageQuerySchema.extend({
  category: z.enum(RISK_CATEGORIES).optional(),
  status: z.enum(RISK_STATUSES).optional(),
  ownerId: z.string().min(1).optional(),
});

const statusSchema = z.object({
  status: z.enum(RISK_STATUSES),
  note: z.string().max(5000).nullable().optional(),
});

/** riskSimulations.seed is a 32-bit integer column — cap the seed there. */
const MAX_SEED = 2_147_483_647;
const seedSchema = z.number().int().min(0).max(MAX_SEED);

const qcraSchema = z.object({
  iterations: z.number().int().min(100).max(20000).default(5000),
  seed: seedSchema.optional(),
  riskIds: z.array(z.string().min(1)).min(1).max(500).optional(),
  /** true → 202 with a job to poll; false → wait for the (batched) result */
  async: z.boolean().default(false),
});

const qsraSchema = z.object({
  scheduleId: z.string().min(1).optional(),
  iterations: z.number().int().min(50).max(5000).default(1000),
  seed: seedSchema.optional(),
  taskUncertainties: z
    .array(z.object({ taskId: z.string().min(1), distribution: distributionSchema }))
    .max(500)
    .optional(),
  /** true → 202 with a job to poll; false → wait for the (batched) result */
  async: z.boolean().default(false),
});

const simulationListQuery = pageQuerySchema.extend({
  kind: z.enum(SIMULATION_KINDS).optional(),
});

const contingencyCreateSchema = z.object({
  name: z.string().min(1).max(300),
  amount: z.number().positive(),
  currency: z.string().length(3).optional(),
  confidenceLevel: z.string().max(30).nullable().optional(),
  simulationId: z.string().min(1).nullable().optional(),
  isManagementReserve: z.boolean().optional(),
});

const drawdownSchema = z.object({
  amount: z.number().positive(),
  reason: z.string().min(1).max(5000),
  riskId: z.string().min(1).nullable().optional(),
  drawnAt: isoDateSchema,
});

const releaseRequestSchema = drawdownSchema;

const releaseDecisionSchema = z.object({
  note: z.string().max(5000).nullable().optional(),
});

const planPutSchema = z.object({
  /** explicit remaining-balance points; wins over a generated shape */
  points: z
    .array(z.object({ date: isoDateSchema, plannedRemaining: z.number().nonnegative() }))
    .max(240)
    .optional(),
  shape: z.enum(CONTINGENCY_CURVE_SHAPES).optional(),
  startDate: isoDateSchema.optional(),
  endDate: isoDateSchema.optional(),
  intervals: z.number().int().min(1).max(240).optional(),
  endRemaining: z.number().nonnegative().optional(),
});

const appetitePutSchema = z.object({
  scope: z.enum(["project", "category"]).default("project"),
  category: z.enum(RISK_CATEGORIES).nullable().optional(),
  maxScore: z.number().int().min(1).max(25).nullable().optional(),
  maxExpectedValue: z.number().nonnegative().nullable().optional(),
  currency: z.string().length(3).optional(),
  note: z.string().max(5000).nullable().optional(),
});

const referenceProjectSchema = z.object({
  name: z.string().min(1).max(300),
  category: z.enum(OPTIMISM_BIAS_CATEGORIES),
  assetClass: z.string().max(200).nullable().optional(),
  country: z.string().max(100).nullable().optional(),
  currency: z.string().length(3).optional(),
  estimatedCost: z.number().positive().nullable().optional(),
  outturnCost: z.number().nonnegative().nullable().optional(),
  estimatedDurationDays: z.number().int().positive().nullable().optional(),
  outturnDurationDays: z.number().int().nonnegative().nullable().optional(),
  completedAt: isoDateSchema.nullable().optional(),
  source: z.string().max(500).nullable().optional(),
  note: z.string().max(5000).nullable().optional(),
});

const rcfQuery = z.object({
  category: z.enum(OPTIMISM_BIAS_CATEGORIES),
  basis: z.enum(["cost", "duration"]).default("cost"),
  position: z.coerce.number().min(0).max(1).default(0),
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Fraction of a contingency below which the exhaustion signal fires (#473). */
const EXHAUSTION_FRACTION = 0.2;

/**
 * Above this amount a contingency draw must go through the release
 * workflow (request → approval by someone else) rather than being written
 * directly (#471-472). A risk:admin may still draw directly — they are the
 * approving authority — but a standard user cannot self-serve six figures
 * out of the risk pot.
 */
const DIRECT_DRAWDOWN_THRESHOLD = 50_000;

function scored<T extends {
  probabilityScore: number;
  impactScore: number;
  postProbabilityScore: number | null;
  postImpactScore: number | null;
}>(r: T) {
  return {
    ...r,
    preScore: r.probabilityScore * r.impactScore,
    postScore:
      r.postProbabilityScore != null && r.postImpactScore != null
        ? r.postProbabilityScore * r.postImpactScore
        : null,
  };
}

/** Parse a stored jsonb distribution; corruption is a 400, not a crash. */
function parseStoredDistribution(value: unknown, label: string): Distribution {
  const parsed = distributionSchema.safeParse(value);
  if (!parsed.success) {
    throw badRequest(`Stored ${label} distribution is invalid and cannot be sampled`);
  }
  return parsed.data as Distribution;
}

interface SummaryLike {
  percentiles?: Record<string, number>;
  mean?: number;
  min?: number;
  max?: number;
}

/**
 * Quantitative risk — spec Vol II Domain H / module M13 (#447-473 subset):
 * risk register with qualitative pre/post scoring (#447-453) and analytic
 * mitigation-value analysis (#454); seeded QCRA cost simulation (#458-466)
 * and QSRA schedule simulation (#457) over lib/montecarlo.ts, persisted with
 * their full input snapshot + seed so any run can be replayed bit-for-bit
 * (the rerun endpoint is the auditability check); contingency register with
 * drawdown discipline, over-draw refusal and an exhaustion signal (#469-473).
 *
 * Modelling notes (documented simplifications):
 * - Correlation between risks is NOT modelled — every result carries
 *   correlationModelled:false from the engine.
 * - QSRA applies a risk's durationImpact to its linked task unconditionally
 *   (occurrenceProbability is a QCRA input only); explicit taskUncertainties
 *   in the request override risk-derived distributions per task.
 * - Post-mitigation expected value scales the analytic EV by the ratio of
 *   post to pre qualitative scores — a proxy, not a second quantification.
 */
export const riskModule: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("risk", "read")];
  const standardGate = [app.authenticate, app.requireCompany, app.requireTool("risk", "standard")];

  /* ---------------------------------------------------------------- */
  /* Scoped fetch helpers                                              */
  /* ---------------------------------------------------------------- */

  async function fetchRisk(riskId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(risks)
      .where(
        and(eq(risks.id, riskId), eq(risks.companyId, companyId), eq(risks.projectId, projectId)),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Risk not found");
    return rows[0];
  }

  async function fetchSimulation(simId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(riskSimulations)
      .where(
        and(
          eq(riskSimulations.id, simId),
          eq(riskSimulations.companyId, companyId),
          eq(riskSimulations.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Simulation not found");
    return rows[0];
  }

  async function fetchContingency(id: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(contingencies)
      .where(
        and(
          eq(contingencies.id, id),
          eq(contingencies.companyId, companyId),
          eq(contingencies.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Contingency not found");
    return rows[0];
  }

  async function assertScheduleTask(taskId: string, projectId: string): Promise<void> {
    const rows = await app.db
      .select({ id: scheduleTasks.id })
      .from(scheduleTasks)
      .where(and(eq(scheduleTasks.id, taskId), eq(scheduleTasks.projectId, projectId)))
      .limit(1);
    if (!rows[0]) throw badRequest("scheduleTaskId does not belong to a schedule on this project");
  }

  /* ---------------------------------------------------------------- */
  /* Risk register (#447-453)                                          */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/risks", { preHandler: standardGate }, async (req, reply) => {
    const body = riskCreateSchema.parse(req.body);
    if (body.scheduleTaskId) await assertScheduleTask(body.scheduleTaskId, req.projectId!);
    const number = await nextRecordNumber(app.db, req.projectId!, "risk");
    const id = newId("rsk");
    await app.db.insert(risks).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      number,
      title: body.title,
      description: body.description ?? null,
      category: body.category,
      status: "open",
      ownerId: body.ownerId ?? null,
      probabilityScore: body.probabilityScore,
      impactScore: body.impactScore,
      postProbabilityScore: body.postProbabilityScore ?? null,
      postImpactScore: body.postImpactScore ?? null,
      occurrenceProbability: body.occurrenceProbability ?? null,
      costImpact: body.costImpact ?? null,
      scheduleTaskId: body.scheduleTaskId ?? null,
      durationImpact: body.durationImpact ?? null,
      mitigations: body.mitigations ?? [],
      mitigationCost: body.mitigationCost ?? null,
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "risk",
      objectId: id,
      payload: {
        number,
        title: body.title,
        category: body.category,
        probabilityScore: body.probabilityScore,
        impactScore: body.impactScore,
        occurrenceProbability: body.occurrenceProbability ?? null,
      },
      storePayload: true,
    });
    const created = await fetchRisk(id, req.companyId!, req.projectId!);
    return reply.status(201).send(scored(created));
  });

  app.get("/projects/:projectId/risks", { preHandler: readGate }, async (req) => {
    const q = riskListQuery.parse(req.query);
    const clauses = [eq(risks.companyId, req.companyId!), eq(risks.projectId, req.projectId!)];
    if (q.category) clauses.push(eq(risks.category, q.category));
    if (q.status) clauses.push(eq(risks.status, q.status));
    if (q.ownerId) clauses.push(eq(risks.ownerId, q.ownerId));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(risks).where(where);
    const rows = await app.db
      .select()
      .from(risks)
      .where(where)
      .orderBy(desc(risks.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows.map(scored), Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/risks/:riskId", { preHandler: readGate }, async (req) => {
    const { riskId } = req.params as { riskId: string };
    const risk = await fetchRisk(riskId, req.companyId!, req.projectId!);
    return scored(risk);
  });

  app.patch("/projects/:projectId/risks/:riskId", { preHandler: standardGate }, async (req) => {
    const { riskId } = req.params as { riskId: string };
    const body = riskPatchSchema.parse(req.body);
    await fetchRisk(riskId, req.companyId!, req.projectId!);
    if (body.scheduleTaskId) await assertScheduleTask(body.scheduleTaskId, req.projectId!);
    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined) set[k] = v;
    }
    await app.db.update(risks).set(set).where(eq(risks.id, riskId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "risk",
      objectId: riskId,
      payload: { changed: Object.keys(body) },
    });
    return scored(await fetchRisk(riskId, req.companyId!, req.projectId!));
  });

  /**
   * Status transitions are a lifecycle, not a free-text field (#450). A
   * `realised` risk has already driven contingency drawdowns and may be
   * cited in a claim; flipping it back to `open` re-admits the same
   * exposure to the next QCRA and rewrites a record other numbers rely on.
   * The privileged moves need risk:admin AND a stated reason — see
   * transitions.ts for the full table.
   */
  app.post(
    "/projects/:projectId/risks/:riskId/status",
    { preHandler: standardGate },
    async (req) => {
      const { riskId } = req.params as { riskId: string };
      const body = statusSchema.parse(req.body);
      const risk = await fetchRisk(riskId, req.companyId!, req.projectId!);
      const from = risk.status as RiskStatus;
      const isAdmin = await holdsToolLevel(app, req, "risk", "admin");
      const check = checkRiskTransition(from, body.status, {
        isAdmin,
        hasNote: Boolean(body.note?.trim()),
      });
      if (!check.allowed) {
        if (check.requiresAdmin && !isAdmin) throw forbidden(check.reason);
        throw badRequest(check.reason);
      }
      await app.db
        .update(risks)
        .set({ status: body.status, updatedAt: new Date().toISOString() })
        .where(eq(risks.id, riskId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "risk",
        objectId: riskId,
        payload: {
          from,
          to: body.status,
          note: body.note ?? null,
          privileged: check.requiresAdmin,
        },
        storePayload: true,
        projectId: req.projectId!,
      });
      return scored(await fetchRisk(riskId, req.companyId!, req.projectId!));
    },
  );

  /**
   * Mitigation value (#454): is the mitigation worth its cost?
   * EV(before) = occurrenceProbability × analytic mean of costImpact.
   * EV(after)  = EV(before) × (postP×postI)/(preP×preI) — the post-mitigation
   * EV scales by the qualitative score ratio (documented simplification: we
   * do not ask users to re-quantify the distribution post-mitigation). When
   * post scores are absent the ratio is 1 (no modelled reduction).
   */
  app.get(
    "/projects/:projectId/risks/:riskId/mitigation-value",
    { preHandler: readGate },
    async (req) => {
      const { riskId } = req.params as { riskId: string };
      const risk = await fetchRisk(riskId, req.companyId!, req.projectId!);
      if (risk.occurrenceProbability == null || risk.costImpact == null) {
        throw badRequest(
          "Risk is not quantified: occurrenceProbability and costImpact are required for mitigation-value analysis",
        );
      }
      const dist = parseStoredDistribution(risk.costImpact, "costImpact");
      const evBefore = risk.occurrenceProbability * analyticMean(dist);
      const hasPost = risk.postProbabilityScore != null && risk.postImpactScore != null;
      const preProduct = risk.probabilityScore * risk.impactScore;
      const ratio = hasPost
        ? (risk.postProbabilityScore! * risk.postImpactScore!) / preProduct
        : 1;
      const evAfter = evBefore * ratio;
      const riskReduction = evBefore - evAfter;
      const mitigationCost = risk.mitigationCost;
      return {
        riskId,
        mitigationCost,
        expectedValueBefore: round2(evBefore),
        expectedValueAfter: round2(evAfter),
        riskReduction: round2(riskReduction),
        worthwhile: riskReduction > (mitigationCost ?? 0),
        method:
          "EV = occurrenceProbability × analytic mean of costImpact (triangular (a+m+b)/3, PERT (a+4m+b)/6, " +
          "uniform midpoint, normal μ, lognormal exp(μ+σ²/2), discrete weighted mean). Post-mitigation EV scales " +
          "the pre-mitigation EV by (postProbabilityScore×postImpactScore)/(probabilityScore×impactScore) — a " +
          "qualitative-score proxy, not a re-quantified distribution.",
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Simulation jobs (#464, #475-476)                                  */
  /* ---------------------------------------------------------------- */

  /**
   * Every simulation is a JOB ROW, not a request that blocks.
   *
   * The engines used to run inline: `qcraSchema` allows 20,000 iterations
   * over 500 risks and `qsraSchema` 5,000 full CPM passes over every task on
   * the programme, all on the Fastify event loop. One large QSRA froze every
   * tenant's requests on that process, and two concurrent runs serialised
   * the whole API. Now the request writes a job and the runner executes it
   * in batches with the event loop released between each one — off-thread
   * entirely when the API is running compiled (see runner.ts).
   *
   * `async: false` (the default) still returns the finished simulation, so
   * existing callers see the same shape; it simply no longer monopolises the
   * process while it computes. `async: true` returns 202 with a job id to
   * poll.
   */
  const queue = new SimulationQueue({
    db: app.db,
    log: app.log,
    newId,
    onComplete: async ({ job, outcome, simulationId }) => {
      const summary = (outcome.result as { summary?: McSummary }).summary ?? null;
      if (job.kind === "qcra") {
        const base = await deterministicEac(job.companyId, job.projectId);
        const adjusted = riskAdjustedCost(summary, base);
        await app.db
          .update(simulationJobs)
          .set({ riskAdjusted: adjusted as unknown as Record<string, unknown> })
          .where(eq(simulationJobs.id, job.id));
      } else {
        const params = job.params as unknown as SimulationJobParams;
        if (params.kind === "qsra" && summary) {
          const dates = completionDatesFor(summary, params.projectStart, outcome.result);
          await app.db
            .update(simulationJobs)
            .set({ riskAdjusted: dates as unknown as Record<string, unknown> })
            .where(eq(simulationJobs.id, job.id));
          await app.db
            .update(riskSimulations)
            .set({
              results: sql`${riskSimulations.results} || ${JSON.stringify({ completionDates: dates })}::jsonb`,
            })
            .where(eq(riskSimulations.id, simulationId));
        }
      }
      await appendLedger(app.db, {
        companyId: job.companyId,
        actorId: job.requestedBy,
        action: "create",
        objectType: "risk_simulation",
        objectId: simulationId,
        payload: {
          kind: job.kind,
          seed: job.seed,
          iterations: outcome.iterationsRun,
          jobId: job.id,
          converged: outcome.converged,
          executor: outcome.executor,
          p50: summary?.percentiles.p50 ?? null,
          p80: summary?.percentiles.p80 ?? null,
        },
        storePayload: true,
        projectId: job.projectId,
      });
    },
  });
  app.addHook("onClose", async () => queue.close());
  registerRiskJobs(app, queue);

  /**
   * Deterministic estimate at completion from the project's ACTIVE budget
   * (#475). Returns nulls with the currency when there is no active budget —
   * the caller then reports the exposure alone and says why, rather than
   * pretending the base is 0.
   */
  async function deterministicEac(
    companyId: string,
    projectId: string,
  ): Promise<{ eac: number | null; currency: string | null }> {
    const rows = await app.db
      .select({
        forecastFinalTotal: budgets.forecastFinalTotal,
        revisedBudgetTotal: budgets.revisedBudgetTotal,
        currency: budgets.currency,
      })
      .from(budgets)
      .where(
        and(
          eq(budgets.companyId, companyId),
          eq(budgets.projectId, projectId),
          eq(budgets.isActive, 1),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return { eac: null, currency: null };
    const eac = row.forecastFinalTotal > 0 ? row.forecastFinalTotal : row.revisedBudgetTotal;
    return { eac: eac > 0 ? eac : null, currency: row.currency };
  }

  /** Day-count percentiles → ISO completion dates (lib/cpm.ts convention). */
  function completionDatesFor(
    summary: McSummary,
    projectStart: string,
    result: unknown,
  ): Record<string, string> {
    const dayToIso = (d: number) => isoFromDay(Math.max(0, Math.round(d) - 1), projectStart);
    const deterministic = (result as { deterministicDurationDays?: number })
      .deterministicDurationDays;
    return {
      p10: dayToIso(summary.percentiles.p10),
      p50: dayToIso(summary.percentiles.p50),
      p80: dayToIso(summary.percentiles.p80),
      p90: dayToIso(summary.percentiles.p90),
      p95: dayToIso(summary.percentiles.p95),
      mean: dayToIso(summary.mean),
      deterministic: dayToIso(deterministic ?? summary.percentiles.p50),
    };
  }

  async function fetchJob(jobId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(simulationJobs)
      .where(
        and(
          eq(simulationJobs.id, jobId),
          eq(simulationJobs.companyId, companyId),
          eq(simulationJobs.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Simulation job not found");
    return rows[0];
  }

  async function enqueueJob(
    req: { companyId?: string; projectId?: string; user?: { id: string } },
    kind: "qcra" | "qsra",
    params: SimulationJobParams,
    seed: number,
    iterations: number,
  ): Promise<string> {
    const jobId = newId("sjb");
    await app.db.insert(simulationJobs).values({
      id: jobId,
      companyId: req.companyId!,
      projectId: req.projectId!,
      kind,
      status: "queued",
      params: params as unknown as Record<string, unknown>,
      seed,
      iterations,
      requestedBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "simulation_job",
      objectId: jobId,
      payload: { kind, seed, iterations },
      storePayload: true,
      projectId: req.projectId!,
    });
    return jobId;
  }

  /** Job row → the shape the UI polls. */
  function jobView(job: typeof simulationJobs.$inferSelect) {
    return {
      id: job.id,
      kind: job.kind,
      status: job.status,
      seed: job.seed,
      iterations: job.iterations,
      iterationsDone: job.iterationsDone,
      progressPercent:
        job.iterations > 0 ? Math.round((job.iterationsDone / job.iterations) * 100) : 0,
      convergence: job.convergence,
      converged: job.converged === 1,
      simulationId: job.simulationId,
      riskAdjusted: job.riskAdjusted,
      error: job.error,
      requestedBy: job.requestedBy,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      createdAt: job.createdAt,
    };
  }

  /* ---------------------------------------------------------------- */
  /* QCRA — quantitative cost risk analysis (#458-466)                 */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/risk/simulations/qcra",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = qcraSchema.parse(req.body);
      const seed = body.seed ?? Date.now() % MAX_SEED;

      let candidates;
      if (body.riskIds) {
        candidates = await app.db
          .select()
          .from(risks)
          .where(
            and(
              eq(risks.companyId, req.companyId!),
              eq(risks.projectId, req.projectId!),
              inArray(risks.id, body.riskIds),
            ),
          );
        const found = new Set(candidates.map((r) => r.id));
        const missing = body.riskIds.filter((id) => !found.has(id));
        if (missing.length > 0) {
          throw badRequest(`Unknown riskIds for this project: ${missing.join(", ")}`);
        }
        const unquantified = candidates.filter(
          (r) => r.occurrenceProbability == null || r.costImpact == null,
        );
        if (unquantified.length > 0) {
          throw badRequest(
            `Risks are not quantified (need occurrenceProbability + costImpact): ${unquantified
              .map((r) => `#${r.number}`)
              .join(", ")}`,
          );
        }
      } else {
        candidates = await app.db
          .select()
          .from(risks)
          .where(
            and(
              eq(risks.companyId, req.companyId!),
              eq(risks.projectId, req.projectId!),
              inArray(risks.status, ["open", "mitigating"]),
              isNotNull(risks.occurrenceProbability),
              isNotNull(risks.costImpact),
            ),
          );
      }
      if (candidates.length === 0) {
        throw badRequest(
          "No quantified risks to simulate: give risks an occurrenceProbability and a costImpact distribution first",
        );
      }
      candidates.sort((a, b) => a.number - b.number);

      const riskInputs: QcraRiskInput[] = candidates.map((r) => ({
        id: r.id,
        name: r.title,
        probability: r.occurrenceProbability!,
        impact: parseStoredDistribution(r.costImpact, `risk #${r.number} costImpact`),
      }));

      const params: SimulationJobParams = {
        kind: "qcra",
        risks: riskInputs,
        riskIds: riskInputs.map((r) => r.id),
      };
      const jobId = await enqueueJob(req, "qcra", params, seed, body.iterations);
      if (body.async) {
        queue.schedule();
        const job = await fetchJob(jobId, req.companyId!, req.projectId!);
        return reply.status(202).send({ job: jobView(job), riskCount: riskInputs.length });
      }
      await queue.runById(jobId);
      const job = await fetchJob(jobId, req.companyId!, req.projectId!);
      if (job.status !== "done" || !job.simulationId) {
        throw badRequest(job.error ?? "The simulation did not complete");
      }
      const sim = await fetchSimulation(job.simulationId, req.companyId!, req.projectId!);
      return reply.status(201).send({
        simulationId: sim.id,
        jobId,
        kind: "qcra",
        seed,
        iterations: sim.iterations,
        riskCount: riskInputs.length,
        converged: job.converged === 1,
        riskAdjusted: job.riskAdjusted,
        ...sim.results,
      });
    },
  );

  /* ---------------------------------------------------------------- */
  /* QSRA — quantitative schedule risk analysis (#457)                 */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/risk/simulations/qsra",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = qsraSchema.parse(req.body);
      const seed = body.seed ?? Date.now() % MAX_SEED;

      let schedule;
      if (body.scheduleId) {
        const rows = await app.db
          .select()
          .from(schedules)
          .where(
            and(
              eq(schedules.id, body.scheduleId),
              eq(schedules.companyId, req.companyId!),
              eq(schedules.projectId, req.projectId!),
            ),
          )
          .limit(1);
        if (!rows[0]) throw notFound("Schedule not found");
        schedule = rows[0];
      } else {
        const rows = await app.db
          .select()
          .from(schedules)
          .where(
            and(
              eq(schedules.companyId, req.companyId!),
              eq(schedules.projectId, req.projectId!),
              eq(schedules.isActive, 1),
            ),
          )
          .orderBy(asc(schedules.createdAt))
          .limit(1);
        if (!rows[0]) throw badRequest("No active schedule on this project — pass scheduleId");
        schedule = rows[0];
      }

      const taskRows = await app.db
        .select()
        .from(scheduleTasks)
        .where(eq(scheduleTasks.scheduleId, schedule.id))
        .orderBy(asc(scheduleTasks.sortOrder), asc(scheduleTasks.createdAt), asc(scheduleTasks.id));
      if (taskRows.length === 0) throw badRequest("Schedule has no tasks to simulate");
      const depRows = await app.db
        .select()
        .from(scheduleDependencies)
        .where(eq(scheduleDependencies.scheduleId, schedule.id));
      const taskIds = new Set(taskRows.map((t) => t.id));

      // Duration distributions: risk-linked durationImpact first (applied
      // UNCONDITIONALLY — the occurrence probability is a QCRA concept and is
      // deliberately not applied here; documented simplification), explicit
      // taskUncertainties override per task.
      const distByTask = new Map<string, { distribution: Distribution; source: string }>();
      const linkedRisks = await app.db
        .select()
        .from(risks)
        .where(
          and(
            eq(risks.companyId, req.companyId!),
            eq(risks.projectId, req.projectId!),
            inArray(risks.status, ["open", "mitigating"]),
            isNotNull(risks.scheduleTaskId),
            isNotNull(risks.durationImpact),
          ),
        );
      linkedRisks.sort((a, b) => a.number - b.number);
      for (const r of linkedRisks) {
        if (!taskIds.has(r.scheduleTaskId!)) continue; // linked to another schedule
        distByTask.set(r.scheduleTaskId!, {
          distribution: parseStoredDistribution(r.durationImpact, `risk #${r.number} durationImpact`),
          source: `risk:${r.id}`,
        });
      }
      for (const u of body.taskUncertainties ?? []) {
        if (!taskIds.has(u.taskId)) {
          throw badRequest(`taskUncertainties.taskId ${u.taskId} is not on this schedule`);
        }
        distByTask.set(u.taskId, {
          distribution: u.distribution as Distribution,
          source: "request",
        });
      }

      const qsraTasks: QsraTaskInput[] = taskRows.map((t) => ({
        id: t.id,
        duration: t.durationDays,
        constraintType: (t.constraintType as TaskConstraintType | null) ?? null,
        constraintDate: t.constraintDate,
        actualStart: t.actualStart,
        actualFinish: t.actualFinish,
        ...(distByTask.has(t.id)
          ? { durationDistribution: distByTask.get(t.id)!.distribution }
          : {}),
      }));
      const cpmDeps: CpmDependencyInput[] = depRows.map((d) => ({
        predecessorId: d.predecessorId,
        successorId: d.successorId,
        type: d.depType as DependencyType,
        lagDays: d.lagDays,
      }));

      const params: SimulationJobParams = {
        kind: "qsra",
        scheduleId: schedule.id,
        projectStart: schedule.projectStart,
        tasks: qsraTasks,
        deps: cpmDeps,
        distributionSources: Object.fromEntries(
          [...distByTask.entries()].map(([taskId, v]) => [taskId, v.source]),
        ),
      };
      const jobId = await enqueueJob(req, "qsra", params, seed, body.iterations);
      if (body.async) {
        queue.schedule();
        const job = await fetchJob(jobId, req.companyId!, req.projectId!);
        return reply
          .status(202)
          .send({ job: jobView(job), scheduleId: schedule.id, taskCount: qsraTasks.length });
      }
      await queue.runById(jobId);
      const job = await fetchJob(jobId, req.companyId!, req.projectId!);
      if (job.status !== "done" || !job.simulationId) {
        throw badRequest(job.error ?? "The simulation did not complete");
      }
      const sim = await fetchSimulation(job.simulationId, req.companyId!, req.projectId!);
      return reply.status(201).send({
        simulationId: sim.id,
        jobId,
        kind: "qsra",
        seed,
        iterations: sim.iterations,
        scheduleId: schedule.id,
        projectStart: schedule.projectStart,
        converged: job.converged === 1,
        ...sim.results,
      });
    },
  );

  /* ---------------------------------------------------------------- */
  /* Job polling and the queue                                         */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/risk/simulation-jobs", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    const where = and(
      eq(simulationJobs.companyId, req.companyId!),
      eq(simulationJobs.projectId, req.projectId!),
    );
    const [totalRow] = await app.db.select({ n: count() }).from(simulationJobs).where(where);
    const rows = await app.db
      .select()
      .from(simulationJobs)
      .where(where)
      .orderBy(desc(simulationJobs.createdAt), desc(simulationJobs.id))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows.map(jobView), Number(totalRow?.n ?? 0), q);
  });

  app.get(
    "/projects/:projectId/risk/simulation-jobs/:jobId",
    { preHandler: readGate },
    async (req) => {
      const { jobId } = req.params as { jobId: string };
      return jobView(await fetchJob(jobId, req.companyId!, req.projectId!));
    },
  );

  /**
   * Drain the queue on demand. The scheduler runs it on an interval; this is
   * the manual trigger tests and operators use, and it is idempotent — a
   * queue with nothing in it returns `{ ran: 0 }`.
   */
  app.post(
    "/projects/:projectId/risk/simulation-jobs/run",
    { preHandler: standardGate },
    async () => {
      const ran = await queue.drain();
      return { ran };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Simulation history + reproducibility (#464-466)                   */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/risk/simulations", { preHandler: readGate }, async (req) => {
    const q = simulationListQuery.parse(req.query);
    const clauses = [
      eq(riskSimulations.companyId, req.companyId!),
      eq(riskSimulations.projectId, req.projectId!),
    ];
    if (q.kind) clauses.push(eq(riskSimulations.kind, q.kind));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(riskSimulations).where(where);
    const rows = await app.db
      .select()
      .from(riskSimulations)
      .where(where)
      .orderBy(desc(riskSimulations.createdAt), desc(riskSimulations.id))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const items = rows.map((s) => {
      const summary = (s.results["summary"] ?? null) as SummaryLike | null;
      return {
        id: s.id,
        kind: s.kind,
        seed: s.seed,
        iterations: s.iterations,
        runBy: s.runBy,
        createdAt: s.createdAt,
        summary: summary
          ? {
              mean: summary.mean ?? null,
              min: summary.min ?? null,
              max: summary.max ?? null,
              percentiles: summary.percentiles ?? null,
            }
          : null,
      };
    });
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get(
    "/projects/:projectId/risk-simulations/:simId",
    { preHandler: readGate },
    async (req) => {
      const { simId } = req.params as { simId: string };
      return fetchSimulation(simId, req.companyId!, req.projectId!);
    },
  );

  /**
   * Reproducibility check (#464): replay the stored input snapshot with the
   * stored seed and verify the fresh percentiles deep-equal the persisted
   * ones. This is the audit answer to "prove that P80" — same inputs + seed
   * must give the same numbers, or the record has been tampered with / the
   * engine has drifted.
   */
  app.post(
    "/projects/:projectId/risk-simulations/:simId/rerun",
    { preHandler: readGate },
    async (req) => {
      const { simId } = req.params as { simId: string };
      const sim = await fetchSimulation(simId, req.companyId!, req.projectId!);
      let fresh: SummaryLike;
      if (sim.kind === "qcra") {
        const inputs = sim.inputs as { risks?: QcraRiskInput[] };
        if (!Array.isArray(inputs.risks)) throw badRequest("Stored QCRA inputs are incomplete");
        fresh = runQcra(inputs.risks, { iterations: sim.iterations, seed: sim.seed }).summary;
      } else {
        const inputs = sim.inputs as {
          tasks?: QsraTaskInput[];
          deps?: CpmDependencyInput[];
          projectStart?: string;
        };
        if (!Array.isArray(inputs.tasks) || !Array.isArray(inputs.deps) || !inputs.projectStart) {
          throw badRequest("Stored QSRA inputs are incomplete");
        }
        fresh = runQsra(inputs.tasks, inputs.deps, {
          projectStart: inputs.projectStart,
          iterations: sim.iterations,
          seed: sim.seed,
        }).summary;
      }
      const stored = (sim.results["summary"] ?? {}) as SummaryLike;
      const reproduced =
        JSON.stringify(stored.percentiles ?? null) === JSON.stringify(fresh.percentiles ?? null);
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "access",
        objectType: "risk_simulation",
        objectId: simId,
        payload: { verification: "rerun", reproduced },
      });
      return {
        simulationId: simId,
        kind: sim.kind,
        seed: sim.seed,
        iterations: sim.iterations,
        reproduced,
        expected: stored.percentiles ?? null,
        actual: fresh.percentiles ?? null,
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Contingency register + drawdown discipline (#469-473)             */
  /* ---------------------------------------------------------------- */

  async function drawnTotal(contingencyId: string): Promise<number> {
    const rows = await app.db
      .select({ amount: contingencyDrawdowns.amount })
      .from(contingencyDrawdowns)
      .where(eq(contingencyDrawdowns.contingencyId, contingencyId));
    return rows.reduce((s, r) => s + r.amount, 0);
  }

  app.post(
    "/projects/:projectId/contingencies",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = contingencyCreateSchema.parse(req.body);
      if (body.simulationId) {
        await fetchSimulation(body.simulationId, req.companyId!, req.projectId!).catch(() => {
          throw badRequest("simulationId does not belong to this project");
        });
      }
      const id = newId("ctg");
      await app.db.insert(contingencies).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        name: body.name,
        currency: body.currency ?? "GBP",
        amount: body.amount,
        confidenceLevel: body.confidenceLevel ?? null,
        simulationId: body.simulationId ?? null,
        isManagementReserve: body.isManagementReserve ? 1 : 0,
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "contingency",
        objectId: id,
        payload: {
          name: body.name,
          amount: body.amount,
          confidenceLevel: body.confidenceLevel ?? null,
          simulationId: body.simulationId ?? null,
          isManagementReserve: Boolean(body.isManagementReserve),
        },
        storePayload: true,
      });
      const created = await fetchContingency(id, req.companyId!, req.projectId!);
      return reply.status(201).send({ ...created, drawnTotal: 0, remaining: created.amount });
    },
  );

  app.get("/projects/:projectId/contingencies", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    const where = and(
      eq(contingencies.companyId, req.companyId!),
      eq(contingencies.projectId, req.projectId!),
    );
    const [totalRow] = await app.db.select({ n: count() }).from(contingencies).where(where);
    const rows = await app.db
      .select()
      .from(contingencies)
      .where(where)
      .orderBy(desc(contingencies.createdAt), desc(contingencies.id))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const draws =
      rows.length === 0
        ? []
        : await app.db
            .select({
              contingencyId: contingencyDrawdowns.contingencyId,
              amount: contingencyDrawdowns.amount,
            })
            .from(contingencyDrawdowns)
            .where(
              inArray(
                contingencyDrawdowns.contingencyId,
                rows.map((c) => c.id),
              ),
            );
    const drawnBy = new Map<string, number>();
    for (const d of draws) {
      drawnBy.set(d.contingencyId, (drawnBy.get(d.contingencyId) ?? 0) + d.amount);
    }
    const items = rows.map((c) => {
      const drawn = round2(drawnBy.get(c.id) ?? 0);
      return { ...c, drawnTotal: drawn, remaining: round2(c.amount - drawn) };
    });
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  /**
   * The over-draw invariant, made real (#469-473).
   *
   * This used to be a read-then-insert with no transaction: `drawnTotal()`
   * was read, compared, and the drawdown inserted afterwards. Two concurrent
   * 60,000 draws against a contingency with 100,000 left both passed the
   * check and both inserted — remaining went to −20,000 and the exhaustion
   * signal fired twice or not at all, because each evaluated a stale
   * `remainingBefore`. Protecting that one number is the reason the register
   * exists, so the whole sequence now runs inside a transaction with the
   * contingency row locked FOR UPDATE. The second writer waits, re-reads,
   * and is correctly refused.
   */
  async function insertDrawdown(
    tx: Parameters<Parameters<typeof app.db.transaction>[0]>[0],
    args: {
      contingencyId: string;
      companyId: string;
      projectId: string;
      amount: number;
      reason: string;
      riskId: string | null;
      drawnAt: string;
      approvedBy: string;
      releaseId?: string | null;
    },
  ): Promise<{
    id: string;
    drawnTotal: number;
    remaining: number;
    exhaustionSignal: boolean;
    currency: string;
    name: string;
  }> {
    const locked = (
      await tx
        .select()
        .from(contingencies)
        .where(
          and(
            eq(contingencies.id, args.contingencyId),
            eq(contingencies.companyId, args.companyId),
            eq(contingencies.projectId, args.projectId),
          ),
        )
        .for("update")
    )[0];
    if (!locked) throw notFound("Contingency not found");

    const priorRows = await tx
      .select({ amount: contingencyDrawdowns.amount })
      .from(contingencyDrawdowns)
      .where(eq(contingencyDrawdowns.contingencyId, args.contingencyId));
    const drawnBefore = priorRows.reduce((s, r) => s + r.amount, 0);
    const remainingBefore = locked.amount - drawnBefore;
    if (args.amount > remainingBefore + 1e-9) {
      throw conflict(
        `Drawdown of ${args.amount} exceeds the remaining contingency of ${round2(remainingBefore)} ` +
          `(${locked.currency} ${locked.amount} budget, ${round2(drawnBefore)} already drawn)`,
      );
    }

    const id = newId("cdd");
    await tx.insert(contingencyDrawdowns).values({
      id,
      contingencyId: args.contingencyId,
      companyId: args.companyId,
      projectId: args.projectId,
      amount: args.amount,
      reason: args.reason,
      riskId: args.riskId,
      drawnAt: args.drawnAt,
      approvedBy: args.approvedBy,
    });

    const remainingAfter = remainingBefore - args.amount;
    const threshold = EXHAUSTION_FRACTION * locked.amount;
    // Fire exactly once: only on the draw that CROSSES the 20% line (#473).
    // Inside the lock this is now genuinely once, not once per racer.
    const exhaustionSignal = remainingBefore >= threshold && remainingAfter < threshold;
    if (exhaustionSignal) {
      await tx.insert(signals).values({
        id: newId("sig"),
        companyId: args.companyId,
        projectId: args.projectId,
        detector: "contingency_exhaustion",
        severity: "high",
        confidence: 1,
        title: `Contingency "${locked.name}" below 20% remaining`,
        explanation:
          `A drawdown of ${locked.currency} ${args.amount} (${args.reason}) leaves ` +
          `${locked.currency} ${round2(remainingAfter)} of the ${locked.currency} ${locked.amount} ` +
          `contingency "${locked.name}" — under the 20% exhaustion threshold of ` +
          `${locked.currency} ${round2(threshold)}. Remaining cover may not absorb the ` +
          `residual risk exposure; review the risk register and replenishment options.`,
        fingerprint: `contingency_exhaustion:${args.contingencyId}`,
        subjectType: "contingency",
        subjectId: args.contingencyId,
      });
    }
    await appendLedger(tx as never, {
      companyId: args.companyId,
      actorId: args.approvedBy,
      action: "create",
      objectType: "contingency_drawdown",
      objectId: id,
      payload: {
        contingencyId: args.contingencyId,
        amount: args.amount,
        reason: args.reason,
        riskId: args.riskId,
        drawnAt: args.drawnAt,
        remainingAfter: round2(remainingAfter),
        releaseId: args.releaseId ?? null,
      },
      storePayload: true,
      projectId: args.projectId,
    });
    return {
      id,
      drawnTotal: round2(drawnBefore + args.amount),
      remaining: round2(remainingAfter),
      exhaustionSignal,
      currency: locked.currency,
      name: locked.name,
    };
  }

  app.post(
    "/projects/:projectId/contingencies/:contingencyId/drawdowns",
    { preHandler: standardGate },
    async (req, reply) => {
      const { contingencyId } = req.params as { contingencyId: string };
      const body = drawdownSchema.parse(req.body);
      await fetchContingency(contingencyId, req.companyId!, req.projectId!);
      if (body.riskId) {
        await fetchRisk(body.riskId, req.companyId!, req.projectId!).catch(() => {
          throw badRequest("riskId does not belong to this project");
        });
      }
      // Above the release threshold, a direct draw is refused: money leaving
      // the risk pot at that size goes through request → approval by someone
      // else (#471-472).
      if (body.amount > DIRECT_DRAWDOWN_THRESHOLD) {
        const isAdmin = await holdsToolLevel(app, req, "risk", "admin");
        if (!isAdmin) {
          throw forbidden(
            `A drawdown of ${body.amount} exceeds the direct-draw threshold of ` +
              `${DIRECT_DRAWDOWN_THRESHOLD}. Raise a contingency release request instead — it is ` +
              `approved by someone other than the requester and the over-draw check runs in the ` +
              `approving transaction.`,
          );
        }
      }
      const outcome = await app.db.transaction((tx) =>
        insertDrawdown(tx, {
          contingencyId,
          companyId: req.companyId!,
          projectId: req.projectId!,
          amount: body.amount,
          reason: body.reason,
          riskId: body.riskId ?? null,
          drawnAt: body.drawnAt,
          approvedBy: req.user!.id,
        }),
      );
      const [row] = await app.db
        .select()
        .from(contingencyDrawdowns)
        .where(eq(contingencyDrawdowns.id, outcome.id))
        .limit(1);
      return reply.status(201).send({
        ...row,
        drawnTotal: outcome.drawnTotal,
        remaining: outcome.remaining,
        exhaustionSignal: outcome.exhaustionSignal,
      });
    },
  );

  /* ---------------------------------------------------------------- */
  /* Contingency release authority workflow (#471-472)                 */
  /* ---------------------------------------------------------------- */

  async function fetchRelease(releaseId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(contingencyReleases)
      .where(
        and(
          eq(contingencyReleases.id, releaseId),
          eq(contingencyReleases.companyId, companyId),
          eq(contingencyReleases.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Contingency release not found");
    return rows[0];
  }

  app.post(
    "/projects/:projectId/contingencies/:contingencyId/releases",
    { preHandler: standardGate },
    async (req, reply) => {
      const { contingencyId } = req.params as { contingencyId: string };
      const body = releaseRequestSchema.parse(req.body);
      const cont = await fetchContingency(contingencyId, req.companyId!, req.projectId!);
      if (body.riskId) {
        await fetchRisk(body.riskId, req.companyId!, req.projectId!).catch(() => {
          throw badRequest("riskId does not belong to this project");
        });
      }
      const id = newId("crl");
      const requiresAdmin = body.amount > DIRECT_DRAWDOWN_THRESHOLD;
      await app.db.insert(contingencyReleases).values({
        id,
        contingencyId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        amount: body.amount,
        reason: body.reason,
        riskId: body.riskId ?? null,
        drawnAt: body.drawnAt,
        status: "requested",
        requiresAdmin: requiresAdmin ? 1 : 0,
        requestedBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "contingency_release",
        objectId: id,
        payload: {
          contingencyId,
          amount: body.amount,
          reason: body.reason,
          currency: cont.currency,
          requiresAdmin,
        },
        storePayload: true,
        projectId: req.projectId!,
      });
      return reply.status(201).send(await fetchRelease(id, req.companyId!, req.projectId!));
    },
  );

  app.get(
    "/projects/:projectId/contingencies/:contingencyId/releases",
    { preHandler: readGate },
    async (req) => {
      const { contingencyId } = req.params as { contingencyId: string };
      await fetchContingency(contingencyId, req.companyId!, req.projectId!);
      const items = await app.db
        .select()
        .from(contingencyReleases)
        .where(
          and(
            eq(contingencyReleases.contingencyId, contingencyId),
            eq(contingencyReleases.companyId, req.companyId!),
          ),
        )
        .orderBy(desc(contingencyReleases.createdAt), desc(contingencyReleases.id));
      return { items, total: items.length };
    },
  );

  /**
   * Approve a release: separation of duties (requester ≠ approver), an
   * admin-only branch above the threshold, and the over-draw check moved
   * INSIDE the transaction that writes the drawdown. Approving is the
   * moment money leaves the pot, so it is the moment the invariant is
   * enforced — not when the request was raised.
   */
  app.post(
    "/projects/:projectId/contingency-releases/:releaseId/approve",
    { preHandler: standardGate },
    async (req) => {
      const { releaseId } = req.params as { releaseId: string };
      const body = releaseDecisionSchema.parse(req.body ?? {});
      const release = await fetchRelease(releaseId, req.companyId!, req.projectId!);
      if (release.status !== "requested") {
        throw badRequest(`A ${release.status} release cannot be approved`);
      }
      if (release.requestedBy === req.user!.id) {
        throw forbidden(
          "Separation of duties: a contingency release cannot be approved by the person who requested it.",
        );
      }
      if (release.requiresAdmin === 1) {
        const isAdmin = await holdsToolLevel(app, req, "risk", "admin");
        if (!isAdmin) {
          throw forbidden(
            `A release of ${release.amount} is above the ${DIRECT_DRAWDOWN_THRESHOLD} threshold and requires risk:admin to approve.`,
          );
        }
      }
      const now = new Date().toISOString();
      const outcome = await app.db.transaction(async (tx) => {
        const locked = (
          await tx
            .select()
            .from(contingencyReleases)
            .where(eq(contingencyReleases.id, releaseId))
            .for("update")
        )[0];
        if (!locked || locked.status !== "requested") {
          throw conflict("This release has already been decided");
        }
        const draw = await insertDrawdown(tx, {
          contingencyId: release.contingencyId,
          companyId: req.companyId!,
          projectId: req.projectId!,
          amount: release.amount,
          reason: release.reason,
          riskId: release.riskId,
          drawnAt: release.drawnAt,
          approvedBy: req.user!.id,
          releaseId,
        });
        await tx
          .update(contingencyReleases)
          .set({
            status: "approved",
            decidedBy: req.user!.id,
            decidedAt: now,
            decisionNote: body.note ?? null,
            drawdownId: draw.id,
            updatedAt: now,
          })
          .where(eq(contingencyReleases.id, releaseId));
        await appendLedger(tx as never, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "state_change",
          objectType: "contingency_release",
          objectId: releaseId,
          payload: {
            from: "requested",
            to: "approved",
            drawdownId: draw.id,
            remaining: draw.remaining,
          },
          storePayload: true,
          projectId: req.projectId!,
        });
        return draw;
      });
      return {
        ...(await fetchRelease(releaseId, req.companyId!, req.projectId!)),
        drawnTotal: outcome.drawnTotal,
        remaining: outcome.remaining,
        exhaustionSignal: outcome.exhaustionSignal,
      };
    },
  );

  for (const verb of ["reject", "withdraw"] as const) {
    app.post(
      `/projects/:projectId/contingency-releases/:releaseId/${verb}`,
      { preHandler: standardGate },
      async (req) => {
        const { releaseId } = req.params as { releaseId: string };
        const body = releaseDecisionSchema.parse(req.body ?? {});
        const release = await fetchRelease(releaseId, req.companyId!, req.projectId!);
        if (release.status !== "requested") {
          throw badRequest(`A ${release.status} release cannot be ${verb}n`);
        }
        if (verb === "withdraw" && release.requestedBy !== req.user!.id) {
          throw forbidden("Only the requester may withdraw their own release request.");
        }
        if (verb === "reject" && release.requestedBy === req.user!.id) {
          throw forbidden(
            "Separation of duties: a release cannot be rejected by the person who requested it — withdraw it instead.",
          );
        }
        const now = new Date().toISOString();
        await app.db
          .update(contingencyReleases)
          .set({
            status: verb === "reject" ? "rejected" : "withdrawn",
            decidedBy: req.user!.id,
            decidedAt: now,
            decisionNote: body.note ?? null,
            updatedAt: now,
          })
          .where(
            and(eq(contingencyReleases.id, releaseId), eq(contingencyReleases.status, "requested")),
          );
        await appendLedger(app.db, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "state_change",
          objectType: "contingency_release",
          objectId: releaseId,
          payload: { from: "requested", to: verb === "reject" ? "rejected" : "withdrawn", note: body.note ?? null },
          storePayload: true,
          projectId: req.projectId!,
        });
        return fetchRelease(releaseId, req.companyId!, req.projectId!);
      },
    );
  }

  /* ---------------------------------------------------------------- */
  /* Planned drawdown curve (#451, #471)                               */
  /* ---------------------------------------------------------------- */

  app.put(
    "/projects/:projectId/contingencies/:contingencyId/plan",
    { preHandler: standardGate },
    async (req) => {
      const { contingencyId } = req.params as { contingencyId: string };
      const body = planPutSchema.parse(req.body);
      const cont = await fetchContingency(contingencyId, req.companyId!, req.projectId!);
      let points: PlanPoint[];
      let source: string;
      if (body.points) {
        points = body.points.map((p) => ({
          date: p.date,
          plannedRemaining: p.plannedRemaining,
        }));
        source = "manual";
        for (const p of points) {
          if (p.plannedRemaining < 0 || p.plannedRemaining > cont.amount + 1e-9) {
            throw badRequest(
              `Planned remaining ${p.plannedRemaining} at ${p.date} is outside the contingency budget of ${cont.amount}`,
            );
          }
        }
      } else if (body.shape && body.startDate && body.endDate) {
        points = generatePlanCurve({
          amount: cont.amount,
          startDate: body.startDate,
          endDate: body.endDate,
          shape: body.shape as ContingencyCurveShape,
          points: body.intervals,
          endRemaining: body.endRemaining,
        });
        source = body.shape;
      } else {
        throw badRequest(
          "Provide either explicit points, or a shape with startDate and endDate to generate a curve",
        );
      }
      await app.db.transaction(async (tx) => {
        await tx
          .delete(contingencyPlanPoints)
          .where(eq(contingencyPlanPoints.contingencyId, contingencyId));
        if (points.length > 0) {
          await tx.insert(contingencyPlanPoints).values(
            points.map((p) => ({
              id: newId("cpp"),
              contingencyId,
              companyId: req.companyId!,
              projectId: req.projectId!,
              pointDate: p.date,
              plannedRemaining: p.plannedRemaining,
              source,
            })),
          );
        }
        await appendLedger(tx as never, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "update",
          objectType: "contingency",
          objectId: contingencyId,
          payload: { plan: source, points: points.length },
          storePayload: true,
          projectId: req.projectId!,
        });
      });
      return { contingencyId, source, points, total: points.length };
    },
  );

  /** Ordered cumulative drawdown curve for charting (#472). */
  app.get(
    "/projects/:projectId/contingencies/:contingencyId/drawdown-curve",
    { preHandler: readGate },
    async (req) => {
      const { contingencyId } = req.params as { contingencyId: string };
      const cont = await fetchContingency(contingencyId, req.companyId!, req.projectId!);
      const rows = await app.db
        .select()
        .from(contingencyDrawdowns)
        .where(eq(contingencyDrawdowns.contingencyId, contingencyId))
        .orderBy(
          asc(contingencyDrawdowns.drawnAt),
          asc(contingencyDrawdowns.createdAt),
          asc(contingencyDrawdowns.id),
        );
      let cumulative = 0;
      const points = rows.map((d) => {
        cumulative += d.amount;
        return {
          date: d.drawnAt,
          amount: d.amount,
          drawn: round2(cumulative),
          remaining: round2(cont.amount - cumulative),
          riskId: d.riskId,
          reason: d.reason,
        };
      });
      // The planned series next to the actual one — a drawdown curve with
      // nothing to compare against cannot answer the only question worth
      // asking of it, which is whether the burn is ahead of plan (#451).
      const planRows = await app.db
        .select()
        .from(contingencyPlanPoints)
        .where(eq(contingencyPlanPoints.contingencyId, contingencyId))
        .orderBy(asc(contingencyPlanPoints.pointDate));
      const plan: PlanPoint[] = planRows.map((p) => ({
        date: p.pointDate,
        plannedRemaining: p.plannedRemaining,
      }));
      const drift = assessDrift({
        amount: cont.amount,
        actualRemaining: round2(cont.amount - cumulative),
        plan,
        asOf: todayISO(),
      });
      return {
        contingencyId,
        name: cont.name,
        currency: cont.currency,
        amount: cont.amount,
        points,
        plan,
        planSource: planRows[0]?.source ?? null,
        drift,
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Risk appetite (#472)                                              */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/risk/appetite", { preHandler: readGate }, async (req) => {
    const rules = await app.db
      .select()
      .from(riskAppetites)
      .where(
        and(
          eq(riskAppetites.companyId, req.companyId!),
          eq(riskAppetites.projectId, req.projectId!),
        ),
      )
      .orderBy(asc(riskAppetites.scope), asc(riskAppetites.category));
    const register = await app.db
      .select()
      .from(risks)
      .where(and(eq(risks.companyId, req.companyId!), eq(risks.projectId, req.projectId!)));
    const inputs: AppetiteRiskInput[] = register.map(toAppetiteRiskInput);
    const breaches = evaluateAppetite(
      rules.map(
        (r): AppetiteRule => ({
          id: r.id,
          scope: r.scope === "category" ? "category" : "project",
          category: r.category,
          maxScore: r.maxScore,
          maxExpectedValue: r.maxExpectedValue,
          currency: r.currency,
        }),
      ),
      inputs,
    );
    return {
      rules,
      breaches,
      liveRisks: inputs.filter((r) => r.status === "open" || r.status === "mitigating").length,
      quantifiedRisks: inputs.filter((r) => r.expectedValue !== null).length,
      basis:
        "Appetite is evaluated against the post-mitigation score where one is recorded, otherwise " +
        "the pre-mitigation score, and against the analytic expected value (occurrence probability × " +
        "the mean of the cost distribution) for quantified risks. Closed and realised risks are not " +
        "exposure and are excluded.",
    };
  });

  /**
   * Upsert one appetite rule. Setting neither threshold deletes the rule —
   * an appetite with no limit is not an appetite.
   */
  app.put("/projects/:projectId/risk/appetite", { preHandler: standardGate }, async (req) => {
    const body = appetitePutSchema.parse(req.body);
    if (body.scope === "category" && !body.category) {
      throw badRequest("A category-scoped appetite rule needs a category");
    }
    const category = body.scope === "category" ? (body.category ?? null) : null;
    const existing = await app.db
      .select()
      .from(riskAppetites)
      .where(
        and(
          eq(riskAppetites.companyId, req.companyId!),
          eq(riskAppetites.projectId, req.projectId!),
          eq(riskAppetites.scope, body.scope),
          category === null
            ? sql`${riskAppetites.category} is null`
            : eq(riskAppetites.category, category),
        ),
      )
      .limit(1);
    const now = new Date().toISOString();
    const noLimits = body.maxScore == null && body.maxExpectedValue == null;
    if (noLimits) {
      if (!existing[0]) throw badRequest("An appetite rule needs a maxScore or a maxExpectedValue");
      await app.db.delete(riskAppetites).where(eq(riskAppetites.id, existing[0].id));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "risk_appetite",
        objectId: existing[0].id,
        payload: { scope: body.scope, category },
        projectId: req.projectId!,
      });
      return { deleted: true, scope: body.scope, category };
    }
    const id = existing[0]?.id ?? newId("rap");
    const values = {
      maxScore: body.maxScore ?? null,
      maxExpectedValue: body.maxExpectedValue ?? null,
      currency: body.currency ?? existing[0]?.currency ?? "GBP",
      note: body.note ?? null,
      updatedAt: now,
    };
    if (existing[0]) {
      await app.db.update(riskAppetites).set(values).where(eq(riskAppetites.id, id));
    } else {
      await app.db.insert(riskAppetites).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        scope: body.scope,
        category,
        createdBy: req.user!.id,
        ...values,
      });
    }
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: existing[0] ? "update" : "create",
      objectType: "risk_appetite",
      objectId: id,
      payload: { scope: body.scope, category, ...values },
      storePayload: true,
      projectId: req.projectId!,
    });
    const [row] = await app.db.select().from(riskAppetites).where(eq(riskAppetites.id, id)).limit(1);
    return row;
  });

  app.delete(
    "/projects/:projectId/contingencies/:contingencyId",
    { preHandler: standardGate },
    async (req, reply) => {
      const { contingencyId } = req.params as { contingencyId: string };
      await fetchContingency(contingencyId, req.companyId!, req.projectId!);
      const [drawRow] = await app.db
        .select({ n: count() })
        .from(contingencyDrawdowns)
        .where(eq(contingencyDrawdowns.contingencyId, contingencyId));
      if (Number(drawRow?.n ?? 0) > 0) {
        throw conflict("A contingency with recorded drawdowns cannot be deleted");
      }
      await app.db.delete(contingencies).where(eq(contingencies.id, contingencyId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "contingency",
        objectId: contingencyId,
        payload: null,
      });
      return reply.status(204).send();
    },
  );

  /* ---------------------------------------------------------------- */
  /* Reference class forecasting (#402-405)                            */
  /* ---------------------------------------------------------------- */

  const companyReadGate = [app.authenticate, app.requireCompany, companyToolGate(app, "risk", "read")];
  const companyStandardGate = [
    app.authenticate,
    app.requireCompany,
    companyToolGate(app, "risk", "standard"),
  ];

  /**
   * The published optimism bias table (#402). It is guidance, not tenant
   * data, so it lives in code and is served read-only — a table anyone can
   * edit is a table nobody can cite.
   */
  app.get("/risk/optimism-bias", { preHandler: companyReadGate }, async () => ({
    source:
      "HM Treasury Green Book Supplementary Guidance on optimism bias (Mott MacDonald review), capital expenditure uplifts.",
    bands: OPTIMISM_BIAS_TABLE,
  }));

  /**
   * The outturn database the outside view is computed from. Company-level:
   * a reference class is a portfolio fact, not a project one, which is why
   * it is gated by companyToolGate rather than left on bare company
   * membership.
   */
  app.post("/risk/reference-projects", { preHandler: companyStandardGate }, async (req, reply) => {
    const body = referenceProjectSchema.parse(req.body);
    const id = newId("rfp");
    await app.db.insert(referenceProjects).values({
      id,
      companyId: req.companyId!,
      name: body.name,
      category: body.category,
      assetClass: body.assetClass ?? null,
      country: body.country ?? null,
      currency: body.currency ?? "GBP",
      estimatedCost: body.estimatedCost ?? null,
      outturnCost: body.outturnCost ?? null,
      estimatedDurationDays: body.estimatedDurationDays ?? null,
      outturnDurationDays: body.outturnDurationDays ?? null,
      completedAt: body.completedAt ?? null,
      source: body.source ?? null,
      note: body.note ?? null,
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "reference_project",
      objectId: id,
      payload: { name: body.name, category: body.category },
      storePayload: true,
    });
    const [row] = await app.db
      .select()
      .from(referenceProjects)
      .where(eq(referenceProjects.id, id))
      .limit(1);
    return reply.status(201).send(row);
  });

  app.get("/risk/reference-projects", { preHandler: companyReadGate }, async (req) => {
    const q = pageQuerySchema
      .extend({ category: z.enum(OPTIMISM_BIAS_CATEGORIES).optional() })
      .parse(req.query);
    const clauses = [eq(referenceProjects.companyId, req.companyId!)];
    if (q.category) clauses.push(eq(referenceProjects.category, q.category));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(referenceProjects).where(where);
    const rows = await app.db
      .select()
      .from(referenceProjects)
      .where(where)
      .orderBy(desc(referenceProjects.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows, Number(totalRow?.n ?? 0), q);
  });

  app.patch(
    "/risk/reference-projects/:referenceId",
    { preHandler: companyStandardGate },
    async (req) => {
      const { referenceId } = req.params as { referenceId: string };
      const body = referenceProjectSchema.partial().parse(req.body);
      const rows = await app.db
        .select()
        .from(referenceProjects)
        .where(
          and(
            eq(referenceProjects.id, referenceId),
            eq(referenceProjects.companyId, req.companyId!),
          ),
        )
        .limit(1);
      if (!rows[0]) throw notFound("Reference project not found");
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const [k, v] of Object.entries(body)) if (v !== undefined) set[k] = v;
      await app.db.update(referenceProjects).set(set).where(eq(referenceProjects.id, referenceId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "reference_project",
        objectId: referenceId,
        payload: { changed: Object.keys(body) },
      });
      const [after] = await app.db
        .select()
        .from(referenceProjects)
        .where(eq(referenceProjects.id, referenceId))
        .limit(1);
      return after;
    },
  );

  app.delete(
    "/risk/reference-projects/:referenceId",
    { preHandler: companyStandardGate },
    async (req, reply) => {
      const { referenceId } = req.params as { referenceId: string };
      const rows = await app.db
        .select({ id: referenceProjects.id })
        .from(referenceProjects)
        .where(
          and(
            eq(referenceProjects.id, referenceId),
            eq(referenceProjects.companyId, req.companyId!),
          ),
        )
        .limit(1);
      if (!rows[0]) throw notFound("Reference project not found");
      await app.db.delete(referenceProjects).where(eq(referenceProjects.id, referenceId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "reference_project",
        objectId: referenceId,
        payload: null,
      });
      return reply.status(204).send();
    },
  );

  /**
   * Inside view vs outside view, side by side (#403-405). The inside view is
   * the Green Book table at the stated mitigation position; the outside view
   * is the empirical uplift of the company's own reference class. Neither is
   * chosen for the user — both are returned with their basis and sample size,
   * and the business case records which was taken and why.
   */
  app.get("/risk/reference-class", { preHandler: companyReadGate }, async (req) => {
    const q = rcfQuery.parse(req.query);
    const rows = await app.db
      .select()
      .from(referenceProjects)
      .where(
        and(
          eq(referenceProjects.companyId, req.companyId!),
          eq(referenceProjects.category, q.category),
        ),
      );
    const inputs: ReferenceProjectInput[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      category: r.category,
      estimatedCost: r.estimatedCost,
      outturnCost: r.outturnCost,
      estimatedDurationDays: r.estimatedDurationDays,
      outturnDurationDays: r.outturnDurationDays,
    }));
    return {
      inside: upliftFor(q.category, q.position),
      outside: referenceClassForecast(inputs, { category: q.category, basis: q.basis }),
      references: rows.map((r) => ({
        id: r.id,
        name: r.name,
        currency: r.currency,
        estimatedCost: r.estimatedCost,
        outturnCost: r.outturnCost,
        estimatedDurationDays: r.estimatedDurationDays,
        outturnDurationDays: r.outturnDurationDays,
        completedAt: r.completedAt,
      })),
    };
  });

  /* ---------------------------------------------------------------- */
  /* Health inputs (contract 3.5)                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Cheap, indexed metrics the intelligence layer reads for the `risk`
   * health dimension. Every metric that cannot be computed is null with a
   * reason — a project with no register is not a project with zero risk.
   */
  app.get(
    "/projects/:projectId/risk/health-inputs",
    { preHandler: readGate },
    async (req) => {
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const register = await app.db
        .select()
        .from(risks)
        .where(and(eq(risks.companyId, companyId), eq(risks.projectId, projectId)));
      const conts = await app.db
        .select()
        .from(contingencies)
        .where(and(eq(contingencies.companyId, companyId), eq(contingencies.projectId, projectId)));
      const draws = conts.length
        ? await app.db
            .select({
              contingencyId: contingencyDrawdowns.contingencyId,
              amount: contingencyDrawdowns.amount,
            })
            .from(contingencyDrawdowns)
            .where(
              inArray(
                contingencyDrawdowns.contingencyId,
                conts.map((c) => c.id),
              ),
            )
        : [];
      const reasons: string[] = [];
      const live = register.filter((r) => r.status === "open" || r.status === "mitigating");
      const quantified = live.filter((r) => r.occurrenceProbability != null && r.costImpact != null);

      let contingencyRemainingPercent: number | null = null;
      if (conts.length === 0) {
        reasons.push("No contingency has been set on this project, so cover cannot be measured.");
      } else {
        const budget = conts.reduce((s, c) => s + c.amount, 0);
        const drawn = draws.reduce((s, d) => s + d.amount, 0);
        contingencyRemainingPercent =
          budget > 0 ? round2(((budget - drawn) / budget) * 100) : null;
        if (contingencyRemainingPercent === null) {
          reasons.push("Contingency budget is zero, so a remaining percentage is undefined.");
        }
        const currencies = new Set(conts.map((c) => c.currency));
        if (currencies.size > 1) {
          reasons.push(
            `Contingencies span ${[...currencies].join(", ")}; the remaining percentage is computed on the raw amounts and should be read per currency.`,
          );
        }
      }

      const appetiteRules = await app.db
        .select()
        .from(riskAppetites)
        .where(
          and(eq(riskAppetites.companyId, companyId), eq(riskAppetites.projectId, projectId)),
        );
      const breaches = evaluateAppetite(
        appetiteRules.map(
          (r): AppetiteRule => ({
            id: r.id,
            scope: r.scope === "category" ? "category" : "project",
            category: r.category,
            maxScore: r.maxScore,
            maxExpectedValue: r.maxExpectedValue,
            currency: r.currency,
          }),
        ),
        register.map(toAppetiteRiskInput),
      );
      if (appetiteRules.length === 0) {
        reasons.push("No risk appetite thresholds are set, so appetite breaches cannot be counted.");
      }

      const lastSim = (
        await app.db
          .select({ createdAt: riskSimulations.createdAt })
          .from(riskSimulations)
          .where(
            and(
              eq(riskSimulations.companyId, companyId),
              eq(riskSimulations.projectId, projectId),
              eq(riskSimulations.kind, "qcra"),
            ),
          )
          .orderBy(desc(riskSimulations.createdAt))
          .limit(1)
      )[0];
      if (!lastSim) {
        reasons.push("No QCRA has been run, so the quantified exposure is unknown.");
      }

      const evTotal = quantified.reduce((s, r) => {
        const ev = expectedValueOf(r);
        return ev === null ? s : s + ev;
      }, 0);

      return {
        metrics: {
          openRisks: live.length,
          highScoreRisks: live.filter(
            (r) =>
              (r.postProbabilityScore != null && r.postImpactScore != null
                ? r.postProbabilityScore * r.postImpactScore
                : r.probabilityScore * r.impactScore) >= 15,
          ).length,
          realisedRisks: register.filter((r) => r.status === "realised").length,
          quantifiedRisks: quantified.length,
          unquantifiedLiveRisks: live.length - quantified.length,
          expectedValueTotal: quantified.length > 0 ? round2(evTotal) : null,
          contingencyRemainingPercent,
          appetiteBreaches: appetiteRules.length === 0 ? null : breaches.length,
          daysSinceLastSimulation:
            lastSim == null
              ? null
              : Math.round(
                  (Date.now() - Date.parse(lastSim.createdAt)) / 86_400_000,
                ),
        },
        reasons,
      };
    },
  );
};
