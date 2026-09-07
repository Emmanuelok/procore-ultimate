/**
 * SKILLS & CERTIFICATION MATRIX — pure, no I/O (spec Vol I #692–696).
 *
 * Two states are deliberately kept apart and never collapsed:
 *
 *   EVIDENCE state (`status`) — did anybody check? A `claimed` ticket is a
 *   worker's assertion; a `verified` one has been seen by somebody else.
 *
 *   VALIDITY state (from `expiresAt`) — is it still good? A verified
 *   certificate expires exactly like an unverified one.
 *
 * A matrix that shows a green tick for an expired-but-verified ticket is how
 * an uncertificated operator ends up on a machine, so the two axes are
 * reported separately and the worst of the two drives the gap list.
 *
 * `unknown` validity — no expiry date recorded — is NOT treated as valid. It
 * is reported as unknown, because "we never wrote down when this lapses" and
 * "this does not lapse" are different facts and only the second is safe.
 */
import type {
  SkillCategory,
  SkillValidityState,
  WorkerSkillStatus,
} from "@constructos/shared";
import { daysBetween, round2 } from "./calendar.js";

/** Days before expiry at which a certificate starts warning. */
export const EXPIRY_WARN_DAYS = 30;

export interface SkillDefinition {
  id: string;
  code: string;
  name: string;
  category: SkillCategory;
  trade: string | null;
  validityMonths: number | null;
  isMandatory: boolean;
  requiresEvidence: boolean;
}

export interface WorkerRef {
  id: string;
  reference: string;
  fullName: string;
  trade: string | null;
  vendorId: string | null;
  status: string;
}

export interface WorkerSkillCell {
  workerId: string;
  skillId: string;
  level: string;
  status: WorkerSkillStatus;
  issuedAt: string | null;
  expiresAt: string | null;
  certificateRef: string | null;
}

export interface ValidityClassification {
  state: SkillValidityState;
  daysToExpiry: number | null;
  reason: string;
}

export function classifyValidity(
  expiresAt: string | null,
  today: string,
  warnDays = EXPIRY_WARN_DAYS,
): ValidityClassification {
  if (!expiresAt) {
    return {
      state: "unknown",
      daysToExpiry: null,
      reason:
        "No expiry date is recorded. That is not the same as never expiring — it means nobody " +
        "wrote down when this lapses, so it cannot be relied on.",
    };
  }
  const days = daysBetween(today, expiresAt);
  if (days < 0) {
    return {
      state: "expired",
      daysToExpiry: days,
      reason: `Expired on ${expiresAt}, ${Math.abs(days)} day(s) ago.`,
    };
  }
  if (days <= warnDays) {
    return {
      state: "expiring",
      daysToExpiry: days,
      reason: `Expires on ${expiresAt}, in ${days} day(s).`,
    };
  }
  return {
    state: "valid",
    daysToExpiry: days,
    reason: `Valid until ${expiresAt}.`,
  };
}

export interface MatrixCell {
  skillId: string;
  skillCode: string;
  skillName: string;
  held: boolean;
  level: string | null;
  status: WorkerSkillStatus | null;
  validity: SkillValidityState;
  daysToExpiry: number | null;
  certificateRef: string | null;
  expiresAt: string | null;
  reason: string;
}

export interface MatrixRow {
  worker: WorkerRef;
  cells: MatrixCell[];
  /** mandatory skills this worker does not hold, or holds expired/rejected */
  gapCount: number;
  expiringCount: number;
  expiredCount: number;
  unverifiedCount: number;
}

export interface SkillCoverage {
  skill: SkillDefinition;
  workersHolding: number;
  valid: number;
  expiring: number;
  expired: number;
  unknownExpiry: number;
  unverified: number;
  missing: number;
  /** null when the project has no workers on the register */
  coveragePercent: number | null;
  reasons: string[];
}

export interface SkillsMatrix {
  rows: MatrixRow[];
  coverage: SkillCoverage[];
  totals: {
    workers: number;
    skills: number;
    mandatoryGaps: number;
    expired: number;
    expiring: number;
    unverified: number;
  };
  reasons: string[];
}

/**
 * The matrix. One row per worker, one cell per skill, plus a per-skill
 * coverage roll-up that is the thing a project actually acts on: "eleven
 * people can operate the MEWP, two of their tickets expire this month".
 */
