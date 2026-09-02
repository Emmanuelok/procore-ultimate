/**
 * Delay event register (spec Domain D #265-268) with entitlement
 * classification, evidence links and per-event Time Impact Analysis (#272).
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { DELAY_CAUSES, DELAY_EVENT_STATUSES } from "@constructos/shared";
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
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { formatDate, humanize } from "../format";
import {
  causeTone,
  deLabel,
  delayStatusTone,
  DetailRow,
  Drawer,
  EcBadges,
  SectionTitle,
  TiaChip,
  type ContractEventLite,
  type ContractLite,
  type DelayEventDetail,
  type DelayEventRow,
  type EvidenceLite,
  type ListResponse,
  type ScheduleRow,
  type ScheduleTaskLite,
  type TiaResult,
} from "./forensicsShared";

const PAGE_SIZE = 25;

interface CreateForm {
  title: string;
  description: string;
  cause: string;
  excusable: boolean;
  compensable: boolean;
  scheduleId: string;
  taskId: string;
  startDate: string;
  durationDays: string;
  contractId: string;
  contractEventId: string;
  evidenceIds: string[];
}

const emptyForm: CreateForm = {
  title: "",
  description: "",
  cause: "client_change",
  excusable: true,
  compensable: false,
  scheduleId: "",
  taskId: "",
  startDate: "",
  durationDays: "1",
  contractId: "",
  contractEventId: "",
  evidenceIds: [],
};

export default function DelayEventsTab({ projectId }: { projectId: string }) {
  const base = `/api/v1/projects/${projectId}`;

  const [items, setItems] = useState<DelayEventRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);

  /* ------------------------------- register ------------------------------- */

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      const res = await api.get<ListResponse<DelayEventRow>>(`${base}/delay-events?${params}`);
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : "Failed to load delay events");
    }
  }, [base, page]);

  useEffect(() => {
    void load();
  }, [load]);

  /* ----------------------------- create modal ----------------------------- */

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<CreateForm>(emptyForm);
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [tasks, setTasks] = useState<ScheduleTaskLite[]>([]);
  const [contracts, setContracts] = useState<ContractLite[]>([]);
  const [contractEvents, setContractEvents] = useState<ContractEventLite[]>([]);
  const [evidencePool, setEvidencePool] = useState<EvidenceLite[]>([]);

  function set<K extends keyof CreateForm>(key: K, value: CreateForm[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function openCreate() {
    setCreateError(null);
    setForm(emptyForm);
    setTasks([]);
    setContractEvents([]);
    setCreateOpen(true);
    try {
      const [sch, con, ev] = await Promise.all([
        api.get<ListResponse<ScheduleRow>>(`${base}/schedules?pageSize=100`),
        api.get<ListResponse<ContractLite>>(`${base}/contracts?pageSize=100`),
        api.get<ListResponse<EvidenceLite>>(`${base}/evidence?pageSize=100`),
      ]);
      setSchedules(sch.items);
      setContracts(con.items);
      setEvidencePool(ev.items);
    } catch {
      // pickers stay empty; the event can still be created without links
    }
  }

  async function onScheduleChange(scheduleId: string) {
    set("scheduleId", scheduleId);
    set("taskId", "");
    setTasks([]);
    if (!scheduleId) return;
    try {
      const detail = await api.get<{ tasks: ScheduleTaskLite[] }>(
        `${base}/schedules/${scheduleId}`,
      );
      setTasks(detail.tasks ?? []);
    } catch {
      setTasks([]);
    }
  }

  async function onContractChange(contractId: string) {
    set("contractId", contractId);
    set("contractEventId", "");
    setContractEvents([]);
    if (!contractId) return;
    try {
      const res = await api.get<ListResponse<ContractEventLite>>(
        `${base}/contracts/${contractId}/events?pageSize=100`,
      );
      setContractEvents(res.items);
    } catch {
      setContractEvents([]);
    }
  }

  function toggleEvidence(id: string) {
    setForm((f) => ({
      ...f,
      evidenceIds: f.evidenceIds.includes(id)
        ? f.evidenceIds.filter((e) => e !== id)
        : [...f.evidenceIds, id],
    }));
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setBusy(true);
    try {
      const duration = Number(form.durationDays);
      const payload: Record<string, unknown> = {
        title: form.title.trim(),
        cause: form.cause,
        excusable: form.excusable,
        compensable: form.excusable ? form.compensable : false,
        startDate: form.startDate,
        durationDays: Number.isFinite(duration) ? Math.round(duration) : 1,
      };
      if (form.description.trim()) payload["description"] = form.description.trim();
      if (form.scheduleId) payload["scheduleId"] = form.scheduleId;
      if (form.taskId) payload["taskId"] = form.taskId;
      if (form.contractEventId) payload["contractEventId"] = form.contractEventId;
      if (form.evidenceIds.length > 0) payload["evidenceIds"] = form.evidenceIds;
      await api.post<DelayEventRow>(`${base}/delay-events`, payload);
      setCreateOpen(false);
      setPage(1);
      await load();
    } catch (err) {
      setCreateError(
        err instanceof ApiClientError ? err.message : "Failed to register the delay event.",
      );
    } finally {
      setBusy(false);
    }
  }

  /* -------------------------------- drawer -------------------------------- */

  const [selected, setSelected] = useState<DelayEventDetail | null>(null);
  const [drawerError, setDrawerError] = useState<string | null>(null);
  const [tiaBusy, setTiaBusy] = useState(false);
  const [tiaBanner, setTiaBanner] = useState<TiaResult | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);

  async function openDrawer(id: string) {
    setDrawerError(null);
    setTiaBanner(null);
    try {
      const detail = await api.get<DelayEventDetail>(`${base}/delay-events/${id}`);
      setSelected(detail);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the delay event");
    }
  }

  async function runTia() {
    if (!selected) return;
    setDrawerError(null);
    setTiaBusy(true);
    try {
      const res = await api.post<TiaResult>(`${base}/delay-events/${selected.id}/tia`);
      setTiaBanner(res);
      await openDrawer(selected.id);
      await load();
    } catch (err) {
      setDrawerError(err instanceof ApiClientError ? err.message : "TIA failed.");
    } finally {
      setTiaBusy(false);
    }
  }

  async function setStatus(status: string) {
    if (!selected) return;
    setDrawerError(null);
    setStatusBusy(true);
    try {
      await api.post(`${base}/delay-events/${selected.id}/status`, { status });
      await openDrawer(selected.id);
      await load();
    } catch (err) {
      setDrawerError(err instanceof ApiClientError ? err.message : "Status change failed.");
    } finally {
      setStatusBusy(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  /* -------------------------------- render -------------------------------- */

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-ink-500">
          Delay events are the atoms of the forensic model — classify entitlement, anchor a
          fragnet, attach evidence.
        </p>
        <Button onClick={() => void openCreate()}>Register delay event</Button>
      </div>

      <ErrorAlert message={error} />

      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState
          title="No delay events yet"
          hint="Register the first delay event to start the forensic record — cause, entitlement, duration and evidence."
          action={<Button onClick={() => void openCreate()}>Register delay event</Button>}
        />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>No.</Th>
                <Th>Title</Th>
                <Th>Cause</Th>
                <Th>E / C</Th>
                <Th className="text-right">Duration</Th>
                <Th>Start</Th>
                <Th>TIA Δ</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {items.map((ev) => (
                <tr
                  key={ev.id}
                  className="cursor-pointer hover:bg-ink-50/60"
                  onClick={() => void openDrawer(ev.id)}
                >
                  <Td className="whitespace-nowrap font-mono text-xs text-ink-500">
                    {deLabel(ev.number)}
                  </Td>
                  <Td className="max-w-64">
                    <span className="block truncate font-medium text-ink-900">{ev.title}</span>
                  </Td>
                  <Td>
                    <Badge tone={causeTone(ev.cause)}>{humanize(ev.cause)}</Badge>
                  </Td>
                  <Td>
                    <EcBadges excusable={ev.excusable} compensable={ev.compensable} />
                  </Td>
                  <Td className="whitespace-nowrap text-right tabular-nums">
                    {ev.durationDays}d
                  </Td>
                  <Td className="whitespace-nowrap">{formatDate(ev.startDate)}</Td>
                  <Td>
                    <TiaChip deltaDays={ev.tiaResult?.completionDeltaDays ?? null} />
                  </Td>
                  <Td>
                    <Badge tone={delayStatusTone(ev.status)}>{humanize(ev.status)}</Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>

          <div className="mt-4 flex items-center justify-between text-sm text-ink-500">
            <span>
              {total} event{total === 1 ? "" : "s"} · page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}

      {/* ------------------------------ create modal ------------------------------ */}
      <Modal
        open={createOpen}
        title="Register delay event"
        onClose={() => setCreateOpen(false)}
        wide
      >
        <ErrorAlert message={createError} />
        <form onSubmit={onCreate} className="space-y-4">
          <Field label="Title">
            <Input
              required
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              placeholder="Late release of piling design — Zone B"
            />
          </Field>
          <Field label="Description">
            <Textarea
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              className="min-h-16"
              placeholder="What happened, who was affected, how it was noticed…"
            />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Cause">
              <Select value={form.cause} onChange={(e) => set("cause", e.target.value)}>
                {DELAY_CAUSES.map((c) => (
                  <option key={c} value={c}>
                    {humanize(c)}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex items-end gap-4 pb-2">
              <label className="flex items-center gap-2 text-sm text-ink-700">
                <input
                  type="checkbox"
                  checked={form.excusable}
                  onChange={(e) => {
                    const excusable = e.target.checked;
                    setForm((f) => ({
                      ...f,
                      excusable,
                      compensable: excusable ? f.compensable : false,
                    }));
                  }}
                  className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
                />
                Excusable
              </label>
              <label
                className={`flex items-center gap-2 text-sm ${form.excusable ? "text-ink-700" : "text-ink-300"}`}
                title={form.excusable ? undefined : "A delay cannot be compensable without being excusable"}
              >
                <input
                  type="checkbox"
                  checked={form.compensable}
                  disabled={!form.excusable}
                  onChange={(e) => set("compensable", e.target.checked)}
                  className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500 disabled:opacity-50"
                />
                Compensable
              </label>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Schedule" hint="Fragnet insertion schedule — needed for TIA.">
              <Select
                value={form.scheduleId}
                onChange={(e) => void onScheduleChange(e.target.value)}
              >
                <option value="">None</option>
                {schedules.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.isActive === 1 ? " (active)" : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Struck task" hint="The task the delay strikes.">
              <Select
                value={form.taskId}
                disabled={!form.scheduleId}
                onChange={(e) => set("taskId", e.target.value)}
              >
                <option value="">None</option>
                {tasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.wbsCode ? `${t.wbsCode} — ` : ""}
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Start date">
              <Input
                type="date"
                required
                value={form.startDate}
                onChange={(e) => set("startDate", e.target.value)}
              />
            </Field>
            <Field label="Duration (days)">
              <Input
                type="number"
                min="1"
                step="1"
                required
                value={form.durationDays}
                onChange={(e) => set("durationDays", e.target.value)}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Contract" hint="To link a contract event (notice).">
              <Select
                value={form.contractId}
                onChange={(e) => void onContractChange(e.target.value)}
              >
                <option value="">None</option>
                {contracts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Contract event">
              <Select
                value={form.contractEventId}
                disabled={!form.contractId}
                onChange={(e) => set("contractEventId", e.target.value)}
              >
                <option value="">None</option>
                {contractEvents.map((ev) => (
                  <option key={ev.id} value={ev.id}>
                    CE-{ev.number} — {ev.title}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <fieldset className="rounded-md border border-ink-200 p-3">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
              Substantiating evidence
            </legend>
            {evidencePool.length === 0 ? (
              <p className="text-xs text-ink-400">No evidence records in this project yet.</p>
            ) : (
              <div className="max-h-40 space-y-1 overflow-y-auto">
                {evidencePool.map((ev) => (
                  <label key={ev.id} className="flex items-center gap-2 text-sm text-ink-700">
                    <input
                      type="checkbox"
                      checked={form.evidenceIds.includes(ev.id)}
                      onChange={() => toggleEvidence(ev.id)}
                      className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
                    />
                    <Badge tone="gray">{humanize(ev.kind)}</Badge>
                    <span className="truncate">{ev.source}</span>
                    <span className="text-xs text-ink-400">{formatDate(ev.capturedAt)}</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Registering…" : "Register event"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* --------------------------------- drawer --------------------------------- */}
      {selected ? (
        <Drawer onClose={() => setSelected(null)}>
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <div className="mb-1 flex items-center gap-2">
                <span className="font-mono text-xs text-ink-400">{deLabel(selected.number)}</span>
                <Badge tone={causeTone(selected.cause)}>{humanize(selected.cause)}</Badge>
                <Badge tone={delayStatusTone(selected.status)}>{humanize(selected.status)}</Badge>
              </div>
              <h2 className="text-base font-semibold text-ink-900">{selected.title}</h2>
            </div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <ErrorAlert message={drawerError} />

          {selected.description ? (
            <p className="mb-4 whitespace-pre-wrap text-sm text-ink-700">{selected.description}</p>
          ) : null}

          <Card className="mb-4">
            <CardBody className="py-3">
              <DetailRow label="Entitlement">
                <EcBadges excusable={selected.excusable} compensable={selected.compensable} />
              </DetailRow>
              <DetailRow label="Start date">{formatDate(selected.startDate)}</DetailRow>
              <DetailRow label="Duration">{selected.durationDays} days</DetailRow>
              <DetailRow label="Struck task">
                {selected.task ? selected.task.name : "— none —"}
              </DetailRow>
              <DetailRow label="Contract event">
                {selected.contractEvent
                  ? `CE-${selected.contractEvent.number} — ${selected.contractEvent.title}`
                  : "— none —"}
              </DetailRow>
            </CardBody>
          </Card>

          {/* TIA */}
          <div className="mb-4 rounded-lg border border-ink-100 p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-semibold text-ink-900">Time Impact Analysis</div>
              <Button
                size="sm"
                onClick={() => void runTia()}
                disabled={tiaBusy || !selected.taskId}
                title={
                  selected.taskId
                    ? "Insert the delay as a fragnet after its struck task and re-run CPM"
                    : "Link a schedule task to run a TIA"
                }
              >
                {tiaBusy ? "Running…" : "Run TIA"}
              </Button>
            </div>
            {!selected.taskId ? (
              <p className="text-xs text-ink-400">
                TIA requires the event to reference a schedule task (the fragnet insertion point).
              </p>
            ) : null}
            {tiaBanner ? (
              <div
                className={`mb-2 rounded-md px-3 py-2 text-sm ring-1 ${
                  tiaBanner.completionDeltaDays > 0
                    ? "bg-red-50 text-red-800 ring-red-200"
                    : "bg-emerald-50 text-emerald-800 ring-emerald-200"
                }`}
              >
                Completion moves{" "}
                <strong>
                  {tiaBanner.completionDeltaDays > 0 ? "+" : ""}
                  {tiaBanner.completionDeltaDays} day
                  {Math.abs(tiaBanner.completionDeltaDays) === 1 ? "" : "s"}
                </strong>{" "}
                — {formatDate(tiaBanner.beforeFinish)} → {formatDate(tiaBanner.afterFinish)}
              </div>
            ) : null}
            {selected.tiaResult ? (
              <div className="text-sm text-ink-700">
                Last result: <TiaChip deltaDays={selected.tiaResult.completionDeltaDays} />{" "}
                <span className="text-xs text-ink-400">
                  {formatDate(selected.tiaResult.beforeFinish)} →{" "}
                  {formatDate(selected.tiaResult.afterFinish)}
                  {selected.tiaResult.computedAt
                    ? ` · computed ${formatDate(selected.tiaResult.computedAt)}`
                    : ""}
                </span>
              </div>
            ) : (
              <p className="text-xs text-ink-400">No TIA computed yet.</p>
            )}
          </div>

          {/* Evidence */}
          <div className="mb-4">
            <SectionTitle>Evidence ({selected.evidence.length})</SectionTitle>
            {selected.evidence.length === 0 ? (
              <p className="text-xs text-ink-400">No evidence linked.</p>
            ) : (
              <ul className="divide-y divide-ink-100 rounded-md border border-ink-100">
                {selected.evidence.map((ev) => (
                  <li key={ev.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <Badge tone="gray">{humanize(ev.kind)}</Badge>
                    <span className="flex-1 truncate text-ink-700">{ev.source}</span>
                    <span className="text-xs text-ink-400">{formatDate(ev.capturedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Status actions */}
          <div className="rounded-lg border border-ink-100 p-4">
            <div className="mb-2 text-sm font-semibold text-ink-900">Status</div>
            <div className="flex flex-wrap gap-2">
              {DELAY_EVENT_STATUSES.filter((s) => s !== selected.status).map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={s === "withdrawn" ? "danger" : "secondary"}
                  disabled={statusBusy}
                  onClick={() => void setStatus(s)}
                >
                  {s === "open" ? "Reopen" : `Mark ${humanize(s).toLowerCase()}`}
                </Button>
              ))}
            </div>
          </div>
        </Drawer>
      ) : null}
    </div>
  );
}
