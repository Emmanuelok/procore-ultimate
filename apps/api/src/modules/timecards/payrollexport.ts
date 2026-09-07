/**
 * PAYROLL EXPORT AND CERTIFIED PAYROLL — pure, no I/O (#615).
 *
 * A payroll export is a legal statement about what people are owed, so this
 * file has two rules that override tidiness:
 *
 *  1. A CELL THE PLATFORM CANNOT FILL IS EMPTY, NOT ZERO. An unpriced
 *     overtime hour exports as a blank rate and the row is listed in
 *     `incompleteRows`; it never exports as 0.00, which reads as "worked for
 *     nothing" and would be paid as such.
 *  2. THE EXPORT CARRIES ITS OWN PROVENANCE. Batch reference, period, the
 *     count of rows and the reasons any of them are incomplete travel with
 *     the file, because the person who opens it in a payroll bureau three
 *     weeks later has no other way to know.
 *
 * CSV quoting is RFC 4180: quotes doubled, fields containing a comma, quote
 * or newline wrapped. Nothing here trusts a description not to contain a
 * comma.
 */

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** RFC 4180 field. Also neutralises a leading =/+/-/@ so a name cannot
 *  become a formula when the bureau opens the file in a spreadsheet. */
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvRow(cells: Array<string | number | null | undefined>): string {
  return cells.map(csvField).join(",");
}

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

export interface PayrollCard {
  id: string;
  reference: string;
  workDate: string;
  shift: string;
  workerId: string;
  workerReference: string;
  workerName: string;
  vendorId: string | null;
  vendorName: string | null;
  crewReference: string | null;
  trade: string | null;
  classification: string | null;
  regularHours: number;
  overtimeHours: number;
  doubleTimeHours: number;
  premiumHours: number;
  premiumKind: string;
  totalHours: number;
  hourlyRate: number | null;
  overtimeRate: number | null;
  doubleTimeRate: number | null;
  premiumRate: number | null;
  burdenRate: number | null;
  totalCost: number | null;
  currency: string;
  status: string;
  /** cost coding, summarised — used by the generic export's code column */
  costCodes: string[];
}

export interface PayrollExportContext {
  projectName: string;
  projectId: string;
  batchReference: string | null;
  periodStart: string;
  periodEnd: string;
  payrollBatchRef: string | null;
  generatedAt: string;
  /** the legal entity making the certification, for certified payroll */
  contractorName?: string | null;
  contractNumber?: string | null;
}

export interface PayrollExport {
  format: string;
  filename: string;
  contentType: string;
  body: string;
  rowCount: number;
  /** references of rows the export could not fully price */
  incompleteRows: string[];
  reasons: string[];
  currencies: string[];
}

const HOUR_BUCKETS = ["regular", "overtime", "double_time", "premium"] as const;

/* ------------------------------------------------------------------ */
/* 1. Generic per-worker-per-period CSV                                */
/* ------------------------------------------------------------------ */

