/**
 * WAGE AND WORKING-TIME RULE LIBRARY — pure, code-resident (Vol II M
 * #678–682).
 *
 * A working-time limit without the instrument it comes from is an opinion,
 * and an opinion is not something you accuse an employer with. So every
 * limit in this file carries `citation`: the statute, directive or standard
 * it is read from. When a project names no jurisdiction the engine returns a
 * REFUSAL (`null` + reasons), never a default — 8 hours a day is Californian,
 * 40 a week is federal, 48 a week is the Working Time Directive, and running
 * a Gulf payroll under any of them produces a finding that is simply wrong.
 *
 * Minimum wages MOVE. The figures below are the rates the platform was last
 * updated with, each stamped with `rateAsOf`; a comparison made against a
 * stale rate is reported as `stale: true` with the date, so nobody quotes an
 * out-of-date threshold as though it were today's law. A tenant that needs a
 * current figure supplies it as an override on the run.
 *
 * What this file deliberately does NOT do: compute payroll. It compares what
 * was worked and what was paid against the limits, and states the gap.
 */

/* ------------------------------------------------------------------ */
/* The library                                                         */
/* ------------------------------------------------------------------ */

export interface MinimumWage {
  amount: number;
  currency: string;
  unit: "hour" | "day" | "month";
  /** the day the figure below was correct */
  rateAsOf: string;
}

export interface WageJurisdiction {
  key: string;
  name: string;
  /** hours in a day beyond which the day itself is a breach */
  maxDailyHours: number | null;
  /** hours in a rolling/pay week beyond which the week is a breach */
  maxWeeklyHours: number | null;
  /**
   * Consecutive days that may be worked before a rest day is owed. Six means
   * "one day off in seven"; a seventh consecutive day is the breach.
   */
  maxConsecutiveWorkDays: number | null;
  /** minimum uninterrupted rest between two shifts */
  minRestHoursBetweenShifts: number | null;
  /** days after the pay period ends by which wages must be paid */
  wagePaymentDueDays: number | null;
  /** the share of gross pay that may lawfully be deducted */
  maxDeductionPercent: number | null;
  minimumWage: MinimumWage | null;
  /** true where the jurisdiction bans worker-paid recruitment fees outright */
  recruitmentFeesProhibited: boolean;
  citation: string;
}

/**
 * The library. Keys are lower-case ISO 3166 alpha-2, optionally with a
 * subdivision (`us-ca`), plus the two supranational standards that contracts
 * actually cite.
 */
