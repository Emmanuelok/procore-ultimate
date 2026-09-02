/**
 * Hand-rolled SVG charts for the Benchmarks workspace. No chart libraries.
 *
 *   · HistogramChart — the server's fixed 10-bin histogram as columns;
 *   · PercentileStrip — min→max track with the percentile markers, and
 *     optionally the project's own value flagged with its percentile rank.
 */
import { AXIS_INK, BRAND, BRAND_PALE, GRID, MARK_INK, fmtNum } from "./benchmarksShared";
import type { HistogramBin } from "./benchmarksShared";

/* -------------------------------- Histogram -------------------------------- */

export function HistogramChart({ bins, unit }: { bins: HistogramBin[]; unit: string }) {
  if (bins.length === 0) {
    return <p className="py-4 text-center text-xs text-ink-400">No histogram to draw.</p>;
  }

  const W = 680;
  const H = 220;
  const PAD = { top: 16, right: 12, bottom: 40, left: 40 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const maxCount = Math.max(1, ...bins.map((b) => b.count));
  const slot = plotW / bins.length;
  const barW = Math.max(4, slot - 6);

  // count-axis ticks: integers only, at most 5
  const step = Math.max(1, Math.ceil(maxCount / 4));
  const ticks: number[] = [];
  for (let v = 0; v <= maxCount; v += step) ticks.push(v);

  const y = (count: number) => PAD.top + plotH - (count / maxCount) * plotH;

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full min-w-[520px]"
        role="img"
        aria-label={`Histogram of benchmark samples in ${unit}, ${bins.length} bins`}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
            <text
              x={PAD.left - 6}
              y={y(t) + 3}
              textAnchor="end"
              fontSize={9}
              fill={AXIS_INK}
              className="tabular-nums"
            >
              {t}
            </text>
          </g>
        ))}

        {bins.map((b, i) => {
          const x = PAD.left + i * slot + (slot - barW) / 2;
          const h = (b.count / maxCount) * plotH;
          return (
            <g key={i}>
              <rect
                x={x}
                y={PAD.top + plotH - h}
                width={barW}
                height={Math.max(h, b.count > 0 ? 2 : 0)}
                fill={b.count > 0 ? BRAND : BRAND_PALE}
                rx={2}
              >
                <title>{`${fmtNum(b.lo)} – ${fmtNum(b.hi)} ${unit}: ${b.count} sample${
                  b.count === 1 ? "" : "s"
                }`}</title>
              </rect>
              {b.count > 0 ? (
                <text
                  x={x + barW / 2}
                  y={PAD.top + plotH - h - 4}
                  textAnchor="middle"
                  fontSize={9}
                  fill={MARK_INK}
                  className="tabular-nums"
                >
                  {b.count}
                </text>
              ) : null}
            </g>
          );
        })}

        {/* bin edges along the x axis — first edge, every other boundary, last edge */}
        {bins.map((b, i) =>
          i % 2 === 0 ? (
            <text
              key={`lo-${i}`}
              x={PAD.left + i * slot}
              y={H - PAD.bottom + 14}
              textAnchor="middle"
              fontSize={8.5}
              fill={AXIS_INK}
              className="tabular-nums"
            >
              {fmtNum(b.lo)}
            </text>
          ) : null,
        )}
        <text
          x={PAD.left + bins.length * slot}
          y={H - PAD.bottom + 14}
          textAnchor="middle"
          fontSize={8.5}
          fill={AXIS_INK}
          className="tabular-nums"
        >
          {fmtNum(bins[bins.length - 1]!.hi)}
        </text>
        <line
          x1={PAD.left}
          x2={PAD.left + bins.length * slot}
          y1={PAD.top + plotH}
          y2={PAD.top + plotH}
          stroke={AXIS_INK}
          strokeWidth={1}
        />
        <text x={PAD.left + plotW / 2} y={H - 6} textAnchor="middle" fontSize={9} fill={AXIS_INK}>
          {unit}
        </text>
      </svg>
    </div>
  );
}

/* ----------------------------- Percentile strip ---------------------------- */

export interface StripMarker {
  value: number;
  label: string;
}

/**
 * Horizontal min→max strip with labelled percentile ticks. When `flag` is
 * given (the project's own value in compare), it is drawn as a brand-colored
 * needle above the track, even when it falls outside the marker range.
 */
export function PercentileStrip({
  markers,
  flag,
  unit,
}: {
  markers: StripMarker[];
  flag?: { value: number; label: string } | null;
  unit: string;
}) {
  const values = [...markers.map((m) => m.value), ...(flag ? [flag.value] : [])];
  if (values.length === 0) {
    return <p className="py-4 text-center text-xs text-ink-400">No percentiles to draw.</p>;
  }
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || Math.abs(hi) || 1;
  const domLo = lo - span * 0.06;
  const domHi = hi + span * 0.06;

  const W = 680;
  const H = flag ? 108 : 84;
  const PAD = { left: 24, right: 24 };
  const trackY = flag ? 62 : 40;
  const x = (v: number) => PAD.left + ((v - domLo) / (domHi - domLo)) * (W - PAD.left - PAD.right);

  const sorted = [...markers].sort((a, b) => a.value - b.value);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full min-w-[520px]"
        role="img"
        aria-label={`Percentile strip in ${unit}${flag ? ` with the project value flagged at ${flag.label}` : ""}`}
      >
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={trackY}
          y2={trackY}
          stroke={GRID}
          strokeWidth={6}
          strokeLinecap="round"
        />
        {first && last && first !== last ? (
          <line
            x1={x(first.value)}
            x2={x(last.value)}
            y1={trackY}
            y2={trackY}
            stroke={BRAND_PALE}
            strokeWidth={6}
            strokeLinecap="round"
          />
        ) : null}

        {sorted.map((m, i) => (
          <g key={`${m.label}-${i}`}>
            <line
              x1={x(m.value)}
              x2={x(m.value)}
              y1={trackY - 9}
              y2={trackY + 9}
              stroke={MARK_INK}
              strokeWidth={m.label === "median" ? 2.5 : 1.5}
            />
            {/* alternate label rows so close percentiles stay readable */}
            <text
              x={x(m.value)}
              y={trackY + (i % 2 === 0 ? 22 : 34)}
              textAnchor="middle"
              fontSize={9}
              fill={AXIS_INK}
            >
              {m.label}
            </text>
            <text
              x={x(m.value)}
              y={trackY - (i % 2 === 0 ? 13 : 25)}
              textAnchor="middle"
              fontSize={9}
              fill={MARK_INK}
              className="tabular-nums"
            >
              {fmtNum(m.value)}
            </text>
          </g>
        ))}

        {flag ? (
          <g>
            <line
              x1={x(flag.value)}
              x2={x(flag.value)}
              y1={14}
              y2={trackY + 9}
              stroke={BRAND}
              strokeWidth={2.5}
            />
            <circle cx={x(flag.value)} cy={trackY} r={5} fill={BRAND} stroke="#fff" strokeWidth={1.5} />
            <text
              x={x(flag.value)}
              y={10}
              textAnchor="middle"
              fontSize={10}
              fontWeight={600}
              fill={BRAND}
              className="tabular-nums"
            >
              {flag.label}
            </text>
          </g>
        ) : null}
      </svg>
    </div>
  );
}
