/**
 * Forensic method suite (spec Vol II Domain D #270-281).
 *
 * Three things a delay expert has to do, in one place:
 *  1. CHOOSE a method, with the AACE 29R-03 factors applied and the reasoning
 *     recorded on the analysis rather than left in an email.
 *  2. RUN it — impacted as-planned, collapsed as-built, windows, longest path
 *     or a concurrency assessment — against a chosen programme and event set.
 *  3. READ the result, including the parts the engine could NOT compute: an
 *     event with no struck activity is listed as unmodelled, never as zero.
 *
 * The float and concurrency doctrine the project has recorded is shown and
 * editable here too, because every entitlement recommendation cites it.
 */
import { useCallback, useEffect, useState } from "react";
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
  Textarea,
  Th,
} from "../../ui";
import { formatDate, formatDateTime } from "../format";
import { deLabel, type DelayEventRow, type ListResponse, type ScheduleRow } from "./forensicsShared";

function msg(err: unknown, fallback: string): string {
  return err instanceof ApiClientError || err instanceof Error ? err.message : fallback;
}

interface Recommendation {
  method: string;
  mipCode: string;
  label: string;
  suitability: "recommended" | "possible" | "not_advised";
  rationale: string;
}

interface FloatRules {
  ownership: string;
  concurrencyRule: string;
  concurrencyThresholdDays: number;
  pacingThresholdDays: number;
  basis: string | null;
  configured: boolean;
  explanation: string;
}

interface AnalysisRow {
  id: string;
  method: string;
  mipCode: string | null;
  sclReference: string | null;
  title: string;
  resultDays: number | null;
  summary: string | null;
  rationale: string | null;
  claimId: string | null;
  createdAt: string;
  inputs?: Record<string, unknown>;
  output?: Record<string, unknown>;
}

const METHODS = [
  { key: "impacted_as_planned", label: "Impacted as-planned (MIP 3.6)" },
  { key: "time_impact_analysis", label: "Time impact analysis (MIP 3.7)" },
  { key: "windows", label: "Windows / time slice (MIP 3.4)" },
  { key: "collapsed_as_built", label: "Collapsed as-built (MIP 3.8)" },
  { key: "longest_path", label: "Retrospective longest path (MIP 3.9)" },
  { key: "concurrency", label: "Concurrency & pacing" },
  { key: "as_planned_vs_as_built", label: "As-planned vs as-built (MIP 3.1)" },
];

const OWNERSHIP = ["project", "contractor", "owner", "first_come"];
const CONCURRENCY_RULES = ["sca_protocol", "malmaison", "apportionment"];
const PARTIES = ["owner", "contractor", "third_party", "neither"];

