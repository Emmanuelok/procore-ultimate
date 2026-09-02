/**
 * SITE OPERATIONS & REALITY CAPTURE — schema (spec Vol II Z #1067–1084,
 * X #995–1003; Vol I §2.15 #471–478).
 *
 * Six registers that answer six questions about a physical site:
 *
 *   who is on it        inductions → passes → gate events → the live register
 *                       → musters, which reconcile the register against a
 *                       headcount taken by a human at a muster point
 *   what may be done    permits to work, confined-space entries, exclusion
 *                       zones (closed polygon rings, point-in-polygon tested)
 *                       and lone-worker check-ins with a due time
 *   what the sky did    daily weather observations, a contract baseline of
 *                       thresholds, and the exceptional-weather analysis that
 *                       compares one to the other for a claim
 *   what it looks like  drone flights, laser scans, scan-vs-model deviation
 *                       reports, 360° tours and their stations
 *   where things are    survey control points and setting-out records
 *   what the ground is  geotechnical investigations, ground-condition findings
 *                       against the baseline, buried utilities and strikes
 *
 *   and, cutting across all of them, progress observations: a claimed
 *   percentage and an independently observed one, recorded as an Assertion +
 *   Evidence pair and reconciled.
 *
 * Every table is company-scoped and every project record carries project_id.
 * What this schema deliberately does NOT duplicate: workers and their access
 * records (workforce.workers / site_access_records — the gate feed reconciles
 * AGAINST them), safety incidents and inspections (safety.*), photos
 * (field.photos), geofences and BIM models (bim.*), daily logs (field.*) and
 * delay events (forensics.*). It links to all of them by id.
 */
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
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

/** A closed ring of [longitude, latitude] pairs, GeoJSON winding-agnostic. */
export type SiteRing = Array<[number, number]>;

/* ------------------------------------------------------------------ */
/* Access & induction (#1067–1069)                                     */
/* ------------------------------------------------------------------ */

/**
 * An induction: the record that a named person was told the site's rules on a
 * date, by someone, and for how long that lasts. A pass without a valid
 * induction behind it is the condition the sweep flags.
 */
export const siteInductions = pgTable(
  "site_inductions",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    /** workforce.workers row when the person is on the labour register */
    workerId: text("worker_id"),
    personName: text("person_name").notNull(),
    personKind: text("person_kind").default("worker").notNull(), // SitePersonKind
    /** employer — directory vendor */
    vendorId: text("vendor_id"),
    inductionType: text("induction_type").default("general").notNull(), // SiteInductionType
    language: text("language"),
    conductedBy: text("conducted_by"),
    conductedByName: text("conducted_by_name"),
    conductedAt: ts("conducted_at"),
    validFrom: text("valid_from"), // ISO date
    validUntil: text("valid_until"), // ISO date
    status: text("status").default("pending").notNull(), // SiteInductionStatus
    topics: jsonb("topics").$type<string[]>().default([]).notNull(),
    scorePercent: doublePrecision("score_percent"),
    passMark: doublePrecision("pass_mark"),
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    revokedAt: ts("revoked_at"),
    revokedBy: text("revoked_by"),
    revokeReason: text("revoke_reason"),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("site_inductions_project_idx").on(t.projectId, t.status),
    index("site_inductions_worker_idx").on(t.projectId, t.workerId),
    index("site_inductions_expiry_idx").on(t.status, t.validUntil),
    index("site_inductions_company_idx").on(t.companyId, t.projectId),
  ],
);

/**
 * The credential that opens the gate. `badgeCode` is what a reader sends, so
 * it is unique per project — two people on one badge is a defect, not a
 * configuration choice.
 */
export const siteAccessPasses = pgTable(
  "site_access_passes",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    inductionId: text("induction_id"),
    workerId: text("worker_id"),
    personName: text("person_name").notNull(),
    personKind: text("person_kind").default("worker").notNull(), // SitePersonKind
    vendorId: text("vendor_id"),
    badgeCode: text("badge_code").notNull(),
    credentialType: text("credential_type").default("badge").notNull(), // SiteCredentialType
    status: text("status").default("active").notNull(), // SitePassStatus
    validFrom: text("valid_from"),
    validUntil: text("valid_until"),
    /** exclusion-zone / location ids the holder may enter; empty = whole site */
    zonesAllowed: jsonb("zones_allowed").$type<string[]>().default([]).notNull(),
    issuedBy: text("issued_by"),
    issuedAt: ts("issued_at"),
    revokedAt: ts("revoked_at"),
    revokedBy: text("revoked_by"),
    revokeReason: text("revoke_reason"),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("site_passes_badge_uq").on(t.projectId, t.badgeCode),
    index("site_passes_project_idx").on(t.projectId, t.status),
    index("site_passes_worker_idx").on(t.projectId, t.workerId),
    index("site_passes_expiry_idx").on(t.status, t.validUntil),
  ],
);

/**
 * One read at a gate. This is a machine feed: readers POST batches, so
 * `externalRef` carries the device's own id for the event and is unique per
 * project, making a replayed batch a no-op rather than a doubled headcount.
 */
