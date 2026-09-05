/**
 * RENTAL AGAINST OWNED — is the fleet cheaper than the hire desk (WP-EQUIP).
 *
 * Pure, no I/O. Given a window of costed machine-days, this answers the only
 * plant-strategy question a contractor actually asks: for THIS class of
 * machine, on THIS job, in THIS currency, are we paying more per productive
 * hour to hire than we are to run our own?
 *
 * The comparison is deliberately hard to make, because a comparison that is
 * easy to make here is a comparison somebody will act on when it is wrong:
 *
 *  · BUCKETED BY (category, currency). A 30-tonne excavator is not a
 *    telehandler, and money is never added across currencies. Two buckets
 *    that differ only by currency are reported separately, never converted.
 *  · COST PER PRODUCTIVE HOUR, not cost per day. A machine that stood for
 *    four of five days did not cost a fifth of the week; it cost the whole
 *    week and produced one day, and cost-per-day hides exactly that.
 *  · REFUSES ON THIN EVIDENCE. Fewer than `MIN_DAYS` machine-days on either
 *    side, or no productive hours on either side, gives `not_comparable`
 *    with the reason — never a ratio computed from two days of data.
 *  · A DAY THAT COULD NOT BE COSTED IS COUNTED AND EXCLUDED, and the count is
 *    reported. Silently dropping uncosted days makes the side with the worse
 *    record look cheaper, which is the wrong way round.
 *
 * What it deliberately does NOT do: depreciation, residual value, financing,
 * standing overhead, or the tax treatment of a lease. Those belong to a
 * capital appraisal, and a screen that mixed them with a 90-day site window
 * would be presenting a purchase decision as an operational one.
 */

export const round2 = (n: number): number => Math.round(n * 100) / 100;
export const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Machine-days on either side before a ratio is stated at all. */
export const MIN_DAYS_TO_COMPARE = 5;

/** Within this band the two are reported as the same, not as a winner. */
export const COMPARABLE_BAND = 0.1;

/** Ownership kinds that mean somebody sends an invoice every week. */
export const HIRED_KINDS = new Set(["hired", "operator_hired", "leased"]);

export interface OwnershipDay {
  equipmentId: string;
  category: string;
  /** EquipmentOwnership */
  ownership: string;
  currency: string;
  workingHours: number;
  idleHours: number;
  standbyHours: number;
  downtimeHours: number;
  availableHours: number | null;
  /** computeDayCost().totalCost — null when nothing could be priced */
  cost: number | null;
  /** computeDayCost().totalIsComplete */
  costIsComplete: boolean;
}

export interface OwnershipSide {
  machines: number;
  days: number;
  workingHours: number;
  /** working + idle + standby: the hours somebody paid for */
  paidHours: number;
  cost: number | null;
  costPerWorkingHour: number | null;
  utilisationPercent: number | null;
  uncostedDays: number;
  partiallyCostedDays: number;
}

export type OwnershipVerdict =
  | "hired_dearer"
  | "owned_dearer"
  | "comparable"
  | "not_comparable";

export interface OwnershipBucket {
  category: string;
  currency: string;
  hired: OwnershipSide;
  owned: OwnershipSide;
  /** hired cost per working hour ÷ owned cost per working hour */
  ratio: number | null;
  verdict: OwnershipVerdict;
  /** money that would have been saved on the hired hours at the owned rate */
  differenceOnHiredHours: number | null;
  reasons: string[];
}

export interface OwnershipComparison {
  buckets: OwnershipBucket[];
  totals: {
    machineDays: number;
    hiredDays: number;
    ownedDays: number;
    uncostedDays: number;
    bucketsCompared: number;
  };
  reasons: string[];
}

function emptySide(): OwnershipSide {
  return {
    machines: 0,
    days: 0,
    workingHours: 0,
    paidHours: 0,
    cost: null,
    costPerWorkingHour: null,
    utilisationPercent: null,
    uncostedDays: 0,
    partiallyCostedDays: 0,
  };
}

