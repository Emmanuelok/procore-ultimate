/**
 * THREE-WAY LABOUR RECONCILIATION — pure, no I/O.
 *
 * The platform holds three independent statements about the same worker on
 * the same days, made by three different parties for three different reasons:
 *
 *   1. TIMECARDS — what the site says was worked and APPROVED (our claim).
 *   2. PAYROLL   — what the employer says was PAID (their claim).
 *   3. SITE ACCESS — what the turnstile recorded (nobody's claim).
 *
 * Two-way reconciliation (payroll vs access) catches the ghost worker. The
 * third leg catches the two failures that cost the most and are never seen:
 *
 *   • HOURS PAID THAT NOBODY APPROVED — the employer invoiced hours the site
 *     never signed for. That is a commercial leak, and it is recoverable.
 *   • HOURS APPROVED THAT NOBODY PAID — we certified the hours, the worker
 *     did not get the money. That is a labour-rights breach, and it is the
 *     one a lender asks about.
 *
 * A missing leg is never treated as a zero. A worker with no payroll entry in
 * the window is "not yet paid for" with a reason, not "paid nothing"; a
 * period whose payroll has not landed produces no finding at all until it is
 * older than the grace period, because accusing an employer of non-payment on
 * the day the period ends is how a control gets switched off.
 */

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface LabourPositionWorker {
  workerId: string;
  reference: string;
  fullName: string;
  vendorId: string | null;
  vendorName: string | null;
  /** hours on cards that reached approved/locked/exported in the window */
  approvedHours: number;
  /** distinct dates with an approved card */
  approvedDays: number;
  /** hours on cards still in draft/submitted — not yet a claim on anyone */
  pendingHours: number;
  /** cost of the approved cards, null when any card could not be costed */
  approvedCost: number | null;
  timecardCurrency: string | null;
  /** the batch payroll references the approved cards were exported under */
  payrollBatchRefs: string[];
  /** hours the payroll file says were paid; null when the file omits hours */
  paidHours: number | null;
  paidDays: number;
  grossPay: number | null;
  payrollCurrency: string | null;
  /** latest payment date across the window's payroll entries */
  paidAt: string | null;
  payrollEntryCount: number;
  /** distinct days the turnstile saw this worker */
  accessDays: number;
  /** the crew membership rate the cost report was built on */
  crewHourlyRate: number | null;
}

export interface LabourPositionFinding {
  detector: string;
  severity: "critical" | "high" | "medium";
  workerId: string;
  reference: string;
  vendorId: string | null;
  title: string;
  explanation: string;
  amountAtRisk: number | null;
  currency: string | null;
  inputs: Record<string, unknown>;
}

export interface LabourPositionRow extends LabourPositionWorker {
  /** paidHours − approvedHours, null when either leg is missing */
  hoursDifference: number | null;
  /** the implied rate the employer actually paid, per hour */
  impliedHourlyRate: number | null;
  status:
    | "reconciled"
    | "paid_over_approved"
    | "approved_not_paid"
    | "rate_below_crew"
    | "awaiting_payroll"
    | "not_comparable";
  reasons: string[];
}

export interface LabourPositionSummary {
  periodStart: string;
  periodEnd: string;
  workers: number;
  rows: LabourPositionRow[];
  findings: LabourPositionFinding[];
  /** money at risk, bucketed by currency — never summed across them */
  moneyAtRisk: Array<{ currency: string; overpaid: number; unpaid: number }>;
  totals: {
    approvedHours: number;
    paidHours: number | null;
    accessDays: number;
    workersAwaitingPayroll: number;
  };
  reasons: string[];
}

