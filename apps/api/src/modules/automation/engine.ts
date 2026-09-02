/**
 * The automation engine (Vol I #79–92 workflow automation, #85–86 escalation,
 * Vol II X #1005–1009 automation hooks).
 *
 * HOW A RULE FIRES
 *  · event rules: `onLedgerEvent` is subscribed to the ledger append path via
 *    `addLedgerEmitHook`. It costs ONE indexed select on automation_rules for
 *    every ledger entry on the platform, and returns immediately for the
 *    tenants that have no matching rule. When rules match, the record snapshot
 *    is loaded once (to resolve the project and give conditions something to
 *    read), a run row is enqueued per rule, and rules marked `immediate`
 *    execute synchronously — bounded, and guarded by try/catch so nothing here
 *    can ever fail the business write that produced the event.
 *  · schedule rules: `scanSchedules` runs from the scheduler job
 *    `automation.schedules`. For each due rule it lists the company's live
 *    records of the trigger type (bounded by SCAN_LIMIT), evaluates conditions
 *    BEFORE creating a run so a daily scan over 500 open RFIs does not leave
 *    500 "skipped" rows, dedupes against runs inside the cooldown window, and
 *    executes the matches.
 *  · queued (non-immediate) runs are executed by the `automation.drain` job.
 *
 * LOOP GUARD
 *  · Ledger entries whose objectType starts with "automation_" are ignored.
 *  · Every record an executor writes is registered in an origin map before its
 *    ledger append. When that append fires the hook, the rule that caused it
 *    is skipped (a rule may not trigger itself), other rules fire with
 *    depth+1, and nothing fires past MAX_CHAIN_DEPTH.
 *  · A per-company rate limit (actions per minute, from
 *    AUTOMATION_MAX_ACTIONS_PER_MINUTE) defers a run rather than dropping it;
 *    after MAX_ATTEMPTS deferrals it is marked `throttled` for an operator.
 *
 * WHAT IT DOES NOT DO
 * It does not evaluate expressions (predicates.ts), it does not know how to
 * find records (snapshots.ts), and it never calls a model (run_agent queues
 * a review item). Everything it writes to the ledger carries actorId null.
 */
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  automationRules,
  automationRuns,
  insuranceCertificates,
  type AutomationActionResult,
  type AutomationConditionJson,
  type AutomationRunContext,
} from "@constructos/db";
import type { Db } from "../../lib/db.js";
import { newId } from "../../lib/ids.js";
import { appendLedger, type LedgerEvent } from "../../lib/ledger.js";
import {
  createFetchClient,
  describeAction,
  executeAction,
  windowStart,
  type AutomationHttpClient,
  type ExecutorDeps,
  type RunFacts,
} from "./actions.js";
import { evaluateCondition, referencedFields, type EvaluationContext } from "./predicates.js";
import { loadSnapshot, scanCandidates, snapshotEntry, type LoadedSnapshot } from "./snapshots.js";

export type RuleRow = typeof automationRules.$inferSelect;
export type RunRow = typeof automationRuns.$inferSelect;

export interface EngineOptions {
  maxActionsPerMinute: number;
  maxChainDepth: number;
  maxAttempts: number;
  drainBatch: number;
  requestTimeoutMs: number;
  responseBodyLimit: number;
  /** origin entries older than this are forgotten */
  originTtlMs: number;
  webhookSigningSecret: string;
  now: () => Date;
}

function intFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function defaultEngineOptions(
  env: NodeJS.ProcessEnv,
  authSecret: string,
): EngineOptions {
  return {
    maxActionsPerMinute: Math.max(1, intFromEnv(env, "AUTOMATION_MAX_ACTIONS_PER_MINUTE", 120)),
    maxChainDepth: Math.max(0, intFromEnv(env, "AUTOMATION_MAX_CHAIN_DEPTH", 3)),
    maxAttempts: Math.max(1, intFromEnv(env, "AUTOMATION_MAX_ATTEMPTS", 5)),
    drainBatch: Math.max(1, intFromEnv(env, "AUTOMATION_DRAIN_BATCH", 50)),
    requestTimeoutMs: intFromEnv(env, "AUTOMATION_WEBHOOK_TIMEOUT_MS", 10_000),
    responseBodyLimit: intFromEnv(env, "AUTOMATION_RESPONSE_BODY_LIMIT", 2_048),
    originTtlMs: 5 * 60_000,
    webhookSigningSecret: env["AUTOMATION_WEBHOOK_SECRET"] ?? authSecret,
    now: () => new Date(),
  };
}

