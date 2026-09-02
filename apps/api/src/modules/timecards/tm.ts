/**
 * T&M (DAYWORK) TICKET ARITHMETIC — pure, no I/O (module M24).
 *
 * A T&M ticket is priced from its lines, and the two things that make it
 * worth testing on its own are the two ways it usually goes wrong:
 *
 *  1. THE UNPRICED LINE. "6 hours, rate to be agreed" is the NORMAL state of
 *     a daywork ticket on the day it is signed — the whole point of
 *     `rateBasis: "to_be_agreed"`. A ticket with an unpriced line therefore
 *     has a real hours figure and NO total, and this file says so with a null
 *     and a reason rather than inventing a zero-rate line that quietly
 *     under-claims. Signing is still allowed: "signed for record of hours
 *     only" is the most valuable signature on a construction project.
 *
 *  2. THE CLAIMED / AGREED SPLIT. A client who signs a ticket but strikes two
 *     lines has not agreed the ticket total. Both figures are carried — what
 *     we claimed, and what they accepted — because the gap between them is
 *     the claim, and collapsing them into one number loses it.
 *
 * MARKUP is a single percentage applied to the net of the four cost
 * categories. The ordered markup STACK (overhead on cost, profit on
 * cost-plus-overhead, bond on the lot) lives in the change-management module
 * and is not duplicated here: a T&M ticket carries the site-agreed daywork
 * percentage, and the contractual stack is applied when the ticket is priced
 * into a PCO by that module.
 *
 * CURRENCY is never crossed. Lines in a second currency do not get summed
 * into the ticket total at any rate, real or assumed.
 */

import type { TmLineKind } from "@constructos/shared";

export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Half a cent — the money tolerance, matching the change module's. */
export const MONEY_EPSILON = 0.005;

