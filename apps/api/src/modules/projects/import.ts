/**
 * CSV import — parsing and row validation (Vol I §0.3 #77).
 *
 * Every substrate register (vendors, contacts, cost codes, locations) accepts
 * a spreadsheet, and every import runs as a DRY RUN first: parse, validate,
 * report row-level errors, and only then let a human commit the rows they
 * reviewed. An importer that writes 4,000 rows and then tells you 60 were
 * wrong is not an importer, it is a data-quality incident.
 *
 * Pure: parsing and validation take strings and return findings. The routes
 * do the writing.
 */

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

/**
 * A small RFC 4180 reader: quoted fields, escaped quotes, embedded newlines
 * and commas, CRLF or LF. Deliberately dependency-free — a CSV reader is
 * fifty lines and a dependency is for ever.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  // Strip a UTF-8 BOM: Excel writes one and it corrupts the first header.
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop trailing blank lines.
  while (rows.length > 0 && rows[rows.length - 1]!.every((c) => c.trim() === "")) rows.pop();
  return rows;
}

/** Turn a parsed sheet into objects keyed by its header row. */
export function toRecords(rows: string[][]): Array<Record<string, string>> {
  const [header, ...body] = rows;
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  return body.map((cells) => {
    const record: Record<string, string> = {};
    keys.forEach((key, idx) => {
      if (!key) return;
      record[key] = (cells[idx] ?? "").trim();
    });
    return record;
  });
}

/** Render rows back to CSV — used for the downloadable template. */
export function toCsv(rows: Array<Array<string | number | null | undefined>>): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const value = cell === null || cell === undefined ? "" : String(cell);
          return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
        })
        .join(","),
    )
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* Column specifications                                               */
/* ------------------------------------------------------------------ */

export interface ColumnSpec {
  key: string;
  label: string;
  required?: boolean;
  maxLength?: number;
  /** allowed values, case-insensitive */
  oneOf?: readonly string[];
  kind?: "text" | "email" | "number";
  hint?: string;
}

export interface DatasetSpec {
  dataset: string;
  label: string;
  /** true when the dataset belongs to a project rather than the company */
  projectScoped: boolean;
  columns: ColumnSpec[];
  /** the column whose value identifies an existing row for update */
  identity: string;
}

export const IMPORT_SPECS: Record<string, DatasetSpec> = {
  vendors: {
    dataset: "vendors",
    label: "Vendors",
    projectScoped: false,
    identity: "name",
    columns: [
      { key: "name", label: "Name", required: true, maxLength: 300 },
      { key: "trade_codes", label: "Trade codes", hint: "semicolon-separated" },
      { key: "address", label: "Address", maxLength: 500 },
      { key: "city", label: "City", maxLength: 200 },
      { key: "country", label: "Country", maxLength: 200 },
      { key: "phone", label: "Phone", maxLength: 50 },
      { key: "email", label: "Email", kind: "email", maxLength: 200 },
      { key: "website", label: "Website", maxLength: 300 },
      { key: "tax_id", label: "Tax id", maxLength: 100 },
      { key: "registration_number", label: "Registration number", maxLength: 100 },
      { key: "status", label: "Status", oneOf: ["active", "inactive"] },
    ],
  },
  contacts: {
    dataset: "contacts",
    label: "Contacts",
    projectScoped: false,
    identity: "email",
    columns: [
      { key: "name", label: "Name", required: true, maxLength: 300 },
      { key: "email", label: "Email", kind: "email", maxLength: 200 },
      { key: "phone", label: "Phone", maxLength: 50 },
      { key: "title", label: "Title", maxLength: 200 },
      { key: "vendor_name", label: "Vendor", hint: "must already exist in the directory" },
    ],
  },
  cost_codes: {
    dataset: "cost_codes",
    label: "Cost codes",
    projectScoped: false,
    identity: "code",
    columns: [
      { key: "code", label: "Code", required: true, maxLength: 50 },
      { key: "title", label: "Title", required: true, maxLength: 300 },
      { key: "division", label: "Division", maxLength: 100 },
      {
        key: "cost_type",
        label: "Cost type",
        oneOf: ["labour", "material", "equipment", "subcontract", "other"],
      },
      { key: "parent_code", label: "Parent code", maxLength: 50 },
    ],
  },
  locations: {
    dataset: "locations",
    label: "Locations",
    projectScoped: true,
    identity: "path",
    columns: [
      {
        key: "path",
        label: "Location path",
        required: true,
        maxLength: 500,
        hint: "Building > Level > Room",
      },
      { key: "sort_order", label: "Sort order", kind: "number" },
    ],
  },
};

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export interface ImportRowError {
  /** 1-based row number as the person sees it in their spreadsheet */
  row: number;
  field: string | null;
  message: string;
  severity: "error" | "warning";
}

