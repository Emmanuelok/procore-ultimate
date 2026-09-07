/**
 * SERIES AND MEETING EDITORS — the half of the module the web app could not reach.
 *
 * The API has always accepted a standing agenda, a standing invitee roll, a
 * distribution list, a chair and a minute taker on a series. The create form
 * never sent any of them and no edit form existed, so every UI-created series
 * generated occurrences with an empty agenda, nobody on the roll, and a
 * distribution list of nobody — while the page told the reader the opposite
 * ("inherits the standing agenda, the invitees and the quorum"). Two of the
 * module's spec functions (#416, #417) existed only for API callers.
 *
 * The same gap on the occurrence: distribution, chair and minute taker could
 * not be set, so issuing minutes notified nobody and the drawer's own warning
 * ("nobody listed") had no remedy.
 *
 * Three deliberate choices here:
 *
 *  1. INVITEES ARE PEOPLE, NOT STRINGS. A row can be a platform user, a
 *     directory contact or a typed name. Only the first two produce an id, and
 *     only an id makes "my actions", assignment notifications and delivery
 *     records work; the typed name is the fallback, and the form says so.
 *  2. THE TEMPLATE IS COPIED, NOT REFERENCED. Applying a library template
 *     writes its items onto the series; editing the library afterwards does
 *     not rewrite minutes that have already been taken.
 *  3. IDENTITY IS FROZEN ONCE THE MINUTES EXIST. The API refuses a change of
 *     minute taker or chair after the minutes are written, because approval
 *     segregation is computed from those two fields. The form disables them
 *     rather than letting the server refuse a save the user has already made.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  Drawer,
  Field,
  Input,
  Select,
  Textarea,
  UserPicker,
  type UserOption,
} from "../../ui";
import { IconPlus, IconTrash } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  ATTENDEE_ROLES,
  ITEM_CATEGORIES,
  MEETING_TYPES,
  RECURRENCES,
  RefusalPanel,
  titleCase,
  useAction,
  useResource,
  type MeetingDetail,
  type SeriesDetail,
} from "./meetingsShared";

/* ------------------------------------------------------------------ */
/* Directory sources                                                   */
/* ------------------------------------------------------------------ */

interface CompanyUser {
  id: string;
  name: string;
  email: string | null;
  title: string | null;
  role: string | null;
}

interface DirectoryContact {
  id: string;
  name: string;
  email: string | null;
  jobTitle: string | null;
  vendorId: string | null;
}

/** Users of this company, for chair / minute taker / distribution / owners. */
export function useCompanyUsers(): UserOption[] {
  const res = useResource<{ items: CompanyUser[] }>("/api/v1/company/users?pageSize=200");
  return useMemo(
    () =>
      (res.data?.items ?? []).map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.title ?? u.role,
      })),
    [res.data],
  );
}

export function useContacts(): DirectoryContact[] {
  const res = useResource<{ items: DirectoryContact[] }>("/api/v1/contacts?pageSize=200");
  return res.data?.items ?? [];
}

/* ------------------------------------------------------------------ */
/* Row shapes                                                          */
/* ------------------------------------------------------------------ */

interface TemplateRow {
  title: string;
  category: string;
  allocatedMinutes: string;
  itemNumber: string;
}

interface AttendeeRow {
  userId: string | null;
  contactId: string | null;
  name: string;
  organisation: string;
  email: string;
  jobTitle: string;
  role: string;
}

function readTemplate(raw: unknown[]): TemplateRow[] {
  return raw.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    return {
      title: typeof o["title"] === "string" ? o["title"] : "",
      category: typeof o["category"] === "string" ? o["category"] : "other",
      allocatedMinutes:
        typeof o["allocatedMinutes"] === "number" ? String(o["allocatedMinutes"]) : "",
      itemNumber: typeof o["itemNumber"] === "string" ? o["itemNumber"] : "",
    };
  });
}

