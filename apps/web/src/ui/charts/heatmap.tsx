/**
 * charts/heatmap.tsx — HeatmapCalendar.
 *
 * Day-grid intensity: daily-log submissions, safety observations, site
 * attendance, inspection counts. Weeks run left to right, weekdays top to
 * bottom.
 *
 * A day with a reported value of zero and a day with no report at all are
 * drawn differently — flat surface fill for a real zero, a dotted outline for
 * "not reported" — because on a construction programme those two mean very
 * different things.
 */
import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { cx } from "../cx";
import type { Tone } from "../tokens";
import {
  SEQUENTIAL_ZERO,
  divergingColor,
  sequentialColor,
  sequentialSteps,
  toneColor,
} from "./palette";
import {
  formatChartDate,
  makeValueFormatter,
  toChartDate,
  toChartNumber,
  type ChartFormatOptions,
  type ValueFormat,
} from "./format";
import { ChartEmpty, ChartLoading } from "./primitives";
import { DAY_MS, addDays, dayKey, startOfDay, startOfWeek } from "./time";
import type { ChartStateProps } from "./types";

/* ============================================================================
   Props
============================================================================ */

export interface HeatmapDay {
  date: Date | string | number;
  /** null = nothing reported. 0 = reported as zero. They render differently. */
  value?: number | null;
  /** Extra line in the cell tooltip. */
  note?: string;
}

export interface HeatmapCalendarProps extends ChartStateProps {
  data: ReadonlyArray<HeatmapDay>;
  /** Defaults to the earliest date in `data`, snapped to a week boundary. */
  start?: Date | string | number;
  /** Defaults to the latest date in `data`. */
  end?: Date | string | number;
  weekStartsOn?: 0 | 1;
  /** Cell edge in px. Default 12. */
  cellSize?: number;
  /** Gap between cells in px. Default 3. */
  cellGap?: number;
  /** Number of intensity steps in the legend. Default 5. */
  levels?: number;
  /** "sequential" for counts, "diverging" for variance around zero. */
  scale?: "sequential" | "diverging";
  /** Fix the colour domain. Default [0, max] (or [-|max|, |max|] diverging). */
  domain?: readonly [number, number];
  /** Hue of the sequential ramp. Default the accent tone. */
  tone?: Tone;
  valueFormat?: ValueFormat;
  formatOptions?: ChartFormatOptions;
  /** Noun used in cell labels: "3 observations". Default "records". */
  unitLabel?: string;
  showMonthLabels?: boolean;
  showWeekdayLabels?: boolean;
  showLegend?: boolean;
  ariaLabel?: string;
  onSelectDay?: (day: { date: Date; value: number | null; note?: string }) => void;
  className?: string;
}

interface Cell {
  date: Date;
  key: string;
  value: number | null;
  note?: string | undefined;
  inRange: boolean;
}

