/**
 * Land / resettlement / community reference data — code-resident, not tenant
 * data (the same pattern as the payments regime library). These tables encode
 * the compliance frames the module enforces: IFC Performance Standard 5 /
 * World Bank ESS5 for resettlement, and the GRM service standard for
 * grievance redress.
 */

import type { GrievanceSeverity, PapStatus, ParcelStatus } from "@constructos/shared";

/* ------------------------------------------------------------------ */
/* Grievance redress SLA (#571-572)                                    */
/* ------------------------------------------------------------------ */

export interface GrievanceSlaRule {
  /** calendar days from receipt within which the complainant must be told
   *  their grievance has been received and by whom it is being handled */
  acknowledgeDays: number;
  /** calendar days from receipt within which a resolution must be offered */
  resolveDays: number;
  /** why the clock is set where it is — surfaced to the intake officer */
  rationale: string;
}

/**
 * Severity → SLA. Calendar days, not working days: a community member's
 * exposure to dust, a blocked access track or a withheld payment does not
 * pause at the weekend, so neither does the clock. Deadlines are computed
 * from `receivedAt` (the date the community raised it), never from the date
 * the record was keyed in.
 *
 *   critical   ack  1 day   / resolve  7 days
 *   high       ack  2 days  / resolve 14 days
 *   medium     ack  3 days  / resolve 30 days
 *   low        ack  5 days  / resolve 45 days
 */
export const GRIEVANCE_SLA: Record<GrievanceSeverity, GrievanceSlaRule> = {
  critical: {
    acknowledgeDays: 1,
    resolveDays: 7,
    rationale:
      "Safety, livelihood loss, gender-based violence or security-force conduct — " +
      "lender notification duties are typically engaged within days.",
  },
  high: {
    acknowledgeDays: 2,
    resolveDays: 14,
    rationale:
      "Loss of access, damage to a structure or crop, or withheld compensation — " +
      "material harm accruing while unresolved.",
  },
  medium: {
    acknowledgeDays: 3,
    resolveDays: 30,
    rationale: "Nuisance-level impacts (dust, noise, traffic) and employment complaints.",
  },
  low: {
    acknowledgeDays: 5,
    resolveDays: 45,
    rationale: "Information requests and minor conduct matters.",
  },
};

/**
 * Grievance classification (#571). Mirrors the value set documented on the
 * `grievances.category` column; `other` is the deliberate escape hatch so the
 * analytics in #574 stay comparable across projects.
 */
export const GRIEVANCE_CATEGORIES = [
  "land",
  "noise",
  "dust",
  "access",
  "employment",
  "conduct",
  "compensation",
  "other",
] as const;
export type GrievanceCategory = (typeof GRIEVANCE_CATEGORIES)[number];

/**
 * Statuses at which the resolution clock stops. `resolved` stops the SLA but
 * does NOT satisfy the obligation — only closure verified with the
 * complainant does that (#573).
 */
export const GRIEVANCE_SETTLED_STATUSES = ["resolved", "closed_verified", "rejected"] as const;

/* ------------------------------------------------------------------ */
/* Parcel acquisition flow (#551-554)                                  */
/* ------------------------------------------------------------------ */

/**
 * Forward-ish acquisition flow. A parcel may fall into `disputed` from any
 * state (a title challenge can surface at any point, including after
 * acquisition), and a dispute resolves back into negotiation.
 *
 * TWO statuses are deliberately NOT reachable from this table, because each
 * has an evidenced route of its own:
 *
 *  - `compensated` — only via /compensate, so a parcel can never be recorded
 *    as compensated without payment evidence on file (#554).
 *  - `acquired` — only via /acquire, which records the BASIS on which title
 *    passed. Before that route existed, a state-owned, donated or
 *    court-ordered parcel could reach `acquired` only by first being marked
 *    `disputed`, so a road scheme dominated by state land manufactured a
 *    dispute for every parcel it acquired, and every dispute statistic,
 *    RAP dashboard figure and pipeline count was wrong from day one.
 */
export const PARCEL_TRANSITIONS: Record<ParcelStatus, readonly ParcelStatus[]> = {
  identified: ["surveyed", "disputed"],
  surveyed: ["under_negotiation", "disputed"],
  under_negotiation: ["agreed", "disputed"],
  agreed: ["disputed"],
  compensated: ["disputed"],
  acquired: ["disputed"],
  disputed: ["under_negotiation"],
};

/**
 * Statuses from which compensation may be recorded (#553-554).
 *
 * `compensated` and `acquired` are included because a supplementary payment
 * is ordinary RAP practice — a valuation is revised on appeal, a crop or
 * structure missed at the survey is paid for later, a court awards a top-up.
 * Excluding them left the register permanently stuck on the first figure:
 * the PATCH route refused the edit (rightly) and pointed at /compensate,
 * which refused it too, so the only reachable path was
 * `compensated → disputed → under_negotiation → /compensate` — three
 * fabricated state changes including a fictitious dispute, which is exactly
 * the register corruption the /acquire route was introduced to eliminate.
 * A second payment ADDS to the total (it does not restate it); restating a
 * mis-keyed figure is the separate, reasoned /compensation-correction act.
 */
export const PARCEL_COMPENSABLE_FROM: readonly ParcelStatus[] = [
  "under_negotiation",
  "agreed",
  "disputed",
  "compensated",
  "acquired",
];

