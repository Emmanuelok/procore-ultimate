/**
 * Submittal engine — pure rules for spec Vol I §2.5:
 *   #337 backward scheduling from required-on-site,
 *   #338 submittal schedule generation from spec sections,
 *   #339 at-risk flagging,
 *   #334 final response-code precedence across parallel reviewers,
 *   #340 resubmittal chain rules,
 *   #347 turnaround analytics,
 *   #348 closeout segregation.
 *
 * No database, no clock: every function takes the dates it needs.
 */
import { CLOSEOUT_SUBMITTAL_TYPES, SUBMITTAL_RESPONSES } from "@constructos/shared";
import { addDaysISO, daysBetween } from "./dates.js";
import { average, median } from "./ageingEngine.js";

export const DEFAULT_REVIEW_ALLOWANCE_DAYS = 14;
export const DEFAULT_AT_RISK_DAYS = 7;
/** Days a reviewer may hold a submittal before the register calls it in-court overdue. */
export const DEFAULT_IN_COURT_ALLOWANCE_DAYS = 10;

/**
 * Final-code precedence when a group of parallel reviewers respond with
 * different codes: the most restrictive wins, and a pure for_record chain
 * stays for_record instead of being promoted to "approved".
 */
export const RESPONSE_PRECEDENCE: readonly string[] = [
  "rejected",
  "revise_and_resubmit",
  "approved_as_noted",
  "approved",
  "for_record",
];

export interface ResponseCodeDef {
  code: string;
  label: string;
  isApproval: boolean;
  isResubmit: boolean;
  sortOrder: number;
}

/** The five built-in codes, in precedence order, used when a company has no custom set. */
export const BUILTIN_RESPONSE_CODES: readonly ResponseCodeDef[] = [
  { code: "rejected", label: "Rejected", isApproval: false, isResubmit: true, sortOrder: 0 },
  {
    code: "revise_and_resubmit",
    label: "Revise and resubmit",
    isApproval: false,
    isResubmit: true,
    sortOrder: 1,
  },
  {
    code: "approved_as_noted",
    label: "Approved as noted",
    isApproval: true,
    isResubmit: false,
    sortOrder: 2,
  },
  { code: "approved", label: "Approved", isApproval: true, isResubmit: false, sortOrder: 3 },
  { code: "for_record", label: "For record", isApproval: false, isResubmit: false, sortOrder: 4 },
];

export function isBuiltinResponseCode(code: string): boolean {
  return (SUBMITTAL_RESPONSES as readonly string[]).includes(code);
}

/**
 * Resolve the final code from every step's code. Precedence is explicit:
 * a resubmit code beats an approval; an approval beats for_record; among
 * approvals "as noted" is the more restrictive. Custom codes are ranked by
 * their sortOrder (lower = more restrictive) after the built-ins.
 */
export function resolveFinalCode(
  codes: readonly (string | null | undefined)[],
  customCodes: readonly ResponseCodeDef[] = [],
): string | null {
  const present = codes.filter((c): c is string => typeof c === "string" && c !== "");
  if (present.length === 0) return null;
  const rank = (code: string): number => {
    const builtin = RESPONSE_PRECEDENCE.indexOf(code);
    if (builtin >= 0) return builtin;
    const custom = customCodes.find((c) => c.code === code);
    if (custom) {
      // Resubmit codes sit with the restrictive built-ins, approvals in the
      // middle, everything else with for_record.
      if (custom.isResubmit) return 1.5;
      if (custom.isApproval) return 3.5;
      return 4.5;
    }
    return 99;
  };
  return present.reduce((best, code) => (rank(code) < rank(best) ? code : best));
}

export function isResubmitCode(code: string, customCodes: readonly ResponseCodeDef[] = []): boolean {
  if (code === "revise_and_resubmit" || code === "rejected") return true;
  return customCodes.some((c) => c.code === code && c.isResubmit);
}

