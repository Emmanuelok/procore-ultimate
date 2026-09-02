/**
 * Scheduled agent runs (plan §6.1).
 *
 * A monitor that only runs when someone opens a page is not a monitor. Every
 * schedulable agent can be put on a clock per company (and per project), and
 * one platform scheduler job drains what is due.
 *
 * Rules this file enforces:
 *   · A scheduled run has NO human actor: it is ledgered with actorId null
 *     and recorded on the run with source "schedule" and the schedule's id.
 *   · A schedule whose agent is disabled by policy, or whose tenant has no
 *     API key, is SKIPPED with the reason recorded — never failed, and never
 *     silently retried in a hot loop.
 *   · Due-ness is computed from `nextRunAt`, which is set forward before the
 *     run starts, so a long run cannot be started twice by two ticks.
 */
import type { FastifyInstance } from "fastify";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { agentSchedules } from "@constructos/db";
import { forEachCompany } from "../../lib/scheduler.js";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import type { Db } from "../../lib/db.js";
import { supersedeStale } from "./actions.js";
import { getAgentDefinition } from "./registry.js";
import { loadEffectivePolicy } from "./policy.js";
import { executeAgent } from "./runner.js";
import { aiEnabled } from "./service.js";

export type ScheduleRow = typeof agentSchedules.$inferSelect;

/** Pure: when should a schedule next run, given when it just ran? */
export function nextRunAt(from: Date, everyMinutes: number): string {
  const minutes = Math.max(15, Math.min(everyMinutes, 60 * 24 * 30));
  return new Date(from.getTime() + minutes * 60_000).toISOString();
}

/** Pure: is this schedule due at `now`? */
export function isDue(row: Pick<ScheduleRow, "enabled" | "nextRunAt">, now: Date): boolean {
  if (row.enabled !== 1) return false;
  if (!row.nextRunAt) return true;
  return Date.parse(row.nextRunAt) <= now.getTime();
}

export async function listSchedules(
  db: Db,
  companyId: string,
  projectId?: string | null,
): Promise<ScheduleRow[]> {
  return db
    .select()
    .from(agentSchedules)
    .where(
      and(
        eq(agentSchedules.companyId, companyId),
        projectId ? eq(agentSchedules.projectId, projectId) : undefined,
      ),
    )
    .orderBy(asc(agentSchedules.agentKind));
}

export async function createSchedule(
  db: Db,
  args: {
    companyId: string;
    projectId: string | null;
    agentKind: string;
    name: string | null;
    everyMinutes: number;
    params: Record<string, unknown>;
    enabled: boolean;
    createdBy: string;
    now: Date;
  },
): Promise<ScheduleRow> {
  const id = newId("asch");
  await db.insert(agentSchedules).values({
    id,
    companyId: args.companyId,
    projectId: args.projectId,
    agentKind: args.agentKind,
    name: args.name,
    enabled: args.enabled ? 1 : 0,
    everyMinutes: args.everyMinutes,
    params: args.params,
    // First run at the next interval boundary, not immediately: creating a
    // schedule should not fire a paid model call as a side effect.
    nextRunAt: nextRunAt(args.now, args.everyMinutes),
    createdBy: args.createdBy,
  });
  const [row] = await db.select().from(agentSchedules).where(eq(agentSchedules.id, id)).limit(1);
  return row!;
}

export interface ScheduleOutcome {
  scheduleId: string;
  agentKind: string;
  status: "done" | "failed" | "skipped";
  detail: string;
  runId: string | null;
  proposals: number;
}

/**
 * Run one schedule now. Never throws: a failing schedule records its error
 * and the next tick tries again, exactly like the platform scheduler's own
 * contract.
 */
