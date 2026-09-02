/**
 * The typed reconciliation library (spec Vol II Domain A #65-71, Vol III §4).
 *
 * WHAT CHANGED AND WHY. The first implementation had one reconciler: take the
 * arithmetic mean of every `metadata.value` on every attached evidence row and
 * compare it to the claim. Three things are wrong with that, and each one is
 * exploitable:
 *
 *   1. It accepts ANY evidence kind for ANY claim. A progress percentage could
 *      be "supported" by a bank transaction; a headcount by a photograph.
 *   2. It lets the claimant choose which evidence is tested. Attach the one
 *      favourable survey and the claim is supported, whatever the other four
 *      rows say — so the auto-reconcile pass here runs every reconciler over
 *      every unreconciled assertion, using every eligible evidence row in the
 *      project rather than a hand-picked list.
 *   3. It ignores WHO produced the evidence and WHEN. Evidence captured
 *      outside the claim window, or captured by the claimant, is not
 *      independent testimony — it is the claim restated.
 *
 * Each reconciler therefore declares the assertion kind it tests, the evidence
 * kinds it will accept, how it aggregates them, and the metadata field it
 * reads. Evidence is weighted by independence and by capture proximity, and
 * every rejected row is reported with the reason it was rejected — a
 * reconciliation that silently drops inconvenient evidence is worse than none.
 *
 * PURE: no database, no clock. `now` and the policy are always passed in.
 */
import type { ReconciliationResult } from "@constructos/shared";
import type { ReconcilerKind } from "@constructos/shared";

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

export interface AssertionLike {
  id: string;
  kind: string;
  value: number | null;
  unit: string | null;
  claimantId: string;
  claimantKind: string;
  createdBy: string | null;
  assertedAt: string;
  /** claim window, when the assertion carries one (period_start/period_end) */
  periodStart?: string | null;
  periodEnd?: string | null;
}

export interface EvidenceLike {
  id: string;
  kind: string;
  source: string;
  capturedAt: string | null;
  ingestedAt: string;
  independenceScore: number;
  metadata: Record<string, unknown>;
  submittedBy: string;
}

export interface TolerancePolicy {
  supportedWithinPercent: number;
  partialWithinPercent: number;
  minIndependence: number;
  maxCaptureGapDays: number | null;
}

export const DEFAULT_TOLERANCE: TolerancePolicy = {
  supportedWithinPercent: 5,
  partialWithinPercent: 15,
  minIndependence: 0,
  maxCaptureGapDays: null,
};

/* ------------------------------------------------------------------ */
/* Independence scoring rules                                          */
/* ------------------------------------------------------------------ */

/**
 * How independent a source is of the population that benefits from the claim,
 * BEFORE the identity of the submitter is considered. These are defaults for
 * evidence ingested without a score; an explicitly supplied
 * `independenceScore` always wins, because the ingesting integration knows
 * more than a table of kinds does.
 */
export const INDEPENDENCE_BY_KIND: Record<string, number> = {
  bank_transaction: 0.95,
  corporate_registry: 0.95,
  telematics: 0.9,
  biometric_log: 0.9,
  access_control_log: 0.9,
  sensor_reading: 0.85,
  reality_capture: 0.85,
  survey: 0.8,
  inspection: 0.7,
  delivery_note: 0.6,
  video: 0.45,
  photograph: 0.4,
  document: 0.3,
  other: 0.2,
};

/**
 * The effective independence of one evidence row for one assertion.
 *
 * The identity rule is the sharp one: evidence submitted by the claimant, or
 * by the person who authored the assertion, scores ZERO however good the
 * instrument was. That is the Vol III §4 design rule expressed as a number
 * rather than as a veto, so a reconciliation built only from such rows comes
 * out with no confidence rather than with false confidence.
 */
export function effectiveIndependence(
  evidence: EvidenceLike,
  assertion: Pick<AssertionLike, "claimantId" | "claimantKind" | "createdBy">,
): { score: number; reason: string } {
  const base =
    Number.isFinite(evidence.independenceScore) && evidence.independenceScore > 0
      ? evidence.independenceScore
      : (INDEPENDENCE_BY_KIND[evidence.kind] ?? 0.2);
  if (assertion.claimantKind === "user" && evidence.submittedBy === assertion.claimantId) {
    return { score: 0, reason: "submitted by the claimant — not independent testimony" };
  }
  if (assertion.createdBy && evidence.submittedBy === assertion.createdBy) {
    return {
      score: 0,
      reason: "submitted by the author of the assertion — same actor on both sides",
    };
  }
  return { score: base, reason: `independence ${base.toFixed(2)} for kind "${evidence.kind}"` };
}

