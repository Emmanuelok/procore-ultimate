/**
 * MAINTENANCE — calendar and meter intervals racing each other.
 *
 * Two things this tab refuses to do, both inherited straight from
 * `maintenance.ts`:
 *
 *  · It never says a machine is overdue on a METER interval when the meter has
 *    never been read. A machine whose meter is unknown cannot be said to have
 *    passed a 500-hour service, and saying so anyway buries the machines that
 *    genuinely have. Those rows read NOT SCHEDULED with the engine's reason.
 *  · It never converts a meter interval into a date it cannot support. A meter
 *    schedule only enters the date comparison through `projectedDueAt`, which
 *    exists only where an average daily usage could be computed; where it
 *    cannot, the row is ranked after the dated ones rather than being dropped.
 *
 * Overdue on CRITICAL plant is called out separately, because that is a
 * stoppage waiting to be discovered by the thing it breaks.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Field,
  Modal,
  SegmentedControl,
  SkeletonTable,
  Switch,
  Textarea,
  Tooltip,
} from "../../ui";
import { api } from "../../lib/api";
import { DataTable, type DataColumns } from "../../ui/data";
import type { Tone } from "../../ui/tokens";
import { IconTool } from "../../ui/icons";
import {
  INTERVAL_KIND_LABEL,
  LoadError,
  MAINTENANCE_STATUS_LABEL,
  ReasonList,
  RefusalNotice,
  SectionHeading,
  isoDate,
  labelize,
  maintenanceTone,
  useAction,
  type Loadable,
  type MaintenanceRegister,
  type MaintenanceRow,
} from "./equipmentShared";

type Bucket = "overdue" | "due_soon" | "not_scheduled" | "all";

export default function MaintenanceTab({
  register,
  criticalOnly,
  onCriticalOnly,
  onOpenMachine,
}: {
  register: Loadable<MaintenanceRegister>;
  criticalOnly: boolean;
  onCriticalOnly: (next: boolean) => void;
  onOpenMachine: (equipmentId: string) => void;
}) {
  const [statusTarget, setStatusTarget] = useState<MaintenanceRow | null>(null);
  const [bucket, setBucket] = useState<Bucket>("overdue");
  const data = register.data;
  const items = useMemo(() => data?.items ?? [], [data]);

  const filtered = useMemo(() => {
    if (bucket === "all") return items;
    return items.filter((row) => (row.due?.status ?? "not_scheduled") === bucket);
  }, [bucket, items]);

  const columns = useMemo<DataColumns<MaintenanceRow>>(
    () => [
      {
        id: "equipmentReference",
        header: "Plant",
        accessor: (row) => row.equipmentReference ?? "",
        type: "code",
        sticky: "start",
        width: 118,
        mono: true,
      },
      {
        id: "equipmentName",
        header: "Machine",
        accessor: (row) => row.equipmentName ?? "",
        type: "text",
        width: 200,
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{row.equipmentName ?? "—"}</span>
            {row.isCriticalPlant ? (
              <Badge tone="highlight" size="xs" variant="outline">
                Critical
              </Badge>
            ) : null}
          </span>
        ),
      },
      {
        id: "name",
        header: "Schedule",
        accessor: "name",
        type: "text",
        width: 230,
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{row.name}</span>
            {row.isStatutory ? (
              <Tooltip content="Statutory maintenance: the interval comes from regulation, not from a service book. Missing it is a legal exposure as well as a mechanical one.">
                <span>
                  <Badge tone="danger" size="xs" variant="outline">
                    Statutory
                  </Badge>
                </span>
              </Tooltip>
            ) : null}
          </span>
        ),
      },
      {
        id: "interval",
        header: "Interval",
        accessor: (row) => `${row.intervalValue} ${row.intervalKind}`,
        type: "text",
        width: 190,
        cell: ({ row }) => (
          <span className="text-content-muted">
            every {row.intervalValue}{" "}
            {(INTERVAL_KIND_LABEL[row.intervalKind] ?? labelize(row.intervalKind)).toLowerCase()}
          </span>
        ),
      },
      {
        id: "status",
        header: "Position",
        accessor: (row) => row.due?.status ?? "not_scheduled",
        type: "enum",
        width: 170,
        groupable: true,
        options: (
          ["overdue", "due_soon", "scheduled", "not_scheduled"] as const
        ).map((value) => ({
          value,
          label: MAINTENANCE_STATUS_LABEL[value],
          text: MAINTENANCE_STATUS_LABEL[value],
          tone: maintenanceTone(value),
        })),
        cell: ({ row }) => {
          const status = row.due?.status ?? "not_scheduled";
          return (
            <Badge
              tone={maintenanceTone(status)}
              size="xs"
              dot
              variant={status === "overdue" && row.isCriticalPlant ? "solid" : "subtle"}
            >
              {MAINTENANCE_STATUS_LABEL[status]}
            </Badge>
          );
        },
      },
      {
        id: "basis",
        header: "Governed by",
        headerTooltip:
          "Which of the two clocks is driving this due date. A calendar due date and a meter due point are not the same kind of number and are never silently mixed.",
        accessor: (row) => row.due?.basis ?? "",
        type: "enum",
        width: 140,
        cell: ({ row }) =>
          row.due?.basis ? (
            <Badge tone={row.due.basis === "meter" ? "info" : "neutral"} size="xs" variant="outline">
              {row.due.basis === "meter" ? "Meter" : "Calendar"}
            </Badge>
          ) : (
            <span className="text-2xs text-content-subtle italic">neither</span>
          ),
      },
      {
        id: "due",
        header: "Due",
        accessor: (row) => row.due?.nextDueAt ?? row.due?.projectedDueAt ?? "",
        type: "text",
        width: 220,
        cell: ({ row }) => <DueCell row={row} />,
      },
      {
        id: "overdueBy",
        header: "Past due by",
        accessor: (row) => row.due?.overdueBy?.value ?? null,
        type: "custom",
        align: "right",
        width: 150,
        aggregate: "none",
        sortDescFirst: true,
        cell: ({ row }) =>
          row.due?.overdueBy ? (
            <span className="font-semibold tabular-nums text-danger-fg">
              {row.due.overdueBy.value} {row.due.overdueBy.unit}
            </span>
          ) : (
            <span className="text-content-subtle">—</span>
          ),
      },
      {
        id: "lastPerformedAt",
        header: "Last done",
        accessor: (row) => row.lastPerformedAt ?? "",
        type: "text",
        width: 140,
        cell: ({ row }) =>
          row.lastPerformedAt ? (
            <span className="text-content-muted">{isoDate(row.lastPerformedAt)}</span>
          ) : (
            <Tooltip content="This schedule has never been performed. The clock still runs — it started when the machine arrived — but a service history that begins with a blank is worth knowing about.">
              <span>
                <Badge tone="warning" size="xs" variant="outline">
                  never
                </Badge>
              </span>
            </Tooltip>
          ),
      },
    ],
    [],
  );

  if (register.error) return <LoadError message={register.error} onRetry={register.reload} />;
  if (register.loading && !data) return <SkeletonTable rows={10} columns={7} />;
  if (!data) return null;

  const summary = data.summary;

  return (
    <div className="space-y-4">
      {summary.overdueOnCriticalPlant > 0 ? (
        <Alert
          tone="danger"
          title={`${summary.overdueOnCriticalPlant} overdue service${
            summary.overdueOnCriticalPlant === 1 ? "" : "s"
          } on critical plant`}
        >
          Critical plant is the machinery whose failure stops the works. An overdue service on one
          of these is not a fleet-admin item: it is an unpriced programme risk that will announce
          itself as a breakdown on the day it costs most. Assessed {data.asOf}.
        </Alert>
      ) : null}

      <Card>
        <CardBody className="space-y-3">
          <SectionHeading
            title="Maintenance due"
            hint="Calendar and meter intervals race each other — whichever arrives first governs. This register is company-wide because a service history belongs to the machine, not to the job it happens to be on."
            className="mb-0"
            actions={
              <Switch
                checked={criticalOnly}
                onChange={onCriticalOnly}
                label="Critical plant only"
                size="sm"
              />
            }
          />
          <div className="flex flex-wrap items-center gap-3">
            <SegmentedControl<Bucket>
              value={bucket}
              onChange={setBucket}
              size="sm"
              aria-label="Maintenance bucket"
              options={[
                { value: "overdue", label: `Overdue (${summary.overdue})` },
                { value: "due_soon", label: `Due soon (${summary.dueSoon})` },
                { value: "not_scheduled", label: `Not scheduled (${summary.notScheduled})` },
                { value: "all", label: `All (${data.total})` },
              ]}
            />
            <span className="text-2xs text-content-subtle">assessed {data.asOf}</span>
          </div>
          <p className="text-2xs text-content-muted">
            A schedule reading <strong>not scheduled</strong> is not a schedule that is fine. It is
            a schedule the platform cannot place — most often because the machine&rsquo;s meter has
            never been read, so a meter interval has nothing to measure against. The reason is
            printed on the row rather than resolved into a guess.
          </p>
        </CardBody>
      </Card>

      {filtered.length === 0 ? (
        <EmptyState
          icon={IconTool}
          tone={bucket === "overdue" ? "success" : "neutral"}
          title={
            bucket === "overdue"
              ? "No service is overdue"
              : bucket === "due_soon"
                ? "Nothing falls due in the warning window"
                : bucket === "not_scheduled"
                  ? "Every schedule can be placed"
                  : "No maintenance schedules exist"
          }
          hint={
            bucket === "not_scheduled"
              ? `Every schedule on the register has enough inputs to compute a due point — a last-performed date, or a meter reading, or a baseline the clock can start from. Assessed ${data.asOf}.`
              : bucket === "all"
                ? "No machine carries a maintenance schedule. Plant without a schedule is not plant without maintenance needs; it is plant whose maintenance needs are nobody's job."
                : `The test ran against ${data.total} schedule(s) as at ${data.asOf} and found none in this state.`
          }
        />
      ) : (
        <div className="space-y-4">
          <DataTable<MaintenanceRow>
            tableId="equipment-maintenance"
            data={filtered}
            columns={columns}
            getRowId={(row) => row.id}
            loading={register.loading}
            height={560}
            stickyHeader
            gridLines
            filterRow
            exportFileName="equipment-maintenance-due"
            searchPlaceholder="Search schedules…"
            rowTone={(row) => maintenanceRail(row)}
            onRowClick={({ row }) => onOpenMachine(row.equipmentId)}
            rowActions={(row) => [
              {
                id: "open",
                label: "Open the machine",
                onSelect: () => onOpenMachine(row.equipmentId),
              },
              /*
               * A schedule with no way out is a schedule people work around.
               * A machine that has left the fleet, or whose regime changed,
               * used to keep generating overdue services for ever.
               */
              {
                id: "status",
                label:
                  row.status === "suspended"
                    ? "Reinstate the schedule"
                    : row.status === "retired"
                      ? "Reinstate the schedule"
                      : "Suspend or retire",
                onSelect: () => setStatusTarget(row),
              },
            ]}
            empty={{ title: "No schedules in this bucket" }}
            aria-label="Maintenance schedules"
          />

          <ScheduleStatusModal
            row={statusTarget}
            onClose={() => setStatusTarget(null)}
            onDone={() => {
              setStatusTarget(null);
              register.reload();
            }}
          />

          {bucket === "not_scheduled" ? (
            <div>
              <SectionHeading
                title="Why these schedules cannot be placed"
                hint="The engine's own words. Each of these is a missing input, not a machine that is fine."
              />
              <div className="space-y-2">
                {filtered.slice(0, 25).map((row) => (
                  <Card key={row.id}>
                    <CardBody className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-semibold">
                          {row.equipmentReference ?? row.equipmentId}
                        </span>
                        <span className="text-sm text-content">{row.name}</span>
                        <Badge tone="neutral" size="xs" variant="outline">
                          every {row.intervalValue}{" "}
                          {(
                            INTERVAL_KIND_LABEL[row.intervalKind] ?? labelize(row.intervalKind)
                          ).toLowerCase()}
                        </Badge>
                      </div>
                      <ReasonList reasons={row.due?.reasons ?? []} />
                    </CardBody>
                  </Card>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function maintenanceRail(row: MaintenanceRow): Tone | undefined {
  const status = row.due?.status ?? "not_scheduled";
  if (status === "overdue") return "danger";
  if (status === "due_soon") return "warning";
  return undefined;
}

/**
 * The due cell says WHICH clock produced the answer, and where a meter
 * interval has been projected onto a date it says the date is a projection.
 */
function DueCell({ row }: { row: MaintenanceRow }) {
  const due = row.due;
  if (!due) {
    return (
      <span className="text-2xs text-content-subtle italic">
        the machine record could not be read
      </span>
    );
  }
  if (due.basis === "calendar" && due.nextDueAt) {
    return (
      <span className="text-content">
        {due.nextDueAt}
        {due.daysRemaining !== null ? (
          <span className={due.daysRemaining < 0 ? "text-danger-fg" : "text-content-subtle"}>
            {" "}
            · {due.daysRemaining < 0 ? `${Math.abs(due.daysRemaining)}d past` : `${due.daysRemaining}d`}
          </span>
        ) : null}
      </span>
    );
  }
  if (due.basis === "meter" && due.nextDueMeter !== null) {
    return (
      <span className="text-content">
        at {due.nextDueMeter.toFixed(0)}
        {due.meterRemaining !== null ? (
          <span className={due.meterRemaining < 0 ? "text-danger-fg" : "text-content-subtle"}>
            {" "}
            ·{" "}
            {due.meterRemaining < 0
              ? `${Math.abs(due.meterRemaining).toFixed(0)} past`
              : `${due.meterRemaining.toFixed(0)} to run`}
          </span>
        ) : null}
        {due.projectedDueAt ? (
          <Tooltip content="A meter interval projected onto a date from the machine's average daily usage. It is an estimate of when, not a commitment — the meter, not the calendar, is what makes this service due.">
            <span className="ml-1 text-2xs text-content-subtle underline decoration-dotted">
              ≈ {due.projectedDueAt}
            </span>
          </Tooltip>
        ) : null}
      </span>
    );
  }
  return (
    <Tooltip
      content={
        <span className="block max-w-xs space-y-1">
          {(due.reasons.length > 0
            ? due.reasons
            : ["The platform holds no basis on which to place this schedule."]
          ).map((reason, index) => (
            <span key={index} className="block">
              {reason}
            </span>
          ))}
        </span>
      }
    >
      <span className="inline-flex items-center gap-1 text-content-muted">
        <span className="font-medium">Cannot be placed</span>
        <Badge tone="warning" size="xs">
          why
        </Badge>
      </span>
    </Tooltip>
  );
}

/* ========================================================================== */
/* Suspend, retire or reinstate a schedule                                     */
/* ========================================================================== */

/**
 * SUSPENDING A SCHEDULE STOPS THE SWEEP COUNTING IT, and keeps its history.
 * Retiring closes it. Neither deletes anything: a machine's service history is
 * the evidence that it was maintained, and evidence is not tidied away.
 *
 * A STATUTORY schedule cannot be suspended or retired without a reason,
 * because that regime is what keeps the plant lawful to operate — and the
 * reason is ledgered with the person who gave it. The API's refusal is
 * rendered verbatim.
 */
function ScheduleStatusModal({
  row,
  onClose,
  onDone,
}: {
  row: MaintenanceRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [reason, setReason] = useState("");

  if (!row) return null;
  const suspended = row.status === "suspended" || row.status === "retired";

  async function act(status: "active" | "suspended" | "retired") {
    if (!row) return;
    const done = await run(status, () =>
      api.patch(
        `/api/v1/companies/current/equipment/${row.equipmentId}/maintenance-schedules/${row.id}`,
        { status, reason: reason.trim() || undefined },
      ),
    );
    if (done) {
      toast.success(
        status === "active"
          ? "Reinstated — the next due date was recomputed from the last service performed"
          : status === "suspended"
            ? "Suspended — it no longer raises a due or overdue service"
            : "Retired",
      );
      setReason("");
      onDone();
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={row.name}
      description={`${row.equipmentReference ?? "This machine"} · ${labelize(row.status)}${
        row.isStatutory ? " · STATUTORY" : ""
      }`}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {suspended ? (
            <Button variant="primary" loading={busy === "active"} onClick={() => act("active")}>
              Reinstate
            </Button>
          ) : (
            <>
              <Button
                variant="secondary"
                loading={busy === "suspended"}
                disabled={row.isStatutory && reason.trim() === ""}
                onClick={() => act("suspended")}
              >
                Suspend
              </Button>
              <Button
                variant="danger"
                loading={busy === "retired"}
                disabled={row.isStatutory && reason.trim() === ""}
                onClick={() => act("retired")}
              >
                Retire
              </Button>
            </>
          )}
        </div>
      }
    >
      <div className="space-y-3">
        {refusal ? <RefusalNotice refusal={refusal} onDismiss={clear} /> : null}
        {row.isStatutory ? (
          <p className="text-meta text-danger">
            This is a STATUTORY schedule — the regime that keeps this machine lawful to operate.
            Suspending or retiring it requires a reason, and the reason is kept on the ledger with
            your name against it.
          </p>
        ) : null}
        <Field
          label="Why"
          required={row.isStatutory}
          hint="Kept on the ledger. 'Machine off hire', 'regime withdrawn', 'interval corrected under SFG20'."
        >
          <Textarea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
        <p className="text-2xs text-content-subtle">
          Nothing is deleted. A suspended schedule keeps its history and stops being counted;
          reinstating it recomputes the next due date from the last service actually performed.
        </p>
      </div>
    </Modal>
  );
}
