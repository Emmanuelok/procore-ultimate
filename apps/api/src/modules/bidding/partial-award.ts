/**
 * PARTIAL AWARDS — one package, several winners, no scope awarded twice.
 *
 * A tender is frequently split: the groundworks go to one bidder and the
 * frame to another, because that is where each of them was strongest. The
 * record of that has to answer three questions an auditor will ask, and none
 * of them can be answered by a free-text note:
 *
 *   1. WHICH SCOPE did this award actually buy? Levelling rows are the only
 *      neutral description of scope on the package — the buyer wrote them,
 *      not the bidders — so a partial award names the levelling item ids it
 *      covers and nothing else.
 *   2. WAS ANY SCOPE BOUGHT TWICE? Two awards whose scope sets overlap mean
 *      the same work is committed under two subcontracts, which is how a
 *      project pays for a wall once and builds it once. Overlap is refused,
 *      naming the rows and the award that already holds them.
 *   3. WHAT IS THE AWARD WORTH? Not the bidder's headline total — that priced
 *      the whole package. A partial award is worth the sum of THAT BIDDER's
 *      LEVELLED amounts on THOSE ROWS, and if any one of them has no levelled
 *      figure the sum has a hole in it and is refused rather than guessed.
 *      The comparison that decides `isLowestBid` is re-run on the same subset,
 *      because "the lowest bid" for the frame is not "the lowest bid" for the
 *      package.
 *
 * Everything here is pure: no database, no clock, no request. The route
 * assembles the rows and this decides. Covers Vol I #175 (partial award) and
 * the award-lifecycle completion in the audit's WP-BID upgrades.
 *
 * Deliberately NOT here: how the remaining scope gets re-tendered (that is a
 * new package), and any attempt to net partial awards off against the
 * engineer's estimate — the estimate is for the whole package and comparing a
 * subset to it would be an invented number.
 */

import { round2 } from "./shared.js";

export interface ScopeItem {
  id: string;
  position: number;
  itemCode: string | null;
  description: string;
  isMandatory: boolean;
}

export interface LiveAwardScope {
  awardId: string;
  reference: string;
  status: string;
  /** empty means the award covers the whole package */
  scopeLevellingItemIds: readonly string[];
}

export interface LevelledCell {
  levellingItemId: string;
  submissionId: string;
  levelledAmount: number | null;
  currency: string;
  includedStatus: string;
}

export type ScopePlan =
  | { ok: true; plan: AwardScopePlan }
  | { ok: false; code: ScopeRefusal; message: string; detail: Record<string, unknown> };

export type ScopeRefusal =
  | "unknown_scope_rows"
  | "empty_scope"
  | "scope_overlap"
  | "full_award_exists"
  | "partial_award_exists";

export interface AwardScopePlan {
  /** false = this award covers the whole package, the ordinary case */
  partial: boolean;
  /** the rows this award covers, in package order */
  scopeItemIds: string[];
  /** every row covered by a live award once this one is approved */
  coveredItemIds: string[];
  /** mandatory rows still without a winner after this award */
  remaining: ScopeItem[];
  /** what the package status becomes when this award is APPROVED */
  packageStatusAfterApproval: "awarded" | "partially_awarded";
  /** a sentence for the ledger and the UI */
  note: string;
}

const LIVE_AWARD_STATUSES_NOTE =
  "rejected, withdrawn and cancelled awards hold no scope and are ignored here";

/**
 * Decide whether an award may be made over `requested` scope rows, given the
 * package's rows and the awards already live on it.
 *
 * `requested` empty (or absent) means a WHOLE-PACKAGE award, which is refused
 * whenever any live award already holds scope: you cannot buy everything when
 * somebody has already bought the frame.
 */
