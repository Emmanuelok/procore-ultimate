/**
 * The wire shapes of apps/api/src/modules/bidding/**, transcribed.
 *
 * Two of them carry the module's whole discipline and are worth reading before
 * anything else:
 *
 *   `Unknowable<T>`   `{ value: T | null, reasons: string[] }` — the platform's
 *                     null contract, identical to the benchmarks metric shape.
 *                     A null here is NOT a zero and must never render as one.
 *
 *   `SealState`       the sealed-bid control. While `amountsWithheld` is true
 *                     every price on every read path comes back null WITH THE
 *                     KEY RETAINED, so "withheld" and "zero" are distinguishable
 *                     in the payload — and must stay distinguishable on screen.
 */

/* ================================================================== */
/* Primitives                                                          */
/* ================================================================== */

export interface Unknowable<T = number> {
  value: T | null;
  reasons: string[];
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ListResponse<T> {
  items: T[];
  total: number;
}

/* ================================================================== */
/* The seal                                                            */
/* ================================================================== */

export interface SealState {
  isSealed: boolean;
  isOpened: boolean;
  /** the instant the seal is due to lift: sealedUntil ?? bidDueAt */
  opensAt: string | null;
  mayOpenNow: boolean;
  requiresWitness: boolean;
  openedAt: string | null;
  openedBy: string | null;
  witnessedBy: string | null;
  /** TRUE while submitted amounts must not leave the building */
  amountsWithheld: boolean;
  /** always populated — the server's own sentence about the position */
  note: string;
}

/* ================================================================== */
/* Packages                                                            */
/* ================================================================== */

export interface Timetable {
  issuedAt: string | null;
  questionsDueAt: string | null;
  questionsClosed: boolean | null;
  bidDueAt: string | null;
  bidsClosed: boolean | null;
  hoursToBidDue: number | null;
  bidValidityDays: number | null;
  siteVisitAt: string | null;
  isSiteVisitMandatory: boolean;
  anticipatedAwardDate: string | null;
  anticipatedStartDate: string | null;
  anticipatedCompletionDate: string | null;
}

export interface BondRequirement {
  bondType: string;
  percent?: number | null;
  amount?: number | null;
  required?: boolean;
  note?: string | null;
}

export interface InsuranceRequirement {
  policyType: string;
  limit?: number | null;
  currency?: string;
  required?: boolean;
  note?: string | null;
}

export interface PackageRequirements {
  bonds: BondRequirement[];
  insurance: InsuranceRequirement[];
  prequalification: {
    required: boolean;
    questionnaireId: string | null;
    strictness: string;
  };
  retentionPercent: number | null;
  paymentTermsDays: number | null;
}

export interface EvaluationCriterion {
  key: string;
  label: string;
  weight: number;
  kind: "price" | "quality";
  guidance?: string | null;
}

export interface BidPackage {
  id: string;
  companyId: string;
  projectId: string;
  number: number;
  reference: string;
  title: string;
  scopeDescription: string | null;
  packageKind: string;
  procurementRoute: string;
  tradeCode: string | null;
  csiDivision: string | null;
  estimatedValue: number | null;
  engineersEstimate: number | null;
  currency: string;
  status: string;
  bidDueAt: string | null;
  sealedUntil: string | null;
  isSealed: number;
  evaluationMethod: string;
  evaluationCriteria: EvaluationCriterion[];
  priceWeight: number | null;
  qualityWeight: number | null;
  prequalificationRequired: number;
  prequalificationQuestionnaireId: string | null;
  invitationCount: number;
  submissionCount: number;
  declineCount: number;
  addendaCount: number;
  awardedVendorId: string | null;
  awardedAmount: number | null;
  awardedAt: string | null;
  cancelledReason: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  issuedAt: string | null;
  openedAt: string | null;
  openedBy: string | null;
  witnessedBy: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  detail: Record<string, unknown>;
  /* decorations added by the route */
  seal: SealState;
  timetable: Timetable;
  requirements: PackageRequirements;
}

export interface Addendum {
  reference: string;
  description: string;
  fileIds: string[];
  issuedAt: string;
  issuedBy: string;
  requiresAcknowledgement: boolean;
  previousBidDueAt: string | null;
  newBidDueAt: string | null;
  acknowledgedBy?: string[];
  outstandingFrom?: string[];
}

export interface PackageDetail extends BidPackage {
  addenda: Addendum[];
  counts: {
    invitations: number;
    submissions: number;
    declines: number;
    addenda: number;
    levellingItems: number;
  };
  submissions: BidSubmission[];
  market: {
    lowest: Unknowable;
    median: Unknowable;
    againstEstimatePercent: Unknowable;
  };
  awards: BidAwardRow[];
}

/* ================================================================== */
/* Invitations                                                         */
/* ================================================================== */

export interface PrequalFlag {
  state: PrequalState;
  reference?: string | null;
  expiresAt: string | null;
  daysToExpiry?: number | null;
  singleProjectLimit?: number | null;
  currency?: string | null;
  ok?: boolean;
  /** populated whenever this vendor's standing is not clean */
  flag?: string | null;
  note: string;
}

export interface LimitCheck {
  exceeds: boolean | null;
  contractValue: number;
  contractCurrency: string;
  limit: number | null;
  limitCurrency: string | null;
  ratio: number | null;
  severity: "none" | "info" | "warning" | "critical";
  message: string;
}

export interface BidInvitation {
  id: string;
  packageId: string;
  projectId: string;
  vendorId: string;
  vendorName: string | null;
  contactName: string | null;
  contactEmail: string | null;
  status: string;
  invitedAt: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  bounceReason: string | null;
  viewedAt: string | null;
  firstDownloadAt: string | null;
  downloadCount: number;
  respondedAt: string | null;
  intentToBid: boolean;
  declineReason: string | null;
  declineNote: string | null;
  remindersSent: number;
  lastReminderAt: string | null;
  isPrequalified: boolean;
  attendedSiteVisit: boolean;
  portalAccessIssued: boolean;
  submissionId: string | null;
  disqualifiedReason: string | null;
  createdAt: string;
  prequalification: PrequalFlag;
  capacity: LimitCheck;
  outstandingAddenda: string[];
  engagement: {
    sent: boolean;
    delivered: boolean;
    viewed: boolean;
    downloaded: boolean;
    responded: boolean;
    silent: boolean;
    remindersSent: number;
  };
}

export interface InvitationList extends Paginated<BidInvitation> {
  summary: { flagged: number; declined: number; silent: number };
}

/* ================================================================== */
/* Submissions                                                         */
/* ================================================================== */

export interface BidSubmission {
  id: string;
  packageId: string;
  projectId: string;
  vendorId: string;
  vendorName?: string | null;
  reference: string;
  revision: number;
  status: string;
  submittedAt: string | null;
  receivedAt: string | null;
  isLate: number;
  lateByMinutes: number | null;
  lateAcceptedBy: string | null;
  lateAcceptanceReason: string | null;
  /** null while the seal holds — see `sealed` / `withheldFields` */
  baseBidAmount: number | null;
  alternatesTotal: number | null;
  allowancesTotal: number | null;
  provisionalSumsTotal: number | null;
  totalAmount: number | null;
  normalisedAmount: number | null;
  commercialScore: number | null;
  technicalScore: number | null;
  totalScore: number | null;
  rank: number | null;
  currency: string;
  exclusions: string | null;
  qualifications: string | null;
  complianceStatus: string;
  nonComplianceNote: string | null;
  evaluationNote: string | null;
  levellingCompletedAt: string | null;
  lineCount: number;
  sealedSha256: string | null;
  openedAt: string | null;
  createdAt: string;
  detail: Record<string, unknown>;
  /* the seal decoration, present on every read path */
  sealed: boolean;
  sealNote: string | null;
  withheldFields: string[];
}

export interface SubmissionDetail extends BidSubmission {
  packageReference: string;
  lateness: {
    isLate: boolean;
    lateByMinutes: number | null;
    accepted: boolean;
    acceptedBy: string | null;
    acceptanceReason: string | null;
    note: string;
  };
  prequalification: PrequalFlag;
  capacity: LimitCheck | null;
  seal: SealState;
}

export interface SubmissionList extends Paginated<BidSubmission> {
  seal: SealState;
}

/* ================================================================== */
/* Levelling — the analytical core                                     */
/* ================================================================== */

export type LevellingInclusion =
  | "included"
  | "excluded"
  | "partially_included"
  | "unclear"
  | "not_priced";

export interface LevellingItem {
  id: string;
  packageId: string;
  position: number;
  itemCode: string | null;
  description: string;
  category: string;
  unit: string | null;
  estimatedQuantity: number | null;
  engineersEstimate: number | null;
  currency: string;
  isMandatory: boolean;
  notes: string | null;
}

export interface LevelledCell {
  levellingItemId: string;
  submissionId: string;
  itemCode: string | null;
  description: string;
  category: string;
  isMandatory: boolean;
  includedStatus: LevellingInclusion;
  asBidAmount: number | null;
  adjustmentAmount: number;
  adjustmentReason: string | null;
  currency: string;
  /** the like-for-like figure, or null with reasons — never a fabricated 0 */
  levelledAmount: number | null;
  reasons: string[];
  /** false for exclusion_check rows, which carry no money by design */
  priceable: boolean;
  covered: boolean;
}

export interface SubmissionLevelling {
  submissionId: string;
  currency: string | null;
  cells: LevelledCell[];
  itemsCovered: number;
  itemsTotal: number;
  mandatoryCovered: number;
  mandatoryTotal: number;
  gaps: Array<{
    levellingItemId: string;
    itemCode: string | null;
    description: string;
    isMandatory: boolean;
    reason: string;
  }>;
  asBidSubtotal: Unknowable;
  adjustmentSubtotal: Unknowable;
  pricedSubtotal: Unknowable;
  levelledTotal: Unknowable;
}

export interface CoverageRow {
  levellingItemId: string;
  itemCode: string | null;
  description: string;
  category: string;
  isMandatory: boolean;
  engineersEstimate: number | null;
  coveredBy: string[];
  missingFrom: string[];
}

export interface ComparisonSubmission {
  id: string;
  vendorId: string;
  vendorName: string | null;
  reference: string;
  status: string;
  currency: string;
  totalAmount: number | null;
  inContention: boolean;
}

export interface LevellingGrid {
  seal: SealState;
  sealed: boolean;
  note?: string;
  package?: {
    id: string;
    reference: string;
    currency: string;
    engineersEstimate: number | null;
    levelledAt: string | null;
  };
  items: Array<{
    id: string;
    itemCode: string | null;
    description: string;
    category: string;
    isMandatory: boolean;
    engineersEstimate: number | null;
    currency: string;
  }>;
  submissions: ComparisonSubmission[];
  grid?: SubmissionLevelling[];
  coverage?: CoverageRow[];
  ranking: Array<{ submissionId: string; levelledAmount: number; rank: number }> | null;
  complete?: boolean;
  blockers?: string[];
  currencies?: string[];
}

/* ================================================================== */
/* Scoring                                                             */
/* ================================================================== */

export interface ScoredCriterion {
  key: string;
  label: string;
  kind: "price" | "quality";
  weight: number;
  score: number | null;
  maxScore: number | null;
  normalised: number | null;
  /** null — NEVER 0 — for a criterion nobody scored */
  weighted: number | null;
  missing: boolean;
  note: string | null;
}

export interface SubmissionScoring {
  submissionId: string;
  reference: string;
  vendorId: string;
  vendorName: string | null;
  priceBasis: "levelled" | "as_bid" | "none";
  priceAmount: number | null;
  priceScore: Unknowable;
  inContention: boolean;
  criteria: ScoredCriterion[];
  commercialScore: Unknowable;
  technicalScore: Unknowable;
  totalScore: Unknowable;
  reasons: string[];
}

export interface ScoringResponse {
  seal: SealState;
  sealed: boolean;
  note?: string;
  criteria: EvaluationCriterion[];
  priceWeight?: number | null;
  qualityWeight?: number | null;
  rows: SubmissionScoring[];
  ranked: Array<{
    submissionId: string;
    totalScore: number | null;
    rank: number | null;
    reasons: string[];
  }>;
  currencies?: string[];
  notes?: string[];
}

/* ================================================================== */
/* Awards                                                              */
/* ================================================================== */

export interface AwardCandidate {
  submissionId: string;
  reference: string;
  vendorId: string;
  comparableAmount: number | null;
  asBidAmount: number | null;
  currency: string;
  totalScore: number | null;
  rank: number | null;
}

export interface AwardComparison {
  basis: "levelled" | "as_bid";
  basisNote: string;
  candidates: AwardCandidate[];
  lowest: AwardCandidate | null;
  currency: string;
}

export interface BidAwardRow {
  id: string;
  packageId: string;
  projectId: string;
  submissionId: string;
  vendorId: string;
  number: number;
  reference: string;
  awardAmount: number;
  currency: string;
  scopeSummary: string | null;
  status: string;
  recommendationBasis: string | null;
  evaluationSummary: unknown[];
  isLowestBid: number | boolean;
  notLowestJustification: string | null;
  lowestBidAmount: number | null;
  savingAgainstEstimate: number | null;
  recommendedBy: string | null;
  recommendedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  approvalAuthority: string | null;
  rejectedReason: string | null;
  letterOfIntentAt: string | null;
  letterOfIntentCap: number | null;
  commitmentId: string | null;
  contractIssuedAt: string | null;
  executedAt: string | null;
  unsuccessfulNotifiedAt: string | null;
  standstillEndsAt: string | null;
  debriefProvidedAt: string | null;
  challengeReceived: number;
  challengeNote: string | null;
  createdBy: string;
  createdAt: string;
  detail: Record<string, unknown>;
}

export interface BidAward extends BidAwardRow {
  vendorName: string | null;
  packageReference: string;
  standstill: { endsAt: string | null; active: boolean; note: string };
  commitment: { id: string; reference?: string; status?: string } | null;
  prequalification: { state: PrequalState; expiresAt: string | null; note: string };
  audit: {
    recommendedBy: string | null;
    recommendedAt: string | null;
    approvedBy: string | null;
    approvedAt: string | null;
    segregated: boolean;
    isLowestBid: boolean;
    lowestBidAmount: number | null;
    notLowestJustification: string | null;
    comparisonBasis: unknown;
    recommendationBasis: string | null;
    savingAgainstEstimate: number | null;
    engineersEstimate: number | null;
    evaluationSummary: unknown[];
    unsuccessfulNotifiedAt: string | null;
    standstillEndsAt: string | null;
    commitmentId: string | null;
  };
  comparison?: AwardComparison;
  warnings?: string[];
}

/* ================================================================== */
/* Tabulation                                                          */
/* ================================================================== */

export interface TabulationRow extends BidSubmission {
  vendorName: string | null;
  prequalification: { state: PrequalState; expiresAt: string | null; note: string };
  capacity: LimitCheck | null;
}

export interface Tabulation {
  package: {
    id: string;
    reference: string;
    title: string;
    currency: string;
    engineersEstimate: number | null;
    evaluationMethod: string;
    status: string;
  };
  seal: SealState;
  asOf: string;
  rows: TabulationRow[];
  market: { lowest: Unknowable; median: Unknowable; againstEstimatePercent: Unknowable };
}

/* ================================================================== */
/* Prequalification                                                    */
/* ================================================================== */

export type PrequalState =
  | "approved"
  | "expiring"
  | "lapsed"
  | "suspended"
  | "rejected"
  | "in_progress"
  | "none";

export interface Questionnaire {
  id: string;
  companyId: string;
  projectId: string | null;
  number: number;
  reference: string;
  name: string;
  description: string | null;
  version: number;
  status: string;
  tradeScope: string[];
  categories: string[];
  questionCount: number;
  maxScore: number | null;
  passThreshold: number | null;
  validityMonths: number | null;
  requiresAnnualRefresh: number;
  approvalAuthority: string | null;
  approvedBy: string | null;
  createdAt: string;
}

export interface QuestionnaireQuestion {
  id: string;
  questionnaireId: string;
  section: string | null;
  position: number;
  questionCode: string | null;
  text: string;
  category: string;
  itemType: string;
  required: boolean;
  options: string[];
  minValue: number | null;
  maxValue: number | null;
  unit: string | null;
  weight: number;
  maxScore: number | null;
  scoringGuidance: string | null;
  isKnockout: boolean;
  knockoutValue: string | null;
  evidenceRequired: boolean | number;
  evidenceKinds: string[];
  guidance: string | null;
  response?: PrequalResponse | null;
}

export interface QuestionnaireDetail extends Questionnaire {
  questions: QuestionnaireQuestion[];
  knockoutQuestions: Array<{
    id: string;
    questionCode: string | null;
    text: string;
    knockoutValue: string | null;
  }>;
}

export interface PrequalResponse {
  id: string;
  questionId: string;
  questionCode: string | null;
  questionText: string;
  category: string;
  itemType: string;
  response: string | null;
  numericValue: number | null;
  selectedOptions: string[];
  fileIds: string[];
  score: number | null;
  maxScore: number | null;
  isKnockoutFail: number;
  assessorNote: string | null;
}

export interface PrequalSubmission {
  id: string;
  companyId: string;
  projectId: string | null;
  questionnaireId: string;
  vendorId: string;
  number: number;
  reference: string;
  status: string;
  invitedAt: string | null;
  submittedAt: string | null;
  submittedByName: string | null;
  overallScore: number | null;
  maxScore: number | null;
  scorePercent: number | null;
  categoryScores: Array<{
    category: string;
    score: number | null;
    maxScore: number;
    percent: number | null;
  }>;
  knockoutFailed: boolean;
  knockoutReason: string | null;
  outcome: string;
  conditions: string | null;
  singleProjectLimit: number | null;
  aggregateLimit: number | null;
  currency: string;
  tradeScopeApproved: string[];
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedReason: string | null;
  validFrom: string | null;
  expiresAt: string | null;
  renewalDueAt: string | null;
  obligationId: string | null;
  signalId: string | null;
  suspendedReason: string | null;
  createdBy: string;
  createdAt: string;
  detail: Record<string, unknown>;
}

export interface PrequalSubmissionDetail extends PrequalSubmission {
  questionnaire: {
    id: string;
    reference: string;
    name: string;
    passThreshold: number | null;
    validityMonths: number | null;
    questionCount: number;
  };
  questions: QuestionnaireQuestion[];
  responses: PrequalResponse[];
  financials: FinancialRecord[];
  screening: RecommendedLimit | null;
  standing: {
    state: PrequalState;
    daysToExpiry: number | null;
    note: string;
    renewalWindowDays: number;
  };
  assessment?: {
    overallScore: Unknowable;
    maxScore: Unknowable;
    scorePercent: Unknowable;
    categoryScores: Array<{
      category: string;
      score: number | null;
      maxScore: number;
      percent: number | null;
    }>;
    unscored: Array<{ questionId: string; label: string }>;
  };
  knockout?: {
    failed: boolean;
    questionId: string | null;
    questionCode: string | null;
    reason: string | null;
  };
}

export interface PrequalSweep {
  lapsed: string[];
  renewalObligationsRaised: string[];
  signalsRaised: string[];
  notes: string[];
}

export interface PrequalSubmissionList extends Paginated<PrequalSubmission> {
  sweep: PrequalSweep;
}

/* ================================================================== */
/* Financial screening                                                 */
/* ================================================================== */

export interface DerivedRatios {
  workingCapital: Unknowable;
  currentRatio: Unknowable;
  acidTestRatio: Unknowable;
  gearingPercent: Unknowable;
  profitMarginPercent: Unknowable;
  returnOnCapitalPercent: Unknowable;
}

export interface LimitTest {
  key: "turnover" | "net_assets" | "track_record";
  label: string;
  value: number | null;
  detail: string;
}

export interface LimitFactor {
  key: "liquidity" | "gearing" | "provenance";
  factor: number;
  why: string;
}

export interface FinancialLimitRule {
  turnoverShare: number;
  netAssetsMultiple: number;
  trackRecordMultiple: number;
  minCurrentRatio: number;
  lowLiquidityFactor: number;
  maxGearingPercent: number;
  highGearingFactor: number;
  unverifiedSourceFactor: number;
  verifiedSources: string[];
}

export interface RecommendedLimit {
  /** the recommended cap on any ONE contract, or null with reasons */
  value: number | null;
  currency: string;
  /** the sentence a buyer can put in front of the vendor and an auditor */
  basis: string;
  bindingTest: LimitTest["key"] | "hard_stop" | null;
  tests: LimitTest[];
  factors: LimitFactor[];
  headroomBeforeFactors: number | null;
  reasons: string[];
  rule: FinancialLimitRule;
}

export interface FinancialRecord {
  id: string;
  vendorId: string;
  submissionId: string | null;
  financialYearEnd: string;
  periodLabel: string | null;
  periodMonths: number | null;
  source: string;
  currency: string;
  turnover: number | null;
  grossProfit: number | null;
  operatingProfit: number | null;
  profitBeforeTax: number | null;
  netAssets: number | null;
  currentAssets: number | null;
  currentLiabilities: number | null;
  cashAtBank: number | null;
  totalDebt: number | null;
  largestContractValue: number | null;
  orderBookValue: number | null;
  employeeCount: number | null;
  creditAgency: string | null;
  creditScore: number | null;
  creditRating: string | null;
  isGoingConcernQualified: boolean | number;
  auditorQualification: string | null;
  ccjCount: number | null;
  insolvencyEvents: Array<{ kind: string; date?: string | null; note?: string | null }>;
  verifiedBy: string | null;
  verifiedAt: string | null;
  createdBy: string;
  createdAt: string;
  ratios?: DerivedRatios;
  recommendedLimit?: RecommendedLimit;
}

export interface FinancialList extends Paginated<FinancialRecord> {
  rule: FinancialLimitRule;
}

export interface VendorStanding {
  vendorId: string;
  vendorName: string | null;
  submissionId: string | null;
  reference: string | null;
  questionnaireId: string | null;
  status: string | null;
  outcome: string | null;
  state: PrequalState;
  validFrom: string | null;
  expiresAt: string | null;
  daysToExpiry: number | null;
  singleProjectLimit: number | null;
  aggregateLimit: number | null;
  currency: string | null;
  tradeScopeApproved: string[];
  conditions: string | null;
  knockoutFailed: boolean;
  knockoutReason: string | null;
  recommendedLimit: RecommendedLimit | null;
  note: string;
  history?: PrequalSubmission[];
  financials?: FinancialRecord[];
  rule?: FinancialLimitRule;
}

export interface CapacityCheck {
  prequalification: VendorStanding;
  limitInUse: { limit: number | null; currency: string | null; basis: string | null };
  capacity: LimitCheck;
  contractToTurnover: Unknowable;
}

/* ================================================================== */
/* Directory                                                           */
/* ================================================================== */

export interface Vendor {
  id: string;
  name: string;
  status: string;
  tradeCodes?: string[];
}

export interface CompanyUser {
  id: string;
  name: string;
  email: string;
}
