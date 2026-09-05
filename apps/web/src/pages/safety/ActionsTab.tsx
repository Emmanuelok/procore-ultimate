/**
 * THE CORRECTIVE-ACTION REGISTER — one register for the whole project.
 *
 * Incidents, observations, inspections, toolbox talks AND quality NCRs feed
 * this one table, so a site has a single overdue list rather than one per
 * module. `sourceType` says which register an action came from.
 *
 * The column that earns its place is HIERARCHY OF CONTROL. It is sortable and
 * groupable, and the profile above the grid shows the whole register's shape,
 * because "40 open actions" tells you nothing and "31 of 40 are briefings and
 * PPE" tells you the programme will see the same incident again.
 *
 * The second is EFFECTIVENESS. Completion is a claim, verification is somebody
 * else agreeing the work was done, and effectiveness is a later, separate
 * judgement that the fix actually worked. The register keeps all three apart.
 */
import { useMemo } from "react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  DataTable,
  Field,
  Progress,
  Select,
  Tooltip,
  type DataColumns,
  type DataView,
} from "../../ui";
import { IconWorkflow } from "../../ui/icons";
import type { Tone } from "../../ui/tokens";
import {
  ACTION_STATUS_TONE,
  EFFECTIVENESS_TONE,
  HIERARCHY_HINT,
  HIERARCHY_LABEL,
  HIERARCHY_ORDER,
  HIERARCHY_TONE,
  HierarchyBadge,
  LoadError,
  ReasonList,
  SOURCE_LABEL,
  SectionHeading,
  RegisterPager,
  count,
  pageParams,
  decimal,
  isoDate,
  labelize,
  nameOf,
  type ActionListResponse,
  type CorrectiveAction,
  type Resource,
} from "./safetyShared";

export interface ActionFilters {
  /** 1-based; the register is paged rather than silently truncated */
  page: string;
  status: string;
  sourceType: string;
  hierarchyOfControl: string;
  effectiveness: string;
  overdue: string;
}

export const EMPTY_ACTION_FILTERS: ActionFilters = { page: "1",
  status: "",
  sourceType: "",
  hierarchyOfControl: "",
  effectiveness: "",
  overdue: "",
};

const STATUSES = ["open", "in_progress", "completed", "verified", "closed", "cancelled"];
const SOURCES = Object.keys(SOURCE_LABEL);
const VERDICTS = ["pending", "effective", "partially_effective", "not_effective"];

const BUILT_IN_VIEWS: DataView[] = [
  {
    id: "builtin:overdue",
    name: "Overdue",
    builtIn: true,
    state: { sorting: [{ id: "dueDate", desc: false }] },
  },
  {
    id: "builtin:weak",
    name: "Weak controls",
    builtIn: true,
    state: { columnFilters: [{ id: "hierarchyOfControl", value: ["administrative", "ppe"] }] },
  },
  {
    id: "builtin:unproven",
    name: "Done but unproven",
    builtIn: true,
    state: {
      columnFilters: [
        { id: "status", value: ["completed", "verified"] },
        { id: "effectivenessVerdict", value: ["pending"] },
      ],
    },
  },
];

function rowRail(row: CorrectiveAction): Tone | undefined {
  if (row.isOverdue) return "danger";
  if (row.effectivenessVerdict === "not_effective") return "danger";
  if (row.isWeakControl && row.status !== "closed") return "warning";
  return undefined;
}

