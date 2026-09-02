/**
 * Scheduled report delivery (spec Vol I §6.1 #736, #752).
 *
 * WHAT WAS WRONG. `report_schedules` rows were created with a maintained
 * `nextRunAt` and a note in every response admitting that nothing would ever
 * run them: no scheduler, no worker, no transport. The instants aged into the
 * past and the register filled with promises the platform could not keep.
 *
 * WHAT IS TRUE NOW. A scheduler job (lib/scheduler.ts, replica-safe through the
 * advisory lock the scheduler already takes per job) claims due schedules,
 * executes the report UNDER THE SCHEDULE CREATOR'S OWN REACH — never the
 * platform's, and never wider than the person who set it up — renders CSV or
 * JSON, hands the message to lib/email.ts and writes a `report_runs` row
 * carrying `deliveryDispatched` and the transport's reasons.
 *
 * WHAT IS STILL HONEST ABOUT IT. With `EMAIL_PROVIDER=none` — the default —
 * the no-op transport records the message and returns `dispatched:false` with
 * the environment variable that would change it. The schedule still advances,
 * the run row still exists, and every response says the message was RECORDED
 * and not delivered. What has changed is that the platform now knows the
 * difference, and can prove which it was.
 *
 * Deliberately NOT done: PDF and XLSX rendering. Both need a dependency this
 * repo does not carry, and a CSV attachment that opens correctly everywhere is
 * worth more than a PDF that is nearly right; the format vocabulary
 * (REPORT_FORMATS) is where they would be added.
 */
import type { FastifyInstance } from "fastify";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { reportDefinitions, reportRuns, reportSchedules } from "@constructos/db";
import type { ReportFormat } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { forEachCompany } from "../../lib/scheduler.js";
import type { Db } from "../../lib/db.js";
import {
  resolveEmailTransport,
  type EmailMessage,
  type EmailSendResult,
  type EmailTransport,
} from "../../lib/email.js";
import type { Config } from "../../config.js";
import { AnalyticsReach } from "./authz.js";
import {
  applySensitivity,
  executeReport,
  resolveReport,
  resultToCsv,
  type ExecutionResult,
  type AggregationInput,
  type FilterInput,
} from "./datasets.js";

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

/**
 * One transport per database handle, for the same two reasons
 * modules/account/mailer.ts memoises its own: `resolveEmailTransport` builds a
 * NEW recorder every call (so calling it per delivery throws away the outbox
 * the no-op transport exists to keep), and a test file holds several apps at
 * once whose outboxes must not mix.
 */
const transports = new WeakMap<object, EmailTransport>();

export function reportTransport(db: Db, config: Config): EmailTransport {
  const key = db as object;
  let t = transports.get(key);
  if (!t) {
    t = resolveEmailTransport(config);
    transports.set(key, t);
  }
  return t;
}

