/**
 * Benefits register tab (spec #416-421): register with baseline → latest →
 * target progress bars (direction-aware, disbenefits tagged), realisation
 * statuses, and a row drawer with the readings sparkline (hand-rolled SVG,
 * baseline/target reference lines), the add-reading form and readings list.
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
  benefitTone,
  fmtNum,
  SectionTitle,
  todayIso,
  useUsers,
  type BenefitDetail,
  type BenefitReading,
  type BenefitRow,
  type ListResponse,
} from "./governanceShared";

const C = {
  series: "#1d60f1", // brand-600
  target: "#10b981", // emerald-500
  baseline: "#9ca3af", // gray-400
  grid: "#ebedf1", // ink-100
  axisText: "#7f8ea4", // ink-400
};

function benLabel(n: number): string {
  return `BEN-${String(n).padStart(3, "0")}`;
}

/* ------------------------------- Progress bar ------------------------------ */

function ProgressCell({ b }: { b: BenefitRow }) {
  const pct = b.progressPercent;
  const reduction = b.targetValue < b.baselineValue;
  return (
    <div className="min-w-44">
      <div className="mb-0.5 flex items-center justify-between text-[10px] tabular-nums text-ink-400">
        <span title="Baseline">{fmtNum(b.baselineValue, 2)}</span>
        <span className="font-semibold text-ink-700" title="Latest reading">
          {b.latestValue === null ? "no readings" : fmtNum(b.latestValue, 2)}
        </span>
        <span title="Target">
          {reduction ? "↓ " : ""}
          {fmtNum(b.targetValue, 2)}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-100">
        <div
          className={`h-full rounded-full ${
            pct !== null && pct >= 100
              ? "bg-emerald-500"
              : b.status === "missed"
                ? "bg-red-600"
                : b.status === "at_risk"
                  ? "bg-amber-500"
                  : "bg-brand-600"
          }`}
          style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%` }}
        />
      </div>
      <div className="mt-0.5 text-[10px] tabular-nums text-ink-400">
        {pct === null ? "—" : `${fmtNum(pct, 1)}% toward target`}
      </div>
    </div>
  );
}

/* -------------------------------- Sparkline -------------------------------- */

function ReadingsSparkline({ benefit }: { benefit: BenefitDetail }) {
  const readings = benefit.readings;
  const W = 560;
  const H = 190;
  const ML = 56;
  const MR = 16;
  const MT = 14;
  const MB = 26;
  const plotW = W - ML - MR;
  const plotH = H - MT - MB;

  const values = [
    ...readings.map((r) => r.value),
    benefit.baselineValue,
    benefit.targetValue,
  ];
  let yMin = Math.min(...values);
  let yMax = Math.max(...values);
  if (yMax - yMin < 1e-9) {
    yMin -= 1;
    yMax += 1;
  }
  const pad = (yMax - yMin) * 0.1;
  yMin -= pad;
  yMax += pad;

  const times = readings.map((r) => Date.parse(`${r.readingDate}T00:00:00Z`));
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);

  const x = (t: number) =>
    tMax - tMin < 1 ? ML + plotW / 2 : ML + ((t - tMin) / (tMax - tMin)) * plotW;
  const y = (v: number) => MT + (1 - (v - yMin) / (yMax - yMin)) * plotH;

  const ticks = [0, 1, 2, 3, 4].map((i) => yMin + ((yMax - yMin) * i) / 4);
  const points = readings.map((r, i) => ({ r, px: x(times[i]!), py: y(r.value) }));
  const path = points.map((p) => `${p.px},${p.py}`).join(" ");

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block w-full"
        role="img"
        aria-label={`Readings for ${benefit.name}`}
      >
        {/* grid + y labels */}
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={ML} y1={y(t)} x2={W - MR} y2={y(t)} stroke={C.grid} strokeWidth={1} />
            <text
              x={ML - 6}
              y={y(t) + 3}
              fontSize={9}
              textAnchor="end"
              fill={C.axisText}
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {fmtNum(t, 1)}
            </text>
          </g>
        ))}

        {/* baseline / target reference lines */}
        <line
          x1={ML}
          y1={y(benefit.baselineValue)}
          x2={W - MR}
          y2={y(benefit.baselineValue)}
          stroke={C.baseline}
          strokeWidth={1}
          strokeDasharray="4 3"
        />
        <text
          x={W - MR}
          y={y(benefit.baselineValue) - 3}
          fontSize={8}
          textAnchor="end"
          fill={C.baseline}
        >
          baseline
        </text>
        <line
          x1={ML}
          y1={y(benefit.targetValue)}
          x2={W - MR}
          y2={y(benefit.targetValue)}
          stroke={C.target}
          strokeWidth={1}
          strokeDasharray="4 3"
        />
        <text
          x={W - MR}
          y={y(benefit.targetValue) - 3}
          fontSize={8}
          textAnchor="end"
          fill={C.target}
        >
          target
        </text>

        {/* series */}
        {points.length > 1 ? (
          <polyline points={path} fill="none" stroke={C.series} strokeWidth={2} />
        ) : null}
        {points.map((p) => (
          <circle key={p.r.id} cx={p.px} cy={p.py} r={3.5} fill={C.series}>
            <title>
              {`${formatDate(p.r.readingDate)} — ${fmtNum(p.r.value, 2)} ${benefit.unit}${p.r.note ? ` (${p.r.note})` : ""}`}
            </title>
          </circle>
        ))}

        {/* x labels */}
        <text x={ML} y={H - 8} fontSize={9} fill={C.axisText}>
          {formatDate(readings[0]!.readingDate)}
        </text>
        {readings.length > 1 ? (
          <text x={W - MR} y={H - 8} fontSize={9} textAnchor="end" fill={C.axisText}>
            {formatDate(readings[readings.length - 1]!.readingDate)}
          </text>
        ) : null}
      </svg>
    </div>
  );
}

/* --------------------------------- The tab --------------------------------- */

export default function BenefitsTab({ projectId }: { projectId: string }) {
  const base = `/api/v1/projects/${projectId}`;
  const { users, nameOf } = useUsers();

  const [items, setItems] = useState<BenefitRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<ListResponse<BenefitRow>>(`${base}/benefits?pageSize=100`);
      setItems(res.items);
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : "Failed to load the benefits register");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  /* ------------------------------ create modal ------------------------------ */

  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [bName, setBName] = useState("");
  const [bUnit, setBUnit] = useState("");
  const [bBaseline, setBBaseline] = useState("");
  const [bTarget, setBTarget] = useState("");
  const [bTargetDate, setBTargetDate] = useState("");
  const [bOwner, setBOwner] = useState("");
  const [bMethod, setBMethod] = useState("");
  const [bDescription, setBDescription] = useState("");
  const [bDisbenefit, setBDisbenefit] = useState(false);

  function openCreate() {
    setCreateError(null);
    setBName("");
    setBUnit("");
    setBBaseline("");
    setBTarget("");
    setBTargetDate("");
    setBOwner("");
    setBMethod("");
    setBDescription("");
    setBDisbenefit(false);
    setCreateOpen(true);
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setBusy(true);
    try {
      const created = await api.post<BenefitRow>(`${base}/benefits`, {
        name: bName.trim(),
        unit: bUnit.trim(),
        baselineValue: Number(bBaseline) || 0,
        targetValue: Number(bTarget) || 0,
        targetDate: bTargetDate || null,
        ownerId: bOwner || null,
        measurementMethod: bMethod.trim() || null,
        description: bDescription.trim() || null,
        isDisbenefit: bDisbenefit,
      });
      setCreateOpen(false);
      await load();
      setSelectedId(created.id);
    } catch (err) {
      setCreateError(err instanceof ApiClientError ? err.message : "Failed to create the benefit.");
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------------- drawer --------------------------------- */

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BenefitDetail | null>(null);
  const [drawerError, setDrawerError] = useState<string | null>(null);
  const [rDate, setRDate] = useState(todayIso());
  const [rValue, setRValue] = useState("");
  const [rNote, setRNote] = useState("");

  const loadDetail = useCallback(async () => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    try {
      setDetail(await api.get<BenefitDetail>(`${base}/benefits/${selectedId}`));
    } catch (err) {
      setDrawerError(err instanceof Error ? err.message : "Failed to load the benefit");
    }
  }, [base, selectedId]);

  useEffect(() => {
    setDrawerError(null);
    setRDate(todayIso());
    setRValue("");
    setRNote("");
    void loadDetail();
  }, [loadDetail]);

  async function onAddReading(e: FormEvent) {
    e.preventDefault();
    if (!detail) return;
    setDrawerError(null);
    setBusy(true);
    try {
      await api.post(`${base}/benefits/${detail.id}/readings`, {
        readingDate: rDate,
        value: Number(rValue) || 0,
        note: rNote.trim() || null,
      });
      setRValue("");
      setRNote("");
      await Promise.all([loadDetail(), load()]);
    } catch (err) {
      setDrawerError(err instanceof ApiClientError ? err.message : "Failed to add the reading.");
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------------- render ---------------------------------- */

  if (items === null) return <Spinner />;

  return (
    <div>
      <ErrorAlert message={error} />

      {items.length === 0 ? (
        <EmptyState
          title="No benefits registered"
          hint="Register the benefits (and disbenefits) this investment must realise — with a baseline, a target and an owner — then track readings over time."
          action={<Button onClick={openCreate}>Register a benefit</Button>}
        />
      ) : (
        <>
          <div className="mb-2 flex items-center justify-between">
            <SectionTitle>Benefits register</SectionTitle>
            <Button size="sm" variant="secondary" onClick={openCreate}>
              Register a benefit
            </Button>
          </div>
          <Table>
            <thead>
              <tr>
                <Th>No.</Th>
                <Th>Benefit</Th>
                <Th>Unit</Th>
                <Th>Baseline → latest → target</Th>
                <Th>Status</Th>
                <Th>Owner</Th>
                <Th>Target date</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {items.map((b) => (
                <tr
                  key={b.id}
                  className="cursor-pointer hover:bg-ink-50/60"
                  onClick={() => setSelectedId(b.id)}
                >
                  <Td className="whitespace-nowrap font-mono text-xs text-ink-500">
                    {benLabel(b.number)}
                  </Td>
                  <Td>
                    <span className="font-medium text-ink-900">{b.name}</span>
                    {b.isDisbenefit === 1 ? (
                      <span className="ml-2 inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-700">
                        disbenefit
                      </span>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap text-xs text-ink-500">{b.unit}</Td>
                  <Td>
                    <ProgressCell b={b} />
                  </Td>
                  <Td>
                    <Badge tone={benefitTone(b.status)}>{humanize(b.status)}</Badge>
                  </Td>
                  <Td className="whitespace-nowrap text-xs">{nameOf(b.ownerId)}</Td>
                  <Td className="whitespace-nowrap text-xs">{formatDate(b.targetDate)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}

      {/* ------------------------------ create modal ------------------------------ */}
      <Modal open={createOpen} title="Register a benefit" onClose={() => setCreateOpen(false)} wide>
        <ErrorAlert message={createError} />
        <form onSubmit={onCreate} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Name">
              <Input
                required
                value={bName}
                onChange={(e) => setBName(e.target.value)}
                placeholder="e.g. Journey time saving"
              />
            </Field>
            <Field label="Unit">
              <Input
                required
                value={bUnit}
                onChange={(e) => setBUnit(e.target.value)}
                placeholder="e.g. minutes, £k p.a., tCO2e"
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Baseline value">
              <Input
                type="number"
                step="any"
                required
                value={bBaseline}
                onChange={(e) => setBBaseline(e.target.value)}
              />
            </Field>
            <Field label="Target value">
              <Input
                type="number"
                step="any"
                required
                value={bTarget}
                onChange={(e) => setBTarget(e.target.value)}
              />
            </Field>
            <Field label="Target date">
              <Input
                type="date"
                value={bTargetDate}
                onChange={(e) => setBTargetDate(e.target.value)}
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Owner">
              <Select value={bOwner} onChange={(e) => setBOwner(e.target.value)}>
                <option value="">Unassigned</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Measurement method">
              <Input
                value={bMethod}
                onChange={(e) => setBMethod(e.target.value)}
                placeholder="How this benefit is measured"
              />
            </Field>
          </div>
          <Field label="Description">
            <Textarea
              value={bDescription}
              onChange={(e) => setBDescription(e.target.value)}
              className="min-h-14"
            />
          </Field>
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input
              type="checkbox"
              className="h-4 w-4 accent-brand-600"
              checked={bDisbenefit}
              onChange={(e) => setBDisbenefit(e.target.checked)}
            />
            This is a disbenefit — the measure should be driven DOWN from its baseline
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Registering…" : "Register benefit"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* --------------------------------- drawer --------------------------------- */}
      {selectedId ? (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-ink-950/40"
          onClick={() => setSelectedId(null)}
        >
          <div
            className="h-full w-full max-w-2xl overflow-y-auto bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            {detail === null ? (
              <Spinner />
            ) : (
              <>
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div>
                    <div className="mb-1 flex items-center gap-2">
                      <span className="font-mono text-xs text-ink-400">
                        {benLabel(detail.number)}
                      </span>
                      {detail.isDisbenefit === 1 ? (
                        <span className="inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-700">
                          disbenefit
                        </span>
                      ) : null}
                      <Badge tone={benefitTone(detail.status)}>{humanize(detail.status)}</Badge>
                    </div>
                    <h2 className="text-base font-semibold text-ink-900">{detail.name}</h2>
                    <p className="mt-0.5 text-xs text-ink-500">
                      {fmtNum(detail.baselineValue, 2)} → {fmtNum(detail.targetValue, 2)}{" "}
                      {detail.unit}
                      {detail.targetDate ? ` by ${formatDate(detail.targetDate)}` : ""} · owner{" "}
                      {nameOf(detail.ownerId)}
                      {detail.progressPercent !== null
                        ? ` · ${fmtNum(detail.progressPercent, 1)}% realised`
                        : ""}
                    </p>
                    {detail.measurementMethod ? (
                      <p className="mt-0.5 text-xs text-ink-400">
                        Measured by: {detail.measurementMethod}
                      </p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedId(null)}
                    className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
                    aria-label="Close"
                  >
                    ✕
                  </button>
                </div>

                <ErrorAlert message={drawerError} />

                <div className="mb-4">
                  <SectionTitle>Realisation over time</SectionTitle>
                  {detail.readings.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-ink-200 px-4 py-8 text-center text-xs text-ink-400">
                      No readings yet — record the first reading below to start tracking
                      realisation against the baseline and target.
                    </div>
                  ) : (
                    <ReadingsSparkline benefit={detail} />
                  )}
                </div>

                <div className="mb-4 rounded-lg bg-ink-50 p-3">
                  <SectionTitle>Add reading</SectionTitle>
                  <form onSubmit={onAddReading} className="flex flex-wrap items-end gap-2">
                    <Field label="Date">
                      <Input
                        type="date"
                        required
                        value={rDate}
                        onChange={(e) => setRDate(e.target.value)}
                        className="w-38"
                      />
                    </Field>
                    <Field label={`Value (${detail.unit})`}>
                      <Input
                        type="number"
                        step="any"
                        required
                        value={rValue}
                        onChange={(e) => setRValue(e.target.value)}
                        className="w-32"
                      />
                    </Field>
                    <div className="min-w-40 flex-1">
                      <Field label="Note">
                        <Input value={rNote} onChange={(e) => setRNote(e.target.value)} />
                      </Field>
                    </div>
                    <Button type="submit" disabled={busy}>
                      {busy ? "Adding…" : "Add"}
                    </Button>
                  </form>
                </div>

                <div>
                  <SectionTitle>Readings</SectionTitle>
                  {detail.readings.length === 0 ? (
                    <p className="text-xs text-ink-400">None recorded.</p>
                  ) : (
                    <div className="divide-y divide-ink-100 rounded-lg ring-1 ring-ink-100">
                      {[...detail.readings].reverse().map((r: BenefitReading) => (
                        <div
                          key={r.id}
                          className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                        >
                          <div className="min-w-0">
                            <span className="tabular-nums text-ink-800">
                              {formatDate(r.readingDate)}
                            </span>
                            {r.note ? (
                              <span className="ml-2 text-xs text-ink-400">{r.note}</span>
                            ) : null}
                          </div>
                          <span className="whitespace-nowrap font-medium tabular-nums text-ink-900">
                            {fmtNum(r.value, 2)} {detail.unit}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
