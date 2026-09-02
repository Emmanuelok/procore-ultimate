/**
 * Wire shapes for the QUALITY workspace, transcribed from the API rather than
 * guessed: apps/api/src/modules/quality/* and packages/db/src/schema/quality.ts.
 *
 * Two conventions in the payloads are load-bearing and are typed literally
 * here rather than smoothed over:
 *
 *  - integer booleans. The schema stores `required`, `isCritical`,
 *    `isNotApplicable`, `photoRequired`, `isBackcharged` as 0/1 integers, and
 *    `checklist_responses.isPass` as 0/1/NULL where NULL means "the platform
 *    could not judge this". A `boolean` here would erase the third state.
 *  - `Figure`. Every computed number arrives as { value, unit, inputs,
 *    reasons } and `value` may be null with the reasons saying why. Nothing in
 *    this workspace unwraps it to a plain number.
 */

/* ================================================================== */
/* Envelopes                                                           */
/* ================================================================== */

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * A figure the platform declines to invent — the exact shape of
 * modules/benchmarks/metrics.ts. `value: null` plus `reasons` is a first-class
 * answer, never a zero.
 */
export interface Figure {
  value: number | null;
  unit: string;
  inputs: Record<string, unknown>;
  reasons: string[];
}

/** The hold-point state machine's verdict (modules/quality/holdPoints.ts). */
export interface Decision {
  allowed: boolean;
  reasons: string[];
  code?: string;
}

/* ================================================================== */
/* ITPs and their activities                                           */
/* ================================================================== */

export interface VerifyingParty {
  party: string;
  interventionPoint: string | null;
  vendorId: string | null;
  userId: string | null;
  name: string | null;
  email: string | null;
}

/** Where notice stands. `noticeExpiresAt: null` is never treated as "now". */
export interface NoticeStatus {
  served: boolean;
  servedAt: string | null;
  noticePeriodHours: number | null;
  noticeExpiresAt: string | null;
  noticeElapsed: boolean;
  reasons: string[];
}

export interface ItpActivity {
  id: string;
  companyId: string;
  projectId: string;
  itpId: string;
  position: number;
  activityCode: string | null;
  activity: string;
  description: string | null;
  specReference: string | null;
  specSectionId: string | null;
  drawingReference: string | null;
  drawingSheetId: string | null;
  acceptanceCriteria: string | null;
  testMethod: string | null;
  frequency: string | null;
  recordRequired: string | null;
  responsibleParty: string;
  interventionPoint: string;
  noticePeriodHours: number | null;
  verifyingParties: unknown[];
  status: string;
  plannedDate: string | null;
  notifiedAt: string | null;
  notifiedBy: string | null;
  notificationMethod: string | null;
  actualDate: string | null;
  releasedBy: string | null;
  releasedAt: string | null;
  releaseNote: string | null;
  waivedBy: string | null;
  waivedAt: string | null;
  waiverReason: string | null;
  checklistId: string | null;
  testRecordId: string | null;
  ncrId: string | null;
  scheduleActivityId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  /* --- decorations the API computes on every read --- */
  parsedVerifyingParties: VerifyingParty[];
  notice: NoticeStatus;
  mayProceed: Decision;
}

export interface HoldPointSummary {
  activityCount: number;
  holdPointCount: number;
  witnessPointCount: number;
  openHoldPointCount: number;
  overdueHoldPointIds: string[];
  blockingActivityIds: string[];
}

