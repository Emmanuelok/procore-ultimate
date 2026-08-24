import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, count, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  assuranceGrants,
  dashboards,
  obligations,
  projectMemberships,
  projects,
  reportDefinitions,
  reportSchedules,
  signals,
} from "@constructos/db";
import {
  REPORT_AGGREGATIONS,
  REPORT_DATASETS,
  REPORT_FILTER_OPERATORS,
  WIDGET_KINDS,
  type WidgetKind,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import type { Db } from "../../lib/db.js";
import {
  datasetCatalog,
  executeReport,
  MAX_LIMIT_ROWS,
  resolveReport,
  resultToCsv,
  type AggregationInput,
  type ExecutionResult,
  type FilterInput,
  type ReportSpec,
} from "./datasets.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

/** A dashboard carries — and executes — at most this many widgets… */
export const MAX_DASHBOARD_WIDGETS = 12;
/** …and each widget's backing report is capped at this many rows. */
export const WIDGET_ROW_CAP = 500;

/**
 * `dataset`, `columns`, filter `field`s, `groupBy`, aggregation `field`s and
 * `sortBy` are typed as plain strings HERE ON PURPOSE: zod only bounds their
 * shape, and `resolveReport` in datasets.ts is the single authority that turns
 * a name into a column. An unknown name never reaches SQL — it 400s there,
 * with the list of names that would have been valid.
 */
const filterSchema = z.object({
  field: z.string().min(1).max(100),
  operator: z.enum(REPORT_FILTER_OPERATORS),
  value: z.unknown().optional(),
});

const aggregationSchema = z.object({
  field: z.string().min(1).max(100),
  fn: z.enum(REPORT_AGGREGATIONS),
  alias: z.string().min(1).max(41),
});

const specSchema = z.object({
  projectId: z.string().min(1).max(60).nullable().optional(),
  dataset: z.string().min(1).max(60),
  columns: z.array(z.string().min(1).max(100)).min(1).max(60),
  filters: z.array(filterSchema).max(50).optional(),
  groupBy: z.string().min(1).max(100).nullable().optional(),
  aggregations: z.array(aggregationSchema).max(10).optional(),
  sortBy: z.string().min(1).max(100).nullable().optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
  limitRows: z.number().int().min(1).max(MAX_LIMIT_ROWS).optional(),
});

const reportCreateSchema = specSchema.extend({
  name: z.string().min(1).max(200),
  description: z.string().max(5000).nullable().optional(),
  isShared: z.boolean().optional(),
});

const reportPatchSchema = reportCreateSchema.partial();

const reportListQuery = pageQuerySchema.extend({
  dataset: z.string().min(1).max(60).optional(),
  projectId: z.string().min(1).max(60).optional(),
});

const runQuery = pageQuerySchema.extend({
  projectId: z.string().min(1).max(60).optional(),
});

/** Prebuilt-dashboard audiences (schema comment on dashboards.audience). */
const DASHBOARD_AUDIENCES = ["pm", "commercial", "owner", "assurance"] as const;

const widgetSchema = z.object({
  id: z.string().min(1).max(60).optional(),
  kind: z.enum(WIDGET_KINDS),
  title: z.string().min(1).max(200),
  reportId: z.string().min(1).max(60).nullable().optional(),
  metric: z.string().min(1).max(60).nullable().optional(),
  span: z.number().int().min(1).max(4).optional(),
});

const dashboardCreateSchema = z.object({
  name: z.string().min(1).max(200),
  projectId: z.string().min(1).max(60).nullable().optional(),
  audience: z.enum(DASHBOARD_AUDIENCES).nullable().optional(),
  widgets: z.array(widgetSchema).max(MAX_DASHBOARD_WIDGETS).optional(),
  isDefault: z.boolean().optional(),
});

const dashboardPatchSchema = dashboardCreateSchema.partial();

const scheduleCreateSchema = z.object({
  cadence: z.enum(["daily", "weekly", "monthly"]),
  dayOfPeriod: z.number().int().min(0).max(28).nullable().optional(),
  recipients: z.array(z.string().email().max(320)).min(1).max(50),
});

const seedSchema = z.object({ projectId: z.string().min(1).max(60) });

/* ------------------------------------------------------------------ */
/* Widgets & metrics                                                   */
/* ------------------------------------------------------------------ */

export interface DashboardWidget {
  id: string;
  kind: WidgetKind;
  title: string;
  reportId: string | null;
  metric: string | null;
  span: number;
}

/**
 * Built-in scalar metrics for `stat` widgets that have no natural dataset in
 * REPORT_DATASETS (obligations are an assurance-module concept, not a
 * reportable dataset). Each is a fixed query defined here in code — the widget
 * supplies only the metric KEY, which is looked up in this map.
 */
interface MetricScope {
  companyId: string;
  projectId: string | null;
  /** as ExecutionScope.projectIds: null = every project, array = exactly these */
  projectIds?: readonly string[] | null;
}

/** Scope predicate for a metric's project column, matching `executeReport`. */
function metricProjectClause(column: AnyPgColumn, scope: MetricScope): SQL | undefined {
  if (scope.projectId) return eq(column, scope.projectId as never);
  if (!scope.projectIds) return undefined;
  return scope.projectIds.length === 0
    ? sql`false`
    : inArray(column, scope.projectIds as never[]);
}

const METRICS: Record<
  string,
  { label: string; run: (db: Db, scope: MetricScope) => Promise<number> }
> = {
  open_obligations: {
    label: "Open obligations",
    run: async (db, scope) => {
      const clauses: (SQL | undefined)[] = [
        eq(obligations.companyId, scope.companyId),
        eq(obligations.status, "open"),
        metricProjectClause(obligations.projectId, scope),
      ];
      const [row] = await db
        .select({ n: count() })
        .from(obligations)
        .where(and(...clauses.filter((c): c is SQL => c !== undefined)));
      return row?.n ?? 0;
    },
  },
  open_signals: {
    label: "Signals awaiting review",
    run: async (db, scope) => {
      const clauses: (SQL | undefined)[] = [
        eq(signals.companyId, scope.companyId),
        inArray(signals.disposition, ["new", "under_review"]),
        metricProjectClause(signals.projectId, scope),
      ];
      const [row] = await db
        .select({ n: count() })
        .from(signals)
        .where(and(...clauses.filter((c): c is SQL => c !== undefined)));
      return row?.n ?? 0;
    },
  },
};

/* ------------------------------------------------------------------ */
/* Schedules (#736)                                                    */
/* ------------------------------------------------------------------ */

export type ScheduleCadence = "daily" | "weekly" | "monthly";

/** Scheduled deliveries are computed for 06:00 UTC. */
export const SCHEDULE_HOUR_UTC = 6;

/**
 * Next delivery instant for a cadence, strictly after `from` — a pure
 * function so the arithmetic is testable without a database.
 *
 * - daily: the next 06:00 UTC.
 * - weekly: the next `dayOfPeriod` (0 = Sunday … 6 = Saturday) at 06:00 UTC;
 *   defaults to Monday.
 * - monthly: the next `dayOfPeriod` (1-28, so every month has one) at 06:00
 *   UTC; defaults to the 1st.
 */
export function computeNextRunAt(
  cadence: ScheduleCadence,
  dayOfPeriod: number | null | undefined,
  from: Date = new Date(),
): string {
  const at = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d, SCHEDULE_HOUR_UTC));
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  const d = from.getUTCDate();

  if (cadence === "daily") {
    const today = at(y, m, d);
    return (today > from ? today : at(y, m, d + 1)).toISOString();
  }
  if (cadence === "weekly") {
    const dow = ((dayOfPeriod ?? 1) % 7 + 7) % 7;
    let candidate = at(y, m, d);
    for (let i = 0; i < 8; i += 1) {
      if (candidate > from && candidate.getUTCDay() === dow) return candidate.toISOString();
      candidate = at(y, m, d + i + 1);
    }
    /* c8 ignore next */
    return candidate.toISOString();
  }
  const day = Math.min(Math.max(dayOfPeriod ?? 1, 1), 28);
  const thisMonth = at(y, m, day);
  return (thisMonth > from ? thisMonth : at(y, m + 1, day)).toISOString();
}

