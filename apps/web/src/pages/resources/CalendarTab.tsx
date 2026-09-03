/**
 * THE CREW & PLANT CALENDAR (spec Vol I #688–690).
 *
 * A booking is kept even when it clashes. The lane grid paints the overlap in
 * the danger tone and the clash list names both bookings and the argument they
 * represent, because refusing the second booking at the point of entry would
 * lose the requirement that produced it.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Drawer,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Table,
  Td,
  Th,
  type DataColumns,
} from "../../ui";
import { IconCalendar, IconPlus, IconWarning } from "../../ui/icons";
import {
  ASSIGNMENT_STATUS_TONE,
  LoadError,
  Pill,
  Row,
  count,
  dateOnly,
  hours,
  mondayOf,
  num,
  percent,
  resourcesApi,
  severityTone,
  shiftIso,
  shortDate,
  titleCase,
  todayIso,
  useAction,
  useResource,
  type Assignment,
  type CalendarView,
  type Conflict,
  type Paginated,
  type ResourceType,
  type UtilisationView,
} from "./resourcesShared";

export default function CalendarTab({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}) {
  const [nonce, setNonce] = useState(0);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [from, setFrom] = useState(mondayOf(todayIso()));
  const to = shiftIso(from, 27);

  const calendar = useResource<CalendarView>(
    `/api/v1/projects/${projectId}/resources/calendar?from=${from}&to=${to}&_=${nonce}`,
  );
  const assignments = useResource<Paginated<Assignment>>(
    `/api/v1/projects/${projectId}/resource-assignments?pageSize=200&_=${nonce}`,
  );
  const utilisation = useResource<UtilisationView>(
    `/api/v1/projects/${projectId}/resources/utilisation?from=${from}&to=${to}&_=${nonce}`,
  );
  const types = useResource<Paginated<ResourceType>>(
    `/api/v1/resource-types?pageSize=200&status=active&projectId=${projectId}`,
  );

  const reload = () => {
    setNonce((n) => n + 1);
    onChanged();
  };

  const columns = useMemo<DataColumns<Assignment>>(
    () => [
      { id: "reference", header: "Ref", accessor: "reference", type: "text", width: 90, mono: true },
      { id: "subjectLabel", header: "Resource", accessor: "subjectLabel", type: "text", width: 220 },
      {
        id: "subjectKind",
        header: "Kind",
        accessor: (row) => titleCase(row.subjectKind),
        type: "text",
        width: 100,
      },
      { id: "taskName", header: "Activity", accessor: (row) => row.taskName ?? "—", type: "text", width: 220 },
      { id: "fromDate", header: "From", accessor: "fromDate", type: "date", width: 110 },
      { id: "toDate", header: "To", accessor: "toDate", type: "date", width: 110 },
      {
        id: "allocationPercent",
        header: "Alloc",
        accessor: "allocationPercent",
        type: "number",
        align: "right",
        width: 80,
        cell: ({ row }) => percent(row.allocationPercent),
      },
      {
        id: "plannedHours",
        header: "Planned",
        accessor: (row) => row.plannedHours,
        type: "number",
        align: "right",
        width: 100,
        cell: ({ row }) => hours(row.plannedHours),
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "text",
        width: 120,
        cell: ({ row }) => <Pill status={row.status} map={ASSIGNMENT_STATUS_TONE} />,
      },
    ],
    [],
  );

  const conflicts = calendar.data?.conflicts ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Four-week calendar"
          subtitle={
            calendar.data
              ? `${calendar.data.calendar.source} Bookings that straddle the window edge are shown.`
              : "Who is booked on what"
          }
          actions={
            <div className="flex items-center gap-2">
              <Input
                type="date"
                value={from}
                onChange={(e) => setFrom(mondayOf(e.target.value || todayIso()))}
                size="sm"
                aria-label="Window start"
              />
              <Button size="sm" icon={IconPlus} onClick={() => setCreating(true)}>
                Book a resource
              </Button>
            </div>
          }
        />
        <CardBody flush>
          {calendar.error ? (
            <div className="p-4">
              <LoadError message={calendar.error} onRetry={calendar.reload} />
            </div>
          ) : calendar.data && calendar.data.lanes.length > 0 ? (
            <div className="overflow-x-auto">
              <Table dense>
                <thead>
                  <tr>
                    <Th className="sticky left-0 z-10 bg-surface">Resource</Th>
                    {calendar.data.days.map((d) => (
                      <Th
                        key={d.date}
                        align="center"
                        className={d.working ? "" : "text-content-subtle opacity-60"}
                      >
                        {shortDate(d.date)}
                      </Th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {calendar.data.lanes.map((lane) => {
                    const clashDays = new Set<string>();
                    for (const c of conflicts) {
                      if (c.subjectId !== lane.subjectId) continue;
                      for (const d of calendar.data!.days) {
                        if (d.date >= c.fromDate && d.date <= c.toDate) clashDays.add(d.date);
                      }
                    }
                    return (
                      <tr key={`${lane.subjectKind}-${lane.subjectId}`}>
                        <Td className="sticky left-0 z-10 bg-surface">
                          <div className="font-medium text-content">{lane.subjectLabel}</div>
                          <div className="text-2xs text-content-subtle">
                            {titleCase(lane.subjectKind)} · {lane.bookings.length} booking(s)
                          </div>
                        </Td>
                        {calendar.data!.days.map((d) => {
                          const booked = lane.bookings.filter(
                            (b) => b.fromDate <= d.date && b.toDate >= d.date,
                          );
                          const clash = clashDays.has(d.date);
                          return (
                            <Td key={d.date} align="center">
                              {booked.length > 0 ? (
                                <span
                                  title={booked
                                    .map(
                                      (b) =>
                                        `${b.reference} ${b.allocationPercent}%${
                                          b.taskName ? ` — ${b.taskName}` : ""
                                        }`,
                                    )
                                    .join("; ")}
                                >
                                  <Badge
                                    tone={clash ? "danger" : d.working ? "info" : "neutral"}
                                    size="xs"
                                  >
                                    {booked.reduce((s, b) => s + b.allocationPercent, 0)}%
                                  </Badge>
                                </span>
                              ) : (
                                <span className="text-2xs text-content-subtle">·</span>
                              )}
                            </Td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </div>
          ) : (
            <div className="p-4">
              <EmptyState
                title="Nothing booked in this window"
                hint={
                  calendar.data?.reasons[0] ??
                  "The calendar shows resource assignments — crews, workers and plant booked to activities — not timecards."
                }
                icon={IconCalendar}
                size="sm"
              />
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Double bookings"
          subtitle="Both bookings were made because somebody needed the resource. Neither is deleted here."
        />
        <CardBody>
          {conflicts.length > 0 ? (
            <ul className="space-y-2">
              {conflicts.map((c: Conflict, i) => (
                <li
                  key={`${c.subjectId}-${c.fromDate}-${i}`}
                  className="rounded-md border border-danger-border bg-surface-raised p-3"
                >
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Pill status={c.severity} map={{ [c.severity]: severityTone(c.severity) }} />
                    <span className="text-meta font-medium text-content">{c.subjectLabel}</span>
                    <span className="text-2xs text-content-subtle">
                      {dateOnly(c.fromDate)} → {dateOnly(c.toDate)} · {c.days} day(s) ·{" "}
                      {percent(c.totalAllocationPercent)}
                    </span>
                  </div>
                  <p className="text-2xs text-content-subtle">{c.explanation}</p>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              title="No clashes in this window"
              hint="Every crew, worker and machine is booked to at most 100% on every day."
              icon={IconWarning}
              size="sm"
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Utilisation"
          subtitle="Booked working days against the window. A resource booked at half allocation for the whole window is fully committed from a planning point of view, which is why this counts days rather than summing allocation."
        />
        <CardBody flush>
          {utilisation.error ? (
            <div className="p-3">
              <LoadError message={utilisation.error} onRetry={utilisation.reload} />
            </div>
          ) : utilisation.data && utilisation.data.items.length > 0 ? (
            <Table dense>
              <thead>
                <tr>
                  <Th>Resource</Th>
                  <Th align="right">Booked days</Th>
                  <Th align="right">Window days</Th>
                  <Th align="right">Utilisation</Th>
                  <Th align="right">Planned hours</Th>
                </tr>
              </thead>
              <tbody>
                {utilisation.data.items.map((u) => (
                  <tr key={`${u.subjectKind}-${u.subjectId}`} title={u.reasons.join(" ")}>
                    <Td>{u.subjectLabel}</Td>
                    <Td align="right">{count(u.bookedDays)}</Td>
                    <Td align="right">{count(u.windowDays)}</Td>
                    <Td align="right">{percent(u.utilisationPercent)}</Td>
                    <Td align="right">{hours(u.plannedHours)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <div className="p-4">
              <EmptyState
                title="Nothing to measure"
                hint={utilisation.data?.reasons[0] ?? "No resource is booked in this window."}
                size="sm"
              />
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Every booking" subtitle="Including the cancelled and completed ones" />
        <CardBody flush>
          {assignments.error ? (
            <div className="p-4">
              <LoadError message={assignments.error} onRetry={assignments.reload} />
            </div>
          ) : (
            <DataTable<Assignment>
              tableId="resources.assignments"
              data={assignments.data?.items ?? []}
              columns={columns}
              getRowId={(row) => row.id}
              loading={assignments.loading && !assignments.data}
              height={340}
              rowHeight={40}
              stickyHeader
              flush
              toolbar={false}
              empty={{
                title: "Nothing booked yet",
                description:
                  "Book a crew, a worker or a machine to an activity. Two bookings that overlap are kept and reported rather than refused.",
              }}
              onRowClick={({ row }) => setOpenId(row.id)}
              aria-label="Resource assignments"
            />
          )}
        </CardBody>
      </Card>

      <CreateAssignmentModal
        open={creating}
        projectId={projectId}
        types={types.data?.items ?? []}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          reload();
        }}
      />

      <AssignmentDrawer
        projectId={projectId}
        assignmentId={openId}
        onClose={() => setOpenId(null)}
        onChanged={reload}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function AssignmentDrawer({
  projectId,
  assignmentId,
  onClose,
  onChanged,
}: {
  projectId: string;
  assignmentId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const action = useAction();
  const [nonce, setNonce] = useState(0);
  const [reason, setReason] = useState("");
  const detail = useResource<Assignment>(
    assignmentId
      ? `/api/v1/projects/${projectId}/resource-assignments/${assignmentId}?_=${nonce}`
      : null,
  );
  const a = detail.data;
  const bump = () => {
    setNonce((n) => n + 1);
    onChanged();
  };

  const transition = async (act: string, body: unknown = {}) => {
    if (!a) return;
    const res = await action.run(act, () =>
      resourcesApi.transitionAssignment(projectId, a.id, act, body),
    );
    if (res) {
      toast.success(titleCase(act));
      bump();
    }
  };

  return (
    <Drawer
      open={assignmentId !== null}
      onClose={onClose}
      size="lg"
      title={a ? `${a.reference} — ${a.subjectLabel}` : "Booking"}
      description={
        a ? (
          <span className="flex items-center gap-2">
            <Pill status={a.status} map={ASSIGNMENT_STATUS_TONE} />
            <span className="text-2xs text-content-subtle">
              {dateOnly(a.fromDate)} → {dateOnly(a.toDate)} · {percent(a.allocationPercent)}
            </span>
          </span>
        ) : null
      }
    >
      {detail.error ? (
        <LoadError message={detail.error} onRetry={detail.reload} />
      ) : !a ? (
        <div className="py-8 text-center text-meta text-content-subtle">Loading…</div>
      ) : (
        <div className="space-y-4">
          {action.error ? (
            <Alert tone="danger" size="sm" onDismiss={action.clear}>
              {action.error}
            </Alert>
          ) : null}

          <dl className="divide-y divide-border-subtle">
            <Row label="Resource">{a.subjectLabel}</Row>
            <Row label="Kind">{titleCase(a.subjectKind)}</Row>
            <Row label="Activity">{a.taskName ?? "—"}</Row>
            <Row label="Trade / plant class">{a.resourceTypeName ?? "—"}</Row>
            <Row label="Shift">{titleCase(a.shift)}</Row>
            <Row label="Hours per day" hint={a.hoursPerDay === null ? "Not recorded" : undefined}>
              {num(a.hoursPerDay)}
            </Row>
            <Row label="Planned hours">{hours(a.plannedHours)}</Row>
            {a.cancelledReason ? <Row label="Cancelled because">{a.cancelledReason}</Row> : null}
          </dl>

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={a.status !== "planned"}
              loading={action.busy === "confirm"}
              onClick={() => transition("confirm")}
            >
              Confirm
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={a.status !== "planned" && a.status !== "confirmed"}
              loading={action.busy === "start"}
              onClick={() => transition("start")}
            >
              Start
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={a.status !== "confirmed" && a.status !== "in_progress"}
              loading={action.busy === "complete"}
              onClick={() => transition("complete")}
            >
              Complete
            </Button>
          </div>

          {a.status !== "cancelled" && a.status !== "completed" ? (
            <Card>
              <CardHeader
                title="Release this booking"
                subtitle="A reason is required: “why was the crane released” is the question a delay analysis asks six months later."
              />
              <CardBody className="space-y-2">
                <Field label="Reason" required>
                  <Input value={reason} onChange={(e) => setReason(e.target.value)} />
                </Field>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={reason.trim().length === 0}
                  loading={action.busy === "cancel"}
                  onClick={() => transition("cancel", { reason: reason.trim() })}
                >
                  Cancel booking
                </Button>
              </CardBody>
            </Card>
          ) : null}

          {a.conflicts && a.conflicts.length > 0 ? (
            <Alert tone="danger" size="sm" title="This booking clashes">
              <ul className="space-y-1 text-2xs">
                {a.conflicts.map((c, i) => (
                  <li key={i}>{c.explanation}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
        </div>
      )}
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */

