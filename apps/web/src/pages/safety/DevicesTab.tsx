/**
 * DEVICE AND LONE-WORKER ALARMS (spec Vol II Z #1070–1073).
 *
 * These are NOT incidents and this register deliberately refuses to file them
 * as such. A man-down alarm is an accelerometer reading; whether an incident
 * occurred is a human's determination made afterwards, and a platform that
 * converts every alarm into an incident produces a register nobody can close
 * and a rate nobody believes.
 *
 * What this register owns instead is the RESPONSE CLOCK. The only thing that
 * can be proved afterwards about a device programme is whether somebody
 * answered the alarm and how long that took, so the deadline is set from the
 * alarm class on arrival — five minutes for a man-down, eight hours for a
 * device going offline — and an unanswered life-safety alarm past that point
 * raises a critical signal in its own right.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  DataTable,
  DescriptionList,
  Drawer,
  Field,
  Input,
  Modal,
  Select,
  Skeleton,
  Textarea,
  type DataColumns,
  type DescriptionItem,
} from "../../ui";
import { IconZap } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  ALARM_STATUS_TONE,
  EM_DASH,
  LoadError,
  RegisterPager,
  RefusalNotice,
  SAFETY_SEVERITY_TONE,
  SectionHeading,
  count,
  dateTime,
  decimal,
  labelize,
  nameOf,
  pageParams,
  useMutation,
  useResource,
  type Paged,
  type Resource,
  type SensorEvent,
  type SensorEventDetail,
} from "./safetyShared";

export interface DeviceFilters {
  page: string;
  status: string;
  kind: string;
  source: string;
  unacknowledged: string;
}

export const EMPTY_DEVICE_FILTERS: DeviceFilters = {
  page: "1",
  status: "",
  kind: "",
  source: "",
  unacknowledged: "",
};

export function deviceQueryString(filters: DeviceFilters): string {
  const params = pageParams(filters.page);
  if (filters.status) params.set("status", filters.status);
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.source) params.set("source", filters.source);
  if (filters.unacknowledged) params.set("unacknowledged", filters.unacknowledged);
  return params.toString();
}

const KINDS = [
  "man_down",
  "no_motion",
  "fall_detected",
  "impact",
  "sos",
  "check_in_missed",
  "gas_alarm",
  "heat_stress",
  "noise_exposure",
  "proximity_alert",
  "exclusion_zone_breach",
  "device_offline",
  "panic_test",
];

const SOURCES = [
  "wearable",
  "lone_worker_device",
  "gas_detector",
  "proximity_tag",
  "plant_telematics",
  "mobile_app",
  "manual",
];

const STATUSES = ["open", "acknowledged", "auto_resolved", "resolved", "escalated", "false_alarm"];

function nowLocalInput(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function DevicesTab({
  projectId,
  events,
  filters,
  onFilters,
  users,
  onMutated,
}: {
  projectId: string;
  events: Resource<Paged<SensorEvent>>;
  filters: DeviceFilters;
  onFilters: (next: DeviceFilters) => void;
  users: Map<string, string>;
  onMutated: () => void;
}) {
  const rows = events.data?.items ?? [];
  const [openId, setOpenId] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);

  const unanswered = rows.filter((r) => r.acknowledgementOverdue);
  const lifeSafetyOpen = rows.filter((r) => r.isLifeSafety && r.status === "open");

  const columns = useMemo<DataColumns<SensorEvent>>(
    () => [
      {
        id: "reference",
        header: "Number",
        accessor: "reference",
        type: "code",
        sticky: "start",
        width: 100,
        mono: true,
      },
      {
        id: "kind",
        header: "Alarm",
        accessor: "kind",
        type: "enum",
        width: 180,
        groupable: true,
        options: KINDS.map((k) => ({ value: k, text: labelize(k), label: labelize(k) })),
        cell: ({ row }) => (
          <span className="block min-w-0">
            <span className="block truncate font-medium">{labelize(row.kind)}</span>
            <span className="block truncate text-2xs text-content-subtle">
              {labelize(row.source)}
              {row.deviceId ? ` · ${row.deviceId}` : ""}
            </span>
          </span>
        ),
      },
      {
        id: "severity",
        header: "Class",
        accessor: "severity",
        type: "enum",
        width: 130,
        cell: ({ row }) => (
          <span className="flex flex-wrap items-center gap-1">
            <Badge tone={SAFETY_SEVERITY_TONE[row.severity] ?? "neutral"} size="xs" dot>
              {labelize(row.severity)}
            </Badge>
            {row.isLifeSafety ? (
              <Badge tone="danger" size="xs" variant="outline">
                Life safety
              </Badge>
            ) : null}
          </span>
        ),
      },
      {
        id: "person",
        header: "Person",
        accessor: (row) => row.reportedPersonName ?? row.workerId ?? "",
        type: "text",
        width: 160,
        cell: ({ row }) =>
          row.reportedPersonName ?? row.workerId ?? (
            <span className="text-content-subtle">Unassigned device</span>
          ),
      },
      {
        id: "occurredAt",
        header: "Occurred",
        accessor: "occurredAt",
        type: "datetime",
        width: 170,
        cell: ({ row }) => dateTime(row.occurredAt),
      },
      {
        id: "response",
        header: "Response",
        headerTooltip:
          "Time from the alarm arriving to somebody acknowledging it. The deadline comes from the alarm class — five minutes for a man-down, eight hours for a device going offline.",
        accessor: (row) => row.responseMinutes ?? (row.acknowledgementOverdue ? 99_999 : -1),
        type: "custom",
        width: 170,
        cell: ({ row }) => {
          if (row.acknowledgedAt) {
            return (
              <span className="text-meta tabular-nums">
                {decimal(row.responseMinutes ?? 0, 1)} min
                <span className="block text-2xs text-content-subtle">
                  target {count(row.responseDeadlineMinutes)} min
                </span>
              </span>
            );
          }
          if (row.acknowledgementOverdue) {
            return (
              <Badge tone="danger" size="xs" dot>
                {count(row.minutesLate)} min past the deadline
              </Badge>
            );
          }
          return <span className="text-content-subtle">Awaiting a response</span>;
        },
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "enum",
        width: 140,
        groupable: true,
        options: STATUSES.map((s) => ({ value: s, text: labelize(s), label: labelize(s) })),
        cell: ({ row }) => (
          <Badge tone={ALARM_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
            {labelize(row.status)}
          </Badge>
        ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-3">
      {lifeSafetyOpen.length > 0 ? (
        <Alert
          tone="danger"
          title={`${count(lifeSafetyOpen.length)} life-safety alarm${lifeSafetyOpen.length === 1 ? " is" : "s are"} open`}
        >
          A life-safety alarm is the device asserting that the person wearing it may be unconscious,
          immobile or in an atmosphere that will kill them. The only acceptable response is somebody
          physically confirming otherwise — acknowledging it from a screen records that the alarm was
          seen, not that the person was found.
        </Alert>
      ) : null}

      {unanswered.length > 0 ? (
        <Alert
          tone="warning"
          title={`${count(unanswered.length)} alarm${unanswered.length === 1 ? " is" : "s are"} past their response deadline`}
        >
          A fleet generating alarms into silence is worse than no fleet, because it looks like
          coverage. Either respond to them or turn off the class nobody is going to act on.
        </Alert>
      ) : null}

      <Card variant="sunken">
        <CardBody className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="Status">
            <Select
              value={filters.status}
              onChange={(e) => onFilters({ ...filters, status: e.target.value })}
            >
              <option value="">Any</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {labelize(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Alarm class">
            <Select
              value={filters.kind}
              onChange={(e) => onFilters({ ...filters, kind: e.target.value })}
            >
              <option value="">Any</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {labelize(k)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Source">
            <Select
              value={filters.source}
              onChange={(e) => onFilters({ ...filters, source: e.target.value })}
            >
              <option value="">Any</option>
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {labelize(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Unacknowledged">
            <Select
              value={filters.unacknowledged}
              onChange={(e) => onFilters({ ...filters, unacknowledged: e.target.value })}
            >
              <option value="">Any</option>
              <option value="true">Never answered</option>
            </Select>
          </Field>
          <div className="flex items-end pb-1">
            <Button size="sm" variant="secondary" onClick={() => setManualOpen(true)}>
              Record an alarm
            </Button>
          </div>
        </CardBody>
      </Card>

      {events.error ? (
        <LoadError
          message={events.error}
          onRetry={events.reload}
          title="The alarm register could not be loaded"
        />
      ) : events.loading && rows.length === 0 ? (
        <Skeleton height={360} />
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={({ row }) => setOpenId(row.id)}
          empty={{
            icon: IconZap,
            title: "No device alarm has reached this project",
            description:
              "Either no wearable, lone-worker device or gas detector is reporting here, or the feed is not connected. An empty register is not a quiet site — it is a site with no device evidence either way.",
          }}
          emptyFiltered={{
            title: "No alarm matches these filters",
            description: "Widen the class, source or status filter.",
          }}
          aria-label="Device alarm register"
        />
      )}

      <RegisterPager
        page={filters.page}
        loaded={rows.length}
        total={events.data?.total ?? null}
        noun="device alarm"
        loading={events.loading}
        onPage={(page) => onFilters({ ...filters, page })}
      />

      <AlarmDrawer
        projectId={projectId}
        eventId={openId}
        users={users}
        onClose={() => setOpenId(null)}
        onMutated={onMutated}
      />

      <ManualAlarmModal
        projectId={projectId}
        open={manualOpen}
        onClose={() => setManualOpen(false)}
        onCreated={() => {
          setManualOpen(false);
          onMutated();
        }}
      />
    </div>
  );
}

/* ========================================================================== */
/* One alarm                                                                   */
/* ========================================================================== */

