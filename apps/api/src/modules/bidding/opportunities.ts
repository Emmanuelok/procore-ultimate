import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import {
  bidOpportunities,
  bidPackages,
  projects,
  tenderCosts,
  vendors,
} from "@constructos/db";
import {
  BID_NO_BID_DECISIONS,
  BID_NO_BID_FACTORS,
  LIVE_OPPORTUNITY_STAGES,
  OPPORTUNITY_SOURCES,
  OPPORTUNITY_STAGES,
  PROCUREMENT_ROUTES,
  TENDER_COST_KINDS,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import type { Db } from "../../lib/db.js";
import {
  currencySchema,
  detailSchema,
  isoDateSchema,
  isoTimestampSchema,
  justificationSchema,
  known,
  nonNegativeMoneySchema,
  pad4,
  reasonSchema,
  round2,
  todayIso,
  unknowable,
  type Unknowable,
} from "./shared.js";
import {
  buildWinFeatures,
  costOfSale,
  estimateWinProbability,
  scoreBidNoBid,
  winRates,
  WIN_MODEL_VERSION,
  type CostRow,
  type FactorScore,
  type OutcomeRow,
  type TrainingRow,
} from "./analytics-math.js";

/**
 * THE OPPORTUNITY PIPELINE AND THE BID/NO-BID DECISION (#1048, #1051, #1052).
 *
 * A tender register starts too late. By the time a bid package exists,
 * somebody has already made the decision that costs the most money to get
 * wrong: whether to chase this job at all. That decision is usually taken in
 * a meeting, recorded in nobody's system, and defended afterwards from
 * memory.
 *
 * So it is modelled as a gate with three separate things kept apart:
 *
 *  THE SCORE      a weighted judgement the bid team records against declared
 *                 factors. It suggests; it never decides.
 *  THE PROBABILITY  an inference fitted from what actually happened on this
 *                 company's last tenders. Where there is not enough history
 *                 to infer anything, it is `{ value: null, reasons }` — never
 *                 the base rate wearing a decimal point.
 *  THE DECISION   what the bid team actually did, with its reason, recorded
 *                 whether or not it agreed with either of the above. The
 *                 interesting ones are the disagreements.
 *
 * And the cost. Tendering is the largest unmeasured overhead in most
 * contracting businesses: the hours are real, they are spent before any
 * revenue exists, and almost nobody totals them by outcome. `tender_costs`
 * makes "we spent 2,900 hours on tenders we lost" a figure rather than a
 * feeling.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it does not forecast the market, price
 * the job, or tell anybody to bid. It records a decision, its basis, and what
 * happened next, so the next decision can be taken with evidence.
 */

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const competitorSchema = z.object({
  name: z.string().trim().min(1).max(200),
  vendorId: z.string().min(1).max(64).nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
});

const factorSchema = z.object({
  factor: z.union([z.enum(BID_NO_BID_FACTORS), z.string().trim().min(1).max(60)]),
  /** 0..10 — how strongly this factor argues for bidding */
  score: z.number().finite().min(0).max(10),
  weight: z.number().finite().min(0).max(100),
  note: z.string().max(2000).nullable().optional(),
});

const opportunityMutable = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(20000).nullable().optional(),
  clientName: z.string().max(300).nullable().optional(),
  clientVendorId: z.string().min(1).max(64).nullable().optional(),
  clientContactId: z.string().min(1).max(64).nullable().optional(),
  sector: z.string().max(120).nullable().optional(),
  workType: z.string().max(120).nullable().optional(),
  tradeCode: z.string().max(60).nullable().optional(),
  region: z.string().max(120).nullable().optional(),
  country: z.string().max(120).nullable().optional(),
  source: z.enum(OPPORTUNITY_SOURCES).optional(),
  procurementRoute: z.enum(PROCUREMENT_ROUTES).nullable().optional(),
  estimatedValue: nonNegativeMoneySchema.nullable().optional(),
  currency: currencySchema.optional(),
  expectedMarginPercent: z.number().finite().min(-100).max(100).nullable().optional(),
  expressionOfInterestDueAt: isoTimestampSchema.nullable().optional(),
  submissionDueAt: isoTimestampSchema.nullable().optional(),
  decisionExpectedAt: isoDateSchema.nullable().optional(),
  anticipatedStartDate: isoDateSchema.nullable().optional(),
  durationMonths: z.number().finite().min(0).max(600).nullable().optional(),
  peakResourceUnits: z.number().finite().min(0).nullable().optional(),
  resourceUnitLabel: z.string().max(60).nullable().optional(),
  competitors: z.array(competitorSchema).max(50).optional(),
  ownerUserId: z.string().min(1).max(64).nullable().optional(),
  projectId: z.string().min(1).max(64).nullable().optional(),
  bidPackageId: z.string().min(1).max(64).nullable().optional(),
  detail: detailSchema.optional(),
});

const opportunityCreateSchema = opportunityMutable.extend({
  title: z.string().trim().min(1).max(300),
});

const decideSchema = z.object({
  decision: z.enum(BID_NO_BID_DECISIONS).refine((d) => d !== "pending", {
    message: "A decision of 'pending' is the absence of a decision, not one.",
  }),
  factors: z.array(factorSchema).max(30).optional(),
  /** why — recorded whether or not it agrees with the score */
  basis: justificationSchema,
});

const outcomeSchema = z.object({
  outcome: z.enum(["won", "lost", "no_bid", "abandoned"]),
  reason: reasonSchema.optional(),
  submittedAmount: nonNegativeMoneySchema.nullable().optional(),
  winningCompetitor: z.string().max(200).nullable().optional(),
  winningAmount: nonNegativeMoneySchema.nullable().optional(),
});

