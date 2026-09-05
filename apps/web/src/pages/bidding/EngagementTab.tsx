/**
 * TENDER ENGAGEMENT — the period between issuing a package and receiving the
 * bids, where the buyer's job is to keep every bidder answering the SAME
 * question.
 *
 *   Queries    a bidder asks, the buyer answers, and the answer is published
 *              to everyone as an addendum. An answer held by one bidder is a
 *              defect in the procurement, so this screen shows "answered but
 *              not published" as an outstanding state rather than a done one.
 *   Meetings   attendance, because a mandatory site visit somebody missed is
 *              a compliance finding on their bid.
 *   Bonds      the security against a winner walking away, with its expiry and
 *              its shortfall against the required percentage of the bid.
 *   Access     who downloaded which document — and, more usefully, who never
 *              opened the drawings they priced.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Modal,
  SegmentedControl,
  Select,
  Stat,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import {
  IconApproval,
  IconCalendar,
  IconMail,
  IconScan,
  IconCompliance,
  IconWarning,
} from "../../ui/icons";
import { api } from "../../lib/api";
import {
  LoadError,
  LoadingBlock,
  RefusalPanel,
  dateTime,
  isoDate,
  money,
  num,
  titleCase,
  useAction,
  useResource,
  useVendors,
} from "./biddingShared";
import type {
  BidBond,
  BidBondList,
  BidMeeting,
  BidQuestion,
  BidQuestionList,
  DocumentAccessReport,
  ListResponse,
  PackageDetail,
} from "./types";

type Section = "queries" | "meetings" | "bonds" | "access";

const QUESTION_CATEGORIES = [
  "scope",
  "drawings",
  "specification",
  "commercial",
  "programme",
  "contract_terms",
  "site_conditions",
  "process",
  "other",
] as const;

const MEETING_KINDS = [
  "pre_bid",
  "site_visit",
  "mid_tender_interview",
  "clarification",
  "post_tender_negotiation",
  "debrief",
] as const;

const BOND_STATUSES = [
  "required",
  "requested",
  "received",
  "verified",
  "rejected",
  "expired",
  "released",
  "called",
] as const;

export default function EngagementTab({
  projectId,
  packageId,
  pkg,
  onMutated,
}: {
  projectId: string;
  packageId: string;
  pkg: PackageDetail | null;
  onMutated: () => void;
}) {
  const [section, setSection] = useState<Section>("queries");
  const [version, setVersion] = useState(0);
  const action = useAction();

  const base = `/api/v1/projects/${projectId}/bid-packages/${packageId}`;
  const questions = useResource<BidQuestionList>(
    packageId && section === "queries" ? `${base}/questions?page=1&pageSize=200&_v=${version}` : null,
  );
  const meetings = useResource<ListResponse<BidMeeting>>(
    packageId && section === "meetings" ? `${base}/meetings?_v=${version}` : null,
  );
  const bonds = useResource<BidBondList>(
    packageId && section === "bonds" ? `${base}/bonds?_v=${version}` : null,
  );
  const access = useResource<DocumentAccessReport>(
    packageId && section === "access" ? `${base}/document-access?_v=${version}` : null,
  );

  function refresh() {
    setVersion((n) => n + 1);
    onMutated();
  }

  return (
    <div className="space-y-4">
      {action.refusal ? <RefusalPanel refusal={action.refusal} onDismiss={action.clear} /> : null}
      <SegmentedControl
        aria-label="Engagement section"
        value={section}
        onChange={(v) => setSection(v as Section)}
        options={[
          { value: "queries", label: "Tender queries" },
          { value: "meetings", label: "Meetings & site visits" },
          { value: "bonds", label: "Bid bonds" },
          { value: "access", label: "Document access" },
        ]}
      />

      {section === "queries" ? (
        <QueriesSection
          base={base}
          list={questions}
          action={action}
          onChanged={refresh}
          pkg={pkg}
        />
      ) : null}
      {section === "meetings" ? (
        <MeetingsSection base={base} list={meetings} action={action} onChanged={refresh} />
      ) : null}
      {section === "bonds" ? (
        <BondsSection base={base} list={bonds} action={action} onChanged={refresh} pkg={pkg} />
      ) : null}
      {section === "access" ? <AccessSection list={access} /> : null}
    </div>
  );
}

/* ================================================================== */
/* Queries                                                             */
/* ================================================================== */

