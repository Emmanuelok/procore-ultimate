/**
 * ESTIMATING SWEEPS — the time-driven half of the module.
 *
 * Two scheduler jobs, both idempotent and both bounded by company plus an
 * index-backed predicate, because an estimating library is one of the biggest
 * tables a tenant owns and a sweep that loads it is a sweep that stops
 * running.
 *
 *   estimating.quote-validity   A subcontract quote out of validity is not a
 *                               price. The sweep expires it, raises a signal
 *                               and tells the estimator BEFORE the tender goes
 *                               out, rather than after the client accepts it.
 *
 *   estimating.hygiene          Three conditions that quietly corrupt
 *                               estimates: catalogue rates that have gone
 *                               stale, approved estimates nobody converted to
 *                               a budget, and measured takeoff nobody priced.
 *
 * Every finding is fingerprinted so a re-run does not manufacture a second
 * one, and every finding is CLOSED when its condition clears — a register
 * that only ever grows is a register nobody reads.
 */
import type { FastifyInstance } from "fastify";
import { and, eq, inArray, isNotNull, isNull, lt, lte, ne, sql } from "drizzle-orm";
import {
  costCatalogueItems,
  estimateLineItems,
  estimateSubQuotes,
  estimates,
  takeoffItems,
} from "@constructos/db";
import { forEachCompany } from "../../lib/scheduler.js";
import type { Db } from "../../lib/db.js";
import { appendLedger } from "../../lib/ledger.js";
import { pushNotifications } from "../notifications/service.js";
import {
  addDays,
  daysBetween,
  raiseSignalOnce,
  reconcileSignals,
  todayIso,
} from "./shared.js";

/** How old a catalogue rate may be before it is flagged for review. */
export const RATE_STALENESS_DAYS = 365;
/** How long an approved estimate may sit unconverted before it is a finding. */
export const CONVERSION_DRIFT_DAYS = 30;
/** How long a measured takeoff may sit unpriced before it is a finding. */
export const UNPRICED_TAKEOFF_DAYS = 14;
/** How far ahead an expiring quote is warned about. */
export const QUOTE_EXPIRY_WARN_DAYS = 7;

/** Quote statuses that still represent a live price. */
const LIVE_QUOTE_STATUSES = ["received", "under_review", "levelled", "accepted"] as const;

export interface QuoteValidityResult {
  expired: number;
  expiring: number;
  signalsRaised: number;
  signalsClosed: number;
  notified: number;
  ranAt: string;
}

/**
 * Expire sub-quotes past their validity date and warn about the ones about to
 * go. Bounded by (companyId, validUntil) — the index on the table.
 */
