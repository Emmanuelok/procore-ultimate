/**
 * The PRIME CONTRACT wire contract, transcribed from
 * `apps/api/src/modules/primecontracts/{index,sov}.ts` — not guessed.
 *
 * Two "we do not know" shapes travel on this spine and both are preserved:
 *
 *   Component  { value: number | null, inputs, reasons }  — a figure the
 *              platform either holds the inputs for or does not. `percentComplete`
 *              against a zero scheduled value is `null` with a reason, never 0.
 *   Identity   { identity, left, right, delta, ok } — an arithmetic claim with
 *              both of its sides, so a failure can name the discrepancy.
 */

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** `sov.ts::Component` — never a fabricated 0. */
export interface Component {
  value: number | null;
  inputs: Record<string, unknown>;
  reasons: string[];
}

/** `sov.ts::Identity` — an arithmetic claim with both sides on the record. */
export interface Identity {
  identity: string;
  left: number;
  right: number;
  delta: number;
  ok: boolean;
}

export type PrimeContractStatus =
  | "draft"
  | "out_for_bid"
  | "out_for_signature"
  | "approved"
  | "complete"
  | "terminated"
  | "void";

export type ChangeStatus =
  | "draft"
  | "pending_pricing"
  | "pending_in_house_review"
  | "pending_owner_approval"
  | "revise_and_resubmit"
  | "approved"
  | "executed"
  | "rejected"
  | "no_charge"
  | "void";

export type ApplicationStatus =
  | "draft"
  | "submitted"
  | "certified"
  | "partially_certified"
  | "rejected"
  | "paid"
  | "void";

/* ------------------------------------------------------------------ */
/* The contract                                                        */
/* ------------------------------------------------------------------ */

