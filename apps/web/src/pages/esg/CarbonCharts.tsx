/**
 * Hand-rolled SVG carbon charts — no chart libraries.
 *
 * `LifeCycleChart` is the EN 15978 module split (#491-492): every module is
 * plotted, zeros included, because a whole-life assessment that silently
 * omits the stages nobody measured reads as a complete assessment when it is
 * not. `ScopeDonut` is the GHG-Protocol split (#505-508), with unscoped
 * emissions shown rather than hidden.
 */
import {
  CHART,
  MODULE_DESCRIPTIONS,
  MODULE_FILL,
  MODULE_LABELS,
  SCOPE_DESCRIPTIONS,
  SCOPE_FILL,
  SCOPE_LABELS,
  fmtPct,
  fmtT,
  niceMax,
} from "./esgShared";

const MODULE_ORDER = ["A1-A3", "A4", "A5", "B1-B7", "C1-C4", "D"] as const;
const SCOPE_ORDER = ["scope_1", "scope_2", "scope_3", "unscoped"] as const;

/* --------------------------- Life-cycle bars ----------------------------- */

export function LifeCycleChart({ byModule }: { byModule: Record<string, number> }) {
  const W = 680;
  const H = 250;
  const PAD = { top: 22, right: 16, bottom: 52, left: 60 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const values = MODULE_ORDER.map((m) => byModule[m] ?? 0);
  const max = niceMax(Math.max(...values, 0));
  const y = (v: number) => PAD.top + (1 - v / max) * plotH;
  const slot = plotW / MODULE_ORDER.length;
  const barW = Math.min(64, slot * 0.56);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const total = values.reduce((s, v) => s + v, 0);
  // Modules A–C are the assessment boundary; D is reported alongside it.
  const acTotal = values.slice(0, 5).reduce((s, v) => s + v, 0);

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label="Embodied carbon by EN 15978 life-cycle module, in tonnes of CO2 equivalent"
      >
        {/* horizontal grid + y labels */}
        {ticks.map((t, i) => (
          <g key={i}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(t)}
              y2={y(t)}
              stroke={i === 0 ? CHART.ink200 : CHART.ink100}
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={y(t) + 3}
              textAnchor="end"
              fontSize={9}
              fill={CHART.ink400}
              className="tabular-nums"
            >
              {fmtT(t, max < 10 ? 2 : 0)}
            </text>
          </g>
        ))}
        <text
          x={PAD.left - 8}
          y={PAD.top - 10}
          textAnchor="end"
          fontSize={9}
          fill={CHART.ink400}
          fontWeight={600}
        >
          tCO₂e
        </text>

        {/* the module bars — every module, zeros included */}
        {MODULE_ORDER.map((m, i) => {
          const v = byModule[m] ?? 0;
          const cx = PAD.left + slot * i + slot / 2;
          const barH = Math.max(v > 0 ? 1.5 : 0, (v / max) * plotH);
          const share = total > 0 ? (v / total) * 100 : 0;
          const tip = `${MODULE_DESCRIPTIONS[m] ?? m}\n${fmtT(v)} tCO₂e${
            total > 0 ? ` · ${fmtPct(share)} of the reported total` : ""
          }`;
          return (
            <g key={m}>
              <rect
                x={cx - barW / 2}
                y={y(v)}
                width={barW}
                height={barH}
                rx={2}
                fill={MODULE_FILL[m] ?? CHART.brand600}
                stroke={m === "D" ? CHART.ink400 : "none"}
                strokeDasharray={m === "D" ? "3 2" : undefined}
              >
                <title>{tip}</title>
              </rect>
              {/* zero modules still get a visible baseline tick and a label */}
              {v === 0 ? (
                <line
                  x1={cx - barW / 2}
                  x2={cx + barW / 2}
                  y1={y(0)}
                  y2={y(0)}
                  stroke={CHART.ink300}
                  strokeWidth={2}
                >
                  <title>{`${MODULE_DESCRIPTIONS[m] ?? m}\nNothing assessed in this module yet.`}</title>
                </line>
              ) : null}
              <text
                x={cx}
                y={y(v) - 6}
                textAnchor="middle"
                fontSize={10}
                fontWeight={600}
                fill={v === 0 ? CHART.ink300 : CHART.ink600}
                className="tabular-nums"
              >
                {v === 0 ? "0" : fmtT(v)}
              </text>
              <text
                x={cx}
                y={H - PAD.bottom + 16}
                textAnchor="middle"
                fontSize={11}
                fontWeight={600}
                fill={CHART.ink600}
              >
                {m}
              </text>
              <text
                x={cx}
                y={H - PAD.bottom + 30}
                textAnchor="middle"
                fontSize={9}
                fill={CHART.ink400}
              >
                {MODULE_LABELS[m] ?? ""}
              </text>
            </g>
          );
        })}

        {/* separator: module D sits outside the A–C system boundary */}
        <line
          x1={PAD.left + slot * 5}
          x2={PAD.left + slot * 5}
          y1={PAD.top - 6}
          y2={H - PAD.bottom + 34}
          stroke={CHART.ink200}
          strokeWidth={1}
          strokeDasharray="3 3"
        />
      </svg>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-400">
        Modules A1–C4 total{" "}
        <span className="font-medium tabular-nums text-ink-600">{fmtT(acTotal)} tCO₂e</span> — the
        assessment boundary. Module D (benefits and loads beyond the boundary) is reported
        alongside it and is never netted off.
      </p>
    </div>
  );
}

