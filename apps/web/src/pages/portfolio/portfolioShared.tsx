/**
 * Shared view-models, vocabulary and presentational helpers for the owner /
 * portfolio workspace (spec Vol I §7 #776–#789, Vol II Domain G #423–#434,
 * Domain Z #1053–#1066).
 *
 * The types mirror `apps/api/src/modules/portfolio` exactly, including the
 * `reasons` arrays every engine returns. Three honesty rules run through this
 * file and every component that uses it:
 *
 *   · A figure the API returned as null renders "—" with the reason it gave,
 *     never 0. `num`, `money` and `pct` are the only places that decide that.
 *   · Money always carries its currency and is NEVER summed across
 *     currencies — the API buckets and this workspace shows the buckets.
 *   · Every panel loads, fails and empties on its own.
 */
import { useCallback, useState, type ReactNode } from "react";
import { api, ApiClientError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { Alert, Badge, Skeleton, cx, type Tone } from "../../ui";
import { useResource, type Loadable, type Paginated } from "../../layouts/project/lib";

export { useResource };
export type { Loadable, Paginated };

export const DASH = "—";

/* ================================ Money ================================== */

export function money(value: number | null | undefined, currency: string | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  const formatted = value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency ? `${formatted} ${currency}` : formatted;
}

/** A compact money figure for dense tables: no decimals over 10,000. */
export function moneyShort(value: number | null | undefined, currency: string | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  const abs = Math.abs(value);
  const formatted =
    abs >= 10_000
      ? value.toLocaleString(undefined, { maximumFractionDigits: 0 })
      : value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${formatted} ${currency}` : formatted;
}

export function num(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export function pct(value: number | null | undefined, dp = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return `${value.toFixed(dp)}%`;
}

export function isoDate(value: string | null | undefined): string {
  if (!value) return DASH;
  return value.slice(0, 10);
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return DASH;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function titleCase(value: string | null | undefined): string {
  if (!value) return DASH;
  return value
    .split(/[_\s]+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export function errorMessage(err: unknown, fallback = "The request failed."): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

export function useIsCompanyAdmin(): boolean {
  const { company } = useAuth();
  return company?.role === "owner" || company?.role === "admin";
}

/* ================================ Tones ================================== */

export function statusTone(status: string): Tone {
  switch (status) {
    case "available":
    case "approved":
    case "live":
    case "active":
    case "completed":
    case "paid":
    case "verified":
    case "carried_forward":
      return "success";
    case "proposed":
    case "draft":
    case "planned":
    case "forming":
    case "pending":
    case "notified":
    case "issued":
    case "under_review":
    case "queried":
      return "warning";
    case "exhausted":
    case "withdrawn":
    case "terminated":
    case "cancelled":
    case "rejected":
    case "lapsed":
    case "disputed":
    case "obstructed":
    case "overdue":
    case "disallowed":
    case "not_quorate":
      return "danger";
    case "closed":
    case "expired":
    case "superseded":
    case "archived":
    case "dissolved":
      return "neutral";
    default:
      return "info";
  }
}

export function severityTone(severity: string): Tone {
  switch (severity) {
    case "critical":
    case "high":
      return "danger";
    case "medium":
      return "warning";
    case "low":
      return "info";
    default:
      return "neutral";
  }
}

/** A headroom figure is good when positive, dangerous when negative. */
export function headroomTone(headroom: number | null): Tone | undefined {
  if (headroom === null || !Number.isFinite(headroom)) return undefined;
  if (headroom < 0) return "danger";
  return undefined;
}

export function utilisationTone(percent: number | null): Tone | undefined {
  if (percent === null || !Number.isFinite(percent)) return undefined;
  if (percent > 100) return "danger";
  if (percent >= 90) return "warning";
  return undefined;
}

export const DETECTOR_LABEL: Record<string, string> = {
  portfolio_envelope_breach: "Affordability envelope breached",
  portfolio_appropriation_overcommitted: "Appropriation overcommitted",
  portfolio_funding_source_overdrawn: "Funding source over-allocated",
  framework_ceiling_breach: "Framework ceiling breached",
  framework_expiring: "Framework expiring",
  jv_contribution_overdue: "Partner contribution overdue",
  target_cost_overrun: "Target cost overrun",
  open_book_verification_overdue: "Open-book verification not started",
  disallowed_cost_unresolved: "Disallowed cost unanswered",
  audit_rights_obstructed: "Audit access obstructed",
};

/* ================================ Types ================================== */

export interface Unknowable {
  value: number | null;
  reasons: string[];
}

export interface CurrencyRollup {
  currency: string;
  projects: number;
  projectValue: number;
  revisedBudget: number;
  committed: number;
  jobToDateCost: number;
  forecastFinal: number;
  commitmentValue: number;
  invoiced: number;
  paid: number;
  forecastVariance: number;
}

export interface PortfolioRollup {
  byCurrency: CurrencyRollup[];
  combinedForecastFinal: Unknowable;
  projectsWithoutBudget: number;
  projectsMixedCurrency: number;
  reasons: string[];
  generatedAt?: string;
}

export interface PipelineEntry {
  projectId: string;
  projectName: string;
  stage: string;
  currency: string;
  value: number | null;
  portfolioId: string | null;
  gatesTotal: number;
  gatesDecided: number;
  nextGate: { id: string; gateNumber: number; name: string; plannedDate: string | null; status: string } | null;
  lastReview: { gateNumber: number; reviewDate: string; rag: string; decision: string } | null;
  overdueGates: number;
  reasons: string[];
}

export interface PipelineResult {
  entries: PipelineEntry[];
  byStage: Record<string, number>;
  byRag: Record<string, number>;
  gatesOverdue: number;
  projectsWithoutGates: number;
  generatedAt?: string;
}

export interface AffordabilityLine {
  envelopeId: string;
  name: string;
  fiscalYear: string;
  currency: string;
  expenditureClass: string;
  envelope: number;
  demand: number;
  headroom: number;
  utilisationPercent: number | null;
  breached: boolean;
  breachedBy: number;
  allocationCount: number;
  basis: string | null;
  reasons: string[];
}

export interface ClassSplitBucket {
  currency: string;
  capital: number;
  revenue: number;
  mixed: number;
  unclassified: number;
  total: number;
  capitalPercent: number | null;
}

export interface AffordabilityResult {
  lines: AffordabilityLine[];
  uncovered: Array<{ fiscalYear: string; currency: string; expenditureClass: string; amount: number; count: number }>;
  reasons: string[];
  classificationSplit?: ClassSplitBucket[];
  allocationCount?: number;
  generatedAt?: string;
}

export interface FundingSourcePosition {
  fundingSourceId: string;
  currency: string;
  facility: number;
  allocated: number;
  drawn: number;
  headroom: number;
  utilisationPercent: number | null;
  overdrawn: boolean;
  overdrawnBy: number;
  currencyMismatches: number;
  reasons: string[];
}

export interface FundingSource {
  id: string;
  portfolioId: string | null;
  reference: string | null;
  name: string;
  kind: string;
  provider: string | null;
  currency: string;
  amount: number;
  availableFrom: string | null;
  availableTo: string | null;
  status: string;
  expenditureClass: string;
  conditions: Array<{ id?: string; text: string; dueDate?: string | null; met?: boolean }>;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  position: FundingSourcePosition;
}

export interface AppropriationPosition {
  appropriationId: string;
  currency: string;
  authorised: number;
  allocated: number;
  drawn: number;
  uncommitted: number;
  utilisationPercent: number | null;
  overcommitted: boolean;
  overcommittedBy: number;
  carryForwardEligible: number;
  carryForwardPolicy: string;
  allocationCount: number;
  currencyMismatches: number;
  reasons: string[];
}

export interface Appropriation {
  id: string;
  name: string;
  fiscalYear: string;
  portfolioId: string | null;
  fundingSourceId: string | null;
  currency: string;
  appropriatedAmount: number;
  carriedForwardIn: number;
  carriedForwardOut: number;
  virementNet: number;
  expenditureClass: string;
  carryForwardPolicy: string;
  status: string;
  carriedForwardFromId: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  closedAt: string | null;
  notes: string | null;
  position: AppropriationPosition;
}

export interface Virement {
  id: string;
  fromAppropriationId: string;
  toAppropriationId: string;
  currency: string;
  amount: number;
  reason: string;
  status: string;
  requestedBy: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

export interface Allocation {
  id: string;
  projectId: string;
  projectName?: string | null;
  fundingSourceId: string | null;
  appropriationId: string | null;
  fiscalYear: string | null;
  currency: string;
  amount: number;
  drawnAmount: number;
  remaining?: number;
  expenditureClass: string;
  status: string;
  wholeLifeCost: number | null;
  approvedBy: string | null;
  approvedAt: string | null;
  notes: string | null;
}

export interface Envelope {
  id: string;
  portfolioId: string | null;
  name: string;
  fiscalYear: string;
  currency: string;
  envelopeAmount: number;
  basis: string | null;
  expenditureClass: string;
  status: string;
  supersededById: string | null;
}

export interface McdaCriterion {
  key: string;
  label: string;
  description?: string | null;
  weight: number;
  direction: "benefit" | "cost";
  min: number;
  max: number;
}

export interface ScoringModel {
  id: string;
  portfolioId: string | null;
  name: string;
  description: string | null;
  criteria: McdaCriterion[];
  normalisation: "fixed_scale" | "relative";
  status: string;
  version: number;
  scoredProjects?: number;
  scores?: Array<{
    id: string;
    projectId: string;
    projectName: string | null;
    scores: Record<string, number>;
    rationale: Record<string, string>;
    notes: string | null;
    scoredBy: string;
    scoredAt: string;
    orphanedKeys: string[];
  }>;
}

export interface McdaCriterionResult {
  key: string;
  label: string;
  direction: "benefit" | "cost";
  weight: number;
  weightShare: number;
  raw: number | null;
  normalised: number | null;
  contribution: number | null;
  rationale: string | null;
  reason: string | null;
}

export interface McdaRanked {
  projectId: string;
  projectName: string;
  stage?: string | null;
  rank: number | null;
  score: number | null;
  coverage: number;
  scoredCriteria: number;
  criteria: McdaCriterionResult[];
  reasons: string[];
}

export interface RankingResponse {
  modelId: string;
  modelName: string;
  modelVersion: number;
  modelStatus?: string;
  method: string;
  run: {
    method: string;
    criteria: Array<{ key: string; label: string; weight: number; weightShare: number; direction: string }>;
    excludedCriteria: Array<{ key: string; reason: string }>;
    ranked: McdaRanked[];
    influence: Array<{ key: string; label: string; weightShare: number; rankChanges: number; changesLeader: boolean }>;
    warnings: string[];
  } | null;
  orphanedEntries?: Array<{ projectId: string; keys: string[] }>;
  reasons: string[];
  generatedAt: string;
}

export interface LotUtilisation {
  lotId: string;
  lotNumber: string;
  title: string;
  currency: string;
  ceiling: number | null;
  ordered: number;
  certified: number;
  callOffCount: number;
  headroom: number | null;
  utilisationPercent: number | null;
  breached: boolean;
  breachedBy: number;
  currencyMismatches: number;
  reasons: string[];
}

export interface FrameworkUtilisation {
  frameworkId: string;
  currency: string;
  ceiling: number | null;
  ordered: number;
  certified: number;
  callOffCount: number;
  headroom: number | null;
  utilisationPercent: number | null;
  breached: boolean;
  breachedBy: number;
  currencyMismatches: number;
  unallocatedCallOffs: number;
  lots: LotUtilisation[];
  daysToExpiry: number | null;
  expiresOn: string | null;
  liveCallOffsAtExpiry: number;
  reasons: string[];
}

export interface Framework {
  id: string;
  reference: string;
  title: string;
  description: string | null;
  contractingAuthority: string | null;
  portfolioId: string | null;
  startDate: string | null;
  endDate: string | null;
  extensionToDate: string | null;
  currency: string;
  maximumValue: number | null;
  awardMode: string;
  directAwardThreshold: number | null;
  status: string;
  rulesReference: string | null;
  notes: string | null;
  utilisation: FrameworkUtilisation;
  lotCount?: number;
}

export interface FrameworkLot {
  id: string;
  frameworkId: string;
  lotNumber: string;
  title: string;
  description: string | null;
  currency: string;
  ceilingValue: number | null;
  awardMode: string | null;
  status: string;
}

export interface FrameworkSupplier {
  id: string;
  frameworkId: string;
  lotId: string | null;
  vendorId: string | null;
  supplierName: string;
  rank: number | null;
  status: string;
  appointedAt: string | null;
  suspendedReason: string | null;
}

export interface MiniCompetition {
  id: string;
  frameworkId: string;
  lotId: string | null;
  projectId: string | null;
  reference: string;
  title: string;
  scope: string | null;
  currency: string;
  estimatedValue: number | null;
  invitedSupplierIds: string[];
  evaluationCriteria: Array<{ key: string; label: string; weight: number; isPrice?: boolean }>;
  responses: Array<{
    supplierId: string;
    supplierName: string;
    price: number | null;
    scores?: Record<string, number>;
    withdrawn?: boolean;
    submittedAt?: string | null;
    note?: string | null;
  }>;
  issuedAt: string | null;
  responsesDueAt: string | null;
  status: string;
  awardedSupplierId: string | null;
  awardedSupplierName: string | null;
  awardValue: number | null;
  awardedAt: string | null;
  decisionNote: string | null;
}

export interface EvaluatedResponse {
  supplierId: string;
  supplierName: string;
  price: number | null;
  qualityScore: number | null;
  priceScore: number | null;
  totalScore: number | null;
  rank: number | null;
  reasons: string[];
}

export interface MiniCompetitionEvaluation {
  responses: EvaluatedResponse[];
  lowestPrice: number | null;
  indicatedWinnerId: string | null;
  warnings: string[];
}

export interface FrameworkDetail extends Framework {
  lots: FrameworkLot[];
  suppliers: FrameworkSupplier[];
  miniCompetitions: MiniCompetition[];
  callOffs: CallOffLite[];
}

export interface CallOffLite {
  id: string;
  projectId: string;
  reference: string;
  frameworkId: string | null;
  lotId: string | null;
  termContractId: string | null;
  route: string;
  currency: string;
  orderValue: number;
  certifiedValue: number;
  status: string;
}

export interface SorItem {
  id: string;
  termContractId: string;
  code: string;
  description: string;
  category: string | null;
  unit: string;
  currency: string;
  rate: number;
  active: number;
}

export interface TermContract {
  id: string;
  reference: string;
  title: string;
  vendorId: string | null;
  supplierName: string;
  currency: string;
  startDate: string | null;
  endDate: string | null;
  maximumValue: number | null;
  adjustmentPercent: number;
  adjustmentBasis: string;
  indexReference: string | null;
  priceBaseDate: string | null;
  status: string;
  notes: string | null;
  consumption: { ordered: number; certified: number; count: number; currencyMismatches: number };
  rates?: SorItem[];
  callOffs?: CallOffLite[];
}

export interface PricedLine {
  sorItemId: string | null;
  code: string;
  description: string;
  unit: string;
  quantity: number;
  baseRate: number | null;
  rate: number | null;
  amount: number | null;
  source: "schedule" | "star_rate" | "unpriced";
  reason: string | null;
}

export interface PricedOrder {
  currency: string;
  adjustmentPercent: number;
  lines: PricedLine[];
  total: number;
  pricedLines: number;
  unpricedLines: number;
  reasons: string[];
}

export interface CallOff {
  id: string;
  projectId: string;
  number: number;
  reference: string;
  title: string;
  scope: string | null;
  route: string;
  frameworkId: string | null;
  lotId: string | null;
  miniCompetitionId: string | null;
  termContractId: string | null;
  vendorId: string | null;
  supplierName: string;
  currency: string;
  orderValue: number;
  certifiedValue: number;
  lines: PricedLine[];
  status: string;
  issuedAt: string | null;
  requiredBy: string | null;
  completedAt: string | null;
  justification: string | null;
  notes: string | null;
  remainingToCertify?: number;
  framework?: Framework | null;
  termContract?: TermContract | null;
  pricingReasons?: string[];
}

export interface CallOffListResponse extends Paginated<CallOff> {
  byCurrency: Array<{ currency: string; ordered: number; certified: number; count: number }>;
}

export interface AvailableFrameworks {
  frameworks: Array<{
    id: string;
    reference: string;
    title: string;
    currency: string;
    awardMode: string;
    directAwardThreshold: number | null;
    endDate: string | null;
    extensionToDate: string | null;
    lots: FrameworkLot[];
    utilisation: FrameworkUtilisation;
  }>;
  termContracts: Array<{
    id: string;
    reference: string;
    title: string;
    supplierName: string;
    currency: string;
    adjustmentPercent: number;
    endDate: string | null;
  }>;
}

export interface PartnerPosition {
  partnerId: string;
  name: string;
  role: string;
  sharePercent: number;
  isSelf: boolean;
  committedCapital: number | null;
  contributed: number;
  distributed: number;
  outstandingCalls: number;
  overdueCalls: number;
  overdueAmount: number;
  netPosition: number;
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
  ourSharePercent: number | null;
  ourContributed: number | null;
  positions: PartnerPosition[];
  reasons: string[];
  warnings: string[];
}

export interface JvPartner {
  id: string;
  jvId: string;
  name: string;
  entityId: string | null;
  vendorId: string | null;
  role: string;
  sharePercent: number;
  committedCapital: number | null;
  liabilityBasis: string;
  isSelf: number;
  boardSeats: number | null;
  status: string;
  joinedAt: string | null;
  leftAt: string | null;
  notes: string | null;
}

export interface JvTransaction {
  id: string;
  jvId: string;
  partnerId: string;
  kind: string;
  currency: string;
  amount: number;
  dueDate: string | null;
  settledDate: string | null;
  status: string;
  reference: string | null;
  obligationId: string | null;
  description: string | null;
  createdBy: string;
}

export interface JvDecision {
  id: string;
  jvId: string;
  reference: string | null;
  decisionType: string;
  meetingDate: string;
  subject: string;
  narrative: string | null;
  deedClause: string | null;
  votes: Array<{ partnerId: string; vote: string; sharePercent?: number | null }>;
  sharePresentPercent: number | null;
  shareForPercent: number | null;
  quorumMet: number;
  thresholdMet: number;
  outcome: string;
  obligationId: string | null;
  obligation?: { id: string; status: string; deadline: string | null } | null;
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
  outcome: string;
  unknownVoters: string[];
  reasons: string[];
}

export interface Venture {
  id: string;
  projectId: string | null;
  projectName?: string | null;
  name: string;
  structure: string;
  currency: string;
  formationDate: string | null;
  endDate: string | null;
  deedReference: string | null;
  registeredNumber: string | null;
  jurisdiction: string | null;
  quorumPercent: number | null;
  reservedMatterThresholdPercent: number | null;
  status: string;
  notes: string | null;
  summary: VentureSummary;
  partners?: JvPartner[];
  transactions?: JvTransaction[];
  decisions?: JvDecision[];
}

export interface ShareBand {
  fromPercent: number;
  toPercent: number | null;
  contractorSharePercent: number;
}

export interface BandResult extends ShareBand {
  amountInBand: number;
  contractorAmount: number;
  clientAmount: number;
}

export interface PainGainOutput {
  computable: boolean;
  reasons: string[];
  warnings: string[];
  currency: string;
  adjustedTarget: number;
  outturnCost: number;
  variance: number;
  variancePercent: number | null;
  side: "pain" | "gain" | "on_target";
  bands: BandResult[];
  contractorShare: number | null;
  clientShare: number | null;
  capApplied: "pain" | "gain" | null;
  cappedAt: number | null;
  capTransfer: number;
  fee: number;
  contractorAdjustment: number | null;
  contractorPayment: number | null;
  participants: Array<{ name: string; partyId: string | null; sharePercent: number; amount: number }>;
  basis: string[];
}

export interface TargetCost {
  id: string;
  projectId: string;
  name: string;
  contractReference: string | null;
  isAlliance: number;
  currency: string;
  baseTargetCost: number;
  targetAdjustments: number;
  actualDefinedCost: number;
  forecastDefinedCost: number | null;
  feePercent: number;
  mechanism: string;
  shareBands: ShareBand[];
  painCap: number | null;
  gainCap: number | null;
  participants: Array<{ name: string; partyId?: string | null; sharePercent: number }>;
  status: string;
  notes: string | null;
  position: PainGainOutput | null;
  positionReason?: string | null;
  actualPosition?: PainGainOutput | null;
  calculations?: PainGainCalculation[];
  modelWarnings?: string[];
}

export interface PainGainCalculation {
  id: string;
  targetCostId: string;
  basis: string;
  currency: string;
  adjustedTarget: number;
  outturnCost: number;
  variance: number;
  contractorShare: number;
  clientShare: number;
  detail: Record<string, unknown>;
  computedBy: string | null;
  createdAt: string;
}

export interface ComponentAggregate {
  component: string;
  items: number;
  claimed: number;
  verified: number;
  queried: number;
  disallowed: number;
  pending: number;
  verificationRatePercent: number | null;
  itemsWithoutEvidence: number;
}

export interface VerificationTotals {
  currency: string;
  claimed: number;
  verified: number;
  queried: number;
  disallowed: number;
  pending: number;
  itemCount: number;
  itemsWithoutEvidence: number;
  currencyMismatches: number;
  verificationRatePercent: number | null;
  disallowanceRatePercent: number | null;
  byComponent: ComponentAggregate[];
  reasons: string[];
}

export interface Extrapolation {
  extrapolable: boolean;
  observedRatePercent: number | null;
  projectedDisallowance: number | null;
  untestedValue: number | null;
  coveragePercent: number | null;
  basis: string[];
  reasons: string[];
}

export interface DefinedCostItem {
  id: string;
  verificationId: string;
  component: string;
  contractHeading: string | null;
  description: string;
  currency: string;
  claimedAmount: number;
  verifiedAmount: number;
  verdict: string;
  evidenceRef: string | null;
  evidenceId: string | null;
  sourceType: string | null;
  sourceId: string | null;
  verifierNote: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  createdBy: string;
}

export interface Verification {
  id: string;
  projectId: string;
  number: number;
  reference: string;
  title: string;
  targetCostId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  currency: string;
  claimedAmount: number;
  verifiedAmount: number;
  queriedAmount: number;
  disallowedAmount: number;
  pendingAmount: number;
  totalsCalculatedAt: string | null;
  auditRightsClause: string | null;
  componentMapping: Record<string, string>;
  methodology: string | null;
  sampling: Record<string, unknown>;
  verifierId: string | null;
  verifierName: string | null;
  plannedAt: string | null;
  status: string;
  reportedAt: string | null;
  findings: string | null;
  untestedAmount?: number;
  items?: DefinedCostItem[];
  totals?: VerificationTotals;
  disallowed?: DisallowedCost[];
  auditRightsExecutions?: AuditRights[];
  extrapolation?: Extrapolation;
}

export interface DisallowedCost {
  id: string;
  projectId: string;
  number: number;
  verificationId: string | null;
  definedCostItemId: string | null;
  description: string;
  category: string;
  groundClause: string | null;
  currency: string;
  amount: number;
  deductedAmount: number;
  status: string;
  raisedBy: string;
  raisedAt: string;
  responseDueAt: string | null;
  contractorResponse: string | null;
  respondedAt: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  obligationId: string | null;
  deductionRefType: string | null;
  deductionRefId: string | null;
  warning?: string | null;
}

export interface DisallowedSummary {
  byCurrency: Array<{
    currency: string;
    raised: number;
    accepted: number;
    disputed: number;
    withdrawn: number;
    deducted: number;
    outstanding: number;
    count: number;
  }>;
  byCategory: Array<{ category: string; count: number; currencies: string[] }>;
  unresolved: number;
  overdueResponses: number;
  withoutGround: number;
  oldestUnresolvedDays: number | null;
  reasons: string[];
}

export interface DisallowedListResponse extends Paginated<DisallowedCost> {
  summary: DisallowedSummary;
}

export interface AuditRights {
  id: string;
  projectId: string | null;
  verificationId: string | null;
  reference: string;
  subjectType: string;
  subjectId: string | null;
  subjectName: string;
  contractReference: string | null;
  clause: string | null;
  scope: string;
  auditorName: string | null;
  auditorUserId: string | null;
  noticeDate: string;
  noticeDays: number | null;
  scheduledDate: string | null;
  accessGrantedAt: string | null;
  recordsRequested: Array<{
    id?: string;
    description: string;
    requestedAt?: string;
    providedAt?: string | null;
    refused?: boolean;
    note?: string | null;
  }>;
  obstructionNote: string | null;
  status: string;
  completedAt: string | null;
  outcome: string | null;
  obligationId: string | null;
  recordsSummary?: { requested: number; provided: number; refused: number; outstanding: number };
}

export interface PortfolioSignal {
  id: string;
  projectId: string | null;
  detector: string;
  severity: string;
  confidence: number;
  title: string;
  explanation: string;
  evidenceRefs: unknown;
  disposition: string;
  createdAt: string;
}

export interface OverviewResponse {
  generatedAt: string;
  scope: { portfolioId: string | null; fiscalYear: string | null };
  projects: { total: number; live: number; sandbox: number };
  rollup: PortfolioRollup;
  pipeline: PipelineResult;
  affordability: AffordabilityResult;
  classificationSplit: ClassSplitBucket[];
  fundingSources: {
    total: number;
    positions: Array<FundingSourcePosition & { id: string; name: string; kind: string; status: string }>;
    overdrawn: number;
  };
  appropriations: {
    total: number;
    positions: Array<AppropriationPosition & { id: string; name: string; fiscalYear: string; status: string }>;
    overcommitted: number;
  };
  frameworks: {
    total: number;
    live: number;
    positions: Array<FrameworkUtilisation & { id: string; reference: string; title: string; status: string; endDate: string | null }>;
    breached: number;
    expiringWithin90Days: number;
  };
  ventures: number;
  signals: Array<{ detector: string; severity: string; count: number }>;
  reasons: string[];
}

export interface ProjectPortfolioSummary {
  generatedAt: string;
  funding: {
    allocations: number;
    approved: number;
    byCurrency: Array<{ currency: string; allocated: number; drawn: number; count: number }>;
  };
  callOffs: {
    total: number;
    live: number;
    byCurrency: Array<{ currency: string; ordered: number; certified: number; count: number }>;
  };
  ventures: { total: number; active: number; overdueContributions: number };
  targetCost: {
    total: number;
    active: number;
    worstVariancePercent: number | null;
    worstTarget: { id: string; name: string; currency: string; variance: number } | null;
  };
  openBook: {
    verifications: number;
    inProgress: number;
    overduePlanned: number;
    coverage: Array<{
      id: string;
      reference: string;
      title: string;
      status: string;
      currency: string;
      claimedAmount: number;
      plannedAt: string | null;
      totals: VerificationTotals;
    }>;
  };
  disallowed: {
    total: number;
    unresolved: number;
    overdueResponses: number;
    withoutGround: number;
    oldestUnresolvedDays: number | null;
    byCurrency: DisallowedSummary["byCurrency"];
  };
  auditRights: { total: number; open: number; obstructed: number };
  reasons: string[];
}

export interface SweepResult {
  ranAt: string;
  envelopeBreaches: number;
  appropriationOvercommits: number;
  fundingOverdrawn: number;
  frameworkCeilingBreaches: number;
  frameworksExpiring: number;
  jvContributionsOverdue: number;
  targetCostOverruns: number;
  verificationsOverdue: number;
  disallowedUnresolved: number;
  auditRightsObstructed: number;
  signalsRaised: number;
  signalsClosed: number;
}

/* ============================ Panel primitives ============================ */

export function ReasonList({ reasons, className }: { reasons: readonly string[]; className?: string }) {
  if (reasons.length === 0) return null;
  return (
    <ul className={cx("space-y-1", className)}>
      {reasons.map((reason, index) => (
        <li key={index} className="flex items-start gap-1.5 text-meta text-content-muted">
          <span aria-hidden className="mt-0.5 shrink-0 text-content-disabled">
            ▪
          </span>
          <span>{reason}</span>
        </li>
      ))}
    </ul>
  );
}

export function LoadError({
  message,
  onRetry,
  title = "This panel could not be loaded",
}: {
  message: string;
  onRetry?: () => void;
  title?: string;
}) {
  return (
    <Alert
      tone="danger"
      title={title}
      actions={
        onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md border border-danger-border bg-surface-raised px-2.5 py-1 text-meta font-medium text-content hover:bg-surface-hover"
          >
            Retry
          </button>
        ) : undefined
      }
    >
      {message}
    </Alert>
  );
}

export function LoadingBlock({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

/** A label/value row inside a drawer. */
export function Row({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <dt className="shrink-0 text-meta text-content-subtle">{label}</dt>
      <dd className="min-w-0 text-right text-meta text-content">
        <div>{children}</div>
        {hint ? <div className="text-2xs text-content-subtle">{hint}</div> : null}
      </dd>
    </div>
  );
}

/**
 * A money figure bucketed by currency. This component exists so that no page
 * anywhere in the workspace can accidentally render a cross-currency total:
 * it takes buckets, never a scalar.
 */
export function CurrencyBuckets({
  buckets,
  render,
  empty = "Nothing recorded.",
  className,
}: {
  buckets: ReadonlyArray<{ currency: string }>;
  render: (bucket: never) => ReactNode;
  empty?: string;
  className?: string;
}) {
  if (buckets.length === 0) {
    return <div className={cx("text-meta text-content-subtle", className)}>{empty}</div>;
  }
  return (
    <div className={cx("flex flex-wrap gap-2", className)}>
      {buckets.map((b) => (
        <span
          key={b.currency}
          className="rounded-md border border-border bg-surface-raised px-2.5 py-1 text-meta text-content-muted"
        >
          <span className="font-semibold text-content">{b.currency}</span> {render(b as never)}
        </span>
      ))}
      {buckets.length > 1 ? (
        <span className="self-center text-2xs text-content-subtle">
          Bucketed by currency; never summed across.
        </span>
      ) : null}
    </div>
  );
}

/** The engine's own explanation, printed verbatim next to the figure. */
export function Basis({ lines, title = "Basis" }: { lines: readonly string[]; title?: string }) {
  if (lines.length === 0) return null;
  return (
    <div className="rounded-md border border-border bg-surface-sunken p-3">
      <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">{title}</div>
      <ol className="space-y-1">
        {lines.map((line, i) => (
          <li key={i} className="text-meta text-content">
            {line}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function BreachBadge({ breached, by, currency }: { breached: boolean; by: number; currency: string }) {
  if (!breached) return <Badge tone="success" size="xs">Within</Badge>;
  return (
    <Badge tone="danger" size="xs" dot>
      Over by {moneyShort(by, currency)}
    </Badge>
  );
}

/* ================================= Hooks ================================== */

/** One mutation at a time, with its refusal printed rather than swallowed. */
export function useAction(): {
  busy: string | null;
  error: string | null;
  clear: () => void;
  run: <T>(key: string, fn: () => Promise<T>) => Promise<T | null>;
} {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(key);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(errorMessage(err));
      return null;
    } finally {
      setBusy(null);
    }
  }, []);
  const clear = useCallback(() => setError(null), []);
  return { busy, error, clear, run };
}

/* =============================== API client =============================== */

const P = "/api/v1/portfolio";

export const portfolioApi = {
  /* company: money authority */
  createSource: (body: Record<string, unknown>) => api.post<FundingSource>(`${P}/funding-sources`, body),
  patchSource: (id: string, body: Record<string, unknown>) =>
    api.patch<FundingSource>(`${P}/funding-sources/${id}`, body),
  setSourceStatus: (id: string, status: string, reason?: string) =>
    api.post<FundingSource>(`${P}/funding-sources/${id}/status`, { status, reason }),
  deleteSource: (id: string) => api.del<void>(`${P}/funding-sources/${id}`),

  createAppropriation: (body: Record<string, unknown>) =>
    api.post<Appropriation>(`${P}/appropriations`, body),
  patchAppropriation: (id: string, body: Record<string, unknown>) =>
    api.patch<Appropriation>(`${P}/appropriations/${id}`, body),
  approveAppropriation: (id: string) => api.post<Appropriation>(`${P}/appropriations/${id}/approve`, {}),
  closeAppropriation: (id: string, body: Record<string, unknown>) =>
    api.post<{ appropriation: Appropriation; carriedForward: number; lapsed: number; unspent: number }>(
      `${P}/appropriations/${id}/close`,
      body,
    ),

  createVirement: (body: Record<string, unknown>) => api.post<Virement>(`${P}/virements`, body),
  decideVirement: (id: string, body: Record<string, unknown>) =>
    api.post<Virement>(`${P}/virements/${id}/decide`, body),

  createAllocation: (body: Record<string, unknown>) => api.post<Allocation>(`${P}/allocations`, body),
  patchAllocation: (id: string, body: Record<string, unknown>) =>
    api.patch<Allocation>(`${P}/allocations/${id}`, body),
  approveAllocation: (id: string) => api.post<Allocation>(`${P}/allocations/${id}/approve`, {}),
  drawAllocation: (id: string, body: Record<string, unknown>) =>
    api.post<Allocation>(`${P}/allocations/${id}/draw`, body),
  cancelAllocation: (id: string, reason: string) =>
    api.post<Allocation>(`${P}/allocations/${id}/cancel`, { reason }),

  createEnvelope: (body: Record<string, unknown>) => api.post<Envelope>(`${P}/envelopes`, body),
  patchEnvelope: (id: string, body: Record<string, unknown>) =>
    api.patch<Envelope>(`${P}/envelopes/${id}`, body),
  activateEnvelope: (id: string) => api.post<Envelope>(`${P}/envelopes/${id}/activate`, {}),

  /* company: prioritisation */
  createModel: (body: Record<string, unknown>) => api.post<ScoringModel>(`${P}/scoring-models`, body),
  patchModel: (id: string, body: Record<string, unknown>) =>
    api.patch<ScoringModel>(`${P}/scoring-models/${id}`, body),
  setModelStatus: (id: string, status: string) =>
    api.post<ScoringModel>(`${P}/scoring-models/${id}/status`, { status }),
  putScores: (modelId: string, projectId: string, body: Record<string, unknown>) =>
    api.put<unknown>(`${P}/scoring-models/${modelId}/scores/${projectId}`, body),
  deleteScores: (modelId: string, projectId: string) =>
    api.del<void>(`${P}/scoring-models/${modelId}/scores/${projectId}`),

  /* company: buying structures */
  createFramework: (body: Record<string, unknown>) => api.post<Framework>(`${P}/frameworks`, body),
  patchFramework: (id: string, body: Record<string, unknown>) =>
    api.patch<Framework>(`${P}/frameworks/${id}`, body),
  setFrameworkStatus: (id: string, status: string, reason?: string) =>
    api.post<Framework>(`${P}/frameworks/${id}/status`, { status, reason }),
  deleteFramework: (id: string) => api.del<void>(`${P}/frameworks/${id}`),
  createLot: (frameworkId: string, body: Record<string, unknown>) =>
    api.post<FrameworkLot>(`${P}/frameworks/${frameworkId}/lots`, body),
  patchLot: (frameworkId: string, lotId: string, body: Record<string, unknown>) =>
    api.patch<FrameworkLot>(`${P}/frameworks/${frameworkId}/lots/${lotId}`, body),
  addSupplier: (frameworkId: string, body: Record<string, unknown>) =>
    api.post<FrameworkSupplier>(`${P}/frameworks/${frameworkId}/suppliers`, body),
  patchSupplier: (frameworkId: string, supplierId: string, body: Record<string, unknown>) =>
    api.patch<FrameworkSupplier>(`${P}/frameworks/${frameworkId}/suppliers/${supplierId}`, body),
  directAwardCheck: (frameworkId: string, body: Record<string, unknown>) =>
    api.post<{ permitted: boolean; reasons: string[] }>(
      `${P}/frameworks/${frameworkId}/direct-award-check`,
      body,
    ),

  createCompetition: (body: Record<string, unknown>) =>
    api.post<MiniCompetition>(`${P}/mini-competitions`, body),
  patchCompetition: (id: string, body: Record<string, unknown>) =>
    api.patch<MiniCompetition>(`${P}/mini-competitions/${id}`, body),
  issueCompetition: (id: string) => api.post<MiniCompetition>(`${P}/mini-competitions/${id}/issue`, {}),
  recordResponse: (id: string, body: Record<string, unknown>) =>
    api.post<{ competition: MiniCompetition; evaluation: MiniCompetitionEvaluation }>(
      `${P}/mini-competitions/${id}/responses`,
      body,
    ),
  awardCompetition: (id: string, body: Record<string, unknown>) =>
    api.post<{
      competition: MiniCompetition;
      evaluation: MiniCompetitionEvaluation;
      awardedAgainstIndication: boolean;
    }>(`${P}/mini-competitions/${id}/award`, body),
  cancelCompetition: (id: string, body: Record<string, unknown>) =>
    api.post<MiniCompetition>(`${P}/mini-competitions/${id}/cancel`, body),

  createTermContract: (body: Record<string, unknown>) => api.post<TermContract>(`${P}/term-contracts`, body),
  patchTermContract: (id: string, body: Record<string, unknown>) =>
    api.patch<TermContract>(`${P}/term-contracts/${id}`, body),
  addRates: (id: string, body: Record<string, unknown>) =>
    api.post<{ items: SorItem[]; total: number }>(`${P}/term-contracts/${id}/rates`, body),
  patchRate: (id: string, itemId: string, body: Record<string, unknown>) =>
    api.patch<SorItem>(`${P}/term-contracts/${id}/rates/${itemId}`, body),
  priceLines: (id: string, lines: unknown[]) =>
    api.post<PricedOrder>(`${P}/term-contracts/${id}/price`, { lines }),

  runSweeps: () => api.post<SweepResult>(`${P}/sweeps/run`, {}),
};

/** Project-scoped calls. */
export function projectApi(projectId: string) {
  const B = `/api/v1/projects/${projectId}/portfolio`;
  return {
    createCallOff: (body: Record<string, unknown>) => api.post<CallOff>(`${B}/call-offs`, body),
    patchCallOff: (id: string, body: Record<string, unknown>) =>
      api.patch<CallOff>(`${B}/call-offs/${id}`, body),
    issueCallOff: (id: string) => api.post<CallOff>(`${B}/call-offs/${id}/issue`, {}),
    certifyCallOff: (id: string, body: Record<string, unknown>) =>
      api.post<CallOff>(`${B}/call-offs/${id}/certify`, body),
    completeCallOff: (id: string) => api.post<CallOff>(`${B}/call-offs/${id}/complete`, {}),
    cancelCallOff: (id: string, reason: string) =>
      api.post<CallOff>(`${B}/call-offs/${id}/cancel`, { reason }),

    createVenture: (body: Record<string, unknown>) => api.post<Venture>(`${B}/ventures`, body),
    patchVenture: (id: string, body: Record<string, unknown>) =>
      api.patch<Venture>(`${B}/ventures/${id}`, body),
    addPartner: (jvId: string, body: Record<string, unknown>) =>
      api.post<{ partner: JvPartner; summary: VentureSummary }>(`${B}/ventures/${jvId}/partners`, body),
    patchPartner: (jvId: string, partnerId: string, body: Record<string, unknown>) =>
      api.patch<{ partner: JvPartner; summary: VentureSummary }>(
        `${B}/ventures/${jvId}/partners/${partnerId}`,
        body,
      ),
    createTransaction: (jvId: string, body: Record<string, unknown>) =>
      api.post<JvTransaction>(`${B}/ventures/${jvId}/transactions`, body),
    callTransaction: (jvId: string, txId: string, body: Record<string, unknown>) =>
      api.post<JvTransaction>(`${B}/ventures/${jvId}/transactions/${txId}/call`, body),
    settleTransaction: (jvId: string, txId: string, body: Record<string, unknown>) =>
      api.post<JvTransaction>(`${B}/ventures/${jvId}/transactions/${txId}/settle`, body),
    waiveTransaction: (jvId: string, txId: string, body: Record<string, unknown>) =>
      api.post<JvTransaction>(`${B}/ventures/${jvId}/transactions/${txId}/waive`, body),
    previewVote: (jvId: string, body: Record<string, unknown>) =>
      api.post<DecisionOutcome>(`${B}/ventures/${jvId}/decisions/preview`, body),
    recordDecision: (jvId: string, body: Record<string, unknown>) =>
      api.post<{ decision: JvDecision; computed: DecisionOutcome }>(
        `${B}/ventures/${jvId}/decisions`,
        body,
      ),

    createTargetCost: (body: Record<string, unknown>) => api.post<TargetCost>(`${B}/target-costs`, body),
    patchTargetCost: (id: string, body: Record<string, unknown>) =>
      api.patch<TargetCost>(`${B}/target-costs/${id}`, body),
    setTargetCostStatus: (id: string, body: Record<string, unknown>) =>
      api.post<TargetCost>(`${B}/target-costs/${id}/status`, body),
    calculate: (id: string, body: Record<string, unknown>) =>
      api.post<{
        frozen: boolean;
        result: PainGainOutput;
        calculation?: PainGainCalculation;
        reason?: string;
      }>(`${B}/target-costs/${id}/calculate`, body),

    createVerification: (body: Record<string, unknown>) => api.post<Verification>(`${B}/verifications`, body),
    patchVerification: (id: string, body: Record<string, unknown>) =>
      api.patch<Verification>(`${B}/verifications/${id}`, body),
    setVerificationStatus: (id: string, body: Record<string, unknown>) =>
      api.post<Verification>(`${B}/verifications/${id}/status`, body),
    addItems: (id: string, body: Record<string, unknown>) =>
      api.post<{ items: DefinedCostItem[]; totals: VerificationTotals }>(
        `${B}/verifications/${id}/items`,
        body,
      ),
    setVerdict: (id: string, itemId: string, body: Record<string, unknown>) =>
      api.post<{ item: DefinedCostItem; disallowedCostId: string | null; totals: VerificationTotals }>(
        `${B}/verifications/${id}/items/${itemId}/verdict`,
        body,
      ),
    deleteItem: (id: string, itemId: string) => api.del<void>(`${B}/verifications/${id}/items/${itemId}`),

    createDisallowed: (body: Record<string, unknown>) =>
      api.post<DisallowedCost>(`${B}/disallowed-costs`, body),
    respondDisallowed: (id: string, body: Record<string, unknown>) =>
      api.post<DisallowedCost>(`${B}/disallowed-costs/${id}/respond`, body),
    resolveDisallowed: (id: string, body: Record<string, unknown>) =>
      api.post<DisallowedCost>(`${B}/disallowed-costs/${id}/resolve`, body),

    createAudit: (body: Record<string, unknown>) => api.post<AuditRights>(`${B}/audit-rights`, body),
    patchAudit: (id: string, body: Record<string, unknown>) =>
      api.patch<AuditRights>(`${B}/audit-rights/${id}`, body),
    setAuditStatus: (id: string, body: Record<string, unknown>) =>
      api.post<AuditRights>(`${B}/audit-rights/${id}/status`, body),
  };
}

/* ============================== Vocabulary =============================== */

export const FUNDING_KINDS = [
  "internal_capital",
  "government_grant",
  "loan",
  "bond",
  "equity",
  "dfi",
  "developer_contribution",
  "insurance_proceeds",
  "operating_revenue",
  "other",
];

export const EXPENDITURE_CLASSES = ["capital", "revenue", "mixed", "unclassified"];
export const CARRY_FORWARD_POLICIES = ["carry_forward", "lapse", "request"];
export const AWARD_MODES = ["direct_award", "mini_competition", "ranked_cascade", "direct_or_mini"];
export const CALL_OFF_ROUTES = ["direct_award", "mini_competition", "term_contract", "measured_term"];
export const JV_STRUCTURES = ["joint_venture", "consortium", "spv", "alliance", "partnership"];
export const JV_PARTNER_ROLES = ["lead", "partner", "sponsor", "silent", "technical", "financial"];
export const JV_LIABILITY_BASES = ["several", "joint_and_several", "limited"];
export const JV_TRANSACTION_KINDS = [
  "capital_contribution",
  "capital_call",
  "working_capital_advance",
  "distribution",
  "profit_share",
  "loss_share",
  "management_fee",
  "expense_reimbursement",
  "guarantee_call",
];
export const JV_DECISION_TYPES = ["reserved_matter", "ordinary", "board_resolution", "written_resolution"];
export const PAIN_GAIN_MECHANISMS = ["banded_share", "flat_share", "capped_share"];
export const DEFINED_COST_COMPONENTS = [
  "people",
  "equipment",
  "plant_and_materials",
  "subcontractors",
  "charges",
  "manufacture_and_fabrication",
  "design",
  "insurance",
  "overhead_and_profit",
  "other",
];
export const DEFINED_COST_VERDICTS = [
  "pending",
  "verified",
  "queried",
  "partially_disallowed",
  "disallowed",
];
export const DISALLOWED_CATEGORIES = [
  "not_defined_cost",
  "not_reasonably_incurred",
  "outside_accepted_programme",
  "contractor_default",
  "correcting_defect",
  "insufficient_records",
  "plant_not_used",
  "duplicate_claim",
  "rate_not_in_sor",
  "resource_not_on_site",
  "other",
];
export const AUDIT_SUBJECT_TYPES = ["commitment", "framework", "term_contract", "jv", "project"];

export interface ProjectLite {
  id: string;
  name: string;
  stage?: string;
  currency?: string;
}

export function useProjects(): Loadable<Paginated<ProjectLite>> {
  return useResource<Paginated<ProjectLite>>("/api/v1/projects?page=1&pageSize=200");
}

export interface VendorLite {
  id: string;
  name: string;
}

export function useVendors(): Loadable<Paginated<VendorLite>> {
  return useResource<Paginated<VendorLite>>("/api/v1/vendors?page=1&pageSize=200");
}
