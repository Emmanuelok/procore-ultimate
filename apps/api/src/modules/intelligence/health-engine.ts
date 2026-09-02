/**
 * Project health engine — the pure, deterministic scorer (Vol I §6.1 #731–740,
 * §7 #776–781; Vol II X #1010).
 *
 * Ten dimensions, each scored 0..100 from a small set of metrics the
 * inputs loader (health-inputs.ts) reads out of the modules' own tables.
 * Every score carries a `basis` sentence and the raw `inputs`, because a
 * number nobody can trace is a number nobody will act on.
 *
 * Honesty rules baked in:
 *   • a dimension with NO records is `unrated` with a reason, never 100 or 0.
 *     An empty risk register is not a risk-free project.
 *   • the overall score is a weighted mean of RATED dimensions only, and a
 *     project with any dimension off track is never called on track.
 *   • nothing here reads the database or the clock — `asOf` is an input —
 *     so the same inputs always yield the same verdict.
 *
 * It deliberately does not predict (no probabilities of overrun — that is
 * the analytics module's job) and does not sum money across currencies.
 */
import { HEALTH_DIMENSIONS, type HealthDimensionKey, type HealthLevel } from "@constructos/shared";
import type { HealthDimension } from "./types.js";

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

export interface ScheduleInputs {
  scheduleName: string | null;
  /** forecast finish minus the project's contractual finish, days; null when either is unknown */
  slipDays: number | null;
  computedFinish: string | null;
  projectFinish: string | null;
  tasks: number;
  /** finish date in the past with work outstanding */
  overdueTasks: number;
  /** of those, on the critical path */
  criticalOverdue: number;
  /** milestones (0-day tasks) past their date without an actual finish */
  milestonesSlipped: number;
  percentComplete: number | null;
}

export interface CostInputs {
  budgetName: string | null;
  currency: string;
  revisedBudget: number;
  forecastFinal: number;
  /** revisedBudget − forecastFinal; negative = overrun */
  variance: number;
  pendingChanges: number;
  jobToDate: number;
}

export interface CommercialInputs {
  currency: string | null;
  commitments: number;
  committedTotal: number;
  pendingCommitments: number;
  openChangeEvents: number;
  /** latestCost summed over open change events */
  changeExposure: number;
  /** open change events older than 30 days */
  agedChangeEvents: number;
  /** the active budget's revised total in the same currency, when known */
  revisedBudget: number | null;
}

export interface AssuranceInputs {
  openSignals: { critical: number; high: number; medium: number; low: number; info: number };
  reconciliations: { total: number; contradicted: number; unsupported: number; insufficient: number };
}

export interface SafetyInputs {
  /** any safety record at all (incident, observation, inspection) */
  recordCount: number;
  incidents90d: number;
  fatalities: number;
  majorOrCatastrophic: number;
  serious: number;
  lostTime: number;
  openIncidents: number;
  openObservations: number;
  overdueActions: number;
}

export interface QualityInputs {
  ncrsOpen: { critical: number; major: number; minor: number };
  overdueNcrResponses: number;
  itpActivities: number;
  itpFailed: number;
  holdPointsPending: number;
}

export interface FieldInputs {
  rfisOpen: number;
  rfisOverdue: number;
  submittalsOpen: number;
  submittalsOverdue: number;
  punchOpen: number;
  punchOverdue: number;
}

export interface ContractInputs {
  events: number;
  timeBarred: number;
  deadlinesWithin7d: number;
  obligationsOpen: number;
  obligationsBreached: number;
  obligationsDue7d: number;
}

export interface RiskInputs {
  open: number;
  /** pre-mitigation probability × impact ≥ 15 */
  high: number;
  realised: number;
  mitigating: number;
}

export interface FinanceInputs {
  covenants: number;
  breached: number;
  /** covenants with no reading yet */
  unread: number;
  claimsDeemed: number;
  claimsSuspended: number;
  conditionsOverdue: number;
}

