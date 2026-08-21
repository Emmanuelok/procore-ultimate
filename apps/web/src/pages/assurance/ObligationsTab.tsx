/**
 * Obligations tab — contract obligations with deadline countdowns, lazy
 * breach detection (server-side), satisfy-with-evidence and waive flows.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../../lib/api";
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
  Table,
  Td,
  Textarea,
  Th,
  statusTone,
} from "../../ui";
import { formatDateTime, humanize } from "../format";
import {
  daysUntil,
  type EvidenceRow,
  type ListResponse,
  type ObligationRow,
} from "./assuranceShared";

interface UpcomingResponse {
  items: ObligationRow[];
  breached: number;
  windowDays: number;
}

interface CreateForm {
  sourceClause: string;
  trigger: string;
  deadline: string;
  warnDaysBefore: string;
  evidenceRequirement: string;
}

const emptyForm: CreateForm = {
  sourceClause: "",
  trigger: "",
  deadline: "",
  warnDaysBefore: "",
  evidenceRequirement: "",
};

export default function ObligationsTab({ projectId }: { projectId: string }) {
  const base = `/api/v1/projects/${projectId}/obligations`;

  const [upcoming, setUpcoming] = useState<UpcomingResponse | null>(null);
  const [items, setItems] = useState<ObligationRow[] | null>(null);
  const [evidence, setEvidence] = useState<EvidenceRow[]>([]);
  const [days, setDays] = useState(30);
  const [error, setError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<CreateForm>(emptyForm);
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [satisfyFor, setSatisfyFor] = useState<ObligationRow | null>(null);
  const [satisfyEvidenceId, setSatisfyEvidenceId] = useState("");
  const [waiveFor, setWaiveFor] = useState<ObligationRow | null>(null);
  const [waiveReason, setWaiveReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [up, all, evd] = await Promise.all([
        api.get<UpcomingResponse>(`${base}/upcoming?days=${days}`),
        api.get<ListResponse<ObligationRow>>(`${base}?pageSize=100`),
        api.get<ListResponse<EvidenceRow>>(
          `/api/v1/projects/${projectId}/evidence?pageSize=100`,
        ),
      ]);
      setUpcoming(up);
      setItems(all.items);
      setEvidence(evd.items);
    } catch (err) {
      setUpcoming(null);
      setItems([]);
      setError(err instanceof Error ? err.message : "Failed to load obligations");
    }
  }, [base, projectId, days]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setCreateError(null);
    try {
      const payload: Record<string, unknown> = {
        sourceClause: form.sourceClause.trim(),
        trigger: form.trigger.trim(),
      };
      if (form.deadline) payload["deadline"] = new Date(form.deadline).toISOString();
      if (form.warnDaysBefore.trim() !== "") payload["warnDaysBefore"] = Number(form.warnDaysBefore);
      if (form.evidenceRequirement.trim()) payload["evidenceRequirement"] = form.evidenceRequirement.trim();
      await api.post(base, payload);
      setCreateOpen(false);
      setForm(emptyForm);
      await load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create the obligation");
    } finally {
      setBusy(false);
    }
  }

  async function onSatisfy(e: FormEvent) {
    e.preventDefault();
    if (!satisfyFor || !satisfyEvidenceId) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await api.post(`${base}/${satisfyFor.id}/satisfy`, { evidenceId: satisfyEvidenceId });
      setSatisfyFor(null);
      setSatisfyEvidenceId("");
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to satisfy the obligation");
    } finally {
      setActionBusy(false);
    }
  }

  async function onWaive(e: FormEvent) {
    e.preventDefault();
    if (!waiveFor || !waiveReason.trim()) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await api.post(`${base}/${waiveFor.id}/waive`, { reason: waiveReason.trim() });
      setWaiveFor(null);
      setWaiveReason("");
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to waive the obligation");
    } finally {
      setActionBusy(false);
    }
  }

  function countdown(o: ObligationRow) {
    const d = daysUntil(o.deadline);
    if (d === null) return <span className="text-ink-400">no deadline</span>;
    if (o.status === "breached" || d < 0) {
      return <span className="font-semibold text-red-600">{Math.abs(d)}d overdue</span>;
    }
    const warn = o.warnDaysBefore !== null && d <= o.warnDaysBefore;
    return (
      <span className={warn ? "font-semibold text-amber-600" : "text-ink-700"}>
        {d === 0 ? "due today" : `${d}d remaining`}
      </span>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-ink-600">
          Upcoming window
          <div className="w-28">
            <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="180">180 days</option>
            </Select>
          </div>
          {upcoming && upcoming.breached > 0 ? (
            <Badge tone="red">{upcoming.breached} newly breached</Badge>
          ) : null}
        </div>
        <Button onClick={() => setCreateOpen(true)}>New obligation</Button>
      </div>

      <ErrorAlert message={error} />

      {items === null ? (
        <Spinner />
      ) : (
        <>
          <Card>
            <CardBody>
              <div className="mb-2 text-sm font-semibold text-ink-900">
                Coming due in the next {upcoming?.windowDays ?? days} days
              </div>
              {!upcoming || upcoming.items.length === 0 ? (
                <p className="text-sm text-ink-400">Nothing falls due inside this window.</p>
              ) : (
                <ul className="divide-y divide-ink-100">
                  {upcoming.items.map((o) => (
                    <li key={o.id} className="flex items-center justify-between gap-3 py-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-ink-900">{o.sourceClause}</div>
                        <div className="truncate text-xs text-ink-500">{o.trigger}</div>
                      </div>
                      <div className="whitespace-nowrap text-sm">{countdown(o)}</div>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          {items.length === 0 ? (
            <EmptyState
              title="No obligations recorded"
              hint="Extract time bars, notice requirements and deliverables from the contract."
              action={<Button onClick={() => setCreateOpen(true)}>Create the first obligation</Button>}
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Source clause</Th>
                  <Th>Trigger</Th>
                  <Th>Deadline</Th>
                  <Th>Countdown</Th>
                  <Th>Evidence required</Th>
                  <Th>Status</Th>
                  <Th />
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {items.map((o) => (
                  <tr key={o.id} className="hover:bg-ink-50/60">
                    <Td className="max-w-xs">
                      <span className="line-clamp-2 font-medium text-ink-900">{o.sourceClause}</span>
                    </Td>
                    <Td className="max-w-xs">
                      <span className="line-clamp-2 text-xs">{o.trigger}</span>
                    </Td>
                    <Td className="whitespace-nowrap text-xs">{formatDateTime(o.deadline)}</Td>
                    <Td className="whitespace-nowrap text-xs">{countdown(o)}</Td>
                    <Td className="max-w-[12rem]">
                      <span className="line-clamp-2 text-xs text-ink-500">
                        {o.evidenceRequirement ?? "—"}
                      </span>
                    </Td>
                    <Td>
                      <Badge tone={statusTone(o.status)}>{humanize(o.status)}</Badge>
                    </Td>
                    <Td className="whitespace-nowrap">
                      {o.status === "open" || o.status === "breached" ? (
                        <span className="flex gap-1.5">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              setSatisfyFor(o);
                              setSatisfyEvidenceId("");
                              setActionError(null);
                            }}
                          >
                            Satisfy
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setWaiveFor(o);
                              setWaiveReason("");
                              setActionError(null);
                            }}
                          >
                            Waive
                          </Button>
                        </span>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </>
      )}

      {/* Create modal */}
      <Modal open={createOpen} title="New obligation" onClose={() => setCreateOpen(false)}>
        <ErrorAlert message={createError} />
        <form onSubmit={onCreate} className="space-y-4">
          <Field label="Source clause" hint="Where in the contract this obligation originates.">
            <Input
              required
              value={form.sourceClause}
              onChange={(e) => setForm((f) => ({ ...f, sourceClause: e.target.value }))}
              placeholder="Clause 20.1 — notice of claim"
            />
          </Field>
          <Field label="Trigger">
            <Textarea
              required
              value={form.trigger}
              onChange={(e) => setForm((f) => ({ ...f, trigger: e.target.value }))}
              placeholder="Contractor becomes aware of an event giving rise to a claim"
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Deadline">
              <Input
                type="datetime-local"
                value={form.deadline}
                onChange={(e) => setForm((f) => ({ ...f, deadline: e.target.value }))}
              />
            </Field>
            <Field label="Warn days before">
              <Input
                type="number"
                min="0"
                max="365"
                value={form.warnDaysBefore}
                onChange={(e) => setForm((f) => ({ ...f, warnDaysBefore: e.target.value }))}
                placeholder="14"
              />
            </Field>
          </div>
          <Field label="Evidence requirement" hint="What proof satisfies this obligation.">
            <Textarea
              value={form.evidenceRequirement}
              onChange={(e) => setForm((f) => ({ ...f, evidenceRequirement: e.target.value }))}
              placeholder="Written notice with contemporaneous records"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create obligation"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Satisfy modal */}
      <Modal
        open={satisfyFor !== null}
        title="Satisfy obligation"
        onClose={() => setSatisfyFor(null)}
      >
        <ErrorAlert message={actionError} />
        <form onSubmit={onSatisfy} className="space-y-4">
          <p className="text-sm text-ink-600">{satisfyFor?.sourceClause}</p>
          <Field label="Satisfying evidence" hint="Choose the evidence record that discharges this obligation.">
            <Select
              required
              value={satisfyEvidenceId}
              onChange={(e) => setSatisfyEvidenceId(e.target.value)}
            >
              <option value="">Choose evidence…</option>
              {evidence.map((ev) => (
                <option key={ev.id} value={ev.id}>
                  {humanize(ev.kind)} — {ev.source.slice(0, 60)}
                </option>
              ))}
            </Select>
          </Field>
          {evidence.length === 0 ? (
            <p className="text-xs text-amber-700">
              No evidence exists on this project yet — ingest evidence in the Reconcile tab first.
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setSatisfyFor(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={actionBusy || !satisfyEvidenceId}>
              {actionBusy ? "Saving…" : "Mark satisfied"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Waive modal */}
      <Modal open={waiveFor !== null} title="Waive obligation" onClose={() => setWaiveFor(null)}>
        <ErrorAlert message={actionError} />
        <form onSubmit={onWaive} className="space-y-4">
          <p className="text-sm text-ink-600">{waiveFor?.sourceClause}</p>
          <Field label="Reason" hint="The waive reason is recorded permanently in the ledger.">
            <Textarea
              required
              value={waiveReason}
              onChange={(e) => setWaiveReason(e.target.value)}
              placeholder="Employer agreed extension per meeting minutes 2026-08-12"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setWaiveFor(null)}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" disabled={actionBusy || !waiveReason.trim()}>
              {actionBusy ? "Saving…" : "Waive"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
