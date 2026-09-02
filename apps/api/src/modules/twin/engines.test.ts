import { describe, expect, it } from "vitest";
import { coolDownElapsed, evaluateBreaches, expiryHorizon } from "./alerts.js";
import {
  buildCobieWorkbook,
  componentRow,
  scoreCompleteness,
  sheetToCsv,
  validateCobie,
  type CobieAsset,
} from "./cobie.js";
import { assessHandover, performanceGap, type HandoverAsset } from "./handover.js";
import { addDays, csvCell, daysBetween } from "./shared.js";

/* ------------------------------------------------------------------ */
/* Threshold evaluation                                                */
/* ------------------------------------------------------------------ */

const reading = (value: number, minute: number) => ({
  value,
  at: `2026-05-01T00:${String(minute).padStart(2, "0")}:00.000Z`,
});

describe("evaluateBreaches", () => {
  it("collapses a batch into one summary per breached bound", () => {
    const breaches = evaluateBreaches(
      [reading(5, 0), reading(31, 1), reading(35, 2), reading(20, 3)],
      { minValue: 10, maxValue: 30 },
    );
    expect(breaches).toHaveLength(2);
    const min = breaches.find((b) => b.kind === "min_breach")!;
    expect(min).toMatchObject({ count: 1, worstValue: 5, threshold: 10 });
    const max = breaches.find((b) => b.kind === "max_breach")!;
    expect(max).toMatchObject({ count: 2, worstValue: 35, threshold: 30 });
    expect(max.firstAt).toBe(reading(31, 1).at);
    expect(max.lastAt).toBe(reading(35, 2).at);
  });

  it("returns nothing when every reading is inside the thresholds", () => {
    expect(evaluateBreaches([reading(20, 0)], { minValue: 10, maxValue: 30 })).toEqual([]);
  });

  it("ignores a bound that is not configured", () => {
    const breaches = evaluateBreaches([reading(-40, 0)], { minValue: null, maxValue: 30 });
    expect(breaches).toEqual([]);
  });
});

describe("coolDownElapsed", () => {
  it("suppresses a second alert inside the cool-down window", () => {
    const last = "2026-05-01T10:00:00.000Z";
    expect(coolDownElapsed(last, "2026-05-01T10:30:00.000Z", 60)).toBe(false);
    expect(coolDownElapsed(last, "2026-05-01T11:00:00.000Z", 60)).toBe(true);
    expect(coolDownElapsed(null, "2026-05-01T10:00:00.000Z", 60)).toBe(true);
    expect(coolDownElapsed(last, "2026-05-01T10:00:01.000Z", 0)).toBe(true);
  });
});

describe("expiryHorizon", () => {
  it("fires once per horizon, in descending order", () => {
    expect(expiryHorizon(120, null)).toBeNull();
    expect(expiryHorizon(80, null)).toBe(90);
    // the most urgent crossed horizon wins, not the widest
    expect(expiryHorizon(20, null)).toBe(30);
    expect(expiryHorizon(2, null)).toBe(7);
    expect(expiryHorizon(80, 90)).toBeNull();
    expect(expiryHorizon(20, 90)).toBe(30);
    expect(expiryHorizon(3, 30)).toBe(7);
    expect(expiryHorizon(-1, 7)).toBe(0);
    expect(expiryHorizon(-30, 0)).toBeNull();
  });
});

describe("date helpers", () => {
  it("adds days and measures differences on ISO dates", () => {
    expect(addDays("2026-02-27", 3)).toBe("2026-03-02");
    expect(daysBetween("2026-01-01", "2026-01-31")).toBe(30);
    expect(Number.isNaN(daysBetween("not-a-date", "2026-01-01"))).toBe(true);
  });

  it("neutralises spreadsheet formulas in CSV cells", () => {
    expect(csvCell('=HYPERLINK("http://evil","x")')).toBe('"\'=HYPERLINK(""http://evil"",""x"")"');
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("normal")).toBe("normal");
    expect(csvCell(null)).toBe("");
  });
});

/* ------------------------------------------------------------------ */
/* COBie                                                               */
/* ------------------------------------------------------------------ */