export interface EngineHealth {
  eventsSeen: number;
  eventsMatched: number;
  runsEnqueued: number;
  runsExecuted: number;
  runsFailed: number;
  runsThrottled: number;
  hookFailures: number;
  lastError: string | null;
  lastErrorAt: string | null;
}

export interface DrainSummary {
  executed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  deferred: number;
  throttled: number;
}

export interface ScanSummary {
  rulesScanned: number;
  candidates: number;
  matched: number;
  deduped: number;
  executed: number;
}

interface Origin {
  runId: string;
  ruleId: string;
  depth: number;
  at: number;
}

export interface EngineLogger {
  error: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
}

const AUTOMATION_PREFIX = "automation_";

export class AutomationEngine {
  private http: AutomationHttpClient;
  private readonly origins = new Map<string, Origin>();
  private draining = false;
  private readonly health: EngineHealth = {
    eventsSeen: 0,
    eventsMatched: 0,
    runsEnqueued: 0,
    runsExecuted: 0,
    runsFailed: 0,
    runsThrottled: 0,
    hookFailures: 0,
    lastError: null,
    lastErrorAt: null,
  };

  constructor(
    private readonly db: Db,
    public options: EngineOptions,
    private readonly logger: EngineLogger = { error: () => {} },
    http?: AutomationHttpClient,
  ) {
    this.http = http ?? createFetchClient(options.requestTimeoutMs, options.responseBodyLimit);
  }

  setHttpClient(client: AutomationHttpClient): void {
    this.http = client;
  }

  configure(partial: Partial<EngineOptions>): void {
    this.options = { ...this.options, ...partial };
  }

  getHealth(): EngineHealth {
    return { ...this.health };
  }

  private recordError(err: unknown, where: string): void {
    const message = `${where}: ${err instanceof Error ? err.message : String(err)}`;
    this.health.lastError = message.slice(0, 1000);
    this.health.lastErrorAt = this.options.now().toISOString();
    this.logger.error({ err: message }, "automation engine error");
  }

  /* ---------------------------------------------------------------- */
  /* Origin map (loop guard)                                           */
  /* ---------------------------------------------------------------- */

  private originKey(objectType: string, objectId: string): string {
    return `${objectType}:${objectId}`;
  }

  markOrigin(objectType: string, objectId: string, run: { id: string; ruleId: string; depth: number }): void {
    const now = this.options.now().getTime();
    if (this.origins.size > 5_000) this.pruneOrigins(now);
    this.origins.set(this.originKey(objectType, objectId), {
      runId: run.id,
      ruleId: run.ruleId,
      depth: run.depth,
      at: now,
    });
  }

  private pruneOrigins(nowMs: number): void {
    for (const [k, v] of this.origins) {
      if (nowMs - v.at > this.options.originTtlMs) this.origins.delete(k);
    }
  }

  private originOf(objectType: string, objectId: string): Origin | null {
    const o = this.origins.get(this.originKey(objectType, objectId));
    if (!o) return null;
    if (this.options.now().getTime() - o.at > this.options.originTtlMs) {
      this.origins.delete(this.originKey(objectType, objectId));
      return null;
    }
    return o;
  }