export async function runSchedule(
  app: FastifyInstance,
  row: ScheduleRow,
  now: Date,
): Promise<ScheduleOutcome> {
  const base = { scheduleId: row.id, agentKind: row.agentKind };
  const finish = async (
    status: ScheduleOutcome["status"],
    detail: string,
    runId: string | null,
    proposals: number,
  ): Promise<ScheduleOutcome> => {
    await app.db
      .update(agentSchedules)
      .set({
        lastRunAt: now.toISOString(),
        nextRunAt: nextRunAt(now, row.everyMinutes),
        lastStatus: status,
        lastError: status === "failed" ? detail.slice(0, 2000) : null,
        lastRunId: runId,
        runCount: sql`${agentSchedules.runCount} + 1`,
        failureCount:
          status === "failed"
            ? sql`${agentSchedules.failureCount} + 1`
            : sql`${agentSchedules.failureCount}`,
        updatedAt: now.toISOString(),
      })
      .where(eq(agentSchedules.id, row.id));
    return { ...base, status, detail, runId, proposals };
  };

  const def = getAgentDefinition(row.agentKind);
  if (!def) return finish("skipped", `No runnable agent named "${row.agentKind}"`, null, 0);
  if (!aiEnabled(app)) {
    return finish("skipped", "AI is disabled: ANTHROPIC_API_KEY is not set", null, 0);
  }
  const policy = await loadEffectivePolicy(app, row.companyId, row.agentKind);
  if (!policy.enabled) {
    return finish("skipped", `Policy disables the "${row.agentKind}" agent for this company`, null, 0);
  }

  try {
    const result = await executeAgent({
      app,
      companyId: row.companyId,
      actorId: null,
      projectId: row.projectId,
      def,
      params: row.params ?? {},
      source: "schedule",
      sourceRef: row.id,
      now,
    });
    if (result.skipped) return finish("skipped", result.summary, null, 0);
    await appendLedger(app.db, {
      companyId: row.companyId,
      actorId: null,
      action: "create",
      objectType: "agent_run",
      objectId: result.runId!,
      payload: {
        agentKind: row.agentKind,
        scheduleId: row.id,
        proposals: result.proposals,
        signals: result.signals,
        source: "schedule",
      },
      projectId: row.projectId,
    });
    return finish("done", result.summary, result.runId, result.proposals);
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return finish("failed", message, null, 0);
  }
}

/** Drain every schedule that is due for one company. */
export async function runDueSchedules(
  app: FastifyInstance,
  companyId: string,
  now: Date,
  limit = 20,
): Promise<ScheduleOutcome[]> {
  const due = await app.db
    .select()
    .from(agentSchedules)
    .where(
      and(
        eq(agentSchedules.companyId, companyId),
        eq(agentSchedules.enabled, 1),
        or(isNull(agentSchedules.nextRunAt), lte(agentSchedules.nextRunAt, now.toISOString())),
      ),
    )
    .orderBy(asc(agentSchedules.nextRunAt))
    .limit(limit);
  const out: ScheduleOutcome[] = [];
  for (const row of due) out.push(await runSchedule(app, row, now));
  return out;
}

/** Days after which an undecided proposal is treated as stale. */
export const STALE_REVIEW_DAYS = 14;

export function staleCutoff(now: Date, days = STALE_REVIEW_DAYS): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

/** Register both jobs. Called once by the module. */
export function registerAgentJobs(app: FastifyInstance): void {
  app.scheduler.register({
    name: "ai.agent-schedules",
    description: "Run every agent schedule that is due (monitors on a clock, system actor)",
    everyMs: 5 * 60_000,
    run: async ({ db, now }) =>
      forEachCompany(db, async (companyId) => {
        const outcomes = await runDueSchedules(app, companyId, now);
        return outcomes.length === 0 ? null : outcomes;
      }),
  });

  app.scheduler.register({
    name: "ai.review-stale",
    description:
      "Supersede review-queue proposals nobody decided within the staleness window, so 'pending' keeps meaning 'act on this'",
    everyMs: 6 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) =>
      forEachCompany(db, async (companyId) => {
        const ids = await supersedeStale(
          db,
          companyId,
          staleCutoff(now),
          now.toISOString(),
        );
        for (const id of ids) {
          await appendLedger(db, {
            companyId,
            actorId: null,
            action: "state_change",
            objectType: "ai_review",
            objectId: id,
            payload: { status: "superseded", reason: `undecided for ${STALE_REVIEW_DAYS} days` },
          });
        }
        return ids.length === 0 ? null : { superseded: ids.length };
      }),
  });
}
