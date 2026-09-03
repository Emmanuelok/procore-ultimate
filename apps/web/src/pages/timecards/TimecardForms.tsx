/**
 * THE WRITE SIDE of the timecards workspace.
 *
 * Two things happen here that nothing else on the platform does, and both are
 * about refusals rather than fields:
 *
 *  • A card is entered as WORKED HOURS and classified under the crew's own
 *    overtime rule, or as an EXPLICIT SPLIT which is recorded as somebody's
 *    assertion rather than a derivation. The form says which is happening,
 *    because "8 + 2 overtime" typed by a foreman and "10 hours classified
 *    under a 40-hour weekly rule" are different claims.
 *  • The batch is where approval happens, and the API refuses a batch whose
 *    cards the approver raised, whose coding no longer reconciles, or whose
 *    variances nobody explained. Those refusals are rendered verbatim: each
 *    one names the cards, and the names are the point.
 */
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button, Field, Input, Modal, Select, Textarea } from "../../ui";
import { api } from "../../lib/api";
import {
  RefusalNotice,
  today,
  useAction,
  type BatchRecord,
  type CostCodeOption,
  type CrewRecord,
} from "./timecardsShared";

function ModalShell({
  open,
  onClose,
  title,
  description,
  busy,
  refusal,
  clearRefusal,
  submitLabel,
  onSubmit,
  disabled,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  busy: boolean;
  refusal: ReturnType<typeof useAction>["refusal"];
  clearRefusal: () => void;
  submitLabel: string;
  onSubmit: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      {...(description ? { description } : {})}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={disabled} onClick={onSubmit}>
            {submitLabel}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {refusal ? <RefusalNotice refusal={refusal} onDismiss={clearRefusal} /> : null}
        {children}
      </div>
    </Modal>
  );
}

export interface WorkerOption {
  id: string;
  reference: string;
  fullName: string;
}

/* ========================================================================== */
/* Raise a timecard                                                            */
/* ========================================================================== */

