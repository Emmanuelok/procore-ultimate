import { describe, expect, it } from "vitest";
import {
  assessFaults,
  checkGeofence,
  classifyDay,
  coerceTelematicsRow,
  engineHoursForDay,
  engineHoursFromCounter,
  reconcileFuel,
  reconcileEquipment,
  reconcileTelematics,
  telematicsKey,
  TELEMATICS_PERSISTENT_DAYS,
  type EquipmentReconcileInput,
} from "./telematics.js";

describe("engineHoursFromCounter — the counter is cumulative", () => {
  it("takes the last reading of the day minus the first", () => {
    const r = engineHoursFromCounter([
      { recordedAt: "2026-08-03T06:00:00.000Z", engineHours: 1200 },
      { recordedAt: "2026-08-03T12:00:00.000Z", engineHours: 1203.5 },
      { recordedAt: "2026-08-03T17:00:00.000Z", engineHours: 1206.2 },
    ]);
    expect(r.hours).toBe(6.2);
    expect(r.samples).toBe(3);
  });

  it("orders by timestamp rather than trusting the array order", () => {
    const r = engineHoursFromCounter([
      { recordedAt: "2026-08-03T17:00:00.000Z", engineHours: 1206 },
      { recordedAt: "2026-08-03T06:00:00.000Z", engineHours: 1200 },
    ]);
    expect(r.hours).toBe(6);
  });

  it("returns null — not zero — for a single reading", () => {
    const r = engineHoursFromCounter([{ recordedAt: "2026-08-03T06:00:00.000Z", engineHours: 1200 }]);
    expect(r.hours).toBeNull();
    expect(r.reasons.join(" ")).toContain("needs two points");
  });

  it("returns null with a reason when the counter was reset", () => {
    const r = engineHoursFromCounter([
      { recordedAt: "2026-08-03T06:00:00.000Z", engineHours: 1200 },
      { recordedAt: "2026-08-03T17:00:00.000Z", engineHours: 4 },
    ]);
    expect(r.hours).toBeNull();
    expect(r.reasons.join(" ")).toContain("reset or replaced");
  });

  it("returns null when no reading carried a counter at all", () => {
    const r = engineHoursFromCounter([
      { recordedAt: "2026-08-03T06:00:00.000Z", engineHours: null },
    ]);
    expect(r.hours).toBeNull();
    expect(r.samples).toBe(0);
  });
});

describe("classifyDay", () => {
  it("calls claimed hours unsupported when they exceed engine hours beyond both tolerances", () => {
    const d = classifyDay({ date: "2026-08-03", manualWorkingHours: 9, telematicsEngineHours: 6.2 });
    expect(d.classification).toBe("unsupported_hours");
    expect(d.varianceHours).toBe(2.8);
    expect(d.reason).toContain("unsupported");
  });

  it("stays within tolerance for a 1-hour difference", () => {
    const d = classifyDay({ date: "2026-08-03", manualWorkingHours: 9, telematicsEngineHours: 8 });
    expect(d.classification).toBe("ok");
  });

  it("stays within tolerance when the ratio is under 1.15 despite a big absolute gap", () => {
    const d = classifyDay({ date: "2026-08-03", manualWorkingHours: 11, telematicsEngineHours: 10 });
    expect(d.classification).toBe("ok");
  });

  it("does not treat missing telematics as an overclaim", () => {
    const d = classifyDay({
      date: "2026-08-03",
      manualWorkingHours: 9,
      telematicsEngineHours: null,
      telematicsReasons: ["only one engine-hour reading in the period"],
    });
    expect(d.classification).toBe("no_telematics");
    expect(d.varianceHours).toBeNull();
    expect(d.reason).toContain("unverified, not disproved");
  });

  it("flags a day the machine ran with no utilisation row at all", () => {
    const d = classifyDay({ date: "2026-08-03", manualWorkingHours: null, telematicsEngineHours: 7 });
    expect(d.classification).toBe("no_manual_record");
    expect(d.reason).toContain("nobody recorded it");
  });

  it("flags under-reporting — hours worked and never billed", () => {
    const d = classifyDay({ date: "2026-08-03", manualWorkingHours: 4, telematicsEngineHours: 9 });
    expect(d.classification).toBe("under_reported");
    expect(d.varianceHours).toBe(-5);
  });
});

