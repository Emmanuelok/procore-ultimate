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
 * Multi-currency & multi-jurisdiction operation (spec Vol II Domain K / M19).
 * Internationally financed projects run several currencies simultaneously
 * with contractual exchange mechanics (FIDIC 14.15): a contract fixes
 * currency proportions and a base-date rate; payments are split accordingly
 * and FX gain/loss is reported against the contractual rate.
 */
export const currencyConfigs = pgTable(
  "currency_configs",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    contractId: text("contract_id"),
    baseCurrency: text("base_currency").notNull(),
    baseDate: text("base_date").notNull(),
    /** contractual split: [{ currency, proportionPercent, baseRate }] (#593-595) */
    portions: jsonb("portions").$type<unknown[]>().default([]).notNull(),
    rateSource: text("rate_source").default("contractual").notNull(), // FxRateSource
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("currency_configs_project_idx").on(t.projectId)],
);

/** Dated FX rates with an auditable source (#597). */
export const fxRates = pgTable(
  "fx_rates",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    fromCurrency: text("from_currency").notNull(),
    toCurrency: text("to_currency").notNull(),
    rate: doublePrecision("rate").notNull(),
    rateDate: text("rate_date").notNull(),
    source: text("source").default("manual").notNull(), // FxRateSource
    sourceReference: text("source_reference"),
    recordedBy: text("recorded_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("fx_rates_uq").on(t.companyId, t.fromCurrency, t.toCurrency, t.rateDate, t.source),
    index("fx_rates_pair_idx").on(t.fromCurrency, t.toCurrency, t.rateDate),
  ],
);

/**
 * Permits, consents, visas and clearances (#585-590, #608, #614).
 * Where a permit blocks schedule tasks, delay risk is explicit (#591).
 */
export const permits = pgTable(
  "permits",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    kind: text("kind").notNull(), // PermitKind
    title: text("title").notNull(),
    authority: text("authority").notNull(),
    jurisdiction: text("jurisdiction"),
    reference: text("reference"),
    appliedAt: text("applied_at"),
    /** expected statutory determination period, in days */
    expectedDays: integer("expected_days"),
    dueAt: text("due_at"),
    grantedAt: text("granted_at"),
    expiresAt: text("expires_at"),
    status: text("status").default("not_started").notNull(), // PermitStatus
    /** conditions attached to the grant: [{ id, text, dueDate?, obligationId?, closed }] */
    conditions: jsonb("conditions").$type<unknown[]>().default([]).notNull(),
    /** schedule tasks that cannot start until this permit is granted */
    blockingTaskIds: jsonb("blocking_task_ids").$type<string[]>().default([]).notNull(),
    obligationId: text("obligation_id"),
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    ownerId: text("owner_id"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("permits_uq").on(t.projectId, t.number),
    index("permits_project_idx").on(t.projectId),
    index("permits_status_due_idx").on(t.status, t.dueAt),
  ],
);

/**
 * Local content / in-country value obligations (#612-615) — a contractual
 * condition in resource-nationalist and Gulf jurisdictions, reconciled
 * against actual spend and headcount.
 */
export const localContentTargets = pgTable(
  "local_content_targets",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    jurisdiction: text("jurisdiction").notNull(),
    /** metric: local_spend_percent | local_headcount_percent | icv_score | national_quota */
    metric: text("metric").notNull(),
    targetValue: doublePrecision("target_value").notNull(),
    unit: text("unit").default("%").notNull(),
    periodStart: text("period_start"),
    periodEnd: text("period_end"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("local_content_targets_project_idx").on(t.projectId)],
);