export interface Itp {
  id: string;
  number: number;
  reference: string;
  title: string;
  description: string | null;
  scopeOfWork: string | null;
  discipline: string | null;
  specSectionId: string | null;
  specSectionCode: string | null;
  workPackage: string | null;
  vendorId: string | null;
  commitmentId: string | null;
  locationId: string | null;
  revision: number;
  status: string;
  standardsReferences: string[];
  activityCount: number;
  holdPointCount: number;
  witnessPointCount: number;
  openHoldPointCount: number;
  submittedAt: string | null;
  submittedBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  approvalAuthority: string | null;
  approvalComments: string | null;
  effectiveFrom: string | null;
  supersedesId: string | null;
  supersededById: string | null;
  documentFileId: string | null;
  detail: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ItpDetail extends Itp {
  activities: ItpActivity[];
  holdPoints: HoldPointSummary;
}

export interface HoldPointPage extends Paged<ItpActivity> {
  summary: HoldPointSummary;
}

/* ================================================================== */
/* Checklists                                                          */
/* ================================================================== */

export interface ChecklistTemplate {
  id: string;
  projectId: string | null;
  reference: string;
  name: string;
  description: string | null;
  category: string;
  version: number;
  status: string;
  itemCount: number;
  scoringMethod: string;
  passThreshold: number | null;
  specSectionCode: string | null;
  appliesToTrades: string[];
  isStatutory: number;
  regulatoryBasis: string | null;
  requiredSignatures: unknown[];
  createdBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChecklistTemplateItem {
  id: string;
  templateId: string;
  section: string | null;
  position: number;
  itemNumber: string | null;
  text: string;
  itemType: string;
  required: number;
  options: string[];
  targetValue: number | null;
  minValue: number | null;
  maxValue: number | null;
  tolerancePlus: number | null;
  toleranceMinus: number | null;
  unit: string | null;
  acceptanceCriteria: string | null;
  guidance: string | null;
  specReference: string | null;
  photoRequired: number;
  weight: number;
  isCritical: number;
  isHoldPoint: number;
  raisesNcrOnFail: number;
  detail: Record<string, unknown>;
}

export interface TemplateDetail extends ChecklistTemplate {
  items: ChecklistTemplateItem[];
}

export interface ChecklistResponse {
  id: string;
  checklistId: string;
  templateItemId: string | null;
  itemNumber: string | null;
  position: number;
  questionText: string;
  itemType: string;
  response: string | null;
  numericValue: number | null;
  selectedOptions: string[];
  unit: string | null;
  /** 1 pass, 0 fail, null "not judgeable" — the third state is the point. */
  isPass: number | null;
  isNotApplicable: number;
  naReason: string | null;
  note: string | null;
  photoFileIds: string[];
  fileIds: string[];
  instrumentId: string | null;
  instrumentSerial: string | null;
  measuredAt: string | null;
  score: number | null;
  maxScore: number | null;
  ncrId: string | null;
  punchItemId: string | null;
  respondedBy: string | null;
  respondedAt: string | null;
  detail: Record<string, unknown>;
}

/** One item's verdict from the scoring engine (checklistItems.ts). */
export interface ItemEvaluation {
  itemId: string;
  isPass: boolean | null;
  judged: boolean;
  answered: boolean;
  notApplicable: boolean;
  score: number | null;
  maxScore: number | null;
  criticalFailure: boolean;
  reasons: string[];
}

export interface ChecklistScore {
  score: number | null;
  maxScore: number | null;
  scorePercent: number | null;
  result: string | null;
  answeredItemCount: number;
  judgedItemCount: number;
  failedItemCount: number;
  criticalFailureCount: number;
  notApplicableCount: number;
  unansweredRequiredItemIds: string[];
  failedItemIds: string[];
  criticalFailureItemIds: string[];
  evaluations: ItemEvaluation[];
  reasons: string[];
}

export interface Checklist {
  id: string;
  number: number;
  reference: string;
  templateId: string | null;
  templateVersion: number | null;
  title: string;
  category: string;
  status: string;
  locationId: string | null;
  locationText: string | null;
  assetId: string | null;
  equipmentId: string | null;
  itpId: string | null;
  itpActivityId: string | null;
  specSectionId: string | null;
  drawingSheetId: string | null;
  vendorId: string | null;
  commitmentId: string | null;
  scheduledFor: string | null;
  performedAt: string | null;
  performedBy: string | null;
  performedByName: string | null;
  result: string | null;
  score: number | null;
  maxScore: number | null;
  scorePercent: number | null;
  answeredItemCount: number;
  failedItemCount: number;
  criticalFailureCount: number;
  ncrCount: number;
  witnessedBy: string | null;
  witnessedByName: string | null;
  witnessedAt: string | null;
  signatureFileId: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  closedBy: string | null;
  closedAt: string | null;
  photoFileIds: string[];
  reportFileId: string | null;
  detail: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChecklistDetail extends Checklist {
  responses: ChecklistResponse[];
  template: ChecklistTemplate | null;
  scoring: ChecklistScore;
}

/* ================================================================== */
/* Non-conformance reports                                             */
/* ================================================================== */

export interface CorrectiveAction {
  id: string;
  number: number;
  reference: string;
  sourceType: string;
  sourceId: string;
  sourceReference: string | null;
  title: string;
  description: string | null;
  actionKind: string;
  hierarchyOfControl: string | null;
  priority: string;
  status: string;
  ownerId: string | null;
  ownerVendorId: string | null;
  ownerName: string | null;
  dueDate: string;
  completedAt: string | null;
  completedBy: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  effectivenessVerdict: string;
  costToImplement: number | null;
  currency: string | null;
}

export interface Ncr {
  id: string;
  number: number;
  reference: string;
  title: string;
  description: string;
  category: string;
  severity: string;
  status: string;
  sourceType: string;
  sourceId: string | null;
  checklistId: string | null;
  checklistResponseId: string | null;
  itpActivityId: string | null;
  testRecordId: string | null;
  deliveryId: string | null;
  raisedAgainstVendorId: string | null;
  commitmentId: string | null;
  raisedByOrganisation: string | null;
  specSectionId: string | null;
  specClauseRef: string | null;
  drawingSheetId: string | null;
  drawingReference: string | null;
  locationId: string | null;
  locationText: string | null;
  assetId: string | null;
  materialItemId: string | null;
  quantityAffected: number | null;
  unit: string | null;
  detectedAt: string | null;
  responseDueDate: string | null;
  disposition: string;
  dispositionJustification: string | null;
  dispositionProposedBy: string | null;
  dispositionProposedAt: string | null;
  dispositionApprovedBy: string | null;
  dispositionApprovedAt: string | null;
  concessionReference: string | null;
  concessionFileId: string | null;
  rootCause: string | null;
  rootCauseMethod: string;
  correctiveActionSummary: string | null;
  preventiveActionSummary: string | null;
  openActionCount: number;
  costImpact: number | null;
  currency: string;
  scheduleImpactDays: number | null;
  isBackcharged: number;
  backchargeReference: string | null;
  changeEventId: string | null;
  closeoutEvidenceDescription: string | null;
  closeoutEvidenceFileIds: string[];
  verificationChecklistId: string | null;
  verificationMethod: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  closedBy: string | null;
  closedAt: string | null;
  reopenedCount: number;
  photoFileIds: string[];
  attachmentFileIds: string[];
  detail: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface NcrDetail extends Ncr {
  correctiveActions: CorrectiveAction[];
  segregation: {
    dispositionProposedBy: string | null;
    dispositionApprovedBy: string | null;
    closedBy: string | null;
    verifiedBy: string | null;
  };
}

/* ================================================================== */
/* Commissioning                                                       */
/* ================================================================== */

export interface CxSystem {
  id: string;
  number: number;
  reference: string;
  systemCode: string;
  name: string;
  description: string | null;
  discipline: string | null;
  level: string;
  parentId: string | null;
  path: string | null;
  locationId: string | null;
  assetId: string | null;
  ifcGlobalIds: string[];
  vendorId: string | null;
  commitmentId: string | null;
  cxAgentId: string | null;
  status: string;
  percentComplete: number;
  plannedStaticCompletion: string | null;
  plannedEnergisation: string | null;
  plannedFunctionalTest: string | null;
  plannedCompletionDate: string | null;
  actualStaticCompletion: string | null;
  actualEnergisation: string | null;
  actualCompletionDate: string | null;
  prefunctionalTestCount: number;
  functionalTestCount: number;
  openDeficiencyCount: number;
  seasonalTestDueDate: string | null;
  turnoverPackageId: string | null;
  acceptedBy: string | null;
  acceptedAt: string | null;
  beneficialUseDate: string | null;
  warrantyStartDate: string | null;
  detail: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CxReading {
  point?: string;
  expected?: number | null;
  measured?: number | null;
  unit?: string | null;
  tolerance?: number | null;
  toleranceMinus?: number | null;
  minValue?: number | null;
  maxValue?: number | null;
  note?: string | null;
  pass?: boolean | null;
  lower?: number | null;
  upper?: number | null;
  reasons?: string[];
}

export interface CxInstrument {
  instrumentId?: string | null;
  name?: string | null;
  serial?: string;
  calibrationDueDate?: string | null;
  certificateFileId?: string | null;
}

export interface CxTest {
  id: string;
  number: number;
  reference: string;
  systemId: string;
  testKind: string;
  title: string;
  description: string | null;
  testProcedureRef: string | null;
  procedureFileId: string | null;
  checklistId: string | null;
  checklistTemplateId: string | null;
  assetId: string | null;
  equipmentId: string | null;
  locationId: string | null;
  status: string;
  scheduledFor: string | null;
  performedAt: string | null;
  performedBy: string | null;
  performedByName: string | null;
  vendorId: string | null;
  contractorRepName: string | null;
  witnessedBy: string | null;
  witnessedByName: string | null;
  witnessedByOrganisation: string | null;
  witnessedAt: string | null;
  thirdPartyWitness: string | null;
  ambientConditions: Record<string, unknown>;
  instruments: CxInstrument[];
  readings: CxReading[];
  result: string | null;
  deficiencyCount: number;
  deficiencyRecordIds: string[];
  ncrId: string | null;
  retestOfId: string | null;
  retestCount: number;
  acceptedBy: string | null;
  acceptedAt: string | null;
  certificateFileId: string | null;
  reportFileId: string | null;
  photoFileIds: string[];
  detail: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** decoration: which half of the ladder this record belongs to */
  phase?: "prefunctional" | "functional" | "unclassified";
}

export interface CxSystemDetail extends CxSystem {
  children: CxSystem[];
  testRecords: CxTest[];
  openDeficiencies: {
    count: number;
    punchItemIds: string[];
    ncrIds: string[];
  };
  functionalReadiness: { allowed: boolean; blockers: string[] };
  parentPath: string | null;
}

/* ================================================================== */
/* Turnover                                                            */
/* ================================================================== */

export interface ArtefactEntry {
  kind: string;
  required: boolean;
  present: boolean;
  fileId: string | null;
  note: string | null;
}

export interface ArtefactGap {
  requiredArtefactCount: number;
  presentArtefactCount: number;
  gap: number;
  missingKinds: string[];
  contents: ArtefactEntry[];
}

export interface BlockingPunchItem {
  id: string;
  number: number;
  title: string;
  status: string;
}

export interface BlockingNcr {
  id: string;
  reference: string;
  title: string;
  status: string;
  disposition: string;
}

export interface TurnoverReadiness {
  strictness: "block" | "warn" | "ignore";
  artefacts: ArtefactGap;
  openPunchItems: BlockingPunchItem[];
  openNcrs: BlockingNcr[];
  systems: Array<{
    id: string;
    systemCode: string;
    name: string;
    status: string;
    assetId: string | null;
    ifcGlobalIds: string[];
  }>;
  outstanding: string[];
  clear: boolean;
  wouldBlock: boolean;
  canSubmit?: boolean;
  canAccept?: boolean;
}

export interface TurnoverPackage {
  id: string;
  number: number;
  reference: string;
  name: string;
  description: string | null;
  packageType: string;
  status: string;
  systemId: string | null;
  systemIds: string[];
  locationId: string | null;
  vendorId: string | null;
  contents: unknown[];
  requiredArtefactCount: number;
  presentArtefactCount: number;
  asBuiltFileIds: string[];
  oAndMFileIds: string[];
  testRecordIds: string[];
  certificateFileIds: string[];
  warrantyIds: string[];
  trainingRecordIds: string[];
  sparePartsListFileId: string | null;
  assetIds: string[];
  assetCount: number;
  ifcGlobalIds: string[];
  cobieFileId: string | null;
  assetHandoverCompletedAt: string | null;
  openPunchItemCount: number;
  openNcrCount: number;
  submittedAt: string | null;
  submittedBy: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewComments: string | null;
  resubmissionCount: number;
  acceptedBy: string | null;
  acceptedAt: string | null;
  rejectionReason: string | null;
  handedOverAt: string | null;
  beneficialUseDate: string | null;
  warrantyStartDate: string | null;
  warrantyEndDate: string | null;
  packageFileId: string | null;
  detail: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** decoration on every list and detail read */
  artefacts?: ArtefactGap;
}

export interface TurnoverDetail extends TurnoverPackage {
  artefacts: ArtefactGap;
  readiness: TurnoverReadiness;
}

export interface TurnoverSummaryRow extends ArtefactGap {
  id: string;
  reference: string;
  name: string;
  status: string;
  strictness: string;
  openPunchItemCount: number;
  openNcrCount: number;
  handedOverAt: string | null;
}

export interface TurnoverSummary {
  items: TurnoverSummaryRow[];
  totals: {
    packages: number;
    requiredArtefactCount: number;
    presentArtefactCount: number;
    gap: number;
    completeness: Figure;
  };
}

/* ================================================================== */
/* The dashboard payload                                               */
/* ================================================================== */

export interface QualitySummary {
  itps: { total: number; byStatus: Record<string, number> };
  holdPoints: {
    total: number;
    open: number;
    overdue: number;
    overdueIds: string[];
    openWithoutNoticeServed: number;
    medianReleaseLatencyHours: Figure;
    witnessPointsAwaitingNotice: string[];
  };
  checklists: {
    total: number;
    byStatus: Record<string, number>;
    byResult: Record<string, number>;
    firstTimePassRate: Figure;
    criticalFailures: number;
  };
  ncrs: {
    total: number;
    open: number;
    overdue: number;
    overdueReferences: string[];
    byStatus: Record<string, number>;
    bySeverity: Record<string, number>;
    byDisposition: Record<string, number>;
    awaitingDispositionApproval: number;
    backcharged: number;
    medianClosureDays: Figure;
    totalCostImpact: Figure;
    /** one figure per currency; money is never summed across them */
    costByCurrency: Figure[];
  };
  commissioning: {
    systems: number;
    byStatus: Record<string, number>;
    openDeficiencies: number;
    systemsWithoutTwinAsset: string[];
  };
  turnover: {
    packages: number;
    byStatus: Record<string, number>;
    handedOver: number;
    assetsHandedOver: number;
    artefactCompleteness: Figure;
    gaps: Array<{ id: string; reference: string; status: string } & ArtefactGap>;
  };
  /** the Domain Z and closeout registers, as counts (WP-QUAL upgrade) */
  registers: RegisterCounts;
}

export interface RegisterCounts {
  concessions: {
    total: number;
    live: number;
    expired: number;
    awaitingDecision: number;
    expiringWithin30Days: number;
  };
  concrete: {
    pours: number;
    poured: number;
    failing: number;
    awaitingResults: number;
    pouredWithoutRelease: number;
  };
  welding: {
    welds: number;
    welded: number;
    rejected: number;
    ndtRecords: number;
    pendingExaminations: number;
    awaitingRequiredNdt: number;
  };
  certificates: {
    total: number;
    unverified: number;
    failed: number;
    withoutTraceability: number;
  };
  calibration: { instruments: number; overdue: number; dueSoon: number; unusable: number };
  rework: {
    total: number;
    open: number;
    costByCurrency: CurrencyTotal[];
    uncosted: number;
  };
  audits: {
    total: number;
    open: number;
    findings: number;
    openFindings: number;
    majorNonConformities: number;
    overdueFindings: number;
  };
  closeout: {
    liabilityPeriods: number;
    expiringWithin60Days: number;
    expired: number;
    guarantees: number;
    guaranteesNotMet: number;
    guaranteesUnmeasured: number;
  };
}

export interface CurrencyTotal {
  currency: string;
  amount: number;
  recordCount: number;
}

/* ================================================================== */
/* The sign-off chain (#1092–1094)                                     */
/* ================================================================== */

export interface ReleaseLeg {
  id: string;
  activityId: string;
  itpId: string;
  position: number;
  party: string;
  /** 0/1 — an invited party that does not block is a real and common row */
  required: number;
  userId: string | null;
  vendorId: string | null;
  organisation: string | null;
  contactName: string | null;
  contactEmail: string | null;
  accreditation: string | null;
  status: string;
  notifiedAt: string | null;
  notifiedBy: string | null;
  attendedAt: string | null;
  attendedByName: string | null;
  releasedBy: string | null;
  releasedAt: string | null;
  releasedByName: string | null;
  note: string | null;
  reportFileId: string | null;
  concessionId: string | null;
}

export interface ChainSummary {
  legCount: number;
  requiredCount: number;
  releasedCount: number;
  waivedCount: number;
  rejectedCount: number;
  outstanding: Array<{ id: string; position: number; party: string; status: string; label: string }>;
  nextLegId: string | null;
  complete: boolean;
  rejected: boolean;
  reasons: string[];
}

export interface ReleaseChain {
  items: ReleaseLeg[];
  summary: ChainSummary;
  activityReleased?: boolean;
}

/** GET /projects/:projectId/surveillance — the legs held by somebody outside. */
export interface SurveillanceRegister {
  items: Array<
    ReleaseLeg & {
      activity: {
        id: string;
        activity: string;
        activityCode: string | null;
        interventionPoint: string;
        plannedDate: string | null;
        status: string;
        itpId: string;
      } | null;
    }
  >;
  total: number;
  awaitingAttendance: number;
  notifiedAwaitingSignature: number;
}

/* ================================================================== */
/* Concessions (#1091)                                                 */
/* ================================================================== */

export interface ConcessionStanding {
  live: boolean;
  expired: boolean;
  daysToExpiry: number | null;
  reasons: string[];
}

export interface Concession {
  id: string;
  reference: string;
  kind: string;
  title: string;
  description: string;
  departureFromRequirement: string | null;
  justification: string | null;
  status: string;
  ncrId: string | null;
  itpActivityId: string | null;
  locationText: string | null;
  vendorId: string | null;
  quantityLimit: number | null;
  unit: string | null;
  conditions: string | null;
  expiryDate: string | null;
  requestedBy: string;
  requestedAt: string | null;
  designerOrganisation: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  approvalAuthority: string | null;
  approvalComments: string | null;
  rejectionReason: string | null;
  valueImpact: number | null;
  currency: string;
  documentFileId: string | null;
  createdBy: string;
  createdAt: string;
  standing: ConcessionStanding;
}

export interface ConcessionSummary {
  total: number;
  live: number;
  byStatus: Record<string, number>;
  byKind: Record<string, number>;
  expiring: Array<{ id: string; reference: string; expiryDate: string | null; days: number | null }>;
  expired: number;
  awaitingDecision: number;
  byVendor: Array<{ vendorId: string; concessions: number }>;
  withoutExpiry: number;
}

/* ================================================================== */
/* Concrete (#1085–1086)                                               */
/* ================================================================== */

export interface ConcreteSpecimen {
  id: string;
  pourId: string;
  specimenRef: string;
  specimenType: string;
  castAt: string | null;
  testAgeDays: number;
  testDate: string | null;
  strengthMpa: number | null;
  result: string;
  failureMode: string | null;
  labName: string | null;
  certificateNumber: string | null;
  voidReason: string | null;
  notes: string | null;
}

export interface AcceptanceCheck {
  name: string;
  passed: boolean | null;
  requirement: string;
  observed: string;
}

export interface PourAssessment {
  code: string;
  verdict: "accepted" | "rejected" | "inconclusive" | "not_assessable";
  statistics: {
    testedCount: number;
    pendingCount: number;
    voidCount: number;
    mean: number | null;
    min: number | null;
    max: number | null;
    standardDeviation: number | null;
    values: number[];
    reasons: string[];
  };
  checks: AcceptanceCheck[];
  reasons: string[];
}

export interface ConcretePour {
  id: string;
  reference: string;
  pourName: string;
  elementType: string | null;
  locationText: string | null;
  status: string;
  plannedDate: string | null;
  pouredAt: string | null;
  mixReference: string | null;
  specifiedGrade: string | null;
  specifiedStrengthMpa: number | null;
  testAgeDays: number;
  acceptanceCode: string;
  volumeM3: number | null;
  supplierVendorId: string | null;
  batchPlant: string | null;
  batchNumbers: string[];
  slumpMm: number | null;
  slumpSpecMin: number | null;
  slumpSpecMax: number | null;
  concreteTempC: number | null;
  ambientTempC: number | null;
  itpActivityId: string | null;
  holdPointReleasedAt: string | null;
  specimenCount: number;
  testedSpecimenCount: number;
  failedSpecimenCount: number;
  meanStrengthMpa: number | null;
  minStrengthMpa: number | null;
  standardDeviationMpa: number | null;
  acceptanceVerdict: string | null;
  acceptanceReasons: string[];
  ncrId: string | null;
  detail: Record<string, unknown>;
}

export interface ConcretePourDetail extends ConcretePour {
  specimens: ConcreteSpecimen[];
  assessment: PourAssessment;
  slump: { passed: boolean | null; reason: string };
}

export interface ConcreteSummary {
  pours: number;
  byStatus: Record<string, number>;
  byVerdict: Record<string, number>;
  failing: number;
  untestedPours: number;
  pouredWithoutRelease: number;
  specimens: number;
  specimensAwaitingResult: number;
  mixes: Array<{
    mixReference: string;
    pours: number;
    specifiedStrengthMpa: number | null;
    resultCount: number;
    meanStrengthMpa: number | null;
    standardDeviationMpa: number | null;
    minStrengthMpa: number | null;
    reasons: string[];
  }>;
}

/* ================================================================== */
/* Welding and NDT (#1087–1088)                                        */
/* ================================================================== */

export interface Rate {
  value: number | null;
  numerator: number;
  denominator: number;
  reasons: string[];
}

export interface WeldingProcedure {
  id: string;
  wpsNumber: string;
  title: string;
  revision: string | null;
  standard: string | null;
  process: string;
  positions: string[];
  baseMaterialGroup: string | null;
  thicknessMinMm: number | null;
  thicknessMaxMm: number | null;
  pqrReference: string | null;
  status: string;
  approvedBy: string | null;
  approvedAt: string | null;
  validFrom: string | null;
  validUntil: string | null;
  createdBy: string;
}

export interface QualificationStanding {
  status: string;
  continuityLapsesOn: string | null;
  expiresInDays: number | null;
  reasons: string[];
}

export interface WelderQualification {
  id: string;
  welderName: string;
  welderStamp: string | null;
  vendorId: string | null;
  certificateNumber: string | null;
  qualificationStandard: string | null;
  processes: string[];
  positions: string[];
  thicknessMinMm: number | null;
  thicknessMaxMm: number | null;
  qualifiedFrom: string | null;
  expiryDate: string | null;
  continuityConfirmedAt: string | null;
  continuityMonths: number;
  status: string;
  suspensionReason: string | null;
  standing?: QualificationStanding;
}

export interface NdtRecord {
  id: string;
  reference: string;
  weldId: string;
  method: string;
  acceptanceStandard: string | null;
  performedAt: string | null;
  performedByOrganisation: string | null;
  technicianName: string | null;
  technicianLevel: string | null;
  result: string;
  defectType: string | null;
  defectLengthMm: number | null;
  reportNumber: string | null;
  ncrId: string | null;
}

export interface Weld {
  id: string;
  reference: string;
  weldMapRef: string | null;
  jointReference: string | null;
  jointType: string | null;
  drawingReference: string | null;
  isometricRef: string | null;
  systemId: string | null;
  materialSpec: string | null;
  thicknessMm: number | null;
  diameterMm: number | null;
  heatNumbers: string[];
  wpsId: string | null;
  welderQualificationId: string | null;
  welderStamp: string | null;
  weldedAt: string | null;
  status: string;
  visualResult: string | null;
  ndtRequiredPercent: number | null;
  ndtMethodsRequired: string[];
  ndtRecordCount: number;
  ndtAcceptCount: number;
  ndtRejectCount: number;
  repairCount: number;
  ncrId: string | null;
  detail: Record<string, unknown>;
}

export interface WeldDetail extends Weld {
  wps: WeldingProcedure | null;
  welderQualification: WelderQualification | null;
  ndtRecords: NdtRecord[];
  compliance: {
    compliant: boolean;
    checks: Array<{ name: string; passed: boolean | null; detail: string }>;
    blockers: string[];
  };
}

export interface WeldingSummary {
  programme: {
    weldCount: number;
    weldedCount: number;
    examinedCount: number;
    acceptedCount: number;
    rejectedCount: number;
    repairCount: number;
    ndtCoverage: Rate;
    repairRate: Rate;
    coverageShortfalls: Array<{
      weldId: string;
      reference: string;
      required: number;
      achieved: number;
    }>;
  };
  welderPerformance: Array<{
    welderQualificationId: string;
    welderName: string;
    welderStamp: string | null;
    weldCount: number;
    examinedCount: number;
    rejectedCount: number;
    repairRate: Rate;
  }>;
  qualifications: {
    total: number;
    valid: number;
    expiring: number;
    expired: number;
    suspended: number;
    items: Array<
      QualificationStanding & {
        id: string;
        welderName: string;
        welderStamp: string | null;
        vendorId: string | null;
      }
    >;
  };
  procedures: { total: number; approved: number; draft: number };
  nonCompliantWelds: Array<{ id: string; reference: string; reason: unknown }>;
  ndtRecords: number;
  pendingExaminations: number;
}

/* ================================================================== */
/* Material test certificates (#1089)                                  */
/* ================================================================== */

export interface PropertyVerdict {
  property: string;
  required: string;
  measured: string;
  passed: boolean | null;
  reason: string;
}

export interface CertificateCheck {
  status: string;
  verdicts: PropertyVerdict[];
  reasons: string[];
  lotTraceable: boolean;
  independentlyWitnessed: boolean;
}

export interface MaterialCertificate {
  id: string;
  reference: string;
  certificateNumber: string;
  certificateType: string;
  materialDescription: string;
  materialGrade: string | null;
  standard: string | null;
  heatNumber: string | null;
  batchNumber: string | null;
  castNumber: string | null;
  quantity: number | null;
  unit: string | null;
  manufacturer: string | null;
  millName: string | null;
  supplierVendorId: string | null;
  issuedAt: string | null;
  receivedAt: string | null;
  requiredProperties: Array<{
    property: string;
    min?: number | null;
    max?: number | null;
    target?: number | null;
    unit?: string | null;
    text?: string | null;
  }>;
  measuredProperties: Array<{
    property: string;
    value?: number | null;
    text?: string | null;
    unit?: string | null;
  }>;
  verificationStatus: string;
  verificationReasons: string[];
  verifiedBy: string | null;
  verifiedAt: string | null;
  ncrId: string | null;
  documentFileId: string | null;
  createdBy: string;
  check: CertificateCheck;
}

export interface CertificateSummary {
  total: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  unverified: number;
  failed: number;
  untraceable: number;
  withoutDocument: number;
  withoutHeat: number;
  reasons: string[];
}

/* ================================================================== */
/* Calibration (#1097)                                                 */
/* ================================================================== */

export interface InstrumentStanding {
  status: string;
  derivedDueDate: string | null;
  daysUntilDue: number | null;
  usable: boolean;
  reasons: string[];
}

export interface Instrument {
  id: string;
  reference: string;
  name: string;
  instrumentType: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  ownerVendorId: string | null;
  custodian: string | null;
  rangeMin: number | null;
  rangeMax: number | null;
  rangeUnit: string | null;
  accuracy: string | null;
  calibrationStandard: string | null;
  calibrationIntervalMonths: number;
  lastCalibratedAt: string | null;
  calibrationDueDate: string | null;
  certificateNumber: string | null;
  calibratedByOrganisation: string | null;
  status: string;
  outOfServiceReason: string | null;
  standing: InstrumentStanding;
}

export interface CalibrationRecord {
  id: string;
  instrumentId: string;
  calibratedAt: string;
  calibrationDueDate: string | null;
  result: string;
  asFoundCondition: string | null;
  asLeftCondition: string | null;
  certificateNumber: string | null;
  calibratedByOrganisation: string | null;
  technicianName: string | null;
  notes: string | null;
}

export interface InstrumentSummary {
  total: number;
  byStatus: Record<string, number>;
  overdue: number;
  dueSoon: number;
  unusable: number;
  withoutCertificate: number;
  items: Array<{
    id: string;
    reference: string;
    name: string;
    serialNumber: string;
    calibrationDueDate: string | null;
    status: string;
    daysUntilDue: number | null;
    usable: boolean;
    reasons: string[];
  }>;
}

/* ================================================================== */
/* Rework and the cost of quality (#1098–1100)                         */
/* ================================================================== */

export interface ReworkItem {
  id: string;
  reference: string;
  title: string;
  description: string | null;
  status: string;
  sourceType: string;
  ncrId: string | null;
  causeCategory: string;
  causeDescription: string | null;
  discoveryPhase: string;
  discoveredAt: string | null;
  responsibleVendorId: string | null;
  trade: string | null;
  locationText: string | null;
  labourHours: number | null;
  labourCost: number | null;
  materialCost: number | null;
  plantCost: number | null;
  subcontractorCost: number | null;
  otherCost: number | null;
  totalCost: number | null;
  currency: string;
  costBasis: string;
  scheduleImpactDays: number | null;
  isBackcharged: number;
  preventable: number;
  completedAt: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  createdBy: string;
}

export interface ReworkGroup {
  key: string;
  items: number;
  costedItems: number;
  uncostedItems: number;
  totals: CurrencyTotal[];
  labourHours: number;
  reasons: string[];
}

export interface ReworkSummary {
  total: number;
  open: number;
  verified: number;
  cancelled: number;
  preventable: number;
  backcharged: number;
  totals: CurrencyTotal[];
  costedItems: number;
  uncostedItems: number;
  byCause: ReworkGroup[];
  byPhase: ReworkGroup[];
  byTrade: ReworkGroup[];
  scheduleImpactDays: number;
  reasons: string[];
}

export interface CostOfQuality {
  buckets: Array<{
    bucket: string;
    label: string;
    money: CurrencyTotal[];
    recordCount: number;
    costedRecordCount: number;
    activityCount: number;
    reasons: string[];
  }>;
  failureByCurrency: Array<{
    currency: string;
    internal: number;
    external: number;
    total: number;
    externalShare: number | null;
  }>;
  reasons: string[];
}

export interface FirstTimeRightRow {
  key: string;
  label: string;
  judged: number;
  right: number;
  failed: number;
  rate: number | null;
  reasons: string[];
}

export interface FirstTimeRight {
  rows: FirstTimeRightRow[];
  overall: FirstTimeRightRow;
}

/* ================================================================== */
/* Audits and ISO 9001 evidence (#1095–1096)                           */
/* ================================================================== */

export interface AuditFinding {
  id: string;
  auditId: string;
  position: number;
  reference: string;
  findingType: string;
  clauseReference: string | null;
  requirement: string | null;
  evidence: string | null;
  description: string;
  status: string;
  responsibleUserId: string | null;
  responsibleVendorId: string | null;
  responseDueDate: string | null;
  dueDate: string | null;
  response: string | null;
  respondedAt: string | null;
  rootCause: string | null;
  verificationEvidence: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  closedBy: string | null;
  closedAt: string | null;
}

export interface QualityAudit {
  id: string;
  reference: string;
  title: string;
  auditType: string;
  standard: string | null;
  scope: string | null;
  clauseReferences: string[];
  auditedVendorId: string | null;
  auditedFunction: string | null;
  leadAuditorId: string | null;
  leadAuditorName: string | null;
  leadAuditorOrganisation: string | null;
  status: string;
  plannedDate: string | null;
  startedAt: string | null;
  completedAt: string | null;
  reportIssuedAt: string | null;
  responseDueDate: string | null;
  findingCount: number;
  majorFindingCount: number;
  minorFindingCount: number;
  observationCount: number;
  openFindingCount: number;
  conformityPercent: number | null;
  nextAuditDueDate: string | null;
  createdBy: string;
}

export interface QualityAuditDetail extends QualityAudit {
  findings: AuditFinding[];
}

export interface IsoEvidence {
  generatedAt: string;
  standard: string;
  clauses: Array<{
    clause: string;
    title: string;
    question: string;
    records: Array<{ kind: string; count: number; href?: string }>;
    evidenced: boolean;
    reasons: string[];
  }>;
  coverage: { clausesReported: number; clausesEvidenced: number; percent: number };
  reasons: string[];
}

/* ================================================================== */
/* Closeout (Domain V)                                                 */
/* ================================================================== */

export interface DlpStanding {
  status: string;
  daysRemaining: number | null;
  reasons: string[];
}

export interface Dlp {
  id: string;
  reference: string;
  name: string;
  scopeDescription: string | null;
  turnoverPackageId: string | null;
  vendorId: string | null;
  contractClause: string | null;
  startDate: string;
  endDate: string;
  durationMonths: number | null;
  status: string;
  makeGoodObligationId: string | null;
  extendedToDate: string | null;
  extensionReason: string | null;
  retentionReleaseDate: string | null;
  retentionAmount: number | null;
  currency: string;
  finalCertificateDate: string | null;
  defectCount: number;
  openDefectCount: number;
  standing: DlpStanding;
}

export interface DlpDefect {
  id: string;
  dlpId: string;
  reference: string;
  title: string;
  description: string | null;
  reportedAt: string | null;
  reportedByName: string | null;
  reportedByOrganisation: string | null;
  severity: string;
  locationText: string | null;
  responsibleVendorId: string | null;
  status: string;
  targetRectificationDate: string | null;
  rectifiedAt: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  cost: number | null;
  currency: string;
  detail: Record<string, unknown>;
}

export interface DlpDetail extends Dlp {
  defects: DlpDefect[];
}

export interface GuaranteeAssessment {
  status: string;
  met: boolean | null;
  shortfall: number | null;
  shortfallPercent: number | null;
  ldAmount: number | null;
  ldCapped: boolean;
  basis: string;
  reasons: string[];
}

export interface PerformanceGuarantee {
  id: string;
  reference: string;
  title: string;
  parameter: string;
  operator: string;
  guaranteedValue: number | null;
  guaranteedMin: number | null;
  guaranteedMax: number | null;
  unit: string | null;
  tolerancePercent: number | null;
  measurementMethod: string | null;
  systemId: string | null;
  vendorId: string | null;
  contractClause: string | null;
  measuredValue: number | null;
  measuredAt: string | null;
  measuredBy: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  status: string;
  shortfall: number | null;
  shortfallPercent: number | null;
  ldRatePerUnit: number | null;
  ldRateUnit: string | null;
  ldCapAmount: number | null;
  ldAmount: number | null;
  ldBasis: string | null;
  currency: string;
  waivedBy: string | null;
  waiverReason: string | null;
  assessment?: GuaranteeAssessment;
}

export interface TrainingRecord {
  id: string;
  reference: string;
  title: string;
  description: string | null;
  trainingKind: string;
  systemId: string | null;
  turnoverPackageId: string | null;
  vendorId: string | null;
  trainerName: string | null;
  trainerOrganisation: string | null;
  status: string;
  scheduledFor: string | null;
  deliveredAt: string | null;
  durationHours: number | null;
  attendees: Array<{ name: string; organisation?: string | null; role?: string | null }>;
  attendeeCount: number;
  competencyAssessed: number;
  acceptedBy: string | null;
  acceptedAt: string | null;
  createdBy: string;
}

export interface SparePart {
  id: string;
  reference: string;
  description: string;
  category: string;
  partNumber: string | null;
  manufacturer: string | null;
  supplierVendorId: string | null;
  systemId: string | null;
  quantityRequired: number | null;
  quantityDelivered: number;
  unit: string | null;
  unitCost: number | null;
  currency: string;
  leadTimeWeeks: number | null;
  status: string;
  deliveredAt: string | null;
  storageLocation: string | null;
  handedOverAt: string | null;
}

export interface Poe {
  id: string;
  reference: string;
  title: string;
  poeKind: string;
  turnoverPackageId: string | null;
  systemId: string | null;
  status: string;
  periodStart: string | null;
  periodEnd: string | null;
  scheduledFor: string | null;
  completedAt: string | null;
  conductedByOrganisation: string | null;
  surveyResponseCount: number | null;
  surveyInviteCount: number | null;
  satisfactionScore: number | null;
  satisfactionScale: string | null;
  energyDesignValue: number | null;
  energyActualValue: number | null;
  energyUnit: string | null;
  defectsRaisedCount: number | null;
  warrantyClaimCount: number | null;
  findings: string | null;
  recommendations: string | null;
  energyVariance: Figure;
  surveyResponseRate: number | null;
}

export interface CloseoutSummary {
  dlps: {
    total: number;
    byStatus: Record<string, number>;
    expiringWithin60Days: Array<{
      id: string;
      reference: string;
      name: string;
      endDate: string;
      daysRemaining: number | null;
      openDefects: number;
    }>;
    openDefects: number;
    defectCosts: CurrencyTotal[];
    defectCostReasons: string[];
    handedOverPackagesWithoutAPeriod: Array<{
      id: string;
      reference: string;
      handedOverAt: string | null;
    }>;
  };
  guarantees: {
    total: number;
    met: number;
    notMet: number;
    unmeasured: number;
    waived: number;
    exposure: {
      byCurrency: Array<{ currency: string; amount: number; guarantees: number; capped: number }>;
      unpricedShortfalls: Array<{
        id: string;
        reference: string;
        parameter: string;
        shortfall: number;
      }>;
      unmeasured: Array<{ id: string; reference: string; parameter: string }>;
      reasons: string[];
    };
  };
  training: {
    total: number;
    delivered: number;
    accepted: number;
    attendees: number;
    outstanding: number;
  };
  spares: {
    total: number;
    handedOver: number;
    outstanding: number;
    byCategory: Record<string, number>;
  };
  poe: {
    total: number;
    complete: number;
    items: Array<{
      id: string;
      reference: string;
      title: string;
      poeKind: string;
      status: string;
      satisfactionScore: number | null;
      energyVariance: Figure;
    }>;
  };
}
