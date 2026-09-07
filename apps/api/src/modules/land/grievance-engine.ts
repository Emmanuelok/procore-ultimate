/**
 * Grievance intelligence engine (#572, #574) — pure rules over grievance rows.
 *
 * TWO THINGS A GRM NEEDS THAT A REGISTER ALONE DOES NOT GIVE IT
 *
 * 1. AN ESCALATION LADDER THAT MOVES ON ITS OWN. A published GRM service
 *    standard is a promise with a clock. When the clock runs out, the promise
 *    that matters is not "we will apologise" — it is "this stops being the
 *    site officer's problem". So a missed acknowledgement raises the case to
 *    tier 1 (community liaison manager) and a missed resolution to tier 2
 *    (project director); a case still open at twice its resolution period
 *    reaches tier 3, which is the point at which the complainant is told, in
 *    writing, about the external and judicial routes the GRM must never
 *    obstruct. The ladder is deterministic and ledgered so nobody can later
 *    claim the case was "being handled".
 *
 * 2. HOTSPOT DETECTION. Individually, five dust complaints are five
 *    grievances. Together, at one location, inside a month, they are a
 *    control failure — and they are how community disruption of the works
 *    starts. The hotspot rule is deliberately simple and stated in the
 *    finding, because an opaque clustering score is not something a community
 *    liaison officer can act on or argue with.
 *
 * Nothing here reads or writes the database.
 */

export const GRIEVANCE_TIER_LABELS: Record<number, string> = {
  0: "Site grievance officer",
  1: "Community liaison manager",
  2: "Project director",
  3: "External / judicial route offered",
};

export const MAX_GRIEVANCE_TIER = 3;

export interface LadderGrievance {
  id: string;
  number: number;
  severity: string;
  status: string;
  receivedAt: string;
  acknowledgeDueAt: string | null;
  resolveDueAt: string | null;
  acknowledgedAt: string | null;
  escalationTier: number;
  category: string;
  locationId: string | null;
}

export interface LadderDecision {
  grievanceId: string;
  fromTier: number;
  toTier: number;
  reason: string;
  /** the clock that was missed, for the ledger payload */
  breach: "acknowledgement" | "resolution" | "prolonged";
  overdueDays: number;
}

/** Statuses at which the clocks stop and the ladder no longer moves. */
export const SETTLED_STATUSES: readonly string[] = [
  "resolved",
  "closed_verified",
  "rejected",
  "withdrawn",
];

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
}

/**
 * The tier a grievance SHOULD be at today, and why. Returns null when the
 * case is already at or above the tier its breaches justify — the ladder only
 * ever climbs, because de-escalating a case because a date passed would erase
 * the record that it was ever escalated.
 */
