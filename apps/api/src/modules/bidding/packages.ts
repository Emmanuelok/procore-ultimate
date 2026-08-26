import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  bidAwards,
  bidInvitations,
  bidLevellingItems,
  bidPackages,
  bidSubmissions,
  vendors,
} from "@constructos/db";
import {
  BID_EVALUATION_METHODS,
  BID_PACKAGE_KINDS,
  BID_PACKAGE_STATUSES,
  BOND_TYPES,
  POLICY_TYPES,
  PROCUREMENT_ROUTES,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { badRequest, conflict } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { epochMs } from "../../lib/time.js";
import type { Db } from "../../lib/db.js";
import {
  assertSegregation,
  currencySchema,
  detailSchema,
  distinctCurrencies,
  fetchPackage,
  isInContention,
  isoDateSchema,
  isoTimestampSchema,
  known,
  ledger,
  nonNegativeMoneySchema,
  packageReference,
  percentSchema,
  reasonSchema,
  round2,
  todayIso,
  unknowable,
  type BidPackageRow,
  type Unknowable,
} from "./shared.js";
import {
  assertOpeningPermitted,
  redactSubmission,
  sealState,
  type SealState,
} from "./sealing.js";
import { effectiveLimit, sweepPrequalification, vendorPrequalStatus } from "./prequal-status.js";
import { checkContractAgainstLimit } from "./financial-limits.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const bondRequirementSchema = z.object({
  bondType: z.enum(BOND_TYPES),
  percent: percentSchema.nullable().optional(),
  amount: nonNegativeMoneySchema.nullable().optional(),
  required: z.boolean().default(true),
  note: z.string().max(1000).nullable().optional(),
});

const insuranceRequirementSchema = z.object({
  policyType: z.enum(POLICY_TYPES),
  limit: nonNegativeMoneySchema.nullable().optional(),
  currency: currencySchema.optional(),
  required: z.boolean().default(true),
  note: z.string().max(1000).nullable().optional(),
});

/**
 * The evaluation basis, declared BEFORE bids open. `kind` splits the criteria
 * into the two halves the weights address; a criterion with no weight cannot
 * decide anything and is refused rather than silently ignored.
 */
const criterionSchema = z.object({
  key: z.string().trim().min(1).max(60),
  label: z.string().trim().min(1).max(200),
  weight: z.number().finite().min(0).max(100),
  kind: z.enum(["price", "quality"]).default("quality"),
  guidance: z.string().max(2000).nullable().optional(),
});

/**
 * Every field is optional and NONE carries a zod default.
 *
 * A `.default()` here would be applied on PATCH as well as on create, so a
 * request that only touches the scope narrative would silently rewrite the
 * package kind and the evaluation method back to their defaults — and the
 * evaluation method is frozen at issue, so the patch would then be refused
 * for a change nobody made. Defaults are applied explicitly on create instead.
 */
const packageMutableSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  scopeDescription: z.string().max(20000).nullable().optional(),
  packageKind: z.enum(BID_PACKAGE_KINDS).optional(),
  procurementRoute: z.enum(PROCUREMENT_ROUTES).optional(),
  tradeCode: z.string().max(60).nullable().optional(),
  csiDivision: z.string().max(60).nullable().optional(),
  specSectionIds: z.array(z.string().min(1).max(64)).max(500).optional(),
  drawingSheetIds: z.array(z.string().min(1).max(64)).max(500).optional(),
  budgetLineItemIds: z.array(z.string().min(1).max(64)).max(500).optional(),
  estimatedValue: nonNegativeMoneySchema.nullable().optional(),
  engineersEstimate: nonNegativeMoneySchema.nullable().optional(),
  currency: currencySchema.optional(),
  questionsDueAt: isoTimestampSchema.nullable().optional(),
  bidDueAt: isoTimestampSchema.nullable().optional(),
  bidValidityDays: z.number().int().min(0).max(3650).nullable().optional(),
  siteVisitAt: isoTimestampSchema.nullable().optional(),
  isSiteVisitMandatory: z.boolean().optional(),
  anticipatedAwardDate: isoDateSchema.nullable().optional(),
  anticipatedStartDate: isoDateSchema.nullable().optional(),
  anticipatedCompletionDate: isoDateSchema.nullable().optional(),
  requiredBonds: z.array(bondRequirementSchema).max(20).optional(),
  insuranceRequirements: z.array(insuranceRequirementSchema).max(20).optional(),
  prequalificationRequired: z.boolean().optional(),
  prequalificationQuestionnaireId: z.string().min(1).max(64).nullable().optional(),
  /** how hard the prequalification gate bites at award: refuse | warn */
  prequalificationStrictness: z.enum(["refuse", "warn"]).optional(),
  retentionPercent: percentSchema.nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
  evaluationMethod: z.enum(BID_EVALUATION_METHODS).optional(),
  evaluationCriteria: z.array(criterionSchema).max(50).optional(),
  priceWeight: percentSchema.nullable().optional(),
  qualityWeight: percentSchema.nullable().optional(),
  isSealed: z.boolean().optional(),
  sealedUntil: isoTimestampSchema.nullable().optional(),
  /** waive the opening witness — a recorded decision, never a default */
  requiresOpeningWitness: z.boolean().optional(),
  documentFileIds: z.array(z.string().min(1).max(64)).max(500).optional(),
  detail: detailSchema.optional(),
});