export const siteGateEvents = pgTable(
  "site_gate_events",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    gateName: text("gate_name").default("main").notNull(),
    deviceId: text("device_id"),
    passId: text("pass_id"),
    workerId: text("worker_id"),
    badgeCode: text("badge_code"),
    personName: text("person_name"),
    personKind: text("person_kind"), // SitePersonKind
    vendorId: text("vendor_id"),
    direction: text("direction").notNull(), // SiteGateDirection
    occurredAt: ts("occurred_at").notNull(),
    source: text("source").default("turnstile").notNull(), // SiteGateSource
    /** 1 = the reader let them through; 0 = refused, with a reason */
    accepted: integer("accepted").default(1).notNull(),
    refusalReason: text("refusal_reason"), // SiteGateRefusal
    zoneId: text("zone_id"),
    lat: doublePrecision("lat"),
    lon: doublePrecision("lon"),
    /** the device's own event id — the dedupe key for a replayed batch */
    externalRef: text("external_ref"),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("site_gate_events_external_uq").on(t.projectId, t.externalRef),
    index("site_gate_events_project_time_idx").on(t.projectId, t.occurredAt),
    index("site_gate_events_pass_idx").on(t.projectId, t.passId, t.occurredAt),
    index("site_gate_events_badge_idx").on(t.projectId, t.badgeCode, t.occurredAt),
    index("site_gate_events_company_idx").on(t.companyId, t.occurredAt),
  ],
);

/** An emergency headcount: the register says N are inside, the muster point
 *  counted M, and the difference is a list of names, not a number. */
export const siteMusters = pgTable(
  "site_musters",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    kind: text("kind").default("drill").notNull(), // SiteMusterKind
    musterPoint: text("muster_point"),
    declaredAt: ts("declared_at").notNull(),
    declaredBy: text("declared_by").notNull(),
    status: text("status").default("open").notNull(), // SiteMusterStatus
    /** snapshot of the on-site register at declaration — the assertion side */
    expectedCount: integer("expected_count").default(0).notNull(),
    accountedCount: integer("accounted_count").default(0).notNull(),
    unaccountedCount: integer("unaccounted_count").default(0).notNull(),
    unexpectedCount: integer("unexpected_count").default(0).notNull(),
    expectedRegister: jsonb("expected_register")
      .$type<Array<{ key: string; name: string; passId: string | null; workerId: string | null; sinceAt: string | null }>>()
      .default([])
      .notNull(),
    clearedAt: ts("cleared_at"),
    reconciledAt: ts("reconciled_at"),
    reconciledBy: text("reconciled_by"),
    durationSeconds: doublePrecision("duration_seconds"),
    signalId: text("signal_id"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("site_musters_ref_uq").on(t.projectId, t.reference),
    index("site_musters_project_idx").on(t.projectId, t.status),
    index("site_musters_declared_idx").on(t.projectId, t.declaredAt),
  ],
);

/** One person checked in (or not) at a muster. */
export const siteMusterCheckins = pgTable(
  "site_muster_checkins",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    musterId: text("muster_id").notNull(),
    /** stable identity across the register: passId, workerId or badge code */
    personKey: text("person_key").notNull(),
    personName: text("person_name").notNull(),
    passId: text("pass_id"),
    workerId: text("worker_id"),
    status: text("status").default("present").notNull(), // SiteMusterPersonStatus
    /** 1 when the person was NOT on the register but turned up at the point */
    unexpected: integer("unexpected").default(0).notNull(),
    method: text("method").default("manual").notNull(),
    checkedInAt: ts("checked_in_at"),
    checkedInBy: text("checked_in_by"),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("site_muster_checkins_uq").on(t.musterId, t.personKey),
    index("site_muster_checkins_muster_idx").on(t.musterId, t.status),
    index("site_muster_checkins_project_idx").on(t.projectId),
  ],
);

/* ------------------------------------------------------------------ */
/* Permits to work, exclusion zones, lone working (#1070–1073)         */
/* ------------------------------------------------------------------ */

