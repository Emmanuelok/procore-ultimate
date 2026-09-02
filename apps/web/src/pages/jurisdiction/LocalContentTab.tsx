/**
 * Local content / ICV tab — spec Vol II Domain K / M19 (#612-615).
 *
 * Every local-content undertaking is a FLOOR: a local spend or headcount
 * percentage, an ICV score or a national quota all state a minimum, so
 * compliance is simply value ≥ target and a positive gap is the distance
 * still to travel. The server raises a `local_content_shortfall` signal the
 * moment a reading lands below its floor — the form says so, because a
 * recorded shortfall is an assurance event, not just a number.
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
  Th,
  Textarea,
} from "../../ui";
import { formatDate } from "../format";
import {
  CHART,
  Caveat,
  DetailRow,
  Drawer,
  Legend,
  METRIC_DESCRIPTIONS,
  METRIC_LABELS,
  Meter,
  StatCard,
  errorMessage,
  fmtNum,
  niceMax,
  todayISO,
  type ListResponse,
  type LocalTargetRow,
  type ReadingsResponse,
} from "./jurisdictionShared";

const METRIC_KEYS = Object.keys(METRIC_LABELS);

/** "42.5%" or "7.3 score" — the unit is part of the statement. */
function fmtValueUnit(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return unit === "%" ? `${fmtNum(value)}%` : `${fmtNum(value)} ${unit}`;
}

function statusBadge(target: LocalTargetRow) {
  if (target.compliant === null) return <Badge tone="gray">No readings</Badge>;
  return target.compliant ? (
    <Badge tone="green">At / above floor</Badge>
  ) : (
    <Badge tone="red">Shortfall</Badge>
  );
}

/* ------------------------------ readings chart ----------------------------- */

interface ChartPoint {
  date: string;
  value: number;
  breach: boolean;
}

/**
 * Readings against the floor over time. Time-scaled on the x axis when the
 * dates span a range; a dashed line marks the floor so a breach is visible as
 * geometry, not just colour. Red is reserved for readings below the floor.
 */
