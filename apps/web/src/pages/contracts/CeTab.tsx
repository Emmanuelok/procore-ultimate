/**
 * NEC compensation-event tab (spec Vol II Domain C #206-211).
 *
 * NEC does not have "a variation"; it has a governed cycle with its own
 * clocks — 61.3 notification, 62.1 instruction, 62.3 quotation and reply,
 * 62.6 deemed acceptance, 64 Project Manager's assessment. This tab shows the
 * cycle state of every compensation event on the contract, the quotation
 * build-up by Schedule of Cost Components head, and how long the Project
 * Manager has left to reply.
 */
import { useCallback, useEffect, useState } from "react";
import { api, ApiClientError } from "../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { formatDate, formatDateTime, formatMoney, humanize } from "../format";
import {
  ceStateTone,
  eventLabel,
  type CeQuotationRow,
  type ContractEventRow,
  type ListResponse,
  type NecBasis,
} from "./contractsShared";

const SCC_COMPONENTS = [
  "people",
  "equipment",
  "plant_and_materials",
  "subcontractors",
  "charges",
  "manufacture_and_fabrication",
  "design",
  "insurance",
] as const;

interface QuotationDraftLine {
  component: string;
  description: string;
  unit: string;
  qty: string;
  rate: string;
}

export default function CeTab({
  projectId,
  contractId,
  currency,
  necBasis,
  onChanged,
}: {
  projectId: string;
  contractId: string;
  currency: string;
  necBasis: NecBasis | null;
  onChanged: () => void;
}) {
  const base = `/api/v1/projects/${projectId}/contracts/${contractId}`;
  const [events, setEvents] = useState<ContractEventRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [quotations, setQuotations] = useState<CeQuotationRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<ListResponse<ContractEventRow>>(
        `${base}/events?kind=compensation_event&pageSize=100`,
      );
      setEvents(res.items);
    } catch (err) {
      setEvents([]);
      setError(err instanceof Error ? err.message : "Failed to load compensation events");
    }
  }, [base]);

  const loadQuotations = useCallback(
    async (eventId: string) => {
      try {
        const res = await api.get<{ items: CeQuotationRow[] }>(
          `${base}/events/${eventId}/quotations`,
        );
        setQuotations(res.items);
      } catch (err) {
        setQuotations([]);
        setError(err instanceof Error ? err.message : "Failed to load quotations");
      }
    },
    [base],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (selected) void loadQuotations(selected);
    else setQuotations([]);
  }, [selected, loadQuotations]);

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await fn();
      await load();
      if (selected) await loadQuotations(selected);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "The action failed");
    } finally {
      setBusy(false);
    }
  }

  const current = events?.find((e) => e.id === selected) ?? null;

  return (
    <div>
      {necBasis ? (
        <Alert tone="info" className="mb-4" title={`Valuation basis: ${humanize(necBasis.basis)}`}>
          {necBasis.explanation}
          {necBasis.painGainShare
            ? " Pain/gain share applies at the final assessment against the target."
            : ""}
        </Alert>
      ) : null}

      <ErrorAlert message={error} />

      {events === null ? (
        <Spinner />
      ) : events.length === 0 ? (
        <EmptyState
          title="No compensation events"
          hint="Raise an event of kind 'compensation event' on the Events tab; the 61.3 clock starts from the awareness date."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>No.</Th>
              <Th>Title</Th>
              <Th>Cycle state</Th>
              <Th>Quotation due</Th>
              <Th>PM reply due</Th>
              <Th className="text-right">Assessed</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {events.map((e) => (
              <tr
                key={e.id}
                className={`cursor-pointer hover:bg-ink-50/60 ${selected === e.id ? "bg-brand-50" : ""}`}
                onClick={() => setSelected(e.id === selected ? null : e.id)}
              >
                <Td className="whitespace-nowrap font-mono text-xs font-medium">
                  {eventLabel(e.number)}
                </Td>
                <Td className="max-w-md truncate">{e.title}</Td>
                <Td>
                  <Badge tone={ceStateTone(e.ceState)}>
                    {e.ceState ? humanize(e.ceState) : "—"}
                  </Badge>
                </Td>
                <Td className="whitespace-nowrap">{formatDate(e.quotationDueDate)}</Td>
                <Td className="whitespace-nowrap">{formatDate(e.replyDueDate)}</Td>
                <Td className="text-right tabular-nums">
                  {formatMoney(e.costImpactEstimate, currency)}
                  {e.timeImpactDaysEstimate ? (
                    <span className="block text-xs text-ink-400">
                      +{e.timeImpactDaysEstimate}d
                    </span>
                  ) : null}
                </Td>
                <Td className="text-right text-xs text-brand-700">
                  {selected === e.id ? "Hide" : "Open"}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {current ? (
        <div className="mt-5 space-y-4">
          <CycleControls event={current} busy={busy} base={base} onAct={act} />
          <QuotationsPanel
            event={current}
            quotations={quotations}
            currency={currency}
            busy={busy}
            base={base}
            onAct={act}
          />
        </div>
      ) : null}
    </div>
  );
}

function CycleControls({
  event,
  busy,
  base,
  onAct,
}: {
  event: ContractEventRow;
  busy: boolean;
  base: string;
  onAct: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [instructionRef, setInstructionRef] = useState("");
  const [reason, setReason] = useState("");
  const state = event.ceState ?? "notified";

  return (
    <Card>
      <CardBody>
        <h3 className="mb-2 text-sm font-semibold text-ink-900">
          Cycle — {eventLabel(event.number)}
        </h3>
        <div className="mb-3 flex flex-wrap items-center gap-1 text-xs">
          {[
            "notified",
            "quotation_requested",
            "quotation_submitted",
            "pm_replied",
            "implemented",
          ].map((s, i, arr) => (
            <span key={s} className="flex items-center gap-1">
              <span
                className={
                  s === state
                    ? "rounded-full bg-brand-600 px-2 py-0.5 font-medium text-white"
                    : "rounded-full bg-ink-100 px-2 py-0.5 text-ink-500"
                }
              >
                {humanize(s)}
              </span>
              {i < arr.length - 1 ? <span className="text-ink-300">→</span> : null}
            </span>
          ))}
        </div>

        {state === "notified" ? (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Instruction reference (62.1)" className="w-64">
              <Input
                value={instructionRef}
                onChange={(e) => setInstructionRef(e.target.value)}
                placeholder="PMI-014"
              />
            </Field>
            <Button
              size="sm"
              disabled={busy || !instructionRef.trim()}
              onClick={() =>
                void onAct(() =>
                  api.post(`${base}/events/${event.id}/ce-state`, {
                    state: "quotation_requested",
                    instructionRef,
                  }),
                )
              }
            >
              Instruct a quotation
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() =>
                void onAct(() =>
                  api.post(`${base}/events/${event.id}/ce-state`, {
                    state: "pm_assessment",
                    reason: "Project Manager's own assessment under clause 64",
                  }),
                )
              }
            >
              Assess under 64
            </Button>
          </div>
        ) : null}

        {state === "pm_assessment" ? (
          <div className="flex flex-wrap items-end gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void onAct(() =>
                  api.post(`${base}/events/${event.id}/ce-state`, { state: "implemented" }),
                )
              }
            >
              Implement the assessment
            </Button>
          </div>
        ) : null}

        {state !== "implemented" && state !== "rejected" ? (
          <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-ink-100 pt-3">
            <Field label="Reason to reject" className="w-80">
              <Input value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <Button
              variant="danger"
              size="sm"
              disabled={busy || reason.trim().length < 3}
              onClick={() =>
                void onAct(() =>
                  api.post(`${base}/events/${event.id}/ce-state`, { state: "rejected", reason }),
                )
              }
            >
              Reject the event
            </Button>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

function QuotationsPanel({
  event,
  quotations,
  currency,
  busy,
  base,
  onAct,
}: {
  event: ContractEventRow;
  quotations: CeQuotationRow[];
  currency: string;
  busy: boolean;
  base: string;
  onAct: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [lines, setLines] = useState<QuotationDraftLine[]>([
    { component: "people", description: "", unit: "hr", qty: "", rate: "" },
  ]);
  const [feePercent, setFeePercent] = useState("10");
  const [risk, setRisk] = useState("0");
  const [timeImpact, setTimeImpact] = useState("0");
  const [assumptions, setAssumptions] = useState("");
  const [replyReason, setReplyReason] = useState("");

  const num = (v: string) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const definedCost = lines.reduce((s, l) => s + num(l.qty) * num(l.rate), 0);
  const fee = definedCost * (num(feePercent) / 100);
  const total = definedCost + fee + num(risk);
  const canSubmit =
    event.ceState === "quotation_requested" &&
    lines.some((l) => l.description.trim() && num(l.qty) !== 0 && num(l.rate) !== 0);

  return (
    <Card>
      <CardBody>
        <h3 className="mb-3 text-sm font-semibold text-ink-900">
          Quotations — Defined Cost plus Fee (62.3, SCC)
        </h3>

        {quotations.length === 0 ? (
          <p className="mb-4 text-sm text-ink-500">No quotation has been submitted yet.</p>
        ) : (
          <div className="mb-4 space-y-3">
            {quotations.map((q) => (
              <div key={q.id} className="rounded-md bg-ink-50 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-semibold">Quotation {q.number}</span>
                    <Badge
                      tone={
                        q.status === "accepted" || q.status === "deemed_accepted"
                          ? "green"
                          : q.status === "rejected"
                            ? "red"
                            : "blue"
                      }
                    >
                      {humanize(q.status)}
                    </Badge>
                    {q.clock?.overdue ? (
                      <Badge tone={q.clock.deemed ? "red" : "amber"}>
                        Reply {q.clock.daysOverdue}d overdue
                      </Badge>
                    ) : null}
                  </div>
                  <span className="text-lg font-semibold tabular-nums">
                    {formatMoney(q.total, q.currency || currency)}
                  </span>
                </div>
                <div className="mt-1 text-xs text-ink-500">
                  Defined Cost {formatMoney(q.definedCost, q.currency)} + Fee {q.feePercent}% (
                  {formatMoney(q.fee, q.currency)})
                  {q.riskAllowance > 0
                    ? ` + risk ${formatMoney(q.riskAllowance, q.currency)}`
                    : ""}{" "}
                  · {q.timeImpactDays} day{q.timeImpactDays === 1 ? "" : "s"} · submitted{" "}
                  {formatDateTime(q.submittedAt)}
                  {q.replyDueDate ? ` · reply due ${formatDate(q.replyDueDate)}` : ""}
                </div>
                {q.clock?.reason ? (
                  <p className="mt-1 text-xs text-ink-500">{q.clock.reason}</p>
                ) : null}
                {q.assumptions ? (
                  <p className="mt-1 text-xs text-ink-600">Assumptions: {q.assumptions}</p>
                ) : null}
                <div className="mt-2 overflow-x-auto">
                  <Table>
                    <thead>
                      <tr>
                        <Th>SCC head</Th>
                        <Th>Description</Th>
                        <Th className="text-right">Qty</Th>
                        <Th className="text-right">Rate</Th>
                        <Th className="text-right">Amount</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-100">
                      {q.components.map((c, i) => (
                        <tr key={`${q.id}-${i}`}>
                          <Td className="whitespace-nowrap text-xs">{humanize(c.component)}</Td>
                          <Td>{c.description}</Td>
                          <Td className="text-right tabular-nums">
                            {c.qty} {c.unit ?? ""}
                          </Td>
                          <Td className="text-right tabular-nums">
                            {formatMoney(c.rate, q.currency)}
                          </Td>
                          <Td className="text-right tabular-nums">
                            {formatMoney(c.amount, q.currency)}
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
                {q.status === "submitted" ? (
                  <div className="mt-3 flex flex-wrap items-end gap-2">
                    <Field label="Reason (required unless accepting)" className="w-72">
                      <Input value={replyReason} onChange={(e) => setReplyReason(e.target.value)} />
                    </Field>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void onAct(() =>
                          api.post(`/api/v1/ce-quotations/${q.id}/reply`, { decision: "accepted" }),
                        )
                      }
                    >
                      Accept
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy || replyReason.trim().length < 3}
                      onClick={() =>
                        void onAct(() =>
                          api.post(`/api/v1/ce-quotations/${q.id}/reply`, {
                            decision: "revision_requested",
                            reason: replyReason,
                          }),
                        )
                      }
                    >
                      Ask for a revision
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={busy || replyReason.trim().length < 3}
                      onClick={() =>
                        void onAct(() =>
                          api.post(`/api/v1/ce-quotations/${q.id}/reply`, {
                            decision: "rejected",
                            reason: replyReason,
                          }),
                        )
                      }
                    >
                      Reject
                    </Button>
                  </div>
                ) : null}
                {q.replyReason ? (
                  <p className="mt-2 text-xs text-ink-600">Reply: {q.replyReason}</p>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {event.ceState === "quotation_requested" ? (
          <div className="rounded-md bg-ink-50 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
              Submit a quotation
            </div>
            <div className="space-y-2">
              {lines.map((l, i) => (
                <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                  <Select
                    value={l.component}
                    onChange={(e) =>
                      setLines((ls) =>
                        ls.map((x, j) => (j === i ? { ...x, component: e.target.value } : x)),
                      )
                    }
                  >
                    {SCC_COMPONENTS.map((c) => (
                      <option key={c} value={c}>
                        {humanize(c)}
                      </option>
                    ))}
                  </Select>
                  <Input
                    className="sm:col-span-2"
                    placeholder="Description"
                    value={l.description}
                    onChange={(e) =>
                      setLines((ls) =>
                        ls.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)),
                      )
                    }
                  />
                  <Input
                    placeholder="Qty"
                    inputMode="decimal"
                    value={l.qty}
                    onChange={(e) =>
                      setLines((ls) => ls.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))
                    }
                  />
                  <Input
                    placeholder="Rate"
                    inputMode="decimal"
                    value={l.rate}
                    onChange={(e) =>
                      setLines((ls) =>
                        ls.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)),
                      )
                    }
                  />
                </div>
              ))}
              <button
                type="button"
                className="text-xs font-medium text-brand-700 hover:text-brand-900"
                onClick={() =>
                  setLines((ls) => [
                    ...ls,
                    { component: "people", description: "", unit: "", qty: "", rate: "" },
                  ])
                }
              >
                + another component
              </button>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Field label="Fee %">
                <Input
                  value={feePercent}
                  inputMode="decimal"
                  onChange={(e) => setFeePercent(e.target.value)}
                />
              </Field>
              <Field label="Risk allowance">
                <Input value={risk} inputMode="decimal" onChange={(e) => setRisk(e.target.value)} />
              </Field>
              <Field label="Delay to planned Completion (days)">
                <Input
                  value={timeImpact}
                  inputMode="numeric"
                  onChange={(e) => setTimeImpact(e.target.value)}
                />
              </Field>
              <div className="flex items-end">
                <div className="w-full rounded-md bg-white px-2 py-1.5 text-right ring-1 ring-ink-200">
                  <div className="text-[10px] uppercase tracking-wide text-ink-400">Total</div>
                  <div className="font-semibold tabular-nums">{formatMoney(total, currency)}</div>
                </div>
              </div>
            </div>
            <Field label="Assumptions" className="mt-2">
              <Textarea
                rows={2}
                value={assumptions}
                onChange={(e) => setAssumptions(e.target.value)}
              />
            </Field>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-xs text-ink-400">
                Defined Cost {formatMoney(definedCost, currency)} + Fee {formatMoney(fee, currency)}
              </span>
              <Button
                size="sm"
                disabled={busy || !canSubmit}
                onClick={() =>
                  void onAct(async () => {
                    await api.post(`${base}/events/${event.id}/quotations`, {
                      components: lines
                        .filter((l) => l.description.trim())
                        .map((l) => ({
                          component: l.component,
                          description: l.description,
                          unit: l.unit || null,
                          qty: num(l.qty),
                          rate: num(l.rate),
                        })),
                      feePercent: num(feePercent),
                      riskAllowance: num(risk),
                      timeImpactDays: Math.round(num(timeImpact)),
                      assumptions: assumptions || null,
                    });
                    setLines([
                      { component: "people", description: "", unit: "hr", qty: "", rate: "" },
                    ]);
                    setAssumptions("");
                  })
                }
              >
                Submit quotation
              </Button>
            </div>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
