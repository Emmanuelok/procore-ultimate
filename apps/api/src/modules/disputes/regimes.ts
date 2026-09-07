/**
 * Statutory and contractual adjudication timetables (spec Vol II Domain E
 * #322-333).
 *
 * WHY THIS IS DATA
 * Adjudication is a creature of statute and the statutes are unforgiving:
 * a referral served on day 8 under the UK Scheme is a nullity, and a
 * response filed a working day late in NSW is simply not read. The timetable
 * is not advice — it is arithmetic on a trigger date, and arithmetic belongs
 * in code where it can be tested, not in a user's head.
 *
 * Each regime is an ordered list of steps with an offset from the trigger
 * date (the notice of adjudication, or the payment claim where the statute
 * runs from there), counted in either calendar days or the jurisdiction's
 * own business/working days. The `extendableToDays` field records the
 * statutory extension where one exists, so the UI can show both the base
 * deadline and the extended one rather than pretending the base is absolute.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * It is not legal advice and it does not know your contract. Public holidays
 * are a parameter, not a built-in calendar — the module accepts a holiday
 * list per project and, given none, counts weekends only and says so.
 * Contractual variations to the statutory timetable are handled by editing
 * the generated steps, which is why generation produces ordinary editable
 * timetable rows rather than a locked schedule.
 */
import type { DisputeJurisdiction } from "@constructos/shared";

export type DayBasis = "calendar" | "business";

export interface RegimeStep {
  /** stable key so a regenerated timetable can be diffed against the old one */
  key: string;
  name: string;
  /** offset from the regime's trigger date */
  offsetDays: number;
  basis: DayBasis;
  /** statutory extension ceiling, in the same basis; null when there is none */
  extendableToDays: number | null;
  /** the party who must act */
  owner: "referring" | "responding" | "adjudicator" | "both";
  /** the provision the offset comes from */
  authority: string;
}

export interface RegimeSpec {
  jurisdiction: DisputeJurisdiction;
  label: string;
  /** what the offsets are measured from */
  triggerName: string;
  statute: string;
  /** applicable dispute kinds; used to warn on an obvious mismatch */
  kinds: string[];
  steps: RegimeStep[];
  notes: string;
}

