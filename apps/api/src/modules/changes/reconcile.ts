import {
  checkIdentity,
  computed,
  nearlyEqual,
  ratio,
  round2,
  round4,
  unavailable,
  type Component,
  type Identity,
} from "./arithmetic.js";

/**
 * THE CHANGE LOG, AS ARITHMETIC.
 *
 * A change log is the one report an owner's auditor reads line by line, and
 * the one report contractors habitually render as a pretty list of statuses
 * that adds up to nothing in particular. Everything here is derived from rows
 * and every headline figure is paired with an identity that says which rows it
 * came from, so "approved changes" on this screen and "approved change sum" on
 * the prime contract are provably the same number or the mismatch is named.
 *
 * CURRENCY. Nothing in here sums across currencies. Rows arrive tagged, the
 * caller groups by currency, and a project holding two currencies gets two
 * reconciliations rather than one meaningless one.
 */

export interface EventRow {
  id: string;
  status: string;
  eventType: string;
  scope: string;
  roughOrderOfMagnitude: number;
  estimatedCost: number;
  latestCost: number;
  estimatedRevenue: number;
  approvedRevenue: number;
  scheduleImpactDays: number;
}

export interface PcoRow {
  id: string;
  changeEventId: string | null;
  commitmentId: string | null;
  changeOrderPackageId: string | null;
  status: string;
  estimatedAmount: number;
  quotedAmount: number;
  amount: number;
  noCharge: number;
}

export interface CorRow {
  id: string;
  changeEventId: string | null;
  primeContractId: string;
  changeOrderPackageId: string | null;
  status: string;
  amount: number;
  approvedAmount: number;
  scheduleImpactDays: number;
  scheduleImpactApprovedDays: number;
  pcoIds: string[];
}

export interface PackageRow {
  id: string;
  kind: string;
  status: string;
  changeEventId: string | null;
  primeContractId: string | null;
  commitmentId: string | null;
  memberIds: string[];
  amount: number;
  scheduleImpactDays: number;
  primeContractChangeId: string | null;
  commitmentChangeId: string | null;
  budgetChangeId: string | null;
}

export interface ContractSumRow {
  id: string;
  reference: string;
  currency: string;
  originalContractSum: number;
  approvedChangeSum: number;
  pendingChangeSum: number;
  revisedContractSum: number;
}

export interface ExecutedChangeRow {
  /** prime_contract_changes.id or commitment_changes.id */
  id: string;
  parentId: string;
  changeOrderPackageId: string | null;
  status: string;
  amount: number;
}

/* ------------------------------------------------------------------ */
/* Status vocabularies                                                 */
/* ------------------------------------------------------------------ */

/** A COR the owner has answered, one way or the other. */
export const DECIDED_COR_STATUSES = ["approved", "partially_approved", "rejected"] as const;
/** A COR carrying a number the owner has agreed to. */
export const APPROVED_COR_STATUSES = ["approved", "partially_approved"] as const;
/** A COR that has been put to the owner and is still live. */
export const LIVE_COR_STATUSES = ["submitted", "under_review", "negotiating"] as const;
/** PCO statuses carrying a priced position. */
export const PRICED_PCO_STATUSES = ["priced", "submitted", "approved"] as const;
/** Statuses that will never become money. */
export const DEAD_STATUSES = ["rejected", "void", "withdrawn", "no_charge"] as const;

const has = (list: readonly string[], value: string): boolean => list.includes(value);
export const isApprovedCor = (s: string): boolean => has(APPROVED_COR_STATUSES, s);
export const isDecidedCor = (s: string): boolean => has(DECIDED_COR_STATUSES, s);
export const isLiveCor = (s: string): boolean => has(LIVE_COR_STATUSES, s);
export const isPricedPco = (s: string): boolean => has(PRICED_PCO_STATUSES, s);
export const isDead = (s: string): boolean => has(DEAD_STATUSES, s);

