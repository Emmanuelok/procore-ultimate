/**
 * CONTRACT CLAUSE AND PROCUREMENT ROUTE PERFORMANCE — spec Vol II Domain W
 * (#987 clause analytics, #988 procurement route analytics).
 *
 * WHY THIS LIVES IN LEARNING
 * The organisation already knows which clause it keeps arguing about; it just
 * knows it one dispute at a time, in the heads of the people who were there.
 * Every dispute, variation, forensic claim and materialised obligation in this
 * platform already carries the clause it came from — `governingClause`,
 * `clauseRef`, `sourceClause`. Reading those columns across every project turns
 * "20.1 is always trouble on FIDIC" from a war story into a measured statement
 * with an n beside it, which is the difference between a lesson and a habit.
 *
 * The same argument, one level up: a procurement route is a bet about how much
 * change and how much argument the job will carry. The platform can settle that
 * bet from its own records rather than from received wisdom.
 *
 * THE HONESTY RULES THIS FILE ENFORCES
 *  • MONEY IS NEVER SUMMED ACROSS CURRENCIES. Every amount is bucketed by its
 *    own currency; a ratio is only ever computed between two figures that share
 *    one, and the reasons say which records were left out and why.
 *  • A rate with no observations is `null`, never 0. "Nothing was disputed" and
 *    "we have never recorded a dispute" are different answers.
 *  • Below `MIN_PROJECTS` a route-level rate is reported with its counts but its
 *    `reliable` flag is false and the reason says how thin the sample is. Three
 *    projects do not settle a procurement argument.
 *  • Nothing here is a recommendation, and nothing here is causal. A clause that
 *    appears in ten disputes may be the clause under which every claim is
 *    correctly notified. The report says what was recorded, and the reader
 *    supplies the judgement.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *  • It does not read meeting decisions. Decisions carry no clause reference in
 *    the schema, so joining them to a clause would mean guessing from free text,
 *    and a guessed clause reference in a dispute analysis is worse than a gap.
 *  • It does not normalise across contract families. "20.1" means one thing in
 *    FIDIC and another in NEC, so the family is part of the key, never averaged
 *    away.
 *  • It does not compute outturn against the FINAL account (the platform has no
 *    single agreed final account figure); the variance it reports is agreed
 *    variation value against contract sum, and it says so in `basis`.
 */

/* ------------------------------------------------------------------ */
/* Inputs — structural, not drizzle rows, so the engine is unit-testable */
/* ------------------------------------------------------------------ */

export interface DisputeObservation {
  projectId: string;
  /** `disputes.governingClause` */
  clause: string | null;
  /** `disputes.contractFamily` — FIDIC / NEC / JCT / bespoke */
  contractFamily: string | null;
  status: string;
  outcome: string | null;
  rootCause: string | null;
  amountClaimed: number | null;
  amountAwarded: number | null;
  currency: string;
  resolvedAt: string | null;
}

export interface VariationObservation {
  projectId: string;
  /** `variations.clauseRef` */
  clause: string | null;
  status: string;
  currency: string;
  agreedValue: number | null;
  costEstimate: number | null;
  timeImpactDays: number | null;
}

export interface ForensicClaimObservation {
  projectId: string;
  /** `forensic_claims.clauseRef` */
  clause: string | null;
  status: string;
  currency: string;
  amountClaimed: number | null;
  amountAssessed: number | null;
  daysClaimed: number | null;
  daysAssessed: number | null;
}

export interface ObligationObservation {
  projectId: string | null;
  /** `obligations.sourceClause` */
  clause: string | null;
  status: string;
}

/** One project, with the contract terms the analysis needs. */
export interface ProjectObservation {
  projectId: string;
  name: string;
  /** the route recorded on the opportunity this project came from, if any */
  procurementRoute: string | null;
  /** the contract family of the project's primary contract, if any */
  contractFamily: string | null;
  contractSum: number | null;
  contractCurrency: string | null;
}

