/**
 * Scheduled work for the quantified-risk module.
 *
 * Three time-driven behaviours, none of which may depend on somebody
 * opening a page:
 *
 *  1. `risk.simulation-queue` — drains queued simulation jobs and requeues
 *     any left `running` by a process that died mid-run. Without this an
 *     async simulation submitted at 17:59 sits queued forever.
 *  2. `risk.contingency-drift` — compares actual contingency drawdown with
 *     the planned curve and raises a signal when the project is burning its
 *     cover faster than planned (#451, #471). Idempotent: it will not raise
 *     a second open signal for the same contingency.
 *  3. `risk.appetite` — evaluates risk appetite thresholds against the live
 *     register and raises a signal per breach (#472). Also idempotent.
 */
import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import {
  contingencies,
  contingencyDrawdowns,
  contingencyPlanPoints,
  riskAppetites,
  risks,
} from "@constructos/db";
import { forEachCompany } from "../../lib/scheduler.js";
import type { Db } from "../../lib/db.js";
import { appendLedger } from "../../lib/ledger.js";
import { closeSignalByKey, raiseSignalOnce } from "../governance/signals.js";
import { analyticMean, distributionSchema } from "./distributions.js";
import {
  assessDrift,
  evaluateAppetite,
  type AppetiteRiskInput,
  type AppetiteRule,
  type PlanPoint,
} from "./contingency.js";
import type { SimulationQueue } from "./runner.js";

const round2 = (n: number): number => Math.round(n * 100) / 100;

/* ------------------------------------------------------------------ */
/* Contingency drift (#451, #471)                                      */
/* ------------------------------------------------------------------ */

export async function sweepContingencyDrift(
  db: Db,
  companyId: string,
  today: string,
): Promise<{ checked: number; raised: number }> {
  const rows = await db
    .select()
    .from(contingencies)
    .where(eq(contingencies.companyId, companyId));
  if (rows.length === 0) return { checked: 0, raised: 0 };
  const ids = rows.map((c) => c.id);
  const draws = await db
    .select({
      contingencyId: contingencyDrawdowns.contingencyId,
      amount: contingencyDrawdowns.amount,
    })
    .from(contingencyDrawdowns)
    .where(inArray(contingencyDrawdowns.contingencyId, ids));
  const plans = await db
    .select()
    .from(contingencyPlanPoints)
    .where(inArray(contingencyPlanPoints.contingencyId, ids));

  const drawnBy = new Map<string, number>();
  for (const d of draws) drawnBy.set(d.contingencyId, (drawnBy.get(d.contingencyId) ?? 0) + d.amount);
  const planBy = new Map<string, PlanPoint[]>();
  for (const p of plans) {
    const list = planBy.get(p.contingencyId) ?? [];
    list.push({ date: p.pointDate, plannedRemaining: p.plannedRemaining });
    planBy.set(p.contingencyId, list);
  }

  let raised = 0;
  for (const c of rows) {
    const plan = planBy.get(c.id) ?? [];
    if (plan.length === 0) continue;
    const drift = assessDrift({
      amount: c.amount,
      actualRemaining: round2(c.amount - (drawnBy.get(c.id) ?? 0)),
      plan,
      asOf: today,
    });
    if (!drift.breached) {
      // The condition cleared (a replenishment, or a re-planned curve).
      await closeSignalByKey(
        db,
        companyId,
        "contingency_drawdown_ahead_of_plan",
        c.id,
        "Drawdown is back inside the planned tolerance.",
      );
      continue;
    }
    const outcome = await raiseSignalOnce(db, {
      companyId,
      projectId: c.projectId,
      detector: "contingency_drawdown_ahead_of_plan",
      key: c.id,
      severity: "high",
      confidence: 1,
      title: `Contingency "${c.name}" is being drawn down ahead of plan`,
      explanation:
        `${drift.basis} A contingency consumed faster than risk is retired is the earliest ` +
        `warning that the remaining cover will not absorb what is left on the register. Review ` +
        `the drawdown reasons against the live risks and the replenishment options.`,
      subjectType: "contingency",
      subjectId: c.id,
      evidenceRefs: { contingencyId: c.id, projectId: c.projectId },
    });
    if (!outcome.raised) continue;
    await appendLedger(db, {
      companyId,
      actorId: null,
      action: "state_change",
      objectType: "contingency",
      objectId: c.id,
      payload: {
        detector: "contingency_drawdown_ahead_of_plan",
        plannedRemaining: drift.plannedRemaining,
        actualRemaining: drift.actualRemaining,
        variancePercent: drift.variancePercent,
      },
      projectId: c.projectId,
    });
    raised += 1;
  }
  return { checked: rows.length, raised };
}

