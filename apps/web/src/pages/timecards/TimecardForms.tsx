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
  labelize,
  today,
  useAction,
  type BatchRecord,
  type CostCodeOption,
  type CrewRecord,
} from "./timecardsShared";

/** Mirrors SHIFTS / CREW_STATUSES / CREW_ROLES in @constructos/shared — the
 *  web package does not import the API's enum module, so the option lists are
 *  restated here and the server remains the authority that refuses. */
const SHIFT_OPTIONS = ["day", "night", "swing", "weekend", "split"] as const;
const CREW_STATUS_OPTIONS = ["forming", "active", "inactive", "disbanded"] as const;
const CREW_ROLE_OPTIONS = [
  "foreman",
  "leading_hand",
  "operative",
  "apprentice",
  "operator",
  "banksman",
  "supervisor",
  "specialist",
  "labourer",
] as const;
/** index 0 = Sunday, matching `crewConfig.weekStartsOn` */
const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

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

/**
 * The formats payroll actually asks for. The WH-347 certified payroll is
 * offered here and NOWHERE is it pre-signed: the statement of compliance is a
 * criminal declaration by a named person, so the export leaves the signature
 * block empty for a human to complete.
 */
const PAYROLL_FORMATS = [
  { value: "generic_csv", label: "CSV", hint: "One row per worker with the buckets as columns" },
  { value: "daily_csv", label: "Daily CSV", hint: "One row per worker per day" },
  {
    value: "certified_payroll",
    label: "WH-347",
    hint: "US Department of Labor certified payroll. The statement of compliance is left unsigned.",
  },
  { value: "json", label: "JSON", hint: "With the provenance an integration needs" },
] as const;

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
          <>
            {PAYROLL_FORMATS.map((format) => (
              <a
                key={format.value}
                className="inline-flex items-center rounded-md border border-border px-2 py-1 text-meta text-content-muted hover:bg-surface-sunken"
                href={`/api/v1/projects/${projectId}/timecard-batches/${batch.id}/payroll-export?format=${format.value}`}
                target="_blank"
                rel="noreferrer"
                title={format.hint}
              >
                {format.label}
              </a>
            ))}
          </>
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


/* ========================================================================== */
/* Raise a T&M ticket, and source its lines from hours already recorded        */
/* ========================================================================== */

/**
 * A T&M TICKET IS EVIDENCE OF AN INSTRUCTION, not a price.
 *
 * Two fields on this form carry the whole commercial argument, so both are
 * asked for plainly:
 *
 *  · WAS IT A VERBAL INSTRUCTION. Verbal instructions are the norm on site
 *    and the reason daywork claims fail. Ticking it REQUIRES the name of the
 *    person who gave it — an instruction from nobody is not an instruction —
 *    and the API refuses the ticket without it.
 *  · WHAT RATE BASIS. Whether these hours are claimed at contract daywork
 *    rates, at an agreed schedule or "to be agreed" changes what the client is
 *    being asked to sign, and a ticket that hides it is a ticket that gets
 *    argued about later.
 *
 * The lines are then SOURCED from timecard allocations and plant days that
 * already exist rather than retyped. Sourcing stamps those rows as billed on
 * this ticket, so the same hours cannot be claimed twice — and labour lines
 * come across WITHOUT a rate, because the worker's internal pay rate is not
 * the contract charge-out rate and putting it on a client-facing ticket both
 * exposes it and under-claims.
 */
