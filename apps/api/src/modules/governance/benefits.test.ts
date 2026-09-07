import { describe, expect, it } from "vitest";
import type { BenefitStatus } from "@constructos/shared";
import {
  propagateBenefitStatus,
  realisationSeries,
  topoOrder,
  wouldCycle,
  type BenefitEdge,
  type BenefitNode,
} from "./benefits.js";

const node = (id: string, ownStatus: BenefitStatus, over: Partial<BenefitNode> = {}): BenefitNode => ({
  id,
  number: Number(id.replace(/\D/g, "")) || 1,
  name: `Benefit ${id}`,
  ownStatus,
  baselineValue: 0,
  targetValue: 100,
  latestValue: null,
  targetDate: null,
  isDisbenefit: false,
  ...over,
});

const edge = (from: string, to: string, depType: BenefitEdge["depType"] = "enables"): BenefitEdge => ({
  fromBenefitId: from,
  toBenefitId: to,
  depType,
});

describe("topological ordering", () => {
  it("orders predecessors before successors", () => {
    const nodes = [node("b3", "tracking"), node("b1", "tracking"), node("b2", "tracking")];
    const edges = [edge("b1", "b2"), edge("b2", "b3")];
    expect(topoOrder(nodes, edges)).toEqual(["b1", "b2", "b3"]);
  });

  it("still returns every node when a cycle exists", () => {
    const nodes = [node("b1", "tracking"), node("b2", "tracking")];
    const edges = [edge("b1", "b2"), edge("b2", "b1")];
    expect(topoOrder(nodes, edges).sort()).toEqual(["b1", "b2"]);
  });

  it("ignores edges pointing outside the node set", () => {
    const nodes = [node("b1", "tracking")];
    expect(topoOrder(nodes, [edge("b1", "ghost")])).toEqual(["b1"]);
  });
});

describe("cycle detection", () => {
  it("rejects a self edge", () => {
    expect(wouldCycle([], "b1", "b1")).toBe(true);
  });

  it("detects the closing edge of a longer loop", () => {
    const edges = [edge("b1", "b2"), edge("b2", "b3")];
    expect(wouldCycle(edges, "b3", "b1")).toBe(true);
    expect(wouldCycle(edges, "b1", "b3")).toBe(false);
  });
});

describe("status propagation (#418-419)", () => {
  it("an enabling dependency that is missed makes its successor missed", () => {
    const nodes = [node("b1", "missed"), node("b2", "tracking")];
    const out = propagateBenefitStatus(nodes, [edge("b1", "b2", "enables")]);
    const b2 = out.find((o) => o.id === "b2")!;
    expect(b2.effectiveStatus).toBe("missed");
    expect(b2.inherited).toBe(true);
    expect(b2.causedBy).toEqual(["b1"]);
    expect(b2.reason).toContain("Benefit b1");
  });

  it("a contributing dependency only ever propagates at_risk", () => {
    const nodes = [node("b1", "missed"), node("b2", "tracking")];
    const out = propagateBenefitStatus(nodes, [edge("b1", "b2", "contributes")]);
    expect(out.find((o) => o.id === "b2")!.effectiveStatus).toBe("at_risk");
  });

  it("propagates transitively through the chain", () => {
    const nodes = [node("b1", "at_risk"), node("b2", "tracking"), node("b3", "tracking")];
    const out = propagateBenefitStatus(nodes, [edge("b1", "b2"), edge("b2", "b3")]);
    expect(out.find((o) => o.id === "b3")!.effectiveStatus).toBe("at_risk");
  });

  it("never un-does a measured realisation", () => {
    const nodes = [node("b1", "missed"), node("b2", "realised")];
    const out = propagateBenefitStatus(nodes, [edge("b1", "b2")]);
    const b2 = out.find((o) => o.id === "b2")!;
    expect(b2.effectiveStatus).toBe("realised");
    expect(b2.inherited).toBe(false);
  });

  it("never improves a benefit that is already worse than its predecessors", () => {
    const nodes = [node("b1", "tracking"), node("b2", "missed")];
    const out = propagateBenefitStatus(nodes, [edge("b1", "b2")]);
    const b2 = out.find((o) => o.id === "b2")!;
    expect(b2.effectiveStatus).toBe("missed");
    expect(b2.inherited).toBe(false);
  });

  it("leaves an unconnected register untouched", () => {
    const nodes = [node("b1", "planned"), node("b2", "tracking")];
    const out = propagateBenefitStatus(nodes, []);
    expect(out.every((o) => !o.inherited)).toBe(true);
  });

  it("names every predecessor that caused the downgrade", () => {
    const nodes = [node("b1", "at_risk"), node("b2", "at_risk"), node("b3", "tracking")];
    const out = propagateBenefitStatus(nodes, [edge("b1", "b3"), edge("b2", "b3")]);
    const b3 = out.find((o) => o.id === "b3")!;
    expect(b3.effectiveStatus).toBe("at_risk");
    expect(b3.causedBy.sort()).toEqual(["b1", "b2"]);
  });
});

describe("realisation series (#421-422)", () => {
  const nodes = [
    node("b1", "tracking", { baselineValue: 0, targetValue: 100, targetDate: "2026-06-30" }),
    node("b2", "tracking", { baselineValue: 10, targetValue: 60, targetDate: "2026-12-31" }),
  ];
  const readings = [
    { benefitId: "b1", readingDate: "2026-03-31", value: 40 },
    { benefitId: "b1", readingDate: "2026-09-30", value: 90 },
    { benefitId: "b2", readingDate: "2026-09-30", value: 35 },
  ];

  it("accumulates planned value only once a target date has arrived", () => {
    const series = realisationSeries(nodes, readings, ["2026-03-31", "2026-06-30", "2026-12-31"]);
    expect(series[0]!.planned).toBeNull();
    expect(series[1]!.planned).toBe(100);
    expect(series[2]!.planned).toBe(150);
  });

  it("accumulates the latest reading at or before each date", () => {
    const series = realisationSeries(nodes, readings, ["2026-03-31", "2026-09-30"]);
    expect(series[0]!.realised).toBe(40);
    // b1 90 − 0 plus b2 35 − 10
    expect(series[1]!.realised).toBe(115);
  });

  it("reports null rather than 0 before any reading exists", () => {
    const series = realisationSeries(nodes, [], ["2026-03-31"]);
    expect(series[0]!.realised).toBeNull();
  });

  it("sorts and de-duplicates the requested dates", () => {
    const series = realisationSeries(nodes, readings, ["2026-09-30", "2026-03-31", "2026-03-31"]);
    expect(series.map((p) => p.date)).toEqual(["2026-03-31", "2026-09-30"]);
  });
});
