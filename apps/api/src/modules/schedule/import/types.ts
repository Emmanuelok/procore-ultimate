/**
 * Shared shapes for the schedule importers (spec Vol I #349-350).
 *
 * Both parsers are PURE: bytes in, a normalised programme out, with every
 * assumption they had to make recorded in `warnings`. Nothing is written to
 * the database from inside a parser, which is what makes them unit-testable
 * against fixtures and what lets the route present a dry-run diff before the
 * planner commits an import.
 */
import type {
  DependencyType,
  ScheduleFileFormat,
  ScheduleResourceType,
  ScheduleTaskType,
  TaskConstraintType,
} from "@constructos/shared";

export interface ParsedCalendar {
  externalId: string;
  name: string;
  /** 7 slots indexed by UTC day-of-week (0 = Sunday); 1 = working */
  workdays: number[];
  holidays: string[];
  exceptions: string[];
  hoursPerDay: number;
  isDefault: boolean;
}

export interface ParsedTask {
  externalId: string;
  name: string;
  wbsCode: string | null;
  wbsPath: string | null;
  /** working days */
  durationDays: number;
  remainingDurationDays: number | null;
  taskType: ScheduleTaskType;
  calendarExternalId: string | null;
  constraintType: TaskConstraintType | null;
  constraintDate: string | null;
  actualStart: string | null;
  actualFinish: string | null;
  percentComplete: number;
  /** dates as they appear in the file — kept for the diff, not authoritative */
  plannedStart: string | null;
  plannedFinish: string | null;
  sortOrder: number;
}

export interface ParsedDependency {
  predecessorExternalId: string;
  successorExternalId: string;
  depType: DependencyType;
  /** calendar days; fractional lags are rounded to the nearest whole day */
  lagDays: number;
}

export interface ParsedResource {
  taskExternalId: string;
  externalId: string | null;
  name: string;
  resourceType: ScheduleResourceType;
  unit: string | null;
  budgetedUnits: number;
  actualUnits: number;
  remainingUnits: number | null;
  unitRate: number | null;
  budgetedCost: number;
  actualCost: number;
}

export interface ParsedSchedule {
  format: ScheduleFileFormat;
  projectName: string | null;
  externalRef: string | null;
  /** earliest date the file implies; the CPM day 0 of the imported schedule */
  projectStart: string;
  dataDate: string | null;
  calendars: ParsedCalendar[];
  tasks: ParsedTask[];
  dependencies: ParsedDependency[];
  resources: ParsedResource[];
  warnings: string[];
}

/** ISO date from a "YYYY-MM-DD ..." or "YYYY-MM-DDTHH:MM:SS" string. */
export function isoDateOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw.trim());
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  return Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) ? null : iso;
}

/** Excel/P6 serial day number (days since 1899-12-30) to an ISO date. */
export function serialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 0 || serial > 200000) return null;
  const ms = Date.UTC(1899, 11, 30) + Math.round(serial) * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

export const DEFAULT_WORKDAYS: number[] = [0, 1, 1, 1, 1, 1, 0];
