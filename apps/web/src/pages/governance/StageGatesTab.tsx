/**
 * Stage gates tab (spec #408-415): the Gateway 0-5 timeline, gate cards with
 * criteria checklists and the latest review's delivery-confidence RAG and
 * decision, the hold-review modal (findings must cover every criterion,
 * conditions repeater), and the open conditions-of-approval panel tracked to
 * closure.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Textarea,
} from "../../ui";
import { formatDate, humanize } from "../format";
import {
  DECISION_META,
  DecisionChip,
  DueBadge,
  RAG_META,
  RagChip,
  SectionTitle,
  todayIso,
  WarnBanner,
  type GateCriterion,
  type GateReview,
  type ListResponse,
  type OpenCondition,
  type StageGateDetail,
  type StageGateRow,
} from "./governanceShared";

const GATE_SLOTS = [0, 1, 2, 3, 4, 5];

const DECISION_OPTIONS = [
  { value: "proceed", label: "Proceed" },
  { value: "proceed_with_conditions", label: "Proceed with conditions" },
  { value: "hold", label: "Hold" },
  { value: "stop", label: "Stop" },
];

const RAG_OPTIONS = ["green", "amber_green", "amber", "amber_red", "red"];

function gateStatusTone(status: string): string {
  if (status === "decided") return "green";
  if (status === "in_review") return "blue";
  return "gray";
}

/* ----------------------------- Gateway timeline ---------------------------- */

