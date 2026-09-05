/**
 * THE INCIDENT REGISTER.
 *
 * Two columns make this more than a list of bad days:
 *
 *  · REPORTABILITY carries the regime, the governing rule and its citation.
 *    A row whose determination is unsettled says so in amber — it is NOT
 *    shown as "not reportable", because the engine did not decide it.
 *
 *  · THE CLOCK is live. A reportable incident with no notification recorded
 *    counts down to its statutory deadline in the row, and the moment the
 *    deadline passes the cell changes register: it stops counting down and
 *    starts counting how long the breach has stood.
 *
 * The rail down the left edge is painted from the same fact, so a missed
 * notification is visible before anything is read.
 */
import { useMemo } from "react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  DataTable,
  Field,
  Input,
  Select,
  type DataColumns,
  type DataView,
} from "../../ui";
import { IconSafety } from "../../ui/icons";
import type { Tone } from "../../ui/tokens";
import {
  INCIDENT_SEVERITY_TONE,
  INCIDENT_STATUS_TONE,
  INVESTIGATION_STATUS_TONE,
  LoadError,
  NotificationCountdown,
  REGIME_LABEL,
  RegisterPager,
  count,
  pageParams,
  dateTime,
  labelize,
  nameOf,
  type Paged,
  type Resource,
  type SafetyIncident,
} from "./safetyShared";

export interface IncidentFilters {
  /** 1-based; the register is paged rather than silently truncated */
  page: string;
  incidentType: string;
  severity: string;
  status: string;
  reportable: string;
  investigationStatus: string;
  from: string;
  to: string;
}

export const EMPTY_INCIDENT_FILTERS: IncidentFilters = { page: "1",
  incidentType: "",
  severity: "",
  status: "",
  reportable: "",
  investigationStatus: "",
  from: "",
  to: "",
};

const INCIDENT_TYPES = [
  "injury",
  "occupational_illness",
  "near_miss",
  "property_damage",
  "environmental",
  "fire",
  "dangerous_occurrence",
  "security",
  "road_traffic",
  "utility_strike",
  "structural_failure",
  "public_impact",
];

const SEVERITIES = ["negligible", "minor", "serious", "major", "catastrophic"];

const STATUSES = [
  "reported",
  "under_investigation",
  "actions_open",
  "pending_closure",
  "closed",
  "reopened",
  "void",
];

const INVESTIGATION_STATUSES = [
  "not_started",
  "in_progress",
  "under_review",
  "complete",
  "reopened",
];

const BUILT_IN_VIEWS: DataView[] = [
  {
    id: "builtin:reportable",
    name: "Reportable",
    builtIn: true,
    state: { columnFilters: [{ id: "reportability", value: ["reportable", "unsettled"] }] },
  },
  {
    id: "builtin:open",
    name: "Open",
    builtIn: true,
    state: {
      columnFilters: [
        { id: "status", value: ["reported", "under_investigation", "actions_open", "reopened"] },
      ],
    },
  },
  {
    id: "builtin:lost-time",
    name: "Lost time",
    builtIn: true,
    state: { columnFilters: [{ id: "isLostTime", value: ["Lost time"] }] },
  },
];

/** One word for the row's statutory position — the value the filter reads. */
function reportabilityKey(row: SafetyIncident): string {
  if (row.notification.needsHumanReview === true) return "unsettled";
  if (row.isReportable) return row.notification.notifiedAt ? "notified" : "reportable";
  return "not_reportable";
}

const REPORTABILITY_LABEL: Record<string, string> = {
  unsettled: "Determination unsettled",
  reportable: "Reportable — not yet notified",
  notified: "Reportable — notified",
  not_reportable: "Not reportable on the facts held",
};

const REPORTABILITY_TONE: Record<string, Tone> = {
  unsettled: "warning",
  reportable: "danger",
  notified: "success",
  not_reportable: "neutral",
};

function rowRail(row: SafetyIncident): Tone | undefined {
  if (row.notification.missed) return "danger";
  if (row.notification.needsHumanReview === true) return "warning";
  if (row.isReportable && !row.notification.notifiedAt) return "danger";
  if (row.investigation.isOverdue) return "warning";
  return undefined;
}

