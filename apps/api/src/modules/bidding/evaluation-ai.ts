/**
 * THE AI EVALUATION ASSISTANT — proposals, never entries.
 *
 * Levelling is the analytical core of this module and it is slow work: a
 * buyer reads every bidder's exclusions, qualifications and assumptions and
 * decides, row by neutral row, whether the price in front of them covers the
 * scope. The model is good at the reading and has no business making the
 * decision, so this file draws the line in one place:
 *
 *   IT PROPOSES. IT NEVER WRITES. Nothing here inserts a levelling entry.
 *   Every output is a DRAFT the evaluator accepts cell by cell through the
 *   ordinary POST /levelling/entries route, which is where the adjustment
 *   reason, the segregation and the ledger already live.
 *
 *   EVERY PROPOSAL CITES ITS SOURCE SENTENCE. A proposal that cannot name
 *   the sentence it came from is dropped before the caller sees it, not
 *   shown with a shrug. `reconcileProposals` is the gate, and it is pure and
 *   tested: a row id or a submission id the prompt never supplied is a
 *   fabrication however plausible the text around it reads.
 *
 *   IT DEGRADES TO NOTHING. With no API key the endpoint answers 503
 *   AiDisabled and every other route in this module is unaffected. Levelling
 *   by hand is the normal path; this is an accelerator on top of it.
 *
 * Covers the audit's "AI evaluation assistant with citations" upgrade for
 * WP-BID and Vol I §6.4. Deliberately NOT here: accepting a proposal (that is
 * the existing levelling route), scoring bids, and anything that decides who
 * wins — the award controls stay human by construction.
 */

import { z } from "zod";
import {
  LEVELLING_ADJUSTMENT_REASONS,
  LEVELLING_INCLUSIONS,
  type LevellingAdjustmentReason,
  type LevellingInclusion,
} from "@constructos/shared";

/* ------------------------------------------------------------------ */
/* What the model is shown                                             */
/* ------------------------------------------------------------------ */

export interface PromptScopeRow {
  id: string;
  itemCode: string | null;
  description: string;
  category: string;
  isMandatory: boolean;
  unit: string | null;
  estimatedQuantity: number | null;
}

export interface PromptBid {
  submissionId: string;
  reference: string;
  vendorName: string;
  currency: string;
  exclusions: string | null;
  qualifications: string | null;
  assumptions: string | null;
  lines: Array<{
    id: string;
    itemCode: string | null;
    description: string;
    amount: number | null;
    unitRate: number | null;
    quantity: number | null;
    levellingItemId: string | null;
  }>;
  /** rows this bidder already has a levelling entry on — never re-proposed */
  answeredItemIds: string[];
}

export interface EvaluationPrompt {
  system: string;
  user: string;
  contextChars: number;
  /** how many (row, bidder) cells were actually put to the model */
  openCells: number;
}

const CHAR_BUDGET_PER_TEXT = 4_000;
const MAX_LINES_PER_BID = 120;

const trim = (value: string | null, limit = CHAR_BUDGET_PER_TEXT): string =>
  value === null || value.trim().length === 0
    ? "(none stated)"
    : value.length <= limit
      ? value
      : `${value.slice(0, limit)}… [truncated at ${limit} characters]`;

/**
 * Assemble the prompt. Pure and separately tested, because a prompt that
 * quietly stops including the exclusions is a silent quality regression that
 * no integration test would notice.
 */