export const sitePermits = pgTable(
  "site_permits",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    permitType: text("permit_type").notNull(), // SitePermitType
    title: text("title").notNull(),
    description: text("description"),
    locationId: text("location_id"),
    locationDescription: text("location_description"),
    exclusionZoneId: text("exclusion_zone_id"),
    vendorId: text("vendor_id"),
    supervisorName: text("supervisor_name"),
    status: text("status").default("draft").notNull(), // SitePermitStatus
    validFrom: ts("valid_from"),
    validTo: ts("valid_to"),
    requestedBy: text("requested_by").notNull(),
    requestedAt: ts("requested_at"),
    /** the approver may never be the requester — segregation of duties */
    approvedBy: text("approved_by"),
    approvedAt: ts("approved_at"),
    rejectedBy: text("rejected_by"),
    rejectedAt: ts("rejected_at"),
    rejectionReason: text("rejection_reason"),
    issuedAt: ts("issued_at"),
    suspendedAt: ts("suspended_at"),
    suspendReason: text("suspend_reason"),
    closedBy: text("closed_by"),
    closedAt: ts("closed_at"),
    closureNotes: text("closure_notes"),
    expiredAt: ts("expired_at"),
    precautions: jsonb("precautions")
      .$type<Array<{ item: string; required: boolean; done: boolean; note?: string }>>()
      .default([])
      .notNull(),
    isolations: jsonb("isolations")
      .$type<Array<{ ref: string; description: string; appliedAt?: string; removedAt?: string }>>()
      .default([])
      .notNull(),
    /** confined space */
    maxOccupancy: integer("max_occupancy"),
    requiresGasTest: integer("requires_gas_test").default(0).notNull(),
    gasTestIntervalMinutes: integer("gas_test_interval_minutes"),
    /** hot work */
    fireWatchMinutes: integer("fire_watch_minutes"),
    fireWatchCompletedAt: ts("fire_watch_completed_at"),
    /** excavation: the utility survey that must exist before it goes active */
    utilityScanId: text("utility_scan_id"),
    riskAssessmentRef: text("risk_assessment_ref"),
    /** safety module method statement / JHA, when one is held */
    safetyRecordId: text("safety_record_id"),
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    signalId: text("signal_id"),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("site_permits_ref_uq").on(t.projectId, t.reference),
    index("site_permits_project_status_idx").on(t.projectId, t.status),
    index("site_permits_validity_idx").on(t.status, t.validTo),
    index("site_permits_type_idx").on(t.projectId, t.permitType, t.status),
    index("site_permits_company_idx").on(t.companyId, t.status),
  ],
);

/** Live entry/exit under a permit — who is inside the confined space now. */
export const sitePermitEntries = pgTable(
  "site_permit_entries",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    permitId: text("permit_id").notNull(),
    personName: text("person_name").notNull(),
    workerId: text("worker_id"),
    passId: text("pass_id"),
    attendantName: text("attendant_name"),
    enteredAt: ts("entered_at").notNull(),
    expectedExitAt: ts("expected_exit_at"),
    exitedAt: ts("exited_at"),
    status: text("status").default("inside").notNull(), // SitePermitEntryStatus
    overdueAt: ts("overdue_at"),
    gasReadings: jsonb("gas_readings")
      .$type<Array<{ at: string; gas: string; value: number; unit: string; safe: boolean }>>()
      .default([])
      .notNull(),
    signalId: text("signal_id"),
    notes: text("notes"),
    recordedBy: text("recorded_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("site_permit_entries_permit_idx").on(t.permitId, t.status),
    index("site_permit_entries_project_idx").on(t.projectId, t.status),
    index("site_permit_entries_overdue_idx").on(t.status, t.expectedExitAt),
  ],
);

/**
 * A closed polygon on the ground that people must stay out of. `ring` is a
 * list of [lon, lat]; point-in-polygon is computed in the module, not the
 * database, so the same code answers "is this gate event inside a live lift".
 */
export const siteExclusionZones = pgTable(
  "site_exclusion_zones",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").default("other").notNull(), // SiteExclusionZoneKind
    permitId: text("permit_id"),
    ring: jsonb("ring").$type<SiteRing>().default([]).notNull(),
    /** circular zones: centre + radius instead of a ring */
    centreLat: doublePrecision("centre_lat"),
    centreLon: doublePrecision("centre_lon"),
    radiusM: doublePrecision("radius_m"),
    status: text("status").default("planned").notNull(), // SiteExclusionZoneStatus
    severity: text("severity").default("high").notNull(), // SignalSeverity
    activeFrom: ts("active_from"),
    activeTo: ts("active_to"),
    liftedAt: ts("lifted_at"),
    liftedBy: text("lifted_by"),
    description: text("description"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("site_zones_project_idx").on(t.projectId, t.status),
    index("site_zones_active_idx").on(t.status, t.activeTo),
    index("site_zones_permit_idx").on(t.permitId),
  ],
);

/** A lone worker with a due check-in. Missing one is the whole point. */
export const siteLoneWorkerSessions = pgTable(
  "site_lone_worker_sessions",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    workerId: text("worker_id"),
    passId: text("pass_id"),
    personName: text("person_name").notNull(),
    activity: text("activity").notNull(),
    locationId: text("location_id"),
    locationDescription: text("location_description"),
    lat: doublePrecision("lat"),
    lon: doublePrecision("lon"),
    startedAt: ts("started_at").notNull(),
    intervalMinutes: integer("interval_minutes").default(30).notNull(),
    nextDueAt: ts("next_due_at").notNull(),
    lastCheckInAt: ts("last_check_in_at"),
    checkInCount: integer("check_in_count").default(0).notNull(),
    missedCount: integer("missed_count").default(0).notNull(),
    expectedEndAt: ts("expected_end_at"),
    status: text("status").default("active").notNull(), // SiteLoneWorkerStatus
    escalatedAt: ts("escalated_at"),
    escalationSignalId: text("escalation_signal_id"),
    completedAt: ts("completed_at"),
    completedBy: text("completed_by"),
    contactName: text("contact_name"),
    contactPhone: text("contact_phone"),
    /** who to tell when a check-in is missed */
    watcherUserIds: jsonb("watcher_user_ids").$type<string[]>().default([]).notNull(),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("site_lone_worker_project_idx").on(t.projectId, t.status),
    index("site_lone_worker_due_idx").on(t.status, t.nextDueAt),
    index("site_lone_worker_company_idx").on(t.companyId, t.status),
  ],
);

