import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, gte, inArray, lte, ne } from "drizzle-orm";
import { z } from "zod";
import {
  boqItems,
  boqScheduleLinks,
  boqs,
  commitments,
  contracts,
  cvrPeriods,
  cvrRows,
  dayworkSheets,
  finalAccountLines,
  finalAccounts,
  fluctuationCalculations,
  invoices,
  paymentCertificates,
  provisionalSums,
  remeasurements,
  scheduleTasks,
  timecards,
  valuations,
  variations,
} from "@constructos/db";
import { FINAL_ACCOUNT_CATEGORIES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { computeCvr, computeSCurve, type CvrPackageInput, type SCurveTaskInput } from "./cvr.js";
import { buildFinalAccount, type FinalAccountLineInput } from "./final-account.js";
import { computeLdExposure } from "./valuation-engine.js";
import {
  isoDateSchema,
  requireCommercialLevel,
  round2,
  subResourceGate,
  todayISO,
} from "./shared.js";

const cvrQuery = z.object({
  periodEnd: isoDateSchema.optional(),
  currency: z.string().min(3).max(8).optional(),
  /** persist the result as a CVR period record */
  save: z.coerce.boolean().optional(),
});

const linkSchema = z.object({
  boqItemId: z.string().min(1),
  taskId: z.string().min(1),
  allocationPercent: z.number().min(0).max(100).optional(),
});

const finalAccountCreateSchema = z.object({
  contractId: z.string().min(1),
  boqId: z.string().nullable().optional(),
});

const manualLineSchema = z.object({
  category: z.enum(FINAL_ACCOUNT_CATEGORIES),
  description: z.string().min(1).max(500),
  amount: z.number().finite(),
  note: z.string().max(2000).nullable().optional(),
});

const signSchema = z.object({ side: z.enum(["contractor", "employer"]) });

/**
 * CVR / WIP, the cash-flow S-curve and the final account
 * (spec Vol II Domain B #181-189).
 *
 * Cost comes from what the platform actually holds: subcontractor invoices
 * against commitments, approved timecard cost, verified dayworks. Where a feed
 * is missing the CVR reports a GAP and returns a null margin — a project with
 * no cost feed does not have a 100% margin, it has an unmeasured one.
 */
export const reportingRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("commercial", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("commercial", "standard"),
  ];
  const subRead = subResourceGate(app, "read");
  const subWrite = subResourceGate(app, "standard");
  const subAdmin = subResourceGate(app, "admin");

  /**
   * The project's commercial currency for reporting: the currency of the
   * issued bills. More than one is reported, never merged.
   */
  async function projectCurrencies(companyId: string, projectId: string): Promise<string[]> {
    const rows = await app.db
      .select({ currency: boqs.currency })
      .from(boqs)
      .where(and(eq(boqs.companyId, companyId), eq(boqs.projectId, projectId)));
    return [...new Set(rows.map((r) => r.currency))];
  }

  /* ---------------------------------------------------------------- */
  /* CVR (#184-187)                                                    */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/commercial/cvr", { preHandler: readGate }, async (req) => {
    const q = cvrQuery.parse(req.query);
    const companyId = req.companyId!;
    const projectId = req.projectId!;
    const periodEnd = q.periodEnd ?? todayISO();
    const currencies = await projectCurrencies(companyId, projectId);
    const currency = q.currency ?? currencies[0] ?? "USD";
    const gaps: string[] = [];
    if (currencies.length > 1) {
      gaps.push(
        `This project holds bills in ${currencies.join(", ")}; this CVR covers ${currency} only.`,
      );
    }

    /* value: the gross of the latest application per bill in this currency */
    const bills = await app.db
      .select()
      .from(boqs)
      .where(
        and(eq(boqs.companyId, companyId), eq(boqs.projectId, projectId), eq(boqs.currency, currency)),
      );
    let valueToDate: number | null = null;
    for (const bill of bills) {
      const latest = await app.db
        .select({ gross: valuations.grossTotal, number: valuations.number })
        .from(valuations)
        .where(and(eq(valuations.boqId, bill.id), lte(valuations.valuationDate, periodEnd)))
        .orderBy(desc(valuations.number))
        .limit(1);
      if (latest[0]) valueToDate = round2((valueToDate ?? 0) + latest[0].gross);
    }
    if (valueToDate === null) {
      gaps.push("No application has been raised in this currency, so value to date is unmeasured.");
    }

    /* certified: Σ netCertified over issued/paid certificates */
    const certRows = await app.db
      .select({
        net: paymentCertificates.netCertified,
        currency: paymentCertificates.currency,
        issuedAt: paymentCertificates.issuedAt,
      })
      .from(paymentCertificates)
      .where(
        and(
          eq(paymentCertificates.companyId, companyId),
          eq(paymentCertificates.projectId, projectId),
          ne(paymentCertificates.status, "withdrawn"),
        ),
      );
    const certifiedToDate = round2(
      certRows
        .filter((c) => c.currency === currency && c.issuedAt.slice(0, 10) <= periodEnd)
        .reduce((s, c) => s + c.net, 0),
    );

    /* cost: subcontract packages (commitments) with their invoiced position */
    const packages: CvrPackageInput[] = [];
    const commitmentRows = await app.db
      .select()
      .from(commitments)
      .where(and(eq(commitments.companyId, companyId), eq(commitments.projectId, projectId)));
    for (const c of commitmentRows) {
      if (c.currency !== currency) {
        gaps.push(`Commitment ${c.reference} is in ${c.currency} and is excluded from this CVR.`);
        continue;
      }
      const inv = await app.db
        .select({
          status: invoices.status,
          total: invoices.totalCompletedAndStored,
          billingDate: invoices.billingDate,
        })
        .from(invoices)
        .where(and(eq(invoices.companyId, companyId), eq(invoices.commitmentId, c.id)));
      const settled = inv.filter(
        (i) => i.billingDate == null || i.billingDate <= periodEnd,
      );
      const costToDate = settled.length > 0 ? round2(settled.reduce((s, i) => s + i.total, 0)) : 0;
      packages.push({
        key: c.id,
        label: `${c.reference} — ${c.title}`,
        valueToDate: null,
        committed: c.revisedCommitmentSum,
        costToDate,
        accruals: 0,
        basis: {
          commitmentId: c.id,
          invoices: settled.length,
          committed: c.revisedCommitmentSum,
        },
        gaps:
          settled.length === 0
            ? [`No invoices yet against ${c.reference}; its cost to date is recorded as zero.`]
            : [],
      });
    }

    /* direct cost: approved timecards in this currency */
    const cards = await app.db
      .select({ cost: timecards.totalCost, currency: timecards.currency, status: timecards.status })
      .from(timecards)
      .where(
        and(
          eq(timecards.companyId, companyId),
          eq(timecards.projectId, projectId),
          lte(timecards.workDate, periodEnd),
        ),
      );
    const approvedCards = cards.filter(
      (c) => c.currency === currency && (c.status === "approved" || c.status === "locked" || c.status === "exported"),
    );
    const labourCost =
      approvedCards.length === 0
        ? null
        : round2(approvedCards.reduce((s, c) => s + (c.cost ?? 0), 0));
    const directCosts = [
      {
        label: "Own labour (approved timecards)",
        amount: labourCost,
        gap:
          approvedCards.length === 0
            ? "No approved timecards in this currency, so own-labour cost is unmeasured."
            : undefined,
      },
    ];

    /* verified dayworks are a cost the contractor has already incurred */
    const sheets = await app.db
      .select({ gross: dayworkSheets.grossTotal, currency: dayworkSheets.currency, status: dayworkSheets.status })
      .from(dayworkSheets)
      .where(and(eq(dayworkSheets.companyId, companyId), eq(dayworkSheets.projectId, projectId)));
    const dayworkCost = sheets
      .filter((s) => s.currency === currency && (s.status === "verified" || s.status === "valued"))
      .reduce((s, x) => s + x.gross, 0);
    if (dayworkCost > 0) {
      directCosts.push({
        label: "Verified dayworks",
        amount: round2(dayworkCost),
        gap: undefined,
      });
    }

    const result = computeCvr({
      currency,
      periodEnd,
      valueToDate,
      certifiedToDate,
      directCosts,
      packages,
    });
    result.gaps.unshift(...gaps);

    let cvrPeriodId: string | null = null;
    if (q.save) {
      let periodId = newId("cvr");
      await app.db.transaction(async (tx) => {
        const existing = await tx
          .select({ id: cvrPeriods.id })
          .from(cvrPeriods)
          .where(and(eq(cvrPeriods.projectId, projectId), eq(cvrPeriods.periodEnd, periodEnd)))
          .limit(1);
        if (existing[0]) {
          periodId = existing[0].id;
          await tx.delete(cvrRows).where(eq(cvrRows.cvrPeriodId, periodId));
          await tx
            .update(cvrPeriods)
            .set({
              currency,
              valueToDate: result.valueToDate ?? 0,
              certifiedToDate: result.certifiedToDate,
              costToDate: result.costToDate ?? 0,
              accruals: result.accruals,
              wip: result.wip ?? 0,
              margin: result.margin ?? 0,
              marginPercent: result.marginPercent,
              overUnderCertification: result.overUnderCertification ?? 0,
              gaps: result.gaps,
              basis: result.basis,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(cvrPeriods.id, periodId));
        } else {
          await tx.insert(cvrPeriods).values({
            id: periodId,
            companyId,
            projectId,
            periodEnd,
            currency,
            status: "draft",
            valueToDate: result.valueToDate ?? 0,
            certifiedToDate: result.certifiedToDate,
            costToDate: result.costToDate ?? 0,
            accruals: result.accruals,
            wip: result.wip ?? 0,
            margin: result.margin ?? 0,
            marginPercent: result.marginPercent,
            overUnderCertification: result.overUnderCertification ?? 0,
            gaps: result.gaps,
            basis: result.basis,
            preparedBy: req.user!.id,
          });
        }
        for (const row of result.rows) {
          await tx.insert(cvrRows).values({
            id: newId("cvrr"),
            cvrPeriodId: periodId,
            scope: row.scope,
            label: row.label,
            packageRef: row.packageRef,
            valueToDate: row.valueToDate ?? 0,
            certifiedToDate: row.certifiedToDate ?? 0,
            costToDate: row.costToDate ?? 0,
            accruals: row.accruals,
            margin: row.margin ?? 0,
            marginPercent: row.marginPercent,
            basis: row.basis,
          });
        }
      });
      cvrPeriodId = periodId;
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "create",
        objectType: "cvr_period",
        objectId: periodId,
        projectId,
        payload: {
          periodEnd,
          currency,
          margin: result.margin,
          overUnderCertification: result.overUnderCertification,
        },
        storePayload: true,
      });
    }

    return { ...result, currencies, cvrPeriodId };
  });

  app.get("/projects/:projectId/commercial/cvr-history", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    const where = and(
      eq(cvrPeriods.companyId, req.companyId!),
      eq(cvrPeriods.projectId, req.projectId!),
    );
    const [totalRow] = await app.db.select({ n: count() }).from(cvrPeriods).where(where);
    const items = await app.db
      .select()
      .from(cvrPeriods)
      .where(where)
      .orderBy(desc(cvrPeriods.periodEnd))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  /* ---------------------------------------------------------------- */
  /* Cash-flow S-curve (#188-189)                                      */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/commercial/cash-flow", { preHandler: readGate }, async (req) => {
    const q = z.object({ currency: z.string().min(3).max(8).optional() }).parse(req.query);
    const companyId = req.companyId!;
    const projectId = req.projectId!;
    const currencies = await projectCurrencies(companyId, projectId);
    const currency = q.currency ?? currencies[0] ?? "USD";

    const bills = await app.db
      .select({ id: boqs.id })
      .from(boqs)
      .where(
        and(
          eq(boqs.companyId, companyId),
          eq(boqs.projectId, projectId),
          eq(boqs.currency, currency),
          inArray(boqs.status, ["issued", "agreed"]),
        ),
      );
    if (bills.length === 0) {
      return {
        currency,
        currencies,
        points: [],
        totalAllocated: 0,
        unallocated: 0,
        reasons: ["No issued bill of quantities in this currency, so there is nothing to spread."],
      };
    }
    const items = await app.db
      .select({ id: boqItems.id, amount: boqItems.amount, level: boqItems.level })
      .from(boqItems)
      .where(inArray(boqItems.boqId, bills.map((b) => b.id)));
    const leaves = items.filter((i) => i.level === "item");
    const amountByItem = new Map(leaves.map((i) => [i.id, i.amount ?? 0]));

    const links = await app.db
      .select()
      .from(boqScheduleLinks)
      .where(
        and(eq(boqScheduleLinks.companyId, companyId), eq(boqScheduleLinks.projectId, projectId)),
      );
    const taskIds = [...new Set(links.map((l) => l.taskId))];
    const tasks =
      taskIds.length === 0
        ? []
        : await app.db
            .select({
              id: scheduleTasks.id,
              name: scheduleTasks.name,
              start: scheduleTasks.startDate,
              finish: scheduleTasks.finishDate,
            })
            .from(scheduleTasks)
            .where(inArray(scheduleTasks.id, taskIds));
    const taskById = new Map(tasks.map((t) => [t.id, t]));

    const perTask = new Map<string, number>();
    const allocatedByItem = new Map<string, number>();
    for (const link of links) {
      const amount = amountByItem.get(link.boqItemId);
      if (amount === undefined) continue;
      const share = round2((amount * link.allocationPercent) / 100);
      perTask.set(link.taskId, (perTask.get(link.taskId) ?? 0) + share);
      allocatedByItem.set(link.boqItemId, (allocatedByItem.get(link.boqItemId) ?? 0) + share);
    }
    const totalBoq = round2(leaves.reduce((s, i) => s + (i.amount ?? 0), 0));
    const totalAllocated = round2([...allocatedByItem.values()].reduce((s, v) => s + v, 0));
    const sCurveTasks: SCurveTaskInput[] = [...perTask.entries()].map(([taskId, amount]) => {
      const t = taskById.get(taskId);
      return {
        taskId,
        name: t?.name ?? taskId,
        start: t?.start ?? null,
        finish: t?.finish ?? null,
        amount,
      };
    });

    const certs = await app.db
      .select({
        issuedAt: paymentCertificates.issuedAt,
        net: paymentCertificates.netCertified,
        currency: paymentCertificates.currency,
        status: paymentCertificates.status,
      })
      .from(paymentCertificates)
      .where(
        and(
          eq(paymentCertificates.companyId, companyId),
          eq(paymentCertificates.projectId, projectId),
        ),
      );
    const actuals = certs
      .filter((c) => c.currency === currency && c.status !== "withdrawn")
      .map((c) => ({ period: c.issuedAt.slice(0, 10), amount: c.net }));

    const result = computeSCurve(
      currency,
      sCurveTasks,
      round2(totalBoq - totalAllocated),
      actuals,
    );
    return { ...result, currencies, totalBoq, linkedTasks: sCurveTasks.length };
  });

  app.get("/projects/:projectId/commercial/schedule-links", { preHandler: readGate }, async (req) => {
    const items = await app.db
      .select()
      .from(boqScheduleLinks)
      .where(
        and(
          eq(boqScheduleLinks.companyId, req.companyId!),
          eq(boqScheduleLinks.projectId, req.projectId!),
        ),
      )
      .orderBy(asc(boqScheduleLinks.createdAt));
    return { items, total: items.length };
  });

  app.post("/projects/:projectId/commercial/schedule-links", { preHandler: standardGate }, async (req, reply) => {
    const body = linkSchema.parse(req.body);
    const item = await app.db
      .select({ id: boqItems.id, level: boqItems.level })
      .from(boqItems)
      .innerJoin(boqs, eq(boqs.id, boqItems.boqId))
      .where(
        and(
          eq(boqItems.id, body.boqItemId),
          eq(boqs.companyId, req.companyId!),
          eq(boqs.projectId, req.projectId!),
        ),
      )
      .limit(1);
    if (!item[0]) throw badRequest("boqItemId does not reference a BQ item on this project");
    if (item[0].level !== "item") throw badRequest("Only a leaf BQ item can carry money to spread");
    // schedule_tasks carries projectId (not companyId); the project is already
    // proved to be in this company by requireTool, so scoping by it is enough.
    const task = await app.db
      .select({ id: scheduleTasks.id })
      .from(scheduleTasks)
      .where(
        and(eq(scheduleTasks.id, body.taskId), eq(scheduleTasks.projectId, req.projectId!)),
      )
      .limit(1);
    if (!task[0]) throw badRequest("taskId does not reference a schedule task on this project");

    const existing = await app.db
      .select({ id: boqScheduleLinks.id })
      .from(boqScheduleLinks)
      .where(
        and(
          eq(boqScheduleLinks.boqItemId, body.boqItemId),
          eq(boqScheduleLinks.taskId, body.taskId),
        ),
      )
      .limit(1);
    if (existing[0]) throw conflict("This BQ item is already linked to that task");

    const id = newId("bsl");
    await app.db.insert(boqScheduleLinks).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      boqItemId: body.boqItemId,
      taskId: body.taskId,
      allocationPercent: body.allocationPercent ?? 100,
      createdBy: req.user!.id,
    });
    const created = await app.db
      .select()
      .from(boqScheduleLinks)
      .where(eq(boqScheduleLinks.id, id))
      .limit(1);
    return reply.status(201).send(created[0]);
  });

  app.delete("/commercial/schedule-links/:linkId", { preHandler: subWrite }, async (req, reply) => {
    const { linkId } = req.params as { linkId: string };
    const rows = await app.db
      .select()
      .from(boqScheduleLinks)
      .where(
        and(eq(boqScheduleLinks.id, linkId), eq(boqScheduleLinks.companyId, req.companyId!)),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Link not found");
    await requireCommercialLevel(app, req, reply, rows[0].projectId, "standard");
    await app.db.delete(boqScheduleLinks).where(eq(boqScheduleLinks.id, linkId));
    return { ok: true };
  });

  /* ---------------------------------------------------------------- */
  /* Final account (#181-183, #187)                                    */
  /* ---------------------------------------------------------------- */

  /** Recompute a draft final account's adjustment schedule from its sources. */
  async function computeFinalAccountLines(
    companyId: string,
    projectId: string,
    contract: typeof contracts.$inferSelect,
    boqId: string | null,
  ): Promise<{ lines: FinalAccountLineInput[]; gaps: string[]; certifiedToDate: number }> {
    const lines: FinalAccountLineInput[] = [];
    const gaps: string[] = [];
    const currency = contract.currency;

    // Remeasurement: the movement in BQ value from applied remeasurements
    const remeasureRows = await app.db
      .select({ r: remeasurements, rate: boqItems.rate })
      .from(remeasurements)
      .innerJoin(boqItems, eq(boqItems.id, remeasurements.boqItemId))
      .where(
        and(eq(remeasurements.companyId, companyId), eq(remeasurements.projectId, projectId)),
      );
    for (const { r, rate } of remeasureRows) {
      if (r.status !== "applied") {
        gaps.push(
          `Remeasurement of BQ item ${r.boqItemId} is ${r.status} and is excluded from the final account.`,
        );
        continue;
      }
      if (r.originalQuantity == null || rate == null) continue;
      const movement = round2((r.remeasuredQuantity - r.originalQuantity) * rate);
      if (Math.abs(movement) < 0.005) continue;
      lines.push({
        category: "remeasurement",
        description: `Remeasured quantity, BQ item ${r.boqItemId}`,
        amount: movement,
        sourceType: "remeasurement",
        sourceId: r.id,
      });
    }

    // Variations: agreed only; anything else is a declared gap
    const varRows = await app.db
      .select()
      .from(variations)
      .where(and(eq(variations.companyId, companyId), eq(variations.projectId, projectId)));
    for (const v of varRows) {
      if (v.status === "rejected" || v.status === "withdrawn") continue;
      if (v.currency !== currency) {
        gaps.push(`Variation ${v.number} is in ${v.currency}; it is not included in a ${currency} account.`);
        continue;
      }
      if (v.status !== "agreed") {
        gaps.push(`Variation ${v.number} ("${v.title}") is ${v.status} and is not yet in the account.`);
        continue;
      }
      lines.push({
        category: "variation",
        description: `VO-${v.number}: ${v.title}`,
        amount: v.agreedValue ?? 0,
        sourceType: "variation",
        sourceId: v.id,
      });
    }

    // Provisional sums: omit the allowance, add the expenditure
    const psRows = await app.db
      .select()
      .from(provisionalSums)
      .where(and(eq(provisionalSums.companyId, companyId), eq(provisionalSums.projectId, projectId)));
    for (const ps of psRows) {
      if (ps.currency !== currency) {
        gaps.push(`Provisional sum "${ps.title}" is in ${ps.currency} and is excluded.`);
        continue;
      }
      if (ps.status === "open" || ps.status === "instructed") {
        gaps.push(`Provisional sum "${ps.title}" is still ${ps.status}; its final adjustment is not known.`);
        continue;
      }
      lines.push({
        category: "provisional_sum_omitted",
        description: `Omit provisional sum: ${ps.title}`,
        amount: -round2(ps.allowance),
        sourceType: "provisional_sum",
        sourceId: ps.id,
      });
      if (ps.expendedTotal > 0.005) {
        lines.push({
          category: "provisional_sum_expenditure",
          description: `Expenditure against: ${ps.title}`,
          amount: round2(ps.expendedTotal),
          sourceType: "provisional_sum",
          sourceId: ps.id,
        });
      }
    }

    // Dayworks: verified sheets not already priced through an agreed variation
    const sheets = await app.db
      .select()
      .from(dayworkSheets)
      .where(and(eq(dayworkSheets.companyId, companyId), eq(dayworkSheets.projectId, projectId)));
    for (const s of sheets) {
      if (s.status === "rejected" || s.status === "draft") continue;
      if (s.currency !== currency) {
        gaps.push(`Daywork sheet ${s.number} is in ${s.currency} and is excluded.`);
        continue;
      }
      if (s.status === "submitted") {
        gaps.push(`Daywork sheet ${s.number} is submitted but not verified; it is not in the account.`);
        continue;
      }
      if (s.variationId) continue; // already carried by the variation
      lines.push({
        category: "daywork",
        description: `DW-${s.number}: ${s.description}`,
        amount: round2(s.grossTotal),
        sourceType: "daywork_sheet",
        sourceId: s.id,
      });
    }

    // Fluctuations
    const fluctuations = await app.db
      .select()
      .from(fluctuationCalculations)
      .where(
        and(
          eq(fluctuationCalculations.companyId, companyId),
          eq(fluctuationCalculations.projectId, projectId),
        ),
      );
    for (const f of fluctuations) {
      if (f.currency !== currency || Math.abs(f.adjustment) < 0.005) continue;
      lines.push({
        category: "fluctuation",
        description: `Price adjustment ${f.currentPeriod} (${f.formula})`,
        amount: round2(f.adjustment),
        sourceType: "fluctuation_calculation",
        sourceId: f.id,
      });
    }

    // Liquidated damages
    const ld = computeLdExposure({
      completionDate: contract.completionDate,
      takingOverDate: contract.takingOverDate,
      actualCompletionDate: contract.actualCompletionDate,
      ldRatePerDay: contract.ldRatePerDay,
      ldCap: contract.ldCap,
      contractStatus: contract.status,
      today: todayISO(),
    });
    if (ld.applicable && ld.accrued > 0.005) {
      lines.push({
        category: "liquidated_damages",
        description: `Delay damages: ${ld.daysLate} days at ${ld.ldRatePerDay} per day`,
        amount: -round2(ld.accrued),
        sourceType: "contract",
        sourceId: contract.id,
      });
    }

    // Certified to date, against which the balance is reconciled
    const certRows = await app.db
      .select({
        net: paymentCertificates.netCertified,
        currency: paymentCertificates.currency,
        boqId: valuations.boqId,
      })
      .from(paymentCertificates)
      .innerJoin(valuations, eq(valuations.id, paymentCertificates.valuationId))
      .where(
        and(
          eq(paymentCertificates.companyId, companyId),
          eq(paymentCertificates.projectId, projectId),
          ne(paymentCertificates.status, "withdrawn"),
        ),
      );
    const certifiedToDate = round2(
      certRows
        .filter((c) => c.currency === currency && (boqId == null || c.boqId === boqId))
        .reduce((s, c) => s + c.net, 0),
    );

    return { lines, gaps, certifiedToDate };
  }

  app.post("/projects/:projectId/final-accounts", { preHandler: standardGate }, async (req, reply) => {
    const body = finalAccountCreateSchema.parse(req.body);
    const c = await app.db
      .select()
      .from(contracts)
      .where(
        and(
          eq(contracts.id, body.contractId),
          eq(contracts.companyId, req.companyId!),
          eq(contracts.projectId, req.projectId!),
        ),
      )
      .limit(1);
    const contract = c[0];
    if (!contract) throw badRequest("contractId does not reference a contract on this project");
    const open = await app.db
      .select({ id: finalAccounts.id, status: finalAccounts.status })
      .from(finalAccounts)
      .where(
        and(
          eq(finalAccounts.contractId, body.contractId),
          inArray(finalAccounts.status, ["draft", "issued"]),
        ),
      )
      .limit(1);
    if (open[0]) {
      throw conflict(`This contract already has a ${open[0].status} final account`);
    }
    const number = await nextRecordNumber(app.db, req.projectId!, "final_account");
    const id = newId("fac");
    await app.db.insert(finalAccounts).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      contractId: body.contractId,
      boqId: body.boqId ?? null,
      number,
      status: "draft",
      currency: contract.currency,
      contractSum: contract.contractSum ?? 0,
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "final_account",
      objectId: id,
      projectId: req.projectId!,
      payload: { number, contractId: body.contractId, contractSum: contract.contractSum ?? 0 },
    });
    return reply.status(201).send(await loadFinalAccount(id, req.companyId!));
  });

  async function loadFinalAccount(id: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(finalAccounts)
      .where(and(eq(finalAccounts.id, id), eq(finalAccounts.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Final account not found");
    const lines = await app.db
      .select()
      .from(finalAccountLines)
      .where(eq(finalAccountLines.finalAccountId, id))
      .orderBy(asc(finalAccountLines.sequence));
    return { ...rows[0], lines };
  }

  app.get("/projects/:projectId/final-accounts", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    const where = and(
      eq(finalAccounts.companyId, req.companyId!),
      eq(finalAccounts.projectId, req.projectId!),
    );
    const [totalRow] = await app.db.select({ n: count() }).from(finalAccounts).where(where);
    const items = await app.db
      .select()
      .from(finalAccounts)
      .where(where)
      .orderBy(desc(finalAccounts.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/final-accounts/:accountId", { preHandler: subRead }, async (req, reply) => {
    const { accountId } = req.params as { accountId: string };
    const rows = await app.db
      .select({ projectId: finalAccounts.projectId })
      .from(finalAccounts)
      .where(and(eq(finalAccounts.id, accountId), eq(finalAccounts.companyId, req.companyId!)))
      .limit(1);
    if (!rows[0]) throw notFound("Final account not found");
    await requireCommercialLevel(app, req, reply, rows[0].projectId, "read");
    return loadFinalAccount(accountId, req.companyId!);
  });

  /** Rebuild the adjustment schedule from the source records. */
  app.post("/final-accounts/:accountId/compute", { preHandler: subWrite }, async (req, reply) => {
    const { accountId } = req.params as { accountId: string };
    const account = (
      await app.db
        .select()
        .from(finalAccounts)
        .where(and(eq(finalAccounts.id, accountId), eq(finalAccounts.companyId, req.companyId!)))
        .limit(1)
    )[0];
    if (!account) throw notFound("Final account not found");
    await requireCommercialLevel(app, req, reply, account.projectId, "standard");
    if (account.status !== "draft") {
      throw badRequest("Only a draft final account can be recomputed");
    }
    const contract = (
      await app.db.select().from(contracts).where(eq(contracts.id, account.contractId)).limit(1)
    )[0];
    if (!contract) throw notFound("The contract this account belongs to no longer exists");

    const { lines, gaps, certifiedToDate } = await computeFinalAccountLines(
      req.companyId!,
      account.projectId,
      contract,
      account.boqId,
    );
    // manual lines survive a recompute — they are somebody's judgement, not
    // derived data, and silently deleting them would lose the negotiation
    const manual = await app.db
      .select()
      .from(finalAccountLines)
      .where(
        and(eq(finalAccountLines.finalAccountId, accountId), eq(finalAccountLines.manual, true)),
      );
    const allLines: FinalAccountLineInput[] = [
      ...lines,
      ...manual.map((m) => ({
        category: m.category as FinalAccountLineInput["category"],
        description: m.description,
        amount: m.amount,
        sourceType: m.sourceType,
        sourceId: m.sourceId,
        manual: true,
        note: m.note,
      })),
    ];
    const statement = buildFinalAccount({
      contractSum: contract.contractSum ?? 0,
      lines: allLines,
      certifiedToDate,
      gaps,
    });

    const now = new Date().toISOString();
    await app.db.transaction(async (tx) => {
      await tx
        .delete(finalAccountLines)
        .where(
          and(eq(finalAccountLines.finalAccountId, accountId), eq(finalAccountLines.manual, false)),
        );
      let sequence = 0;
      for (const line of lines) {
        await tx.insert(finalAccountLines).values({
          id: newId("fal"),
          finalAccountId: accountId,
          sequence,
          category: line.category,
          description: line.description,
          amount: round2(line.amount),
          sourceType: line.sourceType ?? null,
          sourceId: line.sourceId ?? null,
          manual: false,
          note: line.note ?? null,
        });
        sequence += 1;
      }
      await tx
        .update(finalAccounts)
        .set({
          contractSum: statement.contractSum,
          finalContractSum: statement.finalContractSum,
          certifiedToDate: statement.certifiedToDate,
          balanceDue: statement.balanceDue,
          gaps: statement.gaps,
          statement: statement as unknown as Record<string, unknown>,
          computedAt: now,
          updatedAt: now,
        })
        .where(eq(finalAccounts.id, accountId));
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "final_account",
      objectId: accountId,
      projectId: account.projectId,
      payload: {
        finalContractSum: statement.finalContractSum,
        certifiedToDate: statement.certifiedToDate,
        balanceDue: statement.balanceDue,
        gaps: statement.gaps.length,
      },
      storePayload: true,
    });
    return loadFinalAccount(accountId, req.companyId!);
  });

  app.post("/final-accounts/:accountId/lines", { preHandler: subWrite }, async (req, reply) => {
    const { accountId } = req.params as { accountId: string };
    const body = manualLineSchema.parse(req.body);
    const account = (
      await app.db
        .select()
        .from(finalAccounts)
        .where(and(eq(finalAccounts.id, accountId), eq(finalAccounts.companyId, req.companyId!)))
        .limit(1)
    )[0];
    if (!account) throw notFound("Final account not found");
    await requireCommercialLevel(app, req, reply, account.projectId, "standard");
    if (account.status !== "draft") throw badRequest("Only a draft final account can be edited");
    const [seq] = await app.db
      .select({ n: count() })
      .from(finalAccountLines)
      .where(eq(finalAccountLines.finalAccountId, accountId));
    const id = newId("fal");
    await app.db.insert(finalAccountLines).values({
      id,
      finalAccountId: accountId,
      sequence: 1000 + Number(seq?.n ?? 0),
      category: body.category,
      description: body.description,
      amount: round2(body.amount),
      manual: true,
      note: body.note ?? null,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "final_account",
      objectId: accountId,
      projectId: account.projectId,
      payload: { manualLine: id, category: body.category, amount: round2(body.amount) },
      storePayload: true,
    });
    return reply.status(201).send(await loadFinalAccount(accountId, req.companyId!));
  });

  app.post("/final-accounts/:accountId/issue", { preHandler: subAdmin }, async (req, reply) => {
    const { accountId } = req.params as { accountId: string };
    const account = (
      await app.db
        .select()
        .from(finalAccounts)
        .where(and(eq(finalAccounts.id, accountId), eq(finalAccounts.companyId, req.companyId!)))
        .limit(1)
    )[0];
    if (!account) throw notFound("Final account not found");
    await requireCommercialLevel(app, req, reply, account.projectId, "admin");
    if (account.status !== "draft") throw badRequest("Only a draft final account can be issued");
    if (!account.computedAt) {
      throw badRequest("Compute the adjustment schedule before issuing the account");
    }
    const now = new Date().toISOString();
    await app.db
      .update(finalAccounts)
      .set({ status: "issued", issuedBy: req.user!.id, issuedAt: now, updatedAt: now })
      .where(and(eq(finalAccounts.id, accountId), eq(finalAccounts.status, "draft")));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "final_account",
      objectId: accountId,
      projectId: account.projectId,
      payload: {
        from: "draft",
        to: "issued",
        finalContractSum: account.finalContractSum,
        balanceDue: account.balanceDue,
      },
      storePayload: true,
    });
    return loadFinalAccount(accountId, req.companyId!);
  });

  /**
   * Two signatures, from two different people. The account becomes `agreed`
   * only when both sides have signed — the same separation of duties that
   * governs certification.
   */
  app.post("/final-accounts/:accountId/sign", { preHandler: subWrite }, async (req, reply) => {
    const { accountId } = req.params as { accountId: string };
    const body = signSchema.parse(req.body);
    const account = (
      await app.db
        .select()
        .from(finalAccounts)
        .where(and(eq(finalAccounts.id, accountId), eq(finalAccounts.companyId, req.companyId!)))
        .limit(1)
    )[0];
    if (!account) throw notFound("Final account not found");
    await requireCommercialLevel(app, req, reply, account.projectId, "standard");
    if (account.status !== "issued") {
      throw badRequest("Only an issued final account can be signed");
    }
    const other = body.side === "contractor" ? account.employerSignedBy : account.contractorSignedBy;
    const mine = body.side === "contractor" ? account.contractorSignedBy : account.employerSignedBy;
    if (mine) throw conflict(`The ${body.side} side has already signed this account`);
    if (other === req.user!.id) {
      throw forbidden("A final account cannot be signed for both sides by the same person");
    }

    const now = new Date().toISOString();
    const set: Record<string, unknown> = { updatedAt: now };
    if (body.side === "contractor") {
      set["contractorSignedBy"] = req.user!.id;
      set["contractorSignedAt"] = now;
    } else {
      set["employerSignedBy"] = req.user!.id;
      set["employerSignedAt"] = now;
    }
    const bothSigned = Boolean(other);
    if (bothSigned) set["status"] = "agreed";
    await app.db.update(finalAccounts).set(set).where(eq(finalAccounts.id, accountId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "final_account",
      objectId: accountId,
      projectId: account.projectId,
      payload: {
        side: body.side,
        agreed: bothSigned,
        finalContractSum: account.finalContractSum,
        balanceDue: account.balanceDue,
      },
      storePayload: true,
    });
    return loadFinalAccount(accountId, req.companyId!);
  });
};
