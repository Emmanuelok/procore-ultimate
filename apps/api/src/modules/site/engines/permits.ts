/**
 * Permit-to-work state, and the two clocks that run underneath it
 * (spec Vol II Z #1070–1073).
 *
 * A permit to work is a state machine with rules that exist because people
 * have died when they were not enforced:
 *
 *   • The person who approves a permit may not be the person who requested it.
 *   • A permit may not go ACTIVE until its precautions are ticked, and an
 *     excavation permit may not go active without a utility survey behind it.
 *   • A permit may not be closed while anybody is still recorded inside it.
 *   • Hot work is not finished when the work stops; it is finished when the
 *     fire watch has run its course.
 *
 * The two clocks: a confined-space ENTRY has an expected exit time, and a
 * lone-worker SESSION has a next-due check-in. Both are evaluated here so the
 * sweep and the UI reach the same verdict from the same code.
 */

export type PermitStatus =
  | "draft"
  | "requested"
  | "approved"
  | "active"
  | "suspended"
  | "closed"
  | "expired"
  | "cancelled"
  | "rejected";

export interface Precaution {
  item: string;
  required: boolean;
  done: boolean;
  note?: string;
}

export interface PermitState {
  status: PermitStatus;
  permitType: string;
  requestedBy: string;
  approvedBy: string | null;
  validFrom: string | null;
  validTo: string | null;
  precautions: Precaution[];
  utilityScanId: string | null;
  fireWatchMinutes: number | null;
  fireWatchCompletedAt: string | null;
  closedAt: string | null;
  openEntries: number;
}

export interface TransitionRefusal {
  allowed: false;
  reason: string;
}
export interface TransitionAllowed {
  allowed: true;
  warnings: string[];
}
export type TransitionVerdict = TransitionRefusal | TransitionAllowed;

const allow = (warnings: string[] = []): TransitionAllowed => ({ allowed: true, warnings });
const refuse = (reason: string): TransitionRefusal => ({ allowed: false, reason });

/** Which statuses each transition may be applied from. */
const FROM: Record<string, PermitStatus[]> = {
  request: ["draft"],
  approve: ["requested"],
  reject: ["requested"],
  activate: ["approved", "suspended"],
  suspend: ["active"],
  close: ["active", "approved", "suspended"],
  cancel: ["draft", "requested", "approved", "suspended"],
  expire: ["approved", "active", "suspended"],
};

/** Permit types whose activation requires a utility survey on the record. */
export const SCAN_REQUIRED_TYPES = new Set(["excavation", "live_services"]);

export function canTransition(
  permit: PermitState,
  action: keyof typeof FROM,
  actor: { userId: string },
  now: string,
): TransitionVerdict {
  const from = FROM[action];
  if (!from) return refuse(`Unknown permit transition "${action}".`);
  if (!from.includes(permit.status)) {
    return refuse(`A permit that is ${permit.status} cannot be ${pastTense(action)}. Allowed from: ${from.join(", ")}.`);
  }

  const warnings: string[] = [];

  if (action === "approve") {
    if (permit.requestedBy === actor.userId) {
      return refuse(
        "The permit was requested by you. A permit to work must be approved by someone other than the person who requested it — that separation is the control, not a formality.",
      );
    }
    const outstanding = permit.precautions.filter((p) => p.required && !p.done);
    if (outstanding.length > 0) {
      warnings.push(
        `${outstanding.length} required precaution(s) are not yet ticked: ${outstanding.map((p) => p.item).join(", ")}. They must be complete before the permit goes active.`,
      );
    }
  }

  if (action === "activate") {
    const outstanding = permit.precautions.filter((p) => p.required && !p.done);
    if (outstanding.length > 0) {
      return refuse(
        `${outstanding.length} required precaution(s) are outstanding: ${outstanding.map((p) => p.item).join(", ")}. A permit does not go active on a promise.`,
      );
    }
    if (SCAN_REQUIRED_TYPES.has(permit.permitType) && !permit.utilityScanId) {
      return refuse(
        `A ${permit.permitType.replace(/_/g, " ")} permit may not go active without a utility survey recorded against it. Link the scan (or record the trial holes) first.`,
      );
    }
    if (!permit.validFrom || !permit.validTo) {
      return refuse("The permit has no validity window. Set valid-from and valid-to before activating it.");
    }
    if (Date.parse(permit.validTo) <= Date.parse(now)) {
      return refuse(`The permit's validity ended at ${permit.validTo}; it cannot be activated now.`);
    }
    if (Date.parse(permit.validFrom) > Date.parse(now)) {
      warnings.push(`The permit's validity does not begin until ${permit.validFrom}.`);
    }
    if (!permit.approvedBy) {
      return refuse("The permit has not been approved. An unapproved permit cannot be activated.");
    }
  }

  if (action === "close") {
    if (permit.openEntries > 0) {
      return refuse(
        `${permit.openEntries} person(s) are still recorded inside under this permit. Record their exit before closing it — a closed permit says the space is empty.`,
      );
    }
    if (
      permit.permitType === "hot_work" &&
      typeof permit.fireWatchMinutes === "number" &&
      permit.fireWatchMinutes > 0 &&
      !permit.fireWatchCompletedAt
    ) {
      return refuse(
        `Hot work requires a ${permit.fireWatchMinutes}-minute fire watch after the work stops. Record its completion before closing the permit.`,
      );
    }
  }

  return allow(warnings);
}

