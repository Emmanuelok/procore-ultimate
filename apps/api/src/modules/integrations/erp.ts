/**
 * ERP connector framework (spec Vol I §0.7 #130-133, #582).
 *
 * WHAT THIS IS. ConstructOS does not pretend to speak Sage 300 CRE, Viewpoint
 * Vista or QuickBooks natively — each is a different file, a different column
 * vocabulary and a different opinion about what a job cost row is. What it
 * speaks is ONE CANONICAL SHAPE per feed (AP invoices, job cost, payments),
 * and a MAPPING PROFILE declares, per system, which canonical field lands in
 * which column of that system's import file. The profile is a database row, so
 * supporting a new ERP is configuration rather than a release.
 *
 * WHY A CANONICAL SHAPE AT ALL. Without one, every ERP would need its own
 * query over invoices, vendors and cost codes, and the four of them would
 * drift: the day retainage moves from a header field to a line field, three of
 * the four exports are quietly wrong. Here the canonical row is derived once,
 * from the record, and a profile only ever RENAMES and REORDERS. A profile can
 * hold a field back and it can supply a constant (a GL company code, a
 * journal source) — it can never invent a figure.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not post to an ERP. Nothing here
 * opens a socket: the output is a file an operator (or a scheduled job in the
 * finance system) imports. A write-back integration needs credentials,
 * idempotency against a system we cannot roll back, and a reconciliation story
 * for partial failure — none of which is honest to claim before the read path
 * is in production. It also does not convert currency: an export carries the
 * invoice's own currency and the header states the currencies present, because
 * an ERP import that silently mixes them is worse than one that refuses.
 */
import { ERP_FEEDS, type ErpFeed } from "@constructos/shared";

/* ------------------------------------------------------------------ */
/* The canonical shapes                                                */
/* ------------------------------------------------------------------ */

export interface CanonicalField {
  key: string;
  label: string;
  type: "string" | "number" | "date";
  description: string;
}

/**
 * AP INVOICES — one row per invoice. This is the feed a finance team imports
 * to raise a payable against a subcontractor's application.
 */
export const AP_INVOICE_FIELDS: readonly CanonicalField[] = [
  { key: "invoiceId", label: "Invoice ID", type: "string", description: "ConstructOS invoice id — the idempotency key for a re-import" },
  { key: "reference", label: "Reference", type: "string", description: "ConstructOS reference (project-scoped, human readable)" },
  { key: "vendorInvoiceNumber", label: "Vendor Invoice No", type: "string", description: "The number printed on the vendor's own document" },
  { key: "vendorId", label: "Vendor ID", type: "string", description: "ConstructOS vendor id" },
  { key: "vendorName", label: "Vendor", type: "string", description: "Vendor legal name as held in the directory" },
  { key: "vendorReference", label: "Vendor Code", type: "string", description: "The vendor's code in the ERP, when the directory holds one" },
  { key: "projectId", label: "Job ID", type: "string", description: "ConstructOS project id — the ERP's job" },
  { key: "projectName", label: "Job", type: "string", description: "Project name" },
  { key: "status", label: "Status", type: "string", description: "Invoice status at export time" },
  { key: "currency", label: "Currency", type: "string", description: "ISO 4217 of every amount on this row" },
  { key: "billingDate", label: "Invoice Date", type: "date", description: "Billing date" },
  { key: "periodStart", label: "Period From", type: "date", description: "Start of the billing period" },
  { key: "periodEnd", label: "Period To", type: "date", description: "End of the billing period" },
  { key: "dueDate", label: "Due Date", type: "date", description: "Payment due date" },
  { key: "subtotal", label: "Net", type: "number", description: "Net amount before tax and retainage" },
  { key: "taxAmount", label: "Tax", type: "number", description: "Tax amount as computed on the invoice" },
  { key: "retainage", label: "Retainage", type: "number", description: "Retainage held on this invoice" },
  { key: "retainageReleased", label: "Retainage Released", type: "number", description: "Retainage released on this invoice" },
  { key: "total", label: "Gross", type: "number", description: "Gross amount including tax" },
  { key: "amountPaid", label: "Paid", type: "number", description: "Amount already paid against this invoice" },
  { key: "currentPaymentDue", label: "Payment Due", type: "number", description: "Net certified amount due this period" },
  { key: "approvedAt", label: "Approved At", type: "date", description: "When the invoice was approved" },
];