describe("reconcileEquipment", () => {
  const machine = (over: Partial<EquipmentReconcileInput> = {}): EquipmentReconcileInput => ({
    equipmentId: "eqp_1",
    reference: "EQP-0001",
    name: "30t excavator",
    currency: "GBP",
    hireRateAmount: 40,
    hireRateUnit: "hour",
    operatorRateAmount: 30,
    days: [],
    ...over,
  });

  const unsupportedDay = (date: string) => ({
    date,
    manualWorkingHours: 9,
    telematicsEngineHours: 6,
  });

  it("prices the unsupported hours at the hourly plant + operator rates", () => {
    const r = reconcileEquipment(
      machine({ days: [unsupportedDay("2026-08-03"), unsupportedDay("2026-08-04")] }),
    );
    expect(r.daysUnsupported).toBe(2);
    expect(r.varianceHours).toBe(6);
    expect(r.valueAtRisk).toBe(6 * (40 + 30));
    expect(r.persistent).toBe(false);
  });

  it("becomes persistent at the day threshold", () => {
    const days = Array.from({ length: TELEMATICS_PERSISTENT_DAYS }, (_, i) =>
      unsupportedDay(`2026-08-0${i + 3}`),
    );
    const r = reconcileEquipment(machine({ days }));
    expect(r.daysUnsupported).toBe(TELEMATICS_PERSISTENT_DAYS);
    expect(r.persistent).toBe(true);
  });

  it("refuses to price unsupported hours from a daily hire rate", () => {
    const r = reconcileEquipment(
      machine({
        hireRateUnit: "day",
        hireRateAmount: 700,
        days: [unsupportedDay("2026-08-03")],
      }),
    );
    expect(r.daysUnsupported).toBe(1);
    expect(r.valueAtRisk).toBeNull();
    expect(r.reasons.join(" ")).toContain("cannot be converted to money");
  });

  it("says so when there is nothing comparable in the period", () => {
    const r = reconcileEquipment(
      machine({ days: [{ date: "2026-08-03", manualWorkingHours: 8, telematicsEngineHours: null }] }),
    );
    expect(r.daysCompared).toBe(0);
    expect(r.varianceHours).toBeNull();
    expect(r.reasons.join(" ")).toContain("nothing to reconcile");
  });

  it("buckets value at risk by currency across a fleet and never adds them", () => {
    const days = Array.from({ length: 3 }, (_, i) => unsupportedDay(`2026-08-0${i + 3}`));
    const summary = reconcileTelematics(
      [
        machine({ days }),
        machine({ equipmentId: "eqp_2", reference: "EQP-0002", currency: "USD", days }),
      ],
      { periodStart: "2026-08-03", periodEnd: "2026-08-05" },
    );
    expect(summary.machinesPersistent).toBe(2);
    expect(summary.valueAtRiskByCurrency).toEqual({ GBP: 630, USD: 630 });
    expect(Object.keys(summary.valueAtRiskByCurrency)).toHaveLength(2);
  });
});

