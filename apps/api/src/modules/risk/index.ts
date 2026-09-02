import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import {
  contingencies,
  contingencyDrawdowns,
  riskSimulations,
  risks,
  scheduleDependencies,
  scheduleTasks,
  schedules,
  signals,
} from "@constructos/db";
import {
  RISK_CATEGORIES,
  RISK_STATUSES,
  SIMULATION_KINDS,
  type DependencyType,
  type TaskConstraintType,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { isoDateSchema } from "../field/dates.js";
import { isoFromDay, type CpmDependencyInput } from "../../lib/cpm.js";
import {
  runQcra,
  runQsra,
  type Distribution,
  type QcraRiskInput,
  type QsraTaskInput,
} from "../../lib/montecarlo.js";
import { analyticMean, distributionSchema } from "./distributions.js";

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
});

const qsraSchema = z.object({
  scheduleId: z.string().min(1).optional(),
  iterations: z.number().int().min(50).max(5000).default(1000),
  seed: seedSchema.optional(),
  taskUncertainties: z
    .array(z.object({ taskId: z.string().min(1), distribution: distributionSchema }))
    .max(500)
    .optional(),
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

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Fraction of a contingency below which the exhaustion signal fires (#473). */
const EXHAUSTION_FRACTION = 0.2;

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

  app.post(
    "/projects/:projectId/risks/:riskId/status",
    { preHandler: standardGate },
    async (req) => {
      const { riskId } = req.params as { riskId: string };
      const body = statusSchema.parse(req.body);
      const risk = await fetchRisk(riskId, req.companyId!, req.projectId!);
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
        payload: { from: risk.status, to: body.status, note: body.note ?? null },
        storePayload: true,
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

      const result = runQcra(riskInputs, { iterations: body.iterations, seed });
      const simId = newId("sim");
      await app.db.insert(riskSimulations).values({
        id: simId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        kind: "qcra",
        seed,
        iterations: body.iterations,
        inputs: { riskIds: riskInputs.map((r) => r.id), risks: riskInputs },
        results: result as unknown as Record<string, unknown>,
        runBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "risk_simulation",
        objectId: simId,
        payload: {
          kind: "qcra",
          seed,
          iterations: body.iterations,
          riskCount: riskInputs.length,
          p50: result.summary.percentiles.p50,
          p80: result.summary.percentiles.p80,
        },
        storePayload: true,
      });
      return reply.status(201).send({
        simulationId: simId,
        kind: "qcra",
        seed,
        iterations: body.iterations,
        riskCount: riskInputs.length,
        ...result,
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

      const result = runQsra(qsraTasks, cpmDeps, {
        projectStart: schedule.projectStart,
        iterations: body.iterations,
        seed,
      });
      // Day-count percentiles → ISO completion dates. Duration d finishes on
      // the inclusive last day d-1 relative to projectStart (lib/cpm.ts
      // convention: projectFinishDate = isoFromDay(duration - 1)).
      const dayToIso = (d: number) =>
        isoFromDay(Math.max(0, Math.round(d) - 1), schedule.projectStart);
      const completionDates = {
        p10: dayToIso(result.summary.percentiles.p10),
        p50: dayToIso(result.summary.percentiles.p50),
        p80: dayToIso(result.summary.percentiles.p80),
        p90: dayToIso(result.summary.percentiles.p90),
        p95: dayToIso(result.summary.percentiles.p95),
        mean: dayToIso(result.summary.mean),
        deterministic: dayToIso(result.deterministicDurationDays),
      };
      const results = { ...result, completionDates } as unknown as Record<string, unknown>;

      const simId = newId("sim");
      await app.db.insert(riskSimulations).values({
        id: simId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        kind: "qsra",
        seed,
        iterations: body.iterations,
        inputs: {
          scheduleId: schedule.id,
          projectStart: schedule.projectStart,
          tasks: qsraTasks,
          deps: cpmDeps,
          distributionSources: Object.fromEntries(
            [...distByTask.entries()].map(([taskId, v]) => [taskId, v.source]),
          ),
        },
        results,
        runBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "risk_simulation",
        objectId: simId,
        payload: {
          kind: "qsra",
          seed,
          iterations: body.iterations,
          scheduleId: schedule.id,
          taskCount: qsraTasks.length,
          p80CompletionDate: completionDates.p80,
        },
        storePayload: true,
      });
      return reply.status(201).send({
        simulationId: simId,
        kind: "qsra",
        seed,
        iterations: body.iterations,
        scheduleId: schedule.id,
        projectStart: schedule.projectStart,
        ...result,
        completionDates,
      });
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

  app.post(
    "/projects/:projectId/contingencies/:contingencyId/drawdowns",
    { preHandler: standardGate },
    async (req, reply) => {
      const { contingencyId } = req.params as { contingencyId: string };
      const body = drawdownSchema.parse(req.body);
      const cont = await fetchContingency(contingencyId, req.companyId!, req.projectId!);
      if (body.riskId) await fetchRisk(body.riskId, req.companyId!, req.projectId!).catch(() => {
        throw badRequest("riskId does not belong to this project");
      });
      const drawnBefore = await drawnTotal(contingencyId);
      const remainingBefore = cont.amount - drawnBefore;
      if (body.amount > remainingBefore + 1e-9) {
        throw conflict(
          `Drawdown of ${body.amount} exceeds the remaining contingency of ${round2(remainingBefore)} ` +
            `(${cont.currency} ${cont.amount} budget, ${round2(drawnBefore)} already drawn)`,
        );
      }
      const id = newId("cdd");
      await app.db.insert(contingencyDrawdowns).values({
        id,
        contingencyId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        amount: body.amount,
        reason: body.reason,
        riskId: body.riskId ?? null,
        drawnAt: body.drawnAt,
        approvedBy: req.user!.id,
      });
      const remainingAfter = remainingBefore - body.amount;
      const threshold = EXHAUSTION_FRACTION * cont.amount;
      // Fire exactly once: only on the draw that CROSSES the 20% line (#473).
      const exhaustionSignal = remainingBefore >= threshold && remainingAfter < threshold;
      if (exhaustionSignal) {
        await app.db.insert(signals).values({
          id: newId("sig"),
          companyId: req.companyId!,
          projectId: req.projectId!,
          detector: "contingency_exhaustion",
          severity: "high",
          confidence: 1,
          title: `Contingency "${cont.name}" below 20% remaining`,
          explanation:
            `A drawdown of ${cont.currency} ${body.amount} (${body.reason}) leaves ` +
            `${cont.currency} ${round2(remainingAfter)} of the ${cont.currency} ${cont.amount} ` +
            `contingency "${cont.name}" — under the 20% exhaustion threshold of ` +
            `${cont.currency} ${round2(threshold)}. Remaining cover may not absorb the ` +
            `residual risk exposure; review the risk register and replenishment options.`,
        });
      }
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "contingency_drawdown",
        objectId: id,
        payload: {
          contingencyId,
          amount: body.amount,
          reason: body.reason,
          riskId: body.riskId ?? null,
          drawnAt: body.drawnAt,
          remainingAfter: round2(remainingAfter),
        },
        storePayload: true,
      });
      const [row] = await app.db
        .select()
        .from(contingencyDrawdowns)
        .where(eq(contingencyDrawdowns.id, id))
        .limit(1);
      return reply.status(201).send({
        ...row,
        drawnTotal: round2(drawnBefore + body.amount),
        remaining: round2(remainingAfter),
        exhaustionSignal,
      });
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
      return {
        contingencyId,
        name: cont.name,
        currency: cont.currency,
        amount: cont.amount,
        points,
      };
    },
  );

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
};
