/**
 * Valuation arithmetic (spec Vol II Domain B #162-167, #179-180, #254).
 *
 * Everything here is pure so the money can be unit-tested without a database:
 * the gross build-up from BQ lines plus typed sections, retention with the
 * contract's cap and releases applied, the net due after the previously
 * certified position, and the statutory payment due date derived from the
 * contract's payment clause.
 */
import type { ContractForm } from "@constructos/shared";

export const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface SectionInput {
  kind: string;
  amountToDate: number;
  retentionApplies: boolean;
}

export interface ValuationTotalsInput {
  /** Σ amountToDate over the BQ valuation lines */
  workDoneToDate: number;
  materialsOnSite: number;
  materialsOffSite: number;
  sections: SectionInput[];
  retentionPercent: number;
  /** cumulative cap on retention held; null = uncapped */
  retentionCap: number | null;
  /** retention already released (taking-over, DNP, bond substitution) */
  retentionReleased: number;
  /** Σ netCertified on the earlier certificates of this BoQ */
  previousNet: number;
}

export interface ValuationTotals {
  workDoneToDate: number;
  materialsOnSite: number;
  materialsOffSite: number;
  sectionsTotal: number;
  /** the amount retention is computed on (contra charges are excluded) */
  retentionBase: number;
  grossTotal: number;
  retentionPercent: number;
  retentionHeld: number;
  retentionCapped: boolean;
  retentionReleased: number;
  previousNet: number;
  netDue: number;
}

/**
 * The application build-up.
 *
 *   gross     = BQ work done + materials on site + materials off site + Σ sections
 *   retention = min(pct × retention base, cap) − released, floored at 0
 *   net due   = gross − retention − previously certified
 *
 * Sections marked `retentionApplies: false` (contra charges, most claims)
 * still move the gross but never the retention base — retaining against a
 * deduction would retain against money that was never paid.
 */
export function computeValuationTotals(input: ValuationTotalsInput): ValuationTotals {
  const workDoneToDate = round2(input.workDoneToDate);
  const materialsOnSite = round2(input.materialsOnSite);
  const materialsOffSite = round2(input.materialsOffSite);
  let sectionsTotal = 0;
  let retainableSections = 0;
  for (const s of input.sections) {
    sectionsTotal += s.amountToDate;
    if (s.retentionApplies) retainableSections += s.amountToDate;
  }
  sectionsTotal = round2(sectionsTotal);
  const grossTotal = round2(
    workDoneToDate + materialsOnSite + materialsOffSite + sectionsTotal,
  );
  const retentionBase = round2(
    workDoneToDate + materialsOnSite + materialsOffSite + round2(retainableSections),
  );
  const uncapped = round2((input.retentionPercent / 100) * Math.max(0, retentionBase));
  const cap = input.retentionCap;
  const capped = cap != null && uncapped > cap;
  const beforeRelease = capped ? round2(cap) : uncapped;
  const released = round2(Math.max(0, input.retentionReleased));
  const retentionHeld = round2(Math.max(0, beforeRelease - released));
  const previousNet = round2(input.previousNet);
  return {
    workDoneToDate,
    materialsOnSite,
    materialsOffSite,
    sectionsTotal,
    retentionBase,
    grossTotal,
    retentionPercent: input.retentionPercent,
    retentionHeld,
    retentionCapped: capped,
    retentionReleased: released,
    previousNet,
    netDue: round2(grossTotal - retentionHeld - previousNet),
  };
}

/**
 * Statutory / contractual payment due date.
 *
 * The days come from the contract when it states them (`paymentDueDays`),
 * otherwise from the standard form's own payment clause. Every answer carries
 * the clause it came from — a due date without a basis is not a due date.
 */
export interface PaymentDueRule {
  days: number;
  basis: string;
}

const FORM_PAYMENT_RULES: Partial<Record<ContractForm, PaymentDueRule>> = {
  fidic_red_2017: {
    days: 56,
    basis: "FIDIC Red 2017 14.7(b): payment within 56 days of the Engineer receiving the Statement and supporting documents",
  },
  fidic_red_1999: {
    days: 56,
    basis: "FIDIC Red 1999 14.7(b): payment within 56 days of the Engineer receiving the Statement",
  },
  fidic_yellow_2017: {
    days: 56,
    basis: "FIDIC Yellow 2017 14.7(b): payment within 56 days of the Engineer receiving the Statement",
  },
  fidic_silver_2017: {
    days: 56,
    basis: "FIDIC Silver 2017 14.7(b): payment within 56 days of the Employer receiving the Statement",
  },
  jct_sbc_2016: {
    days: 21,
    basis: "JCT SBC 2016 4.11: final date for payment is 14 days after the due date, which is 7 days after the interim valuation date",
  },
  jct_db_2016: {
    days: 21,
    basis: "JCT DB 2016 4.9: final date for payment is 14 days after the due date, which is 7 days after the interim valuation date",
  },
  nec4_ecc: {
    days: 21,
    basis: "NEC4 ECC 51.2: payment is made within three weeks of the assessment date unless the Contract Data states otherwise",
  },
  nec3_ecc: {
    days: 21,
    basis: "NEC3 ECC 51.2: payment is made within three weeks of the assessment date unless the Contract Data states otherwise",
  },
};

export function paymentDueRule(
  form: ContractForm | null,
  contractPaymentDueDays: number | null,
): PaymentDueRule | null {
  if (contractPaymentDueDays != null && contractPaymentDueDays > 0) {
    return {
      days: contractPaymentDueDays,
      basis: `Contract particulars: payment within ${contractPaymentDueDays} days of the application date`,
    };
  }
  if (!form) return null;
  return FORM_PAYMENT_RULES[form] ?? null;
}

