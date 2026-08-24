/**
 * Hand-rolled SVG charts for the land workspace. No chart libraries: clean
 * axes, tabular numerals, brand-600 as the single primary and red reserved
 * for genuinely negative marks (breaches, disputes, overdue). Every mark
 * carries a <title> so hovering explains it.
 */
import type { ReactNode } from "react";
import {
  AMBER,
  AXIS_INK,
  BRAND,
  BRAND_SOFT,
  EMERALD,
  GRID,
  RED,
  fmtNum,
  rampColor,
} from "./landShared";

export interface Datum {
  key: string;
  label: string;
  value: number;
  /** override the bar colour for genuinely negative categories */
  tone?: "brand" | "red" | "amber" | "green" | "soft";
}

const toneFill: Record<string, string> = {
  brand: BRAND,
  red: RED,
  amber: AMBER,
  green: EMERALD,
  soft: BRAND_SOFT,
};

/** Horizontal bar chart — the right form for a handful of named categories. */
export function HBars({
  data,
  height = 18,
  gap = 8,
  labelWidth = 132,
  emptyNote,
  ariaLabel,
}: {
  data: Datum[];
  height?: number;
  gap?: number;
  labelWidth?: number;
  emptyNote?: string;
  ariaLabel: string;
}) {
  const rows = data.filter((d) => d.value > 0);
  if (rows.length === 0) {
    return (
      <p className="py-6 text-center text-xs text-ink-400">
        {emptyNote ?? "Nothing recorded yet."}
      </p>
    );
  }
  const W = 560;
  const PAD_R = 44;
  const plotW = W - labelWidth - PAD_R;
  const max = Math.max(...rows.map((d) => d.value));
  const H = rows.length * (height + gap) + gap;
  const ticks = [0, 0.5, 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={ariaLabel}>
      {ticks.map((f) => (
        <line
          key={f}
          x1={labelWidth + f * plotW}
          x2={labelWidth + f * plotW}
          y1={gap / 2}
          y2={H - gap / 2}
          stroke={GRID}
          strokeWidth={1}
        />
      ))}
      {rows.map((d, i) => {
        const y = gap + i * (height + gap);
        const w = max > 0 ? Math.max(2, (d.value / max) * plotW) : 2;
        return (
          <g key={d.key}>
            <text
              x={labelWidth - 8}
              y={y + height / 2 + 4}
              textAnchor="end"
              fontSize={11}
              fill={AXIS_INK}
            >
              {d.label}
            </text>
            <rect
              x={labelWidth}
              y={y}
              width={w}
              height={height}
              rx={3}
              fill={toneFill[d.tone ?? "brand"] ?? BRAND}
            >
              <title>{`${d.label}: ${fmtNum(d.value)}`}</title>
            </rect>
            <text
              x={labelWidth + w + 6}
              y={y + height / 2 + 4}
              fontSize={11}
              fill={AXIS_INK}
              className="tabular-nums"
            >
              {fmtNum(d.value)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** One stacked bar with a legend — for a lifecycle split that sums to a whole. */
export function StackedBar({
  data,
  ariaLabel,
  emptyNote,
}: {
  data: Datum[];
  ariaLabel: string;
  emptyNote?: string;
}) {
  const rows = data.filter((d) => d.value > 0);
  const total = rows.reduce((s, d) => s + d.value, 0);
  if (total === 0) {
    return (
      <p className="py-6 text-center text-xs text-ink-400">
        {emptyNote ?? "Nothing recorded yet."}
      </p>
    );
  }
  const W = 560;
  const H = 26;
  let x = 0;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={ariaLabel}>
        {rows.map((d) => {
          const w = (d.value / total) * W;
          const rect = (
            <rect
              key={d.key}
              x={x}
              y={0}
              width={Math.max(1, w - 1)}
              height={H}
              rx={2}
              fill={toneFill[d.tone ?? "brand"] ?? BRAND}
            >
              <title>{`${d.label}: ${fmtNum(d.value)} of ${fmtNum(total)}`}</title>
            </rect>
          );
          x += w;
          return rect;
        })}
      </svg>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {rows.map((d) => (
          <li key={d.key} className="flex items-center gap-1.5 text-xs text-ink-600">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ background: toneFill[d.tone ?? "brand"] ?? BRAND }}
            />
            {d.label}
            <span className="font-medium tabular-nums text-ink-800">{fmtNum(d.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Donut — for one split of a whole into a handful of named parts where no
 * part is better or worse than another (grievance intake channels). A single
 * brand ramp rather than a categorical rainbow, and the total in the hole so
 * the reader never has to add the arcs up.
 */
export function Donut({
  data,
  ariaLabel,
  centerLabel,
  emptyNote,
  size = 168,
}: {
  data: Datum[];
  ariaLabel: string;
  centerLabel?: string;
  emptyNote?: string;
  size?: number;
}) {
  const rows = data.filter((d) => d.value > 0);
  const total = rows.reduce((s, d) => s + d.value, 0);
  if (total === 0) {
    return (
      <p className="py-6 text-center text-xs text-ink-400">
        {emptyNote ?? "Nothing recorded yet."}
      </p>
    );
  }
  const r = size / 2 - 4;
  const inner = r * 0.6;
  const cx = size / 2;
  const cy = size / 2;

  // One arc per slice. A slice that is the entire whole cannot be drawn as an
  // arc (start and end coincide), so it renders as a plain ring instead.
  let angle = -Math.PI / 2;
  const slices = rows.map((d, i) => {
    const sweep = (d.value / total) * Math.PI * 2;
    const a0 = angle;
    const a1 = angle + sweep;
    angle = a1;
    const large = sweep > Math.PI ? 1 : 0;
    const p = (rad: number, radius: number) => [cx + radius * Math.cos(rad), cy + radius * Math.sin(rad)];
    const [x0, y0] = p(a0, r);
    const [x1, y1] = p(a1, r);
    const [x2, y2] = p(a1, inner);
    const [x3, y3] = p(a0, inner);
    const path = `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} L ${x2} ${y2} A ${inner} ${inner} 0 ${large} 0 ${x3} ${y3} Z`;
    return { datum: d, path, fill: d.tone ? (toneFill[d.tone] ?? BRAND) : rampColor(i) };
  });
  const whole = rows.length === 1;

  return (
    <div className="flex flex-wrap items-center gap-4">
      <svg
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        className="shrink-0"
        role="img"
        aria-label={ariaLabel}
      >
        {whole ? (
          <circle
            cx={cx}
            cy={cy}
            r={(r + inner) / 2}
            fill="none"
            stroke={slices[0]?.fill ?? BRAND}
            strokeWidth={r - inner}
          >
            <title>{`${rows[0]?.label}: ${fmtNum(total)} of ${fmtNum(total)} (100%)`}</title>
          </circle>
        ) : (
          slices.map((s) => (
            <path key={s.datum.key} d={s.path} fill={s.fill}>
              <title>{`${s.datum.label}: ${fmtNum(s.datum.value)} of ${fmtNum(total)} (${Math.round(
                (s.datum.value / total) * 100,
              )}%)`}</title>
            </path>
          ))
        )}
        <text
          x={cx}
          y={cy - 1}
          textAnchor="middle"
          fontSize={20}
          fontWeight={700}
          fill="#1f2a3d"
          className="tabular-nums"
        >
          {fmtNum(total)}
        </text>
        {centerLabel ? (
          <text x={cx} y={cy + 14} textAnchor="middle" fontSize={9} fill={AXIS_INK}>
            {centerLabel}
          </text>
        ) : null}
      </svg>
      <ul className="min-w-0 flex-1 space-y-1">
        {slices.map((s) => (
          <li key={s.datum.key} className="flex items-center gap-1.5 text-xs text-ink-600">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ background: s.fill }}
            />
            <span className="min-w-0 flex-1 truncate">{s.datum.label}</span>
            <span className="font-medium tabular-nums text-ink-800">{fmtNum(s.datum.value)}</span>
            <span className="w-9 shrink-0 text-right tabular-nums text-ink-400">
              {Math.round((s.datum.value / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Slim progress meter — paid vs committed, restored vs required. */
export function Meter({
  value,
  max,
  tone = "brand",
  caption,
}: {
  value: number;
  max: number;
  tone?: "brand" | "green" | "amber" | "red";
  caption?: ReactNode;
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-ink-100"
        role="img"
        aria-label={`${fmtNum(value)} of ${fmtNum(max)}`}
        title={`${fmtNum(value)} of ${fmtNum(max)}`}
      >
        <div
          className="h-full rounded-full transition-[width]"
          style={{ width: `${pct}%`, background: toneFill[tone] ?? BRAND }}
        />
      </div>
      {caption ? <div className="mt-1 text-xs text-ink-500">{caption}</div> : null}
    </div>
  );
}

/**
 * Timeline of grievance intake by month — a bar per month, so a spike in
 * community complaints lines up visually with what the works were doing.
 */
export function MonthlyBars({ byMonth }: { byMonth: Record<string, number> }) {
  const months = Object.keys(byMonth).sort();
  if (months.length === 0) {
    return <p className="py-6 text-center text-xs text-ink-400">No grievances recorded yet.</p>;
  }
  const W = 560;
  const H = 130;
  const PAD = { top: 10, right: 8, bottom: 26, left: 30 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const max = Math.max(...months.map((m) => byMonth[m] ?? 0), 1);
  const bw = plotW / months.length;
  const ticks = [0, max / 2, max];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label="Grievances received by month"
    >
      {ticks.map((t, i) => {
        const y = PAD.top + (1 - t / max) * plotH;
        return (
          <g key={i}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} stroke={GRID} strokeWidth={1} />
            <text
              x={PAD.left - 6}
              y={y + 3}
              textAnchor="end"
              fontSize={9}
              fill={AXIS_INK}
              className="tabular-nums"
            >
              {fmtNum(Math.round(t))}
            </text>
          </g>
        );
      })}
      {months.map((m, i) => {
        const v = byMonth[m] ?? 0;
        const h = (v / max) * plotH;
        const x = PAD.left + i * bw;
        return (
          <g key={m}>
            <rect
              x={x + bw * 0.18}
              y={PAD.top + plotH - h}
              width={bw * 0.64}
              height={Math.max(1, h)}
              rx={2}
              fill={BRAND}
            >
              <title>{`${m}: ${fmtNum(v)} grievance(s)`}</title>
            </rect>
            {months.length <= 14 || i % 2 === 0 ? (
              <text
                x={x + bw / 2}
                y={H - 8}
                textAnchor="middle"
                fontSize={9}
                fill={AXIS_INK}
                className="tabular-nums"
              >
                {m.slice(2)}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