export default function MethodsTab({ projectId }: { projectId: string }) {
  const base = `/api/v1/projects/${projectId}`;

  const [schedules, setSchedules] = useState<ScheduleRow[] | null>(null);
  const [scheduleId, setScheduleId] = useState("");
  const [events, setEvents] = useState<DelayEventRow[]>([]);
  const [analyses, setAnalyses] = useState<AnalysisRow[]>([]);
  const [rules, setRules] = useState<FloatRules | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [sched, evs, runs, fr] = await Promise.all([
          api.get<ListResponse<ScheduleRow>>(`${base}/schedules?pageSize=100`),
          api.get<ListResponse<DelayEventRow>>(`${base}/delay-events?pageSize=200`),
          api.get<ListResponse<AnalysisRow>>(`${base}/forensics/analyses?pageSize=50`),
          api.get<FloatRules>(`${base}/forensics/float-rules`),
        ]);
        if (cancelled) return;
        setSchedules(sched.items);
        setScheduleId((prev) => prev || (sched.items.find((s) => s.isActive === 1) ?? sched.items[0])?.id || "");
        setEvents(evs.items.filter((e) => e.status !== "withdrawn"));
        setAnalyses(runs.items);
        setRules(fr);
      } catch (err) {
        if (!cancelled) {
          setSchedules([]);
          setLoadError(msg(err, "The forensic workspace could not be loaded."));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base, version]);

  /* ------------------------------ selection wizard ------------------------------ */

  const [factors, setFactors] = useState({
    perspective: "retrospective",
    updatesAvailable: true,
    baselineAvailable: true,
    asBuiltComplete: true,
    concurrencyInIssue: false,
  });
  const [recommendations, setRecommendations] = useState<Recommendation[] | null>(null);
  const [wizardBusy, setWizardBusy] = useState(false);

  async function runWizard() {
    setWizardBusy(true);
    try {
      const res = await api.post<{ recommendations: Recommendation[] }>(
        `${base}/forensics/method-selection`,
        factors,
      );
      setRecommendations(res.recommendations);
    } catch (err) {
      setLoadError(msg(err, "The method selector failed."));
    } finally {
      setWizardBusy(false);
    }
  }

  /* --------------------------------- run form --------------------------------- */

  const [method, setMethod] = useState("impacted_as_planned");
  const [title, setTitle] = useState("");
  const [party, setParty] = useState("owner");
  const [boundaries, setBoundaries] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
  const [rationale, setRationale] = useState("");
  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<AnalysisRow | null>(null);

  async function runAnalysis() {
    if (!scheduleId || title.trim().length === 0) {
      setRunError("Give the analysis a title and choose a programme.");
      return;
    }
    setRunBusy(true);
    setRunError(null);
    try {
      const payload: Record<string, unknown> = {
        method,
        title: title.trim(),
        scheduleId,
        rationale: rationale.trim() || undefined,
      };
      if (selectedEvents.length > 0) payload["eventIds"] = selectedEvents;
      if (method === "collapsed_as_built") payload["party"] = party;
      if (method === "windows") {
        payload["boundaries"] = boundaries
          .split(/[\s,]+/)
          .map((b) => b.trim())
          .filter((b) => /^\d{4}-\d{2}-\d{2}$/.test(b));
      }
      const res = await api.post<AnalysisRow>(`${base}/forensics/analyses`, payload);
      setLastRun(res);
      reload();
    } catch (err) {
      setRunError(msg(err, "The analysis could not be run."));
    } finally {
      setRunBusy(false);
    }
  }

  /* ------------------------------- float doctrine ------------------------------- */

  const [rulesBusy, setRulesBusy] = useState(false);
  const [rulesError, setRulesError] = useState<string | null>(null);

  async function saveRules(next: Partial<FloatRules>) {
    if (!rules) return;
    setRulesBusy(true);
    setRulesError(null);
    try {
      const saved = await api.put<FloatRules>(`${base}/forensics/float-rules`, {
        ownership: next.ownership ?? rules.ownership,
        concurrencyRule: next.concurrencyRule ?? rules.concurrencyRule,
        concurrencyThresholdDays: next.concurrencyThresholdDays ?? rules.concurrencyThresholdDays,
        pacingThresholdDays: next.pacingThresholdDays ?? rules.pacingThresholdDays,
        basis: next.basis !== undefined ? next.basis : rules.basis,
      });
      setRules(saved);
    } catch (err) {
      setRulesError(msg(err, "The float doctrine could not be saved."));
    } finally {
      setRulesBusy(false);
    }
  }

  if (schedules === null) return <Spinner />;
  if (schedules.length === 0) {
    return (
      <EmptyState
        title="No schedules in this project"
        hint="Every forensic method runs against a programme — import or build one first."
      />
    );
  }

  return (
    <div className="space-y-8">
      <ErrorAlert message={loadError} />

      {/* --------------------------- method selection --------------------------- */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Method selection (AACE 29R-03)
        </h2>
        <Card>
          <CardBody className="space-y-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
              <Field label="Perspective">
                <Select
                  value={factors.perspective}
                  onChange={(e) => setFactors({ ...factors, perspective: e.target.value })}
                >
                  <option value="prospective">Prospective</option>
                  <option value="retrospective">Retrospective</option>
                </Select>
              </Field>
              {(
                [
                  ["updatesAvailable", "Contemporaneous updates"],
                  ["baselineAvailable", "Credible baseline"],
                  ["asBuiltComplete", "Complete as-built record"],
                  ["concurrencyInIssue", "Concurrency in issue"],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 pt-6 text-sm text-ink-700">
                  <input
                    type="checkbox"
                    checked={factors[key]}
                    onChange={(e) => setFactors({ ...factors, [key]: e.target.checked })}
                  />
                  {label}
                </label>
              ))}
            </div>
            <Button size="sm" variant="secondary" disabled={wizardBusy} onClick={() => void runWizard()}>
              {wizardBusy ? "Assessing…" : "Which method fits?"}
            </Button>
            {recommendations ? (
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                {recommendations.map((r) => (
                  <Card key={r.method} className={r.suitability === "not_advised" ? "opacity-70" : ""}>
                    <CardBody className="space-y-1 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-ink-900">{r.label}</span>
                        <Badge
                          tone={
                            r.suitability === "recommended"
                              ? "green"
                              : r.suitability === "possible"
                                ? "amber"
                                : "neutral"
                          }
                        >
                          {r.suitability.replace(/_/g, " ")}
                        </Badge>
                      </div>
                      <div className="text-xs text-ink-500">{r.rationale}</div>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => {
                          setMethod(r.method);
                          setRationale(r.rationale);
                        }}
                      >
                        Use this method
                      </Button>
                    </CardBody>
                  </Card>
                ))}
              </div>
            ) : null}
          </CardBody>
        </Card>
      </section>

      {/* ------------------------------- run a method ------------------------------- */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Run an analysis</h2>
        <Card>
          <CardBody className="space-y-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <Field label="Method">
                <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                  {METHODS.map((m) => (
                    <option key={m.key} value={m.key}>
                      {m.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Programme">
                <Select value={scheduleId} onChange={(e) => setScheduleId(e.target.value)}>
                  {schedules.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {s.isActive === 1 ? " (active)" : ""}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Title" className="md:col-span-2">
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="IAP of the January compensation events"
                />
              </Field>
              {method === "collapsed_as_built" ? (
                <Field label="Remove delay attributable to">
                  <Select value={party} onChange={(e) => setParty(e.target.value)}>
                    {PARTIES.map((p) => (
                      <option key={p} value={p}>
                        {p.replace(/_/g, " ")}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
              {method === "windows" ? (
                <Field label="Window boundaries (ISO dates)" className="md:col-span-2">
                  <Input
                    value={boundaries}
                    onChange={(e) => setBoundaries(e.target.value)}
                    placeholder="2026-02-01, 2026-03-01"
                  />
                </Field>
              ) : null}
            </div>

            <Field label="Why this method (recorded on the analysis)">
              <Textarea
                rows={2}
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
                placeholder="Contemporaneous updates exist for every month, so a windows analysis is preferred."
              />
            </Field>

            <div>
              <div className="mb-1 text-xs font-medium text-ink-600">
                Delay events ({selectedEvents.length || "all live"} selected)
              </div>
              {events.length === 0 ? (
                <div className="text-xs text-ink-400">
                  No live delay events — register events before running an additive method.
                </div>
              ) : (
                <div className="flex max-h-40 flex-wrap gap-1 overflow-y-auto">
                  {events.map((e) => {
                    const on = selectedEvents.includes(e.id);
                    return (
                      <button
                        key={e.id}
                        type="button"
                        onClick={() =>
                          setSelectedEvents((prev) =>
                            on ? prev.filter((x) => x !== e.id) : [...prev, e.id],
                          )
                        }
                        className={`rounded-full px-2 py-0.5 text-[11px] ring-1 ${
                          on
                            ? "bg-brand-50 text-brand-700 ring-brand-200"
                            : "bg-ink-50 text-ink-600 ring-ink-100"
                        }`}
                        title={e.title}
                      >
                        {deLabel(e.number)} {e.title}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Button size="sm" disabled={runBusy} onClick={() => void runAnalysis()}>
                {runBusy ? "Running…" : "Run and record"}
              </Button>
              <span className="text-xs text-ink-400">
                Every run stores its inputs, its MIP code and its SCL reference so it can be
                reproduced and challenged.
              </span>
            </div>
            <ErrorAlert message={runError} />
          </CardBody>
        </Card>

        {lastRun ? <AnalysisResult analysis={lastRun} /> : null}
      </section>

      {/* ------------------------------ float doctrine ------------------------------ */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Float ownership & concurrency doctrine
        </h2>
        {rules ? (
          <Card>
            <CardBody className="space-y-3">
              {!rules.configured ? (
                <Alert tone="warning" title="No doctrine recorded for this project">
                  {rules.explanation}
                </Alert>
              ) : null}
              <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
                <Field label="Float belongs to">
                  <Select
                    value={rules.ownership}
                    disabled={rulesBusy}
                    onChange={(e) => void saveRules({ ownership: e.target.value })}
                  >
                    {OWNERSHIP.map((o) => (
                      <option key={o} value={o}>
                        {o.replace(/_/g, " ")}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Concurrency rule">
                  <Select
                    value={rules.concurrencyRule}
                    disabled={rulesBusy}
                    onChange={(e) => void saveRules({ concurrencyRule: e.target.value })}
                  >
                    {CONCURRENCY_RULES.map((c) => (
                      <option key={c} value={c}>
                        {c.replace(/_/g, " ")}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Concurrency threshold (days)">
                  <Input
                    type="number"
                    defaultValue={rules.concurrencyThresholdDays}
                    disabled={rulesBusy}
                    onBlur={(e) => void saveRules({ concurrencyThresholdDays: Number(e.target.value) })}
                  />
                </Field>
                <Field label="Pacing tolerance (days)">
                  <Input
                    type="number"
                    defaultValue={rules.pacingThresholdDays}
                    disabled={rulesBusy}
                    onBlur={(e) => void saveRules({ pacingThresholdDays: Number(e.target.value) })}
                  />
                </Field>
              </div>
              <Field label="Contractual basis">
                <Input
                  defaultValue={rules.basis ?? ""}
                  disabled={rulesBusy}
                  placeholder="Particular condition 8.4"
                  onBlur={(e) => void saveRules({ basis: e.target.value || null })}
                />
              </Field>
              <ErrorAlert message={rulesError} />
            </CardBody>
          </Card>
        ) : (
          <Spinner />
        )}
      </section>

      {/* -------------------------------- run history -------------------------------- */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Recorded analyses</h2>
        {analyses.length === 0 ? (
          <EmptyState
            title="No analyses recorded"
            hint="A delay analysis nobody can reproduce is an opinion. Every run here stores its inputs."
          />
        ) : (
          <Card>
            <CardBody className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <Th>Analysis</Th>
                    <Th>Method</Th>
                    <Th>MIP</Th>
                    <Th align="right">Days</Th>
                    <Th>Run</Th>
                  </tr>
                </thead>
                <tbody>
                  {analyses.map((a) => (
                    <tr key={a.id} className="border-t border-ink-100 align-top">
                      <td className="px-3 py-2">
                        <div className="text-ink-800">{a.title}</div>
                        {a.summary ? <div className="text-xs text-ink-500">{a.summary}</div> : null}
                        {a.rationale ? (
                          <div className="mt-0.5 text-[11px] text-ink-400">Why: {a.rationale}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-ink-600">{a.method.replace(/_/g, " ")}</td>
                      <td className="px-3 py-2 text-ink-500">{a.mipCode ?? "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {a.resultDays === null ? (
                          <span className="text-ink-400">—</span>
                        ) : (
                          `${a.resultDays > 0 ? "+" : ""}${a.resultDays}`
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-ink-500">{formatDateTime(a.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardBody>
          </Card>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Result rendering                                                    */
/* ------------------------------------------------------------------ */

interface IapStep {
  eventId: string;
  title: string;
  incrementalDays: number;
  cumulativeDays: number;
  finishAfter: string | null;
  driving: boolean;
}

function AnalysisResult({ analysis }: { analysis: AnalysisRow }) {
  const out = (analysis.output ?? {}) as Record<string, unknown>;
  const steps = Array.isArray(out["steps"]) ? (out["steps"] as IapStep[]) : null;
  const skipped = Array.isArray(out["skipped"])
    ? (out["skipped"] as { eventId: string; title: string; reason: string }[])
    : [];
  const recs = Array.isArray(out["recommendations"])
    ? (out["recommendations"] as {
        eventId: string;
        title: string;
        party: string;
        time: string;
        money: string;
        classification: string;
        rule: string;
        explanation: string;
      }[])
    : null;
  const path = Array.isArray(out["path"])
    ? (out["path"] as { taskId: string; name?: string; startDate: string; finishDate: string }[])
    : null;
  const windows = Array.isArray(out["windows"])
    ? (out["windows"] as {
        start: string;
        end: string | null;
        movementDays: number | null;
        attributedDays: number;
        unattributedDays: number | null;
        drivingEvents: number;
        events: { title: string; driving: boolean; tiaDeltaDays: number | null; reason?: string }[];
      }[])
    : null;

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-sm font-semibold text-ink-900">{analysis.title}</div>
          <div className="text-xs text-ink-400">
            {analysis.method.replace(/_/g, " ")} · MIP {analysis.mipCode ?? "—"} ·{" "}
            {analysis.sclReference ?? "no SCL reference"}
          </div>
        </div>
        {analysis.summary ? <p className="text-sm text-ink-700">{analysis.summary}</p> : null}

        {steps ? (
          <table className="w-full text-sm">
            <thead>
              <tr>
                <Th>Event</Th>
                <Th align="right">Incremental</Th>
                <Th align="right">Cumulative</Th>
                <Th>Completion after</Th>
                <Th>Driving</Th>
              </tr>
            </thead>
            <tbody>
              {steps.map((s) => (
                <tr key={s.eventId} className="border-t border-ink-100">
                  <td className="px-3 py-1.5 text-ink-800">{s.title}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{s.incrementalDays}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{s.cumulativeDays}</td>
                  <td className="px-3 py-1.5 text-ink-600">
                    {s.finishAfter ? formatDate(s.finishAfter) : "—"}
                  </td>
                  <td className="px-3 py-1.5">
                    {s.driving ? <Badge tone="red">drives</Badge> : <Badge tone="neutral">float</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}

        {windows ? (
          <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
            {windows.map((w, i) => (
              <Card key={`${w.start}-${i}`}>
                <CardBody className="space-y-1 py-3">
                  <div className="text-sm font-medium text-ink-900">
                    {formatDate(w.start)} → {w.end ? formatDate(w.end) : "open"}
                  </div>
                  <div className="text-xs text-ink-600">
                    Completion moved{" "}
                    {w.movementDays === null ? "—" : `${w.movementDays > 0 ? "+" : ""}${w.movementDays} d`} ·{" "}
                    {w.attributedDays} d attributable · {w.drivingEvents} driving event
                    {w.drivingEvents === 1 ? "" : "s"}
                  </div>
                  {w.unattributedDays !== null && w.unattributedDays !== 0 ? (
                    <div className="text-xs text-amber-600">
                      {w.unattributedDays} d of movement is not attributable to any registered event.
                    </div>
                  ) : null}
                  <ul className="space-y-0.5">
                    {w.events.map((e) => (
                      <li key={e.title} className="text-xs text-ink-600">
                        {e.driving ? "▲" : "·"} {e.title}
                        {e.tiaDeltaDays !== null ? ` (${e.tiaDeltaDays} d)` : ""}
                        {e.reason ? <span className="text-ink-400"> — {e.reason}</span> : null}
                      </li>
                    ))}
                  </ul>
                </CardBody>
              </Card>
            ))}
          </div>
        ) : null}

        {path ? (
          <ol className="space-y-1">
            {path.map((n, i) => (
              <li key={n.taskId} className="text-sm text-ink-700">
                <span className="mr-2 text-ink-400">{i + 1}.</span>
                {n.name ?? n.taskId}
                <span className="ml-2 text-xs text-ink-400">
                  {formatDate(n.startDate)} → {formatDate(n.finishDate)}
                </span>
              </li>
            ))}
          </ol>
        ) : null}

        {recs ? (
          <table className="w-full text-sm">
            <thead>
              <tr>
                <Th>Event</Th>
                <Th>Party</Th>
                <Th>Classification</Th>
                <Th>Time</Th>
                <Th>Money</Th>
                <Th>Basis</Th>
              </tr>
            </thead>
            <tbody>
              {recs.map((r) => (
                <tr key={r.eventId} className="border-t border-ink-100 align-top">
                  <td className="px-3 py-1.5 text-ink-800">{r.title}</td>
                  <td className="px-3 py-1.5 text-ink-600">{r.party.replace(/_/g, " ")}</td>
                  <td className="px-3 py-1.5">
                    <Badge tone={r.classification === "true_concurrency" ? "amber" : "neutral"}>
                      {r.classification.replace(/_/g, " ")}
                    </Badge>
                  </td>
                  <td className="px-3 py-1.5">
                    <Badge tone={r.time === "yes" ? "green" : r.time === "shared" ? "amber" : "neutral"}>
                      {r.time}
                    </Badge>
                  </td>
                  <td className="px-3 py-1.5">
                    <Badge tone={r.money === "yes" ? "green" : r.money === "shared" ? "amber" : "neutral"}>
                      {r.money}
                    </Badge>
                  </td>
                  <td className="px-3 py-1.5 text-xs text-ink-500">
                    <div>{r.rule}</div>
                    <div className="text-ink-400">{r.explanation}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}

        {skipped.length > 0 ? (
          <Alert tone="warning" title="Events that could not be modelled">
            <ul className="ml-4 list-disc space-y-1 text-xs">
              {skipped.map((s) => (
                <li key={s.eventId}>
                  {s.title} — {s.reason}
                </li>
              ))}
            </ul>
          </Alert>
        ) : null}
      </CardBody>
    </Card>
  );
}
