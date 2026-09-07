/**
 * Microsoft Project MSPDI (Project XML) importer and exporter (#349-350).
 *
 * MSPDI is plain XML with a stable shape, so a small scanner beats a
 * dependency: `<Project>` carries `<StartDate>`, `<CurrentDate>` (the status
 * date), `<Calendars>` and `<Tasks>`; each `<Task>` carries `<UID>`,
 * `<Name>`, `<WBS>`, `<Duration>` (ISO-8601 `PT40H0M0S`), `<PercentComplete>`,
 * `<ActualStart>`, `<ActualFinish>`, `<ConstraintType>` (0-7) and any number
 * of `<PredecessorLink>` children.
 *
 * Link `<Type>` is 0=FF, 1=FS, 2=SF, 3=SS — NOT the order a reader expects,
 * which is exactly the sort of detail an importer has to get right.
 * `<LinkLag>` is in tenths of a minute, converted here through the calendar's
 * hours-per-day into whole calendar days.
 *
 * The exporter emits the same dialect so a programme can go back to a planner
 * in the tool they use.
 *
 * Deliberately NOT handled: resource assignments on export, split tasks,
 * elapsed durations (`PT…` with the elapsed flag), and manually-scheduled
 * tasks (imported as normal activities with a warning).
 */
import type { DependencyType, ScheduleTaskType, TaskConstraintType } from "@constructos/shared";
import {
  DEFAULT_WORKDAYS,
  isoDateOf,
  type ParsedCalendar,
  type ParsedDependency,
  type ParsedSchedule,
  type ParsedTask,
} from "./types.js";

/* ------------------------------------------------------------------ */
/* Minimal XML scanning (no dependency, no entity expansion beyond the */
/* five predefined entities — external entities are never resolved)    */
/* ------------------------------------------------------------------ */

const MAX_BLOCKS = 100_000;

/** Inner XML of every `<tag>…</tag>` at any depth, handling nesting. */
export function xmlBlocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const open = new RegExp(`<${tag}(\\s[^>]*)?>`, "g");
  const closeTag = `</${tag}>`;
  let m: RegExpExecArray | null;
  while ((m = open.exec(xml)) !== null && out.length < MAX_BLOCKS) {
    const from = m.index + m[0].length;
    // Walk forward balancing nested same-name tags.
    let depth = 1;
    let cursor = from;
    while (depth > 0) {
      const nextOpen = xml.indexOf(`<${tag}`, cursor);
      const nextClose = xml.indexOf(closeTag, cursor);
      if (nextClose === -1) return out;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        const after = xml[nextOpen + tag.length + 1];
        if (after === ">" || after === " " || after === "\n" || after === "\t" || after === "\r") depth += 1;
        cursor = nextOpen + tag.length + 1;
      } else {
        depth -= 1;
        cursor = nextClose + closeTag.length;
      }
    }
    out.push(xml.slice(from, cursor - closeTag.length));
    open.lastIndex = cursor;
  }
  return out;
}

export function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

