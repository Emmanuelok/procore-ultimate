/**
 * ATTENDANCE RECONCILIATION — the gate feed against the labour register
 * (spec Vol II Z #1067–1069, M #689 ghost-worker family).
 *
 * Two independent streams say who was on site on a given day:
 *
 *   • `workforce.site_access_records` — the ATTENDANCE CLAIM: one row per
 *     worker per day, with hours on site, usually loaded from an employer's
 *     own system or entered by hand.
 *   • the site gate feed folded by `dailyPresence` — the OBSERVATION: what the
 *     turnstile actually recorded.
 *
 * This engine compares them. It is deliberately conservative, because the
 * accusation it can produce (an employer claiming hours nobody walked through
 * a gate for) is a serious one:
 *
 *   • Matching is by (workerId, date). A gate read that carries no worker id
 *     is a visitor or an unmatched badge — it is reported separately, never as
 *     a worker who failed to appear.
 *   • A day on which the gate feed recorded NOTHING AT ALL is not evidence
 *     against anybody: every line on such a day is `not_comparable`, with the
 *     reason. A feed that was switched off does not make a workforce liar.
 *   • A session still open at the end of the window has no duration yet, so it
 *     is `not_comparable` rather than counted as zero.
 *   • A claim with no hours on it is not compared; hours cannot be invented.
 *
 * Pure: loading the two streams and rendering the verdicts is the caller's job.
 */

/**
 * Move a gate feed onto the site's own day boundary.
 *
 * `dailyPresence` splits sessions at UTC midnight, and an attendance record
 * carries a plain calendar date the site wrote in its own time. On a site at
 * UTC+8 a 07:00 shift starts at 23:00 the PREVIOUS UTC day, so comparing the
 * two streams unshifted would report a missing gate read on one day and an
 * unexplained presence on the next — an accusation manufactured by arithmetic.
 *
 * Shifting every read by the site's offset before folding moves the boundary
 * without changing any duration: the instants are no longer real instants
 * afterwards, so the shifted stream is used ONLY to bucket days and hours.
 */
export function shiftToLocalDays<T extends { occurredAt: string }>(
  events: readonly T[],
  offsetMinutes: number,
): T[] {
  if (offsetMinutes === 0) return [...events];
  return events.map((event) => {
    const at = Date.parse(event.occurredAt);
    if (Number.isNaN(at)) return event;
    return { ...event, occurredAt: new Date(at + offsetMinutes * 60_000).toISOString() };
  });
}

export interface AttendanceClaim {
  workerId: string;
  workerName: string | null;
  /** ISO date (YYYY-MM-DD) */
  date: string;
  firstIn: string | null;
  lastOut: string | null;
  hours: number | null;
  source: string;
}

export interface AttendanceObservation {
  /** ISO date (YYYY-MM-DD) */
  date: string;
  personKey: string;
  personName: string;
  workerId: string | null;
  firstIn: string | null;
  lastOut: string | null;
  hours: number;
  openAtWindowEnd: boolean;
}

export type AttendanceResult =
  | "agreed"
  | "over_claimed"
  | "under_claimed"
  | "no_gate_record"
  | "no_attendance_record"
  | "not_comparable";

export interface AttendanceLine {
  date: string;
  workerId: string | null;
  personKey: string | null;
  name: string;
  claimedHours: number | null;
  observedHours: number | null;
  /** claimed − observed, in hours; null when the two cannot be compared */
  varianceHours: number | null;
  claimSource: string | null;
  result: AttendanceResult;
  reasons: string[];
}

