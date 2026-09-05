/**
 * THE HOLD-POINT BOARD — every intervention point on the project in one list.
 *
 * This is the screen a site team actually works from, because a hold point
 * matters to the person about to pour concrete regardless of which ITP it sits
 * on. It is deliberately ordered by consequence rather than by reference:
 *
 *   1. unreleased hold points past their planned date
 *   2. everything else that is currently holding work
 *   3. points that are notified and waiting out their notice period
 *   4. the settled ones
 *
 * The grid gives the whole register; the board above it gives the ones that
 * stop work today, expanded, with notice, release and waiver shown apart.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Card,
  CardBody,
  DataTable,
  Field,
  SegmentedControl,
  Select,
  Skeleton,
  type DataColumns,
} from "../../ui";
import { IconAlert } from "../../ui/icons";
import { api } from "../../lib/api";
import ActivityCard, { ProceedCell, isOverdueHoldPoint } from "./ActivityCard";
import {
  ACTIVITY_STATUSES,
  ACTIVITY_STATUS_TONE,
  INTERVENTION_LABEL,
  INTERVENTION_POINTS,
  INTERVENTION_TONE,
  LoadError,
  NothingHere,
  ReasonList,
  dateTime,
  isoDate,
  labelize,
  nameOf,
  plural,
  useResource,
  type Resource,
} from "./qualityShared";
import type { HoldPointPage, ItpActivity, SurveillanceRegister } from "./types";

export interface HoldPointFilters {
  interventionPoint: string;
  status: string;
  openOnly: string;
}

export const EMPTY_HOLD_POINT_FILTERS: HoldPointFilters = {
  interventionPoint: "",
  status: "",
  openOnly: "true",
};

/** Consequence order: what stops work today comes first. */
function rank(a: ItpActivity): number {
  if (isOverdueHoldPoint(a)) return 0;
  if (!a.mayProceed.allowed && a.interventionPoint === "hold_point") return 1;
  if (!a.mayProceed.allowed) return 2;
  if (a.status === "notified") return 3;
  return 4;
}

