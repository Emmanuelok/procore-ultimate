/**
 * Notice composition engine (spec Vol II Domain C #228, #230; Vol II X
 * #1006-#1007 is the AI half of the same job).
 *
 * What it is: a pure function that turns a contract event plus its EFFECTIVE
 * clause (library ⊕ Particular Conditions) into the pack a compliant notice
 * needs — who serves it on whom, by which route the form's notices clause
 * allows, what the notice must state, which of those facts the record already
 * holds, which are missing, and a deterministic draft built only from facts
 * on the record.
 *
 * Why it is deterministic: a notice is a legal act with a deadline. The draft
 * must exist, and must be honest about its gaps, whether or not the AI layer
 * is configured. The AI drafter (modules/ai/agents/contract.ts) is an
 * enhancement layered on top of this pack, never a precondition for it.
 *
 * What it deliberately does not do: it does not serve anything, does not pick
 * an addressee out of the directory, and never invents a fact. A requirement
 * with no supporting record is reported missing and left as a bracketed
 * placeholder in the draft.
 */
import type { ContractForm } from "@constructos/shared";
import type { EffectiveClause } from "./timebar.js";
import { daysBetweenIso } from "./timebar.js";

export type NoticeUrgency = "expired" | "critical" | "soon" | "routine" | "no_bar";

export interface NoticeRequirement {
  key: string;
  /** what the notice must state */
  label: string;
  /** true when the record already carries the fact */
  satisfied: boolean;
  /** the value on the record, or why it is missing */
  detail: string;
}

export interface NoticeFacts {
  number: number;
  kind: string;
  title: string;
  description: string | null;
  eventDate: string;
  awarenessDate: string | null;
  noticeDeadline: string | null;
  deadlineSource: string | null;
  effectiveTimeBarDays: number | null;
  calendarBasis: string;
  costImpactEstimate: number | null;
  timeImpactDaysEstimate: number | null;
  status: string;
  noticeServedAt: string | null;
}

export interface NoticeContractFacts {
  name: string;
  form: ContractForm;
  currency: string;
  parties: Record<string, string>;
}

export interface NoticePack {
  clauseRef: string | null;
  clauseTitle: string | null;
  deadline: string | null;
  deadlineSource: string | null;
  daysRemaining: number | null;
  urgency: NoticeUrgency;
  /** the party the form expects to give this notice */
  servedBy: string | null;
  /** the party it is served on, from the contract's parties block */
  addressee: string | null;
  addresseeRole: string;
  /** the form's own service rule, quoted so the user can check the route */
  serviceRules: string[];
  requirements: NoticeRequirement[];
  missing: string[];
  /** deterministic draft — bracketed placeholders wherever a fact is missing */
  draft: string;
  /** one sentence explaining where the deadline came from */
  basis: string;
  /** true when this event still needs a notice at all */
  noticeRequired: boolean;
}

/** How each standard form requires notices to be given. */
const SERVICE_RULES: Record<string, string[]> = {
  fidic: [
    "Sub-Clause 1.3 (Notices and Other Communications): the notice must be in writing, must be identified as a Notice, and must state the Sub-Clause under which it is issued.",
    "It must be delivered by hand against receipt, by post or courier against receipt, or by the electronic transmission system stated in the Contract Data, to the address stated there.",
  ],
  nec: [
    "Clause 13.1: each communication is in a form which can be read, copied and recorded.",
    "Clause 13.2: a communication has effect when it is received at the last address notified by the recipient; a communication which the contract requires to be separate is issued separately from other communications.",
    "Clause 13.7: a notification which the contract requires is communicated separately from other communications.",
  ],
  jct: [
    "Clause 1.7: notices and other communications are in writing and given by hand, by pre-paid post, or by the electronic means and to the addresses stated in the Contract Particulars.",
    "Where the Contract Particulars do not state an address, service is at the recipient's last known principal business address.",
  ],
  bespoke: [
    "This form is not in the code-resident clause library, so no service rule can be quoted. Read the contract's own notices clause before serving and record the route used.",
  ],
};

/** Family of a contract form, for the service rules and drafting register. */
export function formFamily(form: string): "fidic" | "nec" | "jct" | "bespoke" {
  if (form.startsWith("fidic")) return "fidic";
  if (form.startsWith("nec")) return "nec";
  if (form.startsWith("jct")) return "jct";
  return "bespoke";
}

