/**
 * Shared types + helpers for the quantitative risk workspace
 * (spec Vol II Domain H / M13, #447-473).
 *
 * Everything here codes defensively to the API list shape {items,...}:
 * preScore/postScore are used when present and recomputed client-side
 * from the 1-5 scores when not.
 */

export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/* ------------------------------ distributions ----------------------------- */

export type Dist =
  | { kind: "triangular"; min: number; mode: number; max: number }
  | { kind: "pert"; min: number; mode: number; max: number }
  | { kind: "uniform"; min: number; max: number }
  | { kind: "normal"; mean: number; stdDev: number }
  | { kind: "lognormal"; logMean: number; logStdDev: number }
  | { kind: "discrete"; values: { value: number; weight: number }[] };

export type DistKind = Dist["kind"];

export const DIST_KINDS: DistKind[] = [
  "triangular",
  "pert",
  "uniform",
  "normal",
  "lognormal",
  "discrete",
];

/** Inline validation mirroring the API's distributions.ts rules. */
export function distProblem(d: Dist): string | null {
  const bad = (n: number) => !Number.isFinite(n);
  switch (d.kind) {
    case "triangular":
    case "pert":
      if (bad(d.min) || bad(d.mode) || bad(d.max)) return "min, mode and max are required";
      if (!(d.min <= d.mode && d.mode <= d.max)) return "requires min ≤ mode ≤ max";
      return null;
    case "uniform":
      if (bad(d.min) || bad(d.max)) return "min and max are required";
      if (d.min > d.max) return "requires min ≤ max";
      return null;
    case "normal":
      if (bad(d.mean) || bad(d.stdDev)) return "mean and stdDev are required";
      if (d.stdDev < 0) return "stdDev must be ≥ 0";
      return null;
    case "lognormal":
      if (bad(d.logMean) || bad(d.logStdDev)) return "logMean and logStdDev are required";
      if (d.logStdDev < 0) return "logStdDev must be ≥ 0";
      return null;
    case "discrete":
      if (d.values.length === 0) return "at least one value:weight pair is required";
      if (d.values.some((v) => bad(v.value) || bad(v.weight) || v.weight <= 0))
        return "every pair needs a finite value and a positive weight";
      return null;
  }
}

export function distLabel(d: unknown): string {
  const v = d as Dist | null | undefined;
  if (!v || typeof v !== "object" || !("kind" in v)) return "—";
  switch (v.kind) {
    case "triangular":
    case "pert":
      return `${v.kind}(${v.min} / ${v.mode} / ${v.max})`;
    case "uniform":
      return `uniform(${v.min} … ${v.max})`;
    case "normal":
      return `normal(μ ${v.mean}, σ ${v.stdDev})`;
    case "lognormal":
      return `lognormal(μ ${v.logMean}, σ ${v.logStdDev})`;
    case "discrete":
      return `discrete(${v.values.length} outcomes)`;
    default:
      return "—";
  }
}

/* ---------------------------------- risks --------------------------------- */

export interface MitigationAction {
  description: string;
  ownerId?: string | null;
  dueDate?: string | null;
  cost?: number | null;
  done?: boolean;
}

export interface RiskRow {
  id: string;
  number: number;
  title: string;
  description: string | null;
  category: string;
  status: string;
  ownerId: string | null;
  probabilityScore: number;
  impactScore: number;
  postProbabilityScore: number | null;
  postImpactScore: number | null;
  occurrenceProbability: number | null;
  costImpact: Record<string, unknown> | null;
  scheduleTaskId: string | null;
  durationImpact: Record<string, unknown> | null;
  mitigations: unknown[];
  mitigationCost: number | null;
  createdAt: string;
  updatedAt: string;
  /** provided by the API; recomputed client-side when absent */
  preScore?: number;
  postScore?: number | null;
}

export function preScore(r: RiskRow): number {
  return r.preScore ?? r.probabilityScore * r.impactScore;
}

export function postScore(r: RiskRow): number | null {
  if (r.postScore !== undefined) return r.postScore;
  return r.postProbabilityScore != null && r.postImpactScore != null
    ? r.postProbabilityScore * r.postImpactScore
    : null;
}

export function isQuantified(r: RiskRow): boolean {
  return r.occurrenceProbability != null && r.costImpact != null;
}

/** P×I band: ≥16 red, ≥9 amber, else green. */
export function bandTone(score: number): "red" | "amber" | "green" {
  if (score >= 16) return "red";
  if (score >= 9) return "amber";
  return "green";
}

export const bandChipClass: Record<"red" | "amber" | "green", string> = {
  red: "bg-red-100 text-red-800 ring-1 ring-red-200",
  amber: "bg-amber-100 text-amber-800 ring-1 ring-amber-200",
  green: "bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200",
};

export function riskStatusTone(status: string): string {
  switch (status) {
    case "open":
      return "blue";
    case "mitigating":
      return "amber";
    case "closed":
      return "gray";
    case "realised":
      return "red";
    default:
      return "gray";
  }
}

export function categoryTone(category: string): string {
  switch (category) {
    case "technical":
      return "blue";
    case "commercial":
      return "violet";
    case "external":
      return "amber";
    case "organisational":
      return "gray";
    case "environmental":
      return "green";
    case "political":
      return "red";
    default:
      return "gray";
  }
}

