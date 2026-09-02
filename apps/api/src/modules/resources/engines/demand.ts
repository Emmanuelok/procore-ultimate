/**
 * DEMAND DERIVATION — the programme turned into weekly resource demand
 * (spec Vol I #676–681). Pure, no I/O.
 *
 * A resource plan typed by hand is a wish. A resource plan derived from the
 * schedule is a consequence: change the programme and the histogram moves,
 * which is the only way a resourcing conversation can stay honest as dates
 * slip.
 *
 * THE SPREAD, ONCE:
 *
 *     hoursPerWorkingDay = taskHours ÷ workingDays(start … finish)
 *     weekDemand(w)      = hoursPerWorkingDay × workingDays(w ∩ task window)
 *
 * WHAT IS DELIBERATELY REFUSED. A task with no dates, no hours, or no
 * resource type produces NO demand row and appears in `skipped` with the
 * reason. It does not produce a zero row: a zero row on a histogram says "we
 * need nobody that week", which is a claim about the programme, whereas a
 * skipped task is a claim about our records. Those are different sentences
 * and a planner has to be able to tell them apart.
 *
 * A task already 100% complete is skipped too — resourcing forward-looking
 * work is the point, and past work is measured, not planned.
 */
import {
  DEFAULT_WORK_PATTERN,
  addDays,
  enumerateWeeks,
  round2,
  round3,
  weekStartOf,
  workingDaysBetween,
  workingDaysInWeek,
  type WorkPattern,
} from "./calendar.js";

/** One resource line on an activity — from `schedule_task_resources` or the
 *  activity's own budgeted hours when it carries no explicit resourcing. */
export interface DemandTaskResource {
  /** resolved to a resource type by the caller; null means unresolvable */
  resourceTypeId: string | null;
  /** what the source called it, kept for the skip reason */
  name: string;
  /** budgeted units; only `hours`-unit lines produce demand */
  budgetedUnits: number;
  unit: string | null;
  remainingUnits: number | null;
  actualUnits: number | null;
}

export interface DemandTask {
  id: string;
  name: string;
  startDate: string | null;
  finishDate: string | null;
  percentComplete: number;
  totalFloat: number | null;
  isCritical: boolean;
  /** the activity's own planned labour hours, used when it has no resource lines */
  budgetedHours: number | null;
  /** the resource type the activity as a whole maps to, when known */
  resourceTypeId: string | null;
  resources: DemandTaskResource[];
  locationId?: string | null;
}

export interface DerivedDemandRow {
  resourceTypeId: string;
  weekStart: string;
  demandHours: number;
  sourceTaskId: string;
  sourceTaskName: string;
  basis: string;
  locationId: string | null;
}

export interface SkippedTask {
  taskId: string;
  taskName: string;
  reason: string;
}

export interface DemandDerivation {
  rows: DerivedDemandRow[];
  skipped: SkippedTask[];
  /** tasks that produced at least one row */
  derivedTaskCount: number;
  totalDemandHours: number;
  periodStart: string | null;
  periodEnd: string | null;
  weeks: string[];
  reasons: string[];
}

export interface DeriveDemandOptions {
  weekStartsOn?: number;
  pattern?: WorkPattern;
  /** ignore work already done: only spread the REMAINING share of the hours */
  remainingOnly?: boolean;
}

/** Units a resource line must be measured in to be spread as hours. */
const HOUR_UNITS = new Set(["hour", "hours", "hr", "hrs", "h", "manhour", "manhours", "man-hours"]);

function isHourUnit(unit: string | null): boolean {
  if (!unit) return true; // unstated units on a labour line mean hours here
  return HOUR_UNITS.has(unit.trim().toLowerCase());
}

/**
 * Spread every task's planned hours across the weeks it spans.
 *
 * `remainingOnly` matters on a live project: a task 60% complete does not
 * still need 100% of its hours, and a plan that says it does over-states
 * every forward week and gets ignored within a fortnight.
 */
