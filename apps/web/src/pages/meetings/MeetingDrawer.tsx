/**
 * ONE OCCURRENCE, in a drawer.
 *
 *   Agenda     with the carry chain made visible — an item's carry count is
 *              printed on the row, escalating, because five weeks of "ongoing"
 *              should be a number rather than a feeling.
 *   Attendance the roll, and the quorum it produces. Apologies are separate
 *              from absence: a party who sent apologies was still notified,
 *              which is what matters when a decision taken in their absence is
 *              challenged.
 *   Minutes    draft → issue → objection window → sign-off, with the window's
 *              own arithmetic and the segregation rules stated before they
 *              fire.
 *   Decisions  each with its cost and schedule impact as honest figures, and
 *              whether the quorum was met when it was taken.
 *   Actions    the point of the whole thing.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  Checkbox,
  DescriptionList,
  Drawer,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Skeleton,
  Tabs,
  Textarea,
  Tooltip,
  UserPicker,
  useConfirm,
  type DescriptionItem,
  type UserOption,
} from "../../ui";
import { cx } from "../../ui/cx";
import { IconHistory, IconMeeting, IconPlus, IconUsers } from "../../ui/icons";
import { api } from "../../lib/api";
import { MinutesDocumentPanel, ObjectionsPanel } from "./MinutesPanels";
import { MeetingEditor, useCompanyUsers } from "./SeriesEditor";
import ActionItemCard from "./ActionItemCard";
import {
  ACTION_PRIORITIES,
  AGENDA_STATUSES,
  AGENDA_STATUS_TONE,
  ATTENDANCE_STATES,
  ATTENDANCE_TONE,
  CARRY_THRESHOLD,
  CarryBadge,
  DECISION_STATUS_TONE,
  DecisionImpacts,
  EM_DASH,
  ITEM_CATEGORIES,
  MEETING_STATUS_TONE,
  ObjectionWindow,
  QuorumSummary,
  RefusalPanel,
  count,
  dateTime,
  isoDate,
  titleCase,
  useAction,
  useMeetingDetail,
  type AgendaItem,
  type Attendee,
  type CarryForwardResult,
  type Decision,
  type MeetingDetail,
} from "./meetingsShared";

type Panel = "agenda" | "attendance" | "minutes" | "decisions" | "actions";

export default function MeetingDrawer({
  projectId,
  meetingId,
  version,
  onClose,
  onMutated,
}: {
  projectId: string;
  meetingId: string | null;
  version: number;
  onClose: () => void;
  onMutated: () => void;
}) {
  const [panel, setPanel] = useState<Panel>("agenda");
  const detail = useMeetingDetail(projectId, meetingId, version);
  const { busy, refusal, clear, run } = useAction();
  const { confirm, dialog } = useConfirm();
  const [carryResult, setCarryResult] = useState<CarryForwardResult | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  const meeting = detail.data;

  function reload() {
    detail.reload();
    onMutated();
  }

  async function hold() {
    if (!meeting) return;
    const ok = await confirm({
      title: `Hold ${meeting.reference}?`,
      description:
        "This stamps the actual start and settles the quorum from the attendance recorded right now. Mark who was actually in the room first — the quorum flag is computed from the roll, not from the invitation list.",
      confirmLabel: "Hold the meeting",
    });
    if (!ok) return;
    const done = await run("hold", () =>
      api.post(`/api/v1/projects/${projectId}/meetings/${meeting.id}/hold`, {}),
    );
    if (done !== null) reload();
  }

  async function carryForward() {
    if (!meeting) return;
    const outcome = await run("carry", () =>
      api.post<CarryForwardResult>(
        `/api/v1/projects/${projectId}/meetings/${meeting.id}/carry-forward`,
        {},
      ),
    );
    if (outcome) {
      setCarryResult(outcome);
      reload();
    }
  }

  const overCarried = (meeting?.agendaItems ?? []).filter(
    (i) => i.carryCount >= CARRY_THRESHOLD && i.status !== "closed",
  );

  const tabs = useMemo(
    () => [
      {
        value: "agenda" as const,
        label: "Agenda",
        count: meeting?.agendaItems.length,
        ...(overCarried.length > 0 ? { tone: "danger" as const } : {}),
      },
      { value: "attendance" as const, label: "Attendance", count: meeting?.attendees.length },
      { value: "minutes" as const, label: "Minutes" },
      { value: "decisions" as const, label: "Decisions", count: meeting?.decisions.length },
      {
        value: "actions" as const,
        label: "Actions",
        count: meeting?.actionItems.length,
        ...(meeting && meeting.openActionItemCount > 0 ? { tone: "warning" as const } : {}),
      },
    ],
    [meeting, overCarried.length],
  );

  return (
    <Drawer
      open={meetingId !== null}
      onClose={onClose}
      size="xl"
      title={
        meeting ? (
          <span className="flex items-center gap-2">
            <span className="font-mono">{meeting.reference}</span>
            <span className="truncate">{meeting.title}</span>
          </span>
        ) : (
          "Meeting"
        )
      }
      description={
        meeting
          ? `${titleCase(meeting.meetingType)} · ${dateTime(meeting.scheduledStart)}${
              meeting.location ? ` · ${meeting.location}` : ""
            }`
          : undefined
      }
      headerActions={
        meeting ? (
          <div className="flex items-center gap-2">
            <Badge tone={MEETING_STATUS_TONE[meeting.status] ?? "neutral"} dot>
              {titleCase(meeting.status)}
            </Badge>
            {meeting.status !== "cancelled" ? (
              <Button size="xs" variant="ghost" onClick={() => setEditOpen(true)}>
                Edit
              </Button>
            ) : null}
          </div>
        ) : null
      }
    >
      {dialog}
      {meeting && editOpen ? (
        <MeetingEditor
          projectId={projectId}
          meeting={meeting}
          open={editOpen}
          onClose={() => setEditOpen(false)}
          onSaved={() => {
            setEditOpen(false);
            reload();
          }}
        />
      ) : null}
      {detail.loading && !meeting ? (
        <div className="space-y-3 py-4">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : detail.error ? (
        <Alert tone="danger" title="This meeting could not be loaded">
          {detail.error}
        </Alert>
      ) : meeting ? (
        <div className="space-y-4">
          <RefusalPanel refusal={refusal} onDismiss={clear} />

          {meeting.status === "cancelled" ? (
            <Alert tone="neutral" title="This meeting was cancelled">
              {meeting.cancelledReason ?? "No reason was recorded."}
            </Alert>
          ) : null}

          {overCarried.length > 0 ? (
            <Alert
              tone="danger"
              icon={IconHistory}
              title={`${count(overCarried.length)} item${overCarried.length === 1 ? " has" : "s have"} been carried ${CARRY_THRESHOLD} times or more`}
            >
              An item that survives this many occurrences is not an agenda item, it is an undecided
              question. Give each one an owner and a date, escalate it, or record the decision not to
              decide it — carrying it again is the one option that changes nothing.
            </Alert>
          ) : null}

          <QuorumSummary quorum={meeting.quorum} />

          <Card>
            <CardBody>
              <DescriptionList columns={3} size="sm" items={overviewItems(meeting)} />
            </CardBody>
          </Card>

          <div className="flex flex-wrap gap-2">
            {meeting.status === "scheduled" || meeting.status === "in_progress" ? (
              <Button size="sm" loading={busy === "hold"} onClick={() => void hold()}>
                Hold the meeting
              </Button>
            ) : null}
            {meeting.previousMeetingId ? (
              <Button
                size="sm"
                variant="secondary"
                loading={busy === "carry"}
                onClick={() => void carryForward()}
              >
                Carry forward from the previous occurrence
              </Button>
            ) : null}
          </div>

          {carryResult ? (
            <Alert
              tone="info"
              size="sm"
              title={`${count(carryResult.carried)} item${carryResult.carried === 1 ? "" : "s"} carried in, ${count(carryResult.skipped)} skipped`}
              onDismiss={() => setCarryResult(null)}
            >
              Skipped items were already closed, noted, or had already been carried — the carry is
              idempotent, so pressing it twice can never double an item or double a count.{" "}
              {carryResult.actionsCarried > 0
                ? `${count(carryResult.actionsCarried)} open action${carryResult.actionsCarried === 1 ? " had its" : "s had their"} discussion count incremented rather than being duplicated.`
                : ""}
            </Alert>
          ) : null}

          <Tabs items={tabs} value={panel} onChange={setPanel} size="sm" />

          {panel === "agenda" ? (
            <AgendaPanel projectId={projectId} meeting={meeting} onMutated={reload} />
          ) : panel === "attendance" ? (
            <AttendancePanel projectId={projectId} meeting={meeting} onMutated={reload} />
          ) : panel === "minutes" ? (
            <MinutesPanel projectId={projectId} meeting={meeting} onMutated={reload} />
          ) : panel === "decisions" ? (
            <DecisionsPanel projectId={projectId} meeting={meeting} onMutated={reload} />
          ) : (
            <ActionsPanel projectId={projectId} meeting={meeting} onMutated={reload} />
          )}
        </div>
      ) : null}
    </Drawer>
  );
}

function overviewItems(meeting: MeetingDetail): DescriptionItem[] {
  return [
    {
      id: "occurrence",
      label: "Occurrence",
      value:
        meeting.occurrenceNumber !== null ? `No. ${meeting.occurrenceNumber}` : "One-off meeting",
      hint:
        meeting.previousMeetingId === null
          ? "No previous occurrence, so nothing carries into this one."
          : "Unclosed items from the previous occurrence carry into this one.",
    },
    { id: "scheduled", label: "Scheduled", value: dateTime(meeting.scheduledStart) },
    {
      id: "actual",
      label: "Actually held",
      value: meeting.actualStart ? dateTime(meeting.actualStart) : EM_DASH,
    },
    {
      id: "carriedIn",
      label: "Items carried in",
      value: count(meeting.carryForward.carriedIn),
      hint:
        meeting.carryForward.maxCarryCount > 0
          ? `The most-carried item on this agenda has been carried ${meeting.carryForward.maxCarryCount} times.`
          : "Nothing on this agenda has been carried from an earlier occurrence.",
    },
    {
      id: "actions",
      label: "Actions",
      value: `${count(meeting.openActionItemCount)} open of ${count(meeting.actionItemCount)}`,
    },
    {
      id: "distribution",
      label: "Distribution",
      value:
        meeting.distribution.length > 0
          ? `${count(meeting.distribution.length)} recipients`
          : "nobody listed",
      hint:
        meeting.distribution.length === 0
          ? "Issuing minutes will notify nobody until a distribution list is recorded."
          : undefined,
    },
  ];
}

/* ================================================================== */
/* Agenda                                                              */
/* ================================================================== */