export interface AttendanceSummary {
  from: string;
  to: string;
  toleranceHours: number;
  lines: AttendanceLine[];
  byResult: Record<AttendanceResult, number>;
  /** hours totalled only over the lines that could actually be compared */
  comparedClaimedHours: number;
  comparedObservedHours: number;
  comparedLines: number;
  /** the largest single-day over-claim beyond tolerance; null when there is none */
  worstOverclaimHours: number | null;
  /** days in the window on which the gate feed recorded at least one read */
  daysWithGateReads: number;
  daysInWindow: number;
  /** gate presence that carries no worker id and so matches no claim */
  unattributedPresence: Array<{ date: string; personKey: string; personName: string; hours: number }>;
  reasons: string[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Every date in [from, to] inclusive, as ISO dates. Bounded by the caller. */
function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let cursor = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  if (Number.isNaN(cursor) || Number.isNaN(end)) return out;
  while (cursor <= end && out.length < 400) {
    out.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 86_400_000;
  }
  return out;
}

export function reconcileAttendance(
  claims: readonly AttendanceClaim[],
  observations: readonly AttendanceObservation[],
  options: { from: string; to: string; toleranceHours?: number },
): AttendanceSummary {
  const toleranceHours = options.toleranceHours ?? 0.5;
  const days = datesBetween(options.from, options.to);
  const inWindow = new Set(days);

  const observationsInWindow = observations.filter((o) => inWindow.has(o.date));
  const claimsInWindow = claims.filter((c) => inWindow.has(c.date));

  /** days the feed actually covered — the ONLY days a missing read means anything */
  const daysWithReads = new Set(observationsInWindow.map((o) => o.date));

  const byWorkerDay = new Map<string, AttendanceObservation>();
  const unattributed: AttendanceSummary["unattributedPresence"] = [];
  for (const observation of observationsInWindow) {
    if (!observation.workerId) {
      unattributed.push({
        date: observation.date,
        personKey: observation.personKey,
        personName: observation.personName,
        hours: round2(observation.hours),
      });
      continue;
    }
    const key = `${observation.workerId}|${observation.date}`;
    const existing = byWorkerDay.get(key);
    // Two folds for one worker-day should not happen, but if the feed carries
    // the same worker under two badges, the day's hours are the sum.
    if (existing) {
      byWorkerDay.set(key, {
        ...existing,
        hours: existing.hours + observation.hours,
        firstIn:
          existing.firstIn && observation.firstIn
            ? existing.firstIn < observation.firstIn
              ? existing.firstIn
              : observation.firstIn
            : (existing.firstIn ?? observation.firstIn),
        lastOut:
          existing.lastOut && observation.lastOut
            ? existing.lastOut > observation.lastOut
              ? existing.lastOut
              : observation.lastOut
            : (existing.lastOut ?? observation.lastOut),
        openAtWindowEnd: existing.openAtWindowEnd || observation.openAtWindowEnd,
      });
    } else {
      byWorkerDay.set(key, observation);
    }
  }

  const lines: AttendanceLine[] = [];
  const seenObservations = new Set<string>();

  for (const claim of claimsInWindow) {
    const key = `${claim.workerId}|${claim.date}`;
    const observation = byWorkerDay.get(key);
    if (observation) seenObservations.add(key);
    const name = claim.workerName ?? observation?.personName ?? claim.workerId;

    if (!observation) {
      const feedRan = daysWithReads.has(claim.date);
      lines.push({
        date: claim.date,
        workerId: claim.workerId,
        personKey: null,
        name,
        claimedHours: claim.hours,
        observedHours: null,
        varianceHours: null,
        claimSource: claim.source,
        result: feedRan ? "no_gate_record" : "not_comparable",
        reasons: feedRan
          ? [
              `The labour register records ${claim.hours === null ? "attendance" : `${round2(claim.hours)} hour(s)`} for this worker, and the gate feed recorded reads that day but none for them.`,
            ]
          : [`The gate feed recorded nothing at all on ${claim.date}, so this attendance record cannot be tested against it.`],
      });
      continue;
    }

    if (claim.hours === null) {
      lines.push({
        date: claim.date,
        workerId: claim.workerId,
        personKey: observation.personKey,
        name,
        claimedHours: null,
        observedHours: round2(observation.hours),
        varianceHours: null,
        claimSource: claim.source,
        result: "not_comparable",
        reasons: ["The attendance record carries no hours, so there is nothing to compare with the gate feed."],
      });
      continue;
    }

    if (observation.openAtWindowEnd) {
      lines.push({
        date: claim.date,
        workerId: claim.workerId,
        personKey: observation.personKey,
        name,
        claimedHours: round2(claim.hours),
        observedHours: null,
        varianceHours: null,
        claimSource: claim.source,
        result: "not_comparable",
        reasons: [
          "The gate feed still holds this person on site at the end of the window, so their hours for the day are not yet a fact.",
        ],
      });
      continue;
    }

    const variance = round2(claim.hours - observation.hours);
    const within = Math.abs(variance) <= toleranceHours;
    lines.push({
      date: claim.date,
      workerId: claim.workerId,
      personKey: observation.personKey,
      name,
      claimedHours: round2(claim.hours),
      observedHours: round2(observation.hours),
      varianceHours: variance,
      claimSource: claim.source,
      result: within ? "agreed" : variance > 0 ? "over_claimed" : "under_claimed",
      reasons: within
        ? [`Claimed ${round2(claim.hours)} h against ${round2(observation.hours)} h at the gate, within the ${toleranceHours} h tolerance.`]
        : [
            `Claimed ${round2(claim.hours)} h against ${round2(observation.hours)} h at the gate (${variance > 0 ? "+" : ""}${variance} h), beyond the ${toleranceHours} h tolerance.`,
          ],
    });
  }

  for (const [key, observation] of byWorkerDay) {
    if (seenObservations.has(key)) continue;
    lines.push({
      date: observation.date,
      workerId: observation.workerId,
      personKey: observation.personKey,
      name: observation.personName,
      claimedHours: null,
      observedHours: observation.openAtWindowEnd ? null : round2(observation.hours),
      varianceHours: null,
      claimSource: null,
      result: "no_attendance_record",
      reasons: [
        `The gate feed records this worker on site${observation.openAtWindowEnd ? " (still inside at the end of the window)" : ` for ${round2(observation.hours)} hour(s)`}, and the labour register holds no attendance for them that day.`,
      ],
    });
  }

  lines.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));

  const byResult: Record<AttendanceResult, number> = {
    agreed: 0,
    over_claimed: 0,
    under_claimed: 0,
    no_gate_record: 0,
    no_attendance_record: 0,
    not_comparable: 0,
  };
  let comparedClaimed = 0;
  let comparedObserved = 0;
  let comparedLines = 0;
  let worstOverclaim: number | null = null;
  for (const line of lines) {
    byResult[line.result] += 1;
    if (line.varianceHours === null || line.claimedHours === null || line.observedHours === null) continue;
    comparedLines += 1;
    comparedClaimed += line.claimedHours;
    comparedObserved += line.observedHours;
    // "Worst over-claim" means the worst line the engine actually calls an
    // over-claim: a variance inside the tolerance is agreement, not a small
    // theft, and reporting it as one would cry wolf on every rounding.
    if (line.result === "over_claimed" && (worstOverclaim === null || line.varianceHours > worstOverclaim)) {
      worstOverclaim = line.varianceHours;
    }
  }

  const reasons: string[] = [];
  if (daysWithReads.size === 0) {
    reasons.push(
      `The gate feed recorded nothing between ${options.from} and ${options.to}. Nothing here is evidence about anybody's attendance — it is evidence that the feed is not running.`,
    );
  } else if (daysWithReads.size < days.length) {
    reasons.push(
      `The gate feed covers ${daysWithReads.size} of the ${days.length} day(s) in this window. Attendance on the other days is not tested, and is reported as not comparable rather than as a discrepancy.`,
    );
  }
  if (claimsInWindow.length === 0) {
    reasons.push(
      "The labour register holds no attendance records for this window, so the gate feed has nothing to be reconciled against. Attendance is recorded in the workforce module.",
    );
  }
  if (unattributed.length > 0) {
    reasons.push(
      `${unattributed.length} gate presence(s) carry no worker id — visitors, staff or unmatched badges. They are listed separately and are not counted against the labour register.`,
    );
  }

  return {
    from: options.from,
    to: options.to,
    toleranceHours,
    lines,
    byResult,
    comparedClaimedHours: round2(comparedClaimed),
    comparedObservedHours: round2(comparedObserved),
    comparedLines,
    worstOverclaimHours: worstOverclaim,
    daysWithGateReads: daysWithReads.size,
    daysInWindow: days.length,
    unattributedPresence: unattributed,
    reasons,
  };
}