const packageCreateSchema = packageMutableSchema.extend({
  title: z.string().trim().min(1).max(300),
});

const packagePatchSchema = packageMutableSchema;

const packagesListQuery = pageQuerySchema.extend({
  status: z.enum(BID_PACKAGE_STATUSES).optional(),
  packageKind: z.enum(BID_PACKAGE_KINDS).optional(),
  tradeCode: z.string().max(60).optional(),
});

const openSchema = z.object({
  witnessUserId: z.string().min(1).max(64).nullable().optional(),
  witnessName: z.string().trim().min(1).max(200).nullable().optional(),
  note: z.string().max(4000).nullable().optional(),
});

const addendumSchema = z.object({
  reference: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(8000),
  fileIds: z.array(z.string().min(1).max(64)).max(200).optional(),
  /** an addendum that changes the scope usually buys the bidders more time */
  newBidDueAt: isoTimestampSchema.nullable().optional(),
  requiresAcknowledgement: z.boolean().default(true),
});

export interface Addendum {
  reference: string;
  description: string;
  fileIds: string[];
  issuedAt: string;
  issuedBy: string;
  requiresAcknowledgement: boolean;
  previousBidDueAt: string | null;
  newBidDueAt: string | null;
}

export const addendaOf = (pkg: BidPackageRow): Addendum[] =>
  ((pkg.detail as Record<string, unknown>)["addenda"] as Addendum[] | undefined) ?? [];

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

/**
 * The tender timetable, with the one derived fact everybody actually asks
 * for: is it still open, and for how long.
 */
export function timetableOf(pkg: BidPackageRow, nowMs = Date.now()) {
  const dueMs = epochMs(pkg.bidDueAt);
  return {
    issuedAt: pkg.issuedAt,
    questionsDueAt: pkg.questionsDueAt,
    questionsClosed: pkg.questionsDueAt ? (epochMs(pkg.questionsDueAt) ?? 0) <= nowMs : null,
    bidDueAt: pkg.bidDueAt,
    bidsClosed: dueMs === null ? null : dueMs <= nowMs,
    hoursToBidDue: dueMs === null ? null : round2((dueMs - nowMs) / 3_600_000),
    bidValidityDays: pkg.bidValidityDays,
    siteVisitAt: pkg.siteVisitAt,
    isSiteVisitMandatory: pkg.isSiteVisitMandatory === 1,
    anticipatedAwardDate: pkg.anticipatedAwardDate,
    anticipatedStartDate: pkg.anticipatedStartDate,
    anticipatedCompletionDate: pkg.anticipatedCompletionDate,
  };
}

export function requirementsOf(pkg: BidPackageRow) {
  return {
    bonds: pkg.requiredBonds,
    insurance: pkg.insuranceRequirements,
    prequalification: {
      required: pkg.prequalificationRequired === 1,
      questionnaireId: pkg.prequalificationQuestionnaireId,
      strictness:
        ((pkg.detail as Record<string, unknown>)["prequalificationStrictness"] as string) ??
        (pkg.prequalificationRequired === 1 ? "refuse" : "warn"),
    },
    retentionPercent: pkg.retentionPercent,
    paymentTermsDays: pkg.paymentTermsDays,
  };
}

/**
 * Market position against the pre-tender estimate. Null with reasons wherever
 * the inputs are missing or the seal is still on — "the market is 12% over"
 * is not a statement anyone may make about bids nobody has opened.
 */
