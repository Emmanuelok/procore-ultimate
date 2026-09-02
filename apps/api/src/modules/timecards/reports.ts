/**
 * LABOUR REPORTS — productivity, payroll export, certified payroll (M24).
 *
 * Three questions the cost report cannot answer, and one file somebody has to
 * be able to send to a payroll bureau on a Friday afternoon:
 *
 *  1. WAS THE LABOUR WORTH IT. `computeProductivity` earns hours at the
 *     planned unit rate and states the productivity factor per budget line,
 *     per crew and per week, refusing a figure wherever an input is missing
 *     rather than defaulting a line to 1.0. A run of weeks below the floor
 *     raises `labour_productivity_deviation`.
 *  2. WHAT DOES PAYROLL GET. Generic and per-day CSV, and a WH-347 style
 *     certified payroll whose statement of compliance is deliberately NOT
 *     pre-signed.
 *  3. WHAT DOES THE COST REPORT GET. `post-to-budget` writes the window's
 *     allocated labour cost into `budget_line_items.directCosts` (#715), so
 *     the hours reach the cost report instead of living only here.
 *
 * This file deliberately does NOT re-price hours: `timecards.totalCost` is
 * the priced figure and the batch rollup is the authority on whether it can
 * be summed.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  budgetLineItems,
  costCodes,
  crews,
  payrollEntries,
  projects,
  signals,
  timecardAllocations,
  timecardBatches,
  timecards,
  vendors,
  workers,
} from "@constructos/db";
import { PAYROLL_EXPORT_FORMATS } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { forEachCompany } from "../../lib/scheduler.js";
import {
  computeProductivity,
  detectProductivityDeviation,
  PRODUCTIVITY_FLOOR,
  PRODUCTIVITY_MIN_WEEKS,
  type ProductivityAllocation,
  type ProductivityBudgetLine,
} from "./productivity.js";
import {
  buildCertifiedPayroll,
  buildDailyCsv,
  buildGenericCsv,
  certifiedPayrollToCsv,
  type PayrollCard,
} from "./payrollexport.js";
import { attachAccessLinks } from "./cards.js";
import {
  addDays,
  companyOf,
  crewConfig,
  fetchBatch,
  isoDateSchema,
  ledgerTimecards,
  nowIso,
  projectOf,
  timecardGates,
  todayIso,
} from "./shared.js";
import { round2 } from "./hours.js";

const windowQuery = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  crewId: z.string().min(1).max(64).optional(),
});

/** Statuses whose hours are a real claim on the job. */
const LIVE_STATUSES = ["draft", "submitted", "approved", "locked", "exported"];

