/**
 * CPM2 — the scheduling engine the schedule module actually runs on.
 *
 * WHAT IT ADDS OVER lib/cpm.ts (which stays untouched and still backs its own
 * unit tests): work calendars, a progress data date, and remaining durations.
 * Those three are the difference between a toy network and a programme a
 * planner would recognise:
 *
 *  - CALENDARS. A duration is a count of WORKING days. A five-day activity on
 *    a Mon-Fri calendar starting Thursday finishes the following Wednesday.
 *    The default calendar is continuous (7 workdays, no holidays), which makes
 *    every result identical to lib/cpm.ts when no calendar is supplied — the
 *    existing behaviour is a special case of this engine, not a variant.
 *  - DATA DATE. Work that has not started cannot be planned before the data
 *    date; remaining work on an in-progress activity is pushed to the data
 *    date. Without this, a statused programme forecasts work in the past.
 *  - REMAINING DURATION. An in-progress activity is driven by what is left,
 *    not by its original duration. Explicit remaining duration wins; otherwise
 *    it is derived from percent complete.
 *
 * Conventions inherited from lib/cpm.ts: whole calendar-day indices relative
 * to `projectStart`; the internal finish is EXCLUSIVE, the reported
 * `finishDate` is the inclusive last worked day; lags may be negative;
 * dependency types FS/SS/FF/SF; a dependency cycle aborts the pass and is
 * reported rather than thrown.
 *
 * Lags are calendar days (as P6 stores them on the relationship), durations
 * are working days. That asymmetry is deliberate and matches P6/MSP.
 *
 * Deliberately NOT here: resource levelling, multiple float paths ranking,
 * and calendar exceptions with part-day working — all out of scope for the
 * dates this platform has to defend.
 */

import type { DependencyType, TaskConstraintType } from "@constructos/shared";
import { dayFromIso, isoFromDay } from "../../lib/cpm.js";

export { dayFromIso, isoFromDay };

/* ------------------------------------------------------------------ */
/* Calendars                                                           */
/* ------------------------------------------------------------------ */

export interface CalendarSpec {
  id: string;
  /** 7 slots indexed by UTC day-of-week (0 = Sunday); 1 = working */
  workdays: number[];
  /** ISO dates that are non-working regardless of weekday */
  holidays: string[];
  /** ISO dates that ARE working even if the weekday says otherwise */
  exceptions: string[];
  hoursPerDay: number;
}

/** Continuous calendar: every day works. Keeps CPM2 ≡ lib/cpm.ts by default. */
export const CONTINUOUS_CALENDAR: CalendarSpec = {
  id: "__continuous",
  workdays: [1, 1, 1, 1, 1, 1, 1],
  holidays: [],
  exceptions: [],
  hoursPerDay: 8,
};

/** Standard five-day working week — the importers' fallback. */
export const FIVE_DAY_CALENDAR: CalendarSpec = {
  id: "__five_day",
  workdays: [0, 1, 1, 1, 1, 1, 0],
  holidays: [],
  exceptions: [],
  hoursPerDay: 8,
};

/** Resolved calendar with O(1) membership tests, built once per compute. */
interface ResolvedCalendar {
  spec: CalendarSpec;
  continuous: boolean;
  holidays: Set<number>;
  exceptions: Set<number>;
}

function resolveCalendar(spec: CalendarSpec, projectStart: string): ResolvedCalendar {
  const holidays = new Set<number>();
  for (const h of spec.holidays) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(h)) holidays.add(dayFromIso(h, projectStart));
  }
  const exceptions = new Set<number>();
  for (const e of spec.exceptions) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(e)) exceptions.add(dayFromIso(e, projectStart));
  }
  const continuous =
    spec.workdays.every((w) => w === 1) && holidays.size === 0;
  return { spec, continuous, holidays, exceptions };
}

/** UTC weekday (0 = Sunday) of a day index relative to projectStart. */
function weekdayOf(day: number, startWeekday: number): number {
  return (((day + startWeekday) % 7) + 7) % 7;
}

/** Bound on how far the engine will scan for the next working day. */
const MAX_NONWORKING_RUN = 400;

/* ------------------------------------------------------------------ */
/* Inputs / outputs                                                    */
/* ------------------------------------------------------------------ */

