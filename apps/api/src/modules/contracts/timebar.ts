/**
 * The time-bar engine (spec Vol II Domain C #225-231).
 *
 * WHAT WENT WRONG BEFORE
 * The first cut read every deadline straight out of the code clause library
 * and ignored `contract.particularConditions`. On a contract whose Particular
 * Conditions amend FIDIC 20.2 from 28 to 56 days — which is the norm, not the
 * exception — the platform stated a legally wrong deadline with confidence 1.
 * It also counted calendar days everywhere, had no pre-expiry warning, and
 * modelled each notice as an isolated event when the forms actually impose
 * chains (20.2 → 20.2.4 → 3.7; 61.3 → 62.3 → PM reply).
 *
 * WHAT THIS FILE IS
 * Pure, total functions: resolve the EFFECTIVE clause (library ⊕ Particular
 * Conditions, PC wins), count days on the contract's calendar (calendar days,
 * or working days skipping weekends and the contract's holidays), produce the
 * deadline with the source it came from, and derive the follow-on deadlines a
 * served notice spawns. No database, no clock — the caller passes `today`.
 */
import type {
  CalendarBasis,
  ClauseCategory,
  ContractForm,
  DeadlineSource,
} from "@constructos/shared";
import type { ParticularCondition } from "@constructos/db";
import { clausesForForm, findClause, type ClauseDef } from "./clause-library.js";

export interface EffectiveClause {
  form: ContractForm;
  clauseRef: string;
  title: string;
  summary: string;
  category: ClauseCategory;
  /** the bar actually in force: library value unless a PC replaces it */
  timeBarDays: number | null;
  noticeRequired: boolean;
  noticeBy: string | null;
  /** where timeBarDays came from */
  deadlineSource: DeadlineSource;
  amended: boolean;
  amendment: string | null;
  /** the library's own bar, kept visible next to the amended one */
  libraryTimeBarDays: number | null;
  calendarBasis: CalendarBasis;
  warnDaysBefore: number;
  deleted: boolean;
  standingObligation: ClauseDef["standingObligation"];
  deadlineChain: NonNullable<ClauseDef["deadlineChain"]>;
}

/** Warn a quarter of the way out, never more than a fortnight, never zero. */
export function defaultWarnDays(timeBarDays: number | null | undefined): number {
  if (!timeBarDays || timeBarDays <= 0) return 0;
  return Math.max(1, Math.min(14, Math.ceil(timeBarDays / 4)));
}

function pcFor(
  pcs: ParticularCondition[] | null | undefined,
  clauseRef: string,
): ParticularCondition | undefined {
  return (pcs ?? []).find((p) => p && p.clauseRef === clauseRef);
}

/**
 * Merge one library clause with its Particular Condition. The PC is
 * authoritative for `timeBarDays`, `noticeRequired`, the calendar basis and
 * the warning lead time; `deleted: true` removes the clause from the engine
 * entirely (its bar stops being computed).
 */
export function mergeClause(
  clause: ClauseDef,
  pc: ParticularCondition | undefined,
  contractDefaults: { calendarBasis: CalendarBasis },
): EffectiveClause {
  const amended = pc !== undefined;
  const pcSetsBar = amended && pc !== undefined && "timeBarDays" in pc && pc.timeBarDays !== undefined;
  const timeBarDays = pcSetsBar ? (pc!.timeBarDays ?? null) : (clause.timeBarDays ?? null);
  return {
    form: clause.form,
    clauseRef: clause.clauseRef,
    title: clause.title,
    summary: clause.summary,
    category: clause.category,
    timeBarDays,
    noticeRequired: pc?.noticeRequired ?? clause.noticeRequired,
    noticeBy: clause.noticeBy ?? null,
    deadlineSource: pcSetsBar ? "particular_condition" : "library",
    amended,
    amendment: pc?.amendment ?? null,
    libraryTimeBarDays: clause.timeBarDays ?? null,
    calendarBasis: pc?.calendarBasis ?? contractDefaults.calendarBasis,
    warnDaysBefore: pc?.warnDaysBefore ?? clause.warnDaysBefore ?? defaultWarnDays(timeBarDays),
    deleted: pc?.deleted === true,
    standingObligation: clause.standingObligation,
    deadlineChain: clause.deadlineChain ?? [],
  };
}

