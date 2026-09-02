/**
 * ONE ACTION ITEM — the thing this module actually exists for.
 *
 * Three details are non-negotiable on this card:
 *
 *  · THE ORIGINAL DUE DATE travels beside the current one whenever the date
 *    has been moved. Re-dating is slippage, it is recorded in `revisedCount`
 *    and `originalDueDate`, and the overdue signal raised against the action
 *    was deliberately NOT cleared by the move. A moved date must not look
 *    clean.
 *  · THE CARRY COUNT is shown wherever it is above zero, escalating to solid
 *    red at three. An action discussed at four meetings is not "in progress".
 *  · PROMOTION IS EXPLAINED BEFORE IT IS OFFERED. Promoting an action to an
 *    obligation moves the time bar out of this module for good; the dialog
 *    says exactly what changes, and it refuses to invent the two things an
 *    obligation cannot exist without — the clause it discharges and the date
 *    it bites.
 */
import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Field,
  Input,
  Modal,
  Textarea,
  Tooltip,
  useConfirm,
} from "../../ui";
import { cx } from "../../ui/cx";
import { IconAssurance, IconWarning } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  ACTION_STATUS_TONE,
  CarryBadge,
  DueDate,
  EM_DASH,
  PRIORITY_TONE,
  RefusalPanel,
  count,
  dateTime,
  isoDate,
  titleCase,
  todayISO,
  useAction,
  type ActionItem,
  type PromoteResult,
} from "./meetingsShared";