export function TicketCreateModal({
  open,
  onClose,
  onDone,
  projectId,
  crews,
}: {
  open: boolean;
  onClose: () => void;
  onDone: (ticketId: string) => void;
  projectId: string;
  crews: CrewRecord[];
}) {
  const { busy, refusal, clear, run } = useAction();
  const [title, setTitle] = useState("");
  const [ticketDate, setTicketDate] = useState(today());
  const [scopeOfWork, setScopeOfWork] = useState("");
  const [crewId, setCrewId] = useState("");
  const [locationText, setLocationText] = useState("");
  const [rateBasis, setRateBasis] = useState("contract_daywork_rates");
  const [markupPercent, setMarkupPercent] = useState("");
  const [wasVerbal, setWasVerbal] = useState(false);
  const [instructedByName, setInstructedByName] = useState("");
  const [instructionRef, setInstructionRef] = useState("");

  async function submit() {
    const created = await run("ticket", () =>
      api.post<{ id: string; reference: string }>(`/api/v1/projects/${projectId}/tm-tickets`, {
        title: title.trim(),
        ticketDate,
        scopeOfWork: scopeOfWork.trim() || null,
        crewId: crewId || null,
        locationText: locationText.trim() || null,
        rateBasis,
        markupPercent: markupPercent === "" ? null : Number(markupPercent),
        wasVerbalInstruction: wasVerbal,
        instructedByName: instructedByName.trim() || null,
        instructionRef: instructionRef.trim() || null,
      }),
    );
    if (created) {
      toast.success(`${created.reference} raised`);
      onDone(created.id);
      onClose();
      setTitle("");
      setScopeOfWork("");
      setInstructedByName("");
      setInstructionRef("");
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Raise a T&M ticket"
      description="The record of what was instructed, done and presented for signature on the day. Pricing beyond this belongs to change management; nothing here restates it."
      busy={busy !== null}
      refusal={refusal}
      clearRefusal={clear}
      submitLabel="Raise the ticket"
      disabled={title.trim() === "" || (wasVerbal && instructedByName.trim() === "")}
      onSubmit={submit}
    >
      <Field label="What was done" required>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Break out and remove unrecorded concrete obstruction, grid F/12"
        />
      </Field>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Date of the work" required>
          <Input type="date" value={ticketDate} onChange={(e) => setTicketDate(e.target.value)} />
        </Field>
        <Field label="Crew" hint="Whose hours these are, when one gang did the work.">
          <Select value={crewId} onChange={(e) => setCrewId(e.target.value)}>
            <option value="">Not one crew</option>
            {crews.map((crew) => (
              <option key={crew.id} value={crew.id}>
                {crew.reference} — {crew.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Scope of work" hint="What a stranger reading this in two years needs to know.">
        <Textarea rows={3} value={scopeOfWork} onChange={(e) => setScopeOfWork(e.target.value)} />
      </Field>
      <Field label="Where">
        <Input
          value={locationText}
          onChange={(e) => setLocationText(e.target.value)}
          placeholder="Grid F/12, basement slab"
        />
      </Field>
      <div className="grid gap-3 md:grid-cols-2">
        <Field
          label="Rate basis"
          hint="What the client is being asked to sign against. 'To be agreed' is honest and is recorded as such."
        >
          <Select value={rateBasis} onChange={(e) => setRateBasis(e.target.value)}>
            <option value="contract_daywork_rates">Contract daywork rates</option>
            <option value="schedule_of_rates">Schedule of rates</option>
            <option value="actual_cost_plus">Actual cost plus</option>
            <option value="agreed_lump_sum">Agreed lump sum</option>
            <option value="star_rate">Star rate</option>
            <option value="to_be_agreed">To be agreed</option>
          </Select>
        </Field>
        <Field label="Daywork uplift %" hint="The percentage agreed on site, if any.">
          <Input
            type="number"
            value={markupPercent}
            onChange={(e) => setMarkupPercent(e.target.value)}
            placeholder="e.g. 15"
          />
        </Field>
      </div>
      <label className="flex items-start gap-2 text-meta text-content-muted">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={wasVerbal}
          onChange={(e) => setWasVerbal(e.target.checked)}
        />
        <span>
          This was a VERBAL instruction. Verbal instructions are the norm on site and the reason
          daywork claims fail — so the name of the person who gave it is required.
        </span>
      </label>
      {wasVerbal ? (
        <Field label="Instructed by" required>
          <Input
            value={instructedByName}
            onChange={(e) => setInstructedByName(e.target.value)}
            placeholder="Name and organisation of whoever gave the instruction"
          />
        </Field>
      ) : (
        <Field label="Instruction reference" hint="The written instruction this follows, if there is one.">
          <Input value={instructionRef} onChange={(e) => setInstructionRef(e.target.value)} />
        </Field>
      )}
    </ModalShell>
  );
}

/**
 * SOURCE THE TICKET'S LINES from hours and plant days already recorded.
 *
 * Retyping hours onto a ticket is how the same day gets claimed twice and how
 * a ticket ends up disagreeing with the cost report. Sourcing stamps the rows
 * it took, so a second ticket cannot take them again; the refusal naming the
 * ticket that already has them is rendered verbatim.
 */
export function TicketSourceModal({
  open,
  onClose,
  onDone,
  projectId,
  ticketId,
  ticketReference,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  projectId: string;
  ticketId: string | null;
  ticketReference: string;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [allocationIds, setAllocationIds] = useState("");
  const [utilisationIds, setUtilisationIds] = useState("");

  if (!ticketId) return null;

  const parse = (raw: string): string[] =>
    raw
      .split(/[\s,]+/)
      .map((v) => v.trim())
      .filter(Boolean);

  async function submit() {
    const done = await run("source", () =>
      api.post(`/api/v1/projects/${projectId}/tm-tickets/${ticketId}/lines/source`, {
        ...(parse(allocationIds).length > 0
          ? { timecardAllocationIds: parse(allocationIds) }
          : {}),
        ...(parse(utilisationIds).length > 0
          ? { equipmentUtilisationIds: parse(utilisationIds) }
          : {}),
      }),
    );
    if (done) {
      toast.success("Lines sourced from the hours already recorded");
      setAllocationIds("");
      setUtilisationIds("");
      onDone();
      onClose();
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={`Source lines onto ${ticketReference}`}
      description="Take hours and plant days that already exist rather than retyping them. Each row sourced is stamped as billed on this ticket, so it cannot be claimed on another."
      busy={busy !== null}
      refusal={refusal}
      clearRefusal={clear}
      submitLabel="Source the lines"
      disabled={parse(allocationIds).length + parse(utilisationIds).length === 0}
      onSubmit={submit}
    >
      <Field
        label="Timecard allocation ids"
        hint="From the cost report or the timecard drawer. Separate with spaces or commas. Labour lines come across WITHOUT a rate: the worker's pay rate is not the contract charge-out rate."
      >
        <Textarea
          rows={3}
          value={allocationIds}
          onChange={(e) => setAllocationIds(e.target.value)}
          placeholder="tca_… tca_…"
        />
      </Field>
      <Field
        label="Equipment utilisation ids"
        hint="Plant days from the equipment workspace. The hire rate is not copied either — the plant charge on a daywork ticket is a contract rate."
      >
        <Textarea
          rows={3}
          value={utilisationIds}
          onChange={(e) => setUtilisationIds(e.target.value)}
          placeholder="eut_… eut_…"
        />
      </Field>
    </ModalShell>
  );
}

/* ========================================================================== */
/* Form a crew, and put people in it for a dated period                        */
/* ========================================================================== */

/**
 * A CREW IS A PAY RULE WITH PEOPLE ATTACHED.
 *
 * The rule is asked for first and asked for plainly, because it decides what
 * every hour the crew works costs. There is no platform default and this form
 * offers none: `daily` wants a threshold, `weekly` wants a weekly threshold
 * and a week start, `none` says outright that no hour will ever be classified
 * as overtime. A crew saved with `daily` and no threshold is allowed — an
 * agreement is often not known on the day a gang is formed — but the crew list
 * then shows it as unable to classify hours, which is the honest state.
 *
 * `approvalLevels` is here too, because a two-tier crew whose second tier
 * nobody configured is a crew whose cards sit submitted for ever.
 */
export function CrewCreateModal({
  open,
  onClose,
  onDone,
  projectId,
  workers,
  costCodes,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  projectId: string;
  workers: WorkerOption[];
  costCodes: CostCodeOption[];
}) {
  const { busy, refusal, clear, run } = useAction();
  const [name, setName] = useState("");
  const [trade, setTrade] = useState("");
  const [defaultShift, setDefaultShift] = useState("day");
  const [status, setStatus] = useState("active");
  const [foremanWorkerId, setForemanWorkerId] = useState("");
  const [defaultCostCodeId, setDefaultCostCodeId] = useState("");
  const [overtimeRule, setOvertimeRule] = useState<"daily" | "weekly" | "none">("daily");
  const [dailyThreshold, setDailyThreshold] = useState("8");
  const [dailyDouble, setDailyDouble] = useState("");
  const [weeklyThreshold, setWeeklyThreshold] = useState("40");
  const [weekStartsOn, setWeekStartsOn] = useState("1");
  const [approvalLevels, setApprovalLevels] = useState("1");
  const [tolerance, setTolerance] = useState("0.5");
  const [activeFrom, setActiveFrom] = useState(today());

  const num = (v: string) => (v === "" ? null : Number(v));

  async function submit() {
    const config =
      overtimeRule === "daily"
        ? {
            overtimeRule,
            doubleTimeThresholdHours: num(dailyDouble),
            approvalLevels: Number(approvalLevels),
            varianceToleranceHours: Number(tolerance),
          }
        : overtimeRule === "weekly"
          ? {
              overtimeRule,
              weeklyOvertimeThresholdHours: num(weeklyThreshold),
              weekStartsOn: Number(weekStartsOn),
              approvalLevels: Number(approvalLevels),
              varianceToleranceHours: Number(tolerance),
            }
          : {
              overtimeRule,
              approvalLevels: Number(approvalLevels),
              varianceToleranceHours: Number(tolerance),
            };
    const done = await run("create", () =>
      api.post(`/api/v1/projects/${projectId}/crews`, {
        name: name.trim(),
        trade: trade.trim() || null,
        defaultShift,
        status,
        foremanWorkerId: foremanWorkerId || null,
        defaultCostCodeId: defaultCostCodeId || null,
        overtimeThresholdHours: overtimeRule === "daily" ? num(dailyThreshold) : null,
        activeFrom: activeFrom || null,
        config,
      }),
    );
    if (done) {
      toast.success("Crew formed");
      onDone();
      onClose();
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Form a crew"
      description="The overtime rule is asked for first because it decides what every hour this gang works costs. Leave it unset and the crew cannot classify hours at all — which the register will say."
      busy={busy === "create"}
      refusal={refusal}
      clearRefusal={clear}
      submitLabel="Form the crew"
      disabled={name.trim() === ""}
      onSubmit={submit}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Crew name" required>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Groundworks gang 1"
          />
        </Field>
        <Field label="Trade">
          <Input value={trade} onChange={(e) => setTrade(e.target.value)} placeholder="Groundworks" />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Default shift">
          <Select value={defaultShift} onChange={(e) => setDefaultShift(e.target.value)}>
            {SHIFT_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {labelize(s)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            {CREW_STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {labelize(s)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Active from">
          <Input type="date" value={activeFrom} onChange={(e) => setActiveFrom(e.target.value)} />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Foreman" hint="From the worker register — this module keeps no second person list">
          <Select value={foremanWorkerId} onChange={(e) => setForemanWorkerId(e.target.value)}>
            <option value="">— none recorded —</option>
            {workers.map((w) => (
              <option key={w.id} value={w.id}>
                {w.reference} · {w.fullName}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Default cost code">
          <Select value={defaultCostCodeId} onChange={(e) => setDefaultCostCodeId(e.target.value)}>
            <option value="">— none —</option>
            {costCodes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} · {c.title}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field
        label="Overtime rule"
        hint="8 hours a day is Californian, 40 a week is federal, 48 a week is the Working Time Directive. Pick the one this crew's agreement actually says."
        required
      >
        <Select
          value={overtimeRule}
          onChange={(e) => setOvertimeRule(e.target.value as "daily" | "weekly" | "none")}
        >
          <option value="daily">Daily threshold</option>
          <option value="weekly">Weekly threshold</option>
          <option value="none">No overtime — every hour is plain time</option>
        </Select>
      </Field>
      {overtimeRule === "daily" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Overtime after (hours/day)">
            <Input
              type="number"
              step="0.25"
              value={dailyThreshold}
              onChange={(e) => setDailyThreshold(e.target.value)}
            />
          </Field>
          <Field label="Double time after (hours/day)" hint="Leave empty if the agreement has none">
            <Input
              type="number"
              step="0.25"
              value={dailyDouble}
              onChange={(e) => setDailyDouble(e.target.value)}
            />
          </Field>
        </div>
      ) : overtimeRule === "weekly" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Overtime after (hours/week)">
            <Input
              type="number"
              step="0.5"
              value={weeklyThreshold}
              onChange={(e) => setWeeklyThreshold(e.target.value)}
            />
          </Field>
          <Field label="Pay week starts">
            <Select value={weekStartsOn} onChange={(e) => setWeekStartsOn(e.target.value)}>
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={String(i)}>
                  {d}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Approval tiers"
          hint="How many DISTINCT approvers a card needs. Two tiers means two people, at two levels."
        >
          <Select value={approvalLevels} onChange={(e) => setApprovalLevels(e.target.value)}>
            <option value="1">1 — one approver</option>
            <option value="2">2 — supervisor then manager</option>
            <option value="3">3</option>
          </Select>
        </Field>
        <Field
          label="Variance tolerance (hours)"
          hint="Claimed against present, per day, before an explanation is required"
        >
          <Input
            type="number"
            step="0.25"
            value={tolerance}
            onChange={(e) => setTolerance(e.target.value)}
          />
        </Field>
      </div>
    </ModalShell>
  );
}

/**
 * MEMBERSHIP IS A DATED RANGE, never a flag. The API refuses a membership
 * that overlaps another crew for the same worker and names the clash, and
 * that refusal is rendered verbatim: two gangs claiming the same person on
 * the same day is exactly the condition that makes a week's hours
 * unauditable a year later.
 *
 * The rate asked for here is the worker's PAY rate. It costs the timecard;
 * it is deliberately NOT what a T&M ticket bills the client at.
 */
export function CrewMemberModal({
  open,
  onClose,
  onDone,
  projectId,
  crew,
  workers,
  costCodes,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  projectId: string;
  crew: CrewRecord | null;
  workers: WorkerOption[];
  costCodes: CostCodeOption[];
}) {
  const { busy, refusal, clear, run } = useAction();
  const [workerId, setWorkerId] = useState("");
  const [roleInCrew, setRoleInCrew] = useState("operative");
  const [fromDate, setFromDate] = useState(today());
  const [toDate, setToDate] = useState("");
  const [classification, setClassification] = useState("");
  const [hourlyRate, setHourlyRate] = useState("");
  const [overtimeMultiplier, setOvertimeMultiplier] = useState("1.5");
  const [doubleTimeMultiplier, setDoubleTimeMultiplier] = useState("2");
  const [burdenRate, setBurdenRate] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [defaultCostCodeId, setDefaultCostCodeId] = useState("");

  const num = (v: string) => (v === "" ? null : Number(v));

  async function submit() {
    if (!crew) return;
    const done = await run("add", () =>
      api.post(`/api/v1/projects/${projectId}/crews/${crew.id}/members`, {
        workerId,
        roleInCrew,
        fromDate,
        toDate: toDate || null,
        classification: classification.trim() || null,
        hourlyRate: num(hourlyRate),
        overtimeMultiplier: num(overtimeMultiplier),
        doubleTimeMultiplier: num(doubleTimeMultiplier),
        burdenRate: num(burdenRate),
        currency: currency.toUpperCase(),
        defaultCostCodeId: defaultCostCodeId || null,
      }),
    );
    if (done) {
      toast.success("Added to the crew");
      onDone();
      onClose();
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={crew ? `Add somebody to ${crew.reference}` : "Add a crew member"}
      description="Membership is a dated range. It is how 'who was in this gang on the day of the incident' stays answerable a year later, so the platform refuses a range that overlaps another crew."
      busy={busy === "add"}
      refusal={refusal}
      clearRefusal={clear}
      submitLabel="Add to the crew"
      disabled={!crew || workerId === "" || fromDate === ""}
      onSubmit={submit}
    >
      {!crew ? (
        <p className="text-meta text-ink-500">Choose a crew on the register first.</p>
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
        <Field label="Role in the crew">
          <Select value={roleInCrew} onChange={(e) => setRoleInCrew(e.target.value)}>
            {CREW_ROLE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {labelize(r)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="From" required>
          <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        </Field>
        <Field label="To" hint="Leave empty while the membership is open">
          <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Classification" hint="Trade grade as the agreement names it">
          <Input
            value={classification}
            onChange={(e) => setClassification(e.target.value)}
            placeholder="Skilled operative"
          />
        </Field>
        <Field label="Pay rate / hour" hint="What the hour COSTS — not the T&M charge-out rate">
          <Input
            type="number"
            step="0.01"
            value={hourlyRate}
            onChange={(e) => setHourlyRate(e.target.value)}
          />
        </Field>
        <Field label="Currency">
          <Input
            value={currency}
            maxLength={3}
            onChange={(e) => setCurrency(e.target.value)}
          />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Overtime multiplier">
          <Input
            type="number"
            step="0.05"
            value={overtimeMultiplier}
            onChange={(e) => setOvertimeMultiplier(e.target.value)}
          />
        </Field>
        <Field label="Double-time multiplier">
          <Input
            type="number"
            step="0.05"
            value={doubleTimeMultiplier}
            onChange={(e) => setDoubleTimeMultiplier(e.target.value)}
          />
        </Field>
        <Field label="Burden rate" hint="On-costs as a fraction, e.g. 0.28">
          <Input
            type="number"
            step="0.01"
            value={burdenRate}
            onChange={(e) => setBurdenRate(e.target.value)}
          />
        </Field>
      </div>
      <Field label="Default cost code for this person">
        <Select value={defaultCostCodeId} onChange={(e) => setDefaultCostCodeId(e.target.value)}>
          <option value="">— none —</option>
          {costCodes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code} · {c.title}
            </option>
          ))}
        </Select>
      </Field>
    </ModalShell>
  );
}

/* ========================================================================== */
/* Record field progress                                                       */
/* ========================================================================== */

const PROGRESS_METHOD_OPTIONS = [
  { value: "field_measure", label: "Measured on site" },
  { value: "count", label: "Counted" },
  { value: "survey", label: "Surveyed" },
  { value: "percentage_assessment", label: "Percentage assessment" },
  { value: "supplier_docket", label: "From a supplier docket" },
  { value: "import", label: "Imported" },
];

/**
 * WHAT WAS INSTALLED, MEASURED BY SOMEBODY WHO WALKED IT.
 *
 * The quantity box on a timecard lets the person claiming the hours also
 * state what those hours produced — one author, both sides of the ratio.
 * This form is the other side. Where an entry exists for a budget line, the
 * report earns hours from THESE quantities and ignores the ones typed on the
 * timesheets, because adding a claim to its own check counts the work twice.
 *
 * The unit is not converted. If the line is measured in m3 and somebody
 * measured m2, the server refuses rather than guessing a factor that would
 * silently become an earned-value figure.
 */
export function FieldProgressModal({
  open,
  onClose,
  onDone,
  projectId,
  crews,
  costCodes,
  budgetLines,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  projectId: string;
  crews: CrewRecord[];
  costCodes: CostCodeOption[];
  budgetLines: Array<{ id: string; costCode: string; description: string; unit: string | null }>;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [progressDate, setProgressDate] = useState(today());
  const [budgetLineItemId, setBudgetLineItemId] = useState("");
  const [costCodeId, setCostCodeId] = useState("");
  const [crewId, setCrewId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("");
  const [method, setMethod] = useState("field_measure");
  const [notes, setNotes] = useState("");

  const line = budgetLines.find((b) => b.id === budgetLineItemId);

  async function submit() {
    const done = await run("save", () =>
      api.post(`/api/v1/projects/${projectId}/labour-progress`, {
        progressDate,
        budgetLineItemId: budgetLineItemId || null,
        costCodeId: costCodeId || null,
        crewId: crewId || null,
        quantity: Number(quantity),
        unit: unit.trim(),
        method,
        notes: notes.trim() || null,
      }),
    );
    if (done) {
      toast.success("Progress recorded");
      setQuantity("");
      setNotes("");
      onDone();
      onClose();
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Record field progress"
      description="Installed quantity per cost code per day, measured separately from the timesheets. Where this exists the report earns hours from it and ignores the quantity typed on the cards."
      busy={busy === "save"}
      refusal={refusal}
      clearRefusal={clear}
      submitLabel="Record it"
      disabled={
        quantity === "" ||
        unit.trim() === "" ||
        (budgetLineItemId === "" && costCodeId === "")
      }
      onSubmit={submit}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Date measured" required hint="The day it is earned on, not the day it was typed">
          <Input
            type="date"
            value={progressDate}
            onChange={(e) => setProgressDate(e.target.value)}
          />
        </Field>
        <Field label="Method">
          <Select value={method} onChange={(e) => setMethod(e.target.value)}>
            {PROGRESS_METHOD_OPTIONS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field
        label="Budget line"
        hint="Without one the quantity cannot be earned against a planned rate — it is recorded, but it measures nothing."
      >
        <Select
          value={budgetLineItemId}
          onChange={(e) => {
            setBudgetLineItemId(e.target.value);
            const chosen = budgetLines.find((b) => b.id === e.target.value);
            if (chosen?.unit) setUnit(chosen.unit);
          }}
        >
          <option value="">— none —</option>
          {budgetLines.map((b) => (
            <option key={b.id} value={b.id}>
              {b.costCode} · {b.description}
              {b.unit ? ` (${b.unit})` : ""}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Cost code">
        <Select value={costCodeId} onChange={(e) => setCostCodeId(e.target.value)}>
          <option value="">— none —</option>
          {costCodes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code} · {c.title}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Quantity installed" required>
          <Input
            type="number"
            step="0.001"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </Field>
        <Field
          label="Unit"
          required
          {...(line?.unit ? { hint: `The budget line is measured in ${line.unit}` } : {})}
        >
          <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="m3" />
        </Field>
        <Field label="Crew" hint="Leave empty and the per-crew comparison abstains rather than guessing">
          <Select value={crewId} onChange={(e) => setCrewId(e.target.value)}>
            <option value="">— not attributed —</option>
            {crews.map((c) => (
              <option key={c.id} value={c.id}>
                {c.reference} · {c.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Notes" optional>
        <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </ModalShell>
  );
}
