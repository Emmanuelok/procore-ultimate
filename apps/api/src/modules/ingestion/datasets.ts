import {
  ASSERTION_KINDS,
  EVIDENCE_KINDS,
  FX_RATE_SOURCES,
  INGESTION_DATASETS,
  RFI_STATUSES,
  type IngestionDataset,
} from "@constructos/shared";

/**
 * M6 — code-resident dataset registry + CSV machinery (spec Vol III M6 /
 * Domain N; Domain Y #1045-1047).
 *
 * Everything in this file is PURE: the registry describes what each ingestion
 * dataset accepts, `coerceRow` turns one raw staged payload into a typed row
 * (or a list of precise reasons why it cannot), and `parseCsv` is a small,
 * correct RFC-4180-style parser. The registry is the single authority the
 * validate step, the push endpoint, and the web mapping UI all read — a field
 * that is not listed here cannot be mapped, staged, or committed.
 */

/* ------------------------------------------------------------------ */
/* Registry types                                                      */
/* ------------------------------------------------------------------ */

export type FieldType = "string" | "number" | "integer" | "date" | "time" | "enum";

export interface DatasetField {
  key: string;
  label: string;
  required: boolean;
  type: FieldType;
  /** for type "enum": the exact accepted values (input is lower-cased first) */
  enumValues?: readonly string[];
  description?: string;
}

export interface DatasetDef {
  dataset: IngestionDataset;
  label: string;
  /** where committed rows land — shown verbatim in the mapping UI */
  target: string;
  /** true = a run for this dataset must carry a projectId */
  requiresProject: boolean;
  /**
   * true = rows are committed by another module through its own inlet, not by
   * this module's writers. The dataset is still a first-class member so tokens
   * can be scoped to it and its runs filtered, but the CSV mapping wizard must
   * not offer it.
   */
  committedElsewhere?: boolean;
  fields: DatasetField[];
  /**
   * Cross-field check run AFTER per-field coercion succeeded. Returns a
   * human-readable rejection message, or null when the row is sound.
   */
  validateRow?: (row: Record<string, unknown>) => string | null;
}

/** Every dataset accepts an optional source-system id for dedupe/provenance. */
const EXTERNAL_ID_FIELD: DatasetField = {
  key: "externalId",
  label: "Source-system ID",
  required: false,
  type: "string",
  description:
    "Identifier of the row in the system it came from. Used to reject duplicates " +
    "within a run and against rows already committed for this dataset.",
};

const SITE_ACCESS_SOURCES = ["turnstile", "biometric", "manual", "gate_log"] as const;
const IMPACT_VALUES = ["yes", "no", "tbd"] as const;

/* ------------------------------------------------------------------ */
/* The registry — one entry per INGESTION_DATASETS member              */
/* ------------------------------------------------------------------ */