function AlarmDrawer({
  projectId,
  eventId,
  users,
  onClose,
  onMutated,
}: {
  projectId: string;
  eventId: string | null;
  users: Map<string, string>;
  onClose: () => void;
  onMutated: () => void;
}) {
  const [version, setVersion] = useState(0);
  const [note, setNote] = useState("");
  const [outcome, setOutcome] = useState("");
  const [resolveStatus, setResolveStatus] = useState("resolved");
  const [observationTitle, setObservationTitle] = useState("");

  const detail = useResource<SensorEventDetail>(
    (signal) =>
      api.get<SensorEventDetail>(
        `/api/v1/projects/${projectId}/safety/sensor-events/${eventId}`,
        { signal },
      ),
    [projectId, eventId, version],
    eventId !== null && projectId !== "",
  );

  const mutation = useMutation(() => {
    setVersion((n) => n + 1);
    onMutated();
  });

  const alarm = detail.data;

  const facts: DescriptionItem[] = alarm
    ? [
        { label: "Alarm", value: labelize(alarm.kind) },
        { label: "Source", value: labelize(alarm.source) },
        { label: "Device", value: alarm.deviceId ?? EM_DASH },
        { label: "Person", value: alarm.workerName ?? alarm.reportedPersonName ?? "Unassigned" },
        { label: "Occurred", value: dateTime(alarm.occurredAt) },
        { label: "Received", value: dateTime(alarm.receivedAt) },
        {
          label: "Acknowledgement due",
          value: alarm.acknowledgeDueAt
            ? `${dateTime(alarm.acknowledgeDueAt)} · ${count(alarm.responseDeadlineMinutes)} minutes from receipt`
            : EM_DASH,
          span: 2,
        },
        {
          label: "Reading",
          value:
            alarm.measurementValue === null
              ? EM_DASH
              : `${decimal(alarm.measurementValue, 2)} ${alarm.measurementUnit ?? ""}${
                  alarm.thresholdValue === null
                    ? ""
                    : ` (threshold ${decimal(alarm.thresholdValue, 2)})`
                }`,
          span: 2,
        },
        { label: "Location", value: alarm.locationText ?? EM_DASH, span: 2 },
        {
          label: "Answered",
          value: alarm.acknowledgedAt
            ? `${dateTime(alarm.acknowledgedAt)} by ${nameOf(users, alarm.acknowledgedBy)} · ${decimal(alarm.responseMinutes ?? 0, 1)} minutes`
            : "Nobody has answered it",
          span: 2,
        },
        {
          label: "What was found",
          value: alarm.responseNote ?? EM_DASH,
          span: 2,
        },
        {
          label: "Outcome",
          value: alarm.outcome ?? EM_DASH,
          span: 2,
        },
      ]
    : [];

  return (
    <Drawer
      open={eventId !== null}
      onClose={onClose}
      size="md"
      icon={IconZap}
      tone={alarm?.isLifeSafety && alarm.status === "open" ? "danger" : undefined}
      title={alarm ? `${alarm.reference} · ${labelize(alarm.kind)}` : "Device alarm"}
      headerActions={
        alarm ? (
          <Badge tone={ALARM_STATUS_TONE[alarm.status] ?? "neutral"} size="sm" dot>
            {labelize(alarm.status)}
          </Badge>
        ) : null
      }
    >
      {detail.error ? (
        <LoadError message={detail.error} onRetry={detail.reload} title="This alarm could not be loaded" />
      ) : null}
      {mutation.refusal ? (
        <div className="mb-3">
          <RefusalNotice refusal={mutation.refusal} onDismiss={mutation.clear} />
        </div>
      ) : null}
      {mutation.error ? (
        <div className="mb-3">
          <Alert tone="danger" title="That action could not be completed" onDismiss={mutation.clear}>
            {mutation.error}
          </Alert>
        </div>
      ) : null}

      {detail.loading && !alarm ? (
        <Skeleton height={240} />
      ) : alarm ? (
        <div className="space-y-4">
          {alarm.note ? (
            <Alert tone={alarm.status === "open" ? "danger" : "info"} title="What this class means">
              {alarm.note}
            </Alert>
          ) : null}

          <DescriptionList items={facts} columns={2} dividers />

          {!alarm.acknowledgedAt ? (
            <section>
              <SectionHeading
                title="Acknowledge"
                hint="Record what was actually found. The first response is the one the record turns on, and it cannot be re-recorded."
              />
              <Card>
                <CardBody className="space-y-2">
                  <Field label="What was found" required>
                    <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
                  </Field>
                  <Button
                    size="sm"
                    disabled={note.trim() === ""}
                    loading={mutation.busy === "ack"}
                    onClick={() =>
                      void mutation.run("ack", "This alarm could not be acknowledged", () =>
                        api.post(
                          `/api/v1/projects/${projectId}/safety/sensor-events/${alarm.id}/acknowledge`,
                          { note: note.trim() },
                        ),
                      )
                    }
                  >
                    Record the response
                  </Button>
                </CardBody>
              </Card>
            </section>
          ) : null}

          {!alarm.resolvedAt ? (
            <section>
              <SectionHeading title="Resolve" />
              <Card>
                <CardBody className="space-y-2">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Field label="Outcome">
                      <Select
                        value={resolveStatus}
                        onChange={(e) => setResolveStatus(e.target.value)}
                      >
                        <option value="resolved">Resolved</option>
                        <option value="false_alarm">False alarm</option>
                        <option value="auto_resolved">The device cancelled itself</option>
                        <option value="escalated">Escalated</option>
                      </Select>
                    </Field>
                    <Field label="What happened" required>
                      <Input value={outcome} onChange={(e) => setOutcome(e.target.value)} />
                    </Field>
                  </div>
                  {resolveStatus === "false_alarm" && alarm.isLifeSafety && !alarm.acknowledgedAt ? (
                    <Alert tone="warning" size="sm" title="Somebody has to look first">
                      Marking a life-safety alarm a false alarm without anybody having gone to look is
                      a determination about a person's condition made from a screen. The platform
                      refuses it.
                    </Alert>
                  ) : null}
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={outcome.trim() === ""}
                    loading={mutation.busy === "resolve"}
                    onClick={() =>
                      void mutation.run("resolve", "This alarm could not be resolved", () =>
                        api.post(
                          `/api/v1/projects/${projectId}/safety/sensor-events/${alarm.id}/resolve`,
                          { status: resolveStatus, outcome: outcome.trim() },
                        ),
                      )
                    }
                  >
                    Close the alarm
                  </Button>
                </CardBody>
              </Card>
            </section>
          ) : null}

          <section>
            <SectionHeading
              title="Raise an observation"
              hint="Conversion is explicit and recorded once. A site whose alarms all become incidents is over-converting; one where none do is ignoring its devices."
            />
            {alarm.observationId ? (
              <Alert tone="success" size="sm" title="An observation was raised from this alarm">
                {alarm.observationId}
              </Alert>
            ) : (
              <Card>
                <CardBody className="space-y-2">
                  <Field label="Observation title">
                    <Input
                      value={observationTitle}
                      placeholder="Lone working in the basement with no check-in"
                      onChange={(e) => setObservationTitle(e.target.value)}
                    />
                  </Field>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={observationTitle.trim() === ""}
                    loading={mutation.busy === "observe"}
                    onClick={() =>
                      void mutation.run("observe", "That observation could not be raised", () =>
                        api.post(
                          `/api/v1/projects/${projectId}/safety/sensor-events/${alarm.id}/raise-observation`,
                          { title: observationTitle.trim() },
                        ),
                      )
                    }
                  >
                    Raise it
                  </Button>
                </CardBody>
              </Card>
            )}
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}

/* ========================================================================== */
/* Manual entry                                                                */
/* ========================================================================== */

function ManualAlarmModal({
  projectId,
  open,
  onClose,
  onCreated,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const mutation = useMutation(() => undefined);
  const [kind, setKind] = useState("check_in_missed");
  const [source, setSource] = useState("manual");
  const [deviceId, setDeviceId] = useState("");
  const [occurredAt, setOccurredAt] = useState(nowLocalInput());
  const [reportedPersonName, setReportedPersonName] = useState("");
  const [locationText, setLocationText] = useState("");

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record a device alarm"
      size="md"
      footer={
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={mutation.busy !== null}
            onClick={() =>
              void mutation.run("create", "That alarm could not be recorded", async () => {
                await api.post(`/api/v1/projects/${projectId}/safety/sensor-events`, {
                  kind,
                  source,
                  ...(deviceId.trim() ? { deviceId: deviceId.trim() } : {}),
                  occurredAt: new Date(occurredAt).toISOString(),
                  ...(reportedPersonName.trim()
                    ? { reportedPersonName: reportedPersonName.trim() }
                    : {}),
                  ...(locationText.trim() ? { locationText: locationText.trim() } : {}),
                });
                onCreated();
              })
            }
          >
            Record it
          </Button>
        </div>
      }
    >
      {mutation.refusal ? (
        <div className="mb-3">
          <RefusalNotice refusal={mutation.refusal} onDismiss={mutation.clear} />
        </div>
      ) : null}
      {mutation.error ? (
        <div className="mb-3">
          <Alert tone="danger" title="That could not be saved" onDismiss={mutation.clear}>
            {mutation.error}
          </Alert>
        </div>
      ) : null}
      <div className="space-y-3">
        <Alert tone="info" title="Devices normally post these themselves">
          The ingest endpoint is machine-friendly and idempotent on the device's own event id, so a
          fleet that retries does not double-count. This form exists for the alarm somebody reports
          by radio, and for testing the response clock before a fleet is connected.
        </Alert>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Alarm class" required>
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {labelize(k)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Source">
            <Select value={source} onChange={(e) => setSource(e.target.value)}>
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {labelize(s)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Device id">
            <Input value={deviceId} onChange={(e) => setDeviceId(e.target.value)} />
          </Field>
          <Field label="When it occurred" required>
            <Input
              type="datetime-local"
              value={occurredAt}
              onChange={(e) => setOccurredAt(e.target.value)}
            />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Person the device reported">
            <Input
              value={reportedPersonName}
              onChange={(e) => setReportedPersonName(e.target.value)}
            />
          </Field>
          <Field label="Location">
            <Input value={locationText} onChange={(e) => setLocationText(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