export function buildGenericCsv(
  cards: PayrollCard[],
  ctx: PayrollExportContext,
): PayrollExport {
  const byWorker = new Map<string, PayrollCard[]>();
  for (const c of cards) {
    const list = byWorker.get(c.workerId) ?? [];
    list.push(c);
    byWorker.set(c.workerId, list);
  }

  const header = [
    "worker_reference",
    "worker_name",
    "employer",
    "trade",
    "classification",
    "period_start",
    "period_end",
    "days",
    "regular_hours",
    "overtime_hours",
    "double_time_hours",
    "premium_hours",
    "total_hours",
    "regular_rate",
    "overtime_rate",
    "double_time_rate",
    "premium_rate",
    "gross_amount",
    "currency",
    "cost_codes",
    "source_timecards",
  ];

  const lines = [csvRow(header)];
  const incomplete: string[] = [];
  const currencies = new Set<string>();

  for (const [, list] of byWorker) {
    const first = list[0]!;
    currencies.add(first.currency);
    const sum = (pick: (c: PayrollCard) => number) =>
      round2(list.reduce((s, c) => s + pick(c), 0));
    const uncosted = list.filter((c) => c.totalCost === null);
    if (uncosted.length > 0) incomplete.push(...uncosted.map((c) => c.reference));
    const distinctRate = (pick: (c: PayrollCard) => number | null): number | null => {
      const vals = [...new Set(list.map(pick).filter((v): v is number => v !== null))];
      return vals.length === 1 ? vals[0]! : null;
    };
    lines.push(
      csvRow([
        first.workerReference,
        first.workerName,
        first.vendorName ?? "",
        first.trade ?? "",
        first.classification ?? "",
        ctx.periodStart,
        ctx.periodEnd,
        new Set(list.map((c) => c.workDate)).size,
        sum((c) => c.regularHours),
        sum((c) => c.overtimeHours),
        sum((c) => c.doubleTimeHours),
        sum((c) => c.premiumHours),
        sum((c) => c.totalHours),
        distinctRate((c) => c.hourlyRate),
        distinctRate((c) => c.overtimeRate),
        distinctRate((c) => c.doubleTimeRate),
        distinctRate((c) => c.premiumRate),
        uncosted.length > 0 ? "" : sum((c) => c.totalCost ?? 0),
        first.currency,
        [...new Set(list.flatMap((c) => c.costCodes))].join(" "),
        list.map((c) => c.reference).join(" "),
      ]),
    );
  }

  return {
    format: "generic_csv",
    filename: `payroll-${ctx.batchReference ?? ctx.periodEnd}.csv`,
    contentType: "text/csv; charset=utf-8",
    body: lines.join("\n") + "\n",
    rowCount: byWorker.size,
    incompleteRows: [...new Set(incomplete)],
    currencies: [...currencies],
    reasons: exportReasons(incomplete, currencies),
  };
}

/* ------------------------------------------------------------------ */
/* 2. One row per worker per day                                       */
/* ------------------------------------------------------------------ */

export function buildDailyCsv(cards: PayrollCard[], ctx: PayrollExportContext): PayrollExport {
  const header = [
    "work_date",
    "shift",
    "worker_reference",
    "worker_name",
    "employer",
    "crew",
    "trade",
    "classification",
    "regular_hours",
    "overtime_hours",
    "double_time_hours",
    "premium_hours",
    "premium_kind",
    "total_hours",
    "regular_rate",
    "overtime_rate",
    "double_time_rate",
    "burden_rate",
    "amount",
    "currency",
    "cost_codes",
    "timecard_reference",
    "status",
  ];
  const incomplete: string[] = [];
  const currencies = new Set<string>();
  const rows = [...cards].sort(
    (a, b) => a.workDate.localeCompare(b.workDate) || a.workerReference.localeCompare(b.workerReference),
  );
  const lines = [csvRow(header)];
  for (const c of rows) {
    currencies.add(c.currency);
    if (c.totalCost === null) incomplete.push(c.reference);
    lines.push(
      csvRow([
        c.workDate,
        c.shift,
        c.workerReference,
        c.workerName,
        c.vendorName ?? "",
        c.crewReference ?? "",
        c.trade ?? "",
        c.classification ?? "",
        c.regularHours,
        c.overtimeHours,
        c.doubleTimeHours,
        c.premiumHours,
        c.premiumKind,
        c.totalHours,
        c.hourlyRate,
        c.overtimeRate,
        c.doubleTimeRate,
        c.burdenRate,
        c.totalCost,
        c.currency,
        c.costCodes.join(" "),
        c.reference,
        c.status,
      ]),
    );
  }
  return {
    format: "daily_csv",
    filename: `payroll-daily-${ctx.batchReference ?? ctx.periodEnd}.csv`,
    contentType: "text/csv; charset=utf-8",
    body: lines.join("\n") + "\n",
    rowCount: rows.length,
    incompleteRows: [...new Set(incomplete)],
    currencies: [...currencies],
    reasons: exportReasons(incomplete, currencies),
  };
}

/* ------------------------------------------------------------------ */
/* 3. Certified payroll (WH-347 shape)                                 */
/* ------------------------------------------------------------------ */

