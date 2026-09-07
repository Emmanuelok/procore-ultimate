import { describe, expect, it } from "vitest";
import { buildRegister, dailyPresence, type GateEventInput } from "./occupancy.js";

let seq = 0;
function ev(partial: Partial<GateEventInput> & { occurredAt: string; direction: string; personKey: string }): GateEventInput {
  seq += 1;
  return {
    id: `ev${String(seq).padStart(4, "0")}`,
    accepted: 1,
    personName: partial.personKey,
    passId: null,
    workerId: null,
    vendorId: null,
    personKind: "worker",
    gateName: "north",
    source: "turnstile",
    refusalReason: null,
    ...partial,
  };
}

describe("buildRegister", () => {
  it("folds a normal in/out day to an empty site", () => {
    const r = buildRegister(
      [
        ev({ occurredAt: "2026-03-02T07:00:00.000Z", direction: "in", personKey: "alice" }),
        ev({ occurredAt: "2026-03-02T16:00:00.000Z", direction: "out", personKey: "alice" }),
      ],
      { asOf: "2026-03-02T18:00:00.000Z" },
    );
    expect(r.headcount).toBe(0);
    expect(r.offSite).toHaveLength(1);
    expect(r.offSite[0]?.completedMinutes).toBe(540);
    expect(r.anomalyCount).toBe(0);
  });

  it("holds people inside and reports the open session length", () => {
    const r = buildRegister([ev({ occurredAt: "2026-03-02T07:00:00.000Z", direction: "in", personKey: "bob" })], {
      asOf: "2026-03-02T09:30:00.000Z",
    });
    expect(r.headcount).toBe(1);
    expect(r.onSite[0]?.sinceAt).toBe("2026-03-02T07:00:00.000Z");
    expect(r.onSite[0]?.openMinutes).toBe(150);
  });

  it("keeps the earliest entry time when a second IN arrives with no OUT", () => {
    const r = buildRegister(
      [
        ev({ occurredAt: "2026-03-02T07:00:00.000Z", direction: "in", personKey: "cara" }),
        ev({ occurredAt: "2026-03-02T09:00:00.000Z", direction: "in", personKey: "cara" }),
      ],
      { asOf: "2026-03-02T10:00:00.000Z" },
    );
    expect(r.onSite[0]?.sinceAt).toBe("2026-03-02T07:00:00.000Z");
    expect(r.onSite[0]?.openMinutes).toBe(180);
    expect(r.anomalyCount).toBe(1);
    expect(r.onSite[0]?.anomalies[0]).toContain("no exit");
  });

  it("records an OUT with no matching IN as an anomaly and leaves them outside", () => {
    const r = buildRegister([ev({ occurredAt: "2026-03-02T16:00:00.000Z", direction: "out", personKey: "dan" })], {
      asOf: "2026-03-02T18:00:00.000Z",
    });
    expect(r.headcount).toBe(0);
    expect(r.anomalyCount).toBe(1);
    expect(r.offSite[0]?.anomalies[0]).toContain("no matching entry");
  });

  it("never lets a refused read change the register", () => {
    const r = buildRegister(
      [ev({ occurredAt: "2026-03-02T07:00:00.000Z", direction: "in", personKey: "eve", accepted: 0, refusalReason: "pass_expired" })],
      { asOf: "2026-03-02T08:00:00.000Z" },
    );
    expect(r.headcount).toBe(0);
    expect(r.refusedEvents).toBe(1);
    expect(r.offSite[0]?.refusals).toBe(1);
  });

  it("ignores events after asOf so a historic muster is reproducible", () => {
    const events = [
      ev({ occurredAt: "2026-03-02T07:00:00.000Z", direction: "in", personKey: "fay" }),
      ev({ occurredAt: "2026-03-02T12:00:00.000Z", direction: "out", personKey: "fay" }),
    ];
    expect(buildRegister(events, { asOf: "2026-03-02T10:00:00.000Z" }).headcount).toBe(1);
    expect(buildRegister(events, { asOf: "2026-03-02T13:00:00.000Z" }).headcount).toBe(0);
  });

  it("flags an overstay without inventing an exit", () => {
    const r = buildRegister([ev({ occurredAt: "2026-03-01T07:00:00.000Z", direction: "in", personKey: "gil" })], {
      asOf: "2026-03-02T07:00:00.000Z",
      overstayHours: 16,
    });
    expect(r.overstays).toHaveLength(1);
    expect(r.headcount).toBe(1);
    expect(r.overstays[0]?.openMinutes).toBe(1440);
  });

  it("buckets the live headcount by employer and person kind", () => {
    const r = buildRegister(
      [
        ev({ occurredAt: "2026-03-02T07:00:00.000Z", direction: "in", personKey: "h", vendorId: "ven_a", personKind: "worker" }),
        ev({ occurredAt: "2026-03-02T07:05:00.000Z", direction: "in", personKey: "i", vendorId: "ven_a", personKind: "worker" }),
        ev({ occurredAt: "2026-03-02T07:10:00.000Z", direction: "in", personKey: "j", vendorId: null, personKind: "visitor" }),
      ],
      { asOf: "2026-03-02T08:00:00.000Z" },
    );
    expect(r.byVendor).toEqual({ ven_a: 2, unassigned: 1 });
    expect(r.byPersonKind).toEqual({ worker: 2, visitor: 1 });
  });

  it("is order-independent: shuffled input folds identically", () => {
    const events = [
      ev({ occurredAt: "2026-03-02T07:00:00.000Z", direction: "in", personKey: "k" }),
      ev({ occurredAt: "2026-03-02T12:00:00.000Z", direction: "out", personKey: "k" }),
      ev({ occurredAt: "2026-03-02T13:00:00.000Z", direction: "in", personKey: "k" }),
    ];
    const a = buildRegister(events, { asOf: "2026-03-02T14:00:00.000Z" });
    const b = buildRegister([...events].reverse(), { asOf: "2026-03-02T14:00:00.000Z" });
    expect(b.headcount).toBe(a.headcount);
    expect(b.onSite[0]?.sinceAt).toBe(a.onSite[0]?.sinceAt);
    expect(b.offSite).toEqual(a.offSite);
  });
});