/**
 * Scheduled report delivery is RECORDED, NOT SENT.
 *
 * This deployment runs a single API process with no worker, queue or cron, and
 * no outbound mail transport is configured. A schedule row therefore stores the
 * cadence, the recipients and a maintained `nextRunAt`, and nothing else
 * happens when that instant passes: no email is sent. Wiring delivery means
 * adding a scheduler that polls `report_schedules` for due rows, executes the
 * report and hands the CSV to a mail transport. Every schedule response repeats
 * this in its `delivery` block so no user believes a report is arriving.
 */
const DELIVERY_NOTICE = {
  enabled: false,
  note:
    "Recorded only. This deployment has no scheduler or mail transport, so no email is sent " +
    "when nextRunAt passes; the schedule and its next run instant are maintained for when a " +
    "delivery worker is added.",
} as const;

/* ------------------------------------------------------------------ */
/* Module                                                              */
/* ------------------------------------------------------------------ */

/**
 * Cross-tool reporting & dashboards — spec Vol I §6.1-6.2 (#731-739, #741-742,
 * #749, #751): a report builder over a whitelisted dataset registry (#731-733),
 * saved definitions with sharing and permissions (#734, #737), live preview and
 * paged execution (#738), CSV export (#738), project- and company-scoped runs
 * (#739), role dashboards seeded from real definitions (#741-742), widget data
 * that drills back to records (#749), and row-level security enforced by the
 * executor rather than by the definition (#751).
 *
 * All routes are company-scoped: analytics crosses projects by design, so the
 * `:projectId` tool gate does not apply. Project reach is checked per report
 * against the caller's project membership instead (see `assertProjectReadable`).
 */
