/**
 * The verdict panel: the next thing that will go wrong with resourcing on
 * this project, in the order it will go wrong, with the arithmetic attached.
 *
 * Nothing here shows a zero it cannot defend. A project with no plan gets the
 * sentence "unknown, not zero" rather than a reassuring set of green tiles.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  ChartCard,
  DataTable,
  EmptyState,
  LineChart,
  Progress,
  type DataColumns,
} from "../../ui";
import { IconActivity, IconRefresh, IconWarning } from "../../ui/icons";
import {
  DETECTOR_LABEL,
  LoadError,
  Pill,
  ReasonList,
  Row,
  count,
  dateOnly,
  factor,
  hours,
  percent,
  severityTone,
  titleCase,
  useAction,
  useResource,
  resourcesApi,
  PLAN_STATUS_TONE,
  type Loadable,
  type ResourceSignal,
  type ResourceSummary,
  type SkillGap,
} from "./resourcesShared";

export default function OverviewTab({
  projectId,
  summary,
  onChanged,
}: {
  projectId: string;
  summary: Loadable<ResourceSummary>;
  onChanged: () => void;
}) {
  const s = summary.data;
  const action = useAction();
  const [sweeping, setSweeping] = useState(false);
  const gaps = useResource<{ total: number; items: SkillGap[]; reasons: string[] }>(
    `/api/v1/projects/${projectId}/resources/skill-gaps`,
  );

  const trend = useMemo(
    () =>
      (s?.productivity.weeks ?? []).map((w) => ({
        week: w.weekStart,
        factor: w.productivityFactor,
        actual: w.actualHours,
      })),
    [s],
  );

  const signalColumns = useMemo<DataColumns<ResourceSignal>>(
    () => [
      {
        id: "detector",
        header: "Finding",
        accessor: (row) => DETECTOR_LABEL[row.detector] ?? titleCase(row.detector),
        type: "text",
        width: 170,
      },
      {
        id: "severity",
        header: "Severity",
        accessor: "severity",
        type: "text",
        width: 110,
        cell: ({ row }) => <Pill status={row.severity} map={{ [row.severity]: severityTone(row.severity) }} />,
      },
      { id: "title", header: "What", accessor: "title", type: "text", width: 420 },
      {
        id: "occurrences",
        header: "Seen",
        accessor: "occurrences",
        type: "number",
        align: "right",
        width: 70,
      },
      {
        id: "createdAt",
        header: "Raised",
        accessor: "createdAt",
        type: "datetime",
        width: 140,
        cell: ({ row }) => dateOnly(row.createdAt),
      },
    ],
    [],
  );

  if (summary.error) {
    return <LoadError message={summary.error} onRetry={summary.reload} />;
  }

  return (
    <div className="space-y-4">
      {action.error ? (
        <Alert tone="danger" size="sm" onDismiss={action.clear}>
          {action.error}
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader
            title="Coverage"
            subtitle="Demand against the supply this project says it can field, over the next quarter"
          />
          <CardBody>
            {s ? (
              <dl className="divide-y divide-border-subtle">
                <Row label="Active plan">
                  {s.plan ? (
                    <span className="flex items-center justify-end gap-2">
                      <Pill status={s.plan.status} map={PLAN_STATUS_TONE} />
                      <span>{s.plan.reference}</span>
                    </span>
                  ) : (
                    "—"
                  )}
                </Row>
                <Row
                  label="Weeks short"
                  hint={
                    s.coverage.overWeeks === null
                      ? "No active plan, so coverage is unknown rather than perfect"
                      : undefined
                  }
                >
                  {count(s.coverage.overWeeks)}
                </Row>
                <Row
                  label="Weeks with no supply recorded"
                  hint="Unknown supply is a question, not a crisis"
                >
                  {count(s.coverage.unknownSupplyWeeks)}
                </Row>
                <Row
                  label="Peak demand"
                  hint={s.coverage.peakWeekStart ? `Week of ${dateOnly(s.coverage.peakWeekStart)}` : undefined}
                >
                  {hours(s.coverage.peakDemandHours)}
                </Row>
                <Row label="Peak headcount" hint={s.plan?.peakHeadcount === null ? "Not derivable" : undefined}>
                  {count(s.plan?.peakHeadcount ?? null)}
                </Row>
              </dl>
            ) : (
              <div className="py-6 text-center text-meta text-content-subtle">Loading…</div>
            )}
            {s?.coverage.worstShortfall ? (
              <Alert tone="danger" size="sm" className="mt-3" title="The next thing to go wrong">
                {s.coverage.worstShortfall.resourceTypeName} is {hours(
                  s.coverage.worstShortfall.shortfallHours,
                )}{" "}
                short in the week beginning {dateOnly(s.coverage.worstShortfall.weekStart)} —{" "}
                {hours(s.coverage.worstShortfall.demandHours)} needed against{" "}
                {hours(s.coverage.worstShortfall.availableHours)} available.
              </Alert>
            ) : null}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Bookings" subtitle="Live assignments and every clash between them" />
          <CardBody>
            {s ? (
              <dl className="divide-y divide-border-subtle">
                <Row label="Live bookings">{count(s.bookings.active)}</Row>
                <Row label="Double bookings">{count(s.bookings.conflicts)}</Row>
                <Row label="Workers on the register">{count(s.certifications.workers)}</Row>
                <Row label="Certification records">{count(s.certifications.records)}</Row>
                <Row label="Unverified tickets" hint="A claim by the person it benefits is not evidence">
                  {count(s.certifications.unverified)}
                </Row>
              </dl>
            ) : (
              <div className="py-6 text-center text-meta text-content-subtle">Loading…</div>
            )}
            {s?.bookings.worstConflict ? (
              <Alert tone="warning" size="sm" className="mt-3" title="Worst clash">
                {s.bookings.worstConflict.explanation}
              </Alert>
            ) : null}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Hours bought against hours earned"
            subtitle="From coded timecard allocations — the only place an hour is attached to something built"
          />
          <CardBody>
            {s ? (
              <>
                <dl className="divide-y divide-border-subtle">
                  <Row label="Window">
                    {dateOnly(s.productivity.window.from)} → {dateOnly(s.productivity.window.to)}
                  </Row>
                  <Row label="Hours spent">{hours(s.productivity.totals.actualHours)}</Row>
                  <Row
                    label="Hours earned"
                    hint={
                      s.productivity.totals.earnedHours === null
                        ? "Not stated: some hours have no earn rate"
                        : undefined
                    }
                  >
                    {hours(s.productivity.totals.earnedHours)}
                  </Row>
                  <Row label="Productivity factor">
                    {factor(s.productivity.totals.productivityFactor)}
                  </Row>
                  <Row label="Hours that earned nothing">
                    {hours(s.productivity.totals.unearnableHours)}
                  </Row>
                  <Row
                    label="Forecast at completion"
                    hint={
                      s.productivity.latestForecast
                        ? `${titleCase(s.productivity.latestForecast.method)} · as at ${dateOnly(
                            s.productivity.latestForecast.asOfDate,
                          )}`
                        : "No forecast has been kept yet"
                    }
                  >
                    {hours(s.productivity.latestForecast?.forecastHoursAtCompletion ?? null)}
                  </Row>
                </dl>
                {s.productivity.totals.actualHours > 0 &&
                s.productivity.totals.unearnableHours > 0 ? (
                  <div className="mt-3">
                    <div className="mb-1 flex items-center justify-between text-2xs text-content-subtle">
                      <span>Measurable share of the hours</span>
                      <span>
                        {percent(
                          ((s.productivity.totals.actualHours -
                            s.productivity.totals.unearnableHours) /
                            s.productivity.totals.actualHours) *
                            100,
                        )}
                      </span>
                    </div>
                    <Progress
                      value={
                        ((s.productivity.totals.actualHours -
                          s.productivity.totals.unearnableHours) /
                          s.productivity.totals.actualHours) *
                        100
                      }
                      tone="info"
                      size="sm"
                    />
                  </div>
                ) : null}
              </>
            ) : (
              <div className="py-6 text-center text-meta text-content-subtle">Loading…</div>
            )}
          </CardBody>
        </Card>
      </div>

      <ChartCard
        title="Productivity by week"
        subtitle="A factor of 1.00 means the hours bought exactly what they were planned to. A week with no measurable factor is a gap in the line, not a zero."
        icon={IconActivity}
        metric={factor(s?.productivity.totals.productivityFactor ?? null)}
        metricCaption="Factor over the window"
        footnote={
          s && s.productivity.totals.linesUnmeasurable > 0
            ? `${s.productivity.totals.linesUnmeasurable} budget line(s) carrying hours have no planned rate, so those hours are shown as spent and not as unproductive.`
            : undefined
        }
      >
        {trend.length > 0 ? (
          <LineChart
            data={trend}
            categoryKey="week"
            series={[{ key: "factor", label: "Productivity factor", tone: "accent" }]}
            valueFormat="number"
            height={220}
            references={[{ y: 1, label: "On plan", tone: "success" }]}
            ariaLabel="Productivity factor by week"
          />
        ) : (
          <EmptyState
            title="No measurable weeks yet"
            hint="Productivity is computed from timecard allocations: hours, a cost code and an installed quantity. Record progress per cost code per day to make it measurable."
            icon={IconActivity}
            size="sm"
          />
        )}
      </ChartCard>

      <Card>
        <CardHeader
          title="Open resourcing findings"
          subtitle="Raised by the sweeps, deduplicated on what the finding is about rather than on the run that found it"
          actions={
            <Button
              size="sm"
              variant="secondary"
              icon={IconRefresh}
              loading={sweeping}
              onClick={async () => {
                setSweeping(true);
                const res = await action.run("sweep", () => resourcesApi.runSweeps(projectId));
                setSweeping(false);
                if (res) {
                  toast.success("Sweeps run");
                  onChanged();
                }
              }}
            >
              Run sweeps now
            </Button>
          }
        />
        <CardBody flush>
          {s && s.openSignals.items.length > 0 ? (
            <DataTable<ResourceSignal>
              tableId="resources.signals"
              data={s.openSignals.items}
              columns={signalColumns}
              getRowId={(row) => row.id}
              loading={summary.loading && !s}
              height={280}
              rowHeight={40}
              stickyHeader
              flush
              toolbar={false}
              aria-label="Open resourcing findings"
            />
          ) : (
            <div className="p-4">
              <EmptyState
                title="Nothing open"
                hint="The sweeps have found no over-allocation, double booking, lapsed ticket or sustained productivity shortfall on this project."
                icon={IconWarning}
                size="sm"
              />
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Booked without the ticket"
          subtitle="Workers booked on work whose resource type demands a certification they do not hold, hold expired, or whose ticket lapses part-way through the booking"
        />
        <CardBody>
          {gaps.error ? (
            <LoadError message={gaps.error} onRetry={gaps.reload} />
          ) : gaps.data && gaps.data.items.length > 0 ? (
            <ul className="space-y-2">
              {gaps.data.items.slice(0, 8).map((g) => (
                <li
                  key={`${g.assignmentId}-${g.skillId}`}
                  className="rounded-md border border-border-subtle bg-surface-raised p-3"
                >
                  <div className="mb-1 flex items-center gap-2">
                    <Pill status={g.kind} map={{ [g.kind]: severityTone(g.severity) }} />
                    <span className="text-meta font-medium text-content">{g.workerLabel}</span>
                    <span className="text-2xs text-content-subtle">
                      {g.skillName} · {g.assignmentReference}
                    </span>
                  </div>
                  <p className="text-2xs text-content-subtle">{g.explanation}</p>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              title="No ticket gaps in the next 90 days"
              hint={
                gaps.data?.reasons.length
                  ? gaps.data.reasons[0]
                  : "Every worker booked on work that requires a certification holds a valid one that outlives the booking."
              }
              size="sm"
            />
          )}
          {gaps.data ? <ReasonList reasons={gaps.data.reasons} className="mt-3" /> : null}
        </CardBody>
      </Card>

      {s ? <ReasonList reasons={s.reasons} /> : null}
    </div>
  );
}