/**
 * Retention release entitlement at a moment in time (#254 / FIDIC 14.9).
 * Half at taking-over, the balance at the end of the Defects Notification
 * Period, unless the contract states a different first tranche.
 */
export interface RetentionScheduleInput {
  retentionHeld: number;
  takingOverDate: string | null;
  defectsPeriodMonths: number | null;
  releaseAtTakingOver: number;
  asOf: string;
  alreadyReleased: number;
}

export interface RetentionSchedule {
  dueNow: number;
  firstTranche: number;
  firstTrancheDate: string | null;
  secondTranche: number;
  secondTrancheDate: string | null;
  reasons: string[];
}

function addMonthsIso(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}

export function retentionSchedule(input: RetentionScheduleInput): RetentionSchedule {
  const reasons: string[] = [];
  const total = round2(input.retentionHeld + input.alreadyReleased);
  const firstFraction = Math.min(1, Math.max(0, input.releaseAtTakingOver));
  const firstTranche = round2(total * firstFraction);
  const secondTranche = round2(total - firstTranche);
  const firstTrancheDate = input.takingOverDate;
  const secondTrancheDate =
    input.takingOverDate && input.defectsPeriodMonths != null
      ? addMonthsIso(input.takingOverDate, input.defectsPeriodMonths)
      : null;

  let dueNow = 0;
  if (!firstTrancheDate) {
    reasons.push("No taking-over date recorded, so no retention is releasable yet.");
  } else if (input.asOf >= firstTrancheDate) {
    dueNow += firstTranche;
    reasons.push(
      `First tranche (${Math.round(firstFraction * 100)}%) fell due at taking-over on ${firstTrancheDate}.`,
    );
  } else {
    reasons.push(`Taking-over is ${firstTrancheDate}; the first tranche is not yet due.`);
  }
  if (secondTrancheDate && input.asOf >= secondTrancheDate) {
    dueNow += secondTranche;
    reasons.push(`Balance fell due at the end of the Defects Notification Period on ${secondTrancheDate}.`);
  } else if (!secondTrancheDate && firstTrancheDate) {
    reasons.push("No defects period recorded, so the balance release date cannot be computed.");
  }
  dueNow = round2(Math.max(0, dueNow - input.alreadyReleased));
  return {
    dueNow,
    firstTranche,
    firstTrancheDate,
    secondTranche,
    secondTrancheDate,
    reasons,
  };
}

/**
 * Liquidated damages exposure (#249-250). Accrual stops at taking-over /
 * actual completion, and a completed or terminated contract is frozen at its
 * final position rather than accruing forever.
 */
export interface LdInput {
  completionDate: string | null;
  takingOverDate: string | null;
  actualCompletionDate: string | null;
  ldRatePerDay: number | null;
  ldCap: number | null;
  contractStatus: string;
  today: string;
}

export interface LdExposure {
  applicable: boolean;
  reason: string;
  completionDate: string | null;
  accrualEndDate: string | null;
  accrualEndBasis: string | null;
  daysLate: number;
  ldRatePerDay: number | null;
  ldCap: number | null;
  accrued: number;
  capReached: boolean;
  frozen: boolean;
}

function daysBetweenIso(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function computeLdExposure(input: LdInput): LdExposure {
  const base: LdExposure = {
    applicable: false,
    reason: "",
    completionDate: input.completionDate,
    accrualEndDate: null,
    accrualEndBasis: null,
    daysLate: 0,
    ldRatePerDay: input.ldRatePerDay,
    ldCap: input.ldCap,
    accrued: 0,
    capReached: false,
    frozen: false,
  };
  if (input.ldRatePerDay == null || !input.completionDate) {
    return {
      ...base,
      reason:
        input.ldRatePerDay == null
          ? "No delay-damages rate is recorded on the contract."
          : "No contract completion date is recorded.",
    };
  }
  const completionAchieved = input.takingOverDate ?? input.actualCompletionDate;
  let accrualEnd: string;
  let accrualEndBasis: string;
  let frozen = false;
  if (completionAchieved) {
    accrualEnd = completionAchieved;
    accrualEndBasis = input.takingOverDate
      ? `Accrual stopped at taking-over on ${input.takingOverDate}.`
      : `Accrual stopped at actual completion on ${input.actualCompletionDate}.`;
    frozen = true;
  } else if (input.contractStatus === "completed" || input.contractStatus === "terminated") {
    accrualEnd = input.completionDate;
    accrualEndBasis = `Contract is ${input.contractStatus} with no taking-over date recorded; accrual is frozen rather than running to today.`;
    frozen = true;
  } else {
    accrualEnd = input.today;
    accrualEndBasis = "Works are not complete; damages accrue to today.";
  }
  const daysLate = Math.max(0, daysBetweenIso(input.completionDate, accrualEnd));
  const raw = round2(daysLate * input.ldRatePerDay);
  const accrued = input.ldCap != null ? round2(Math.min(raw, input.ldCap)) : raw;
  return {
    applicable: true,
    reason:
      daysLate === 0
        ? "Completion was achieved on or before the contract completion date; no damages accrue."
        : `${daysLate} days late at ${input.ldRatePerDay} per day.`,
    completionDate: input.completionDate,
    accrualEndDate: accrualEnd,
    accrualEndBasis,
    daysLate,
    ldRatePerDay: input.ldRatePerDay,
    ldCap: input.ldCap,
    accrued,
    capReached: input.ldCap != null && raw >= input.ldCap,
    frozen,
  };
}
