/**
 * RESOURCE HISTOGRAM AND LEVELLING — pure, no I/O (spec Vol I #682–687).
 *
 * The histogram is demand against supply, week by week, per trade. Three
 * rules make it worth looking at:
 *
 *  1. UNKNOWN SUPPLY IS NOT ZERO SUPPLY. A week with no availability row is
 *     `unknown`, not a 100% overload. A histogram that paints every
 *     unrecorded week red is one nobody reads by week three, and then the
 *     genuinely red weeks go unseen too.
 *
 *  2. ASSUMED SUPPLY IS LABELLED. `assumed` availability is carried through
 *     to the cell so a planner can see that this week's comfortable-looking
 *     coverage rests on people nobody has committed.
 *
 *  3. LEVELLING SUGGESTS, IT NEVER APPLIES. Moving an activity changes the
 *     programme, and the programme is the schedule module's record. Every
 *     suggestion here names the activity, the float it has, and the hours
 *     that would have to move — and then stops.
 */
import type { ResourceLevellingAction } from "@constructos/shared";
import { round2, round3 } from "./calendar.js";

export interface HistogramType {
  id: string;
  code: string;
  name: string;
  kind: string;
  unit: string;
  standardHoursPerDay: number | null;
  workingDaysPerWeek: number | null;
}

export interface HistogramDemandRow {
  resourceTypeId: string;
  weekStart: string;
  demandHours: number;
  sourceTaskId: string | null;
}

export interface HistogramSupplyRow {
  resourceTypeId: string;
  weekStart: string;
  availableHours: number;
  availableHeadcount: number | null;
  source: string;
}

export type HistogramState = "over" | "tight" | "ok" | "idle" | "unknown";

export interface HistogramCell {
  resourceTypeId: string;
  weekStart: string;
  demandHours: number;
  availableHours: number | null;
  availabilitySource: string | null;
  /** demand − available; null when supply is unknown */
  overAllocationHours: number | null;
  utilisationPercent: number | null;
  demandHeadcount: number | null;
  availableHeadcount: number | null;
  state: HistogramState;
  contributingTaskIds: string[];
  reasons: string[];
}

export interface HistogramSeries {
  resourceType: HistogramType;
  cells: HistogramCell[];
  totalDemandHours: number;
  peakDemandHours: number;
  peakWeekStart: string | null;
  /** null when any week in the window has unknown supply */
  totalAvailableHours: number | null;
  overWeeks: number;
  unknownSupplyWeeks: number;
  assumedSupplyWeeks: number;
  reasons: string[];
}

export interface HistogramResult {
  weeks: string[];
  series: HistogramSeries[];
  totals: {
    demandHours: number;
    /** null when ANY series has an unknown-supply week — never a partial sum */
    availableHours: number | null;
    overAllocatedCells: number;
    unknownSupplyCells: number;
    peakWeekStart: string | null;
    peakDemandHours: number;
  };
  reasons: string[];
}

export interface BuildHistogramInput {
  weeks: string[];
  types: HistogramType[];
  demand: HistogramDemandRow[];
  supply: HistogramSupplyRow[];
  /** working days in a week under the project calendar, for headcount */
  workingDaysPerWeek: number;
  /** utilisation at or above this is "tight" but not over */
  tightThresholdPercent?: number;
  /** utilisation at or below this is "idle" */
  idleThresholdPercent?: number;
}

/** Utilisation ≥ this and ≤ 100 is a week with no slack left. */
export const TIGHT_THRESHOLD_PERCENT = 90;
export const IDLE_THRESHOLD_PERCENT = 50;