describe("coerceTelematicsRow", () => {
  it("accepts an AEMP-shaped record and keeps the vendor payload verbatim", () => {
    const record = {
      deviceId: "DEV-1",
      recordedAt: "2026-08-03T06:00:00Z",
      engineHours: "1200.5",
      engine_running: "true",
      lat: 51.5,
      lon: -0.12,
      vendorOnlyField: "kept",
    };
    const out = coerceTelematicsRow(record, { providerKey: "generic_aemp" });
    expect(out.row).not.toBeNull();
    expect(out.row!.engineHours).toBe(1200.5);
    expect(out.row!.engineRunning).toBe(1);
    expect(out.row!.latitude).toBe(51.5);
    expect(out.row!.raw["vendorOnlyField"]).toBe("kept");
    expect(out.row!.recordedAt).toBe("2026-08-03T06:00:00.000Z");
  });

  it("rejects a record with no device id and says why", () => {
    const out = coerceTelematicsRow(
      { recordedAt: "2026-08-03T06:00:00Z" },
      { providerKey: "generic_aemp" },
    );
    expect(out.row).toBeNull();
    expect(out.issues.map((i) => i.field)).toContain("deviceId");
  });

  it("rejects an unparseable timestamp and an unknown provider", () => {
    const out = coerceTelematicsRow(
      { deviceId: "DEV-1", recordedAt: "not-a-date", providerKey: "acme_tracker" },
      { providerKey: "generic_aemp" },
    );
    expect(out.row).toBeNull();
    expect(out.issues.map((i) => i.code)).toContain("invalid_timestamp");
    expect(out.issues.map((i) => i.code)).toContain("unknown_enum");
  });

  it("normalises the idempotency key so a replay collides", () => {
    expect(telematicsKey("generic_aemp", "DEV-1", "2026-08-03T06:00:00Z")).toBe(
      telematicsKey("generic_aemp", "DEV-1", "2026-08-03T06:00:00.000Z"),
    );
  });
});

/* ================================================================== */
/* Telematics intelligence (WP-EQUIP upgrade)                          */
/* ================================================================== */

describe("engineHoursForDay — the counter does not stop at midnight", () => {
  it("carries the previous day's last reading in as the opening point", () => {
    const out = engineHoursForDay({
      openingReading: { recordedAt: "2026-08-02T21:00:00.000Z", engineHours: 1200 },
      dayReadings: [
        { recordedAt: "2026-08-03T08:00:00.000Z", engineHours: 1201 },
        { recordedAt: "2026-08-03T17:00:00.000Z", engineHours: 1210 },
      ],
    });
    // 1210 − 1200 = 10, not the 9 that last-minus-first inside the day gives.
    expect(out.hours).toBe(10);
    expect(out.reasons).toHaveLength(0);
  });

  it("states a day's hours from a device that reports once a day", () => {
    const out = engineHoursForDay({
      openingReading: { recordedAt: "2026-08-02T23:00:00.000Z", engineHours: 1200 },
      dayReadings: [{ recordedAt: "2026-08-03T23:00:00.000Z", engineHours: 1208.5 }],
    });
    expect(out.hours).toBe(8.5);
  });

  it("falls back to within-day and says what was lost when there is no carry-in", () => {
    const out = engineHoursForDay({
      openingReading: null,
      dayReadings: [
        { recordedAt: "2026-08-03T08:00:00.000Z", engineHours: 1201 },
        { recordedAt: "2026-08-03T17:00:00.000Z", engineHours: 1210 },
      ],
    });
    expect(out.hours).toBe(9);
    expect(out.reasons.join(" ")).toContain("no reading exists before this day");
  });

  it("refuses a figure when the counter went backwards", () => {
    const out = engineHoursForDay({
      openingReading: { recordedAt: "2026-08-02T21:00:00.000Z", engineHours: 1200 },
      dayReadings: [{ recordedAt: "2026-08-03T17:00:00.000Z", engineHours: 40 }],
    });
    expect(out.hours).toBeNull();
    expect(out.reasons.join(" ")).toContain("reset or replaced");
  });

  it("does not turn silence into zero hours", () => {
    const out = engineHoursForDay({
      openingReading: { recordedAt: "2026-08-02T21:00:00.000Z", engineHours: 1200 },
      dayReadings: [],
    });
    expect(out.hours).toBeNull();
    expect(out.reasons.join(" ")).toContain("not distinguishable");
  });
});

