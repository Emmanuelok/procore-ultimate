/**
 * RESOURCE PRODUCTIVITY, HOURS FORECASTING AND THE MEASURED MILE — pure, no
 * I/O (spec Vol I #691–699).
 *
 * The cost report says what the labour COST. This says whether it bought any
 * progress, which is a different question and the only one still actionable
 * while the job is running.
 *
 * The arithmetic, stated once:
 *
 *     plannedUnitRate   = budgetHours ÷ budgetQuantity        (h per unit)
 *     earnedHours       = installedQuantity × plannedUnitRate
 *     achievedUnitRate  = actualHours ÷ installedQuantity
 *     productivityFactor= earnedHours ÷ actualHours           (PF; >1 is good)
 *
 * Every one of those is NULL when an input is missing, and the reason is
 * carried with it. A budget line with no planned hours has no PF; it does not
 * have a PF of 1.0 and it certainly does not have a PF of 0. A forecast built
 * on lines that quietly defaulted reads as confident and is not.
 *
 * WHY THIS ENGINE EXISTS ALONGSIDE THE TIMECARD ONE. The timecards module
 * earns hours per BUDGET LINE, which is the cost view. This one earns them
 * per RESOURCE TYPE, CREW and WEEK, which is the resourcing view — the axis a
 * measured-mile argument and an hours-at-completion forecast are built on.
 * Both read the same allocations; neither restates the other's numbers.
 */
import type { HoursForecastMethod } from "@constructos/shared";
import { round2, round3, weekStartOf } from "./calendar.js";

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

/** One coded allocation of hours, optionally carrying installed quantity. */
export interface ProductivityAllocation {
  workDate: string;
  hours: number;
  quantity: number | null;
  unit: string | null;
  budgetLineItemId: string | null;
  crewId: string | null;
  crewName: string | null;
  resourceTypeId: string | null;
  resourceTypeName: string | null;
}

/** The planned side: the hours and quantity a budget line was set up with. */
export interface PlannedLine {
  id: string;
  code: string | null;
  description: string;
  budgetHours: number | null;
  budgetQuantity: number | null;
  unit: string | null;
}

/* ------------------------------------------------------------------ */
/* Outputs                                                             */
/* ------------------------------------------------------------------ */

export interface ProductivityBucket {
  key: string;
  label: string;
  actualHours: number;
  /** null when ANY hours in the bucket could not be earned — never partial */
  earnedHours: number | null;
  productivityFactor: number | null;
  installedQuantity: number | null;
  unit: string | null;
  achievedUnitRate: number | null;
  plannedUnitRate: number | null;
  unearnableHours: number;
  reasons: string[];
}

export interface ProductivityWeek extends ProductivityBucket {
  weekStart: string;
}

export interface ResourceProductivityReport {
  weeks: ProductivityWeek[];
  byResourceType: ProductivityBucket[];
  byCrew: ProductivityBucket[];
  totals: {
    actualHours: number;
    earnedHours: number | null;
    productivityFactor: number | null;
    unearnableHours: number;
    allocationsConsidered: number;
    linesMeasured: number;
    linesUnmeasurable: number;
  };
  reasons: string[];
}

export interface ComputeProductivityOptions {
  weekStartsOn?: number;
}

const normaliseUnit = (unit: string | null): string | null =>
  unit ? unit.trim().toLowerCase() : null;

interface EarnRate {
  rate: number;
  unit: string | null;
  plannedUnitRate: number;
}

/**
 * The earn rate for each budget line — hours per unit — or the reason there
 * is none. Built once and reused by every breakdown so the week view and the
 * crew view can never disagree about what an hour was worth.
 */