export const analyticsModule: FastifyPluginAsync = async (app) => {
  const gate = [app.authenticate, app.requireCompany];

  const isCompanyAdmin = (req: FastifyRequest) =>
    req.companyRole === "owner" || req.companyRole === "admin";

  /**
   * Which projects this caller may read, mirroring `requireTool`'s model so
   * analytics is never a wider door than the module it reports on:
   *
   *  - company owner / admin        → every project (returns `null`)
   *  - company-wide assurance grant → every project (auditors and regulators
   *    hold read across the tenant, and a report is a read)
   *  - anyone else                  → their project memberships, plus any
   *    project-specific assurance grant
   *
   * `null` means unrestricted; an array — possibly empty — is exhaustive.
   */
  async function reachableProjectIds(req: FastifyRequest): Promise<string[] | null> {
    if (isCompanyAdmin(req)) return null;
    const now = new Date().toISOString();
    const grants = await app.db
      .select({ projectId: assuranceGrants.projectId, expiresAt: assuranceGrants.expiresAt })
      .from(assuranceGrants)
      .where(
        and(
          eq(assuranceGrants.companyId, req.companyId!),
          eq(assuranceGrants.userId, req.user!.id),
        ),
      );
    const live = grants.filter((g) => !g.expiresAt || g.expiresAt > now);
    if (live.some((g) => g.projectId === null)) return null;
    const memberships = await app.db
      .select({ projectId: projectMemberships.projectId })
      .from(projectMemberships)
      .where(
        and(
          eq(projectMemberships.companyId, req.companyId!),
          eq(projectMemberships.userId, req.user!.id),
        ),
      );
    return [
      ...new Set([
        ...memberships.map((m) => m.projectId),
        ...live.map((g) => g.projectId!).filter(Boolean),
      ]),
    ];
  }

  /**
   * Row-level security for project-scoped runs (#751): the project must belong
   * to the caller's company, and — unless they reach every project — the caller
   * must be a member of it (or hold an assurance grant over it). A report
   * cannot be used to read a project the user cannot otherwise open.
   */
  async function assertProjectReadable(req: FastifyRequest, projectId: string): Promise<void> {
    const rows = await app.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, req.companyId!)))
      .limit(1);
    if (!rows[0]) throw badRequest("projectId is not a project in this company");
    const reach = await reachableProjectIds(req);
    if (reach === null || reach.includes(projectId)) return;
    throw forbidden("No access to this project");
  }

  async function fetchReport(reportId: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(reportDefinitions)
      .where(
        and(eq(reportDefinitions.id, reportId), eq(reportDefinitions.companyId, companyId)),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Report not found");
    return rows[0];
  }

  type ReportRow = Awaited<ReturnType<typeof fetchReport>>;

  const canManageReport = (row: ReportRow, req: FastifyRequest) =>
    row.createdBy === req.user!.id || isCompanyAdmin(req);

  const canReadReport = (row: ReportRow, req: FastifyRequest) =>
    canManageReport(row, req) || row.isShared === 1;

  function requireReadable(row: ReportRow, req: FastifyRequest): ReportRow {
    // 404, not 403: a private report's existence is not the caller's business.
    if (!canReadReport(row, req)) throw notFound("Report not found");
    return row;
  }

  /** Stored definition → the shape `resolveReport` validates. */
  function specFromRow(row: ReportRow): ReportSpec {
    return {
      dataset: row.dataset,
      columns: row.columns,
      filters: (row.filters ?? []) as FilterInput[],
      groupBy: row.groupBy,
      aggregations: (row.aggregations ?? []) as AggregationInput[],
      sortBy: row.sortBy,
      sortDir: row.sortDir,
      limitRows: row.limitRows,
    };
  }

  function viewReport(row: ReportRow) {
    return { ...row, isShared: row.isShared === 1 };
  }

  /** Resolve the project a run executes against and check reach. */
  async function resolveRunScope(
    req: FastifyRequest,
    reportProjectId: string | null,
    requestedProjectId?: string | null,
  ): Promise<string | null> {
    // A definition's own project wins; a run may only supply one when the
    // definition is company-wide, and never widen an existing scope.
    const projectId = reportProjectId ?? requestedProjectId ?? null;
    if (projectId) await assertProjectReadable(req, projectId);
    return projectId;
  }

  async function runSpec(
    req: FastifyRequest,
    spec: ReportSpec,
    projectId: string | null,
    window: { pageSize: number; offset: number },
  ): Promise<ExecutionResult> {
    const plan = resolveReport(spec);
    // A run that names no project still cannot cross into projects the caller
    // does not reach — omitting `projectId` must not widen the query (#751).
    const projectIds = projectId ? null : await reachableProjectIds(req);
    return executeReport(
      app.db,
      plan,
      { companyId: req.companyId!, projectId, projectIds },
      window,
    );
  }

  /* ---------------------------------------------------------------- */
  /* Catalog (#731-732)                                                */
  /* ---------------------------------------------------------------- */

  app.get("/analytics/datasets", { preHandler: gate }, async () => ({
    datasets: datasetCatalog(),
    operators: REPORT_FILTER_OPERATORS,
    aggregations: REPORT_AGGREGATIONS,
    widgetKinds: WIDGET_KINDS,
    limits: { maxLimitRows: MAX_LIMIT_ROWS, maxDashboardWidgets: MAX_DASHBOARD_WIDGETS },
  }));

  /* ---------------------------------------------------------------- */
  /* Report definitions (#731-734, #737, #739)                         */
  /* ---------------------------------------------------------------- */

  app.post("/analytics/reports", { preHandler: gate }, async (req, reply) => {
    const body = reportCreateSchema.parse(req.body);
    if (body.projectId) await assertProjectReadable(req, body.projectId);
    // Validate the whole definition before it is stored — an unstorable
    // definition is better than a stored one that 400s on every run.
    resolveReport({ ...body, limitRows: body.limitRows ?? 500 });

    const id = newId("rpt");
    await app.db.insert(reportDefinitions).values({
      id,
      companyId: req.companyId!,
      projectId: body.projectId ?? null,
      name: body.name,
      description: body.description ?? null,
      dataset: body.dataset,
      columns: body.columns,
      filters: body.filters ?? [],
      groupBy: body.groupBy ?? null,
      aggregations: body.aggregations ?? [],
      sortBy: body.sortBy ?? null,
      sortDir: body.sortDir ?? "desc",
      limitRows: body.limitRows ?? 500,
      isShared: body.isShared ? 1 : 0,
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "report_definition",
      objectId: id,
      payload: {
        name: body.name,
        dataset: body.dataset,
        columns: body.columns,
        filters: body.filters ?? [],
        groupBy: body.groupBy ?? null,
        aggregations: body.aggregations ?? [],
        projectId: body.projectId ?? null,
      },
      storePayload: true,
    });
    return reply.status(201).send(viewReport(await fetchReport(id, req.companyId!)));
  });

  app.get("/analytics/reports", { preHandler: gate }, async (req) => {
    const q = reportListQuery.parse(req.query);
    const clauses = [
      eq(reportDefinitions.companyId, req.companyId!),
      // mine + shared (company admins additionally see everything)
      isCompanyAdmin(req)
        ? undefined
        : or(eq(reportDefinitions.createdBy, req.user!.id), eq(reportDefinitions.isShared, 1))!,
      q.dataset ? eq(reportDefinitions.dataset, q.dataset) : undefined,
      q.projectId ? eq(reportDefinitions.projectId, q.projectId) : undefined,
    ].filter((c) => c !== undefined);
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(reportDefinitions).where(where);
    const rows = await app.db
      .select()
      .from(reportDefinitions)
      .where(where)
      .orderBy(desc(reportDefinitions.updatedAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows.map(viewReport), totalRow?.n ?? 0, q);
  });

  app.get("/analytics/reports/:reportId", { preHandler: gate }, async (req) => {
    const { reportId } = req.params as { reportId: string };
    const row = requireReadable(await fetchReport(reportId, req.companyId!), req);
    return viewReport(row);
  });

  app.patch("/analytics/reports/:reportId", { preHandler: gate }, async (req) => {
    const { reportId } = req.params as { reportId: string };
    const body = reportPatchSchema.parse(req.body);
    // invisible reports 404 before we say anything about who may edit them
    const row = requireReadable(await fetchReport(reportId, req.companyId!), req);
    if (!canManageReport(row, req)) {
      throw forbidden("Only the report's creator or a company admin may edit it");
    }
    if (body.projectId) await assertProjectReadable(req, body.projectId);

    const merged: ReportSpec = {
      dataset: body.dataset ?? row.dataset,
      columns: body.columns ?? row.columns,
      filters: (body.filters ?? row.filters) as FilterInput[],
      groupBy: body.groupBy === undefined ? row.groupBy : body.groupBy,
      aggregations: (body.aggregations ?? row.aggregations) as AggregationInput[],
      sortBy: body.sortBy === undefined ? row.sortBy : body.sortBy,
      sortDir: body.sortDir ?? row.sortDir,
      limitRows: body.limitRows ?? row.limitRows,
    };
    resolveReport(merged);

    await app.db
      .update(reportDefinitions)
      .set({
        name: body.name ?? row.name,
        description: body.description === undefined ? row.description : body.description,
        projectId: body.projectId === undefined ? row.projectId : body.projectId,
        dataset: merged.dataset,
        columns: merged.columns,
        filters: merged.filters,
        groupBy: merged.groupBy ?? null,
        aggregations: merged.aggregations,
        sortBy: merged.sortBy ?? null,
        sortDir: merged.sortDir ?? "desc",
        limitRows: merged.limitRows,
        isShared: body.isShared === undefined ? row.isShared : body.isShared ? 1 : 0,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(reportDefinitions.id, reportId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "report_definition",
      objectId: reportId,
      payload: { changed: Object.keys(body) },
    });
    return viewReport(await fetchReport(reportId, req.companyId!));
  });

  app.delete("/analytics/reports/:reportId", { preHandler: gate }, async (req, reply) => {
    const { reportId } = req.params as { reportId: string };
    const row = requireReadable(await fetchReport(reportId, req.companyId!), req);
    if (!canManageReport(row, req)) {
      throw forbidden("Only the report's creator or a company admin may delete it");
    }
    await app.db.delete(reportSchedules).where(eq(reportSchedules.reportId, reportId));
    await app.db.delete(reportDefinitions).where(eq(reportDefinitions.id, reportId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "report_definition",
      objectId: reportId,
      payload: { name: row.name, dataset: row.dataset },
    });
    return reply.status(204).send();
  });

  /* ---------------------------------------------------------------- */
  /* Execution (#738-739)                                              */
  /* ---------------------------------------------------------------- */

  app.post("/analytics/reports/preview", { preHandler: gate }, async (req) => {
    const body = specSchema.parse(req.body);
    const q = pageQuerySchema.parse(req.query);
    const projectId = body.projectId ?? null;
    if (projectId) await assertProjectReadable(req, projectId);
    const result = await runSpec(
      req,
      { ...body, limitRows: body.limitRows ?? 500 },
      projectId,
      { pageSize: q.pageSize, offset: pageOffset(q) },
    );
    return { ...result, page: q.page, pageSize: q.pageSize, saved: false };
  });

  app.post("/analytics/reports/:reportId/run", { preHandler: gate }, async (req) => {
    const { reportId } = req.params as { reportId: string };
    const q = runQuery.parse(req.query);
    const row = requireReadable(await fetchReport(reportId, req.companyId!), req);
    const projectId = await resolveRunScope(req, row.projectId, q.projectId);
    const result = await runSpec(req, specFromRow(row), projectId, {
      pageSize: q.pageSize,
      offset: pageOffset(q),
    });
    return {
      ...result,
      page: q.page,
      pageSize: q.pageSize,
      report: { id: row.id, name: row.name, dataset: row.dataset, projectId },
    };
  });

  app.get("/analytics/reports/:reportId/export.csv", { preHandler: gate }, async (req, reply) => {
    const { reportId } = req.params as { reportId: string };
    const q = runQuery.parse(req.query);
    const row = requireReadable(await fetchReport(reportId, req.companyId!), req);
    const projectId = await resolveRunScope(req, row.projectId, q.projectId);
    const result = await runSpec(req, specFromRow(row), projectId, {
      pageSize: row.limitRows,
      offset: 0,
    });
    // Data leaving the platform is a ledgered access event (#737).
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "access",
      objectType: "report_definition",
      objectId: reportId,
      payload: { export: "csv", rowCount: result.rowCount, projectId },
    });
    const safeName = row.name.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 60) || "report";
    return reply
      .type("text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${safeName}.csv"`)
      .header("x-report-truncated", String(result.truncated))
      .send(resultToCsv(result));
  });

  /* ---------------------------------------------------------------- */
  /* Schedules (#736)                                                  */
  /* ---------------------------------------------------------------- */

  app.post("/analytics/reports/:reportId/schedules", { preHandler: gate }, async (req, reply) => {
    const { reportId } = req.params as { reportId: string };
    const body = scheduleCreateSchema.parse(req.body);
    const row = requireReadable(await fetchReport(reportId, req.companyId!), req);
    if (!canManageReport(row, req)) {
      throw forbidden("Only the report's creator or a company admin may schedule it");
    }
    if (body.cadence === "weekly" && body.dayOfPeriod != null && body.dayOfPeriod > 6) {
      throw badRequest("dayOfPeriod for a weekly schedule is 0 (Sunday) to 6 (Saturday)");
    }
    if (body.cadence === "monthly" && body.dayOfPeriod != null && body.dayOfPeriod < 1) {
      throw badRequest("dayOfPeriod for a monthly schedule is 1 to 28");
    }
    const nextRunAt = computeNextRunAt(body.cadence, body.dayOfPeriod ?? null);
    const id = newId("rsc");
    await app.db.insert(reportSchedules).values({
      id,
      reportId,
      companyId: req.companyId!,
      cadence: body.cadence,
      dayOfPeriod: body.dayOfPeriod ?? null,
      recipients: body.recipients,
      nextRunAt,
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "report_schedule",
      objectId: id,
      payload: { reportId, cadence: body.cadence, recipients: body.recipients, nextRunAt },
      storePayload: true,
    });
    const [created] = await app.db
      .select()
      .from(reportSchedules)
      .where(eq(reportSchedules.id, id))
      .limit(1);
    return reply.status(201).send({ ...created, delivery: DELIVERY_NOTICE });
  });

  app.get("/analytics/reports/:reportId/schedules", { preHandler: gate }, async (req) => {
    const { reportId } = req.params as { reportId: string };
    requireReadable(await fetchReport(reportId, req.companyId!), req);
    const rows = await app.db
      .select()
      .from(reportSchedules)
      .where(
        and(
          eq(reportSchedules.reportId, reportId),
          eq(reportSchedules.companyId, req.companyId!),
        ),
      )
      .orderBy(asc(reportSchedules.createdAt));
    return { items: rows, delivery: DELIVERY_NOTICE };
  });

  app.delete(
    "/analytics/reports/:reportId/schedules/:scheduleId",
    { preHandler: gate },
    async (req, reply) => {
      const { reportId, scheduleId } = req.params as { reportId: string; scheduleId: string };
      const report = requireReadable(await fetchReport(reportId, req.companyId!), req);
      if (!canManageReport(report, req)) {
        throw forbidden("Only the report's creator or a company admin may remove its schedules");
      }
      const [row] = await app.db
        .select()
        .from(reportSchedules)
        .where(
          and(
            eq(reportSchedules.id, scheduleId),
            eq(reportSchedules.reportId, reportId),
            eq(reportSchedules.companyId, req.companyId!),
          ),
        )
        .limit(1);
      if (!row) throw notFound("Schedule not found");
      await app.db.delete(reportSchedules).where(eq(reportSchedules.id, scheduleId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "report_schedule",
        objectId: scheduleId,
        payload: { reportId, cadence: row.cadence },
      });
      return reply.status(204).send();
    },
  );

  /* ---------------------------------------------------------------- */
  /* Dashboards (#741-742, #749)                                       */
  /* ---------------------------------------------------------------- */

  async function fetchDashboard(dashboardId: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(dashboards)
      .where(and(eq(dashboards.id, dashboardId), eq(dashboards.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Dashboard not found");
    return rows[0];
  }

  type DashboardRow = Awaited<ReturnType<typeof fetchDashboard>>;

  /** Validate widgets and normalize them (server-assigned ids, default span). */
  async function normalizeWidgets(
    req: FastifyRequest,
    input: z.infer<typeof widgetSchema>[],
  ): Promise<DashboardWidget[]> {
    const out: DashboardWidget[] = [];
    for (const w of input) {
      const hasReport = !!w.reportId;
      const hasMetric = !!w.metric;
      if (hasReport === hasMetric) {
        throw badRequest(`Widget "${w.title}" needs exactly one of reportId or metric`);
      }
      if (hasReport) {
        // must exist in this company AND be readable by this user (#737)
        requireReadable(await fetchReport(w.reportId!, req.companyId!), req);
      }
      if (hasMetric && !Object.hasOwn(METRICS, w.metric!)) {
        throw badRequest(`Unknown metric "${w.metric}"`, { allowed: Object.keys(METRICS) });
      }
      out.push({
        id: w.id && /^[A-Za-z0-9_-]{1,60}$/.test(w.id) ? w.id : newId("wid"),
        kind: w.kind,
        title: w.title,
        reportId: w.reportId ?? null,
        metric: w.metric ?? null,
        span: w.span ?? 2,
      });
    }
    return out;
  }

  const canManageDashboard = (row: DashboardRow, req: FastifyRequest) =>
    row.createdBy === req.user!.id || isCompanyAdmin(req);

  app.post("/analytics/dashboards", { preHandler: gate }, async (req, reply) => {
    const body = dashboardCreateSchema.parse(req.body);
    if (body.projectId) await assertProjectReadable(req, body.projectId);
    const widgets = await normalizeWidgets(req, body.widgets ?? []);
    const id = newId("dsh");
    await app.db.insert(dashboards).values({
      id,
      companyId: req.companyId!,
      projectId: body.projectId ?? null,
      name: body.name,
      audience: body.audience ?? null,
      widgets,
      isDefault: body.isDefault ? 1 : 0,
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "dashboard",
      objectId: id,
      payload: { name: body.name, audience: body.audience ?? null, widgets },
      storePayload: true,
    });
    return reply.status(201).send(await fetchDashboard(id, req.companyId!));
  });

  app.get("/analytics/dashboards", { preHandler: gate }, async (req) => {
    const q = reportListQuery.parse(req.query);
    const clauses = [
      eq(dashboards.companyId, req.companyId!),
      q.projectId ? eq(dashboards.projectId, q.projectId) : undefined,
    ].filter((c) => c !== undefined);
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(dashboards).where(where);
    const rows = await app.db
      .select()
      .from(dashboards)
      .where(where)
      .orderBy(desc(dashboards.isDefault), asc(dashboards.name))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows, totalRow?.n ?? 0, q);
  });

  app.get("/analytics/dashboards/:dashboardId", { preHandler: gate }, async (req) => {
    const { dashboardId } = req.params as { dashboardId: string };
    return fetchDashboard(dashboardId, req.companyId!);
  });

  /**
   * Execute every widget on a dashboard (#742). Bounded by construction: at
   * most MAX_DASHBOARD_WIDGETS widgets, each capped at WIDGET_ROW_CAP rows.
   * A widget that fails — its report deleted, its definition no longer
   * resolvable, its project out of reach — reports its own error and the rest
   * of the dashboard still renders.
   */
  app.get("/analytics/dashboards/:dashboardId/data", { preHandler: gate }, async (req) => {
    const { dashboardId } = req.params as { dashboardId: string };
    const dash = await fetchDashboard(dashboardId, req.companyId!);
    const all = (dash.widgets ?? []) as DashboardWidget[];
    const widgets = all.slice(0, MAX_DASHBOARD_WIDGETS);
    const results = [];
    for (const w of widgets) {
      const base = { widgetId: w.id, kind: w.kind, title: w.title, span: w.span };
      try {
        if (w.reportId) {
          const report = requireReadable(await fetchReport(w.reportId, req.companyId!), req);
          const projectId = await resolveRunScope(req, report.projectId ?? dash.projectId, null);
          const data = await runSpec(req, specFromRow(report), projectId, {
            pageSize: Math.min(report.limitRows, WIDGET_ROW_CAP),
            offset: 0,
          });
          results.push({ ...base, reportId: report.id, data });
        } else if (w.metric) {
          if (!Object.hasOwn(METRICS, w.metric)) throw badRequest(`Unknown metric "${w.metric}"`);
          const metric = METRICS[w.metric]!;
          // A metric reads rows too, so it takes the same reach check a report
          // widget gets from resolveRunScope.
          if (dash.projectId) await assertProjectReadable(req, dash.projectId);
          const value = await metric.run(app.db, {
            companyId: req.companyId!,
            projectId: dash.projectId,
            projectIds: dash.projectId ? null : await reachableProjectIds(req),
          });
          results.push({ ...base, metric: w.metric, data: { label: metric.label, value } });
        } else {
          throw badRequest("Widget has neither reportId nor metric");
        }
      } catch (err) {
        results.push({ ...base, data: null, error: (err as Error).message });
      }
    }
    return {
      dashboard: { id: dash.id, name: dash.name, audience: dash.audience, projectId: dash.projectId },
      widgets: results,
      skipped: all.length - widgets.length,
      executedAt: new Date().toISOString(),
    };
  });

  app.patch("/analytics/dashboards/:dashboardId", { preHandler: gate }, async (req) => {
    const { dashboardId } = req.params as { dashboardId: string };
    const body = dashboardPatchSchema.parse(req.body);
    const row = await fetchDashboard(dashboardId, req.companyId!);
    if (!canManageDashboard(row, req)) {
      throw forbidden("Only the dashboard's creator or a company admin may edit it");
    }
    if (body.projectId) await assertProjectReadable(req, body.projectId);
    const widgets = body.widgets ? await normalizeWidgets(req, body.widgets) : row.widgets;
    await app.db
      .update(dashboards)
      .set({
        name: body.name ?? row.name,
        projectId: body.projectId === undefined ? row.projectId : body.projectId,
        audience: body.audience === undefined ? row.audience : body.audience,
        widgets,
        isDefault: body.isDefault === undefined ? row.isDefault : body.isDefault ? 1 : 0,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(dashboards.id, dashboardId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "dashboard",
      objectId: dashboardId,
      payload: { changed: Object.keys(body) },
    });
    return fetchDashboard(dashboardId, req.companyId!);
  });

  app.delete("/analytics/dashboards/:dashboardId", { preHandler: gate }, async (req, reply) => {
    const { dashboardId } = req.params as { dashboardId: string };
    const row = await fetchDashboard(dashboardId, req.companyId!);
    if (!canManageDashboard(row, req)) {
      throw forbidden("Only the dashboard's creator or a company admin may delete it");
    }
    await app.db.delete(dashboards).where(eq(dashboards.id, dashboardId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "dashboard",
      objectId: dashboardId,
      payload: { name: row.name },
    });
    return reply.status(204).send();
  });

  /* ---------------------------------------------------------------- */
  /* Prebuilt role dashboards (#741)                                   */
  /* ---------------------------------------------------------------- */

  interface SeedReport {
    name: string;
    description: string;
    spec: Omit<ReportSpec, "limitRows"> & { limitRows: number };
  }

  /**
   * The seeded reports are ordinary definitions — nothing about them is
   * special-cased at execution, so a user can open, edit or copy any of them.
   */
  const SEED_REPORTS: Record<string, SeedReport> = {
    open_rfis: {
      name: "Open RFIs",
      description: "Count of RFIs still awaiting an official response.",
      spec: {
        dataset: "rfis",
        columns: ["id"],
        filters: [{ field: "status", operator: "in", value: ["draft", "open"] }],
        aggregations: [{ field: "id", fn: "count", alias: "open_rfis" }],
        limitRows: 1,
      },
    },
    punch_by_status: {
      name: "Punch items by status",
      description: "Punch list volume by status, largest first.",
      spec: {
        dataset: "punch_items",
        columns: ["id"],
        filters: [],
        groupBy: "status",
        aggregations: [{ field: "id", fn: "count", alias: "items" }],
        sortBy: "items",
        sortDir: "desc",
        limitRows: 20,
      },
    },
    rfi_ageing: {
      name: "RFI ageing",
      description: "Unanswered RFIs by due date — the oldest commitment first.",
      spec: {
        dataset: "rfis",
        columns: ["number", "subject", "status", "ballInCourtId", "dueDate", "createdAt"],
        filters: [{ field: "status", operator: "in", value: ["draft", "open"] }],
        aggregations: [],
        sortBy: "dueDate",
        sortDir: "asc",
        limitRows: 100,
      },
    },
    variations_by_status: {
      name: "Variations by status",
      description: "Variation count and agreed value by status.",
      spec: {
        dataset: "variations",
        columns: ["id"],
        filters: [],
        groupBy: "status",
        aggregations: [
          { field: "id", fn: "count", alias: "variations" },
          { field: "agreedValue", fn: "sum", alias: "agreed_value" },
        ],
        sortBy: "variations",
        sortDir: "desc",
        limitRows: 20,
      },
    },
    claims_by_status: {
      name: "Payment claims by status",
      description: "Where the payment book stands across the statutory states.",
      spec: {
        dataset: "payment_claims",
        columns: ["id"],
        filters: [],
        groupBy: "status",
        aggregations: [
          { field: "id", fn: "count", alias: "claims" },
          { field: "claimedAmount", fn: "sum", alias: "claimed" },
        ],
        sortBy: "claims",
        sortDir: "desc",
        limitRows: 20,
      },
    },
    disbursement_register: {
      name: "Disbursement register",
      description: "Drawdown requests with amount, purpose and state.",
      spec: {
        dataset: "disbursements",
        columns: ["number", "amount", "status", "purpose", "submittedAt", "disbursedAt"],
        filters: [],
        aggregations: [],
        sortBy: "createdAt",
        sortDir: "desc",
        limitRows: 100,
      },
    },
    signals_by_severity: {
      name: "Signals by severity",
      description: "Open assurance signals grouped by severity.",
      spec: {
        dataset: "signals",
        columns: ["id"],
        filters: [{ field: "disposition", operator: "in", value: ["new", "under_review"] }],
        groupBy: "severity",
        aggregations: [{ field: "id", fn: "count", alias: "signals" }],
        sortBy: "signals",
        sortDir: "desc",
        limitRows: 20,
      },
    },
    grievances_by_status: {
      name: "Grievances by status",
      description: "Community grievance load by status.",
      spec: {
        dataset: "grievances",
        columns: ["id"],
        filters: [],
        groupBy: "status",
        aggregations: [{ field: "id", fn: "count", alias: "grievances" }],
        sortBy: "grievances",
        sortDir: "desc",
        limitRows: 20,
      },
    },
  };

  const SEED_DASHBOARDS: {
    name: string;
    audience: (typeof DASHBOARD_AUDIENCES)[number];
    widgets: { kind: WidgetKind; title: string; report?: string; metric?: string; span: number }[];
  }[] = [
    {
      name: "Project delivery",
      audience: "pm",
      widgets: [
        { kind: "stat", title: "Open RFIs", report: "open_rfis", span: 1 },
        { kind: "bar", title: "Punch items by status", report: "punch_by_status", span: 3 },
        { kind: "table", title: "RFI ageing", report: "rfi_ageing", span: 4 },
      ],
    },
    {
      name: "Commercial",
      audience: "commercial",
      widgets: [
        { kind: "bar", title: "Variations by status", report: "variations_by_status", span: 2 },
        { kind: "donut", title: "Payment claims by status", report: "claims_by_status", span: 2 },
        { kind: "table", title: "Disbursements", report: "disbursement_register", span: 4 },
      ],
    },
    {
      name: "Assurance",
      audience: "assurance",
      widgets: [
        { kind: "bar", title: "Signals by severity", report: "signals_by_severity", span: 2 },
        { kind: "stat", title: "Open obligations", metric: "open_obligations", span: 1 },
        { kind: "donut", title: "Grievances by status", report: "grievances_by_status", span: 3 },
      ],
    },
  ];

  /**
   * Seed the three role dashboards and their backing definitions for a
   * project. Idempotent by (company, project, name): re-running adopts what is
   * already there rather than duplicating it, so it is safe to call on every
   * project open.
   */
  app.post("/analytics/dashboards/seed-defaults", { preHandler: gate }, async (req, reply) => {
    const { projectId } = seedSchema.parse(req.body);
    await assertProjectReadable(req, projectId);
    const companyId = req.companyId!;

    const existingReports = await app.db
      .select()
      .from(reportDefinitions)
      .where(
        and(
          eq(reportDefinitions.companyId, companyId),
          eq(reportDefinitions.projectId, projectId),
        ),
      );
    const byName = new Map(existingReports.map((r) => [r.name, r]));

    const reportIds: Record<string, string> = {};
    const createdReports: string[] = [];
    for (const [key, seed] of Object.entries(SEED_REPORTS)) {
      const existing = byName.get(seed.name);
      if (existing) {
        reportIds[key] = existing.id;
        continue;
      }
      const id = newId("rpt");
      resolveReport(seed.spec); // seeds are definitions like any other
      await app.db.insert(reportDefinitions).values({
        id,
        companyId,
        projectId,
        name: seed.name,
        description: seed.description,
        dataset: seed.spec.dataset,
        columns: seed.spec.columns,
        filters: seed.spec.filters ?? [],
        groupBy: seed.spec.groupBy ?? null,
        aggregations: seed.spec.aggregations ?? [],
        sortBy: seed.spec.sortBy ?? null,
        sortDir: seed.spec.sortDir ?? "desc",
        limitRows: seed.spec.limitRows,
        isShared: 1,
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "create",
        objectType: "report_definition",
        objectId: id,
        payload: { name: seed.name, dataset: seed.spec.dataset, seeded: true },
      });
      reportIds[key] = id;
      createdReports.push(seed.name);
    }

    const existingDashboards = await app.db
      .select()
      .from(dashboards)
      .where(and(eq(dashboards.companyId, companyId), eq(dashboards.projectId, projectId)));
    const dashByName = new Map(existingDashboards.map((d) => [d.name, d]));

    const created: string[] = [];
    const adopted: string[] = [];
    const ids: string[] = [];
    for (const seed of SEED_DASHBOARDS) {
      const existing = dashByName.get(seed.name);
      if (existing) {
        adopted.push(existing.name);
        ids.push(existing.id);
        continue;
      }
      const widgets: DashboardWidget[] = seed.widgets.map((w) => ({
        id: newId("wid"),
        kind: w.kind,
        title: w.title,
        reportId: w.report ? (reportIds[w.report] ?? null) : null,
        metric: w.metric ?? null,
        span: w.span,
      }));
      const id = newId("dsh");
      await app.db.insert(dashboards).values({
        id,
        companyId,
        projectId,
        name: seed.name,
        audience: seed.audience,
        widgets,
        isDefault: 1,
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "create",
        objectType: "dashboard",
        objectId: id,
        payload: { name: seed.name, audience: seed.audience, seeded: true },
        storePayload: true,
      });
      created.push(seed.name);
      ids.push(id);
    }

    const rows = ids.length
      ? await app.db.select().from(dashboards).where(inArray(dashboards.id, ids))
      : [];
    return reply.status(201).send({
      created,
      adopted,
      createdReports,
      dashboards: rows,
    });
  });
};
