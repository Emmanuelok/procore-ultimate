/**
 * Wire shapes for the project command centre.
 *
 * Every field named here is one the API actually sends — checked against
 * apps/api/src/modules/{budget,primecontracts,commitments,changes,invoicing,
 * field,schedule,risk,assurance}. Where the API returns a figure it could not
 * derive it sends `{ value: null, reasons: [...] }` (`Unknowable`) and that
 * shape is kept intact all the way to the component that renders it:
 * collapsing it to a number in the type layer is how a "we do not know"
 * becomes a zero three files later.
 */
import type { Unknowable } from "../../../layouts/project/lib";

/* -------------------------------------------------------------- commitments */

export interface CommitmentRow {
  id: string;
  number: number;
  reference: string;
  title: string;
  kind: string;
  status: string;
  currency: string;
  vendorId: string | null;
  vendorName: string | null;
  executed: number;
  paymentHold: number;
  originalCommitmentSum: number;
  approvedChangeSum: number;
  revisedCommitmentSum: number;
  totalInvoiced: number;
  totalPaid: number;
  retainageHeld: number;
  balanceToFinish: number;
  createdAt: string;
  updatedAt: string;
}

export interface CommitmentCurrencyTotals {
  currency: string;
  commitmentCount: number;
  originalCommitmentSum: number;
  approvedChangeSum: number;
  revisedCommitmentSum: number;
  totalInvoiced: number;
  totalPaid: number;
  retainageHeld: number;
}

export interface CommitmentList {
  items: CommitmentRow[];
  total: number;
  page: number;
  pageSize: number;
  totalsByCurrency: CommitmentCurrencyTotals[];
  mixedCurrency: boolean;
}

/* ------------------------------------------------------------------ budget */

export interface BudgetRow {
  id: string;
  number: number;
  reference: string;
  name: string;
  status: string;
  isActive: number;
  currency: string;
}

export interface BudgetPlanTotals {
  originalBudget: number;
  budgetModifications: number;
  approvedChanges: number;
  pendingChanges: number;
  revisedBudget: number;
  forecastToComplete: number;
  forecastFinal: number;
  /** revised budget − forecast final. Negative = projected overrun. */
  variance: number;
}

export interface BudgetOverrunLine {
  lineItemId: string;
  costCode: string | null;
  costType: string | null;
  description: string | null;
  revisedBudget: number;
  forecastFinal: number;
  projectedOverUnder: number;
}

export interface BudgetSummary {
  budgetId: string;
  projectId: string;
  reference: string;
  name: string;
  status: string;
  currency: string;
  asOf: string;
  lineCount: number;
  plan: BudgetPlanTotals;
  components: {
    committed: Unknowable;
    pendingCommitments: Unknowable;
    invoicedToDate: Unknowable;
    directCosts: Unknowable;
    jobToDateCosts: Unknowable;
    contingencyRemaining: Unknowable;
  };
  drift: {
    committed: number | null;
    jobToDateCosts: number | null;
    totalsCalculatedAt: string | null;
  };
  overrunLines: BudgetOverrunLine[];
}

/* --------------------------------------------------------------- invoicing */

export interface InvoiceRow {
  id: string;
  kind: string;
  number: number;
  reference: string;
  title: string | null;
  status: string;
  currency: string;
  billingDate: string | null;
  periodEnd: string | null;
  dueDate: string | null;
  revisedContractSum: number;
  totalCompletedAndStored: number;
  totalRetainage: number;
  currentPaymentDue: number;
  amountPaid: number;
  total: number;
  updatedAt: string;
  createdAt: string;
}

export interface CashPositionBucket {
  currency: string;
  receivableBilledUnpaid: number;
  receivableRetainageHeldByOwner: number;
  payableInvoicedUnpaid: number;
  payableRetainageWeHold: number;
  receivableOverdue: number;
  payableOverdue: number;
  netWorkingPosition: number;
  netPositionIncludingRetainage: number;
}

export interface CashPosition {
  asOf: string;
  projectId: string;
  byCurrency: CashPositionBucket[];
  openBillingPeriods: Array<{
    id: string;
    reference: string;
    name: string | null;
    startDate: string | null;
    endDate: string | null;
    billingDate: string | null;
    dueDate: string | null;
  }>;
  currencyNote: string | null;
  reasons: string[];
}

/* ----------------------------------------------------------------- changes */

export interface ChangeLogGroup {
  currency: string;
  events: {
    total: number;
    byStatus: Record<string, number>;
    openScheduleImpactDays: number;
    latestCostTotal: number;
  };
  pcos: { total: number; positionTotal: number; byStatus: Record<string, number> };
  cors: {
    total: number;
    requestedTotal: number;
    approvedTotal: number;
    negotiationGap: number;
    approvalRatePercent: Unknowable;
    daysClaimed: number;
    daysApproved: number;
    byStatus: Record<string, number>;
  };
  packages: {
    total: number;
    executedPrimeTotal: number;
    executedCommitmentTotal: number;
    byStatus: Record<string, number>;
  };
  marginTotal: { revenue: number; cost: number; margin: number; marginPercent: Unknowable };
  ok: boolean;
}

export interface ChangeLog {
  projectId: string;
  currencies: string[];
  mixedCurrency: boolean;
  reconciliation: ChangeLogGroup | null;
  groups: ChangeLogGroup[];
  reasons: string[];
}

/* ------------------------------------------------------------------- field */

export interface RfiAnalytics {
  open: number;
  overdue: number;
  avgResponseDays: number | null;
  byStatus: Record<string, number>;
}

export interface PunchAnalytics {
  byStatus: Record<string, number>;
  byAssignee: Array<{ assigneeId: string | null; count: number }>;
  overdue: number;
}

export interface RfiRow {
  id: string;
  number: number;
  subject: string;
  status: string;
  dueDate: string | null;
  ballInCourtId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SubmittalRow {
  id: string;
  number: number;
  revision: number;
  title: string;
  status: string;
  specSection: string | null;
  requiredOnSite: string | null;
  submitByDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PunchRow {
  id: string;
  number: number;
  title: string;
  status: string;
  priority: string;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
}

/* ---------------------------------------------------------------- schedule */

export interface ScheduleRow {
  id: string;
  name: string;
  projectStart: string;
  isActive: number;
  computedFinish: string | null;
  computedDurationDays: number | null;
  lastComputedAt: string | null;
}

export interface ScheduleTaskRow {
  id: string;
  name: string;
  wbsCode: string | null;
  /** 0 marks a milestone in this schema. */
  durationDays: number;
  actualStart: string | null;
  actualFinish: string | null;
  percentComplete: number;
  startDate: string | null;
  finishDate: string | null;
  totalFloat: number | null;
  isCritical: number;
}

export interface ScheduleDetail extends ScheduleRow {
  tasks: ScheduleTaskRow[];
  summary?: { taskCount: number; dependencyCount: number; criticalCount: number };
}

/* -------------------------------------------------------------------- risk */

export interface RiskRow {
  id: string;
  number: number;
  title: string;
  category: string;
  status: string;
  probabilityScore: number;
  impactScore: number;
  preScore: number;
  postScore: number | null;
  updatedAt: string;
}