/** Every dimension's metrics, `null` when the module holds no records for the project. */
export interface HealthInputs {
  asOf: string;
  schedule: ScheduleInputs | null;
  cost: CostInputs | null;
  commercial: CommercialInputs | null;
  assurance: AssuranceInputs | null;
  safety: SafetyInputs | null;
  quality: QualityInputs | null;
  field: FieldInputs | null;
  contract: ContractInputs | null;
  risk: RiskInputs | null;
  finance: FinanceInputs | null;
  /** why a dimension is null, keyed by dimension */
  reasons: Partial<Record<HealthDimensionKey, string>>;
}

export interface HealthComputation {
  score: number | null;
  level: HealthLevel;
  ratedDimensions: number;
  dimensions: HealthDimension[];
  /** one sentence on the overall verdict */
  basis: string;
}

/* ------------------------------------------------------------------ */
/* Constants — the tunables, in one place                              */
/* ------------------------------------------------------------------ */

export const DIMENSION_WEIGHTS: Record<HealthDimensionKey, number> = {
  schedule: 1.5,
  cost: 1.5,
  commercial: 1,
  assurance: 1.25,
  safety: 1.25,
  quality: 1,
  field: 1,
  contract: 1,
  risk: 0.75,
  finance: 0.75,
};

export const ON_TRACK_MIN = 75;
export const WATCH_MIN = 50;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const round = (n: number) => Math.round(n);
const round1 = (n: number) => Math.round(n * 10) / 10;

export function levelForScore(score: number | null): HealthLevel {
  if (score === null || !Number.isFinite(score)) return "unrated";
  if (score >= ON_TRACK_MIN) return "on_track";
  if (score >= WATCH_MIN) return "watch";
  return "off_track";
}

function unrated(key: HealthDimensionKey, reason: string): HealthDimension {
  return { key, score: null, level: "unrated", basis: reason, inputs: {} };
}

