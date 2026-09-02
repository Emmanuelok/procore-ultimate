/**
 * SERIES — the recurring meetings a contract usually requires.
 *
 * A series is the template plus the recurrence: the standing agenda, the
 * standing invitees, the quorum every occurrence inherits, and the rule that
 * generates the next dates. Generating occurrences one at a time in date order
 * is what makes the carry chain real — three weeks generated at once produces
 * exactly the chain three weeks of clicking would have.
 *
 * Closing a series is deliberately loud about what it leaves behind: the API
 * counts the open actions still hanging off it and returns the number, because
 * a series closed over the top of eleven open promises is how a project loses
 * the thread of what it agreed.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  DataTable,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Textarea,
  Tooltip,
  useConfirm,
  type DataColumns,
} from "../../ui";
import { IconMeeting, IconPlus } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  LoadError,
  MEETING_TYPES,
  RECURRENCES,
  RefusalPanel,
  SERIES_STATUS_TONE,
  count,
  dateTime,
  titleCase,
  useAction,
  type GenerateResult,
  type Loadable,
  type MeetingSeries,
  type Paginated,
} from "./meetingsShared";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default function SeriesTab({
  projectId,
  series,
  onChanged,
  onOpenSeries,
  onOpenOccurrences,
}: {
  projectId: string;
  series: Loadable<Paginated<MeetingSeries>>;
  onChanged: () => void;
  onOpenSeries: (seriesId: string) => void;
  onOpenOccurrences: (seriesId: string) => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const { confirm, dialog } = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const [generated, setGenerated] = useState<GenerateResult | null>(null);

  const rows = series.data?.items ?? [];

  async function generate(row: MeetingSeries) {
    const ok = await confirm({
      title: `Generate the next occurrences of ${row.reference}?`,
      description:
        "Occurrences are created one at a time in date order, and each one carries forward from the one before it. Standing agenda items land first, carried items beneath them, and standing invitees start as ABSENT — nobody has attended a meeting that has not happened.",
      confirmLabel: "Generate 4 occurrences",
    });
    if (!ok) return;
    const outcome = await run(`generate:${row.id}`, () =>
      api.post<GenerateResult>(
        `/api/v1/projects/${projectId}/meeting-series/${row.id}/generate-occurrences`,
        { count: 4 },
      ),
    );
    if (outcome) {
      setGenerated(outcome);
      onChanged();
    }
  }

  async function close(row: MeetingSeries) {
    const ok = await confirm({
      title: `Close ${row.reference}?`,
      description:
        "A closed series stops generating occurrences; everything it has already produced stays readable. Any action item still open against it is left behind — the platform will tell you how many, and they do not close themselves.",
      confirmLabel: "Close the series",
      destructive: true,
    });
    if (!ok) return;
    const done = await run(`close:${row.id}`, () =>
      api.post(`/api/v1/projects/${projectId}/meeting-series/${row.id}/close`, {}),
    );
    if (done !== null) onChanged();
  }

  const columns = useMemo<DataColumns<MeetingSeries>>(
    () => [
      {
        id: "reference",
        header: "Series",
        accessor: "reference",
        type: "code",
        sticky: "start",
        width: 110,
        mono: true,
      },
      { id: "title", header: "Title", accessor: "title", type: "text", width: 260 },
      {
        id: "meetingType",
        header: "Type",
        accessor: "meetingType",
        type: "enum",
        width: 190,
        groupable: true,
        options: MEETING_TYPES.map((t) => ({ value: t, text: titleCase(t), label: titleCase(t) })),
        cell: ({ row }) => (
          <Badge tone="neutral" size="xs" variant="outline">
            {titleCase(row.meetingType)}
          </Badge>
        ),
      },
      {
        id: "recurrence",
        header: "Recurs",
        accessor: "recurrence",
        type: "enum",
        width: 170,
        groupable: true,
        cell: ({ row }) => (
          <span className="text-meta">
            {titleCase(row.recurrence)}
            {row.dayOfWeek !== null ? ` · ${DAYS[row.dayOfWeek] ?? ""}` : ""}
            {row.startTime ? ` · ${row.startTime}` : ""}
          </span>
        ),
      },
      {
        id: "template",
        header: "Standing template",
        headerTooltip:
          "The agenda items and invitees every generated occurrence starts with. Invitees start as ABSENT — nobody has attended a meeting that has not happened.",
        accessor: (row) => row.agendaTemplate.length,
        type: "number",
        align: "right",
        width: 160,
        aggregate: "none",
        cell: ({ row }) => (
          <span className="text-meta tabular-nums">
            {count(row.agendaTemplate.length)} item
            {row.agendaTemplate.length === 1 ? "" : "s"} · {count(row.defaultAttendees.length)}{" "}
            invitee{row.defaultAttendees.length === 1 ? "" : "s"}
          </span>
        ),
      },
      {
        id: "occurrenceCount",
        header: "Occurrences",
        accessor: "occurrenceCount",
        type: "number",
        align: "right",
        width: 120,
        aggregate: "sum",
      },
      {
        id: "nextOccurrenceAt",
        header: "Next",
        accessor: (row) => row.nextOccurrenceAt ?? "",
        type: "text",
        width: 190,
        cell: ({ row }) =>
          row.nextOccurrenceAt ? (
            dateTime(row.nextOccurrenceAt)
          ) : (
            <Tooltip content="No occurrence is scheduled ahead of now. Generating a batch into the past does not make it upcoming — the API only advertises a future date here.">
              <span className="italic text-content-subtle">none scheduled</span>
            </Tooltip>
          ),
      },
      {
        id: "contractRequirement",
        header: "Contract basis",
        accessor: (row) => row.contractRequirement ?? "",
        type: "text",
        width: 220,
        cell: ({ row }) =>
          row.contractRequirement ?? (
            <span className="italic text-content-subtle">not recorded</span>
          ),
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 110,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone={SERIES_STATUS_TONE[row.status] ?? "neutral"} size="xs" dot>
            {titleCase(row.status)}
          </Badge>
        ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      {dialog}
      <RefusalPanel refusal={refusal} onDismiss={clear} />
      {series.error ? (
        <LoadError
          message={series.error}
          onRetry={series.reload}
          title="The meeting series could not be loaded"
        />
      ) : null}

      {generated ? (
        <Card>
          <CardBody className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-content">
                {count(generated.count)} occurrence{generated.count === 1 ? "" : "s"} generated
              </p>
              <Button size="xs" variant="ghost" onClick={() => setGenerated(null)}>
                Dismiss
              </Button>
            </div>
            <ul className="space-y-1">
              {generated.created.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-2 text-meta">
                  <span className="font-mono text-content">{m.reference}</span>
                  <span className="text-content-muted">{m.title}</span>
                  <span className="text-content-subtle">{dateTime(m.scheduledStart)}</span>
                  {m.carriedForward.carried > 0 ? (
                    <Badge tone="warning" size="xs">
                      {count(m.carriedForward.carried)} item
                      {m.carriedForward.carried === 1 ? "" : "s"} carried in
                    </Badge>
                  ) : null}
                  {m.carriedForward.actionsCarried > 0 ? (
                    <Badge tone="neutral" size="xs">
                      {count(m.carriedForward.actionsCarried)} action
                      {m.carriedForward.actionsCarried === 1 ? "" : "s"} re-tabled
                    </Badge>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="text-2xs text-content-subtle">
              Open actions hanging off a carried item are not duplicated — two open rows for one
              promise is how an action gets closed twice and done never. What moves is the count:
              "this action has now been discussed at four meetings".
            </p>
          </CardBody>
        </Card>
      ) : null}

      {!series.loading && rows.length === 0 ? (
        <EmptyState
          icon={IconMeeting}
          title="No meeting series on this project"
          hint="A series is the recurring meeting a contract usually requires: the standing agenda, the standing invitees, the quorum, and the rule that produces the next date. Without one, occurrences are one-offs and nothing carries forward between them — which is precisely how an unresolved item disappears."
          action={
            <Button icon={IconPlus} onClick={() => setCreateOpen(true)}>
              Create a series
            </Button>
          }
        />
      ) : (
        <DataTable<MeetingSeries>
          tableId="meeting-series"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          loading={series.loading}
          height={480}
          stickyHeader
          gridLines
          filterRow
          savedViews
          exportFileName="meeting-series"
          searchPlaceholder="Search series…"
          defaultSort={[{ id: "reference", desc: false }]}
          rowTone={(row) => (row.status === "closed" ? "neutral" : undefined)}
          onRowClick={({ row }) => onOpenSeries(row.id)}
          rowActions={(row) => [
            {
              id: "occurrences",
              label: "Show its occurrences",
              onSelect: () => onOpenOccurrences(row.id),
            },
            {
              id: "carry",
              label: "Carry-forward report",
              onSelect: () => onOpenSeries(row.id),
            },
            {
              id: "generate",
              label: "Generate the next 4 occurrences",
              disabled: row.status !== "active" || busy !== null,
              onSelect: () => void generate(row),
            },
            {
              id: "close",
              label: "Close the series",
              destructive: true,
              disabled: row.status === "closed",
              onSelect: () => void close(row),
            },
          ]}
          toolbarActions={
            <Button size="sm" icon={IconPlus} onClick={() => setCreateOpen(true)}>
              New series
            </Button>
          }
          empty={{
            title: "No series",
            description: "Create one to start generating occurrences.",
          }}
          emptyFiltered={{
            title: "No series matches these filters",
            description: "Clear the type or status filter.",
          }}
          aria-label="Meeting series"
        />
      )}

      <CreateSeriesModal
        open={createOpen}
        projectId={projectId}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          onChanged();
        }}
      />
    </div>
  );
}

interface SeriesForm {
  title: string;
  description: string;
  meetingType: string;
  recurrence: string;
  dayOfWeek: string;
  startTime: string;
  durationMinutes: string;
  timezone: string;
  defaultLocation: string;
  quorumRequired: string;
  contractRequirement: string;
}

const EMPTY_SERIES: SeriesForm = {
  title: "",
  description: "",
  meetingType: "progress",
  recurrence: "weekly",
  dayOfWeek: "1",
  startTime: "09:00",
  durationMinutes: "60",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  defaultLocation: "",
  quorumRequired: "",
  contractRequirement: "",
};

function CreateSeriesModal({
  open,
  projectId,
  onClose,
  onCreated,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [form, setForm] = useState<SeriesForm>(EMPTY_SERIES);

  async function submit() {
    const quorum = form.quorumRequired.trim() === "" ? null : Number(form.quorumRequired);
    const duration = form.durationMinutes.trim() === "" ? null : Number(form.durationMinutes);
    const day = form.dayOfWeek === "" ? null : Number(form.dayOfWeek);
    const done = await run("create", () =>
      api.post(`/api/v1/projects/${projectId}/meeting-series`, {
        title: form.title.trim(),
        description: form.description.trim() || null,
        meetingType: form.meetingType,
        recurrence: form.recurrence,
        dayOfWeek: day !== null && Number.isFinite(day) ? day : null,
        startTime: form.startTime || null,
        durationMinutes: duration !== null && Number.isFinite(duration) ? duration : null,
        timezone: form.timezone || null,
        defaultLocation: form.defaultLocation.trim() || null,
        quorumRequired: quorum !== null && Number.isFinite(quorum) ? quorum : null,
        contractRequirement: form.contractRequirement.trim() || null,
      }),
    );
    if (done !== null) {
      setForm(EMPTY_SERIES);
      onCreated();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create a meeting series"
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={form.title.trim().length === 0 || busy !== null}
            loading={busy === "create"}
            onClick={() => void submit()}
          >
            Create the series
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {refusal ? (
          <Alert tone="danger" size="sm" title="The series was refused" onDismiss={clear}>
            <p className="whitespace-pre-wrap">{refusal.message}</p>
          </Alert>
        ) : null}
        <Alert tone="info" variant="subtle" size="sm" title="An unsupported rule is refused, not approximated">
          A recurrence this platform cannot compute exactly is rejected outright. Silently
          downgrading "every Monday, Wednesday and Friday" to "every Monday" would put two-thirds of
          a project's progress meetings on dates nobody agreed to, and nothing downstream would
          notice.
        </Alert>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Title" required className="sm:col-span-2">
            <Input
              value={form.title}
              placeholder="Weekly progress meeting"
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </Field>
          <Field label="Meeting type">
            <Select
              value={form.meetingType}
              onChange={(e) => setForm({ ...form, meetingType: e.target.value })}
            >
              {MEETING_TYPES.map((t) => (
                <option key={t} value={t}>
                  {titleCase(t)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Recurrence">
            <Select
              value={form.recurrence}
              onChange={(e) => setForm({ ...form, recurrence: e.target.value })}
            >
              {RECURRENCES.filter((r) => r !== "custom").map((r) => (
                <option key={r} value={r}>
                  {titleCase(r)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Day of week">
            <Select
              value={form.dayOfWeek}
              onChange={(e) => setForm({ ...form, dayOfWeek: e.target.value })}
            >
              <option value="">Not fixed</option>
              {DAYS.map((d, i) => (
                <option key={d} value={String(i)}>
                  {d}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Start time" hint="Local to the timezone below.">
            <Input
              type="time"
              value={form.startTime}
              onChange={(e) => setForm({ ...form, startTime: e.target.value })}
            />
          </Field>
          <Field label="Duration (minutes)">
            <Input
              type="number"
              min={5}
              value={form.durationMinutes}
              onChange={(e) => setForm({ ...form, durationMinutes: e.target.value })}
            />
          </Field>
          <Field label="Timezone" hint="An unknown zone falls back to UTC rather than blocking you.">
            <Input
              value={form.timezone}
              onChange={(e) => setForm({ ...form, timezone: e.target.value })}
            />
          </Field>
          <Field label="Default location">
            <Input
              value={form.defaultLocation}
              onChange={(e) => setForm({ ...form, defaultLocation: e.target.value })}
            />
          </Field>
          <Field
            label="Quorum required"
            hint="Leave blank and the platform reports 'not asserted' rather than pretending a quorum was met."
          >
            <Input
              type="number"
              min={1}
              value={form.quorumRequired}
              onChange={(e) => setForm({ ...form, quorumRequired: e.target.value })}
            />
          </Field>
        </div>
        <Field
          label="Contract basis"
          hint="The clause that requires this meeting to be held, if there is one."
        >
          <Input
            value={form.contractRequirement}
            placeholder="Clause 3.4 — monthly progress meeting"
            onChange={(e) => setForm({ ...form, contractRequirement: e.target.value })}
          />
        </Field>
        <Field label="Description">
          <Textarea
            rows={2}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </Field>
      </div>
    </Modal>
  );
}
