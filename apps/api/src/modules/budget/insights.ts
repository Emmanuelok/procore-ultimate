/**
 * BUDGET INSIGHTS — earned value, forecast swing and anomaly detection, as
 * pure functions (spec #490–#493, #497; Vol II X anomaly explanation hooks).
 *
 * Everything here reads a line's stored cost report plus, optionally, the
 * schedule window its work sits in and the snapshots taken before now. It
 * never touches the database and never fabricates: a metric whose inputs are
 * absent comes back `null` with the reason, and every finding carries the
 * exact figures and the line/snapshot ids it was computed from, so the grid
 * can show "why" next to the flag and a reviewer can re-perform it.
 *
 * Earned value vocabulary (PMBOK, restated for a cost report):
 *   BAC  budget at completion         = revisedBudget
 *   PV   planned value                = BAC × planned % (time-phased)
 *   EV   earned value                 = BAC × percent complete
 *   AC   actual cost                  = jobToDateCosts
 *   CPI  cost performance index       = EV ÷ AC
 *   SPI  schedule performance index   = EV ÷ PV
 *   EAC  estimate at completion       = AC + (BAC − EV) ÷ CPI   (typical)
 *   VAC  variance at completion       = BAC − EAC
 *   TCPI to-complete performance idx  = (BAC − EV) ÷ (BAC − AC)
 */
import type { BudgetInsightKind, BudgetInsightSeverity } from "@constructos/shared";
import { round2, round4, type Component } from "./calc.js";

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

export interface InsightLine {
  id: string;
  costCode: string;
  costType: string;
  description: string;
  lineKind: string;
  status: string;
  wbsPath: string | null;
  originalBudget: number;
  budgetModifications: number;
  approvedChanges: number;
  revisedBudget: number;
  committedCost: number;
  pendingCommitments: number;
  directCosts: number;
  jobToDateCosts: number;
  forecastMethod: string;
  forecastToComplete: number;
  forecastFinal: number;
  projectedOverUnder: number;
  percentComplete: number;
}

/** A schedule window for the work on a line, when one can be matched. */
export interface ScheduleWindow {
  taskIds: string[];
  /** ISO dates */
  start: string | null;
  finish: string | null;
  /** cost-weighted or plain mean of the tasks' percent complete (0..100) */
  taskPercentComplete: number | null;
}

/** A prior capture's view of one line — for swings. */
export interface SnapshotPoint {
  snapshotId: string;
  reference: string;
  asOfDate: string;
  forecastFinal: number;
  jobToDateCosts: number;
  revisedBudget: number;
  percentComplete: number;
}

export interface InsightThresholds {
  /** CPI below this is flagged (default 0.9) */
  cpiFloor: number;
  /** SPI below this is flagged (default 0.85) */
  spiFloor: number;
  /** forecast movement as a share of revised budget, per period (default 0.05) */
  swingShare: number;
  /** consecutive periods of movement in one direction to flag (default 3) */
  swingRun: number;
  /** contingency burn ahead of progress by this many points flags (default 15) */
  contingencyLeadPoints: number;
  /** cost with zero progress above this share of revised budget flags (default 0.1) */
  costWithoutProgressShare: number;
}

export const DEFAULT_THRESHOLDS: InsightThresholds = {
  cpiFloor: 0.9,
  spiFloor: 0.85,
  swingShare: 0.05,
  swingRun: 3,
  contingencyLeadPoints: 15,
  costWithoutProgressShare: 0.1,
};

/* ------------------------------------------------------------------ */
/* Time phasing                                                        */
/* ------------------------------------------------------------------ */

const DAY = 86_400_000;

