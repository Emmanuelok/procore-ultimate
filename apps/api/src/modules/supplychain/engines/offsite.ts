/**
 * OFFSITE PRODUCTION ENGINE (spec #922–928).
 *
 * A unit's progress is what its stages say, and what an inspector has
 * WITNESSED is a separate, smaller number that a valuation may rely on:
 *
 *  - `percentComplete`            stages complete ÷ stages total (self-reported)
 *  - `percentVerifiedForPayment`  the percent the MOST RECENT passed or
 *                                 conditional inspection witnessed (never the
 *                                 factory's, and never the highest ever seen:
 *                                 a later inspection corrects an earlier one)
 *  - a failed, un-waived QA gate puts the unit on `qa_hold`; nothing advances
 *    past it (readyToShip is false) until the gate passes or is waived
 *
 * Status transitions are a small, explicit machine; skipping QA is refused.
 */
import type { OffsiteUnitStatus } from "@constructos/shared";

export interface StageRow {
  id: string;
  position: number;
  status: string;
  isQaGate: boolean;
  qaResult: string;
  completedBy: string | null;
}

export interface UnitRollup {
  stagesTotal: number;
  stagesComplete: number;
  percentComplete: number;
  qaGatesTotal: number;
  qaGatesPassed: number;
  qaGatesFailed: number;
  qaGatesPending: number;
  /** every QA gate has passed or been waived, and every stage is complete */
  readyToShip: boolean;
  /** a completed QA-gate stage with a failed result and no waiver */
  onQaHold: boolean;
  reasons: string[];
}

export function rollupStages(stages: StageRow[]): UnitRollup {
  const total = stages.length;
  const complete = stages.filter((s) => s.status === "complete").length;
  const gates = stages.filter((s) => s.isQaGate);
  const passed = gates.filter((s) => s.qaResult === "passed" || s.qaResult === "waived").length;
  const failed = gates.filter((s) => s.qaResult === "failed").length;
  const pending = gates.filter((s) => s.status === "complete" && s.qaResult === "pending").length;
  const reasons: string[] = [];
  if (total === 0) reasons.push("No production stages defined yet.");
  if (failed > 0) reasons.push(`${failed} QA gate(s) failed and not waived.`);
  if (pending > 0) reasons.push(`${pending} completed QA gate(s) awaiting an independent verifier.`);
  const incomplete = total - complete;
  if (incomplete > 0 && total > 0) reasons.push(`${incomplete} stage(s) not complete.`);
  return {
    stagesTotal: total,
    stagesComplete: complete,
    percentComplete: total > 0 ? Math.round((complete / total) * 1000) / 10 : 0,
    qaGatesTotal: gates.length,
    qaGatesPassed: passed,
    qaGatesFailed: failed,
    qaGatesPending: pending,
    readyToShip: total > 0 && complete === total && failed === 0 && pending === 0,
    onQaHold: failed > 0,
    reasons,
  };
}

/** The status the unit should sit in given its rollup, unless it is further along the lifecycle already. */
export function derivedProductionStatus(current: string, rollup: UnitRollup): OffsiteUnitStatus {
  const downstream: ReadonlySet<string> = new Set(["ready_to_ship", "in_transit", "delivered", "installed", "rejected"]);
  if (downstream.has(current)) return current as OffsiteUnitStatus;
  if (rollup.onQaHold) return "qa_hold";
  if (rollup.readyToShip) return "passed_qa";
  if (rollup.stagesComplete > 0 || current === "in_production") return "in_production";
  return current === "in_design" ? "in_design" : "planned";
}

const TRANSITIONS: Record<OffsiteUnitStatus, readonly OffsiteUnitStatus[]> = {
  planned: ["in_design", "in_production", "rejected"],
  in_design: ["in_production", "rejected"],
  in_production: ["passed_qa", "rejected"],
  qa_hold: ["in_production", "passed_qa", "rejected"],
  passed_qa: ["ready_to_ship", "in_production", "rejected"],
  ready_to_ship: ["in_transit", "rejected"],
  in_transit: ["delivered", "rejected"],
  delivered: ["installed", "rejected"],
  installed: [],
  rejected: ["in_production"],
};

export function transitionAllowed(
  current: string,
  next: OffsiteUnitStatus,
  rollup: UnitRollup,
): { ok: boolean; reason?: string } {
  const allowed = TRANSITIONS[current as OffsiteUnitStatus];
  if (!allowed) return { ok: false, reason: `Unknown status ${current}.` };
  // `qa_hold` is DERIVED from a failed, un-waived QA gate. Setting it by hand
  // would be undone by the next rollup, so it is refused with the reason
  // rather than accepted and silently reverted.
  if (next === "qa_hold") {
    return {
      ok: false,
      reason: "A QA hold is not set by hand: record the failing QA gate on the stage and the unit goes on hold by itself.",
    };
  }
  if (!allowed.includes(next)) return { ok: false, reason: `A ${current.replace(/_/g, " ")} unit cannot go to ${next.replace(/_/g, " ")}.` };
  if ((next === "passed_qa" || next === "ready_to_ship") && !rollup.readyToShip) {
    return {
      ok: false,
      reason: `Not every stage is complete and QA-passed: ${rollup.reasons.join(" ")}`.trim(),
    };
  }
  return { ok: true };
}

/** One inspection as the engine reads it. */
export interface InspectionFact {
  id?: string | null;
  result: string;
  percentVerified: number | null;
  performedAt: string | null;
  createdAt?: string | null;
  inspectorId: string | null;
}

export interface VerifiedForPayment {
  percent: number | null;
  inspectionCount: number;
  /** The inspection the percent came from — who witnessed it and when. */
  source: { id: string | null; inspectorId: string | null; performedAt: string | null } | null;
  /** How many passed/conditional inspections carry a percent at all. */
  usableCount: number;
  reasons: string[];
}

/**
 * What a valuation may rely on: the percent the MOST RECENT passed or
 * conditional inspection witnessed. Never the factory's own number, and
 * deliberately never `max()` — an inspector who records 90 in error must be
 * correctable by a second inspector recording the true 40, and a maximum
 * would make the first figure permanent.
 */
export function verifiedForPayment(inspections: InspectionFact[]): VerifiedForPayment {
  const usable = inspections.filter(
    (i) => (i.result === "passed" || i.result === "conditional") && typeof i.percentVerified === "number",
  );
  if (usable.length === 0) {
    return {
      percent: null,
      inspectionCount: inspections.length,
      source: null,
      usableCount: 0,
      reasons: [
        inspections.length === 0
          ? "No factory inspection recorded; nothing has been independently verified."
          : "No passed or conditional inspection records a verified percent.",
      ],
    };
  }
  const latest = [...usable].sort((a, b) => {
    const byPerformed = (b.performedAt ?? "").localeCompare(a.performedAt ?? "");
    if (byPerformed !== 0) return byPerformed;
    return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
  })[0]!;
  const superseded = usable.filter((i) => i !== latest && (i.percentVerified as number) > (latest.percentVerified as number));
  return {
    percent: Math.min(100, Math.max(0, latest.percentVerified as number)),
    inspectionCount: inspections.length,
    source: { id: latest.id ?? null, inspectorId: latest.inspectorId, performedAt: latest.performedAt },
    usableCount: usable.length,
    reasons:
      superseded.length > 0
        ? [
            `The most recent inspection (${latest.performedAt ?? "undated"}) is the figure a valuation may use; ${superseded.length} earlier inspection(s) verified a higher percent and are superseded, not added.`,
          ]
        : [],
  };
}
