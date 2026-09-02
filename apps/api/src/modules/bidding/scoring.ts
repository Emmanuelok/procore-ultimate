import type { FastifyPluginAsync } from "fastify";
import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { bidSubmissions, vendors } from "@constructos/db";
import { badRequest, conflict } from "../../lib/errors.js";
import type { Db } from "../../lib/db.js";
import {
  distinctCurrencies,
  fetchPackage,
  fetchSubmission,
  isInContention,

  ledger,
  requireBiddingLevel,
  unknowable,
  type BidPackageRow,
  type BidSubmissionRow,
  type Unknowable,
} from "./shared.js";
import { assertUnsealedForAnalysis, sealState } from "./sealing.js";
import {
  derivePriceScores,
  rankByScore,
  scoreSubmission,
  type CriterionDef,
  type CriterionScoreInput,
  type ScoreResult,
} from "./levelling-math.js";

const scoreEntrySchema = z.object({
  key: z.string().trim().min(1).max(60),
  score: z.number().finite().min(0).nullable(),
  maxScore: z.number().finite().min(0).nullable().optional(),
  note: z.string().max(4000).nullable().optional(),
});

const scoresSchema = z.object({
  scores: z.array(scoreEntrySchema).min(1).max(50),
  evaluationNote: z.string().max(8000).nullable().optional(),
});

export function criteriaOf(pkg: BidPackageRow): CriterionDef[] {
  return ((pkg.evaluationCriteria as unknown[]) ?? []).map((raw) => {
    const c = raw as Record<string, unknown>;
    return {
      key: String(c["key"] ?? ""),
      label: String(c["label"] ?? c["key"] ?? ""),
      weight: typeof c["weight"] === "number" ? (c["weight"] as number) : 0,
      kind: c["kind"] === "price" ? "price" : "quality",
    };
  });
}

export function storedScores(submission: BidSubmissionRow): CriterionScoreInput[] {
  const detail = submission.detail as Record<string, unknown>;
  const raw = (detail["criterionScores"] as unknown[]) ?? [];
  return raw.map((r) => {
    const s = r as Record<string, unknown>;
    return {
      key: String(s["key"] ?? ""),
      score: typeof s["score"] === "number" ? (s["score"] as number) : null,
      maxScore: typeof s["maxScore"] === "number" ? (s["maxScore"] as number) : null,
      note: typeof s["note"] === "string" ? (s["note"] as string) : null,
    };
  });
}

/**
 * Which figure the price score is computed from. The LEVELLED amount when the
 * levelling has been completed, the as-bid total otherwise — and the answer
 * says which, because scoring price off as-bid totals is scoring bidders on
 * how much scope they left out.
 */
export function priceBasisOf(submission: BidSubmissionRow): {
  amount: number | null;
  basis: "levelled" | "as_bid" | "none";
  note: string;
} {
  if (submission.levellingCompletedAt && submission.normalisedAmount !== null) {
    return {
      amount: submission.normalisedAmount,
      basis: "levelled",
      note: "Scored on the levelled (like-for-like) amount.",
    };
  }
  if (submission.totalAmount !== null) {
    return {
      amount: submission.totalAmount,
      basis: "as_bid",
      note:
        "Scored on the AS-BID total because this package has not been levelled. As-bid totals " +
        "reward the bidder who read the scope least carefully — level the package before the " +
        "score is relied on.",
    };
  }
  return { amount: null, basis: "none", note: "This bid carries no amount to score." };
}

export interface SubmissionScoring extends ScoreResult {
  submissionId: string;
  reference: string;
  vendorId: string;
  vendorName: string | null;
  priceBasis: "levelled" | "as_bid" | "none";
  priceAmount: number | null;
  priceScore: Unknowable;
  inContention: boolean;
}

/**
 * Score every bid on a package. The one thing this must never do is treat an
 * unscored criterion as a zero — the total comes back null with the criterion
 * named instead, because a bidder losing an award on a criterion nobody
 * assessed them on is the failure this whole arrangement exists to prevent.
 */