function AgendaPanel({
  projectId,
  meeting,
  onMutated,
}: {
  projectId: string;
  meeting: MeetingDetail;
  onMutated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [addOpen, setAddOpen] = useState(false);
  const [closing, setClosing] = useState<AgendaItem | null>(null);
  const [discussion, setDiscussion] = useState("");

  async function close() {
    if (!closing) return;
    const done = await run(`close:${closing.id}`, () =>
      api.post(`/api/v1/projects/${projectId}/meeting-agenda-items/${closing.id}/close`, {
        discussion: discussion.trim() || undefined,
      }),
    );
    if (done !== null) {
      setClosing(null);
      setDiscussion("");
      onMutated();
    }
  }

  async function setStatus(item: AgendaItem, status: string) {
    const done = await run(`status:${item.id}`, () =>
      api.patch(`/api/v1/projects/${projectId}/meeting-agenda-items/${item.id}`, { status }),
    );
    if (done !== null) onMutated();
  }

  const items = meeting.agendaItems;

  return (
    <div className="space-y-3">
      <RefusalPanel refusal={refusal} onDismiss={clear} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-meta text-content-muted">
          {count(items.length)} item{items.length === 1 ? "" : "s"} ·{" "}
          {count(items.filter((i) => i.carryCount > 0).length)} carried in from an earlier
          occurrence
        </p>
        <Button size="xs" variant="secondary" icon={IconPlus} onClick={() => setAddOpen(true)}>
          Add an item
        </Button>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={IconMeeting}
          size="sm"
          title="This meeting has no agenda"
          hint="Nothing has been tabled and nothing has carried in from a previous occurrence. A meeting with no agenda produces no decisions and no actions, and there is nothing for the next occurrence to inherit."
        />
      ) : (
        <ul className="space-y-2">
          {items.map((item) => {
            const over = item.carryCount >= CARRY_THRESHOLD && item.status !== "closed";
            return (
              <li
                key={item.id}
                className={cx(
                  "rounded-lg border p-3",
                  over
                    ? "border-danger-border bg-danger-subtle/40"
                    : item.carryCount > 0
                      ? "border-warning-border bg-warning-subtle/30"
                      : "border-border bg-surface-raised",
                )}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      {item.itemNumber ? (
                        <span className="font-mono text-2xs text-content-subtle">
                          {item.itemNumber}
                        </span>
                      ) : null}
                      <span className="text-sm font-semibold text-content">{item.title}</span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <Badge tone={AGENDA_STATUS_TONE[item.status] ?? "neutral"} size="xs" dot>
                        {titleCase(item.status)}
                      </Badge>
                      <Badge tone="neutral" size="xs" variant="outline">
                        {titleCase(item.category)}
                      </Badge>
                      <CarryBadge carryCount={item.carryCount} />
                      {item.allocatedMinutes !== null ? (
                        <span className="text-2xs text-content-subtle">
                          {item.allocatedMinutes} min allocated
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {item.carriedForwardToItemId ? (
                      <Tooltip content="This row has already been carried into a later occurrence. Edit the item on that occurrence — it is the live one.">
                        <span>
                          <Badge tone="neutral" size="xs">
                            Carried onward
                          </Badge>
                        </span>
                      </Tooltip>
                    ) : item.status === "closed" ? (
                      <Badge tone="success" size="xs">
                        Closed {isoDate(item.closedAt)}
                      </Badge>
                    ) : (
                      <>
                        <Select
                          size="sm"
                          value={item.status}
                          disabled={busy !== null}
                          onChange={(e) => void setStatus(item, e.target.value)}
                          aria-label={`Status of ${item.title}`}
                        >
                          {AGENDA_STATUSES.filter((s) => s !== "carried_forward").map((s) => (
                            <option key={s} value={s}>
                              {titleCase(s)}
                            </option>
                          ))}
                        </Select>
                        <Button
                          size="xs"
                          variant="secondary"
                          onClick={() => {
                            setClosing(item);
                            setDiscussion(item.discussion ?? "");
                          }}
                        >
                          Close
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                {item.description ? (
                  <p className="mt-2 text-meta text-content-muted">{item.description}</p>
                ) : null}
                {item.discussion ? (
                  <p className="mt-2 whitespace-pre-wrap text-meta text-content">
                    {item.discussion}
                  </p>
                ) : null}
                {item.carryCount > 0 ? (
                  <p className="mt-2 text-2xs text-content-subtle">
                    First raised at meeting{" "}
                    <span className="font-mono">{item.firstRaisedMeetingId ?? "unknown"}</span> and
                    open ever since. The chain preserves where it started, so "this has been on the
                    agenda since March" is a query rather than a memory.
                  </p>
                ) : null}
                {over ? (
                  <p className="mt-1.5 text-2xs font-medium text-danger-fg">
                    Carried {item.carryCount} times. A signal has been raised against the root item —
                    a count nobody can query shames nobody, which is why this one is queryable.
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <Modal
        open={closing !== null}
        onClose={() => setClosing(null)}
        title={closing ? `Close "${closing.title}"` : "Close item"}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setClosing(null)}>
              Cancel
            </Button>
            <Button disabled={busy !== null} onClick={() => void close()}>
              Close the item
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <p className="text-meta text-content-muted">
            A closed item does not carry into the next occurrence. If the matter is not actually
            settled, leave it open and let it carry — the carry count is the honest record of a
            project that has not decided.
          </p>
          <Field label="What was discussed / decided?">
            <Textarea
              rows={4}
              value={discussion}
              onChange={(e) => setDiscussion(e.target.value)}
              autoFocus
            />
          </Field>
        </div>
      </Modal>

      <AddAgendaItemModal
        open={addOpen}
        projectId={projectId}
        meetingId={meeting.id}
        onClose={() => setAddOpen(false)}
        onCreated={() => {
          setAddOpen(false);
          onMutated();
        }}
      />
    </div>
  );
}

function AddAgendaItemModal({
  open,
  projectId,
  meetingId,
  onClose,
  onCreated,
}: {
  open: boolean;
  projectId: string;
  meetingId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("other");
  const [description, setDescription] = useState("");
  const [allocatedMinutes, setAllocatedMinutes] = useState("");

  async function submit() {
    const minutes = allocatedMinutes.trim() === "" ? null : Number(allocatedMinutes);
    const done = await run("create", () =>
      api.post(`/api/v1/projects/${projectId}/meetings/${meetingId}/agenda-items`, {
        title: title.trim(),
        category,
        description: description.trim() || null,
        allocatedMinutes: minutes !== null && Number.isFinite(minutes) ? minutes : null,
      }),
    );
    if (done !== null) {
      setTitle("");
      setDescription("");
      setAllocatedMinutes("");
      onCreated();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add an agenda item"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={title.trim().length === 0 || busy !== null}
            loading={busy === "create"}
            onClick={() => void submit()}
          >
            Add it
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {refusal ? (
          <Alert tone="danger" size="sm" title="Refused" onDismiss={clear}>
            <p className="whitespace-pre-wrap">{refusal.message}</p>
          </Alert>
        ) : null}
        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Category">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {ITEM_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {titleCase(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Minutes allocated">
            <Input
              type="number"
              min={0}
              value={allocatedMinutes}
              onChange={(e) => setAllocatedMinutes(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Description">
          <Textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* Attendance                                                          */
/* ================================================================== */

function AttendancePanel({
  projectId,
  meeting,
  onMutated,
}: {
  projectId: string;
  meeting: MeetingDetail;
  onMutated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [addOpen, setAddOpen] = useState(false);
  const [delegateFor, setDelegateFor] = useState<Attendee | null>(null);
  const [delegateName, setDelegateName] = useState("");

  async function setAttendance(attendee: Attendee, attendance: string) {
    if (attendance === "delegate_attended" && !attendee.delegateName) {
      setDelegateFor(attendee);
      setDelegateName("");
      return;
    }
    const done = await run(`att:${attendee.id}`, () =>
      api.patch(`/api/v1/projects/${projectId}/meeting-attendees/${attendee.id}`, { attendance }),
    );
    if (done !== null) onMutated();
  }

  async function saveDelegate() {
    if (!delegateFor || !delegateName.trim()) return;
    const done = await run(`att:${delegateFor.id}`, () =>
      api.patch(`/api/v1/projects/${projectId}/meeting-attendees/${delegateFor.id}`, {
        attendance: "delegate_attended",
        delegateName: delegateName.trim(),
      }),
    );
    if (done !== null) {
      setDelegateFor(null);
      setDelegateName("");
      onMutated();
    }
  }

  return (
    <div className="space-y-3">
      <RefusalPanel refusal={refusal} onDismiss={clear} />
      <QuorumSummary quorum={meeting.quorum} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-meta text-content-muted">
          Attendance drives the quorum, and the quorum is recomputed as you mark the roll — not when
          somebody remembers to press "hold" again.
        </p>
        <Button size="xs" variant="secondary" icon={IconPlus} onClick={() => setAddOpen(true)}>
          Add an attendee
        </Button>
      </div>

      {meeting.attendees.length === 0 ? (
        <EmptyState
          icon={IconUsers}
          size="sm"
          title="Nobody has been recorded for this meeting"
          hint="With no roll, the quorum cannot be checked and a decision taken here has no record of who was in the room to challenge it. Add the invitees — they start as absent, because nobody has attended a meeting that has not happened."
        />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {meeting.attendees.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 bg-surface-raised p-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-content">{a.name}</p>
                <p className="truncate text-2xs text-content-subtle">
                  {a.organisation ?? "no organisation"}
                  {a.jobTitle ? ` · ${a.jobTitle}` : ""} · {titleCase(a.role)}
                  {a.delegateName ? ` · delegate: ${a.delegateName}` : ""}
                </p>
              </div>
              <Badge tone={ATTENDANCE_TONE[a.attendance] ?? "neutral"} size="xs" dot>
                {titleCase(a.attendance)}
              </Badge>
              <Select
                size="sm"
                value={a.attendance}
                disabled={busy !== null}
                onChange={(e) => void setAttendance(a, e.target.value)}
                aria-label={`Attendance of ${a.name}`}
              >
                {ATTENDANCE_STATES.map((s) => (
                  <option key={s} value={s}>
                    {titleCase(s)}
                  </option>
                ))}
              </Select>
            </li>
          ))}
        </ul>
      )}

      <p className="text-2xs text-content-subtle">
        Apologies are held separately from absence on purpose: a party who sent apologies was still
        notified, and that is the fact that matters when a decision taken in their absence is
        challenged. Chairs, minute takers, observers and distribution-only invitees do not count
        towards the quorum.
      </p>

      <Modal
        open={delegateFor !== null}
        onClose={() => setDelegateFor(null)}
        title="Who attended instead?"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDelegateFor(null)}>
              Cancel
            </Button>
            <Button
              disabled={delegateName.trim().length === 0 || busy !== null}
              onClick={() => void saveDelegate()}
            >
              Record the delegate
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <p className="text-meta text-content-muted">
            "Someone came instead" is not a record of who was in the room. The API refuses a
            delegate attendance without a name, and so does this form.
          </p>
          <Field label={`Delegate for ${delegateFor?.name ?? ""}`} required>
            <Input
              value={delegateName}
              onChange={(e) => setDelegateName(e.target.value)}
              autoFocus
            />
          </Field>
        </div>
      </Modal>

      <AddAttendeeModal
        open={addOpen}
        projectId={projectId}
        meetingId={meeting.id}
        onClose={() => setAddOpen(false)}
        onCreated={() => {
          setAddOpen(false);
          onMutated();
        }}
      />
    </div>
  );
}

function AddAttendeeModal({
  open,
  projectId,
  meetingId,
  onClose,
  onCreated,
}: {
  open: boolean;
  projectId: string;
  meetingId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [name, setName] = useState("");
  const [organisation, setOrganisation] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [role, setRole] = useState("required");

  async function submit() {
    const done = await run("create", () =>
      api.post(`/api/v1/projects/${projectId}/meetings/${meetingId}/attendees`, {
        attendees: [
          {
            name: name.trim(),
            organisation: organisation.trim() || null,
            jobTitle: jobTitle.trim() || null,
            role,
          },
        ],
      }),
    );
    if (done !== null) {
      setName("");
      setOrganisation("");
      setJobTitle("");
      onCreated();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add an attendee"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={name.trim().length === 0 || busy !== null}
            loading={busy === "create"}
            onClick={() => void submit()}
          >
            Add
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {refusal ? (
          <Alert tone="danger" size="sm" title="Refused" onDismiss={clear}>
            <p className="whitespace-pre-wrap">{refusal.message}</p>
          </Alert>
        ) : null}
        <p className="text-meta text-content-muted">
          New attendees are recorded as <strong>absent</strong> until you mark them present.
        </p>
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Organisation">
            <Input value={organisation} onChange={(e) => setOrganisation(e.target.value)} />
          </Field>
          <Field label="Job title">
            <Input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} />
          </Field>
        </div>
        <Field
          label="Role"
          hint="Chairs, minute takers, observers and distribution-only invitees do not count towards a quorum."
        >
          <Select value={role} onChange={(e) => setRole(e.target.value)}>
            {["chair", "minute_taker", "required", "optional", "presenter", "observer", "distribution_only"].map(
              (r) => (
                <option key={r} value={r}>
                  {titleCase(r)}
                </option>
              ),
            )}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* Minutes                                                             */
/* ================================================================== */

function MinutesPanel({
  projectId,
  meeting,
  onMutated,
}: {
  projectId: string;
  meeting: MeetingDetail;
  onMutated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const { confirm, dialog } = useConfirm();
  const [body, setBody] = useState(meeting.minutesBody ?? "");
  const [objectionDays, setObjectionDays] = useState(
    meeting.objectionPeriodDays !== null ? String(meeting.objectionPeriodDays) : "7",
  );
  const [aiDrafted, setAiDrafted] = useState(meeting.aiDrafted === 1);
  const [objection, setObjection] = useState("");
  const [correction, setCorrection] = useState("");

  const base = `/api/v1/projects/${projectId}/meetings/${meeting.id}/minutes`;
  const issued = meeting.minutesIssuedAt !== null;
  const approved = meeting.approvedAt !== null;

  async function draft() {
    const days = objectionDays.trim() === "" ? null : Number(objectionDays);
    const done = await run("draft", () =>
      api.post(base, {
        minutesBody: body,
        objectionPeriodDays: days !== null && Number.isFinite(days) ? days : null,
        aiDrafted,
      }),
    );
    if (done !== null) onMutated();
  }

  async function issue() {
    const ok = await confirm({
      title: `Issue the minutes for ${meeting.reference}?`,
      description:
        "Issued minutes are the record a party is deemed to have accepted if they do not object within the stated period. Everyone on the distribution list is notified. You will not be able to approve them yourself afterwards — that is the point.",
      confirmLabel: "Issue the minutes",
      tone: "warning",
    });
    if (!ok) return;
    const done = await run("issue", () => api.post(`${base}/issue`, {}));
    if (done !== null) onMutated();
  }

  async function object() {
    if (!objection.trim()) return;
    const done = await run("object", () => api.post(`${base}/object`, { note: objection.trim() }));
    if (done !== null) {
      setObjection("");
      onMutated();
    }
  }

  async function correct() {
    if (!correction.trim()) return;
    const ok = await confirm({
      title: `Withdraw the issued minutes for ${meeting.reference}?`,
      description:
        "This is a ledgered re-issue, not an edit. The version is bumped, the issue stamps are cleared, live objections move into the history, and everyone who received the withdrawn version is told. The document already delivered keeps its own hash, so a later dispute compares two versions rather than one that quietly changed.",
      confirmLabel: "Withdraw for correction",
      tone: "warning",
    });
    if (!ok) return;
    const done = await run("correct", () =>
      api.post(`${base}/correct`, { reason: correction.trim() }),
    );
    if (done !== null) {
      setCorrection("");
      onMutated();
    }
  }

  async function approve() {
    const ok = await confirm({
      title: "Sign the minutes off?",
      description:
        "Approval is the other party's act — that is what makes issued minutes binding. The platform refuses it to whoever wrote or issued them, and refuses it while any objection is unresolved. For a recurring meeting, sign-off happens at the NEXT occurrence, which must have been held.",
      confirmLabel: "Approve the minutes",
      tone: "warning",
    });
    if (!ok) return;
    const done = await run("approve", () => api.post(`${base}/approve`, {}));
    if (done !== null) onMutated();
  }

  return (
    <div className="space-y-3">
      {dialog}
      <RefusalPanel refusal={refusal} onDismiss={clear} />
      <ObjectionWindow window={meeting.minutesObjectionWindow} />

      {meeting.aiDrafted === 1 ? (
        <Alert tone="warning" variant="subtle" size="sm" title="These minutes were AI-drafted">
          The record says so, and keeps saying so after they are issued. A draft produced by a
          machine is a starting point for the minute taker, never a statement of what a room agreed.
        </Alert>
      ) : null}

      {approved ? (
        <Alert tone="success" variant="subtle" size="sm" title="Signed off">
          Approved {dateTime(meeting.approvedAt)} by somebody who neither wrote nor issued them.
        </Alert>
      ) : null}

      <Card>
        <CardBody className="space-y-3">
          <Field
            label="Minutes"
            hint={
              approved
                ? "Approved minutes cannot be redrafted."
                : "The record of what the room agreed. Once issued, this is what silence will be read against."
            }
          >
            <Textarea
              rows={12}
              value={body}
              disabled={approved}
              onChange={(e) => setBody(e.target.value)}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Objection period (days)"
              hint="With none recorded, nothing is ever deemed accepted — silence carries no weight."
            >
              <Input
                type="number"
                min={0}
                max={90}
                value={objectionDays}
                disabled={issued}
                onChange={(e) => setObjectionDays(e.target.value)}
              />
            </Field>
            <div className="flex items-end">
              <Checkbox
                checked={aiDrafted}
                disabled={approved}
                onChange={(e) => setAiDrafted(e.target.checked)}
                label="This draft was produced by AI"
                description="Recorded permanently on the meeting. It cannot be unset by redrafting."
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              /*
               * Refused once issued. Saving a draft over issued minutes used to
               * regress the status while minutesIssuedAt stayed set, after
               * which neither /issue nor /approve would accept the meeting and
               * it could never reach minutes_accepted — a deadlock this button
               * actively invited. Correction is now an explicit, ledgered act.
               */
              disabled={approved || issued || body.trim().length === 0 || busy !== null}
              loading={busy === "draft"}
              onClick={() => void draft()}
            >
              Save the draft
            </Button>
            {!issued ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={!meeting.minutesBody || busy !== null}
                loading={busy === "issue"}
                onClick={() => void issue()}
              >
                Issue them
              </Button>
            ) : null}
            {issued && !approved ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy !== null}
                loading={busy === "approve"}
                onClick={() => void approve()}
              >
                Sign off
              </Button>
            ) : null}
          </div>
        </CardBody>
      </Card>

      {issued && !approved ? (
        <Card>
          <CardBody className="space-y-2">
            <p className="text-sm font-semibold text-content">Withdraw and correct</p>
            <p className="text-meta text-content-muted">
              Issued minutes cannot be redrafted in place. A correction bumps the version, clears
              the issue stamps, moves the live objections into the history and tells the previous
              recipients that what they received has been withdrawn — because a correction nobody is
              told about is a rewrite.
            </p>
            <Field label="Why are these minutes being withdrawn?">
              <Textarea
                rows={2}
                value={correction}
                onChange={(e) => setCorrection(e.target.value)}
              />
            </Field>
            <Button
              size="sm"
              variant="secondary"
              disabled={correction.trim().length === 0 || busy !== null}
              loading={busy === "correct"}
              onClick={() => void correct()}
            >
              Withdraw for correction
            </Button>
          </CardBody>
        </Card>
      ) : null}

      <ObjectionsPanel
        projectId={projectId}
        meeting={meeting}
        onMutated={onMutated}
      />

      <MinutesDocumentPanel projectId={projectId} meeting={meeting} onMutated={onMutated} />

      {issued && !approved ? (
        <Card>
          <CardBody className="space-y-2">
            <p className="text-sm font-semibold text-content">Raise an objection</p>
            <p className="text-meta text-content-muted">
              Inside the period, an objection blocks sign-off until it is settled. After the period
              closes the API refuses it and tells you to raise the disagreement as a new agenda item
              at the next occurrence rather than rewriting an accepted record.
            </p>
            <Field label="What is wrong with the minutes?">
              <Textarea
                rows={3}
                value={objection}
                onChange={(e) => setObjection(e.target.value)}
              />
            </Field>
            <Button
              size="sm"
              variant="secondary"
              disabled={objection.trim().length === 0 || busy !== null}
              loading={busy === "object"}
              onClick={() => void object()}
            >
              Record the objection
            </Button>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

/* ================================================================== */
/* Decisions                                                           */
/* ================================================================== */

function DecisionsPanel({
  projectId,
  meeting,
  onMutated,
}: {
  projectId: string;
  meeting: MeetingDetail;
  onMutated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const { confirm, dialog } = useConfirm();
  const [addOpen, setAddOpen] = useState(false);

  async function ratify(decision: Decision) {
    const ok = await confirm({
      title: `Ratify ${decision.reference}?`,
      description:
        "Ratification is the independent check that stops a decision with cost consequences being self-authorised in the minutes. The platform refuses it both to the person who made the decision and to the person who minuted it.",
      confirmLabel: "Ratify",
      tone: "warning",
    });
    if (!ok) return;
    const done = await run(`ratify:${decision.id}`, () =>
      api.post(`/api/v1/projects/${projectId}/meeting-decisions/${decision.id}/ratify`, {}),
    );
    if (done !== null) onMutated();
  }

  return (
    <div className="space-y-3">
      {dialog}
      <RefusalPanel refusal={refusal} onDismiss={clear} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-meta text-content-muted">
          {count(meeting.decisions.length)} decision{meeting.decisions.length === 1 ? "" : "s"}{" "}
          minuted at this meeting.
        </p>
        <Button size="xs" variant="secondary" icon={IconPlus} onClick={() => setAddOpen(true)}>
          Record a decision
        </Button>
      </div>

      {meeting.decisions.length === 0 ? (
        <EmptyState
          icon={IconMeeting}
          size="sm"
          title="No decision has been minuted at this meeting"
          hint="Not every meeting decides something, and recording none is an honest outcome. But an agenda item that keeps carrying with no decision against it is the pattern this workspace is built to expose."
        />
      ) : (
        <ul className="space-y-2">
          {meeting.decisions.map((d) => (
            <li key={d.id} className="rounded-lg border border-border bg-surface-raised p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-2xs text-content-subtle">{d.reference}</span>
                    <span className="text-sm font-semibold text-content">{d.title}</span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <Badge tone={DECISION_STATUS_TONE[d.status] ?? "neutral"} size="xs" dot>
                      {titleCase(d.status)}
                    </Badge>
                    <span className="text-2xs text-content-subtle">
                      {d.decidedByName ?? d.decidedById ?? "decider not recorded"} ·{" "}
                      {isoDate(d.decisionDate)}
                    </span>
                    {meeting.quorum.met === false ? (
                      <Tooltip content="The quorum was not met at this meeting. The decision is still recorded — the platform does not delete it — but this is the first thing challenged later.">
                        <span>
                          <Badge tone="danger" size="xs" variant="outline">
                            Taken without a quorum
                          </Badge>
                        </span>
                      </Tooltip>
                    ) : null}
                  </div>
                </div>
                {d.status === "recorded" ? (
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={busy !== null}
                    onClick={() => void ratify(d)}
                  >
                    Ratify
                  </Button>
                ) : null}
              </div>
              <p className="mt-2 whitespace-pre-wrap text-meta text-content">{d.decision}</p>
              {d.rationale ? (
                <p className="mt-1.5 text-meta text-content-muted">{d.rationale}</p>
              ) : null}
              <div className="mt-3 rounded-md border border-border bg-surface-sunken p-2.5">
                <DecisionImpacts decision={d} />
              </div>
              {d.supersededByDecisionId ? (
                <p className="mt-1.5 text-2xs text-content-subtle">
                  Superseded by a later decision. Both directions are recorded, so the decision that
                  was in force on any given day stays readable.
                </p>
              ) : null}
              {d.disputeNote ? (
                <p className="mt-1.5 text-meta text-danger-fg">
                  <span className="font-medium">Disputed:</span> {d.disputeNote}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <AddDecisionModal
        open={addOpen}
        projectId={projectId}
        meetingId={meeting.id}
        agendaItems={meeting.agendaItems}
        onClose={() => setAddOpen(false)}
        onCreated={() => {
          setAddOpen(false);
          onMutated();
        }}
      />
    </div>
  );
}

function AddDecisionModal({
  open,
  projectId,
  meetingId,
  agendaItems,
  onClose,
  onCreated,
}: {
  open: boolean;
  projectId: string;
  meetingId: string;
  agendaItems: AgendaItem[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [title, setTitle] = useState("");
  const [decision, setDecision] = useState("");
  const [rationale, setRationale] = useState("");
  const [agendaItemId, setAgendaItemId] = useState("");
  const [decidedByName, setDecidedByName] = useState("");
  const [impactsCost, setImpactsCost] = useState(false);
  const [estimatedCostImpact, setEstimatedCostImpact] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [impactsSchedule, setImpactsSchedule] = useState(false);
  const [scheduleDays, setScheduleDays] = useState("");

  async function submit() {
    const cost = estimatedCostImpact.trim() === "" ? null : Number(estimatedCostImpact);
    const days = scheduleDays.trim() === "" ? null : Number(scheduleDays);
    const done = await run("create", () =>
      api.post(`/api/v1/projects/${projectId}/meetings/${meetingId}/decisions`, {
        title: title.trim(),
        decision: decision.trim(),
        rationale: rationale.trim() || null,
        agendaItemId: agendaItemId || null,
        decidedByName: decidedByName.trim() || null,
        impactsCost,
        estimatedCostImpact: cost !== null && Number.isFinite(cost) ? cost : null,
        currency: impactsCost ? currency.trim().toUpperCase().slice(0, 3) : null,
        impactsSchedule,
        estimatedScheduleImpactDays: days !== null && Number.isFinite(days) ? days : null,
      }),
    );
    if (done !== null) {
      setTitle("");
      setDecision("");
      setRationale("");
      onCreated();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record a decision"
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={title.trim().length === 0 || decision.trim().length === 0 || busy !== null}
            loading={busy === "create"}
            onClick={() => void submit()}
          >
            Record it
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {refusal ? (
          <Alert tone="danger" size="sm" title="Refused" onDismiss={clear}>
            <p className="whitespace-pre-wrap">{refusal.message}</p>
          </Alert>
        ) : null}
        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
        <Field label="The decision" required>
          <Textarea rows={3} value={decision} onChange={(e) => setDecision(e.target.value)} />
        </Field>
        <Field label="Rationale">
          <Textarea rows={2} value={rationale} onChange={(e) => setRationale(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Against which agenda item?">
            <Select value={agendaItemId} onChange={(e) => setAgendaItemId(e.target.value)}>
              <option value="">Not tied to an item</option>
              {agendaItems.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.itemNumber ? `${i.itemNumber} · ` : ""}
                  {i.title}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Who made the call?">
            <Input
              value={decidedByName}
              onChange={(e) => setDecidedByName(e.target.value)}
              placeholder="Name as minuted"
            />
          </Field>
        </div>

        <div className="space-y-2 rounded-lg border border-border bg-surface-raised p-3">
          <Checkbox
            checked={impactsCost}
            onChange={(e) => setImpactsCost(e.target.checked)}
            label="This decision has a cost consequence"
            description="Flagging it without an estimate is honest: the figure then reads as 'not available' with the reason, never as zero."
          />
          {impactsCost ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Estimated cost impact">
                <Input
                  type="number"
                  value={estimatedCostImpact}
                  onChange={(e) => setEstimatedCostImpact(e.target.value)}
                  placeholder="Leave blank if unknown"
                />
              </Field>
              <Field label="Currency" hint="Each decision carries its own; they are never summed.">
                <Input
                  value={currency}
                  maxLength={3}
                  onChange={(e) => setCurrency(e.target.value)}
                />
              </Field>
            </div>
          ) : null}
          <Checkbox
            checked={impactsSchedule}
            onChange={(e) => setImpactsSchedule(e.target.checked)}
            label="This decision has a schedule consequence"
          />
          {impactsSchedule ? (
            <Field label="Estimated schedule impact (days)">
              <Input
                type="number"
                value={scheduleDays}
                onChange={(e) => setScheduleDays(e.target.value)}
                placeholder="Leave blank if unknown"
              />
            </Field>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* Actions                                                             */
/* ================================================================== */

function ActionsPanel({
  projectId,
  meeting,
  onMutated,
}: {
  projectId: string;
  meeting: MeetingDetail;
  onMutated: () => void;
}) {
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-meta text-content-muted">
          {count(meeting.openActionItemCount)} open of {count(meeting.actionItemCount)} agreed here.
        </p>
        <Button size="xs" variant="secondary" icon={IconPlus} onClick={() => setAddOpen(true)}>
          Agree an action
        </Button>
      </div>

      {meeting.actionItems.length === 0 ? (
        <EmptyState
          icon={IconMeeting}
          size="sm"
          title="No action was agreed at this meeting"
          hint="The minutes are not the product — the action item is. A meeting that produced no action either settled everything on its agenda, or agreed nothing anybody is accountable for."
        />
      ) : (
        <div className="space-y-2">
          {meeting.actionItems.map((a) => (
            <ActionItemCard
              key={a.id}
              projectId={projectId}
              action={a}
              onMutated={onMutated}
            />
          ))}
        </div>
      )}

      <AddActionModal
        open={addOpen}
        projectId={projectId}
        meeting={meeting}
        onClose={() => setAddOpen(false)}
        onCreated={() => {
          setAddOpen(false);
          onMutated();
        }}
      />
    </div>
  );
}

function AddActionModal({
  open,
  projectId,
  meeting,
  onClose,
  onCreated,
}: {
  open: boolean;
  projectId: string;
  meeting: MeetingDetail;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const users = useCompanyUsers();
  const [title, setTitle] = useState("");
  /*
   * OWNER IS A PERSON, NOT A STRING.
   *
   * This form used to post `ownerName` alone, so `ownerId` was never set from
   * the UI at all: GET /meeting-action-items/mine (which filters on ownerId)
   * was permanently empty, the assignment notification never fired, and the
   * overdue-by-owner report grouped typed names. Picking the user is the
   * default; a typed name remains available for somebody outside the tenant,
   * and the form says what that costs.
   */
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [ownerName, setOwnerName] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [priority, setPriority] = useState("medium");
  const [agendaItemId, setAgendaItemId] = useState("");
  const [description, setDescription] = useState("");
  const [sourceClause, setSourceClause] = useState("");

  /* An attendee of THIS meeting is the likely owner, so they come first. */
  const candidates = useMemo<UserOption[]>(() => {
    const attending = meeting.attendees
      .filter((a) => a.userId)
      .map((a) => ({ id: a.userId as string, name: a.name, role: a.jobTitle ?? a.organisation }));
    const seen = new Set(attending.map((a) => a.id));
    return [...attending, ...users.filter((u) => !seen.has(u.id))];
  }, [meeting.attendees, users]);

  async function submit() {
    const done = await run("create", () =>
      api.post(`/api/v1/projects/${projectId}/meeting-action-items`, {
        title: title.trim(),
        description: description.trim() || null,
        meetingId: meeting.id,
        agendaItemId: agendaItemId || null,
        priority,
        ownerId,
        ownerName: ownerName.trim() || null,
        dueDate: dueDate || null,
        sourceClause: sourceClause.trim() || null,
      }),
    );
    if (done !== null) {
      setTitle("");
      setOwnerId(null);
      setOwnerName("");
      setDueDate("");
      setDescription("");
      setSourceClause("");
      onCreated();
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Agree an action"
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={title.trim().length === 0 || ownerName.trim().length === 0 || busy !== null}
            loading={busy === "create"}
            onClick={() => void submit()}
          >
            Agree it
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {refusal ? (
          <Alert tone="danger" size="sm" title="Refused" onDismiss={clear}>
            <p className="whitespace-pre-wrap">{refusal.message}</p>
          </Alert>
        ) : null}
        <Alert tone="info" variant="subtle" size="sm" title="An action nobody owns is a wish">
          The API refuses an action item with no owner — a name at minimum. A due date is optional
          here, but without one the action can never be overdue and can never be promoted to an
          obligation.
        </Alert>
        <Field label="What was agreed?" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field
            label="Owner"
            required
            className="sm:col-span-3"
            hint={
              ownerId
                ? "Linked to a platform user: this action appears in their list, they are notified, and the overdue report groups by person rather than by spelling."
                : "A typed name still appears in the minutes, but it produces no notification, never shows in the owner's own list, and groups by spelling in the overdue report."
            }
          >
            <div className="grid gap-2 sm:grid-cols-2">
              <UserPicker
                users={candidates}
                value={ownerId}
                placeholder="Pick the person who owns this…"
                onChange={(id, user) => {
                  setOwnerId(id);
                  if (user) setOwnerName(user.name);
                }}
              />
              <Input
                value={ownerName}
                onChange={(e) => setOwnerName(e.target.value)}
                placeholder="…or type a name"
              />
            </div>
          </Field>
          <Field label="Due">
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
          <Field label="Priority">
            <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
              {ACTION_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {titleCase(p)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Against which agenda item?">
          <Select value={agendaItemId} onChange={(e) => setAgendaItemId(e.target.value)}>
            <option value="">Not tied to an item</option>
            {meeting.agendaItems.map((i) => (
              <option key={i.id} value={i.id}>
                {i.itemNumber ? `${i.itemNumber} · ` : ""}
                {i.title}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Clause it discharges"
          hint="Optional now, required before this action can ever be promoted to an obligation. Recording it here saves the argument later."
        >
          <Input
            value={sourceClause}
            onChange={(e) => setSourceClause(e.target.value)}
            placeholder="Clause 20.1 — notice of claim"
          />
        </Field>
        <Field label="Detail">
          <Textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}
