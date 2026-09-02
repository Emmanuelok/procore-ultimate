/**
 * CVR & cash-flow tab (spec Vol II Domain B #184-189).
 *
 * Value is what the work is worth under the contract; cost is what it took.
 * The gap is margin, and the gap between value and what has been CERTIFIED is
 * over- or under-certification — the number that says whether the project is
 * quietly funding its client.
 *
 * Where a cost feed is missing the margin renders as "not available" with the
 * reason, never as a number. A project with no cost data does not have a 100%
 * margin; it has an unmeasured one.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import {
  Alert,
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
import { formatDate } from "../format";
import {
  money,
  money0,
  moneySigned,
  percent,
  StatCard,
  todayIso,
  type CvrResult,
  type ListResponse,
  type SCurveResult,
} from "./commercialShared";

interface CvrPeriodRow {
  id: string;
  periodEnd: string;
  currency: string;
  status: string;
  valueToDate: number;
  certifiedToDate: number;
  costToDate: number;
  margin: number;
  marginPercent: number | null;
  overUnderCertification: number;
  gaps: string[];
}

export default function CvrTab({
  projectId,
  currencies,
}: {
  projectId: string;
  currencies: string[];
}) {
  const [currency, setCurrency] = useState(currencies[0] ?? "");
  const [cvr, setCvr] = useState<CvrResult | null>(null);
  const [curve, setCurve] = useState<SCurveResult | null>(null);
  const [history, setHistory] = useState<CvrPeriodRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!currency && currencies[0]) setCurrency(currencies[0]);
  }, [currencies, currency]);

  const load = useCallback(
    async (save = false) => {
      setError(null);
      setLoading(true);
      try {
        const q = new URLSearchParams();
        if (currency) q.set("currency", currency);
        if (save) q.set("save", "true");
        const [c, s, h] = await Promise.all([
          api.get<CvrResult>(`/api/v1/projects/${projectId}/commercial/cvr?${q.toString()}`),
          api.get<SCurveResult>(
            `/api/v1/projects/${projectId}/commercial/cash-flow?${currency ? `currency=${currency}` : ""}`,
          ),
          api.get<ListResponse<CvrPeriodRow>>(
            `/api/v1/projects/${projectId}/commercial/cvr-history?pageSize=24`,
          ),
        ]);
        setCvr(c);
        setCurve(s);
        setHistory(h.items);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to compute the CVR");
      } finally {
        setLoading(false);
      }
    },
    [projectId, currency],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const displayCurrency = cvr?.currency ?? currency ?? "USD";
  const maxCumulative = Math.max(
    1,
    ...(curve?.points ?? []).map((p) => Math.max(p.plannedCumulative, p.actualCumulative ?? 0)),
  );

  return (
    <div className="space-y-8">
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink-900">
              Cost–value reconciliation to {formatDate(cvr?.periodEnd ?? todayIso())}
            </h2>
            <p className="mt-0.5 text-xs text-ink-500">
              Value from the latest application per bill; cost from subcontract invoices, approved
              timecards and verified dayworks.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {currencies.length > 1 ? (
              <Select
                className="w-28"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
              >
                {currencies.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            ) : null}
            <Button
              size="sm"
              disabled={saving}
              onClick={async () => {
                setSaving(true);
                await load(true);
                setSaving(false);
              }}
            >
              {saving ? "Saving…" : "Save this period"}
            </Button>
          </div>
        </div>

        <ErrorAlert message={error} />
        {loading ? <Spinner /> : null}

        {cvr ? (
          <>
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <StatCard label="Value to date" value={money0(cvr.valueToDate, displayCurrency)} />
              <StatCard
                label="Certified to date"
                value={money0(cvr.certifiedToDate, displayCurrency)}
              />
              <StatCard label="Cost to date" value={money0(cvr.costToDate, displayCurrency)} />
              <StatCard label="WIP (uncertified)" value={money0(cvr.wip, displayCurrency)} />
              <StatCard
                label="Margin"
                value={money0(cvr.margin, displayCurrency)}
                hint={cvr.marginPercent != null ? percent(cvr.marginPercent) : undefined}
                tone="emphasis"
              />
              <StatCard
                label={
                  (cvr.overUnderCertification ?? 0) >= 0 ? "Over-certified" : "Under-certified"
                }
                value={money0(
                  cvr.overUnderCertification == null
                    ? null
                    : Math.abs(cvr.overUnderCertification),
                  displayCurrency,
                )}
              />
            </div>

            {cvr.gaps.length > 0 ? (
              <Alert tone="warning" className="mb-4" title="What could not be measured">
                <ul className="mt-1 space-y-0.5 text-xs">
                  {cvr.gaps.map((g) => (
                    <li key={g}>• {g}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}

            <Table>
              <thead>
                <tr>
                  <Th>Scope</Th>
                  <Th className="text-right">Value</Th>
                  <Th className="text-right">Cost</Th>
                  <Th className="text-right">Accruals</Th>
                  <Th className="text-right">Margin</Th>
                  <Th className="text-right">%</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {cvr.rows.map((r) => (
                  <tr
                    key={`${r.scope}-${r.label}`}
                    className={r.scope === "project" ? "bg-ink-50 font-medium" : ""}
                  >
                    <Td>
                      {r.label}
                      {r.scope === "project" ? (
                        <Badge tone="blue" className="ml-2">
                          Project
                        </Badge>
                      ) : null}
                    </Td>
                    <Td className="text-right tabular-nums">{money(r.valueToDate, displayCurrency)}</Td>
                    <Td className="text-right tabular-nums">{money(r.costToDate, displayCurrency)}</Td>
                    <Td className="text-right tabular-nums">{money(r.accruals, displayCurrency)}</Td>
                    <Td
                      className={
                        (r.margin ?? 0) < 0
                          ? "text-right tabular-nums text-red-600"
                          : "text-right tabular-nums"
                      }
                    >
                      {money(r.margin, displayCurrency)}
                    </Td>
                    <Td className="text-right tabular-nums">{percent(r.marginPercent)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </>
        ) : null}
      </section>

      <section>
        <h2 className="mb-1 text-sm font-semibold text-ink-900">Cash-flow S-curve</h2>
        <p className="mb-3 text-xs text-ink-500">
          Bill value spread over the linked programme tasks, with certified value overlaid.
        </p>
        {curve === null ? (
          <Spinner />
        ) : curve.points.length === 0 ? (
          <EmptyState
            title="No curve to draw"
            hint={curve.reasons[0] ?? "Link BQ items to schedule tasks to spread the value."}
          />
        ) : (
          <Card>
            <CardBody>
              <div className="flex h-56 items-end gap-1">
                {curve.points.map((p) => (
                  <div key={p.period} className="flex flex-1 flex-col items-center gap-0.5">
                    <div className="relative flex h-48 w-full items-end justify-center">
                      <div
                        className="w-full rounded-t bg-brand-200"
                        style={{ height: `${(p.plannedCumulative / maxCumulative) * 100}%` }}
                        title={`Planned ${money(p.plannedCumulative, curve.currency)}`}
                      />
                      {p.actualCumulative != null ? (
                        <div
                          className="absolute bottom-0 w-1/2 rounded-t bg-brand-700"
                          style={{ height: `${(p.actualCumulative / maxCumulative) * 100}%` }}
                          title={`Certified ${money(p.actualCumulative, curve.currency)}`}
                        />
                      ) : null}
                    </div>
                    <span className="rotate-45 text-[10px] text-ink-400">{p.period.slice(2)}</span>
                  </div>
                ))}
              </div>
              <div className="mt-6 flex flex-wrap items-center gap-4 text-xs text-ink-500">
                <span className="flex items-center gap-1">
                  <span className="h-2 w-3 rounded bg-brand-200" /> Planned cumulative
                </span>
                <span className="flex items-center gap-1">
                  <span className="h-2 w-3 rounded bg-brand-700" /> Certified cumulative
                </span>
                <span className="ml-auto">
                  {money(curve.totalAllocated, curve.currency)} allocated
                  {curve.unallocated > 0
                    ? ` · ${money(curve.unallocated, curve.currency)} unallocated`
                    : ""}
                </span>
              </div>
              {curve.reasons.length > 0 ? (
                <ul className="mt-2 space-y-0.5 text-xs text-ink-400">
                  {curve.reasons.map((r) => (
                    <li key={r}>• {r}</li>
                  ))}
                </ul>
              ) : null}
            </CardBody>
          </Card>
        )}
      </section>

      {history.length > 0 ? (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-ink-900">Saved CVR periods</h2>
          <Table>
            <thead>
              <tr>
                <Th>Period end</Th>
                <Th className="text-right">Value</Th>
                <Th className="text-right">Certified</Th>
                <Th className="text-right">Cost</Th>
                <Th className="text-right">Margin</Th>
                <Th className="text-right">Over/under</Th>
                <Th>Gaps</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {history.map((h) => (
                <tr key={h.id}>
                  <Td className="whitespace-nowrap">{formatDate(h.periodEnd)}</Td>
                  <Td className="text-right tabular-nums">{money(h.valueToDate, h.currency)}</Td>
                  <Td className="text-right tabular-nums">
                    {money(h.certifiedToDate, h.currency)}
                  </Td>
                  <Td className="text-right tabular-nums">{money(h.costToDate, h.currency)}</Td>
                  <Td className="text-right tabular-nums">{money(h.margin, h.currency)}</Td>
                  <Td className="text-right tabular-nums">
                    {moneySigned(h.overUnderCertification, h.currency)}
                  </Td>
                  <Td className="text-xs text-ink-400">{h.gaps.length}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
      ) : null}
    </div>
  );
}
