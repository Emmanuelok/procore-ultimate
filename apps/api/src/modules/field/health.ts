/**
 * Field health inputs for the intelligence layer (plan §3.5): the cheap
 * counts the project-health engine folds into its "field" dimension. Every
 * metric is a number the tables can state; anything they cannot is null with
 * a reason, never zero.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, count, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { dailyLogs, fieldEscalations, fieldObservations, punchItems, rfis, submittals } from "@constructos/db";
import { addDaysISO, todayISO } from "./dates.js";
import { businessDaysBetween } from "./dailyLogEngine.js";
import { PUNCH_OPEN_STATUSES } from "./punchEngine.js";
import { loadFieldSettings } from "./settings.js";

export const fieldHealthRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("rfis", "read")];

  app.get("/projects/:projectId/field/health-inputs", { preHandler: readGate }, async (req) => {
    const companyId = req.companyId!;
    const projectId = req.projectId!;
    const today = todayISO();
    const settings = await loadFieldSettings(app.db, companyId, projectId);
    const reasons: string[] = [];
    const n = (v: unknown) => Number(v ?? 0);

    const [rfi] = await app.db
      .select({
        open: sql<number>`count(*) filter (where ${rfis.status} = 'open')`,
        overdue: sql<number>`count(*) filter (where ${rfis.status} = 'open' and ${rfis.dueDate} < ${today})`,
        total: count(),
      })
      .from(rfis)
      .where(and(eq(rfis.companyId, companyId), eq(rfis.projectId, projectId)));
    const [sub] = await app.db
      .select({
        open: sql<number>`count(*) filter (where ${submittals.status} in ('draft','open','in_review'))`,
        overdue: sql<number>`count(*) filter (where ${submittals.status} in ('draft','open','in_review') and ${submittals.submitByDate} < ${today})`,
        atRisk: sql<number>`count(*) filter (where ${submittals.status} in ('draft','open','in_review') and ${submittals.submitByDate} >= ${today} and ${submittals.submitByDate} < ${addDaysISO(today, settings.submittal.atRiskDays)})`,
        inReview: sql<number>`count(*) filter (where ${submittals.status} = 'in_review')`,
        total: count(),
      })
      .from(submittals)
      .where(and(eq(submittals.companyId, companyId), eq(submittals.projectId, projectId)));
    const [punch] = await app.db
      .select({
        open: sql<number>`count(*) filter (where ${punchItems.status} in ('open','in_progress','ready_for_review'))`,
        overdue: sql<number>`count(*) filter (where ${punchItems.status} in ('open','in_progress','ready_for_review') and ${punchItems.dueDate} < ${today})`,
        closed: sql<number>`count(*) filter (where ${punchItems.status} = 'closed')`,
        total: sql<number>`count(*) filter (where ${punchItems.status} <> 'void')`,
      })
      .from(punchItems)
      .where(and(eq(punchItems.companyId, companyId), eq(punchItems.projectId, projectId)));
    const [obs] = await app.db
      .select({
        open: sql<number>`count(*) filter (where ${fieldObservations.status} in ('open','in_progress','ready_for_review'))`,
        overdue: sql<number>`count(*) filter (where ${fieldObservations.status} in ('open','in_progress','ready_for_review') and ${fieldObservations.dueDate} < ${today})`,
        safetyOpen: sql<number>`count(*) filter (where ${fieldObservations.status} in ('open','in_progress','ready_for_review') and ${fieldObservations.observationType} = 'safety')`,
      })
      .from(fieldObservations)
      .where(and(eq(fieldObservations.companyId, companyId), eq(fieldObservations.projectId, projectId)));

    const from = addDaysISO(today, -14);
    const yesterday = addDaysISO(today, -1);
    const expectedDays = businessDaysBetween(from, yesterday);
    const [logCount] = await app.db.select({ n: count() }).from(dailyLogs).where(and(eq(dailyLogs.companyId, companyId), eq(dailyLogs.projectId, projectId)));
    let dailyLogMissingDays14: number | null = null;
    if (n(logCount?.n) === 0) {
      reasons.push("No daily logs have ever been kept on this project — missing-day count is not available.");
    } else {
      const logged = await app.db
        .select({ logDate: dailyLogs.logDate })
        .from(dailyLogs)
        .where(and(eq(dailyLogs.companyId, companyId), eq(dailyLogs.projectId, projectId), inArray(dailyLogs.status, ["submitted", "approved"]), gte(dailyLogs.logDate, from), lt(dailyLogs.logDate, today)));
      const covered = new Set(logged.map((l) => l.logDate));
      dailyLogMissingDays14 = expectedDays.filter((d) => !covered.has(d)).length;
    }
    const [esc] = await app.db
      .select({ n: count() })
      .from(fieldEscalations)
      .where(and(eq(fieldEscalations.companyId, companyId), eq(fieldEscalations.projectId, projectId), eq(fieldEscalations.level, 3), isNotNull(fieldEscalations.signalId), gte(fieldEscalations.notifiedAt, new Date(Date.now() - 30 * 86_400_000).toISOString())));

    if (n(rfi?.total) === 0 && n(sub?.total) === 0 && n(punch?.total) === 0) {
      reasons.push("No RFIs, submittals or punch items recorded yet.");
    }
    const punchTotal = n(punch?.total);
    return {
      metrics: {
        rfisOpen: n(rfi?.open),
        rfisOverdue: n(rfi?.overdue),
        submittalsOpen: n(sub?.open),
        submittalsOverdue: n(sub?.overdue),
        submittalsAtRisk: n(sub?.atRisk),
        submittalsInReview: n(sub?.inReview),
        punchOpen: n(punch?.open),
        punchOverdue: n(punch?.overdue),
        punchCompletionPct: punchTotal > 0 ? Math.round((n(punch?.closed) / punchTotal) * 1000) / 10 : null,
        observationsOpen: n(obs?.open),
        observationsOverdue: n(obs?.overdue),
        safetyObservationsOpen: n(obs?.safetyOpen),
        dailyLogMissingDays14,
        dailyLogExpectedDays14: expectedDays.length,
        escalationSignalsLast30: n(esc?.n),
      },
      reasons,
      asOf: today,
    };
  });
};