export function buildSkillsMatrix(
  workers: WorkerRef[],
  skills: SkillDefinition[],
  cells: WorkerSkillCell[],
  options: { today: string; warnDays?: number },
): SkillsMatrix {
  const warnDays = options.warnDays ?? EXPIRY_WARN_DAYS;
  const byWorker = new Map<string, Map<string, WorkerSkillCell>>();
  for (const cell of cells) {
    const held = byWorker.get(cell.workerId) ?? new Map<string, WorkerSkillCell>();
    held.set(cell.skillId, cell);
    byWorker.set(cell.workerId, held);
  }

  const coverageAcc = new Map<
    string,
    { valid: number; expiring: number; expired: number; unknown: number; unverified: number; holding: number }
  >();
  for (const skill of skills) {
    coverageAcc.set(skill.id, {
      valid: 0,
      expiring: 0,
      expired: 0,
      unknown: 0,
      unverified: 0,
      holding: 0,
    });
  }

  let mandatoryGaps = 0;
  let expiredTotal = 0;
  let expiringTotal = 0;
  let unverifiedTotal = 0;

  const rows: MatrixRow[] = workers.map((worker) => {
    const held = byWorker.get(worker.id) ?? new Map<string, WorkerSkillCell>();
    let gapCount = 0;
    let expiringCount = 0;
    let expiredCount = 0;
    let unverifiedCount = 0;

    const matrixCells: MatrixCell[] = skills.map((skill) => {
      const cell = held.get(skill.id);
      const acc = coverageAcc.get(skill.id)!;
      if (!cell || cell.status === "rejected" || cell.status === "revoked") {
        if (skill.isMandatory) {
          gapCount += 1;
          mandatoryGaps += 1;
        }
        return {
          skillId: skill.id,
          skillCode: skill.code,
          skillName: skill.name,
          held: false,
          level: null,
          status: cell?.status ?? null,
          validity: "unknown",
          daysToExpiry: null,
          certificateRef: null,
          expiresAt: null,
          reason: cell
            ? `Recorded as ${cell.status}, so it does not count as held.`
            : "Not recorded against this worker.",
        };
      }
      acc.holding += 1;
      const validity = classifyValidity(cell.expiresAt, options.today, warnDays);
      if (validity.state === "valid") acc.valid += 1;
      else if (validity.state === "expiring") {
        acc.expiring += 1;
        expiringCount += 1;
        expiringTotal += 1;
      } else if (validity.state === "expired") {
        acc.expired += 1;
        expiredCount += 1;
        expiredTotal += 1;
        if (skill.isMandatory) {
          gapCount += 1;
          mandatoryGaps += 1;
        }
      } else acc.unknown += 1;

      if (cell.status !== "verified") {
        acc.unverified += 1;
        unverifiedCount += 1;
        unverifiedTotal += 1;
      }

      return {
        skillId: skill.id,
        skillCode: skill.code,
        skillName: skill.name,
        held: true,
        level: cell.level,
        status: cell.status,
        validity: validity.state,
        daysToExpiry: validity.daysToExpiry,
        certificateRef: cell.certificateRef,
        expiresAt: cell.expiresAt,
        reason:
          cell.status === "verified"
            ? validity.reason
            : `${validity.reason} Recorded as ${cell.status} — nobody has verified the evidence.`,
      };
    });

    return {
      worker,
      cells: matrixCells,
      gapCount,
      expiringCount,
      expiredCount,
      unverifiedCount,
    };
  });

  const coverage: SkillCoverage[] = skills.map((skill) => {
    const acc = coverageAcc.get(skill.id)!;
    const reasons: string[] = [];
    if (workers.length === 0) {
      reasons.push("No workers are on this project's register, so coverage is not computable.");
    }
    if (acc.unknown > 0) {
      reasons.push(
        `${acc.unknown} holder(s) have no expiry date recorded, so their validity is unknown ` +
          "rather than good.",
      );
    }
    if (acc.unverified > 0) {
      reasons.push(
        `${acc.unverified} record(s) have not been verified by anyone other than the claimant.`,
      );
    }
    return {
      skill,
      workersHolding: acc.holding,
      valid: acc.valid,
      expiring: acc.expiring,
      expired: acc.expired,
      unknownExpiry: acc.unknown,
      unverified: acc.unverified,
      missing: workers.length - acc.holding,
      coveragePercent: workers.length > 0 ? round2((acc.valid / workers.length) * 100) : null,
      reasons,
    };
  });

  const reasons: string[] = [];
  if (skills.length === 0) {
    reasons.push(
      "No skills or certifications are defined for this company, so there is no matrix to build. " +
        "Define the tickets the work actually requires first.",
    );
  }
  if (workers.length === 0) {
    reasons.push(
      "No workers are on this project's register. The matrix reads the workforce register rather " +
        "than keeping a second list of people.",
    );
  }

  return {
    rows,
    coverage: coverage.sort((a, b) => (a.coveragePercent ?? 101) - (b.coveragePercent ?? 101)),
    totals: {
      workers: workers.length,
      skills: skills.length,
      mandatoryGaps,
      expired: expiredTotal,
      expiring: expiringTotal,
      unverified: unverifiedTotal,
    },
    reasons,
  };
}