const asset = (over: Partial<CobieAsset> = {}): CobieAsset => ({
  id: "ast_1",
  tagCode: "AHU-01",
  name: "Air handling unit 01",
  category: "HVAC",
  classificationSystem: "uniclass",
  classificationCode: "Ss_65_40",
  parentId: null,
  locationId: "loc_space",
  manufacturer: "Daikin",
  modelNumber: "VRV-X",
  serialNumber: "SN-1",
  installedAt: "2026-01-10",
  commissionedAt: "2026-02-01",
  warrantyStart: "2026-02-01",
  warrantyMonths: 24,
  expectedLifeYears: 20,
  criticality: "high",
  status: "operational",
  attributes: { description: "Roof plant" },
  createdAt: "2026-01-01T00:00:00.000Z",
  createdBy: "u1",
  creatorEmail: "fm@example.com",
  spaceName: "Roof plant room",
  ...over,
});

const workbookInput = {
  project: { id: "prj", name: "Tower", address: "1 Road", city: "London", country: "GB" },
  assets: [asset()],
  locations: [
    { id: "loc_floor", name: "Roof", parentId: null, path: "loc_floor" },
    { id: "loc_space", name: "Roof plant room", parentId: "loc_floor", path: "loc_floor/loc_space" },
  ],
  contacts: [{ id: "u1", email: "fm@example.com", name: "Facilities Manager" }],
  warranties: [
    {
      id: "wty_1",
      assetId: "ast_1",
      provider: "Daikin",
      description: null,
      startDate: "2026-02-01",
      endDate: "2028-02-01",
      documentFileId: "fil_1",
    },
  ],
};

describe("COBie workbook", () => {
  const workbook = buildCobieWorkbook(workbookInput);

  it("builds every sheet and says why the empty ones are empty", () => {
    const names = workbook.sheets.map((s) => s.name);
    expect(names).toContain("Component");
    expect(names).toContain("Type");
    expect(names).toContain("Space");
    const zone = workbook.sheets.find((s) => s.name === "Zone")!;
    expect(zone.rows).toHaveLength(0);
    expect(zone.reason).toContain("not modelled");
  });

  it("derives Type rows from manufacturer and model", () => {
    const type = workbook.sheets.find((s) => s.name === "Type")!;
    expect(type.rows[0]!["Name"]).toBe("Daikin VRV-X");
    expect(workbook.sheets.find((s) => s.name === "Component")!.rows[0]!["TypeName"]).toBe(
      "Daikin VRV-X",
    );
  });

  it("links spaces to their floor", () => {
    const space = workbook.sheets.find((s) => s.name === "Space")!.rows[0]!;
    expect(space["FloorName"]).toBe("Roof");
  });

  it("passes validation for a complete asset", () => {
    expect(workbook.issues.filter((i) => i.severity === "error")).toHaveLength(0);
    expect(workbook.completeness.score).toBe(100);
  });

  it("reports referential errors, duplicates and bad dates", () => {
    const broken = buildCobieWorkbook({
      ...workbookInput,
      assets: [
        asset({ id: "a", tagCode: "T1", spaceName: "Nowhere", installedAt: "01/06/2026" }),
        asset({ id: "b", tagCode: "T2", name: "Air handling unit 01" }),
      ],
    });
    const messages = broken.issues.map((i) => i.message);
    expect(messages.some((m) => m.includes("does not exist on the Space sheet"))).toBe(true);
    expect(messages.some((m) => m.includes("Duplicate component name"))).toBe(true);
    expect(messages.some((m) => m.includes("is not an ISO date"))).toBe(true);
  });

  it("scores completeness field by field and names what is missing", () => {
    const partial = scoreCompleteness([
      asset({ serialNumber: null, installedAt: null, spaceName: null }),
    ]);
    expect(partial.score).toBeLessThan(100);
    expect(partial.missingByComponent[0]!.missing.sort()).toEqual([
      "InstallationDate",
      "SerialNumber",
      "Space",
    ]);
    expect(scoreCompleteness([]).score).toBe(0);
  });

  it("flags an empty deliverable as an error rather than a pass", () => {
    const empty = validateCobie([
      { name: "Component", columns: ["Name"], rows: [] },
      { name: "Type", columns: ["Name"], rows: [] },
      { name: "Space", columns: ["Name"], rows: [] },
      { name: "Contact", columns: ["Email"], rows: [] },
    ]);
    expect(empty.some((i) => i.message.includes("no components"))).toBe(true);
  });

  it("renders a sheet as CSV with the header first", () => {
    const csv = sheetToCsv(workbook.sheets.find((s) => s.name === "Component")!, csvCell);
    const [header, first] = csv.trim().split("\r\n");
    expect(header).toContain("Name,CreatedBy,CreatedOn,TypeName,Space");
    expect(first).toContain("Air handling unit 01");
  });

  it("builds one component row per asset", () => {
    expect(componentRow(asset()).TagNumber).toBe("AHU-01");
  });
});

