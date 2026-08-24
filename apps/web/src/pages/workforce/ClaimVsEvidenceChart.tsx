/**
 * Hand-rolled grouped bar chart: days CLAIMED by the employer above days
 * EVIDENCED by the access control, one pair per worker (#669). The claimed
 * bar's unevidenced tail is drawn in red because that segment is exactly the
 * money that has no attendance behind it. No chart libraries.
 */
import { AXIS_INK, BRAND, BRAND_PALE, GRID, MARK_INK, RED, fmtNum } from "./workforceShared";
import type { ReconRow } from "./workforceShared";

const MAX_ROWS = 16;

export default function ClaimVsEvidenceChart({ rows }: { rows: ReconRow[] }) {
  const shown = rows.slice(0, MAX_ROWS);
  if (shown.length === 0) {
    return (
      <p className="py-4 text-center text-xs text-ink-400">
        No worker was paid in this period, so there is nothing to reconcile.
      </p>
    );
  }

  const ROW_H = 30;
  const BAR_H = 10;
  const PAD = { top: 8, right: 68, bottom: 26, left: 108 };
  const W = 720;
  const plotW = W - PAD.left - PAD.right;
  const H = PAD.top + shown.length * ROW_H + PAD.bottom;

  const maxDays = Math.max(1, ...shown.map((r) => Math.max(r.daysClaimed, r.accessDays)));
  // a readable tick step: 1, 2, 5, 10, 20 … whichever gives 4-8 ticks
  const rawStep = maxDays / 6;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(rawStep, 0.1))));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => maxDays / s <= 8) ?? mag * 10;
  const ticks: number[] = [];
  for (let v = 0; v <= maxDays + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);

  const x = (days: number) => PAD.left + (days / maxDays) * plotW;

  return (
    <div>
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full min-w-[560px]"
          role="img"
          aria-label="Days claimed against days evidenced by site access, per worker"
        >
          {/* vertical grid + day axis */}
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={x(t)}
                x2={x(t)}
                y1={PAD.top}
                y2={H - PAD.bottom}
                stroke={GRID}
                strokeWidth={1}
              />
              <text
                x={x(t)}
                y={H - PAD.bottom + 14}
                textAnchor="middle"
                fontSize={9}
                fill={AXIS_INK}
                className="tabular-nums"
              >
                {fmtNum(t, 1)}
              </text>
            </g>
          ))}
          <text
            x={PAD.left + plotW / 2}
            y={H - 3}
            textAnchor="middle"
            fontSize={9}
            fill={AXIS_INK}
          >
            days in period
          </text>

          {shown.map((r, i) => {
            const top = PAD.top + i * ROW_H;
            const evidencedW = x(r.accessDays) - PAD.left;
            const matched = Math.min(r.daysClaimed, r.accessDays);
            const matchedW = x(matched) - PAD.left;
            const unmatchedW = Math.max(0, x(r.daysClaimed) - x(matched));
            const flagged = r.classification === "ghost" || r.classification === "overclaim";
            return (
              <g key={r.workerId}>
                <text
                  x={PAD.left - 8}
                  y={top + ROW_H / 2 + 3}
                  textAnchor="end"
                  fontSize={10}
                  fill={flagged ? MARK_INK : AXIS_INK}
                  fontWeight={flagged ? 600 : 400}
                >
                  {r.reference.length > 14 ? `${r.reference.slice(0, 13)}…` : r.reference}
                </text>

                {/* claimed (upper bar) — matched portion then the unevidenced tail */}
                <rect
                  x={PAD.left}
                  y={top + 2}
                  width={Math.max(matchedW, r.daysClaimed > 0 ? 1 : 0)}
                  height={BAR_H}
                  fill={BRAND}
                  rx={1.5}
                >
                  <title>{`${r.reference} — ${fmtNum(r.daysClaimed, 1)} day(s) claimed`}</title>
                </rect>
                {unmatchedW > 0 ? (
                  <rect
                    x={PAD.left + matchedW}
                    y={top + 2}
                    width={unmatchedW}
                    height={BAR_H}
                    fill={RED}
                    rx={1.5}
                  >
                    <title>
                      {`${r.reference} — ${fmtNum(r.unmatchedDays, 1)} claimed day(s) with no access record (${r.reason})`}
                    </title>
                  </rect>
                ) : null}

                {/* evidenced (lower bar) */}
                <rect
                  x={PAD.left}
                  y={top + 2 + BAR_H + 3}
                  width={Math.max(evidencedW, r.accessDays > 0 ? 1 : 0)}
                  height={BAR_H}
                  fill={BRAND_PALE}
                  rx={1.5}
                >
                  <title>{`${r.reference} — ${r.accessDays} distinct day(s) on site`}</title>
                </rect>
                {r.accessDays === 0 ? (
                  <text
                    x={PAD.left + 4}
                    y={top + 2 + BAR_H + 3 + BAR_H - 1.5}
                    fontSize={8.5}
                    fill={RED}
                    fontWeight={600}
                  >
                    no access record
                  </text>
                ) : null}

                <text
                  x={W - PAD.right + 6}
                  y={top + ROW_H / 2 + 3}
                  fontSize={9.5}
                  fill={flagged ? RED : AXIS_INK}
                  fontWeight={flagged ? 600 : 400}
                  className="tabular-nums"
                >
                  {fmtNum(r.daysClaimed, 1)} / {r.accessDays}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-4 text-[11px] text-ink-500">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-4 rounded-sm" style={{ background: BRAND }} /> claimed
          (evidenced portion)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-4 rounded-sm" style={{ background: RED }} /> claimed
          without an access record
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-4 rounded-sm" style={{ background: BRAND_PALE }} />{" "}
          days on site
        </span>
        {rows.length > MAX_ROWS ? (
          <span className="text-ink-400">
            showing the {MAX_ROWS} worst of {rows.length} workers
          </span>
        ) : null}
      </div>
    </div>
  );
}
