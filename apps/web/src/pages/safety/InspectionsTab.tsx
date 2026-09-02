/**
 * INSPECTIONS — performed against a template, scored, with defects.
 *
 * Two facts sit at the front of the register:
 *
 *  · THE TEMPLATE VERSION the inspection was performed against, stamped at
 *    the time. A form revised in March does not silently rewrite what was
 *    inspected in January.
 *
 *  · CRITICAL DEFECTS separately from the score. A percentage of 92% with one
 *    critical item failed is not a pass, and a register that shows only the
 *    percentage invites exactly that reading.
 *
 * Statutory inspections carry a re-inspection interval; an overdue one is
 * painted at the rail, because the interval is a legal obligation rather than
 * a preference.
 */
import { useMemo, useState } from "react";
import {
  Badge,
  Card,
  CardBody,
  DataTable,
  EmptyState,
  Field,
  Progress,
  Select,
  Tabs,
  Tooltip,
  type DataColumns,
  type DataView,
} from "../../ui";
import { IconInspection } from "../../ui/icons";
import type { Tone } from "../../ui/tokens";
import {
  INSPECTION_RESULT_TONE,
  INSPECTION_STATUS_TONE,
  LoadError,
  SectionHeading,
  RegisterPager,
  count,
  pageParams,
  dateTime,
  decimal,
  isoDate,
  labelize,
  nameOf,
  type InspectionTemplate,
  type Paged,
  type Resource,
  type SafetyInspection,
} from "./safetyShared";

export interface InspectionFilters {
  /** 1-based; the register is paged rather than silently truncated */
  page: string;
  status: string;
  inspectionType: string;
  result: string;
  statutory: string;
  overdue: string;
}

export const EMPTY_INSPECTION_FILTERS: InspectionFilters = { page: "1",
  status: "",
  inspectionType: "",
  result: "",
  statutory: "",
  overdue: "",
};

const TYPES = [
  "general_site",
  "scaffold",
  "excavation",
  "lifting_equipment",
  "lifting_operation",
  "electrical",
  "fire",
  "ppe",
  "welfare",
  "plant",
  "temporary_works",
  "permit_audit",
  "environmental",
  "statutory",
  "executive_walk",
  "client_walk",
  "third_party",
];

const STATUSES = ["scheduled", "in_progress", "complete", "overdue", "reviewed", "closed", "void"];
const RESULTS = ["pass", "pass_with_observations", "fail", "not_applicable"];

const BUILT_IN_VIEWS: DataView[] = [
  {
    id: "builtin:failed",
    name: "Failed",
    builtIn: true,
    state: { columnFilters: [{ id: "result", value: ["fail"] }] },
  },
  {
    id: "builtin:statutory",
    name: "Statutory",
    builtIn: true,
    state: { columnFilters: [{ id: "isStatutory", value: ["Statutory"] }] },
  },
];

function rowRail(row: SafetyInspection): Tone | undefined {
  if (row.reInspectionOverdue) return "danger";
  if (row.criticalDefectCount > 0) return "danger";
  if (row.result === "fail") return "danger";
  if (row.result === "pass_with_observations") return "warning";
  return undefined;
}

