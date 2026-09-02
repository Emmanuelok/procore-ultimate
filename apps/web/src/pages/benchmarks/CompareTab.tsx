/**
 * Compare (#832, #856): the project's latest frozen snapshot against the
 * distribution its company can access — value, percentile rank marked on
 * the p10/median/p90 strip, and every disclosure the server sent. Adverse
 * outliers against a genuinely contributed cell (never seed data) raise a
 * benchmark_outlier signal server-side; the UI names that when it happens.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ASSET_CLASSES } from "@constructos/shared";
import { ApiClientError, api } from "../../lib/api";
import { Badge, Button, Card, CardBody, EmptyState, Field, Input, Select, Spinner } from "../../ui";
import { formatDateTime } from "../format";
import {
  AccessBadge,
  DirectionBadge,
  DisclosureList,
  HealthWarningBanner,
  LoadError,
  Stat,
  SuppressedCard,
  errorMessage,
  fmtNum,
  fmtPercentile,
  label,
} from "./benchmarksShared";
import type { CompareResponse, MetricDef } from "./benchmarksShared";
import { PercentileStrip } from "./charts";

export default function CompareTab({
  projectId,
  metrics,
}: {
  projectId: string;
  metrics: MetricDef[] | null;
}) {
  const [metric, setMetric] = useState("");
  const [assetClass, setAssetClass] = useState("");
  const [region, setRegion] = useState("");

  const [data, setData] = useState<CompareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 404 (no snapshot) and 400 (no cell) are guidance, not failures */
  const [guidance, setGuidance] = useState<string | null>(null);

  const load = useCallback(
    async (m: string, ac: string, rg: string) => {
      if (!m) return;
      setLoading(true);
      setError(null);
      setGuidance(null);
      try {
        const params = new URLSearchParams({ metric: m });
        if (ac) params.set("assetClass", ac);
        if (rg.trim()) params.set("region", rg.trim());
        setData(
          await api.get<CompareResponse>(
            `/api/v1/projects/${projectId}/benchmarks/compare?${params}`,
          ),
        );
      } catch (err) {
        setData(null);
        if (err instanceof ApiClientError && (err.status === 404 || err.status === 400)) {
          setGuidance(err.message);
        } else {
          setError(errorMessage(err, "Failed to load the comparison"));
        }
      } finally {
        setLoading(false);
      }
    },
    [projectId],
  );

  // a new project invalidates whatever comparison was on screen
  useEffect(() => {
    setData(null);
    setError(null);
    setGuidance(null);
  }, [projectId]);

  function submit(e: FormEvent) {
    e.preventDefault();
    void load(metric, assetClass, region);
  }

  const dist = data?.distribution ?? null;
  const suppressed = dist?.suppressed === true;
  const hasStrip = !!data && !!dist && !suppressed && dist.median !== undefined;

  return (
    <div className="space-y-4">
      <Card>
        <CardBody>
          <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
            <div className="min-w-56">
              <Field label="Metric">
                <Select
                  value={metric}
                  onChange={(e) => setMetric(e.target.value)}
                  disabled={!metrics}
                >
                  <option value="">{metrics ? "Select a metric…" : "Loading metrics…"}</option>
                  {(metrics ?? []).map((m) => (
                    <option key={m.key} value={m.key}>
                      {m.name} ({m.unit})
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="min-w-44">
              <Field label="Asset class (optional)">
                <Select value={assetClass} onChange={(e) => setAssetClass(e.target.value)}>
                  <option value="">From contributed sample</option>
                  {ASSET_CLASSES.map((c) => (
                    <option key={c} value={c}>
                      {label(c)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="w-32">
              <Field label="Region (optional)" hint="e.g. GB">
                <Input
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                  maxLength={40}
                  placeholder="From sample"
                />
              </Field>
            </div>
            <Button type="submit" disabled={!metric || loading} className="mb-5">
              {loading ? "Comparing…" : "Compare"}
            </Button>
          </form>
          <p className="text-xs text-ink-400">
            Compares the project's latest snapshot of the metric. Leave the cell blank to reuse the
            asset class and region this snapshot was contributed into.
          </p>
        </CardBody>
      </Card>

      {error ? (
        <LoadError message={error} onRetry={() => void load(metric, assetClass, region)} />
      ) : guidance ? (
        <EmptyState
          title="Nothing to compare yet"
          hint={`${guidance} — compute a snapshot in the Project snapshots tab, or pick an asset class and region above.`}
        />
      ) : loading && !data ? (
        <Spinner label="Loading the comparison…" />
      ) : !data ? (
        <EmptyState
          title="Pick a metric to compare"
          hint="The project's latest frozen snapshot is placed on the distribution its company can access."
        />
      ) : (
        <>
          <HealthWarningBanner warning={data.healthWarning} />
          {data.accessLevel === "seed_only" ? (
            <div className="mb-0 rounded-md bg-brand-50 px-3 py-2 text-sm text-brand-800 ring-1 ring-brand-100">
              <span className="font-medium">Seed-only access:</span> this comparison is against
              illustrative seed data only. Contribute a snapshot of this metric to compare against
              the real contributed distribution. Outlier signals are never raised against seed
              data.
            </div>
          ) : null}

          {data.outlier?.adverse ? (
            <div className="rounded-md bg-red-50 px-4 py-3 ring-1 ring-red-200" role="alert">
              <p className="text-sm font-medium text-red-800">
                Adverse outlier: this project sits{" "}
                {data.outlier.side === "above_p90" ? "above the 90th" : "below the 10th"}{" "}
                percentile of its benchmark cell — the unfavourable tail for this metric.
              </p>
              <p className="mt-1 text-xs text-red-700">
                {data.outlier.signalRaised
                  ? "A medium-severity benchmark_outlier signal has been raised for this snapshot and will appear in Assurance."
                  : data.accessLevel === "contributed" && dist && dist.n >= data.minSampleN
                    ? "A benchmark_outlier signal for this snapshot already exists (signals are idempotent per snapshot)."
                    : "No signal was raised: outlier signals require a contributed distribution with at least the minimum sample count."}
              </p>
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label="Project value"
              value={
                <>
                  {fmtNum(data.value)} <span className="text-sm text-ink-500">{data.unit}</span>
                </>
              }
              emphasized
              hint={`Snapshot frozen ${formatDateTime(data.computedAt)}`}
            />
            <Stat
              label="Percentile rank"
              value={fmtPercentile(data.percentile)}
              hint={
                data.percentile !== null
                  ? "Share of samples at or below the project"
                  : "Not computable"
              }
            />
            <Stat label="Sample size n" value={dist ? dist.n : "—"} hint="Always disclosed" />
            <Card>
              <CardBody className="px-4 py-3">
                <div className="flex flex-wrap gap-1.5">
                  <AccessBadge level={data.accessLevel} />
                  {metrics ? (
                    <DirectionBadge
                      higherIsBetter={
                        metrics.find((m) => m.key === data.metric)?.higherIsBetter ?? false
                      }
                    />
                  ) : null}
                  {data.seedIncluded ? <Badge tone="amber">Includes seed rows</Badge> : null}
                </div>
                <div className="mt-1.5 text-xs text-ink-400">
                  {label(data.assetClass)} · {data.region}
                </div>
              </CardBody>
            </Card>
          </div>

          {suppressed ? (
            <SuppressedCard n={dist!.n} minSampleN={data.minSampleN} />
          ) : dist && dist.n === 0 ? (
            <EmptyState
              title="No samples in this cell (n = 0)"
              hint="There is nothing to place this project against yet."
            />
          ) : hasStrip ? (
            <Card>
              <CardBody>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
                  Project against the p10 / median / p90 of the cell
                </h3>
                <PercentileStrip
                  unit={data.unit}
                  markers={[
                    { value: dist!.p10!, label: "p10" },
                    { value: dist!.median!, label: "median" },
                    { value: dist!.p90!, label: "p90" },
                  ]}
                  flag={{
                    value: data.value,
                    label: `this project (${fmtPercentile(data.percentile)})`,
                  }}
                />
              </CardBody>
            </Card>
          ) : null}

          <DisclosureList disclosures={data.disclosures} />
        </>
      )}
    </div>
  );
}
