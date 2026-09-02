/**
 * Pure-SVG Gantt — no chart libraries. One row per task in sortOrder, a date
 * axis from the schedule's earliest date to its computed finish (plus margin),
 * critical bars in red, baseline ghost bars beneath current bars, a today
 * line, and float whiskers. Tooltips ride on native <title> elements.
 */
import { useMemo } from "react";
import { formatDate } from "../format";
import { DAY_MS, dayNum, shortDate, todayIso, type BaselineTask, type TaskRow } from "./types";

const ROW_H = 28;
const AXIS_H = 30;
const BAR_H = 12;
const MARGIN_DAYS = 3;

const C = {
  critical: "#dc2626", // red-600
  normal: "#1d60f1", // brand-600
  ghost: "#9ca3af", // gray-400
  float: "#8ec3ff", // brand-300
  rowStripe: "#f6f7f9", // ink-50
  rowSelected: "#eef6ff", // brand-50
  gridWeek: "#ebedf1", // ink-100
  gridMonth: "#d3d8e0", // ink-200
  today: "#f59e0b", // amber-500
  todayText: "#b45309", // amber-700
  axisText: "#7f8ea4", // ink-400
  muted: "#acb6c5", // ink-300
  progress: "rgba(20, 36, 86, 0.30)",
};

export interface GanttSvgProps {
  tasks: TaskRow[];
  projectStart: string;
  computedFinish: string | null;
  /** snapshot rows of the selected baseline, keyed by taskId — null = no ghost bars */
  baseline: Map<string, BaselineTask> | null;
  baselineName?: string | null;
  selectedTaskId: string | null;
  onSelectTask: (id: string) => void;
}

interface Diamond {
  cx: number;
  cy: number;
  r: number;
}

function diamondPoints({ cx, cy, r }: Diamond): string {
  return `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`;
}

