/**
 * COVERAGE — the three questions a register built from the spec must answer.
 *
 *   1. Which sections have nothing anybody has agreed to?
 *   2. Which requirements were agreed and then never registered?
 *   3. Which submittals exist with no clause behind them at all?
 *
 * The headline figure is `registerCompleteness`, and it is the platform's
 * standard honest-figure shape: when no requirement has been confirmed there
 * is no agreed register to measure against, so the API returns `value: null`
 * with the reason and this screen prints the reason rather than a 0%. A zero
 * would say "we built none of the register"; null says "there is no register
 * to have built any of", and those are different projects.
 */
import { useMemo, type ReactNode } from "react";
import {
  Alert,
  Badge,
  Card,
  CardBody,
  ChartCard,
  DataTable,
  DonutChart,
  EmptyState,
  Skeleton,
  Stat,
  Tooltip,
  type DataColumns,
} from "../../ui";
import { IconCheckCircle, IconCompliance } from "../../ui/icons";
import {
  ConfidenceMeter,
  LoadError,
  ReasonList,
  UnknowableValue,
  count,
  titleCase,
  type Loadable,
  type SpecCoverage,
} from "./specShared";

type SectionGap = SpecCoverage["sectionsWithoutConfirmedRequirements"][number];
type NeverRegistered = SpecCoverage["requirementsNeverRegistered"][number];
type OrphanSubmittal = SpecCoverage["submittalsWithoutSpecBasis"][number];

