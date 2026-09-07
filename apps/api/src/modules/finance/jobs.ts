/**
 * Scheduled work for project finance.
 *
 *  1. `finance.conditions` — flips OPEN facility conditions whose due date
 *     has passed to `breached`, breaches the backing obligation and raises a
 *     signal. This used to run only as a side effect of somebody opening the
 *     facilities page, and — worse — recorded the READER as the actor of the
 *     transition. An auditor with read-only access became the recorded actor
 *     of "facility condition breached" transitions they did not perform.
 *     The sweep now runs on a schedule with `actorId: null` (the system
 *     principal); the read path still refreshes state but attributes it the
 *     same way.
 *  2. `finance.covenant-tests` — reads the facility cashflow rows and
 *     computes any covenant with a named formula whose test period has
 *     passed without a reading (#743).
 *  3. `finance.forecast` — compares the planned drawdown profile with what
 *     actually moved and raises a signal when actuals lag the plan or a
 *     milestone-triggered tranche's milestone is incomplete (#745-746).
 *  4. `finance.designated-accounts` — an advance account nobody has
 *     reconciled is the single most common finding in a DFI audit, and it
 *     is invisible on a page nobody opens. The sweep raises it (#735, #745).
 */
import type { FastifyInstance } from "fastify";
import { and, asc, eq, inArray, isNotNull, lt } from "drizzle-orm";
import {
  covenantReadings,
  covenantWaivers,
  covenants,
  designatedAccountReconciliations,
  designatedAccounts,
  disbursementForecasts,
  disbursements,
  facilityCashflows,
  facilityConditions,
  fundingFacilities,
  obligations,
  scheduleTasks,
} from "@constructos/db";
import { forEachCompany } from "../../lib/scheduler.js";
import type { Db } from "../../lib/db.js";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { closeSignalByKey, raiseSignalOnce } from "../governance/signals.js";
import { computeCovenantReading, formulaSpec } from "./covenants.js";
import { compareForecast, type ForecastPeriod } from "./money.js";

/* ------------------------------------------------------------------ */
/* Conditions (#730-731)                                               */
/* ------------------------------------------------------------------ */

/**
 * Breach open conditions past their due date.
 *
 * `actorId` is null for the scheduler; a route that calls this on the read
 * path passes null too, because the reader did not perform the transition.
 * Guarded on the status flip itself, so a breached condition never
 * re-enters the sweep.
 */
export async function sweepOverdueConditions(
  db: Db,
  companyId: string,
  today: string,
  projectId?: string,
): Promise<{ breached: number }> {
  const clauses = [
    eq(facilityConditions.companyId, companyId),
    eq(facilityConditions.status, "open"),
    isNotNull(facilityConditions.dueDate),
    lt(facilityConditions.dueDate, today),
  ];
  if (projectId) clauses.push(eq(facilityConditions.projectId, projectId));
  const overdue = await db
    .select()
    .from(facilityConditions)
    .where(and(...clauses));
  if (overdue.length === 0) return { breached: 0 };

  const facilityIds = [...new Set(overdue.map((c) => c.facilityId))];
  const facs = await db
    .select({ id: fundingFacilities.id, name: fundingFacilities.name })
    .from(fundingFacilities)
    .where(inArray(fundingFacilities.id, facilityIds));
  const facilityName = new Map(facs.map((f) => [f.id, f.name]));

  let breached = 0;
  for (const cond of overdue) {
    // One transaction per condition: the status flip, the obligation and the
    // ledger entry either all land or none do. A mid-sequence failure used
    // to leave an obligation with no owning record on the assurance
    // register.
    const changed = await db.transaction(async (tx) => {
      const updated = await tx
        .update(facilityConditions)
        .set({ status: "breached", updatedAt: new Date().toISOString() })
        .where(and(eq(facilityConditions.id, cond.id), eq(facilityConditions.status, "open")))
        .returning({ id: facilityConditions.id });
      if (updated.length === 0) return false;
      if (cond.obligationId) {
        await tx
          .update(obligations)
          .set({ status: "breached" })
          .where(and(eq(obligations.id, cond.obligationId), eq(obligations.status, "open")));
      }
      await appendLedger(tx as Db, {
        companyId,
        actorId: null,
        action: "state_change",
        objectType: "facility_condition",
        objectId: cond.id,
        payload: { from: "open", to: "breached", dueDate: cond.dueDate, sweep: true },
        projectId: cond.projectId,
      });
      return true;
    });
    if (!changed) continue;
    const fname = facilityName.get(cond.facilityId) ?? "funding facility";
    await raiseSignalOnce(db, {
      companyId,
      projectId: cond.projectId,
      detector: "facility_condition_overdue",
      key: cond.id,
      severity: "high",
      confidence: 1,
      title: `Facility condition overdue — ${fname}${cond.reference ? ` (${cond.reference})` : ""}`,
      explanation:
        `Condition ${cond.kind} on facility "${fname}" fell due on ${cond.dueDate} and remains ` +
        `unsatisfied: ${cond.description}. ` +
        (cond.kind === "precedent"
          ? "While it stands, disbursement requests against this facility cannot be submitted."
          : "An unsatisfied condition subsequent is an event of default risk under the facility agreement."),
      subjectType: "facility_condition",
      subjectId: cond.id,
      evidenceRefs: { facilityId: cond.facilityId, dueDate: cond.dueDate },
    });
    breached += 1;
  }
  return { breached };
}

