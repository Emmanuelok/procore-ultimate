/**
 * Workforce rights engines — PURE, no I/O (spec Vol II Domain M / M17).
 *
 * Three independent calculations live here so they can be unit-tested
 * against hand-worked numbers without a database:
 *
 *  1. Age verification (#670) — the child-labour gate on worker enrolment.
 *  2. Ghost-worker / wage reconciliation (#669, #677) — payroll days claimed
 *     by the employer against the INDEPENDENT site-access evidence stream,
 *     plus a wage-versus-hours check against the agreed daily rate.
 *  3. Modern-slavery composite scoring at subcontractor level (#694).
 *
 * DOCUMENTED SIMPLIFICATIONS (so the model stays honest):
 * - A "day on site" is a distinct access DATE inside the period. Hours are
 *   captured but not used for the day count: a worker who swiped in for ten
 *   minutes counts as present. The reconciliation detects fabricated
 *   attendance, not short days.
 * - Payroll entries are aggregated per worker across every entry overlapping
 *   the period, even where an entry's own period only partly overlaps. That
 *   over-counts claimed days at period edges, so the 1.15 overclaim
 *   tolerance below is deliberately generous.
 * - The implied daily rate is grossPay / daysClaimed. Overtime premia,
 *   piece rates and allowances are not modelled, so #677 flags a rate that
 *   is materially BELOW the agreed rate and never one that is above it.
 * - Currency is carried through but never converted: mixed-currency payroll
 *   for one worker is summed as-is (the vendor-risk view is a ranking, not
 *   a financial statement).
 */

import type { LabourRiskIndicator } from "@constructos/shared";

const round2 = (n: number): number => Math.round(n * 100) / 100;

/* ------------------------------------------------------------------ */
/* Age verification (#670)                                             */
/* ------------------------------------------------------------------ */

/** ILO C138 general minimum; the platform's hard floor for site enrolment. */
export const MINIMUM_WORKING_AGE = 18;

/**
 * Whole years old on `onDate`. Returns null when either date is not a
 * parseable ISO calendar date. A future date of birth yields a negative
 * age, which `isUnderage` treats as underage rather than as valid.
 */
export function ageOnDate(dateOfBirth: string, onDate: string): number | null {
  const b = dateOfBirth.split("-").map(Number);
  const o = onDate.split("-").map(Number);
  if (b.length !== 3 || o.length !== 3) return null;
  const [by, bm, bd] = b as [number, number, number];
  const [oy, om, od] = o as [number, number, number];
  if (![by, bm, bd, oy, om, od].every((n) => Number.isFinite(n))) return null;
  let age = oy - by;
  if (om < bm || (om === bm && od < bd)) age -= 1;
  return age;
}

export function isUnderage(
  dateOfBirth: string,
  onDate: string,
  minimumAge: number = MINIMUM_WORKING_AGE,
): boolean {
  const age = ageOnDate(dateOfBirth, onDate);
  return age !== null && age < minimumAge;
}

/* ------------------------------------------------------------------ */
/* Ghost-worker & wage reconciliation (#669, #677)                     */
/* ------------------------------------------------------------------ */

/**
 * Claimed days may exceed evidenced days by 15% before the claim is treated
 * as an overclaim. The head-room absorbs period-edge effects and manual
 * gate-log gaps; beyond it the employer is billing for attendance that no
 * independent record supports.
 */
export const OVERCLAIM_TOLERANCE = 1.15;

/**
 * Pay may fall 5% below the agreed daily rate before it is treated as
 * underpayment — the band covers rounding, part-days and lawful minor
 * deductions without swallowing systematic wage theft.
 */
export const UNDERPAYMENT_TOLERANCE = 0.95;

export type ReconcileClassification = "ghost" | "overclaim" | "underpaid" | "ok";