function buildEarnRates(planned: PlannedLine[]): {
  rates: Map<string, EarnRate>;
  unmeasurable: Map<string, string>;
} {
  const rates = new Map<string, EarnRate>();
  const unmeasurable = new Map<string, string>();
  for (const line of planned) {
    if (line.budgetHours === null || line.budgetQuantity === null) {
      unmeasurable.set(
        line.id,
        `Budget line ${line.code ?? line.id} carries ` +
          (line.budgetHours === null ? "no planned hours" : "no planned quantity") +
          ", so a planned unit rate cannot be derived and its hours are unknown rather than 100% " +
          "productive.",
      );
      continue;
    }
    if (line.budgetQuantity <= 0) {
      unmeasurable.set(
        line.id,
        `Budget line ${line.code ?? line.id} has a planned quantity of zero, so a unit rate is undefined.`,
      );
      continue;
    }
    rates.set(line.id, {
      rate: line.budgetHours / line.budgetQuantity,
      unit: normaliseUnit(line.unit),
      plannedUnitRate: round3(line.budgetHours / line.budgetQuantity),
    });
  }
  return { rates, unmeasurable };
}

interface Accumulator {
  label: string;
  hours: number;
  earned: number;
  unearnable: number;
  quantity: number;
  quantityRows: number;
  units: Set<string>;
  plannedRates: Set<number>;
  reasons: Set<string>;
}

function emptyAccumulator(label: string): Accumulator {
  return {
    label,
    hours: 0,
    earned: 0,
    unearnable: 0,
    quantity: 0,
    quantityRows: 0,
    units: new Set(),
    plannedRates: new Set(),
    reasons: new Set(),
  };
}

function finish(key: string, acc: Accumulator): ProductivityBucket {
  const installedQuantity = acc.quantityRows > 0 ? round3(acc.quantity) : null;
  const unit = acc.units.size === 1 ? [...acc.units][0]! : null;
  if (acc.units.size > 1) {
    acc.reasons.add(
      `Quantities were booked in ${[...acc.units].join(", ")}. Quantities in different units are ` +
        "never added, so no single installed quantity or achieved rate is stated here.",
    );
  }
  const earnable = acc.unearnable <= 0.001;
  const earnedHours = earnable ? round2(acc.earned) : null;
  return {
    key,
    label: acc.label,
    actualHours: round2(acc.hours),
    earnedHours,
    productivityFactor: earnedHours !== null && acc.hours > 0 ? round3(earnedHours / acc.hours) : null,
    installedQuantity: acc.units.size > 1 ? null : installedQuantity,
    unit,
    achievedUnitRate:
      acc.units.size <= 1 && installedQuantity !== null && installedQuantity > 0
        ? round3(acc.hours / installedQuantity)
        : null,
    plannedUnitRate: acc.plannedRates.size === 1 ? round3([...acc.plannedRates][0]!) : null,
    unearnableHours: round2(acc.unearnable),
    reasons: [...acc.reasons],
  };
}

/**
 * Earned hours, productivity factor and achieved unit rates, broken down by
 * week, resource type and crew.
 */
