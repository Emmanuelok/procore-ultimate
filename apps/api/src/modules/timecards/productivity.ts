/**
 * LABOUR PRODUCTIVITY AND EARNED VALUE — pure, no I/O (spec #615, #689-699).
 *
 * The cost report says what labour COST. This says whether it was WORTH it,
 * which is a different question and the only one that can still be acted on
 * while the job is running.
 *
 * The arithmetic, once:
 *
 *     achievedUnitRate  = actualHours / installedQuantity      (h per unit)
 *     plannedUnitRate   = budgetHours / budgetQuantity         (h per unit)
 *     earnedHours       = installedQuantity × plannedUnitRate
 *     productivityFactor= earnedHours / actualHours            (PF; >1 is good)
 *     forecastHours     = actualHours + remainingQuantity × achievedUnitRate
 *
 * Every one of those is NULL when its input is missing, with the reason
 * stated. A budget line with no planned hours has no PF — it does not have a
 * PF of 1.0, and it certainly does not have a PF of 0. That distinction is
 * the whole point: a forecast built on lines that quietly defaulted is a
 * forecast that reads as confident and is not.
 *
 * UNITS ARE NEVER ASSUMED TO MATCH. If the budget line is in m3 and the
 * allocations booked m2, the line is reported as incomparable rather than
 * divided.
 */

export const round2 = (n: number): number => Math.round(n * 100) / 100;
export const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** One coded allocation of hours, optionally carrying installed quantity. */
export interface ProductivityAllocation {
  budgetLineItemId: string | null;
  costCodeId: string | null;
  workDate: string;
  crewId: string | null;
  crewName?: string | null;
  hours: number;
  /** quantity installed by those hours, in `unit` */
  quantity: number | null;
  unit: string | null;
}

/** The planned side: a budget line's hours and quantity. */
export interface ProductivityBudgetLine {
  id: string;
  code: string | null;
  description: string;
  budgetHours: number | null;
  budgetQuantity: number | null;
  unit: string | null;
  /** money budgeted for labour on the line, used for the cost index */
  budgetAmount: number | null;
  currency: string | null;
}

export interface ProductivityLine {
  budgetLineItemId: string;
  code: string | null;
  description: string;
  unit: string | null;
  actualHours: number;
  installedQuantity: number | null;
  plannedUnitRate: number | null;
  achievedUnitRate: number | null;
  earnedHours: number | null;
  productivityFactor: number | null;
  percentComplete: number | null;
  remainingQuantity: number | null;
  forecastHoursAtCompletion: number | null;
  forecastVarianceHours: number | null;
  reasons: string[];
}

export interface ProductivityWeek {
  weekStart: string;
  actualHours: number;
  earnedHours: number | null;
  productivityFactor: number | null;
}

export interface ProductivityCrew {
  crewId: string | null;
  crewName: string | null;
  actualHours: number;
  earnedHours: number | null;
  productivityFactor: number | null;
}

export interface ProductivityReport {
  lines: ProductivityLine[];
  weeks: ProductivityWeek[];
  crews: ProductivityCrew[];
  totals: {
    actualHours: number;
    /** null when ANY line contributing hours could not be earned */
    earnedHours: number | null;
    productivityFactor: number | null;
    forecastHoursAtCompletion: number | null;
    linesMeasured: number;
    linesUnmeasurable: number;
  };
  reasons: string[];
}

function weekStartOf(iso: string, weekStartsOn: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - ((dow - weekStartsOn + 7) % 7));
  return d.toISOString().slice(0, 10);
}

/**
 * Build the report. `weekStartsOn` matters because the weekly trend is what
 * a foreman is judged on and a Sunday-start week moves a Saturday's hours.
 */