export async function scorePackage(
  db: Db,
  pkg: BidPackageRow,
): Promise<{
  criteria: CriterionDef[];
  priceWeight: number | null;
  qualityWeight: number | null;
  rows: SubmissionScoring[];
  ranked: ReturnType<typeof rankByScore>;
  currencies: string[];
  notes: string[];
}> {
  const criteria = criteriaOf(pkg);
  const subs = await db
    .select()
    .from(bidSubmissions)
    .where(eq(bidSubmissions.packageId, pkg.id))
    .orderBy(asc(bidSubmissions.createdAt));
  const contenders = subs.filter(
    (s) => isInContention(s.status) && !(s.isLate === 1 && !s.lateAcceptedBy),
  );
  const vendorRows = subs.length
    ? await db
        .select({ id: vendors.id, name: vendors.name })
        .from(vendors)
        .where(inArray(vendors.id, [...new Set(subs.map((s) => s.vendorId))]))
    : [];
  const names = new Map(vendorRows.map((v) => [v.id, v.name] as const));

  const notes: string[] = [];
  const currencies = distinctCurrencies(contenders.map((s) => s.currency));
  const bases = new Map(contenders.map((s) => [s.id, priceBasisOf(s)] as const));
  if ([...bases.values()].some((b) => b.basis === "as_bid")) {
    notes.push(
      "At least one bid is being scored on its as-bid total because the levelling is not " +
        "complete. Complete the levelling before the ranking is used to award.",
    );
  }

  let priceScores: Map<string, Unknowable>;
  if (currencies.length > 1) {
    const why =
      `Bids still in contention are priced in ${currencies.join(", ")}. Price scores rank bids ` +
      "against each other, and bids in different currencies are never ranked here — no rate is " +
      "on the record.";
    notes.push(why);
    priceScores = new Map(contenders.map((s) => [s.id, unknowable<number>(why)] as const));
  } else {
    priceScores = derivePriceScores(
      contenders.map((s) => ({ submissionId: s.id, amount: bases.get(s.id)?.amount ?? null })),
    );
  }

  const rows: SubmissionScoring[] = subs.map((s) => {
    const inContention = contenders.some((c) => c.id === s.id);
    const basis = bases.get(s.id) ?? priceBasisOf(s);
    const priceScore =
      priceScores.get(s.id) ??
      unknowable<number>(
        `${s.reference} is not in contention (status ${s.status}${
          s.isLate === 1 && !s.lateAcceptedBy ? ", late and not accepted" : ""
        }), so it is not scored against the other bids.`,
      );
    const result = scoreSubmission({
      criteria,
      scores: storedScores(s),
      priceWeight: pkg.priceWeight,
      qualityWeight: pkg.qualityWeight,
      priceScore,
    });
    return {
      ...result,
      submissionId: s.id,
      reference: s.reference,
      vendorId: s.vendorId,
      vendorName: names.get(s.vendorId) ?? null,
      priceBasis: basis.basis,
      priceAmount: basis.amount,
      priceScore,
      inContention,
    };
  });

  const ranked = rankByScore(
    rows
      .filter((r) => r.inContention)
      .map((r) => ({ submissionId: r.submissionId, totalScore: r.totalScore })),
  );

  return {
    criteria,
    priceWeight: pkg.priceWeight,
    qualityWeight: pkg.qualityWeight,
    rows,
    ranked,
    currencies,
    notes,
  };
}

