import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, count, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import {
  budgetChanges,
  budgetForecasts,
  budgetLineItems,
  budgetSnapshots,
  budgets,
  changeOrderPackages,
  commitmentSovLines,
  commitments,
  costCodes,
  invoiceLineItems,
  invoices,
  wbsSegments,
} from "@constructos/db";
import {
  BUDGET_CHANGE_KINDS,
  BUDGET_CHANGE_STATUSES,
  BUDGET_FORECAST_STATUSES,
  BUDGET_LINE_KINDS,
  BUDGET_LINE_STATUSES,
  BUDGET_SNAPSHOT_KINDS,
  BUDGET_STATUSES,
  COST_TYPES,
  FORECAST_METHODS,
  type BudgetChangeKind,
  type CostType,
  type ForecastMethod,
  type PermissionLevel,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import type { Db } from "../../lib/db.js";
// The CSV reader is the ingestion module's, not a second one written here:
// budget imports are the same RFC 4180 dialect as every other import on the
// platform, and a divergent parser is a divergent bug report.
import { parseCsv } from "../ingestion/datasets.js";
import {
  changeTargetColumn,
  computed,
  computeForecast,
  deriveLine,
  diffSnapshots,
  groupBy,
  legVerdict,
  nearlyEqual,
  reconcile,
  rollUpByWbs,
  rollUpTotals,
  round2,
  round4,
  snapshotContentHash,
  sumInCurrency,
  unavailable,
  type ChangeLeg,
  type Component,
  type LineAmounts,
  type RollupLine,
  type SnapshotLine,
} from "./calc.js";

/* ------------------------------------------------------------------ */
/* Wire schemas                                                        */
/* ------------------------------------------------------------------ */

/** ISO calendar date (YYYY-MM-DD) — the wire format for every date column here. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD)");
const money = z.number().finite();
const idRef = z.string().min(1).max(64);
const fraction = z.number().min(0).max(1);

const budgetCreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(20000).nullable().optional(),
  currency: z.string().min(3).max(8).optional(),
  /** ordered wbs_segments.id list this budget is broken down by */
  wbsSegmentIds: z.array(idRef).max(20).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
  /** make this the project's active budget on creation */
  isActive: z.boolean().optional(),
});

const budgetPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(20000).nullable().optional(),
  currency: z.string().min(3).max(8).optional(),
  wbsSegmentIds: z.array(idRef).max(20).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const budgetListQuery = pageQuerySchema.extend({
  status: z.enum(BUDGET_STATUSES).optional(),
  isActive: z.enum(["true", "false"]).optional(),
});