export const WAGE_JURISDICTIONS: readonly WageJurisdiction[] = [
  {
    key: "gb",
    name: "United Kingdom",
    maxDailyHours: null,
    maxWeeklyHours: 48,
    maxConsecutiveWorkDays: 12,
    minRestHoursBetweenShifts: 11,
    wagePaymentDueDays: 31,
    maxDeductionPercent: 10,
    minimumWage: { amount: 11.44, currency: "GBP", unit: "hour", rateAsOf: "2024-04-01" },
    recruitmentFeesProhibited: true,
    citation:
      "Working Time Regulations 1998 regs 4 (48-hour average week), 10-11 (daily and weekly rest); " +
      "National Minimum Wage Act 1998; Employment Rights Act 1996 Part II (deductions)",
  },
  {
    key: "ie",
    name: "Ireland",
    maxDailyHours: null,
    maxWeeklyHours: 48,
    maxConsecutiveWorkDays: 12,
    minRestHoursBetweenShifts: 11,
    wagePaymentDueDays: 31,
    maxDeductionPercent: 10,
    minimumWage: { amount: 12.7, currency: "EUR", unit: "hour", rateAsOf: "2024-01-01" },
    recruitmentFeesProhibited: true,
    citation:
      "Organisation of Working Time Act 1997 ss 11-13, 15; National Minimum Wage Act 2000; " +
      "Payment of Wages Act 1991",
  },
  {
    key: "eu",
    name: "European Union (Working Time Directive baseline)",
    maxDailyHours: 13,
    maxWeeklyHours: 48,
    maxConsecutiveWorkDays: 12,
    minRestHoursBetweenShifts: 11,
    wagePaymentDueDays: 31,
    maxDeductionPercent: null,
    minimumWage: null,
    recruitmentFeesProhibited: true,
    citation: "Directive 2003/88/EC arts 3, 5, 6 (rest, weekly rest, maximum weekly working time)",
  },
  {
    key: "us",
    name: "United States (FLSA federal floor)",
    maxDailyHours: null,
    maxWeeklyHours: null,
    maxConsecutiveWorkDays: null,
    minRestHoursBetweenShifts: null,
    wagePaymentDueDays: 16,
    maxDeductionPercent: null,
    minimumWage: { amount: 7.25, currency: "USD", unit: "hour", rateAsOf: "2009-07-24" },
    recruitmentFeesProhibited: false,
    citation:
      "Fair Labor Standards Act 29 U.S.C. §§206-207 (minimum wage, overtime after 40 hours). " +
      "The FLSA caps no hours: an excessive-hours finding under it would be wrong, so none is made.",
  },
  {
    key: "us-ca",
    name: "United States — California",
    maxDailyHours: 12,
    maxWeeklyHours: 72,
    maxConsecutiveWorkDays: 6,
    minRestHoursBetweenShifts: null,
    wagePaymentDueDays: 10,
    maxDeductionPercent: null,
    minimumWage: { amount: 16, currency: "USD", unit: "hour", rateAsOf: "2024-01-01" },
    recruitmentFeesProhibited: false,
    citation:
      "California Labor Code §§510 (daily overtime and double time), 551-552 (one day's rest in " +
      "seven), 204 (semi-monthly payment); IWC Wage Order 16 (construction)",
  },
  {
    key: "ae",
    name: "United Arab Emirates",
    maxDailyHours: 10,
    maxWeeklyHours: 48,
    maxConsecutiveWorkDays: 6,
    minRestHoursBetweenShifts: 12,
    wagePaymentDueDays: 15,
    maxDeductionPercent: 20,
    minimumWage: null,
    recruitmentFeesProhibited: true,
    citation:
      "Federal Decree-Law 33/2021 arts 17 (hours), 19 (overtime), 21 (weekly rest), 25 (deductions); " +
      "MoHRE Wage Protection System (payment within 15 days of the due date)",
  },
  {
    key: "sa",
    name: "Saudi Arabia",
    maxDailyHours: 11,
    maxWeeklyHours: 48,
    maxConsecutiveWorkDays: 6,
    minRestHoursBetweenShifts: 10,
    wagePaymentDueDays: 10,
    maxDeductionPercent: 50,
    minimumWage: null,
    recruitmentFeesProhibited: true,
    citation:
      "Saudi Labour Law arts 98 (48-hour week), 104 (weekly rest), 90 (payment of wages), 91-92 " +
      "(deductions); Wage Protection System circulars",
  },
  {
    key: "qa",
    name: "Qatar",
    maxDailyHours: 10,
    maxWeeklyHours: 48,
    maxConsecutiveWorkDays: 6,
    minRestHoursBetweenShifts: 10,
    wagePaymentDueDays: 7,
    maxDeductionPercent: 10,
    minimumWage: { amount: 1000, currency: "QAR", unit: "month", rateAsOf: "2021-03-20" },
    recruitmentFeesProhibited: true,
    citation:
      "Qatar Labour Law 14/2004 arts 73, 75, 66; Law 17/2020 (non-discriminatory minimum wage); " +
      "Wage Protection System Ministerial Decision 4/2015",
  },
  {
    key: "sg",
    name: "Singapore",
    maxDailyHours: 12,
    maxWeeklyHours: 60,
    maxConsecutiveWorkDays: 6,
    minRestHoursBetweenShifts: null,
    wagePaymentDueDays: 7,
    maxDeductionPercent: 50,
    minimumWage: null,
    recruitmentFeesProhibited: true,
    citation:
      "Employment Act 1968 ss 36 (rest day), 38 (hours of work and overtime, 72 OT hours a month), " +
      "21 (payment within 7 days), 27-32 (authorised deductions)",
  },
  {
    key: "my",
    name: "Malaysia",
    maxDailyHours: 12,
    maxWeeklyHours: 45,
    maxConsecutiveWorkDays: 6,
    minRestHoursBetweenShifts: null,
    wagePaymentDueDays: 7,
    maxDeductionPercent: 50,
    minimumWage: { amount: 1500, currency: "MYR", unit: "month", rateAsOf: "2022-05-01" },
    recruitmentFeesProhibited: true,
    citation:
      "Employment Act 1955 ss 59 (rest day), 60A (hours of work), 19 (payment within 7 days), " +
      "24 (lawful deductions); Minimum Wages Order 2022",
  },
  {
    key: "in",
    name: "India",
    maxDailyHours: 9,
    maxWeeklyHours: 48,
    maxConsecutiveWorkDays: 6,
    minRestHoursBetweenShifts: null,
    wagePaymentDueDays: 7,
    maxDeductionPercent: 50,
    minimumWage: null,
    recruitmentFeesProhibited: true,
    citation:
      "Factories Act 1948 ss 51, 52, 54; Code on Wages 2019 ss 13, 18; Building and Other " +
      "Construction Workers Act 1996",
  },
  {
    key: "za",
    name: "South Africa",
    maxDailyHours: 9,
    maxWeeklyHours: 45,
    maxConsecutiveWorkDays: 6,
    minRestHoursBetweenShifts: 12,
    wagePaymentDueDays: 7,
    maxDeductionPercent: 25,
    minimumWage: { amount: 27.58, currency: "ZAR", unit: "hour", rateAsOf: "2024-03-01" },
    recruitmentFeesProhibited: true,
    citation:
      "Basic Conditions of Employment Act 75/1997 ss 9 (ordinary hours), 15 (daily and weekly rest), " +
      "32 (payment), 34 (deductions); National Minimum Wage Act 9/2018",
  },
  {
    key: "ke",
    name: "Kenya",
    maxDailyHours: 8,
    maxWeeklyHours: 52,
    maxConsecutiveWorkDays: 6,
    minRestHoursBetweenShifts: null,
    wagePaymentDueDays: 7,
    maxDeductionPercent: 50,
    minimumWage: null,
    recruitmentFeesProhibited: true,
    citation:
      "Employment Act 2007 ss 27 (hours and weekly rest), 18 (payment of wages), 19 (deductions); " +
      "Regulation of Wages (General) Order",
  },
  {
    key: "ng",
    name: "Nigeria",
    maxDailyHours: 8,
    maxWeeklyHours: 48,
    maxConsecutiveWorkDays: 6,
    minRestHoursBetweenShifts: null,
    wagePaymentDueDays: 7,
    maxDeductionPercent: 33.3,
    minimumWage: { amount: 30000, currency: "NGN", unit: "month", rateAsOf: "2019-04-18" },
    recruitmentFeesProhibited: true,
    citation:
      "Labour Act Cap L1 LFN 2004 ss 13 (hours), 15 (payment of wages), 5 (deductions); National " +
      "Minimum Wage Act 2019",
  },
  {
    key: "au",
    name: "Australia",
    maxDailyHours: 12,
    maxWeeklyHours: 38,
    maxConsecutiveWorkDays: 6,
    minRestHoursBetweenShifts: 10,
    wagePaymentDueDays: 31,
    maxDeductionPercent: null,
    minimumWage: { amount: 24.1, currency: "AUD", unit: "hour", rateAsOf: "2024-07-01" },
    recruitmentFeesProhibited: true,
    citation:
      "Fair Work Act 2009 ss 62 (maximum weekly hours), 323 (payment in full), 324 (deductions); " +
      "Building and Construction General On-site Award MA000020",
  },
  {
    key: "nz",
    name: "New Zealand",
    maxDailyHours: null,
    maxWeeklyHours: 40,
    maxConsecutiveWorkDays: 6,
    minRestHoursBetweenShifts: null,
    wagePaymentDueDays: 14,
    maxDeductionPercent: null,
    minimumWage: { amount: 23.15, currency: "NZD", unit: "hour", rateAsOf: "2024-04-01" },
    recruitmentFeesProhibited: true,
    citation:
      "Minimum Wage Act 1983 s 11B; Wages Protection Act 1983 ss 4-5; Employment Relations Act 2000 " +
      "s 67D (availability)",
  },
  {
    key: "ilo",
    name: "ILO conventions baseline",
    maxDailyHours: 8,
    maxWeeklyHours: 48,
    maxConsecutiveWorkDays: 6,
    minRestHoursBetweenShifts: null,
    wagePaymentDueDays: 31,
    maxDeductionPercent: null,
    minimumWage: null,
    recruitmentFeesProhibited: true,
    citation:
      "ILO C001 (Hours of Work, Industry, 1919), C014 (Weekly Rest), C095 (Protection of Wages) " +
      "arts 8, 12; ILO General Principles on Fair Recruitment (no worker-paid fees)",
  },
] as const;

