/**
 * ONE TOOLBOX TALK, and the attendance sheet.
 *
 * Attendance and comprehension are counted separately and shown separately.
 * A signature says somebody was in the room; a comprehension check says
 * somebody asked them a question and got an answer. In an enforcement
 * interview those two records carry very different weight, and so does the
 * method the signature was captured by — a biometric scan and a supervisor's
 * tick are the same row with very different evidential value.
 */
import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  DescriptionList,
  Drawer,
  EmptyState,
  Field,
  Input,
  Progress,
  Select,
  Skeleton,
  Textarea,
  type DescriptionItem,
} from "../../ui";
import { IconMeeting } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  EM_DASH,
  LoadError,
  ReasonList,
  RefusalNotice,
  SectionHeading,
  TALK_STATUS_TONE,
  count,
  dateTime,
  decimal,
  isoDate,
  labelize,
  nameOf,
  useMutation,
  useResource,
  type TalkDetail,
} from "./safetyShared";

const METHODS = [
  "wet_signature",
  "on_device_signature",
  "biometric",
  "qr_scan",
  "badge_scan",
  "verbal_confirmed",
  "supervisor_attested",
];

/** How much an inspector will accept each acknowledgement method as evidence. */
const METHOD_WEIGHT: Record<string, "strong" | "moderate" | "weak"> = {
  biometric: "strong",
  badge_scan: "strong",
  on_device_signature: "moderate",
  qr_scan: "moderate",
  wet_signature: "moderate",
  verbal_confirmed: "weak",
  supervisor_attested: "weak",
};

