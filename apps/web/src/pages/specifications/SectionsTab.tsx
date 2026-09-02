/**
 * SECTIONS — the unit people actually reference.
 *
 * A book is 800 pages and useless in that form. The division tree on the left
 * is the tabbed binder; the grid on the right is every section in the project,
 * with the two counts that decide whether the register can be built from it:
 * how many requirements have been read out of it, and whether ANY of them has
 * been confirmed by a person.
 *
 * `requirementsConfirmed` is a flag, not a count, on purpose — the API sets it
 * when at least one requirement on the section reached `confirmed`. A section
 * showing "0 confirmed" is not a section with no work in it; it is a section
 * whose extraction nobody has read yet, and the empty state says so.
 */
import { useMemo } from "react";
import {
  Badge,
  Card,
  CardBody,
  DataTable,
  EmptyState,
  Field,
  Input,
  Select,
  Skeleton,
  Tooltip,
  TreeView,
  type DataColumns,
  type TreeNode,
} from "../../ui";
import { IconSpec } from "../../ui/icons";
import {
  EMPTY_SECTION_FILTERS,
  LoadError,
  SECTION_STATUS_TONE,
  count,
  isoDate,
  titleCase,
  type Loadable,
  type Paginated,
  type SectionFilters,
  type SpecBook,
  type SpecDivision,
  type SpecSection,
} from "./specShared";

const SECTION_STATUSES = ["draft", "current", "superseded", "withdrawn"] as const;

