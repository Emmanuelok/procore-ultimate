/**
 * RFI analytics engine — spec #321 ball-in-court analytics and #322 ageing /
 * cycle-time analytics. Cycle time is measured from `issuedAt` (the moment
 * the question left draft), falling back to `createdAt` only for records
 * that predate the column, and the basis says which it used.
 */
import { average, median, ageInDays, daysOverdue } from "./ageingEngine.js";
import { daysBetween } from "./dates.js";

export interface CycleTimeStats {
  n: number;
  avgResponseDays: number | null;
  medianResponseDays: number | null;
  basis: string;
  /** how many of the answered RFIs lacked issuedAt and were measured from createdAt */
  measuredFromCreated: number;
}

export function cycleTimeStats(
  rows: readonly { issuedAt: string | null; createdAt: string; respondedAt: string | null }[],
): CycleTimeStats {
  let measuredFromCreated = 0;
  const durations: number[] = [];
  for (const r of rows) {
    if (!r.respondedAt) continue;
    const start = r.issuedAt ?? r.createdAt;
    if (!r.issuedAt) measuredFromCreated += 1;
    durations.push(Math.max(0, daysBetween(start, r.respondedAt)));
  }
  return {
    n: durations.length,
    avgResponseDays: average(durations),
    medianResponseDays: median(durations),
    measuredFromCreated,
    basis:
      durations.length === 0
        ? "No answered RFIs yet"
        : measuredFromCreated === 0
          ? "Issued → responded, calendar days"
          : `Issued → responded; ${measuredFromCreated} legacy record(s) measured from creation`,
  };
}

export interface BallInCourtRow {
  userId: string;
  open: number;
  overdue: number;
  avgDaysInCourt: number | null;
  oldestDays: number;
}

/** Who is holding open RFIs, how many, how long, how many overdue. */
export function ballInCourtSummary(
  rows: readonly { ballInCourtId: string | null; status: string; issuedAt: string | null; createdAt: string; dueDate: string | null; updatedAt: string }[],
  todayIso: string,
): BallInCourtRow[] {
  const byUser = new Map<string, { ages: number[]; overdue: number }>();
  for (const r of rows) {
    if (r.status !== "open" || !r.ballInCourtId) continue;
    const rec = byUser.get(r.ballInCourtId) ?? { ages: [], overdue: 0 };
    rec.ages.push(ageInDays(r.issuedAt ?? r.createdAt, todayIso));
    if (daysOverdue(r.dueDate, todayIso) > 0) rec.overdue += 1;
    byUser.set(r.ballInCourtId, rec);
  }
  return [...byUser.entries()]
    .map(([userId, rec]) => ({
      userId,
      open: rec.ages.length,
      overdue: rec.overdue,
      avgDaysInCourt: average(rec.ages),
      oldestDays: rec.ages.length > 0 ? Math.max(...rec.ages) : 0,
    }))
    .sort((a, b) => b.overdue - a.overdue || b.open - a.open || a.userId.localeCompare(b.userId));
}