function rated(
  key: HealthDimensionKey,
  score: number,
  basis: string,
  inputs: Record<string, unknown>,
): HealthDimension {
  const s = round(clamp(score));
  return { key, score: s, level: levelForScore(s), basis, inputs };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ------------------------------------------------------------------ */
/* Dimension scorers                                                   */
/* ------------------------------------------------------------------ */

export function scoreSchedule(i: ScheduleInputs | null, reason?: string): HealthDimension {
  if (!i) return unrated("schedule", reason ?? "No active schedule for this project.");
  if (i.tasks === 0) return unrated("schedule", "The active schedule has no tasks.");
  let penalty = 0;
  const notes: string[] = [];
  if (i.slipDays !== null) {
    if (i.slipDays > 0) {
      penalty += Math.min(60, i.slipDays * 2);
      notes.push(`forecast finish ${i.computedFinish} slips ${plural(i.slipDays, "day")} past the project finish ${i.projectFinish}`);
    } else {
      notes.push(`forecast finish ${i.computedFinish} is on or ahead of the project finish ${i.projectFinish}`);
    }
  } else {
    notes.push(
      i.projectFinish
        ? "no forecast finish yet — the schedule has not been computed"
        : "the project has no finish date, so slip cannot be measured",
    );
  }
  const overdueRatio = i.tasks > 0 ? i.overdueTasks / i.tasks : 0;
  penalty += 40 * overdueRatio;
  penalty += Math.min(20, i.criticalOverdue * 5);
  penalty += Math.min(15, i.milestonesSlipped * 5);
  notes.push(
    `${i.overdueTasks} of ${plural(i.tasks, "task")} past finish with work outstanding` +
      (i.criticalOverdue > 0 ? ` (${i.criticalOverdue} critical)` : "") +
      (i.milestonesSlipped > 0 ? `; ${plural(i.milestonesSlipped, "milestone")} slipped` : ""),
  );
  return rated("schedule", 100 - penalty, `${notes.join("; ")}.`, {
    scheduleName: i.scheduleName,
    slipDays: i.slipDays,
    computedFinish: i.computedFinish,
    projectFinish: i.projectFinish,
    tasks: i.tasks,
    overdueTasks: i.overdueTasks,
    criticalOverdue: i.criticalOverdue,
    milestonesSlipped: i.milestonesSlipped,
    percentComplete: i.percentComplete,
  });
}

export function scoreCost(i: CostInputs | null, reason?: string): HealthDimension {
  if (!i) return unrated("cost", reason ?? "No active budget for this project.");
  if (!(i.revisedBudget > 0)) {
    return unrated("cost", `The active budget${i.budgetName ? ` "${i.budgetName}"` : ""} has no revised total yet.`);
  }
  const variancePct = round1((i.variance / i.revisedBudget) * 100);
  let penalty = 0;
  const notes: string[] = [];
  if (variancePct < 0) {
    penalty += Math.min(100, Math.abs(variancePct) * 10);
    notes.push(`forecast final exceeds the revised budget by ${Math.abs(variancePct)}% (${i.currency})`);
  } else {
    notes.push(`forecast final is within the revised budget (${variancePct}% headroom, ${i.currency})`);
  }
  const pendingPct = round1((i.pendingChanges / i.revisedBudget) * 100);
  if (pendingPct > 0) {
    penalty += Math.min(20, pendingPct * 2);
    notes.push(`pending changes add ${pendingPct}% of exposure`);
  }
  return rated("cost", 100 - penalty, `${notes.join("; ")}.`, {
    budgetName: i.budgetName,
    currency: i.currency,
    revisedBudget: i.revisedBudget,
    forecastFinal: i.forecastFinal,
    variance: i.variance,
    variancePercent: variancePct,
    pendingChanges: i.pendingChanges,
    pendingChangesPercent: pendingPct,
    jobToDate: i.jobToDate,
  });
}

export function scoreCommercial(i: CommercialInputs | null, reason?: string): HealthDimension {
  if (!i) return unrated("commercial", reason ?? "No commitments or change events recorded.");
  if (i.commitments === 0 && i.openChangeEvents === 0) {
    return unrated("commercial", "No commitments or open change events recorded.");
  }
  let penalty = 0;
  const notes: string[] = [];
  let exposurePct: number | null = null;
  if (i.revisedBudget !== null && i.revisedBudget > 0) {
    exposurePct = round1((i.changeExposure / i.revisedBudget) * 100);
    penalty += Math.min(60, exposurePct * 6);
    notes.push(`open change exposure is ${exposurePct}% of the revised budget`);
    const pendingPct = (i.pendingCommitments / i.revisedBudget) * 100;
    penalty += Math.min(10, pendingPct);
  } else {
    penalty += Math.min(30, i.openChangeEvents * 3);
    notes.push(`${plural(i.openChangeEvents, "open change event")} (no budget to measure exposure against)`);
  }
  if (i.agedChangeEvents > 0) {
    penalty += Math.min(30, i.agedChangeEvents * 3);
    notes.push(`${plural(i.agedChangeEvents, "change event")} open for more than 30 days`);
  }
  if (notes.length === 1 && i.openChangeEvents === 0) notes.push("no open change events");
  return rated("commercial", 100 - penalty, `${notes.join("; ")}.`, {
    currency: i.currency,
    commitments: i.commitments,
    committedTotal: i.committedTotal,
    pendingCommitments: i.pendingCommitments,
    openChangeEvents: i.openChangeEvents,
    changeExposure: i.changeExposure,
    changeExposurePercent: exposurePct,
    agedChangeEvents: i.agedChangeEvents,
    revisedBudget: i.revisedBudget,
  });
}

export function scoreAssurance(i: AssuranceInputs | null, reason?: string): HealthDimension {
  if (!i) return unrated("assurance", reason ?? "No detector output or reconciliations recorded yet.");
  const s = i.openSignals;
  const r = i.reconciliations;
  const openTotal = s.critical + s.high + s.medium + s.low + s.info;
  if (openTotal === 0 && r.total === 0) {
    return unrated("assurance", "No detector output or reconciliations recorded yet.");
  }
  const signalPenalty = Math.min(100, s.critical * 25 + s.high * 12 + s.medium * 5 + s.low * 2);
  const reconPenalty = Math.min(40, r.contradicted * 15 + r.unsupported * 8 + r.insufficient * 3);
  const notes = [
    openTotal === 0
      ? "no open integrity signals"
      : `${plural(openTotal, "open integrity signal")} (${s.critical} critical, ${s.high} high, ${s.medium} medium)`,
    r.total === 0
      ? "no reconciliations yet"
      : `${r.contradicted + r.unsupported} of ${plural(r.total, "reconciliation")} contradicted or unsupported`,
  ];
  return rated("assurance", 100 - signalPenalty - reconPenalty, `${notes.join("; ")}.`, {
    openSignals: s,
    reconciliations: r,
  });
}

export function scoreSafety(i: SafetyInputs | null, reason?: string): HealthDimension {
  if (!i || i.recordCount === 0) return unrated("safety", reason ?? "No safety records for this project.");
  if (i.fatalities > 0) {
    return rated("safety", 0, `${plural(i.fatalities, "fatality", "fatalities")} recorded in the last 90 days.`, { ...i });
  }
  const penalty = Math.min(
    100,
    i.majorOrCatastrophic * 40 +
      i.serious * 15 +
      i.lostTime * 10 +
      i.openIncidents * 3 +
      i.overdueActions * 4 +
      i.openObservations * 1,
  );
  const notes = [
    i.incidents90d === 0
      ? "no incidents in the last 90 days"
      : `${plural(i.incidents90d, "incident")} in the last 90 days (${i.majorOrCatastrophic} major or worse, ${i.serious} serious, ${i.lostTime} lost-time)`,
    `${i.openIncidents} open, ${plural(i.overdueActions, "overdue corrective action")}, ${plural(i.openObservations, "open observation")}`,
  ];
  return rated("safety", 100 - penalty, `${notes.join("; ")}.`, { ...i });
}

export function scoreQuality(i: QualityInputs | null, reason?: string): HealthDimension {
  if (!i) return unrated("quality", reason ?? "No quality records for this project.");
  const n = i.ncrsOpen;
  const openNcrs = n.critical + n.major + n.minor;
  if (openNcrs === 0 && i.itpActivities === 0 && i.overdueNcrResponses === 0) {
    return unrated("quality", "No NCRs or inspection & test plan activities recorded.");
  }
  const penalty = Math.min(
    100,
    n.critical * 25 + n.major * 10 + n.minor * 3 + i.overdueNcrResponses * 5 + i.itpFailed * 10,
  );
  const notes = [
    openNcrs === 0
      ? "no open NCRs"
      : `${plural(openNcrs, "open NCR")} (${n.critical} critical, ${n.major} major)` +
        (i.overdueNcrResponses > 0 ? `, ${i.overdueNcrResponses} past response date` : ""),
    i.itpActivities === 0
      ? "no ITP activities"
      : `${i.itpFailed} of ${plural(i.itpActivities, "ITP activity", "ITP activities")} failed, ${i.holdPointsPending} hold points pending`,
  ];
  return rated("quality", 100 - penalty, `${notes.join("; ")}.`, { ...i });
}

export function scoreField(i: FieldInputs | null, reason?: string): HealthDimension {
  if (!i) return unrated("field", reason ?? "No RFIs, submittals or punch items recorded.");
  if (i.rfisOpen + i.submittalsOpen + i.punchOpen + i.rfisOverdue + i.submittalsOverdue + i.punchOverdue === 0) {
    return unrated("field", "No open RFIs, submittals or punch items.");
  }
  const penalty = Math.min(100, i.rfisOverdue * 6 + i.submittalsOverdue * 5 + i.punchOverdue * 1.5);
  const basis =
    `${i.rfisOverdue} of ${plural(i.rfisOpen, "open RFI")} overdue; ` +
    `${i.submittalsOverdue} of ${plural(i.submittalsOpen, "open submittal")} past submit-by; ` +
    `${i.punchOverdue} of ${plural(i.punchOpen, "open punch item")} overdue.`;
  return rated("field", 100 - penalty, basis, { ...i });
}

export function scoreContract(i: ContractInputs | null, reason?: string): HealthDimension {
  if (!i) return unrated("contract", reason ?? "No contract events or obligations recorded.");
  if (i.events === 0 && i.obligationsOpen === 0 && i.obligationsBreached === 0) {
    return unrated("contract", "No contract events or open obligations recorded.");
  }
  const penalty = Math.min(
    100,
    i.timeBarred * 25 + i.deadlinesWithin7d * 8 + i.obligationsBreached * 15 + i.obligationsDue7d * 4,
  );
  const basis =
    `${plural(i.timeBarred, "time-barred event")}, ${i.deadlinesWithin7d} notice deadlines within 7 days; ` +
    `${plural(i.obligationsBreached, "breached obligation")}, ${i.obligationsDue7d} due within 7 days of ${i.obligationsOpen} open.`;
  return rated("contract", 100 - penalty, basis, { ...i });
}

export function scoreRisk(i: RiskInputs | null, reason?: string): HealthDimension {
  if (!i) return unrated("risk", reason ?? "No risk register entries for this project.");
  if (i.open + i.realised + i.mitigating === 0) {
    return unrated("risk", "The risk register has no open, mitigating or realised risks.");
  }
  const penalty = Math.min(100, i.high * 10 + i.realised * 15);
  const basis = `${plural(i.open + i.mitigating, "live risk")}, ${i.high} scored high (P×I ≥ 15), ${plural(i.realised, "risk")} realised.`;
  return rated("risk", 100 - penalty, basis, { ...i });
}

export function scoreFinance(i: FinanceInputs | null, reason?: string): HealthDimension {
  if (!i) return unrated("finance", reason ?? "No funding facilities, covenants or payment claims recorded.");
  if (i.covenants + i.claimsDeemed + i.claimsSuspended + i.conditionsOverdue === 0) {
    return unrated("finance", "No covenants, overdue facility conditions or statutory payment claims recorded.");
  }
  const penalty = Math.min(
    100,
    i.breached * 40 + i.unread * 10 + i.claimsDeemed * 20 + i.claimsSuspended * 25 + i.conditionsOverdue * 8,
  );
  const basis =
    `${i.breached} of ${plural(i.covenants, "covenant")} breached at the latest reading (${i.unread} unread); ` +
    `${i.claimsDeemed} payment claims deemed, ${i.claimsSuspended} suspended; ${plural(i.conditionsOverdue, "overdue facility condition")}.`;
  return rated("finance", 100 - penalty, basis, { ...i });
}

/* ------------------------------------------------------------------ */
/* Overall                                                             */
/* ------------------------------------------------------------------ */

export function scoreHealth(inputs: HealthInputs): HealthComputation {
  const r = inputs.reasons;
  const dimensions: HealthDimension[] = [
    scoreSchedule(inputs.schedule, r.schedule),
    scoreCost(inputs.cost, r.cost),
    scoreCommercial(inputs.commercial, r.commercial),
    scoreAssurance(inputs.assurance, r.assurance),
    scoreSafety(inputs.safety, r.safety),
    scoreQuality(inputs.quality, r.quality),
    scoreField(inputs.field, r.field),
    scoreContract(inputs.contract, r.contract),
    scoreRisk(inputs.risk, r.risk),
    scoreFinance(inputs.finance, r.finance),
  ];
  // keep the declared order regardless of how the scorers were listed
  const order = new Map(HEALTH_DIMENSIONS.map((k, idx) => [k, idx] as const));
  dimensions.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));

  const ratedDims = dimensions.filter((d) => d.score !== null);
  if (ratedDims.length === 0) {
    return {
      score: null,
      level: "unrated",
      ratedDimensions: 0,
      dimensions,
      basis: "No dimension holds enough records to score; the platform will not invent a verdict.",
    };
  }
  let weightSum = 0;
  let acc = 0;
  for (const d of ratedDims) {
    const w = DIMENSION_WEIGHTS[d.key];
    weightSum += w;
    acc += w * (d.score ?? 0);
  }
  const score = round(acc / weightSum);
  let level = levelForScore(score);
  const offTrack = ratedDims.filter((d) => d.level === "off_track").map((d) => d.key);
  const watch = ratedDims.filter((d) => d.level === "watch").map((d) => d.key);
  let basis = `Weighted mean of ${plural(ratedDims.length, "rated dimension")} (${dimensions.length - ratedDims.length} unrated).`;
  if (level === "on_track" && offTrack.length > 0) {
    level = "watch";
    basis += ` Held at "watch" because ${offTrack.join(", ")} ${offTrack.length === 1 ? "is" : "are"} off track.`;
  } else if (offTrack.length > 0) {
    basis += ` Off track: ${offTrack.join(", ")}.`;
  } else if (watch.length > 0) {
    basis += ` On watch: ${watch.join(", ")}.`;
  }
  return { score, level, ratedDimensions: ratedDims.length, dimensions, basis };
}
