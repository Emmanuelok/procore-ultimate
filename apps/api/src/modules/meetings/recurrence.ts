/**
 * Pure recurrence and quorum arithmetic for the meetings module
 * (spec Vol I §2.9, module M20).
 *
 * No database, no Fastify: a recurring meeting is a date calculation, and a
 * date calculation that is wrong by an hour twice a year is worse than one
 * that is obviously wrong all the time. Everything here is unit-tested.
 *
 * The one non-obvious rule: an unsupported RRULE is REFUSED rather than
 * approximated. Silently downgrading "FREQ=WEEKLY;BYDAY=MO,WE,FR" to "every
 * Monday" would put two-thirds of a project's progress meetings on dates
 * nobody agreed to, and nothing downstream would ever notice.
 */

import type { MeetingRecurrence } from "@constructos/shared";

const MS_PER_DAY = 86_400_000;

/* ------------------------------------------------------------------ */
/* Wall-clock → instant                                                */
/* ------------------------------------------------------------------ */

function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const get = (type: string): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number(found.value) : 0;
  };
  const asIfUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asIfUtc - utcMs;
}

/**
 * Turn a local wall-clock time ("2026-03-29", "09:00", "Europe/London") into
 * the instant it actually happens at. Two passes settle the DST edge cases:
 * the first estimates the offset from the naive instant, the second corrects
 * it using the offset in force at the estimated instant.
 *
 * An unknown zone falls back to UTC rather than throwing — a mistyped
 * timezone must not stop a meeting being scheduled — and the caller can tell
 * because `resolvedTimezone` comes back null.
 */
export function zonedWallTimeToUtc(
  isoDate: string,
  timeHHMM: string,
  timeZone: string | null | undefined,
): { instant: string; resolvedTimezone: string | null } {
  const naive = Date.parse(`${isoDate}T${timeHHMM}:00Z`);
  if (!Number.isFinite(naive)) throw new Error(`Invalid date/time: ${isoDate} ${timeHHMM}`);
  if (!timeZone) return { instant: new Date(naive).toISOString(), resolvedTimezone: null };
  try {
    const firstGuess = naive - zoneOffsetMs(naive, timeZone);
    const settled = naive - zoneOffsetMs(firstGuess, timeZone);
    return { instant: new Date(settled).toISOString(), resolvedTimezone: timeZone };
  } catch {
    return { instant: new Date(naive).toISOString(), resolvedTimezone: null };
  }
}

/* ------------------------------------------------------------------ */
/* RRULE (the supported subset)                                        */
/* ------------------------------------------------------------------ */

export interface ParsedRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY";
  interval: number;
  /** 0 = Sunday … 6 = Saturday */
  byDay: number[];
}

const RRULE_DAYS: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

export class UnsupportedRecurrenceRule extends Error {}

/**
 * Parse the RRULE subset this platform actually honours:
 * `FREQ=DAILY|WEEKLY|MONTHLY`, optional `INTERVAL=n`, optional `BYDAY=MO,WE`.
 * Anything else throws — see the file header for why.
 */