const costSchema = z.object({
  opportunityId: z.string().min(1).max(64).nullable().optional(),
  packageId: z.string().min(1).max(64).nullable().optional(),
  projectId: z.string().min(1).max(64).nullable().optional(),
  kind: z.enum(TENDER_COST_KINDS),
  description: z.string().trim().min(1).max(2000),
  incurredOn: isoDateSchema,
  hours: z.number().finite().min(0).max(10000).nullable().optional(),
  hourlyRate: nonNegativeMoneySchema.nullable().optional(),
  amount: nonNegativeMoneySchema.optional(),
  currency: currencySchema.optional(),
  userId: z.string().min(1).max(64).nullable().optional(),
  vendorId: z.string().min(1).max(64).nullable().optional(),
  invoiceReference: z.string().max(200).nullable().optional(),
  fileIds: z.array(z.string().min(1).max(64)).max(50).optional(),
  detail: detailSchema.optional(),
});

export const opportunityReference = (n: number): string => `OPP-${pad4(n)}`;

/* ------------------------------------------------------------------ */
/* Pipeline arithmetic                                                 */
/* ------------------------------------------------------------------ */

export interface PipelineBucket {
  currency: string;
  stages: Array<{ stage: string; count: number; value: number | null }>;
  liveCount: number;
  liveValue: number | null;
  /** value x probability, summed, over the pursuits that carry a probability */
  weightedValue: Unknowable;
  weightedFrom: number;
  unweighted: number;
}

/**
 * The pipeline, bucketed by currency and never summed across one. The
 * weighted value is deliberately incomplete: it sums only the pursuits that
 * carry a modelled probability, and says how many it left out. A weighted
 * pipeline that silently treats "we do not know" as 50% is a forecast built
 * on a coin toss.
 */
export function pipelineBuckets(
  rows: readonly {
    stage: string;
    currency: string;
    estimatedValue: number | null;
    winProbability: number | null;
  }[],
): PipelineBucket[] {
  const currencies = [...new Set(rows.map((r) => r.currency.toUpperCase()))].sort();
  return currencies.map((currency) => {
    const mine = rows.filter((r) => r.currency.toUpperCase() === currency);
    const live = mine.filter((r) =>
      (LIVE_OPPORTUNITY_STAGES as readonly string[]).includes(r.stage),
    );
    const priced = live.filter((r) => r.estimatedValue !== null);
    const weighted = live.filter(
      (r) => r.estimatedValue !== null && r.winProbability !== null,
    );
    const unweighted = live.length - weighted.length;
    return {
      currency,
      stages: OPPORTUNITY_STAGES.map((stage) => {
        const group = mine.filter((r) => r.stage === stage);
        const withValue = group.filter((r) => r.estimatedValue !== null);
        return {
          stage,
          count: group.length,
          value:
            withValue.length === 0
              ? null
              : round2(withValue.reduce((s, r) => s + (r.estimatedValue ?? 0), 0)),
        };
      }).filter((s) => s.count > 0),
      liveCount: live.length,
      liveValue:
        priced.length === 0
          ? null
          : round2(priced.reduce((s, r) => s + (r.estimatedValue ?? 0), 0)),
      weightedValue:
        weighted.length === 0
          ? unknowable<number>(
              live.length === 0
                ? "Nothing is live in this currency."
                : `None of the ${live.length} live pursuit(s) in ${currency} carries both a value ` +
                  "and a modelled win probability, so there is nothing to weight. A weighted " +
                  "pipeline built by assuming a probability is a forecast built on an assumption.",
            )
          : known(
              round2(
                weighted.reduce(
                  (s, r) => s + (r.estimatedValue ?? 0) * (r.winProbability ?? 0),
                  0,
                ),
              ),
            ),
      weightedFrom: weighted.length,
      unweighted,
    };
  });
}

export interface CapacityView {
  unit: string | null;
  committed: number | null;
  pursued: number | null;
  weightedPursued: number | null;
  note: string;
}

/**
 * Capacity: what winning everything currently in the pipeline would require.
 * Expressed in whatever unit the company records (crews, operatives, £/month
 * of turnover) — the platform does not know what a "unit" is here and does
 * not pretend to.
 */
