/**
 * Local content / ICV tab — spec Vol II Domain K / M19 (#612-615).
 *
 * Every local-content undertaking is a FLOOR: a local spend or headcount
 * percentage, an ICV score or a national quota all state a minimum, so
 * compliance is simply value ≥ target and a positive gap is the distance
 * still to travel.
 *
 * Three things this view insists on:
 *
 *  - A reading can be DERIVED from the invoice and worker registers rather
 *    than keyed (#612-613). The derivation is shown before it is committed,
 *    with the records behind it, so the number a regulator is shown can be
 *    walked back to the transactions that produced it. A metric the platform
 *    cannot derive says why rather than offering a zero.
 *  - A reading is never edited. A correction SUPERSEDES it, and the withdrawn
 *    figure stays visible, because "what was reported before" is exactly what
 *    a verification exercise is looking for.
 *  - The shortfall FINDING belongs to the scheduled detector, not to whoever
 *    keyed the reading. This form records a measurement; assurance raises the
 *    signal, as the system actor.
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
  type ComputedReadingResponse,
  type ListResponse,
  type LocalContentMetricRule,
  type LocalReadingRow,
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

/** Where a figure came from — keyed by hand, derived, or certified. */
function sourceBadge(source: LocalReadingRow["source"]) {
  if (source === "computed")
    return (
      <Badge tone="blue" title="Derived from the project's own invoice and worker registers">
        Derived
      </Badge>
    );
  if (source === "certified")
    return (
      <Badge tone="green" title="Taken from an accredited certificate">
        Certified
      </Badge>
    );
  return (
    <Badge tone="gray" title="Keyed by hand — the basis is whatever the recorder stated">
      Keyed
    </Badge>
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
  /*
   * The metric library is the server's, not the form's: which metrics can be
   * derived from platform records — and the derivation each one uses — is a
   * property of the engine, so the UI asks rather than asserting.
   */
  const [metricRules, setMetricRules] = useState<LocalContentMetricRule[]>([]);

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

  useEffect(() => {
    let cancelled = false;
    void api
      .get<{ metrics: LocalContentMetricRule[] }>("/api/v1/local-content/metrics")
      .then((res) => {
        if (!cancelled) setMetricRules(res.metrics);
      })
      // the register works without the library; only the derive affordance
      // depends on it, and it fails alone
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const ruleFor = useCallback(
    (metric: string): LocalContentMetricRule | null =>
      metricRules.find((r) => r.key === metric) ?? null,
    [metricRules],
  );

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
    setDerived(null);
    setDeriveError(null);
    void loadReadings(target.id);
  }

  function closeDetail() {
    setOpenTarget(null);
    setReadings(null);
    setReadingsError(null);
    setDerived(null);
    setDeriveError(null);
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

  /* ------------------------- derive from the records ----------------------- */

  const [derived, setDerived] = useState<ComputedReadingResponse | null>(null);
  const [deriveError, setDeriveError] = useState<string | null>(null);
  const [deriving, setDeriving] = useState(false);

  async function onDerive(commit: boolean) {
    if (!openTarget) return;
    setDeriveError(null);
    setDeriving(true);
    try {
      const res = await api.post<ComputedReadingResponse>(
        `${base}/local-content-targets/${openTarget.id}/compute`,
        { readingDate: rDate, commit },
      );
      setDerived(res);
      if (res.committed) {
        await Promise.all([loadReadings(openTarget.id), load()]);
      }
    } catch (err) {
      setDerived(null);
      setDeriveError(errorMessage(err, "Failed to derive the reading from project records."));
    } finally {
      setDeriving(false);
    }
  }

  /* ---------------------------- correct a reading -------------------------- */

  const [correcting, setCorrecting] = useState<
    (LocalReadingRow & { gap: number; compliantBool: boolean }) | null
  >(null);
  const [cDate, setCDate] = useState("");
  const [cValue, setCValue] = useState("");
  const [cBasis, setCBasis] = useState("");
  const [cReason, setCReason] = useState("");
  const [correctError, setCorrectError] = useState<string | null>(null);

  function openCorrect(reading: LocalReadingRow & { gap: number; compliantBool: boolean }) {
    setCorrectError(null);
    setCDate(reading.readingDate);
    setCValue(String(reading.value));
    setCBasis(reading.basis ?? "");
    setCReason("");
    setCorrecting(reading);
  }

  async function onCorrect(e: FormEvent) {
    e.preventDefault();
    if (!correcting || !openTarget) return;
    setCorrectError(null);
    setBusy(true);
    try {
      await api.post(`${base}/local-content-readings/${correcting.id}/supersede`, {
        readingDate: cDate,
        value: Number(cValue),
        basis: cBasis.trim(),
        reason: cReason.trim(),
      });
      setCorrecting(null);
      await Promise.all([loadReadings(openTarget.id), load()]);
    } catch (err) {
      setCorrectError(errorMessage(err, "Failed to record the correction."));
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------- edit / retire target ------------------------ */

  const [editOpen, setEditOpen] = useState(false);
  const [eName, setEName] = useState("");
  const [eTarget, setETarget] = useState("");
  const [eUnit, setEUnit] = useState("");
  const [eStart, setEStart] = useState("");
  const [eEnd, setEEnd] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  function openEdit(target: LocalTargetRow) {
    setEditError(null);
    setEName(target.name);
    setETarget(String(target.targetValue));
    setEUnit(target.unit);
    setEStart(target.periodStart ?? "");
    setEEnd(target.periodEnd ?? "");
    setEditOpen(true);
  }

  async function onEdit(e: FormEvent) {
    e.preventDefault();
    if (!openTarget) return;
    setEditError(null);
    setBusy(true);
    try {
      await api.patch(`${base}/local-content-targets/${openTarget.id}`, {
        name: eName.trim(),
        targetValue: Number(eTarget),
        unit: eUnit.trim(),
        periodStart: eStart === "" ? null : eStart,
        periodEnd: eEnd === "" ? null : eEnd,
      });
      setEditOpen(false);
      await Promise.all([loadReadings(openTarget.id), load()]);
    } catch (err) {
      setEditError(errorMessage(err, "Failed to update the undertaking."));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!openTarget) return;
    setBusy(true);
    setError(null);
    try {
      await api.del(`${base}/local-content-targets/${openTarget.id}`);
      closeDetail();
      await load();
    } catch (err) {
      // the API refuses to delete an undertaking with a measurement history;
      // that refusal is the answer, so it is shown rather than swallowed
      setError(errorMessage(err, "Failed to remove the undertaking."));
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

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" onClick={() => openEdit(detailTarget)}>
                Edit undertaking
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => void onDelete()}
                title={
                  detailTarget.readingCount > 0
                    ? "An undertaking with a measurement history cannot be removed — close the period instead"
                    : "Remove this undertaking"
                }
              >
                Remove
              </Button>
            </div>

            <ErrorAlert message={readingsError} />

            {readings === null && !readingsError ? (
              <Spinner label="Loading readings…" />
            ) : readings ? (
              <>
                {readings.breaches > 0 ? (
                  <Caveat>
                    {readings.breaches} of {readings.total}{" "}
                    {readings.total === 1 ? "reading that stands" : "readings that stand"} sit below
                    the floor. The scheduled detector raises a{" "}
                    <strong>local content shortfall</strong> signal against the current reading —
                    sustained shortfall typically attracts penalties, withheld certificates or
                    exclusion from future tenders.
                  </Caveat>
                ) : null}
                {readings.supersededCount > 0 ? (
                  <p className="text-xs text-ink-400">
                    {readings.supersededCount} withdrawn{" "}
                    {readings.supersededCount === 1 ? "reading is" : "readings are"} kept below for
                    the audit trail and excluded from every count.
                  </p>
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
                      A reading below the floor is picked up by the scheduled local-content
                      detector, which raises the shortfall signal as the system actor.
                    </p>
                    <Button type="submit" size="sm" disabled={busy}>
                      {busy ? "Recording…" : "Record reading"}
                    </Button>
                  </div>
                </form>

                {/* ------------------------ derive from records ---------------------- */}
                <div className="rounded-lg bg-brand-50 p-3 ring-1 ring-brand-100">
                  <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-xs font-medium text-ink-700">
                      Derive this reading from project records
                      <span className="ml-1.5 font-normal text-ink-400">(#612-613)</span>
                    </p>
                    {ruleFor(detailTarget.metric)?.computable ? (
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={deriving}
                          onClick={() => void onDerive(false)}
                        >
                          {deriving ? "Deriving…" : "Preview derivation"}
                        </Button>
                        <Button
                          size="sm"
                          disabled={deriving || derived === null || derived.value === null}
                          onClick={() => void onDerive(true)}
                          title={
                            derived === null
                              ? "Preview the derivation first — a figure is not committed unseen"
                              : "Record the derived figure as a reading"
                          }
                        >
                          Commit as reading
                        </Button>
                      </div>
                    ) : null}
                  </div>
                  <p className="text-xs text-ink-500">
                    {ruleFor(detailTarget.metric)?.derivation ??
                      (metricRules.length === 0
                        ? "The metric library could not be loaded, so derivation is unavailable here. Record the reading manually."
                        : "This metric is not derivable from platform records — record it manually, or register the certificate that carries it.")}
                  </p>
                  <ErrorAlert message={deriveError} />
                  {derived ? (
                    <div className="mt-2 rounded border border-ink-100 bg-white p-2.5 text-xs">
                      {derived.value === null ? (
                        <p className="text-amber-700">
                          <span className="font-medium">Not available.</span>{" "}
                          {derived.unavailableReason ??
                            "The records this metric is derived from are not present for the period."}
                        </p>
                      ) : (
                        <>
                          <p className="text-sm font-semibold tabular-nums text-ink-900">
                            {fmtValueUnit(derived.value, detailTarget.unit)}{" "}
                            {derived.compliant ? (
                              <Badge tone="green">At / above floor</Badge>
                            ) : (
                              <Badge tone="red">Shortfall</Badge>
                            )}
                            {derived.committed ? (
                              <Badge tone="blue" className="ml-1.5">
                                Recorded
                              </Badge>
                            ) : (
                              <Badge tone="gray" className="ml-1.5">
                                Preview only
                              </Badge>
                            )}
                          </p>
                          <p className="mt-1 text-ink-600">{derived.basis}</p>
                          <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-ink-500">
                            {Object.entries(derived.inputs).map(([k, v]) => (
                              <div key={k} className="flex justify-between gap-2">
                                <dt className="truncate">{k}</dt>
                                <dd className="tabular-nums text-ink-700">
                                  {typeof v === "number" || typeof v === "string"
                                    ? String(v)
                                    : JSON.stringify(v)}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        </>
                      )}
                    </div>
                  ) : null}
                </div>

                {readings.items.length > 0 ? (
                  <Table>
                    <thead>
                      <tr>
                        <Th>Date</Th>
                        <Th className="text-right">Value</Th>
                        <Th className="text-right">Gap</Th>
                        <Th>Status</Th>
                        <Th>Source</Th>
                        <Th>Basis</Th>
                        <Th className="text-right">Correct</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-100">
                      {[...readings.items].reverse().map((r) => (
                        <tr key={r.id} className={r.superseded ? "opacity-60" : undefined}>
                          <Td className="whitespace-nowrap">{formatDate(r.readingDate)}</Td>
                          <Td className="text-right tabular-nums">
                            <span className={r.superseded ? "line-through" : undefined}>
                              {fmtValueUnit(r.value, readings.target.unit)}
                            </span>
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
                            {r.superseded ? (
                              <Badge
                                tone="gray"
                                title="Withdrawn by a later correction — kept for the audit trail, excluded from every count"
                              >
                                Superseded
                              </Badge>
                            ) : r.compliantBool ? (
                              <Badge tone="green">Compliant</Badge>
                            ) : (
                              <Badge tone="red">Breach</Badge>
                            )}
                          </Td>
                          <Td>{sourceBadge(r.source)}</Td>
                          <Td
                            className="max-w-56 truncate text-xs text-ink-500"
                            title={r.basis ?? undefined}
                          >
                            {r.basis ?? <span className="text-ink-300">not stated</span>}
                          </Td>
                          <Td className="text-right">
                            {r.superseded ? (
                              <span className="text-xs text-ink-300">—</span>
                            ) : (
                              <button
                                type="button"
                                className="text-xs font-medium text-brand-700 hover:text-brand-800"
                                onClick={() => openCorrect(r)}
                              >
                                Correct
                              </button>
                            )}
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

      {/* ---------------------------- correction modal -------------------------- */}
      <Modal
        open={correcting !== null}
        title="Correct a reported figure"
        onClose={() => setCorrecting(null)}
      >
        <form onSubmit={onCorrect} className="space-y-3">
          <ErrorAlert message={correctError} />
          <p className="text-xs text-ink-500">
            A reported local-content figure is a regulatory statement, so it is never edited in
            place: this records a NEW reading that supersedes{" "}
            {correcting ? (
              <span className="font-medium text-ink-700">
                {formatDate(correcting.readingDate)} —{" "}
                {fmtValueUnit(correcting.value, detailTarget?.unit ?? "%")}
              </span>
            ) : null}
            , and the withdrawn figure stays on file.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Corrected reading date">
              <Input
                type="date"
                value={cDate}
                onChange={(e) => setCDate(e.target.value)}
                required
              />
            </Field>
            <Field label={`Corrected value (${detailTarget?.unit ?? ""})`}>
              <Input
                type="number"
                step="any"
                value={cValue}
                onChange={(e) => setCValue(e.target.value)}
                required
              />
            </Field>
          </div>
          <Field label="Basis of measurement">
            <Textarea
              value={cBasis}
              onChange={(e) => setCBasis(e.target.value)}
              className="min-h-16"
              maxLength={10000}
              required
            />
          </Field>
          <Field label="Why the earlier figure was wrong" hint="recorded in the ledger">
            <Textarea
              value={cReason}
              onChange={(e) => setCReason(e.target.value)}
              className="min-h-16"
              maxLength={10000}
              required
            />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={() => setCorrecting(null)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy || cBasis.trim() === "" || cReason.trim() === "" || cValue === ""}
            >
              {busy ? "Recording…" : "Supersede reading"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ------------------------------- edit modal ----------------------------- */}
      <Modal open={editOpen} title="Edit undertaking" onClose={() => setEditOpen(false)}>
        <form onSubmit={onEdit} className="space-y-3">
          <ErrorAlert message={editError} />
          <p className="text-xs text-ink-500">
            The metric and jurisdiction are what the undertaking IS; changing either would make the
            measurement history describe a different promise, so they are fixed. Revising the floor
            or the period is ledgered with its before and after.
          </p>
          <Field label="Name">
            <Input value={eName} onChange={(e) => setEName(e.target.value)} required maxLength={200} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Floor (target value)">
              <Input
                type="number"
                step="any"
                value={eTarget}
                onChange={(e) => setETarget(e.target.value)}
                required
              />
            </Field>
            <Field label="Unit">
              <Input value={eUnit} onChange={(e) => setEUnit(e.target.value)} maxLength={20} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Period start">
              <Input type="date" value={eStart} onChange={(e) => setEStart(e.target.value)} />
            </Field>
            <Field label="Period end">
              <Input type="date" value={eEnd} onChange={(e) => setEEnd(e.target.value)} />
            </Field>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || eName.trim() === "" || eTarget === ""}>
              {busy ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
