import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  bidAwards,
  bidInvitations,
  bidPackages,
  bidSubmissions,
  vendors,
} from "@constructos/db";
import { badRequest } from "../../lib/errors.js";
import { epochMs } from "../../lib/time.js";
import type { Db } from "../../lib/db.js";
import {
  distinctCurrencies,
  isInContention,
  known,
  round2,
  todayIso,
  unknowable,
  type Unknowable,
} from "./shared.js";
import { batchVendorPrequalStatus } from "./prequal-status.js";
import { competitorProfiles, type PricingObservation } from "./analytics-math.js";
import { medianUnsorted } from "./integrity.js";

/**
 * COMPANY-LEVEL PROCUREMENT ANALYTICS.
 *
 * Three questions a buyer cannot answer from inside one package:
 *
 *  COVERAGE (#158, #159, #161, #162) — is this tender actually being
 *    competed? A package with six invitations and two intending bidders is
 *    not a competition, and the moment to find that out is five days before
 *    the deadline, not on the tabulation.
 *
 *  VENDOR HISTORY (#179) — everything one supplier has ever done with us:
 *    what they were invited to, what they bid, where they came, how they
 *    price against the field, and how often they say no. It is what the
 *    invite modal should be filtered by and what a debrief conversation
 *    should be held on.
 *
 *  MARKET POSITION (#1050) — where each bidder sits against the field, built
 *    entirely from prices they submitted to us. That is the only competitor
 *    intelligence that is both lawful to hold and useful to have: it says how
 *    a company prices relative to a market, not what they will bid next.
 *
 * Every rate in here refuses to be computed from too few observations, and
 * says how few. A win rate over two tenders is a description of two tenders.
 */

const WINDOW_MONTHS = 24;

interface PackageObservation {
  packageId: string;
  reference: string;
  title: string;
  projectId: string;
  tradeCode: string | null;
  currency: string;
  engineersEstimate: number | null;
  awardedVendorId: string | null;
  awardedAt: string | null;
  status: string;
  bidDueAt: string | null;
  submissions: Array<{
    id: string;
    vendorId: string;
    amount: number | null;
    comparable: number | null;
    currency: string;
    status: string;
    rank: number | null;
    isLate: boolean;
    receivedAt: string | null;
  }>;
}

async function loadObservations(
  db: Db,
  companyId: string,
  sinceIso: string,
): Promise<PackageObservation[]> {
  const packages = await db
    .select()
    .from(bidPackages)
    .where(and(eq(bidPackages.companyId, companyId), gte(bidPackages.createdAt, sinceIso)))
    .orderBy(desc(bidPackages.createdAt))
    .limit(400);
  if (packages.length === 0) return [];
  const subs = await db
    .select()
    .from(bidSubmissions)
    .where(
      inArray(
        bidSubmissions.packageId,
        packages.map((p) => p.id),
      ),
    );
  return packages.map((pkg) => {
    const mine = subs.filter((s) => s.packageId === pkg.id);
    const allLevelled =
      mine.length > 0 &&
      mine
        .filter((s) => isInContention(s.status))
        .every((s) => s.levellingCompletedAt !== null && s.normalisedAmount !== null);
    return {
      packageId: pkg.id,
      reference: pkg.reference,
      title: pkg.title,
      projectId: pkg.projectId,
      tradeCode: pkg.tradeCode,
      currency: pkg.currency,
      engineersEstimate: pkg.engineersEstimate,
      awardedVendorId: pkg.awardedVendorId,
      awardedAt: pkg.awardedAt,
      status: pkg.status,
      bidDueAt: pkg.bidDueAt,
      submissions: mine.map((s) => ({
        id: s.id,
        vendorId: s.vendorId,
        amount: s.totalAmount,
        comparable: allLevelled ? s.normalisedAmount : s.totalAmount,
        currency: s.currency,
        status: s.status,
        rank: s.rank,
        isLate: s.isLate === 1,
        receivedAt: s.receivedAt,
      })),
    };
  });
}