export function computeResourceProductivity(
  allocations: ProductivityAllocation[],
  planned: PlannedLine[],
  options: ComputeProductivityOptions = {},
): ResourceProductivityReport {
  const weekStartsOn = options.weekStartsOn ?? 1;
  const { rates, unmeasurable } = buildEarnRates(planned);
  const reasons: string[] = [];

  const weeks = new Map<string, Accumulator>();
  const types = new Map<string, Accumulator>();
  const crews = new Map<string, Accumulator>();
  const linesSeen = new Set<string>();
  const linesUnmeasurable = new Set<string>();

  let totalHours = 0;
  let totalEarned = 0;
  let totalUnearnable = 0;
  let uncodedHours = 0;

  for (const alloc of allocations) {
    const hours = Number.isFinite(alloc.hours) ? alloc.hours : 0;
    if (hours <= 0 && (alloc.quantity ?? 0) <= 0) continue;

    const week = weekStartOf(alloc.workDate, weekStartsOn);
    const weekAcc = weeks.get(week) ?? emptyAccumulator(`Week beginning ${week}`);
    const typeKey = alloc.resourceTypeId ?? "__unmapped__";
    const typeAcc =
      types.get(typeKey) ??
      emptyAccumulator(alloc.resourceTypeName ?? "Not mapped to a resource type");
    const crewKey = alloc.crewId ?? "__nocrew__";
    const crewAcc = crews.get(crewKey) ?? emptyAccumulator(alloc.crewName ?? "No crew recorded");

    for (const acc of [weekAcc, typeAcc, crewAcc]) {
      acc.hours = round2(acc.hours + hours);
    }
    totalHours = round2(totalHours + hours);

    const lineId = alloc.budgetLineItemId;
    if (!lineId) {
      uncodedHours = round2(uncodedHours + hours);
      const reason =
        "Hours with no budget line cannot be earned against anything, so they are counted as " +
        "spent and excluded from every productivity figure.";
      for (const acc of [weekAcc, typeAcc, crewAcc]) {
        acc.unearnable = round2(acc.unearnable + hours);
        acc.reasons.add(reason);
      }
      totalUnearnable = round2(totalUnearnable + hours);
    } else {
      linesSeen.add(lineId);
      const rate = rates.get(lineId);
      if (!rate) {
        linesUnmeasurable.add(lineId);
        const reason =
          unmeasurable.get(lineId) ??
          `No budget line was found for ${lineId}, so there is nothing to earn its hours against.`;
        for (const acc of [weekAcc, typeAcc, crewAcc]) {
          acc.unearnable = round2(acc.unearnable + hours);
          acc.reasons.add(reason);
        }
        totalUnearnable = round2(totalUnearnable + hours);
      } else {
        const allocUnit = normaliseUnit(alloc.unit);
        if (rate.unit && allocUnit && rate.unit !== allocUnit) {
          linesUnmeasurable.add(lineId);
          const reason =
            `Budget line ${lineId} is measured in ${rate.unit} and hours were booked against ` +
            `${allocUnit}. Quantities in different units are never converted here.`;
          for (const acc of [weekAcc, typeAcc, crewAcc]) {
            acc.unearnable = round2(acc.unearnable + hours);
            acc.reasons.add(reason);
          }
          totalUnearnable = round2(totalUnearnable + hours);
        } else if (alloc.quantity === null || alloc.quantity <= 0) {
          const reason =
            "Some hours carry no installed quantity, so they have earned nothing yet. Record " +
            "progress per cost code per day to make them measurable.";
          for (const acc of [weekAcc, typeAcc, crewAcc]) {
            acc.unearnable = round2(acc.unearnable + hours);
            acc.reasons.add(reason);
          }
          totalUnearnable = round2(totalUnearnable + hours);
        } else {
          const earned = alloc.quantity * rate.rate;
          for (const acc of [weekAcc, typeAcc, crewAcc]) {
            acc.earned = round2(acc.earned + earned);
            acc.quantity = round3(acc.quantity + alloc.quantity);
            acc.quantityRows += 1;
            acc.plannedRates.add(rate.plannedUnitRate);
            if (allocUnit) acc.units.add(allocUnit);
            else if (rate.unit) acc.units.add(rate.unit);
          }
          totalEarned = round2(totalEarned + earned);
        }
      }
    }

    weeks.set(week, weekAcc);
    types.set(typeKey, typeAcc);
    crews.set(crewKey, crewAcc);
  }

  if (uncodedHours > 0) {
    reasons.push(
      `${uncodedHours} hour(s) in this window carry no budget line and are excluded from every ` +
        "productivity figure. Hours nobody coded cannot be earned against anything.",
    );
  }
  if (linesUnmeasurable.size > 0) {
    reasons.push(
      `${linesUnmeasurable.size} of ${linesSeen.size} budget line(s) carrying hours have no ` +
        "derivable planned rate, so totals that depend on them are stated as unknown rather than " +
        "as the sum of the measurable ones.",
    );
  }
  if (allocations.length === 0) {
    reasons.push(
      "No coded labour hours were found in this window, so nothing can be measured. Productivity " +
        "is computed from timecard allocations: hours, a cost code and an installed quantity.",
    );
  }

  const weekRows: ProductivityWeek[] = [...weeks.entries()]
    .map(([weekStart, acc]) => ({ ...finish(weekStart, acc), weekStart }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));

  const earnedTotal = totalUnearnable <= 0.001 ? round2(totalEarned) : null;

  return {
    weeks: weekRows,
    byResourceType: [...types.entries()]
      .map(([key, acc]) => finish(key, acc))
      .sort((a, b) => b.actualHours - a.actualHours),
    byCrew: [...crews.entries()]
      .map(([key, acc]) => finish(key, acc))
      .sort((a, b) => b.actualHours - a.actualHours),
    totals: {
      actualHours: totalHours,
      earnedHours: earnedTotal,
      productivityFactor:
        earnedTotal !== null && totalHours > 0 ? round3(earnedTotal / totalHours) : null,
      unearnableHours: totalUnearnable,
      allocationsConsidered: allocations.length,
      linesMeasured: linesSeen.size - linesUnmeasurable.size,
      linesUnmeasurable: linesUnmeasurable.size,
    },
    reasons,
  };
}

