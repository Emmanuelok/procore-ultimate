/**
 * Programme side panels for the schedule workspace: earned value, key
 * milestones, the lookahead constraints log, work calendars, resource
 * loading (#370), revision comparison (#357), a calendar view, update
 * narratives and P6/MSP import-export.
 *
 * Each panel owns its own fetch, loading, error and empty state so one broken
 * endpoint never blanks the workspace, and every figure the API could not
 * produce renders as "—" with the reason the API gave — never as 0.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
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
  Stat,
  Textarea,
  Th,
} from "../../ui";
import { formatDate, formatDateTime } from "../format";
import type {
  CalendarRow,
  CalendarViewResponse,
  ConstraintRow,
  EarnedValueResponse,
  ImportRunRow,
  MilestoneRow,
  NarrativeRow,
  ResourcesResponse,
  RevisionCompareResponse,
  RevisionDiffSummary,
  ScheduleRow,
} from "./types";

function errMessage(err: unknown, fallback: string): string {
  return err instanceof ApiClientError || err instanceof Error ? err.message : fallback;
}

/** A figure the API could not produce renders with its reason, never as zero. */
function Value({ value, suffix }: { value: number | null | undefined; suffix?: string }) {
  if (value === null || value === undefined) return <span className="text-ink-400">—</span>;
  return (
    <span>
      {Math.round(value * 100) / 100}
      {suffix ?? ""}
    </span>
  );
}