export interface CertifiedPayrollRow {
  workerReference: string;
  workerName: string;
  classification: string | null;
  /** hours per calendar day of the week, in the week's date order */
  dayHours: Array<{ date: string; regular: number; overtime: number }>;
  totalRegularHours: number;
  totalOvertimeHours: number;
  regularRate: number | null;
  overtimeRate: number | null;
  grossAmount: number | null;
  currency: string;
  /** payroll-side figures, only where a payroll entry has been ingested */
  deductions: number | null;
  netPay: number | null;
  incomplete: string[];
}

export interface CertifiedPayrollReport {
  projectName: string;
  projectId: string;
  contractorName: string | null;
  contractNumber: string | null;
  weekEnding: string;
  periodStart: string;
  periodEnd: string;
  weekDates: string[];
  rows: CertifiedPayrollRow[];
  /** the statement of compliance is NOT auto-signed — see the note */
  statementOfCompliance: {
    signed: false;
    note: string;
  };
  reasons: string[];
}

/**
 * A US Department of Labor WH-347 style certified payroll.
 *
 * The statement of compliance is deliberately NOT pre-signed. Signing it is
 * a personal criminal representation by a named officer that every worker was
 * paid the full prevailing wage with no unlawful deduction; a platform that
 * pre-ticks it is manufacturing a false certification. The report assembles
 * the evidence and leaves the signature to a person.
 *
 * `payrollByWorker` carries the deduction and net-pay columns, which live on
 * ingested payroll entries rather than on timecards. Where a worker has no
 * payroll entry the columns are empty and the row is marked incomplete —
 * a certified payroll with invented deductions is worse than a late one.
 */
export function buildCertifiedPayroll(
  cards: PayrollCard[],
  ctx: PayrollExportContext & { weekEnding: string },
  payrollByWorker: Map<string, { deductions: number; netPay: number; currency: string }>,
): CertifiedPayrollReport {
  const dates = [...new Set(cards.map((c) => c.workDate))].sort();
  const byWorker = new Map<string, PayrollCard[]>();
  for (const c of cards) {
    const list = byWorker.get(c.workerId) ?? [];
    list.push(c);
    byWorker.set(c.workerId, list);
  }

  const rows: CertifiedPayrollRow[] = [];
  const reasons: string[] = [];

  for (const [workerId, list] of byWorker) {
    const first = list[0]!;
    const incomplete: string[] = [];
    const dayHours = dates.map((date) => {
      const onDay = list.filter((c) => c.workDate === date);
      return {
        date,
        regular: round2(onDay.reduce((s, c) => s + c.regularHours + c.premiumHours, 0)),
        overtime: round2(onDay.reduce((s, c) => s + c.overtimeHours + c.doubleTimeHours, 0)),
      };
    });
    const classifications = [...new Set(list.map((c) => c.classification).filter(Boolean))];
    if (classifications.length === 0) {
      incomplete.push(
        "no wage classification is recorded, and a certified payroll is a statement about the " +
          "classification as much as the hours",
      );
    } else if (classifications.length > 1) {
      incomplete.push(
        `the week carries ${classifications.length} different classifications ` +
          `(${classifications.join(", ")}); WH-347 needs one line per classification`,
      );
    }
    const rates = [...new Set(list.map((c) => c.hourlyRate).filter((v): v is number => v !== null))];
    if (rates.length === 0) {
      incomplete.push("no hourly rate is held, so the gross cannot be stated");
    }
    const uncosted = list.filter((c) => c.totalCost === null);
    if (uncosted.length > 0) {
      incomplete.push(
        `${uncosted.length} card(s) could not be costed (${uncosted.map((c) => c.reference).join(", ")})`,
      );
    }
    const pay = payrollByWorker.get(workerId) ?? null;
    if (!pay) {
      incomplete.push(
        "no payroll entry has been ingested for this worker, so deductions and net pay are blank",
      );
    } else if (pay.currency !== first.currency) {
      incomplete.push(
        `the timecards are in ${first.currency} and the payroll entry in ${pay.currency}; money is ` +
          "never converted here",
      );
    }

    rows.push({
      workerReference: first.workerReference,
      workerName: first.workerName,
      classification: classifications[0] ?? null,
      dayHours,
      totalRegularHours: round2(dayHours.reduce((s, d) => s + d.regular, 0)),
      totalOvertimeHours: round2(dayHours.reduce((s, d) => s + d.overtime, 0)),
      regularRate: rates.length === 1 ? rates[0]! : null,
      overtimeRate:
        [...new Set(list.map((c) => c.overtimeRate).filter((v): v is number => v !== null))]
          .length === 1
          ? list.find((c) => c.overtimeRate !== null)!.overtimeRate
          : null,
      grossAmount: uncosted.length > 0 ? null : round2(list.reduce((s, c) => s + (c.totalCost ?? 0), 0)),
      currency: first.currency,
      deductions: pay && pay.currency === first.currency ? round2(pay.deductions) : null,
      netPay: pay && pay.currency === first.currency ? round2(pay.netPay) : null,
      incomplete,
    });
  }

  const incompleteCount = rows.filter((r) => r.incomplete.length > 0).length;
  if (incompleteCount > 0) {
    reasons.push(
      `${incompleteCount} of ${rows.length} worker line(s) are incomplete. A certified payroll is a ` +
        "criminal representation when it is signed; every blank below has to be filled from the " +
        "employer's own records before anybody signs it.",
    );
  }

  return {
    projectName: ctx.projectName,
    projectId: ctx.projectId,
    contractorName: ctx.contractorName ?? null,
    contractNumber: ctx.contractNumber ?? null,
    weekEnding: ctx.weekEnding,
    periodStart: ctx.periodStart,
    periodEnd: ctx.periodEnd,
    weekDates: dates,
    rows: rows.sort((a, b) => a.workerReference.localeCompare(b.workerReference)),
    statementOfCompliance: {
      signed: false,
      note:
        "The statement of compliance on a WH-347 is a personal representation, made under penalty " +
        "of law, that every person listed was paid the full weekly wage earned with no unlawful " +
        "deduction and no rebate. This platform assembles the evidence; it does not sign. A named " +
        "officer signs, after checking the lines marked incomplete.",
    },
    reasons,
  };
}

