import type { SignalSeverity } from "@constructos/shared";

/**
 * Pure integrity detectors (spec Vol II Domain A, selected: #37 approval
 * velocity, #40 segregation of duties, #58 Benford analysis, #66
 * over-certification / contradicted claimant, plus duplicate-assertion and
 * round-number clustering heuristics).
 *
 * Every function is side-effect free: it receives plain rows and returns
 * Signal drafts. The API layer owns persistence and ledgering, so these can
 * be unit-tested against fabricated data without a database.
 */

export interface SignalDraft {
  detector: string;
  severity: SignalSeverity;
  confidence: number;
  title: string;
  explanation: string;
  evidenceRefs: unknown;
  /**
   * Deterministic identity of the FINDING — the same condition observed twice
   * must produce the same fingerprint, and two different conditions from the
   * same detector must not. Without it every re-run manufactures a duplicate
   * signal, which is the false-positive fatigue Vol III §6 warns about and
   * which silently corrupts every precision figure computed from the register.
   *
   * Convention: `<what it is about>` in stable, sorted form. The persistence
   * layer prefixes the detector name, so a fingerprint need only be unique
   * within its own detector.
   */
  fingerprint: string;
  /** the object the finding is ABOUT, for scoring and deep links */
  subjectType?: string;
  subjectId?: string;
  /** typed links written to `signal_evidence` */
  links?: Array<{ objectType: string; objectId: string; role?: string }>;
}

/** Sort + join, so a fingerprint never depends on row order. */
export function fingerprintOf(...parts: Array<string | number | null | undefined>): string {
  return parts
    .filter((p): p is string | number => p !== null && p !== undefined && p !== "")
    .map(String)
    .join("|");
}

/** Ids in a stable order — the usual fingerprint ingredient. */
export function sortedIds(ids: string[]): string {
  return [...new Set(ids)].sort().join(",");
}

/* ------------------------------------------------------------------ */
/* benford_first_digit (spec A#58)                                     */
/* ------------------------------------------------------------------ */

/** Benford expected probability for first digit d (1..9). */
export function benfordExpected(d: number): number {
  return Math.log10(1 + 1 / d);
}

/** First significant digit of a value, or null when it has none. */
export function firstSignificantDigit(value: number): number | null {
  if (!Number.isFinite(value) || value === 0) return null;
  const s = Math.abs(value).toExponential(); // "d.ddde±x"
  const digit = Number(s[0]);
  return digit >= 1 && digit <= 9 ? digit : null;
}

export interface BenfordResult {
  /** true when the sample was too small to test (n < 30) */
  skipped: boolean;
  n: number;
  chiSquare: number;
  /** observed counts for digits 1..9 (index 0 = digit 1) */
  histogram: number[];
  draft: SignalDraft | null;
}

/**
 * Chi-square test of the first-digit distribution against Benford's Law.
 * Fires medium at chi-square > 20, high at > 30. Requires n >= 30.
 */
export function benfordFirstDigit(values: number[]): BenfordResult {
  const histogram = new Array<number>(9).fill(0);
  let n = 0;
  for (const v of values) {
    const d = firstSignificantDigit(v);
    if (d !== null) {
      histogram[d - 1]! += 1;
      n += 1;
    }
  }
  if (n < 30) {
    return { skipped: true, n, chiSquare: 0, histogram, draft: null };
  }
  let chiSquare = 0;
  for (let d = 1; d <= 9; d++) {
    const expected = n * benfordExpected(d);
    const observed = histogram[d - 1]!;
    chiSquare += ((observed - expected) ** 2) / expected;
  }
  let severity: SignalSeverity | null = null;
  if (chiSquare > 30) severity = "high";
  else if (chiSquare > 20) severity = "medium";

  const draft: SignalDraft | null = severity
    ? {
        detector: "benford_first_digit",
        severity,
        confidence: Math.min(0.99, chiSquare / 40),
        title: "First-digit distribution deviates from Benford's Law",
        explanation:
          `Chi-square ${chiSquare.toFixed(2)} over ${n} cost/quantity assertion values ` +
          `(threshold: >20 medium, >30 high). Digit histogram 1..9: [${histogram.join(", ")}]. ` +
          `Fabricated or manipulated value populations tend to flatten the first-digit curve.`,
        evidenceRefs: { chiSquare, n, histogram },
        // The population, not the moment: re-running over the same n values
        // is the same finding. n changes when the population does.
        fingerprint: fingerprintOf("n", n, "bucket", Math.round(chiSquare / 5) * 5),
        subjectType: "assertion_population",
        subjectId: `n=${n}`,
      }
    : null;
  return { skipped: false, n, chiSquare, histogram, draft };
}

/* ------------------------------------------------------------------ */
/* duplicate_assertions                                                */
/* ------------------------------------------------------------------ */