export default function HoldPointsTab({
  holdPoints,
  filters,
  onFilters,
  projectId,
  users,
  onMutated,
  onOpenItp,
}: {
  holdPoints: Resource<HoldPointPage>;
  filters: HoldPointFilters;
  onFilters: (next: HoldPointFilters) => void;
  projectId: string;
  users: Map<string, string>;
  onMutated: () => void;
  onOpenItp: (itpId: string) => void;
}) {
  const [mode, setMode] = useState<"board" | "grid">("board");
  /*
   * The legs held by somebody OUTSIDE this company — a notified body, the
   * regulator, the client's engineer. They are drawn apart from the board
   * because they are the ones nobody here can clear: chasing them is the work,
   * and the register exists so the chasing is a list rather than a memory.
   */
  const surveillance = useResource<SurveillanceRegister>(
    (signal) =>
      api.get<SurveillanceRegister>(
        `/api/v1/projects/${projectId}/surveillance?openOnly=true`,
        { signal },
      ),
    [projectId, holdPoints.data],
  );

  const rows = useMemo(() => {
    const items = [...(holdPoints.data?.items ?? [])];
    items.sort((a, b) => {
      const byRank = rank(a) - rank(b);
      if (byRank !== 0) return byRank;
      const aDate = a.plannedDate ?? "9999-12-31";
      const bDate = b.plannedDate ?? "9999-12-31";
      return aDate < bDate ? -1 : aDate > bDate ? 1 : 0;
    });
    return items;
  }, [holdPoints.data]);

  const overdue = rows.filter(isOverdueHoldPoint);
  const stopping = rows.filter((a) => !a.mayProceed.allowed && !isOverdueHoldPoint(a));
  const total = holdPoints.data?.total ?? rows.length;
  const truncated = total > rows.length;

  const columns = useMemo<DataColumns<ItpActivity>>(
    () => [
      {
        id: "activity",
        header: "Activity",
        accessor: "activity",
        type: "text",
        sticky: "start",
        width: 260,
        cell: ({ row }) => (
          <div className="min-w-0 py-0.5">
            <span className="block truncate font-medium">{row.activity}</span>
            {row.activityCode ? (
              <span className="block font-mono text-2xs text-content-subtle">{row.activityCode}</span>
            ) : null}
          </div>
        ),
      },
      {
        id: "interventionPoint",
        header: "Point",
        accessor: "interventionPoint",
        type: "enum",
        width: 150,
        groupable: true,
        options: INTERVENTION_POINTS.map((p) => ({
          value: p,
          text: INTERVENTION_LABEL[p] ?? labelize(p),
          label: INTERVENTION_LABEL[p] ?? labelize(p),
          tone: INTERVENTION_TONE[p] ?? "neutral",
        })),
        cell: ({ row }) => (
          <Badge tone={INTERVENTION_TONE[row.interventionPoint] ?? "neutral"} size="xs" variant="solid">
            {INTERVENTION_LABEL[row.interventionPoint] ?? labelize(row.interventionPoint)}
          </Badge>
        ),
      },
      {
        id: "proceed",
        header: "May work proceed?",
        headerTooltip:
          "The API's own decision, computed on every read from the notice, the release and the waiver.",
        accessor: (row) => (row.mayProceed.allowed ? "yes" : "no"),
        type: "custom",
        width: 260,
        cell: ({ row }) => <ProceedCell activity={row} />,
        toCsv: ({ row }) =>
          row.mayProceed.allowed ? "may proceed" : row.mayProceed.reasons.join(" "),
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 130,
        groupable: true,
        options: ACTIVITY_STATUSES.map((s) => ({
          value: s,
          text: labelize(s),
          label: labelize(s),
          tone: ACTIVITY_STATUS_TONE[s] ?? "neutral",
        })),
        cell: ({ row }) => (
          <Badge tone={ACTIVITY_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
            {labelize(row.status)}
          </Badge>
        ),
      },
      {
        id: "planned",
        header: "Planned",
        accessor: (row) => row.plannedDate ?? "",
        type: "date",
        width: 130,
        cell: ({ row }) =>
          row.plannedDate ? (
            <span
              className={
                isOverdueHoldPoint(row) ? "font-semibold tabular-nums text-danger-fg" : "tabular-nums"
              }
            >
              {isoDate(row.plannedDate)}
            </span>
          ) : (
            <span className="text-content-subtle">no date</span>
          ),
      },
      {
        id: "notice",
        header: "Notice",
        accessor: (row) => row.notice.servedAt ?? "",
        type: "custom",
        width: 200,
        cell: ({ row }) =>
          row.notice.served ? (
            <div className="min-w-0 py-0.5">
              <span className="block text-2xs tabular-nums">{dateTime(row.notice.servedAt)}</span>
              <Badge tone={row.notice.noticeElapsed ? "success" : "warning"} size="xs">
                {row.notice.noticeExpiresAt === null
                  ? "period not computable"
                  : row.notice.noticeElapsed
                    ? "period has run"
                    : "period still running"}
              </Badge>
            </div>
          ) : (
            <span className="text-2xs italic text-content-subtle">no notice served</span>
          ),
        toCsv: ({ row }) => row.notice.servedAt ?? "no notice served",
      },
      {
        id: "verifiers",
        header: "Nominated to release",
        accessor: (row) =>
          row.parsedVerifyingParties.map((p) => p.name ?? p.party).join(", "),
        type: "text",
        width: 200,
        cell: ({ row }) =>
          row.parsedVerifyingParties.length === 0 ? (
            <span className="text-2xs italic text-danger-fg">nobody nominated</span>
          ) : (
            <span className="truncate text-2xs">
              {row.parsedVerifyingParties.map((p) => p.name ?? labelize(p.party)).join(", ")}
            </span>
          ),
      },
    ],
    [],
  );

  if (holdPoints.error) {
    return (
      <LoadError
        message={holdPoints.error}
        onRetry={holdPoints.reload}
        title="The intervention-point register could not be loaded"
      />
    );
  }

  return (
    <div className="space-y-4">
      {overdue.length > 0 ? (
        <Alert
          tone="danger"
          icon={IconAlert}
          title={`${overdue.length} unreleased hold ${plural(overdue.length, "point")} past ${plural(overdue.length, "its", "their")} planned date`}
        >
          Work may not proceed past an unreleased hold point. For each of these, either the work is
          standing idle waiting for the nominated party, or it went ahead without them — and once it
          is covered up, the second becomes very hard to disprove.
        </Alert>
      ) : null}

      <ThirdPartyPanel register={surveillance} users={users} />

      <Card>
        <CardBody className="grid gap-3 md:grid-cols-3">
          <Field label="Intervention point">
            <Select
              value={filters.interventionPoint}
              onChange={(e) => onFilters({ ...filters, interventionPoint: e.target.value })}
            >
              <option value="">Hold and witness points</option>
              {INTERVENTION_POINTS.map((p) => (
                <option key={p} value={p}>
                  {INTERVENTION_LABEL[p] ?? labelize(p)}
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
              {ACTIVITY_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {labelize(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Outstanding only">
            <Select
              value={filters.openOnly}
              onChange={(e) => onFilters({ ...filters, openOnly: e.target.value })}
            >
              <option value="true">Outstanding points only</option>
              <option value="">Everything, settled included</option>
            </Select>
          </Field>
        </CardBody>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-meta text-content-muted">
          {holdPoints.data
            ? `${total} ${plural(total, "point")} match — ${overdue.length} overdue, ${stopping.length} otherwise holding work`
            : "Loading the board…"}
        </p>
        <SegmentedControl
          value={mode}
          onChange={setMode}
          size="sm"
          options={[
            { value: "board", label: "What is stopping work" },
            { value: "grid", label: "Register" },
          ]}
          aria-label="Hold point view"
        />
      </div>

      {truncated ? (
        <Alert tone="info" size="sm" variant="subtle" title="Showing the first page">
          {rows.length} of {total} matching points are loaded. Narrow the filters to be sure you are
          looking at all of them — this view will not pretend the rest do not exist.
        </Alert>
      ) : null}

      {holdPoints.loading && rows.length === 0 ? (
        <Skeleton height={420} />
      ) : rows.length === 0 ? (
        <NothingHere
          title="No intervention point matches"
          reason={
            filters.status || filters.interventionPoint
              ? "Nothing matches the filters above. That is a statement about the filters, not about the project — clear them to see every point."
              : "No hold or witness point exists on this project. Nothing on site is currently gated by this platform: either the ITPs carry only surveillance points, or no plan has been written yet."
          }
        />
      ) : mode === "grid" ? (
        <DataTable<ItpActivity>
          tableId="quality-hold-points"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          height={560}
          stickyHeader
          zebra
          filterRow
          exportFileName="intervention-points"
          searchPlaceholder="Search activities"
          aria-label="Intervention points"
          rowTone={(row) =>
            isOverdueHoldPoint(row)
              ? "danger"
              : !row.mayProceed.allowed
                ? "warning"
                : row.status === "waived"
                  ? "highlight"
                  : undefined
          }
          onRowClick={({ row }) => onOpenItp(row.itpId)}
        />
      ) : (
        <BoardView
          rows={rows}
          projectId={projectId}
          users={users}
          onMutated={onMutated}
          onOpenItp={onOpenItp}
        />
      )}
    </div>
  );
}

function BoardView({
  rows,
  projectId,
  users,
  onMutated,
  onOpenItp,
}: {
  rows: readonly ItpActivity[];
  projectId: string;
  users: Map<string, string>;
  onMutated: () => void;
  onOpenItp: (itpId: string) => void;
}) {
  const active = rows.filter((a) => !a.mayProceed.allowed || a.status === "notified");
  const settled = rows.length - active.length;

  if (active.length === 0) {
    return (
      <NothingHere
        title="Nothing is holding work on this project right now"
        reason={`Every one of the ${rows.length} ${plural(rows.length, "point")} in scope is released, waived, closed or not applicable, and no notice period is still running. That is the register saying so, not an absence of data.`}
      />
    );
  }

  return (
    <div className="space-y-3">
      {active.map((a) => (
        <ActivityCard
          key={a.id}
          activity={a}
          users={users}
          projectId={projectId}
          onMutated={onMutated}
          showItpLink
          onOpenItp={onOpenItp}
        />
      ))}
      {settled > 0 ? (
        <p className="text-meta text-content-subtle">
          {settled} settled {plural(settled, "point")} {plural(settled, "is", "are")} not shown on
          this board. They are in the register view.
        </p>
      ) : null}
    </div>
  );
}

/**
 * WHAT IS WAITING ON SOMEBODY OUTSIDE.
 *
 * A third-party surveillance leg has three states worth telling apart, and the
 * difference decides who to ring: nobody has told them yet, they have been
 * told and have not turned up, or they attended and have not signed. Drawn as
 * a count each, with the joints named, because "the notified body is holding
 * us up" is only actionable when it says which points and since when.
 */
function ThirdPartyPanel({
  register,
  users,
}: {
  register: Resource<SurveillanceRegister>;
  users: Map<string, string>;
}) {
  if (register.error) {
    return (
      <LoadError
        message={register.error}
        onRetry={register.reload}
        title="The third-party surveillance register could not be loaded"
      />
    );
  }
  const data = register.data;
  if (!data || data.total === 0) return null;

  const unnotified = data.items.filter((r) => !r.notifiedAt);
  const notNotYetAttended = data.items.filter((r) => r.notifiedAt && !r.attendedAt);
  const attendedUnsigned = data.items.filter((r) => r.attendedAt && !r.releasedAt);

  const line = (
    label: string,
    rows: SurveillanceRegister["items"],
    tone: "danger" | "warning" | "info",
  ) =>
    rows.length === 0 ? null : (
      <li key={label} className="text-meta">
        <span
          className={
            tone === "danger"
              ? "font-medium text-danger"
              : tone === "warning"
                ? "font-medium text-warning"
                : "font-medium text-content"
          }
        >
          {rows.length} {label}
        </span>
        <span className="ml-1 text-2xs text-content-subtle">
          {rows
            .map((r) => {
              const who =
                r.organisation ??
                r.contactName ??
                (r.userId ? nameOf(users, r.userId) : labelize(r.party));
              const what = r.activity
                ? (r.activity.activityCode ?? r.activity.activity)
                : "an activity that no longer exists";
              const since = r.attendedAt ?? r.notifiedAt;
              return `${what} — ${who}${since ? ` since ${isoDate(since)}` : ""}`;
            })
            .slice(0, 6)
            .join("; ")}
          {rows.length > 6 ? ` … and ${rows.length - 6} more` : ""}
        </span>
      </li>
    );

  return (
    <Card>
      <CardBody className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-content">Waiting on a third party</h3>
          <Badge tone="info" size="xs" variant="outline">
            {data.total} outstanding {plural(data.total, "leg")}
          </Badge>
        </div>
        <ul className="space-y-1">
          {line("nobody has been told about yet", unnotified, "danger")}
          {line("notified and not yet attended", notNotYetAttended, "warning")}
          {line("attended and not yet signed off", attendedUnsigned, "info")}
        </ul>
        <ReasonList
          reasons={[
            "A surveillance leg is held by an organisation outside this company. It cannot be released from here, and marking it released without their signature is the one thing this register exists to make impossible.",
          ]}
        />
      </CardBody>
    </Card>
  );
}