/** Render the certified payroll as CSV in the WH-347 column order. */
export function certifiedPayrollToCsv(report: CertifiedPayrollReport): PayrollExport {
  const header = [
    "worker_reference",
    "worker_name",
    "classification",
    ...report.weekDates.flatMap((d) => [`${d}_regular`, `${d}_overtime`]),
    "total_regular_hours",
    "total_overtime_hours",
    "regular_rate",
    "overtime_rate",
    "gross_amount",
    "deductions",
    "net_pay",
    "currency",
    "incomplete_because",
  ];
  const lines = [csvRow(header)];
  for (const r of report.rows) {
    lines.push(
      csvRow([
        r.workerReference,
        r.workerName,
        r.classification,
        ...r.dayHours.flatMap((d) => [d.regular, d.overtime]),
        r.totalRegularHours,
        r.totalOvertimeHours,
        r.regularRate,
        r.overtimeRate,
        r.grossAmount,
        r.deductions,
        r.netPay,
        r.currency,
        r.incomplete.join("; "),
      ]),
    );
  }
  return {
    format: "certified_payroll",
    filename: `certified-payroll-${report.weekEnding}.csv`,
    contentType: "text/csv; charset=utf-8",
    body: lines.join("\n") + "\n",
    rowCount: report.rows.length,
    incompleteRows: report.rows.filter((r) => r.incomplete.length > 0).map((r) => r.workerReference),
    currencies: [...new Set(report.rows.map((r) => r.currency))],
    reasons: report.reasons,
  };
}

function exportReasons(incomplete: string[], currencies: Set<string>): string[] {
  const reasons: string[] = [];
  if (incomplete.length > 0) {
    reasons.push(
      `${new Set(incomplete).size} row(s) carry hours the platform holds no rate for. Their amount ` +
        "column is EMPTY, not zero, and they are listed in incompleteRows — an empty cell gets " +
        "queried by the bureau, a zero gets paid.",
    );
  }
  if (currencies.size > 1) {
    reasons.push(
      `This export spans ${[...currencies].join(", ")}. Money is never summed across currencies: ` +
        "run one export per currency before sending anything to a bureau.",
    );
  }
  return reasons;
}

export const PAYROLL_HOUR_BUCKETS = HOUR_BUCKETS;