export function parseMitigations(raw: unknown[]): MitigationAction[] {
  return (Array.isArray(raw) ? raw : []).flatMap((m) => {
    if (m && typeof m === "object" && "description" in m) {
      const o = m as Record<string, unknown>;
      return [
        {
          description: String(o["description"] ?? ""),
          ownerId: (o["ownerId"] as string | null | undefined) ?? null,
          dueDate: (o["dueDate"] as string | null | undefined) ?? null,
          cost: typeof o["cost"] === "number" ? (o["cost"] as number) : null,
          done: Boolean(o["done"]),
        },
      ];
    }
    return [];
  });
}

/* ------------------------------- simulations ------------------------------ */

export interface HistogramBin {
  from: number;
  to: number;
  count: number;
}

export interface SimSummary {
  iterations: number;
  mean: number;
  stdDev: number;
  min: number;
  max: number;
  percentiles: { p10: number; p50: number; p80: number; p90: number; p95: number };
  histogram: HistogramBin[];
}

export interface PerRiskRow {
  id: string;
  name: string;
  expectedValue: number;
  occurredShare: number;
  correlationWithTotal: number;
}

export interface PerTaskRow {
  id: string;
  criticalityIndex: number;
  sensitivity: number;
}

/** Unified result view — populated from a fresh run or a stored record. */
export interface SimView {
  simulationId: string | null;
  kind: "qcra" | "qsra";
  seed: number;
  iterations: number;
  summary: SimSummary;
  perRisk?: PerRiskRow[];
  perTask?: PerTaskRow[];
  contingencyAt?: { p50: number; p80: number; p90: number };
  deterministicDurationDays?: number;
  completionDates?: Record<string, string>;
  scheduleId?: string;
  correlationModelled?: boolean;
}

export interface SimListItem {
  id: string;
  kind: string;
  seed: number;
  iterations: number;
  runBy: string;
  createdAt: string;
  summary: {
    mean: number | null;
    min: number | null;
    max: number | null;
    percentiles: Record<string, number> | null;
  } | null;
}

export interface SimDetail {
  id: string;
  kind: string;
  seed: number;
  iterations: number;
  inputs: Record<string, unknown>;
  results: Record<string, unknown>;
  runBy: string;
  createdAt: string;
}

export interface RerunResult {
  simulationId: string;
  kind: string;
  seed: number;
  iterations: number;
  reproduced: boolean;
  expected: Record<string, number> | null;
  actual: Record<string, number> | null;
}

/** Defensive: build the unified view from a stored simulation record. */
export function viewFromDetail(sim: SimDetail): SimView | null {
  const results = sim.results ?? {};
  const summary = results["summary"] as SimSummary | undefined;
  if (!summary || !summary.percentiles) return null;
  const kind = sim.kind === "qsra" ? "qsra" : "qcra";
  const inputs = sim.inputs ?? {};
  return {
    simulationId: sim.id,
    kind,
    seed: sim.seed,
    iterations: sim.iterations,
    summary,
    perRisk: Array.isArray(results["perRisk"]) ? (results["perRisk"] as PerRiskRow[]) : undefined,
    perTask: Array.isArray(results["perTask"]) ? (results["perTask"] as PerTaskRow[]) : undefined,
    contingencyAt: (results["contingencyAt"] as SimView["contingencyAt"]) ?? undefined,
    deterministicDurationDays:
      typeof results["deterministicDurationDays"] === "number"
        ? (results["deterministicDurationDays"] as number)
        : undefined,
    completionDates: (results["completionDates"] as Record<string, string>) ?? undefined,
    scheduleId: typeof inputs["scheduleId"] === "string" ? (inputs["scheduleId"] as string) : undefined,
    correlationModelled: Boolean(results["correlationModelled"]),
  };
}

/* ------------------------------- contingency ------------------------------ */

export interface ContingencyRow {
  id: string;
  name: string;
  currency: string;
  amount: number;
  confidenceLevel: string | null;
  simulationId: string | null;
  isManagementReserve: number;
  createdAt: string;
  drawnTotal: number;
  remaining: number;
}

export interface DrawdownPoint {
  date: string;
  amount: number;
  drawn: number;
  remaining: number;
  riskId: string | null;
  reason: string;
}

export interface DrawdownCurveData {
  contingencyId: string;
  name: string;
  currency: string;
  amount: number;
  points: DrawdownPoint[];
}

/* -------------------------------- schedules ------------------------------- */

export interface ScheduleLite {
  id: string;
  name: string;
  isActive: number;
  projectStart: string;
}

export interface ScheduleTaskLite {
  id: string;
  name: string;
  durationDays: number;
}

export interface TaskOption {
  id: string;
  name: string;
  scheduleName: string;
}

export interface UserLite {
  id: string;
  name: string;
  email: string;
}

/* ------------------------------- formatting ------------------------------- */

export function fmtNum(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(v);
}

/** Value axis formatting: qcra → cost figure, qsra → whole days. */
export function fmtSimValue(v: number, kind: "qcra" | "qsra"): string {
  if (kind === "qsra") return `${Math.round(v)}d`;
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 10_000) return `${Math.round(v / 1000)}k`;
  return fmtNum(v);
}

export function rskLabel(n: number): string {
  return `RSK-${String(n).padStart(3, "0")}`;
}
