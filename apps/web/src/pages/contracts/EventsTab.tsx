/**
 * Events & Notices tab — the contract event register and the time-bar engine
 * (#225-231).
 *
 * Raising an event under a clause fixes the notice deadline from the EFFECTIVE
 * clause (the library merged with the contract's Particular Conditions),
 * counted on the contract's calendar. Serving the notice discharges the
 * obligation and starts whatever deadline the form chains after it. Late
 * service is recorded as late — a barred event stays visibly barred rather
 * than collapsing to a clean "notice served".
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { CONTRACT_EVENT_KINDS } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { formatDate, formatDateTime, formatMoney, humanize } from "../format";
import {
  addDaysIso,
  DeadlineBadge,
  deadlineSourceLabel,
  DetailRow,
  eventLabel,
  eventStatusTone,
  InfoBanner,
  kindTone,
  NOTICE_METHODS,
  todayIso,
  type ContractEventRow,
  type EffectiveClause,
  type ListResponse,
} from "./contractsShared";

/* ------------------------------ Create modal ------------------------------- */

function CreateEventModal({
  projectId,
  contractId,
  clauses,
  initialClauseRef,
  onClose,
  onCreated,
}: {
  projectId: string;
  contractId: string;
  clauses: EffectiveClause[];
  initialClauseRef: string | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [kind, setKind] = useState<string>("claim_notice");
  const [clauseRef, setClauseRef] = useState(initialClauseRef ?? "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [eventDate, setEventDate] = useState(todayIso());
  const [awarenessDate, setAwarenessDate] = useState("");
  const [manualBar, setManualBar] = useState("");
  const [costImpact, setCostImpact] = useState("");
  const [timeImpact, setTimeImpact] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clause = clauses.find((c) => c.clauseRef === clauseRef);
  // the bar runs from awareness where one is recorded, and the EFFECTIVE bar
  // is the amended one when the Particular Conditions changed it
  const barStart = awarenessDate || eventDate;
  const effectiveBar = clause?.deleted
    ? null
    : (clause?.timeBarDays ?? (manualBar ? Number(manualBar) : null));
  const deadlinePreview =
    effectiveBar && barStart && Number.isFinite(effectiveBar)
      ? addDaysIso(barStart, effectiveBar)
      : null;
  const amendedBar = Boolean(
    clause?.amended && clause.libraryTimeBarDays != null && clause.timeBarDays !== clause.libraryTimeBarDays,
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        kind,
        title: title.trim(),
        eventDate,
      };
      if (awarenessDate) payload["awarenessDate"] = awarenessDate;
      if (manualBar && !clause?.timeBarDays) payload["timeBarDays"] = Number(manualBar);
      if (clauseRef) payload["clauseRef"] = clauseRef;
      if (description.trim()) payload["description"] = description.trim();
      const cost = costImpact.trim() === "" ? undefined : Number(costImpact);
      if (cost !== undefined && Number.isFinite(cost)) payload["costImpactEstimate"] = cost;
      const days = timeImpact.trim() === "" ? undefined : Number(timeImpact);
      if (days !== undefined && Number.isFinite(days)) {
        payload["timeImpactDaysEstimate"] = Math.trunc(days);
      }
      await api.post(
        `/api/v1/projects/${projectId}/contracts/${contractId}/events`,
        payload,
      );
      onCreated();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to raise the event.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title="Raise contract event" onClose={onClose} wide>
      <ErrorAlert message={error} />
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {CONTRACT_EVENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {humanize(k)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Clause"
            hint="A clause with a time bar fixes the notice deadline automatically."
          >
            <Select value={clauseRef} onChange={(e) => setClauseRef(e.target.value)}>
              <option value="">— none —</option>
              {clauses.map((c) => (
                <option key={c.clauseRef} value={c.clauseRef}>
                  {c.clauseRef} · {c.title.slice(0, 60)}
                  {c.deleted
                    ? " (deleted by PC)"
                    : c.timeBarDays
                      ? ` (${c.timeBarDays}d bar${
                          c.libraryTimeBarDays != null && c.libraryTimeBarDays !== c.timeBarDays
                            ? ", amended"
                            : ""
                        })`
                      : ""}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Title">
          <Input
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Unforeseen rock encountered in basement excavation"
          />
        </Field>
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field
            label="Event date"
            hint={
              deadlinePreview
                ? `Notice deadline: ${formatDate(deadlinePreview)}${amendedBar ? " (amended by the Particular Conditions)" : ""}`
                : clause?.deleted
                  ? "This clause is deleted by the Particular Conditions — no bar applies."
                  : clause
                    ? "No day-counted bar for this clause."
                    : undefined
            }
          >
            <Input
              type="date"
              required
              value={eventDate}
              onChange={(e) => setEventDate(e.target.value)}
            />
          </Field>
          <Field
            label="Awareness date"
            hint="Most bars run from when the claiming party became aware, not from the event."
          >
            <Input
              type="date"
              value={awarenessDate}
              onChange={(e) => setAwarenessDate(e.target.value)}
            />
          </Field>
          {!clause?.timeBarDays ? (
            <Field
              label="Time bar (days)"
              hint="For a bespoke form or an unlisted clause, state the bar so the engine can track it."
            >
              <Input
                inputMode="numeric"
                value={manualBar}
                onChange={(e) => setManualBar(e.target.value)}
              />
            </Field>
          ) : null}
          <Field label="Cost impact (est.)">
            <Input
              inputMode="decimal"
              value={costImpact}
              onChange={(e) => setCostImpact(e.target.value)}
            />
          </Field>
          <Field label="Time impact (est. days)">
            <Input
              inputMode="numeric"
              value={timeImpact}
              onChange={(e) => setTimeImpact(e.target.value)}
            />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !title.trim() || !eventDate}>
            {busy ? "Raising…" : "Raise event"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------- Event drawer ------------------------------ */

/* ----------------------------- Notice pack -------------------------------- */

interface NoticeRequirement {
  key: string;
  label: string;
  satisfied: boolean;
  detail: string;
}

interface NoticePack {
  clauseRef: string | null;
  clauseTitle: string | null;
  deadline: string | null;
  daysRemaining: number | null;
  urgency: "expired" | "critical" | "soon" | "routine" | "no_bar";
  servedBy: string | null;
  addressee: string | null;
  addresseeRole: string;
  serviceRules: string[];
  requirements: NoticeRequirement[];
  missing: string[];
  draft: string;
  basis: string;
  noticeRequired: boolean;
  aiAvailable: boolean;
  note: string;
}

interface AiDraft {
  runId: string;
  subject: string | null;
  noticeText: string;
  missingFacts: string[];
  confidence: number | null;
  droppedCitations: number;
}

const URGENCY_TONE: Record<string, "red" | "amber" | "blue" | "slate"> = {
  expired: "red",
  critical: "red",
  soon: "amber",
  routine: "blue",
  no_bar: "slate",
};

/**
 * The notice a live time bar demands, composed from the contract and the
 * event record. The deterministic pack is always available; the AI drafter is
 * an enhancement on top of it and says so when it is not configured.
 */
function NoticePackPanel({ base }: { base: string }) {
  const [pack, setPack] = useState<NoticePack | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<AiDraft | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPack(await api.get<NoticePack>(`${base}/notice-pack`));
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to compose the notice pack.");
    } finally {
      setLoading(false);
    }
  }, [base]);

  async function runDrafter() {
    setAiBusy(true);
    setAiError(null);
    try {
      setDraft(await api.post<AiDraft>(`${base}/draft-notice`, {}));
    } catch (err) {
      setAiError(
        err instanceof ApiClientError
          ? err.message
          : "The notice drafter did not return a draft.",
      );
    } finally {
      setAiBusy(false);
    }
  }

  if (!pack) {
    return (
      <div className="mb-4 rounded-md border border-ink-100 p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-ink-900">Notice pack</h3>
            <p className="text-xs text-ink-500">
              What the notice must state, who it is served on, by which route — and a draft built
              only from facts on the record.
            </p>
          </div>
          <Button size="sm" variant="secondary" disabled={loading} onClick={() => void load()}>
            {loading ? "Composing…" : "Prepare notice"}
          </Button>
        </div>
        <ErrorAlert message={error} />
      </div>
    );
  }

  return (
    <div className="mb-4 space-y-3 rounded-md border border-ink-100 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink-900">
          Notice pack
          {pack.clauseRef ? (
            <span className="ml-2 font-mono text-xs font-normal text-ink-500">
              Clause {pack.clauseRef}
            </span>
          ) : null}
        </h3>
        <Badge tone={URGENCY_TONE[pack.urgency] ?? "slate"}>
          {pack.urgency === "no_bar"
            ? "No day-counted bar"
            : pack.daysRemaining !== null && pack.daysRemaining < 0
              ? `${Math.abs(pack.daysRemaining)} days past the deadline`
              : `${pack.daysRemaining ?? "—"} days remaining`}
        </Badge>
      </div>

      <p className="text-xs text-ink-500">{pack.basis}</p>

      <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <div>
          <span className="text-xs uppercase tracking-wide text-ink-400">Served on</span>
          <div className="text-ink-800">
            {pack.addressee ?? (
              <span className="text-amber-700">
                Not on record — the contract's {pack.addresseeRole} is not named
              </span>
            )}
          </div>
        </div>
        <div>
          <span className="text-xs uppercase tracking-wide text-ink-400">Given by</span>
          <div className="text-ink-800">{pack.servedBy ? humanize(pack.servedBy) : "Either party"}</div>
        </div>
      </div>

      <div>
        <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">
          Service rules
        </div>
        <ul className="mt-1 space-y-0.5 text-xs text-ink-600">
          {pack.serviceRules.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </div>

      <div>
        <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">
          The notice must state
        </div>
        <ul className="mt-1 space-y-1 text-sm">
          {pack.requirements.map((r) => (
            <li key={r.key} className="flex gap-2">
              <span className={r.satisfied ? "text-emerald-600" : "text-amber-600"}>
                {r.satisfied ? "✓" : "!"}
              </span>
              <span>
                <span className="text-ink-800">{r.label}</span>
                <span className="block text-xs text-ink-500">{r.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">Draft</div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void navigator.clipboard?.writeText(draft?.noticeText ?? pack.draft)}
            >
              Copy
            </Button>
            {pack.aiAvailable ? (
              <Button size="sm" variant="secondary" disabled={aiBusy} onClick={() => void runDrafter()}>
                {aiBusy ? "Drafting…" : "Draft with AI"}
              </Button>
            ) : null}
          </div>
        </div>
        {!pack.aiAvailable ? <InfoBanner message={pack.note} /> : null}
        <ErrorAlert message={aiError} />
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-ink-50 p-3 font-mono text-xs text-ink-800">
          {draft?.noticeText ?? pack.draft}
        </pre>
        {draft ? (
          <p className="mt-1 text-xs text-ink-500">
            Drafted by the notice drafter (run {draft.runId})
            {draft.confidence !== null ? ` · confidence ${Math.round(draft.confidence * 100)}%` : ""}
            {draft.droppedCitations > 0
              ? ` · ${draft.droppedCitations} unverifiable citation(s) dropped`
              : ""}
            . Review before serving.
          </p>
        ) : null}
        {(draft?.missingFacts ?? pack.missing).length > 0 ? (
          <div className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-900">
            <strong>Still missing:</strong> {(draft?.missingFacts ?? pack.missing).join("; ")}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function EventDrawer({
  projectId,
  contractId,
  event,
  currency,
  onClose,
  onChanged,
}: {
  projectId: string;
  contractId: string;
  event: ContractEventRow;
  currency: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [method, setMethod] = useState<string>("email");
  const [reference, setReference] = useState("");
  const [servedOn, setServedOn] = useState("");
  const [evidenceRef, setEvidenceRef] = useState("");
  const [lateReason, setLateReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lateBanner, setLateBanner] = useState<string | null>(null);

  const base = `/api/v1/projects/${projectId}/contracts/${contractId}/events/${event.id}`;
  const canServe = event.status === "open" || event.status === "time_barred";
  const canTransition = ["open", "notice_served", "time_barred"].includes(event.status);

  async function serveNotice(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLateBanner(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { method };
      if (reference.trim()) payload["reference"] = reference.trim();
      if (servedOn) payload["servedAt"] = `${servedOn}T12:00:00Z`;
      if (evidenceRef.trim()) payload["evidenceRef"] = evidenceRef.trim();
      if (lateReason.trim()) payload["reason"] = lateReason.trim();
      const res = await api.post<
        ContractEventRow & { late?: boolean; chainedEvents?: Array<{ clauseRef: string }> }
      >(`${base}/serve-notice`, payload);
      if (res?.late) {
        setLateBanner(
          "Notice served after the time bar — the event stays time-barred and the late service is recorded on the register.",
        );
      } else if ((res?.chainedEvents ?? []).length > 0) {
        setLateBanner(
          `Notice recorded. The next deadline under clause ${(res.chainedEvents ?? [])
            .map((c) => c.clauseRef)
            .join(", ")} has been opened automatically.`,
        );
      }
      onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to serve the notice.");
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(status: "resolved" | "withdrawn") {
    setError(null);
    setBusy(true);
    try {
      await api.post(`${base}/status`, { status });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to update the event.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title={`${eventLabel(event.number)} — ${event.title}`} onClose={onClose} wide>
      <ErrorAlert message={error} />
      <InfoBanner message={lateBanner} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge tone={kindTone(event.kind)}>{humanize(event.kind)}</Badge>
        <Badge tone={eventStatusTone(event.status)}>{humanize(event.status)}</Badge>
        {event.clauseRef ? (
          <span className="font-mono text-xs text-ink-500">Clause {event.clauseRef}</span>
        ) : null}
        <DeadlineBadge
          daysRemaining={event.daysToDeadline ?? null}
          timeBarred={event.status === "time_barred"}
        />
      </div>
      {event.description ? (
        <p className="mb-3 text-sm text-ink-700">{event.description}</p>
      ) : null}
      <div className="mb-4 divide-y divide-ink-100 rounded-md bg-ink-50 px-3 py-1">
        <DetailRow label="Event date">{formatDate(event.eventDate)}</DetailRow>
        {event.awarenessDate ? (
          <DetailRow label="Awareness date">{formatDate(event.awarenessDate)}</DetailRow>
        ) : null}
        <DetailRow label="Notice deadline">
          {event.noticeDeadline ? (
            <>
              {formatDate(event.noticeDeadline)}
              <span className="ml-2 text-xs text-ink-400">
                {event.effectiveTimeBarDays != null
                  ? `${event.effectiveTimeBarDays} ${event.calendarBasis === "working" ? "working" : "calendar"} days · `
                  : ""}
                {deadlineSourceLabel(event.deadlineSource)}
              </span>
            </>
          ) : (
            "—"
          )}
        </DetailRow>
        <DetailRow label="Cost impact (est.)">
          {event.costImpactEstimate !== null
            ? formatMoney(event.costImpactEstimate, currency)
            : "—"}
        </DetailRow>
        <DetailRow label="Time impact (est.)">
          {event.timeImpactDaysEstimate !== null ? `${event.timeImpactDaysEstimate} days` : "—"}
        </DetailRow>
        {event.noticeServedAt ? (
          <DetailRow label="Notice served">
            {formatDateTime(event.noticeServedAt)} · {humanize(event.noticeMethod ?? "")}
            {event.noticeReference ? ` · ${event.noticeReference}` : ""}
            {event.noticeServedLate ? (
              <Badge tone="red" className="ml-2">
                Served late
              </Badge>
            ) : null}
            {event.deadlineAtService ? (
              <span className="block text-xs text-ink-400">
                Deadline at service: {formatDate(event.deadlineAtService)}
              </span>
            ) : null}
            {event.lateReason ? (
              <span className="block text-xs text-ink-500">Reason: {event.lateReason}</span>
            ) : null}
            {event.serviceEvidenceRef ? (
              <span className="block text-xs text-ink-500">
                Proof of service: {event.serviceEvidenceRef}
              </span>
            ) : null}
          </DetailRow>
        ) : null}
        {event.chainStage ? (
          <DetailRow label="Follows">
            Chained from the preceding notice under clause {event.chainStage}
          </DetailRow>
        ) : null}
      </div>

      {(event.chainedEvents ?? []).length > 0 ? (
        <div className="mb-4 rounded-md bg-brand-50 p-3 ring-1 ring-brand-100">
          <div className="text-xs font-semibold uppercase tracking-wide text-brand-700">
            Deadlines this notice started
          </div>
          <ul className="mt-1 space-y-0.5 text-sm text-brand-900">
            {(event.chainedEvents ?? []).map((c) => (
              <li key={c.id}>
                Clause {c.clauseRef} — due{" "}
                {formatDate(c.deadline ?? c.noticeDeadline ?? null)}
                {c.status ? ` (${humanize(c.status)})` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {canServe ? <NoticePackPanel base={base} /> : null}

      {canServe ? (
        <form onSubmit={serveNotice} className="mb-4 space-y-3 rounded-md border border-ink-100 p-3">
          <h3 className="text-sm font-semibold text-ink-900">Serve notice</h3>
          {event.status === "time_barred" ? (
            <InfoBanner message="This event is already time-barred — a late notice is recorded but the entitlement may be lost." />
          ) : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Method">
              <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                {NOTICE_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {humanize(m)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reference">
              <Input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="NT-005 / letter ref"
              />
            </Field>
            <Field
              label="Date of service"
              hint="Leave blank for now. Recording service more than a day in the past needs a reason and proof."
            >
              <Input type="date" value={servedOn} onChange={(e) => setServedOn(e.target.value)} />
            </Field>
            <Field label="Proof of service">
              <Input
                value={evidenceRef}
                onChange={(e) => setEvidenceRef(e.target.value)}
                placeholder="Recorded-delivery number, email message-id"
              />
            </Field>
            <Field label="Reason for a backdated record" className="sm:col-span-2">
              <Input value={lateReason} onChange={(e) => setLateReason(e.target.value)} />
            </Field>
          </div>
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? "Serving…" : "Serve notice"}
          </Button>
        </form>
      ) : null}

      {canTransition ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void setStatus("resolved")}>
            Mark resolved
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void setStatus("withdrawn")}>
            Withdraw
          </Button>
        </div>
      ) : (
        <p className="text-xs text-ink-400">This event is {humanize(event.status).toLowerCase()} — no further actions.</p>
      )}
    </Modal>
  );
}

/* --------------------------------- Events tab ------------------------------ */

export default function EventsTab({
  projectId,
  contractId,
  clauses,
  currency,
  prefillClauseRef,
  onPrefillConsumed,
  onChanged,
}: {
  projectId: string;
  contractId: string;
  clauses: EffectiveClause[];
  currency: string;
  prefillClauseRef: string | null;
  onPrefillConsumed: () => void;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<ContractEventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createClauseRef, setCreateClauseRef] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const base = `/api/v1/projects/${projectId}/contracts/${contractId}/events`;

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({ pageSize: "100" });
      if (statusFilter) params.set("status", statusFilter);
      const res = await api.get<ListResponse<ContractEventRow>>(`${base}?${params}`);
      setRows(res?.items ?? []);
    } catch (err) {
      setRows([]);
      setError(err instanceof Error ? err.message : "Failed to load contract events");
    }
  }, [base, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  // "Raise event under this clause" from the Clauses tab
  useEffect(() => {
    if (prefillClauseRef) {
      setCreateClauseRef(prefillClauseRef);
      setCreateOpen(true);
      onPrefillConsumed();
    }
  }, [prefillClauseRef, onPrefillConsumed]);

  const selected = useMemo(
    () => rows?.find((r) => r.id === selectedId) ?? null,
    [rows, selectedId],
  );

  const refresh = useCallback(() => {
    void load();
    onChanged();
  }, [load, onChanged]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-ink-900">Events & notices</h2>
          <div className="w-40">
            <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">All statuses</option>
              {["open", "notice_served", "time_barred", "resolved", "withdrawn"].map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <Button
          onClick={() => {
            setCreateClauseRef(null);
            setCreateOpen(true);
          }}
        >
          Raise event
        </Button>
      </div>

      <ErrorAlert message={error} />

      {rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title={statusFilter ? "No events match the filter" : "No contract events yet"}
          hint={
            statusFilter
              ? "Try clearing the status filter."
              : "Raise events under their governing clause — the time-bar engine computes each notice deadline."
          }
          action={
            !statusFilter ? (
              <Button
                onClick={() => {
                  setCreateClauseRef(null);
                  setCreateOpen(true);
                }}
              >
                Raise the first event
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>No.</Th>
              <Th>Kind</Th>
              <Th>Title</Th>
              <Th>Clause</Th>
              <Th>Event date</Th>
              <Th>Deadline</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((ev) => (
              <tr
                key={ev.id}
                className="cursor-pointer hover:bg-ink-50/60"
                onClick={() => setSelectedId(ev.id)}
              >
                <Td className="whitespace-nowrap font-mono text-xs font-medium text-brand-700">
                  {eventLabel(ev.number)}
                </Td>
                <Td>
                  <Badge tone={kindTone(ev.kind)}>{humanize(ev.kind)}</Badge>
                </Td>
                <Td className="max-w-md truncate font-medium">{ev.title}</Td>
                <Td className="whitespace-nowrap font-mono text-xs">{ev.clauseRef ?? "—"}</Td>
                <Td className="whitespace-nowrap">{formatDate(ev.eventDate)}</Td>
                <Td className="whitespace-nowrap">
                  {ev.noticeDeadline ? (
                    <span className="inline-flex flex-col gap-0.5">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="text-xs text-ink-500">
                          {formatDate(ev.noticeDeadline)}
                        </span>
                        {ev.status === "open" || ev.status === "time_barred" ? (
                          <DeadlineBadge
                            daysRemaining={ev.daysToDeadline ?? null}
                            timeBarred={ev.status === "time_barred"}
                          />
                        ) : null}
                      </span>
                      <span
                        className={
                          ev.deadlineSource === "particular_condition"
                            ? "text-[11px] font-medium text-violet-700"
                            : "text-[11px] text-ink-400"
                        }
                      >
                        {deadlineSourceLabel(ev.deadlineSource)}
                      </span>
                    </span>
                  ) : (
                    <span className="text-xs text-ink-400">—</span>
                  )}
                </Td>
                <Td>
                  <Badge tone={eventStatusTone(ev.status)}>{humanize(ev.status)}</Badge>
                  {ev.noticeServedLate ? (
                    <Badge tone="red" className="ml-1">
                      Served late
                    </Badge>
                  ) : null}
                  {ev.ceState ? (
                    <span className="block text-[11px] text-ink-400">{humanize(ev.ceState)}</span>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {createOpen ? (
        <CreateEventModal
          projectId={projectId}
          contractId={contractId}
          clauses={clauses}
          initialClauseRef={createClauseRef}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            refresh();
          }}
        />
      ) : null}

      {selected ? (
        <EventDrawer
          projectId={projectId}
          contractId={contractId}
          event={selected}
          currency={currency}
          onClose={() => setSelectedId(null)}
          onChanged={refresh}
        />
      ) : null}
    </div>
  );
}