export function capacityView(
  rows: readonly {
    stage: string;
    peakResourceUnits: number | null;
    resourceUnitLabel: string | null;
    winProbability: number | null;
  }[],
): CapacityView {
  const live = rows.filter((r) =>
    (LIVE_OPPORTUNITY_STAGES as readonly string[]).includes(r.stage),
  );
  const withUnits = live.filter((r) => r.peakResourceUnits !== null);
  const units = [
    ...new Set(withUnits.map((r) => r.resourceUnitLabel).filter((x): x is string => Boolean(x))),
  ];
  if (withUnits.length === 0) {
    return {
      unit: null,
      committed: null,
      pursued: null,
      weightedPursued: null,
      note:
        "No live pursuit records the resource it would consume, so the pipeline cannot say " +
        "whether winning it is possible. Record peakResourceUnits on the pursuits that matter — " +
        "a pipeline that only counts value tells you what you might earn and nothing about " +
        "whether you could deliver it.",
    };
  }
  if (units.length > 1) {
    return {
      unit: null,
      committed: null,
      pursued: null,
      weightedPursued: null,
      note:
        `Live pursuits record their resource in different units (${units.join(", ")}), and this ` +
        "platform does not convert between units nobody defined. Use one unit across the " +
        "pipeline for the total to mean anything.",
    };
  }
  const pursued = round2(withUnits.reduce((s, r) => s + (r.peakResourceUnits ?? 0), 0));
  const weightedRows = withUnits.filter((r) => r.winProbability !== null);
  return {
    unit: units[0] ?? null,
    committed: null,
    pursued,
    weightedPursued:
      weightedRows.length === 0
        ? null
        : round2(
            weightedRows.reduce(
              (s, r) => s + (r.peakResourceUnits ?? 0) * (r.winProbability ?? 0),
              0,
            ),
          ),
    note:
      `Winning every live pursuit would need ${pursued} ${units[0]}` +
      (weightedRows.length > 0
        ? `; weighted by the modelled probabilities of the ${weightedRows.length} pursuit(s) ` +
          "that carry one, the expectation is lower"
        : "") +
      ". The comparison that matters is against what the business can actually staff, which " +
      "this module does not know and does not guess.",
  };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export const opportunityRoutes: FastifyPluginAsync = async (app) => {
  const memberGate = [app.authenticate, app.requireCompany];
  const writeGate = [app.authenticate, app.requireCompany];
  const BASE = "/companies/current/opportunities";

  async function fetchOpportunity(id: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(bidOpportunities)
      .where(and(eq(bidOpportunities.id, id), eq(bidOpportunities.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Opportunity not found");
    return rows[0];
  }

  async function assertProject(projectId: string, companyId: string): Promise<void> {
    const rows = await app.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw badRequest("projectId does not reference a project in this company");
  }

  /** The decided history the win model is fitted on. */
  async function trainingHistory(
    db: Db,
    companyId: string,
  ): Promise<{
    rows: TrainingRow[];
    decided: (typeof bidOpportunities.$inferSelect)[];
  }> {
    const decided = await db
      .select()
      .from(bidOpportunities)
      .where(
        and(
          eq(bidOpportunities.companyId, companyId),
          inArray(bidOpportunities.outcome, ["won", "lost"]),
        ),
      )
      .orderBy(asc(bidOpportunities.createdAt))
      .limit(1000);
    const medianValue = medianOfValues(decided.map((d) => d.estimatedValue));
    const rows: TrainingRow[] = decided.map((d) => {
      const priorSameClient = decided.filter(
        (o) =>
          o.id !== d.id &&
          o.createdAt < d.createdAt &&
          ((d.clientVendorId && o.clientVendorId === d.clientVendorId) ||
            (!d.clientVendorId && d.clientName && o.clientName === d.clientName)),
      );
      const priorSameType = decided.filter(
        (o) => o.id !== d.id && o.createdAt < d.createdAt && o.workType === d.workType,
      );
      return {
        features: buildWinFeatures({
          clientWins: priorSameClient.filter((o) => o.outcome === "won").length,
          clientBids: priorSameClient.length,
          workTypeWins: priorSameType.filter((o) => o.outcome === "won").length,
          workTypeBids: priorSameType.length,
          value: d.estimatedValue,
          medianDecidedValue: medianValue,
          competitorCount: ((d.competitors as unknown[]) ?? []).length,
          leadTimeDays: leadTimeDaysOf(d.createdAt, d.submissionDueAt),
        }),
        label: d.outcome === "won" ? 1 : 0,
      };
    });
    return { rows, decided };
  }

  function medianOfValues(values: readonly (number | null)[]): number | null {
    const clean = values.filter((v): v is number => v !== null && Number.isFinite(v)).sort(
      (a, b) => a - b,
    );
    if (clean.length === 0) return null;
    const mid = Math.floor(clean.length / 2);
    if (clean.length % 2 === 1) return clean[mid] ?? null;
    const a = clean[mid - 1];
    const b = clean[mid];
    return a !== undefined && b !== undefined ? (a + b) / 2 : null;
  }

  function leadTimeDaysOf(createdAt: string, dueAt: string | null): number | null {
    if (!dueAt) return null;
    const from = Date.parse(createdAt);
    const to = Date.parse(dueAt);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    return Math.max(0, Math.round((to - from) / 86_400_000));
  }

  /** Compute (and store) the win probability for one pursuit. */
  async function computeWinProbability(
    db: Db,
    companyId: string,
    row: typeof bidOpportunities.$inferSelect,
  ) {
    const { rows: history, decided } = await trainingHistory(db, companyId);
    const priorSameClient = decided.filter(
      (o) =>
        (row.clientVendorId && o.clientVendorId === row.clientVendorId) ||
        (!row.clientVendorId && row.clientName && o.clientName === row.clientName),
    );
    const priorSameType = decided.filter((o) => o.workType === row.workType);
    const features = buildWinFeatures({
      clientWins: priorSameClient.filter((o) => o.outcome === "won").length,
      clientBids: priorSameClient.length,
      workTypeWins: priorSameType.filter((o) => o.outcome === "won").length,
      workTypeBids: priorSameType.length,
      value: row.estimatedValue,
      medianDecidedValue: medianOfValues(decided.map((d) => d.estimatedValue)),
      competitorCount: ((row.competitors as unknown[]) ?? []).length,
      leadTimeDays: leadTimeDaysOf(row.createdAt, row.submissionDueAt),
    });
    return estimateWinProbability(features, history);
  }

  async function opportunityDetail(db: Db, row: typeof bidOpportunities.$inferSelect) {
    const costRows = await db
      .select()
      .from(tenderCosts)
      .where(eq(tenderCosts.opportunityId, row.id));
    const currencies = [...new Set(costRows.map((c) => c.currency.toUpperCase()))];
    const factors = (row.bidNoBidFactors as FactorScore[]) ?? [];
    const [client] = row.clientVendorId
      ? await db
          .select({ name: vendors.name })
          .from(vendors)
          .where(eq(vendors.id, row.clientVendorId))
          .limit(1)
      : [];
    const [pkg] = row.bidPackageId
      ? await db
          .select({ id: bidPackages.id, reference: bidPackages.reference, status: bidPackages.status })
          .from(bidPackages)
          .where(eq(bidPackages.id, row.bidPackageId))
          .limit(1)
      : [];
    return {
      ...row,
      clientDisplayName: row.clientName ?? client?.name ?? null,
      bidPackage: pkg ?? null,
      assessment: scoreBidNoBid(factors),
      costs: {
        entries: costRows.length,
        byCurrency: currencies.map((currency) => {
          const mine = costRows.filter((c) => c.currency.toUpperCase() === currency);
          const hourRows = mine.filter((c) => c.hours !== null);
          return {
            currency,
            total: round2(mine.reduce((s, c) => s + c.amount, 0)),
            hours:
              hourRows.length === 0
                ? null
                : round2(hourRows.reduce((s, c) => s + (c.hours ?? 0), 0)),
          };
        }),
      },
      probability: {
        value: row.winProbability,
        model: row.winProbabilityModel,
        computedAt: row.winProbabilityAt,
        basis: row.winProbabilityBasis,
      },
    };
  }

  /* ---------------------------------------------------------------- */
  /* CRUD                                                              */
  /* ---------------------------------------------------------------- */

  app.post(BASE, { preHandler: writeGate }, async (req, reply) => {
    const body = opportunityCreateSchema.parse(req.body);
    const companyId = req.companyId!;
    if (body.projectId) await assertProject(body.projectId, companyId);
    const number = await nextRecordNumber(app.db, companyId, "bid_opportunity");
    const id = newId("opp");
    await app.db.insert(bidOpportunities).values({
      id,
      companyId,
      projectId: body.projectId ?? null,
      number,
      reference: opportunityReference(number),
      title: body.title,
      description: body.description ?? null,
      clientName: body.clientName ?? null,
      clientVendorId: body.clientVendorId ?? null,
      clientContactId: body.clientContactId ?? null,
      sector: body.sector ?? null,
      workType: body.workType ?? null,
      tradeCode: body.tradeCode ?? null,
      region: body.region ?? null,
      country: body.country ?? null,
      source: body.source ?? "other",
      procurementRoute: body.procurementRoute ?? null,
      stage: "identified",
      estimatedValue: body.estimatedValue ?? null,
      currency: body.currency ?? "USD",
      expectedMarginPercent: body.expectedMarginPercent ?? null,
      expressionOfInterestDueAt: body.expressionOfInterestDueAt ?? null,
      submissionDueAt: body.submissionDueAt ?? null,
      decisionExpectedAt: body.decisionExpectedAt ?? null,
      anticipatedStartDate: body.anticipatedStartDate ?? null,
      durationMonths: body.durationMonths ?? null,
      peakResourceUnits: body.peakResourceUnits ?? null,
      resourceUnitLabel: body.resourceUnitLabel ?? null,
      competitors: body.competitors ?? [],
      ownerUserId: body.ownerUserId ?? req.user!.id,
      bidPackageId: body.bidPackageId ?? null,
      detail: body.detail ?? {},
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId,
      projectId: body.projectId ?? null,
      actorId: req.user!.id,
      action: "create",
      objectType: "bid_opportunity",
      objectId: id,
      payload: {
        reference: opportunityReference(number),
        title: body.title,
        clientName: body.clientName ?? null,
        estimatedValue: body.estimatedValue ?? null,
        currency: body.currency ?? "USD",
        source: body.source ?? "other",
      },
      storePayload: true,
    });
    return reply
      .status(201)
      .send(await opportunityDetail(app.db, await fetchOpportunity(id, companyId)));
  });

  app.get(BASE, { preHandler: memberGate }, async (req) => {
    const q = pageQuerySchema
      .extend({
        stage: z.enum(OPPORTUNITY_STAGES).optional(),
        outcome: z.enum(["won", "lost", "no_bid", "abandoned"]).optional(),
        tradeCode: z.string().max(60).optional(),
        clientVendorId: z.string().min(1).max(64).optional(),
        liveOnly: z
          .union([z.boolean(), z.string()])
          .optional()
          .transform((v) => v === true || v === "true"),
      })
      .parse(req.query);
    const filters = [eq(bidOpportunities.companyId, req.companyId!)];
    if (q.stage) filters.push(eq(bidOpportunities.stage, q.stage));
    if (q.outcome) filters.push(eq(bidOpportunities.outcome, q.outcome));
    if (q.tradeCode) filters.push(eq(bidOpportunities.tradeCode, q.tradeCode));
    if (q.clientVendorId) filters.push(eq(bidOpportunities.clientVendorId, q.clientVendorId));
    if (q.liveOnly) {
      filters.push(inArray(bidOpportunities.stage, [...LIVE_OPPORTUNITY_STAGES]));
    }
    const where = and(...filters);
    const [totalRow] = await app.db.select({ n: count() }).from(bidOpportunities).where(where);
    const items = await app.db
      .select()
      .from(bidOpportunities)
      .where(where)
      .orderBy(asc(bidOpportunities.submissionDueAt), desc(bidOpportunities.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    // The pipeline summary is computed over EVERY pursuit, not just the page:
    // a pipeline that changes when you turn the page is not a pipeline.
    const all = await app.db
      .select({
        stage: bidOpportunities.stage,
        currency: bidOpportunities.currency,
        estimatedValue: bidOpportunities.estimatedValue,
        winProbability: bidOpportunities.winProbability,
        peakResourceUnits: bidOpportunities.peakResourceUnits,
        resourceUnitLabel: bidOpportunities.resourceUnitLabel,
      })
      .from(bidOpportunities)
      .where(eq(bidOpportunities.companyId, req.companyId!));
    return {
      ...paginate(items, Number(totalRow?.n ?? 0), q),
      pipeline: pipelineBuckets(all),
      capacity: capacityView(all),
    };
  });

  app.get(`${BASE}/:opportunityId`, { preHandler: memberGate }, async (req) => {
    const { opportunityId } = req.params as { opportunityId: string };
    const row = await fetchOpportunity(opportunityId, req.companyId!);
    return opportunityDetail(app.db, row);
  });

  app.patch(`${BASE}/:opportunityId`, { preHandler: writeGate }, async (req) => {
    const { opportunityId } = req.params as { opportunityId: string };
    const body = opportunityMutable.parse(req.body);
    const row = await fetchOpportunity(opportunityId, req.companyId!);
    if (row.outcome) {
      throw conflict(
        `${row.reference} was closed as "${row.outcome}" on ${row.outcomeAt}. A decided pursuit ` +
          "is a record of what happened; editing it afterwards changes the history the win " +
          "model is fitted on.",
      );
    }
    if (body.projectId) await assertProject(body.projectId, req.companyId!);
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    for (const key of [
      "title",
      "description",
      "clientName",
      "clientVendorId",
      "clientContactId",
      "sector",
      "workType",
      "tradeCode",
      "region",
      "country",
      "source",
      "procurementRoute",
      "estimatedValue",
      "currency",
      "expectedMarginPercent",
      "expressionOfInterestDueAt",
      "submissionDueAt",
      "decisionExpectedAt",
      "anticipatedStartDate",
      "durationMonths",
      "peakResourceUnits",
      "resourceUnitLabel",
      "competitors",
      "ownerUserId",
      "projectId",
      "bidPackageId",
      "detail",
    ] as const) {
      if (body[key] !== undefined) patch[key] = body[key] ?? null;
    }
    await app.db
      .update(bidOpportunities)
      .set(patch)
      .where(eq(bidOpportunities.id, opportunityId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      projectId: row.projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "bid_opportunity",
      objectId: opportunityId,
      payload: { reference: row.reference, changed: Object.keys(body) },
    });
    return opportunityDetail(app.db, await fetchOpportunity(opportunityId, req.companyId!));
  });

  app.post(`${BASE}/:opportunityId/stage`, { preHandler: writeGate }, async (req) => {
    const { opportunityId } = req.params as { opportunityId: string };
    const body = z
      .object({ stage: z.enum(OPPORTUNITY_STAGES), note: z.string().max(4000).optional() })
      .parse(req.body);
    const row = await fetchOpportunity(opportunityId, req.companyId!);
    if (row.outcome && (LIVE_OPPORTUNITY_STAGES as readonly string[]).includes(body.stage)) {
      throw conflict(
        `${row.reference} was closed as "${row.outcome}". Reopening a decided pursuit would ` +
          "silently change the outcome history the win model learns from.",
      );
    }
    if (body.stage === "bidding" && row.bidNoBidDecision !== "bid" && row.bidNoBidDecision !== "conditional") {
      throw conflict(
        `${row.reference} has not passed the bid/no-bid gate (the decision is currently ` +
          `"${row.bidNoBidDecision}"). Moving straight to bidding is exactly the step that gets ` +
          "taken in a corridor and defended from memory a year later. Record the decision and " +
          "its basis first.",
      );
    }
    const now = new Date().toISOString();
    await app.db
      .update(bidOpportunities)
      .set({ stage: body.stage, updatedAt: now })
      .where(eq(bidOpportunities.id, opportunityId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      projectId: row.projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "bid_opportunity",
      objectId: opportunityId,
      payload: {
        reference: row.reference,
        from: row.stage,
        to: body.stage,
        note: body.note ?? null,
      },
      storePayload: true,
    });
    return opportunityDetail(app.db, await fetchOpportunity(opportunityId, req.companyId!));
  });

  /* ---------------------------------------------------------------- */
  /* The win probability (#1048)                                       */
  /* ---------------------------------------------------------------- */

  app.post(
    `${BASE}/:opportunityId/win-probability`,
    { preHandler: writeGate },
    async (req) => {
      const { opportunityId } = req.params as { opportunityId: string };
      const row = await fetchOpportunity(opportunityId, req.companyId!);
      const result = await computeWinProbability(app.db, req.companyId!, row);
      const now = new Date().toISOString();
      await app.db
        .update(bidOpportunities)
        .set({
          winProbability: result.probability.value,
          winProbabilityModel: result.model ? WIN_MODEL_VERSION : null,
          winProbabilityAt: now,
          winProbabilityBasis: {
            basis: result.basis,
            reasons: result.probability.reasons,
            features: result.features,
            contributions: result.contributions,
            model: result.model,
          },
          updatedAt: now,
        })
        .where(eq(bidOpportunities.id, opportunityId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: row.projectId,
        actorId: req.user!.id,
        action: "update",
        objectType: "bid_opportunity",
        objectId: opportunityId,
        payload: {
          event: "win_probability_computed",
          reference: row.reference,
          probability: result.probability.value,
          model: result.model?.version ?? null,
          sampleSize: result.model?.sampleSize ?? 0,
        },
        storePayload: true,
      });
      return {
        opportunityId,
        reference: row.reference,
        ...result,
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* The bid/no-bid gate (#1048)                                       */
  /* ---------------------------------------------------------------- */

  app.post(`${BASE}/:opportunityId/decide`, { preHandler: writeGate }, async (req) => {
    const body = decideSchema.parse(req.body);
    const { opportunityId } = req.params as { opportunityId: string };
    const row = await fetchOpportunity(opportunityId, req.companyId!);
    if (row.bidNoBidDecision !== "pending") {
      throw conflict(
        `${row.reference} was already decided "${row.bidNoBidDecision}" by ` +
          `${row.bidNoBidDecidedBy} on ${row.bidNoBidDecidedAt}. Reversing a bid/no-bid decision ` +
          "is a new decision: record the reversal on the stage with its reason, so both are on " +
          "the record.",
      );
    }
    const factors = (body.factors ?? (row.bidNoBidFactors as FactorScore[]) ?? []) as FactorScore[];
    const assessment = scoreBidNoBid(factors);
    const probability = await computeWinProbability(app.db, req.companyId!, row);
    const now = new Date().toISOString();
    const stage =
      body.decision === "no_bid"
        ? "no_bid"
        : row.stage === "identified" || row.stage === "qualifying" || row.stage === "bid_no_bid"
          ? "bidding"
          : row.stage;

    await app.db
      .update(bidOpportunities)
      .set({
        bidNoBidDecision: body.decision,
        bidNoBidFactors: factors,
        bidNoBidScore: assessment.score.value,
        bidNoBidBasis: body.basis,
        bidNoBidDecidedBy: req.user!.id,
        bidNoBidDecidedAt: now,
        stage,
        winProbability: probability.probability.value,
        winProbabilityModel: probability.model ? WIN_MODEL_VERSION : null,
        winProbabilityAt: now,
        winProbabilityBasis: {
          basis: probability.basis,
          reasons: probability.probability.reasons,
          features: probability.features,
          contributions: probability.contributions,
          model: probability.model,
        },
        ...(body.decision === "no_bid"
          ? { outcome: "no_bid", outcomeAt: now, outcomeReason: body.basis }
          : {}),
        updatedAt: now,
      })
      .where(eq(bidOpportunities.id, opportunityId));

    await appendLedger(app.db, {
      companyId: req.companyId!,
      projectId: row.projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "bid_opportunity",
      objectId: opportunityId,
      payload: {
        event: "bid_no_bid_decision",
        reference: row.reference,
        decision: body.decision,
        score: assessment.score.value,
        suggested: assessment.suggested,
        againstTheScore:
          assessment.suggested !== null &&
          assessment.suggested !== "marginal" &&
          assessment.suggested !== body.decision,
        winProbability: probability.probability.value,
        basis: body.basis,
        factors,
        decidedBy: req.user!.id,
      },
      storePayload: true,
    });

    const against =
      assessment.suggested !== null &&
      assessment.suggested !== "marginal" &&
      assessment.suggested !== body.decision;
    return {
      ...(await opportunityDetail(app.db, await fetchOpportunity(opportunityId, req.companyId!))),
      assessment,
      probability,
      note: against
        ? `The scored assessment suggested "${assessment.suggested}" and the decision was ` +
          `"${body.decision}". That is not a problem — the score suggests and the bid team ` +
          "decides — but it is the decision worth revisiting when the outcome is known, and it " +
          "is on the ledger with its reason so that it can be."
        : `Decision recorded with its basis and the scored assessment behind it.`,
    };
  });

  /* ---------------------------------------------------------------- */
  /* The outcome — what the model learns from                          */
  /* ---------------------------------------------------------------- */

  app.post(`${BASE}/:opportunityId/outcome`, { preHandler: writeGate }, async (req) => {
    const body = outcomeSchema.parse(req.body);
    const { opportunityId } = req.params as { opportunityId: string };
    const row = await fetchOpportunity(opportunityId, req.companyId!);
    if (row.outcome) {
      throw conflict(`${row.reference} was already closed as "${row.outcome}" on ${row.outcomeAt}.`);
    }
    if ((body.outcome === "won" || body.outcome === "lost") && row.bidNoBidDecision === "no_bid") {
      throw badRequest(
        `${row.reference} was a no-bid, so it cannot have been won or lost. A pursuit nobody bid ` +
          "on teaches the win model nothing and must not be counted as a loss.",
      );
    }
    const now = new Date().toISOString();
    const stage =
      body.outcome === "won"
        ? "won"
        : body.outcome === "lost"
          ? "lost"
          : body.outcome === "no_bid"
            ? "no_bid"
            : "abandoned";
    await app.db
      .update(bidOpportunities)
      .set({
        outcome: body.outcome,
        outcomeAt: now,
        outcomeReason: body.reason ?? null,
        stage,
        submittedAmount: body.submittedAmount ?? row.submittedAmount,
        winningCompetitor: body.winningCompetitor ?? row.winningCompetitor,
        winningAmount: body.winningAmount ?? row.winningAmount,
        updatedAt: now,
      })
      .where(eq(bidOpportunities.id, opportunityId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      projectId: row.projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "bid_opportunity",
      objectId: opportunityId,
      payload: {
        event: "outcome_recorded",
        reference: row.reference,
        outcome: body.outcome,
        reason: body.reason ?? null,
        submittedAmount: body.submittedAmount ?? row.submittedAmount,
        winningCompetitor: body.winningCompetitor ?? null,
        winningAmount: body.winningAmount ?? null,
        modelledProbability: row.winProbability,
      },
      storePayload: true,
    });
    return {
      ...(await opportunityDetail(app.db, await fetchOpportunity(opportunityId, req.companyId!))),
      note:
        row.winProbability !== null
          ? `Outcome recorded. This pursuit was modelled at ${round2(row.winProbability * 100)}% ` +
            `and was ${body.outcome}. Every recorded outcome makes the next estimate better; a ` +
            "pipeline of pursuits with no recorded outcome makes the model impossible."
          : "Outcome recorded. It is now part of the history the win model is fitted on.",
    };
  });

  /* ---------------------------------------------------------------- */
  /* Tender cost of sale (#1051)                                       */
  /* ---------------------------------------------------------------- */

  app.post("/companies/current/tender-costs", { preHandler: writeGate }, async (req, reply) => {
    const body = costSchema.parse(req.body);
    const companyId = req.companyId!;
    if (!body.opportunityId && !body.packageId) {
      throw badRequest(
        "A tender cost belongs to a pursuit or to a package. Recording one against neither " +
          "produces an overhead figure nobody can attribute to an outcome, which is exactly the " +
          "state this register exists to end.",
      );
    }
    let projectId = body.projectId ?? null;
    let currency = body.currency ?? null;
    if (body.opportunityId) {
      const opp = await fetchOpportunity(body.opportunityId, companyId);
      projectId = projectId ?? opp.projectId;
      currency = currency ?? opp.currency;
    }
    if (body.packageId) {
      const [pkg] = await app.db
        .select()
        .from(bidPackages)
        .where(and(eq(bidPackages.id, body.packageId), eq(bidPackages.companyId, companyId)))
        .limit(1);
      if (!pkg) throw badRequest("That bid package is not in this company.");
      projectId = projectId ?? pkg.projectId;
      currency = currency ?? pkg.currency;
    }
    const derived =
      body.amount ??
      (body.hours !== null && body.hours !== undefined && body.hourlyRate !== null && body.hourlyRate !== undefined
        ? round2(body.hours * body.hourlyRate)
        : null);
    if (derived === null) {
      throw badRequest(
        "Give an amount, or hours and an hourly rate to derive one from. A cost entry with " +
          "neither records that something was done and nothing about what it cost.",
      );
    }
    if (
      body.amount !== undefined &&
      body.hours !== null &&
      body.hours !== undefined &&
      body.hourlyRate !== null &&
      body.hourlyRate !== undefined &&
      Math.abs(round2(body.hours * body.hourlyRate) - body.amount) > 0.005
    ) {
      throw badRequest(
        `Hours x rate is ${round2(body.hours * body.hourlyRate)} but the amount given is ` +
          `${body.amount}. A third figure that disagrees is refused rather than silently taken.`,
      );
    }
    const id = newId("tcs");
    await app.db.insert(tenderCosts).values({
      id,
      companyId,
      projectId,
      opportunityId: body.opportunityId ?? null,
      packageId: body.packageId ?? null,
      kind: body.kind,
      description: body.description,
      incurredOn: body.incurredOn,
      hours: body.hours ?? null,
      hourlyRate: body.hourlyRate ?? null,
      amount: derived,
      currency: currency ?? "USD",
      userId: body.userId ?? req.user!.id,
      vendorId: body.vendorId ?? null,
      invoiceReference: body.invoiceReference ?? null,
      fileIds: body.fileIds ?? [],
      detail: body.detail ?? {},
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "tender_cost",
      objectId: id,
      payload: {
        kind: body.kind,
        amount: derived,
        currency: currency ?? "USD",
        hours: body.hours ?? null,
        opportunityId: body.opportunityId ?? null,
        packageId: body.packageId ?? null,
      },
    });
    const [created] = await app.db
      .select()
      .from(tenderCosts)
      .where(eq(tenderCosts.id, id))
      .limit(1);
    return reply.status(201).send(created);
  });

  app.get("/companies/current/tender-costs", { preHandler: memberGate }, async (req) => {
    const q = pageQuerySchema
      .extend({
        opportunityId: z.string().min(1).max(64).optional(),
        packageId: z.string().min(1).max(64).optional(),
        kind: z.enum(TENDER_COST_KINDS).optional(),
      })
      .parse(req.query);
    const filters = [eq(tenderCosts.companyId, req.companyId!)];
    if (q.opportunityId) filters.push(eq(tenderCosts.opportunityId, q.opportunityId));
    if (q.packageId) filters.push(eq(tenderCosts.packageId, q.packageId));
    if (q.kind) filters.push(eq(tenderCosts.kind, q.kind));
    const where = and(...filters);
    const [totalRow] = await app.db.select({ n: count() }).from(tenderCosts).where(where);
    const items = await app.db
      .select()
      .from(tenderCosts)
      .where(where)
      .orderBy(desc(tenderCosts.incurredOn))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  /**
   * COST OF SALE BY OUTCOME (#1051). The number nobody computes: what one win
   * costs when every loss is counted against it.
   */
  app.get("/companies/current/cost-of-sale", { preHandler: memberGate }, async (req) => {
    const companyId = req.companyId!;
    const costRows = await app.db
      .select()
      .from(tenderCosts)
      .where(eq(tenderCosts.companyId, companyId))
      .limit(5000);
    const opps = await app.db
      .select()
      .from(bidOpportunities)
      .where(eq(bidOpportunities.companyId, companyId))
      .limit(2000);
    const outcomeById = new Map(opps.map((o) => [o.id, o.outcome ?? "pending"] as const));

    const rows: CostRow[] = costRows.map((c) => {
      const outcome = c.opportunityId ? (outcomeById.get(c.opportunityId) ?? "pending") : "pending";
      return {
        subjectId: c.opportunityId ?? c.packageId ?? c.id,
        outcome: outcome as CostRow["outcome"],
        amount: c.amount,
        currency: c.currency,
        hours: c.hours,
        kind: c.kind,
      };
    });
    const wonValue = new Map<string, number>();
    const winsBy = new Map<string, number>();
    for (const o of opps) {
      if (o.outcome !== "won") continue;
      const cur = o.currency.toUpperCase();
      winsBy.set(cur, (winsBy.get(cur) ?? 0) + 1);
      if (o.submittedAmount !== null || o.estimatedValue !== null) {
        wonValue.set(cur, (wonValue.get(cur) ?? 0) + (o.submittedAmount ?? o.estimatedValue ?? 0));
      }
    }
    const summaries = costOfSale(rows, wonValue, winsBy);
    return {
      currencies: summaries,
      entries: costRows.length,
      pursuits: opps.length,
      note:
        summaries.length === 0
          ? "No tender costs are recorded. Until they are, the cost of winning work is an " +
            "overhead line rather than a figure attributable to the tenders that produced it."
          : "Cost of sale belongs in the margin expectation of every bid. A business that does " +
            "not know what a win costs is pricing its work without one of its largest inputs.",
    };
  });

  /* ---------------------------------------------------------------- */
  /* Win-rate analytics (#1049)                                        */
  /* ---------------------------------------------------------------- */

  app.get("/companies/current/win-rate", { preHandler: memberGate }, async (req) => {
    const q = z
      .object({
        by: z.enum(["client", "workType", "sector", "source", "region", "competitor"]).default("client"),
      })
      .parse(req.query ?? {});
    const opps = await app.db
      .select()
      .from(bidOpportunities)
      .where(eq(bidOpportunities.companyId, req.companyId!))
      .limit(2000);

    const keyOf = (o: (typeof opps)[number]): { key: string; label: string } => {
      switch (q.by) {
        case "workType":
          return { key: o.workType ?? "__none__", label: o.workType ?? "Not recorded" };
        case "sector":
          return { key: o.sector ?? "__none__", label: o.sector ?? "Not recorded" };
        case "source":
          return { key: o.source, label: o.source };
        case "region":
          return { key: o.region ?? "__none__", label: o.region ?? "Not recorded" };
        case "competitor":
          return {
            key: o.winningCompetitor ?? "__none__",
            label: o.winningCompetitor ?? "No competitor recorded",
          };
        default:
          return {
            key: o.clientVendorId ?? o.clientName ?? "__none__",
            label: o.clientName ?? o.clientVendorId ?? "Not recorded",
          };
      }
    };

    const rows: OutcomeRow[] = opps.map((o) => {
      const { key, label } = keyOf(o);
      return {
        key,
        label,
        outcome: (o.outcome ?? "pending") as OutcomeRow["outcome"],
        value: o.submittedAmount ?? o.estimatedValue,
        currency: o.currency,
      };
    });
    const result = winRates(rows);
    const { rows: history } = await trainingHistory(app.db, req.companyId!);
    return {
      by: q.by,
      ...result,
      modelSampleSize: history.length,
      note:
        opps.length === 0
          ? "No pursuits are recorded, so there is no win rate. A win rate is a property of " +
            "recorded outcomes, and this register is where they are recorded."
          : `Win rate is computed over decided pursuits only — pending ones are counted neither ` +
            "as wins nor as losses. Value is bucketed per currency and never summed across one.",
    };
  });

  /* ---------------------------------------------------------------- */
  /* Due-soon feed, used by the workspace and the sweep                */
  /* ---------------------------------------------------------------- */

  app.get(`${BASE}/due-soon`, { preHandler: memberGate }, async (req) => {
    const q = z
      .object({ days: z.coerce.number().int().min(1).max(120).default(14) })
      .parse(req.query ?? {});
    const horizon = new Date(Date.now() + q.days * 86_400_000).toISOString();
    const rows = await app.db
      .select()
      .from(bidOpportunities)
      .where(
        and(
          eq(bidOpportunities.companyId, req.companyId!),
          inArray(bidOpportunities.stage, [...LIVE_OPPORTUNITY_STAGES]),
          isNotNull(bidOpportunities.submissionDueAt),
        ),
      )
      .orderBy(asc(bidOpportunities.submissionDueAt))
      .limit(200);
    const nowIso = new Date().toISOString();
    const items = rows
      .filter((r) => (r.submissionDueAt ?? "") <= horizon)
      .map((r) => ({
        id: r.id,
        reference: r.reference,
        title: r.title,
        clientName: r.clientName,
        stage: r.stage,
        bidNoBidDecision: r.bidNoBidDecision,
        submissionDueAt: r.submissionDueAt,
        overdue: (r.submissionDueAt ?? "") < nowIso,
        estimatedValue: r.estimatedValue,
        currency: r.currency,
        winProbability: r.winProbability,
      }));
    return {
      items,
      total: items.length,
      horizonDays: q.days,
      undecided: items.filter((i) => i.bidNoBidDecision === "pending").length,
      asOf: todayIso(),
    };
  });
};