function TimelineNode({ gate }: { gate: StageGateDetail | null }) {
  if (!gate) {
    return (
      <span className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-dashed border-ink-200 text-xs font-semibold text-ink-300">
        ·
      </span>
    );
  }
  const decision = gate.reviews[0]?.decision ?? gate.latestReview?.decision ?? null;
  if (gate.status === "decided" && decision) {
    const node = DECISION_META[decision]?.node ?? "bg-ink-400 text-white";
    return (
      <span
        className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold shadow-sm ${node}`}
        title={`Gate ${gate.gateNumber} — ${DECISION_META[decision]?.label ?? decision}`}
      >
        {gate.gateNumber}
      </span>
    );
  }
  if (gate.status === "in_review") {
    return (
      <span
        className="flex h-9 w-9 animate-pulse items-center justify-center rounded-full bg-brand-600 text-sm font-bold text-white ring-4 ring-brand-200"
        title={`Gate ${gate.gateNumber} — in review`}
      >
        {gate.gateNumber}
      </span>
    );
  }
  return (
    <span
      className="flex h-9 w-9 items-center justify-center rounded-full bg-ink-200 text-sm font-bold text-ink-600"
      title={`Gate ${gate.gateNumber} — pending`}
    >
      {gate.gateNumber}
    </span>
  );
}

function GatewayTimeline({ gates }: { gates: StageGateDetail[] }) {
  const byNumber = new Map(gates.map((g) => [g.gateNumber, g]));
  return (
    <Card className="mb-4">
      <CardBody className="py-4">
        <SectionTitle>Gateway timeline</SectionTitle>
        <div className="flex items-start">
          {GATE_SLOTS.map((n, i) => {
            const gate = byNumber.get(n) ?? null;
            return (
              <div key={n} className="flex min-w-0 flex-1 items-start">
                {i > 0 ? <div className="mt-[17px] h-0.5 flex-1 bg-ink-200" /> : null}
                <div className="flex w-24 shrink-0 flex-col items-center text-center">
                  <TimelineNode gate={gate} />
                  <div className="mt-1.5 w-full truncate text-[11px] font-medium text-ink-700">
                    {gate ? gate.name : `Gate ${n}`}
                  </div>
                  <div className="text-[10px] tabular-nums text-ink-400">
                    {gate?.plannedDate ? formatDate(gate.plannedDate) : "not planned"}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </CardBody>
    </Card>
  );
}

/* --------------------------------- The tab --------------------------------- */

export default function StageGatesTab({ projectId }: { projectId: string }) {
  const base = `/api/v1/projects/${projectId}`;

  const [gates, setGates] = useState<StageGateDetail[] | null>(null);
  const [conditions, setConditions] = useState<OpenCondition[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await api.get<ListResponse<StageGateRow>>(`${base}/stage-gates?pageSize=50`);
      const [details, cond] = await Promise.all([
        Promise.all(
          list.items.map((g) => api.get<StageGateDetail>(`${base}/stage-gates/${g.id}`)),
        ),
        api.get<{ items: OpenCondition[] }>(`${base}/governance/conditions`),
      ]);
      setGates(details.sort((a, b) => a.gateNumber - b.gateNumber));
      setConditions(cond.items ?? []);
    } catch (err) {
      setGates([]);
      setError(err instanceof Error ? err.message : "Failed to load stage gates");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  /* ------------------------------ create modal ------------------------------ */

  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [gNumber, setGNumber] = useState("0");
  const [gName, setGName] = useState("");
  const [gDescription, setGDescription] = useState("");
  const [gPlanned, setGPlanned] = useState("");
  const [gCriteria, setGCriteria] = useState<{ text: string; evidenceRequired: boolean }[]>([
    { text: "", evidenceRequired: false },
  ]);

  function openCreate() {
    const taken = new Set((gates ?? []).map((g) => g.gateNumber));
    const free = GATE_SLOTS.find((n) => !taken.has(n));
    setCreateError(null);
    setGNumber(String(free ?? 0));
    setGName("");
    setGDescription("");
    setGPlanned("");
    setGCriteria([{ text: "", evidenceRequired: false }]);
    setCreateOpen(true);
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    const criteria = gCriteria
      .map((c) => ({ ...c, text: c.text.trim() }))
      .filter((c) => c.text !== "");
    if (criteria.length === 0) {
      setCreateError("A gate needs at least one review criterion.");
      return;
    }
    setBusy(true);
    try {
      await api.post(`${base}/stage-gates`, {
        gateNumber: Number(gNumber),
        name: gName.trim(),
        description: gDescription.trim() || null,
        plannedDate: gPlanned || null,
        criteria,
      });
      setCreateOpen(false);
      await load();
    } catch (err) {
      setCreateError(err instanceof ApiClientError ? err.message : "Failed to create the gate.");
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------ review modal ------------------------------ */

  const [reviewGate, setReviewGate] = useState<StageGateDetail | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [rDate, setRDate] = useState(todayIso());
  const [rRag, setRRag] = useState("amber");
  const [rDecision, setRDecision] = useState("proceed");
  const [rNarrative, setRNarrative] = useState("");
  const [rFindings, setRFindings] = useState<Record<string, { met?: boolean; note: string }>>({});
  const [rConditions, setRConditions] = useState<{ text: string; dueDate: string }[]>([]);

  function openReview(gate: StageGateDetail) {
    setReviewError(null);
    setRDate(todayIso());
    setRRag("amber");
    setRDecision("proceed");
    setRNarrative("");
    const seed: Record<string, { met?: boolean; note: string }> = {};
    for (const c of gate.criteria) seed[c.id] = { note: "" };
    setRFindings(seed);
    setRConditions([]);
    setReviewGate(gate);
  }

  const unresolvedCount = reviewGate
    ? reviewGate.criteria.filter((c) => rFindings[c.id]?.met === undefined).length
    : 0;

  async function onSubmitReview(e: FormEvent) {
    e.preventDefault();
    if (!reviewGate) return;
    if (unresolvedCount > 0) {
      setReviewError(
        `Findings must cover every criterion — ${unresolvedCount} still unassessed.`,
      );
      return;
    }
    setReviewError(null);
    setBusy(true);
    try {
      await api.post(`${base}/stage-gates/${reviewGate.id}/reviews`, {
        reviewDate: rDate,
        rag: rRag,
        decision: rDecision,
        narrative: rNarrative.trim() || null,
        findings: reviewGate.criteria.map((c) => ({
          criterionId: c.id,
          met: rFindings[c.id]?.met === true,
          ...(rFindings[c.id]?.note.trim() ? { note: rFindings[c.id]!.note.trim() } : {}),
        })),
        conditions: rConditions
          .map((c) => ({ ...c, text: c.text.trim() }))
          .filter((c) => c.text !== "")
          .map((c) => ({ text: c.text, ...(c.dueDate ? { dueDate: c.dueDate } : {}) })),
      });
      setReviewGate(null);
      await load();
    } catch (err) {
      setReviewError(err instanceof ApiClientError ? err.message : "Failed to record the review.");
    } finally {
      setBusy(false);
    }
  }

  /* -------------------------- close condition modal -------------------------- */

  const [closing, setClosing] = useState<OpenCondition | null>(null);
  const [closeNote, setCloseNote] = useState("");
  const [closeError, setCloseError] = useState<string | null>(null);

  async function onCloseCondition(e: FormEvent) {
    e.preventDefault();
    if (!closing) return;
    setCloseError(null);
    setBusy(true);
    try {
      await api.post(
        `${base}/gate-reviews/${closing.reviewId}/conditions/${closing.conditionId}/close`,
        { note: closeNote.trim() || null },
      );
      setClosing(null);
      setCloseNote("");
      await load();
    } catch (err) {
      setCloseError(err instanceof ApiClientError ? err.message : "Failed to close the condition.");
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------------- render ---------------------------------- */

  if (gates === null) return <Spinner />;

  return (
    <div>
      <ErrorAlert message={error} />

      {gates.length === 0 ? (
        <EmptyState
          title="No stage gates defined"
          hint="Define the OGC/IPA-style Gateway 0-5 gates with their review criteria — independent reviews record a delivery-confidence RAG and a decision with conditions."
          action={<Button onClick={openCreate}>Define a gate</Button>}
        />
      ) : (
        <>
          <GatewayTimeline gates={gates} />

          <div className="mb-2 flex items-center justify-between">
            <SectionTitle>Gates</SectionTitle>
            <Button size="sm" variant="secondary" onClick={openCreate}>
              Define a gate
            </Button>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {gates.map((gate) => {
              const latest: GateReview | undefined = gate.reviews[0];
              const findingsByCriterion = new Map(
                (latest?.findings ?? []).map((f) => [f.criterionId, f]),
              );
              return (
                <Card key={gate.id}>
                  <CardBody>
                    <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="text-sm font-semibold text-ink-900">
                          Gate {gate.gateNumber} — {gate.name}
                        </div>
                        <div className="mt-0.5 text-xs text-ink-400">
                          {gate.plannedDate
                            ? `Planned ${formatDate(gate.plannedDate)}`
                            : "No planned date"}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge tone={gateStatusTone(gate.status)}>{humanize(gate.status)}</Badge>
                        <Button size="sm" variant="secondary" onClick={() => openReview(gate)}>
                          Hold review
                        </Button>
                      </div>
                    </div>

                    {gate.description ? (
                      <p className="mb-2 text-xs leading-5 text-ink-500">{gate.description}</p>
                    ) : null}

                    {/* criteria checklist */}
                    <div className="mb-3 space-y-1">
                      {gate.criteria.map((c: GateCriterion) => {
                        const finding = findingsByCriterion.get(c.id);
                        return (
                          <div key={c.id} className="flex items-start gap-2 text-xs">
                            {finding === undefined ? (
                              <span className="mt-0.5 text-ink-300" aria-label="not yet assessed">
                                ○
                              </span>
                            ) : finding.met ? (
                              <span className="mt-0.5 font-bold text-emerald-600" aria-label="met">
                                ✓
                              </span>
                            ) : (
                              <span className="mt-0.5 font-bold text-red-600" aria-label="not met">
                                ✕
                              </span>
                            )}
                            <div className="min-w-0">
                              <span className="text-ink-700">{c.text}</span>
                              {c.evidenceRequired ? (
                                <span className="ml-1.5 rounded bg-ink-100 px-1 py-px text-[10px] font-medium uppercase tracking-wide text-ink-500">
                                  evidence
                                </span>
                              ) : null}
                              {finding?.note ? (
                                <div className="text-[11px] italic text-ink-400">{finding.note}</div>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* latest review summary */}
                    {latest ? (
                      <div className="rounded-md bg-ink-50 px-3 py-2">
                        <div className="mb-1 flex flex-wrap items-center gap-2">
                          <RagChip rag={latest.rag} />
                          <DecisionChip decision={latest.decision} />
                          <span className="text-xs text-ink-400">
                            reviewed {formatDate(latest.reviewDate)}
                            {gate.reviews.length > 1
                              ? ` · ${gate.reviews.length} reviews on record`
                              : ""}
                          </span>
                        </div>
                        {latest.narrative ? (
                          <p className="text-xs leading-5 text-ink-600">{latest.narrative}</p>
                        ) : null}
                        {latest.conditions.length > 0 ? (
                          <div className="mt-1 text-[11px] text-ink-500">
                            {latest.conditions.filter((c) => !c.closed).length} of{" "}
                            {latest.conditions.length} condition
                            {latest.conditions.length === 1 ? "" : "s"} still open
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="rounded-md border border-dashed border-ink-200 px-3 py-2 text-xs text-ink-400">
                        Not yet reviewed.
                      </div>
                    )}
                  </CardBody>
                </Card>
              );
            })}
          </div>

          {/* ------------------------- open conditions panel ------------------------- */}
          <div className="mt-6">
            <SectionTitle>Open conditions of approval</SectionTitle>
            {conditions.length === 0 ? (
              <div className="rounded-lg border border-dashed border-ink-200 bg-white/50 px-4 py-6 text-center text-xs text-ink-400">
                No open conditions — every condition of approval has been discharged.
              </div>
            ) : (
              <Card>
                <div className="divide-y divide-ink-100">
                  {conditions.map((c) => (
                    <div
                      key={c.conditionId}
                      className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-ink-800">{c.text}</div>
                        <div className="mt-0.5 text-xs text-ink-400">
                          {c.gateNumber !== null ? `Gate ${c.gateNumber}` : "Gate"}
                          {c.gateName ? ` — ${c.gateName}` : ""}
                          {c.dueDate ? ` · due ${formatDate(c.dueDate)}` : ""}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <DueBadge days={c.daysToDue} />
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            setCloseError(null);
                            setCloseNote("");
                            setClosing(c);
                          }}
                        >
                          Close
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        </>
      )}

      {/* ------------------------------ create modal ------------------------------ */}
      <Modal open={createOpen} title="Define a stage gate" onClose={() => setCreateOpen(false)} wide>
        <ErrorAlert message={createError} />
        <form onSubmit={onCreate} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Gate number">
              <Select value={gNumber} onChange={(e) => setGNumber(e.target.value)}>
                {GATE_SLOTS.map((n) => (
                  <option
                    key={n}
                    value={n}
                    disabled={(gates ?? []).some((g) => g.gateNumber === n)}
                  >
                    Gate {n}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Name">
              <Input
                required
                value={gName}
                onChange={(e) => setGName(e.target.value)}
                placeholder="e.g. Delivery strategy"
              />
            </Field>
            <Field label="Planned date">
              <Input type="date" value={gPlanned} onChange={(e) => setGPlanned(e.target.value)} />
            </Field>
          </div>
          <Field label="Description">
            <Textarea
              value={gDescription}
              onChange={(e) => setGDescription(e.target.value)}
              className="min-h-14"
            />
          </Field>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-ink-600">Review criteria</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setGCriteria((prev) => [...prev, { text: "", evidenceRequired: false }])
                }
              >
                + Add criterion
              </Button>
            </div>
            <div className="space-y-2">
              {gCriteria.map((c, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={c.text}
                    onChange={(e) =>
                      setGCriteria((prev) =>
                        prev.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)),
                      )
                    }
                    placeholder={`Criterion ${i + 1}`}
                  />
                  <label className="flex shrink-0 items-center gap-1.5 text-xs text-ink-500">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-brand-600"
                      checked={c.evidenceRequired}
                      onChange={(e) =>
                        setGCriteria((prev) =>
                          prev.map((x, j) =>
                            j === i ? { ...x, evidenceRequired: e.target.checked } : x,
                          ),
                        )
                      }
                    />
                    evidence
                  </label>
                  {gCriteria.length > 1 ? (
                    <button
                      type="button"
                      className="shrink-0 rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
                      aria-label="Remove criterion"
                      onClick={() => setGCriteria((prev) => prev.filter((_, j) => j !== i))}
                    >
                      ✕
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create gate"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ------------------------------ review modal ------------------------------ */}
      <Modal
        open={reviewGate !== null}
        title={reviewGate ? `Gate ${reviewGate.gateNumber} review — ${reviewGate.name}` : "Review"}
        onClose={() => setReviewGate(null)}
        wide
      >
        <ErrorAlert message={reviewError} />
        {reviewGate ? (
          <form onSubmit={onSubmitReview} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label="Review date">
                <Input
                  type="date"
                  required
                  value={rDate}
                  onChange={(e) => setRDate(e.target.value)}
                />
              </Field>
              <Field label="Delivery confidence (RAG)">
                <Select value={rRag} onChange={(e) => setRRag(e.target.value)}>
                  {RAG_OPTIONS.map((r) => (
                    <option key={r} value={r}>
                      {RAG_META[r]?.label ?? r}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Decision">
                <Select value={rDecision} onChange={(e) => setRDecision(e.target.value)}>
                  {DECISION_OPTIONS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <div>
              <span className="mb-1 block text-xs font-medium text-ink-600">
                Findings — every criterion must be assessed
              </span>
              <div className="space-y-2">
                {reviewGate.criteria.map((c) => {
                  const f = rFindings[c.id] ?? { note: "" };
                  return (
                    <div key={c.id} className="rounded-md bg-ink-50 px-3 py-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="min-w-0 flex-1 text-xs text-ink-700">{c.text}</span>
                        <div className="flex shrink-0 gap-1">
                          <button
                            type="button"
                            onClick={() =>
                              setRFindings((prev) => ({
                                ...prev,
                                [c.id]: { ...f, met: true },
                              }))
                            }
                            className={`rounded px-2 py-1 text-xs font-medium ${
                              f.met === true
                                ? "bg-emerald-600 text-white"
                                : "bg-white text-ink-500 ring-1 ring-ink-200 hover:bg-ink-100"
                            }`}
                          >
                            Met
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setRFindings((prev) => ({
                                ...prev,
                                [c.id]: { ...f, met: false },
                              }))
                            }
                            className={`rounded px-2 py-1 text-xs font-medium ${
                              f.met === false
                                ? "bg-red-600 text-white"
                                : "bg-white text-ink-500 ring-1 ring-ink-200 hover:bg-ink-100"
                            }`}
                          >
                            Not met
                          </button>
                        </div>
                      </div>
                      <Input
                        value={f.note}
                        onChange={(e) =>
                          setRFindings((prev) => ({
                            ...prev,
                            [c.id]: { ...f, note: e.target.value },
                          }))
                        }
                        placeholder="Note (optional)"
                        className="mt-1.5 py-1 text-xs"
                      />
                    </div>
                  );
                })}
              </div>
              {unresolvedCount > 0 ? (
                <WarnBanner
                  message={`${unresolvedCount} criterion${unresolvedCount === 1 ? "" : "s"} not yet assessed — findings must cover every criterion.`}
                />
              ) : null}
            </div>

            <Field label="Narrative" hint="Delivery confidence assessment narrative (#414).">
              <Textarea
                value={rNarrative}
                onChange={(e) => setRNarrative(e.target.value)}
                className="min-h-16"
              />
            </Field>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-medium text-ink-600">
                  Conditions of approval — each materializes as an assurance obligation
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setRConditions((prev) => [...prev, { text: "", dueDate: "" }])}
                >
                  + Add condition
                </Button>
              </div>
              {rConditions.length === 0 ? (
                <div className="rounded-md border border-dashed border-ink-200 px-3 py-2 text-xs text-ink-400">
                  No conditions attached.
                </div>
              ) : (
                <div className="space-y-2">
                  {rConditions.map((c, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input
                        value={c.text}
                        onChange={(e) =>
                          setRConditions((prev) =>
                            prev.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)),
                          )
                        }
                        placeholder={`Condition ${i + 1}`}
                      />
                      <Input
                        type="date"
                        value={c.dueDate}
                        onChange={(e) =>
                          setRConditions((prev) =>
                            prev.map((x, j) => (j === i ? { ...x, dueDate: e.target.value } : x)),
                          )
                        }
                        className="w-40 shrink-0"
                      />
                      <button
                        type="button"
                        className="shrink-0 rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
                        aria-label="Remove condition"
                        onClick={() => setRConditions((prev) => prev.filter((_, j) => j !== i))}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setReviewGate(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || unresolvedCount > 0}>
                {busy ? "Recording…" : "Record review"}
              </Button>
            </div>
          </form>
        ) : null}
      </Modal>

      {/* -------------------------- close condition modal ------------------------- */}
      <Modal open={closing !== null} title="Close condition" onClose={() => setClosing(null)}>
        <ErrorAlert message={closeError} />
        {closing ? (
          <form onSubmit={onCloseCondition} className="space-y-4">
            <p className="text-sm text-ink-700">{closing.text}</p>
            <Field label="Closure note" hint="How the condition was discharged (optional).">
              <Textarea
                value={closeNote}
                onChange={(e) => setCloseNote(e.target.value)}
                className="min-h-16"
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setClosing(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Closing…" : "Close condition"}
              </Button>
            </div>
          </form>
        ) : null}
      </Modal>
    </div>
  );
}