export default function CoverageTab({
  coverage,
  onOpenSection,
}: {
  coverage: Loadable<SpecCoverage>;
  onOpenSection: (sectionId: string) => void;
}) {
  const data = coverage.data;

  const mix = useMemo(() => {
    if (!data) return [];
    const s = data.summary;
    return [
      { label: "Registered", value: s.registered, tone: "success" as const },
      { label: "Confirmed, not registered", value: s.confirmed, tone: "info" as const },
      { label: "Awaiting confirmation", value: s.identified, tone: "warning" as const },
      { label: "Ruled out", value: s.notRequired, tone: "neutral" as const },
    ].filter((slice) => slice.value > 0);
  }, [data]);

  const gapColumns = useMemo<DataColumns<SectionGap>>(
    () => [
      { id: "code", header: "Section", accessor: "code", type: "code", width: 120, mono: true },
      { id: "title", header: "Title", accessor: "title", type: "text", width: 260 },
      {
        id: "extractedButUnconfirmed",
        header: "Read but unconfirmed",
        accessor: "extractedButUnconfirmed",
        type: "number",
        align: "right",
        width: 170,
        aggregate: "sum",
      },
      {
        id: "reason",
        header: "Why it contributes nothing",
        accessor: "reason",
        type: "text",
        width: 420,
        truncate: false,
        cell: ({ row }) => (
          <span className="whitespace-normal text-meta text-content-muted">{row.reason}</span>
        ),
      },
    ],
    [],
  );

  const neverColumns = useMemo<DataColumns<NeverRegistered>>(
    () => [
      {
        id: "sectionCode",
        header: "Section",
        accessor: "sectionCode",
        type: "code",
        width: 110,
        mono: true,
        groupable: true,
      },
      {
        id: "paragraphRef",
        header: "Paragraph",
        accessor: (row) => row.paragraphRef ?? "",
        type: "code",
        width: 105,
        mono: true,
      },
      { id: "title", header: "Requirement", accessor: "title", type: "text", width: 260 },
      {
        id: "submittalType",
        header: "Type",
        accessor: "submittalType",
        type: "enum",
        width: 130,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone="neutral" size="xs" variant="outline">
            {titleCase(row.submittalType)}
          </Badge>
        ),
      },
      {
        id: "humanConfirmed",
        header: "Human confirmed",
        accessor: (row) => (row.humanConfirmed ? "yes" : "no"),
        type: "enum",
        width: 150,
        groupable: true,
        cell: ({ row }) =>
          row.humanConfirmed ? (
            <Badge tone="success" size="xs" icon={IconCheckCircle}>
              Confirmed
            </Badge>
          ) : (
            <Badge tone="warning" size="xs" variant="solid">
              Not confirmed
            </Badge>
          ),
      },
      {
        id: "confidence",
        header: "Confidence",
        accessor: (row) => row.extractionConfidence,
        type: "custom",
        align: "right",
        width: 130,
        aggregate: "none",
        cell: ({ row }) =>
          row.extractionConfidence === null ? (
            <Tooltip content="Typed by a person — no confidence was measured.">
              <span className="italic text-content-subtle">not measured</span>
            </Tooltip>
          ) : (
            <ConfidenceMeter value={row.extractionConfidence} />
          ),
        toCsv: ({ row }) =>
          row.extractionConfidence === null ? "" : String(row.extractionConfidence),
      },
      {
        id: "blocker",
        header: "What is stopping it",
        accessor: "blocker",
        type: "text",
        width: 300,
        truncate: false,
        cell: ({ row }) => (
          <span className="whitespace-normal text-meta text-content-muted">{row.blocker}</span>
        ),
      },
    ],
    [],
  );

  const orphanColumns = useMemo<DataColumns<OrphanSubmittal>>(
    () => [
      {
        id: "number",
        header: "Submittal",
        accessor: "number",
        type: "number",
        width: 110,
        mono: true,
        cell: ({ row }) => (
          <span className="font-mono">
            SUB-{String(row.number).padStart(3, "0")}
            {row.revision > 0 ? `.${row.revision}` : ""}
          </span>
        ),
      },
      { id: "title", header: "Title", accessor: "title", type: "text", width: 280 },
      {
        id: "specSection",
        header: "Cited section",
        accessor: (row) => row.specSection ?? "",
        type: "code",
        width: 130,
        mono: true,
        cell: ({ row }) =>
          row.specSection ? (
            <span className="font-mono">{row.specSection}</span>
          ) : (
            <span className="italic text-content-subtle">none cited</span>
          ),
      },
      {
        id: "reason",
        header: "Why it has no spec basis",
        accessor: "reason",
        type: "text",
        width: 420,
        truncate: false,
        cell: ({ row }) => (
          <span className="whitespace-normal text-meta text-content-muted">{row.reason}</span>
        ),
      },
    ],
    [],
  );

  if (coverage.error) {
    return (
      <LoadError
        message={coverage.error}
        onRetry={coverage.reload}
        title="The coverage report could not be loaded"
      />
    );
  }

  if (coverage.loading && !data) {
    return (
      <div className="space-y-4">
        <Card>
          <CardBody className="grid gap-4 sm:grid-cols-4">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </CardBody>
        </Card>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data) return null;

  const s = data.summary;
  const completeness = data.registerCompleteness;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardBody className="space-y-4">
            <div>
              <p className="text-label uppercase text-content-subtle">Register completeness</p>
              <div className="mt-1 text-display-xs font-semibold text-content">
                <UnknowableValue
                  figure={completeness}
                  render={(value) => (
                    <span className="tabular-nums">
                      {value}
                      <span className="text-lg">%</span>
                    </span>
                  )}
                />
              </div>
              {completeness.value !== null ? (
                <p className="mt-1 text-meta text-content-muted">
                  {count(s.registered)} of {count(s.confirmed + s.registered)} confirmed requirements
                  have become real submittals. The denominator is deliberately the CONFIRMED set,
                  not everything extracted — an unconfirmed machine reading is not something the
                  project has agreed to deliver.
                </p>
              ) : null}
            </div>
            <div className="grid gap-4 sm:grid-cols-4">
              <Stat label="Sections" value={count(s.sections)} />
              <Stat label="Requirements held" value={count(s.requirements)} />
              <Stat
                label="Awaiting confirmation"
                value={count(s.identified)}
                tone={s.identified > 0 ? "warning" : "neutral"}
              />
              <Stat label="Submittals on project" value={count(s.submittals)} />
            </div>
          </CardBody>
        </Card>

        <ChartCard
          title="Where the requirements sit"
          subtitle="Every requirement held on this project, by state."
          footnote="Confirmation is a human act performed by someone other than the extractor. Nothing moves out of 'awaiting confirmation' on its own."
        >
          <DonutChart
            data={mix}
            height={240}
            legendPosition="bottom"
            emptyMessage="No requirement has been extracted or typed on this project, so there is no distribution to draw."
            ariaLabel="Requirement states"
          />
        </ChartCard>
      </div>

      <Section
        title="Sections with nothing anybody has agreed to"
        badge={s.sectionsWithoutConfirmedRequirements}
        description="These sections are live in the spec and contribute nothing to the register. Some have never been read at all; others were read and nobody has confirmed the reading."
        emptyTitle="Every live section has at least one confirmed requirement"
        emptyHint="Nothing here means the review queue has been worked through — not that the queue is empty."
      >
        {data.sectionsWithoutConfirmedRequirements.length > 0 ? (
          <DataTable<SectionGap>
            tableId="spec-coverage-gaps"
            data={data.sectionsWithoutConfirmedRequirements}
            columns={gapColumns}
            getRowId={(row) => row.sectionId}
            height={320}
            rowHeight={48}
            stickyHeader
            gridLines
            exportFileName="spec-sections-without-confirmed-requirements"
            defaultSort={[{ id: "code", desc: false }]}
            rowTone={() => "warning"}
            onRowClick={({ row }) => onOpenSection(row.sectionId)}
            aria-label="Sections without confirmed requirements"
          />
        ) : null}
      </Section>

      <Section
        title="Requirements that never became a submittal"
        badge={s.requirementsNeverRegistered}
        description="Each row states what is stopping it — awaiting a human, or confirmed and simply never registered. The second kind is the dangerous one: the project agreed the submittal was required and then did not raise it."
        emptyTitle="Every requirement held has been registered or ruled out"
        emptyHint="No requirement is sitting between agreement and action."
      >
        {data.requirementsNeverRegistered.length > 0 ? (
          <DataTable<NeverRegistered>
            tableId="spec-coverage-unregistered"
            data={data.requirementsNeverRegistered}
            columns={neverColumns}
            getRowId={(row) => row.requirementId}
            height={380}
            rowHeight={48}
            stickyHeader
            gridLines
            filterRow
            exportFileName="spec-requirements-never-registered"
            defaultSort={[{ id: "sectionCode", desc: false }]}
            rowTone={(row) => (row.humanConfirmed ? "info" : "warning")}
            aria-label="Requirements never registered"
          />
        ) : null}
      </Section>

      <Section
        title="Submittals with no spec basis"
        badge={s.submittalsWithoutSpecBasis}
        description="A submittal that was not built from any requirement. It may be perfectly legitimate — but nobody can point at the clause that demanded it, which is exactly the position you do not want to be in when a rejection is disputed."
        emptyTitle="Every submittal on this project traces back to a requirement"
        emptyHint="The register is fully derived from the spec book."
      >
        {data.submittalsWithoutSpecBasis.length > 0 ? (
          <DataTable<OrphanSubmittal>
            tableId="spec-coverage-orphans"
            data={data.submittalsWithoutSpecBasis}
            columns={orphanColumns}
            getRowId={(row) => row.submittalId}
            height={340}
            rowHeight={48}
            stickyHeader
            gridLines
            filterRow
            exportFileName="submittals-without-spec-basis"
            defaultSort={[{ id: "number", desc: false }]}
            rowTone={() => "warning"}
            aria-label="Submittals without a spec basis"
          />
        ) : null}
      </Section>

      {completeness.value === null ? (
        <Alert tone="info" variant="subtle" title="Why there is no percentage above">
          <ReasonList reasons={completeness.reasons} />
          <p className="mt-2 text-meta">
            The inputs the figure would have been computed from are held and shown in the counts
            above; what is missing is a denominator that means anything.
          </p>
        </Alert>
      ) : null}
    </div>
  );
}

function Section({
  title,
  badge,
  description,
  emptyTitle,
  emptyHint,
  children,
}: {
  title: string;
  badge: number;
  description: string;
  emptyTitle: string;
  emptyHint: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-content">{title}</h3>
          <Badge tone={badge > 0 ? "warning" : "success"} size="xs">
            {count(badge)}
          </Badge>
        </div>
        <p className="max-w-prose text-meta text-content-muted">{description}</p>
        {badge === 0 ? (
          <EmptyState
            icon={IconCompliance}
            size="sm"
            title={emptyTitle}
            hint={emptyHint}
            tone="success"
          />
        ) : (
          children
        )}
      </CardBody>
    </Card>
  );
}
