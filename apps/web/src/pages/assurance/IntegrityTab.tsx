/**
 * Integrity exposure scores (spec Vol II Domain A #93-99).
 *
 * 0..100, HIGHER IS WORSE — this is an exposure score, not a health score, and
 * the page says so rather than relying on the reader's assumption. Every score
 * opens into the components it was built from, because a number nobody can
 * decompose is an accusation rather than a measurement.
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
  Sparkline,
  Table,
  Td,
  Th,
} from "../../ui";
import { humanize } from "../format";
import { StatCard } from "./assuranceShared";

interface ScoreComponent {
  key: string;
  weight: number;
  contribution: number;
  basis: string;
}

interface ScoreRow {
  id: string;
  scope: string;
  subjectId: string;
  subjectLabel: string | null;
  score: number;
  band: string;
  openSignals: number;
  confirmedSignals: number;
  components: ScoreComponent[];
  computedAt: string;
}

interface TrendSeries {
  subjectId: string;
  subjectLabel: string | null;
  points: { at: string; score: number; band: string }[];
}

function bandTone(band: string): "red" | "amber" | "green" | "gray" {
  switch (band) {
    case "severe":
      return "red";
    case "elevated":
      return "amber";
    case "watch":
      return "gray";
    default:
      return "green";
  }
}

export default function IntegrityTab() {
  const [scope, setScope] = useState("project");
  const [items, setItems] = useState<ScoreRow[] | null>(null);
  const [computedAt, setComputedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [trends, setTrends] = useState<TrendSeries[] | null>(null);
  const [trendError, setTrendError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<{ items: ScoreRow[]; computedAt: string | null }>(
        `/api/v1/integrity/scores?scope=${scope}&limit=50`,
      );
      setItems(res.items);
      setComputedAt(res.computedAt);
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : "Failed to load integrity scores");
    }
  }, [scope]);

  const loadTrends = useCallback(async () => {
    setTrendError(null);
    try {
      const res = await api.get<{ series: TrendSeries[] }>(
        `/api/v1/integrity/trends?scope=project&days=90`,
      );
      setTrends(res.series);
    } catch (err) {
      setTrends([]);
      setTrendError(err instanceof Error ? err.message : "Failed to load trends");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void loadTrends();
  }, [loadTrends]);

  async function recompute() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/v1/integrity/recompute", {});
      await Promise.all([load(), loadTrends()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recompute failed");
    } finally {
      setBusy(false);
    }
  }

  const severe = (items ?? []).filter((i) => i.band === "severe").length;
  const elevated = (items ?? []).filter((i) => i.band === "elevated").length;
  const trendFor = (subjectId: string) =>
    (trends ?? []).find((t) => t.subjectId === subjectId)?.points.map((p) => ({ value: p.score })) ??
    [];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Subjects scored" value={items?.length ?? "—"} />
        <StatCard label="Severe" value={items ? severe : "—"} tone={severe > 0 ? "red" : "default"} />
        <StatCard
          label="Elevated"
          value={items ? elevated : "—"}
          tone={elevated > 0 ? "amber" : "default"}
        />
        <StatCard
          label="Computed"
          value={computedAt ? new Date(computedAt).toLocaleDateString() : "—"}
        />
      </div>

      <Card>
        <CardBody>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-2xl text-xs text-ink-500">
              <span className="font-semibold text-ink-700">0–100 exposure, higher is worse.</span>{" "}
              Weighted by severity and by what a reviewer made of each finding, discounted by the
              detector's own measured precision, and decayed with a 90-day half-life. A score of 0
              means nothing has been raised — it is not a statement that nothing is wrong. Snapshots
              are written by the <span className="font-mono">assurance.integrity-scores</span>{" "}
              scheduled job.
            </p>
            <div className="flex items-center gap-2">
              <div className="w-40">
                <Select value={scope} onChange={(e) => setScope(e.target.value)}>
                  <option value="project">Projects</option>
                  <option value="entity">Suppliers / entities</option>
                  <option value="approver">Approvers</option>
                </Select>
              </div>
              <Button variant="secondary" onClick={() => void recompute()} disabled={busy}>
                {busy ? "Recomputing…" : "Recompute now"}
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>

      <ErrorAlert message={error} />
      <ErrorAlert message={trendError} />

      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState
          title="No exposure scores yet"
          hint="Scores are computed from integrity signals. Run detectors, then recompute."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Subject</Th>
              <Th>Exposure</Th>
              <Th>Band</Th>
              <Th>Open</Th>
              <Th>Confirmed</Th>
              <Th>90-day trend</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <tr key={row.id}>
                <Td>
                  <div className="text-sm font-medium text-ink-900">
                    {row.subjectLabel ?? row.subjectId}
                  </div>
                  <div className="font-mono text-[11px] text-ink-400">{row.subjectId}</div>
                  {expanded === row.id ? (
                    <ul className="mt-2 space-y-1 border-l-2 border-ink-100 pl-3 text-[11px] text-ink-600">
                      {row.components.length === 0 ? (
                        <li>No contributing findings.</li>
                      ) : (
                        row.components.map((c) => <li key={c.key}>{c.basis}</li>)
                      )}
                    </ul>
                  ) : null}
                </Td>
                <Td className="whitespace-nowrap tabular-nums text-sm font-semibold">
                  {row.score.toFixed(1)}
                </Td>
                <Td>
                  <Badge tone={bandTone(row.band)}>{humanize(row.band)}</Badge>
                </Td>
                <Td className="tabular-nums text-sm">{row.openSignals}</Td>
                <Td className="tabular-nums text-sm">{row.confirmedSignals}</Td>
                <Td>
                  {trendFor(row.subjectId).length > 1 ? (
                    <Sparkline data={trendFor(row.subjectId)} higherIsBetter={false} />
                  ) : (
                    <span className="text-[11px] text-ink-400">one snapshot only</span>
                  )}
                </Td>
                <Td className="whitespace-nowrap">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setExpanded(expanded === row.id ? null : row.id)}
                  >
                    {expanded === row.id ? "Hide basis" : "Why?"}
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
