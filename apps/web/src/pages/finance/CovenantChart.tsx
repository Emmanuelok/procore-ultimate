/**
 * Hand-rolled SVG line chart of covenant readings against the threshold
 * reference line (#742-743). Single series in brand; red is reserved for
 * genuinely breaching readings. No chart libs.
 */
import { fmtNum, opGlyph, type CovenantReadingRow, type CovenantRow } from "./financeShared";

const BRAND = "#1d60f1";
const GRID = "#ebedf1";
const AXIS_INK = "#7f8ea4";
const MARKER_INK = "#4b5a72";
const RED = "#dc2626";

export default function CovenantChart({
  covenant,
  readings,
}: {
  covenant: CovenantRow;
  readings: CovenantReadingRow[];
}) {
  const W = 620;
  const H = 200;
  const PAD = { top: 16, right: 64, bottom: 24, left: 48 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  if (readings.length === 0) {
    return (
      <div className="py-4 text-center text-xs text-ink-400">
        No readings recorded yet — add the first reading to start the compliance series.
      </div>
    );
  }

  const t = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
  const first = readings[0]!;
  const last = readings[readings.length - 1]!;
  const t0 = t(first.readingDate);
  const spanT = Math.max(1, t(last.readingDate) - t0);
  const x = (iso: string) =>
    readings.length === 1 ? PAD.left + plotW / 2 : PAD.left + ((t(iso) - t0) / spanT) * plotW;

  const values = readings.map((r) => r.value);
  const rawLo = Math.min(covenant.threshold, ...values);
  const rawHi = Math.max(covenant.threshold, ...values);
  const padV = Math.max((rawHi - rawLo) * 0.12, Math.abs(rawHi) * 0.05, 0.5);
  const lo = rawLo - padV;
  const hi = rawHi + padV;
  const spanV = hi - lo || 1;
  const y = (v: number) => PAD.top + (1 - (v - lo) / spanV) * plotH;

  const line = readings
    .map((r) => `${x(r.readingDate).toFixed(1)},${y(r.value).toFixed(1)}`)
    .join(" ");
  const gridLevels = [0, 0.25, 0.5, 0.75, 1].map((f) => lo + f * spanV);
  const anyBreach = readings.some((r) => r.compliant !== 1);
  const unit = covenant.unit ? ` ${covenant.unit}` : "";

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Readings of covenant ${covenant.name} against the ${opGlyph(covenant.operator)} ${covenant.threshold} threshold`}
      >
        {/* recessive horizontal grid + y labels */}
        {gridLevels.map((v, i) => (
          <g key={i}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(v)}
              y2={y(v)}
              stroke={GRID}
              strokeWidth={1}
            />
            <text
              x={PAD.left - 6}
              y={y(v) + 3}
              textAnchor="end"
              fontSize={9}
              fill={AXIS_INK}
              className="tabular-nums"
            >
              {fmtNum(Math.round(v * 100) / 100)}
            </text>
          </g>
        ))}

        {/* threshold reference line */}
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={y(covenant.threshold)}
          y2={y(covenant.threshold)}
          stroke={MARKER_INK}
          strokeWidth={1}
          strokeDasharray="4 3"
        >
          <title>{`Required ${opGlyph(covenant.operator)} ${fmtNum(covenant.threshold)}${unit}`}</title>
        </line>
        <text
          x={W - PAD.right + 4}
          y={y(covenant.threshold) + 3}
          fontSize={9}
          fontWeight={600}
          fill={MARKER_INK}
          className="tabular-nums"
        >
          {opGlyph(covenant.operator)} {fmtNum(covenant.threshold)}
        </text>

        {/* the reading series */}
        <polyline points={line} fill="none" stroke={BRAND} strokeWidth={2}>
          <title>{`${covenant.name} readings`}</title>
        </polyline>
        {readings.map((r) => {
          const breach = r.compliant !== 1;
          return (
            <circle
              key={r.id}
              cx={x(r.readingDate)}
              cy={y(r.value)}
              r={breach ? 4.5 : 3.5}
              fill={breach ? RED : BRAND}
              stroke="#ffffff"
              strokeWidth={1.5}
            >
              <title>
                {`${r.readingDate}: ${fmtNum(r.value)}${unit} — ${
                  breach ? "BREACH" : "compliant"
                } (headroom ${fmtNum(r.headroom)})${r.note ? ` · ${r.note}` : ""}`}
              </title>
            </circle>
          );
        })}

        {/* latest value end-label */}
        <text
          x={W - PAD.right + 4}
          y={
            y(last.value) +
            (Math.abs(y(last.value) - y(covenant.threshold)) < 11 ? 13 : 3)
          }
          fontSize={9}
          fontWeight={600}
          fill={last.compliant !== 1 ? RED : BRAND}
          className="tabular-nums"
        >
          {fmtNum(last.value)}
        </text>

        {/* x-axis date labels */}
        <text x={PAD.left} y={H - 8} textAnchor="start" fontSize={9} fill={AXIS_INK}>
          {first.readingDate}
        </text>
        {readings.length > 1 ? (
          <text x={W - PAD.right} y={H - 8} textAnchor="end" fontSize={9} fill={AXIS_INK}>
            {last.readingDate}
          </text>
        ) : null}
      </svg>
      <div className="mt-1 flex flex-wrap items-center gap-4 text-[11px] text-ink-500">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded bg-brand-600" /> reading
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded border-t border-dashed border-ink-500" />{" "}
          threshold {opGlyph(covenant.operator)} {fmtNum(covenant.threshold)}
          {unit}
        </span>
        {anyBreach ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-red-600" /> breach
          </span>
        ) : null}
      </div>
    </div>
  );
}