/* ------------------------------------------------------------------ */
/* The reconciler table                                                */
/* ------------------------------------------------------------------ */

type Aggregation = "sum" | "mean" | "max";

export interface Reconciler {
  kind: ReconcilerKind;
  /** assertion kinds this reconciler is competent to test */
  assertionKinds: string[];
  /** the only evidence kinds it will accept */
  evidenceKinds: string[];
  /** metadata fields searched, in order, for the observed number */
  fields: string[];
  aggregation: Aggregation;
  /** plain-English description of what it compares */
  description: string;
  /** which direction of variance is the adverse one for the claimant */
  adverse: "observed_below_claim" | "observed_above_claim";
}

export const RECONCILERS: Reconciler[] = [
  {
    kind: "progress_vs_capture",
    assertionKinds: ["progress_percent"],
    evidenceKinds: ["reality_capture", "survey", "photograph", "inspection", "video"],
    fields: ["observedPercent", "percentComplete", "value"],
    aggregation: "mean",
    description:
      "Claimed percentage complete against what independent capture of the same work observed " +
      "inside the claim window.",
    adverse: "observed_below_claim",
  },
  {
    kind: "quantity_vs_delivery",
    assertionKinds: ["quantity"],
    evidenceKinds: ["delivery_note", "survey", "inspection", "reality_capture"],
    fields: ["quantityInstalled", "quantityDelivered", "quantity", "value"],
    aggregation: "sum",
    description:
      "Claimed quantity against quantities evidenced by delivery notes and independent measure.",
    adverse: "observed_below_claim",
  },
  {
    kind: "headcount_vs_access",
    assertionKinds: ["headcount"],
    evidenceKinds: ["access_control_log", "biometric_log"],
    fields: ["distinctWorkers", "headcount", "value"],
    aggregation: "mean",
    description:
      "Claimed headcount against distinct workers recorded by the gate or biometric reader.",
    adverse: "observed_below_claim",
  },
  {
    kind: "hours_vs_telematics",
    assertionKinds: ["duration", "rate"],
    evidenceKinds: ["telematics", "sensor_reading"],
    fields: ["engineHours", "hours", "value"],
    aggregation: "sum",
    description: "Claimed plant hours against engine hours reported by the machine itself.",
    adverse: "observed_below_claim",
  },
  {
    kind: "cost_vs_bank",
    assertionKinds: ["cost", "entitlement"],
    evidenceKinds: ["bank_transaction", "document"],
    fields: ["amount", "value"],
    aggregation: "sum",
    description: "Claimed cost against money that actually left an account.",
    adverse: "observed_below_claim",
  },
  {
    kind: "numeric_mean",
    assertionKinds: [], // the fallback: competent for anything numeric
    evidenceKinds: [], // …and accepts any kind
    fields: ["value"],
    aggregation: "mean",
    description:
      "Generic numeric comparison: the mean of every numeric `value` on the attached evidence. " +
      "Used only when no typed reconciler applies.",
    adverse: "observed_below_claim",
  },
];

/** Reconcilers competent for an assertion kind, most specific first. */
export function reconcilersFor(assertionKind: string): Reconciler[] {
  const typed = RECONCILERS.filter((r) => r.assertionKinds.includes(assertionKind));
  const fallback = RECONCILERS.find((r) => r.kind === "numeric_mean")!;
  return [...typed, fallback];
}

/* ------------------------------------------------------------------ */
/* Running one reconciler                                              */
/* ------------------------------------------------------------------ */

export interface EvidenceUse {
  evidenceId: string;
  used: boolean;
  value: number | null;
  weight: number;
  independence: number;
  proximityFactor: number;
  reason: string;
}

export interface ReconcileOutcome {
  reconciler: ReconcilerKind;
  method: string;
  result: ReconciliationResult;
  claimed: number | null;
  observed: number | null;
  variance: number | null;
  variancePercent: number | null;
  confidence: number;
  usedEvidenceIds: string[];
  evidence: EvidenceUse[];
  basis: string;
  /** true when the adverse direction (over-claim) is the one observed */
  adverse: boolean;
  /** 0..1 — how many independent rows the verdict rests on (1 = three or more) */
  breadth: number;
  /** rows offered but not used, with the reason each was rejected */
  rejected: Array<{ evidenceId: string; reason: string }>;
}