export const WAGE_JURISDICTION_KEYS = WAGE_JURISDICTIONS.map((j) => j.key);

export function getJurisdiction(key: string | null | undefined): WageJurisdiction | null {
  if (!key) return null;
  const wanted = key.trim().toLowerCase();
  return WAGE_JURISDICTIONS.find((j) => j.key === wanted) ?? null;
}

/** How stale a stored minimum wage is, in whole days, as of a date. */
export function rateAgeDays(rate: MinimumWage, asOf: string): number {
  const from = Date.parse(`${rate.rateAsOf}T00:00:00Z`);
  const to = Date.parse(`${asOf}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

/** Beyond this a quoted statutory rate is reported as stale, not as law. */
export const RATE_STALE_AFTER_DAYS = 400;

/* ------------------------------------------------------------------ */
/* Findings                                                            */
/* ------------------------------------------------------------------ */

export type ComplianceSeverity = "critical" | "high" | "medium" | "low";

export interface ComplianceFinding {
  detector: string;
  severity: ComplianceSeverity;
  title: string;
  explanation: string;
  /** the instrument the limit came from — never omitted */
  citation: string;
  /** the numbers the finding was made on, for the evidence pack */
  inputs: Record<string, unknown>;
  /** the labour risk indicator this finding raises, where one maps */
  indicator: string | null;
  /** money the worker is short, where the finding is about money */
  amountAtRisk: number | null;
  currency: string | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

const addDays = (iso: string, days: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const daysBetween = (from: string, to: string): number =>
  Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );

/* ------------------------------------------------------------------ */
/* 1. Working time                                                     */
/* ------------------------------------------------------------------ */

export interface WorkedDay {
  /** ISO date */
  date: string;
  /** hours worked that day, from timecards or from site access */
  hours: number;
  /** where the hours came from — carried into the finding */
  source: "timecard" | "site_access";
}

export interface WorkingTimeInput {
  jurisdiction: WageJurisdiction;
  workerReference: string;
  workerName: string;
  periodStart: string;
  periodEnd: string;
  days: WorkedDay[];
  /** 0 = Sunday … 6 = Saturday; the pay week the weekly limit is read over */
  weekStartsOn?: number;
}

export interface WorkingTimeAssessment {
  /** longest run of consecutive worked days inside the window */
  longestRunDays: number;
  runStart: string | null;
  runEnd: string | null;
  weeks: Array<{ weekStart: string; hours: number; days: number }>;
  maxDailyHours: number;
  maxDailyDate: string | null;
  findings: ComplianceFinding[];
}

function weekStartOf(iso: string, weekStartsOn: number): string {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return addDays(iso, -((dow - weekStartsOn + 7) % 7));
}

/**
 * Rest days, weekly hours and daily hours against the jurisdiction's limits.
 *
 * A day the worker did not attend is a REST DAY only if we have evidence for
 * the day at all; the window is bounded by periodStart/periodEnd and days
 * outside it are not assumed to be worked. Runs are computed on calendar
 * adjacency, which is what "one day's rest in seven" actually means.
 */
export function assessWorkingTime(input: WorkingTimeInput): WorkingTimeAssessment {
  const j = input.jurisdiction;
  const weekStartsOn = input.weekStartsOn ?? 1;
  const worked = input.days
    .filter((d) => d.hours > 0 && d.date >= input.periodStart && d.date <= input.periodEnd)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));

  const findings: ComplianceFinding[] = [];

  /* --- consecutive days without a rest day --- */
  let longestRun = 0;
  let runStart: string | null = null;
  let runEnd: string | null = null;
  let currentStart: string | null = null;
  let current = 0;
  let previous: string | null = null;
  for (const day of worked) {
    if (previous !== null && daysBetween(previous, day.date) === 1) {
      current += 1;
    } else {
      current = 1;
      currentStart = day.date;
    }
    if (current > longestRun) {
      longestRun = current;
      runStart = currentStart;
      runEnd = day.date;
    }
    previous = day.date;
  }

  if (j.maxConsecutiveWorkDays !== null && longestRun > j.maxConsecutiveWorkDays) {
    findings.push({
      detector: "labour_no_rest_day",
      severity: longestRun >= j.maxConsecutiveWorkDays + 7 ? "critical" : "high",
      title: `${input.workerReference} worked ${longestRun} consecutive days without a rest day`,
      explanation:
        `${input.workerName} (${input.workerReference}) worked ${longestRun} consecutive days ` +
        `from ${runStart} to ${runEnd}. ${j.name} allows ${j.maxConsecutiveWorkDays} before a rest ` +
        `day is owed. A missing rest day is one of the ILO forced-labour indicators when it is ` +
        `systematic, and it is the leading indicator of the fatigue that precedes site accidents.`,
      citation: j.citation,
      inputs: {
        jurisdiction: j.key,
        consecutiveDays: longestRun,
        limit: j.maxConsecutiveWorkDays,
        runStart,
        runEnd,
        source: worked[0]?.source ?? null,
      },
      indicator: "no_rest_day",
      amountAtRisk: null,
      currency: null,
    });
  }

  /* --- weekly hours --- */
  const weekMap = new Map<string, { hours: number; days: number }>();
  for (const day of worked) {
    const key = weekStartOf(day.date, weekStartsOn);
    const held = weekMap.get(key) ?? { hours: 0, days: 0 };
    held.hours = round2(held.hours + day.hours);
    held.days += 1;
    weekMap.set(key, held);
  }
  const weeks = [...weekMap.entries()]
    .map(([weekStart, v]) => ({ weekStart, hours: v.hours, days: v.days }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));

  if (j.maxWeeklyHours !== null) {
    // Only whole weeks inside the window are judged: a window that clips a
    // week in half would otherwise make a 60-hour week look like 20.
    const breached = weeks.filter(
      (w) =>
        w.hours > j.maxWeeklyHours! &&
        w.weekStart >= input.periodStart &&
        addDays(w.weekStart, 6) <= input.periodEnd,
    );
    for (const w of breached) {
      findings.push({
        detector: "labour_excessive_weekly_hours",
        severity: w.hours > j.maxWeeklyHours * 1.25 ? "high" : "medium",
        title: `${input.workerReference} worked ${w.hours} h in the week of ${w.weekStart}`,
        explanation:
          `${input.workerName} (${input.workerReference}) worked ${w.hours} hours over ${w.days} ` +
          `day(s) in the week beginning ${w.weekStart}. The limit in ${j.name} is ` +
          `${j.maxWeeklyHours} hours. Overtime hours a worker cannot refuse are an ILO forced-labour ` +
          `indicator; hours a worker chose are still hours the employer must be able to evidence ` +
          `consent for.`,
        citation: j.citation,
        inputs: {
          jurisdiction: j.key,
          weekStart: w.weekStart,
          hours: w.hours,
          limit: j.maxWeeklyHours,
          days: w.days,
        },
        indicator: "excessive_overtime",
        amountAtRisk: null,
        currency: null,
      });
    }
  }

  /* --- daily hours --- */
  let maxDaily = 0;
  let maxDailyDate: string | null = null;
  for (const day of worked) {
    if (day.hours > maxDaily) {
      maxDaily = day.hours;
      maxDailyDate = day.date;
    }
  }
  if (j.maxDailyHours !== null) {
    const overDays = worked.filter((d) => d.hours > j.maxDailyHours!);
    if (overDays.length > 0) {
      const worst = overDays.reduce((a, b) => (b.hours > a.hours ? b : a));
      findings.push({
        detector: "labour_excessive_daily_hours",
        severity: worst.hours > j.maxDailyHours + 4 ? "high" : "medium",
        title: `${input.workerReference} worked over ${j.maxDailyHours} h on ${overDays.length} day(s)`,
        explanation:
          `${input.workerName} (${input.workerReference}) worked more than the ${j.maxDailyHours}-hour ` +
          `daily limit in ${j.name} on ${overDays.length} day(s) in ${input.periodStart} → ` +
          `${input.periodEnd}; the longest was ${worst.hours} hours on ${worst.date}.`,
        citation: j.citation,
        inputs: {
          jurisdiction: j.key,
          limit: j.maxDailyHours,
          days: overDays.map((d) => ({ date: d.date, hours: d.hours })).slice(0, 20),
          worstDate: worst.date,
          worstHours: worst.hours,
        },
        indicator: "excessive_overtime",
        amountAtRisk: null,
        currency: null,
      });
    }
  }

  return {
    longestRunDays: longestRun,
    runStart,
    runEnd,
    weeks,
    maxDailyHours: round2(maxDaily),
    maxDailyDate,
    findings,
  };
}

/* ------------------------------------------------------------------ */
/* 2. Wage payment                                                     */
/* ------------------------------------------------------------------ */

export interface WagePaymentInput {
  jurisdiction: WageJurisdiction;
  workerReference: string;
  workerName: string;
  periodStart: string;
  periodEnd: string;
  grossPay: number;
  deductions: number;
  netPay: number;
  currency: string;
  /** hours the payroll entry says were paid for, where the file carries them */
  hoursClaimed: number | null;
  daysClaimed: number;
  /** ISO date the wages were actually paid, null = not yet paid */
  paidAt: string | null;
  /** the date the assessment is made on */
  asOf: string;
  /** coded deduction lines, where the employer supplied them */
  deductionLines?: Array<{ code: string; label: string; amount: number }>;
  /** override for a rate the tenant maintains itself */
  minimumWageOverride?: MinimumWage | null;
}

const RECRUITMENT_FEE_CODES = [
  "recruitment",
  "recruitment_fee",
  "agency",
  "agency_fee",
  "placement",
  "visa_cost",
  "visa_recovery",
  "job_cost",
  "broker",
];

/**
 * Late payment, non-payment, deductions and minimum wage.
 *
 * The minimum-wage comparison is made against the IMPLIED rate — gross pay
 * over hours where hours are known, otherwise over days at the jurisdiction's
 * day equivalent. Where neither is knowable the comparison is SKIPPED with a
 * reason rather than made against a guess: an underpayment finding against a
 * real, named person on invented arithmetic is worse than no finding at all.
 */
export function assessWagePayment(input: WagePaymentInput): {
  impliedHourlyRate: number | null;
  impliedDailyRate: number | null;
  deductionPercent: number | null;
  reasons: string[];
  findings: ComplianceFinding[];
} {
  const j = input.jurisdiction;
  const findings: ComplianceFinding[] = [];
  const reasons: string[] = [];

  const impliedDailyRate = input.daysClaimed > 0 ? round2(input.grossPay / input.daysClaimed) : null;
  const impliedHourlyRate =
    input.hoursClaimed && input.hoursClaimed > 0
      ? round2(input.grossPay / input.hoursClaimed)
      : null;
  const deductionPercent =
    input.grossPay > 0 ? round2((input.deductions / input.grossPay) * 100) : null;

  /* --- payment timing --- */
  if (j.wagePaymentDueDays !== null) {
    const dueBy = addDays(input.periodEnd, j.wagePaymentDueDays);
    if (input.paidAt === null) {
      const overdueDays = daysBetween(dueBy, input.asOf);
      if (overdueDays > 0) {
        findings.push({
          detector: "labour_wage_unpaid",
          severity: overdueDays > 30 ? "critical" : "high",
          title: `${input.workerReference} has not been paid for ${input.periodStart} → ${input.periodEnd}`,
          explanation:
            `The payroll entry for ${input.workerName} (${input.workerReference}) covering ` +
            `${input.periodStart} → ${input.periodEnd} carries no payment date. In ${j.name} wages ` +
            `were due by ${dueBy} (${j.wagePaymentDueDays} days after the period ended); that is ` +
            `${overdueDays} day(s) ago. Withheld wages are an ILO forced-labour indicator: a worker ` +
            `who is owed money cannot leave.`,
          citation: j.citation,
          inputs: {
            jurisdiction: j.key,
            periodEnd: input.periodEnd,
            dueBy,
            overdueDays,
            grossPay: input.grossPay,
            currency: input.currency,
          },
          indicator: "wage_withheld",
          amountAtRisk: round2(input.netPay),
          currency: input.currency,
        });
      }
    } else if (input.paidAt > dueBy) {
      const lateDays = daysBetween(dueBy, input.paidAt);
      findings.push({
        detector: "labour_wage_paid_late",
        severity: lateDays > 30 ? "high" : "medium",
        title: `${input.workerReference} was paid ${lateDays} day(s) late`,
        explanation:
          `Wages for ${input.periodStart} → ${input.periodEnd} were paid on ${input.paidAt}; in ` +
          `${j.name} they were due by ${dueBy}. Late payment on a construction project is rarely ` +
          `isolated — it is usually the whole crew, and it is the first thing a labour audit tests.`,
        citation: j.citation,
        inputs: {
          jurisdiction: j.key,
          paidAt: input.paidAt,
          dueBy,
          lateDays,
          currency: input.currency,
        },
        indicator: "wage_withheld",
        amountAtRisk: null,
        currency: input.currency,
      });
    }
  }

  /* --- deductions --- */
  if (j.maxDeductionPercent !== null && deductionPercent !== null) {
    if (deductionPercent > j.maxDeductionPercent) {
      findings.push({
        detector: "labour_excessive_deductions",
        severity: deductionPercent > j.maxDeductionPercent * 2 ? "critical" : "high",
        title: `${deductionPercent}% deducted from ${input.workerReference}'s gross pay`,
        explanation:
          `${input.currency} ${round2(input.deductions)} was deducted from gross pay of ` +
          `${input.currency} ${round2(input.grossPay)} — ${deductionPercent}%. ${j.name} caps ` +
          `lawful deductions at ${j.maxDeductionPercent}%. Deductions that outrun the cap are how ` +
          `debt bondage is administered: the worker is paid, on paper, and takes nothing home.`,
        citation: j.citation,
        inputs: {
          jurisdiction: j.key,
          deductions: round2(input.deductions),
          grossPay: round2(input.grossPay),
          deductionPercent,
          limitPercent: j.maxDeductionPercent,
          currency: input.currency,
        },
        indicator: "debt_bondage",
        amountAtRisk: round2(
          input.deductions - (input.grossPay * j.maxDeductionPercent) / 100,
        ),
        currency: input.currency,
      });
    }
  } else if (deductionPercent !== null && deductionPercent > 0 && j.maxDeductionPercent === null) {
    reasons.push(
      `${j.name} has no single statutory deduction cap in this library, so the ${deductionPercent}% ` +
        "deducted is reported without a verdict rather than judged against a borrowed limit.",
    );
  }

  /* --- recruitment fees, when the file codes them --- */
  for (const line of input.deductionLines ?? []) {
    const code = `${line.code} ${line.label}`.toLowerCase();
    if (!RECRUITMENT_FEE_CODES.some((c) => code.includes(c.replace(/_/g, " ")) || code.includes(c))) {
      continue;
    }
    if (line.amount <= 0) continue;
    findings.push({
      detector: "labour_recruitment_fee_deduction",
      severity: "critical",
      title: `Recruitment cost deducted from ${input.workerReference}'s wages`,
      explanation:
        `A deduction of ${input.currency} ${round2(line.amount)} coded "${line.code}" ` +
        `(${line.label}) was taken from ${input.workerName}'s pay for ${input.periodStart} → ` +
        `${input.periodEnd}. ${
          j.recruitmentFeesProhibited
            ? `${j.name} prohibits charging recruitment costs to the worker.`
            : "The employer-pays principle (ILO General Principles on Fair Recruitment) puts " +
              "recruitment costs on the employer whatever the local law says."
        } A worker repaying a recruitment cost out of wages is the textbook debt-bondage mechanism, ` +
        `and it is a hard breach of IFC PS2 on a financed project.`,
      citation: j.citation,
      inputs: {
        jurisdiction: j.key,
        code: line.code,
        label: line.label,
        amount: round2(line.amount),
        currency: input.currency,
      },
      indicator: "recruitment_fee_paid",
      amountAtRisk: round2(line.amount),
      currency: input.currency,
    });
  }

  /* --- minimum wage --- */
  const rate = input.minimumWageOverride ?? j.minimumWage;
  if (!rate) {
    reasons.push(
      `${j.name} has no minimum wage in the library (it may set rates by sector or by contract), ` +
        "so no minimum-wage comparison was made. Supply one on the run to compare.",
    );
  } else if (rate.currency !== input.currency) {
    reasons.push(
      `The minimum wage for ${j.name} is stated in ${rate.currency} and this payroll is in ` +
        `${input.currency}. Money is never converted here, so no comparison was made.`,
    );
  } else {
    const stale = rateAgeDays(rate, input.asOf) > RATE_STALE_AFTER_DAYS;
    let comparison: { paid: number; floor: number; unit: string } | null = null;
    if (rate.unit === "hour" && impliedHourlyRate !== null) {
      comparison = { paid: impliedHourlyRate, floor: rate.amount, unit: "hour" };
    } else if (rate.unit === "day" && impliedDailyRate !== null) {
      comparison = { paid: impliedDailyRate, floor: rate.amount, unit: "day" };
    } else if (rate.unit === "month") {
      const monthDays = daysBetween(input.periodStart, input.periodEnd) + 1;
      if (monthDays >= 28) {
        comparison = { paid: round2(input.grossPay), floor: rate.amount, unit: "month" };
      } else {
        reasons.push(
          `The minimum wage for ${j.name} is a monthly figure and this period covers ${monthDays} ` +
            "day(s), so it was not annualised into a comparison.",
        );
      }
    } else {
      reasons.push(
        `The minimum wage for ${j.name} is stated per ${rate.unit} and the payroll entry carries no ` +
          `${rate.unit === "hour" ? "hours" : "days"}, so no comparison was made.`,
      );
    }
    if (comparison && comparison.paid < comparison.floor - 0.005) {
      const shortfall =
        comparison.unit === "hour" && input.hoursClaimed
          ? round2((comparison.floor - comparison.paid) * input.hoursClaimed)
          : comparison.unit === "day"
            ? round2((comparison.floor - comparison.paid) * input.daysClaimed)
            : round2(comparison.floor - comparison.paid);
      findings.push({
        detector: "labour_wage_below_minimum",
        severity: "critical",
        title: `${input.workerReference} was paid below the ${j.name} minimum wage`,
        explanation:
          `Gross pay of ${input.currency} ${round2(input.grossPay)} over ` +
          `${comparison.unit === "hour" ? `${input.hoursClaimed} hour(s)` : comparison.unit === "day" ? `${input.daysClaimed} day(s)` : "the month"} ` +
          `implies ${input.currency} ${comparison.paid} per ${comparison.unit}, against a statutory ` +
          `floor of ${rate.currency} ${rate.amount} per ${rate.unit}` +
          `${stale ? ` (the figure the platform holds is dated ${rate.rateAsOf} and may have been uprated since — check it before acting)` : ""}. ` +
          `The shortfall on this entry is ${input.currency} ${shortfall}.`,
        citation: j.citation,
        inputs: {
          jurisdiction: j.key,
          impliedRate: comparison.paid,
          floor: rate.amount,
          unit: rate.unit,
          rateAsOf: rate.rateAsOf,
          rateIsStale: stale,
          shortfall,
          currency: input.currency,
        },
        indicator: "wage_withheld",
        amountAtRisk: shortfall,
        currency: input.currency,
      });
    }
  }

  return { impliedHourlyRate, impliedDailyRate, deductionPercent, reasons, findings };
}