/** #337 — submit-by = required-on-site − lead time − review allowance. */
export function computeSubmitBy(
  requiredOnSite: string | null | undefined,
  leadTimeDays: number | null | undefined,
  reviewAllowanceDays: number = DEFAULT_REVIEW_ALLOWANCE_DAYS,
): string | null {
  if (!requiredOnSite) return null;
  return addDaysISO(requiredOnSite, -((leadTimeDays ?? 0) + reviewAllowanceDays));
}

/** #348 — closeout submittals are segregated by type. */
export function isCloseoutType(submittalType: string): boolean {
  return (CLOSEOUT_SUBMITTAL_TYPES as readonly string[]).includes(submittalType);
}

const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["draft", "open", "in_review"]);

export type SubmittalRisk = "none" | "late" | "at_risk" | "required_on_site_passed";

/**
 * #339 — at-risk when the submit-by date is within `atRiskDays`, late when it
 * has passed, and "required_on_site_passed" when the site date itself has
 * gone by without a final response. Closed/responded records are never at risk.
 */
export function submittalRisk(
  row: { status: string; submitByDate: string | null; requiredOnSite: string | null },
  todayIso: string,
  atRiskDays: number = DEFAULT_AT_RISK_DAYS,
): SubmittalRisk {
  if (!ACTIVE_STATUSES.has(row.status)) return "none";
  if (row.requiredOnSite && row.requiredOnSite < todayIso) return "required_on_site_passed";
  if (!row.submitByDate) return "none";
  if (row.submitByDate < todayIso) return "late";
  if (row.submitByDate < addDaysISO(todayIso, atRiskDays)) return "at_risk";
  return "none";
}

export interface StepLike {
  id: string;
  position: number;
  reviewerId: string;
  responseCode: string | null;
}

/** The lowest-position group of unresponded steps, or null when the chain is done. */
export function firstPendingGroup<T extends StepLike>(
  steps: readonly T[],
): { position: number; steps: T[] } | null {
  const pending = steps.filter((s) => !s.responseCode);
  if (pending.length === 0) return null;
  const position = Math.min(...pending.map((s) => s.position));
  return { position, steps: pending.filter((s) => s.position === position) };
}

/**
 * A submittal is stranded when it says it is in review but no step is left
 * to respond — the failure mode two concurrent parallel reviewers produced
 * before responses were serialised. Detail reads and the repair route use it.
 */
export function chainIsStranded(status: string, steps: readonly StepLike[]): boolean {
  return status === "in_review" && steps.length > 0 && firstPendingGroup(steps) === null;
}

/* ------------------------------------------------------------------ */
/* #338 schedule generation                                            */
/* ------------------------------------------------------------------ */

export interface ScheduleSeed {
  specSection: string;
  title: string;
  submittalType?: string;
  requiredOnSite?: string | null;
  leadTimeDays?: number | null;
}

export interface ScheduleRow extends ScheduleSeed {
  submittalType: string;
  submitByDate: string | null;
  isCloseout: boolean;
  /** why submitBy is null when it is */
  reason: string | null;
}

/**
 * Turn a list of spec sections (each optionally carrying a required-on-site
 * date and a lead time) into register rows with a back-computed submit-by.
 * Sections without a site date get a null submit-by AND the reason, never a
 * fabricated date. Duplicate (section, title) pairs collapse to one row.
 */