export default function TalkDrawer({
  projectId,
  talkId,
  users,
  vendors,
  onClose,
  onMutated,
}: {
  projectId: string;
  talkId: string | null;
  users: Map<string, string>;
  vendors: Map<string, string>;
  onClose: () => void;
  onMutated: () => void;
}) {
  const [version, setVersion] = useState(0);
  const detail = useResource<TalkDetail>(
    (signal) =>
      api.get<TalkDetail>(`/api/v1/projects/${projectId}/safety/toolbox-talks/${talkId}`, {
        signal,
      }),
    [projectId, talkId, version],
    talkId !== null && projectId !== "",
  );
  const mutation = useMutation(() => {
    setVersion((n) => n + 1);
    onMutated();
  });

  const [attendeeName, setAttendeeName] = useState("");
  const [attendeeWorkerId, setAttendeeWorkerId] = useState("");
  const [method, setMethod] = useState("wet_signature");
  const [comprehension, setComprehension] = useState(false);
  const [verifyNote, setVerifyNote] = useState("");

  const talk = detail.data;

  const facts: DescriptionItem[] = talk
    ? [
        { label: "Topic", value: talk.topic ?? EM_DASH },
        { label: "Category", value: labelize(talk.category) },
        { label: "Date", value: isoDate(talk.talkDate) },
        {
          label: "Start / duration",
          value: `${talk.startTime ?? EM_DASH}${talk.durationMinutes ? ` · ${talk.durationMinutes} min` : ""}`,
        },
        {
          label: "Presenter",
          value: talk.presenterName ?? (talk.presenterId ? nameOf(users, talk.presenterId) : EM_DASH),
        },
        { label: "Crew briefed", value: talk.vendorId ? nameOf(vendors, talk.vendorId) : EM_DASH },
        { label: "Location", value: talk.locationText ?? EM_DASH },
        {
          label: "Delivered in",
          value: (
            <span className="flex flex-wrap items-center gap-1.5">
              {talk.language ? talk.language : <span className="text-content-muted">not recorded</span>}
              {talk.interpreterUsed ? (
                <Badge tone="info" size="xs">
                  Interpreter used
                </Badge>
              ) : null}
            </span>
          ),
          hint: "The language the talk was actually delivered in, not the language the material is written in.",
        },
        {
          label: "Verified",
          value: talk.verifiedAt
            ? `${dateTime(talk.verifiedAt)} by ${nameOf(users, talk.verifiedBy)}`
            : "Not verified",
          hint: "Verification is never by the presenter.",
          span: 2,
        },
      ]
    : [];

  const attendancePct =
    talk && talk.expectedAttendeeCount ? (talk.attendeeCount / talk.expectedAttendeeCount) * 100 : null;
  const comprehensionPct =
    talk && talk.attendeeCount > 0 ? (talk.comprehensionCheckedCount / talk.attendeeCount) * 100 : null;

  return (
    <Drawer
      open={talkId !== null}
      onClose={onClose}
      size="lg"
      icon={IconMeeting}
      title={talk ? `${talk.reference} · ${talk.title}` : "Toolbox talk"}
      headerActions={
        talk ? (
          <Badge tone={TALK_STATUS_TONE[talk.status] ?? "neutral"} size="sm" dot>
            {labelize(talk.status)}
          </Badge>
        ) : null
      }
    >
      {detail.error ? (
        <LoadError message={detail.error} onRetry={detail.reload} title="This talk could not be loaded" />
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

      {detail.loading && !talk ? (
        <Skeleton height={280} />
      ) : talk ? (
        <div className="space-y-4">
          {talk.relatedIncidentId ? (
            <Alert tone="info" title="Given because of an incident">
              This briefing cites an incident on this project as its reason. That link is the
              evidence that a lesson was pushed to the people it concerned rather than filed.
            </Alert>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <Card variant="sunken">
              <CardBody>
                <p className="text-label uppercase text-content-subtle">Attendance</p>
                <p className="mt-1 text-display-xs font-semibold tabular-nums text-content">
                  {count(talk.attendeeCount)}
                  {talk.expectedAttendeeCount ? (
                    <span className="text-lg text-content-muted"> / {count(talk.expectedAttendeeCount)}</span>
                  ) : null}
                </p>
                {attendancePct !== null ? (
                  <Progress
                    className="mt-1.5"
                    value={Math.min(100, attendancePct)}
                    max={100}
                    size="xs"
                    tone={attendancePct >= 100 ? "success" : attendancePct >= 80 ? "warning" : "danger"}
                  />
                ) : (
                  <p className="mt-1 text-2xs text-content-muted">
                    No expected headcount was recorded, so attendance is a count and not a rate.
                  </p>
                )}
                {talk.attendanceShortfall !== null && talk.attendanceShortfall > 0 ? (
                  <p className="mt-1.5 text-2xs text-warning-fg">
                    {count(talk.attendanceShortfall)} of the crew who were expected were not briefed.
                  </p>
                ) : null}
              </CardBody>
            </Card>
            <Card variant="sunken">
              <CardBody>
                <p className="text-label uppercase text-content-subtle">Comprehension checked</p>
                <p className="mt-1 text-display-xs font-semibold tabular-nums text-content">
                  {count(talk.comprehensionCheckedCount)}
                  <span className="text-lg text-content-muted"> / {count(talk.attendeeCount)}</span>
                </p>
                {comprehensionPct !== null ? (
                  <Progress
                    className="mt-1.5"
                    value={comprehensionPct}
                    max={100}
                    size="xs"
                    tone={comprehensionPct >= 80 ? "success" : comprehensionPct >= 40 ? "warning" : "danger"}
                  />
                ) : null}
                <p className="mt-1 text-2xs text-content-muted">
                  A signature says somebody was there. A comprehension check says somebody asked
                  them a question and got an answer.
                </p>
              </CardBody>
            </Card>
          </div>

          <DescriptionList items={facts} columns={2} dividers />

          {talk.contentSummary ? (
            <Card>
              <CardBody>
                <p className="text-label uppercase text-content-subtle">What was covered</p>
                <p className="mt-1 whitespace-pre-wrap text-body text-content">
                  {talk.contentSummary}
                </p>
              </CardBody>
            </Card>
          ) : null}

          {/* ------------------------------------------------------------ */}
          <section>
            <SectionHeading
              title={`Attendance sheet · ${count(talk.attendees.length)}`}
              hint={`${count(talk.registeredWorkerCount)} of them are in the worker register — the same register that carries induction and site access. The rest are names only.`}
            />
            {talk.attendees.length === 0 ? (
              <EmptyState
                size="sm"
                title="Nobody has been recorded as attending"
                hint="A talk with no attendance sheet is a talk that cannot be shown to have reached anybody. If it was delivered, the sheet is the evidence; if it was not, the register should say planned."
              />
            ) : (
              <ul className="space-y-1.5">
                {talk.attendees.map((a) => {
                  const weight = METHOD_WEIGHT[a.acknowledgementMethod] ?? "moderate";
                  return (
                    <li
                      key={a.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface-raised px-2.5 py-1.5"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-meta text-content">{a.name}</span>
                        <span className="block truncate text-2xs text-content-subtle">
                          {[a.trade, a.vendorId ? nameOf(vendors, a.vendorId) : null]
                            .filter(Boolean)
                            .join(" · ") || "no trade recorded"}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-wrap items-center gap-1.5">
                        {a.workerId ? (
                          <Badge tone="neutral" size="xs" variant="outline">
                            In the register
                          </Badge>
                        ) : (
                          <Badge tone="warning" size="xs" variant="outline">
                            Name only
                          </Badge>
                        )}
                        <Badge
                          tone={
                            weight === "strong" ? "success" : weight === "moderate" ? "info" : "warning"
                          }
                          size="xs"
                        >
                          {labelize(a.acknowledgementMethod)}
                        </Badge>
                        {a.comprehensionChecked ? (
                          <Badge tone="success" size="xs" dot>
                            Understood
                          </Badge>
                        ) : (
                          <Badge tone="neutral" size="xs" variant="outline">
                            Not checked
                          </Badge>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}

            <Card className="mt-3">
              <CardBody className="grid gap-3 sm:grid-cols-2">
                <Field label="Name" className="sm:col-span-2">
                  <Input
                    value={attendeeName}
                    placeholder="As it appears on the sheet"
                    onChange={(e) => setAttendeeName(e.target.value)}
                  />
                </Field>
                <Field
                  label="Worker id"
                  hint="Where the person is in the worker register, use their id — the inverse question (has this worker been briefed on confined spaces this month) is asked about a worker, not a talk."
                >
                  <Input
                    value={attendeeWorkerId}
                    onChange={(e) => setAttendeeWorkerId(e.target.value)}
                  />
                </Field>
                <Field label="How was attendance captured?">
                  <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                    {METHODS.map((m) => (
                      <option key={m} value={m}>
                        {labelize(m)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Comprehension checked?">
                  <Select
                    value={comprehension ? "true" : "false"}
                    onChange={(e) => setComprehension(e.target.value === "true")}
                  >
                    <option value="false">No — attendance only</option>
                    <option value="true">Yes — a question was asked and answered</option>
                  </Select>
                </Field>
                <div className="flex items-end">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={attendeeName.trim() === "" && attendeeWorkerId.trim() === ""}
                    loading={mutation.busy === "attendee"}
                    onClick={() =>
                      void mutation.run("attendee", "This attendee could not be added", async () => {
                        await api.post(
                          `/api/v1/projects/${projectId}/safety/toolbox-talks/${talk.id}/attendees`,
                          {
                            attendees: [
                              {
                                ...(attendeeName.trim() ? { name: attendeeName.trim() } : {}),
                                ...(attendeeWorkerId.trim()
                                  ? { workerId: attendeeWorkerId.trim() }
                                  : {}),
                                acknowledgementMethod: method,
                                comprehensionChecked: comprehension,
                              },
                            ],
                          },
                        );
                        setAttendeeName("");
                        setAttendeeWorkerId("");
                      })
                    }
                  >
                    Add to the sheet
                  </Button>
                </div>
              </CardBody>
            </Card>
          </section>

          {/* ------------------------------------------------------------ */}
          <section>
            <SectionHeading title="Delivery and verification" />
            <Card>
              <CardBody className="space-y-3">
                {talk.status === "planned" ? (
                  <>
                    <ReasonList
                      reasons={[
                        "This talk is still planned. Recording delivery is what turns it from an intention into evidence.",
                      ]}
                    />
                    <Button
                      size="sm"
                      loading={mutation.busy === "deliver"}
                      onClick={() =>
                        void mutation.run("deliver", "This talk could not be recorded as delivered", () =>
                          api.post(
                            `/api/v1/projects/${projectId}/safety/toolbox-talks/${talk.id}/deliver`,
                            {},
                          ),
                        )
                      }
                    >
                      Record as delivered
                    </Button>
                  </>
                ) : talk.verifiedAt ? (
                  <Alert tone="success" title={`Verified ${dateTime(talk.verifiedAt)}`}>
                    By {nameOf(users, talk.verifiedBy)}. {decimal(comprehensionPct ?? 0, 0)}% of
                    attendees had their comprehension checked.
                  </Alert>
                ) : (
                  <>
                    <Field label="Verification note">
                      <Textarea
                        rows={2}
                        value={verifyNote}
                        onChange={(e) => setVerifyNote(e.target.value)}
                      />
                    </Field>
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={mutation.busy === "verify"}
                      onClick={() =>
                        void mutation.run("verify", "This talk could not be verified", () =>
                          api.post(
                            `/api/v1/projects/${projectId}/safety/toolbox-talks/${talk.id}/verify`,
                            { ...(verifyNote.trim() ? { note: verifyNote.trim() } : {}) },
                          ),
                        )
                      }
                    >
                      Verify the talk happened
                    </Button>
                    <p className="text-2xs text-content-subtle">
                      Verification is never by the presenter. A talk evidenced only by the word of
                      the person who claims to have given it is the weakest record on the site.
                    </p>
                  </>
                )}
              </CardBody>
            </Card>
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}
