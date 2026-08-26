/**
 * M23 — the next-due maintenance engine. PURE: a function of its arguments
 * and an explicit `asOf`, never of the clock.
 *
 * CALENDAR AND METER INTERVALS RACE EACH OTHER. A 500-hour service on a
 * machine doing 2 hours a day and a 6-monthly service on the same machine
 * are two different due dates, and the one that arrives first is the one
 * that governs. A schedule row carries a single `intervalKind`, so the race
 * is run across the schedules of one machine by `earliestDue`.
 *
 * A METER INTERVAL HAS NO DATE until you know how hard the machine is being
 * worked. `computeNextDue` will project one when an average daily usage is
 * supplied, and labels it `projectedDueAt` — never `nextDueAt` — because a
 * projection made from last month's usage is not a date anybody should book
 * a fitter against without knowing where it came from.
 *
 * HONESTY RULE: a due date that cannot be computed is null with a reason. A
 * schedule that has never been performed and carries no baseline is
 * `not_scheduled`, not "overdue" — inventing an overdue service on day one
 * of a hire is how a real overdue service gets ignored.
 */

import type { MaintenanceIntervalKind, MeterType } from "@constructos/shared";

export type IsoDate = string;

const MS_PER_DAY = 86_400_000;

export const round2 = (n: number): number => Math.round(n * 100) / 100;

export function addDays(isoDate: IsoDate, days: number): IsoDate {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.trunc(days));
  return d.toISOString().slice(0, 10);
}

/**
 * Add whole months, clamping to the end of the target month so
 * 2026-01-31 + 1 month is 2026-02-28 rather than rolling into March. A
 * six-monthly thorough examination booked from the 31st must not silently
 * gain three days.
 */
export function addMonths(isoDate: IsoDate, months: number): IsoDate {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const targetMonthIndex = m - 1 + Math.trunc(months);
  const year = y + Math.floor(targetMonthIndex / 12);
  const month = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function daysBetweenISO(a: IsoDate, b: IsoDate): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / MS_PER_DAY);
}

/** Meter kinds each interval kind can legitimately be measured against. */
const METER_KINDS_FOR: Partial<Record<MaintenanceIntervalKind, readonly MeterType[]>> = {
  operating_hours: ["hours"],
  distance: ["kilometres", "miles"],
  cycles: ["cycles"],
};

export type MaintenanceDueStatus = "not_scheduled" | "scheduled" | "due_soon" | "overdue";

export interface NextDueInput {
  intervalKind: MaintenanceIntervalKind;
  intervalValue: number;
  /** how far ahead to warn — days for calendar kinds, meter units otherwise */
  warnAheadValue: number | null;
  lastPerformedAt: IsoDate | null;
  lastPerformedMeter: number | null;
  /** the machine's meter right now — the whole basis of a meter interval */
  currentMeter: number | null;
  meterType: MeterType;
  /**
   * Used when the schedule has never been performed: the date the clock
   * legitimately starts from (hire start, commissioning, purchase). Without
   * it a never-performed calendar schedule is `not_scheduled`.
   */
  baselineDate?: IsoDate | null;
  baselineMeter?: number | null;
  /** meter units per day, for projecting a meter interval onto a date */
  averageDailyUsage?: number | null;
  asOf: IsoDate;
}

export interface NextDueResult {
  nextDueAt: IsoDate | null;
  nextDueMeter: number | null;
  basis: "calendar" | "meter" | null;
  status: MaintenanceDueStatus;
  /** meter units still to run; negative means the interval has been passed */
  meterRemaining: number | null;
  /** days still to run; negative means the date has passed */
  daysRemaining: number | null;
  /** a meter interval projected onto a date from averageDailyUsage */
  projectedDueAt: IsoDate | null;
  /** how far past due, in the units of the governing basis */
  overdueBy: { value: number; unit: string } | null;
  reasons: string[];
}

