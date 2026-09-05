/**
 * SAFETY DASHBOARD — leading indicators, lagging indicators, and the published
 * rates.
 *
 * The layout carries an argument. Leading indicators come FIRST because they
 * are the only ones that can still be acted on: observations raised, talks
 * delivered, inspections passed, actions closed at the durable end of the
 * hierarchy. Lagging indicators — the injuries — come second, because by the
 * time they move, someone has already been hurt.
 *
 * And the rates are rendered by `<RateTile>`, which prints "Not available"
 * plus the API's reasons when exposure hours are missing. There is no path
 * through this file that produces a TRIR of 0.00 from an absent denominator.
 */
import { useMemo, useState, type ReactNode } from "react";
import {
  Badge,
  BarChart,
  Button,
  Card,
  CardBody,
  ChartCard,
  DonutChart,
  EmptyState,
  Field,
  Input,
  Progress,
  Skeleton,
  Stat,
  cx,
} from "../../ui";
import {
  IconAlert,
  IconCheckCircle,
  IconClock,
  IconInspection,
  IconSafety,
  IconWarning,
} from "../../ui/icons";
import {
  HIERARCHY_LABEL,
  HIERARCHY_ORDER,
  HIERARCHY_TONE,
  LoadError,
  RateTile,
  ReasonList,
  SAFETY_DETECTOR_LABEL,
  SectionHeading,
  addDays,
  count,
  decimal,
  labelize,
  today,
  type HierarchyProfile,
  type Resource,
  type SafetyStatistics,
  type SafetySummary,
} from "./safetyShared";