function accumulate(days: OwnershipDay[]): OwnershipSide {
  const side = emptySide();
  if (days.length === 0) return side;
  side.machines = new Set(days.map((d) => d.equipmentId)).size;
  side.days = days.length;
  let cost = 0;
  let costedDays = 0;
  let windowHours = 0;
  for (const day of days) {
    side.workingHours = round2(side.workingHours + day.workingHours);
    side.paidHours = round2(
      side.paidHours + day.workingHours + day.idleHours + day.standbyHours,
    );
    const accounted =
      day.workingHours + day.idleHours + day.standbyHours + day.downtimeHours;
    windowHours = round2(
      windowHours + (day.availableHours !== null && day.availableHours > 0
        ? day.availableHours
        : accounted),
    );
    if (day.cost === null) {
      side.uncostedDays += 1;
      continue;
    }
    if (!day.costIsComplete) side.partiallyCostedDays += 1;
    cost = round2(cost + day.cost);
    costedDays += 1;
  }
  side.cost = costedDays > 0 ? cost : null;
  side.costPerWorkingHour =
    side.cost !== null && side.workingHours > 0
      ? round2(side.cost / side.workingHours)
      : null;
  side.utilisationPercent =
    windowHours > 0 ? round2((side.workingHours / windowHours) * 100) : null;
  return side;
}

/**
 * Build the buckets. `days` may contain any mix of categories, currencies and
 * ownership kinds; nothing is merged that should not be.
 */
