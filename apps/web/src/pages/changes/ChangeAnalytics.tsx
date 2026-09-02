/**
 * CHANGE ANALYTICS (#560–562) — ageing, cycle time, pass-down leaks.
 *
 * Every figure comes from dated status transitions the API materialises as
 * changes move. A stage with no dated sample says so (`reasons`) rather than
 * rendering a zero; money at risk is per object type and never summed across
 * the commitments' currencies.
 */
import { useMemo } from "react";
import { Alert, Badge, Card, CardBody, CardHeader, EmptyState, ErrorAlert, Stat } from "../../ui";
import { BarChart, ChartCard } from "../../ui/charts";
import { IconClock } from "../../ui/icons";
import { PanelSkeleton, label, num, useResource } from "./changesShared";

interface AgeingResponse {
  asOf: string;
  items: Array<{
    objectType: string;
    id: string;
    reference: string;
    title: string;
    status: string;
    amount: number;
    sinceAt: string;
    anchoredOn: "history" | "createdAt";
    daysInStatus: number;
    bucket: string;
  }>;
  buckets: Array<{ bucket: string; count: number; byType: Array<{ objectType: string; count: number; amount: number }> }>;
  oldest: { reference: string; daysInStatus: number; status: string } | null;
  note: string | null;
}

interface StageStat {
  from: string;
  to: string;
  n: number;
  medianDays: number | null;
  p90Days: number | null;
  maxDays: number | null;
  reasons: string[];
}

interface CycleTimeResponse {
  pcos: number;
  overall: StageStat[];
  byReason: Array<{ key: string; n: number; stages: StageStat[] }>;
  byVendor: Array<{ key: string; n: number; stages: StageStat[]; vendorName: string | null }>;
  note: string | null;
}

interface PassDownResponse {
  revenueUpCostNotDown: Array<Record<string, unknown>>;
  costDownNeverBilled: Array<Record<string, unknown>>;
  summary: { revenueUpCostNotDown: number; costDownNeverBilled: number; note: string };
}

const TYPE_LABEL: Record<string, string> = {
  potential_change_order: "PCOs",
  change_order_request: "CORs",
  change_order_package: "Packages",
};

