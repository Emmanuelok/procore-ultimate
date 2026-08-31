/**
 * THE ITP REGISTER.
 *
 * A plan is almost administrative; its ACTIVITIES are the module. So the
 * register is built to answer, at a glance, the only question that matters
 * before a pour: how many points on this plan are still holding the work, and
 * how many of those went past their date without anybody releasing them.
 *
 * The overdue count is computed here from the project's own intervention-point
 * list rather than read off the plan row, because the plan row carries
 * `openHoldPointCount` but not "open AND past its planned date" — and the
 * second one is the number that gets somebody out of bed.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  DataTable,
  Field,
  Input,
  Modal,
  Select,
  Skeleton,
  Textarea,
  type DataColumns,
} from "../../ui";
import { IconAlert, IconPlus } from "../../ui/icons";
import { api } from "../../lib/api";
import { isOverdueHoldPoint } from "./ActivityCard";
import {
  ITP_STATUS_TONE,
  LoadError,
  NothingHere,
  RefusalNotice,
  isoDate,
  labelize,
  plural,
  useAction,
  type Resource,
} from "./qualityShared";
import type { HoldPointPage, Itp, Paged } from "./types";

const ITP_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "approved_as_noted",
  "rejected",
  "active",
  "superseded",
  "closed",
];

export interface ItpFilters {
  status: string;
  discipline: string;
  search: string;
}

export const EMPTY_ITP_FILTERS: ItpFilters = { status: "", discipline: "", search: "" };

interface Row extends Itp {
  overdueHoldPoints: number;
  heldActivities: number;
}

export default function ItpsTab({
  itps,
  holdPoints,
  filters,
  onFilters,
  projectId,
  onOpen,
  onMutated,
  onGoToHoldPoints,
}: {
  itps: Resource<Paged<Itp>>;
  holdPoints: Resource<HoldPointPage>;
  filters: ItpFilters;
  onFilters: (next: ItpFilters) => void;
  projectId: string;
  onOpen: (itpId: string) => void;
  onMutated: () => void;
  onGoToHoldPoints: () => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [discipline, setDiscipline] = useState("");
  const [scope, setScope] = useState("");
  const { busy, refusal, clear, run } = useAction();

  const rows = useMemo<Row[]>(() => {
    const points = holdPoints.data?.items ?? [];
    const overdueByItp = new Map<string, number>();
    const heldByItp = new Map<string, number>();
    for (const a of points) {
      if (isOverdueHoldPoint(a)) {
        overdueByItp.set(a.itpId, (overdueByItp.get(a.itpId) ?? 0) + 1);
      }
      if (!a.mayProceed.allowed) {
        heldByItp.set(a.itpId, (heldByItp.get(a.itpId) ?? 0) + 1);
      }
    }
    return (itps.data?.items ?? []).map((itp) => ({
      ...itp,
      overdueHoldPoints: overdueByItp.get(itp.id) ?? 0,
      heldActivities: heldByItp.get(itp.id) ?? 0,
    }));
  }, [itps.data, holdPoints.data]);

  const overdueTotal = rows.reduce((n, r) => n + r.overdueHoldPoints, 0);
  /* The intervention-point read is capped at one page. Where it is capped the
   * per-plan counts below are a floor, and the register says so rather than
   * presenting a partial count as the count. */
  const pointsLoaded = holdPoints.data?.items.length ?? 0;
  const pointsTotal = holdPoints.data?.total ?? pointsLoaded;
  const pointsTruncated = pointsTotal > pointsLoaded;

  const columns = useMemo<DataColumns<Row>>(
    () => [
      {
        id: "reference",
        header: "Reference",
        accessor: "reference",
        type: "code",
        mono: true,
        sticky: "start",
        width: 120,
      },
      { id: "title", header: "Plan", accessor: "title", type: "text", width: 300 },
      {
        id: "discipline",
        header: "Discipline",
        accessor: (row) => row.discipline ?? "",
        type: "enum",
        width: 150,
        groupable: true,
        cell: ({ row }) =>
          row.discipline ? (
            labelize(row.discipline)
          ) : (
            <span className="text-content-subtle">not stated</span>
          ),
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 150,
        groupable: true,
        options: ITP_STATUSES.map((s) => ({
          value: s,
          text: labelize(s),
          label: labelize(s),
          tone: ITP_STATUS_TONE[s] ?? "neutral",
        })),
        cell: ({ row }) => (
          <Badge tone={ITP_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
            {labelize(row.status)}
          </Badge>
        ),
      },
      {
        id: "rev",
        header: "Rev",
        accessor: "revision",
        type: "number",
        width: 70,
        align: "right",
      },
      {
        id: "activities",
        header: "Activities",
        accessor: "activityCount",
        type: "number",
        width: 100,
        align: "right",
        aggregate: "sum",
      },
      {
        id: "holdPoints",
        header: "Hold points",
        headerTooltip:
          "Points that stop the work outright until the nominated party releases or waives them.",
        accessor: "holdPointCount",
        type: "number",
        width: 120,
        align: "right",
        aggregate: "sum",
      },
      {
        id: "openHoldPoints",
        header: "Still holding",
        headerTooltip:
          "Hold points not yet released, waived or closed. The second line counts every intervention point on the plan that work may not currently proceed past — a witness point inside its notice period holds the work too.",
        accessor: "openHoldPointCount",
        type: "number",
        width: 140,
        align: "right",
        aggregate: "sum",
        cell: ({ row }) =>
          row.openHoldPointCount === 0 && row.heldActivities === 0 ? (
            <span className="text-content-subtle">—</span>
          ) : (
            <span className="flex flex-col items-end gap-0.5 py-0.5">
              <Badge tone="warning" size="xs">
                {row.openHoldPointCount} hold {plural(row.openHoldPointCount, "point")}
              </Badge>
              {row.heldActivities > row.openHoldPointCount ? (
                <span className="text-2xs text-content-subtle">
                  {row.heldActivities} points holding work
                </span>
              ) : null}
            </span>
          ),
      },
      {
        id: "overdue",
        header: "Past their date",
        headerTooltip:
          "Hold points that are still unreleased and whose planned date has gone by. Either the work is standing or it went ahead without the verifier.",
        accessor: "overdueHoldPoints",
        type: "number",
        width: 140,
        align: "right",
        aggregate: "sum",
        cell: ({ row }) =>
          row.overdueHoldPoints === 0 ? (
            <span className="text-content-subtle">—</span>
          ) : (
            <Badge tone="danger" size="xs" variant="solid">
              {row.overdueHoldPoints} overdue
            </Badge>
          ),
      },
      {
        id: "approved",
        header: "Agreed",
        accessor: (row) => row.approvedAt ?? "",
        type: "date",
        width: 130,
        cell: ({ row }) =>
          row.approvedAt ? (
            <span className="tabular-nums">{isoDate(row.approvedAt)}</span>
          ) : (
            <span className="text-content-subtle">not yet agreed</span>
          ),
      },
    ],
    [],
  );

  async function create() {
    const created = await run("create", () =>
      api.post<Itp>(`/api/v1/projects/${projectId}/itps`, {
        title: title.trim(),
        discipline: discipline.trim() === "" ? null : discipline.trim(),
        scopeOfWork: scope.trim() === "" ? null : scope.trim(),
      }),
    );
    if (created) {
      setCreateOpen(false);
      setTitle("");
      setDiscipline("");
      setScope("");
      onMutated();
      onOpen(created.id);
    }
  }

  if (itps.error) {
    return (
      <LoadError
        message={itps.error}
        onRetry={itps.reload}
        title="The inspection and test plan register could not be loaded"
      />
    );
  }

  return (
    <div className="space-y-4">
      {overdueTotal > 0 ? (
        <Alert
          tone="danger"
          icon={IconAlert}
          title={`${overdueTotal} hold ${plural(overdueTotal, "point")} unreleased past ${plural(overdueTotal, "its", "their")} planned date`}
          actions={
            <Button size="sm" variant="secondary" onClick={onGoToHoldPoints}>
              Open the hold-point board
            </Button>
          }
        >
          Work may not proceed past an unreleased hold point. Every one of these is either work
          standing idle waiting for a verifier, or work that went ahead without one — and the
          platform cannot tell which from the data it holds.
        </Alert>
      ) : null}

      {pointsTruncated ? (
        <Alert tone="info" size="sm" variant="subtle" title="The hold-point counts below are a floor">
          {pointsLoaded} of {pointsTotal} outstanding intervention points were loaded, so
          &ldquo;still holding&rdquo; and &ldquo;past their date&rdquo; count only those. The
          hold-point board carries the full register.
        </Alert>
      ) : null}

      <Card>
        <CardBody className="grid gap-3 md:grid-cols-3">
          <Field label="Status">
            <Select
              value={filters.status}
              onChange={(e) => onFilters({ ...filters, status: e.target.value })}
            >
              <option value="">Every status</option>
              {ITP_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {labelize(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Discipline">
            <Input
              value={filters.discipline}
              placeholder="e.g. structural"
              onChange={(e) => onFilters({ ...filters, discipline: e.target.value })}
            />
          </Field>
          <Field label="Search titles">
            <Input
              value={filters.search}
              placeholder="Plan title"
              onChange={(e) => onFilters({ ...filters, search: e.target.value })}
            />
          </Field>
        </CardBody>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-meta text-content-muted">
          {itps.data
            ? `${itps.data.total} ${plural(itps.data.total, "plan")} on this project`
            : "Loading the register…"}
        </p>
        <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
          New plan
        </Button>
      </div>

      {itps.loading && rows.length === 0 ? (
        <Skeleton height={420} />
      ) : rows.length === 0 ? (
        <NothingHere
          title="No inspection and test plan is recorded on this project"
          reason={
            filters.status || filters.discipline || filters.search
              ? "No plan matches the filters above. Clear them to see the whole register — an empty filtered view is not an empty register."
              : "An ITP is the agreement, made before the work starts, about who looks at what and when everybody else gets to stop it. With none recorded, no hold point exists to be released and nothing on site is gated by this platform."
          }
          action={
            <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
              Write the first plan
            </Button>
          }
        />
      ) : (
        <DataTable<Row>
          tableId="quality-itps"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          height={560}
          stickyHeader
          showFooter
          zebra
          filterRow
          exportFileName="itp-register"
          searchPlaceholder="Search plans"
          aria-label="Inspection and test plans"
          rowTone={(row) =>
            row.overdueHoldPoints > 0 ? "danger" : row.openHoldPointCount > 0 ? "warning" : undefined
          }
          onRowClick={({ row }) => onOpen(row.id)}
          defaultSort={[{ id: "overdue", desc: true }]}
        />
      )}

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New inspection and test plan"
        description="The plan is agreed before the work starts. Activities, their intervention points and their verifying parties are added to it next."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy === "create"}
              disabled={title.trim().length === 0}
              onClick={create}
            >
              Create the plan
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <RefusalNotice refusal={refusal} onDismiss={clear} />
          <Field label="Title" required>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. In-situ concrete — substructure"
              autoFocus
            />
          </Field>
          <Field label="Discipline" hint="Groups the register and drives the discipline filter.">
            <Input
              value={discipline}
              onChange={(e) => setDiscipline(e.target.value)}
              placeholder="e.g. structural"
            />
          </Field>
          <Field label="Scope of work">
            <Textarea rows={3} value={scope} onChange={(e) => setScope(e.target.value)} />
          </Field>
        </div>
      </Modal>
    </div>
  );
}