/** JOB COST — one row per invoice LINE, coded to a cost code and cost type. */
export const JOB_COST_FIELDS: readonly CanonicalField[] = [
  { key: "lineId", label: "Line ID", type: "string", description: "ConstructOS invoice line id" },
  { key: "invoiceId", label: "Invoice ID", type: "string", description: "Parent invoice id" },
  { key: "reference", label: "Reference", type: "string", description: "Parent invoice reference" },
  { key: "projectId", label: "Job ID", type: "string", description: "ConstructOS project id" },
  { key: "costCode", label: "Cost Code", type: "string", description: "Cost code as coded on the line" },
  { key: "costType", label: "Cost Type", type: "string", description: "Labour / material / equipment / subcontract, as coded" },
  { key: "description", label: "Description", type: "string", description: "Line description" },
  { key: "currency", label: "Currency", type: "string", description: "ISO 4217 of every amount on this row" },
  { key: "periodEnd", label: "Period To", type: "date", description: "End of the billing period the cost falls in" },
  { key: "quantity", label: "Quantity", type: "number", description: "Quantity billed, when the line is measured" },
  { key: "unitRate", label: "Unit Rate", type: "number", description: "Rate per unit, when the line is measured" },
  { key: "thisPeriodWork", label: "Work This Period", type: "number", description: "Value of work in this period" },
  { key: "thisPeriodStoredMaterials", label: "Stored Materials", type: "number", description: "Stored materials billed this period" },
  { key: "retainageThisPeriod", label: "Retainage", type: "number", description: "Retainage held on this line this period" },
  { key: "taxAmount", label: "Tax", type: "number", description: "Tax on this line" },
  { key: "amount", label: "Amount", type: "number", description: "Net billed this period after retainage" },
];

/** PAYMENTS — one row per payment made against an invoice. */
export const PAYMENT_FIELDS: readonly CanonicalField[] = [
  { key: "invoiceId", label: "Invoice ID", type: "string", description: "The invoice paid" },
  { key: "reference", label: "Reference", type: "string", description: "Invoice reference" },
  { key: "vendorId", label: "Vendor ID", type: "string", description: "ConstructOS vendor id" },
  { key: "vendorName", label: "Vendor", type: "string", description: "Vendor legal name" },
  { key: "projectId", label: "Job ID", type: "string", description: "ConstructOS project id" },
  { key: "currency", label: "Currency", type: "string", description: "ISO 4217 of every amount on this row" },
  { key: "amountPaid", label: "Amount Paid", type: "number", description: "Amount recorded as paid" },
  { key: "paidDate", label: "Paid Date", type: "date", description: "Date the payment was recorded" },
  { key: "retainageReleased", label: "Retainage Released", type: "number", description: "Retainage released with this payment" },
];

export const FEED_FIELDS: Record<ErpFeed, readonly CanonicalField[]> = {
  ap_invoices: AP_INVOICE_FIELDS,
  job_cost: JOB_COST_FIELDS,
  payments: PAYMENT_FIELDS,
};

export function feedFields(feed: string): readonly CanonicalField[] | null {
  return Object.hasOwn(FEED_FIELDS, feed) ? FEED_FIELDS[feed as ErpFeed] : null;
}

/* ------------------------------------------------------------------ */
/* Mapping profiles                                                    */
/* ------------------------------------------------------------------ */

/**
 * One mapping instruction: put canonical field `source` (or the literal
 * `constant`) in the export column named `target`. Exactly one of the two is
 * set — a mapping that names both would be ambiguous, and a mapping that names
 * neither is a column of nothing.
 */
