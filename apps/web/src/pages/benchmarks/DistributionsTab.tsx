/**
 * Distributions explorer (#831, #855): one anonymized cell at a time —
 * metric × asset class × region — with n always on show, min-n suppression
 * rendered as an explanation rather than an error, seed-only access
 * labelled with the server's upgrade note, and the seed health warning
 * repeated verbatim in amber.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ASSET_CLASSES } from "@constructos/shared";
import { Badge, Button, Card, CardBody, EmptyState, Field, Input, Select, Spinner } from "../../ui";
import { api } from "../../lib/api";
import {
  AccessBadge,
  DirectionBadge,
  DisclosureList,
  HealthWarningBanner,
  LoadError,
  SeedOnlyNote,
  Stat,
  SuppressedCard,
  errorMessage,
  fmtNum,
  label,
} from "./benchmarksShared";
import type { DistributionResponse, MetricDef } from "./benchmarksShared";
import { HistogramChart, PercentileStrip } from "./charts";

export default function DistributionsTab({ metrics }: { metrics: MetricDef[] | null }) {
  const [metric, setMetric] = useState("");
  const [assetClass, setAssetClass] = useState<string>("commercial");
  const [region, setRegion] = useState("GB");

  const [data, setData] = useState<DistributionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoloaded = useRef(false);

  const load = useCallback(async (m: string, ac: string, rg: string) => {
    if (!m || !ac || rg.trim().length < 2) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ metric: m, assetClass: ac, region: rg.trim() });
      setData(await api.get<DistributionResponse>(`/api/v1/benchmarks/distributions?${params}`));
    } catch (err) {
      setData(null);
      setError(errorMessage(err, "Failed to load the distribution"));
    } finally {
      setLoading(false);
    }
  }, []);

  // default to the first metric once the registry arrives, and load it once
  useEffect(() => {
    if (metrics && metrics.length > 0 && !autoloaded.current) {
      autoloaded.current = true;
      const first = metrics[0]!.key;
      setMetric(first);
      void load(first, "commercial", "GB");
    }
  }, [metrics, load]);

  function submit(e: FormEvent) {
    e.preventDefault();
    void load(metric, assetClass, region);
  }

  const dist = data?.distribution ?? null;
  const suppressed = dist?.suppressed === true;
  const hasStats = !!dist && !suppressed && dist.n > 0 && dist.median !== undefined;

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
            <div className="min-w-40">
              <Field label="Asset class">
                <Select value={assetClass} onChange={(e) => setAssetClass(e.target.value)}>
                  {ASSET_CLASSES.map((c) => (
                    <option key={c} value={c}>
                      {label(c)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="w-28">
              <Field label="Region" hint="e.g. GB">
                <Input
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                  minLength={2}
                  maxLength={40}
                  required
                />
              </Field>
            </div>
            <Button type="submit" disabled={!metric || loading} className="mb-5">
              {loading ? "Loading…" : "View distribution"}
            </Button>
          </form>
        </CardBody>
      </Card>

      {error ? (
        <LoadError message={error} onRetry={() => void load(metric, assetClass, region)} />
      ) : loading && !data ? (
        <Spinner label="Loading the distribution…" />
      ) : !data ? (
        <EmptyState
          title="Pick a cell to explore"
          hint="Choose a metric, asset class and region above. The first query for a metric materializes its illustrative seed distribution."
        />
      ) : (
        <>
          <HealthWarningBanner warning={data.healthWarning} />
          {data.accessLevel === "seed_only" ? <SeedOnlyNote note={data.note} /> : null}

          <Card>
            <CardBody>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-ink-900">
                    {metrics?.find((m) => m.key === data.metric)?.name ?? label(data.metric)}
                  </h3>
                  <p className="mt-0.5 text-xs text-ink-500">
                    {label(data.assetClass)} · {data.region} · {data.unit}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <DirectionBadge higherIsBetter={data.higherIsBetter} />
                  <AccessBadge level={data.accessLevel} />
                  {data.seedIncluded ? <Badge tone="amber">Includes seed rows</Badge> : null}
                </div>
              </div>
            </CardBody>
          </Card>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            <Stat
              label="Sample size n"
              value={dist ? dist.n : "—"}
              emphasized
              hint="Always disclosed"
            />
            <Stat label="Min" value={hasStats ? fmtNum(dist!.min) : "—"} />
            <Stat label="p25" value={hasStats ? fmtNum(dist!.p25) : "—"} />
            <Stat label="Median" value={hasStats ? fmtNum(dist!.median) : "—"} />
            <Stat label="p75" value={hasStats ? fmtNum(dist!.p75) : "—"} />
            <Stat label="p90" value={hasStats ? fmtNum(dist!.p90) : "—"} />
            <Stat label="Max" value={hasStats ? fmtNum(dist!.max) : "—"} />
          </div>

          {suppressed ? (
            <SuppressedCard n={dist!.n} minSampleN={data.minSampleN} />
          ) : dist && dist.n === 0 ? (
            <EmptyState
              title="No samples in this cell (n = 0)"
              hint={
                data.accessLevel === "contributed"
                  ? "No company has contributed a sample for this asset class and region yet."
                  : "No seed values exist for this asset class and region — try the GB cells, or contribute real samples."
              }
            />
          ) : hasStats ? (
            <>
              <Card>
                <CardBody>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
                    Histogram — {dist!.n} sample{dist!.n === 1 ? "" : "s"} in 10 equal-width bins
                  </h3>
                  <HistogramChart bins={dist!.histogram ?? []} unit={data.unit} />
                </CardBody>
              </Card>
              <Card>
                <CardBody>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
                    Percentile strip
                  </h3>
                  <PercentileStrip
                    unit={data.unit}
                    markers={[
                      { value: dist!.min!, label: "min" },
                      { value: dist!.p25!, label: "p25" },
                      { value: dist!.median!, label: "median" },
                      { value: dist!.p75!, label: "p75" },
                      { value: dist!.p90!, label: "p90" },
                      { value: dist!.max!, label: "max" },
                    ]}
                  />
                </CardBody>
              </Card>
            </>
          ) : null}

          <DisclosureList disclosures={data.disclosures} />
        </>
      )}
    </div>
  );
}
