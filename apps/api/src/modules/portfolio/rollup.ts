/**
 * Portfolio roll-up, affordability and appropriation arithmetic.
 * Spec Vol I §7 #776–#780, #783–#784, #789; Vol II Domain G #426–#434.
 *
 * Pure and deterministic. The route fetches bounded row sets (one company,
 * optionally one portfolio, one fiscal year) and this file turns them into
 * the numbers the workspace prints.
 *
 * The rule that shapes every function here: MONEY IS NEVER SUMMED ACROSS
 * CURRENCIES. Anything that would need a rate returns an `Unknowable` — the
 * value is null and the reasons say which currencies were present — because a
 * portfolio total computed at an unstated rate is worse than no total.
 *
 * What it deliberately does NOT do: convert currencies, forecast, or infer a
 * project's budget when no active budget exists. A project with no budget
 * contributes to counts and to its own reason list, never to a total.
 */

export interface Unknowable<T = number> {
  value: T | null;
  reasons: string[];
}

export const unknowable = <T,>(reasons: string[]): Unknowable<T> => ({ value: null, reasons });

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * A cross-currency total is only knowable when exactly one currency is in
 * play. Otherwise the reasons name what was found.
 */
export function combinedTotal<T extends { currency: string }>(
  buckets: T[],
  pick: (bucket: T) => number,
  label: string,
): Unknowable {
  if (buckets.length === 0) return unknowable([`No ${label} has been recorded.`]);
  if (buckets.length === 1) {
    const only = buckets[0]!;
    return { value: round2(pick(only)), reasons: [] };
  }
  return unknowable([
    `${label} spans ${buckets.length} currencies (${buckets.map((b) => b.currency).join(", ")}); a single total would need an exchange rate this platform has not been given.`,
  ]);
}

/* ================================================================== */
/* Portfolio financial roll-up (#777)                                  */
/* ================================================================== */

export interface RollupProject {
  projectId: string;
  name: string;
  stage: string;
  currency: string;
  /** the project's own headline value, when the owner recorded one */
  value: number | null;
  portfolioId: string | null;
  isSandbox: boolean;
}

export interface RollupBudget {
  projectId: string;
  currency: string;
  revisedBudgetTotal: number;
  committedTotal: number;
  jobToDateCostsTotal: number;
  forecastFinalTotal: number;
}

export interface RollupCommitment {
  projectId: string;
  currency: string;
  revisedCommitmentSum: number;
  totalInvoiced: number;
  totalPaid: number;
}

export interface CurrencyRollup {
  currency: string;
  projects: number;
  projectValue: number;
  revisedBudget: number;
  committed: number;
  jobToDateCost: number;
  forecastFinal: number;
  commitmentValue: number;
  invoiced: number;
  paid: number;
  /** forecastFinal − revisedBudget; positive is an overrun */
  forecastVariance: number;
}

export interface PortfolioRollup {
  byCurrency: CurrencyRollup[];
  combinedForecastFinal: Unknowable;
  projectsWithoutBudget: number;
  projectsMixedCurrency: number;
  reasons: string[];
}

/**
 * Roll project value, active budget and commitment position up by currency.
 * A budget whose currency differs from its project's is counted under the
 * BUDGET's currency and flagged — the money is denominated where the budget
 * says it is, not where the project header says it is.
 */
