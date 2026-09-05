/**
 * THE LEADING INDICATORS — the predictive index, the under-reporting read, and
 * the vendor scorecard.
 *
 * Everything on this tab is deliberately NOT an accident count. A project's
 * accident count is lagging, small-sample and, on any single job, mostly luck;
 * the numbers that predict are the ones a site can change this week — how many
 * corrective actions are overdue, how many of them were answered with a
 * briefing rather than a guard, whether anybody is still reporting near misses,
 * whether the permits have expired.
 *
 * The index is withheld rather than published thin: below 40% coverage of its
 * own weight the score is null with the components that could not be computed
 * listed. An index carried by three of nine components is a number that will be
 * quoted without its caveat.
 *
 * The under-reporting read is the most consequential thing here and is stated
 * as EVIDENCE, never as a finding: every entry says what was expected, on what
 * basis, what was observed, and — the field that matters most — what would
 * refute it. Under-reporting is the one safety failure that makes every other
 * number on the project look better, which is exactly why nobody notices it
 * from inside.
 */
import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  DataTable,
  Progress,
  Skeleton,
  Sparkline,
  type DataColumns,
} from "../../ui";
import { IconInsight, IconVendor } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  LoadError,
  RISK_BAND_LABEL,
  RISK_BAND_TONE_MAP,
  ReasonList,
  RefusalNotice,
  SectionHeading,
  count,
  decimal,
  isoDate,
  labelize,
  useMutation,
  useResource,
  type RiskIndex,
  type ScorecardResponse,
  type UnderReportingResult,
  type VendorScorecard,
} from "./safetyShared";

