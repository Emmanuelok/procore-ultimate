/**
 * Jurisdiction reference data — code-resident, not tenant data.
 *
 * The permit lifecycle used to be a free-for-all: the status route applied
 * whatever it was sent, so `granted → applied` left the determination
 * obligation satisfied and `grantedAt` set (the overdue sweep could then
 * never fire again), `not_started → expired` was accepted with no grant on
 * file, and `refused → granted` never reopened anything. The drawer offered
 * every status as a button. A permit register whose states can move backwards
 * is not a register; it is a free-text field with rounded corners.
 *
 * These transitions encode the statutory sequence:
 *
 *      not_started ──► applied ──► in_review ──► granted ──► expired
 *                          │           │            │
 *                          └──────► refused ◄───────┘
 *                                      │
 *   re-application: refused / expired ──► applied  (fresh determination clock)
 */

import type { PermitStatus } from "@constructos/shared";

export const PERMIT_TRANSITIONS: Record<PermitStatus, readonly PermitStatus[]> = {
  not_started: ["applied"],
  applied: ["in_review", "granted", "refused"],
  in_review: ["granted", "refused"],
  // A grant lapses; it does not un-grant. `expired` is also reached by the
  // scheduled sweep when the expiry date passes.
  granted: ["expired"],
  // Both dead ends are escapable only by re-applying, which starts a fresh
  // determination clock and a fresh obligation.
  refused: ["applied"],
  expired: ["applied"],
};

/** Statuses from which moving to `applied` is a RE-application, not a first one. */
export const PERMIT_REAPPLY_FROM: readonly PermitStatus[] = ["refused", "expired"];

/** Statuses in which a permit still awaits the authority's decision. */
export const PERMIT_AWAITING_STATUSES: readonly PermitStatus[] = ["applied", "in_review"];

/** Statuses in which a permit does NOT authorise work to proceed (#591). */
export const PERMIT_BLOCKING_STATUSES: readonly PermitStatus[] = [
  "not_started",
  "applied",
  "in_review",
  "refused",
  "expired",
];

/** How far ahead an ICV certificate expiry is warned about. */
export const ICV_EXPIRY_WARN_DAYS = 60;

/* ------------------------------------------------------------------ */
/* Local content metrics (#612-615)                                    */
/* ------------------------------------------------------------------ */

export interface LocalContentMetricRule {
  key: string;
  label: string;
  unit: string;
  /** the platform can derive this from source records rather than a keyed figure */
  computable: boolean;
  /** what the derivation reads, stated so the reading's basis is honest */
  derivation: string;
}

/**
 * Every local-content metric is "higher is better" — a spend or headcount
 * percentage, an ICV score and a national quota are all FLOORS — so
 * compliance is `value >= targetValue` with no per-metric operator.
 */
export const LOCAL_CONTENT_METRIC_RULES: readonly LocalContentMetricRule[] = [
  {
    key: "local_spend_percent",
    label: "Local spend",
    unit: "%",
    computable: true,
    derivation:
      "Paid invoice value to vendors whose country matches the target's jurisdiction, over " +
      "total paid invoice value in the period. Invoices are counted once, in their own " +
      "currency: a period mixing currencies is reported as unknowable rather than summed.",
  },
  {
    key: "local_headcount_percent",
    label: "Local headcount",
    unit: "%",
    computable: true,
    derivation:
      "Active workers on the project register whose NATIONALITY matches the target's " +
      "jurisdiction, over all active workers. The worker register carries nationality only, " +
      "so residency is not read and this figure currently coincides with the national quota; " +
      "a regime that scores long-term residents as local needs a residency attribute on the " +
      "worker record before this metric can differ from it.",
  },
  {
    key: "national_quota",
    label: "National quota",
    unit: "%",
    computable: true,
    derivation:
      "Same population as local headcount, restricted to nationality — a quota is about " +
      "citizenship, and treating long-term residents as nationals is how a quota is missed " +
      "on paper and met in the report.",
  },
  {
    key: "icv_score",
    label: "In-Country Value score",
    unit: "score",
    computable: false,
    derivation:
      "Issued by an accredited ICV certifier against the regime's own template; the platform " +
      "records the certificate, it does not compute the score.",
  },
];

export const LOCAL_CONTENT_METRICS = LOCAL_CONTENT_METRIC_RULES.map((r) => r.key) as [
  string,
  ...string[],
];

export function localContentRule(metric: string): LocalContentMetricRule | null {
  return LOCAL_CONTENT_METRIC_RULES.find((r) => r.key === metric) ?? null;
}