export async function sweepQuoteValidity(
  db: Db,
  companyId: string,
  now: Date,
): Promise<QuoteValidityResult> {
  const today = now.toISOString().slice(0, 10);
  const horizon = addDays(today, QUOTE_EXPIRY_WARN_DAYS);
  const rows = await db
    .select()
    .from(estimateSubQuotes)
    .where(
      and(
        eq(estimateSubQuotes.companyId, companyId),
        isNotNull(estimateSubQuotes.validUntil),
        lte(estimateSubQuotes.validUntil, horizon),
        inArray(estimateSubQuotes.status, [...LIVE_QUOTE_STATUSES]),
      ),
    );

  let expired = 0;
  let expiring = 0;
  let signalsRaised = 0;
  let notified = 0;
  const expiredKeys = new Set<string>();
  const expiringKeys = new Set<string>();

  for (const quote of rows) {
    const validUntil = quote.validUntil;
    if (!validUntil) continue;
    const daysLeft = daysBetween(today, validUntil);
    if (daysLeft < 0) {
      expired += 1;
      expiredKeys.add(quote.id);
      await db
        .update(estimateSubQuotes)
        .set({ status: "expired", updatedAt: now.toISOString() })
        .where(eq(estimateSubQuotes.id, quote.id));
      await appendLedger(db, {
        companyId,
        actorId: null,
        action: "state_change",
        objectType: "estimate_sub_quote",
        objectId: quote.id,
        projectId: quote.projectId,
        payload: {
          reference: quote.reference,
          from: quote.status,
          to: "expired",
          validUntil,
          reason: "validity period elapsed (estimating.quote-validity sweep)",
        },
      });
      const raised = await raiseSignalOnce(db, {
        companyId,
        projectId: quote.projectId,
        detector: "sub_quote_expired",
        key: quote.id,
        severity: quote.status === "accepted" ? "high" : "medium",
        confidence: 1,
        title: `Sub-quote out of validity — ${quote.vendorName} (${quote.tradePackage})`,
        explanation:
          `${quote.reference} from ${quote.vendorName} for ${quote.tradePackage} was valid until ${validUntil}, ${Math.abs(daysLeft)} day${Math.abs(daysLeft) === 1 ? "" : "s"} ago. ` +
          `Its quoted total of ${quote.quotedTotal} ${quote.currency} is no longer a price the supplier is bound by. ` +
          (quote.status === "accepted"
            ? "It was ACCEPTED into an estimate, so any tender resting on it is carrying an unpriced risk. Re-confirm the price or re-price the package."
            : "Re-confirm the price before it is used in an estimate."),
        subjectType: "estimate_sub_quote",
        subjectId: quote.id,
        evidenceRefs: {
          quoteId: quote.id,
          reference: quote.reference,
          vendorName: quote.vendorName,
          validUntil,
          quotedTotal: quote.quotedTotal,
          currency: quote.currency,
        },
      });
      if (raised.raised) signalsRaised += 1;
      await pushNotifications(db, [
        {
          companyId,
          userId: quote.createdBy,
          projectId: quote.projectId,
          kind: "estimate",
          title: `Sub-quote ${quote.reference} has expired`,
          body: `${quote.vendorName} — ${quote.tradePackage}. Valid until ${validUntil}.`,
          recordType: "estimate_sub_quote",
          recordId: quote.id,
        },
      ]);
      notified += 1;
    } else {
      expiring += 1;
      expiringKeys.add(quote.id);
      const raised = await raiseSignalOnce(db, {
        companyId,
        projectId: quote.projectId,
        detector: "sub_quote_expiring",
        key: quote.id,
        severity: "low",
        confidence: 1,
        title: `Sub-quote validity runs out in ${daysLeft} day${daysLeft === 1 ? "" : "s"} — ${quote.vendorName}`,
        explanation:
          `${quote.reference} from ${quote.vendorName} for ${quote.tradePackage} is valid until ${validUntil}. ` +
          `Extend it, re-confirm it, or accept it before it lapses; after that the ${quote.quotedTotal} ${quote.currency} in the estimate is our number, not theirs.`,
        subjectType: "estimate_sub_quote",
        subjectId: quote.id,
        evidenceRefs: {
          quoteId: quote.id,
          reference: quote.reference,
          validUntil,
          daysLeft,
        },
      });
      if (raised.raised) {
        signalsRaised += 1;
        await pushNotifications(db, [
          {
            companyId,
            userId: quote.createdBy,
            projectId: quote.projectId,
            kind: "estimate",
            title: `Sub-quote ${quote.reference} expires on ${validUntil}`,
            body: `${quote.vendorName} — ${quote.tradePackage}.`,
            recordType: "estimate_sub_quote",
            recordId: quote.id,
          },
        ]);
        notified += 1;
      }
    }
  }

  const signalsClosed =
    (await reconcileSignals(
      db,
      companyId,
      "sub_quote_expiring",
      expiringKeys,
      "The quote was accepted, withdrawn, re-dated or has now lapsed; the warning no longer applies.",
    )) +
    (await reconcileSignals(
      db,
      companyId,
      "sub_quote_expired",
      expiredKeys,
      "The quote's validity was extended or the quote was withdrawn.",
    ));

  return {
    expired,
    expiring,
    signalsRaised,
    signalsClosed,
    notified,
    ranAt: now.toISOString(),
  };
}

export interface HygieneResult {
  catalogueFlagged: number;
  staleRateEstimates: number;
  unconvertedEstimates: number;
  unpricedTakeoffProjects: number;
  unpricedTakeoffItems: number;
  signalsRaised: number;
  signalsClosed: number;
  ranAt: string;
}

/**
 * Catalogue staleness, unconverted approved estimates, and measured takeoff
 * nobody priced. All three are "the record says one thing and the work says
 * another" conditions — cheap to detect, expensive to discover in a tender.
 */
