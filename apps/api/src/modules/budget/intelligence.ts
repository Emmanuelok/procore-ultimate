/**
 * BUDGET INTELLIGENCE ROUTES — the platform-upgrade half of the budget
 * module. Registered from index.ts as a sub-plugin so the classic cost
 * report (index.ts) and the layer that explains it live under one tool key
 * and one set of gates.
 *
 * Covers, by spec function:
 *   #486–487  saved views with calculated fields (views.ts, safe evaluator)
 *   #489      snapshot comparison is in index.ts; the swing analysis here
 *             reads the same captures
 *   #490–492  forecast-to-complete methods: earned-value (CPI / SPI / TCPI
 *             / VAC / EAC by four methods) and linear-burn EACs on top of
 *             the manual + formula methods index.ts already stores
 *   #495–497  budget vs actual variance report, grouped, with movement
 *             since the last capture
 *   #499      contingency management: budget contingency lines linked to
 *             the risk register's contingencies, drawdowns compared
 *   #500      drill-down to source transactions ("explain this number")
 *   #481      ERP import: GL → cost-code map CRUD (the import itself lives
 *             in index.ts next to prepareLine/writeLines)
 *   Vol II X  anomaly detection with reasons and citations
 *   cash-flow S-curve by period from lines, commitments and invoices
 *   reconciliation history + the nightly reconciliation job
 *   health inputs for the intelligence layer (plan §3.5)
 *
 * Deliberately NOT here: anything that writes a stored cost column by hand.
 * The only writer of cost-side columns is reconcile.ts, and this file only
 * ever calls it.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import {
  budgetContingencyLinks,
  budgetLineItems,
  budgetPostings,
  budgetReconciliations,
  budgetSnapshots,
  budgetViews,
  budgets,
  commitments,
  contingencies,
  contingencyDrawdowns,
  costCodes,
  glCostCodeMaps,
  invoiceLineItems,
  invoices,
  projects,
  scheduleTasks,
} from "@constructos/db";
import { COST_TYPES, ERP_SYSTEMS } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { forEachCompany } from "../../lib/scheduler.js";
import type { Db } from "../../lib/db.js";
import { computed, rollUpTotals, round2, round4, unavailable, type Component, type SnapshotLine } from "./calc.js";
import { buildCashFlow, type DatedAmount, type Phaseable } from "./cashflow.js";
import { ERP_DIALECTS } from "./erp.js";
import {
  DEFAULT_THRESHOLDS,
  detectContingencyBurn,
  detectLineAnomalies,
  driftFinding,
  earnedValue,
  forecastSwing,
  rollUpEarnedValue,
  sortFindings,
  type Finding,
  type InsightLine,
  type ScheduleWindow,
  type SnapshotPoint,
} from "./insights.js";
import { explainLine, runReconciliation, COMMITTED_STATUSES, INCURRED_INVOICE_STATUSES } from "./reconcile.js";
import { varianceReport } from "./reports.js";
import { compileCalculatedFields, evaluateFields, VIEW_COLUMN_KEYS } from "./views.js";
import {
  fetchBudget,
  fetchLineWithBudget,
  isVoidSnapshot,
  latestSnapshot,
  linesOfBudget,
  nowIso,
  requireBudgetLevel,
  today,
  type BudgetRow,
  type LineRow,
} from "./shared.js";

/* ------------------------------------------------------------------ */
/* Wire schemas                                                        */
/* ------------------------------------------------------------------ */

const idRef = z.string().min(1).max(64);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD)");

const calculatedFieldSchema = z.object({
  key: z.string().min(1).max(40),
  label: z.string().max(120).optional(),
  expression: z.string().min(1).max(400),
  format: z.enum(["currency", "number", "percent"]).optional(),
});

const viewCreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  budgetId: idRef.nullable().optional(),
  isDefault: z.boolean().optional(),
  columns: z.array(z.string().min(1).max(60)).max(60).optional(),
  calculatedFields: z.array(calculatedFieldSchema).max(20).optional(),
  grouping: z.enum(["none", "division", "cost_type", "line_kind", "sub_job", "wbs"]).optional(),
  filters: z.record(z.string(), z.unknown()).optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});
const viewPatchSchema = viewCreateSchema.partial();

const evaluateSchema = z.object({ calculatedFields: z.array(calculatedFieldSchema).max(20) });

const glMapCreateSchema = z.object({
  erpSystem: z.enum(ERP_SYSTEMS).optional(),
  glAccount: z.string().min(1).max(80),
  glSubAccount: z.string().max(80).nullable().optional(),
  glDescription: z.string().max(500).nullable().optional(),
  costCodeId: idRef.optional(),
  costCode: z.string().min(1).max(50).optional(),
  costType: z.enum(COST_TYPES),
  /** company-wide when false/absent; this project only when true */
  projectOnly: z.boolean().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});
const glMapPatchSchema = z.object({
  glDescription: z.string().max(500).nullable().optional(),
  costCodeId: idRef.optional(),
  costCode: z.string().min(1).max(50).optional(),
  costType: z.enum(COST_TYPES).optional(),
  isActive: z.boolean().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});
const glMapListQuery = pageQuerySchema.extend({
  erpSystem: z.enum(ERP_SYSTEMS).optional(),
  q: z.string().max(100).optional(),
});

const varianceQuery = z.object({
  by: z.enum(["cost_code", "cost_type", "division", "line_kind", "sub_job"]).default("cost_code"),
  /** a snapshot id / number / reference to show movement since; default = latest */
  compareWith: z.string().max(64).optional(),
});

const cashflowQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  asOf: isoDate.optional(),
});

const insightsQuery = z.object({
  asOf: isoDate.optional(),
  severity: z.enum(["critical", "high", "medium", "low", "info"]).optional(),
});