export function planAwardScope(input: {
  items: readonly ScopeItem[];
  liveAwards: readonly LiveAwardScope[];
  requested: readonly string[] | undefined;
}): ScopePlan {
  const items = [...input.items].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const byId = new Map(items.map((i) => [i.id, i] as const));
  const requested = [...new Set(input.requested ?? [])];
  const partial = requested.length > 0;

  const fullLive = input.liveAwards.filter((a) => a.scopeLevellingItemIds.length === 0);
  const partialLive = input.liveAwards.filter((a) => a.scopeLevellingItemIds.length > 0);

  if (!partial) {
    if (partialLive.length > 0) {
      return {
        ok: false,
        code: "partial_award_exists",
        message:
          `${partialLive.map((a) => a.reference).join(", ")} already ` +
          `${partialLive.length === 1 ? "holds" : "hold"} part of this package's scope, so a ` +
          "whole-package award would buy that work a second time. Recommend the remaining scope " +
          "as a partial award (name its levelling rows in scopeLevellingItemIds), or withdraw " +
          "the existing award first.",
        detail: { liveAwardIds: partialLive.map((a) => a.awardId) },
      };
    }
    if (fullLive.length > 0) {
      return {
        ok: false,
        code: "full_award_exists",
        message:
          `${fullLive[0]!.reference} already covers this package at status ` +
          `"${fullLive[0]!.status}". Reject or withdraw it before recommending a different ` +
          "bidder.",
        detail: { liveAwardIds: fullLive.map((a) => a.awardId) },
      };
    }
  } else {
    if (fullLive.length > 0) {
      return {
        ok: false,
        code: "full_award_exists",
        message:
          `${fullLive[0]!.reference} already covers the WHOLE of this package at status ` +
          `"${fullLive[0]!.status}", so there is no scope left to award in part. Withdraw it ` +
          "first if the package is to be split.",
        detail: { liveAwardIds: fullLive.map((a) => a.awardId) },
      };
    }
  }

  if (partial) {
    const unknown = requested.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      return {
        ok: false,
        code: "unknown_scope_rows",
        message:
          `${unknown.length} of the scope rows named are not levelling rows on this package: ` +
          `${unknown.slice(0, 10).join(", ")}. A partial award is defined by the buyer's own ` +
          "scope rows — an id from somewhere else describes nothing anybody agreed to.",
        detail: { unknownItemIds: unknown },
      };
    }
    if (items.length === 0) {
      return {
        ok: false,
        code: "empty_scope",
        message:
          "This package has no levelling rows, so there is no defined scope to split. Build the " +
          "levelling scope first: a partial award with no neutral description of what it bought " +
          "is a note, not a record.",
        detail: {},
      };
    }
    const taken = new Map<string, LiveAwardScope>();
    for (const award of partialLive) {
      for (const id of award.scopeLevellingItemIds) taken.set(id, award);
    }
    const clashes = requested.filter((id) => taken.has(id));
    if (clashes.length > 0) {
      const named = clashes
        .slice(0, 10)
        .map((id) => {
          const item = byId.get(id);
          const holder = taken.get(id)!;
          return `${item?.itemCode ?? item?.description ?? id} (held by ${holder.reference})`;
        })
        .join("; ");
      return {
        ok: false,
        code: "scope_overlap",
        message:
          `${clashes.length} scope row(s) are already covered by a live award: ${named}. Awarding ` +
          "them again would commit the same work under two subcontracts — the project would pay " +
          `for it twice. (${LIVE_AWARD_STATUSES_NOTE}.)`,
        detail: {
          overlappingItemIds: clashes,
          heldBy: [...new Set(clashes.map((id) => taken.get(id)!.awardId))],
        },
      };
    }
  }

  const covered = new Set<string>(partial ? requested : items.map((i) => i.id));
  for (const award of partialLive) for (const id of award.scopeLevellingItemIds) covered.add(id);
  const orderedCovered = items.filter((i) => covered.has(i.id)).map((i) => i.id);
  const remaining = items.filter((i) => i.isMandatory && !covered.has(i.id));
  const complete = remaining.length === 0;

  return {
    ok: true,
    plan: {
      partial,
      scopeItemIds: partial ? items.filter((i) => requested.includes(i.id)).map((i) => i.id) : [],
      coveredItemIds: orderedCovered,
      remaining,
      packageStatusAfterApproval: complete ? "awarded" : "partially_awarded",
      note: !partial
        ? "This award covers the whole package."
        : complete
          ? `This award covers the last ${requested.length} of the package's mandatory scope ` +
            "rows; every row now has a winner and the package is fully awarded."
          : `This award covers ${requested.length} of ${items.length} scope row(s). ` +
            `${remaining.length} mandatory row(s) remain unawarded: ` +
            `${remaining.slice(0, 5).map((r) => r.itemCode ?? r.description).join(", ")}` +
            `${remaining.length > 5 ? ", …" : ""}. The package stays partially awarded until ` +
            "they are placed or the package is cancelled.",
    },
  };
}