export default function GanttSvg({
  tasks,
  projectStart,
  computedFinish,
  baseline,
  baselineName,
  selectedTaskId,
  onSelectTask,
}: GanttSvgProps) {
  const today = todayIso();

  const scale = useMemo(() => {
    const days: number[] = [dayNum(projectStart)];
    if (computedFinish) days.push(dayNum(computedFinish));
    for (const t of tasks) {
      if (t.startDate) days.push(dayNum(t.startDate));
      if (t.finishDate) {
        const f = dayNum(t.finishDate);
        days.push(f);
        if (t.totalFloat !== null && t.totalFloat > 0) days.push(f + t.totalFloat);
      }
    }
    if (baseline) {
      for (const b of baseline.values()) {
        if (b.startDate) days.push(dayNum(b.startDate));
        if (b.finishDate) days.push(dayNum(b.finishDate));
      }
    }
    const minDay = Math.min(...days) - MARGIN_DAYS;
    const maxDay = Math.max(...days) + MARGIN_DAYS;
    const span = Math.max(1, maxDay - minDay + 1);
    const pxPerDay = Math.max(7, Math.min(26, Math.floor(1040 / span)));
    return { minDay, maxDay, span, pxPerDay };
  }, [tasks, projectStart, computedFinish, baseline]);

  const { minDay, maxDay, pxPerDay } = scale;
  const width = (maxDay - minDay + 1) * pxPerDay;
  const height = AXIS_H + tasks.length * ROW_H + 6;
  const x = (day: number) => (day - minDay) * pxPerDay;

  const todayDay = dayNum(today);
  const showToday = todayDay >= minDay && todayDay <= maxDay;

  /* ------------------------------ axis ------------------------------ */

  const axis = useMemo(() => {
    const monthLines: { x: number; label: string }[] = [];
    const weekLines: { x: number; label: string | null }[] = [];
    let prevYear: number | null = null;
    for (let day = minDay; day <= maxDay; day += 1) {
      const d = new Date(day * DAY_MS);
      if (d.getUTCDate() === 1 || day === minDay) {
        const year = d.getUTCFullYear();
        const label =
          prevYear === year
            ? d.toLocaleDateString(undefined, { month: "short", timeZone: "UTC" })
            : d.toLocaleDateString(undefined, {
                month: "short",
                year: "numeric",
                timeZone: "UTC",
              });
        prevYear = year;
        monthLines.push({ x: x(day), label });
      } else if (d.getUTCDay() === 1) {
        weekLines.push({
          x: x(day),
          label: pxPerDay >= 10 ? String(d.getUTCDate()) : null,
        });
      }
    }
    return { monthLines, weekLines };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minDay, maxDay, pxPerDay]);

  /* ------------------------------ render ------------------------------ */

  return (
    <div>
      <div className="flex">
        {/* fixed task-name gutter — stays put while the chart scrolls */}
        <div className="w-44 shrink-0 border-r border-ink-100 sm:w-52">
          <div
            style={{ height: AXIS_H }}
            className="flex items-end px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-400"
          >
            Task
          </div>
          {tasks.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onSelectTask(t.id)}
              style={{ height: ROW_H }}
              className={`flex w-full items-center gap-1.5 px-2 text-left text-xs ${
                selectedTaskId === t.id ? "bg-brand-50" : "hover:bg-ink-50"
              }`}
              title={t.name}
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  t.isCritical === 1 ? "bg-red-600" : "bg-ink-200"
                }`}
                aria-hidden
              />
              {t.wbsCode ? (
                <span className="shrink-0 font-mono text-[10px] text-ink-400">{t.wbsCode}</span>
              ) : null}
              <span className="truncate text-ink-800">{t.name}</span>
              {t.durationDays === 0 ? (
                <span className="shrink-0 text-[10px] text-violet-600" aria-label="milestone">
                  ◆
                </span>
              ) : null}
            </button>
          ))}
        </div>

        {/* scrollable chart */}
        <div className="min-w-0 flex-1 overflow-x-auto">
          <svg width={width} height={height} className="block" role="img" aria-label="Gantt chart">
            {/* row striping + selection */}
            {tasks.map((t, i) =>
              selectedTaskId === t.id || i % 2 === 1 ? (
                <rect
                  key={`bg-${t.id}`}
                  x={0}
                  y={AXIS_H + i * ROW_H}
                  width={width}
                  height={ROW_H}
                  fill={selectedTaskId === t.id ? C.rowSelected : C.rowStripe}
                />
              ) : null,
            )}

            {/* gridlines */}
            {axis.weekLines.map((w, i) => (
              <line
                key={`w-${i}`}
                x1={w.x}
                y1={AXIS_H - 6}
                x2={w.x}
                y2={height}
                stroke={C.gridWeek}
                strokeWidth={1}
              />
            ))}
            {axis.monthLines.map((m, i) => (
              <line
                key={`m-${i}`}
                x1={m.x}
                y1={12}
                x2={m.x}
                y2={height}
                stroke={C.gridMonth}
                strokeWidth={1}
              />
            ))}

            {/* axis labels */}
            {axis.monthLines.map((m, i) => (
              <text key={`ml-${i}`} x={m.x + 3} y={11} fontSize={10} fill={C.axisText}>
                {m.label}
              </text>
            ))}
            {axis.weekLines.map((w, i) =>
              w.label ? (
                <text key={`wl-${i}`} x={w.x + 2} y={AXIS_H - 8} fontSize={9} fill={C.muted}>
                  {w.label}
                </text>
              ) : null,
            )}

            {/* task bars */}
            {tasks.map((t, i) => {
              const rowY = AXIS_H + i * ROW_H;
              const cy = rowY + ROW_H / 2 - 2;
              const barY = cy - BAR_H / 2;
              const ghost = baseline?.get(t.id) ?? null;
              const color = t.isCritical === 1 ? C.critical : C.normal;
              const tip = [
                `${t.wbsCode ? `${t.wbsCode} · ` : ""}${t.name}`,
                t.durationDays === 0
                  ? `Milestone — ${formatDate(t.startDate)}`
                  : `${formatDate(t.startDate)} → ${formatDate(t.finishDate)} (${t.durationDays}d)`,
                `Float ${t.totalFloat ?? "—"}d${t.isCritical === 1 ? " · CRITICAL" : ""}`,
                `${Math.round(t.percentComplete)}% complete`,
                ghost && ghost.startDate
                  ? `Baseline${baselineName ? ` (${baselineName})` : ""}: ${shortDate(ghost.startDate)} → ${shortDate(ghost.finishDate)}`
                  : null,
              ]
                .filter(Boolean)
                .join("\n");

              return (
                <g
                  key={t.id}
                  onClick={() => onSelectTask(t.id)}
                  style={{ cursor: "pointer" }}
                >
                  <title>{tip}</title>
                  {/* click target across the whole row */}
                  <rect x={0} y={rowY} width={width} height={ROW_H} fill="transparent" />

                  {/* baseline ghost beneath the current bar */}
                  {ghost && ghost.startDate ? (
                    ghost.durationDays === 0 ? (
                      <polygon
                        points={diamondPoints({
                          cx: x(dayNum(ghost.startDate)) + pxPerDay / 2,
                          cy: rowY + ROW_H - 5,
                          r: 3.5,
                        })}
                        fill={C.ghost}
                        opacity={0.9}
                      />
                    ) : ghost.finishDate ? (
                      <rect
                        x={x(dayNum(ghost.startDate))}
                        y={rowY + ROW_H - 7}
                        width={Math.max(
                          2,
                          (dayNum(ghost.finishDate) - dayNum(ghost.startDate) + 1) * pxPerDay,
                        )}
                        height={4}
                        rx={1.5}
                        fill={C.ghost}
                        opacity={0.85}
                      />
                    ) : null
                  ) : null}

                  {t.startDate === null ? (
                    <text x={4} y={cy + 3} fontSize={10} fill={C.muted}>
                      unscheduled
                    </text>
                  ) : t.durationDays === 0 ? (
                    <polygon
                      points={diamondPoints({
                        cx: x(dayNum(t.startDate)) + pxPerDay / 2,
                        cy,
                        r: 6,
                      })}
                      fill={color}
                      stroke="#fff"
                      strokeWidth={1}
                    />
                  ) : t.finishDate !== null ? (
                    (() => {
                      const bx = x(dayNum(t.startDate!));
                      const bw = Math.max(
                        2,
                        (dayNum(t.finishDate!) - dayNum(t.startDate!) + 1) * pxPerDay,
                      );
                      const pct = Math.min(100, Math.max(0, t.percentComplete));
                      return (
                        <>
                          {/* float whisker — light extension of length totalFloat */}
                          {t.totalFloat !== null && t.totalFloat > 0 ? (
                            <>
                              <line
                                x1={bx + bw}
                                y1={cy}
                                x2={bx + bw + t.totalFloat * pxPerDay}
                                y2={cy}
                                stroke={C.float}
                                strokeWidth={2}
                              />
                              <line
                                x1={bx + bw + t.totalFloat * pxPerDay}
                                y1={cy - 4}
                                x2={bx + bw + t.totalFloat * pxPerDay}
                                y2={cy + 4}
                                stroke={C.float}
                                strokeWidth={2}
                              />
                            </>
                          ) : null}
                          <rect x={bx} y={barY} width={bw} height={BAR_H} rx={2.5} fill={color} />
                          {pct > 0 ? (
                            <rect
                              x={bx}
                              y={barY + BAR_H - 4}
                              width={(bw * pct) / 100}
                              height={4}
                              rx={2}
                              fill={C.progress}
                            />
                          ) : null}
                        </>
                      );
                    })()
                  ) : null}
                </g>
              );
            })}

            {/* today line */}
            {showToday ? (
              <g>
                <line
                  x1={x(todayDay) + pxPerDay / 2}
                  y1={14}
                  x2={x(todayDay) + pxPerDay / 2}
                  y2={height}
                  stroke={C.today}
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                />
                <text
                  x={x(todayDay) + pxPerDay / 2 + 4}
                  y={AXIS_H - 8}
                  fontSize={9}
                  fill={C.todayText}
                >
                  Today
                </text>
              </g>
            ) : null}
          </svg>
        </div>
      </div>

      {/* legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-ink-100 px-3 py-2 text-[10px] text-ink-500">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-5 rounded-sm" style={{ background: C.critical }} /> critical
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-5 rounded-sm" style={{ background: C.normal }} /> task
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span style={{ color: C.normal }}>◆</span> milestone
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1 w-5 rounded-sm" style={{ background: C.ghost }} /> baseline
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-5" style={{ background: C.float }} /> float
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="h-3 w-0 border-l-2 border-dashed"
            style={{ borderColor: C.today }}
          />{" "}
          today
        </span>
      </div>
    </div>
  );
}