export default function ActionItemCard({
  projectId,
  action,
  onMutated,
  showMeeting = false,
}: {
  projectId: string;
  action: ActionItem;
  onMutated: () => void;
  showMeeting?: boolean;
}) {
  const { busy, refusal, clear, run } = useAction();
  const { confirm, dialog } = useConfirm();
  const [expanded, setExpanded] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [redateOpen, setRedateOpen] = useState(false);
  const [promoted, setPromoted] = useState<PromoteResult | null>(null);

  const a = action;
  const path = `/api/v1/projects/${projectId}/meeting-action-items/${a.id}`;
  const open = a.status === "open" || a.status === "in_progress" || a.status === "blocked";
  const overdue = a.isOverdue ?? (open && a.dueDate !== null && a.dueDate < todayISO());
  const promotedAlready = a.obligationId !== null;

  async function post(key: string, verb: string, body?: unknown) {
    const done = await run(key, () => api.post(`${path}/${verb}`, body ?? {}));
    if (done !== null) onMutated();
  }

  async function complete() {
    const ok = await confirm({
      title: `Mark ${a.reference} complete?`,
      description:
        "Completion is your assertion that it was done. It is not verification — somebody who did not complete it has to confirm that separately, because self-verification is the absence of verification.",
      confirmLabel: "Mark complete",
    });
    if (ok) await post("complete", "complete");
  }

  async function verify() {
    const ok = await confirm({
      title: `Verify ${a.reference}?`,
      description:
        "You are asserting that this action was actually done. The platform refuses this to whoever completed it — if that was you, ask someone else.",
      confirmLabel: "Verify it",
      tone: "warning",
    });
    if (ok) await post("verify", "verify");
  }

  return (
    <div
      className={cx(
        "rounded-lg border p-3",
        overdue
          ? "border-danger-border bg-danger-subtle/40"
          : a.carryCount >= 3
            ? "border-warning-border bg-warning-subtle/40"
            : "border-border bg-surface-raised",
      )}
    >
      {dialog}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-2xs text-content-subtle">{a.reference}</span>
            <span className="text-sm font-semibold text-content">{a.title}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge tone={ACTION_STATUS_TONE[a.status] ?? "neutral"} size="xs" dot>
              {titleCase(a.status)}
            </Badge>
            <Badge tone={PRIORITY_TONE[a.priority] ?? "neutral"} size="xs" variant="outline">
              {titleCase(a.priority)}
            </Badge>
            <CarryBadge carryCount={a.carryCount} />
            {overdue ? (
              <Badge tone="danger" size="xs" variant="solid" icon={IconWarning}>
                Overdue
              </Badge>
            ) : null}
            {promotedAlready ? (
              <Tooltip content="This action has been promoted to an obligation. The obligation owns the time bar now; the action item owns the conversation.">
                <span>
                  <Badge tone="accent" size="xs" icon={IconAssurance}>
                    Promoted to an obligation
                  </Badge>
                </span>
              </Tooltip>
            ) : null}
            {a.signalId ? (
              <Tooltip content="An overdue signal was raised against this action and is still open. Re-dating the action does not clear it — that is deliberate, so a slipped promise cannot be made to look clean.">
                <span>
                  <Badge tone="warning" size="xs" variant="outline">
                    Signal open
                  </Badge>
                </span>
              </Tooltip>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <DueDate
            dueDate={a.dueDate}
            originalDueDate={a.originalDueDate}
            revisedCount={a.revisedCount}
            overdue={overdue}
            className="text-right text-meta"
          />
          <span className="text-2xs text-content-subtle">
            {a.ownerName ?? a.ownerId ?? (
              <span className="italic text-danger-fg">no owner — an action nobody owns is a wish</span>
            )}
          </span>
        </div>
      </div>

      <RefusalPanel refusal={refusal} onDismiss={clear} />

      {promoted ? (
        <Alert
          tone="success"
          size="sm"
          className="mt-2"
          title="Promoted — the time bar has moved"
          onDismiss={() => setPromoted(null)}
        >
          <p>{promoted.note}</p>
          <p className="mt-1 text-2xs">
            Obligation <span className="font-mono">{promoted.obligation.id}</span> · clause{" "}
            {promoted.obligation.sourceClause} · bites {dateTime(promoted.obligation.deadline)}
          </p>
        </Alert>
      ) : null}

      {a.blockedReason && a.status === "blocked" ? (
        <p className="mt-2 text-meta text-danger-fg">
          <span className="font-medium">Blocked:</span> {a.blockedReason}
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {open ? (
          <>
            <Button size="xs" loading={busy === "complete"} onClick={() => void complete()}>
              Complete
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setRedateOpen(true)}>
              Re-date
            </Button>
          </>
        ) : null}
        {a.status === "completed" ? (
          <Button size="xs" loading={busy === "verify"} onClick={() => void verify()}>
            Verify
          </Button>
        ) : null}
        {open && !promotedAlready ? (
          <Button size="xs" variant="secondary" onClick={() => setPromoteOpen(true)}>
            Promote to an obligation…
          </Button>
        ) : null}
        <Button size="xs" variant="ghost" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Less" : "Detail"}
        </Button>
      </div>

      {expanded ? (
        <div className="mt-3 space-y-3">
          {a.description ? (
            <p className="text-meta text-content-muted">{a.description}</p>
          ) : null}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-2xs sm:grid-cols-3">
            <Detail label="Raised" value={isoDate(a.createdAt)} />
            <Detail label="Originally due" value={isoDate(a.originalDueDate)} />
            <Detail
              label="Times re-dated"
              value={a.revisedCount === 0 ? "never" : `${count(a.revisedCount)}`}
            />
            <Detail
              label="Discussed at"
              value={`${count(a.carryCount + 1)} meeting${a.carryCount === 0 ? "" : "s"}`}
            />
            <Detail label="Completed" value={a.completedAt ? dateTime(a.completedAt) : EM_DASH} />
            <Detail label="Verified" value={a.verifiedAt ? dateTime(a.verifiedAt) : EM_DASH} />
            <Detail label="Source clause" value={a.sourceClause ?? EM_DASH} />
            <Detail label="Deadline" value={a.deadline ? dateTime(a.deadline) : EM_DASH} />
            <Detail
              label="Evidence required"
              value={a.evidenceRequirement ?? "none recorded"}
            />
          </dl>
          {showMeeting && a.meetingId ? (
            <p className="text-2xs text-content-subtle">
              Agreed at meeting <span className="font-mono">{a.meetingId}</span>.
            </p>
          ) : null}
          {a.closureNote ? (
            <p className="text-meta text-content-muted">
              <span className="font-medium text-content">Closure note:</span> {a.closureNote}
            </p>
          ) : null}
        </div>
      ) : null}

      <RedateModal
        open={redateOpen}
        path={path}
        action={a}
        onClose={() => setRedateOpen(false)}
        onDone={() => {
          setRedateOpen(false);
          onMutated();
        }}
      />
      <PromoteModal
        open={promoteOpen}
        path={path}
        action={a}
        onClose={() => setPromoteOpen(false)}
        onDone={(result) => {
          setPromoteOpen(false);
          setPromoted(result);
          onMutated();
        }}
      />
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="contents">
      <dt className="text-content-subtle">{label}</dt>
      <dd className="text-content">{value}</dd>
    </div>
  );
}

/**
 * Re-dating, with the consequence stated up front. The dialog does not
 * pretend the move is neutral: it names what will be recorded and what will
 * NOT be cleared.
 */
function RedateModal({
  open,
  path,
  action,
  onClose,
  onDone,
}: {
  open: boolean;
  path: string;
  action: ActionItem;
  onClose: () => void;
  onDone: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [dueDate, setDueDate] = useState(action.dueDate ?? "");

  async function submit() {
    const done = await run("redate", () => api.patch(path, { dueDate: dueDate || null }));
    if (done !== null) onDone();
  }

  const original = action.originalDueDate ?? action.dueDate;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Move the due date on ${action.reference}`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy !== null || dueDate === (action.dueDate ?? "")}
            loading={busy === "redate"}
            onClick={() => void submit()}
          >
            Move the date
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
        <Alert tone="warning" variant="subtle" size="sm" title="Moving a date is recorded as slippage">
          <p>
            The original date{original ? ` (${isoDate(original)})` : ""} survives on the record and
            the move count goes to {count(action.revisedCount + 1)}. If an overdue signal has been
            raised against this action it stays open — re-dating is not a way to make the warning
            disappear, and the slippage ends up on the record twice.
          </p>
        </Alert>
        <Field
          label="New due date"
          hint="Leave blank to remove the date entirely — an action with no date can never be overdue and can never be promoted."
        >
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

/**
 * PROMOTION — explained before it is done.
 *
 * The action item already carries the obligation column shape, so this is a
 * copy rather than a re-keying. What the dialog has to make clear is the part
 * that is irreversible in practice: the time bar leaves this module. From then
 * on the obligations sweep warns about the deadline, the meetings sweep skips
 * the action, and cancelling the action is refused.
 */
function PromoteModal({
  open,
  path,
  action,
  onClose,
  onDone,
}: {
  open: boolean;
  path: string;
  action: ActionItem;
  onClose: () => void;
  onDone: (result: PromoteResult) => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [sourceClause, setSourceClause] = useState(action.sourceClause ?? "");
  const [deadline, setDeadline] = useState(
    action.deadline ? action.deadline.slice(0, 10) : (action.dueDate ?? ""),
  );
  const [evidenceRequirement, setEvidenceRequirement] = useState(action.evidenceRequirement ?? "");
  const [warnDaysBefore, setWarnDaysBefore] = useState(
    action.warnDaysBefore !== null ? String(action.warnDaysBefore) : "",
  );

  async function submit() {
    const warn = warnDaysBefore.trim() === "" ? null : Number(warnDaysBefore);
    const result = await run("promote", () =>
      api.post<PromoteResult>(`${path}/promote`, {
        sourceClause: sourceClause.trim() || undefined,
        deadline: deadline ? `${deadline}T23:59:59.000Z` : undefined,
        warnDaysBefore: warn !== null && Number.isFinite(warn) ? warn : null,
        evidenceRequirement: evidenceRequirement.trim() || null,
      }),
    );
    if (result) onDone(result);
  }

  const missingClause = sourceClause.trim().length === 0;
  const missingDeadline = deadline.trim().length === 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Promote ${action.reference} to an obligation`}
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={missingClause || missingDeadline || busy !== null}
            loading={busy === "promote"}
            onClick={() => void submit()}
          >
            Promote it
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {refusal ? (
          <Alert tone="warning" size="sm" title="Promotion refused" onDismiss={clear}>
            <p className="whitespace-pre-wrap">{refusal.message}</p>
          </Alert>
        ) : null}

        <Alert tone="info" title="What promotion actually does">
          <ul className="mt-1 space-y-1 text-meta">
            <li>
              A real <strong>obligation</strong> is created, carrying the clause it discharges, the
              date it bites, who owes it, who is owed it and what evidence discharges it.
            </li>
            <li>
              <strong>The time bar leaves this module.</strong> From then on the obligations sweep
              warns about the deadline and the meetings sweep skips this action — two systems warning
              about one deadline is how a warning gets ignored.
            </li>
            <li>
              <strong>The action can no longer be cancelled here.</strong> You would cancel or waive
              the obligation instead.
            </li>
            <li>
              The conversation stays with the action item; the duty moves. Both rows are written
              with the same clause and deadline so they cannot drift into telling different stories.
            </li>
          </ul>
        </Alert>

        <Alert tone="warning" variant="subtle" size="sm" title="Two things will not be invented">
          An obligation must name the clause it discharges and the date it bites. This platform
          refuses to guess either — a fabricated time bar is worse than no time bar, because someone
          would rely on it.
        </Alert>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Clause this discharges"
            required
            error={missingClause ? "An obligation must name its contractual basis." : null}
            className="sm:col-span-2"
          >
            <Input
              value={sourceClause}
              placeholder="Clause 20.1 — notice of claim"
              onChange={(e) => setSourceClause(e.target.value)}
            />
          </Field>
          <Field
            label="Date it bites"
            required
            error={missingDeadline ? "An obligation must have a date it bites." : null}
            hint={
              action.dueDate
                ? `Defaults to the action's due date (${isoDate(action.dueDate)}), at end of day.`
                : "This action has no due date, so there is nothing to default to."
            }
          >
            <Input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </Field>
          <Field label="Warn this many days before">
            <Input
              type="number"
              min={0}
              value={warnDaysBefore}
              onChange={(e) => setWarnDaysBefore(e.target.value)}
            />
          </Field>
          <Field
            label="What evidence discharges it?"
            className="sm:col-span-2"
            hint="Left blank, the obligation records that no evidence requirement was stated — rather than implying none is needed."
          >
            <Textarea
              rows={2}
              value={evidenceRequirement}
              onChange={(e) => setEvidenceRequirement(e.target.value)}
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
