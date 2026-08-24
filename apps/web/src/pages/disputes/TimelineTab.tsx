/**
 * Timeline tab: the forward-only status stepper (notified → referred →
 * submissions → hearing → decided, with the settled/withdrawn branch), the
 * procedural timetable checklist whose deadlines are mirrored as assurance
 * Obligations, and status actions (#325-333, #338, #349).
 */
import { useState, type FormEvent } from "react";
import { api, ApiClientError } from "../../lib/api";
import { Badge, Button, Card, CardBody, ErrorAlert, Field, Input, Modal, Textarea } from "../../ui";
import { formatDate, humanize } from "../format";
import {
  CountdownBadge,
  daysUntilIso,
  FORWARD_ORDER,
  isTerminal,
  SectionTitle,
  type DisputeDetail,
  type TimetableStep,
} from "./disputesShared";

/* ------------------------------ Status stepper ------------------------------ */

function StatusStepper({ dispute }: { dispute: DisputeDetail }) {
  const branch = dispute.status === "settled" || dispute.status === "withdrawn";
  const currentIdx = FORWARD_ORDER.indexOf(dispute.status as (typeof FORWARD_ORDER)[number]);
  return (
    <div className="px-1 pb-2 pt-1">
      <div className="flex items-center">
        {FORWARD_ORDER.map((s, i) => {
          const reached = currentIdx >= 0 && i <= currentIdx;
          const current = i === currentIdx;
          return (
            <div key={s} className={`flex items-center ${i > 0 ? "flex-1" : ""}`}>
              {i > 0 ? (
                <div
                  className={`h-0.5 flex-1 ${reached && !branch ? "bg-brand-500" : "bg-ink-200"}`}
                />
              ) : null}
              <div className="flex flex-col items-center" title={humanize(s)}>
                <div
                  className={`h-3.5 w-3.5 rounded-full border-2 border-white shadow ${
                    branch
                      ? "bg-ink-300"
                      : current
                        ? "bg-brand-600 ring-2 ring-brand-200"
                        : reached
                          ? "bg-brand-600"
                          : "bg-ink-300"
                  }`}
                />
                <span
                  className={`mt-1 text-[10px] font-medium ${
                    current && !branch ? "text-brand-700" : "text-ink-500"
                  }`}
                >
                  {humanize(s)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      {branch ? (
        <p className="mt-2 text-xs text-ink-500">
          The procedural ladder ended early — the dispute {dispute.status === "settled" ? "settled" : "was withdrawn"} before a decision.
        </p>
      ) : null}
    </div>
  );
}

/* --------------------------------- The tab --------------------------------- */

export default function TimelineTab({
  projectId,
  dispute,
  onChanged,
}: {
  projectId: string;
  dispute: DisputeDetail;
  onChanged: () => Promise<void>;
}) {
  const base = `/api/v1/projects/${projectId}`;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const active = !isTerminal(dispute.status);
  const currentIdx = FORWARD_ORDER.indexOf(dispute.status as (typeof FORWARD_ORDER)[number]);
  const nextStatus =
    active && currentIdx >= 0 && currentIdx < FORWARD_ORDER.length - 2
      ? FORWARD_ORDER[currentIdx + 1]
      : null;

  async function changeStatus(status: string, outcome?: string) {
    setError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { status };
      if (outcome?.trim()) payload["outcome"] = outcome.trim();
      await api.post(`${base}/disputes/${dispute.id}/status`, payload);
      await onChanged();
      return true;
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Status change failed.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  /* decided modal (asks outcome) */
  const [decideOpen, setDecideOpen] = useState(false);
  const [decideOutcome, setDecideOutcome] = useState("");
  async function onDecide(e: FormEvent) {
    e.preventDefault();
    if (await changeStatus("decided", decideOutcome)) setDecideOpen(false);
  }

  /* settle modal (optional outcome) */
  const [settleOpen, setSettleOpen] = useState(false);
  const [settleOutcome, setSettleOutcome] = useState("");
  async function onSettle(e: FormEvent) {
    e.preventDefault();
    if (await changeStatus("settled", settleOutcome)) setSettleOpen(false);
  }

  /* withdraw confirm */
  const [withdrawOpen, setWithdrawOpen] = useState(false);

  /* timetable actions */
  async function completeStep(stepId: string) {
    setError(null);
    setBusy(true);
    try {
      await api.post(`${base}/disputes/${dispute.id}/timetable/${stepId}/complete`);
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to complete the step.");
    } finally {
      setBusy(false);
    }
  }

  const [newStepName, setNewStepName] = useState("");
  const [newStepDue, setNewStepDue] = useState("");
  async function addStep(e: FormEvent) {
    e.preventDefault();
    if (!newStepName.trim()) return;
    setError(null);
    setBusy(true);
    try {
      const timetable = [
        ...dispute.timetable.map((s) => ({ id: s.id, name: s.name, dueDate: s.dueDate })),
        { name: newStepName.trim(), ...(newStepDue ? { dueDate: newStepDue } : {}) },
      ];
      await api.patch(`${base}/disputes/${dispute.id}`, { timetable });
      setNewStepName("");
      setNewStepDue("");
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to add the step.");
    } finally {
      setBusy(false);
    }
  }

  function stepBadge(s: TimetableStep) {
    if (s.done) return <Badge tone="green">Done</Badge>;
    if (s.breachedAt) return <Badge tone="red">Missed</Badge>;
    if (s.obligationId) return <Badge tone="blue">Obligation</Badge>;
    return <Badge tone="gray">Undated</Badge>;
  }

  return (
    <div>
      <ErrorAlert message={error} />

      <Card className="mb-4">
        <CardBody>
          <div className="mb-2 text-sm font-semibold text-ink-900">Procedural status</div>
          <StatusStepper dispute={dispute} />
        </CardBody>
      </Card>

      {/* Status actions */}
      {active ? (
        <div className="mb-4 flex flex-wrap gap-2">
          {nextStatus ? (
            <Button disabled={busy} onClick={() => void changeStatus(nextStatus)}>
              Move to {humanize(nextStatus).toLowerCase()}
            </Button>
          ) : null}
          <Button variant="secondary" disabled={busy} onClick={() => setDecideOpen(true)}>
            Record decision…
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => setSettleOpen(true)}>
            Mark settled…
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setWithdrawOpen(true)}>
            Withdraw…
          </Button>
        </div>
      ) : null}

      {/* Timetable checklist (#330, #338) */}
      <SectionTitle>Procedural timetable ({dispute.timetable.length})</SectionTitle>
      {dispute.timetable.length === 0 ? (
        <p className="mb-3 text-xs text-ink-400">
          No timetable steps yet — dated steps materialize assurance obligations and feed the
          deadline radar.
        </p>
      ) : (
        <ul className="mb-3 divide-y divide-ink-100 rounded-md border border-ink-100">
          {dispute.timetable.map((s) => {
            const missed = !s.done && s.breachedAt !== null;
            const days = s.dueDate && !s.done ? daysUntilIso(s.dueDate) : null;
            return (
              <li
                key={s.id}
                className={`flex flex-wrap items-center gap-2 px-3 py-2 ${missed ? "bg-red-50" : ""}`}
              >
                <span
                  aria-hidden
                  className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${
                    s.done
                      ? "bg-emerald-600 text-white"
                      : missed
                        ? "bg-red-600 text-white"
                        : "bg-ink-100 text-ink-400"
                  }`}
                >
                  {s.done ? "✓" : missed ? "!" : ""}
                </span>
                <span
                  className={`text-sm ${missed ? "font-medium text-red-800" : "text-ink-800"} ${
                    s.done ? "line-through decoration-ink-300 text-ink-400" : ""
                  }`}
                >
                  {s.name}
                </span>
                {stepBadge(s)}
                <span className="ml-auto inline-flex items-center gap-2">
                  {s.dueDate ? (
                    <span className="text-xs text-ink-400">{formatDate(s.dueDate)}</span>
                  ) : null}
                  {days !== null ? <CountdownBadge days={days} /> : null}
                  {s.done && s.doneAt ? (
                    <span className="text-xs text-ink-400">done {formatDate(s.doneAt)}</span>
                  ) : null}
                  {!s.done && active ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void completeStep(s.id)}
                    >
                      Complete
                    </Button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {/* Add step */}
      {active ? (
        <form onSubmit={addStep} className="flex items-center gap-2">
          <Input
            value={newStepName}
            onChange={(e) => setNewStepName(e.target.value)}
            placeholder="Add a timetable step — e.g. Response due"
            className="flex-1"
          />
          <Input
            type="date"
            value={newStepDue}
            onChange={(e) => setNewStepDue(e.target.value)}
            className="w-40"
          />
          <Button type="submit" size="sm" variant="secondary" disabled={busy || !newStepName.trim()}>
            Add step
          </Button>
        </form>
      ) : null}

      {/* ------------------------------ decide modal ------------------------------ */}
      <Modal open={decideOpen} title="Record the decision" onClose={() => setDecideOpen(false)}>
        <p className="mb-3 text-sm text-ink-500">
          Recording a decision closes the dispute file — a decided dispute can no longer be edited.
        </p>
        <form onSubmit={onDecide} className="space-y-4">
          <Field label="Outcome" hint="Required — the decision or award in summary.">
            <Textarea
              required
              value={decideOutcome}
              onChange={(e) => setDecideOutcome(e.target.value)}
              placeholder="Adjudicator decided the sum of £412,000 is payable within 7 days…"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDecideOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Recording…" : "Record decision"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ------------------------------ settle modal ------------------------------ */}
      <Modal open={settleOpen} title="Mark the dispute settled" onClose={() => setSettleOpen(false)}>
        <p className="mb-3 text-sm text-ink-500">
          Settling closes the dispute file. If a settlement offer was accepted, prefer accepting it
          in the Settlement tab — that records the offer and settles the dispute in one step.
        </p>
        <form onSubmit={onSettle} className="space-y-4">
          <Field label="Settlement terms" hint="Optional summary of the agreed terms.">
            <Textarea
              value={settleOutcome}
              onChange={(e) => setSettleOutcome(e.target.value)}
              placeholder="Settled at £250,000 all-in, each party bearing its own costs…"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setSettleOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Settling…" : "Mark settled"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ----------------------------- withdraw modal ----------------------------- */}
      <Modal open={withdrawOpen} title="Withdraw the referral" onClose={() => setWithdrawOpen(false)}>
        <p className="mb-4 text-sm text-ink-700">
          Withdrawing closes the dispute file permanently — it cannot be reopened, and open
          timetable obligations stay on the assurance register until waived.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setWithdrawOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() =>
              void changeStatus("withdrawn").then((ok) => {
                if (ok) setWithdrawOpen(false);
              })
            }
          >
            {busy ? "Withdrawing…" : "Withdraw dispute"}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