export interface PrimeContract {
  id: string;
  companyId: string;
  projectId: string;
  number: number;
  reference: string;
  title: string;
  description: string | null;
  scopeOfWork: string | null;
  ownerVendorId: string | null;
  ownerContactId: string | null;
  contractorVendorId: string | null;
  architectVendorId: string | null;
  contractId: string | null;
  pricingType: string;
  status: PrimeContractStatus;
  executed: number;
  currency: string;
  originalContractSum: number;
  approvedChangeSum: number;
  pendingChangeSum: number;
  draftChangeSum: number;
  revisedContractSum: number;
  totalBilled: number;
  totalPaid: number;
  defaultRetainagePercent: number;
  retainageHeld: number;
  retainageReleased: number;
  balanceToFinish: number;
  totalsCalculatedAt: string | null;
  contractDate: string | null;
  startDate: string | null;
  substantialCompletionDate: string | null;
  actualCompletionDate: string | null;
  signedContractReceivedDate: string | null;
  executionDate: string | null;
  terminationDate: string | null;
  paymentTermsDays: number | null;
  inclusions: string | null;
  exclusions: string | null;
  documentIds: string[];
  createdBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  executedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `sov.ts::RetainageTerms` — the clause reduced to the numbers that bite. */
export interface RetainageTerms {
  workPercent: number;
  materialsPercent: number;
  /** contract percent complete at which the rate steps down; null = never */
  reductionThresholdPercent: number | null;
  reducedPercent: number | null;
}

export interface SovTotals {
  lineCount: number;
  scheduledValue: number;
  changeOrderValue: number;
  revisedScheduledValue: number;
  baseScope: number;
  changeOrderScope: number;
}

export interface SovIdentityCheck {
  ok: boolean;
  currency: string;
  totals: SovTotals;
  sovTotal: number;
  contractSum: number;
  /** sovTotal − contractSum: positive = the SOV over-states the contract */
  discrepancy: number;
  direction: "balanced" | "over" | "under";
  legs: Identity[];
  /** one sentence naming the discrepancy — the API's own words */
  message: string;
}

/** `contractView()` — the shape every contract read returns. */
export interface ContractView extends PrimeContract {
  retainageTerms: RetainageTerms;
  sov: { totals: SovTotals; identity: SovIdentityCheck };
  percentComplete: Component;
  /** this-period work on an open (uncertified) application — outside totalBilled */
  draftBilled: number;
  identities: Identity[];
  reconciled: boolean;
}

export interface ContractSummaryGroup {
  currency: string;
  contractCount: number;
  executedCount: number;
  originalContractSum: number;
  approvedChangeSum: number;
  pendingChangeSum: number;
  revisedContractSum: number;
  totalBilled: number;
  totalPaid: number;
  retainageHeld: number;
  balanceToFinish: number;
  percentComplete: Component;
}

export interface ContractSummary {
  groups: ContractSummaryGroup[];
  combinedRevisedContractSum: Component;
}

/* ------------------------------------------------------------------ */
/* Schedule of values                                                  */
/* ------------------------------------------------------------------ */

export interface PrimeSovLine {
  id: string;
  primeContractId: string;
  lineNumber: string;
  sortOrder: number;
  costCodeId: string | null;
  costCode: string | null;
  costType: string | null;
  budgetLineItemId: string | null;
  description: string;
  billingMethod: string;
  unit: string | null;
  quantity: number | null;
  unitRate: number | null;
  scheduledValue: number;
  changeOrderValue: number;
  revisedScheduledValue: number;
  previousBilled: number;
  previousStoredMaterials: number;
  thisPeriodWork: number;
  thisPeriodStoredMaterials: number;
  materialsPresentlyStored: number;
  totalCompletedAndStored: number;
  balanceToFinish: number;
  retainagePercent: number;
  retainageHeld: number;
  retainageReleased: number;
  isChangeOrderLine: number;
  changeOrderPackageId: string | null;
  notes: string | null;
}

/** `GET /prime-contracts/:id/sov` decorates each line with a Component. */
export interface SovViewLine extends PrimeSovLine {
  percentComplete: Component;
}

export interface SovView {
  primeContractId: string;
  reference: string;
  currency: string;
  retainageTerms: RetainageTerms;
  totals: SovTotals;
  identity: SovIdentityCheck;
  lines: SovViewLine[];
}

/* ------------------------------------------------------------------ */
/* Change orders                                                       */
/* ------------------------------------------------------------------ */

export interface PrimeChangeLine {
  sovLineId: string | null;
  costCode: string | null;
  costType: string | null;
  description: string;
  amount: number;
}

export interface PrimeChange {
  id: string;
  primeContractId: string;
  number: number;
  reference: string;
  changeOrderPackageId: string | null;
  title: string;
  description: string | null;
  reason: string | null;
  status: ChangeStatus;
  amount: number;
  scheduleImpactDays: number;
  lines: PrimeChangeLine[];
  /** contract sum after this change lands — the running total for the CO log */
  revisedContractSum: number;
  requestedDate: string | null;
  dueDate: string | null;
  executedDate: string | null;
  signedChangeOrderReceivedDate: string | null;
  rejectionReason: string | null;
  createdBy: string;
  submittedBy: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  executedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What `/changes/:id/execute` returns: the change, what it appended, the contract. */
export interface ChangeExecution {
  change: PrimeChange;
  appendedLines: Array<{ id: string; lineNumber: string; scheduledValue: number }>;
  /** the owner-funded budget increase written in the same transaction */
  budget: ExecutionBudgetEffect;
  contract: ContractView;
}

/* ------------------------------------------------------------------ */
/* Progress billing — G702 / G703                                      */
/* ------------------------------------------------------------------ */

export interface PaymentApplication {
  id: string;
  projectId: string;
  primeContractId: string;
  invoiceId: string | null;
  billingPeriodId: string | null;
  number: number;
  reference: string;
  status: ApplicationStatus;
  applicationDate: string | null;
  periodTo: string | null;
  currency: string;
  originalContractSum: number;
  netChangeOrders: number;
  contractSumToDate: number;
  totalCompletedAndStored: number;
  totalRetainage: number;
  totalEarnedLessRetainage: number;
  lessPreviousCertificates: number;
  currentPaymentDue: number;
  balanceToFinishPlusRetainage: number;
  certifiedByContractorName: string | null;
  contractorCertifiedAt: string | null;
  notaryReference: string | null;
  architectVendorId: string | null;
  certifiedAmount: number | null;
  certificationNotes: string | null;
  certifiedBy: string | null;
  certifiedAt: string | null;
  paidAmount: number;
  paidAt: string | null;
  paymentReference: string | null;
  submittedBy: string | null;
  submittedAt: string | null;
  rejectedBy: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** The owner invoice behind an application (the G703 carrier). */
export interface OwnerInvoice {
  id: string;
  number: number;
  reference: string;
  status: string;
  currency: string;
  completedToDate: number;
  storedMaterials: number;
  retainagePercentWork: number;
  retainageWork: number;
  retainagePercentMaterials: number;
  retainageMaterials: number;
  retainageReleased: number;
  billingDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  dueDate: string | null;
  amountPaid: number;
}

/** One continuation-sheet row as stored on the invoice. */
export interface G703Line {
  id: string;
  invoiceId: string;
  lineNumber: string;
  sortOrder: number;
  primeContractSovLineId: string | null;
  costCode: string | null;
  costType: string | null;
  budgetLineItemId: string | null;
  description: string;
  source: string;
  billingMethod: string;
  unit: string | null;
  quantity: number | null;
  unitRate: number | null;
  scheduledValue: number;
  previousBilled: number;
  thisPeriodWork: number;
  previousStoredMaterials: number;
  thisPeriodStoredMaterials: number;
  materialsPresentlyStored: number;
  totalCompletedAndStored: number;
  percentComplete: number;
  balanceToFinish: number;
  retainagePercent: number;
  retainageThisPeriod: number;
  retainageHeldToDate: number;
  retainageReleased: number;
  amount: number;
  notes: string | null;
}

/** The G702 cover sheet, line by numbered line. */
export interface G702 {
  originalContractSum: number;
  netChangeOrders: number;
  contractSumToDate: number;
  completedToDate: number;
  storedMaterials: number;
  totalCompletedAndStored: number;
  retainagePercentWork: number;
  retainageWork: number;
  retainagePercentMaterials: number;
  retainageMaterials: number;
  totalRetainage: number;
  totalEarnedLessRetainage: number;
  lessPreviousCertificates: number;
  currentPaymentDue: number;
  balanceToFinishPlusRetainage: number;
  percentComplete: Component;
  currency: string;
}

/** `billingView()` — one application, both sheets, and the proof they agree. */
export interface BillingView {
  application: PaymentApplication;
  invoice: OwnerInvoice;
  g702: G702;
  g703: G703Line[];
  identities: Identity[];
  reconciled: boolean;
  retainage: unknown;
}

export interface Vendor {
  id: string;
  name: string;
  status: string;
}

/* ------------------------------------------------------------------ */
/* Platform-upgrade wire types — transcribed from                     */
/* apps/api/src/modules/primecontracts/{lifecycle,analytics,shared}.ts */
/* ------------------------------------------------------------------ */

export type ComplianceKind =
  | "insurance_certificate"
  | "performance_bond"
  | "payment_bond"
  | "permit"
  | "tax_form"
  | "notice_to_proceed"
  | "lien_waiver"
  | "warranty"
  | "other";

export type ComplianceStatus = "missing" | "received" | "verified" | "expired" | "waived";

export interface ComplianceDocument {
  id: string;
  primeContractId: string;
  kind: ComplianceKind;
  title: string;
  required: number;
  status: ComplianceStatus;
  documentId: string | null;
  reference: string | null;
  issuer: string | null;
  issuedDate: string | null;
  effectiveDate: string | null;
  expiryDate: string | null;
  receivedAt: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  waivedBy: string | null;
  waivedReason: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ComplianceGate {
  ok: boolean;
  blocking: Array<{ id: string; kind: string; title: string; status: string; problem: string }>;
  expiringSoon: Array<{ id: string; kind: string; title: string; expiryDate: string; daysLeft: number }>;
  summary: { required: number; satisfied: number; missing: number; expired: number; waived: number; optional: number };
}

export interface ComplianceView {
  primeContractId: string;
  items: ComplianceDocument[];
  total: number;
  gate: ComplianceGate;
}

export type StoredMaterialStatus = "stored" | "partially_incorporated" | "incorporated" | "removed";

export interface StoredMaterial {
  id: string;
  primeContractId: string;
  sovLineId: string;
  number: number;
  reference: string;
  description: string;
  status: StoredMaterialStatus;
  location: string;
  locationNotes: string | null;
  quantity: number | null;
  unit: string | null;
  value: number;
  incorporatedValue: number;
  storedDate: string;
  incorporatedDate: string | null;
  supplierInvoiceReference: string | null;
  supplierVendorId: string | null;
  insured: number;
  insuranceReference: string | null;
  billedOnApplicationId: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: string;
}

export interface StoredMaterialsView {
  primeContractId: string;
  currency: string;
  items: StoredMaterial[];
  total: number;
  reconciliation: {
    lines: Array<{ sovLineId: string; lineNumber: string; registerValue: number; billedValue: number; identity: Identity; items: number; uninsured: number; unevidenced: number }>;
    totals: { registerValue: number; billedValue: number; identity: Identity };
    reasons: string[];
  };
}

export interface OwnerReceipt {
  id: string;
  paymentApplicationId: string;
  number: number;
  reference: string;
  status: "recorded" | "void";
  amount: number;
  currency: string;
  receivedDate: string;
  method: string;
  paymentReference: string | null;
  bankReference: string | null;
  notes: string | null;
  voidReason: string | null;
  recordedBy: string;
  createdAt: string;
}

export interface ReceiptsView {
  applicationId: string;
  reference: string;
  currency: string;
  certified: number | null;
  paid: number;
  outstanding: number | null;
  items: OwnerReceipt[];
  total: number;
}

export interface AgedReceivable {
  applicationId: string;
  reference: string;
  certifiedAt: string | null;
  dueDate: string | null;
  certified: number;
  paid: number;
  outstanding: number;
  state: "unpaid" | "partially_paid" | "paid";
  daysOutstanding: number | null;
  daysOverdue: number | null;
  bucket: "current" | "1-30" | "31-60" | "61-90" | "90+" | "unknown";
}

export interface ReceivablesView {
  primeContractId: string;
  asOf: string;
  currency: string;
  paymentTermsDays: number | null;
  items: AgedReceivable[];
  totals: { certified: number; paid: number; outstanding: number; overdue: number };
  buckets: Array<{ bucket: AgedReceivable["bucket"]; amount: number; count: number }>;
  dunning: AgedReceivable[];
  reasons: string[];
  receipts: number;
}

export interface RetainageRelease {
  id: string;
  reference: string;
  status: string;
  basis: string;
  amount: number;
  retainageHeldBefore: number;
  retainageHeldAfter: number;
  newRetainagePercent: number | null;
  effectiveDate: string | null;
  releaseDate: string | null;
  reason: string | null;
  createdAt: string;
}

export interface RetainageView {
  primeContractId: string;
  currency: string;
  held: number;
  released: number;
  percentComplete: Component;
  byLine: Array<{ sovLineId: string; lineNumber: string; description: string; retainagePercent: number; retainageHeld: number; retainageReleased: number; totalCompletedAndStored: number }>;
  releases: RetainageRelease[];
  proposal: { kind: "none" | "step_down" | "final"; amount: Component; gate: { ok: boolean; reasons: string[] }; rationale: string };
  gate: { compliance: ComplianceGate; outstandingLienWaivers: Array<{ id: string; reference: string }>; openApplications: number };
}

export interface ChangeAnalytics {
  primeContractId: string;
  currency: string;
  asOf: string;
  byStatus: Array<{ status: string; count: number; amount: number }>;
  byReason: Array<{ reason: string; count: number; amount: number }>;
  executed: { count: number; amount: number; shareOfOriginal: number | null; scheduleImpactDays: number };
  pending: { count: number; amount: number; oldestDays: number | null; averageAgeDays: number | null };
  cycleTimeDays: { createdToSubmitted: number | null; submittedToApproved: number | null; approvedToExecuted: number | null; createdToExecuted: number | null; samples: number };
  monthly: Array<{ month: string; count: number; amount: number; cumulative: number }>;
  reasons: string[];
}

/** What `/changes/:id/execute` reports about the budget side. */
export interface ExecutionBudgetEffect {
  applied: boolean;
  budgetId: string | null;
  budgetChangeId: string | null;
  linesMoved: number;
  amount: number;
  reasons: string[];
}

export interface CostCodeRef {
  id: string;
  code: string;
  title: string;
  costType: string | null;
  isActive: number;
}