export interface AssertionRow {
  id: string;
  kind: string;
  value: number | null;
  unit: string | null;
  claimantId: string;
  assertedAt: string;
}

const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000;

/**
 * Same claimant asserting the same kind+value+unit more than once within a
 * 30-day window — classic double-claim / re-submission pattern.
 */
export function duplicateAssertions(rows: AssertionRow[]): SignalDraft[] {
  const groups = new Map<string, AssertionRow[]>();
  for (const row of rows) {
    if (row.value === null || row.value === undefined) continue;
    const key = `${row.claimantId}|${row.kind}|${row.value}|${row.unit ?? ""}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const drafts: SignalDraft[] = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort(
      (a, b) => new Date(a.assertedAt).getTime() - new Date(b.assertedAt).getTime(),
    );
    const clustered: AssertionRow[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const gap =
        new Date(sorted[i]!.assertedAt).getTime() - new Date(sorted[i - 1]!.assertedAt).getTime();
      if (gap <= THIRTY_DAYS_MS) {
        if (!clustered.includes(sorted[i - 1]!)) clustered.push(sorted[i - 1]!);
        clustered.push(sorted[i]!);
      }
    }
    if (clustered.length < 2) continue;
    const first = clustered[0]!;
    drafts.push({
      detector: "duplicate_assertions",
      severity: "medium",
      confidence: 0.6,
      title: `Duplicate ${first.kind} assertion (${first.value} ${first.unit ?? ""})`.trim(),
      explanation:
        `Claimant ${first.claimantId} asserted ${first.kind} = ${first.value}` +
        `${first.unit ? " " + first.unit : ""} ${clustered.length} times within 30 days ` +
        `(${clustered.map((r) => r.id).join(", ")}). Possible double claim.`,
      evidenceRefs: { assertionIds: clustered.map((r) => r.id) },
      fingerprint: sortedIds(clustered.map((r) => r.id)),
      subjectType: "user",
      subjectId: first.claimantId,
      links: clustered.map((r) => ({ objectType: "assertion", objectId: r.id })),
    });
  }
  return drafts;
}

/* ------------------------------------------------------------------ */
/* round_number_clustering                                             */
/* ------------------------------------------------------------------ */

/**
 * Estimated / invented figures cluster on round numbers. Fires medium when
 * more than 40% of values are divisible by 1000 (or by 100 for sets smaller
 * than 30) with at least 10 usable values.
 */
export function roundNumberClustering(values: number[]): SignalDraft | null {
  const usable = values.filter((v) => Number.isFinite(v) && v !== 0);
  if (usable.length < 10) return null;
  const divisor = usable.length >= 30 ? 1000 : 100;
  const round = usable.filter((v) => v % divisor === 0);
  const share = round.length / usable.length;
  if (share <= 0.4) return null;
  return {
    detector: "round_number_clustering",
    severity: "medium",
    confidence: 0.5,
    title: "Assertion values cluster on round numbers",
    explanation:
      `${round.length} of ${usable.length} values (${(share * 100).toFixed(1)}%) are divisible ` +
      `by ${divisor}. Genuine measured quantities rarely round this cleanly; estimated or ` +
      `fabricated figures do.`,
    evidenceRefs: { share, divisor, roundCount: round.length, n: usable.length },
    fingerprint: fingerprintOf("n", usable.length, "divisor", divisor, "round", round.length),
    subjectType: "assertion_population",
    subjectId: `n=${usable.length}`,
  };
}

/* ------------------------------------------------------------------ */
/* approval_velocity (spec A#37)                                       */
/* ------------------------------------------------------------------ */

export interface StepRow {
  id: string;
  instanceId: string;
  assigneeId: string;
  delegatedToId: string | null;
  decision: string;
  createdAt: string;
  decidedAt: string | null;
}

/**
 * Approvals decided in under 60 seconds cannot reflect genuine review.
 * Fires high per assignee with >= 3 such approvals.
 */
export function approvalVelocity(steps: StepRow[]): SignalDraft[] {
  const fastByAssignee = new Map<string, StepRow[]>();
  for (const s of steps) {
    if (s.decision !== "approved" || !s.decidedAt) continue;
    const elapsedMs = new Date(s.decidedAt).getTime() - new Date(s.createdAt).getTime();
    if (elapsedMs >= 60_000) continue;
    const list = fastByAssignee.get(s.assigneeId) ?? [];
    list.push(s);
    fastByAssignee.set(s.assigneeId, list);
  }
  const drafts: SignalDraft[] = [];
  for (const [assigneeId, fast] of fastByAssignee) {
    if (fast.length < 3) continue;
    drafts.push({
      detector: "approval_velocity",
      severity: "high",
      confidence: 0.7,
      title: `Rubber-stamp approvals by ${assigneeId}`,
      explanation:
        `${fast.length} workflow steps were approved by ${assigneeId} less than 60 seconds ` +
        `after assignment (steps ${fast.map((s) => s.id).join(", ")}). Approval this fast is ` +
        `not compatible with substantive review (spec A#37).`,
      evidenceRefs: { assigneeId, stepIds: fast.map((s) => s.id) },
      fingerprint: fingerprintOf(assigneeId, sortedIds(fast.map((s) => s.id))),
      subjectType: "user",
      subjectId: assigneeId,
      links: fast.map((s) => ({ objectType: "workflow_step", objectId: s.id })),
    });
  }
  return drafts;
}

