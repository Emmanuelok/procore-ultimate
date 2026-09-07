import { describe, expect, it } from "vitest";
import { reconcileMuster, type CheckinEntry, type RegisterEntry } from "./muster.js";

const register: RegisterEntry[] = [
  { key: "p1", name: "Alice", passId: "pass1", workerId: "wk1", sinceAt: "2026-03-02T07:00:00.000Z" },
  { key: "p2", name: "Bob", passId: "pass2", workerId: null, sinceAt: "2026-03-02T07:05:00.000Z" },
  { key: "p3", name: "Cara", passId: "pass3", workerId: null, sinceAt: "2026-03-02T07:10:00.000Z" },
];

const declaredAt = "2026-03-02T10:00:00.000Z";

describe("reconcileMuster", () => {
  it("names who is missing rather than counting them", () => {
    const checkins: CheckinEntry[] = [
      { personKey: "p1", personName: "Alice", status: "present", checkedInAt: "2026-03-02T10:03:00.000Z" },
      { personKey: "p2", personName: "Bob", status: "accounted_offsite", checkedInAt: "2026-03-02T10:04:00.000Z" },
    ];
    const r = reconcileMuster(register, checkins, { declaredAt });
    expect(r.expectedCount).toBe(3);
    expect(r.accountedCount).toBe(2);
    expect(r.unaccountedCount).toBe(1);
    expect(r.unaccounted.map((p) => p.name)).toEqual(["Cara"]);
    expect(r.clear).toBe(false);
    expect(r.durationSeconds).toBe(240);
  });

  it("is clear only when everyone on a non-empty register is accounted for", () => {
    const checkins: CheckinEntry[] = register.map((p) => ({
      personKey: p.key,
      personName: p.name,
      status: "present",
      checkedInAt: "2026-03-02T10:02:00.000Z",
    }));
    const r = reconcileMuster(register, checkins, { declaredAt });
    expect(r.clear).toBe(true);
    expect(r.unaccountedCount).toBe(0);
  });

  it("refuses to call an empty register clear", () => {
    const r = reconcileMuster([], [], { declaredAt });
    expect(r.clear).toBe(false);
    expect(r.reasons[0]).toContain("empty");
  });

  it("reports people at the point who were not on the register", () => {
    const r = reconcileMuster(register, [
      { personKey: "p1", personName: "Alice", status: "present", checkedInAt: declaredAt },
      { personKey: "p2", personName: "Bob", status: "present", checkedInAt: declaredAt },
      { personKey: "p3", personName: "Cara", status: "present", checkedInAt: declaredAt },
      { personKey: "ghost", personName: "Unbadged visitor", status: "present", checkedInAt: declaredAt },
    ], { declaredAt });
    expect(r.unexpectedCount).toBe(1);
    expect(r.unexpected[0]?.name).toBe("Unbadged visitor");
    expect(r.unexpected[0]?.onRegister).toBe(false);
    expect(r.reasons.some((x) => x.includes("without being on the register"))).toBe(true);
  });

  it("takes the strongest claim when a person is checked in twice", () => {
    const r = reconcileMuster(register.slice(0, 1), [
      { personKey: "p1", personName: "Alice", status: "unaccounted", checkedInAt: null },
      { personKey: "p1", personName: "Alice", status: "present", checkedInAt: "2026-03-02T10:01:00.000Z" },
    ], { declaredAt });
    expect(r.present.map((p) => p.name)).toEqual(["Alice"]);
    expect(r.unaccountedCount).toBe(0);
  });

  it("treats an explicitly unaccounted check-in row as still missing", () => {
    const r = reconcileMuster(register.slice(0, 1), [
      { personKey: "p1", personName: "Alice", status: "unaccounted", checkedInAt: null },
    ], { declaredAt });
    expect(r.unaccountedCount).toBe(1);
    expect(r.durationSeconds).toBeNull();
  });
});
