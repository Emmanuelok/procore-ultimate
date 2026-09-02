import { describe, expect, it } from "vitest";
import {
  assessArrival,
  estimateTransportCarbon,
  onTimeDelivery,
  overlaps,
  peakConcurrency,
  validateBooking,
  type GateRules,
  type SlotWindow,
} from "./logistics.js";

const gate = (over: Partial<GateRules> = {}): GateRules => ({
  opensAt: "07:00",
  closesAt: "18:00",
  concurrentSlots: 1,
  craneAvailable: true,
  maxVehicleType: "articulated",
  status: "open",
  ...over,
});

const slot = (id: string, start: string, end: string, over: Partial<SlotWindow> = {}): SlotWindow => ({
  id,
  startsAt: start,
  endsAt: end,
  craneRequired: false,
  status: "confirmed",
  reference: id.toUpperCase(),
  ...over,
});

describe("overlaps / peakConcurrency", () => {
  it("treats touching windows as non-overlapping", () => {
    expect(overlaps("2026-09-01T08:00:00Z", "2026-09-01T09:00:00Z", "2026-09-01T09:00:00Z", "2026-09-01T10:00:00Z")).toBe(false);
    expect(overlaps("2026-09-01T08:00:00Z", "2026-09-01T09:30:00Z", "2026-09-01T09:00:00Z", "2026-09-01T10:00:00Z")).toBe(true);
  });
  it("finds the busiest minute", () => {
    const peak = peakConcurrency(
      [
        slot("a", "2026-09-01T08:00:00Z", "2026-09-01T09:00:00Z"),
        slot("b", "2026-09-01T08:30:00Z", "2026-09-01T09:30:00Z"),
        slot("c", "2026-09-01T09:15:00Z", "2026-09-01T10:00:00Z"),
      ],
      "2026-09-01T08:00:00Z",
      "2026-09-01T10:00:00Z",
    );
    expect(peak).toBe(2);
  });
});

describe("validateBooking", () => {
  const req = (over: Partial<Parameters<typeof validateBooking>[2]> = {}) => ({
    startsAt: "2026-09-01T08:00:00Z",
    endsAt: "2026-09-01T08:30:00Z",
    craneRequired: false,
    vehicleType: "rigid_18t",
    ...over,
  });

  it("accepts a clean booking", () => {
    expect(validateBooking(gate(), [], req())).toEqual([]);
  });

  it("refuses an inverted window", () => {
    expect(validateBooking(gate(), [], req({ endsAt: "2026-09-01T07:00:00Z" }))[0]?.kind).toBe("invalid_window");
  });

  it("refuses outside gate hours and closed gates", () => {
    expect(validateBooking(gate(), [], req({ startsAt: "2026-09-01T06:00:00Z", endsAt: "2026-09-01T06:30:00Z" })).map((c) => c.kind)).toContain("outside_hours");
    expect(validateBooking(gate({ status: "closed" }), [], req()).map((c) => c.kind)).toContain("gate_closed");
  });

  it("refuses when the bays are full and names the clash", () => {
    const existing = [slot("s1", "2026-09-01T08:15:00Z", "2026-09-01T08:45:00Z")];
    const conflicts = validateBooking(gate(), existing, req());
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.kind).toBe("capacity");
    expect(conflicts[0]?.clashingSlotIds).toEqual(["s1"]);
    expect(conflicts[0]?.detail).toContain("S1");
  });

  it("allows a second vehicle when the gate has two bays, but not a third", () => {
    const existing = [slot("s1", "2026-09-01T08:00:00Z", "2026-09-01T08:30:00Z")];
    expect(validateBooking(gate({ concurrentSlots: 2 }), existing, req())).toEqual([]);
    const two = [...existing, slot("s2", "2026-09-01T08:00:00Z", "2026-09-01T08:30:00Z")];
    expect(validateBooking(gate({ concurrentSlots: 2 }), two, req()).map((c) => c.kind)).toContain("capacity");
  });

  it("ignores cancelled and no-show slots and the slot being edited", () => {
    const existing = [
      slot("s1", "2026-09-01T08:00:00Z", "2026-09-01T08:30:00Z", { status: "cancelled" }),
      slot("s2", "2026-09-01T08:00:00Z", "2026-09-01T08:30:00Z", { status: "no_show" }),
      slot("me", "2026-09-01T08:00:00Z", "2026-09-01T08:30:00Z"),
    ];
    expect(validateBooking(gate(), existing, req({ excludeSlotId: "me" }))).toEqual([]);
  });

  it("refuses a crane clash and a crane request at a gate with none", () => {
    const existing = [slot("s1", "2026-09-01T08:00:00Z", "2026-09-01T08:30:00Z", { craneRequired: true })];
    const c = validateBooking(gate({ concurrentSlots: 3 }), existing, req({ craneRequired: true }));
    expect(c.map((x) => x.kind)).toEqual(["crane"]);
    expect(validateBooking(gate({ craneAvailable: false }), [], req({ craneRequired: true })).map((x) => x.kind)).toEqual(["crane"]);
  });

  it("refuses a vehicle bigger than the approach takes", () => {
    expect(validateBooking(gate({ maxVehicleType: "rigid_18t" }), [], req({ vehicleType: "articulated" })).map((x) => x.kind)).toEqual(["vehicle_too_large"]);
    expect(validateBooking(gate({ maxVehicleType: "rigid_18t" }), [], req({ vehicleType: "van" }))).toEqual([]);
  });
});