export interface Cpm2TaskInput {
  id: string;
  /** planned duration in WORKING days; 0 = milestone */
  duration: number;
  /** work left after the data date, in working days; null = derive */
  remainingDuration?: number | null;
  percentComplete?: number | null;
  constraintType?: TaskConstraintType | null;
  constraintDate?: string | null;
  actualStart?: string | null;
  actualFinish?: string | null;
  /** calendar id; falls back to the compute's default calendar */
  calendarId?: string | null;
  /** level-of-effort / summary activities never drive the critical path */
  taskType?: string | null;
}

export interface Cpm2DependencyInput {
  predecessorId: string;
  successorId: string;
  type: DependencyType;
  /** lag in CALENDAR days (may be negative) */
  lagDays: number;
}

export interface Cpm2TaskResult {
  id: string;
  earlyStart: number;
  earlyFinish: number;
  lateStart: number;
  lateFinish: number;
  /** float in WORKING days on the task's own calendar */
  totalFloat: number;
  freeFloat: number;
  isCritical: boolean;
  startDate: string;
  /** inclusive last worked day */
  finishDate: string;
  /** remaining working days used by the forecast */
  remainingDuration: number;
  /** true when the task is complete (actual finish captured) */
  complete: boolean;
}

export interface Cpm2Result {
  ok: boolean;
  cycle: string[];
  tasks: Map<string, Cpm2TaskResult>;
  projectFinishDate: string | null;
  projectDurationDays: number;
  criticalIds: string[];
  /** driving chain from a schedule start to the finishing activity */
  longestPath: string[];
  dataDate: string | null;
}

export interface Cpm2Options {
  projectStart: string;
  /** progress data date; null = the programme has never been statused */
  dataDate?: string | null;
  calendars?: CalendarSpec[];
  defaultCalendarId?: string | null;
}

/* ------------------------------------------------------------------ */
/* Calendar arithmetic                                                 */
/* ------------------------------------------------------------------ */

class CalendarMath {
  private readonly startWeekday: number;

  constructor(
    private readonly cals: Map<string, ResolvedCalendar>,
    private readonly fallback: ResolvedCalendar,
    projectStart: string,
  ) {
    this.startWeekday = new Date(`${projectStart}T00:00:00Z`).getUTCDay();
  }

  get(id: string | null | undefined): ResolvedCalendar {
    if (!id) return this.fallback;
    return this.cals.get(id) ?? this.fallback;
  }

  isWorkday(cal: ResolvedCalendar, day: number): boolean {
    if (cal.continuous) return true;
    if (cal.exceptions.has(day)) return true;
    if (cal.holidays.has(day)) return false;
    return cal.spec.workdays[weekdayOf(day, this.startWeekday)] === 1;
  }

  /** First working day at or after `day`. */
  nextWorkday(cal: ResolvedCalendar, day: number): number {
    if (cal.continuous) return day;
    let d = day;
    for (let i = 0; i < MAX_NONWORKING_RUN; i += 1) {
      if (this.isWorkday(cal, d)) return d;
      d += 1;
    }
    return day; // pathological calendar with no working days — degrade, never hang
  }

  /** Last working day at or before `day`. */
  prevWorkday(cal: ResolvedCalendar, day: number): number {
    if (cal.continuous) return day;
    let d = day;
    for (let i = 0; i < MAX_NONWORKING_RUN; i += 1) {
      if (this.isWorkday(cal, d)) return d;
      d -= 1;
    }
    return day;
  }

  /**
   * Exclusive finish of `n` working days starting at `start` (which is
   * advanced to the next working day first). n = 0 returns start unchanged —
   * a milestone occupies no time.
   */
  addWorkdays(cal: ResolvedCalendar, start: number, n: number): number {
    if (n <= 0) return start;
    if (cal.continuous) return start + n;
    let day = this.nextWorkday(cal, start);
    let left = n;
    let guard = 0;
    while (left > 0 && guard < n * 7 + MAX_NONWORKING_RUN * 2) {
      if (this.isWorkday(cal, day)) left -= 1;
      day += 1;
      guard += 1;
    }
    return day;
  }

  /** Inverse of addWorkdays: the start that yields `finish` after n workdays. */
  subWorkdays(cal: ResolvedCalendar, finish: number, n: number): number {
    if (n <= 0) return finish;
    if (cal.continuous) return finish - n;
    let day = finish - 1;
    let left = n;
    let guard = 0;
    while (left > 0 && guard < n * 7 + MAX_NONWORKING_RUN * 2) {
      if (this.isWorkday(cal, day)) left -= 1;
      if (left > 0) day -= 1;
      guard += 1;
    }
    return day;
  }