/* ------------------------------------------------------------------ */
/* Risk appetite (#472)                                                */
/* ------------------------------------------------------------------ */

/** Analytic expected value of a risk, or null when it is not quantified. */
export function expectedValueOf(risk: {
  occurrenceProbability: number | null;
  costImpact: Record<string, unknown> | null;
}): number | null {
  if (risk.occurrenceProbability == null || risk.costImpact == null) return null;
  const parsed = distributionSchema.safeParse(risk.costImpact);
  if (!parsed.success) return null;
  return risk.occurrenceProbability * analyticMean(parsed.data as never);
}

export function toAppetiteRiskInput(row: typeof risks.$inferSelect): AppetiteRiskInput {
  const post =
    row.postProbabilityScore != null && row.postImpactScore != null
      ? row.postProbabilityScore * row.postImpactScore
      : null;
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    category: row.category,
    status: row.status,
    effectiveScore: post ?? row.probabilityScore * row.impactScore,
    expectedValue: expectedValueOf(row),
  };
}

export async function sweepAppetite(
  db: Db,
  companyId: string,
): Promise<{ projects: number; raised: number }> {
  const rules = await db.select().from(riskAppetites).where(eq(riskAppetites.companyId, companyId));
  if (rules.length === 0) return { projects: 0, raised: 0 };
  const byProject = new Map<string, typeof rules>();
  for (const r of rules) {
    const list = byProject.get(r.projectId) ?? [];
    list.push(r);
    byProject.set(r.projectId, list);
  }
  let raised = 0;
  for (const [projectId, projectRules] of byProject) {
    const register = await db
      .select()
      .from(risks)
      .where(and(eq(risks.companyId, companyId), eq(risks.projectId, projectId)));
    const breaches = evaluateAppetite(
      projectRules.map(
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
    for (const b of breaches) {
      const fragment = b.riskNumber === null ? "aggregate exposure" : `risk #${b.riskNumber}`;
      const outcome = await raiseSignalOnce(db, {
        companyId,
        projectId,
        detector: "risk_appetite_exceeded",
        key: `${b.ruleId}:${b.kind}:${b.riskId ?? "portfolio"}`,
        severity: b.kind === "portfolio_expected_value" ? "high" : "medium",
        confidence: 1,
        title: `Risk appetite exceeded — ${fragment}`,
        explanation:
          `${b.detail} An appetite threshold is the board's own statement of what it will accept; ` +
          `exceeding it is not an error but it is a fact the board is entitled to be told, with the ` +
          `mitigation plan or the appetite revision that follows.`,
        subjectType: b.riskId ? "risk" : "risk_appetite",
        subjectId: b.riskId ?? b.ruleId,
        evidenceRefs: { ruleId: b.ruleId, kind: b.kind, limit: b.limit, actual: b.actual },
      });
      if (outcome.raised) raised += 1;
    }
  }
  return { projects: byProject.size, raised };
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

export function registerRiskJobs(app: FastifyInstance, queue: SimulationQueue): void {
  app.scheduler.register({
    name: "risk.simulation-queue",
    description:
      "Drain queued Monte Carlo simulation jobs and requeue any left running by a process that died mid-run",
    everyMs: 30_000,
    runOnBoot: true,
    run: async () => {
      const requeued = await queue.requeueStale();
      const ran = await queue.drain();
      return { requeued, ran };
    },
  });

  app.scheduler.register({
    name: "risk.contingency-drift",
    description:
      "Compare actual contingency drawdown with the planned curve and raise a signal where cover is being consumed ahead of plan",
    everyMs: 6 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) =>
      forEachCompany(db, (companyId) =>
        sweepContingencyDrift(db, companyId, now.toISOString().slice(0, 10)),
      ),
  });

  app.scheduler.register({
    name: "risk.appetite",
    description:
      "Evaluate risk appetite and tolerance thresholds against the live register and raise a signal per breach",
    everyMs: 12 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db }) => forEachCompany(db, (companyId) => sweepAppetite(db, companyId)),
  });
}
