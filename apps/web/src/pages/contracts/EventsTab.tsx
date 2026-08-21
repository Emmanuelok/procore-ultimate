/**
 * Events & Notices tab — the contract event register with the automatic
 * time-bar engine (#225-231): raising an event under a clause with a time bar
 * fixes the notice deadline, and serving the notice discharges the obligation.
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
  const [costImpact, setCostImpact] = useState("");
  const [timeImpact, setTimeImpact] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clause = clauses.find((c) => c.clauseRef === clauseRef);
  const deadlinePreview =
    clause?.timeBarDays && eventDate ? addDaysIso(eventDate, clause.timeBarDays) : null;

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
                  {c.timeBarDays ? ` (${c.timeBarDays}d bar)` : ""}
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
                ? `Notice deadline: ${formatDate(deadlinePreview)}`
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
      const res = await api.post<ContractEventRow & { late?: boolean }>(
        `${base}/serve-notice`,
        payload,
      );
      if (res?.late) {
        setLateBanner(
          "Notice served after the time bar — the related entitlement may already be barred.",
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
        <DetailRow label="Notice deadline">
          {event.noticeDeadline ? formatDate(event.noticeDeadline) : "—"}
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
          </DetailRow>
        ) : null}
      </div>

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
                    <span className="inline-flex items-center gap-1.5">
                      <span className="text-xs text-ink-500">{formatDate(ev.noticeDeadline)}</span>
                      {ev.status === "open" || ev.status === "time_barred" ? (
                        <DeadlineBadge
                          daysRemaining={ev.daysToDeadline ?? null}
                          timeBarred={ev.status === "time_barred"}
                        />
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-xs text-ink-400">—</span>
                  )}
                </Td>
                <Td>
                  <Badge tone={eventStatusTone(ev.status)}>{humanize(ev.status)}</Badge>
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
