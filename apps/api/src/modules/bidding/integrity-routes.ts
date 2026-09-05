import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { bidPackages, signals } from "@constructos/db";
import { badRequest, notFound } from "../../lib/errors.js";
import { appendLedger } from "../../lib/ledger.js";
import { fetchPackage, reasonSchema } from "./shared.js";
import { sealState } from "./sealing.js";
import {
  DEFAULT_INTEGRITY_THRESHOLDS,
  resolveThresholds,
  type IntegrityFinding,
} from "./integrity.js";
import {
  CROSS_PACKAGE_WINDOW_MONTHS,
  integritySignalsForPackage,
  loadPackageIntegrityInput,
  runCompanyIntegrityAndPersist,
  runPackageIntegrityAndPersist,
} from "./integrity-service.js";

/**
 * BID-INTEGRITY ENDPOINTS.
 *
 * Two surfaces, because the two kinds of pattern live at different scales:
 *
 *   /projects/:id/bid-packages/:id/integrity   what the shape of THESE bids
 *                                              says — clustering, shared
 *                                              rates, proportional bills,
 *                                              submission timing, abnormally
 *                                              low or high prices, unbalanced
 *                                              rates.
 *
 *   /companies/current/bid-integrity           what the shape of the LAST TWO
 *                                              YEARS says — cover bidding,
 *                                              winner rotation, a bidder list
 *                                              that never changes, bidders
 *                                              who always withdraw.
 *
 * Both are readable by anyone with `bidding:read` (or company membership for
 * the company view), because a control only a specialist can see is a control
 * nobody applies. Running the detectors — which writes signals — needs
 * `standard`.
 *
 * The findings do not block. They are put in front of the recommender at the
 * moment of recommendation, where a high or critical finding must be
 * acknowledged in writing before a bidder can be recommended.
 */
