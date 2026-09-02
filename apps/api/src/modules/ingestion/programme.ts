/**
 * Programme importers — Primavera P6 XER and Microsoft Project XML
 * (spec Vol I §2.6 #349-350).
 *
 * WHY THIS EXISTS. Until now the only way a schedule reached the platform was
 * the `schedule_tasks` CSV dataset: flat activity rows with no logic, no
 * constraints, no calendars and no recompute. Every contractor programme in the
 * world is an XER or an MPP/XML, and a forensic module that can only reason
 * about hand-typed toy schedules cannot do the one job it exists for. Domain D
 * — windows analysis, as-planned vs as-built, concurrency — is arithmetic over
 * a logic network; without the links it is arithmetic over a list.
 *
 * WHAT IT DOES. Both parsers are PURE: text in, staged rows out, in exactly the
 * shape the `schedule_tasks` dataset already accepts, with `taskCode` and
 * `predecessors` carrying the logic. Nothing about the commit path changes —
 * the rows are staged, validated and committed like any other, which means an
 * imported programme goes through the same mapping review, the same validation
 * report and the same ledger entry a spreadsheet does.
 *
 * WHAT IT DELIBERATELY DOES NOT DO.
 *  · CALENDARS. P6 calendars (shift patterns, exceptions, non-work days) are
 *    not imported, so durations are read as CALENDAR days and the recomputed
 *    dates will differ from the contractor's where a working-day calendar
 *    applies. That is stated on every import result rather than hidden: a date
 *    that silently disagrees with the programme it came from is worse than a
 *    date the reader knows to check.
 *  · RESOURCES, COSTS, CODES, WBS HIERARCHY beyond the WBS code string.
 *  · MPP (the binary format). Microsoft Project must export XML; the binary is
 *    an OLE compound document with no open specification worth reimplementing.
 *  · Baselines. An imported programme is a programme, not a baseline; capture
 *    the baseline through the schedule module once it is in.
 */

import { parsePredecessorList } from "./datasets.js";

export type ProgrammeFormat = "p6_xer" | "msp_xml";

export interface ProgrammeTaskRow {
  taskCode: string;
  name: string;
  wbsCode: string | null;
  durationDays: number;
  actualStart: string | null;
  actualFinish: string | null;
  percentComplete: number | null;
  constraintType: string | null;
  constraintDate: string | null;
  /** rendered in the dataset's own `predecessors` grammar */
  predecessors: string;
  externalId: string;
}

export interface ProgrammeParseResult {
  format: ProgrammeFormat;
  /** the programme's own name, when it carries one */
  projectName: string | null;
  /** earliest date seen — the CPM day zero the schedule should carry */
  earliestDate: string | null;
  tasks: ProgrammeTaskRow[];
  /** links whose predecessor or successor is not in the file */
  danglingLinks: number;
  /** everything the reader must know about what was NOT imported */
  caveats: string[];
}

const CALENDAR_CAVEAT =
  "Calendars were not imported: durations are read as calendar days, so recomputed dates will " +
  "differ from the source programme wherever a working-day or shift calendar applies. Compare " +
  "the computed finish with the programme's own before relying on it.";

/** `2024-03-01 08:00` / `2024-03-01T08:00:00` / `01-MAR-24` → ISO date. */
export function normaliseDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (value === "") return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // P6 also writes DD-MMM-YY (01-MAR-24)
  const p6 = /^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})/.exec(value);
  if (p6) {
    const months: Record<string, string> = {
      jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
      jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
    };
    const mm = months[p6[2]!.toLowerCase()];
    if (!mm) return null;
    const yearRaw = p6[3]!;
    const year = yearRaw.length === 2 ? `20${yearRaw}` : yearRaw;
    return `${year}-${mm}-${p6[1]!.padStart(2, "0")}`;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}

/* ------------------------------------------------------------------ */
/* P6 XER                                                              */
/* ------------------------------------------------------------------ */

interface XerTable {
  fields: string[];
  rows: string[][];
}

/**
 * XER is a tab-delimited record stream: `%T` opens a table, `%F` names its
 * fields, `%R` is a row, `%E` ends the file. Values are never quoted, so a tab
 * split is exact.
 */