export function generateSubmittalSchedule(
  seeds: readonly ScheduleSeed[],
  reviewAllowanceDays: number = DEFAULT_REVIEW_ALLOWANCE_DAYS,
): ScheduleRow[] {
  const seen = new Set<string>();
  const rows: ScheduleRow[] = [];
  for (const seed of seeds) {
    const key = `${seed.specSection.trim().toLowerCase()}|${seed.title.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const submittalType = seed.submittalType ?? "other";
    const submitByDate = computeSubmitBy(seed.requiredOnSite, seed.leadTimeDays, reviewAllowanceDays);
    rows.push({
      ...seed,
      submittalType,
      submitByDate,
      isCloseout: isCloseoutType(submittalType),
      reason: submitByDate ? null : "No required-on-site date — submit-by cannot be derived",
    });
  }
  return rows.sort((a, b) => {
    if (a.submitByDate && b.submitByDate) return a.submitByDate.localeCompare(b.submitByDate);
    if (a.submitByDate) return -1;
    if (b.submitByDate) return 1;
    return a.specSection.localeCompare(b.specSection);
  });
}

/* ------------------------------------------------------------------ */
/* #347 turnaround analytics                                           */
/* ------------------------------------------------------------------ */

export interface TurnaroundStep {
  reviewerId: string;
  activatedAt: string | null;
  respondedAt: string | null;
  responseCode: string | null;
}

export interface ReviewerTurnaround {
  reviewerId: string;
  responded: number;
  avgDays: number | null;
  medianDays: number | null;
  /** currently pending steps for this reviewer */
  inCourt: number;
  /** longest pending age in days */
  oldestInCourtDays: number | null;
  overdueInCourt: number;
}

/** Per-reviewer turnaround and in-court load; ages measured to `nowIso`. */
export function reviewerTurnaround(
  steps: readonly TurnaroundStep[],
  nowIso: string,
  inCourtAllowanceDays: number = DEFAULT_IN_COURT_ALLOWANCE_DAYS,
): ReviewerTurnaround[] {
  const byReviewer = new Map<string, { durations: number[]; pendingAges: number[] }>();
  for (const s of steps) {
    let rec = byReviewer.get(s.reviewerId);
    if (!rec) {
      rec = { durations: [], pendingAges: [] };
      byReviewer.set(s.reviewerId, rec);
    }
    if (s.responseCode && s.respondedAt && s.activatedAt) {
      rec.durations.push(Math.max(0, daysBetween(s.activatedAt, s.respondedAt)));
    } else if (!s.responseCode && s.activatedAt) {
      rec.pendingAges.push(Math.max(0, daysBetween(s.activatedAt, nowIso)));
    }
  }
  return [...byReviewer.entries()]
    .map(([reviewerId, rec]) => ({
      reviewerId,
      responded: rec.durations.length,
      avgDays: average(rec.durations),
      medianDays: median(rec.durations),
      inCourt: rec.pendingAges.length,
      oldestInCourtDays:
        rec.pendingAges.length > 0 ? Math.round(Math.max(...rec.pendingAges) * 10) / 10 : null,
      overdueInCourt: rec.pendingAges.filter((d) => d > inCourtAllowanceDays).length,
    }))
    .sort((a, b) => b.inCourt - a.inCourt || a.reviewerId.localeCompare(b.reviewerId));
}

/** Resubmission rate per spec section: revisions ÷ distinct numbers. */
export function resubmissionBySpecSection(
  rows: readonly { specSection: string | null; number: number; revision: number }[],
): Array<{ specSection: string; submittals: number; revisions: number; rate: number }> {
  const bySection = new Map<string, { numbers: Set<number>; revisions: number }>();
  for (const r of rows) {
    const key = r.specSection ?? "(unassigned)";
    let rec = bySection.get(key);
    if (!rec) {
      rec = { numbers: new Set(), revisions: 0 };
      bySection.set(key, rec);
    }
    rec.numbers.add(r.number);
    if (r.revision > 0) rec.revisions += 1;
  }
  return [...bySection.entries()]
    .map(([specSection, rec]) => ({
      specSection,
      submittals: rec.numbers.size,
      revisions: rec.revisions,
      rate: rec.numbers.size > 0 ? Math.round((rec.revisions / rec.numbers.size) * 100) / 100 : 0,
    }))
    .sort((a, b) => b.rate - a.rate || a.specSection.localeCompare(b.specSection));
}
