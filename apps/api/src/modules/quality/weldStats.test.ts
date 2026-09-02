import { describe, expect, it } from "vitest";
import {
  addMonths,
  daysBetween,
  qualificationStanding,
  weldCompliance,
  weldProgramme,
  welderPerformance,
  type NdtRecordLike,
  type WeldLike,
  type WelderQualificationLike,
  type WpsLike,
} from "./weldStats.js";
import { instrumentStanding, derivedDueDate, readingsInDoubt } from "./calibrationStatus.js";

const qual = (over: Partial<WelderQualificationLike> = {}): WelderQualificationLike => ({
  id: "wq1",
  welderName: "J. Welder",
  welderStamp: "W12",
  processes: ["gtaw", "smaw"],
  positions: ["6G"],
  materialGroups: ["P1"],
  thicknessMinMm: 3,
  thicknessMaxMm: 25,
  diameterMinMm: null,
  diameterMaxMm: null,
  qualifiedFrom: "2025-01-01",
  expiryDate: "2027-01-01",
  continuityConfirmedAt: "2026-06-01",
  continuityMonths: 6,
  status: "valid",
  ...over,
});

const wps = (over: Partial<WpsLike> = {}): WpsLike => ({
  id: "wps1",
  wpsNumber: "WPS-001",
  process: "gtaw",
  positions: ["6G"],
  baseMaterialGroup: "P1",
  thicknessMinMm: 3,
  thicknessMaxMm: 20,
  status: "approved",
  validFrom: "2025-01-01",
  validUntil: null,
  ...over,
});

const weld = (over: Partial<WeldLike> = {}): WeldLike => ({
  id: "w1",
  reference: "W-001",
  status: "welded",
  weldedAt: "2026-07-01",
  thicknessMm: 10,
  diameterMm: 168,
  wpsId: "wps1",
  welderQualificationId: "wq1",
  ndtRequiredPercent: null,
  ndtRecordCount: 0,
  ndtAcceptCount: 0,
  ndtRejectCount: 0,
  repairCount: 0,
  jointType: "butt",
  ...over,
});

describe("date arithmetic", () => {
  it("adds months and clamps the day into the target month", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-06-15", 6)).toBe("2026-12-15");
    expect(addMonths("2026-12-01", 1)).toBe("2027-01-01");
  });
  it("counts days between dates", () => {
    expect(daysBetween("2026-01-01", "2026-01-31")).toBe(30);
    expect(daysBetween("nonsense", "2026-01-31")).toBeNull();
  });
});

describe("qualificationStanding", () => {
  it("is valid while both the certificate and continuity hold", () => {
    expect(qualificationStanding(qual(), "2026-07-01").status).toBe("valid");
  });

  it("lapses on continuity before the certificate expiry, and says which", () => {
    const standing = qualificationStanding(qual({ continuityConfirmedAt: "2025-12-01" }), "2026-07-01");
    expect(standing.status).toBe("expired");
    expect(standing.reasons.join(" ")).toContain("continuity");
    expect(standing.continuityLapsesOn).toBe("2026-06-01");
  });

  it("warns inside the notice window", () => {
    const standing = qualificationStanding(qual({ continuityConfirmedAt: "2026-06-01" }), "2026-11-15");
    expect(standing.status).toBe("expiring");
  });

  it("refuses to call a qualification current with no dates at all", () => {
    const standing = qualificationStanding(
      qual({ expiryDate: null, continuityConfirmedAt: null }),
      "2026-07-01",
    );
    expect(standing.status).toBe("expiring");
    expect(standing.reasons.join(" ")).toContain("cannot be shown to be current");
  });

  it("respects a suspension over any arithmetic", () => {
    expect(qualificationStanding(qual({ status: "suspended" }), "2026-07-01").status).toBe(
      "suspended",
    );
  });
});

describe("weldCompliance", () => {
  it("passes a joint welded to an approved procedure by a current welder", () => {
    const out = weldCompliance(weld(), wps(), qual(), "2026-07-02");
    expect(out.compliant).toBe(true);
    expect(out.blockers).toHaveLength(0);
  });

  it("refuses a joint with no procedure named", () => {
    const out = weldCompliance(weld({ wpsId: null }), null, qual(), "2026-07-02");
    expect(out.compliant).toBe(false);
    expect(out.blockers.join(" ")).toContain("names no WPS");
  });

  it("refuses a joint outside the procedure's qualified thickness", () => {
    const out = weldCompliance(weld({ thicknessMm: 30 }), wps(), qual(), "2026-07-02");
    expect(out.compliant).toBe(false);
    expect(out.blockers.join(" ")).toContain("thickness range");
  });

  it("judges the welder's qualification as at the day of welding, not today", () => {
    const out = weldCompliance(
      weld({ weldedAt: "2026-07-01" }),
      wps(),
      qual({ continuityConfirmedAt: "2025-01-01" }),
      "2026-07-02",
    );
    expect(out.compliant).toBe(false);
    expect(out.blockers.join(" ")).toContain("was welded on 2026-07-01");
  });

  it("refuses a process the welder is not qualified for", () => {
    const out = weldCompliance(weld(), wps({ process: "fcaw" }), qual(), "2026-07-02");
    expect(out.compliant).toBe(false);
    expect(out.blockers.join(" ")).toContain("does not cover");
  });

  it("refuses a joint with no welder qualification at all", () => {
    const out = weldCompliance(weld({ welderQualificationId: null }), wps(), null, "2026-07-02");
    expect(out.compliant).toBe(false);
    expect(out.blockers.join(" ")).toContain("names no welder qualification");
  });
});