export const DATASET_REGISTRY: Record<IngestionDataset, DatasetDef> = {
  vendors: {
    dataset: "vendors",
    label: "Vendors / subcontractor directory",
    target: "Directory vendors (company-wide vendor register)",
    requiresProject: false,
    fields: [
      { key: "name", label: "Vendor name", required: true, type: "string" },
      {
        key: "tradeCodes",
        label: "Trade codes",
        required: false,
        type: "string",
        description: "Comma- or semicolon-separated trade codes",
      },
      { key: "address", label: "Address", required: false, type: "string" },
      { key: "city", label: "City", required: false, type: "string" },
      { key: "country", label: "Country", required: false, type: "string" },
      { key: "phone", label: "Phone", required: false, type: "string" },
      { key: "email", label: "Email", required: false, type: "string" },
      { key: "website", label: "Website", required: false, type: "string" },
      { key: "taxId", label: "Tax ID", required: false, type: "string" },
      { key: "registrationNumber", label: "Registration number", required: false, type: "string" },
      EXTERNAL_ID_FIELD,
    ],
  },

  cost_assertions: {
    dataset: "cost_assertions",
    label: "Cost assertions",
    target: "Assurance assertions (claims to be reconciled against evidence)",
    requiresProject: true,
    fields: [
      {
        key: "kind",
        label: "Assertion kind",
        required: true,
        type: "enum",
        enumValues: ASSERTION_KINDS,
      },
      { key: "value", label: "Asserted value", required: true, type: "number" },
      { key: "unit", label: "Unit", required: false, type: "string" },
      { key: "basis", label: "Basis of the claim", required: true, type: "string" },
      { key: "contractRef", label: "Contract reference", required: false, type: "string" },
      { key: "assertedAt", label: "Asserted on (date)", required: false, type: "date" },
      EXTERNAL_ID_FIELD,
    ],
  },

  site_access: {
    dataset: "site_access",
    label: "Site access records",
    target:
      "Workforce site-access records (the independent evidence stream for " +
      "ghost-worker reconciliation, ADR 0014)",
    requiresProject: true,
    fields: [
      {
        key: "workerReference",
        label: "Worker reference / badge number",
        required: true,
        type: "string",
      },
      { key: "accessDate", label: "Access date", required: true, type: "date" },
      { key: "firstIn", label: "First in (HH:MM)", required: false, type: "time" },
      { key: "lastOut", label: "Last out (HH:MM)", required: false, type: "time" },
      { key: "hoursOnSite", label: "Hours on site", required: false, type: "number" },
      {
        key: "source",
        label: "Capture source",
        required: false,
        type: "enum",
        enumValues: SITE_ACCESS_SOURCES,
        description: "Defaults to turnstile; reviewers discount manual/gate_log",
      },
      EXTERNAL_ID_FIELD,
    ],
    validateRow: (row) => {
      const hours = row["hoursOnSite"];
      if (typeof hours === "number" && (hours < 0 || hours > 24)) {
        return `hoursOnSite ${hours} is outside 0-24`;
      }
      return null;
    },
  },

  payroll: {
    dataset: "payroll",
    label: "Payroll entries",
    target: "Workforce payroll entries (the employer's claim side, ADR 0014)",
    requiresProject: true,
    fields: [
      {
        key: "workerReference",
        label: "Worker reference / badge number",
        required: true,
        type: "string",
      },
      { key: "periodStart", label: "Period start", required: true, type: "date" },
      { key: "periodEnd", label: "Period end", required: true, type: "date" },
      { key: "daysClaimed", label: "Days claimed", required: true, type: "number" },
      { key: "hoursClaimed", label: "Hours claimed", required: false, type: "number" },
      { key: "grossPay", label: "Gross pay", required: true, type: "number" },
      { key: "deductions", label: "Deductions", required: false, type: "number" },
      { key: "netPay", label: "Net pay", required: true, type: "number" },
      { key: "currency", label: "Currency", required: false, type: "string" },
      { key: "paidAt", label: "Paid on (date)", required: false, type: "date" },
      { key: "wpsReference", label: "WPS reference", required: false, type: "string" },
      EXTERNAL_ID_FIELD,
    ],
    validateRow: (row) => {
      const start = row["periodStart"] as string;
      const end = row["periodEnd"] as string;
      if (end < start) return `periodEnd ${end} precedes periodStart ${start}`;
      const gross = row["grossPay"] as number;
      const deductions = (row["deductions"] as number | undefined) ?? 0;
      const net = row["netPay"] as number;
      const expected = gross - deductions;
      if (Math.abs(net - expected) > 0.01) {
        return (
          `netPay ${net} does not equal grossPay ${gross} − deductions ${deductions} ` +
          `(= ${Math.round(expected * 100) / 100}, tolerance ±0.01)`
        );
      }
      return null;
    },
  },

  rfis: {
    dataset: "rfis",
    label: "RFIs",
    target: "Field RFIs (auto-numbered per project on commit)",
    requiresProject: true,
    fields: [
      { key: "subject", label: "Subject", required: true, type: "string" },
      { key: "question", label: "Question", required: true, type: "string" },
      { key: "proposedSolution", label: "Proposed solution", required: false, type: "string" },
      {
        key: "status",
        label: "Status",
        required: false,
        type: "enum",
        enumValues: RFI_STATUSES,
        description: "Defaults to draft, matching the field module",
      },
      { key: "dueDate", label: "Due date", required: false, type: "date" },
      {
        key: "costImpact",
        label: "Cost impact",
        required: false,
        type: "enum",
        enumValues: IMPACT_VALUES,
      },
      {
        key: "scheduleImpact",
        label: "Schedule impact",
        required: false,
        type: "enum",
        enumValues: IMPACT_VALUES,
      },
      EXTERNAL_ID_FIELD,
    ],
  },

  schedule_tasks: {
    dataset: "schedule_tasks",
    label: "Schedule tasks",
    target:
      "Schedule tasks, appended to the project's ACTIVE schedule (commit fails " +
      "honestly if the project has no active schedule; CPM dates are computed by " +
      "the schedule module, not by ingestion)",
    requiresProject: true,
    fields: [
      { key: "name", label: "Task name", required: true, type: "string" },
      { key: "wbsCode", label: "WBS code", required: false, type: "string" },
      {
        key: "durationDays",
        label: "Duration (days)",
        required: false,
        type: "integer",
        description: "0 = milestone; defaults to 1",
      },
      { key: "percentComplete", label: "% complete", required: false, type: "number" },
      { key: "actualStart", label: "Actual start", required: false, type: "date" },
      { key: "actualFinish", label: "Actual finish", required: false, type: "date" },
      EXTERNAL_ID_FIELD,
    ],
    validateRow: (row) => {
      const d = row["durationDays"];
      if (typeof d === "number" && d < 0) return `durationDays ${d} is negative`;
      const pc = row["percentComplete"];
      if (typeof pc === "number" && (pc < 0 || pc > 100)) {
        return `percentComplete ${pc} is outside 0-100`;
      }
      return null;
    },
  },

  evidence: {
    dataset: "evidence",
    label: "Evidence",
    target:
      "Assurance evidence rows. Each committed row is content-hashed " +
      "(hashPayload over the typed payload) with run + file-hash provenance",
    requiresProject: true,
    fields: [
      {
        key: "kind",
        label: "Evidence kind",
        required: true,
        type: "enum",
        enumValues: EVIDENCE_KINDS,
      },
      { key: "source", label: "Source", required: true, type: "string" },
      { key: "capturedAt", label: "Captured on (date)", required: false, type: "date" },
      {
        key: "independenceScore",
        label: "Independence score (0-1)",
        required: false,
        type: "number",
        description: "Self-declared at ingest (ADR 0004); defaults to 0",
      },
      { key: "description", label: "Description", required: false, type: "string" },
      EXTERNAL_ID_FIELD,
    ],
    validateRow: (row) => {
      const s = row["independenceScore"];
      if (typeof s === "number" && (s < 0 || s > 1)) {
        return `independenceScore ${s} is outside 0-1`;
      }
      return null;
    },
  },

  fx_rates: {
    dataset: "fx_rates",
    label: "FX rates",
    target:
      "Jurisdiction FX rates (dated, sourced; duplicates of an existing " +
      "(from, to, date, source) row are skipped, not overwritten)",
    requiresProject: false,
    fields: [
      { key: "fromCurrency", label: "From currency", required: true, type: "string" },
      { key: "toCurrency", label: "To currency", required: true, type: "string" },
      { key: "rate", label: "Rate", required: true, type: "number" },
      { key: "rateDate", label: "Rate date", required: true, type: "date" },
      {
        key: "source",
        label: "Rate source",
        required: false,
        type: "enum",
        enumValues: FX_RATE_SOURCES,
        description: "Defaults to manual",
      },
      { key: "sourceReference", label: "Source reference", required: false, type: "string" },
      EXTERNAL_ID_FIELD,
    ],
    validateRow: (row) => {
      const rate = row["rate"] as number;
      if (rate <= 0) return `rate ${rate} must be positive`;
      const from = row["fromCurrency"] as string;
      const to = row["toCurrency"] as string;
      if (!/^[A-Za-z]{3}$/.test(from)) return `fromCurrency "${from}" is not a 3-letter code`;
      if (!/^[A-Za-z]{3}$/.test(to)) return `toCurrency "${to}" is not a 3-letter code`;
      if (from.toUpperCase() === to.toUpperCase()) {
        return `fromCurrency and toCurrency are both "${from.toUpperCase()}"`;
      }
      return null;
    },
  },

  /**
   * Plant telematics — the one dataset whose rows this module does NOT commit.
   *
   * Readings arrive at POST /ingestion/push/telematics, which the equipment
   * module registers, and land in equipment_telematics_readings idempotent on
   * (providerKey, deviceId, recordedAt). The entry exists here so the dataset
   * behaves like every other one where it matters to an operator: a machine
   * token can be minted with the `telematics` scope, and runs can be filtered
   * to it. `committedElsewhere` marks it so the CSV wizard does not offer a
   * mapping step for a dataset it cannot commit.
   */
  telematics: {
    dataset: "telematics",
    label: "Plant telematics readings",
    target:
      "Equipment telematics readings, committed by the equipment module " +
      "(idempotent on provider + device + timestamp; an unmapped device is " +
      "retained with a null equipmentId rather than dropped)",
    requiresProject: false,
    committedElsewhere: true,
    fields: [
      { key: "deviceId", label: "Device ID", required: true, type: "string" },
      { key: "recordedAt", label: "Recorded at", required: true, type: "date" },
      { key: "providerKey", label: "Provider", required: false, type: "string" },
      { key: "engineHours", label: "Engine hours", required: false, type: "number" },
      { key: "odometerKm", label: "Odometer (km)", required: false, type: "number" },
      { key: "fuelUsedLitres", label: "Fuel used (litres)", required: false, type: "number" },
      { key: "latitude", label: "Latitude", required: false, type: "number" },
      { key: "longitude", label: "Longitude", required: false, type: "number" },
      EXTERNAL_ID_FIELD,
    ],
  },
};