export interface ReconcileWorkerInput {
  workerId: string;
  reference: string;
  fullName: string;
  vendorId: string | null;
  /** null when no rate was agreed on the worker record — #677 then abstains */
  agreedDailyRate: number | null;
  currency: string;
  /** Σ days claimed across payroll entries overlapping the period */
  daysClaimed: number;
  grossPay: number;
  netPay: number;
  /** count of DISTINCT site-access dates inside the period */
  accessDays: number;
  payrollEntries: number;
}

export interface WorkerReconciliation extends ReconcileWorkerInput {
  /** the single worst label, for the table: ghost > overclaim > underpaid > ok */
  classification: ReconcileClassification;
  /** conditions are evaluated independently — a worker can be both */
  isGhost: boolean;
  isOverclaim: boolean;
  isUnderpaid: boolean;
  /** claimed days with no matching access date (never negative) */
  unmatchedDays: number;
  /** daysClaimed / accessDays; null when nothing was evidenced */
  claimRatio: number | null;
  impliedDailyRate: number | null;
  /** money claimed against attendance that is not evidenced */
  valueAtRisk: number;
  /** money apparently owed TO the worker under the agreed rate */
  wageShortfall: number;
  reason: string;
}

export interface ReconciliationTotals {
  daysClaimed: number;
  accessDays: number;
  unmatchedDays: number;
  valueAtRisk: number;
  grossPay: number;
  wageShortfall: number;
}

export interface ReconciliationSummary {
  periodStart: string;
  periodEnd: string;
  workers: number;
  ghosts: number;
  overclaims: number;
  underpayments: number;
  totals: ReconciliationTotals;
  rows: WorkerReconciliation[];
}

/** Do two inclusive ISO date ranges intersect? (ISO dates sort as strings.) */
export function periodsOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean {
  return aStart <= bEnd && aEnd >= bStart;
}

/** Distinct, sorted access dates falling inside [from, to] inclusive. */
export function distinctAccessDays(dates: string[], from: string, to: string): string[] {
  const set = new Set<string>();
  for (const d of dates) if (d >= from && d <= to) set.add(d);
  return [...set].sort();
}

/**
 * Classify one worker's period. Conditions are evaluated independently and
 * the classification reports the worst of them, because a ghost worker and
 * an underpaid worker are different wrongs with different remedies:
 *
 * - ghost      — pay claimed with ZERO evidenced days on site (#669).
 * - overclaim  — claimed days exceed evidenced days by more than the
 *                tolerance (#669).
 * - underpaid  — implied daily rate materially below the agreed rate (#677).
 *                Not evaluated for ghosts: with no attendance at all the
 *                rate comparison is meaningless noise.
 */
