import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import {
  bidAwards,
  bidPackages,
  bidSubmissions,
  commitments,
  vendors,
} from "@constructos/db";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { badRequest, conflict } from "../../lib/errors.js";
import { epochMs } from "../../lib/time.js";
import type { Db } from "../../lib/db.js";
import { commitmentReference } from "../commitments/shared.js";
import { insertSovLine, sovContext, type SovLineInput } from "../commitments/sov.js";
import { budgetLineIdsFor, recomputeCommitmentTotals, syncBudgetCommitted } from "../commitments/rollups.js";
import {
  assertSegregation,
  awardReference,
  CENT,
  distinctCurrencies,
  fetchAward,
  fetchPackage,
  fetchSubmission,
  isInContention,
  justificationSchema,
  ledger,
  reasonSchema,
  requireBiddingLevel,
  round2,
  type BidAwardRow,
  type BidPackageRow,
  type BidSubmissionRow,
} from "./shared.js";
import { assertLateBidUsable, assertUnsealedForAnalysis } from "./sealing.js";
import { effectiveLimit, evaluatePrequalGate, vendorPrequalStatus } from "./prequal-status.js";
import { checkContractAgainstLimit } from "./financial-limits.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const recommendSchema = z.object({
  submissionId: z.string().min(1).max(64),
  /** why this bid — the sentence the recommendation stands or falls on */
  recommendationBasis: justificationSchema,
  scopeSummary: z.string().max(20000).nullable().optional(),
  /** REQUIRED when the recommendation is not the lowest comparable bid */
  notLowestJustification: justificationSchema.nullable().optional(),
  /** days between telling the losers and signing anything */
  standstillDays: z.number().int().min(0).max(90).optional(),
  approvalAuthority: z.string().max(300).nullable().optional(),
});

const approveSchema = z.object({
  approvalAuthority: z.string().max(300).nullable().optional(),
  approvalReference: z.string().max(200).nullable().optional(),
  standstillDays: z.number().int().min(0).max(90).optional(),
  /** carried onto the commitment created by this approval */
  contractDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  estimatedCompletionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  /** override where the committed cost lands; defaults to the package's budget lines */
  budgetLineItemId: z.string().min(1).max(64).nullable().optional(),
  note: z.string().max(8000).nullable().optional(),
});

/* ------------------------------------------------------------------ */
/* The comparison an award rests on                                    */
/* ------------------------------------------------------------------ */

export interface AwardCandidate {
  submissionId: string;
  reference: string;
  vendorId: string;
  /** the figure this bid is COMPARED on */
  comparableAmount: number | null;
  asBidAmount: number | null;
  currency: string;
  totalScore: number | null;
  rank: number | null;
}

export interface AwardComparison {
  basis: "levelled" | "as_bid";
  basisNote: string;
  candidates: AwardCandidate[];
  lowest: AwardCandidate | null;
  currency: string;
}

/**
 * Build the comparison the award decision rests on.
 *
 * The comparable figure is the LEVELLED amount wherever the package has been
 * levelled, and the as-bid total otherwise — stated either way, because
 * "lowest bid" means something different under each and an auditor will ask
 * which one you meant.
 *
 * Bids in different currencies are refused outright rather than converted:
 * there is no rate on this record, and inventing one would decide an award on
 * a number nobody supplied.
 */