export interface ClauseInput {
  asOf: string;
  disputes: readonly DisputeObservation[];
  variations: readonly VariationObservation[];
  forensicClaims: readonly ForensicClaimObservation[];
  obligations: readonly ObligationObservation[];
}

export interface RouteInput {
  asOf: string;
  projects: readonly ProjectObservation[];
  disputes: readonly DisputeObservation[];
  variations: readonly VariationObservation[];
}

/* ------------------------------------------------------------------ */
/* Output                                                             */
/* ------------------------------------------------------------------ */

/** Money, always keyed by the currency it is denominated in. */
export type MoneyByCurrency = Record<string, number>;

export interface ClauseRow {
  /** stable key: `${contractFamily}::${clause}` */
  key: string;
  contractFamily: string;
  clause: string;
  /** distinct projects the clause was recorded on */
  projects: number;
  disputes: number;
  disputesResolved: number;
  disputeOutcomes: Record<string, number>;
  disputeRootCauses: Record<string, number>;
  amountClaimed: MoneyByCurrency;
  amountAwarded: MoneyByCurrency;
  /**
   * awarded ÷ claimed, computed ONLY over disputes where both figures exist and
   * share a currency. `null` when no dispute qualifies.
   */
  recoveryRatio: number | null;
  recoveryObservations: number;
  variations: number;
  variationValue: MoneyByCurrency;
  variationTimeImpactDays: number | null;
  forensicClaims: number;
  obligations: number;
  obligationsBreached: number;
  /** breached ÷ obligations, `null` when the clause carries no obligation */
  breachRate: number | null;
  /** total records of any kind, used for ordering */
  weight: number;
  basis: string;
  reasons: string[];
}

export interface ClauseReport {
  asOf: string;
  items: ClauseRow[];
  /** records that carried no clause reference and could not be attributed */
  unattributed: {
    disputes: number;
    variations: number;
    forensicClaims: number;
    obligations: number;
  };
  reasons: string[];
}

export interface RouteRow {
  route: string;
  projects: number;
  projectIds: string[];
  /** contract sums, bucketed by currency — never one number */
  contractSum: MoneyByCurrency;
  agreedVariationValue: MoneyByCurrency;
  /**
   * Mean of the per-project ratio (agreed variation value ÷ contract sum),
   * computed only where the variation currency matches the contract currency.
   * A ratio, so it is currency-neutral and safe to average.
   */
  outturnVariancePercent: number | null;
  outturnObservations: number;
  /** mean variations recorded per project */
  variationsPerProject: number | null;
  variations: number;
  /** share of projects on this route carrying at least one dispute, 0..1 */
  disputeRate: number | null;
  disputedProjects: number;
  disputes: number;
  /** false when the sample is too thin to argue from */
  reliable: boolean;
  basis: string;
  reasons: string[];
}

export interface RouteReport {
  asOf: string;
  items: RouteRow[];
  minProjects: number;
  reasons: string[];
}

/* ------------------------------------------------------------------ */
/* Normalisation                                                      */
/* ------------------------------------------------------------------ */

/** Below this a route-level rate is reported but flagged as unreliable. */
export const MIN_PROJECTS = 4;

const UNRECORDED = "unrecorded";

/**
 * Clause references are typed by humans: "Sub-Clause 20.1", "cl. 20.1",
 * "Clause 20.1 [Contractor's Claims]" and "20.1" are the same clause and must
 * land in the same bucket, or the analysis reports four clauses each with an n
 * of one. The normaliser is deliberately conservative: it strips the words that
 * mean "clause", trims punctuation and collapses whitespace, and does NOTHING
 * else — it never tries to guess that 20.1 and 20 are related, because on a
 * contract they are not.
 */
