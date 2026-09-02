/**
 * Hand-rolled SVG for the Organisational Learning workspace. No chart
 * libraries — every mark here is drawn from the server's own numbers.
 *
 *   · BacklogAgeChart — open capture triggers aged into the four buckets the
 *     summary endpoint returns. This is the shaming chart: colour walks from
 *     green to red with age, the two oldest buckets are hatched, and an
 *     ageing backlog is annotated in words underneath so it cannot be read
 *     as "just some bars".
 *   · StackedBar — one-row composition (capture rate, lessons by status).
 */
import { AGE_BUCKETS, AGE_COLOR, AXIS_INK, GRID, MARK_INK, fmtInt } from "./learningShared";
import type { AgeBucket } from "./learningShared";

/* ------------------------------ Backlog by age ----------------------------- */

export function BacklogAgeChart({
  buckets,
  oldestOpenDays,
}: {
  buckets: Record<string, number>;
  oldestOpenDays: number | null;
}) {
  const data = AGE_BUCKETS.map((b) => ({ bucket: b, count: buckets[b] ?? 0 }));
  const total = data.reduce((s, d) => s + d.count, 0);
  const maxCount = Math.max(1, ...data.map((d) => d.count));

  const W = 680;
  const H = 240;
  const PAD = { top: 22, right: 16, bottom: 54, left: 44 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const slot = plotW / data.length;
  const barW = Math.min(96, slot - 26);

  const step = Math.max(1, Math.ceil(maxCount / 4));
  const ticks: number[] = [];
  for (let v = 0; v <= maxCount; v += step) ticks.push(v);
  const y = (count: number) => PAD.top + plotH - (count / maxCount) * plotH;

  /* The two oldest buckets are debt, not data — they get a hatch. */
  const hatched: Record<AgeBucket, boolean> = {
    "0-7": false,
    "8-30": false,
    "31-90": true,
    "90+": true,
  };

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full min-w-[520px]"
        role="img"
        aria-label={`Open capture triggers by age: ${data
          .map((d) => `${d.count} at ${d.bucket} days`)
          .join(", ")}`}
      >
        <defs>
          <pattern id="ll-hatch" width={6} height={6} patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <rect width={6} height={6} fill="#ffffff" fillOpacity={0} />
            <line x1={0} y1={0} x2={0} y2={6} stroke="#ffffff" strokeOpacity={0.55} strokeWidth={2.5} />
          </pattern>
        </defs>

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

        {data.map((d, i) => {
          const x = PAD.left + i * slot + (slot - barW) / 2;
          const h = (d.count / maxCount) * plotH;
          const color = AGE_COLOR[d.bucket];
          return (
            <g key={d.bucket}>
              <rect
                x={x}
                y={PAD.top + plotH - h}
                width={barW}
                height={Math.max(h, d.count > 0 ? 3 : 0)}
                fill={color}
                rx={2}
              >
                <title>
                  {`${d.count} open trigger${d.count === 1 ? "" : "s"} aged ${d.bucket} day${
                    d.bucket === "90+" ? "s or more" : "s"
                  }`}
                </title>
              </rect>
              {hatched[d.bucket] && d.count > 0 ? (
                <rect
                  x={x}
                  y={PAD.top + plotH - h}
                  width={barW}
                  height={Math.max(h, 3)}
                  fill="url(#ll-hatch)"
                  rx={2}
                  pointerEvents="none"
                />
              ) : null}
              <text
                x={x + barW / 2}
                y={PAD.top + plotH - h - 6}
                textAnchor="middle"
                fontSize={13}
                fontWeight={700}
                fill={d.count > 0 ? color : AXIS_INK}
                className="tabular-nums"
              >
                {d.count}
              </text>
              <text
                x={x + barW / 2}
                y={H - PAD.bottom + 16}
                textAnchor="middle"
                fontSize={11}
                fontWeight={600}
                fill={MARK_INK}
              >
                {d.bucket}
              </text>
              <text x={x + barW / 2} y={H - PAD.bottom + 29} textAnchor="middle" fontSize={9} fill={AXIS_INK}>
                days open
              </text>
            </g>
          );
        })}

        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={PAD.top + plotH}
          y2={PAD.top + plotH}
          stroke={AXIS_INK}
          strokeWidth={1}
        />
        <text x={PAD.left} y={12} fontSize={9} fill={AXIS_INK}>
          open triggers
        </text>
        <text x={W - PAD.right} y={H - 6} textAnchor="end" fontSize={9} fill={AXIS_INK}>
          {total === 0
            ? "no open triggers"
            : `${fmtInt(total)} open · oldest ${oldestOpenDays === null ? "—" : `${fmtInt(oldestOpenDays)} days`}`}
        </text>
      </svg>
    </div>
  );
}

/* -------------------------------- Stacked bar ------------------------------- */

export interface BarSegment {
  key: string;
  label: string;
  value: number;
  color: string;
}

/**
 * One-row composition. Zero-value segments are dropped from the bar but kept
 * in the legend with their zero shown — an absent status is information.
 */
export function StackedBar({
  segments,
  emptyLabel = "Nothing to show yet",
}: {
  segments: BarSegment[];
  emptyLabel?: string;
}) {
  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0);
  const W = 680;
  const H = 34;

  return (
    <div>
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full"
          role="img"
          aria-label={segments.map((s) => `${s.label}: ${s.value}`).join(", ")}
        >
          {total === 0 ? (
            <>
              <rect x={0} y={6} width={W} height={H - 12} rx={4} fill={GRID} />
              <text x={W / 2} y={H / 2 + 4} textAnchor="middle" fontSize={11} fill={AXIS_INK}>
                {emptyLabel}
              </text>
            </>
          ) : (
            (() => {
              let cursor = 0;
              return segments
                .filter((s) => s.value > 0)
                .map((s) => {
                  const w = (s.value / total) * W;
                  const x = cursor;
                  cursor += w;
                  return (
                    <g key={s.key}>
                      <rect x={x} y={6} width={Math.max(w - 1.5, 1)} height={H - 12} rx={3} fill={s.color}>
                        <title>{`${s.label}: ${s.value} of ${total}`}</title>
                      </rect>
                      {w > 46 ? (
                        <text
                          x={x + w / 2}
                          y={H / 2 + 4}
                          textAnchor="middle"
                          fontSize={11}
                          fontWeight={600}
                          fill="#ffffff"
                          className="tabular-nums"
                        >
                          {s.value}
                        </text>
                      ) : null}
                    </g>
                  );
                });
            })()
          )}
        </svg>
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {segments.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5 text-xs text-ink-600">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: s.color }}
            />
            <span>{s.label}</span>
            <span className="font-semibold tabular-nums text-ink-800">{fmtInt(s.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