const nothing = (reasons: string[]): NextDueResult => ({
  nextDueAt: null,
  nextDueMeter: null,
  basis: null,
  status: "not_scheduled",
  meterRemaining: null,
  daysRemaining: null,
  projectedDueAt: null,
  overdueBy: null,
  reasons,
});

/**
 * When the next service falls due for ONE schedule.
 *
 * Calendar kinds run off `lastPerformedAt`, falling back to `baselineDate`
 * with a reason recorded, because a machine that has never been serviced
 * still has a clock — it started when the machine arrived.
 *
 * Meter kinds run off `lastPerformedMeter` + the interval and compare
 * against `currentMeter`. Both are required: a machine whose meter has never
 * been read cannot be said to be overdue, and saying so anyway is how the
 * real overdue machines get lost in the noise.
 */
export function computeNextDue(input: NextDueInput): NextDueResult {
  const reasons: string[] = [];
  if (!(input.intervalValue > 0)) {
    return nothing([
      `interval value ${input.intervalValue} is not a positive number — no interval, no due date`,
    ]);
  }

  if (input.intervalKind === "condition_based") {
    return nothing([
      "this schedule is condition-based: it falls due on inspection findings, not on a computed " +
        "interval, so no due date can or should be derived",
    ]);
  }

  if (input.intervalKind === "calendar_days" || input.intervalKind === "calendar_months") {
    const from = input.lastPerformedAt ?? input.baselineDate ?? null;
    if (!from) {
      return nothing([
        "this schedule has never been performed and no baseline date (hire start, commissioning) " +
          "is recorded — the clock has no start, so no due date can be computed",
      ]);
    }
    if (!input.lastPerformedAt) {
      reasons.push(
        `never performed — the interval is counted from the baseline date ${from} rather than ` +
          "from a completed service",
      );
    }
    const nextDueAt =
      input.intervalKind === "calendar_days"
        ? addDays(from, input.intervalValue)
        : addMonths(from, input.intervalValue);
    const daysRemaining = daysBetweenISO(input.asOf, nextDueAt);
    const warnDays = input.warnAheadValue ?? null;
    const status: MaintenanceDueStatus =
      daysRemaining < 0
        ? "overdue"
        : warnDays !== null && daysRemaining <= warnDays
          ? "due_soon"
          : "scheduled";
    if (warnDays === null) {
      reasons.push(
        "no warn-ahead is set on this schedule, so it can only ever read scheduled or overdue — " +
          "there is no window in which anyone is told it is coming",
      );
    }
    return {
      nextDueAt,
      nextDueMeter: null,
      basis: "calendar",
      status,
      meterRemaining: null,
      daysRemaining,
      projectedDueAt: null,
      overdueBy: daysRemaining < 0 ? { value: -daysRemaining, unit: "days" } : null,
      reasons,
    };
  }

  /* meter kinds: operating_hours | distance | cycles */
  const allowed = METER_KINDS_FOR[input.intervalKind];
  if (allowed && !allowed.includes(input.meterType)) {
    reasons.push(
      `the schedule is measured in ${input.intervalKind.replace("_", " ")} but the machine's meter ` +
        `counts ${input.meterType} — the interval and the meter are not the same quantity`,
    );
    if (input.meterType === "none") {
      return nothing([
        ...reasons,
        "this machine has no meter at all, so a meter-based interval can never fall due on it",
      ]);
    }
  }
  const from = input.lastPerformedMeter ?? input.baselineMeter ?? null;
  if (from === null) {
    return nothing([
      ...reasons,
      "this schedule has never been performed and no baseline meter reading is recorded — " +
        "there is no point to count the interval from",
    ]);
  }
  if (input.lastPerformedMeter === null) {
    reasons.push(
      `never performed — the interval is counted from the baseline meter ${from} rather than ` +
        "from a completed service",
    );
  }
  const nextDueMeter = round2(from + input.intervalValue);
  if (input.currentMeter === null) {
    return {
      nextDueAt: null,
      nextDueMeter,
      basis: "meter",
      status: "not_scheduled",
      meterRemaining: null,
      daysRemaining: null,
      projectedDueAt: null,
      overdueBy: null,
      reasons: [
        ...reasons,
        `the next service falls at meter ${nextDueMeter}, but no current meter reading is held ` +
          "for this machine — whether it is due cannot be stated until somebody reads the meter",
      ],
    };
  }
  const meterRemaining = round2(nextDueMeter - input.currentMeter);
  const warnUnits = input.warnAheadValue ?? null;
  const status: MaintenanceDueStatus =
    meterRemaining < 0
      ? "overdue"
      : warnUnits !== null && meterRemaining <= warnUnits
        ? "due_soon"
        : "scheduled";
  if (warnUnits === null) {
    reasons.push(
      "no warn-ahead is set on this schedule, so it can only ever read scheduled or overdue",
    );
  }

  let projectedDueAt: IsoDate | null = null;
  const usage = input.averageDailyUsage ?? null;
  if (usage !== null && usage > 0) {
    const daysAway = Math.ceil(meterRemaining / usage);
    projectedDueAt = addDays(input.asOf, daysAway);
    reasons.push(
      `projected to fall due on ${projectedDueAt} at the observed ${round2(usage)} ` +
        `${input.meterType === "hours" ? "hours" : "units"}/day — a projection, not a booking`,
    );
  } else if (usage === null) {
    reasons.push(
      "no average daily usage is known for this machine, so the meter interval cannot be turned " +
        "into a date — it will fall due when it falls due",
    );
  }

  return {
    nextDueAt: null,
    nextDueMeter,
    basis: "meter",
    status,
    meterRemaining,
    daysRemaining: null,
    projectedDueAt,
    overdueBy:
      meterRemaining < 0
        ? { value: round2(-meterRemaining), unit: input.meterType === "hours" ? "hours" : input.meterType }
        : null,
    reasons,
  };
}