  /* ---------------------------------------------------------------- */
  /* Event path                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * The ledger hook. NEVER THROWS — a rule engine's bookkeeping must not
   * weaken appendLedger's contract with the business write that fired it.
   * Returns the number of runs enqueued.
   */
  async onLedgerEvent(event: LedgerEvent): Promise<number> {
    this.health.eventsSeen += 1;
    if (event.objectType.startsWith(AUTOMATION_PREFIX)) return 0;
    try {
      const rules = await this.db
        .select()
        .from(automationRules)
        .where(
          and(
            eq(automationRules.companyId, event.companyId),
            eq(automationRules.status, "active"),
            eq(automationRules.triggerKind, "event"),
            inArray(automationRules.triggerObjectType, [event.objectType, "*"]),
            inArray(automationRules.triggerAction, [event.action, "*"]),
          ),
        )
        .orderBy(asc(automationRules.priority), asc(automationRules.createdAt));
      if (rules.length === 0) return 0;
      this.health.eventsMatched += 1;

      const origin = this.originOf(event.objectType, event.objectId);
      const snapshot = await loadSnapshot(this.db, event.companyId, event.objectType, event.objectId);
      const projectId = event.projectId ?? snapshot?.projectId ?? null;
      const context: AutomationRunContext = {
        event: {
          seq: event.seq,
          action: event.action,
          objectType: event.objectType,
          objectId: event.objectId,
          actorId: event.actorId,
          at: event.at,
        },
        record: snapshot?.record ?? null,
        recordKnown: snapshotEntry(event.objectType) !== undefined,
      };

      let enqueued = 0;
      for (const rule of rules) {
        if (rule.projectId && rule.projectId !== projectId) continue;
        if (origin) {
          if (origin.ruleId === rule.id) continue; // a rule may not trigger itself
          if (origin.depth + 1 > this.options.maxChainDepth) continue;
        }
        const run = await this.enqueue(rule, {
          projectId,
          eventSeq: event.seq,
          objectType: event.objectType,
          objectId: event.objectId,
          action: event.action,
          actorId: event.actorId,
          context,
          causedByRunId: origin?.runId ?? null,
          depth: origin ? origin.depth + 1 : 0,
        });
        enqueued += 1;
        if (rule.immediate === 1) {
          try {
            await this.executeRun(run.id);
          } catch (err) {
            this.recordError(err, `immediate run ${run.id}`);
          }
        }
      }
      return enqueued;
    } catch (err) {
      this.health.hookFailures += 1;
      this.recordError(err, "ledger hook");
      return 0;
    }
  }

  private async enqueue(
    rule: RuleRow,
    input: {
      projectId: string | null;
      eventSeq: number | null;
      objectType: string;
      objectId: string;
      action: string;
      actorId: string | null;
      context: AutomationRunContext;
      causedByRunId: string | null;
      depth: number;
      dryRun?: boolean;
    },
  ): Promise<RunRow> {
    const id = newId("arun");
    const now = this.options.now().toISOString();
    const row: typeof automationRuns.$inferInsert = {
      id,
      companyId: rule.companyId,
      projectId: input.projectId,
      ruleId: rule.id,
      ruleName: rule.name,
      triggerKind: rule.triggerKind,
      eventSeq: input.eventSeq,
      objectType: input.objectType,
      objectId: input.objectId,
      action: input.action,
      status: input.dryRun ? "dry_run" : "queued",
      dryRun: input.dryRun ? 1 : 0,
      causedByRunId: input.causedByRunId,
      depth: input.depth,
      context: input.context,
      actorId: input.actorId,
      queuedAt: now,
    };
    const inserted = await this.db.insert(automationRuns).values(row).returning();
    this.health.runsEnqueued += 1;
    return inserted[0]!;
  }

  /* ---------------------------------------------------------------- */
  /* Context                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Derived facts a rule may reference under `derived.*`. Computed only when
   * the rule's conditions mention them, so the common path costs nothing.
   *   derived.vendorInsuranceValid — the record's vendorId has at least one
   *   active insurance certificate valid today (for this company).
   */
  private async deriveFacts(
    companyId: string,
    record: Record<string, unknown> | null,
    conditions: AutomationConditionJson | null,
    now: Date,
  ): Promise<Record<string, unknown>> {
    const derived: Record<string, unknown> = {};
    const refs = referencedFields(conditions);
    if (!refs.some((f) => f.startsWith("derived."))) return derived;
    const vendorId = record?.["vendorId"] ?? record?.["raisedAgainstVendorId"];
    if (refs.includes("derived.vendorInsuranceValid")) {
      if (typeof vendorId !== "string" || !vendorId) {
        derived["vendorInsuranceValid"] = null;
      } else {
        const today = now.toISOString().slice(0, 10);
        const rows = await this.db
          .select({ id: insuranceCertificates.id })
          .from(insuranceCertificates)
          .where(
            and(
              eq(insuranceCertificates.companyId, companyId),
              eq(insuranceCertificates.vendorId, vendorId),
              eq(insuranceCertificates.status, "active"),
              lte(insuranceCertificates.validFrom, today),
              gte(insuranceCertificates.validTo, today),
            ),
          )
          .limit(1);
        derived["vendorInsuranceValid"] = rows.length > 0;
      }
    }
    return derived;
  }