/** Each check-in, kept so a session's history survives the session. */
export const siteLoneWorkerCheckins = pgTable(
  "site_lone_worker_checkins",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    sessionId: text("session_id").notNull(),
    checkedInAt: ts("checked_in_at").notNull(),
    dueAt: ts("due_at"),
    lateSeconds: doublePrecision("late_seconds"),
    lat: doublePrecision("lat"),
    lon: doublePrecision("lon"),
    method: text("method").default("mobile").notNull(),
    ok: integer("ok").default(1).notNull(),
    note: text("note"),
    recordedBy: text("recorded_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("site_lw_checkins_session_idx").on(t.sessionId, t.checkedInAt),
    index("site_lw_checkins_project_idx").on(t.projectId),
  ],
);

/* ------------------------------------------------------------------ */
/* Weather archive & exceptional-weather analysis (#1074–1076)         */
/* ------------------------------------------------------------------ */

export const siteWeatherObservations = pgTable(
  "site_weather_observations",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    observedOn: text("observed_on").notNull(), // ISO date
    source: text("source").default("manual").notNull(), // SiteWeatherSource
    provider: text("provider"),
    stationRef: text("station_ref"),
    tempMinC: doublePrecision("temp_min_c"),
    tempMaxC: doublePrecision("temp_max_c"),
    tempMeanC: doublePrecision("temp_mean_c"),
    precipitationMm: doublePrecision("precipitation_mm"),
    snowfallMm: doublePrecision("snowfall_mm"),
    windMeanKph: doublePrecision("wind_mean_kph"),
    windGustKph: doublePrecision("wind_gust_kph"),
    humidityPct: doublePrecision("humidity_pct"),
    visibilityM: doublePrecision("visibility_m"),
    seaStateM: doublePrecision("sea_state_m"),
    conditions: text("conditions"),
    /** what the site reported, independent of the numbers */
    workStopped: integer("work_stopped").default(0).notNull(),
    hoursLost: doublePrecision("hours_lost"),
    affectedActivities: jsonb("affected_activities").$type<string[]>().default([]).notNull(),
    /** set by the analysis: did this day breach the baseline thresholds */
    adverse: integer("adverse"),
    adverseReasons: jsonb("adverse_reasons").$type<string[]>().default([]).notNull(),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    recordedBy: text("recorded_by"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("site_weather_obs_uq").on(t.projectId, t.observedOn, t.source),
    index("site_weather_obs_project_idx").on(t.projectId, t.observedOn),
    index("site_weather_obs_company_idx").on(t.companyId, t.observedOn),
  ],
);

/**
 * The contract's definition of "exceptional". Thresholds are the measurable
 * tests; `monthlyExpectedAdverseDays` is the number of adverse days the
 * contract or the met records say a normal month contains.
 */
export const siteWeatherBaselines = pgTable(
  "site_weather_baselines",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    source: text("source").default("contract").notNull(), // SiteWeatherBaselineSource
    contractRef: text("contract_ref"),
    method: text("method"),
    periodStart: text("period_start"),
    periodEnd: text("period_end"),
    thresholds: jsonb("thresholds")
      .$type<Array<{ metric: string; comparator: string; value: number; label?: string }>>()
      .default([])
      .notNull(),
    /** month number "1".."12" → expected adverse days in a normal year */
    monthlyExpectedAdverseDays: jsonb("monthly_expected_adverse_days")
      .$type<Record<string, number>>()
      .default({})
      .notNull(),
    isActive: integer("is_active").default(1).notNull(),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("site_weather_baselines_project_idx").on(t.projectId, t.isActive),
  ],
);

/** The claim-ready output: observed adverse days versus the baseline, month by
 *  month, with the breached threshold quoted for every day counted. */
export const siteWeatherAnalyses = pgTable(
  "site_weather_analyses",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    baselineId: text("baseline_id").notNull(),
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),
    status: text("status").default("draft").notNull(), // SiteWeatherAnalysisStatus
    daysInPeriod: integer("days_in_period").default(0).notNull(),
    daysObserved: integer("days_observed").default(0).notNull(),
    observedAdverseDays: doublePrecision("observed_adverse_days"),
    baselineAdverseDays: doublePrecision("baseline_adverse_days"),
    exceptionalDays: doublePrecision("exceptional_days"),
    hoursLost: doublePrecision("hours_lost"),
    coveragePercent: doublePrecision("coverage_percent"),
    byMonth: jsonb("by_month")
      .$type<Array<{ month: string; days: number; observed: number; expected: number | null; exceptional: number | null; reasons: string[] }>>()
      .default([])
      .notNull(),
    adverseDayDetail: jsonb("adverse_day_detail")
      .$type<Array<{ date: string; reasons: string[]; hoursLost: number | null; workStopped: boolean }>>()
      .default([])
      .notNull(),
    reasons: jsonb("reasons").$type<string[]>().default([]).notNull(),
    /** forensics link: the delay event this analysis supports */
    delayEventId: text("delay_event_id"),
    issuedAt: ts("issued_at"),
    issuedBy: text("issued_by"),
    supersededById: text("superseded_by_id"),
    notes: text("notes"),
    generatedBy: text("generated_by").notNull(),
    generatedAt: ts("generated_at").defaultNow().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("site_weather_analyses_ref_uq").on(t.projectId, t.reference),
    index("site_weather_analyses_project_idx").on(t.projectId, t.status),
    index("site_weather_analyses_period_idx").on(t.projectId, t.periodStart, t.periodEnd),
  ],
);

