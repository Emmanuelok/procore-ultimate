/**
 * Signals tab — anomaly feed for one project: severity stat cards, filters,
 * detector runner, and a review drawer with segregation-of-duties handling.
 */
import { useCallback, useEffect, useState } from "react";
import { SIGNAL_DISPOSITIONS, SIGNAL_SEVERITIES } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Field,
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { formatDateTime, humanize } from "../format";
import {
  dispositionTone,
  pct,
  severityTone,
  StatCard,
  WarnBanner,
  type ListResponse,
  type SignalRow,
} from "./assuranceShared";

const DETECTORS = [
  "benford_first_digit",
  "duplicate_assertions",
  "round_number_clustering",
  "approval_velocity",
  "segregation_of_duties",
  "contradicted_claimant",
] as const;

interface RunResult {
  created: number;
  skipped?: string[];
  perDetector: Record<string, number>;
}

export default function SignalsTab({ projectId }: { projectId: string }) {
  const base = `/api/v1/projects/${projectId}/signals`;

  const [items, setItems] = useState<SignalRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [severity, setSeverity] = useState("");
  const [disposition, setDisposition] = useState("");

  const [selected, setSelected] = useState<SignalRow | null>(null);
  const [dispForm, setDispForm] = useState("under_review");
  const [notes, setNotes] = useState("");
  const [dispBusy, setDispBusy] = useState(false);
  const [sodWarning, setSodWarning] = useState<string | null>(null);
  const [dispError, setDispError] = useState<string | null>(null);

  const [checked, setChecked] = useState<Set<string>>(new Set(DETECTORS));
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({ pageSize: "100" });
      if (severity) params.set("severity", severity);
      if (disposition) params.set("disposition", disposition);
      const res = await api.get<ListResponse<SignalRow>>(`${base}?${params}`);
      setItems(res.items);
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : "Failed to load signals");
    }
  }, [base, severity, disposition]);

  useEffect(() => {
    void load();
  }, [load]);

  const counts: Record<string, number> = {};
  for (const s of items ?? []) counts[s.severity] = (counts[s.severity] ?? 0) + 1;

  function openDrawer(s: SignalRow) {
    setSelected(s);
    setDispForm(s.disposition === "new" ? "under_review" : s.disposition);
    setNotes(s.reviewerNotes ?? "");
    setSodWarning(null);
    setDispError(null);
  }

  async function submitDisposition() {
    if (!selected) return;
    setDispBusy(true);
    setSodWarning(null);
    setDispError(null);
    try {
      const payload: Record<string, unknown> = { disposition: dispForm };
      if (notes.trim()) payload["reviewerNotes"] = notes.trim();
      await api.patch(`/api/v1/signals/${selected.id}/disposition`, payload);
      setSelected(null);
      await load();
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 403) {
        setSodWarning(
          "Signal disposition requires an Integrity Reviewer grant — segregation of duties.",
        );
      } else {
        setDispError(err instanceof Error ? err.message : "Failed to update the signal");
      }
    } finally {
      setDispBusy(false);
    }
  }

  async function runDetectors() {
    setRunning(true);
    setRunError(null);
    setRunResult(null);
    try {
      const res = await api.post<RunResult>(`/api/v1/projects/${projectId}/detectors/run`, {
        detectors: [...checked],
      });
      setRunResult(res);
      await load();
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Detector run failed");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Critical" value={counts["critical"] ?? 0} tone={(counts["critical"] ?? 0) > 0 ? "red" : "default"} />
        <StatCard label="High" value={counts["high"] ?? 0} tone={(counts["high"] ?? 0) > 0 ? "red" : "default"} />
        <StatCard label="Medium" value={counts["medium"] ?? 0} tone={(counts["medium"] ?? 0) > 0 ? "amber" : "default"} />
        <StatCard label="Low / info" value={(counts["low"] ?? 0) + (counts["info"] ?? 0)} />
      </div>

      <Card>
        <CardBody>
          <div className="mb-2 text-sm font-semibold text-ink-900">Run detectors</div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {DETECTORS.map((d) => (
              <label key={d} className="flex items-center gap-1.5 text-sm text-ink-700">
                <input
                  type="checkbox"
                  checked={checked.has(d)}
                  onChange={(e) => {
                    setChecked((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(d);
                      else next.delete(d);
                      return next;
                    });
                  }}
                />
                {humanize(d)}
              </label>
            ))}
            <Button size="sm" onClick={() => void runDetectors()} disabled={running || checked.size === 0}>
              {running ? "Running…" : "Run"}
            </Button>
          </div>
          <ErrorAlert message={runError} />
          {runResult ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Badge tone={runResult.created > 0 ? "amber" : "green"}>
                {runResult.created} signal{runResult.created === 1 ? "" : "s"} created
              </Badge>
              {Object.entries(runResult.perDetector).map(([k, v]) => (
                <Badge key={k} tone={v > 0 ? "red" : "gray"}>
                  {humanize(k)}: {v}
                </Badge>
              ))}
              {(runResult.skipped ?? []).map((k) => (
                <Badge key={`skip-${k}`} tone="gray">
                  {humanize(k)}: skipped (insufficient data)
                </Badge>
              ))}
            </div>
          ) : null}
        </CardBody>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <div className="w-44">
          <Select value={severity} onChange={(e) => setSeverity(e.target.value)}>
            <option value="">All severities</option>
            {SIGNAL_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-44">
          <Select value={disposition} onChange={(e) => setDisposition(e.target.value)}>
            <option value="">All dispositions</option>
            {SIGNAL_DISPOSITIONS.map((d) => (
              <option key={d} value={d}>
                {humanize(d)}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <ErrorAlert message={error} />

      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState
          title={severity || disposition ? "No signals match your filters" : "No signals yet"}
          hint="Run the detectors above to test this project's assertions, approvals and reconciliations."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Severity</Th>
              <Th>Detector</Th>
              <Th>Title</Th>
              <Th>Confidence</Th>
              <Th>Disposition</Th>
              <Th>Created</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {items.map((s) => (
              <tr key={s.id} className="cursor-pointer hover:bg-ink-50/60" onClick={() => openDrawer(s)}>
                <Td>
                  <Badge tone={severityTone(s.severity)}>{humanize(s.severity)}</Badge>
                </Td>
                <Td className="whitespace-nowrap font-mono text-xs">{s.detector}</Td>
                <Td className="max-w-md">
                  <span className="line-clamp-2 font-medium text-ink-900">{s.title}</span>
                </Td>
                <Td className="tabular-nums">{pct(s.confidence)}</Td>
                <Td>
                  <Badge tone={dispositionTone(s.disposition)}>{humanize(s.disposition)}</Badge>
                </Td>
                <Td className="whitespace-nowrap text-xs text-ink-500">{formatDateTime(s.createdAt)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {selected ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-ink-950/40" onClick={() => setSelected(null)}>
          <div
            className="h-full w-full max-w-xl overflow-y-auto bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <div className="mb-1 flex items-center gap-2">
                  <Badge tone={severityTone(selected.severity)}>{humanize(selected.severity)}</Badge>
                  <Badge tone={dispositionTone(selected.disposition)}>
                    {humanize(selected.disposition)}
                  </Badge>
                  <span className="font-mono text-xs text-ink-400">{selected.detector}</span>
                </div>
                <h2 className="text-base font-semibold text-ink-900">{selected.title}</h2>
                <p className="mt-0.5 text-xs text-ink-400">
                  Confidence {pct(selected.confidence)} · {formatDateTime(selected.createdAt)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <div className="mb-4">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-400">
                Explanation
              </div>
              <p className="whitespace-pre-wrap text-sm text-ink-800">{selected.explanation}</p>
            </div>

            <div className="mb-4">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-400">
                Evidence refs
              </div>
              <pre className="max-h-64 overflow-auto rounded-md bg-ink-950/95 p-3 font-mono text-xs leading-5 text-ink-100">
                {JSON.stringify(selected.evidenceRefs ?? null, null, 2)}
              </pre>
            </div>

            <div className="rounded-lg border border-ink-100 p-4">
              <div className="mb-2 text-sm font-semibold text-ink-900">Disposition</div>
              <WarnBanner message={sodWarning} />
              <ErrorAlert message={dispError} />
              <div className="space-y-3">
                <Field label="Set disposition">
                  <Select value={dispForm} onChange={(e) => setDispForm(e.target.value)}>
                    {SIGNAL_DISPOSITIONS.map((d) => (
                      <option key={d} value={d}>
                        {humanize(d)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Reviewer notes">
                  <Textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Why is this signal being confirmed / dismissed?"
                  />
                </Field>
                <div className="flex justify-end">
                  <Button onClick={() => void submitDisposition()} disabled={dispBusy}>
                    {dispBusy ? "Saving…" : "Save disposition"}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
