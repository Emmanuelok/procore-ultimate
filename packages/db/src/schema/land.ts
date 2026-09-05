import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull();

/**
 * Land, resettlement & community (spec Vol II Domain J / module M16).
 * The category of work Procore has no concept of, and frequently the largest
 * single source of delay on internationally financed infrastructure.
 * Compliance frames: IFC Performance Standard 5 / World Bank ESS5.
 */
export const landParcels = pgTable(
  "land_parcels",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    reference: text("reference").notNull(), // cadastral / plot reference
    description: text("description"),
    areaSqm: doublePrecision("area_sqm"),
    tenureType: text("tenure_type").notNull(), // TenureType
    ownerName: text("owner_name"),
    /** entity id when the owner is registered in the entity graph */
    ownerEntityId: text("owner_entity_id"),
    encumbrances: text("encumbrances"),
    status: text("status").default("identified").notNull(), // ParcelStatus
    /** how title actually passed — AcquisitionBasis (#551-554) */
    acquisitionBasis: text("acquisition_basis"),
    acquiredAt: text("acquired_at"), // ISO date
    valuationAmount: doublePrecision("valuation_amount"),
    compensationAmount: doublePrecision("compensation_amount"),
    currency: text("currency").default("USD").notNull(),
    compensationPaidAt: text("compensation_paid_at"), // ISO date
    /** links to the assurance evidence substantiating payment/verification */
    evidenceIds: jsonb("evidence_ids").$type<string[]>().default([]).notNull(),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    /** blocks these schedule tasks until acquired (consent-to-programme, #591) */
    blockingTaskIds: jsonb("blocking_task_ids").$type<string[]>().default([]).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("land_parcels_uq").on(t.projectId, t.reference),
    index("land_parcels_project_idx").on(t.projectId),
  ],
);

/**
 * Project Affected Persons census (#555-557). Vulnerability screening drives
 * entitlement enhancement under IFC PS5.
 */
export const affectedPersons = pgTable(
  "affected_persons",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    reference: text("reference").notNull(), // PAP census number
    householdHead: text("household_head").notNull(),
    householdSize: integer("household_size"),
    parcelId: text("parcel_id"),
    displacementType: text("displacement_type").default("none").notNull(), // DisplacementType
    /** vulnerability flags: elderly | disabled | female_headed | landless |
     *  indigenous | below_poverty_line | child_headed */
    vulnerabilities: jsonb("vulnerabilities").$type<string[]>().default([]).notNull(),
    /** socio-economic baseline survey capture (#556) */
    baseline: jsonb("baseline").$type<Record<string, unknown>>().default({}).notNull(),
    /** entitlement matrix application (#566): [{ item, basis, amount, delivered }] */
    entitlements: jsonb("entitlements").$type<unknown[]>().default([]).notNull(),
    compensationTotal: doublePrecision("compensation_total"),
    compensationPaidAt: text("compensation_paid_at"),
    /** livelihood restoration programme tracking (#561) */
    livelihoodProgramme: text("livelihood_programme"),
    livelihoodRestoredAt: text("livelihood_restored_at"),
    status: text("status").default("registered").notNull(), // PapStatus
    /** declared before the cut-off date; later arrivals are encroachment (#564) */
    censusDate: text("census_date"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("affected_persons_uq").on(t.projectId, t.reference),
    index("affected_persons_project_idx").on(t.projectId),
  ],
);

/**
 * Community grievance redress mechanism (#569-574). SLA-driven with
 * anonymous intake and closure verified WITH the complainant.
 */
export const grievances = pgTable(
  "grievances",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    channel: text("channel").notNull(), // GrievanceChannel
    isAnonymous: integer("is_anonymous").default(0).notNull(),
    complainantName: text("complainant_name"),
    complainantContact: text("complainant_contact"),
    papId: text("pap_id"),
    category: text("category").notNull(), // land | noise | dust | access | employment | conduct | compensation | other
    severity: text("severity").default("medium").notNull(), // GrievanceSeverity
    description: text("description").notNull(),
    locationId: text("location_id"),
    receivedAt: text("received_at").notNull(), // ISO date
    /** SLA deadlines computed from severity at intake */
    acknowledgeDueAt: text("acknowledge_due_at"),
    resolveDueAt: text("resolve_due_at"),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true, mode: "string" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "string" }),
    resolution: text("resolution"),
    /** closure verified with the complainant (#573) */
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" }),
    verifiedBy: text("verified_by"),
    complainantSatisfied: integer("complainant_satisfied"),
    status: text("status").default("received").notNull(), // GrievanceStatus
    /** escalation ladder position (#572): 0 site officer .. 3 external route */
    escalationTier: integer("escalation_tier").default(0).notNull(),
    escalatedAt: timestamp("escalated_at", { withTimezone: true, mode: "string" }),
    /** [{ at, fromTier, toTier, reason, automatic, assigneeId }] */
    escalationHistory: jsonb("escalation_history").$type<unknown[]>().default([]).notNull(),
    assigneeId: text("assignee_id"),
    obligationId: text("obligation_id"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("grievances_uq").on(t.projectId, t.number),
    index("grievances_project_idx").on(t.projectId),
    index("grievances_sla_idx").on(t.status, t.resolveDueAt),
  ],
);

