/**
 * THE OBSERVATIONS BOARD.
 *
 * A board rather than a grid because an observation's life is short and its
 * state is the thing you act on: raised → assigned → actioned → verified →
 * closed. The lanes are that lifecycle.
 *
 * Every card leads with its 5×5 RISK SCORE — likelihood × severity, banded.
 * Where either axis was left unscored there is no number at all: the card
 * says "not scored" and carries the API's reason, because a risk score is a
 * judgement about how bad this could have been and a fabricated one is worse
 * than an admission that nobody made the judgement.
 *
 * Cards are not draggable. Assignment, closure and lifting a work stoppage
 * are separate acts with their own preconditions on the server, and dragging
 * a card between lanes would imply a transition the platform does not make.
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
  KanbanBoard,
  KanbanCard,
  SegmentedControl,
  Select,
  Skeleton,
  type DataColumns,
  type KanbanColumn,
} from "../../ui";
import { IconSafety } from "../../ui/icons";
import type { Tone } from "../../ui/tokens";
import {
  LoadError,
  OBSERVATION_STATUS_TONE,
  RiskBadge,
  SAFETY_SEVERITY_TONE,
  RegisterPager,
  count,
  pageParams,
  dateTime,
  isoDate,
  labelize,
  nameOf,
  type Paged,
  type Resource,
  type SafetyObservation,
} from "./safetyShared";

export interface ObservationFilters {
  /** 1-based; the register is paged rather than silently truncated */
  page: string;
  kind: string;
  category: string;
  severity: string;
  status: string;
  workStopped: string;
  overdue: string;
}

export const EMPTY_OBSERVATION_FILTERS: ObservationFilters = { page: "1",
  kind: "",
  category: "",
  severity: "",
  status: "",
  workStopped: "",
  overdue: "",
};

const CATEGORIES = [
  "ppe",
  "working_at_height",
  "housekeeping",
  "electrical",
  "excavation",
  "lifting_operations",
  "hot_works",
  "confined_space",
  "plant_and_equipment",
  "manual_handling",
  "hazardous_substances",
  "fire",
  "traffic_management",
  "temporary_works",
  "permit_compliance",
  "environmental",
  "welfare",
  "behaviour",
  "emergency_preparedness",
  "other",
];

const SEVERITIES = ["informational", "low", "medium", "high", "critical"];

const LANES: KanbanColumn[] = [
  {
    id: "open",
    title: "Raised",
    description: "Recorded and not yet owned by anybody.",
    tone: "warning",
  },
  {
    id: "action_assigned",
    title: "Assigned",
    description: "An owner and a date exist.",
    tone: "info",
  },
  { id: "actioned", title: "Actioned", description: "The fix is claimed done.", tone: "accent" },
  {
    id: "verified",
    title: "Verified",
    description: "Somebody else confirmed it.",
    tone: "success",
  },
  { id: "closed", title: "Closed", description: "Off the live register.", tone: "neutral" },
];

function cardTone(o: SafetyObservation): Tone | undefined {
  if (o.workStoppedAndNotResumed) return "danger";
  if (o.isOverdue) return "danger";
  if (o.risk && (o.risk.band === "high" || o.risk.band === "critical")) return "warning";
  if (o.kind === "positive") return "success";
  return undefined;
}

