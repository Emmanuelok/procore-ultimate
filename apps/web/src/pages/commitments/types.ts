/**
 * The COMMITMENTS wire contract, transcribed from
 * `apps/api/src/modules/commitments/**` — not guessed.
 *
 * Every field name here is one the API actually sends. Where the API returns a
 * figure it could not derive it sends `{ value: null, reasons: [...] }`
 * (`Unknowable`), and this file keeps that shape intact all the way to the
 * component that renders it: collapsing it to a number in the type layer is how
 * a "we do not know" turns into a zero three files later.
 */

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** `shared.ts::Unknowable` — a figure the platform could not compute. */
export interface Unknowable<T = number> {
  value: T | null;
  reasons: string[];
}

export type CommitmentKind = "subcontract" | "purchase_order";

export type CommitmentStatus =
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

export type PaymentStatus =
  | "scheduled"
  | "on_hold"
  | "issued"
  | "cleared"
  | "failed"
  | "voided";

/* ------------------------------------------------------------------ */
/* Commitment                                                          */
/* ------------------------------------------------------------------ */

/** `commitments` table row, as the list and detail routes send it. */
export interface Commitment {
  id: string;
  companyId: string;
  projectId: string;
  kind: CommitmentKind;
  number: number;
  reference: string;
  title: string;
  description: string | null;
  scopeOfWork: string | null;
  vendorId: string | null;
  vendorContactId: string | null;
  contractId: string | null;
  primeContractId: string | null;
  pricingType: string;
  status: CommitmentStatus;
  executed: number;
  currency: string;
  originalCommitmentSum: number;
  approvedChangeSum: number;
  pendingChangeSum: number;
  draftChangeSum: number;
  revisedCommitmentSum: number;
  totalInvoiced: number;
  totalPaid: number;
  defaultRetainagePercent: number;
  retainageHeld: number;
  retainageReleased: number;
  balanceToFinish: number;
  totalsCalculatedAt: string | null;
  contractDate: string | null;
  startDate: string | null;
  estimatedCompletionDate: string | null;
  actualCompletionDate: string | null;
  signedContractReceivedDate: string | null;
  executionDate: string | null;
  terminationDate: string | null;
  paymentTermsDays: number | null;
  requiresLienWaiver: number;
  paymentHold: number;
  complianceHoldReason: string | null;
  shipTo: string | null;
  shipVia: string | null;
  deliveryDate: string | null;
  taxable: number;
  taxPercent: number | null;
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

/** The list route joins the vendor's name onto each row. */
export interface CommitmentListRow extends Commitment {
  vendorName: string | null;
}

/** Per-currency subtotals over the WHOLE filtered set. Never summed across. */
export interface CurrencyTotals {
  currency: string;
  commitmentCount: number;
  originalCommitmentSum: number;
  approvedChangeSum: number;
  revisedCommitmentSum: number;
  totalInvoiced: number;
  totalPaid: number;
  retainageHeld: number;
}

export interface CommitmentList extends Paginated<CommitmentListRow> {
  totalsByCurrency: CurrencyTotals[];
  mixedCurrency: boolean;
}

/* ------------------------------------------------------------------ */
/* Schedule of values                                                  */
/* ------------------------------------------------------------------ */

export interface SovLine {
  id: string;
  commitmentId: string;
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
  percentComplete: number;
  balanceToFinish: number;
  retainagePercent: number;
  retainageHeld: number;
  retainageReleased: number;
  isChangeOrderLine: number;
  changeOrderPackageId: string | null;
  taxable: number;
  taxCode: string | null;
  taxPercent: number | null;
  notes: string | null;
}

/** `GET /commitments/:id/sov` — the identity asserted on every read. */
export interface SovResponse {
  commitmentId: string;
  currency: string;
  lines: SovLine[];
  totals: {
    scheduledValue: number;
    changeOrderValue: number;
    revisedScheduledValue: number;
    totalCompletedAndStored: number;
    retainageHeld: number;
    balanceToFinish: number;
  };
  identity: {
    statement: string;
    sovTotal: number;
    commitmentSum: number;
    reconciles: boolean;
  };
}

/* ------------------------------------------------------------------ */
/* Change orders                                                       */
/* ------------------------------------------------------------------ */

export interface ChangeLine {
  sovLineId: string | null;
  costCode: string | null;
  costType: string | null;
  description: string;
  amount: number;
  budgetLineItemId: string | null;
}

export interface CommitmentChange {
  id: string;
  commitmentId: string;
  number: number;
  reference: string;
  title: string;
  description: string | null;
  reason: string | null;
  status: ChangeStatus;
  amount: number;
  scheduleImpactDays: number;
  lines: ChangeLine[];
  /** the commitment sum AFTER this change lands — stamped at approval */
  revisedCommitmentSum: number;
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

export interface ChangeRegister extends Paginated<CommitmentChange> {
  currency: string;
  register: { committed: number; pending: number; draft: number; dead: number };
}

/* ------------------------------------------------------------------ */
/* Payments                                                            */
/* ------------------------------------------------------------------ */

export interface CommitmentPayment {
  id: string;
  commitmentId: string;
  invoiceId: string | null;
  vendorId: string | null;
  number: number;
  reference: string;
  method: string;
  status: PaymentStatus;
  amount: number;
  retainageReleasedAmount: number;
  discountTaken: number;
  currency: string;
  paymentDate: string | null;
  clearedDate: string | null;
  checkNumber: string | null;
  transactionReference: string | null;
  holdReason: string | null;
  lienWaiverId: string | null;
  notes: string | null;
  createdBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  issuedBy: string | null;
  issuedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentRegister extends Paginated<CommitmentPayment> {
  currency: string;
  register: {
    paid: number;
    scheduled: number;
    onHold: number;
    failed: number;
    retainageReleasedPaid: number;
  };
}

/* ------------------------------------------------------------------ */
/* Compliance — the differentiator                                     */
/* ------------------------------------------------------------------ */

export type ComplianceCode =
  | "no_vendor"
  | "vendor_inactive"
  | "certificate_missing"
  | "certificate_expired"
  | "certificate_not_yet_effective"
  | "certificate_unverified"
  | "certificate_limit_below_requirement"
  | "bond_missing"
  | "bond_expired"
  | "bond_below_requirement"
  | "lien_waiver_outstanding"
  | "payment_hold";

export interface ComplianceFinding {
  code: ComplianceCode;
  severity: "block" | "warn";
  /** The API's own sentence. Rendered verbatim — never paraphrased. */
  message: string;
  subjectType: string | null;
  subjectId: string | null;
  /** the date the evidence ran out, when there was evidence */
  expiredOn: string | null;
  daysExpired: number | null;
}

export type ComplianceStatus = "compliant" | "warning" | "blocked" | "unknown";

export interface ComplianceRequirements {
  strictness: "off" | "warn" | "block";
  requiredPolicyTypes: string[];
  requiredBondTypes: string[];
  minimumInsuranceLimit: number | null;
  minimumBondPercent: number | null;
  requireVerifiedCertificates: boolean;
  notes: string | null;
}

export interface ComplianceResult {
  status: ComplianceStatus;
  strictness: "off" | "warn" | "block";
  vendorId: string | null;
  asOf: string;
  /** false when no cover requirement is recorded — the honest "we cannot say" */
  requirementsKnown: boolean;
  requirements: ComplianceRequirements;
  findings: ComplianceFinding[];
  blocking: ComplianceFinding[];
  warnings: ComplianceFinding[];
  note: string | null;
  evidence: {
    certificatesConsidered: number;
    bondsConsidered: number;
    lienWaiversConsidered: number;
  };
}

export interface ComplianceEntry {
  commitmentId: string;
  reference: string;
  kind: string;
  title: string;
  status: string;
  vendorId: string | null;
  vendorName: string | null;
  revisedCommitmentSum: number;
  currency: string;
  compliance: ComplianceResult;
}

export interface ComplianceReport {
  projectId: string;
  asOf: string;
  entries: ComplianceEntry[];
  summary: {
    total: number;
    blocked: number;
    warning: number;
    compliant: number;
    unknown: number;
    paymentBlocked: number;
  };
  notes: string[];
}

/* ------------------------------------------------------------------ */
/* Position + detail                                                   */
/* ------------------------------------------------------------------ */

export interface ReconciliationCheck {
  identity: string;
  left: number;
  right: number;
  delta: number;
  reconciles: boolean;
}

export interface CommitmentPosition {
  commitmentId: string;
  currency: string;
  originalCommitmentSum: number;
  approvedChangeSum: number;
  pendingChangeSum: number;
  draftChangeSum: number;
  revisedCommitmentSum: number;
  potentialCommitmentSum: number;
  totalInvoiced: number;
  totalPaid: number;
  retainageHeld: number;
  retainageReleased: number;
  balanceToFinish: number;
  outstandingToPay: number;
  percentInvoiced: Unknowable;
  percentPaid: Unknowable;
  invoiceCount: number;
  reconciliation: { checks: ReconciliationCheck[]; reconciles: boolean };
}

export interface CommitmentDetail {
  commitment: Commitment & { complianceRequirements: ComplianceRequirements };
  billable: { billable: boolean; reason: string | null };
  vendor: { id: string; name: string; status: string } | null;
  sovLines: SovLine[];
  changes: CommitmentChange[];
  payments: CommitmentPayment[];
  position: CommitmentPosition;
  compliance: ComplianceResult;
}

/* ------------------------------------------------------------------ */
/* Buyout log                                                          */
/* ------------------------------------------------------------------ */

export interface BuyoutRow {
  budgetLineItemId: string;
  costCode: string;
  costType: string;
  description: string;
  revisedBudget: number;
  committed: number;
  pendingCommitted: number;
  /** revisedBudget − committed − pendingCommitted; negative is an overrun */
  projectedSavings: number;
  percentBoughtOut: Unknowable;
  boughtOut: boolean;
  commitmentCount: number;
  currency: string;
  excludedCurrencies: string[];
}

export interface BuyoutLog {
  projectId: string;
  budgetId: string | null;
  currency: string | null;
  rows: BuyoutRow[];
  totals: {
    revisedBudget: number;
    committed: number;
    pendingCommitted: number;
    projectedSavings: number;
  } | null;
  unboughtLineCount: number;
  notes: string[];
}

/* ------------------------------------------------------------------ */
/* Directory                                                           */
/* ------------------------------------------------------------------ */

export interface Vendor {
  id: string;
  name: string;
  status: string;
}