/* ------------------------------------------------------------------ */
/* Handover readiness and performance                                  */
/* ------------------------------------------------------------------ */

const handoverAsset = (over: Partial<HandoverAsset> = {}): HandoverAsset => ({
  id: "a1",
  tagCode: "AHU-01",
  name: "AHU",
  status: "operational",
  criticality: "high",
  locationId: "loc",
  classificationCode: "Ss_65",
  manufacturer: "Daikin",
  modelNumber: "X",
  serialNumber: "SN",
  installedAt: "2026-01-01",
  commissionedAt: "2026-02-01",
  hasWarranty: true,
  hasDocument: true,
  hasElementLink: true,
  hasSensor: true,
  ...over,
});

describe("handover readiness", () => {
  it("is unknowable, not zero, with no assets", () => {
    const result = assessHandover([]);
    expect(result.score).toBeNull();
    expect(result.scoreBasis).toContain("not available");
  });

  it("scores a complete register at 100", () => {
    const result = assessHandover([handoverAsset()]);
    expect(result.score).toBe(100);
    expect(result.blockers).toHaveLength(0);
  });

  it("names the blocking gaps and the assets responsible", () => {
    const result = assessHandover([
      handoverAsset(),
      handoverAsset({ id: "a2", tagCode: "FCU-02", hasWarranty: false, locationId: null, status: "installed" }),
    ]);
    expect(result.score).toBeLessThan(100);
    expect(result.blockers.join(" ")).toContain('fail "Located in a space"');
    expect(result.blockers.join(" ")).toContain("not yet commissioned");
    const located = result.dimensions.find((d) => d.key === "located")!;
    expect(located.missingTagCodes).toEqual(["FCU-02"]);
    expect(located.percent).toBe(50);
  });
});

describe("performanceGap", () => {
  it("refuses to invent a gap without a baseline", () => {
    const row = performanceGap({
      sensorId: "s1",
      sensorName: "Supply air",
      kind: "temperature",
      unit: "C",
      designSetpoint: null,
      readings: 100,
      avg: 21,
      min: 19,
      max: 23,
      lastValue: 21,
      lastAt: "2026-05-01T00:00:00.000Z",
    });
    expect(row.verdict).toBe("unknown");
    expect(row.gap).toBeNull();
    expect(row.basis).toContain("no design setpoint");
  });

  it("classifies on/above/below design against the tolerance", () => {
    const base = {
      sensorId: "s1",
      sensorName: "Supply air",
      kind: "temperature",
      unit: "C",
      designSetpoint: 20,
      readings: 10,
      min: 0,
      max: 0,
      lastValue: null,
      lastAt: null,
    };
    expect(performanceGap({ ...base, avg: 20.5 }).verdict).toBe("on_design");
    expect(performanceGap({ ...base, avg: 26 }).verdict).toBe("above_design");
    expect(performanceGap({ ...base, avg: 15 }).verdict).toBe("below_design");
    expect(performanceGap({ ...base, avg: 26 }).gapPercent).toBe(30);
  });

  it("says so when the window holds no readings", () => {
    const row = performanceGap({
      sensorId: "s1",
      sensorName: "Supply air",
      kind: "temperature",
      unit: "C",
      designSetpoint: 20,
      readings: 0,
      avg: null,
      min: null,
      max: null,
      lastValue: null,
      lastAt: null,
    });
    expect(row.verdict).toBe("unknown");
    expect(row.basis).toContain("no readings");
  });
});