export default function ChangeAnalytics({ projectId }: { projectId: string }) {
  const ageing = useResource<AgeingResponse>(`/api/v1/projects/${projectId}/change-log/ageing`);
  const cycle = useResource<CycleTimeResponse>(`/api/v1/projects/${projectId}/change-log/cycle-time`);
  const passDown = useResource<PassDownResponse>(`/api/v1/projects/${projectId}/change-log/pass-down`);

  const ageingData = useMemo(
    () =>
      (ageing.data?.buckets ?? []).map((b) => ({
        bucket: `${b.bucket} days`,
        PCOs: b.byType.find((t) => t.objectType === "potential_change_order")?.count ?? 0,
        CORs: b.byType.find((t) => t.objectType === "change_order_request")?.count ?? 0,
        Packages: b.byType.find((t) => t.objectType === "change_order_package")?.count ?? 0,
      })),
    [ageing.data],
  );

  const cycleData = useMemo(
    () =>
      (cycle.data?.overall ?? [])
        .filter((s) => !(s.from === "identified" && s.to === "executed"))
        .map((s) => ({ stage: `${label(s.from)} → ${label(s.to)}`, median: s.medianDays ?? 0, p90: s.p90Days ?? 0, n: s.n })),
    [cycle.data],
  );
  const endToEnd = cycle.data?.overall.find((s) => s.from === "identified" && s.to === "executed") ?? null;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Oldest open item"
          value={ageing.data?.oldest ? `${ageing.data.oldest.daysInStatus} d` : "—"}
          hint={ageing.data?.oldest ? `${ageing.data.oldest.reference} · ${label(ageing.data.oldest.status)}` : "nothing open, or not loaded"}
          loading={ageing.loading}
        />
        <Stat
          label="Identified → executed (median)"
          value={endToEnd && endToEnd.medianDays !== null ? `${num(endToEnd.medianDays, 0)} d` : "—"}
          hint={endToEnd && endToEnd.n > 0 ? `p90 ${num(endToEnd.p90Days ?? 0, 0)} d over ${endToEnd.n} PCO(s)` : (endToEnd?.reasons[0] ?? "no dated sample yet")}
          loading={cycle.loading}
        />
        <Stat
          label="Pass-down leaks"
          value={passDown.data ? passDown.data.summary.revenueUpCostNotDown + passDown.data.summary.costDownNeverBilled : "—"}
          hint={passDown.data ? `${passDown.data.summary.revenueUpCostNotDown} revenue-up / ${passDown.data.summary.costDownNeverBilled} cost-down` : "not loaded"}
          tone={passDown.data && passDown.data.summary.revenueUpCostNotDown > 0 ? "danger" : undefined}
          loading={passDown.loading}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Ageing — days in current status" subtitle="Live PCOs, owner requests and packages, bucketed; the oldest is named above." icon={IconClock}>
          {ageing.error ? (
            <ErrorAlert message={ageing.error} />
          ) : ageing.loading && !ageing.data ? (
            <PanelSkeleton rows={4} />
          ) : ageingData.every((d) => d.PCOs + d.CORs + d.Packages === 0) ? (
            <EmptyState title="Nothing is ageing" hint="No open change record on this project — not a zero, an empty register." />
          ) : (
            <BarChart data={ageingData} categoryKey="bucket" stacked series={[{ key: "PCOs" }, { key: "CORs" }, { key: "Packages" }]} height={220} />
          )}
          {ageing.data?.note ? <p className="mt-2 text-2xs text-content-subtle">{ageing.data.note}</p> : null}
        </ChartCard>

        <ChartCard title="Cycle time by stage" subtitle="Median and p90 days between stages, over dated transitions only." icon={IconClock}>
          {cycle.error ? (
            <ErrorAlert message={cycle.error} />
          ) : cycle.loading && !cycle.data ? (
            <PanelSkeleton rows={4} />
          ) : cycleData.every((d) => d.n === 0) ? (
            <EmptyState title="No cycle time yet" hint={cycle.data?.note ?? "Cycle times need dated transitions and fill in as changes move."} />
          ) : (
            <BarChart data={cycleData} categoryKey="stage" series={[{ key: "median", label: "Median days" }, { key: "p90", label: "p90 days" }]} height={220} />
          )}
          {cycle.data ? (
            <ul className="mt-2 space-y-0.5 text-2xs text-content-subtle">
              {cycle.data.overall.map((s) => (
                <li key={`${s.from}-${s.to}`}>
                  {label(s.from)} → {label(s.to)}: {s.n === 0 ? s.reasons[0] : `n=${s.n}, median ${num(s.medianDays ?? 0, 0)} d, p90 ${num(s.p90Days ?? 0, 0)} d, max ${num(s.maxDays ?? 0, 0)} d`}
                </li>
              ))}
            </ul>
          ) : null}
        </ChartCard>
      </div>

      {cycle.data && (cycle.data.byReason.length > 0 || cycle.data.byVendor.length > 0) ? (
        <Card>
          <CardHeader title="Cycle time by reason and by vendor" subtitle="Identified → executed, median days, where a dated sample exists." />
          <CardBody className="grid gap-4 md:grid-cols-2">
            {[
              { title: "By reason", groups: cycle.data.byReason },
              { title: "By vendor", groups: cycle.data.byVendor },
            ].map(({ title, groups }) => (
              <div key={title}>
                <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">{title}</p>
                {groups.length === 0 ? (
                  <p className="text-meta italic text-content-subtle">No group has a dated sample.</p>
                ) : (
                  <ul className="space-y-1 text-meta">
                    {groups.map((g) => {
                      const e2e = g.stages.find((s) => s.from === "identified" && s.to === "executed");
                      return (
                        <li key={g.key} className="flex items-center justify-between">
                          <span>{label(g.key)}</span>
                          <span className="tabular-nums">
                            {e2e && e2e.medianDays !== null ? `${num(e2e.medianDays, 0)} d (n=${e2e.n})` : <span className="italic text-content-subtle">no executed sample</span>}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Pass-down leaks"
          subtitle="Revenue executed on the owner side whose subcontract cost was never passed down, and the inverse. Amounts are per row in the commitment's own currency."
          actions={passDown.data ? <Badge tone={passDown.data.summary.revenueUpCostNotDown > 0 ? "danger" : "success"}>{passDown.data.summary.revenueUpCostNotDown > 0 ? "leaks found" : "clean"}</Badge> : null}
        />
        <CardBody className="space-y-3">
          <ErrorAlert message={passDown.error} />
          {passDown.loading && !passDown.data ? <PanelSkeleton rows={3} /> : null}
          {passDown.data ? (
            <>
              {passDown.data.revenueUpCostNotDown.length === 0 && passDown.data.costDownNeverBilled.length === 0 ? (
                <Alert tone="success" variant="subtle" size="sm" title="Every executed change ties out in both directions">
                  No executed owner package is missing its subcontract pass-down, and no executed commitment package is unbilled to the owner.
                </Alert>
              ) : null}
              {passDown.data.revenueUpCostNotDown.length > 0 ? (
                <div>
                  <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-danger-fg">Revenue up, cost not passed down</p>
                  <table className="w-full text-meta">
                    <thead>
                      <tr className="text-left text-content-subtle">
                        <th className="py-1">Owner package</th>
                        <th className="py-1">COR</th>
                        <th className="py-1">PCO</th>
                        <th className="py-1 text-right">Subcontract cost</th>
                        <th className="py-1 text-right">Ageing</th>
                      </tr>
                    </thead>
                    <tbody>
                      {passDown.data.revenueUpCostNotDown.map((r) => (
                        <tr key={`${String(r["primePackageId"])}-${String(r["pcoId"])}`} className="border-t border-border-subtle">
                          <td className="py-1 font-mono">{String(r["primePackageReference"])}</td>
                          <td className="py-1 font-mono">{String(r["corReference"])}</td>
                          <td className="py-1 font-mono">{String(r["pcoReference"])} <Badge size="xs" tone="neutral" variant="outline">{label(String(r["pcoStatus"]))}</Badge></td>
                          <td className="py-1 text-right tabular-nums">{num(Number(r["subcontractCost"]), 2)}</td>
                          <td className="py-1 text-right tabular-nums">{r["ageingDays"] === null ? "—" : `${String(r["ageingDays"])} d`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              {passDown.data.costDownNeverBilled.length > 0 ? (
                <div>
                  <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-warning-fg">Cost passed down, never billed to the owner</p>
                  <ul className="space-y-1 text-meta">
                    {passDown.data.costDownNeverBilled.map((r) => (
                      <li key={`${String(r["commitmentPackageId"])}-${String(r["pcoId"])}`}>
                        <span className="font-mono">{String(r["commitmentPackageReference"])}</span> · <span className="font-mono">{String(r["pcoReference"])}</span> · {num(Number(r["amount"]), 2)} — {String(r["reason"])}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <p className="text-2xs text-content-subtle">{passDown.data.summary.note}</p>
            </>
          ) : null}
        </CardBody>
      </Card>
    </div>
  );
}