export const REGIMES: readonly RegimeSpec[] = [
  {
    jurisdiction: "uk_hgcra",
    label: "United Kingdom — HGCRA 1996 / Scheme for Construction Contracts",
    triggerName: "Notice of adjudication",
    statute: "Housing Grants, Construction and Regeneration Act 1996 s.108; Scheme Part I",
    kinds: ["adjudication"],
    steps: [
      {
        key: "appointment",
        name: "Adjudicator nominated and appointed",
        offsetDays: 7,
        basis: "calendar",
        extendableToDays: null,
        owner: "referring",
        authority: "s.108(2)(b) — secure appointment within 7 days of the notice",
      },
      {
        key: "referral",
        name: "Referral notice served",
        offsetDays: 7,
        basis: "calendar",
        extendableToDays: null,
        owner: "referring",
        authority: "s.108(2)(b) / Scheme para 7(1) — refer within 7 days of the notice",
      },
      {
        key: "response",
        name: "Responding party's response served",
        offsetDays: 21,
        basis: "calendar",
        extendableToDays: null,
        owner: "responding",
        authority: "Directed by the adjudicator; 14 days after referral is the usual direction",
      },
      {
        key: "decision",
        name: "Adjudicator's decision",
        offsetDays: 35,
        basis: "calendar",
        extendableToDays: 49,
        owner: "adjudicator",
        authority:
          "s.108(2)(c)-(d) — 28 days from referral, extendable by 14 days with the referring party's consent",
      },
      {
        key: "compliance",
        name: "Compliance with the decision",
        offsetDays: 42,
        basis: "calendar",
        extendableToDays: null,
        owner: "responding",
        authority: "Decision is binding until finally determined; payment usually 7 days after",
      },
    ],
    notes:
      "Offsets run from the notice of adjudication. The 28-day decision period runs from the REFERRAL, so the decision step here is 7 + 28 = 35 days from the notice; the extension to 42 days from referral shows as 49.",
  },
  {
    jurisdiction: "singapore_sopa",
    label: "Singapore — Building and Construction Industry Security of Payment Act",
    triggerName: "Payment claim served",
    statute: "SOPA (Cap 30B) ss.11-17",
    kinds: ["adjudication"],
    steps: [
      {
        key: "payment_response",
        name: "Payment response served",
        offsetDays: 21,
        basis: "calendar",
        extendableToDays: null,
        owner: "responding",
        authority: "s.11(1) — within 21 days of the payment claim (7 days for supply contracts)",
      },
      {
        key: "dispute_settlement_end",
        name: "Dispute settlement period ends",
        offsetDays: 28,
        basis: "calendar",
        extendableToDays: null,
        owner: "both",
        authority: "s.12(4) — 7 days after the payment response deadline",
      },
      {
        key: "adjudication_application",
        name: "Adjudication application lodged",
        offsetDays: 35,
        basis: "calendar",
        extendableToDays: null,
        owner: "referring",
        authority: "s.13(3)(a) — within 7 days after the dispute settlement period",
      },
      {
        key: "adjudication_response",
        name: "Adjudication response lodged",
        offsetDays: 42,
        basis: "calendar",
        extendableToDays: null,
        owner: "responding",
        authority: "s.15(1) — within 7 days of receiving the adjudication application",
      },
      {
        key: "determination",
        name: "Adjudication determination",
        offsetDays: 49,
        basis: "calendar",
        extendableToDays: null,
        owner: "adjudicator",
        authority: "s.17(1)(a) — within 7 days after the response period expires",
      },
    ],
    notes:
      "Offsets run from service of the payment claim. Supply contracts have shorter periods; adjust the generated steps where the contract is a supply contract.",
  },
  {
    jurisdiction: "nsw_sopa",
    label: "New South Wales — Building and Construction Industry Security of Payment Act 1999",
    triggerName: "Payment claim served",
    statute: "BCISPA 1999 (NSW) ss.14, 17, 20, 21",
    kinds: ["adjudication"],
    steps: [
      {
        key: "payment_schedule",
        name: "Payment schedule provided",
        offsetDays: 10,
        basis: "business",
        extendableToDays: null,
        owner: "responding",
        authority: "s.14(4)(b) — within 10 business days of the payment claim",
      },
      {
        key: "adjudication_application",
        name: "Adjudication application lodged",
        offsetDays: 20,
        basis: "business",
        extendableToDays: null,
        owner: "referring",
        authority: "s.17(3)(c) — within 10 business days after the schedule was due",
      },
      {
        key: "adjudication_response",
        name: "Adjudication response lodged",
        offsetDays: 25,
        basis: "business",
        extendableToDays: null,
        owner: "responding",
        authority: "s.20(1) — 5 business days after receiving a copy of the application",
      },
      {
        key: "determination",
        name: "Adjudicator's determination",
        offsetDays: 35,
        basis: "business",
        extendableToDays: null,
        owner: "adjudicator",
        authority: "s.21(3) — within 10 business days after acceptance of the application",
      },
    ],
    notes: "Business days exclude weekends and, where supplied, the project's public holidays.",
  },
  {
    jurisdiction: "qld_boif",
    label: "Queensland — Building Industry Fairness (Security of Payment) Act 2017",
    triggerName: "Payment claim given",
    statute: "BIF Act 2017 (Qld) ss.76, 79, 82, 85",
    kinds: ["adjudication"],
    steps: [
      {
        key: "payment_schedule",
        name: "Payment schedule given",
        offsetDays: 15,
        basis: "business",
        extendableToDays: null,
        owner: "responding",
        authority: "s.76(2)(b) — within 15 business days of the payment claim",
      },
      {
        key: "adjudication_application",
        name: "Adjudication application made",
        offsetDays: 45,
        basis: "business",
        extendableToDays: null,
        owner: "referring",
        authority: "s.79(2) — within 30 business days after the schedule was due",
      },
      {
        key: "adjudication_response",
        name: "Adjudication response given",
        offsetDays: 55,
        basis: "business",
        extendableToDays: null,
        owner: "responding",
        authority: "s.82(2) — 10 business days after receiving the application",
      },
      {
        key: "decision",
        name: "Adjudicator's decision",
        offsetDays: 65,
        basis: "business",
        extendableToDays: 70,
        owner: "adjudicator",
        authority:
          "s.85(1) — 10 business days for a standard payment claim, 15 for a complex claim",
      },
    ],
    notes:
      "The complex-claim track has longer periods throughout; the extendable ceiling on the decision reflects the 15-business-day complex-claim limit.",
  },
  {
    jurisdiction: "malaysia_cipaa",
    label: "Malaysia — Construction Industry Payment and Adjudication Act 2012",
    triggerName: "Payment claim served",
    statute: "CIPAA 2012 ss.6-12",
    kinds: ["adjudication"],
    steps: [
      {
        key: "payment_response",
        name: "Payment response served",
        offsetDays: 10,
        basis: "business",
        extendableToDays: null,
        owner: "responding",
        authority: "s.6(1) — within 10 working days of the payment claim",
      },
      {
        key: "notice_of_adjudication",
        name: "Notice of adjudication served",
        offsetDays: 11,
        basis: "business",
        extendableToDays: null,
        owner: "referring",
        authority: "s.8(1) — after the payment response period expires",
      },
      {
        key: "appointment",
        name: "Adjudicator appointed",
        offsetDays: 21,
        basis: "business",
        extendableToDays: null,
        owner: "both",
        authority: "s.21 — 10 working days for agreement, else AIAC appointment",
      },
      {
        key: "adjudication_claim",
        name: "Adjudication claim served",
        offsetDays: 31,
        basis: "business",
        extendableToDays: null,
        owner: "referring",
        authority: "s.9(1) — within 10 working days of the adjudicator's acceptance",
      },
      {
        key: "adjudication_response",
        name: "Adjudication response served",
        offsetDays: 41,
        basis: "business",
        extendableToDays: null,
        owner: "responding",
        authority: "s.10(1) — within 10 working days of the adjudication claim",
      },
      {
        key: "adjudication_reply",
        name: "Adjudication reply served",
        offsetDays: 46,
        basis: "business",
        extendableToDays: null,
        owner: "referring",
        authority: "s.11(1) — within 5 working days of the response",
      },
      {
        key: "decision",
        name: "Adjudication decision",
        offsetDays: 91,
        basis: "business",
        extendableToDays: null,
        owner: "adjudicator",
        authority: "s.12(2) — within 45 working days of the reply or response period expiring",
      },
    ],
    notes: "Working days under CIPAA exclude weekends and public holidays in the relevant state.",
  },
  {
    jurisdiction: "nz_cca",
    label: "New Zealand — Construction Contracts Act 2002",
    triggerName: "Notice of adjudication",
    statute: "CCA 2002 ss.28-46",
    kinds: ["adjudication"],
    steps: [
      {
        key: "appointment",
        name: "Adjudicator appointed",
        offsetDays: 2,
        basis: "business",
        extendableToDays: null,
        owner: "referring",
        authority: "s.33 — 2 working days to select, or nominating body appoints",
      },
      {
        key: "referral",
        name: "Claim referred (written claim served)",
        offsetDays: 7,
        basis: "business",
        extendableToDays: null,
        owner: "referring",
        authority: "s.36(1) — within 5 working days of the adjudicator's acceptance",
      },
      {
        key: "response",
        name: "Written response served",
        offsetDays: 12,
        basis: "business",
        extendableToDays: null,
        owner: "responding",
        authority: "s.37(1) — within 5 working days of receiving the claim",
      },
      {
        key: "determination",
        name: "Adjudicator's determination",
        offsetDays: 32,
        basis: "business",
        extendableToDays: 42,
        owner: "adjudicator",
        authority:
          "s.46 — 20 working days after the response period, extendable to 30 with the parties' consent",
      },
    ],
    notes: "Working days exclude weekends and, where supplied, public holidays.",
  },
  {
    jurisdiction: "fidic_daab",
    label: "FIDIC 2017 — Dispute Avoidance/Adjudication Board",
    triggerName: "Referral to the DAAB",
    statute: "FIDIC 2017 Red/Yellow/Silver Book sub-clauses 21.4-21.6",
    kinds: ["daab", "adjudication"],
    steps: [
      {
        key: "decision",
        name: "DAAB decision given",
        offsetDays: 84,
        basis: "calendar",
        extendableToDays: null,
        owner: "adjudicator",
        authority: "SC 21.4.3 — within 84 days of receiving the referral",
      },
      {
        key: "notice_of_dissatisfaction",
        name: "Notice of dissatisfaction window closes",
        offsetDays: 112,
        basis: "calendar",
        extendableToDays: null,
        owner: "both",
        authority: "SC 21.4.4 — 28 days after the decision, else it becomes final and binding",
      },
      {
        key: "amicable_settlement",
        name: "Amicable settlement period ends",
        offsetDays: 140,
        basis: "calendar",
        extendableToDays: null,
        owner: "both",
        authority: "SC 21.5 — 28 days from the notice of dissatisfaction before arbitration",
      },
    ],
    notes:
      "A DAAB decision is binding and must be given effect even while a notice of dissatisfaction stands; the compliance obligation is tracked separately from the dissatisfaction window.",
  },
] as const;

