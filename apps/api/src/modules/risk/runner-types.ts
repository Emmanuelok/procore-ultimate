/**
 * Wire types shared between the simulation runner and its worker thread.
 * Kept in their own module so the worker imports no database code.
 */
import type { QcraResult, QcraRiskInput, QsraResult, QsraTaskInput } from "../../lib/montecarlo.js";
import type { CpmDependencyInput } from "../../lib/cpm.js";
import type { ConvergencePoint } from "./simulation.js";

export interface QcraWorkerRequest {
  kind: "qcra";
  risks: QcraRiskInput[];
  iterations: number;
  seed: number;
  batchSize: number;
}

export interface QsraWorkerRequest {
  kind: "qsra";
  tasks: QsraTaskInput[];
  deps: CpmDependencyInput[];
  projectStart: string;
  iterations: number;
  seed: number;
  batchSize: number;
}

export type SimulationWorkerRequest = QcraWorkerRequest | QsraWorkerRequest;

export type SimulationWorkerResponse =
  | { type: "progress"; done: number; total: number; convergence: ConvergencePoint[] }
  | {
      type: "done";
      kind: "qcra";
      result: QcraResult;
      convergence: ConvergencePoint[];
      converged: boolean;
      iterationsRun: number;
    }
  | {
      type: "done";
      kind: "qsra";
      result: QsraResult;
      convergence: ConvergencePoint[];
      converged: boolean;
      iterationsRun: number;
    }
  | { type: "error"; message: string };

export interface SimulationOutcome {
  kind: "qcra" | "qsra";
  result: QcraResult | QsraResult;
  convergence: ConvergencePoint[];
  converged: boolean;
  iterationsRun: number;
  /** "worker" or "inline" — recorded on the job so operators can see which path ran */
  executor: "worker" | "inline";
}