/* ------------------------------------------------------------------ */
/* Hours at completion                                                 */
/* ------------------------------------------------------------------ */

export interface ForecastInput {
  budgetHours: number | null;
  actualHours: number;
  earnedHours: number | null;
  /** for the remaining-quantity method */
  budgetQuantity?: number | null;
  installedQuantity?: number | null;
  /** an explicit override for method = manual */
  manualForecastHours?: number | null;
}

export interface ForecastResult {
  method: HoursForecastMethod;
  budgetHours: number | null;
  actualHours: number;
  earnedHours: number | null;
  productivityFactor: number | null;
  percentComplete: number | null;
  remainingHours: number | null;
  forecastHoursAtCompletion: number | null;
  varianceHours: number | null;
  confidence: "low" | "medium" | "high" | null;
  basis: string;
  reasons: string[];
}

/** Below this many actual hours a PF is too thin to extrapolate from. */
export const MIN_HOURS_FOR_CONFIDENT_FORECAST = 200;

/**
 * Forecast hours at completion by one of four named methods. The method is
 * an input rather than a choice this function makes, because "which method"
 * is a commercial judgement that has to be stated on the record — a forecast
 * whose method silently changed between two reports is worse than no
 * forecast.
 */
export function forecastHoursAtCompletion(
  input: ForecastInput,
  method: HoursForecastMethod,
): ForecastResult {
  const reasons: string[] = [];
  const actualHours = round2(input.actualHours);
  const earnedHours = input.earnedHours === null ? null : round2(input.earnedHours);
  const productivityFactor =
    earnedHours !== null && actualHours > 0 ? round3(earnedHours / actualHours) : null;
  const percentComplete =
    earnedHours !== null && input.budgetHours !== null && input.budgetHours > 0
      ? round2(Math.min(999, (earnedHours / input.budgetHours) * 100))
      : null;

  let forecast: number | null = null;
  let basis = "";

  if (method === "manual") {
    forecast = input.manualForecastHours ?? null;
    basis =
      forecast === null
        ? "A manual forecast was selected but no figure was supplied."
        : `Manually set to ${round2(forecast)} hours.`;
    if (forecast === null) reasons.push(basis);
  } else if (method === "productivity_factor") {
    if (input.budgetHours === null) {
      reasons.push(
        "No budgeted hours are recorded, so the budget cannot be divided by the productivity " +
          "factor. Set planned hours on the budget lines this work is coded to.",
      );
      basis = "Not derivable: no budgeted hours.";
    } else if (productivityFactor === null) {
      reasons.push(
        "No productivity factor could be computed for this scope, so extrapolating from it would " +
          "be inventing one. Record installed quantities against the hours.",
      );
      basis = "Not derivable: no productivity factor.";
    } else if (productivityFactor <= 0) {
      reasons.push(
        "The productivity factor is zero — hours have been spent and nothing has been earned — so " +
          "dividing by it is undefined. This is itself the finding.",
      );
      basis = "Not derivable: productivity factor is zero.";
    } else {
      forecast = round2(input.budgetHours / productivityFactor);
      basis =
        `${round2(input.budgetHours)} budgeted hours ÷ a productivity factor of ` +
        `${productivityFactor} achieved over ${actualHours} hours worked. The rest of the job is ` +
        "assumed to run at the rate the job has run at so far.";
    }
  } else if (method === "remaining_quantity") {
    const budgetQuantity = input.budgetQuantity ?? null;
    const installedQuantity = input.installedQuantity ?? null;
    if (budgetQuantity === null || installedQuantity === null) {
      reasons.push(
        "The remaining-quantity method needs both a planned quantity and an installed quantity; " +
          "at least one is missing.",
      );
      basis = "Not derivable: quantities missing.";
    } else if (installedQuantity <= 0) {
      reasons.push(
        "Nothing has been installed yet, so no achieved unit rate exists to project the remainder at.",
      );
      basis = "Not derivable: nothing installed.";
    } else {
      const achieved = actualHours / installedQuantity;
      const remaining = Math.max(0, budgetQuantity - installedQuantity);
      forecast = round2(actualHours + remaining * achieved);
      basis =
        `${actualHours} hours have installed ${round3(installedQuantity)} units — ` +
        `${round3(achieved)} h/unit achieved. The remaining ${round3(remaining)} units are ` +
        "projected at that same achieved rate.";
    }
  } else {
    /* planned_burn */
    if (input.budgetHours === null || earnedHours === null) {
      reasons.push(
        "The planned-burn method needs budgeted hours and earned hours; at least one is missing.",
      );
      basis = "Not derivable: budgeted or earned hours missing.";
    } else {
      const remaining = Math.max(0, input.budgetHours - earnedHours);
      forecast = round2(actualHours + remaining);
      basis =
        `${actualHours} hours spent plus the ${round2(remaining)} budgeted hours not yet earned. ` +
        "This assumes the remainder runs exactly to plan, which is optimistic whenever the " +
        "productivity factor to date is below 1.";
      if (productivityFactor !== null && productivityFactor < 1) {
        reasons.push(
          `The productivity factor to date is ${productivityFactor}. Planned burn assumes it ` +
            "returns to 1.0 for the rest of the job — say why, or use the productivity-factor method.",
        );
      }
    }
  }

  const remainingHours = forecast !== null ? round2(Math.max(0, forecast - actualHours)) : null;
  const varianceHours =
    forecast !== null && input.budgetHours !== null ? round2(forecast - input.budgetHours) : null;

  let confidence: "low" | "medium" | "high" | null = null;
  if (forecast !== null) {
    if (actualHours < MIN_HOURS_FOR_CONFIDENT_FORECAST) {
      confidence = "low";
      reasons.push(
        `Only ${actualHours} hours have been worked. A rate extrapolated from less than ` +
          `${MIN_HOURS_FOR_CONFIDENT_FORECAST} hours moves sharply with each new week; treat this ` +
          "as an early indication rather than a forecast.",
      );
    } else if (percentComplete !== null && percentComplete >= 20) {
      confidence = "high";
    } else {
      confidence = "medium";
    }
  }

  return {
    method,
    budgetHours: input.budgetHours,
    actualHours,
    earnedHours,
    productivityFactor,
    percentComplete,
    remainingHours,
    forecastHoursAtCompletion: forecast,
    varianceHours,
    confidence,
    basis,
    reasons,
  };
}