/* ------------------------------------------------------------------ */
/* Computed covenant readings (#743)                                   */
/* ------------------------------------------------------------------ */

export async function sweepCovenantTests(
  db: Db,
  companyId: string,
): Promise<{ computed: number; skipped: number }> {
  const covs = await db
    .select()
    .from(covenants)
    .where(eq(covenants.companyId, companyId));
  const computable = covs.filter((c) => c.formula !== "custom");
  if (computable.length === 0) return { computed: 0, skipped: 0 };

  const cashflows = await db
    .select()
    .from(facilityCashflows)
    .where(eq(facilityCashflows.companyId, companyId))
    .orderBy(asc(facilityCashflows.periodEnd));
  const byFacility = new Map<string, typeof cashflows>();
  for (const cf of cashflows) {
    const list = byFacility.get(cf.facilityId) ?? [];
    list.push(cf);
    byFacility.set(cf.facilityId, list);
  }

  let computed = 0;
  let skipped = 0;
  for (const cov of computable) {
    const periods = byFacility.get(cov.facilityId) ?? [];
    if (periods.length === 0) {
      skipped += 1;
      continue;
    }
    const existing = await db
      .select({ readingDate: covenantReadings.readingDate })
      .from(covenantReadings)
      .where(eq(covenantReadings.covenantId, cov.id));
    const have = new Set(existing.map((r) => r.readingDate));
    for (const period of periods) {
      if (have.has(period.periodEnd)) continue;
      const result = computeCovenantReading(cov.formula, period.inputs);
      if (result.value === null) {
        skipped += 1;
        continue;
      }
      const compliant = cov.operator === "gte" ? result.value >= cov.threshold : result.value <= cov.threshold;
      const headroom =
        Math.round(
          (cov.operator === "gte" ? result.value - cov.threshold : cov.threshold - result.value) * 100,
        ) / 100;
      await db.insert(covenantReadings).values({
        id: newId("cvr"),
        covenantId: cov.id,
        companyId,
        readingDate: period.periodEnd,
        value: result.value,
        compliant: compliant ? 1 : 0,
        headroom,
        note: null,
        basis: cov.formula,
        computedFrom: { inputs: result.used, basis: result.basis, cashflowId: period.id },
        recordedBy: "system",
      });
      computed += 1;
      if (!compliant) {
        const spec = formulaSpec(cov.formula);
        await raiseSignalOnce(db, {
          companyId,
          projectId: cov.projectId,
          detector: "covenant_breach",
          key: `${cov.id}:${period.periodEnd}`,
          severity: "critical",
          confidence: 1,
          title: `Covenant breach — ${cov.name} at ${period.periodEnd}`,
          explanation:
            `The computed ${spec?.label ?? cov.formula} for the period ending ${period.periodEnd} ` +
            `is ${result.value} against a required level of ` +
            `${cov.operator === "gte" ? "≥" : "≤"} ${cov.threshold}. ${result.basis} ` +
            `A financial covenant breach is a draw-stop event: further disbursements are refused ` +
            `until the breach clears or a lender waiver is recorded.`,
          subjectType: "covenant",
          subjectId: cov.id,
          evidenceRefs: { covenantId: cov.id, periodEnd: period.periodEnd, inputs: result.used },
        });
      } else {
        await closeSignalByKey(
          db,
          companyId,
          "covenant_breach",
          `${cov.id}:${period.periodEnd}`,
          "The recomputed reading for this period complies.",
        );
      }
    }
  }
  return { computed, skipped };
}

/* ------------------------------------------------------------------ */
/* Forecast vs actual (#745-746)                                       */
/* ------------------------------------------------------------------ */