function pastTense(action: string): string {
  if (action === "close") return "closed";
  if (action === "cancel") return "cancelled";
  if (action === "expire") return "expired";
  return `${action}d`;
}

/* ------------------------------------------------------------------ */
/* Clocks                                                              */
/* ------------------------------------------------------------------ */

export interface EntryClock {
  id: string;
  personName: string;
  enteredAt: string;
  expectedExitAt: string | null;
  status: string;
}

export interface OverdueEntry {
  id: string;
  personName: string;
  expectedExitAt: string;
  overdueMinutes: number;
  insideMinutes: number;
}

/** Entries still inside past their expected exit, worst first. */
export function overdueEntries(entries: readonly EntryClock[], now: string): OverdueEntry[] {
  const nowMs = Date.parse(now);
  const out: OverdueEntry[] = [];
  for (const entry of entries) {
    if (entry.status !== "inside" && entry.status !== "overdue") continue;
    if (!entry.expectedExitAt) continue;
    const dueMs = Date.parse(entry.expectedExitAt);
    if (!Number.isFinite(dueMs) || dueMs >= nowMs) continue;
    out.push({
      id: entry.id,
      personName: entry.personName,
      expectedExitAt: entry.expectedExitAt,
      overdueMinutes: Math.round((nowMs - dueMs) / 60_000),
      insideMinutes: Math.round((nowMs - Date.parse(entry.enteredAt)) / 60_000),
    });
  }
  return out.sort((a, b) => b.overdueMinutes - a.overdueMinutes);
}

export interface LoneWorkerClock {
  id: string;
  personName: string;
  status: string;
  nextDueAt: string;
  intervalMinutes: number;
  missedCount: number;
  expectedEndAt: string | null;
}

export interface LoneWorkerVerdict {
  id: string;
  personName: string;
  nextDueAt: string;
  lateMinutes: number;
  /** overdue → the check-in is late; escalated → late by a whole interval */
  action: "overdue" | "escalate";
  reason: string;
}

/**
 * A missed check-in is `overdue` immediately; it becomes `escalate` once the
 * worker is a whole check-in interval late (or five minutes, whichever is
 * longer — a two-minute interval must still escalate at some point).
 */
export function loneWorkerDue(sessions: readonly LoneWorkerClock[], now: string): LoneWorkerVerdict[] {
  const nowMs = Date.parse(now);
  const out: LoneWorkerVerdict[] = [];
  for (const session of sessions) {
    if (session.status !== "active" && session.status !== "overdue") continue;
    const dueMs = Date.parse(session.nextDueAt);
    if (!Number.isFinite(dueMs) || dueMs > nowMs) continue;
    const lateMinutes = Math.round((nowMs - dueMs) / 60_000);
    const escalateAfter = Math.max(5, session.intervalMinutes);
    const escalate = lateMinutes >= escalateAfter || session.status === "overdue";
    out.push({
      id: session.id,
      personName: session.personName,
      nextDueAt: session.nextDueAt,
      lateMinutes,
      action: escalate ? "escalate" : "overdue",
      reason: escalate
        ? `${session.personName} is ${lateMinutes} minute(s) past a check-in due at ${session.nextDueAt} — a full check-in interval. Send someone to their last known position.`
        : `${session.personName} missed a check-in due at ${session.nextDueAt} (${lateMinutes} minute(s) ago).`,
    });
  }
  return out.sort((a, b) => b.lateMinutes - a.lateMinutes);
}

/** Permits whose validity window has closed while they were still open. */
export function expiredPermits<T extends { id: string; status: string; validTo: string | null }>(
  permits: readonly T[],
  now: string,
): T[] {
  const nowMs = Date.parse(now);
  return permits.filter((p) => {
    if (p.status !== "active" && p.status !== "approved" && p.status !== "suspended") return false;
    if (!p.validTo) return false;
    const to = Date.parse(p.validTo);
    return Number.isFinite(to) && to < nowMs;
  });
}