export default function IncidentsTab({
  incidents,
  filters,
  onFilters,
  users,
  vendors,
  onOpen,
  onNew,
}: {
  incidents: Resource<Paged<SafetyIncident>>;
  filters: IncidentFilters;
  onFilters: (next: IncidentFilters) => void;
  users: Map<string, string>;
  vendors: Map<string, string>;
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  const rows = incidents.data?.items ?? [];

  const columns = useMemo<DataColumns<SafetyIncident>>(
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
      {
        id: "occurredAt",
        header: "Occurred",
        accessor: "occurredAt",
        type: "datetime",
        width: 160,
        sortDescFirst: true,
        cell: ({ row }) => (
          <span className="tabular-nums">
            {dateTime(row.occurredAt)}
            {row.reportingDelayHours !== null && row.reportingDelayHours > 24 ? (
              <span className="ml-1.5 text-2xs text-warning-fg">
                reported {Math.round(row.reportingDelayHours)}h later
              </span>
            ) : null}
          </span>
        ),
      },
      {
        id: "title",
        header: "What happened",
        accessor: "title",
        type: "text",
        width: 280,
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{row.title}</span>
            {row.isFatality ? (
              <Badge tone="danger" size="xs" variant="solid">
                Fatality
              </Badge>
            ) : null}
            {row.isConfidential ? (
              <Badge tone="neutral" size="xs" variant="outline">
                Confidential
              </Badge>
            ) : null}
          </span>
        ),
      },
      {
        id: "incidentType",
        header: "Type",
        accessor: "incidentType",
        type: "enum",
        width: 160,
        groupable: true,
        options: INCIDENT_TYPES.map((t) => ({ value: t, text: labelize(t), label: labelize(t) })),
        cell: ({ row }) => (
          <Badge tone="neutral" size="xs">
            {labelize(row.incidentType)}
          </Badge>
        ),
      },
      {
        id: "severity",
        header: "Severity",
        accessor: "severity",
        type: "enum",
        width: 130,
        groupable: true,
        options: SEVERITIES.map((s) => ({
          value: s,
          text: labelize(s),
          label: labelize(s),
          tone: INCIDENT_SEVERITY_TONE[s],
        })),
        cell: ({ row }) => (
          <Badge tone={INCIDENT_SEVERITY_TONE[row.severity] ?? "neutral"} size="xs" dot>
            {labelize(row.severity)}
          </Badge>
        ),
      },
      {
        id: "person",
        header: "Injured person",
        // the API resolves workerId against the WORKER register; the company
        // user directory does not contain workers and printed a raw id here
        accessor: (row) => row.injuredPersonDisplayName ?? row.injuredPersonName ?? "",
        type: "text",
        width: 190,
        cell: ({ row }) => {
          const who = row.injuredPersonDisplayName ?? row.injuredPersonName ?? null;
          if (!who) return <span className="text-content-subtle">—</span>;
          return (
            <span className="block min-w-0">
              <span className="block truncate">{who}</span>
              <span className="block truncate text-2xs text-content-subtle">
                {[
                  row.injuredPersonType ? labelize(row.injuredPersonType) : null,
                  row.vendorId ? nameOf(vendors, row.vendorId) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </span>
          );
        },
      },
      {
        id: "reportability",
        header: "Statutory position",
        headerTooltip:
          "Computed by the reportability engine from the facts held. An amber row is one the engine could NOT decide — it is an open question, not a negative result.",
        accessor: (row) => reportabilityKey(row),
        type: "enum",
        width: 260,
        truncate: false,
        groupable: true,
        options: Object.keys(REPORTABILITY_LABEL).map((k) => ({
          value: k,
          text: REPORTABILITY_LABEL[k]!,
          label: REPORTABILITY_LABEL[k]!,
          tone: REPORTABILITY_TONE[k],
        })),
        cell: ({ row }) => {
          const key = reportabilityKey(row);
          const governing = row.reportability?.governingRuleId
            ? row.reportability.rules.find((r) => r.ruleId === row.reportability?.governingRuleId)
            : undefined;
          return (
            <span className="block min-w-0 py-0.5">
              <Badge tone={REPORTABILITY_TONE[key] ?? "neutral"} size="xs" dot>
                {REPORTABILITY_LABEL[key]}
              </Badge>
              {row.notification.regimes.length > 0 ? (
                <span className="mt-1 block truncate text-2xs text-content-muted">
                  {row.notification.regimes.map((r) => REGIME_LABEL[r] ?? r).join(" · ")}
                </span>
              ) : null}
              {governing ? (
                <span className="mt-0.5 block truncate font-mono text-2xs text-content-subtle">
                  {governing.citation}
                </span>
              ) : null}
              {key === "unsettled" && row.notification.openQuestions.length > 0 ? (
                <span className="mt-0.5 block truncate text-2xs text-warning-fg">
                  {row.notification.openQuestions[0]}
                </span>
              ) : null}
            </span>
          );
        },
        toCsv: ({ row }) =>
          `${REPORTABILITY_LABEL[reportabilityKey(row)]}${
            row.notification.regimes.length > 0 ? ` (${row.notification.regimes.join(", ")})` : ""
          }`,
      },
      {
        id: "deadline",
        header: "Notification clock",
        headerTooltip:
          "A live countdown to the statutory deadline. Once it passes it counts up instead — a missed notification is an offence, not a late field.",
        accessor: (row) => row.notification.dueAt ?? "",
        type: "custom",
        width: 200,
        truncate: false,
        interactive: true,
        cell: ({ row }) =>
          row.notification.dueAt ? (
            <span className="block py-0.5">
              <NotificationCountdown
                dueAt={row.notification.dueAt}
                notifiedAt={row.notification.notifiedAt}
                size="sm"
              />
              <span className="mt-0.5 block text-2xs text-content-subtle">
                due {dateTime(row.notification.dueAt)}
              </span>
            </span>
          ) : (
            <span className="text-2xs text-content-subtle">
              {row.isReportable ? "No deadline computed" : "—"}
            </span>
          ),
        toCsv: ({ row }) => row.notification.dueAt ?? "",
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 150,
        groupable: true,
        options: STATUSES.map((s) => ({
          value: s,
          text: labelize(s),
          label: labelize(s),
          tone: INCIDENT_STATUS_TONE[s],
        })),
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5">
            <Badge tone={INCIDENT_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
              {labelize(row.status)}
            </Badge>
            {row.reopenedCount > 0 ? (
              <Badge tone="warning" size="xs" variant="outline">
                ×{row.reopenedCount}
              </Badge>
            ) : null}
          </span>
        ),
      },
      {
        id: "investigation",
        header: "Investigation",
        accessor: (row) => row.investigation.status,
        type: "enum",
        width: 175,
        groupable: true,
        options: INVESTIGATION_STATUSES.map((s) => ({
          value: s,
          text: labelize(s),
          label: labelize(s),
          tone: INVESTIGATION_STATUS_TONE[s],
        })),
        cell: ({ row }) => (
          <span className="flex flex-wrap items-center gap-1">
            <Badge tone={INVESTIGATION_STATUS_TONE[row.investigation.status] ?? "neutral"} size="xs">
              {labelize(row.investigation.status)}
            </Badge>
            {row.investigation.isOverdue ? (
              <Badge tone="danger" size="xs" variant="outline">
                {count(row.investigation.daysOverdue)}d late
              </Badge>
            ) : null}
          </span>
        ),
      },
      {
        id: "isLostTime",
        header: "Outcome",
        accessor: (row) => (row.isLostTime ? "Lost time" : row.treatmentLevel ?? ""),
        type: "enum",
        width: 160,
        cell: ({ row }) => (
          <span className="flex flex-wrap items-center gap-1">
            {row.treatmentLevel ? (
              <Badge tone="neutral" size="xs" variant="outline">
                {labelize(row.treatmentLevel)}
              </Badge>
            ) : null}
            {row.isLostTime ? (
              <Badge tone="danger" size="xs">
                {row.lostTimeDays !== null ? `${count(row.lostTimeDays)}d lost` : "Lost time"}
              </Badge>
            ) : null}
          </span>
        ),
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
        id: "workStopped",
        header: "Work stopped",
        accessor: (row) => (row.workStopped ? "Yes" : "No"),
        type: "enum",
        width: 130,
        defaultHidden: true,
        cell: ({ row }) =>
          row.workStopped ? (
            <Badge tone={row.workResumedAt ? "neutral" : "danger"} size="xs" dot>
              {row.workResumedAt ? "Resumed" : "Still stopped"}
            </Badge>
          ) : (
            <span className="text-content-subtle">—</span>
          ),
      },
      {
        id: "reportedAt",
        header: "Reported",
        accessor: "reportedAt",
        type: "datetime",
        width: 160,
        defaultHidden: true,
        cell: ({ row }) => dateTime(row.reportedAt),
      },
    ],
    [users, vendors],
  );

  return (
    <div className="space-y-4">
      {incidents.error ? (
        <LoadError
          message={incidents.error}
          onRetry={incidents.reload}
          title="The incident register could not be loaded"
        />
      ) : null}

      <Card>
        <CardBody className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Field label="Type">
            <Select
              value={filters.incidentType}
              onChange={(e) => onFilters({ ...filters, incidentType: e.target.value })}
            >
              <option value="">All types</option>
              {INCIDENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {labelize(t)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Severity">
            <Select
              value={filters.severity}
              onChange={(e) => onFilters({ ...filters, severity: e.target.value })}
            >
              <option value="">All severities</option>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {labelize(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status">
            <Select
              value={filters.status}
              onChange={(e) => onFilters({ ...filters, status: e.target.value })}
            >
              <option value="">All statuses</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {labelize(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Investigation">
            <Select
              value={filters.investigationStatus}
              onChange={(e) => onFilters({ ...filters, investigationStatus: e.target.value })}
            >
              <option value="">Any state</option>
              {INVESTIGATION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {labelize(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Occurred from">
            <Input
              type="date"
              value={filters.from}
              onChange={(e) => onFilters({ ...filters, from: e.target.value })}
            />
          </Field>
          <Field label="Occurred to">
            <Input
              type="date"
              value={filters.to}
              onChange={(e) => onFilters({ ...filters, to: e.target.value })}
            />
          </Field>
        </CardBody>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="xs"
          variant={filters.reportable === "true" ? "primary" : "outline"}
          onClick={() =>
            onFilters({ ...filters, reportable: filters.reportable === "true" ? "" : "true" })
          }
        >
          Reportable only
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => onFilters(EMPTY_INCIDENT_FILTERS)}
          disabled={Object.values(filters).every((v) => v === "")}
        >
          Clear filters
        </Button>
      </div>

      <DataTable<SafetyIncident>
        tableId="safety-incidents"
        data={rows}
        columns={columns}
        getRowId={(row) => row.id}
        loading={incidents.loading}
        loadingRows={8}
        height={620}
        stickyHeader
        gridLines
        filterRow
        savedViews
        builtInViews={BUILT_IN_VIEWS}
        exportFileName="safety-incidents"
        searchPlaceholder="Search the incident register…"
        defaultSort={[{ id: "occurredAt", desc: true }]}
        rowTone={rowRail}
        onRowClick={({ row }) => onOpen(row.id)}
        rowActions={(row) => [
          { id: "open", label: "Open incident", onSelect: () => onOpen(row.id) },
        ]}
        toolbarActions={
          <Button size="sm" onClick={onNew}>
            Report an incident
          </Button>
        }
        empty={{
          icon: IconSafety,
          title: "No incident has been reported on this project",
          description:
            "That is the register answering, not an absence of data. An incident recorded here starts a reportability determination, an investigation clock and — where a statutory test is met — a notification deadline the platform will hold you to.",
          action: (
            <Button size="sm" onClick={onNew}>
              Report an incident
            </Button>
          ),
        }}
        emptyFiltered={{
          title: "No incident matches these filters",
          description:
            "Widen the type, severity, status or date window. An empty filtered register is not the same as a clean one.",
        }}
        aria-label="Incident register"
      />

      <RegisterPager
        page={filters.page}
        loaded={rows.length}
        total={incidents.data?.total ?? null}
        noun="incident"
        loading={incidents.loading}
        onPage={(page) => onFilters({ ...filters, page })}
      />

      <p className="text-2xs text-content-subtle">
        The clock column is live. It is computed from the deadline the reportability engine stored on
        the incident, and it counts up once passed — because the consequence of a missed statutory
        notification does not stop growing at zero.
      </p>
    </div>
  );
}

export function incidentQueryString(filters: IncidentFilters): string {
  const params = pageParams(filters.page);
  if (filters.incidentType) params.set("incidentType", filters.incidentType);
  if (filters.severity) params.set("severity", filters.severity);
  if (filters.status) params.set("status", filters.status);
  if (filters.reportable) params.set("reportable", filters.reportable);
  if (filters.investigationStatus) params.set("investigationStatus", filters.investigationStatus);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  return params.toString();
}
