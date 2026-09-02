/**
 * Permits, consents and clearances — spec Vol II Domain K / M19 (#585-591,
 * #608).
 *
 * A permit register is only worth keeping if it says two things the authority
 * will not: when the statutory determination period runs out, and what work
 * cannot lawfully start until the consent is in hand. Both are on the face of
 * this tab — the determination countdown in the register, and the
 * consent-to-programme banner above it, which is red precisely when a permit
 * that is not granted blocks a task inside the 90-day horizon.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { PERMIT_KINDS, PERMIT_STATUSES } from "@constructos/shared";
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
  Th,
  Textarea,
} from "../../ui";
import { formatDate, formatDateTime } from "../format";
import {
  Countdown,
  DetailRow,
  Drawer,
  PERMIT_KIND_LABELS,
  PERMIT_STATUS_LABELS,
  StatCard,
  addDaysISO,
  countdownLabel,
  errorMessage,
  permitStatusTone,
  todayISO,
  type ListResponse,
  type PermitDetail,
  type PermitRow,
  type ScheduleDetail,
  type SchedulePickRow,
  type ScheduleRiskResponse,
  type ScheduleTaskRow,
} from "./jurisdictionShared";

/** The horizon the consent-to-programme view is read over (#591). */
const RISK_DAYS = 90;
/** An expiry inside this window is amber: renewal lead times are not short. */
const EXPIRY_WARN_DAYS = 30;
/** Schedules read for the blocking-task picker — bounded on purpose. */
const MAX_SCHEDULES_SCANNED = 10;

interface ConditionDraft {
  text: string;
  dueDate: string;
}

const emptyCondition = (): ConditionDraft => ({ text: "", dueDate: "" });

interface TaskOption extends ScheduleTaskRow {
  scheduleName: string;
}

/* ============================ Schedule-risk banner ======================== */

function ScheduleRiskBanner({ risk }: { risk: ScheduleRiskResponse }) {
  const blocked = risk.items.filter((i) => i.blocked);
  if (blocked.length === 0) {
    return (
      <div className="mb-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-200">
        No ungranted permit blocks work starting in the next {risk.days} days.
        {risk.total > 0 ? (
          <span className="ml-1 text-xs text-emerald-700">
            {risk.total} consent-to-programme link{risk.total === 1 ? "" : "s"} in the horizon, all
            granted.
          </span>
        ) : null}
      </div>
    );
  }
  const soonest = blocked[0];
  return (
    <div className="mb-4 rounded-md bg-red-50 px-4 py-3 text-sm text-red-800 ring-1 ring-red-200">
      <p className="font-semibold">
        {risk.summary.blockingPermits} permit
        {risk.summary.blockingPermits === 1 ? "" : "s"} block{" "}
        {risk.summary.blockedTasks} task{risk.summary.blockedTasks === 1 ? "" : "s"} starting within{" "}
        {risk.days} days
      </p>
      <p className="mt-1 text-xs leading-relaxed">
        A consent-to-programme dependency with no grant on file is a delay already in motion: either
        the start moves or the work proceeds unlawfully.
        {risk.summary.criticalBlocked > 0 ? (
          <>
            {" "}
            <span className="font-semibold">
              {risk.summary.criticalBlocked} of the blocked links are on the critical path.
            </span>
          </>
        ) : null}
      </p>
      <ul className="mt-2 space-y-1 text-xs">
        {blocked.slice(0, 6).map((i) => (
          <li key={`${i.permitId}-${i.taskId}`} className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">#{i.permitNumber}</span>
            <span>{i.permitTitle}</span>
            <span className="text-red-600" aria-hidden>
              →
            </span>
            <span>
              {i.wbsCode ? `${i.wbsCode} ` : ""}
              {i.taskName}
            </span>
            <span className="tabular-nums font-medium">
              starts {countdownLabel(i.daysUntilStart)}
            </span>
            {i.isCritical ? (
              <span className="rounded bg-red-100 px-1 text-[10px] font-semibold uppercase">
                critical
              </span>
            ) : null}
            <span className="text-red-600/80">
              ({PERMIT_STATUS_LABELS[i.status] ?? i.status})
            </span>
          </li>
        ))}
      </ul>
      {blocked.length > 6 ? (
        <p className="mt-1 text-xs text-red-700">…and {blocked.length - 6} more.</p>
      ) : null}
      {soonest ? (
        <p className="mt-2 text-xs">
          Earliest blocked start:{" "}
          <span className="font-semibold tabular-nums">{formatDate(soonest.startDate)}</span>.
        </p>
      ) : null}
    </div>
  );
}

