import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, gte, inArray, lte, ne } from "drizzle-orm";
import { z } from "zod";
import {
  budgetLineItems,
  crews,
  signals,
  siteAccessRecords,
  timecardAllocations,
  timecards,
  workers,
} from "@constructos/db";
import { newId } from "../../lib/ids.js";
import { badRequest } from "../../lib/errors.js";
import type { Db } from "../../lib/db.js";
import {
  ACCESS_GAP_MIN_DAYS,
  OVERCLAIM_PATTERN_MIN_DAYS,
  OVERCLAIM_PATTERN_MIN_HOURS,
  VARIANCE_TOLERANCE_HOURS,
  accessVariance,
  detectVariancePatterns,
  round2,
  type VariancePatternSummary,
  type VarianceRow,
} from "./hours.js";
import {
  addDays,
  companyOf,
  crewConfig,
  isoDateSchema,
  ledgerTimecards,
  projectOf,
  timecardGates,
  todayIso,
} from "./shared.js";

const periodSchema = z
  .object({ periodStart: isoDateSchema, periodEnd: isoDateSchema })
  .refine((b) => b.periodEnd >= b.periodStart, { message: "periodEnd must not precede periodStart" });

const windowQuery = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  workerId: z.string().min(1).max(64).optional(),
  crewId: z.string().min(1).max(64).optional(),
});

const costReportQuery = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  crewId: z.string().min(1).max(64).optional(),
  vendorId: z.string().min(1).max(64).optional(),
  groupBy: z.enum(["budget_line", "cost_code"]).optional(),
});

/**
 * The detectors this module owns. They are also the idempotence keys: a
 * re-run of the same window must not raise the same finding twice, and the
 * key is (detector, workerId, periodStart, periodEnd) carried in
 * `evidenceRefs` — the same idiom the workforce ghost-worker reconciliation
 * uses, because the two findings are read side by side by the same reviewer.
 */
export const TIMECARD_DETECTORS = ["timecard_hours_overclaim", "timecard_access_gap"] as const;