export function buildEvaluationPrompt(input: {
  packageReference: string;
  packageTitle: string;
  currency: string;
  scopeDescription: string | null;
  rows: readonly PromptScopeRow[];
  bids: readonly PromptBid[];
}): EvaluationPrompt {
  const system = [
    "You are the ConstructOS bid levelling assistant.",
    "You are given a buyer's neutral scope rows and each bidder's own words.",
    "For each (scope row, bidder) cell that has NO entry yet, propose whether that bidder's",
    "price includes the row, and quote the SENTENCE from that bidder's text or the line item",
    "that made you think so.",
    "Rules you may not break:",
    "- Use ONLY the supplied text and line items. Never invent a price, a quantity or a clause.",
    "- Every proposal MUST carry sourceQuote: a verbatim fragment of the supplied bidder text",
    "  or line description. A proposal you cannot quote for is one you must not make.",
    "- levellingItemId and submissionId must be ids that appear in this prompt, exactly.",
    `- includedStatus is one of: ${LEVELLING_INCLUSIONS.join(", ")}.`,
    `- adjustmentReason, when you suggest an adjustment, is one of: ${LEVELLING_ADJUSTMENT_REASONS.join(", ")}.`,
    "- Where the bidder's words are ambiguous, say 'unclear' and write the clarification question",
    "  you would ask them. Ambiguity is a finding, not a gap to fill with a guess.",
    "- confidence is 0-1 and reflects how directly the quote answers the row.",
    'Return ONLY JSON: {"proposals":[{"levellingItemId":string,"submissionId":string,',
    '"includedStatus":string,"adjustmentAmount":number|null,"adjustmentReason":string|null,',
    '"sourceQuote":string,"rationale":string,"clarificationQuestion":string|null,',
    '"confidence":number}],"complianceNotes":[{"submissionId":string,"note":string,',
    '"sourceQuote":string}],"citations":[{"type":string,"id":string}]}',
  ].join("\n");

  let openCells = 0;
  const bidBlocks = input.bids.map((bid) => {
    const open = input.rows.filter((r) => !bid.answeredItemIds.includes(r.id));
    openCells += open.length;
    return [
      `### Bid ${bid.reference} — ${bid.vendorName} (submissionId ${bid.submissionId}, ${bid.currency})`,
      `Exclusions: ${trim(bid.exclusions)}`,
      `Qualifications: ${trim(bid.qualifications)}`,
      `Assumptions: ${trim(bid.assumptions)}`,
      bid.lines.length === 0
        ? "Priced lines: (none recorded)"
        : [
            `Priced lines (${bid.lines.length}${bid.lines.length > MAX_LINES_PER_BID ? `, first ${MAX_LINES_PER_BID} shown` : ""}):`,
            ...bid.lines
              .slice(0, MAX_LINES_PER_BID)
              .map(
                (l) =>
                  `- lineId ${l.id} | ${l.itemCode ?? "(no code)"} | ${l.description} | ` +
                  `amount ${l.amount ?? "not stated"} | rate ${l.unitRate ?? "not stated"} | ` +
                  `qty ${l.quantity ?? "not stated"}` +
                  (l.levellingItemId ? ` | already mapped to ${l.levellingItemId}` : ""),
              ),
          ].join("\n"),
      open.length === 0
        ? "Every scope row already has an entry for this bidder — propose nothing."
        : `Rows still open for this bidder: ${open.map((r) => r.id).join(", ")}`,
    ].join("\n");
  });

  const user = [
    `Package ${input.packageReference} — ${input.packageTitle}. Currency ${input.currency}.`,
    `Scope: ${trim(input.scopeDescription, 2_000)}`,
    "",
    "## Scope rows (the buyer's neutral description — propose against these ids only)",
    ...input.rows.map(
      (r) =>
        `- ${r.id} | ${r.itemCode ?? "(no code)"} | ${r.description} | ${r.category}` +
        `${r.isMandatory ? " | MANDATORY" : ""}` +
        `${r.unit ? ` | ${r.estimatedQuantity ?? "?"} ${r.unit}` : ""}`,
    ),
    "",
    "## Bids",
    ...bidBlocks,
  ].join("\n");

  return { system, user, contextChars: user.length, openCells };
}

/* ------------------------------------------------------------------ */
/* What comes back                                                     */
/* ------------------------------------------------------------------ */

export const evaluationOutputSchema = z.object({
  proposals: z
    .array(
      z.object({
        levellingItemId: z.string().min(1).max(64),
        submissionId: z.string().min(1).max(64),
        includedStatus: z.string().min(1).max(40),
        adjustmentAmount: z.number().finite().nullable().default(null),
        adjustmentReason: z.string().max(60).nullable().default(null),
        sourceQuote: z.string().max(2_000).default(""),
        rationale: z.string().max(2_000).default(""),
        clarificationQuestion: z.string().max(1_000).nullable().default(null),
        confidence: z.number().min(0).max(1).default(0.5),
      }),
    )
    .max(500)
    .default([]),
  complianceNotes: z
    .array(
      z.object({
        submissionId: z.string().min(1).max(64),
        note: z.string().max(4_000),
        sourceQuote: z.string().max(2_000).default(""),
      }),
    )
    .max(100)
    .default([]),
});

export type EvaluationOutput = z.infer<typeof evaluationOutputSchema>;

export interface AcceptedProposal {
  levellingItemId: string;
  itemCode: string | null;
  itemDescription: string;
  submissionId: string;
  submissionReference: string;
  vendorName: string;
  includedStatus: LevellingInclusion;
  adjustmentAmount: number | null;
  adjustmentReason: LevellingAdjustmentReason | null;
  sourceQuote: string;
  rationale: string;
  clarificationQuestion: string | null;
  confidence: number;
  /** the body a client POSTs to /levelling/entries if the evaluator accepts */
  apply: Record<string, unknown>;
}

export interface ReconciledProposals {
  proposals: AcceptedProposal[];
  complianceNotes: Array<{ submissionId: string; reference: string; note: string; sourceQuote: string }>;
  dropped: Array<{ reason: string; detail: string }>;
}

/**
 * Keep only the proposals that name a row and a bid the prompt supplied, sit
 * on a cell nobody has answered yet, use a vocabulary the API accepts, and
 * quote something. Everything else is DROPPED WITH ITS REASON — the count of
 * silently-discarded model output is a number an evaluator is entitled to
 * see, because it is the honest measure of how much of this to trust.
 */
