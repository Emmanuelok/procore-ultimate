import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { z } from "zod";
import {
  awardDelegations,
  bidAwards,
  bidPackages,
  bidSubmissions,
  budgetLineItems,
  commitments,
  vendors,
} from "@constructos/db";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { AppError, badRequest, conflict } from "../../lib/errors.js";
import { epochMs } from "../../lib/time.js";
import type { Db } from "../../lib/db.js";
import { AWARD_DELEGATION_SUBJECTS } from "@constructos/shared";
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
import { detectApprovalBehaviour } from "./integrity.js";
import {
  INTEGRITY_ACKNOWLEDGEMENT_KEY,
  integritySignalsForPackage,
  persistIntegrityFindings,
  runPackageIntegrityAndPersist,
} from "./integrity-service.js";
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
  /**
   * REQUIRED when open bid-integrity findings of high or critical severity
   * bear on this package. Not a veto — a sentence saying what was checked and
   * what the explanation was.
   */
  integrityAcknowledgement: justificationSchema.nullable().optional(),
  /** partial award: the levelling rows this award covers */
  scopeLevellingItemIds: z.array(z.string().min(1).max(64)).max(2000).optional(),
});

const withdrawSchema = z.object({
  reason: justificationSchema,
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
/* Delegated authority (Domain A #41)                                  */
/* ------------------------------------------------------------------ */

export interface AuthorityCheck {
  permitted: boolean;
  /** the delegation that permitted it, in words, for the approval record */
  authority: string | null;
  basis: string;
  limit: number | null;
  currency: string | null;
  message: string;
}

/**
 * AN APPROVAL LIMIT IS ONLY A CONTROL IF THE PLATFORM REFUSES THE APPROVAL
 * THAT EXCEEDS IT.
 *
 * Delegations are recorded per company against a named person or a company
 * role, per currency, optionally narrowed to one project or one package
 * kind. The rule is deliberately permissive where nothing has been recorded:
 * a company that has not written its scheme of delegation down is not told
 * that nobody may approve anything — it is told, on the approval record, that
 * no limit was found. Silence is reported, never invented.
 */
export async function checkAwardAuthority(
  db: Db,
  input: {
    companyId: string;
    projectId: string;
    userId: string;
    role: string | null;
    amount: number;
    currency: string;
    packageKind: string;
  },
  asOf: string = new Date().toISOString().slice(0, 10),
): Promise<AuthorityCheck> {
  const rows = await db
    .select()
    .from(awardDelegations)
    .where(
      and(
        eq(awardDelegations.companyId, input.companyId),
        eq(awardDelegations.isActive, 1),
        or(
          and(
            eq(awardDelegations.subjectKind, "user"),
            eq(awardDelegations.subjectId, input.userId),
          ),
          input.role
            ? and(
                eq(awardDelegations.subjectKind, "company_role"),
                eq(awardDelegations.subjectId, input.role),
              )
            : undefined,
        ),
      ),
    );
  const applicable = rows.filter(
    (d) =>
      d.currency.toUpperCase() === input.currency.toUpperCase() &&
      (d.projectId === null || d.projectId === input.projectId) &&
      (d.packageKind === null || d.packageKind === input.packageKind) &&
      (d.validFrom === null || d.validFrom <= asOf) &&
      (d.validTo === null || d.validTo >= asOf),
  );
  if (applicable.length === 0) {
    const wrongCurrency = rows.filter(
      (d) => d.currency.toUpperCase() !== input.currency.toUpperCase(),
    );
    return {
      permitted: true,
      authority: null,
      limit: null,
      currency: null,
      basis:
        "No delegated award authority is recorded for this approver" +
        (wrongCurrency.length > 0
          ? ` in ${input.currency} (their limits are stated in ` +
            `${[...new Set(wrongCurrency.map((d) => d.currency))].join(", ")}, and limits in ` +
            "different currencies are never converted here)"
          : "") +
        ". The approval proceeds and this absence is recorded on it: a scheme of delegation " +
        "the platform does not hold cannot be enforced by the platform, and pretending " +
        "otherwise would be worse than saying so.",
      message: "No delegated authority limit is on record for this approver.",
    };
  }
  const best = applicable.reduce((a, b) => (b.maxAwardAmount > a.maxAwardAmount ? b : a));
  if (input.amount > best.maxAwardAmount) {
    return {
      permitted: false,
      authority: best.label ?? best.id,
      limit: best.maxAwardAmount,
      currency: best.currency,
      basis: best.basis ?? "",
      message:
        `This award is ${input.currency} ${input.amount} and the delegated authority held by ` +
        `this approver is ${best.currency} ${best.maxAwardAmount}` +
        (best.label ? ` (${best.label})` : "") +
        ". Approving above your own limit is the control failure a scheme of delegation exists " +
        "to prevent, and it is the finding an auditor writes up first. Route it to somebody " +
        "who holds the authority, or record a higher delegation with the basis for it.",
    };
  }
  return {
    permitted: true,
    authority: best.label ?? `Delegation ${best.id}`,
    limit: best.maxAwardAmount,
    currency: best.currency,
    basis:
      best.basis ??
      `Within the delegated authority of ${best.currency} ${best.maxAwardAmount} held by this ` +
        "approver.",
    message: `Within a delegated authority of ${best.currency} ${best.maxAwardAmount}.`,
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
        /** the AS-BID contract sum — what the commitment will be raised for */
        asBidContractSum: award.awardAmount,
        /** the figure the comparison was actually made on */
        recommendedComparableAmount:
          award.recommendedComparableAmount ??
          ((award.detail as Record<string, unknown>)["recommendedComparableAmount"] as
            | number
            | undefined) ??
          null,
        lowestBidAmount: award.lowestBidAmount,
        comparableAmountsNote:
          (award.comparisonBasis ??
            (award.detail as Record<string, unknown>)["comparisonBasis"]) === "levelled"
            ? "The recommended and lowest amounts below are LEVELLED figures. The award amount " +
              "is the as-bid contract sum, which is a different number and is what the " +
              "commitment is raised for."
            : "This package was not levelled, so the compared amounts are as-bid totals — the " +
              "cheapest of which frequently belongs to whoever read the scope least carefully.",
        notLowestJustification: award.notLowestJustification,
        comparisonBasis:
          award.comparisonBasis ??
          (award.detail as Record<string, unknown>)["comparisonBasis"] ??
          null,
        integrityAcknowledgement:
          (award.detail as Record<string, unknown>)[INTEGRITY_ACKNOWLEDGEMENT_KEY] ?? null,
        approvalAuthorityBasis:
          (award.detail as Record<string, unknown>)["approvalAuthorityBasis"] ?? null,
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

      /*
       * THE INTEGRITY FINDINGS ARE PUT IN FRONT OF THE RECOMMENDER.
       *
       * Detectors that nobody reads are decoration. The run happens here, at
       * the moment somebody is about to choose a winner, and an open finding
       * of high or critical severity must be ACKNOWLEDGED in writing before
       * the recommendation is accepted — the same discipline as the
       * not-lowest justification, and for the same reason: the control that
       * makes somebody write a sentence is the one that leaves a record.
       */
      const integrityReport = await runPackageIntegrityAndPersist(app.db, pkg, req.user!.id);
      const integritySignals = await integritySignalsForPackage(app.db, companyId, packageId);
      const open = integritySignals.filter(
        (sig) =>
          sig.disposition !== "dismissed" &&
          sig.disposition !== "closed" &&
          sig.closedAt === null,
      );

      /*
       * AN ABNORMALLY LOW BID CANNOT BE RECOMMENDED UNTIL IT HAS EXPLAINED
       * ITSELF. Public procurement everywhere requires the buyer to ASK, and
       * the asking is worthless unless the answer is on the record. The
       * explanation is recorded through the compliance route, which puts it
       * on the submission where the evaluation can see it.
       */
      const lowAssessment = integrityReport.abnormal.assessments.find(
        (a) => a.submissionId === chosen.id && a.verdict === "abnormally_low",
      );
      if (lowAssessment?.requiresJustification) {
        throw badRequest(
          `${chosen.reference} is ${lowAssessment.deviationFromMedianPercent ?? lowAssessment.deviationFromEstimatePercent}% ` +
            "below the field and no price explanation is on the record. An abnormally low tender " +
            "accepted without asking the bidder to explain it is the one that returns as a claim, " +
            "a variation account or an insolvency — and by then the second-lowest price is no " +
            "longer available. Record the explanation with POST " +
            "/bid-submissions/:id/compliance (abnormalLowJustification) and recommend again.",
          {
            control: "abnormally_low_requires_justification",
            submissionId: chosen.id,
            deviationFromMedianPercent: lowAssessment.deviationFromMedianPercent,
            deviationFromEstimatePercent: lowAssessment.deviationFromEstimatePercent,
          },
        );
      }

      /*
       * Everything else of high or critical severity must be ACKNOWLEDGED in
       * writing — the same discipline as the not-lowest justification. A
       * price-level finding about a bid nobody is recommending is not a
       * blocker: it is information about the field, and blocking on it would
       * teach people to dismiss findings to get their work done.
       */
      const blocking = open.filter(
        (sig) =>
          (sig.severity === "critical" || sig.severity === "high") &&
          !(
            (sig.detector === "bid_integrity_abnormally_low" ||
              sig.detector === "bid_integrity_abnormally_high") &&
            sig.subjectId !== chosen.id
          ),
      );
      if (blocking.length > 0 && !body.integrityAcknowledgement) {
        throw badRequest(
          `${blocking.length} open bid-integrity finding(s) bear on ${pkg.reference} and must be ` +
            "acknowledged before a bidder is recommended: " +
            blocking.map((sig) => `${sig.detector} — ${sig.title}`).join("; ") +
            ". A finding is a question rather than an accusation, and the ordinary answer is an " +
            "innocent explanation — but the explanation has to exist somewhere, and afterwards " +
            "is too late. Supply integrityAcknowledgement saying what was checked and what was " +
            "found.",
          {
            control: "integrity_findings_require_acknowledgement",
            signalIds: blocking.map((sig) => sig.id),
            detectors: blocking.map((sig) => sig.detector),
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
        /*
         * `awardAmount` is the AS-BID contract sum; `lowestBidAmount` is the
         * LEVELLED figure wherever the package was levelled. Showing them side
         * by side as if they were comparable let a levelled-lowest bid display
         * a recommended amount above the "lowest bid amount" while asserting
         * that it was the lowest. The comparable figure is now a column of its
         * own, and the basis both are on is stated next to them.
         */
        recommendedComparableAmount: chosenCandidate.comparableAmount,
        comparisonBasis: comparison.basis,
        scopeLevellingItemIds: body.scopeLevellingItemIds ?? [],
        savingAgainstEstimate: saving,
        recommendedBy: req.user!.id,
        recommendedAt: now,
        approvalAuthority: body.approvalAuthority ?? null,
        standstillEndsAt: null,
        detail: {
          comparisonBasis: comparison.basis,
          comparisonBasisNote: comparison.basisNote,
          lowestBidSubmissionId: comparison.lowest.submissionId,
          [INTEGRITY_ACKNOWLEDGEMENT_KEY]: body.integrityAcknowledgement ?? null,
          integritySignalIds: blocking.map((sig) => sig.id),
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

    /* ---- delegated authority: the approver's own limit ---- */
    const authority = await checkAwardAuthority(app.db, {
      companyId,
      projectId,
      userId: req.user!.id,
      role: req.companyRole ?? null,
      amount: award.awardAmount,
      currency: award.currency,
      packageKind: pkg.packageKind,
    });
    if (!authority.permitted) {
      throw new AppError(403, authority.message, {
        control: "delegated_authority",
        limit: authority.limit,
        currency: authority.currency,
        awardAmount: award.awardAmount,
      });
    }

    /*
     * THE BUDGET LINE IS RESOLVED AND CHECKED BEFORE ANYTHING IS WRITTEN.
     *
     * `insertSovLine` throws when the budget line is not on this project, and
     * it used to throw AFTER the commitment row had been inserted — leaving a
     * draft commitment with no schedule of values, an award still at
     * "recommended", a package not marked awarded, and a retry that created a
     * second commitment. `bid_packages.budgetLineItemIds` accepts arbitrary
     * strings, so this was reachable from ordinary data entry.
     */
    const budgetLineItemId =
      body.budgetLineItemId ?? ((pkg.budgetLineItemIds as string[])[0] ?? null);
    if (budgetLineItemId) {
      const [line] = await app.db
        .select({ id: budgetLineItems.id })
        .from(budgetLineItems)
        .where(
          and(
            eq(budgetLineItems.id, budgetLineItemId),
            eq(budgetLineItems.companyId, companyId),
            eq(budgetLineItems.projectId, projectId),
          ),
        )
        .limit(1);
      if (!line) {
        throw badRequest(
          `Budget line ${budgetLineItemId} is not a budget line on this project, so the ` +
            "committed cost has nowhere to land. Correct the package's budgetLineItemIds (or " +
            "pass budgetLineItemId on this approval) before approving: an award that cannot be " +
            "charged anywhere is an award nobody has funded.",
          { control: "budget_line_not_on_project", budgetLineItemId },
        );
      }
    }

    const kind = pkg.packageKind === "supply_only" ? "purchase_order" : "subcontract";
    const standstillDays =
      body.standstillDays ??
      ((award.detail as Record<string, unknown>)["standstillDays"] as number | undefined) ??
      0;
    const standstillEndsAt =
      standstillDays > 0
        ? new Date(Date.now() + standstillDays * 86_400_000).toISOString()
        : null;

    /*
     * ONE TRANSACTION, AND THE STATUS CHECK IS IN THE STATEMENT.
     *
     * Approval creates a commitment, a schedule-of-values line, two rollups,
     * an award update, a package update and a status change on every other
     * bid. Done outside a transaction, a failure anywhere after the first
     * insert left an orphan commitment and an award that still looked
     * approvable — and two concurrent approvals both passed the read-then-
     * check and each created a commitment, double-committing the budget. The
     * conditional UPDATE is the lock: exactly one request can move the award
     * out of "recommended".
     */
    const commitmentId = newId("cmt");
    let commitmentRef = "";
    await app.db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      const claimed = await db
        .update(bidAwards)
        .set({
          status: "approved",
          approvedBy: req.user!.id,
          approvedAt: now,
          approvalAuthority:
            body.approvalAuthority ?? authority.authority ?? award.approvalAuthority,
          approvalReference: body.approvalReference ?? null,
          commitmentId,
          standstillEndsAt,
          detail: {
            ...(award.detail as Record<string, unknown>),
            approvalNote: body.note ?? null,
            prequalificationAtApproval: prequal.state,
            prequalificationFlagAtApproval: gate.message,
            approvalAuthorityBasis: authority.basis,
          },
          updatedAt: now,
        })
        .where(
          and(
            eq(bidAwards.id, award.id),
            inArray(bidAwards.status, ["recommended", "pending_approval"]),
            isNull(bidAwards.approvedBy),
          ),
        )
        .returning({ id: bidAwards.id });
      if (claimed.length === 0) {
        throw conflict(
          `${award.reference} was approved by another request while this one was in flight. ` +
            "One approval creates one commitment; a second would double-commit the budget.",
        );
      }

      const commitmentNumber = await nextRecordNumber(db, projectId, "commitment");
      commitmentRef = commitmentReference(kind, commitmentNumber);
      await db.insert(commitments).values({
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

      const ctx = await sovContext(db, companyId, projectId, {
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
      await recomputeCommitmentTotals(db, commitmentId);
      const budgetLines = await budgetLineIdsFor(db, commitmentId);
      if (budgetLines.length > 0) {
        await syncBudgetCommitted(db, companyId, projectId, budgetLines);
      }
      await db
        .update(bidAwards)
        .set({
          detail: {
            ...(award.detail as Record<string, unknown>),
            approvalNote: body.note ?? null,
            prequalificationAtApproval: prequal.state,
            prequalificationFlagAtApproval: gate.message,
            approvalAuthorityBasis: authority.basis,
            commitmentReference: commitmentRef,
          },
        })
        .where(eq(bidAwards.id, award.id));

      /* ---- the package and the bidders ---- */
      await db
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
      await db
        .update(bidSubmissions)
        .set({ status: "awarded", updatedAt: now })
        .where(eq(bidSubmissions.id, award.submissionId));
      const others = await db
        .select()
        .from(bidSubmissions)
        .where(eq(bidSubmissions.packageId, pkg.id));
      for (const other of others) {
        if (other.id === award.submissionId) continue;
        if (!isInContention(other.status)) continue;
        await db
          .update(bidSubmissions)
          .set({ status: "unsuccessful", updatedAt: now })
          .where(eq(bidSubmissions.id, other.id));
      }
    });

    /*
     * Approval behaviour is examined AFTER the money is safely committed: a
     * detector must never be able to fail an award. Velocity and out-of-hours
     * findings are signals for somebody to look at, not gates.
     */
    const behaviour = detectApprovalBehaviour({
      awardId: award.id,
      reference: award.reference,
      packageId: pkg.id,
      projectId,
      vendorId: award.vendorId,
      awardAmount: award.awardAmount,
      currency: award.currency,
      recommendedAt: award.recommendedAt,
      approvedAt: now,
      approvedBy: req.user!.id,
    });
    if (behaviour.length > 0) {
      await persistIntegrityFindings(app.db, companyId, projectId, req.user!.id, behaviour);
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

  /* ---------------------------------------------------------------- */
  /* Unwinding an award                                                */
  /* ---------------------------------------------------------------- */

  /**
   * WITHDRAWING AN APPROVED AWARD.
   *
   * Awards get unwound: the winner goes into administration, the funding
   * falls through, the challenge succeeds. The unwind has to put the package
   * back into a state that can be recommended again WITHOUT pretending the
   * first decision never happened — so the commitment is voided rather than
   * deleted, the losing bids are restored to contention, and the whole thing
   * is one transaction with a written reason. The person unwinding may not be
   * the person who approved: an approver who can quietly reverse their own
   * award has no approval control at all.
   */
  app.post("/bid-awards/:awardId/withdraw", { preHandler: companyGate }, async (req, reply) => {
    const body = withdrawSchema.parse(req.body);
    const { award, pkg } = await awardContext(req);
    await requireBiddingLevel(app, req, reply, award.projectId, "standard");
    if (!["approved", "letter_of_intent", "recommended", "pending_approval"].includes(award.status)) {
      throw conflict(
        `An award at status "${award.status}" cannot be withdrawn. A contract that has been ` +
          "issued or executed is unwound through the commitment and the contract, not by " +
          "editing the procurement record that preceded them.",
      );
    }
    assertSegregation(req.user!.id, { recommendedBy: award.recommendedBy }, "award");
    const now = new Date().toISOString();
    const restored: string[] = [];
    await app.db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      const claimed = await db
        .update(bidAwards)
        .set({
          status: "withdrawn",
          withdrawnAt: now,
          withdrawnBy: req.user!.id,
          withdrawnReason: body.reason,
          updatedAt: now,
        })
        .where(and(eq(bidAwards.id, award.id), eq(bidAwards.status, award.status)))
        .returning({ id: bidAwards.id });
      if (claimed.length === 0) {
        throw conflict("This award changed status while the withdrawal was in flight.");
      }
      if (award.commitmentId) {
        await db
          .update(commitments)
          .set({
            status: "void",
            updatedAt: now,
            detail: {
              sourceBidAwardId: award.id,
              voidedBecause: `Bid award ${award.reference} was withdrawn: ${body.reason}`,
              voidedAt: now,
            },
          })
          .where(
            and(
              eq(commitments.id, award.commitmentId),
              eq(commitments.companyId, award.companyId),
              eq(commitments.status, "draft"),
            ),
          );
      }
      // Every bid the award knocked out comes back into contention: the
      // package is live again and they are entitled to be considered.
      const subs = await db
        .select()
        .from(bidSubmissions)
        .where(eq(bidSubmissions.packageId, award.packageId));
      for (const sub of subs) {
        if (sub.status !== "unsuccessful" && sub.status !== "awarded") continue;
        if (sub.supersededById) continue;
        await db
          .update(bidSubmissions)
          .set({ status: "under_review", updatedAt: now })
          .where(eq(bidSubmissions.id, sub.id));
        restored.push(sub.id);
      }
      await db
        .update(bidPackages)
        .set({
          status: "under_evaluation",
          awardedSubmissionId: null,
          awardedVendorId: null,
          awardedAmount: null,
          awardedAt: null,
          updatedAt: now,
        })
        .where(eq(bidPackages.id, award.packageId));
    });

    await ledger(
      app.db,
      req,
      "state_change",
      "bid_award",
      award.id,
      {
        projectId: award.projectId,
        packageId: award.packageId,
        packageReference: pkg.reference,
        to: "withdrawn",
        from: award.status,
        reason: body.reason,
        withdrawnBy: req.user!.id,
        approvedBy: award.approvedBy,
        commitmentId: award.commitmentId,
        commitmentVoided: Boolean(award.commitmentId),
        restoredSubmissionIds: restored,
        awardAmount: award.awardAmount,
        currency: award.currency,
      },
      award.projectId,
      true,
    );
    return {
      ...(await awardDetail(app.db, await fetchAward(app.db, award.id, req.companyId!))),
      restored: restored.length,
      note:
        `${award.reference} is withdrawn. ` +
        (award.commitmentId
          ? `Commitment ${award.commitmentId} was voided — a draft commitment raised for an ` +
            "award that no longer exists would otherwise sit in the budget as committed cost " +
            "against nothing. "
          : "") +
        `${restored.length} bid(s) are back in contention and ${pkg.reference} can be ` +
        "recommended again. The withdrawn award stays on the record with its reason: the " +
        "history of a procurement includes the decisions that were reversed.",
    };
  });

  /* ---------------------------------------------------------------- */
  /* Delegated award authority (Domain A #41)                          */
  /* ---------------------------------------------------------------- */

  app.get(
    "/companies/current/award-delegations",
    { preHandler: [app.authenticate, app.requireCompany] },
    async (req) => {
      const rows = await app.db
        .select()
        .from(awardDelegations)
        .where(eq(awardDelegations.companyId, req.companyId!))
        .orderBy(desc(awardDelegations.maxAwardAmount));
      return {
        items: rows.map((r) => ({ ...r, isActive: r.isActive === 1 })),
        total: rows.length,
        note:
          rows.length === 0
            ? "No scheme of delegation is recorded. Awards are approved by anyone who is not " +
              "the recommender, and the absence of a limit is stated on each approval rather " +
              "than a limit being invented. Recording the scheme here makes it enforceable."
            : "An approval above the approver's own limit is refused, and the limit that " +
              "permitted an approval is written onto the award.",
      };
    },
  );

  app.post(
    "/companies/current/award-delegations",
    {
      preHandler: [
        app.authenticate,
        app.requireCompany,
        app.requireCompanyRole(["owner", "admin"]),
      ],
    },
    async (req, reply) => {
      const body = z
        .object({
          subjectKind: z.enum(AWARD_DELEGATION_SUBJECTS).default("user"),
          subjectId: z.string().min(1).max(64),
          label: z.string().max(200).nullable().optional(),
          maxAwardAmount: z.number().finite().min(0),
          currency: z.string().min(3).max(8).transform((c) => c.toUpperCase()),
          projectId: z.string().min(1).max(64).nullable().optional(),
          packageKind: z.string().max(60).nullable().optional(),
          validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
          validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
          basis: z.string().max(4000).nullable().optional(),
        })
        .parse(req.body);
      const id = newId("awd");
      await app.db.insert(awardDelegations).values({
        id,
        companyId: req.companyId!,
        subjectKind: body.subjectKind,
        subjectId: body.subjectId,
        label: body.label ?? null,
        maxAwardAmount: body.maxAwardAmount,
        currency: body.currency,
        projectId: body.projectId ?? null,
        packageKind: body.packageKind ?? null,
        validFrom: body.validFrom ?? null,
        validTo: body.validTo ?? null,
        basis: body.basis ?? null,
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "award_delegation",
        objectId: id,
        payload: {
          subjectKind: body.subjectKind,
          subjectId: body.subjectId,
          maxAwardAmount: body.maxAwardAmount,
          currency: body.currency,
          projectId: body.projectId ?? null,
        },
        storePayload: true,
      });
      const [created] = await app.db
        .select()
        .from(awardDelegations)
        .where(eq(awardDelegations.id, id))
        .limit(1);
      return reply.status(201).send(created);
    },
  );

  app.patch(
    "/companies/current/award-delegations/:delegationId",
    {
      preHandler: [
        app.authenticate,
        app.requireCompany,
        app.requireCompanyRole(["owner", "admin"]),
      ],
    },
    async (req) => {
      const { delegationId } = req.params as { delegationId: string };
      const body = z
        .object({
          maxAwardAmount: z.number().finite().min(0).optional(),
          isActive: z.boolean().optional(),
          validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
          basis: z.string().max(4000).nullable().optional(),
          label: z.string().max(200).nullable().optional(),
        })
        .parse(req.body);
      const [existing] = await app.db
        .select()
        .from(awardDelegations)
        .where(
          and(
            eq(awardDelegations.id, delegationId),
            eq(awardDelegations.companyId, req.companyId!),
          ),
        )
        .limit(1);
      if (!existing) throw badRequest("That delegation is not in this company.");
      await app.db
        .update(awardDelegations)
        .set({
          ...(body.maxAwardAmount !== undefined ? { maxAwardAmount: body.maxAwardAmount } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive ? 1 : 0 } : {}),
          ...(body.validTo !== undefined ? { validTo: body.validTo } : {}),
          ...(body.basis !== undefined ? { basis: body.basis } : {}),
          ...(body.label !== undefined ? { label: body.label } : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(awardDelegations.id, delegationId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "award_delegation",
        objectId: delegationId,
        payload: { changed: Object.keys(body), previous: existing.maxAwardAmount },
        storePayload: true,
      });
      const [updated] = await app.db
        .select()
        .from(awardDelegations)
        .where(eq(awardDelegations.id, delegationId))
        .limit(1);
      return updated;
    },
  );

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