  private buildContext(
    run: Pick<RunRow, "context" | "objectType" | "objectId" | "action" | "actorId">,
    snapshot: LoadedSnapshot | null,
    derived: Record<string, unknown>,
    now: Date,
  ): EvaluationContext {
    const stored = run.context;
    return {
      event: stored?.event ?? {
        seq: null,
        action: run.action,
        objectType: run.objectType,
        objectId: run.objectId,
        actorId: run.actorId,
        at: now.toISOString(),
      },
      record: snapshot?.record ?? stored?.record ?? null,
      derived,
      now: now.toISOString(),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Execution                                                         */
  /* ---------------------------------------------------------------- */

  private async actionsInWindow(companyId: string, now: Date): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`coalesce(sum(${automationRuns.actionCount}), 0)` })
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.companyId, companyId),
          gte(automationRuns.startedAt, windowStart(now, 60_000)),
        ),
      );
    return Number(rows[0]?.n ?? 0);
  }

  /** Execute one queued run to completion. Returns the final row. */
  async executeRun(runId: string): Promise<RunRow> {
    const [run] = await this.db.select().from(automationRuns).where(eq(automationRuns.id, runId)).limit(1);
    if (!run) throw new Error(`automation run ${runId} not found`);
    if (run.status !== "queued") return run;
    const [rule] = await this.db
      .select()
      .from(automationRules)
      .where(and(eq(automationRules.id, run.ruleId), eq(automationRules.companyId, run.companyId)))
      .limit(1);
    const now = this.options.now();
    const nowIso = now.toISOString();

    if (!rule || rule.status !== "active") {
      const [row] = await this.db
        .update(automationRuns)
        .set({
          status: "skipped",
          startedAt: nowIso,
          finishedAt: nowIso,
          attempts: run.attempts + 1,
          error: rule ? `rule is ${rule.status}` : "rule no longer exists",
        })
        .where(eq(automationRuns.id, run.id))
        .returning();
      return row!;
    }

    // Rate limit: defer, never drop. The count includes this run's own actions.
    const actionTotal = rule.actions.length;
    const used = await this.actionsInWindow(run.companyId, now);
    if (actionTotal > 0 && used + actionTotal > this.options.maxActionsPerMinute) {
      const attempts = run.attempts + 1;
      const exhausted = attempts >= this.options.maxAttempts;
      const [row] = await this.db
        .update(automationRuns)
        .set(
          exhausted
            ? {
                status: "throttled",
                attempts,
                finishedAt: nowIso,
                error: `Rate limit: ${used} action(s) already executed in the last minute for this company (limit ${this.options.maxActionsPerMinute}); deferred ${attempts} times. Retry manually.`,
              }
            : {
                attempts,
                queuedAt: new Date(now.getTime() + 60_000).toISOString(),
                error: `Rate limit: deferred (attempt ${attempts} of ${this.options.maxAttempts}); ${used} action(s) executed in the last minute, limit ${this.options.maxActionsPerMinute}.`,
              },
        )
        .where(eq(automationRuns.id, run.id))
        .returning();
      if (exhausted) this.health.runsThrottled += 1;
      return row!;
    }

    await this.db
      .update(automationRuns)
      .set({ status: "running", startedAt: nowIso, attempts: run.attempts + 1, error: null })
      .where(eq(automationRuns.id, run.id));

    const results: AutomationActionResult[] = [];
    let actionCount = 0;
    let finalStatus: "succeeded" | "failed" | "skipped" = "succeeded";
    let error: string | null = null;
    let conditionResult = run.conditionResult ?? null;
    let context: AutomationRunContext | null = run.context ?? null;

    try {
      // A fresh snapshot at execution time: a drained run should act on the
      // record as it is now, not as it was when the event fired.
      const snapshot = await loadSnapshot(this.db, run.companyId, run.objectType, run.objectId);
      const derived = await this.deriveFacts(run.companyId, snapshot?.record ?? run.context?.record ?? null, rule.conditions ?? null, now);
      const ctx = this.buildContext(run, snapshot, derived, now);
      context = {
        event: ctx.event as AutomationRunContext["event"],
        record: ctx.record,
        recordKnown: snapshotEntry(run.objectType) !== undefined,
      };
      conditionResult = evaluateCondition(rule.conditions ?? null, ctx);
      if (!conditionResult.matched) {
        finalStatus = "skipped";
      } else {
        const facts: RunFacts = {
          runId: run.id,
          ruleId: rule.id,
          ruleName: rule.name,
          companyId: run.companyId,
          projectId: run.projectId ?? snapshot?.projectId ?? null,
          objectType: run.objectType,
          objectId: run.objectId,
          actorId: run.actorId,
          recordTitle: snapshot?.title ?? run.objectId,
        };
        const deps: ExecutorDeps = {
          db: this.db,
          http: this.http,
          now: this.options.now,
          webhookSigningSecret: this.options.webhookSigningSecret,
          markOrigin: (objectType, objectId) =>
            this.markOrigin(objectType, objectId, { id: run.id, ruleId: rule.id, depth: run.depth }),
        };
        for (const [index, action] of rule.actions.entries()) {
          const started = this.options.now().getTime();
          let outcome;
          try {
            outcome = await executeAction(deps, facts, ctx, action.type, action.params ?? {});
          } catch (err) {
            outcome = {
              outcome: "failed" as const,
              detail: {},
              error: err instanceof Error ? err.message : String(err),
            };
          }
          if (outcome.outcome !== "skipped") actionCount += 1;
          results.push({
            index,
            type: action.type,
            outcome: outcome.outcome,
            detail: outcome.detail,
            error: outcome.error,
            durationMs: this.options.now().getTime() - started,
          });
        }
        const failures = results.filter((r) => r.outcome === "failed");
        if (failures.length > 0) {
          finalStatus = "failed";
          error = failures.map((f) => `${f.type}: ${f.error ?? "failed"}`).join("; ").slice(0, 1000);
        }
      }
    } catch (err) {
      finalStatus = "failed";
      error = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
      this.recordError(err, `run ${run.id}`);
    }

    const finishedAt = this.options.now().toISOString();
    const [final] = await this.db
      .update(automationRuns)
      .set({
        status: finalStatus,
        finishedAt,
        conditionResult,
        actionResults: results,
        actionCount,
        error,
        context,
      })
      .where(eq(automationRuns.id, run.id))
      .returning();

    this.health.runsExecuted += 1;
    if (finalStatus === "failed") this.health.runsFailed += 1;

    // Rule statistics — only when the rule actually did something or failed.
    if (finalStatus !== "skipped") {
      await this.db
        .update(automationRules)
        .set({
          runCount: sql`${automationRules.runCount} + 1`,
          failureCount: finalStatus === "failed" ? sql`${automationRules.failureCount} + 1` : automationRules.failureCount,
          lastRunAt: finishedAt,
          lastError: finalStatus === "failed" ? error : null,
        })
        .where(eq(automationRules.id, rule.id));
      // The run is a consequential system act; it is ledgered with the system
      // actor. Its objectType is ignored by the hook (see AUTOMATION_PREFIX).
      try {
        await appendLedger(this.db, {
          companyId: run.companyId,
          projectId: run.projectId,
          actorId: null,
          action: "create",
          objectType: "automation_run",
          objectId: run.id,
          payload: {
            ruleId: rule.id,
            status: finalStatus,
            objectType: run.objectType,
            objectId: run.objectId,
            actions: results.map((r) => ({ type: r.type, outcome: r.outcome })),
          },
        });
      } catch (err) {
        this.recordError(err, `ledger for run ${run.id}`);
      }
    }
    return final!;
  }

  /** Execute every due queued run, oldest first, up to the batch size. */
  async drain(limit = this.options.drainBatch): Promise<DrainSummary> {
    const summary: DrainSummary = { executed: 0, succeeded: 0, failed: 0, skipped: 0, deferred: 0, throttled: 0 };
    if (this.draining) return summary;
    this.draining = true;
    try {
      const nowIso = this.options.now().toISOString();
      const due = await this.db
        .select({ id: automationRuns.id })
        .from(automationRuns)
        .where(and(eq(automationRuns.status, "queued"), lte(automationRuns.queuedAt, nowIso)))
        .orderBy(asc(automationRuns.queuedAt), asc(automationRuns.id))
        .limit(limit);
      for (const { id } of due) {
        let row: RunRow;
        try {
          row = await this.executeRun(id);
        } catch (err) {
          this.recordError(err, `drain ${id}`);
          summary.failed += 1;
          continue;
        }
        summary.executed += 1;
        if (row.status === "succeeded") summary.succeeded += 1;
        else if (row.status === "failed") summary.failed += 1;
        else if (row.status === "skipped") summary.skipped += 1;
        else if (row.status === "throttled") summary.throttled += 1;
        else if (row.status === "queued") summary.deferred += 1;
      }
      return summary;
    } finally {
      this.draining = false;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Schedule path                                                     */
  /* ---------------------------------------------------------------- */

  /** Evaluate every due schedule rule for one company. Idempotent per cooldown window. */
  async scanSchedules(companyId: string, now = this.options.now(), force = false): Promise<ScanSummary> {
    const summary: ScanSummary = { rulesScanned: 0, candidates: 0, matched: 0, deduped: 0, executed: 0 };
    const rules = await this.db
      .select()
      .from(automationRules)
      .where(
        and(
          eq(automationRules.companyId, companyId),
          eq(automationRules.status, "active"),
          eq(automationRules.triggerKind, "schedule"),
        ),
      )
      .orderBy(asc(automationRules.priority));
    for (const rule of rules) {
      const everyMs = Math.max(1, rule.trigger.everyMinutes ?? 60) * 60_000;
      if (!force && rule.lastScanAt && now.getTime() - Date.parse(rule.lastScanAt) < everyMs) continue;
      summary.rulesScanned += 1;
      const cooldownMs = Math.max(1, rule.trigger.cooldownHours ?? 24) * 3_600_000;
      try {
        const candidates = await scanCandidates(this.db, companyId, rule.triggerObjectType, rule.projectId);
        summary.candidates += candidates.length;
        for (const candidate of candidates) {
          const objectId = String(candidate.record["id"] ?? "");
          if (!objectId) continue;
          const derived = await this.deriveFacts(companyId, candidate.record, rule.conditions ?? null, now);
          const ctx: EvaluationContext = {
            event: null,
            record: candidate.record,
            derived,
            now: now.toISOString(),
          };
          const verdict = evaluateCondition(rule.conditions ?? null, ctx);
          if (!verdict.matched) continue;
          summary.matched += 1;
          const recent = await this.db
            .select({ id: automationRuns.id })
            .from(automationRuns)
            .where(
              and(
                eq(automationRuns.ruleId, rule.id),
                eq(automationRuns.objectType, rule.triggerObjectType),
                eq(automationRuns.objectId, objectId),
                eq(automationRuns.dryRun, 0),
                gte(automationRuns.createdAt, windowStart(now, cooldownMs)),
              ),
            )
            .limit(1);
          if (recent[0]) {
            summary.deduped += 1;
            continue;
          }
          const run = await this.enqueue(rule, {
            projectId: candidate.projectId,
            eventSeq: null,
            objectType: rule.triggerObjectType,
            objectId,
            action: "scan",
            actorId: null,
            context: { event: null, record: candidate.record, recordKnown: true },
            causedByRunId: null,
            depth: 0,
          });
          try {
            await this.executeRun(run.id);
            summary.executed += 1;
          } catch (err) {
            this.recordError(err, `schedule run ${run.id}`);
          }
        }
      } catch (err) {
        this.recordError(err, `scan rule ${rule.id}`);
      }
      await this.db
        .update(automationRules)
        .set({ lastScanAt: now.toISOString() })
        .where(eq(automationRules.id, rule.id));
    }
    return summary;
  }

  /* ---------------------------------------------------------------- */
  /* Dry run                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Evaluate a rule (saved or unsaved) against a real record, a supplied
   * sample, or an event shape, and describe what WOULD happen. Nothing is
   * executed and nothing is ledgered; a `dry_run` row is written only when
   * `persist` is set (for a saved rule) so the operator can see it in the log.
   */
  async dryRun(
    rule: Pick<RuleRow, "id" | "companyId" | "name" | "projectId" | "conditions" | "actions" | "triggerObjectType" | "triggerKind" | "triggerAction">,
    input: { objectId?: string; record?: Record<string, unknown>; event?: { action?: string; actorId?: string | null }; persist?: boolean },
  ) {
    const now = this.options.now();
    let snapshot: LoadedSnapshot | null = null;
    let recordSource: "loaded" | "sample" | "none" = "none";
    if (input.objectId) {
      snapshot = await loadSnapshot(this.db, rule.companyId, rule.triggerObjectType, input.objectId);
      if (snapshot) recordSource = "loaded";
    }
    const record = snapshot?.record ?? input.record ?? null;
    if (!snapshot && input.record) recordSource = "sample";
    const derived = await this.deriveFacts(rule.companyId, record, rule.conditions ?? null, now);
    const objectId = input.objectId ?? String(record?.["id"] ?? "sample");
    const ctx: EvaluationContext = {
      event:
        rule.triggerKind === "event"
          ? {
              seq: null,
              action: input.event?.action ?? (rule.triggerAction === "*" ? "update" : rule.triggerAction),
              objectType: rule.triggerObjectType,
              objectId,
              actorId: input.event?.actorId ?? null,
              at: now.toISOString(),
            }
          : null,
      record,
      derived,
      now: now.toISOString(),
    };
    const conditionResult = evaluateCondition(rule.conditions ?? null, ctx);
    const plannedActions = rule.actions.map((a, index) => ({
      index,
      type: a.type,
      description: describeAction(a.type, a.params ?? {}, ctx),
      wouldRun: conditionResult.matched,
    }));
    const warnings: string[] = [];
    if (!snapshotEntry(rule.triggerObjectType)) {
      warnings.push(`"${rule.triggerObjectType}" is not in the snapshot registry: conditions on record.* will see nothing.`);
    }
    if (input.objectId && !snapshot) warnings.push(`Record ${input.objectId} was not found in this company.`);
    if (recordSource === "none" && referencedFields(rule.conditions ?? null).some((f) => f.startsWith("record."))) {
      warnings.push("No record supplied: every record.* condition evaluated against nothing.");
    }
    if (rule.projectId && snapshot && snapshot.projectId !== rule.projectId) {
      warnings.push("The record belongs to a different project than the rule; it would not fire for real.");
    }
    let runId: string | null = null;
    if (input.persist && rule.id) {
      const [ruleRow] = await this.db.select().from(automationRules).where(eq(automationRules.id, rule.id)).limit(1);
      if (ruleRow) {
        const run = await this.enqueue(ruleRow, {
          projectId: snapshot?.projectId ?? rule.projectId ?? null,
          eventSeq: null,
          objectType: rule.triggerObjectType,
          objectId,
          action: ctx.event ? String((ctx.event as { action: string }).action) : "scan",
          actorId: null,
          context: { event: ctx.event as AutomationRunContext["event"], record, recordKnown: snapshotEntry(rule.triggerObjectType) !== undefined },
          causedByRunId: null,
          depth: 0,
          dryRun: true,
        });
        await this.db
          .update(automationRuns)
          .set({
            conditionResult,
            finishedAt: now.toISOString(),
            startedAt: now.toISOString(),
            actionResults: plannedActions.map((p) => ({
              index: p.index,
              type: p.type,
              outcome: "skipped" as const,
              detail: { dryRun: true, description: p.description },
              error: null,
              durationMs: 0,
            })),
          })
          .where(eq(automationRuns.id, run.id));
        runId = run.id;
      }
    }
    return {
      matched: conditionResult.matched,
      conditionResult,
      plannedActions,
      context: { event: ctx.event, record, derived, recordSource },
      warnings,
      runId,
    };
  }

  /** Newest runs for one rule and object — the dedupe/health probes use this. */
  async recentRuns(ruleId: string, limit = 5): Promise<RunRow[]> {
    return this.db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.ruleId, ruleId))
      .orderBy(desc(automationRuns.createdAt))
      .limit(limit);
  }
}

/* ------------------------------------------------------------------ */
/* Per-database-handle registry                                        */
/* ------------------------------------------------------------------ */

const registry = new WeakMap<object, AutomationEngine>();

export function registerEngine(db: Db, engine: AutomationEngine): void {
  registry.set(db as object, engine);
}

export function getEngine(db: Db): AutomationEngine | undefined {
  return registry.get(db as object);
}
