/**
 * PRIME CONTRACT ANALYTICS — pure functions behind the owner change order
 * register (#508–#512), receivables ageing and payment receipts (#518), the
 * compliance gate (#519), stored materials (#516), retainage release
 * proposals (#517) and the AIA G702/G703 export (#514).
 *
 * Nothing here touches the database or the clock: every function takes
 * `today` as an argument so the ageing an auditor re-performs is the ageing
 * the platform printed.
 */
import { formatMoney, nearlyEqual, round2, round4, type Component, type Identity } from "./sov.js";

/* ------------------------------------------------------------------ */
/* Change order register analytics                                     */
/* ------------------------------------------------------------------ */

export interface ChangeForAnalytics {
  id: string;
  reference: string;
  status: string;
  amount: number;
  reason: string | null;
  createdAt: string;
  submittedAt: string | null;
  approvedAt: string | null;
  executedDate: string | null;
  requestedDate: string | null;
  scheduleImpactDays: number;
}

export interface ChangeAnalytics {
  byStatus: Array<{ status: string; count: number; amount: number }>;
  byReason: Array<{ reason: string; count: number; amount: number }>;
  executed: { count: number; amount: number; /** Σ executed ÷ original sum */ shareOfOriginal: number | null; scheduleImpactDays: number };
  pending: { count: number; amount: number; oldestDays: number | null; averageAgeDays: number | null };
  /** mean calendar days between lifecycle stamps, over the changes that have both */
  cycleTimeDays: { createdToSubmitted: number | null; submittedToApproved: number | null; approvedToExecuted: number | null; createdToExecuted: number | null; samples: number };
  /** executed value by month of execution, oldest first */
  monthly: Array<{ month: string; count: number; amount: number; cumulative: number }>;
  reasons: string[];
}

const DAY = 86_400_000;
const ms = (d: string | null): number | null => {
  if (!d) return null;
  const v = Date.parse(d.length === 10 ? `${d}T00:00:00Z` : d);
  return Number.isFinite(v) ? v : null;
};
const daysBetween = (a: string | null, b: string | null): number | null => {
  const x = ms(a);
  const y = ms(b);
  return x === null || y === null ? null : round4((y - x) / DAY);
};
const mean = (xs: number[]): number | null => (xs.length === 0 ? null : round4(xs.reduce((s, v) => s + v, 0) / xs.length));

const PENDING = ["pending_pricing", "pending_in_house_review", "pending_owner_approval", "revise_and_resubmit", "approved"];