/** Group-separated money for prose. Hand-rolled so the string is locale-stable. */
export function formatMoney(n: number): string {
  const value = round2(n);
  const negative = value < 0;
  const fixed = Math.abs(value).toFixed(2);
  const dot = fixed.indexOf(".");
  const whole = fixed.slice(0, dot);
  const frac = fixed.slice(dot + 1);
  return `${negative ? "-" : ""}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
}

/** A figure the platform either holds the inputs for, or does not. */
export interface Figure {
  /** null when an input is missing — never a fabricated 0 */
  value: number | null;
  inputs: Record<string, unknown>;
  /** why `value` is null; empty when a value was computed */
  reasons: string[];
}

const computed = (value: number, inputs: Record<string, unknown> = {}): Figure => ({
  value: round2(value),
  inputs,
  reasons: [],
});

const unavailable = (reasons: string[], inputs: Record<string, unknown> = {}): Figure => ({
  value: null,
  inputs,
  reasons,
});

/* ------------------------------------------------------------------ */
/* Line pricing                                                        */
/* ------------------------------------------------------------------ */

export interface TmLineInput {
  /** for messages — the line's position on the ticket, 1-based */
  position?: number;
  lineKind: TmLineKind;
  description: string;
  quantity?: number | null;
  unit?: string | null;
  hours?: number | null;
  rate?: number | null;
  /** an amount stated outright, e.g. a supplier invoice pasted onto the ticket */
  amount?: number | null;
  currency: string;
  isDisputed?: boolean;
  /** what the client accepted for a struck line */
  agreedAmount?: number | null;
}

export interface PricedTmLine extends TmLineInput {
  position: number;
  /** null when the line states hours but no rate — the normal daywork case */
  amount: number | null;
  /** how the amount was reached, so a reviewer does not have to guess */
  basis: "stated" | "hours_x_rate" | "quantity_x_rate" | "unpriced";
  reasons: string[];
}

/**
 * Price one line. Precedence: a stated amount wins, then hours × rate, then
 * quantity × rate. Anything else is UNPRICED — it keeps its hours and its
 * description and contributes nothing to the total.
 */
export function priceTmLine(line: TmLineInput, position: number): PricedTmLine {
  const finite = (n: number | null | undefined): n is number =>
    typeof n === "number" && Number.isFinite(n);
  const base: Omit<PricedTmLine, "amount" | "basis" | "reasons"> = {
    ...line,
    position,
    isDisputed: line.isDisputed ?? false,
    agreedAmount: line.agreedAmount ?? null,
  };
  if (finite(line.amount)) {
    return { ...base, amount: round2(line.amount), basis: "stated", reasons: [] };
  }
  if (finite(line.hours) && finite(line.rate)) {
    return { ...base, amount: round2(line.hours * line.rate), basis: "hours_x_rate", reasons: [] };
  }
  if (finite(line.quantity) && finite(line.rate)) {
    return {
      ...base,
      amount: round2(line.quantity * line.rate),
      basis: "quantity_x_rate",
      reasons: [],
    };
  }
  const what = finite(line.hours)
    ? `${line.hours} hour(s)`
    : finite(line.quantity)
      ? `${line.quantity} ${line.unit ?? "unit(s)"}`
      : "a quantity";
  return {
    ...base,
    amount: null,
    basis: "unpriced",
    reasons: [
      `Line ${position} ("${line.description}") records ${what} but no rate and no stated amount, ` +
        "so it has no value yet. On a ticket priced \"to be agreed\" that is the correct state — " +
        "the hours are the claim and the rate follows.",
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Ticket totals                                                       */
/* ------------------------------------------------------------------ */

export interface TmTotalsInput {
  lines: readonly TmLineInput[];
  /** the ticket's own currency; lines must match it */
  currency: string;
  /** site-agreed daywork percentage on the net of the cost categories */
  markupPercent?: number | null;
}

export interface TmTotals {
  currency: string;
  lineCount: number;
  /** hours across LABOUR lines — the figure the signature is really about */
  totalLabourHours: number;
  /** hours across equipment lines, kept apart from labour hours */
  totalEquipmentHours: number;
  labourTotal: Figure;
  equipmentTotal: Figure;
  materialTotal: Figure;
  subcontractTotal: Figure;
  otherTotal: Figure;
  /** Σ of the categories before markup */
  netTotal: Figure;
  markupPercent: number | null;
  markupTotal: Figure;
  /** net + markup — what we claim */
  total: Figure;
  /** what the client accepted, once disputed lines are settled */
  agreedTotal: Figure;
  disputedLineCount: number;
  unpricedLineCount: number;
  lines: PricedTmLine[];
  /** things a reader should know that do not invalidate a figure */
  notes: string[];
}

const KIND_TO_CATEGORY: Record<TmLineKind, "labour" | "equipment" | "material" | "subcontract" | "other"> = {
  labour: "labour",
  equipment: "equipment",
  material: "material",
  subcontract: "subcontract",
  markup: "other",
  other: "other",
};

/**
 * Price a whole ticket.
 *
 * Every category total, the net, the markup and the grand total are Figures:
 * a single unpriced line makes the categories it belongs to and everything
 * downstream null, with the line named in the reasons. The hours survive — a
 * ticket with no total still evidences the labour that was expended, which is
 * exactly what the client's representative signed for.
 */
export function computeTicketTotals(input: TmTotalsInput): TmTotals {
  const currency = input.currency.toUpperCase();
  const priced = input.lines.map((l, i) => priceTmLine(l, i + 1));
  const notes: string[] = [];

  const foreign = priced.filter((l) => l.currency.toUpperCase() !== currency);
  const currencyReasons =
    foreign.length > 0
      ? [
          `Line(s) ${foreign.map((l) => l.position).join(", ")} are denominated in ` +
            `${[...new Set(foreign.map((l) => l.currency.toUpperCase()))].join(", ")} while the ticket ` +
            `is in ${currency}. Money is never summed across currencies here — raise a separate ` +
            "ticket per currency rather than converting at an assumed rate.",
        ]
      : [];

  const totalLabourHours = round2(
    priced
      .filter((l) => l.lineKind === "labour")
      .reduce((s, l) => s + (typeof l.hours === "number" && Number.isFinite(l.hours) ? l.hours : 0), 0),
  );
  const totalEquipmentHours = round2(
    priced
      .filter((l) => l.lineKind === "equipment")
      .reduce((s, l) => s + (typeof l.hours === "number" && Number.isFinite(l.hours) ? l.hours : 0), 0),
  );

  const category = (
    name: "labour" | "equipment" | "material" | "subcontract" | "other",
  ): Figure => {
    const rows = priced.filter((l) => KIND_TO_CATEGORY[l.lineKind] === name);
    const inputs = { lines: rows.map((r) => r.position), currency };
    if (currencyReasons.length > 0) return unavailable(currencyReasons, inputs);
    const unpriced = rows.filter((r) => r.amount === null);
    if (unpriced.length > 0) {
      return unavailable(
        unpriced.flatMap((r) => r.reasons),
        { ...inputs, unpricedLines: unpriced.map((r) => r.position) },
      );
    }
    return computed(
      rows.reduce((s, r) => s + (r.amount ?? 0), 0),
      inputs,
    );
  };

  const labourTotal = category("labour");
  const equipmentTotal = category("equipment");
  const materialTotal = category("material");
  const subcontractTotal = category("subcontract");
  const otherTotal = category("other");
  const categories = [labourTotal, equipmentTotal, materialTotal, subcontractTotal, otherTotal];

  const netReasons = [...new Set(categories.flatMap((c) => c.reasons))];
  const netTotal: Figure =
    netReasons.length > 0
      ? unavailable(netReasons, { currency })
      : computed(
          categories.reduce((s, c) => s + (c.value ?? 0), 0),
          { currency },
        );

  const markupPercent =
    typeof input.markupPercent === "number" && Number.isFinite(input.markupPercent)
      ? input.markupPercent
      : null;
  if (markupPercent === null) {
    notes.push(
      "No markup percentage is recorded on this ticket, so no markup has been added. If the " +
        "contract's daywork percentage applies, set markupPercent — an omitted percentage is " +
        "treated as none, never guessed from the contract.",
    );
  }
  const markupTotal: Figure =
    netTotal.value === null
      ? unavailable(
          [
            "The markup cannot be computed because the net of the cost categories is unknown.",
            ...netReasons,
          ],
          { markupPercent },
        )
      : computed((netTotal.value * (markupPercent ?? 0)) / 100, {
          markupPercent,
          base: netTotal.value,
        });

  const total: Figure =
    netTotal.value === null || markupTotal.value === null
      ? unavailable(
          netReasons.length > 0
            ? netReasons
            : ["The ticket total cannot be stated because the markup is unknown."],
          { currency },
        )
      : computed(netTotal.value + markupTotal.value, {
          net: netTotal.value,
          markup: markupTotal.value,
          currency,
        });

  const disputed = priced.filter((l) => l.isDisputed);
  const disputedWithoutAgreement = disputed.filter(
    (l) => !(typeof l.agreedAmount === "number" && Number.isFinite(l.agreedAmount)),
  );
  const agreedTotal: Figure = (() => {
    if (currencyReasons.length > 0) return unavailable(currencyReasons, { currency });
    if (disputed.length === 0) {
      return total.value === null
        ? unavailable(
            [
              "No line is disputed, so the agreed total would be the ticket total — which is " +
                "itself not yet stateable.",
              ...total.reasons,
            ],
            { currency },
          )
        : computed(total.value, { currency, basis: "no line disputed" });
    }
    if (disputedWithoutAgreement.length > 0) {
      return unavailable(
        [
          `Line(s) ${disputedWithoutAgreement.map((l) => l.position).join(", ")} are marked disputed ` +
            "with no agreed amount recorded, so what the client has actually accepted is unknown. " +
            "It is not zero and it is not the claim.",
        ],
        { currency, disputedLines: disputed.map((l) => l.position) },
      );
    }
    const undisputedUnpriced = priced.filter((l) => !l.isDisputed && l.amount === null);
    if (undisputedUnpriced.length > 0) {
      return unavailable(
        undisputedUnpriced.flatMap((l) => l.reasons),
        { currency },
      );
    }
    const net =
      priced.reduce(
        (s, l) => s + (l.isDisputed ? (l.agreedAmount ?? 0) : (l.amount ?? 0)),
        0,
      ) *
      (1 + (markupPercent ?? 0) / 100);
    return computed(net, {
      currency,
      markupPercent,
      basis: "disputed lines valued at their agreed amounts",
    });
  })();

  return {
    currency,
    lineCount: priced.length,
    totalLabourHours,
    totalEquipmentHours,
    labourTotal,
    equipmentTotal,
    materialTotal,
    subcontractTotal,
    otherTotal,
    netTotal,
    markupPercent,
    markupTotal,
    total,
    agreedTotal,
    disputedLineCount: disputed.length,
    unpricedLineCount: priced.filter((l) => l.amount === null).length,
    lines: priced,
    notes,
  };
}

/* ------------------------------------------------------------------ */
/* The signature                                                       */
/* ------------------------------------------------------------------ */

/**
 * What the client's representative actually did. Derived STRICTLY from the
 * stored signature columns and never from the ticket's status, so a ticket
 * whose status was pushed to "signed" by any other route still reads as
 * unsigned here. An unsigned ticket must never present as signed: on a
 * disputed change, the presence or absence of a site signature is the whole
 * argument.
 */
export const SIGNATURE_STATES = [
  "unsigned",
  "signed",
  "signed_under_protest",
  "refused_to_sign",
] as const;
export type SignatureState = (typeof SIGNATURE_STATES)[number];

export interface SignatureColumns {
  signedAt: string | null;
  signedByName: string | null;
  signatureMethod: string;
  signedUnderProtest: number;
  refusedToSign: number;
  protestNote: string | null;
  refusalNote: string | null;
}

export interface SignatureEvidence {
  state: SignatureState;
  /** true ONLY for a clean, unqualified signature */
  isSigned: boolean;
  /** true when a client-side event of any kind is on record */
  hasClientResponse: boolean;
  note: string | null;
  /** one line a reviewer can read without opening the ticket */
  summary: string;
}

export function signatureEvidence(t: SignatureColumns): SignatureEvidence {
  if (t.refusedToSign === 1) {
    return {
      state: "refused_to_sign",
      isSigned: false,
      hasClientResponse: true,
      note: t.refusalNote,
      summary:
        `${t.signedByName ?? "The client's representative"} REFUSED to sign this ticket` +
        (t.refusalNote ? `: ${t.refusalNote}` : "") +
        ". A recorded refusal is evidence in its own right — it fixes the date on which the " +
        "client was told the work was being done and declined to acknowledge it.",
    };
  }
  if (t.signedAt === null) {
    return {
      state: "unsigned",
      isSigned: false,
      hasClientResponse: false,
      note: null,
      summary:
        "This ticket carries no site signature and no recorded refusal. It is our own record of " +
        "hours and nothing more.",
    };
  }
  if (t.signedUnderProtest === 1) {
    return {
      state: "signed_under_protest",
      isSigned: false,
      hasClientResponse: true,
      note: t.protestNote,
      summary:
        `${t.signedByName ?? "The client's representative"} signed UNDER PROTEST at ${t.signedAt} ` +
        `by ${t.signatureMethod}` +
        (t.protestNote ? `: ${t.protestNote}` : "") +
        ". The signature acknowledges the hours; it does not admit liability, and it must never " +
        "be reported as an unqualified acceptance.",
    };
  }
  return {
    state: "signed",
    isSigned: true,
    hasClientResponse: true,
    note: null,
    summary:
      `${t.signedByName ?? "The client's representative"} signed this ticket at ${t.signedAt} by ` +
      `${t.signatureMethod}.`,
  };
}
