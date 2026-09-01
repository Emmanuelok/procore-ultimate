/**
 * Platform job scheduler.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * Before this file, every time-driven behaviour on the platform — time-bar
 * breach detection, deemed-liability sweeps, insurance and permit expiry,
 * heartbeat seals, overdue-action escalation, invitation expiry — ran only as
 * a side effect of someone opening the page that happened to call the sweep.
 * A platform whose product is "the deadline was missed and here is the
 * record" cannot depend on a browser tab to notice the deadline.
 *
 * This is one in-process ticker that every module registers jobs with:
 *
 *     app.scheduler.register({
 *       name: "contracts.time-bars",
 *       description: "Record time-bar breaches and warn ahead of deadlines",
 *       everyMs: 15 * 60_000,
 *       run: async ({ db, now }) => sweepAll(db, now),
 *     });
 *
 * ---------------------------------------------------------------------------
 * GUARANTEES
 *
 *  • One run of a job at a time, per process (an in-process flag) AND across
 *    replicas on Postgres (a transaction-scoped advisory lock keyed on the job
 *    name; a replica that loses the race records `skipped_locked` and moves
 *    on). Under embedded PGlite there is one process, so the flag suffices.
 *  • A failing job never takes the ticker down: the error is recorded on the
 *    job's status, logged, and the next tick tries again.
 *  • Disabled under NODE_ENV=test (and by SCHEDULER_ENABLED=false) so suites
 *    are deterministic; `runNow(name)` runs a job on demand in every mode,
 *    which is what tests and the admin "run now" button use.
 *  • The timer is unref'd: a process never stays alive on account of the
 *    scheduler.
 */
import type { FastifyBaseLogger } from "fastify";
import { sql } from "drizzle-orm";
import { companies } from "@constructos/db";
import type { Db } from "./db.js";

export type SchedulerRunReason = "interval" | "manual" | "boot";

export interface SchedulerJobContext {
  db: Db;
  now: Date;
  log: FastifyBaseLogger;
  reason: SchedulerRunReason;
}

export interface SchedulerJob {
  /** Unique, dotted: "<module>.<what>" — e.g. "payments.deemed-liability". */
  name: string;
  description: string;
  /** How often the job is due. The tick granularity bounds precision. */
  everyMs: number;
  /** Run once shortly after boot instead of waiting a full interval. */
  runOnBoot?: boolean;
  /** Return value is stored (JSON-serialisable, keep it small) for the status page. */
  run: (ctx: SchedulerJobContext) => Promise<unknown>;
}

export type SchedulerJobState =
  | "idle"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped_locked";

export interface SchedulerJobStatus {
  name: string;
  description: string;
  everyMs: number;
  state: SchedulerJobState;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  lastResult: unknown;
  lastReason: SchedulerRunReason | null;
  runCount: number;
  failureCount: number;
  nextDueAt: string | null;
}

export interface SchedulerOptions {
  enabled: boolean;
  tickMs: number;
  /** true when the database is a shared Postgres (advisory locks matter). */
  postgres: boolean;
}

interface JobRecord {
  job: SchedulerJob;
  status: SchedulerJobStatus;
  running: boolean;
  /** epoch ms of the last start, used for due computation */
  lastStartMs: number | null;
  booted: boolean;
}

function summariseError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 2000);
  return String(err).slice(0, 2000);
}

