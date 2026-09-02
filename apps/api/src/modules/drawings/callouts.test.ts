import { describe, expect, it } from "vitest";
import { detectCallouts, detectSpecCitations, normaliseSheetNumber } from "./callouts.js";
import type { PositionedItem } from "./pdf.js";

const item = (t: string, x = 0.5, y = 0.5, w = 0.05, h = 0.01): PositionedItem => ({ t, x, y, w, h });

describe("callouts: sheet references (#263)", () => {
  it("normalises dashes and case", () => {
    expect(normaliseSheetNumber("a–501")).toBe("A-501");
    expect(normaliseSheetNumber(" s1.02 ")).toBe("S1.02");
  });

  it("reads an explicit SEE DETAIL callout as a detail link with high confidence", () => {
    const hits = detectCallouts([item("SEE DETAIL 4/A-501", 0.2, 0.3)], "A-101");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ targetNumber: "A-501", kind: "detail", x: 0.2, y: 0.3 });
    expect(hits[0]!.confidence).toBeGreaterThanOrEqual(0.85);
    expect(hits[0]!.confidence).toBeLessThan(1);
  });

  it("reads a bare bubble '3/A-501' with lower confidence than an explicit SEE", () => {
    const [bare] = detectCallouts([item("3/A-501")], null);
    const [explicit] = detectCallouts([item("SEE DETAIL 3/A-501")], null);
    expect(bare?.targetNumber).toBe("A-501");
    expect(bare?.confidence).toBeLessThan(explicit!.confidence);
  });

  it("types SECTION and ELEVATION callouts and treats a plain SEE as a sheet link", () => {
    expect(detectCallouts([item("SEE SECTION 2/S-301")], null)[0]?.kind).toBe("section");
    expect(detectCallouts([item("SEE ELEVATION A/A-201")], null)[0]?.kind).toBe("elevation");
    expect(detectCallouts([item("SEE A-502")], null)[0]).toMatchObject({
      targetNumber: "A-502",
      kind: "sheet",
    });
    expect(detectCallouts([item("REFER TO SHEET M-401")], null)[0]?.targetNumber).toBe("M-401");
  });

  it("never links a sheet to itself and ignores blacklisted prefixes", () => {
    expect(detectCallouts([item("SEE A-101")], "A-101")).toEqual([]);
    expect(detectCallouts([item("SEE REV-2")], null)).toEqual([]);
    expect(detectCallouts([item("SEE NO-3")], null)).toEqual([]);
  });

  it("marks TYP/SIM callouts slightly less certain", () => {
    const [typ] = detectCallouts([item("SEE DETAIL 4/A-501 TYP.")], null);
    const [plain] = detectCallouts([item("SEE DETAIL 4/A-501")], null);
    expect(typ!.confidence).toBeLessThan(plain!.confidence);
  });

  it("collapses the same target at the same spot into one link", () => {
    const hits = detectCallouts([item("SEE DETAIL 4/A-501", 0.4, 0.4)], null);
    expect(hits).toHaveLength(1);
  });

  it("assembles a stacked bubble: detail id above, sheet number directly beneath", () => {
    const top = item("3", 0.50, 0.500, 0.012, 0.010);
    const below = item("A-501", 0.495, 0.512, 0.03, 0.010);
    const hits = detectCallouts([top, below], null);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ label: "3/A-501", targetNumber: "A-501", kind: "detail" });
    expect(hits[0]!.confidence).toBeCloseTo(0.7, 2);
    // the hot-zone is the union of both boxes
    expect(hits[0]!.x).toBeCloseTo(0.495, 3);
    expect(hits[0]!.y).toBeCloseTo(0.5, 3);
    expect(hits[0]!.h).toBeGreaterThan(0.02);
  });

  it("does not stack a number that is far below or not horizontally aligned", () => {
    const top = item("3", 0.5, 0.5, 0.012, 0.01);
    const far = item("A-501", 0.5, 0.6, 0.03, 0.01);
    const aside = item("A-501", 0.8, 0.512, 0.03, 0.01);
    expect(detectCallouts([top, far], null)).toEqual([]);
    expect(detectCallouts([top, aside], null)).toEqual([]);
  });
});

describe("callouts: spec citations (#316)", () => {
  it("reads MasterFormat section citations in every separator style", () => {
    const hits = detectSpecCitations([
      item("SEE SECTION 03 30 00 FOR CONCRETE", 0.1, 0.1),
      item("SPEC 09-91-23", 0.2, 0.2),
      item("SPECIFICATION 26.05.19", 0.3, 0.3),
    ]);
    expect(hits.map((h) => h.normalisedCode)).toEqual(["033000", "099123", "260519"]);
    expect(hits[0]).toMatchObject({ code: "03 30 00", x: 0.1, y: 0.1 });
    for (const h of hits) expect(h.confidence).toBeLessThan(1);
  });

  it("ignores six-digit numbers that are not introduced as a section", () => {
    expect(detectSpecCitations([item("PROJECT 033000 PHASE 2")])).toEqual([]);
  });

  it("dedupes the same code at the same position", () => {
    expect(detectSpecCitations([item("SECTION 03 30 00 SECTION 03 30 00")])).toHaveLength(1);
  });
});