export function reconcileWorker(input: ReconcileWorkerInput): WorkerReconciliation {
  const { daysClaimed, accessDays, grossPay, agreedDailyRate } = input;
  const impliedDailyRate = daysClaimed > 0 ? round2(grossPay / daysClaimed) : null;
  const claimRatio = accessDays > 0 ? round2(daysClaimed / accessDays) : null;
  const unmatchedDays = round2(Math.max(0, daysClaimed - accessDays));

  const isGhost = accessDays === 0 && daysClaimed > 0;
  const isOverclaim = !isGhost && daysClaimed > accessDays * OVERCLAIM_TOLERANCE;
  const isUnderpaid =
    !isGhost &&
    agreedDailyRate !== null &&
    agreedDailyRate > 0 &&
    impliedDailyRate !== null &&
    impliedDailyRate < agreedDailyRate * UNDERPAYMENT_TOLERANCE;

  const classification: ReconcileClassification = isGhost
    ? "ghost"
    : isOverclaim
      ? "overclaim"
      : isUnderpaid
        ? "underpaid"
        : "ok";

  const valueAtRisk = isGhost
    ? round2(grossPay)
    : isOverclaim && impliedDailyRate !== null
      ? round2(unmatchedDays * impliedDailyRate)
      : 0;
  const wageShortfall =
    isUnderpaid && agreedDailyRate !== null && impliedDailyRate !== null
      ? round2((agreedDailyRate - impliedDailyRate) * daysClaimed)
      : 0;

  const parts: string[] = [];
  if (isGhost) {
    parts.push(
      `${daysClaimed} day(s) and ${input.currency} ${round2(grossPay)} claimed with no site-access record at all`,
    );
  } else if (isOverclaim) {
    parts.push(
      `${daysClaimed} day(s) claimed against ${accessDays} evidenced day(s) — ${unmatchedDays} unmatched, ` +
        `${claimRatio}× the evidenced attendance (tolerance ${OVERCLAIM_TOLERANCE}×)`,
    );
  }
  if (isUnderpaid && agreedDailyRate !== null) {
    parts.push(
      `implied daily rate ${input.currency} ${impliedDailyRate} is below the agreed ` +
        `${input.currency} ${agreedDailyRate} (tolerance ${UNDERPAYMENT_TOLERANCE}×)`,
    );
  }
  if (parts.length === 0) {
    parts.push(
      `${daysClaimed} day(s) claimed against ${accessDays} evidenced day(s) — within tolerance`,
    );
  }

  return {
    ...input,
    classification,
    isGhost,
    isOverclaim,
    isUnderpaid,
    unmatchedDays,
    claimRatio,
    impliedDailyRate,
    valueAtRisk,
    wageShortfall,
    reason: parts.join("; "),
  };
}

/**
 * Reconcile a whole period. Counts are PER CONDITION, not per classification,
 * so a worker who is both overclaimed and underpaid appears in both counts
 * while the table shows the worst single label.
 */
export function reconcileWorkforce(
  inputs: ReconcileWorkerInput[],
  period: { periodStart: string; periodEnd: string },
): ReconciliationSummary {
  const rows = inputs.map(reconcileWorker);
  const totals: ReconciliationTotals = {
    daysClaimed: round2(rows.reduce((s, r) => s + r.daysClaimed, 0)),
    accessDays: rows.reduce((s, r) => s + r.accessDays, 0),
    unmatchedDays: round2(rows.reduce((s, r) => s + r.unmatchedDays, 0)),
    valueAtRisk: round2(rows.reduce((s, r) => s + r.valueAtRisk, 0)),
    grossPay: round2(rows.reduce((s, r) => s + r.grossPay, 0)),
    wageShortfall: round2(rows.reduce((s, r) => s + r.wageShortfall, 0)),
  };
  const severityRank: Record<ReconcileClassification, number> = {
    ghost: 0,
    overclaim: 1,
    underpaid: 2,
    ok: 3,
  };
  rows.sort(
    (a, b) =>
      severityRank[a.classification] - severityRank[b.classification] ||
      b.valueAtRisk - a.valueAtRisk ||
      b.wageShortfall - a.wageShortfall ||
      a.reference.localeCompare(b.reference),
  );
  return {
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    workers: rows.length,
    ghosts: rows.filter((r) => r.isGhost).length,
    overclaims: rows.filter((r) => r.isOverclaim).length,
    underpayments: rows.filter((r) => r.isUnderpaid).length,
    totals,
    rows,
  };
}

/* ------------------------------------------------------------------ */
/* Modern-slavery composite scoring (#694)                             */
/* ------------------------------------------------------------------ */

/**
 * Indicators that on their own evidence forced labour under the ILO
 * framework rather than merely poor practice — these drive a `high`
 * signal severity and carry double weight in the composite score.
 */
export const CRITICAL_LABOUR_INDICATORS: readonly LabourRiskIndicator[] = [
  "passport_retained",
  "debt_bondage",
  "underage",
  "movement_restricted",
];

export function indicatorSeverity(indicator: string): "high" | "medium" {
  return (CRITICAL_LABOUR_INDICATORS as readonly string[]).includes(indicator)
    ? "high"
    : "medium";
}

