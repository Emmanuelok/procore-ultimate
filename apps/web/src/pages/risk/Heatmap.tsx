/**
 * 5×5 probability/impact heatmap (spec Domain H #450) — hand-rolled SVG.
 * Cell shade encodes how many risks sit at that (probability, impact)
 * position; clicking a cell filters the register table. The pre/post toggle
 * (owned by the parent) re-plots risks at their post-mitigation position —
 * where a risk has no post scores it stays at its pre position, so the
 * movement between the two views IS the modelled mitigation effect.
 */
import type { RiskRow } from "./riskShared";

export interface HeatCell {
  probability: number;
  impact: number;
}

/** Sequential single-hue ramp (brand) — count 0 stays on the surface tint. */
const SHADES = ["#f6f7f9", "#d9eaff", "#bcdaff", "#8ec3ff", "#59a1ff", "#3380fc", "#1d60f1"];

function shadeFor(count: number, max: number): string {
  if (count <= 0) return SHADES[0]!;
  const idx = 1 + Math.round((count / Math.max(1, max)) * (SHADES.length - 2));
  return SHADES[Math.min(SHADES.length - 1, idx)]!;
}

/** Text must stay readable on the darker ramp steps. */
function inkFor(count: number, max: number): string {
  if (count <= 0) return "#acb6c5";
  return count / Math.max(1, max) > 0.55 ? "#ffffff" : "#303744";
}

export function cellScores(r: RiskRow, mode: "pre" | "post"): HeatCell {
  if (mode === "post" && r.postProbabilityScore != null && r.postImpactScore != null) {
    return { probability: r.postProbabilityScore, impact: r.postImpactScore };
  }
  return { probability: r.probabilityScore, impact: r.impactScore };
}

export default function Heatmap({
  risks,
  mode,
  selected,
  onSelect,
}: {
  risks: RiskRow[];
  mode: "pre" | "post";
  selected: HeatCell | null;
  onSelect: (cell: HeatCell | null) => void;
}) {
  const counts = new Map<string, number>();
  for (const r of risks) {
    const c = cellScores(r, mode);
    const key = `${c.probability}:${c.impact}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const maxCount = Math.max(1, ...counts.values());

  const CELL = 44;
  const GAP = 3;
  const PAD = { left: 34, bottom: 30, top: 6, right: 6 };
  const W = PAD.left + 5 * CELL + 4 * GAP + PAD.right;
  const H = PAD.top + 5 * CELL + 4 * GAP + PAD.bottom;

  const cellX = (p: number) => PAD.left + (p - 1) * (CELL + GAP);
  const cellY = (i: number) => PAD.top + (5 - i) * (CELL + GAP) - CELL;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full max-w-[280px]"
      role="img"
      aria-label={`Probability by impact heatmap, ${mode}-mitigation positions`}
    >
      {Array.from({ length: 5 }, (_, pi) => pi + 1).map((p) =>
        Array.from({ length: 5 }, (_, ii) => ii + 1).map((i) => {
          const count = counts.get(`${p}:${i}`) ?? 0;
          const isSelected = selected?.probability === p && selected?.impact === i;
          const band = p * i;
          return (
            <g
              key={`${p}-${i}`}
              className="cursor-pointer"
              onClick={() => onSelect(isSelected ? null : { probability: p, impact: i })}
            >
              <rect
                x={cellX(p)}
                y={cellY(i)}
                width={CELL}
                height={CELL}
                rx={4}
                fill={shadeFor(count, maxCount)}
                stroke={isSelected ? "#164bde" : band >= 16 && count > 0 ? "#dc2626" : "#d3d8e0"}
                strokeWidth={isSelected ? 2.5 : band >= 16 && count > 0 ? 1.5 : 0.75}
              >
                <title>
                  {`P${p} × I${i} (score ${band}): ${count} risk${count === 1 ? "" : "s"}${
                    isSelected ? " — click to clear filter" : count > 0 ? " — click to filter" : ""
                  }`}
                </title>
              </rect>
              {count > 0 ? (
                <text
                  x={cellX(p) + CELL / 2}
                  y={cellY(i) + CELL / 2 + 4}
                  textAnchor="middle"
                  fontSize={13}
                  fontWeight={600}
                  fill={inkFor(count, maxCount)}
                  className="pointer-events-none tabular-nums"
                >
                  {count}
                </text>
              ) : null}
            </g>
          );
        }),
      )}
      {/* axes */}
      {Array.from({ length: 5 }, (_, k) => k + 1).map((n) => (
        <g key={`ax-${n}`}>
          <text
            x={cellX(n) + CELL / 2}
            y={H - PAD.bottom + 13}
            textAnchor="middle"
            fontSize={9}
            fill="#7f8ea4"
            className="tabular-nums"
          >
            {n}
          </text>
          <text
            x={PAD.left - 8}
            y={cellY(n) + CELL / 2 + 3}
            textAnchor="end"
            fontSize={9}
            fill="#7f8ea4"
            className="tabular-nums"
          >
            {n}
          </text>
        </g>
      ))}
      <text
        x={PAD.left + (5 * CELL + 4 * GAP) / 2}
        y={H - 4}
        textAnchor="middle"
        fontSize={9}
        fill="#5f708a"
      >
        Probability →
      </text>
      <text
        x={9}
        y={PAD.top + (5 * CELL + 4 * GAP) / 2}
        textAnchor="middle"
        fontSize={9}
        fill="#5f708a"
        transform={`rotate(-90 9 ${PAD.top + (5 * CELL + 4 * GAP) / 2})`}
      >
        Impact →
      </text>
    </svg>
  );
}