export function changeOrderAnalytics(changes: readonly ChangeForAnalytics[], originalContractSum: number, today: string): ChangeAnalytics {
  const byStatus = new Map<string, { count: number; amount: number }>();
  const byReason = new Map<string, { count: number; amount: number }>();
  for (const c of changes) {
    const s = byStatus.get(c.status) ?? { count: 0, amount: 0 };
    s.count += 1;
    s.amount = round2(s.amount + c.amount);
    byStatus.set(c.status, s);
    const key = c.reason ?? "unstated";
    const r = byReason.get(key) ?? { count: 0, amount: 0 };
    r.count += 1;
    r.amount = round2(r.amount + c.amount);
    byReason.set(key, r);
  }
  const executed = changes.filter((c) => c.status === "executed");
  const pending = changes.filter((c) => PENDING.includes(c.status));
  const executedAmount = round2(executed.reduce((s, c) => s + c.amount, 0));
  const ages = pending.map((c) => daysBetween(c.submittedAt ?? c.createdAt, today)).filter((d): d is number => d !== null);
  const cs = changes.map((c) => daysBetween(c.createdAt, c.submittedAt)).filter((d): d is number => d !== null && d >= 0);
  const sa = changes.map((c) => daysBetween(c.submittedAt, c.approvedAt)).filter((d): d is number => d !== null && d >= 0);
  const ae = executed.map((c) => daysBetween(c.approvedAt, c.executedDate)).filter((d): d is number => d !== null && d >= 0);
  const ce = executed.map((c) => daysBetween(c.createdAt, c.executedDate)).filter((d): d is number => d !== null && d >= 0);
  const monthly = new Map<string, { count: number; amount: number }>();
  for (const c of executed) {
    const key = (c.executedDate ?? c.approvedAt ?? c.createdAt).slice(0, 7);
    const m = monthly.get(key) ?? { count: 0, amount: 0 };
    m.count += 1;
    m.amount = round2(m.amount + c.amount);
    monthly.set(key, m);
  }
  let cumulative = 0;
  const reasons: string[] = [];
  if (changes.length === 0) reasons.push("No change orders have been raised against this contract.");
  if (originalContractSum <= 0) reasons.push("The contract has no original sum, so the executed share cannot be stated.");
  return {
    byStatus: [...byStatus.entries()].map(([status, v]) => ({ status, ...v })).sort((a, b) => a.status.localeCompare(b.status)),
    byReason: [...byReason.entries()].map(([reason, v]) => ({ reason, ...v })).sort((a, b) => b.amount - a.amount),
    executed: { count: executed.length, amount: executedAmount, shareOfOriginal: originalContractSum > 0 ? round4(executedAmount / originalContractSum) : null, scheduleImpactDays: executed.reduce((s, c) => s + c.scheduleImpactDays, 0) },
    pending: { count: pending.length, amount: round2(pending.reduce((s, c) => s + c.amount, 0)), oldestDays: ages.length === 0 ? null : Math.max(...ages), averageAgeDays: mean(ages) },
    cycleTimeDays: { createdToSubmitted: mean(cs), submittedToApproved: mean(sa), approvedToExecuted: mean(ae), createdToExecuted: mean(ce), samples: changes.length },
    monthly: [...monthly.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, v]) => {
      cumulative = round2(cumulative + v.amount);
      return { month, ...v, cumulative };
    }),
    reasons,
  };
}

/* ------------------------------------------------------------------ */
/* Receipts, settlement, ageing                                        */
/* ------------------------------------------------------------------ */

export interface ReceiptLike {
  paymentApplicationId: string;
  status: string;
  amount: number;
  receivedDate: string;
}

export interface ApplicationLike {
  id: string;
  reference: string;
  status: string;
  currency: string;
  currentPaymentDue: number;
  certifiedAmount: number | null;
  certifiedAt: string | null;
  applicationDate: string | null;
}

export type SettlementState = "unpaid" | "partially_paid" | "paid";

export interface Settlement {
  certified: number;
  paid: number;
  outstanding: number;
  state: SettlementState;
  receipts: number;
  lastReceivedDate: string | null;
}

/** Σ non-void receipts against an application's certified amount. */
export function settlementOf(app: ApplicationLike, receipts: readonly ReceiptLike[]): Settlement {
  const mine = receipts.filter((r) => r.paymentApplicationId === app.id && r.status !== "void");
  const paid = round2(mine.reduce((s, r) => s + r.amount, 0));
  const certified = round2(app.certifiedAmount ?? app.currentPaymentDue);
  const outstanding = round2(Math.max(0, certified - paid));
  const state: SettlementState = paid <= 0.005 ? "unpaid" : outstanding <= 0.005 ? "paid" : "partially_paid";
  return { certified, paid, outstanding, state, receipts: mine.length, lastReceivedDate: mine.map((r) => r.receivedDate).sort().pop() ?? null };
}

export interface AgedReceivable {
  applicationId: string;
  reference: string;
  certifiedAt: string | null;
  dueDate: string | null;
  certified: number;
  paid: number;
  outstanding: number;
  state: SettlementState;
  daysOutstanding: number | null;
  daysOverdue: number | null;
  bucket: "current" | "1-30" | "31-60" | "61-90" | "90+" | "unknown";
}

export interface ReceivablesAging {
  currency: string;
  paymentTermsDays: number | null;
  items: AgedReceivable[];
  totals: { certified: number; paid: number; outstanding: number; overdue: number };
  buckets: Array<{ bucket: AgedReceivable["bucket"]; amount: number; count: number }>;
  /** applications overdue, most overdue first — the dunning list */
  dunning: AgedReceivable[];
  reasons: string[];
}