export async function sweepDisbursementForecast(
  db: Db,
  companyId: string,
  today: string,
): Promise<{ facilities: number; raised: number }> {
  const forecasts = await db
    .select()
    .from(disbursementForecasts)
    .where(eq(disbursementForecasts.companyId, companyId));
  if (forecasts.length === 0) return { facilities: 0, raised: 0 };
  const facilityIds = [...new Set(forecasts.map((f) => f.facilityId))];
  const facs = await db
    .select()
    .from(fundingFacilities)
    .where(inArray(fundingFacilities.id, facilityIds));
  const draws = await db
    .select()
    .from(disbursements)
    .where(inArray(disbursements.facilityId, facilityIds));
  const milestoneIds = [
    ...new Set(forecasts.map((f) => f.milestoneTaskId).filter((x): x is string => Boolean(x))),
  ];
  const tasks = milestoneIds.length
    ? await db
        .select({ id: scheduleTasks.id, actualFinish: scheduleTasks.actualFinish })
        .from(scheduleTasks)
        .where(inArray(scheduleTasks.id, milestoneIds))
    : [];
  const finished = new Map(tasks.map((t) => [t.id, t.actualFinish !== null]));

  let raised = 0;
  for (const facility of facs) {
    const rows = forecasts.filter((f) => f.facilityId === facility.id);
    const periods: ForecastPeriod[] = rows.map((f) => ({
      periodStart: f.periodStart,
      periodEnd: f.periodEnd,
      plannedAmount: f.plannedAmount,
      milestoneTaskId: f.milestoneTaskId,
      milestoneComplete: f.milestoneTaskId ? (finished.get(f.milestoneTaskId) ?? false) : null,
    }));
    const actuals = draws
      .filter((d) => d.facilityId === facility.id && d.status === "disbursed" && d.disbursedAt)
      .map((d) => ({ date: d.disbursedAt!.slice(0, 10), amount: d.amount }));
    const comparison = compareForecast(periods, actuals, today);

    if (comparison.behindPlan) {
      await raiseSignalOnce(db, {
        companyId,
        projectId: facility.projectId,
        detector: "disbursement_behind_forecast",
        key: facility.id,
        severity: "medium",
        confidence: 1,
        title: `Disbursements are behind the drawdown forecast — ${facility.name}`,
        explanation:
          `Cumulative disbursements on "${facility.name}" lag the planned profile by ` +
          `${facility.currency} ${comparison.lagAmount} (${comparison.lagPercent}% of the plan to date). ` +
          `${comparison.basis} A facility drawing more slowly than planned usually means the works ` +
          `are behind, the evidence is not being assembled, or the availability period is being ` +
          `wasted — all three matter to the lender.`,
        subjectType: "funding_facility",
        subjectId: facility.id,
        evidenceRefs: { lagAmount: comparison.lagAmount, lagPercent: comparison.lagPercent },
      });
      raised += 1;
    } else {
      await closeSignalByKey(
        db,
        companyId,
        "disbursement_behind_forecast",
        facility.id,
        "Drawdowns are back within tolerance of the forecast.",
      );
    }

    for (const point of comparison.points) {
      const key = `${facility.id}:${point.periodEnd}`;
      if (point.milestoneOutstanding) {
        await raiseSignalOnce(db, {
          companyId,
          projectId: facility.projectId,
          detector: "milestone_tranche_unearned",
          key,
          severity: "high",
          confidence: 1,
          title: `Milestone-triggered tranche is not yet earned — ${facility.name}`,
          explanation:
            `The tranche of ${facility.currency} ${point.planned} planned for the period ending ` +
            `${point.periodEnd} is conditional on a schedule milestone that has no actual finish ` +
            `date. Drawing against an unearned milestone is the classic disbursement finding.`,
          subjectType: "funding_facility",
          subjectId: facility.id,
          evidenceRefs: { periodEnd: point.periodEnd, planned: point.planned },
        });
        raised += 1;
      } else {
        await closeSignalByKey(
          db,
          companyId,
          "milestone_tranche_unearned",
          key,
          "The milestone behind this tranche is complete.",
        );
      }
    }
  }
  return { facilities: facs.length, raised };
}

/* ------------------------------------------------------------------ */
/* Standing covenant status (used by the draw-stop test)               */
/* ------------------------------------------------------------------ */

export interface CovenantStandingRow {
  covenantId: string;
  name: string;
  compliant: boolean | null;
  readingDate: string | null;
  headroom: number | null;
  waivedBy: { id: string; reference: string | null; effectiveTo: string | null } | null;
}

