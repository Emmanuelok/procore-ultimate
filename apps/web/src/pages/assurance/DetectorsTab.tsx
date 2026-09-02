/**
 * The detector programme, as a programme (spec Vol II Domain A, Vol III §6).
 *
 * One table showing every detector this platform runs: what it tests, what it
 * needs, what its thresholds are, and — the part that makes the register
 * survivable — its MEASURED precision from the dispositions reviewers have
 * actually given it. A detector nobody believes any more can be switched off
 * here, or left to suppress itself against its precision floor.
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
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import { humanize } from "../format";
import { pct, ScoreMeter, StatCard } from "./assuranceShared";

interface DetectorRow {
  id: string;
  family: string;
  scope: string;
  name: string;
  description: string;
  specRef: string;
  requires: string[];
  thresholds: Record<string, number>;
  enabled: boolean;
  precisionFloor: number | null;
  measuredPrecision: number | null;
  precisionBasis: string;
  confirmed: number;
  falsePositive: number;
  suppressed: boolean;
  suppressionReason: string | null;
  signalsRaised: number;
  passive: boolean;
}

interface RunResult {
  runId: string;
  created: number;
  refreshed: number;
  superseded: number;
  autoClosed: number;
  executed: string[];
  skipped: { detector: string; reason: string }[];
  perDetector: Record<string, number>;
  durationMs: number;
}

interface DetectorRun {
  id: string;
  scope: string;
  projectId: string | null;
  trigger: string;
  detectors: string[];
  skipped: { detector: string; reason: string }[];
  signalsCreated: number;
  signalsRefreshed: number;
  signalsAutoClosed: number;
  durationMs: number | null;
  startedAt: string;
}

export default function DetectorsTab() {
  const [items, setItems] = useState<DetectorRow[] | null>(null);
  const [families, setFamilies] = useState<string[]>([]);
  const [family, setFamily] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<DetectorRun[] | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<{ items: DetectorRow[]; families: string[] }>("/api/v1/detectors");
      setItems(res.items);
      setFamilies(res.families);
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : "Failed to load the detector registry");
    }
  }, []);

  const loadRuns = useCallback(async () => {
    setRunError(null);
    try {
      const res = await api.get<{ items: DetectorRun[] }>("/api/v1/detector-runs?pageSize=15");
      setRuns(res.items);
    } catch (err) {
      setRuns([]);
      setRunError(err instanceof Error ? err.message : "Failed to load detector runs");
    }
  }, []);

  useEffect(() => {
    void load();
    void loadRuns();
  }, [load, loadRuns]);

  async function runCompanyDetectors() {
    setBusy(true);
    setActionError(null);
    setResult(null);
    try {
      const res = await api.post<RunResult>("/api/v1/detectors/run", {});
      setResult(res);
      await Promise.all([load(), loadRuns()]);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "The detector run failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(row: DetectorRow) {
    setActionError(null);
    try {
      await api.put(`/api/v1/detectors/${row.id}/policy`, { enabled: !row.enabled });
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not update the detector policy");
    }
  }

  const shown = (items ?? []).filter((d) => !family || d.family === family);
  const active = (items ?? []).filter((d) => d.enabled && !d.suppressed && !d.passive);
  const suppressed = (items ?? []).filter((d) => d.suppressed);
  const measured = (items ?? []).filter((d) => d.measuredPrecision !== null);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Detectors" value={items?.length ?? "—"} />
        <StatCard label="Running" value={items ? active.length : "—"} />
        <StatCard
          label="Suppressed"
          value={items ? suppressed.length : "—"}
          tone={suppressed.length > 0 ? "amber" : "default"}
        />
        <StatCard
          label="With measured precision"
          value={items ? `${measured.length}/${items.length}` : "—"}
        />
      </div>

      <Card>
        <CardBody>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-ink-900">Company-scoped run</div>
              <p className="mt-0.5 text-xs text-ink-500">
                Payables, approval patterns and the entity network. Runs are idempotent: a
                condition already open is refreshed, never duplicated, and a condition that has
                cleared is closed.
              </p>
            </div>
            <Button onClick={() => void runCompanyDetectors()} disabled={busy}>
              {busy ? "Running…" : "Run company detectors"}
            </Button>
          </div>
          <ErrorAlert message={actionError} />
          {result ? (
            <div className="mt-3 rounded-md bg-brand-50 px-3 py-2 text-sm text-brand-900 ring-1 ring-brand-200">
              <span className="font-semibold">{result.created} new</span> ·{" "}
              {result.refreshed} still true · {result.superseded} superseded ·{" "}
              {result.autoClosed} auto-closed · {result.executed.length} detector
              {result.executed.length === 1 ? "" : "s"} executed in {result.durationMs}ms.
              {result.skipped.length > 0 ? (
                <ul className="mt-1 list-inside list-disc text-xs">
                  {result.skipped.map((s) => (
                    <li key={s.detector}>
                      <span className="font-medium">{s.detector}</span> skipped — {s.reason}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </CardBody>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <div className="w-56">
          <Select value={family} onChange={(e) => setFamily(e.target.value)}>
            <option value="">All families</option>
            {families.map((f) => (
              <option key={f} value={f}>
                {humanize(f)}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <ErrorAlert message={error} />
      {items === null ? (
        <Spinner />
      ) : shown.length === 0 ? (
        <EmptyState title="No detectors in this family" />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Detector</Th>
              <Th>Family</Th>
              <Th>Scope</Th>
              <Th>Measured precision</Th>
              <Th>Signals</Th>
              <Th>State</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {shown.map((d) => (
              <tr key={d.id}>
                <Td>
                  <div className="text-sm font-medium text-ink-900">{d.name}</div>
                  <div className="mt-0.5 max-w-xl text-xs text-ink-500">{d.description}</div>
                  <div className="mt-0.5 text-[11px] text-ink-400">
                    <span className="font-mono">{d.id}</span> · {d.specRef} · needs{" "}
                    {d.requires.join("; ")}
                  </div>
                </Td>
                <Td className="whitespace-nowrap text-xs">{humanize(d.family)}</Td>
                <Td className="whitespace-nowrap text-xs">{humanize(d.scope)}</Td>
                <Td>
                  {d.measuredPrecision === null ? (
                    <div className="text-xs text-ink-400" title={d.precisionBasis}>
                      not available
                      <div className="text-[11px]">{d.precisionBasis}</div>
                    </div>
                  ) : (
                    <div>
                      <ScoreMeter
                        value={d.measuredPrecision}
                        tone={d.suppressed ? "red" : undefined}
                      />
                      <div className="mt-0.5 text-[11px] text-ink-400">
                        {d.confirmed} confirmed / {d.confirmed + d.falsePositive} reviewed
                        {d.precisionFloor !== null ? ` · floor ${pct(d.precisionFloor)}` : ""}
                      </div>
                    </div>
                  )}
                </Td>
                <Td className="whitespace-nowrap tabular-nums text-sm">{d.signalsRaised}</Td>
                <Td className="whitespace-nowrap">
                  {d.passive ? (
                    <Badge tone="gray">raised elsewhere</Badge>
                  ) : d.suppressed ? (
                    <Badge tone="red" title={d.suppressionReason ?? undefined}>
                      suppressed
                    </Badge>
                  ) : d.enabled ? (
                    <Badge tone="green">enabled</Badge>
                  ) : (
                    <Badge tone="gray">disabled</Badge>
                  )}
                </Td>
                <Td className="whitespace-nowrap">
                  {d.passive ? null : (
                    <Button size="sm" variant="secondary" onClick={() => void toggle(d)}>
                      {d.enabled ? "Disable" : "Enable"}
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <Card>
        <CardBody>
          <div className="mb-2 text-sm font-semibold text-ink-900">Recent runs</div>
          <ErrorAlert message={runError} />
          {runs === null ? (
            <Spinner />
          ) : runs.length === 0 ? (
            <EmptyState
              title="No detector runs recorded"
              hint="Runs are recorded so cadence and precision are facts rather than impressions."
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Scope</Th>
                  <Th>Trigger</Th>
                  <Th>Detectors</Th>
                  <Th>New</Th>
                  <Th>Refreshed</Th>
                  <Th>Auto-closed</Th>
                  <Th>Skipped</Th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <Td className="whitespace-nowrap text-xs">
                      {new Date(r.startedAt).toLocaleString()}
                      {r.durationMs !== null ? (
                        <span className="ml-1 text-ink-400">({r.durationMs}ms)</span>
                      ) : null}
                    </Td>
                    <Td className="text-xs">{humanize(r.scope)}</Td>
                    <Td className="text-xs">{humanize(r.trigger)}</Td>
                    <Td className="text-xs">{r.detectors.length}</Td>
                    <Td className="tabular-nums text-sm">{r.signalsCreated}</Td>
                    <Td className="tabular-nums text-sm">{r.signalsRefreshed}</Td>
                    <Td className="tabular-nums text-sm">{r.signalsAutoClosed}</Td>
                    <Td className="max-w-sm text-[11px] text-ink-500">
                      {r.skipped.length === 0
                        ? "—"
                        : r.skipped.map((s) => `${s.detector}: ${s.reason}`).join(" · ")}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
