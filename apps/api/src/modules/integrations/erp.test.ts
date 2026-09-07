import { describe, expect, it } from "vitest";
import {
  applyFieldMap,
  currenciesIn,
  erpCsvEscape,
  feedFields,
  identityFieldMap,
  STARTER_PROFILES,
  toCsv,
  validateFieldMap,
  type CanonicalRow,
} from "./erp.js";

describe("canonical feeds", () => {
  it("publishes a field vocabulary for every feed, with no duplicate keys", () => {
    for (const feed of ["ap_invoices", "job_cost", "payments"]) {
      const fields = feedFields(feed);
      expect(fields, feed).not.toBeNull();
      const keys = fields!.map((f) => f.key);
      expect(new Set(keys).size, feed).toBe(keys.length);
      // every field carries a description: a column an integrator cannot
      // interpret is a column that ends up mapped to the wrong ledger account.
      expect(fields!.every((f) => f.description.length > 10), feed).toBe(true);
    }
    expect(feedFields("nonsense")).toBeNull();
  });

  it("carries a currency on every feed — an ERP row without one is unusable", () => {
    for (const feed of ["ap_invoices", "job_cost", "payments"]) {
      expect(feedFields(feed)!.some((f) => f.key === "currency"), feed).toBe(true);
    }
  });
});

describe("field map validation", () => {
  it("accepts the identity map for every feed", () => {
    for (const feed of ["ap_invoices", "job_cost", "payments"]) {
      expect(validateFieldMap(feed, identityFieldMap(feed)), feed).toEqual([]);
    }
  });

  it("accepts every built-in starter profile against its own feed", () => {
    for (const starter of STARTER_PROFILES) {
      expect(validateFieldMap(starter.feed, starter.fieldMap), starter.key).toEqual([]);
    }
  });

  it("refuses a source that is not a field of the feed", () => {
    const problems = validateFieldMap("ap_invoices", [
      { target: "Vendor", source: "vendorName" },
      { target: "Ghost", source: "notAField" },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain("notAField");
  });

  it("refuses an entry with both source and constant, or neither", () => {
    expect(
      validateFieldMap("ap_invoices", [
        { target: "X", source: "total", constant: "1" },
      ])[0]!.message,
    ).toContain("exactly one");
    expect(validateFieldMap("ap_invoices", [{ target: "X" }])[0]!.message).toContain(
      "exactly one",
    );
  });

  it("refuses duplicate target columns and an empty one", () => {
    const problems = validateFieldMap("ap_invoices", [
      { target: "Amount", source: "total" },
      { target: "Amount", source: "subtotal" },
      { target: "", source: "taxAmount" },
    ]);
    expect(problems.some((p) => p.message.includes("duplicate"))).toBe(true);
    expect(problems.some((p) => p.message.includes("empty"))).toBe(true);
  });

  it("refuses an unknown feed outright", () => {
    expect(validateFieldMap("gl_journal", [])[0]!.message).toContain("Unknown feed");
  });
});

describe("rendering", () => {
  const rows: CanonicalRow[] = [
    { vendorName: "Acme Ltd", total: 1200.5, currency: "GBP", reference: "INV-1" },
    { vendorName: "Beta Oy", total: 900, currency: "EUR", reference: "INV-2" },
  ];

  it("renames and reorders, and can supply a constant, but cannot invent a figure", () => {
    const mapped = applyFieldMap(rows, [
      { target: "Company", constant: "01" },
      { target: "Vendor", source: "vendorName" },
      { target: "Amount", source: "total" },
    ]);
    expect(mapped.columns).toEqual(["Company", "Vendor", "Amount"]);
    expect(mapped.rows[0]).toEqual({ Company: "01", Vendor: "Acme Ltd", Amount: 1200.5 });
    // a mapped field that the canonical row does not carry is null, never 0
    const missing = applyFieldMap(rows, [{ target: "Job", source: "projectId" }]);
    expect(missing.rows[0]!["Job"]).toBeNull();
  });

  it("reports every currency present and never merges them", () => {
    expect(currenciesIn(rows)).toEqual(["EUR", "GBP"]);
    expect(currenciesIn([])).toEqual([]);
  });

  it("neutralises spreadsheet formulas in exported strings", () => {
    // A vendor name authored by a lower-trust party is the untrusted string
    // that makes CSV injection work; an ERP export lands in Excel as often as
    // in an importer.
    expect(erpCsvEscape('=HYPERLINK("http://evil.example")')).toBe(
      "\"'=HYPERLINK(\"\"http://evil.example\"\")\"",
    );
    expect(erpCsvEscape("+1234")).toBe("'+1234");
    expect(erpCsvEscape("-1234")).toBe("'-1234");
    expect(erpCsvEscape("@SUM(A1)")).toBe("'@SUM(A1)");
    // ordinary text is untouched
    expect(erpCsvEscape("Acme Ltd")).toBe("Acme Ltd");
    expect(erpCsvEscape(null)).toBe("");
    expect(erpCsvEscape(1200.5)).toBe("1200.5");
  });

  it("quotes separators, newlines and quotes", () => {
    expect(erpCsvEscape('Acme, Ltd "Group"')).toBe('"Acme, Ltd ""Group"""');
    expect(erpCsvEscape("line1\nline2")).toBe('"line1\nline2"');
  });

  it("renders a header row and one line per row", () => {
    const csv = toCsv(["Vendor", "Amount"], [
      { Vendor: "Acme Ltd", Amount: 1200.5 },
      { Vendor: "Beta Oy", Amount: 900 },
    ]);
    expect(csv).toBe("Vendor,Amount\nAcme Ltd,1200.5\nBeta Oy,900\n");
  });
});
