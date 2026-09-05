/**
 * Simulation job runner (spec Vol II Domain H #464, #475-476).
 *
 * WHAT IT FIXES
 * `runQcra`/`runQsra` used to execute inside the request handler. A 5,000
 * iteration QSRA over a 2,000-task programme is seconds of blocked event
 * loop, and two people clicking "Run simulation" serialised the whole API
 * for every tenant on the process. Now a request only WRITES A JOB ROW; the
 * arithmetic happens here, off the request path, in batches, with the event
 * loop released between each one.
 *
 * TWO EXECUTION PATHS, ONE IMPLEMENTATION
 *  - worker: when the API runs from compiled JavaScript, the payload goes to
 *    a `worker_threads` worker so the arithmetic leaves the main thread
 *    entirely. Worker startup failure is not fatal — it falls back.
 *  - inline: under tsx and vitest (and after any worker failure) the same
 *    `runQcraBatched`/`runQsraBatched` run here, awaiting `setImmediate`
 *    between batches so other requests still get served.
 * Both call the same functions in `simulation.ts`, so there is exactly one
 * copy of the mathematics and the path the tests exercise is the one that
 * always works.
 *
 * CONCURRENCY
 * One job at a time per process, FIFO. A queue means a burst of clicks
 * costs queue depth, not memory: the alternative — N simultaneous 10-million
 * sample arrays — is how the process gets OOM-killed.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { riskSimulations, simulationJobs } from "@constructos/db";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../../lib/db.js";
import { runQcraBatched, runQsraBatched, type ConvergencePoint } from "./simulation.js";
import type {
  SimulationOutcome,
  SimulationWorkerRequest,
  SimulationWorkerResponse,
} from "./runner-types.js";
import type { QcraRiskInput, QsraTaskInput } from "../../lib/montecarlo.js";
import type { CpmDependencyInput } from "../../lib/cpm.js";

/** Iterations per batch. Small enough that a batch is milliseconds. */
export const RUNNER_BATCH_SIZE = 500;
/** Hard ceiling on a single worker run before it is abandoned. */
const WORKER_TIMEOUT_MS = 5 * 60_000;

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Stored `params` on a job row, written when the request is accepted. */
export interface QcraJobParams {
  kind: "qcra";
  risks: QcraRiskInput[];
  riskIds: string[];
}

export interface QsraJobParams {
  kind: "qsra";
  scheduleId: string;
  projectStart: string;
  tasks: QsraTaskInput[];
  deps: CpmDependencyInput[];
  distributionSources: Record<string, string>;
}

export type SimulationJobParams = QcraJobParams | QsraJobParams;

/**
 * Run one simulation payload. Exported so tests can drive the arithmetic
 * without a job row, and so the worker and inline paths stay symmetrical.
 */
export async function executeSimulation(
  params: SimulationJobParams,
  options: {
    iterations: number;
    seed: number;
    batchSize?: number;
    onProgress?: (done: number, total: number, series: ConvergencePoint[]) => Promise<void> | void;
    preferWorker?: boolean;
    log?: FastifyBaseLogger;
  },
): Promise<SimulationOutcome> {
  const batchSize = options.batchSize ?? RUNNER_BATCH_SIZE;
  const request: SimulationWorkerRequest =
    params.kind === "qcra"
      ? { kind: "qcra", risks: params.risks, iterations: options.iterations, seed: options.seed, batchSize }
      : {
          kind: "qsra",
          tasks: params.tasks,
          deps: params.deps,
          projectStart: params.projectStart,
          iterations: options.iterations,
          seed: options.seed,
          batchSize,
        };

  if (options.preferWorker ?? workerAvailable()) {
    try {
      return await runInWorker(request, options.onProgress);
    } catch (err) {
      options.log?.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "simulation worker unavailable — falling back to the inline batched runner",
      );
    }
  }

  if (request.kind === "qcra") {
    const run = await runQcraBatched(request.risks, {
      iterations: request.iterations,
      seed: request.seed,
      batchSize,
      onBatch: async (done, total, series) => {
        await options.onProgress?.(done, total, series);
        await yieldToEventLoop();
      },
    });
    return { kind: "qcra", ...run, executor: "inline" };
  }
  const run = await runQsraBatched(request.tasks, request.deps, {
    projectStart: request.projectStart,
    iterations: request.iterations,
    seed: request.seed,
    batchSize,
    onBatch: async (done, total, series) => {
      await options.onProgress?.(done, total, series);
      await yieldToEventLoop();
    },
  });
  return { kind: "qsra", ...run, executor: "inline" };
}