const parseIso = (d: string | null | undefined): number | null => {
  if (!d) return null;
  const ms = Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * The share of a window that has elapsed at `asOf`, clamped to [0, 1]. A
 * window with no dates, or a finish before its start, yields null.
 */
export function plannedFraction(
  start: string | null,
  finish: string | null,
  asOf: string,
): { value: number | null; reasons: string[] } {
  const s = parseIso(start);
  const f = parseIso(finish);
  const now = parseIso(asOf);
  if (s === null || f === null || now === null) {
    return { value: null, reasons: ["No schedule window is linked to this line, so planned value cannot be time-phased."] };
  }
  if (f < s) return { value: null, reasons: ["The linked schedule window finishes before it starts."] };
  if (now <= s) return { value: 0, reasons: [] };
  if (now >= f) return { value: 1, reasons: [] };
  const span = Math.max(1, Math.round((f - s) / DAY));
  const elapsed = Math.round((now - s) / DAY);
  return { value: round4(Math.min(1, Math.max(0, elapsed / span))), reasons: [] };
}

/* ------------------------------------------------------------------ */
/* Earned value                                                        */
/* ------------------------------------------------------------------ */

export interface EarnedValue {
  bac: number;
  pv: Component;
  ev: Component;
  ac: number;
  cpi: Component;
  spi: Component;
  tcpi: Component;
  /** EAC = AC + (BAC − EV) ÷ CPI — assumes current efficiency continues */
  eacCpi: Component;
  /** EAC = AC + (BAC − EV) — remaining work at budgeted rate */
  eacBudgeted: Component;
  /** EAC = AC + (BAC − EV) ÷ (CPI × SPI) — schedule-adjusted */
  eacComposite: Component;
  /** EAC = AC ÷ planned fraction — straight-line burn over the window */
  eacLinear: Component;
  /** the line's stored forecast, for comparison */
  storedForecastFinal: number;
  vac: Component;
  plannedFraction: number | null;
  reasons: string[];
}

const unavailable = (reasons: string[], inputs: Record<string, unknown> = {}): Component => ({
  value: null,
  inputs,
  reasons,
});
const computed = (value: number, inputs: Record<string, unknown> = {}): Component => ({
  value: round2(value),
  inputs,
  reasons: [],
});

export function earnedValue(
  line: InsightLine,
  window: ScheduleWindow | null,
  asOf: string,
): EarnedValue {
  const bac = line.revisedBudget;
  const ac = line.jobToDateCosts;
  const pc = Math.min(1, Math.max(0, line.percentComplete));
  const reasons: string[] = [];

  const ev: Component =
    bac <= 0
      ? unavailable(["No revised budget on this line — earned value needs a budget at completion."], { bac })
      : computed(bac * pc, { bac, percentComplete: pc });

  const pf = plannedFraction(window?.start ?? null, window?.finish ?? null, asOf);
  reasons.push(...pf.reasons);
  const pv: Component =
    pf.value === null
      ? unavailable(pf.reasons, { bac })
      : bac <= 0
        ? unavailable(["No revised budget on this line."], { bac })
        : computed(bac * pf.value, { bac, plannedFraction: pf.value, window: window?.taskIds ?? [] });

  const cpi: Component =
    ev.value === null
      ? unavailable(ev.reasons)
      : ac <= 0
        ? unavailable(["No cost has been incurred on this line, so CPI is undefined rather than infinite."], { ev: ev.value, ac })
        : { value: round4(ev.value / ac), inputs: { ev: ev.value, ac }, reasons: [] };

  const spi: Component =
    ev.value === null
      ? unavailable(ev.reasons)
      : pv.value === null
        ? unavailable(pv.reasons)
        : pv.value <= 0
          ? unavailable(["Planned value is zero at this date — the work has not been due to start."], { ev: ev.value, pv: pv.value })
          : { value: round4(ev.value / pv.value), inputs: { ev: ev.value, pv: pv.value }, reasons: [] };

  const remainingWork = ev.value === null ? null : round2(bac - ev.value);
  const eacBudgeted: Component =
    remainingWork === null ? unavailable(ev.reasons) : computed(ac + remainingWork, { ac, remainingWork });
  const eacCpi: Component =
    cpi.value === null || remainingWork === null
      ? unavailable(cpi.reasons.length > 0 ? cpi.reasons : ev.reasons)
      : computed(ac + remainingWork / cpi.value, { ac, remainingWork, cpi: cpi.value });
  const eacComposite: Component =
    cpi.value === null || spi.value === null || remainingWork === null
      ? unavailable([...(cpi.reasons ?? []), ...(spi.reasons ?? [])].filter((r, i, a) => a.indexOf(r) === i))
      : cpi.value * spi.value <= 0
        ? unavailable(["CPI × SPI is zero — the composite method cannot divide by it."])
        : computed(ac + remainingWork / (cpi.value * spi.value), { ac, remainingWork, cpi: cpi.value, spi: spi.value });
  const eacLinear: Component =
    pf.value === null
      ? unavailable(pf.reasons)
      : pf.value <= 0
        ? unavailable(["The schedule window has not started, so a linear burn cannot be extrapolated."])
        : ac <= 0
          ? unavailable(["No cost has been incurred, so there is no burn rate to extend."])
          : computed(ac / pf.value, { ac, plannedFraction: pf.value });

  const tcpi: Component =
    remainingWork === null
      ? unavailable(ev.reasons)
      : bac - ac <= 0
        ? unavailable(["The budget is fully spent — there is no remaining budget for a to-complete index to divide by."], { bac, ac })
        : { value: round4(remainingWork / (bac - ac)), inputs: { remainingWork, remainingBudget: round2(bac - ac) }, reasons: [] };

  const vac: Component =
    eacCpi.value === null ? unavailable(eacCpi.reasons) : computed(bac - eacCpi.value, { bac, eac: eacCpi.value });

  return {
    bac: round2(bac),
    pv,
    ev,
    ac: round2(ac),
    cpi,
    spi,
    tcpi,
    eacCpi,
    eacBudgeted,
    eacComposite,
    eacLinear,
    storedForecastFinal: line.forecastFinal,
    vac,
    plannedFraction: pf.value,
    reasons,
  };
}

/** Roll earned value up across lines: sums of the money figures, ratios re-derived. */
export function rollUpEarnedValue(rows: ReadonlyArray<{ line: InsightLine; ev: EarnedValue }>): {
  bac: number;
  ac: number;
  ev: Component;
  pv: Component;
  cpi: Component;
  spi: Component;
  eacCpi: Component;
  vac: Component;
  storedForecastFinal: number;
  linesWithPv: number;
  linesWithEv: number;
} {
  let bac = 0;
  let ac = 0;
  let evSum = 0;
  let evCount = 0;
  let pvSum = 0;
  let pvBac = 0;
  let pvCount = 0;
  let stored = 0;
  for (const { ev } of rows) {
    bac += ev.bac;
    ac += ev.ac;
    stored += ev.storedForecastFinal;
    if (ev.ev.value !== null) {
      evSum += ev.ev.value;
      evCount += 1;
    }
    if (ev.pv.value !== null) {
      pvSum += ev.pv.value;
      pvBac += ev.bac;
      pvCount += 1;
    }
  }
  const evC: Component =
    evCount === 0 ? unavailable(["No line carries a revised budget, so nothing has been earned."]) : computed(evSum, { lines: evCount });
  const pvC: Component =
    pvCount === 0
      ? unavailable(["No line is linked to a schedule window, so planned value cannot be time-phased for this budget."])
      : computed(pvSum, { lines: pvCount, bacCovered: round2(pvBac), bacTotal: round2(bac) });
  const cpi: Component =
    evC.value === null ? unavailable(evC.reasons) : ac <= 0 ? unavailable(["No cost incurred yet."]) : { value: round4(evC.value / ac), inputs: { ev: evC.value, ac: round2(ac) }, reasons: [] };
  // SPI compares like with like: only the lines that HAVE a planned value.
  const evOnPvLines = round2(rows.filter((r) => r.ev.pv.value !== null && r.ev.ev.value !== null).reduce((s, r) => s + (r.ev.ev.value as number), 0));
  const spi: Component =
    pvC.value === null
      ? unavailable(pvC.reasons)
      : pvC.value <= 0
        ? unavailable(["Planned value is zero at this date."])
        : { value: round4(evOnPvLines / pvC.value), inputs: { ev: evOnPvLines, pv: pvC.value }, reasons: [] };
  const eacCpi: Component =
    cpi.value === null || evC.value === null ? unavailable(cpi.reasons) : computed(ac + (bac - evC.value) / cpi.value, { ac: round2(ac), bac: round2(bac), ev: evC.value, cpi: cpi.value });
  const vac: Component = eacCpi.value === null ? unavailable(eacCpi.reasons) : computed(bac - eacCpi.value, { bac: round2(bac), eac: eacCpi.value });
  return {
    bac: round2(bac),
    ac: round2(ac),
    ev: evC,
    pv: pvC,
    cpi,
    spi,
    eacCpi,
    vac,
    storedForecastFinal: round2(stored),
    linesWithPv: pvCount,
    linesWithEv: evCount,
  };
}

/* ------------------------------------------------------------------ */
/* Forecast swing                                                      */
/* ------------------------------------------------------------------ */

export interface SwingPoint {
  snapshotId: string;
  reference: string;
  asOfDate: string;
  forecastFinal: number;
  delta: number;
  /** delta as a share of the revised budget at that capture */
  share: number | null;
}

export interface SwingAnalysis {
  points: SwingPoint[];
  /** consecutive most-recent movements in the same direction, above the share threshold */
  run: number;
  direction: "up" | "down" | "flat";
  /** total movement from the earliest capture to the line's current forecast */
  netMovement: number;
}

export function forecastSwing(
  current: { forecastFinal: number; revisedBudget: number },
  history: readonly SnapshotPoint[],
  thresholds: InsightThresholds = DEFAULT_THRESHOLDS,
): SwingAnalysis {
  const ordered = [...history].sort((a, b) =>
    a.asOfDate === b.asOfDate ? a.reference.localeCompare(b.reference) : a.asOfDate.localeCompare(b.asOfDate),
  );
  const points: SwingPoint[] = [];
  let prev: SnapshotPoint | null = null;
  for (const p of ordered) {
    const delta = prev ? round2(p.forecastFinal - prev.forecastFinal) : 0;
    points.push({
      snapshotId: p.snapshotId,
      reference: p.reference,
      asOfDate: p.asOfDate,
      forecastFinal: p.forecastFinal,
      delta,
      share: p.revisedBudget > 0 ? round4(delta / p.revisedBudget) : null,
    });
    prev = p;
  }
  // the movement since the latest capture to the live figure
  const last = ordered[ordered.length - 1];
  const liveDelta = last ? round2(current.forecastFinal - last.forecastFinal) : 0;
  const movements = [...points.slice(1).map((p) => ({ delta: p.delta, share: p.share })), ...(last ? [{ delta: liveDelta, share: current.revisedBudget > 0 ? round4(liveDelta / current.revisedBudget) : null }] : [])];
  let run = 0;
  let direction: SwingAnalysis["direction"] = "flat";
  for (let i = movements.length - 1; i >= 0; i -= 1) {
    const m = movements[i] as { delta: number; share: number | null };
    const significant = m.share !== null && Math.abs(m.share) >= thresholds.swingShare;
    if (!significant) break;
    const dir: SwingAnalysis["direction"] = m.delta > 0 ? "up" : "down";
    if (direction === "flat") direction = dir;
    if (dir !== direction) break;
    run += 1;
  }
  const first = ordered[0];
  return {
    points,
    run,
    direction,
    netMovement: first ? round2(current.forecastFinal - first.forecastFinal) : 0,
  };
}

/* ------------------------------------------------------------------ */
/* Anomalies                                                           */
/* ------------------------------------------------------------------ */

export interface InsightCitation {
  type: "budget_line_item" | "budget_snapshot" | "schedule_task";
  id: string;
  reference?: string;
}

export interface Finding {
  kind: BudgetInsightKind;
  severity: BudgetInsightSeverity;
  lineItemId: string | null;
  costCode: string | null;
  title: string;
  explanation: string;
  /** the figures the finding was computed from */
  inputs: Record<string, unknown>;
  citations: InsightCitation[];
}

const severityByShare = (share: number): BudgetInsightSeverity =>
  share >= 0.25 ? "critical" : share >= 0.1 ? "high" : share >= 0.03 ? "medium" : "low";

/**
 * Run every detector over one line. Each finding names its inputs and cites
 * the line (and snapshots where they were read), so "why is this flagged" is
 * answerable from the finding alone.
 */
export function detectLineAnomalies(
  line: InsightLine,
  ev: EarnedValue,
  swing: SwingAnalysis,
  thresholds: InsightThresholds = DEFAULT_THRESHOLDS,
): Finding[] {
  const out: Finding[] = [];
  const cite: InsightCitation[] = [{ type: "budget_line_item", id: line.id, reference: line.costCode }];
  const revised = line.revisedBudget;
  if (line.status === "void" || line.status === "closed") return out;

  if (revised > 0 && line.committedCost - revised > 0.005) {
    const over = round2(line.committedCost - revised);
    out.push({
      kind: "committed_exceeds_revised",
      severity: severityByShare(over / revised),
      lineItemId: line.id,
      costCode: line.costCode,
      title: `Committed ${formatShort(line.committedCost)} exceeds the revised budget of ${formatShort(revised)}`,
      explanation:
        `Approved commitments on ${line.costCode} / ${line.costType} total ${formatShort(line.committedCost)} against a revised budget of ${formatShort(revised)} — over-committed by ${formatShort(over)} before any direct cost. This line will overrun unless budget is moved to it or a commitment is reduced.`,
      inputs: { committedCost: line.committedCost, revisedBudget: revised, over },
      citations: cite,
    });
  }

  if (line.jobToDateCosts - line.forecastFinal > 0.005) {
    const over = round2(line.jobToDateCosts - line.forecastFinal);
    out.push({
      kind: "jtd_exceeds_forecast",
      severity: revised > 0 ? severityByShare(over / revised) : "high",
      lineItemId: line.id,
      costCode: line.costCode,
      title: `Cost to date ${formatShort(line.jobToDateCosts)} already exceeds the forecast at completion`,
      explanation:
        `Job-to-date cost is ${formatShort(line.jobToDateCosts)} but the stored forecast at completion is ${formatShort(line.forecastFinal)} (method ${line.forecastMethod}). A forecast below what has already been spent is stale — re-forecast the line.`,
      inputs: { jobToDateCosts: line.jobToDateCosts, forecastFinal: line.forecastFinal, forecastMethod: line.forecastMethod, over },
      citations: cite,
    });
  }

  if (line.lineKind === "allowance" && revised > 0 && line.jobToDateCosts - revised > 0.005) {
    const over = round2(line.jobToDateCosts - revised);
    out.push({
      kind: "allowance_exceeded",
      severity: severityByShare(over / revised),
      lineItemId: line.id,
      costCode: line.costCode,
      title: `Allowance ${line.costCode} exhausted — spent ${formatShort(line.jobToDateCosts)} of ${formatShort(revised)}`,
      explanation:
        `This allowance line has incurred ${formatShort(line.jobToDateCosts)} against an allowance of ${formatShort(revised)}: ${formatShort(over)} beyond the allowance is either a change to the owner or an unfunded overrun. Reconcile the allowance.`,
      inputs: { jobToDateCosts: line.jobToDateCosts, revisedBudget: revised, over },
      citations: cite,
    });
  }

  if (
    line.lineKind !== "contingency" &&
    revised > 0 &&
    line.percentComplete <= 0 &&
    line.jobToDateCosts / revised >= thresholds.costWithoutProgressShare
  ) {
    out.push({
      kind: "cost_without_progress",
      severity: line.jobToDateCosts / revised >= 0.5 ? "high" : "medium",
      lineItemId: line.id,
      costCode: line.costCode,
      title: `${formatShort(line.jobToDateCosts)} spent on ${line.costCode} with no progress recorded`,
      explanation:
        `Job-to-date cost is ${round4((line.jobToDateCosts / revised) * 100)}% of the revised budget while percent complete is 0. Either progress has not been measured — in which case every percent-based forecast on this line is unusable — or cost is landing on the wrong line.`,
      inputs: { jobToDateCosts: line.jobToDateCosts, revisedBudget: revised, percentComplete: line.percentComplete },
      citations: cite,
    });
  }

  // A CPI of exactly zero means no progress has been recorded at all; that is
  // the cost_without_progress finding above, not a second finding here.
  if (ev.cpi.value !== null && ev.cpi.value > 0 && ev.cpi.value < thresholds.cpiFloor && line.jobToDateCosts > 0) {
    out.push({
      kind: "cpi_below_threshold",
      severity: ev.cpi.value < 0.75 ? "high" : "medium",
      lineItemId: line.id,
      costCode: line.costCode,
      title: `CPI ${ev.cpi.value.toFixed(2)} on ${line.costCode} — earning less than it spends`,
      explanation:
        `Earned value ${formatShort(ev.ev.value ?? 0)} against actual cost ${formatShort(ev.ac)} gives a cost performance index of ${ev.cpi.value.toFixed(2)} (floor ${thresholds.cpiFloor}). At this efficiency the estimate at completion is ${formatShort(ev.eacCpi.value ?? 0)} against a budget of ${formatShort(ev.bac)}.`,
      inputs: { cpi: ev.cpi.value, ev: ev.ev.value, ac: ev.ac, eac: ev.eacCpi.value, bac: ev.bac },
      citations: cite,
    });
  }

  if (ev.spi.value !== null && ev.spi.value < thresholds.spiFloor) {
    out.push({
      kind: "spi_below_threshold",
      severity: ev.spi.value < 0.7 ? "high" : "medium",
      lineItemId: line.id,
      costCode: line.costCode,
      title: `SPI ${ev.spi.value.toFixed(2)} on ${line.costCode} — behind the time-phased plan`,
      explanation:
        `Earned value ${formatShort(ev.ev.value ?? 0)} against planned value ${formatShort(ev.pv.value ?? 0)} at ${round4((ev.plannedFraction ?? 0) * 100)}% of the linked schedule window gives a schedule performance index of ${ev.spi.value.toFixed(2)} (floor ${thresholds.spiFloor}).`,
      inputs: { spi: ev.spi.value, ev: ev.ev.value, pv: ev.pv.value, plannedFraction: ev.plannedFraction },
      citations: cite,
    });
  }

  if (swing.run >= thresholds.swingRun) {
    out.push({
      kind: "forecast_swing",
      severity: swing.run >= thresholds.swingRun + 2 ? "high" : "medium",
      lineItemId: line.id,
      costCode: line.costCode,
      title: `Forecast on ${line.costCode} has moved ${swing.direction} ${swing.run} periods running`,
      explanation:
        `The forecast at completion moved more than ${round4(thresholds.swingShare * 100)}% of the revised budget in the same direction on ${swing.run} consecutive captures (net ${formatShort(swing.netMovement)} since the first). A forecast that drifts every period is not converging — review the method (${line.forecastMethod}) and its basis.`,
      inputs: { run: swing.run, direction: swing.direction, netMovement: swing.netMovement, points: swing.points },
      citations: [...cite, ...swing.points.map((p) => ({ type: "budget_snapshot" as const, id: p.snapshotId, reference: p.reference }))],
    });
  }

  return out;
}

/**
 * Contingency burn versus progress, over the whole budget: the share of
 * contingency drawn compared with the cost-weighted percent complete.
 */
export function detectContingencyBurn(
  lines: readonly InsightLine[],
  thresholds: InsightThresholds = DEFAULT_THRESHOLDS,
): { finding: Finding | null; drawnShare: number | null; progressShare: number | null; reasons: string[] } {
  const contingency = lines.filter((l) => l.lineKind === "contingency" && l.status !== "void");
  if (contingency.length === 0) {
    return { finding: null, drawnShare: null, progressShare: null, reasons: ["This budget carries no contingency line."] };
  }
  const original = contingency.reduce((s, l) => s + l.originalBudget + l.approvedChanges, 0);
  const drawn = contingency.reduce((s, l) => s + Math.max(0, -l.budgetModifications), 0);
  if (original <= 0) {
    return { finding: null, drawnShare: null, progressShare: null, reasons: ["The contingency lines carry no original budget to measure burn against."] };
  }
  const working = lines.filter((l) => l.lineKind !== "contingency" && l.status !== "void");
  const revised = working.reduce((s, l) => s + l.revisedBudget, 0);
  const progressShare = revised > 0 ? round4(working.reduce((s, l) => s + l.revisedBudget * Math.min(1, Math.max(0, l.percentComplete)), 0) / revised) : null;
  const drawnShare = round4(drawn / original);
  if (progressShare === null) {
    return { finding: null, drawnShare, progressShare, reasons: ["Working lines carry no revised budget, so progress cannot be weighted."] };
  }
  const lead = round4((drawnShare - progressShare) * 100);
  if (lead < thresholds.contingencyLeadPoints) {
    return { finding: null, drawnShare, progressShare, reasons: [] };
  }
  return {
    drawnShare,
    progressShare,
    reasons: [],
    finding: {
      kind: "contingency_burn",
      severity: lead >= 40 ? "critical" : lead >= 25 ? "high" : "medium",
      lineItemId: null,
      costCode: null,
      title: `Contingency ${round4(drawnShare * 100)}% drawn while the work is ${round4(progressShare * 100)}% complete`,
      explanation:
        `${formatShort(drawn)} of ${formatShort(original)} contingency has been drawn (${round4(drawnShare * 100)}%) against cost-weighted progress of ${round4(progressShare * 100)}% — burn leads progress by ${lead} points (threshold ${thresholds.contingencyLeadPoints}). At this rate contingency is exhausted before the work is.`,
      inputs: { drawn: round2(drawn), original: round2(original), drawnShare, progressShare, leadPoints: lead },
      citations: contingency.map((l) => ({ type: "budget_line_item" as const, id: l.id, reference: l.costCode })),
    },
  };
}

/** Cost drift from a reconciliation, as a finding, so it lands in the same feed. */
export function driftFinding(
  drift: ReadonlyArray<{ lineItemId: string; costCode: string; component: string; stored: number; rebuilt: number; delta: number }>,
  totalsRevised: number,
): Finding | null {
  if (drift.length === 0) return null;
  const amount = round2(drift.reduce((s, d) => s + Math.abs(d.delta), 0));
  const share = totalsRevised > 0 ? amount / totalsRevised : 1;
  return {
    kind: "cost_drift",
    severity: severityByShare(share),
    lineItemId: null,
    costCode: null,
    title: `${drift.length} stored cost figure(s) disagree with their source tables by ${formatShort(amount)}`,
    explanation:
      "The cost-side columns stored on the budget grid no longer match what the commitments and invoicing tools hold. The rows below name each line, the column and both figures; run a reconciliation to rebuild them.",
    inputs: { driftCount: drift.length, driftAmount: amount, rows: drift.slice(0, 50) },
    citations: [...new Set(drift.map((d) => d.lineItemId))].slice(0, 50).map((id) => ({ type: "budget_line_item" as const, id })),
  };
}

const SEVERITY_RANK: Record<BudgetInsightSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (a.costCode ?? "").localeCompare(b.costCode ?? ""));
}

function formatShort(n: number): string {
  const v = round2(n);
  const neg = v < 0;
  const fixed = Math.abs(v).toFixed(2);
  const dot = fixed.indexOf(".");
  return `${neg ? "-" : ""}${fixed.slice(0, dot).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fixed.slice(dot + 1)}`;
}