function CreateAssignmentModal({
  open,
  projectId,
  types,
  onClose,
  onCreated,
}: {
  open: boolean;
  projectId: string;
  types: ResourceType[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const action = useAction();
  const [subjectKind, setSubjectKind] = useState<"crew" | "worker" | "equipment">("crew");
  const [subjectId, setSubjectId] = useState("");
  const [typeId, setTypeId] = useState("");
  const [fromDate, setFromDate] = useState(todayIso());
  const [toDate, setToDate] = useState(shiftIso(todayIso(), 4));
  const [hoursPerDay, setHoursPerDay] = useState("8");
  const [allocation, setAllocation] = useState("100");
  const [warning, setWarning] = useState<string | null>(null);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Book a resource"
      description="A booking names exactly one crew, worker or machine. A clash with an existing booking is reported, not refused."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button
            size="sm"
            loading={action.busy === "create"}
            disabled={subjectId.trim().length === 0}
            onClick={async () => {
              setWarning(null);
              const body: Record<string, unknown> = {
                fromDate,
                toDate,
                allocationPercent: Number(allocation) || 100,
                ...(hoursPerDay ? { hoursPerDay: Number(hoursPerDay) } : {}),
                ...(typeId ? { resourceTypeId: typeId } : {}),
              };
              body[`${subjectKind}Id`] = subjectId.trim();
              const res = await action.run("create", () =>
                resourcesApi.createAssignment(projectId, body),
              );
              if (res) {
                if (res.conflictWarning) {
                  setWarning(res.conflictWarning);
                  toast.warning("Booked, with a clash");
                } else {
                  toast.success(`${res.reference} booked`);
                }
                onCreated();
              }
            }}
          >
            Book
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {action.error ? (
          <Alert tone="danger" size="sm" onDismiss={action.clear}>
            {action.error}
          </Alert>
        ) : null}
        {warning ? (
          <Alert tone="warning" size="sm" title="Kept, and clashing">
            {warning}
          </Alert>
        ) : null}
        <Field label="What is being booked">
          <Select
            value={subjectKind}
            onChange={(e) => setSubjectKind(e.target.value as "crew" | "worker" | "equipment")}
          >
            <option value="crew">Crew</option>
            <option value="worker">Worker</option>
            <option value="equipment">Machine</option>
          </Select>
        </Field>
        <Field
          label={`${titleCase(subjectKind)} id`}
          required
          hint="The record's id from the crews, workforce or equipment register — this module keeps no second register of its own."
        >
          <Input value={subjectId} onChange={(e) => setSubjectId(e.target.value)} />
        </Field>
        <Field
          label="Trade or plant class"
          hint="Setting this is what makes the certification check run against the booking."
        >
          <Select value={typeId} onChange={(e) => setTypeId(e.target.value)}>
            <option value="">Not stated</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.code} — {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From">
            <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Hours per day">
            <Input
              type="number"
              value={hoursPerDay}
              onChange={(e) => setHoursPerDay(e.target.value)}
            />
          </Field>
          <Field label="Allocation %" hint="Two 50% bookings do not clash.">
            <Input
              type="number"
              value={allocation}
              onChange={(e) => setAllocation(e.target.value)}
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