/**
 * Workers are only used when this module was loaded as compiled JavaScript.
 * Under tsx/vitest the sibling `sim-worker.js` does not exist, so spawning
 * one would fail on every run; the inline path is used instead and is what
 * the suite exercises.
 */
function workerAvailable(): boolean {
  if (process.env.NODE_ENV === "test") return false;
  if (process.env.SIMULATION_WORKER === "off") return false;
  return import.meta.url.endsWith(".js");
}

async function runInWorker(
  request: SimulationWorkerRequest,
  onProgress?: (done: number, total: number, series: ConvergencePoint[]) => Promise<void> | void,
): Promise<SimulationOutcome> {
  const { Worker } = await import("node:worker_threads");
  const workerUrl = new URL("./sim-worker.js", import.meta.url);
  return new Promise<SimulationOutcome>((resolve, reject) => {
    const worker = new Worker(workerUrl, { workerData: request });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`Simulation worker exceeded ${WORKER_TIMEOUT_MS}ms`));
    }, WORKER_TIMEOUT_MS);
    timer.unref?.();
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    worker.on("message", (msg: SimulationWorkerResponse) => {
      if (msg.type === "progress") {
        void onProgress?.(msg.done, msg.total, msg.convergence);
        return;
      }
      if (msg.type === "error") {
        finish(() => reject(new Error(msg.message)));
        return;
      }
      finish(() =>
        resolve({
          kind: msg.kind,
          result: msg.result,
          convergence: msg.convergence,
          converged: msg.converged,
          iterationsRun: msg.iterationsRun,
          executor: "worker",
        }),
      );
    });
    worker.on("error", (err) => finish(() => reject(err)));
    worker.on("exit", (code) => {
      if (code !== 0) finish(() => reject(new Error(`Simulation worker exited with code ${code}`)));
      else finish(() => reject(new Error("Simulation worker exited before producing a result")));
    });
  });
}

/* ------------------------------------------------------------------ */
/* Queue                                                               */
/* ------------------------------------------------------------------ */

export interface SimulationQueueOptions {
  db: Db;
  log: FastifyBaseLogger;
  newId: (prefix: string) => string;
  /** how a completed run becomes a persisted riskSimulations row */
  onComplete?: (ctx: {
    job: typeof simulationJobs.$inferSelect;
    outcome: SimulationOutcome;
    simulationId: string;
  }) => Promise<void>;
}

/**
 * In-process FIFO queue over the `simulation_jobs` table. The table is the
 * source of truth — a restart mid-run leaves a `running` row, which
 * `requeueStale` moves back to `queued` on boot rather than stranding it.
 */
export class SimulationQueue {
  private draining = false;
  private closed = false;

  constructor(private readonly opts: SimulationQueueOptions) {}

  /** Kick the queue. Never throws into the caller — jobs record their own failure. */
  schedule(): void {
    if (this.closed) return;
    setImmediate(() => {
      void this.drain().catch((err) => {
        this.opts.log.error({ err: String(err) }, "simulation queue drain failed");
      });
    });
  }

  close(): void {
    this.closed = true;
  }

