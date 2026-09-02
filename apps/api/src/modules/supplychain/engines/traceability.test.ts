import { describe, expect, it } from "vitest";
import { chainCompleteness, traceCoverage, type TraceRecordInput } from "./traceability.js";

const record = (over: Partial<TraceRecordInput> = {}): TraceRecordInput => ({
  heatNumber: null,
  batchNumber: null,
  lotNumber: null,
  serialNumber: null,
  certificates: [],
  status: "received",
  installedLocationId: null,
  installedAt: null,
  supplierNodeId: null,
  vendorId: null,
  manufacturer: null,
  originCountry: null,
  conformityMarking: null,
  ...over,
});

describe("chainCompleteness", () => {
  it("names every missing link on an empty record", () => {
    const r = chainCompleteness(record());
    expect(r.complete).toBe(false);
    expect(r.score).toBe(0);
    expect(r.gaps).toHaveLength(4);
    expect(r.gaps[0]).toMatch(/No heat, batch/);
  });

  it("is complete when identifier, provenance, verified certificate and installed location are present", () => {
    const r = chainCompleteness(
      record({
        heatNumber: "H-4471",
        manufacturer: "Steelworks AG",
        certificates: [{ id: "c1", kind: "mill_certificate", reference: "MC-1", verifiedBy: "u2" }],
        status: "installed",
        installedLocationId: "loc1",
      }),
    );
    expect(r.complete).toBe(true);
    expect(r.score).toBe(100);
  });

  it("flags an unverified certificate and a missing conformity marking when required", () => {
    const r = chainCompleteness(
      record({
        batchNumber: "B-1",
        vendorId: "v1",
        certificates: [{ id: "c1", kind: "test_certificate", reference: "TC-1" }],
        requiresConformityMarking: true,
      }),
    );
    expect(r.links.certificate).toBe(true);
    expect(r.links.certificateVerified).toBe(false);
    expect(r.links.conformityMarking).toBe(false);
    expect(r.gaps.some((g) => /not verified/.test(g))).toBe(true);
    expect(r.gaps.some((g) => /CE\/UKCA/.test(g))).toBe(true);
  });

  it("does not count an EPD as the vouching certificate", () => {
    const r = chainCompleteness(record({ heatNumber: "H1", certificates: [{ id: "c1", kind: "epd", reference: "E-1" }] }));
    expect(r.links.certificate).toBe(false);
  });

  it("flags installed with no location", () => {
    const r = chainCompleteness(record({ heatNumber: "H1", status: "installed" }));
    expect(r.gaps.some((g) => /no location/.test(g))).toBe(true);
    expect(r.links.installed).toBe(false);
  });
});

describe("traceCoverage", () => {
  it("returns null coverage with a reason when empty", () => {
    expect(traceCoverage([]).completenessPercent).toBeNull();
    expect(traceCoverage([]).reasons[0]).toMatch(/No traceability/);
  });
  it("counts installed lots without any certificate", () => {
    const c = traceCoverage([
      { chainComplete: 1, status: "installed", certificateCount: 1 },
      { chainComplete: 0, status: "installed", certificateCount: 0 },
      { chainComplete: 0, status: "received", certificateCount: 0 },
    ]);
    expect(c.completenessPercent).toBeCloseTo(33.3, 1);
    expect(c.installedWithoutCertificate).toBe(1);
  });
});