export function TimecardCreateModal({
  open,
  onClose,
  onDone,
  projectId,
  workers,
  crews,
  costCodes,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  projectId: string;
  workers: WorkerOption[];
  crews: CrewRecord[];
  costCodes: CostCodeOption[];
}) {
  const { busy, refusal, clear, run } = useAction();
  const [mode, setMode] = useState<"worked" | "split" | "clock">("worked");
  const [workerId, setWorkerId] = useState("");
  const [crewId, setCrewId] = useState("");
  const [workDate, setWorkDate] = useState(today());
  const [shift, setShift] = useState("day");
  const [workedHours, setWorkedHours] = useState("8");
  const [startTime, setStartTime] = useState("07:30");
  const [endTime, setEndTime] = useState("17:00");
  const [breakMinutes, setBreakMinutes] = useState("30");
  const [regularHours, setRegularHours] = useState("8");
  const [overtimeHours, setOvertimeHours] = useState("0");
  const [doubleTimeHours, setDoubleTimeHours] = useState("0");
  const [idleHours, setIdleHours] = useState("");
  const [idleReason, setIdleReason] = useState("");
  const [allocCostCodeId, setAllocCostCodeId] = useState("");
  const [allocQuantity, setAllocQuantity] = useState("");
  const [allocUnit, setAllocUnit] = useState("");
  const [notes, setNotes] = useState("");
  const [weekNote, setWeekNote] = useState<string | null>(null);

  const num = (v: string) => (v === "" ? undefined : Number(v));

  async function submit() {
    const hoursBlock =
      mode === "worked"
        ? { workedHours: num(workedHours) }
        : mode === "clock"
          ? { startTime, endTime, breakMinutes: num(breakMinutes) }
          : {
              regularHours: num(regularHours) ?? 0,
              overtimeHours: num(overtimeHours) ?? 0,
              doubleTimeHours: num(doubleTimeHours) ?? 0,
            };
    /*
     * The card is created FIRST and coded second, because the coding has to
     * reconcile with the classified split bucket by bucket — and under a
     * weekly rule the browser cannot know what that split will be until the
     * server has applied the crew's rule to the week.
     */
    const created = await run("create", () =>
      api.post<{
        id: string;
        weekReclassified?: unknown[];
        regularHours: number;
        overtimeHours: number;
        doubleTimeHours: number;
        premiumHours: number;
      }>(`/api/v1/projects/${projectId}/timecards`, {
        workerId,
        crewId: crewId || null,
        workDate,
        shift,
        ...hoursBlock,
        idleHours: num(idleHours),
        idleReason: idleReason || null,
        notes: notes.trim() || null,
      }),
    );
    if (created && allocCostCodeId) {
      await run("allocate", () =>
        api.put(`/api/v1/projects/${projectId}/timecards/${created.id}/allocations`, {
          allocations: [
            {
              costCodeId: allocCostCodeId,
              regularHours: created.regularHours,
              overtimeHours: created.overtimeHours,
              doubleTimeHours: created.doubleTimeHours,
              premiumHours: created.premiumHours,
              quantity: num(allocQuantity),
              unit: allocUnit.trim() || null,
            },
          ],
        }),
      );
    }
    if (created) {
      const reclassified = created.weekReclassified?.length ?? 0;
      setWeekNote(
        reclassified > 0
          ? `${reclassified} other card(s) in the same pay week were repriced: a weekly overtime ` +
              "rule reprices the whole week when any day in it changes."
          : null,
      );
      toast.success("Timecard raised");
      onDone();
      if (reclassified === 0) onClose();
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Raise a timecard"
      description="One worker, one day, one shift. The hours are classified under the crew's own overtime rule — there is no platform default, because 8 a day is Californian and 48 a week is the Working Time Directive."
      busy={busy === "create"}
      refusal={refusal}
      clearRefusal={clear}
      submitLabel="Raise it"
      disabled={workerId === ""}
      onSubmit={submit}
    >
      {weekNote ? (
        <p className="rounded-md bg-surface-sunken p-2 text-meta text-content-muted">{weekNote}</p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Worker" required>
          <Select value={workerId} onChange={(e) => setWorkerId(e.target.value)}>
            <option value="">— choose —</option>
            {workers.map((w) => (
              <option key={w.id} value={w.id}>
                {w.reference} · {w.fullName}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Crew"
          hint="Left blank, the crew the worker belonged to on that DATE is used — dated membership, not a flag."
        >
          <Select value={crewId} onChange={(e) => setCrewId(e.target.value)}>
            <option value="">— from dated membership —</option>
            {crews.map((c) => (
              <option key={c.id} value={c.id}>
                {c.reference} · {c.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Work date" required>
          <Input type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} />
        </Field>
        <Field label="Shift">
          <Select value={shift} onChange={(e) => setShift(e.target.value)}>
            <option value="day">Day</option>
            <option value="night">Night</option>
            <option value="weekend">Weekend</option>
            <option value="holiday">Holiday</option>
          </Select>
        </Field>
        <Field label="How the hours are given">
          <Select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="worked">Worked hours (classified)</option>
            <option value="clock">Clock times (classified)</option>
            <option value="split">Explicit split (asserted)</option>
          </Select>
        </Field>
      </div>

      {mode === "worked" ? (
        <Field label="Worked hours" required hint="Net of unpaid breaks.">
          <Input
            type="number"
            step="0.25"
            value={workedHours}
            onChange={(e) => setWorkedHours(e.target.value)}
          />
        </Field>
      ) : mode === "clock" ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Start">
            <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          </Field>
          <Field label="End">
            <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
          </Field>
          <Field label="Break (minutes)">
            <Input
              type="number"
              value={breakMinutes}
              onChange={(e) => setBreakMinutes(e.target.value)}
            />
          </Field>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Plain time">
            <Input
              type="number"
              step="0.25"
              value={regularHours}
              onChange={(e) => setRegularHours(e.target.value)}
            />
          </Field>
          <Field label="Overtime">
            <Input
              type="number"
              step="0.25"
              value={overtimeHours}
              onChange={(e) => setOvertimeHours(e.target.value)}
            />
          </Field>
          <Field label="Double time">
            <Input
              type="number"
              step="0.25"
              value={doubleTimeHours}
              onChange={(e) => setDoubleTimeHours(e.target.value)}
            />
          </Field>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Idle hours" optional hint="A memo on hours already paid, never an addition.">
          <Input
            type="number"
            step="0.25"
            value={idleHours}
            onChange={(e) => setIdleHours(e.target.value)}
          />
        </Field>
        <Field label="Idle reason" optional>
          <Select value={idleReason} onChange={(e) => setIdleReason(e.target.value)}>
            <option value="">— none —</option>
            <option value="weather">Weather</option>
            <option value="awaiting_materials">Awaiting materials</option>
            <option value="awaiting_instruction">Awaiting instruction</option>
            <option value="breakdown">Breakdown</option>
            <option value="access_blocked">Access blocked</option>
            <option value="other">Other</option>
          </Select>
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field
          label="Cost code"
          hint="A card with no coding is hours nobody can code, which is how a labour overrun stays invisible until month end."
        >
          <Select value={allocCostCodeId} onChange={(e) => setAllocCostCodeId(e.target.value)}>
            <option value="">— code it later —</option>
            {costCodes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code}
                {c.title ? ` · ${c.title}` : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Quantity installed" optional hint="Makes productivity computable.">
          <Input
            type="number"
            value={allocQuantity}
            onChange={(e) => setAllocQuantity(e.target.value)}
          />
        </Field>
        <Field label="Unit" optional>
          <Input
            value={allocUnit}
            onChange={(e) => setAllocUnit(e.target.value)}
            placeholder="m3"
          />
        </Field>
      </div>
      <Field label="Notes" optional>
        <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </ModalShell>
  );
}

/* ========================================================================== */
/* Batch actions                                                               */
/* ========================================================================== */

export function BatchActions({
  projectId,
  batch,
  onDone,
}: {
  projectId: string;
  batch: BatchRecord;
  onDone: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [comment, setComment] = useState("");
  const [payrollRef, setPayrollRef] = useState("");
  const [asking, setAsking] = useState<"reject" | "export" | null>(null);
  const base = `/api/v1/projects/${projectId}/timecard-batches/${batch.id}`;

  async function act(key: string, path: string, body?: unknown, message?: string) {
    const done = await run(key, () => api.post(`${base}${path}`, body ?? {}));
    if (done) {
      toast.success(message ?? "Done");
      setAsking(null);
      setComment("");
      onDone();
    }
  }

  const collectable = batch.status === "draft" || batch.status === "rejected";
  const approvable = batch.status === "submitted" || batch.status === "partially_approved";

  return (
    <div className="space-y-2">
      {refusal ? <RefusalNotice refusal={refusal} onDismiss={clear} /> : null}
      <div className="flex flex-wrap gap-2">
        {collectable ? (
          <>
            <Button
              size="sm"
              variant="secondary"
              loading={busy === "collect"}
              onClick={() => act("collect", "/collect", {}, "The week's cards were collected")}
            >
              Collect the week
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={busy === "submit"}
              onClick={() => act("submit", "/submit", {}, "Submitted for approval")}
            >
              Submit
            </Button>
          </>
        ) : null}
        {approvable ? (
          <>
            <Button
              size="sm"
              variant="primary"
              loading={busy === "approve"}
              onClick={() =>
                act("approve", "/approve", { decision: "approved" }, "Approval recorded")
              }
            >
              Approve
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAsking("reject")}>
              Send back
            </Button>
          </>
        ) : null}
        {batch.status === "approved" ? (
          <Button
            size="sm"
            variant="secondary"
            loading={busy === "lock"}
            onClick={() => act("lock", "/lock", {}, "Locked — corrections are now dated adjustments")}
          >
            Lock
          </Button>
        ) : null}
        {batch.status === "approved" || batch.status === "locked" ? (
          <Button size="sm" variant="secondary" onClick={() => setAsking("export")}>
            Export to payroll
          </Button>
        ) : null}
        {batch.status === "exported" || batch.status === "locked" ? (
          <a
            className="inline-flex items-center rounded-md border border-border px-2 py-1 text-meta text-content-muted hover:bg-surface-sunken"
            href={`/api/v1${`/projects/${projectId}/timecard-batches/${batch.id}/payroll-export?format=generic_csv`}`}
            target="_blank"
            rel="noreferrer"
          >
            Download CSV
          </a>
        ) : null}
      </div>

      {asking === "reject" ? (
        <div className="space-y-2 rounded-md border border-border p-3">
          <Field label="Why is it going back?" required>
            <Textarea
              rows={2}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="The crew has to know what to fix."
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAsking(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={comment.trim() === ""}
              loading={busy === "reject"}
              onClick={() =>
                act("reject", "/approve", { decision: "rejected", comment }, "Sent back")
              }
            >
              Send back
            </Button>
          </div>
        </div>
      ) : null}

      {asking === "export" ? (
        <div className="space-y-2 rounded-md border border-border p-3">
          <Field
            label="Payroll batch reference"
            required
            hint="The external system's own identifier — the only thread tying a payment made outside this platform back to the hours that justified it."
          >
            <Input value={payrollRef} onChange={(e) => setPayrollRef(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAsking(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={payrollRef.trim() === ""}
              loading={busy === "export"}
              onClick={() =>
                act(
                  "export",
                  "/export",
                  { payrollBatchRef: payrollRef.trim() },
                  "Handed to payroll — the cards are frozen",
                )
              }
            >
              Export
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ========================================================================== */
/* Raise a batch                                                               */
/* ========================================================================== */

export function BatchCreateModal({
  open,
  onClose,
  onDone,
  projectId,
  crews,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  projectId: string;
  crews: CrewRecord[];
}) {
  const { busy, refusal, clear, run } = useAction();
  const [crewId, setCrewId] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState(today());
  const [collect, setCollect] = useState(true);

  async function submit() {
    const done = await run("create", () =>
      api.post(`/api/v1/projects/${projectId}/timecard-batches`, {
        crewId: crewId || null,
        periodStart: periodStart || periodEnd,
        periodEnd,
        collect,
      }),
    );
    if (done) {
      toast.success("Batch raised");
      onDone();
      onClose();
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Start a week"
      description="A batch is a crew's week or a subcontractor's week — name one, so there is somebody to send it back to when the hours are wrong."
      busy={busy === "create"}
      refusal={refusal}
      clearRefusal={clear}
      submitLabel="Start it"
      disabled={crewId === "" || periodEnd === ""}
      onSubmit={submit}
    >
      <Field label="Crew" required>
        <Select value={crewId} onChange={(e) => setCrewId(e.target.value)}>
          <option value="">— choose —</option>
          {crews.map((c) => (
            <option key={c.id} value={c.id}>
              {c.reference} · {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Period start" required>
          <Input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
        </Field>
        <Field label="Period end" required>
          <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-meta">
        <input type="checkbox" checked={collect} onChange={(e) => setCollect(e.target.checked)} />
        Pull in the period&apos;s uncollected cards for this crew now
      </label>
    </ModalShell>
  );
}