export function buildHistogram(input: BuildHistogramInput): HistogramResult {
  const tight = input.tightThresholdPercent ?? TIGHT_THRESHOLD_PERCENT;
  const idle = input.idleThresholdPercent ?? IDLE_THRESHOLD_PERCENT;
  const weeks = [...input.weeks].sort();
  const reasons: string[] = [];

  const demandIndex = new Map<string, { hours: number; taskIds: Set<string> }>();
  for (const row of input.demand) {
    const key = `${row.resourceTypeId}|${row.weekStart}`;
    const held = demandIndex.get(key) ?? { hours: 0, taskIds: new Set<string>() };
    held.hours = round2(held.hours + row.demandHours);
    if (row.sourceTaskId) held.taskIds.add(row.sourceTaskId);
    demandIndex.set(key, held);
  }
  const supplyIndex = new Map<string, HistogramSupplyRow>();
  for (const row of input.supply) supplyIndex.set(`${row.resourceTypeId}|${row.weekStart}`, row);

  const workingDays = input.workingDaysPerWeek > 0 ? input.workingDaysPerWeek : 5;

  const series: HistogramSeries[] = [];
  let overAllocatedCells = 0;
  let unknownSupplyCells = 0;
  let totalDemand = 0;
  let anyUnknownSupply = false;
  let grandPeakWeek: string | null = null;
  let grandPeakHours = 0;

  for (const type of input.types) {
    const cells: HistogramCell[] = [];
    const seriesReasons: string[] = [];
    let totalDemandHours = 0;
    let availableAccumulator = 0;
    let peakDemandHours = 0;
    let peakWeekStart: string | null = null;
    let overWeeks = 0;
    let unknownWeeks = 0;
    let assumedWeeks = 0;

    for (const week of weeks) {
      const key = `${type.id}|${week}`;
      const demand = demandIndex.get(key);
      const supply = supplyIndex.get(key);
      const demandHours = round2(demand?.hours ?? 0);
      const cellReasons: string[] = [];

      const demandHeadcount =
        type.standardHoursPerDay && type.standardHoursPerDay > 0
          ? round2(demandHours / (type.standardHoursPerDay * workingDays))
          : null;
      if (demandHeadcount === null && demandHours > 0) {
        cellReasons.push(
          `${type.name} records no standard hours per day, so its hours cannot be shown as a ` +
            "headcount. The hours figure is exact; the headcount is simply not derivable.",
        );
      }

      let state: HistogramState;
      let overAllocationHours: number | null = null;
      let utilisationPercent: number | null = null;

      if (!supply) {
        state = "unknown";
        unknownWeeks += 1;
        unknownSupplyCells += 1;
        anyUnknownSupply = true;
        if (demandHours > 0) {
          cellReasons.push(
            `No availability is recorded for ${type.name} in the week beginning ${week}, so this ` +
              "week's coverage is unknown rather than short. Record what can be fielded to make " +
              "the gap computable.",
          );
        }
      } else {
        overAllocationHours = round2(demandHours - supply.availableHours);
        utilisationPercent =
          supply.availableHours > 0
            ? round2((demandHours / supply.availableHours) * 100)
            : demandHours > 0
              ? null
              : 0;
        if (utilisationPercent === null) {
          cellReasons.push(
            `${type.name} has ${demandHours} hours of demand against zero recorded availability in ` +
              `the week beginning ${week}. Utilisation is undefined rather than infinite; the ` +
              "shortfall is the whole demand.",
          );
          state = "over";
          overWeeks += 1;
          overAllocatedCells += 1;
        } else if (overAllocationHours > 0.01) {
          state = "over";
          overWeeks += 1;
          overAllocatedCells += 1;
        } else if (utilisationPercent >= tight) {
          state = "tight";
        } else if (supply.availableHours > 0 && utilisationPercent <= idle) {
          state = "idle";
        } else {
          state = "ok";
        }
        if (supply.source === "assumed") {
          assumedWeeks += 1;
          cellReasons.push(
            "This week's supply is recorded as ASSUMED — nobody has committed these people. " +
              "Treat the coverage as a plan, not a fact.",
          );
        }
        availableAccumulator = round2(availableAccumulator + supply.availableHours);
      }

      totalDemandHours = round2(totalDemandHours + demandHours);
      if (demandHours > peakDemandHours) {
        peakDemandHours = demandHours;
        peakWeekStart = week;
      }

      cells.push({
        resourceTypeId: type.id,
        weekStart: week,
        demandHours,
        availableHours: supply?.availableHours ?? null,
        availabilitySource: supply?.source ?? null,
        overAllocationHours,
        utilisationPercent,
        demandHeadcount,
        availableHeadcount: supply?.availableHeadcount ?? null,
        state,
        contributingTaskIds: demand ? [...demand.taskIds] : [],
        reasons: cellReasons,
      });
    }

    if (unknownWeeks > 0) {
      seriesReasons.push(
        `${unknownWeeks} of ${weeks.length} week(s) have no recorded availability for ${type.name}, ` +
          "so the total supply for this trade is stated as unknown rather than as the sum of the " +
          "weeks that happen to be filled in.",
      );
    }
    if (assumedWeeks > 0) {
      seriesReasons.push(
        `${assumedWeeks} week(s) of ${type.name} supply are assumed rather than committed.`,
      );
    }

    totalDemand = round2(totalDemand + totalDemandHours);
    if (peakDemandHours > grandPeakHours) {
      grandPeakHours = peakDemandHours;
      grandPeakWeek = peakWeekStart;
    }

    series.push({
      resourceType: type,
      cells,
      totalDemandHours,
      peakDemandHours,
      peakWeekStart,
      totalAvailableHours: unknownWeeks === 0 ? availableAccumulator : null,
      overWeeks,
      unknownSupplyWeeks: unknownWeeks,
      assumedSupplyWeeks: assumedWeeks,
      reasons: seriesReasons,
    });
  }

  if (anyUnknownSupply) {
    reasons.push(
      "At least one trade-week has no recorded availability, so the project's total supply is " +
        "not stated. A partial sum here would read as the whole picture.",
    );
  }
  if (input.types.length === 0) {
    reasons.push(
      "No resource types are in scope, so there is nothing to plot. Create the trades and plant " +
        "classes this project resources against first.",
    );
  }

  return {
    weeks,
    series,
    totals: {
      demandHours: totalDemand,
      availableHours: anyUnknownSupply
        ? null
        : round2(series.reduce((s, x) => s + (x.totalAvailableHours ?? 0), 0)),
      overAllocatedCells,
      unknownSupplyCells,
      peakWeekStart: grandPeakWeek,
      peakDemandHours: grandPeakHours,
    },
    reasons,
  };
}

