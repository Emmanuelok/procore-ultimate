/**
 * charts/gantt.tsx — GanttChart.
 *
 * A real schedule view, not a bar chart wearing a costume:
 *
 *   · WBS tree in a frozen left column, collapsible, full ARIA tree keyboard model
 *   · task bars with progress fill, milestones as diamonds, summary brackets
 *   · baseline comparison bars under each task
 *   · dependency arrows (FS / SS / FF / SF) routed orthogonally
 *   · critical-path highlighting, on bars and on the links between them
 *   · today marker, two-tier calendar header
 *   · zoom by day / week / month / quarter, drag to pan, keyboard pan and zoom
 *
 * Recharts has no concept of any of this, so it is drawn directly. Everything
 * still speaks in design-system tokens, so it re-themes with the rest of the app.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { cx } from "../cx";
import {
  IconCalendarCheck,
  IconChevronDown,
  IconChevronRight,
  IconGantt,
  IconMinus,
  IconPlus,
} from "../icons";
import type { Tone } from "../tokens";
import { useReducedMotion } from "../motion";
import { ChartDataTable, ChartEmpty, ChartLoading } from "./primitives";
import { toneColor, withAlpha } from "./palette";
import { formatChartDate, toChartDate } from "./format";
import {
  addDays,
  addMonths,
  diffDays,
  isSameDay,
  isWeekend,
  startOfMonth,
  startOfQuarter,
  startOfWeek,
  startOfYear,
} from "./time";
import type { ChartStateProps } from "./types";

/* ============================================================================
   Model
============================================================================ */

export type GanttLinkType = "FS" | "SS" | "FF" | "SF";

export interface GanttLink {
  /** Predecessor task id. */
  from: string;
  /** Successor task id. */
  to: string;
  type?: GanttLinkType;
  /** Lag in days, shown in the link tooltip. */
  lag?: number;
}

export interface GanttTask {
  id: string;
  name: string;
  start?: Date | string | number | null;
  end?: Date | string | number | null;
  /** Parent WBS node. Omit for a root row. */
  parentId?: string | null;
  /** 0…1. Omit when progress has not been reported — no bar fill is drawn. */
  progress?: number | null;
  /** On the critical path. */
  critical?: boolean;
  /** Zero-duration event; drawn as a diamond. */
  milestone?: boolean;
  baselineStart?: Date | string | number | null;
  baselineEnd?: Date | string | number | null;
  /** Predecessors. Strings are finish-to-start. */
  dependencies?: ReadonlyArray<string | { id: string; type?: GanttLinkType; lag?: number }>;
  tone?: Tone;
  color?: string;
  /** Rendered under the task name in the WBS column. */
  meta?: ReactNode;
  /** Collapse this summary row on first render. */
  defaultCollapsed?: boolean;
}

export type GanttZoom = "day" | "week" | "month" | "quarter";

export const GANTT_ZOOMS: readonly GanttZoom[] = ["day", "week", "month", "quarter"];

const ZOOM_PX_PER_DAY: Record<GanttZoom, number> = {
  day: 26,
  week: 9,
  month: 2.8,
  quarter: 1.15,
};

const ZOOM_LABEL: Record<GanttZoom, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
  quarter: "Quarter",
};

export interface GanttChartProps extends ChartStateProps {
  tasks: ReadonlyArray<GanttTask>;
  /** Links declared centrally. Merged with per-task `dependencies`. */
  links?: ReadonlyArray<GanttLink>;
  /** Controlled zoom. */
  zoom?: GanttZoom;
  defaultZoom?: GanttZoom;
  onZoomChange?: (zoom: GanttZoom) => void;
  /** Force the visible window. Defaults to the span of the tasks, padded. */
  start?: Date | string | number;
  end?: Date | string | number;
  /** Overrides "now" — useful for tests and for reporting as-at a data date. */
  today?: Date | string | number;
  showToday?: boolean;
  showBaseline?: boolean;
  showDependencies?: boolean;
  highlightCriticalPath?: boolean;
  showWeekends?: boolean;
  rowHeight?: number;
  /** Width of the frozen WBS column in px. Default 260. */
  nameColumnWidth?: number;
  /** Viewport height. The grid scrolls inside it. Default 420. */
  height?: number | string;
  /** Zoom / today toolbar. Default true. */
  controls?: boolean;
  /** Controlled expansion. */
  expandedIds?: ReadonlyArray<string>;
  defaultCollapsedIds?: ReadonlyArray<string>;
  onExpandedChange?: (ids: string[]) => void;
  selectedId?: string | null;
  onSelectTask?: (task: GanttTask) => void;
  ariaLabel?: string;
  dataTable?: boolean;
  dataTableLabel?: string;
  footnote?: ReactNode;
  className?: string;
}

/* ============================================================================
   Internal row model
============================================================================ */