function numberFrom(meta: Record<string, unknown>, fields: string[]): number | null {
  for (const f of fields) {
    const v = meta[f];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * How much a capture time outside the claim window discounts the evidence.
 * Inside the window (or when no window is stated) it counts fully; beyond it
 * the weight falls linearly to zero at `maxCaptureGapDays`, because a survey
 * taken three months after the period tells you about a different month.
 */
export function proximityFactor(
  evidence: EvidenceLike,
  assertion: AssertionLike,
  policy: TolerancePolicy,
): { factor: number; gapDays: number | null } {
  const maxGap = policy.maxCaptureGapDays;
  if (maxGap === null || maxGap <= 0) return { factor: 1, gapDays: null };
  const captured = parseMs(evidence.capturedAt ?? evidence.ingestedAt);
  if (captured === null) return { factor: 1, gapDays: null };
  const start = parseMs(assertion.periodStart) ?? parseMs(assertion.assertedAt);
  const end = parseMs(assertion.periodEnd) ?? parseMs(assertion.assertedAt);
  if (start === null || end === null) return { factor: 1, gapDays: null };
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  if (captured >= lo && captured <= hi) return { factor: 1, gapDays: 0 };
  const gapMs = captured < lo ? lo - captured : captured - hi;
  const gapDays = gapMs / 86_400_000;
  const factor = Math.max(0, 1 - gapDays / maxGap);
  return { factor, gapDays };
}

/**
 * Test one assertion against one pool of evidence with one reconciler.
 *
 * Returns `insufficient_evidence` rather than guessing whenever the claim has
 * no number, no eligible evidence survives the filters, or every surviving row
 * carries zero weight. "Not available, and here is why" is a permitted answer;
 * a fabricated one is not.
 */
export function runReconciler(
  reconciler: Reconciler,
  assertion: AssertionLike,
  pool: EvidenceLike[],
  policy: TolerancePolicy = DEFAULT_TOLERANCE,
): ReconcileOutcome {
  const uses: EvidenceUse[] = [];
  const accepted: Array<{ value: number; weight: number }> = [];

  for (const ev of pool) {
    const kindOk =
      reconciler.evidenceKinds.length === 0 || reconciler.evidenceKinds.includes(ev.kind);
    if (!kindOk) {
      uses.push({
        evidenceId: ev.id,
        used: false,
        value: null,
        weight: 0,
        independence: 0,
        proximityFactor: 0,
        reason: `evidence kind "${ev.kind}" is not accepted by the ${reconciler.kind} reconciler`,
      });
      continue;
    }
    const value = numberFrom(ev.metadata, reconciler.fields);
    const ind = effectiveIndependence(ev, assertion);
    const prox = proximityFactor(ev, assertion, policy);
    if (value === null) {
      uses.push({
        evidenceId: ev.id,
        used: false,
        value: null,
        weight: 0,
        independence: ind.score,
        proximityFactor: prox.factor,
        reason: `no numeric ${reconciler.fields.join("/")} on this evidence row`,
      });
      continue;
    }
    if (ind.score < policy.minIndependence) {
      uses.push({
        evidenceId: ev.id,
        used: false,
        value,
        weight: 0,
        independence: ind.score,
        proximityFactor: prox.factor,
        reason: `independence ${ind.score.toFixed(2)} below the project minimum ${policy.minIndependence.toFixed(2)} (${ind.reason})`,
      });
      continue;
    }
    if (prox.factor <= 0) {
      uses.push({
        evidenceId: ev.id,
        used: false,
        value,
        weight: 0,
        independence: ind.score,
        proximityFactor: 0,
        reason: `captured ${prox.gapDays?.toFixed(0) ?? "?"} days outside the claim window (limit ${policy.maxCaptureGapDays})`,
      });
      continue;
    }
    // Weight never goes to zero on independence alone: a self-submitted row
    // still moves the observed value, it just cannot carry the confidence.
    const weight = Math.max(0.05, ind.score) * prox.factor;
    accepted.push({ value, weight });
    uses.push({
      evidenceId: ev.id,
      used: true,
      value,
      weight,
      independence: ind.score,
      proximityFactor: prox.factor,
      reason: ind.reason,
    });
  }

  const usedIds = uses.filter((u) => u.used).map((u) => u.evidenceId);
  const claimed = assertion.value;

  if (accepted.length === 0 || claimed === null || claimed === undefined) {
    return {
      reconciler: reconciler.kind,
      method: reconciler.kind,
      result: "insufficient_evidence",
      claimed: claimed ?? null,
      observed: null,
      variance: null,
      variancePercent: null,
      confidence: 0,
      usedEvidenceIds: usedIds,
      evidence: uses,
      basis:
        claimed === null || claimed === undefined
          ? "The assertion carries no numeric value, so there is nothing to test it against."
          : `No evidence of an accepted kind (${reconciler.evidenceKinds.join(", ") || "any"}) ` +
            `carried a usable ${reconciler.fields.join("/")} value.`,
      adverse: false,
      breadth: 0,
      rejected: uses.filter((u) => !u.used).map((u) => ({ evidenceId: u.evidenceId, reason: u.reason })),
    };
  }

  const totalWeight = accepted.reduce((a, x) => a + x.weight, 0);
  let observed: number;
  if (reconciler.aggregation === "sum") {
    observed = accepted.reduce((a, x) => a + x.value, 0);
  } else if (reconciler.aggregation === "max") {
    observed = accepted.reduce((a, x) => Math.max(a, x.value), Number.NEGATIVE_INFINITY);
  } else {
    observed =
      totalWeight > 0
        ? accepted.reduce((a, x) => a + x.value * x.weight, 0) / totalWeight
        : accepted.reduce((a, x) => a + x.value, 0) / accepted.length;
  }

  const variance = observed - claimed;
  let variancePercent: number | null;
  let result: ReconciliationResult;
  if (claimed === 0) {
    variancePercent = variance === 0 ? 0 : null;
    result = variance === 0 ? "supported" : "contradicted";
  } else {
    variancePercent = (variance / claimed) * 100;
    const vp = Math.abs(variancePercent);
    result =
      vp <= policy.supportedWithinPercent
        ? "supported"
        : vp <= policy.partialWithinPercent
          ? "partially_supported"
          : "contradicted";
  }

  // Confidence is the weighted independence of what was actually used. It is
  // deliberately NOT scaled by the arithmetic: a variance of 0.1% computed
  // from evidence the claimant produced themselves deserves no confidence at
  // all, and that is exactly what a weighted independence of 0 gives it.
  // `breadth` is reported separately rather than folded in, so a reviewer can
  // see "0.9 independent, but from a single row" instead of one blended
  // number that hides which half is weak.
  const weightedIndependence =
    totalWeight > 0
      ? uses
          .filter((u) => u.used)
          .reduce((a, u) => a + u.independence * u.weight, 0) / totalWeight
      : 0;
  const breadth = Math.min(1, accepted.length / 3);
  const confidence = Math.max(0, Math.min(1, weightedIndependence));

  const adverse =
    reconciler.adverse === "observed_below_claim" ? variance < 0 : variance > 0;

  return {
    reconciler: reconciler.kind,
    method: reconciler.kind,
    result,
    claimed,
    observed,
    variance,
    variancePercent,
    confidence,
    usedEvidenceIds: usedIds,
    evidence: uses,
    basis:
      `${reconciler.description} Claimed ${claimed}${assertion.unit ? ` ${assertion.unit}` : ""}; ` +
      `${accepted.length} evidence row(s) of kind(s) ${[...new Set(uses.filter((u) => u.used).map((u) => u.evidenceId))].length > 0 ? reconciler.evidenceKinds.join("/") || "any" : "none"} ` +
      `${reconciler.aggregation === "sum" ? "sum" : reconciler.aggregation === "max" ? "max" : "weighted mean"} to ` +
      `${observed.toFixed(3)}. Variance ${variance.toFixed(3)}` +
      (variancePercent === null ? "" : ` (${variancePercent.toFixed(2)}%)`) +
      `. Bands: supported within ±${policy.supportedWithinPercent}%, partial within ` +
      `±${policy.partialWithinPercent}%.` +
      (adverse ? " The variance is in the adverse direction: the claim exceeds what was evidenced." : ""),
    adverse,
    breadth,
    rejected: uses.filter((u) => !u.used).map((u) => ({ evidenceId: u.evidenceId, reason: u.reason })),
  };
}

/**
 * Pick the reconciler that produces the most defensible answer for this
 * assertion: the first typed reconciler that reaches a real verdict, falling
 * back to the generic numeric comparison, and finally to the typed
 * reconciler's own "insufficient evidence" (which explains what was missing)
 * rather than the generic one's.
 */
export function autoReconcile(
  assertion: AssertionLike,
  pool: EvidenceLike[],
  policy: TolerancePolicy = DEFAULT_TOLERANCE,
): ReconcileOutcome {
  const candidates = reconcilersFor(assertion.kind);
  const outcomes = candidates.map((r) => runReconciler(r, assertion, pool, policy));
  const decisive = outcomes.find((o) => o.result !== "insufficient_evidence");
  return decisive ?? outcomes[0]!;
}