export function ladderDecision(
  g: LadderGrievance,
  today: string,
  resolveDays: number,
): LadderDecision | null {
  if (SETTLED_STATUSES.includes(g.status)) return null;

  const prolongedFrom = g.resolveDueAt ? daysBetween(g.resolveDueAt, today) : -1;
  const resolutionMissed = g.resolveDueAt != null && g.resolveDueAt < today;
  const acknowledgementMissed =
    g.acknowledgedAt == null && g.acknowledgeDueAt != null && g.acknowledgeDueAt < today;

  // Prolonged: still open a full resolution period past the deadline.
  if (resolutionMissed && prolongedFrom >= resolveDays && g.escalationTier < 3) {
    return {
      grievanceId: g.id,
      fromTier: g.escalationTier,
      toTier: 3,
      breach: "prolonged",
      overdueDays: prolongedFrom,
      reason:
        `GRV-${g.number} has been open ${prolongedFrom} day(s) past its resolution deadline of ` +
        `${g.resolveDueAt} — a full ${resolveDays}-day service period beyond the promise. The ` +
        `complainant must now be told in writing about the external and judicial routes ` +
        `available to them; a GRM that absorbs a case indefinitely without offering them is ` +
        `itself a finding under IFC PS1 / ESS10.`,
    };
  }

  if (resolutionMissed && g.escalationTier < 2) {
    return {
      grievanceId: g.id,
      fromTier: g.escalationTier,
      toTier: 2,
      breach: "resolution",
      overdueDays: Math.max(0, prolongedFrom),
      reason:
        `GRV-${g.number} passed its published resolution deadline of ${g.resolveDueAt} ` +
        `${Math.max(0, prolongedFrom)} day(s) ago and remains ${g.status}. Under the published ` +
        `service standard the case escalates to the project director.`,
    };
  }

  if (acknowledgementMissed && g.escalationTier < 1) {
    const overdue = g.acknowledgeDueAt ? daysBetween(g.acknowledgeDueAt, today) : 0;
    return {
      grievanceId: g.id,
      fromTier: g.escalationTier,
      toTier: 1,
      breach: "acknowledgement",
      overdueDays: Math.max(0, overdue),
      reason:
        `GRV-${g.number} was not acknowledged by ${g.acknowledgeDueAt} (${Math.max(0, overdue)} ` +
        `day(s) ago). A complainant who has not been told their grievance was received has no ` +
        `reason to believe the mechanism works; the case escalates to the community liaison ` +
        `manager.`,
    };
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Hotspot detection                                                   */
/* ------------------------------------------------------------------ */

/** A cluster is at least this many grievances… */
export const HOTSPOT_MIN_COUNT = 3;
/** …of one category, at one location, inside this many days. */
export const HOTSPOT_WINDOW_DAYS = 30;

export interface HotspotCluster {
  key: string;
  locationId: string;
  category: string;
  count: number;
  windowStart: string;
  windowEnd: string;
  grievanceIds: string[];
  severityMix: Record<string, number>;
}

/**
 * Sliding-window cluster detection. For each (location, category) the
 * grievances are ordered by receipt date and any window of
 * HOTSPOT_WINDOW_DAYS containing at least HOTSPOT_MIN_COUNT of them is a
 * hotspot; the reported cluster is the densest such window, so a category
 * that has been rumbling for a year does not report the whole year.
 *
 * Grievances with no location are excluded on purpose: "unassigned" is not a
 * place, and a hotspot a liaison officer cannot walk to is not actionable.
 */
export function detectHotspots(
  rows: readonly LadderGrievance[],
  opts?: { minCount?: number; windowDays?: number },
): HotspotCluster[] {
  const minCount = opts?.minCount ?? HOTSPOT_MIN_COUNT;
  const windowDays = opts?.windowDays ?? HOTSPOT_WINDOW_DAYS;
  const groups = new Map<string, LadderGrievance[]>();
  for (const g of rows) {
    if (!g.locationId) continue;
    const key = `${g.locationId}|${g.category}`;
    const list = groups.get(key);
    if (list) list.push(g);
    else groups.set(key, [g]);
  }

  const clusters: HotspotCluster[] = [];
  for (const [key, list] of groups) {
    if (list.length < minCount) continue;
    const sorted = [...list].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    let best: { start: number; end: number } | null = null;
    let left = 0;
    for (let right = 0; right < sorted.length; right += 1) {
      while (daysBetween(sorted[left]!.receivedAt, sorted[right]!.receivedAt) > windowDays) {
        left += 1;
      }
      const size = right - left + 1;
      if (size >= minCount && (!best || size > best.end - best.start + 1)) {
        best = { start: left, end: right };
      }
    }
    if (!best) continue;
    const window = sorted.slice(best.start, best.end + 1);
    const first = window[0]!;
    const severityMix: Record<string, number> = {};
    for (const g of window) severityMix[g.severity] = (severityMix[g.severity] ?? 0) + 1;
    clusters.push({
      key,
      locationId: first.locationId!,
      category: first.category,
      count: window.length,
      windowStart: first.receivedAt,
      windowEnd: window[window.length - 1]!.receivedAt,
      grievanceIds: window.map((g) => g.id),
      severityMix,
    });
  }
  clusters.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return clusters;
}