export async function sweepEstimatingHygiene(
  db: Db,
  companyId: string,
  now: Date,
): Promise<HygieneResult> {
  const today = now.toISOString().slice(0, 10);
  const staleBefore = addDays(today, -RATE_STALENESS_DAYS);
  const conversionCutoff = new Date(now.getTime() - CONVERSION_DRIFT_DAYS * 86_400_000).toISOString();
  const takeoffCutoff = new Date(now.getTime() - UNPRICED_TAKEOFF_DAYS * 86_400_000).toISOString();

  let signalsRaised = 0;

  /* --- 1. catalogue rates that have gone stale -------------------------- */
  const staleItems = await db
    .select({ id: costCatalogueItems.id })
    .from(costCatalogueItems)
    .where(
      and(
        eq(costCatalogueItems.companyId, companyId),
        eq(costCatalogueItems.status, "active"),
        isNotNull(costCatalogueItems.rateAsAt),
        lt(costCatalogueItems.rateAsAt, staleBefore),
      ),
    );
  for (const item of staleItems) {
    await db
      .update(costCatalogueItems)
      .set({ status: "review", updatedAt: now.toISOString() })
      .where(eq(costCatalogueItems.id, item.id));
  }

  /* --- 2. live estimates resting on stale rates ------------------------- */
  const staleLineRows = await db
    .select({
      estimateId: estimateLineItems.estimateId,
      projectId: estimateLineItems.projectId,
      n: sql<number>`count(*)`,
      oldest: sql<string>`min(${estimateLineItems.rateAsAt})`,
    })
    .from(estimateLineItems)
    .innerJoin(estimates, eq(estimates.id, estimateLineItems.estimateId))
    .where(
      and(
        eq(estimateLineItems.companyId, companyId),
        isNotNull(estimateLineItems.rateAsAt),
        lt(estimateLineItems.rateAsAt, staleBefore),
        inArray(estimates.status, ["draft", "in_review", "approved"]),
      ),
    )
    .groupBy(estimateLineItems.estimateId, estimateLineItems.projectId);

  const staleKeys = new Set<string>();
  for (const row of staleLineRows) {
    staleKeys.add(row.estimateId);
    const count = Number(row.n);
    const raised = await raiseSignalOnce(db, {
      companyId,
      projectId: row.projectId,
      detector: "estimate_stale_rates",
      key: row.estimateId,
      severity: "medium",
      confidence: 0.9,
      title: `Estimate priced on rates over ${RATE_STALENESS_DAYS} days old`,
      explanation:
        `${count} line${count === 1 ? "" : "s"} on this estimate carry a catalogue rate whose currency date is before ${staleBefore} (oldest ${row.oldest}). ` +
        "A rate that old is a historical fact, not a price. Refresh the rates from the catalogue, or record why the old rate still holds.",
      subjectType: "estimate",
      subjectId: row.estimateId,
      evidenceRefs: { estimateId: row.estimateId, staleLineCount: count, oldestRateAsAt: row.oldest, staleBefore },
    });
    if (raised.raised) signalsRaised += 1;
  }

  /* --- 3. approved estimates nobody converted --------------------------- */
  const unconverted = await db
    .select({
      id: estimates.id,
      projectId: estimates.projectId,
      reference: estimates.reference,
      name: estimates.name,
      total: estimates.total,
      currency: estimates.currency,
      approvedAt: estimates.approvedAt,
      createdBy: estimates.createdBy,
    })
    .from(estimates)
    .where(
      and(
        eq(estimates.companyId, companyId),
        eq(estimates.status, "approved"),
        isNull(estimates.convertedBudgetId),
        isNotNull(estimates.approvedAt),
        lt(estimates.approvedAt, conversionCutoff),
      ),
    );
  const unconvertedKeys = new Set<string>();
  for (const est of unconverted) {
    unconvertedKeys.add(est.id);
    const raised = await raiseSignalOnce(db, {
      companyId,
      projectId: est.projectId,
      detector: "estimate_unconverted",
      key: est.id,
      severity: "low",
      confidence: 1,
      title: `Approved estimate never became a budget — ${est.reference}`,
      explanation:
        `${est.reference} "${est.name}" was approved on ${String(est.approvedAt).slice(0, 10)} at ${est.total} ${est.currency} and has not been converted to a budget in ${CONVERSION_DRIFT_DAYS} days. ` +
        "Until it is, the project is being delivered against a number nothing measures it by.",
      subjectType: "estimate",
      subjectId: est.id,
      evidenceRefs: { estimateId: est.id, reference: est.reference, total: est.total, currency: est.currency },
    });
    if (raised.raised) signalsRaised += 1;
  }

  /* --- 4. measured takeoff nobody priced -------------------------------- */
  const unpricedRows = await db
    .select({ id: takeoffItems.id, projectId: takeoffItems.projectId, name: takeoffItems.name })
    .from(takeoffItems)
    .leftJoin(estimateLineItems, eq(estimateLineItems.takeoffItemId, takeoffItems.id))
    .where(
      and(
        eq(takeoffItems.companyId, companyId),
        inArray(takeoffItems.status, ["measured", "assigned"]),
        lt(takeoffItems.createdAt, takeoffCutoff),
        ne(takeoffItems.quantity, 0),
        isNull(estimateLineItems.id),
      ),
    );
  const byProject = new Map<string, Array<{ id: string; name: string }>>();
  for (const row of unpricedRows) {
    const bucket = byProject.get(row.projectId) ?? [];
    bucket.push({ id: row.id, name: row.name });
    byProject.set(row.projectId, bucket);
  }
  const unpricedKeys = new Set<string>();
  for (const [projectId, items] of byProject) {
    unpricedKeys.add(projectId);
    const raised = await raiseSignalOnce(db, {
      companyId,
      projectId,
      detector: "takeoff_unpriced",
      key: projectId,
      severity: "low",
      confidence: 1,
      title: `${items.length} measured takeoff item${items.length === 1 ? "" : "s"} never priced`,
      explanation:
        `${items.length} takeoff item${items.length === 1 ? " was" : "s were"} measured more than ${UNPRICED_TAKEOFF_DAYS} days ago and ${items.length === 1 ? "has" : "have"} not been priced onto any estimate line. ` +
        "Either the quantity belongs in an estimate and the estimate is short, or the measurement was abandoned and should be voided. Both are cheap to fix now.",
      subjectType: "project",
      subjectId: projectId,
      evidenceRefs: {
        takeoffItemIds: items.slice(0, 20).map((i) => i.id),
        takeoffItemNames: items.slice(0, 20).map((i) => i.name),
        total: items.length,
      },
    });
    if (raised.raised) signalsRaised += 1;
  }

  const signalsClosed =
    (await reconcileSignals(
      db,
      companyId,
      "estimate_stale_rates",
      staleKeys,
      "The estimate's rates were refreshed, or it is no longer live.",
    )) +
    (await reconcileSignals(
      db,
      companyId,
      "estimate_unconverted",
      unconvertedKeys,
      "The estimate was converted to a budget, superseded or withdrawn.",
    )) +
    (await reconcileSignals(
      db,
      companyId,
      "takeoff_unpriced",
      unpricedKeys,
      "Every measured takeoff on this project is now priced or voided.",
    ));

  return {
    catalogueFlagged: staleItems.length,
    staleRateEstimates: staleLineRows.length,
    unconvertedEstimates: unconverted.length,
    unpricedTakeoffProjects: byProject.size,
    unpricedTakeoffItems: unpricedRows.length,
    signalsRaised,
    signalsClosed,
    ranAt: now.toISOString(),
  };
}

