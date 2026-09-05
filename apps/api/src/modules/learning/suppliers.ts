/**
 * CROSS-PROJECT SUPPLIER PERFORMANCE (spec Domain W #987-989).
 *
 * WHY THIS LIVES IN LEARNING
 * A vendor's record on one job is an anecdote. The same vendor's record across
 * eleven jobs is knowledge, and knowledge that crosses a project boundary is
 * exactly what this module exists to hold. The scorecard is therefore not a
 * procurement gadget bolted to the directory; it is the organisational memory
 * of how a supplier actually behaved, assembled from acts the platform already
 * recorded rather than from opinions collected at the end.
 *
 * THE THREE THINGS IT MEASURES, AND WHY THOSE
 *  • CERTIFICATE DISCIPLINE — did their insurance evidence stay in date without
 *    being chased. A supplier whose certificate lapses twice a year is telling
 *    you what their administration is like everywhere else.
 *  • COMMITMENT SLIPPAGE — meeting actions they owned: how many ran past their
 *    date, and how many were carried from one occurrence to the next. An action
 *    carried four times is not a scheduling problem.
 *  • QUALITY — non-conformances raised against them, and how many are still open.
 *
 * THE HONESTY RULES THIS FILE ENFORCES
 *  • A metric with no observations is `null`, never 0, and never contributes to
 *    the composite. "We never checked" and "they were perfect" are different
 *    answers and a scorecard that conflates them is worse than none.
 *  • The composite is `null` below `MIN_OBSERVATIONS`, and the reason says so.
 *    A vendor with one certificate does not get a 100% rating.
 *  • Every score carries the counts it came from, so a reader can disagree with
 *    the arithmetic rather than having to trust it.
 *  • Nothing here is a recommendation. It reports what happened; whether that
 *    disqualifies a supplier is a human judgement with a right of reply.
 */

/* ------------------------------------------------------------------ */
/* Inputs — deliberately structural, not drizzle rows                  */
/* ------------------------------------------------------------------ */

export interface CertificateObservation {
  vendorId: string;
  /** the day cover ends */
  validTo: string;
  verifiedAt: string | null;
  status: string;
}

export interface ActionObservation {
  ownerVendorId: string;
  status: string;
  dueDate: string | null;
  completedAt: string | null;
  carryCount: number;
}

export interface NcrObservation {
  raisedAgainstVendorId: string;
  status: string;
  severity: string;
}

export interface SupplierScoreInput {
  asOf: string;
  vendors: ReadonlyArray<{ id: string; name: string }>;
  certificates: readonly CertificateObservation[];
  actions: readonly ActionObservation[];
  ncrs: readonly NcrObservation[];
}

/* ------------------------------------------------------------------ */
/* Output                                                             */
/* ------------------------------------------------------------------ */

export interface Dimension {
  /** 0..100, or null when there is nothing to score */
  score: number | null;
  /** how many records the score is computed from */
  observations: number;
  /** the arithmetic, in words */
  basis: string;
  counts: Record<string, number>;
}

export interface SupplierScore {
  vendorId: string;
  vendorName: string;
  certificateDiscipline: Dimension;
  commitmentSlippage: Dimension;
  quality: Dimension;
  /** the weighted mean of the dimensions that HAVE a score, or null */
  composite: number | null;
  observations: number;
  reasons: string[];
}

/**
 * Below this many observations across all dimensions the composite is withheld.
 * Three is not a statistical threshold; it is the point below which a number
 * would be read as a judgement when it is only a coincidence.
 */
export const MIN_OBSERVATIONS = 3;

/** Certificate discipline is worth more than the others because it is the
 *  cheapest to get right, and therefore the most telling when it is not. */
const WEIGHTS = { certificateDiscipline: 0.4, commitmentSlippage: 0.35, quality: 0.25 };

const EMPTY = (basis: string): Dimension => ({
  score: null,
  observations: 0,
  basis,
  counts: {},
});

const pct = (good: number, total: number): number =>
  total === 0 ? 0 : Math.round((good / total) * 1000) / 10;