export function computeProductivity(
  allocations: ProductivityAllocation[],
  budgetLines: ProductivityBudgetLine[],
  options: { weekStartsOn?: number } = {},
): ProductivityReport {
  const weekStartsOn = options.weekStartsOn ?? 1;
  const byLine = new Map<string, ProductivityBudgetLine>(budgetLines.map((b) => [b.id, b]));
  const reasons: string[] = [];

  /* ------------------------- per budget line ------------------------ */
  const grouped = new Map<
    string,
    { hours: number; quantity: number; units: Set<string>; quantityRows: number }
  >();
  let uncodedHours = 0;
  for (const a of allocations) {
    if (!a.budgetLineItemId) {
      uncodedHours = round2(uncodedHours + a.hours);
      continue;
    }
    const held = grouped.get(a.budgetLineItemId) ?? {
      hours: 0,
      quantity: 0,
      units: new Set<string>(),
      quantityRows: 0,
    };
    held.hours = round2(held.hours + a.hours);
    if (a.quantity !== null && a.quantity > 0) {
      held.quantity = round3(held.quantity + a.quantity);
      held.quantityRows += 1;
      if (a.unit) held.units.add(a.unit.trim().toLowerCase());
    }
    grouped.set(a.budgetLineItemId, held);
  }
  if (uncodedHours > 0) {
    reasons.push(
      `${uncodedHours} hour(s) in this window carry no budget line and are excluded from every ` +
        "productivity figure. Hours nobody coded cannot be earned against anything.",
    );
  }

  const lines: ProductivityLine[] = [];
  /** earned hours per budget line, reused by the week and crew breakdowns */
  const earnedRatePerLine = new Map<string, number>();

  for (const [lineId, agg] of grouped) {
    const budget = byLine.get(lineId) ?? null;
    const lineReasons: string[] = [];
    const unit = budget?.unit ?? [...agg.units][0] ?? null;

    let plannedUnitRate: number | null = null;
    if (!budget) {
      lineReasons.push(
        "No budget line was found for this code, so there is nothing to earn against.",
      );
    } else if (budget.budgetHours === null || budget.budgetQuantity === null) {
      lineReasons.push(
        "The budget line carries " +
          (budget.budgetHours === null ? "no planned hours" : "no planned quantity") +
          ", so a planned unit rate cannot be derived and productivity is unknown rather than 100%.",
      );
    } else if (budget.budgetQuantity <= 0) {
      lineReasons.push("The budget line's planned quantity is zero, so a unit rate is undefined.");
    } else {
      plannedUnitRate = round3(budget.budgetHours / budget.budgetQuantity);
    }

    if (budget?.unit && agg.units.size > 0 && !agg.units.has(budget.unit.trim().toLowerCase())) {
      lineReasons.push(
        `The budget line is measured in ${budget.unit} and the hours were booked against ` +
          `${[...agg.units].join(", ")}. Quantities in different units are never added, so this ` +
          "line is reported without an earned figure.",
      );
      plannedUnitRate = null;
    }

    const installedQuantity = agg.quantityRows > 0 ? round3(agg.quantity) : null;
    if (installedQuantity === null) {
      lineReasons.push(
        "No installed quantity was recorded against these hours, so nothing has been earned yet. " +
          "Record progress per cost code per day to make this line measurable.",
      );
    }

    const achievedUnitRate =
      installedQuantity !== null && installedQuantity > 0
        ? round3(agg.hours / installedQuantity)
        : null;
    const earnedHours =
      plannedUnitRate !== null && installedQuantity !== null
        ? round2(installedQuantity * plannedUnitRate)
        : null;
    const productivityFactor =
      earnedHours !== null && agg.hours > 0 ? round3(earnedHours / agg.hours) : null;
    const percentComplete =
      budget?.budgetQuantity && budget.budgetQuantity > 0 && installedQuantity !== null
        ? round2(Math.min(999, (installedQuantity / budget.budgetQuantity) * 100))
        : null;
    const remainingQuantity =
      budget?.budgetQuantity != null && installedQuantity !== null
        ? round3(Math.max(0, budget.budgetQuantity - installedQuantity))
        : null;
    const forecastHoursAtCompletion =
      remainingQuantity !== null && achievedUnitRate !== null
        ? round2(agg.hours + remainingQuantity * achievedUnitRate)
        : null;
    const forecastVarianceHours =
      forecastHoursAtCompletion !== null && budget?.budgetHours != null
        ? round2(forecastHoursAtCompletion - budget.budgetHours)
        : null;

    if (earnedHours !== null) earnedRatePerLine.set(lineId, plannedUnitRate!);

    lines.push({
      budgetLineItemId: lineId,
      code: budget?.code ?? null,
      description: budget?.description ?? "Unknown budget line",
      unit,
      actualHours: agg.hours,
      installedQuantity,
      plannedUnitRate,
      achievedUnitRate,
      earnedHours,
      productivityFactor,
      percentComplete,
      remainingQuantity,
      forecastHoursAtCompletion,
      forecastVarianceHours,
      reasons: lineReasons,
    });
  }

  lines.sort((a, b) => b.actualHours - a.actualHours);

  /* --------------------------- weekly trend ------------------------- */
  const weekMap = new Map<string, { hours: number; earned: number; complete: boolean }>();
  for (const a of allocations) {
    const key = weekStartOf(a.workDate, weekStartsOn);
    const held = weekMap.get(key) ?? { hours: 0, earned: 0, complete: true };
    held.hours = round2(held.hours + a.hours);
    const rate = a.budgetLineItemId ? earnedRatePerLine.get(a.budgetLineItemId) : undefined;
    if (rate !== undefined && a.quantity !== null && a.quantity > 0) {
      held.earned = round2(held.earned + a.quantity * rate);
    } else if (a.hours > 0) {
      held.complete = false;
    }
    weekMap.set(key, held);
  }
  const weeks: ProductivityWeek[] = [...weekMap.entries()]
    .map(([weekStart, v]) => ({
      weekStart,
      actualHours: v.hours,
      earnedHours: v.complete ? round2(v.earned) : null,
      productivityFactor: v.complete && v.hours > 0 ? round3(v.earned / v.hours) : null,
    }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));

  /* ------------------------------ crews ----------------------------- */
  const crewMap = new Map<
    string,
    { name: string | null; hours: number; earned: number; complete: boolean }
  >();
  for (const a of allocations) {
    const key = a.crewId ?? "__none__";
    const held = crewMap.get(key) ?? {
      name: a.crewName ?? null,
      hours: 0,
      earned: 0,
      complete: true,
    };
    if (!held.name && a.crewName) held.name = a.crewName;
    held.hours = round2(held.hours + a.hours);
    const rate = a.budgetLineItemId ? earnedRatePerLine.get(a.budgetLineItemId) : undefined;
    if (rate !== undefined && a.quantity !== null && a.quantity > 0) {
      held.earned = round2(held.earned + a.quantity * rate);
    } else if (a.hours > 0) {
      held.complete = false;
    }
    crewMap.set(key, held);
  }
  const crews: ProductivityCrew[] = [...crewMap.entries()]
    .map(([key, v]) => ({
      crewId: key === "__none__" ? null : key,
      crewName: v.name,
      actualHours: v.hours,
      earnedHours: v.complete ? round2(v.earned) : null,
      productivityFactor: v.complete && v.hours > 0 ? round3(v.earned / v.hours) : null,
    }))
    .sort((a, b) => b.actualHours - a.actualHours);

  /* ----------------------------- totals ----------------------------- */
  const actualHours = round2(lines.reduce((s, l) => s + l.actualHours, 0));
  const measurable = lines.filter((l) => l.earnedHours !== null);
  const unmeasurable = lines.filter((l) => l.earnedHours === null);
  const earnedHours =
    unmeasurable.length === 0 && measurable.length > 0
      ? round2(measurable.reduce((s, l) => s + (l.earnedHours ?? 0), 0))
      : null;
  if (unmeasurable.length > 0) {
    reasons.push(
      `${unmeasurable.length} of ${lines.length} budget line(s) carrying hours could not be earned ` +
        "(no planned rate, no installed quantity, or mismatched units), so the project total is " +
        "stated as unknown rather than as the sum of the measurable ones.",
    );
  }
  const forecastable = lines.filter((l) => l.forecastHoursAtCompletion !== null);
  const forecastHoursAtCompletion =
    forecastable.length === lines.length && lines.length > 0
      ? round2(forecastable.reduce((s, l) => s + (l.forecastHoursAtCompletion ?? 0), 0))
      : null;

  return {
    lines,
    weeks,
    crews,
    totals: {
      actualHours,
      earnedHours,
      productivityFactor:
        earnedHours !== null && actualHours > 0 ? round3(earnedHours / actualHours) : null,
      forecastHoursAtCompletion,
      linesMeasured: measurable.length,
      linesUnmeasurable: unmeasurable.length,
    },
    reasons,
  };
}