/* ------------------------------------------------------------------ */
/* segregation_of_duties (spec A#40)                                   */
/* ------------------------------------------------------------------ */

export interface InstanceRow {
  id: string;
  startedBy: string;
  recordType?: string;
  recordId?: string;
}

/**
 * The initiator of a workflow approved one of its own steps — the same actor
 * on both sides of a control.
 */
export function segregationOfDuties(
  instances: InstanceRow[],
  steps: StepRow[],
): SignalDraft[] {
  const byInstance = new Map<string, StepRow[]>();
  for (const s of steps) {
    const list = byInstance.get(s.instanceId) ?? [];
    list.push(s);
    byInstance.set(s.instanceId, list);
  }
  const drafts: SignalDraft[] = [];
  for (const inst of instances) {
    const own = (byInstance.get(inst.id) ?? []).filter(
      (s) =>
        s.decision === "approved" &&
        (s.assigneeId === inst.startedBy || s.delegatedToId === inst.startedBy),
    );
    if (own.length === 0) continue;
    drafts.push({
      detector: "segregation_of_duties",
      severity: "high",
      confidence: 0.9,
      title: `Initiator approved own workflow ${inst.id}`,
      explanation:
        `User ${inst.startedBy} started workflow ${inst.id}` +
        `${inst.recordType ? ` (${inst.recordType} ${inst.recordId ?? ""})`.trimEnd() : ""} ` +
        `and also approved ${own.length} of its steps (${own.map((s) => s.id).join(", ")}). ` +
        `Segregation of duties violated (spec A#40).`,
      evidenceRefs: { instanceId: inst.id, startedBy: inst.startedBy, stepIds: own.map((s) => s.id) },
      fingerprint: fingerprintOf(inst.id, sortedIds(own.map((s) => s.id))),
      subjectType: "user",
      subjectId: inst.startedBy,
      links: [
        { objectType: "workflow_instance", objectId: inst.id, role: "subject" },
        ...own.map((s) => ({ objectType: "workflow_step", objectId: s.id })),
      ],
    });
  }
  return drafts;
}

/* ------------------------------------------------------------------ */
/* contradicted_claimant (spec A#66)                                   */
/* ------------------------------------------------------------------ */

export interface ClaimantReconciliationRow {
  reconciliationId: string;
  claimantId: string;
  result: string;
}

/**
 * A claimant whose assertions have been contradicted by evidence two or more
 * times — an over-certification / systematic misstatement signal.
 */
export function contradictedClaimant(rows: ClaimantReconciliationRow[]): SignalDraft[] {
  const byClaimant = new Map<string, ClaimantReconciliationRow[]>();
  for (const r of rows) {
    if (r.result !== "contradicted") continue;
    const list = byClaimant.get(r.claimantId) ?? [];
    list.push(r);
    byClaimant.set(r.claimantId, list);
  }
  const drafts: SignalDraft[] = [];
  for (const [claimantId, list] of byClaimant) {
    if (list.length < 2) continue;
    drafts.push({
      detector: "contradicted_claimant",
      severity: "high",
      confidence: 0.8,
      title: `Repeatedly contradicted claimant ${claimantId}`,
      explanation:
        `${list.length} reconciliations contradicted assertions made by ${claimantId} ` +
        `(${list.map((r) => r.reconciliationId).join(", ")}). A pattern of contradicted ` +
        `claims indicates over-certification (spec A#66).`,
      evidenceRefs: { claimantId, reconciliationIds: list.map((r) => r.reconciliationId) },
      fingerprint: fingerprintOf(claimantId, sortedIds(list.map((r) => r.reconciliationId))),
      subjectType: "user",
      subjectId: claimantId,
      links: list.map((r) => ({ objectType: "reconciliation", objectId: r.reconciliationId })),
    });
  }
  return drafts;
}

export const DETECTOR_NAMES = [
  "benford_first_digit",
  "duplicate_assertions",
  "round_number_clustering",
  "approval_velocity",
  "segregation_of_duties",
  "contradicted_claimant",
] as const;
export type DetectorName = (typeof DETECTOR_NAMES)[number];