export const timecardReportRoutes: FastifyPluginAsync = async (app) => {
  const gates = timecardGates(app);

  /* ---------------------------------------------------------------- */
  /* Productivity and earned value                                     */
  /* ---------------------------------------------------------------- */

  async function loadProductivity(
    companyId: string,
    projectId: string,
    from: string,
    to: string,
    crewId?: string,
  ) {
    const clauses = [
      eq(timecards.companyId, companyId),
      eq(timecards.projectId, projectId),
      gte(timecards.workDate, from),
      lte(timecards.workDate, to),
      ne(timecards.status, "void"),
      ne(timecards.status, "revised"),
    ];
    if (crewId) clauses.push(eq(timecards.crewId, crewId));
    const cards = await app.db.select().from(timecards).where(and(...clauses));
    if (cards.length === 0) {
      return {
        report: computeProductivity([], []),
        cards: 0,
      };
    }
    const allocations = await app.db
      .select()
      .from(timecardAllocations)
      .where(
        inArray(
          timecardAllocations.timecardId,
          cards.map((c) => c.id),
        ),
      );
    const cardById = new Map(cards.map((c) => [c.id, c] as const));
    const crewIds = [...new Set(cards.map((c) => c.crewId).filter((v): v is string => !!v))];
    const crewRows = crewIds.length
      ? await app.db.select().from(crews).where(inArray(crews.id, crewIds))
      : [];
    const crewById = new Map(crewRows.map((c) => [c.id, c] as const));

    const budgetIds = [
      ...new Set(allocations.map((a) => a.budgetLineItemId).filter((v): v is string => !!v)),
    ];
    const budgetRows = budgetIds.length
      ? await app.db
          .select()
          .from(budgetLineItems)
          .where(inArray(budgetLineItems.id, budgetIds))
      : [];

    const inputs: ProductivityAllocation[] = allocations.map((a) => {
      const card = cardById.get(a.timecardId);
      const crew = card?.crewId ? crewById.get(card.crewId) : undefined;
      return {
        budgetLineItemId: a.budgetLineItemId,
        costCodeId: a.costCodeId,
        workDate: card?.workDate ?? from,
        crewId: card?.crewId ?? null,
        crewName: crew ? `${crew.reference} ${crew.name}` : null,
        hours: a.totalHours,
        quantity: a.quantity,
        unit: a.unit,
      };
    });
    const lines: ProductivityBudgetLine[] = budgetRows.map((b) => {
      const detail = (b.detail ?? {}) as { budgetHours?: unknown };
      return {
        id: b.id,
        code: b.costCode,
        description: b.description,
        // The budget schema carries money and quantity, not hours; a tenant
        // that plans hours puts them on the line's detail. Absent, the line
        // is UNMEASURABLE rather than assumed.
        budgetHours: typeof detail.budgetHours === "number" ? detail.budgetHours : null,
        budgetQuantity: b.quantity,
        unit: b.unit,
        budgetAmount: b.revisedBudget,
        currency: null,
      };
    });

    // The pay week the crews actually run on, where they all agree.
    const weekStarts = [...new Set(crewRows.map((c) => crewConfig(c).weekStartsOn))];
    const report = computeProductivity(inputs, lines, {
      ...(weekStarts.length === 1 ? { weekStartsOn: weekStarts[0]! } : {}),
    });
    if (weekStarts.length > 1) {
      report.reasons.push(
        `The crews on this project start their pay week on ${weekStarts.length} different days, ` +
          "so the weekly trend is bucketed on Monday. Per-crew figures are unaffected.",
      );
    }
    return { report, cards: cards.length };
  }

  app.get("/projects/:projectId/labour-productivity", { preHandler: gates.read }, async (req) => {
    const q = windowQuery.parse(req.query);
    const to = q.to ?? todayIso();
    const from = q.from ?? addDays(to, -90);
    if (to < from) throw badRequest("to must not precede from");
    const { report, cards } = await loadProductivity(
      companyOf(req),
      projectOf(req),
      from,
      to,
      q.crewId,
    );
    const deviation = detectProductivityDeviation(report.weeks);
    return {
      from,
      to,
      timecards: cards,
      ...report,
      deviation,
      method:
        "earned hours = installed quantity × the budget line's planned unit rate (planned hours ÷ " +
        "planned quantity). Productivity factor = earned ÷ actual; above 1 the crew is beating " +
        "the plan. A line with no planned hours, no installed quantity or a unit that does not " +
        "match is reported as unmeasurable, never as 1.0.",
      thresholds: { floor: PRODUCTIVITY_FLOOR, minWeeks: PRODUCTIVITY_MIN_WEEKS },
    };
  });

  /** Raise the deviation signal. A read never writes; this is the writer. */
  app.post(
    "/projects/:projectId/labour-productivity/run",
    { preHandler: gates.standard },
    async (req, reply) => {
      const body = windowQuery.parse(req.body ?? {});
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const to = body.to ?? todayIso();
      const from = body.from ?? addDays(to, -90);
      const { report } = await loadProductivity(companyId, projectId, from, to, body.crewId);
      const deviation = detectProductivityDeviation(report.weeks);
      if (!deviation) {
        return reply.status(200).send({
          raised: 0,
          deviation: null,
          note:
            report.weeks.length === 0
              ? "no measurable week in this window — record installed quantity against the hours " +
                "to make productivity computable"
              : "productivity has not been under the floor for long enough to be a pattern",
        });
      }
      const key = `${projectId}|${deviation.from}|${deviation.to}`;
      const existing = await app.db
        .select({ id: signals.id })
        .from(signals)
        .where(
          and(
            eq(signals.companyId, companyId),
            eq(signals.projectId, projectId),
            eq(signals.detector, "labour_productivity_deviation"),
            sql`${signals.evidenceRefs}->>'key' = ${key}`,
          ),
        )
        .limit(1);
      if (existing[0]) {
        return reply.status(200).send({ raised: 0, deviation, signalId: existing[0].id });
      }
      const signalId = newId("sig");
      await app.db.insert(signals).values({
        id: signalId,
        companyId,
        projectId,
        detector: "labour_productivity_deviation",
        severity: deviation.averageFactor < 0.6 ? "high" : "medium",
        confidence: 1,
        title: `Labour productivity below ${PRODUCTIVITY_FLOOR} for ${deviation.weeks} weeks`,
        explanation: deviation.explanation,
        evidenceRefs: {
          key,
          from: deviation.from,
          to: deviation.to,
          weeks: deviation.weeks,
          averageFactor: deviation.averageFactor,
          worstFactor: deviation.worstFactor,
          lostHours: deviation.lostHours,
          floor: PRODUCTIVITY_FLOOR,
        },
      });
      await ledgerTimecards(app.db, req, "create", "labour_productivity_run", signalId, {
        from,
        to,
        weeks: deviation.weeks,
        averageFactor: deviation.averageFactor,
        lostHours: deviation.lostHours,
      });
      return reply.status(201).send({ raised: 1, signalId, deviation });
    },
  );

  /* ---------------------------------------------------------------- */
  /* Payroll export                                                    */
  /* ---------------------------------------------------------------- */

  async function payrollCards(
    companyId: string,
    projectId: string,
    where: ReturnType<typeof and>,
  ): Promise<PayrollCard[]> {
    const rows = await app.db
      .select({ card: timecards, worker: workers })
      .from(timecards)
      .innerJoin(workers, eq(workers.id, timecards.workerId))
      .where(where);
    if (rows.length === 0) return [];
    const crewIds = [...new Set(rows.map((r) => r.card.crewId).filter((v): v is string => !!v))];
    const vendorIds = [...new Set(rows.map((r) => r.card.vendorId).filter((v): v is string => !!v))];
    const crewRows = crewIds.length
      ? await app.db.select().from(crews).where(inArray(crews.id, crewIds))
      : [];
    const vendorRows = vendorIds.length
      ? await app.db
          .select({ id: vendors.id, name: vendors.name })
          .from(vendors)
          .where(and(eq(vendors.companyId, companyId), inArray(vendors.id, vendorIds)))
      : [];
    const allocations = await app.db
      .select({
        timecardId: timecardAllocations.timecardId,
        costCode: timecardAllocations.costCode,
        costCodeId: timecardAllocations.costCodeId,
      })
      .from(timecardAllocations)
      .where(
        inArray(
          timecardAllocations.timecardId,
          rows.map((r) => r.card.id),
        ),
      );
    const codeIds = [
      ...new Set(allocations.map((a) => a.costCodeId).filter((v): v is string => !!v)),
    ];
    const codeRows = codeIds.length
      ? await app.db
          .select({ id: costCodes.id, code: costCodes.code })
          .from(costCodes)
          .where(inArray(costCodes.id, codeIds))
      : [];
    const codeById = new Map(codeRows.map((c) => [c.id, c.code] as const));
    const crewById = new Map(crewRows.map((c) => [c.id, c] as const));
    const vendorById = new Map(vendorRows.map((v) => [v.id, v.name] as const));

    return rows.map(({ card, worker }) => ({
      id: card.id,
      reference: card.reference,
      workDate: card.workDate,
      shift: card.shift,
      workerId: card.workerId,
      workerReference: worker.reference,
      workerName: worker.fullName,
      vendorId: card.vendorId,
      vendorName: card.vendorId ? (vendorById.get(card.vendorId) ?? null) : null,
      crewReference: card.crewId ? (crewById.get(card.crewId)?.reference ?? null) : null,
      trade: card.trade,
      classification: card.classification,
      regularHours: card.regularHours,
      overtimeHours: card.overtimeHours,
      doubleTimeHours: card.doubleTimeHours,
      premiumHours: card.premiumHours,
      premiumKind: card.premiumKind,
      totalHours: card.totalHours,
      hourlyRate: card.hourlyRate,
      overtimeRate: card.overtimeRate,
      doubleTimeRate: card.doubleTimeRate,
      premiumRate: card.premiumRate,
      burdenRate: card.burdenRate,
      totalCost: card.totalCost,
      currency: card.currency,
      status: card.status,
      costCodes: [
        ...new Set(
          allocations
            .filter((a) => a.timecardId === card.id)
            .map((a) => a.costCode ?? (a.costCodeId ? codeById.get(a.costCodeId) : null))
            .filter((v): v is string => !!v),
        ),
      ],
    }));
  }

  const exportQuery = z.object({
    format: z.enum(PAYROLL_EXPORT_FORMATS).default("generic_csv"),
    /** return the file body inline as JSON rather than as a download */
    inline: z.coerce.boolean().optional(),
  });

  app.get(
    "/projects/:projectId/timecard-batches/:batchId/payroll-export",
    { preHandler: gates.admin },
    async (req, reply) => {
      const { batchId } = req.params as { batchId: string };
      const q = exportQuery.parse(req.query);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const batch = await fetchBatch(app.db, batchId, companyId, projectId);
      const cards = await payrollCards(
        companyId,
        projectId,
        and(eq(timecards.batchId, batchId), inArray(timecards.status, LIVE_STATUSES)),
      );
      if (cards.length === 0) {
        throw badRequest(
          `Batch ${batch.reference} holds no live timecards, so there is nothing to export.`,
        );
      }
      const [project] = await app.db
        .select({ name: projects.name })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      const ctx = {
        projectName: project?.name ?? projectId,
        projectId,
        batchReference: batch.reference,
        periodStart: batch.periodStart,
        periodEnd: batch.periodEnd,
        payrollBatchRef: batch.payrollBatchRef,
        generatedAt: nowIso(),
      };

      let output;
      if (q.format === "daily_csv") {
        output = buildDailyCsv(cards, ctx);
      } else if (q.format === "certified_payroll") {
        output = certifiedPayrollToCsv(
          buildCertifiedPayroll(
            cards,
            { ...ctx, weekEnding: batch.weekEnding ?? batch.periodEnd },
            await payrollByWorker(companyId, projectId, batch.periodStart, batch.periodEnd),
          ),
        );
      } else if (q.format === "json") {
        output = {
          format: "json",
          filename: `payroll-${batch.reference}.json`,
          contentType: "application/json",
          body: JSON.stringify({ context: ctx, cards }, null, 2),
          rowCount: cards.length,
          incompleteRows: cards.filter((c) => c.totalCost === null).map((c) => c.reference),
          currencies: [...new Set(cards.map((c) => c.currency))],
          reasons: [],
        };
      } else {
        output = buildGenericCsv(cards, ctx);
      }

      await ledgerTimecards(app.db, req, "access", "timecard_batch", batchId, {
        reference: batch.reference,
        export: q.format,
        rows: output.rowCount,
        incompleteRows: output.incompleteRows.length,
      });

      if (q.inline) return output;
      reply.header("content-type", output.contentType);
      reply.header("content-disposition", `attachment; filename="${output.filename}"`);
      reply.header("x-export-rows", String(output.rowCount));
      reply.header("x-export-incomplete", String(output.incompleteRows.length));
      return reply.send(output.body);
    },
  );

  /** Deductions and net pay live on ingested payroll, not on timecards. */
  async function payrollByWorker(
    companyId: string,
    projectId: string,
    from: string,
    to: string,
  ): Promise<Map<string, { deductions: number; netPay: number; currency: string }>> {
    const rows = await app.db
      .select()
      .from(payrollEntries)
      .where(
        and(
          eq(payrollEntries.companyId, companyId),
          eq(payrollEntries.projectId, projectId),
          lte(payrollEntries.periodStart, to),
          gte(payrollEntries.periodEnd, from),
        ),
      );
    const out = new Map<string, { deductions: number; netPay: number; currency: string }>();
    for (const r of rows) {
      const held = out.get(r.workerId);
      if (!held) {
        out.set(r.workerId, {
          deductions: r.deductions,
          netPay: r.netPay,
          currency: r.currency,
        });
      } else if (held.currency === r.currency) {
        held.deductions = round2(held.deductions + r.deductions);
        held.netPay = round2(held.netPay + r.netPay);
      }
    }
    return out;
  }

  app.get("/projects/:projectId/certified-payroll", { preHandler: gates.read }, async (req) => {
    const q = z
      .object({
        weekEnding: isoDateSchema,
        contractorName: z.string().max(300).optional(),
        contractNumber: z.string().max(120).optional(),
        format: z.enum(["json", "csv"]).default("json"),
      })
      .parse(req.query);
    const companyId = companyOf(req);
    const projectId = projectOf(req);
    const weekStart = addDays(q.weekEnding, -6);
    const cards = await payrollCards(
      companyId,
      projectId,
      and(
        eq(timecards.companyId, companyId),
        eq(timecards.projectId, projectId),
        gte(timecards.workDate, weekStart),
        lte(timecards.workDate, q.weekEnding),
        inArray(timecards.status, LIVE_STATUSES),
      ),
    );
    const [project] = await app.db
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const report = buildCertifiedPayroll(
      cards,
      {
        projectName: project?.name ?? projectId,
        projectId,
        batchReference: null,
        periodStart: weekStart,
        periodEnd: q.weekEnding,
        payrollBatchRef: null,
        generatedAt: nowIso(),
        weekEnding: q.weekEnding,
        ...(q.contractorName ? { contractorName: q.contractorName } : {}),
        ...(q.contractNumber ? { contractNumber: q.contractNumber } : {}),
      },
      await payrollByWorker(companyId, projectId, weekStart, q.weekEnding),
    );
    if (q.format === "csv") return certifiedPayrollToCsv(report);
    return report;
  });

  /* ---------------------------------------------------------------- */
  /* Labour cost onto the cost report (#715)                           */
  /* ---------------------------------------------------------------- */

  /**
   * Post the window's allocated labour cost onto the budget lines it was
   * coded to. This is the join the module header promises and the reason
   * allocations exist: without it, labour lives only in this module and the
   * cost report shows a job with no people on it.
   *
   * Only APPROVED and later cards are posted — a draft is a claim nobody has
   * checked, and posting it would make the cost report move every time a
   * foreman opened a form.
   */
  app.post(
    "/projects/:projectId/labour-cost-report/post-to-budget",
    { preHandler: gates.admin },
    async (req, reply) => {
      const body = z
        .object({ from: isoDateSchema.optional(), to: isoDateSchema.optional() })
        .parse(req.body ?? {});
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const to = body.to ?? todayIso();
      const from = body.from ?? addDays(to, -30);
      if (to < from) throw badRequest("to must not precede from");

      const cards = await app.db
        .select()
        .from(timecards)
        .where(
          and(
            eq(timecards.companyId, companyId),
            eq(timecards.projectId, projectId),
            gte(timecards.workDate, from),
            lte(timecards.workDate, to),
            inArray(timecards.status, ["approved", "locked", "exported"]),
          ),
        );
      if (cards.length === 0) {
        return reply.status(200).send({
          posted: 0,
          lines: [],
          reasons: [
            "no approved timecard falls in this window, so there is nothing to post. Draft and " +
              "submitted hours are deliberately not posted: they are claims nobody has checked.",
          ],
        });
      }
      const allocations = await app.db
        .select()
        .from(timecardAllocations)
        .where(
          inArray(
            timecardAllocations.timecardId,
            cards.map((c) => c.id),
          ),
        );
      const byLine = new Map<string, { cost: number; hours: number; currency: string }>();
      const reasons: string[] = [];
      let uncoded = 0;
      let uncosted = 0;
      for (const a of allocations) {
        if (!a.budgetLineItemId) {
          uncoded = round2(uncoded + a.totalHours);
          continue;
        }
        if (a.cost === null) {
          uncosted = round2(uncosted + a.totalHours);
          continue;
        }
        const held = byLine.get(a.budgetLineItemId) ?? {
          cost: 0,
          hours: 0,
          currency: a.currency,
        };
        if (held.currency !== a.currency) {
          reasons.push(
            `Budget line ${a.budgetLineItemId} has labour in both ${held.currency} and ` +
              `${a.currency}. Money is never summed across currencies, so this line was not posted.`,
          );
          byLine.delete(a.budgetLineItemId);
          continue;
        }
        held.cost = round2(held.cost + a.cost);
        held.hours = round2(held.hours + a.totalHours);
        byLine.set(a.budgetLineItemId, held);
      }
      if (uncoded > 0) {
        reasons.push(
          `${uncoded} approved hour(s) carry no budget line and were not posted. Uncoded hours ` +
            "never reach the cost report.",
        );
      }
      if (uncosted > 0) {
        reasons.push(
          `${uncosted} approved hour(s) could not be costed (no rate) and were not posted, rather ` +
            "than posted at zero.",
        );
      }

      const lineIds = [...byLine.keys()];
      const lines = lineIds.length
        ? await app.db
            .select()
            .from(budgetLineItems)
            .where(
              and(
                eq(budgetLineItems.projectId, projectId),
                inArray(budgetLineItems.id, lineIds),
              ),
            )
        : [];
      const posted: Array<{
        budgetLineItemId: string;
        costCode: string;
        labourCost: number;
        labourHours: number;
        currency: string;
      }> = [];
      const now = nowIso();
      for (const line of lines) {
        const held = byLine.get(line.id)!;
        const detail = { ...(line.detail as Record<string, unknown>) };
        const priorPosting = (detail["labourPosting"] ?? null) as {
          labourCost?: number;
        } | null;
        const previous = typeof priorPosting?.labourCost === "number" ? priorPosting.labourCost : 0;
        detail["labourPosting"] = {
          from,
          to,
          labourCost: held.cost,
          labourHours: held.hours,
          currency: held.currency,
          postedAt: now,
          postedBy: req.user!.id,
          note:
            "posted from approved timecard allocations; re-posting the same window REPLACES this " +
            "figure rather than adding to it",
        };
        await app.db
          .update(budgetLineItems)
          .set({
            // `directCosts` is the budget's column for cost booked outside a
            // commitment — labour is exactly that. Re-posting the same window
            // replaces this module's contribution rather than adding to it.
            directCosts: round2(line.directCosts - previous + held.cost),
            jobToDateCosts: round2(line.jobToDateCosts - previous + held.cost),
            detail,
            updatedAt: now,
          })
          .where(eq(budgetLineItems.id, line.id));
        posted.push({
          budgetLineItemId: line.id,
          costCode: line.costCode,
          labourCost: held.cost,
          labourHours: held.hours,
          currency: held.currency,
        });
      }
      const runId = newId("lcp");
      await ledgerTimecards(app.db, req, "update", "labour_cost_posting", runId, {
        from,
        to,
        lines: posted.length,
        hours: round2(posted.reduce((s, p) => s + p.labourHours, 0)),
        uncodedHours: uncoded,
        uncostedHours: uncosted,
      });
      return reply.status(201).send({ runId, from, to, posted: posted.length, lines: posted, reasons });
    },
  );

  /* ---------------------------------------------------------------- */
  /* Health inputs (contract 3.5)                                      */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/timecards/health-inputs", { preHandler: gates.read }, async (req) => {
    const companyId = companyOf(req);
    const projectId = projectOf(req);
    const to = todayIso();
    const from = addDays(to, -30);
    const cards = await app.db
      .select({
        id: timecards.id,
        status: timecards.status,
        varianceHours: timecards.varianceHours,
        varianceExplanation: timecards.varianceExplanation,
        totalHours: timecards.totalHours,
      })
      .from(timecards)
      .where(
        and(
          eq(timecards.companyId, companyId),
          eq(timecards.projectId, projectId),
          gte(timecards.workDate, from),
          lte(timecards.workDate, to),
          ne(timecards.status, "void"),
          ne(timecards.status, "revised"),
        ),
      );
    const unallocated = await app.db
      .select({ n: sql<number>`count(*)` })
      .from(timecards)
      .where(
        and(
          eq(timecards.companyId, companyId),
          eq(timecards.projectId, projectId),
          gte(timecards.workDate, from),
          lte(timecards.workDate, to),
          ne(timecards.status, "void"),
          sql`not exists (select 1 from ${timecardAllocations} where ${timecardAllocations.timecardId} = ${timecards.id})`,
        ),
      );
    const openBatches = await app.db
      .select({ n: sql<number>`count(*)` })
      .from(timecardBatches)
      .where(
        and(
          eq(timecardBatches.companyId, companyId),
          eq(timecardBatches.projectId, projectId),
          inArray(timecardBatches.status, ["submitted", "partially_approved"]),
        ),
      );
    const exceptions = cards.filter(
      (c) => c.varianceHours !== null && c.varianceHours > 0.5 && !(c.varianceExplanation ?? "").trim(),
    ).length;
    const { report } = await loadProductivity(companyId, projectId, addDays(to, -90), to);
    const reasons: string[] = [];
    if (cards.length === 0) {
      reasons.push("no timecards in the last 30 days, so the labour metrics are null, not zero");
    }
    if (report.totals.productivityFactor === null) {
      reasons.push(
        "productivity is not computable: " +
          (report.reasons[0] ?? "no budget line carries both planned hours and installed quantity"),
      );
    }
    return {
      metrics: {
        timecards30d: cards.length,
        hours30d: cards.length === 0 ? null : round2(cards.reduce((s, c) => s + c.totalHours, 0)),
        unexplainedVarianceCards: cards.length === 0 ? null : exceptions,
        unallocatedCards: Number(unallocated[0]?.n ?? 0),
        batchesAwaitingApproval: Number(openBatches[0]?.n ?? 0),
        productivityFactor: report.totals.productivityFactor,
      },
      reasons,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Scheduled jobs (plan §6.1)                                        */
  /* ---------------------------------------------------------------- */

  app.scheduler.register({
    name: "timecards.access-links",
    description:
      "Attach site-access records that landed after the timecard did, and recompute the " +
      "claimed-vs-present variance — moved off the list read, which was writing under a " +
      "read-only permission",
    everyMs: 6 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db }) =>
      forEachCompany(db, async (companyId) => {
        const projectRows = await db
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.companyId, companyId));
        let linked = 0;
        for (const project of projectRows) {
          const result = await attachAccessLinks(db, companyId, project.id);
          linked += result.linked;
        }
        return { linked };
      }),
  });

  app.scheduler.register({
    name: "timecards.orphan-cards",
    description:
      "Flag approved timecards outside any batch — hours that were approved and will never " +
      "reach a payroll export",
    everyMs: 24 * 60 * 60_000,
    runOnBoot: false,
    run: async ({ db }) =>
      forEachCompany(db, async (companyId) => {
        const today = new Date().toISOString().slice(0, 10);
        const cutoff = addDays(today, -14);
        const orphans = await db
          .select({
            id: timecards.id,
            projectId: timecards.projectId,
            reference: timecards.reference,
            workDate: timecards.workDate,
            totalHours: timecards.totalHours,
          })
          .from(timecards)
          .where(
            and(
              eq(timecards.companyId, companyId),
              eq(timecards.status, "approved"),
              isNull(timecards.batchId),
              lte(timecards.workDate, cutoff),
            ),
          )
          .limit(500);
        if (orphans.length === 0) return { orphans: 0 };
        const byProject = new Map<string, typeof orphans>();
        for (const o of orphans) {
          const list = byProject.get(o.projectId) ?? [];
          list.push(o);
          byProject.set(o.projectId, list);
        }
        let raised = 0;
        for (const [projectId, list] of byProject) {
          const key = `${projectId}|${cutoff}`;
          const seen = await db
            .select({ id: signals.id })
            .from(signals)
            .where(
              and(
                eq(signals.companyId, companyId),
                eq(signals.detector, "timecard_approved_unbatched"),
                sql`${signals.evidenceRefs}->>'key' = ${key}`,
              ),
            )
            .limit(1);
          if (seen[0]) continue;
          await db.insert(signals).values({
            id: newId("sig"),
            companyId,
            projectId,
            detector: "timecard_approved_unbatched",
            severity: "medium",
            confidence: 1,
            title: `${list.length} approved timecard(s) belong to no batch`,
            explanation:
              `${list.length} timecard(s) covering ` +
              `${round2(list.reduce((s, c) => s + c.totalHours, 0))} hour(s) were approved and are ` +
              `older than ${cutoff}, and none of them is in a batch. Payroll is exported per ` +
              "batch: hours nobody collected are hours somebody worked and nobody will be paid " +
              "for through this platform.",
            evidenceRefs: {
              key,
              cutoff,
              count: list.length,
              references: list.slice(0, 20).map((c) => c.reference),
            },
          });
          raised += 1;
        }
        return { orphans: orphans.length, raised };
      }),
  });
};