export interface FieldMapEntry {
  target: string;
  source?: string;
  constant?: string;
}

export interface FieldMapProblem {
  index: number;
  message: string;
}

/** Validate a field map against a feed's canonical vocabulary. */
export function validateFieldMap(
  feed: string,
  entries: readonly FieldMapEntry[],
): FieldMapProblem[] {
  const fields = feedFields(feed);
  const problems: FieldMapProblem[] = [];
  if (!fields) {
    return [{ index: -1, message: `Unknown feed "${feed}" — expected one of ${ERP_FEEDS.join(", ")}` }];
  }
  const known = new Set(fields.map((f) => f.key));
  const seenTargets = new Set<string>();
  entries.forEach((entry, index) => {
    if (entry.target.trim() === "") {
      problems.push({ index, message: "target column name is empty" });
    }
    if (seenTargets.has(entry.target)) {
      problems.push({ index, message: `duplicate target column "${entry.target}"` });
    }
    seenTargets.add(entry.target);
    const hasSource = typeof entry.source === "string" && entry.source !== "";
    const hasConstant = typeof entry.constant === "string";
    if (hasSource === hasConstant) {
      problems.push({
        index,
        message: `"${entry.target}" needs exactly one of source or constant`,
      });
      return;
    }
    if (hasSource && !known.has(entry.source!)) {
      problems.push({
        index,
        message: `"${entry.source}" is not a field of the ${feed} feed`,
      });
    }
  });
  return problems;
}

/** The identity profile: every canonical field, under its canonical key. */
export function identityFieldMap(feed: string): FieldMapEntry[] {
  return (feedFields(feed) ?? []).map((f) => ({ target: f.key, source: f.key }));
}

/* ------------------------------------------------------------------ */
/* Built-in starter profiles                                           */
/* ------------------------------------------------------------------ */

export interface StarterProfile {
  key: string;
  system: string;
  feed: ErpFeed;
  name: string;
  notes: string;
  fieldMap: FieldMapEntry[];
}

/**
 * Starter profiles for the three systems the brief names. They are STARTERS,
 * not certifications: the column names follow each product's published import
 * templates, and an integrator is expected to adjust them to the customer's
 * own chart of accounts. That is stated on every export header rather than
 * implied, because "Sage 300 CRE profile" reads like a guarantee otherwise.
 */
