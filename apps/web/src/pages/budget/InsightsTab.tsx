/**
 * INSIGHTS — earned value, forecast swings, anomaly findings and the
 * reconciliation history, on one screen (spec #490–#493, #497; Vol II X).
 *
 * Every figure here comes with its basis: a CPI is shown next to the EV and
 * AC it was divided from, a finding lists the exact inputs it was computed
 * from and cites the lines and captures it read, and a metric the platform
 * cannot compute renders "not available" with the reason. Nothing is a bare
 * number.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  SegmentedControl,
  Skeleton,
  Stat,
  Table,
  Td,
  Th,
  Tooltip,
  Tr,
} from "../../ui";
import { IconInsight, IconRefresh } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  COMPONENT_LABEL,
  FigureValue,
  LoadError,
  ReasonList,
  SEVERITY_TONE,
  SectionHeading,
  actorName,
  count,
  dateTime,
  errorMessage,
  labelize,
  money,
  percent,
  ratio,
  useResource,
  type BudgetDetail,
  type BudgetInsights,
  type Figure,
  type InsightFinding,
  type InsightSeverity,
  type ListResponse,
  type ReconciliationDetail,
  type ReconciliationSummary,
} from "./budgetShared";

type SeverityFilter = "all" | InsightSeverity;

export default function InsightsTab({
  budget,
  currency,
  users,
  version,
  onChanged,
  onOpenLine,
}: {
  budget: BudgetDetail;
  currency: string;
  users: Map<string, string>;
  version: number;
  onChanged: () => void;
  onOpenLine?: (lineId: string) => void;
}) {
  const [severity, setSeverity] = useState<SeverityFilter>("all");
  const [reconciling, setReconciling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);

  const insights = useResource<BudgetInsights>(
    (signal) => api.get<BudgetInsights>(`/api/v1/budgets/${budget.id}/insights`, { signal }),
    [budget.id, version],
  );
  const runs = useResource<ListResponse<ReconciliationSummary>>(
    (signal) =>
      api.get<ListResponse<ReconciliationSummary>>(
        `/api/v1/budgets/${budget.id}/reconciliations?page=1&pageSize=20`,
        { signal },
      ),
    [budget.id, version],
  );
  const runDetail = useResource<ReconciliationDetail>(
    (signal) => api.get<ReconciliationDetail>(`/api/v1/budget-reconciliations/${openRun}`, { signal }),
    [openRun ?? ""],
    openRun !== null,
  );

  const data = insights.data;
  const findings = useMemo(() => {
    const all = data?.findings ?? [];
    return severity === "all" ? all : all.filter((f) => f.severity === severity);
  }, [data, severity]);

  async function reconcile() {
    setReconciling(true);
    setActionError(null);
    try {
      await api.post(`/api/v1/budgets/${budget.id}/reconcile`, {});
      onChanged();
    } catch (err) {
      setActionError(errorMessage(err, "The reconciliation could not be run"));
    } finally {
      setReconciling(false);
    }
  }

  if (insights.error) {
    return <LoadError message={insights.error} onRetry={insights.reload} title="Insights could not be computed" />;
  }
  if (insights.loading && !data) {
    return (
      <div className="space-y-3">
        <Skeleton height={96} />
        <Skeleton height={240} />
      </div>
    );
  }
  if (!data) return null;

  const ev = data.earnedValue;

  return (
    <div className="space-y-5">
      {actionError ? <Alert tone="danger" title="Reconciliation failed" onDismiss={() => setActionError(null)}>{actionError}</Alert> : null}

      <section>
        <SectionHeading
          title="Earned value"
          hint={`As at ${data.asOf}. Planned value is time-phased over the schedule windows linked to ${count(data.linesWithScheduleWindow)} of ${count(data.lineCount)} lines by WBS code; lines without a window have no PV or SPI, and say so.`}
        />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Budget at completion" value={money(ev.bac, currency)} hint="Σ revised budget" />
          <Stat label="Actual cost" value={money(ev.ac, currency)} hint="Σ job-to-date cost" />
          <Stat
            label="Earned value"
            value={<FigureValue figure={ev.ev} currency={currency} />}
            hint={`BAC × % complete on ${count(ev.linesWithEv)} lines`}
          />
          <Stat
            label="Planned value"
            value={<FigureValue figure={ev.pv} currency={currency} />}
            hint={`Time-phased on ${count(ev.linesWithPv)} lines`}
          />
          <Stat label="CPI" value={<RatioValue figure={ev.cpi} />} hint="EV ÷ AC — below 1.0 is earning less than it spends" />
          <Stat label="SPI" value={<RatioValue figure={ev.spi} />} hint="EV ÷ PV, over the lines that have a planned value" />
          <Stat
            label="EAC (CPI method)"
            value={<FigureValue figure={ev.eacCpi} currency={currency} />}
            hint={`Stored forecast at completion: ${money(ev.storedForecastFinal, currency)}`}
          />
          <Stat label="Variance at completion" value={<FigureValue figure={ev.vac} currency={currency} />} hint="BAC − EAC; negative is an overrun" />
        </div>
      </section>

      <section>
        <SectionHeading
          title="Findings"
          hint="Each finding names the figures it was computed from and cites the lines and captures it read."
          actions={
            <SegmentedControl<SeverityFilter>
              value={severity}
              onChange={setSeverity}
              size="sm"
              aria-label="Severity"
              options={[
                { value: "all", label: `All (${count(data.findingCount)})` },
                { value: "critical", label: `Critical (${count(data.bySeverity.critical)})` },
                { value: "high", label: `High (${count(data.bySeverity.high)})` },
                { value: "medium", label: `Medium (${count(data.bySeverity.medium)})` },
                { value: "low", label: `Low (${count(data.bySeverity.low)})` },
              ]}
            />
          }
        />
        {findings.length === 0 ? (
          <EmptyState
            icon={IconInsight}
            title={data.findingCount === 0 ? "Nothing to flag" : "No findings at this severity"}
            hint={
              data.findingCount === 0
                ? "No line is over-committed, spent past its forecast, burning contingency ahead of progress or drifting from its source tables."
                : "Widen the severity filter to see the rest."
            }
          />
        ) : (
          <div className="space-y-2">
            {findings.map((f, i) => (
              <FindingCard key={`${f.kind}-${f.lineItemId ?? "budget"}-${i}`} finding={f} currency={currency} onOpenLine={onOpenLine} />
            ))}
          </div>
        )}
        {data.contingency.reasons.length > 0 ? (
          <p className="mt-2 text-meta text-content-subtle">Contingency burn: {data.contingency.reasons.join(" ")}</p>
        ) : data.contingency.drawnShare !== null ? (
          <p className="mt-2 text-meta text-content-muted">
            Contingency {percent(data.contingency.drawnShare)} drawn against {percent(data.contingency.progressShare)} cost-weighted progress.
          </p>
        ) : null}
      </section>

      <section>
        <SectionHeading
          title="Reconciliation history"
          hint="Every run rebuilds the cost-side columns from commitments, invoices and payments and records what disagreed. The nightly job runs it for every active budget; run it now to see today's position."
          actions={
            <Button size="sm" leadingIcon={IconRefresh} onClick={() => void reconcile()} loading={reconciling}>
              Reconcile now
            </Button>
          }
        />
        {runs.error ? <LoadError message={runs.error} onRetry={runs.reload} title="Reconciliations could not be loaded" /> : null}
        {(runs.data?.items ?? []).length === 0 ? (
          <p className="text-meta text-content-muted">
            No reconciliation has run on this budget yet — the stored cost columns have not been checked against their sources.
          </p>
        ) : (
          <Table dense stickyHeader>
            <thead>
              <tr>
                <Th>Run</Th>
                <Th>Trigger</Th>
                <Th>By</Th>
                <Th numeric>Lines checked</Th>
                <Th numeric>Updated</Th>
                <Th numeric>Drift rows</Th>
                <Th numeric>Σ |drift|</Th>
                <Th>When</Th>
              </tr>
            </thead>
            <tbody>
              {(runs.data?.items ?? []).map((r) => (
                <Tr key={r.id} interactive onClick={() => setOpenRun(openRun === r.id ? null : r.id)}>
                  <Td className="font-mono text-code">{r.reference}</Td>
                  <Td>
                    <Badge tone={r.trigger === "scheduled" ? "info" : "neutral"} size="xs">
                      {r.trigger}
                    </Badge>
                  </Td>
                  <Td muted>{r.runBy ? actorName(users, r.runBy) : "Platform scheduler"}</Td>
                  <Td numeric>{count(r.linesChecked)}</Td>
                  <Td numeric>{count(r.linesUpdated)}</Td>
                  <Td numeric>
                    <Badge tone={r.driftCount > 0 ? "warning" : "success"} size="xs">
                      {count(r.driftCount)}
                    </Badge>
                  </Td>
                  <Td numeric>{money(r.driftAmount, currency)}</Td>
                  <Td muted>{dateTime(r.createdAt)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
        {openRun ? (
          <Card variant="sunken" className="mt-3">
            <CardBody>
              {runDetail.error ? <LoadError message={runDetail.error} onRetry={runDetail.reload} title="Run could not be loaded" /> : null}
              {runDetail.loading && !runDetail.data ? <Skeleton height={80} /> : null}
              {runDetail.data ? (
                <div className="space-y-2">
                  <p className="text-meta font-semibold text-content">
                    {runDetail.data.reference} — {count(runDetail.data.driftCount)} stored figure{runDetail.data.driftCount === 1 ? "" : "s"} disagreed with the source tables
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(runDetail.data.components).map(([component, c]) => (
                      <Badge key={component} tone={c.applied ? "success" : "neutral"} size="xs" variant="outline">
                        {COMPONENT_LABEL[component] ?? labelize(component)}: {c.applied ? "rebuilt" : "left as stored"}
                      </Badge>
                    ))}
                  </div>
                  {runDetail.data.drift.length > 0 ? (
                    <Table dense>
                      <thead>
                        <tr>
                          <Th>Line</Th>
                          <Th>Column</Th>
                          <Th numeric>Stored</Th>
                          <Th numeric>Rebuilt</Th>
                          <Th numeric>Delta</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {runDetail.data.drift.slice(0, 50).map((d, i) => (
                          <Tr key={`${d.lineItemId}-${d.component}-${i}`} interactive={Boolean(onOpenLine)} onClick={() => onOpenLine?.(d.lineItemId)}>
                            <Td className="font-mono text-code">
                              {d.costCode} / {labelize(d.costType)}
                            </Td>
                            <Td>{COMPONENT_LABEL[d.component] ?? labelize(d.component)}</Td>
                            <Td numeric>{money(d.stored, currency)}</Td>
                            <Td numeric>{money(d.rebuilt, currency)}</Td>
                            <Td numeric className={d.delta < 0 ? "text-danger-fg" : "text-success-fg"}>
                              {money(d.delta, currency, { signed: true })}
                            </Td>
                          </Tr>
                        ))}
                      </tbody>
                    </Table>
                  ) : (
                    <p className="text-meta text-content-muted">Every stored figure agreed with its sources.</p>
                  )}
                  {Object.values(runDetail.data.components).some((c) => !c.applied) ? (
                    <div>
                      <p className="text-meta font-semibold text-content">Left as stored, and why:</p>
                      {Object.entries(runDetail.data.components)
                        .filter(([, c]) => !c.applied)
                        .map(([component, c]) => (
                          <div key={component} className="mt-1">
                            <p className="text-meta text-content-muted">{COMPONENT_LABEL[component] ?? labelize(component)}</p>
                            <ReasonList reasons={c.reasons} />
                          </div>
                        ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </CardBody>
          </Card>
        ) : null}
      </section>

      <section>
        <SectionHeading title="Line by line" hint="Earned value per line, with the window it was phased over and the findings on it." />
        <div className="overflow-x-auto">
          <Table dense stickyHeader>
            <thead>
              <tr>
                <Th>Line</Th>
                <Th numeric>BAC</Th>
                <Th numeric>AC</Th>
                <Th numeric>% complete</Th>
                <Th numeric>EV</Th>
                <Th numeric>PV</Th>
                <Th numeric>CPI</Th>
                <Th numeric>SPI</Th>
                <Th numeric>EAC (CPI)</Th>
                <Th numeric>Stored FAC</Th>
                <Th>Window</Th>
                <Th>Swing</Th>
                <Th>Findings</Th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((l) => (
                <Tr key={l.lineItemId} interactive={Boolean(onOpenLine)} onClick={() => onOpenLine?.(l.lineItemId)}>
                  <Td>
                    <span className="font-mono text-code">{l.costCode}</span>
                    <span className="block truncate text-meta text-content-subtle">{l.description}</span>
                  </Td>
                  <Td numeric>{money(l.earnedValue.bac, currency)}</Td>
                  <Td numeric>{money(l.earnedValue.ac, currency)}</Td>
                  <Td numeric>{percent(l.percentComplete)}</Td>
                  <Td numeric><FigureValue figure={l.earnedValue.ev} currency={currency} compact /></Td>
                  <Td numeric><FigureValue figure={l.earnedValue.pv} currency={currency} compact /></Td>
                  <Td numeric><RatioValue figure={l.earnedValue.cpi} /></Td>
                  <Td numeric><RatioValue figure={l.earnedValue.spi} /></Td>
                  <Td numeric><FigureValue figure={l.earnedValue.eacCpi} currency={currency} compact /></Td>
                  <Td numeric>{money(l.forecastFinal, currency)}</Td>
                  <Td muted>{l.window ? `${l.window.start ?? "?"} → ${l.window.finish ?? "?"}` : "no linked task"}</Td>
                  <Td muted>{l.swing.run > 0 ? `${l.swing.direction} × ${l.swing.run}` : "steady"}</Td>
                  <Td>
                    {l.findings.length === 0 ? (
                      <span className="text-meta text-content-subtle">—</span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {l.findings.map((f) => (
                          <Badge key={f.kind} tone={SEVERITY_TONE[f.severity]} size="xs">
                            {labelize(f.kind)}
                          </Badge>
                        ))}
                      </span>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </div>
      </section>
    </div>
  );
}

/** A ratio figure (CPI, SPI): the number, or "not available" with the reasons. */
function RatioValue({ figure }: { figure: Figure }) {
  if (figure.value === null) {
    return (
      <Tooltip content={figure.reasons.length > 0 ? figure.reasons.join(" ") : "The platform holds no inputs for this figure."}>
        <span className="text-content-muted">
          Not available <Badge tone="warning" size="xs">why</Badge>
        </span>
      </Tooltip>
    );
  }
  return <span className="tabular-nums">{ratio(figure.value)}</span>;
}