export default function ObservationsTab({
  observations,
  filters,
  onFilters,
  users,
  onOpen,
  onNew,
}: {
  observations: Resource<Paged<SafetyObservation>>;
  filters: ObservationFilters;
  onFilters: (next: ObservationFilters) => void;
  users: Map<string, string>;
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  const [mode, setMode] = useState<"board" | "grid">("board");
  const rows = observations.data?.items ?? [];

  const laneItems = useMemo(
    () => rows.filter((o) => o.status !== "void"),
    [rows],
  );

  const columns = useMemo<DataColumns<SafetyObservation>>(
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
      { id: "title", header: "Observation", accessor: "title", type: "text", width: 280 },
      {
        id: "kind",
        header: "Kind",
        accessor: "kind",
        type: "enum",
        width: 110,
        groupable: true,
        options: ["positive", "negative"].map((k) => ({
          value: k,
          text: labelize(k),
          label: labelize(k),
          tone: k === "positive" ? ("success" as const) : ("warning" as const),
        })),
        cell: ({ row }) => (
          <Badge tone={row.kind === "positive" ? "success" : "warning"} size="xs" dot>
            {labelize(row.kind)}
          </Badge>
        ),
      },
      {
        id: "category",
        header: "Category",
        accessor: "category",
        type: "enum",
        width: 180,
        groupable: true,
        options: CATEGORIES.map((c) => ({ value: c, text: labelize(c), label: labelize(c) })),
        cell: ({ row }) => labelize(row.category),
      },
      {
        id: "risk",
        header: "Risk",
        headerTooltip:
          "Likelihood × severity on the conventional 5×5 matrix. Blank where either axis was not scored — the platform does not invent one.",
        accessor: (row) => row.riskScore ?? -1,
        type: "custom",
        width: 150,
        align: "left",
        cell: ({ row }) => <RiskBadge risk={row.risk} reasons={row.riskReasons} />,
        toCsv: ({ row }) => row.riskScore ?? "not scored",
      },
      {
        id: "severity",
        header: "Potential severity",
        accessor: "severity",
        type: "enum",
        width: 160,
        groupable: true,
        options: SEVERITIES.map((s) => ({
          value: s,
          text: labelize(s),
          label: labelize(s),
          tone: SAFETY_SEVERITY_TONE[s],
        })),
        cell: ({ row }) => (
          <Badge tone={SAFETY_SEVERITY_TONE[row.severity] ?? "neutral"} size="xs">
            {labelize(row.severity)}
          </Badge>
        ),
      },
      {
        id: "workStopped",
        header: "Work stopped",
        accessor: (row) =>
          row.workStoppedAndNotResumed ? "Still stopped" : row.workStopped ? "Resumed" : "No",
        type: "enum",
        width: 140,
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
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 150,
        groupable: true,
        options: Object.keys(OBSERVATION_STATUS_TONE).map((s) => ({
          value: s,
          text: labelize(s),
          label: labelize(s),
          tone: OBSERVATION_STATUS_TONE[s],
        })),
        cell: ({ row }) => (
          <Badge tone={OBSERVATION_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
            {labelize(row.status)}
          </Badge>
        ),
      },
      {
        id: "assignee",
        header: "Assigned to",
        accessor: (row) => (row.assigneeId ? nameOf(users, row.assigneeId) : ""),
        type: "text",
        width: 170,
      },
      {
        id: "dueDate",
        header: "Due",
        accessor: "dueDate",
        type: "date",
        width: 140,
        cell: ({ row }) =>
          row.dueDate ? (
            <span className="flex items-center gap-1.5 tabular-nums">
              {isoDate(row.dueDate)}
              {row.isOverdue ? (
                <Badge tone="danger" size="xs">
                  +{count(row.daysOverdue)}d
                </Badge>
              ) : null}
            </span>
          ) : (
            <span className="text-content-subtle">no date set</span>
          ),
      },
      {
        id: "observedAt",
        header: "Observed",
        accessor: "observedAt",
        type: "datetime",
        width: 170,
        cell: ({ row }) => dateTime(row.observedAt),
      },
    ],
    [users],
  );

  return (
    <div className="space-y-4">
      {observations.error ? (
        <LoadError
          message={observations.error}
          onRetry={observations.reload}
          title="The observation register could not be loaded"
        />
      ) : null}

      <Card>
        <CardBody className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Field label="Kind">
            <Select
              value={filters.kind}
              onChange={(e) => onFilters({ ...filters, kind: e.target.value })}
            >
              <option value="">Both</option>
              <option value="negative">Negative</option>
              <option value="positive">Positive</option>
            </Select>
          </Field>
          <Field label="Category">
            <Select
              value={filters.category}
              onChange={(e) => onFilters({ ...filters, category: e.target.value })}
            >
              <option value="">Every category</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {labelize(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Potential severity">
            <Select
              value={filters.severity}
              onChange={(e) => onFilters({ ...filters, severity: e.target.value })}
            >
              <option value="">Any severity</option>
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
              <option value="">Every status</option>
              {Object.keys(OBSERVATION_STATUS_TONE).map((s) => (
                <option key={s} value={s}>
                  {labelize(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Work stoppage">
            <Select
              value={filters.workStopped}
              onChange={(e) => onFilters({ ...filters, workStopped: e.target.value })}
            >
              <option value="">Everything</option>
              <option value="true">Work was stopped</option>
              <option value="false">Work continued</option>
            </Select>
          </Field>
          <Field label="Overdue">
            <Select
              value={filters.overdue}
              onChange={(e) => onFilters({ ...filters, overdue: e.target.value })}
            >
              <option value="">Everything</option>
              <option value="true">Overdue only</option>
              <option value="false">Not overdue</option>
            </Select>
          </Field>
        </CardBody>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl
          value={mode}
          onChange={setMode}
          size="sm"
          options={[
            { value: "board", label: "Board" },
            { value: "grid", label: "Register" },
          ]}
          aria-label="Observation view"
        />
        <Button size="sm" onClick={onNew}>
          Record an observation
        </Button>
      </div>

      {observations.loading && rows.length === 0 ? (
        <Skeleton height={420} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={IconSafety}
          title="No observation has been recorded on this project"
          hint="An observation register with nothing in it is not a safe site — it is a site where nobody is writing anything down. The positive-to-negative ratio on the dashboard is the reason positives are worth recording at all."
          action={
            <Button size="sm" onClick={onNew}>
              Record the first observation
            </Button>
          }
        />
      ) : mode === "board" ? (
        <KanbanBoard<SafetyObservation>
          columns={LANES}
          items={laneItems}
          getItemId={(o) => o.id}
          getItemColumn={(o) => (LANES.some((l) => l.id === o.status) ? o.status : "open")}
          onCardClick={(o) => onOpen(o.id)}
          height={560}
          emptyColumnText="Nothing at this stage"
          columnSummary={(items) => {
            const stopped = items.filter((o) => o.workStoppedAndNotResumed).length;
            const overdue = items.filter((o) => o.isOverdue).length;
            if (stopped === 0 && overdue === 0) return null;
            return (
              <span className="flex gap-1.5">
                {stopped > 0 ? (
                  <Badge tone="danger" size="xs">
                    {stopped} work stopped
                  </Badge>
                ) : null}
                {overdue > 0 ? (
                  <Badge tone="warning" size="xs">
                    {overdue} overdue
                  </Badge>
                ) : null}
              </span>
            );
          }}
          renderCard={(o) => (
            <KanbanCard
              reference={o.reference}
              title={o.title}
              tone={cardTone(o)}
              badges={
                <span className="flex flex-wrap items-center gap-1">
                  <RiskBadge risk={o.risk} reasons={o.riskReasons} size="xs" />
                  {o.kind === "positive" ? (
                    <Badge tone="success" size="xs" variant="outline">
                      Positive
                    </Badge>
                  ) : null}
                  {o.workStoppedAndNotResumed ? (
                    <Badge tone="danger" size="xs" variant="solid">
                      Work still stopped
                    </Badge>
                  ) : null}
                </span>
              }
              meta={
                <span className="text-2xs text-content-subtle">
                  {labelize(o.category)} · observed {isoDate(o.observedAt)}
                </span>
              }
              footer={
                <span className="flex flex-wrap items-center gap-1.5 text-2xs">
                  {o.assigneeId ? (
                    <span className="text-content-muted">{nameOf(users, o.assigneeId)}</span>
                  ) : (
                    <span className="text-content-subtle">unassigned</span>
                  )}
                  {o.dueDate ? (
                    <Badge tone={o.isOverdue ? "danger" : "neutral"} size="xs" variant="outline">
                      due {isoDate(o.dueDate)}
                    </Badge>
                  ) : null}
                  {o.openActionCount > 0 ? (
                    <Badge tone="info" size="xs" variant="outline">
                      {o.openActionCount} open action{o.openActionCount === 1 ? "" : "s"}
                    </Badge>
                  ) : null}
                </span>
              }
            />
          )}
          aria-label="Observation board"
        />
      ) : (
        <DataTable<SafetyObservation>
          tableId="safety-observations"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          loading={observations.loading}
          height={560}
          stickyHeader
          gridLines
          filterRow
          savedViews
          exportFileName="safety-observations"
          searchPlaceholder="Search observations…"
          defaultSort={[{ id: "observedAt", desc: true }]}
          rowTone={cardTone}
          onRowClick={({ row }) => onOpen(row.id)}
          empty={{
            title: "No observation on this project",
            description: "Nothing has been recorded here yet.",
          }}
          emptyFiltered={{
            title: "No observation matches these filters",
            description: "Widen the category, severity or status filter.",
          }}
          aria-label="Observation register"
        />
      )}

      <RegisterPager
        page={filters.page}
        loaded={rows.length}
        total={observations.data?.total ?? null}
        noun="observation"
        loading={observations.loading}
        onPage={(page) => onFilters({ ...filters, page })}
      />

      <p className="text-2xs text-content-subtle">
        The lanes are the lifecycle, not a drag surface. Assigning an owner, lifting a work stoppage
        and closing an observation are separate acts with their own preconditions — closure, in
        particular, is never done by the person who raised it.
      </p>
    </div>
  );
}

export function observationQueryString(filters: ObservationFilters): string {
  const params = pageParams(filters.page);
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.category) params.set("category", filters.category);
  if (filters.severity) params.set("severity", filters.severity);
  if (filters.status) params.set("status", filters.status);
  if (filters.workStopped) params.set("workStopped", filters.workStopped);
  if (filters.overdue) params.set("overdue", filters.overdue);
  return params.toString();
}