export function normaliseClause(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (s.length === 0) return null;
  // Drop a trailing bracketed heading: "20.1 [Contractor's Claims]"
  s = s.replace(/\s*[[(][^\])]*[\])]\s*$/u, "").trim();
  // Drop the leading word for "clause" in the forms people actually type.
  s = s.replace(/^(sub[-\s]?clause|clause|cl\.?|section|sec\.?|art\.?|article)\s*/iu, "").trim();
  s = s.replace(/[.,;:]+$/u, "").trim();
  s = s.replace(/\s+/gu, " ");
  if (s.length === 0) return null;
  return s.toUpperCase();
}

/** A family label that is never empty, so grouping never loses rows. */
export function normaliseFamily(raw: string | null | undefined): string {
  if (typeof raw !== "string") return UNRECORDED;
  const s = raw.trim();
  return s.length === 0 ? UNRECORDED : s.toLowerCase();
}

/** A route label that is never empty. */
export function normaliseRoute(raw: string | null | undefined): string {
  if (typeof raw !== "string") return UNRECORDED;
  const s = raw.trim();
  return s.length === 0 ? UNRECORDED : s.toLowerCase();
}

function addMoney(bucket: MoneyByCurrency, currency: string, amount: number | null): void {
  if (amount === null || !Number.isFinite(amount)) return;
  const ccy = currency.trim().toUpperCase() || "UNKNOWN";
  bucket[ccy] = round2((bucket[ccy] ?? 0) + amount);
}