/** The whole effective clause set for a contract, in library order. */
export function effectiveClauses(
  form: ContractForm,
  pcs: ParticularCondition[] | null | undefined,
  contractDefaults: { calendarBasis: CalendarBasis },
): EffectiveClause[] {
  const library = clausesForForm(form).map((c) =>
    mergeClause(c, pcFor(pcs, c.clauseRef), contractDefaults),
  );
  // Particular Conditions may also ADD a clause the library does not carry —
  // bespoke amendments and Gulf/Asian derivatives do this constantly. Those
  // appear as clauses in their own right rather than being silently dropped.
  const known = new Set(library.map((c) => c.clauseRef));
  const added: EffectiveClause[] = [];
  for (const pc of pcs ?? []) {
    if (!pc || known.has(pc.clauseRef)) continue;
    added.push({
      form,
      clauseRef: pc.clauseRef,
      title: `Particular Condition ${pc.clauseRef}`,
      summary: pc.amendment,
      category: "general",
      timeBarDays: pc.timeBarDays ?? null,
      noticeRequired: pc.noticeRequired ?? Boolean(pc.timeBarDays),
      noticeBy: null,
      deadlineSource: "particular_condition",
      amended: true,
      amendment: pc.amendment,
      libraryTimeBarDays: null,
      calendarBasis: pc.calendarBasis ?? contractDefaults.calendarBasis,
      warnDaysBefore: pc.warnDaysBefore ?? defaultWarnDays(pc.timeBarDays ?? null),
      deleted: pc.deleted === true,
      standingObligation: undefined,
      deadlineChain: [],
    });
  }
  return [...library, ...added];
}

/** Resolve one clause, including PC-only clauses on a bespoke contract. */
export function resolveClause(
  form: ContractForm,
  clauseRef: string,
  pcs: ParticularCondition[] | null | undefined,
  contractDefaults: { calendarBasis: CalendarBasis },
): EffectiveClause | null {
  const lib = findClause(form, clauseRef);
  const pc = pcFor(pcs, clauseRef);
  if (lib) return mergeClause(lib, pc, contractDefaults);
  if (!pc) return null;
  return {
    form,
    clauseRef,
    title: `Particular Condition ${clauseRef}`,
    summary: pc.amendment,
    category: "general",
    timeBarDays: pc.timeBarDays ?? null,
    noticeRequired: pc.noticeRequired ?? Boolean(pc.timeBarDays),
    noticeBy: null,
    deadlineSource: "particular_condition",
    amended: true,
    amendment: pc.amendment,
    libraryTimeBarDays: null,
    calendarBasis: pc.calendarBasis ?? contractDefaults.calendarBasis,
    warnDaysBefore: pc.warnDaysBefore ?? defaultWarnDays(pc.timeBarDays ?? null),
    deleted: pc.deleted === true,
    standingObligation: undefined,
    deadlineChain: [],
  };
}

/* ------------------------------------------------------------------ */
/* Calendar arithmetic                                                 */
/* ------------------------------------------------------------------ */

