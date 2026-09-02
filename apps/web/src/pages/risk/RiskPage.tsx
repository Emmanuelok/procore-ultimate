/**
 * Quantitative risk workspace — spec Vol II Domain H / M13 (#447-473):
 * - Register: 5×5 pre/post heatmap, scored risk table, create/edit modal,
 *   mitigation drawer (#447-454).
 * - Simulation: seeded QCRA/QSRA runs, S-curve + tornado + criticality,
 *   simulation history with the reproducibility verifier (#457-466).
 * - Contingency: confidence-linked contingencies, drawdown discipline and
 *   the drawdown curve (#469-473).
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useParams } from "react-router-dom";
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
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { formatDate, formatDateTime, formatMoney, humanize } from "../format";
import Heatmap, { cellScores, type HeatCell } from "./Heatmap";
import RiskModal from "./RiskModal";
import RiskDrawer from "./RiskDrawer";
import { DrawdownCurve, SCurve, Tornado, type TornadoRow } from "./SimulationCharts";
import {
  bandChipClass,
  bandTone,
  categoryTone,
  fmtNum,
  fmtSimValue,
  isQuantified,
  preScore,
  postScore,
  riskStatusTone,
  rskLabel,
  viewFromDetail,
  type ContingencyRow,
  type DrawdownCurveData,
  type ListResponse,
  type RerunResult,
  type RiskRow,
  type ScheduleLite,
  type ScheduleTaskLite,
  type SimDetail,
  type SimListItem,
  type SimView,
  type TaskOption,
  type UserLite,
} from "./riskShared";

const todayIso = () => new Date().toISOString().slice(0, 10);

function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: ReactNode;
  tone?: "red" | "amber" | "green";
  hint?: string;
}) {
  const valueCls =
    tone === "red"
      ? "text-red-700"
      : tone === "amber"
        ? "text-amber-700"
        : tone === "green"
          ? "text-emerald-700"
          : "text-ink-900";
  return (
    <Card>
      <CardBody className="px-4 py-3">
        <div className={`text-xl font-bold tabular-nums ${valueCls}`}>{value}</div>
        <div className="mt-0.5 text-xs font-medium uppercase tracking-wide text-ink-400">{label}</div>
        {hint ? <div className="mt-0.5 text-[11px] text-ink-400">{hint}</div> : null}
      </CardBody>
    </Card>
  );
}

/* ================================ REGISTER ================================ */

