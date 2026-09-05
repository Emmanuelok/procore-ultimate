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
 * Workforce rights & welfare (spec Vol II Domain M / module M17).
 * Labour tracked as PEOPLE WITH RIGHTS rather than cost and hours — a hard
 * contractual condition on DFI-financed projects (IFC PS2, ILO core
 * conventions). Ghost-worker elimination reconciles payroll against site
 * access records (#669); risk indicators score modern-slavery exposure (#694).
 */
export const workers = pgTable(
  "workers",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    reference: text("reference").notNull(), // worker id / badge number
    fullName: text("full_name").notNull(),
    dateOfBirth: text("date_of_birth"), // for age verification (#670)
    nationality: text("nationality"),
    /** employer — a vendor in the directory (subcontractor tiering) */
    vendorId: text("vendor_id"),
    trade: text("trade"),
    /** identity verification without storing document images */
    idVerified: integer("id_verified").default(0).notNull(),
    biometricEnrolled: integer("biometric_enrolled").default(0).notNull(),
    /** employment contract issued in the worker's own language (#674) */
    contractIssued: integer("contract_issued").default(0).notNull(),
    contractLanguage: text("contract_language"),
    recruitmentAgency: text("recruitment_agency"),
    /** wage protection: agreed rate for wage-vs-hours verification (#677) */
    agreedDailyRate: doublePrecision("agreed_daily_rate"),
    currency: text("currency").default("USD").notNull(),
    accommodationRef: text("accommodation_ref"),
    inductedAt: text("inducted_at"),
    demobilisedAt: text("demobilised_at"),
    status: text("status").default("active").notNull(), // WorkerStatus
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("workers_uq").on(t.projectId, t.reference),
    index("workers_project_idx").on(t.projectId),
    index("workers_vendor_idx").on(t.vendorId),
  ],
);

/** Site access records — the independent evidence stream for reconciliation. */
export const siteAccessRecords = pgTable(
  "site_access_records",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    workerId: text("worker_id").notNull(),
    accessDate: text("access_date").notNull(), // ISO date
    firstIn: text("first_in"), // HH:MM
    lastOut: text("last_out"),
    hoursOnSite: doublePrecision("hours_on_site"),
    source: text("source").default("turnstile").notNull(), // turnstile | biometric | manual | gate_log
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("site_access_uq").on(t.workerId, t.accessDate),
    index("site_access_project_date_idx").on(t.projectId, t.accessDate),
  ],
);

/** Payroll entries claimed by the employer — reconciled against access. */
export const payrollEntries = pgTable(
  "payroll_entries",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    workerId: text("worker_id").notNull(),
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),
    daysClaimed: doublePrecision("days_claimed").notNull(),
    hoursClaimed: doublePrecision("hours_claimed"),
    grossPay: doublePrecision("gross_pay").notNull(),
    deductions: doublePrecision("deductions").default(0).notNull(),
    netPay: doublePrecision("net_pay").notNull(),
    currency: text("currency").default("USD").notNull(),
    paidAt: text("paid_at"),
    /** Wage Protection System reference for Gulf jurisdictions (#676) */
    wpsReference: text("wps_reference"),
    /**
     * IDEMPOTENCY KEY. A payroll file re-posted after a timeout must replace
     * its own rows, never add a second copy: two copies double daysClaimed
     * and grossPay, and the reconciliation then accuses an honest worker of
     * an overclaim. Empty string = "the employer's single run for this
     * period", which is the common case; a distinct run reference (an
     * adjustment run, a second employer file) gets its own row.
     */
    sourceRef: text("source_ref").default("").notNull(),
    /** the payroll system's own row identifier, carried for the audit trail */
    externalRef: text("external_ref"),
    submittedBy: text("submitted_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("payroll_entries_uq").on(
      t.workerId,
      t.periodStart,
      t.periodEnd,
      t.sourceRef,
    ),
    index("payroll_entries_worker_idx").on(t.workerId),
    index("payroll_entries_project_period_idx").on(t.projectId, t.periodEnd),
  ],
);

/**
 * WORKER VOICE (#689-691) — a grievance channel the employer does not own.
 *
 * The channel is a project-level intake TOKEN handed to workers on a card in
 * their own language. A report posted with that token needs no account, and
 * `isAnonymous` reports carry no worker id at all: the tracking code is the
 * only thread back to the report, and it is held by the worker, not by us.
 * The employer named in a report is never given the reporter's identity —
 * only the project's own grievance handler sees the register.
 */
