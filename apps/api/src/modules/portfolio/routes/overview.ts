/**
 * THE PORTFOLIO COMMAND VIEW — roll-ups, the stage-gate pipeline, the project
 * summary and the health inputs the intelligence layer reads.
 * Spec Vol I §7 #776–#789; Vol II Domain G #423, #426, #430.
 *
 * Everything here is READ-ONLY except the manual sweep trigger. The roll-up is
 * computed on demand from budgets, commitments and the money-authority tables;
 * nothing is materialised, because a portfolio total that is a day old is a
 * portfolio total that is wrong.
 *
 * The rule that shapes every number: MONEY IS NEVER SUMMED ACROSS CURRENCIES.
 * The response buckets by currency and returns `{ value: null, reasons }` for
 * anything that would need a rate. A portfolio total computed at an unstated
 * rate is worse than no total, and every owner who has been burned by one
 * knows it.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, count, desc, eq, inArray, isNull, ne, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  auditRightsExecutions,
  budgets,
  callOffOrders,
  commitments,
  definedCostItems,
  disallowedCosts,
  frameworkAgreements,
  frameworkLots,
  gateReviews,
  jointVentures,
  jvTransactions,
  openBookVerifications,
  portfolioAllocations,
  portfolioAppropriations,
  portfolioEnvelopes,
  portfolioFundingSources,
  portfolios,
  projects,
  signals,
  stageGates,
  targetCostContracts,
} from "@constructos/db";
import { PORTFOLIO_SIGNAL_DETECTORS } from "@constructos/shared";
import { forbidden } from "../../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import { frameworkUtilisation } from "../frameworks.js";
import { computePainGain, parseParticipants, parseShareBands } from "../paingain.js";
import {
  affordability,
  appropriationPosition,
  classificationSplit,
  fundingSourcePosition,
  pipeline,
  rollUpPortfolio,
  type EnvelopeRow,
  type GateReviewRow,
  type GateRow,
  type RollupBudget,
  type RollupCommitment,
  type RollupProject,
} from "../rollup.js";
import {
  disallowedSummary,
  verificationTotals,
  type DisallowedRow,
} from "../openbook.js";
import { loadAllocations, loadCallOffs, visibleProjectIds } from "../service.js";
import { runPortfolioSweeps } from "../sweeps.js";
import { buildGates, idSchema, nowISO, round2, todayISO } from "../shared.js";

const overviewQuery = z.object({
  portfolioId: idSchema.optional(),
  fiscalYear: z.string().max(20).optional(),
});

export const overviewRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, companyGate, companyAdminGate } = buildGates(app);

  /** Live, non-template projects the caller may see, optionally one portfolio. */
  async function candidateProjects(
    companyId: string,
    userId: string,
    companyRole: string | undefined,
    portfolioId?: string,
  ): Promise<{ rows: RollupProject[]; ids: string[]; restricted: boolean }> {
    const visible = await visibleProjectIds(app.db, companyId, userId, companyRole);
    const clauses: SQL[] = [
      eq(projects.companyId, companyId),
      isNull(projects.deletedAt),
      eq(projects.isTemplate, 0),
    ];
    if (portfolioId) clauses.push(eq(projects.portfolioId, portfolioId));
    if (visible !== null) {
      if (visible.length === 0) return { rows: [], ids: [], restricted: true };
      clauses.push(inArray(projects.id, visible));
    }
    const rows = await app.db
      .select({
        id: projects.id,
        name: projects.name,
        stage: projects.stage,
        currency: projects.currency,
        value: projects.value,
        portfolioId: projects.portfolioId,
        isSandbox: projects.isSandbox,
      })
      .from(projects)
      .where(and(...clauses));
    return {
      rows: rows.map((p) => ({
        projectId: p.id,
        name: p.name,
        stage: p.stage,
        currency: p.currency,
        value: p.value,
        portfolioId: p.portfolioId,
        isSandbox: p.isSandbox === 1,
      })),
      ids: rows.map((p) => p.id),
      restricted: visible !== null,
    };
  }

  async function rollupFor(projectIds: string[], companyId: string, rows: RollupProject[]) {
    if (projectIds.length === 0) {
      return rollUpPortfolio(rows, [], []);
    }
    const budgetRows = await app.db
      .select({
        projectId: budgets.projectId,
        currency: budgets.currency,
        revisedBudgetTotal: budgets.revisedBudgetTotal,
        committedTotal: budgets.committedTotal,
        jobToDateCostsTotal: budgets.jobToDateCostsTotal,
        forecastFinalTotal: budgets.forecastFinalTotal,
      })
      .from(budgets)
      .where(
        and(
          eq(budgets.companyId, companyId),
          eq(budgets.isActive, 1),
          inArray(budgets.projectId, projectIds),
        ),
      );
    const commitmentRows = await app.db
      .select({
        projectId: commitments.projectId,
        currency: commitments.currency,
        revisedCommitmentSum: commitments.revisedCommitmentSum,
        totalInvoiced: commitments.totalInvoiced,
        totalPaid: commitments.totalPaid,
      })
      .from(commitments)
      .where(
        and(
          eq(commitments.companyId, companyId),
          inArray(commitments.projectId, projectIds),
          ne(commitments.status, "void"),
        ),
      );
    /* Commitments arrive one per row; the engine wants one bucket per
       (project, currency), so fold them here rather than in the engine. */
    const folded = new Map<string, RollupCommitment>();
    for (const c of commitmentRows) {
      const key = `${c.projectId}|${c.currency}`;
      const acc = folded.get(key) ?? {
        projectId: c.projectId,
        currency: c.currency,
        revisedCommitmentSum: 0,
        totalInvoiced: 0,
        totalPaid: 0,
      };
      acc.revisedCommitmentSum += c.revisedCommitmentSum;
      acc.totalInvoiced += c.totalInvoiced;
      acc.totalPaid += c.totalPaid;
      folded.set(key, acc);
    }
    const budgetBuckets: RollupBudget[] = budgetRows.map((b) => ({
      projectId: b.projectId,
      currency: b.currency,
      revisedBudgetTotal: b.revisedBudgetTotal,
      committedTotal: b.committedTotal,
      jobToDateCostsTotal: b.jobToDateCostsTotal,
      forecastFinalTotal: b.forecastFinalTotal,
    }));
    return rollUpPortfolio(rows, budgetBuckets, [...folded.values()]);
  }

  /* ================================================================ */
  /* Portfolio groupings (read-through to core.portfolios)             */
  /* ================================================================ */

  app.get("/portfolio/portfolios", { preHandler: companyGate }, async (req) => {
    const rows = await app.db
      .select()
      .from(portfolios)
      .where(eq(portfolios.companyId, req.companyId!));
    const counts = await app.db
      .select({ portfolioId: projects.portfolioId, n: count() })
      .from(projects)
      .where(and(eq(projects.companyId, req.companyId!), isNull(projects.deletedAt)))
      .groupBy(projects.portfolioId);
    const countOf = new Map(counts.map((c) => [c.portfolioId, Number(c.n)]));
    return {
      items: rows.map((p) => ({ ...p, projectCount: countOf.get(p.id) ?? 0 })),
      total: rows.length,
      ungroupedProjects: countOf.get(null) ?? 0,
    };
  });

  /* ================================================================ */
  /* The command view (#776–#780)                                      */
  /* ================================================================ */

  app.get("/portfolio/overview", { preHandler: companyGate }, async (req) => {
    const q = overviewQuery.parse(req.query);
    const companyId = req.companyId!;
    const { rows, ids, restricted } = await candidateProjects(
      companyId,
      req.user!.id,
      req.companyRole,
      q.portfolioId,
    );
    const reasons: string[] = [];
    if (restricted) {
      reasons.push(
        "You see only the projects you are a member of; company owners and admins see the whole portfolio.",
      );
    }

    const rollup = await rollupFor(ids, companyId, rows);
    const allocations = await loadAllocations(app.db, companyId, {
      projectIds: ids.length > 0 || restricted ? ids : null,
    });
    const scopedAllocations = q.fiscalYear
      ? allocations.filter((a) => a.fiscalYear === q.fiscalYear)
      : allocations;

    const envelopeClauses: SQL[] = [eq(portfolioEnvelopes.companyId, companyId)];
    if (q.fiscalYear) envelopeClauses.push(eq(portfolioEnvelopes.fiscalYear, q.fiscalYear));
    if (q.portfolioId) envelopeClauses.push(eq(portfolioEnvelopes.portfolioId, q.portfolioId));
    const envelopeRows = await app.db
      .select()
      .from(portfolioEnvelopes)
      .where(and(...envelopeClauses));
    const envelopes: EnvelopeRow[] = envelopeRows.map((e) => ({
      id: e.id,
      name: e.name,
      portfolioId: e.portfolioId,
      fiscalYear: e.fiscalYear,
      currency: e.currency,
      envelopeAmount: e.envelopeAmount,
      expenditureClass: e.expenditureClass,
      status: e.status,
      basis: e.basis,
    }));

    const gateRows =
      ids.length > 0
        ? await app.db
            .select()
            .from(stageGates)
            .where(and(eq(stageGates.companyId, companyId), inArray(stageGates.projectId, ids)))
        : [];
    const reviewRows =
      ids.length > 0
        ? await app.db
            .select()
            .from(gateReviews)
            .where(and(eq(gateReviews.companyId, companyId), inArray(gateReviews.projectId, ids)))
        : [];
    const gates: GateRow[] = gateRows.map((g) => ({
      id: g.id,
      projectId: g.projectId,
      gateNumber: g.gateNumber,
      name: g.name,
      status: g.status,
      plannedDate: g.plannedDate,
    }));
    const reviews: GateReviewRow[] = reviewRows.map((r) => ({
      id: r.id,
      gateId: r.gateId,
      projectId: r.projectId,
      reviewDate: r.reviewDate,
      rag: r.rag,
      decision: r.decision,
    }));

    const sources = await app.db
      .select()
      .from(portfolioFundingSources)
      .where(eq(portfolioFundingSources.companyId, companyId));
    const appropriations = await app.db
      .select()
      .from(portfolioAppropriations)
      .where(eq(portfolioAppropriations.companyId, companyId));

    const fundingPositions = sources.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      status: s.status,
      ...fundingSourcePosition(
        {
          id: s.id,
          currency: s.currency,
          amount: s.amount,
          status: s.status,
          expenditureClass: s.expenditureClass,
        },
        allocations,
      ),
    }));
    const appropriationPositions = appropriations.map((a) => ({
      id: a.id,
      name: a.name,
      fiscalYear: a.fiscalYear,
      status: a.status,
      ...appropriationPosition(
        {
          id: a.id,
          fiscalYear: a.fiscalYear,
          currency: a.currency,
          appropriatedAmount: a.appropriatedAmount,
          carriedForwardIn: a.carriedForwardIn,
          carriedForwardOut: a.carriedForwardOut,
          virementNet: a.virementNet,
          status: a.status,
          carryForwardPolicy: a.carryForwardPolicy,
          expenditureClass: a.expenditureClass,
        },
        allocations,
      ),
    }));

    /* Frameworks: consumption and the ones running out of road. */
    const frameworks = await app.db
      .select()
      .from(frameworkAgreements)
      .where(eq(frameworkAgreements.companyId, companyId));
    const lots = await app.db
      .select()
      .from(frameworkLots)
      .where(eq(frameworkLots.companyId, companyId));
    const callOffs = await loadCallOffs(app.db, companyId);
    const today = todayISO();
    const frameworkPositions = frameworks.map((fw) => ({
      id: fw.id,
      reference: fw.reference,
      title: fw.title,
      status: fw.status,
      endDate: fw.endDate,
      extensionToDate: fw.extensionToDate,
      ...frameworkUtilisation(
        {
          id: fw.id,
          reference: fw.reference,
          title: fw.title,
          currency: fw.currency,
          maximumValue: fw.maximumValue,
          startDate: fw.startDate,
          endDate: fw.endDate,
          extensionToDate: fw.extensionToDate,
          awardMode: fw.awardMode,
          directAwardThreshold: fw.directAwardThreshold,
          status: fw.status,
        },
        lots.filter((l) => l.frameworkId === fw.id).map((l) => ({
          id: l.id,
          frameworkId: l.frameworkId,
          lotNumber: l.lotNumber,
          title: l.title,
          currency: l.currency,
          ceilingValue: l.ceilingValue,
          awardMode: l.awardMode,
          status: l.status,
        })),
        callOffs,
        today,
      ),
    }));

    const openSignals = await app.db
      .select({ detector: signals.detector, severity: signals.severity, n: count() })
      .from(signals)
      .where(
        and(
          eq(signals.companyId, companyId),
          inArray(signals.detector, [...PORTFOLIO_SIGNAL_DETECTORS]),
          ne(signals.disposition, "closed"),
        ),
      )
      .groupBy(signals.detector, signals.severity);

    /* Ventures follow the same visibility rule as the projects above: an
       owner or admin sees the company's, everyone else only those on the
       projects they are a member of, and a portfolio filter narrows both. */
    const scopeVentures = restricted || Boolean(q.portfolioId);
    let ventureCount = 0;
    if (!(scopeVentures && ids.length === 0)) {
      const clauses: SQL[] = [eq(jointVentures.companyId, companyId)];
      if (scopeVentures) clauses.push(inArray(jointVentures.projectId, ids));
      const [row] = await app.db
        .select({ n: count() })
        .from(jointVentures)
        .where(and(...clauses));
      ventureCount = Number(row?.n ?? 0);
    }

    return {
      generatedAt: nowISO(),
      scope: { portfolioId: q.portfolioId ?? null, fiscalYear: q.fiscalYear ?? null },
      projects: {
        total: rows.length,
        live: rows.filter((p) => !p.isSandbox).length,
        sandbox: rows.filter((p) => p.isSandbox).length,
      },
      rollup,
      pipeline: pipeline(rows, gates, reviews, today),
      affordability: affordability(envelopes, scopedAllocations, {
        portfolioId: q.portfolioId ?? null,
      }),
      classificationSplit: classificationSplit(scopedAllocations),
      fundingSources: {
        total: sources.length,
        positions: fundingPositions,
        overdrawn: fundingPositions.filter((p) => p.overdrawn).length,
      },
      appropriations: {
        total: appropriations.length,
        positions: appropriationPositions,
        overcommitted: appropriationPositions.filter((p) => p.overcommitted).length,
      },
      frameworks: {
        total: frameworks.length,
        live: frameworks.filter((f) => f.status === "live").length,
        positions: frameworkPositions,
        breached: frameworkPositions.filter((f) => f.breached).length,
        expiringWithin90Days: frameworkPositions.filter(
          (f) => f.daysToExpiry !== null && f.daysToExpiry >= 0 && f.daysToExpiry <= 90,
        ).length,
      },
      ventures: ventureCount,
      signals: openSignals.map((s) => ({
        detector: s.detector,
        severity: s.severity,
        count: Number(s.n),
      })),
      reasons,
    };
  });

  /** The cross-project pipeline on its own (#778, #786). */
  app.get("/portfolio/pipeline", { preHandler: companyGate }, async (req) => {
    const q = overviewQuery.parse(req.query);
    const { rows, ids } = await candidateProjects(
      req.companyId!,
      req.user!.id,
      req.companyRole,
      q.portfolioId,
    );
    const gateRows =
      ids.length > 0
        ? await app.db
            .select()
            .from(stageGates)
            .where(
              and(eq(stageGates.companyId, req.companyId!), inArray(stageGates.projectId, ids)),
            )
        : [];
    const reviewRows =
      ids.length > 0
        ? await app.db
            .select()
            .from(gateReviews)
            .where(
              and(eq(gateReviews.companyId, req.companyId!), inArray(gateReviews.projectId, ids)),
            )
        : [];
    return {
      ...pipeline(
        rows,
        gateRows.map((g) => ({
          id: g.id,
          projectId: g.projectId,
          gateNumber: g.gateNumber,
          name: g.name,
          status: g.status,
          plannedDate: g.plannedDate,
        })),
        reviewRows.map((r) => ({
          id: r.id,
          gateId: r.gateId,
          projectId: r.projectId,
          reviewDate: r.reviewDate,
          rag: r.rag,
          decision: r.decision,
        })),
        todayISO(),
      ),
      generatedAt: nowISO(),
    };
  });

  /** The financial roll-up on its own, bucketed by currency (#777). */
  app.get("/portfolio/rollup", { preHandler: companyGate }, async (req) => {
    const q = overviewQuery.parse(req.query);
    const { rows, ids } = await candidateProjects(
      req.companyId!,
      req.user!.id,
      req.companyRole,
      q.portfolioId,
    );
    return { ...(await rollupFor(ids, req.companyId!, rows)), generatedAt: nowISO() };
  });

  /* ================================================================ */
  /* Signals raised by this module                                     */
  /* ================================================================ */

  app.get("/portfolio/signals", { preHandler: companyGate }, async (req) => {
    const q = pageQuerySchema
      .extend({
        includeClosed: z.coerce.boolean().default(false),
        detector: z.enum(PORTFOLIO_SIGNAL_DETECTORS).optional(),
      })
      .parse(req.query);
    const visible = await visibleProjectIds(app.db, req.companyId!, req.user!.id, req.companyRole);
    const clauses: SQL[] = [
      eq(signals.companyId, req.companyId!),
      inArray(signals.detector, q.detector ? [q.detector] : [...PORTFOLIO_SIGNAL_DETECTORS]),
    ];
    if (!q.includeClosed) clauses.push(ne(signals.disposition, "closed"));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(signals).where(where);
    const rows = await app.db
      .select()
      .from(signals)
      .where(where)
      .orderBy(desc(signals.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    /* Company-wide signals carry no project; project-scoped ones are filtered
       to the projects the caller may see (plan §6.3). */
    const items =
      visible === null
        ? rows
        : rows.filter((r) => r.projectId === null || visible.includes(r.projectId));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  /** Run every portfolio sweep for this company, now. */
  app.post("/portfolio/sweeps/run", { preHandler: companyAdminGate }, async (req) => {
    const counts = await runPortfolioSweeps(app.db, req.companyId!, new Date());
    return { ranAt: nowISO(), ...counts };
  });

  /* ================================================================ */
  /* Project workspace summary                                         */
  /* ================================================================ */

  async function projectSummary(companyId: string, projectId: string) {
    const allocations = await app.db
      .select()
      .from(portfolioAllocations)
      .where(
        and(
          eq(portfolioAllocations.companyId, companyId),
          eq(portfolioAllocations.projectId, projectId),
        ),
      );
    const orders = await loadCallOffs(app.db, companyId, { projectId });
    const ventures = await app.db
      .select()
      .from(jointVentures)
      .where(and(eq(jointVentures.companyId, companyId), eq(jointVentures.projectId, projectId)));
    const overdueTx = ventures.length
      ? await app.db
          .select({ n: count() })
          .from(jvTransactions)
          .where(
            and(
              eq(jvTransactions.companyId, companyId),
              inArray(
                jvTransactions.jvId,
                ventures.map((v) => v.id),
              ),
              eq(jvTransactions.status, "overdue"),
            ),
          )
      : [];
    const targets = await app.db
      .select()
      .from(targetCostContracts)
      .where(
        and(
          eq(targetCostContracts.companyId, companyId),
          eq(targetCostContracts.projectId, projectId),
        ),
      );
    const verifications = await app.db
      .select()
      .from(openBookVerifications)
      .where(
        and(
          eq(openBookVerifications.companyId, companyId),
          eq(openBookVerifications.projectId, projectId),
        ),
      );
    const disallowed = await app.db
      .select()
      .from(disallowedCosts)
      .where(
        and(eq(disallowedCosts.companyId, companyId), eq(disallowedCosts.projectId, projectId)),
      );
    const audits = await app.db
      .select()
      .from(auditRightsExecutions)
      .where(
        and(
          eq(auditRightsExecutions.companyId, companyId),
          eq(auditRightsExecutions.projectId, projectId),
        ),
      );
    const itemRows = await app.db
      .select()
      .from(definedCostItems)
      .where(
        and(eq(definedCostItems.companyId, companyId), eq(definedCostItems.projectId, projectId)),
      );

    const reasons: string[] = [];

    /* Allocation position, bucketed by currency — never summed across. */
    const allocationBuckets = new Map<
      string,
      { currency: string; allocated: number; drawn: number; count: number }
    >();
    for (const a of allocations) {
      if (a.status === "cancelled") continue;
      const acc = allocationBuckets.get(a.currency) ?? {
        currency: a.currency,
        allocated: 0,
        drawn: 0,
        count: 0,
      };
      acc.allocated = round2(acc.allocated + a.amount);
      acc.drawn = round2(acc.drawn + a.drawnAmount);
      acc.count += 1;
      allocationBuckets.set(a.currency, acc);
    }
    if (allocationBuckets.size > 1) {
      reasons.push(
        `Funding for this project is allocated in ${allocationBuckets.size} currencies (${[...allocationBuckets.keys()].sort().join(", ")}); totals are shown per currency and never combined.`,
      );
    }
    if (allocations.length === 0) {
      reasons.push("No funding has been allocated to this project from the portfolio.");
    }

    const callOffBuckets = new Map<
      string,
      { currency: string; ordered: number; certified: number; count: number }
    >();
    for (const o of orders) {
      const acc = callOffBuckets.get(o.currency) ?? {
        currency: o.currency,
        ordered: 0,
        certified: 0,
        count: 0,
      };
      if (["issued", "in_progress", "completed", "disputed"].includes(o.status)) {
        acc.ordered = round2(acc.ordered + o.orderValue);
        acc.count += 1;
      }
      acc.certified = round2(acc.certified + o.certifiedValue);
      callOffBuckets.set(o.currency, acc);
    }

    /* Target cost: the worst live variance, with its own currency attached. */
    const activeTargets = targets.filter((t) => t.status === "active" || t.status === "final_account");
    let worstVariancePercent: number | null = null;
    let worstTarget: { id: string; name: string; currency: string; variance: number } | null = null;
    for (const t of activeTargets) {
      try {
        const result = computePainGain({
          currency: t.currency,
          baseTargetCost: t.baseTargetCost,
          targetAdjustments: t.targetAdjustments,
          outturnCost: t.forecastDefinedCost ?? t.actualDefinedCost,
          feePercent: t.feePercent,
          mechanism: t.mechanism as never,
          shareBands: parseShareBands(t.shareBands),
          painCap: t.painCap,
          gainCap: t.gainCap,
          participants: parseParticipants(t.participants),
        });
        if (!result.computable || result.variancePercent === null) continue;
        if (worstVariancePercent === null || result.variancePercent > worstVariancePercent) {
          worstVariancePercent = result.variancePercent;
          worstTarget = { id: t.id, name: t.name, currency: t.currency, variance: result.variance };
        }
      } catch {
        reasons.push(
          `Target-cost model "${t.name}" carries share bands that are not a valid apportionment, so its variance is not computed.`,
        );
      }
    }
    if (activeTargets.length === 0) {
      reasons.push("No active target-cost model on this project, so there is no pain/gain position.");
    }

    const disallowedRows: DisallowedRow[] = disallowed.map((d) => ({
      id: d.id,
      category: d.category,
      status: d.status,
      currency: d.currency,
      amount: d.amount,
      deductedAmount: d.deductedAmount,
      raisedAt: d.raisedAt,
      responseDueAt: d.responseDueAt,
      groundClause: d.groundClause,
    }));
    const dcSummary = disallowedSummary(disallowedRows, todayISO());

    /* Verification coverage across every verification on the project, per
       verification currency (the engine already refuses to mix). */
    const verificationCoverage = verifications.map((v) => {
      const rows = itemRows
        .filter((i) => i.verificationId === v.id)
        .map((i) => ({
          id: i.id,
          component: i.component,
          currency: i.currency,
          claimedAmount: i.claimedAmount,
          verifiedAmount: i.verifiedAmount,
          verdict: i.verdict,
          evidenceRef: i.evidenceRef,
          evidenceId: i.evidenceId,
        }));
      const totals = verificationTotals(rows, v.currency);
      return {
        id: v.id,
        reference: v.reference,
        title: v.title,
        status: v.status,
        currency: v.currency,
        claimedAmount: v.claimedAmount,
        plannedAt: v.plannedAt,
        totals,
      };
    });

    return {
      generatedAt: nowISO(),
      funding: {
        allocations: allocations.length,
        approved: allocations.filter((a) => a.status === "approved" || a.status === "drawn").length,
        byCurrency: [...allocationBuckets.values()].sort((a, b) =>
          a.currency.localeCompare(b.currency),
        ),
      },
      callOffs: {
        total: orders.length,
        live: orders.filter((o) => o.status === "issued" || o.status === "in_progress").length,
        byCurrency: [...callOffBuckets.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
      },
      ventures: {
        total: ventures.length,
        active: ventures.filter((v) => v.status === "active").length,
        overdueContributions: Number(overdueTx[0]?.n ?? 0),
      },
      targetCost: {
        total: targets.length,
        active: activeTargets.length,
        worstVariancePercent,
        worstTarget,
      },
      openBook: {
        verifications: verifications.length,
        inProgress: verifications.filter((v) => v.status === "in_progress").length,
        overduePlanned: verifications.filter(
          (v) => v.status === "planned" && v.plannedAt !== null && v.plannedAt < todayISO(),
        ).length,
        coverage: verificationCoverage,
      },
      disallowed: {
        total: disallowed.length,
        unresolved: dcSummary.unresolved,
        overdueResponses: dcSummary.overdueResponses,
        withoutGround: dcSummary.withoutGround,
        oldestUnresolvedDays: dcSummary.oldestUnresolvedDays,
        byCurrency: dcSummary.byCurrency,
      },
      auditRights: {
        total: audits.length,
        open: audits.filter((a) => !["completed", "closed"].includes(a.status)).length,
        obstructed: audits.filter((a) => a.status === "obstructed").length,
      },
      reasons,
    };
  }

  app.get("/projects/:projectId/portfolio/summary", { preHandler: readGate }, async (req) =>
    projectSummary(req.companyId!, req.projectId!),
  );

  /**
   * Health inputs (plan §3.5). Counts and percentages only — never a money
   * total, because money on this project may be denominated in more than one
   * currency and the intelligence layer must not be handed a number that
   * silently added them. A metric the platform cannot derive is `null` with a
   * reason, never 0.
   */
  app.get("/projects/:projectId/portfolio/health-inputs", { preHandler: readGate }, async (req) => {
    const s = await projectSummary(req.companyId!, req.projectId!);
    const reasons: string[] = [...s.reasons];

    let drawnPercent: number | null = null;
    if (s.funding.byCurrency.length === 1) {
      const only = s.funding.byCurrency[0]!;
      drawnPercent = only.allocated > 0 ? round2((only.drawn / only.allocated) * 100) : null;
      if (drawnPercent === null) reasons.push("Allocated funding is zero, so a drawn percentage has no meaning.");
    } else if (s.funding.byCurrency.length > 1) {
      reasons.push(
        "Funding is allocated in more than one currency, so a single drawn percentage would require an exchange rate this platform has not been given.",
      );
    }

    let disallowanceRatePercent: number | null = null;
    const singleCurrencyVerification =
      s.openBook.coverage.length > 0 &&
      new Set(s.openBook.coverage.map((v) => v.currency)).size === 1;
    if (singleCurrencyVerification) {
      const claimed = s.openBook.coverage.reduce((sum, v) => sum + v.totals.claimed, 0);
      const disallowed = s.openBook.coverage.reduce((sum, v) => sum + v.totals.disallowed, 0);
      disallowanceRatePercent = claimed > 0 ? round2((disallowed / claimed) * 100) : null;
      if (disallowanceRatePercent === null) {
        reasons.push("No defined cost has been tested yet, so no disallowance rate exists.");
      }
    } else if (s.openBook.coverage.length > 1) {
      reasons.push(
        "Open-book verifications on this project are denominated in more than one currency; a combined disallowance rate is not computable.",
      );
    } else if (s.openBook.coverage.length === 0) {
      reasons.push("No open-book verification has been carried out on this project.");
    }

    return {
      metrics: {
        allocationsApproved: s.funding.approved,
        allocationDrawnPercent: drawnPercent,
        callOffsLive: s.callOffs.live,
        jvContributionsOverdue: s.ventures.overdueContributions,
        targetCostVariancePercent: s.targetCost.worstVariancePercent,
        openBookVerificationsOverdue: s.openBook.overduePlanned,
        openBookDisallowanceRatePercent: disallowanceRatePercent,
        disallowedUnresolved: s.disallowed.unresolved,
        disallowedOverdueResponses: s.disallowed.overdueResponses,
        disallowedWithoutGround: s.disallowed.withoutGround,
        auditRightsObstructed: s.auditRights.obstructed,
      },
      reasons,
      generatedAt: s.generatedAt,
    };
  });

  /* A company-level guard so an unauthorised caller gets a clear refusal
     rather than an empty list that looks like "nothing to see". */
  app.get("/portfolio/allocations/by-project/:projectId", { preHandler: companyGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const visible = await visibleProjectIds(app.db, req.companyId!, req.user!.id, req.companyRole);
    if (visible !== null && !visible.includes(projectId)) {
      throw forbidden("You are not a member of that project");
    }
    const rows = await app.db
      .select()
      .from(portfolioAllocations)
      .where(
        and(
          eq(portfolioAllocations.companyId, req.companyId!),
          eq(portfolioAllocations.projectId, projectId),
        ),
      );
    return { items: rows, total: rows.length };
  });

  /* Every call-off across the company, so procurement can see the whole
     picture without opening each project. */
  app.get("/portfolio/call-offs", { preHandler: companyGate }, async (req) => {
    const q = pageQuerySchema
      .extend({ frameworkId: idSchema.optional(), termContractId: idSchema.optional() })
      .parse(req.query);
    const visible = await visibleProjectIds(app.db, req.companyId!, req.user!.id, req.companyRole);
    const clauses: SQL[] = [eq(callOffOrders.companyId, req.companyId!)];
    if (visible !== null) {
      if (visible.length === 0) return paginate([], 0, q);
      clauses.push(inArray(callOffOrders.projectId, visible));
    }
    if (q.frameworkId) clauses.push(eq(callOffOrders.frameworkId, q.frameworkId));
    if (q.termContractId) clauses.push(eq(callOffOrders.termContractId, q.termContractId));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(callOffOrders).where(where);
    const items = await app.db
      .select()
      .from(callOffOrders)
      .where(where)
      .orderBy(desc(callOffOrders.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });
};