/* ------------------------------------------------------------------ */
/* Measured mile                                                       */
/* ------------------------------------------------------------------ */

export interface MeasuredMileWeek {
  weekStart: string;
  actualHours: number;
  earnedHours: number | null;
  productivityFactor: number | null;
}

export interface MeasuredMilePeriod {
  from: string;
  to: string;
  weeks: number;
  actualHours: number;
  earnedHours: number;
  productivityFactor: number;
}

export interface MeasuredMileResult {
  mile: MeasuredMilePeriod | null;
  impacted: MeasuredMilePeriod | null;
  /** hours the impacted period would not have needed at the mile's rate */
  lostHours: number | null;
  lostHoursPercent: number | null;
  measuredWeeks: number;
  unmeasurableWeeks: number;
  explanation: string;
  reasons: string[];
}

export const MEASURED_MILE_MIN_WEEKS = 3;

/**
 * The measured-mile comparison (SCL Protocol part B, spec #697–699).
 *
 * The benchmark is the LONGEST run of consecutive measured weeks whose
 * average productivity factor is the best available — a period the project
 * demonstrably achieved, on this job, with this crew, so no industry norm has
 * to be argued about. Everything else measured is the impacted period, and
 * the loss is the hours the impacted work would not have needed at the
 * benchmark rate.
 *
 * Weeks with no measurable PF BREAK a run rather than being counted good or
 * bad. Silence is not evidence, and a mile that quietly spans a fortnight
 * nobody recorded quantities for is exactly the sort of number that collapses
 * under cross-examination.
 */