function money(value: number | null | undefined, currency: string): string {
  if (value === null || value === undefined) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${currency} ${Math.round(value)}`;
  }
}

function useResource<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    if (!path) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get<T>(path)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (!cancelled) {
          setData(null);
          setError(errMessage(err, "This panel could not be loaded."));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, version, ...deps]);
  return { data, loading, error, reload };
}

/* ================================================================== */
/* Earned value (#363-369)                                             */
/* ================================================================== */

export function EarnedValuePanel({ base, scheduleId }: { base: string; scheduleId: string | null }) {
  const { data, loading, error } = useResource<EarnedValueResponse>(
    scheduleId ? `${base}/schedules/${scheduleId}/earned-value` : null,
  );

  if (!scheduleId) return <EmptyState title="Select a schedule" hint="Earned value is computed per programme." />;
  if (loading) return <Spinner label="Computing earned value…" />;
  if (error) return <ErrorAlert message={error} />;
  if (!data) return <EmptyState title="Earned value unavailable" hint="No response from the server." />;

  const c = data.currency;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Budget at completion" value={money(data.bac, c)} hint={`${data.pricedActivities} priced activities`} />
        <Stat label="Planned value" value={money(data.pv, c)} hint={`basis: ${data.basis}`} />
        <Stat label="Earned value" value={money(data.ev, c)} />
        <Stat label="Actual cost" value={money(data.ac, c)} />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="SPI"
          value={data.spi === null ? "—" : String(data.spi)}
          hint={data.spi === null ? "planned value is zero at this data date" : "earned ÷ planned"}
        />
        <Stat
          label="CPI"
          value={data.cpi === null ? "—" : String(data.cpi)}
          hint={data.cpi === null ? "no cost has been booked" : "earned ÷ actual"}
        />
        <Stat label="Forecast at completion" value={money(data.eac, c)} hint="BAC ÷ CPI" />
        <Stat
          label="Schedule EAC"
          value={data.scheduleEacDays === null ? "—" : `${data.scheduleEacDays} d`}
          hint={data.plannedDurationDays === null ? "no planned duration" : `planned ${data.plannedDurationDays} d`}
        />
      </div>

      {data.reasons.length > 0 ? (
        <Alert tone="warning" title="What these numbers do and do not include">
          <ul className="ml-4 list-disc space-y-1 text-xs">
            {data.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {data.activities.length === 0 ? (
        <EmptyState
          title="No priced activity"
          hint="Map activities to a budget line, give them a budgeted cost, or load resources with costs."
        />
      ) : (
        <Card>
          <CardBody className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <Th>Activity</Th>
                  <Th align="right">BAC</Th>
                  <Th align="right">PV</Th>
                  <Th align="right">EV</Th>
                  <Th align="right">AC</Th>
                  <Th align="right">SV</Th>
                  <Th align="right">CV</Th>
                </tr>
              </thead>
              <tbody>
                {data.activities.map((a) => (
                  <tr key={a.id} className="border-t border-ink-100">
                    <td className="px-3 py-1.5 text-ink-800">{a.name}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{money(a.bac, c)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{money(a.pv, c)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{money(a.ev, c)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{money(a.ac, c)}</td>
                    <td className={`px-3 py-1.5 text-right tabular-nums ${a.sv < 0 ? "text-red-600" : "text-ink-700"}`}>
                      {money(a.sv, c)}
                    </td>
                    <td className={`px-3 py-1.5 text-right tabular-nums ${a.cv < 0 ? "text-red-600" : "text-ink-700"}`}>
                      {money(a.cv, c)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

/* ================================================================== */
/* Key milestones (#362)                                               */
/* ================================================================== */

export function MilestonesPanel({
  base,
  scheduleId,
  onSelectTask,
}: {
  base: string;
  scheduleId: string | null;
  onSelectTask: (id: string) => void;
}) {
  const { data, loading, error, reload } = useResource<{
    items: MilestoneRow[];
    total: number;
    late: number;
    untracked: number;
  }>(scheduleId ? `${base}/schedules/${scheduleId}/milestones` : null);
  const [sweeping, setSweeping] = useState(false);
  const [sweepMessage, setSweepMessage] = useState<string | null>(null);

  async function runSweep() {
    if (!scheduleId) return;
    setSweeping(true);
    setSweepMessage(null);
    try {
      const res = await api.post<{ scanned: number; slipped: number; alerted: number }>(
        `${base}/schedules/${scheduleId}/milestone-sweep`,
      );
      setSweepMessage(
        `${res.scanned} milestone(s) checked · ${res.slipped} slipped · ${res.alerted} new alert(s) raised.`,
      );
      reload();
    } catch (err) {
      setSweepMessage(errMessage(err, "The sweep could not be run."));
    } finally {
      setSweeping(false);
    }
  }

  if (!scheduleId) return <EmptyState title="Select a schedule" hint="Milestones belong to a programme." />;
  if (loading) return <Spinner label="Loading milestones…" />;
  if (error) return <ErrorAlert message={error} />;
  if (!data) return <EmptyState title="Milestones unavailable" hint="No response from the server." />;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Stat label="Milestones" value={String(data.total)} />
        <Stat label="Late" value={String(data.late)} />
        <Stat label="Untracked" value={String(data.untracked)} hint="no contractual date" />
        <Button size="sm" variant="secondary" onClick={() => void runSweep()} disabled={sweeping}>
          {sweeping ? "Running…" : "Run slip check"}
        </Button>
      </div>
      {sweepMessage ? <Alert tone="info">{sweepMessage}</Alert> : null}
      {data.items.length === 0 ? (
        <EmptyState
          title="No milestones"
          hint="Mark an activity as a key milestone and give it a contractual date to track slip."
        />
      ) : (
        <Card>
          <CardBody className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <Th>Milestone</Th>
                  <Th>Contractual</Th>
                  <Th>Forecast / actual</Th>
                  <Th align="right">Slip</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((m) => (
                  <tr key={m.id} className="border-t border-ink-100">
                    <td className="px-3 py-1.5">
                      <button
                        type="button"
                        className="text-left text-ink-800 hover:text-brand-600"
                        onClick={() => onSelectTask(m.id)}
                      >
                        {m.wbsCode ? <span className="text-ink-400">{m.wbsCode} </span> : null}
                        {m.name}
                      </button>
                    </td>
                    <td className="px-3 py-1.5 text-ink-600">
                      {m.contractualDate ? formatDate(m.contractualDate) : <span className="text-ink-400">— not set</span>}
                    </td>
                    <td className="px-3 py-1.5 text-ink-600">
                      {m.actualFinish ? formatDate(m.actualFinish) : m.forecastDate ? formatDate(m.forecastDate) : "—"}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {m.slipDays === null ? (
                        <span className="text-ink-400">—</span>
                      ) : (
                        <span className={m.slipDays > 0 ? "text-red-600" : "text-emerald-600"}>
                          {m.slipDays > 0 ? "+" : ""}
                          {m.slipDays} d
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      <Badge
                        tone={
                          m.status === "late"
                            ? "red"
                            : m.status === "achieved"
                              ? "green"
                              : m.status === "untracked"
                                ? "neutral"
                                : "blue"
                        }
                      >
                        {m.status.replace(/_/g, " ")}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

/* ================================================================== */
/* Lookahead constraints log (#359)                                    */
/* ================================================================== */

const CONSTRAINT_CATEGORIES = [
  "design_information",
  "procurement",
  "site_access",
  "labour",
  "permit_or_approval",
  "material",
  "equipment",
  "predecessor_work",
  "weather",
  "other",
];

export function ConstraintsPanel({
  base,
  scheduleId,
  tasks,
}: {
  base: string;
  scheduleId: string | null;
  tasks: { id: string; name: string }[];
}) {
  const { data, loading, error, reload } = useResource<{ items: ConstraintRow[]; total: number }>(
    scheduleId ? `${base}/schedule-constraints?scheduleId=${scheduleId}&pageSize=200` : null,
  );
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("design_information");
  const [taskId, setTaskId] = useState("");
  const [needByDate, setNeedByDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    if (!scheduleId || description.trim().length === 0) return;
    setBusy(true);
    setFormError(null);
    try {
      await api.post(`${base}/schedule-constraints`, {
        scheduleId,
        description: description.trim(),
        category,
        taskId: taskId || null,
        needByDate: needByDate || null,
      });
      setDescription("");
      setTaskId("");
      setNeedByDate("");
      reload();
    } catch (err) {
      setFormError(errMessage(err, "The constraint could not be raised."));
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(row: ConstraintRow, status: string) {
    setBusy(true);
    setFormError(null);
    try {
      await api.patch(`${base}/schedule-constraints/${row.id}`, { status });
      reload();
    } catch (err) {
      setFormError(errMessage(err, "The constraint could not be updated."));
    } finally {
      setBusy(false);
    }
  }

  if (!scheduleId) return <EmptyState title="Select a schedule" hint="Constraints are raised against a programme." />;

  const items = data?.items ?? [];
  const open = items.filter((c) => c.status !== "cleared" && c.status !== "void");
  const overdue = open.filter((c) => c.needByDate !== null && c.needByDate < new Date().toISOString().slice(0, 10));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Stat label="Open" value={String(open.length)} />
        <Stat label="Past need-by" value={String(overdue.length)} tone={overdue.length > 0 ? "danger" : "neutral"} />
        <Stat label="Cleared" value={String(items.length - open.length)} />
      </div>

      <Card>
        <CardBody>
          <form className="grid grid-cols-1 gap-2 md:grid-cols-5" onSubmit={onCreate}>
            <Field label="What is blocking the work?" className="md:col-span-2">
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Rebar schedule not released"
                required
              />
            </Field>
            <Field label="Category">
              <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                {CONSTRAINT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c.replace(/_/g, " ")}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Activity (optional)">
              <Select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
                <option value="">—</option>
                {tasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Needed by">
              <div className="flex gap-2">
                <Input type="date" value={needByDate} onChange={(e) => setNeedByDate(e.target.value)} />
                <Button type="submit" size="sm" disabled={busy}>
                  Raise
                </Button>
              </div>
            </Field>
          </form>
          {formError ? <ErrorAlert message={formError} className="mt-2" /> : null}
        </CardBody>
      </Card>

      {loading ? <Spinner label="Loading constraints…" /> : null}
      {error ? <ErrorAlert message={error} /> : null}
      {!loading && !error && items.length === 0 ? (
        <EmptyState
          title="No constraints logged"
          hint="A constraint past its need-by date is the most reliable predictor of a missed week — log them here and the platform escalates them."
        />
      ) : null}

      {items.length > 0 ? (
        <Card>
          <CardBody className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <Th>#</Th>
                  <Th>Constraint</Th>
                  <Th>Category</Th>
                  <Th>Needed by</Th>
                  <Th>Status</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id} className="border-t border-ink-100">
                    <td className="px-3 py-1.5 tabular-nums text-ink-400">C-{c.number}</td>
                    <td className="px-3 py-1.5 text-ink-800">{c.description}</td>
                    <td className="px-3 py-1.5 text-ink-600">{c.category.replace(/_/g, " ")}</td>
                    <td className="px-3 py-1.5 text-ink-600">
                      {c.needByDate ? formatDate(c.needByDate) : <span className="text-ink-400">—</span>}
                    </td>
                    <td className="px-3 py-1.5">
                      <Badge
                        tone={
                          c.status === "escalated"
                            ? "red"
                            : c.status === "cleared"
                              ? "green"
                              : c.status === "in_progress"
                                ? "blue"
                                : "neutral"
                        }
                      >
                        {c.status.replace(/_/g, " ")}
                      </Badge>
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {c.status !== "cleared" && c.status !== "void" ? (
                        <Button size="xs" variant="ghost" disabled={busy} onClick={() => void setStatus(c, "cleared")}>
                          Clear
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

/* ================================================================== */
/* Work calendars                                                      */
/* ================================================================== */

const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

export function CalendarsPanel({ base }: { base: string }) {
  const { data, loading, error, reload } = useResource<{ items: CalendarRow[] }>(
    `${base}/schedule-calendars`,
  );
  const [name, setName] = useState("");
  const [workdays, setWorkdays] = useState<number[]>([0, 1, 1, 1, 1, 1, 0]);
  const [hoursPerDay, setHoursPerDay] = useState("8");
  const [holidays, setHolidays] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    if (name.trim().length === 0) return;
    setBusy(true);
    setFormError(null);
    try {
      await api.post(`${base}/schedule-calendars`, {
        name: name.trim(),
        workdays,
        hoursPerDay: Number(hoursPerDay) || 8,
        holidays: holidays
          .split(/[\s,]+/)
          .map((h) => h.trim())
          .filter((h) => /^\d{4}-\d{2}-\d{2}$/.test(h)),
      });
      setName("");
      setHolidays("");
      reload();
    } catch (err) {
      setFormError(errMessage(err, "The calendar could not be created."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <Card>
        <CardBody className="space-y-2">
          <form className="grid grid-cols-1 gap-2 md:grid-cols-4" onSubmit={onCreate}>
            <Field label="Calendar name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Mon-Fri 8h" required />
            </Field>
            <Field label="Working week">
              <div className="flex gap-1">
                {DAY_LABELS.map((d, i) => (
                  <button
                    key={`${d}-${i}`}
                    type="button"
                    aria-pressed={workdays[i] === 1}
                    onClick={() =>
                      setWorkdays((prev) => prev.map((v, idx) => (idx === i ? (v === 1 ? 0 : 1) : v)))
                    }
                    className={`h-7 w-7 rounded text-xs font-medium ${
                      workdays[i] === 1 ? "bg-brand-600 text-white" : "bg-ink-100 text-ink-500"
                    }`}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Hours per day">
              <Input value={hoursPerDay} onChange={(e) => setHoursPerDay(e.target.value)} inputMode="decimal" />
            </Field>
            <Field label="Holidays (ISO dates)">
              <div className="flex gap-2">
                <Input value={holidays} onChange={(e) => setHolidays(e.target.value)} placeholder="2026-12-25" />
                <Button type="submit" size="sm" disabled={busy}>
                  Add
                </Button>
              </div>
            </Field>
          </form>
          {formError ? <ErrorAlert message={formError} /> : null}
          <p className="text-xs text-ink-400">
            Durations are counts of WORKING days on the activity's calendar. Without a calendar the
            engine treats every day as a workday, which is what the platform did before.
          </p>
        </CardBody>
      </Card>

      {loading ? <Spinner label="Loading calendars…" /> : null}
      {error ? <ErrorAlert message={error} /> : null}
      {!loading && (data?.items ?? []).length === 0 ? (
        <EmptyState title="No calendars" hint="Every activity runs on a continuous 7-day week until you add one." />
      ) : null}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {(data?.items ?? []).map((c) => (
          <Card key={c.id}>
            <CardBody className="space-y-2 py-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-ink-900">{c.name}</span>
                {c.isDefault === 1 ? <Badge tone="blue">default</Badge> : null}
              </div>
              <div className="flex gap-1">
                {DAY_LABELS.map((d, i) => (
                  <span
                    key={`${c.id}-${i}`}
                    className={`flex h-6 w-6 items-center justify-center rounded text-[11px] ${
                      c.workdays[i] === 1 ? "bg-emerald-100 text-emerald-700" : "bg-ink-100 text-ink-400"
                    }`}
                  >
                    {d}
                  </span>
                ))}
              </div>
              <div className="text-xs text-ink-500">
                {c.hoursPerDay} h/day · {c.holidays.length} holiday{c.holidays.length === 1 ? "" : "s"}
                {c.scheduleId ? " · schedule-specific" : " · project-wide"}
              </div>
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  );
}

/* ================================================================== */
/* Narratives                                                          */
/* ================================================================== */

export function NarrativesPanel({ base, scheduleId }: { base: string; scheduleId: string | null }) {
  const { data, loading, error, reload } = useResource<{ items: NarrativeRow[] }>(
    scheduleId ? `${base}/schedules/${scheduleId}/narratives` : null,
  );
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    if (!scheduleId || title.trim().length === 0 || body.trim().length === 0) return;
    setBusy(true);
    setFormError(null);
    try {
      await api.post(`${base}/schedules/${scheduleId}/narratives`, {
        title: title.trim(),
        body: body.trim(),
      });
      setTitle("");
      setBody("");
      reload();
    } catch (err) {
      setFormError(errMessage(err, "The narrative could not be saved."));
    } finally {
      setBusy(false);
    }
  }

  if (!scheduleId) return <EmptyState title="Select a schedule" hint="Narratives accompany a programme update." />;

  return (
    <div className="space-y-3">
      <Card>
        <CardBody className="space-y-2">
          <form className="space-y-2" onSubmit={onCreate}>
            <Field label="Title">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="January update" required />
            </Field>
            <Field label="Narrative">
              <Textarea
                rows={4}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="What moved, why, and what is being done about it."
                required
              />
            </Field>
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-ink-400">
                The programme's computed figures are frozen onto the narrative when it is saved, so
                a later recompute cannot make the prose describe a programme that never was.
              </p>
              <Button type="submit" size="sm" disabled={busy}>
                Save
              </Button>
            </div>
          </form>
          {formError ? <ErrorAlert message={formError} /> : null}
        </CardBody>
      </Card>

      {loading ? <Spinner label="Loading narratives…" /> : null}
      {error ? <ErrorAlert message={error} /> : null}
      {!loading && (data?.items ?? []).length === 0 ? (
        <EmptyState title="No narratives yet" hint="A programme update without an explanation is a table of dates." />
      ) : null}
      <div className="space-y-2">
        {(data?.items ?? []).map((n) => (
          <Card key={n.id}>
            <CardBody className="space-y-1 py-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-ink-900">{n.title}</span>
                <span className="text-xs text-ink-400">{formatDateTime(n.createdAt)}</span>
              </div>
              <p className="whitespace-pre-wrap text-sm text-ink-700">{n.body}</p>
              {n.metrics ? (
                <div className="text-xs text-ink-400">
                  As written: completion{" "}
                  {typeof n.metrics["computedFinish"] === "string" ? n.metrics["computedFinish"] : "—"} ·{" "}
                  {typeof n.metrics["taskCount"] === "number" ? n.metrics["taskCount"] : "—"} activities ·{" "}
                  {typeof n.metrics["criticalCount"] === "number" ? n.metrics["criticalCount"] : "—"} critical
                </div>
              ) : null}
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  );
}

/* ================================================================== */
/* Import / export (#349-350)                                          */
/* ================================================================== */

interface DryRunResponse {
  dryRun: true;
  format: string;
  name: string;
  projectStart: string;
  dataDate: string | null;
  stats: { tasks: number; dependencies: number; calendars: number; resources: number };
  warnings: string[];
  diff: RevisionDiffSummary | null;
}

export function ImportPanel({
  base,
  schedules,
  onImported,
}: {
  base: string;
  schedules: ScheduleRow[];
  onImported: (scheduleId: string) => void;
}) {
  const { data, loading, error, reload } = useResource<{ items: ImportRunRow[] }>(
    `${base}/schedule-imports?pageSize=20`,
  );
  const [file, setFile] = useState<File | null>(null);
  const [targetScheduleId, setTargetScheduleId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [preview, setPreview] = useState<DryRunResponse | null>(null);

  async function send(dryRun: boolean) {
    if (!file) {
      setFormError("Choose a P6 .xer or MS Project .xml file first.");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const form = new FormData();
      if (targetScheduleId) form.append("targetScheduleId", targetScheduleId);
      if (name.trim()) form.append("name", name.trim());
      if (dryRun) form.append("dryRun", "true");
      form.append("file", file);
      const res = await api.upload<DryRunResponse | { schedule: { id: string } }>(
        `${base}/schedules/import`,
        form,
      );
      if (dryRun) {
        setPreview(res as DryRunResponse);
      } else {
        setPreview(null);
        setFile(null);
        reload();
        onImported((res as { schedule: { id: string } }).schedule.id);
      }
    } catch (err) {
      setFormError(errMessage(err, "The file could not be imported."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <Card>
        <CardBody className="space-y-2">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            <Field label="Programme file">
              <input
                type="file"
                accept=".xer,.xml,text/xml,application/xml,text/plain"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="block w-full text-xs text-ink-600 file:mr-2 file:rounded file:border-0 file:bg-ink-100 file:px-2 file:py-1 file:text-xs"
              />
            </Field>
            <Field label="Compare against (optional)">
              <Select value={targetScheduleId} onChange={(e) => setTargetScheduleId(e.target.value)}>
                <option value="">Import as a new programme</option>
                {schedules.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Name (optional)">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="From the file" />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled={busy || !file} onClick={() => void send(true)}>
              Preview changes
            </Button>
            <Button size="sm" disabled={busy || !file} onClick={() => void send(false)}>
              {targetScheduleId ? "Import as a new revision" : "Import"}
            </Button>
          </div>
          {formError ? <ErrorAlert message={formError} /> : null}
          <p className="text-xs text-ink-400">
            Primavera P6 XER and MS Project XML. Durations arrive in hours and are converted with the
            activity's own calendar; every assumption the parser had to make is listed below.
          </p>
        </CardBody>
      </Card>

      {preview ? (
        <Card>
          <CardBody className="space-y-2">
            <div className="text-sm font-medium text-ink-900">
              Preview — {preview.name} ({preview.format.toUpperCase()})
            </div>
            <div className="flex flex-wrap gap-3 text-xs text-ink-600">
              <span>{preview.stats.tasks} activities</span>
              <span>{preview.stats.dependencies} relationships</span>
              <span>{preview.stats.calendars} calendars</span>
              <span>{preview.stats.resources} resource assignments</span>
              <span>start {preview.projectStart}</span>
              <span>data date {preview.dataDate ?? "—"}</span>
            </div>
            {preview.diff ? (
              <div className="space-y-1 text-xs text-ink-700">
                <div className="font-medium text-ink-800">Against the selected revision</div>
                <div>
                  {preview.diff.totals.added} added · {preview.diff.totals.removed} removed ·{" "}
                  {preview.diff.totals.durationChanged} duration change
                  {preview.diff.totals.durationChanged === 1 ? "" : "s"} ·{" "}
                  {preview.diff.totals.logicChanged} logic change
                  {preview.diff.totals.logicChanged === 1 ? "" : "s"}
                </div>
                {preview.diff.durationChanges.slice(0, 8).map((d) => (
                  <div key={d.name} className="text-ink-600">
                    {d.name}: {d.fromDays}d → {d.toDays}d ({d.deltaDays > 0 ? "+" : ""}
                    {d.deltaDays})
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-ink-400">
                No revision selected — nothing to diff against.
              </div>
            )}
            {preview.warnings.length > 0 ? (
              <Alert tone="warning" title="Assumptions the importer had to make">
                <ul className="ml-4 list-disc space-y-1 text-xs">
                  {preview.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {loading ? <Spinner label="Loading import history…" /> : null}
      {error ? <ErrorAlert message={error} /> : null}
      {!loading && (data?.items ?? []).length === 0 ? (
        <EmptyState title="Nothing imported yet" hint="Upload a P6 XER or MS Project XML file to start." />
      ) : null}
      {(data?.items ?? []).length > 0 ? (
        <Card>
          <CardBody className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <Th>File</Th>
                  <Th>Format</Th>
                  <Th align="right">Activities</Th>
                  <Th>Warnings</Th>
                  <Th>Imported</Th>
                </tr>
              </thead>
              <tbody>
                {(data?.items ?? []).map((r) => (
                  <tr key={r.id} className="border-t border-ink-100">
                    <td className="px-3 py-1.5 text-ink-800">{r.fileName}</td>
                    <td className="px-3 py-1.5 uppercase text-ink-500">{r.format}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {typeof r.stats["tasks"] === "number" ? r.stats["tasks"] : "—"}
                    </td>
                    <td className="px-3 py-1.5 text-ink-600">
                      {r.warnings.length === 0 ? (
                        <span className="text-ink-400">none</span>
                      ) : (
                        <Badge tone="amber">{r.warnings.length}</Badge>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-ink-500">{formatDateTime(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

export { Value };

/* ================================================================== */
/* Resource loading (#370)                                             */
/* ================================================================== */

const RESOURCE_TYPES = ["labour", "equipment", "material", "subcontract", "other"];

/**
 * Resource-loaded activities. Units and cost are shown side by side because
 * a programme loaded with hours but no rates still answers "who is needed
 * when" — and the panel says so rather than showing a zero cost as if it
 * were priced.
 */
export function ResourcesPanel({
  base,
  scheduleId,
  tasks,
}: {
  base: string;
  scheduleId: string | null;
  tasks: { id: string; name: string }[];
}) {
  const { data, loading, error, reload } = useResource<ResourcesResponse>(
    scheduleId ? `${base}/schedules/${scheduleId}/resources` : null,
  );
  const currency = data?.currency ?? "USD";
  const [taskId, setTaskId] = useState("");
  const [name, setName] = useState("");
  const [resourceType, setResourceType] = useState("labour");
  const [unit, setUnit] = useState("hours");
  const [budgetedUnits, setBudgetedUnits] = useState("");
  const [unitRate, setUnitRate] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const taskName = new Map(tasks.map((t) => [t.id, t.name] as const));

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    if (!taskId || name.trim().length === 0) {
      setFormError("Choose an activity and name the resource.");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      await api.post(`${base}/schedule-tasks/${taskId}/resources`, {
        name: name.trim(),
        resourceType,
        unit: unit.trim() || null,
        budgetedUnits: Number(budgetedUnits) || 0,
        ...(unitRate.trim() === "" ? {} : { unitRate: Number(unitRate) }),
      });
      setName("");
      setBudgetedUnits("");
      setUnitRate("");
      reload();
    } catch (err) {
      setFormError(errMessage(err, "The resource could not be assigned."));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(id: string) {
    setBusy(true);
    setFormError(null);
    try {
      await api.del(`${base}/schedule-task-resources/${id}`);
      reload();
    } catch (err) {
      setFormError(errMessage(err, "The assignment could not be removed."));
    } finally {
      setBusy(false);
    }
  }

  if (!scheduleId) {
    return <EmptyState title="Select a schedule" hint="Resources load onto a programme's activities." />;
  }

  const items = data?.items ?? [];
  const byType = data?.byType ?? [];
  const reasons = data?.reasons ?? [];
  const anyPriced = items.some((r) => r.unitRate !== null || r.budgetedCost > 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Stat label="Assignments" value={String(items.length)} />
        <Stat
          label="Budgeted cost"
          value={anyPriced ? money(byType.reduce((s, t) => s + t.budgetedCost, 0), currency) : "—"}
          hint={anyPriced ? undefined : "No assignment carries a rate"}
        />
        <Stat
          label="Actual cost"
          value={anyPriced ? money(byType.reduce((s, t) => s + t.actualCost, 0), currency) : "—"}
        />
      </div>

      {reasons.length > 0 ? (
        <Alert tone="info" title="How these figures were produced">
          <ul className="ml-4 list-disc space-y-1 text-xs">
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <Card>
        <CardBody>
          <form className="grid grid-cols-1 gap-2 md:grid-cols-6" onSubmit={onCreate}>
            <Field label="Activity" className="md:col-span-2">
              <Select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
                <option value="">Choose an activity…</option>
                {tasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Resource">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Steel fixers" />
            </Field>
            <Field label="Class">
              <Select value={resourceType} onChange={(e) => setResourceType(e.target.value)}>
                {RESOURCE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Budgeted units">
              <div className="flex gap-1">
                <Input
                  type="number"
                  min="0"
                  step="any"
                  value={budgetedUnits}
                  onChange={(e) => setBudgetedUnits(e.target.value)}
                />
                <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="hours" />
              </div>
            </Field>
            <Field label={`Rate (${currency}/unit)`}>
              <div className="flex gap-2">
                <Input
                  type="number"
                  min="0"
                  step="any"
                  value={unitRate}
                  onChange={(e) => setUnitRate(e.target.value)}
                  placeholder="optional"
                />
                <Button type="submit" size="sm" disabled={busy}>
                  Add
                </Button>
              </div>
            </Field>
          </form>
          {formError ? <ErrorAlert message={formError} className="mt-2" /> : null}
        </CardBody>
      </Card>

      {loading ? <Spinner label="Loading resource assignments…" /> : null}
      {error ? <ErrorAlert message={error} /> : null}
      {!loading && !error && items.length === 0 ? (
        <EmptyState
          title="No resources loaded"
          hint="Load labour, plant and subcontract onto activities — a resource-loaded programme is what turns earned value and the DCMA resource check from 'not applicable' into a number."
        />
      ) : null}

      {byType.length > 0 ? (
        <Card>
          <CardBody className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <Th>Class</Th>
                  <Th align="right">Budgeted units</Th>
                  <Th align="right">Actual units</Th>
                  <Th align="right">Budgeted cost</Th>
                  <Th align="right">Actual cost</Th>
                </tr>
              </thead>
              <tbody>
                {byType.map((t) => (
                  <tr key={t.resourceType} className="border-t border-ink-100">
                    <td className="px-3 py-1.5 text-ink-800">{t.resourceType}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      <Value value={t.budgetedUnits} />
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      <Value value={t.actualUnits} />
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {t.budgetedCost > 0 ? money(t.budgetedCost, currency) : <span className="text-ink-400">—</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {t.actualCost > 0 ? money(t.actualCost, currency) : <span className="text-ink-400">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      ) : null}

      {items.length > 0 ? (
        <Card>
          <CardBody className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <Th>Activity</Th>
                  <Th>Resource</Th>
                  <Th>Class</Th>
                  <Th align="right">Budgeted</Th>
                  <Th align="right">Actual</Th>
                  <Th align="right">Rate</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id} className="border-t border-ink-100">
                    <td className="px-3 py-1.5 text-ink-700">{taskName.get(r.taskId) ?? r.taskId}</td>
                    <td className="px-3 py-1.5 text-ink-900">{r.name}</td>
                    <td className="px-3 py-1.5 text-ink-500">{r.resourceType}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {r.budgetedUnits} {r.unit ?? ""}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {r.actualUnits} {r.unit ?? ""}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {r.unitRate === null ? (
                        <span className="text-ink-400" title="No rate recorded — cost is not available">
                          —
                        </span>
                      ) : (
                        money(r.unitRate, currency)
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <Button size="xs" variant="ghost" disabled={busy} onClick={() => void onDelete(r.id)}>
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

/* ================================================================== */
/* Revision comparison (#357) and MSPDI export                         */
/* ================================================================== */

export function RevisionsPanel({
  base,
  schedules,
  scheduleId,
}: {
  base: string;
  schedules: ScheduleRow[];
  scheduleId: string | null;
}) {
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState(scheduleId ?? "");
  const [result, setResult] = useState<RevisionCompareResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  /* A stale comparison headed by the previous revision pair is a lie about
   * the current selection, so the result is dropped whenever either side
   * changes. */
  useEffect(() => {
    setResult(null);
    setPanelError(null);
  }, [fromId, toId]);

  async function run() {
    if (!fromId || !toId || fromId === toId) {
      setPanelError("Choose two different revisions to compare.");
      return;
    }
    setBusy(true);
    setPanelError(null);
    try {
      const res = await api.get<RevisionCompareResponse>(
        `${base}/schedules-compare?fromScheduleId=${encodeURIComponent(fromId)}&toScheduleId=${encodeURIComponent(toId)}`,
      );
      setResult(res);
    } catch (err) {
      setResult(null);
      setPanelError(errMessage(err, "The revisions could not be compared."));
    } finally {
      setBusy(false);
    }
  }

  async function exportXml() {
    if (!scheduleId) return;
    setExportError(null);
    try {
      const xml = await api.get<string>(`${base}/schedules/${scheduleId}/export?format=mspdi`);
      const blob = new Blob([typeof xml === "string" ? xml : String(xml)], {
        type: "application/xml;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const name = schedules.find((s) => s.id === scheduleId)?.name ?? "schedule";
      a.download = `${name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "schedule"}.xml`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setExportError(errMessage(err, "The programme could not be exported."));
    }
  }

  const diff = result?.diff ?? null;

  return (
    <div className="space-y-3">
      <Card>
        <CardBody className="space-y-2">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            <Field label="From revision">
              <Select value={fromId} onChange={(e) => setFromId(e.target.value)}>
                <option value="">Choose…</option>
                {schedules.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.revision ? ` (rev ${s.revision})` : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="To revision">
              <Select value={toId} onChange={(e) => setToId(e.target.value)}>
                <option value="">Choose…</option>
                {schedules.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.revision ? ` (rev ${s.revision})` : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex items-end gap-2">
              <Button size="sm" disabled={busy} onClick={() => void run()}>
                Compare
              </Button>
              <Button size="sm" variant="secondary" disabled={!scheduleId} onClick={() => void exportXml()}>
                Export MS Project XML
              </Button>
            </div>
          </div>
          {panelError ? <ErrorAlert message={panelError} /> : null}
          {exportError ? <ErrorAlert message={exportError} /> : null}
          <p className="text-xs text-ink-400">
            Activities are matched on the source file id, then WBS code and name — a renamed activity
            with no external id reads as one removed and one added, and the totals say so.
          </p>
        </CardBody>
      </Card>

      {result && diff ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Stat
              label="Completion movement"
              value={
                result.completionMovementDays === null
                  ? "—"
                  : `${result.completionMovementDays > 0 ? "+" : ""}${result.completionMovementDays} d`
              }
              hint={
                result.completionMovementDays === null
                  ? "One of the revisions has no computed finish"
                  : `${result.from.computedFinish ?? "?"} → ${result.to.computedFinish ?? "?"}`
              }
              tone={
                result.completionMovementDays !== null && result.completionMovementDays > 0
                  ? "danger"
                  : "neutral"
              }
            />
            <Stat label="Added" value={String(diff.totals.added)} />
            <Stat label="Removed" value={String(diff.totals.removed)} />
            <Stat label="Duration changes" value={String(diff.totals.durationChanged)} />
            <Stat label="Logic changes" value={String(diff.totals.logicChanged)} />
          </div>

          {diff.durationChanges.length > 0 ? (
            <Card>
              <CardHeaderless title="Duration changes" />
              <CardBody className="overflow-x-auto p-0">
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <Th>Activity</Th>
                      <Th align="right">From</Th>
                      <Th align="right">To</Th>
                      <Th align="right">Delta</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {diff.durationChanges.slice(0, 100).map((d) => (
                      <tr key={`${d.name}-${d.fromDays}-${d.toDays}`} className="border-t border-ink-100">
                        <td className="px-3 py-1.5 text-ink-800">{d.name}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{d.fromDays}d</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{d.toDays}d</td>
                        <td
                          className={`px-3 py-1.5 text-right tabular-nums ${d.deltaDays > 0 ? "text-red-600" : "text-emerald-600"}`}
                        >
                          {d.deltaDays > 0 ? "+" : ""}
                          {d.deltaDays}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardBody>
            </Card>
          ) : null}

          {diff.logicAdded.length > 0 || diff.logicRemoved.length > 0 || diff.logicChanged.length > 0 ? (
            <Card>
              <CardHeaderless title="Logic changes" />
              <CardBody className="space-y-1 text-xs">
                {diff.logicAdded.slice(0, 40).map((l) => (
                  <div key={`a-${l.predecessor}-${l.successor}`} className="text-emerald-700">
                    + {l.predecessor} → {l.successor} {l.toType ?? ""}
                  </div>
                ))}
                {diff.logicRemoved.slice(0, 40).map((l) => (
                  <div key={`r-${l.predecessor}-${l.successor}`} className="text-red-600">
                    − {l.predecessor} → {l.successor} {l.fromType ?? ""}
                  </div>
                ))}
                {diff.logicChanged.slice(0, 40).map((l) => (
                  <div key={`c-${l.predecessor}-${l.successor}`} className="text-amber-700">
                    ~ {l.predecessor} → {l.successor}: {l.fromType ?? "?"} → {l.toType ?? "?"}
                  </div>
                ))}
              </CardBody>
            </Card>
          ) : null}

          {diff.totals.added === 0 &&
          diff.totals.removed === 0 &&
          diff.totals.durationChanged === 0 &&
          diff.totals.logicChanged === 0 ? (
            <EmptyState
              title="No structural differences"
              hint="Durations, logic and the activity set are identical between these two revisions."
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** A minimal card title row — CardHeader is reserved for page-level cards. */
function CardHeaderless({ title }: { title: string }) {
  return (
    <div className="border-b border-ink-100 px-3 py-2 text-sm font-medium text-ink-800">{title}</div>
  );
}

/* ================================================================== */
/* Calendar view                                                       */
/* ================================================================== */

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function CalendarViewPanel({ base, scheduleId }: { base: string; scheduleId: string | null }) {
  const [from, setFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [weeks, setWeeks] = useState(6);
  const query =
    scheduleId && from
      ? `${base}/schedules/${scheduleId}/calendar-view?from=${from}&to=${addWeeks(from, weeks)}`
      : null;
  const { data, loading, error } = useResource<CalendarViewResponse>(query);

  if (!scheduleId) {
    return <EmptyState title="Select a schedule" hint="The calendar renders one programme's activities." />;
  }

  const days = data?.days ?? [];
  /* Pad to a Sunday-start grid so weeks line up with the calendar people
   * actually use. */
  const lead = days[0] ? new Date(`${days[0].date}T00:00:00Z`).getUTCDay() : 0;

  return (
    <div className="space-y-3">
      <Card>
        <CardBody>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
            <Field label="From">
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="Weeks">
              <Select value={String(weeks)} onChange={(e) => setWeeks(Number(e.target.value))}>
                {[2, 4, 6, 8, 12].map((w) => (
                  <option key={w} value={w}>
                    {w}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="md:col-span-2 flex items-end text-xs text-ink-500">
              {data?.calendarName
                ? `Non-working days from calendar "${data.calendarName}".`
                : "No work calendar is assigned — every day reads as working."}
            </div>
          </div>
        </CardBody>
      </Card>

      {loading ? <Spinner label="Loading the calendar…" /> : null}
      {error ? <ErrorAlert message={error} /> : null}
      {!loading && !error && days.length === 0 ? (
        <EmptyState title="Nothing in this window" hint="Widen the window or compute the programme." />
      ) : null}

      {days.length > 0 ? (
        <Card>
          <CardBody>
            <div className="grid grid-cols-7 gap-px text-[11px]">
              {WEEKDAY_LABELS.map((d) => (
                <div key={d} className="px-1 pb-1 text-center font-medium text-ink-500">
                  {d}
                </div>
              ))}
              {Array.from({ length: lead }).map((_, i) => (
                <div key={`pad-${i}`} />
              ))}
              {days.map((d) => (
                <div
                  key={d.date}
                  className={`min-h-[64px] rounded border p-1 ${
                    d.working ? "border-ink-200 bg-surface" : "border-ink-100 bg-ink-50 text-ink-400"
                  }`}
                >
                  <div className="mb-0.5 flex items-center justify-between">
                    <span className="tabular-nums">{d.date.slice(8)}</span>
                    {d.inProgress > 0 ? (
                      <span className="text-ink-400" title={`${d.inProgress} activities in progress`}>
                        {d.inProgress}
                      </span>
                    ) : null}
                  </div>
                  {d.starting.slice(0, 2).map((t) => (
                    <div
                      key={`s-${t.id}`}
                      className={`truncate ${t.isCritical ? "text-red-600" : "text-emerald-700"}`}
                      title={`Starts: ${t.name}`}
                    >
                      ▶ {t.name}
                    </div>
                  ))}
                  {d.finishing.slice(0, 2).map((t) => (
                    <div
                      key={`f-${t.id}`}
                      className={`truncate ${t.isCritical ? "text-red-600" : "text-ink-600"}`}
                      title={`${t.isMilestone ? "Milestone" : "Finishes"}: ${t.name}`}
                    >
                      {t.isMilestone ? "◆" : "◀"} {t.name}
                    </div>
                  ))}
                  {d.starting.length + d.finishing.length > 4 ? (
                    <div className="text-ink-400">+{d.starting.length + d.finishing.length - 4} more</div>
                  ) : null}
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

function addWeeks(iso: string, weeks: number): string {
  const d = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(d)) return iso;
  return new Date(d + weeks * 7 * 86_400_000).toISOString().slice(0, 10);
}
