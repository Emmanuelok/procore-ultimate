/**
 * Availability-payment (PPP unitary charge) mechanism — spec Vol II Domain O.
 *
 * A concession earns its unitary charge in full only when the asset is both
 * AVAILABLE and PERFORMING. This module turns a period's unavailability
 * events and performance failure points into the deduction the payment
 * mechanism actually produces:
 *
 *   availability deduction = charge × availabilityWeight × weighted-unavailable-hours / requiredHours
 *   performance  deduction = charge × performanceWeight × points × pointValue
 *   total deduction        = min(sum, cap)          (cap optional)
 *   net payment            = charge − total deduction
 *
 * WEIGHTING. Each unavailability event carries an area weight: a plant room
 * out of service is not the same loss as a ward. A weight of 1 means the
 * whole asset. Weights above 1 are refused by the caller's schema — an event
 * cannot cost more than the asset.
 *
 * Deliberately not modelled: ratchet mechanisms that escalate deductions for
 * repeated failure, and the availability/performance interaction rules some
 * contracts use (a failure that is both). Both are contract-specific and
 * would be invented rather than derived. Persistent breach is REPORTED (the
 * points threshold) so the reader can apply the contract's own remedy.
 */

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

export interface UnavailabilityEvent {
  /** the area or system that was unavailable */
  area: string;
  /** hours it was unavailable within the period */
  hours: number;
  /** share of the asset the area represents, 0..1 (1 = the whole asset) */
  weight: number;
  note?: string | null;
}

export interface AvailabilityModelInput {
  unitaryCharge: number;
  currency: string;
  availabilityWeightPercent: number;
  performanceWeightPercent: number;
  performancePointValuePercent: number;
  deductionCapPercent: number | null;
  persistentBreachPoints: number | null;
}

export interface AvailabilityPeriodInput {
  requiredHours: number;
  events: UnavailabilityEvent[];
  performancePoints: number;
}

export interface AvailabilityPaymentResult {
  currency: string;
  grossCharge: number;
  /** Σ hours × weight, in "whole-asset hours" */
  weightedUnavailableHours: number;
  requiredHours: number;
  /** 0..1 — the share of the period the asset was effectively available */
  availabilityRatio: number | null;
  availabilityDeduction: number;
  performanceDeduction: number;
  /** the deduction before any cap */
  rawDeduction: number;
  totalDeduction: number;
  capApplied: boolean;
  netPayment: number;
  persistentBreach: boolean;
  warnings: string[];
  basis: string;
}

/**
 * Compute one period's payment.
 *
 * `requiredHours` of zero makes the availability deduction UNCOMPUTABLE
 * rather than zero: a period nobody was required to be available for cannot
 * have an availability failure, and pretending the ratio is 1 would silently
 * pay a full charge for a period with no service obligation. The result says
 * so in `warnings` and leaves `availabilityRatio` null.
 */
export function computeAvailabilityPayment(
  model: AvailabilityModelInput,
  period: AvailabilityPeriodInput,
): AvailabilityPaymentResult {
  const warnings: string[] = [];
  const charge = model.unitaryCharge;

  const weightedUnavailableHours = round4(
    period.events.reduce((s, e) => s + Math.max(0, e.hours) * Math.max(0, e.weight), 0),
  );

  let availabilityRatio: number | null = null;
  let availabilityDeduction = 0;
  if (period.requiredHours <= 0) {
    warnings.push(
      "No required availability hours are recorded for this period, so no availability deduction " +
        "can be computed. The availability element of the charge is neither deducted nor confirmed.",
    );
  } else {
    const unavailableShare = Math.min(1, weightedUnavailableHours / period.requiredHours);
    availabilityRatio = round4(1 - unavailableShare);
    availabilityDeduction = round2(
      charge * (model.availabilityWeightPercent / 100) * unavailableShare,
    );
    if (weightedUnavailableHours > period.requiredHours) {
      warnings.push(
        `Weighted unavailable hours (${weightedUnavailableHours}) exceed the required hours ` +
          `(${period.requiredHours}); the deduction is capped at the whole availability element ` +
          `rather than allowed to exceed it.`,
      );
    }
  }

  const points = Math.max(0, period.performancePoints);
  const performanceDeduction = round2(
    charge *
      (model.performanceWeightPercent / 100) *
      Math.min(1, points * (model.performancePointValuePercent / 100)),
  );
  if (points * (model.performancePointValuePercent / 100) > 1) {
    warnings.push(
      `Performance failure points (${points}) exceed the whole performance element of the charge; ` +
        `the deduction is capped at that element.`,
    );
  }

  const rawDeduction = round2(availabilityDeduction + performanceDeduction);
  const cap =
    model.deductionCapPercent === null
      ? null
      : round2(charge * (model.deductionCapPercent / 100));
  const capApplied = cap !== null && rawDeduction > cap;
  const totalDeduction = capApplied ? cap! : rawDeduction;
  if (capApplied) {
    warnings.push(
      `The computed deduction of ${rawDeduction} exceeds the contractual cap of ${cap} ` +
        `(${model.deductionCapPercent}% of the charge) and has been limited to it. The uncapped ` +
        `figure is reported so the shortfall is visible.`,
    );
  }

  const persistentBreach =
    model.persistentBreachPoints !== null && points >= model.persistentBreachPoints;
  if (persistentBreach) {
    warnings.push(
      `Performance failure points (${points}) reached the persistent-breach threshold ` +
        `(${model.persistentBreachPoints}). The contract's warning-notice remedy is engaged; this ` +
        `module reports the fact and does not apply it.`,
    );
  }

  return {
    currency: model.currency,
    grossCharge: round2(charge),
    weightedUnavailableHours,
    requiredHours: period.requiredHours,
    availabilityRatio,
    availabilityDeduction,
    performanceDeduction,
    rawDeduction,
    totalDeduction,
    capApplied,
    netPayment: round2(charge - totalDeduction),
    persistentBreach,
    warnings,
    basis:
      `Unitary charge ${round2(charge)} ${model.currency}. Availability element ` +
      `${model.availabilityWeightPercent}% deducted pro rata to weighted unavailable hours ` +
      `(${weightedUnavailableHours} of ${period.requiredHours} required). Performance element ` +
      `${model.performanceWeightPercent}% deducted at ${model.performancePointValuePercent}% of ` +
      `the charge per failure point (${points} points). ` +
      (cap === null ? "No deduction cap." : `Deduction capped at ${cap}.`) +
      " Ratchets and availability/performance interaction rules are not modelled.",
  };
}
