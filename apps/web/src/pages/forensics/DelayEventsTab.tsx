/**
 * Delay event register (spec Domain D #265-268) with entitlement
 * classification, culpable party, notice time bars, evidence links and
 * per-event Time Impact Analysis (#272).
 *
 * Notice time bars matter more than anything else on this screen: on most
 * standard forms a late notice extinguishes the entitlement the event would
 * otherwise carry, so the register shows the bar's state on every row and the
 * sweep that opens the obligation can be run from here.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { CULPABLE_PARTIES, DELAY_CAUSES } from "@constructos/shared";
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

/**
 * Mirror of the server's DELAY_EVENT_TRANSITIONS. Offering a button the API
 * will refuse is worse than offering none, so the drawer shows only the moves
 * that exist — and asks for the reason the server requires before it sends.
 */
const TRANSITIONS: Record<string, string[]> = {
  open: ["assessed", "withdrawn", "closed"],
  assessed: ["closed", "withdrawn"],
  closed: ["open"],
  withdrawn: ["open"],
};
/** Leaving these states needs a recorded reason, as does withdrawing. */
const REOPEN_FROM = new Set(["closed", "withdrawn"]);

/** Days before the bar at which the platform starts warning (server: NOTICE_WARN_DAYS). */
const NOTICE_WARN_DAYS = 5;

interface WeatherAnalysis {
  id: string;
  reference: string;
  status: string;
  periodStart: string;
  periodEnd: string;
  observedAdverseDays: number | null;
  baselineAdverseDays: number | null;
  exceptionalDays: number | null;
  hoursLost: number | null;
  coveragePercent: number | null;
}

interface WeatherEvidence {
  analyses: WeatherAnalysis[];
  summary: {
    analyses: number;
    exceptionalDays: number | null;
    hoursLost: number | null;
    meanCoveragePercent: number | null;
  };
  reasons: string[];
}

interface NoticeState {
  label: string;
  tone: "red" | "amber" | "green" | "gray";
  title: string;
}

