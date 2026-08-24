import { PAYMENT_REGIMES, type PaymentRegime } from "@constructos/shared";
import { addDaysISO, isBusinessDay } from "../field/dates.js";

/**
 * Statutory security-of-payment regime library — spec Vol II Domain F
 * (#358-372 foundation subset). Like the Phase 2 clause library this is
 * code-resident reference data, not tenant data: the day counts and
 * consequences below drive the deadline engine (#359-361), the right-to-
 * suspend flow (#362) and statutory interest (#387).
 *
 * DOCUMENTED SIMPLIFICATIONS (deliberate, so the model stays honest):
 * - Business-day arithmetic skips Saturdays and Sundays only. There are no
 *   public-holiday calendars, so "working days" statutes (NSW, Malaysia,
 *   New Zealand) compute slightly early around holidays — conservative in
 *   the payer's favour for warnings, never late.
 * - Each regime is reduced to ONE response deadline and ONE final payment
 *   date, both running from a single base date (the later of the statutory
 *   reference date and the date of service). Real statutes hang some of
 *   these off the contractual due date (UK) or off invoices (Singapore);
 *   the per-regime comments say where the model diverges.
 * - Interest rates that float on a central-bank base rate are pinned to a
 *   stated fixed figure; the `interestNote` records the true statutory
 *   formula.
 * - Suspension notice periods are applied in calendar days even where the
 *   statute counts business days (NSW s 27's "2 business days" is modelled
 *   as 2 calendar days).
 */
export interface RegimeDef {
  regime: PaymentRegime;
  name: string;
  jurisdiction: string;
  /** author's own plain-language summary, 1-3 sentences */
  summary: string;
  /** days from the base date to serve a payment response / schedule */
  responseDeadlineDays: number;
  responseDayBasis: "calendar" | "business";
  /** days from the base date to the final date for payment */
  finalPaymentDays: number;
  finalPaymentBasis: "calendar" | "business";
  /** notice period before a right-to-suspend may take effect (#362) */
  suspensionNoticeDays: number;
  /** modelled simple-interest rate, % per annum (see interestNote) */
  annualInterestPercent: number;
  interestNote: string;
  /** what happens when no valid response is served in time (#361) */
  deemedRule: string;
  adjudicationNote: string;
}