export const scoringRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("bidding", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("bidding", "standard"),
  ];
  const companyGate = [app.authenticate, app.requireCompany];

  /**
   * Record an evaluator's scores against the declared criteria. A criterion
   * key that was never declared is refused: scoring bidders on something the
   * tender did not say they would be scored on is the same failure as
   * changing the weights after the prices are open.
   */
  app.post("/bid-submissions/:submissionId/scores", { preHandler: companyGate }, async (req, reply) => {
    const body = scoresSchema.parse(req.body);
    const { submissionId } = req.params as { submissionId: string };
    const submission = await fetchSubmission(app.db, submissionId, req.companyId!);
    await requireBiddingLevel(app, req, reply, submission.projectId, "standard");
    const pkg = await fetchPackage(app.db, submission.packageId, req.companyId!);
    assertUnsealedForAnalysis(pkg, "Scoring a bid");

    const criteria = criteriaOf(pkg);
    if (criteria.length === 0) {
      throw conflict(
        "This package declares no evaluation criteria, so there is nothing to score against. " +
          "Declare the basis on the package before bids open.",
      );
    }
    const declared = new Set(criteria.map((c) => c.key));
    for (const s of body.scores) {
      if (!declared.has(s.key)) {
        throw badRequest(
          `"${s.key}" is not a declared evaluation criterion on ${pkg.reference}. The declared ` +
            `set is: ${[...declared].join(", ")}. Bidders are scored on what the tender said ` +
            "they would be scored on, and on nothing else.",
        );
      }
      if (s.score !== null && s.maxScore !== null && s.maxScore !== undefined && s.score > s.maxScore) {
        throw badRequest(`Score ${s.score} for "${s.key}" exceeds its maximum of ${s.maxScore}.`);
      }
    }

    const existing = storedScores(submission);
    const merged = new Map(existing.map((s) => [s.key, s] as const));
    for (const s of body.scores) {
      merged.set(s.key, {
        key: s.key,
        score: s.score,
        maxScore: s.maxScore ?? 100,
        note: s.note ?? null,
      });
    }
    const now = new Date().toISOString();
    await app.db
      .update(bidSubmissions)
      .set({
        detail: {
          ...(submission.detail as Record<string, unknown>),
          criterionScores: [...merged.values()],
        },
        evaluatedBy: req.user!.id,
        evaluatedAt: now,
        evaluationNote: body.evaluationNote ?? submission.evaluationNote,
        updatedAt: now,
      })
      .where(eq(bidSubmissions.id, submissionId));

    await ledger(app.db, req, "update", "bid_submission", submissionId, {
      projectId: submission.projectId,
      packageId: submission.packageId,
      event: "scored",
      scores: body.scores,
      evaluatedBy: req.user!.id,
    }, submission.projectId, true);

    const fresh = await fetchSubmission(app.db, submissionId, req.companyId!);
    const result = scoreSubmission({
      criteria,
      scores: storedScores(fresh),
      priceWeight: pkg.priceWeight,
      qualityWeight: pkg.qualityWeight,
      // Price is a COMPARISON across the package, so it cannot be formed for
      // one bid in isolation. Only the quality half is meaningful here.
      priceScore: unknowable(
        "A price score ranks this bid against the others, so it is produced by " +
          "POST /scoring/compute across the package, never one bid at a time.",
      ),
    });
    return {
      submissionId,
      criteria: result.criteria,
      technicalScore: result.technicalScore,
      note:
        "Totals and ranks are produced by POST .../scoring/compute across the whole package, " +
        "because a price score is a comparison and cannot be formed one bid at a time.",
    };
  });

  app.get(
    "/projects/:projectId/bid-packages/:packageId/scoring",
    { preHandler: readGate },
    async (req) => {
      const { packageId } = req.params as { packageId: string };
      const pkg = await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      const seal = sealState(pkg);
      if (seal.amountsWithheld) {
        return {
          seal,
          sealed: true,
          criteria: criteriaOf(pkg),
          rows: [],
          ranked: [],
          note:
            `Scores are withheld while this package is sealed: a price score IS the price, ` +
            `expressed as a comparison. ${seal.note}`,
        };
      }
      const scored = await scorePackage(app.db, pkg);
      return { seal, sealed: false, ...scored };
    },
  );

  app.post(
    "/projects/:projectId/bid-packages/:packageId/scoring/compute",
    { preHandler: standardGate },
    async (req) => {
      const { packageId } = req.params as { packageId: string };
      const pkg = await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      assertUnsealedForAnalysis(pkg, "Computing scores");
      const scored = await scorePackage(app.db, pkg);
      const rankById = new Map(scored.ranked.map((r) => [r.submissionId, r] as const));
      const now = new Date().toISOString();

      for (const row of scored.rows) {
        await app.db
          .update(bidSubmissions)
          .set({
            commercialScore: row.commercialScore.value,
            technicalScore: row.technicalScore.value,
            // NULL, never 0, when a criterion was not scored
            totalScore: row.totalScore.value,
            rank: rankById.get(row.submissionId)?.rank ?? null,
            updatedAt: now,
          })
          .where(eq(bidSubmissions.id, row.submissionId));
      }
      await ledger(app.db, req, "update", "bid_package", packageId, {
        projectId: req.projectId!,
        event: "scoring_computed",
        priceWeight: pkg.priceWeight,
        qualityWeight: pkg.qualityWeight,
        criteria: scored.criteria,
        results: scored.rows.map((r) => ({
          submissionId: r.submissionId,
          reference: r.reference,
          commercialScore: r.commercialScore.value,
          technicalScore: r.technicalScore.value,
          totalScore: r.totalScore.value,
          unscoredReasons: r.totalScore.reasons,
          rank: rankById.get(r.submissionId)?.rank ?? null,
        })),
      }, req.projectId!, true);

      return {
        ...scored,
        unscored: scored.rows
          .filter((r) => r.inContention && r.totalScore.value === null)
          .map((r) => ({
            submissionId: r.submissionId,
            reference: r.reference,
            vendorName: r.vendorName,
            totalScore: null,
            reasons: r.totalScore.reasons,
          })),
        note:
          "A bid with an unscored criterion carries a NULL total and no rank, with the criterion " +
          "named. It is never scored zero: a gap counted as zero decides awards wrongly.",
      };
    },
  );
};