export interface ScopedAmount {
  submissionId: string;
  amount: number | null;
  currency: string | null;
  /** rows this bidder has no levelled figure for — the reason `amount` is null */
  missing: Array<{ levellingItemId: string; why: string }>;
  reasons: string[];
}

/**
 * What one bidder's price is for a subset of the scope, on the levelled
 * basis. Null with reasons wherever a row has no levelled figure: an award
 * amount assembled by treating an unanswered row as zero is a number the
 * bidder never quoted and will not honour.
 */
export function scopedLevelledAmount(
  submissionId: string,
  itemIds: readonly string[],
  cells: readonly LevelledCell[],
  itemLabel: (id: string) => string,
): ScopedAmount {
  const mine = new Map(
    cells.filter((c) => c.submissionId === submissionId).map((c) => [c.levellingItemId, c] as const),
  );
  const missing: Array<{ levellingItemId: string; why: string }> = [];
  const currencies = new Set<string>();
  let total = 0;
  for (const id of itemIds) {
    const cell = mine.get(id);
    if (!cell) {
      missing.push({
        levellingItemId: id,
        why: `${itemLabel(id)}: this bidder has no levelling entry on that row at all.`,
      });
      continue;
    }
    if (cell.levelledAmount === null) {
      missing.push({
        levellingItemId: id,
        why:
          `${itemLabel(id)}: the levelling entry is "${cell.includedStatus}" and carries no ` +
          "levelled amount, so there is no figure to add.",
      });
      continue;
    }
    currencies.add(cell.currency);
    total += cell.levelledAmount;
  }
  if (missing.length > 0) {
    return {
      submissionId,
      amount: null,
      currency: currencies.size === 1 ? [...currencies][0]! : null,
      missing,
      reasons: [
        `${missing.length} of the ${itemIds.length} scope row(s) in this award carry no levelled ` +
          "amount for this bidder, so the award value cannot be summed.",
        ...missing.map((m) => m.why),
      ],
    };
  }
  if (currencies.size > 1) {
    return {
      submissionId,
      amount: null,
      currency: null,
      missing: [],
      reasons: [
        `The levelled rows in this award are priced in ${[...currencies].sort().join(" and ")}. ` +
          "Amounts in different currencies are never added together.",
      ],
    };
  }
  return {
    submissionId,
    amount: round2(total),
    currency: currencies.size === 1 ? [...currencies][0]! : null,
    missing: [],
    reasons: [],
  };
}

export interface ScopedCandidate {
  submissionId: string;
  reference: string;
  vendorId: string;
  amount: number | null;
  currency: string | null;
  reasons: string[];
  rank: number | null;
}

/**
 * The comparison a PARTIAL award rests on: every bid in contention priced on
 * the same subset of rows. A bidder who left one of those rows unpriced has
 * no comparable figure and is ranked nowhere — never last, and never zero.
 */
export function buildScopedComparison(
  submissions: readonly { id: string; reference: string; vendorId: string; status: string }[],
  itemIds: readonly string[],
  cells: readonly LevelledCell[],
  itemLabel: (id: string) => string,
  inContention: (status: string) => boolean,
): { candidates: ScopedCandidate[]; lowest: ScopedCandidate | null; currency: string | null } {
  const live = submissions.filter((s) => inContention(s.status));
  const priced = live.map((s) => {
    const scoped = scopedLevelledAmount(s.id, itemIds, cells, itemLabel);
    return {
      submissionId: s.id,
      reference: s.reference,
      vendorId: s.vendorId,
      amount: scoped.amount,
      currency: scoped.currency,
      reasons: scoped.reasons,
      rank: null as number | null,
    };
  });
  const comparable = priced.filter(
    (c): c is ScopedCandidate & { amount: number } => c.amount !== null,
  );
  const currencies = new Set(comparable.map((c) => c.currency).filter((c): c is string => !!c));
  if (currencies.size > 1) {
    return { candidates: priced, lowest: null, currency: null };
  }
  const sorted = [...comparable].sort((a, b) => a.amount - b.amount);
  sorted.forEach((c, i) => {
    c.rank = i + 1;
  });
  return {
    candidates: priced,
    lowest: sorted[0] ?? null,
    currency: currencies.size === 1 ? [...currencies][0]! : null,
  };
}