function FindingCard({
  finding,
  currency,
  onOpenLine,
}: {
  finding: InsightFinding;
  currency: string;
  onOpenLine?: (lineId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const inputs = Object.entries(finding.inputs).filter(([, v]) => typeof v === "number" || typeof v === "string");
  return (
    <Card>
      <CardBody className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2">
              <Badge tone={SEVERITY_TONE[finding.severity]} size="xs" dot>
                {labelize(finding.severity)}
              </Badge>
              <Badge tone="neutral" size="xs" variant="outline">
                {labelize(finding.kind)}
              </Badge>
              {finding.costCode ? <span className="font-mono text-code">{finding.costCode}</span> : null}
            </p>
            <p className="mt-1 text-body font-medium text-content">{finding.title}</p>
          </div>
          <div className="flex gap-1">
            {finding.lineItemId && onOpenLine ? (
              <Button size="xs" variant="ghost" onClick={() => onOpenLine(finding.lineItemId as string)}>
                Open line
              </Button>
            ) : null}
            <Button size="xs" variant="ghost" onClick={() => setOpen((o) => !o)}>
              {open ? "Hide the arithmetic" : "Why?"}
            </Button>
          </div>
        </div>
        {open ? (
          <div className="space-y-2 text-meta">
            <p className="text-content-muted">{finding.explanation}</p>
            {inputs.length > 0 ? (
              <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
                {inputs.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-content-subtle">{labelize(k)}</dt>
                    <dd className="font-mono tabular-nums">
                      {typeof v === "number" && Math.abs(v) >= 1000 ? money(v, currency) : String(v)}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
            <p className="text-content-subtle">
              Cites {finding.citations.length} record{finding.citations.length === 1 ? "" : "s"}:{" "}
              {finding.citations
                .slice(0, 6)
                .map((c) => c.reference ?? c.id)
                .join(", ")}
              {finding.citations.length > 6 ? "…" : ""}
            </p>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