export default function DashboardTab({
  statistics,
  summary,
  hierarchy,
  window: win,
  onWindow,
}: {
  statistics: Resource<SafetyStatistics>;
  summary: Resource<SafetySummary>;
  hierarchy: HierarchyProfile | null;
  window: { from: string; to: string };
  onWindow: (next: { from: string; to: string }) => void;
}) {
  const [draft, setDraft] = useState(win);
  const stats = statistics.data;
  const sum = summary.data;

  const lagging = useMemo(() => {
    if (!stats) return [];
    const c = stats.counts;
    return [
      { label: "Recordable", value: c.recordableCases },
      { label: "Lost time", value: c.lostTimeCases },
      { label: "DART", value: c.dartCases },
      { label: "Fatalities", value: c.fatalities },
      { label: "All injuries", value: c.allInjuries },
      { label: "Near misses", value: c.nearMisses },
    ];
  }, [stats]);

  const observationSplit = useMemo(() => {
    if (!stats) return [];
    const l = stats.leadingIndicators;
    return [
      { label: "Positive", value: l.observationsPositive, tone: "success" as const },
      { label: "Negative", value: l.observationsNegative, tone: "warning" as const },
    ].filter((slice) => slice.value > 0);
  }, [stats]);

  return (
    <div className="space-y-5">
      {statistics.error ? (
        <LoadError
          message={statistics.error}
          onRetry={statistics.reload}
          title="The safety statistics could not be loaded"
        />
      ) : null}
      {summary.error ? (
        <LoadError
          message={summary.error}
          onRetry={summary.reload}
          title="The register summary could not be loaded"
        />
      ) : null}

      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardBody className="flex flex-wrap items-end gap-3">
          <Field label="From" hint="Incidents are counted by when they occurred, not when reported.">
            <Input
              type="date"
              value={draft.from}
              onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            />
          </Field>
          <Field label="To">
            <Input
              type="date"
              value={draft.to}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            />
          </Field>
          <Button
            size="sm"
            onClick={() => onWindow(draft)}
            disabled={draft.from === win.from && draft.to === win.to}
          >
            Apply window
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const next = { from: addDays(today(), -365), to: today() };
              setDraft(next);
              onWindow(next);
            }}
          >
            Last 12 months
          </Button>
        </CardBody>
      </Card>

      {stats?.honesty ? (
        <Card variant="sunken" accent="warning">
          <CardBody>
            <p className="text-label uppercase text-warning-fg">No rate has been computed</p>
            <p className="mt-1 max-w-4xl text-body text-content">{stats.honesty}</p>
          </CardBody>
        </Card>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      <section>
        <SectionHeading
          title="Leading indicators"
          hint="What the site is doing now. These are the only figures on this page that can still change the outcome — everything below them is a count of harm already done."
        />
        {statistics.loading && !stats ? (
          <div className="grid gap-3 md:grid-cols-3">
            <Skeleton height={140} />
            <Skeleton height={140} />
            <Skeleton height={140} />
          </div>
        ) : stats ? (
          <div className="grid gap-3 lg:grid-cols-3">
            <ChartCard
              title="Observations raised"
              subtitle="Positive against negative"
              metric={count(
                stats.leadingIndicators.observationsPositive +
                  stats.leadingIndicators.observationsNegative,
              )}
              metricCaption="in the window"
              className="lg:col-span-1"
            >
              {observationSplit.length === 0 ? (
                <EmptyState
                  size="sm"
                  bordered={false}
                  icon={IconSafety}
                  title="No observations in this window"
                  hint={
                    stats.leadingIndicators.reasons[0] ??
                    "Nothing was recorded, so there is no positive/negative ratio to read."
                  }
                />
              ) : (
                <DonutChart
                  data={observationSplit}
                  height={180}
                  ariaLabel="Positive against negative observations"
                />
              )}
            </ChartCard>

            <Card>
              <CardBody className="space-y-3">
                <Stat
                  label="Positive share of observations"
                  value={
                    stats.leadingIndicators.positiveShare === null
                      ? "Not available"
                      : `${decimal(stats.leadingIndicators.positiveShare, 1)}%`
                  }
                  icon={IconCheckCircle}
                  tone={
                    stats.leadingIndicators.positiveShare === null
                      ? "neutral"
                      : stats.leadingIndicators.positiveShare > 20
                        ? "success"
                        : "warning"
                  }
                  hint="A site that only ever records hazards has a reporting-culture problem, not a safe one."
                />
                {stats.leadingIndicators.positiveShare !== null ? (
                  <Progress
                    value={stats.leadingIndicators.positiveShare}
                    max={100}
                    tone={stats.leadingIndicators.positiveShare > 20 ? "success" : "warning"}
                  />
                ) : null}
                <ReasonList reasons={stats.leadingIndicators.reasons} />
              </CardBody>
            </Card>

            <Card>
              <CardBody className="space-y-3">
                <Stat
                  label="Near miss to injury ratio"
                  value={
                    stats.ratios.nearMissToInjury === null
                      ? "Not available"
                      : `${decimal(stats.ratios.nearMissToInjury, 2)} : 1`
                  }
                  icon={IconWarning}
                  tone={stats.ratios.nearMissToInjury === null ? "neutral" : "info"}
                  hint="Needs no exposure hours — it is a ratio of two counts, not a rate."
                />
                <ReasonList reasons={stats.ratios.reasons} />
                <div className="flex flex-wrap gap-2 border-t border-border pt-2 text-2xs text-content-muted">
                  <span>{count(stats.counts.nearMisses)} near misses</span>
                  <span>·</span>
                  <span>{count(stats.counts.allInjuries)} injuries and illnesses</span>
                </div>
              </CardBody>
            </Card>
          </div>
        ) : null}
      </section>

      {/* ---------------------------------------------------------------- */}
      <section>
        <SectionHeading
          title="Lagging indicators"
          hint="Case counts from the incident register. These are real and are reported whether or not a rate can be computed from them."
        />
        {statistics.loading && !stats ? (
          <Skeleton height={240} />
        ) : stats ? (
          <div className="grid gap-3 lg:grid-cols-3">
            <ChartCard
              title="Cases in the window"
              subtitle={`${stats.from} → ${stats.to}`}
              className="lg:col-span-2"
              footnote="A case is counted at its most severe outcome. DART is the days-away plus restricted-duty subset, so it never exceeds the recordable count."
            >
              {lagging.every((d) => d.value === 0) ? (
                <EmptyState
                  size="sm"
                  bordered={false}
                  icon={IconCheckCircle}
                  title="No incidents occurred in this window"
                  hint="Nothing was recorded against this project between these dates. That is a genuine zero — the register was asked and it is empty, not unavailable."
                />
              ) : (
                <BarChart
                  data={lagging}
                  categoryKey="label"
                  series={[{ key: "value", label: "Cases", tone: "danger" }]}
                  height={220}
                  colorByCategory={false}
                  ariaLabel="Incident case counts in the window"
                />
              )}
            </ChartCard>

            <Card>
              <CardBody className="space-y-3">
                <Stat
                  label="Calendar days lost"
                  value={count(stats.counts.daysLost)}
                  icon={IconClock}
                  tone={stats.counts.daysLost > 0 ? "danger" : "neutral"}
                  hint="Days, not cases. Read this beside LTIFR: one serious injury gives a low frequency and a high severity."
                />
                <div className="border-t border-border pt-3">
                  <Stat
                    label="Still under assessment"
                    value={count(stats.counts.underAssessment)}
                    icon={IconAlert}
                    tone={stats.counts.underAssessment > 0 ? "warning" : "neutral"}
                    hint="Incidents with an undecided statutory test. They are excluded from every numerator, so each rate below is a floor."
                  />
                </div>
              </CardBody>
            </Card>
          </div>
        ) : null}
      </section>

      {/* ---------------------------------------------------------------- */}
      <section>
        <SectionHeading
          title="Published rates"
          hint="TRIR, DART, LTIFR and the severity rate all divide by hours actually worked. Where the platform holds no hours, the rate is not estimated — it is refused, with the reason printed."
        />

        {statistics.loading && !stats ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <Skeleton height={220} />
            <Skeleton height={220} />
            <Skeleton height={220} />
          </div>
        ) : stats ? (
          <>
            <ExposurePanel stats={stats} />
            {stats.caveats.length > 0 ? (
              <Card variant="sunken" className="mt-3">
                <CardBody>
                  <p className="text-label uppercase text-content-subtle">
                    Read every rate below with these
                  </p>
                  <ReasonList reasons={stats.caveats} className="mt-1" />
                </CardBody>
              </Card>
            ) : null}
            <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {stats.rates.map((rate) => (
                <RateTile key={rate.key} rate={rate} />
              ))}
            </div>
          </>
        ) : null}
      </section>

      {/* ---------------------------------------------------------------- */}
      <section>
        <SectionHeading
          title="Statutory posture"
          hint="What the regulator would ask on arrival: what was reportable, what was reported, and what is still undecided."
        />
        {stats ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <Card>
              <CardBody>
                <Stat
                  label="Classified reportable"
                  value={count(stats.reportable.reportableCount)}
                  icon={IconSafety}
                  tone={stats.reportable.reportableCount > 0 ? "warning" : "neutral"}
                />
              </CardBody>
            </Card>
            <Card>
              <CardBody>
                <Stat
                  label="Notification recorded"
                  value={count(stats.reportable.notifiedCount)}
                  icon={IconCheckCircle}
                  tone="success"
                />
              </CardBody>
            </Card>
            <Card accent={stats.reportable.awaitingNotification > 0 ? "warning" : undefined}>
              <CardBody>
                <Stat
                  label="Awaiting notification"
                  value={count(stats.reportable.awaitingNotification)}
                  icon={IconAlert}
                  tone={stats.reportable.awaitingNotification > 0 ? "warning" : "neutral"}
                  hint={`Reportable with the clock still running. Counted per DUTY: ${count(stats.reportable.outstandingDuties)} outstanding across the window.`}
                />
              </CardBody>
            </Card>
            <Card accent={stats.reportable.missedNotification > 0 ? "danger" : undefined}>
              <CardBody>
                <Stat
                  label="Deadline already passed"
                  value={count(stats.reportable.missedNotification)}
                  icon={IconAlert}
                  tone={stats.reportable.missedNotification > 0 ? "danger" : "neutral"}
                  hint={`${count(stats.reportable.missedDuties)} duty/duties whose statutory deadline has gone by with nothing filed. Failing to notify is an offence in its own right, separate from the accident.`}
                />
              </CardBody>
            </Card>
            <Card accent={stats.reportable.needsHumanReview > 0 ? "warning" : undefined}>
              <CardBody>
                <Stat
                  label="Determination not settled"
                  value={count(stats.reportable.needsHumanReview)}
                  icon={IconWarning}
                  tone={stats.reportable.needsHumanReview > 0 ? "warning" : "neutral"}
                  hint="A rule the engine could not decide. Not the same as 'not reportable'."
                />
              </CardBody>
            </Card>
          </div>
        ) : null}
      </section>

      {/* ---------------------------------------------------------------- */}
      {hierarchy ? (
        <section>
          <SectionHeading
            title="Hierarchy of control profile"
            hint="Every corrective action on this project, by the durability of the control chosen. A register weighted to the bottom two bands is a programme that briefs and issues gloves."
          />
          {hierarchy.total === 0 ? (
            <EmptyState
              icon={IconInspection}
              title="No corrective actions on this project"
              hint={
                hierarchy.reasons[0] ??
                "Nothing has been raised from an incident, observation or inspection yet, so there is no control profile to weigh."
              }
            />
          ) : (
            <Card>
              <CardBody className="space-y-2.5">
                {HIERARCHY_ORDER.map((level) => {
                  const n = hierarchy.counts[level] ?? 0;
                  const share = hierarchy.total > 0 ? (n / hierarchy.total) * 100 : 0;
                  return (
                    <div key={level}>
                      <div className="flex items-center justify-between gap-2 text-meta">
                        <span className="text-content">{HIERARCHY_LABEL[level]}</span>
                        <span className="tabular-nums text-content-muted">
                          {count(n)} · {decimal(share, 1)}%
                        </span>
                      </div>
                      <Progress value={share} max={100} tone={HIERARCHY_TONE[level]} size="xs" />
                    </div>
                  );
                })}
                <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
                  <Badge
                    tone={
                      hierarchy.weakControlShare === null
                        ? "neutral"
                        : hierarchy.weakControlShare > 60
                          ? "danger"
                          : hierarchy.weakControlShare > 35
                            ? "warning"
                            : "success"
                    }
                    size="sm"
                    dot
                  >
                    {hierarchy.weakControlShare === null
                      ? "No profile"
                      : `${decimal(hierarchy.weakControlShare, 1)}% at the weak end`}
                  </Badge>
                  {hierarchy.unrecorded > 0 ? (
                    <Badge tone="warning" size="sm" variant="outline">
                      {count(hierarchy.unrecorded)} with no control level recorded
                    </Badge>
                  ) : null}
                  <span className="text-2xs text-content-subtle">
                    Administrative and PPE controls depend on a person behaving correctly every
                    time; they are the controls that fail on the day it matters.
                  </span>
                </div>
              </CardBody>
            </Card>
          )}
        </section>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      <section>
        <SectionHeading
          title="Registers and open signals"
          hint="Counts across the whole project, not the statistics window."
        />
        {summary.loading && !sum ? (
          <Skeleton height={180} />
        ) : sum ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <RegisterTile label="Observations" tally={sum.observations} />
              <RegisterTile label="Incidents" tally={sum.incidents} />
              <RegisterTile
                label="Corrective actions"
                tally={sum.correctiveActions}
                extra={
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {sum.correctiveActions.overdue > 0 ? (
                      <Badge tone="danger" size="xs" dot>
                        {count(sum.correctiveActions.overdue)} overdue
                      </Badge>
                    ) : null}
                    {sum.correctiveActions.awaitingEffectivenessCheck > 0 ? (
                      <Badge tone="warning" size="xs" variant="outline">
                        {count(sum.correctiveActions.awaitingEffectivenessCheck)} unproven
                      </Badge>
                    ) : null}
                  </div>
                }
              />
              <RegisterTile label="Inspections" tally={sum.inspections} />
              <RegisterTile label="Toolbox talks" tally={sum.toolboxTalks} />
              <RegisterTile label="Programme records" tally={sum.programmeRecords} />
            </div>

            <Card>
              <CardBody>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-body font-semibold text-content">Detector signals</p>
                  <Badge tone={sum.signals.open > 0 ? "danger" : "success"} size="sm" dot>
                    {count(sum.signals.open)} open of {count(sum.signals.total)}
                  </Badge>
                </div>
                <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
                  {sum.signals.detectors.map((detector) => (
                    <li
                      key={detector}
                      className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface-raised px-2.5 py-1.5"
                    >
                      <span className="truncate text-meta text-content">
                        {SAFETY_DETECTOR_LABEL[detector] ?? labelize(detector)}
                      </span>
                      <span className="tabular-nums text-meta text-content-muted">
                        {count(sum.signals.byDetector[detector] ?? 0)}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 border-t border-border pt-2 text-2xs text-content-muted">
                  {sum.obligations.note}
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {Object.entries(sum.obligations.byStatus).map(([status, n]) => (
                    <Badge
                      key={status}
                      size="xs"
                      variant="outline"
                      tone={status === "breached" ? "danger" : "neutral"}
                    >
                      {labelize(status)} · {count(n)}
                    </Badge>
                  ))}
                  {sum.obligations.total === 0 ? (
                    <span className="text-2xs text-content-subtle">
                      No safety obligation has been raised on this project.
                    </span>
                  ) : null}
                </div>
              </CardBody>
            </Card>
          </div>
        ) : null}
      </section>
    </div>
  );
}

/**
 * Where the denominator came from, or why there isn't one. Timecards and
 * turnstile presence are never summed — the same hour appears in both.
 */
function ExposurePanel({ stats }: { stats: SafetyStatistics }) {
  const e = stats.exposure;
  return (
    <Card variant={e.hours === null ? "sunken" : "raised"} accent={e.hours === null ? "warning" : undefined}>
      <CardBody>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-label uppercase text-content-subtle">Exposure hours</p>
            <p className="mt-1 text-display-xs font-semibold tabular-nums text-content">
              {e.hours === null ? "Not available" : count(e.hours)}
            </p>
            <p className="mt-0.5 text-2xs text-content-muted">
              {e.source === "timecards"
                ? "Read from timecards — hours claimed and, where the module is in use, approved."
                : e.source === "site_access"
                  ? "Read from site-access records — turnstile or biometric presence, not worked hours."
                  : "Neither timecards nor site-access records hold hours for this window."}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-2xs">
            <SourceChip
              label="Timecards"
              hours={e.inputs.timecardHours}
              rows={e.inputs.timecardCount}
              chosen={e.source === "timecards"}
            />
            <SourceChip
              label="Site access"
              hours={e.inputs.siteAccessHours}
              rows={e.inputs.siteAccessCount}
              chosen={e.source === "site_access"}
            />
          </div>
        </div>
        {e.reasons.length > 0 ? <ReasonList reasons={e.reasons} className="mt-3" /> : null}
        <p className="mt-3 border-t border-border pt-2 text-2xs text-content-subtle">
          The two sources are never added together: the same hour appears in both, and a doubled
          denominator halves every rate on the page.
        </p>
      </CardBody>
    </Card>
  );
}

function SourceChip({
  label,
  hours,
  rows,
  chosen,
}: {
  label: string;
  hours: number | null;
  rows: number;
  chosen: boolean;
}) {
  return (
    <div
      className={cx(
        "rounded-md border px-2.5 py-1.5",
        chosen ? "border-accent-border bg-accent-subtle" : "border-border bg-surface-raised",
      )}
    >
      <p className="text-label uppercase text-content-subtle">{label}</p>
      <p className="tabular-nums text-meta text-content">
        {hours === null ? "no hours" : count(hours)}
      </p>
      <p className="text-2xs text-content-subtle">{count(rows)} records</p>
    </div>
  );
}

function RegisterTile({
  label,
  tally,
  extra,
}: {
  label: string;
  tally: { byStatus: Record<string, number>; total: number };
  extra?: ReactNode;
}) {
  const entries = Object.entries(tally.byStatus).sort((a, b) => b[1] - a[1]);
  return (
    <Card>
      <CardBody>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-label uppercase text-content-subtle">{label}</span>
          <span className="text-lg font-semibold tabular-nums text-content">
            {count(tally.total)}
          </span>
        </div>
        {entries.length === 0 ? (
          <p className="mt-1.5 text-2xs text-content-subtle">
            This register is empty on this project.
          </p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {entries.map(([status, n]) => (
              <Badge key={status} size="xs" variant="outline" tone="neutral">
                {labelize(status)} · {count(n)}
              </Badge>
            ))}
          </div>
        )}
        {extra}
      </CardBody>
    </Card>
  );
}