  /** Run every queued job, oldest first. Safe to call concurrently. */
  async drain(): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    let ran = 0;
    try {
      for (;;) {
        if (this.closed) break;
        const next = (
          await this.opts.db
            .select()
            .from(simulationJobs)
            .where(eq(simulationJobs.status, "queued"))
            .orderBy(asc(simulationJobs.createdAt), asc(simulationJobs.id))
            .limit(1)
        )[0];
        if (!next) break;
        // Claim it: only one worker may move queued → running.
        const claimed = await this.opts.db
          .update(simulationJobs)
          .set({ status: "running", startedAt: new Date().toISOString() })
          .where(and(eq(simulationJobs.id, next.id), eq(simulationJobs.status, "queued")))
          .returning({ id: simulationJobs.id });
        if (claimed.length === 0) continue;
        await this.runJob({ ...next, status: "running" });
        ran += 1;
      }
    } finally {
      this.draining = false;
    }
    return ran;
  }

  /**
   * Claim and run ONE named job, awaited. This is the synchronous request
   * path: the caller still gets its result, but the arithmetic runs in
   * batches with the event loop released between them instead of blocking
   * the process for the whole run. Returns false when the job was already
   * claimed by the drain loop.
   */
  async runById(jobId: string): Promise<boolean> {
    const rows = await this.opts.db
      .select()
      .from(simulationJobs)
      .where(eq(simulationJobs.id, jobId))
      .limit(1);
    const job = rows[0];
    if (!job || job.status !== "queued") return false;
    const claimed = await this.opts.db
      .update(simulationJobs)
      .set({ status: "running", startedAt: new Date().toISOString() })
      .where(and(eq(simulationJobs.id, jobId), eq(simulationJobs.status, "queued")))
      .returning({ id: simulationJobs.id });
    if (claimed.length === 0) return false;
    await this.runJob({ ...job, status: "running" });
    return true;
  }

  /** Move jobs left `running` by a crashed process back into the queue. */
  async requeueStale(): Promise<number> {
    const rows = await this.opts.db
      .update(simulationJobs)
      .set({ status: "queued", startedAt: null })
      .where(inArray(simulationJobs.status, ["running"]))
      .returning({ id: simulationJobs.id });
    return rows.length;
  }

  private async runJob(job: typeof simulationJobs.$inferSelect): Promise<void> {
    const db = this.opts.db;
    try {
      const params = job.params as unknown as SimulationJobParams;
      let lastPersist = 0;
      const outcome = await executeSimulation(params, {
        iterations: job.iterations,
        seed: job.seed,
        log: this.opts.log,
        onProgress: async (done, _total, series) => {
          // Persist at most every 4 batches: progress is for a spinner, not
          // a ledger, and a write per batch would dominate the run.
          if (done - lastPersist < RUNNER_BATCH_SIZE * 4 && done < job.iterations) return;
          lastPersist = done;
          await db
            .update(simulationJobs)
            .set({ iterationsDone: done, convergence: series as unknown as unknown[] })
            .where(eq(simulationJobs.id, job.id));
        },
      });

      const simulationId = this.opts.newId("sim");
      await db.insert(riskSimulations).values({
        id: simulationId,
        companyId: job.companyId,
        projectId: job.projectId,
        kind: job.kind,
        seed: job.seed,
        iterations: outcome.iterationsRun,
        inputs: job.params as unknown as Record<string, unknown>,
        results: {
          ...(outcome.result as unknown as Record<string, unknown>),
          convergence: outcome.convergence,
          converged: outcome.converged,
        },
        runBy: job.requestedBy,
      });
      await this.opts.onComplete?.({ job, outcome, simulationId });
      await db
        .update(simulationJobs)
        .set({
          status: "done",
          simulationId,
          iterationsDone: outcome.iterationsRun,
          convergence: outcome.convergence as unknown as unknown[],
          converged: outcome.converged ? 1 : 0,
          finishedAt: new Date().toISOString(),
          error: null,
        })
        .where(eq(simulationJobs.id, job.id));
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      this.opts.log.error({ err: message, jobId: job.id }, "simulation job failed");
      await db
        .update(simulationJobs)
        .set({ status: "failed", error: message.slice(0, 2000), finishedAt: new Date().toISOString() })
        .where(eq(simulationJobs.id, job.id));
    }
  }
}