export const localContentReadings = pgTable(
  "local_content_readings",
  {
    id: text("id").primaryKey(),
    targetId: text("target_id").notNull(),
    companyId: text("company_id").notNull(),
    readingDate: text("reading_date").notNull(),
    value: doublePrecision("value").notNull(),
    /** computed at write against the target */
    compliant: integer("compliant").notNull(),
    basis: text("basis"),
    /** manual | computed | certified — how the figure was arrived at */
    source: text("source").default("manual").notNull(), // LocalContentSource
    /** the reporting window the figure covers, when it is a period measure */
    periodStart: text("period_start"),
    periodEnd: text("period_end"),
    /** the source records a computed reading was derived from */
    inputs: jsonb("inputs").$type<Record<string, unknown>>().default({}).notNull(),
    /** a reading is never edited: a correction supersedes it */
    supersededById: text("superseded_by_id"),
    supersedesId: text("supersedes_id"),
    recordedBy: text("recorded_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("local_content_readings_target_idx").on(t.targetId, t.readingDate),
    index("local_content_readings_company_idx").on(t.companyId),
  ],
);

/* ------------------------------------------------------------------ */
/* WP-SAFEG — group entities, consolidation, ICV certificates          */
/* ------------------------------------------------------------------ */

/**
 * Reporting entities for multi-entity consolidation (#600-607).
 *
 * A cross-border programme is delivered through a parent, local
 * subsidiaries, branches and JV vehicles, each with its own FUNCTIONAL
 * currency (IAS 21 para 9: the currency of the primary economic environment
 * it operates in) which is frequently NOT the currency the group reports
 * in. Recording the two separately is what makes a translation auditable —
 * and what makes the IAS 29 hyperinflation question answerable at all.
 */
export const reportingEntities = pgTable(
  "reporting_entities",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    name: text("name").notNull(),
    code: text("code"),
    role: text("role").default("subsidiary").notNull(), // EntityRole
    country: text("country").notNull(),
    /** IAS 21 functional currency of the entity */
    functionalCurrency: text("functional_currency").notNull(),
    /** the currency the group presents in — usually the parent's */
    presentationCurrency: text("presentation_currency").notNull(),
    /** IAS 29: the functional currency is that of a hyperinflationary economy */
    hyperinflationary: integer("hyperinflationary").default(0).notNull(),
    /** general price index series used for IAS 29 restatement: [{ period, index }] */
    priceIndex: jsonb("price_index").$type<unknown[]>().default([]).notNull(),
    parentEntityId: text("parent_entity_id"),
    ownershipPercent: doublePrecision("ownership_percent").default(100).notNull(),
    /** the entity graph node when the entity is also a counterparty */
    entityGraphId: text("entity_graph_id"),
    taxIdentifier: text("tax_identifier"),
    active: integer("active").default(1).notNull(),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("reporting_entities_uq").on(t.companyId, t.name),
    index("reporting_entities_company_idx").on(t.companyId, t.active),
  ],
);

/** Which entity delivers which project, and for what share (#600-603). */
export const entityProjectLinks = pgTable(
  "entity_project_links",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    entityId: text("entity_id").notNull(),
    projectId: text("project_id").notNull(),
    sharePercent: doublePrecision("share_percent").default(100).notNull(),
    role: text("role"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("entity_project_links_uq").on(t.entityId, t.projectId),
    index("entity_project_links_project_idx").on(t.projectId),
  ],
);

/**
 * A consolidation run (#604-607): each entity's position translated into the
 * presentation currency at a stated method and date, with the translation
 * reserve falling out of the difference. Frozen at write, because a
 * consolidation whose numbers move when you reopen it is not a consolidation.
 */
export const consolidationRuns = pgTable(
  "consolidation_runs",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** null = whole company; set = one project's entities */
    projectId: text("project_id"),
    asOf: text("as_of").notNull(),
    presentationCurrency: text("presentation_currency").notNull(),
    method: text("method").default("closing_rate").notNull(), // TranslationMethod
    ias29Applied: integer("ias29_applied").default(0).notNull(),
    /** [{ entityId, name, functionalCurrency, amount, rate, ratePath, rateSource,
     *     translated, restatementFactor, notes }] */
    lines: jsonb("lines").$type<unknown[]>().default([]).notNull(),
    totals: jsonb("totals").$type<Record<string, unknown>>().default({}).notNull(),
    /** entities that could not be translated, and why — never silently zeroed */
    unpriced: jsonb("unpriced").$type<unknown[]>().default([]).notNull(),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("consolidation_runs_company_idx").on(t.companyId, t.asOf),
    index("consolidation_runs_project_idx").on(t.projectId, t.asOf),
  ],
);

/**
 * In-Country Value / local content certificates (#612-615). Gulf ICV and
 * Nigerian NCDMB regimes make the certificate itself the tender currency:
 * an expired one is an exclusion, so the expiry is an Obligation.
 */
export const icvCertificates = pgTable(
  "icv_certificates",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    targetId: text("target_id"),
    /** the certified party — the delivering entity or a vendor */
    entityName: text("entity_name").notNull(),
    vendorId: text("vendor_id"),
    jurisdiction: text("jurisdiction").notNull(),
    issuer: text("issuer").notNull(),
    certificateNumber: text("certificate_number").notNull(),
    score: doublePrecision("score"),
    scoreUnit: text("score_unit").default("%").notNull(),
    issuedAt: text("issued_at").notNull(),
    expiresAt: text("expires_at"),
    status: text("status").default("issued").notNull(), // IcvCertificateStatus
    obligationId: text("obligation_id"),
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    supersededById: text("superseded_by_id"),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("icv_certificates_uq").on(t.projectId, t.issuer, t.certificateNumber),
    index("icv_certificates_project_idx").on(t.projectId, t.status),
    index("icv_certificates_expiry_idx").on(t.status, t.expiresAt),
  ],
);