export function countBy<T>(rows: readonly T[], key: (row: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const k = key(row);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

const sum = <T>(rows: readonly T[], value: (row: T) => number): number =>
  round2(rows.reduce((s, r) => s + value(r), 0));

/* ------------------------------------------------------------------ */
/* The funnel                                                          */
/* ------------------------------------------------------------------ */

export interface FunnelStage {
  stage: string;
  /** how many change events have reached this stage */
  events: number;
  /** the money at this stage, in the reconciliation's single currency */
  amount: number;
  description: string;
}

/**
 * Where the project's exposure actually is. Each stage counts EVENTS, not
 * documents, because "we have 40 change orders" answers a different question
 * from "we have 12 unresolved changes worth 800k".
 */
export function buildFunnel(
  events: readonly EventRow[],
  pcos: readonly PcoRow[],
  cors: readonly CorRow[],
  packages: readonly PackageRow[],
): FunnelStage[] {
  const livePcosByEvent = new Map<string, PcoRow[]>();
  for (const p of pcos) {
    if (!p.changeEventId || isDead(p.status)) continue;
    const list = livePcosByEvent.get(p.changeEventId) ?? [];
    list.push(p);
    livePcosByEvent.set(p.changeEventId, list);
  }
  const corsByEvent = new Map<string, CorRow[]>();
  for (const c of cors) {
    if (!c.changeEventId) continue;
    const list = corsByEvent.get(c.changeEventId) ?? [];
    list.push(c);
    corsByEvent.set(c.changeEventId, list);
  }
  const executedPrime = packages.filter((p) => p.kind === "prime_contract" && p.status === "executed");
  const executedEvents = new Set(executedPrime.map((p) => p.changeEventId).filter((x): x is string => !!x));

  const identified = events.filter((e) => e.status !== "void");
  const priced = identified.filter((e) => (livePcosByEvent.get(e.id) ?? []).some((p) => isPricedPco(p.status)));
  const submitted = identified.filter((e) =>
    (corsByEvent.get(e.id) ?? []).some((c) => isLiveCor(c.status) || isDecidedCor(c.status)),
  );
  const approved = identified.filter((e) => (corsByEvent.get(e.id) ?? []).some((c) => isApprovedCor(c.status)));

  return [
    {
      stage: "identified",
      events: identified.length,
      amount: sum(identified, (e) => e.roughOrderOfMagnitude),
      description: "Change events raised and not voided, valued at rough order of magnitude.",
    },
    {
      stage: "priced",
      events: priced.length,
      amount: sum(
        priced.flatMap((e) => (livePcosByEvent.get(e.id) ?? []).filter((p) => isPricedPco(p.status))),
        (p) => p.amount,
      ),
      description: "Events carrying at least one priced PCO, valued at the position taken forward.",
    },
    {
      stage: "submitted",
      events: submitted.length,
      amount: sum(
        submitted.flatMap((e) => (corsByEvent.get(e.id) ?? []).filter((c) => isLiveCor(c.status) || isDecidedCor(c.status))),
        (c) => c.amount,
      ),
      description: "Events put to the owner on a COR, valued at what was asked for.",
    },
    {
      stage: "approved",
      events: approved.length,
      amount: sum(
        approved.flatMap((e) => (corsByEvent.get(e.id) ?? []).filter((c) => isApprovedCor(c.status))),
        (c) => c.approvedAmount,
      ),
      description: "Events the owner has agreed a number on, valued at what was granted.",
    },
    {
      stage: "executed",
      events: executedEvents.size,
      amount: sum(executedPrime, (p) => p.amount),
      description: "Events inside an executed prime change order — money now in the contract sum.",
    },
  ];
}

/* ------------------------------------------------------------------ */
/* The reconciliation                                                  */
/* ------------------------------------------------------------------ */

export interface ChangeLogInput {
  currency: string;
  events: readonly EventRow[];
  pcos: readonly PcoRow[];
  cors: readonly CorRow[];
  packages: readonly PackageRow[];
  contracts: readonly ContractSumRow[];
  primeChanges: readonly ExecutedChangeRow[];
  commitmentChanges: readonly ExecutedChangeRow[];
}

export interface ContractMovement {
  primeContractId: string;
  reference: string;
  originalContractSum: number;
  approvedChangeSum: number;
  pendingChangeSum: number;
  revisedContractSum: number;
  /** Σ executed packages against this contract */
  executedPackageTotal: number;
  /** Σ executed prime_contract_changes rows against this contract */
  executedChangeTotal: number;
  identities: Identity[];
  ok: boolean;
}

export interface EventMargin {
  changeEventId: string;
  /** executed revenue: prime packages carrying this event */
  revenue: number;
  /** executed cost: commitment packages carrying this event */
  cost: number;
  margin: number;
  marginPercent: Component;
}

export interface ChangeLogReconciliation {
  currency: string;
  events: {
    total: number;
    byStatus: Record<string, number>;
    byType: Record<string, number>;
    byScope: Record<string, number>;
    roughOrderOfMagnitudeTotal: number;
    estimatedCostTotal: number;
    latestCostTotal: number;
    openScheduleImpactDays: number;
  };
  pcos: {
    total: number;
    byStatus: Record<string, number>;
    estimatedTotal: number;
    quotedTotal: number;
    positionTotal: number;
    noChargeCount: number;
    /** quoted − our estimate, over PCOs holding both */
    quoteVarianceAgainstEstimate: Component;
  };
  cors: {
    total: number;
    byStatus: Record<string, number>;
    requestedTotal: number;
    approvedTotal: number;
    rejectedTotal: number;
    /** what was asked minus what was granted, over DECIDED CORs only */
    negotiationGap: number;
    approvalRatePercent: Component;
    daysClaimed: number;
    daysApproved: number;
  };
  packages: {
    total: number;
    byStatus: Record<string, number>;
    byKind: Record<string, number>;
    executedPrimeTotal: number;
    executedCommitmentTotal: number;
  };
  contractMovement: ContractMovement[];
  /** executed revenue vs executed cost, per change event */
  margins: EventMargin[];
  /** executed prime revenue that no COR attributed to a change event */
  unattributedExecutedRevenue: number;
  marginTotal: { revenue: number; cost: number; margin: number; marginPercent: Component };
  funnel: FunnelStage[];
  identities: Identity[];
  ok: boolean;
}

export function reconcileChangeLog(input: ChangeLogInput): ChangeLogReconciliation {
  const { events, pcos, cors, packages, contracts, primeChanges, commitmentChanges } = input;

  const liveEvents = events.filter((e) => e.status !== "void");
  const openEvents = events.filter((e) => e.status === "open" || e.status === "pending");

  const withBoth = pcos.filter((p) => p.quotedAmount !== 0 && p.estimatedAmount !== 0);
  const quoteVariance =
    withBoth.length === 0
      ? unavailable(
          ["No PCO carries both our estimate and a subcontractor quote — nothing to compare."],
          { pcosWithBoth: 0 },
        )
      : computed(
          sum(withBoth, (p) => p.quotedAmount - p.estimatedAmount),
          { pcosWithBoth: withBoth.length },
        );

  const decided = cors.filter((c) => isDecidedCor(c.status));
  const approvedCors = cors.filter((c) => isApprovedCor(c.status));
  const rejectedCors = cors.filter((c) => c.status === "rejected");
  const requestedTotal = sum(
    cors.filter((c) => !has(["draft", "void", "withdrawn"], c.status)),
    (c) => c.amount,
  );
  const approvedTotal = sum(approvedCors, (c) => c.approvedAmount);
  const decidedAsked = sum(decided, (c) => c.amount);
  const decidedGranted = sum(decided, (c) => c.approvedAmount);

  const executedPrimePackages = packages.filter(
    (p) => p.kind === "prime_contract" && p.status === "executed",
  );
  const executedCommitmentPackages = packages.filter(
    (p) => p.kind === "commitment" && p.status === "executed",
  );
  const executedPrimeTotal = sum(executedPrimePackages, (p) => p.amount);
  const executedCommitmentTotal = sum(executedCommitmentPackages, (p) => p.amount);

  const executedPrimeChanges = primeChanges.filter((c) => c.status === "executed");
  const executedCommitmentChanges = commitmentChanges.filter((c) => c.status === "executed");

  const contractMovement: ContractMovement[] = contracts.map((contract) => {
    const pkgs = executedPrimePackages.filter((p) => p.primeContractId === contract.id);
    const chgs = executedPrimeChanges.filter((c) => c.parentId === contract.id);
    const executedPackageTotal = sum(pkgs, (p) => p.amount);
    const executedChangeTotal = sum(chgs, (c) => c.amount);
    const identities = [
      checkIdentity(
        "originalContractSum + approvedChangeSum = revisedContractSum",
        contract.originalContractSum + contract.approvedChangeSum,
        contract.revisedContractSum,
      ),
      checkIdentity(
        "Σ executed prime contract changes = approvedChangeSum",
        executedChangeTotal,
        contract.approvedChangeSum,
      ),
      checkIdentity(
        "Σ executed change order packages = Σ executed prime contract changes",
        executedPackageTotal,
        executedChangeTotal,
      ),
    ];
    return {
      primeContractId: contract.id,
      reference: contract.reference,
      originalContractSum: round2(contract.originalContractSum),
      approvedChangeSum: round2(contract.approvedChangeSum),
      pendingChangeSum: round2(contract.pendingChangeSum),
      revisedContractSum: round2(contract.revisedContractSum),
      executedPackageTotal,
      executedChangeTotal,
      identities,
      ok: identities.every((i) => i.ok),
    };
  });

  /*
   * Margin is attributed through the MEMBERS of an executed package, never
   * through the package's own changeEventId: one PCCO routinely bundles CORs
   * from several change events, and attributing the whole package to whichever
   * event the package row happens to name would put another event's revenue on
   * this one's margin. What cannot be attributed is disclosed rather than
   * spread.
   */
  const executedPrimeIds = new Set(executedPrimePackages.map((p) => p.id));
  const executedCommitmentIds = new Set(executedCommitmentPackages.map((p) => p.id));
  const executedCors = cors.filter(
    (c) => c.changeOrderPackageId !== null && executedPrimeIds.has(c.changeOrderPackageId),
  );
  const executedPcos = pcos.filter(
    (p) => p.changeOrderPackageId !== null && executedCommitmentIds.has(p.changeOrderPackageId),
  );

  const marginByEvent = new Map<string, { revenue: number; cost: number }>();
  for (const c of executedCors) {
    if (!c.changeEventId) continue;
    const entry = marginByEvent.get(c.changeEventId) ?? { revenue: 0, cost: 0 };
    entry.revenue += c.approvedAmount;
    marginByEvent.set(c.changeEventId, entry);
  }
  for (const p of executedPcos) {
    if (!p.changeEventId) continue;
    const entry = marginByEvent.get(p.changeEventId) ?? { revenue: 0, cost: 0 };
    entry.cost += p.amount;
    marginByEvent.set(p.changeEventId, entry);
  }
  const attributedRevenue = sum(
    executedCors.filter((c) => c.changeEventId !== null),
    (c) => c.approvedAmount,
  );
  const unattributedRevenue = round2(executedPrimeTotal - attributedRevenue);
  const margins: EventMargin[] = [...marginByEvent.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([changeEventId, v]) => ({
      changeEventId,
      revenue: round2(v.revenue),
      cost: round2(v.cost),
      margin: round2(v.revenue - v.cost),
      marginPercent: ratio(v.revenue - v.cost, v.revenue, "Change margin"),
    }));
  const marginRevenue = round2(margins.reduce((s, m) => s + m.revenue, 0));
  const marginCost = round2(margins.reduce((s, m) => s + m.cost, 0));

  const eventApprovedRevenue = sum(events, (e) => e.approvedRevenue);
  const executedCorApproved = sum(
    executedPrimePackages.flatMap((p) => cors.filter((c) => p.memberIds.includes(c.id))),
    (c) => c.approvedAmount,
  );

  const identities: Identity[] = [
    checkIdentity(
      "Σ executed prime packages = Σ approvedAmount of the CORs inside them",
      executedPrimeTotal,
      executedCorApproved,
    ),
    checkIdentity(
      "Σ executed prime packages = Σ executed prime contract changes",
      executedPrimeTotal,
      sum(executedPrimeChanges, (c) => c.amount),
    ),
    checkIdentity(
      "Σ executed commitment packages = Σ executed commitment changes",
      executedCommitmentTotal,
      sum(executedCommitmentChanges, (c) => c.amount),
    ),
    checkIdentity(
      "Σ change event approvedRevenue + revenue not attributable to an event = Σ executed prime packages",
      eventApprovedRevenue + unattributedRevenue,
      executedPrimeTotal,
    ),
    checkIdentity(
      "Σ COR requested − Σ COR approved (decided only) = negotiation gap",
      decidedAsked - decidedGranted,
      round2(decidedAsked - decidedGranted),
    ),
  ];

  return {
    currency: input.currency,
    events: {
      total: events.length,
      byStatus: countBy(events, (e) => e.status),
      byType: countBy(events, (e) => e.eventType),
      byScope: countBy(events, (e) => e.scope),
      roughOrderOfMagnitudeTotal: sum(liveEvents, (e) => e.roughOrderOfMagnitude),
      estimatedCostTotal: sum(liveEvents, (e) => e.estimatedCost),
      latestCostTotal: sum(liveEvents, (e) => e.latestCost),
      openScheduleImpactDays: openEvents.reduce((s, e) => s + e.scheduleImpactDays, 0),
    },
    pcos: {
      total: pcos.length,
      byStatus: countBy(pcos, (p) => p.status),
      estimatedTotal: sum(pcos, (p) => p.estimatedAmount),
      quotedTotal: sum(pcos, (p) => p.quotedAmount),
      positionTotal: sum(
        pcos.filter((p) => !isDead(p.status)),
        (p) => p.amount,
      ),
      noChargeCount: pcos.filter((p) => p.noCharge === 1).length,
      quoteVarianceAgainstEstimate: quoteVariance,
    },
    cors: {
      total: cors.length,
      byStatus: countBy(cors, (c) => c.status),
      requestedTotal,
      approvedTotal,
      rejectedTotal: sum(rejectedCors, (c) => c.amount),
      negotiationGap: round2(decidedAsked - decidedGranted),
      approvalRatePercent:
        decided.length === 0
          ? unavailable(["No COR has been decided yet — an approval rate over nothing is not 0%."], {
              decidedCors: 0,
            })
          : ratio(decidedGranted, decidedAsked, "COR approval rate"),
      daysClaimed: cors.reduce((s, c) => s + c.scheduleImpactDays, 0),
      daysApproved: approvedCors.reduce((s, c) => s + c.scheduleImpactApprovedDays, 0),
    },
    packages: {
      total: packages.length,
      byStatus: countBy(packages, (p) => p.status),
      byKind: countBy(packages, (p) => p.kind),
      executedPrimeTotal,
      executedCommitmentTotal,
    },
    contractMovement,
    margins,
    unattributedExecutedRevenue: unattributedRevenue,
    marginTotal: {
      revenue: marginRevenue,
      cost: marginCost,
      margin: round2(marginRevenue - marginCost),
      marginPercent: ratio(marginRevenue - marginCost, marginRevenue, "Portfolio change margin"),
    },
    funnel: buildFunnel(events, pcos, cors, packages),
    identities,
    ok: identities.every((i) => i.ok) && contractMovement.every((c) => c.ok),
  };
}

/* ------------------------------------------------------------------ */
/* Time impact                                                         */
/* ------------------------------------------------------------------ */

export interface DelayEventRow {
  id: string;
  number: number;
  title: string;
  cause: string;
  excusable: number;
  compensable: number;
  status: string;
  startDate: string;
  durationDays: number;
  /** the TIA result the forensics module computed, when one exists */
  completionDeltaDays: number | null;
}

export interface CorTimeImpact {
  changeOrderRequestId: string;
  reference: string;
  title: string;
  status: string;
  daysClaimed: number;
  daysApproved: number;
  delayEventIds: string[];
  linkedDelayEvents: DelayEventRow[];
  /** Σ of the linked events' modelled completion delta; null when unmodelled */
  modelledDays: Component;
  /** claimed − modelled; null when nothing was modelled */
  unsupportedDays: Component;
  /** the assurance finding, in one sentence */
  verdict: string;
}

/**
 * Time claimed against time modelled. A COR claiming 14 days with no delay
 * event behind it is not a schedule position, it is an assertion — and this is
 * the report that says so before the owner's programmer does.
 *
 * The forensics module already owns delay events and the TIA that quantifies
 * them (`delay_events.tia_result.completionDeltaDays`). Nothing is recomputed
 * here: the days come from there, and a COR merely points at them.
 */
export function assessCorTimeImpact(
  cor: {
    id: string;
    reference: string;
    title: string;
    status: string;
    scheduleImpactDays: number;
    scheduleImpactApprovedDays: number;
  },
  delayEventIds: readonly string[],
  linked: readonly DelayEventRow[],
): CorTimeImpact {
  const modelledRows = linked.filter((d) => d.completionDeltaDays !== null);
  const modelled =
    linked.length === 0
      ? unavailable(
          [
            "No delay event is linked to this change order request — the days claimed rest on " +
              "nothing the schedule can be asked about.",
          ],
          { delayEvents: 0 },
        )
      : modelledRows.length === 0
        ? unavailable(
            [
              `${linked.length} delay event(s) are linked but none has been run through a time ` +
                "impact analysis — link them, then run the TIA in forensics.",
            ],
            { delayEvents: linked.length, analysed: 0 },
          )
        : computed(
            modelledRows.reduce((s, d) => s + (d.completionDeltaDays ?? 0), 0),
            { delayEvents: linked.length, analysed: modelledRows.length },
            round4,
          );

  const unsupported =
    modelled.value === null
      ? unavailable(modelled.reasons, modelled.inputs)
      : computed(cor.scheduleImpactDays - modelled.value, {
          claimed: cor.scheduleImpactDays,
          modelled: modelled.value,
        }, round4);

  let verdict: string;
  if (cor.scheduleImpactDays === 0 && linked.length === 0) {
    verdict = "No time claimed and no delay event linked — nothing to substantiate.";
  } else if (linked.length === 0) {
    verdict =
      `${cor.scheduleImpactDays} day(s) claimed with no delay event linked. Raise the delay ` +
      "event in forensics and link it, or withdraw the time claim.";
  } else if (modelled.value === null) {
    verdict =
      `${cor.scheduleImpactDays} day(s) claimed against ${linked.length} unanalysed delay ` +
      "event(s). Run the time impact analysis before the owner does.";
  } else if (nearlyEqual(unsupported.value ?? 0, 0, 0.5)) {
    verdict = `${cor.scheduleImpactDays} day(s) claimed and ${modelled.value} day(s) modelled — substantiated.`;
  } else if ((unsupported.value ?? 0) > 0) {
    verdict =
      `${cor.scheduleImpactDays} day(s) claimed but only ${modelled.value} day(s) modelled — ` +
      `${round4(unsupported.value ?? 0)} day(s) unsupported.`;
  } else {
    verdict =
      `${cor.scheduleImpactDays} day(s) claimed against ${modelled.value} day(s) modelled — the ` +
      "claim understates the modelled impact.";
  }

  return {
    changeOrderRequestId: cor.id,
    reference: cor.reference,
    title: cor.title,
    status: cor.status,
    daysClaimed: cor.scheduleImpactDays,
    daysApproved: cor.scheduleImpactApprovedDays,
    delayEventIds: [...delayEventIds],
    linkedDelayEvents: [...linked],
    modelledDays: modelled,
    unsupportedDays: unsupported,
    verdict,
  };
}