export function estimateComparison(
  pkg: BidPackageRow,
  seal: SealState,
  submissions: readonly { totalAmount: number | null; currency: string; status: string }[],
): { lowest: Unknowable; median: Unknowable; againstEstimatePercent: Unknowable } {
  const withheld = seal.amountsWithheld;
  const blocked = (extra: string) =>
    unknowable<number>(
      withheld
        ? `Bids on this package are sealed and unopened. ${seal.note}`
        : extra,
    );
  if (withheld) {
    return {
      lowest: blocked(""),
      median: blocked(""),
      againstEstimatePercent: blocked(""),
    };
  }
  const live = submissions.filter((s) => isInContention(s.status) && s.totalAmount !== null);
  const currencies = distinctCurrencies(live.map((s) => s.currency));
  if (live.length === 0) {
    const why = "No bid on this package carries a total amount yet.";
    return {
      lowest: unknowable(why),
      median: unknowable(why),
      againstEstimatePercent: unknowable(why),
    };
  }
  if (currencies.length > 1) {
    const why =
      `Bids on this package are priced in ${currencies.join(", ")}. Figures in different ` +
      "currencies are never summed or ranked here.";
    return {
      lowest: unknowable(why),
      median: unknowable(why),
      againstEstimatePercent: unknowable(why),
    };
  }
  const amounts = live.map((s) => s.totalAmount!).sort((a, b) => a - b);
  const lowest = amounts[0]!;
  const mid = amounts.length % 2 === 1
    ? amounts[(amounts.length - 1) / 2]!
    : (amounts[amounts.length / 2 - 1]! + amounts[amounts.length / 2]!) / 2;
  const estimate = pkg.engineersEstimate;
  return {
    lowest: known(round2(lowest)),
    median: known(round2(mid)),
    againstEstimatePercent:
      estimate === null || estimate <= 0
        ? unknowable(
            "No engineer's estimate is recorded on this package, so there is nothing to measure " +
              "the market against. The estimate is what makes 'everyone is 30% over' visible.",
          )
        : known(round2(((lowest - estimate) / estimate) * 100)),
  };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export const packageRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("bidding", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("bidding", "standard"),
  ];
  const adminGate = [app.authenticate, app.requireCompany, app.requireTool("bidding", "admin")];

  function assertWeights(priceWeight: number | null, qualityWeight: number | null): void {
    if (priceWeight === null && qualityWeight === null) return;
    if (priceWeight === null || qualityWeight === null) {
      throw badRequest(
        "Declare both priceWeight and qualityWeight, or neither. A basis that weights one half " +
          "of the evaluation and leaves the other undeclared cannot produce a defensible total.",
      );
    }
    if (priceWeight + qualityWeight <= 0) {
      throw badRequest("priceWeight and qualityWeight cannot both be zero.");
    }
  }

  function assertCriteria(criteria: z.infer<typeof criterionSchema>[] | undefined): void {
    if (!criteria) return;
    const keys = new Set<string>();
    for (const c of criteria) {
      if (keys.has(c.key)) throw badRequest(`Duplicate evaluation criterion key "${c.key}"`);
      keys.add(c.key);
    }
    const quality = criteria.filter((c) => c.kind === "quality");
    if (quality.length > 0 && quality.every((c) => c.weight === 0)) {
      throw badRequest(
        "Every declared quality criterion carries a weight of zero, so none of them can affect " +
          "the outcome. Weight them, or drop them from the declared basis.",
      );
    }
  }

  /**
   * The evaluation basis is frozen the moment bidders can see the package.
   * Changing the method, the criteria or the weights once prices are in the
   * room is the classic procurement-integrity failure, and it is refused
   * here rather than discouraged in a guidance note.
   */
  const BASIS_FIELDS = [
    "evaluationMethod",
    "evaluationCriteria",
    "priceWeight",
    "qualityWeight",
    "isSealed",
    "sealedUntil",
    "requiresOpeningWitness",
  ] as const;

  const ISSUED_STATUSES = [
    "invitations_sent",
    "open",
    "closed",
    "under_evaluation",
    "levelled",
    "awarded",
    "partially_awarded",
  ];

  async function packageDetail(db: Db, pkg: BidPackageRow) {
    const subs = await db
      .select()
      .from(bidSubmissions)
      .where(eq(bidSubmissions.packageId, pkg.id))
      .orderBy(asc(bidSubmissions.createdAt));
    const seal = sealState(pkg);
    const [invitationCount] = await db
      .select({ n: count() })
      .from(bidInvitations)
      .where(eq(bidInvitations.packageId, pkg.id));
    const [levellingItemCount] = await db
      .select({ n: count() })
      .from(bidLevellingItems)
      .where(eq(bidLevellingItems.packageId, pkg.id));
    const awardRows = await db
      .select()
      .from(bidAwards)
      .where(eq(bidAwards.packageId, pkg.id))
      .orderBy(desc(bidAwards.createdAt));

    return {
      ...pkg,
      seal,
      timetable: timetableOf(pkg),
      requirements: requirementsOf(pkg),
      addenda: addendaOf(pkg),
      counts: {
        invitations: Number(invitationCount?.n ?? 0),
        submissions: subs.length,
        declines: pkg.declineCount,
        addenda: pkg.addendaCount,
        levellingItems: Number(levellingItemCount?.n ?? 0),
      },
      submissions: subs.map((s) => redactSubmission(s, seal)),
      market: estimateComparison(pkg, seal, subs),
      awards: awardRows,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Create / read / update                                            */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/bid-packages", { preHandler: standardGate }, async (req, reply) => {
    const body = packageCreateSchema.parse(req.body);
    const companyId = req.companyId!;
    const projectId = req.projectId!;
    assertWeights(body.priceWeight ?? null, body.qualityWeight ?? null);
    assertCriteria(body.evaluationCriteria);

    if (body.isSealed && !body.bidDueAt && !body.sealedUntil) {
      throw badRequest(
        "A sealed package needs a moment at which the seal lifts. Set bidDueAt (or sealedUntil) " +
          "when declaring isSealed — otherwise the amounts can never lawfully be read.",
      );
    }
    if (body.sealedUntil && body.bidDueAt && epochMs(body.sealedUntil)! < epochMs(body.bidDueAt)!) {
      throw badRequest(
        "sealedUntil is before bidDueAt: the seal would lift while bids were still being taken.",
      );
    }

    const number = await nextRecordNumber(app.db, projectId, "bid_package");
    const reference = packageReference(number);
    const id = newId("bpk");
    const detail: Record<string, unknown> = { ...(body.detail ?? {}) };
    if (body.prequalificationStrictness) {
      detail["prequalificationStrictness"] = body.prequalificationStrictness;
    }
    if (body.requiresOpeningWitness === false) detail["requiresOpeningWitness"] = false;

    await app.db.insert(bidPackages).values({
      id,
      companyId,
      projectId,
      number,
      reference,
      title: body.title,
      scopeDescription: body.scopeDescription ?? null,
      packageKind: body.packageKind ?? "subcontract",
      procurementRoute: body.procurementRoute ?? "selective_tender",
      tradeCode: body.tradeCode ?? null,
      csiDivision: body.csiDivision ?? null,
      specSectionIds: body.specSectionIds ?? [],
      drawingSheetIds: body.drawingSheetIds ?? [],
      budgetLineItemIds: body.budgetLineItemIds ?? [],
      estimatedValue: body.estimatedValue ?? null,
      engineersEstimate: body.engineersEstimate ?? null,
      currency: body.currency ?? "USD",
      status: "draft",
      questionsDueAt: body.questionsDueAt ?? null,
      bidDueAt: body.bidDueAt ?? null,
      bidValidityDays: body.bidValidityDays ?? null,
      siteVisitAt: body.siteVisitAt ?? null,
      isSiteVisitMandatory: body.isSiteVisitMandatory ? 1 : 0,
      anticipatedAwardDate: body.anticipatedAwardDate ?? null,
      anticipatedStartDate: body.anticipatedStartDate ?? null,
      anticipatedCompletionDate: body.anticipatedCompletionDate ?? null,
      requiredBonds: body.requiredBonds ?? [],
      insuranceRequirements: body.insuranceRequirements ?? [],
      prequalificationRequired: body.prequalificationRequired ? 1 : 0,
      prequalificationQuestionnaireId: body.prequalificationQuestionnaireId ?? null,
      retentionPercent: body.retentionPercent ?? null,
      paymentTermsDays: body.paymentTermsDays ?? null,
      evaluationMethod: body.evaluationMethod ?? "lowest_price",
      evaluationCriteria: body.evaluationCriteria ?? [],
      priceWeight: body.priceWeight ?? null,
      qualityWeight: body.qualityWeight ?? null,
      isSealed: body.isSealed ? 1 : 0,
      sealedUntil: body.sealedUntil ?? null,
      documentFileIds: body.documentFileIds ?? [],
      detail,
      createdBy: req.user!.id,
    });

    await ledger(
      app.db,
      req,
      "create",
      "bid_package",
      id,
      {
        projectId,
        reference,
        title: body.title,
        packageKind: body.packageKind ?? "subcontract",
        procurementRoute: body.procurementRoute ?? "selective_tender",
        evaluationMethod: body.evaluationMethod ?? "lowest_price",
        evaluationCriteria: body.evaluationCriteria ?? [],
        priceWeight: body.priceWeight ?? null,
        qualityWeight: body.qualityWeight ?? null,
        isSealed: body.isSealed ? 1 : 0,
        sealedUntil: body.sealedUntil ?? null,
        engineersEstimate: body.engineersEstimate ?? null,
      },
      projectId,
      true,
    );
    const created = await fetchPackage(app.db, id, companyId, projectId);
    return reply.status(201).send(await packageDetail(app.db, created));
  });

  app.get("/projects/:projectId/bid-packages", { preHandler: readGate }, async (req) => {
    const q = packagesListQuery.parse(req.query);
    // Lazy sweep on a list read (#780): prequalification standings shown next
    // to these packages must be true at the moment they are read.
    await sweepPrequalification(app.db, req.companyId!, req.user!.id);
    const filters = [
      eq(bidPackages.companyId, req.companyId!),
      eq(bidPackages.projectId, req.projectId!),
    ];
    if (q.status) filters.push(eq(bidPackages.status, q.status));
    if (q.packageKind) filters.push(eq(bidPackages.packageKind, q.packageKind));
    if (q.tradeCode) filters.push(eq(bidPackages.tradeCode, q.tradeCode));
    const where = and(...filters);
    const [totalRow] = await app.db.select({ n: count() }).from(bidPackages).where(where);
    const items = await app.db
      .select()
      .from(bidPackages)
      .where(where)
      .orderBy(asc(bidPackages.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(
      items.map((pkg) => ({
        ...pkg,
        seal: sealState(pkg),
        timetable: timetableOf(pkg),
        requirements: requirementsOf(pkg),
      })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.get(
    "/projects/:projectId/bid-packages/:packageId",
    { preHandler: readGate },
    async (req) => {
      const { packageId } = req.params as { packageId: string };
      await sweepPrequalification(app.db, req.companyId!, req.user!.id);
      const pkg = await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      return packageDetail(app.db, pkg);
    },
  );

  app.patch(
    "/projects/:projectId/bid-packages/:packageId",
    { preHandler: standardGate },
    async (req) => {
      const { packageId } = req.params as { packageId: string };
      const body = packagePatchSchema.parse(req.body);
      const pkg = await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      if (pkg.status === "awarded" || pkg.status === "cancelled") {
        throw conflict(`A ${pkg.status} package can no longer be edited.`);
      }
      const issued = ISSUED_STATUSES.includes(pkg.status);
      if (issued) {
        const touched = BASIS_FIELDS.filter((f) => body[f] !== undefined);
        if (touched.length > 0) {
          throw conflict(
            `The evaluation basis cannot be changed after the package has been issued — ` +
              `${touched.join(", ")} ${touched.length === 1 ? "is" : "are"} frozen at issue. ` +
              "How the winner will be chosen is declared before bids open, never after the " +
              "prices are visible. Cancel and re-tender if the basis was wrong.",
          );
        }
      }
      assertWeights(
        body.priceWeight !== undefined ? (body.priceWeight ?? null) : pkg.priceWeight,
        body.qualityWeight !== undefined ? (body.qualityWeight ?? null) : pkg.qualityWeight,
      );
      assertCriteria(body.evaluationCriteria);

      const detail: Record<string, unknown> = {
        ...(pkg.detail as Record<string, unknown>),
        ...(body.detail ?? {}),
      };
      if (body.prequalificationStrictness) {
        detail["prequalificationStrictness"] = body.prequalificationStrictness;
      }
      if (body.requiresOpeningWitness !== undefined) {
        detail["requiresOpeningWitness"] = body.requiresOpeningWitness;
      }

      const patch: Partial<typeof bidPackages.$inferInsert> = { updatedAt: new Date().toISOString(), detail };
      const copy = <K extends keyof typeof body>(key: K, target = key as string) => {
        if (body[key] !== undefined) {
          (patch as Record<string, unknown>)[target] = body[key] ?? null;
        }
      };
      for (const key of [
        "title",
        "scopeDescription",
        "packageKind",
        "procurementRoute",
        "tradeCode",
        "csiDivision",
        "specSectionIds",
        "drawingSheetIds",
        "budgetLineItemIds",
        "estimatedValue",
        "engineersEstimate",
        "currency",
        "questionsDueAt",
        "bidDueAt",
        "bidValidityDays",
        "siteVisitAt",
        "anticipatedAwardDate",
        "anticipatedStartDate",
        "anticipatedCompletionDate",
        "requiredBonds",
        "insuranceRequirements",
        "prequalificationQuestionnaireId",
        "retentionPercent",
        "paymentTermsDays",
        "evaluationMethod",
        "evaluationCriteria",
        "priceWeight",
        "qualityWeight",
        "sealedUntil",
        "documentFileIds",
      ] as const) {
        copy(key);
      }
      if (body.isSiteVisitMandatory !== undefined) {
        patch.isSiteVisitMandatory = body.isSiteVisitMandatory ? 1 : 0;
      }
      if (body.prequalificationRequired !== undefined) {
        patch.prequalificationRequired = body.prequalificationRequired ? 1 : 0;
      }
      if (body.isSealed !== undefined) patch.isSealed = body.isSealed ? 1 : 0;

      await app.db.update(bidPackages).set(patch).where(eq(bidPackages.id, packageId));
      await ledger(app.db, req, "update", "bid_package", packageId, {
        projectId: req.projectId!,
        changed: Object.keys(body),
      }, req.projectId!);
      const updated = await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      return packageDetail(app.db, updated);
    },
  );

  app.delete(
    "/projects/:projectId/bid-packages/:packageId",
    { preHandler: adminGate },
    async (req, reply) => {
      const { packageId } = req.params as { packageId: string };
      const pkg = await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      if (pkg.status !== "draft") {
        throw conflict(
          `Only a draft package can be deleted; this one is ${pkg.status}. Cancel it instead — ` +
            "the record of a tender that went out and was abandoned is itself worth keeping.",
        );
      }
      const [invited] = await app.db
        .select({ n: count() })
        .from(bidInvitations)
        .where(eq(bidInvitations.packageId, packageId));
      if (Number(invited?.n ?? 0) > 0) {
        throw conflict("This package has invitations against it and cannot be deleted. Cancel it.");
      }
      await app.db.delete(bidPackages).where(eq(bidPackages.id, packageId));
      await ledger(app.db, req, "delete", "bid_package", packageId, {
        projectId: req.projectId!,
        reference: pkg.reference,
      }, req.projectId!);
      return reply.status(204).send();
    },
  );

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Approval to go out to tender. Never the person who wrote the package:
   * the schema comment says so and so does this route.
   */
  app.post(
    "/projects/:projectId/bid-packages/:packageId/approve",
    { preHandler: standardGate },
    async (req) => {
      const { packageId } = req.params as { packageId: string };
      const pkg = await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      if (pkg.approvedBy) throw conflict("This package has already been approved for issue.");
      if (pkg.status !== "draft" && pkg.status !== "prequalification") {
        throw conflict(`A ${pkg.status} package is past the point of approval to tender.`);
      }
      assertSegregation(req.user!.id, { createdBy: pkg.createdBy }, "bid package");
      const now = new Date().toISOString();
      await app.db
        .update(bidPackages)
        .set({ approvedBy: req.user!.id, approvedAt: now, updatedAt: now })
        .where(eq(bidPackages.id, packageId));
      await ledger(app.db, req, "state_change", "bid_package", packageId, {
        projectId: req.projectId!,
        approvedBy: req.user!.id,
        createdBy: pkg.createdBy,
        reference: pkg.reference,
      }, req.projectId!, true);
      return packageDetail(
        app.db,
        await fetchPackage(app.db, packageId, req.companyId!, req.projectId!),
      );
    },
  );

  app.post(
    "/projects/:projectId/bid-packages/:packageId/issue",
    { preHandler: standardGate },
    async (req) => {
      const { packageId } = req.params as { packageId: string };
      const pkg = await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      if (ISSUED_STATUSES.includes(pkg.status)) {
        throw conflict(`This package is already ${pkg.status}.`);
      }
      if (!pkg.approvedBy) {
        throw conflict(
          "This package has not been approved for issue. Somebody other than its author has to " +
            "agree the scope, the timetable and the evaluation basis before it goes to market.",
        );
      }
      if (!pkg.bidDueAt) {
        throw badRequest(
          "Set bidDueAt before issuing. A tender with no deadline has no late bids — and no " +
            "fair ones either.",
        );
      }
      const now = new Date().toISOString();
      await app.db
        .update(bidPackages)
        .set({ status: "invitations_sent", issuedAt: now, updatedAt: now })
        .where(eq(bidPackages.id, packageId));
      await ledger(app.db, req, "state_change", "bid_package", packageId, {
        projectId: req.projectId!,
        from: pkg.status,
        to: "invitations_sent",
        bidDueAt: pkg.bidDueAt,
        isSealed: pkg.isSealed,
        sealedUntil: pkg.sealedUntil,
      }, req.projectId!, true);
      return packageDetail(
        app.db,
        await fetchPackage(app.db, packageId, req.companyId!, req.projectId!),
      );
    },
  );

  app.post(
    "/projects/:projectId/bid-packages/:packageId/close",
    { preHandler: standardGate },
    async (req) => {
      const { packageId } = req.params as { packageId: string };
      const pkg = await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      if (!ISSUED_STATUSES.includes(pkg.status)) {
        throw conflict(`A ${pkg.status} package cannot be closed to bids.`);
      }
      const now = new Date().toISOString();
      await app.db
        .update(bidPackages)
        .set({ status: "closed", updatedAt: now })
        .where(eq(bidPackages.id, packageId));
      await ledger(app.db, req, "state_change", "bid_package", packageId, {
        projectId: req.projectId!,
        from: pkg.status,
        to: "closed",
      }, req.projectId!);
      return packageDetail(
        app.db,
        await fetchPackage(app.db, packageId, req.companyId!, req.projectId!),
      );
    },
  );

  app.post(
    "/projects/:projectId/bid-packages/:packageId/cancel",
    { preHandler: standardGate },
    async (req) => {
      const { packageId } = req.params as { packageId: string };
      const { reason } = z.object({ reason: reasonSchema }).parse(req.body);
      const pkg = await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      if (pkg.status === "awarded") {
        throw conflict("An awarded package cannot be cancelled — terminate the commitment instead.");
      }
      const now = new Date().toISOString();
      await app.db
        .update(bidPackages)
        .set({ status: "cancelled", cancelledReason: reason, updatedAt: now })
        .where(eq(bidPackages.id, packageId));
      await ledger(app.db, req, "state_change", "bid_package", packageId, {
        projectId: req.projectId!,
        from: pkg.status,
        to: "cancelled",
        reason,
      }, req.projectId!, true);
      return packageDetail(
        app.db,
        await fetchPackage(app.db, packageId, req.companyId!, req.projectId!),
      );
    },
  );

  /* ---------------------------------------------------------------- */
  /* THE OPENING — the moment the seal lawfully breaks                 */
  /* ---------------------------------------------------------------- */

  /**
   * Breaking the seal. Refused before the time, refused without a witness
   * where one is required, refused twice, and ledgered with opener, witness
   * and the number of bids that were in the room — because "nobody saw a
   * price before the deadline" has to be provable, not asserted.
   */
  app.post(
    "/projects/:projectId/bid-packages/:packageId/open",
    { preHandler: standardGate },
    async (req) => {
      const { packageId } = req.params as { packageId: string };
      const body = openSchema.parse(req.body ?? {});
      const pkg = await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      const opener = req.user!.id;

      const permitted = assertOpeningPermitted(pkg, {
        openerId: opener,
        witnessId: body.witnessUserId ?? null,
        note: body.note ?? null,
      });

      const now = new Date().toISOString();
      const subs = await app.db
        .select()
        .from(bidSubmissions)
        .where(
          and(
            eq(bidSubmissions.packageId, packageId),
            inArray(bidSubmissions.status, ["submitted", "received"]),
          ),
        );

      await app.db
        .update(bidPackages)
        .set({
          openedAt: now,
          openedBy: opener,
          witnessedBy: permitted.witnessId,
          status: pkg.status === "closed" ? "under_evaluation" : pkg.status,
          detail: {
            ...(pkg.detail as Record<string, unknown>),
            openingWitnessName: body.witnessName ?? null,
            openingNote: body.note ?? null,
          },
          updatedAt: now,
        })
        .where(eq(bidPackages.id, packageId));

      for (const sub of subs) {
        await app.db
          .update(bidSubmissions)
          .set({ openedAt: now, openedBy: opener, status: "opened", updatedAt: now })
          .where(eq(bidSubmissions.id, sub.id));
      }

      await ledger(
        app.db,
        req,
        "state_change",
        "bid_package",
        packageId,
        {
          projectId: req.projectId!,
          event: "sealed_bid_opening",
          reference: pkg.reference,
          openedAt: now,
          openedBy: opener,
          witnessedBy: permitted.witnessId,
          witnessName: body.witnessName ?? null,
          witnessRequired: permitted.requiresWitness,
          sealLiftedDueAt: permitted.opensAt,
          bidsInTheRoom: subs.length,
          submissionIds: subs.map((s) => s.id),
          sealedHashes: subs.map((s) => ({ id: s.id, sha256: s.sealedSha256 })),
          note: body.note ?? null,
        },
        req.projectId!,
        true,
      );

      const opened = await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      return {
        ...(await packageDetail(app.db, opened)),
        opening: {
          openedAt: now,
          openedBy: opener,
          witnessedBy: permitted.witnessId,
          witnessName: body.witnessName ?? null,
          sealLiftedDueAt: permitted.opensAt,
          bidsOpened: subs.length,
          note:
            `The seal was broken at ${now} by ${opener}` +
            (permitted.witnessId ? ` in the presence of ${permitted.witnessId}` : "") +
            `. ${subs.length} bid(s) were in the room. Submitted amounts are readable from here on.`,
        },
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Addenda                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * An addendum changes the question every bidder is answering. It is counted
   * on the package, carried to every live invitation for acknowledgement, and
   * usually buys the bidders more time — a scope change three days before the
   * deadline with no extension is how a package gets priced by guesswork.
   */
  app.post(
    "/projects/:projectId/bid-packages/:packageId/addenda",
    { preHandler: standardGate },
    async (req, reply) => {
      const { packageId } = req.params as { packageId: string };
      const body = addendumSchema.parse(req.body);
      const pkg = await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      if (pkg.status === "awarded" || pkg.status === "cancelled") {
        throw conflict(`A ${pkg.status} package cannot take an addendum.`);
      }
      const existing = addendaOf(pkg);
      if (existing.some((a) => a.reference === body.reference)) {
        throw conflict(`Addendum "${body.reference}" has already been issued on this package.`);
      }
      const now = new Date().toISOString();
      const addendum: Addendum = {
        reference: body.reference,
        description: body.description,
        fileIds: body.fileIds ?? [],
        issuedAt: now,
        issuedBy: req.user!.id,
        requiresAcknowledgement: body.requiresAcknowledgement,
        previousBidDueAt: pkg.bidDueAt,
        newBidDueAt: body.newBidDueAt ?? null,
      };
      if (body.newBidDueAt && pkg.bidDueAt && epochMs(body.newBidDueAt)! < epochMs(pkg.bidDueAt)!) {
        throw badRequest(
          "An addendum may extend the bid deadline but never shorten it — bidders have already " +
            "planned around the published date.",
        );
      }
      await app.db
        .update(bidPackages)
        .set({
          addendaCount: existing.length + 1,
          bidDueAt: body.newBidDueAt ?? pkg.bidDueAt,
          detail: { ...(pkg.detail as Record<string, unknown>), addenda: [...existing, addendum] },
          updatedAt: now,
        })
        .where(eq(bidPackages.id, packageId));
      await ledger(app.db, req, "update", "bid_package", packageId, {
        projectId: req.projectId!,
        event: "addendum_issued",
        addendum,
      }, req.projectId!, true);
      return reply.status(201).send({
        addendum,
        addendaCount: existing.length + 1,
        bidDueAt: body.newBidDueAt ?? pkg.bidDueAt,
        note: body.requiresAcknowledgement
          ? "Every live invitation must now acknowledge this addendum. A bid submitted without " +
            "acknowledging it was priced against a different scope."
          : "Acknowledgement is not required for this addendum.",
      });
    },
  );

  app.get(
    "/projects/:projectId/bid-packages/:packageId/addenda",
    { preHandler: readGate },
    async (req) => {
      const { packageId } = req.params as { packageId: string };
      const pkg = await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      const invites = await app.db
        .select()
        .from(bidInvitations)
        .where(eq(bidInvitations.packageId, packageId));
      const addenda = addendaOf(pkg);
      return {
        items: addenda.map((a) => {
          const acknowledgedBy = invites
            .filter((inv) =>
              ((inv.addendaAcknowledged as { addendumRef?: string }[]) ?? []).some(
                (ack) => ack.addendumRef === a.reference,
              ),
            )
            .map((inv) => inv.vendorId);
          return {
            ...a,
            acknowledgedBy,
            outstandingFrom: invites
              .filter(
                (inv) =>
                  !acknowledgedBy.includes(inv.vendorId) &&
                  inv.status !== "declined" &&
                  inv.status !== "withdrawn" &&
                  inv.status !== "disqualified",
              )
              .map((inv) => inv.vendorId),
          };
        }),
        total: addenda.length,
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Bid tabulation — the report, still bound by the seal               */
  /* ---------------------------------------------------------------- */

  app.get(
    "/projects/:projectId/bid-packages/:packageId/tabulation",
    { preHandler: readGate },
    async (req) => {
      const { packageId } = req.params as { packageId: string };
      const pkg = await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      const seal = sealState(pkg);
      const subs = await app.db
        .select()
        .from(bidSubmissions)
        .where(eq(bidSubmissions.packageId, packageId))
        .orderBy(asc(bidSubmissions.createdAt));
      const vendorRows = subs.length
        ? await app.db
            .select({ id: vendors.id, name: vendors.name })
            .from(vendors)
            .where(inArray(vendors.id, [...new Set(subs.map((s) => s.vendorId))]))
        : [];
      const vendorName = new Map(vendorRows.map((v) => [v.id, v.name] as const));

      const rows = await Promise.all(
        subs.map(async (s) => {
          const status = await vendorPrequalStatus(app.db, req.companyId!, s.vendorId);
          const cap = effectiveLimit(status);
          const limitCheck = seal.amountsWithheld
            ? null
            : checkContractAgainstLimit({
                contractValue: s.totalAmount,
                contractCurrency: s.currency,
                limit: cap.limit,
                limitCurrency: cap.currency,
                vendorName: vendorName.get(s.vendorId) ?? s.vendorId,
                basis: cap.basis,
              });
          const redacted = redactSubmission(s, seal);
          return {
            ...redacted,
            vendorName: vendorName.get(s.vendorId) ?? null,
            prequalification: {
              state: status.state,
              expiresAt: status.expiresAt,
              note: status.note,
            },
            capacity: limitCheck,
          };
        }),
      );

      return {
        package: {
          id: pkg.id,
          reference: pkg.reference,
          title: pkg.title,
          currency: pkg.currency,
          engineersEstimate: pkg.engineersEstimate,
          evaluationMethod: pkg.evaluationMethod,
          status: pkg.status,
        },
        seal,
        asOf: todayIso(),
        rows,
        market: estimateComparison(pkg, seal, subs),
      };
    },
  );
};