export const REGIME_LIBRARY: RegimeDef[] = [
  {
    regime: "uk_hgcra",
    name: "Housing Grants, Construction and Regeneration Act 1996 (Part II, as amended 2011)",
    jurisdiction: "United Kingdom",
    summary:
      "Every construction contract must provide an adequate payment mechanism with a due date " +
      "and a final date for payment. The payer must state the sum it intends to pay in a " +
      "payment notice, and may only pay less than the notified sum by serving a timely " +
      "pay-less notice; otherwise the notified sum is payable in full.",
    // Statute: payment notice within 5 days AFTER the contractual due date;
    // pay-less notice no later than 7 days BEFORE the final date. Modelled
    // as 5 days from the base date for the response and a 17-day final date
    // (Scheme for Construction Contracts default: due date + 17 days),
    // which preserves the >=7-day gap between the two.
    responseDeadlineDays: 5,
    responseDayBasis: "calendar",
    finalPaymentDays: 17,
    finalPaymentBasis: "calendar",
    suspensionNoticeDays: 7, // s 112: at least 7 days' written notice
    annualInterestPercent: 12.75,
    interestNote:
      "Late Payment of Commercial Debts (Interest) Act 1998: statutory interest is 8% over " +
      "the Bank of England base rate. Modelled at a pinned 12.75% (8 + 4.75); the live base " +
      "rate is not tracked.",
    deemedRule:
      "If neither a payment notice nor a pay-less notice is served in time, the sum applied " +
      "for (the notified sum) becomes the amount due and must be paid by the final date.",
    adjudicationNote:
      "Either party may refer any dispute under the contract to 28-day statutory " +
      "adjudication at any time; the decision binds until final determination.",
  },
  {
    regime: "sg_sopa",
    name: "Building and Construction Industry Security of Payment Act 2004",
    jurisdiction: "Singapore",
    summary:
      "Confers a statutory entitlement to progress payments on construction and supply " +
      "contracts. The respondent must answer a payment claim with a payment response within " +
      "the statutory window, and reasons for withholding not stated in that response cannot " +
      "be raised later in adjudication.",
    // s 11: payment response within 21 days for construction contracts (or
    // earlier if the contract says so — contract-shorter periods are not
    // modelled). Payment modelled as due 35 days from the base date; the
    // statute counts 35 days from the payment response / tax invoice.
    responseDeadlineDays: 21,
    responseDayBasis: "calendar",
    finalPaymentDays: 35,
    finalPaymentBasis: "calendar",
    suspensionNoticeDays: 7, // s 26: 7 days' notice before suspending work
    annualInterestPercent: 5.33,
    interestNote:
      "Interest runs at the contract rate or the prescribed rate, whichever is lower. " +
      "Modelled at a pinned 5.33% — the Supreme Court judgment-debt rate commonly used as " +
      "the prescribed benchmark.",
    deemedRule:
      "A respondent who serves no payment response is barred from relying on any withholding " +
      "reasons in adjudication, so the claimed amount is in practice payable in full once " +
      "the dispute-settlement period lapses.",
    adjudicationNote:
      "The claimant may lodge an adjudication application after the dispute-settlement " +
      "period; adjudicated amounts are enforceable as judgment debts.",
  },
  {
    regime: "au_nsw_sopa",
    name: "Building and Construction Industry Security of Payment Act 1999 (NSW)",
    jurisdiction: "New South Wales, Australia",
    summary:
      "Grants a statutory right to progress payments that cannot be contracted out of. A " +
      "respondent who does not serve a payment schedule within ten business days of the " +
      "payment claim becomes liable for the full claimed amount on the due date.",
    // s 14(4): payment schedule within 10 business days of the claim;
    // s 11: progress payment due 15 business days after the claim is served
    // (head contracts; subcontract chains have different periods — not
    // modelled).
    responseDeadlineDays: 10,
    responseDayBasis: "business",
    finalPaymentDays: 15,
    finalPaymentBasis: "business",
    suspensionNoticeDays: 2, // s 27: at least 2 business days' notice (modelled in calendar days)
    annualInterestPercent: 8.35,
    interestNote:
      "The greater of the contract rate and the rate under s 101 Civil Procedure Act 2005 " +
      "(NSW) — the RBA cash rate plus 4%. Modelled at a pinned 8.35% (4.35 cash rate + 4); " +
      "the live cash rate is not tracked.",
    deemedRule:
      "No payment schedule within 10 business days means the respondent is liable for the " +
      "full claimed amount on the due date, and may not raise any reasons for withholding " +
      "in a later adjudication.",
    adjudicationNote:
      "The claimant may apply for adjudication or sue on the deemed debt; judgment cannot " +
      "be resisted on the merits of the construction work.",
  },
  {
    regime: "my_cipaa",
    name: "Construction Industry Payment and Adjudication Act 2012 (CIPAA)",
    jurisdiction: "Malaysia",
    summary:
      "An adjudication-centric regime: an unpaid party serves a payment claim, the " +
      "non-paying party may answer with a payment response, and the real remedy is speedy " +
      "statutory adjudication rather than automatic deemed liability.",
    // s 6: payment response within 10 working days (modelled as Mon-Fri
    // business days). CIPAA fixes no universal final payment date; the s 36
    // default terms (payment within 30 calendar days) are used as the model.
    responseDeadlineDays: 10,
    responseDayBasis: "business",
    finalPaymentDays: 30,
    finalPaymentBasis: "calendar",
    suspensionNoticeDays: 14, // s 29: suspend 14 days after notice of an unpaid adjudicated amount
    annualInterestPercent: 5,
    interestNote:
      "CIPAA leaves interest to the contract or to the adjudicator's discretion. Modelled " +
      "at a pinned 5% simple — the customary Malaysian judgment rate.",
    deemedRule:
      "Failure to serve a payment response deems the entire payment claim DISPUTED (s 6(4)), " +
      "clearing the path to adjudication. This platform's 'deemed' status therefore marks an " +
      "adjudication-ready exposure under CIPAA, not an automatic liability.",
    adjudicationNote:
      "Adjudication under the AIAC is the central remedy: decisions are binding, enforceable " +
      "as court judgments, and ground the statutory rights to suspend or slow down work.",
  },
  {
    regime: "nz_cca",
    name: "Construction Contracts Act 2002",
    jurisdiction: "New Zealand",
    summary:
      "Provides default progress-payment terms and a payment-claim / payment-schedule " +
      "mechanism. A payer who serves no payment schedule in time must pay the claimed " +
      "amount in full, and the unpaid contractor may suspend work or recover the sum as a " +
      "debt due.",
    // Modelled on the Act's default provisions: payment schedule within 20
    // working days of the claim, and payment due 20 working days after the
    // claim is served ("working days" modelled as Mon-Fri business days;
    // contract-specific claim provisions are not modelled).
    responseDeadlineDays: 20,
    responseDayBasis: "business",
    finalPaymentDays: 20,
    finalPaymentBasis: "business",
    suspensionNoticeDays: 5, // s 24A: suspension on 5 working days' notice (modelled in calendar days)
    annualInterestPercent: 7.5,
    interestNote:
      "The Act prescribes no rate; interest follows the contract or the Interest on Money " +
      "Claims Act 2016 floating formula. Modelled at a pinned 7.5% simple.",
    deemedRule:
      "Absent a timely payment schedule the claimed amount becomes payable in full; the " +
      "payee may recover it as a debt due in court, where the payer has no defence on the " +
      "merits, and may suspend work after notice.",
    adjudicationNote:
      "Either party may refer a dispute to adjudication at any time; determinations are " +
      "enforceable and adjudicators may also rule on associated rights and obligations.",
  },
];

