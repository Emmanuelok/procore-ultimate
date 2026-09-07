/**
 * PRODUCTIVITY, THE MEASURED MILE AND HOURS AT COMPLETION (spec Vol I
 * #691–699).
 *
 * Every figure here comes from coded timecard allocations. Three rules:
 *  · hours with no earn rate are SPENT, shown as such, and never counted as
 *    unproductive;
 *  · a week with no measurable factor is a gap in the line, not a zero;
 *  · the measured mile prints its own arithmetic and says explicitly that it
 *    is not a finding of causation.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ChartCard,
  EmptyState,
  Field,
  Input,
  LineChart,
  Select,
  Table,
  Td,
  Th,
} from "../../ui";
import { IconActivity, IconForensics, IconSave, IconTrendUp } from "../../ui/icons";
import {
  FORECAST_METHODS,
  LoadError,
  ReasonList,
  Row,
  count,
  dateOnly,
  factor,
  hours,
  num,
  percent,
  resourcesApi,
  shiftIso,
  titleCase,
  todayIso,
  useAction,
  useResource,
  type ForecastView,
  type MeasuredMile,
  type ProductivityBucket,
  type ProductivityReport,
} from "./resourcesShared";

export default function ProductivityTab({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}) {
  const action = useAction();
  const [nonce, setNonce] = useState(0);
  const [from, setFrom] = useState(shiftIso(todayIso(), -182));
  const [to, setTo] = useState(todayIso());
  const [method, setMethod] = useState<string>("productivity_factor");

  const window = `from=${from}&to=${to}`;
  const report = useResource<ProductivityReport>(
    `/api/v1/projects/${projectId}/resources/productivity?${window}&_=${nonce}`,
  );
  const mile = useResource<MeasuredMile>(
    `/api/v1/projects/${projectId}/resources/measured-mile?${window}&_=${nonce}`,
  );
  const forecast = useResource<ForecastView>(
    `/api/v1/projects/${projectId}/resources/forecast?${window}&method=${method}&_=${nonce}`,
  );

  const trend = useMemo(
    () =>
      (report.data?.weeks ?? []).map((w) => ({
        week: w.weekStart,
        factor: w.productivityFactor,
        actual: w.actualHours,
        earned: w.earnedHours,
      })),
    [report.data],
  );

  const bump = () => {
    setNonce((n) => n + 1);
    onChanged();
  };

  return (
    <div className="space-y-4">
      {action.error ? (
        <Alert tone="danger" size="sm" onDismiss={action.clear}>
          {action.error}
        </Alert>
      ) : null}

      <Card>
        <CardHeader
          title="Window"
          subtitle="Rejected, void and superseded cards are excluded. Draft cards are included so the current week is visible."
          actions={
            <Button
              size="sm"
              variant="secondary"
              icon={IconSave}
              loading={action.busy === "snapshot"}
              onClick={async () => {
                const res = await action.run("snapshot", () =>
                  resourcesApi.snapshot(projectId, { from, to, includeWeeks: true }),
                );
                if (res) {
                  toast.success(`${res.rowsWritten} snapshot rows kept`);
                  bump();
                }
              }}
            >
              Keep a snapshot
            </Button>
          }
        />
        <CardBody>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="From">
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="To">
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
            <Field
              label="Forecast method"
              hint="The method is stated on the record: a forecast whose method silently changed between two reports is worse than no forecast."
            >
              <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                {FORECAST_METHODS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </CardBody>
      </Card>

      <ChartCard
        title="Earned against actual, by week"
        subtitle="A factor of 1.00 means the hours bought exactly what they were planned to buy"
        icon={IconActivity}
        metric={factor(report.data?.totals.productivityFactor ?? null)}
        metricCaption={
          report.data
            ? `${hours(report.data.totals.earnedHours)} earned of ${hours(
                report.data.totals.actualHours,
              )}`
            : undefined
        }
        loading={report.loading && !report.data}
        footnote={
          report.data && report.data.totals.unearnableHours > 0
            ? `${hours(report.data.totals.unearnableHours)} of the hours in this window have no earn rate — no budget line, no planned rate, no installed quantity, or a unit mismatch. They are counted as spent and excluded from the factor, never counted as unproductive.`
            : undefined
        }
      >
        {report.error ? (
          <LoadError message={report.error} onRetry={report.reload} />
        ) : trend.length > 0 ? (
          <LineChart
            data={trend}
            categoryKey="week"
            series={[
              { key: "actual", label: "Hours spent", tone: "neutral" },
              { key: "earned", label: "Hours earned", tone: "accent" },
            ]}
            valueFormat="number"
            height={240}
            ariaLabel="Hours spent and hours earned by week"
          />
        ) : (
          <EmptyState
            title="Nothing measurable in this window"
            hint={
              report.data?.reasons[0] ??
              "Productivity is computed from timecard allocations: hours, a cost code and an installed quantity."
            }
            icon={IconActivity}
            size="sm"
          />
        )}
      </ChartCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <BucketTable
          title="By trade and plant class"
          subtitle="Hours whose trade matches no resource type are kept under “not mapped” rather than dropped"
          buckets={report.data?.byResourceType ?? []}
          loading={report.loading}
        />
        <BucketTable
          title="By crew"
          subtitle="The crew a foreman is judged on"
          buckets={report.data?.byCrew ?? []}
          loading={report.loading}
        />
      </div>

      <Card>
        <CardHeader
          title="Measured mile"
          subtitle="The longest run of consecutive measured weeks at the best rate this project actually achieved — no industry norm has to be argued about"
          icon={IconForensics}
        />
        <CardBody>
          {mile.error ? (
            <LoadError message={mile.error} onRetry={mile.reload} />
          ) : mile.data ? (
            <div className="space-y-3">
              {mile.data.mile ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-md border border-border-subtle p-3">
                    <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
                      Benchmark (unimpacted)
                    </div>
                    <dl className="divide-y divide-border-subtle">
                      <Row label="Window">
                        {dateOnly(mile.data.mile.from)} → {dateOnly(mile.data.mile.to)}
                      </Row>
                      <Row label="Weeks">{count(mile.data.mile.weeks)}</Row>
                      <Row label="Hours">{hours(mile.data.mile.actualHours)}</Row>
                      <Row label="Earned">{hours(mile.data.mile.earnedHours)}</Row>
                      <Row label="Factor">{factor(mile.data.mile.productivityFactor)}</Row>
                    </dl>
                  </div>
                  <div className="rounded-md border border-border-subtle p-3">
                    <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
                      Impacted
                    </div>
                    {mile.data.impacted ? (
                      <dl className="divide-y divide-border-subtle">
                        <Row label="Window">
                          {dateOnly(mile.data.impacted.from)} → {dateOnly(mile.data.impacted.to)}
                        </Row>
                        <Row label="Weeks">{count(mile.data.impacted.weeks)}</Row>
                        <Row label="Hours">{hours(mile.data.impacted.actualHours)}</Row>
                        <Row label="Earned">{hours(mile.data.impacted.earnedHours)}</Row>
                        <Row label="Factor">{factor(mile.data.impacted.productivityFactor)}</Row>
                        <Row label="Hours that bought nothing">{hours(mile.data.lostHours)}</Row>
                        <Row label="Share of impacted hours">
                          {percent(mile.data.lostHoursPercent)}
                        </Row>
                      </dl>
                    ) : (
                      <p className="text-2xs text-content-subtle">
                        Every measured week falls inside the benchmark, so no disruption loss is
                        claimed.
                      </p>
                    )}
                  </div>
                </div>
              ) : null}
              <p className="text-2xs text-content-subtle">{mile.data.explanation}</p>
              <Alert tone="info" size="sm" title="What this figure is, and is not">
                {mile.data.forensicsNote}
              </Alert>
              <ReasonList reasons={mile.data.reasons} />
            </div>
          ) : (
            <div className="py-6 text-center text-meta text-content-subtle">Loading…</div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Hours at completion"
          subtitle="Four named methods. The method is part of the record, not a hidden default."
          icon={IconTrendUp}
          actions={
            <Button
              size="sm"
              variant="secondary"
              loading={action.busy === "keep"}
              disabled={forecast.data?.forecast.forecastHoursAtCompletion === null}
              onClick={async () => {
                const res = await action.run("keep", () =>
                  resourcesApi.keepForecast(projectId, { method, from, to }),
                );
                if (res) {
                  toast.success("Forecast kept");
                  bump();
                }
              }}
            >
              Keep this forecast
            </Button>
          }
        />
        <CardBody>
          {forecast.error ? (
            <LoadError message={forecast.error} onRetry={forecast.reload} />
          ) : forecast.data ? (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <dl className="divide-y divide-border-subtle">
                  <Row label="Method">{titleCase(forecast.data.forecast.method)}</Row>
                  <Row
                    label="Budgeted hours"
                    hint={
                      forecast.data.forecast.budgetHours === null
                        ? "No budget line carries planned hours"
                        : undefined
                    }
                  >
                    {hours(forecast.data.forecast.budgetHours)}
                  </Row>
                  <Row label="Hours spent">{hours(forecast.data.forecast.actualHours)}</Row>
                  <Row label="Hours earned">{hours(forecast.data.forecast.earnedHours)}</Row>
                  <Row label="Percent complete">
                    {percent(forecast.data.forecast.percentComplete)}
                  </Row>
                </dl>
                <dl className="divide-y divide-border-subtle">
                  <Row label="Forecast at completion">
                    {hours(forecast.data.forecast.forecastHoursAtCompletion)}
                  </Row>
                  <Row label="Hours remaining">{hours(forecast.data.forecast.remainingHours)}</Row>
                  <Row label="Variance against budget">
                    {hours(forecast.data.forecast.varianceHours)}
                  </Row>
                  <Row label="Confidence">
                    {forecast.data.forecast.confidence ? (
                      <Badge
                        tone={
                          forecast.data.forecast.confidence === "high"
                            ? "success"
                            : forecast.data.forecast.confidence === "medium"
                              ? "info"
                              : "warning"
                        }
                        size="xs"
                      >
                        {titleCase(forecast.data.forecast.confidence)}
                      </Badge>
                    ) : (
                      "—"
                    )}
                  </Row>
                </dl>
              </div>
              <div className="rounded-md border border-border-subtle bg-surface-raised p-3 text-2xs text-content-subtle">
                {forecast.data.forecast.basis}
              </div>
              <ReasonList reasons={forecast.data.forecast.reasons} />

              {forecast.data.history.length > 0 ? (
                <div>
                  <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
                    What we thought, and when
                  </div>
                  <Table dense>
                    <thead>
                      <tr>
                        <Th>As at</Th>
                        <Th>Method</Th>
                        <Th align="right">Forecast</Th>
                        <Th align="right">Variance</Th>
                        <Th align="right">Factor</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {forecast.data.history.map((h) => (
                        <tr key={h.id} title={h.basis ?? undefined}>
                          <Td>{dateOnly(h.asOfDate)}</Td>
                          <Td>{titleCase(h.method)}</Td>
                          <Td align="right">{hours(h.forecastHoursAtCompletion)}</Td>
                          <Td align="right">{hours(h.varianceHours)}</Td>
                          <Td align="right">{factor(h.productivityFactor)}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="py-6 text-center text-meta text-content-subtle">Loading…</div>
          )}
        </CardBody>
      </Card>

      {report.data ? <ReasonList reasons={report.data.reasons} /> : null}
    </div>
  );
}

function BucketTable({
  title,
  subtitle,
  buckets,
  loading,
}: {
  title: string;
  subtitle: string;
  buckets: ProductivityBucket[];
  loading: boolean;
}) {
  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} />
      <CardBody flush>
        {buckets.length > 0 ? (
          <Table dense>
            <thead>
              <tr>
                <Th>Bucket</Th>
                <Th align="right">Spent</Th>
                <Th align="right">Earned</Th>
                <Th align="right">Factor</Th>
                <Th align="right">Achieved rate</Th>
                <Th align="right">Planned rate</Th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((b) => (
                <tr key={b.key} title={b.reasons.join(" ")}>
                  <Td>{b.label}</Td>
                  <Td align="right">{num(b.actualHours)}</Td>
                  <Td align="right">{num(b.earnedHours)}</Td>
                  <Td align="right">{factor(b.productivityFactor)}</Td>
                  <Td align="right">
                    {b.achievedUnitRate === null ? "—" : `${num(b.achievedUnitRate, 3)} h/${b.unit ?? "unit"}`}
                  </Td>
                  <Td align="right">
                    {b.plannedUnitRate === null ? "—" : `${num(b.plannedUnitRate, 3)} h/${b.unit ?? "unit"}`}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <div className="p-4">
            <EmptyState
              title={loading ? "Loading…" : "No coded hours in this window"}
              hint="Hours reach this table through timecard allocations."
              size="sm"
            />
          </div>
        )}
      </CardBody>
    </Card>
  );
}