/* ================================== Tab =================================== */

export default function PermitsTab({ projectId }: { projectId: string }) {
  const base = `/api/v1/projects/${projectId}`;

  const [permits, setPermits] = useState<PermitRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [risk, setRisk] = useState<ScheduleRiskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [fKind, setFKind] = useState("");
  const [fStatus, setFStatus] = useState("");
  const [fOverdue, setFOverdue] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const params = new URLSearchParams({ pageSize: "200" });
    if (fKind) params.set("kind", fKind);
    if (fStatus) params.set("status", fStatus);
    if (fOverdue) params.set("overdue", "true");
    try {
      const [list, riskRes] = await Promise.all([
        api.get<ListResponse<PermitRow>>(`${base}/permits?${params.toString()}`),
        api.get<ScheduleRiskResponse>(`${base}/permits/schedule-risk?days=${RISK_DAYS}`),
      ]);
      setPermits(list.items);
      setTotal(list.total);
      setRisk(riskRes);
    } catch (err) {
      setPermits((prev) => prev ?? []);
      setError(errorMessage(err, "Failed to load the permit register"));
    }
  }, [base, fKind, fStatus, fOverdue]);

  useEffect(() => {
    void load();
  }, [load]);

  /* --------------------- blocking-task picker (lazy) ---------------------- */

  const [tasks, setTasks] = useState<TaskOption[] | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);

  const loadTasks = useCallback(async () => {
    if (tasks !== null) return;
    setTaskError(null);
    try {
      const list = await api.get<ListResponse<SchedulePickRow>>(`${base}/schedules?pageSize=200`);
      const scanned = list.items.slice(0, MAX_SCHEDULES_SCANNED);
      const details = await Promise.all(
        scanned.map((s) => api.get<ScheduleDetail>(`${base}/schedules/${s.id}`)),
      );
      const flat: TaskOption[] = [];
      for (const detail of details) {
        for (const t of detail.tasks ?? []) flat.push({ ...t, scheduleName: detail.name });
      }
      setTasks(flat);
    } catch (err) {
      setTasks([]);
      setTaskError(errorMessage(err, "Failed to load the project's schedule tasks"));
    }
  }, [base, tasks]);

  /* ------------------------------ create modal ---------------------------- */

  const [open, setOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [cKind, setCKind] = useState<string>("work_permit");
  const [cTitle, setCTitle] = useState("");
  const [cAuthority, setCAuthority] = useState("");
  const [cJurisdiction, setCJurisdiction] = useState("");
  const [cReference, setCReference] = useState("");
  const [cAppliedAt, setCAppliedAt] = useState("");
  const [cExpectedDays, setCExpectedDays] = useState("");
  const [cBlocking, setCBlocking] = useState<string[]>([]);
  const [cTaskFilter, setCTaskFilter] = useState("");
  const [cConditions, setCConditions] = useState<ConditionDraft[]>([]);

  const duePreview = useMemo(() => {
    const days = Number(cExpectedDays);
    if (!cAppliedAt || !Number.isFinite(days) || days <= 0) return null;
    return addDaysISO(cAppliedAt, Math.trunc(days));
  }, [cAppliedAt, cExpectedDays]);

  function openCreate() {
    setFormError(null);
    setCKind("work_permit");
    setCTitle("");
    setCAuthority("");
    setCJurisdiction("");
    setCReference("");
    setCAppliedAt("");
    setCExpectedDays("");
    setCBlocking([]);
    setCTaskFilter("");
    setCConditions([]);
    setOpen(true);
    void loadTasks();
  }

  const visibleTasks = useMemo(() => {
    const all = tasks ?? [];
    const q = cTaskFilter.trim().toLowerCase();
    const matched = q
      ? all.filter(
          (t) =>
            t.name.toLowerCase().includes(q) ||
            (t.wbsCode ?? "").toLowerCase().includes(q) ||
            t.scheduleName.toLowerCase().includes(q),
        )
      : all;
    return matched.slice(0, 200);
  }, [tasks, cTaskFilter]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        kind: cKind,
        title: cTitle.trim(),
        authority: cAuthority.trim(),
      };
      if (cJurisdiction.trim()) payload["jurisdiction"] = cJurisdiction.trim();
      if (cReference.trim()) payload["reference"] = cReference.trim();
      if (cAppliedAt) payload["appliedAt"] = cAppliedAt;
      if (cExpectedDays) payload["expectedDays"] = Number(cExpectedDays);
      if (cBlocking.length > 0) payload["blockingTaskIds"] = cBlocking;
      const conditions = cConditions
        .filter((c) => c.text.trim() !== "")
        .map((c) => ({ text: c.text.trim(), ...(c.dueDate ? { dueDate: c.dueDate } : {}) }));
      if (conditions.length > 0) payload["conditions"] = conditions;
      await api.post<PermitRow>(`${base}/permits`, payload);
      setOpen(false);
      await load();
    } catch (err) {
      setFormError(errorMessage(err, "Failed to create the permit."));
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------------- drawer -------------------------------- */

  const [detail, setDetail] = useState<PermitDetail | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);

  const openDetail = useCallback(
    async (permitId: string) => {
      setDetailId(permitId);
      setDetail(null);
      setDetailError(null);
      try {
        setDetail(await api.get<PermitDetail>(`${base}/permits/${permitId}`));
      } catch (err) {
        setDetailError(errorMessage(err, "Failed to load the permit"));
      }
    },
    [base],
  );

  async function setStatus(status: string, extra?: Record<string, unknown>) {
    if (!detailId) return;
    setDetailError(null);
    setDetailBusy(true);
    try {
      const updated = await api.post<PermitDetail>(`${base}/permits/${detailId}/status`, {
        status,
        ...(extra ?? {}),
      });
      setDetail((prev) => (prev ? { ...prev, ...updated } : prev));
      await load();
      await openDetail(detailId);
    } catch (err) {
      setDetailError(errorMessage(err, "Failed to change the permit status"));
    } finally {
      setDetailBusy(false);
    }
  }

  /* grant modal */
  const [grantOpen, setGrantOpen] = useState(false);
  const [gGranted, setGGranted] = useState(todayISO);
  const [gExpires, setGExpires] = useState("");
  const [gReference, setGReference] = useState("");

  function openGrant() {
    setGGranted(todayISO());
    setGExpires(detail?.expiresAt ?? "");
    setGReference(detail?.reference ?? "");
    setGrantOpen(true);
  }

  async function onGrant(e: FormEvent) {
    e.preventDefault();
    const extra: Record<string, unknown> = { grantedAt: gGranted };
    extra["expiresAt"] = gExpires || null;
    extra["reference"] = gReference.trim() || null;
    await setStatus("granted", extra);
    setGrantOpen(false);
  }

  /* condition discharge */
  const [closingId, setClosingId] = useState<string | null>(null);
  const [closeNote, setCloseNote] = useState("");

  async function onCloseCondition(conditionId: string) {
    if (!detailId) return;
    setDetailError(null);
    setDetailBusy(true);
    try {
      await api.post(`${base}/permits/${detailId}/conditions/${conditionId}/close`, {
        note: closeNote.trim() || null,
      });
      setClosingId(null);
      setCloseNote("");
      await openDetail(detailId);
      await load();
    } catch (err) {
      setDetailError(errorMessage(err, "Failed to discharge the condition"));
    } finally {
      setDetailBusy(false);
    }
  }

  /* -------------------------------- render -------------------------------- */

  const items = permits ?? [];
  const openConditions = items.reduce((s, p) => s + p.openConditions, 0);
  const awaiting = items.filter((p) => p.status === "applied" || p.status === "in_review").length;
  const overdueCount = items.filter((p) => p.overdue).length;
  const expiringSoon = items.filter(
    (p) => p.status === "granted" && p.daysToExpiry !== null && p.daysToExpiry <= EXPIRY_WARN_DAYS,
  ).length;

  if (permits === null && !error) return <Spinner label="Loading permits…" />;

  return (
    <div>
      <ErrorAlert message={error} />

      {risk ? <ScheduleRiskBanner risk={risk} /> : null}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Awaiting determination"
          value={awaiting}
          hint="applied or in review"
          title="Permits submitted to an authority with no determination recorded yet. The statutory clock is running on each of them."
        />
        <StatCard
          label="Determination overdue"
          value={overdueCount}
          tone={overdueCount > 0 ? "red" : undefined}
          hint="past the statutory period"
          title="The authority is late. Authority delay beyond the statutory period is normally an employer-risk event — the entitlement argument later rests on the chase correspondence recorded now."
        />
        <StatCard
          label="Expiring soon"
          value={expiringSoon}
          tone={expiringSoon > 0 ? "amber" : undefined}
          hint={`granted, inside ${EXPIRY_WARN_DAYS} days`}
          title="Renewal lead times are rarely shorter than the notice you get. Work relying on a lapsed consent is an enforcement exposure."
        />
        <StatCard
          label="Open conditions"
          value={openConditions}
          tone={openConditions > 0 ? "amber" : undefined}
          hint="attached to grants"
          title="Conditions attached to a grant are obligations in their own right. A consent with undischarged conditions is not a clean consent."
        />
      </div>

      <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink-900">
          Permit register{" "}
          <span className="font-normal text-ink-400">
            — {total} permit{total === 1 ? "" : "s"}
          </span>
        </h3>
        <div className="flex flex-wrap items-end gap-2">
          <Select
            value={fKind}
            onChange={(e) => setFKind(e.target.value)}
            aria-label="Filter by kind"
            className="w-44"
          >
            <option value="">All kinds</option>
            {PERMIT_KINDS.map((k) => (
              <option key={k} value={k}>
                {PERMIT_KIND_LABELS[k] ?? k}
              </option>
            ))}
          </Select>
          <Select
            value={fStatus}
            onChange={(e) => setFStatus(e.target.value)}
            aria-label="Filter by status"
            className="w-40"
          >
            <option value="">All statuses</option>
            {PERMIT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {PERMIT_STATUS_LABELS[s] ?? s}
              </option>
            ))}
          </Select>
          <label className="flex items-center gap-1.5 pb-2 text-xs text-ink-600">
            <input
              type="checkbox"
              checked={fOverdue}
              onChange={(e) => setFOverdue(e.target.checked)}
              className="rounded border-ink-300"
            />
            Overdue only
          </label>
          <Button size="sm" onClick={openCreate}>
            New permit
          </Button>
        </div>
      </div>

      {items.length === 0 ? (
        <EmptyState
          title="No permits recorded"
          hint="A permit that blocks a schedule task is a programme risk with a name and an authority attached. Record the application date and the statutory period, and the determination clock keeps itself."
          action={<Button onClick={openCreate}>Record the first permit</Button>}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>No.</Th>
              <Th>Kind</Th>
              <Th>Title</Th>
              <Th>Authority</Th>
              <Th>Status</Th>
              <Th>Determination due</Th>
              <Th>Expires</Th>
              <Th className="text-right">Blocks</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {items.map((p) => (
              <tr
                key={p.id}
                className="cursor-pointer hover:bg-ink-50/60"
                onClick={() => void openDetail(p.id)}
              >
                <Td className="whitespace-nowrap font-medium tabular-nums text-ink-900">
                  #{p.number}
                </Td>
                <Td>
                  <Badge tone="gray">{PERMIT_KIND_LABELS[p.kind] ?? p.kind}</Badge>
                </Td>
                <Td className="max-w-xs">
                  <div className="truncate text-ink-900" title={p.title}>
                    {p.title}
                  </div>
                  {p.openConditions > 0 ? (
                    <div className="text-[11px] text-amber-700">
                      {p.openConditions} open condition{p.openConditions === 1 ? "" : "s"}
                    </div>
                  ) : null}
                </Td>
                <Td className="max-w-[12rem] truncate text-xs text-ink-600" title={p.authority}>
                  {p.authority}
                </Td>
                <Td>
                  <Badge tone={permitStatusTone(p.status)}>
                    {PERMIT_STATUS_LABELS[p.status] ?? p.status}
                  </Badge>
                </Td>
                <Td className="text-xs">
                  {p.dueAt ? (
                    <div>
                      <div className="tabular-nums text-ink-600">{formatDate(p.dueAt)}</div>
                      <Countdown
                        days={p.daysToDue}
                        warnWithin={14}
                        overdueLabel="overdue"
                        title={
                          p.overdue
                            ? "The statutory determination period has expired with no determination recorded."
                            : "Days until the statutory determination period expires."
                        }
                      />
                    </div>
                  ) : (
                    <span
                      className="text-ink-300"
                      title="No application date or no statutory period recorded, so no clock is running."
                    >
                      —
                    </span>
                  )}
                </Td>
                <Td className="text-xs">
                  {p.expiresAt ? (
                    <div>
                      <div className="tabular-nums text-ink-600">{formatDate(p.expiresAt)}</div>
                      <Countdown
                        days={p.daysToExpiry}
                        warnWithin={EXPIRY_WARN_DAYS}
                        overdueLabel="expired"
                        title="Days until the consent lapses. Renewal lead times are rarely shorter than this."
                      />
                    </div>
                  ) : (
                    <span className="text-ink-300">—</span>
                  )}
                </Td>
                <Td className="text-right tabular-nums text-ink-700">
                  {p.blockingTaskCount > 0 ? (
                    <span
                      className={p.status !== "granted" ? "font-medium text-red-700" : undefined}
                      title={
                        p.status !== "granted"
                          ? `${p.blockingTaskCount} schedule task(s) cannot lawfully start until this permit is granted.`
                          : `${p.blockingTaskCount} schedule task(s) depended on this consent.`
                      }
                    >
                      {p.blockingTaskCount}
                    </span>
                  ) : (
                    <span className="text-ink-300">—</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {/* ------------------------------ create modal -------------------------- */}
      <Modal open={open} title="New permit" onClose={() => setOpen(false)} wide>
        <ErrorAlert message={formError} />
        <form onSubmit={onCreate} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Kind">
              <Select value={cKind} onChange={(e) => setCKind(e.target.value)}>
                {PERMIT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {PERMIT_KIND_LABELS[k] ?? k}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Authority" hint="The body that determines the application.">
              <Input
                required
                value={cAuthority}
                onChange={(e) => setCAuthority(e.target.value)}
                placeholder="e.g. City of Westminster — Highways"
              />
            </Field>
          </div>

          <Field label="Title">
            <Input
              required
              value={cTitle}
              onChange={(e) => setCTitle(e.target.value)}
              placeholder="What is being consented"
            />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Jurisdiction">
              <Input
                value={cJurisdiction}
                onChange={(e) => setCJurisdiction(e.target.value)}
                placeholder="Country / state / municipality"
              />
            </Field>
            <Field label="Reference">
              <Input
                value={cReference}
                onChange={(e) => setCReference(e.target.value)}
                placeholder="Authority's application reference"
                className="font-mono"
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Applied on"
              hint="The determination clock only starts once an application is in."
            >
              <Input
                type="date"
                value={cAppliedAt}
                onChange={(e) => setCAppliedAt(e.target.value)}
              />
            </Field>
            <Field label="Statutory period (days)">
              <Input
                type="number"
                min="1"
                max="3650"
                step="1"
                value={cExpectedDays}
                onChange={(e) => setCExpectedDays(e.target.value)}
                placeholder="e.g. 56"
              />
            </Field>
          </div>

          <div
            className={`rounded-md px-3 py-2 text-sm ring-1 ${
              duePreview
                ? "bg-brand-50 text-brand-900 ring-brand-100"
                : "bg-ink-50 text-ink-500 ring-ink-100"
            }`}
          >
            {duePreview ? (
              <>
                Determination due{" "}
                <span className="font-semibold tabular-nums">{formatDate(duePreview)}</span>
                <span className="ml-1 text-xs">
                  ({countdownLabel(
                    Math.round(
                      (Date.parse(`${duePreview}T00:00:00Z`) -
                        Date.parse(`${todayISO()}T00:00:00Z`)) /
                        86_400_000,
                    ),
                  )}
                  )
                </span>
                <p className="mt-1 text-xs leading-relaxed">
                  An obligation is raised on this date. If it passes with no determination, the
                  obligation is breached and a signal is raised — the authority's delay becomes a
                  recorded claim event rather than a chase-up email.
                </p>
              </>
            ) : (
              "Enter both an application date and a statutory period to start the determination clock."
            )}
          </div>

          {/* --------------------------- blocking tasks ------------------------ */}
          <div>
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium text-ink-600">
                Blocked schedule tasks{" "}
                {cBlocking.length > 0 ? (
                  <span className="text-brand-700">({cBlocking.length} selected)</span>
                ) : null}
              </span>
              <Input
                value={cTaskFilter}
                onChange={(e) => setCTaskFilter(e.target.value)}
                placeholder="Filter tasks…"
                aria-label="Filter schedule tasks"
                className="w-48"
              />
            </div>
            <ErrorAlert message={taskError} />
            <div className="max-h-56 overflow-y-auto rounded-md ring-1 ring-ink-200">
              {tasks === null ? (
                <Spinner label="Loading schedule tasks…" />
              ) : visibleTasks.length === 0 ? (
                <p className="px-3 py-4 text-xs text-ink-400">
                  {(tasks ?? []).length === 0
                    ? "No schedule tasks on this project yet. A permit can still be recorded; link it to tasks once a programme exists."
                    : "No task matches that filter."}
                </p>
              ) : (
                <ul className="divide-y divide-ink-100">
                  {visibleTasks.map((t) => {
                    const checked = cBlocking.includes(t.id);
                    return (
                      <li key={t.id}>
                        <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs hover:bg-ink-50">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) =>
                              setCBlocking((prev) =>
                                e.target.checked
                                  ? [...prev, t.id]
                                  : prev.filter((id) => id !== t.id),
                              )
                            }
                            className="rounded border-ink-300"
                          />
                          <span className="min-w-0 flex-1 truncate text-ink-800">
                            {t.wbsCode ? (
                              <span className="mr-1.5 font-mono text-ink-400">{t.wbsCode}</span>
                            ) : null}
                            {t.name}
                          </span>
                          {t.isCritical === 1 ? (
                            <span className="rounded bg-red-100 px-1 text-[10px] font-semibold uppercase text-red-700">
                              critical
                            </span>
                          ) : null}
                          <span className="shrink-0 tabular-nums text-ink-400">
                            {t.startDate ?? t.constraintDate ?? "unscheduled"}
                          </span>
                          <span className="shrink-0 truncate text-ink-300">{t.scheduleName}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <p className="mt-1 text-[11px] text-ink-400">
              Linking tasks is what turns a permit into a programme risk: an ungranted permit whose
              blocked work starts inside 30 days raises a signal on its own.
            </p>
          </div>

          {/* ----------------------------- conditions -------------------------- */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-medium text-ink-600">Conditions</span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setCConditions((prev) => [...prev, emptyCondition()])}
              >
                Add condition
              </Button>
            </div>
            {cConditions.length === 0 ? (
              <p className="text-[11px] text-ink-400">
                Conditions attached to a grant are obligations in their own right. Add them here or
                after the determination arrives.
              </p>
            ) : (
              <div className="space-y-2">
                {cConditions.map((c, i) => (
                  <div key={i} className="flex items-end gap-2">
                    <div className="flex-1">
                      <Field label={i === 0 ? "Condition" : ""}>
                        <Input
                          value={c.text}
                          onChange={(e) =>
                            setCConditions((prev) =>
                              prev.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)),
                            )
                          }
                          placeholder="What the authority requires"
                        />
                      </Field>
                    </div>
                    <div className="w-44">
                      <Field label={i === 0 ? "Due" : ""}>
                        <Input
                          type="date"
                          value={c.dueDate}
                          onChange={(e) =>
                            setCConditions((prev) =>
                              prev.map((x, j) => (j === i ? { ...x, dueDate: e.target.value } : x)),
                            )
                          }
                        />
                      </Field>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="mb-0.5"
                      aria-label="Remove condition"
                      onClick={() => setCConditions((prev) => prev.filter((_, j) => j !== i))}
                    >
                      ✕
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Create permit"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* --------------------------------- drawer ----------------------------- */}
      <Drawer
        open={detailId !== null}
        wide
        onClose={() => {
          setDetailId(null);
          setDetail(null);
          setClosingId(null);
        }}
        title={
          detail ? (
            <span className="flex flex-wrap items-center gap-2">
              <span className="tabular-nums">#{detail.number}</span>
              <span>{detail.title}</span>
              <Badge tone={permitStatusTone(detail.status)}>
                {PERMIT_STATUS_LABELS[detail.status] ?? detail.status}
              </Badge>
            </span>
          ) : (
            "Permit"
          )
        }
      >
        <ErrorAlert message={detailError} />
        {detail === null && !detailError ? (
          <Spinner label="Loading permit…" />
        ) : detail ? (
          <div>
            {/* status actions */}
            <div className="mb-4 rounded-md bg-ink-50 p-3">
              <p className="mb-2 text-xs font-medium text-ink-600">Record a determination</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={detailBusy} onClick={openGrant}>
                  Grant…
                </Button>
                {PERMIT_STATUSES.filter((s) => s !== "granted").map((s) => (
                  <Button
                    key={s}
                    size="sm"
                    variant="secondary"
                    disabled={detailBusy || detail.status === s}
                    onClick={() => void setStatus(s)}
                  >
                    {PERMIT_STATUS_LABELS[s] ?? s}
                  </Button>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-ink-400">
                A refusal is a determination too — it discharges the determination obligation, and
                the programme consequence surfaces in the consent-to-programme view rather than
                being buried in the status.
              </p>
            </div>

            <div className="border-t border-ink-100 pt-2">
              <DetailRow label="Kind">
                {PERMIT_KIND_LABELS[detail.kind] ?? detail.kind}
              </DetailRow>
              <DetailRow label="Authority">{detail.authority}</DetailRow>
              <DetailRow label="Jurisdiction">{detail.jurisdiction ?? "—"}</DetailRow>
              <DetailRow label="Reference">
                <span className="font-mono text-xs">{detail.reference ?? "—"}</span>
              </DetailRow>
              <DetailRow label="Applied">
                <span className="tabular-nums">{formatDate(detail.appliedAt)}</span>
                {detail.expectedDays ? (
                  <span className="ml-2 text-xs text-ink-400">
                    {detail.expectedDays}-day statutory period
                  </span>
                ) : null}
              </DetailRow>
              <DetailRow label="Determination due">
                {detail.dueAt ? (
                  <span className="flex flex-wrap items-baseline gap-2">
                    <span className="tabular-nums">{formatDate(detail.dueAt)}</span>
                    <Countdown days={detail.daysToDue} warnWithin={14} />
                  </span>
                ) : (
                  "—"
                )}
              </DetailRow>
              <DetailRow label="Granted">
                <span className="tabular-nums">{formatDate(detail.grantedAt)}</span>
              </DetailRow>
              <DetailRow label="Expires">
                {detail.expiresAt ? (
                  <span className="flex flex-wrap items-baseline gap-2">
                    <span className="tabular-nums">{formatDate(detail.expiresAt)}</span>
                    <Countdown
                      days={detail.daysToExpiry}
                      warnWithin={EXPIRY_WARN_DAYS}
                      overdueLabel="expired"
                    />
                  </span>
                ) : (
                  "—"
                )}
              </DetailRow>
            </div>

            {detail.obligation ? (
              <Card className="mt-4">
                <CardBody className="py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium uppercase tracking-wide text-ink-400">
                      Determination obligation
                    </span>
                    <Badge
                      tone={
                        detail.obligation.status === "breached"
                          ? "red"
                          : detail.obligation.status === "satisfied"
                            ? "green"
                            : "blue"
                      }
                    >
                      {detail.obligation.status}
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm text-ink-800">{detail.obligation.sourceClause}</p>
                  <p className="mt-0.5 text-xs text-ink-500">
                    Deadline{" "}
                    <span className="tabular-nums">
                      {formatDateTime(detail.obligation.deadline)}
                    </span>
                  </p>
                  {detail.obligation.evidenceRequirement ? (
                    <p className="mt-1 text-xs text-ink-500">
                      Evidence: {detail.obligation.evidenceRequirement}
                    </p>
                  ) : null}
                </CardBody>
              </Card>
            ) : null}

            {/* conditions checklist */}
            <div className="mt-5">
              <h3 className="mb-2 text-sm font-semibold text-ink-900">
                Conditions{" "}
                <span className="font-normal text-ink-400">
                  — {detail.openConditions} open of {detail.conditions.length}
                </span>
              </h3>
              {detail.conditions.length === 0 ? (
                <p className="text-xs text-ink-400">No conditions attached to this permit.</p>
              ) : (
                <ul className="space-y-2">
                  {detail.conditions.map((c) => (
                    <li
                      key={c.id}
                      className={`rounded-md px-3 py-2 ring-1 ${
                        c.closed ? "bg-emerald-50/60 ring-emerald-100" : "bg-white ring-ink-200"
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <span
                          aria-hidden
                          className={`mt-0.5 text-sm ${c.closed ? "text-emerald-600" : "text-ink-300"}`}
                        >
                          {c.closed ? "☑" : "☐"}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p
                            className={`text-sm ${c.closed ? "text-ink-500 line-through" : "text-ink-800"}`}
                          >
                            {c.text}
                          </p>
                          <p className="mt-0.5 text-[11px] text-ink-400">
                            {c.dueDate ? (
                              <>
                                Due <span className="tabular-nums">{formatDate(c.dueDate)}</span>
                              </>
                            ) : (
                              "No due date"
                            )}
                            {c.closed && c.closedAt ? (
                              <> · discharged {formatDateTime(c.closedAt)}</>
                            ) : null}
                          </p>
                          {c.note ? (
                            <p className="mt-1 text-xs text-ink-600">Note: {c.note}</p>
                          ) : null}

                          {!c.closed && closingId === c.id ? (
                            <div className="mt-2 space-y-2">
                              <Textarea
                                value={closeNote}
                                onChange={(e) => setCloseNote(e.target.value)}
                                placeholder="How the condition was discharged — the evidence a regulator would ask for"
                                className="min-h-16 text-xs"
                              />
                              <div className="flex gap-2">
                                <Button
                                  size="sm"
                                  disabled={detailBusy}
                                  onClick={() => void onCloseCondition(c.id)}
                                >
                                  {detailBusy ? "Discharging…" : "Confirm discharge"}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => {
                                    setClosingId(null);
                                    setCloseNote("");
                                  }}
                                >
                                  Cancel
                                </Button>
                              </div>
                            </div>
                          ) : null}
                        </div>
                        {!c.closed && closingId !== c.id ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              setClosingId(c.id);
                              setCloseNote("");
                            }}
                          >
                            Discharge
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* blocked tasks */}
            <div className="mt-5">
              <h3 className="mb-2 text-sm font-semibold text-ink-900">
                Blocked work{" "}
                <span className="font-normal text-ink-400">
                  — {detail.blockingTasks.length} task
                  {detail.blockingTasks.length === 1 ? "" : "s"}
                </span>
              </h3>
              {detail.blockingTasks.length === 0 ? (
                <p className="text-xs text-ink-400">
                  No schedule task is linked to this consent.
                </p>
              ) : (
                <ul className="divide-y divide-ink-100 rounded-md ring-1 ring-ink-200">
                  {detail.blockingTasks.map((t) => (
                    <li key={t.id} className="flex items-center gap-2 px-3 py-2 text-xs">
                      <span className="min-w-0 flex-1 truncate text-ink-800">
                        {t.wbsCode ? (
                          <span className="mr-1.5 font-mono text-ink-400">{t.wbsCode}</span>
                        ) : null}
                        {t.name}
                      </span>
                      {t.isCritical === 1 ? (
                        <span className="rounded bg-red-100 px-1 text-[10px] font-semibold uppercase text-red-700">
                          critical
                        </span>
                      ) : null}
                      <span className="shrink-0 tabular-nums text-ink-500">
                        {t.startDate ? formatDate(t.startDate) : "unscheduled"}
                      </span>
                      <span className="w-24 shrink-0 text-right">
                        <Countdown
                          days={t.daysUntilStart}
                          warnWithin={detail.status === "granted" ? -1 : 30}
                          overdueLabel="started"
                        />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : null}
      </Drawer>

      {/* -------------------------------- grant modal ------------------------- */}
      <Modal open={grantOpen} title="Record the grant" onClose={() => setGrantOpen(false)}>
        <form onSubmit={onGrant} className="space-y-4">
          <Field
            label="Granted on"
            hint="A grant without a date is not a grant — today is used if left blank."
          >
            <Input
              type="date"
              required
              value={gGranted}
              onChange={(e) => setGGranted(e.target.value)}
            />
          </Field>
          <Field
            label="Expires on"
            hint="Leave blank for a consent with no expiry. An expired grant flips itself to expired and raises a high signal."
          >
            <Input type="date" value={gExpires} onChange={(e) => setGExpires(e.target.value)} />
          </Field>
          <Field label="Reference" hint="The authority's consent or decision reference.">
            <Input
              value={gReference}
              onChange={(e) => setGReference(e.target.value)}
              placeholder="Consent reference"
              className="font-mono"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setGrantOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={detailBusy}>
              {detailBusy ? "Recording…" : "Record grant"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