export function buildAwardComparison(
  submissions: readonly BidSubmissionRow[],
): AwardComparison {
  const contenders = submissions.filter(
    (s) => isInContention(s.status) && !(s.isLate === 1 && !s.lateAcceptedBy),
  );
  if (contenders.length === 0) {
    throw conflict("No bid on this package is still in contention, so there is nothing to award.");
  }
  const currencies = distinctCurrencies(contenders.map((s) => s.currency));
  if (currencies.length > 1) {
    throw badRequest(
      `Bids still in contention are priced in ${currencies.join(", ")}. This platform never ` +
        "ranks figures in different currencies against each other: no exchange rate is on the " +
        "record, and choosing one here would be choosing the winner. Restate the bids in one " +
        "currency, with the rate and its source recorded, before recommending an award.",
    );
  }
  const allLevelled = contenders.every(
    (s) => s.levellingCompletedAt !== null && s.normalisedAmount !== null,
  );
  const basis: "levelled" | "as_bid" = allLevelled ? "levelled" : "as_bid";
  const candidates: AwardCandidate[] = contenders.map((s) => ({
    submissionId: s.id,
    reference: s.reference,
    vendorId: s.vendorId,
    comparableAmount: basis === "levelled" ? s.normalisedAmount : s.totalAmount,
    asBidAmount: s.totalAmount,
    currency: s.currency,
    totalScore: s.totalScore,
    rank: s.rank,
  }));
  const priced = candidates.filter(
    (c): c is AwardCandidate & { comparableAmount: number } => c.comparableAmount !== null,
  );
  const lowest =
    priced.length === 0
      ? null
      : priced.reduce((low, c) => (c.comparableAmount < low.comparableAmount ? c : low));

  return {
    basis,
    basisNote:
      basis === "levelled"
        ? "Bids are compared on their LEVELLED amounts — the like-for-like figures produced by " +
          "the levelling, not the numbers the bidders wrote."
        : "Bids are compared on their AS-BID totals because this package has not been levelled. " +
          "As-bid totals are not like-for-like: the cheapest as-bid number frequently belongs " +
          "to whoever read the scope least carefully. Level the package before awarding on it.",
    candidates,
    lowest,
    currency: currencies[0] ?? "USD",
  };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export const awardRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("bidding", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("bidding", "standard"),
  ];
  const companyGate = [app.authenticate, app.requireCompany];

  async function awardContext(
    req: FastifyRequest,
  ): Promise<{ award: BidAwardRow; pkg: BidPackageRow; submission: BidSubmissionRow }> {
    const { awardId } = req.params as { awardId: string };
    const award = await fetchAward(app.db, awardId, req.companyId!);
    const pkg = await fetchPackage(app.db, award.packageId, req.companyId!);
    const submission = await fetchSubmission(app.db, award.submissionId, req.companyId!);
    return { award, pkg, submission };
  }

  function standstill(award: BidAwardRow, nowMs = Date.now()) {
    const endsMs = epochMs(award.standstillEndsAt);
    return {
      endsAt: award.standstillEndsAt,
      active: endsMs !== null && endsMs > nowMs,
      note:
        endsMs === null
          ? "No standstill period was set on this award."
          : endsMs > nowMs
            ? `Standstill runs to ${award.standstillEndsAt}. Nothing may be signed before then: ` +
              "the period exists so an unsuccessful bidder can challenge the decision while it " +
              "is still capable of being unwound."
            : `Standstill ended ${award.standstillEndsAt}.`,
    };
  }

  async function awardDetail(db: Db, award: BidAwardRow) {
    const pkg = await fetchPackage(db, award.packageId, award.companyId);
    const [vendorRow] = await db
      .select({ name: vendors.name })
      .from(vendors)
      .where(eq(vendors.id, award.vendorId))
      .limit(1);
    const commitmentRow = award.commitmentId
      ? (
          await db
            .select()
            .from(commitments)
            .where(eq(commitments.id, award.commitmentId))
            .limit(1)
        )[0] ?? null
      : null;
    const prequal = await vendorPrequalStatus(db, award.companyId, award.vendorId);
    return {
      ...award,
      isLowestBid: award.isLowestBid === 1,
      vendorName: vendorRow?.name ?? null,
      packageReference: pkg.reference,
      standstill: standstill(award),
      commitment: commitmentRow,
      prequalification: {
        state: prequal.state,
        expiresAt: prequal.expiresAt,
        note: prequal.note,
      },
      /**
       * The block a procurement audit asks for, assembled in one place so it
       * cannot be assembled differently by two screens.
       */
      audit: {
        recommendedBy: award.recommendedBy,
        recommendedAt: award.recommendedAt,
        approvedBy: award.approvedBy,
        approvedAt: award.approvedAt,
        segregated: Boolean(
          award.approvedBy && award.recommendedBy && award.approvedBy !== award.recommendedBy,
        ),
        isLowestBid: award.isLowestBid === 1,
        lowestBidAmount: award.lowestBidAmount,
        notLowestJustification: award.notLowestJustification,
        comparisonBasis: (award.detail as Record<string, unknown>)["comparisonBasis"] ?? null,
        recommendationBasis: award.recommendationBasis,
        savingAgainstEstimate: award.savingAgainstEstimate,
        engineersEstimate: pkg.engineersEstimate,
        evaluationSummary: award.evaluationSummary,
        unsuccessfulNotifiedAt: award.unsuccessfulNotifiedAt,
        standstillEndsAt: award.standstillEndsAt,
        commitmentId: award.commitmentId,
      },
    };
  }

  /* ---------------------------------------------------------------- */
  /* Recommend                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * The recommendation.
   *
   * The two columns every procurement audit asks for are set here and cannot
   * be avoided: `isLowestBid`, and — when the answer is no —
   * `notLowestJustification` alongside `lowestBidAmount`. Recommending
   * anything other than the lowest comparable bid without saying why in
   * writing is refused, not warned about.
   */
  app.post(
    "/projects/:projectId/bid-packages/:packageId/award/recommend",
    { preHandler: standardGate },
    async (req, reply) => {
      const { packageId } = req.params as { packageId: string };
      const body = recommendSchema.parse(req.body);
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const pkg = await fetchPackage(app.db, packageId, companyId, projectId);
      assertUnsealedForAnalysis(pkg, "Recommending an award");

      const existing = await app.db
        .select()
        .from(bidAwards)
        .where(eq(bidAwards.packageId, packageId));
      const live = existing.find(
        (a) => !["rejected", "withdrawn", "cancelled"].includes(a.status),
      );
      if (live) {
        throw conflict(
          `${pkg.reference} already carries award ${live.reference} at status "${live.status}". ` +
            "Reject or withdraw it before recommending a different bidder.",
        );
      }

      const submissions = await app.db
        .select()
        .from(bidSubmissions)
        .where(eq(bidSubmissions.packageId, packageId))
        .orderBy(asc(bidSubmissions.createdAt));
      const chosen = submissions.find((s) => s.id === body.submissionId);
      if (!chosen) throw badRequest("That submission is not on this package.");
      assertLateBidUsable(chosen, "Recommending this bid for award");
      if (!isInContention(chosen.status)) {
        throw conflict(
          `${chosen.reference} is at status "${chosen.status}" and is not in contention.`,
        );
      }
      if (chosen.totalAmount === null) {
        throw badRequest(
          `${chosen.reference} carries no total amount, so there is no sum to award. A ` +
            "commitment cannot be created for an unknown figure.",
        );
      }

      const comparison = buildAwardComparison(submissions);
      const chosenCandidate = comparison.candidates.find((c) => c.submissionId === chosen.id)!;
      if (chosenCandidate.comparableAmount === null) {
        throw conflict(
          `${chosen.reference} has no comparable amount on the ${comparison.basis} basis, so it ` +
            "cannot be shown to be the lowest bid or justified as not being it. " +
            comparison.basisNote,
        );
      }
      if (!comparison.lowest) {
        throw conflict("No bid in contention carries a comparable amount.");
      }

      const isLowest =
        chosenCandidate.comparableAmount <= comparison.lowest.comparableAmount! + CENT;
      if (!isLowest && !body.notLowestJustification) {
        throw badRequest(
          `${chosen.reference} at ${comparison.currency} ${chosenCandidate.comparableAmount} is ` +
            `not the lowest bid — ${comparison.lowest.reference} is, at ${comparison.currency} ` +
            `${comparison.lowest.comparableAmount}. A recommendation that is not the lowest bid ` +
            "REQUIRES a written justification: that record, alongside the lowest bid amount, is " +
            "precisely what an auditor asks for, and it cannot be written afterwards. Supply " +
            "notLowestJustification.",
          {
            control: "not_lowest_requires_justification",
            lowestSubmissionId: comparison.lowest.submissionId,
            lowestBidAmount: comparison.lowest.comparableAmount,
            recommendedAmount: chosenCandidate.comparableAmount,
            comparisonBasis: comparison.basis,
          },
        );
      }

      // The prequalification gate at award — refuse or warn per the package's
      // configured strictness, and either way name the lapse.
      const prequal = await vendorPrequalStatus(app.db, companyId, chosen.vendorId);
      const gate = evaluatePrequalGate(pkg, prequal, "Award recommendation", true);
      const cap = effectiveLimit(prequal);
      const capacity = checkContractAgainstLimit({
        contractValue: chosen.totalAmount,
        contractCurrency: chosen.currency,
        limit: cap.limit,
        limitCurrency: cap.currency,
        vendorName: prequal.vendorName ?? chosen.vendorId,
        basis: cap.basis,
      });

      const number = await nextRecordNumber(app.db, projectId, "bid_award");
      const reference = awardReference(number);
      const id = newId("bwd");
      const now = new Date().toISOString();
      const saving =
        pkg.engineersEstimate === null ? null : round2(pkg.engineersEstimate - chosen.totalAmount);

      await app.db.insert(bidAwards).values({
        id,
        companyId,
        projectId,
        packageId,
        submissionId: chosen.id,
        vendorId: chosen.vendorId,
        number,
        reference,
        awardAmount: chosen.totalAmount,
        currency: chosen.currency,
        scopeSummary: body.scopeSummary ?? pkg.scopeDescription ?? pkg.title,
        status: "recommended",
        recommendationBasis: body.recommendationBasis,
        evaluationSummary: comparison.candidates.map((c) => ({
          submissionId: c.submissionId,
          reference: c.reference,
          vendorId: c.vendorId,
          comparableAmount: c.comparableAmount,
          asBidAmount: c.asBidAmount,
          currency: c.currency,
          totalScore: c.totalScore,
          rank: c.rank,
          recommended: c.submissionId === chosen.id,
        })),
        isLowestBid: isLowest ? 1 : 0,
        notLowestJustification: isLowest ? null : (body.notLowestJustification ?? null),
        // recorded whether or not we took it — this is the auditor's anchor
        lowestBidAmount: comparison.lowest.comparableAmount,
        savingAgainstEstimate: saving,
        recommendedBy: req.user!.id,
        recommendedAt: now,
        approvalAuthority: body.approvalAuthority ?? null,
        standstillEndsAt: null,
        detail: {
          comparisonBasis: comparison.basis,
          comparisonBasisNote: comparison.basisNote,
          recommendedComparableAmount: chosenCandidate.comparableAmount,
          lowestBidSubmissionId: comparison.lowest.submissionId,
          lowestBidVendorId: comparison.lowest.vendorId,
          standstillDays: body.standstillDays ?? 0,
          prequalificationAtRecommendation: prequal.state,
          prequalificationFlag: gate.message,
          capacity,
        },
        createdBy: req.user!.id,
      });

      await app.db
        .update(bidPackages)
        .set({ status: "under_evaluation", updatedAt: now })
        .where(and(eq(bidPackages.id, packageId), ne(bidPackages.status, "awarded")));

      await ledger(
        app.db,
        req,
        "create",
        "bid_award",
        id,
        {
          projectId,
          packageId,
          packageReference: pkg.reference,
          reference,
          submissionId: chosen.id,
          vendorId: chosen.vendorId,
          awardAmount: chosen.totalAmount,
          currency: chosen.currency,
          comparisonBasis: comparison.basis,
          isLowestBid: isLowest,
          lowestBidAmount: comparison.lowest.comparableAmount,
          notLowestJustification: isLowest ? null : body.notLowestJustification,
          recommendationBasis: body.recommendationBasis,
          recommendedBy: req.user!.id,
          engineersEstimate: pkg.engineersEstimate,
          savingAgainstEstimate: saving,
          prequalificationState: prequal.state,
          prequalificationFlag: gate.message,
          capacityFlag: capacity.exceeds ? capacity.message : null,
        },
        projectId,
        true,
      );

      const created = await fetchAward(app.db, id, companyId);
      return reply.status(201).send({
        ...(await awardDetail(app.db, created)),
        comparison,
        warnings: [
          ...(gate.message ? [gate.message] : []),
          ...(capacity.exceeds || capacity.exceeds === null ? [capacity.message] : []),
        ],
      });
    },
  );

  /* ---------------------------------------------------------------- */
  /* Read                                                              */
  /* ---------------------------------------------------------------- */

  app.get(
    "/projects/:projectId/bid-packages/:packageId/awards",
    { preHandler: readGate },
    async (req) => {
      const { packageId } = req.params as { packageId: string };
      await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      const rows = await app.db
        .select()
        .from(bidAwards)
        .where(eq(bidAwards.packageId, packageId))
        .orderBy(desc(bidAwards.createdAt));
      const items = await Promise.all(rows.map((r) => awardDetail(app.db, r)));
      return { items, total: items.length };
    },
  );

  app.get("/bid-awards/:awardId", { preHandler: companyGate }, async (req, reply) => {
    const { award } = await awardContext(req);
    await requireBiddingLevel(app, req, reply, award.projectId, "read");
    return awardDetail(app.db, award);
  });

  /* ---------------------------------------------------------------- */
  /* Approve — and create the commitment                               */
  /* ---------------------------------------------------------------- */

  /**
   * Approval, by somebody who is neither the author nor the recommender, and
   * the handoff into the money spine.
   *
   * The commitment is CREATED IN THE COMMITMENTS MODULE — its reference
   * builder, its schedule-of-values insert, its totals recompute and its
   * budget sync — rather than shaped again here. `bid_awards.commitmentId` is
   * the seam, and after this call the buy side of the project holds one
   * record, not two that drift.
   */
  app.post("/bid-awards/:awardId/approve", { preHandler: companyGate }, async (req, reply) => {
    const body = approveSchema.parse(req.body ?? {});
    const { award, pkg, submission } = await awardContext(req);
    await requireBiddingLevel(app, req, reply, award.projectId, "standard");
    if (award.status !== "recommended" && award.status !== "pending_approval") {
      throw conflict(`This award is at status "${award.status}" and is not awaiting approval.`);
    }
    assertSegregation(
      req.user!.id,
      { createdBy: award.createdBy, recommendedBy: award.recommendedBy },
      "award",
    );

    // Standing can lapse between recommendation and approval — re-test it.
    const prequal = await vendorPrequalStatus(app.db, award.companyId, award.vendorId);
    const gate = evaluatePrequalGate(pkg, prequal, "Award approval", true);

    const companyId = award.companyId;
    const projectId = award.projectId;
    const now = new Date().toISOString();

    /* ---- the commitment ---- */
    const kind = pkg.packageKind === "supply_only" ? "purchase_order" : "subcontract";
    const commitmentNumber = await nextRecordNumber(app.db, projectId, "commitment");
    const commitmentRef = commitmentReference(kind, commitmentNumber);
    const commitmentId = newId("cmt");
    await app.db.insert(commitments).values({
      id: commitmentId,
      companyId,
      projectId,
      kind,
      number: commitmentNumber,
      reference: commitmentRef,
      title: pkg.title,
      description: `Awarded from bid package ${pkg.reference} (award ${award.reference}).`,
      scopeOfWork: award.scopeSummary ?? pkg.scopeDescription ?? null,
      vendorId: award.vendorId,
      pricingType: "lump_sum",
      status: "draft",
      currency: award.currency,
      defaultRetainagePercent: submission.retentionPercent ?? pkg.retentionPercent ?? 0,
      contractDate: body.contractDate ?? null,
      startDate: body.startDate ?? submission.proposedStartDate ?? null,
      estimatedCompletionDate:
        body.estimatedCompletionDate ?? submission.proposedCompletionDate ?? null,
      paymentTermsDays: submission.paymentTermsDays ?? pkg.paymentTermsDays ?? null,
      inclusions: submission.assumptions ?? null,
      exclusions: submission.exclusions ?? null,
      detail: {
        sourceBidPackageId: pkg.id,
        sourceBidPackageReference: pkg.reference,
        sourceBidAwardId: award.id,
        sourceBidAwardReference: award.reference,
        sourceBidSubmissionId: submission.id,
        bidQualifications: submission.qualifications ?? null,
      },
      createdBy: req.user!.id,
    });

    const budgetLineItemId =
      body.budgetLineItemId ?? ((pkg.budgetLineItemIds as string[])[0] ?? null);
    const ctx = await sovContext(app.db, companyId, projectId, {
      id: commitmentId,
      kind,
      defaultRetainagePercent: submission.retentionPercent ?? pkg.retentionPercent ?? 0,
    });
    const sovLine: SovLineInput = {
      description: award.scopeSummary ?? pkg.title,
      scheduledValue: award.awardAmount,
      billingMethod: "percent_complete",
      budgetLineItemId,
    };
    await insertSovLine(ctx, sovLine);
    await recomputeCommitmentTotals(app.db, commitmentId);
    const budgetLines = await budgetLineIdsFor(app.db, commitmentId);
    if (budgetLines.length > 0) {
      await syncBudgetCommitted(app.db, companyId, projectId, budgetLines);
    }

    /* ---- the award ---- */
    const standstillDays =
      body.standstillDays ??
      ((award.detail as Record<string, unknown>)["standstillDays"] as number | undefined) ??
      0;
    const standstillEndsAt =
      standstillDays > 0
        ? new Date(Date.now() + standstillDays * 86_400_000).toISOString()
        : null;

    await app.db
      .update(bidAwards)
      .set({
        status: "approved",
        approvedBy: req.user!.id,
        approvedAt: now,
        approvalAuthority: body.approvalAuthority ?? award.approvalAuthority,
        approvalReference: body.approvalReference ?? null,
        commitmentId,
        standstillEndsAt,
        detail: {
          ...(award.detail as Record<string, unknown>),
          approvalNote: body.note ?? null,
          prequalificationAtApproval: prequal.state,
          prequalificationFlagAtApproval: gate.message,
          commitmentReference: commitmentRef,
        },
        updatedAt: now,
      })
      .where(eq(bidAwards.id, award.id));

    /* ---- the package and the bidders ---- */
    await app.db
      .update(bidPackages)
      .set({
        status: "awarded",
        awardedSubmissionId: award.submissionId,
        awardedVendorId: award.vendorId,
        awardedAmount: award.awardAmount,
        awardedAt: now,
        updatedAt: now,
      })
      .where(eq(bidPackages.id, pkg.id));
    await app.db
      .update(bidSubmissions)
      .set({ status: "awarded", updatedAt: now })
      .where(eq(bidSubmissions.id, award.submissionId));
    const others = await app.db
      .select()
      .from(bidSubmissions)
      .where(eq(bidSubmissions.packageId, pkg.id));
    for (const other of others) {
      if (other.id === award.submissionId) continue;
      if (!isInContention(other.status)) continue;
      await app.db
        .update(bidSubmissions)
        .set({ status: "unsuccessful", updatedAt: now })
        .where(eq(bidSubmissions.id, other.id));
    }

    await ledger(
      app.db,
      req,
      "state_change",
      "bid_award",
      award.id,
      {
        projectId,
        packageId: pkg.id,
        reference: award.reference,
        to: "approved",
        approvedBy: req.user!.id,
        recommendedBy: award.recommendedBy,
        createdBy: award.createdBy,
        approvalAuthority: body.approvalAuthority ?? award.approvalAuthority,
        awardAmount: award.awardAmount,
        currency: award.currency,
        isLowestBid: award.isLowestBid === 1,
        lowestBidAmount: award.lowestBidAmount,
        notLowestJustification: award.notLowestJustification,
        commitmentId,
        commitmentReference: commitmentRef,
        standstillEndsAt,
      },
      projectId,
      true,
    );
    await ledger(
      app.db,
      req,
      "create",
      "bid_award",
      commitmentId,
      {
        projectId,
        event: "commitment_created_from_award",
        commitmentId,
        commitmentReference: commitmentRef,
        kind,
        vendorId: award.vendorId,
        amount: award.awardAmount,
        currency: award.currency,
        budgetLineItemId,
        awardId: award.id,
      },
      projectId,
      true,
    );

    const fresh = await fetchAward(app.db, award.id, companyId);
    return {
      ...(await awardDetail(app.db, fresh)),
      commitmentCreated: {
        id: commitmentId,
        reference: commitmentRef,
        kind,
        note:
          `Commitment ${commitmentRef} was created in the commitments module with a single ` +
          `schedule-of-values line of ${award.currency} ${award.awardAmount}. It starts in ` +
          "draft: its own approval, its compliance gates and its payments are that module's " +
          "business, not this one's.",
      },
      warnings: gate.message ? [gate.message] : [],
    };
  });

  app.post("/bid-awards/:awardId/reject", { preHandler: companyGate }, async (req, reply) => {
    const { reason } = z.object({ reason: reasonSchema }).parse(req.body);
    const { award } = await awardContext(req);
    await requireBiddingLevel(app, req, reply, award.projectId, "standard");
    if (award.status === "approved" || award.status === "executed") {
      throw conflict(`An ${award.status} award cannot be rejected — withdraw or cancel it.`);
    }
    assertSegregation(
      req.user!.id,
      { recommendedBy: award.recommendedBy },
      "award recommendation",
    );
    const now = new Date().toISOString();
    await app.db
      .update(bidAwards)
      .set({ status: "rejected", rejectedReason: reason, updatedAt: now })
      .where(eq(bidAwards.id, award.id));
    await ledger(app.db, req, "state_change", "bid_award", award.id, {
      projectId: award.projectId,
      packageId: award.packageId,
      to: "rejected",
      reason,
      rejectedBy: req.user!.id,
    }, award.projectId, true);
    return awardDetail(app.db, await fetchAward(app.db, award.id, req.companyId!));
  });

  /* ---------------------------------------------------------------- */
  /* Unsuccessful bidders + standstill                                 */
  /* ---------------------------------------------------------------- */

  /**
   * Telling the losers. The standstill clock starts HERE, not at approval:
   * a period that runs before anyone has been told is not a period in which
   * anyone can challenge.
   */
  app.post(
    "/bid-awards/:awardId/notify-unsuccessful",
    { preHandler: companyGate },
    async (req, reply) => {
      const body = z
        .object({ standstillDays: z.number().int().min(0).max(90).optional() })
        .parse(req.body ?? {});
      const { award, pkg } = await awardContext(req);
      await requireBiddingLevel(app, req, reply, award.projectId, "standard");
      if (award.status !== "approved") {
        throw conflict(
          "Unsuccessful bidders are told after the award is approved, never before. Telling " +
            "them earlier commits the buyer to a decision nobody has authorised.",
        );
      }
      if (award.unsuccessfulNotifiedAt) {
        throw conflict(`Unsuccessful bidders were already notified at ${award.unsuccessfulNotifiedAt}.`);
      }
      const now = new Date().toISOString();
      const days =
        body.standstillDays ??
        ((award.detail as Record<string, unknown>)["standstillDays"] as number | undefined) ??
        0;
      const standstillEndsAt =
        days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : award.standstillEndsAt;

      const losers = await app.db
        .select()
        .from(bidSubmissions)
        .where(
          and(
            eq(bidSubmissions.packageId, award.packageId),
            ne(bidSubmissions.id, award.submissionId),
          ),
        );
      for (const loser of losers) {
        if (loser.status === "draft" || loser.status === "withdrawn") continue;
        await app.db
          .update(bidSubmissions)
          .set({ unsuccessfulNotifiedAt: now, status: "unsuccessful", updatedAt: now })
          .where(eq(bidSubmissions.id, loser.id));
      }
      await app.db
        .update(bidAwards)
        .set({ unsuccessfulNotifiedAt: now, standstillEndsAt, updatedAt: now })
        .where(eq(bidAwards.id, award.id));

      await ledger(app.db, req, "state_change", "bid_award", award.id, {
        projectId: award.projectId,
        packageId: award.packageId,
        event: "unsuccessful_notified",
        notifiedAt: now,
        notified: losers.map((l) => ({ submissionId: l.id, vendorId: l.vendorId })),
        standstillDays: days,
        standstillEndsAt,
      }, award.projectId, true);

      const fresh = await fetchAward(app.db, award.id, req.companyId!);
      return {
        ...(await awardDetail(app.db, fresh)),
        notified: losers.length,
        note:
          days > 0
            ? `A ${days}-day standstill now runs to ${standstillEndsAt}. Nothing may be signed ` +
              `on ${pkg.reference} before it ends.`
            : "No standstill period was set. Where the procurement is subject to one, set " +
              "standstillDays — signing inside the period is what makes an award challengeable.",
      };
    },
  );

  app.post(
    "/bid-awards/:awardId/letter-of-intent",
    { preHandler: companyGate },
    async (req, reply) => {
      const body = z
        .object({
          cap: z.number().finite().min(0).nullable().optional(),
          fileId: z.string().min(1).max(64).nullable().optional(),
        })
        .parse(req.body ?? {});
      const { award } = await awardContext(req);
      await requireBiddingLevel(app, req, reply, award.projectId, "standard");
      if (award.status !== "approved") {
        throw conflict("A letter of intent follows an approved award.");
      }
      if (body.cap === null || body.cap === undefined) {
        throw badRequest(
          "A letter of intent needs a financial cap. An uncapped LOI is a contract with no " +
            "agreed price — the single most expensive document in construction.",
        );
      }
      if (body.cap > award.awardAmount) {
        throw badRequest(
          `The LOI cap (${body.cap}) exceeds the award amount (${award.awardAmount}). A letter ` +
            "of intent authorises part of the works, never more than the whole of them.",
        );
      }
      const now = new Date().toISOString();
      await app.db
        .update(bidAwards)
        .set({
          status: "letter_of_intent",
          letterOfIntentAt: now,
          letterOfIntentCap: body.cap,
          letterOfIntentFileId: body.fileId ?? null,
          updatedAt: now,
        })
        .where(eq(bidAwards.id, award.id));
      await ledger(app.db, req, "state_change", "bid_award", award.id, {
        projectId: award.projectId,
        to: "letter_of_intent",
        cap: body.cap,
        awardAmount: award.awardAmount,
      }, award.projectId, true);
      return awardDetail(app.db, await fetchAward(app.db, award.id, req.companyId!));
    },
  );

  app.post(
    "/bid-awards/:awardId/contract-issued",
    { preHandler: companyGate },
    async (req, reply) => {
      const { award } = await awardContext(req);
      await requireBiddingLevel(app, req, reply, award.projectId, "standard");
      if (award.status !== "approved" && award.status !== "letter_of_intent") {
        throw conflict(`An award at status "${award.status}" has no contract to issue.`);
      }
      const period = standstill(award);
      if (period.active) {
        throw conflict(
          `The standstill period on ${award.reference} runs to ${award.standstillEndsAt}. ` +
            "Issuing the contract inside it defeats the point of telling the unsuccessful " +
            "bidders at all: their challenge would arrive against a signed contract.",
        );
      }
      const now = new Date().toISOString();
      await app.db
        .update(bidAwards)
        .set({ status: "contract_issued", contractIssuedAt: now, updatedAt: now })
        .where(eq(bidAwards.id, award.id));
      await ledger(app.db, req, "state_change", "bid_award", award.id, {
        projectId: award.projectId,
        to: "contract_issued",
        commitmentId: award.commitmentId,
      }, award.projectId);
      return awardDetail(app.db, await fetchAward(app.db, award.id, req.companyId!));
    },
  );

  app.post("/bid-awards/:awardId/execute", { preHandler: companyGate }, async (req, reply) => {
    const { award } = await awardContext(req);
    await requireBiddingLevel(app, req, reply, award.projectId, "standard");
    if (award.status !== "contract_issued" && award.status !== "letter_of_intent") {
      throw conflict(`An award at status "${award.status}" cannot be executed.`);
    }
    const now = new Date().toISOString();
    await app.db
      .update(bidAwards)
      .set({ status: "executed", executedAt: now, updatedAt: now })
      .where(eq(bidAwards.id, award.id));
    await ledger(app.db, req, "state_change", "bid_award", award.id, {
      projectId: award.projectId,
      to: "executed",
      commitmentId: award.commitmentId,
    }, award.projectId, true);
    return awardDetail(app.db, await fetchAward(app.db, award.id, req.companyId!));
  });

  /**
   * A challenge from an unsuccessful bidder. Recorded on the award because
   * the answer to it is the record this module has been building all along:
   * the levelling, the scores, the lowest bid amount and why it was not taken.
   */
  app.post("/bid-awards/:awardId/challenge", { preHandler: companyGate }, async (req, reply) => {
    const { note } = z.object({ note: reasonSchema }).parse(req.body);
    const { award } = await awardContext(req);
    await requireBiddingLevel(app, req, reply, award.projectId, "standard");
    const now = new Date().toISOString();
    await app.db
      .update(bidAwards)
      .set({ challengeReceived: 1, challengeNote: note, updatedAt: now })
      .where(eq(bidAwards.id, award.id));
    await ledger(app.db, req, "update", "bid_award", award.id, {
      projectId: award.projectId,
      event: "challenge_received",
      note,
    }, award.projectId, true);
    return awardDetail(app.db, await fetchAward(app.db, award.id, req.companyId!));
  });

  app.post("/bid-awards/:awardId/debrief", { preHandler: companyGate }, async (req, reply) => {
    const { award } = await awardContext(req);
    await requireBiddingLevel(app, req, reply, award.projectId, "standard");
    const now = new Date().toISOString();
    await app.db
      .update(bidAwards)
      .set({ debriefProvidedAt: now, updatedAt: now })
      .where(eq(bidAwards.id, award.id));
    await ledger(app.db, req, "update", "bid_award", award.id, {
      projectId: award.projectId,
      event: "debrief_provided",
    }, award.projectId);
    return awardDetail(app.db, await fetchAward(app.db, award.id, req.companyId!));
  });
};
