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
    recordedBy: text("recorded_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("local_content_readings_target_idx").on(t.targetId)],
);