export interface ScheduleDue extends NextDueResult {
  scheduleId: string;
  name: string;
  intervalKind: MaintenanceIntervalKind;
  isStatutory: boolean;
}

const STATUS_RANK: Record<MaintenanceDueStatus, number> = {
  overdue: 0,
  due_soon: 1,
  scheduled: 2,
  not_scheduled: 3,
};

/**
 * The race. Across a machine's schedules, the governing one is the worst
 * status; within a status, the one that arrives first. A calendar due date
 * and a meter due point are not directly comparable, so a meter schedule
 * enters the date comparison only through its `projectedDueAt`, and where it
 * has none it ranks after the dated ones rather than being dropped.
 */
export function earliestDue(rows: ScheduleDue[]): ScheduleDue | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => {
    const byStatus = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (byStatus !== 0) return byStatus;
    if (a.status === "overdue") {
      // deepest into overdue first, measured in its own units
      return (b.overdueBy?.value ?? 0) - (a.overdueBy?.value ?? 0);
    }
    const aDate = a.nextDueAt ?? a.projectedDueAt;
    const bDate = b.nextDueAt ?? b.projectedDueAt;
    if (aDate && bDate) return aDate.localeCompare(bDate) || a.name.localeCompare(b.name);
    if (aDate) return -1;
    if (bDate) return 1;
    return (a.meterRemaining ?? Infinity) - (b.meterRemaining ?? Infinity) || a.name.localeCompare(b.name);
  });
  return sorted[0] ?? null;
}

/**
 * Average meter units per day between two readings. Returns null (with the
 * caller free to say why) rather than 0 when the window is degenerate or the
 * meter went backwards — a backwards meter is an anomaly, not a usage rate.
 */
export function averageDailyUsage(
  earlier: { value: number; at: string } | null,
  later: { value: number; at: string } | null,
): number | null {
  if (!earlier || !later) return null;
  const days = (Date.parse(later.at) - Date.parse(earlier.at)) / MS_PER_DAY;
  if (!Number.isFinite(days) || days <= 0) return null;
  const delta = later.value - earlier.value;
  if (delta < 0) return null;
  return round2(delta / days);
}