interface GanttRow {
  task: GanttTask;
  id: string;
  depth: number;
  hasChildren: boolean;
  /** Dates after summary roll-up. */
  start: Date | null;
  end: Date | null;
  /** True when the dates were rolled up from children rather than supplied. */
  derived: boolean;
  baselineStart: Date | null;
  baselineEnd: Date | null;
}

interface Tick {
  x: number;
  width: number;
  label: string;
  key: string;
  isToday?: boolean;
}

function normalizeLinks(
  tasks: ReadonlyArray<GanttTask>,
  extra: ReadonlyArray<GanttLink> | undefined,
): GanttLink[] {
  const out: GanttLink[] = [];
  for (const task of tasks) {
    for (const dependency of task.dependencies ?? []) {
      if (typeof dependency === "string") {
        out.push({ from: dependency, to: task.id, type: "FS" });
      } else {
        out.push({
          from: dependency.id,
          to: task.id,
          type: dependency.type ?? "FS",
          ...(dependency.lag !== undefined ? { lag: dependency.lag } : {}),
        });
      }
    }
  }
  for (const link of extra ?? []) out.push({ type: "FS", ...link });
  return out;
}

/* ============================================================================
   Component
============================================================================ */

export function GanttChart({
  tasks,
  links,
  zoom: zoomProp,
  defaultZoom = "week",
  onZoomChange,
  start,
  end,
  today,
  showToday = true,
  showBaseline = true,
  showDependencies = true,
  highlightCriticalPath = true,
  showWeekends = true,
  rowHeight = 30,
  nameColumnWidth = 260,
  height = 420,
  controls = true,
  expandedIds,
  defaultCollapsedIds,
  onExpandedChange,
  selectedId,
  onSelectTask,
  ariaLabel = "Project schedule",
  dataTable = true,
  dataTableLabel,
  footnote,
  className,
  ...state
}: GanttChartProps) {
  const reduced = useReducedMotion();
  const gridId = useId().replace(/[^a-zA-Z0-9-]/g, "");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [internalZoom, setInternalZoom] = useState<GanttZoom>(defaultZoom);
  const zoom = zoomProp ?? internalZoom;

  const setZoom = useCallback(
    (next: GanttZoom) => {
      if (zoomProp === undefined) setInternalZoom(next);
      onZoomChange?.(next);
    },
    [zoomProp, onZoomChange],
  );

  /* ---------------------------------------------------------------- tree */

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () =>
      new Set([
        ...(defaultCollapsedIds ?? []),
        ...tasks.filter((task) => task.defaultCollapsed).map((task) => task.id),
      ]),
  );

  const effectiveCollapsed = useMemo(() => {
    if (!expandedIds) return collapsed;
    const open = new Set(expandedIds);
    return new Set(tasks.filter((task) => !open.has(task.id)).map((task) => task.id));
  }, [expandedIds, collapsed, tasks]);

  const childrenOf = useMemo(() => {
    const map = new Map<string | null, GanttTask[]>();
    for (const task of tasks) {
      const parent = task.parentId ?? null;
      const bucket = map.get(parent);
      if (bucket) bucket.push(task);
      else map.set(parent, [task]);
    }
    return map;
  }, [tasks]);

  /** Depth-first, parents before children, with summary dates rolled up. */
  const allRows = useMemo<GanttRow[]>(() => {
    const out: GanttRow[] = [];
    const seen = new Set<string>();

    const spanOf = (task: GanttTask): { start: Date | null; end: Date | null; derived: boolean } => {
      const ownStart = toChartDate(task.start ?? null);
      const ownEnd = toChartDate(task.end ?? null);
      if (ownStart && ownEnd) return { start: ownStart, end: ownEnd, derived: false };
      if (ownStart && !ownEnd) return { start: ownStart, end: ownStart, derived: false };

      const kids = childrenOf.get(task.id) ?? [];
      if (kids.length === 0) return { start: ownStart, end: ownEnd, derived: false };
      let lo: Date | null = null;
      let hi: Date | null = null;
      for (const kid of kids) {
        const child = spanOf(kid);
        if (child.start && (!lo || child.start < lo)) lo = child.start;
        if (child.end && (!hi || child.end > hi)) hi = child.end;
      }
      return { start: lo, end: hi, derived: true };
    };

    const walk = (parentId: string | null, depth: number) => {
      for (const task of childrenOf.get(parentId) ?? []) {
        if (seen.has(task.id)) continue;
        seen.add(task.id);
        const kids = childrenOf.get(task.id) ?? [];
        const span = spanOf(task);
        out.push({
          task,
          id: task.id,
          depth,
          hasChildren: kids.length > 0,
          start: span.start,
          end: span.end,
          derived: span.derived,
          baselineStart: toChartDate(task.baselineStart ?? null),
          baselineEnd: toChartDate(task.baselineEnd ?? null),
        });
        walk(task.id, depth + 1);
      }
    };

    walk(null, 0);
    // Orphans (parentId pointing at a task that is not in the list) still show.
    for (const task of tasks) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      const span = spanOf(task);
      out.push({
        task,
        id: task.id,
        depth: 0,
        hasChildren: false,
        start: span.start,
        end: span.end,
        derived: span.derived,
        baselineStart: toChartDate(task.baselineStart ?? null),
        baselineEnd: toChartDate(task.baselineEnd ?? null),
      });
    }
    return out;
  }, [tasks, childrenOf]);

  const hiddenIds = useMemo(() => {
    const hidden = new Set<string>();
    const hide = (parentId: string) => {
      for (const child of childrenOf.get(parentId) ?? []) {
        hidden.add(child.id);
        hide(child.id);
      }
    };
    for (const id of effectiveCollapsed) hide(id);
    return hidden;
  }, [effectiveCollapsed, childrenOf]);

  const rows = useMemo(
    () => allRows.filter((row) => !hiddenIds.has(row.id)),
    [allRows, hiddenIds],
  );

  const rowIndexById = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, index) => map.set(row.id, index));
    return map;
  }, [rows]);

  const toggleRow = useCallback(
    (id: string) => {
      const next = new Set(effectiveCollapsed);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      if (expandedIds) {
        onExpandedChange?.(allRows.filter((row) => !next.has(row.id)).map((row) => row.id));
      } else {
        setCollapsed(next);
        onExpandedChange?.(allRows.filter((row) => !next.has(row.id)).map((row) => row.id));
      }
    },
    [effectiveCollapsed, expandedIds, onExpandedChange, allRows],
  );

  /* --------------------------------------------------------------- scale */

  const nowDate = useMemo(() => toChartDate(today ?? null) ?? new Date(), [today]);

  const viewport = useMemo(() => {
    const explicitStart = toChartDate(start ?? null);
    const explicitEnd = toChartDate(end ?? null);
    let lo: Date | null = explicitStart;
    let hi: Date | null = explicitEnd;
    if (!lo || !hi) {
      for (const row of allRows) {
        for (const date of [row.start, row.end, row.baselineStart, row.baselineEnd]) {
          if (!date) continue;
          if (!lo || date < lo) lo = explicitStart ?? date;
          if (!hi || date > hi) hi = explicitEnd ?? date;
        }
      }
    }
    if (!lo || !hi) return null;
    const padDays = zoom === "day" ? 3 : zoom === "week" ? 7 : zoom === "month" ? 20 : 45;
    const from =
      zoom === "day" || zoom === "week"
        ? startOfWeek(addDays(lo, -padDays))
        : zoom === "month"
          ? startOfMonth(addDays(lo, -padDays))
          : startOfQuarter(addDays(lo, -padDays));
    const to = addDays(hi, padDays);
    return { from, to };
  }, [allRows, start, end, zoom]);

  const pxPerDay = ZOOM_PX_PER_DAY[zoom];
  const totalDays = viewport ? Math.max(diffDays(viewport.from, viewport.to) + 1, 1) : 0;
  const timelineWidth = Math.max(Math.round(totalDays * pxPerDay), 240);

  const xFor = useCallback(
    (date: Date): number => (viewport ? diffDays(viewport.from, date) * pxPerDay : 0),
    [viewport, pxPerDay],
  );

  const ticks = useMemo(() => {
    if (!viewport) return { major: [] as Tick[], minor: [] as Tick[] };
    const major: Tick[] = [];
    const minor: Tick[] = [];
    const limit = viewport.to.getTime();

    if (zoom === "day" || zoom === "week") {
      let cursor = startOfMonth(viewport.from);
      while (cursor.getTime() <= limit) {
        const next = addMonths(cursor, 1);
        const x = xFor(cursor);
        major.push({
          key: `m-${cursor.getTime()}`,
          x,
          width: xFor(next) - x,
          label: formatChartDate(cursor, "monthYear"),
        });
        cursor = next;
      }
    } else {
      let cursor = startOfYear(viewport.from);
      while (cursor.getTime() <= limit) {
        const next = new Date(cursor.getFullYear() + 1, 0, 1);
        const x = xFor(cursor);
        major.push({
          key: `y-${cursor.getTime()}`,
          x,
          width: xFor(next) - x,
          label: String(cursor.getFullYear()),
        });
        cursor = next;
      }
    }

    if (zoom === "day") {
      let cursor = viewport.from;
      while (cursor.getTime() <= limit) {
        minor.push({
          key: `d-${cursor.getTime()}`,
          x: xFor(cursor),
          width: pxPerDay,
          label: String(cursor.getDate()),
          isToday: isSameDay(cursor, nowDate),
        });
        cursor = addDays(cursor, 1);
      }
    } else if (zoom === "week") {
      let cursor = startOfWeek(viewport.from);
      while (cursor.getTime() <= limit) {
        minor.push({
          key: `w-${cursor.getTime()}`,
          x: xFor(cursor),
          width: pxPerDay * 7,
          label: formatChartDate(cursor, "dayShort"),
        });
        cursor = addDays(cursor, 7);
      }
    } else if (zoom === "month") {
      let cursor = startOfMonth(viewport.from);
      while (cursor.getTime() <= limit) {
        const next = addMonths(cursor, 1);
        const x = xFor(cursor);
        minor.push({
          key: `mm-${cursor.getTime()}`,
          x,
          width: xFor(next) - x,
          label: formatChartDate(cursor, "month"),
        });
        cursor = next;
      }
    } else {
      let cursor = startOfQuarter(viewport.from);
      while (cursor.getTime() <= limit) {
        const next = addMonths(cursor, 3);
        const x = xFor(cursor);
        minor.push({
          key: `q-${cursor.getTime()}`,
          x,
          width: xFor(next) - x,
          label: `Q${Math.floor(cursor.getMonth() / 3) + 1}`,
        });
        cursor = next;
      }
    }

    return { major, minor };
  }, [viewport, zoom, xFor, pxPerDay, nowDate]);

  const weekendBands = useMemo(() => {
    if (!showWeekends || !viewport || zoom !== "day") return [];
    const out: Array<{ key: string; x: number; width: number }> = [];
    let cursor = viewport.from;
    while (cursor.getTime() <= viewport.to.getTime()) {
      if (isWeekend(cursor)) {
        out.push({ key: `we-${cursor.getTime()}`, x: xFor(cursor), width: pxPerDay });
      }
      cursor = addDays(cursor, 1);
    }
    return out;
  }, [showWeekends, viewport, zoom, xFor, pxPerDay]);

  const todayX = viewport && showToday ? xFor(nowDate) : null;
  const todayVisible =
    todayX !== null && viewport !== null && nowDate >= viewport.from && nowDate <= viewport.to;

  /* ------------------------------------------------------------ scroll */

  const scrollToToday = useCallback(() => {
    const node = scrollRef.current;
    if (!node || todayX === null) return;
    node.scrollTo({
      left: Math.max(todayX - node.clientWidth / 2 + nameColumnWidth, 0),
      behavior: reduced ? "auto" : "smooth",
    });
  }, [todayX, nameColumnWidth, reduced]);

  const didInitialScroll = useRef(false);
  useEffect(() => {
    if (didInitialScroll.current || !todayVisible) return;
    didInitialScroll.current = true;
    const node = scrollRef.current;
    if (!node || todayX === null) return;
    node.scrollLeft = Math.max(todayX - node.clientWidth / 2 + nameColumnWidth, 0);
  }, [todayVisible, todayX, nameColumnWidth]);

  /* --------------------------------------------------------- drag to pan */

  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  /** Set while a pan is in progress so the pointerup does not also select a row. */
  const panned = useRef(false);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, a, [role='treeitem'] [tabindex='0']")) return;
    const node = scrollRef.current;
    if (!node) return;
    drag.current = { x: event.clientX, y: event.clientY, left: node.scrollLeft, top: node.scrollTop };
    panned.current = false;
    setDragging(true);
    node.setPointerCapture?.(event.pointerId);
  }, []);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = drag.current;
    const node = scrollRef.current;
    if (!origin || !node) return;
    const dx = event.clientX - origin.x;
    const dy = event.clientY - origin.y;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) panned.current = true;
    node.scrollLeft = origin.left - dx;
    node.scrollTop = origin.top - dy;
  }, []);

  const endDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null;
    setDragging(false);
    scrollRef.current?.releasePointerCapture?.(event.pointerId);
  }, []);

  /* ---------------------------------------------------------- keyboard */

  const [focusedId, setFocusedId] = useState<string | null>(null);

  const focusRow = useCallback((id: string) => {
    setFocusedId(id);
    scrollRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`)?.focus();
  }, []);

  const onRowKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, row: GanttRow, index: number) => {
      switch (event.key) {
        case "ArrowDown": {
          event.preventDefault();
          const next = rows[index + 1];
          if (next) focusRow(next.id);
          break;
        }
        case "ArrowUp": {
          event.preventDefault();
          const previous = rows[index - 1];
          if (previous) focusRow(previous.id);
          break;
        }
        case "ArrowRight": {
          event.preventDefault();
          if (row.hasChildren && effectiveCollapsed.has(row.id)) toggleRow(row.id);
          else {
            const next = rows[index + 1];
            if (next && next.depth > row.depth) focusRow(next.id);
          }
          break;
        }
        case "ArrowLeft": {
          event.preventDefault();
          if (row.hasChildren && !effectiveCollapsed.has(row.id)) toggleRow(row.id);
          else {
            const parent = rows
              .slice(0, index)
              .reverse()
              .find((candidate) => candidate.depth < row.depth);
            if (parent) focusRow(parent.id);
          }
          break;
        }
        case "Home": {
          event.preventDefault();
          const first = rows[0];
          if (first) focusRow(first.id);
          break;
        }
        case "End": {
          event.preventDefault();
          const last = rows[rows.length - 1];
          if (last) focusRow(last.id);
          break;
        }
        case "Enter":
        case " ": {
          if (onSelectTask) {
            event.preventDefault();
            onSelectTask(row.task);
          } else if (row.hasChildren) {
            event.preventDefault();
            toggleRow(row.id);
          }
          break;
        }
        case "+":
        case "=": {
          event.preventDefault();
          const at = GANTT_ZOOMS.indexOf(zoom);
          const next = GANTT_ZOOMS[Math.max(at - 1, 0)];
          if (next) setZoom(next);
          break;
        }
        case "-":
        case "_": {
          event.preventDefault();
          const at = GANTT_ZOOMS.indexOf(zoom);
          const next = GANTT_ZOOMS[Math.min(at + 1, GANTT_ZOOMS.length - 1)];
          if (next) setZoom(next);
          break;
        }
        case "t":
        case "T": {
          event.preventDefault();
          scrollToToday();
          break;
        }
        default:
          break;
      }
    },
    [rows, effectiveCollapsed, toggleRow, focusRow, onSelectTask, zoom, setZoom, scrollToToday],
  );

  /* ------------------------------------------------------------- links */

  const allLinks = useMemo(() => normalizeLinks(tasks, links), [tasks, links]);

  const linkPaths = useMemo(() => {
    if (!showDependencies || !viewport) return [];
    const criticalIds = new Set(allRows.filter((row) => row.task.critical).map((row) => row.id));
    const out: Array<{ key: string; d: string; critical: boolean; title: string }> = [];

    for (const link of allLinks) {
      const fromIndex = rowIndexById.get(link.from);
      const toIndex = rowIndexById.get(link.to);
      if (fromIndex === undefined || toIndex === undefined) continue;
      const fromRow = rows[fromIndex];
      const toRow = rows[toIndex];
      if (!fromRow || !toRow || !fromRow.start || !fromRow.end || !toRow.start || !toRow.end) continue;

      const type = link.type ?? "FS";
      const fromDate = type === "SS" || type === "SF" ? fromRow.start : fromRow.end;
      const toDate = type === "FF" || type === "SF" ? toRow.end : toRow.start;
      const fromAtEnd = type === "FS" || type === "FF";
      const toAtStart = type === "FS" || type === "SS";

      const x1 = xFor(fromDate) + (fromAtEnd ? Math.max(pxPerDay, 2) : 0);
      const x2 = xFor(toDate) + (toAtStart ? 0 : Math.max(pxPerDay, 2));
      const y1 = fromIndex * rowHeight + rowHeight / 2;
      const y2 = toIndex * rowHeight + rowHeight / 2;

      const stub = 10;
      const arrowGap = 6;
      const outX = fromAtEnd ? x1 + stub : x1 - stub;
      const inX = toAtStart ? x2 - arrowGap : x2 + arrowGap;

      let d: string;
      const forwards = toAtStart ? inX >= outX : inX <= outX;
      if (forwards) {
        const midX = toAtStart ? Math.max(outX, inX - stub) : Math.min(outX, inX + stub);
        d = `M${x1} ${y1} L${outX} ${y1} L${midX} ${y1} L${midX} ${y2} L${inX} ${y2}`;
      } else {
        const backY = y1 + (y2 > y1 ? rowHeight / 2 : -rowHeight / 2);
        d = `M${x1} ${y1} L${outX} ${y1} L${outX} ${backY} L${inX} ${backY} L${inX} ${y2}`;
      }

      const critical =
        highlightCriticalPath && criticalIds.has(link.from) && criticalIds.has(link.to);
      out.push({
        key: `${link.from}->${link.to}-${type}`,
        d,
        critical,
        title: `${fromRow.task.name} → ${toRow.task.name} (${type}${link.lag ? `, ${link.lag}d lag` : ""})`,
      });
    }
    return out;
  }, [
    showDependencies,
    viewport,
    allLinks,
    rowIndexById,
    rows,
    allRows,
    xFor,
    pxPerDay,
    rowHeight,
    highlightCriticalPath,
  ]);

  /* -------------------------------------------------------------- state */

  const bodyHeight = rows.length * rowHeight;
  const headerHeight = 48;

  if (state.loading) {
    return (
      <div className={cx("w-full", className)} style={{ height }}>
        <ChartLoading variant="block" />
      </div>
    );
  }

  if (state.error) {
    const message = state.error instanceof Error ? state.error.message : state.error;
    return (
      <div className={cx("w-full", className)} style={{ height }}>
        <ChartEmpty title="Schedule unavailable" message={message} icon={IconGantt} />
      </div>
    );
  }

  if (rows.length === 0 || !viewport || state.empty) {
    return (
      <div className={cx("w-full", className)} style={{ height }}>
        <ChartEmpty
          title={state.emptyTitle ?? "No schedule"}
          message={
            state.emptyMessage ??
            "No activities with dates have been imported for this project, so there is nothing to plot."
          }
          action={state.emptyAction}
          icon={IconGantt}
        />
      </div>
    );
  }

  const tableRows = allRows.map((row) => ({
    label: `${"— ".repeat(row.depth)}${row.task.name}`,
    values: [
      row.start ? formatChartDate(row.start, "day") : "—",
      row.end ? formatChartDate(row.end, "day") : "—",
      row.start && row.end ? `${diffDays(row.start, row.end) + 1}d` : "—",
      row.task.progress == null ? "—" : `${Math.round(row.task.progress * 100)}%`,
      row.task.critical ? "Yes" : "No",
    ],
  }));

  return (
    <figure className={cx("m-0 flex min-w-0 flex-col gap-2", className)} aria-label={ariaLabel}>
      {controls ? (
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="Timeline zoom"
            className="inline-flex items-center rounded-md border border-border bg-surface-raised p-0.5"
          >
            {GANTT_ZOOMS.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={zoom === option}
                onClick={() => setZoom(option)}
                className={cx(
                  "rounded-sm px-2 py-1 text-meta transition-colors duration-fast",
                  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
                  zoom === option
                    ? "bg-surface-selected font-medium text-content"
                    : "text-content-muted hover:bg-surface-hover hover:text-content",
                )}
              >
                {ZOOM_LABEL[option]}
              </button>
            ))}
          </div>

          <div className="inline-flex items-center gap-1">
            <button
              type="button"
              aria-label="Zoom out"
              onClick={() => {
                const at = GANTT_ZOOMS.indexOf(zoom);
                const next = GANTT_ZOOMS[Math.min(at + 1, GANTT_ZOOMS.length - 1)];
                if (next) setZoom(next);
              }}
              className="grid size-control-sm place-items-center rounded-md border border-border bg-surface-raised text-content-muted hover:bg-surface-hover hover:text-content"
            >
              <IconMinus size="sm" />
            </button>
            <button
              type="button"
              aria-label="Zoom in"
              onClick={() => {
                const at = GANTT_ZOOMS.indexOf(zoom);
                const next = GANTT_ZOOMS[Math.max(at - 1, 0)];
                if (next) setZoom(next);
              }}
              className="grid size-control-sm place-items-center rounded-md border border-border bg-surface-raised text-content-muted hover:bg-surface-hover hover:text-content"
            >
              <IconPlus size="sm" />
            </button>
          </div>

          {todayVisible ? (
            <button
              type="button"
              onClick={scrollToToday}
              className="inline-flex h-control-sm items-center gap-1.5 rounded-md border border-border bg-surface-raised px-2 text-meta text-content-muted hover:bg-surface-hover hover:text-content"
            >
              <IconCalendarCheck size="sm" />
              Today
            </button>
          ) : null}

          {highlightCriticalPath ? (
            <span className="ml-auto inline-flex items-center gap-1.5 text-meta text-content-subtle">
              <span
                className="h-1.5 w-4 rounded-full"
                style={{ backgroundColor: toneColor("danger") }}
                aria-hidden="true"
              />
              Critical path
            </span>
          ) : null}
        </div>
      ) : null}

      <div
        ref={scrollRef}
        className={cx(
          "relative overflow-auto rounded-lg border border-border bg-surface-raised",
          dragging ? "cursor-grabbing select-none" : "cursor-grab",
        )}
        style={{ height }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="relative" style={{ width: nameColumnWidth + timelineWidth }}>
          {/* ------------------------------------------------------ header */}
          <div
            className="sticky top-0 z-30 flex bg-surface-raised"
            style={{ height: headerHeight }}
          >
            <div
              className="sticky left-0 z-40 flex shrink-0 items-end border-b border-r border-border bg-surface-raised px-3 pb-1.5"
              style={{ width: nameColumnWidth }}
            >
              <span className="text-label uppercase text-content-subtle">Activity</span>
            </div>
            <div className="relative shrink-0 border-b border-border" style={{ width: timelineWidth }}>
              <div className="relative h-6 border-b border-border-subtle">
                {ticks.major.map((tick) => (
                  <span
                    key={tick.key}
                    className="absolute top-0 flex h-6 items-center overflow-hidden whitespace-nowrap border-l border-border-subtle px-1.5 text-meta font-medium text-content-muted"
                    style={{ left: tick.x, width: tick.width }}
                  >
                    {tick.width > 44 ? tick.label : ""}
                  </span>
                ))}
              </div>
              <div className="relative h-6">
                {ticks.minor.map((tick) => (
                  <span
                    key={tick.key}
                    className={cx(
                      "absolute top-0 flex h-6 items-center justify-center overflow-hidden whitespace-nowrap border-l border-border-subtle text-2xs tabular-nums",
                      tick.isToday ? "font-semibold text-accent-text" : "text-content-subtle",
                    )}
                    style={{ left: tick.x, width: tick.width }}
                  >
                    {tick.width > 18 ? tick.label : ""}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* -------------------------------------------------------- body */}
          <div className="relative" style={{ height: Math.max(bodyHeight, 1) }}>
            {/* grid + weekend + today, drawn once behind the rows */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0"
              style={{ left: nameColumnWidth, width: timelineWidth }}
            >
              {weekendBands.map((band) => (
                <span
                  key={band.key}
                  className="absolute inset-y-0 bg-surface-sunken"
                  style={{ left: band.x, width: band.width }}
                />
              ))}
              {ticks.minor.map((tick) => (
                <span
                  key={`grid-${tick.key}`}
                  className="absolute inset-y-0 w-px bg-chart-grid"
                  style={{ left: tick.x }}
                />
              ))}
              {todayVisible && todayX !== null ? (
                <span
                  className="absolute inset-y-0 w-px"
                  style={{ left: todayX, backgroundColor: "var(--ds-accent)" }}
                />
              ) : null}
            </div>

            {/* dependency arrows */}
            {showDependencies && linkPaths.length > 0 ? (
              <svg
                aria-hidden="true"
                className="pointer-events-none absolute top-0"
                style={{ left: nameColumnWidth, width: timelineWidth, height: bodyHeight }}
                width={timelineWidth}
                height={bodyHeight}
              >
                <defs>
                  <marker
                    id={`${gridId}-arrow`}
                    viewBox="0 0 8 8"
                    refX="7"
                    refY="4"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M0 1 L7 4 L0 7 z" fill="var(--ds-content-subtle)" />
                  </marker>
                  <marker
                    id={`${gridId}-arrow-critical`}
                    viewBox="0 0 8 8"
                    refX="7"
                    refY="4"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M0 1 L7 4 L0 7 z" fill="var(--ds-danger-solid)" />
                  </marker>
                </defs>
                {linkPaths.map((path) => (
                  <path
                    key={path.key}
                    d={path.d}
                    fill="none"
                    stroke={path.critical ? "var(--ds-danger-solid)" : "var(--ds-content-subtle)"}
                    strokeOpacity={path.critical ? 0.9 : 0.5}
                    strokeWidth={path.critical ? 1.5 : 1}
                    markerEnd={`url(#${gridId}-${path.critical ? "arrow-critical" : "arrow"})`}
                  >
                    <title>{path.title}</title>
                  </path>
                ))}
              </svg>
            ) : null}

            {/* rows */}
            <div role="tree" aria-label={ariaLabel}>
              {rows.map((row, index) => {
                const isCollapsed = effectiveCollapsed.has(row.id);
                const selected = selectedId === row.id;
                const critical = highlightCriticalPath && row.task.critical === true;
                const barColor =
                  row.task.color ??
                  (row.task.tone
                    ? toneColor(row.task.tone)
                    : critical
                      ? toneColor("danger")
                      : row.hasChildren
                        ? "var(--ds-content-muted)"
                        : "var(--ds-accent)");

                const hasSpan = row.start !== null && row.end !== null;
                const x = hasSpan ? xFor(row.start as Date) : 0;
                const spanDays = hasSpan ? diffDays(row.start as Date, row.end as Date) + 1 : 0;
                const w = Math.max(spanDays * pxPerDay, 3);
                const progress =
                  row.task.progress == null || !Number.isFinite(row.task.progress)
                    ? null
                    : Math.max(0, Math.min(1, row.task.progress));

                const baselineOk = showBaseline && row.baselineStart && row.baselineEnd;
                const bx = baselineOk ? xFor(row.baselineStart as Date) : 0;
                const bw = baselineOk
                  ? Math.max(
                      (diffDays(row.baselineStart as Date, row.baselineEnd as Date) + 1) * pxPerDay,
                      3,
                    )
                  : 0;

                const dateSummary = hasSpan
                  ? `${formatChartDate(row.start, "day")} to ${formatChartDate(row.end, "day")}`
                  : "no dates recorded";

                return (
                  <div
                    key={row.id}
                    role="treeitem"
                    data-row={row.id}
                    aria-level={row.depth + 1}
                    aria-expanded={row.hasChildren ? !isCollapsed : undefined}
                    aria-selected={selected || undefined}
                    aria-label={`${row.task.name}, ${dateSummary}${
                      progress !== null ? `, ${Math.round(progress * 100)}% complete` : ""
                    }${critical ? ", on the critical path" : ""}`}
                    tabIndex={
                      (focusedId ?? selectedId ?? rows[0]?.id) === row.id ? 0 : -1
                    }
                    onFocus={() => setFocusedId(row.id)}
                    onKeyDown={(event) => onRowKeyDown(event, row, index)}
                    onClick={() => {
                      if (panned.current) return;
                      onSelectTask?.(row.task);
                    }}
                    className={cx(
                      "group relative flex items-stretch outline-none",
                      "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                      selected ? "bg-surface-selected" : "hover:bg-surface-hover/70",
                    )}
                    style={{ height: rowHeight }}
                  >
                    {/* WBS cell */}
                    <div
                      className={cx(
                        "sticky left-0 z-20 flex shrink-0 items-center gap-1 border-r border-border pr-2",
                        selected ? "bg-surface-selected" : "bg-surface-raised group-hover:bg-surface-hover",
                      )}
                      style={{ width: nameColumnWidth, paddingLeft: 8 + row.depth * 14 }}
                    >
                      {row.hasChildren ? (
                        <button
                          type="button"
                          tabIndex={-1}
                          aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${row.task.name}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleRow(row.id);
                          }}
                          className="grid size-4 shrink-0 place-items-center rounded-xs text-content-subtle hover:bg-surface-active hover:text-content"
                        >
                          {isCollapsed ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
                        </button>
                      ) : (
                        <span className="size-4 shrink-0" aria-hidden="true" />
                      )}
                      <span className="min-w-0 flex-1 truncate">
                        <span
                          className={cx(
                            "block truncate text-meta",
                            row.hasChildren ? "font-semibold text-content" : "text-content-muted",
                          )}
                        >
                          {row.task.name}
                        </span>
                        {row.task.meta ? (
                          <span className="block truncate text-2xs text-content-subtle">
                            {row.task.meta}
                          </span>
                        ) : null}
                      </span>
                      {critical ? (
                        <span
                          className="size-1.5 shrink-0 rounded-full"
                          style={{ backgroundColor: toneColor("danger") }}
                          title="Critical path"
                          aria-hidden="true"
                        />
                      ) : null}
                    </div>

                    {/* timeline cell */}
                    <div className="relative shrink-0" style={{ width: timelineWidth }}>
                      {!hasSpan ? (
                        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-2xs italic text-content-subtle">
                          No dates recorded
                        </span>
                      ) : row.task.milestone ? (
                        <span
                          className="absolute top-1/2 block -translate-y-1/2 rotate-45 rounded-[2px]"
                          style={{
                            left: x - 5,
                            width: 10,
                            height: 10,
                            backgroundColor: barColor,
                            boxShadow: "0 0 0 1px var(--ds-surface-raised)",
                          }}
                          title={`${row.task.name} — ${formatChartDate(row.start, "day")}`}
                        />
                      ) : (
                        <>
                          {baselineOk ? (
                            <span
                              className="absolute rounded-full"
                              style={{
                                left: bx,
                                width: bw,
                                height: 3,
                                bottom: 3,
                                backgroundColor: "var(--ds-content-subtle)",
                                opacity: 0.5,
                              }}
                              title={`Baseline: ${formatChartDate(row.baselineStart, "day")} to ${formatChartDate(row.baselineEnd, "day")}`}
                            />
                          ) : null}
                          <span
                            className={cx(
                              "absolute top-1/2 block -translate-y-1/2 overflow-hidden",
                              row.hasChildren ? "rounded-[2px]" : "rounded-[3px]",
                            )}
                            style={{
                              left: x,
                              width: w,
                              height: row.hasChildren ? 8 : Math.min(rowHeight - 12, 14),
                              backgroundColor: row.derived ? withAlpha(barColor, 0.35) : withAlpha(barColor, 0.85),
                              border: `1px solid ${withAlpha(barColor, 0.9)}`,
                              marginTop: baselineOk ? -3 : 0,
                            }}
                            title={`${row.task.name} — ${dateSummary}`}
                          >
                            {progress !== null && !row.hasChildren ? (
                              <span
                                className="absolute inset-y-0 left-0 block"
                                style={{
                                  width: `${progress * 100}%`,
                                  backgroundColor: barColor,
                                }}
                              />
                            ) : null}
                          </span>
                          {progress !== null && w > 44 && !row.hasChildren ? (
                            <span
                              className="pointer-events-none absolute top-1/2 -translate-y-1/2 text-2xs font-medium tabular-nums text-content"
                              style={{ left: x + w + 6 }}
                            >
                              {Math.round(progress * 100)}%
                            </span>
                          ) : null}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {footnote ? <figcaption className="text-meta text-content-subtle">{footnote}</figcaption> : null}

      {dataTable ? (
        <ChartDataTable
          caption={ariaLabel}
          categoryHeader="Activity"
          rows={tableRows}
          columns={[
            { key: "start", label: "Start" },
            { key: "finish", label: "Finish" },
            { key: "duration", label: "Duration" },
            { key: "progress", label: "Progress" },
            { key: "critical", label: "Critical" },
          ]}
          summaryLabel={dataTableLabel}
        />
      ) : null}
    </figure>
  );
}