export default function SectionsTab({
  sections,
  divisions,
  books,
  filters,
  onFilters,
  onOpenSection,
}: {
  sections: Loadable<Paginated<SpecSection>>;
  divisions: Loadable<{ items: SpecDivision[]; total: number }>;
  books: SpecBook[];
  filters: SectionFilters;
  onFilters: (next: SectionFilters) => void;
  onOpenSection: (sectionId: string) => void;
}) {
  const rows = sections.data?.items ?? [];

  /**
   * The binder. Divisions can repeat across books (each book has its own
   * division rows), so they are folded by code and the section counts summed —
   * the tree is a navigation aid over the project's sections, not a per-book
   * table of contents.
   */
  const tree = useMemo<TreeNode[]>(() => {
    const byCode = new Map<string, { code: string; title: string; sections: SpecSection[] }>();
    for (const d of divisions.data?.items ?? []) {
      if (!byCode.has(d.code)) byCode.set(d.code, { code: d.code, title: d.title, sections: [] });
    }
    for (const s of rows) {
      const code = s.divisionCode ?? "??";
      const entry = byCode.get(code) ?? { code, title: `Division ${code}`, sections: [] };
      entry.sections.push(s);
      byCode.set(code, entry);
    }
    return [...byCode.values()]
      .sort((a, b) => a.code.localeCompare(b.code))
      .map<TreeNode>((d) => ({
        id: `div:${d.code}`,
        label: (
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="font-mono text-2xs text-content-subtle">{d.code}</span>
            <span className="truncate">{d.title}</span>
          </span>
        ),
        text: `${d.code} ${d.title}`,
        count: d.sections.length,
        children: d.sections
          .slice()
          .sort((a, b) => a.code.localeCompare(b.code))
          .map<TreeNode>((s) => ({
            id: s.id,
            label: (
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="font-mono text-2xs text-content-subtle">{s.code}</span>
                <span className="truncate">{s.title}</span>
              </span>
            ),
            text: `${s.code} ${s.title}`,
            tone: s.requirementsConfirmed === 1 ? "success" : "warning",
            badge:
              s.submittalRequirementCount > 0 ? (
                <Badge
                  tone={s.requirementsConfirmed === 1 ? "success" : "warning"}
                  size="xs"
                  variant="subtle"
                >
                  {count(s.submittalRequirementCount)}
                </Badge>
              ) : undefined,
          })),
      }));
  }, [divisions.data, rows]);

  const columns = useMemo<DataColumns<SpecSection>>(
    () => [
      {
        id: "code",
        header: "Section",
        accessor: "code",
        type: "code",
        sticky: "start",
        width: 120,
        mono: true,
      },
      { id: "title", header: "Title", accessor: "title", type: "text", width: 300 },
      {
        id: "divisionCode",
        header: "Division",
        accessor: (row) => row.divisionCode ?? "",
        type: "enum",
        width: 100,
        groupable: true,
        cell: ({ row }) => (
          <span className="font-mono text-2xs">{row.divisionCode ?? "—"}</span>
        ),
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 130,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone={SECTION_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
            {titleCase(row.status)}
          </Badge>
        ),
      },
      {
        id: "revisionCount",
        header: "Revisions",
        accessor: "revisionCount",
        type: "number",
        align: "right",
        width: 100,
        aggregate: "none",
      },
      {
        id: "requirements",
        header: "Requirements",
        accessor: "submittalRequirementCount",
        type: "number",
        align: "right",
        width: 130,
        aggregate: "none",
        cell: ({ row }) =>
          row.submittalRequirementCount === 0 ? (
            <Tooltip content="Nothing has ever been read or typed for this section — so the register has no basis to build a submittal from it.">
              <span className="italic text-content-subtle">none read</span>
            </Tooltip>
          ) : (
            <span className="tabular-nums">{count(row.submittalRequirementCount)}</span>
          ),
      },
      {
        id: "requirementsConfirmed",
        header: "Human confirmed",
        headerTooltip:
          "Set when at least one requirement on this section has been confirmed by a person other than whoever extracted it. Until then the section contributes nothing to the register.",
        accessor: (row) => (row.requirementsConfirmed === 1 ? "yes" : "no"),
        type: "enum",
        width: 170,
        groupable: true,
        options: [
          { value: "yes", text: "Confirmed", label: "Confirmed", tone: "success" },
          { value: "no", text: "Not confirmed", label: "Not confirmed", tone: "warning" },
        ],
        cell: ({ row }) =>
          row.requirementsConfirmed === 1 ? (
            <Badge tone="success" size="xs">
              At least one confirmed
            </Badge>
          ) : (
            <Badge tone="warning" size="xs" variant="solid">
              None confirmed
            </Badge>
          ),
      },
      {
        id: "updatedAt",
        header: "Updated",
        accessor: "updatedAt",
        type: "text",
        width: 120,
        cell: ({ row }) => isoDate(row.updatedAt),
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      {sections.error ? (
        <LoadError
          message={sections.error}
          onRetry={sections.reload}
          title="The spec sections could not be loaded"
        />
      ) : null}

      <Card>
        <CardBody className="grid gap-3 md:grid-cols-4">
          <Field label="Issue">
            <Select
              value={filters.bookId}
              onChange={(e) => onFilters({ ...filters, bookId: e.target.value })}
            >
              <option value="">Every issue</option>
              {books.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.reference} · {b.name}
                  {b.isCurrent === 1 ? " (current)" : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status">
            <Select
              value={filters.status}
              onChange={(e) => onFilters({ ...filters, status: e.target.value })}
            >
              <option value="">Every status</option>
              {SECTION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Division code" hint="Two digits, e.g. 03 for Concrete.">
            <Input
              value={filters.divisionCode}
              placeholder="03"
              onChange={(e) => onFilters({ ...filters, divisionCode: e.target.value })}
            />
          </Field>
          <Field label="Search" hint="Matches the section title.">
            <Input
              value={filters.search}
              placeholder="cast-in-place concrete…"
              onChange={(e) => onFilters({ ...filters, search: e.target.value })}
            />
          </Field>
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <Card className="h-fit">
          <CardBody className="space-y-2">
            <p className="text-label uppercase text-content-subtle">Divisions</p>
            {divisions.loading && tree.length === 0 ? (
              <div className="space-y-1.5">
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-11/12" />
                <Skeleton className="h-6 w-10/12" />
                <Skeleton className="h-6 w-9/12" />
              </div>
            ) : tree.length === 0 ? (
              <p className="py-6 text-center text-meta text-content-subtle">
                No division has been split out yet. Divisions appear once a book has been uploaded
                and split.
              </p>
            ) : (
              <TreeView
                nodes={tree}
                showCounts
                aria-label="Spec divisions and sections"
                onSelect={(node) => {
                  if (node.id.startsWith("div:")) {
                    onFilters({ ...filters, divisionCode: node.id.slice(4) });
                  } else {
                    onOpenSection(node.id);
                  }
                }}
                emptyText="No divisions."
              />
            )}
            {filters.divisionCode ? (
              <button
                type="button"
                className="text-2xs text-accent-text underline"
                onClick={() => onFilters({ ...filters, divisionCode: "" })}
              >
                Clear the division {filters.divisionCode} filter
              </button>
            ) : null}
          </CardBody>
        </Card>

        <div>
          {!sections.loading && rows.length === 0 ? (
            <EmptyState
              icon={IconSpec}
              title={
                hasFilters(filters)
                  ? "No section matches these filters"
                  : "This project holds no spec sections"
              }
              hint={
                hasFilters(filters)
                  ? "The filters above exclude every section in the project. Widen the issue, status or division and the binder will fill back in."
                  : "Sections are created by splitting an uploaded spec book, or by hand when a section arrives outside the book. Until one exists, no submittal on this project can be traced back to a clause."
              }
            />
          ) : (
            <DataTable<SpecSection>
              tableId="spec-sections"
              data={rows}
              columns={columns}
              getRowId={(row) => row.id}
              loading={sections.loading}
              height={560}
              stickyHeader
              gridLines
              filterRow
              savedViews
              exportFileName="spec-sections"
              searchPlaceholder="Search sections…"
              defaultSort={[{ id: "code", desc: false }]}
              rowTone={(row) =>
                row.status === "withdrawn"
                  ? "danger"
                  : row.requirementsConfirmed === 1
                    ? undefined
                    : "warning"
              }
              onRowClick={({ row }) => onOpenSection(row.id)}
              rowActions={(row) => [
                { id: "open", label: "Open section", onSelect: () => onOpenSection(row.id) },
              ]}
              empty={{
                title: "No section on this project",
                description: "Upload a spec book and it will be split into sections.",
              }}
              emptyFiltered={{
                title: "No section matches these filters",
                description: "Clear the division or status filter to widen the list.",
              }}
              aria-label="Spec sections"
            />
          )}
        </div>
      </div>
    </div>
  );
}

function hasFilters(filters: SectionFilters): boolean {
  return (
    filters.bookId !== EMPTY_SECTION_FILTERS.bookId ||
    filters.status !== EMPTY_SECTION_FILTERS.status ||
    filters.divisionCode !== EMPTY_SECTION_FILTERS.divisionCode ||
    filters.search !== EMPTY_SECTION_FILTERS.search
  );
}
