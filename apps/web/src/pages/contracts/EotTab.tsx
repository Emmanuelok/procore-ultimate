/**
 * EOT Claims tab — extension-of-time claim lifecycle (#237-240):
 * notified → submitted → assessed → agreed | rejected | referred, with
 * determination independence enforced server-side (#232) and agreement
 * moving the contract completion date.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
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
import { formatDate, humanize } from "../format";
import {
  addDaysIso,
  eotLabel,
  eotStatusTone,
  eventLabel,
  InfoBanner,
  type ContractEventRow,
  type EffectiveClause,
  type EotClaimRow,
  type ListResponse,
} from "./contractsShared";

/** SCL Delay and Disruption Protocol methods, in the order it lists them. */
const DELAY_METHODS = [
  "time_impact_analysis",
  "as_planned_impacted",
  "collapsed_as_built",
  "as_planned_versus_as_built",
  "time_slice_windows",
  "impacted_as_planned_windows",
] as const;

const CONCURRENCY_FINDINGS = ["none", "true_concurrency", "sequential", "pacing"] as const;

const FLOAT_OWNERS = ["project", "contractor", "employer", "shared"] as const;

const INDEPENDENCE_MESSAGE =
  "Determination independence: an EOT claim cannot be assessed by the user who raised it — a different contract administrator must make the assessment.";

/* ------------------------------- Create modal ------------------------------ */

