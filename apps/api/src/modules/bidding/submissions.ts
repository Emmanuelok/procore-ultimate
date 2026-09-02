import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  bidInvitations,
  bidPackages,
  bidSubmissionLines,
  bidSubmissions,
  insuranceCertificates,
  vendors,
} from "@constructos/db";
import { BID_COMPLIANCE_STATUSES, BID_SUBMISSION_STATUSES, BOND_TYPES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { badRequest, conflict } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import type { Db } from "../../lib/db.js";
import {
  assertVendor,
  CENT,
  currencySchema,
  detailSchema,
  fetchInvitation,
  fetchPackage,
  fetchSubmission,
  isInContention,
  isoDateSchema,
  isoTimestampSchema,
  justificationSchema,
  ledger,
  moneySchema,
  nonNegativeMoneySchema,
  percentSchema,
  reasonSchema,
  requireBiddingLevel,
  round2,
  todayIso,
  type BidInvitationRow,
  type BidPackageRow,
  type BidSubmissionRow,
} from "./shared.js";
import { addendaOf } from "./packages.js";
import { computeLateness, redactSubmission, sealState } from "./sealing.js";
import { effectiveLimit, evaluatePrequalGate, vendorPrequalStatus } from "./prequal-status.js";
import { checkContractAgainstLimit } from "./financial-limits.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const lineSchema = z.object({
  itemCode: z.string().max(60).nullable().optional(),
  description: z.string().trim().min(1).max(2000),
  specSectionCode: z.string().max(60).nullable().optional(),
  unit: z.string().max(30).nullable().optional(),
  quantity: z.number().finite().nullable().optional(),
  unitRate: z.number().finite().nullable().optional(),
  amount: moneySchema.nullable().optional(),
  currency: currencySchema.optional(),
  isProvisionalSum: z.boolean().optional(),
  isAllowance: z.boolean().optional(),
  isAlternate: z.boolean().optional(),
  alternateLabel: z.string().max(200).nullable().optional(),
  isExcluded: z.boolean().optional(),
  inclusionNote: z.string().max(4000).nullable().optional(),
  levellingItemId: z.string().min(1).max(64).nullable().optional(),
  costCodeId: z.string().min(1).max(64).nullable().optional(),
  budgetLineItemId: z.string().min(1).max(64).nullable().optional(),
  position: z.number().int().min(0).max(100000).optional(),
  detail: detailSchema.optional(),
});

const alternateSchema = z.object({
  label: z.string().trim().min(1).max(200),
  description: z.string().max(4000).nullable().optional(),
  amount: moneySchema,
  /** an alternate the buyer has not accepted is NOT in the compared price */
  accepted: z.boolean().default(false),
});

const bondOfferSchema = z.object({
  bondType: z.enum(BOND_TYPES),
  offered: z.boolean().default(true),
  provider: z.string().max(200).nullable().optional(),
  percent: percentSchema.nullable().optional(),
  amount: nonNegativeMoneySchema.nullable().optional(),
  cost: nonNegativeMoneySchema.nullable().optional(),
});

const valueEngineeringSchema = z.object({
  description: z.string().trim().min(1).max(4000),
  saving: moneySchema.nullable().optional(),
  risk: z.string().max(4000).nullable().optional(),
});

const submissionCreateSchema = z.object({
  vendorId: z.string().min(1).max(64),
  invitationId: z.string().min(1).max(64).nullable().optional(),
  reference: z.string().trim().min(1).max(120).optional(),
  /** when the bid actually arrived — this, not "now", decides lateness */
  receivedAt: isoTimestampSchema.optional(),
  submittedAt: isoTimestampSchema.nullable().optional(),
  status: z.enum(["draft", "submitted"]).default("submitted"),
  baseBidAmount: moneySchema.nullable().optional(),
  allowancesTotal: moneySchema.nullable().optional(),
  provisionalSumsTotal: moneySchema.nullable().optional(),
  currency: currencySchema.optional(),
  alternates: z.array(alternateSchema).max(100).optional(),
  valueEngineering: z.array(valueEngineeringSchema).max(100).optional(),
  exclusions: z.string().max(20000).nullable().optional(),
  qualifications: z.string().max(20000).nullable().optional(),
  assumptions: z.string().max(20000).nullable().optional(),
  clarificationsRequested: z.string().max(20000).nullable().optional(),
  proposedProgrammeWeeks: z.number().finite().min(0).nullable().optional(),
  proposedStartDate: isoDateSchema.nullable().optional(),
  proposedCompletionDate: isoDateSchema.nullable().optional(),
  validUntil: isoDateSchema.nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
  retentionPercent: percentSchema.nullable().optional(),
  bondsOffered: z.array(bondOfferSchema).max(20).optional(),
  insuranceCertificateIds: z.array(z.string().min(1).max(64)).max(50).optional(),
  addendaAcknowledged: z.array(z.string().min(1).max(60)).max(100).optional(),
  attachmentFileIds: z.array(z.string().min(1).max(64)).max(200).optional(),
  /** the sealed envelope, content-addressed at the moment of receipt */
  sealedFileId: z.string().min(1).max(64).nullable().optional(),
  sealedSha256: z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase sha256 hex digest").nullable().optional(),
  lines: z.array(lineSchema).max(2000).optional(),
  /** required when receivedAt is backdated by more than a week */
  backdateReason: reasonSchema.optional(),
  detail: detailSchema.optional(),
});

/**
 * A package can take bids only once it has been ISSUED. See the create route
 * for why: the evaluation basis, and with it the seal, is frozen at issue.
 */
export const ISSUED_FOR_BIDS = [
  "invitations_sent",
  "open",
  "closed",
  "under_evaluation",
  "levelled",
  "partially_awarded",
];

