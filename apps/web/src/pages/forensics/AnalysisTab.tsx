/**
 * Forensic analysis views: as-planned vs as-built comparison against a
 * captured baseline (spec Domain D #269) and windows attribution of delay
 * events (#273 — honestly scoped to per-event TIA movement).
 */
import { useCallback, useEffect, useState } from "react";
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
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import { formatDate, humanize } from "../format";
import {
  causeTone,
  deLabel,
  InfoBanner,
  SlipCell,
  TiaChip,
  type ApvabResponse,
  type BaselineRow,
  type ListResponse,
  type ScheduleRow,
  type WindowsResponse,
} from "./forensicsShared";

export default function AnalysisTab({ projectId }: { projectId: string }) {
  const base = `/api/v1/projects/${projectId}`;

  const [schedules, setSchedules] = useState<ScheduleRow[] | null>(null);
  const [scheduleId, setScheduleId] = useState("");
  const [baselines, setBaselines] = useState<BaselineRow[]>([]);
  const [baselineId, setBaselineId] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);

  /* ------------------------- schedule / baseline pickers ------------------------- */

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<ListResponse<ScheduleRow>>(`${base}/schedules?pageSize=100`);
        if (cancelled) return;
        setSchedules(res.items);
        const active = res.items.find((s) => s.isActive === 1) ?? res.items[0];
        if (active) setScheduleId(active.id);
      } catch (err) {
        if (!cancelled) {
          setSchedules([]);
          setLoadError(err instanceof Error ? err.message : "Failed to load schedules");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base]);

  useEffect(() => {
    if (!scheduleId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{ items: BaselineRow[] }>(
          `${base}/schedules/${scheduleId}/baselines`,
        );
        if (cancelled) return;
        setBaselines(res.items);
        setBaselineId(res.items[0]?.id ?? "");
      } catch {
        if (!cancelled) {
          setBaselines([]);
          setBaselineId("");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base, scheduleId]);

  /* --------------------------- as-planned vs as-built --------------------------- */

  const [apvab, setApvab] = useState<ApvabResponse | null>(null);
  const [apvabError, setApvabError] = useState<string | null>(null);
  const [apvabLoading, setApvabLoading] = useState(false);

  const loadApvab = useCallback(async () => {
    if (!scheduleId) return;
    setApvabLoading(true);
    setApvabError(null);
    setApvab(null);
    try {
      const params = new URLSearchParams({ scheduleId });
      if (baselineId) params.set("baselineId", baselineId);
      const res = await api.get<ApvabResponse>(
        `${base}/forensics/as-planned-vs-as-built?${params}`,
      );
      setApvab(res);
    } catch (err) {
      setApvabError(
        err instanceof ApiClientError ? err.message : "As-planned vs as-built comparison failed",
      );
    } finally {
      setApvabLoading(false);
    }
  }, [base, scheduleId, baselineId]);

  useEffect(() => {
    void loadApvab();
  }, [loadApvab]);

  /* --------------------------------- windows --------------------------------- */

  const [boundaries, setBoundaries] = useState<string[]>([""]);
  const [windowsRes, setWindowsRes] = useState<WindowsResponse | null>(null);
  const [windowsError, setWindowsError] = useState<string | null>(null);
  const [windowsBusy, setWindowsBusy] = useState(false);

  function setBoundary(i: number, value: string) {
    setBoundaries((b) => b.map((d, j) => (j === i ? value : d)));
  }

  async function runWindows() {
    const dates = boundaries.map((b) => b.trim()).filter(Boolean);
    if (dates.length === 0) {
      setWindowsError("Add at least one window boundary date.");
      return;
    }
    setWindowsBusy(true);
    setWindowsError(null);
    try {
      const params = new URLSearchParams({ boundaries: dates.join(",") });
      if (scheduleId) params.set("scheduleId", scheduleId);
      const res = await api.get<WindowsResponse>(`${base}/forensics/windows?${params}`);
      setWindowsRes(res);
    } catch (err) {
      setWindowsError(err instanceof ApiClientError ? err.message : "Windows analysis failed");
    } finally {
      setWindowsBusy(false);
    }
  }

  /* --------------------------------- render --------------------------------- */

  if (schedules === null) return <Spinner />;
  if (schedules.length === 0) {
    return (
      <EmptyState
        title="No schedules in this project"
        hint="Forensic analysis compares the live programme against a captured baseline — build a schedule first."
      />
    );
  }

  const slipTone = (days: number | null) =>
    days === null ? "text-ink-400" : days > 0 ? "text-red-700" : "text-emerald-700";

  return (
    <div className="space-y-8">
      <ErrorAlert message={loadError} />

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-64">
          <Field label="Schedule">
            <Select value={scheduleId} onChange={(e) => setScheduleId(e.target.value)}>
              {schedules.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.isActive === 1 ? " (active)" : ""}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="w-64">
          <Field label="Baseline">
            <Select
              value={baselineId}
              onChange={(e) => setBaselineId(e.target.value)}
              disabled={baselines.length === 0}
            >
              {baselines.length === 0 ? <option value="">No baselines captured</option> : null}
              {baselines.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} · {formatDate(b.capturedAt)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>

      {/* ------------------------ As-planned vs as-built ------------------------ */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">
          As-planned vs as-built
        </h2>

        {apvabLoading ? <Spinner /> : null}
        {apvabError ? <InfoBanner message={apvabError} /> : null}

        {apvab ? (
          <>
            <Card
              className={`mb-4 border-l-4 ${
                (apvab.totalSlipDays ?? 0) > 0 ? "border-l-red-500" : "border-l-emerald-500"
              }`}
            >
              <CardBody className="flex flex-wrap items-center gap-x-10 gap-y-3 py-4">
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
                    Planned finish
                  </div>
                  <div className="text-lg font-semibold text-ink-900">
                    {formatDate(apvab.plannedFinish)}
                  </div>
                  <div className="text-xs text-ink-400">
                    baseline “{apvab.baselineName}” · {formatDate(apvab.capturedAt)}
                  </div>
                </div>
                <div className="text-2xl text-ink-300">→</div>
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
                    Current forecast finish
                  </div>
                  <div className="text-lg font-semibold text-ink-900">
                    {formatDate(apvab.currentForecastFinish)}
                  </div>
                </div>
                <div className="ml-auto text-right">
                  <div className="text-xs font-medium uppercase tracking-wide text-ink-400">
                    Total slip
                  </div>
                  <div className={`text-2xl font-bold ${slipTone(apvab.totalSlipDays)}`}>
                    {apvab.totalSlipDays === null
                      ? "—"
                      : `${apvab.totalSlipDays > 0 ? "+" : ""}${apvab.totalSlipDays}d`}
                  </div>
                </div>
              </CardBody>
            </Card>

            {apvab.tasks.length === 0 ? (
              <EmptyState title="The schedule has no tasks" />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Task</Th>
                    <Th>Planned start</Th>
                    <Th>Actual / forecast</Th>
                    <Th>Start slip</Th>
                    <Th>Planned finish</Th>
                    <Th>Actual / forecast</Th>
                    <Th>Finish slip</Th>
                    <Th></Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {apvab.tasks.map((t) => (
                    <tr key={t.taskId} className="hover:bg-ink-50/60">
                      <Td className="max-w-56">
                        <span className="block truncate font-medium text-ink-900">
                          {t.wbsCode ? (
                            <span className="mr-1 font-mono text-xs text-ink-400">{t.wbsCode}</span>
                          ) : null}
                          {t.name}
                        </span>
                        {!t.inBaseline ? (
                          <span className="text-xs text-amber-600">not in baseline</span>
                        ) : null}
                      </Td>
                      <Td className="whitespace-nowrap text-xs">{formatDate(t.plannedStart)}</Td>
                      <Td className="whitespace-nowrap text-xs">
                        {formatDate(t.actualOrForecastStart)}
                        {t.hasStarted ? (
                          <span className="ml-1 text-[10px] text-emerald-600">actual</span>
                        ) : null}
                      </Td>
                      <Td>
                        <SlipCell days={t.startSlipDays} />
                      </Td>
                      <Td className="whitespace-nowrap text-xs">{formatDate(t.plannedFinish)}</Td>
                      <Td className="whitespace-nowrap text-xs">
                        {formatDate(t.actualOrForecastFinish)}
                        {t.hasFinished ? (
                          <span className="ml-1 text-[10px] text-emerald-600">actual</span>
                        ) : null}
                      </Td>
                      <Td>
                        <SlipCell days={t.finishSlipDays} />
                      </Td>
                      <Td>{t.isCritical ? <Badge tone="red">critical</Badge> : null}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </>
        ) : null}
      </section>

      {/* -------------------------------- Windows -------------------------------- */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">
          Windows analysis
        </h2>
        <p className="mb-3 text-sm text-ink-500">
          Slice the project into windows at boundary dates; delay events are attributed to the
          window containing their start date.
        </p>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          {boundaries.map((b, i) => (
            <div key={i} className="flex items-center gap-1">
              <Input
                type="date"
                value={b}
                onChange={(e) => setBoundary(i, e.target.value)}
                className="w-40"
                aria-label={`Window boundary ${i + 1}`}
              />
              {boundaries.length > 1 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setBoundaries((arr) => arr.filter((_, j) => j !== i))}
                  aria-label={`Remove boundary ${i + 1}`}
                >
                  ✕
                </Button>
              ) : null}
            </div>
          ))}
          <Button variant="secondary" size="sm" onClick={() => setBoundaries((b) => [...b, ""])}>
            Add boundary
          </Button>
          <Button size="sm" onClick={() => void runWindows()} disabled={windowsBusy}>
            {windowsBusy ? "Analysing…" : "Run windows analysis"}
          </Button>
        </div>

        <ErrorAlert message={windowsError} />

        {windowsRes ? (
          <>
            <InfoBanner message={windowsRes.method} />
            {windowsRes.unattributedEvents > 0 ? (
              <p className="mb-3 text-xs text-amber-600">
                {windowsRes.unattributedEvents} event
                {windowsRes.unattributedEvents === 1 ? "" : "s"} fell before the project start and
                could not be attributed.
              </p>
            ) : null}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {windowsRes.windows.map((w, i) => (
                <Card key={i}>
                  <CardBody>
                    <div className="mb-2 flex items-center justify-between">
                      <div className="text-sm font-semibold text-ink-900">
                        Window {i + 1}
                        <span className="ml-2 text-xs font-normal text-ink-400">
                          {formatDate(w.start)} → {w.end ? formatDate(w.end) : "open"}
                        </span>
                      </div>
                      <TiaChip deltaDays={w.totals.events > 0 ? w.totals.tiaDeltaDays : null} />
                    </div>
                    <div className="mb-3 grid grid-cols-4 gap-2 text-center">
                      <div className="rounded-md bg-ink-50 px-2 py-1.5">
                        <div className="text-base font-bold text-ink-900">{w.totals.events}</div>
                        <div className="text-[10px] uppercase tracking-wide text-ink-400">
                          events
                        </div>
                      </div>
                      <div className="rounded-md bg-blue-50 px-2 py-1.5">
                        <div className="text-base font-bold text-blue-800">
                          {w.totals.excusableDays}
                        </div>
                        <div className="text-[10px] uppercase tracking-wide text-blue-600">
                          excusable d
                        </div>
                      </div>
                      <div className="rounded-md bg-emerald-50 px-2 py-1.5">
                        <div className="text-base font-bold text-emerald-800">
                          {w.totals.compensableDays}
                        </div>
                        <div className="text-[10px] uppercase tracking-wide text-emerald-600">
                          compensable d
                        </div>
                      </div>
                      <div className="rounded-md bg-red-50 px-2 py-1.5">
                        <div className="text-base font-bold text-red-800">
                          {w.totals.nonExcusableDays}
                        </div>
                        <div className="text-[10px] uppercase tracking-wide text-red-600">
                          non-excusable d
                        </div>
                      </div>
                    </div>
                    {w.events.length === 0 ? (
                      <p className="text-xs text-ink-400">No delay events in this window.</p>
                    ) : (
                      <ul className="divide-y divide-ink-100">
                        {w.events.map((ev) => (
                          <li key={ev.id} className="flex items-center gap-2 py-1.5 text-sm">
                            <span className="font-mono text-xs text-ink-400">
                              {deLabel(ev.number)}
                            </span>
                            <span className="flex-1 truncate text-ink-800">{ev.title}</span>
                            <Badge tone={causeTone(ev.cause)}>{humanize(ev.cause)}</Badge>
                            <span className="whitespace-nowrap text-xs text-ink-400">
                              {ev.durationDays}d
                            </span>
                            <TiaChip deltaDays={ev.tiaDeltaDays} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardBody>
                </Card>
              ))}
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}
