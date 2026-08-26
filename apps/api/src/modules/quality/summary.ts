/**
 * The quality dashboard payload, and the explicit sweep endpoint.
 *
 * Every figure here obeys the platform's honesty rule (see
 * modules/benchmarks/metrics.ts): where the inputs are not held, the value is
 * `null` and `reasons` says what is missing. A first-time-pass rate of 0%
 * computed over zero checklists is a lie that reads like a crisis, and a rate
 * of 100% computed the same way is a lie that reads like success. Neither is
 * ever returned.
 */

import type { FastifyPluginAsync } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  checklists,
  commissioningSystems,
  inspectionTestPlans,
  itpActivities,
  nonConformanceReports,
  turnoverPackages,
} from "@constructos/db";
import { buildGates, figure, isoDateSchema, medianOrNull, round2, todayISO } from "./shared.js";
import { isUnreleasedPastPlannedDate, isTerminalActivityStatus, noticeStatus } from "./holdPoints.js";
import { artefactGap } from "./turnover.js";
import { sweepQuality } from "./sweeps.js";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

const sweepBodySchema = z.object({ asOf: isoDateSchema.optional() });

const OPEN_NCR_STATUSES = [
  "open",
  "under_review",
  "disposition_proposed",
  "disposition_approved",
  "action_in_progress",
  "verification_pending",
];