export function parseRecurrenceRule(rule: string): ParsedRule {
  const cleaned = rule.trim().replace(/^RRULE:/i, "");
  if (cleaned === "") throw new UnsupportedRecurrenceRule("Recurrence rule is empty");
  const parts = new Map<string, string>();
  for (const chunk of cleaned.split(";")) {
    if (chunk.trim() === "") continue;
    const [rawKey, rawValue] = chunk.split("=");
    if (!rawKey || rawValue === undefined) {
      throw new UnsupportedRecurrenceRule(`Malformed rule part "${chunk}"`);
    }
    parts.set(rawKey.trim().toUpperCase(), rawValue.trim().toUpperCase());
  }
  const freq = parts.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY") {
    throw new UnsupportedRecurrenceRule(
      `FREQ=${freq ?? "(missing)"} is not supported — use DAILY, WEEKLY or MONTHLY`,
    );
  }
  const intervalRaw = parts.get("INTERVAL");
  const interval = intervalRaw === undefined ? 1 : Number(intervalRaw);
  if (!Number.isInteger(interval) || interval < 1 || interval > 52) {
    throw new UnsupportedRecurrenceRule(`INTERVAL=${intervalRaw} is out of range (1-52)`);
  }
  const byDayRaw = parts.get("BYDAY");
  const byDay: number[] = [];
  if (byDayRaw) {
    for (const token of byDayRaw.split(",")) {
      const day = RRULE_DAYS[token.trim()];
      if (day === undefined) {
        throw new UnsupportedRecurrenceRule(
          `BYDAY=${token} is not supported — ordinals such as "2MO" are not honoured`,
        );
      }
      byDay.push(day);
    }
    byDay.sort((a, b) => a - b);
  }
  for (const key of parts.keys()) {
    if (!["FREQ", "INTERVAL", "BYDAY", "WKST"].includes(key)) {
      throw new UnsupportedRecurrenceRule(
        `${key} is not supported by this platform's recurrence engine`,
      );
    }
  }
  return { freq, interval, byDay };
}

/** The simple recurrences expressed as the same rule shape. */
export function ruleForRecurrence(
  recurrence: MeetingRecurrence,
  recurrenceRule: string | null | undefined,
  dayOfWeek: number | null | undefined,
): ParsedRule {
  const byDay = dayOfWeek == null ? [] : [dayOfWeek];
  switch (recurrence) {
    case "daily":
      return { freq: "DAILY", interval: 1, byDay: [] };
    case "weekly":
      return { freq: "WEEKLY", interval: 1, byDay };
    case "fortnightly":
      return { freq: "WEEKLY", interval: 2, byDay };
    case "monthly":
      return { freq: "MONTHLY", interval: 1, byDay: [] };
    case "quarterly":
      return { freq: "MONTHLY", interval: 3, byDay: [] };
    case "custom": {
      if (!recurrenceRule) {
        throw new UnsupportedRecurrenceRule(
          "A custom recurrence needs a recurrenceRule (RFC 5545 RRULE)",
        );
      }
      return parseRecurrenceRule(recurrenceRule);
    }
    case "none":
      throw new UnsupportedRecurrenceRule(
        "This series does not recur — create a one-off meeting instead of generating occurrences",
      );
    default:
      throw new UnsupportedRecurrenceRule(`Unknown recurrence "${String(recurrence)}"`);
  }
}

/* ------------------------------------------------------------------ */
/* Occurrence dates                                                    */
/* ------------------------------------------------------------------ */

function toISODate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function dayOfWeekOf(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay();
}

function addMonthsISO(isoDate: string, months: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const targetDay = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const daysInMonth = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(targetDay, daysInMonth));
  return d.toISOString().slice(0, 10);
}

export interface OccurrencePlan {
  /** ISO calendar date of the occurrence, in the series' own timezone */
  date: string;
  scheduledStart: string;
  scheduledEnd: string | null;
}

export interface PlanOptions {
  rule: ParsedRule;
  /** first date to consider, inclusive (ISO date) */
  from: string;
  count: number;
  startTime?: string | null;
  durationMinutes?: number | null;
  timezone?: string | null;
}

/**
 * The next `count` occurrence dates on or after `from`.
 *
 * WEEKLY with BYDAY walks day by day within each interval window so
 * "MO,WE,FR" produces three meetings a week rather than one; MONTHLY steps
 * whole months and clamps to the last day when the anchor day does not exist
 * (a series anchored on the 31st meets on 28 February, not 3 March).
 */
