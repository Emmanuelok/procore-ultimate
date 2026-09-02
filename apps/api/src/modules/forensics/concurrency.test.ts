import { describe, expect, it } from "vitest";
import { DEFAULT_FLOAT_RULES, analyseConcurrency, overlapDays, type FloatRules } from "./concurrency.js";
import type { ForensicEvent, ForensicNetwork } from "./methods.js";
import type { Cpm2DependencyInput, Cpm2TaskInput } from "../schedule/cpm2.js";

const START = "2026-01-05";

/**
 * Two parallel chains onto a common finish:
 *   a(20d) -> f       (critical)
 *   p(10d) -> f       (10 days of float)
 */
function network(): ForensicNetwork {
  const tasks: Cpm2TaskInput[] = [
    { id: "a", duration: 20 },
    { id: "p", duration: 10 },
    { id: "f", duration: 1 },
  ];
  const deps: Cpm2DependencyInput[] = [
    { predecessorId: "a", successorId: "f", type: "FS", lagDays: 0 },
    { predecessorId: "p", successorId: "f", type: "FS", lagDays: 0 },
  ];
  return { tasks, deps, projectStart: START };
}

function ev(id: string, extra: Partial<ForensicEvent> = {}): ForensicEvent {
  return {
    id,
    title: `Event ${id}`,
    startDate: "2026-01-10",
    durationDays: 10,
    struckTaskId: "a",
    party: "owner",
    excusable: true,
    compensable: true,
    ...extra,
  };
}

describe("overlap", () => {
  it("counts overlapping days of two event spans", () => {
    expect(overlapDays(ev("a", { startDate: "2026-01-01", durationDays: 10 }), ev("b", { startDate: "2026-01-06", durationDays: 10 }))).toBe(5);
    expect(overlapDays(ev("a", { startDate: "2026-01-01", durationDays: 5 }), ev("b", { startDate: "2026-02-01", durationDays: 5 }))).toBe(0);
  });
});

describe("concurrency classification", () => {
  it("classes two overlapping critical-path delays as true concurrency", () => {
    // Both strike the same critical activity over the same window, so together
    // they do not add up: the completion moves once, not twice.
    const res = analyseConcurrency(network(), [
      ev("owner", { struckTaskId: "a", party: "owner", startDate: "2026-01-10", durationDays: 10 }),
      ev("contractor", { struckTaskId: "a", party: "contractor", startDate: "2026-01-12", durationDays: 10, compensable: false }),
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const pair = res.pairs[0]!;
    expect(pair.overlapDays).toBeGreaterThan(0);
    expect(pair.classification).toBe("true_concurrency");
    expect(pair.rationale).toMatch(/less than/);
  });

  it("classes non-overlapping delays as independent", () => {
    const res = analyseConcurrency(network(), [
      ev("e1", { startDate: "2026-01-06", durationDays: 3 }),
      ev("e2", { startDate: "2026-02-10", durationDays: 3 }),
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pairs[0]!.classification).toBe("independent");
  });

  it("classes a float-consuming event tracking a driver as pacing", () => {
    // The parallel chain has 10 days of float; a 10-day event on it consumes
    // exactly the float the 10-day critical event is eating.
    const res = analyseConcurrency(network(), [
      ev("driver", { struckTaskId: "a", durationDays: 10, party: "owner" }),
      ev("pacer", { struckTaskId: "p", durationDays: 10, party: "contractor", compensable: false }),
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pairs[0]!.classification).toBe("pacing");
    const rec = res.recommendations.find((r) => r.eventId === "pacer")!;
    expect(rec.classification).toBe("pacing");
    expect(rec.time).toBe("no");
    expect(rec.money).toBe("no");
    expect(rec.rule).toMatch(/pacing/i);
  });

  it("reports events it cannot model rather than scoring them", () => {
    const res = analyseConcurrency(network(), [ev("bad", { struckTaskId: "ghost" })]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.impacts[0]!.deltaAlone).toBeNull();
    expect(res.impacts[0]!.reason).toMatch(/not in this network/);
    expect(res.recommendations[0]!.time).toBe("no");
  });
});

describe("entitlement recommendations", () => {
  it("gives time and money for a driving compensable owner event with no concurrency", () => {
    const res = analyseConcurrency(network(), [ev("e1", { party: "owner", compensable: true })]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const rec = res.recommendations[0]!;
    expect(rec.time).toBe("yes");
    expect(rec.money).toBe("yes");
    expect(rec.explanation).toMatch(/moves completion/);
  });

  it("gives time but not money under the SCL protocol when concurrent", () => {
    const res = analyseConcurrency(network(), [
      ev("owner", { struckTaskId: "a", party: "owner", startDate: "2026-01-10", durationDays: 10 }),
      ev("contractor", { struckTaskId: "a", party: "contractor", startDate: "2026-01-12", durationDays: 10, compensable: false }),
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const owner = res.recommendations.find((r) => r.eventId === "owner")!;
    expect(owner.time).toBe("yes");
    expect(owner.money).toBe("no");
    expect(owner.rule).toMatch(/SCL/);
    const contractor = res.recommendations.find((r) => r.eventId === "contractor")!;
    expect(contractor.time).toBe("no");
    expect(contractor.money).toBe("no");
  });

  it("apportions time and money when the project records the apportionment doctrine", () => {
    const rules: FloatRules = { ...DEFAULT_FLOAT_RULES, concurrencyRule: "apportionment" };
    const res = analyseConcurrency(
      network(),
      [
        ev("owner", { struckTaskId: "a", party: "owner", startDate: "2026-01-10", durationDays: 10 }),
        ev("contractor", { struckTaskId: "a", party: "contractor", startDate: "2026-01-12", durationDays: 10, compensable: false }),
      ],
      rules,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const owner = res.recommendations.find((r) => r.eventId === "owner")!;
    expect(owner.time).toBe("shared");
    expect(owner.money).toBe("shared");
    expect(owner.rule).toMatch(/City Inn/);
  });

  it("makes float consumption compensable only when the contract gives the contractor the float", () => {
    const events = [ev("e1", { struckTaskId: "p", party: "owner", durationDays: 3 })];
    const projectFloat = analyseConcurrency(network(), events, DEFAULT_FLOAT_RULES);
    expect(projectFloat.ok).toBe(true);
    if (!projectFloat.ok) return;
    expect(projectFloat.recommendations[0]!.money).toBe("no");
    expect(projectFloat.recommendations[0]!.rule).toMatch(/belongs to the project/);

    const contractorFloat = analyseConcurrency(network(), events, {
      ...DEFAULT_FLOAT_RULES,
      ownership: "contractor",
    });
    expect(contractorFloat.ok).toBe(true);
    if (!contractorFloat.ok) return;
    expect(contractorFloat.recommendations[0]!.money).toBe("yes");
    expect(contractorFloat.recommendations[0]!.rule).toMatch(/owned by the contractor/);
  });

  it("never gives a contractor-culpable event time or money", () => {
    const res = analyseConcurrency(network(), [
      ev("e1", { party: "contractor", compensable: false, excusable: false }),
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.recommendations[0]!.time).toBe("no");
    expect(res.recommendations[0]!.money).toBe("no");
  });

  it("refuses to run on a cyclic network", () => {
    const n = network();
    n.deps.push({ predecessorId: "f", successorId: "a", type: "FS", lagDays: 0 });
    const res = analyseConcurrency(n, [ev("e1")]);
    expect(res.ok).toBe(false);
  });
});