export function reconcileProposals(
  output: EvaluationOutput,
  rows: readonly PromptScopeRow[],
  bids: readonly PromptBid[],
): ReconciledProposals {
  const rowById = new Map(rows.map((r) => [r.id, r] as const));
  const bidById = new Map(bids.map((b) => [b.submissionId, b] as const));
  const seen = new Set<string>();
  const proposals: AcceptedProposal[] = [];
  const dropped: Array<{ reason: string; detail: string }> = [];

  for (const p of output.proposals) {
    const row = rowById.get(p.levellingItemId);
    if (!row) {
      dropped.push({
        reason: "unknown_scope_row",
        detail: `${p.levellingItemId} is not a scope row on this package.`,
      });
      continue;
    }
    const bid = bidById.get(p.submissionId);
    if (!bid) {
      dropped.push({
        reason: "unknown_submission",
        detail: `${p.submissionId} is not a bid that was put to the model.`,
      });
      continue;
    }
    if (bid.answeredItemIds.includes(row.id)) {
      dropped.push({
        reason: "cell_already_answered",
        detail: `${bid.reference} already has an entry on ${row.itemCode ?? row.description}; a human answer is never overwritten by a proposal.`,
      });
      continue;
    }
    const key = `${row.id}:${bid.submissionId}`;
    if (seen.has(key)) {
      dropped.push({
        reason: "duplicate_proposal",
        detail: `A second proposal for ${bid.reference} on ${row.itemCode ?? row.description} was discarded.`,
      });
      continue;
    }
    if (!(LEVELLING_INCLUSIONS as readonly string[]).includes(p.includedStatus)) {
      dropped.push({
        reason: "unknown_inclusion_status",
        detail: `"${p.includedStatus}" is not an inclusion status this platform recognises.`,
      });
      continue;
    }
    const reason =
      p.adjustmentReason !== null &&
      (LEVELLING_ADJUSTMENT_REASONS as readonly string[]).includes(p.adjustmentReason)
        ? (p.adjustmentReason as LevellingAdjustmentReason)
        : null;
    if (p.adjustmentReason !== null && reason === null) {
      dropped.push({
        reason: "unknown_adjustment_reason",
        detail: `"${p.adjustmentReason}" is not an adjustment reason this platform recognises.`,
      });
      continue;
    }
    if (p.sourceQuote.trim().length < 3) {
      dropped.push({
        reason: "no_source_quote",
        detail: `A proposal for ${bid.reference} on ${row.itemCode ?? row.description} quoted nothing, so there is nothing to check it against.`,
      });
      continue;
    }
    /*
     * An adjustment with no reason is refused by the levelling route itself.
     * Proposing one anyway would hand the evaluator a body that cannot be
     * submitted, so it is dropped here where the reason can be stated.
     */
    const adjustment = p.adjustmentAmount;
    if (adjustment !== null && adjustment !== 0 && reason === null) {
      dropped.push({
        reason: "adjustment_without_reason",
        detail: `An adjustment of ${adjustment} for ${bid.reference} carried no reason; the levelling route would refuse it.`,
      });
      continue;
    }
    seen.add(key);
    proposals.push({
      levellingItemId: row.id,
      itemCode: row.itemCode,
      itemDescription: row.description,
      submissionId: bid.submissionId,
      submissionReference: bid.reference,
      vendorName: bid.vendorName,
      includedStatus: p.includedStatus as LevellingInclusion,
      adjustmentAmount: adjustment,
      adjustmentReason: reason,
      sourceQuote: p.sourceQuote.trim(),
      rationale: p.rationale.trim(),
      clarificationQuestion:
        p.clarificationQuestion && p.clarificationQuestion.trim().length > 0
          ? p.clarificationQuestion.trim()
          : null,
      confidence: p.confidence,
      apply: {
        levellingItemId: row.id,
        submissionId: bid.submissionId,
        includedStatus: p.includedStatus,
        ...(adjustment !== null && adjustment !== 0
          ? { adjustmentAmount: adjustment, adjustmentReason: reason }
          : {}),
        adjustmentNote:
          `AI proposal accepted by the evaluator. Source: "${p.sourceQuote.trim().slice(0, 400)}"` +
          (p.rationale.trim() ? ` — ${p.rationale.trim().slice(0, 400)}` : ""),
      },
    });
  }

  const notes = output.complianceNotes.flatMap((n) => {
    const bid = bidById.get(n.submissionId);
    if (!bid) {
      dropped.push({
        reason: "unknown_submission",
        detail: `A compliance note named ${n.submissionId}, which is not a bid on this package.`,
      });
      return [];
    }
    return [
      {
        submissionId: bid.submissionId,
        reference: bid.reference,
        note: n.note,
        sourceQuote: n.sourceQuote,
      },
    ];
  });

  return { proposals, complianceNotes: notes, dropped };
}