describe("dailyPresence", () => {
  it("computes hours per person per day", () => {
    const rows = dailyPresence(
      [
        ev({ occurredAt: "2026-03-02T07:00:00.000Z", direction: "in", personKey: "alice", workerId: "wk1" }),
        ev({ occurredAt: "2026-03-02T16:30:00.000Z", direction: "out", personKey: "alice", workerId: "wk1" }),
      ],
      { from: "2026-03-02", to: "2026-03-02" },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.hours).toBe(9.5);
    expect(rows[0]?.firstIn).toBe("2026-03-02T07:00:00.000Z");
    expect(rows[0]?.lastOut).toBe("2026-03-02T16:30:00.000Z");
  });

  it("splits a night shift across the midnight boundary", () => {
    const rows = dailyPresence(
      [
        ev({ occurredAt: "2026-03-02T22:00:00.000Z", direction: "in", personKey: "nate" }),
        ev({ occurredAt: "2026-03-03T06:00:00.000Z", direction: "out", personKey: "nate" }),
      ],
      { from: "2026-03-02", to: "2026-03-03" },
    );
    expect(rows.map((r) => [r.date, r.hours])).toEqual([
      ["2026-03-02", 2],
      ["2026-03-03", 6],
    ]);
  });

  it("contributes no hours for a session still open at the window end", () => {
    const rows = dailyPresence([ev({ occurredAt: "2026-03-02T07:00:00.000Z", direction: "in", personKey: "opal" })], {
      from: "2026-03-02",
      to: "2026-03-02",
    });
    expect(rows[0]?.hours).toBe(0);
    expect(rows[0]?.openAtWindowEnd).toBe(true);
  });
});