const lineFieldsSchema = z.object({
  costCodeId: idRef.nullable().optional(),
  /** resolved against the project's cost-code list when costCodeId is absent */
  costCode: z.string().min(1).max(50).optional(),
  costType: z.enum(COST_TYPES).optional(),
  wbsPath: z.string().max(200).nullable().optional(),
  subJob: z.string().max(100).nullable().optional(),
  description: z.string().min(1).max(2000),
  lineKind: z.enum(BUDGET_LINE_KINDS).optional(),
  status: z.enum(BUDGET_LINE_STATUSES).optional(),
  unit: z.string().max(20).nullable().optional(),
  quantity: money.nullable().optional(),
  unitRate: money.nullable().optional(),
  originalBudget: money.optional(),
  directCosts: money.optional(),
  jobToDateCosts: money.optional(),
  percentComplete: fraction.optional(),
  forecastMethod: z.enum(FORECAST_METHODS).optional(),
  forecastToComplete: money.nonnegative().optional(),
  notes: z.string().max(20000).nullable().optional(),
  sortOrder: z.number().int().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const lineCreateSchema = lineFieldsSchema;
const linePatchSchema = lineFieldsSchema.partial();

const lineListQuery = pageQuerySchema.extend({
  costType: z.enum(COST_TYPES).optional(),
  lineKind: z.enum(BUDGET_LINE_KINDS).optional(),
  status: z.enum(BUDGET_LINE_STATUSES).optional(),
  /** prefix match on the denormalized cost code */
  costCode: z.string().max(50).optional(),
  /** prefix match on the materialized WBS path */
  wbsPath: z.string().max(200).optional(),
  /** substring match on description / cost code */
  q: z.string().max(200).optional(),
  /** only lines whose projected over/under is negative */
  overrunOnly: z.enum(["true", "false"]).optional(),
  sort: z.enum(["sortOrder", "costCode", "revisedBudget", "variance"]).optional(),
});

const bulkLinesSchema = z.object({
  lines: z.array(lineCreateSchema).min(1).max(2000),
  /** update the amounts of an existing (costCode, costType) instead of failing */
  mode: z.enum(["create", "upsert"]).optional(),
});

const csvImportSchema = z.object({
  csv: z.string().min(1).max(4 * 1024 * 1024),
  /** parse + validate and report, writing nothing */
  dryRun: z.boolean().optional(),
  mode: z.enum(["create", "upsert"]).optional(),
});

const changeLegSchema = z.object({
  lineItemId: idRef,
  amount: money,
});

const changeCreateSchema = z.object({
  kind: z.enum(BUDGET_CHANGE_KINDS).optional(),
  title: z.string().min(1).max(300),
  description: z.string().max(20000).nullable().optional(),
  reason: z.string().max(2000).nullable().optional(),
  lines: z.array(changeLegSchema).max(200).optional(),
  /** two-leg shorthand for the common transfer */
  fromLineItemId: idRef.optional(),
  toLineItemId: idRef.optional(),
  amount: money.positive().optional(),
  effectiveDate: isoDate.optional(),
  sourceType: z.string().max(60).nullable().optional(),
  sourceId: idRef.nullable().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const changePatchSchema = changeCreateSchema.partial();

const changeListQuery = pageQuerySchema.extend({
  status: z.enum(BUDGET_CHANGE_STATUSES).optional(),
  kind: z.enum(BUDGET_CHANGE_KINDS).optional(),
  lineItemId: idRef.optional(),
});

const rejectSchema = z.object({ reason: z.string().min(1).max(2000) });

const snapshotCreateSchema = z.object({
  name: z.string().min(1).max(200),
  kind: z.enum(BUDGET_SNAPSHOT_KINDS).optional(),
  asOfDate: isoDate.optional(),
  periodStart: isoDate.nullable().optional(),
  periodEnd: isoDate.nullable().optional(),
  billingPeriodId: idRef.nullable().optional(),
  notes: z.string().max(20000).nullable().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const forecastCurvePointSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/, "Expected a month as YYYY-MM"),
  amount: money,
});

const forecastCreateSchema = z.object({
  /** null / absent = a whole-budget forecast */
  lineItemId: idRef.nullable().optional(),
  method: z.enum(FORECAST_METHODS),
  asOfDate: isoDate.optional(),
  /** required when method = "manual" */
  forecastToComplete: money.optional(),
  percentComplete: fraction.optional(),
  billingPeriodId: idRef.nullable().optional(),
  curve: z.array(forecastCurvePointSchema).max(240).optional(),
  assumptions: z.string().max(20000).nullable().optional(),
  notes: z.string().max(20000).nullable().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const forecastListQuery = pageQuerySchema.extend({
  status: z.enum(BUDGET_FORECAST_STATUSES).optional(),
  method: z.enum(FORECAST_METHODS).optional(),
  lineItemId: idRef.optional(),
});

const rollupQuery = z.object({
  by: z.enum(["cost_code", "cost_type", "wbs", "line_kind", "sub_job"]).default("cost_code"),
  /** roll cost codes up to their first N path segments (division rollup) */
  depth: z.coerce.number().int().min(1).max(6).optional(),
});

const forecastPreviewQuery = z.object({
  method: z.enum(FORECAST_METHODS).default("committed_plus_pending"),
  lineItemId: idRef.optional(),
});

/* ------------------------------------------------------------------ */
/* Row types + local helpers                                           */
/* ------------------------------------------------------------------ */

type BudgetRow = typeof budgets.$inferSelect;
type LineRow = typeof budgetLineItems.$inferSelect;
type ChangeRow = typeof budgetChanges.$inferSelect;
type SnapshotRow = typeof budgetSnapshots.$inferSelect;
type ForecastRow = typeof budgetForecasts.$inferSelect;

const pad3 = (n: number): string => String(n).padStart(3, "0");
const today = (): string => new Date().toISOString().slice(0, 10);
const nowIso = (): string => new Date().toISOString();

/** Commitment statuses that count as committed cost vs. still-pending exposure. */
const COMMITTED_STATUSES = ["approved", "complete"] as const;
const PENDING_COMMITMENT_STATUSES = ["draft", "out_for_bid", "out_for_signature"] as const;
/** Subcontractor invoice statuses that represent cost actually incurred. */
const INCURRED_INVOICE_STATUSES = ["approved", "approved_as_noted", "paid"] as const;
/** Rows per multi-value INSERT on the bulk/CSV import path. */
const INSERT_CHUNK = 500;

/** Cost-report projection of a line row — the exact shape calc.ts consumes. */
const amountsOf = (l: LineRow): LineAmounts => ({
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
});

const rollupOf = (l: LineRow): RollupLine & { wbsPath: string | null } => ({
  ...amountsOf(l),
  revisedBudget: l.revisedBudget,
  forecastToComplete: l.forecastToComplete,
  forecastFinal: l.forecastFinal,
  projectedOverUnder: l.projectedOverUnder,
  wbsPath: l.wbsPath,
});

/** Defensive read of the jsonb leg array — a stored row is data, not a type. */
function legsOf(row: { lines: unknown[] }): ChangeLeg[] {
  const out: ChangeLeg[] = [];
  for (const raw of row.lines) {
    if (!raw || typeof raw !== "object") continue;
    const leg = raw as Record<string, unknown>;
    const lineItemId = typeof leg["lineItemId"] === "string" ? leg["lineItemId"] : null;
    const amount = typeof leg["amount"] === "number" ? leg["amount"] : null;
    if (!lineItemId || amount === null || !Number.isFinite(amount)) continue;
    out.push({
      lineItemId,
      costCode: typeof leg["costCode"] === "string" ? leg["costCode"] : "",
      costType: (typeof leg["costType"] === "string" ? leg["costType"] : "other") as CostType,
      amount,
    });
  }
  return out;
}

function snapshotLinesOf(rows: readonly LineRow[]): SnapshotLine[] {
  return rows.map((l) => ({
    lineItemId: l.id,
    costCode: l.costCode,
    costType: l.costType,
    description: l.description,
    wbsPath: l.wbsPath,
    lineKind: l.lineKind,
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
  }));
}

/** Read a snapshot's frozen jsonb back into the diff's line shape. */
const storedSnapshotLines = (row: SnapshotRow): SnapshotLine[] =>
  row.lines as unknown as SnapshotLine[];

/**
 * M2 — BUDGET (spec Vol I §3.1). The root of construction financial
 * management: every commitment, change order and invoice on the platform
 * reconciles back to a budget line, so this module owns the arithmetic all of
 * them are measured against.
 *
 * Five tables, one discipline. `budgets` is the versioned plan;
 * `budget_line_items` is the cost report, one row per WBS coordinate (cost
 * code × cost type) bound to the project's real `cost_codes` and
 * `wbs_segments` rather than to a hierarchy invented here;
 * `budget_changes` is the only way money moves after lock, and it is refused
 * unless it balances and unless somebody other than the requester approves it;
 * `budget_snapshots` are immutable period captures with a content hash;
 * `budget_forecasts` record who forecast what, by which method, and when.
 *
 * Every figure is produced by ./calc.ts. Nothing in this file does
 * arithmetic of its own, which is what makes the number on the grid, the
 * number in the month-end capture and the number in the budget-vs-actual
 * summary provably the same number.
 *
 * Tool key: `budget`.
 */
export const budgetModule: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("budget", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("budget", "standard"),
  ];
  const companyGate = [app.authenticate, app.requireCompany];

  /**
   * Tool-permission check for sub-resource routes that carry no `:projectId`
   * (e.g. /budget-lines/:lineId). The owning project comes from the record,
   * is injected into params, and the standard gate runs — so a sub-resource
   * write enforces exactly the same budget tool level as a project route.
   */
  async function requireBudgetLevel(
    req: FastifyRequest,
    reply: FastifyReply,
    projectId: string,
    level: PermissionLevel,
  ): Promise<void> {
    (req.params as Record<string, string | undefined>)["projectId"] = projectId;
    await (app as FastifyInstance).requireTool("budget", level)(req, reply);
  }

  async function ledger(
    req: FastifyRequest,
    action: "create" | "update" | "delete" | "state_change",
    objectType: string,
    objectId: string,
    payload: Record<string, unknown>,
  ) {
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action,
      objectType,
      objectId,
      payload,
      projectId: (payload["projectId"] as string | undefined) ?? req.projectId ?? null,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Fetch helpers                                                     */
  /* ---------------------------------------------------------------- */

  async function fetchBudget(budgetId: string, companyId: string): Promise<BudgetRow> {
    const rows = await app.db
      .select()
      .from(budgets)
      .where(and(eq(budgets.id, budgetId), eq(budgets.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Budget not found");
    return rows[0];
  }

  async function fetchLineWithBudget(
    lineId: string,
    companyId: string,
  ): Promise<{ line: LineRow; budget: BudgetRow }> {
    const rows = await app.db
      .select({ line: budgetLineItems, budget: budgets })
      .from(budgetLineItems)
      .innerJoin(budgets, eq(budgets.id, budgetLineItems.budgetId))
      .where(and(eq(budgetLineItems.id, lineId), eq(budgetLineItems.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Budget line item not found");
    return rows[0];
  }

  async function fetchChangeWithBudget(
    changeId: string,
    companyId: string,
  ): Promise<{ change: ChangeRow; budget: BudgetRow }> {
    const rows = await app.db
      .select({ change: budgetChanges, budget: budgets })
      .from(budgetChanges)
      .innerJoin(budgets, eq(budgets.id, budgetChanges.budgetId))
      .where(and(eq(budgetChanges.id, changeId), eq(budgetChanges.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Budget change not found");
    return rows[0];
  }

  async function fetchForecastWithBudget(
    forecastId: string,
    companyId: string,
  ): Promise<{ forecast: ForecastRow; budget: BudgetRow }> {
    const rows = await app.db
      .select({ forecast: budgetForecasts, budget: budgets })
      .from(budgetForecasts)
      .innerJoin(budgets, eq(budgets.id, budgetForecasts.budgetId))
      .where(and(eq(budgetForecasts.id, forecastId), eq(budgetForecasts.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Budget forecast not found");
    return rows[0];
  }

  const linesOfBudget = (budgetId: string) =>
    app.db
      .select()
      .from(budgetLineItems)
      .where(eq(budgetLineItems.budgetId, budgetId))
      .orderBy(asc(budgetLineItems.sortOrder), asc(budgetLineItems.costCode));

  /* ---------------------------------------------------------------- */
  /* Cost-code / WBS binding                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Resolve a budget line to a REAL cost code (core.ts `cost_codes`), project
   * overrides winning over the company standard list. A budget line that does
   * not point at a cost code is a budget line nothing else can reconcile
   * against, so an unresolvable code is a 400 with instructions rather than a
   * silently created orphan.
   */
  type CostCodeRow = typeof costCodes.$inferSelect;
  interface CostCodeIndex {
    byId: Map<string, CostCodeRow>;
    /** company-standard plus this project's overrides, project first */
    scoped: CostCodeRow[];
  }

  /**
   * Load the project's cost-code list once. A 2,000-line import resolves
   * every row against this in memory rather than re-reading the list per row.
   */
  async function loadCostCodes(companyId: string, projectId: string): Promise<CostCodeIndex> {
    const all = await app.db.select().from(costCodes).where(eq(costCodes.companyId, companyId));
    return {
      byId: new Map(all.map((c) => [c.id, c])),
      scoped: all.filter((c) => c.projectId === null || c.projectId === projectId),
    };
  }

  function resolveCostCodeIn(
    index: CostCodeIndex,
    projectId: string,
    input: { costCodeId?: string | null; costCode?: string },
  ): { id: string; code: string; costType: CostType | null; wbsPath: string } {
    const { byId, scoped } = index;
    let match: CostCodeRow | undefined;
    if (input.costCodeId) {
      match = scoped.find((c) => c.id === input.costCodeId);
      if (!match) {
        throw badRequest(
          "costCodeId does not reference a cost code available to this project — a budget " +
            "line must bind to the company or project cost-code list.",
        );
      }
    } else if (input.costCode) {
      const wanted = input.costCode.trim();
      match =
        scoped.find((c) => c.projectId === projectId && c.code === wanted) ??
        scoped.find((c) => c.code === wanted);
      if (!match) {
        throw badRequest(
          `Cost code "${wanted}" does not exist on this project or in the company standard ` +
            "list. Create the cost code first — the budget binds to the cost-code structure, " +
            "it does not define a parallel one.",
        );
      }
    } else {
      throw badRequest("A budget line requires either costCodeId or costCode.");
    }
    if (match.isActive === 0) {
      throw badRequest(`Cost code "${match.code}" is inactive and cannot take new budget.`);
    }
    // Materialize the WBS path from the cost-code parent chain.
    const segments: string[] = [];
    let cursor: CostCodeRow | undefined = match;
    for (let depth = 0; cursor && depth < 10; depth += 1) {
      segments.unshift(cursor.code);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    return {
      id: match.id,
      code: match.code,
      costType: (match.costType as CostType | null) ?? null,
      wbsPath: segments.join("/"),
    };
  }

  /** Single-line convenience wrapper — loads the index and resolves one code. */
  async function resolveCostCode(
    companyId: string,
    projectId: string,
    input: { costCodeId?: string | null; costCode?: string },
  ) {
    return resolveCostCodeIn(await loadCostCodes(companyId, projectId), projectId, input);
  }

  async function assertWbsSegments(
    companyId: string,
    projectId: string,
    ids: string[],
  ): Promise<void> {
    if (ids.length === 0) return;
    const rows = await app.db
      .select({ id: wbsSegments.id })
      .from(wbsSegments)
      .where(
        and(
          eq(wbsSegments.companyId, companyId),
          eq(wbsSegments.projectId, projectId),
          inArray(wbsSegments.id, ids),
        ),
      );
    const found = new Set(rows.map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw badRequest(
        `wbsSegmentIds not found on this project: ${missing.join(", ")} — a budget is broken ` +
          "down by the project's own WBS segments.",
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Period guards                                                     */
  /* ---------------------------------------------------------------- */

  async function latestSnapshot(budgetId: string): Promise<SnapshotRow | null> {
    const rows = await app.db
      .select()
      .from(budgetSnapshots)
      .where(eq(budgetSnapshots.budgetId, budgetId))
      .orderBy(desc(budgetSnapshots.asOfDate), desc(budgetSnapshots.number))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * A snapshot is the answer to "what did the budget say at month end", and
   * that answer has to stay true. Once a period is captured, nothing may be
   * back-dated into it: a movement effective on or before the capture date
   * would change a figure somebody has already signed, reported or been paid
   * against.
   */
  async function assertPeriodOpen(budgetId: string, effectiveDate: string): Promise<void> {
    const snapshot = await latestSnapshot(budgetId);
    if (!snapshot) return;
    if (effectiveDate <= snapshot.asOfDate) {
      throw conflict(
        `The budget was captured as at ${snapshot.asOfDate} (${snapshot.reference} — ` +
          `"${snapshot.name}"). A movement effective ${effectiveDate} would rewrite a closed ` +
          "period; date it after the capture instead.",
      );
    }
  }

  /**
   * Direct edits to plan amounts stop at the first of two events: the budget
   * is locked, or a period has been captured. After either, `original` is
   * frozen and money moves only through an approved `budget_change` — which
   * is precisely what makes original-vs-revised defensible rather than an
   * edit log nobody can reconstruct.
   */
  async function assertPlanEditable(budget: BudgetRow): Promise<void> {
    if (budget.status === "closed") throw conflict("A closed budget cannot be edited.");
    if (budget.lockedAt) {
      throw conflict(
        `Budget ${budget.reference} was locked at ${budget.lockedAt}. Plan amounts now move ` +
          "only through an approved budget change.",
      );
    }
    const snapshot = await latestSnapshot(budget.id);
    if (snapshot) {
      throw conflict(
        `Budget ${budget.reference} was captured as at ${snapshot.asOfDate} ` +
          `(${snapshot.reference}). Plan amounts now move only through an approved budget ` +
          "change so the capture stays true.",
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Derived-column maintenance                                        */
  /* ---------------------------------------------------------------- */

  interface SettledForecast {
    forecastToComplete: number;
    /** why the line's method could not be applied; empty when it was */
    reasons: string[];
  }

  /**
   * Re-derive a line's forecast with its own recorded method. When the method
   * cannot be applied (no progress recorded, no quantity on a measured
   * method) the PREVIOUS figure is retained and the reason is handed back to
   * the caller to surface — a stored cost column is never quietly replaced
   * with a number the inputs do not support.
   */
  function settleForecast(
    line: LineAmounts & { forecastMethod: string; forecastToComplete: number },
    override?: number,
  ): SettledForecast {
    if (override !== undefined) return { forecastToComplete: round2(override), reasons: [] };
    const result = computeForecast(line.forecastMethod as ForecastMethod, line);
    if (result.forecastToComplete === null) {
      return { forecastToComplete: line.forecastToComplete, reasons: result.reasons };
    }
    return { forecastToComplete: result.forecastToComplete, reasons: [] };
  }

  /** Everything derivable from a line's stored inputs, ready to persist. */
  function derivedColumns(
    line: LineAmounts & { forecastMethod: string; forecastToComplete: number },
    override?: number,
  ): { set: Record<string, unknown>; reasons: string[] } {
    const settled = settleForecast(line, override);
    const derived = deriveLine(line, settled.forecastToComplete);
    return {
      set: {
        revisedBudget: derived.revisedBudget,
        forecastToComplete: derived.forecastToComplete,
        forecastFinal: derived.forecastFinal,
        projectedOverUnder: derived.projectedOverUnder,
      },
      reasons: settled.reasons,
    };
  }

  /**
   * Recompute the budget's materialized rollups from its lines. Called after
   * every write that can move a line amount; `totalsCalculatedAt` is stamped
   * so a stale grid is detectable rather than merely wrong.
   */
  async function recomputeBudgetTotals(db: Db, budgetId: string) {
    const rows = await db
      .select()
      .from(budgetLineItems)
      .where(eq(budgetLineItems.budgetId, budgetId));
    const totals = rollUpTotals(rows.map(rollupOf));
    await db
      .update(budgets)
      .set({ ...totals, totalsCalculatedAt: nowIso(), updatedAt: nowIso() })
      .where(eq(budgets.id, budgetId));
    return totals;
  }

  /* ---------------------------------------------------------------- */
  /* Budgets                                                           */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/budgets", { preHandler: standardGate }, async (req, reply) => {
    const body = budgetCreateSchema.parse(req.body);
    const companyId = req.companyId!;
    const projectId = req.projectId!;
    await assertWbsSegments(companyId, projectId, body.wbsSegmentIds ?? []);

    const number = await nextRecordNumber(app.db, projectId, "budget");
    const id = newId("bdg");
    await app.db.transaction(async (tx) => {
      if (body.isActive) {
        await tx
          .update(budgets)
          .set({ isActive: 0, updatedAt: nowIso() })
          .where(eq(budgets.projectId, projectId));
      }
      await tx.insert(budgets).values({
        id,
        companyId,
        projectId,
        number,
        reference: `BUD-${pad3(number)}`,
        name: body.name,
        description: body.description ?? null,
        status: "draft",
        isActive: body.isActive ? 1 : 0,
        currency: body.currency ?? "USD",
        wbsSegmentIds: body.wbsSegmentIds ?? [],
        settings: body.settings ?? {},
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      });
    });
    await ledger(req, "create", "budget", id, {
      projectId,
      reference: `BUD-${pad3(number)}`,
      name: body.name,
      currency: body.currency ?? "USD",
    });
    return reply.status(201).send(await fetchBudget(id, companyId));
  });

  app.get("/projects/:projectId/budgets", { preHandler: readGate }, async (req) => {
    const q = budgetListQuery.parse(req.query);
    const clauses = [
      eq(budgets.companyId, req.companyId!),
      eq(budgets.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(budgets.status, q.status));
    if (q.isActive) clauses.push(eq(budgets.isActive, q.isActive === "true" ? 1 : 0));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(budgets).where(where);
    const items = await app.db
      .select()
      .from(budgets)
      .where(where)
      .orderBy(desc(budgets.isActive), desc(budgets.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/budgets/:budgetId", { preHandler: companyGate }, async (req, reply) => {
    const { budgetId } = req.params as { budgetId: string };
    const budget = await fetchBudget(budgetId, req.companyId!);
    await requireBudgetLevel(req, reply, budget.projectId, "read");
    const [lineCountRow] = await app.db
      .select({ n: count() })
      .from(budgetLineItems)
      .where(eq(budgetLineItems.budgetId, budgetId));
    const snapshot = await latestSnapshot(budgetId);
    const totals = {
      originalBudgetTotal: budget.originalBudgetTotal,
      budgetModificationsTotal: budget.budgetModificationsTotal,
      approvedChangesTotal: budget.approvedChangesTotal,
      pendingChangesTotal: budget.pendingChangesTotal,
      revisedBudgetTotal: budget.revisedBudgetTotal,
      committedTotal: budget.committedTotal,
      pendingCommitmentsTotal: budget.pendingCommitmentsTotal,
      directCostsTotal: budget.directCostsTotal,
      jobToDateCostsTotal: budget.jobToDateCostsTotal,
      forecastToCompleteTotal: budget.forecastToCompleteTotal,
      forecastFinalTotal: budget.forecastFinalTotal,
      varianceTotal: budget.varianceTotal,
    };
    return {
      ...budget,
      lineCount: Number(lineCountRow?.n ?? 0),
      reconciliation: reconcile(totals),
      lastSnapshot: snapshot
        ? {
            id: snapshot.id,
            reference: snapshot.reference,
            name: snapshot.name,
            asOfDate: snapshot.asOfDate,
            capturedAt: snapshot.capturedAt,
          }
        : null,
      planEditable: !budget.lockedAt && budget.status !== "closed" && snapshot === null,
    };
  });

  app.patch("/budgets/:budgetId", { preHandler: companyGate }, async (req, reply) => {
    const { budgetId } = req.params as { budgetId: string };
    const body = budgetPatchSchema.parse(req.body);
    const budget = await fetchBudget(budgetId, req.companyId!);
    await requireBudgetLevel(req, reply, budget.projectId, "standard");
    if (budget.status === "closed") throw conflict("A closed budget cannot be edited.");

    const set: Record<string, unknown> = { updatedAt: nowIso() };
    if (body.name !== undefined) set["name"] = body.name;
    if (body.description !== undefined) set["description"] = body.description;
    if (body.settings !== undefined) set["settings"] = body.settings;
    if (body.detail !== undefined) set["detail"] = body.detail;
    if (body.wbsSegmentIds !== undefined) {
      await assertWbsSegments(budget.companyId, budget.projectId, body.wbsSegmentIds);
      set["wbsSegmentIds"] = body.wbsSegmentIds;
    }
    if (body.currency !== undefined && body.currency !== budget.currency) {
      const [lineCountRow] = await app.db
        .select({ n: count() })
        .from(budgetLineItems)
        .where(eq(budgetLineItems.budgetId, budgetId));
      if (Number(lineCountRow?.n ?? 0) > 0) {
        throw conflict(
          "A budget's currency cannot change once it holds lines — the stored amounts are " +
            "denominated in it and are never converted implicitly.",
        );
      }
      set["currency"] = body.currency;
    }
    await app.db.update(budgets).set(set).where(eq(budgets.id, budgetId));
    await ledger(req, "update", "budget", budgetId, {
      projectId: budget.projectId,
      changed: Object.keys(body),
    });
    return fetchBudget(budgetId, req.companyId!);
  });

  app.post("/budgets/:budgetId/activate", { preHandler: companyGate }, async (req, reply) => {
    const { budgetId } = req.params as { budgetId: string };
    const budget = await fetchBudget(budgetId, req.companyId!);
    await requireBudgetLevel(req, reply, budget.projectId, "admin");
    if (budget.status === "closed") throw conflict("A closed budget cannot be made active.");
    await app.db.transaction(async (tx) => {
      await tx
        .update(budgets)
        .set({ isActive: 0, updatedAt: nowIso() })
        .where(eq(budgets.projectId, budget.projectId));
      await tx
        .update(budgets)
        .set({ isActive: 1, updatedAt: nowIso() })
        .where(eq(budgets.id, budgetId));
    });
    await ledger(req, "state_change", "budget", budgetId, {
      projectId: budget.projectId,
      isActive: 1,
    });
    return fetchBudget(budgetId, req.companyId!);
  });

  app.post("/budgets/:budgetId/lock", { preHandler: companyGate }, async (req, reply) => {
    const { budgetId } = req.params as { budgetId: string };
    const budget = await fetchBudget(budgetId, req.companyId!);
    await requireBudgetLevel(req, reply, budget.projectId, "admin");
    if (budget.lockedAt) throw conflict(`Budget ${budget.reference} is already locked.`);
    if (budget.status === "closed") throw conflict("A closed budget cannot be locked.");
    const [lineCountRow] = await app.db
      .select({ n: count() })
      .from(budgetLineItems)
      .where(eq(budgetLineItems.budgetId, budgetId));
    if (Number(lineCountRow?.n ?? 0) === 0) {
      throw badRequest("An empty budget cannot be locked — there is nothing to freeze.");
    }
    await app.db
      .update(budgets)
      .set({
        status: "locked",
        lockedAt: nowIso(),
        lockedBy: req.user!.id,
        approvedBy: req.user!.id,
        approvedAt: nowIso(),
        updatedAt: nowIso(),
      })
      .where(eq(budgets.id, budgetId));
    const totals = await recomputeBudgetTotals(app.db, budgetId);
    await ledger(req, "state_change", "budget", budgetId, {
      projectId: budget.projectId,
      from: budget.status,
      to: "locked",
      originalBudgetTotal: totals.originalBudgetTotal,
    });
    return fetchBudget(budgetId, req.companyId!);
  });

  app.post("/budgets/:budgetId/close", { preHandler: companyGate }, async (req, reply) => {
    const { budgetId } = req.params as { budgetId: string };
    const budget = await fetchBudget(budgetId, req.companyId!);
    await requireBudgetLevel(req, reply, budget.projectId, "admin");
    if (budget.status === "closed") throw conflict("Budget is already closed.");
    const open = await app.db
      .select({ id: budgetChanges.id, reference: budgetChanges.reference })
      .from(budgetChanges)
      .where(
        and(
          eq(budgetChanges.budgetId, budgetId),
          inArray(budgetChanges.status, ["draft", "pending_approval"]),
        ),
      );
    if (open.length > 0) {
      throw conflict(
        `Budget has ${open.length} unresolved budget change(s) (${open
          .map((c) => c.reference)
          .join(", ")}). Approve, reject or void them before closing.`,
      );
    }
    await app.db
      .update(budgets)
      .set({ status: "closed", updatedAt: nowIso() })
      .where(eq(budgets.id, budgetId));
    await ledger(req, "state_change", "budget", budgetId, {
      projectId: budget.projectId,
      from: budget.status,
      to: "closed",
    });
    return fetchBudget(budgetId, req.companyId!);
  });

  app.delete("/budgets/:budgetId", { preHandler: companyGate }, async (req, reply) => {
    const { budgetId } = req.params as { budgetId: string };
    const budget = await fetchBudget(budgetId, req.companyId!);
    await requireBudgetLevel(req, reply, budget.projectId, "admin");
    if (budget.status !== "draft" || budget.lockedAt) {
      throw conflict("Only a draft, unlocked budget can be deleted.");
    }
    const snapshot = await latestSnapshot(budgetId);
    if (snapshot) {
      throw conflict(
        "This budget has immutable period captures against it and cannot be deleted.",
      );
    }
    await app.db.transaction(async (tx) => {
      await tx.delete(budgetForecasts).where(eq(budgetForecasts.budgetId, budgetId));
      await tx.delete(budgetChanges).where(eq(budgetChanges.budgetId, budgetId));
      await tx.delete(budgetLineItems).where(eq(budgetLineItems.budgetId, budgetId));
      await tx.delete(budgets).where(eq(budgets.id, budgetId));
    });
    await ledger(req, "delete", "budget", budgetId, {
      projectId: budget.projectId,
      reference: budget.reference,
    });
    return { ok: true };
  });

  /* ---------------------------------------------------------------- */
  /* Budget line items                                                 */
  /* ---------------------------------------------------------------- */

  /** Resolve unit basis + original budget, refusing a rate that disagrees. */
  function resolveLineAmount(
    quantity: number | null,
    unitRate: number | null,
    explicit: number | undefined,
    fallback: number,
  ): number {
    if (quantity !== null && unitRate !== null) {
      const extended = round2(quantity * unitRate);
      if (explicit !== undefined && !nearlyEqual(explicit, extended, 0.01)) {
        throw badRequest(
          `originalBudget ${explicit.toFixed(2)} does not match quantity × unitRate ` +
            `(${extended.toFixed(2)}). A measured line's budget is its extension — correct ` +
            "one of the three.",
        );
      }
      return extended;
    }
    return explicit !== undefined ? round2(explicit) : fallback;
  }

  interface PreparedLine {
    values: typeof budgetLineItems.$inferInsert;
    reasons: string[];
  }

  function prepareLine(
    budget: BudgetRow,
    body: z.infer<typeof lineCreateSchema>,
    actorId: string,
    index: CostCodeIndex,
  ): PreparedLine {
    const code = resolveCostCodeIn(index, budget.projectId, {
      costCodeId: body.costCodeId ?? null,
      ...(body.costCode !== undefined ? { costCode: body.costCode } : {}),
    });
    const costType: CostType = body.costType ?? code.costType ?? "other";
    const quantity = body.quantity ?? null;
    const unitRate = body.unitRate ?? null;
    const originalBudget = resolveLineAmount(quantity, unitRate, body.originalBudget, 0);
    const directCosts = round2(body.directCosts ?? 0);
    const jobToDateCosts = round2(body.jobToDateCosts ?? directCosts);
    const amounts: LineAmounts & { forecastMethod: string; forecastToComplete: number } = {
      originalBudget,
      budgetModifications: 0,
      approvedChanges: 0,
      pendingBudgetChanges: 0,
      committedCost: 0,
      pendingCommitments: 0,
      directCosts,
      jobToDateCosts,
      percentComplete: body.percentComplete ?? 0,
      quantity,
      unitRate,
      forecastMethod: body.forecastMethod ?? "remaining_budget",
      forecastToComplete: 0,
    };
    const derived = derivedColumns(amounts, body.forecastToComplete);
    return {
      values: {
        id: newId("bli"),
        budgetId: budget.id,
        companyId: budget.companyId,
        projectId: budget.projectId,
        costCodeId: code.id,
        costCode: code.code,
        costType,
        wbsPath: body.wbsPath ?? code.wbsPath,
        subJob: body.subJob ?? null,
        description: body.description,
        lineKind: body.lineKind ?? "standard",
        status: body.status ?? "active",
        unit: body.unit ?? null,
        quantity,
        unitRate,
        originalBudget,
        budgetModifications: 0,
        approvedChanges: 0,
        pendingBudgetChanges: 0,
        committedCost: 0,
        pendingCommitments: 0,
        directCosts,
        jobToDateCosts,
        forecastMethod: amounts.forecastMethod,
        percentComplete: amounts.percentComplete,
        notes: body.notes ?? null,
        sortOrder: body.sortOrder ?? 0,
        detail: body.detail ?? {},
        createdBy: actorId,
        ...derived.set,
      },
      reasons: derived.reasons,
    };
  }

  app.post("/budgets/:budgetId/lines", { preHandler: companyGate }, async (req, reply) => {
    const { budgetId } = req.params as { budgetId: string };
    const body = lineCreateSchema.parse(req.body);
    const budget = await fetchBudget(budgetId, req.companyId!);
    await requireBudgetLevel(req, reply, budget.projectId, "standard");
    await assertPlanEditable(budget);

    const prepared = prepareLine(
      budget,
      body,
      req.user!.id,
      await loadCostCodes(budget.companyId, budget.projectId),
    );
    const clash = await app.db
      .select({ id: budgetLineItems.id })
      .from(budgetLineItems)
      .where(
        and(
          eq(budgetLineItems.budgetId, budgetId),
          eq(budgetLineItems.costCode, prepared.values.costCode),
          eq(budgetLineItems.costType, prepared.values.costType as string),
        ),
      )
      .limit(1);
    if (clash[0]) {
      throw conflict(
        `A line for cost code ${prepared.values.costCode} / ${prepared.values.costType} ` +
          "already exists on this budget — a WBS coordinate holds exactly one line.",
      );
    }
    await app.db.insert(budgetLineItems).values(prepared.values);
    await recomputeBudgetTotals(app.db, budgetId);
    await ledger(req, "create", "budget_line_item", prepared.values.id, {
      projectId: budget.projectId,
      budgetId,
      costCode: prepared.values.costCode,
      costType: prepared.values.costType,
      originalBudget: prepared.values.originalBudget,
    });
    const created = await app.db
      .select()
      .from(budgetLineItems)
      .where(eq(budgetLineItems.id, prepared.values.id))
      .limit(1);
    return reply
      .status(201)
      .send({ ...created[0], forecastNotice: prepared.reasons.length > 0 ? prepared.reasons : undefined });
  });

  app.get("/budgets/:budgetId/lines", { preHandler: companyGate }, async (req, reply) => {
    const { budgetId } = req.params as { budgetId: string };
    const q = lineListQuery.parse(req.query);
    const budget = await fetchBudget(budgetId, req.companyId!);
    await requireBudgetLevel(req, reply, budget.projectId, "read");

    // The filter set is small and the predicates are prefix/substring, so the
    // page is cut in memory over the budget's own lines rather than in six
    // dialect-specific SQL fragments.
    const all = await linesOfBudget(budgetId);
    const needle = q.q?.toLowerCase();
    const filtered = all.filter((l) => {
      if (q.costType && l.costType !== q.costType) return false;
      if (q.lineKind && l.lineKind !== q.lineKind) return false;
      if (q.status && l.status !== q.status) return false;
      if (q.costCode && !l.costCode.startsWith(q.costCode)) return false;
      if (q.wbsPath && !(l.wbsPath ?? "").startsWith(q.wbsPath)) return false;
      if (q.overrunOnly === "true" && l.projectedOverUnder >= 0) return false;
      if (needle) {
        const hay = `${l.costCode} ${l.description} ${l.subJob ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    switch (q.sort) {
      case "costCode":
        filtered.sort((a, b) => a.costCode.localeCompare(b.costCode));
        break;
      case "revisedBudget":
        filtered.sort((a, b) => b.revisedBudget - a.revisedBudget);
        break;
      case "variance":
        filtered.sort((a, b) => a.projectedOverUnder - b.projectedOverUnder);
        break;
      default:
        break;
    }
    const offset = pageOffset(q);
    const page = filtered.slice(offset, offset + q.pageSize);
    return {
      ...paginate(page, filtered.length, q),
      pageTotals: rollUpTotals(page.map(rollupOf)),
      filteredTotals: rollUpTotals(filtered.map(rollupOf)),
      currency: budget.currency,
    };
  });

  app.get("/budget-lines/:lineId", { preHandler: companyGate }, async (req, reply) => {
    const { lineId } = req.params as { lineId: string };
    const { line, budget } = await fetchLineWithBudget(lineId, req.companyId!);
    await requireBudgetLevel(req, reply, budget.projectId, "read");
    const derived = deriveLine(amountsOf(line), line.forecastToComplete);
    const forecasts = await app.db
      .select()
      .from(budgetForecasts)
      .where(eq(budgetForecasts.lineItemId, lineId))
      .orderBy(desc(budgetForecasts.asOfDate))
      .limit(10);
    return { ...line, currency: budget.currency, derived, forecastHistory: forecasts };
  });

  app.patch("/budget-lines/:lineId", { preHandler: companyGate }, async (req, reply) => {
    const { lineId } = req.params as { lineId: string };
    const body = linePatchSchema.parse(req.body);
    const { line, budget } = await fetchLineWithBudget(lineId, req.companyId!);
    await requireBudgetLevel(req, reply, budget.projectId, "standard");
    if (budget.status === "closed") throw conflict("A closed budget cannot be edited.");
    if (line.status === "locked" && Object.keys(body).length > 0) {
      throw conflict(`Line ${line.costCode} is locked and cannot be edited.`);
    }

    // Plan columns freeze at lock/capture; actuals and progress keep moving.
    const touchesPlan =
      body.originalBudget !== undefined ||
      body.quantity !== undefined ||
      body.unitRate !== undefined ||
      body.costCodeId !== undefined ||
      body.costCode !== undefined ||
      body.costType !== undefined;
    if (touchesPlan) await assertPlanEditable(budget);

    const set: Record<string, unknown> = { updatedAt: nowIso() };
    let costCodeValue = line.costCode;
    let costTypeValue = line.costType;
    if (body.costCodeId !== undefined || body.costCode !== undefined) {
      const code = await resolveCostCode(budget.companyId, budget.projectId, {
        costCodeId: body.costCodeId ?? null,
        ...(body.costCode !== undefined ? { costCode: body.costCode } : {}),
      });
      costCodeValue = code.code;
      set["costCodeId"] = code.id;
      set["costCode"] = code.code;
      if (body.wbsPath === undefined) set["wbsPath"] = code.wbsPath;
    }
    if (body.costType !== undefined) {
      costTypeValue = body.costType;
      set["costType"] = body.costType;
    }
    if (costCodeValue !== line.costCode || costTypeValue !== line.costType) {
      const clash = await app.db
        .select({ id: budgetLineItems.id })
        .from(budgetLineItems)
        .where(
          and(
            eq(budgetLineItems.budgetId, line.budgetId),
            eq(budgetLineItems.costCode, costCodeValue),
            eq(budgetLineItems.costType, costTypeValue),
          ),
        )
        .limit(1);
      if (clash[0] && clash[0].id !== lineId) {
        throw conflict(
          `A line for ${costCodeValue} / ${costTypeValue} already exists on this budget.`,
        );
      }
    }

    for (const key of ["description", "wbsPath", "subJob", "unit", "notes", "detail"] as const) {
      if (body[key] !== undefined) set[key] = body[key];
    }
    if (body.lineKind !== undefined) set["lineKind"] = body.lineKind;
    if (body.status !== undefined) set["status"] = body.status;
    if (body.sortOrder !== undefined) set["sortOrder"] = body.sortOrder;

    const quantity = body.quantity !== undefined ? body.quantity : line.quantity;
    const unitRate = body.unitRate !== undefined ? body.unitRate : line.unitRate;
    const originalBudget = resolveLineAmount(
      quantity,
      unitRate,
      body.originalBudget,
      line.originalBudget,
    );
    set["quantity"] = quantity;
    set["unitRate"] = unitRate;
    set["originalBudget"] = originalBudget;

    const directCosts = round2(body.directCosts ?? line.directCosts);
    const jobToDateCosts = round2(
      body.jobToDateCosts !== undefined
        ? body.jobToDateCosts
        : body.directCosts !== undefined
          ? line.jobToDateCosts - line.directCosts + directCosts
          : line.jobToDateCosts,
    );
    set["directCosts"] = directCosts;
    set["jobToDateCosts"] = jobToDateCosts;
    const percentComplete = round4(body.percentComplete ?? line.percentComplete);
    set["percentComplete"] = percentComplete;
    const forecastMethod = body.forecastMethod ?? line.forecastMethod;
    set["forecastMethod"] = forecastMethod;

    const derived = derivedColumns(
      {
        ...amountsOf(line),
        originalBudget,
        directCosts,
        jobToDateCosts,
        percentComplete,
        quantity,
        unitRate,
        forecastMethod,
        forecastToComplete: line.forecastToComplete,
      },
      body.forecastToComplete,
    );
    Object.assign(set, derived.set);

    await app.db.update(budgetLineItems).set(set).where(eq(budgetLineItems.id, lineId));
    await recomputeBudgetTotals(app.db, line.budgetId);
    await ledger(req, "update", "budget_line_item", lineId, {
      projectId: budget.projectId,
      budgetId: line.budgetId,
      changed: Object.keys(body),
      originalBudget,
      revisedBudget: derived.set["revisedBudget"],
    });
    const updated = await app.db
      .select()
      .from(budgetLineItems)
      .where(eq(budgetLineItems.id, lineId))
      .limit(1);
    return {
      ...updated[0],
      forecastNotice: derived.reasons.length > 0 ? derived.reasons : undefined,
    };
  });

  app.delete("/budget-lines/:lineId", { preHandler: companyGate }, async (req, reply) => {
    const { lineId } = req.params as { lineId: string };
    const { line, budget } = await fetchLineWithBudget(lineId, req.companyId!);
    await requireBudgetLevel(req, reply, budget.projectId, "admin");
    await assertPlanEditable(budget);
    const withLeg = (
      await app.db
        .select({ id: budgetChanges.id, reference: budgetChanges.reference, lines: budgetChanges.lines })
        .from(budgetChanges)
        .where(
          and(
            eq(budgetChanges.budgetId, line.budgetId),
            inArray(budgetChanges.status, ["draft", "pending_approval", "approved"]),
          ),
        )
    ).filter((c) => legsOf(c).some((leg) => leg.lineItemId === lineId));
    if (withLeg.length > 0) {
      throw conflict(
        `Line ${line.costCode} carries budget movements (${withLeg
          .map((c) => c.reference)
          .join(", ")}) and cannot be deleted — void the changes first or close the line.`,
      );
    }
    await app.db.transaction(async (tx) => {
      await tx.delete(budgetForecasts).where(eq(budgetForecasts.lineItemId, lineId));
      await tx.delete(budgetLineItems).where(eq(budgetLineItems.id, lineId));
    });
    await recomputeBudgetTotals(app.db, line.budgetId);
    await ledger(req, "delete", "budget_line_item", lineId, {
      projectId: budget.projectId,
      budgetId: line.budgetId,
      costCode: line.costCode,
    });
    return { ok: true };
  });

  /* ---------------------------------------------------------------- */
  /* Bulk create + CSV import                                          */
  /* ---------------------------------------------------------------- */

  interface ImportIssue {
    row: number;
    field: string | null;
    message: string;
  }

  /**
   * Write a batch of prepared lines, upserting amounts onto an existing WBS
   * coordinate when asked. The batch is validated in full first and then
   * written in one transaction: a half-imported budget is worse than a
   * refused one, because nobody knows which half they are looking at.
   */
  async function writeLines(
    budget: BudgetRow,
    prepared: { rowNumber: number; values: typeof budgetLineItems.$inferInsert }[],
    mode: "create" | "upsert",
    actorId: string,
  ): Promise<{ created: number; updated: number; issues: ImportIssue[] }> {
    const existing = await app.db
      .select()
      .from(budgetLineItems)
      .where(eq(budgetLineItems.budgetId, budget.id));
    const byKey = new Map(existing.map((l) => [`${l.costCode} ${l.costType}`, l]));
    const issues: ImportIssue[] = [];
    let created = 0;
    let updated = 0;

    // Validate the WHOLE batch before writing a single row. A partially
    // applied import is the worst outcome available here: the caller is told
    // the import failed while the budget quietly holds half of it.
    const seen = new Set<string>();
    for (const item of prepared) {
      const key = `${item.values.costCode} ${item.values.costType as string}`;
      if (seen.has(key)) {
        issues.push({
          row: item.rowNumber,
          field: "costCode",
          message: `Duplicate WBS coordinate ${item.values.costCode} / ${item.values.costType as string} within this batch.`,
        });
        continue;
      }
      seen.add(key);
      if (byKey.has(key) && mode !== "upsert") {
        issues.push({
          row: item.rowNumber,
          field: "costCode",
          message: `A line for ${item.values.costCode} / ${item.values.costType as string} already exists on this budget.`,
        });
      }
    }
    if (issues.length > 0) return { created: 0, updated: 0, issues };

    const inserts: (typeof budgetLineItems.$inferInsert)[] = [];
    await app.db.transaction(async (tx) => {
      for (const item of prepared) {
        const key = `${item.values.costCode} ${item.values.costType as string}`;
        const clash = byKey.get(key);
        if (clash) {
          const merged: LineAmounts & { forecastMethod: string; forecastToComplete: number } = {
            ...amountsOf(clash),
            originalBudget: item.values.originalBudget ?? clash.originalBudget,
            directCosts: item.values.directCosts ?? clash.directCosts,
            jobToDateCosts: item.values.jobToDateCosts ?? clash.jobToDateCosts,
            percentComplete: item.values.percentComplete ?? clash.percentComplete,
            quantity: item.values.quantity ?? clash.quantity,
            unitRate: item.values.unitRate ?? clash.unitRate,
            forecastMethod: (item.values.forecastMethod ?? clash.forecastMethod) as string,
            forecastToComplete: clash.forecastToComplete,
          };
          const derived = derivedColumns(merged);
          await tx
            .update(budgetLineItems)
            .set({
              description: item.values.description ?? clash.description,
              unit: item.values.unit ?? clash.unit,
              quantity: merged.quantity ?? null,
              unitRate: merged.unitRate ?? null,
              originalBudget: merged.originalBudget,
              directCosts: merged.directCosts,
              jobToDateCosts: merged.jobToDateCosts,
              percentComplete: merged.percentComplete,
              forecastMethod: merged.forecastMethod,
              wbsPath: item.values.wbsPath ?? clash.wbsPath,
              subJob: item.values.subJob ?? clash.subJob,
              lineKind: item.values.lineKind ?? clash.lineKind,
              notes: item.values.notes ?? clash.notes,
              updatedAt: nowIso(),
              ...derived.set,
            })
            .where(eq(budgetLineItems.id, clash.id));
          updated += 1;
          continue;
        }
        inserts.push({ ...item.values, createdBy: actorId });
        created += 1;
      }
      // Chunked so a 2,000-line import is four round trips, not 2,000.
      for (let i = 0; i < inserts.length; i += INSERT_CHUNK) {
        await tx.insert(budgetLineItems).values(inserts.slice(i, i + INSERT_CHUNK));
      }
    });
    return { created, updated, issues };
  }

  app.post("/budgets/:budgetId/lines/bulk", { preHandler: companyGate }, async (req, reply) => {
    const { budgetId } = req.params as { budgetId: string };
    const body = bulkLinesSchema.parse(req.body);
    const budget = await fetchBudget(budgetId, req.companyId!);
    await requireBudgetLevel(req, reply, budget.projectId, "standard");
    await assertPlanEditable(budget);

    const codeIndex = await loadCostCodes(budget.companyId, budget.projectId);
    const prepared: { rowNumber: number; values: typeof budgetLineItems.$inferInsert }[] = [];
    const issues: ImportIssue[] = [];
    for (const [index, line] of body.lines.entries()) {
      try {
        const p = prepareLine(budget, line, req.user!.id, codeIndex);
        prepared.push({ rowNumber: index + 1, values: p.values });
      } catch (err) {
        issues.push({
          row: index + 1,
          field: null,
          message: err instanceof Error ? err.message : "Invalid line",
        });
      }
    }
    if (issues.length > 0) {
      throw badRequest("One or more budget lines were rejected; nothing was written.", { issues });
    }
    const result = await writeLines(budget, prepared, body.mode ?? "create", req.user!.id);
    if (result.issues.length > 0) {
      throw badRequest("One or more budget lines were rejected; nothing was written.", {
        issues: result.issues,
      });
    }
    await recomputeBudgetTotals(app.db, budgetId);
    await ledger(req, "create", "budget_line_item", budgetId, {
      projectId: budget.projectId,
      budgetId,
      bulk: true,
      created: result.created,
      updated: result.updated,
    });
    return reply.status(201).send({ ...result, budgetId });
  });

  /**
   * CSV import. Headers are matched case-insensitively in either snake_case
   * or camelCase; unknown columns are reported rather than ignored, because
   * a silently dropped `original_budget` column is a budget that is quietly
   * zero. `dryRun` validates and reports without writing a row.
   */
  const CSV_FIELDS: Record<string, keyof z.infer<typeof lineCreateSchema>> = {
    cost_code: "costCode",
    costcode: "costCode",
    code: "costCode",
    cost_type: "costType",
    costtype: "costType",
    description: "description",
    unit: "unit",
    quantity: "quantity",
    qty: "quantity",
    unit_rate: "unitRate",
    unitrate: "unitRate",
    rate: "unitRate",
    original_budget: "originalBudget",
    originalbudget: "originalBudget",
    amount: "originalBudget",
    line_kind: "lineKind",
    linekind: "lineKind",
    wbs_path: "wbsPath",
    wbspath: "wbsPath",
    sub_job: "subJob",
    subjob: "subJob",
    notes: "notes",
    sort_order: "sortOrder",
    sortorder: "sortOrder",
  };

  app.post("/budgets/:budgetId/lines/import", { preHandler: companyGate }, async (req, reply) => {
    const { budgetId } = req.params as { budgetId: string };
    const body = csvImportSchema.parse(req.body);
    const budget = await fetchBudget(budgetId, req.companyId!);
    await requireBudgetLevel(req, reply, budget.projectId, "standard");
    await assertPlanEditable(budget);

    const rows = parseCsv(body.csv);
    const header = rows[0];
    if (!header || rows.length < 2) {
      throw badRequest("CSV must carry a header row and at least one data row.");
    }
    const mapped = header.map((h) => CSV_FIELDS[h.trim().toLowerCase().replace(/\s+/g, "_")] ?? null);
    const unknown = header.filter((_, i) => mapped[i] === null || mapped[i] === undefined);
    if (!mapped.includes("costCode")) {
      throw badRequest(
        "CSV needs a cost_code column — every budget line binds to the project's cost-code list.",
      );
    }
    if (!mapped.includes("description")) {
      throw badRequest("CSV needs a description column.");
    }
    if (rows.length - 1 > 2000) {
      throw badRequest("A single import carries at most 2000 budget lines.");
    }

    const codeIndex = await loadCostCodes(budget.companyId, budget.projectId);
    const issues: ImportIssue[] = [];
    const prepared: { rowNumber: number; values: typeof budgetLineItems.$inferInsert }[] = [];
    const previews: unknown[] = [];
    for (let r = 1; r < rows.length; r += 1) {
      const row = rows[r]!;
      const rowNumber = r + 1;
      const raw: Record<string, unknown> = {};
      for (let c = 0; c < mapped.length; c += 1) {
        const field = mapped[c];
        if (!field) continue;
        const cell = (row[c] ?? "").trim();
        if (cell === "") continue;
        if (
          field === "quantity" ||
          field === "unitRate" ||
          field === "originalBudget" ||
          field === "sortOrder"
        ) {
          const n = Number(cell.replace(/[,\s]/g, ""));
          if (!Number.isFinite(n)) {
            issues.push({ row: rowNumber, field, message: `"${cell}" is not a number.` });
            continue;
          }
          raw[field] = field === "sortOrder" ? Math.trunc(n) : n;
        } else {
          raw[field] = cell;
        }
      }
      const parsed = lineCreateSchema.safeParse(raw);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          issues.push({
            row: rowNumber,
            field: issue.path.join(".") || null,
            message: issue.message,
          });
        }
        continue;
      }
      try {
        const p = prepareLine(budget, parsed.data, req.user!.id, codeIndex);
        prepared.push({ rowNumber, values: p.values });
        previews.push({
          row: rowNumber,
          costCode: p.values.costCode,
          costType: p.values.costType,
          description: p.values.description,
          originalBudget: p.values.originalBudget,
        });
      } catch (err) {
        issues.push({
          row: rowNumber,
          field: null,
          message: err instanceof Error ? err.message : "Invalid row",
        });
      }
    }

    if (body.dryRun) {
      return {
        dryRun: true,
        budgetId,
        parsedRows: rows.length - 1,
        readyRows: prepared.length,
        unknownColumns: unknown,
        issues,
        preview: previews.slice(0, 50),
        totalOriginalBudget: round2(
          prepared.reduce((s, p) => s + (p.values.originalBudget ?? 0), 0),
        ),
      };
    }
    if (issues.length > 0) {
      throw badRequest(
        `${issues.length} row(s) could not be imported; nothing was written. Fix the file or ` +
          "re-run with dryRun to review.",
        { issues },
      );
    }
    const result = await writeLines(budget, prepared, body.mode ?? "create", req.user!.id);
    if (result.issues.length > 0) {
      throw badRequest("One or more rows were rejected; nothing was written.", {
        issues: result.issues,
      });
    }
    await recomputeBudgetTotals(app.db, budgetId);
    await ledger(req, "create", "budget_line_item", budgetId, {
      projectId: budget.projectId,
      budgetId,
      importedRows: prepared.length,
      created: result.created,
      updated: result.updated,
    });
    return reply.status(201).send({
      dryRun: false,
      budgetId,
      parsedRows: rows.length - 1,
      unknownColumns: unknown,
      ...result,
    });
  });

  /* ---------------------------------------------------------------- */
  /* Budget changes — the only way money moves after lock              */
  /* ---------------------------------------------------------------- */

  /** Resolve request legs against real budget lines and stamp code/type. */
  async function resolveLegs(
    budget: BudgetRow,
    body: { lines?: { lineItemId: string; amount: number }[]; fromLineItemId?: string; toLineItemId?: string; amount?: number },
  ): Promise<{ legs: ChangeLeg[]; lines: Map<string, LineRow> }> {
    let requested: { lineItemId: string; amount: number }[];
    if (body.lines && body.lines.length > 0) {
      requested = body.lines;
    } else if (body.fromLineItemId && body.toLineItemId && body.amount !== undefined) {
      requested = [
        { lineItemId: body.fromLineItemId, amount: -Math.abs(body.amount) },
        { lineItemId: body.toLineItemId, amount: Math.abs(body.amount) },
      ];
    } else {
      throw badRequest(
        "A budget change needs either lines[] or the two-leg shorthand " +
          "(fromLineItemId, toLineItemId, amount).",
      );
    }
    const ids = [...new Set(requested.map((l) => l.lineItemId))];
    const rows = await app.db
      .select()
      .from(budgetLineItems)
      .where(
        and(eq(budgetLineItems.budgetId, budget.id), inArray(budgetLineItems.id, ids)),
      );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw badRequest(`Budget line(s) not on this budget: ${missing.join(", ")}`);
    }
    for (const row of rows) {
      if (row.status === "void" || row.status === "closed") {
        throw badRequest(
          `Line ${row.costCode} is ${row.status} and cannot take a budget movement.`,
        );
      }
    }
    const legs: ChangeLeg[] = requested.map((l) => {
      const row = byId.get(l.lineItemId)!;
      return {
        lineItemId: l.lineItemId,
        costCode: row.costCode,
        costType: row.costType as CostType,
        amount: round2(l.amount),
      };
    });
    return { legs, lines: byId };
  }

  async function assertOwnerChangeSource(
    budget: BudgetRow,
    sourceType: string | null | undefined,
    sourceId: string | null | undefined,
  ): Promise<void> {
    if (!sourceType || !sourceId) {
      throw badRequest(
        "An owner_change is the downstream effect of an executed prime contract change " +
          "order — it requires sourceType 'change_order_package' and the package's sourceId. " +
          "Money does not enter a budget without a signed instrument behind it.",
      );
    }
    if (sourceType !== "change_order_package") {
      throw badRequest(
        `sourceType "${sourceType}" cannot fund an owner_change; only ` +
          "'change_order_package' can.",
      );
    }
    const rows = await app.db
      .select({ id: changeOrderPackages.id, status: changeOrderPackages.status })
      .from(changeOrderPackages)
      .where(
        and(
          eq(changeOrderPackages.id, sourceId),
          eq(changeOrderPackages.projectId, budget.projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) {
      throw badRequest("sourceId does not reference a change order package on this project.");
    }
  }

  /** Move the legs on or off the lines' `pendingBudgetChanges` exposure. */
  async function applyPending(db: Db, legs: ChangeLeg[], sign: 1 | -1): Promise<void> {
    for (const leg of legs) {
      const rows = await db
        .select()
        .from(budgetLineItems)
        .where(eq(budgetLineItems.id, leg.lineItemId))
        .limit(1);
      const row = rows[0];
      if (!row) continue;
      await db
        .update(budgetLineItems)
        .set({
          pendingBudgetChanges: round2(row.pendingBudgetChanges + sign * leg.amount),
          updatedAt: nowIso(),
        })
        .where(eq(budgetLineItems.id, leg.lineItemId));
    }
  }

  app.post("/budgets/:budgetId/changes", { preHandler: companyGate }, async (req, reply) => {
    const { budgetId } = req.params as { budgetId: string };
    const body = changeCreateSchema.parse(req.body);
    const budget = await fetchBudget(budgetId, req.companyId!);
    await requireBudgetLevel(req, reply, budget.projectId, "standard");
    if (budget.status === "closed") throw conflict("A closed budget cannot take changes.");

    const kind: BudgetChangeKind = body.kind ?? "transfer";
    const effectiveDate = body.effectiveDate ?? today();
    await assertPeriodOpen(budgetId, effectiveDate);

    const { legs, lines } = await resolveLegs(budget, body);
    const verdict = legVerdict(kind, legs);
    if (verdict.error) throw badRequest(verdict.error, { legs, net: verdict.analysis.net });
    if (kind === "contingency_draw") {
      const sourcesAreContingency = verdict.analysis.sources.every(
        (s) => lines.get(s.lineItemId)?.lineKind === "contingency",
      );
      if (!sourcesAreContingency) {
        throw badRequest(
          "A contingency_draw must source from a line of kind 'contingency'. Record a " +
            "movement between working lines as a transfer.",
        );
      }
    }
    if (kind === "owner_change") {
      await assertOwnerChangeSource(budget, body.sourceType, body.sourceId);
    }

    const number = await nextRecordNumber(app.db, budgetId, "budget_change");
    const id = newId("bch");
    const reference = `BC-${pad3(number)}`;
    await app.db.insert(budgetChanges).values({
      id,
      companyId: budget.companyId,
      projectId: budget.projectId,
      budgetId,
      number,
      reference,
      kind,
      title: body.title,
      description: body.description ?? null,
      reason: body.reason ?? null,
      status: "draft",
      lines: legs,
      fromLineItemId: verdict.analysis.sources[0]?.lineItemId ?? null,
      toLineItemId: verdict.analysis.destinations[0]?.lineItemId ?? null,
      amount: verdict.analysis.amount,
      netEffect: kind === "owner_change" ? verdict.analysis.net : 0,
      effectiveDate,
      sourceType: body.sourceType ?? (kind === "owner_change" ? "change_order_package" : "manual"),
      sourceId: body.sourceId ?? null,
      // requestedBy is NOT NULL and is the author of the movement from the
      // moment it exists; requestedAt is stamped when it is actually submitted.
      requestedBy: req.user!.id,
      detail: body.detail ?? {},
      createdBy: req.user!.id,
    });
    await ledger(req, "create", "budget_change", id, {
      projectId: budget.projectId,
      budgetId,
      reference,
      kind,
      amount: verdict.analysis.amount,
      netEffect: verdict.analysis.net,
    });
    const created = await app.db
      .select()
      .from(budgetChanges)
      .where(eq(budgetChanges.id, id))
      .limit(1);
    return reply.status(201).send(created[0]);
  });

  app.get("/budgets/:budgetId/changes", { preHandler: companyGate }, async (req, reply) => {
    const { budgetId } = req.params as { budgetId: string };
    const q = changeListQuery.parse(req.query);
    const budget = await fetchBudget(budgetId, req.companyId!);
    await requireBudgetLevel(req, reply, budget.projectId, "read");
    const clauses = [eq(budgetChanges.budgetId, budgetId)];
    if (q.status) clauses.push(eq(budgetChanges.status, q.status));
    if (q.kind) clauses.push(eq(budgetChanges.kind, q.kind));
    const where = and(...clauses);
    const all = await app.db
      .select()
      .from(budgetChanges)
      .where(where)
      .orderBy(desc(budgetChanges.number));
    const filtered = q.lineItemId
      ? all.filter((c) => legsOf(c).some((l) => l.lineItemId === q.lineItemId))
      : all;
    const offset = pageOffset(q);
    return paginate(filtered.slice(offset, offset + q.pageSize), filtered.length, q);
  });

  app.get("/budget-changes/:changeId", { preHandler: companyGate }, async (req, reply) => {
    const { changeId } = req.params as { changeId: string };
    const { change, budget } = await fetchChangeWithBudget(changeId, req.companyId!);
    await requireBudgetLevel(req, reply, budget.projectId, "read");
    const analysis = legVerdict(change.kind as BudgetChangeKind, legsOf(change));
    return {
      ...change,
      currency: budget.currency,
      balance: {
        net: analysis.analysis.net,
        amount: analysis.analysis.amount,
        balances: analysis.analysis.balances,
        error: analysis.error,
      },
    };
  });

  app.patch("/budget-changes/:changeId", { preHandler: companyGate }, async (req, reply) => {
    const { changeId } = req.params as { changeId: string };
    const body = changePatchSchema.parse(req.body);
    const { change, budget } = await fetchChangeWithBudget(changeId, req.companyId!);
    await requireBudgetLevel(req, reply, budget.projectId, "standard");
    if (change.status !== "draft") {
      throw conflict(
        `Budget change ${change.reference} is ${change.status} and can no longer be edited — ` +
          "the movement it describes is already in the approval record.",
      );
    }
    const kind: BudgetChangeKind = (body.kind ?? change.kind) as BudgetChangeKind;
    const effectiveDate = body.effectiveDate ?? change.effectiveDate ?? today();
    await assertPeriodOpen(budget.id, effectiveDate);

    const set: Record<string, unknown> = { updatedAt: nowIso(), kind, effectiveDate };
    if (body.title !== undefined) set["title"] = body.title;
    if (body.description !== undefined) set["description"] = body.description;
    if (body.reason !== undefined) set["reason"] = body.reason;
    if (body.detail !== undefined) set["detail"] = body.detail;
    if (body.sourceType !== undefined) set["sourceType"] = body.sourceType;
    if (body.sourceId !== undefined) set["sourceId"] = body.sourceId;

    const hasNewLegs =
      (body.lines && body.lines.length > 0) ||
      (body.fromLineItemId && body.toLineItemId && body.amount !== undefined);
    const legs = hasNewLegs ? (await resolveLegs(budget, body)).legs : legsOf(change);
    const verdict = legVerdict(kind, legs);
    if (verdict.error) throw badRequest(verdict.error, { legs, net: verdict.analysis.net });
    if (kind === "owner_change") {
      await assertOwnerChangeSource(
        budget,
        (set["sourceType"] as string | undefined) ?? change.sourceType,
        (set["sourceId"] as string | undefined) ?? change.sourceId,
      );
    }
    set["lines"] = legs;
    set["amount"] = verdict.analysis.amount;
    set["netEffect"] = kind === "owner_change" ? verdict.analysis.net : 0;
    set["fromLineItemId"] = verdict.analysis.sources[0]?.lineItemId ?? null;
    set["toLineItemId"] = verdict.analysis.destinations[0]?.lineItemId ?? null;

    await app.db.update(budgetChanges).set(set).where(eq(budgetChanges.id, changeId));
    await ledger(req, "update", "budget_change", changeId, {
      projectId: budget.projectId,
      budgetId: budget.id,
      changed: Object.keys(body),
    });
    const updated = await app.db
      .select()
      .from(budgetChanges)
      .where(eq(budgetChanges.id, changeId))
      .limit(1);
    return updated[0];
  });

  app.post("/budget-changes/:changeId/submit", { preHandler: companyGate }, async (req, reply) => {
    const { changeId } = req.params as { changeId: string };
    const { change, budget } = await fetchChangeWithBudget(changeId, req.companyId!);
    await requireBudgetLevel(req, reply, budget.projectId, "standard");
    if (change.status !== "draft") {
      throw conflict(`Budget change ${change.reference} is already ${change.status}.`);
    }
    const legs = legsOf(change);
    const verdict = legVerdict(change.kind as BudgetChangeKind, legs);
    if (verdict.error) throw badRequest(verdict.error, { net: verdict.analysis.net });
    await assertPeriodOpen(budget.id, change.effectiveDate ?? today());

    await app.db.transaction(async (tx) => {
      await applyPending(tx, legs, 1);
      await tx
        .update(budgetChanges)
        .set({
          status: "pending_approval",
          requestedBy: req.user!.id,
          requestedAt: nowIso(),
          updatedAt: nowIso(),
        })
        .where(eq(budgetChanges.id, changeId));
    });
    await recomputeBudgetTotals(app.db, budget.id);
    await ledger(req, "state_change", "budget_change", changeId, {
      projectId: budget.projectId,
      budgetId: budget.id,
      from: "draft",
      to: "pending_approval",
      requestedBy: req.user!.id,
      amount: change.amount,
    });
    const updated = await app.db
      .select()
      .from(budgetChanges)
      .where(eq(budgetChanges.id, changeId))
      .limit(1);
    return updated[0];
  });

  /**
   * Approve a movement. Two refusals live here and neither is negotiable:
   *
   *  - SEGREGATION OF DUTIES (ADR 0004). The approver may not be the person
   *    who requested the movement, nor the person who drafted it. A project
   *    manager moving money out of contingency into his own overrun on his
   *    own signature is the single most common financial control failure on
   *    a construction project, and the columns exist so the refusal is
   *    provable afterwards.
   *  - BALANCE. The legs are re-verified at approval, not merely at
   *    creation: lines can change underneath a pending request, and what is
   *    approved is what is applied.
   */
  app.post("/budget-changes/:changeId/approve", { preHandler: companyGate }, async (req, reply) => {
    const { changeId } = req.params as { changeId: string };
    const { change, budget } = await fetchChangeWithBudget(changeId, req.companyId!);
    await requireBudgetLevel(req, reply, budget.projectId, "admin");
    if (change.status !== "pending_approval") {
      throw conflict(
        `Only a budget change pending approval can be approved; ${change.reference} is ` +
          `${change.status}.`,
      );
    }
    const actorId = req.user!.id;
    if (actorId === change.requestedBy) {
      throw forbidden(
        "Segregation of duties: the approver of a budget movement may not be the person who " +
          "requested it. Route this to another approver.",
      );
    }
    if (actorId === change.createdBy) {
      throw forbidden(
        "Segregation of duties: the approver of a budget movement may not be the person who " +
          "drafted it.",
      );
    }
    const legs = legsOf(change);
    const kind = change.kind as BudgetChangeKind;
    const verdict = legVerdict(kind, legs);
    if (verdict.error) throw badRequest(verdict.error, { net: verdict.analysis.net });
    const effectiveDate = change.effectiveDate ?? today();
    await assertPeriodOpen(budget.id, effectiveDate);

    const targetColumn = changeTargetColumn(kind);
    const rows = await app.db
      .select()
      .from(budgetLineItems)
      .where(
        and(
          eq(budgetLineItems.budgetId, budget.id),
          inArray(
            budgetLineItems.id,
            legs.map((l) => l.lineItemId),
          ),
        ),
      );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const missing = legs.filter((l) => !byId.has(l.lineItemId));
    if (missing.length > 0) {
      throw conflict(
        `Budget line(s) on this movement no longer exist: ${missing
          .map((l) => l.costCode)
          .join(", ")}. Void the change and raise it again.`,
      );
    }
    // A movement may not drive a line's revised budget below zero: that is
    // not a transfer, it is an unfunded position wearing one's clothes.
    for (const leg of legs) {
      const row = byId.get(leg.lineItemId)!;
      const next = round2(
        row.originalBudget +
          (targetColumn === "budgetModifications"
            ? row.budgetModifications + leg.amount
            : row.budgetModifications) +
          (targetColumn === "approvedChanges" ? row.approvedChanges + leg.amount : row.approvedChanges),
      );
      if (next < 0) {
        throw conflict(
          `Approving this movement would take line ${row.costCode} / ${row.costType} to ` +
            `${next.toFixed(2)}. A budget line cannot hold a negative revised budget — reduce ` +
            "the transfer or source it elsewhere.",
        );
      }
    }

    const approvedAt = nowIso();
    await app.db.transaction(async (tx) => {
      await applyPending(tx, legs, -1);
      for (const leg of legs) {
        const row = byId.get(leg.lineItemId)!;
        const nextAmounts: LineAmounts & { forecastMethod: string; forecastToComplete: number } = {
          ...amountsOf(row),
          pendingBudgetChanges: round2(row.pendingBudgetChanges - leg.amount),
          [targetColumn]: round2(row[targetColumn] + leg.amount),
          forecastMethod: row.forecastMethod,
          forecastToComplete: row.forecastToComplete,
        } as LineAmounts & { forecastMethod: string; forecastToComplete: number };
        const derived = derivedColumns(nextAmounts);
        await tx
          .update(budgetLineItems)
          .set({
            [targetColumn]: nextAmounts[targetColumn],
            pendingBudgetChanges: nextAmounts.pendingBudgetChanges,
            updatedAt: nowIso(),
            ...derived.set,
          })
          .where(eq(budgetLineItems.id, leg.lineItemId));
      }
      await tx
        .update(budgetChanges)
        .set({
          status: "approved",
          approvedBy: actorId,
          approvedAt,
          updatedAt: approvedAt,
        })
        .where(eq(budgetChanges.id, changeId));
      if (budget.status === "locked") {
        await tx
          .update(budgets)
          .set({ status: "revised", updatedAt: approvedAt })
          .where(eq(budgets.id, budget.id));
      }
    });
    const totals = await recomputeBudgetTotals(app.db, budget.id);
    await ledger(req, "state_change", "budget_change", changeId, {
      projectId: budget.projectId,
      budgetId: budget.id,
      from: "pending_approval",
      to: "approved",
      requestedBy: change.requestedBy,
      approvedBy: actorId,
      kind,
      amount: change.amount,
      netEffect: change.netEffect,
      revisedBudgetTotal: totals.revisedBudgetTotal,
    });
    const updated = await app.db
      .select()
      .from(budgetChanges)
      .where(eq(budgetChanges.id, changeId))
      .limit(1);
    return { ...updated[0], budgetTotals: totals };
  });

  app.post("/budget-changes/:changeId/reject", { preHandler: companyGate }, async (req, reply) => {
    const { changeId } = req.params as { changeId: string };
    const body = rejectSchema.parse(req.body);
    const { change, budget } = await fetchChangeWithBudget(changeId, req.companyId!);
    await requireBudgetLevel(req, reply, budget.projectId, "admin");
    if (change.status !== "pending_approval") {
      throw conflict(`Only a budget change pending approval can be rejected.`);
    }
    if (req.user!.id === change.requestedBy) {
      throw forbidden(
        "Segregation of duties: the person who requested a movement may not adjudicate it. " +
          "Void it instead if it should not proceed.",
      );
    }
    const legs = legsOf(change);
    await app.db.transaction(async (tx) => {
      await applyPending(tx, legs, -1);
      await tx
        .update(budgetChanges)
        .set({
          status: "rejected",
          rejectedBy: req.user!.id,
          rejectedAt: nowIso(),
          rejectionReason: body.reason,
          updatedAt: nowIso(),
        })
        .where(eq(budgetChanges.id, changeId));
    });
    await recomputeBudgetTotals(app.db, budget.id);
    await ledger(req, "state_change", "budget_change", changeId, {
      projectId: budget.projectId,
      budgetId: budget.id,
      from: "pending_approval",
      to: "rejected",
      rejectedBy: req.user!.id,
      reason: body.reason,
    });
    const updated = await app.db
      .select()
      .from(budgetChanges)
      .where(eq(budgetChanges.id, changeId))
      .limit(1);
    return updated[0];
  });

  app.post("/budget-changes/:changeId/void", { preHandler: companyGate }, async (req, reply) => {
    const { changeId } = req.params as { changeId: string };
    const { change, budget } = await fetchChangeWithBudget(changeId, req.companyId!);
    await requireBudgetLevel(req, reply, budget.projectId, "standard");
    if (change.status === "approved") {
      throw conflict(
        "An approved budget movement cannot be voided — the money has moved. Raise a " +
          "reversing change so both sides stay on the record.",
      );
    }
    if (change.status === "void") throw conflict("Budget change is already void.");
    const legs = legsOf(change);
    await app.db.transaction(async (tx) => {
      if (change.status === "pending_approval") await applyPending(tx, legs, -1);
      await tx
        .update(budgetChanges)
        .set({ status: "void", updatedAt: nowIso() })
        .where(eq(budgetChanges.id, changeId));
    });
    await recomputeBudgetTotals(app.db, budget.id);
    await ledger(req, "state_change", "budget_change", changeId, {
      projectId: budget.projectId,
      budgetId: budget.id,
      from: change.status,
      to: "void",
    });
    const updated = await app.db
      .select()
      .from(budgetChanges)
      .where(eq(budgetChanges.id, changeId))
      .limit(1);
    return updated[0];
  });

  /**
   * The movement ledger: every approved leg in effect order with the running
   * balance it produced, per line and in total. This is the audit answer to
   * "how did this line get from its original budget to today's figure", and
   * it is derived from the change rows rather than kept as a second copy.
   */
  app.get("/budgets/:budgetId/movements", { preHandler: companyGate }, async (req, reply) => {
    const { budgetId } = req.params as { budgetId: string };
    const budget = await fetchBudget(budgetId, req.companyId!);
    await requireBudgetLevel(req, reply, budget.projectId, "read");
    const lines = await linesOfBudget(budgetId);
    const byId = new Map(lines.map((l) => [l.id, l]));
    const approved = await app.db
      .select()
      .from(budgetChanges)
      .where(and(eq(budgetChanges.budgetId, budgetId), eq(budgetChanges.status, "approved")))
      .orderBy(asc(budgetChanges.effectiveDate), asc(budgetChanges.number));

    const running = new Map<string, number>(lines.map((l) => [l.id, l.originalBudget]));
    let runningTotal = round2([...running.values()].reduce((s, v) => s + v, 0));
    const openingTotal = runningTotal;
    const movements: unknown[] = [];
    for (const change of approved) {
      for (const leg of legsOf(change)) {
        const before = running.get(leg.lineItemId) ?? 0;
        const after = round2(before + leg.amount);
        running.set(leg.lineItemId, after);
        runningTotal = round2(runningTotal + leg.amount);
        movements.push({
          changeId: change.id,
          reference: change.reference,
          kind: change.kind,
          title: change.title,
          reason: change.reason,
          effectiveDate: change.effectiveDate,
          requestedBy: change.requestedBy,
          approvedBy: change.approvedBy,
          approvedAt: change.approvedAt,
          sourceType: change.sourceType,
          sourceId: change.sourceId,
          lineItemId: leg.lineItemId,
          costCode: leg.costCode || byId.get(leg.lineItemId)?.costCode || "",
          costType: leg.costType,
          amount: leg.amount,
          lineBalanceAfter: after,
          budgetTotalAfter: runningTotal,
        });
      }
    }
    return {
      budgetId,
      currency: budget.currency,
      openingTotal,
      closingTotal: runningTotal,
      movementCount: movements.length,
      /** proves the ledger reconstructs the stored revised total */
      reconcilesToRevisedTotal: nearlyEqual(runningTotal, budget.revisedBudgetTotal),
      storedRevisedTotal: budget.revisedBudgetTotal,
      movements,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Snapshots — immutable period captures                             */
  /* ---------------------------------------------------------------- */

  app.post("/budgets/:budgetId/snapshots", { preHandler: companyGate }, async (req, reply) => {
    const { budgetId } = req.params as { budgetId: string };
    const body = snapshotCreateSchema.parse(req.body);
    const budget = await fetchBudget(budgetId, req.companyId!);
    await requireBudgetLevel(req, reply, budget.projectId, "standard");

    const asOfDate = body.asOfDate ?? today();
    const previous = await latestSnapshot(budgetId);
    if (previous && asOfDate < previous.asOfDate) {
      throw conflict(
        `A capture already exists as at ${previous.asOfDate} (${previous.reference}). A period ` +
          "capture cannot be back-dated behind one that has already been taken.",
      );
    }
    const lines = await linesOfBudget(budgetId);
    if (lines.length === 0) {
      throw badRequest("There is nothing to capture — this budget has no lines.");
    }
    const frozen = snapshotLinesOf(lines);
    const totals = rollUpTotals(lines.map(rollupOf));
    const contentHash = snapshotContentHash(frozen, totals as unknown as Record<string, number>);
    const number = await nextRecordNumber(app.db, budgetId, "budget_snapshot");
    const id = newId("bsn");
    const reference = `BS-${pad3(number)}`;
    await app.db.insert(budgetSnapshots).values({
      id,
      companyId: budget.companyId,
      projectId: budget.projectId,
      budgetId,
      number,
      reference,
      name: body.name,
      kind: body.kind ?? "monthly_close",
      billingPeriodId: body.billingPeriodId ?? null,
      periodStart: body.periodStart ?? null,
      periodEnd: body.periodEnd ?? null,
      asOfDate,
      lines: frozen,
      totals: totals as unknown as Record<string, number>,
      contentHash,
      lineCount: frozen.length,
      notes: body.notes ?? null,
      detail: body.detail ?? {},
      capturedBy: req.user!.id,
    });
    await ledger(req, "create", "budget_snapshot", id, {
      projectId: budget.projectId,
      budgetId,
      reference,
      asOfDate,
      contentHash,
      lineCount: frozen.length,
      revisedBudgetTotal: totals.revisedBudgetTotal,
    });
    const created = await app.db
      .select()
      .from(budgetSnapshots)
      .where(eq(budgetSnapshots.id, id))
      .limit(1);
    return reply.status(201).send(created[0]);
  });

  app.get("/budgets/:budgetId/snapshots", { preHandler: companyGate }, async (req, reply) => {
    const { budgetId } = req.params as { budgetId: string };
    const q = pageQuerySchema.parse(req.query);
    const budget = await fetchBudget(budgetId, req.companyId!);
    await requireBudgetLevel(req, reply, budget.projectId, "read");
    const where = eq(budgetSnapshots.budgetId, budgetId);
    const [totalRow] = await app.db.select({ n: count() }).from(budgetSnapshots).where(where);
    const items = await app.db
      .select({
        id: budgetSnapshots.id,
        number: budgetSnapshots.number,
        reference: budgetSnapshots.reference,
        name: budgetSnapshots.name,
        kind: budgetSnapshots.kind,
        asOfDate: budgetSnapshots.asOfDate,
        periodStart: budgetSnapshots.periodStart,
        periodEnd: budgetSnapshots.periodEnd,
        billingPeriodId: budgetSnapshots.billingPeriodId,
        totals: budgetSnapshots.totals,
        contentHash: budgetSnapshots.contentHash,
        lineCount: budgetSnapshots.lineCount,
        notes: budgetSnapshots.notes,
        capturedBy: budgetSnapshots.capturedBy,
        capturedAt: budgetSnapshots.capturedAt,
      })
      .from(budgetSnapshots)
      .where(where)
      .orderBy(desc(budgetSnapshots.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  /**
   * Diff any two captures line by line. `from`/`to` accept either a snapshot
   * id or its integer number, because a month-end reviewer thinks in
   * "BS-003 vs BS-004", not in opaque ids.
   */
  app.get("/budgets/:budgetId/snapshots/diff", { preHandler: companyGate }, async (req, reply) => {
    const { budgetId } = req.params as { budgetId: string };
    const q = z
      .object({ from: z.string().min(1).max(64), to: z.string().min(1).max(64) })
      .parse(req.query);
    const budget = await fetchBudget(budgetId, req.companyId!);
    await requireBudgetLevel(req, reply, budget.projectId, "read");

    const all = await app.db
      .select()
      .from(budgetSnapshots)
      .where(eq(budgetSnapshots.budgetId, budgetId));
    const find = (token: string): SnapshotRow => {
      const asNumber = Number(token);
      const row =
        all.find((s) => s.id === token) ??
        (Number.isInteger(asNumber) ? all.find((s) => s.number === asNumber) : undefined) ??
        all.find((s) => s.reference === token);
      if (!row) throw notFound(`Snapshot "${token}" not found on this budget`);
      return row;
    };
    const from = find(q.from);
    const to = find(q.to);
    if (from.id === to.id) {
      throw badRequest("A diff needs two different captures.");
    }
    const diff = diffSnapshots(
      { lines: storedSnapshotLines(from), totals: from.totals },
      { lines: storedSnapshotLines(to), totals: to.totals },
    );
    return {
      budgetId,
      currency: budget.currency,
      from: {
        id: from.id,
        reference: from.reference,
        name: from.name,
        asOfDate: from.asOfDate,
        lineCount: from.lineCount,
        contentHash: from.contentHash,
      },
      to: {
        id: to.id,
        reference: to.reference,
        name: to.name,
        asOfDate: to.asOfDate,
        lineCount: to.lineCount,
        contentHash: to.contentHash,
      },
      ...diff,
      addedCount: diff.added.length,
      removedCount: diff.removed.length,
      changedCount: diff.changed.length,
    };
  });

  app.get("/budget-snapshots/:snapshotId", { preHandler: companyGate }, async (req, reply) => {
    const { snapshotId } = req.params as { snapshotId: string };
    const rows = await app.db
      .select()
      .from(budgetSnapshots)
      .where(
        and(eq(budgetSnapshots.id, snapshotId), eq(budgetSnapshots.companyId, req.companyId!)),
      )
      .limit(1);
    const snapshot = rows[0];
    if (!snapshot) throw notFound("Budget snapshot not found");
    await requireBudgetLevel(req, reply, snapshot.projectId, "read");
    // Recompute the hash over what is actually stored: a capture that no
    // longer hashes to its recorded value has been tampered with, and saying
    // so is the entire point of storing the hash.
    const recomputed = snapshotContentHash(snapshot.lines, snapshot.totals);
    return {
      ...snapshot,
      hashVerified: recomputed === snapshot.contentHash,
      recomputedContentHash: recomputed,
      immutable: true,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Forecasting                                                       */
  /* ---------------------------------------------------------------- */

  /** Aggregate the whole budget into one pseudo-line for budget-level work. */
  function budgetAsLine(lines: readonly LineRow[]): LineAmounts {
    const totals = rollUpTotals(lines.map(rollupOf));
    const revised = totals.revisedBudgetTotal;
    return {
      originalBudget: totals.originalBudgetTotal,
      budgetModifications: totals.budgetModificationsTotal,
      approvedChanges: totals.approvedChangesTotal,
      pendingBudgetChanges: totals.pendingChangesTotal,
      committedCost: totals.committedTotal,
      pendingCommitments: totals.pendingCommitmentsTotal,
      directCosts: totals.directCostsTotal,
      jobToDateCosts: totals.jobToDateCostsTotal,
      // cost-weighted progress; a straight average of line percentages would
      // let a £500 line outvote a £5m one
      percentComplete: revised > 0 ? round4(totals.jobToDateCostsTotal / revised) : 0,
      quantity: null,
      unitRate: null,
    };
  }

  app.post("/budgets/:budgetId/forecasts", { preHandler: companyGate }, async (req, reply) => {
    const { budgetId } = req.params as { budgetId: string };
    const body = forecastCreateSchema.parse(req.body);
    const budget = await fetchBudget(budgetId, req.companyId!);
    await requireBudgetLevel(req, reply, budget.projectId, "standard");
    if (budget.status === "closed") throw conflict("A closed budget cannot be re-forecast.");
    const asOfDate = body.asOfDate ?? today();

    let line: LineRow | null = null;
    let amounts: LineAmounts;
    if (body.lineItemId) {
      const rows = await app.db
        .select()
        .from(budgetLineItems)
        .where(
          and(
            eq(budgetLineItems.id, body.lineItemId),
            eq(budgetLineItems.budgetId, budgetId),
          ),
        )
        .limit(1);
      if (!rows[0]) throw badRequest("lineItemId is not a line of this budget.");
      line = rows[0];
      amounts = amountsOf(line);
    } else {
      const lines = await linesOfBudget(budgetId);
      if (lines.length === 0) {
        throw badRequest("This budget has no lines to forecast.");
      }
      amounts = budgetAsLine(lines);
    }

    const result = computeForecast(body.method, amounts, {
      manualForecastToComplete: body.forecastToComplete ?? null,
      percentComplete: body.percentComplete ?? null,
    });
    if (result.forecastToComplete === null || result.forecastFinal === null) {
      // Money discipline: a forecast whose inputs are missing is refused with
      // the reasons, never rounded down to a plausible-looking zero.
      throw badRequest(
        `Forecast method '${body.method}' cannot be computed from what this platform holds.`,
        { reasons: result.reasons, inputs: result.inputs },
      );
    }

    const previousRows = await app.db
      .select()
      .from(budgetForecasts)
      .where(
        and(
          eq(budgetForecasts.budgetId, budgetId),
          body.lineItemId
            ? eq(budgetForecasts.lineItemId, body.lineItemId)
            : isNotNull(budgetForecasts.id),
          eq(budgetForecasts.status, "approved"),
        ),
      )
      .orderBy(desc(budgetForecasts.asOfDate), desc(budgetForecasts.number));
    const previous = body.lineItemId
      ? previousRows[0]
      : previousRows.find((r) => r.lineItemId === null);
    const previousForecastFinal =
      previous?.forecastFinal ?? (line ? line.forecastFinal : budget.forecastFinalTotal);

    const number = await nextRecordNumber(app.db, budgetId, "budget_forecast");
    const id = newId("bfc");
    const reference = `FC-${pad3(number)}`;
    const percentComplete = round4(body.percentComplete ?? amounts.percentComplete);
    await app.db.insert(budgetForecasts).values({
      id,
      companyId: budget.companyId,
      projectId: budget.projectId,
      budgetId,
      lineItemId: body.lineItemId ?? null,
      billingPeriodId: body.billingPeriodId ?? null,
      number,
      reference,
      asOfDate,
      method: body.method,
      status: "draft",
      forecastToComplete: result.forecastToComplete,
      forecastFinal: result.forecastFinal,
      previousForecastFinal: round2(previousForecastFinal),
      deltaFromPrevious: round2(result.forecastFinal - previousForecastFinal),
      percentComplete,
      curve: body.curve ?? [],
      assumptions: body.assumptions ?? null,
      notes: body.notes ?? null,
      detail: { ...(body.detail ?? {}), computationInputs: result.inputs },
      createdBy: req.user!.id,
    });
    await ledger(req, "create", "budget_forecast", id, {
      projectId: budget.projectId,
      budgetId,
      reference,
      method: body.method,
      lineItemId: body.lineItemId ?? null,
      forecastFinal: result.forecastFinal,
    });
    const created = await app.db
      .select()
      .from(budgetForecasts)
      .where(eq(budgetForecasts.id, id))
      .limit(1);
    return reply.status(201).send(created[0]);
  });

  app.get("/budgets/:budgetId/forecasts", { preHandler: companyGate }, async (req, reply) => {
    const { budgetId } = req.params as { budgetId: string };
    const q = forecastListQuery.parse(req.query);
    const budget = await fetchBudget(budgetId, req.companyId!);
    await requireBudgetLevel(req, reply, budget.projectId, "read");
    const clauses = [eq(budgetForecasts.budgetId, budgetId)];
    if (q.status) clauses.push(eq(budgetForecasts.status, q.status));
    if (q.method) clauses.push(eq(budgetForecasts.method, q.method));
    if (q.lineItemId) clauses.push(eq(budgetForecasts.lineItemId, q.lineItemId));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(budgetForecasts).where(where);
    const items = await app.db
      .select()
      .from(budgetForecasts)
      .where(where)
      .orderBy(desc(budgetForecasts.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.post(
    "/budget-forecasts/:forecastId/submit",
    { preHandler: companyGate },
    async (req, reply) => {
      const { forecastId } = req.params as { forecastId: string };
      const { forecast, budget } = await fetchForecastWithBudget(forecastId, req.companyId!);
      await requireBudgetLevel(req, reply, budget.projectId, "standard");
      if (forecast.status !== "draft") {
        throw conflict(`Forecast ${forecast.reference} is already ${forecast.status}.`);
      }
      await app.db
        .update(budgetForecasts)
        .set({
          status: "submitted",
          submittedBy: req.user!.id,
          submittedAt: nowIso(),
          updatedAt: nowIso(),
        })
        .where(eq(budgetForecasts.id, forecastId));
      await ledger(req, "state_change", "budget_forecast", forecastId, {
        projectId: budget.projectId,
        budgetId: budget.id,
        from: "draft",
        to: "submitted",
      });
      const updated = await app.db
        .select()
        .from(budgetForecasts)
        .where(eq(budgetForecasts.id, forecastId))
        .limit(1);
      return updated[0];
    },
  );

  /**
   * Approving a forecast is what moves the line's stored figure. The approver
   * may be neither the author nor the submitter (ADR 0004) — a forecast is a
   * commercial position, and a position nobody independent has looked at is
   * an opinion, not a forecast.
   */
  app.post(
    "/budget-forecasts/:forecastId/approve",
    { preHandler: companyGate },
    async (req, reply) => {
      const { forecastId } = req.params as { forecastId: string };
      const { forecast, budget } = await fetchForecastWithBudget(forecastId, req.companyId!);
      await requireBudgetLevel(req, reply, budget.projectId, "admin");
      if (forecast.status !== "submitted") {
        throw conflict(
          `Only a submitted forecast can be approved; ${forecast.reference} is ` +
            `${forecast.status}.`,
        );
      }
      const actorId = req.user!.id;
      if (actorId === forecast.createdBy) {
        throw forbidden(
          "Segregation of duties: the approver of a forecast may not be its author.",
        );
      }
      if (forecast.submittedBy && actorId === forecast.submittedBy) {
        throw forbidden(
          "Segregation of duties: the approver of a forecast may not be the person who " +
            "submitted it.",
        );
      }
      const approvedAt = nowIso();
      await app.db.transaction(async (tx) => {
        // Supersede the standing approved forecast for the same scope; there
        // is exactly one live forecast per line at any moment.
        const siblings = await tx
          .select()
          .from(budgetForecasts)
          .where(
            and(
              eq(budgetForecasts.budgetId, budget.id),
              eq(budgetForecasts.status, "approved"),
            ),
          );
        const supersede = siblings.filter((s) => s.lineItemId === forecast.lineItemId);
        if (supersede.length > 0) {
          await tx
            .update(budgetForecasts)
            .set({ status: "superseded", updatedAt: approvedAt })
            .where(
              inArray(
                budgetForecasts.id,
                supersede.map((s) => s.id),
              ),
            );
        }
        await tx
          .update(budgetForecasts)
          .set({ status: "approved", approvedBy: actorId, approvedAt, updatedAt: approvedAt })
          .where(eq(budgetForecasts.id, forecastId));

        if (forecast.lineItemId) {
          const rows = await tx
            .select()
            .from(budgetLineItems)
            .where(eq(budgetLineItems.id, forecast.lineItemId))
            .limit(1);
          const row = rows[0];
          if (row) {
            const derived = derivedColumns(
              {
                ...amountsOf(row),
                percentComplete: forecast.percentComplete,
                forecastMethod: forecast.method,
                forecastToComplete: row.forecastToComplete,
              },
              forecast.forecastToComplete,
            );
            await tx
              .update(budgetLineItems)
              .set({
                forecastMethod: forecast.method,
                percentComplete: forecast.percentComplete,
                updatedAt: approvedAt,
                ...derived.set,
              })
              .where(eq(budgetLineItems.id, forecast.lineItemId));
          }
        }
      });
      const totals = await recomputeBudgetTotals(app.db, budget.id);
      await ledger(req, "state_change", "budget_forecast", forecastId, {
        projectId: budget.projectId,
        budgetId: budget.id,
        from: "submitted",
        to: "approved",
        approvedBy: actorId,
        createdBy: forecast.createdBy,
        method: forecast.method,
        forecastFinal: forecast.forecastFinal,
      });
      const updated = await app.db
        .select()
        .from(budgetForecasts)
        .where(eq(budgetForecasts.id, forecastId))
        .limit(1);
      return { ...updated[0], budgetTotals: totals };
    },
  );

  /**
   * What each line's forecast WOULD be under a given method, computed and
   * discarded. The default method is `committed_plus_pending` — the
   * commitment-led view a cost manager reaches for first. Lines whose inputs
   * do not support the method come back with `forecastToComplete: null` and
   * the reasons, never a fabricated figure.
   */
  app.get(
    "/budgets/:budgetId/forecast-preview",
    { preHandler: companyGate },
    async (req, reply) => {
      const { budgetId } = req.params as { budgetId: string };
      const q = forecastPreviewQuery.parse(req.query);
      const budget = await fetchBudget(budgetId, req.companyId!);
      await requireBudgetLevel(req, reply, budget.projectId, "read");
      const all = await linesOfBudget(budgetId);
      const lines = q.lineItemId ? all.filter((l) => l.id === q.lineItemId) : all;
      if (q.lineItemId && lines.length === 0) {
        throw notFound("Budget line item not found on this budget");
      }
      const rows = lines.map((l) => {
        const result = computeForecast(q.method, amountsOf(l));
        return {
          lineItemId: l.id,
          costCode: l.costCode,
          costType: l.costType,
          description: l.description,
          revisedBudget: l.revisedBudget,
          jobToDateCosts: l.jobToDateCosts,
          storedMethod: l.forecastMethod,
          storedForecastToComplete: l.forecastToComplete,
          storedForecastFinal: l.forecastFinal,
          proposedForecastToComplete: result.forecastToComplete,
          proposedForecastFinal: result.forecastFinal,
          proposedProjectedOverUnder: result.projectedOverUnder,
          delta:
            result.forecastFinal === null
              ? null
              : round2(result.forecastFinal - l.forecastFinal),
          reasons: result.reasons,
        };
      });
      const computable = rows.filter((r) => r.proposedForecastFinal !== null);
      return {
        budgetId,
        currency: budget.currency,
        method: q.method,
        lineCount: rows.length,
        computableCount: computable.length,
        /** null when NO line supports the method — a total would be a fiction */
        proposedForecastFinalTotal:
          computable.length === 0
            ? null
            : round2(computable.reduce((s, r) => s + (r.proposedForecastFinal ?? 0), 0)),
        uncomputableCount: rows.length - computable.length,
        lines: rows,
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Source reads — commitments and invoices                           */
  /* ---------------------------------------------------------------- */

  interface SourceRead {
    /** budgetLineItemId -> amount, only for rows that resolved to a line */
    byLine: Map<string, number>;
    component: Component;
    /** rows whose budgetLineItemId is null — cost the budget cannot see */
    unmapped: number;
    unmappedAmount: number;
  }

  const emptySource = (reason: string): SourceRead => ({
    byLine: new Map(),
    component: unavailable([reason]),
    unmapped: 0,
    unmappedAmount: 0,
  });

  /**
   * Commitment cost against this budget's lines. Reads `commitment_sov_lines`
   * joined to `commitments` for status and currency — the budget never
   * invents a commitment total of its own.
   */
  async function readCommitments(
    budget: BudgetRow,
    which: "committed" | "pending",
  ): Promise<SourceRead> {
    const rows = await app.db
      .select({
        budgetLineItemId: commitmentSovLines.budgetLineItemId,
        revisedScheduledValue: commitmentSovLines.revisedScheduledValue,
        scheduledValue: commitmentSovLines.scheduledValue,
        status: commitments.status,
        currency: commitments.currency,
      })
      .from(commitmentSovLines)
      .innerJoin(commitments, eq(commitments.id, commitmentSovLines.commitmentId))
      .where(
        and(
          eq(commitmentSovLines.companyId, budget.companyId),
          eq(commitmentSovLines.projectId, budget.projectId),
        ),
      );
    if (rows.length === 0) {
      return emptySource(
        "No commitment schedule-of-values lines exist on this project yet, so committed cost " +
          "is unknown rather than zero.",
      );
    }
    const wanted: readonly string[] =
      which === "committed" ? COMMITTED_STATUSES : PENDING_COMMITMENT_STATUSES;
    const relevant = rows.filter((r) => wanted.includes(r.status));
    if (relevant.length === 0) {
      return emptySource(
        which === "committed"
          ? "No approved or complete commitments on this project — committed cost is unknown " +
              "rather than zero."
          : "No draft or out-for-signature commitments on this project.",
      );
    }
    const summed = sumInCurrency(
      relevant.map((r) => ({
        amount: r.revisedScheduledValue || r.scheduledValue,
        currency: r.currency,
      })),
      budget.currency,
      which === "committed" ? "committed cost" : "pending commitment",
    );
    const byLine = new Map<string, number>();
    let unmapped = 0;
    let unmappedAmount = 0;
    for (const row of relevant) {
      if ((row.currency ?? budget.currency) !== budget.currency) continue;
      const amount = row.revisedScheduledValue || row.scheduledValue;
      if (!row.budgetLineItemId) {
        unmapped += 1;
        unmappedAmount += amount;
        continue;
      }
      byLine.set(row.budgetLineItemId, round2((byLine.get(row.budgetLineItemId) ?? 0) + amount));
    }
    const reasons = [...summed.reasons];
    if (unmapped > 0) {
      reasons.push(
        `${unmapped} commitment SOV line(s) worth ${round2(unmappedAmount).toFixed(2)} carry no ` +
          "budgetLineItemId and are therefore outside every budget line — the project total " +
          "and the budget total will differ by that amount until they are coded.",
      );
    }
    return {
      byLine,
      component:
        summed.value === null
          ? unavailable(reasons, { rowsConsidered: relevant.length })
          : { ...computed(summed.value, {
              rowsConsidered: relevant.length,
              rowsCounted: summed.counted,
              rowsExcluded: summed.excluded,
              excludedCurrencies: summed.excludedCurrencies,
              unmappedLines: unmapped,
              unmappedAmount: round2(unmappedAmount),
            }), reasons },
      unmapped,
      unmappedAmount: round2(unmappedAmount),
    };
  }

  /** Cost actually incurred: approved/paid subcontractor invoice lines. */
  async function readInvoicedToDate(budget: BudgetRow): Promise<SourceRead> {
    const rows = await app.db
      .select({
        budgetLineItemId: invoiceLineItems.budgetLineItemId,
        totalCompletedAndStored: invoiceLineItems.totalCompletedAndStored,
        status: invoices.status,
        kind: invoices.kind,
        currency: invoices.currency,
      })
      .from(invoiceLineItems)
      .innerJoin(invoices, eq(invoices.id, invoiceLineItems.invoiceId))
      .where(
        and(
          eq(invoiceLineItems.companyId, budget.companyId),
          eq(invoiceLineItems.projectId, budget.projectId),
        ),
      );
    if (rows.length === 0) {
      return emptySource(
        "No invoice lines exist on this project yet, so cost invoiced to date is unknown " +
          "rather than zero.",
      );
    }
    const relevant = rows.filter(
      (r) =>
        r.kind === "subcontractor_invoice" &&
        (INCURRED_INVOICE_STATUSES as readonly string[]).includes(r.status),
    );
    if (relevant.length === 0) {
      return emptySource(
        "No approved or paid subcontractor invoices on this project — cost invoiced to date " +
          "is unknown rather than zero.",
      );
    }
    const summed = sumInCurrency(
      relevant.map((r) => ({ amount: r.totalCompletedAndStored, currency: r.currency })),
      budget.currency,
      "subcontractor invoice",
    );
    const byLine = new Map<string, number>();
    let unmapped = 0;
    let unmappedAmount = 0;
    for (const row of relevant) {
      if ((row.currency ?? budget.currency) !== budget.currency) continue;
      if (!row.budgetLineItemId) {
        unmapped += 1;
        unmappedAmount += row.totalCompletedAndStored;
        continue;
      }
      byLine.set(
        row.budgetLineItemId,
        round2((byLine.get(row.budgetLineItemId) ?? 0) + row.totalCompletedAndStored),
      );
    }
    const reasons = [...summed.reasons];
    if (unmapped > 0) {
      reasons.push(
        `${unmapped} invoice line(s) worth ${round2(unmappedAmount).toFixed(2)} are not coded ` +
          "to a budget line.",
      );
    }
    return {
      byLine,
      component:
        summed.value === null
          ? unavailable(reasons, { rowsConsidered: relevant.length })
          : { ...computed(summed.value, {
              rowsConsidered: relevant.length,
              rowsCounted: summed.counted,
              rowsExcluded: summed.excluded,
              excludedCurrencies: summed.excludedCurrencies,
              unmappedLines: unmapped,
              unmappedAmount: round2(unmappedAmount),
            }), reasons },
      unmapped,
      unmappedAmount: round2(unmappedAmount),
    };
  }

  /**
   * Pull committed cost, pending commitments and invoiced cost down onto the
   * budget lines from the source tables. A component whose source table holds
   * nothing is SKIPPED, not zeroed: overwriting a stored figure with a
   * fabricated 0 because a sibling module has not shipped yet would be the
   * worst kind of quiet wrong answer.
   */
  app.post("/budgets/:budgetId/recalculate", { preHandler: companyGate }, async (req, reply) => {
    const { budgetId } = req.params as { budgetId: string };
    const budget = await fetchBudget(budgetId, req.companyId!);
    await requireBudgetLevel(req, reply, budget.projectId, "standard");
    const lines = await linesOfBudget(budgetId);
    if (lines.length === 0) throw badRequest("This budget has no lines to recalculate.");

    const committed = await readCommitments(budget, "committed");
    const pending = await readCommitments(budget, "pending");
    const invoiced = await readInvoicedToDate(budget);

    const applyCommitted = committed.component.value !== null;
    const applyPendingCommitments = pending.component.value !== null;
    const applyInvoiced = invoiced.component.value !== null;

    let updatedLines = 0;
    await app.db.transaction(async (tx) => {
      for (const line of lines) {
        const committedCost = applyCommitted
          ? (committed.byLine.get(line.id) ?? 0)
          : line.committedCost;
        const pendingCommitments = applyPendingCommitments
          ? (pending.byLine.get(line.id) ?? 0)
          : line.pendingCommitments;
        const jobToDateCosts = applyInvoiced
          ? round2((invoiced.byLine.get(line.id) ?? 0) + line.directCosts)
          : line.jobToDateCosts;
        const next: LineAmounts & { forecastMethod: string; forecastToComplete: number } = {
          ...amountsOf(line),
          committedCost,
          pendingCommitments,
          jobToDateCosts,
          forecastMethod: line.forecastMethod,
          forecastToComplete: line.forecastToComplete,
        };
        const derived = derivedColumns(next);
        const changed =
          committedCost !== line.committedCost ||
          pendingCommitments !== line.pendingCommitments ||
          jobToDateCosts !== line.jobToDateCosts ||
          derived.set["forecastToComplete"] !== line.forecastToComplete ||
          derived.set["revisedBudget"] !== line.revisedBudget;
        if (!changed) continue;
        updatedLines += 1;
        await tx
          .update(budgetLineItems)
          .set({
            committedCost,
            pendingCommitments,
            jobToDateCosts,
            updatedAt: nowIso(),
            ...derived.set,
          })
          .where(eq(budgetLineItems.id, line.id));
      }
    });
    const totals = await recomputeBudgetTotals(app.db, budgetId);
    await ledger(req, "update", "budget", budgetId, {
      projectId: budget.projectId,
      recalculated: true,
      updatedLines,
      revisedBudgetTotal: totals.revisedBudgetTotal,
    });
    return {
      budgetId,
      currency: budget.currency,
      updatedLines,
      totals,
      reconciliation: reconcile(totals),
      applied: {
        committedCost: applyCommitted,
        pendingCommitments: applyPendingCommitments,
        jobToDateCosts: applyInvoiced,
      },
      /** why a component was left alone — never silently zeroed */
      skipped: [
        ...(applyCommitted ? [] : [{ component: "committedCost", reasons: committed.component.reasons }]),
        ...(applyPendingCommitments
          ? []
          : [{ component: "pendingCommitments", reasons: pending.component.reasons }]),
        ...(applyInvoiced ? [] : [{ component: "jobToDateCosts", reasons: invoiced.component.reasons }]),
      ],
    };
  });

  /* ---------------------------------------------------------------- */
  /* Rollups + budget vs actual                                        */
  /* ---------------------------------------------------------------- */

  app.get("/budgets/:budgetId/rollup", { preHandler: companyGate }, async (req, reply) => {
    const { budgetId } = req.params as { budgetId: string };
    const q = rollupQuery.parse(req.query);
    const budget = await fetchBudget(budgetId, req.companyId!);
    await requireBudgetLevel(req, reply, budget.projectId, "read");
    const lines = await linesOfBudget(budgetId);
    const rows = lines.map((l) => ({ ...rollupOf(l), row: l }));

    let groups: unknown[];
    if (q.by === "wbs") {
      groups = rollUpByWbs(rows);
    } else if (q.by === "cost_type") {
      groups = groupBy(rows, (l) => ({ key: l.row.costType, label: l.row.costType })).map(
        ({ lines: _lines, ...rest }) => rest,
      );
    } else if (q.by === "line_kind") {
      groups = groupBy(rows, (l) => ({ key: l.row.lineKind, label: l.row.lineKind })).map(
        ({ lines: _lines, ...rest }) => rest,
      );
    } else if (q.by === "sub_job") {
      groups = groupBy(rows, (l) => ({
        key: l.row.subJob ?? "",
        label: l.row.subJob ?? "(no sub job)",
      })).map(({ lines: _lines, ...rest }) => rest);
    } else {
      groups = groupBy(rows, (l) => {
        const code = l.row.costCode;
        const key = q.depth
          ? (l.row.wbsPath ?? code).split("/").slice(0, q.depth).join("/")
          : code;
        return { key, label: key };
      }).map(({ lines: groupLines, ...rest }) => ({
        ...rest,
        descriptions: [...new Set((groupLines ?? []).map((g) => g.row.description))].slice(0, 5),
      }));
    }
    const totals = rollUpTotals(rows);
    return {
      budgetId,
      currency: budget.currency,
      by: q.by,
      groupCount: groups.length,
      groups,
      totals,
      reconciliation: reconcile(totals),
    };
  });

  /**
   * Budget vs actual — the one screen a project director looks at.
   *
   * The stored columns give the plan side, which the budget owns outright.
   * The cost side is re-read LIVE from `commitments` and `invoices` so the
   * summary states what those tools actually hold, and each component carries
   * its own `reasons` when the platform cannot answer: an empty commitments
   * table produces `committed: null, reasons: [...]`, never `committed: 0`,
   * because a project director reading "£0 committed" on a job with forty
   * live subcontracts will make a decision on it.
   */
  app.get("/budgets/:budgetId/summary", { preHandler: companyGate }, async (req, reply) => {
    const { budgetId } = req.params as { budgetId: string };
    const budget = await fetchBudget(budgetId, req.companyId!);
    await requireBudgetLevel(req, reply, budget.projectId, "read");
    const lines = await linesOfBudget(budgetId);
    const totals = rollUpTotals(lines.map(rollupOf));

    const [committed, pending, invoiced] = await Promise.all([
      readCommitments(budget, "committed"),
      readCommitments(budget, "pending"),
      readInvoicedToDate(budget),
    ]);

    const directCosts = computed(totals.directCostsTotal, {
      source: "budget_line_items.direct_costs",
      lineCount: lines.length,
    });
    const jobToDate: Component =
      invoiced.component.value === null
        ? unavailable(
            [
              ...invoiced.component.reasons,
              "Job-to-date cost is invoiced commitment cost plus direct cost; with the " +
                "invoiced half unknown the total cannot be stated.",
            ],
            { directCosts: totals.directCostsTotal },
          )
        : computed(invoiced.component.value + totals.directCostsTotal, {
            invoicedToDate: invoiced.component.value,
            directCosts: totals.directCostsTotal,
          });

    const overruns = lines
      .filter((l) => l.projectedOverUnder < 0)
      .sort((a, b) => a.projectedOverUnder - b.projectedOverUnder)
      .slice(0, 10)
      .map((l) => ({
        lineItemId: l.id,
        costCode: l.costCode,
        costType: l.costType,
        description: l.description,
        revisedBudget: l.revisedBudget,
        forecastFinal: l.forecastFinal,
        projectedOverUnder: l.projectedOverUnder,
      }));

    const contingency = lines.filter((l) => l.lineKind === "contingency");
    const contingencyRemaining =
      contingency.length === 0
        ? unavailable(["This budget carries no contingency line."])
        : computed(
            contingency.reduce((s, l) => s + l.revisedBudget, 0),
            {
              lines: contingency.length,
              original: round2(contingency.reduce((s, l) => s + l.originalBudget, 0)),
              drawn: round2(contingency.reduce((s, l) => s + l.budgetModifications, 0)),
            },
          );

    return {
      budgetId,
      projectId: budget.projectId,
      reference: budget.reference,
      name: budget.name,
      status: budget.status,
      currency: budget.currency,
      asOf: nowIso(),
      lineCount: lines.length,
      /** the plan side: owned by this module, always available */
      plan: {
        originalBudget: totals.originalBudgetTotal,
        budgetModifications: totals.budgetModificationsTotal,
        approvedChanges: totals.approvedChangesTotal,
        pendingChanges: totals.pendingChangesTotal,
        revisedBudget: totals.revisedBudgetTotal,
        forecastToComplete: totals.forecastToCompleteTotal,
        forecastFinal: totals.forecastFinalTotal,
        variance: totals.varianceTotal,
      },
      /** the cost side: read live from the source tools, null when unknown */
      components: {
        committed: committed.component,
        pendingCommitments: pending.component,
        invoicedToDate: invoiced.component,
        directCosts,
        jobToDateCosts: jobToDate,
        contingencyRemaining,
      },
      /**
       * Stored rollups vs. what the source tools say right now. A drift means
       * the budget needs recalculating, and saying so is more useful than
       * showing whichever figure happened to be read last.
       */
      drift: {
        committed:
          committed.component.value === null
            ? null
            : round2(committed.component.value - totals.committedTotal),
        jobToDateCosts:
          jobToDate.value === null ? null : round2(jobToDate.value - totals.jobToDateCostsTotal),
        totalsCalculatedAt: budget.totalsCalculatedAt,
      },
      reconciliation: reconcile(totals),
      overrunLines: overruns,
    };
  });
};