/**
 * Composite weighting — 100 points of exposure, worst-first. The bands are
 * the author's own calibration, not a published standard; every component is
 * returned alongside the score so a reviewer can see how it was reached.
 *
 *   open risk flags        45 pts  — 12 per critical indicator, 6 per other
 *   reconciliation signals 25 pts  — 6 per ghost worker, 3 per overclaim
 *   contract coverage      18 pts  — (1 − contract-issued %) × 18  (#674)
 *   identity verification  12 pts  — (1 − id-verified %) × 12      (#667)
 *
 * A vendor with no workers on the project scores 0: there is nothing yet to
 * be exposed to, and an empty denominator must not manufacture risk.
 */
export const VENDOR_RISK_WEIGHTS = {
  flagCritical: 12,
  flagOther: 6,
  flagCap: 45,
  ghostSignal: 6,
  overclaimSignal: 3,
  reconciliationCap: 25,
  contractMax: 18,
  identityMax: 12,
} as const;

export type RiskBand = "low" | "medium" | "high" | "critical";

export interface VendorRiskInput {
  vendorId: string | null;
  vendorName: string;
  workers: number;
  contractIssued: number;
  idVerified: number;
  /** indicators of the OPEN flags attributable to this vendor */
  openFlagIndicators: string[];
  ghostSignals: number;
  overclaimSignals: number;
}

export interface VendorRiskResult extends VendorRiskInput {
  openFlags: number;
  flagsByIndicator: Record<string, number>;
  contractIssuedPct: number;
  idVerifiedPct: number;
  components: {
    flags: number;
    reconciliation: number;
    contracts: number;
    identity: number;
  };
  score: number;
  band: RiskBand;
}

export function riskBand(score: number): RiskBand {
  if (score >= 70) return "critical";
  if (score >= 45) return "high";
  if (score >= 20) return "medium";
  return "low";
}

export function scoreVendorRisk(input: VendorRiskInput): VendorRiskResult {
  const w = VENDOR_RISK_WEIGHTS;
  const flagsByIndicator: Record<string, number> = {};
  for (const ind of input.openFlagIndicators) {
    flagsByIndicator[ind] = (flagsByIndicator[ind] ?? 0) + 1;
  }
  const flagPoints = Math.min(
    w.flagCap,
    input.openFlagIndicators.reduce(
      (s, ind) => s + (indicatorSeverity(ind) === "high" ? w.flagCritical : w.flagOther),
      0,
    ),
  );
  const reconciliationPoints = Math.min(
    w.reconciliationCap,
    input.ghostSignals * w.ghostSignal + input.overclaimSignals * w.overclaimSignal,
  );
  const hasWorkers = input.workers > 0;
  const contractIssuedPct = hasWorkers ? round2(input.contractIssued / input.workers) : 1;
  const idVerifiedPct = hasWorkers ? round2(input.idVerified / input.workers) : 1;
  const contractPoints = hasWorkers ? round2((1 - contractIssuedPct) * w.contractMax) : 0;
  const identityPoints = hasWorkers ? round2((1 - idVerifiedPct) * w.identityMax) : 0;

  const score = hasWorkers
    ? Math.min(
        100,
        Math.round(flagPoints + reconciliationPoints + contractPoints + identityPoints),
      )
    : 0;

  return {
    ...input,
    openFlags: input.openFlagIndicators.length,
    flagsByIndicator,
    contractIssuedPct,
    idVerifiedPct,
    components: {
      flags: flagPoints,
      reconciliation: reconciliationPoints,
      contracts: contractPoints,
      identity: identityPoints,
    },
    score,
    band: riskBand(score),
  };
}

/** Worst-first ranking; ties broken by open flags, then by vendor name. */
export function rankVendorRisk(inputs: VendorRiskInput[]): VendorRiskResult[] {
  return inputs
    .map(scoreVendorRisk)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.openFlags - a.openFlags ||
        b.workers - a.workers ||
        a.vendorName.localeCompare(b.vendorName),
    );
}