const WEEKDAY_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function HeatmapCalendar({
  data,
  start,
  end,
  weekStartsOn = 1,
  cellSize = 12,
  cellGap = 3,
  levels = 5,
  scale = "sequential",
  domain,
  tone,
  valueFormat,
  formatOptions,
  unitLabel = "records",
  showMonthLabels = true,
  showWeekdayLabels = true,
  showLegend = true,
  ariaLabel = "Activity calendar",
  onSelectDay,
  className,
  ...state
}: HeatmapCalendarProps) {
  const [focused, setFocused] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);

  const formatter = useMemo(
    () => makeValueFormatter(valueFormat, formatOptions ?? {}),
    [valueFormat, formatOptions],
  );

  const byDay = useMemo(() => {
    const map = new Map<string, { value: number | null; note?: string | undefined }>();
    for (const entry of data) {
      const date = toChartDate(entry.date);
      if (!date) continue;
      map.set(dayKey(date), { value: toChartNumber(entry.value), note: entry.note });
    }
    return map;
  }, [data]);

  const range = useMemo(() => {
    const explicitStart = toChartDate(start ?? null);
    const explicitEnd = toChartDate(end ?? null);
    if (explicitStart && explicitEnd) return { from: startOfDay(explicitStart), to: startOfDay(explicitEnd) };

    let min: Date | null = explicitStart ? startOfDay(explicitStart) : null;
    let max: Date | null = explicitEnd ? startOfDay(explicitEnd) : null;
    for (const entry of data) {
      const date = toChartDate(entry.date);
      if (!date) continue;
      const day = startOfDay(date);
      if (!min || day < min) min = day;
      if (!max || day > max) max = day;
    }
    return min && max ? { from: min, to: max } : null;
  }, [data, start, end]);

  const weeks = useMemo<Cell[][]>(() => {
    if (!range) return [];
    const first = startOfWeek(range.from, weekStartsOn);
    const totalDays = Math.round((range.to.getTime() - first.getTime()) / DAY_MS) + 1;
    const weekCount = Math.ceil(totalDays / 7);
    const out: Cell[][] = [];
    for (let w = 0; w < weekCount; w += 1) {
      const column: Cell[] = [];
      for (let d = 0; d < 7; d += 1) {
        const date = addDays(first, w * 7 + d);
        const key = dayKey(date);
        const record = byDay.get(key);
        column.push({
          date,
          key,
          value: record?.value ?? null,
          note: record?.note,
          inRange: date >= range.from && date <= range.to,
        });
      }
      out.push(column);
    }
    return out;
  }, [range, weekStartsOn, byDay]);

  const bounds = useMemo(() => {
    if (domain) return { lo: domain[0], hi: domain[1] };
    let lo = 0;
    let hi = 0;
    for (const record of byDay.values()) {
      if (record.value === null) continue;
      lo = Math.min(lo, record.value);
      hi = Math.max(hi, record.value);
    }
    if (scale === "diverging") {
      const bound = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
      return { lo: -bound, hi: bound };
    }
    return { lo: 0, hi: hi || 1 };
  }, [domain, byDay, scale]);

  const hue = tone ? toneColor(tone) : "var(--ds-accent)";

  const fillFor = useCallback(
    (value: number | null): string => {
      if (value === null) return "transparent";
      if (scale === "diverging") {
        const bound = Math.max(Math.abs(bounds.lo), Math.abs(bounds.hi)) || 1;
        return divergingColor(value / bound);
      }
      if (value === 0) return SEQUENTIAL_ZERO;
      const span = bounds.hi - bounds.lo || 1;
      const step = Math.max(1, Math.round(((value - bounds.lo) / span) * (levels - 1)));
      return sequentialColor(step / (levels - 1), hue);
    },
    [scale, bounds, levels, hue],
  );

  const monthSpans = useMemo(() => {
    const spans: Array<{ label: string; startWeek: number; weeks: number }> = [];
    weeks.forEach((column, index) => {
      const anchor = column[0];
      if (!anchor) return;
      const label = formatChartDate(anchor.date, "month");
      const last = spans[spans.length - 1];
      if (!last || last.label !== label) {
        spans.push({ label, startWeek: index, weeks: 1 });
      } else {
        last.weeks += 1;
      }
    });
    return spans;
  }, [weeks]);

  const flatCells = useMemo(() => weeks.flat().filter((cell) => cell.inRange), [weeks]);
  const reported = flatCells.filter((cell) => cell.value !== null).length;

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, weekIndex: number, dayIndex: number) => {
      const move = (dw: number, dd: number) => {
        event.preventDefault();
        const nextWeek = weekIndex + dw;
        const nextDay = dayIndex + dd;
        const cell = weeks[nextWeek]?.[nextDay];
        if (!cell) return;
        setFocused(cell.key);
        gridRef.current
          ?.querySelector<HTMLElement>(`[data-day="${cell.key}"]`)
          ?.focus();
      };
      switch (event.key) {
        case "ArrowLeft":
          move(-1, 0);
          break;
        case "ArrowRight":
          move(1, 0);
          break;
        case "ArrowUp":
          move(0, -1);
          break;
        case "ArrowDown":
          move(0, 1);
          break;
        case "Home":
          move(-weekIndex, 0);
          break;
        case "End":
          move(weeks.length - 1 - weekIndex, 0);
          break;
        default:
          break;
      }
    },
    [weeks],
  );

  if (state.loading) {
    return (
      <div className={cx("h-24 w-full", className)}>
        <ChartLoading variant="block" />
      </div>
    );
  }

  if (state.error) {
    const message = state.error instanceof Error ? state.error.message : state.error;
    return (
      <div className={cx("h-24 w-full", className)}>
        <ChartEmpty title="Calendar unavailable" message={message} compact />
      </div>
    );
  }

  if (!range || weeks.length === 0 || reported === 0) {
    return (
      <div className={cx("h-24 w-full", className)}>
        <ChartEmpty
          title={state.emptyTitle ?? "No activity"}
          message={
            state.emptyMessage ??
            "Nothing has been reported for these dates, so there is no calendar to draw."
          }
          action={state.emptyAction}
          compact
        />
      </div>
    );
  }

  const columnWidth = cellSize + cellGap;
  const firstFocusable = focused ?? flatCells[0]?.key ?? null;

  return (
    <div className={cx("flex min-w-0 flex-col gap-2", className)}>
      <div className="flex min-w-0 gap-2">
        {showWeekdayLabels ? (
          <div
            className="flex shrink-0 flex-col text-2xs text-content-subtle"
            style={{ gap: cellGap, paddingTop: showMonthLabels ? 18 : 0 }}
            aria-hidden="true"
          >
            {Array.from({ length: 7 }, (_, index) => {
              const weekday = (index + weekStartsOn) % 7;
              const show = index % 2 === 1;
              return (
                <span
                  key={index}
                  className="flex items-center justify-end pr-0.5 leading-none"
                  style={{ height: cellSize }}
                >
                  {show ? WEEKDAY_LABEL[weekday]?.slice(0, 1) : ""}
                </span>
              );
            })}
          </div>
        ) : null}

        <div className="min-w-0 flex-1 overflow-x-auto no-scrollbar">
          <div style={{ width: weeks.length * columnWidth }}>
            {showMonthLabels ? (
              <div className="relative h-[18px] text-2xs text-content-subtle" aria-hidden="true">
                {monthSpans.map((span) => (
                  <span
                    key={`${span.label}-${span.startWeek}`}
                    className="absolute top-0 leading-none"
                    style={{ left: span.startWeek * columnWidth }}
                  >
                    {span.weeks >= 2 ? span.label : ""}
                  </span>
                ))}
              </div>
            ) : null}

            <div ref={gridRef} role="grid" aria-label={ariaLabel} aria-rowcount={7}>
              {Array.from({ length: 7 }, (_, dayIndex) => (
                <div
                  key={dayIndex}
                  role="row"
                  className="flex"
                  style={{ gap: cellGap, marginBottom: cellGap }}
                >
                  {weeks.map((column, weekIndex) => {
                    const cell = column[dayIndex];
                    if (!cell) return null;
                    if (!cell.inRange) {
                      return (
                        <div
                          key={cell.key}
                          role="gridcell"
                          aria-hidden="true"
                          style={{ width: cellSize, height: cellSize }}
                        />
                      );
                    }
                    const missing = cell.value === null;
                    const description = missing
                      ? `${formatChartDate(cell.date, "day")}: not reported`
                      : `${formatChartDate(cell.date, "day")}: ${formatter(cell.value as number)} ${unitLabel}`;
                    const interactive = Boolean(onSelectDay);
                    return (
                      <div
                        key={cell.key}
                        role="gridcell"
                        data-day={cell.key}
                        tabIndex={cell.key === firstFocusable ? 0 : -1}
                        aria-label={cell.note ? `${description}. ${cell.note}` : description}
                        title={cell.note ? `${description} — ${cell.note}` : description}
                        onFocus={() => setFocused(cell.key)}
                        onKeyDown={(event) => {
                          if (interactive && (event.key === "Enter" || event.key === " ")) {
                            event.preventDefault();
                            onSelectDay?.({ date: cell.date, value: cell.value, note: cell.note });
                            return;
                          }
                          onKeyDown(event, weekIndex, dayIndex);
                        }}
                        onClick={
                          interactive
                            ? () => onSelectDay?.({ date: cell.date, value: cell.value, note: cell.note })
                            : undefined
                        }
                        className={cx(
                          "rounded-xs transition-colors duration-fast",
                          "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
                          missing ? "border border-dashed border-border" : "border border-black/[0.04] dark:border-white/[0.05]",
                          interactive && "cursor-pointer hover:ring-1 hover:ring-accent-border",
                        )}
                        style={{
                          width: cellSize,
                          height: cellSize,
                          backgroundColor: fillFor(cell.value),
                        }}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {showLegend ? (
        <div className="flex items-center gap-2 text-meta text-content-subtle">
          <span className="inline-flex items-center gap-1">
            <span
              className="inline-block rounded-xs border border-dashed border-border"
              style={{ width: cellSize, height: cellSize }}
              aria-hidden="true"
            />
            Not reported
          </span>
          <span className="ml-auto inline-flex items-center gap-1">
            Less
            {(scale === "diverging"
              ? [-1, -0.5, 0, 0.5, 1].map((t) => divergingColor(t))
              : [SEQUENTIAL_ZERO, ...sequentialSteps(levels - 1, hue)]
            ).map((fill, index) => (
              <span
                key={index}
                className="inline-block rounded-xs border border-black/[0.04] dark:border-white/[0.05]"
                style={{ width: cellSize, height: cellSize, backgroundColor: fill }}
                aria-hidden="true"
              />
            ))}
            More
          </span>
        </div>
      ) : null}
    </div>
  );
}
