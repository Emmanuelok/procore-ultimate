/**
 * Health inputs loader — reads every module's own tables for ONE project
 * and hands the engine a `HealthInputs` (Vol I §6.1 #731–740, plan §3.5).
 *
 * Every query is an indexed aggregate bounded by (companyId, projectId) and,
 * where the table is large, a date window; nothing loads a register into
 * memory. A module with no records for the project yields `null` plus a
 * reason, and the engine renders that as "unrated", never as a score.
 *
 * Computed here in SQL rather than by calling each module's HTTP summary,
 * because the scheduler job has no request to forward and the Pulse must be
 * one request, not fifty.
 */
import { and, count, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import {
  budgets,
  changeEvents,
  commitments,
  contractEvents,
  covenantReadings,
  covenants,
  facilityConditions,
  itpActivities,
  nonConformanceReports,
  obligations,
  paymentClaims,
  projects,
  punchItems,
  reconciliations,
  rfis,
  risks,
  safetyCorrectiveActions,
  safetyIncidents,
  safetyInspections,
  safetyObservations,
  scheduleTasks,
  schedules,
  signals,
  submittals,
} from "@constructos/db";
import type { Db } from "../../lib/db.js";
import type { HealthInputs } from "./health-engine.js";

const DAY_MS = 86_400_000;
const n = (v: unknown): number => {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
};
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const plusDays = (d: Date, days: number) => new Date(d.getTime() + days * DAY_MS);

/** Whole days from ISO date `a` to ISO date `b`; null when either is missing or unparseable. */
export function daysBetweenIso(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const ta = Date.parse(a.length > 10 ? a : `${a}T00:00:00Z`);
  const tb = Date.parse(b.length > 10 ? b : `${b}T00:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round((tb - ta) / DAY_MS);
}

export const OPEN_SIGNAL_DISPOSITIONS = ["new", "under_review", "confirmed", "escalated"];
const OPEN_RFI = ["open", "answered"];
const OPEN_SUBMITTAL = ["draft", "open", "in_review", "responded"];
const OVERDUE_SUBMITTAL = ["draft", "open"];
const OPEN_PUNCH = ["open", "in_progress", "ready_for_review"];
const CLOSED_NCR = ["closed", "rejected", "void"];
const CLOSED_INCIDENT = ["closed", "void"];
const CLOSED_OBSERVATION = ["verified", "closed", "void"];
const CLOSED_ACTION = ["completed", "verified", "closed", "cancelled"];
const OPEN_CHANGE_EVENT = ["open", "pending"];
const PENDING_COMMITMENT = ["draft", "out_for_bid", "out_for_signature"];
const DEAD_COMMITMENT = ["void", "terminated"];

export async function loadHealthInputs(
  db: Db,
  companyId: string,
  projectId: string,
  now: Date,
): Promise<HealthInputs> {
  const today = isoDate(now);
  const in7 = isoDate(plusDays(now, 7));
  const nowIso = now.toISOString();
  const in7Iso = plusDays(now, 7).toISOString();
  const ago30Iso = plusDays(now, -30).toISOString();
  const ago90Iso = plusDays(now, -90).toISOString();
  const reasons: HealthInputs["reasons"] = {};

  const [project] = await db
    .select({ finishDate: projects.finishDate, currency: projects.currency })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
    .limit(1);
  const projectFinish = project?.finishDate ?? null;
  const projectCurrency = project?.currency ?? null;

  /* ---------------- schedule ---------------- */
  const scheduleP = (async () => {
    const [sched] = await db
      .select({ id: schedules.id, name: schedules.name, computedFinish: schedules.computedFinish })
      .from(schedules)
      .where(and(eq(schedules.companyId, companyId), eq(schedules.projectId, projectId), eq(schedules.isActive, 1)))
      .orderBy(desc(schedules.updatedAt))
      .limit(1);
    if (!sched) {
      reasons.schedule = "No active schedule for this project.";
      return null;
    }
    const [agg] = await db
      .select({
        tasks: count(),
        overdue: sql<number>`count(*) filter (where ${scheduleTasks.finishDate} < ${today} and ${scheduleTasks.actualFinish} is null and ${scheduleTasks.percentComplete} < 100 and ${scheduleTasks.durationDays} > 0)`,
        criticalOverdue: sql<number>`count(*) filter (where ${scheduleTasks.finishDate} < ${today} and ${scheduleTasks.actualFinish} is null and ${scheduleTasks.percentComplete} < 100 and ${scheduleTasks.durationDays} > 0 and ${scheduleTasks.isCritical} = 1)`,
        milestonesSlipped: sql<number>`count(*) filter (where ${scheduleTasks.durationDays} = 0 and ${scheduleTasks.finishDate} < ${today} and ${scheduleTasks.actualFinish} is null)`,
        percentComplete: sql<number | null>`avg(${scheduleTasks.percentComplete})`,
      })
      .from(scheduleTasks)
      .where(and(eq(scheduleTasks.scheduleId, sched.id), eq(scheduleTasks.projectId, projectId)));
    return {
      scheduleName: sched.name,
      slipDays: daysBetweenIso(projectFinish, sched.computedFinish),
      computedFinish: sched.computedFinish,
      projectFinish,
      tasks: n(agg?.tasks),
      overdueTasks: n(agg?.overdue),
      criticalOverdue: n(agg?.criticalOverdue),
      milestonesSlipped: n(agg?.milestonesSlipped),
      percentComplete: agg?.percentComplete === null || agg?.percentComplete === undefined ? null : Math.round(n(agg.percentComplete) * 10) / 10,
    };
  })();

  /* ---------------- cost ---------------- */
  const costP = (async () => {
    const [b] = await db
      .select({
        name: budgets.name,
        currency: budgets.currency,
        revised: budgets.revisedBudgetTotal,
        forecastFinal: budgets.forecastFinalTotal,
        variance: budgets.varianceTotal,
        pending: budgets.pendingChangesTotal,
        jtd: budgets.jobToDateCostsTotal,
      })
      .from(budgets)
      .where(and(eq(budgets.companyId, companyId), eq(budgets.projectId, projectId), eq(budgets.isActive, 1)))
      .orderBy(desc(budgets.updatedAt))
      .limit(1);
    if (!b) {
      reasons.cost = "No active budget for this project.";
      return null;
    }
    return {
      budgetName: b.name,
      currency: b.currency,
      revisedBudget: n(b.revised),
      forecastFinal: n(b.forecastFinal),
      variance: n(b.variance),
      pendingChanges: n(b.pending),
      jobToDate: n(b.jtd),
    };
  })();

  /* ---------------- commercial ---------------- */
  const commercialP = (async () => {
    const [c] = await db
      .select({
        commitments: sql<number>`count(*) filter (where ${commitments.status} not in ('void','terminated'))`,
        committed: sql<number>`coalesce(sum(${commitments.revisedCommitmentSum}) filter (where ${commitments.status} not in ('void','terminated') and ${commitments.executed} = 1), 0)`,
        pending: sql<number>`coalesce(sum(${commitments.revisedCommitmentSum}) filter (where ${commitments.status} in ('draft','out_for_bid','out_for_signature')), 0)`,
      })
      .from(commitments)
      .where(and(eq(commitments.companyId, companyId), eq(commitments.projectId, projectId)));
    const [ce] = await db
      .select({
        open: count(),
        exposure: sql<number>`coalesce(sum(${changeEvents.latestCost}), 0)`,
        aged: sql<number>`count(*) filter (where ${changeEvents.createdAt} < ${ago30Iso})`,
      })
      .from(changeEvents)
      .where(
        and(
          eq(changeEvents.companyId, companyId),
          eq(changeEvents.projectId, projectId),
          inArray(changeEvents.status, OPEN_CHANGE_EVENT),
        ),
      );
    const commitmentCount = n(c?.commitments);
    const openChangeEvents = n(ce?.open);
    if (commitmentCount === 0 && openChangeEvents === 0) {
      reasons.commercial = "No commitments or open change events recorded.";
      return null;
    }
    const cost = await costP;
    return {
      currency: cost?.currency ?? projectCurrency,
      commitments: commitmentCount,
      committedTotal: n(c?.committed),
      pendingCommitments: n(c?.pending),
      openChangeEvents,
      changeExposure: n(ce?.exposure),
      agedChangeEvents: n(ce?.aged),
      // exposure is only measured against a budget in the same currency — never converted
      revisedBudget:
        cost && cost.revisedBudget > 0 && (projectCurrency === null || cost.currency === projectCurrency)
          ? cost.revisedBudget
          : null,
    };
  })();

  /* ---------------- assurance ---------------- */
  const assuranceP = (async () => {
    const [s] = await db
      .select({
        critical: sql<number>`count(*) filter (where ${signals.severity} = 'critical')`,
        high: sql<number>`count(*) filter (where ${signals.severity} = 'high')`,
        medium: sql<number>`count(*) filter (where ${signals.severity} = 'medium')`,
        low: sql<number>`count(*) filter (where ${signals.severity} = 'low')`,
        info: sql<number>`count(*) filter (where ${signals.severity} = 'info')`,
      })
      .from(signals)
      .where(
        and(
          eq(signals.companyId, companyId),
          eq(signals.projectId, projectId),
          inArray(signals.disposition, OPEN_SIGNAL_DISPOSITIONS),
        ),
      );
    const [r] = await db
      .select({
        total: count(),
        contradicted: sql<number>`count(*) filter (where ${reconciliations.result} = 'contradicted')`,
        unsupported: sql<number>`count(*) filter (where ${reconciliations.result} = 'unsupported')`,
        insufficient: sql<number>`count(*) filter (where ${reconciliations.result} = 'insufficient_evidence')`,
      })
      .from(reconciliations)
      .where(
        and(
          eq(reconciliations.companyId, companyId),
          eq(reconciliations.projectId, projectId),
          gte(reconciliations.createdAt, ago90Iso),
        ),
      );
    const openSignals = { critical: n(s?.critical), high: n(s?.high), medium: n(s?.medium), low: n(s?.low), info: n(s?.info) };
    const recon = { total: n(r?.total), contradicted: n(r?.contradicted), unsupported: n(r?.unsupported), insufficient: n(r?.insufficient) };
    const openTotal = openSignals.critical + openSignals.high + openSignals.medium + openSignals.low + openSignals.info;
    if (openTotal === 0 && recon.total === 0) {
      reasons.assurance = "No open integrity signals and no reconciliations in the last 90 days.";
      return null;
    }
    return { openSignals, reconciliations: recon };
  })();

  /* ---------------- safety ---------------- */
  const safetyP = (async () => {
    const [inc] = await db
      .select({
        total: count(),
        recent: sql<number>`count(*) filter (where ${safetyIncidents.occurredAt} >= ${ago90Iso})`,
        fatalities: sql<number>`count(*) filter (where ${safetyIncidents.occurredAt} >= ${ago90Iso} and ${safetyIncidents.isFatality} = 1)`,
        major: sql<number>`count(*) filter (where ${safetyIncidents.occurredAt} >= ${ago90Iso} and ${safetyIncidents.severity} in ('major','catastrophic'))`,
        serious: sql<number>`count(*) filter (where ${safetyIncidents.occurredAt} >= ${ago90Iso} and ${safetyIncidents.severity} = 'serious')`,
        lostTime: sql<number>`count(*) filter (where ${safetyIncidents.occurredAt} >= ${ago90Iso} and ${safetyIncidents.isLostTime} = 1)`,
        open: sql<number>`count(*) filter (where ${safetyIncidents.status} not in ('closed','void'))`,
      })
      .from(safetyIncidents)
      .where(and(eq(safetyIncidents.companyId, companyId), eq(safetyIncidents.projectId, projectId)));
    const [obs] = await db
      .select({
        total: count(),
        open: sql<number>`count(*) filter (where ${safetyObservations.status} not in ('verified','closed','void'))`,
      })
      .from(safetyObservations)
      .where(and(eq(safetyObservations.companyId, companyId), eq(safetyObservations.projectId, projectId)));
    const [insp] = await db
      .select({ total: count() })
      .from(safetyInspections)
      .where(and(eq(safetyInspections.companyId, companyId), eq(safetyInspections.projectId, projectId)));
    const [acts] = await db
      .select({ overdue: count() })
      .from(safetyCorrectiveActions)
      .where(
        and(
          eq(safetyCorrectiveActions.companyId, companyId),
          eq(safetyCorrectiveActions.projectId, projectId),
          lt(safetyCorrectiveActions.dueDate, today),
          sql`${safetyCorrectiveActions.status} not in ('completed','verified','closed','cancelled')`,
        ),
      );
    const recordCount = n(inc?.total) + n(obs?.total) + n(insp?.total);
    if (recordCount === 0) {
      reasons.safety = "No incidents, observations or inspections recorded for this project.";
      return null;
    }
    return {
      recordCount,
      incidents90d: n(inc?.recent),
      fatalities: n(inc?.fatalities),
      majorOrCatastrophic: n(inc?.major),
      serious: n(inc?.serious),
      lostTime: n(inc?.lostTime),
      openIncidents: n(inc?.open),
      openObservations: n(obs?.open),
      overdueActions: n(acts?.overdue),
    };
  })();

  /* ---------------- quality ---------------- */
  const qualityP = (async () => {
    const [ncr] = await db
      .select({
        total: count(),
        critical: sql<number>`count(*) filter (where ${nonConformanceReports.status} not in ('closed','rejected','void') and ${nonConformanceReports.severity} = 'critical')`,
        major: sql<number>`count(*) filter (where ${nonConformanceReports.status} not in ('closed','rejected','void') and ${nonConformanceReports.severity} = 'major')`,
        minor: sql<number>`count(*) filter (where ${nonConformanceReports.status} not in ('closed','rejected','void') and ${nonConformanceReports.severity} = 'minor')`,
        overdue: sql<number>`count(*) filter (where ${nonConformanceReports.status} not in ('closed','rejected','void') and ${nonConformanceReports.responseDueDate} < ${today})`,
      })
      .from(nonConformanceReports)
      .where(and(eq(nonConformanceReports.companyId, companyId), eq(nonConformanceReports.projectId, projectId)));
    const [itp] = await db
      .select({
        total: count(),
        failed: sql<number>`count(*) filter (where ${itpActivities.status} = 'failed')`,
        holdPending: sql<number>`count(*) filter (where ${itpActivities.interventionPoint} = 'hold_point' and ${itpActivities.status} in ('pending','notified'))`,
      })
      .from(itpActivities)
      .where(and(eq(itpActivities.companyId, companyId), eq(itpActivities.projectId, projectId)));
    if (n(ncr?.total) === 0 && n(itp?.total) === 0) {
      reasons.quality = "No NCRs or inspection & test plan activities recorded.";
      return null;
    }
    return {
      ncrsOpen: { critical: n(ncr?.critical), major: n(ncr?.major), minor: n(ncr?.minor) },
      overdueNcrResponses: n(ncr?.overdue),
      itpActivities: n(itp?.total),
      itpFailed: n(itp?.failed),
      holdPointsPending: n(itp?.holdPending),
    };
  })();

  /* ---------------- field ---------------- */
  const fieldP = (async () => {
    const [r] = await db
      .select({
        total: count(),
        open: sql<number>`count(*) filter (where ${rfis.status} in ('open','answered'))`,
        overdue: sql<number>`count(*) filter (where ${rfis.status} in ('open','answered') and ${rfis.dueDate} < ${today})`,
      })
      .from(rfis)
      .where(and(eq(rfis.companyId, companyId), eq(rfis.projectId, projectId)));
    const [s] = await db
      .select({
        total: count(),
        open: sql<number>`count(*) filter (where ${submittals.status} in ('draft','open','in_review','responded'))`,
        overdue: sql<number>`count(*) filter (where ${submittals.status} in ('draft','open') and ${submittals.submitByDate} < ${today})`,
      })
      .from(submittals)
      .where(and(eq(submittals.companyId, companyId), eq(submittals.projectId, projectId)));
    const [p] = await db
      .select({
        total: count(),
        open: sql<number>`count(*) filter (where ${punchItems.status} in ('open','in_progress','ready_for_review'))`,
        overdue: sql<number>`count(*) filter (where ${punchItems.status} in ('open','in_progress','ready_for_review') and ${punchItems.dueDate} < ${today})`,
      })
      .from(punchItems)
      .where(and(eq(punchItems.companyId, companyId), eq(punchItems.projectId, projectId)));
    if (n(r?.total) + n(s?.total) + n(p?.total) === 0) {
      reasons.field = "No RFIs, submittals or punch items recorded.";
      return null;
    }
    return {
      rfisOpen: n(r?.open),
      rfisOverdue: n(r?.overdue),
      submittalsOpen: n(s?.open),
      submittalsOverdue: n(s?.overdue),
      punchOpen: n(p?.open),
      punchOverdue: n(p?.overdue),
    };
  })();

  /* ---------------- contract ---------------- */
  const contractP = (async () => {
    const [ev] = await db
      .select({
        total: count(),
        timeBarred: sql<number>`count(*) filter (where ${contractEvents.status} = 'time_barred')`,
        within7: sql<number>`count(*) filter (where ${contractEvents.status} = 'open' and ${contractEvents.noticeDeadline} >= ${today} and ${contractEvents.noticeDeadline} <= ${in7})`,
      })
      .from(contractEvents)
      .where(and(eq(contractEvents.companyId, companyId), eq(contractEvents.projectId, projectId)));
    const [ob] = await db
      .select({
        open: sql<number>`count(*) filter (where ${obligations.status} = 'open')`,
        breached: sql<number>`count(*) filter (where ${obligations.status} = 'breached')`,
        due7: sql<number>`count(*) filter (where ${obligations.status} = 'open' and ${obligations.deadline} is not null and ${obligations.deadline} <= ${in7Iso})`,
      })
      .from(obligations)
      .where(and(eq(obligations.companyId, companyId), eq(obligations.projectId, projectId)));
    const events = n(ev?.total);
    const open = n(ob?.open);
    const breached = n(ob?.breached);
    if (events === 0 && open === 0 && breached === 0) {
      reasons.contract = "No contract events or open obligations recorded.";
      return null;
    }
    return {
      events,
      timeBarred: n(ev?.timeBarred),
      deadlinesWithin7d: n(ev?.within7),
      obligationsOpen: open,
      obligationsBreached: breached,
      obligationsDue7d: n(ob?.due7),
    };
  })();

  /* ---------------- risk ---------------- */
  const riskP = (async () => {
    const [r] = await db
      .select({
        total: count(),
        open: sql<number>`count(*) filter (where ${risks.status} = 'open')`,
        mitigating: sql<number>`count(*) filter (where ${risks.status} = 'mitigating')`,
        realised: sql<number>`count(*) filter (where ${risks.status} = 'realised')`,
        high: sql<number>`count(*) filter (where ${risks.status} in ('open','mitigating') and ${risks.probabilityScore} * ${risks.impactScore} >= 15)`,
      })
      .from(risks)
      .where(and(eq(risks.companyId, companyId), eq(risks.projectId, projectId)));
    if (n(r?.total) === 0) {
      reasons.risk = "No risk register entries for this project.";
      return null;
    }
    return { open: n(r?.open), high: n(r?.high), realised: n(r?.realised), mitigating: n(r?.mitigating) };
  })();

  /* ---------------- finance ---------------- */
  const financeP = (async () => {
    const covRows = await db
      .select({ id: covenants.id })
      .from(covenants)
      .where(and(eq(covenants.companyId, companyId), eq(covenants.projectId, projectId)))
      .limit(500);
    let breached = 0;
    let unread = 0;
    if (covRows.length > 0) {
      const ids = covRows.map((c) => c.id);
      const readings = await db
        .select({ covenantId: covenantReadings.covenantId, compliant: covenantReadings.compliant, readingDate: covenantReadings.readingDate, createdAt: covenantReadings.createdAt })
        .from(covenantReadings)
        .where(and(eq(covenantReadings.companyId, companyId), inArray(covenantReadings.covenantId, ids)))
        .orderBy(desc(covenantReadings.readingDate), desc(covenantReadings.createdAt))
        .limit(5000);
      const latest = new Map<string, number>();
      for (const rd of readings) if (!latest.has(rd.covenantId)) latest.set(rd.covenantId, rd.compliant);
      for (const id of ids) {
        const c = latest.get(id);
        if (c === undefined) unread += 1;
        else if (c === 0) breached += 1;
      }
    }
    const [claims] = await db
      .select({
        deemed: sql<number>`count(*) filter (where ${paymentClaims.status} = 'deemed')`,
        suspended: sql<number>`count(*) filter (where ${paymentClaims.status} = 'suspended')`,
      })
      .from(paymentClaims)
      .where(and(eq(paymentClaims.companyId, companyId), eq(paymentClaims.projectId, projectId)));
    const [conds] = await db
      .select({ overdue: count() })
      .from(facilityConditions)
      .where(
        and(
          eq(facilityConditions.companyId, companyId),
          eq(facilityConditions.projectId, projectId),
          eq(facilityConditions.status, "open"),
          lt(facilityConditions.dueDate, today),
        ),
      );
    const out = {
      covenants: covRows.length,
      breached,
      unread,
      claimsDeemed: n(claims?.deemed),
      claimsSuspended: n(claims?.suspended),
      conditionsOverdue: n(conds?.overdue),
    };
    if (out.covenants + out.claimsDeemed + out.claimsSuspended + out.conditionsOverdue === 0) {
      reasons.finance = "No covenants, overdue facility conditions or statutory payment claims recorded.";
      return null;
    }
    return out;
  })();

  const [schedule, cost, commercial, assurance, safety, quality, field, contract, risk, finance] =
    await Promise.all([scheduleP, costP, commercialP, assuranceP, safetyP, qualityP, fieldP, contractP, riskP, financeP]);

  return {
    asOf: nowIso,
    schedule,
    cost,
    commercial,
    assurance,
    safety,
    quality,
    field,
    contract,
    risk,
    finance,
    reasons,
  };
}