/** Days after period end before an unpaid approved week is a finding. */
export const PAYROLL_GRACE_DAYS = 14;
/** Hours tolerance before an approved-vs-paid gap is worth naming. */
export const HOURS_TOLERANCE = 1;

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export function computeLabourPosition(
  workers: LabourPositionWorker[],
  options: { periodStart: string; periodEnd: string; asOf: string },
): LabourPositionSummary {
  const rows: LabourPositionRow[] = [];
  const findings: LabourPositionFinding[] = [];
  const reasons: string[] = [];
  const money = new Map<string, { overpaid: number; unpaid: number }>();
  const bucket = (currency: string) => {
    let b = money.get(currency);
    if (!b) {
      b = { overpaid: 0, unpaid: 0 };
      money.set(currency, b);
    }
    return b;
  };

  const sinceEnd = daysBetween(options.periodEnd, options.asOf);

  for (const w of workers) {
    const rowReasons: string[] = [];
    let status: LabourPositionRow["status"] = "reconciled";

    const impliedHourlyRate =
      w.grossPay !== null && w.paidHours !== null && w.paidHours > 0
        ? round2(w.grossPay / w.paidHours)
        : null;

    let hoursDifference: number | null = null;
    if (w.paidHours === null) {
      rowReasons.push(
        w.payrollEntryCount === 0
          ? "No payroll entry has landed for this worker in the window, so nothing can be compared " +
            "against the approved hours yet."
          : "The payroll file carried days but no hours, so hours cannot be compared. Ask the " +
            "employer to include hours, or compare on days.",
      );
      status = w.payrollEntryCount === 0 ? "awaiting_payroll" : "not_comparable";
    } else {
      hoursDifference = round2(w.paidHours - w.approvedHours);
    }

    /* --- currency mismatch makes money incomparable --- */
    const currency = w.payrollCurrency ?? w.timecardCurrency;
    if (
      w.payrollCurrency &&
      w.timecardCurrency &&
      w.payrollCurrency !== w.timecardCurrency
    ) {
      rowReasons.push(
        `The timecards are in ${w.timecardCurrency} and the payroll in ${w.payrollCurrency}. Money ` +
          "is never converted here, so no money-at-risk figure is stated for this worker.",
      );
    }
    const comparableMoney =
      !w.payrollCurrency || !w.timecardCurrency || w.payrollCurrency === w.timecardCurrency;

    /* --- 1. paid more than was ever approved --- */
    if (hoursDifference !== null && hoursDifference > HOURS_TOLERANCE) {
      status = "paid_over_approved";
      const rate = impliedHourlyRate ?? w.crewHourlyRate;
      const amount = rate !== null && comparableMoney ? round2(hoursDifference * rate) : null;
      if (amount !== null && currency) bucket(currency).overpaid = round2(bucket(currency).overpaid + amount);
      findings.push({
        detector: "labour_hours_paid_never_approved",
        severity: hoursDifference > w.approvedHours * 0.25 ? "high" : "medium",
        workerId: w.workerId,
        reference: w.reference,
        vendorId: w.vendorId,
        title: `${w.reference}: ${hoursDifference} h paid that the site never approved`,
        explanation:
          `Payroll for ${options.periodStart} → ${options.periodEnd} paid ${w.paidHours} hour(s) ` +
          `for ${w.fullName} (${w.reference}). The site approved ${w.approvedHours} hour(s) on ` +
          `timecards over the same window — a difference of +${hoursDifference} hour(s)` +
          `${amount !== null ? `, worth about ${currency} ${amount} at the rate actually paid` : ""}. ` +
          "Hours nobody on site signed for are hours the employer cannot evidence, and on a " +
          "reimbursable or T&M package they are recoverable. Check whether cards were raised and " +
          "never submitted before treating this as an overclaim.",
        amountAtRisk: amount,
        currency: amount !== null ? currency : null,
        inputs: {
          paidHours: w.paidHours,
          approvedHours: w.approvedHours,
          pendingHours: w.pendingHours,
          differenceHours: hoursDifference,
          accessDays: w.accessDays,
          impliedHourlyRate,
          periodStart: options.periodStart,
          periodEnd: options.periodEnd,
        },
      });
    }

    /* --- 2. approved and exported, but never paid --- */
    const unpaid =
      w.approvedHours > 0 &&
      (w.payrollEntryCount === 0 || (hoursDifference !== null && hoursDifference < -HOURS_TOLERANCE));
    if (unpaid && sinceEnd > PAYROLL_GRACE_DAYS) {
      status = "approved_not_paid";
      const shortHours =
        hoursDifference !== null ? round2(-hoursDifference) : round2(w.approvedHours);
      const rate = w.crewHourlyRate ?? impliedHourlyRate;
      const amount = rate !== null && comparableMoney ? round2(shortHours * rate) : null;
      if (amount !== null && currency) bucket(currency).unpaid = round2(bucket(currency).unpaid + amount);
      findings.push({
        detector: "labour_approved_never_paid",
        severity: w.payrollEntryCount === 0 ? "critical" : "high",
        workerId: w.workerId,
        reference: w.reference,
        vendorId: w.vendorId,
        title: `${w.reference}: ${shortHours} h approved on site with no matching payment`,
        explanation:
          `${w.fullName} (${w.reference}) has ${w.approvedHours} approved hour(s) for ` +
          `${options.periodStart} → ${options.periodEnd}` +
          `${w.payrollBatchRefs.length > 0 ? `, exported to payroll as ${w.payrollBatchRefs.join(", ")}` : ""}. ` +
          `${
            w.payrollEntryCount === 0
              ? "No payroll entry has been filed for this worker at all"
              : `The payroll filed covers only ${w.paidHours} hour(s)`
          }, and the period ended ${sinceEnd} day(s) ago. We certified these hours: if the worker ` +
          "was not paid for them, that is our exposure as much as the employer's, and it is the " +
          "first question a labour audit asks.",
        amountAtRisk: amount,
        currency: amount !== null ? currency : null,
        inputs: {
          approvedHours: w.approvedHours,
          paidHours: w.paidHours,
          payrollEntries: w.payrollEntryCount,
          payrollBatchRefs: w.payrollBatchRefs,
          daysSincePeriodEnd: sinceEnd,
          periodStart: options.periodStart,
          periodEnd: options.periodEnd,
        },
      });
    } else if (unpaid) {
      rowReasons.push(
        `The period ended ${sinceEnd} day(s) ago and payroll is allowed ${PAYROLL_GRACE_DAYS} days ` +
          "to land, so no non-payment finding has been made yet.",
      );
      status = "awaiting_payroll";
    }

    /* --- 3. paid below the rate the cost report was built on --- */
    if (
      impliedHourlyRate !== null &&
      w.crewHourlyRate !== null &&
      comparableMoney &&
      impliedHourlyRate < w.crewHourlyRate * 0.95
    ) {
      if (status === "reconciled") status = "rate_below_crew";
      const gap = round2(w.crewHourlyRate - impliedHourlyRate);
      const amount = w.paidHours !== null ? round2(gap * w.paidHours) : null;
      if (amount !== null && currency) bucket(currency).unpaid = round2(bucket(currency).unpaid + amount);
      findings.push({
        detector: "labour_pay_rate_below_crew_rate",
        severity: impliedHourlyRate < w.crewHourlyRate * 0.75 ? "high" : "medium",
        workerId: w.workerId,
        reference: w.reference,
        vendorId: w.vendorId,
        title: `${w.reference} was paid ${currency ?? ""} ${impliedHourlyRate}/h against a crew rate of ${w.crewHourlyRate}/h`,
        explanation:
          `The cost report prices ${w.fullName}'s hours at ${w.crewHourlyRate} per hour — the rate ` +
          `on the crew membership, which is where a prevailing-wage classification lives. Payroll ` +
          `paid ${w.grossPay} for ${w.paidHours} hour(s), an implied ${impliedHourlyRate} per hour: ` +
          `${gap} per hour less${amount !== null ? `, ${currency} ${amount} across the window` : ""}. ` +
          "Either the worker is being underpaid against the classification we costed, or the cost " +
          "report is overstating labour. Both are worth ten minutes.",
        amountAtRisk: amount,
        currency: amount !== null ? currency : null,
        inputs: {
          impliedHourlyRate,
          crewHourlyRate: w.crewHourlyRate,
          gapPerHour: gap,
          paidHours: w.paidHours,
          grossPay: w.grossPay,
        },
      });
    }

    rows.push({
      ...w,
      hoursDifference,
      impliedHourlyRate,
      status,
      reasons: rowReasons,
    });
  }

  const paidLegs = rows.filter((r) => r.paidHours !== null);
  if (paidLegs.length < rows.length) {
    reasons.push(
      `${rows.length - paidLegs.length} of ${rows.length} worker(s) have no comparable payroll ` +
        "hours in this window, so the paid total is stated as unknown rather than as a partial sum.",
    );
  }

  return {
    periodStart: options.periodStart,
    periodEnd: options.periodEnd,
    workers: rows.length,
    rows,
    findings,
    moneyAtRisk: [...money.entries()]
      .map(([currency, v]) => ({ currency, overpaid: v.overpaid, unpaid: v.unpaid }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
    totals: {
      approvedHours: round2(rows.reduce((s, r) => s + r.approvedHours, 0)),
      paidHours:
        paidLegs.length === rows.length && rows.length > 0
          ? round2(rows.reduce((s, r) => s + (r.paidHours ?? 0), 0))
          : null,
      accessDays: rows.reduce((s, r) => s + r.accessDays, 0),
      workersAwaitingPayroll: rows.filter((r) => r.status === "awaiting_payroll").length,
    },
    reasons,
  };
}