export const integrityRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("bidding", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("bidding", "standard"),
  ];
  const companyGate = [app.authenticate, app.requireCompany];

  const openSignals = (rows: Array<typeof signals.$inferSelect>) =>
    rows.filter(
      (r) => r.disposition !== "dismissed" && r.disposition !== "closed" && r.closedAt === null,
    );

  const shapeSignal = (row: typeof signals.$inferSelect) => ({
    id: row.id,
    detector: row.detector,
    severity: row.severity,
    confidence: row.confidence,
    title: row.title,
    explanation: row.explanation,
    disposition: row.disposition,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    evidenceRefs: row.evidenceRefs,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
  });

  /* ---------------------------------------------------------------- */
  /* Package-level                                                     */
  /* ---------------------------------------------------------------- */

  app.get(
    "/projects/:projectId/bid-packages/:packageId/integrity",
    { preHandler: readGate },
    async (req) => {
      const { packageId } = req.params as { packageId: string };
      const pkg = await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      const seal = sealState(pkg);
      if (seal.amountsWithheld) {
        return {
          seal,
          sealed: true,
          findings: [],
          signals: [],
          dispersion: null,
          abnormal: { median: null, assessments: [] },
          unbalanced: [],
          notRun: [
            {
              detector: "all",
              reason:
                "Every detector here reads submitted amounts, and this package is sealed. " +
                seal.note,
            },
          ],
          thresholds: resolveThresholds(
            (pkg.detail as Record<string, unknown>)["integrityThresholds"],
          ),
          note:
            "Integrity analysis is withheld while the seal is on. The detectors compare prices, " +
            "and comparing prices before the opening is precisely what the seal prevents.",
        };
      }
      // Read-only: the read path never writes signals. Running them is a
      // deliberate act with a `standard` gate on it.
      const report = await runPackageIntegrityAndPersist(app.db, pkg, req.user!.id, {
        persist: false,
      });
      const existing = await integritySignalsForPackage(app.db, req.companyId!, packageId);
      const input = await loadPackageIntegrityInput(app.db, pkg);
      return {
        seal,
        sealed: false,
        packageReference: pkg.reference,
        comparisonBasis: report.comparisonBasis,
        contenders: input.contenders.map((c) => ({
          submissionId: c.submissionId,
          reference: c.reference,
          vendorId: c.vendorId,
          vendorName: c.vendorName,
          amount: c.amount,
          currency: c.currency,
          receivedAt: c.receivedAt,
          isLate: c.isLate,
        })),
        findings: report.findings,
        signals: existing.map(shapeSignal),
        openSignals: openSignals(existing).length,
        dispersion: report.dispersion,
        abnormal: report.abnormal,
        unbalanced: report.unbalanced,
        notRun: report.notRun,
        thresholds: resolveThresholds(
          (pkg.detail as Record<string, unknown>)["integrityThresholds"],
        ),
        defaultThresholds: DEFAULT_INTEGRITY_THRESHOLDS,
        note: report.note,
      };
    },
  );

  /** Run the detectors and record what they found. */
  app.post(
    "/projects/:projectId/bid-packages/:packageId/integrity/run",
    { preHandler: standardGate },
    async (req) => {
      const { packageId } = req.params as { packageId: string };
      const pkg = await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      const seal = sealState(pkg);
      if (seal.amountsWithheld) {
        throw badRequest(
          `Running the integrity detectors reads submitted amounts. ${seal.note}`,
        );
      }
      const report = await runPackageIntegrityAndPersist(app.db, pkg, req.user!.id);
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "bid_package",
        objectId: packageId,
        payload: {
          event: "bid_integrity_run",
          reference: pkg.reference,
          findings: report.findings.length,
          raised: report.raised.length,
          alreadyOpen: report.alreadyOpen.length,
          detectors: report.findings.map((f) => f.detector),
        },
        storePayload: true,
      });
      return {
        ...report,
        note:
          report.raised.length === 0 && report.findings.length > 0
            ? `${report.findings.length} finding(s), all of them already on the register. ` +
              "Re-running a detector over unchanged data must not manufacture a second signal — " +
              "false-positive fatigue is what stops anybody reading the register at all."
            : report.note,
      };
    },
  );

  /**
   * Set or clear per-package thresholds. A two-bidder plant hire enquiry and
   * a public works tender do not share a dispersion expectation, and a
   * threshold nobody can move is a threshold people learn to ignore. The
   * change is ledgered with the old and new values.
   */
  app.put(
    "/projects/:projectId/bid-packages/:packageId/integrity/thresholds",
    { preHandler: standardGate },
    async (req) => {
      const { packageId } = req.params as { packageId: string };
      const body = z
        .object({
          thresholds: z.record(z.string(), z.number().finite().min(0)).nullable(),
          reason: reasonSchema,
        })
        .parse(req.body);
      const pkg = await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      const previous = resolveThresholds(
        (pkg.detail as Record<string, unknown>)["integrityThresholds"],
      );
      const detail = { ...(pkg.detail as Record<string, unknown>) };
      if (body.thresholds === null) delete detail["integrityThresholds"];
      else detail["integrityThresholds"] = body.thresholds;
      await app.db
        .update(bidPackages)
        .set({ detail, updatedAt: new Date().toISOString() })
        .where(eq(bidPackages.id, packageId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "bid_package",
        objectId: packageId,
        payload: {
          event: "bid_integrity_thresholds_changed",
          reason: body.reason,
          previous,
          next: resolveThresholds(body.thresholds),
        },
        storePayload: true,
      });
      return {
        thresholds: resolveThresholds(body.thresholds),
        defaults: DEFAULT_INTEGRITY_THRESHOLDS,
        previous,
        note:
          "Thresholds moved. The change is on the ledger with its reason, because a detector " +
          "quietly relaxed the week before an award is itself a finding.",
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Company-level                                                     */
  /* ---------------------------------------------------------------- */

  app.get("/companies/current/bid-integrity", { preHandler: companyGate }, async (req) => {
    const q = z
      .object({
        detector: z.string().max(80).optional(),
        severity: z.enum(["critical", "high", "medium", "low", "info"]).optional(),
        openOnly: z
          .union([z.boolean(), z.string()])
          .optional()
          .transform((v) => v !== false && v !== "false"),
      })
      .parse(req.query ?? {});

    const rows = await app.db
      .select()
      .from(signals)
      .where(eq(signals.companyId, req.companyId!))
      .orderBy(desc(signals.createdAt))
      .limit(1000);
    const mine = rows.filter(
      (r) =>
        r.detector.startsWith("bid_integrity_") &&
        (!q.detector || r.detector === q.detector) &&
        (!q.severity || r.severity === q.severity) &&
        (!q.openOnly || (r.disposition !== "dismissed" && r.disposition !== "closed")),
    );

    const packageIds = [
      ...new Set(
        mine
          .filter((r) => r.subjectType === "bid_package" && r.subjectId)
          .map((r) => r.subjectId as string),
      ),
    ];
    const packageRows = packageIds.length
      ? await app.db
          .select({
            id: bidPackages.id,
            reference: bidPackages.reference,
            title: bidPackages.title,
            projectId: bidPackages.projectId,
          })
          .from(bidPackages)
          .where(
            and(eq(bidPackages.companyId, req.companyId!), inArray(bidPackages.id, packageIds)),
          )
      : [];
    const packagesById = new Map(packageRows.map((p) => [p.id, p] as const));

    const byDetector = new Map<string, number>();
    for (const row of mine) byDetector.set(row.detector, (byDetector.get(row.detector) ?? 0) + 1);
    const bySeverity = new Map<string, number>();
    for (const row of mine) bySeverity.set(row.severity, (bySeverity.get(row.severity) ?? 0) + 1);

    return {
      items: mine.map((row) => ({
        ...shapeSignal(row),
        package:
          row.subjectType === "bid_package" ? (packagesById.get(row.subjectId ?? "") ?? null) : null,
      })),
      total: mine.length,
      byDetector: [...byDetector.entries()]
        .map(([detector, count]) => ({ detector, count }))
        .sort((a, b) => b.count - a.count),
      bySeverity: [...bySeverity.entries()].map(([severity, count]) => ({ severity, count })),
      windowMonths: CROSS_PACKAGE_WINDOW_MONTHS,
      note:
        mine.length === 0
          ? "No bid-integrity finding is open. That is a statement about what the detectors can " +
            "see: cross-package patterns need several tenders in the same trade before they say " +
            "anything, and the within-package ones need a field of at least three bids."
          : "Every finding carries the statistic it was computed from. The ordinary outcome of " +
            "reviewing one is an innocent explanation recorded next to it — dismissing a finding " +
            "with a reason is how the detector's measured precision improves.",
    };
  });

  /** Run the cross-package detectors over the company's own history. */
  app.post(
    "/companies/current/bid-integrity/run",
    {
      preHandler: [
        app.authenticate,
        app.requireCompany,
        app.requireCompanyRole(["owner", "admin"]),
      ],
    },
    async (req) => {
      const report = await runCompanyIntegrityAndPersist(app.db, req.companyId!, req.user!.id);
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "company",
        objectId: req.companyId!,
        payload: {
          event: "bid_integrity_company_run",
          packagesExamined: report.packagesExamined,
          findings: report.findings.length,
          raised: report.raised.length,
        },
        storePayload: true,
      });
      return report;
    },
  );

  /**
   * Dismissing a finding WITH A REASON. This is the feedback loop that makes
   * a detector's precision measurable: a detector whose findings are all
   * dismissed is a detector that should be re-tuned or retired, and that is
   * only visible if the dismissal is recorded rather than the row deleted.
   */
  app.post(
    "/companies/current/bid-integrity/:signalId/dismiss",
    { preHandler: companyGate },
    async (req) => {
      const { signalId } = req.params as { signalId: string };
      const { reason } = z.object({ reason: reasonSchema }).parse(req.body);
      const [row] = await app.db
        .select()
        .from(signals)
        .where(and(eq(signals.id, signalId), eq(signals.companyId, req.companyId!)))
        .limit(1);
      if (!row) throw notFound("Signal not found");
      if (!row.detector.startsWith("bid_integrity_")) {
        throw badRequest(
          "That signal was not raised by the bidding detectors, so it is not this module's to " +
            "close. Use the assurance register.",
        );
      }
      const now = new Date().toISOString();
      await app.db
        .update(signals)
        .set({
          disposition: "dismissed",
          reviewerId: req.user!.id,
          reviewerNotes: reason,
          closedAt: now,
        })
        .where(eq(signals.id, signalId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: row.projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "signal",
        objectId: signalId,
        payload: {
          detector: row.detector,
          to: "dismissed",
          reason,
          subjectType: row.subjectType,
          subjectId: row.subjectId,
        },
        storePayload: true,
      });
      return {
        id: signalId,
        disposition: "dismissed",
        reviewerNotes: reason,
        note:
          "Recorded. A dismissal with a stated reason is what makes this detector's precision " +
          "measurable — a detector whose findings are always dismissed should be re-tuned or " +
          "retired, and that only becomes visible if the dismissals are counted.",
      };
    },
  );
};

export type { IntegrityFinding };