/** Look up a dataset definition; null for names outside INGESTION_DATASETS. */
export function datasetDef(name: string): DatasetDef | null {
  return (INGESTION_DATASETS as readonly string[]).includes(name)
    ? DATASET_REGISTRY[name as IngestionDataset]
    : null;
}

/** Public shape for GET /ingestion/datasets — drives the web mapping UI. */
export function datasetCatalog() {
  return INGESTION_DATASETS.map((name) => {
    const def = DATASET_REGISTRY[name];
    return {
      dataset: def.dataset,
      label: def.label,
      target: def.target,
      requiresProject: def.requiresProject,
      fields: def.fields.map((f) => ({
        key: f.key,
        label: f.label,
        required: f.required,
        type: f.type,
        ...(f.enumValues ? { enumValues: [...f.enumValues] } : {}),
        ...(f.description ? { description: f.description } : {}),
      })),
    };
  });
}

/* ------------------------------------------------------------------ */
/* Row coercion & validation                                           */
/* ------------------------------------------------------------------ */

export interface RowIssue {
  /** null = the row as a whole (cross-field check) */
  field: string | null;
  code:
    | "required_missing"
    | "type_invalid"
    | "enum_invalid"
    | "row_invalid"
    | "duplicate_in_run"
    | "duplicate_committed";
  message: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isMissing(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

function coerceValue(field: DatasetField, raw: unknown): { ok: true; value: unknown } | { ok: false } {
  switch (field.type) {
    case "string": {
      const s = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : null;
      return s === null ? { ok: false } : { ok: true, value: s };
    }
    case "number":
    case "integer": {
      const n =
        typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : Number.NaN;
      if (!Number.isFinite(n)) return { ok: false };
      if (field.type === "integer" && !Number.isInteger(n)) return { ok: false };
      return { ok: true, value: n };
    }
    case "date": {
      if (typeof raw !== "string") return { ok: false };
      const s = raw.trim();
      if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s))) return { ok: false };
      return { ok: true, value: s };
    }
    case "time": {
      if (typeof raw !== "string") return { ok: false };
      const s = raw.trim();
      return TIME_RE.test(s) ? { ok: true, value: s } : { ok: false };
    }
    case "enum": {
      if (typeof raw !== "string") return { ok: false };
      const s = raw.trim().toLowerCase();
      return field.enumValues!.includes(s) ? { ok: true, value: s } : { ok: false };
    }
  }
}

