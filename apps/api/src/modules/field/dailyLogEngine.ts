/**
 * Daily-log engine — pure rules for spec Vol I §2.7:
 *   #382–#389 full section coverage and key-level merge (a save never wipes
 *             a section it did not carry),
 *   #392–#393 consolidated site-day view,
 *   #395      missing-log / compliance arithmetic,
 *   #397      templates and carry-forward,
 *   HTML export, AI-draft normalisation, and the owner-side reconciliation of
 *   logged manpower against timecard hours (Vol II assurance).
 */
import { addDaysISO, isBusinessDay } from "./dates.js";

export const SECTION_KEYS = [
  "manpower",
  "equipment",
  "deliveries",
  "visitors",
  "delays",
  "quantities",
  "inspections",
  "safetyViolations",
  "incidents",
  "waste",
  "calls",
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

type Sections = Record<string, unknown>;

/**
 * Key-level merge: a section present in `incoming` replaces the same section
 * in `existing`; sections absent from `incoming` are left untouched. Passing
 * an explicit `null` for a section clears it. This is what makes a page that
 * renders four sections safe to save without deleting the other seven.
 */
export function mergeSections(existing: Sections | null | undefined, incoming: Sections): Sections {
  const out: Sections = { ...(existing ?? {}) };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (value === null) {
      delete out[key];
      continue;
    }
    out[key] = value;
  }
  return out;
}