export const reconcileRoutes: FastifyPluginAsync = async (app) => {
  const gates = timecardGates(app);

  /**
   * Replay reconciliation 1 over a window: every card's claim against the
   * INDEPENDENT site-access stream. Pure read — the engine is the same one
   * the write path calls, so the review screen and the finding can never
   * disagree.
   */
  async function computeReconciliation(
    companyId: string,
    projectId: string,
    from: string,
    to: string,
    filters: { workerId?: string | undefined; crewId?: string | undefined } = {},
  ): Promise<VariancePatternSummary & { rows: VarianceRow[] }> {
    const clauses = [
      eq(timecards.companyId, companyId),
      eq(timecards.projectId, projectId),
      gte(timecards.workDate, from),
      lte(timecards.workDate, to),
      ne(timecards.status, "void"),
      ne(timecards.status, "revised"),
    ];
    if (filters.workerId) clauses.push(eq(timecards.workerId, filters.workerId));
    if (filters.crewId) clauses.push(eq(timecards.crewId, filters.crewId));

    const cards = await app.db
      .select({ card: timecards, worker: workers })
      .from(timecards)
      .innerJoin(workers, eq(workers.id, timecards.workerId))
      .where(and(...clauses))
      .orderBy(asc(timecards.workDate));
    if (cards.length === 0) {
      return {
        ...detectVariancePatterns([], { periodStart: from, periodEnd: to }),
        rows: [],
      };
    }

    const workerIds = [...new Set(cards.map((c) => c.card.workerId))];
    const access = await app.db
      .select()
      .from(siteAccessRecords)
      .where(
        and(
          inArray(siteAccessRecords.workerId, workerIds),
          gte(siteAccessRecords.accessDate, from),
          lte(siteAccessRecords.accessDate, to),
        ),
      );
    const byKey = new Map(access.map((a) => [`${a.workerId}|${a.accessDate}`, a]));

    const crewIds = [...new Set(cards.map((c) => c.card.crewId).filter((v): v is string => !!v))];
    const crewRows =
      crewIds.length > 0
        ? await app.db.select().from(crews).where(inArray(crews.id, crewIds))
        : [];
    const crewById = new Map(crewRows.map((c) => [c.id, c]));

    const rows: VarianceRow[] = cards.map(({ card, worker }) => {
      const hit = byKey.get(`${card.workerId}|${card.workDate}`) ?? null;
      const tolerance = crewConfig(card.crewId ? (crewById.get(card.crewId) ?? null) : null)
        .varianceToleranceHours;
      const variance = accessVariance({
        claimedHours: card.totalHours,
        hasAccessRecord: hit !== null,
        accessHoursOnSite: hit?.hoursOnSite ?? null,
        firstIn: hit?.firstIn ?? null,
        lastOut: hit?.lastOut ?? null,
        explanation: card.varianceExplanation,
        toleranceHours: tolerance,
      });
      return {
        timecardId: card.id,
        reference: card.reference,
        workerId: card.workerId,
        workerReference: worker.reference,
        workerName: worker.fullName,
        vendorId: card.vendorId,
        workDate: card.workDate,
        shift: card.shift,
        claimedHours: card.totalHours,
        accessHours: variance.accessHours,
        varianceHours: variance.value,
        explained: variance.explained,
        explanation: card.varianceExplanation,
        reasons: variance.reasons,
      };
    });

    const summary = detectVariancePatterns(rows, { periodStart: from, periodEnd: to });
    return { ...summary, rows };
  }

  /**
   * Run the reconciliation and PERSIST what it found.
   *
   * Two findings, deliberately different in kind and never conflated:
   *
   *  - `timecard_hours_overclaim` (high) — a repeated, unexplained claim above
   *    what the turnstile recorded. This is a finding about the claim.
   *  - `timecard_access_gap` (low) — repeated days with no usable access
   *    record at all. This is a finding about the EVIDENCE FEED, raised at low
   *    severity and worded so nobody reads it as an accusation. A control
   *    that cries fraud at a broken turnstile is switched off within a month,
   *    and then the real overclaims go unseen too.
   */
  app.post(
    "/projects/:projectId/timecards/reconcile",
    { preHandler: gates.standard },
    async (req, reply) => {
      const body = periodSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const summary = await computeReconciliation(
        companyId,
        projectId,
        body.periodStart,
        body.periodEnd,
      );

      const existing = await app.db
        .select({ detector: signals.detector, evidenceRefs: signals.evidenceRefs })
        .from(signals)
        .where(
          and(
            eq(signals.companyId, companyId),
            eq(signals.projectId, projectId),
            inArray(signals.detector, [...TIMECARD_DETECTORS]),
          ),
        );
      const seen = new Set<string>();
      for (const s of existing) {
        const ref = s.evidenceRefs as
          | { workerId?: string; periodStart?: string; periodEnd?: string }
          | null;
        if (!ref?.workerId) continue;
        if (ref.periodStart !== body.periodStart || ref.periodEnd !== body.periodEnd) continue;
        seen.add(`${s.detector}|${ref.workerId}`);
      }

      const toInsert: (typeof signals.$inferInsert)[] = [];
      for (const w of summary.workers) {
        if (w.isOverclaimPattern && !seen.has(`timecard_hours_overclaim|${w.workerId}`)) {
          seen.add(`timecard_hours_overclaim|${w.workerId}`);
          toInsert.push({
            id: newId("sig"),
            companyId,
            projectId,
            detector: "timecard_hours_overclaim",
            severity: "high",
            confidence: 1,
            title: `Timecard overclaim pattern — ${w.workerReference} (${w.unexplainedOverHours} unexplained hour(s))`,
            explanation:
              `Timecard reconciliation for ${body.periodStart} → ${body.periodEnd}: ${w.reason}. ` +
              `${w.workerName} (${w.workerReference}) claimed ${w.claimedHours} hour(s) across ` +
              `${w.days} card(s); ${w.daysCompared} of those days could be compared against the ` +
              `site-access stream, which recorded ${w.accessHours} hour(s). The site-access record ` +
              "is an independent evidence stream and a crew sheet is the claimant's own assertion, " +
              "so a persistent gap between them is where to look first. Threshold for this " +
              `finding: ${OVERCLAIM_PATTERN_MIN_DAYS} unexplained day(s) or ` +
              `${OVERCLAIM_PATTERN_MIN_HOURS} unexplained hour(s) in the window.`,
            evidenceRefs: {
              workerId: w.workerId,
              reference: w.workerReference,
              vendorId: w.vendorId,
              periodStart: body.periodStart,
              periodEnd: body.periodEnd,
              days: w.days,
              daysCompared: w.daysCompared,
              claimedHours: w.claimedHours,
              accessHours: w.accessHours,
              unexplainedOverHours: w.unexplainedOverHours,
              unexplainedOverDays: w.unexplainedOverDays,
              toleranceHours: VARIANCE_TOLERANCE_HOURS,
            },
          });
        }
        if (w.isAccessGap && !seen.has(`timecard_access_gap|${w.workerId}`)) {
          seen.add(`timecard_access_gap|${w.workerId}`);
          toInsert.push({
            id: newId("sig"),
            companyId,
            projectId,
            detector: "timecard_access_gap",
            severity: "low",
            confidence: 1,
            title: `Site-access data gap — ${w.workerReference} (${w.daysWithoutAccessRecord} day(s) unverifiable)`,
            explanation:
              `${w.daysWithoutAccessRecord} of ${w.days} timecard(s) for ${w.workerName} ` +
              `(${w.workerReference}) between ${body.periodStart} and ${body.periodEnd} have no ` +
              "usable site-access record, so those claims could be neither confirmed nor " +
              "contradicted. THIS IS NOT A FINDING AGAINST THE WORKER: a missing turnstile record " +
              "is a gap in the evidence feed, and treating it as zero hours present would " +
              "manufacture a fraud finding out of a data-quality problem. Fix the feed — check " +
              "the gate export, the biometric enrolment and any second entrance — and the " +
              `reconciliation becomes meaningful again. Threshold: ${ACCESS_GAP_MIN_DAYS} day(s).`,
            evidenceRefs: {
              workerId: w.workerId,
              reference: w.workerReference,
              vendorId: w.vendorId,
              periodStart: body.periodStart,
              periodEnd: body.periodEnd,
              days: w.days,
              daysWithoutAccessRecord: w.daysWithoutAccessRecord,
              findingKind: "data_completeness",
            },
          });
        }
      }
      for (let i = 0; i < toInsert.length; i += 200) {
        await app.db.insert(signals).values(toInsert.slice(i, i + 200));
      }

      const runId = newId("trc");
      await ledgerTimecards(app.db, req, "create", "timecard_reconciliation", runId, {
        periodStart: body.periodStart,
        periodEnd: body.periodEnd,
        timecards: summary.timecards,
        compared: summary.compared,
        withoutAccessRecord: summary.withoutAccessRecord,
        overclaimPatterns: summary.overclaimPatterns,
        accessGaps: summary.accessGaps,
        totals: summary.totals,
        signalsRaised: toInsert.length,
      });
      return reply.status(201).send({ runId, ...summary, signalsRaised: toInsert.length });
    },
  );

  /** The same engine, replayed for review. A read never writes. */
  app.get(
    "/projects/:projectId/timecards/reconciliation",
    { preHandler: gates.read },
    async (req) => {
      const q = windowQuery.parse(req.query);
      const to = q.to ?? todayIso();
      const from = q.from ?? addDays(to, -30);
      if (to < from) throw badRequest("to must not precede from");
      const summary = await computeReconciliation(companyOf(req), projectOf(req), from, to, {
        workerId: q.workerId,
        crewId: q.crewId,
      });
      return {
        ...summary,
        persisted: false,
        toleranceHours: VARIANCE_TOLERANCE_HOURS,
        thresholds: {
          overclaimMinDays: OVERCLAIM_PATTERN_MIN_DAYS,
          overclaimMinHours: OVERCLAIM_PATTERN_MIN_HOURS,
          accessGapMinDays: ACCESS_GAP_MIN_DAYS,
        },
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Labour on the cost report                                         */
  /* ---------------------------------------------------------------- */

  /**
   * What labour has landed where.
   *
   * This is the read side of reconciliation 2 — allocated hours against the
   * budget lines they were coded to. It deliberately does NOT write
   * `budget_line_items.directCosts`: the budget module owns that column and
   * posting into it from here would give the cost report two authors and no
   * way to tell which one was right. What this route guarantees instead is
   * that the figure the budget module posts is derivable, exact and
   * attributable to individual cards.
   *
   * Three buckets are reported separately because they are three different
   * problems: coded to a budget line (the good case), coded to a cost code
   * with no budget line (visible but not on the report), and not coded at all
   * (invisible until month end).
   */
  app.get("/projects/:projectId/labour-cost-report", { preHandler: gates.read }, async (req) => {
    const q = costReportQuery.parse(req.query);
    const companyId = companyOf(req);
    const projectId = projectOf(req);
    const to = q.to ?? todayIso();
    const from = q.from ?? addDays(to, -30);
    if (to < from) throw badRequest("to must not precede from");

    const clauses = [
      eq(timecards.companyId, companyId),
      eq(timecards.projectId, projectId),
      gte(timecards.workDate, from),
      lte(timecards.workDate, to),
      ne(timecards.status, "void"),
      ne(timecards.status, "revised"),
    ];
    if (q.crewId) clauses.push(eq(timecards.crewId, q.crewId));
    if (q.vendorId) clauses.push(eq(timecards.vendorId, q.vendorId));
    const cards = await app.db.select().from(timecards).where(and(...clauses));
    const cardById = new Map(cards.map((c) => [c.id, c]));

    const allocations =
      cards.length > 0
        ? await app.db
            .select()
            .from(timecardAllocations)
            .where(inArray(timecardAllocations.timecardId, cards.map((c) => c.id)))
        : [];

    const budgetIds = [
      ...new Set(allocations.map((a) => a.budgetLineItemId).filter((v): v is string => !!v)),
    ];
    const budgetRows =
      budgetIds.length > 0
        ? await app.db
            .select()
            .from(budgetLineItems)
            .where(inArray(budgetLineItems.id, budgetIds))
        : [];
    const budgetById = new Map(budgetRows.map((b) => [b.id, b]));

    interface Group {
      key: string;
      budgetLineItemId: string | null;
      costCodeId: string | null;
      costCode: string | null;
      costType: string;
      description: string | null;
      revisedBudget: number | null;
      regularHours: number;
      overtimeHours: number;
      doubleTimeHours: number;
      premiumHours: number;
      totalHours: number;
      cost: number | null;
      currency: string;
      timecardIds: Set<string>;
      workerIds: Set<string>;
      uncostedAllocations: number;
      currencies: Set<string>;
    }
    const groups = new Map<string, Group>();
    for (const a of allocations) {
      const key =
        q.groupBy === "cost_code"
          ? (a.costCodeId ?? a.costCode ?? "__uncoded__")
          : (a.budgetLineItemId ?? `cc:${a.costCodeId ?? a.costCode ?? "__uncoded__"}`);
      const budget = a.budgetLineItemId ? (budgetById.get(a.budgetLineItemId) ?? null) : null;
      let g = groups.get(key);
      if (!g) {
        g = {
          key,
          budgetLineItemId: a.budgetLineItemId,
          costCodeId: a.costCodeId,
          costCode: a.costCode ?? budget?.costCode ?? null,
          costType: a.costType,
          description: budget?.description ?? null,
          revisedBudget: budget?.revisedBudget ?? null,
          regularHours: 0,
          overtimeHours: 0,
          doubleTimeHours: 0,
          premiumHours: 0,
          totalHours: 0,
          cost: 0,
          currency: a.currency,
          timecardIds: new Set(),
          workerIds: new Set(),
          uncostedAllocations: 0,
          currencies: new Set(),
        };
        groups.set(key, g);
      }
      g.regularHours += a.regularHours;
      g.overtimeHours += a.overtimeHours;
      g.doubleTimeHours += a.doubleTimeHours;
      g.premiumHours += a.premiumHours;
      g.totalHours += a.totalHours;
      g.currencies.add(a.currency);
      if (a.cost === null) g.uncostedAllocations += 1;
      else if (g.cost !== null) g.cost += a.cost;
      g.timecardIds.add(a.timecardId);
      const card = cardById.get(a.timecardId);
      if (card) g.workerIds.add(card.workerId);
    }

    const lines = [...groups.values()].map((g) => {
      const mixedCurrency = g.currencies.size > 1;
      const reasons: string[] = [];
      if (mixedCurrency) {
        reasons.push(
          `This line carries allocations in ${[...g.currencies].join(" and ")}. Money is never ` +
            "summed across currencies, so no cost is stated for it.",
        );
      }
      if (g.uncostedAllocations > 0) {
        reasons.push(
          `${g.uncostedAllocations} allocation(s) on this line carry hours the platform holds no ` +
            "rate for, so the line's labour cost is unknown rather than understated.",
        );
      }
      return {
        budgetLineItemId: g.budgetLineItemId,
        costCodeId: g.costCodeId,
        costCode: g.costCode,
        costType: g.costType,
        description: g.description,
        revisedBudget: g.revisedBudget,
        regularHours: round2(g.regularHours),
        overtimeHours: round2(g.overtimeHours),
        doubleTimeHours: round2(g.doubleTimeHours),
        premiumHours: round2(g.premiumHours),
        totalHours: round2(g.totalHours),
        labourCost: reasons.length > 0 ? null : round2(g.cost ?? 0),
        currency: mixedCurrency ? null : [...g.currencies][0] ?? g.currency,
        timecards: g.timecardIds.size,
        workers: g.workerIds.size,
        /** true when these hours actually reach the cost report */
        onBudget: g.budgetLineItemId !== null,
        reasons,
      };
    });
    lines.sort((a, b) => b.totalHours - a.totalHours);

    const allocatedCardIds = new Set(allocations.map((a) => a.timecardId));
    const uncoded = cards.filter((c) => !allocatedCardIds.has(c.id));
    const offBudget = lines.filter((l) => !l.onBudget);
    const currencies = new Set(cards.map((c) => c.currency));

    return {
      from,
      to,
      groupBy: q.groupBy ?? "budget_line",
      lines,
      totals: {
        totalHours: round2(lines.reduce((s, l) => s + l.totalHours, 0)),
        onBudgetHours: round2(
          lines.filter((l) => l.onBudget).reduce((s, l) => s + l.totalHours, 0),
        ),
        offBudgetHours: round2(offBudget.reduce((s, l) => s + l.totalHours, 0)),
        uncodedHours: round2(uncoded.reduce((s, c) => s + c.totalHours, 0)),
        labourCost:
          lines.some((l) => l.labourCost === null) || currencies.size > 1
            ? null
            : round2(lines.reduce((s, l) => s + (l.labourCost ?? 0), 0)),
        currency: currencies.size === 1 ? [...currencies][0] ?? null : null,
      },
      /** cards in the window with no allocation at all — the invisible hours */
      uncodedTimecards: uncoded.map((c) => ({
        id: c.id,
        reference: c.reference,
        workerId: c.workerId,
        workDate: c.workDate,
        totalHours: c.totalHours,
        status: c.status,
      })),
      reasons: [
        ...(uncoded.length > 0
          ? [
              `${uncoded.length} card(s) in this window carry no cost coding at all ` +
                `(${round2(uncoded.reduce((s, c) => s + c.totalHours, 0))} hour(s)). Those hours are ` +
                "not on the cost report and will surface as an unexplained labour overrun at " +
                "month end.",
            ]
          : []),
        ...(offBudget.length > 0
          ? [
              `${offBudget.length} coding group(s) name a cost code but no budget line ` +
                `(${round2(offBudget.reduce((s, l) => s + l.totalHours, 0))} hour(s)). They are ` +
                "visible in a labour report but do not land on the budget.",
            ]
          : []),
        ...(currencies.size > 1
          ? [
              `Cards in this window are denominated in ${[...currencies].join(", ")}; no single ` +
                "labour cost is stated, because money is never summed across currencies.",
            ]
          : []),
      ],
      note:
        "This report derives labour from timecard allocations. It does not write " +
        "budget_line_items.directCosts — the budget module owns that column, and a cost report " +
        "with two authors has no author at all.",
    };
  });
};

/** Exported for tests: the engine behind both reconciliation routes. */
export async function reconciliationFor(
  db: Db,
  companyId: string,
  projectId: string,
  from: string,
  to: string,
): Promise<VariancePatternSummary> {
  const cards = await db
    .select({ card: timecards, worker: workers })
    .from(timecards)
    .innerJoin(workers, eq(workers.id, timecards.workerId))
    .where(
      and(
        eq(timecards.companyId, companyId),
        eq(timecards.projectId, projectId),
        gte(timecards.workDate, from),
        lte(timecards.workDate, to),
      ),
    );
  const access = await db
    .select()
    .from(siteAccessRecords)
    .where(eq(siteAccessRecords.projectId, projectId));
  const byKey = new Map(access.map((a) => [`${a.workerId}|${a.accessDate}`, a]));
  const rows: VarianceRow[] = cards.map(({ card, worker }) => {
    const hit = byKey.get(`${card.workerId}|${card.workDate}`) ?? null;
    const v = accessVariance({
      claimedHours: card.totalHours,
      hasAccessRecord: hit !== null,
      accessHoursOnSite: hit?.hoursOnSite ?? null,
      firstIn: hit?.firstIn ?? null,
      lastOut: hit?.lastOut ?? null,
      explanation: card.varianceExplanation,
    });
    return {
      timecardId: card.id,
      reference: card.reference,
      workerId: card.workerId,
      workerReference: worker.reference,
      workerName: worker.fullName,
      vendorId: card.vendorId,
      workDate: card.workDate,
      shift: card.shift,
      claimedHours: card.totalHours,
      accessHours: v.accessHours,
      varianceHours: v.value,
      explained: v.explained,
      explanation: card.varianceExplanation,
      reasons: v.reasons,
    };
  });
  return detectVariancePatterns(rows, { periodStart: from, periodEnd: to });
}
