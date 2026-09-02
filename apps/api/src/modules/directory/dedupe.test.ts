import { describe, expect, it } from "vitest";
import { compareVendors, findDuplicates, normaliseName, tokenSetSimilarity } from "./dedupe.js";

describe("normaliseName", () => {
  it("strips legal form, punctuation and case", () => {
    expect(normaliseName("ACME Ltd.")).toBe("acme");
    expect(normaliseName("Acme Limited")).toBe("acme");
    expect(normaliseName("The Acme Group PLC")).toBe("acme");
  });

  it("keeps the distinguishing words", () => {
    expect(normaliseName("Acme Northern Ltd")).toBe("acme northern");
  });
});

describe("tokenSetSimilarity", () => {
  it("is 1 for names that differ only in legal form", () => {
    expect(tokenSetSimilarity("ACME Ltd", "Acme Limited")).toBe(1);
  });

  it("is 0 for unrelated names", () => {
    expect(tokenSetSimilarity("Acme", "Beta Construction")).toBe(0);
  });

  it("is partial for a shared word", () => {
    const score = tokenSetSimilarity("Acme Northern", "Acme Southern");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });
});

describe("compareVendors", () => {
  it("flags an identical name once legal form is stripped, with the reason", () => {
    const pair = compareVendors(
      { id: "a", name: "ACME Ltd" },
      { id: "b", name: "Acme Limited" },
    );
    expect(pair).not.toBeNull();
    expect(pair!.reasons.some((r) => r.includes("identical name"))).toBe(true);
  });

  it("flags a shared tax id even when the names differ completely", () => {
    const pair = compareVendors(
      { id: "a", name: "Northern Groundworks", taxId: "GB 123 4567 89" },
      { id: "b", name: "NGW Civils", taxId: "gb1234567 89" },
    );
    expect(pair).not.toBeNull();
    expect(pair!.confidence).toBeGreaterThan(0.7);
    expect(pair!.reasons[0]).toContain("tax id");
  });

  it("does not flag on a shared email domain alone — subsidiaries are common", () => {
    expect(
      compareVendors(
        { id: "a", name: "Alpha Civils", email: "a@group.test" },
        { id: "b", name: "Beta Mechanical", email: "b@group.test" },
      ),
    ).toBeNull();
  });

  it("flags a similar name plus a shared phone number", () => {
    const pair = compareVendors(
      { id: "a", name: "Acme Northern", phone: "+44 113 555 0101" },
      { id: "b", name: "Acme Northern Services", phone: "0113 555 0101" },
    );
    expect(pair).not.toBeNull();
    expect(pair!.reasons.some((r) => r.includes("phone"))).toBe(true);
  });

  it("returns null when nothing at all is shared", () => {
    expect(
      compareVendors({ id: "a", name: "Alpha" }, { id: "b", name: "Zulu Mechanical" }),
    ).toBeNull();
  });

  it("caps confidence at 1", () => {
    const pair = compareVendors(
      {
        id: "a",
        name: "Acme Ltd",
        taxId: "T1",
        registrationNumber: "R1",
        email: "x@acme.test",
        phone: "0113 555 0101",
        address: "1 High Street",
        city: "Leeds",
      },
      {
        id: "b",
        name: "Acme Limited",
        taxId: "T1",
        registrationNumber: "R1",
        email: "x@acme.test",
        phone: "0113 555 0101",
        address: "1 High Street",
        city: "Leeds",
      },
    );
    expect(pair!.confidence).toBe(1);
  });
});

describe("findDuplicates", () => {
  it("returns pairs ordered by confidence and honours the limit", () => {
    const vendors = [
      { id: "a", name: "Acme Ltd", taxId: "T1" },
      { id: "b", name: "Acme Limited", taxId: "T1" },
      { id: "c", name: "Acme Northern" },
      { id: "d", name: "Acme Northern Ltd" },
      { id: "e", name: "Completely Different" },
    ];
    const pairs = findDuplicates(vendors);
    expect(pairs.length).toBeGreaterThanOrEqual(2);
    expect(pairs[0]!.confidence).toBeGreaterThanOrEqual(pairs[1]!.confidence);
    expect(pairs.some((p) => p.a === "e" || p.b === "e")).toBe(false);
    expect(findDuplicates(vendors, 1)).toHaveLength(1);
  });

  it("never pairs a vendor with itself", () => {
    const pairs = findDuplicates([{ id: "a", name: "Acme" }]);
    expect(pairs).toEqual([]);
  });
});
