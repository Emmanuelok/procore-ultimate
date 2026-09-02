/**
 * Hand-rolled SVG charts for the risk workspace (no chart libs):
 * - SCurve: cumulative probability curve built from the histogram cumsum,
 *   with the histogram bars ghosted behind and P50/P80/P90 markers (#461).
 * - Tornado: horizontal driver ranking (correlation / sensitivity) (#462).
 * - DrawdownCurve: cumulative-drawn vs remaining step lines per
 *   contingency, dates on x, 20% exhaustion threshold marked (#471-473).
 */
import { fmtNum, fmtSimValue, type DrawdownCurveData, type SimSummary } from "./riskShared";

const BRAND = "#1d60f1";
const BRAND_LIGHT = "#d9eaff";
const GRID = "#ebedf1";
const AXIS_INK = "#7f8ea4";
const MARKER_INK = "#4b5a72";
const RED = "#dc2626";

/* --------------------------------- S-curve -------------------------------- */

export function SCurve({ summary, kind }: { summary: SimSummary; kind: "qcra" | "qsra" }) {
  const W = 640;
  const H = 240;
  const PAD = { top: 26, right: 14, bottom: 26, left: 44 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const hist = summary.histogram ?? [];
  const totalCount = hist.reduce((s, b) => s + b.count, 0);
  const lo = summary.min;
  const hi = summary.max;
  const span = hi - lo || 1;
  const x = (v: number) => PAD.left + ((v - lo) / span) * plotW;
  const y = (frac: number) => PAD.top + (1 - frac) * plotH;

  if (hist.length === 0 || totalCount === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-xs text-ink-400">
        No distribution data to plot.
      </div>
    );
  }

  // cumulative curve through each bin's upper edge
  let cum = 0;
  const pts: Array<[number, number]> = [[x(hist[0]!.from), y(0)]];
  for (const b of hist) {
    cum += b.count;
    pts.push([x(b.to), y(cum / totalCount)]);
  }
  const line = pts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(" ");

  const maxBin = Math.max(1, ...hist.map((b) => b.count));
  const markers: Array<{ label: string; value: number }> = [
    { label: "P50", value: summary.percentiles.p50 },
    { label: "P80", value: summary.percentiles.p80 },
    { label: "P90", value: summary.percentiles.p90 },
  ];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label="Cumulative probability S-curve with P50, P80 and P90 markers"
    >
      {/* horizontal grid at 0/25/50/75/100% */}
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <g key={f}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(f)} y2={y(f)} stroke={GRID} strokeWidth={1} />
          <text
            x={PAD.left - 6}
            y={y(f) + 3}
            textAnchor="end"
            fontSize={9}
            fill={AXIS_INK}
            className="tabular-nums"
          >
            {Math.round(f * 100)}%
          </text>
        </g>
      ))}
      {/* ghosted histogram behind the curve */}
      {hist.map((b, i) => {
        const bw = Math.max(1, x(b.to) - x(b.from) - 1);
        const bh = (b.count / maxBin) * plotH * 0.55;
        return (
          <rect
            key={i}
            x={x(b.from) + 0.5}
            y={PAD.top + plotH - bh}
            width={bw}
            height={bh}
            fill={BRAND_LIGHT}
            opacity={0.55}
          >
            <title>{`${fmtSimValue(b.from, kind)} – ${fmtSimValue(b.to, kind)}: ${b.count} iterations`}</title>
          </rect>
        );
      })}
      {/* percentile markers */}
      {markers.map((m) => (
        <g key={m.label}>
          <line
            x1={x(m.value)}
            x2={x(m.value)}
            y1={PAD.top - 2}
            y2={PAD.top + plotH}
            stroke={MARKER_INK}
            strokeWidth={1}
            strokeDasharray="3 3"
          />
          <text
            x={x(m.value)}
            y={PAD.top - 8}
            textAnchor="middle"
            fontSize={9}
            fontWeight={600}
            fill={MARKER_INK}
            className="tabular-nums"
          >
            {m.label} {fmtSimValue(m.value, kind)}
          </text>
        </g>
      ))}
      {/* the S-curve itself */}
      <polyline points={line} fill="none" stroke={BRAND} strokeWidth={2}>
        <title>Cumulative probability of the simulated total</title>
      </polyline>
      {/* x labels */}
      <text x={PAD.left} y={H - 8} textAnchor="start" fontSize={9} fill={AXIS_INK} className="tabular-nums">
        {fmtSimValue(lo, kind)}
      </text>
      <text
        x={W - PAD.right}
        y={H - 8}
        textAnchor="end"
        fontSize={9}
        fill={AXIS_INK}
        className="tabular-nums"
      >
        {fmtSimValue(hi, kind)}
      </text>
      <text x={PAD.left + plotW / 2} y={H - 8} textAnchor="middle" fontSize={9} fill={AXIS_INK}>
        {kind === "qcra" ? "Total risk cost" : "Project duration (days)"}
      </text>
    </svg>
  );
}