export default function RiskTab({
  projectId,
  version,
  onMutated,
}: {
  projectId: string;
  version: number;
  onMutated: () => void;
}) {
  const [localVersion, setLocalVersion] = useState(0);

  const index = useResource<RiskIndex>(
    (signal) => api.get<RiskIndex>(`/api/v1/projects/${projectId}/safety/risk-index`, { signal }),
    [projectId, version, localVersion],
    projectId !== "",
  );

  const underReporting = useResource<UnderReportingResult>(
    (signal) =>
      api.get<UnderReportingResult>(
        `/api/v1/projects/${projectId}/safety/under-reporting`,
        { signal },
      ),
    [projectId, version, localVersion],
    projectId !== "",
  );

  const scorecards = useResource<ScorecardResponse>(
    (signal) =>
      api.get<ScorecardResponse>(
        `/api/v1/projects/${projectId}/safety/vendor-scorecard`,
        { signal },
      ),
    [projectId, version, localVersion],
    projectId !== "",
  );

  const mutation = useMutation(() => {
    setLocalVersion((n) => n + 1);
    onMutated();
  });

  const idx = index.data;
  const trend = (idx?.trend ?? []).filter((t) => t.score !== null);

  return (
    <div className="space-y-4">
      {/* ---------------------------------------------------------------- */}
      <section className="space-y-3">
        <SectionHeading
          title="Predictive safety risk index"
          hint="Built only from leading indicators — things this site can change this week. It is not a prediction of an accident and it is not a rate."
          actions={
            <Button
              size="xs"
              variant="secondary"
              loading={mutation.busy === "recompute"}
              onClick={() =>
                void mutation.run("recompute", "The index could not be recomputed", () =>
                  api.post(`/api/v1/projects/${projectId}/safety/risk-index/recompute`, {}),
                )
              }
            >
              Recompute and snapshot
            </Button>
          }
        />

        {mutation.refusal ? <RefusalNotice refusal={mutation.refusal} onDismiss={mutation.clear} /> : null}
        {mutation.error ? (
          <Alert tone="danger" title="That could not be done" onDismiss={mutation.clear}>
            {mutation.error}
          </Alert>
        ) : null}

        {index.error ? (
          <LoadError message={index.error} onRetry={index.reload} title="The index could not be computed" />
        ) : index.loading && !idx ? (
          <Skeleton height={220} />
        ) : idx ? (
          <>
            <div className="grid gap-3 lg:grid-cols-3">
              <Card accent={idx.band === "severe" || idx.band === "high" ? "warning" : undefined}>
                <CardBody>
                  <p className="text-label uppercase text-content-subtle">Index</p>
                  <p className="mt-1 text-display-sm font-semibold tabular-nums text-content">
                    {idx.score === null ? "Withheld" : decimal(idx.score, 0)}
                  </p>
                  <Badge tone={RISK_BAND_TONE_MAP[idx.band] ?? "neutral"} size="sm" dot>
                    {RISK_BAND_LABEL[idx.band] ?? labelize(idx.band)}
                  </Badge>
                  <p className="mt-2 text-2xs text-content-muted">
                    {idx.from} → {idx.to}
                  </p>
                </CardBody>
              </Card>
              <Card>
                <CardBody>
                  <p className="text-label uppercase text-content-subtle">Coverage</p>
                  <p className="mt-1 text-display-xs font-semibold tabular-nums text-content">
                    {decimal(idx.coverage * 100, 0)}%
                  </p>
                  <Progress value={idx.coverage * 100} max={100} size="xs" />
                  <p className="mt-1 text-2xs text-content-muted">
                    How much of the index's own weight could be computed from records actually held.
                    Below 40% the score is withheld rather than published thin.
                  </p>
                </CardBody>
              </Card>
              <Card>
                <CardBody>
                  <p className="text-label uppercase text-content-subtle">Trend</p>
                  {trend.length > 1 ? (
                    <>
                      <Sparkline
                        data={trend.map((t) => t.score ?? 0)}
                        height={40}
                        tone={idx.band === "severe" || idx.band === "high" ? "danger" : "accent"}
                      />
                      <p className="mt-1 text-2xs text-content-muted">
                        {count(trend.length)} snapshots · {isoDate(trend[0]?.asOfDate)} →{" "}
                        {isoDate(trend[trend.length - 1]?.asOfDate)}
                      </p>
                    </>
                  ) : (
                    <p className="mt-1 text-2xs text-content-muted">
                      One reading is a number; two are a direction. Snapshots accumulate daily from
                      the scheduler — an index of 62 means nothing, an index that has moved 38 → 62
                      in three weeks is a conversation.
                    </p>
                  )}
                </CardBody>
              </Card>
            </div>

            <p className="whitespace-pre-wrap text-meta text-content-muted">{idx.explanation}</p>
            {idx.reasons.length > 0 ? <ReasonList reasons={idx.reasons} /> : null}

            {idx.drivers.length > 0 ? (
              <Card variant="sunken">
                <CardBody className="space-y-2">
                  <p className="text-label uppercase text-content-subtle">
                    What is driving it, in order
                  </p>
                  {idx.drivers.map((d) => (
                    <div key={d.key} className="rounded-md border border-border bg-surface p-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-meta font-medium text-content">{d.name}</span>
                        <Badge tone="warning" size="xs">
                          {decimal(d.contribution, 1)} points
                        </Badge>
                      </div>
                      <p className="mt-1 text-2xs text-content-muted">{d.advice}</p>
                    </div>
                  ))}
                </CardBody>
              </Card>
            ) : null}

            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {idx.components.map((c) => (
                <div key={c.key} className="rounded-lg border border-border bg-surface-raised p-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-meta font-medium text-content">{c.name}</span>
                    <span className="text-meta tabular-nums text-content">
                      {c.value === null ? "—" : decimal(c.value, 0)}
                    </span>
                  </div>
                  <p className="mt-1 text-2xs text-content-subtle">{c.basis}</p>
                  {c.reasons.length > 0 ? <ReasonList reasons={c.reasons} className="mt-1" /> : null}
                </div>
              ))}
            </div>
          </>
        ) : null}
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="space-y-3">
        <SectionHeading
          title="Is this register telling the truth?"
          hint="Readings about the REGISTER, not about the site. Every one states what would refute it, because the honest answer to most of them is that the site really was that quiet."
        />
        {underReporting.error ? (
          <LoadError
            message={underReporting.error}
            onRetry={underReporting.reload}
            title="That read could not be completed"
          />
        ) : underReporting.loading && !underReporting.data ? (
          <Skeleton height={140} />
        ) : underReporting.data ? (
          underReporting.data.findings.length === 0 ? (
            <Alert tone="success" size="sm" title="Nothing looks like silence">
              The counts held for {underReporting.data.from} → {underReporting.data.to} are
              consistent with the exposure and with the company's other projects. That is a statement
              about the shape of the register, not a clean bill of health for the site.
              {underReporting.data.reasons.length > 0 ? (
                <ReasonList reasons={underReporting.data.reasons} className="mt-2" />
              ) : null}
            </Alert>
          ) : (
            <div className="space-y-2">
              {underReporting.data.findings.map((f) => (
                <Card key={f.key} accent={f.severity === "critical" || f.severity === "high" ? "warning" : undefined}>
                  <CardBody className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-meta font-medium text-content">{f.title}</p>
                      <span className="flex items-center gap-1.5">
                        <Badge tone={f.severity === "critical" ? "danger" : "warning"} size="xs" dot>
                          {labelize(f.severity)}
                        </Badge>
                        <Badge tone="neutral" size="xs" variant="outline">
                          confidence {decimal(f.confidence * 100, 0)}%
                        </Badge>
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap text-2xs text-content-muted">{f.explanation}</p>
                    <dl className="grid gap-1 text-2xs sm:grid-cols-3">
                      <div>
                        <dt className="text-content-subtle">Expected</dt>
                        <dd className="text-content-muted">{f.expected}</dd>
                      </div>
                      <div>
                        <dt className="text-content-subtle">Observed</dt>
                        <dd className="text-content-muted">{f.observed}</dd>
                      </div>
                      <div>
                        <dt className="text-content-subtle">What would refute it</dt>
                        <dd className="text-content-muted">{f.refutedBy}</dd>
                      </div>
                    </dl>
                  </CardBody>
                </Card>
              ))}
            </div>
          )
        ) : null}
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="space-y-3">
        <SectionHeading
          title="Subcontractor safety record"
          hint="What each supplier's record on this project actually shows — as against what their prequalification questionnaire says about themselves. Rates use the supplier's OWN hours; a metric with no denominator is null, never zero."
        />
        {scorecards.error ? (
          <LoadError
            message={scorecards.error}
            onRetry={scorecards.reload}
            title="The scorecards could not be computed"
          />
        ) : scorecards.loading && !scorecards.data ? (
          <Skeleton height={200} />
        ) : scorecards.data ? (
          scorecards.data.scorecards.length === 0 ? (
            <Alert tone="info" size="sm" title="No supplier appears in these registers">
              <ReasonList reasons={scorecards.data.reasons} />
            </Alert>
          ) : (
            <ScorecardTable scorecards={scorecards.data.scorecards} />
          )
        ) : null}
      </section>
    </div>
  );
}

