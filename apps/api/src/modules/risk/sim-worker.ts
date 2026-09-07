/**
 * Monte Carlo worker thread entry (spec Vol II Domain H #464, #475-476).
 *
 * Receives a fully-resolved simulation payload — no database handle, no
 * request context, just numbers — runs it in batches through
 * `simulation.ts`, streams `{ type: "progress" }` messages back to the
 * parent after each batch and finishes with `{ type: "done" }` or
 * `{ type: "error" }`.
 *
 * The parent (`runner.ts`) only reaches for this file when the API is
 * running from compiled JavaScript; under tsx and vitest the identical
 * functions run inline on a yielded event loop instead. Both paths call the
 * same `runQcraBatched` / `runQsraBatched`, so there is one implementation
 * of the mathematics and the tested path is the one that always works.
 */
import { parentPort, workerData } from "node:worker_threads";
import { runQcraBatched, runQsraBatched } from "./simulation.js";
import type { SimulationWorkerRequest, SimulationWorkerResponse } from "./runner-types.js";

async function main(): Promise<void> {
  const port = parentPort;
  if (!port) return;
  const req = workerData as SimulationWorkerRequest;
  const post = (msg: SimulationWorkerResponse): void => port.postMessage(msg);
  try {
    if (req.kind === "qcra") {
      const run = await runQcraBatched(req.risks, {
        iterations: req.iterations,
        seed: req.seed,
        batchSize: req.batchSize,
        onBatch: (done, total, series) =>
          post({ type: "progress", done, total, convergence: series }),
      });
      post({
        type: "done",
        kind: "qcra",
        result: run.result,
        convergence: run.convergence,
        converged: run.converged,
        iterationsRun: run.iterationsRun,
      });
      return;
    }
    const run = await runQsraBatched(req.tasks, req.deps, {
      projectStart: req.projectStart,
      iterations: req.iterations,
      seed: req.seed,
      batchSize: req.batchSize,
      onBatch: (done, total, series) => post({ type: "progress", done, total, convergence: series }),
    });
    post({
      type: "done",
      kind: "qsra",
      result: run.result,
      convergence: run.convergence,
      converged: run.converged,
      iterationsRun: run.iterationsRun,
    });
  } catch (err) {
    post({
      type: "error",
      message: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
  }
}

void main();
