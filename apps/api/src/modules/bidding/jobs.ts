import type { FastifyInstance } from "fastify";
import { and, eq, inArray, isNotNull, lte } from "drizzle-orm";
import {
  bidInvitations,
  bidOpportunities,
  bidPackages,
  bidSubmissions,
} from "@constructos/db";
import { forEachCompany } from "../../lib/scheduler.js";
import { appendLedger } from "../../lib/ledger.js";
import type { Db } from "../../lib/db.js";
import { pushNotifications } from "../notifications/service.js";
import { isInContention, todayIso } from "./shared.js";
import { sweepPrequalification } from "./prequal-status.js";
import { sweepBidBonds } from "./engagement.js";
import { runCompanyIntegrityAndPersist, runPackageIntegrityAndPersist } from "./integrity-service.js";

/**
 * TIME-DRIVEN BIDDING BEHAVIOUR.
 *
 * Everything here used to happen only when somebody happened to open the
 * right page. A platform whose product is "the deadline was missed and here
 * is the record" cannot depend on a browser tab to notice the deadline, so
 * each sweep is a scheduler job — idempotent, bounded by an index, and
 * runnable on demand (`app.scheduler.runNow(...)`) in tests and by admins.
 *
 * Five jobs:
 *
 *   bidding.prequalification-expiry   approvals lapsing and renewals falling
 *                                     due — the sweep that used to run on
 *                                     every list read.
 *   bidding.bid-bonds                 bid bonds expiring under a live tender.
 *   bidding.tender-deadlines          packages past their bid deadline that
 *                                     nobody has closed, bid validity running
 *                                     out before the anticipated award, and
 *                                     invitations that have gone silent.
 *   bidding.integrity                 the cross-package detectors, plus the
 *                                     within-package ones on any package
 *                                     whose bids are open and unevaluated.
 *   bidding.opportunities             pursuits whose submission date has
 *                                     passed with no decision recorded.
 */

/* ------------------------------------------------------------------ */
/* Tender deadlines and bid validity                                   */
/* ------------------------------------------------------------------ */

export interface DeadlineSweepResult {
  closedToBids: string[];
  validityWarnings: Array<{ submissionId: string; reference: string; validUntil: string }>;
  silentInvitations: number;
  notified: number;
}

/**
 * A bid is only binding while it is valid. A tender whose anticipated award
 * date falls after the bidders' validity expires is a tender that will have
 * to ask everybody to extend — which is the moment the price goes up, and it
 * is entirely predictable weeks beforehand.
 */