function readAttendees(raw: unknown[]): AttendeeRow[] {
  return raw.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
    return {
      userId: typeof o["userId"] === "string" ? (o["userId"] as string) : null,
      contactId: typeof o["contactId"] === "string" ? (o["contactId"] as string) : null,
      name: str("name"),
      organisation: str("organisation"),
      email: str("email"),
      jobTitle: str("jobTitle"),
      role: str("role") || "required",
    };
  });
}

/* ================================================================== */
/* SERIES EDITOR                                                       */
/* ================================================================== */

export default function SeriesEditor({
  projectId,
  seriesId,
  open,
  onClose,
  onSaved,
}: {
  projectId: string;
  seriesId: string;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const detail = useResource<SeriesDetail>(
    open ? `/api/v1/projects/${projectId}/meeting-series/${seriesId}` : null,
  );
  const users = useCompanyUsers();
  const contacts = useContacts();
  const { busy, refusal, clear, run } = useAction();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [meetingType, setMeetingType] = useState("progress");
  const [recurrence, setRecurrence] = useState("weekly");
  const [startTime, setStartTime] = useState("");
  const [duration, setDuration] = useState("");
  const [location, setLocation] = useState("");
  const [quorum, setQuorum] = useState("");
  const [contractRequirement, setContractRequirement] = useState("");
  const [chairId, setChairId] = useState<string | null>(null);
  const [minuteTakerId, setMinuteTakerId] = useState<string | null>(null);
  const [distribution, setDistribution] = useState<string[]>([]);
  const [template, setTemplate] = useState<TemplateRow[]>([]);
  const [attendees, setAttendees] = useState<AttendeeRow[]>([]);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    const d = detail.data;
    if (!d) return;
    setTitle(d.title);
    setDescription(d.description ?? "");
    setMeetingType(d.meetingType);
    setRecurrence(d.recurrence);
    setStartTime(d.startTime ?? "");
    setDuration(d.durationMinutes === null ? "" : String(d.durationMinutes));
    setLocation(d.defaultLocation ?? "");
    setQuorum(d.quorumRequired === null ? "" : String(d.quorumRequired));
    setContractRequirement(d.contractRequirement ?? "");
    setChairId(d.chairId);
    setMinuteTakerId(d.minuteTakerId);
    setDistribution(d.distribution ?? []);
    setTemplate(readTemplate(d.agendaTemplate ?? []));
    setAttendees(readAttendees(d.defaultAttendees ?? []));
  }, [detail.data]);

  const save = useCallback(async () => {
    const cleanTemplate = template
      .filter((t) => t.title.trim().length > 0)
      .map((t, i) => ({
        title: t.title.trim(),
        category: t.category,
        position: i,
        allocatedMinutes: t.allocatedMinutes.trim() === "" ? null : Number(t.allocatedMinutes),
        itemNumber: t.itemNumber.trim() || null,
      }));
    const cleanAttendees = attendees
      .filter((a) => a.name.trim().length > 0)
      .map((a) => ({
        userId: a.userId,
        contactId: a.contactId,
        name: a.name.trim(),
        organisation: a.organisation.trim() || null,
        email: a.email.trim() || null,
        jobTitle: a.jobTitle.trim() || null,
        role: a.role,
      }));
    const done = await run("save", () =>
      api.patch(`/api/v1/projects/${projectId}/meeting-series/${seriesId}`, {
        title: title.trim(),
        description: description.trim() || null,
        meetingType,
        recurrence,
        startTime: startTime || null,
        durationMinutes: duration.trim() === "" ? null : Number(duration),
        defaultLocation: location.trim() || null,
        quorumRequired: quorum.trim() === "" ? null : Number(quorum),
        contractRequirement: contractRequirement.trim() || null,
        chairId,
        minuteTakerId,
        distribution,
        agendaTemplate: cleanTemplate,
        defaultAttendees: cleanAttendees,
      }),
    );
    if (done !== null) {
      onSaved();
      detail.reload();
    }
  }, [
    attendees,
    chairId,
    contractRequirement,
    description,
    detail,
    distribution,
    duration,
    location,
    meetingType,
    minuteTakerId,
    onSaved,
    projectId,
    quorum,
    recurrence,
    run,
    seriesId,
    startTime,
    template,
    title,
  ]);

  const pause = async (status: "paused" | "active" | "closed") => {
    const done = await run(
      `status:${status}`,
      () =>
        status === "closed"
          ? api.post(`/api/v1/projects/${projectId}/meeting-series/${seriesId}/close`, {})
          : api.patch(`/api/v1/projects/${projectId}/meeting-series/${seriesId}`, { status }),
    );
    if (done !== null) {
      onSaved();
      detail.reload();
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={detail.data ? `${detail.data.reference} — standing arrangements` : "Series"}
      size="xl"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-2">
            {detail.data?.status === "active" ? (
              <Button variant="ghost" size="sm" onClick={() => void pause("paused")}>
                Pause
              </Button>
            ) : null}
            {detail.data?.status === "paused" ? (
              <Button variant="ghost" size="sm" onClick={() => void pause("active")}>
                Resume
              </Button>
            ) : null}
            {detail.data && detail.data.status !== "closed" ? (
              <Button variant="ghost" size="sm" onClick={() => void pause("closed")}>
                Close the series
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button loading={busy === "save"} disabled={busy !== null} onClick={() => void save()}>
              Save the standing arrangements
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <RefusalPanel refusal={refusal} onDismiss={clear} />
        {detail.error ? <Alert tone="danger" size="sm">{detail.error}</Alert> : null}

        <Alert tone="info" variant="subtle" size="sm" title="What these do">
          Every occurrence generated from this series starts with the standing agenda below, the
          invitee roll marked <strong>absent</strong> (nobody has attended a meeting that has not
          happened), and the previous occurrence's unclosed items carried in. The distribution list
          is who receives the minutes when they are issued — an empty list means issuing notifies
          nobody.
        </Alert>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Title" required className="sm:col-span-2">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Description" className="sm:col-span-2">
            <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label="Type">
            <Select value={meetingType} onChange={(e) => setMeetingType(e.target.value)}>
              {MEETING_TYPES.map((t) => (
                <option key={t} value={t}>
                  {titleCase(t)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Recurrence">
            <Select value={recurrence} onChange={(e) => setRecurrence(e.target.value)}>
              {RECURRENCES.map((r) => (
                <option key={r} value={r}>
                  {titleCase(r)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Start time">
            <Input
              value={startTime}
              placeholder="09:00"
              onChange={(e) => setStartTime(e.target.value)}
            />
          </Field>
          <Field label="Duration (minutes)">
            <Input
              type="number"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            />
          </Field>
          <Field label="Default location">
            <Input value={location} onChange={(e) => setLocation(e.target.value)} />
          </Field>
          <Field
            label="Quorum"
            hint="Decisions taken below quorum are recorded as not binding, never hidden"
          >
            <Input type="number" value={quorum} onChange={(e) => setQuorum(e.target.value)} />
          </Field>
          <Field label="Contract basis" className="sm:col-span-2">
            <Input
              value={contractRequirement}
              placeholder="NEC4 cl.31"
              onChange={(e) => setContractRequirement(e.target.value)}
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Chair" hint="Frozen once minutes exist for an occurrence">
            <UserPicker
              users={users}
              value={chairId}
              onChange={(id) => setChairId(id)}
              placeholder="Search people…"
            />
          </Field>
          <Field
            label="Minute taker"
            hint="Cannot also approve the minutes they wrote — that is the segregation the module is built on"
          >
            <UserPicker
              users={users}
              value={minuteTakerId}
              onChange={(id) => setMinuteTakerId(id)}
              placeholder="Search people…"
            />
          </Field>
          <Field
            label="Minutes distribution"
            className="sm:col-span-2"
            hint="Who receives the issued minutes. The objection period runs from delivery to these people."
          >
            <UserPicker
              multiple
              users={users}
              value={distribution}
              onChange={(ids) => setDistribution(ids)}
              placeholder="Add recipients…"
            />
          </Field>
        </div>

        <TemplateEditor
          projectId={projectId}
          seriesId={seriesId}
          rows={template}
          onChange={setTemplate}
          applying={applying}
          setApplying={setApplying}
          onApplied={() => {
            onSaved();
            detail.reload();
          }}
        />

        <AttendeeEditor rows={attendees} users={users} contacts={contacts} onChange={setAttendees} />
      </div>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */
/* Standing agenda                                                     */
/* ------------------------------------------------------------------ */

interface AgendaTemplateLibraryRow {
  id: string;
  name: string;
  meetingType: string;
  items: unknown[];
  isDefault: number;
  usageCount: number;
}

function TemplateEditor({
  projectId,
  seriesId,
  rows,
  onChange,
  applying,
  setApplying,
  onApplied,
}: {
  projectId: string;
  seriesId: string;
  rows: TemplateRow[];
  onChange: (rows: TemplateRow[]) => void;
  applying: boolean;
  setApplying: (v: boolean) => void;
  onApplied: () => void;
}) {
  const library = useResource<{ items: AgendaTemplateLibraryRow[] }>(
    applying ? "/api/v1/meeting-agenda-templates?pageSize=100" : null,
  );
  const { busy, refusal, clear, run } = useAction();

  const set = (i: number, patch: Partial<TemplateRow>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const move = (i: number, delta: number) => {
    const next = [...rows];
    const target = i + delta;
    if (target < 0 || target >= next.length) return;
    const a = next[i]!;
    const b = next[target]!;
    next[i] = b;
    next[target] = a;
    onChange(next);
  };

  const apply = async (templateId: string, mode: "replace" | "append") => {
    const done = await run(`apply:${templateId}`, () =>
      api.post(
        `/api/v1/projects/${projectId}/meeting-series/${seriesId}/apply-template`,
        { templateId, mode },
      ),
    );
    if (done !== null) {
      setApplying(false);
      onApplied();
    }
  };

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-content">Standing agenda</h3>
            <p className="text-2xs text-content-subtle">
              {rows.length} item{rows.length === 1 ? "" : "s"}. These are copied onto each
              occurrence — editing them here does not rewrite minutes already taken.
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="xs" variant="ghost" onClick={() => setApplying(!applying)}>
              {applying ? "Hide the library" : "Apply a library template"}
            </Button>
            <Button
              size="xs"
              icon={IconPlus}
              onClick={() =>
                onChange([
                  ...rows,
                  { title: "", category: "other", allocatedMinutes: "", itemNumber: "" },
                ])
              }
            >
              Add item
            </Button>
          </div>
        </div>

        <RefusalPanel refusal={refusal} onDismiss={clear} />

        {applying ? (
          <div className="rounded-md border border-border-subtle p-2">
            {library.loading ? (
              <p className="text-meta text-content-subtle">Loading the template library…</p>
            ) : (library.data?.items ?? []).length === 0 ? (
              <p className="text-meta text-content-subtle">
                No company agenda template is recorded yet. A template is an organisational
                standard: the same headings on every job, so the eighth one does not quietly stop
                appearing.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {(library.data?.items ?? []).map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center gap-2 text-meta">
                    <span className="font-medium text-content">{t.name}</span>
                    <Badge tone="neutral" size="xs" variant="outline">
                      {titleCase(t.meetingType)}
                    </Badge>
                    <span className="text-content-subtle">
                      {t.items.length} item{t.items.length === 1 ? "" : "s"}
                    </span>
                    {t.isDefault === 1 ? (
                      <Badge tone="info" size="xs">
                        default
                      </Badge>
                    ) : null}
                    <span className="flex-1" />
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => void apply(t.id, "append")}
                    >
                      Append
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => void apply(t.id, "replace")}
                    >
                      Replace
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        {rows.length === 0 ? (
          <p className="text-meta text-content-subtle">
            No standing agenda. Occurrences generated from this series will start empty.
          </p>
        ) : (
          <ul className="space-y-2">
            {rows.map((r, i) => (
              <li key={i} className="grid gap-2 sm:grid-cols-12">
                <div className="sm:col-span-5">
                  <Input
                    value={r.title}
                    placeholder="Safety moment"
                    onChange={(e) => set(i, { title: e.target.value })}
                  />
                </div>
                <div className="sm:col-span-3">
                  <Select value={r.category} onChange={(e) => set(i, { category: e.target.value })}>
                    {ITEM_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {titleCase(c)}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="sm:col-span-2">
                  <Input
                    type="number"
                    value={r.allocatedMinutes}
                    placeholder="min"
                    onChange={(e) => set(i, { allocatedMinutes: e.target.value })}
                  />
                </div>
                <div className="flex items-center gap-1 sm:col-span-2">
                  <Button size="xs" variant="ghost" onClick={() => move(i, -1)} aria-label="Move up">
                    ↑
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => move(i, 1)} aria-label="Move down">
                    ↓
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    icon={IconTrash}
                    aria-label="Remove"
                    onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Standing invitees                                                   */
/* ------------------------------------------------------------------ */

function AttendeeEditor({
  rows,
  users,
  contacts,
  onChange,
}: {
  rows: AttendeeRow[];
  users: UserOption[];
  contacts: DirectoryContact[];
  onChange: (rows: AttendeeRow[]) => void;
}) {
  const set = (i: number, patch: Partial<AttendeeRow>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const withoutId = rows.filter((r) => !r.userId && !r.contactId).length;

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-content">Standing invitees</h3>
            <p className="text-2xs text-content-subtle">
              {rows.length} invitee{rows.length === 1 ? "" : "s"}, added to each occurrence as{" "}
              <strong>absent</strong> until attendance is recorded.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                onChange([
                  ...rows,
                  ...users
                    .filter((u) => !rows.some((r) => r.userId === u.id))
                    .slice(0, 0)
                    .map(() => ({
                      userId: null,
                      contactId: null,
                      name: "",
                      organisation: "",
                      email: "",
                      jobTitle: "",
                      role: "required",
                    })),
                  {
                    userId: null,
                    contactId: null,
                    name: "",
                    organisation: "",
                    email: "",
                    jobTitle: "",
                    role: "required",
                  },
                ])
              }
              icon={IconPlus}
            >
              Add invitee
            </Button>
          </div>
        </div>

        {withoutId > 0 ? (
          <Alert tone="warning" variant="subtle" size="sm">
            {withoutId} invitee{withoutId === 1 ? " has" : "s have"} no linked user or contact.
            Typed names still appear on the roll and in the minutes, but they cannot receive an
            assignment notification, cannot appear in "my actions", and a delivery of the minutes to
            them cannot be recorded — so the objection period will not run from their receipt.
          </Alert>
        ) : null}

        {rows.length === 0 ? (
          <p className="text-meta text-content-subtle">
            No standing invitees. Generated occurrences will have an empty attendance roll, and
            quorum cannot be settled against a roll that does not exist.
          </p>
        ) : (
          <ul className="space-y-2">
            {rows.map((r, i) => (
              <li key={i} className="grid gap-2 sm:grid-cols-12">
                <div className="sm:col-span-4">
                  <UserPicker
                    users={users}
                    value={r.userId}
                    placeholder="Link a platform user…"
                    onChange={(id, user) =>
                      set(i, {
                        userId: id,
                        contactId: id ? null : r.contactId,
                        name: user?.name ?? r.name,
                        email: user?.email ?? r.email,
                        jobTitle: user?.role ?? r.jobTitle,
                      })
                    }
                  />
                </div>
                <div className="sm:col-span-3">
                  <Select
                    value={r.contactId ?? ""}
                    onChange={(e) => {
                      const c = contacts.find((x) => x.id === e.target.value);
                      set(i, {
                        contactId: e.target.value || null,
                        userId: e.target.value ? null : r.userId,
                        name: c?.name ?? r.name,
                        email: c?.email ?? r.email,
                        jobTitle: c?.jobTitle ?? r.jobTitle,
                      });
                    }}
                  >
                    <option value="">…or a directory contact</option>
                    {contacts.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="sm:col-span-2">
                  <Input
                    value={r.name}
                    placeholder="Name as minuted"
                    onChange={(e) => set(i, { name: e.target.value })}
                  />
                </div>
                <div className="sm:col-span-2">
                  <Select value={r.role} onChange={(e) => set(i, { role: e.target.value })}>
                    {ATTENDEE_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {titleCase(role)}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="flex items-center sm:col-span-1">
                  <Button
                    size="xs"
                    variant="ghost"
                    icon={IconTrash}
                    aria-label="Remove"
                    onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

/* ================================================================== */
/* MEETING EDITOR — distribution, chair and minute taker per occurrence */
/* ================================================================== */

export function MeetingEditor({
  projectId,
  meeting,
  open,
  onClose,
  onSaved,
}: {
  projectId: string;
  meeting: MeetingDetail;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const users = useCompanyUsers();
  const { busy, refusal, clear, run } = useAction();
  const [title, setTitle] = useState(meeting.title);
  const [location, setLocation] = useState(meeting.location ?? "");
  const [chairId, setChairId] = useState<string | null>(meeting.chairId);
  const [minuteTakerId, setMinuteTakerId] = useState<string | null>(meeting.minuteTakerId);
  const [distribution, setDistribution] = useState<string[]>(meeting.distribution ?? []);
  const [quorum, setQuorum] = useState(
    meeting.quorumRequired === null ? "" : String(meeting.quorumRequired),
  );

  /* The API refuses these once the minutes exist, because minutes approval
     segregation is computed from them. Disable rather than let a save fail. */
  const identityFrozen = Boolean(meeting.minutesBody) || Boolean(meeting.minutesIssuedAt);

  const save = async () => {
    const done = await run("save", () =>
      api.patch(`/api/v1/projects/${projectId}/meetings/${meeting.id}`, {
        title: title.trim(),
        location: location.trim() || null,
        distribution,
        quorumRequired: quorum.trim() === "" ? null : Number(quorum),
        ...(identityFrozen ? {} : { chairId, minuteTakerId }),
      }),
    );
    if (done !== null) onSaved();
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={`${meeting.reference} — details`}
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy === "save"} disabled={busy !== null} onClick={() => void save()}>
            Save
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <RefusalPanel refusal={refusal} onDismiss={clear} />
        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Location">
          <Input value={location} onChange={(e) => setLocation(e.target.value)} />
        </Field>
        <Field label="Quorum">
          <Input type="number" value={quorum} onChange={(e) => setQuorum(e.target.value)} />
        </Field>
        {identityFrozen ? (
          <Alert tone="info" variant="subtle" size="sm" title="Chair and minute taker are frozen">
            The minutes for this occurrence already exist. Approval segregation is computed from the
            minute taker and the issuer, so changing either now would let the author of a set of
            minutes approve them. Correct the minutes instead, or record the change as a decision at
            the next occurrence.
          </Alert>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Chair">
              <UserPicker users={users} value={chairId} onChange={(id) => setChairId(id)} />
            </Field>
            <Field label="Minute taker">
              <UserPicker
                users={users}
                value={minuteTakerId}
                onChange={(id) => setMinuteTakerId(id)}
              />
            </Field>
          </div>
        )}
        <Field
          label="Minutes distribution"
          hint="Who receives the issued minutes. The objection period runs from delivery — an empty list means issuing notifies nobody and no clock starts."
        >
          <UserPicker
            multiple
            users={users}
            value={distribution}
            onChange={(ids) => setDistribution(ids)}
          />
        </Field>
      </div>
    </Drawer>
  );
}