/* --------------------------------- tornado -------------------------------- */

export interface TornadoRow {
  id: string;
  name: string;
  /** bar length driver, 0..1 (|correlation| or sensitivity) */
  value: number;
  /** right-hand annotation, already formatted */
  annotation: string;
}

export function Tornado({ rows, title }: { rows: TornadoRow[]; title: string }) {
  const shown = rows.slice(0, 12);
  if (shown.length === 0) {
    return <div className="py-6 text-center text-xs text-ink-400">No drivers to rank.</div>;
  }
  const maxV = Math.max(0.0001, ...shown.map((r) => r.value));
  const ROW_H = 24;
  const W = 640;
  const NAME_W = 190;
  const VAL_W = 78;
  const H = shown.length * ROW_H + 8;
  const barMax = W - NAME_W - VAL_W - 16;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={title}>
      {shown.map((r, i) => {
        const yTop = 4 + i * ROW_H;
        const bw = Math.max(2, (r.value / maxV) * barMax);
        return (
          <g key={r.id}>
            <text
              x={NAME_W}
              y={yTop + ROW_H / 2 + 3}
              textAnchor="end"
              fontSize={10}
              fill="#3e495d"
            >
              {r.name.length > 30 ? `${r.name.slice(0, 29)}…` : r.name}
              <title>{r.name}</title>
            </text>
            <line
              x1={NAME_W + 8}
              x2={NAME_W + 8}
              y1={yTop + 1}
              y2={yTop + ROW_H - 3}
              stroke={GRID}
              strokeWidth={1}
            />
            <rect
              x={NAME_W + 8}
              y={yTop + 3}
              width={bw}
              height={ROW_H - 10}
              rx={3}
              fill={BRAND}
              opacity={0.55 + 0.45 * (r.value / maxV)}
            >
              <title>{`${r.name}: ${r.value.toFixed(3)}`}</title>
            </rect>
            <text
              x={NAME_W + 12 + bw}
              y={yTop + ROW_H / 2 + 3}
              textAnchor="start"
              fontSize={9.5}
              fill="#5f708a"
              className="tabular-nums"
            >
              {r.annotation}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ------------------------------ drawdown curve ----------------------------- */

export function DrawdownCurve({ curve }: { curve: DrawdownCurveData }) {
  const W = 620;
  const H = 190;
  const PAD = { top: 14, right: 64, bottom: 26, left: 46 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const points = curve.points ?? [];
  if (points.length === 0) {
    return (
      <div className="py-4 text-center text-xs text-ink-400">
        No drawdowns recorded yet — the full {fmtNum(curve.amount)} {curve.currency} remains.
      </div>
    );
  }

  const t = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
  const t0 = t(points[0]!.date);
  const t1 = Math.max(t(points[points.length - 1]!.date), t0 + 1);
  const spanT = t1 - t0 || 1;
  const x = (iso: string) => PAD.left + ((t(iso) - t0) / spanT) * plotW;
  const yMax = Math.max(curve.amount, ...points.map((p) => p.drawn)) || 1;
  const y = (v: number) => PAD.top + (1 - Math.max(0, v) / yMax) * plotH;

  // step paths: hold the previous level until each drawdown date, then jump
  function stepPath(getter: (p: (typeof points)[number]) => number, startValue: number): string {
    let d = `M ${PAD.left.toFixed(1)} ${y(startValue).toFixed(1)}`;
    let prev = startValue;
    for (const p of points) {
      const px = x(p.date);
      d += ` L ${px.toFixed(1)} ${y(prev).toFixed(1)} L ${px.toFixed(1)} ${y(getter(p)).toFixed(1)}`;
      prev = getter(p);
    }
    d += ` L ${(W - PAD.right).toFixed(1)} ${y(prev).toFixed(1)}`;
    return d;
  }

  const remainingPath = stepPath((p) => p.remaining, curve.amount);
  const drawnPath = stepPath((p) => p.drawn, 0);
  const threshold = 0.2 * curve.amount;
  const lastRemaining = points[points.length - 1]!.remaining;
  const lastDrawn = points[points.length - 1]!.drawn;

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Drawdown curve for ${curve.name}`}
      >
        {/* grid: 0, half, full */}
        {[0, yMax / 2, yMax].map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke={GRID} strokeWidth={1} />
            <text
              x={PAD.left - 5}
              y={y(v) + 3}
              textAnchor="end"
              fontSize={9}
              fill={AXIS_INK}
              className="tabular-nums"
            >
              {fmtSimValue(v, "qcra")}
            </text>
          </g>
        ))}
        {/* 20% exhaustion threshold — genuinely critical, hence red */}
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={y(threshold)}
          y2={y(threshold)}
          stroke={RED}
          strokeWidth={1}
          strokeDasharray="4 3"
        >
          <title>{`20% exhaustion threshold: ${fmtNum(threshold)} ${curve.currency}`}</title>
        </line>
        <text x={W - PAD.right + 4} y={y(threshold) + 3} fontSize={8.5} fill={RED}>
          20%
        </text>
        {/* cumulative drawn (secondary) */}
        <path d={drawnPath} fill="none" stroke={AXIS_INK} strokeWidth={1.5} strokeDasharray="5 3">
          <title>Cumulative drawn</title>
        </path>
        {/* remaining (primary) */}
        <path d={remainingPath} fill="none" stroke={lastRemaining < threshold ? RED : BRAND} strokeWidth={2}>
          <title>Remaining contingency</title>
        </path>
        {/* drawdown event dots */}
        {points.map((p, i) => (
          <circle key={i} cx={x(p.date)} cy={y(p.remaining)} r={3} fill={lastRemaining < threshold && i === points.length - 1 ? RED : BRAND}>
            <title>{`${p.date}: −${fmtNum(p.amount)} (${p.reason}) → ${fmtNum(p.remaining)} remaining`}</title>
          </circle>
        ))}
        {/* end labels */}
        <text
          x={W - PAD.right + 4}
          y={y(lastRemaining) + 3}
          fontSize={9}
          fontWeight={600}
          fill={lastRemaining < threshold ? RED : BRAND}
          className="tabular-nums"
        >
          {fmtSimValue(lastRemaining, "qcra")}
        </text>
        <text
          x={W - PAD.right + 4}
          y={y(lastDrawn) + (Math.abs(y(lastDrawn) - y(lastRemaining)) < 10 ? 12 : 3)}
          fontSize={9}
          fill={AXIS_INK}
          className="tabular-nums"
        >
          {fmtSimValue(lastDrawn, "qcra")}
        </text>
        {/* x-axis dates */}
        <text x={PAD.left} y={H - 8} textAnchor="start" fontSize={9} fill={AXIS_INK}>
          {points[0]!.date}
        </text>
        <text x={W - PAD.right} y={H - 8} textAnchor="end" fontSize={9} fill={AXIS_INK}>
          {points[points.length - 1]!.date}
        </text>
      </svg>
      <div className="mt-1 flex items-center gap-4 text-[11px] text-ink-500">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded bg-brand-600" /> remaining
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded border-t border-dashed border-ink-400" />{" "}
          cumulative drawn
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded border-t border-dashed border-red-600" /> 20%
          exhaustion threshold
        </span>
      </div>
    </div>
  );
}