/** Turn packages into per-vendor pricing observations against the field. */
export function pricingObservations(
  packages: readonly PackageObservation[],
  vendorNames: ReadonlyMap<string, string>,
): PricingObservation[] {
  const out: PricingObservation[] = [];
  for (const pkg of packages) {
    const contenders = pkg.submissions.filter(
      (s) => isInContention(s.status) || s.status === "unsuccessful" || s.status === "awarded",
    );
    const priced = contenders.filter(
      (s): s is (typeof contenders)[number] & { comparable: number } => s.comparable !== null,
    );
    if (priced.length === 0) continue;
    // One field, one currency: a median across currencies is meaningless.
    const currencies = distinctCurrencies(priced.map((s) => s.currency));
    if (currencies.length > 1) continue;
    const median = medianUnsorted(priced.map((s) => s.comparable));
    for (const sub of priced) {
      out.push({
        packageId: pkg.packageId,
        packageReference: pkg.reference,
        tradeCode: pkg.tradeCode,
        vendorId: sub.vendorId,
        vendorName: vendorNames.get(sub.vendorId) ?? null,
        amount: sub.comparable,
        currency: sub.currency,
        fieldMedian: median,
        engineersEstimate: pkg.engineersEstimate,
        rank: sub.rank,
        fieldSize: priced.length,
        won: pkg.awardedVendorId === sub.vendorId,
      });
    }
  }
  return out;
}

