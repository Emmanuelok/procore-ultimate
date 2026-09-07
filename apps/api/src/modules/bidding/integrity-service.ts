import { and, desc, eq, gte, inArray } from "drizzle-orm";
import {
  bidAwards,
  bidInvitations,
  bidLevellingEntries,
  bidPackages,
  bidSubmissionLines,
  bidSubmissions,
  signals,
  vendors,
} from "@constructos/db";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import type { Db } from "../../lib/db.js";
import { isInContention, nowIso, type BidPackageRow } from "./shared.js";
import {
  runCompanyIntegrity,
  runPackageIntegrity,
  resolveThresholds,
  type ContenderFacts,
  type IntegrityFinding,
  type PackageFacts,
  type PackageHistoryFacts,
  type PackageIntegrityResult,
  type RateFacts,
} from "./integrity.js";

/**
 * PERSISTENCE FOR THE BID-INTEGRITY DETECTORS.
 *
 * The detectors themselves are pure (integrity.ts). This file does the two
 * things they must not: it loads the facts out of the database, and it turns
 * a finding into a row on the `signals` register — ONCE. A detector that
 * raises the same finding on every read produces false-positive fatigue and
 * corrupts every precision figure anyone derives from the register, so every
 * signal carries a deterministic fingerprint and a re-run over unchanged data
 * raises nothing.
 *
 * The findings do NOT block anything by themselves. What they do is appear on
 * the Award tab, where the recommendation has to acknowledge them in writing
 * before it can be made — the same discipline as the not-lowest
 * justification. A control that silently refuses is a control people route
 * around; a control that makes somebody write a sentence is one that leaves
 * a record.
 */

export const INTEGRITY_ACKNOWLEDGEMENT_KEY = "integrityAcknowledgement";

const fingerprintFor = (key: string): string => `bidding:${key}`;

/* ------------------------------------------------------------------ */
/* Loading the facts                                                   */
/* ------------------------------------------------------------------ */

export interface PackageIntegrityInput {
  facts: PackageFacts;
  contenders: ContenderFacts[];
  lines: RateFacts[];
  justified: Set<string>;
}

/**
 * Everything one package's detectors need, in three queries.
 *
 * The comparable amount is the LEVELLED figure where every contender has been
 * levelled and the as-bid total otherwise, exactly as the award comparison
 * does it — a dispersion statistic computed on as-bid totals where a
 * levelling exists would be measuring the scope differences the levelling
 * already removed.
 */
export async function loadPackageIntegrityInput(
  db: Db,
  pkg: BidPackageRow,
): Promise<PackageIntegrityInput> {
  const subs = await db
    .select()
    .from(bidSubmissions)
    .where(eq(bidSubmissions.packageId, pkg.id));
  const contenderRows = subs.filter(
    (s) => isInContention(s.status) && !(s.isLate === 1 && !s.lateAcceptedBy),
  );
  const vendorIds = [...new Set(contenderRows.map((s) => s.vendorId))];
  const vendorRows = vendorIds.length
    ? await db
        .select({ id: vendors.id, name: vendors.name })
        .from(vendors)
        .where(inArray(vendors.id, vendorIds))
    : [];
  const names = new Map(vendorRows.map((v) => [v.id, v.name] as const));

  const allLevelled =
    contenderRows.length > 0 &&
    contenderRows.every((s) => s.levellingCompletedAt !== null && s.normalisedAmount !== null);
  const comparisonBasis: "levelled" | "as_bid" = allLevelled ? "levelled" : "as_bid";

  const contenders: ContenderFacts[] = contenderRows.map((s) => ({
    submissionId: s.id,
    reference: s.reference,
    vendorId: s.vendorId,
    vendorName: names.get(s.vendorId) ?? null,
    amount: comparisonBasis === "levelled" ? s.normalisedAmount : s.totalAmount,
    currency: s.currency,
    receivedAt: s.receivedAt ?? s.submittedAt ?? null,
    isLate: s.isLate === 1,
    lateAccepted: Boolean(s.lateAcceptedBy),
    status: s.status,
  }));

  const lineRows = contenderRows.length
    ? await db
        .select()
        .from(bidSubmissionLines)
        .where(
          inArray(
            bidSubmissionLines.submissionId,
            contenderRows.map((s) => s.id),
          ),
        )
    : [];
  /*
   * Two lines are "the same scope" when they map to the same levelling item.
   * Where the package has no levelling, the item code is the next best thing
   * and a bare description is the last resort — normalised, because
   * "Excavate to reduce level" and "excavate to reduce  level" are the same
   * row to everyone except a string comparison.
   */
  const lines: RateFacts[] = lineRows.map((l) => ({
    submissionId: l.submissionId,
    vendorId: l.vendorId,
    lineId: l.id,
    key:
      l.levellingItemId ??
      (l.itemCode ? `code:${l.itemCode.trim().toLowerCase()}` : `desc:${l.description.trim().toLowerCase().replace(/\s+/g, " ")}`),
    position: l.position,
    description: l.description,
    unitRate: l.unitRate,
    amount: l.amount,
    quantity: l.quantity,
  }));

  const justified = new Set(
    contenderRows
      .filter((s) => {
        const detail = s.detail as Record<string, unknown>;
        return (
          typeof detail["abnormalLowJustification"] === "string" &&
          (detail["abnormalLowJustification"] as string).trim().length >= 20
        );
      })
      .map((s) => s.id),
  );

  return {
    facts: {
      packageId: pkg.id,
      reference: pkg.reference,
      title: pkg.title,
      currency: pkg.currency,
      engineersEstimate: pkg.engineersEstimate,
      tradeCode: pkg.tradeCode,
      comparisonBasis,
    },
    contenders,
    lines,
    justified,
  };
}