describe("assessArrival / onTimeDelivery", () => {
  it("grants a grace period and measures waiting", () => {
    const s = { startsAt: "2026-09-01T08:00:00Z", endsAt: "2026-09-01T08:30:00Z" };
    expect(assessArrival(s, "2026-09-01T08:10:00Z", "2026-09-01T08:25:00Z")).toEqual({ wasOnTime: true, lateMinutes: 10, waitingMinutes: 15 });
    expect(assessArrival(s, "2026-09-01T07:40:00Z", null)).toEqual({ wasOnTime: true, lateMinutes: 0, waitingMinutes: null });
    expect(assessArrival(s, "2026-09-01T08:40:00Z", null).wasOnTime).toBe(false);
  });

  it("computes on-time % only from assessed deliveries and says so when there are none", () => {
    expect(onTimeDelivery([]).onTimePercent).toBeNull();
    expect(onTimeDelivery([]).reasons[0]).toMatch(/No completed deliveries/);
    const stats = onTimeDelivery([
      { status: "completed", wasOnTime: 1, lateMinutes: 0, waitingMinutes: 10 },
      { status: "completed", wasOnTime: 0, lateMinutes: 40, waitingMinutes: 30 },
      { status: "completed", wasOnTime: 1, lateMinutes: 5, waitingMinutes: null },
      { status: "no_show", wasOnTime: null, lateMinutes: null, waitingMinutes: null },
      { status: "confirmed", wasOnTime: null, lateMinutes: null, waitingMinutes: null },
    ]);
    expect(stats.completed).toBe(3);
    expect(stats.onTimePercent).toBeCloseTo(66.7, 1);
    expect(stats.noShow).toBe(1);
    expect(stats.averageLateMinutes).toBe(40);
    expect(stats.averageWaitingMinutes).toBe(20);
  });
});

describe("estimateTransportCarbon", () => {
  it("produces no figure without a distance, with the reason", () => {
    const r = estimateTransportCarbon({ transportMode: "road", vehicleType: "articulated", transportKm: null, loadTonnes: null });
    expect(r.kgCo2e).toBeNull();
    expect(r.reasons[0]).toMatch(/distance not recorded/);
  });
  it("uses the generic road factor per vehicle-km and says it is generic", () => {
    const r = estimateTransportCarbon({ transportMode: "road", vehicleType: "articulated", transportKm: 120, loadTonnes: null });
    expect(r.kgCo2e).toBe(114);
    expect(r.basis).toMatch(/generic road factor/);
  });
  it("needs a load weight for tonne-km modes", () => {
    expect(estimateTransportCarbon({ transportMode: "sea", vehicleType: "other", transportKm: 5000, loadTonnes: null }).reasons[0]).toMatch(/load weight/);
    expect(estimateTransportCarbon({ transportMode: "sea", vehicleType: "other", transportKm: 5000, loadTonnes: 20 }).kgCo2e).toBe(1600);
  });
});
