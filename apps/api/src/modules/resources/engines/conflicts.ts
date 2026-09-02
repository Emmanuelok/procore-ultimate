/**
 * ASSIGNMENT CONFLICT DETECTION — pure, no I/O (spec Vol I #688–690).
 *
 * Two bookings on the same crew, worker or machine at the same time is the
 * single most common resourcing failure, and it is almost never a data-entry
 * mistake: both bookings are real, both were made by someone who needed the
 * resource, and the argument is about which one gives way. So this engine
 * DETECTS rather than prevents. A refusal at the point of booking loses the
 * second requirement entirely; a detected conflict keeps both and names them.
 *
 * ALLOCATION IS PROPORTIONAL. Two 50% bookings are not a conflict — a
 * supervisor split across two areas is normal — so the test is on the SUM of
 * allocation percent over each elementary interval, not on the mere fact of
 * overlap.
 *
 * The sweep is a boundary sweep, not an O(n²) pair comparison: for each
 * subject, every from-date and every day after a to-date is a boundary, and
 * the load is constant between consecutive boundaries. Adjacent intervals
 * carrying the same set of bookings are merged so one double-booking reads as
 * one finding rather than as one finding per day.
 */
import { addDays, daysBetween, round2 } from "./calendar.js";

export interface AssignmentWindow {
  id: string;
  reference: string;
  subjectKind: string;
  /** crewId / workerId / equipmentId — the thing that can only be in one place */
  subjectId: string;
  subjectLabel: string;
  fromDate: string;
  toDate: string;
  status: string;
  allocationPercent: number;
  hoursPerDay: number | null;
  scheduleTaskId: string | null;
  taskName?: string | null;
}

export interface ConflictParticipant {
  assignmentId: string;
  reference: string;
  allocationPercent: number;
  scheduleTaskId: string | null;
  taskName: string | null;
}

export interface AssignmentConflict {
  subjectKind: string;
  subjectId: string;
  subjectLabel: string;
  fromDate: string;
  toDate: string;
  days: number;
  participants: ConflictParticipant[];
  totalAllocationPercent: number;
  overByPercent: number;
  severity: "critical" | "high" | "medium";
  explanation: string;
}

/** Statuses that still occupy a calendar. Cancelled and completed do not. */
const OCCUPYING = new Set(["planned", "confirmed", "in_progress"]);

/** Over 100% by more than this is treated as noise-free rounding, not a clash. */
const TOLERANCE_PERCENT = 0.5;

function severityFor(total: number): "critical" | "high" | "medium" {
  if (total >= 200) return "critical";
  if (total >= 150) return "high";
  return "medium";
}

/**
 * Every window where one subject is booked beyond 100%.
 *
 * `assignments` may span the whole project; only occupying statuses count.
 */
export function detectAssignmentConflicts(
  assignments: AssignmentWindow[],
): AssignmentConflict[] {
  const bySubject = new Map<string, AssignmentWindow[]>();
  for (const a of assignments) {
    if (!OCCUPYING.has(a.status)) continue;
    if (a.toDate < a.fromDate) continue;
    const key = `${a.subjectKind}|${a.subjectId}`;
    const list = bySubject.get(key) ?? [];
    list.push(a);
    bySubject.set(key, list);
  }

  const conflicts: AssignmentConflict[] = [];
  for (const [, list] of bySubject) {
    if (list.length < 2) continue;
    const boundaries = new Set<string>();
    for (const a of list) {
      boundaries.add(a.fromDate);
      boundaries.add(addDays(a.toDate, 1));
    }
    const points = [...boundaries].sort();

    interface Segment {
      from: string;
      to: string;
      ids: string[];
      total: number;
    }
    const segments: Segment[] = [];
    for (let i = 0; i < points.length - 1; i += 1) {
      const from = points[i]!;
      const to = addDays(points[i + 1]!, -1);
      if (to < from) continue;
      const active = list.filter((a) => a.fromDate <= from && a.toDate >= to);
      if (active.length < 2) continue;
      const total = round2(active.reduce((s, a) => s + a.allocationPercent, 0));
      if (total <= 100 + TOLERANCE_PERCENT) continue;
      const ids = active.map((a) => a.id).sort();
      const previous = segments[segments.length - 1];
      if (
        previous &&
        previous.ids.join("|") === ids.join("|") &&
        addDays(previous.to, 1) === from
      ) {
        previous.to = to;
      } else {
        segments.push({ from, to, ids, total });
      }
    }

    for (const segment of segments) {
      const members = segment.ids
        .map((id) => list.find((a) => a.id === id))
        .filter((a): a is AssignmentWindow => Boolean(a));
      const first = members[0];
      if (!first) continue;
      const days = daysBetween(segment.from, segment.to) + 1;
      const over = round2(segment.total - 100);
      conflicts.push({
        subjectKind: first.subjectKind,
        subjectId: first.subjectId,
        subjectLabel: first.subjectLabel,
        fromDate: segment.from,
        toDate: segment.to,
        days,
        participants: members.map((m) => ({
          assignmentId: m.id,
          reference: m.reference,
          allocationPercent: m.allocationPercent,
          scheduleTaskId: m.scheduleTaskId,
          taskName: m.taskName ?? null,
        })),
        totalAllocationPercent: segment.total,
        overByPercent: over,
        severity: severityFor(segment.total),
        explanation:
          `${first.subjectLabel} is booked to ${members.length} assignments between ` +
          `${segment.from} and ${segment.to} (${days} day(s)) totalling ` +
          `${segment.total}% — ${over}% more than exists. ` +
          members
            .map(
              (m) =>
                `${m.reference} at ${m.allocationPercent}%${m.taskName ? ` on "${m.taskName}"` : ""}`,
            )
            .join("; ") +
          ". Both bookings were made because somebody needed the resource: decide which gives " +
          "way rather than deleting one quietly.",
      });
    }
  }

  return conflicts.sort(
    (a, b) => b.overByPercent - a.overByPercent || a.fromDate.localeCompare(b.fromDate),
  );
}