/**
 * Coerce one raw payload (strings from a CSV, or typed values from a push)
 * into the dataset's typed row. Returns the typed row plus every issue found —
 * a rejected row reports ALL of its problems, not just the first.
 */
export function coerceRow(
  def: DatasetDef,
  raw: Record<string, unknown>,
): { value: Record<string, unknown>; issues: RowIssue[] } {
  const value: Record<string, unknown> = {};
  const issues: RowIssue[] = [];
  for (const field of def.fields) {
    const rawValue = raw[field.key];
    if (isMissing(rawValue)) {
      if (field.required) {
        issues.push({
          field: field.key,
          code: "required_missing",
          message: `${field.key} is required`,
        });
      }
      continue;
    }
    const coerced = coerceValue(field, rawValue);
    if (!coerced.ok) {
      const expectation =
        field.type === "enum"
          ? `one of ${field.enumValues!.join(", ")}`
          : field.type === "date"
            ? "an ISO date (YYYY-MM-DD)"
            : field.type === "time"
              ? "a time (HH:MM)"
              : `a ${field.type}`;
      issues.push({
        field: field.key,
        code: field.type === "enum" ? "enum_invalid" : "type_invalid",
        message: `${field.key} "${String(rawValue)}" is not ${expectation}`,
      });
      continue;
    }
    value[field.key] = coerced.value;
  }
  if (issues.length === 0 && def.validateRow) {
    const rowMessage = def.validateRow(value);
    if (rowMessage) issues.push({ field: null, code: "row_invalid", message: rowMessage });
  }
  return { value, issues };
}

