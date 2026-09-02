/**
 * Shared vocabulary for the CHANGE MANAGEMENT workspace (module M5).
 *
 * The API models change as a CHAIN, not a list of change orders:
 *
 *   change event      something happened, and nobody knows what it costs
 *     → PCO           our cost position, priced by cost type
 *         → RFQ       the sub's number, compared and selected
 *     → COR           the ask to the owner, with the markup stack
 *         → package   executed: contract sum, commitment and budget all move
 *
 * Everything in this file exists to keep that chain legible and to keep the
 * screen honest about what it does not know:
 *
 *   · a `Component` (`{ value, inputs, reasons }`) with a null value renders
 *     "Not available" plus the server's reasons VERBATIM — never a zero;
 *   · money is never summed across currencies, so every total carries the
 *     currency it was computed in and mixed projects get one block each;
 *   · an unverified provenance link is labelled unverified, not blessed.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiClientError, api } from "../../lib/api";
import { Alert, Badge, Card, CardBody, Skeleton } from "../../ui";
import type { Tone } from "../../ui/tokens";

/* ============================================================================
   Wire shapes — mirrored from apps/api/src/modules/changes
============================================================================ */

export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** `{ value, inputs, reasons }` — the API's "no fabricated number" contract. */
export interface MetricComponent {
  value: number | null;
  inputs: Record<string, unknown>;
  reasons: string[];
}

export interface Identity {
  identity: string;
  left: number;
  right: number;
  delta: number;
  ok: boolean;
}

export type CostType = "labour" | "material" | "equipment" | "subcontract" | "other";

export const COST_TYPES: readonly CostType[] = [
  "labour",
  "material",
  "equipment",
  "subcontract",
  "other",
];

export const COST_TYPE_LABEL: Record<CostType, string> = {
  labour: "Labour",
  material: "Material",
  equipment: "Equipment",
  subcontract: "Subcontract",
  other: "Other",
};

