import { describe, expect, it } from "vitest";
import { detectJitConflicts, type JitInput } from "./jit.js";

const input = (over: Partial<JitInput> = {}): JitInput => ({
  tasks: [{ id: "t1", name: "Erect steel L3", startDate: "2026-09-15", actualStart: null, isCritical: false }],
  slots: [],
  items: [],
  units: [],
  today: "2026-09-01",
  ...over,
});

describe("detectJitConflicts", () => {
  it("is quiet when the delivery lands before the task starts", () => {
    const r = detectJitConflicts(
      input({ slots: [{ id: "s1", reference: "DEL-001", scheduleTaskId: "t1", longLeadItemId: null, offsiteUnitId: null, startsAt: "2026-09-12T08:00:00Z", status: "confirmed" }] }),
    );
    expect(r).toEqual([]);
  });

  it("flags a delivery booked after the task start, critical when the task is", () => {
    const slots = [{ id: "s1", reference: "DEL-001", scheduleTaskId: "t1", longLeadItemId: null, offsiteUnitId: null, startsAt: "2026-09-18T08:00:00Z", status: "confirmed" }];
    const r = detectJitConflicts(input({ slots }));
    expect(r).toHaveLength(1);
    expect(r[0]?.kind).toBe("arrives_after_task_start");
    expect(r[0]?.severity).toBe("high");
    expect(r[0]?.daysDelta).toBe(3);
    expect(r[0]?.key).toBe("jit:slot:s1:after");
    const critical = detectJitConflicts(input({ slots, tasks: [{ id: "t1", name: "Erect steel L3", startDate: "2026-09-15", actualStart: null, isCritical: true }] }));
    expect(critical[0]?.severity).toBe("critical");
  });

  it("flags deliveries that arrive far too early", () => {
    const r = detectJitConflicts(
      input({ slots: [{ id: "s1", reference: "DEL-001", scheduleTaskId: "t1", longLeadItemId: null, offsiteUnitId: null, startsAt: "2026-08-01T08:00:00Z", status: "confirmed" }] }),
    );
    expect(r[0]?.kind).toBe("arrives_too_early");
    expect(r[0]?.severity).toBe("low");
  });

  it("ignores cancelled slots", () => {
    const r = detectJitConflicts(
      input({ slots: [{ id: "s1", reference: "DEL-001", scheduleTaskId: "t1", longLeadItemId: null, offsiteUnitId: null, startsAt: "2026-09-18T08:00:00Z", status: "cancelled" }] }),
    );
    expect(r).toEqual([]);
  });

  it("flags a long-lead forecast after the task start", () => {
    const r = detectJitConflicts(
      input({ items: [{ id: "i1", reference: "LLI-001", name: "Steel beams", scheduleTaskId: "t1", expectedOnSite: "2026-09-20", status: "shipped" }] }),
    );
    expect(r[0]?.kind).toBe("forecast_after_task_start");
    expect(r[0]?.daysDelta).toBe(5);
  });

  it("flags an offsite unit not ready when the install task is imminent", () => {
    const r = detectJitConflicts(
      input({
        today: "2026-09-10",
        units: [{ id: "u1", reference: "MOD-001", name: "Bathroom pod 1", scheduleTaskId: "t1", status: "in_production", plannedDeliveryDate: null, actualDeliveryDate: null }],
      }),
    );
    expect(r[0]?.kind).toBe("unit_not_ready_for_install");
    expect(r[0]?.severity).toBe("medium");
  });

  it("flags a task with linked material starting soon and no delivery booked", () => {
    const r = detectJitConflicts(
      input({
        today: "2026-09-08",
        items: [{ id: "i1", reference: "LLI-001", name: "Steel beams", scheduleTaskId: "t1", expectedOnSite: "2026-09-10", status: "shipped" }],
      }),
    );
    expect(r.map((c) => c.kind)).toEqual(["no_delivery_booked"]);
    expect(r[0]?.key).toBe("jit:task:t1:nobooking:2026-09-15");
  });

  it("sorts by severity", () => {
    const r = detectJitConflicts(
      input({
        slots: [
          { id: "s1", reference: "DEL-001", scheduleTaskId: "t1", longLeadItemId: null, offsiteUnitId: null, startsAt: "2026-08-01T08:00:00Z", status: "confirmed" },
          { id: "s2", reference: "DEL-002", scheduleTaskId: "t1", longLeadItemId: null, offsiteUnitId: null, startsAt: "2026-09-18T08:00:00Z", status: "confirmed" },
        ],
      }),
    );
    expect(r.map((c) => c.severity)).toEqual(["high", "low"]);
  });
});
