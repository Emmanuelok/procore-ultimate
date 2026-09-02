/**
 * Cost–Value Reconciliation, WIP and the cash-flow S-curve
 * (spec Vol II Domain B #184-189).
 *
 * THE POINT
 * Value is what the work is worth under the contract; cost is what it took to
 * do it. The gap between them is the margin, and the gap between value and
 * what has actually been certified is over- or under-certification — the
 * number that decides whether a project is quietly funding its client.
 *
 * HONESTY RULES BAKED IN
 *  • Cost that cannot be measured is a `gap`, never a zero. A CVR with no cost
 *    feed returns margin = null with the reason, because "100% margin" is a
 *    lie, not a result.
 *  • Nothing is summed across currencies: the caller passes one currency's
 *    rows and the currency is carried on the result.
 *  • Every figure names the records it came from in `basis`.
 */

export const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface CvrPackageInput {
  /** stable key — commitment id, or "unallocated" */
  key: string;
  label: string;
  /** value earned under the main contract attributable to this package */
  valueToDate: number | null;
  /** committed cost (the subcontract sum), for context */
  committed: number | null;
  /** cost incurred: certified subcontractor applications, invoices */
  costToDate: number | null;
  /** work done but not yet invoiced by the supply chain */
  accruals: number;
  basis: Record<string, unknown>;
  gaps: string[];
}

export interface CvrInput {
  currency: string;
  periodEnd: string;
  /** Σ gross of the latest application per BoQ — the internal valuation */
  valueToDate: number | null;
  /** Σ netCertified over issued certificates */
  certifiedToDate: number;
  /** direct costs not attributable to a package (labour, plant, materials) */
  directCosts: Array<{ label: string; amount: number | null; gap?: string }>;
  packages: CvrPackageInput[];
}

export interface CvrRowResult {
  scope: "project" | "package";
  label: string;
  packageRef: string | null;
  valueToDate: number | null;
  certifiedToDate: number | null;
  costToDate: number | null;
  accruals: number;
  margin: number | null;
  marginPercent: number | null;
  basis: Record<string, unknown>;
}

export interface CvrResult {
  currency: string;
  periodEnd: string;
  valueToDate: number | null;
  certifiedToDate: number;
  costToDate: number | null;
  accruals: number;
  wip: number | null;
  margin: number | null;
  marginPercent: number | null;
  overUnderCertification: number | null;
  rows: CvrRowResult[];
  gaps: string[];
  basis: Record<string, unknown>;
}

/**
 * Roll the package and direct-cost feeds into a project CVR.
 *
 * WIP is the work done and valued but not yet certified — value − certified.
 * Over/under-certification is certified − value: positive means the client has
 * certified more than the internal valuation supports.
 */
export function computeCvr(input: CvrInput): CvrResult {
  const gaps: string[] = [];
  const rows: CvrRowResult[] = [];

  let costKnown = true;
  let costToDate = 0;
  let accruals = 0;

  for (const p of input.packages) {
    if (p.costToDate == null) {
      costKnown = false;
      gaps.push(`No cost feed for package "${p.label}".`);
    } else {
      costToDate += p.costToDate;
    }
    accruals += p.accruals;
    for (const g of p.gaps) gaps.push(g);
    const margin =
      p.valueToDate != null && p.costToDate != null
        ? round2(p.valueToDate - p.costToDate - p.accruals)
        : null;
    rows.push({
      scope: "package",
      label: p.label,
      packageRef: p.key,
      valueToDate: p.valueToDate == null ? null : round2(p.valueToDate),
      certifiedToDate: null,
      costToDate: p.costToDate == null ? null : round2(p.costToDate),
      accruals: round2(p.accruals),
      margin,
      marginPercent:
        margin != null && p.valueToDate != null && p.valueToDate !== 0
          ? Math.round((margin / p.valueToDate) * 1000) / 10
          : null,
      basis: p.basis,
    });
  }

  for (const d of input.directCosts) {
    if (d.amount == null) {
      costKnown = false;
      gaps.push(d.gap ?? `No cost feed for "${d.label}".`);
      continue;
    }
    costToDate += d.amount;
    rows.push({
      scope: "package",
      label: d.label,
      packageRef: null,
      valueToDate: null,
      certifiedToDate: null,
      costToDate: round2(d.amount),
      accruals: 0,
      margin: null,
      marginPercent: null,
      basis: { kind: "direct_cost" },
    });
  }

  const valueToDate = input.valueToDate == null ? null : round2(input.valueToDate);
  if (valueToDate == null) {
    gaps.push("No priced valuation exists, so the value side of the CVR cannot be measured.");
  }
  const certifiedToDate = round2(input.certifiedToDate);
  const resolvedCost = costKnown ? round2(costToDate) : null;
  accruals = round2(accruals);

  const margin =
    valueToDate != null && resolvedCost != null
      ? round2(valueToDate - resolvedCost - accruals)
      : null;

  rows.unshift({
    scope: "project",
    label: "Project",
    packageRef: null,
    valueToDate,
    certifiedToDate,
    costToDate: resolvedCost,
    accruals,
    margin,
    marginPercent:
      margin != null && valueToDate != null && valueToDate !== 0
        ? Math.round((margin / valueToDate) * 1000) / 10
        : null,
    basis: { packages: input.packages.length, directCostLines: input.directCosts.length },
  });

  return {
    currency: input.currency,
    periodEnd: input.periodEnd,
    valueToDate,
    certifiedToDate,
    costToDate: resolvedCost,
    accruals,
    wip: valueToDate == null ? null : round2(valueToDate - certifiedToDate),
    margin,
    marginPercent:
      margin != null && valueToDate != null && valueToDate !== 0
        ? Math.round((margin / valueToDate) * 1000) / 10
        : null,
    overUnderCertification: valueToDate == null ? null : round2(certifiedToDate - valueToDate),
    rows,
    gaps,
    basis: {
      valueSource: "latest application per BoQ (gross)",
      certifiedSource: "Σ netCertified over issued payment certificates",
      costSource: "commitment invoices + timecard cost + direct cost feeds",
    },
  };
}