function ReadingsChart({
  points,
  target,
  unit,
}: {
  points: ChartPoint[];
  target: number;
  unit: string;
}) {
  if (points.length === 0) return null;
  const W = 560;
  const H = 190;
  const PAD_L = 52;
  const PAD_R = 14;
  const PAD_T = 12;
  const PAD_B = 26;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const yMax = niceMax(Math.max(target, ...points.map((p) => p.value)) * 1.1);
  const y = (v: number) => PAD_T + plotH - (v / yMax) * plotH;

  const times = points.map((p) => Date.parse(`${p.date}T00:00:00Z`));
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const span = tMax - tMin;
  const x = (i: number) =>
    PAD_L + (span > 0 ? ((times[i]! - tMin) / span) * plotW : plotW / 2);

  const ticks = [0, 0.5, 1].map((f) => f * yMax);
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(p.value)}`).join(" ");

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label="Readings against the contractual floor over time"
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} stroke={CHART.ink100} strokeWidth={1} />
            <text x={PAD_L - 6} y={y(t) + 3.5} textAnchor="end" fontSize={10} fill={CHART.ink400}>
              {fmtNum(t, 1)}
            </text>
          </g>
        ))}
        {/* the floor — the whole point of the chart */}
        <line
          x1={PAD_L}
          x2={W - PAD_R}
          y1={y(target)}
          y2={y(target)}
          stroke={CHART.amber}
          strokeWidth={1.5}
          strokeDasharray="6 4"
        >
          <title>{`Contractual floor: ${fmtNum(target)}${unit === "%" ? "%" : ` ${unit}`}`}</title>
        </line>
        {points.length > 1 ? (
          <path d={path} fill="none" stroke={CHART.brand600} strokeWidth={2} />
        ) : null}
        {points.map((p, i) => (
          <circle
            key={`${p.date}-${i}`}
            cx={x(i)}
            cy={y(p.value)}
            r={3.5}
            fill={p.breach ? CHART.red : CHART.brand600}
          >
            <title>{`${p.date}: ${fmtNum(p.value)}${unit === "%" ? "%" : ` ${unit}`}${
              p.breach ? " — below the floor" : ""
            }`}</title>
          </circle>
        ))}
        <text x={PAD_L} y={H - 8} fontSize={10} fill={CHART.ink400}>
          {points[0]!.date}
        </text>
        {points.length > 1 ? (
          <text x={W - PAD_R} y={H - 8} textAnchor="end" fontSize={10} fill={CHART.ink400}>
            {points[points.length - 1]!.date}
          </text>
        ) : null}
      </svg>
      <Legend
        items={[
          { color: CHART.brand600, label: "Reading" },
          { color: CHART.amber, label: "Contractual floor", title: "The minimum the undertaking requires" },
          { color: CHART.red, label: "Below floor", title: "Readings that breached the floor" },
        ]}
      />
    </div>
  );
}

/* --------------------------------- the tab --------------------------------- */

export default function LocalContentTab({ projectId }: { projectId: string }) {
  const base = `/api/v1/projects/${projectId}`;

  const [targets, setTargets] = useState<LocalTargetRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<ListResponse<LocalTargetRow>>(
        `${base}/local-content-targets?pageSize=200`,
      );
      setTargets(res.items);
      setTotal(res.total);
    } catch (err) {
      setTargets((prev) => prev ?? []);
      setError(errorMessage(err, "Failed to load the local content register"));
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  /* ------------------------------- add target ------------------------------ */

  const [addOpen, setAddOpen] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [fName, setFName] = useState("");
  const [fJurisdiction, setFJurisdiction] = useState("");
  const [fMetric, setFMetric] = useState("local_spend_percent");
  const [fTarget, setFTarget] = useState("");
  const [fUnit, setFUnit] = useState("");
  const [fStart, setFStart] = useState("");
  const [fEnd, setFEnd] = useState("");

  const defaultUnit = fMetric === "icv_score" ? "score" : "%";

  function openAdd() {
    setAddError(null);
    setFName("");
    setFJurisdiction("");
    setFMetric("local_spend_percent");
    setFTarget("");
    setFUnit("");
    setFStart("");
    setFEnd("");
    setAddOpen(true);
  }

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    setAddError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        name: fName.trim(),
        jurisdiction: fJurisdiction.trim(),
        metric: fMetric,
        targetValue: Number(fTarget),
      };
      if (fUnit.trim()) payload["unit"] = fUnit.trim();
      if (fStart) payload["periodStart"] = fStart;
      if (fEnd) payload["periodEnd"] = fEnd;
      await api.post<LocalTargetRow>(`${base}/local-content-targets`, payload);
      setAddOpen(false);
      await load();
    } catch (err) {
      setAddError(errorMessage(err, "Failed to record the undertaking."));
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------ detail drawer ---------------------------- */

  const [openTarget, setOpenTarget] = useState<LocalTargetRow | null>(null);
  const [readings, setReadings] = useState<ReadingsResponse | null>(null);
  const [readingsError, setReadingsError] = useState<string | null>(null);

  const loadReadings = useCallback(
    async (targetId: string) => {
      setReadingsError(null);
      try {
        const res = await api.get<ReadingsResponse>(
          `${base}/local-content-targets/${targetId}/readings`,
        );
        setReadings(res);
      } catch (err) {
        setReadings(null);
        setReadingsError(errorMessage(err, "Failed to load the readings"));
      }
    },
    [base],
  );

  function openDetail(target: LocalTargetRow) {
    setOpenTarget(target);
    setReadings(null);
    setRDate(todayISO());
    setRValue("");
    setRBasis("");
    setRecordError(null);
    void loadReadings(target.id);
  }

  function closeDetail() {
    setOpenTarget(null);
    setReadings(null);
    setReadingsError(null);
  }

  /* ------------------------------ record reading --------------------------- */

  const [rDate, setRDate] = useState(todayISO);
  const [rValue, setRValue] = useState("");
  const [rBasis, setRBasis] = useState("");
  const [recordError, setRecordError] = useState<string | null>(null);

  async function onRecord(e: FormEvent) {
    e.preventDefault();
    if (!openTarget) return;
    setRecordError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { readingDate: rDate, value: Number(rValue) };
      if (rBasis.trim()) payload["basis"] = rBasis.trim();
      await api.post(`${base}/local-content-targets/${openTarget.id}/readings`, payload);
      setRValue("");
      setRBasis("");
      await Promise.all([loadReadings(openTarget.id), load()]);
    } catch (err) {
      setRecordError(errorMessage(err, "Failed to record the reading."));
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------------- render -------------------------------- */

  if (targets === null) return <Spinner label="Loading local content undertakings…" />;

  const shortfalls = targets.filter((t) => t.compliant === false).length;
  const compliant = targets.filter((t) => t.compliant === true).length;
  const unmeasured = targets.filter((t) => t.compliant === null).length;

  // the drawer reads the LIVE row so a just-recorded reading updates its status
  const detailTarget = openTarget
    ? (targets.find((t) => t.id === openTarget.id) ?? openTarget)
    : null;

  return (
    <div>
      <ErrorAlert message={error} />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Undertakings" value={total} hint="local content / ICV floors tracked" />
        <StatCard
          label="In shortfall"
          value={shortfalls}
          tone={shortfalls > 0 ? "red" : undefined}
          hint="latest reading below the floor"
          emphasized={shortfalls > 0}
        />
        <StatCard label="At / above floor" value={compliant} tone={compliant > 0 ? "green" : undefined} />
        <StatCard
          label="Unmeasured"
          value={unmeasured}
          tone={unmeasured > 0 ? "amber" : undefined}
          hint="no reading recorded yet"
          title="An undertaking with no readings is not compliant — it is unmeasured. The register never conflates the two."
        />
      </div>

      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-xs text-ink-400">
          Every metric is a floor: compliance is value at or above the target, and a positive gap is
          the distance still to travel.
        </p>
        <Button onClick={openAdd}>Add undertaking</Button>
      </div>

      {targets.length === 0 ? (
        <EmptyState
          title="No local content undertakings yet"
          hint="Record the local spend, local headcount, ICV score or nationalisation quota floors this project's licences and contracts impose."
          action={<Button onClick={openAdd}>Add undertaking</Button>}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Undertaking</Th>
              <Th>Metric</Th>
              <Th className="text-right">Floor</Th>
              <Th className="text-right">Latest</Th>
              <Th>Progress</Th>
              <Th className="text-right">Gap</Th>
              <Th>Status</Th>
              <Th className="text-right">Readings</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {targets.map((t) => {
              const pct =
                t.latestValue !== null && t.targetValue > 0
                  ? (t.latestValue / t.targetValue) * 100
                  : null;
              return (
                <tr
                  key={t.id}
                  className="cursor-pointer hover:bg-ink-50"
                  onClick={() => openDetail(t)}
                >
                  <Td>
                    <div className="font-medium text-ink-900">{t.name}</div>
                    <div className="text-xs text-ink-400">{t.jurisdiction}</div>
                  </Td>
                  <Td title={METRIC_DESCRIPTIONS[t.metric]}>
                    <Badge tone="blue">{METRIC_LABELS[t.metric] ?? t.metric}</Badge>
                  </Td>
                  <Td className="text-right tabular-nums">{fmtValueUnit(t.targetValue, t.unit)}</Td>
                  <Td className="text-right tabular-nums">
                    {fmtValueUnit(t.latestValue, t.unit)}
                    {t.latestReading ? (
                      <div className="text-xs text-ink-400">{formatDate(t.latestReading.readingDate)}</div>
                    ) : null}
                  </Td>
                  <Td className="w-32">
                    {pct === null ? (
                      <span className="text-ink-300">—</span>
                    ) : (
                      <Meter
                        percent={pct}
                        tone={t.compliant ? "green" : "red"}
                        size="sm"
                        title={`Latest reading is ${fmtNum(pct, 1)}% of the floor`}
                      />
                    )}
                  </Td>
                  <Td className="text-right tabular-nums">
                    {t.gap === null ? (
                      <span className="text-ink-300">—</span>
                    ) : t.gap > 0 ? (
                      <span className="font-medium text-red-700">
                        {fmtValueUnit(t.gap, t.unit)} short
                      </span>
                    ) : (
                      <span className="text-emerald-700">
                        {fmtValueUnit(Math.abs(t.gap), t.unit)} clear
                      </span>
                    )}
                  </Td>
                  <Td>{statusBadge(t)}</Td>
                  <Td className="text-right tabular-nums">{t.readingCount}</Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      {/* ------------------------------ add modal ------------------------------ */}
      <Modal open={addOpen} title="Add local content undertaking" onClose={() => setAddOpen(false)}>
        <form onSubmit={onAdd} className="space-y-3">
          <ErrorAlert message={addError} />
          <Field label="Name" hint="e.g. “ICV certification floor — main works contract”">
            <Input value={fName} onChange={(e) => setFName(e.target.value)} required maxLength={300} />
          </Field>
          <Field label="Jurisdiction" hint="the state, emirate or licensing authority imposing the floor">
            <Input
              value={fJurisdiction}
              onChange={(e) => setFJurisdiction(e.target.value)}
              required
              maxLength={200}
            />
          </Field>
          <Field label="Metric" hint={METRIC_DESCRIPTIONS[fMetric]}>
            <Select value={fMetric} onChange={(e) => setFMetric(e.target.value)}>
              {METRIC_KEYS.map((m) => (
                <option key={m} value={m}>
                  {METRIC_LABELS[m]}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Floor (target value)">
              <Input
                type="number"
                step="any"
                value={fTarget}
                onChange={(e) => setFTarget(e.target.value)}
                required
              />
            </Field>
            <Field label="Unit" hint={`defaults to “${defaultUnit}”`}>
              <Input
                value={fUnit}
                onChange={(e) => setFUnit(e.target.value)}
                placeholder={defaultUnit}
                maxLength={50}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Period start (optional)">
              <Input type="date" value={fStart} onChange={(e) => setFStart(e.target.value)} />
            </Field>
            <Field label="Period end (optional)">
              <Input type="date" value={fEnd} onChange={(e) => setFEnd(e.target.value)} />
            </Field>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Add undertaking"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ----------------------------- detail drawer --------------------------- */}
      <Drawer
        open={detailTarget !== null}
        title={detailTarget?.name ?? ""}
        onClose={closeDetail}
        wide
      >
        {detailTarget ? (
          <div className="space-y-4">
            <div>
              <DetailRow label="Metric">
                <Badge tone="blue">{METRIC_LABELS[detailTarget.metric] ?? detailTarget.metric}</Badge>
                <p className="mt-1 text-xs text-ink-400">
                  {METRIC_DESCRIPTIONS[detailTarget.metric]}
                </p>
              </DetailRow>
              <DetailRow label="Jurisdiction">{detailTarget.jurisdiction}</DetailRow>
              <DetailRow label="Contractual floor">
                <span className="font-medium tabular-nums">
                  {fmtValueUnit(detailTarget.targetValue, detailTarget.unit)}
                </span>
              </DetailRow>
              <DetailRow label="Period">
                {detailTarget.periodStart || detailTarget.periodEnd
                  ? `${formatDate(detailTarget.periodStart)} → ${formatDate(detailTarget.periodEnd)}`
                  : "—"}
              </DetailRow>
              <DetailRow label="Status">{statusBadge(detailTarget)}</DetailRow>
            </div>

            <ErrorAlert message={readingsError} />

            {readings === null && !readingsError ? (
              <Spinner label="Loading readings…" />
            ) : readings ? (
              <>
                {readings.breaches > 0 ? (
                  <Caveat>
                    {readings.breaches} of {readings.total}{" "}
                    {readings.total === 1 ? "reading" : "readings"} breached the floor. Each
                    shortfall raised a <strong>local content shortfall</strong> signal for
                    assurance review — sustained shortfall typically attracts penalties, withheld
                    certificates or exclusion from future tenders.
                  </Caveat>
                ) : null}

                {readings.items.length > 0 ? (
                  <Card>
                    <CardBody>
                      <ReadingsChart
                        points={readings.items.map((r) => ({
                          date: r.readingDate,
                          value: r.value,
                          breach: !r.compliantBool,
                        }))}
                        target={readings.target.targetValue}
                        unit={readings.target.unit}
                      />
                    </CardBody>
                  </Card>
                ) : (
                  <EmptyState
                    title="No readings yet"
                    hint="This undertaking is unmeasured until its first reading is recorded."
                  />
                )}

                <form onSubmit={onRecord} className="rounded-lg bg-ink-50 p-3">
                  <p className="mb-2 text-xs font-medium text-ink-600">Record a reading</p>
                  <ErrorAlert message={recordError} />
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Reading date">
                      <Input
                        type="date"
                        value={rDate}
                        onChange={(e) => setRDate(e.target.value)}
                        required
                      />
                    </Field>
                    <Field label={`Value (${detailTarget.unit})`}>
                      <Input
                        type="number"
                        step="any"
                        value={rValue}
                        onChange={(e) => setRValue(e.target.value)}
                        required
                      />
                    </Field>
                  </div>
                  <div className="mt-3">
                    <Field
                      label="Basis of measurement (optional)"
                      hint="how the figure was measured — a reading with no stated basis is recorded as such"
                    >
                      <Textarea
                        value={rBasis}
                        onChange={(e) => setRBasis(e.target.value)}
                        className="min-h-16"
                        maxLength={10000}
                      />
                    </Field>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <p className="text-xs text-ink-400">
                      A reading below the floor immediately raises a shortfall signal.
                    </p>
                    <Button type="submit" size="sm" disabled={busy}>
                      {busy ? "Recording…" : "Record reading"}
                    </Button>
                  </div>
                </form>

                {readings.items.length > 0 ? (
                  <Table>
                    <thead>
                      <tr>
                        <Th>Date</Th>
                        <Th className="text-right">Value</Th>
                        <Th className="text-right">Gap</Th>
                        <Th>Status</Th>
                        <Th>Basis</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-100">
                      {[...readings.items].reverse().map((r) => (
                        <tr key={r.id}>
                          <Td className="whitespace-nowrap">{formatDate(r.readingDate)}</Td>
                          <Td className="text-right tabular-nums">
                            {fmtValueUnit(r.value, readings.target.unit)}
                          </Td>
                          <Td className="text-right tabular-nums">
                            {r.gap > 0 ? (
                              <span className="font-medium text-red-700">
                                {fmtValueUnit(r.gap, readings.target.unit)} short
                              </span>
                            ) : (
                              <span className="text-emerald-700">
                                {fmtValueUnit(Math.abs(r.gap), readings.target.unit)} clear
                              </span>
                            )}
                          </Td>
                          <Td>
                            {r.compliantBool ? (
                              <Badge tone="green">Compliant</Badge>
                            ) : (
                              <Badge tone="red">Breach</Badge>
                            )}
                          </Td>
                          <Td
                            className="max-w-56 truncate text-xs text-ink-500"
                            title={r.basis ?? undefined}
                          >
                            {r.basis ?? <span className="text-ink-300">not stated</span>}
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
