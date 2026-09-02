import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, count, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  analyticsForecasts,
  dashboards,
  obligations,
  projects,
  reportDefinitions,
  reportRuns,
  reportSchedules,
  signals,
} from "@constructos/db";
import {
  meetsLevel,
  REPORT_AGGREGATIONS,
  REPORT_DATASETS,
  REPORT_FILTER_OPERATORS,
  REPORT_FORMATS,
  WIDGET_KINDS,
  type PermissionLevel,
  type ToolKey,
  type WidgetKind,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import type { Db } from "../../lib/db.js";
import {
  applySensitivity,
  datasetCatalog,
  DATASETS,
  executeReport,
  MAX_LIMIT_ROWS,
  resolveReport,
  resultToCsv,
  type AggregationInput,
  type ExecutionResult,
  type FilterInput,
  type ReportSpec,
} from "./datasets.js";
import { reachOf, type Reach } from "./authz.js";
import { registerReportDelivery, runDueSchedules } from "./delivery.js";
import {
  computeForecast,
  FORECAST_KIND_LIST,
  registerForecastJob,
  storeForecast,
  type ForecastKindKey,
} from "./forecast.js";

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
  format: z.enum(REPORT_FORMATS).optional(),
});

const schedulePatchSchema = z
  .object({
    active: z.boolean().optional(),
    recipients: z.array(z.string().email().max(320)).min(1).max(50).optional(),
    format: z.enum(REPORT_FORMATS).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, "no fields to update");

const runsListQuery = pageQuerySchema.extend({
  reportId: z.string().min(1).max(60).optional(),
  status: z.enum(["succeeded", "failed"]).optional(),
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
 * What this deployment will actually do when `nextRunAt` passes.
 *
 * The scheduler job `analytics.report-delivery` now executes due schedules,
 * renders them and hands them to the transport lib/email.ts resolves. Whether
 * anything LEAVES depends on `EMAIL_PROVIDER`, and the answer is computed from
 * the running configuration rather than asserted: with no provider the
 * platform records the message, reports `dispatched:false` with the variable
 * that would change it, and says so here — the same discipline
 * MetricComputation applies to a figure it cannot compute.
 */
function deliveryNotice(app: { appConfig: { EMAIL_PROVIDER: string } }) {
  const provider = app.appConfig.EMAIL_PROVIDER;
  const dispatches = provider !== "none";
  return {
    enabled: true,
    dispatches,
    provider,
    job: "analytics.report-delivery",
    note: dispatches
      ? `Due schedules are executed by the scheduler job "analytics.report-delivery" and sent ` +
        `through the ${provider} transport. Each run is recorded in GET /analytics/reports/runs ` +
        "with what was sent, to whom, and whether the provider accepted it."
      : "Due schedules ARE executed by the scheduler job \"analytics.report-delivery\", but " +
        "EMAIL_PROVIDER is unset, so the rendered report is recorded and NOT delivered. Every run " +
        "row carries deliveryDispatched=false and the reason. Set EMAIL_PROVIDER (plus " +
        "EMAIL_API_KEY and EMAIL_FROM_ADDRESS) to make delivery real.",
  };
}

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
 * `:projectId` tool gate cannot apply as a preHandler. Authority is resolved
 * per report instead, against the DATASET'S GOVERNING TOOL and the caller's
 * effective level on it — see ./authz.ts. A report is never a wider door than
 * the module it reports on, and a column classed `commercial` or `pii` needs
 * the level that could edit the record it came from.
 *
 * Scheduled delivery is real (./delivery.ts): a scheduler job renders due
 * reports and hands them to lib/email.ts, which reports `dispatched:false` with
 * reasons when no transport is configured. Predictive insights (#753-758) live
 * in ./forecast.ts.
 */
export const analyticsModule: FastifyPluginAsync = async (app) => {
  const gate = [app.authenticate, app.requireCompany];
  /** Running every due schedule now mails data out of the tenant: admin only. */
  const adminGate = [
    app.authenticate,
    app.requireCompany,
    app.requireCompanyRole(["owner", "admin"]),
  ];

  // Delivery and forecasting are time-driven, so they are scheduler jobs
  // rather than side effects of somebody opening a page (PLAN §6.1).
  registerReportDelivery(app, (cadence, dayOfPeriod, from) =>
    computeNextRunAt(cadence as ScheduleCadence, dayOfPeriod, from),
  );
  registerForecastJob(app);

  const isCompanyAdmin = (req: FastifyRequest) =>
    req.companyRole === "owner" || req.companyRole === "admin";

  /**
   * ROW-LEVEL SECURITY, TOOL-AWARE (#751). See ./authz.ts for why this is not
   * "every project you are a member of": a membership carries a LEVEL per
   * tool, and a report over `workers` is a read of the workforce module.
   */
  const reach = (req: FastifyRequest) => reachOf(app.db, req);

  /** The tool a dataset key is governed by; 400 on an unknown dataset. */
  function toolForDataset(dataset: string): ToolKey {
    if (!Object.hasOwn(DATASETS, dataset)) {
      throw badRequest(`Unknown dataset "${dataset}"`, { allowed: REPORT_DATASETS });
    }
    return DATASETS[dataset as keyof typeof DATASETS].tool;
  }

  /**
   * A project a report is pinned to must be in the tenant AND readable by the
   * caller at the dataset's tool. Passing the tool is what makes the check
   * mean something — the old version accepted any membership.
   */
  async function assertProjectReadable(
    req: FastifyRequest,
    projectId: string,
    tool: ToolKey,
  ): Promise<void> {
    await reach(req).assertProjectReadable(projectId, tool);
  }

  /** A dashboard is a container: reaching it needs any access to its project. */
  async function assertProjectVisible(req: FastifyRequest, projectId: string): Promise<void> {
    const rows = await app.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, req.companyId!)))
      .limit(1);
    if (!rows[0]) throw badRequest("projectId is not a project in this company");
    const any = await reach(req).anyReach();
    if (any !== null && !any.includes(projectId)) throw forbidden("No access to this project");
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
    return { ...row, isShared: row.isShared === 1, tool: toolForDataset(row.dataset) };
  }

  /** Resolve the project a run executes against. */
  async function resolveRunScope(
    req: FastifyRequest,
    dataset: string,
    reportProjectId: string | null,
    requestedProjectId?: string | null,
  ): Promise<string | null> {
    // A definition's own project wins; a run may only supply one when the
    // definition is company-wide, and never widen an existing scope.
    const projectId = reportProjectId ?? requestedProjectId ?? null;
    if (projectId) await assertProjectReadable(req, projectId, toolForDataset(dataset));
    return projectId;
  }

  interface RunOutcome {
    result: ExecutionResult;
    /** the effective scope, recorded on every export and scheduled run */
    scope: {
      tool: ToolKey;
      level: PermissionLevel;
      projectId: string | null;
      projectIds: string[] | null;
      hiddenColumns: string[];
    };
  }

  /**
   * Execute a spec under the caller's authority.
   *
   * Two questions are answered here and nowhere else: WHICH PROJECTS' rows may
   * be read (the dataset's tool at `read`), and WHICH COLUMNS may be projected
   * (the dataset's tool at `standard` for commercial and pii classes). A
   * company-wide run takes the WEAKER of the levels it spans — holding standard
   * on one project does not unlock salaries on another.
   */
  async function runSpec(
    req: FastifyRequest,
    spec: ReportSpec,
    projectId: string | null,
    window: { pageSize: number; offset: number },
  ): Promise<RunOutcome> {
    const plan = resolveReport(spec);
    const tool = plan.dataset.tool;
    const r = reach(req);
    let level: PermissionLevel;
    let projectIds: Reach = null;
    if (projectId) {
      level = await r.levelFor(projectId, tool);
      if (!meetsLevel(level, "read")) {
        throw forbidden(`Requires read access to ${tool} on this project`);
      }
    } else {
      const readReach = await r.reachFor(tool, "read");
      const stdReach = await r.reachFor(tool, "standard");
      projectIds = readReach;
      const standardEverywhere =
        stdReach === null ||
        (readReach !== null && readReach.every((id) => stdReach.includes(id)));
      level = standardEverywhere ? "standard" : "read";
    }
    const { plan: narrowed, hiddenColumns } = applySensitivity(plan, level);
    const result = await executeReport(
      app.db,
      narrowed,
      { companyId: req.companyId!, projectId, projectIds },
      window,
      { hiddenColumns },
    );
    return {
      result,
      scope: {
        tool,
        level,
        projectId,
        projectIds: projectIds === null ? null : [...projectIds],
        hiddenColumns,
      },
    };
  }

  /** Record an execution: what ran, under whose reach, and what came back. */
  async function recordRun(
    req: FastifyRequest | null,
    input: {
      companyId: string;
      reportId: string;
      trigger: "manual" | "scheduled" | "dashboard";
      outcome: RunOutcome | null;
      format?: "csv" | "json";
      error?: string | null;
    },
  ): Promise<string> {
    const id = newId("rrn");
    const res = input.outcome?.result;
    await app.db.insert(reportRuns).values({
      id,
      companyId: input.companyId,
      reportId: input.reportId,
      scheduleId: null,
      trigger: input.trigger,
      status: input.error ? "failed" : "succeeded",
      projectId: input.outcome?.scope.projectId ?? null,
      rowCount: res?.rowCount ?? 0,
      truncated: res?.truncated ? 1 : 0,
      durationMs: res?.ms ?? 0,
      // Aggregate results are small and are the ones a trend chart wants; a
      // row-mode result is NOT frozen (it would duplicate the record).
      resultSummary: res && res.rows.length <= 50 ? res.rows : [],
      scope: (input.outcome?.scope ?? {}) as Record<string, unknown>,
      format: input.format ?? "csv",
      recipients: [],
      deliveryDispatched: 0,
      deliveryReasons: [],
      error: input.error ?? null,
      runBy: req?.user?.id ?? null,
    });
    return id;
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
    if (body.projectId) {
      await assertProjectReadable(req, body.projectId, toolForDataset(body.dataset));
    }
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
    if (body.projectId) {
      await assertProjectReadable(req, body.projectId, toolForDataset(body.dataset ?? row.dataset));
    }

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
    if (projectId) await assertProjectReadable(req, projectId, toolForDataset(body.dataset));
    const { result, scope } = await runSpec(
      req,
      { ...body, limitRows: body.limitRows ?? 500 },
      projectId,
      { pageSize: q.pageSize, offset: pageOffset(q) },
    );
    return { ...result, page: q.page, pageSize: q.pageSize, saved: false, scope };
  });

  app.post("/analytics/reports/:reportId/run", { preHandler: gate }, async (req) => {
    const { reportId } = req.params as { reportId: string };
    const q = runQuery.parse(req.query);
    const row = requireReadable(await fetchReport(reportId, req.companyId!), req);
    const projectId = await resolveRunScope(req, row.dataset, row.projectId, q.projectId);
    const outcome = await runSpec(req, specFromRow(row), projectId, {
      pageSize: q.pageSize,
      offset: pageOffset(q),
    });
    await recordRun(req, {
      companyId: req.companyId!,
      reportId: row.id,
      trigger: "manual",
      outcome,
    });
    return {
      ...outcome.result,
      page: q.page,
      pageSize: q.pageSize,
      scope: outcome.scope,
      report: {
        id: row.id,
        name: row.name,
        dataset: row.dataset,
        projectId,
        /** the definition's own scope, so the UI can say which it ran */
        definitionProjectId: row.projectId,
      },
    };
  });

  app.get("/analytics/reports/:reportId/export.csv", { preHandler: gate }, async (req, reply) => {
    const { reportId } = req.params as { reportId: string };
    const q = runQuery.parse(req.query);
    const row = requireReadable(await fetchReport(reportId, req.companyId!), req);
    const projectId = await resolveRunScope(req, row.dataset, row.projectId, q.projectId);
    const { result, scope } = await runSpec(req, specFromRow(row), projectId, {
      pageSize: row.limitRows,
      offset: 0,
    });
    await recordRun(req, {
      companyId: req.companyId!,
      reportId: row.id,
      trigger: "manual",
      outcome: { result, scope },
      format: "csv",
    });
    // Data leaving the platform is a ledgered access event (#737), and the
    // entry records the EFFECTIVE SCOPE it left under: which tool governed it,
    // which level the caller held, which projects were in reach and which
    // columns were withheld. An export nobody can characterise afterwards is
    // not an audited export.
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "access",
      objectType: "report_definition",
      objectId: reportId,
      payload: {
        export: "csv",
        rowCount: result.rowCount,
        truncated: result.truncated,
        projectId,
        scope,
      },
      storePayload: true,
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
      format: body.format ?? "csv",
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
    return reply.status(201).send({ ...created, delivery: deliveryNotice(app) });
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
    return { items: rows, delivery: deliveryNotice(app) };
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

  /**
   * Pause, resume, re-address or re-format a schedule. A paused schedule keeps
   * its next instant so resuming does not deliver a backlog, and every change
   * is ledgered — a standing instruction to mail data out of the tenant is a
   * consequential object.
   */
  app.patch(
    "/analytics/reports/:reportId/schedules/:scheduleId",
    { preHandler: gate },
    async (req) => {
      const { reportId, scheduleId } = req.params as { reportId: string; scheduleId: string };
      const body = schedulePatchSchema.parse(req.body);
      const report = requireReadable(await fetchReport(reportId, req.companyId!), req);
      if (!canManageReport(report, req)) {
        throw forbidden("Only the report's creator or a company admin may change its schedules");
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
      const nextRunAt =
        body.active === true && row.isActive !== 1
          ? computeNextRunAt(row.cadence as ScheduleCadence, row.dayOfPeriod)
          : row.nextRunAt;
      await app.db
        .update(reportSchedules)
        .set({
          isActive: body.active === undefined ? row.isActive : body.active ? 1 : 0,
          recipients: body.recipients ?? row.recipients,
          format: body.format ?? row.format,
          nextRunAt,
        })
        .where(eq(reportSchedules.id, scheduleId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "report_schedule",
        objectId: scheduleId,
        payload: { changed: Object.keys(body), active: body.active ?? row.isActive === 1 },
      });
      const [after] = await app.db
        .select()
        .from(reportSchedules)
        .where(eq(reportSchedules.id, scheduleId))
        .limit(1);
      return { ...after, delivery: deliveryNotice(app) };
    },
  );

  /**
   * Run every due schedule for this tenant NOW. The scheduler runs the same
   * function on its own clock; this is the operator's "do it now" and the seam
   * every delivery test drives.
   */
  app.post(
    "/analytics/reports/schedules/run-due",
    { preHandler: adminGate },
    async (req) => {
      const out = await runDueSchedules(
        app.db,
        app.appConfig,
        req.companyId!,
        new Date(),
        (cadence, dayOfPeriod, from) =>
          computeNextRunAt(cadence as ScheduleCadence, dayOfPeriod, from),
      );
      return { ...out, delivery: deliveryNotice(app) };
    },
  );

  /**
   * The run history (#752). Every execution — manual, scheduled or through a
   * dashboard — leaves a row, and a scheduled row states whether the message
   * was actually dispatched. It is also the series a trend widget charts.
   */
  app.get("/analytics/reports/runs", { preHandler: gate }, async (req) => {
    const q = runsListQuery.parse(req.query);
    // A run row names a report and a project, so it is filtered to the reports
    // the caller may read, exactly like the definitions list.
    const visible = await app.db
      .select({ id: reportDefinitions.id })
      .from(reportDefinitions)
      .where(
        and(
          eq(reportDefinitions.companyId, req.companyId!),
          isCompanyAdmin(req)
            ? undefined
            : or(
                eq(reportDefinitions.createdBy, req.user!.id),
                eq(reportDefinitions.isShared, 1),
              )!,
        ),
      );
    const visibleIds = visible.map((r) => r.id);
    if (visibleIds.length === 0) return paginate([], 0, q);
    const where = and(
      eq(reportRuns.companyId, req.companyId!),
      inArray(reportRuns.reportId, q.reportId ? [q.reportId] : visibleIds),
      q.reportId && !visibleIds.includes(q.reportId) ? sql`false` : undefined,
      q.status ? eq(reportRuns.status, q.status) : undefined,
    );
    const [totalRow] = await app.db.select({ n: count() }).from(reportRuns).where(where);
    const rows = await app.db
      .select()
      .from(reportRuns)
      .where(where)
      .orderBy(desc(reportRuns.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(
      rows.map((r) => ({
        ...r,
        truncated: r.truncated === 1,
        deliveryDispatched: r.deliveryDispatched === 1,
      })),
      totalRow?.n ?? 0,
      q,
    );
  });

  /* ---------------------------------------------------------------- */
  /* Predictive insights (#753-758)                                    */
  /* ---------------------------------------------------------------- */

  const forecastQuery = z.object({
    kind: z.enum(["cost_overrun", "schedule_overrun"]).optional(),
    assetClass: z.string().min(2).max(40).optional(),
    region: z.string().min(2).max(40).optional(),
  });

  /**
   * The live forecast for a project. Read-only: nothing is stored, nothing is
   * signalled — a GET that writes is a GET a prefetching browser can fire.
   */
  app.get(
    "/projects/:projectId/analytics/forecast",
    { preHandler: [app.authenticate, app.requireCompany, app.requireTool("analytics", "read")] },
    async (req) => {
      const q = forecastQuery.parse(req.query);
      const kinds = q.kind ? [q.kind as ForecastKindKey] : [...FORECAST_KIND_LIST];
      const forecasts = [];
      for (const kind of kinds) {
        forecasts.push(
          await computeForecast(app.db, {
            companyId: req.companyId!,
            projectId: req.projectId!,
            kind,
            assetClass: q.assetClass ?? null,
            region: q.region ?? null,
          }),
        );
      }
      return {
        projectId: req.projectId!,
        computedAt: new Date().toISOString(),
        forecasts,
        method:
          "Reference-class forecasting: the project's booked growth placed in the empirical " +
          "distribution of comparable projects. No parametric model, no smoothing — with a small " +
          "n the probability moves in whole samples, which is why n and the contributor count are " +
          "always returned.",
      };
    },
  );

  /** Freeze a forecast, so the number a contingency decision cited survives. */
  app.post(
    "/projects/:projectId/analytics/forecast",
    { preHandler: [app.authenticate, app.requireCompany, app.requireTool("analytics", "standard")] },
    async (req, reply) => {
      const q = forecastQuery.parse(req.body ?? {});
      const kinds = q.kind ? [q.kind as ForecastKindKey] : [...FORECAST_KIND_LIST];
      const stored = [];
      for (const kind of kinds) {
        const f = await computeForecast(app.db, {
          companyId: req.companyId!,
          projectId: req.projectId!,
          kind,
          assetClass: q.assetClass ?? null,
          region: q.region ?? null,
        });
        const id = await storeForecast(
          app.db,
          {
            companyId: req.companyId!,
            projectId: req.projectId!,
            computedBy: req.user!.id,
          },
          f,
        );
        await appendLedger(app.db, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "create",
          objectType: "analytics_forecast",
          objectId: id,
          projectId: req.projectId!,
          payload: {
            kind: f.kind,
            probability: f.probability,
            p80Uplift: f.p80Uplift,
            referenceClass: f.referenceClass,
            sampleSize: f.sampleSize,
            reasons: f.reasons,
          },
          storePayload: true,
        });
        stored.push({ id, ...f });
      }
      return reply.status(201).send({ forecasts: stored });
    },
  );

  /** The stored forecast history for a project. */
  app.get(
    "/projects/:projectId/analytics/forecasts",
    { preHandler: [app.authenticate, app.requireCompany, app.requireTool("analytics", "read")] },
    async (req) => {
      const q = pageQuerySchema.parse(req.query);
      const where = and(
        eq(analyticsForecasts.companyId, req.companyId!),
        eq(analyticsForecasts.projectId, req.projectId!),
      );
      const [totalRow] = await app.db.select({ n: count() }).from(analyticsForecasts).where(where);
      const rows = await app.db
        .select()
        .from(analyticsForecasts)
        .where(where)
        .orderBy(desc(analyticsForecasts.createdAt))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      return paginate(rows, totalRow?.n ?? 0, q);
    },
  );

  /**
   * Health inputs for the intelligence layer (contract §3.5). Cheap, indexed
   * and project-scoped: the count of open signals and obligations this project
   * carries, plus the overrun probabilities if they are computable. A metric
   * the platform cannot compute is `null` with a reason, never 0.
   */
  app.get(
    "/projects/:projectId/analytics/health-inputs",
    { preHandler: [app.authenticate, app.requireCompany, app.requireTool("analytics", "read")] },
    async (req) => {
      const reasons: string[] = [];
      const [signalRow] = await app.db
        .select({ n: count() })
        .from(signals)
        .where(
          and(
            eq(signals.companyId, req.companyId!),
            eq(signals.projectId, req.projectId!),
            inArray(signals.disposition, ["new", "under_review"]),
          ),
        );
      const [obligationRow] = await app.db
        .select({ n: count() })
        .from(obligations)
        .where(
          and(
            eq(obligations.companyId, req.companyId!),
            eq(obligations.projectId, req.projectId!),
            eq(obligations.status, "open"),
          ),
        );
      const cost = await computeForecast(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        kind: "cost_overrun",
      });
      const schedule = await computeForecast(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        kind: "schedule_overrun",
      });
      if (cost.probability === null) reasons.push(...cost.reasons.slice(0, 2));
      if (schedule.probability === null) reasons.push(...schedule.reasons.slice(0, 2));
      return {
        metrics: {
          openSignals: signalRow?.n ?? 0,
          openObligations: obligationRow?.n ?? 0,
          costOverrunProbability: cost.probability,
          scheduleOverrunProbability: schedule.probability,
          costGrowthPct:
            typeof cost.inputs["growthToDatePct"] === "number"
              ? (cost.inputs["growthToDatePct"] as number)
              : null,
        },
        reasons: [...new Set(reasons)],
      };
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
    if (body.projectId) await assertProjectVisible(req, body.projectId);
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

  /**
   * A dashboard PINNED to a project is listed for callers who reach that
   * project; a COMPANY-WIDE dashboard (projectId null) is listed for everyone
   * in the tenant, because it is exactly the object a company-level view is
   * made of and its widgets are still executed under the reader's own reach.
   *
   * `projectId=` narrows to that project AND the company-wide ones, which is
   * what the project workspace wants: previously a company-wide dashboard
   * created through the API was invisible in every screen the app has.
   */
  app.get("/analytics/dashboards", { preHandler: gate }, async (req) => {
    const q = reportListQuery.parse(req.query);
    const any = await reach(req).anyReach();
    const scopeClause = q.projectId
      ? or(eq(dashboards.projectId, q.projectId), isNull(dashboards.projectId))!
      : any === null
        ? undefined
        : any.length === 0
          ? isNull(dashboards.projectId)
          : or(inArray(dashboards.projectId, any), isNull(dashboards.projectId))!;
    if (q.projectId) await assertProjectVisible(req, q.projectId);
    const clauses = [eq(dashboards.companyId, req.companyId!), scopeClause].filter(
      (c) => c !== undefined,
    );
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(dashboards).where(where);
    const rows = await app.db
      .select()
      .from(dashboards)
      .where(where)
      .orderBy(desc(dashboards.isDefault), asc(dashboards.name))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(
      rows.map((d) => ({ ...d, companyWide: d.projectId === null })),
      totalRow?.n ?? 0,
      q,
    );
  });

  app.get("/analytics/dashboards/:dashboardId", { preHandler: gate }, async (req) => {
    const { dashboardId } = req.params as { dashboardId: string };
    const dash = await fetchDashboard(dashboardId, req.companyId!);
    // The definition names project ids and report ids: reading it is reading
    // something about the project, so it takes the same reach check its data
    // does. Without this a member on no project could enumerate which projects
    // have which dashboards.
    if (dash.projectId) await assertProjectVisible(req, dash.projectId);
    return { ...dash, companyWide: dash.projectId === null };
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
    if (dash.projectId) await assertProjectVisible(req, dash.projectId);
    const all = (dash.widgets ?? []) as DashboardWidget[];
    const widgets = all.slice(0, MAX_DASHBOARD_WIDGETS);
    // One batched fetch for every backing definition instead of one query per
    // widget: a twelve-widget dashboard used to run ~60 queries, most of them
    // recomputing the same membership set.
    const reportIds = [...new Set(widgets.map((w) => w.reportId).filter((v): v is string => !!v))];
    const reportRows = reportIds.length
      ? await app.db
          .select()
          .from(reportDefinitions)
          .where(
            and(
              eq(reportDefinitions.companyId, req.companyId!),
              inArray(reportDefinitions.id, reportIds),
            ),
          )
      : [];
    const reportsById = new Map(reportRows.map((r) => [r.id, r]));
    const metricReach = dash.projectId ? null : await reach(req).anyReach();
    const results = [];
    for (const w of widgets) {
      const base = { widgetId: w.id, kind: w.kind, title: w.title, span: w.span };
      try {
        if (w.reportId) {
          const found = reportsById.get(w.reportId);
          if (!found) throw notFound("Report not found");
          const report = requireReadable(found, req);
          const projectId = await resolveRunScope(
            req,
            report.dataset,
            report.projectId ?? dash.projectId,
            null,
          );
          const { result, scope } = await runSpec(req, specFromRow(report), projectId, {
            pageSize: Math.min(report.limitRows, WIDGET_ROW_CAP),
            offset: 0,
          });
          results.push({ ...base, reportId: report.id, data: result, scope });
        } else if (w.metric) {
          if (!Object.hasOwn(METRICS, w.metric)) throw badRequest(`Unknown metric "${w.metric}"`);
          const metric = METRICS[w.metric]!;
          if (dash.projectId) await assertProjectVisible(req, dash.projectId);
          const value = await metric.run(app.db, {
            companyId: req.companyId!,
            projectId: dash.projectId,
            projectIds: metricReach,
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
    if (body.projectId) await assertProjectVisible(req, body.projectId);
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
    await assertProjectVisible(req, projectId);
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