/** Run both sweeps for one project's company and return the combined result. */
export async function runEstimatingSweeps(
  db: Db,
  companyId: string,
  now: Date,
): Promise<{ quotes: QuoteValidityResult; hygiene: HygieneResult }> {
  const quotes = await sweepQuoteValidity(db, companyId, now);
  const hygiene = await sweepEstimatingHygiene(db, companyId, now);
  return { quotes, hygiene };
}

export function registerEstimatingJobs(app: FastifyInstance): void {
  app.scheduler.register({
    name: "estimating.quote-validity",
    description:
      "Expire subcontract quotes past their validity date, warn a week ahead, and tell the estimator who is relying on them",
    everyMs: 6 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) =>
      forEachCompany(db, (companyId) => sweepQuoteValidity(db, companyId, now)),
  });
  app.scheduler.register({
    name: "estimating.hygiene",
    description:
      "Flag catalogue rates over a year old, estimates resting on them, approved estimates never converted to a budget, and measured takeoff nobody priced",
    everyMs: 12 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) =>
      forEachCompany(db, (companyId) => sweepEstimatingHygiene(db, companyId, now)),
  });
}

/** Exposed for the route that lets an operator run the sweeps on demand. */
export const SWEEP_JOB_NAMES = ["estimating.quote-validity", "estimating.hygiene"] as const;

export { todayIso };