/** Stakeholder register + engagement log (#579-584). */
export const stakeholders = pgTable(
  "stakeholders",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    organisation: text("organisation"),
    category: text("category"), // community | authority | ngo | media | business | indigenous_group
    /** influence/interest mapping (#579): 1-5 each */
    influence: integer("influence").default(3).notNull(),
    interest: integer("interest").default(3).notNull(),
    contact: text("contact"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("stakeholders_project_idx").on(t.projectId)],
);

export const engagements = pgTable(
  "engagements",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    title: text("title").notNull(),
    kind: text("kind").notNull(), // consultation | disclosure | meeting | site_visit | notice
    engagementDate: text("engagement_date").notNull(),
    location: text("location"),
    stakeholderIds: jsonb("stakeholder_ids").$type<string[]>().default([]).notNull(),
    attendeeCount: integer("attendee_count"),
    summary: text("summary"),
    /** feedback capture + disposition (#582): [{ point, raisedBy, disposition }] */
    feedback: jsonb("feedback").$type<unknown[]>().default([]).notNull(),
    /** FPIC process documentation (#575) */
    consentStatus: text("consent_status"), // ConsentStatus
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    recordedBy: text("recorded_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("engagements_project_idx").on(t.projectId, t.engagementDate)],
);

/* ------------------------------------------------------------------ */
/* WP-SAFEG — resettlement depth                                       */
/* ------------------------------------------------------------------ */

/**
 * Replacement-cost verification (#550, IFC PS5 para 27 and its footnote 22).
 *
 * The single most common finding on a lender supervision mission is that a
 * project paid the government's depreciated schedule rate rather than full
 * replacement cost. Full replacement cost = the market value of the asset
 * with NO deduction for depreciation, plus the transaction costs the
 * household actually has to bear (registration, transfer duty, moving) —
 * so the study has to carry the market survey behind it and the gap it
 * leaves against what was offered.
 */
export const replacementCostStudies = pgTable(
  "replacement_cost_studies",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    parcelId: text("parcel_id"),
    papId: text("pap_id"),
    assetType: text("asset_type").notNull(), // ReplacementAssetType
    description: text("description").notNull(),
    method: text("method").notNull(), // ValuationMethod
    /** the surveyed market value of an equivalent asset */
    marketValue: doublePrecision("market_value").notNull(),
    /** depreciation the government schedule would have deducted — recorded so
     *  the difference between schedule rate and replacement cost is visible */
    depreciationDeducted: doublePrecision("depreciation_deducted").default(0).notNull(),
    /** registration, transfer duty, moving costs the household must bear */
    transactionCosts: doublePrecision("transaction_costs").default(0).notNull(),
    /** computed at write: marketValue + transactionCosts (no depreciation) */
    replacementCost: doublePrecision("replacement_cost").notNull(),
    /** what the project actually offered or paid, when known */
    compensationOffered: doublePrecision("compensation_offered"),
    currency: text("currency").default("USD").notNull(),
    /** computed: replacementCost − compensationOffered, positive = shortfall */
    shortfall: doublePrecision("shortfall"),
    verdict: text("verdict").default("unverified").notNull(), // ReplacementVerdict
    surveyDate: text("survey_date").notNull(),
    valuerName: text("valuer_name"),
    /** independent valuer = not the acquiring authority or the contractor */
    valuerIndependent: integer("valuer_independent").default(0).notNull(),
    evidenceIds: jsonb("evidence_ids").$type<string[]>().default([]).notNull(),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("replacement_cost_project_idx").on(t.projectId),
    index("replacement_cost_parcel_idx").on(t.parcelId),
    index("replacement_cost_pap_idx").on(t.papId),
    index("replacement_cost_verdict_idx").on(t.projectId, t.verdict),
  ],
);

/**
 * Indigenous Peoples plans, cultural heritage management plans, FPIC
 * processes and chance-find procedures (IFC PS7 / PS8, spec #575-578).
 * A plan with commitments nobody tracks is a document, not a safeguard, so
 * every commitment carries a due date and is counted in the RAP dashboard.
 */