export function parseXerTables(text: string): Map<string, XerTable> {
  const tables = new Map<string, XerTable>();
  let current: XerTable | null = null;
  let currentName = "";
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine === "") continue;
    const parts = rawLine.split("\t");
    const tag = parts[0];
    if (tag === "%T") {
      currentName = (parts[1] ?? "").trim();
      current = { fields: [], rows: [] };
      tables.set(currentName, current);
    } else if (tag === "%F" && current) {
      current.fields = parts.slice(1).map((f) => f.trim());
    } else if (tag === "%R" && current) {
      current.rows.push(parts.slice(1));
    } else if (tag === "%E") {
      break;
    }
  }
  return tables;
}

function xerRecords(table: XerTable | undefined): Record<string, string>[] {
  if (!table) return [];
  return table.rows.map((row) => {
    const out: Record<string, string> = {};
    table.fields.forEach((f, i) => {
      out[f] = (row[i] ?? "").trim();
    });
    return out;
  });
}

/** P6 constraint codes → the platform's constraint vocabulary. */
const XER_CONSTRAINTS: Record<string, string> = {
  CS_MSO: "must_start_on",
  CS_MSOA: "start_no_earlier_than",
  CS_MSOB: "finish_no_later_than",
  CS_MEO: "finish_no_later_than",
  CS_MEOA: "start_no_earlier_than",
  CS_MEOB: "finish_no_later_than",
  CS_ALAP: "start_no_earlier_than",
};

const XER_LINK_TYPES: Record<string, string> = {
  PR_FS: "FS",
  PR_SS: "SS",
  PR_FF: "FF",
  PR_SF: "SF",
};

