/**
 * ONE INTERVENTION POINT, rendered as the thing it actually is.
 *
 * This component is the centre of the ITP half of the workspace, so it is
 * built around a single question: MAY WORK PROCEED PAST THIS POINT? The API
 * answers that on every read (`mayProceed`), and the answer leads.
 *
 * Three facts that are routinely conflated are kept visually separate:
 *
 *   NOTICE     when the nominated party was told, by what method, and whether
 *              the contractual notice period has actually run. Where no notice
 *              period is recorded the platform says the period cannot be
 *              computed rather than assuming zero hours — assuming zero would
 *              license proceeding past a witness point the instant the
 *              invitation was sent.
 *   RELEASE    the nominated party attended and let the work go on.
 *   WAIVER     the party chose not to attend and said so in writing. This is a
 *              DIFFERENT FACT from an attended release and only one of them
 *              survives a challenge, so it is never drawn in the same colour.
 *
 * An unreleased hold point whose planned date has passed is drawn as loudly as
 * the design system allows: either the work is standing idle waiting for
 * somebody, or it went ahead without them, and the platform cannot tell which
 * from here.
 */
import { useState, type ReactNode } from "react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  Field,
  Input,
  Modal,
  Textarea,
} from "../../ui";
import { cx } from "../../ui/cx";
import {
  IconAlert,
  IconCheckCircle,
  IconLock,
  IconSend,
  IconSlash,
  IconUnlock,
} from "../../ui/icons";
import { toneClass } from "../../ui/tokens";
import { api } from "../../lib/api";
import SignOffChain from "./SignOffChain";
import {
  ACTIVITY_STATUS_TONE,
  EM_DASH,
  Facts,
  INTERVENTION_LABEL,
  INTERVENTION_MEANING,
  INTERVENTION_TONE,
  ReasonList,
  RefusalNotice,
  TONE_RAIL,
  dateTime,
  daysFromToday,
  isoDate,
  labelize,
  nameOf,
  plural,
  useAction,
  useReason,
} from "./qualityShared";
import type { ItpActivity } from "./types";

const TERMINAL = ["released", "waived", "closed", "not_applicable"];

export function isOverdueHoldPoint(a: ItpActivity): boolean {
  if (a.interventionPoint !== "hold_point") return false;
  if (TERMINAL.includes(a.status)) return false;
  if (!a.plannedDate) return false;
  return a.plannedDate < new Date().toISOString().slice(0, 10);
}

/** The one-line standing of a point, for a grid cell. */
export function ProceedCell({ activity }: { activity: ItpActivity }) {
  const overdue = isOverdueHoldPoint(activity);
  if (activity.mayProceed.allowed) {
    return (
      <Badge tone="success" size="xs" dot>
        Work may proceed
      </Badge>
    );
  }
  return (
    <div className="min-w-0 py-0.5">
      <Badge tone={overdue ? "danger" : "warning"} size="xs" variant={overdue ? "solid" : "subtle"}>
        {overdue ? "HELD · date passed" : "Work is held"}
      </Badge>
      {activity.mayProceed.reasons[0] ? (
        <p className="mt-0.5 whitespace-normal text-2xs leading-snug text-content-muted">
          {activity.mayProceed.reasons[0]}
        </p>
      ) : null}
    </div>
  );
}

/* ================================================================== */
/* The card                                                            */
/* ================================================================== */

