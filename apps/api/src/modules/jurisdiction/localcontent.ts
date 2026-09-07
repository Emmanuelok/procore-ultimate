/**
 * Local content / in-country value computation (#612-615) — pure arithmetic
 * over rows the route has already loaded and tenant-scoped.
 *
 * WHY A COMPUTED READING BEATS A KEYED ONE
 *
 * Local content undertakings are conditions of the licence or concession in
 * resource-nationalist and Gulf jurisdictions, and the figure reported to the
 * authority is normally typed in by the person whose bonus depends on it.
 * The platform already holds the two populations the figure is made of —
 * paid invoices with a vendor country, and workers with a nationality — so it
 * can derive the number and record the source set as the reading's basis. A
 * keyed figure remains possible (some regimes score on their own template),
 * but it is labelled `manual` next to a `computed` one, and the difference
 * between them is itself the finding.
 *
 * THE CURRENCY RULE, WHICH IS NOT NEGOTIABLE
 *
 * Local spend is a ratio of money. Money in different currencies does not
 * add. A period whose invoices span several currencies produces an
 * UNKNOWABLE result with the currencies listed, not a sum that pretends
 * 1 NGN = 1 USD. The caller can narrow the period or convert deliberately;
 * the engine will not do it silently.
 */

export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Invoice statuses that count as spend actually incurred. */
export const SPEND_STATUSES: readonly string[] = ["approved", "approved_as_noted", "paid"];

export interface SpendRow {
  invoiceId: string;
  vendorId: string | null;
  vendorName: string | null;
  vendorCountry: string | null;
  currency: string;
  amount: number;
  date: string | null;
}

export interface WorkerRow {
  workerId: string;
  nationality: string | null;
  status: string;
}

export interface ComputedReading {
  value: number | null;
  compliant: boolean | null;
  basis: string;
  inputs: Record<string, unknown>;
  unavailableReason: string | null;
}

/** Case- and whitespace-insensitive jurisdiction match. */
export function matchesJurisdiction(value: string | null, jurisdiction: string): boolean {
  if (!value) return false;
  return value.trim().toLowerCase() === jurisdiction.trim().toLowerCase();
}

/* ------------------------------------------------------------------ */
/* local_spend_percent                                                 */
/* ------------------------------------------------------------------ */

export function computeLocalSpend(args: {
  rows: readonly SpendRow[];
  jurisdiction: string;
  targetValue: number;
  periodStart: string | null;
  periodEnd: string | null;
}): ComputedReading {
  const inPeriod = args.rows.filter((r) => {
    if (args.periodStart && (!r.date || r.date < args.periodStart)) return false;
    if (args.periodEnd && (!r.date || r.date > args.periodEnd)) return false;
    return true;
  });
  if (inPeriod.length === 0) {
    return {
      value: null,
      compliant: null,
      basis: "",
      inputs: { invoices: 0 },
      unavailableReason:
        "No approved or paid invoices fall in the reporting period, so there is no spend " +
        "population to measure a local share against.",
    };
  }
  const currencies = [...new Set(inPeriod.map((r) => r.currency))].sort();
  if (currencies.length > 1) {
    return {
      value: null,
      compliant: null,
      basis: "",
      inputs: { invoices: inPeriod.length, currencies },
      unavailableReason:
        `The spend population spans ${currencies.length} currencies (${currencies.join(", ")}). ` +
        `A local-spend percentage is a ratio of money and money in different currencies does ` +
        `not add; convert the population deliberately or narrow the period rather than summing ` +
        `across currencies.`,
    };
  }
  const total = inPeriod.reduce((s, r) => s + r.amount, 0);
  if (!(total > 0)) {
    return {
      value: null,
      compliant: null,
      basis: "",
      inputs: { invoices: inPeriod.length, currency: currencies[0] },
      unavailableReason: "The spend population totals zero, so no share can be computed.",
    };
  }
  const local = inPeriod.filter((r) => matchesJurisdiction(r.vendorCountry, args.jurisdiction));
  const unknownCountry = inPeriod.filter((r) => !r.vendorCountry).length;
  const localTotal = local.reduce((s, r) => s + r.amount, 0);
  const value = round2((localTotal / total) * 100);
  return {
    value,
    compliant: value >= args.targetValue,
    basis:
      `${round2(localTotal)} ${currencies[0]} to ${local.length} vendor(s) registered in ` +
      `${args.jurisdiction}, over ${round2(total)} ${currencies[0]} of approved and paid ` +
      `invoices across ${inPeriod.length} invoice(s)` +
      (args.periodStart || args.periodEnd
        ? ` for ${args.periodStart ?? "the start of the project"}–${args.periodEnd ?? "today"}`
        : "") +
      `.` +
      (unknownCountry > 0
        ? ` ${unknownCountry} invoice(s) are against vendors with no country recorded and count ` +
          `in the denominator as non-local, which understates the share until the directory is ` +
          `completed.`
        : ""),
    inputs: {
      invoices: inPeriod.length,
      localInvoices: local.length,
      currency: currencies[0],
      localAmount: round2(localTotal),
      totalAmount: round2(total),
      vendorsWithoutCountry: unknownCountry,
      invoiceIds: inPeriod.map((r) => r.invoiceId).slice(0, 500),
    },
    unavailableReason: null,
  };
}

/* ------------------------------------------------------------------ */
/* local_headcount_percent / national_quota                            */
/* ------------------------------------------------------------------ */

export function computeLocalHeadcount(args: {
  workers: readonly WorkerRow[];
  jurisdiction: string;
  targetValue: number;
  /** national_quota counts citizenship only and excludes unknowns from neither side */
  metric: "local_headcount_percent" | "national_quota";
}): ComputedReading {
  const active = args.workers.filter((w) => w.status === "active");
  if (active.length === 0) {
    return {
      value: null,
      compliant: null,
      basis: "",
      inputs: { workers: 0 },
      unavailableReason:
        "No active workers are on the project register, so there is no headcount population " +
        "to measure a local share against.",
    };
  }
  const local = active.filter((w) => matchesJurisdiction(w.nationality, args.jurisdiction));
  const unknown = active.filter((w) => !w.nationality).length;
  const value = round2((local.length / active.length) * 100);
  return {
    value,
    compliant: value >= args.targetValue,
    basis:
      `${local.length} of ${active.length} active workers hold ${args.jurisdiction} ` +
      `nationality (${value}%)` +
      (args.metric === "national_quota"
        ? `. A national quota is about citizenship, so long-term residents without ` +
          `${args.jurisdiction} nationality are counted in the denominator only — treating them ` +
          `as nationals is how a quota is missed on site and met in the report.`
        : `. The worker register holds nationality and not residency, so a long-term resident ` +
          `without ${args.jurisdiction} nationality counts as non-local here and this figure ` +
          `coincides with the national quota; a regime that scores residents as local needs a ` +
          `residency attribute on the worker record before the two can differ.`) +
      (unknown > 0
        ? ` ${unknown} worker(s) have no nationality recorded and count as non-local, which ` +
          `understates the share until the register is completed.`
        : ""),
    inputs: {
      workers: active.length,
      localWorkers: local.length,
      workersWithoutNationality: unknown,
      metric: args.metric,
    },
    unavailableReason: null,
  };
}