export function measuredMile(
  weeks: MeasuredMileWeek[],
  options: { minWeeks?: number } = {},
): MeasuredMileResult {
  const minWeeks = options.minWeeks ?? MEASURED_MILE_MIN_WEEKS;
  const ordered = [...weeks].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  const reasons: string[] = [];

  const measured = ordered.filter(
    (w) => w.productivityFactor !== null && w.earnedHours !== null && w.actualHours > 0,
  );
  const unmeasurable = ordered.length - measured.length;
  if (unmeasurable > 0) {
    reasons.push(
      `${unmeasurable} of ${ordered.length} week(s) have no measurable productivity factor and are ` +
        "excluded. They break a run rather than being treated as good or bad weeks.",
    );
  }

  /* Every maximal run of consecutive measured weeks. */
  const runs: MeasuredMileWeek[][] = [];
  let current: MeasuredMileWeek[] = [];
  for (const week of ordered) {
    if (week.productivityFactor !== null && week.earnedHours !== null && week.actualHours > 0) {
      current.push(week);
    } else if (current.length > 0) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length > 0) runs.push(current);

  const candidates: MeasuredMilePeriod[] = [];
  for (const run of runs) {
    /* Every window of at least minWeeks inside the run is a candidate mile. */
    for (let start = 0; start < run.length; start += 1) {
      for (let end = start + minWeeks - 1; end < run.length; end += 1) {
        const slice = run.slice(start, end + 1);
        const actual = round2(slice.reduce((s, w) => s + w.actualHours, 0));
        const earned = round2(slice.reduce((s, w) => s + (w.earnedHours ?? 0), 0));
        if (actual <= 0) continue;
        candidates.push({
          from: slice[0]!.weekStart,
          to: slice[slice.length - 1]!.weekStart,
          weeks: slice.length,
          actualHours: actual,
          earnedHours: earned,
          productivityFactor: round3(earned / actual),
        });
      }
    }
  }

  if (candidates.length === 0) {
    return {
      mile: null,
      impacted: null,
      lostHours: null,
      lostHoursPercent: null,
      measuredWeeks: measured.length,
      unmeasurableWeeks: unmeasurable,
      explanation:
        `No measured mile exists: a benchmark needs ${minWeeks} consecutive weeks with a ` +
        "computable productivity factor, and this window has none. Record installed quantities " +
        "against coded hours week by week — without them there is no unimpacted period to " +
        "compare anything to.",
      reasons,
    };
  }

  /* Best PF first; on a tie prefer the longer, then the earlier window. */
  candidates.sort(
    (a, b) =>
      b.productivityFactor - a.productivityFactor ||
      b.weeks - a.weeks ||
      a.from.localeCompare(b.from),
  );
  const mile = candidates[0]!;

  const impactedWeeks = measured.filter((w) => w.weekStart < mile.from || w.weekStart > mile.to);
  if (impactedWeeks.length === 0) {
    return {
      mile,
      impacted: null,
      lostHours: null,
      lostHoursPercent: null,
      measuredWeeks: measured.length,
      unmeasurableWeeks: unmeasurable,
      explanation:
        `The measured mile runs ${mile.from} → ${mile.to} at a productivity factor of ` +
        `${mile.productivityFactor}, and every measured week falls inside it. There is no ` +
        "impacted period to compare against, so no disruption loss is claimed.",
      reasons,
    };
  }

  const impactedActual = round2(impactedWeeks.reduce((s, w) => s + w.actualHours, 0));
  const impactedEarned = round2(impactedWeeks.reduce((s, w) => s + (w.earnedHours ?? 0), 0));
  const impacted: MeasuredMilePeriod = {
    from: impactedWeeks[0]!.weekStart,
    to: impactedWeeks[impactedWeeks.length - 1]!.weekStart,
    weeks: impactedWeeks.length,
    actualHours: impactedActual,
    earnedHours: impactedEarned,
    productivityFactor: impactedActual > 0 ? round3(impactedEarned / impactedActual) : 0,
  };

  const hoursAtMileRate = mile.productivityFactor > 0 ? impactedEarned / mile.productivityFactor : null;
  const lostHours = hoursAtMileRate === null ? null : round2(impactedActual - hoursAtMileRate);
  const lostHoursPercent =
    lostHours !== null && impactedActual > 0 ? round2((lostHours / impactedActual) * 100) : null;

  if (lostHours !== null && lostHours < 0) {
    reasons.push(
      "The impacted period outperformed the measured mile, so no loss is computed from it. That " +
        "usually means the benchmark window was itself disrupted — pick the period deliberately " +
        "rather than accepting the automatic one.",
    );
  }

  return {
    mile,
    impacted,
    lostHours,
    lostHoursPercent,
    measuredWeeks: measured.length,
    unmeasurableWeeks: unmeasurable,
    explanation:
      `The measured mile runs ${mile.from} → ${mile.to} (${mile.weeks} weeks): ${mile.actualHours} ` +
      `hours produced ${mile.earnedHours} earned hours, a productivity factor of ` +
      `${mile.productivityFactor}. Over the ${impacted.weeks} other measured week(s) ` +
      `(${impacted.from} → ${impacted.to}) ${impacted.actualHours} hours produced ` +
      `${impacted.earnedHours} earned hours, a factor of ${impacted.productivityFactor}. At the ` +
      `mile's rate that work would have taken ${hoursAtMileRate === null ? "—" : round2(hoursAtMileRate)} ` +
      `hours, so ${lostHours === null ? "—" : lostHours} hours` +
      (lostHoursPercent === null ? "" : ` (${lostHoursPercent}% of the impacted hours)`) +
      " bought no additional progress. This is the arithmetic, not the causation: the cause of the " +
      "disruption is evidenced elsewhere and this figure quantifies it only once that link is made.",
    reasons,
  };
}