export function deriveDemand(
  tasks: DemandTask[],
  options: DeriveDemandOptions = {},
): DemandDerivation {
  const weekStartsOn = options.weekStartsOn ?? 1;
  const pattern = options.pattern ?? DEFAULT_WORK_PATTERN;
  const remainingOnly = options.remainingOnly ?? false;

  const rows: DerivedDemandRow[] = [];
  const skipped: SkippedTask[] = [];
  const reasons: string[] = [];
  const contributing = new Set<string>();
  let earliest: string | null = null;
  let latest: string | null = null;

  for (const task of tasks) {
    if (!task.startDate || !task.finishDate) {
      skipped.push({
        taskId: task.id,
        taskName: task.name,
        reason:
          "The activity has no computed start and finish, so there is no window to spread hours " +
          "across. Run the schedule before deriving demand from it.",
      });
      continue;
    }
    if (task.finishDate < task.startDate) {
      skipped.push({
        taskId: task.id,
        taskName: task.name,
        reason: `The activity finishes (${task.finishDate}) before it starts (${task.startDate}).`,
      });
      continue;
    }
    const complete = Number.isFinite(task.percentComplete) ? task.percentComplete : 0;
    if (complete >= 100) {
      skipped.push({
        taskId: task.id,
        taskName: task.name,
        reason:
          "The activity is complete. A resource plan resources work that is still to come; " +
          "finished work is measured on the productivity tab, not planned here.",
      });
      continue;
    }

    /* Which lines carry the hours: explicit resource lines when present,
       otherwise the activity's own budgeted hours against its own type. */
    const lines: DemandTaskResource[] =
      task.resources.length > 0
        ? task.resources
        : [
            {
              resourceTypeId: task.resourceTypeId,
              name: task.name,
              budgetedUnits: task.budgetedHours ?? 0,
              unit: "hours",
              remainingUnits: null,
              actualUnits: null,
            },
          ];

    let producedAny = false;
    for (const line of lines) {
      if (!line.resourceTypeId) {
        skipped.push({
          taskId: task.id,
          taskName: task.name,
          reason:
            `"${line.name}" could not be matched to a resource type, so its hours cannot be ` +
            "added to any trade's histogram. Map it by giving the resource type a code that " +
            "matches, or set the activity's resource type directly.",
        });
        continue;
      }
      if (!isHourUnit(line.unit)) {
        skipped.push({
          taskId: task.id,
          taskName: task.name,
          reason:
            `"${line.name}" is measured in ${line.unit}, not hours. Quantities in other units are ` +
            "never converted to hours here — the conversion rate is a productivity assumption and " +
            "belongs on the estimate, not in a chart.",
        });
        continue;
      }

      let hours = line.budgetedUnits;
      let basisPrefix = `${round2(hours)} planned hours`;
      if (remainingOnly) {
        if (line.remainingUnits !== null && line.remainingUnits >= 0) {
          hours = line.remainingUnits;
          basisPrefix = `${round2(hours)} remaining hours (of ${round2(line.budgetedUnits)} planned)`;
        } else if (complete > 0) {
          hours = round2(line.budgetedUnits * (1 - complete / 100));
          basisPrefix =
            `${round2(hours)} remaining hours (${round2(line.budgetedUnits)} planned, ` +
            `${round2(complete)}% complete)`;
        }
      }
      if (!Number.isFinite(hours) || hours <= 0) {
        skipped.push({
          taskId: task.id,
          taskName: task.name,
          reason:
            `"${line.name}" carries no planned hours` +
            (remainingOnly ? " still to spend" : "") +
            ", so there is nothing to spread. An activity with no hours is not a zero-demand " +
            "week; it is an activity nobody has resourced.",
        });
        continue;
      }

      const workingDays = workingDaysBetween(task.startDate, task.finishDate, pattern);
      const spreadDays = workingDays > 0 ? workingDays : 0;
      if (spreadDays === 0) {
        skipped.push({
          taskId: task.id,
          taskName: task.name,
          reason:
            `"${line.name}" spans ${task.startDate} → ${task.finishDate}, which contains no working ` +
            "days under this project's calendar, so its hours cannot be spread. Check the " +
            "calendar's holidays and working weekdays.",
        });
        continue;
      }
      const perDay = hours / spreadDays;

      for (const week of enumerateWeeks(task.startDate, task.finishDate, weekStartsOn)) {
        const daysInWeek = workingDaysInWeek(week, task.startDate, task.finishDate, pattern);
        if (daysInWeek === 0) continue;
        const demandHours = round2(perDay * daysInWeek);
        if (demandHours <= 0) continue;
        rows.push({
          resourceTypeId: line.resourceTypeId,
          weekStart: week,
          demandHours,
          sourceTaskId: task.id,
          sourceTaskName: task.name,
          locationId: task.locationId ?? null,
          basis:
            `${basisPrefix} on "${task.name}" spread over ${spreadDays} working day(s) ` +
            `(${round3(perDay)} h/day); ${daysInWeek} of them fall in the week beginning ${week}.`,
        });
        producedAny = true;
        if (earliest === null || week < earliest) earliest = week;
        const weekEnd = addDays(week, 6);
        if (latest === null || weekEnd > latest) latest = weekEnd;
      }
    }
    if (producedAny) contributing.add(task.id);
  }

  if (skipped.length > 0) {
    reasons.push(
      `${skipped.length} activity line(s) produced no demand and are listed with their reason. ` +
        "They are excluded rather than counted as zero, because an unresourced activity and an " +
        "activity that genuinely needs nobody are different facts.",
    );
  }
  if (rows.length === 0) {
    reasons.push(
      "No demand could be derived from this schedule. Demand needs three things on an activity: " +
        "computed dates, planned hours, and a resource type to attribute them to.",
    );
  }

  return {
    rows,
    skipped,
    derivedTaskCount: contributing.size,
    totalDemandHours: round2(rows.reduce((s, r) => s + r.demandHours, 0)),
    periodStart: earliest,
    periodEnd: latest,
    weeks:
      earliest !== null && latest !== null ? enumerateWeeks(earliest, latest, weekStartsOn) : [],
    reasons,
  };
}