/** What the administrator is called under this form. */
export function administratorTitle(form: string): string {
  const family = formFamily(form);
  if (family === "fidic") return "the Engineer";
  if (family === "nec") return "the Project Manager";
  if (family === "jct") return "the Contract Administrator";
  return "the contract administrator";
}

/**
 * Urgency from the deadline alone, so the same word means the same thing in
 * the API, the UI badge and the AI prompt.
 */
export function noticeUrgency(deadline: string | null, today: string): NoticeUrgency {
  if (!deadline) return "no_bar";
  const days = daysBetweenIso(today, deadline);
  if (days < 0) return "expired";
  if (days <= 3) return "critical";
  if (days <= 10) return "soon";
  return "routine";
}

function requirement(
  key: string,
  label: string,
  value: string | number | null | undefined,
  missingWhy: string,
): NoticeRequirement {
  const present =
    value !== null && value !== undefined && String(value).trim().length > 0;
  return {
    key,
    label,
    satisfied: present,
    detail: present ? String(value) : missingWhy,
  };
}

/**
 * Build the notice pack.
 *
 * `today` is passed in — the engine has no clock, so a test can sit on any
 * date and the sweep and the route agree on what "3 days out" means.
 */
export function buildNoticePack(args: {
  contract: NoticeContractFacts;
  event: NoticeFacts;
  clause: EffectiveClause | null;
  today: string;
}): NoticePack {
  const { contract, event, clause, today } = args;
  const family = formFamily(contract.form);
  const parties = contract.parties ?? {};

  // Who gives the notice, and to whom. The library records the party the form
  // expects to notify; the addressee is the administrator except where the
  // administrator is the one giving it.
  const servedBy = clause?.noticeBy && clause.noticeBy !== "either" ? clause.noticeBy : null;
  const addresseeRole = servedBy === "administrator" ? "contractor" : "administrator";
  const addressee = parties[addresseeRole] ?? null;

  const start = event.awarenessDate ?? event.eventDate;
  const urgency = noticeUrgency(event.noticeDeadline, today);
  const daysRemaining = event.noticeDeadline ? daysBetweenIso(today, event.noticeDeadline) : null;

  const requirements: NoticeRequirement[] = [
    requirement(
      "event_description",
      "A description of the event or circumstance relied on",
      event.description ?? (event.title.length > 40 ? event.title : null),
      "The event record carries only a short title; a notice needs the facts of the event itself.",
    ),
    requirement(
      "event_date",
      "The date the event or circumstance occurred",
      event.eventDate,
      "Not recorded on the event.",
    ),
    requirement(
      "awareness_date",
      "The date the notifying party became aware of it (the date the bar runs from)",
      event.awarenessDate,
      "Not recorded; the deadline has been computed from the event date instead, which is the less favourable reading.",
    ),
    requirement(
      "clause_ref",
      "The clause the notice is given under",
      clause ? `${contract.form.toUpperCase()} ${clause.clauseRef} — ${clause.title}` : null,
      "No clause is attached to this event, so the notice cannot state its own basis.",
    ),
    requirement(
      "addressee",
      `The party the notice is served on (${addresseeRole})`,
      addressee,
      `The contract's parties block has no "${addresseeRole}", so the addressee must be supplied before service.`,
    ),
  ];

  // Category-specific content. A time claim must say what time is sought; a
  // money claim must at least say that cost is claimed and how it will be
  // particularised.
  const category = clause?.category ?? null;
  // A FIDIC 20.2 / NEC 61.3 notice claims BOTH heads, so a "notice" clause
  // pulls in the time and the money requirement; a pure time or payment clause
  // pulls in only its own.
  const timeHead =
    category === "time" ||
    category === "risk" ||
    category === "notice" ||
    event.kind === "delay_event" ||
    event.kind === "eot_claim";
  const moneyHead =
    category === "payment" ||
    category === "variation" ||
    category === "risk" ||
    category === "notice" ||
    event.kind === "claim_notice" ||
    event.kind === "compensation_event";
  if (timeHead) {
    requirements.push(
      requirement(
        "time_impact",
        "The extension of time sought, or a statement that it will be particularised",
        event.timeImpactDaysEstimate,
        "No time impact estimate is recorded; state that particulars will follow rather than omitting the head of claim.",
      ),
    );
  }
  if (moneyHead) {
    requirements.push(
      requirement(
        "cost_impact",
        "The additional payment claimed, or a statement that it will be particularised",
        event.costImpactEstimate != null
          ? `${event.costImpactEstimate} ${contract.currency}`
          : null,
        "No cost estimate is recorded; state that particulars will follow rather than omitting the head of claim.",
      ),
    );
  }

  const missing = requirements.filter((r) => !r.satisfied).map((r) => r.label);

  const basis = clause
    ? clause.timeBarDays != null
      ? `${clause.timeBarDays} ${clause.calendarBasis === "working" ? "working" : "calendar"} days from ${start} under ${contract.form.toUpperCase()} ${clause.clauseRef}` +
        (clause.deadlineSource === "particular_condition"
          ? ` as amended by the Particular Conditions (the standard form states ${clause.libraryTimeBarDays ?? "no"} days).`
          : ".")
      : `${contract.form.toUpperCase()} ${clause.clauseRef} imposes no day-counted bar; the notice is still required to be given promptly.`
    : "No clause is attached to this event, so no contractual bar has been computed.";

  const placeholder = (r: NoticeRequirement, text: string) =>
    r.satisfied ? text : `[${r.label} — NOT ON RECORD]`;
  const byKey = new Map(requirements.map((r) => [r.key, r]));
  const req = (k: string) => byKey.get(k)!;

  const heading =
    family === "nec"
      ? `NOTIFICATION UNDER ${contract.form.toUpperCase().replace("_", " ")} CLAUSE ${clause?.clauseRef ?? "[CLAUSE]"}`
      : `NOTICE UNDER ${contract.form.toUpperCase().replace(/_/g, " ")} SUB-CLAUSE ${clause?.clauseRef ?? "[CLAUSE]"}`;

  const draftLines = [
    heading,
    "",
    `Project / Contract: ${contract.name}`,
    `To: ${placeholder(req("addressee"), `${addressee} (${administratorTitle(contract.form)})`)}`,
    `Event reference: #${event.number} — ${event.title}`,
    `Date of this notice: ${today}`,
    "",
    `1. This is a Notice given under ${placeholder(req("clause_ref"), req("clause_ref").detail)}.`,
    `2. The event or circumstance relied on occurred on ${event.eventDate}${
      event.awarenessDate ? ` and came to our attention on ${event.awarenessDate}` : ""
    }.`,
    `3. The event or circumstance is: ${placeholder(req("event_description"), req("event_description").detail)}`,
  ];
  const timeReq = byKey.get("time_impact");
  if (timeReq) {
    draftLines.push(
      `4. We consider that this event entitles us to an extension of time of ${
        timeReq.satisfied
          ? `${timeReq.detail} days`
          : "[an amount to be particularised once the effect on the programme has been assessed]"
      }.`,
    );
  }
  const costReq = byKey.get("cost_impact");
  if (costReq) {
    draftLines.push(
      `${timeReq ? "5" : "4"}. We consider that this event entitles us to additional payment of ${
        costReq.satisfied
          ? costReq.detail
          : "[an amount to be particularised once the cost has been ascertained]"
      }.`,
    );
  }
  draftLines.push(
    "",
    "Full particulars will follow in accordance with the Contract. This notice is given without prejudice to our other rights and remedies under the Contract and at law.",
    "",
    "Signed: ______________________",
    `For and on behalf of: ${parties[servedBy ?? "contractor"] ?? "[the notifying party]"}`,
  );

  return {
    clauseRef: clause?.clauseRef ?? null,
    clauseTitle: clause?.title ?? null,
    deadline: event.noticeDeadline,
    deadlineSource: event.deadlineSource,
    daysRemaining,
    urgency,
    servedBy,
    addressee,
    addresseeRole,
    serviceRules: SERVICE_RULES[family] ?? SERVICE_RULES["bespoke"]!,
    requirements,
    missing,
    draft: draftLines.join("\n"),
    basis,
    noticeRequired: clause?.noticeRequired ?? true,
  };
}