/** Override the transport for one database handle (tests). `null` restores it. */
export function useReportTransport(db: Db, transport: EmailTransport | null): void {
  if (transport) transports.set(db as object, transport);
  else transports.delete(db as object);
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/** Render a result in the schedule's format. CSV goes through the same
 * formula-neutralising escape every export does. */
export function renderResult(result: ExecutionResult, format: ReportFormat): string {
  if (format === "json") {
    return JSON.stringify(
      {
        dataset: result.dataset,
        columns: result.columns,
        rows: result.rows,
        rowCount: result.rowCount,
        truncated: result.truncated,
        executedAt: result.executedAt,
        ...(result.hiddenColumns ? { hiddenColumns: result.hiddenColumns } : {}),
      },
      null,
      2,
    );
  }
  return resultToCsv(result);
}

/**
 * The message body. A scheduled report that arrives without its caveats is
 * worse than no report: truncation, withheld columns and the scope it ran under
 * are stated in the text, not only in the attachment.
 */
export function composeMessage(input: {
  to: string;
  reportName: string;
  result: ExecutionResult;
  format: ReportFormat;
  body: string;
  appBaseUrl: string;
  projectId: string | null;
  cadence: string;
}): EmailMessage {
  const caveats: string[] = [];
  if (input.result.truncated) {
    caveats.push(
      `More rows matched than were returned — this extract stops at ${input.result.rowCount} rows.`,
    );
  }
  if (input.result.hiddenColumns?.length) {
    caveats.push(
      `Withheld columns (you do not hold standard access to them): ${input.result.hiddenColumns.join(", ")}.`,
    );
  }
  caveats.push(
    input.projectId
      ? `Scope: one project (${input.projectId}).`
      : "Scope: every project you can open.",
  );
  const lines = [
    `${input.reportName} — ${input.cadence} extract`,
    "",
    `${input.result.rowCount} row(s), executed ${input.result.executedAt}.`,
    ...caveats,
    "",
    "--- extract follows ---",
    input.body.length > 60_000 ? `${input.body.slice(0, 60_000)}\n…[truncated]` : input.body,
  ];
  const text = lines.join("\n");
  return {
    to: { email: input.to },
    subject: `${input.reportName} — ${input.result.rowCount} row(s)`,
    text,
    html: `<pre style="font:12px/1.5 ui-monospace,monospace">${escapeHtml(text)}</pre>`,
    tags: { kind: "report_schedule", format: input.format },
  };
}

function escapeHtml(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

export interface ScheduleRunSummary {
  scheduleId: string;
  reportId: string;
  status: "succeeded" | "failed";
  rowCount: number;
  recipients: number;
  dispatched: boolean;
  reasons: string[];
  error: string | null;
  runId: string | null;
}

/**
 * The creator's authority, resolved the same way a request would resolve it.
 * A schedule is a standing instruction from a person, so it reads what THAT
 * person can read — not what the platform can read. If they lose access, the
 * extract shrinks; if they lose the company entirely, it returns nothing.
 */
async function creatorReach(
  db: Db,
  companyId: string,
  userId: string,
): Promise<AnalyticsReach> {
  // Company role is deliberately NOT assumed: a schedule created by an admin
  // who has since become a member must run at the member's reach. The role is
  // re-read here rather than frozen at creation.
  const rows = await db.execute(
    sql`select role from company_memberships where company_id = ${companyId} and user_id = ${userId} limit 1`,
  );
  const list = (rows as unknown as { rows?: Array<{ role?: unknown }> }).rows ??
    (rows as unknown as Array<{ role?: unknown }>);
  const role = list?.[0]?.role;
  const isAdmin = role === "owner" || role === "admin";
  return new AnalyticsReach(db, companyId, userId, isAdmin);
}

/** Execute one schedule now: render, send, record, advance. */
export async function runSchedule(
  db: Db,
  config: Config,
  schedule: typeof reportSchedules.$inferSelect,
  now: Date,
  nextRunAt: (from: Date) => string,
): Promise<ScheduleRunSummary> {
  const base: ScheduleRunSummary = {
    scheduleId: schedule.id,
    reportId: schedule.reportId,
    status: "succeeded",
    rowCount: 0,
    recipients: schedule.recipients.length,
    dispatched: false,
    reasons: [],
    error: null,
    runId: null,
  };
  const [report] = await db
    .select()
    .from(reportDefinitions)
    .where(
      and(
        eq(reportDefinitions.id, schedule.reportId),
        eq(reportDefinitions.companyId, schedule.companyId),
      ),
    )
    .limit(1);

  const format = (schedule.format === "json" ? "json" : "csv") as ReportFormat;
  const runId = newId("rrn");
  let result: ExecutionResult | null = null;
  let scope: Record<string, unknown> = {};
  let error: string | null = null;

  try {
    if (!report) throw new Error("The report this schedule points at no longer exists");
    const reach = await creatorReach(db, schedule.companyId, schedule.createdBy);
    const plan = resolveReport({
      dataset: report.dataset,
      columns: report.columns,
      filters: (report.filters ?? []) as FilterInput[],
      groupBy: report.groupBy,
      aggregations: (report.aggregations ?? []) as AggregationInput[],
      sortBy: report.sortBy,
      sortDir: report.sortDir,
      limitRows: report.limitRows,
    });
    const tool = plan.dataset.tool;
    let level = await (async () => {
      if (report.projectId) return reach.levelFor(report.projectId, tool);
      const readReach = await reach.reachFor(tool, "read");
      const stdReach = await reach.reachFor(tool, "standard");
      const everywhere =
        stdReach === null ||
        (readReach !== null && readReach.every((id) => stdReach.includes(id)));
      return everywhere ? ("standard" as const) : ("read" as const);
    })();
    let projectIds: string[] | null = null;
    if (report.projectId) {
      if (level === "none") {
        throw new Error(
          "The person who created this schedule no longer has access to the report's project",
        );
      }
    } else {
      projectIds = await reach.reachFor(tool, "read");
      if (projectIds !== null && projectIds.length === 0) level = "read";
    }
    const { plan: narrowed, hiddenColumns } = applySensitivity(plan, level);
    result = await executeReport(
      db,
      narrowed,
      { companyId: schedule.companyId, projectId: report.projectId, projectIds },
      { pageSize: report.limitRows, offset: 0 },
      { hiddenColumns },
    );
    scope = {
      tool,
      level,
      projectId: report.projectId,
      projectIds,
      hiddenColumns,
      as: schedule.createdBy,
    };
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const reasons: string[] = [];
  let dispatched = false;
  if (result && report) {
    const transport = reportTransport(db, config);
    const body = renderResult(result, format);
    const outcomes: EmailSendResult[] = [];
    for (const to of schedule.recipients) {
      const message = composeMessage({
        to,
        reportName: report.name,
        result,
        format,
        body,
        appBaseUrl: config.APP_BASE_URL,
        projectId: report.projectId,
        cadence: schedule.cadence,
      });
      outcomes.push(await transport.send(message));
    }
    dispatched = outcomes.length > 0 && outcomes.every((o) => o.dispatched);
    for (const o of outcomes) for (const r of o.reasons) if (!reasons.includes(r)) reasons.push(r);
  }

  await db.insert(reportRuns).values({
    id: runId,
    companyId: schedule.companyId,
    reportId: schedule.reportId,
    scheduleId: schedule.id,
    trigger: "scheduled",
    status: error ? "failed" : "succeeded",
    projectId: report?.projectId ?? null,
    rowCount: result?.rowCount ?? 0,
    truncated: result?.truncated ? 1 : 0,
    durationMs: result?.ms ?? 0,
    resultSummary: result && result.rows.length <= 50 ? result.rows : [],
    scope,
    format,
    recipients: schedule.recipients,
    deliveryDispatched: dispatched ? 1 : 0,
    deliveryReasons: reasons,
    error,
    runBy: schedule.createdBy,
  });

  await db
    .update(reportSchedules)
    .set({
      lastRunAt: now.toISOString(),
      nextRunAt: nextRunAt(now),
      lastStatus: error ? "failed" : dispatched ? "sent" : "recorded",
      lastError: error,
      runCount: sql`${reportSchedules.runCount} + 1`,
    })
    .where(eq(reportSchedules.id, schedule.id));

  await appendLedger(db, {
    companyId: schedule.companyId,
    // A scheduled run has no human actor at the instant it fires — the system
    // is the actor, and the creator is recorded in the payload.
    actorId: null,
    action: "access",
    objectType: "report_schedule",
    objectId: schedule.id,
    payload: {
      phase: "scheduled_run",
      reportId: schedule.reportId,
      runId,
      rowCount: result?.rowCount ?? 0,
      recipients: schedule.recipients.length,
      dispatched,
      reasons,
      error,
      onBehalfOf: schedule.createdBy,
    },
    storePayload: true,
  });

  return {
    ...base,
    status: error ? "failed" : "succeeded",
    rowCount: result?.rowCount ?? 0,
    dispatched,
    reasons,
    error,
    runId,
  };
}

/** Every active schedule of one company whose instant has passed. */
export async function runDueSchedules(
  db: Db,
  config: Config,
  companyId: string,
  now: Date,
  nextRunAt: (cadence: string, dayOfPeriod: number | null, from: Date) => string,
  limit = 50,
): Promise<{ due: number; sent: number; failed: number; runs: ScheduleRunSummary[] }> {
  const nowIso = now.toISOString();
  const due = await db
    .select()
    .from(reportSchedules)
    .where(
      and(
        eq(reportSchedules.companyId, companyId),
        eq(reportSchedules.isActive, 1),
        lte(reportSchedules.nextRunAt, nowIso),
      ),
    )
    .orderBy(asc(reportSchedules.nextRunAt))
    .limit(limit);

  const runs: ScheduleRunSummary[] = [];
  for (const schedule of due) {
    try {
      runs.push(
        await runSchedule(db, config, schedule, now, (from) =>
          nextRunAt(schedule.cadence, schedule.dayOfPeriod, from),
        ),
      );
    } catch (err) {
      // A schedule that throws outside its own error handling must not stop
      // the others: it is recorded and the loop continues.
      runs.push({
        scheduleId: schedule.id,
        reportId: schedule.reportId,
        status: "failed",
        rowCount: 0,
        recipients: schedule.recipients.length,
        dispatched: false,
        reasons: [],
        error: err instanceof Error ? err.message : String(err),
        runId: null,
      });
    }
  }
  return {
    due: due.length,
    sent: runs.filter((r) => r.dispatched).length,
    failed: runs.filter((r) => r.status === "failed").length,
    runs,
  };
}

/**
 * Register the delivery job. Fifteen minutes is the granularity: schedules fire
 * at 06:00 UTC, so a quarter-hour tick delivers within the hour without waking
 * the database every minute for a job that is usually empty.
 */
export function registerReportDelivery(
  app: FastifyInstance,
  nextRunAt: (cadence: string, dayOfPeriod: number | null, from: Date) => string,
): void {
  app.scheduler.register({
    name: "analytics.report-delivery",
    description:
      "Execute report schedules that have fallen due, render them, hand them to the mail transport and record what actually left the building",
    everyMs: 15 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) =>
      forEachCompany(db, async (companyId) => {
        const out = await runDueSchedules(
          db,
          app.appConfig,
          companyId,
          now,
          nextRunAt,
        );
        return { due: out.due, sent: out.sent, failed: out.failed };
      }),
  });
}