export function encodeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** First direct text value of `<tag>` inside a block. */
export function xmlValue(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`);
  const m = re.exec(block);
  return m ? decodeXml(m[2]!).trim() : null;
}

const numValue = (block: string, tag: string): number | null => {
  const raw = xmlValue(block, tag);
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/** `PT40H30M0S` → hours. */
export function durationHours(raw: string | null): number | null {
  if (!raw) return null;
  const m = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(raw.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) + Number(m[2] ?? 0) / 60 + Number(m[3] ?? 0) / 3600;
}

/** MSPDI ConstraintType codes. */
const CONSTRAINT_MAP: Record<number, TaskConstraintType | null> = {
  0: null, // as soon as possible
  1: null, // as late as possible
  2: "must_start_on",
  3: "finish_no_later_than", // must finish on — modelled as a hard latest finish
  4: "start_no_earlier_than",
  5: null, // start no later than — no engine equivalent
  6: null, // finish no earlier than
  7: "finish_no_later_than",
};

/** MSPDI PredecessorLink Type codes. */
const LINK_MAP: Record<number, DependencyType> = { 0: "FF", 1: "FS", 2: "SF", 3: "SS" };

export function parseMspdi(xml: string): ParsedSchedule {
  const warnings: string[] = [];
  if (!/<Project[\s>]/.test(xml)) {
    throw new Error("Not a readable MS Project XML file — no <Project> element was found");
  }

  /* ---- calendars ---- */
  const calendarsXml = xmlBlocks(xml, "Calendars")[0] ?? "";
  const calendars: ParsedCalendar[] = [];
  for (const cal of xmlBlocks(calendarsXml, "Calendar")) {
    const uid = xmlValue(cal, "UID");
    if (!uid) continue;
    const workdays = [0, 0, 0, 0, 0, 0, 0];
    const holidays: string[] = [];
    let sawWeekday = false;
    let hoursPerDay = 0;
    let workingDayCount = 0;
    for (const wd of xmlBlocks(cal, "WeekDay")) {
      const dayType = numValue(wd, "DayType");
      const working = xmlValue(wd, "DayWorking");
      if (dayType !== null && dayType >= 1 && dayType <= 7) {
        sawWeekday = true;
        if (working === "1") {
          workdays[dayType - 1] = 1; // MSPDI DayType 1 = Sunday
          workingDayCount += 1;
          let dayHours = 0;
          for (const wt of xmlBlocks(wd, "WorkingTime")) {
            const from = xmlValue(wt, "FromTime");
            const to = xmlValue(wt, "ToTime");
            if (from && to) {
              const f = Number(from.slice(0, 2)) * 60 + Number(from.slice(3, 5));
              const t = Number(to.slice(0, 2)) * 60 + Number(to.slice(3, 5));
              if (Number.isFinite(f) && Number.isFinite(t) && t > f) dayHours += (t - f) / 60;
            }
          }
          hoursPerDay += dayHours;
        }
      } else if (dayType === 0 && working === "0") {
        // an exception day: <TimePeriod><FromDate>…
        for (const tp of xmlBlocks(wd, "TimePeriod")) {
          const iso = isoDateOf(xmlValue(tp, "FromDate"));
          if (iso) holidays.push(iso);
        }
      }
    }
    for (const exc of xmlBlocks(cal, "Exception")) {
      if (xmlValue(exc, "DayWorking") === "1") continue;
      for (const tp of xmlBlocks(exc, "TimePeriod")) {
        const iso = isoDateOf(xmlValue(tp, "FromDate"));
        if (iso) holidays.push(iso);
      }
    }
    calendars.push({
      externalId: uid,
      name: xmlValue(cal, "Name") ?? `Calendar ${uid}`,
      workdays: sawWeekday && workdays.some((d) => d === 1) ? workdays : [...DEFAULT_WORKDAYS],
      holidays: [...new Set(holidays)],
      exceptions: [],
      hoursPerDay: workingDayCount > 0 && hoursPerDay > 0 ? hoursPerDay / workingDayCount : 8,
      isDefault: false,
    });
  }
  if (calendars.length === 0) {
    warnings.push("The file declared no calendars — a Mon-Fri 8h calendar was assumed");
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
  const projectCalendarUid = xmlValue(xml.slice(0, xml.indexOf("<Tasks") + 1), "CalendarUID");
  const defaultCal =
    calendars.find((c) => c.externalId === projectCalendarUid) ?? calendars[0]!;
  defaultCal.isDefault = true;
  const defaultHours = defaultCal.hoursPerDay > 0 ? defaultCal.hoursPerDay : 8;
  const hoursOf = (uid: string | null): number => {
    const c = uid ? calendars.find((x) => x.externalId === uid) : undefined;
    return c && c.hoursPerDay > 0 ? c.hoursPerDay : defaultHours;
  };

  /* ---- tasks ---- */
  const tasksXml = xmlBlocks(xml, "Tasks")[0] ?? "";
  const tasks: ParsedTask[] = [];
  const dependencies: ParsedDependency[] = [];
  const seen = new Set<string>();
  let order = 0;
  for (const block of xmlBlocks(tasksXml, "Task")) {
    const uid = xmlValue(block, "UID");
    if (!uid || seen.has(uid)) continue;
    // UID 0 is the project summary row, not an activity.
    if (uid === "0") continue;
    seen.add(uid);
    const calUid = xmlValue(block, "CalendarUID");
    const hpd = hoursOf(calUid);
    const isSummary = xmlValue(block, "Summary") === "1";
    const isMilestone = xmlValue(block, "Milestone") === "1";
    const hours = durationHours(xmlValue(block, "Duration"));
    const remainingHours = durationHours(xmlValue(block, "RemainingDuration"));
    if (xmlValue(block, "Manual") === "1") {
      warnings.push(`Task ${xmlValue(block, "Name") ?? uid} is manually scheduled — imported as a normal activity`);
    }
    const constraintCode = numValue(block, "ConstraintType");
    const constraintDate = isoDateOf(xmlValue(block, "ConstraintDate"));
    const mapped = constraintCode !== null ? (CONSTRAINT_MAP[constraintCode] ?? null) : null;
    if (constraintCode !== null && constraintCode !== 0 && mapped === null) {
      warnings.push(
        `Task ${xmlValue(block, "Name") ?? uid}: constraint type ${constraintCode} has no engine equivalent and was dropped`,
      );
    }
    const actualStart = isoDateOf(xmlValue(block, "ActualStart"));
    const actualFinish = isoDateOf(xmlValue(block, "ActualFinish"));
    const taskType: ScheduleTaskType = isSummary
      ? "wbs_summary"
      : isMilestone
        ? "start_milestone"
        : "task";
    tasks.push({
      externalId: uid,
      name: xmlValue(block, "Name") ?? `Task ${uid}`,
      wbsCode: xmlValue(block, "WBS"),
      wbsPath: xmlValue(block, "OutlineNumber"),
      durationDays: isMilestone || hours === null ? (isMilestone ? 0 : 1) : Math.max(0, Math.round(hours / hpd)),
      remainingDurationDays:
        remainingHours === null || isMilestone ? null : Math.max(0, Math.round(remainingHours / hpd)),
      taskType,
      calendarExternalId: calUid,
      constraintType: mapped && constraintDate ? mapped : null,
      constraintDate: mapped && constraintDate ? constraintDate : null,
      actualStart,
      actualFinish: actualStart ? actualFinish : null,
      percentComplete: Math.min(100, Math.max(0, numValue(block, "PercentComplete") ?? 0)),
      plannedStart: isoDateOf(xmlValue(block, "Start")),
      plannedFinish: isoDateOf(xmlValue(block, "Finish")),
      sortOrder: order++,
    });
    for (const link of xmlBlocks(block, "PredecessorLink")) {
      const pred = xmlValue(link, "PredecessorUID");
      if (!pred) continue;
      const typeCode = numValue(link, "Type");
      const lagTenthsOfMinutes = numValue(link, "LinkLag") ?? 0;
      dependencies.push({
        predecessorExternalId: pred,
        successorExternalId: uid,
        depType: typeCode !== null ? (LINK_MAP[typeCode] ?? "FS") : "FS",
        lagDays: Math.round(lagTenthsOfMinutes / 600 / hpd),
      });
    }
  }
  const known = new Set(tasks.map((t) => t.externalId));
  const logic = dependencies.filter(
    (d) => known.has(d.predecessorExternalId) && known.has(d.successorExternalId),
  );
  if (logic.length !== dependencies.length) {
    warnings.push(
      `${dependencies.length - logic.length} predecessor link(s) referenced tasks outside the file and were dropped`,
    );
  }

  const headerStart = isoDateOf(xmlValue(xml, "StartDate"));
  const candidates = [headerStart, ...tasks.map((t) => t.actualStart), ...tasks.map((t) => t.plannedStart)].filter(
    (d): d is string => d !== null,
  );
  const projectStart =
    candidates.length > 0 ? candidates.reduce((a, b) => (b < a ? b : a)) : new Date().toISOString().slice(0, 10);
  if (candidates.length === 0) {
    warnings.push("No dates were found in the file — today was used as the programme start");
  }
  if (tasks.length === 0) warnings.push("The file contained no <Task> elements");

  return {
    format: "mspdi",
    projectName: xmlValue(xml, "Title") ?? xmlValue(xml, "Name"),
    externalRef: xmlValue(xml, "UID"),
    projectStart,
    dataDate: isoDateOf(xmlValue(xml, "CurrentDate")) ?? isoDateOf(xmlValue(xml, "StatusDate")),
    calendars,
    tasks,
    dependencies: logic,
    resources: [],
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* Export (#350 — round-trip back to the planner's tool)               */
/* ------------------------------------------------------------------ */

export interface ExportTask {
  id: string;
  name: string;
  wbsCode: string | null;
  durationDays: number;
  startDate: string | null;
  finishDate: string | null;
  actualStart: string | null;
  actualFinish: string | null;
  percentComplete: number;
  taskType: string;
  totalFloat: number | null;
  isCritical: boolean;
  sortOrder: number;
}

export interface ExportDependency {
  predecessorId: string;
  successorId: string;
  depType: string;
  lagDays: number;
}

const REVERSE_LINK: Record<string, number> = { FF: 0, FS: 1, SF: 2, SS: 3 };

/** Emit an MSPDI document for a computed schedule. */
export function exportMspdi(input: {
  name: string;
  projectStart: string;
  dataDate: string | null;
  hoursPerDay?: number;
  tasks: ExportTask[];
  dependencies: ExportDependency[];
}): string {
  const hpd = input.hoursPerDay && input.hoursPerDay > 0 ? input.hoursPerDay : 8;
  const uid = new Map<string, number>();
  input.tasks.forEach((t, i) => uid.set(t.id, i + 1));
  const dt = (iso: string | null): string => (iso ? `${iso}T08:00:00` : "");
  const dur = (days: number): string => `PT${Math.round(days * hpd)}H0M0S`;

  const taskXml = input.tasks
    .map((t) => {
      const links = input.dependencies
        .filter((d) => d.successorId === t.id && uid.has(d.predecessorId))
        .map(
          (d) =>
            `      <PredecessorLink><PredecessorUID>${uid.get(d.predecessorId)}</PredecessorUID>` +
            `<Type>${REVERSE_LINK[d.depType] ?? 1}</Type><LinkLag>${Math.round(d.lagDays * hpd * 600)}</LinkLag>` +
            `<LagFormat>7</LagFormat></PredecessorLink>`,
        )
        .join("\n");
      return [
        "    <Task>",
        `      <UID>${uid.get(t.id)}</UID>`,
        `      <ID>${t.sortOrder + 1}</ID>`,
        `      <Name>${encodeXml(t.name)}</Name>`,
        t.wbsCode ? `      <WBS>${encodeXml(t.wbsCode)}</WBS>` : "",
        `      <Type>1</Type>`,
        `      <Milestone>${t.durationDays === 0 ? 1 : 0}</Milestone>`,
        `      <Summary>${t.taskType === "wbs_summary" ? 1 : 0}</Summary>`,
        `      <Critical>${t.isCritical ? 1 : 0}</Critical>`,
        `      <Duration>${dur(t.durationDays)}</Duration>`,
        `      <DurationFormat>7</DurationFormat>`,
        t.startDate ? `      <Start>${dt(t.startDate)}</Start>` : "",
        t.finishDate ? `      <Finish>${dt(t.finishDate)}</Finish>` : "",
        t.actualStart ? `      <ActualStart>${dt(t.actualStart)}</ActualStart>` : "",
        t.actualFinish ? `      <ActualFinish>${dt(t.actualFinish)}</ActualFinish>` : "",
        `      <PercentComplete>${Math.round(t.percentComplete)}</PercentComplete>`,
        t.totalFloat !== null ? `      <TotalSlack>${Math.round(t.totalFloat * hpd * 600)}</TotalSlack>` : "",
        links,
        "    </Task>",
      ]
        .filter((line) => line !== "")
        .join("\n");
    })
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Project xmlns="http://schemas.microsoft.com/project">',
    `  <Name>${encodeXml(input.name)}</Name>`,
    `  <Title>${encodeXml(input.name)}</Title>`,
    `  <StartDate>${dt(input.projectStart)}</StartDate>`,
    input.dataDate ? `  <CurrentDate>${dt(input.dataDate)}</CurrentDate>` : "",
    input.dataDate ? `  <StatusDate>${dt(input.dataDate)}</StatusDate>` : "",
    "  <ScheduleFromStart>1</ScheduleFromStart>",
    `  <MinutesPerDay>${Math.round(hpd * 60)}</MinutesPerDay>`,
    "  <Tasks>",
    taskXml,
    "  </Tasks>",
    "</Project>",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