function asRows(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

/**
 * The AI daily-log agent historically wrote delays as {description,
 * durationHours} and manpower with an `activity` key. Normalise those shapes
 * to the canonical section rows so an AI-drafted log survives a UI save.
 */
export function normaliseAiSections(sections: Sections | null | undefined): Sections {
  if (!sections) return {};
  const out: Sections = { ...sections };
  const delays = asRows(sections["delays"]).map((row) => {
    if (row["cause"] === undefined && row["description"] !== undefined) {
      return {
        cause: str(row["category"] ?? row["type"] ?? "Unclassified"),
        description: str(row["description"]),
        hoursLost: row["hoursLost"] !== undefined ? num(row["hoursLost"]) : num(row["durationHours"]),
      };
    }
    return row;
  });
  if (delays.length > 0) out["delays"] = delays;
  const manpower = asRows(sections["manpower"]).map((row) => ({
    company: str(row["company"] ?? row["contractor"] ?? row["trade"] ?? "Unknown"),
    workers: Math.max(0, Math.round(num(row["workers"] ?? row["headcount"]))),
    hours: Math.max(0, num(row["hours"])),
    ...(row["notes"] !== undefined || row["activity"] !== undefined
      ? { notes: str(row["notes"] ?? row["activity"]) }
      : {}),
  }));
  if (manpower.length > 0) out["manpower"] = manpower;
  return out;
}

/* ------------------------------------------------------------------ */
/* Consolidated site-day view (#392)                                   */
/* ------------------------------------------------------------------ */

export interface LogForConsolidation {
  id: string;
  createdBy: string;
  status: string;
  logKind: string;
  vendorId: string | null;
  sections: Sections;
  weather: Record<string, unknown> | null;
}

export interface ConsolidatedDay {
  logs: number;
  submittedOrApproved: number;
  manpower: Array<{ company: string; workers: number; hours: number; sources: number }>;
  totalWorkers: number;
  totalHours: number;
  equipment: Array<{ name: string; hoursOperating: number; hoursIdle: number; sources: number }>;
  delays: Array<{ cause: string; description: string; hoursLost: number; reportedBy: string }>;
  totalHoursLost: number;
  deliveries: Array<{ supplier: string; description: string; reportedBy: string }>;
  visitors: Array<{ name: string; company: string; reportedBy: string }>;
  weather: Record<string, unknown> | null;
  /** creator ids whose logs are still draft — the approver's "who is missing" list */
  draftCreators: string[];
}

/** Aggregate every creator's log for one date; drafts are listed, not counted. */
export function consolidateLogs(logs: readonly LogForConsolidation[]): ConsolidatedDay {
  const counted = logs.filter((l) => l.status === "submitted" || l.status === "approved");
  const manpower = new Map<string, { workers: number; hours: number; sources: number }>();
  const equipment = new Map<string, { hoursOperating: number; hoursIdle: number; sources: number }>();
  const delays: ConsolidatedDay["delays"] = [];
  const deliveries: ConsolidatedDay["deliveries"] = [];
  const visitors: ConsolidatedDay["visitors"] = [];
  let weather: Record<string, unknown> | null = null;
  for (const log of counted) {
    for (const row of asRows(log.sections["manpower"])) {
      const key = str(row["company"]).trim() || "Unknown";
      const rec = manpower.get(key) ?? { workers: 0, hours: 0, sources: 0 };
      rec.workers += num(row["workers"]);
      rec.hours += num(row["hours"]);
      rec.sources += 1;
      manpower.set(key, rec);
    }
    for (const row of asRows(log.sections["equipment"])) {
      const key = str(row["name"]).trim() || "Unknown";
      const rec = equipment.get(key) ?? { hoursOperating: 0, hoursIdle: 0, sources: 0 };
      rec.hoursOperating += num(row["hoursOperating"]);
      rec.hoursIdle += num(row["hoursIdle"]);
      rec.sources += 1;
      equipment.set(key, rec);
    }
    for (const row of asRows(log.sections["delays"])) {
      delays.push({
        cause: str(row["cause"]),
        description: str(row["description"]),
        hoursLost: num(row["hoursLost"]),
        reportedBy: log.createdBy,
      });
    }
    for (const row of asRows(log.sections["deliveries"])) {
      deliveries.push({
        supplier: str(row["supplier"]),
        description: str(row["description"]),
        reportedBy: log.createdBy,
      });
    }
    for (const row of asRows(log.sections["visitors"])) {
      visitors.push({ name: str(row["name"]), company: str(row["company"]), reportedBy: log.createdBy });
    }
    // The internal (GC) log's weather wins; otherwise the first one recorded.
    if (log.weather && (weather === null || log.logKind === "internal")) weather = log.weather;
  }
  const manpowerRows = [...manpower.entries()]
    .map(([company, rec]) => ({ company, ...rec }))
    .sort((a, b) => b.hours - a.hours || a.company.localeCompare(b.company));
  return {
    logs: logs.length,
    submittedOrApproved: counted.length,
    manpower: manpowerRows,
    totalWorkers: manpowerRows.reduce((s, r) => s + r.workers, 0),
    totalHours: Math.round(manpowerRows.reduce((s, r) => s + r.hours, 0) * 100) / 100,
    equipment: [...equipment.entries()]
      .map(([name, rec]) => ({ name, ...rec }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    delays,
    totalHoursLost: Math.round(delays.reduce((s, d) => s + d.hoursLost, 0) * 100) / 100,
    deliveries,
    visitors,
    weather,
    draftCreators: logs.filter((l) => l.status === "draft").map((l) => l.createdBy),
  };
}

/* ------------------------------------------------------------------ */
/* Missing logs and compliance (#395)                                  */
/* ------------------------------------------------------------------ */

/** Business days in [from, to], capped at `maxDays` to bound a sweep. */
export function businessDaysBetween(from: string, to: string, maxDays = 400): string[] {
  const days: string[] = [];
  let day = from;
  let guard = 0;
  while (day <= to && guard < maxDays) {
    if (isBusinessDay(day)) days.push(day);
    day = addDaysISO(day, 1);
    guard += 1;
  }
  return days;
}

export interface ComplianceRow {
  createdBy: string;
  expected: number;
  submitted: number;
  missing: string[];
  pct: number | null;
}

/**
 * Submitted-vs-expected business days per creator. Expected days are the
 * business days in the window; a creator who has never logged is not listed
 * (there is no basis to expect them to). `pct` is null with no expected days.
 */
export function complianceByCreator(
  logs: readonly { createdBy: string; logDate: string; status: string }[],
  from: string,
  to: string,
): ComplianceRow[] {
  const expectedDays = businessDaysBetween(from, to);
  const byCreator = new Map<string, Set<string>>();
  for (const log of logs) {
    if (log.status !== "submitted" && log.status !== "approved") {
      if (!byCreator.has(log.createdBy)) byCreator.set(log.createdBy, new Set());
      continue;
    }
    const set = byCreator.get(log.createdBy) ?? new Set<string>();
    set.add(log.logDate);
    byCreator.set(log.createdBy, set);
  }
  return [...byCreator.entries()]
    .map(([createdBy, days]) => {
      const submitted = expectedDays.filter((d) => days.has(d)).length;
      return {
        createdBy,
        expected: expectedDays.length,
        submitted,
        missing: expectedDays.filter((d) => !days.has(d)),
        pct: expectedDays.length > 0 ? Math.round((submitted / expectedDays.length) * 1000) / 10 : null,
      };
    })
    .sort((a, b) => (a.pct ?? 0) - (b.pct ?? 0) || a.createdBy.localeCompare(b.createdBy));
}

/* ------------------------------------------------------------------ */
/* Templates and carry-forward (#397)                                  */
/* ------------------------------------------------------------------ */

/**
 * Apply a template's default rows underneath a (possibly empty) set of
 * sections: template rows fill sections the log does not have; sections the
 * log already carries are kept verbatim.
 */
export function applyTemplate(template: Sections, sections: Sections | null | undefined): Sections {
  const out: Sections = { ...(sections ?? {}) };
  for (const [key, rows] of Object.entries(template)) {
    if (!Array.isArray(rows)) continue;
    const existing = out[key];
    if (Array.isArray(existing) && existing.length > 0) continue;
    out[key] = rows;
  }
  return out;
}

/**
 * Carry forward the structural sections of a previous day (manpower
 * companies with zeroed hours, equipment names with zeroed hours) — never the
 * day-specific ones (deliveries, delays, visitors, quantities, incidents).
 */
export function carryForwardSections(previous: Sections | null | undefined): Sections {
  if (!previous) return {};
  const out: Sections = {};
  const manpower = asRows(previous["manpower"]).map((row) => ({
    company: str(row["company"]),
    workers: 0,
    hours: 0,
  }));
  if (manpower.length > 0) out["manpower"] = manpower;
  const equipment = asRows(previous["equipment"]).map((row) => ({
    name: str(row["name"]),
    hoursOperating: 0,
    hoursIdle: 0,
  }));
  if (equipment.length > 0) out["equipment"] = equipment;
  return out;
}

/* ------------------------------------------------------------------ */
/* Reconciliation — logged hours vs timecards (owner-side assurance)   */
/* ------------------------------------------------------------------ */

export interface ReconciliationVariance {
  key: string;
  loggedHours: number;
  timecardHours: number;
  varianceHours: number;
  variancePct: number | null;
  flagged: boolean;
}

/**
 * Compare hours claimed on the daily log (by company/vendor key) with hours on
 * timecards for the same key and day. A key with no timecards at all is
 * flagged only when the log claims hours (there is nothing to reconcile a
 * zero against). Variance % is relative to the timecard figure; null when
 * timecards are zero.
 */
export function reconcileHours(
  logged: ReadonlyMap<string, number>,
  timecards: ReadonlyMap<string, number>,
  thresholdPct: number,
): ReconciliationVariance[] {
  const keys = new Set([...logged.keys(), ...timecards.keys()]);
  const out: ReconciliationVariance[] = [];
  for (const key of keys) {
    const loggedHours = Math.round((logged.get(key) ?? 0) * 100) / 100;
    const timecardHours = Math.round((timecards.get(key) ?? 0) * 100) / 100;
    const varianceHours = Math.round((loggedHours - timecardHours) * 100) / 100;
    const variancePct =
      timecardHours > 0 ? Math.round((varianceHours / timecardHours) * 1000) / 10 : null;
    const flagged =
      timecardHours > 0
        ? Math.abs(variancePct ?? 0) > thresholdPct
        : loggedHours > 0;
    out.push({ key, loggedHours, timecardHours, varianceHours, variancePct, flagged });
  }
  return out.sort((a, b) => Math.abs(b.varianceHours) - Math.abs(a.varianceHours) || a.key.localeCompare(b.key));
}

/* ------------------------------------------------------------------ */
/* HTML export                                                         */
/* ------------------------------------------------------------------ */

export function escapeHtml(value: unknown): string {
  return str(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const SECTION_COLUMNS: Record<string, string[]> = {
  manpower: ["company", "workers", "hours", "notes"],
  equipment: ["name", "hoursOperating", "hoursIdle"],
  deliveries: ["supplier", "description", "trackingRef"],
  visitors: ["name", "company", "reason"],
  delays: ["cause", "description", "hoursLost"],
  quantities: ["costCode", "description", "qty", "unit"],
  inspections: ["inspector", "agency", "subject", "outcome"],
  safetyViolations: ["subject", "description", "issuedTo"],
  incidents: ["title", "description", "incidentId"],
  waste: ["material", "qty", "unit", "disposal"],
  calls: ["with", "subject", "summary"],
};

function labelOf(key: string): string {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

export interface HtmlExportMeta {
  projectName: string;
  creatorName: string;
  approverName: string | null;
  generatedAt: string;
}

/** A printable, self-contained HTML rendering of one daily log. */
export function renderDailyLogHtml(
  log: {
    logDate: string;
    status: string;
    weather: Record<string, unknown> | null;
    weatherSource: string | null;
    sections: Sections;
    notes: string | null;
    logKind: string;
  },
  meta: HtmlExportMeta,
): string {
  const parts: string[] = [];
  parts.push(
    `<!doctype html><html><head><meta charset="utf-8"><title>Daily log ${escapeHtml(log.logDate)} — ${escapeHtml(meta.projectName)}</title>` +
      `<style>body{font:13px/1.45 system-ui,sans-serif;color:#111;margin:32px}h1{font-size:20px;margin:0 0 4px}h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#555;margin:20px 0 6px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:4px 8px;text-align:left;vertical-align:top}th{background:#f4f4f4}.meta{color:#555;font-size:12px}.empty{color:#888;font-style:italic}</style></head><body>`,
  );
  parts.push(`<h1>Daily log — ${escapeHtml(log.logDate)}</h1>`);
  parts.push(
    `<div class="meta">${escapeHtml(meta.projectName)} · ${escapeHtml(log.logKind)} log by ${escapeHtml(meta.creatorName)} · status ${escapeHtml(log.status)}` +
      (meta.approverName ? ` · approved by ${escapeHtml(meta.approverName)}` : "") +
      ` · generated ${escapeHtml(meta.generatedAt)}</div>`,
  );
  parts.push(`<h2>Weather${log.weatherSource ? ` (${escapeHtml(log.weatherSource)})` : ""}</h2>`);
  if (log.weather && Object.keys(log.weather).length > 0) {
    parts.push("<table><tbody>");
    for (const [k, v] of Object.entries(log.weather)) {
      parts.push(`<tr><th>${escapeHtml(labelOf(k))}</th><td>${escapeHtml(v)}</td></tr>`);
    }
    parts.push("</tbody></table>");
  } else {
    parts.push(`<p class="empty">Not recorded.</p>`);
  }
  for (const key of SECTION_KEYS) {
    const rows = asRows(log.sections[key]);
    parts.push(`<h2>${escapeHtml(labelOf(key))}</h2>`);
    if (rows.length === 0) {
      parts.push(`<p class="empty">Nothing recorded.</p>`);
      continue;
    }
    const cols = SECTION_COLUMNS[key] ?? Object.keys(rows[0] ?? {});
    parts.push("<table><thead><tr>");
    for (const c of cols) parts.push(`<th>${escapeHtml(labelOf(c))}</th>`);
    parts.push("</tr></thead><tbody>");
    for (const row of rows) {
      parts.push("<tr>");
      for (const c of cols) parts.push(`<td>${escapeHtml(row[c] ?? "")}</td>`);
      parts.push("</tr>");
    }
    parts.push("</tbody></table>");
  }
  parts.push("<h2>Notes</h2>");
  parts.push(
    log.notes ? `<p>${escapeHtml(log.notes).replace(/\n/g, "<br>")}</p>` : `<p class="empty">None.</p>`,
  );
  parts.push("</body></html>");
  return parts.join("");
}