export function parseXer(text: string): ProgrammeParseResult {
  const tables = parseXerTables(text);
  const projects = xerRecords(tables.get("PROJECT"));
  const wbs = xerRecords(tables.get("PROJWBS"));
  const tasks = xerRecords(tables.get("TASK"));
  const preds = xerRecords(tables.get("TASKPRED"));

  const wbsById = new Map(
    wbs.map((w) => [w["wbs_id"] ?? "", w["wbs_short_name"] || w["wbs_name"] || ""]),
  );
  const codeById = new Map<string, string>();
  for (const t of tasks) {
    const id = t["task_id"] ?? "";
    const code = t["task_code"] || id;
    if (id) codeById.set(id, code);
  }

  const linksBySuccessor = new Map<string, string[]>();
  let dangling = 0;
  for (const link of preds) {
    const succ = codeById.get(link["task_id"] ?? "");
    const pred = codeById.get(link["pred_task_id"] ?? "");
    if (!succ || !pred) {
      dangling += 1;
      continue;
    }
    const type = XER_LINK_TYPES[link["pred_type"] ?? "PR_FS"] ?? "FS";
    // XER lags are in hours ("lag_hr_cnt"); 8 hours is one working day in the
    // default P6 calendar, and rounding to whole days is the honest resolution
    // for a calendar-day model.
    const hours = Number(link["lag_hr_cnt"] ?? "0");
    const lag = Number.isFinite(hours) ? Math.round(hours / 8) : 0;
    const entry = `${pred}:${type}${lag > 0 ? `+${lag}` : lag < 0 ? `${lag}` : ""}`;
    const list = linksBySuccessor.get(succ) ?? [];
    list.push(entry);
    linksBySuccessor.set(succ, list);
  }

  const rows: ProgrammeTaskRow[] = [];
  let earliest: string | null = null;
  for (const t of tasks) {
    const code = t["task_code"] || t["task_id"] || "";
    if (!code) continue;
    const hours = Number(t["target_drtn_hr_cnt"] ?? "");
    const durationDays = Number.isFinite(hours) ? Math.max(0, Math.round(hours / 8)) : 1;
    const actualStart = normaliseDate(t["act_start_date"]);
    const actualFinish = normaliseDate(t["act_end_date"]);
    const start = normaliseDate(t["early_start_date"] ?? t["target_start_date"]);
    for (const d of [actualStart, start]) {
      if (d && (earliest === null || d < earliest)) earliest = d;
    }
    const constraintType = XER_CONSTRAINTS[t["cstr_type"] ?? ""] ?? null;
    rows.push({
      taskCode: code,
      name: t["task_name"] || code,
      wbsCode: wbsById.get(t["wbs_id"] ?? "") || null,
      durationDays,
      actualStart,
      actualFinish,
      percentComplete: (() => {
        const raw = Number(t["phys_complete_pct"] ?? "");
        return Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : null;
      })(),
      constraintType,
      constraintDate: constraintType ? normaliseDate(t["cstr_date"]) : null,
      predecessors: (linksBySuccessor.get(code) ?? []).join("; "),
      externalId: `xer:${code}`,
    });
  }

  return {
    format: "p6_xer",
    projectName: projects[0]?.["proj_short_name"] || null,
    earliestDate: earliest,
    tasks: rows,
    danglingLinks: dangling,
    caveats: [
      CALENDAR_CAVEAT,
      "P6 lags are stored in hours and were converted at 8 hours per day.",
      "Resources, cost accounts, activity codes and the WBS hierarchy were not imported; the " +
        "WBS short name is carried on each task as its wbsCode.",
      ...(dangling > 0
        ? [`${dangling} relationship(s) referenced an activity outside this file and were dropped.`]
        : []),
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Microsoft Project XML                                               */
/* ------------------------------------------------------------------ */

/**
 * A deliberately small XML reader.
 *
 * MSP XML is a flat, predictable document — `<Task>` elements with scalar
 * children and nested `<PredecessorLink>` — and adding an XML parser
 * dependency for one shape the format guarantees is not a trade worth making.
 * It reads elements, not entities beyond the five standard ones, and it does
 * not resolve namespaces: it is a reader for THIS document type and says so.
 */
export function extractElements(xml: string, tag: string): string[] {
  const out: string[] = [];
  const open = new RegExp(`<${tag}(?:\\s[^>]*)?>`, "g");
  let match: RegExpExecArray | null;
  while ((match = open.exec(xml)) !== null) {
    const start = match.index + match[0].length;
    const close = xml.indexOf(`</${tag}>`, start);
    if (close === -1) break;
    out.push(xml.slice(start, close));
    open.lastIndex = close + tag.length + 3;
  }
  return out;
}

export function childText(fragment: string, tag: string): string | null {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(fragment);
  if (!m || m[1] === undefined) return null;
  return decodeXml(m[1].trim());
}

function decodeXml(v: string): string {
  return v
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

/** MSP link types: 0=FF, 1=FS, 2=SS, 3=SF. */
const MSP_LINK_TYPES: Record<string, string> = { "0": "FF", "1": "FS", "2": "SS", "3": "SF" };

/** MSP constraint types: 4=SNET, 2=MSO, 7=FNLT (the three the CPM engine has). */
const MSP_CONSTRAINTS: Record<string, string> = {
  "2": "must_start_on",
  "4": "start_no_earlier_than",
  "7": "finish_no_later_than",
};

/** `PT40H0M0S` / `P5D` → whole days at 8h. */
export function parseMspDuration(raw: string | null): number {
  if (!raw) return 1;
  const days = /P(\d+(?:\.\d+)?)D/.exec(raw);
  if (days?.[1]) return Math.max(0, Math.round(Number(days[1])));
  const hours = /PT(\d+(?:\.\d+)?)H/.exec(raw);
  if (hours?.[1]) return Math.max(0, Math.round(Number(hours[1]) / 8));
  return 1;
}

export function parseMspXml(xml: string): ProgrammeParseResult {
  const taskFragments = extractElements(xml, "Task");
  const nameById = new Map<string, string>();
  const parsed: {
    uid: string;
    fragment: string;
  }[] = [];
  for (const fragment of taskFragments) {
    const uid = childText(fragment, "UID");
    if (!uid) continue;
    parsed.push({ uid, fragment });
    nameById.set(uid, childText(fragment, "Name") ?? uid);
  }

  const rows: ProgrammeTaskRow[] = [];
  let earliest: string | null = null;
  let dangling = 0;
  for (const { uid, fragment } of parsed) {
    // UID 0 is the project summary row, not an activity.
    if (uid === "0") continue;
    const isSummary = childText(fragment, "Summary") === "1";
    if (isSummary) continue;
    const start = normaliseDate(childText(fragment, "Start"));
    const actualStart = normaliseDate(childText(fragment, "ActualStart"));
    const actualFinish = normaliseDate(childText(fragment, "ActualFinish"));
    for (const d of [actualStart, start]) {
      if (d && (earliest === null || d < earliest)) earliest = d;
    }
    const links: string[] = [];
    for (const link of extractElements(fragment, "PredecessorLink")) {
      const predUid = childText(link, "PredecessorUID");
      if (!predUid || !nameById.has(predUid)) {
        dangling += 1;
        continue;
      }
      const type = MSP_LINK_TYPES[childText(link, "Type") ?? "1"] ?? "FS";
      const lagRaw = Number(childText(link, "LinkLag") ?? "0");
      // MSP LinkLag is in tenths of a minute; 4800 tenths = 8 hours = one day.
      const lag = Number.isFinite(lagRaw) ? Math.round(lagRaw / 4800) : 0;
      links.push(`${predUid}:${type}${lag > 0 ? `+${lag}` : lag < 0 ? `${lag}` : ""}`);
    }
    const constraintType = MSP_CONSTRAINTS[childText(fragment, "ConstraintType") ?? ""] ?? null;
    const pct = Number(childText(fragment, "PercentComplete") ?? "");
    rows.push({
      taskCode: uid,
      name: childText(fragment, "Name") ?? uid,
      wbsCode: childText(fragment, "WBS"),
      durationDays: parseMspDuration(childText(fragment, "Duration")),
      actualStart,
      actualFinish,
      percentComplete: Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : null,
      constraintType,
      constraintDate: constraintType ? normaliseDate(childText(fragment, "ConstraintDate")) : null,
      predecessors: links.join("; "),
      externalId: `msp:${uid}`,
    });
  }

  return {
    format: "msp_xml",
    projectName: childText(xml, "Title") ?? childText(xml, "Name"),
    earliestDate: earliest,
    tasks: rows,
    danglingLinks: dangling,
    caveats: [
      CALENDAR_CAVEAT,
      "MSP durations and lags were converted at 8 hours per working day.",
      "Summary tasks and the project summary row were skipped; only leaf activities are imported.",
      "Resources, assignments, calendars and custom fields were not imported.",
      ...(dangling > 0
        ? [`${dangling} predecessor link(s) referenced a task outside this file and were dropped.`]
        : []),
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/** Which programme format this text is, or null when it is neither. */
export function sniffProgramme(text: string, fileName: string): ProgrammeFormat | null {
  const head = text.slice(0, 4096);
  if (head.startsWith("ERMHDR") || /^%T\t/m.test(head)) return "p6_xer";
  if (/<Project[\s>]/.test(head) || /<\?xml/.test(head.trimStart())) {
    return /<Project[\s>]/.test(text.slice(0, 65_536)) ? "msp_xml" : null;
  }
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".xer")) return "p6_xer";
  if (lower.endsWith(".xml")) return "msp_xml";
  return null;
}

export function parseProgramme(text: string, format: ProgrammeFormat): ProgrammeParseResult {
  return format === "p6_xer" ? parseXer(text) : parseMspXml(text);
}

/** Order the parsed logic so a link's predecessor is imported first. */
export function topoOrder(tasks: readonly ProgrammeTaskRow[]): ProgrammeTaskRow[] {
  const byCode = new Map(tasks.map((t) => [t.taskCode, t]));
  const seen = new Set<string>();
  const out: ProgrammeTaskRow[] = [];
  const visit = (task: ProgrammeTaskRow, stack: Set<string>) => {
    if (seen.has(task.taskCode)) return;
    // A cycle in the source programme is the source programme's problem: the
    // CPM engine reports it. Here it only means "stop descending".
    if (stack.has(task.taskCode)) return;
    stack.add(task.taskCode);
    for (const link of parsePredecessorList(task.predecessors).links) {
      const pred = byCode.get(link.taskCode);
      if (pred) visit(pred, stack);
    }
    stack.delete(task.taskCode);
    seen.add(task.taskCode);
    out.push(task);
  };
  for (const t of tasks) visit(t, new Set());
  return out;
}