export interface ImportPreview {
  dataset: string;
  columns: ColumnSpec[];
  rows: Array<Record<string, string>>;
  errors: ImportRowError[];
  rowCount: number;
  validCount: number;
  errorCount: number;
}

const EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

/**
 * Validate every row against the dataset's column spec.
 *
 * Rows with an error are kept in the preview (so the person can see them in
 * context) but excluded from `validCount`, and the commit writes only rows
 * with no error against them.
 */
export function validateRows(
  spec: DatasetSpec,
  records: Array<Record<string, string>>,
  options: { maxRows?: number } = {},
): ImportPreview {
  const errors: ImportRowError[] = [];
  const maxRows = options.maxRows ?? 5000;
  const rows = records.slice(0, maxRows);
  if (records.length > maxRows) {
    errors.push({
      row: maxRows + 1,
      field: null,
      message: `Only the first ${maxRows} rows are imported in one run; split the file.`,
      severity: "warning",
    });
  }

  const known = new Set(spec.columns.map((c) => c.key));
  const firstRow = rows[0];
  if (firstRow) {
    for (const key of Object.keys(firstRow)) {
      if (!known.has(key)) {
        errors.push({
          row: 1,
          field: key,
          message: `Column "${key}" is not part of the ${spec.label} template and is ignored.`,
          severity: "warning",
        });
      }
    }
  }

  const seenIdentity = new Map<string, number>();
  const badRows = new Set<number>();

  rows.forEach((record, index) => {
    const rowNumber = index + 2; // +1 for the header, +1 for 1-based
    for (const column of spec.columns) {
      const raw = (record[column.key] ?? "").trim();
      if (column.required && raw === "") {
        errors.push({
          row: rowNumber,
          field: column.key,
          message: `${column.label} is required`,
          severity: "error",
        });
        badRows.add(index);
        continue;
      }
      if (raw === "") continue;
      if (column.maxLength && raw.length > column.maxLength) {
        errors.push({
          row: rowNumber,
          field: column.key,
          message: `${column.label} is longer than ${column.maxLength} characters`,
          severity: "error",
        });
        badRows.add(index);
      }
      if (column.kind === "email" && !EMAIL.test(raw)) {
        errors.push({
          row: rowNumber,
          field: column.key,
          message: `"${raw}" is not an email address`,
          severity: "error",
        });
        badRows.add(index);
      }
      if (column.kind === "number" && !Number.isFinite(Number(raw))) {
        errors.push({
          row: rowNumber,
          field: column.key,
          message: `${column.label} must be a number`,
          severity: "error",
        });
        badRows.add(index);
      }
      if (column.oneOf && !column.oneOf.includes(raw.toLowerCase())) {
        errors.push({
          row: rowNumber,
          field: column.key,
          message: `${column.label} must be one of: ${column.oneOf.join(", ")}`,
          severity: "error",
        });
        badRows.add(index);
      }
    }

    const identity = (record[spec.identity] ?? "").trim().toLowerCase();
    if (identity !== "") {
      const previous = seenIdentity.get(identity);
      if (previous !== undefined) {
        errors.push({
          row: rowNumber,
          field: spec.identity,
          message: `Duplicate ${spec.identity} — also on row ${previous}`,
          severity: "error",
        });
        badRows.add(index);
      } else {
        seenIdentity.set(identity, rowNumber);
      }
    }
  });

  return {
    dataset: spec.dataset,
    columns: spec.columns,
    rows: rows.map((record, index) => ({ ...record, __row: String(index + 2) })),
    errors,
    rowCount: rows.length,
    validCount: rows.length - badRows.size,
    errorCount: errors.filter((e) => e.severity === "error").length,
  };
}

/** Rows the commit may write: everything with no error against it. */
export function committableRows(preview: ImportPreview): Array<Record<string, string>> {
  const bad = new Set(
    preview.errors.filter((e) => e.severity === "error").map((e) => String(e.row)),
  );
  return preview.rows.filter((r) => !bad.has(r["__row"] ?? ""));
}

/** The blank template a person downloads before filling it in. */
export function templateCsv(spec: DatasetSpec): string {
  return toCsv([
    spec.columns.map((c) => c.key),
    spec.columns.map((c) => c.hint ?? (c.required ? "required" : "")),
  ]);
}
