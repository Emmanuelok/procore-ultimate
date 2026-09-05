/**
 * The certificate boundary, stated once and tested here.
 *
 * A certificate valid to the 30th is VALID ON the 30th. Getting that wrong in
 * one direction condemns a lawful machine and in the other clears an unlawful
 * one, and the second mistake is the one that hurts somebody.
 */
import { describe, expect, it } from "vitest";
import {
  CERTIFICATE_EXPIRING_WINDOW_DAYS,
  certificateVerdict,
  daysBetweenISO,
  isStatutoryCertificate,
} from "./signals.js";

const ASOF = "2026-06-30";

describe("daysBetweenISO", () => {
  it("counts forward and backward in whole days", () => {
    expect(daysBetweenISO("2026-06-30", "2026-07-05")).toBe(5);
    expect(daysBetweenISO("2026-06-30", "2026-06-25")).toBe(-5);
    expect(daysBetweenISO("2026-06-30", "2026-06-30")).toBe(0);
  });

  it("crosses a month and a leap day without drifting", () => {
    expect(daysBetweenISO("2028-02-27", "2028-03-01")).toBe(3);
  });
});

describe("isStatutoryCertificate", () => {
  it("separates unlawful-to-operate from serious-but-chaseable", () => {
    expect(isStatutoryCertificate("thorough_examination")).toBe(true);
    expect(isStatutoryCertificate("crane_test_certificate")).toBe(true);
    // Deliberately NOT statutory: their lapse is reported at high, not
    // critical, because the machine may lawfully be worked while it is chased.
    expect(isStatutoryCertificate("insurance")).toBe(false);
    expect(isStatutoryCertificate("calibration")).toBe(false);
    expect(isStatutoryCertificate("conformity_declaration")).toBe(false);
  });
});

describe("certificateVerdict", () => {
  it("is VALID on its last day, not expired", () => {
    const verdict = certificateVerdict({
      validTo: ASOF,
      validFrom: "2025-07-01",
      certificateType: "thorough_examination",
      inService: true,
      asOf: ASOF,
    });
    expect(verdict.status).not.toBe("expired");
    expect(verdict.daysToExpiry).toBe(0);
    expect(verdict.detector).toBeNull();
  });

  it("expires the day AFTER validTo", () => {
    const verdict = certificateVerdict({
      validTo: "2026-06-29",
      validFrom: "2025-07-01",
      certificateType: "thorough_examination",
      inService: true,
      asOf: ASOF,
    });
    expect(verdict.status).toBe("expired");
    expect(verdict.daysToExpiry).toBe(-1);
  });

  it("is CRITICAL only when a statutory certificate has lapsed on plant in service", () => {
    const inService = certificateVerdict({
      validTo: "2026-06-01",
      validFrom: null,
      certificateType: "thorough_examination",
      inService: true,
      asOf: ASOF,
    });
    expect(inService.severity).toBe("critical");
    expect(inService.detector).toBe("equipment_certificate_expired_in_service");

    const inYard = certificateVerdict({
      validTo: "2026-06-01",
      validFrom: null,
      certificateType: "thorough_examination",
      inService: false,
      asOf: ASOF,
    });
    expect(inYard.severity).toBe("high");
    expect(inYard.detector).toBe("equipment_certificate_expired");

    const nonStatutory = certificateVerdict({
      validTo: "2026-06-01",
      validFrom: null,
      certificateType: "insurance",
      inService: true,
      asOf: ASOF,
    });
    expect(nonStatutory.severity).toBe("high");
    expect(nonStatutory.detector).toBe("equipment_certificate_expired");
  });

  it("is PENDING, and raises nothing, before it comes into force", () => {
    const verdict = certificateVerdict({
      validTo: "2027-06-30",
      validFrom: "2026-07-01",
      certificateType: "thorough_examination",
      inService: true,
      asOf: ASOF,
    });
    expect(verdict.status).toBe("pending");
    expect(verdict.severity).toBeNull();
    expect(verdict.detector).toBeNull();
  });

  it("warns inside the booking window and stays quiet outside it", () => {
    const inside = certificateVerdict({
      validTo: "2026-07-20",
      validFrom: null,
      certificateType: "thorough_examination",
      inService: true,
      asOf: ASOF,
    });
    expect(inside.status).toBe("expiring");
    expect(inside.daysToExpiry).toBeLessThanOrEqual(CERTIFICATE_EXPIRING_WINDOW_DAYS);

    const outside = certificateVerdict({
      validTo: "2026-09-30",
      validFrom: null,
      certificateType: "thorough_examination",
      inService: true,
      asOf: ASOF,
    });
    expect(outside.status).toBe("valid");
    // Neither state raises a signal: an expiring certificate is a diary entry,
    // not a finding, and raising one would drown the register that matters.
    expect(inside.detector).toBeNull();
    expect(outside.detector).toBeNull();
  });
});