/* ------------------------------------------------------------------ */
/* Reality capture (#1077–1080)                                        */
/* ------------------------------------------------------------------ */

export const siteDroneFlights = pgTable(
  "site_drone_flights",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    purpose: text("purpose").default("progress").notNull(), // SiteFlightPurpose
    status: text("status").default("planned").notNull(), // SiteFlightStatus
    pilotName: text("pilot_name"),
    pilotLicenceRef: text("pilot_licence_ref"),
    operatorVendorId: text("operator_vendor_id"),
    aircraft: text("aircraft"),
    plannedFor: ts("planned_for"),
    flownAt: ts("flown_at"),
    durationMinutes: doublePrecision("duration_minutes"),
    permissionStatus: text("permission_status").default("pending").notNull(), // SiteFlightPermission
    permissionRef: text("permission_ref"),
    airspaceNotes: text("airspace_notes"),
    maxAltitudeM: doublePrecision("max_altitude_m"),
    areaCoveredM2: doublePrecision("area_covered_m2"),
    imageCount: integer("image_count"),
    weatherObservationId: text("weather_observation_id"),
    riskAssessmentRef: text("risk_assessment_ref"),
    groundedReason: text("grounded_reason"),
    outputs: jsonb("outputs")
      .$type<Array<{ kind: string; fileId?: string; ref?: string; note?: string }>>()
      .default([])
      .notNull(),
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("site_flights_ref_uq").on(t.projectId, t.reference),
    index("site_flights_project_idx").on(t.projectId, t.status),
    index("site_flights_planned_idx").on(t.projectId, t.plannedFor),
  ],
);

export const siteScans = pgTable(
  "site_scans",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    name: text("name").notNull(),
    method: text("method").default("terrestrial_laser").notNull(), // SiteScanMethod
    status: text("status").default("planned").notNull(), // SiteScanStatus
    capturedAt: ts("captured_at"),
    capturedByName: text("captured_by_name"),
    vendorId: text("vendor_id"),
    locationId: text("location_id"),
    areaDescription: text("area_description"),
    droneFlightId: text("drone_flight_id"),
    setupCount: integer("setup_count"),
    pointCountMillions: doublePrecision("point_count_millions"),
    sizeMb: doublePrecision("size_mb"),
    coordinateSystem: text("coordinate_system"),
    registrationStatus: text("registration_status").default("unregistered").notNull(), // SiteScanRegistrationStatus
    registrationErrorMm: doublePrecision("registration_error_mm"),
    controlPointRefs: jsonb("control_point_refs").$type<string[]>().default([]).notNull(),
    /** bim.models row this scan is compared against */
    modelId: text("model_id"),
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("site_scans_ref_uq").on(t.projectId, t.reference),
    index("site_scans_project_idx").on(t.projectId, t.status),
    index("site_scans_captured_idx").on(t.projectId, t.capturedAt),
  ],
);

/** Scan-versus-model: per-element deviations, rolled up per zone, with the
 *  tolerance the verdict was reached against stored alongside it. */
export const siteScanDeviations = pgTable(
  "site_scan_deviations",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    scanId: text("scan_id").notNull(),
    modelId: text("model_id"),
    modelVersion: text("model_version"),
    reference: text("reference").notNull(),
    number: integer("number").notNull(),
    method: text("method").default("cloud_to_mesh").notNull(),
    toleranceMm: doublePrecision("tolerance_mm").notNull(),
    marginalFactor: doublePrecision("marginal_factor").default(0.8).notNull(),
    elementCount: integer("element_count").default(0).notNull(),
    withinToleranceCount: integer("within_tolerance_count").default(0).notNull(),
    marginalCount: integer("marginal_count").default(0).notNull(),
    outOfToleranceCount: integer("out_of_tolerance_count").default(0).notNull(),
    maxDeviationMm: doublePrecision("max_deviation_mm"),
    meanAbsDeviationMm: doublePrecision("mean_abs_deviation_mm"),
    rmsDeviationMm: doublePrecision("rms_deviation_mm"),
    verdict: text("verdict").default("not_assessable").notNull(), // SiteDeviationVerdict
    status: text("status").default("draft").notNull(), // SiteDeviationStatus
    byZone: jsonb("by_zone")
      .$type<Array<{ zone: string; elements: number; outOfTolerance: number; maxDeviationMm: number | null; verdict: string }>>()
      .default([])
      .notNull(),
    items: jsonb("items")
      .$type<Array<{ elementId: string; elementName?: string; zone?: string; deviationMm: number; verdict: string }>>()
      .default([])
      .notNull(),
    reasons: jsonb("reasons").$type<string[]>().default([]).notNull(),
    signalId: text("signal_id"),
    acceptedBy: text("accepted_by"),
    acceptedAt: ts("accepted_at"),
    notes: text("notes"),
    generatedBy: text("generated_by").notNull(),
    generatedAt: ts("generated_at").defaultNow().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("site_deviations_ref_uq").on(t.projectId, t.reference),
    index("site_deviations_scan_idx").on(t.scanId),
    index("site_deviations_project_idx").on(t.projectId, t.status),
  ],
);