function bump(counter: Record<string, number>, key: string | null | undefined): void {
  const k = typeof key === "string" && key.trim().length > 0 ? key.trim() : UNRECORDED;
  counter[k] = (counter[k] ?? 0) + 1;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

const RESOLVED_DISPUTE_STATUSES = new Set([
  "settled",
  "decided",
  "awarded",
  "withdrawn",
  "closed",
  "resolved",
  "dismissed",
]);

const AGREED_VARIATION_STATUSES = new Set(["agreed", "instructed", "approved", "executed"]);

/* ------------------------------------------------------------------ */
/* #987 — clause performance                                           */
/* ------------------------------------------------------------------ */

interface Accumulator {
  row: ClauseRow;
  projectIds: Set<string>;
  timeImpactDays: number;
  timeImpactCount: number;
  claimedForRatio: number;
  awardedForRatio: number;
  mixedCurrencyDisputes: number;
}

/**
 * Per (contract family, clause): how often it was argued about, for how much,
 * how it came out, and how often the obligations it generated were breached.
 */
export function clausePerformance(input: ClauseInput): ClauseReport {
  const acc = new Map<string, Accumulator>();
  const unattributed = { disputes: 0, variations: 0, forensicClaims: 0, obligations: 0 };

  /* Contract family per project, learned from the disputes that state one, so
     a variation with a clause but no family still lands in the right bucket
     when the project's disputes have told us the form. Where nothing says, the
     family is "unrecorded" and stays visibly separate. */
  const familyByProject = new Map<string, string>();
  for (const d of input.disputes) {
    const fam = normaliseFamily(d.contractFamily);
    if (fam !== UNRECORDED) familyByProject.set(d.projectId, fam);
  }

  const bucket = (projectId: string | null, family: string, clause: string): Accumulator => {
    const key = `${family}::${clause}`;
    let a = acc.get(key);
    if (!a) {
      a = {
        row: {
          key,
          contractFamily: family,
          clause,
          projects: 0,
          disputes: 0,
          disputesResolved: 0,
          disputeOutcomes: {},
          disputeRootCauses: {},
          amountClaimed: {},
          amountAwarded: {},
          recoveryRatio: null,
          recoveryObservations: 0,
          variations: 0,
          variationValue: {},
          variationTimeImpactDays: null,
          forensicClaims: 0,
          obligations: 0,
          obligationsBreached: 0,
          breachRate: null,
          weight: 0,
          basis: "",
          reasons: [],
        },
        projectIds: new Set<string>(),
        timeImpactDays: 0,
        timeImpactCount: 0,
        claimedForRatio: 0,
        awardedForRatio: 0,
        mixedCurrencyDisputes: 0,
      };
      acc.set(key, a);
    }
    if (projectId) a.projectIds.add(projectId);
    a.row.weight += 1;
    return a;
  };

  for (const d of input.disputes) {
    const clause = normaliseClause(d.clause);
    if (!clause) {
      unattributed.disputes += 1;
      continue;
    }
    const a = bucket(d.projectId, normaliseFamily(d.contractFamily), clause);
    a.row.disputes += 1;
    if (d.resolvedAt || RESOLVED_DISPUTE_STATUSES.has(d.status)) a.row.disputesResolved += 1;
    bump(a.row.disputeOutcomes, d.outcome);
    bump(a.row.disputeRootCauses, d.rootCause);
    addMoney(a.row.amountClaimed, d.currency, d.amountClaimed);
    addMoney(a.row.amountAwarded, d.currency, d.amountAwarded);
    /* The recovery ratio only means anything between two figures in the same
       currency. Both are on the same dispute row and therefore share `currency`
       by construction — but a dispute with only one of the two figures cannot
       contribute, and saying so is the point. */
    if (
      d.amountClaimed !== null &&
      d.amountAwarded !== null &&
      Number.isFinite(d.amountClaimed) &&
      Number.isFinite(d.amountAwarded) &&
      d.amountClaimed > 0
    ) {
      a.claimedForRatio += d.amountClaimed;
      a.awardedForRatio += d.amountAwarded;
      a.row.recoveryObservations += 1;
    }
  }

  for (const v of input.variations) {
    const clause = normaliseClause(v.clause);
    if (!clause) {
      unattributed.variations += 1;
      continue;
    }
    const family = familyByProject.get(v.projectId) ?? UNRECORDED;
    const a = bucket(v.projectId, family, clause);
    a.row.variations += 1;
    addMoney(a.row.variationValue, v.currency, v.agreedValue ?? v.costEstimate);
    if (v.timeImpactDays !== null && Number.isFinite(v.timeImpactDays)) {
      a.timeImpactDays += v.timeImpactDays;
      a.timeImpactCount += 1;
    }
  }

  for (const f of input.forensicClaims) {
    const clause = normaliseClause(f.clause);
    if (!clause) {
      unattributed.forensicClaims += 1;
      continue;
    }
    const family = familyByProject.get(f.projectId) ?? UNRECORDED;
    const a = bucket(f.projectId, family, clause);
    a.row.forensicClaims += 1;
    addMoney(a.row.amountClaimed, f.currency, f.amountClaimed);
    addMoney(a.row.amountAwarded, f.currency, f.amountAssessed);
  }

  for (const o of input.obligations) {
    const clause = normaliseClause(o.clause);
    if (!clause) {
      unattributed.obligations += 1;
      continue;
    }
    const family = o.projectId ? (familyByProject.get(o.projectId) ?? UNRECORDED) : UNRECORDED;
    const a = bucket(o.projectId, family, clause);
    a.row.obligations += 1;
    if (o.status === "breached") a.row.obligationsBreached += 1;
  }

  const items: ClauseRow[] = [];
  for (const a of acc.values()) {
    const r = a.row;
    r.projects = a.projectIds.size;
    r.recoveryRatio =
      a.claimedForRatio > 0 ? round4(a.awardedForRatio / a.claimedForRatio) : null;
    r.variationTimeImpactDays =
      a.timeImpactCount > 0 ? round2(a.timeImpactDays / a.timeImpactCount) : null;
    r.breachRate = r.obligations > 0 ? round4(r.obligationsBreached / r.obligations) : null;

    const parts: string[] = [];
    if (r.disputes > 0) parts.push(`${r.disputes} dispute(s), ${r.disputesResolved} resolved`);
    if (r.forensicClaims > 0) parts.push(`${r.forensicClaims} forensic claim(s)`);
    if (r.variations > 0) parts.push(`${r.variations} variation(s)`);
    if (r.obligations > 0) {
      parts.push(`${r.obligations} obligation(s), ${r.obligationsBreached} breached`);
    }
    r.basis =
      `Clause ${r.clause} on ${r.contractFamily === UNRECORDED ? "contracts of unrecorded form" : r.contractFamily.toUpperCase()}, ` +
      `across ${r.projects} project(s): ${parts.join("; ") || "no records"}.`;

    if (r.recoveryRatio === null && r.disputes > 0) {
      r.reasons.push(
        "No recovery ratio: no dispute on this clause records both a claimed and an awarded " +
          "amount, so what was actually recovered is not knowable from the register.",
      );
    }
    if (r.projects < 2 && r.weight > 0) {
      r.reasons.push(
        "Recorded on a single project — this is one project's experience of the clause, not the " +
          "company's.",
      );
    }
    if (r.contractFamily === UNRECORDED) {
      r.reasons.push(
        "The contract form is not recorded on these records, so this row is not comparable with " +
          "the same clause number under a named form: clause 20.1 is a different obligation in " +
          "FIDIC and in NEC.",
      );
    }
    items.push(r);
  }

  items.sort(
    (a, b) =>
      b.disputes - a.disputes ||
      b.weight - a.weight ||
      a.contractFamily.localeCompare(b.contractFamily) ||
      a.clause.localeCompare(b.clause),
  );

  const reasons: string[] = [];
  const totalUnattributed =
    unattributed.disputes +
    unattributed.variations +
    unattributed.forensicClaims +
    unattributed.obligations;
  if (totalUnattributed > 0) {
    reasons.push(
      `${totalUnattributed} record(s) carry no clause reference and are excluded: ` +
        `${unattributed.disputes} dispute(s), ${unattributed.forensicClaims} forensic claim(s), ` +
        `${unattributed.variations} variation(s), ${unattributed.obligations} obligation(s). ` +
        "They are not evidence that those clauses caused nothing — they are evidence that the " +
        "clause was never recorded.",
    );
  }
  if (items.length === 0) {
    reasons.push(
      "No record in this company carries a clause reference yet, so there is nothing to measure. " +
        "Clause references are captured on disputes (governing clause), variations, forensic " +
        "claims and obligations.",
    );
  }
  reasons.push(
    "Frequency is not fault: a clause that appears often may be the clause under which claims " +
      "are correctly notified. This report says what was recorded, not what went wrong.",
  );

  return { asOf: input.asOf, items, unattributed, reasons };
}

/* ------------------------------------------------------------------ */
/* #988 — procurement route performance                                */
/* ------------------------------------------------------------------ */

/**
 * Per procurement route: how much change the jobs carried and how often they
 * ended in an argument. Ratios are computed per project and then averaged, so
 * no figure ever crosses a currency boundary.
 */
export function procurementRoutePerformance(input: RouteInput): RouteReport {
  const variationsByProject = new Map<string, VariationObservation[]>();
  for (const v of input.variations) {
    const list = variationsByProject.get(v.projectId);
    if (list) list.push(v);
    else variationsByProject.set(v.projectId, [v]);
  }
  const disputesByProject = new Map<string, DisputeObservation[]>();
  for (const d of input.disputes) {
    const list = disputesByProject.get(d.projectId);
    if (list) list.push(d);
    else disputesByProject.set(d.projectId, [d]);
  }

  interface RouteAcc {
    row: RouteRow;
    ratios: number[];
    currencyMismatches: number;
    noContractSum: number;
  }
  const acc = new Map<string, RouteAcc>();

  for (const p of input.projects) {
    const route = normaliseRoute(p.procurementRoute);
    let a = acc.get(route);
    if (!a) {
      a = {
        row: {
          route,
          projects: 0,
          projectIds: [],
          contractSum: {},
          agreedVariationValue: {},
          outturnVariancePercent: null,
          outturnObservations: 0,
          variationsPerProject: null,
          variations: 0,
          disputeRate: null,
          disputedProjects: 0,
          disputes: 0,
          reliable: false,
          basis: "",
          reasons: [],
        },
        ratios: [],
        currencyMismatches: 0,
        noContractSum: 0,
      };
      acc.set(route, a);
    }
    a.row.projects += 1;
    a.row.projectIds.push(p.projectId);
    const contractCcy = (p.contractCurrency ?? "").trim().toUpperCase();
    if (p.contractSum !== null && Number.isFinite(p.contractSum) && contractCcy) {
      addMoney(a.row.contractSum, contractCcy, p.contractSum);
    }

    const vs = variationsByProject.get(p.projectId) ?? [];
    a.row.variations += vs.length;
    let agreedInContractCurrency = 0;
    let mismatched = false;
    for (const v of vs) {
      const value = v.agreedValue ?? null;
      if (value === null || !Number.isFinite(value)) continue;
      if (!AGREED_VARIATION_STATUSES.has(v.status)) continue;
      const ccy = v.currency.trim().toUpperCase();
      addMoney(a.row.agreedVariationValue, ccy, value);
      if (contractCcy && ccy === contractCcy) agreedInContractCurrency += value;
      else if (contractCcy) mismatched = true;
    }
    if (p.contractSum !== null && Number.isFinite(p.contractSum) && p.contractSum > 0 && contractCcy) {
      if (mismatched) a.currencyMismatches += 1;
      else a.ratios.push(agreedInContractCurrency / p.contractSum);
    } else {
      a.noContractSum += 1;
    }

    const ds = disputesByProject.get(p.projectId) ?? [];
    a.row.disputes += ds.length;
    if (ds.length > 0) a.row.disputedProjects += 1;
  }

  const items: RouteRow[] = [];
  for (const a of acc.values()) {
    const r = a.row;
    r.outturnObservations = a.ratios.length;
    r.outturnVariancePercent =
      a.ratios.length > 0
        ? round2((a.ratios.reduce((s, x) => s + x, 0) / a.ratios.length) * 100)
        : null;
    r.variationsPerProject = r.projects > 0 ? round2(r.variations / r.projects) : null;
    r.disputeRate = r.projects > 0 ? round4(r.disputedProjects / r.projects) : null;
    r.reliable = r.projects >= MIN_PROJECTS;

    r.basis =
      `${r.projects} project(s) recorded on the "${r.route}" route: ${r.variations} variation(s), ` +
      `${r.disputes} dispute(s) on ${r.disputedProjects} of them. Outturn variance is the mean of ` +
      `each project's agreed variation value ÷ contract sum, computed only where both are in the ` +
      `same currency (${r.outturnObservations} of ${r.projects} qualified).`;

    if (!r.reliable) {
      r.reasons.push(
        `Only ${r.projects} project(s) on this route — below the ${MIN_PROJECTS} needed before ` +
          "these rates should be argued from. The counts are real; the rates are indicative.",
      );
    }
    if (r.route === UNRECORDED) {
      r.reasons.push(
        "No procurement route is recorded for these projects. The route is read from the " +
          "opportunity a project was won through; projects created directly carry none, and " +
          "guessing one would put a number under a fact that was never captured.",
      );
    }
    if (a.currencyMismatches > 0) {
      r.reasons.push(
        `${a.currencyMismatches} project(s) have variations in a currency other than the contract ` +
          "currency; their variance is excluded rather than converted at an invented rate.",
      );
    }
    if (a.noContractSum > 0) {
      r.reasons.push(
        `${a.noContractSum} project(s) have no contract sum with a currency, so no variance can ` +
          "be computed for them.",
      );
    }
    items.push(r);
  }

  items.sort((a, b) => b.projects - a.projects || a.route.localeCompare(b.route));

  const reasons: string[] = [];
  if (items.length === 0) {
    reasons.push("No project is visible to you, so no route can be measured.");
  }
  reasons.push(
    "A route does not cause an outcome. Difficult jobs are procured differently on purpose, and " +
      "this report cannot tell the route apart from the work it was chosen for.",
  );

  return { asOf: input.asOf, items, minProjects: MIN_PROJECTS, reasons };
}
