/**
 * Primavera P6 XER importer (spec Vol I #349).
 *
 * XER is a tab-delimited multi-table dump. Each table opens with a `%T` line
 * naming it, a `%F` line naming its columns and then `%R` rows; `%E` ends the
 * file. This parser reads the five tables a programme actually needs:
 *
 *   PROJECT   — proj_short_name, plan_start_date, last_recalc_date (data date)
 *   CALENDAR  — clndr_id, clndr_name, day_hr_cnt, clndr_data (the week + holidays)
 *   PROJWBS   — wbs_id, parent_wbs_id, wbs_short_name → the WBS path of a task
 *   TASK      — the activities
 *   TASKPRED  — the logic (pred_type PR_FS/PR_SS/PR_FF/PR_SF, lag_hr_cnt)
 *   TASKRSRC  — resource assignments (#370)
 *
 * Durations arrive in HOURS and are converted to working days with the
 * activity's own calendar hours-per-day; a lag arrives in hours and is
 * converted to calendar days the same way, because that is how P6 means it.
 *
 * Everything the parser had to assume is pushed into `warnings` rather than
 * silently applied — an imported programme that quietly invented a calendar is
 * worse than one that says it did.
 *
 * Deliberately NOT parsed: resource curves, activity codes, UDFs, expenses,
 * multi-project XERs (the first PROJECT row wins and the rest are reported).
 */
import type { DependencyType, ScheduleTaskType, TaskConstraintType } from "@constructos/shared";
import {
  DEFAULT_WORKDAYS,
  isoDateOf,
  serialToIso,
  type ParsedCalendar,
  type ParsedDependency,
  type ParsedResource,
  type ParsedSchedule,
  type ParsedTask,
} from "./types.js";

interface XerTable {
  name: string;
  fields: string[];
  rows: string[][];
}

const MAX_ROWS = 200_000;

export function parseXerTables(text: string): XerTable[] {
  const tables: XerTable[] = [];
  let current: XerTable | null = null;
  let rowCount = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.length === 0) continue;
    const cells = rawLine.split("\t");
    const kind = cells[0];
    if (kind === "%T") {
      current = { name: (cells[1] ?? "").trim(), fields: [], rows: [] };
      tables.push(current);
    } else if (kind === "%F" && current) {
      current.fields = cells.slice(1).map((f) => f.trim());
    } else if (kind === "%R" && current) {
      if (rowCount >= MAX_ROWS) break;
      current.rows.push(cells.slice(1));
      rowCount += 1;
    } else if (kind === "%E") {
      break;
    }
  }
  return tables;
}

function tableRows(tables: XerTable[], name: string): Record<string, string>[] {
  const t = tables.find((x) => x.name.toUpperCase() === name);
  if (!t) return [];
  return t.rows.map((cells) => {
    const row: Record<string, string> = {};
    for (let i = 0; i < t.fields.length; i += 1) row[t.fields[i]!] = (cells[i] ?? "").trim();
    return row;
  });
}

const num = (v: string | undefined): number | null => {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * P6 stores the working week and holidays inside `clndr_data`, a nested
 * pipe-and-parenthesis blob. The shape that matters is:
 *
 *   (0||DaysOfWeek()(0||1()) (0||2()(0||0(s|08:00|f|17:00))) …)
 *   (0||Exceptions()(0||0(d|44562))…)
 *
 * A day with a `s|` (shift start) inside its group is a working day; a day
 * with an empty group is not. Exceptions carry P6 date serials.
 *
 * P6 day numbers are 1 = Sunday … 7 = Saturday, which lines up with
 * JS getUTCDay() once shifted by one.
 */
export function parseXerCalendarData(data: string): {
  workdays: number[] | null;
  holidays: string[];
} {
  const holidays: string[] = [];
  const dowIdx = data.indexOf("DaysOfWeek");
  const excIdx = data.indexOf("Exceptions");
  let workdays: number[] | null = null;

  if (dowIdx >= 0) {
    const section = data.slice(dowIdx, excIdx > dowIdx ? excIdx : undefined);
    const marks: { day: number; at: number }[] = [];
    const re = /\(0\|\|([1-7])\(\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(section)) !== null) {
      marks.push({ day: Number(m[1]), at: m.index + m[0].length });
    }
    if (marks.length > 0) {
      const days = [0, 0, 0, 0, 0, 0, 0];
      for (let i = 0; i < marks.length; i += 1) {
        const from = marks[i]!.at;
        const to = i + 1 < marks.length ? marks[i + 1]!.at : section.length;
        const body = section.slice(from, to);
        // P6 day 1 = Sunday → JS index 0
        if (body.includes("s|")) days[(marks[i]!.day - 1) % 7] = 1;
      }
      workdays = days;
    }
  }

  if (excIdx >= 0) {
    const section = data.slice(excIdx);
    const re = /d\|(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(section)) !== null) {
      const iso = serialToIso(Number(m[1]));
      if (iso) holidays.push(iso);
    }
  }
  return { workdays, holidays };
}