export default function InspectionsTab({
  inspections,
  templates,
  filters,
  onFilters,
  users,
  onOpen,
}: {
  inspections: Resource<Paged<SafetyInspection>>;
  templates: Resource<Paged<InspectionTemplate>>;
  filters: InspectionFilters;
  onFilters: (next: InspectionFilters) => void;
  users: Map<string, string>;
  onOpen: (id: string) => void;
}) {
  const [pane, setPane] = useState<"performed" | "templates">("performed");
  const rows = inspections.data?.items ?? [];
  const templateRows = templates.data?.items ?? [];

  const columns = useMemo<DataColumns<SafetyInspection>>(
    () => [
      {
        id: "reference",
        header: "Number",
        accessor: "reference",
        type: "code",
        sticky: "start",
        width: 110,
        mono: true,
      },
      { id: "title", header: "Inspection", accessor: "title", type: "text", width: 260 },
      {
        id: "inspectionType",
        header: "Type",
        accessor: "inspectionType",
        type: "enum",
        width: 170,
        groupable: true,
        options: TYPES.map((t) => ({ value: t, text: labelize(t), label: labelize(t) })),
        cell: ({ row }) => (
          <span className="flex flex-wrap items-center gap-1">
            <Badge tone="neutral" size="xs">
              {labelize(row.inspectionType)}
            </Badge>
            {row.isStatutory ? (
              <Badge tone="info" size="xs" variant="outline">
                Statutory
              </Badge>
            ) : null}
          </span>
        ),
      },
      {
        id: "template",
        header: "Form used",
        headerTooltip:
          "The template version is stamped when the inspection is performed, so a form revised later does not rewrite what was inspected.",
        accessor: (row) =>
          row.templateId ? `${row.templateId} v${row.templateVersion ?? "?"}` : "",
        type: "text",
        width: 170,
        cell: ({ row }) =>
          row.templateId ? (
            <span className="text-2xs text-content-muted">
              version {row.templateVersion ?? "unstamped"}
            </span>
          ) : (
            <span className="text-2xs text-content-subtle">no template — free-form</span>
          ),
      },
      {
        id: "scorePercent",
        header: "Score",
        accessor: (row) => row.scorePercent ?? -1,
        type: "custom",
        align: "right",
        width: 150,
        cell: ({ row }) =>
          row.scorePercent === null ? (
            <Tooltip content="This inspection has not been completed, or its template scores nothing (a pass/fail form produces no percentage by design).">
              <span className="text-2xs text-content-subtle">no score</span>
            </Tooltip>
          ) : (
            <span className="block w-full">
              <span className="block text-right tabular-nums">
                {decimal(row.scorePercent, 1)}%
              </span>
              <Progress
                value={row.scorePercent}
                max={100}
                size="xs"
                tone={
                  row.criticalDefectCount > 0
                    ? "danger"
                    : row.scorePercent >= 90
                      ? "success"
                      : row.scorePercent >= 70
                        ? "warning"
                        : "danger"
                }
              />
            </span>
          ),
        toCsv: ({ row }) => row.scorePercent ?? "",
      },
      {
        id: "result",
        header: "Result",
        accessor: (row) => row.result ?? "",
        type: "enum",
        width: 190,
        groupable: true,
        options: RESULTS.map((r) => ({
          value: r,
          text: labelize(r),
          label: labelize(r),
          tone: INSPECTION_RESULT_TONE[r],
        })),
        cell: ({ row }) =>
          row.result ? (
            <span className="flex flex-wrap items-center gap-1">
              <Badge tone={INSPECTION_RESULT_TONE[row.result] ?? "neutral"} size="xs" dot>
                {labelize(row.result)}
              </Badge>
              {row.criticalDefectCount > 0 ? (
                <Tooltip content="A critical item failed. Whatever the percentage says, this is not a pass.">
                  <span>
                    <Badge tone="danger" size="xs" variant="solid">
                      {row.criticalDefectCount} critical
                    </Badge>
                  </span>
                </Tooltip>
              ) : null}
            </span>
          ) : (
            <span className="text-2xs text-content-subtle">not yet performed</span>
          ),
      },
      {
        id: "defectCount",
        header: "Defects",
        accessor: "defectCount",
        type: "number",
        align: "right",
        width: 100,
      },
      {
        id: "openActionCount",
        header: "Open actions",
        accessor: "openActionCount",
        type: "number",
        align: "right",
        width: 120,
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 140,
        groupable: true,
        options: STATUSES.map((s) => ({
          value: s,
          text: labelize(s),
          label: labelize(s),
          tone: INSPECTION_STATUS_TONE[s],
        })),
        cell: ({ row }) => (
          <Badge tone={INSPECTION_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
            {labelize(row.status)}
          </Badge>
        ),
      },
      {
        id: "inspector",
        header: "Inspector",
        accessor: (row) => row.inspectorName ?? (row.inspectorId ? nameOf(users, row.inspectorId) : ""),
        type: "text",
        width: 170,
      },
      {
        id: "performedAt",
        header: "Performed",
        accessor: "performedAt",
        type: "datetime",
        width: 165,
        cell: ({ row }) => dateTime(row.performedAt),
      },
      {
        id: "nextDueDate",
        header: "Re-inspection due",
        accessor: "nextDueDate",
        type: "date",
        width: 175,
        cell: ({ row }) =>
          row.nextDueDate ? (
            <span className="flex items-center gap-1.5 tabular-nums">
              {isoDate(row.nextDueDate)}
              {row.reInspectionOverdue ? (
                <Badge tone="danger" size="xs">
                  +{count(row.daysOverdue)}d
                </Badge>
              ) : null}
            </span>
          ) : (
            <span className="text-content-subtle">—</span>
          ),
      },
      {
        id: "isStatutory",
        header: "Statutory",
        accessor: (row) => (row.isStatutory ? "Statutory" : "Discretionary"),
        type: "enum",
        width: 130,
        defaultHidden: true,
      },
    ],
    [users],
  );

  return (
    <div className="space-y-4">
      {inspections.error ? (
        <LoadError
          message={inspections.error}
          onRetry={inspections.reload}
          title="The inspection register could not be loaded"
        />
      ) : null}

      <Tabs
        items={[
          { value: "performed", label: "Performed" },
          { value: "templates", label: "Templates", count: templateRows.length },
        ]}
        value={pane}
        onChange={setPane}
        size="sm"
        variant="pill"
        aria-label="Inspection views"
      />

      {pane === "performed" ? (
        <>
          <Card>
            <CardBody className="grid gap-3 md:grid-cols-3 xl:grid-cols-5">
              <Field label="Type">
                <Select
                  value={filters.inspectionType}
                  onChange={(e) => onFilters({ ...filters, inspectionType: e.target.value })}
                >
                  <option value="">Every type</option>
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {labelize(t)}
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
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {labelize(s)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Result">
                <Select
                  value={filters.result}
                  onChange={(e) => onFilters({ ...filters, result: e.target.value })}
                >
                  <option value="">Any result</option>
                  {RESULTS.map((r) => (
                    <option key={r} value={r}>
                      {labelize(r)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Statutory">
                <Select
                  value={filters.statutory}
                  onChange={(e) => onFilters({ ...filters, statutory: e.target.value })}
                >
                  <option value="">Everything</option>
                  <option value="true">Statutory only</option>
                  <option value="false">Discretionary only</option>
                </Select>
              </Field>
              <Field label="Re-inspection">
                <Select
                  value={filters.overdue}
                  onChange={(e) => onFilters({ ...filters, overdue: e.target.value })}
                >
                  <option value="">Everything</option>
                  <option value="true">Overdue only</option>
                  <option value="false">In date</option>
                </Select>
              </Field>
            </CardBody>
          </Card>

          <DataTable<SafetyInspection>
            tableId="safety-inspections"
            data={rows}
            columns={columns}
            getRowId={(row) => row.id}
            loading={inspections.loading}
            height={600}
            stickyHeader
            gridLines
            filterRow
            savedViews
            builtInViews={BUILT_IN_VIEWS}
            exportFileName="safety-inspections"
            searchPlaceholder="Search inspections…"
            defaultSort={[{ id: "performedAt", desc: true }]}
            rowTone={rowRail}
            onRowClick={({ row }) => onOpen(row.id)}
            empty={{
              icon: IconInspection,
              title: "No inspection has been performed on this project",
              description:
                "An inspection is a template answered on a date by a named person. Until one exists there is no evidence the site was walked — which is a different statement from the site being in order.",
            }}
            emptyFiltered={{
              title: "No inspection matches these filters",
              description: "Widen the type, status or result filter.",
            }}
            aria-label="Inspection register"
          />
          <RegisterPager
            page={filters.page}
            loaded={rows.length}
            total={inspections.data?.total ?? null}
            noun="inspection"
            loading={inspections.loading}
            onPage={(page) => onFilters({ ...filters, page })}
          />
        </>
      ) : (
        <TemplateList templates={templates} />
      )}
    </div>
  );
}

function TemplateList({ templates }: { templates: Resource<Paged<InspectionTemplate>> }) {
  const rows = templates.data?.items ?? [];
  return (
    <div className="space-y-3">
      {templates.error ? (
        <LoadError
          message={templates.error}
          onRetry={templates.reload}
          title="The template library could not be loaded"
        />
      ) : null}

      <SectionHeading
        title="Template library"
        hint="Company standards apply on every project; a project-level form is the exception. A template is only usable once somebody other than its author has approved it."
      />

      {rows.length === 0 && !templates.loading ? (
        <EmptyState
          icon={IconInspection}
          title="No inspection template exists yet"
          hint="Templates are held at company level so the same scaffold form is answered the same way on every site. Without one, every inspection here is free-form and nothing can be compared."
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((t) => (
            <Card key={t.id} accent={t.isStatutory ? "info" : undefined}>
              <CardBody className="space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-body font-medium text-content">{t.name}</p>
                    <p className="font-mono text-2xs text-content-muted">
                      {t.reference} · v{t.version}
                    </p>
                  </div>
                  <Badge
                    tone={t.status === "active" ? "success" : t.status === "draft" ? "warning" : "neutral"}
                    size="xs"
                    dot
                  >
                    {labelize(t.status)}
                  </Badge>
                </div>
                <p className="text-2xs text-content-muted">
                  {labelize(t.inspectionType)} · {count(t.itemCount)} items ·{" "}
                  {labelize(t.scoringMethod)} scoring
                </p>
                {t.regulatoryBasis ? (
                  <p className="text-2xs text-content-subtle">
                    Discharges: {t.regulatoryBasis}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-1.5">
                  {t.isStatutory ? (
                    <Badge tone="info" size="xs" variant="outline">
                      Statutory
                    </Badge>
                  ) : null}
                  {t.criticalItemCount ? (
                    <Badge tone="danger" size="xs" variant="outline">
                      {t.criticalItemCount} critical items
                    </Badge>
                  ) : null}
                  {t.projectId === null ? (
                    <Badge tone="neutral" size="xs" variant="outline">
                      Company standard
                    </Badge>
                  ) : (
                    <Badge tone="highlight" size="xs" variant="outline">
                      Project-specific
                    </Badge>
                  )}
                </div>
                {t.approvedBy ? null : (
                  <p className="rounded-md border border-warning-border bg-warning-subtle/50 px-2 py-1 text-2xs text-warning-fg">
                    Not approved. A template nobody but its author has signed off is not evidence of
                    a standard.
                  </p>
                )}
              </CardBody>
            </Card>
          ))}
        </div>
      )}
      {templates.loading && rows.length === 0 ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <Card>
            <CardBody>
              <Progress indeterminate />
            </CardBody>
          </Card>
        </div>
      ) : null}
    </div>
  );
}

export function inspectionQueryString(filters: InspectionFilters): string {
  const params = pageParams(filters.page);
  if (filters.status) params.set("status", filters.status);
  if (filters.inspectionType) params.set("inspectionType", filters.inspectionType);
  if (filters.result) params.set("result", filters.result);
  if (filters.statutory) params.set("statutory", filters.statutory);
  if (filters.overdue) params.set("overdue", filters.overdue);
  return params.toString();
}