describe("checkGeofence", () => {
  const site = { latitude: 51.5, longitude: -0.12 };

  it("says nothing when the project has no location", () => {
    const out = checkGeofence({
      site: null,
      readings: [{ latitude: 52, longitude: 0, recordedAt: "2026-08-03T09:00:00.000Z", engineRunning: 1 }],
    });
    expect(out.breaches).toHaveLength(0);
    expect(out.reasons.join(" ")).toContain("no fence to test");
  });

  it("finds a machine running well outside the fence", () => {
    const out = checkGeofence({
      site,
      radiusMetres: 1000,
      readings: [
        { latitude: 51.5, longitude: -0.121, recordedAt: "2026-08-03T08:00:00.000Z", engineRunning: 1 },
        { latitude: 51.7, longitude: -0.12, recordedAt: "2026-08-03T09:00:00.000Z", engineRunning: 1 },
        { latitude: 51.7, longitude: -0.12, recordedAt: "2026-08-03T13:00:00.000Z", engineRunning: 1 },
      ],
    });
    expect(out.breaches).toHaveLength(2);
    expect(out.maxDistanceMetres).toBeGreaterThan(20_000);
    expect(out.spanHours).toBe(4);
  });

  it("ignores a machine parked off site with the engine off", () => {
    const out = checkGeofence({
      site,
      radiusMetres: 1000,
      readings: [
        { latitude: 51.9, longitude: -0.12, recordedAt: "2026-08-03T22:00:00.000Z", engineRunning: 0 },
      ],
    });
    expect(out.breaches).toHaveLength(0);
    expect(out.reasons.join(" ")).toContain("engine running");
  });
});

describe("reconcileFuel", () => {
  it("refuses to compare when the feed reports no consumption", () => {
    const out = reconcileFuel({
      telematicsFuelUsedLitres: [null, null],
      fills: [{ litres: 400, at: "2026-08-03T08:00:00.000Z" }],
    });
    expect(out.burnLitres).toBeNull();
    expect(out.unexplained).toBe(false);
    expect(out.reasons.join(" ")).toContain("gap in the feed, not evidence of a loss");
  });

  it("passes a fill that matches the burn inside tolerance", () => {
    const out = reconcileFuel({
      telematicsFuelUsedLitres: [180, 200],
      fills: [{ litres: 400, at: "2026-08-03T08:00:00.000Z" }],
    });
    expect(out.unexplained).toBe(false);
    expect(out.differenceLitres).toBe(20);
  });

  it("flags fills that materially outrun the burn", () => {
    const out = reconcileFuel({
      telematicsFuelUsedLitres: [100, 100],
      fills: [
        { litres: 300, at: "2026-08-03T08:00:00.000Z" },
        { litres: 300, at: "2026-08-05T08:00:00.000Z" },
      ],
    });
    expect(out.unexplained).toBe(true);
    expect(out.differenceLitres).toBe(400);
    expect(out.reasons.join(" ")).toContain("most stolen commodity");
  });
});

describe("assessFaults", () => {
  it("ignores dashboard-light severities", () => {
    const out = assessFaults([{ code: "SPN-100", severity: "warning" }]);
    expect(out.actionable).toHaveLength(0);
    expect(out.stopWork).toBe(false);
  });

  it("raises a service for a severe fault", () => {
    const out = assessFaults([{ code: "SPN-110", description: "Coolant temp", severity: "severe" }]);
    expect(out.worst).toBe("severe");
    expect(out.stopWork).toBe(false);
    expect(out.reason).toContain("SPN-110");
  });

  it("stops the machine on a critical fault", () => {
    const out = assessFaults([
      { code: "SPN-110", severity: "severe" },
      { code: "SPN-190", description: "Overspeed", severity: "critical" },
    ]);
    expect(out.worst).toBe("critical");
    expect(out.stopWork).toBe(true);
    expect(out.reason).toContain("stop it");
  });
});