const CONSTRAINT_MAP: Record<string, TaskConstraintType | null> = {
  CS_MSO: "must_start_on",
  CS_MSOA: "start_no_earlier_than",
  CS_MSOB: "finish_no_later_than",
  CS_MEOA: "start_no_earlier_than",
  CS_MEOB: "finish_no_later_than",
  CS_MEO: "finish_no_later_than",
  CS_MANDSTART: "must_start_on",
  CS_MANDFIN: "finish_no_later_than",
  CS_ALAP: null,
};

const TASK_TYPE_MAP: Record<string, ScheduleTaskType> = {
  TT_Task: "task",
  TT_Rsrc: "task",
  TT_Mile: "start_milestone",
  TT_FinMile: "finish_milestone",
  TT_LOE: "level_of_effort",
  TT_WBS: "wbs_summary",
};

const DEP_MAP: Record<string, DependencyType> = {
  PR_FS: "FS",
  PR_SS: "SS",
  PR_FF: "FF",
  PR_SF: "SF",
};

export function parseXer(text: string): ParsedSchedule {
  const warnings: string[] = [];
  const tables = parseXerTables(text);
  if (tables.length === 0) {
    throw new Error("Not a readable XER file — no %T table markers were found");
  }

  /* ---- calendars ---- */
  const calRows = tableRows(tables, "CALENDAR");
  const calendars: ParsedCalendar[] = [];
  const hoursByCalendar = new Map<string, number>();
  for (const r of calRows) {
    const id = r["clndr_id"] ?? "";
    if (!id) continue;
    const hoursPerDay = num(r["day_hr_cnt"]) ?? 8;
    hoursByCalendar.set(id, hoursPerDay > 0 ? hoursPerDay : 8);
    const parsed = parseXerCalendarData(r["clndr_data"] ?? "");
    if (!parsed.workdays) {
      warnings.push(
        `Calendar "${r["clndr_name"] ?? id}" had no readable working-week data — a Mon-Fri week was assumed`,
      );
    }
    calendars.push({
      externalId: id,
      name: r["clndr_name"] || `Calendar ${id}`,
      workdays: parsed.workdays ?? [...DEFAULT_WORKDAYS],
      holidays: parsed.holidays,
      exceptions: [],
      hoursPerDay: hoursPerDay > 0 ? hoursPerDay : 8,
      isDefault: r["default_flag"] === "Y",
    });
  }
  if (calendars.length === 0) {
    warnings.push("The file contained no CALENDAR table — a Mon-Fri 8h calendar was assumed");
    calendars.push({
      externalId: "__default",
      name: "Imported default (Mon-Fri)",
      workdays: [...DEFAULT_WORKDAYS],
      holidays: [],
      exceptions: [],
      hoursPerDay: 8,
      isDefault: true,
    });
  }
  if (!calendars.some((c) => c.isDefault)) calendars[0]!.isDefault = true;
  const defaultHours = calendars.find((c) => c.isDefault)?.hoursPerDay ?? 8;

  /* ---- WBS paths ---- */
  const wbsRows = tableRows(tables, "PROJWBS");
  const wbsById = new Map<string, { name: string; parent: string | null }>();
  for (const r of wbsRows) {
    const id = r["wbs_id"];
    if (!id) continue;
    const parent = r["parent_wbs_id"] || null;
    wbsById.set(id, { name: r["wbs_short_name"] || r["wbs_name"] || id, parent });
  }
  const wbsPathOf = (id: string | undefined): string | null => {
    if (!id) return null;
    const parts: string[] = [];
    let cursor: string | null = id;
    for (let i = 0; i < 40 && cursor; i += 1) {
      const node = wbsById.get(cursor);
      if (!node) break;
      parts.unshift(node.name);
      cursor = node.parent;
    }
    return parts.length > 0 ? parts.join(".") : null;
  };

  /* ---- project header ---- */
  const projectRows = tableRows(tables, "PROJECT");
  if (projectRows.length > 1) {
    warnings.push(
      `The file contains ${projectRows.length} projects — the first (${projectRows[0]?.["proj_short_name"] ?? "?"}) was imported`,
    );
  }
  const project = projectRows[0];
  const dataDate =
    isoDateOf(project?.["last_recalc_date"]) ?? isoDateOf(project?.["plan_end_date"]) ?? null;

  /* ---- tasks ---- */
  const taskRows = tableRows(tables, "TASK");
  const tasks: ParsedTask[] = [];
  const seen = new Set<string>();
  let order = 0;
  for (const r of taskRows) {
    const id = r["task_id"];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const calId = r["clndr_id"] || null;
    const hpd = (calId ? hoursByCalendar.get(calId) : undefined) ?? defaultHours;
    const targetHours = num(r["target_drtn_hr_cnt"]) ?? 0;
    const remainHours = num(r["remain_drtn_hr_cnt"]);
    const taskType = TASK_TYPE_MAP[r["task_type"] ?? ""] ?? "task";
    const isMilestone = taskType === "start_milestone" || taskType === "finish_milestone";
    const rawConstraint = r["cstr_type"] ?? "";
    if (rawConstraint && !(rawConstraint in CONSTRAINT_MAP)) {
      warnings.push(`Activity ${r["task_code"] ?? id}: constraint ${rawConstraint} is not modelled and was dropped`);
    }
    const constraintType = rawConstraint ? (CONSTRAINT_MAP[rawConstraint] ?? null) : null;
    const constraintDate = isoDateOf(r["cstr_date"]);
    const actualStart = isoDateOf(r["act_start_date"]);
    const actualFinish = isoDateOf(r["act_end_date"]);
    const pct = num(r["phys_complete_pct"]) ?? num(r["complete_pct"]) ?? 0;
    tasks.push({
      externalId: id,
      name: r["task_name"] || r["task_code"] || `Activity ${id}`,
      wbsCode: r["task_code"] || null,
      wbsPath: wbsPathOf(r["wbs_id"]),
      durationDays: isMilestone ? 0 : Math.max(0, Math.round(targetHours / hpd)),
      remainingDurationDays:
        remainHours === null || isMilestone ? null : Math.max(0, Math.round(remainHours / hpd)),
      taskType,
      calendarExternalId: calId,
      constraintType: constraintType && constraintDate ? constraintType : null,
      constraintDate: constraintType && constraintDate ? constraintDate : null,
      actualStart,
      actualFinish: actualStart ? actualFinish : null,
      percentComplete: Math.min(100, Math.max(0, pct)),
      plannedStart: isoDateOf(r["target_start_date"]) ?? isoDateOf(r["early_start_date"]),
      plannedFinish: isoDateOf(r["target_end_date"]) ?? isoDateOf(r["early_end_date"]),
      sortOrder: order++,
    });
    if (actualFinish && !actualStart) {
      warnings.push(
        `Activity ${r["task_code"] ?? id} had an actual finish with no actual start — the finish was dropped`,
      );
    }
  }

  /* ---- logic ---- */
  const predRows = tableRows(tables, "TASKPRED");
  const dependencies: ParsedDependency[] = [];
  for (const r of predRows) {
    const succ = r["task_id"];
    const pred = r["pred_task_id"];
    if (!succ || !pred || !seen.has(succ) || !seen.has(pred)) continue;
    const depType = DEP_MAP[r["pred_type"] ?? "PR_FS"] ?? "FS";
    const lagHours = num(r["lag_hr_cnt"]) ?? 0;
    dependencies.push({
      predecessorExternalId: pred,
      successorExternalId: succ,
      depType,
      lagDays: Math.round(lagHours / defaultHours),
    });
  }

  /* ---- resources (#370) ---- */
  const rsrcNames = new Map<string, string>();
  for (const r of tableRows(tables, "RSRC")) {
    if (r["rsrc_id"]) rsrcNames.set(r["rsrc_id"], r["rsrc_name"] || r["rsrc_short_name"] || r["rsrc_id"]);
  }
  const resources: ParsedResource[] = [];
  for (const r of tableRows(tables, "TASKRSRC")) {
    const taskId = r["task_id"];
    if (!taskId || !seen.has(taskId)) continue;
    const rsrcId = r["rsrc_id"] || null;
    const budgeted = num(r["target_qty"]) ?? 0;
    const actual = num(r["act_reg_qty"]) ?? 0;
    const remaining = num(r["remain_qty"]);
    const rate = num(r["cost_per_qty"]);
    resources.push({
      taskExternalId: taskId,
      externalId: rsrcId,
      name: (rsrcId ? rsrcNames.get(rsrcId) : undefined) ?? `Resource ${rsrcId ?? "?"}`,
      resourceType: r["rsrc_type"] === "RT_Equip" ? "equipment" : r["rsrc_type"] === "RT_Mat" ? "material" : "labour",
      unit: null,
      budgetedUnits: budgeted,
      actualUnits: actual,
      remainingUnits: remaining,
      unitRate: rate,
      budgetedCost: num(r["target_cost"]) ?? (rate !== null ? budgeted * rate : 0),
      actualCost: num(r["act_reg_cost"]) ?? 0,
    });
  }

  /* ---- project start = the earliest date the file implies ---- */
  const candidates = [
    isoDateOf(project?.["plan_start_date"]),
    ...tasks.map((t) => t.actualStart),
    ...tasks.map((t) => t.plannedStart),
  ].filter((d): d is string => d !== null);
  const projectStart =
    candidates.length > 0 ? candidates.reduce((a, b) => (b < a ? b : a)) : new Date().toISOString().slice(0, 10);
  if (candidates.length === 0) {
    warnings.push("No dates were found in the file — today was used as the programme start");
  }

  if (tasks.length === 0) warnings.push("The file contained no TASK rows");

  return {
    format: "xer",
    projectName: project?.["proj_short_name"] || null,
    externalRef: project?.["proj_id"] || null,
    projectStart,
    dataDate,
    calendars,
    tasks,
    dependencies,
    resources,
    warnings,
  };
}