export function rollUpPortfolio(
  projects: RollupProject[],
  budgets: RollupBudget[],
  commitments: RollupCommitment[],
): PortfolioRollup {
  const reasons: string[] = [];
  const live = projects.filter((p) => !p.isSandbox);
  if (live.length !== projects.length) {
    reasons.push(`${projects.length - live.length} sandbox project(s) are excluded from the roll-up.`);
  }

  const byCurrency = new Map<string, CurrencyRollup>();
  const seed = (currency: string): CurrencyRollup => {
    let acc = byCurrency.get(currency);
    if (!acc) {
      acc = {
        currency,
        projects: 0,
        projectValue: 0,
        revisedBudget: 0,
        committed: 0,
        jobToDateCost: 0,
        forecastFinal: 0,
        commitmentValue: 0,
        invoiced: 0,
        paid: 0,
        forecastVariance: 0,
      };
      byCurrency.set(currency, acc);
    }
    return acc;
  };

  const projectCurrency = new Map<string, string>();
  const liveIds = new Set(live.map((p) => p.projectId));
  for (const p of live) {
    projectCurrency.set(p.projectId, p.currency);
    const acc = seed(p.currency);
    acc.projects += 1;
    if (p.value !== null && Number.isFinite(p.value)) acc.projectValue += p.value;
  }

  let mixed = 0;
  const budgeted = new Set<string>();
  for (const b of budgets) {
    if (!liveIds.has(b.projectId)) continue;
    budgeted.add(b.projectId);
    if (projectCurrency.get(b.projectId) !== b.currency) mixed += 1;
    const acc = seed(b.currency);
    acc.revisedBudget += b.revisedBudgetTotal;
    acc.committed += b.committedTotal;
    acc.jobToDateCost += b.jobToDateCostsTotal;
    acc.forecastFinal += b.forecastFinalTotal;
  }
  for (const c of commitments) {
    if (!liveIds.has(c.projectId)) continue;
    const acc = seed(c.currency);
    acc.commitmentValue += c.revisedCommitmentSum;
    acc.invoiced += c.totalInvoiced;
    acc.paid += c.totalPaid;
  }

  const buckets = [...byCurrency.values()]
    .map((b) => ({
      ...b,
      projectValue: round2(b.projectValue),
      revisedBudget: round2(b.revisedBudget),
      committed: round2(b.committed),
      jobToDateCost: round2(b.jobToDateCost),
      forecastFinal: round2(b.forecastFinal),
      commitmentValue: round2(b.commitmentValue),
      invoiced: round2(b.invoiced),
      paid: round2(b.paid),
      forecastVariance: round2(b.forecastFinal - b.revisedBudget),
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency));

  const withBudget = buckets.filter((b) => b.revisedBudget !== 0 || b.forecastFinal !== 0);
  const withoutBudget = live.filter((p) => !budgeted.has(p.projectId)).length;
  if (withoutBudget > 0) {
    reasons.push(
      `${withoutBudget} project(s) have no active budget, so they contribute to counts but to no financial total.`,
    );
  }
  if (mixed > 0) {
    reasons.push(`${mixed} budget(s) are denominated in a currency other than their project's header currency.`);
  }

  return {
    byCurrency: buckets,
    combinedForecastFinal: combinedTotal(withBudget, (b: CurrencyRollup) => b.forecastFinal, "forecast final cost"),
    projectsWithoutBudget: withoutBudget,
    projectsMixedCurrency: mixed,
    reasons,
  };
}

/* ================================================================== */
/* Appropriation position (#428–#429, #433)                            */
/* ================================================================== */

export interface AppropriationRow {
  id: string;
  fiscalYear: string;
  currency: string;
  appropriatedAmount: number;
  carriedForwardIn: number;
  carriedForwardOut: number;
  virementNet: number;
  status: string;
  carryForwardPolicy: string;
  expenditureClass: string;
}

export interface AllocationRow {
  id: string;
  appropriationId: string | null;
  fundingSourceId: string | null;
  projectId: string;
  currency: string;
  amount: number;
  drawnAmount: number;
  status: string;
  expenditureClass: string;
  fiscalYear: string | null;
}

/** Allocation statuses that consume authority. `cancelled` releases it. */
export const CONSUMING_ALLOCATION_STATUSES = ["planned", "approved", "drawn", "released"];

export interface AppropriationPosition {
  appropriationId: string;
  currency: string;
  /** appropriated + carried in + net virement − carried out */
  authorised: number;
  allocated: number;
  drawn: number;
  uncommitted: number;
  utilisationPercent: number | null;
  overcommitted: boolean;
  overcommittedBy: number;
  /** what would carry to next year under the policy, were the year closed now */
  carryForwardEligible: number;
  carryForwardPolicy: string;
  allocationCount: number;
  currencyMismatches: number;
  reasons: string[];
}

/**
 * The position of one appropriation against the allocations drawn on it.
 * An allocation in another currency cannot consume this authority and is
 * excluded with a reason rather than added at par.
 */
export function appropriationPosition(
  appropriation: AppropriationRow,
  allocations: AllocationRow[],
): AppropriationPosition {
  const reasons: string[] = [];
  const mine = allocations.filter((a) => a.appropriationId === appropriation.id);
  const sameCurrency = mine.filter((a) => a.currency === appropriation.currency);
  const mismatches = mine.length - sameCurrency.length;
  if (mismatches > 0) {
    reasons.push(
      `${mismatches} allocation(s) are in a different currency from the appropriation (${appropriation.currency}) and are excluded from its position.`,
    );
  }
  const consuming = sameCurrency.filter((a) => CONSUMING_ALLOCATION_STATUSES.includes(a.status));
  const allocated = round2(consuming.reduce((s, a) => s + a.amount, 0));
  const drawn = round2(sameCurrency.reduce((s, a) => s + a.drawnAmount, 0));
  const authorised = round2(
    appropriation.appropriatedAmount +
      appropriation.carriedForwardIn +
      appropriation.virementNet -
      appropriation.carriedForwardOut,
  );
  const uncommitted = round2(authorised - allocated);
  const overcommitted = uncommitted < -0.005;
  const carryForwardEligible =
    appropriation.carryForwardPolicy === "lapse" ? 0 : Math.max(0, round2(authorised - drawn));
  if (appropriation.carryForwardPolicy === "lapse" && authorised - drawn > 0.005) {
    reasons.push(
      `Policy is to lapse: ${round2(authorised - drawn)} ${appropriation.currency} of unspent authority would be lost at the year end.`,
    );
  }
  if (appropriation.carryForwardPolicy === "request") {
    reasons.push("Carry-forward requires an approval; the eligible balance is not automatic.");
  }
  return {
    appropriationId: appropriation.id,
    currency: appropriation.currency,
    authorised,
    allocated,
    drawn,
    uncommitted,
    utilisationPercent: authorised > 0 ? round2((allocated / authorised) * 100) : null,
    overcommitted,
    overcommittedBy: overcommitted ? round2(-uncommitted) : 0,
    carryForwardEligible,
    carryForwardPolicy: appropriation.carryForwardPolicy,
    allocationCount: consuming.length,
    currencyMismatches: mismatches,
    reasons,
  };
}

/* ================================================================== */
/* Funding source position (#427)                                      */
/* ================================================================== */

export interface FundingSourceRow {
  id: string;
  currency: string;
  amount: number;
  status: string;
  expenditureClass: string;
}

export interface FundingSourcePosition {
  fundingSourceId: string;
  currency: string;
  facility: number;
  allocated: number;
  drawn: number;
  headroom: number;
  utilisationPercent: number | null;
  overdrawn: boolean;
  overdrawnBy: number;
  currencyMismatches: number;
  reasons: string[];
}

export function fundingSourcePosition(
  source: FundingSourceRow,
  allocations: AllocationRow[],
): FundingSourcePosition {
  const reasons: string[] = [];
  const mine = allocations.filter((a) => a.fundingSourceId === source.id);
  const sameCurrency = mine.filter((a) => a.currency === source.currency);
  const mismatches = mine.length - sameCurrency.length;
  if (mismatches > 0) {
    reasons.push(
      `${mismatches} allocation(s) are in a different currency from the facility (${source.currency}) and are excluded.`,
    );
  }
  const consuming = sameCurrency.filter((a) => CONSUMING_ALLOCATION_STATUSES.includes(a.status));
  const allocated = round2(consuming.reduce((s, a) => s + a.amount, 0));
  const drawn = round2(sameCurrency.reduce((s, a) => s + a.drawnAmount, 0));
  const headroom = round2(source.amount - allocated);
  return {
    fundingSourceId: source.id,
    currency: source.currency,
    facility: round2(source.amount),
    allocated,
    drawn,
    headroom,
    utilisationPercent: source.amount > 0 ? round2((allocated / source.amount) * 100) : null,
    overdrawn: headroom < -0.005,
    overdrawnBy: headroom < 0 ? round2(-headroom) : 0,
    currencyMismatches: mismatches,
    reasons,
  };
}

/* ================================================================== */
/* Affordability envelope versus demand (#426)                         */
/* ================================================================== */

export interface EnvelopeRow {
  id: string;
  name: string;
  portfolioId: string | null;
  fiscalYear: string;
  currency: string;
  envelopeAmount: number;
  expenditureClass: string;
  status: string;
  basis: string | null;
}

export interface AffordabilityLine {
  envelopeId: string;
  name: string;
  fiscalYear: string;
  currency: string;
  expenditureClass: string;
  envelope: number;
  /** allocations in the same year, currency and class */
  demand: number;
  headroom: number;
  utilisationPercent: number | null;
  breached: boolean;
  breachedBy: number;
  allocationCount: number;
  basis: string | null;
  reasons: string[];
}

export interface AffordabilityResult {
  lines: AffordabilityLine[];
  /** allocations that no active envelope covers */
  uncovered: Array<{ fiscalYear: string; currency: string; expenditureClass: string; amount: number; count: number }>;
  reasons: string[];
}

/**
 * Measure portfolio demand against each active envelope. Demand is matched on
 * fiscal year, currency AND expenditure class: a capital envelope does not
 * pay for revenue spend, and saying so is the whole point of #430.
 */
export function affordability(
  envelopes: EnvelopeRow[],
  allocations: AllocationRow[],
  options: { portfolioId?: string | null } = {},
): AffordabilityResult {
  const reasons: string[] = [];
  const active = envelopes.filter((e) => e.status === "active");
  if (active.length === 0 && envelopes.length > 0) {
    reasons.push("No envelope is active; a draft or superseded ceiling is not a control.");
  }
  const consuming = allocations.filter((a) => CONSUMING_ALLOCATION_STATUSES.includes(a.status));

  const matched = new Set<string>();
  const lines: AffordabilityLine[] = active.map((env) => {
    const hits = consuming.filter(
      (a) =>
        a.fiscalYear === env.fiscalYear &&
        a.currency === env.currency &&
        (env.expenditureClass === "mixed" || a.expenditureClass === env.expenditureClass),
    );
    for (const h of hits) matched.add(h.id);
    const demand = round2(hits.reduce((s, a) => s + a.amount, 0));
    const headroom = round2(env.envelopeAmount - demand);
    const lineReasons: string[] = [];
    if (hits.length === 0) {
      lineReasons.push("No allocation matches this envelope's year, currency and expenditure class.");
    }
    return {
      envelopeId: env.id,
      name: env.name,
      fiscalYear: env.fiscalYear,
      currency: env.currency,
      expenditureClass: env.expenditureClass,
      envelope: round2(env.envelopeAmount),
      demand,
      headroom,
      utilisationPercent: env.envelopeAmount > 0 ? round2((demand / env.envelopeAmount) * 100) : null,
      breached: headroom < -0.005,
      breachedBy: headroom < 0 ? round2(-headroom) : 0,
      allocationCount: hits.length,
      basis: env.basis,
      reasons: lineReasons,
    };
  });

  const uncoveredMap = new Map<string, { fiscalYear: string; currency: string; expenditureClass: string; amount: number; count: number }>();
  for (const a of consuming) {
    if (matched.has(a.id)) continue;
    const key = `${a.fiscalYear ?? "—"}|${a.currency}|${a.expenditureClass}`;
    const acc = uncoveredMap.get(key) ?? {
      fiscalYear: a.fiscalYear ?? "—",
      currency: a.currency,
      expenditureClass: a.expenditureClass,
      amount: 0,
      count: 0,
    };
    acc.amount = round2(acc.amount + a.amount);
    acc.count += 1;
    uncoveredMap.set(key, acc);
  }
  const uncovered = [...uncoveredMap.values()].sort(
    (a, b) => a.fiscalYear.localeCompare(b.fiscalYear) || a.currency.localeCompare(b.currency),
  );
  if (uncovered.length > 0) {
    reasons.push(
      `${uncovered.reduce((s, u) => s + u.count, 0)} allocation(s) fall outside every active envelope (year/currency/class combinations: ${uncovered
        .map((u) => `${u.fiscalYear} ${u.currency} ${u.expenditureClass}`)
        .join("; ")}).`,
    );
  }
  if (options.portfolioId) {
    reasons.push(`Scoped to portfolio ${options.portfolioId}.`);
  }
  return { lines, uncovered, reasons };
}

/* ================================================================== */
/* Capital versus revenue split (#430)                                 */
/* ================================================================== */

export interface ClassSplitBucket {
  currency: string;
  capital: number;
  revenue: number;
  mixed: number;
  unclassified: number;
  total: number;
  capitalPercent: number | null;
}

/** Split allocation value by expenditure class, per currency. */
export function classificationSplit(allocations: AllocationRow[]): ClassSplitBucket[] {
  const map = new Map<string, ClassSplitBucket>();
  for (const a of allocations) {
    if (!CONSUMING_ALLOCATION_STATUSES.includes(a.status)) continue;
    let acc = map.get(a.currency);
    if (!acc) {
      acc = { currency: a.currency, capital: 0, revenue: 0, mixed: 0, unclassified: 0, total: 0, capitalPercent: null };
      map.set(a.currency, acc);
    }
    if (a.expenditureClass === "capital") acc.capital += a.amount;
    else if (a.expenditureClass === "revenue") acc.revenue += a.amount;
    else if (a.expenditureClass === "mixed") acc.mixed += a.amount;
    else acc.unclassified += a.amount;
    acc.total += a.amount;
  }
  return [...map.values()]
    .map((b) => ({
      currency: b.currency,
      capital: round2(b.capital),
      revenue: round2(b.revenue),
      mixed: round2(b.mixed),
      unclassified: round2(b.unclassified),
      total: round2(b.total),
      capitalPercent: b.total > 0 ? round2((b.capital / b.total) * 100) : null,
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

/* ================================================================== */
/* Stage-gate pipeline (#778, #786)                                    */
/* ================================================================== */

export interface GateRow {
  id: string;
  projectId: string;
  gateNumber: number;
  name: string;
  status: string;
  plannedDate: string | null;
}

export interface GateReviewRow {
  id: string;
  gateId: string;
  projectId: string;
  reviewDate: string;
  rag: string;
  decision: string;
}

export interface PipelineEntry {
  projectId: string;
  projectName: string;
  stage: string;
  currency: string;
  value: number | null;
  portfolioId: string | null;
  gatesTotal: number;
  gatesDecided: number;
  /** the lowest-numbered gate not yet decided */
  nextGate: { id: string; gateNumber: number; name: string; plannedDate: string | null; status: string } | null;
  /** the most recent review across all this project's gates */
  lastReview: { gateNumber: number; reviewDate: string; rag: string; decision: string } | null;
  overdueGates: number;
  reasons: string[];
}

export interface PipelineResult {
  entries: PipelineEntry[];
  byStage: Record<string, number>;
  byRag: Record<string, number>;
  gatesOverdue: number;
  projectsWithoutGates: number;
}

/**
 * Cross-project stage-gate pipeline. Reads the governance module's gates and
 * reviews; a project with no gate definition is reported as such rather than
 * being shown at gate 0.
 */
export function pipeline(
  projects: RollupProject[],
  gates: GateRow[],
  reviews: GateReviewRow[],
  today: string,
): PipelineResult {
  const gatesByProject = new Map<string, GateRow[]>();
  for (const g of gates) {
    const list = gatesByProject.get(g.projectId) ?? [];
    list.push(g);
    gatesByProject.set(g.projectId, list);
  }
  const reviewsByProject = new Map<string, GateReviewRow[]>();
  for (const r of reviews) {
    const list = reviewsByProject.get(r.projectId) ?? [];
    list.push(r);
    reviewsByProject.set(r.projectId, list);
  }
  const gateNumberById = new Map(gates.map((g) => [g.id, g.gateNumber]));

  const byStage: Record<string, number> = {};
  const byRag: Record<string, number> = {};
  let gatesOverdue = 0;
  let projectsWithoutGates = 0;

  const entries: PipelineEntry[] = projects
    .filter((p) => !p.isSandbox)
    .map((p) => {
      byStage[p.stage] = (byStage[p.stage] ?? 0) + 1;
      const projectGates = [...(gatesByProject.get(p.projectId) ?? [])].sort((a, b) => a.gateNumber - b.gateNumber);
      const projectReviews = [...(reviewsByProject.get(p.projectId) ?? [])].sort((a, b) =>
        b.reviewDate.localeCompare(a.reviewDate),
      );
      const reasons: string[] = [];
      if (projectGates.length === 0) {
        projectsWithoutGates += 1;
        reasons.push("No stage gates are defined for this project, so its pipeline position is unknown.");
      }
      const decided = projectGates.filter((g) => g.status === "decided").length;
      const next = projectGates.find((g) => g.status !== "decided") ?? null;
      const overdue = projectGates.filter(
        (g) => g.status !== "decided" && g.plannedDate !== null && g.plannedDate < today,
      ).length;
      gatesOverdue += overdue;
      const last = projectReviews[0] ?? null;
      if (last) byRag[last.rag] = (byRag[last.rag] ?? 0) + 1;
      else byRag["unrated"] = (byRag["unrated"] ?? 0) + 1;
      return {
        projectId: p.projectId,
        projectName: p.name,
        stage: p.stage,
        currency: p.currency,
        value: p.value,
        portfolioId: p.portfolioId,
        gatesTotal: projectGates.length,
        gatesDecided: decided,
        nextGate: next
          ? {
              id: next.id,
              gateNumber: next.gateNumber,
              name: next.name,
              plannedDate: next.plannedDate,
              status: next.status,
            }
          : null,
        lastReview: last
          ? {
              gateNumber: gateNumberById.get(last.gateId) ?? -1,
              reviewDate: last.reviewDate,
              rag: last.rag,
              decision: last.decision,
            }
          : null,
        overdueGates: overdue,
        reasons,
      };
    })
    .sort((a, b) => a.projectName.localeCompare(b.projectName));

  return { entries, byStage, byRag, gatesOverdue, projectsWithoutGates };
}