export function planOccurrences(opts: PlanOptions): OccurrencePlan[] {
  const { rule } = opts;
  const startTime = opts.startTime ?? "09:00";
  const out: OccurrencePlan[] = [];
  const emit = (date: string) => {
    const { instant } = zonedWallTimeToUtc(date, startTime, opts.timezone);
    const end =
      opts.durationMinutes != null && opts.durationMinutes > 0
        ? new Date(Date.parse(instant) + opts.durationMinutes * 60_000).toISOString()
        : null;
    out.push({ date, scheduledStart: instant, scheduledEnd: end });
  };

  const fromMs = Date.parse(`${opts.from}T00:00:00Z`);
  if (!Number.isFinite(fromMs)) throw new Error(`Invalid from date: ${opts.from}`);

  if (rule.freq === "MONTHLY") {
    // Every occurrence is measured from the ANCHOR date, never from the
    // previous occurrence: stepping from a clamped date (28 February) would
    // drag a series anchored on the 31st onto the 28th for good.
    for (let i = 0; out.length < opts.count; i++) {
      emit(addMonthsISO(opts.from, i * rule.interval));
    }
    return out;
  }

  if (rule.freq === "DAILY") {
    for (let i = 0; out.length < opts.count; i++) {
      emit(toISODate(fromMs + i * rule.interval * MS_PER_DAY));
    }
    return out;
  }

  // WEEKLY (interval 1 = weekly, 2 = fortnightly), optionally on named days.
  const days = rule.byDay.length > 0 ? rule.byDay : [dayOfWeekOf(opts.from)];
  // Anchor on the Sunday of the week `from` falls in, so interval windows are
  // whole weeks and a fortnightly series never drifts by a day.
  const anchor = fromMs - dayOfWeekOf(opts.from) * MS_PER_DAY;
  for (let week = 0; out.length < opts.count && week < opts.count * rule.interval + 8; week++) {
    const weekStart = anchor + week * rule.interval * 7 * MS_PER_DAY;
    for (const day of days) {
      const ms = weekStart + day * MS_PER_DAY;
      if (ms < fromMs) continue;
      if (out.length >= opts.count) break;
      emit(toISODate(ms));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Quorum                                                              */
/* ------------------------------------------------------------------ */

/**
 * Attendance states that count towards quorum. A delegate who actually turned
 * up counts (someone with authority was in the room); apologies do not (being
 * told about a meeting is not attending it), which is exactly the distinction
 * that matters when a decision taken in someone's absence is challenged.
 */
export const QUORUM_COUNTING_STATES = [
  "present",
  "late",
  "left_early",
  "remote",
  "delegate_attended",
] as const;

/** Roles that never count towards quorum however they are marked. */
export const NON_COUNTING_ROLES = ["distribution_only", "observer"] as const;

export interface QuorumInput {
  role: string;
  attendance: string;
}

export interface QuorumResult {
  /** null when the meeting states no quorum requirement — never a fabricated pass */
  met: boolean | null;
  required: number | null;
  counted: number;
  present: number;
  apologies: number;
  absent: number;
  reasons: string[];
}

export function checkQuorum(
  attendees: QuorumInput[],
  quorumRequired: number | null | undefined,
): QuorumResult {
  const counting = attendees.filter(
    (a) => !NON_COUNTING_ROLES.includes(a.role as (typeof NON_COUNTING_ROLES)[number]),
  );
  const counted = counting.filter((a) =>
    QUORUM_COUNTING_STATES.includes(a.attendance as (typeof QUORUM_COUNTING_STATES)[number]),
  ).length;
  const present = counting.filter((a) => a.attendance === "present").length;
  const apologies = counting.filter((a) => a.attendance === "apologies").length;
  const absent = counting.filter((a) => a.attendance === "absent").length;
  if (quorumRequired == null || quorumRequired <= 0) {
    return {
      met: null,
      required: quorumRequired ?? null,
      counted,
      present,
      apologies,
      absent,
      reasons: [
        "No quorum is required for this meeting, so whether one was met is not a fact this " +
          "platform holds. Set quorumRequired on the series or the occurrence to have it checked.",
      ],
    };
  }
  return {
    met: counted >= quorumRequired,
    required: quorumRequired,
    counted,
    present,
    apologies,
    absent,
    reasons: [],
  };
}