/* ------------------------------------------------------------------ */
/* Cash-flow S-curve (#188)                                            */
/* ------------------------------------------------------------------ */

export interface SCurveTaskInput {
  taskId: string;
  name: string;
  start: string | null;
  finish: string | null;
  /** BQ money allocated to this task */
  amount: number;
}

export interface SCurvePoint {
  period: string;
  planned: number;
  plannedCumulative: number;
  actualCumulative: number | null;
}

export interface SCurveResult {
  currency: string;
  points: SCurvePoint[];
  totalAllocated: number;
  unallocated: number;
  reasons: string[];
}

function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

function monthsBetween(a: string, b: string): string[] {
  const out: string[] = [];
  const start = new Date(`${a.slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(`${b.slice(0, 7)}-01T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return out;
  const cursor = new Date(start);
  let guard = 0;
  while (cursor <= end && guard < 600) {
    out.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    guard += 1;
  }
  return out;
}

/**
 * Spread BQ money over the programme: each linked task's amount is spread
 * evenly across the months it spans, giving a planned cash-flow curve. Actual
 * cumulative certified value is overlaid where periods are supplied.
 *
 * Money attached to no task is reported as `unallocated` rather than being
 * smeared arbitrarily across the programme.
 */
export function computeSCurve(
  currency: string,
  tasks: SCurveTaskInput[],
  unallocated: number,
  actuals: Array<{ period: string; amount: number }> = [],
): SCurveResult {
  const reasons: string[] = [];
  const perPeriod = new Map<string, number>();
  let totalAllocated = 0;

  for (const t of tasks) {
    if (!t.start || !t.finish) {
      reasons.push(`Task "${t.name}" has no dates; its ${round2(t.amount)} is not on the curve.`);
      continue;
    }
    const months = monthsBetween(t.start, t.finish);
    if (months.length === 0) {
      reasons.push(`Task "${t.name}" has unusable dates; its ${round2(t.amount)} is not on the curve.`);
      continue;
    }
    const share = t.amount / months.length;
    for (const m of months) perPeriod.set(m, (perPeriod.get(m) ?? 0) + share);
    totalAllocated += t.amount;
  }
  if (unallocated > 0) {
    reasons.push(
      `${round2(unallocated)} of BQ value is not linked to any programme task and is excluded from the curve.`,
    );
  }

  const actualByPeriod = new Map<string, number>();
  for (const a of actuals) actualByPeriod.set(monthKey(a.period), a.amount);
  const periods = [...new Set([...perPeriod.keys(), ...actualByPeriod.keys()])].sort();

  let cumulative = 0;
  let actualCumulative = 0;
  let sawActual = false;
  const points: SCurvePoint[] = periods.map((period) => {
    const planned = round2(perPeriod.get(period) ?? 0);
    cumulative = round2(cumulative + planned);
    const actual = actualByPeriod.get(period);
    if (actual !== undefined) {
      sawActual = true;
      actualCumulative = round2(actualCumulative + actual);
    }
    return {
      period,
      planned,
      plannedCumulative: cumulative,
      actualCumulative: sawActual ? actualCumulative : null,
    };
  });

  return {
    currency,
    points,
    totalAllocated: round2(totalAllocated),
    unallocated: round2(unallocated),
    reasons,
  };
}