/* ------------------------------------------------------------------ */
/* Assignment gaps                                                     */
/* ------------------------------------------------------------------ */

export interface AssignedWorker {
  assignmentId: string;
  assignmentReference: string;
  workerId: string;
  workerLabel: string;
  fromDate: string;
  toDate: string;
  /** the skills the assigned resource type requires */
  requiredSkillIds: string[];
}

export interface SkillGap {
  assignmentId: string;
  assignmentReference: string;
  workerId: string;
  workerLabel: string;
  skillId: string;
  skillName: string;
  kind: "missing" | "expired" | "expires_during" | "unverified";
  severity: "critical" | "high" | "medium";
  expiresAt: string | null;
  explanation: string;
}

/**
 * Workers booked onto work whose resource type demands a ticket they do not
 * hold, hold expired, or whose ticket lapses part-way through the booking.
 *
 * `expires_during` is the finding nobody catches by hand: the ticket is valid
 * on the day the booking is made and expires in week three of a six-week
 * assignment.
 */
export function detectSkillGaps(
  assigned: AssignedWorker[],
  skills: SkillDefinition[],
  cells: WorkerSkillCell[],
  options: { today: string },
): SkillGap[] {
  const skillIndex = new Map(skills.map((s) => [s.id, s]));
  const byWorker = new Map<string, Map<string, WorkerSkillCell>>();
  for (const cell of cells) {
    const held = byWorker.get(cell.workerId) ?? new Map<string, WorkerSkillCell>();
    held.set(cell.skillId, cell);
    byWorker.set(cell.workerId, held);
  }

  const gaps: SkillGap[] = [];
  for (const booking of assigned) {
    for (const skillId of booking.requiredSkillIds) {
      const skill = skillIndex.get(skillId);
      if (!skill) continue;
      const cell = byWorker.get(booking.workerId)?.get(skillId);
      if (!cell || cell.status === "rejected" || cell.status === "revoked") {
        gaps.push({
          assignmentId: booking.assignmentId,
          assignmentReference: booking.assignmentReference,
          workerId: booking.workerId,
          workerLabel: booking.workerLabel,
          skillId,
          skillName: skill.name,
          kind: "missing",
          severity: skill.isMandatory ? "critical" : "medium",
          expiresAt: null,
          explanation:
            `${booking.workerLabel} is booked on ${booking.assignmentReference} ` +
            `(${booking.fromDate} → ${booking.toDate}) which requires ${skill.name}, and ` +
            (cell
              ? `their record is ${cell.status}.`
              : "no record of it exists against them.") +
            (skill.isMandatory ? " This ticket is mandatory: the work cannot proceed without it." : ""),
        });
        continue;
      }
      const validity = classifyValidity(cell.expiresAt, options.today);
      if (validity.state === "expired") {
        gaps.push({
          assignmentId: booking.assignmentId,
          assignmentReference: booking.assignmentReference,
          workerId: booking.workerId,
          workerLabel: booking.workerLabel,
          skillId,
          skillName: skill.name,
          kind: "expired",
          severity: skill.isMandatory ? "critical" : "high",
          expiresAt: cell.expiresAt,
          explanation:
            `${booking.workerLabel}'s ${skill.name} ${validity.reason.toLowerCase()} They are ` +
            `booked on ${booking.assignmentReference} from ${booking.fromDate} to ${booking.toDate}.`,
        });
        continue;
      }
      if (cell.expiresAt && cell.expiresAt >= booking.fromDate && cell.expiresAt <= booking.toDate) {
        gaps.push({
          assignmentId: booking.assignmentId,
          assignmentReference: booking.assignmentReference,
          workerId: booking.workerId,
          workerLabel: booking.workerLabel,
          skillId,
          skillName: skill.name,
          kind: "expires_during",
          severity: skill.isMandatory ? "high" : "medium",
          expiresAt: cell.expiresAt,
          explanation:
            `${booking.workerLabel}'s ${skill.name} expires on ${cell.expiresAt}, part-way through ` +
            `${booking.assignmentReference} (${booking.fromDate} → ${booking.toDate}). It is valid ` +
            "today, which is why nobody catches this by hand.",
        });
        continue;
      }
      if (cell.status !== "verified" && skill.requiresEvidence) {
        gaps.push({
          assignmentId: booking.assignmentId,
          assignmentReference: booking.assignmentReference,
          workerId: booking.workerId,
          workerLabel: booking.workerLabel,
          skillId,
          skillName: skill.name,
          kind: "unverified",
          severity: "medium",
          expiresAt: cell.expiresAt,
          explanation:
            `${booking.workerLabel}'s ${skill.name} is recorded as ${cell.status} and this ticket ` +
            "requires evidence. A claim by the person it benefits is not evidence.",
        });
      }
    }
  }
  return gaps;
}
