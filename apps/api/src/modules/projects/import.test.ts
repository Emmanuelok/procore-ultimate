import { describe, expect, it } from "vitest";
import {
  committableRows,
  IMPORT_SPECS,
  parseCsv,
  templateCsv,
  toCsv,
  toRecords,
  validateRows,
} from "./import.js";

describe("parseCsv", () => {
  it("reads quoted fields with embedded commas, quotes and newlines", () => {
    const rows = parseCsv('a,b\n"one, two","he said ""hi"""\n"multi\nline",x');
    expect(rows).toEqual([
      ["a", "b"],
      ["one, two", 'he said "hi"'],
      ["multi\nline", "x"],
    ]);
  });

  it("handles CRLF and a UTF-8 BOM from Excel", () => {
    const rows = parseCsv("﻿name,city\r\nAcme,Leeds\r\n");
    expect(rows[0]).toEqual(["name", "city"]);
    expect(rows[1]).toEqual(["Acme", "Leeds"]);
  });

  it("drops trailing blank lines", () => {
    expect(parseCsv("a\n\n\n")).toEqual([["a"]]);
  });
});

describe("toRecords", () => {
  it("keys rows by a normalised header", () => {
    expect(toRecords(parseCsv("Trade Codes,Name\n03;05, Acme "))).toEqual([
      { trade_codes: "03;05", name: "Acme" },
    ]);
  });

  it("returns nothing for an empty sheet", () => {
    expect(toRecords([])).toEqual([]);
  });
});

describe("toCsv", () => {
  it("quotes only what needs quoting", () => {
    expect(toCsv([["plain", "with,comma", 'with"quote', null]])).toBe(
      'plain,"with,comma","with""quote",',
    );
  });
});

describe("validateRows — vendors", () => {
  const spec = IMPORT_SPECS["vendors"]!;

  it("accepts a clean sheet", () => {
    const preview = validateRows(
      spec,
      toRecords(parseCsv("name,email,status\nAcme,ops@acme.test,active")),
    );
    expect(preview.errorCount).toBe(0);
    expect(preview.validCount).toBe(1);
  });

  it("reports the row number a person sees in their spreadsheet", () => {
    const preview = validateRows(spec, toRecords(parseCsv("name,email\nAcme,not-an-email")));
    // Header is row 1, so the first data row is row 2.
    expect(preview.errors[0]).toMatchObject({ row: 2, field: "email", severity: "error" });
  });

  it("refuses a missing required column value", () => {
    const preview = validateRows(spec, toRecords(parseCsv("name,city\n,Leeds")));
    expect(preview.errorCount).toBe(1);
    expect(preview.validCount).toBe(0);
  });

  it("refuses a value outside an enumerated column", () => {
    const preview = validateRows(spec, toRecords(parseCsv("name,status\nAcme,retired")));
    expect(preview.errors.some((e) => e.field === "status")).toBe(true);
  });

  it("flags a duplicate identity within the file and names the other row", () => {
    const preview = validateRows(spec, toRecords(parseCsv("name\nAcme\nAcme")));
    const duplicate = preview.errors.find((e) => e.message.startsWith("Duplicate"));
    expect(duplicate).toMatchObject({ row: 3 });
    expect(duplicate!.message).toContain("row 2");
  });

  it("warns about an unknown column without failing the row", () => {
    const preview = validateRows(spec, toRecords(parseCsv("name,favourite_colour\nAcme,blue")));
    expect(preview.errorCount).toBe(0);
    expect(preview.errors.some((e) => e.severity === "warning")).toBe(true);
  });

  it("caps the row count and says so", () => {
    const rows = ["name", ...Array.from({ length: 12 }, (_, i) => `Vendor ${i}`)].join("\n");
    const preview = validateRows(spec, toRecords(parseCsv(rows)), { maxRows: 5 });
    expect(preview.rowCount).toBe(5);
    expect(preview.errors.some((e) => e.message.includes("first 5 rows"))).toBe(true);
  });
});

describe("committableRows", () => {
  it("writes only the rows with no error against them", () => {
    const spec = IMPORT_SPECS["vendors"]!;
    const preview = validateRows(spec, toRecords(parseCsv("name,email\nGood,ok@x.test\nBad,nope")));
    const writable = committableRows(preview);
    expect(writable).toHaveLength(1);
    expect(writable[0]!["name"]).toBe("Good");
  });
});

describe("templateCsv", () => {
  it("produces a header plus a hint row for every dataset", () => {
    for (const spec of Object.values(IMPORT_SPECS)) {
      const lines = templateCsv(spec).split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]!.split(",")).toHaveLength(spec.columns.length);
    }
  });
});

describe("validateRows — locations", () => {
  it("requires the path column and validates the numeric sort order", () => {
    const spec = IMPORT_SPECS["locations"]!;
    const preview = validateRows(
      spec,
      toRecords(parseCsv("path,sort_order\nBlock A > Level 1,2\n,3\nBlock B,x")),
    );
    expect(preview.errors.some((e) => e.field === "path")).toBe(true);
    expect(preview.errors.some((e) => e.field === "sort_order")).toBe(true);
    expect(preview.validCount).toBe(1);
  });
});
