/**
 * THE REQUIREMENT REVIEW QUEUE — the point of this whole workspace.
 *
 * The submittal register on this platform is DERIVED from the spec book rather
 * than typed, and this is the screen where that derivation is checked by a
 * person. It is a queue, not a report: identified → confirmed → registered,
 * with the two refusals that make the chain worth anything —
 *
 *   · confirmation is refused to whoever extracted or typed the row, and
 *   · registration is refused to anything that is not confirmed.
 *
 * The queue defaults to the work: everything still awaiting confirmation,
 * weakest reading first, because the lowest-confidence machine readings are
 * the ones most likely to be wrong and the ones a reviewer should see first.
 */
import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  DataTable,
  EmptyState,
  Field,
  Progress,
  SegmentedControl,
  Select,
  Skeleton,
  Stat,
  Tooltip,
  type DataColumns,
} from "../../ui";
import { IconSubmittal } from "../../ui/icons";
import RequirementCard from "./RequirementCard";
import {
  ConfidenceMeter,
  EXTRACTION_LABEL,
  EMPTY_REQUIREMENT_FILTERS,
  ExtractionDisclaimer,
  LoadError,
  Provenance,
  REQUIREMENT_STATUSES,
  REQUIREMENT_STATUS_MEANING,
  REQUIREMENT_STATUS_TONE,
  SUBMITTAL_TYPES,
  count,
  isoDate,
  titleCase,
  type Loadable,
  type Paginated,
  type RequirementFilters,
  type SpecBook,
  type SpecRequirement,
} from "./specShared";

type Layout = "queue" | "grid";