/** Roll derived rows up to one row per (type, week) — what the plan stores
 *  when the caller does not want per-activity traceability. */
export function collapseByTypeWeek(rows: DerivedDemandRow[]): DerivedDemandRow[] {
  const map = new Map<string, DerivedDemandRow & { taskIds: Set<string> }>();
  for (const row of rows) {
    const key = `${row.resourceTypeId}|${row.weekStart}`;
    const held = map.get(key);
    if (held) {
      held.demandHours = round2(held.demandHours + row.demandHours);
      held.taskIds.add(row.sourceTaskId);
    } else {
      map.set(key, { ...row, taskIds: new Set([row.sourceTaskId]) });
    }
  }
  return [...map.values()].map((row) => ({
    resourceTypeId: row.resourceTypeId,
    weekStart: row.weekStart,
    demandHours: row.demandHours,
    sourceTaskId: row.sourceTaskId,
    sourceTaskName: row.sourceTaskName,
    locationId: row.locationId,
    basis:
      row.taskIds.size === 1
        ? row.basis
        : `${round2(row.demandHours)} hours from ${row.taskIds.size} activities in the week beginning ${row.weekStart}.`,
  }));
}

/**
 * Convert hours to a headcount. Null — never a guess — when the resource type
 * records no standard working day: dividing by an invented 8 makes every
 * headcount on a 10-hour shift 25% wrong.
 */
export function headcountFor(
  demandHours: number,
  standardHoursPerDay: number | null,
  workingDaysInWeek: number,
): { value: number | null; reason: string | null } {
  if (standardHoursPerDay === null || standardHoursPerDay <= 0) {
    return {
      value: null,
      reason:
        "This resource type records no standard hours per day, so hours cannot be converted to a " +
        "headcount. Set it on the resource type rather than assuming an eight-hour day.",
    };
  }
  if (workingDaysInWeek <= 0) {
    return {
      value: null,
      reason: "The week contains no working days under this project's calendar.",
    };
  }
  return {
    value: round2(demandHours / (standardHoursPerDay * workingDaysInWeek)),
    reason: null,
  };
}

export { weekStartOf };
