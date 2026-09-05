/**
 * OVERVIEW — the portfolio roll-up by currency, the stage-gate pipeline across
 * every project, and the controls that have tripped (#776–#780, #786).
 *
 * The roll-up table has one row per currency and no total row. That absence is
 * the point: the API returns `combinedForecastFinal` as `{ value: null,
 * reasons }` the moment two currencies are in play, and this panel prints the
 * reason instead of inventing a rate.
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
  Table,
  Td,
  Th,
  toast,
  type DataColumns,
} from "../../ui";
import { IconRefresh } from "../../ui/icons";
import {
  Basis,
  DASH,
  DETECTOR_LABEL,
  LoadError,
  ReasonList,
  Row,
  dateTime,
  headroomTone,
  isoDate,
  money,
  moneyShort,
  num,
  pct,
  portfolioApi,
  severityTone,
  statusTone,
  titleCase,
  useAction,
  useIsCompanyAdmin,
  useResource,
  type Loadable,
  type OverviewResponse,
  type Paginated,
  type PipelineEntry,
  type PortfolioSignal,
  type SweepResult,
} from "./portfolioShared";

export default function OverviewTab({ overview }: { overview: Loadable<OverviewResponse> }) {
  const isAdmin = useIsCompanyAdmin();
  const action = useAction();
  const [lastSweep, setLastSweep] = useState<SweepResult | null>(null);
  const [openSignal, setOpenSignal] = useState<PortfolioSignal | null>(null);

  const signals = useResource<Paginated<PortfolioSignal>>(
    "/api/v1/portfolio/signals?page=1&pageSize=200",
  );
  const o = overview.data;

  async function runSweeps() {
    const res = await action.run("sweep", () => portfolioApi.runSweeps());
    if (res) {
      setLastSweep(res);
      toast.success(
        `Sweeps complete — ${res.signalsRaised} raised, ${res.signalsClosed} closed as the condition cleared`,
      );
      signals.reload();
      overview.reload();
    }
  }

  const pipelineColumns = useMemo<DataColumns<PipelineEntry>>(
    () => [
      { id: "projectName", header: "Project", accessor: "projectName", type: "text", width: 240 },
      {
        id: "stage",
        header: "Stage",
        accessor: "stage",
        type: "text",
        width: 150,
        cell: ({ row }) => <Badge tone="neutral" size="xs">{titleCase(row.stage)}</Badge>,
      },
      {
        id: "value",
        header: "Value",
        accessor: (row) => row.value ?? 0,
        type: "number",
        align: "right",
        width: 150,
        cell: ({ row }) => moneyShort(row.value, row.currency),
      },
      {
        id: "gates",
        header: "Gates decided",
        accessor: (row) => row.gatesDecided,
        type: "number",
        align: "right",
        width: 130,
        cell: ({ row }) =>
          row.gatesTotal === 0 ? (
            <span className="italic text-content-subtle">none defined</span>
          ) : (
            `${row.gatesDecided} / ${row.gatesTotal}`
          ),
      },
      {
        id: "nextGate",
        header: "Next gate",
        accessor: (row) => row.nextGate?.name ?? "",
        type: "text",
        width: 260,
        cell: ({ row }) =>
          row.nextGate ? (
            <span>
              G{row.nextGate.gateNumber} {row.nextGate.name}
              {row.nextGate.plannedDate ? (
                <span className="ml-1 text-content-subtle">· {isoDate(row.nextGate.plannedDate)}</span>
              ) : null}
            </span>
          ) : (
            <span className="text-content-subtle">{DASH}</span>
          ),
      },
      {
        id: "overdueGates",
        header: "Overdue",
        accessor: "overdueGates",
        type: "number",
        align: "right",
        width: 90,
        cell: ({ row }) =>
          row.overdueGates > 0 ? (
            <span className="font-semibold text-danger-text">{row.overdueGates}</span>
          ) : (
            DASH
          ),
      },
      {
        id: "rag",
        header: "Last review",
        accessor: (row) => row.lastReview?.rag ?? "",
        type: "text",
        width: 180,
        cell: ({ row }) =>
          row.lastReview ? (
            <span className="flex items-center gap-1.5">
              <Badge
                tone={
                  row.lastReview.rag === "red"
                    ? "danger"
                    : row.lastReview.rag === "amber"
                      ? "warning"
                      : "success"
                }
                size="xs"
                dot
              >
                {titleCase(row.lastReview.rag)}
              </Badge>
              <span className="text-2xs text-content-subtle">{isoDate(row.lastReview.reviewDate)}</span>
            </span>
          ) : (
            <span className="italic text-content-subtle">never reviewed</span>
          ),
      },
    ],
    [],
  );

  const signalColumns = useMemo<DataColumns<PortfolioSignal>>(
    () => [
      {
        id: "severity",
        header: "Severity",
        accessor: "severity",
        type: "text",
        width: 100,
        cell: ({ row }) => (
          <Badge tone={severityTone(row.severity)} size="xs" dot>
            {titleCase(row.severity)}
          </Badge>
        ),
      },
      {
        id: "detector",
        header: "Control",
        accessor: (row) => DETECTOR_LABEL[row.detector] ?? row.detector,
        type: "text",
        width: 240,
      },
      { id: "title", header: "Finding", accessor: "title", type: "text", width: 420 },
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
        width: 170,
        cell: ({ row }) => dateTime(row.createdAt),
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Portfolio position by currency"
          subtitle="One row per currency. There is deliberately no total row: a portfolio total across currencies would need an exchange rate this platform has not been given."
        />
        <CardBody flush>
          {overview.error ? (
            <div className="p-4">
              <LoadError message={overview.error} onRetry={overview.reload} />
            </div>
          ) : !o ? (
            <div className="p-4 text-meta text-content-subtle">Loading the roll-up…</div>
          ) : o.rollup.byCurrency.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="Nothing to roll up yet"
                description="Once projects carry a value or an active budget, their position appears here bucketed by currency."
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <thead>
                  <tr>
                    <Th>Currency</Th>
                    <Th align="right">Projects</Th>
                    <Th align="right">Project value</Th>
                    <Th align="right">Revised budget</Th>
                    <Th align="right">Committed</Th>
                    <Th align="right">Cost to date</Th>
                    <Th align="right">Forecast final</Th>
                    <Th align="right">Forecast variance</Th>
                  </tr>
                </thead>
                <tbody>
                  {o.rollup.byCurrency.map((b) => (
                    <tr key={b.currency}>
                      <Td>
                        <span className="font-semibold">{b.currency}</span>
                      </Td>
                      <Td align="right">{num(b.projects)}</Td>
                      <Td align="right">{moneyShort(b.projectValue, null)}</Td>
                      <Td align="right">{moneyShort(b.revisedBudget, null)}</Td>
                      <Td align="right">{moneyShort(b.committed, null)}</Td>
                      <Td align="right">{moneyShort(b.jobToDateCost, null)}</Td>
                      <Td align="right">{moneyShort(b.forecastFinal, null)}</Td>
                      <Td align="right">
                        <span
                          className={
                            b.forecastVariance > 0
                              ? "font-semibold text-danger-text"
                              : b.forecastVariance < 0
                                ? "text-success-text"
                                : undefined
                          }
                        >
                          {moneyShort(b.forecastVariance, null)}
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </CardBody>
        {o ? (
          <CardBody className="border-t border-border">
            <div className="mb-2 text-meta">
              <span className="text-content-subtle">Combined forecast final cost: </span>
              {o.rollup.combinedForecastFinal.value === null ? (
                <span className="font-semibold text-content-muted">not available</span>
              ) : (
                <span className="font-semibold text-content">
                  {money(o.rollup.combinedForecastFinal.value, o.rollup.byCurrency[0]?.currency ?? null)}
                </span>
              )}
            </div>
            <ReasonList reasons={[...o.rollup.combinedForecastFinal.reasons, ...o.rollup.reasons, ...o.reasons]} />
          </CardBody>
        ) : null}
      </Card>

      <Card>
        <CardHeader
          title="Stage-gate pipeline"
          subtitle="Read from the governance module's gates and reviews. A project with no gates defined is reported as such rather than shown at gate zero."
        />
        <CardBody flush>
          {o && o.pipeline.entries.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="No projects in scope"
                description="Projects appear here as soon as they exist; their gate position follows once the governance module has gates for them."
              />
            </div>
          ) : (
            <DataTable<PipelineEntry>
              tableId="portfolio.pipeline"
              data={o?.pipeline.entries ?? []}
              columns={pipelineColumns}
              getRowId={(row) => row.projectId}
              loading={overview.loading && !o}
              height={380}
              rowHeight={44}
              stickyHeader
              flush
              toolbar={false}
              rowTone={(row) => (row.overdueGates > 0 ? "danger" : undefined)}
              empty={{ title: "No projects in scope" }}
              aria-label="Stage-gate pipeline"
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Controls"
          subtitle="Every portfolio control runs on the platform scheduler, not on this page load. Each finding is raised once and closes itself when the condition clears."
          actions={
            isAdmin ? (
              <Button size="sm" icon={IconRefresh} onClick={() => void runSweeps()} loading={action.busy === "sweep"}>
                Run the sweeps now
              </Button>
            ) : undefined
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
              Last run {dateTime(lastSweep.ranAt)}: {num(lastSweep.envelopeBreaches)} envelope breach(es),{" "}
              {num(lastSweep.appropriationOvercommits)} overcommitted appropriation(s),{" "}
              {num(lastSweep.fundingOverdrawn)} over-allocated facility(ies),{" "}
              {num(lastSweep.frameworkCeilingBreaches)} framework ceiling breach(es),{" "}
              {num(lastSweep.frameworksExpiring)} expiring framework(s),{" "}
              {num(lastSweep.jvContributionsOverdue)} overdue partner contribution(s),{" "}
              {num(lastSweep.targetCostOverruns)} target-cost overrun(s),{" "}
              {num(lastSweep.verificationsOverdue)} unstarted verification(s),{" "}
              {num(lastSweep.disallowedUnresolved)} unanswered disallowance(s),{" "}
              {num(lastSweep.auditRightsObstructed)} obstructed audit(s).
            </div>
          ) : null}
          {signals.error ? (
            <div className="p-4">
              <LoadError message={signals.error} onRetry={signals.reload} />
            </div>
          ) : (
            <DataTable<PortfolioSignal>
              tableId="portfolio.signals"
              data={signals.data?.items ?? []}
              columns={signalColumns}
              getRowId={(row) => row.id}
              loading={signals.loading && !signals.data}
              height={320}
              rowHeight={44}
              stickyHeader
              flush
              toolbar={false}
              onRowClick={({ row }) => setOpenSignal(row)}
              rowTone={(row) => severityTone(row.severity)}
              empty={{
                title: "No open control breaches",
                description:
                  "Nothing here means the sweeps found no envelope breach, overcommitted appropriation, framework ceiling breach, overdue partner contribution, target-cost overrun, unstarted verification, unanswered disallowance or obstructed audit — not that none can happen.",
              }}
              aria-label="Portfolio control breaches"
            />
          )}
        </CardBody>
      </Card>

      {o && o.fundingSources.positions.length > 0 ? (
        <Card>
          <CardHeader
            title="Funding headroom"
            subtitle="Each facility against the allocations drawn on it. An allocation in another currency cannot consume a facility and is excluded with a reason, never converted."
          />
          <CardBody flush>
            <div className="overflow-x-auto">
              <Table>
                <thead>
                  <tr>
                    <Th>Facility</Th>
                    <Th>Kind</Th>
                    <Th>Status</Th>
                    <Th align="right">Facility value</Th>
                    <Th align="right">Allocated</Th>
                    <Th align="right">Drawn</Th>
                    <Th align="right">Headroom</Th>
                    <Th align="right">Utilisation</Th>
                  </tr>
                </thead>
                <tbody>
                  {o.fundingSources.positions.map((p) => (
                    <tr key={p.id}>
                      <Td>{p.name}</Td>
                      <Td>{titleCase(p.kind)}</Td>
                      <Td>
                        <Badge tone={statusTone(p.status)} size="xs">
                          {titleCase(p.status)}
                        </Badge>
                      </Td>
                      <Td align="right">{moneyShort(p.facility, p.currency)}</Td>
                      <Td align="right">{moneyShort(p.allocated, p.currency)}</Td>
                      <Td align="right">{moneyShort(p.drawn, p.currency)}</Td>
                      <Td align="right">
                        <span className={headroomTone(p.headroom) === "danger" ? "font-semibold text-danger-text" : undefined}>
                          {moneyShort(p.headroom, p.currency)}
                        </span>
                      </Td>
                      <Td align="right">{pct(p.utilisationPercent)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </CardBody>
        </Card>
      ) : null}

      <Drawer
        open={openSignal !== null}
        onClose={() => setOpenSignal(null)}
        size="md"
        title={openSignal ? openSignal.title : "Control breach"}
        description={
          openSignal
            ? `${DETECTOR_LABEL[openSignal.detector] ?? openSignal.detector} · ${titleCase(openSignal.severity)} · ${Math.round(openSignal.confidence * 100)}% confidence`
            : undefined
        }
      >
        {openSignal ? (
          <div className="space-y-4">
            <p className="text-meta text-content">{openSignal.explanation}</p>
            <dl className="divide-y divide-border">
              <Row label="Disposition">{titleCase(openSignal.disposition)}</Row>
              <Row label="Raised">{dateTime(openSignal.createdAt)}</Row>
              <Row label="Scope">
                {openSignal.projectId ? "One project" : "Portfolio-wide (no single project)"}
              </Row>
            </dl>
            <Basis
              lines={[
                "Raised by a scheduled portfolio sweep, not by opening this page.",
                "The same condition never raises a second signal; it closes itself when the condition clears.",
              ]}
              title="How this was found"
            />
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