const addDays = (iso: string, days: number): string => new Date(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/**
 * Age every certified application: outstanding = certified − receipts; due
 * = certification date + payment terms (when the contract records terms);
 * overdue = today past due. Without terms, days outstanding is still shown
 * but nothing is called overdue — an overdue flag without a term behind it
 * would be a claim about the contract, not the record.
 */
export function receivablesAging(apps: readonly ApplicationLike[], receipts: readonly ReceiptLike[], paymentTermsDays: number | null, today: string, currency: string): ReceivablesAging {
  const items: AgedReceivable[] = [];
  const reasons: string[] = [];
  if (paymentTermsDays === null) reasons.push("The contract records no payment terms, so due dates and overdue days cannot be stated — days outstanding are shown from certification.");
  for (const app of apps) {
    if (!["certified", "partially_certified", "paid"].includes(app.status)) continue;
    const s = settlementOf(app, receipts);
    const certifiedAt = app.certifiedAt ? app.certifiedAt.slice(0, 10) : null;
    const dueDate = certifiedAt && paymentTermsDays !== null ? addDays(certifiedAt, paymentTermsDays) : null;
    const daysOutstanding = s.outstanding > 0.005 && certifiedAt ? Math.max(0, Math.floor(((ms(today) ?? 0) - (ms(certifiedAt) ?? 0)) / DAY)) : null;
    const daysOverdue = s.outstanding > 0.005 && dueDate ? Math.floor(((ms(today) ?? 0) - (ms(dueDate) ?? 0)) / DAY) : null;
    const bucket: AgedReceivable["bucket"] =
      s.outstanding <= 0.005 ? "current" : daysOverdue === null ? "unknown" : daysOverdue <= 0 ? "current" : daysOverdue <= 30 ? "1-30" : daysOverdue <= 60 ? "31-60" : daysOverdue <= 90 ? "61-90" : "90+";
    items.push({ applicationId: app.id, reference: app.reference, certifiedAt, dueDate, certified: s.certified, paid: s.paid, outstanding: s.outstanding, state: s.state, daysOutstanding, daysOverdue, bucket });
  }
  const buckets = new Map<AgedReceivable["bucket"], { amount: number; count: number }>();
  for (const i of items) {
    if (i.outstanding <= 0.005) continue;
    const b = buckets.get(i.bucket) ?? { amount: 0, count: 0 };
    b.amount = round2(b.amount + i.outstanding);
    b.count += 1;
    buckets.set(i.bucket, b);
  }
  const order: AgedReceivable["bucket"][] = ["current", "1-30", "31-60", "61-90", "90+", "unknown"];
  const overdueItems = items.filter((i) => i.daysOverdue !== null && i.daysOverdue > 0 && i.outstanding > 0.005).sort((a, b) => (b.daysOverdue ?? 0) - (a.daysOverdue ?? 0));
  return {
    currency,
    paymentTermsDays,
    items: items.sort((a, b) => (b.certifiedAt ?? "").localeCompare(a.certifiedAt ?? "")),
    totals: { certified: round2(items.reduce((s, i) => s + i.certified, 0)), paid: round2(items.reduce((s, i) => s + i.paid, 0)), outstanding: round2(items.reduce((s, i) => s + i.outstanding, 0)), overdue: round2(overdueItems.reduce((s, i) => s + i.outstanding, 0)) },
    buckets: order.map((bucket) => ({ bucket, amount: buckets.get(bucket)?.amount ?? 0, count: buckets.get(bucket)?.count ?? 0 })),
    dunning: overdueItems,
    reasons,
  };
}

/* ------------------------------------------------------------------ */
/* Compliance gate                                                     */
/* ------------------------------------------------------------------ */

export interface ComplianceDocLike {
  id: string;
  kind: string;
  title: string;
  required: number;
  status: string;
  expiryDate: string | null;
}

export interface ComplianceGate {
  ok: boolean;
  /** required documents that block: missing, expired, or expiring before `today` */
  blocking: Array<{ id: string; kind: string; title: string; status: string; problem: string }>;
  expiringSoon: Array<{ id: string; kind: string; title: string; expiryDate: string; daysLeft: number }>;
  summary: { required: number; satisfied: number; missing: number; expired: number; waived: number; optional: number };
}

/** A required document satisfies the gate only when received/verified and unexpired. */
export function complianceGate(docs: readonly ComplianceDocLike[], today: string, warnDays = 30): ComplianceGate {
  const blocking: ComplianceGate["blocking"] = [];
  const expiringSoon: ComplianceGate["expiringSoon"] = [];
  let satisfied = 0;
  let missing = 0;
  let expired = 0;
  let waived = 0;
  let optional = 0;
  let required = 0;
  for (const d of docs) {
    const isExpired = d.expiryDate !== null && d.expiryDate < today;
    if (d.required !== 1) {
      optional += 1;
      continue;
    }
    required += 1;
    if (d.status === "waived") {
      waived += 1;
      satisfied += 1;
      continue;
    }
    if (d.status === "missing") {
      missing += 1;
      blocking.push({ id: d.id, kind: d.kind, title: d.title, status: d.status, problem: `${d.title} has not been received.` });
      continue;
    }
    if (d.status === "expired" || isExpired) {
      expired += 1;
      blocking.push({ id: d.id, kind: d.kind, title: d.title, status: isExpired ? "expired" : d.status, problem: `${d.title} expired on ${d.expiryDate ?? "an unrecorded date"}.` });
      continue;
    }
    satisfied += 1;
    if (d.expiryDate) {
      const left = Math.floor(((ms(d.expiryDate) ?? 0) - (ms(today) ?? 0)) / DAY);
      if (left >= 0 && left <= warnDays) expiringSoon.push({ id: d.id, kind: d.kind, title: d.title, expiryDate: d.expiryDate, daysLeft: left });
    }
  }
  return { ok: blocking.length === 0, blocking, expiringSoon, summary: { required, satisfied, missing, expired, waived, optional } };
}

/* ------------------------------------------------------------------ */
/* Stored materials                                                    */
/* ------------------------------------------------------------------ */

export interface StoredItemLike {
  id: string;
  sovLineId: string;
  status: string;
  value: number;
  incorporatedValue: number;
  insured: number;
  supplierInvoiceReference: string | null;
}

export interface StoredLineLike {
  id: string;
  lineNumber: string;
  materialsPresentlyStored: number;
}

export interface StoredMaterialsReconciliation {
  lines: Array<{ sovLineId: string; lineNumber: string; registerValue: number; billedValue: number; identity: Identity; items: number; uninsured: number; unevidenced: number }>;
  totals: { registerValue: number; billedValue: number; identity: Identity };
  reasons: string[];
}

/** Σ open register value per line must equal what column F claims for it. */
export function storedMaterialsReconciliation(items: readonly StoredItemLike[], lines: readonly StoredLineLike[]): StoredMaterialsReconciliation {
  const open = items.filter((i) => i.status === "stored" || i.status === "partially_incorporated");
  const byLine = new Map<string, StoredItemLike[]>();
  for (const i of open) {
    const list = byLine.get(i.sovLineId) ?? [];
    list.push(i);
    byLine.set(i.sovLineId, list);
  }
  const out = lines
    .filter((l) => byLine.has(l.id) || l.materialsPresentlyStored > 0.005)
    .map((l) => {
      const mine = byLine.get(l.id) ?? [];
      const registerValue = round2(mine.reduce((s, i) => s + (i.value - i.incorporatedValue), 0));
      return {
        sovLineId: l.id,
        lineNumber: l.lineNumber,
        registerValue,
        billedValue: round2(l.materialsPresentlyStored),
        identity: { identity: `Σ stored register on line ${l.lineNumber} = column F`, left: registerValue, right: round2(l.materialsPresentlyStored), delta: round2(registerValue - l.materialsPresentlyStored), ok: nearlyEqual(registerValue, l.materialsPresentlyStored) },
        items: mine.length,
        uninsured: mine.filter((i) => i.insured !== 1).length,
        unevidenced: mine.filter((i) => !i.supplierInvoiceReference).length,
      };
    });
  const registerValue = round2(out.reduce((s, l) => s + l.registerValue, 0));
  const billedValue = round2(out.reduce((s, l) => s + l.billedValue, 0));
  const reasons: string[] = [];
  const uninsured = out.reduce((s, l) => s + l.uninsured, 0);
  const unevidenced = out.reduce((s, l) => s + l.unevidenced, 0);
  if (uninsured > 0) reasons.push(`${uninsured} stored item(s) carry no insurance — an owner is entitled to refuse column F on uninsured material.`);
  if (unevidenced > 0) reasons.push(`${unevidenced} stored item(s) carry no supplier invoice or bill of sale supporting their value.`);
  return { lines: out, totals: { registerValue, billedValue, identity: { identity: "Σ stored register = Σ G703 column F", left: registerValue, right: billedValue, delta: round2(registerValue - billedValue), ok: nearlyEqual(registerValue, billedValue) } }, reasons };
}

/* ------------------------------------------------------------------ */
/* Retainage release proposal                                          */
/* ------------------------------------------------------------------ */

export interface ReleaseProposalInput {
  retainageHeld: number;
  retainageReleased: number;
  percentComplete: number | null;
  substantialCompletionDate: string | null;
  actualCompletionDate: string | null;
  terms: { workPercent: number; reductionThresholdPercent: number | null; reducedPercent: number | null };
  pendingReleases: number;
  openApplications: number;
  /** commitments still holding a lien-waiver requirement without a verified waiver */
  outstandingLienWaivers: number;
  complianceOk: boolean;
  today: string;
}

export interface ReleaseProposal {
  kind: "none" | "step_down" | "final";
  amount: Component;
  gate: { ok: boolean; reasons: string[] };
  rationale: string;
}

export function finalReleaseProposal(i: ReleaseProposalInput): ReleaseProposal {
  const reasons: string[] = [];
  if (i.pendingReleases > 0) reasons.push(`${i.pendingReleases} retainage release(s) are already in flight — resolve them before proposing another.`);
  if (i.openApplications > 0) reasons.push(`${i.openApplications} application(s) for payment are still open; a release is proposed on a clean billing position.`);
  if (i.outstandingLienWaivers > 0) reasons.push(`${i.outstandingLienWaivers} commitment(s) still require a lien waiver that has not been verified — the final release is gated on downstream waivers.`);
  if (!i.complianceOk) reasons.push("A required compliance document is missing or expired.");
  const complete = i.actualCompletionDate !== null || (i.substantialCompletionDate !== null && i.substantialCompletionDate <= i.today);
  if (i.retainageHeld <= 0.005) {
    return { kind: "none", amount: { value: null, inputs: { retainageHeld: i.retainageHeld }, reasons: ["No retainage is held on this contract."] }, gate: { ok: false, reasons: ["Nothing to release."] }, rationale: "Nothing is held." };
  }
  if (complete) {
    return {
      kind: "final",
      amount: { value: round2(i.retainageHeld), inputs: { retainageHeld: i.retainageHeld, substantialCompletionDate: i.substantialCompletionDate, actualCompletionDate: i.actualCompletionDate }, reasons: [] },
      gate: { ok: reasons.length === 0, reasons },
      rationale: `Substantial completion is recorded${i.substantialCompletionDate ? ` (${i.substantialCompletionDate})` : ""}; the contract's full held balance of ${formatMoney(i.retainageHeld)} is proposed for final release, subject to the gate.`,
    };
  }
  const threshold = i.terms.reductionThresholdPercent;
  const reduced = i.terms.reducedPercent;
  if (threshold !== null && reduced !== null && i.percentComplete !== null && i.percentComplete >= threshold - 1e-9 && i.terms.workPercent > reduced) {
    // held at the original rate; stepping down releases the difference
    const heldAtReduced = round2((i.retainageHeld / i.terms.workPercent) * reduced);
    const release = round2(i.retainageHeld - heldAtReduced);
    return {
      kind: "step_down",
      amount: { value: release, inputs: { retainageHeld: i.retainageHeld, workPercent: i.terms.workPercent, reducedPercent: reduced, percentComplete: i.percentComplete, threshold }, reasons: [] },
      gate: { ok: reasons.length === 0, reasons },
      rationale: `The work is ${round4(i.percentComplete)}% complete, past the ${threshold}% step-down threshold; reducing the rate from ${i.terms.workPercent}% to ${reduced}% on the held balance releases ${formatMoney(release)}.`,
    };
  }
  return { kind: "none", amount: { value: null, inputs: { percentComplete: i.percentComplete, threshold, substantialCompletionDate: i.substantialCompletionDate }, reasons: ["Neither substantial completion nor the step-down threshold has been reached."] }, gate: { ok: false, reasons: ["No contractual trigger for a release has occurred."] }, rationale: "No release is due under the recorded terms." };
}

/* ------------------------------------------------------------------ */
/* AIA G702 / G703 export                                              */
/* ------------------------------------------------------------------ */

export interface AiaExportInput {
  contract: { reference: string; title: string; currency: string; ownerName: string | null; contractorName: string | null; architectName: string | null; contractDate: string | null; executionDate: string | null };
  application: { reference: string; number: number; applicationDate: string | null; periodTo: string | null; status: string; certifiedAmount: number | null; certifiedAt: string | null; certifiedByContractorName: string | null; contractorCertifiedAt: string | null; notaryReference: string | null };
  g702: { originalContractSum: number; netChangeOrders: number; contractSumToDate: number; completedToDate: number; storedMaterials: number; totalCompletedAndStored: number; retainagePercentWork: number; retainageWork: number; retainagePercentMaterials: number; retainageMaterials: number; totalRetainage: number; totalEarnedLessRetainage: number; lessPreviousCertificates: number; currentPaymentDue: number; balanceToFinishPlusRetainage: number };
  g703: ReadonlyArray<{ lineNumber: string; description: string; scheduledValue: number; previousBilled: number; thisPeriodWork: number; materialsPresentlyStored: number; totalCompletedAndStored: number; percentComplete: number; balanceToFinish: number; retainageHeldToDate: number }>;
  changes: ReadonlyArray<{ reference: string; amount: number; executedDate: string | null }>;
}

export interface AiaExport {
  form: "AIA G702/G703 (data)";
  g702: Record<string, string | number | null>;
  changeOrderSummary: { additions: number; deductions: number; net: number; rows: Array<{ reference: string; additions: number; deductions: number; executedDate: string | null }> };
  g703: Array<Record<string, string | number>>;
  g703Totals: Record<string, number>;
}

/** The two forms as data, with the printed field names of the AIA documents. */
export function aiaExport(i: AiaExportInput): AiaExport {
  const g = i.g702;
  const additions = round2(i.changes.filter((c) => c.amount > 0).reduce((s, c) => s + c.amount, 0));
  const deductions = round2(i.changes.filter((c) => c.amount < 0).reduce((s, c) => s - c.amount, 0));
  const g702: Record<string, string | number | null> = {
    "TO OWNER": i.contract.ownerName,
    "FROM CONTRACTOR": i.contract.contractorName,
    "VIA ARCHITECT": i.contract.architectName,
    PROJECT: i.contract.title,
    "CONTRACT FOR": i.contract.reference,
    "CONTRACT DATE": i.contract.contractDate ?? i.contract.executionDate,
    "APPLICATION NO": i.application.number,
    "APPLICATION REF": i.application.reference,
    "APPLICATION DATE": i.application.applicationDate,
    "PERIOD TO": i.application.periodTo,
    CURRENCY: i.contract.currency,
    "1. ORIGINAL CONTRACT SUM": g.originalContractSum,
    "2. NET CHANGE BY CHANGE ORDERS": g.netChangeOrders,
    "3. CONTRACT SUM TO DATE": g.contractSumToDate,
    "4. TOTAL COMPLETED & STORED TO DATE": g.totalCompletedAndStored,
    "5a. RETAINAGE % OF COMPLETED WORK": g.retainagePercentWork,
    "5a. RETAINAGE ON COMPLETED WORK": g.retainageWork,
    "5b. RETAINAGE % OF STORED MATERIAL": g.retainagePercentMaterials,
    "5b. RETAINAGE ON STORED MATERIAL": g.retainageMaterials,
    "5. TOTAL RETAINAGE": g.totalRetainage,
    "6. TOTAL EARNED LESS RETAINAGE": g.totalEarnedLessRetainage,
    "7. LESS PREVIOUS CERTIFICATES FOR PAYMENT": g.lessPreviousCertificates,
    "8. CURRENT PAYMENT DUE": g.currentPaymentDue,
    "9. BALANCE TO FINISH, INCLUDING RETAINAGE": g.balanceToFinishPlusRetainage,
    "CONTRACTOR CERTIFIED BY": i.application.certifiedByContractorName,
    "CONTRACTOR CERTIFIED AT": i.application.contractorCertifiedAt,
    "NOTARY REFERENCE": i.application.notaryReference,
    "AMOUNT CERTIFIED": i.application.certifiedAmount,
    "CERTIFIED AT": i.application.certifiedAt,
    STATUS: i.application.status,
  };
  const g703 = i.g703.map((r) => ({
    "A. ITEM NO": r.lineNumber,
    "B. DESCRIPTION OF WORK": r.description,
    "C. SCHEDULED VALUE": r.scheduledValue,
    "D. FROM PREVIOUS APPLICATION": r.previousBilled,
    "E. THIS PERIOD": r.thisPeriodWork,
    "F. MATERIALS PRESENTLY STORED": r.materialsPresentlyStored,
    "G. TOTAL COMPLETED AND STORED TO DATE": r.totalCompletedAndStored,
    "G/C %": r.percentComplete,
    "H. BALANCE TO FINISH": r.balanceToFinish,
    "I. RETAINAGE": r.retainageHeldToDate,
  }));
  const sum = (k: keyof (typeof i.g703)[number]): number => round2(i.g703.reduce((s, r) => s + (r[k] as number), 0));
  return {
    form: "AIA G702/G703 (data)",
    g702,
    changeOrderSummary: { additions, deductions, net: round2(additions - deductions), rows: i.changes.map((c) => ({ reference: c.reference, additions: c.amount > 0 ? c.amount : 0, deductions: c.amount < 0 ? -c.amount : 0, executedDate: c.executedDate })) },
    g703,
    g703Totals: { "C. SCHEDULED VALUE": sum("scheduledValue"), "D. FROM PREVIOUS APPLICATION": sum("previousBilled"), "E. THIS PERIOD": sum("thisPeriodWork"), "F. MATERIALS PRESENTLY STORED": sum("materialsPresentlyStored"), "G. TOTAL COMPLETED AND STORED TO DATE": sum("totalCompletedAndStored"), "H. BALANCE TO FINISH": sum("balanceToFinish"), "I. RETAINAGE": sum("retainageHeldToDate") },
  };
}

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The export as one CSV: G702 as key/value rows, a blank line, then the G703 sheet. */
export function aiaCsv(e: AiaExport): string {
  const lines: string[] = ["AIA G702 — APPLICATION AND CERTIFICATE FOR PAYMENT"];
  for (const [k, v] of Object.entries(e.g702)) lines.push(`${csvCell(k)},${csvCell(v)}`);
  lines.push("", "CHANGE ORDER SUMMARY,ADDITIONS,DEDUCTIONS");
  for (const r of e.changeOrderSummary.rows) lines.push(`${csvCell(r.reference)},${r.additions},${r.deductions}`);
  lines.push(`NET CHANGES BY CHANGE ORDER,${e.changeOrderSummary.additions},${e.changeOrderSummary.deductions}`);
  lines.push("", "AIA G703 — CONTINUATION SHEET");
  const headers = e.g703[0] ? Object.keys(e.g703[0]) : Object.keys(e.g703Totals);
  lines.push(headers.map(csvCell).join(","));
  for (const row of e.g703) lines.push(headers.map((h) => csvCell(row[h])).join(","));
  lines.push(headers.map((h) => (h in e.g703Totals ? String(e.g703Totals[h]) : h === "A. ITEM NO" ? "TOTALS" : "")).join(","));
  return lines.join("\n");
}