/* ------------------------------------------------------------------ */
/* Utilisation                                                         */
/* ------------------------------------------------------------------ */

export interface UtilisationRow {
  subjectKind: string;
  subjectId: string;
  subjectLabel: string;
  /** days inside the window with at least one occupying assignment */
  bookedDays: number;
  /** working days in the window */
  windowDays: number;
  utilisationPercent: number | null;
  assignments: number;
  /** null when no assignment records hours per day */
  plannedHours: number | null;
  reasons: string[];
}

/**
 * How much of the window each resource is actually booked for. Booked DAYS
 * rather than summed allocation, because a resource booked at 50% for the
 * whole window is fully committed from a planning point of view even though
 * its allocation sums to half.
 */
export function computeUtilisation(
  assignments: AssignmentWindow[],
  window: { from: string; to: string },
  isWorkday: (iso: string) => boolean,
): UtilisationRow[] {
  const span = daysBetween(window.from, window.to);
  if (span < 0) return [];
  const days: string[] = [];
  for (let i = 0; i <= span; i += 1) {
    const iso = addDays(window.from, i);
    if (isWorkday(iso)) days.push(iso);
  }
  const windowDays = days.length;

  const bySubject = new Map<string, AssignmentWindow[]>();
  for (const a of assignments) {
    if (!OCCUPYING.has(a.status)) continue;
    const key = `${a.subjectKind}|${a.subjectId}`;
    const list = bySubject.get(key) ?? [];
    list.push(a);
    bySubject.set(key, list);
  }

  const rows: UtilisationRow[] = [];
  for (const [, list] of bySubject) {
    const first = list[0]!;
    let bookedDays = 0;
    let plannedHours = 0;
    let anyHours = false;
    for (const day of days) {
      if (list.some((a) => a.fromDate <= day && a.toDate >= day)) bookedDays += 1;
    }
    for (const a of list) {
      if (a.hoursPerDay === null) continue;
      anyHours = true;
      let workingDays = 0;
      for (const day of days) {
        if (a.fromDate <= day && a.toDate >= day) workingDays += 1;
      }
      plannedHours = round2(plannedHours + a.hoursPerDay * workingDays * (a.allocationPercent / 100));
    }
    const reasons: string[] = [];
    if (windowDays === 0) {
      reasons.push("The window contains no working days under this project's calendar.");
    }
    if (!anyHours) {
      reasons.push(
        "No assignment on this resource records hours per day, so booked time is reported in days " +
          "and planned hours are not derivable.",
      );
    }
    rows.push({
      subjectKind: first.subjectKind,
      subjectId: first.subjectId,
      subjectLabel: first.subjectLabel,
      bookedDays,
      windowDays,
      utilisationPercent: windowDays > 0 ? round2((bookedDays / windowDays) * 100) : null,
      assignments: list.length,
      plannedHours: anyHours ? plannedHours : null,
      reasons,
    });
  }
  return rows.sort((a, b) => (b.utilisationPercent ?? -1) - (a.utilisationPercent ?? -1));
}