/* ------------------------------------------------------------------ */
/* CSV parser                                                          */
/* ------------------------------------------------------------------ */

/**
 * Parse CSV text into rows of string cells. Handles quoted fields, escaped
 * quotes ("" inside a quoted field), CR/CRLF/LF line endings, newlines inside
 * quoted fields, and a UTF-8 BOM. Fully blank rows are dropped. This is the
 * whole grammar the migration wizard accepts — no sniffing, no delimiters
 * other than the comma.
 */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  const pushCell = () => {
    row.push(cell);
    cell = "";
  };
  const pushRow = () => {
    pushCell();
    if (row.some((c) => c !== "")) rows.push(row);
    row = [];
  };
  while (i < src.length) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        cell += ch;
        i += 1;
      }
    } else if (ch === '"' && cell === "") {
      inQuotes = true;
      i += 1;
    } else if (ch === ",") {
      pushCell();
      i += 1;
    } else if (ch === "\r") {
      pushRow();
      i += src[i + 1] === "\n" ? 2 : 1;
    } else if (ch === "\n") {
      pushRow();
      i += 1;
    } else {
      cell += ch;
      i += 1;
    }
  }
  if (cell !== "" || row.length > 0) pushRow();
  return rows;
}

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

/** A single run stages at most this many data rows. */
export const MAX_ROWS_PER_RUN = 20000;
/** A single machine push carries at most this many records. */
export const MAX_PUSH_RECORDS = 5000;
/** The run's stored validation report is capped at this many entries. */
export const MAX_REPORT_ENTRIES = 200;
/** Raw-row preview returned when a run is created. */
export const PREVIEW_ROWS = 5;