export interface ChangeLineRow {
  id: string;
  parentType: string;
  parentId: string;
  changeEventId: string | null;
  lineNumber: string | null;
  sortOrder: number;
  costCodeId: string | null;
  costCode: string | null;
  costType: string | null;
  budgetLineItemId: string | null;
  description: string;
  unit: string | null;
  quantity: number | null;
  unitRate: number | null;
  costAmount: number;
  revenueAmount: number;
  markupKind: string | null;
  markupPercent: number | null;
  markupAmount: number;
  taxPercent: number | null;
  taxAmount: number;
  vendorId: string | null;
  notes: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface LineTotals {
  lineCount: number;
  costSubtotal: number;
  costByType: Record<string, number>;
  revenueSubtotal: number;
  lineMarkupTotal: number;
  taxTotal: number;
  margin: number;
}

/** One step of the markup stack, exactly as the API applied it. */
export interface AppliedMarkup {
  sequence: number;
  kind: string;
  label: string;
  basis: string;
  rate: number;
  costTypes: string[] | null;
  maxAmount: number | null;
  basisAmount: number;
  computedAmount: number;
  amount: number;
  cappedBy: number | null;
  runningTotalAfter: number;
  reasons: string[];
}

export interface MarkupStackResult {
  costSubtotal: number;
  costByType: Record<string, number>;
  quantityTotal: number;
  applied: AppliedMarkup[];
  markupTotal: number;
  taxTotal: number;
  total: number;
  margin: number;
  reasons: string[];
}

export interface ChangeEventRow {
  id: string;
  companyId: string;
  projectId: string;
  number: number;
  reference: string;
  title: string;
  description: string | null;
  status: string;
  eventType: string;
  scope: string;
  reason: string | null;
  originType: string;
  originId: string | null;
  primeContractId: string | null;
  locationId: string | null;
  tier: string | null;
  roughOrderOfMagnitude: number;
  estimatedCost: number;
  latestCost: number;
  estimatedRevenue: number;
  approvedRevenue: number;
  scheduleImpactDays: number;
  identifiedDate: string | null;
  dueDate: string | null;
  notes: string | null;
  documentIds: string[];
  detail: Record<string, unknown>;
  createdBy: string;
  closedBy: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EventRollup {
  roughOrderOfMagnitude: number;
  estimatedCost: number;
  latestCost: number;
  estimatedRevenue: number;
  approvedRevenue: number;
  margin: MetricComponent;
  pcoCount: number;
  corCount: number;
  executedPackageCount: number;
}

export interface OriginVerification {
  originType: string;
  originId: string | null;
  verified: boolean;
  label: string | null;
  reasons: string[];
}

export interface EventDetail {
  event: ChangeEventRow;
  lines: ChangeLineRow[];
  lineTotals: {
    costSubtotal: number;
    costByType: Record<string, number>;
    revenueSubtotal: number;
    taxTotal: number;
  };
  potentialChangeOrders: PcoRow[];
  changeOrderRequests: CorRow[];
  rollup: EventRollup;
}

export interface PcoRow {
  id: string;
  changeEventId: string | null;
  number: number;
  reference: string;
  title: string;
  description: string | null;
  status: string;
  reason: string | null;
  scope: string;
  commitmentId: string | null;
  vendorId: string | null;
  primeContractId: string | null;
  changeOrderRequestId: string | null;
  changeOrderPackageId: string | null;
  estimatedAmount: number;
  quotedAmount: number;
  amount: number;
  scheduleImpactDays: number;
  noCharge: number;
  dueDate: string | null;
  detail: Record<string, unknown>;
  createdBy: string;
  submittedBy: string | null;
  approvedBy: string | null;
  rejectedBy: string | null;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PcoPositions {
  estimatedAmount: number;
  quotedAmount: number;
  amount: number;
  quoteVariance: MetricComponent;
  quoteVariancePercent: MetricComponent;
}

export interface PcoDetail {
  pco: PcoRow;
  lines: ChangeLineRow[];
  totals: LineTotals;
  quoteRequests: QuoteRow[];
  positions: PcoPositions;
}

export interface QuoteRow {
  id: string;
  changeEventId: string | null;
  potentialChangeOrderId: string | null;
  commitmentId: string | null;
  vendorId: string | null;
  number: number;
  reference: string;
  title: string;
  scopeDescription: string | null;
  status: string;
  dueDate: string | null;
  sentAt: string | null;
  viewedAt: string | null;
  respondedAt: string | null;
  quotedAmount: number | null;
  quotedScheduleImpactDays: number | null;
  quoteNotes: string | null;
  quoteValidUntil: string | null;
  quoteDocumentIds: string[];
  acceptedAt: string | null;
  acceptedBy: string | null;
  declinedAt: string | null;
  declineReason: string | null;
  createdAt: string;
  updatedAt: string;
  /** added by the list/detail routes */
  expired?: boolean;
}

export interface QuoteComparisonRow {
  id: string;
  reference: string;
  vendorId: string | null;
  vendorName: string | null;
  status: string;
  quotedAmount: number | null;
  quotedScheduleImpactDays: number | null;
  quoteValidUntil: string | null;
  expired: boolean;
  respondedAt: string | null;
  turnaroundDays: number | null;
  varianceAgainstEstimate: MetricComponent;
  varianceAgainstLowest: MetricComponent;
  rank: number | null;
}

export interface QuoteComparison {
  potentialChangeOrderId: string;
  reference: string;
  estimatedAmount: number;
  quotes: QuoteComparisonRow[];
  coverage: {
    requested: number;
    responded: number;
    outstanding: number;
    declined: number;
    accepted: number;
  };
  lowest: MetricComponent;
  highest: MetricComponent;
  spread: MetricComponent;
  recommendation: string;
}

export interface CorRow {
  id: string;
  primeContractId: string;
  changeEventId: string | null;
  number: number;
  reference: string;
  title: string;
  description: string | null;
  reason: string | null;
  status: string;
  pcoIds: string[];
  markups: unknown[];
  subtotal: number;
  markupTotal: number;
  taxTotal: number;
  amount: number;
  approvedAmount: number;
  scheduleImpactDays: number;
  scheduleImpactApprovedDays: number;
  submittedDate: string | null;
  dueDate: string | null;
  ownerResponseDate: string | null;
  changeOrderPackageId: string | null;
  negotiationNotes: string | null;
  documentIds: string[];
  detail: Record<string, unknown>;
  createdBy: string;
  submittedBy: string | null;
  approvedBy: string | null;
  rejectedBy: string | null;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NegotiationRound {
  seq: number;
  at: string;
  by: string;
  position: "owner" | "contractor";
  amount: number | null;
  scheduleImpactDays: number | null;
  note: string;
}

export interface CorDetail {
  changeOrderRequest: CorRow;
  lines: ChangeLineRow[];
  members: PcoRow[];
  markupStack: MarkupStackResult;
  total: MetricComponent;
  identities: Identity[];
  negotiation: NegotiationRound[];
  commercial: {
    asked: number;
    granted: number;
    gap: number;
    gapPercent: MetricComponent;
  };
}

export interface PackageRow {
  id: string;
  kind: "prime_contract" | "commitment";
  number: number;
  reference: string;
  title: string;
  description: string | null;
  status: string;
  primeContractId: string | null;
  commitmentId: string | null;
  changeEventId: string | null;
  memberIds: string[];
  amount: number;
  scheduleImpactDays: number;
  primeContractChangeId: string | null;
  commitmentChangeId: string | null;
  budgetChangeId: string | null;
  executedAt: string | null;
  executedBy: string | null;
  signedDate: string | null;
  dueDate: string | null;
  createdBy: string;
  submittedBy: string | null;
  approvedBy: string | null;
  rejectedBy: string | null;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContractSums {
  originalContractSum: number;
  approvedChangeSum: number;
  pendingChangeSum: number;
  draftChangeSum: number;
  revisedContractSum: number;
}

export interface CommitmentSums {
  originalCommitmentSum: number;
  approvedChangeSum: number;
  pendingChangeSum: number;
  draftChangeSum: number;
  revisedCommitmentSum: number;
}

export interface BudgetEffect {
  applied: boolean;
  budgetId: string | null;
  budgetChangeId: string | null;
  linesMoved: number;
  amount: number;
  reasons: string[];
  forecastNotes: string[];
}

export interface AllocationLegOut {
  key: string;
  costCode: string | null;
  costType: string | null;
  budgetLineItemId: string | null;
  description: string;
  amount: number;
  residual: number;
}

export interface ExecutionResult {
  packageId: string;
  reference: string;
  kind: string;
  amount: number;
  currency: string;
  scale: number;
  legs: AllocationLegOut[];
  primeContractChangeId: string | null;
  primeContractChangeReference: string | null;
  appendedSovLineIds: string[];
  contractSums: ContractSums | null;
  commitmentChangeId: string | null;
  commitmentChangeReference: string | null;
  commitmentSums: CommitmentSums | null;
  budget: BudgetEffect;
  identities: Identity[];
}

export interface PackageDetail {
  package: PackageRow;
  members: Array<PcoRow | CorRow>;
  lines: ChangeLineRow[];
  identities: Identity[];
  executed: Record<string, unknown>;
}

export interface FunnelStage {
  stage: string;
  events: number;
  amount: number;
  description: string;
}

export interface ContractMovement {
  primeContractId: string;
  reference: string;
  originalContractSum: number;
  approvedChangeSum: number;
  pendingChangeSum: number;
  revisedContractSum: number;
  executedPackageTotal: number;
  executedChangeTotal: number;
  identities: Identity[];
  ok: boolean;
}

export interface EventMargin {
  changeEventId: string;
  revenue: number;
  cost: number;
  margin: number;
  marginPercent: MetricComponent;
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
    quoteVarianceAgainstEstimate: MetricComponent;
  };
  cors: {
    total: number;
    byStatus: Record<string, number>;
    requestedTotal: number;
    approvedTotal: number;
    rejectedTotal: number;
    negotiationGap: number;
    approvalRatePercent: MetricComponent;
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
  margins: EventMargin[];
  unattributedExecutedRevenue: number;
  marginTotal: {
    revenue: number;
    cost: number;
    margin: number;
    marginPercent: MetricComponent;
  };
  funnel: FunnelStage[];
  identities: Identity[];
  ok: boolean;
}

export interface ChangeLogResponse {
  projectId: string;
  currencies: string[];
  mixedCurrency: boolean;
  reconciliation: ChangeLogReconciliation | null;
  groups: ChangeLogReconciliation[];
  reasons: string[];
}

export interface PrimeContractRow {
  id: string;
  number: number;
  reference: string;
  title: string;
  status: string;
  currency: string;
  originalContractSum: number;
  approvedChangeSum: number;
  pendingChangeSum: number;
  revisedContractSum: number;
}

export interface CommitmentRow {
  id: string;
  kind: string;
  number: number;
  reference: string;
  title: string;
  status: string;
  currency: string;
  vendorId: string | null;
  originalCommitmentSum: number;
  approvedChangeSum: number;
  pendingChangeSum: number;
  revisedCommitmentSum: number;
}

export interface VendorRow {
  id: string;
  name: string;
  status: string;
}

/* ============================================================================
   Errors
============================================================================ */

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

/**
 * The server's refusal, kept intact. A refusal on this module names figures to
 * the cent and cites the control it is enforcing; paraphrasing it would throw
 * away the only part a user can act on.
 */
export interface ServerRefusal {
  status: number;
  message: string;
  control: string | null;
  details: Record<string, unknown> | null;
}

export function refusalFrom(err: unknown): ServerRefusal | null {
  if (!(err instanceof ApiClientError)) return null;
  const body = err.details as { details?: unknown } | undefined;
  const raw = body && typeof body === "object" ? body.details : undefined;
  const details =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const control = details && typeof details["control"] === "string" ? details["control"] : null;
  return { status: err.status, message: err.message, control, details };
}

/* ============================================================================
   Formatting
============================================================================ */

/**
 * Money, in ONE currency. There is no variant that takes a list of amounts in
 * different currencies, because there is no answer to that question here.
 */
export function money(amount: number | null | undefined, currency: string | null): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return "—";
  if (!currency) {
    return `${amount.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })} (currency unknown)`;
  }
  try {
    return amount.toLocaleString(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    });
  } catch {
    return `${currency} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}

export function num(value: number | null | undefined, dp = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, { maximumFractionDigits: dp });
}

export function percent(value: number | null | undefined, dp = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: dp })}%`;
}

export function days(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} d`;
}

export function isoDate(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function isoDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** `design_change` → `Design change`. Enum members are stored snake_case. */
export function label(value: string | null | undefined): string {
  if (!value) return "—";
  const spaced = value.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(parsed)) return null;
  return Math.floor((Date.now() - parsed) / 86_400_000);
}

/* ============================================================================
   Status vocabulary
============================================================================ */

const EVENT_TONE: Record<string, Tone> = {
  open: "warning",
  pending: "info",
  closed: "success",
  void: "neutral",
};

const PCO_TONE: Record<string, Tone> = {
  draft: "neutral",
  pending_quote: "warning",
  priced: "info",
  submitted: "accent",
  approved: "success",
  rejected: "danger",
  no_charge: "neutral",
  void: "neutral",
};

const QUOTE_TONE: Record<string, Tone> = {
  draft: "neutral",
  sent: "info",
  viewed: "info",
  quoted: "accent",
  accepted: "success",
  declined: "danger",
  expired: "warning",
  void: "neutral",
};

const COR_TONE: Record<string, Tone> = {
  draft: "neutral",
  submitted: "info",
  under_review: "info",
  negotiating: "warning",
  approved: "success",
  partially_approved: "warning",
  rejected: "danger",
  withdrawn: "neutral",
  void: "neutral",
};

const PACKAGE_TONE: Record<string, Tone> = {
  draft: "neutral",
  pending_pricing: "warning",
  pending_in_house_review: "info",
  pending_owner_approval: "info",
  revise_and_resubmit: "warning",
  approved: "accent",
  executed: "success",
  rejected: "danger",
  no_charge: "neutral",
  void: "neutral",
};

export const eventTone = (s: string): Tone => EVENT_TONE[s] ?? "neutral";
export const pcoTone = (s: string): Tone => PCO_TONE[s] ?? "neutral";
export const quoteTone = (s: string): Tone => QUOTE_TONE[s] ?? "neutral";
export const corTone = (s: string): Tone => COR_TONE[s] ?? "neutral";
export const packageTone = (s: string): Tone => PACKAGE_TONE[s] ?? "neutral";

export const CHANGE_EVENT_STATUSES = ["open", "pending", "closed", "void"] as const;

export const CHANGE_EVENT_TYPES = [
  "design_change",
  "field_condition",
  "owner_request",
  "allowance_reconciliation",
  "value_engineering",
  "backcharge",
  "weather",
  "errors_omissions",
  "regulatory",
  "scope_gap",
  "other",
] as const;

export const CHANGE_EVENT_SCOPES = ["in_scope", "out_of_scope", "tbd"] as const;

export const CHANGE_REASONS = [
  "client_request",
  "design_development",
  "design_error",
  "design_omission",
  "unforeseen_condition",
  "existing_condition",
  "code_compliance",
  "coordination_conflict",
  "allowance_reconciliation",
  "value_engineering",
  "weather",
  "owner_directed_acceleration",
  "other",
] as const;

export const CHANGE_EVENT_ORIGIN_KINDS = [
  "rfi",
  "submittal",
  "observation",
  "daily_log",
  "drawing_revision",
  "specification",
  "meeting",
  "inspection",
  "punch_item",
  "contract_event",
  "schedule_task",
  "document",
  "manual",
] as const;

export const PCO_STATUSES = [
  "draft",
  "pending_quote",
  "priced",
  "submitted",
  "approved",
  "rejected",
  "no_charge",
  "void",
] as const;

export const COR_STATUSES = [
  "draft",
  "submitted",
  "under_review",
  "negotiating",
  "approved",
  "partially_approved",
  "rejected",
  "withdrawn",
  "void",
] as const;

export const QUOTE_REQUEST_STATUSES = [
  "draft",
  "sent",
  "viewed",
  "quoted",
  "accepted",
  "declined",
  "expired",
  "void",
] as const;

export const MARKUP_BASES = ["cost", "running_total", "markups_to_date", "quantity", "none"] as const;
export const MARKUP_KINDS = ["percent", "fixed_amount", "per_unit"] as const;

export const MARKUP_BASIS_EXPLAIN: Record<string, string> = {
  cost: "the cost subtotal (optionally narrowed to named cost types)",
  running_total: "cost plus every markup charged before this one",
  markups_to_date: "only the markups charged before this one",
  quantity: "the summed quantity across the cost lines",
  none: "nothing — a flat amount",
};

/**
 * Which route a change event's origin can be followed to. The API verifies the
 * link server-side; this only decides where a verified link points.
 */
export function originHref(
  projectId: string,
  originType: string,
  originId: string | null,
): string | null {
  if (!originId) return null;
  switch (originType) {
    case "rfi":
      return `/projects/${projectId}/rfis?rfi=${encodeURIComponent(originId)}`;
    case "submittal":
      return `/projects/${projectId}/submittals?submittal=${encodeURIComponent(originId)}`;
    case "drawing_revision":
      return `/projects/${projectId}/drawings?revision=${encodeURIComponent(originId)}`;
    case "daily_log":
      return `/projects/${projectId}/daily-logs?log=${encodeURIComponent(originId)}`;
    case "punch_item":
      return `/projects/${projectId}/punch?item=${encodeURIComponent(originId)}`;
    case "schedule_task":
      return `/projects/${projectId}/schedule?task=${encodeURIComponent(originId)}`;
    case "document":
      return `/projects/${projectId}/documents?file=${encodeURIComponent(originId)}`;
    default:
      return null;
  }
}

/* ============================================================================
   Honesty components
============================================================================ */

/**
 * A `Component` from the API. `value: null` is never rendered as 0 — it is
 * rendered as "Not available" with the server's reasons underneath, word for
 * word, because those reasons name exactly which record is missing.
 */
export function ComponentValue({
  component,
  currency,
  format = "money",
  dp = 2,
  className,
}: {
  component: MetricComponent | null | undefined;
  currency?: string | null;
  format?: "money" | "number" | "percent" | "days";
  dp?: number;
  className?: string;
}) {
  if (!component) {
    return <span className="text-content-subtle">—</span>;
  }
  if (component.value === null) {
    return (
      <span className={className}>
        <span className="text-content-subtle italic">Not available</span>
        {component.reasons.length > 0 ? (
          <span className="mt-0.5 block text-2xs leading-snug text-content-muted">
            {component.reasons.join(" ")}
          </span>
        ) : null}
      </span>
    );
  }
  const text =
    format === "money"
      ? money(component.value, currency ?? null)
      : format === "percent"
        ? percent(component.value, dp)
        : format === "days"
          ? days(component.value)
          : num(component.value, dp);
  return <span className={className}>{text}</span>;
}

/** The server's reasons, verbatim, in a muted block. Renders nothing if empty. */
export function Reasons({
  reasons,
  tone = "info",
  title,
}: {
  reasons: readonly string[] | null | undefined;
  tone?: Tone;
  title?: ReactNode;
}) {
  if (!reasons || reasons.length === 0) return null;
  return (
    <Alert tone={tone} variant="subtle" size="sm" title={title}>
      <ul className="ml-4 list-disc space-y-1">
        {reasons.map((reason, index) => (
          <li key={index}>{reason}</li>
        ))}
      </ul>
    </Alert>
  );
}

/**
 * A figure with no source. Renders the reason it is absent rather than a zero,
 * because a zero here is a factual claim about the project.
 */
export function NoFigure({ reason }: { reason: string }) {
  return (
    <span className="text-content-subtle">
      <span className="italic">Not available</span>
      <span className="mt-0.5 block text-2xs leading-snug text-content-muted">{reason}</span>
    </span>
  );
}

/** A number the API returned as `null` inside a plain object. */
export function Maybe({
  value,
  currency,
  reason,
}: {
  value: number | null | undefined;
  currency?: string | null;
  reason: string;
}) {
  if (value === null || value === undefined) return <NoFigure reason={reason} />;
  return <>{money(value, currency ?? null)}</>;
}

/** The reconciliation identity row: what was checked, and by how much it is out. */
export function IdentityList({
  identities,
  currency,
}: {
  identities: readonly Identity[];
  currency: string | null;
}) {
  if (identities.length === 0) return null;
  return (
    <ul className="space-y-1.5">
      {identities.map((identity, index) => (
        <li
          key={index}
          className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-border-subtle px-2.5 py-1.5"
        >
          <span className="font-mono text-2xs text-content-muted">{identity.identity}</span>
          <span className="flex items-center gap-2 text-meta tabular-nums">
            <span className="text-content">{money(identity.left, currency)}</span>
            <span className="text-content-subtle">vs</span>
            <span className="text-content">{money(identity.right, currency)}</span>
            <Badge tone={identity.ok ? "success" : "danger"} size="xs">
              {identity.ok ? "ties" : `out by ${money(identity.delta, currency)}`}
            </Badge>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Card-shaped skeleton for a panel that is still loading. */
export function PanelSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <Card>
      <CardBody className="space-y-3">
        <Skeleton height={14} width="34%" />
        {Array.from({ length: rows }).map((_, index) => (
          <Skeleton key={index} height={12} width={`${88 - index * 9}%`} />
        ))}
      </CardBody>
    </Card>
  );
}

/* ============================================================================
   Data hooks
============================================================================ */

export interface Resource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** GET once, re-fetch on demand. Failures are named, never rendered as empty. */
export function useResource<T>(path: string | null): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(path !== null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!path) {
      setData(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get<T>(path)
      .then((body) => {
        if (!cancelled) setData(body);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, `Failed to load ${path}`));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}


/**
 * Every page of a list endpoint, fetched sequentially at the API's page cap
 * and concatenated — so a register with more rows than one page still loads
 * in full, and one that fits in a page costs one request. Bounded at 25 pages
 * (12,500 rows); beyond that `truncated` says so rather than pretending.
 */
export function useAllPages<T>(path: string | null, pageSize = 200): Resource<ListResponse<T>> & { truncated: boolean } {
  const [data, setData] = useState<ListResponse<T> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(path !== null);
  const [truncated, setTruncated] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!path) {
      setData(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      const items: T[] = [];
      let total = 0;
      let page = 1;
      let more = true;
      let cut = false;
      while (more) {
        const sep = path.includes("?") ? "&" : "?";
        const body = await api.get<ListResponse<T>>(`${path}${sep}page=${page}&pageSize=${pageSize}`);
        items.push(...body.items);
        total = body.total;
        more = body.items.length === pageSize && items.length < total;
        page += 1;
        if (more && page > 25) {
          cut = true;
          more = false;
        }
      }
      if (!cancelled) {
        setData({ items, total, page: 1, pageSize: items.length });
        setTruncated(cut);
      }
    })()
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, `Failed to load ${path}`));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, nonce, pageSize]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload, truncated };
}

export interface ChangeContext {
  contracts: PrimeContractRow[];
  commitments: CommitmentRow[];
  vendors: VendorRow[];
  contractById: Map<string, PrimeContractRow>;
  commitmentById: Map<string, CommitmentRow>;
  vendorName: (id: string | null | undefined) => string | null;
  /** The currency of a prime contract, or null when it cannot be established. */
  contractCurrency: (id: string | null | undefined) => string | null;
  commitmentCurrency: (id: string | null | undefined) => string | null;
  /** The project's currencies, from its contracts and commitments. */
  currencies: string[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * The contracts, commitments and vendors a change screen needs to say what a
 * number is denominated in and who it is with. Currency is READ from the
 * contract that owns the money — never assumed from the project.
 */
export function useChangeContext(projectId: string): ChangeContext {
  const scope = projectId ? `/api/v1/projects/${projectId}` : null;
  const contracts = useAllPages<PrimeContractRow>(scope && `${scope}/prime-contracts`);
  const commitments = useAllPages<CommitmentRow>(scope && `${scope}/commitments`);
  const vendors = useAllPages<VendorRow>(projectId ? "/api/v1/vendors" : null);

  const contractRows = useMemo(() => contracts.data?.items ?? [], [contracts.data]);
  const commitmentRows = useMemo(() => commitments.data?.items ?? [], [commitments.data]);
  const vendorRows = useMemo(() => vendors.data?.items ?? [], [vendors.data]);

  const contractById = useMemo(
    () => new Map(contractRows.map((c) => [c.id, c])),
    [contractRows],
  );
  const commitmentById = useMemo(
    () => new Map(commitmentRows.map((c) => [c.id, c])),
    [commitmentRows],
  );
  const vendorById = useMemo(() => new Map(vendorRows.map((v) => [v.id, v])), [vendorRows]);

  const currencies = useMemo(() => {
    const set = new Set<string>();
    for (const c of contractRows) set.add(c.currency.toUpperCase());
    for (const c of commitmentRows) set.add(c.currency.toUpperCase());
    return [...set].sort();
  }, [contractRows, commitmentRows]);

  const reload = useCallback(() => {
    contracts.reload();
    commitments.reload();
    vendors.reload();
  }, [contracts, commitments, vendors]);

  return {
    contracts: contractRows,
    commitments: commitmentRows,
    vendors: vendorRows,
    contractById,
    commitmentById,
    vendorName: (id) => (id ? (vendorById.get(id)?.name ?? null) : null),
    contractCurrency: (id) => (id ? (contractById.get(id)?.currency.toUpperCase() ?? null) : null),
    commitmentCurrency: (id) =>
      id ? (commitmentById.get(id)?.currency.toUpperCase() ?? null) : null,
    currencies,
    loading: contracts.loading || commitments.loading || vendors.loading,
    error: contracts.error ?? commitments.error ?? vendors.error,
    reload,
  };
}

/** Only one currency on the project? Then every figure is in it, unambiguously. */
export function soleCurrency(currencies: readonly string[]): string | null {
  return currencies.length === 1 ? (currencies[0] ?? null) : null;
}

/* ============================================================================
   The chain, loaded once
============================================================================ */

export interface ChangeChain {
  events: ChangeEventRow[];
  pcos: PcoRow[];
  quotes: QuoteRow[];
  cors: CorRow[];
  packages: PackageRow[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Every link of the chain, in one place. The pipeline derives a change event's
 * STAGE from the documents that exist underneath it — there is no "stage"
 * column, and there should not be one: a change moves stage by being priced,
 * quoted, submitted or executed, never by somebody setting a field.
 */
export function useChangeChain(projectId: string): ChangeChain {
  const scope = projectId ? `/api/v1/projects/${projectId}` : null;
  const events = useAllPages<ChangeEventRow>(scope && `${scope}/change-events`);
  const pcos = useAllPages<PcoRow>(scope && `${scope}/potential-change-orders`);
  const quotes = useAllPages<QuoteRow>(scope && `${scope}/quote-requests`);
  const cors = useAllPages<CorRow>(scope && `${scope}/change-order-requests`);
  const packages = useAllPages<PackageRow>(scope && `${scope}/change-order-packages`);

  const reload = useCallback(() => {
    events.reload();
    pcos.reload();
    quotes.reload();
    cors.reload();
    packages.reload();
  }, [events, pcos, quotes, cors, packages]);

  return {
    events: events.data?.items ?? [],
    pcos: pcos.data?.items ?? [],
    quotes: quotes.data?.items ?? [],
    cors: cors.data?.items ?? [],
    packages: packages.data?.items ?? [],
    loading:
      events.loading || pcos.loading || quotes.loading || cors.loading || packages.loading,
    error: events.error ?? pcos.error ?? quotes.error ?? cors.error ?? packages.error,
    reload,
  };
}

export const PIPELINE_STAGES = [
  "identified",
  "priced",
  "quoted",
  "submitted",
  "decided",
  "executed",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const PIPELINE_STAGE_LABEL: Record<PipelineStage, string> = {
  identified: "Identified",
  priced: "Priced (PCO)",
  quoted: "Quoted (RFQ)",
  submitted: "Submitted (COR)",
  decided: "Approved / rejected",
  executed: "Executed",
};

export const PIPELINE_STAGE_HINT: Record<PipelineStage, string> = {
  identified: "Raised. Nobody knows yet what it costs.",
  priced: "A PCO carries a cost position taken forward.",
  quoted: "An RFQ is out to a subcontractor, or a quote is back.",
  submitted: "A COR is with the owner and live.",
  decided: "The owner has answered — approved, part-approved or rejected.",
  executed: "A package executed: contract sum, commitment and budget have moved.",
};

const DEAD_PCO = new Set(["rejected", "no_charge", "void"]);
const PRICED_PCO = new Set(["priced", "submitted", "approved"]);
const LIVE_COR = new Set(["submitted", "under_review", "negotiating"]);
const DECIDED_COR = new Set(["approved", "partially_approved", "rejected"]);

export interface StagedEvent {
  event: ChangeEventRow;
  stage: PipelineStage;
  pcos: PcoRow[];
  quotes: QuoteRow[];
  cors: CorRow[];
  packages: PackageRow[];
  currency: string | null;
  /** the money this event carries AT its stage, in `currency` */
  stageAmount: number;
  stageAmountBasis: string;
}

/**
 * Place each change event on the chain from the records that exist under it.
 * A void event is dropped; everything else lands somewhere, and the furthest
 * stage reached wins, because exposure does not go backwards on a screen.
 */
export function stageEvents(
  chain: ChangeChain,
  currencyOfContract: (id: string | null | undefined) => string | null,
  currencyOfCommitment: (id: string | null | undefined) => string | null,
): StagedEvent[] {
  const pcosByEvent = new Map<string, PcoRow[]>();
  for (const p of chain.pcos) {
    if (!p.changeEventId) continue;
    const list = pcosByEvent.get(p.changeEventId) ?? [];
    list.push(p);
    pcosByEvent.set(p.changeEventId, list);
  }
  const corsByEvent = new Map<string, CorRow[]>();
  for (const c of chain.cors) {
    if (!c.changeEventId) continue;
    const list = corsByEvent.get(c.changeEventId) ?? [];
    list.push(c);
    corsByEvent.set(c.changeEventId, list);
  }
  const quotesByPco = new Map<string, QuoteRow[]>();
  for (const q of chain.quotes) {
    if (!q.potentialChangeOrderId) continue;
    const list = quotesByPco.get(q.potentialChangeOrderId) ?? [];
    list.push(q);
    quotesByPco.set(q.potentialChangeOrderId, list);
  }
  const packagesByEvent = new Map<string, PackageRow[]>();
  const addPackage = (eventId: string | null, pkg: PackageRow) => {
    if (!eventId) return;
    const list = packagesByEvent.get(eventId) ?? [];
    if (!list.some((p) => p.id === pkg.id)) list.push(pkg);
    packagesByEvent.set(eventId, list);
  };
  const corById = new Map(chain.cors.map((c) => [c.id, c]));
  const pcoById = new Map(chain.pcos.map((p) => [p.id, p]));
  for (const pkg of chain.packages) {
    addPackage(pkg.changeEventId, pkg);
    for (const memberId of pkg.memberIds) {
      const member = pkg.kind === "prime_contract" ? corById.get(memberId) : pcoById.get(memberId);
      if (member) addPackage(member.changeEventId, pkg);
    }
  }

  const staged: StagedEvent[] = [];
  for (const event of chain.events) {
    if (event.status === "void") continue;
    const pcos = pcosByEvent.get(event.id) ?? [];
    const livePcos = pcos.filter((p) => !DEAD_PCO.has(p.status));
    const cors = corsByEvent.get(event.id) ?? [];
    const quotes = livePcos.flatMap((p) => quotesByPco.get(p.id) ?? []);
    const packages = packagesByEvent.get(event.id) ?? [];

    const executed = packages.filter((p) => p.status === "executed");
    const decidedCors = cors.filter((c) => DECIDED_COR.has(c.status));
    const liveCors = cors.filter((c) => LIVE_COR.has(c.status));
    const livePriced = livePcos.filter((p) => PRICED_PCO.has(p.status));
    const liveQuotes = quotes.filter((q) => !["draft", "void"].includes(q.status));

    let stage: PipelineStage = "identified";
    if (livePriced.length > 0) stage = "priced";
    if (liveQuotes.length > 0 && stage === "priced") stage = "quoted";
    else if (liveQuotes.length > 0 && stage === "identified") stage = "quoted";
    if (liveCors.length > 0) stage = "submitted";
    if (decidedCors.length > 0) stage = "decided";
    if (executed.length > 0) stage = "executed";

    const currency =
      currencyOfContract(event.primeContractId) ??
      currencyOfContract(cors[0]?.primeContractId) ??
      currencyOfCommitment(livePcos.find((p) => p.commitmentId)?.commitmentId) ??
      null;

    let stageAmount: number;
    let stageAmountBasis: string;
    switch (stage) {
      case "executed":
        stageAmount = executed.reduce((s, p) => s + p.amount, 0);
        stageAmountBasis = "executed package total";
        break;
      case "decided":
        stageAmount = decidedCors.reduce((s, c) => s + c.approvedAmount, 0);
        stageAmountBasis = "granted by the owner";
        break;
      case "submitted":
        stageAmount = liveCors.reduce((s, c) => s + c.amount, 0);
        stageAmountBasis = "asked of the owner";
        break;
      case "quoted":
      case "priced":
        stageAmount = livePcos.reduce((s, p) => s + (p.noCharge === 1 ? 0 : p.amount), 0);
        stageAmountBasis = "position taken forward on the PCOs";
        break;
      default:
        stageAmount = event.roughOrderOfMagnitude;
        stageAmountBasis = "rough order of magnitude";
    }

    staged.push({
      event,
      stage,
      pcos,
      quotes,
      cors,
      packages,
      currency,
      stageAmount: Math.round(stageAmount * 100) / 100,
      stageAmountBasis,
    });
  }
  return staged;
}
