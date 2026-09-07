/**
 * Dispute outcome database and drafting recommendations — company level
 * (spec Vol II Domain E #356-357).
 *
 * Only terminal disputes count: a live dispute has no outcome, and counting
 * it would drag every rate toward zero. Rates whose sample is too small to
 * mean anything are marked thin rather than quietly presented as fact, and
 * money is reported per currency because awards in different currencies are
 * not the same quantity.
 */
import { useCallback, useEffect, useState } from "react";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Field,
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import { humanize } from "../format";
import { fmtMoney } from "./disputesShared";

interface GroupMetrics {
  key: string;
  label: string;
  disputes: number;
  winRate: number | null;
  winRateSample: number;
  awardRatio: number | null;
  awardRatioSample: number;
  averageDurationDays: number | null;
  durationSample: number;
  costPerUnitRecovered: Array<{ currency: string; ratio: number | null; sample: number }>;
  recoveredByCurrency: Array<{ currency: string; amount: number }>;
  costsByCurrency: Array<{ currency: string; amount: number }>;
  thin: boolean;
}

interface AnalyticsResponse {
  overall: GroupMetrics | null;
  groups: GroupMetrics[];
  groupedBy?: string;
  excludedNotTerminal?: number;
  basis?: string;
  reason?: string;
  scoped?: boolean;
}

interface Recommendation {
  subject: string;
  dimension: string;
  disputes: number;
  citedDisputeIds: string[];
  averageDurationDays: number | null;
  recoveredByCurrency: Array<{ currency: string; amount: number }>;
  costsByCurrency: Array<{ currency: string; amount: number }>;
  awardRatio: number | null;
  headline: string;
  thin: boolean;
}

interface RecommendationsResponse {
  recommendations: Recommendation[];
  disputesConsidered?: number;
  reason: string | null;
  scoped?: boolean;
}

const GROUPINGS = [
  { key: "rootCause", label: "Root cause" },
  { key: "forum", label: "Forum" },
  { key: "kind", label: "Kind" },
  { key: "jurisdiction", label: "Jurisdiction" },
  { key: "contractFamily", label: "Contract family" },
  { key: "governingClause", label: "Governing clause" },
];