describe("weldProgramme", () => {
  const ndt = (over: Partial<NdtRecordLike> & { id: string; weldId: string }): NdtRecordLike => ({
    method: "rt",
    result: "accept",
    performedAt: "2026-07-02",
    ...over,
  });

  it("reports coverage and repair rate as null when nothing has been welded or examined", () => {
    const out = weldProgramme([weld({ status: "planned" })], []);
    expect(out.ndtCoverage.value).toBeNull();
    expect(out.ndtCoverage.reasons.join(" ")).toContain("would read as a failure to examine");
    expect(out.repairRate.value).toBeNull();
  });

  it("computes coverage over welded joints and repair rate over examinations", () => {
    const out = weldProgramme(
      [weld({ id: "w1" }), weld({ id: "w2", reference: "W-002" })],
      [ndt({ id: "n1", weldId: "w1" }), ndt({ id: "n2", weldId: "w1", result: "reject" })],
    );
    expect(out.ndtCoverage.value).toBe(50);
    expect(out.repairRate.value).toBe(50);
    expect(out.rejectedCount).toBe(1);
  });

  it("names joints short of their required examination percentage", () => {
    const out = weldProgramme([weld({ id: "w1", ndtRequiredPercent: 100 })], []);
    expect(out.coverageShortfalls).toHaveLength(1);
    expect(out.coverageShortfalls[0]!.required).toBe(100);
    expect(out.coverageShortfalls[0]!.achieved).toBe(0);
  });

  it("ignores pending examinations in the repair rate", () => {
    const out = weldProgramme(
      [weld({ id: "w1" })],
      [ndt({ id: "n1", weldId: "w1", result: "pending" })],
    );
    expect(out.repairRate.value).toBeNull();
  });
});

describe("welderPerformance", () => {
  it("ranks welders by repair rate and admits when a rate is unmeasured", () => {
    const rows = welderPerformance(
      [
        weld({ id: "w1", welderQualificationId: "wq1" }),
        weld({ id: "w2", welderQualificationId: "wq2" }),
      ],
      [
        { id: "n1", weldId: "w1", method: "rt", result: "reject", performedAt: "2026-07-02" },
        { id: "n2", weldId: "w1", method: "rt", result: "accept", performedAt: "2026-07-03" },
      ],
      [qual(), qual({ id: "wq2", welderName: "K. Welder" })],
    );
    expect(rows[0]!.welderQualificationId).toBe("wq1");
    expect(rows[0]!.repairRate.value).toBe(50);
    const unmeasured = rows.find((r) => r.welderQualificationId === "wq2")!;
    expect(unmeasured.repairRate.value).toBeNull();
    expect(unmeasured.repairRate.reasons.join(" ")).toContain("unmeasured");
  });
});

describe("calibration standing", () => {
  const instrument = {
    id: "ins1",
    reference: "CAL-001",
    name: "Pressure gauge",
    serialNumber: "SN-1",
    lastCalibratedAt: "2026-01-15",
    calibrationDueDate: "2027-01-15",
    calibrationIntervalMonths: 12,
    status: "in_service",
    certificateFileId: "file1",
    certificateNumber: "C-1",
  };

  it("derives the due date from the interval", () => {
    expect(derivedDueDate(instrument)).toBe("2027-01-15");
  });

  it("is in service well inside the interval", () => {
    expect(instrumentStanding(instrument, "2026-06-01").status).toBe("in_service");
  });

  it("is overdue past the due date and refuses to call it usable", () => {
    const standing = instrumentStanding(instrument, "2027-02-01");
    expect(standing.status).toBe("overdue");
    expect(standing.usable).toBe(false);
    expect(standing.reasons.join(" ")).toContain("cannot be relied on");
  });

  it("warns inside the due-soon window", () => {
    expect(instrumentStanding(instrument, "2027-01-01").status).toBe("due_soon");
  });

  it("takes the earlier of a recorded due date and the interval, and says so", () => {
    const standing = instrumentStanding(
      { ...instrument, calibrationDueDate: "2028-01-01" },
      "2027-06-01",
    );
    expect(standing.status).toBe("overdue");
    expect(standing.reasons.join(" ")).toContain("earlier date governs");
  });

  it("treats an instrument with no calibration at all as overdue rather than in service", () => {
    const standing = instrumentStanding(
      { ...instrument, lastCalibratedAt: null, calibrationDueDate: null },
      "2026-06-01",
    );
    expect(standing.status).toBe("overdue");
    expect(standing.reasons.join(" ")).toContain("treated as overdue");
  });

  it("reports a decision status without arithmetic", () => {
    expect(instrumentStanding({ ...instrument, status: "lost" }, "2026-06-01").usable).toBe(false);
  });
});

describe("readingsInDoubt", () => {
  it("names the window back to the last passing calibration", () => {
    const window = readingsInDoubt(
      [
        { calibratedAt: "2025-01-10", result: "pass" },
        { calibratedAt: "2026-01-10", result: "pass" },
        { calibratedAt: "2027-01-10", result: "fail" },
      ],
      "2027-01-10",
    );
    expect(window.from).toBe("2026-01-10");
    expect(window.to).toBe("2027-01-10");
  });

  it("admits when everything ever measured is in doubt", () => {
    const window = readingsInDoubt([{ calibratedAt: "2027-01-10", result: "fail" }], "2027-01-10");
    expect(window.from).toBeNull();
    expect(window.reasons.join(" ")).toContain("every reading");
  });
});