function CreateEotModal({
  projectId,
  contractId,
  clauses,
  events,
  onClose,
  onCreated,
}: {
  projectId: string;
  contractId: string;
  clauses: EffectiveClause[];
  events: ContractEventRow[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [clauseRef, setClauseRef] = useState("");
  const [daysClaimed, setDaysClaimed] = useState("");
  const [narrative, setNarrative] = useState("");
  const [eventIds, setEventIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const days = Number(daysClaimed);
  const valid = title.trim().length > 0 && Number.isInteger(days) && days >= 1;

  function toggleEvent(id: string) {
    setEventIds((cur) => (cur.includes(id) ? cur.filter((e) => e !== id) : [...cur, id]));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        title: title.trim(),
        daysClaimed: days,
      };
      if (clauseRef) payload["clauseRef"] = clauseRef;
      if (narrative.trim()) payload["narrative"] = narrative.trim();
      if (eventIds.length > 0) payload["eventIds"] = eventIds;
      await api.post(
        `/api/v1/projects/${projectId}/contracts/${contractId}/eot-claims`,
        payload,
      );
      onCreated();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to raise the EOT claim.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title="New EOT claim" onClose={onClose} wide>
      <ErrorAlert message={error} />
      <form onSubmit={submit} className="space-y-4">
        <Field label="Title">
          <Input
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="EOT for unforeseeable ground conditions, zone B"
          />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Clause">
            <Select value={clauseRef} onChange={(e) => setClauseRef(e.target.value)}>
              <option value="">— none —</option>
              {clauses.map((c) => (
                <option key={c.clauseRef} value={c.clauseRef}>
                  {c.clauseRef} · {c.title.slice(0, 60)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Days claimed" hint="Whole days of extension sought.">
            <Input
              required
              inputMode="numeric"
              value={daysClaimed}
              onChange={(e) => setDaysClaimed(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Narrative">
          <Textarea value={narrative} onChange={(e) => setNarrative(e.target.value)} />
        </Field>
        <Field
          label="Supporting events"
          hint={
            events.length === 0
              ? "No contract events recorded yet — the claim can still be raised without them."
              : "Link the contract events that ground the claim."
          }
        >
          {events.length === 0 ? (
            <p className="text-sm text-ink-400">No events available.</p>
          ) : (
            <div className="max-h-44 space-y-1 overflow-y-auto rounded-md border border-ink-200 p-2">
              {events.map((ev) => (
                <label key={ev.id} className="flex items-center gap-2 text-sm text-ink-700">
                  <input
                    type="checkbox"
                    checked={eventIds.includes(ev.id)}
                    onChange={() => toggleEvent(ev.id)}
                  />
                  <span className="font-mono text-xs text-brand-700">{eventLabel(ev.number)}</span>
                  <span className="truncate">{ev.title}</span>
                  <Badge tone="gray">{humanize(ev.status)}</Badge>
                </label>
              ))}
            </div>
          )}
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !valid}>
            {busy ? "Raising…" : "Raise claim"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* -------------------------------- Claim drawer ----------------------------- */

function ClaimDrawer({
  projectId,
  contractId,
  claim,
  events,
  completionDate,
  onClose,
  onChanged,
}: {
  projectId: string;
  contractId: string;
  claim: EotClaimRow;
  events: ContractEventRow[];
  completionDate: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [daysAwarded, setDaysAwarded] = useState(
    claim.daysAwarded !== null ? String(claim.daysAwarded) : String(claim.daysClaimed),
  );
  const [method, setMethod] = useState<string>("time_impact_analysis");
  const [concurrency, setConcurrency] = useState<string>("none");
  const [floatOwnership, setFloatOwnership] = useState<string>("project");
  const [reasons, setReasons] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [independenceBlocked, setIndependenceBlocked] = useState(false);

  const base = `/api/v1/projects/${projectId}/contracts/${contractId}/eot-claims/${claim.id}`;
  const linked = events.filter((ev) => claim.eventIds.includes(ev.id));

  async function setStatus(status: string, extra?: Record<string, unknown>) {
    setError(null);
    setIndependenceBlocked(false);
    setBusy(true);
    try {
      await api.post(`${base}/status`, { status, ...extra });
      onChanged();
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 403) {
        setIndependenceBlocked(true);
      } else {
        setError(err instanceof ApiClientError ? err.message : "Failed to update the claim.");
      }
    } finally {
      setBusy(false);
    }
  }

  const awarded = Number(daysAwarded);
  const awardValid = Number.isInteger(awarded) && awarded >= 0;
  const projectedCompletion =
    claim.status === "assessed" && completionDate && claim.daysAwarded !== null
      ? addDaysIso(completionDate, claim.daysAwarded)
      : null;

  return (
    <Modal open title={`${eotLabel(claim.number)} — ${claim.title}`} onClose={onClose} wide>
      <ErrorAlert message={error} />
      {independenceBlocked ? <InfoBanner message={INDEPENDENCE_MESSAGE} /> : null}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge tone={eotStatusTone(claim.status)}>{humanize(claim.status)}</Badge>
        {claim.clauseRef ? (
          <span className="font-mono text-xs text-ink-500">Clause {claim.clauseRef}</span>
        ) : null}
        <span className="text-sm text-ink-600">
          Claimed <span className="font-semibold tabular-nums">{claim.daysClaimed}d</span>
          {claim.daysAwarded !== null ? (
            <>
              {" "}
              · Awarded <span className="font-semibold tabular-nums">{claim.daysAwarded}d</span>
            </>
          ) : null}
        </span>
      </div>
      {claim.narrative ? <p className="mb-3 text-sm text-ink-700">{claim.narrative}</p> : null}

      {linked.length > 0 ? (
        <div className="mb-4">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
            Supporting events
          </h3>
          <ul className="space-y-1">
            {linked.map((ev) => (
              <li key={ev.id} className="flex items-center gap-2 text-sm text-ink-700">
                <span className="font-mono text-xs text-brand-700">{eventLabel(ev.number)}</span>
                <span className="truncate">{ev.title}</span>
                <Badge tone="gray">{humanize(ev.status)}</Badge>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {claim.status === "notified" ? (
        <Button size="sm" disabled={busy} onClick={() => void setStatus("submitted")}>
          Submit claim
        </Button>
      ) : null}

      {claim.status === "submitted" ? (
        <div className="space-y-3 rounded-md border border-ink-100 p-3">
          <h3 className="text-sm font-semibold text-ink-900">Assess</h3>
          <p className="text-xs text-ink-400">
            The assessor must be independent of the person who raised the claim, and the assessment
            must name the delay-analysis method it used — an award with no stated method cannot be
            defended.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <Field label="Days awarded">
              <Input
                inputMode="numeric"
                value={daysAwarded}
                onChange={(e) => setDaysAwarded(e.target.value)}
              />
            </Field>
            <Field label="Method (SCL protocol)">
              <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                {DELAY_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {humanize(m)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Concurrency">
              <Select value={concurrency} onChange={(e) => setConcurrency(e.target.value)}>
                {CONCURRENCY_FINDINGS.map((c) => (
                  <option key={c} value={c}>
                    {humanize(c)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Float ownership">
              <Select value={floatOwnership} onChange={(e) => setFloatOwnership(e.target.value)}>
                {FLOAT_OWNERS.map((f) => (
                  <option key={f} value={f}>
                    {humanize(f)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Reasons">
            <Textarea
              rows={3}
              value={reasons}
              onChange={(e) => setReasons(e.target.value)}
              placeholder="Which events drove planned Completion, and why the award is what it is."
            />
          </Field>
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={busy || !awardValid}
              onClick={() =>
                void setStatus("assessed", {
                  daysAwarded: awarded,
                  assessment: {
                    method,
                    concurrency,
                    floatOwnership,
                    ...(reasons.trim() ? { reasons: reasons.trim() } : {}),
                  },
                })
              }
            >
              Record assessment
            </Button>
          </div>
        </div>
      ) : null}

      {claim.status === "assessed" ? (
        <div className="space-y-3">
          {projectedCompletion ? (
            <p className="text-sm text-ink-600">
              Agreeing this award moves completion from{" "}
              <span className="font-medium">{formatDate(completionDate)}</span> to{" "}
              <span className="font-medium">{formatDate(projectedCompletion)}</span>.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => void setStatus("agreed")}>
              Agree award
            </Button>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => void setStatus("rejected")}>
              Reject
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void setStatus("referred")}>
              Refer to dispute
            </Button>
          </div>
        </div>
      ) : null}

      {["agreed", "rejected", "referred"].includes(claim.status) ? (
        <p className="text-xs text-ink-400">
          This claim is {humanize(claim.status).toLowerCase()} — no further actions.
          {claim.status === "agreed" && claim.daysAwarded !== null
            ? ` The contract completion date was extended by ${claim.daysAwarded} days.`
            : ""}
        </p>
      ) : null}
    </Modal>
  );
}

/* ---------------------------------- EOT tab -------------------------------- */

export default function EotTab({
  projectId,
  contractId,
  clauses,
  completionDate,
  onChanged,
}: {
  projectId: string;
  contractId: string;
  clauses: EffectiveClause[];
  completionDate: string | null;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<EotClaimRow[] | null>(null);
  const [events, setEvents] = useState<ContractEventRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const base = `/api/v1/projects/${projectId}/contracts/${contractId}`;

  const load = useCallback(async () => {
    setError(null);
    try {
      const [claims, evs] = await Promise.all([
        api.get<ListResponse<EotClaimRow>>(`${base}/eot-claims?pageSize=100`),
        api.get<ListResponse<ContractEventRow>>(`${base}/events?pageSize=100`),
      ]);
      setRows(claims?.items ?? []);
      setEvents(evs?.items ?? []);
    } catch (err) {
      setRows([]);
      setError(err instanceof Error ? err.message : "Failed to load EOT claims");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = rows?.find((r) => r.id === selectedId) ?? null;

  const refresh = useCallback(() => {
    void load();
    onChanged();
  }, [load, onChanged]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-ink-900">EOT claims</h2>
          <span className="text-xs text-ink-500">
            Current completion:{" "}
            <span className="font-medium text-ink-800">{formatDate(completionDate)}</span>
          </span>
        </div>
        <Button onClick={() => setCreateOpen(true)}>New EOT claim</Button>
      </div>

      <ErrorAlert message={error} />

      {rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No EOT claims yet"
          hint="Claims move notified → submitted → assessed → agreed; agreement extends the completion date."
          action={<Button onClick={() => setCreateOpen(true)}>Raise the first claim</Button>}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>No.</Th>
              <Th>Title</Th>
              <Th>Clause</Th>
              <Th className="text-right">Claimed</Th>
              <Th className="text-right">Awarded</Th>
              <Th>Events</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((c) => (
              <tr
                key={c.id}
                className="cursor-pointer hover:bg-ink-50/60"
                onClick={() => setSelectedId(c.id)}
              >
                <Td className="whitespace-nowrap font-mono text-xs font-medium text-brand-700">
                  {eotLabel(c.number)}
                </Td>
                <Td className="max-w-md truncate font-medium">{c.title}</Td>
                <Td className="whitespace-nowrap font-mono text-xs">{c.clauseRef ?? "—"}</Td>
                <Td className="text-right tabular-nums">{c.daysClaimed}d</Td>
                <Td className="text-right tabular-nums">
                  {c.daysAwarded !== null ? `${c.daysAwarded}d` : "—"}
                </Td>
                <Td className="text-right tabular-nums">{c.eventIds.length}</Td>
                <Td>
                  <Badge tone={eotStatusTone(c.status)}>{humanize(c.status)}</Badge>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {createOpen ? (
        <CreateEotModal
          projectId={projectId}
          contractId={contractId}
          clauses={clauses}
          events={events}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            refresh();
          }}
        />
      ) : null}

      {selected ? (
        <ClaimDrawer
          projectId={projectId}
          contractId={contractId}
          claim={selected}
          events={events}
          completionDate={completionDate}
          onClose={() => setSelectedId(null)}
          onChanged={refresh}
        />
      ) : null}
    </div>
  );
}