/* ------------------------------------------------------------------ */
/* Levelling                                                           */
/* ------------------------------------------------------------------ */

export interface LevellingTask {
  id: string;
  name: string;
  totalFloat: number | null;
  isCritical: boolean;
  startDate: string | null;
  finishDate: string | null;
}

export interface LevellingSuggestion {
  resourceTypeId: string;
  resourceTypeName: string;
  weekStart: string;
  overAllocationHours: number;
  action: ResourceLevellingAction;
  taskId: string | null;
  taskName: string | null;
  floatDays: number | null;
  /** hours this move would take out of the peak week */
  moveHours: number | null;
  explanation: string;
}

export interface SuggestLevellingInput {
  histogram: HistogramResult;
  /** per (type|week|task) hours, so a suggestion can quantify the move */
  contributions: Array<{
    resourceTypeId: string;
    weekStart: string;
    sourceTaskId: string | null;
    demandHours: number;
  }>;
  tasks: LevellingTask[];
  /** a task must have at least this much float to be worth deferring */
  minFloatDays?: number;
  maxSuggestions?: number;
}

export const MIN_DEFERRABLE_FLOAT_DAYS = 5;

/**
 * For every over-allocated week, name the cheapest ways out of it: defer the
 * float-bearing activities that made the peak, or add supply. Critical
 * activities are never proposed for deferral — moving them moves the
 * completion date, which is a different decision taken by different people.
 */
export function suggestLevelling(input: SuggestLevellingInput): LevellingSuggestion[] {
  const minFloat = input.minFloatDays ?? MIN_DEFERRABLE_FLOAT_DAYS;
  const maxSuggestions = input.maxSuggestions ?? 50;
  const taskIndex = new Map(input.tasks.map((t) => [t.id, t]));
  const contributionIndex = new Map<string, Array<{ taskId: string | null; hours: number }>>();
  for (const c of input.contributions) {
    const key = `${c.resourceTypeId}|${c.weekStart}`;
    const list = contributionIndex.get(key) ?? [];
    list.push({ taskId: c.sourceTaskId, hours: c.demandHours });
    contributionIndex.set(key, list);
  }

  const out: LevellingSuggestion[] = [];
  for (const series of input.histogram.series) {
    for (const cell of series.cells) {
      if (cell.state !== "over") continue;
      const over = cell.overAllocationHours ?? cell.demandHours;
      if (over <= 0) continue;
      const key = `${cell.resourceTypeId}|${cell.weekStart}`;
      const contributors = [...(contributionIndex.get(key) ?? [])].sort((a, b) => b.hours - a.hours);

      let covered = 0;
      let proposed = 0;
      for (const contributor of contributors) {
        if (covered >= over || proposed >= 3) break;
        const task = contributor.taskId ? taskIndex.get(contributor.taskId) : undefined;
        if (!task) continue;
        if (task.isCritical) continue;
        const float = task.totalFloat;
        if (float === null || float < minFloat) continue;
        const moveHours = round2(Math.min(contributor.hours, over - covered));
        covered = round2(covered + moveHours);
        proposed += 1;
        out.push({
          resourceTypeId: cell.resourceTypeId,
          resourceTypeName: series.resourceType.name,
          weekStart: cell.weekStart,
          overAllocationHours: over,
          action: "defer_task",
          taskId: task.id,
          taskName: task.name,
          floatDays: float,
          moveHours,
          explanation:
            `The week beginning ${cell.weekStart} needs ${cell.demandHours} h of ` +
            `${series.resourceType.name} against ${cell.availableHours ?? 0} h available — ` +
            `${over} h short. "${task.name}" contributes ${round2(contributor.hours)} h and carries ` +
            `${float} days of total float, so deferring it takes ${moveHours} h out of the peak ` +
            "without moving the completion date. This is a suggestion: the move itself is a " +
            "programme change and belongs in the schedule.",
        });
      }

      if (covered < over) {
        const shortfall = round2(over - covered);
        const criticalContributors = contributors
          .map((c) => (c.taskId ? taskIndex.get(c.taskId) : undefined))
          .filter((t): t is LevellingTask => Boolean(t?.isCritical));
        out.push({
          resourceTypeId: cell.resourceTypeId,
          resourceTypeName: series.resourceType.name,
          weekStart: cell.weekStart,
          overAllocationHours: over,
          action: "add_supply",
          taskId: null,
          taskName: null,
          floatDays: null,
          moveHours: shortfall,
          explanation:
            `${shortfall} h of the ${over} h shortfall in the week beginning ${cell.weekStart} ` +
            `cannot be levelled by deferral` +
            (criticalContributors.length > 0
              ? ` — ${criticalContributors.length} of the contributing activities are critical, and ` +
                "moving a critical activity moves the completion date"
              : " — no contributing activity carries enough float") +
            `. Field ${shortfall} more hours of ${series.resourceType.name} that week, or accept ` +
            "the peak knowing the work will not all be done.",
        });
      }
      if (out.length >= maxSuggestions) return out.slice(0, maxSuggestions);
    }
  }
  return out;
}

export { round2, round3 };