  /** Working days in the half-open interval [from, to). Negative when to < from. */
  workdaysBetween(cal: ResolvedCalendar, from: number, to: number): number {
    if (cal.continuous) return to - from;
    const sign = to >= from ? 1 : -1;
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    if (hi - lo > 20_000) return sign * (hi - lo); // absurd span: degrade to calendar days
    let n = 0;
    for (let d = lo; d < hi; d += 1) if (this.isWorkday(cal, d)) n += 1;
    return sign * n;
  }

  /** Inclusive last worked day of a task occupying [start, finishExclusive). */
  inclusiveFinish(cal: ResolvedCalendar, start: number, finishExclusive: number): number {
    if (finishExclusive <= start) return start;
    return this.prevWorkday(cal, finishExclusive - 1);
  }
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

/** Working days still to run on a task, from explicit input or percent complete. */
export function deriveRemaining(task: Cpm2TaskInput): number {
  const duration = Math.max(0, Math.round(task.duration));
  if (task.actualFinish) return 0;
  if (task.remainingDuration != null && Number.isFinite(task.remainingDuration)) {
    return Math.max(0, Math.round(task.remainingDuration));
  }
  const pct = task.percentComplete ?? 0;
  if (!task.actualStart || pct <= 0) return duration;
  if (pct >= 100) return 0;
  return Math.max(0, Math.ceil((duration * (100 - pct)) / 100));
}

const NON_DRIVING_TYPES = new Set(["level_of_effort", "wbs_summary"]);

export function computeCpm2(
  taskInputs: Cpm2TaskInput[],
  deps: Cpm2DependencyInput[],
  options: Cpm2Options,
): Cpm2Result {
  const start = options.projectStart;
  const dataDateIso = options.dataDate ?? null;
  const dataDate = dataDateIso ? dayFromIso(dataDateIso, start) : null;

  const resolved = new Map<string, ResolvedCalendar>();
  for (const c of options.calendars ?? []) resolved.set(c.id, resolveCalendar(c, start));
  const fallback =
    (options.defaultCalendarId ? resolved.get(options.defaultCalendarId) : undefined) ??
    resolveCalendar(CONTINUOUS_CALENDAR, start);
  const cal = new CalendarMath(resolved, fallback, start);

  const ids = new Set(taskInputs.map((t) => t.id));
  const validDeps = deps.filter(
    (d) => ids.has(d.predecessorId) && ids.has(d.successorId) && d.predecessorId !== d.successorId,
  );

  /* ---- topological order (Kahn) ---- */
  const outgoing = new Map<string, Cpm2DependencyInput[]>();
  const incoming = new Map<string, Cpm2DependencyInput[]>();
  const indegree = new Map<string, number>();
  for (const t of taskInputs) indegree.set(t.id, 0);
  for (const d of validDeps) {
    const out = outgoing.get(d.predecessorId);
    if (out) out.push(d);
    else outgoing.set(d.predecessorId, [d]);
    const inc = incoming.get(d.successorId);
    if (inc) inc.push(d);
    else incoming.set(d.successorId, [d]);
    indegree.set(d.successorId, (indegree.get(d.successorId) ?? 0) + 1);
  }
  const queue = taskInputs.filter((t) => (indegree.get(t.id) ?? 0) === 0).map((t) => t.id);
  const topo: string[] = [];
  const work = new Map(indegree);
  while (queue.length > 0) {
    const id = queue.shift()!;
    topo.push(id);
    for (const d of outgoing.get(id) ?? []) {
      const n = (work.get(d.successorId) ?? 0) - 1;
      work.set(d.successorId, n);
      if (n === 0) queue.push(d.successorId);
    }
  }
  if (topo.length !== taskInputs.length) {
    const done = new Set(topo);
    return {
      ok: false,
      cycle: taskInputs.map((t) => t.id).filter((id) => !done.has(id)),
      tasks: new Map(),
      projectFinishDate: null,
      projectDurationDays: 0,
      criticalIds: [],
      longestPath: [],
      dataDate: dataDateIso,
    };
  }

  const byId = new Map(taskInputs.map((t) => [t.id, t] as const));
  const ES = new Map<string, number>();
  const EF = new Map<string, number>();
  const REM = new Map<string, number>();

  /* ---- forward pass ---- */
  for (const id of topo) {
    const t = byId.get(id)!;
    const c = cal.get(t.calendarId);
    const duration = Math.max(0, Math.round(t.duration));
    const remaining = deriveRemaining(t);
    REM.set(id, remaining);

    const aStart = t.actualStart ? dayFromIso(t.actualStart, start) : null;
    const aFinish = t.actualFinish ? dayFromIso(t.actualFinish, start) : null;

    if (aFinish !== null) {
      // Complete: the record wins outright.
      const es = aStart ?? cal.subWorkdays(c, aFinish + 1, Math.max(duration, 1));
      const ef = duration === 0 && aStart !== null && aFinish === aStart ? aFinish : aFinish + 1;
      ES.set(id, es);
      EF.set(id, Math.max(ef, es));
      continue;
    }

    let es = 0;
    for (const dep of incoming.get(id) ?? []) {
      const pES = ES.get(dep.predecessorId)!;
      const pEF = EF.get(dep.predecessorId)!;
      let bound: number;
      switch (dep.type) {
        case "FS":
          bound = pEF + dep.lagDays;
          break;
        case "SS":
          bound = pES + dep.lagDays;
          break;
        case "FF":
          bound = cal.subWorkdays(c, pEF + dep.lagDays, remaining);
          break;
        case "SF":
          bound = cal.subWorkdays(c, pES + dep.lagDays, remaining);
          break;
      }
      es = Math.max(es, bound);
    }
    if (t.constraintType === "start_no_earlier_than" && t.constraintDate) {
      es = Math.max(es, dayFromIso(t.constraintDate, start));
    }
    if (t.constraintType === "must_start_on" && t.constraintDate) {
      es = dayFromIso(t.constraintDate, start);
    }
    if (aStart !== null) {
      es = aStart;
    } else if (dataDate !== null) {
      // Unstarted work cannot be scheduled behind the data date.
      es = Math.max(es, dataDate);
    }
    es = cal.nextWorkday(c, es);

    // Remaining work on an in-progress activity resumes at the data date.
    const workFrom =
      aStart !== null && dataDate !== null ? cal.nextWorkday(c, Math.max(es, dataDate)) : es;
    const ef = remaining === 0 ? Math.max(es, workFrom) : cal.addWorkdays(c, workFrom, remaining);
    ES.set(id, es);
    EF.set(id, Math.max(ef, es));
  }

  const projectFinish = topo.length === 0 ? 0 : Math.max(0, ...topo.map((id) => EF.get(id)!));

  /* ---- backward pass ---- */
  const LS = new Map<string, number>();
  const LF = new Map<string, number>();
  for (const id of [...topo].reverse()) {
    const t = byId.get(id)!;
    const c = cal.get(t.calendarId);
    const remaining = REM.get(id)!;
    let lf = projectFinish;
    for (const dep of outgoing.get(id) ?? []) {
      const sLS = LS.get(dep.successorId)!;
      const sLF = LF.get(dep.successorId)!;
      const sRem = REM.get(dep.successorId)!;
      const sc = cal.get(byId.get(dep.successorId)!.calendarId);
      let bound: number;
      switch (dep.type) {
        case "FS":
          bound = sLS - dep.lagDays;
          break;
        case "SS":
          bound = cal.addWorkdays(c, sLS - dep.lagDays, remaining);
          break;
        case "FF":
          bound = sLF - dep.lagDays;
          break;
        case "SF":
          bound = cal.addWorkdays(sc, sLF - dep.lagDays, remaining);
          break;
      }
      lf = Math.min(lf, bound);
    }
    if (t.constraintType === "finish_no_later_than" && t.constraintDate) {
      const cd = dayFromIso(t.constraintDate, start);
      lf = Math.min(lf, remaining === 0 && t.duration === 0 ? cd : cd + 1);
    }
    let ls = cal.subWorkdays(c, lf, remaining);
    if (t.constraintType === "must_start_on" && t.constraintDate) {
      ls = dayFromIso(t.constraintDate, start);
      lf = cal.addWorkdays(c, ls, remaining);
    }
    LS.set(id, ls);
    LF.set(id, lf);
  }

  /* ---- assemble ---- */
  const tasks = new Map<string, Cpm2TaskResult>();
  const criticalIds: string[] = [];
  for (const id of topo) {
    const t = byId.get(id)!;
    const c = cal.get(t.calendarId);
    const es = ES.get(id)!;
    const ef = EF.get(id)!;
    const ls = LS.get(id)!;
    const lf = LF.get(id)!;
    const remaining = REM.get(id)!;
    const complete = Boolean(t.actualFinish);
    const totalFloat = cal.workdaysBetween(c, es, ls);
    // Free float: how far the task can slip without moving any successor.
    let freeFloat = totalFloat;
    for (const dep of outgoing.get(id) ?? []) {
      const sES = ES.get(dep.successorId)!;
      const slack =
        dep.type === "FS" || dep.type === "FF"
          ? cal.workdaysBetween(c, ef + dep.lagDays, sES)
          : cal.workdaysBetween(c, es + dep.lagDays, sES);
      freeFloat = Math.min(freeFloat, slack);
    }
    const isCritical =
      !complete && totalFloat <= 0 && !NON_DRIVING_TYPES.has(t.taskType ?? "task");
    if (isCritical) criticalIds.push(id);
    tasks.set(id, {
      id,
      earlyStart: es,
      earlyFinish: ef,
      lateStart: ls,
      lateFinish: lf,
      totalFloat,
      freeFloat: Number.isFinite(freeFloat) ? freeFloat : totalFloat,
      isCritical,
      startDate: isoFromDay(es, start),
      finishDate: isoFromDay(cal.inclusiveFinish(c, es, ef), start),
      remainingDuration: remaining,
      complete,
    });
  }

  /* ---- longest (driving) path, walked back from the finishing activity ---- */
  const longestPath: string[] = [];
  if (topo.length > 0) {
    let cursor: string | null =
      topo.filter((id) => EF.get(id)! === projectFinish).sort()[0] ?? null;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      longestPath.unshift(cursor);
      const t: Cpm2TaskInput = byId.get(cursor)!;
      const c = cal.get(t.calendarId);
      const rem = REM.get(cursor)!;
      // The driving predecessor is the one whose bound equals this task's
      // early start: remove it and the task moves. Ties break on id so the
      // reported path is deterministic.
      const cursorEs = ES.get(cursor)!;
      let driver: string | null = null;
      let bestBound = Number.NEGATIVE_INFINITY;
      for (const dep of incoming.get(cursor) ?? []) {
        const pES = ES.get(dep.predecessorId)!;
        const pEF = EF.get(dep.predecessorId)!;
        let bound: number;
        switch (dep.type) {
          case "FS":
            bound = pEF + dep.lagDays;
            break;
          case "SS":
            bound = pES + dep.lagDays;
            break;
          case "FF":
            bound = cal.subWorkdays(c, pEF + dep.lagDays, rem);
            break;
          case "SF":
            bound = cal.subWorkdays(c, pES + dep.lagDays, rem);
            break;
        }
        if (
          bound > bestBound ||
          (bound === bestBound && driver !== null && dep.predecessorId < driver)
        ) {
          bestBound = bound;
          driver = dep.predecessorId;
        }
      }
      cursor = driver !== null && bestBound >= cursorEs ? driver : null;
    }
  }

  return {
    ok: true,
    cycle: [],
    tasks,
    projectFinishDate: topo.length === 0 ? null : isoFromDay(Math.max(0, projectFinish - 1), start),
    projectDurationDays: projectFinish,
    criticalIds,
    longestPath,
    dataDate: dataDateIso,
  };
}

/* ------------------------------------------------------------------ */
/* Helpers used by importers and routes                                */
/* ------------------------------------------------------------------ */

/** Working days between two ISO dates on a calendar (inclusive of `from`). */
export function workingDaysBetweenIso(
  spec: CalendarSpec,
  fromIso: string,
  toIso: string,
): number {
  const cals = new Map<string, ResolvedCalendar>();
  const r = resolveCalendar(spec, fromIso);
  cals.set(spec.id, r);
  const math = new CalendarMath(cals, r, fromIso);
  return math.workdaysBetween(r, 0, dayFromIso(toIso, fromIso));
}

/** Convert an hour count from a source file to whole working days. */
export function hoursToDays(hours: number, hoursPerDay: number): number {
  const hpd = hoursPerDay > 0 ? hoursPerDay : 8;
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  return Math.max(0, Math.round((hours / hpd) * 100) / 100);
}