/** Notice time-bar state for a row — the single most consequential column. */
function noticeState(ev: {
  noticeDueDate?: string | null;
  contractEventId: string | null;
  status: string;
}): NoticeState | null {
  if (!ev.noticeDueDate) return null;
  if (ev.contractEventId) {
    return { label: "served", tone: "green", title: `Notice recorded; bar was ${ev.noticeDueDate}` };
  }
  if (ev.status === "withdrawn" || ev.status === "closed") {
    return { label: "n/a", tone: "gray", title: `Event is ${ev.status}` };
  }
  const today = new Date().toISOString().slice(0, 10);
  const days = Math.round(
    (Date.parse(`${ev.noticeDueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
  if (days < 0) {
    return {
      label: `barred ${Math.abs(days)}d`,
      tone: "red",
      title: `The notice was due ${ev.noticeDueDate} and none is recorded — entitlement may be barred`,
    };
  }
  if (days <= NOTICE_WARN_DAYS) {
    return { label: `${days}d left`, tone: "amber", title: `Notice due ${ev.noticeDueDate}` };
  }
  return { label: `${days}d`, tone: "gray", title: `Notice due ${ev.noticeDueDate}` };
}

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
  noticeDueDate: string;
  party: string;
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
  noticeDueDate: "",
  party: "neither",
  evidenceIds: [],
};

export default function DelayEventsTab({
  projectId,
  focusId,
}: {
  projectId: string;
  /** deep link from ⌘K search: open this event's drawer once, on arrival */
  focusId?: string | null;
}) {
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

  /* --------------------------- notice time bars --------------------------- */

  const [sweepBusy, setSweepBusy] = useState(false);
  const [sweepNote, setSweepNote] = useState<string | null>(null);

  async function runNoticeSweep() {
    setSweepBusy(true);
    setSweepNote(null);
    setError(null);
    try {
      const res = await api.post<{
        scanned: number;
        obligationsOpened: number;
        obligationsClosed: number;
        dueSoon: number;
        missed: number;
        alerted: number;
        warnDays: number;
      }>(`${base}/forensics/notice-sweep`, {});
      setSweepNote(
        `${res.scanned} event(s) with a notice date checked — ${res.obligationsOpened} obligation(s) opened, ` +
          `${res.obligationsClosed} closed, ${res.missed} past the bar, ${res.dueSoon} due within ${res.warnDays} days, ` +
          `${res.alerted} new alert(s).`,
      );
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "The notice sweep could not be run.");
    } finally {
      setSweepBusy(false);
    }
  }

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
      if (form.noticeDueDate) payload["noticeDueDate"] = form.noticeDueDate;
      if (form.party) payload["party"] = form.party;
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

  const [weather, setWeather] = useState<WeatherEvidence | null>(null);

  async function openDrawer(id: string) {
    setDrawerError(null);
    setTiaBanner(null);
    setWeather(null);
    try {
      const detail = await api.get<DelayEventDetail>(`${base}/delay-events/${id}`);
      setSelected(detail);
      // The weather comparison lives in the site module; forensics reads it so
      // the claim and the met record can never disagree. Its own failure must
      // not blank the drawer.
      api
        .get<WeatherEvidence>(`${base}/delay-events/${id}/weather`)
        .then((res) => setWeather(res))
        .catch(() => setWeather(null));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the delay event");
    }
  }

  /*
   * Arriving from company search (or any link that names an event) opens that
   * event rather than dropping the reader on an unfiltered register. It fires
   * once per id: reopening after the user closes the drawer would trap them.
   */
  const openedFocus = useRef<string | null>(null);
  useEffect(() => {
    if (!focusId || openedFocus.current === focusId) return;
    openedFocus.current = focusId;
    void openDrawer(focusId);
    // openDrawer is stable for a given base; the id is what drives this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, base]);

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

  const [statusReason, setStatusReason] = useState("");

  function reasonRequired(from: string, to: string): boolean {
    return to === "withdrawn" || REOPEN_FROM.has(from);
  }

  async function setStatus(status: string) {
    if (!selected) return;
    setDrawerError(null);
    if (reasonRequired(selected.status, status) && statusReason.trim().length === 0) {
      setDrawerError(
        status === "withdrawn"
          ? "A reason is required to withdraw a delay event — it disappears from every downstream aggregation."
          : `A reason is required to reopen a ${selected.status} delay event.`,
      );
      return;
    }
    setStatusBusy(true);
    try {
      await api.post(`${base}/delay-events/${selected.id}/status`, {
        status,
        ...(statusReason.trim() ? { reason: statusReason.trim() } : {}),
      });
      setStatusReason("");
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
        <div className="flex gap-2">
          <Button variant="secondary" disabled={sweepBusy} onClick={() => void runNoticeSweep()}>
            {sweepBusy ? "Checking…" : "Check notice time bars"}
          </Button>
          <Button onClick={() => void openCreate()}>Register delay event</Button>
        </div>
      </div>

      <ErrorAlert message={error} />
      {sweepNote ? (
        <Alert tone="info" title="Notice time bars" className="mb-4">
          {sweepNote}
        </Alert>
      ) : null}

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
                <Th>Notice</Th>
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
                    {(() => {
                      const n = noticeState(ev);
                      return n ? (
                        <Badge tone={n.tone} title={n.title}>
                          {n.label}
                        </Badge>
                      ) : (
                        <span className="text-xs text-ink-300" title="No notice time bar recorded">
                          —
                        </span>
                      );
                    })()}
                  </Td>
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
            <Field
              label="Culpable party"
              hint="Whose delay this is — the concurrency engine cannot classify without it."
            >
              <Select value={form.party} onChange={(e) => set("party", e.target.value)}>
                {CULPABLE_PARTIES.map((party) => (
                  <option key={party} value={party}>
                    {humanize(party)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Notice due by"
              hint="The contract time bar. A missed bar can extinguish the entitlement."
            >
              <Input
                type="date"
                value={form.noticeDueDate}
                onChange={(e) => set("noticeDueDate", e.target.value)}
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
              <DetailRow label="Culpable party">
                {selected.party ? humanize(selected.party) : "— not classified —"}
              </DetailRow>
              <DetailRow label="Contract event">
                {selected.contractEvent
                  ? `CE-${selected.contractEvent.number} — ${selected.contractEvent.title}`
                  : "— none —"}
              </DetailRow>
              <DetailRow label="Notice due by">
                {selected.noticeDueDate ? (
                  <span className="flex items-center gap-2">
                    {formatDate(selected.noticeDueDate)}
                    {(() => {
                      const n = noticeState(selected);
                      return n ? <Badge tone={n.tone}>{n.label}</Badge> : null;
                    })()}
                  </span>
                ) : (
                  "— no time bar recorded —"
                )}
              </DetailRow>
            </CardBody>
          </Card>

          {selected.noticeDueDate && !selected.contractEventId ? (
            <Alert
              tone={noticeState(selected)?.tone === "red" ? "danger" : "warning"}
              title={
                noticeState(selected)?.tone === "red"
                  ? "The notice time bar has passed"
                  : "A notice is outstanding"
              }
              className="mb-4"
            >
              No contract event is linked to this delay event. Serve the notice and record it above —
              the platform holds this deadline as an obligation and escalates it, but it cannot serve
              a notice for you.
            </Alert>
          ) : null}

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

          {/* Weather baseline (site module) */}
          {weather && (weather.analyses.length > 0 || selected.cause === "exceptional_weather") ? (
            <div className="mb-4">
              <SectionTitle>Weather against the contract baseline</SectionTitle>
              {weather.analyses.length === 0 ? (
                <p className="text-xs text-ink-400">
                  {weather.reasons[0] ??
                    "No weather analysis has been issued against this event."}{" "}
                  Issue one from Site operations → Weather to evidence the excusable period.
                </p>
              ) : (
                <>
                  <div className="mb-2 flex flex-wrap gap-4 text-sm">
                    <span>
                      <span className="text-ink-500">Exceptional days </span>
                      <strong className="tabular-nums">
                        {weather.summary.exceptionalDays ?? "—"}
                      </strong>
                    </span>
                    <span>
                      <span className="text-ink-500">Hours lost </span>
                      <strong className="tabular-nums">{weather.summary.hoursLost ?? "—"}</strong>
                    </span>
                    <span>
                      <span className="text-ink-500">Record coverage </span>
                      <strong className="tabular-nums">
                        {weather.summary.meanCoveragePercent === null
                          ? "—"
                          : `${weather.summary.meanCoveragePercent}%`}
                      </strong>
                    </span>
                  </div>
                  <ul className="divide-y divide-ink-100 rounded-md border border-ink-100">
                    {weather.analyses.map((a) => (
                      <li key={a.id} className="px-3 py-2 text-sm">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs text-ink-500">{a.reference}</span>
                          <Badge tone={a.status === "issued" ? "green" : "gray"}>
                            {humanize(a.status)}
                          </Badge>
                          <span className="text-xs text-ink-400">
                            {formatDate(a.periodStart)} – {formatDate(a.periodEnd)}
                          </span>
                        </div>
                        <div className="mt-0.5 text-xs text-ink-600">
                          {a.observedAdverseDays ?? "—"} adverse days observed against{" "}
                          {a.baselineAdverseDays ?? "—"} in the baseline —{" "}
                          <strong>{a.exceptionalDays ?? "—"}</strong> exceptional.
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          ) : null}

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

          {/* Status actions — only the transitions the server allows */}
          <div className="rounded-lg border border-ink-100 p-4">
            <div className="mb-2 text-sm font-semibold text-ink-900">Status</div>
            {selected.statusReason ? (
              <p className="mb-2 text-xs text-ink-500">
                Last change: {selected.statusReason}
              </p>
            ) : null}
            {(TRANSITIONS[selected.status] ?? []).length === 0 ? (
              <p className="text-xs text-ink-400">
                {humanize(selected.status)} is a terminal state for this event.
              </p>
            ) : (
              <>
                <Field
                  label="Reason"
                  hint={
                    REOPEN_FROM.has(selected.status)
                      ? "Required to reopen — the event returns to every downstream aggregation."
                      : "Required to withdraw."
                  }
                >
                  <Input
                    value={statusReason}
                    onChange={(e) => setStatusReason(e.target.value)}
                    placeholder="Raised in error; superseded by DE-014…"
                  />
                </Field>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(TRANSITIONS[selected.status] ?? []).map((next) => (
                    <Button
                      key={next}
                      size="sm"
                      variant={next === "withdrawn" ? "danger" : "secondary"}
                      disabled={statusBusy}
                      onClick={() => void setStatus(next)}
                    >
                      {next === "open" ? "Reopen" : `Mark ${humanize(next).toLowerCase()}`}
                    </Button>
                  ))}
                </div>
              </>
            )}
          </div>
        </Drawer>
      ) : null}
    </div>
  );
}