export const sitePhotoTours = pgTable(
  "site_photo_tours",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    capturedAt: ts("captured_at"),
    capturedByName: text("captured_by_name"),
    locationId: text("location_id"),
    level: text("level"),
    status: text("status").default("draft").notNull(), // SiteTourStatus
    stationCount: integer("station_count").default(0).notNull(),
    coverageNotes: text("coverage_notes"),
    scanId: text("scan_id"),
    droneFlightId: text("drone_flight_id"),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("site_tours_project_idx").on(t.projectId, t.status),
    index("site_tours_captured_idx").on(t.projectId, t.capturedAt),
  ],
);

export const sitePhotoTourStations = pgTable(
  "site_photo_tour_stations",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    tourId: text("tour_id").notNull(),
    name: text("name").notNull(),
    sequence: integer("sequence").default(0).notNull(),
    capturedAt: ts("captured_at"),
    fileId: text("file_id"),
    photoId: text("photo_id"),
    lat: doublePrecision("lat"),
    lon: doublePrecision("lon"),
    elevationM: doublePrecision("elevation_m"),
    headingDeg: doublePrecision("heading_deg"),
    locationId: text("location_id"),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [
    index("site_tour_stations_tour_idx").on(t.tourId, t.sequence),
    index("site_tour_stations_project_idx").on(t.projectId),
  ],
);

/* ------------------------------------------------------------------ */
/* Survey control & setting out (#1081)                                */
/* ------------------------------------------------------------------ */

export const siteSurveyPoints = pgTable(
  "site_survey_points",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    pointRef: text("point_ref").notNull(),
    kind: text("kind").default("control").notNull(), // SiteSurveyPointKind
    easting: doublePrecision("easting"),
    northing: doublePrecision("northing"),
    elevation: doublePrecision("elevation"),
    lat: doublePrecision("lat"),
    lon: doublePrecision("lon"),
    coordinateSystem: text("coordinate_system"),
    datum: text("datum"),
    method: text("method").default("gnss").notNull(), // SiteSurveyMethod
    accuracyMm: doublePrecision("accuracy_mm"),
    establishedByName: text("established_by_name"),
    establishedAt: ts("established_at"),
    status: text("status").default("active").notNull(), // SiteSurveyPointStatus
    lastCheckedAt: ts("last_checked_at"),
    lastCheckedBy: text("last_checked_by"),
    lastDeltaMm: doublePrecision("last_delta_mm"),
    supersededById: text("superseded_by_id"),
    description: text("description"),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("site_survey_points_uq").on(t.projectId, t.pointRef),
    index("site_survey_points_project_idx").on(t.projectId, t.status),
    index("site_survey_points_kind_idx").on(t.projectId, t.kind),
  ],
);

export const siteSettingOutRecords = pgTable(
  "site_setting_out_records",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    description: text("description").notNull(),
    elementRef: text("element_ref"),
    locationId: text("location_id"),
    scheduleTaskId: text("schedule_task_id"),
    drawingId: text("drawing_id"),
    drawingRevision: text("drawing_revision"),
    method: text("method").default("total_station").notNull(), // SiteSurveyMethod
    controlPointRefs: jsonb("control_point_refs").$type<string[]>().default([]).notNull(),
    toleranceMm: doublePrecision("tolerance_mm"),
    maxDeviationMm: doublePrecision("max_deviation_mm"),
    setOutBy: text("set_out_by").notNull(),
    setOutByName: text("set_out_by_name"),
    setOutAt: ts("set_out_at"),
    /** the checker may never be the person who set the work out */
    checkedBy: text("checked_by"),
    checkedByName: text("checked_by_name"),
    checkedAt: ts("checked_at"),
    approvedBy: text("approved_by"),
    approvedAt: ts("approved_at"),
    status: text("status").default("draft").notNull(), // SiteSettingOutStatus
    rejectionReason: text("rejection_reason"),
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("site_setting_out_ref_uq").on(t.projectId, t.reference),
    index("site_setting_out_project_idx").on(t.projectId, t.status),
    index("site_setting_out_task_idx").on(t.projectId, t.scheduleTaskId),
  ],
);

/* ------------------------------------------------------------------ */
/* Ground conditions & buried utilities (#1082–1083)                   */
/* ------------------------------------------------------------------ */