export const STARTER_PROFILES: readonly StarterProfile[] = [
  {
    key: "sage300_ap",
    system: "sage",
    feed: "ap_invoices",
    name: "Sage 300 CRE — AP invoices",
    notes:
      "Column names follow the Sage 300 CRE Accounts Payable invoice import layout. Confirm the " +
      "vendor code column against the customer's AP vendor master before the first import.",
    fieldMap: [
      { target: "Vendor", source: "vendorReference" },
      { target: "Invoice", source: "vendorInvoiceNumber" },
      { target: "Invoice Date", source: "billingDate" },
      { target: "Due Date", source: "dueDate" },
      { target: "Job", source: "projectId" },
      { target: "Amount", source: "total" },
      { target: "Retainage", source: "retainage" },
      { target: "Currency", source: "currency" },
      { target: "Description", source: "reference" },
    ],
  },
  {
    key: "sage300_job_cost",
    system: "sage",
    feed: "job_cost",
    name: "Sage 300 CRE — job cost",
    notes: "One row per invoice line, coded to Job / Cost Code / Category.",
    fieldMap: [
      { target: "Job", source: "projectId" },
      { target: "Cost Code", source: "costCode" },
      { target: "Category", source: "costType" },
      { target: "Description", source: "description" },
      { target: "Units", source: "quantity" },
      { target: "Unit Cost", source: "unitRate" },
      { target: "Amount", source: "amount" },
      { target: "Accounting Date", source: "periodEnd" },
      { target: "Currency", source: "currency" },
    ],
  },
  {
    key: "viewpoint_ap",
    system: "viewpoint",
    feed: "ap_invoices",
    name: "Viewpoint Vista — AP invoice batch",
    notes:
      "Follows the Vista AP Unapproved Invoice Entry batch layout. The Batch Month column is a " +
      "constant here — set it per batch, or map it to Period To if the customer prefers.",
    fieldMap: [
      { target: "VendorGroup", constant: "1" },
      { target: "Vendor", source: "vendorReference" },
      { target: "APRef", source: "vendorInvoiceNumber" },
      { target: "InvDate", source: "billingDate" },
      { target: "DueDate", source: "dueDate" },
      { target: "Job", source: "projectId" },
      { target: "InvTotal", source: "total" },
      { target: "Retainage", source: "retainage" },
      { target: "CurrCode", source: "currency" },
    ],
  },
  {
    key: "quickbooks_bills",
    system: "quickbooks",
    feed: "ap_invoices",
    name: "QuickBooks — bills (IIF-style columns)",
    notes:
      "Column names match the QuickBooks Bill import template. QuickBooks holds one currency per " +
      "vendor: an export that spans currencies must be split before import, and the header says so.",
    fieldMap: [
      { target: "Vendor", source: "vendorName" },
      { target: "Bill No", source: "vendorInvoiceNumber" },
      { target: "Bill Date", source: "billingDate" },
      { target: "Due Date", source: "dueDate" },
      { target: "Customer", source: "projectName" },
      { target: "Amount", source: "total" },
      { target: "Currency", source: "currency" },
      { target: "Memo", source: "reference" },
    ],
  },
  {
    key: "quickbooks_payments",
    system: "quickbooks",
    feed: "payments",
    name: "QuickBooks — bill payments",
    notes: "One row per payment recorded against an invoice.",
    fieldMap: [
      { target: "Vendor", source: "vendorName" },
      { target: "Payment Date", source: "paidDate" },
      { target: "Amount", source: "amountPaid" },
      { target: "Currency", source: "currency" },
      { target: "Memo", source: "reference" },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

export type CanonicalRow = Record<string, string | number | null>;

/** Apply a field map to canonical rows, producing the export's own columns. */
export function applyFieldMap(
  rows: readonly CanonicalRow[],
  entries: readonly FieldMapEntry[],
): { columns: string[]; rows: Record<string, string | number | null>[] } {
  const columns = entries.map((e) => e.target);
  const mapped = rows.map((row) => {
    const out: Record<string, string | number | null> = {};
    for (const entry of entries) {
      out[entry.target] =
        entry.constant !== undefined ? entry.constant : (row[entry.source!] ?? null);
    }
    return out;
  });
  return { columns, rows: mapped };
}

/**
 * CSV escaping with formula neutralisation. An ERP export is opened in a
 * spreadsheet at least as often as it is imported by a machine, and a vendor
 * name authored by a lower-trust party is exactly the untrusted string that
 * makes CSV injection work. Same rule as the analytics export.
 */
const FORMULA_TRIGGERS = new Set(["=", "+", "-", "@", "\t", "\r"]);

export function erpCsvEscape(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (s.length > 0 && FORMULA_TRIGGERS.has(s[0]!)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(
  columns: readonly string[],
  rows: readonly Record<string, string | number | null>[],
): string {
  const lines = [columns.map(erpCsvEscape).join(",")];
  for (const row of rows) lines.push(columns.map((c) => erpCsvEscape(row[c])).join(","));
  return `${lines.join("\n")}\n`;
}

/**
 * The currencies present in a set of canonical rows. An ERP export never sums
 * across them and never converts; the header declares what is in the file so
 * the importing system's operator can split it if their ledger demands one.
 */
export function currenciesIn(rows: readonly CanonicalRow[]): string[] {
  const set = new Set<string>();
  for (const row of rows) {
    const c = row["currency"];
    if (typeof c === "string" && c !== "") set.add(c);
  }
  return [...set].sort();
}
