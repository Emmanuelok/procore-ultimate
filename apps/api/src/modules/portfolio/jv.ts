/**
 * Joint-venture, consortium and SPV arithmetic.
 * Spec Vol II Domain Z #1057 (JV and consortium accounting with partner
 * shares), #1058 (governance, board and deed compliance), #1059 (partner
 * contribution and distribution tracking), #1060 (SPV financial reporting).
 *
 * Pure and deterministic. Two things are computed here and nowhere else:
 *
 *  1. THE PARTNER POSITION — what each partner committed, contributed,
 *     received and still owes, plus the tenant's own share of the venture
 *     ("our share"), which is the number an owner actually needs.
 *  2. THE GOVERNANCE OUTCOME — whether a board decision was quorate and
 *     whether it carried, computed from the deed's percentages and the votes
 *     actually cast. A decision that is not quorate is `not_quorate`, never
 *     "approved by those present".
 *
 * What it deliberately does NOT do: net contributions against distributions
 * across currencies, or assume an absent partner abstained. An absent partner
 * is absent, and absence reduces the share present.
 */

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export interface PartnerRow {
  id: string;
  name: string;
  role: string;
  sharePercent: number;
  committedCapital: number | null;
  liabilityBasis: string;
  isSelf: boolean;
  status: string;
}

export interface TransactionRow {
  id: string;
  partnerId: string;
  kind: string;
  currency: string;
  amount: number;
  dueDate: string | null;
  settledDate: string | null;
  status: string;
}

/** Kinds that move money INTO the venture from a partner. */
export const INFLOW_KINDS = ["capital_contribution", "capital_call", "working_capital_advance", "guarantee_call"];
/** Kinds that move money OUT of the venture to a partner. */
export const OUTFLOW_KINDS = ["distribution", "profit_share", "management_fee", "expense_reimbursement"];

export interface PartnerPosition {
  partnerId: string;
  name: string;
  role: string;
  sharePercent: number;
  isSelf: boolean;
  committedCapital: number | null;
  contributed: number;
  distributed: number;
  /** called but not yet settled */
  outstandingCalls: number;
  overdueCalls: number;
  overdueAmount: number;
  /** contributed − distributed, in the venture currency */
  netPosition: number;
  /** committed − contributed; null when no commitment was recorded */
  uncalledCommitment: number | null;
  currencyMismatches: number;
  reasons: string[];
}

export interface VentureSummary {
  currency: string;
  partnerCount: number;
  shareTotalPercent: number;
  sharesBalanced: boolean;
  totalContributed: number;
  totalDistributed: number;
  totalOutstandingCalls: number;
  totalOverdueAmount: number;
  overdueCallCount: number;
  /** the tenant's own share of the venture, when a partner is flagged isSelf */
  ourSharePercent: number | null;
  ourContributed: number | null;
  positions: PartnerPosition[];
  reasons: string[];
  warnings: string[];
}

/**
 * Partner positions and the venture summary. `today` is supplied so overdue
 * is computed against the caller's clock, not this module's.
 */
export function venturePosition(
  partners: PartnerRow[],
  transactions: TransactionRow[],
  options: { currency: string; today: string },
): VentureSummary {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const active = partners.filter((p) => p.status === "active");
  const shareTotal = round2(active.reduce((s, p) => s + p.sharePercent, 0));
  const sharesBalanced = Math.abs(shareTotal - 100) < 0.01;
  if (!sharesBalanced) {
    warnings.push(
      `Active partner shares total ${shareTotal}%, not 100%. Every "our share" figure below rests on the shares as recorded.`,
    );
  }

  const positions: PartnerPosition[] = partners.map((partner) => {
    const mine = transactions.filter((t) => t.partnerId === partner.id);
    const same = mine.filter((t) => t.currency === options.currency);
    const mismatches = mine.length - same.length;
    const partnerReasons: string[] = [];
    if (mismatches > 0) {
      partnerReasons.push(
        `${mismatches} transaction(s) are in a currency other than the venture's (${options.currency}) and are excluded from this position.`,
      );
    }
    const settled = same.filter((t) => t.status === "paid");
    const contributed = round2(
      settled.filter((t) => INFLOW_KINDS.includes(t.kind)).reduce((s, t) => s + t.amount, 0),
    );
    const distributed = round2(
      settled.filter((t) => OUTFLOW_KINDS.includes(t.kind)).reduce((s, t) => s + t.amount, 0),
    );
    const open = same.filter((t) => t.status === "called" || t.status === "overdue");
    const outstandingCalls = round2(
      open.filter((t) => INFLOW_KINDS.includes(t.kind)).reduce((s, t) => s + t.amount, 0),
    );
    const overdue = open.filter(
      (t) => INFLOW_KINDS.includes(t.kind) && t.dueDate !== null && t.dueDate < options.today,
    );
    const overdueAmount = round2(overdue.reduce((s, t) => s + t.amount, 0));
    const uncalled =
      partner.committedCapital === null ? null : round2(partner.committedCapital - contributed);
    if (partner.committedCapital === null) {
      partnerReasons.push("No committed capital recorded, so the uncalled commitment is unknown.");
    }
    return {
      partnerId: partner.id,
      name: partner.name,
      role: partner.role,
      sharePercent: partner.sharePercent,
      isSelf: partner.isSelf,
      committedCapital: partner.committedCapital,
      contributed,
      distributed,
      outstandingCalls,
      overdueCalls: overdue.length,
      overdueAmount,
      netPosition: round2(contributed - distributed),
      uncalledCommitment: uncalled,
      currencyMismatches: mismatches,
      reasons: partnerReasons,
    };
  });

  const self = positions.find((p) => p.isSelf) ?? null;
  if (!self) {
    reasons.push("No partner is flagged as this company, so \"our share\" cannot be reported.");
  }
  const totalMismatches = positions.reduce((s, p) => s + p.currencyMismatches, 0);
  if (totalMismatches > 0) {
    reasons.push(`${totalMismatches} transaction(s) in another currency are excluded from every total.`);
  }

  return {
    currency: options.currency,
    partnerCount: partners.length,
    shareTotalPercent: shareTotal,
    sharesBalanced,
    totalContributed: round2(positions.reduce((s, p) => s + p.contributed, 0)),
    totalDistributed: round2(positions.reduce((s, p) => s + p.distributed, 0)),
    totalOutstandingCalls: round2(positions.reduce((s, p) => s + p.outstandingCalls, 0)),
    totalOverdueAmount: round2(positions.reduce((s, p) => s + p.overdueAmount, 0)),
    overdueCallCount: positions.reduce((s, p) => s + p.overdueCalls, 0),
    ourSharePercent: self ? self.sharePercent : null,
    ourContributed: self ? self.contributed : null,
    positions,
    reasons,
    warnings,
  };
}