function QueriesSection({
  base,
  list,
  action,
  onChanged,
  pkg,
}: {
  base: string;
  list: ReturnType<typeof useResource<BidQuestionList>>;
  action: ReturnType<typeof useAction>;
  onChanged: () => void;
  pkg: PackageDetail | null;
}) {
  const [asking, setAsking] = useState(false);
  const [answering, setAnswering] = useState<BidQuestion | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [publishing, setPublishing] = useState(false);

  const data = list.data;
  const answered = useMemo(
    () => (data?.items ?? []).filter((q) => q.status === "answered"),
    [data],
  );

  if (list.loading && !data) return <LoadingBlock rows={4} />;
  if (list.error) return <LoadError message={list.error} onRetry={list.reload} />;

  return (
    <Card>
      <CardHeader
        title="Tender queries"
        subtitle="Every answer reaches every bidder, as an addendum. An answer one bidder holds alone means the others priced a different job."
        actions={
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setAsking(true)}>
              Record a query
            </Button>
            <Button
              size="sm"
              disabled={selected.size === 0}
              onClick={() => setPublishing(true)}
            >
              Publish {selected.size > 0 ? `${selected.size} ` : ""}as an addendum
            </Button>
          </div>
        }
      />
      <CardBody flush>
        {data && data.summary.answeredNotPublished > 0 ? (
          <Alert tone="warning" className="m-3" icon={IconWarning} title="Answers not yet with the other bidders">
            <p>{data.note}</p>
          </Alert>
        ) : null}
        {!data || data.items.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={IconMail}
              title="No tender queries yet"
              hint="Queries arrive through the bidder portal or by email. Record them here so the answer reaches everybody."
            />
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th> </Th>
                <Th>Query</Th>
                <Th>From</Th>
                <Th>Status</Th>
                <Th>Answer</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((q) => (
                <tr key={q.id}>
                  <Td>
                    <Checkbox
                      aria-label={`Select ${q.reference}`}
                      checked={selected.has(q.id)}
                      disabled={q.status !== "answered"}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(q.id);
                        else next.delete(q.id);
                        setSelected(next);
                      }}
                    />
                  </Td>
                  <Td>
                    <p className="font-medium">{q.reference}</p>
                    <p className="mt-0.5 whitespace-pre-wrap text-2xs leading-snug text-content-muted">
                      {q.question}
                    </p>
                    <Badge tone="neutral" size="xs" variant="subtle" className="mt-1">
                      {titleCase(q.category)}
                    </Badge>
                  </Td>
                  <Td>
                    <p className="text-meta">{q.vendorName ?? "Not attributed"}</p>
                    <p className="text-2xs text-content-subtle">{dateTime(q.askedAt)}</p>
                  </Td>
                  <Td>
                    <Badge
                      tone={
                        q.status === "published"
                          ? "success"
                          : q.status === "answered"
                            ? "warning"
                            : "neutral"
                      }
                      size="xs"
                    >
                      {titleCase(q.status)}
                    </Badge>
                    {q.publishedAddendumRef ? (
                      <p className="mt-0.5 text-2xs text-content-subtle">
                        {q.publishedAddendumRef}
                      </p>
                    ) : null}
                    {q.isPrivate ? (
                      <p className="mt-0.5 text-2xs text-warning-fg">answered privately</p>
                    ) : null}
                  </Td>
                  <Td>
                    <p className="whitespace-pre-wrap text-2xs leading-snug text-content-muted">
                      {q.answer ?? "—"}
                    </p>
                  </Td>
                  <Td align="right">
                    {q.status === "submitted" || q.status === "under_review" ? (
                      <Button size="xs" variant="secondary" onClick={() => setAnswering(q)}>
                        Answer
                      </Button>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </CardBody>

      <AskModal
        open={asking}
        onClose={() => setAsking(false)}
        base={base}
        action={action}
        onDone={() => {
          setAsking(false);
          onChanged();
        }}
      />
      <AnswerModal
        question={answering}
        onClose={() => setAnswering(null)}
        base={base}
        action={action}
        onDone={() => {
          setAnswering(null);
          onChanged();
        }}
      />
      <PublishModal
        open={publishing}
        onClose={() => setPublishing(false)}
        base={base}
        action={action}
        questions={answered.filter((q) => selected.has(q.id))}
        currentDueAt={pkg?.timetable.bidDueAt ?? null}
        onDone={() => {
          setPublishing(false);
          setSelected(new Set());
          onChanged();
        }}
      />
    </Card>
  );
}

function AskModal({
  open,
  onClose,
  base,
  action,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  base: string;
  action: ReturnType<typeof useAction>;
  onDone: () => void;
}) {
  const vendors = useVendors();
  const [question, setQuestion] = useState("");
  const [category, setCategory] = useState<string>("scope");
  const [vendorId, setVendorId] = useState("");
  const [warning, setWarning] = useState<string | null>(null);

  async function submit() {
    const res = await action.run("ask", () =>
      api.post<BidQuestion>(`${base}/questions`, {
        question,
        category,
        ...(vendorId ? { vendorId } : {}),
      }),
    );
    if (!res) return;
    setQuestion("");
    if (res.lateWarning) {
      setWarning(res.lateWarning);
      onDone();
      return;
    }
    onDone();
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        setWarning(null);
        onClose();
      }}
      title="Record a tender query"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            disabled={question.trim().length < 5}
            loading={action.busy === "ask"}
            onClick={() => void submit()}
          >
            Record
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {warning ? (
          <Alert tone="warning" title="Received after the questions deadline">
            <p className="whitespace-pre-wrap">{warning}</p>
          </Alert>
        ) : null}
        <Field label="The query" required>
          <Textarea rows={4} value={question} onChange={(e) => setQuestion(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Category">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {QUESTION_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {titleCase(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Asked by"
            hint="Optional — the published answer is anonymised either way."
          >
            <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              <option value="">Not attributed</option>
              {(vendors.data?.items ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function AnswerModal({
  question,
  onClose,
  base,
  action,
  onDone,
}: {
  question: BidQuestion | null;
  onClose: () => void;
  base: string;
  action: ReturnType<typeof useAction>;
  onDone: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const [anonymised, setAnonymised] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [privateReason, setPrivateReason] = useState("");

  async function submit() {
    if (!question) return;
    const res = await action.run("answer", () =>
      api.post(`${base}/questions/${question.id}/answer`, {
        answer,
        anonymisedQuestion: anonymised.trim() || question.question,
        isPrivate,
        ...(isPrivate ? { privateReason } : {}),
      }),
    );
    if (!res) return;
    setAnswer("");
    setAnonymised("");
    setIsPrivate(false);
    setPrivateReason("");
    onDone();
  }

  return (
    <Modal
      open={question !== null}
      onClose={onClose}
      title={question ? `Answer ${question.reference}` : ""}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              answer.trim().length < 5 || (isPrivate && privateReason.trim().length < 20)
            }
            loading={action.busy === "answer"}
            onClick={() => void submit()}
          >
            Record the answer
          </Button>
        </div>
      }
    >
      {question ? (
        <div className="space-y-3">
          <div className="rounded-md bg-surface-sunken p-2 text-meta">
            <p className="whitespace-pre-wrap">{question.question}</p>
          </div>
          <Field label="The answer" required>
            <Textarea rows={4} value={answer} onChange={(e) => setAnswer(e.target.value)} />
          </Field>
          <Field
            label="The question as it will be published"
            hint="Names and identifying detail removed — the fact that the incumbent asked about the existing services tells the others something."
          >
            <Textarea
              rows={2}
              value={anonymised}
              placeholder={question.question}
              onChange={(e) => setAnonymised(e.target.value)}
            />
          </Field>
          <Checkbox
            checked={isPrivate}
            onChange={(e) => setIsPrivate(e.target.checked)}
            label="Answer this bidder only"
            description="The default is that everybody hears it. A private answer needs a written reason."
          />
          {isPrivate ? (
            <Field
              label="Why this answer is not shared"
              required
              hint="At least 20 characters — this is the sentence a losing bidder's challenge will read."
            >
              <Textarea
                rows={3}
                value={privateReason}
                onChange={(e) => setPrivateReason(e.target.value)}
              />
            </Field>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}

function PublishModal({
  open,
  onClose,
  base,
  action,
  questions,
  currentDueAt,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  base: string;
  action: ReturnType<typeof useAction>;
  questions: BidQuestion[];
  currentDueAt: string | null;
  onDone: () => void;
}) {
  const [reference, setReference] = useState("");
  const [extend, setExtend] = useState("");

  async function submit() {
    const res = await action.run("publish", () =>
      api.post(`${base}/questions/publish`, {
        addendumReference: reference,
        questionIds: questions.map((q) => q.id),
        ...(extend ? { newBidDueAt: new Date(extend).toISOString() } : {}),
      }),
    );
    if (!res) return;
    setReference("");
    setExtend("");
    onDone();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Publish the answers as an addendum"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={reference.trim().length === 0 || questions.length === 0}
            loading={action.busy === "publish"}
            onClick={() => void submit()}
          >
            Publish
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-meta leading-relaxed text-content-muted">
          Every live invitation will have to acknowledge this addendum. A bid submitted without
          acknowledging it was priced against a different scope from the one the other bidders
          answered.
        </p>
        <ul className="space-y-1 rounded-md bg-surface-sunken p-2 text-2xs">
          {questions.map((q) => (
            <li key={q.id}>
              <span className="font-medium">{q.reference}</span>{" "}
              {q.anonymisedQuestion ?? q.question}
            </li>
          ))}
        </ul>
        <Field label="Addendum reference" required>
          <Input
            value={reference}
            placeholder="ADD-03"
            onChange={(e) => setReference(e.target.value)}
          />
        </Field>
        <Field
          label="Extend the bid deadline to"
          hint={
            currentDueAt
              ? `Currently ${dateTime(currentDueAt)}. An addendum may extend the deadline but never shorten it.`
              : "Optional."
          }
        >
          <Input
            type="datetime-local"
            value={extend}
            onChange={(e) => setExtend(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* Meetings                                                            */
/* ================================================================== */

function MeetingsSection({
  base,
  list,
  action,
  onChanged,
}: {
  base: string;
  list: ReturnType<typeof useResource<ListResponse<BidMeeting>>>;
  action: ReturnType<typeof useAction>;
  onChanged: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [attendanceFor, setAttendanceFor] = useState<BidMeeting | null>(null);
  const [minutesFor, setMinutesFor] = useState<BidMeeting | null>(null);

  if (list.loading && !list.data) return <LoadingBlock rows={3} />;
  if (list.error) return <LoadError message={list.error} onRetry={list.reload} />;
  const items = list.data?.items ?? [];

  return (
    <Card>
      <CardHeader
        title="Pre-bid meetings and site visits"
        subtitle="Attendance is the record that matters: a mandatory site visit somebody missed is a compliance finding on their bid."
        actions={
          <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
            Schedule a meeting
          </Button>
        }
      />
      <CardBody>
        {items.length === 0 ? (
          <EmptyState
            icon={IconCalendar}
            title="No meetings scheduled"
            hint="A pre-bid meeting or site visit is where the bidders find out what the drawings do not say."
          />
        ) : (
          <div className="space-y-3">
            {items.map((m) => (
              <div key={m.id} className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium">{m.title}</p>
                      <Badge tone="neutral" size="xs" variant="subtle">
                        {titleCase(m.kind)}
                      </Badge>
                      {m.isMandatory ? (
                        <Badge tone="warning" size="xs">
                          Mandatory
                        </Badge>
                      ) : null}
                      <Badge
                        tone={m.status === "held" ? "success" : "info"}
                        size="xs"
                        variant="subtle"
                      >
                        {titleCase(m.status)}
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-2xs text-content-subtle">
                      {dateTime(m.scheduledAt)}
                      {m.location ? ` · ${m.location}` : ""}
                      {m.publishedAddendumRef
                        ? ` · minutes published as ${m.publishedAddendumRef}`
                        : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button size="xs" variant="ghost" onClick={() => setAttendanceFor(m)}>
                      Attendance
                    </Button>
                    <Button size="xs" variant="secondary" onClick={() => setMinutesFor(m)}>
                      Minutes
                    </Button>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-4 text-meta">
                  <span>
                    <span className="text-content-subtle">Attended:</span> {m.attendedCount}
                  </span>
                  {m.attendees.length > 0 ? (
                    <span className="text-content-muted">
                      {m.attendees
                        .map(
                          (a) =>
                            `${a.vendorName ?? a.attendeeName ?? "—"} (${titleCase(a.attendance)})`,
                        )
                        .join(", ")}
                    </span>
                  ) : null}
                </div>
                {m.compliance ? (
                  <Alert tone="warning" className="mt-2" icon={IconWarning}>
                    <p className="whitespace-pre-wrap">{m.compliance}</p>
                    <p className="mt-1 text-2xs">
                      Did not attend:{" "}
                      {m.missingMandatory.map((v) => v.vendorName ?? v.vendorId).join(", ")}
                    </p>
                  </Alert>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </CardBody>

      <MeetingModal
        open={creating}
        onClose={() => setCreating(false)}
        base={base}
        action={action}
        onDone={() => {
          setCreating(false);
          onChanged();
        }}
      />
      <AttendanceModal
        meeting={attendanceFor}
        onClose={() => setAttendanceFor(null)}
        base={base}
        action={action}
        onDone={() => {
          setAttendanceFor(null);
          onChanged();
        }}
      />
      <MinutesModal
        meeting={minutesFor}
        onClose={() => setMinutesFor(null)}
        base={base}
        action={action}
        onDone={() => {
          setMinutesFor(null);
          onChanged();
        }}
      />
    </Card>
  );
}

function MeetingModal({
  open,
  onClose,
  base,
  action,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  base: string;
  action: ReturnType<typeof useAction>;
  onDone: () => void;
}) {
  const [kind, setKind] = useState<string>("pre_bid");
  const [title, setTitle] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [location, setLocation] = useState("");
  const [isMandatory, setIsMandatory] = useState(false);

  async function submit() {
    const res = await action.run("meeting", () =>
      api.post(`${base}/meetings`, {
        kind,
        title,
        scheduledAt: new Date(scheduledAt).toISOString(),
        location: location || null,
        isMandatory,
      }),
    );
    if (!res) return;
    setTitle("");
    setScheduledAt("");
    setLocation("");
    onDone();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Schedule a meeting"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!title.trim() || !scheduledAt}
            loading={action.busy === "meeting"}
            onClick={() => void submit()}
          >
            Schedule
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {MEETING_KINDS.map((k) => (
                <option key={k} value={k}>
                  {titleCase(k)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="When" required>
            <Input
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Location">
          <Input value={location} onChange={(e) => setLocation(e.target.value)} />
        </Field>
        <Checkbox
          checked={isMandatory}
          onChange={(e) => setIsMandatory(e.target.checked)}
          label="Attendance is mandatory"
          description="A bidder who did not attend a mandatory visit priced the job on the drawings alone."
        />
      </div>
    </Modal>
  );
}

function AttendanceModal({
  meeting,
  onClose,
  base,
  action,
  onDone,
}: {
  meeting: BidMeeting | null;
  onClose: () => void;
  base: string;
  action: ReturnType<typeof useAction>;
  onDone: () => void;
}) {
  const vendors = useVendors();
  const [vendorId, setVendorId] = useState("");
  const [attendeeName, setAttendeeName] = useState("");
  const [attendance, setAttendance] = useState("attended");

  async function submit() {
    if (!meeting) return;
    const res = await action.run("attendance", () =>
      api.post(`${base}/meetings/${meeting.id}/attendance`, {
        attendees: [
          {
            ...(vendorId ? { vendorId } : {}),
            ...(attendeeName ? { attendeeName } : {}),
            attendance,
          },
        ],
      }),
    );
    if (!res) return;
    setAttendeeName("");
    onDone();
  }

  return (
    <Modal
      open={meeting !== null}
      onClose={onClose}
      title={meeting ? `Attendance — ${meeting.title}` : ""}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            disabled={!vendorId && !attendeeName.trim()}
            loading={action.busy === "attendance"}
            onClick={() => void submit()}
          >
            Record
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Bidder">
            <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              <option value="">Not a bidder</option>
              {(vendors.data?.items ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Attendance">
            <Select value={attendance} onChange={(e) => setAttendance(e.target.value)}>
              {["attended", "apologies", "absent", "invited"].map((a) => (
                <option key={a} value={a}>
                  {titleCase(a)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Person" hint="Who actually turned up.">
          <Input value={attendeeName} onChange={(e) => setAttendeeName(e.target.value)} />
        </Field>
        {meeting && meeting.attendees.length > 0 ? (
          <div className="rounded-md bg-surface-sunken p-2 text-2xs">
            {meeting.attendees.map((a) => (
              <p key={a.id}>
                {a.vendorName ?? a.attendeeName ?? "—"} · {titleCase(a.attendance)}
              </p>
            ))}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function MinutesModal({
  meeting,
  onClose,
  base,
  action,
  onDone,
}: {
  meeting: BidMeeting | null;
  onClose: () => void;
  base: string;
  action: ReturnType<typeof useAction>;
  onDone: () => void;
}) {
  const [minutes, setMinutes] = useState("");
  const [addendum, setAddendum] = useState("");

  async function submit() {
    if (!meeting) return;
    const res = await action.run("minutes", () =>
      api.post(`${base}/meetings/${meeting.id}/minutes`, {
        minutes,
        ...(addendum ? { publishAsAddendum: addendum } : {}),
      }),
    );
    if (!res) return;
    setMinutes("");
    setAddendum("");
    onDone();
  }

  return (
    <Modal
      open={meeting !== null}
      onClose={onClose}
      title={meeting ? `Minutes — ${meeting.title}` : ""}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={minutes.trim().length < 20}
            loading={action.busy === "minutes"}
            onClick={() => void submit()}
          >
            Record
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label="Minutes" required hint="At least 20 characters.">
          <Textarea
            rows={6}
            value={meeting?.minutes ? meeting.minutes : minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
        </Field>
        <Field
          label="Publish as addendum"
          hint="What was said at the meeting changed the question. A bidder who was not there is entitled to the same answer."
        >
          <Input
            value={addendum}
            placeholder="ADD-SV1"
            onChange={(e) => setAddendum(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* Bonds                                                               */
/* ================================================================== */

function BondsSection({
  base,
  list,
  action,
  onChanged,
  pkg,
}: {
  base: string;
  list: ReturnType<typeof useResource<BidBondList>>;
  action: ReturnType<typeof useAction>;
  onChanged: () => void;
  pkg: PackageDetail | null;
}) {
  const [creating, setCreating] = useState(false);
  const [statusFor, setStatusFor] = useState<BidBond | null>(null);

  if (list.loading && !list.data) return <LoadingBlock rows={3} />;
  if (list.error) return <LoadError message={list.error} onRetry={list.reload} />;
  const items = list.data?.items ?? [];
  const expiring = items.filter((b) => b.expired || (b.daysToExpiry !== null && b.daysToExpiry <= 30));

  return (
    <Card>
      <CardHeader
        title="Bid bonds"
        subtitle="The security against a winning bidder walking away. An expired bond on a live tender is a hole in the arrangement."
        actions={
          <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
            Record a bond
          </Button>
        }
      />
      <CardBody flush>
        {expiring.length > 0 ? (
          <Alert tone="warning" className="m-3" icon={IconWarning} title="Bonds at or near expiry">
            <p>
              {expiring.length} bond(s) expire within 30 days or already have. Extend or replace
              them: a tender running on an expired bond has no security behind it at the moment it
              most needs one.
            </p>
          </Alert>
        ) : null}
        {items.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={IconCompliance}
              title="No bid bonds recorded"
              hint={
                (pkg?.requirements.bonds ?? []).length > 0
                  ? "This package requires bonds. Record what each bidder lodged so the shortfall is visible before the award."
                  : "This package does not require a bid bond."
              }
            />
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Bidder</Th>
                <Th>Status</Th>
                <Th align="right">Required</Th>
                <Th align="right">Provided</Th>
                <Th align="right">Shortfall</Th>
                <Th>Expiry</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((b) => (
                <tr key={b.id}>
                  <Td>
                    <p className="font-medium">{b.vendorName ?? b.vendorId}</p>
                    <p className="text-2xs text-content-subtle">
                      {titleCase(b.bondType)}
                      {b.provider ? ` · ${b.provider}` : ""}
                      {b.bondNumber ? ` · ${b.bondNumber}` : ""}
                    </p>
                  </Td>
                  <Td>
                    <Badge
                      tone={
                        b.status === "verified"
                          ? "success"
                          : b.status === "expired" || b.status === "rejected"
                            ? "danger"
                            : b.status === "received"
                              ? "warning"
                              : "neutral"
                      }
                      size="xs"
                    >
                      {titleCase(b.status)}
                    </Badge>
                  </Td>
                  <Td align="right" className="tabular-nums">
                    {b.derivedRequiredAmount === null ? (
                      <span className="italic text-content-subtle">
                        {b.requiredPercent !== null ? `${num(b.requiredPercent, 1)}% of the bid` : "—"}
                      </span>
                    ) : (
                      money(b.derivedRequiredAmount, b.currency)
                    )}
                  </Td>
                  <Td align="right" className="tabular-nums">
                    {b.providedAmount === null ? "—" : money(b.providedAmount, b.currency)}
                  </Td>
                  <Td align="right" className="tabular-nums">
                    {b.shortfall === null ? (
                      "—"
                    ) : b.shortfall > 0 ? (
                      <span className="font-medium text-danger-fg">
                        {money(b.shortfall, b.currency)}
                      </span>
                    ) : (
                      <span className="text-success-fg">covered</span>
                    )}
                  </Td>
                  <Td>
                    <p className={b.expired ? "font-medium text-danger-fg" : ""}>
                      {isoDate(b.expiresAt)}
                    </p>
                    {b.daysToExpiry !== null ? (
                      <p className="text-2xs text-content-subtle">
                        {b.daysToExpiry < 0 ? `${-b.daysToExpiry} days ago` : `in ${b.daysToExpiry} days`}
                      </p>
                    ) : null}
                  </Td>
                  <Td align="right">
                    <Button size="xs" variant="ghost" onClick={() => setStatusFor(b)}>
                      Update
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {items.some((b) => b.note) ? (
          <div className="space-y-1 border-t border-border p-3 text-2xs text-content-muted">
            {items
              .filter((b) => b.note)
              .map((b) => (
                <p key={b.id}>
                  <span className="font-medium">{b.vendorName ?? b.vendorId}:</span> {b.note}
                </p>
              ))}
          </div>
        ) : null}
      </CardBody>

      <BondModal
        open={creating}
        onClose={() => setCreating(false)}
        base={base}
        action={action}
        currency={pkg?.currency ?? "USD"}
        onDone={() => {
          setCreating(false);
          onChanged();
        }}
      />
      <BondStatusModal
        bond={statusFor}
        onClose={() => setStatusFor(null)}
        action={action}
        onDone={() => {
          setStatusFor(null);
          onChanged();
        }}
      />
    </Card>
  );
}

function BondModal({
  open,
  onClose,
  base,
  action,
  currency,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  base: string;
  action: ReturnType<typeof useAction>;
  currency: string;
  onDone: () => void;
}) {
  const vendors = useVendors();
  const [vendorId, setVendorId] = useState("");
  const [requiredPercent, setRequiredPercent] = useState("");
  const [providedAmount, setProvidedAmount] = useState("");
  const [provider, setProvider] = useState("");
  const [expiresAt, setExpiresAt] = useState("");

  async function submit() {
    const res = await action.run("bond", () =>
      api.post(`${base}/bonds`, {
        vendorId,
        bondType: "bid",
        ...(requiredPercent ? { requiredPercent: Number(requiredPercent) } : {}),
        ...(providedAmount ? { providedAmount: Number(providedAmount) } : {}),
        ...(provider ? { provider } : {}),
        ...(expiresAt ? { expiresAt } : {}),
        currency,
      }),
    );
    if (!res) return;
    setVendorId("");
    setProvidedAmount("");
    onDone();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record a bid bond"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!vendorId} loading={action.busy === "bond"} onClick={() => void submit()}>
            Record
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label="Bidder" required>
          <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
            <option value="">Choose a bidder</option>
            {(vendors.data?.items ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Required (% of bid)">
            <Input
              type="number"
              value={requiredPercent}
              onChange={(e) => setRequiredPercent(e.target.value)}
            />
          </Field>
          <Field label={`Provided (${currency})`}>
            <Input
              type="number"
              value={providedAmount}
              onChange={(e) => setProvidedAmount(e.target.value)}
            />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Surety / provider">
            <Input value={provider} onChange={(e) => setProvider(e.target.value)} />
          </Field>
          <Field label="Expires">
            <Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function BondStatusModal({
  bond,
  onClose,
  action,
  onDone,
}: {
  bond: BidBond | null;
  onClose: () => void;
  action: ReturnType<typeof useAction>;
  onDone: () => void;
}) {
  const [status, setStatus] = useState("received");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const needsReason = status === "called" || status === "rejected";

  async function submit() {
    if (!bond) return;
    const res = await action.run("bondStatus", () =>
      api.post(`/api/v1/bid-bonds/${bond.id}/status`, {
        status,
        ...(note ? { note } : {}),
        ...(needsReason ? { reason } : {}),
      }),
    );
    if (!res) return;
    setNote("");
    setReason("");
    onDone();
  }

  return (
    <Modal
      open={bond !== null}
      onClose={onClose}
      title={bond ? `Bond — ${bond.vendorName ?? bond.vendorId}` : ""}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={needsReason && reason.trim().length < 3}
            loading={action.busy === "bondStatus"}
            onClick={() => void submit()}
          >
            Update
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field
          label="Status"
          hint="Verification is checking the instrument with the surety — and the person who recorded it may not be the person who verifies it."
        >
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            {BOND_STATUSES.map((s) => (
              <option key={s} value={s}>
                {titleCase(s)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Note">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {needsReason ? (
          <Field label="Reason" required>
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        ) : null}
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* Document access                                                     */
/* ================================================================== */

function AccessSection({
  list,
}: {
  list: ReturnType<typeof useResource<DocumentAccessReport>>;
}) {
  if (list.loading && !list.data) return <LoadingBlock rows={3} />;
  if (list.error) return <LoadError message={list.error} onRetry={list.reload} />;
  const data = list.data;

  return (
    <Card>
      <CardHeader
        title="Document access by bidder"
        subtitle="A bidder who priced a package without ever opening its drawings priced something else."
      />
      <CardBody flush>
        {!data || data.byVendor.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={IconScan}
              title="No access recorded"
              hint="Access is recorded when a bidder fetches a document through the portal. A bidder who received the documents another way will not appear here."
            />
          </div>
        ) : (
          <>
            <div className="grid gap-4 p-3 sm:grid-cols-3">
              <Stat label="Documents issued" value={String(data.files.length)} />
              <Stat label="Access events" value={String(data.total)} />
              <Stat
                label="Bidders who opened nothing"
                value={String(data.byVendor.filter((v) => v.filesOpened === 0).length)}
              />
            </div>
            <Table>
              <thead>
                <tr>
                  <Th>Bidder</Th>
                  <Th align="right">Files opened</Th>
                  <Th>Never opened</Th>
                  <Th>First</Th>
                  <Th>Last</Th>
                </tr>
              </thead>
              <tbody>
                {data.byVendor.map((v) => (
                  <tr key={v.invitationId}>
                    <Td>
                      <p className="font-medium">{v.vendorName ?? v.vendorId}</p>
                      <p className="text-2xs text-content-subtle">{titleCase(v.status)}</p>
                    </Td>
                    <Td align="right" className="tabular-nums">
                      {v.filesOpened} / {v.filesIssued}
                    </Td>
                    <Td>
                      {v.neverAccessed.length === 0 ? (
                        <Badge tone="success" size="xs" variant="subtle" icon={IconApproval}>
                          all opened
                        </Badge>
                      ) : (
                        <span className="text-2xs text-content-muted">
                          {v.neverAccessed.join(", ")}
                        </span>
                      )}
                    </Td>
                    <Td>{dateTime(v.firstAccessAt)}</Td>
                    <Td>{dateTime(v.lastAccessAt)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="border-t border-border p-3 text-2xs leading-relaxed text-content-muted">
              {data.note}
            </p>
          </>
        )}
      </CardBody>
    </Card>
  );
}