function isWeekend(iso: string): boolean {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

function plusOneDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Add `days` to an ISO date on the contract's calendar.
 *
 * `calendar` counts every day. `working` counts only Monday–Friday days that
 * are not in the contract's holiday list, and — where a calendar count would
 * land on a non-working day — the deadline rolls forward to the next working
 * day, which is how every jurisdiction that counts working days treats it.
 */
export function addDaysOnCalendar(
  isoDate: string,
  days: number,
  basis: CalendarBasis,
  holidays: readonly string[] = [],
): string {
  if (basis === "calendar") {
    const d = new Date(`${isoDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
  const holidaySet = new Set(holidays);
  const isWorking = (iso: string) => !isWeekend(iso) && !holidaySet.has(iso);
  let cursor = isoDate;
  let remaining = Math.max(0, Math.round(days));
  let guard = 0;
  while (remaining > 0 && guard < 20_000) {
    cursor = plusOneDay(cursor);
    if (isWorking(cursor)) remaining -= 1;
    guard += 1;
  }
  while (!isWorking(cursor) && guard < 20_000) {
    cursor = plusOneDay(cursor);
    guard += 1;
  }
  return cursor;
}

/** Whole days from `from` to `to` (negative = already past). */
export function daysBetweenIso(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
}

/* ------------------------------------------------------------------ */
/* Deadline resolution                                                 */
/* ------------------------------------------------------------------ */

export interface DeadlineRequest {
  form: ContractForm;
  clauseRef: string | null;
  particularConditions: ParticularCondition[] | null | undefined;
  calendarBasis: CalendarBasis;
  holidays: readonly string[];
  /** the date the bar runs from: awareness where recorded, else the event date */
  startDate: string;
  /** caller-supplied bar for bespoke forms and unlisted clauses */
  manualTimeBarDays?: number | null;
  manualDeadline?: string | null;
}

export interface DeadlineResult {
  noticeDeadline: string | null;
  effectiveTimeBarDays: number | null;
  deadlineSource: DeadlineSource | null;
  calendarBasis: CalendarBasis;
  warnDaysBefore: number | null;
  clause: EffectiveClause | null;
  /** one sentence a user can read to understand where the date came from */
  explanation: string;
}

/**
 * Compute the notice deadline for an event.
 *
 * Precedence: an explicit deadline supplied by the caller, then an explicit
 * bar in days, then the effective clause (Particular Condition over library).
 * A clause a PC has deleted, or one with no bar, yields no deadline — and says
 * so, rather than silently returning null.
 */
export function computeDeadline(req: DeadlineRequest): DeadlineResult {
  const clause = req.clauseRef
    ? resolveClause(req.form, req.clauseRef, req.particularConditions, {
        calendarBasis: req.calendarBasis,
      })
    : null;

  if (req.manualDeadline) {
    return {
      noticeDeadline: req.manualDeadline,
      effectiveTimeBarDays: null,
      deadlineSource: "manual",
      calendarBasis: req.calendarBasis,
      warnDaysBefore: defaultWarnDays(
        Math.max(1, daysBetweenIso(req.startDate, req.manualDeadline)),
      ),
      clause,
      explanation: `Deadline set manually to ${req.manualDeadline}.`,
    };
  }

  if (req.manualTimeBarDays != null && req.manualTimeBarDays > 0) {
    const basis = clause?.calendarBasis ?? req.calendarBasis;
    const deadline = addDaysOnCalendar(req.startDate, req.manualTimeBarDays, basis, req.holidays);
    return {
      noticeDeadline: deadline,
      effectiveTimeBarDays: req.manualTimeBarDays,
      deadlineSource: "manual",
      calendarBasis: basis,
      warnDaysBefore: defaultWarnDays(req.manualTimeBarDays),
      clause,
      explanation: `${req.manualTimeBarDays} ${basis === "working" ? "working" : "calendar"} days from ${req.startDate}, entered for this event.`,
    };
  }

  if (!clause) {
    return {
      noticeDeadline: null,
      effectiveTimeBarDays: null,
      deadlineSource: null,
      calendarBasis: req.calendarBasis,
      warnDaysBefore: null,
      clause: null,
      explanation: req.clauseRef
        ? `Clause ${req.clauseRef} is not in the ${req.form} library and no Particular Condition defines it, so no deadline was computed. Enter timeBarDays or noticeDeadline to track one.`
        : "No clause was cited, so no notice deadline applies.",
    };
  }
  if (clause.deleted) {
    return {
      noticeDeadline: null,
      effectiveTimeBarDays: null,
      deadlineSource: "particular_condition",
      calendarBasis: clause.calendarBasis,
      warnDaysBefore: null,
      clause,
      explanation: `Clause ${clause.clauseRef} is deleted by the Particular Conditions, so it imposes no notice deadline.`,
    };
  }
  if (clause.timeBarDays == null) {
    return {
      noticeDeadline: null,
      effectiveTimeBarDays: null,
      deadlineSource: clause.deadlineSource,
      calendarBasis: clause.calendarBasis,
      warnDaysBefore: null,
      clause,
      explanation: `${clause.clauseRef} (${clause.title}) imposes no day-counted time bar${clause.amended ? ", including as amended by the Particular Conditions" : ""}.`,
    };
  }

  const deadline = addDaysOnCalendar(
    req.startDate,
    clause.timeBarDays,
    clause.calendarBasis,
    req.holidays,
  );
  const unit = clause.calendarBasis === "working" ? "working" : "calendar";
  const explanation =
    clause.deadlineSource === "particular_condition"
      ? `${clause.timeBarDays} ${unit} days from ${req.startDate} under the Particular Condition amending ${clause.clauseRef} (the standard form allows ${clause.libraryTimeBarDays ?? "no stated bar"}).`
      : `${clause.timeBarDays} ${unit} days from ${req.startDate} under ${clause.clauseRef} (${clause.title}).`;

  return {
    noticeDeadline: deadline,
    effectiveTimeBarDays: clause.timeBarDays,
    deadlineSource: clause.deadlineSource,
    calendarBasis: clause.calendarBasis,
    warnDaysBefore: clause.warnDaysBefore,
    clause,
    explanation,
  };
}

/* ------------------------------------------------------------------ */
/* Chained deadlines (#227)                                            */
/* ------------------------------------------------------------------ */

export interface ChainedDeadline {
  clauseRef: string;
  label: string;
  days: number;
  from: "awareness" | "service";
  deadline: string;
  calendarBasis: CalendarBasis;
  warnDaysBefore: number;
  deadlineSource: DeadlineSource;
  explanation: string;
}

/**
 * The follow-on deadlines that serving this notice creates. Each is resolved
 * through the same PC overlay, so an amended 20.2.4 produces an amended chain
 * link — the chain is not a hard-coded 84 days once a contract says otherwise.
 */
export function chainedDeadlines(
  clause: EffectiveClause | null,
  args: {
    form: ContractForm;
    particularConditions: ParticularCondition[] | null | undefined;
    calendarBasis: CalendarBasis;
    holidays: readonly string[];
    awarenessDate: string;
    servedDate: string;
  },
): ChainedDeadline[] {
  if (!clause || clause.deleted) return [];
  const out: ChainedDeadline[] = [];
  for (const link of clause.deadlineChain) {
    const nextClause = resolveClause(args.form, link.clauseRef, args.particularConditions, {
      calendarBasis: args.calendarBasis,
    });
    if (nextClause?.deleted) continue;
    const days = nextClause?.timeBarDays ?? link.days;
    const basis = nextClause?.calendarBasis ?? args.calendarBasis;
    const start = link.from === "service" ? args.servedDate : args.awarenessDate;
    const deadline = addDaysOnCalendar(start, days, basis, args.holidays);
    const source: DeadlineSource =
      nextClause?.deadlineSource === "particular_condition" ? "particular_condition" : "chain";
    out.push({
      clauseRef: link.clauseRef,
      label: link.label,
      days,
      from: link.from,
      deadline,
      calendarBasis: basis,
      warnDaysBefore: nextClause?.warnDaysBefore ?? defaultWarnDays(days),
      deadlineSource: source,
      explanation:
        `${link.label}: ${days} ${basis === "working" ? "working" : "calendar"} days from ` +
        `${link.from === "service" ? `service of the preceding notice on ${args.servedDate}` : `awareness on ${args.awarenessDate}`}` +
        (source === "particular_condition" ? ", as amended by the Particular Conditions" : "") +
        ".",
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Sweep decisions                                                     */
/* ------------------------------------------------------------------ */

export type SweepVerdict = "none" | "warn" | "breach";

export interface SweepCandidate {
  noticeDeadline: string | null;
  warnDaysBefore: number | null;
  warnedAt: string | null;
  status: string;
}

/**
 * What the sweep should do with one open event today. Kept pure so both the
 * scheduled job and the tests reason about the same decision table.
 */
export function sweepVerdict(candidate: SweepCandidate, today: string): SweepVerdict {
  if (candidate.status !== "open" || !candidate.noticeDeadline) return "none";
  if (today > candidate.noticeDeadline) return "breach";
  if (candidate.warnedAt) return "none";
  const warn = candidate.warnDaysBefore ?? 0;
  if (warn <= 0) return "none";
  const daysRemaining = daysBetweenIso(today, candidate.noticeDeadline);
  return daysRemaining <= warn ? "warn" : "none";
}