/* ------------------------------------------------------------------ */
/* Deviation detector                                                  */
/* ------------------------------------------------------------------ */

/** PF below this for `minWeeks` consecutive weeks is a finding. */
export const PRODUCTIVITY_FLOOR = 0.8;
export const PRODUCTIVITY_MIN_WEEKS = 3;

export interface ProductivityDeviation {
  from: string;
  to: string;
  weeks: number;
  worstFactor: number;
  averageFactor: number;
  lostHours: number;
  explanation: string;
}

/**
 * A run of consecutive measured weeks under the floor. One bad week is
 * weather; three is a method that is not working, and by then it is still
 * cheap to change. Weeks with no measurable PF break the run rather than
 * being counted as good or bad — silence is not evidence.
 */
export function detectProductivityDeviation(
  weeks: ProductivityWeek[],
  options: { floor?: number; minWeeks?: number } = {},
): ProductivityDeviation | null {
  const floor = options.floor ?? PRODUCTIVITY_FLOOR;
  const minWeeks = options.minWeeks ?? PRODUCTIVITY_MIN_WEEKS;
  const ordered = [...weeks].sort((a, b) => a.weekStart.localeCompare(b.weekStart));

  let best: ProductivityWeek[] = [];
  let run: ProductivityWeek[] = [];
  for (const w of ordered) {
    if (w.productivityFactor !== null && w.productivityFactor < floor) {
      run.push(w);
      if (run.length > best.length) best = [...run];
    } else {
      run = [];
    }
  }
  if (best.length < minWeeks) return null;

  const first = best[0]!;
  const last = best[best.length - 1]!;
  const factors = best.map((w) => w.productivityFactor ?? 0);
  const worst = Math.min(...factors);
  const actual = round2(best.reduce((s, w) => s + w.actualHours, 0));
  const earned = round2(best.reduce((s, w) => s + (w.earnedHours ?? 0), 0));
  const average = actual > 0 ? round3(earned / actual) : 0;
  return {
    from: first.weekStart,
    to: last.weekStart,
    weeks: best.length,
    worstFactor: round3(worst),
    averageFactor: average,
    lostHours: round2(actual - earned),
    explanation:
      `Labour productivity has run below ${floor} for ${best.length} consecutive weeks ` +
      `(${first.weekStart} → ${last.weekStart}), averaging ${average} and bottoming at ` +
      `${round3(worst)}. Over that run ${actual} hours produced ${earned} earned hours — ` +
      `${round2(actual - earned)} hours of labour bought no progress. One bad week is weather; ` +
      "three is a method, a sequence or a resourcing problem that will not fix itself, and it is " +
      "still cheap to change now.",
  };
}