function certificateDimension(
  rows: readonly CertificateObservation[],
  asOf: string,
): Dimension {
  if (rows.length === 0) {
    return EMPTY(
      "No insurance certificate has ever been collected from this supplier, so their evidence discipline is unknown — not good.",
    );
  }
  const live = rows.filter((c) => c.status !== "superseded" && c.status !== "withdrawn");
  if (live.length === 0) {
    return EMPTY(
      "Every certificate on file has been superseded or withdrawn; nothing current is left to score.",
    );
  }
  const inDate = live.filter((c) => c.validTo >= asOf).length;
  const verified = live.filter((c) => c.verifiedAt !== null).length;
  /* In date is necessary; verified is what makes it evidence rather than a
     PDF somebody emailed. Both are counted, the second at half weight. */
  const score = Math.round((pct(inDate, live.length) * 2 + pct(verified, live.length)) / 3);
  return {
    score,
    observations: live.length,
    basis:
      `${inDate} of ${live.length} certificate(s) are in date as at ${asOf}, and ${verified} ` +
      "have been verified by somebody other than the supplier. Being in date counts twice as " +
      "much as being verified, because expired cover is a live exposure and unverified cover " +
      "is only an unchecked claim.",
    counts: { certificates: live.length, inDate, verified, expired: live.length - inDate },
  };
}

function slippageDimension(rows: readonly ActionObservation[], asOf: string): Dimension {
  if (rows.length === 0) {
    return EMPTY(
      "No meeting action has ever been owned by this supplier, so nothing about their delivery against dates can be said.",
    );
  }
  const overdue = rows.filter(
    (a) =>
      a.dueDate !== null &&
      a.dueDate < asOf &&
      a.status !== "completed" &&
      a.status !== "verified" &&
      a.status !== "cancelled",
  ).length;
  const lateClosed = rows.filter(
    (a) =>
      a.completedAt !== null &&
      a.dueDate !== null &&
      a.completedAt.slice(0, 10) > a.dueDate,
  ).length;
  const carried = rows.filter((a) => a.carryCount >= 2).length;
  const bad = overdue + lateClosed + carried;
  /* One action can be counted twice (carried AND late), which is deliberate:
     an item that was carried three times and then closed late is worse than
     one that was merely late. The score is clamped so it cannot go negative. */
  const score = Math.max(0, Math.round(pct(Math.max(0, rows.length - bad), rows.length)));
  return {
    score,
    observations: rows.length,
    basis:
      `Of ${rows.length} action(s) this supplier owned, ${overdue} are past their date and still ` +
      `open, ${lateClosed} were closed after their date, and ${carried} were carried between two ` +
      "or more meetings. An action carried repeatedly is an undecided question, not a scheduling problem.",
    counts: { actions: rows.length, overdue, lateClosed, carried },
  };
}

function qualityDimension(rows: readonly NcrObservation[]): Dimension {
  if (rows.length === 0) {
    return EMPTY(
      "No non-conformance has been raised against this supplier. That is an absence of records, not evidence of quality: it also happens on projects that do not raise NCRs at all.",
    );
  }
  const open = rows.filter((n) => n.status !== "closed" && n.status !== "verified").length;
  const major = rows.filter((n) => n.severity === "major" || n.severity === "critical").length;
  /* Every NCR costs 6 points, a major one 6 more, an unresolved one 4 more.
     The scale is arbitrary and stated so the reader can discount it. */
  const penalty = rows.length * 6 + major * 6 + open * 4;
  const score = Math.max(0, 100 - penalty);
  return {
    score,
    observations: rows.length,
    basis:
      `${rows.length} non-conformance(s) raised against this supplier, of which ${major} are ` +
      `major or critical and ${open} remain unresolved. The scale (6 points per NCR, 6 more if ` +
      "major, 4 more if still open) is a convention of this platform, not an industry standard.",
    counts: { ncrs: rows.length, open, major },
  };
}

