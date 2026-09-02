/**
 * OVERVIEW — what this project's estimating position actually is: the money
 * bucketed by currency (never summed across them), the composition of the
 * live estimate by cost type, the historical rate reference, and everything
 * the hygiene sweeps have found wrong.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Drawer,
  EmptyState,
  Input,
  Progress,
  Table,
  Td,
  Th,
  toast,
  type DataColumns,
} from "../../ui";
import { IconEmpty, IconRefresh, IconSearch } from "../../ui/icons";
import {
  BasisList,
  DASH,
  DETECTOR_LABEL,
  LoadError,
  ReasonList,
  Row,
  count,
  dateTime,
  money,
  money0,
  num,
  pct,
  severityTone,
  titleCase,
  useAction,
  useResource,
  estimatingApi,
  type EstimatingSignal,
  type EstimatingSummary,
  type HistoricalRates,
  type Loadable,
  type Paginated,
  type SweepResult,
} from "./estimatingShared";

export default function OverviewTab({
  projectId,
  summary,
  onChanged,
}: {
  projectId: string;
  summary: Loadable<EstimatingSummary>;
  onChanged: () => void;
}) {
  const s = summary.data;
  const action = useAction();
  const [lastSweep, setLastSweep] = useState<SweepResult | null>(null);
  const [openSignal, setOpenSignal] = useState<EstimatingSignal | null>(null);
  const [rateQuery, setRateQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");

  const risks = useResource<Paginated<EstimatingSignal>>(
    `/api/v1/projects/${projectId}/estimating/risks?page=1&pageSize=100`,
  );
  const history = useResource<HistoricalRates>(
    submittedQuery.trim().length > 0
      ? `/api/v1/projects/${projectId}/estimating/historical-rates?search=${encodeURIComponent(submittedQuery.trim())}`
      : null,
  );

  async function runSweep() {
    const res = await action.run("sweep", () => estimatingApi.sweep(projectId));
    if (res) {
      setLastSweep(res);
      toast.success(
        `Sweeps complete — ${res.quotes.signalsRaised + res.hygiene.signalsRaised} new finding${
          res.quotes.signalsRaised + res.hygiene.signalsRaised === 1 ? "" : "s"
        }`,
      );
      risks.reload();
      onChanged();
    }
  }

  const signalColumns = useMemo<DataColumns<EstimatingSignal>>(
    () => [
      {
        id: "severity",
        header: "Severity",
        accessor: "severity",
        type: "text",
        width: 110,
        cell: ({ row }) => (
          <Badge tone={severityTone(row.severity)} size="xs" dot>
            {titleCase(row.severity)}
          </Badge>
        ),
      },
      {
        id: "detector",
        header: "Finding",
        accessor: (row) => DETECTOR_LABEL[row.detector] ?? row.detector,
        type: "text",
        width: 170,
      },
      { id: "title", header: "What was found", accessor: "title", type: "text", width: 480 },
      {
        id: "disposition",
        header: "Disposition",
        accessor: "disposition",
        type: "text",
        width: 120,
        cell: ({ row }) => titleCase(row.disposition),
      },
      {
        id: "createdAt",
        header: "Raised",
        accessor: "createdAt",
        type: "datetime",
        width: 160,
        cell: ({ row }) => dateTime(row.createdAt),
      },
    ],
    [],
  );

  const composition = useMemo(() => {
    if (!s?.latestEstimate) return null;
    return s.latestEstimate;
  }, [s]);

  return (
    <div className="space-y-4">
      {summary.error ? <LoadError message={summary.error} onRetry={summary.reload} /> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Priced value by currency"
            subtitle="Buckets, never a sum. Two estimates in two currencies are two facts, and adding them would require an exchange rate nobody recorded."
          />
          <CardBody>
            {!s ? (
              <div className="text-meta text-content-subtle">Loading…</div>
            ) : s.byCurrency.length === 0 ? (
              <EmptyState
                icon={IconEmpty}
                title="Nothing priced yet"
                description="No live estimate on this project carries a value. Create one on the Estimates tab."
              />
            ) : (
              <>
                <Table>
                  <thead>
                    <tr>
                      <Th>Currency</Th>
                      <Th>Estimates</Th>
                      <Th align="right">Direct cost</Th>
                      <Th align="right">Markup</Th>
                      <Th align="right">Total</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.byCurrency.map((bucket) => (
                      <tr key={bucket.currency}>
                        <Td>
                          <Badge tone="neutral" size="xs">
                            {bucket.currency}
                          </Badge>
                        </Td>
                        <Td>{count(bucket.estimates)}</Td>
                        <Td align="right">{money0(bucket.directCost, bucket.currency)}</Td>
                        <Td align="right">{money0(bucket.markup, bucket.currency)}</Td>
                        <Td align="right" className="font-semibold">
                          {money0(bucket.total, bucket.currency)}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                {s.crossCurrency.value === null ? (
                  <div className="mt-3">
                    <Alert tone="info" size="sm" title="No single total">
                      <ReasonList reasons={s.crossCurrency.reasons} />
                    </Alert>
                  </div>
                ) : null}
              </>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Composition of the latest estimate"
            subtitle={
              composition
                ? `${composition.reference} rev ${composition.version} — ${composition.lineCount} lines, ${num(composition.labourHours, 1)} labour hours`
                : "No estimate has been priced yet."
            }
          />
          <CardBody>
            {!s ? (
              <div className="text-meta text-content-subtle">Loading…</div>
            ) : !composition ? (
              <EmptyState
                icon={IconEmpty}
                title="Nothing to break down"
                description="An estimate's cost-type split appears here once it has priced lines."
              />
            ) : (
              <CompositionBreakdown projectId={projectId} estimateId={composition.id} />
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="What the sweeps found"
          subtitle="Stale catalogue rates, estimates resting on them, approved estimates nobody converted, measurements nobody priced, and quotes out of validity. Each is raised once and closed automatically when it clears."
          actions={
            <Button size="sm" icon={IconRefresh} onClick={() => void runSweep()} loading={action.busy === "sweep"}>
              Run the sweeps now
            </Button>
          }
        />
        <CardBody flush>
          {action.error ? (
            <div className="p-3">
              <Alert tone="danger" size="sm">
                {action.error}
              </Alert>
            </div>
          ) : null}
          {lastSweep ? (
            <div className="border-b border-border px-4 py-2 text-2xs text-content-subtle">
              Last run {dateTime(lastSweep.hygiene.ranAt)}: {count(lastSweep.quotes.expired)} quotes expired,{" "}
              {count(lastSweep.quotes.expiring)} expiring, {count(lastSweep.hygiene.catalogueFlagged)} catalogue
              rates flagged for review, {count(lastSweep.hygiene.staleRateEstimates)} estimates on stale rates,{" "}
              {count(lastSweep.hygiene.unconvertedEstimates)} approved but unconverted,{" "}
              {count(lastSweep.hygiene.unpricedTakeoffItems)} unpriced measurements. The sweeps run company-wide.
            </div>
          ) : null}
          {risks.error ? (
            <div className="p-4">
              <LoadError message={risks.error} onRetry={risks.reload} />
            </div>
          ) : (
            <DataTable<EstimatingSignal>
              tableId="estimating.risks"
              data={risks.data?.items ?? []}
              columns={signalColumns}
              getRowId={(row) => row.id}
              loading={risks.loading && !risks.data}
              height={320}
              rowHeight={44}
              stickyHeader
              flush
              toolbar={false}
              empty={{
                title: "Nothing open",
                description:
                  "The sweeps found no stale rate, unconverted estimate, unpriced measurement or lapsed quote on this project. That is not the same as none being possible — run them now to check.",
              }}
              onRowClick={({ row }) => setOpenSignal(row)}
              rowTone={(row) => severityTone(row.severity)}
              aria-label="Estimating findings"
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Historical cost reference (#207)"
          subtitle="What this company has priced the same work at before, taken from its own approved and converted estimates. Buckets by currency and unit; a single past line is a data point, not a distribution."
        />
        <CardBody>
          <form
            className="mb-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setSubmittedQuery(rateQuery);
            }}
          >
            <Input
              value={rateQuery}
              onChange={(e) => setRateQuery(e.target.value)}
              placeholder="Search past priced lines, e.g. blockwork"
              leading={IconSearch}
              className="max-w-md"
            />
            <Button type="submit" variant="secondary" size="md" disabled={rateQuery.trim().length === 0}>
              Look up
            </Button>
          </form>
          {submittedQuery.trim().length === 0 ? (
            <p className="text-meta text-content-subtle">
              Enter a description to see what it has been priced at before.
            </p>
          ) : history.error ? (
            <LoadError message={history.error} onRetry={history.reload} />
          ) : history.loading ? (
            <div className="text-meta text-content-subtle">Looking…</div>
          ) : history.data && history.data.distributions.length === 0 ? (
            <Alert tone="info" size="sm" title="No historical rate on record">
              <ReasonList reasons={history.data.reasons} />
            </Alert>
          ) : history.data ? (
            <>
              <Table>
                <thead>
                  <tr>
                    <Th>Currency / unit</Th>
                    <Th align="right">n</Th>
                    <Th align="right">Projects</Th>
                    <Th align="right">Low</Th>
                    <Th align="right">Median</Th>
                    <Th align="right">High</Th>
                  </tr>
                </thead>
                <tbody>
                  {history.data.distributions.map((d) => (
                    <tr key={`${d.currency}-${d.unit}`}>
                      <Td>
                        {d.currency} / {d.unit}
                        <div className="text-2xs text-content-subtle">{d.basis}</div>
                      </Td>
                      <Td align="right">{count(d.n)}</Td>
                      <Td align="right">{count(d.projects)}</Td>
                      <Td align="right">{money(d.low, d.currency)}</Td>
                      <Td align="right" className="font-semibold">
                        {money(d.median, d.currency)}
                      </Td>
                      <Td align="right">{money(d.high, d.currency)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <div className="mt-3 text-2xs text-content-subtle">
                {history.data.samples.length} sample line
                {history.data.samples.length === 1 ? "" : "s"}, most recent first:{" "}
                {history.data.samples
                  .slice(0, 5)
                  .map((x) => `${x.estimateReference} ${money(x.unitRate, x.currency)}/${x.unit ?? DASH}`)
                  .join(" · ")}
              </div>
            </>
          ) : null}
        </CardBody>
      </Card>

      <Drawer
        open={openSignal !== null}
        onClose={() => setOpenSignal(null)}
        size="md"
        title={openSignal ? openSignal.title : "Finding"}
        description={
          openSignal
            ? `${DETECTOR_LABEL[openSignal.detector] ?? openSignal.detector} · ${titleCase(openSignal.severity)} · ${pct(openSignal.confidence, 0)} confidence`
            : undefined
        }
      >
        {openSignal ? (
          <div className="space-y-4">
            <p className="text-meta text-content">{openSignal.explanation}</p>
            <dl className="divide-y divide-border">
              <Row label="Disposition">{titleCase(openSignal.disposition)}</Row>
              <Row label="Raised">{dateTime(openSignal.createdAt)}</Row>
            </dl>
            <div>
              <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
                Evidence references
              </div>
              <pre className="overflow-x-auto rounded-md border border-border bg-surface-sunken p-2 text-2xs text-content">
                {JSON.stringify(openSignal.evidenceRefs, null, 2)}
              </pre>
            </div>
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}

/** The cost-type split of one estimate, with the labour-hour count beside it. */
function CompositionBreakdown({ projectId, estimateId }: { projectId: string; estimateId: string }) {
  const estimate = useResource<{
    currency: string;
    directCostTotal: number;
    labourTotal: number;
    materialTotal: number;
    equipmentTotal: number;
    subcontractTotal: number;
    otherTotal: number;
    markupTotal: number;
    total: number;
    labourHours: number;
    alternateTotal: number;
    excludedTotal: number;
    warnings: string[];
  }>(`/api/v1/projects/${projectId}/estimates/${estimateId}`);

  if (estimate.error) return <LoadError message={estimate.error} onRetry={estimate.reload} />;
  const e = estimate.data;
  if (!e) return <div className="text-meta text-content-subtle">Loading…</div>;

  const parts = [
    { key: "Labour", value: e.labourTotal },
    { key: "Material", value: e.materialTotal },
    { key: "Equipment", value: e.equipmentTotal },
    { key: "Subcontract", value: e.subcontractTotal },
    { key: "Other", value: e.otherTotal },
  ].filter((p) => p.value !== 0);

  return (
    <div className="space-y-3">
      {parts.length === 0 ? (
        <p className="text-meta text-content-subtle">This estimate has no priced lines yet.</p>
      ) : (
        parts.map((part) => (
          <div key={part.key}>
            <div className="mb-1 flex items-baseline justify-between text-meta">
              <span className="text-content">{part.key}</span>
              <span className="text-content-subtle">
                {money0(part.value, e.currency)} ·{" "}
                {e.directCostTotal === 0 ? DASH : pct(part.value / e.directCostTotal, 0)}
              </span>
            </div>
            <Progress
              value={e.directCostTotal === 0 ? 0 : (part.value / e.directCostTotal) * 100}
              size="xs"
            />
          </div>
        ))
      )}
      <dl className="divide-y divide-border border-t border-border pt-2">
        <Row label="Direct cost">{money0(e.directCostTotal, e.currency)}</Row>
        <Row label="Markups">{money0(e.markupTotal, e.currency)}</Row>
        <Row label="Total">
          <span className="font-semibold">{money0(e.total, e.currency)}</span>
        </Row>
        <Row label="Labour hours" hint="From the crews and production rates used">
          {num(e.labourHours, 1)}
        </Row>
        {e.alternateTotal !== 0 ? (
          <Row label="Alternates" hint="Priced, offered, not in the total">
            {money0(e.alternateTotal, e.currency)}
          </Row>
        ) : null}
        {e.excludedTotal !== 0 ? (
          <Row label="Excluded" hint="Kept for the reasoning, outside the total">
            {money0(e.excludedTotal, e.currency)}
          </Row>
        ) : null}
      </dl>
      <BasisList warnings={e.warnings} />
    </div>
  );
}