export default function ActivityCard({
  activity,
  users,
  projectId,
  onMutated,
  showItpLink,
  onOpenItp,
}: {
  activity: ItpActivity;
  users: Map<string, string>;
  projectId: string;
  onMutated: () => void;
  showItpLink?: boolean;
  onOpenItp?: (itpId: string) => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const { ask, dialog } = useReason();
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [method, setMethod] = useState("Email to the nominated verifying party");
  const [note, setNote] = useState("");
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [releaseNote, setReleaseNote] = useState("");
  const [chainOpen, setChainOpen] = useState(false);
  /** bumped by every transition so the chain panel reloads with the card */
  const [chainVersion, setChainVersion] = useState(0);

  const overdue = isOverdueHoldPoint(activity);
  const held = !activity.mayProceed.allowed;
  const blocking = activity.interventionPoint === "hold_point";
  const terminal = TERMINAL.includes(activity.status);
  const daysLate = overdue ? Math.abs(daysFromToday(activity.plannedDate) ?? 0) : 0;
  const base = `/api/v1/projects/${projectId}/itps/${activity.itpId}/activities/${activity.id}`;

  async function serveNotice() {
    const done = await run("notify", () =>
      api.post(`${base}/notify`, {
        method: method.trim(),
        note: note.trim() === "" ? null : note.trim(),
      }),
    );
    if (done) {
      setNotifyOpen(false);
      setNote("");
      onMutated();
    }
  }

  async function release() {
    const done = await run("release", () =>
      api.post(`${base}/release`, {
        note: releaseNote.trim() === "" ? null : releaseNote.trim(),
      }),
    );
    if (done) {
      setReleaseOpen(false);
      setReleaseNote("");
      onMutated();
    }
  }

  /**
   * The explicit transitions. They replaced a patchable status: a hold point
   * used to be closable straight from a PATCH with no verifying party, no
   * reason and no record of who did it.
   */
  async function fail() {
    const reason = await ask({
      title: "Record a failed verification",
      description:
        "The verification happened and the work did not pass. Say what failed — it is what the contractor answers, and what the re-inspection is checked against.",
      label: "What failed?",
      confirmLabel: "Record the failure",
    });
    if (!reason) return;
    const done = await run("fail", () => api.post(`${base}/fail`, { reason }));
    if (done) {
      setChainVersion((n) => n + 1);
      onMutated();
    }
  }

  async function notApplicable() {
    const reason = await ask({
      title: "Mark the point not applicable",
      description:
        "Terminal, so it is segregated exactly like a release: the person who raised or served notice on a hold point may not be the one who decides it never applied.",
      label: "Why does this point not apply?",
      confirmLabel: "Record it",
    });
    if (!reason) return;
    const done = await run("na", () => api.post(`${base}/not-applicable`, { reason }));
    if (done) {
      setChainVersion((n) => n + 1);
      onMutated();
    }
  }

  async function closePoint() {
    const done = await run("close", () => api.post(`${base}/close`, {}));
    if (done) {
      setChainVersion((n) => n + 1);
      onMutated();
    }
  }

  async function reopen() {
    const reason = await ask({
      title: "Reopen this point",
      description:
        "Reopening clears the release and the waiver: a reopened point that still carried a signature would read as released by somebody who released different work.",
      label: "Why is it being reopened?",
      confirmLabel: "Reopen it",
    });
    if (!reason) return;
    const done = await run("reopen", () => api.post(`${base}/reopen`, { reason }));
    if (done) {
      setChainVersion((n) => n + 1);
      onMutated();
    }
  }

  async function waive() {
    const reason = await ask({
      title: `Waive ${INTERVENTION_LABEL[activity.interventionPoint] ?? "this point"}`,
      description:
        "A waived point is a different fact from an attended one. It only survives a challenge if the reason was written down at the time, so the API requires one here.",
      label: "Why is this point being waived?",
      confirmLabel: "Record the waiver",
    });
    if (!reason) return;
    const done = await run("waive", () => api.post(`${base}/waive`, { reason }));
    if (done) onMutated();
  }

  return (
    <Card
      className={cx(
        "border-l-4",
        TONE_RAIL[
          overdue
            ? "danger"
            : held
              ? blocking
                ? "danger"
                : "warning"
              : activity.status === "waived"
                ? "highlight"
                : activity.status === "released"
                  ? "success"
                  : "neutral"
        ],
      )}
    >
      <CardBody className="space-y-3">
        {/* ---------------- headline ---------------- */}
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone={INTERVENTION_TONE[activity.interventionPoint] ?? "neutral"} size="xs" variant="solid">
                {INTERVENTION_LABEL[activity.interventionPoint] ?? labelize(activity.interventionPoint)}
              </Badge>
              {activity.activityCode ? (
                <span className="font-mono text-2xs text-content-subtle">{activity.activityCode}</span>
              ) : null}
              <Badge tone={ACTIVITY_STATUS_TONE[activity.status] ?? "neutral"} size="xs" dot>
                {labelize(activity.status)}
              </Badge>
              {activity.status === "waived" ? (
                <Badge tone="highlight" size="xs" variant="outline">
                  waived, not attended
                </Badge>
              ) : null}
            </div>
            <h4 className="mt-1 text-sm font-semibold text-content">{activity.activity}</h4>
            {activity.description ? (
              <p className="mt-0.5 text-meta text-content-muted">{activity.description}</p>
            ) : null}
          </div>
          <div className="shrink-0 text-right">
            <div className="text-label uppercase tracking-wide text-content-subtle">Planned</div>
            <div
              className={cx(
                "text-meta tabular-nums",
                overdue ? cx("font-semibold", toneClass("danger", "text")) : "text-content",
              )}
            >
              {isoDate(activity.plannedDate)}
            </div>
          </div>
        </div>

        {/* ---------------- the unmissable band ---------------- */}
        {overdue ? (
          <div
            className={cx(
              "flex items-start gap-2.5 rounded-md border p-3",
              toneClass("danger", "subtle"),
              toneClass("danger", "border"),
            )}
          >
            <IconAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
            <div className="min-w-0">
              <p className="text-sm font-semibold">
                Unreleased hold point, {daysLate} {plural(daysLate, "day")} past its planned date
              </p>
              <p className="mt-0.5 text-meta">
                Either the work is standing idle waiting for {describeParties(activity)}, or it went
                ahead without them. The platform cannot tell which from here — which is exactly why
                a human is being asked. Planned {isoDate(activity.plannedDate)}, still{" "}
                {labelize(activity.status).toLowerCase()}.
              </p>
            </div>
          </div>
        ) : held ? (
          <div
            className={cx(
              "flex items-start gap-2.5 rounded-md border p-2.5",
              toneClass(blocking ? "danger" : "warning", "subtle"),
              toneClass(blocking ? "danger" : "warning", "border"),
            )}
          >
            <IconLock className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div className="min-w-0">
              <p className="text-meta font-semibold">Work may not proceed past this point</p>
              <ReasonList reasons={activity.mayProceed.reasons} className="mt-1 text-content-muted" />
            </div>
          </div>
        ) : (
          <div
            className={cx(
              "flex items-start gap-2.5 rounded-md border p-2.5",
              toneClass("success", "subtle"),
              toneClass("success", "border"),
            )}
          >
            <IconCheckCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p className="text-meta font-medium">
              Work may proceed past this point
              {activity.status === "waived"
                ? " — on a written waiver, not on an attendance."
                : activity.status === "released"
                  ? "."
                  : " — the notice period has run and the party did not attend."}
            </p>
          </div>
        )}

        {/* ---------------- notice / release / waiver, kept apart ---------------- */}
        <div className="grid gap-2.5 lg:grid-cols-3">
          <NoticePanel activity={activity} users={users} />
          <ReleasePanel activity={activity} users={users} />
          <WaiverPanel activity={activity} users={users} />
        </div>

        {/* ---------------- who holds it ---------------- */}
        <div className="rounded-md border border-border-subtle bg-surface-sunken p-2.5">
          <div className="text-label uppercase tracking-wide text-content-subtle">
            Nominated verifying {plural(activity.parsedVerifyingParties.length || 2, "party", "parties")}
          </div>
          {activity.parsedVerifyingParties.length === 0 ? (
            <p className="mt-1 text-meta text-content-muted">
              None nominated. A hold point released by nobody in particular is a signature on a
              blank line — the ITP is meant to name who holds it before the work starts, and the API
              refuses a release until it does.
            </p>
          ) : (
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {activity.parsedVerifyingParties.map((p, i) => (
                <li key={`${p.party}-${i}`}>
                  <Badge tone={p.userId ? "accent" : "neutral"} size="xs" variant="outline">
                    {labelize(p.party)}
                    {p.name ? ` · ${p.name}` : ""}
                    {p.userId ? " · platform user" : " · organisation only"}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
          {activity.parsedVerifyingParties.length > 0 &&
          activity.parsedVerifyingParties.every((p) => !p.userId) ? (
            <p className="mt-1.5 text-2xs text-content-subtle">
              No nominated party has a platform account, so the release cannot be matched to a named
              user. The API falls back to refusing self-release: whoever raised the point may not
              also release it.
            </p>
          ) : null}
        </div>

        {/* ---------------- the sign-off chain ---------------- */}
        {activity.interventionPoint !== "surveillance_point" ? (
          <div>
            <button
              type="button"
              className="text-2xs font-medium text-content-muted underline-offset-2 hover:underline"
              onClick={() => setChainOpen((open) => !open)}
            >
              {chainOpen ? "Hide the sign-off chain" : "Sign-off chain — who signs, in what order"}
            </button>
            {chainOpen ? (
              <div className="mt-1.5">
                <SignOffChain
                  projectId={projectId}
                  itpId={activity.itpId}
                  activityId={activity.id}
                  users={users}
                  version={chainVersion}
                  onMutated={onMutated}
                />
              </div>
            ) : null}
          </div>
        ) : null}

        {/* ---------------- criteria ---------------- */}
        <Facts
          columns={3}
          items={[
            { label: "Responsible party", value: labelize(activity.responsibleParty) },
            activity.acceptanceCriteria
              ? { label: "Acceptance criteria", value: activity.acceptanceCriteria }
              : null,
            activity.testMethod ? { label: "Test method", value: activity.testMethod } : null,
            activity.frequency ? { label: "Frequency", value: activity.frequency } : null,
            activity.recordRequired
              ? { label: "Record required", value: activity.recordRequired }
              : null,
            activity.specReference ? { label: "Specification", value: activity.specReference } : null,
            activity.drawingReference ? { label: "Drawing", value: activity.drawingReference } : null,
            activity.actualDate ? { label: "Actual date", value: isoDate(activity.actualDate) } : null,
          ]}
        />

        <p className="text-2xs italic text-content-subtle">
          {INTERVENTION_MEANING[activity.interventionPoint] ?? ""}
        </p>

        <RefusalNotice refusal={refusal} onDismiss={clear} />

        {/* ---------------- actions ---------------- */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle pt-2.5">
          <Button
            size="sm"
            variant="secondary"
            icon={IconSend}
            disabled={terminal || activity.interventionPoint === "surveillance_point"}
            onClick={() => setNotifyOpen(true)}
          >
            {activity.notifiedAt ? "Serve notice again" : "Serve notice"}
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={IconUnlock}
            disabled={terminal || activity.interventionPoint === "surveillance_point"}
            onClick={() => setReleaseOpen(true)}
          >
            Release
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={IconSlash}
            disabled={terminal}
            loading={busy === "waive"}
            onClick={waive}
          >
            Waive
          </Button>
          {showItpLink && onOpenItp ? (
            <Button size="sm" variant="ghost" onClick={() => onOpenItp(activity.itpId)}>
              Open the plan
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            icon={IconAlert}
            disabled={terminal}
            loading={busy === "fail"}
            onClick={fail}
          >
            Fail
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={terminal}
            loading={busy === "na"}
            onClick={notApplicable}
          >
            Not applicable
          </Button>
          {activity.status === "released" || activity.status === "waived" ? (
            <Button size="sm" variant="ghost" loading={busy === "close"} onClick={closePoint}>
              Close
            </Button>
          ) : null}
          {terminal ? (
            <Button size="sm" variant="ghost" loading={busy === "reopen"} onClick={reopen}>
              Reopen
            </Button>
          ) : null}
          {terminal ? (
            <span className="text-2xs text-content-subtle">
              This point is {labelize(activity.status).toLowerCase()} — reopening it clears the
              release, because a signature belongs to the work it was given against.
            </span>
          ) : null}
        </div>
      </CardBody>

      {/* ---------------- notice dialog ---------------- */}
      <Modal
        open={notifyOpen}
        onClose={() => setNotifyOpen(false)}
        title="Serve notice on the verifying party"
        description="The dispute is never about whether they turned up. It is about whether notice was served — so the method and the timestamp are the record."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setNotifyOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy === "notify"}
              disabled={method.trim().length === 0}
              onClick={serveNotice}
            >
              Record the notice
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <Field
            label="How was notice served?"
            required
            hint="Recorded verbatim — “Email to J. Okafor, Arup, 14:05” is worth more than “email”."
          >
            <Input value={method} onChange={(e) => setMethod(e.target.value)} />
          </Field>
          <Field label="Note" hint="Optional. Stored with the notice on the activity.">
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <p className="text-2xs text-content-subtle">
            {activity.noticePeriodHours === null
              ? "No notice period is recorded on this activity, so the platform will not be able to compute when the notice has run. Add one to the activity if the contract sets one."
              : `The contractual notice period on this activity is ${activity.noticePeriodHours} hours.`}
          </p>
        </div>
      </Modal>

      {/* ---------------- release dialog ---------------- */}
      <Modal
        open={releaseOpen}
        onClose={() => setReleaseOpen(false)}
        title="Release this point"
        description="Release is reserved to the nominated verifying party. Where the nomination names organisations rather than users, the person who raised the point may not also release it — the API refuses that outright."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setReleaseOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy === "release"} onClick={release}>
              Record the release
            </Button>
          </div>
        }
      >
        <Field label="Release note" hint="Optional, and worth writing: it is what the release means.">
          <Textarea rows={3} value={releaseNote} onChange={(e) => setReleaseNote(e.target.value)} />
        </Field>
      </Modal>

      {dialog}
    </Card>
  );
}

function describeParties(activity: ItpActivity): string {
  if (activity.parsedVerifyingParties.length === 0) return "a party nobody named";
  return activity.parsedVerifyingParties
    .map((p) => (p.name ? `${labelize(p.party)} (${p.name})` : labelize(p.party)))
    .join(", ");
}

/* ================================================================== */
/* The three panels                                                    */
/* ================================================================== */

function Panel({
  title,
  tone,
  icon,
  children,
}: {
  title: string;
  tone: "neutral" | "info" | "success" | "highlight" | "warning";
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={cx(
        "rounded-md border p-2.5",
        tone === "neutral"
          ? "border-border bg-surface-raised"
          : cx(toneClass(tone, "subtle"), toneClass(tone, "border")),
      )}
    >
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="text-label uppercase tracking-wide">{title}</span>
      </div>
      <div className="mt-1.5 space-y-1 text-2xs leading-snug">{children}</div>
    </div>
  );
}

function NoticePanel({ activity, users }: { activity: ItpActivity; users: Map<string, string> }) {
  const notice = activity.notice;
  return (
    <Panel
      title="Notice"
      tone={notice.served ? "info" : "neutral"}
      icon={<IconSend className="size-3.5" />}
    >
      {!notice.served ? (
        <p className="text-content-muted">
          {notice.reasons[0] ?? "No notice has been served on this activity."}
        </p>
      ) : (
        <>
          <Line label="Served" value={dateTime(notice.servedAt)} />
          <Line label="By" value={nameOf(users, activity.notifiedBy)} />
          <Line label="Method" value={activity.notificationMethod ?? EM_DASH} />
          <Line
            label="Period"
            value={
              notice.noticePeriodHours === null
                ? "not recorded"
                : `${notice.noticePeriodHours} hours`
            }
          />
          <Line
            label="Runs out"
            value={
              notice.noticeExpiresAt === null ? "cannot be computed" : dateTime(notice.noticeExpiresAt)
            }
          />
          <div className="pt-0.5">
            <Badge tone={notice.noticeElapsed ? "success" : "warning"} size="xs" dot>
              {notice.noticeElapsed ? "Notice period has run" : "Notice period still running"}
            </Badge>
          </div>
          <ReasonList reasons={notice.reasons} className="pt-0.5" />
        </>
      )}
    </Panel>
  );
}

function ReleasePanel({ activity, users }: { activity: ItpActivity; users: Map<string, string> }) {
  const released = activity.status === "released" || activity.releasedAt !== null;
  return (
    <Panel
      title="Release"
      tone={released ? "success" : "neutral"}
      icon={<IconUnlock className="size-3.5" />}
    >
      {!released ? (
        <p className="text-content-muted">
          Not released. Release is the nominated party attending and letting the work go on — it is
          not the same thing as a waiver and is not recorded as one.
        </p>
      ) : (
        <>
          <Line label="Released" value={dateTime(activity.releasedAt)} />
          <Line label="By" value={nameOf(users, activity.releasedBy)} />
          {activity.releaseNote ? (
            <p className="whitespace-pre-wrap pt-0.5 text-content-muted">{activity.releaseNote}</p>
          ) : (
            <p className="pt-0.5 text-content-subtle">No release note was recorded.</p>
          )}
        </>
      )}
    </Panel>
  );
}

function WaiverPanel({ activity, users }: { activity: ItpActivity; users: Map<string, string> }) {
  const waived = activity.status === "waived" || activity.waivedAt !== null;
  return (
    <Panel
      title="Waiver"
      tone={waived ? "highlight" : "neutral"}
      icon={<IconSlash className="size-3.5" />}
    >
      {!waived ? (
        <p className="text-content-muted">
          Not waived. A waiver is the party choosing not to attend, in writing — a weaker fact than
          an attendance, and recorded separately for that reason.
        </p>
      ) : (
        <>
          <Line label="Waived" value={dateTime(activity.waivedAt)} />
          <Line label="By" value={nameOf(users, activity.waivedBy)} />
          <p className="whitespace-pre-wrap pt-0.5">
            {activity.waiverReason ?? "No reason was recorded — which should not be possible."}
          </p>
          <p className="pt-0.5 italic text-content-subtle">
            This point was not attended. Under challenge, that distinction is the whole argument.
          </p>
        </>
      )}
    </Panel>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1.5">
      <span className="shrink-0 text-content-subtle">{label}</span>
      <span className="min-w-0 break-words font-medium">{value}</span>
    </div>
  );
}