/**
 * Score every vendor that appears anywhere in the observations, plus any
 * vendor explicitly asked for. A vendor with no observations at all is
 * returned with a null composite and a reason, because omitting them would
 * read as "nothing to report" when the truth is "nothing was recorded".
 */
export function scoreSuppliers(input: SupplierScoreInput): SupplierScore[] {
  const certsBy = new Map<string, CertificateObservation[]>();
  for (const c of input.certificates) {
    const list = certsBy.get(c.vendorId) ?? [];
    list.push(c);
    certsBy.set(c.vendorId, list);
  }
  const actionsBy = new Map<string, ActionObservation[]>();
  for (const a of input.actions) {
    const list = actionsBy.get(a.ownerVendorId) ?? [];
    list.push(a);
    actionsBy.set(a.ownerVendorId, list);
  }
  const ncrsBy = new Map<string, NcrObservation[]>();
  for (const n of input.ncrs) {
    const list = ncrsBy.get(n.raisedAgainstVendorId) ?? [];
    list.push(n);
    ncrsBy.set(n.raisedAgainstVendorId, list);
  }

  const out: SupplierScore[] = [];
  for (const vendor of input.vendors) {
    const certificateDiscipline = certificateDimension(
      certsBy.get(vendor.id) ?? [],
      input.asOf,
    );
    const commitmentSlippage = slippageDimension(actionsBy.get(vendor.id) ?? [], input.asOf);
    const quality = qualityDimension(ncrsBy.get(vendor.id) ?? []);
    const dims = [
      ["certificateDiscipline", certificateDiscipline] as const,
      ["commitmentSlippage", commitmentSlippage] as const,
      ["quality", quality] as const,
    ];
    const observations = dims.reduce((n, [, d]) => n + d.observations, 0);
    const reasons: string[] = [];

    let composite: number | null = null;
    if (observations < MIN_OBSERVATIONS) {
      reasons.push(
        `Only ${observations} observation(s) exist for this supplier — fewer than the ${MIN_OBSERVATIONS} ` +
          "this platform requires before it will publish a composite. A rating built on one " +
          "certificate is a coincidence wearing a number.",
      );
    } else {
      let weighted = 0;
      let weight = 0;
      for (const [key, dim] of dims) {
        if (dim.score === null) continue;
        weighted += dim.score * WEIGHTS[key];
        weight += WEIGHTS[key];
      }
      if (weight === 0) {
        reasons.push(
          "No dimension could be scored, so no composite is offered even though records exist.",
        );
      } else {
        composite = Math.round(weighted / weight);
        const missing = dims.filter(([, d]) => d.score === null).map(([k]) => k);
        if (missing.length > 0) {
          reasons.push(
            `The composite is the weighted mean of the dimensions that could be scored; ` +
              `${missing.join(" and ")} had nothing to score and were left out rather than counted as zero.`,
          );
        }
      }
    }
    if (certificateDiscipline.counts["expired"] ?? 0) {
      reasons.push(
        `${certificateDiscipline.counts["expired"]} certificate(s) on file have expired — that is a live exposure, not a filing error.`,
      );
    }
    if ((commitmentSlippage.counts["carried"] ?? 0) > 0) {
      reasons.push(
        `${commitmentSlippage.counts["carried"]} action(s) were carried between meetings rather than closed.`,
      );
    }
    reasons.push(
      "This is a record of what happened, not a recommendation. Nothing here disqualifies a supplier; that judgement is a human one and the supplier is entitled to answer it.",
    );

    out.push({
      vendorId: vendor.id,
      vendorName: vendor.name,
      certificateDiscipline,
      commitmentSlippage,
      quality,
      composite,
      observations,
      reasons,
    });
  }

  /* Worst first: a scorecard sorted best-first is read as a leaderboard, and
     the useful end of this list is the other one. Vendors with no composite
     sort last — an unknown is not a good score. */
  return out.sort((a, b) => {
    if (a.composite === null && b.composite === null) return b.observations - a.observations;
    if (a.composite === null) return 1;
    if (b.composite === null) return -1;
    return a.composite - b.composite;
  });
}