/* ================================================================== */
/* Governance: quorum and threshold (#1058)                            */
/* ================================================================== */

export type VoteValue = "for" | "against" | "abstain";

export interface VoteRow {
  partnerId: string;
  vote: VoteValue;
}

export interface DecisionOutcome {
  sharePresentPercent: number;
  shareForPercent: number;
  shareAgainstPercent: number;
  shareAbstainPercent: number;
  quorumPercent: number | null;
  thresholdPercent: number | null;
  quorumMet: boolean;
  thresholdMet: boolean;
  outcome: "approved" | "rejected" | "deferred" | "not_quorate";
  unknownVoters: string[];
  reasons: string[];
}

/**
 * Decide a board vote against the deed's quorum and threshold. Shares are
 * taken from the partner register, so a vote cast by a partner with no share
 * counts as present but carries no weight — and is named in `unknownVoters`
 * when the partner is not on the register at all.
 *
 * A reserved matter defaults to unanimity of the shares present when the deed
 * records no explicit threshold; that default is stated in `reasons` rather
 * than applied silently.
 */
export function decideVote(
  partners: PartnerRow[],
  votes: VoteRow[],
  options: {
    quorumPercent: number | null;
    thresholdPercent: number | null;
    decisionType: string;
  },
): DecisionOutcome {
  const reasons: string[] = [];
  const shareOf = new Map(partners.filter((p) => p.status === "active").map((p) => [p.id, p.sharePercent]));
  const unknownVoters: string[] = [];
  const counted = new Map<string, VoteValue>();
  for (const v of votes) {
    if (!shareOf.has(v.partnerId)) {
      unknownVoters.push(v.partnerId);
      continue;
    }
    // A partner voting twice: the last entry stands, and we say so.
    if (counted.has(v.partnerId)) {
      reasons.push(`Partner ${v.partnerId} appears more than once; the last vote recorded stands.`);
    }
    counted.set(v.partnerId, v.vote);
  }
  if (unknownVoters.length > 0) {
    reasons.push(`${unknownVoters.length} vote(s) were cast by parties that are not active partners and carry no share.`);
  }

  let present = 0;
  let forShare = 0;
  let againstShare = 0;
  let abstainShare = 0;
  for (const [partnerId, vote] of counted) {
    const share = shareOf.get(partnerId) ?? 0;
    present += share;
    if (vote === "for") forShare += share;
    else if (vote === "against") againstShare += share;
    else abstainShare += share;
  }
  present = round2(present);
  forShare = round2(forShare);
  againstShare = round2(againstShare);
  abstainShare = round2(abstainShare);

  const quorumPercent = options.quorumPercent;
  const quorumMet = quorumPercent === null ? true : present + 1e-9 >= quorumPercent;
  if (quorumPercent === null) {
    reasons.push("The venture records no quorum requirement; the vote is treated as quorate.");
  }

  let thresholdPercent = options.thresholdPercent;
  if (options.decisionType === "reserved_matter" && thresholdPercent === null) {
    thresholdPercent = present;
    reasons.push(
      "This is a reserved matter and the deed records no threshold, so unanimity of the shares present is required.",
    );
  }
  if (thresholdPercent === null) {
    thresholdPercent = present / 2;
    reasons.push("No threshold is recorded; a simple majority of the shares present is applied.");
  }
  const thresholdMet = forShare > thresholdPercent - 1e-9 && forShare > 0;

  let outcome: DecisionOutcome["outcome"];
  if (!quorumMet) outcome = "not_quorate";
  else if (thresholdMet) outcome = "approved";
  else if (forShare + abstainShare === 0 && againstShare === 0) outcome = "deferred";
  else outcome = "rejected";

  return {
    sharePresentPercent: present,
    shareForPercent: forShare,
    shareAgainstPercent: againstShare,
    shareAbstainPercent: abstainShare,
    quorumPercent,
    thresholdPercent: round2(thresholdPercent),
    quorumMet,
    thresholdMet,
    outcome,
    unknownVoters,
    reasons,
  };
}