export default function ReviewQueueTab({
  projectId,
  requirements,
  books,
  filters,
  onFilters,
  onMutated,
  onOpenSection,
}: {
  projectId: string;
  requirements: Loadable<Paginated<SpecRequirement>>;
  books: SpecBook[];
  filters: RequirementFilters;
  onFilters: (next: RequirementFilters) => void;
  onMutated: () => void;
  onOpenSection: (sectionId: string) => void;
}) {
  const [layout, setLayout] = useState<Layout>("queue");

  const rows = requirements.data?.items ?? [];

  const tally = useMemo(() => {
    const byStatus = new Map<string, number>();
    let machine = 0;
    let lowConfidence = 0;
    for (const r of rows) {
      byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
      if (r.extractionMethod !== "manual") machine += 1;
      if (r.extractionConfidence !== null && r.extractionConfidence < 0.6) lowConfidence += 1;
    }
    return {
      total: rows.length,
      identified: byStatus.get("identified") ?? 0,
      confirmed: byStatus.get("confirmed") ?? 0,
      registered: byStatus.get("registered") ?? 0,
      notRequired: byStatus.get("not_required") ?? 0,
      machine,
      lowConfidence,
    };
  }, [rows]);

  /** Weakest machine reading first: it is the one most likely to be wrong. */
  const queue = useMemo(
    () =>
      rows
        .slice()
        .sort((a, b) => {
          const rank = (r: SpecRequirement) =>
            r.status === "identified" ? 0 : r.status === "confirmed" ? 1 : 2;
          const byRank = rank(a) - rank(b);
          if (byRank !== 0) return byRank;
          const ac = a.extractionConfidence ?? 1;
          const bc = b.extractionConfidence ?? 1;
          if (ac !== bc) return ac - bc;
          return a.sectionCode.localeCompare(b.sectionCode);
        }),
    [rows],
  );

  const columns = useMemo<DataColumns<SpecRequirement>>(
    () => [
      {
        id: "sectionCode",
        header: "Section",
        accessor: "sectionCode",
        type: "code",
        sticky: "start",
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
        cell: ({ row }) =>
          row.paragraphRef ?? <span className="italic text-content-subtle">unanchored</span>,
      },
      { id: "title", header: "Requirement", accessor: "title", type: "text", width: 280 },
      {
        id: "submittalType",
        header: "Type",
        accessor: "submittalType",
        type: "enum",
        width: 140,
        groupable: true,
        options: SUBMITTAL_TYPES.map((t) => ({ value: t, text: titleCase(t), label: titleCase(t) })),
        cell: ({ row }) => (
          <Badge tone="neutral" size="xs" variant="outline">
            {titleCase(row.submittalType)}
          </Badge>
        ),
      },
      {
        id: "status",
        header: "State",
        accessor: "status",
        type: "status",
        width: 140,
        groupable: true,
        options: REQUIREMENT_STATUSES.map((s) => ({
          value: s,
          text: titleCase(s),
          label: titleCase(s),
          tone: REQUIREMENT_STATUS_TONE[s] ?? "neutral",
        })),
        cell: ({ row }) => (
          <Tooltip content={REQUIREMENT_STATUS_MEANING[row.status] ?? row.status}>
            <span>
              <Badge tone={REQUIREMENT_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
                {titleCase(row.status)}
              </Badge>
            </span>
          </Tooltip>
        ),
      },
      {
        id: "extractionMethod",
        header: "How it got here",
        headerTooltip:
          "A machine reading and a human assertion are different facts. This column never collapses them.",
        accessor: "extractionMethod",
        type: "enum",
        width: 210,
        groupable: true,
        options: (["ai_extracted", "manual", "imported"] as const).map((m) => ({
          value: m,
          text: EXTRACTION_LABEL[m],
          label: EXTRACTION_LABEL[m],
        })),
        cell: ({ row }) => <Provenance provenance={row.provenance} />,
      },
      {
        id: "extractionConfidence",
        header: "Confidence",
        accessor: (row) => row.extractionConfidence,
        type: "custom",
        align: "right",
        width: 130,
        sortDescFirst: false,
        aggregate: "none",
        cell: ({ row }) =>
          row.extractionConfidence === null ? (
            <Tooltip content="A person typed this row, so no confidence was ever measured. A number here would imply a measurement that never happened.">
              <span className="italic text-content-subtle">not measured</span>
            </Tooltip>
          ) : (
            <ConfidenceMeter value={row.extractionConfidence} />
          ),
        toCsv: ({ row }) =>
          row.extractionConfidence === null ? "" : String(row.extractionConfidence),
      },
      {
        id: "registeredSubmittalId",
        header: "Submittal",
        accessor: (row) => row.registeredSubmittalId ?? "",
        type: "code",
        width: 160,
        mono: true,
        cell: ({ row }) =>
          row.registeredSubmittalId ? (
            <span className="font-mono text-2xs">{row.registeredSubmittalId}</span>
          ) : (
            <span className="italic text-content-subtle">not registered</span>
          ),
      },
      {
        id: "confirmedAt",
        header: "Confirmed",
        accessor: (row) => row.confirmedAt ?? "",
        type: "text",
        width: 120,
        cell: ({ row }) =>
          row.confirmedAt ? (
            isoDate(row.confirmedAt)
          ) : (
            <span className="italic text-content-subtle">never</span>
          ),
      },
    ],
    [],
  );

  const progressDenominator = tally.confirmed + tally.registered;

  return (
    <div className="space-y-4">
      {requirements.error ? (
        <LoadError
          message={requirements.error}
          onRetry={requirements.reload}
          title="The requirement queue could not be loaded"
        />
      ) : null}

      <Card>
        <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Stat
            label="Awaiting confirmation"
            value={count(tally.identified)}
            tone="warning"
            hint="A person other than the extractor has to read the clause before any of these can be registered."
          />
          <Stat
            label="Confirmed, not registered"
            value={count(tally.confirmed)}
            tone="info"
            hint="Agreed by a human and eligible to become a submittal."
          />
          <Stat
            label="Registered"
            value={count(tally.registered)}
            tone="success"
            hint="A real submittal exists and is the live record."
          />
          <Stat
            label="Machine readings"
            value={count(tally.machine)}
            tone={tally.machine > 0 ? "warning" : "neutral"}
            hint={`${count(tally.lowConfidence)} of them scored under 60%.`}
          />
          <div>
            <span className="text-label uppercase text-content-subtle">Register built</span>
            {progressDenominator === 0 ? (
              <p className="mt-1 text-meta italic text-content-subtle">
                Not available — no requirement on this list has been confirmed, so there is no agreed
                register to measure against. An extraction on its own is not a register.
              </p>
            ) : (
              <div className="mt-1.5">
                <Progress
                  value={(tally.registered / progressDenominator) * 100}
                  tone="success"
                  showValue
                  label={`${count(tally.registered)} of ${count(progressDenominator)} confirmed`}
                />
              </div>
            )}
          </div>
        </CardBody>
      </Card>

      <ExtractionDisclaimer machineCount={tally.machine} />

      <Card>
        <CardBody className="grid gap-3 md:grid-cols-5">
          <Field label="State">
            <Select
              value={filters.status}
              onChange={(e) => onFilters({ ...filters, status: e.target.value })}
            >
              <option value="">Every state</option>
              {REQUIREMENT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="How it got here">
            <Select
              value={filters.extractionMethod}
              onChange={(e) => onFilters({ ...filters, extractionMethod: e.target.value })}
            >
              <option value="">Any route</option>
              <option value="ai_extracted">Read by the extractor</option>
              <option value="manual">Typed by a person</option>
              <option value="imported">Imported</option>
            </Select>
          </Field>
          <Field label="Submittal type">
            <Select
              value={filters.submittalType}
              onChange={(e) => onFilters({ ...filters, submittalType: e.target.value })}
            >
              <option value="">Every type</option>
              {SUBMITTAL_TYPES.map((t) => (
                <option key={t} value={t}>
                  {titleCase(t)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Issue">
            <Select
              value={filters.bookId}
              onChange={(e) => onFilters({ ...filters, bookId: e.target.value })}
            >
              <option value="">Every issue</option>
              {books.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.reference} · {b.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Registered">
            <Select
              value={filters.registered}
              onChange={(e) => onFilters({ ...filters, registered: e.target.value })}
            >
              <option value="">Either</option>
              <option value="0">Never registered</option>
              <option value="1">Registered</option>
            </Select>
          </Field>
        </CardBody>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl<Layout>
          value={layout}
          onChange={setLayout}
          size="sm"
          options={[
            { value: "queue", label: "Review queue" },
            { value: "grid", label: "Grid" },
          ]}
        />
        {hasFilters(filters) ? (
          <Button size="xs" variant="ghost" onClick={() => onFilters(EMPTY_REQUIREMENT_FILTERS)}>
            Clear filters
          </Button>
        ) : null}
      </div>

      {requirements.loading && rows.length === 0 ? (
        <Card>
          <CardBody className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-5/6" />
          </CardBody>
        </Card>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={IconSubmittal}
          title={
            hasFilters(filters)
              ? "No requirement matches these filters"
              : "No submittal requirement has been read out of this project's spec"
          }
          hint={
            hasFilters(filters)
              ? "The filters above exclude every requirement held on this project. Clear them to see the queue."
              : "Part 1.3 of every section lists what must be submitted, and this queue is that list. Nothing has been extracted or typed yet, so the submittal register on this project has no spec basis at all — upload a book with extraction turned on, or add requirements section by section."
          }
        />
      ) : layout === "queue" ? (
        <div className="space-y-2">
          {queue.map((r) => (
            <div key={r.id}>
              <RequirementCard
                projectId={projectId}
                requirement={r}
                onMutated={onMutated}
                showSection
              />
              <div className="mt-1 pl-3">
                <button
                  type="button"
                  className="text-2xs text-accent-text underline"
                  onClick={() => onOpenSection(r.sectionId)}
                >
                  Open section {r.sectionCode}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <DataTable<SpecRequirement>
          tableId="spec-requirements"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          loading={requirements.loading}
          height={620}
          rowHeight={52}
          stickyHeader
          gridLines
          filterRow
          savedViews
          builtInViews={[
            {
              id: "builtin:awaiting",
              name: "Awaiting confirmation",
              builtIn: true,
              state: { columnFilters: [{ id: "status", value: ["identified"] }] },
            },
            {
              id: "builtin:machine",
              name: "Machine readings only",
              builtIn: true,
              state: { columnFilters: [{ id: "extractionMethod", value: ["ai_extracted"] }] },
            },
            {
              id: "builtin:confirmed-unregistered",
              name: "Confirmed, never registered",
              builtIn: true,
              state: { columnFilters: [{ id: "status", value: ["confirmed"] }] },
            },
          ]}
          exportFileName="spec-requirements"
          searchPlaceholder="Search requirements…"
          defaultSort={[{ id: "sectionCode", desc: false }]}
          rowTone={(row) =>
            row.status === "identified"
              ? "warning"
              : row.status === "registered"
                ? "success"
                : undefined
          }
          onRowClick={({ row }) => onOpenSection(row.sectionId)}
          rowActions={(row) => [
            {
              id: "section",
              label: `Open section ${row.sectionCode}`,
              onSelect: () => onOpenSection(row.sectionId),
            },
          ]}
          empty={{
            title: "No requirement held on this project",
            description: "Extract them from a spec book, or add them section by section.",
          }}
          emptyFiltered={{
            title: "No requirement matches these filters",
            description: "Widen the state, route or issue filter.",
          }}
          aria-label="Spec submittal requirements"
        />
      )}
    </div>
  );
}

function hasFilters(filters: RequirementFilters): boolean {
  return (
    filters.status !== "" ||
    filters.submittalType !== "" ||
    filters.extractionMethod !== "" ||
    filters.bookId !== "" ||
    filters.registered !== ""
  );
}