export default function ActionsTab({
  actions,
  filters,
  onFilters,
  users,
  vendors,
  onOpen,
}: {
  actions: Resource<ActionListResponse>;
  filters: ActionFilters;
  onFilters: (next: ActionFilters) => void;
  users: Map<string, string>;
  vendors: Map<string, string>;
  onOpen: (id: string) => void;
}) {
  const rows = actions.data?.items ?? [];
  const profile = actions.data?.hierarchyProfile ?? null;

  const columns = useMemo<DataColumns<CorrectiveAction>>(
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
        id: "title",
        header: "Action",
        accessor: "title",
        type: "text",
        width: 300,
      },
      {
        id: "hierarchyOfControl",
        header: "Level of control",
        headerTooltip:
          "The hierarchy of control, ranked 1 (elimination) to 6 (PPE). Recorded on every action because eliminating a hazard and retraining an operative are not equivalent, and a register that does not say which was chosen cannot be audited.",
        accessor: (row) => row.hierarchyOfControl ?? "",
        type: "enum",
        width: 210,
        groupable: true,
        sortFn: (a, b) => {
          const rank = (v: unknown) =>
            v ? HIERARCHY_ORDER.indexOf(v as never) : HIERARCHY_ORDER.length;
          return rank(a) - rank(b);
        },
        options: HIERARCHY_ORDER.map((h, i) => ({
          value: h,
          text: `${i + 1}. ${HIERARCHY_LABEL[h]}`,
          label: `${i + 1}. ${HIERARCHY_LABEL[h]}`,
          tone: HIERARCHY_TONE[h],
          description: HIERARCHY_HINT[h],
        })),
        cell: ({ row }) => <HierarchyBadge value={row.hierarchyOfControl} size="sm" />,
        toCsv: ({ row }) => row.hierarchyOfControl ?? "not recorded",
      },
      {
        id: "actionKind",
        header: "Kind",
        accessor: "actionKind",
        type: "enum",
        width: 130,
        groupable: true,
        options: ["containment", "corrective", "preventive"].map((k) => ({
          value: k,
          text: labelize(k),
          label: labelize(k),
        })),
        cell: ({ row }) => (
          <Badge tone="neutral" size="xs" variant="outline">
            {labelize(row.actionKind)}
          </Badge>
        ),
      },
      {
        id: "sourceType",
        header: "Raised from",
        accessor: "sourceType",
        type: "enum",
        width: 180,
        groupable: true,
        options: SOURCES.map((s) => ({ value: s, text: SOURCE_LABEL[s]!, label: SOURCE_LABEL[s]! })),
        cell: ({ row }) => (
          <span className="block min-w-0">
            <span className="block truncate text-meta">{SOURCE_LABEL[row.sourceType] ?? row.sourceType}</span>
            {row.sourceReference ? (
              <span className="block truncate font-mono text-2xs text-content-subtle">
                {row.sourceReference}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        id: "owner",
        header: "Owner",
        accessor: (row) => row.ownerName ?? (row.ownerId ? nameOf(users, row.ownerId) : ""),
        type: "text",
        width: 180,
        cell: ({ row }) => (
          <span className="truncate">
            {row.ownerName ??
              (row.ownerId ? nameOf(users, row.ownerId) : null) ??
              (row.ownerVendorId ? nameOf(vendors, row.ownerVendorId) : null) ??
              "—"}
          </span>
        ),
      },
      {
        id: "dueDate",
        header: "Due",
        accessor: "dueDate",
        type: "date",
        width: 150,
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5 tabular-nums">
            {isoDate(row.dueDate)}
            {row.isOverdue ? (
              <Badge tone="danger" size="xs">
                +{count(row.daysOverdue)}d
              </Badge>
            ) : null}
          </span>
        ),
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
          tone: ACTION_STATUS_TONE[s],
        })),
        cell: ({ row }) => (
          <Badge tone={ACTION_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
            {labelize(row.status)}
          </Badge>
        ),
      },
      {
        id: "effectivenessVerdict",
        header: "Shown to have worked?",
        headerTooltip:
          "A later, separate judgement from closure, made by a different person. An action closed on evidence of completion has not yet been shown to have worked.",
        accessor: "effectivenessVerdict",
        type: "enum",
        width: 200,
        groupable: true,
        options: VERDICTS.map((v) => ({
          value: v,
          text: labelize(v),
          label: labelize(v),
          tone: EFFECTIVENESS_TONE[v],
        })),
        cell: ({ row }) => (
          <span className="flex flex-wrap items-center gap-1">
            <Badge
              tone={EFFECTIVENESS_TONE[row.effectivenessVerdict] ?? "neutral"}
              size="xs"
              variant="outline"
            >
              {labelize(row.effectivenessVerdict)}
            </Badge>
            {row.effectivenessOutstanding && row.completedAt ? (
              <Tooltip content="Completed, but the effectiveness check is still outstanding. Until it is done the fix is asserted, not demonstrated.">
                <span>
                  <Badge tone="warning" size="xs">
                    unproven
                  </Badge>
                </span>
              </Tooltip>
            ) : null}
          </span>
        ),
      },
      {
        id: "verifiedBy",
        header: "Verified by",
        accessor: (row) => (row.verifiedBy ? nameOf(users, row.verifiedBy) : ""),
        type: "text",
        width: 170,
        defaultHidden: true,
        cell: ({ row }) =>
          row.verifiedBy ? (
            <span className="truncate">{nameOf(users, row.verifiedBy)}</span>
          ) : (
            <span className="text-content-subtle">not verified</span>
          ),
      },
      {
        id: "priority",
        header: "Priority",
        accessor: "priority",
        type: "enum",
        width: 120,
        defaultHidden: true,
        options: ["low", "medium", "high", "critical"].map((p) => ({
          value: p,
          text: labelize(p),
          label: labelize(p),
        })),
      },
    ],
    [users, vendors],
  );

  return (
    <div className="space-y-4">
      {actions.error ? (
        <LoadError
          message={actions.error}
          onRetry={actions.reload}
          title="The corrective-action register could not be loaded"
        />
      ) : null}

      {profile ? <HierarchyStrip profile={profile} /> : null}

      <Card>
        <CardBody className="grid gap-3 md:grid-cols-3 xl:grid-cols-5">
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
          <Field label="Raised from">
            <Select
              value={filters.sourceType}
              onChange={(e) => onFilters({ ...filters, sourceType: e.target.value })}
            >
              <option value="">Every register</option>
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {SOURCE_LABEL[s]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Level of control">
            <Select
              value={filters.hierarchyOfControl}
              onChange={(e) => onFilters({ ...filters, hierarchyOfControl: e.target.value })}
            >
              <option value="">Every level</option>
              {HIERARCHY_ORDER.map((h, i) => (
                <option key={h} value={h}>
                  {i + 1}. {HIERARCHY_LABEL[h]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Effectiveness">
            <Select
              value={filters.effectiveness}
              onChange={(e) => onFilters({ ...filters, effectiveness: e.target.value })}
            >
              <option value="">Any verdict</option>
              {VERDICTS.map((v) => (
                <option key={v} value={v}>
                  {labelize(v)}
                </option>
              ))}
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

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="xs"
          variant={filters.overdue === "true" ? "primary" : "outline"}
          onClick={() =>
            onFilters({ ...filters, overdue: filters.overdue === "true" ? "" : "true" })
          }
        >
          Overdue only
        </Button>
        <Button
          size="xs"
          variant={filters.hierarchyOfControl === "ppe" ? "primary" : "outline"}
          onClick={() =>
            onFilters({
              ...filters,
              hierarchyOfControl: filters.hierarchyOfControl === "ppe" ? "" : "ppe",
            })
          }
        >
          PPE-only controls
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={Object.values(filters).every((v) => v === "")}
          onClick={() => onFilters(EMPTY_ACTION_FILTERS)}
        >
          Clear filters
        </Button>
      </div>

      <DataTable<CorrectiveAction>
        tableId="safety-corrective-actions"
        data={rows}
        columns={columns}
        getRowId={(row) => row.id}
        loading={actions.loading}
        loadingRows={8}
        height={600}
        stickyHeader
        gridLines
        filterRow
        savedViews
        builtInViews={BUILT_IN_VIEWS}
        exportFileName="safety-corrective-actions"
        searchPlaceholder="Search actions…"
        defaultSort={[{ id: "dueDate", desc: false }]}
        rowTone={rowRail}
        onRowClick={({ row }) => onOpen(row.id)}
        rowActions={(row) => [{ id: "open", label: "Open action", onSelect: () => onOpen(row.id) }]}
        empty={{
          icon: IconWorkflow,
          title: "No corrective action on this project",
          description:
            "Nothing has been raised from an incident, an observation, an inspection or a quality NCR. This register is the single overdue list for all of them, so an empty one means no register has produced an action yet — not that the actions live elsewhere.",
        }}
        emptyFiltered={{
          title: "No action matches these filters",
          description: "Widen the status, source or control level to see the rest of the register.",
        }}
        aria-label="Corrective action register"
      />

      <RegisterPager
        page={filters.page}
        loaded={rows.length}
        total={actions.data?.total ?? null}
        noun="corrective action"
        loading={actions.loading}
        onPage={(page) => onFilters({ ...filters, page })}
      />
    </div>
  );
}

/**
 * The shape of the whole register at a glance. The bar is stacked in
 * hierarchy order so the eye reads durability left to right; the weak-control
 * share is stated as a number because that is the figure an auditor asks for.
 */
function HierarchyStrip({ profile }: { profile: ActionListResponse["hierarchyProfile"] }) {
  if (profile.total === 0) {
    return (
      <Card variant="sunken">
        <CardBody>
          <p className="text-label uppercase text-content-subtle">Hierarchy of control profile</p>
          <ReasonList reasons={profile.reasons} className="mt-1" />
        </CardBody>
      </Card>
    );
  }

  const weak = profile.weakControlShare;
  return (
    <Card accent={weak !== null && weak > 60 ? "warning" : undefined}>
      <CardBody>
        <SectionHeading
          title="Hierarchy of control profile"
          hint="Every action on the project, by the durability of the control chosen. Read the right-hand end: administrative controls and PPE depend on a person behaving correctly every single time."
          actions={
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge
                tone={weak === null ? "neutral" : weak > 60 ? "danger" : weak > 35 ? "warning" : "success"}
                size="sm"
                dot
              >
                {weak === null ? "No profile" : `${decimal(weak, 1)}% weak controls`}
              </Badge>
              {profile.unrecorded > 0 ? (
                <Badge tone="warning" size="sm" variant="outline">
                  {count(profile.unrecorded)} unrecorded
                </Badge>
              ) : null}
            </div>
          }
        />
        <div className="flex h-2.5 w-full overflow-hidden rounded-full border border-border">
          {HIERARCHY_ORDER.map((h) => {
            const n = profile.counts[h] ?? 0;
            if (n === 0) return null;
            const pct = (n / profile.total) * 100;
            return (
              <Tooltip key={h} content={`${HIERARCHY_LABEL[h]} — ${n} action(s). ${HIERARCHY_HINT[h]}`}>
                <div
                  style={{ width: `${pct}%` }}
                  className={
                    h === "elimination" || h === "substitution"
                      ? "bg-success-solid"
                      : h === "engineering"
                        ? "bg-accent"
                        : h === "isolation"
                          ? "bg-info-solid"
                          : h === "administrative"
                            ? "bg-warning-solid"
                            : "bg-danger-solid"
                  }
                />
              </Tooltip>
            );
          })}
        </div>
        <div className="mt-2 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {HIERARCHY_ORDER.map((h, i) => (
            <div key={h}>
              <p className="truncate text-2xs text-content-subtle">
                {i + 1}. {HIERARCHY_LABEL[h]}
              </p>
              <p className="text-meta tabular-nums text-content">{count(profile.counts[h] ?? 0)}</p>
              <Progress
                value={profile.total > 0 ? ((profile.counts[h] ?? 0) / profile.total) * 100 : 0}
                max={100}
                size="xs"
                tone={HIERARCHY_TONE[h]}
              />
            </div>
          ))}
        </div>
      </CardBody>
    </Card>
  );
}

export function actionQueryString(filters: ActionFilters): string {
  const params = pageParams(filters.page);
  if (filters.status) params.set("status", filters.status);
  if (filters.sourceType) params.set("sourceType", filters.sourceType);
  if (filters.hierarchyOfControl) params.set("hierarchyOfControl", filters.hierarchyOfControl);
  if (filters.effectiveness) params.set("effectiveness", filters.effectiveness);
  if (filters.overdue) params.set("overdue", filters.overdue);
  return params.toString();
}