export function compareOwnership(days: OwnershipDay[]): OwnershipComparison {
  const grouped = new Map<string, OwnershipDay[]>();
  for (const day of days) {
    const key = `${day.category}|${day.currency}`;
    const list = grouped.get(key) ?? [];
    list.push(day);
    grouped.set(key, list);
  }

  const buckets: OwnershipBucket[] = [];
  let hiredDays = 0;
  let ownedDays = 0;
  let uncostedDays = 0;

  for (const [key, list] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const [category = "", currency = ""] = key.split("|");
    const hiredRows = list.filter((d) => HIRED_KINDS.has(d.ownership));
    const ownedRows = list.filter((d) => !HIRED_KINDS.has(d.ownership));
    hiredDays += hiredRows.length;
    ownedDays += ownedRows.length;
    const hired = accumulate(hiredRows);
    const owned = accumulate(ownedRows);
    uncostedDays += hired.uncostedDays + owned.uncostedDays;

    const reasons: string[] = [];
    let verdict: OwnershipVerdict = "not_comparable";
    let ratio: number | null = null;
    let difference: number | null = null;

    if (hired.days === 0) {
      reasons.push(
        `No hired ${category.replace(/_/g, " ")} worked in this window in ${currency}, so there ` +
          "is nothing to compare the owned fleet against.",
      );
    } else if (owned.days === 0) {
      reasons.push(
        `No owned ${category.replace(/_/g, " ")} worked in this window in ${currency}. The hire ` +
          "cost is stated, but there is no in-house rate to test it against — record an internal " +
          "charge-out rate on the owned plant and this becomes answerable.",
      );
    } else if (hired.days < MIN_DAYS_TO_COMPARE || owned.days < MIN_DAYS_TO_COMPARE) {
      reasons.push(
        `Only ${hired.days} hired and ${owned.days} owned machine-day(s) in this window; ` +
          `${MIN_DAYS_TO_COMPARE} of each is the minimum before a rate comparison means anything. ` +
          "A ratio from two days is arithmetic, not evidence.",
      );
    } else if (hired.costPerWorkingHour === null || owned.costPerWorkingHour === null) {
      reasons.push(
        hired.costPerWorkingHour === null
          ? "The hired side has no productive hours or no priced day, so its cost per working " +
            "hour cannot be stated — and a comparison against a missing number is not a comparison."
          : "The owned side has no productive hours or no internal charge-out rate, so its cost " +
            "per working hour cannot be stated. Owned plant with no internal rate reads as free, " +
            "which is the most expensive mistake in a plant department.",
      );
    } else if (owned.costPerWorkingHour === 0) {
      reasons.push(
        "The owned side prices at zero per working hour, which is a missing rate rather than a " +
          "free machine. No ratio is stated.",
      );
    } else {
      ratio = round3(hired.costPerWorkingHour / owned.costPerWorkingHour);
      difference = round2(
        (hired.costPerWorkingHour - owned.costPerWorkingHour) * hired.workingHours,
      );
      if (Math.abs(ratio - 1) <= COMPARABLE_BAND) {
        verdict = "comparable";
        reasons.push(
          `Hiring costs ${hired.costPerWorkingHour} and running our own costs ` +
            `${owned.costPerWorkingHour} per productive hour in ${currency} — within ` +
            `${Math.round(COMPARABLE_BAND * 100)}%, which is not a difference worth restructuring ` +
            "a fleet over.",
        );
      } else if (ratio > 1) {
        verdict = "hired_dearer";
        reasons.push(
          `Hired ${category.replace(/_/g, " ")} cost ${hired.costPerWorkingHour} per productive ` +
            `hour against ${owned.costPerWorkingHour} for the owned fleet — ${ratio}×. Over the ` +
            `${hired.workingHours} hired productive hours in this window that is ${difference} ` +
            `${currency} more than the same hours would have cost in-house, IF the owned machines ` +
            "had been free to do them: owned utilisation here was " +
            `${owned.utilisationPercent === null ? "not computable" : `${owned.utilisationPercent}%`}.`,
        );
      } else {
        verdict = "owned_dearer";
        reasons.push(
          `The owned fleet cost ${owned.costPerWorkingHour} per productive hour against ` +
            `${hired.costPerWorkingHour} hired — ${ratio}×. Owned plant is dearer per hour when it ` +
            "stands: utilisation here was " +
            `${owned.utilisationPercent === null ? "not computable" : `${owned.utilisationPercent}%`}.`,
        );
      }
    }

    if (hired.uncostedDays > 0 || owned.uncostedDays > 0) {
      reasons.push(
        `${hired.uncostedDays + owned.uncostedDays} machine-day(s) in this bucket carried no ` +
          "usable rate and were excluded from the money, not counted as zero.",
      );
    }
    if (hired.partiallyCostedDays > 0 || owned.partiallyCostedDays > 0) {
      reasons.push(
        `${hired.partiallyCostedDays + owned.partiallyCostedDays} day(s) were costed only in ` +
          "part (no operator rate or no fuel cost), so both figures are floors.",
      );
    }

    buckets.push({
      category,
      currency,
      hired,
      owned,
      ratio,
      verdict,
      differenceOnHiredHours: difference,
      reasons,
    });
  }

  const compared = buckets.filter((b) => b.verdict !== "not_comparable").length;
  const reasons: string[] = [];
  if (days.length === 0) {
    reasons.push(
      "No plant day is recorded in this window, so nothing can be compared. This is an absence " +
        "of plant sheets, not an absence of plant cost.",
    );
  } else if (compared === 0) {
    reasons.push(
      "No category has both hired and owned plant with enough costed days to compare. The most " +
        "common cause is owned plant with no internal charge-out rate, which makes the owned " +
        "fleet look free.",
    );
  }
  reasons.push(
    "Depreciation, financing, residual value and standing overhead are deliberately absent: they " +
      "belong to a capital appraisal, and mixing them into a site window presents a purchase " +
      "decision as an operational one.",
  );

  return {
    buckets,
    totals: {
      machineDays: days.length,
      hiredDays,
      ownedDays,
      uncostedDays,
      bucketsCompared: compared,
    },
    reasons,
  };
}