export const analyticsRoutes: FastifyPluginAsync = async (app) => {
  const memberGate = [app.authenticate, app.requireCompany];

  async function namesFor(db: Db, companyId: string, ids: readonly string[]) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return new Map<string, string>();
    const rows = await db
      .select({ id: vendors.id, name: vendors.name })
      .from(vendors)
      .where(and(eq(vendors.companyId, companyId), inArray(vendors.id, unique)));
    return new Map(rows.map((v) => [v.id, v.name] as const));
  }

  function windowStart(months: number): string {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - months);
    return d.toISOString();
  }

  /* ---------------------------------------------------------------- */
  /* Bid coverage by trade (#158, #159, #161, #162)                    */
  /* ---------------------------------------------------------------- */

  app.get("/companies/current/bid-coverage", { preHandler: memberGate }, async (req) => {
    const q = z
      .object({ warnDays: z.coerce.number().int().min(0).max(60).default(5) })
      .parse(req.query ?? {});
    const companyId = req.companyId!;
    const live = await app.db
      .select()
      .from(bidPackages)
      .where(
        and(
          eq(bidPackages.companyId, companyId),
          inArray(bidPackages.status, ["invitations_sent", "open", "closed"]),
        ),
      )
      .limit(300);
    if (live.length === 0) {
      return {
        trades: [],
        packages: [],
        total: 0,
        note:
          "No tender is currently out to market. Coverage is a statement about live packages: " +
          "how many bidders were asked, how many said they would bid, and how many did.",
      };
    }
    const packageIds = live.map((p) => p.id);
    const invites = await app.db
      .select()
      .from(bidInvitations)
      .where(inArray(bidInvitations.packageId, packageIds));
    const names = await namesFor(
      app.db,
      companyId,
      invites.map((i) => i.vendorId),
    );
    const nowMs = Date.now();

    const packageRows = live.map((pkg) => {
      const mine = invites.filter((i) => i.packageId === pkg.id);
      const intending = mine.filter(
        (i) => i.intentToBid === 1 || i.status === "submitted",
      ).length;
      const submitted = mine.filter((i) => i.status === "submitted").length;
      const declined = mine.filter((i) => i.status === "declined").length;
      const silent = mine.filter(
        (i) => i.sentAt !== null && i.respondedAt === null && i.viewedAt === null,
      );
      const dueMs = epochMs(pkg.bidDueAt);
      const daysToDue = dueMs === null ? null : Math.round((dueMs - nowMs) / 86_400_000);
      const thin = intending < 3;
      const urgent = daysToDue !== null && daysToDue <= q.warnDays && daysToDue >= 0;
      return {
        packageId: pkg.id,
        projectId: pkg.projectId,
        reference: pkg.reference,
        title: pkg.title,
        tradeCode: pkg.tradeCode,
        status: pkg.status,
        bidDueAt: pkg.bidDueAt,
        daysToDue,
        invited: mine.length,
        intending,
        submitted,
        declined,
        silent: silent.length,
        silentVendors: silent.map((i) => ({
          invitationId: i.id,
          vendorId: i.vendorId,
          vendorName: names.get(i.vendorId) ?? null,
          sentAt: i.sentAt,
          remindersSent: i.remindersSent,
        })),
        declineReasons: [
          ...mine
            .filter((i) => i.declineReason)
            .reduce((acc, i) => {
              const key = i.declineReason as string;
              acc.set(key, (acc.get(key) ?? 0) + 1);
              return acc;
            }, new Map<string, number>())
            .entries(),
        ].map(([reason, count]) => ({ reason, count })),
        coverageFlag:
          thin && urgent
            ? "critical"
            : thin
              ? "warning"
              : silent.length > 0 && urgent
                ? "warning"
                : "ok",
        note: thin
          ? `${intending} bidder(s) intend to bid` +
            (daysToDue !== null ? ` with ${daysToDue} day(s) to the deadline` : "") +
            ". A field of fewer than three is a quotation rather than a competition, and the " +
            "price it produces is not a market price. Chase the silent invitations, extend the " +
            "period, or widen the list — all three are cheaper than the price of an " +
            "uncontested tender."
          : silent.length > 0
            ? `${silent.length} invited bidder(s) have neither opened the package nor responded.`
            : "Adequately covered.",
      };
    });

    const tradeMap = new Map<string, typeof packageRows>();
    for (const row of packageRows) {
      const key = row.tradeCode ?? "__untraded__";
      tradeMap.set(key, [...(tradeMap.get(key) ?? []), row]);
    }
    return {
      packages: packageRows,
      trades: [...tradeMap.entries()].map(([tradeCode, rows]) => ({
        tradeCode: tradeCode === "__untraded__" ? null : tradeCode,
        packages: rows.length,
        invited: rows.reduce((s, r) => s + r.invited, 0),
        intending: rows.reduce((s, r) => s + r.intending, 0),
        submitted: rows.reduce((s, r) => s + r.submitted, 0),
        declined: rows.reduce((s, r) => s + r.declined, 0),
        thinPackages: rows.filter((r) => r.coverageFlag !== "ok").length,
      })),
      total: packageRows.length,
      atRisk: packageRows.filter((r) => r.coverageFlag !== "ok").length,
      warnDays: q.warnDays,
      asOf: todayIso(),
      note:
        "Coverage counts intentions, not invitations. Six invitations and two intending bidders " +
        "is a package with two bidders, and the moment to discover that is before the deadline.",
    };
  });

  /* ---------------------------------------------------------------- */
  /* Competitor pricing intelligence (#1050)                           */
  /* ---------------------------------------------------------------- */

  app.get("/companies/current/bid-pricing", { preHandler: memberGate }, async (req) => {
    const q = z
      .object({
        tradeCode: z.string().max(60).optional(),
        months: z.coerce.number().int().min(1).max(120).default(WINDOW_MONTHS),
      })
      .parse(req.query ?? {});
    const companyId = req.companyId!;
    const packages = await loadObservations(app.db, companyId, windowStart(q.months));
    const scoped = q.tradeCode ? packages.filter((p) => p.tradeCode === q.tradeCode) : packages;
    const names = await namesFor(
      app.db,
      companyId,
      scoped.flatMap((p) => p.submissions.map((s) => s.vendorId)),
    );
    const observations = pricingObservations(scoped, names);
    const profiles = competitorProfiles(observations);

    const byTrade = new Map<string, PricingObservation[]>();
    for (const o of observations) {
      const key = o.tradeCode ?? "__untraded__";
      byTrade.set(key, [...(byTrade.get(key) ?? []), o]);
    }

    return {
      windowMonths: q.months,
      tradeCode: q.tradeCode ?? null,
      packagesExamined: scoped.length,
      observations: observations.length,
      vendors: profiles,
      trades: [...byTrade.entries()].map(([tradeCode, rows]) => {
        const currencies = distinctCurrencies(rows.map((r) => r.currency));
        const estimateDeviations = rows
          .filter((r) => r.engineersEstimate !== null && r.engineersEstimate > 0)
          .map(
            (r) =>
              ((r.amount - (r.engineersEstimate as number)) / (r.engineersEstimate as number)) * 100,
          );
        const median = medianUnsorted(estimateDeviations);
        return {
          tradeCode: tradeCode === "__untraded__" ? null : tradeCode,
          observations: rows.length,
          bidders: new Set(rows.map((r) => r.vendorId)).size,
          packages: new Set(rows.map((r) => r.packageId)).size,
          currencies,
          medianDeviationFromEstimatePercent:
            median === null
              ? unknowable<number>(
                  "None of the packages in this trade carries a pre-tender estimate, so the " +
                    "market cannot be measured against anything.",
                )
              : known(median),
          note:
            median === null
              ? "No estimate on record for this trade."
              : median > 10
                ? `The market in this trade is coming back a median ${median}% ABOVE the ` +
                  "pre-tender estimates. Either the estimates are stale or the market has " +
                  "moved; both are worth knowing before the next budget is set."
                : median < -10
                  ? `The market is coming back a median ${Math.abs(median)}% BELOW the ` +
                    "pre-tender estimates, which usually means the estimates carry contingency " +
                    "the market does not."
                  : "The market and the estimates broadly agree in this trade.",
        };
      }),
      note:
        observations.length === 0
          ? "No priced bid in this window carries a comparable amount, so there is nothing to " +
            "place anybody against."
          : "Built entirely from prices these bidders submitted to us. It says how a company " +
            "prices relative to a field, never what they will bid next — and it is not a " +
            "reason to share information between bidders.",
    };
  });

  /* ---------------------------------------------------------------- */
  /* One vendor's whole bidding history (#179)                         */
  /* ---------------------------------------------------------------- */

  app.get(
    "/companies/current/vendors/:vendorId/bid-history",
    { preHandler: memberGate },
    async (req) => {
      const { vendorId } = req.params as { vendorId: string };
      const companyId = req.companyId!;
      const [vendor] = await app.db
        .select({ id: vendors.id, name: vendors.name })
        .from(vendors)
        .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, companyId)))
        .limit(1);
      if (!vendor) throw badRequest("That vendor is not in this company's directory.");

      const invites = await app.db
        .select()
        .from(bidInvitations)
        .where(
          and(eq(bidInvitations.companyId, companyId), eq(bidInvitations.vendorId, vendorId)),
        )
        .orderBy(desc(bidInvitations.createdAt))
        .limit(300);
      const subs = await app.db
        .select()
        .from(bidSubmissions)
        .where(
          and(eq(bidSubmissions.companyId, companyId), eq(bidSubmissions.vendorId, vendorId)),
        )
        .orderBy(desc(bidSubmissions.createdAt))
        .limit(300);
      const awards = await app.db
        .select()
        .from(bidAwards)
        .where(and(eq(bidAwards.companyId, companyId), eq(bidAwards.vendorId, vendorId)))
        .limit(300);
      const packageIds = [
        ...new Set([
          ...invites.map((i) => i.packageId),
          ...subs.map((s) => s.packageId),
          ...awards.map((a) => a.packageId),
        ]),
      ];
      const packages = packageIds.length
        ? await app.db
            .select()
            .from(bidPackages)
            .where(
              and(eq(bidPackages.companyId, companyId), inArray(bidPackages.id, packageIds)),
            )
        : [];
      const packagesById = new Map(packages.map((p) => [p.id, p] as const));
      const fieldSubs = packageIds.length
        ? await app.db
            .select({
              packageId: bidSubmissions.packageId,
              vendorId: bidSubmissions.vendorId,
              totalAmount: bidSubmissions.totalAmount,
              normalisedAmount: bidSubmissions.normalisedAmount,
              currency: bidSubmissions.currency,
              status: bidSubmissions.status,
            })
            .from(bidSubmissions)
            .where(inArray(bidSubmissions.packageId, packageIds))
        : [];

      const rows = invites.map((inv) => {
        const pkg = packagesById.get(inv.packageId);
        const sub = subs.find((s) => s.packageId === inv.packageId && !s.supersededById);
        const award = awards.find((a) => a.packageId === inv.packageId);
        const field = fieldSubs.filter(
          (f) => f.packageId === inv.packageId && f.totalAmount !== null,
        );
        const sameCurrency =
          sub && field.every((f) => f.currency.toUpperCase() === sub.currency.toUpperCase());
        const median =
          sameCurrency && field.length >= 2
            ? medianUnsorted(field.map((f) => f.normalisedAmount ?? f.totalAmount ?? 0))
            : null;
        const mine = sub?.normalisedAmount ?? sub?.totalAmount ?? null;
        return {
          packageId: inv.packageId,
          projectId: inv.projectId,
          packageReference: pkg?.reference ?? null,
          packageTitle: pkg?.title ?? null,
          tradeCode: pkg?.tradeCode ?? null,
          invitedAt: inv.invitedAt ?? inv.createdAt,
          invitationStatus: inv.status,
          declineReason: inv.declineReason,
          bidDueAt: pkg?.bidDueAt ?? null,
          submitted: Boolean(sub),
          submissionId: sub?.id ?? null,
          submissionStatus: sub?.status ?? null,
          amount: mine,
          currency: sub?.currency ?? pkg?.currency ?? null,
          onTime: sub ? sub.isLate !== 1 : null,
          rank: sub?.rank ?? null,
          fieldSize: field.length,
          deviationFromMedianPercent:
            median !== null && median > 0 && mine !== null
              ? round2(((mine - median) / median) * 100)
              : null,
          deviationFromEstimatePercent:
            pkg?.engineersEstimate && pkg.engineersEstimate > 0 && mine !== null
              ? round2(((mine - pkg.engineersEstimate) / pkg.engineersEstimate) * 100)
              : null,
          won: award ? ["approved", "letter_of_intent", "contract_issued", "executed"].includes(award.status) : false,
          awardReference: award?.reference ?? null,
        };
      });

      const submittedRows = rows.filter((r) => r.submitted);
      const decided = rows.filter(
        (r) => r.submitted && (r.won || r.submissionStatus === "unsuccessful"),
      );
      const wins = decided.filter((r) => r.won).length;
      const onTimeRows = submittedRows.filter((r) => r.onTime !== null);
      const deviations = rows
        .map((r) => r.deviationFromMedianPercent)
        .filter((d): d is number => d !== null);
      const winRate: Unknowable =
        decided.length < 3
          ? unknowable<number>(
              `${decided.length} decided bid(s) from this vendor; a win rate over fewer than ` +
                "three outcomes describes those tenders, not a rate.",
            )
          : known(round2((wins / decided.length) * 100));
      const standing = await batchVendorPrequalStatus(app.db, companyId, [vendorId]);

      return {
        vendor,
        prequalification: standing.get(vendorId) ?? null,
        rows,
        summary: {
          invitations: invites.length,
          submitted: submittedRows.length,
          declined: rows.filter((r) => r.invitationStatus === "declined").length,
          silent: rows.filter(
            (r) => !r.submitted && r.invitationStatus !== "declined",
          ).length,
          wins,
          decided: decided.length,
          winRatePercent: winRate,
          onTimeRatePercent:
            onTimeRows.length === 0
              ? unknowable<number>("This vendor has never submitted a bid.")
              : known(
                  round2(
                    (onTimeRows.filter((r) => r.onTime === true).length / onTimeRows.length) * 100,
                  ),
                ),
          responseRatePercent:
            invites.length === 0
              ? unknowable<number>("This vendor has never been invited.")
              : known(round2((submittedRows.length / invites.length) * 100)),
          medianDeviationFromFieldPercent:
            deviations.length === 0
              ? unknowable<number>(
                  "None of this vendor's bids sat in a field of at least two priced bids in the " +
                    "same currency, so there is nothing to place them against.",
                )
              : known(medianUnsorted(deviations) ?? 0),
        },
        declineReasons: [
          ...rows
            .filter((r) => r.declineReason)
            .reduce((acc, r) => {
              const key = r.declineReason as string;
              acc.set(key, (acc.get(key) ?? 0) + 1);
              return acc;
            }, new Map<string, number>())
            .entries(),
        ].map(([reason, count]) => ({ reason, count })),
        note:
          invites.length === 0
            ? `${vendor.name} has never been invited to tender by this company.`
            : `${vendor.name} has been invited ${invites.length} time(s) and bid ` +
              `${submittedRows.length} time(s). A supplier who is invited constantly and bids ` +
              "rarely is either wrong for the work or too busy for it, and both are worth " +
              "knowing before the next invitation.",
      };
    },
  );
};
