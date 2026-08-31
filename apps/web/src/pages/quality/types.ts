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
}
