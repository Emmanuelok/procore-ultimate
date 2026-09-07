/**
 * Asynchronous Monte Carlo jobs, convergence and risk-adjusted forecasts
 * (spec Vol II Domain H #464, #475-476).
 *
 * A 20,000-iteration QCRA or a 5,000-pass QSRA over a real programme is not
 * a request/response operation. Queued runs execute off the request path in
 * batches; this panel polls the job, shows the running P50/P80 after each
 * batch so "were enough iterations run?" is answered with evidence, and
 * surfaces the risk-adjusted EAC (cost) or completion dates (schedule) the
 * run produced.
 *
 * Convergence is reported, never asserted: a job that stopped before the P80
 * settled says so rather than presenting its last figure as final.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiClientError } from "../../lib/api";
import { Badge, Button, Card, CardBody, ErrorAlert, Spinner, Table, Td, Th } from "../../ui";
import { formatDateTime, humanize } from "../format";

export interface ConvergencePoint {
  iterations: number;
  p50: number;
  p80: number;
  p80DeltaPercent: number | null;
}

export interface SimulationJob {
  id: string;
  kind: string;
  status: string;
  seed: number;
  iterations: number;
  iterationsDone: number;
  progressPercent: number;
  convergence: ConvergencePoint[];
  converged: boolean;
  simulationId: string | null;
  riskAdjusted: Record<string, unknown> | null;
  error: string | null;
  requestedBy: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

interface ListResponse<T> {
  items: T[];
  total: number;
}

function statusTone(status: string): "gray" | "blue" | "green" | "red" {
  switch (status) {
    case "done":
      return "green";
    case "failed":
      return "red";
    case "running":
      return "blue";
    default:
      return "gray";
  }
}

/** Formats a risk-adjusted figure: money for QCRA, an ISO date for QSRA. */
function fmtAdjusted(value: unknown, kind: string): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return kind === "qsra"
    ? `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} days`
    : value.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export default function SimulationJobs({
  base,
  onOpenSimulation,
}: {
  base: string;
  /** open the finished simulation in the results panel */
  onOpenSimulation: (simulationId: string) => void;
}) {
  const [jobs, setJobs] = useState<SimulationJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draining, setDraining] = useState(false);
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<ListResponse<SimulationJob>>(
        `${base}/risk/simulation-jobs?page=1&pageSize=10`,
      );
      setJobs(res.items ?? []);
      setError(null);
    } catch (err) {
      setJobs([]);
      setError(err instanceof ApiClientError ? err.message : "Could not load simulation jobs");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll only while something is actually in flight — an idle queue is not
  // worth a request every few seconds.
  const inFlight = (jobs ?? []).some((j) => j.status === "queued" || j.status === "running");
  useEffect(() => {
    if (!inFlight) return;
    timer.current = window.setInterval(() => void load(), 3000);
    return () => {
      if (timer.current !== null) window.clearInterval(timer.current);
      timer.current = null;
    };
  }, [inFlight, load]);

  async function drain() {
    setDraining(true);
    setError(null);
    try {
      await api.post<{ ran: number }>(`${base}/risk/simulation-jobs/run`, {});
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not run the queue");
    } finally {
      setDraining(false);
    }
  }

  if (jobs === null) return <Spinner label="Loading simulation jobs…" />;
  if (jobs.length === 0 && error === null) return null;

  return (
    <Card className="mt-5">
      <CardBody>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-ink-900">Queued simulations</h3>
            <p className="text-xs text-ink-400">
              Large runs execute off the request path in batches, recording the running P50/P80 so
              convergence is measured rather than assumed (#464, #475-476).
            </p>
          </div>
          <Button variant="secondary" size="sm" disabled={draining} onClick={() => void drain()}>
            {draining ? "Running…" : "Run queue now"}
          </Button>
        </div>

        <ErrorAlert message={error} />

        <Table>
          <thead>
            <tr>
              <Th>Run</Th>
              <Th>Status</Th>
              <Th className="text-right">Progress</Th>
              <Th>Convergence</Th>
              <Th>Risk-adjusted</Th>
              <Th className="text-right" />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {jobs.map((job) => {
              const last = job.convergence[job.convergence.length - 1];
              const adjusted = (job.riskAdjusted ?? {}) as Record<string, unknown>;
              return (
                <tr key={job.id}>
                  <Td className="whitespace-nowrap text-xs">
                    <span className="font-semibold uppercase text-ink-700">{job.kind}</span>
                    <div className="text-[11px] text-ink-400">
                      seed {job.seed} · {formatDateTime(job.createdAt)}
                    </div>
                  </Td>
                  <Td>
                    <Badge tone={statusTone(job.status)}>{humanize(job.status)}</Badge>
                    {job.error ? (
                      <div className="mt-0.5 max-w-xs text-[11px] leading-4 text-red-700">
                        {job.error}
                      </div>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap text-right tabular-nums text-xs">
                    {job.iterationsDone.toLocaleString()} / {job.iterations.toLocaleString()}
                    <div className="mt-1 h-1.5 w-24 overflow-hidden rounded-full bg-ink-100">
                      <div
                        className="h-full rounded-full bg-brand-600"
                        style={{ width: `${Math.min(100, job.progressPercent)}%` }}
                      />
                    </div>
                  </Td>
                  <Td className="text-xs">
                    {job.convergence.length === 0 ? (
                      <span className="text-ink-300">no batches yet</span>
                    ) : (
                      <>
                        <div className="flex items-center gap-1.5">
                          <Badge tone={job.converged ? "green" : "amber"}>
                            {job.converged ? "converged" : "not converged"}
                          </Badge>
                          <span className="tabular-nums text-ink-600">
                            {job.convergence.length} batch
                            {job.convergence.length === 1 ? "" : "es"}
                          </span>
                        </div>
                        {last ? (
                          <div className="mt-0.5 tabular-nums text-[11px] text-ink-500">
                            P50 {fmtAdjusted(last.p50, job.kind)} · P80{" "}
                            {fmtAdjusted(last.p80, job.kind)}
                            {last.p80DeltaPercent === null
                              ? ""
                              : ` · ΔP80 ${last.p80DeltaPercent.toFixed(2)}%`}
                          </div>
                        ) : null}
                      </>
                    )}
                  </Td>
                  <Td className="text-xs">
                    {job.riskAdjusted === null ? (
                      <span className="text-ink-300">—</span>
                    ) : (
                      <div className="tabular-nums text-ink-700">
                        {["p50", "p80", "p90"].map((k) =>
                          adjusted[k] === undefined ? null : (
                            <div key={k}>
                              <span className="uppercase text-ink-400">{k}</span>{" "}
                              {fmtAdjusted(adjusted[k], job.kind)}
                            </div>
                          ),
                        )}
                        {typeof adjusted["basis"] === "string" ? (
                          <div className="mt-0.5 max-w-xs text-[11px] leading-4 text-ink-400">
                            {adjusted["basis"]}
                          </div>
                        ) : null}
                      </div>
                    )}
                  </Td>
                  <Td className="text-right">
                    {job.simulationId ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onOpenSimulation(job.simulationId!)}
                      >
                        Open result
                      </Button>
                    ) : null}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </CardBody>
    </Card>
  );
}