function pct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(0)}%`;
}

function moneyList(rows: Array<{ currency: string; amount: number }>): string {
  if (rows.length === 0) return "—";
  return rows.map((r) => fmtMoney(r.amount, r.currency)).join(" · ");
}

export default function DisputeAnalyticsPage() {
  const [groupBy, setGroupBy] = useState("rootCause");
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [recs, setRecs] = useState<RecommendationsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [a, r] = await Promise.all([
        api.get<AnalyticsResponse>(`/api/v1/disputes/analytics?groupBy=${groupBy}`),
        api.get<RecommendationsResponse>("/api/v1/disputes/drafting-recommendations"),
      ]);
      setData(a);
      setRecs(r);
    } catch (err) {
      setData({ overall: null, groups: [] });
      setRecs({ recommendations: [], reason: null });
      setError(err instanceof ApiClientError ? err.message : "Could not load dispute analytics");
    }
  }, [groupBy]);

  useEffect(() => {
    void load();
  }, [load]);

  if (data === null && error === null) return <Spinner label="Loading dispute analytics…" />;

  const overall = data?.overall ?? null;

  return (
    <div>
      <PageHeader
        title="Dispute outcomes"
        subtitle="What disputes actually cost and recover — the outcome database behind contract drafting"
        actions={
          <div className="w-52">
            <Field label="Group by">
              <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
                {GROUPINGS.map((g) => (
                  <option key={g.key} value={g.key}>
                    {g.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        }
      />

      <ErrorAlert message={error} />

      {data?.reason ? (
        <div className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
          {data.reason}
        </div>
      ) : null}

      {overall === null ? (
        <EmptyState
          title="No terminal disputes yet"
          hint="Win rates, award ratios and cost of recovery are computed only from disputes that have been decided, settled or withdrawn."
        />
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Card>
              <CardBody className="px-4 py-3">
                <div className="text-xl font-bold tabular-nums text-ink-900">
                  {overall.disputes}
                </div>
                <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
                  Terminal disputes
                </div>
              </CardBody>
            </Card>
            <Card>
              <CardBody className="px-4 py-3">
                <div className="text-xl font-bold tabular-nums text-ink-900">
                  {pct(overall.winRate)}
                </div>
                <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
                  Win rate
                </div>
                <div className="text-[11px] text-ink-400">n = {overall.winRateSample}</div>
              </CardBody>
            </Card>
            <Card>
              <CardBody className="px-4 py-3">
                <div className="text-xl font-bold tabular-nums text-ink-900">
                  {overall.awardRatio === null ? "—" : `${(overall.awardRatio * 100).toFixed(0)}%`}
                </div>
                <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
                  Awarded / claimed
                </div>
                <div className="text-[11px] text-ink-400">n = {overall.awardRatioSample}</div>
              </CardBody>
            </Card>
            <Card>
              <CardBody className="px-4 py-3">
                <div className="text-xl font-bold tabular-nums text-ink-900">
                  {overall.averageDurationDays === null
                    ? "—"
                    : `${Math.round(overall.averageDurationDays)}d`}
                </div>
                <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
                  Mean duration
                </div>
                <div className="text-[11px] text-ink-400">n = {overall.durationSample}</div>
              </CardBody>
            </Card>
            <Card>
              <CardBody className="px-4 py-3">
                <div className="text-sm font-semibold tabular-nums text-ink-900">
                  {moneyList(overall.recoveredByCurrency)}
                </div>
                <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
                  Recovered
                </div>
                <div className="text-[11px] text-ink-400">
                  costs {moneyList(overall.costsByCurrency)}
                </div>
              </CardBody>
            </Card>
          </div>

          <Card className="mb-6">
            <CardBody>
              <h3 className="mb-2 text-sm font-semibold text-ink-900">
                By {GROUPINGS.find((g) => g.key === groupBy)?.label.toLowerCase() ?? groupBy}
              </h3>
              {data && data.groups.length === 0 ? (
                <p className="py-3 text-center text-xs text-ink-400">
                  No terminal dispute carries this attribute yet.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <thead>
                      <tr>
                        <Th>Group</Th>
                        <Th className="text-right">Disputes</Th>
                        <Th className="text-right">Win rate</Th>
                        <Th className="text-right">Award ratio</Th>
                        <Th className="text-right">Mean duration</Th>
                        <Th>Recovered</Th>
                        <Th>Cost of recovery</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-100">
                      {(data?.groups ?? []).map((g) => (
                        <tr key={g.key}>
                          <Td className="text-sm">
                            {g.label}
                            {g.thin ? (
                              <Badge tone="amber" className="ml-1.5">
                                thin
                              </Badge>
                            ) : null}
                          </Td>
                          <Td className="text-right tabular-nums">{g.disputes}</Td>
                          <Td className="text-right tabular-nums">
                            {pct(g.winRate)}
                            <div className="text-[11px] text-ink-400">n = {g.winRateSample}</div>
                          </Td>
                          <Td className="text-right tabular-nums">
                            {g.awardRatio === null ? "—" : `${(g.awardRatio * 100).toFixed(0)}%`}
                          </Td>
                          <Td className="text-right tabular-nums">
                            {g.averageDurationDays === null
                              ? "—"
                              : `${Math.round(g.averageDurationDays)}d`}
                          </Td>
                          <Td className="text-xs">{moneyList(g.recoveredByCurrency)}</Td>
                          <Td className="text-xs">
                            {g.costPerUnitRecovered.length === 0
                              ? "—"
                              : g.costPerUnitRecovered
                                  .map((c) =>
                                    c.ratio === null
                                      ? `${c.currency} n/a`
                                      : `${c.currency} ${(c.ratio * 100).toFixed(0)}%`,
                                  )
                                  .join(" · ")}
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              )}
              {data?.basis ? (
                <p className="mt-2 text-xs leading-5 text-ink-400">
                  {data.basis}
                  {data.excludedNotTerminal
                    ? ` ${data.excludedNotTerminal} live dispute(s) are excluded.`
                    : ""}
                </p>
              ) : null}
            </CardBody>
          </Card>
        </>
      )}

      {/* -------------------------- drafting recommendations ---------------------- */}
      <Card>
        <CardBody>
          <h3 className="mb-1 text-sm font-semibold text-ink-900">
            What the outcomes say about our contracts (#357)
          </h3>
          <p className="mb-3 text-xs text-ink-400">
            Every recommendation cites the disputes behind it — nothing here is asserted that cannot
            be traced to a record.
          </p>
          {!recs || recs.recommendations.length === 0 ? (
            <p className="rounded-md bg-ink-50 px-3 py-2 text-xs text-ink-500 ring-1 ring-ink-100">
              {recs?.reason ??
                "No drafting pattern is available yet."}
            </p>
          ) : (
            <ul className="divide-y divide-ink-100">
              {recs.recommendations.map((r) => (
                <li key={`${r.dimension}-${r.subject}`} className="py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="violet">{humanize(r.dimension)}</Badge>
                    <span className="text-sm font-semibold text-ink-900">{r.subject}</span>
                    <span className="text-xs text-ink-500">
                      {r.disputes} dispute{r.disputes === 1 ? "" : "s"}
                    </span>
                    {r.thin ? <Badge tone="amber">thin sample</Badge> : null}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-ink-700">{r.headline}</p>
                  <div className="mt-1 text-[11px] text-ink-400">
                    recovered {moneyList(r.recoveredByCurrency)} · costs{" "}
                    {moneyList(r.costsByCurrency)} · cites {r.citedDisputeIds.length} record
                    {r.citedDisputeIds.length === 1 ? "" : "s"}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