const contingencyLinkSchema = z.object({
  contingencyId: idRef,
  notes: z.string().max(2000).nullable().optional(),
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const insightLineOf = (l: LineRow): InsightLine => ({
  id: l.id,
  costCode: l.costCode,
  costType: l.costType,
  description: l.description,
  lineKind: l.lineKind,
  status: l.status,
  wbsPath: l.wbsPath,
  originalBudget: l.originalBudget,
  budgetModifications: l.budgetModifications,
  approvedChanges: l.approvedChanges,
  revisedBudget: l.revisedBudget,
  committedCost: l.committedCost,
  pendingCommitments: l.pendingCommitments,
  directCosts: l.directCosts,
  jobToDateCosts: l.jobToDateCosts,
  forecastMethod: l.forecastMethod,
  forecastToComplete: l.forecastToComplete,
  forecastFinal: l.forecastFinal,
  projectedOverUnder: l.projectedOverUnder,
  percentComplete: l.percentComplete,
});

const viewColumnsOf = (l: LineRow) => ({
  originalBudget: l.originalBudget,
  budgetModifications: l.budgetModifications,
  approvedChanges: l.approvedChanges,
  pendingBudgetChanges: l.pendingBudgetChanges,
  revisedBudget: l.revisedBudget,
  committedCost: l.committedCost,
  pendingCommitments: l.pendingCommitments,
  directCosts: l.directCosts,
  jobToDateCosts: l.jobToDateCosts,
  forecastToComplete: l.forecastToComplete,
  forecastFinal: l.forecastFinal,
  projectedOverUnder: l.projectedOverUnder,
  percentComplete: l.percentComplete,
  quantity: l.quantity,
  unitRate: l.unitRate,
});

/**
 * Match schedule tasks to a budget line by WBS code: a task whose `wbsCode`
 * equals the line's cost code, or is an ancestor segment of its WBS path.
 * The window is the union of the matched tasks' dates.
 */
export function scheduleWindowFor(
  line: Pick<LineRow, "costCode" | "wbsPath">,
  tasks: ReadonlyArray<{ id: string; wbsCode: string | null; startDate: string | null; finishDate: string | null; actualStart: string | null; actualFinish: string | null; percentComplete: number }>,
): ScheduleWindow | null {
  const path = line.wbsPath ?? line.costCode;
  const matched = tasks.filter((t) => {
    if (!t.wbsCode) return false;
    const code = t.wbsCode.trim();
    if (code === "") return false;
    return code === line.costCode || path === code || path.startsWith(`${code}/`);
  });
  if (matched.length === 0) return null;
  let start: string | null = null;
  let finish: string | null = null;
  let pcSum = 0;
  for (const t of matched) {
    const s = t.actualStart ?? t.startDate;
    const f = t.actualFinish ?? t.finishDate;
    if (s && (start === null || s < start)) start = s;
    if (f && (finish === null || f > finish)) finish = f;
    pcSum += t.percentComplete;
  }
  return {
    taskIds: matched.map((t) => t.id),
    start,
    finish,
    taskPercentComplete: round4(pcSum / matched.length),
  };
}

/** The scheduled reconciliation over every active, open budget of one company. */
export async function reconcileCompanyBudgets(
  db: Db,
  companyId: string,
): Promise<{ budgets: number; drifted: number; driftAmount: number }> {
  const active = await db
    .select()
    .from(budgets)
    .where(and(eq(budgets.companyId, companyId), eq(budgets.isActive, 1)));
  let drifted = 0;
  let driftAmount = 0;
  let ran = 0;
  for (const budget of active) {
    if (budget.status === "closed") continue;
    const lineCount = await db
      .select({ n: count() })
      .from(budgetLineItems)
      .where(eq(budgetLineItems.budgetId, budget.id));
    if (Number(lineCount[0]?.n ?? 0) === 0) continue;
    const result = await runReconciliation(db, budget, { trigger: "scheduled", actorId: null, raiseSignal: true });
    ran += 1;
    if (result.driftCount > 0) drifted += 1;
    driftAmount = round2(driftAmount + result.driftAmount);
  }
  return { budgets: ran, drifted, driftAmount };
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

export const budgetIntelligenceRoutes: FastifyPluginAsync = async (app) => {
  const companyGate = [app.authenticate, app.requireCompany];
  const readGate = [...companyGate, app.requireTool("budget", "read")];
  const standardGate = [...companyGate, app.requireTool("budget", "standard")];
  const db = app.db;

  /* ---------------------------------------------------------------- */
  /* Nightly reconciliation                                            */
  /* ---------------------------------------------------------------- */

  app.scheduler.register({
    name: "budget.reconcile",
    description:
      "Rebuild every active budget's cost-side columns from commitments, invoices and payments; record drift as a finding, never a silent overwrite.",
    everyMs: 6 * 60 * 60_000,
    runOnBoot: false,
    run: async ({ db: jobDb }) => {
      let budgetsRun = 0;
      let drifted = 0;
      const summary = await forEachCompany(jobDb, async (companyId) => {
        const r = await reconcileCompanyBudgets(jobDb, companyId);
        budgetsRun += r.budgets;
        drifted += r.drifted;
      });
      return { ...summary, budgets: budgetsRun, drifted };
    },
  });

  /* ---------------------------------------------------------------- */
  /* Drill-down: explain this number (#500)                            */
  /* ---------------------------------------------------------------- */

  app.get("/budget-lines/:lineId/transactions", { preHandler: companyGate }, async (req, reply) => {
    const { lineId } = req.params as { lineId: string };
    const { line, budget } = await fetchLineWithBudget(db, lineId, req.companyId!);
    await requireBudgetLevel(app, req, reply, budget.projectId, "read");
    const [explained, postings] = await Promise.all([
      explainLine(db, budget, line),
      db
        .select()
        .from(budgetPostings)
        .where(eq(budgetPostings.budgetLineItemId, line.id))
        .orderBy(asc(budgetPostings.component), desc(budgetPostings.amount)),
    ]);
    return {
      lineItemId: line.id,
      budgetId: budget.id,
      currency: budget.currency,
      costCode: line.costCode,
      costType: line.costType,
      description: line.description,
      asOf: nowIso(),
      components: explained.components,
      /** what the last reconciliation posted, per source — the stored evidence */
      postings,
      lastReconciliation: explained.lastReconciliation,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Reconciliation runs                                               */
  /* ---------------------------------------------------------------- */

  app.post("/budgets/:budgetId/reconcile", { preHandler: companyGate }, async (req, reply) => {
    const { budgetId } = req.params as { budgetId: string };
    const budget = await fetchBudget(db, budgetId, req.companyId!);
    await requireBudgetLevel(app, req, reply, budget.projectId, "standard");
    const lines = await linesOfBudget(db, budgetId);
    if (lines.length === 0) throw badRequest("This budget has no lines to reconcile.");
    return runReconciliation(db, budget, { trigger: "manual", actorId: req.user!.id, raiseSignal: true });
  });

  app.get("/budgets/:budgetId/reconciliations", { preHandler: companyGate }, async (req, reply) => {
    const { budgetId } = req.params as { budgetId: string };
    const q = pageQuerySchema.parse(req.query);
    const budget = await fetchBudget(db, budgetId, req.companyId!);
    await requireBudgetLevel(app, req, reply, budget.projectId, "read");
    const where = eq(budgetReconciliations.budgetId, budgetId);
    const [totalRow] = await db.select({ n: count() }).from(budgetReconciliations).where(where);
    const items = await db
      .select({
        id: budgetReconciliations.id,
        number: budgetReconciliations.number,
        reference: budgetReconciliations.reference,
        trigger: budgetReconciliations.trigger,
        runBy: budgetReconciliations.runBy,
        linesChecked: budgetReconciliations.linesChecked,
        linesUpdated: budgetReconciliations.linesUpdated,
        driftCount: budgetReconciliations.driftCount,
        driftAmount: budgetReconciliations.driftAmount,
        components: budgetReconciliations.components,
        totals: budgetReconciliations.totals,
        createdAt: budgetReconciliations.createdAt,
      })
      .from(budgetReconciliations)
      .where(where)
      .orderBy(desc(budgetReconciliations.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return { ...paginate(items, Number(totalRow?.n ?? 0), q), currency: budget.currency };
  });

  app.get("/budget-reconciliations/:reconciliationId", { preHandler: companyGate }, async (req, reply) => {
    const { reconciliationId } = req.params as { reconciliationId: string };
    const rows = await db
      .select()
      .from(budgetReconciliations)
      .where(and(eq(budgetReconciliations.id, reconciliationId), eq(budgetReconciliations.companyId, req.companyId!)))
      .limit(1);
    const run = rows[0];
    if (!run) throw notFound("Budget reconciliation not found");
    await requireBudgetLevel(app, req, reply, run.projectId, "read");
    return run;
  });

  /* ---------------------------------------------------------------- */
  /* Insights: earned value, swings, anomalies                         */
  /* ---------------------------------------------------------------- */

  async function loadSnapshotPoints(budgetId: string): Promise<Map<string, SnapshotPoint[]>> {
    const rows = await db
      .select({ id: budgetSnapshots.id, reference: budgetSnapshots.reference, asOfDate: budgetSnapshots.asOfDate, lines: budgetSnapshots.lines, detail: budgetSnapshots.detail })
      .from(budgetSnapshots)
      .where(eq(budgetSnapshots.budgetId, budgetId))
      .orderBy(asc(budgetSnapshots.asOfDate), asc(budgetSnapshots.number));
    const out = new Map<string, SnapshotPoint[]>();
    for (const s of rows) {
      if (isVoidSnapshot(s)) continue;
      for (const raw of s.lines as SnapshotLine[]) {
        if (!raw || typeof raw !== "object" || typeof raw.lineItemId !== "string") continue;
        const list = out.get(raw.lineItemId) ?? [];
        list.push({
          snapshotId: s.id,
          reference: s.reference,
          asOfDate: s.asOfDate,
          forecastFinal: Number(raw.forecastFinal ?? 0),
          jobToDateCosts: Number(raw.jobToDateCosts ?? 0),
          revisedBudget: Number(raw.revisedBudget ?? 0),
          percentComplete: Number(raw.percentComplete ?? 0),
        });
        out.set(raw.lineItemId, list);
      }
    }
    return out;
  }

  async function loadTasks(projectId: string) {
    return db
      .select({
        id: scheduleTasks.id,
        wbsCode: scheduleTasks.wbsCode,
        startDate: scheduleTasks.startDate,
        finishDate: scheduleTasks.finishDate,
        actualStart: scheduleTasks.actualStart,
        actualFinish: scheduleTasks.actualFinish,
        percentComplete: scheduleTasks.percentComplete,
      })
      .from(scheduleTasks)
      .where(eq(scheduleTasks.projectId, projectId));
  }

  async function computeInsights(budget: BudgetRow, asOf: string) {
    const [lines, history, tasks, lastRun] = await Promise.all([
      linesOfBudget(db, budget.id),
      loadSnapshotPoints(budget.id),
      loadTasks(budget.projectId),
      db
        .select()
        .from(budgetReconciliations)
        .where(eq(budgetReconciliations.budgetId, budget.id))
        .orderBy(desc(budgetReconciliations.number))
        .limit(1),
    ]);
    const perLine = lines.map((l) => {
      const il = insightLineOf(l);
      const window = scheduleWindowFor(l, tasks);
      const ev = earnedValue(il, window, asOf);
      const swing = forecastSwing(il, history.get(l.id) ?? []);
      const findings = detectLineAnomalies(il, ev, swing);
      return { line: il, window, ev, swing, findings };
    });
    const rollup = rollUpEarnedValue(perLine.map((p) => ({ line: p.line, ev: p.ev })));
    const burn = detectContingencyBurn(perLine.map((p) => p.line));
    const drift = lastRun[0]
      ? driftFinding(
          (lastRun[0].drift as Array<{ lineItemId: string; costCode: string; component: string; stored: number; rebuilt: number; delta: number }>) ?? [],
          budget.revisedBudgetTotal,
        )
      : null;
    const findings: Finding[] = sortFindings([
      ...perLine.flatMap((p) => p.findings),
      ...(burn.finding ? [burn.finding] : []),
      ...(drift ? [drift] : []),
    ]);
    return { lines, perLine, rollup, burn, drift, findings, lastRun: lastRun[0] ?? null, linesWithWindow: perLine.filter((p) => p.window !== null).length };
  }

  app.get("/budgets/:budgetId/insights", { preHandler: companyGate }, async (req, reply) => {
    const { budgetId } = req.params as { budgetId: string };
    const q = insightsQuery.parse(req.query);
    const budget = await fetchBudget(db, budgetId, req.companyId!);
    await requireBudgetLevel(app, req, reply, budget.projectId, "read");
    const asOf = q.asOf ?? today();
    const r = await computeInsights(budget, asOf);
    const severityRank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;
    const findings = q.severity ? r.findings.filter((f) => severityRank[f.severity] <= severityRank[q.severity!]) : r.findings;
    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const f of r.findings) bySeverity[f.severity] += 1;
    return {
      budgetId,
      currency: budget.currency,
      asOf,
      thresholds: DEFAULT_THRESHOLDS,
      lineCount: r.lines.length,
      linesWithScheduleWindow: r.linesWithWindow,
      earnedValue: r.rollup,
      contingency: { drawnShare: r.burn.drawnShare, progressShare: r.burn.progressShare, reasons: r.burn.reasons },
      findings,
      findingCount: r.findings.length,
      bySeverity,
      lastReconciliation: r.lastRun
        ? { id: r.lastRun.id, reference: r.lastRun.reference, createdAt: r.lastRun.createdAt, driftCount: r.lastRun.driftCount, driftAmount: r.lastRun.driftAmount, trigger: r.lastRun.trigger }
        : null,
      lines: r.perLine.map((p) => ({
        lineItemId: p.line.id,
        costCode: p.line.costCode,
        costType: p.line.costType,
        description: p.line.description,
        revisedBudget: p.line.revisedBudget,
        jobToDateCosts: p.line.jobToDateCosts,
        percentComplete: p.line.percentComplete,
        forecastFinal: p.line.forecastFinal,
        forecastMethod: p.line.forecastMethod,
        window: p.window,
        earnedValue: p.ev,
        swing: { run: p.swing.run, direction: p.swing.direction, netMovement: p.swing.netMovement, points: p.swing.points },
        findings: p.findings.map((f) => ({ kind: f.kind, severity: f.severity, title: f.title })),
      })),
    };
  });

  /* ---------------------------------------------------------------- */
  /* Budget vs actual variance report (#497)                           */
  /* ---------------------------------------------------------------- */

  app.get("/budgets/:budgetId/variance", { preHandler: companyGate }, async (req, reply) => {
    const { budgetId } = req.params as { budgetId: string };
    const q = varianceQuery.parse(req.query);
    const budget = await fetchBudget(db, budgetId, req.companyId!);
    await requireBudgetLevel(app, req, reply, budget.projectId, "read");
    const lines = await linesOfBudget(db, budgetId);
    let previous: { snapshotId: string; reference: string; asOfDate: string; lines: SnapshotLine[] } | null = null;
    if (q.compareWith) {
      const all = await db.select().from(budgetSnapshots).where(eq(budgetSnapshots.budgetId, budgetId));
      const asNumber = Number(q.compareWith);
      const row =
        all.find((s) => s.id === q.compareWith) ??
        all.find((s) => s.reference === q.compareWith) ??
        (Number.isInteger(asNumber) ? all.find((s) => s.number === asNumber) : undefined);
      if (!row) throw notFound(`Snapshot "${q.compareWith}" not found on this budget`);
      previous = { snapshotId: row.id, reference: row.reference, asOfDate: row.asOfDate, lines: row.lines as SnapshotLine[] };
    } else {
      const latest = await latestSnapshot(db, budgetId);
      if (latest) previous = { snapshotId: latest.id, reference: latest.reference, asOfDate: latest.asOfDate, lines: latest.lines as SnapshotLine[] };
    }
    const report = varianceReport(
      lines.map((l) => ({
        id: l.id,
        costCode: l.costCode,
        costType: l.costType,
        description: l.description,
        lineKind: l.lineKind,
        subJob: l.subJob,
        wbsPath: l.wbsPath,
        originalBudget: l.originalBudget,
        budgetModifications: l.budgetModifications,
        approvedChanges: l.approvedChanges,
        pendingBudgetChanges: l.pendingBudgetChanges,
        committedCost: l.committedCost,
        pendingCommitments: l.pendingCommitments,
        directCosts: l.directCosts,
        jobToDateCosts: l.jobToDateCosts,
        percentComplete: l.percentComplete,
        quantity: l.quantity,
        unitRate: l.unitRate,
        revisedBudget: l.revisedBudget,
        forecastToComplete: l.forecastToComplete,
        forecastFinal: l.forecastFinal,
        projectedOverUnder: l.projectedOverUnder,
      })),
      q.by,
      previous,
    );
    return {
      budgetId,
      currency: budget.currency,
      asOf: nowIso(),
      totalsCalculatedAt: budget.totalsCalculatedAt,
      lineCount: lines.length,
      ...report,
      reasons: previous ? [] : ["No period capture exists on this budget, so movement since the last capture cannot be shown."],
    };
  });

  /* ---------------------------------------------------------------- */
  /* Cash-flow forecast (S-curve by period)                            */
  /* ---------------------------------------------------------------- */

  app.get("/budgets/:budgetId/cashflow", { preHandler: companyGate }, async (req, reply) => {
    const { budgetId } = req.params as { budgetId: string };
    const q = cashflowQuery.parse(req.query);
    const budget = await fetchBudget(db, budgetId, req.companyId!);
    await requireBudgetLevel(app, req, reply, budget.projectId, "read");
    const [lines, project, tasks, commitmentRows, invoiceRows] = await Promise.all([
      linesOfBudget(db, budgetId),
      db.select({ startDate: projects.startDate, finishDate: projects.finishDate }).from(projects).where(eq(projects.id, budget.projectId)).limit(1),
      loadTasks(budget.projectId),
      db
        .select({
          id: commitments.id,
          reference: commitments.reference,
          status: commitments.status,
          currency: commitments.currency,
          revisedCommitmentSum: commitments.revisedCommitmentSum,
          startDate: commitments.startDate,
          estimatedCompletionDate: commitments.estimatedCompletionDate,
          actualCompletionDate: commitments.actualCompletionDate,
        })
        .from(commitments)
        .where(and(eq(commitments.companyId, budget.companyId), eq(commitments.projectId, budget.projectId), inArray(commitments.status, [...COMMITTED_STATUSES]))),
      db
        .select({
          invoiceId: invoices.id,
          reference: invoices.reference,
          status: invoices.status,
          kind: invoices.kind,
          currency: invoices.currency,
          billingDate: invoices.billingDate,
          approvedAt: invoices.approvedAt,
          budgetLineItemId: invoiceLineItems.budgetLineItemId,
          thisPeriodWork: invoiceLineItems.thisPeriodWork,
          thisPeriodStoredMaterials: invoiceLineItems.thisPeriodStoredMaterials,
        })
        .from(invoiceLineItems)
        .innerJoin(invoices, eq(invoices.id, invoiceLineItems.invoiceId))
        .where(and(eq(invoiceLineItems.companyId, budget.companyId), eq(invoiceLineItems.projectId, budget.projectId), eq(invoices.kind, "subcontractor_invoice"), inArray(invoices.status, [...INCURRED_INVOICE_STATUSES]))),
    ]);
    const reasons: string[] = [];
    const lineIds = new Set(lines.map((l) => l.id));
    const defaultWindow = { start: project[0]?.startDate ?? null, finish: project[0]?.finishDate ?? null };
    if (!defaultWindow.start || !defaultWindow.finish) {
      reasons.push("The project records no start/finish dates, so lines without a linked schedule window cannot be phased.");
    }
    const planned: Phaseable[] = lines.map((l) => {
      const w = scheduleWindowFor(l, tasks);
      return { id: l.id, reference: l.costCode, amount: l.revisedBudget, start: w?.start ?? null, finish: w?.finish ?? null };
    });
    const foreignCommitments = commitmentRows.filter((c) => c.currency.toUpperCase() !== budget.currency.toUpperCase());
    if (foreignCommitments.length > 0) {
      reasons.push(`${foreignCommitments.length} commitment(s) in another currency were excluded from the committed curve.`);
    }
    const committed: Phaseable[] = commitmentRows
      .filter((c) => c.currency.toUpperCase() === budget.currency.toUpperCase())
      .map((c) => ({ id: c.id, reference: c.reference, amount: c.revisedCommitmentSum, start: c.startDate, finish: c.actualCompletionDate ?? c.estimatedCompletionDate }));
    // actual = this-period work + stored per approved invoice, on the lines of THIS budget
    const byInvoice = new Map<string, DatedAmount>();
    let foreignInvoices = 0;
    for (const r of invoiceRows) {
      if (!r.budgetLineItemId || !lineIds.has(r.budgetLineItemId)) continue;
      if (r.currency.toUpperCase() !== budget.currency.toUpperCase()) {
        foreignInvoices += 1;
        continue;
      }
      const cur = byInvoice.get(r.invoiceId) ?? { id: r.invoiceId, reference: r.reference, amount: 0, date: r.billingDate ?? (r.approvedAt ? r.approvedAt.slice(0, 10) : null) };
      cur.amount = round2(cur.amount + r.thisPeriodWork + r.thisPeriodStoredMaterials);
      byInvoice.set(r.invoiceId, cur);
    }
    if (foreignInvoices > 0) reasons.push(`${foreignInvoices} invoice line(s) in another currency were excluded from the actual curve.`);
    const asOf = q.asOf ?? today();
    const flow = buildCashFlow({
      currency: budget.currency,
      asOf,
      defaultWindow,
      planned,
      committed,
      actual: [...byInvoice.values()],
      forecastToComplete: Math.max(0, budget.forecastToCompleteTotal),
      ...(q.from ? { from: q.from } : {}),
      ...(q.to ? { to: q.to } : {}),
    });
    return {
      budgetId,
      ...flow,
      reasons: [...reasons, ...flow.reasons],
      basis: {
        planned: "Each line's revised budget spread linearly over its linked schedule window (or the project window).",
        committed: "Approved/complete commitments spread over start → estimated completion.",
        actual: "This-period work and stored material on approved subcontractor invoices coded to this budget, by billing date.",
        forecast: "Actual to date, then the stored forecast to complete spread from today to the project finish.",
      },
    };
  });

  /* ---------------------------------------------------------------- */
  /* Saved views with calculated fields (#486–487)                     */
  /* ---------------------------------------------------------------- */

  async function fetchView(viewId: string, companyId: string) {
    const rows = await db
      .select()
      .from(budgetViews)
      .where(and(eq(budgetViews.id, viewId), eq(budgetViews.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Budget view not found");
    return rows[0];
  }

  function compileOrRefuse(raw: unknown) {
    const compiled = compileCalculatedFields(raw);
    if (compiled.errors.length > 0) {
      throw badRequest("One or more calculated fields are invalid; the view was not saved.", { errors: compiled.errors, columns: VIEW_COLUMN_KEYS });
    }
    return compiled;
  }

  app.get("/budgets/:budgetId/views", { preHandler: companyGate }, async (req, reply) => {
    const { budgetId } = req.params as { budgetId: string };
    const budget = await fetchBudget(db, budgetId, req.companyId!);
    await requireBudgetLevel(app, req, reply, budget.projectId, "read");
    const items = await db
      .select()
      .from(budgetViews)
      .where(and(eq(budgetViews.projectId, budget.projectId), or(isNull(budgetViews.budgetId), eq(budgetViews.budgetId, budgetId))))
      .orderBy(desc(budgetViews.isDefault), asc(budgetViews.name));
    return { items, total: items.length, columns: VIEW_COLUMN_KEYS };
  });

  app.post("/budgets/:budgetId/views", { preHandler: companyGate }, async (req, reply) => {
    const { budgetId } = req.params as { budgetId: string };
    const body = viewCreateSchema.parse(req.body);
    const budget = await fetchBudget(db, budgetId, req.companyId!);
    await requireBudgetLevel(app, req, reply, budget.projectId, "standard");
    const compiled = compileOrRefuse(body.calculatedFields ?? []);
    const id = newId("bvw");
    const scopedBudgetId = body.budgetId === null ? null : budgetId;
    await db.transaction(async (tx) => {
      if (body.isDefault) {
        await tx.update(budgetViews).set({ isDefault: 0, updatedAt: nowIso() }).where(eq(budgetViews.projectId, budget.projectId));
      }
      await tx.insert(budgetViews).values({
        id,
        companyId: budget.companyId,
        projectId: budget.projectId,
        budgetId: scopedBudgetId,
        name: body.name,
        description: body.description ?? null,
        isDefault: body.isDefault ? 1 : 0,
        columns: body.columns ?? [],
        calculatedFields: compiled.fields.map((f) => ({ key: f.key, label: f.label, expression: f.expression, format: f.format, reads: f.reads })),
        grouping: body.grouping ?? "none",
        filters: body.filters ?? {},
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      });
    });
    await appendLedger(db, {
      companyId: budget.companyId,
      projectId: budget.projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "budget_view",
      objectId: id,
      payload: { budgetId: scopedBudgetId, name: body.name, calculatedFields: compiled.fields.map((f) => f.key) },
    });
    return reply.status(201).send(await fetchView(id, budget.companyId));
  });

  app.get("/budget-views/:viewId", { preHandler: companyGate }, async (req, reply) => {
    const { viewId } = req.params as { viewId: string };
    const view = await fetchView(viewId, req.companyId!);
    await requireBudgetLevel(app, req, reply, view.projectId, "read");
    return view;
  });

  app.patch("/budget-views/:viewId", { preHandler: companyGate }, async (req, reply) => {
    const { viewId } = req.params as { viewId: string };
    const body = viewPatchSchema.parse(req.body);
    const view = await fetchView(viewId, req.companyId!);
    await requireBudgetLevel(app, req, reply, view.projectId, "standard");
    const set: Record<string, unknown> = { updatedAt: nowIso() };
    if (body.name !== undefined) set["name"] = body.name;
    if (body.description !== undefined) set["description"] = body.description;
    if (body.columns !== undefined) set["columns"] = body.columns;
    if (body.grouping !== undefined) set["grouping"] = body.grouping;
    if (body.filters !== undefined) set["filters"] = body.filters;
    if (body.detail !== undefined) set["detail"] = body.detail;
    if (body.calculatedFields !== undefined) {
      const compiled = compileOrRefuse(body.calculatedFields);
      set["calculatedFields"] = compiled.fields.map((f) => ({ key: f.key, label: f.label, expression: f.expression, format: f.format, reads: f.reads }));
    }
    await db.transaction(async (tx) => {
      if (body.isDefault === true) {
        await tx.update(budgetViews).set({ isDefault: 0, updatedAt: nowIso() }).where(eq(budgetViews.projectId, view.projectId));
        set["isDefault"] = 1;
      } else if (body.isDefault === false) {
        set["isDefault"] = 0;
      }
      await tx.update(budgetViews).set(set).where(eq(budgetViews.id, viewId));
    });
    await appendLedger(db, {
      companyId: view.companyId,
      projectId: view.projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "budget_view",
      objectId: viewId,
      payload: { changed: Object.keys(body) },
    });
    return fetchView(viewId, view.companyId);
  });

  app.delete("/budget-views/:viewId", { preHandler: companyGate }, async (req, reply) => {
    const { viewId } = req.params as { viewId: string };
    const view = await fetchView(viewId, req.companyId!);
    await requireBudgetLevel(app, req, reply, view.projectId, "standard");
    await db.delete(budgetViews).where(eq(budgetViews.id, viewId));
    await appendLedger(db, {
      companyId: view.companyId,
      projectId: view.projectId,
      actorId: req.user!.id,
      action: "delete",
      objectType: "budget_view",
      objectId: viewId,
      payload: { name: view.name },
    });
    return { ok: true };
  });

  /** The lines of a budget with every calculated field of a view evaluated. */
  app.get("/budget-views/:viewId/rows", { preHandler: companyGate }, async (req, reply) => {
    const { viewId } = req.params as { viewId: string };
    const q = z.object({ budgetId: idRef.optional() }).parse(req.query);
    const view = await fetchView(viewId, req.companyId!);
    await requireBudgetLevel(app, req, reply, view.projectId, "read");
    const budgetId = view.budgetId ?? q.budgetId;
    if (!budgetId) throw badRequest("This view spans every budget on the project — pass ?budgetId= to evaluate it against one.");
    const budget = await fetchBudget(db, budgetId, req.companyId!);
    if (budget.projectId !== view.projectId) throw badRequest("budgetId is not on this view's project.");
    const compiled = compileCalculatedFields(view.calculatedFields);
    const lines = await linesOfBudget(db, budgetId);
    const rows = lines.map((l) => ({ ...l, calculated: evaluateFields(compiled.fields, viewColumnsOf(l)) }));
    return {
      viewId,
      budgetId,
      currency: budget.currency,
      columns: view.columns,
      grouping: view.grouping,
      fields: compiled.fields.map((f) => ({ key: f.key, label: f.label, expression: f.expression, format: f.format, reads: f.reads })),
      errors: compiled.errors,
      items: rows,
      total: rows.length,
      totals: rollUpTotals(
        lines.map((l) => ({ ...viewColumnsOf(l), forecastToComplete: l.forecastToComplete, forecastFinal: l.forecastFinal, projectedOverUnder: l.projectedOverUnder, revisedBudget: l.revisedBudget })),
      ),
    };
  });

  /** Evaluate a field set against a budget without saving it — the editor's preview. */
  app.post("/budgets/:budgetId/views/evaluate", { preHandler: companyGate }, async (req, reply) => {
    const { budgetId } = req.params as { budgetId: string };
    const body = evaluateSchema.parse(req.body);
    const budget = await fetchBudget(db, budgetId, req.companyId!);
    await requireBudgetLevel(app, req, reply, budget.projectId, "read");
    const compiled = compileCalculatedFields(body.calculatedFields);
    const lines = await linesOfBudget(db, budgetId);
    return {
      budgetId,
      currency: budget.currency,
      errors: compiled.errors,
      fields: compiled.fields.map((f) => ({ key: f.key, label: f.label, expression: f.expression, format: f.format, reads: f.reads })),
      items: lines.slice(0, 200).map((l) => ({ lineItemId: l.id, costCode: l.costCode, costType: l.costType, description: l.description, calculated: evaluateFields(compiled.fields, viewColumnsOf(l)) })),
      truncated: lines.length > 200 ? lines.length - 200 : 0,
    };
  });

  /* ---------------------------------------------------------------- */
  /* ERP: GL → cost-code map (#481)                                    */
  /* ---------------------------------------------------------------- */

  app.get("/budget-erp/dialects", { preHandler: companyGate }, async () => ({
    items: Object.values(ERP_DIALECTS).map((d) => ({ system: d.system, label: d.label, template: d.template, accountHeaders: d.account, subAccountHeaders: d.subAccount, amountHeaders: d.amount })),
  }));

  app.get("/projects/:projectId/gl-cost-code-maps", { preHandler: readGate }, async (req) => {
    const q = glMapListQuery.parse(req.query);
    const clauses = [
      eq(glCostCodeMaps.companyId, req.companyId!),
      or(isNull(glCostCodeMaps.projectId), eq(glCostCodeMaps.projectId, req.projectId!)),
    ];
    if (q.erpSystem) clauses.push(eq(glCostCodeMaps.erpSystem, q.erpSystem));
    const where = and(...clauses);
    const all = await db.select().from(glCostCodeMaps).where(where).orderBy(asc(glCostCodeMaps.glAccount), asc(glCostCodeMaps.glSubAccount));
    const needle = q.q?.toLowerCase();
    const filtered = needle
      ? all.filter((m) => `${m.glAccount} ${m.glSubAccount ?? ""} ${m.glDescription ?? ""} ${m.costCode}`.toLowerCase().includes(needle))
      : all;
    const offset = pageOffset(q);
    return paginate(filtered.slice(offset, offset + q.pageSize), filtered.length, q);
  });

  async function resolveMapCostCode(companyId: string, projectId: string, input: { costCodeId?: string; costCode?: string }) {
    const all = await db.select().from(costCodes).where(eq(costCodes.companyId, companyId));
    const scoped = all.filter((c) => c.projectId === null || c.projectId === projectId);
    const match = input.costCodeId
      ? scoped.find((c) => c.id === input.costCodeId)
      : input.costCode
        ? (scoped.find((c) => c.projectId === projectId && c.code === input.costCode) ?? scoped.find((c) => c.code === input.costCode))
        : undefined;
    if (!match) {
      throw badRequest("A GL mapping must point at a cost code on the company standard list or this project — pass costCodeId or costCode.");
    }
    if (match.isActive === 0) throw badRequest(`Cost code "${match.code}" is inactive.`);
    return match;
  }

  app.post("/projects/:projectId/gl-cost-code-maps", { preHandler: standardGate }, async (req, reply) => {
    const body = glMapCreateSchema.parse(req.body);
    const companyId = req.companyId!;
    const projectId = req.projectId!;
    const code = await resolveMapCostCode(companyId, projectId, body);
    const erpSystem = body.erpSystem ?? "other";
    const scopeProjectId = body.projectOnly ? projectId : null;
    const clash = await db
      .select({ id: glCostCodeMaps.id })
      .from(glCostCodeMaps)
      .where(
        and(
          eq(glCostCodeMaps.companyId, companyId),
          scopeProjectId ? eq(glCostCodeMaps.projectId, scopeProjectId) : isNull(glCostCodeMaps.projectId),
          eq(glCostCodeMaps.erpSystem, erpSystem),
          eq(glCostCodeMaps.glAccount, body.glAccount),
          body.glSubAccount ? eq(glCostCodeMaps.glSubAccount, body.glSubAccount) : isNull(glCostCodeMaps.glSubAccount),
        ),
      )
      .limit(1);
    if (clash[0]) {
      throw conflict(`A ${erpSystem} mapping for GL account ${body.glAccount}${body.glSubAccount ? ` / ${body.glSubAccount}` : ""} already exists at this scope — edit it instead.`);
    }
    const id = newId("glm");
    await db.insert(glCostCodeMaps).values({
      id,
      companyId,
      projectId: scopeProjectId,
      erpSystem,
      glAccount: body.glAccount,
      glSubAccount: body.glSubAccount ?? null,
      glDescription: body.glDescription ?? null,
      costCodeId: code.id,
      costCode: code.code,
      costType: body.costType,
      isActive: 1,
      detail: body.detail ?? {},
      createdBy: req.user!.id,
    });
    await appendLedger(db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "gl_cost_code_map",
      objectId: id,
      payload: { erpSystem, glAccount: body.glAccount, glSubAccount: body.glSubAccount ?? null, costCode: code.code, costType: body.costType, scope: scopeProjectId ? "project" : "company" },
    });
    const rows = await db.select().from(glCostCodeMaps).where(eq(glCostCodeMaps.id, id)).limit(1);
    return reply.status(201).send(rows[0]);
  });

  async function fetchMap(mapId: string, companyId: string) {
    const rows = await db
      .select()
      .from(glCostCodeMaps)
      .where(and(eq(glCostCodeMaps.id, mapId), eq(glCostCodeMaps.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("GL mapping not found");
    return rows[0];
  }

  /** A company-wide map row belongs to every project; the gate runs on the project in the query. */
  async function requireMapLevel(req: Parameters<typeof requireBudgetLevel>[1], reply: Parameters<typeof requireBudgetLevel>[2], map: { projectId: string | null }, level: "standard" | "admin") {
    const q = z.object({ projectId: idRef.optional() }).parse(req.query ?? {});
    const projectId = map.projectId ?? q.projectId;
    if (!projectId) {
      throw badRequest("This mapping is company-wide; pass ?projectId= so the budget tool level can be checked on a project.");
    }
    await requireBudgetLevel(app, req, reply, projectId, level);
    return projectId;
  }

  app.patch("/gl-cost-code-maps/:mapId", { preHandler: companyGate }, async (req, reply) => {
    const { mapId } = req.params as { mapId: string };
    const body = glMapPatchSchema.parse(req.body);
    const map = await fetchMap(mapId, req.companyId!);
    const projectId = await requireMapLevel(req, reply, map, "standard");
    const set: Record<string, unknown> = { updatedAt: nowIso() };
    if (body.glDescription !== undefined) set["glDescription"] = body.glDescription;
    if (body.isActive !== undefined) set["isActive"] = body.isActive ? 1 : 0;
    if (body.detail !== undefined) set["detail"] = body.detail;
    if (body.costType !== undefined) set["costType"] = body.costType;
    if (body.costCodeId !== undefined || body.costCode !== undefined) {
      const code = await resolveMapCostCode(map.companyId, projectId, body);
      set["costCodeId"] = code.id;
      set["costCode"] = code.code;
    }
    await db.update(glCostCodeMaps).set(set).where(eq(glCostCodeMaps.id, mapId));
    await appendLedger(db, {
      companyId: map.companyId,
      projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "gl_cost_code_map",
      objectId: mapId,
      payload: { changed: Object.keys(body) },
    });
    return fetchMap(mapId, map.companyId);
  });

  app.delete("/gl-cost-code-maps/:mapId", { preHandler: companyGate }, async (req, reply) => {
    const { mapId } = req.params as { mapId: string };
    const map = await fetchMap(mapId, req.companyId!);
    const projectId = await requireMapLevel(req, reply, map, "admin");
    await db.delete(glCostCodeMaps).where(eq(glCostCodeMaps.id, mapId));
    await appendLedger(db, {
      companyId: map.companyId,
      projectId,
      actorId: req.user!.id,
      action: "delete",
      objectType: "gl_cost_code_map",
      objectId: mapId,
      payload: { glAccount: map.glAccount, glSubAccount: map.glSubAccount },
    });
    return { ok: true };
  });

  /* ---------------------------------------------------------------- */
  /* Contingency management (#499)                                     */
  /* ---------------------------------------------------------------- */

  app.get("/budgets/:budgetId/contingency", { preHandler: companyGate }, async (req, reply) => {
    const { budgetId } = req.params as { budgetId: string };
    const budget = await fetchBudget(db, budgetId, req.companyId!);
    await requireBudgetLevel(app, req, reply, budget.projectId, "read");
    const [lines, links, riskRows] = await Promise.all([
      linesOfBudget(db, budgetId),
      db.select().from(budgetContingencyLinks).where(eq(budgetContingencyLinks.budgetId, budgetId)),
      db.select().from(contingencies).where(and(eq(contingencies.companyId, budget.companyId), eq(contingencies.projectId, budget.projectId))),
    ]);
    const riskIds = riskRows.map((r) => r.id);
    const drawdowns = riskIds.length > 0 ? await db.select().from(contingencyDrawdowns).where(inArray(contingencyDrawdowns.contingencyId, riskIds)) : [];
    const drawnByRisk = new Map<string, number>();
    for (const d of drawdowns) drawnByRisk.set(d.contingencyId, round2((drawnByRisk.get(d.contingencyId) ?? 0) + d.amount));
    const linksByLine = new Map<string, typeof links>();
    for (const l of links) {
      const list = linksByLine.get(l.budgetLineItemId) ?? [];
      list.push(l);
      linksByLine.set(l.budgetLineItemId, list);
    }
    const contingencyLines = lines.filter((l) => l.lineKind === "contingency");
    const items = contingencyLines.map((l) => {
      const drawn = round2(Math.max(0, -l.budgetModifications));
      const mine = linksByLine.get(l.id) ?? [];
      const linked = mine.map((link) => {
        const risk = riskRows.find((r) => r.id === link.contingencyId);
        const riskDrawn = risk ? (drawnByRisk.get(risk.id) ?? 0) : null;
        return {
          linkId: link.id,
          contingencyId: link.contingencyId,
          name: risk?.name ?? null,
          currency: risk?.currency ?? null,
          amount: risk?.amount ?? null,
          confidenceLevel: risk?.confidenceLevel ?? null,
          isManagementReserve: risk?.isManagementReserve ?? null,
          drawn: riskDrawn,
          notes: link.notes,
          agrees:
            risk && risk.currency.toUpperCase() === budget.currency.toUpperCase()
              ? { amount: Math.abs(risk.amount - (l.originalBudget + l.approvedChanges)) <= 0.005, drawn: riskDrawn !== null && Math.abs(riskDrawn - drawn) <= 0.005 }
              : null,
          reasons:
            risk && risk.currency.toUpperCase() !== budget.currency.toUpperCase()
              ? [`The risk contingency is kept in ${risk.currency}; this budget is in ${budget.currency}, so the two are listed side by side and never compared.`]
              : [],
        };
      });
      return {
        lineItemId: l.id,
        costCode: l.costCode,
        costType: l.costType,
        description: l.description,
        status: l.status,
        original: round2(l.originalBudget + l.approvedChanges),
        drawn,
        remaining: round2(l.revisedBudget),
        drawnShare: l.originalBudget + l.approvedChanges > 0 ? round4(drawn / (l.originalBudget + l.approvedChanges)) : null,
        links: linked,
      };
    });
    const linkedRiskIds = new Set(links.map((l) => l.contingencyId));
    const remaining: Component =
      contingencyLines.length === 0
        ? unavailable(["This budget carries no contingency line."])
        : computed(contingencyLines.reduce((s, l) => s + l.revisedBudget, 0), { lines: contingencyLines.length });
    return {
      budgetId,
      currency: budget.currency,
      remaining,
      totals: {
        original: round2(contingencyLines.reduce((s, l) => s + l.originalBudget + l.approvedChanges, 0)),
        drawn: round2(contingencyLines.reduce((s, l) => s + Math.max(0, -l.budgetModifications), 0)),
      },
      items,
      /** risk-register contingencies on this project not yet linked to a budget line */
      unlinkedRiskContingencies: riskRows
        .filter((r) => !linkedRiskIds.has(r.id))
        .map((r) => ({ id: r.id, name: r.name, currency: r.currency, amount: r.amount, confidenceLevel: r.confidenceLevel, isManagementReserve: r.isManagementReserve, drawn: drawnByRisk.get(r.id) ?? 0 })),
    };
  });

  app.post("/budget-lines/:lineId/contingency-links", { preHandler: companyGate }, async (req, reply) => {
    const { lineId } = req.params as { lineId: string };
    const body = contingencyLinkSchema.parse(req.body);
    const { line, budget } = await fetchLineWithBudget(db, lineId, req.companyId!);
    await requireBudgetLevel(app, req, reply, budget.projectId, "standard");
    if (line.lineKind !== "contingency") {
      throw badRequest(`Line ${line.costCode} is a ${line.lineKind} line — only a contingency line links to a risk contingency.`);
    }
    const risk = await db
      .select()
      .from(contingencies)
      .where(and(eq(contingencies.id, body.contingencyId), eq(contingencies.companyId, budget.companyId), eq(contingencies.projectId, budget.projectId)))
      .limit(1);
    if (!risk[0]) throw badRequest("contingencyId does not reference a risk contingency on this project.");
    const dupe = await db
      .select({ id: budgetContingencyLinks.id })
      .from(budgetContingencyLinks)
      .where(and(eq(budgetContingencyLinks.budgetLineItemId, lineId), eq(budgetContingencyLinks.contingencyId, body.contingencyId)))
      .limit(1);
    if (dupe[0]) throw conflict("This line is already linked to that contingency.");
    const id = newId("bcl");
    await db.insert(budgetContingencyLinks).values({
      id,
      companyId: budget.companyId,
      projectId: budget.projectId,
      budgetId: budget.id,
      budgetLineItemId: lineId,
      contingencyId: body.contingencyId,
      notes: body.notes ?? null,
      createdBy: req.user!.id,
    });
    await appendLedger(db, {
      companyId: budget.companyId,
      projectId: budget.projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "budget_contingency_link",
      objectId: id,
      payload: { budgetId: budget.id, lineItemId: lineId, contingencyId: body.contingencyId, riskName: risk[0].name },
    });
    const rows = await db.select().from(budgetContingencyLinks).where(eq(budgetContingencyLinks.id, id)).limit(1);
    return reply.status(201).send(rows[0]);
  });

  app.delete("/budget-contingency-links/:linkId", { preHandler: companyGate }, async (req, reply) => {
    const { linkId } = req.params as { linkId: string };
    const rows = await db
      .select()
      .from(budgetContingencyLinks)
      .where(and(eq(budgetContingencyLinks.id, linkId), eq(budgetContingencyLinks.companyId, req.companyId!)))
      .limit(1);
    const link = rows[0];
    if (!link) throw notFound("Contingency link not found");
    await requireBudgetLevel(app, req, reply, link.projectId, "standard");
    await db.delete(budgetContingencyLinks).where(eq(budgetContingencyLinks.id, linkId));
    await appendLedger(db, {
      companyId: link.companyId,
      projectId: link.projectId,
      actorId: req.user!.id,
      action: "delete",
      objectType: "budget_contingency_link",
      objectId: linkId,
      payload: { lineItemId: link.budgetLineItemId, contingencyId: link.contingencyId },
    });
    return { ok: true };
  });

  /* ---------------------------------------------------------------- */
  /* Health inputs (plan §3.5)                                         */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/budget/health-inputs", { preHandler: readGate }, async (req) => {
    const active = await db
      .select()
      .from(budgets)
      .where(and(eq(budgets.companyId, req.companyId!), eq(budgets.projectId, req.projectId!), eq(budgets.isActive, 1)))
      .limit(1);
    const budget = active[0];
    if (!budget) {
      return {
        metrics: { variancePct: null, spentShare: null, obligatedShare: null, overrunLines: null, driftCount: null, contingencyDrawnShare: null, criticalFindings: null, highFindings: null },
        reasons: ["This project has no active budget, so no cost health can be stated."],
      };
    }
    const r = await computeInsights(budget, today());
    const revised = budget.revisedBudgetTotal;
    const reasons: string[] = [];
    if (revised <= 0) reasons.push("The active budget has no revised total, so the share metrics are not available.");
    const bySeverity = { critical: 0, high: 0 };
    for (const f of r.findings) if (f.severity === "critical" || f.severity === "high") bySeverity[f.severity] += 1;
    return {
      budgetId: budget.id,
      reference: budget.reference,
      currency: budget.currency,
      metrics: {
        variancePct: revised > 0 ? round4(budget.varianceTotal / revised) : null,
        spentShare: revised > 0 ? round4(budget.jobToDateCostsTotal / revised) : null,
        obligatedShare: revised > 0 ? round4((budget.committedTotal + budget.pendingCommitmentsTotal) / revised) : null,
        overrunLines: r.lines.filter((l) => l.projectedOverUnder < -0.005).length,
        driftCount: r.lastRun ? r.lastRun.driftCount : null,
        contingencyDrawnShare: r.burn.drawnShare,
        criticalFindings: bySeverity.critical,
        highFindings: bySeverity.high,
        cpi: r.rollup.cpi.value,
        spi: r.rollup.spi.value,
      },
      reasons: [...reasons, ...(r.lastRun ? [] : ["No reconciliation has run yet, so cost drift is unknown."]), ...r.burn.reasons],
    };
  });
};