/** Latest reading per covenant on a facility, with any waiver in force. */
export async function covenantStanding(
  db: Db,
  facilityId: string,
  today: string,
): Promise<CovenantStandingRow[]> {
  const covs = await db.select().from(covenants).where(eq(covenants.facilityId, facilityId));
  if (covs.length === 0) return [];
  const readings = await db
    .select()
    .from(covenantReadings)
    .where(
      inArray(
        covenantReadings.covenantId,
        covs.map((c) => c.id),
      ),
    )
    .orderBy(asc(covenantReadings.readingDate), asc(covenantReadings.createdAt));
  const waivers = await db
    .select()
    .from(covenantWaivers)
    .where(eq(covenantWaivers.facilityId, facilityId));
  return covs.map((c) => {
    const series = readings.filter((r) => r.covenantId === c.id);
    const latest = series[series.length - 1] ?? null;
    const waiver =
      waivers.find(
        (w) =>
          w.covenantId === c.id &&
          w.effectiveFrom <= today &&
          (w.effectiveTo === null || w.effectiveTo >= today),
      ) ?? null;
    return {
      covenantId: c.id,
      name: c.name,
      compliant: latest ? latest.compliant === 1 : null,
      readingDate: latest?.readingDate ?? null,
      headroom: latest?.headroom ?? null,
      waivedBy: waiver
        ? { id: waiver.id, reference: waiver.lenderReference, effectiveTo: waiver.effectiveTo }
        : null,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Designated account reconciliation staleness (#735, #745)            */
/* ------------------------------------------------------------------ */

/** Days an active designated account may go unreconciled before it is raised. */
export const ACCOUNT_RECONCILIATION_MAX_AGE_DAYS = 45;

/**
 * Raise (once) every active designated account whose last reconciliation is
 * older than the threshold, or which has never been reconciled at all. The
 * finding closes itself when a reconciliation lands, so the register does
 * not accumulate stale rows.
 */
export async function sweepDesignatedAccounts(
  db: Db,
  companyId: string,
  today: string,
): Promise<void> {
  const accounts = await db
    .select()
    .from(designatedAccounts)
    .where(and(eq(designatedAccounts.companyId, companyId), eq(designatedAccounts.status, "active")));
  if (accounts.length === 0) return;
  const recs = await db
    .select({
      accountId: designatedAccountReconciliations.accountId,
      periodEnd: designatedAccountReconciliations.periodEnd,
    })
    .from(designatedAccountReconciliations)
    .where(
      inArray(
        designatedAccountReconciliations.accountId,
        accounts.map((a) => a.id),
      ),
    );
  const latest = new Map<string, string>();
  for (const r of recs) {
    const current = latest.get(r.accountId);
    if (!current || r.periodEnd > current) latest.set(r.accountId, r.periodEnd);
  }
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - ACCOUNT_RECONCILIATION_MAX_AGE_DAYS);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  for (const account of accounts) {
    const last = latest.get(account.id) ?? null;
    const stale = last === null || last < cutoffIso;
    if (!stale) {
      await closeSignalByKey(
        db,
        companyId,
        "designated_account_unreconciled_overdue",
        account.id,
        `Reconciled to ${last ?? "an earlier period"}, inside the ${ACCOUNT_RECONCILIATION_MAX_AGE_DAYS}-day window.`,
      );
      continue;
    }
    await raiseSignalOnce(db, {
      companyId,
      projectId: account.projectId,
      detector: "designated_account_unreconciled_overdue",
      key: account.id,
      severity: "medium",
      confidence: 1,
      title: `Designated account "${account.name}" has not been reconciled`,
      explanation:
        last === null
          ? `This account has never been reconciled against a bank statement. Until it is, the ` +
            `advance outstanding on it is unevidenced.`
          : `The last reconciliation of this account was to ${last}, more than ` +
            `${ACCOUNT_RECONCILIATION_MAX_AGE_DAYS} days ago. An advance account is only ` +
            `evidence of anything while it reconciles.`,
      subjectType: "designated_account",
      subjectId: account.id,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

export function registerFinanceJobs(app: FastifyInstance): void {
  app.scheduler.register({
    name: "finance.conditions",
    description:
      "Breach facility conditions past their due date, breach the backing obligation and raise the signal — attributed to the platform, not to whoever opened the page",
    everyMs: 6 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) =>
      forEachCompany(db, (companyId) =>
        sweepOverdueConditions(db, companyId, now.toISOString().slice(0, 10)),
      ),
  });

  app.scheduler.register({
    name: "finance.covenant-tests",
    description:
      "Compute covenant readings from the period cashflow inputs for every covenant with a named formula",
    everyMs: 12 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db }) => forEachCompany(db, (companyId) => sweepCovenantTests(db, companyId)),
  });

  app.scheduler.register({
    name: "finance.designated-accounts",
    description:
      "Raise every active designated account that has never been reconciled, or whose last reconciliation is more than 45 days old",
    everyMs: 24 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) =>
      forEachCompany(db, (companyId) =>
        sweepDesignatedAccounts(db, companyId, now.toISOString().slice(0, 10)),
      ),
  });

  app.scheduler.register({
    name: "finance.forecast",
    description:
      "Compare drawdowns with the planned profile and flag facilities lagging the plan or drawing against an unearned milestone",
    everyMs: 12 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) =>
      forEachCompany(db, (companyId) =>
        sweepDisbursementForecast(db, companyId, now.toISOString().slice(0, 10)),
      ),
  });
}
