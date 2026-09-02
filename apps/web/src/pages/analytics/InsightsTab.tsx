/**
 * Insights tab — predictive forecasts (#753-758) and the report run history
 * (#752).
 *
 * Two things that had no surface at all before this. The forecast endpoints
 * existed and were unreachable; the run history existed and was invisible, so a
 * scheduled delivery left no trace anyone could look at.
 *
 * HONESTY RULES APPLIED HERE, because this is where they bite hardest:
 *   · A probability the platform cannot compute renders as "not available"
 *     with the REASONS the API returned. It never renders as 0%, and it never
 *     renders as a dash with no explanation.
 *   · The sample size and the reference class behind every probability are
 *     shown next to it. A p80 uplift drawn from six comparable projects is a
 *     different object from one drawn from six hundred, and the reader is not
 *     asked to guess which they are looking at.
 *   · A run row states whether the message was DISPATCHED, not whether it was
 *     scheduled. `deliveryDispatched: false` with its reasons is the normal
 *     state on a deployment with no mail transport, and it says so.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import { formatDateTime } from "../format";
import { Caveat, StatCard, errorMessage, fmtNum, type ListResponse } from "./analyticsShared";

interface ExceedanceRow {
  threshold: number;
  probability: number | null;
}

interface Forecast {
  kind: "cost_overrun" | "schedule_overrun";
  probability: number | null;
  p50Uplift: number | null;
  p80Uplift: number | null;
  referenceClass: string | null;
  sampleSize: number;
  contributorCount?: number;
  basis: string;
  inputs: Record<string, unknown>;
  reasons: string[];
  exceedance?: ExceedanceRow[];
}

interface ForecastResponse {
  projectId: string;
  computedAt: string;
  forecasts: Forecast[];
  method: string;
}

interface RunRow {
  id: string;
  reportId: string;
  scheduleId: string | null;
  trigger: string;
  status: string;
  projectId: string | null;
  rowCount: number;
  truncated: boolean;
  durationMs: number;
  format: string;
  recipients: string[];
  deliveryDispatched: boolean;
  deliveryReasons: string[];
  error: string | null;
  createdAt: string;
}

const KIND_LABEL: Record<string, string> = {
  cost_overrun: "Cost overrun",
  schedule_overrun: "Programme overrun",
};

function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${fmtNum(value * 100, 0)}%`;
}

function tone(probability: number | null): "brand" | "amber" | "red" | undefined {
  if (probability === null) return undefined;
  if (probability >= 0.6) return "red";
  if (probability >= 0.35) return "amber";
  return "brand";
}

function ForecastCard({ forecast }: { forecast: Forecast }) {
  const label = KIND_LABEL[forecast.kind] ?? forecast.kind;
  const unavailable = forecast.probability === null;
  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-ink-900">{label}</h3>
            <p className="text-xs text-ink-400">
              {forecast.referenceClass
                ? `Reference class: ${forecast.referenceClass}`
                : "No reference class resolved"}
            </p>
          </div>
          <Badge tone={unavailable ? "gray" : forecast.probability! >= 0.5 ? "red" : "blue"}>
            n = {forecast.sampleSize}
            {typeof forecast.contributorCount === "number"
              ? ` · ${forecast.contributorCount} contributor(s)`
              : ""}
          </Badge>
        </div>

        {unavailable ? (
          <div className="rounded-md bg-ink-50 px-3 py-2 text-xs leading-relaxed text-ink-600">
            <span className="font-medium text-ink-900">Not available.</span>{" "}
            {forecast.reasons.length > 0
              ? forecast.reasons.join(" ")
              : "The platform does not hold the inputs this forecast needs."}
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            <StatCard
              label="P(overrun)"
              value={pct(forecast.probability)}
              tone={tone(forecast.probability)}
              title={forecast.basis}
            />
            <StatCard label="P50 uplift" value={forecast.p50Uplift === null ? "—" : `${fmtNum(forecast.p50Uplift, 1)}%`} />
            <StatCard label="P80 uplift" value={forecast.p80Uplift === null ? "—" : `${fmtNum(forecast.p80Uplift, 1)}%`} />
          </div>
        )}

        {forecast.exceedance && forecast.exceedance.length > 0 ? (
          <div className="flex flex-wrap gap-3 text-xs text-ink-600">
            {forecast.exceedance.map((e) => (
              <span key={e.threshold} className="rounded-md bg-ink-50 px-2 py-1">
                P(&gt; {e.threshold}%) ={" "}
                <span className="font-medium tabular-nums text-ink-900">{pct(e.probability)}</span>
              </span>
            ))}
          </div>
        ) : null}

        <p className="text-xs leading-relaxed text-ink-500">{forecast.basis}</p>
      </CardBody>
    </Card>
  );
}

export default function InsightsTab({ projectId }: { projectId: string }) {
  const [forecast, setForecast] = useState<ForecastResponse | null>(null);
  const [forecastError, setForecastError] = useState<string | null>(null);
  const [storing, setStoring] = useState(false);
  const [storeNote, setStoreNote] = useState<string | null>(null);

  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);

  const loadForecast = useCallback(async () => {
    setForecastError(null);
    try {
      const res = await api.get<ForecastResponse>(
        `/api/v1/projects/${projectId}/analytics/forecast`,
      );
      setForecast(res);
    } catch (err) {
      setForecast(null);
      setForecastError(errorMessage(err, "Failed to compute the forecast"));
    }
  }, [projectId]);

  const loadRuns = useCallback(async () => {
    setRunsError(null);
    try {
      const res = await api.get<ListResponse<RunRow>>(
        "/api/v1/analytics/reports/runs?page=1&pageSize=25",
      );
      setRuns(res.items ?? []);
    } catch (err) {
      setRuns([]);
      setRunsError(errorMessage(err, "Failed to load the run history"));
    }
  }, []);

  useEffect(() => {
    void loadForecast();
    void loadRuns();
  }, [loadForecast, loadRuns]);

  async function onFreeze() {
    setStoring(true);
    setStoreNote(null);
    try {
      await api.post(`/api/v1/projects/${projectId}/analytics/forecast`, {});
      setStoreNote(
        "Frozen. The figures above are now a stored record with their inputs, so the number a " +
          "contingency decision cited can be produced again later.",
      );
    } catch (err) {
      setStoreNote(errorMessage(err, "Could not freeze the forecast"));
    } finally {
      setStoring(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-ink-900">Predictive insights</h2>
            <p className="text-xs text-ink-400">
              Reference-class forecasting: this project's booked growth placed in the empirical
              distribution of comparable projects.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => void loadForecast()}>
              Recompute
            </Button>
            <Button onClick={() => void onFreeze()} disabled={storing || forecast === null}>
              {storing ? "Freezing…" : "Freeze this forecast"}
            </Button>
          </div>
        </div>

        <ErrorAlert message={forecastError} />
        {storeNote ? <Caveat>{storeNote}</Caveat> : null}

        {forecast === null && forecastError === null ? (
          <Spinner label="Computing the forecast…" />
        ) : null}

        {forecast ? (
          <>
            <div className="grid gap-3 md:grid-cols-2">
              {forecast.forecasts.map((f) => (
                <ForecastCard key={f.kind} forecast={f} />
              ))}
            </div>
            <Caveat>{forecast.method}</Caveat>
          </>
        ) : null}
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold text-ink-900">Report run history</h2>
          <p className="text-xs text-ink-400">
            Every execution — pressed by a person, fired by a schedule or driven by a dashboard —
            with what came back and whether a scheduled delivery actually left the building.
          </p>
        </div>

        <ErrorAlert message={runsError} />

        {runs === null ? (
          <Spinner label="Loading runs…" />
        ) : runs.length === 0 ? (
          <EmptyState
            title="No runs recorded yet"
            hint="Run a report, or wait for a schedule to fall due; every execution leaves a row here."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Trigger</Th>
                <Th>Status</Th>
                <Th className="text-right">Rows</Th>
                <Th className="text-right">Duration</Th>
                <Th>Delivery</Th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <Td className="whitespace-nowrap">{formatDateTime(r.createdAt)}</Td>
                  <Td>
                    <Badge tone={r.trigger === "scheduled" ? "blue" : "gray"}>{r.trigger}</Badge>
                  </Td>
                  <Td>
                    <Badge tone={r.status === "succeeded" ? "green" : "red"}>{r.status}</Badge>
                    {r.error ? (
                      <div className="mt-0.5 max-w-64 truncate text-xs text-red-700" title={r.error}>
                        {r.error}
                      </div>
                    ) : null}
                  </Td>
                  <Td className="text-right tabular-nums">
                    {fmtNum(r.rowCount, 0)}
                    {r.truncated ? <span className="ml-1 text-amber-700">(capped)</span> : null}
                  </Td>
                  <Td className="text-right tabular-nums">{fmtNum(r.durationMs, 0)} ms</Td>
                  <Td>
                    {r.trigger !== "scheduled" ? (
                      <span className="text-ink-300">—</span>
                    ) : r.deliveryDispatched ? (
                      <Badge tone="green">sent to {r.recipients.length}</Badge>
                    ) : (
                      <span
                        className="text-xs text-amber-800"
                        title={r.deliveryReasons.join(" ")}
                      >
                        not sent
                        {r.deliveryReasons.length > 0 ? ` — ${r.deliveryReasons[0]}` : ""}
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </div>
  );
}