export class PlatformScheduler {
  private readonly jobs = new Map<string, JobRecord>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly db: Db,
    private readonly log: FastifyBaseLogger,
    readonly options: SchedulerOptions,
  ) {}

  /** Register a job. Throws on a duplicate name so two modules cannot collide silently. */
  register(job: SchedulerJob): void {
    if (this.jobs.has(job.name)) {
      throw new Error(`Scheduler job "${job.name}" is already registered`);
    }
    if (!(job.everyMs > 0)) {
      throw new Error(`Scheduler job "${job.name}" needs a positive everyMs`);
    }
    this.jobs.set(job.name, {
      job,
      running: false,
      lastStartMs: null,
      booted: false,
      status: {
        name: job.name,
        description: job.description,
        everyMs: job.everyMs,
        state: "idle",
        lastStartedAt: null,
        lastFinishedAt: null,
        lastDurationMs: null,
        lastError: null,
        lastResult: null,
        lastReason: null,
        runCount: 0,
        failureCount: 0,
        nextDueAt: null,
      },
    });
  }

  has(name: string): boolean {
    return this.jobs.has(name);
  }

  list(): SchedulerJobStatus[] {
    return [...this.jobs.values()]
      .map((r) => ({ ...r.status, nextDueAt: this.nextDue(r) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  start(): void {
    if (this.timer || !this.options.enabled || this.options.tickMs <= 0) return;
    this.timer = setInterval(() => {
      void this.tick("interval");
    }, this.options.tickMs);
    this.timer.unref?.();
    // A first tick soon after boot so runOnBoot jobs do not wait a whole interval.
    const boot = setTimeout(() => {
      void this.tick("boot");
    }, Math.min(this.options.tickMs, 5_000));
    boot.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Run one job immediately, regardless of `enabled`. */
  async runNow(name: string, reason: SchedulerRunReason = "manual"): Promise<SchedulerJobStatus> {
    const rec = this.jobs.get(name);
    if (!rec) throw new Error(`Unknown scheduler job "${name}"`);
    await this.execute(rec, reason);
    return { ...rec.status, nextDueAt: this.nextDue(rec) };
  }

  private nextDue(rec: JobRecord): string | null {
    if (!this.options.enabled) return null;
    const base = rec.lastStartMs ?? Date.now();
    return new Date(base + rec.job.everyMs).toISOString();
  }

  private isDue(rec: JobRecord, reason: SchedulerRunReason, nowMs: number): boolean {
    if (rec.running) return false;
    if (rec.lastStartMs === null) {
      if (reason === "boot") return Boolean(rec.job.runOnBoot);
      return true;
    }
    return nowMs - rec.lastStartMs >= rec.job.everyMs;
  }

  private async tick(reason: SchedulerRunReason): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const nowMs = Date.now();
      for (const rec of this.jobs.values()) {
        if (!this.isDue(rec, reason, nowMs)) continue;
        await this.execute(rec, reason);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async execute(rec: JobRecord, reason: SchedulerRunReason): Promise<void> {
    if (rec.running) return;
    rec.running = true;
    const started = Date.now();
    rec.lastStartMs = started;
    rec.status.state = "running";
    rec.status.lastStartedAt = new Date(started).toISOString();
    rec.status.lastReason = reason;
    const ctx: SchedulerJobContext = {
      db: this.db,
      now: new Date(started),
      log: this.log.child({ job: rec.job.name }),
      reason,
    };
    try {
      let result: unknown;
      let locked = true;
      if (this.options.postgres) {
        // Hold a transaction-scoped advisory lock for the duration of the run
        // so a second replica skips instead of duplicating the work. The job
        // itself runs against the pooled `db`, not this transaction.
        await this.db.transaction(async (tx) => {
          const key = `constructos:job:${rec.job.name}`;
          const rows = await tx.execute(
            sql`select pg_try_advisory_xact_lock(hashtext(${key})) as locked`,
          );
          const row = (rows as unknown as { rows?: Array<{ locked: unknown }> }).rows?.[0] ??
            (rows as unknown as Array<{ locked: unknown }>)[0];
          locked = row?.locked === true || row?.locked === "t" || row?.locked === 1;
          if (!locked) return;
          result = await rec.job.run(ctx);
        });
      } else {
        result = await rec.job.run(ctx);
      }
      const finished = Date.now();
      rec.status.lastFinishedAt = new Date(finished).toISOString();
      rec.status.lastDurationMs = finished - started;
      if (!locked) {
        rec.status.state = "skipped_locked";
        rec.status.lastResult = null;
      } else {
        rec.status.state = "succeeded";
        rec.status.lastError = null;
        rec.status.lastResult = result === undefined ? null : result;
        rec.status.runCount += 1;
      }
    } catch (err) {
      const finished = Date.now();
      rec.status.lastFinishedAt = new Date(finished).toISOString();
      rec.status.lastDurationMs = finished - started;
      rec.status.state = "failed";
      rec.status.lastError = summariseError(err);
      rec.status.failureCount += 1;
      rec.status.runCount += 1;
      ctx.log.error({ err: rec.status.lastError }, "scheduled job failed");
    } finally {
      rec.running = false;
    }
  }
}

/**
 * Iterate every tenant — the shape almost every sweep wants. Errors in one
 * company are recorded and do not stop the others; the summary is returned
 * for the job's status.
 */
export async function forEachCompany(
  db: Db,
  fn: (companyId: string) => Promise<unknown>,
): Promise<{ companies: number; failed: Array<{ companyId: string; error: string }> }> {
  const rows = await db.select({ id: companies.id }).from(companies);
  const failed: Array<{ companyId: string; error: string }> = [];
  for (const row of rows) {
    try {
      await fn(row.id);
    } catch (err) {
      failed.push({ companyId: row.id, error: summariseError(err) });
    }
  }
  return { companies: rows.length, failed };
}