export const summaryRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate } = buildGates(app);

  /**
   * Run every quality detector now. Idempotent — the second call over an
   * unchanged project raises nothing, which is asserted by the tests rather
   * than assumed. Exposed mostly so a scheduler or an operator can force the
   * pass; the ordinary path is the lazy sweep on every list read.
   */
  app.post("/projects/:projectId/quality/sweep", { preHandler: standardGate }, async (req) => {
    const body = sweepBodySchema.parse(req.body ?? {});
    const outcome = await sweepQuality(
      app.db,
      req.companyId!,
      req.projectId!,
      req.user!.id,
      body.asOf ?? todayISO(),
    );
    return outcome;
  });

  app.get("/projects/:projectId/quality/summary", { preHandler: readGate }, async (req) => {
    await sweepQuality(app.db, req.companyId!, req.projectId!, req.user!.id);
    const scope = { companyId: req.companyId!, projectId: req.projectId! };
    const today = todayISO();
    const nowMs = Date.now();

    const [itpRows, activityRows, checklistRows, ncrRows, systemRows, packageRows] =
      await Promise.all([
        app.db
          .select()
          .from(inspectionTestPlans)
          .where(
            and(
              eq(inspectionTestPlans.companyId, scope.companyId),
              eq(inspectionTestPlans.projectId, scope.projectId),
            ),
          ),
        app.db
          .select()
          .from(itpActivities)
          .where(
            and(
              eq(itpActivities.companyId, scope.companyId),
              eq(itpActivities.projectId, scope.projectId),
            ),
          ),
        app.db
          .select()
          .from(checklists)
          .where(
            and(eq(checklists.companyId, scope.companyId), eq(checklists.projectId, scope.projectId)),
          ),
        app.db
          .select()
          .from(nonConformanceReports)
          .where(
            and(
              eq(nonConformanceReports.companyId, scope.companyId),
              eq(nonConformanceReports.projectId, scope.projectId),
            ),
          ),
        app.db
          .select()
          .from(commissioningSystems)
          .where(
            and(
              eq(commissioningSystems.companyId, scope.companyId),
              eq(commissioningSystems.projectId, scope.projectId),
            ),
          ),
        app.db
          .select()
          .from(turnoverPackages)
          .where(
            and(
              eq(turnoverPackages.companyId, scope.companyId),
              eq(turnoverPackages.projectId, scope.projectId),
            ),
          ),
      ]);

    const countBy = <T extends Record<string, unknown>>(rows: T[], key: keyof T) => {
      const out: Record<string, number> = {};
      for (const row of rows) {
        const value = String(row[key]);
        out[value] = (out[value] ?? 0) + 1;
      }
      return out;
    };

    /* --- hold points --- */
    const holdPoints = activityRows.filter((a) => a.interventionPoint === "hold_point");
    const openHoldPoints = holdPoints.filter((a) => !isTerminalActivityStatus(a.status));
    const overdueHoldPoints = holdPoints.filter((a) => isUnreleasedPastPlannedDate(a, today));
    const withoutNotice = openHoldPoints.filter((a) => !a.notifiedAt);
    const releaseLatencies = activityRows
      .filter((a) => a.notifiedAt && a.releasedAt)
      .map((a) => (Date.parse(a.releasedAt!) - Date.parse(a.notifiedAt!)) / MS_PER_HOUR)
      .filter((h) => Number.isFinite(h) && h >= 0);
    const medianReleaseLatencyHours = medianOrNull(releaseLatencies);

    /* --- checklists: first-time pass --- */
    const judged = checklistRows.filter((c) => c.result !== null);
    const passed = judged.filter(
      (c) => c.result === "pass" || c.result === "pass_with_observations",
    );
    const firstTimePassRate =
      judged.length === 0
        ? figure(null, "percent", { judgedChecklists: 0 }, [
            "No checklist on this project has been completed with a result, so there is no first-time-pass rate to report. A rate computed over zero records would read as either a crisis or a success and would be neither.",
          ])
        : figure(
            round2((passed.length / judged.length) * 100),
            "percent",
            { judgedChecklists: judged.length, passed: passed.length },
            [],
          );

    /* --- NCRs --- */
    const openNcrs = ncrRows.filter((n) => OPEN_NCR_STATUSES.includes(n.status));
    const overdueNcrs = openNcrs.filter(
      (n) => n.responseDueDate !== null && n.responseDueDate < today,
    );
    const closureDays = ncrRows
      .filter((n) => n.status === "closed" && n.detectedAt && n.verifiedAt)
      .map((n) => (Date.parse(n.verifiedAt!) - Date.parse(n.detectedAt!)) / MS_PER_DAY)
      .filter((d) => Number.isFinite(d) && d >= 0);
    const medianClosureDays =
      closureDays.length === 0
        ? figure(null, "days", { closedNcrs: 0 }, [
            "No NCR on this project has been closed with both a detection timestamp and an independent verification, so no closure duration can be computed.",
          ])
        : figure(
            round2(medianOrNull(closureDays)!),
            "days",
            { closedNcrs: closureDays.length },
            [],
          );
    const ncrCostImpacts = ncrRows
      .map((n) => n.costImpact)
      .filter((c): c is number => typeof c === "number");
    const totalNcrCost =
      ncrCostImpacts.length === 0
        ? figure(null, "currency", { ncrsWithCost: 0, totalNcrs: ncrRows.length }, [
            "No NCR on this project carries a recorded cost impact, so the cost of non-conformance cannot be totalled. It is not zero — it is unmeasured.",
          ])
        : figure(
            round2(ncrCostImpacts.reduce((a, b) => a + b, 0)),
            "currency",
            {
              ncrsWithCost: ncrCostImpacts.length,
              totalNcrs: ncrRows.length,
              currency: ncrRows[0]?.currency ?? "USD",
            },
            ncrCostImpacts.length < ncrRows.length
              ? [
                  `${ncrRows.length - ncrCostImpacts.length} of ${ncrRows.length} NCRs carry no cost impact and are excluded from the total, which is therefore a floor rather than the figure.`,
                ]
              : [],
          );

    /* --- commissioning + turnover --- */
    const systemsWithoutAsset = systemRows.filter((s) => !s.assetId);
    let requiredArtefacts = 0;
    let presentArtefacts = 0;
    const packageGaps = packageRows.map((p) => {
      const gap = artefactGap(p.contents);
      requiredArtefacts += gap.requiredArtefactCount;
      presentArtefacts += gap.presentArtefactCount;
      return { id: p.id, reference: p.reference, status: p.status, ...gap };
    });
    const turnoverCompleteness =
      requiredArtefacts === 0
        ? figure(null, "percent", { requiredArtefacts, presentArtefacts }, [
            "No turnover package declares a required artefact, so there is no denominator for a completeness figure.",
          ])
        : figure(
            round2((presentArtefacts / requiredArtefacts) * 100),
            "percent",
            { requiredArtefacts, presentArtefacts },
            [],
          );

    return {
      itps: {
        total: itpRows.length,
        byStatus: countBy(itpRows, "status"),
      },
      holdPoints: {
        total: holdPoints.length,
        open: openHoldPoints.length,
        overdue: overdueHoldPoints.length,
        overdueIds: overdueHoldPoints.map((a) => a.id),
        openWithoutNoticeServed: withoutNotice.length,
        medianReleaseLatencyHours:
          medianReleaseLatencyHours === null
            ? figure(null, "hours", { released: 0 }, [
                "No hold point on this project has both a notice timestamp and a release timestamp, so release latency cannot be computed.",
              ])
            : figure(
                round2(medianReleaseLatencyHours),
                "hours",
                { released: releaseLatencies.length },
                [],
              ),
        witnessPointsAwaitingNotice: activityRows
          .filter(
            (a) =>
              a.interventionPoint === "witness_point" &&
              !isTerminalActivityStatus(a.status) &&
              !noticeStatus(a, nowMs).served,
          )
          .map((a) => a.id),
      },
      checklists: {
        total: checklistRows.length,
        byStatus: countBy(checklistRows, "status"),
        byResult: countBy(judged, "result"),
        firstTimePassRate,
        criticalFailures: checklistRows.reduce((n, c) => n + c.criticalFailureCount, 0),
      },
      ncrs: {
        total: ncrRows.length,
        open: openNcrs.length,
        overdue: overdueNcrs.length,
        overdueReferences: overdueNcrs.map((n) => n.reference),
        byStatus: countBy(ncrRows, "status"),
        bySeverity: countBy(ncrRows, "severity"),
        byDisposition: countBy(ncrRows, "disposition"),
        awaitingDispositionApproval: ncrRows.filter((n) => n.status === "disposition_proposed")
          .length,
        backcharged: ncrRows.filter((n) => n.isBackcharged === 1).length,
        medianClosureDays,
        totalCostImpact: totalNcrCost,
      },
      commissioning: {
        systems: systemRows.length,
        byStatus: countBy(systemRows, "status"),
        openDeficiencies: systemRows.reduce((n, s) => n + s.openDeficiencyCount, 0),
        systemsWithoutTwinAsset: systemsWithoutAsset.map((s) => s.systemCode),
      },
      turnover: {
        packages: packageRows.length,
        byStatus: countBy(packageRows, "status"),
        handedOver: packageRows.filter((p) => p.handedOverAt !== null).length,
        assetsHandedOver: packageRows.reduce((n, p) => n + p.assetCount, 0),
        artefactCompleteness: turnoverCompleteness,
        gaps: packageGaps.filter((g) => g.gap > 0),
      },
    };
  });
};