function ScorecardTable({ scorecards }: { scorecards: VendorScorecard[] }) {
  const [openVendor, setOpenVendor] = useState<string | null>(null);
  const columns: DataColumns<VendorScorecard> = [
    {
      id: "vendor",
      header: "Subcontractor",
      accessor: (row) => row.vendorName ?? row.vendorId,
      type: "text",
      sticky: "start",
      width: 220,
    },
    {
      id: "grade",
      header: "Grade",
      accessor: "grade",
      type: "enum",
      width: 110,
      cell: ({ row }) => (
        <Badge
          tone={
            row.grade === "A"
              ? "success"
              : row.grade === "B"
                ? "info"
                : row.grade === "C"
                  ? "warning"
                  : row.grade === "D"
                    ? "danger"
                    : "neutral"
          }
          size="xs"
          dot
        >
          {row.grade === "unrated" ? "Unrated" : row.grade}
        </Badge>
      ),
    },
    {
      id: "score",
      header: "Score",
      accessor: (row) => row.score ?? -1,
      type: "number",
      width: 90,
      align: "right",
      cell: ({ row }) => (row.score === null ? <span className="text-content-subtle">—</span> : decimal(row.score, 0)),
    },
    {
      id: "coverage",
      header: "Coverage",
      headerTooltip: "How much of the scorecard's weight could be computed from records actually held.",
      accessor: "coverage",
      type: "number",
      width: 110,
      align: "right",
      cell: ({ row }) => `${decimal(row.coverage * 100, 0)}%`,
    },
    {
      id: "records",
      header: "Records",
      accessor: "recordCount",
      type: "number",
      width: 100,
      align: "right",
    },
    {
      id: "flags",
      header: "Flags",
      accessor: (row) => row.flags.length,
      type: "number",
      width: 90,
      align: "right",
      cell: ({ row }) =>
        row.flags.length === 0 ? (
          <span className="text-content-subtle">None</span>
        ) : (
          <Badge tone="danger" size="xs">
            {count(row.flags.length)}
          </Badge>
        ),
    },
  ];

  const open = scorecards.find((s) => s.vendorId === openVendor) ?? null;

  return (
    <div className="space-y-2">
      <DataTable
        data={scorecards}
        columns={columns}
        getRowId={(row) => row.vendorId}
        onRowClick={({ row }) => setOpenVendor(row.vendorId === openVendor ? null : row.vendorId)}
        empty={{ icon: IconVendor, title: "No supplier record" }}
        aria-label="Subcontractor safety scorecards"
      />
      {open ? (
        <Card>
          <CardBody className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-meta font-medium text-content">
                {open.vendorName ?? open.vendorId} · {open.from} → {open.to}
              </p>
              <IconInsight className="size-4 text-content-subtle" aria-hidden />
            </div>
            {open.flags.length > 0 ? (
              <Alert tone="danger" size="sm" title="Flags">
                <ReasonList reasons={open.flags} />
              </Alert>
            ) : null}
            {open.reasons.length > 0 ? <ReasonList reasons={open.reasons} /> : null}
            <div className="grid gap-2 md:grid-cols-2">
              {open.metrics.map((m) => (
                <div key={m.key} className="rounded-lg border border-border bg-surface-raised p-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-meta font-medium text-content">{m.name}</span>
                    <span className="text-meta tabular-nums text-content">
                      {m.value === null ? "—" : `${decimal(m.value, 2)} ${m.unit}`}
                    </span>
                  </div>
                  <p className="mt-1 text-2xs text-content-subtle">{m.basis}</p>
                  {m.reasons.length > 0 ? <ReasonList reasons={m.reasons} className="mt-1" /> : null}
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