/**
 * Statuses from which title may pass (#551-552). `disputed` is included
 * because a court order or a compulsory-purchase determination is exactly
 * how a disputed parcel is acquired — with the order as the evidence.
 */
export const PARCEL_ACQUIRABLE_FROM: readonly ParcelStatus[] = [
  "agreed",
  "compensated",
  "disputed",
];

/**
 * Acquisition bases that involve buying the land, and therefore require a
 * compensation payment before possession (IFC PS5 para 20). Donation, state
 * allocation and a lease of land the state already holds do not.
 */
export const CASH_ACQUISITION_BASES: readonly string[] = ["purchase", "expropriation"];

/** A parcel is only handed to construction once title has actually passed. */
export const PARCEL_READY_STATUS: ParcelStatus = "acquired";

/** Statuses that still block the programme (#591). */
export const PARCEL_BLOCKING_STATUSES: readonly ParcelStatus[] = [
  "identified",
  "surveyed",
  "under_negotiation",
  "agreed",
  "compensated",
  "disputed",
];

/* ------------------------------------------------------------------ */
/* PAP vulnerability screening (#557)                                  */
/* ------------------------------------------------------------------ */

/**
 * Vulnerability flags allowlist, mirroring the documented value set on
 * `affected_persons.vulnerabilities`. Under IFC PS5 a household carrying any
 * of these attracts enhanced entitlements and targeted livelihood support, so
 * the set is closed: a free-text flag would silently drop a household out of
 * the enhanced-entitlement population.
 */
export const VULNERABILITY_FLAGS = [
  "elderly",
  "disabled",
  "female_headed",
  "landless",
  "indigenous",
  "below_poverty_line",
  "child_headed",
] as const;
export type VulnerabilityFlag = (typeof VULNERABILITY_FLAGS)[number];

/** Displacement types that require a livelihood restoration programme (#561). */
export const LIVELIHOOD_REQUIRED_DISPLACEMENT: readonly string[] = ["economic", "both"];

/**
 * Household lifecycle (#555-568), mirroring PARCEL_TRANSITIONS.
 *
 * Before this table the status route accepted anything but `compensated`, so
 * `livelihood_restored → registered` was legal, a household could be marked
 * `resettled` with no entitlements and no payment, and `grievance_open` could
 * be set by hand — while the RAP metrics counted livelihood restoration by
 * status OR date, so the dashboard and the ledger told different stories.
 *
 * Two statuses are deliberately unreachable from this table:
 *  - `compensated` — only via the evidenced /compensate route.
 *  - `grievance_open` — set by the grievance module (see pap-grievance.ts)
 *    when a grievance naming the household is opened, and cleared when the
 *    last such grievance settles. It describes something that happened
 *    elsewhere; typing it in asserts a grievance exists that does not.
 *
 * `grievance_open` is an OVERLAY, not a step: the household's substantive
 * position is stashed in `statusBeforeGrievance` and restored exactly, and
 * every rule that reads the column as a lifecycle fact goes through
 * `effectivePapStatus`. The route therefore evaluates this table from the
 * effective status, and the `grievance_open` row below only ever applies to
 * rows flagged before the stash existed.
 */
export const PAP_TRANSITIONS: Record<PapStatus, readonly PapStatus[]> = {
  registered: ["surveyed"],
  surveyed: ["entitlement_agreed"],
  entitlement_agreed: [],
  compensated: ["resettled", "livelihood_restored"],
  resettled: ["livelihood_restored"],
  livelihood_restored: [],
  // a household whose grievance closes returns to where the register had it
  grievance_open: ["entitlement_agreed", "compensated", "resettled", "livelihood_restored"],
};

/** `resettled` asserts a physical move actually happened. */
export const RESETTLEMENT_REQUIRES_PAYMENT = true;

/** Displacement types that count as physical displacement (#565). */
export const PHYSICAL_DISPLACEMENT: readonly string[] = ["physical", "both"];

/* ------------------------------------------------------------------ */
/* Stakeholder influence / interest mapping (#579)                     */
/* ------------------------------------------------------------------ */

export const STAKEHOLDER_QUADRANTS = [
  "manage_closely",
  "keep_satisfied",
  "keep_informed",
  "monitor",
] as const;
export type StakeholderQuadrant = (typeof STAKEHOLDER_QUADRANTS)[number];

/**
 * Mendelow power/interest grid on the 1-5 scales carried by the register.
 * 4-5 is "high" on either axis, 1-3 is "low".
 */
export function quadrantFor(influence: number, interest: number): StakeholderQuadrant {
  const highInfluence = influence >= 4;
  const highInterest = interest >= 4;
  if (highInfluence && highInterest) return "manage_closely";
  if (highInfluence) return "keep_satisfied";
  if (highInterest) return "keep_informed";
  return "monitor";
}

/** Engagement kinds (#580-584), mirroring the documented column value set. */
export const ENGAGEMENT_KINDS = [
  "consultation",
  "disclosure",
  "meeting",
  "site_visit",
  "notice",
] as const;
export type EngagementKind = (typeof ENGAGEMENT_KINDS)[number];

/** Stakeholder categories, mirroring the documented column value set. */
export const STAKEHOLDER_CATEGORIES = [
  "community",
  "authority",
  "ngo",
  "media",
  "business",
  "indigenous_group",
] as const;
export type StakeholderCategory = (typeof STAKEHOLDER_CATEGORIES)[number];