export const siteGeotechInvestigations = pgTable(
  "site_geotech_investigations",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    holeRef: text("hole_ref").notNull(),
    kind: text("kind").default("borehole").notNull(), // SiteGeotechKind
    status: text("status").default("planned").notNull(), // SiteGeotechStatus
    /** 1 = part of the contractual baseline ground model (the GBR) */
    isBaseline: integer("is_baseline").default(0).notNull(),
    baselineInvestigationId: text("baseline_investigation_id"),
    contractorVendorId: text("contractor_vendor_id"),
    investigatedOn: text("investigated_on"),
    locationDescription: text("location_description"),
    lat: doublePrecision("lat"),
    lon: doublePrecision("lon"),
    easting: doublePrecision("easting"),
    northing: doublePrecision("northing"),
    groundLevelM: doublePrecision("ground_level_m"),
    depthM: doublePrecision("depth_m"),
    waterStrikeDepthM: doublePrecision("water_strike_depth_m"),
    strata: jsonb("strata")
      .$type<Array<{ fromM: number; toM: number; description: string; soilType?: string; spt?: number; strengthKpa?: number }>>()
      .default([])
      .notNull(),
    labTestRefs: jsonb("lab_test_refs").$type<string[]>().default([]).notNull(),
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("site_geotech_ref_uq").on(t.projectId, t.reference),
    index("site_geotech_project_idx").on(t.projectId, t.status),
    index("site_geotech_baseline_idx").on(t.projectId, t.isBaseline),
    index("site_geotech_hole_idx").on(t.projectId, t.holeRef),
  ],
);

/** What was found that the baseline did not say — the ground-conditions claim
 *  in record form, one finding per differing depth interval. */
export const siteGroundFindings = pgTable(
  "site_ground_findings",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    investigationId: text("investigation_id").notNull(),
    baselineInvestigationId: text("baseline_investigation_id"),
    category: text("category").notNull(), // SiteGroundFindingCategory
    severity: text("severity").default("medium").notNull(), // SignalSeverity
    depthFromM: doublePrecision("depth_from_m"),
    depthToM: doublePrecision("depth_to_m"),
    baselineDescription: text("baseline_description"),
    observedDescription: text("observed_description").notNull(),
    differsFromBaseline: integer("differs_from_baseline").default(1).notNull(),
    varianceNotes: text("variance_notes"),
    detectedAt: ts("detected_at").defaultNow().notNull(),
    detectionMethod: text("detection_method").default("comparison").notNull(),
    status: text("status").default("open").notNull(), // SiteGroundFindingStatus
    assessedBy: text("assessed_by"),
    assessedAt: ts("assessed_at"),
    assessmentNotes: text("assessment_notes"),
    changeEventId: text("change_event_id"),
    signalId: text("signal_id"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("site_ground_findings_project_idx").on(t.projectId, t.status),
    index("site_ground_findings_investigation_idx").on(t.investigationId),
    index("site_ground_findings_category_idx").on(t.projectId, t.category),
  ],
);

export const siteUtilityServices = pgTable(
  "site_utility_services",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    serviceRef: text("service_ref").notNull(),
    utilityType: text("utility_type").default("unknown").notNull(), // SiteUtilityType
    ownerName: text("owner_name"),
    specification: text("specification"),
    depthM: doublePrecision("depth_m"),
    /** polyline of [lon, lat] along the recorded route */
    route: jsonb("route").$type<SiteRing>().default([]).notNull(),
    detectionMethod: text("detection_method").default("records").notNull(), // SiteUtilityDetectionMethod
    confidence: text("confidence").default("unknown").notNull(), // SiteUtilityConfidence
    surveyScanId: text("survey_scan_id"),
    markedOutAt: ts("marked_out_at"),
    markedOutByName: text("marked_out_by_name"),
    markValidUntil: text("mark_valid_until"),
    status: text("status").default("unknown").notNull(), // SiteUtilityStatus
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("site_utility_services_uq").on(t.projectId, t.serviceRef),
    index("site_utility_services_project_idx").on(t.projectId, t.status),
    index("site_utility_services_type_idx").on(t.projectId, t.utilityType),
  ],
);

export const siteUtilityStrikes = pgTable(
  "site_utility_strikes",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    occurredAt: ts("occurred_at").notNull(),
    utilityType: text("utility_type").default("unknown").notNull(), // SiteUtilityType
    serviceId: text("service_id"),
    permitId: text("permit_id"),
    severity: text("severity").default("near_miss").notNull(), // SiteStrikeSeverity
    status: text("status").default("reported").notNull(), // SiteStrikeStatus
    locationDescription: text("location_description"),
    lat: doublePrecision("lat"),
    lon: doublePrecision("lon"),
    depthM: doublePrecision("depth_m"),
    injuries: integer("injuries").default(0).notNull(),
    servicesLost: text("services_lost"),
    contractorVendorId: text("contractor_vendor_id"),
    operativeName: text("operative_name"),
    plantType: text("plant_type"),
    /** the three controls whose absence is the whole story */
    permitInPlace: integer("permit_in_place").default(0).notNull(),
    scanCompleted: integer("scan_completed").default(0).notNull(),
    marksPresent: integer("marks_present").default(0).notNull(),
    rootCause: text("root_cause"),
    immediateActions: text("immediate_actions"),
    reportedToOwnerAt: ts("reported_to_owner_at"),
    costEstimate: doublePrecision("cost_estimate"),
    currency: text("currency").default("USD").notNull(),
    /** safety.incidents row when one was raised */
    incidentId: text("incident_id"),
    signalId: text("signal_id"),
    closedAt: ts("closed_at"),
    closedBy: text("closed_by"),
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("site_strikes_ref_uq").on(t.projectId, t.reference),
    index("site_strikes_project_idx").on(t.projectId, t.status),
    index("site_strikes_occurred_idx").on(t.projectId, t.occurredAt),
  ],
);

