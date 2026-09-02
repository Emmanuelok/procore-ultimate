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
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  calibratedInstruments,
  checklistTemplates,
  checklists,
  commissioningSystems,
  commissioningTestRecords,
  concretePours,
  defectsLiabilityPeriods,
  dlpDefects,
  inspectionTestPlans,
  itpActivities,
  materialTestCertificates,
  ndtRecords,
  nonConformanceReports,
  operatorTrainingRecords,
  performanceGuarantees,
  qualityAuditFindings,
  qualityAudits,
  qualityConcessions,
  reworkItems,
  turnoverPackages,
  vendors,
  welds,
} from "@constructos/db";
import {
  buildGates,
  figure,
  isoDateSchema,
  medianOrNull,
  round2,
  todayISO,
  totalsByCurrency,
} from "./shared.js";
import { costOfQuality, firstTimeRightByTrade } from "./costOfQuality.js";
import { instrumentStanding } from "./calibrationStatus.js";
import { concessionStanding } from "./concessions.js";
import { dlpStanding } from "./closeout.js";
import { assessGuarantee } from "./guarantees.js";
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
    /*
     * COST OF NON-CONFORMANCE, BUCKETED BY CURRENCY.
     *
     * NCRs carry their own currency. Adding a GBP cost impact to a USD one and
     * labelling the result with whichever currency happened to be on the first
     * row is not a rounding error, it is a fabricated number — so the register
     * returns one figure per currency and a null total whenever more than one
     * currency is present, with the per-currency figures beside it.
     */
    const ncrMoney = totalsByCurrency(
      ncrRows.map((n) => ({ amount: n.costImpact, currency: n.currency })),
    );
    const excludedReason =
      ncrMoney.withoutAmount > 0
        ? [
            `${ncrMoney.withoutAmount} of ${ncrRows.length} NCRs carry no cost impact and are excluded, so every total below is a floor rather than the figure.`,
          ]
        : [];
    const costByCurrency = ncrMoney.totals.map((t) =>
      figure(t.amount, t.currency, { ncrsWithCost: t.recordCount, currency: t.currency }, excludedReason),
    );
    const totalNcrCost =
      ncrMoney.totals.length === 0
        ? figure(null, "currency", { ncrsWithCost: 0, totalNcrs: ncrRows.length }, [
            "No NCR on this project carries a recorded cost impact, so the cost of non-conformance cannot be totalled. It is not zero — it is unmeasured.",
          ])
        : ncrMoney.totals.length === 1
          ? figure(
              ncrMoney.totals[0]!.amount,
              ncrMoney.totals[0]!.currency,
              {
                ncrsWithCost: ncrMoney.totals[0]!.recordCount,
                totalNcrs: ncrRows.length,
                currency: ncrMoney.totals[0]!.currency,
              },
              excludedReason,
            )
          : figure(
              null,
              "currency",
              {
                currencies: ncrMoney.totals.map((t) => t.currency),
                ncrsWithCost: ncrMoney.withAmount,
                totalNcrs: ncrRows.length,
              },
              [
                `Costs are recorded in ${ncrMoney.totals.length} currencies (${ncrMoney.totals
                  .map((t) => `${t.currency} ${t.amount}`)
                  .join(", ")}). They are reported per currency rather than summed — a cross-currency total would be an invented number.`,
                ...excludedReason,
              ],
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

    /*
     * The Domain Z and closeout registers, as counts. Cheap indexed counts
     * rather than full loads: the overview needs to know whether a register
     * has anything in it and whether anything in it is overdue, and the tab
     * for each register loads its own detail.
     */
    const [
      concessionRows,
      pourRows,
      weldRows,
      ndtRows,
      certificateRows,
      instrumentRows,
      reworkRows,
      auditRows,
      findingRows,
      dlpRows,
      guaranteeRows,
    ] = await Promise.all([
      app.db.select().from(qualityConcessions).where(and(eq(qualityConcessions.companyId, scope.companyId), eq(qualityConcessions.projectId, scope.projectId))),
      app.db.select().from(concretePours).where(and(eq(concretePours.companyId, scope.companyId), eq(concretePours.projectId, scope.projectId))),
      app.db.select().from(welds).where(and(eq(welds.companyId, scope.companyId), eq(welds.projectId, scope.projectId))),
      app.db.select().from(ndtRecords).where(and(eq(ndtRecords.companyId, scope.companyId), eq(ndtRecords.projectId, scope.projectId))),
      app.db.select().from(materialTestCertificates).where(and(eq(materialTestCertificates.companyId, scope.companyId), eq(materialTestCertificates.projectId, scope.projectId))),
      app.db.select().from(calibratedInstruments).where(and(eq(calibratedInstruments.companyId, scope.companyId), eq(calibratedInstruments.projectId, scope.projectId))),
      app.db.select().from(reworkItems).where(and(eq(reworkItems.companyId, scope.companyId), eq(reworkItems.projectId, scope.projectId))),
      app.db.select().from(qualityAudits).where(and(eq(qualityAudits.companyId, scope.companyId), eq(qualityAudits.projectId, scope.projectId))),
      app.db.select().from(qualityAuditFindings).where(and(eq(qualityAuditFindings.companyId, scope.companyId), eq(qualityAuditFindings.projectId, scope.projectId))),
      app.db.select().from(defectsLiabilityPeriods).where(and(eq(defectsLiabilityPeriods.companyId, scope.companyId), eq(defectsLiabilityPeriods.projectId, scope.projectId))),
      app.db.select().from(performanceGuarantees).where(and(eq(performanceGuarantees.companyId, scope.companyId), eq(performanceGuarantees.projectId, scope.projectId))),
    ]);

    const liveConcessions = concessionRows.filter((c) => concessionStanding(c, today).live);
    const instrumentStandings = instrumentRows.map((i) => instrumentStanding(i, today));
    const guaranteeAssessments = guaranteeRows.map((g) =>
      assessGuarantee({
        id: g.id,
        reference: g.reference,
        parameter: g.parameter,
        operator: g.operator,
        guaranteedValue: g.guaranteedValue,
        guaranteedMin: g.guaranteedMin,
        guaranteedMax: g.guaranteedMax,
        unit: g.unit,
        tolerancePercent: g.tolerancePercent,
        measuredValue: g.measuredValue,
        ldRatePerUnit: g.ldRatePerUnit,
        ldCapAmount: g.ldCapAmount,
        currency: g.currency,
        status: g.status,
      }),
    );
    const reworkMoney = totalsByCurrency(
      reworkRows
        .filter((r) => r.status !== "cancelled")
        .map((r) => ({ amount: r.totalCost, currency: r.currency })),
    );

    const registers = {
      concessions: {
        total: concessionRows.length,
        live: liveConcessions.length,
        expired: concessionRows.filter((c) => c.status === "expired").length,
        awaitingDecision: concessionRows.filter(
          (c) => c.status === "submitted" || c.status === "under_review",
        ).length,
        expiringWithin30Days: liveConcessions.filter((c) => {
          const d = concessionStanding(c, today).daysToExpiry;
          return d !== null && d <= 30;
        }).length,
      },
      concrete: {
        pours: pourRows.length,
        poured: pourRows.filter((p) => p.pouredAt !== null).length,
        failing: pourRows.filter((p) => p.acceptanceVerdict === "rejected").length,
        awaitingResults: pourRows.filter(
          (p) => p.pouredAt !== null && p.testedSpecimenCount < p.specimenCount,
        ).length,
        pouredWithoutRelease: pourRows.filter(
          (p) => (p.detail as Record<string, unknown>)["pouredWithoutRelease"] === true,
        ).length,
      },
      welding: {
        welds: weldRows.length,
        welded: weldRows.filter((w) => w.weldedAt !== null).length,
        rejected: weldRows.filter((w) => w.status === "rejected").length,
        ndtRecords: ndtRows.length,
        pendingExaminations: ndtRows.filter((r) => r.result === "pending").length,
        awaitingRequiredNdt: weldRows.filter(
          (w) => w.ndtRequiredPercent !== null && w.ndtRequiredPercent > 0 && w.ndtRecordCount === 0,
        ).length,
      },
      certificates: {
        total: certificateRows.length,
        unverified: certificateRows.filter((c) => c.verificationStatus === "unverified").length,
        failed: certificateRows.filter((c) => c.verificationStatus === "failed").length,
        withoutTraceability: certificateRows.filter(
          (c) => !c.heatNumber && !c.batchNumber && !c.castNumber,
        ).length,
      },
      calibration: {
        instruments: instrumentRows.length,
        overdue: instrumentStandings.filter((s) => s.status === "overdue").length,
        dueSoon: instrumentStandings.filter((s) => s.status === "due_soon").length,
        unusable: instrumentStandings.filter((s) => !s.usable).length,
      },
      rework: {
        total: reworkRows.length,
        open: reworkRows.filter((r) => ["identified", "approved", "in_progress"].includes(r.status))
          .length,
        costByCurrency: reworkMoney.totals,
        uncosted: reworkMoney.withoutAmount,
      },
      audits: {
        total: auditRows.length,
        open: auditRows.filter((a) => a.status !== "closed" && a.status !== "cancelled").length,
        findings: findingRows.length,
        openFindings: findingRows.filter((f) =>
          ["open", "response_received", "action_agreed", "action_complete"].includes(f.status),
        ).length,
        majorNonConformities: findingRows.filter((f) => f.findingType === "major_nonconformity")
          .length,
        overdueFindings: findingRows.filter(
          (f) =>
            f.dueDate !== null &&
            f.dueDate < today &&
            ["open", "response_received", "action_agreed", "action_complete"].includes(f.status),
        ).length,
      },
      closeout: {
        liabilityPeriods: dlpRows.length,
        expiringWithin60Days: dlpRows.filter((d) => dlpStanding(d, today).status === "expiring")
          .length,
        expired: dlpRows.filter((d) => dlpStanding(d, today).status === "expired").length,
        guarantees: guaranteeRows.length,
        guaranteesNotMet: guaranteeAssessments.filter((a) => a.met === false).length,
        guaranteesUnmeasured: guaranteeAssessments.filter(
          (a) => a.met === null && a.status !== "waived",
        ).length,
      },
    };

    return {
      registers,
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
        costByCurrency,
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

  /* ---------------------------------------------------------------- */
  /* Cost of quality (#1099) and first-time right (#1100)              */
  /* ---------------------------------------------------------------- */

  /**
   * The PAF model over what this project actually holds. Prevention and
   * appraisal are counted rather than costed — the platform does not hold the
   * inspection hours, and reporting them as zero would make the ratio
   * flattering and false. Failure money is bucketed by currency and never
   * summed across them.
   */
  app.get("/projects/:projectId/quality/cost-of-quality", { preHandler: readGate }, async (req) => {
    const scope = { companyId: req.companyId!, projectId: req.projectId! };
    const [rework, ncrs, defects, itps, templates, training, checklistRows, tests, ndt, specimenPours, audits] =
      await Promise.all([
        app.db.select().from(reworkItems).where(and(eq(reworkItems.companyId, scope.companyId), eq(reworkItems.projectId, scope.projectId))),
        app.db.select().from(nonConformanceReports).where(and(eq(nonConformanceReports.companyId, scope.companyId), eq(nonConformanceReports.projectId, scope.projectId))),
        app.db.select().from(dlpDefects).where(and(eq(dlpDefects.companyId, scope.companyId), eq(dlpDefects.projectId, scope.projectId))),
        app.db.select().from(inspectionTestPlans).where(and(eq(inspectionTestPlans.companyId, scope.companyId), eq(inspectionTestPlans.projectId, scope.projectId))),
        app.db.select().from(checklistTemplates).where(eq(checklistTemplates.companyId, scope.companyId)),
        app.db.select().from(operatorTrainingRecords).where(and(eq(operatorTrainingRecords.companyId, scope.companyId), eq(operatorTrainingRecords.projectId, scope.projectId))),
        app.db.select().from(checklists).where(and(eq(checklists.companyId, scope.companyId), eq(checklists.projectId, scope.projectId))),
        app.db.select().from(commissioningTestRecords).where(and(eq(commissioningTestRecords.companyId, scope.companyId), eq(commissioningTestRecords.projectId, scope.projectId))),
        app.db.select().from(ndtRecords).where(and(eq(ndtRecords.companyId, scope.companyId), eq(ndtRecords.projectId, scope.projectId))),
        app.db.select().from(concretePours).where(and(eq(concretePours.companyId, scope.companyId), eq(concretePours.projectId, scope.projectId))),
        app.db.select().from(qualityAudits).where(and(eq(qualityAudits.companyId, scope.companyId), eq(qualityAudits.projectId, scope.projectId))),
      ]);
    return costOfQuality({
      rework: rework.map((r) => ({
        id: r.id,
        totalCost: r.totalCost,
        currency: r.currency,
        causeCategory: r.causeCategory,
        discoveryPhase: r.discoveryPhase,
        status: r.status,
        trade: r.trade,
        responsibleVendorId: r.responsibleVendorId,
        labourHours: r.labourHours,
      })),
      ncrs: ncrs.map((n) => ({
        id: n.id,
        costImpact: n.costImpact,
        currency: n.currency,
        status: n.status,
      })),
      dlpDefects: defects.map((d) => ({ id: d.id, cost: d.cost, currency: d.currency })),
      activity: {
        approvedItps: itps.filter((i) => i.status === "approved" || i.status === "active" || i.status === "closed").length,
        approvedTemplates: templates.filter((t) => t.status === "active").length,
        trainingSessions: training.filter((t) => t.status === "delivered" || t.status === "accepted").length,
        completedChecklists: checklistRows.filter((c) => c.performedAt !== null).length,
        commissioningTests: tests.filter((t) => t.performedAt !== null).length,
        ndtExaminations: ndt.filter((n) => n.result !== "pending").length,
        concreteSpecimens: specimenPours.reduce((n, p) => n + p.testedSpecimenCount, 0),
        qualityAudits: audits.filter((a) => a.reportIssuedAt !== null).length,
      },
    });
  });

  /**
   * First-time right by trade. "Right" is computed from the record — a
   * checklist with any failed item is not first-time right whatever its
   * headline result — and a trade with nothing judged returns null rather than
   * 100%.
   */
  app.get("/projects/:projectId/quality/first-time-right", { preHandler: readGate }, async (req) => {
    const rows = await app.db
      .select()
      .from(checklists)
      .where(
        and(eq(checklists.companyId, req.companyId!), eq(checklists.projectId, req.projectId!)),
      );
    const vendorIds = [...new Set(rows.map((r) => r.vendorId).filter((v): v is string => !!v))];
    const vendorRows = vendorIds.length
      ? await app.db
          .select({ id: vendors.id, name: vendors.name })
          .from(vendors)
          .where(and(eq(vendors.companyId, req.companyId!), inArray(vendors.id, vendorIds)))
      : [];
    const labels = new Map(vendorRows.map((v) => [v.id, v.name] as const));
    return firstTimeRightByTrade(
      rows.map((r) => ({
        id: r.id,
        result: r.result,
        failedItemCount: r.failedItemCount,
        criticalFailureCount: r.criticalFailureCount,
        vendorId: r.vendorId,
        category: r.category,
        detail: r.detail as Record<string, unknown>,
      })),
      labels,
    );
  });

  /* ---------------------------------------------------------------- */
  /* Health inputs (plan §3.5)                                         */
  /* ---------------------------------------------------------------- */

  /**
   * The quality dimension, as numbers another module can score. Every metric
   * is a count or a rate the register can defend; a metric with no denominator
   * is `null` with a reason rather than a zero that would read as perfect.
   */
  app.get("/projects/:projectId/quality/health-inputs", { preHandler: readGate }, async (req) => {
    const scope = { companyId: req.companyId!, projectId: req.projectId! };
    const today = todayISO();
    const [activities, ncrRows, checklistRows, packages, concessionRows, instrumentRows, findingRows, pourRows, weldRows] =
      await Promise.all([
        app.db.select().from(itpActivities).where(and(eq(itpActivities.companyId, scope.companyId), eq(itpActivities.projectId, scope.projectId))),
        app.db.select().from(nonConformanceReports).where(and(eq(nonConformanceReports.companyId, scope.companyId), eq(nonConformanceReports.projectId, scope.projectId))),
        app.db.select().from(checklists).where(and(eq(checklists.companyId, scope.companyId), eq(checklists.projectId, scope.projectId))),
        app.db.select().from(turnoverPackages).where(and(eq(turnoverPackages.companyId, scope.companyId), eq(turnoverPackages.projectId, scope.projectId))),
        app.db.select().from(qualityConcessions).where(and(eq(qualityConcessions.companyId, scope.companyId), eq(qualityConcessions.projectId, scope.projectId))),
        app.db.select().from(calibratedInstruments).where(and(eq(calibratedInstruments.companyId, scope.companyId), eq(calibratedInstruments.projectId, scope.projectId))),
        app.db.select().from(qualityAuditFindings).where(and(eq(qualityAuditFindings.companyId, scope.companyId), eq(qualityAuditFindings.projectId, scope.projectId))),
        app.db.select().from(concretePours).where(and(eq(concretePours.companyId, scope.companyId), eq(concretePours.projectId, scope.projectId))),
        app.db.select().from(welds).where(and(eq(welds.companyId, scope.companyId), eq(welds.projectId, scope.projectId))),
      ]);

    const openNcrs = ncrRows.filter((n) => OPEN_NCR_STATUSES.includes(n.status));
    const overdueNcrs = openNcrs.filter((n) => n.responseDueDate !== null && n.responseDueDate < today);
    const judged = checklistRows.filter((c) => c.result !== null);
    const firstTimeRight = judged.filter((c) => c.failedItemCount === 0 && c.result !== "fail");
    const overdueHoldPoints = activities.filter((a) => isUnreleasedPastPlannedDate(a, today));
    const reasons: string[] = [];
    if (judged.length === 0) {
      reasons.push(
        "No checklist has been completed with a result, so the first-time-right rate is unmeasured rather than perfect.",
      );
    }
    if (ncrRows.length === 0) {
      reasons.push(
        "No non-conformance has been raised on this project. On a live project that usually means the register is not being used rather than that nothing has gone wrong.",
      );
    }
    return {
      metrics: {
        openNcrs: openNcrs.length,
        overdueNcrs: overdueNcrs.length,
        criticalOpenNcrs: openNcrs.filter((n) => n.severity === "critical").length,
        overdueHoldPoints: overdueHoldPoints.length,
        openHoldPoints: activities.filter(
          (a) => a.interventionPoint === "hold_point" && !isTerminalActivityStatus(a.status),
        ).length,
        firstTimeRightPercent:
          judged.length === 0 ? null : round2((firstTimeRight.length / judged.length) * 100),
        turnoverArtefactGap: packages.reduce(
          (n, p) => n + Math.max(0, p.requiredArtefactCount - p.presentArtefactCount),
          0,
        ),
        liveConcessions: concessionRows.filter((c) => concessionStanding(c, today).live).length,
        expiredConcessions: concessionRows.filter((c) => c.status === "expired").length,
        instrumentsOutOfCalibration: instrumentRows.filter(
          (i) => instrumentStanding(i, today).status === "overdue",
        ).length,
        openAuditFindings: findingRows.filter((f) =>
          ["open", "response_received", "action_agreed", "action_complete"].includes(f.status),
        ).length,
        majorNonConformities: findingRows.filter((f) => f.findingType === "major_nonconformity").length,
        failedConcretePours: pourRows.filter((p) => p.acceptanceVerdict === "rejected").length,
        weldsAwaitingRequiredNdt: weldRows.filter(
          (w) => w.ndtRequiredPercent !== null && w.ndtRequiredPercent > 0 && w.ndtRecordCount === 0,
        ).length,
        rejectedWelds: weldRows.filter((w) => w.status === "rejected").length,
      },
      reasons,
    };
  });
};