export const heritagePlans = pgTable(
  "heritage_plans",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    kind: text("kind").notNull(), // HeritagePlanKind
    title: text("title").notNull(),
    /** the community, group or asset the plan is for */
    subject: text("subject"),
    status: text("status").default("draft").notNull(), // HeritagePlanStatus
    /** FPIC standing where PS7 para 12-17 is engaged */
    consentStatus: text("consent_status"), // ConsentStatus
    consentEvidenceIds: jsonb("consent_evidence_ids").$type<string[]>().default([]).notNull(),
    /** [{ id, text, dueDate, owner, status, closedAt, note }] */
    commitments: jsonb("commitments").$type<unknown[]>().default([]).notNull(),
    stakeholderIds: jsonb("stakeholder_ids").$type<string[]>().default([]).notNull(),
    disclosedAt: text("disclosed_at"),
    reviewDueAt: text("review_due_at"),
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("heritage_plans_project_idx").on(t.projectId),
    index("heritage_plans_status_idx").on(t.projectId, t.status),
  ],
);

/**
 * Chance finds (PS8 para 16). A find stops the works in the affected area
 * until the authority has spoken; the register is what proves it did.
 */
export const chanceFinds = pgTable(
  "chance_finds",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    planId: text("plan_id"),
    discoveredAt: text("discovered_at").notNull(),
    locationId: text("location_id"),
    locationDescription: text("location_description"),
    description: text("description").notNull(),
    workStoppedAt: timestamp("work_stopped_at", { withTimezone: true, mode: "string" }),
    authorityNotifiedAt: timestamp("authority_notified_at", {
      withTimezone: true,
      mode: "string",
    }),
    authority: text("authority"),
    assessment: text("assessment"),
    disposition: text("disposition"),
    releasedAt: timestamp("released_at", { withTimezone: true, mode: "string" }),
    status: text("status").default("reported").notNull(), // ChanceFindStatus
    affectedTaskIds: jsonb("affected_task_ids").$type<string[]>().default([]).notNull(),
    evidenceIds: jsonb("evidence_ids").$type<string[]>().default([]).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("chance_finds_uq").on(t.projectId, t.number),
    index("chance_finds_project_idx").on(t.projectId, t.status),
  ],
);

/**
 * Livelihood restoration activities per household (#561, PS5 paras 27-29).
 *
 * "Livelihood restored" is a measured claim, not a tick: it holds when
 * income after the intervention is at least the pre-displacement baseline.
 * Recording the baseline and the current figure is what turns a training
 * course into evidence.
 */
export const livelihoodActivities = pgTable(
  "livelihood_activities",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    papId: text("pap_id").notNull(),
    kind: text("kind").notNull(), // LivelihoodActivityKind
    description: text("description").notNull(),
    status: text("status").default("planned").notNull(), // LivelihoodActivityStatus
    plannedAt: text("planned_at"),
    deliveredAt: text("delivered_at"),
    verifiedAt: text("verified_at"),
    verifiedBy: text("verified_by"),
    cost: doublePrecision("cost"),
    currency: text("currency").default("USD").notNull(),
    /** monthly household income before displacement and at last measurement */
    incomeBaseline: doublePrecision("income_baseline"),
    incomeCurrent: doublePrecision("income_current"),
    incomeMeasuredAt: text("income_measured_at"),
    evidenceIds: jsonb("evidence_ids").$type<string[]>().default([]).notNull(),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("livelihood_activities_project_idx").on(t.projectId),
    index("livelihood_activities_pap_idx").on(t.papId),
    index("livelihood_activities_status_idx").on(t.projectId, t.status),
  ],
);

/**
 * RAP completion audit (#568) and lender supervision pack (#558-560).
 * The audit is a point-in-time assertion about the register, so it stores
 * the indicator set it computed AND the ledger sequence range it was built
 * from: an auditor can replay the same window and get the same numbers.
 */
export const rapAudits = pgTable(
  "rap_audits",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    kind: text("kind").default("completion_audit").notNull(),
    auditor: text("auditor").notNull(),
    /** independent monitor = not the implementing agency (#568) */
    auditorIndependent: integer("auditor_independent").default(0).notNull(),
    auditDate: text("audit_date").notNull(),
    scope: text("scope"),
    /** computed indicator set, frozen at the moment of the audit */
    indicators: jsonb("indicators").$type<Record<string, unknown>>().default({}).notNull(),
    /** [{ id, ref, severity, finding, recommendation, status, dueDate }] */
    findings: jsonb("findings").$type<unknown[]>().default([]).notNull(),
    conclusion: text("conclusion").default("not_assessed").notNull(), // RapAuditConclusion
    /** the ledger window the pack was assembled from */
    ledgerSeqFrom: integer("ledger_seq_from"),
    ledgerSeqTo: integer("ledger_seq_to"),
    evidenceIds: jsonb("evidence_ids").$type<string[]>().default([]).notNull(),
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("rap_audits_uq").on(t.projectId, t.number),
    index("rap_audits_project_idx").on(t.projectId, t.auditDate),
  ],
);