/* ------------------------------------------------------------------ */
/* Raising the signals                                                 */
/* ------------------------------------------------------------------ */

export interface IntegrityPersistResult {
  raised: string[];
  alreadyOpen: string[];
}

/**
 * Turn findings into signals, once each. Returns which were new so a caller
 * can report honestly rather than claiming to have found something it found
 * last week.
 */
export async function persistIntegrityFindings(
  db: Db,
  companyId: string,
  projectId: string | null,
  actorId: string | null,
  findings: readonly IntegrityFinding[],
): Promise<IntegrityPersistResult> {
  const result: IntegrityPersistResult = { raised: [], alreadyOpen: [] };
  if (findings.length === 0) return result;

  const fingerprints = findings.map((f) => fingerprintFor(f.key));
  const existing = await db
    .select({ id: signals.id, fingerprint: signals.fingerprint })
    .from(signals)
    .where(and(eq(signals.companyId, companyId), inArray(signals.fingerprint, fingerprints)));
  const seen = new Map(existing.map((row) => [row.fingerprint ?? "", row.id] as const));

  for (const finding of findings) {
    const fingerprint = fingerprintFor(finding.key);
    const already = seen.get(fingerprint);
    if (already) {
      result.alreadyOpen.push(already);
      await db
        .update(signals)
        .set({ lastSeenAt: nowIso() })
        .where(eq(signals.id, already));
      continue;
    }
    const id = newId("sig");
    await db.insert(signals).values({
      id,
      companyId,
      projectId,
      detector: finding.detector,
      severity: finding.severity,
      confidence: finding.confidence,
      title: finding.title,
      explanation: finding.explanation,
      evidenceRefs: {
        key: finding.key,
        statistic: finding.statistic,
        ...finding.evidence,
      },
      fingerprint,
      subjectType: finding.subjectType,
      subjectId: finding.subjectId,
      firstSeenAt: nowIso(),
      lastSeenAt: nowIso(),
    });
    seen.set(fingerprint, id);
    result.raised.push(id);
    await appendLedger(db, {
      companyId,
      projectId,
      actorId,
      action: "create",
      objectType: "signal",
      objectId: id,
      payload: {
        detector: finding.detector,
        severity: finding.severity,
        key: finding.key,
        subjectType: finding.subjectType,
        subjectId: finding.subjectId,
        statistic: finding.statistic,
        source: "bid_integrity",
      },
    });
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Package-level run                                                   */
/* ------------------------------------------------------------------ */

export interface PackageIntegrityReport extends PackageIntegrityResult {
  packageId: string;
  packageReference: string;
  comparisonBasis: "levelled" | "as_bid";
  contenders: number;
  /** signals raised by this run (new findings only) */
  raised: string[];
  alreadyOpen: string[];
  /** the finding keys a recommendation has to acknowledge */
  outstandingKeys: string[];
  note: string;
}

/**
 * Run every within-package detector and record what it found. Called on
 * levelling completion, on recommendation, from the scheduled sweep and on
 * demand from the Integrity tab.
 */
export async function runPackageIntegrityAndPersist(
  db: Db,
  pkg: BidPackageRow,
  actorId: string | null,
  options: { persist?: boolean } = {},
): Promise<PackageIntegrityReport> {
  const input = await loadPackageIntegrityInput(db, pkg);
  const thresholds = resolveThresholds(
    (pkg.detail as Record<string, unknown>)["integrityThresholds"],
  );
  const result = runPackageIntegrity(
    input.facts,
    input.contenders,
    input.lines,
    input.justified,
    thresholds,
  );
  const persisted =
    options.persist === false
      ? { raised: [], alreadyOpen: [] }
      : await persistIntegrityFindings(
          db,
          pkg.companyId,
          pkg.projectId,
          actorId,
          result.findings,
        );
  return {
    ...result,
    packageId: pkg.id,
    packageReference: pkg.reference,
    comparisonBasis: input.facts.comparisonBasis,
    contenders: input.contenders.length,
    raised: persisted.raised,
    alreadyOpen: persisted.alreadyOpen,
    outstandingKeys: result.findings
      .filter((f) => f.severity === "critical" || f.severity === "high")
      .map((f) => f.key),
    note:
      result.findings.length === 0
        ? input.contenders.length < 3
          ? `Only ${input.contenders.length} bid(s) are in contention on ${pkg.reference}. Most ` +
            "of the pattern detectors need a field of three or more to say anything at all, so " +
            "'no findings' here means 'not enough bids to look', not 'nothing to find'."
          : `No integrity finding on ${pkg.reference}: the ${input.contenders.length} bids in ` +
            "contention are dispersed like independently priced bids, no two of them share " +
            "rates, and nothing arrived at a suspicious moment."
        : `${result.findings.length} integrity finding(s) on ${pkg.reference}. A finding is a ` +
          "question, not an accusation: each one carries the statistic it was computed from so " +
          "it can be checked, and the ordinary outcome is an innocent explanation that goes on " +
          "the record next to it.",
  };
}

/* ------------------------------------------------------------------ */
/* Company-level run                                                   */
/* ------------------------------------------------------------------ */

/**
 * The trailing window for cross-package detectors. Two years: long enough
 * for a rotation to show, short enough that a supply chain the company left
 * behind in 2019 is not still generating findings.
 */
export const CROSS_PACKAGE_WINDOW_MONTHS = 24;

export async function loadCompanyHistory(
  db: Db,
  companyId: string,
  sinceIso: string,
): Promise<{ history: PackageHistoryFacts[]; vendorNames: Map<string, string> }> {
  const packages = await db
    .select()
    .from(bidPackages)
    .where(and(eq(bidPackages.companyId, companyId), gte(bidPackages.createdAt, sinceIso)))
    .orderBy(desc(bidPackages.createdAt))
    .limit(500);
  if (packages.length === 0) return { history: [], vendorNames: new Map() };
  const packageIds = packages.map((p) => p.id);

  const subs = await db
    .select({
      id: bidSubmissions.id,
      packageId: bidSubmissions.packageId,
      vendorId: bidSubmissions.vendorId,
      status: bidSubmissions.status,
      isLate: bidSubmissions.isLate,
      lateAcceptedBy: bidSubmissions.lateAcceptedBy,
    })
    .from(bidSubmissions)
    .where(inArray(bidSubmissions.packageId, packageIds));
  const invites = await db
    .select({
      packageId: bidInvitations.packageId,
      vendorId: bidInvitations.vendorId,
      status: bidInvitations.status,
      intentToBid: bidInvitations.intentToBid,
    })
    .from(bidInvitations)
    .where(inArray(bidInvitations.packageId, packageIds));

  const history: PackageHistoryFacts[] = packages.map((pkg) => {
    const mySubs = subs.filter((s) => s.packageId === pkg.id);
    const myInvites = invites.filter((i) => i.packageId === pkg.id);
    const winnerSub = pkg.awardedSubmissionId
      ? mySubs.find((s) => s.id === pkg.awardedSubmissionId)
      : undefined;
    return {
      packageId: pkg.id,
      reference: pkg.reference,
      tradeCode: pkg.tradeCode,
      awardedAt: pkg.awardedAt,
      winnerVendorId: pkg.awardedVendorId,
      bidderVendorIds: [
        ...new Set(mySubs.filter((s) => s.status !== "draft").map((s) => s.vendorId)),
      ],
      invitedVendorIds: [...new Set(myInvites.map((i) => i.vendorId))],
      withdrawnVendorIds: [
        ...new Set(
          myInvites
            .filter((i) => i.intentToBid === 1 && (i.status === "declined" || i.status === "withdrawn"))
            .map((i) => i.vendorId),
        ),
      ],
      winnerWasLate: Boolean(winnerSub && winnerSub.isLate === 1),
      winnerSubmissionId: pkg.awardedSubmissionId,
    };
  });

  const vendorIds = [
    ...new Set(history.flatMap((h) => [...h.bidderVendorIds, ...h.invitedVendorIds])),
  ];
  const vendorRows = vendorIds.length
    ? await db
        .select({ id: vendors.id, name: vendors.name })
        .from(vendors)
        .where(and(eq(vendors.companyId, companyId), inArray(vendors.id, vendorIds)))
    : [];
  return {
    history,
    vendorNames: new Map(vendorRows.map((v) => [v.id, v.name] as const)),
  };
}

export interface CompanyIntegrityReport {
  windowMonths: number;
  packagesExamined: number;
  findings: IntegrityFinding[];
  raised: string[];
  alreadyOpen: string[];
  note: string;
}

export async function runCompanyIntegrityAndPersist(
  db: Db,
  companyId: string,
  actorId: string | null,
  options: { persist?: boolean; now?: Date } = {},
): Promise<CompanyIntegrityReport> {
  const now = options.now ?? new Date();
  const since = new Date(now);
  since.setUTCMonth(since.getUTCMonth() - CROSS_PACKAGE_WINDOW_MONTHS);
  const { history, vendorNames } = await loadCompanyHistory(db, companyId, since.toISOString());
  const findings = runCompanyIntegrity(history, vendorNames);
  const persisted =
    options.persist === false
      ? { raised: [], alreadyOpen: [] }
      : await persistIntegrityFindings(db, companyId, null, actorId, findings);
  return {
    windowMonths: CROSS_PACKAGE_WINDOW_MONTHS,
    packagesExamined: history.length,
    findings,
    raised: persisted.raised,
    alreadyOpen: persisted.alreadyOpen,
    note:
      history.length < 4
        ? `Only ${history.length} package(s) fall inside the ${CROSS_PACKAGE_WINDOW_MONTHS}-month ` +
          "window. Cross-package patterns — cover bidding, winner rotation, a closed bidder " +
          "list — are invisible below about four tenders in a trade, so this is a statement " +
          "about the sample and not about the supply chain."
        : `${history.length} package(s) examined across the trailing ` +
          `${CROSS_PACKAGE_WINDOW_MONTHS} months. ${findings.length} cross-package finding(s).`,
  };
}

/* ------------------------------------------------------------------ */
/* Award-behaviour detectors                                           */
/* ------------------------------------------------------------------ */

export async function loadOpenIntegritySignals(
  db: Db,
  companyId: string,
  packageId: string,
): Promise<Array<typeof signals.$inferSelect>> {
  const rows = await db
    .select()
    .from(signals)
    .where(and(eq(signals.companyId, companyId), eq(signals.subjectType, "bid_package")))
    .orderBy(desc(signals.createdAt))
    .limit(500);
  return rows.filter((r) => r.subjectId === packageId);
}

/**
 * Every open integrity signal that bears on one package — whether it was
 * raised against the package, one of its bids, or the award itself. This is
 * what the Award tab shows and what the recommendation must acknowledge.
 */
export async function integritySignalsForPackage(
  db: Db,
  companyId: string,
  packageId: string,
): Promise<Array<typeof signals.$inferSelect>> {
  const subs = await db
    .select({ id: bidSubmissions.id })
    .from(bidSubmissions)
    .where(eq(bidSubmissions.packageId, packageId));
  const awards = await db
    .select({ id: bidAwards.id })
    .from(bidAwards)
    .where(eq(bidAwards.packageId, packageId));
  const subjectIds = new Set<string>([
    packageId,
    ...subs.map((s) => s.id),
    ...awards.map((a) => a.id),
  ]);
  const rows = await db
    .select()
    .from(signals)
    .where(
      and(
        eq(signals.companyId, companyId),
        inArray(signals.subjectId, [...subjectIds]),
      ),
    )
    .orderBy(desc(signals.createdAt));
  return rows.filter((r) => r.detector.startsWith("bid_integrity_"));
}

/**
 * Levelling entries answer "did this bidder carry this scope"; a levelled
 * package is the one whose contenders can be compared line for line. This
 * loader exists so the scope-gap analysis and the integrity run read the
 * same rows.
 */
export async function loadLevellingCoverage(db: Db, packageId: string) {
  return db
    .select()
    .from(bidLevellingEntries)
    .where(eq(bidLevellingEntries.packageId, packageId));
}