const submissionsListQuery = pageQuerySchema.extend({
  status: z.enum(BID_SUBMISSION_STATUSES).optional(),
  vendorId: z.string().min(1).max(64).optional(),
});

const lateAcceptSchema = z.object({
  /** why this late bid is being let in — the whole audit answer */
  reason: justificationSchema,
});

const complianceSchema = z.object({
  complianceStatus: z.enum(BID_COMPLIANCE_STATUSES),
  note: z.string().max(8000).nullable().optional(),
  /**
   * The bidder's written explanation of an abnormally low price. Recording it
   * is what unblocks an abnormally low tender for recommendation: public
   * procurement everywhere requires the buyer to ASK before accepting one,
   * and the asking is worthless if the answer is not on the record.
   */
  abnormalLowJustification: justificationSchema.nullable().optional(),
});

/**
 * Statuses from which a clarification may be requested or answered. An
 * awarded, unsuccessful or withdrawn bid is OUT, and a clarification must
 * never quietly put it back in contention.
 */
const CLARIFIABLE_STATUSES = [
  "received",
  "opened",
  "under_review",
  "clarification_requested",
  "clarified",
  "shortlisted",
];

/* ------------------------------------------------------------------ */
/* Arithmetic                                                          */
/* ------------------------------------------------------------------ */

export interface SubmissionTotals {
  baseBidAmount: number | null;
  alternatesTotal: number;
  allowancesTotal: number | null;
  provisionalSumsTotal: number | null;
  totalAmount: number | null;
  notes: string[];
}

/**
 * Resolve a bid's headline figures from what the bidder actually gave us.
 *
 * TWO RULES DO ALL THE WORK HERE:
 *
 *  1. ALLOWANCES AND PROVISIONAL SUMS ARE INSIDE THE BASE BID. They are
 *     recorded so levelling can see them, never added on top — adding them
 *     again is the commonest way a bid tab overstates a tender by exactly the
 *     amount of its provisional sums.
 *  2. AN UNACCEPTED ALTERNATE IS NOT IN THE PRICE. `totalAmount` is the base
 *     bid plus the alternates the buyer has ACCEPTED, so the compared number
 *     always describes the same scope.
 *
 * Where the lines and the headline figure disagree by more than a cent, the
 * disagreement is refused rather than resolved. It is the interesting fact.
 */
export function resolveSubmissionTotals(input: {
  baseBidAmount: number | null;
  allowancesTotal: number | null;
  provisionalSumsTotal: number | null;
  alternates: { amount: number; accepted: boolean }[];
  lines: { amount: number | null; isAlternate: boolean; isAllowance: boolean; isProvisionalSum: boolean }[];
}): SubmissionTotals {
  const notes: string[] = [];
  const hasLines = input.lines.length > 0;
  const sumOf = (pick: (l: (typeof input.lines)[number]) => boolean): number =>
    round2(input.lines.filter(pick).reduce((s, l) => s + (l.amount ?? 0), 0));

  let base = input.baseBidAmount;
  if (hasLines) {
    const lineBase = sumOf((l) => !l.isAlternate);
    if (base === null) {
      base = lineBase;
      /*
       * COUNTS, NEVER AMOUNTS. This note is persisted on the submission and
       * comes back on every read path; a figure written into it walks
       * straight through the seal, because redaction nulls the money COLUMNS
       * and cannot read prose. The rule is absolute: nothing in this module
       * puts a price into a sentence that is stored.
       */
      notes.push(
        `Base bid taken as the sum of the ${input.lines.filter((l) => !l.isAlternate).length} ` +
          "non-alternate priced line(s).",
      );
    } else if (Math.abs(base - lineBase) > CENT) {
      throw badRequest(
        `The stated base bid (${base}) does not equal the sum of the priced lines (${lineBase}). ` +
          "That disagreement is the interesting fact, not a rounding problem — correct the " +
          "lines or the headline before the bid enters the comparison.",
      );
    }
  }

  let allowances = input.allowancesTotal;
  if (hasLines) {
    const lineAllowances = sumOf((l) => l.isAllowance && !l.isAlternate);
    if (allowances === null) allowances = lineAllowances;
    else if (Math.abs(allowances - lineAllowances) > CENT) {
      throw badRequest(
        `The stated allowances total (${allowances}) does not equal the sum of the lines flagged ` +
          `as allowances (${lineAllowances}).`,
      );
    }
  }

  let provisional = input.provisionalSumsTotal;
  if (hasLines) {
    const linePs = sumOf((l) => l.isProvisionalSum && !l.isAlternate);
    if (provisional === null) provisional = linePs;
    else if (Math.abs(provisional - linePs) > CENT) {
      throw badRequest(
        `The stated provisional sums total (${provisional}) does not equal the sum of the lines ` +
          `flagged as provisional sums (${linePs}).`,
      );
    }
  }

  const accepted = input.alternates.filter((a) => a.accepted);
  const alternatesTotal = round2(accepted.reduce((s, a) => s + a.amount, 0));
  if (input.alternates.length > accepted.length) {
    notes.push(
      `${input.alternates.length - accepted.length} alternate(s) were offered but not accepted, ` +
        "so they are recorded and excluded from the compared total.",
    );
  }
  if (allowances !== null || provisional !== null) {
    notes.push(
      "Allowances and provisional sums are components of the base bid and are NOT added to it — " +
        "adding them again would overstate the tender by exactly their value.",
    );
  }

  return {
    baseBidAmount: base === null ? null : round2(base),
    alternatesTotal,
    allowancesTotal: allowances === null ? null : round2(allowances),
    provisionalSumsTotal: provisional === null ? null : round2(provisional),
    totalAmount: base === null ? null : round2(base + alternatesTotal),
    notes,
  };
}