function RegisterTab({
  base,
  projectId,
  users,
  tasks,
}: {
  base: string;
  projectId: string;
  users: UserLite[];
  tasks: TaskOption[];
}) {
  const [items, setItems] = useState<RiskRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [heatMode, setHeatMode] = useState<"pre" | "post">("pre");
  const [cell, setCell] = useState<HeatCell | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editRisk, setEditRisk] = useState<RiskRow | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [drawerBump, setDrawerBump] = useState(0);

  const PAGE_SIZE = 100;

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<ListResponse<RiskRow>>(
        `${base}/risks?page=${page}&pageSize=${PAGE_SIZE}`,
      );
      setItems(res.items ?? []);
      setTotal(res.total ?? 0);
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : "Failed to load the risk register");
    }
  }, [base, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = (items ?? []).filter((r) => {
    if (!cell) return true;
    const c = cellScores(r, heatMode);
    return c.probability === cell.probability && c.impact === cell.impact;
  });
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const ownerName = (id: string | null) =>
    id ? (users.find((u) => u.id === id)?.name ?? id) : "—";

  return (
    <div>
      <ErrorAlert message={error} />
      {items === null ? (
        <Spinner label="Loading the risk register…" />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr]">
          {/* heatmap */}
          <Card className="self-start">
            <CardBody className="py-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                  Heatmap
                </span>
                <div className="inline-flex overflow-hidden rounded-md ring-1 ring-ink-200">
                  {(["pre", "post"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setHeatMode(m)}
                      className={`px-2.5 py-1 text-xs font-medium ${
                        heatMode === m ? "bg-brand-600 text-white" : "bg-white text-ink-600 hover:bg-ink-50"
                      }`}
                    >
                      {m === "pre" ? "Pre" : "Post"}
                    </button>
                  ))}
                </div>
              </div>
              <Heatmap risks={items} mode={heatMode} selected={cell} onSelect={setCell} />
              <p className="mt-2 text-[11px] leading-4 text-ink-400">
                Cell shade = number of risks. Click a cell to filter the table.
                {heatMode === "post"
                  ? " Post view plots residual positions — risks without post scores stay at their pre position."
                  : ""}
              </p>
              {cell ? (
                <button
                  type="button"
                  className="mt-1 text-xs font-medium text-brand-700 hover:text-brand-800"
                  onClick={() => setCell(null)}
                >
                  Clear filter (P{cell.probability} × I{cell.impact})
                </button>
              ) : null}
            </CardBody>
          </Card>

          {/* table */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm text-ink-500">
                {filtered.length} of {total} risk{total === 1 ? "" : "s"}
                {cell ? ` at P${cell.probability} × I${cell.impact} (${heatMode})` : ""}
              </span>
              <Button
                onClick={() => {
                  setEditRisk(null);
                  setModalOpen(true);
                }}
              >
                New risk
              </Button>
            </div>
            {items.length === 0 ? (
              <EmptyState
                title="No risks on the register yet"
                hint="Score risks 1-5 for probability and impact — quantify them with a distribution to unlock Monte Carlo simulation."
                action={
                  <Button
                    onClick={() => {
                      setEditRisk(null);
                      setModalOpen(true);
                    }}
                  >
                    Add the first risk
                  </Button>
                }
              />
            ) : (
              <>
                <Table>
                  <thead>
                    <tr>
                      <Th>No.</Th>
                      <Th>Title</Th>
                      <Th>Category</Th>
                      <Th>Score</Th>
                      <Th>Owner</Th>
                      <Th className="text-center">Quantified</Th>
                      <Th>Status</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {filtered.map((r) => {
                      const pre = preScore(r);
                      const post = postScore(r);
                      return (
                        <tr
                          key={r.id}
                          className="cursor-pointer hover:bg-ink-50/60"
                          onClick={() => {
                            setDrawerId(r.id);
                            setDrawerBump((b) => b + 1);
                          }}
                        >
                          <Td className="whitespace-nowrap font-mono text-xs text-ink-500">
                            {rskLabel(r.number)}
                          </Td>
                          <Td className="max-w-[280px]">
                            <span className="line-clamp-1 font-medium text-ink-900">{r.title}</span>
                          </Td>
                          <Td>
                            <Badge tone={categoryTone(r.category)}>{humanize(r.category)}</Badge>
                          </Td>
                          <Td className="whitespace-nowrap">
                            <span
                              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-bold tabular-nums ${bandChipClass[bandTone(pre)]}`}
                              title={`P${r.probabilityScore} × I${r.impactScore}`}
                            >
                              {pre}
                            </span>
                            {post != null ? (
                              <span className="ml-1.5 text-xs text-ink-400">
                                →{" "}
                                <span
                                  className={`inline-flex items-center rounded-full px-1.5 py-0.5 font-bold tabular-nums ${bandChipClass[bandTone(post)]}`}
                                  title={`Post-mitigation P${r.postProbabilityScore} × I${r.postImpactScore}`}
                                >
                                  {post}
                                </span>
                              </span>
                            ) : null}
                          </Td>
                          <Td className="whitespace-nowrap text-xs">{ownerName(r.ownerId)}</Td>
                          <Td className="text-center">
                            {isQuantified(r) ? (
                              <span className="font-semibold text-emerald-600" title="Occurrence probability and cost impact are set — included in QCRA">
                                ✓
                              </span>
                            ) : (
                              <span className="text-ink-300">—</span>
                            )}
                          </Td>
                          <Td>
                            <Badge tone={riskStatusTone(r.status)}>{humanize(r.status)}</Badge>
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
                {totalPages > 1 ? (
                  <div className="mt-3 flex items-center justify-end gap-2 text-sm text-ink-500">
                    <span>
                      page {page} of {totalPages}
                    </span>
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
                ) : null}
              </>
            )}
          </div>
        </div>
      )}

      {drawerId ? (
        <RiskDrawer
          key={`${drawerId}:${drawerBump}`}
          projectId={projectId}
          riskId={drawerId}
          users={users}
          onClose={() => setDrawerId(null)}
          onChanged={() => void load()}
          onEdit={(r) => {
            setEditRisk(r);
            setModalOpen(true);
          }}
        />
      ) : null}

      {/* rendered after the drawer so editing from the drawer stacks on top */}
      <RiskModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        projectId={projectId}
        risk={editRisk}
        users={users}
        tasks={tasks}
        onSaved={() => {
          void load();
          setDrawerBump((b) => b + 1);
        }}
      />
    </div>
  );
}

/* =============================== SIMULATION =============================== */

function SimulationTab({
  base,
  schedules,
  taskNames,
}: {
  base: string;
  schedules: ScheduleLite[];
  taskNames: Record<string, string>;
}) {
  const [kind, setKind] = useState<"qcra" | "qsra">("qcra");
  const [iterations, setIterations] = useState("5000");
  const [seed, setSeed] = useState("");
  const [scheduleId, setScheduleId] = useState("");
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [view, setView] = useState<SimView | null>(null);

  const [history, setHistory] = useState<SimListItem[] | null>(null);
  const [histError, setHistError] = useState<string | null>(null);
  const [verify, setVerify] = useState<Record<string, "running" | "yes" | "no">>({});

  const loadHistory = useCallback(async () => {
    setHistError(null);
    try {
      const res = await api.get<ListResponse<SimListItem>>(
        `${base}/risk/simulations?page=1&pageSize=25`,
      );
      setHistory(res.items ?? []);
    } catch (err) {
      setHistory([]);
      setHistError(err instanceof Error ? err.message : "Failed to load simulation history");
    }
  }, [base]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  function switchKind(k: "qcra" | "qsra") {
    setKind(k);
    setIterations(k === "qcra" ? "5000" : "1000");
  }

  async function onRun() {
    setRunError(null);
    setRunning(true);
    try {
      const body: Record<string, unknown> = { iterations: Number(iterations) || undefined };
      if (seed.trim() !== "") body["seed"] = Number(seed);
      if (kind === "qsra" && scheduleId) body["scheduleId"] = scheduleId;
      const res = await api.post<SimView & Record<string, unknown>>(
        `${base}/risk/simulations/${kind}`,
        body,
      );
      setView({ ...res, kind });
      await loadHistory();
    } catch (err) {
      setRunError(err instanceof ApiClientError ? err.message : "Simulation failed.");
    } finally {
      setRunning(false);
    }
  }

  async function onView(id: string) {
    setHistError(null);
    try {
      const sim = await api.get<SimDetail>(`${base}/risk-simulations/${id}`);
      const v = viewFromDetail(sim);
      if (v) setView(v);
      else setHistError("Stored simulation record is missing its summary.");
    } catch (err) {
      setHistError(err instanceof Error ? err.message : "Failed to load the simulation");
    }
  }

  async function onVerify(id: string) {
    setVerify((m) => ({ ...m, [id]: "running" }));
    try {
      const res = await api.post<RerunResult>(`${base}/risk-simulations/${id}/rerun`);
      setVerify((m) => ({ ...m, [id]: res.reproduced ? "yes" : "no" }));
    } catch {
      setVerify((m) => ({ ...m, [id]: "no" }));
    }
  }

  const taskName = (id: string) => taskNames[id] ?? `task ${id.slice(0, 10)}…`;

  const tornadoRows: TornadoRow[] =
    view?.kind === "qcra"
      ? (view.perRisk ?? []).map((r) => ({
          id: r.id,
          name: r.name,
          value: r.correlationWithTotal,
          annotation: `${r.correlationWithTotal.toFixed(2)} · EV ${fmtSimValue(r.expectedValue, "qcra")}`,
        }))
      : [...(view?.perTask ?? [])]
          .filter((t) => t.sensitivity > 0)
          .sort((a, b) => b.sensitivity - a.sensitivity)
          .map((t) => ({
            id: t.id,
            name: taskName(t.id),
            value: t.sensitivity,
            annotation: t.sensitivity.toFixed(2),
          }));

  const exposureDays =
    view?.kind === "qsra" && view.deterministicDurationDays != null
      ? Math.round(view.summary.percentiles.p80 - view.deterministicDurationDays)
      : null;

  const criticality =
    view?.kind === "qsra"
      ? [...(view.perTask ?? [])].sort((a, b) => b.criticalityIndex - a.criticalityIndex).slice(0, 15)
      : [];

  return (
    <div className="space-y-4">
      {/* run panel */}
      <Card>
        <CardBody className="py-3">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <span className="mb-1 block text-xs font-medium text-ink-600">Analysis</span>
              <div className="inline-flex overflow-hidden rounded-md ring-1 ring-ink-200">
                {(["qcra", "qsra"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => switchKind(k)}
                    className={`px-3 py-2 text-sm font-medium ${
                      kind === k ? "bg-brand-600 text-white" : "bg-white text-ink-600 hover:bg-ink-50"
                    }`}
                  >
                    {k === "qcra" ? "QCRA · cost" : "QSRA · schedule"}
                  </button>
                ))}
              </div>
            </div>
            <Field label="Iterations">
              <Input
                type="number"
                min={kind === "qcra" ? 100 : 50}
                max={kind === "qcra" ? 20000 : 5000}
                value={iterations}
                onChange={(e) => setIterations(e.target.value)}
                className="w-28 tabular-nums"
              />
            </Field>
            <Field label="Seed" hint="Same seed + inputs reproduce the run exactly.">
              <div className="flex gap-1.5">
                <Input
                  type="number"
                  min={0}
                  value={seed}
                  onChange={(e) => setSeed(e.target.value)}
                  placeholder="auto"
                  className="w-32 tabular-nums"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setSeed(String(Math.floor(Math.random() * 2_147_483_647)))}
                >
                  Random
                </Button>
              </div>
            </Field>
            {kind === "qsra" ? (
              <Field label="Schedule">
                <Select value={scheduleId} onChange={(e) => setScheduleId(e.target.value)}>
                  <option value="">Active schedule</option>
                  {schedules.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {s.isActive ? " (active)" : ""}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Button onClick={() => void onRun()} disabled={running}>
              {running ? "Simulating…" : "Run simulation"}
            </Button>
          </div>
          <ErrorAlert message={runError} />
        </CardBody>
      </Card>

      {/* results */}
      {view ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
            <Stat label="Mean" value={fmtSimValue(view.summary.mean, view.kind)} />
            <Stat label="P50" value={fmtSimValue(view.summary.percentiles.p50, view.kind)} />
            <Stat label="P80" value={fmtSimValue(view.summary.percentiles.p80, view.kind)} />
            <Stat label="P90" value={fmtSimValue(view.summary.percentiles.p90, view.kind)} />
            {view.kind === "qsra" && exposureDays != null ? (
              <Stat
                label="Schedule risk exposure"
                value={`${exposureDays >= 0 ? "+" : ""}${exposureDays} days`}
                tone={exposureDays > 0 ? "amber" : "green"}
                hint={`deterministic ${view.deterministicDurationDays}d vs P80${
                  view.completionDates?.["p80"] ? ` · P80 finish ${formatDate(view.completionDates["p80"])}` : ""
                }`}
              />
            ) : view.contingencyAt ? (
              <Stat
                label="Contingency at P80"
                value={fmtSimValue(view.contingencyAt.p80, "qcra")}
                hint="over a deterministic base of 0"
              />
            ) : null}
          </div>

          <Card>
            <CardBody className="py-3">
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                  Cumulative probability (S-curve) — {view.kind.toUpperCase()}, {fmtNum(view.iterations)}{" "}
                  iterations, seed {view.seed}
                </span>
                <span className="text-[11px] text-ink-400">
                  Correlation between risks is not modelled — the spread may understate reality.
                </span>
              </div>
              <SCurve summary={view.summary} kind={view.kind} />
            </CardBody>
          </Card>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Card>
              <CardBody className="py-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
                  Tornado — {view.kind === "qcra" ? "risk drivers by correlation with total" : "task duration sensitivity"}
                </div>
                <Tornado
                  rows={tornadoRows}
                  title={view.kind === "qcra" ? "Risk drivers" : "Task sensitivity"}
                />
              </CardBody>
            </Card>
            {view.kind === "qsra" ? (
              <Card>
                <CardBody className="py-3">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
                    Criticality index — share of iterations on the critical path
                  </div>
                  {criticality.length === 0 ? (
                    <p className="py-4 text-center text-xs text-ink-400">No task data.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {criticality.map((t) => (
                        <div key={t.id} className="flex items-center gap-2 text-xs">
                          <span className="w-44 truncate text-ink-700" title={taskName(t.id)}>
                            {taskName(t.id)}
                          </span>
                          <span className="relative h-3.5 flex-1 overflow-hidden rounded bg-ink-100">
                            <span
                              className={`absolute inset-y-0 left-0 rounded ${
                                t.criticalityIndex >= 0.99 ? "bg-red-600" : "bg-brand-600"
                              }`}
                              style={{ width: `${Math.max(1, t.criticalityIndex * 100)}%` }}
                            />
                          </span>
                          <span className="w-11 text-right tabular-nums text-ink-600">
                            {Math.round(t.criticalityIndex * 100)}%
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </CardBody>
              </Card>
            ) : view.perRisk && view.perRisk.length > 0 ? (
              <Card>
                <CardBody className="py-3">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
                    Per-risk contribution
                  </div>
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-ink-100 text-xs">
                      <thead>
                        <tr className="text-left text-[11px] uppercase tracking-wide text-ink-400">
                          <th className="py-1.5 pr-3">Risk</th>
                          <th className="py-1.5 pr-3 text-right">Expected value</th>
                          <th className="py-1.5 pr-3 text-right">Occurred</th>
                          <th className="py-1.5 text-right">Corr. w/ total</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-ink-100">
                        {view.perRisk.map((r) => (
                          <tr key={r.id}>
                            <td className="max-w-[220px] truncate py-1.5 pr-3 text-ink-800" title={r.name}>
                              {r.name}
                            </td>
                            <td className="py-1.5 pr-3 text-right tabular-nums">
                              {fmtSimValue(r.expectedValue, "qcra")}
                            </td>
                            <td className="py-1.5 pr-3 text-right tabular-nums">
                              {Math.round(r.occurredShare * 100)}%
                            </td>
                            <td className="py-1.5 text-right tabular-nums">
                              {r.correlationWithTotal.toFixed(3)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardBody>
              </Card>
            ) : null}
          </div>
        </div>
      ) : (
        <EmptyState
          title="No simulation loaded"
          hint="Run a QCRA over the quantified risks, or a QSRA over a schedule — or open a past run from the history below."
        />
      )}

      {/* history */}
      <Card>
        <CardBody className="py-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
            Simulation history
          </div>
          <ErrorAlert message={histError} />
          {history === null ? (
            <Spinner label="Loading history…" />
          ) : history.length === 0 ? (
            <p className="py-4 text-center text-xs text-ink-400">No simulations recorded yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-ink-100 text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-ink-400">
                    <th className="py-1.5 pr-3">Kind</th>
                    <th className="py-1.5 pr-3">Run</th>
                    <th className="py-1.5 pr-3 text-right">Iterations</th>
                    <th className="py-1.5 pr-3 text-right">Seed</th>
                    <th className="py-1.5 pr-3 text-right">P80</th>
                    <th className="py-1.5 pr-3">Reproducibility</th>
                    <th className="py-1.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {history.map((s) => {
                    const k = s.kind === "qsra" ? "qsra" : "qcra";
                    const p80 = s.summary?.percentiles?.["p80"];
                    const v = verify[s.id];
                    return (
                      <tr key={s.id}>
                        <td className="py-2 pr-3">
                          <Badge tone={k === "qcra" ? "blue" : "violet"}>{k.toUpperCase()}</Badge>
                        </td>
                        <td className="whitespace-nowrap py-2 pr-3 text-xs text-ink-600">
                          {formatDateTime(s.createdAt)}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">{fmtNum(s.iterations)}</td>
                        <td className="py-2 pr-3 text-right font-mono text-xs tabular-nums">{s.seed}</td>
                        <td className="py-2 pr-3 text-right font-medium tabular-nums">
                          {p80 != null ? fmtSimValue(p80, k) : "—"}
                        </td>
                        <td className="py-2 pr-3">
                          {v === "yes" ? (
                            <Badge tone="green">Reproduced exactly</Badge>
                          ) : v === "no" ? (
                            <Badge tone="red">MISMATCH</Badge>
                          ) : v === "running" ? (
                            <span className="text-xs text-ink-400">Verifying…</span>
                          ) : (
                            <Button variant="ghost" size="sm" onClick={() => void onVerify(s.id)}>
                              Verify reproducibility
                            </Button>
                          )}
                        </td>
                        <td className="py-2 text-right">
                          <Button variant="secondary" size="sm" onClick={() => void onView(s.id)}>
                            View
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

/* =============================== CONTINGENCY ============================== */

function meterClass(fraction: number): string {
  if (fraction < 0.2) return "bg-red-600";
  if (fraction < 0.5) return "bg-amber-500";
  return "bg-emerald-500";
}

function ContingencyTab({ base }: { base: string }) {
  const [items, setItems] = useState<ContingencyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [curves, setCurves] = useState<Record<string, DrawdownCurveData | "loading">>({});
  const [openCurves, setOpenCurves] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<ListResponse<ContingencyRow>>(
        `${base}/contingencies?page=1&pageSize=100`,
      );
      setItems(res.items ?? []);
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : "Failed to load contingencies");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadCurve = useCallback(
    async (id: string) => {
      setCurves((m) => ({ ...m, [id]: "loading" }));
      try {
        const curve = await api.get<DrawdownCurveData>(`${base}/contingencies/${id}/drawdown-curve`);
        setCurves((m) => ({ ...m, [id]: curve }));
      } catch {
        setCurves((m) => {
          const { [id]: _gone, ...rest } = m;
          return rest;
        });
      }
    },
    [base],
  );

  function toggleCurve(id: string) {
    setOpenCurves((m) => ({ ...m, [id]: !m[id] }));
    if (!curves[id]) void loadCurve(id);
  }

  /* -------- create modal -------- */
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cName, setCName] = useState("");
  const [cAmount, setCAmount] = useState("");
  const [cCurrency, setCCurrency] = useState("GBP");
  const [cReserve, setCReserve] = useState(false);
  const [cSimId, setCSimId] = useState("");
  const [cConfidence, setCConfidence] = useState("");
  const [sims, setSims] = useState<SimListItem[]>([]);

  async function openCreate() {
    setCreateError(null);
    setCName("");
    setCAmount("");
    setCCurrency("GBP");
    setCReserve(false);
    setCSimId("");
    setCConfidence("");
    setCreateOpen(true);
    try {
      const res = await api.get<ListResponse<SimListItem>>(
        `${base}/risk/simulations?page=1&pageSize=50&kind=qcra`,
      );
      setSims((res.items ?? []).filter((s) => s.summary?.percentiles));
    } catch {
      setSims([]);
    }
  }

  function prefillAmount(simId: string, confidence: string) {
    if (!simId || !confidence) return;
    const sim = sims.find((s) => s.id === simId);
    const v = sim?.summary?.percentiles?.[confidence];
    if (v != null) setCAmount(String(Math.round(v * 100) / 100));
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        name: cName.trim(),
        amount: Number(cAmount),
        isManagementReserve: cReserve,
      };
      const cur = cCurrency.trim().toUpperCase();
      if (cur) payload["currency"] = cur;
      if (cConfidence) payload["confidenceLevel"] = cConfidence;
      if (cSimId) payload["simulationId"] = cSimId;
      await api.post(`${base}/contingencies`, payload);
      setCreateOpen(false);
      await load();
    } catch (err) {
      setCreateError(err instanceof ApiClientError ? err.message : "Failed to create the contingency.");
    } finally {
      setBusy(false);
    }
  }

  /* -------- drawdown modal -------- */
  const [drawFor, setDrawFor] = useState<ContingencyRow | null>(null);
  const [drawError, setDrawError] = useState<string | null>(null);
  const [dAmount, setDAmount] = useState("");
  const [dReason, setDReason] = useState("");
  const [dRiskId, setDRiskId] = useState("");
  const [dDate, setDDate] = useState(todayIso());
  const [riskOptions, setRiskOptions] = useState<RiskRow[]>([]);

  async function openDraw(c: ContingencyRow) {
    setDrawError(null);
    setDAmount("");
    setDReason("");
    setDRiskId("");
    setDDate(todayIso());
    setDrawFor(c);
    try {
      const res = await api.get<ListResponse<RiskRow>>(`${base}/risks?page=1&pageSize=200`);
      setRiskOptions(res.items ?? []);
    } catch {
      setRiskOptions([]);
    }
  }

  async function onDraw(e: FormEvent) {
    e.preventDefault();
    if (!drawFor) return;
    setDrawError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        amount: Number(dAmount),
        reason: dReason.trim(),
        drawnAt: dDate,
      };
      if (dRiskId) payload["riskId"] = dRiskId;
      await api.post(`${base}/contingencies/${drawFor.id}/drawdowns`, payload);
      const id = drawFor.id;
      setDrawFor(null);
      await load();
      if (openCurves[id]) void loadCurve(id);
    } catch (err) {
      // 409 carries the "exceeds the remaining contingency" message — surface it verbatim
      setDrawError(err instanceof ApiClientError ? err.message : "Failed to record the drawdown.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm text-ink-500">
          {items ? `${items.length} contingenc${items.length === 1 ? "y" : "ies"}` : ""}
        </span>
        <Button onClick={() => void openCreate()}>New contingency</Button>
      </div>
      <ErrorAlert message={error} />
      {items === null ? (
        <Spinner label="Loading contingencies…" />
      ) : items.length === 0 ? (
        <EmptyState
          title="No contingencies yet"
          hint="Set a contingency at a simulated confidence level (e.g. the QCRA P80) and draw it down against realised risks."
          action={<Button onClick={() => void openCreate()}>Create the first contingency</Button>}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {items.map((c) => {
            const fraction = c.amount > 0 ? c.remaining / c.amount : 0;
            const curve = curves[c.id];
            return (
              <Card key={c.id} className={fraction < 0.2 ? "border-l-4 border-l-red-500" : ""}>
                <CardBody className="py-3">
                  <div className="mb-1.5 flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-ink-900">{c.name}</span>
                    {c.confidenceLevel ? (
                      <Badge tone="blue">set at {c.confidenceLevel.toUpperCase()}</Badge>
                    ) : null}
                    {c.isManagementReserve ? <Badge tone="violet">Management reserve</Badge> : null}
                    {fraction < 0.2 ? <Badge tone="red">Below 20%</Badge> : null}
                  </div>
                  <div className="mb-2 flex items-baseline gap-3">
                    <span className="text-xl font-bold tabular-nums text-ink-900">
                      {formatMoney(c.amount, c.currency)}
                    </span>
                    <span className="text-xs text-ink-500">
                      drawn {formatMoney(c.drawnTotal, c.currency)} · remaining{" "}
                      <strong className={fraction < 0.2 ? "text-red-700" : "text-ink-700"}>
                        {formatMoney(c.remaining, c.currency)}
                      </strong>
                    </span>
                  </div>
                  {/* remaining meter */}
                  <div
                    className="relative mb-3 h-2.5 overflow-hidden rounded-full bg-ink-100"
                    role="meter"
                    aria-valuemin={0}
                    aria-valuemax={c.amount}
                    aria-valuenow={c.remaining}
                    aria-label={`Remaining ${c.name}`}
                    title={`${Math.round(fraction * 100)}% remaining`}
                  >
                    <div
                      className={`absolute inset-y-0 left-0 rounded-full ${meterClass(fraction)}`}
                      style={{ width: `${Math.min(100, Math.max(0, fraction * 100))}%` }}
                    />
                    {/* 20% threshold tick */}
                    <div className="absolute inset-y-0 left-[20%] w-px bg-ink-400/60" />
                  </div>
                  <div className="flex gap-2">
                    <Button variant="secondary" size="sm" onClick={() => void openDraw(c)}>
                      Draw down
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => toggleCurve(c.id)}>
                      {openCurves[c.id] ? "Hide drawdown curve" : "Drawdown curve"}
                    </Button>
                  </div>
                  {openCurves[c.id] ? (
                    <div className="mt-3 border-t border-ink-100 pt-3">
                      {curve === "loading" || !curve ? (
                        <Spinner label="Loading curve…" />
                      ) : (
                        <DrawdownCurve curve={curve} />
                      )}
                    </div>
                  ) : null}
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}

      {/* create modal */}
      <Modal open={createOpen} title="New contingency" onClose={() => setCreateOpen(false)} wide>
        <ErrorAlert message={createError} />
        <form onSubmit={onCreate} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Name">
              <Input
                required
                value={cName}
                onChange={(e) => setCName(e.target.value)}
                placeholder="Construction risk contingency"
              />
            </Field>
            <label className="mt-6 flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={cReserve}
                onChange={(e) => setCReserve(e.target.checked)}
                className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
              />
              <span className="text-sm text-ink-700">Management reserve (held apart)</span>
            </label>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Source simulation"
              hint="Optional — link a QCRA run and pick a confidence to prefill the amount."
            >
              <Select
                value={cSimId}
                onChange={(e) => {
                  setCSimId(e.target.value);
                  prefillAmount(e.target.value, cConfidence);
                }}
              >
                <option value="">None</option>
                {sims.map((s) => (
                  <option key={s.id} value={s.id}>
                    QCRA · {formatDateTime(s.createdAt)} · P80{" "}
                    {s.summary?.percentiles?.["p80"] != null
                      ? fmtNum(s.summary.percentiles["p80"])
                      : "—"}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Confidence level">
              <Select
                value={cConfidence}
                onChange={(e) => {
                  setCConfidence(e.target.value);
                  prefillAmount(cSimId, e.target.value);
                }}
              >
                <option value="">Not stated</option>
                {["p50", "p80", "p90"].map((p) => (
                  <option key={p} value={p}>
                    {p.toUpperCase()}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Amount">
              <Input
                type="number"
                min={0.01}
                step="any"
                required
                value={cAmount}
                onChange={(e) => setCAmount(e.target.value)}
                className="tabular-nums"
              />
            </Field>
            <Field label="Currency">
              <Input
                value={cCurrency}
                maxLength={3}
                onChange={(e) => setCCurrency(e.target.value)}
                placeholder="GBP"
              />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create contingency"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* drawdown modal */}
      <Modal
        open={drawFor !== null}
        title={drawFor ? `Draw down — ${drawFor.name}` : "Draw down"}
        onClose={() => setDrawFor(null)}
      >
        <ErrorAlert message={drawError} />
        {drawFor ? (
          <form onSubmit={onDraw} className="space-y-4">
            <p className="text-xs text-ink-500">
              Remaining:{" "}
              <strong className="tabular-nums">{formatMoney(drawFor.remaining, drawFor.currency)}</strong>{" "}
              of {formatMoney(drawFor.amount, drawFor.currency)}
            </p>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Amount">
                <Input
                  type="number"
                  min={0.01}
                  step="any"
                  required
                  value={dAmount}
                  onChange={(e) => setDAmount(e.target.value)}
                  className="tabular-nums"
                />
              </Field>
              <Field label="Date">
                <Input type="date" required value={dDate} onChange={(e) => setDDate(e.target.value)} />
              </Field>
            </div>
            <Field label="Realised risk" hint="Optional — the risk this drawdown pays for.">
              <Select value={dRiskId} onChange={(e) => setDRiskId(e.target.value)}>
                <option value="">None</option>
                {riskOptions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {rskLabel(r.number)} — {r.title}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reason">
              <Textarea
                required
                className="min-h-12"
                value={dReason}
                onChange={(e) => setDReason(e.target.value)}
                placeholder="Ground obstruction encountered at pile group B…"
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setDrawFor(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Recording…" : "Record drawdown"}
              </Button>
            </div>
          </form>
        ) : null}
      </Modal>
    </div>
  );
}

/* ================================== PAGE ================================== */

const TABS = [
  { id: "register", label: "Register" },
  { id: "simulation", label: "Simulation" },
  { id: "contingency", label: "Contingency" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function RiskPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const base = `/api/v1/projects/${projectId}`;
  const [tab, setTab] = useState<TabId>("register");

  const [users, setUsers] = useState<UserLite[]>([]);
  const [schedules, setSchedules] = useState<ScheduleLite[]>([]);
  const [tasks, setTasks] = useState<TaskOption[]>([]);
  const [taskNames, setTaskNames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<ListResponse<UserLite>>("/api/v1/company/users?pageSize=200");
        if (!cancelled) setUsers(res.items ?? []);
      } catch {
        // owner pickers simply show ids
      }
    })();
    (async () => {
      try {
        const list = await api.get<ListResponse<ScheduleLite>>(`${base}/schedules?pageSize=20`);
        const scheds = list.items ?? [];
        if (cancelled) return;
        setSchedules(scheds);
        const details = await Promise.all(
          scheds.slice(0, 8).map((s) =>
            api
              .get<{ tasks: ScheduleTaskLite[] }>(`${base}/schedules/${s.id}`)
              .then((d) => ({ schedule: s, tasks: d.tasks ?? [] }))
              .catch(() => ({ schedule: s, tasks: [] as ScheduleTaskLite[] })),
          ),
        );
        if (cancelled) return;
        const opts: TaskOption[] = [];
        const names: Record<string, string> = {};
        for (const d of details) {
          for (const t of d.tasks) {
            opts.push({ id: t.id, name: t.name, scheduleName: d.schedule.name });
            names[t.id] = t.name;
          }
        }
        setTasks(opts);
        setTaskNames(names);
      } catch {
        // schedule link picker stays empty
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base, projectId]);

  if (!projectId) return null;

  return (
    <div>
      <PageHeader
        title="Quantitative Risk"
        subtitle="Risk register, Monte Carlo cost & schedule simulation, and contingency drawdown discipline"
      />

      {/* tabs */}
      <div className="mb-4 flex gap-1 border-b border-ink-200">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`-mb-px rounded-t-md px-3.5 py-2 text-sm font-medium transition-colors ${
              tab === t.id
                ? "border border-ink-200 border-b-white bg-white text-brand-700"
                : "text-ink-500 hover:text-ink-800"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "register" ? (
        <RegisterTab base={base} projectId={projectId} users={users} tasks={tasks} />
      ) : tab === "simulation" ? (
        <SimulationTab base={base} schedules={schedules} taskNames={taskNames} />
      ) : (
        <ContingencyTab base={base} />
      )}
    </div>
  );
}