/* ------------------------------------------------------------------ */
/* Environmental / seismic / tidal event log (#1084)                   */
/* ------------------------------------------------------------------ */

export const siteEnvironmentalEvents = pgTable(
  "site_environmental_events",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    category: text("category").notNull(), // SiteEnvironmentalCategory
    detectedVia: text("detected_via").default("observation").notNull(), // SiteEnvironmentalDetection
    occurredAt: ts("occurred_at").notNull(),
    durationMinutes: doublePrecision("duration_minutes"),
    magnitude: doublePrecision("magnitude"),
    magnitudeUnit: text("magnitude_unit"),
    thresholdValue: doublePrecision("threshold_value"),
    thresholdUnit: text("threshold_unit"),
    exceededThreshold: integer("exceeded_threshold").default(0).notNull(),
    severity: text("severity").default("low").notNull(), // SignalSeverity
    status: text("status").default("open").notNull(), // SiteEnvironmentalStatus
    locationId: text("location_id"),
    zoneId: text("zone_id"),
    lat: doublePrecision("lat"),
    lon: doublePrecision("lon"),
    sensorRef: text("sensor_ref"),
    impact: text("impact"),
    workStopped: integer("work_stopped").default(0).notNull(),
    stoppageMinutes: doublePrecision("stoppage_minutes"),
    actionsTaken: text("actions_taken"),
    weatherObservationId: text("weather_observation_id"),
    /** assurance.events row raised for the platform-wide occurrence log */
    assuranceEventId: text("assurance_event_id"),
    signalId: text("signal_id"),
    closedAt: ts("closed_at"),
    closedBy: text("closed_by"),
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    notes: text("notes"),
    reportedByName: text("reported_by_name"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("site_env_events_ref_uq").on(t.projectId, t.reference),
    index("site_env_events_project_idx").on(t.projectId, t.status),
    index("site_env_events_occurred_idx").on(t.projectId, t.occurredAt),
    index("site_env_events_category_idx").on(t.projectId, t.category),
  ],
);

/* ------------------------------------------------------------------ */
/* Progress determination (#995–1003)                                  */
/* ------------------------------------------------------------------ */

/**
 * A claimed percentage and an independently observed one for the same zone.
 * The row is a pointer into the assurance primitives: `assertionId` is the
 * claim, `evidenceId` the observation, `reconciliationId` the verdict. The
 * different-actor rule is enforced when the row is created — the observer may
 * not be the claimant, and the module refuses rather than recording a
 * self-verified claim.
 */
export const siteProgressObservations = pgTable(
  "site_progress_observations",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    zoneName: text("zone_name").notNull(),
    locationId: text("location_id"),
    scheduleTaskId: text("schedule_task_id"),
    workPackageRef: text("work_package_ref"),
    claimedPercent: doublePrecision("claimed_percent").notNull(),
    observedPercent: doublePrecision("observed_percent").notNull(),
    variancePercent: doublePrecision("variance_percent").notNull(),
    method: text("method").default("visual").notNull(), // SiteProgressMethod
    observedAt: ts("observed_at").notNull(),
    /** the user who observed — never the claimant */
    observedBy: text("observed_by").notNull(),
    observedByName: text("observed_by_name"),
    claimSourceType: text("claim_source_type").default("manual").notNull(), // SiteProgressClaimSource
    claimSourceId: text("claim_source_id"),
    claimantId: text("claimant_id").notNull(),
    claimantKind: text("claimant_kind").default("user").notNull(),
    claimedAt: ts("claimed_at"),
    scanId: text("scan_id"),
    droneFlightId: text("drone_flight_id"),
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    assertionId: text("assertion_id").notNull(),
    evidenceId: text("evidence_id").notNull(),
    reconciliationId: text("reconciliation_id").notNull(),
    result: text("result").notNull(), // ReconciliationResult
    confidence: doublePrecision("confidence"),
    independenceScore: doublePrecision("independence_score"),
    signalId: text("signal_id"),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("site_progress_obs_ref_uq").on(t.projectId, t.reference),
    index("site_progress_obs_project_idx").on(t.projectId, t.observedAt),
    index("site_progress_obs_result_idx").on(t.projectId, t.result),
    index("site_progress_obs_task_idx").on(t.projectId, t.scheduleTaskId),
  ],
);