const BY_JURISDICTION = new Map(REGIMES.map((r) => [r.jurisdiction, r]));

export function regimeFor(jurisdiction: string): RegimeSpec | null {
  return BY_JURISDICTION.get(jurisdiction as DisputeJurisdiction) ?? null;
}

/* ------------------------------------------------------------------ */
/* Calendars                                                           */
/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;

export function addCalendarDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function isWeekend(iso: string): boolean {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * Add business days, skipping weekends and any supplied holiday dates.
 * Counting starts the day AFTER the trigger, which is the universal
 * convention in the statutes above ("within 10 business days of…").
 * A zero offset returns the trigger date itself.
 */
export function addBusinessDays(iso: string, days: number, holidays: Set<string>): string {
  if (days <= 0) return iso;
  let cursor = iso;
  let remaining = days;
  let guard = 0;
  while (remaining > 0 && guard < 10_000) {
    guard += 1;
    cursor = addCalendarDays(cursor, 1);
    if (isWeekend(cursor) || holidays.has(cursor)) continue;
    remaining -= 1;
  }
  return cursor;
}

/* ------------------------------------------------------------------ */
/* Timetable generation (#322-333)                                     */
/* ------------------------------------------------------------------ */

export interface GeneratedStep {
  key: string;
  name: string;
  dueDate: string;
  /** the extended deadline where the statute allows one */
  extendedDueDate: string | null;
  owner: RegimeStep["owner"];
  basis: DayBasis;
  offsetDays: number;
  authority: string;
}

export interface GeneratedTimetable {
  jurisdiction: string;
  label: string;
  statute: string;
  triggerName: string;
  triggerDate: string;
  steps: GeneratedStep[];
  /** true when no holiday calendar was supplied and business days were counted */
  weekendsOnly: boolean;
  notes: string;
}

/**
 * Materialise a regime's timetable from a trigger date. Returns null for an
 * unknown jurisdiction rather than inventing a schedule — a made-up
 * adjudication deadline is worse than no deadline.
 */
export function generateTimetable(
  jurisdiction: string,
  triggerDate: string,
  holidays: string[] = [],
): GeneratedTimetable | null {
  const regime = regimeFor(jurisdiction);
  if (!regime) return null;
  const holidaySet = new Set(holidays);
  const dateFor = (offset: number, basis: DayBasis): string =>
    basis === "calendar"
      ? addCalendarDays(triggerDate, offset)
      : addBusinessDays(triggerDate, offset, holidaySet);
  return {
    jurisdiction: regime.jurisdiction,
    label: regime.label,
    statute: regime.statute,
    triggerName: regime.triggerName,
    triggerDate,
    steps: regime.steps.map((s) => ({
      key: s.key,
      name: s.name,
      dueDate: dateFor(s.offsetDays, s.basis),
      extendedDueDate: s.extendableToDays === null ? null : dateFor(s.extendableToDays, s.basis),
      owner: s.owner,
      basis: s.basis,
      offsetDays: s.offsetDays,
      authority: s.authority,
    })),
    weekendsOnly: holidays.length === 0 && regime.steps.some((s) => s.basis === "business"),
    notes: regime.notes,
  };
}

/* ------------------------------------------------------------------ */
/* Adjudicator nomination request (#328)                               */
/* ------------------------------------------------------------------ */

export interface NominationRequestInput {
  disputeNumber: number;
  disputeTitle: string;
  jurisdiction: string;
  forum: string | null;
  rules: string | null;
  contractReference: string | null;
  contractFamily: string | null;
  projectName: string;
  referringParty: string;
  respondingParty: string;
  amountInDispute: number | null;
  currency: string;
  triggerDate: string | null;
  natureOfDispute: string;
  requestedAt: string;
}

export interface NominationRequest {
  title: string;
  /** ordered sections rendered as a document by the UI/PDF layer */
  sections: { heading: string; body: string }[];
  /** deadlines the nominating body is being asked to meet */
  deadlines: { name: string; dueDate: string }[];
  basis: string;
}

/**
 * Assemble the adjudicator nomination request from what the platform
 * already holds. This is document ASSEMBLY, not drafting: every sentence is
 * built from a recorded field, so nothing in the output is invented.
 */
export function buildNominationRequest(input: NominationRequestInput): NominationRequest {
  const regime = regimeFor(input.jurisdiction);
  const deadlines: { name: string; dueDate: string }[] = [];
  if (regime && input.triggerDate) {
    const generated = generateTimetable(input.jurisdiction, input.triggerDate);
    for (const s of generated?.steps ?? []) {
      if (s.key === "appointment" || s.key === "referral" || s.key === "decision") {
        deadlines.push({ name: s.name, dueDate: s.dueDate });
      }
    }
  }
  const money =
    input.amountInDispute === null
      ? "The amount in dispute has not been quantified on the register."
      : `The amount in dispute is ${input.currency} ${input.amountInDispute.toLocaleString("en-GB")}.`;
  return {
    title: `Request for nomination of an adjudicator — dispute #${input.disputeNumber}: ${input.disputeTitle}`,
    sections: [
      {
        heading: "Nominating body",
        body:
          input.forum ??
          "No nominating body has been recorded on this dispute; insert the body named in the contract before sending.",
      },
      {
        heading: "The contract",
        body:
          `Project: ${input.projectName}. ` +
          (input.contractReference ? `Contract reference: ${input.contractReference}. ` : "No contract reference is recorded. ") +
          (input.contractFamily ? `Contract form: ${input.contractFamily}. ` : "") +
          (input.rules ? `Rules invoked: ${input.rules}.` : ""),
      },
      { heading: "The parties", body: `Referring party: ${input.referringParty}. Responding party: ${input.respondingParty}.` },
      { heading: "Nature of the dispute", body: input.natureOfDispute },
      { heading: "Quantum", body: money },
      {
        heading: "Statutory framework",
        body: regime
          ? `${regime.label} (${regime.statute}). Offsets run from: ${regime.triggerName}` +
            (input.triggerDate ? `, dated ${input.triggerDate}.` : " — no trigger date is recorded.")
          : "No statutory regime has been selected for this dispute; the timetable is contractual only.",
      },
      {
        heading: "Timetable the nomination must support",
        body:
          deadlines.length > 0
            ? deadlines.map((d) => `${d.name}: ${d.dueDate}`).join("; ") + "."
            : "No statutory deadlines could be computed — record a jurisdiction and a trigger date.",
      },
    ],
    deadlines,
    basis:
      `Assembled on ${input.requestedAt} from the dispute register, the linked contract and the ` +
      `${regime ? regime.label : "contract-only"} timetable. Every statement is drawn from a recorded ` +
      `field; nothing has been drafted or inferred.`,
  };
}