/* ------------------------------------------------------------------ */
/* Sustained-shortfall detector                                        */
/* ------------------------------------------------------------------ */

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
 * weather; three is a method, a sequence or a resourcing problem that will
 * not fix itself — and it is still cheap to change. Unmeasurable weeks break
 * the run rather than counting as good or bad.
 */
export function detectSustainedShortfall(
  weeks: MeasuredMileWeek[],
  options: { floor?: number; minWeeks?: number } = {},
): ProductivityDeviation | null {
  const floor = options.floor ?? PRODUCTIVITY_FLOOR;
  const minWeeks = options.minWeeks ?? PRODUCTIVITY_MIN_WEEKS;
  const ordered = [...weeks].sort((a, b) => a.weekStart.localeCompare(b.weekStart));

  let best: MeasuredMileWeek[] = [];
  let run: MeasuredMileWeek[] = [];
  for (const week of ordered) {
    if (week.productivityFactor !== null && week.productivityFactor < floor) {
      run.push(week);
      if (run.length > best.length) best = [...run];
    } else {
      run = [];
    }
  }
  if (best.length < minWeeks) return null;

  const first = best[0]!;
  const last = best[best.length - 1]!;
  const actual = round2(best.reduce((s, w) => s + w.actualHours, 0));
  const earned = round2(best.reduce((s, w) => s + (w.earnedHours ?? 0), 0));
  const worst = round3(Math.min(...best.map((w) => w.productivityFactor ?? 0)));
  const average = actual > 0 ? round3(earned / actual) : 0;
  return {
    from: first.weekStart,
    to: last.weekStart,
    weeks: best.length,
    worstFactor: worst,
    averageFactor: average,
    lostHours: round2(actual - earned),
    explanation:
      `Labour productivity has run below ${floor} for ${best.length} consecutive weeks ` +
      `(${first.weekStart} → ${last.weekStart}), averaging ${average} and bottoming at ${worst}. ` +
      `Over that run ${actual} hours produced ${earned} earned hours — ${round2(actual - earned)} ` +
      "hours of labour bought no progress.",
  };
}

export { round2, round3 };