export async function sweepTenderDeadlines(
  db: Db,
  companyId: string,
  asOf: string = todayIso(),
): Promise<DeadlineSweepResult> {
  const result: DeadlineSweepResult = {
    closedToBids: [],
    validityWarnings: [],
    silentInvitations: 0,
    notified: 0,
  };
  const nowIso = new Date().toISOString();
  const live = await db
    .select()
    .from(bidPackages)
    .where(
      and(
        eq(bidPackages.companyId, companyId),
        inArray(bidPackages.status, ["invitations_sent", "open"]),
        isNotNull(bidPackages.bidDueAt),
        lte(bidPackages.bidDueAt, nowIso),
      ),
    );

  for (const pkg of live) {
    // The tender period is over. Moving the package to "closed" is a
    // statement of fact, not a decision, so the sweep may make it — and it
    // is conditional so a concurrent manual close does not double-ledger.
    const flipped = await db
      .update(bidPackages)
      .set({ status: "closed", updatedAt: nowIso })
      .where(
        and(
          eq(bidPackages.id, pkg.id),
          inArray(bidPackages.status, ["invitations_sent", "open"]),
        ),
      )
      .returning({ id: bidPackages.id });
    if (flipped.length === 0) continue;
    result.closedToBids.push(pkg.id);
    await appendLedger(db, {
      companyId,
      projectId: pkg.projectId,
      actorId: null,
      action: "state_change",
      objectType: "bid_package",
      objectId: pkg.id,
      payload: {
        from: pkg.status,
        to: "closed",
        reference: pkg.reference,
        bidDueAt: pkg.bidDueAt,
        derived: true,
        why: "The published bid deadline has passed.",
      },
      storePayload: true,
    });
    const silent = await db
      .select({ id: bidInvitations.id })
      .from(bidInvitations)
      .where(
        and(
          eq(bidInvitations.packageId, pkg.id),
          inArray(bidInvitations.status, ["sent", "delivered", "viewed", "downloaded", "intent_to_bid"]),
        ),
      );
    result.silentInvitations += silent.length;
  }

  /* Bid validity running out before the award */
  const evaluating = await db
    .select()
    .from(bidPackages)
    .where(
      and(
        eq(bidPackages.companyId, companyId),
        inArray(bidPackages.status, ["closed", "under_evaluation", "levelled"]),
      ),
    );
  for (const pkg of evaluating) {
    const target = pkg.anticipatedAwardDate ?? asOf;
    const subs = await db
      .select()
      .from(bidSubmissions)
      .where(and(eq(bidSubmissions.packageId, pkg.id), isNotNull(bidSubmissions.validUntil)));
    for (const sub of subs) {
      if (!sub.validUntil || !isInContention(sub.status)) continue;
      if (sub.validUntil >= target) continue;
      const detail = sub.detail as Record<string, unknown>;
      if (detail["validityWarnedAt"]) continue;
      await db
        .update(bidSubmissions)
        .set({
          detail: { ...detail, validityWarnedAt: nowIso, validityWarnedAgainst: target },
          updatedAt: nowIso,
        })
        .where(eq(bidSubmissions.id, sub.id));
      result.validityWarnings.push({
        submissionId: sub.id,
        reference: sub.reference,
        validUntil: sub.validUntil,
      });
      await appendLedger(db, {
        companyId,
        projectId: sub.projectId,
        actorId: null,
        action: "update",
        objectType: "bid_submission",
        objectId: sub.id,
        payload: {
          event: "bid_validity_expiring",
          reference: sub.reference,
          validUntil: sub.validUntil,
          measuredAgainst: target,
          packageId: pkg.id,
          packageReference: pkg.reference,
          derived: true,
          why:
            "This bid's validity expires before the anticipated award date. A bid that has " +
            "expired is not binding: awarding on it invites the bidder to re-price, and they " +
            "will.",
        },
        storePayload: true,
      });
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Opportunities whose moment passed                                   */
/* ------------------------------------------------------------------ */

export async function sweepOpportunities(
  db: Db,
  companyId: string,
): Promise<{ overdue: string[]; notified: number }> {
  const nowIso = new Date().toISOString();
  const rows = await db
    .select()
    .from(bidOpportunities)
    .where(
      and(
        eq(bidOpportunities.companyId, companyId),
        inArray(bidOpportunities.stage, ["identified", "qualifying", "bid_no_bid", "bidding"]),
        isNotNull(bidOpportunities.submissionDueAt),
        lte(bidOpportunities.submissionDueAt, nowIso),
      ),
    );
  const overdue: string[] = [];
  const targets: Parameters<typeof pushNotifications>[1] = [];
  for (const row of rows) {
    const detail = row.detail as Record<string, unknown>;
    if (detail["overdueNotifiedAt"]) continue;
    await db
      .update(bidOpportunities)
      .set({ detail: { ...detail, overdueNotifiedAt: nowIso }, updatedAt: nowIso })
      .where(eq(bidOpportunities.id, row.id));
    overdue.push(row.id);
    await appendLedger(db, {
      companyId,
      projectId: row.projectId,
      actorId: null,
      action: "update",
      objectType: "bid_opportunity",
      objectId: row.id,
      payload: {
        event: "submission_date_passed",
        reference: row.reference,
        stage: row.stage,
        bidNoBidDecision: row.bidNoBidDecision,
        submissionDueAt: row.submissionDueAt,
        derived: true,
      },
      storePayload: true,
    });
    if (row.ownerUserId) {
      targets.push({
        companyId,
        userId: row.ownerUserId,
        projectId: row.projectId,
        kind: "overdue",
        tool: "bidding",
        title: `${row.reference} passed its submission date`,
        body:
          `${row.title} was due ${row.submissionDueAt} and is still at stage "${row.stage}"` +
          (row.bidNoBidDecision === "pending"
            ? " with no bid/no-bid decision recorded."
            : ".") +
          " Record the outcome: a pursuit with no recorded outcome teaches the win model " +
          "nothing and quietly inflates the pipeline.",
        recordType: "bid_opportunity",
        recordId: row.id,
      });
    }
  }
  const pushed = targets.length > 0 ? await pushNotifications(db, targets) : { inserted: 0 };
  return { overdue, notified: pushed.inserted };
}

/* ------------------------------------------------------------------ */
/* Integrity sweep                                                     */
/* ------------------------------------------------------------------ */

export async function sweepIntegrity(
  db: Db,
  companyId: string,
): Promise<{ packages: number; findings: number; raised: number }> {
  const company = await runCompanyIntegrityAndPersist(db, companyId, null);
  let findings = company.findings.length;
  let raised = company.raised.length;

  // Within-package detectors on packages whose bids are readable and whose
  // evaluation is still open: those are the ones where a finding can still
  // change a decision.
  const candidates = await db
    .select()
    .from(bidPackages)
    .where(
      and(
        eq(bidPackages.companyId, companyId),
        inArray(bidPackages.status, ["closed", "under_evaluation", "levelled"]),
      ),
    )
    .limit(200);
  let examined = 0;
  for (const pkg of candidates) {
    if (pkg.isSealed === 1 && !pkg.openedAt) continue;
    if (pkg.submissionCount < 2) continue;
    const report = await runPackageIntegrityAndPersist(db, pkg, null);
    examined += 1;
    findings += report.findings.length;
    raised += report.raised.length;
  }
  return { packages: examined, findings, raised };
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

export function registerBiddingJobs(app: FastifyInstance): void {
  app.scheduler.register({
    name: "bidding.prequalification-expiry",
    description:
      "Expire lapsed prequalification approvals, raise renewal obligations inside the window and signal the lapses — the sweep that used to run only when somebody opened the register",
    everyMs: 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) =>
      forEachCompany(db, (companyId) =>
        sweepPrequalification(db, companyId, "system", now.toISOString().slice(0, 10)),
      ),
  });

  app.scheduler.register({
    name: "bidding.bid-bonds",
    description:
      "Expire bid bonds that have run out and raise an obligation for those about to — a tender running on an expired bond has no security behind it",
    everyMs: 6 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) =>
      forEachCompany(db, (companyId) =>
        sweepBidBonds(db, companyId, null, now.toISOString().slice(0, 10)),
      ),
  });

  app.scheduler.register({
    name: "bidding.tender-deadlines",
    description:
      "Close tenders whose published deadline has passed, and warn where a bid's validity expires before the anticipated award date",
    everyMs: 30 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) =>
      forEachCompany(db, (companyId) =>
        sweepTenderDeadlines(db, companyId, now.toISOString().slice(0, 10)),
      ),
  });

  app.scheduler.register({
    name: "bidding.integrity",
    description:
      "Run the bid-pattern integrity detectors: cover bidding, winner rotation and repeat invitation sets across the company, and price clustering, shared rates and unbalanced bids on every package still under evaluation",
    everyMs: 12 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db }) => forEachCompany(db, (companyId) => sweepIntegrity(db, companyId)),
  });

  app.scheduler.register({
    name: "bidding.opportunities",
    description:
      "Flag pursuits whose submission date has passed with no outcome recorded — an unclosed pursuit inflates the pipeline and teaches the win model nothing",
    everyMs: 6 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db }) => forEachCompany(db, (companyId) => sweepOpportunities(db, companyId)),
  });
}