/* ------------------------------ Scope donut ------------------------------ */

export function ScopeDonut({ byScope }: { byScope: Record<string, number> }) {
  const size = 176;
  const stroke = 26;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const cx = size / 2;

  const slices = SCOPE_ORDER.map((k) => ({
    key: k,
    value: byScope[k] ?? 0,
    color: SCOPE_FILL[k] ?? CHART.ink200,
  }));
  const total = slices.reduce((s, x) => s + x.value, 0);

  let offset = 0;
  const drawn = slices
    .filter((s) => s.value > 0)
    .map((s) => {
      const len = (s.value / total) * c;
      const seg = { ...s, len, offset };
      offset += len;
      return seg;
    });

  return (
    <div className="flex flex-wrap items-center gap-5">
      <svg
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        className="shrink-0"
        role="img"
        aria-label="Emissions by GHG Protocol scope"
      >
        <circle cx={cx} cy={cx} r={r} fill="none" stroke={CHART.ink100} strokeWidth={stroke} />
        {drawn.map((s) => (
          <circle
            key={s.key}
            cx={cx}
            cy={cx}
            r={r}
            fill="none"
            stroke={s.color}
            strokeWidth={stroke}
            strokeDasharray={`${s.len} ${c - s.len}`}
            strokeDashoffset={-s.offset}
            transform={`rotate(-90 ${cx} ${cx})`}
          >
            <title>{`${SCOPE_DESCRIPTIONS[s.key] ?? s.key}\n${fmtT(s.value)} tCO₂e · ${fmtPct(
              (s.value / total) * 100,
            )}`}</title>
          </circle>
        ))}
        <text
          x={cx}
          y={cx - 2}
          textAnchor="middle"
          fontSize={17}
          fontWeight={700}
          fill={CHART.ink600}
          className="tabular-nums"
        >
          {fmtT(total)}
        </text>
        <text x={cx} y={cx + 14} textAnchor="middle" fontSize={9} fill={CHART.ink400}>
          tCO₂e
        </text>
      </svg>

      <ul className="min-w-40 flex-1 space-y-1.5">
        {slices.map((s) => (
          <li key={s.key} className="flex items-center gap-2 text-xs" title={SCOPE_DESCRIPTIONS[s.key]}>
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: s.color }}
            />
            <span className="min-w-0 flex-1 truncate text-ink-600">{SCOPE_LABELS[s.key]}</span>
            <span className="tabular-nums font-medium text-ink-800">{fmtT(s.value)}</span>
            <span className="w-12 text-right tabular-nums text-ink-400">
              {total > 0 ? fmtPct((s.value / total) * 100, 0) : "—"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