export const workerVoiceChannels = pgTable(
  "worker_voice_channels",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    /** sha256 of the token handed out — the token itself is never stored */
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    languages: jsonb("languages").$type<string[]>().default([]).notNull(),
    /** who handles reports — deliberately not the employer */
    handlerUserId: text("handler_user_id"),
    /** hours within which a report must get a first response */
    responseSlaHours: integer("response_sla_hours").default(72).notNull(),
    isActive: integer("is_active").default(1).notNull(),
    reportCount: integer("report_count").default(0).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("worker_voice_channels_token_uq").on(t.tokenHash),
    index("worker_voice_channels_project_idx").on(t.projectId, t.isActive),
  ],
);

/** One report through the worker voice channel. */
export const workerGrievances = pgTable(
  "worker_grievances",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    channelId: text("channel_id"),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    /** sha256 of the tracking code — the worker holds the code, we hold the hash */
    trackingHash: text("tracking_hash").notNull(),
    category: text("category").notNull(), // WorkerGrievanceCategory
    severity: text("severity").default("medium").notNull(), // SignalSeverity
    summary: text("summary").notNull(),
    detailText: text("detail_text"),
    language: text("language"),
    isAnonymous: integer("is_anonymous").default(1).notNull(),
    /** only set when the reporter chose to identify themselves */
    workerId: text("worker_id"),
    /** the employer the report is ABOUT, where the reporter named one */
    vendorId: text("vendor_id"),
    status: text("status").default("received").notNull(), // WorkerGrievanceStatus
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    responseDueAt: timestamp("response_due_at", { withTimezone: true, mode: "string" }),
    firstRespondedAt: timestamp("first_responded_at", { withTimezone: true, mode: "string" }),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "string" }),
    outcome: text("outcome"),
    /** [{ at, by, kind: "response"|"note"|"escalation", text, visibleToReporter }] */
    updates: jsonb("updates").$type<unknown[]>().default([]).notNull(),
    /** the labour risk flag raised from this report, when one was */
    riskFlagId: text("risk_flag_id"),
    signalId: text("signal_id"),
    slaBreached: integer("sla_breached").default(0).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("worker_grievances_uq").on(t.projectId, t.number),
    uniqueIndex("worker_grievances_tracking_uq").on(t.trackingHash),
    index("worker_grievances_project_idx").on(t.projectId, t.status),
    index("worker_grievances_due_idx").on(t.companyId, t.responseDueAt),
    index("worker_grievances_vendor_idx").on(t.vendorId),
  ],
);

/** Labour-rights risk indicators raised against a worker or an employer. */
export const labourRiskFlags = pgTable(
  "labour_risk_flags",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    workerId: text("worker_id"),
    vendorId: text("vendor_id"),
    indicator: text("indicator").notNull(), // LabourRiskIndicator
    severity: text("severity").default("high").notNull(),
    detail: text("detail"),
    /** raised through the worker voice channel, an audit, or a detector */
    source: text("source").default("audit").notNull(), // audit | worker_report | detector | inspection
    signalId: text("signal_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "string" }),
    resolution: text("resolution"),
    raisedBy: text("raised_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("labour_risk_flags_project_idx").on(t.projectId),
    index("labour_risk_flags_vendor_idx").on(t.vendorId),
  ],
);

/** Welfare/accommodation inspections with scored areas (#683-688). */
export const welfareInspections = pgTable(
  "welfare_inspections",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    inspectionDate: text("inspection_date").notNull(),
    location: text("location").notNull(), // camp / block reference
    vendorId: text("vendor_id"),
    /** scored areas: [{ area: WelfareInspectionArea, score 1-5, note, photoFileId? }] */
    areas: jsonb("areas").$type<unknown[]>().default([]).notNull(),
    occupancyCount: integer("occupancy_count"),
    capacity: integer("capacity"),
    overallScore: doublePrecision("overall_score"),
    /** corrective actions: [{ id, text, dueDate, closed }] */
    actions: jsonb("actions").$type<unknown[]>().default([]).notNull(),
    inspectedBy: text("inspected_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("welfare_inspections_project_idx").on(t.projectId, t.inspectionDate)],
);

/** Subcontractor labour audit programme (#697-699). */
export const labourAudits = pgTable(
  "labour_audits",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    vendorId: text("vendor_id").notNull(),
    scheduledFor: text("scheduled_for").notNull(),
    isUnannounced: integer("is_unannounced").default(0).notNull(),
    status: text("status").default("scheduled").notNull(), // LabourAuditStatus
    /** findings: [{ id, indicator?, description, severity, capDueDate?, closedAt? }] */
    findings: jsonb("findings").$type<unknown[]>().default([]).notNull(),
    score: doublePrecision("score"),
    reportFileId: text("report_file_id"),
    auditedBy: text("audited_by"),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("labour_audits_project_idx").on(t.projectId)],
);