/** amount ?? quantity x rate, refusing a third figure that disagrees. */
export function resolveLineAmount(line: {
  amount?: number | null;
  quantity?: number | null;
  unitRate?: number | null;
  description: string;
}): number | null {
  const measured =
    line.quantity !== null && line.quantity !== undefined &&
    line.unitRate !== null && line.unitRate !== undefined
      ? round2(line.quantity * line.unitRate)
      : null;
  if (line.amount === null || line.amount === undefined) return measured;
  if (measured !== null && Math.abs(measured - line.amount) > CENT) {
    throw badRequest(
      `Line "${line.description}": quantity x rate is ${measured} but the amount given is ` +
        `${line.amount}. A measured line's amount IS quantity x rate; a third figure that ` +
        "disagrees is refused rather than silently accepted.",
    );
  }
  return round2(line.amount);
}

/* ------------------------------------------------------------------ */
/* Compliance report (READS insurance; never re-implements it)         */
/* ------------------------------------------------------------------ */

export interface ComplianceFinding {
  requirement: string;
  satisfied: boolean;
  detail: string;
}

export async function complianceReport(
  db: Db,
  pkg: BidPackageRow,
  submission: BidSubmissionRow,
): Promise<{ findings: ComplianceFinding[]; satisfied: boolean }> {
  const findings: ComplianceFinding[] = [];
  const asOf = todayIso();

  /* bonds */
  const offered = (submission.bondsOffered as { bondType?: string; offered?: boolean }[]) ?? [];
  for (const req of (pkg.requiredBonds as { bondType?: string; required?: boolean }[]) ?? []) {
    if (req.required === false) continue;
    const match = offered.find((o) => o.bondType === req.bondType && o.offered !== false);
    findings.push({
      requirement: `${req.bondType} bond`,
      satisfied: Boolean(match),
      detail: match
        ? `Offered by the bidder.`
        : `Required by this package and not offered. A bid without the security the tender asked ` +
          `for is priced on different terms from one that carries it.`,
    });
  }

  /* insurance — the certificates live in the insurance module and are READ here */
  const certIds = (submission.insuranceCertificateIds as string[]) ?? [];
  const certs = certIds.length
    ? await db
        .select()
        .from(insuranceCertificates)
        .where(
          and(
            eq(insuranceCertificates.companyId, pkg.companyId),
            inArray(insuranceCertificates.id, certIds),
          ),
        )
    : [];
  const vendorCerts = await db
    .select()
    .from(insuranceCertificates)
    .where(
      and(
        eq(insuranceCertificates.companyId, pkg.companyId),
        eq(insuranceCertificates.vendorId, submission.vendorId),
      ),
    );
  const pool = [...certs, ...vendorCerts.filter((c) => !certIds.includes(c.id))];
  for (const req of (pkg.insuranceRequirements as {
    policyType?: string;
    limit?: number | null;
    currency?: string;
    required?: boolean;
  }[]) ?? []) {
    if (req.required === false) continue;
    const candidates = pool.filter((c) => c.policyType === req.policyType);
    const live = candidates.filter((c) => c.validTo >= asOf && c.status !== "void");
    const enough = live.filter(
      (c) =>
        req.limit === null ||
        req.limit === undefined ||
        (c.limitOfIndemnity !== null &&
          c.limitOfIndemnity >= req.limit &&
          (!req.currency || c.currency.toUpperCase() === req.currency.toUpperCase())),
    );
    findings.push({
      requirement: `${req.policyType} insurance${req.limit ? ` of at least ${req.currency ?? ""} ${req.limit}` : ""}`,
      satisfied: enough.length > 0,
      detail:
        enough.length > 0
          ? `Evidenced by certificate ${enough[0]!.certificateNumber ?? enough[0]!.id}, valid to ${enough[0]!.validTo}` +
            `${enough[0]!.verifiedAt ? " and independently verified." : " (not independently verified)."}`
          : candidates.length === 0
            ? "No certificate of this cover is held for this bidder. Evidence of cover is not " +
              "cover, but its absence is the only thing you can see."
            : live.length === 0
              ? `The certificate(s) held expired on ${candidates.map((c) => c.validTo).sort().at(-1)}.`
              : `Cover is held but the limit is below what this package requires` +
                (req.currency ? ` in ${req.currency}` : "") + ".",
    });
  }

  /* addenda */
  const acknowledged = new Set((submission.addendaAcknowledged as string[]) ?? []);
  for (const a of addendaOf(pkg)) {
    if (!a.requiresAcknowledgement) continue;
    findings.push({
      requirement: `Addendum ${a.reference} acknowledged`,
      satisfied: acknowledged.has(a.reference),
      detail: acknowledged.has(a.reference)
        ? "Acknowledged by the bidder."
        : `Not acknowledged. A bid submitted without acknowledging ${a.reference} was priced ` +
          "against a different scope from the one the other bidders answered.",
    });
  }

  return { findings, satisfied: findings.every((f) => f.satisfied) };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export const submissionRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("bidding", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("bidding", "standard"),
  ];
  const companyGate = [app.authenticate, app.requireCompany];

  async function recountSubmissions(db: Db, packageId: string): Promise<void> {
    const [row] = await db
      .select({ n: count() })
      .from(bidSubmissions)
      .where(eq(bidSubmissions.packageId, packageId));
    await db
      .update(bidPackages)
      .set({ submissionCount: Number(row?.n ?? 0), updatedAt: new Date().toISOString() })
      .where(eq(bidPackages.id, packageId));
  }

  async function lineRows(db: Db, submissionId: string) {
    return db
      .select()
      .from(bidSubmissionLines)
      .where(eq(bidSubmissionLines.submissionId, submissionId))
      .orderBy(asc(bidSubmissionLines.position));
  }

  /** The full submission view, ALWAYS through the seal. */
  async function submissionDetail(db: Db, submission: BidSubmissionRow, pkg: BidPackageRow) {
    const seal = sealState(pkg);
    const lines = seal.amountsWithheld ? [] : await lineRows(db, submission.id);
    const compliance = await complianceReport(db, pkg, submission);
    const prequal = await vendorPrequalStatus(db, pkg.companyId, submission.vendorId);
    const gate = evaluatePrequalGate(pkg, prequal, "Bid", false);
    const cap = effectiveLimit(prequal);
    const capacity = seal.amountsWithheld
      ? null
      : checkContractAgainstLimit({
          contractValue: submission.totalAmount,
          contractCurrency: submission.currency,
          limit: cap.limit,
          limitCurrency: cap.currency,
          vendorName: prequal.vendorName ?? submission.vendorId,
          basis: cap.basis,
        });
    return {
      ...redactSubmission({ ...submission, lines }, seal),
      packageReference: pkg.reference,
      vendorName: prequal.vendorName,
      lateness: {
        isLate: submission.isLate === 1,
        lateByMinutes: submission.lateByMinutes,
        accepted: Boolean(submission.lateAcceptedBy),
        acceptedBy: submission.lateAcceptedBy,
        acceptanceReason: submission.lateAcceptanceReason,
        note:
          submission.isLate === 1
            ? submission.lateAcceptedBy
              ? `Accepted late by ${submission.lateAcceptedBy}: ${submission.lateAcceptanceReason}`
              : `This bid arrived ${submission.lateByMinutes} minute(s) after the deadline and ` +
                "has not been accepted. It cannot be levelled, scored or awarded until somebody " +
                "accepts it with a stated reason."
            : "On time.",
      },
      compliance,
      prequalification: {
        state: prequal.state,
        expiresAt: prequal.expiresAt,
        ok: gate.ok,
        flag: gate.message,
        note: prequal.note,
      },
      capacity,
      seal,
    };
  }

  async function submissionContext(
    req: FastifyRequest,
  ): Promise<{ submission: BidSubmissionRow; pkg: BidPackageRow }> {
    const { submissionId } = req.params as { submissionId: string };
    const submission = await fetchSubmission(app.db, submissionId, req.companyId!);
    const pkg = await fetchPackage(app.db, submission.packageId, req.companyId!);
    return { submission, pkg };
  }

  /* ---------------------------------------------------------------- */
  /* Record a bid                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Receiving a bid. Three things happen here that cannot happen later:
   * lateness is MEASURED against the published deadline (never inferred
   * afterwards from a status), the sealed envelope's hash is fixed at the
   * moment of receipt, and the headline figures are reconciled against the
   * priced lines.
   */
  app.post(
    "/projects/:projectId/bid-packages/:packageId/submissions",
    { preHandler: standardGate },
    async (req, reply) => {
      const { packageId } = req.params as { packageId: string };
      const body = submissionCreateSchema.parse(req.body);
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const pkg = await fetchPackage(app.db, packageId, companyId, projectId);
      if (pkg.status === "awarded" || pkg.status === "cancelled") {
        throw conflict(`A ${pkg.status} package cannot take new bids.`);
      }
      /*
       * A BID CANNOT ARRIVE BEFORE THE TENDER WENT OUT. Recording one against
       * a draft package let the seal be switched off afterwards: the
       * evaluation basis (isSealed, sealedUntil, requiresOpeningWitness) is
       * frozen at ISSUE, so a package that never issued could take three
       * sealed bids and then have its seal PATCHed away with no opening, no
       * witness and no ledger entry. Refusing here closes that door at the
       * only place it can be closed.
       */
      if (!ISSUED_FOR_BIDS.includes(pkg.status)) {
        throw conflict(
          `${pkg.reference} is at status "${pkg.status}" and has not been issued to bidders, so ` +
            "there is nothing for a bid to be a response to. Approve and issue the package " +
            "first: the evaluation basis — including whether bids are sealed and when the seal " +
            "lifts — is frozen at issue, and a bid recorded before that freeze could have its " +
            "seal removed afterwards without an opening, a witness or a record.",
        );
      }
      const vendor = await assertVendor(app.db, body.vendorId, companyId);

      if (pkg.isSealed === 1 && body.sealedFileId && !body.sealedSha256) {
        throw badRequest(
          "A sealed submission carrying a file must carry its sha256 as well. The hash is what " +
            "fixes the content at the moment of receipt — without it, 'the price was not " +
            "altered between the deadline and the opening' is an assertion rather than a fact.",
        );
      }

      /*
       * The client-supplied invitation is resolved and CHECKED before it is
       * touched. `body.invitationId` used to go straight into a WHERE clause
       * with no company, package or vendor constraint, so a standard user in
       * one company could flip an invitation belonging to another company to
       * "submitted" and point it at their own bid. Ids travel — they appear
       * in ledger payloads and webhook events — so an id is never authority.
       */
      let invitation: BidInvitationRow | null = null;
      if (body.invitationId) {
        invitation = await fetchInvitation(app.db, body.invitationId, companyId);
        if (invitation.packageId !== packageId) {
          throw badRequest(
            "That invitation belongs to a different bid package. An invitation is the record of " +
              "one vendor being asked to price one package; pointing it at a bid on another " +
              "package would falsify both.",
          );
        }
        if (invitation.vendorId !== body.vendorId) {
          throw badRequest(
            "That invitation was issued to a different vendor. A bid is recorded against the " +
              "invitation of the company that submitted it, never against somebody else's.",
          );
        }
      }

      const revisionRows = await app.db
        .select()
        .from(bidSubmissions)
        .where(
          and(eq(bidSubmissions.packageId, packageId), eq(bidSubmissions.vendorId, body.vendorId)),
        );
      const revision = revisionRows.reduce((max, r) => Math.max(max, r.revision + 1), 0);

      /*
       * LATENESS IS MEASURED FROM A TIME SOMEBODY COULD HAVE FAKED. The
       * receipt time decides whether a bid was late, so it is bounded: never
       * in the future, and a backdate of more than a week needs a stated
       * reason. Both the stated receipt and the server's own clock go into
       * the ledger, so a discrepancy is visible afterwards even where it was
       * permitted at the time.
       */
      const serverNow = new Date().toISOString();
      const receivedAt = body.receivedAt ?? serverNow;
      const receivedMs = Date.parse(receivedAt);
      const serverMs = Date.parse(serverNow);
      if (Number.isFinite(receivedMs) && receivedMs > serverMs + 60_000) {
        throw badRequest(
          `receivedAt (${receivedAt}) is in the future. A bid cannot have arrived before it ` +
            "arrived, and a forward-dated receipt makes a late bid on time.",
        );
      }
      if (
        Number.isFinite(receivedMs) &&
        serverMs - receivedMs > 7 * 86_400_000 &&
        !body.backdateReason
      ) {
        throw badRequest(
          `receivedAt (${receivedAt}) is more than seven days before now. Backdating a receipt ` +
            "by that much changes whether the bid was late, so it needs a stated reason " +
            "(backdateReason) that goes on the ledger next to the server's own clock.",
          { control: "backdated_receipt", serverTime: serverNow },
        );
      }
      const lateness = computeLateness(pkg.bidDueAt, receivedAt);

      const lines = (body.lines ?? []).map((l, index) => ({
        ...l,
        position: l.position ?? index,
        resolvedAmount: resolveLineAmount(l),
      }));
      const totals = resolveSubmissionTotals({
        baseBidAmount: body.baseBidAmount ?? null,
        allowancesTotal: body.allowancesTotal ?? null,
        provisionalSumsTotal: body.provisionalSumsTotal ?? null,
        alternates: (body.alternates ?? []).map((a) => ({ amount: a.amount, accepted: a.accepted })),
        lines: lines.map((l) => ({
          amount: l.resolvedAmount,
          isAlternate: l.isAlternate === true,
          isAllowance: l.isAllowance === true,
          isProvisionalSum: l.isProvisionalSum === true,
        })),
      });

      const currency = body.currency ?? pkg.currency;
      const id = newId("bsu");
      const reference = body.reference ?? `${pkg.reference}-${vendor.name.slice(0, 12).trim()}${revision > 0 ? `-R${revision}` : ""}`;
      const status = body.status === "draft" ? "draft" : "received";

      await app.db.insert(bidSubmissions).values({
        id,
        companyId,
        projectId,
        packageId,
        invitationId: body.invitationId ?? null,
        vendorId: body.vendorId,
        reference,
        revision,
        status,
        submittedAt: body.submittedAt ?? receivedAt,
        receivedAt,
        isLate: lateness.isLate ? 1 : 0,
        lateByMinutes: lateness.lateByMinutes,
        baseBidAmount: totals.baseBidAmount,
        alternatesTotal: totals.alternatesTotal,
        allowancesTotal: totals.allowancesTotal,
        provisionalSumsTotal: totals.provisionalSumsTotal,
        totalAmount: totals.totalAmount,
        currency,
        exclusions: body.exclusions ?? null,
        qualifications: body.qualifications ?? null,
        assumptions: body.assumptions ?? null,
        clarificationsRequested: body.clarificationsRequested ?? null,
        proposedProgrammeWeeks: body.proposedProgrammeWeeks ?? null,
        proposedStartDate: body.proposedStartDate ?? null,
        proposedCompletionDate: body.proposedCompletionDate ?? null,
        validUntil: body.validUntil ?? null,
        paymentTermsDays: body.paymentTermsDays ?? null,
        retentionPercent: body.retentionPercent ?? null,
        bondsOffered: body.bondsOffered ?? [],
        insuranceCertificateIds: body.insuranceCertificateIds ?? [],
        addendaAcknowledged: body.addendaAcknowledged ?? [],
        alternates: body.alternates ?? [],
        valueEngineering: body.valueEngineering ?? [],
        attachmentFileIds: body.attachmentFileIds ?? [],
        sealedFileId: body.sealedFileId ?? null,
        sealedSha256: body.sealedSha256 ?? null,
        lineCount: lines.length,
        detail: {
          ...(body.detail ?? {}),
          totalsNotes: totals.notes,
          statedReceiptAt: receivedAt,
          serverReceiptAt: serverNow,
          ...(body.backdateReason ? { backdateReason: body.backdateReason } : {}),
        },
        createdBy: req.user!.id,
      });

      for (const line of lines) {
        await app.db.insert(bidSubmissionLines).values({
          id: newId("bsl"),
          companyId,
          projectId,
          submissionId: id,
          packageId,
          vendorId: body.vendorId,
          levellingItemId: line.levellingItemId ?? null,
          position: line.position,
          itemCode: line.itemCode ?? null,
          description: line.description,
          specSectionCode: line.specSectionCode ?? null,
          unit: line.unit ?? null,
          quantity: line.quantity ?? null,
          unitRate: line.unitRate ?? null,
          amount: line.resolvedAmount,
          currency: line.currency ?? currency,
          isProvisionalSum: line.isProvisionalSum ? 1 : 0,
          isAllowance: line.isAllowance ? 1 : 0,
          isAlternate: line.isAlternate ? 1 : 0,
          alternateLabel: line.alternateLabel ?? null,
          isExcluded: line.isExcluded ? 1 : 0,
          inclusionNote: line.inclusionNote ?? null,
          costCodeId: line.costCodeId ?? null,
          budgetLineItemId: line.budgetLineItemId ?? null,
          detail: line.detail ?? {},
        });
      }

      if (invitation) {
        await app.db
          .update(bidInvitations)
          .set({
            status: "submitted",
            submissionId: id,
            respondedAt: receivedAt,
            updatedAt: new Date().toISOString(),
          })
          .where(
            and(
              eq(bidInvitations.id, invitation.id),
              eq(bidInvitations.companyId, companyId),
              eq(bidInvitations.packageId, packageId),
              eq(bidInvitations.vendorId, body.vendorId),
            ),
          );
      }

      /*
       * A REVISION SUPERSEDES ITS PREDECESSOR. Every earlier revision used to
       * stay at "received", so R0 and R1 both counted as contenders: R0's
       * unanswered scope rows blocked the levelling, both appeared in the
       * award comparison, and the "lowest bid amount" recorded on an award
       * could be a figure the bidder had already replaced. The earlier
       * revision is withdrawn from contention and kept in full — what they
       * priced before the addendum is a question somebody asks.
       */
      const superseded: string[] = [];
      if (revision > 0) {
        for (const prior of revisionRows) {
          if (prior.id === id) continue;
          if (!isInContention(prior.status)) continue;
          await app.db
            .update(bidSubmissions)
            .set({
              status: "withdrawn",
              supersededById: id,
              evaluationNote:
                `Superseded by revision ${revision} (${reference}) received ${receivedAt}.`,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(bidSubmissions.id, prior.id));
          superseded.push(prior.id);
          await ledger(
            app.db,
            req,
            "state_change",
            "bid_submission",
            prior.id,
            {
              projectId,
              packageId,
              event: "superseded_by_revision",
              to: "withdrawn",
              supersededBy: id,
              supersededByReference: reference,
              priorRevision: prior.revision,
              newRevision: revision,
              sealedSha256: prior.sealedSha256,
            },
            projectId,
            true,
          );
        }
      }
      await recountSubmissions(app.db, packageId);
      if (pkg.status === "invitations_sent") {
        await app.db
          .update(bidPackages)
          .set({ status: "open", updatedAt: new Date().toISOString() })
          .where(eq(bidPackages.id, packageId));
      }

      await ledger(
        app.db,
        req,
        "create",
        "bid_submission",
        id,
        {
          projectId,
          packageId,
          packageReference: pkg.reference,
          vendorId: body.vendorId,
          vendorName: vendor.name,
          reference,
          revision,
          receivedAt,
          bidDueAt: pkg.bidDueAt,
          isLate: lateness.isLate,
          lateByMinutes: lateness.lateByMinutes,
          statedReceiptAt: receivedAt,
          serverReceiptAt: serverNow,
          backdateReason: body.backdateReason ?? null,
          supersededSubmissionIds: superseded,
          invitationId: invitation?.id ?? null,
          sealed: pkg.isSealed === 1,
          sealedSha256: body.sealedSha256 ?? null,
          lineCount: lines.length,
          // The AMOUNT is deliberately not in a stored ledger payload for a
          // sealed package: the ledger proves the bid arrived and what its
          // envelope hashed to, without becoming a way to read the price.
          totalAmount: pkg.isSealed === 1 ? null : totals.totalAmount,
          currency,
        },
        projectId,
        true,
      );

      const created = await fetchSubmission(app.db, id, companyId);
      const detail = await submissionDetail(app.db, created, pkg);
      return reply.status(201).send({
        ...detail,
        totalsNotes: totals.notes,
        latenessNote: lateness.reason,
        superseded,
        supersededNote:
          superseded.length > 0
            ? `Revision ${revision} supersedes ${superseded.length} earlier revision(s), which ` +
              "are withdrawn from contention and kept for the record."
            : null,
      });
    },
  );

  /* ---------------------------------------------------------------- */
  /* Read paths — every one of them through the seal                   */
  /* ---------------------------------------------------------------- */

  app.get(
    "/projects/:projectId/bid-packages/:packageId/submissions",
    { preHandler: readGate },
    async (req) => {
      const { packageId } = req.params as { packageId: string };
      const q = submissionsListQuery.parse(req.query);
      const pkg = await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      const filters = [eq(bidSubmissions.packageId, packageId)];
      if (q.status) filters.push(eq(bidSubmissions.status, q.status));
      if (q.vendorId) filters.push(eq(bidSubmissions.vendorId, q.vendorId));
      const where = and(...filters);
      const [totalRow] = await app.db.select({ n: count() }).from(bidSubmissions).where(where);
      const rows = await app.db
        .select()
        .from(bidSubmissions)
        .where(where)
        .orderBy(asc(bidSubmissions.createdAt))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      const seal = sealState(pkg);
      const vendorRows = rows.length
        ? await app.db
            .select({ id: vendors.id, name: vendors.name })
            .from(vendors)
            .where(inArray(vendors.id, [...new Set(rows.map((r) => r.vendorId))]))
        : [];
      const names = new Map(vendorRows.map((v) => [v.id, v.name] as const));
      return {
        ...paginate(
          rows.map((r) => ({
            ...redactSubmission(r, seal),
            vendorName: names.get(r.vendorId) ?? null,
          })),
          Number(totalRow?.n ?? 0),
          q,
        ),
        seal,
      };
    },
  );

  app.get("/bid-submissions/:submissionId", { preHandler: companyGate }, async (req, reply) => {
    const { submission, pkg } = await submissionContext(req);
    await requireBiddingLevel(app, req, reply, submission.projectId, "read");
    return submissionDetail(app.db, submission, pkg);
  });

  app.get(
    "/bid-submissions/:submissionId/lines",
    { preHandler: companyGate },
    async (req, reply) => {
      const { submission, pkg } = await submissionContext(req);
      await requireBiddingLevel(app, req, reply, submission.projectId, "read");
      const seal = sealState(pkg);
      if (seal.amountsWithheld) {
        return {
          items: [],
          total: submission.lineCount,
          sealed: true,
          sealNote: seal.note,
          note:
            "The priced lines of a sealed bid are withheld in full: a unit rate is a price, and " +
            "a bill of quantities read early tells a competitor everything.",
        };
      }
      const items = await lineRows(app.db, submission.id);
      return { items, total: items.length, sealed: false, sealNote: null };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Late acceptance — never silent                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Letting a late bid into the comparison. The reason is REQUIRED and is
   * ledgered with the lateness in minutes and the deadline it missed,
   * because "we accepted it because they are the incumbent" and "the courier
   * was held at the gate for eleven minutes" are different decisions and only
   * one of them survives a challenge.
   */
  app.post(
    "/bid-submissions/:submissionId/accept-late",
    { preHandler: companyGate },
    async (req, reply) => {
      const body = lateAcceptSchema.parse(req.body);
      const { submission, pkg } = await submissionContext(req);
      await requireBiddingLevel(app, req, reply, submission.projectId, "standard");
      if (submission.isLate !== 1) {
        throw badRequest(
          "This bid was not late, so there is nothing to accept. Recording a late acceptance " +
            "against an on-time bid would put a defect on the record that never happened.",
        );
      }
      if (submission.lateAcceptedBy) {
        throw conflict(
          `This late bid was already accepted by ${submission.lateAcceptedBy}: ` +
            `"${submission.lateAcceptanceReason}"`,
        );
      }
      const now = new Date().toISOString();
      await app.db
        .update(bidSubmissions)
        .set({ lateAcceptedBy: req.user!.id, lateAcceptanceReason: body.reason, updatedAt: now })
        .where(eq(bidSubmissions.id, submission.id));
      await ledger(
        app.db,
        req,
        "state_change",
        "bid_submission",
        submission.id,
        {
          projectId: submission.projectId,
          packageId: submission.packageId,
          event: "late_bid_accepted",
          reference: submission.reference,
          vendorId: submission.vendorId,
          bidDueAt: pkg.bidDueAt,
          receivedAt: submission.receivedAt,
          lateByMinutes: submission.lateByMinutes,
          acceptedBy: req.user!.id,
          reason: body.reason,
        },
        submission.projectId,
        true,
      );
      const fresh = await fetchSubmission(app.db, submission.id, req.companyId!);
      return submissionDetail(app.db, fresh, pkg);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Compliance, clarification, withdrawal                             */
  /* ---------------------------------------------------------------- */

  app.post(
    "/bid-submissions/:submissionId/compliance",
    { preHandler: companyGate },
    async (req, reply) => {
      const body = complianceSchema.parse(req.body);
      const { submission, pkg } = await submissionContext(req);
      await requireBiddingLevel(app, req, reply, submission.projectId, "standard");
      if (
        (body.complianceStatus === "non_compliant" ||
          body.complianceStatus === "qualified" ||
          body.complianceStatus === "conditional") &&
        !body.note
      ) {
        throw badRequest(
          `A "${body.complianceStatus}" finding needs a note saying what is wrong with the bid. ` +
            "A compliance status with no explanation cannot be put to the bidder or defended.",
        );
      }
      const now = new Date().toISOString();
      await app.db
        .update(bidSubmissions)
        .set({
          complianceStatus: body.complianceStatus,
          nonComplianceNote: body.note ?? null,
          detail: {
            ...(submission.detail as Record<string, unknown>),
            ...(body.abnormalLowJustification !== undefined
              ? {
                  abnormalLowJustification: body.abnormalLowJustification,
                  abnormalLowJustificationBy: req.user!.id,
                  abnormalLowJustificationAt: now,
                }
              : {}),
          },
          evaluatedBy: req.user!.id,
          evaluatedAt: now,
          updatedAt: now,
        })
        .where(eq(bidSubmissions.id, submission.id));
      await ledger(app.db, req, "state_change", "bid_submission", submission.id, {
        projectId: submission.projectId,
        packageId: submission.packageId,
        complianceStatus: body.complianceStatus,
        note: body.note ?? null,
        abnormalLowJustification: body.abnormalLowJustification ?? null,
      }, submission.projectId, true);
      const fresh = await fetchSubmission(app.db, submission.id, req.companyId!);
      return submissionDetail(app.db, fresh, pkg);
    },
  );

  app.post(
    "/bid-submissions/:submissionId/clarification",
    { preHandler: companyGate },
    async (req, reply) => {
      const body = z
        .object({
          requested: z.string().max(20000).nullable().optional(),
          response: z.string().max(20000).nullable().optional(),
        })
        .parse(req.body);
      const { submission, pkg } = await submissionContext(req);
      await requireBiddingLevel(app, req, reply, submission.projectId, "standard");
      if (!CLARIFIABLE_STATUSES.includes(submission.status)) {
        throw conflict(
          `${submission.reference} is at status "${submission.status}" and cannot be clarified. ` +
            "A clarification used to set the status to 'clarified' unconditionally, which put a " +
            "withdrawn, superseded, unsuccessful or already-awarded bid back into contention: " +
            "it re-entered the levelling blockers, the scoring and the award comparison, and an " +
            "awarded bid lost its award status. Record the correspondence against the bid " +
            "instead, or re-open it deliberately.",
        );
      }
      const now = new Date().toISOString();
      await app.db
        .update(bidSubmissions)
        .set({
          clarificationsRequested: body.requested ?? submission.clarificationsRequested,
          clarificationResponse: body.response ?? submission.clarificationResponse,
          status: body.response ? "clarified" : "clarification_requested",
          updatedAt: now,
        })
        .where(eq(bidSubmissions.id, submission.id));
      await ledger(app.db, req, "update", "bid_submission", submission.id, {
        projectId: submission.projectId,
        packageId: submission.packageId,
        event: body.response ? "clarification_answered" : "clarification_requested",
      }, submission.projectId);
      const fresh = await fetchSubmission(app.db, submission.id, req.companyId!);
      return submissionDetail(app.db, fresh, pkg);
    },
  );

  app.post(
    "/bid-submissions/:submissionId/withdraw",
    { preHandler: companyGate },
    async (req, reply) => {
      const { reason } = z.object({ reason: reasonSchema }).parse(req.body);
      const { submission, pkg } = await submissionContext(req);
      await requireBiddingLevel(app, req, reply, submission.projectId, "standard");
      if (submission.status === "awarded") {
        throw conflict("An awarded bid cannot be withdrawn — cancel the award instead.");
      }
      const now = new Date().toISOString();
      await app.db
        .update(bidSubmissions)
        .set({
          status: "withdrawn",
          evaluationNote: reason,
          updatedAt: now,
        })
        .where(eq(bidSubmissions.id, submission.id));
      await ledger(app.db, req, "state_change", "bid_submission", submission.id, {
        projectId: submission.projectId,
        packageId: submission.packageId,
        to: "withdrawn",
        reason,
      }, submission.projectId, true);
      const fresh = await fetchSubmission(app.db, submission.id, req.companyId!);
      return submissionDetail(app.db, fresh, pkg);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Post-bid alternates (#166)                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Accepting (or releasing) an alternate AFTER the bids are in.
   *
   * An unaccepted alternate is not in the compared price — that is what
   * makes the comparison like-for-like. Accepting one therefore CHANGES the
   * compared price, so it is a deliberate, ledgered act with the before and
   * after recorded, it is refused once the package is awarded, and it voids
   * any levelling that was completed on the old figure. Quietly folding an
   * alternate into a total after the tabulation is how a bid that was second
   * becomes first without anybody deciding that it should.
   */
  app.post(
    "/bid-submissions/:submissionId/alternates/:label/accept",
    { preHandler: companyGate },
    async (req, reply) => {
      const { label } = req.params as { label: string };
      const body = z
        .object({ accepted: z.boolean().default(true), reason: reasonSchema })
        .parse(req.body ?? {});
      const { submission, pkg } = await submissionContext(req);
      await requireBiddingLevel(app, req, reply, submission.projectId, "standard");
      if (pkg.status === "awarded" || pkg.status === "cancelled") {
        throw conflict(
          `${pkg.reference} is ${pkg.status}. An alternate accepted after the award changes the ` +
            "contract sum without a change instruction — that belongs in the commitment, not " +
            "in the bid.",
        );
      }
      const seal = sealState(pkg);
      if (seal.amountsWithheld) {
        throw conflict(
          `Accepting an alternate reads and rewrites a submitted amount. ${seal.note}`,
        );
      }
      const alternates = (submission.alternates as {
        label?: string;
        description?: string | null;
        amount?: number;
        accepted?: boolean;
      }[]) ?? [];
      const match = alternates.find((a) => a.label === label);
      if (!match) {
        throw badRequest(
          `${submission.reference} offered no alternate labelled "${label}". The alternates on ` +
            `this bid are: ${alternates.map((a) => a.label).join(", ") || "none"}.`,
        );
      }
      if ((match.accepted === true) === body.accepted) {
        throw conflict(
          `Alternate "${label}" is already ${body.accepted ? "accepted" : "not accepted"}.`,
        );
      }
      const next = alternates.map((a) =>
        a.label === label ? { ...a, accepted: body.accepted } : a,
      );
      const totals = resolveSubmissionTotals({
        baseBidAmount: submission.baseBidAmount,
        allowancesTotal: submission.allowancesTotal,
        provisionalSumsTotal: submission.provisionalSumsTotal,
        alternates: next.map((a) => ({
          amount: typeof a.amount === "number" ? a.amount : 0,
          accepted: a.accepted === true,
        })),
        lines: [],
      });
      const now = new Date().toISOString();
      await app.db
        .update(bidSubmissions)
        .set({
          alternates: next,
          alternatesTotal: totals.alternatesTotal,
          totalAmount: totals.totalAmount,
          // The levelled figure was frozen against the OLD compared price.
          normalisedAmount: null,
          levellingCompletedAt: null,
          detail: {
            ...(submission.detail as Record<string, unknown>),
            totalsNotes: totals.notes,
          },
          updatedAt: now,
        })
        .where(eq(bidSubmissions.id, submission.id));
      await ledger(
        app.db,
        req,
        "update",
        "bid_submission",
        submission.id,
        {
          projectId: submission.projectId,
          packageId: submission.packageId,
          event: body.accepted ? "alternate_accepted" : "alternate_released",
          label,
          reason: body.reason,
          previousTotalAmount: submission.totalAmount,
          newTotalAmount: totals.totalAmount,
          currency: submission.currency,
        },
        submission.projectId,
        true,
      );
      const fresh = await fetchSubmission(app.db, submission.id, req.companyId!);
      return {
        ...(await submissionDetail(app.db, fresh, pkg)),
        note:
          `Alternate "${label}" is now ${body.accepted ? "accepted" : "excluded"} and the ` +
          "compared total has moved. Any levelling completed on the previous figure has been " +
          "cleared: a frozen comparable amount that no longer describes the same scope is " +
          "worse than none.",
      };
    },
  );
};