const byRegime = new Map(REGIME_LIBRARY.map((r) => [r.regime, r] as const));

export function findRegime(regime: string): RegimeDef | undefined {
  return byRegime.get(regime as PaymentRegime);
}

/** All regime keys have a definition — checked here so a drifted enum fails loudly in tests. */
export function libraryCoversAllRegimes(): boolean {
  return PAYMENT_REGIMES.every((r) => byRegime.has(r));
}

/**
 * Add `days` business days (Mon-Fri) to an ISO date. Each counted day must
 * itself be a business day; weekends are skipped. SIMPLIFICATION: no
 * public-holiday calendars — statutory "working days" are approximated.
 */
export function addBusinessDays(isoDate: string, days: number): string {
  let d = isoDate;
  let remaining = days;
  while (remaining > 0) {
    d = addDaysISO(d, 1);
    if (isBusinessDay(d)) remaining -= 1;
  }
  return d;
}

export interface StatutoryTimeline {
  /** last day (inclusive) to serve a payment response / schedule */
  responseDeadline: string;
  /** final date for payment (inclusive) */
  finalPaymentDate: string;
}

/**
 * Compute the statutory timeline for a served claim (#360). Both clocks run
 * from a single base date: the LATER of the statutory reference date and the
 * calendar date (UTC) of service — a clock never starts before the claim is
 * actually served, and a claim served early waits for its reference date.
 */
export function computeTimeline(
  regime: PaymentRegime,
  referenceDate: string,
  servedAtIso: string,
): StatutoryTimeline {
  const def = findRegime(regime);
  if (!def) throw new Error(`Unknown payment regime: ${regime}`);
  const servedDate = new Date(servedAtIso).toISOString().slice(0, 10);
  const base = servedDate > referenceDate ? servedDate : referenceDate;
  const add = (basis: "calendar" | "business", days: number): string =>
    basis === "business" ? addBusinessDays(base, days) : addDaysISO(base, days);
  return {
    responseDeadline: add(def.responseDayBasis, def.responseDeadlineDays),
    finalPaymentDate: add(def.finalPaymentBasis, def.finalPaymentDays),
  };
}
