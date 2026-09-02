import { describe, expect, it } from "vitest";
import type { ClauseChange } from "./parser.js";
import { planReissue, refsOverlap, type ReissueRequirement } from "./reissue.js";

const req = (id: string, ref: string | null, status = "identified", sub: string | null = null): ReissueRequirement => ({
  id,
  paragraphRef: ref,
  status,
  registeredSubmittalId: sub,
});

describe("paragraph-tree overlap", () => {
  it("matches the same node, an ancestor and a descendant — never a sibling", () => {
    expect(refsOverlap("1.3.B.2", "1.3.B.2")).toBe(true);
    expect(refsOverlap("1.3.B.2", "1.3.B")).toBe(true);
    expect(refsOverlap("1.3.B", "1.3.B.2.a")).toBe(true);
    expect(refsOverlap("1.3.B.2", "1.3.B.20")).toBe(false);
    expect(refsOverlap("1.3.B", "1.3.C")).toBe(false);
  });
});

describe("reissue impact on the register (#288)", () => {
  const changes: ClauseChange[] = [
    { ref: "1.3.A", kind: "amended", text: "Product Data: five copies", previousText: "Product Data: three copies" },
    { ref: "1.3.C", kind: "removed", text: "Samples" },
    { ref: "1.4.B", kind: "added", text: "Mock-ups" },
  ];

  it("supersedes unregistered rows whose clause was removed", () => {
    const plan = planReissue(changes, [req("r1", "1.3.C"), req("r2", "1.3.C", "confirmed")]);
    expect(plan.superseded.sort()).toEqual(["r1", "r2"]);
    expect(plan.reconfirm).toEqual([]);
  });

  it("voids the confirmation of a confirmed row whose clause was amended and flags an identified one", () => {
    const plan = planReissue(changes, [req("c", "1.3.A", "confirmed"), req("i", "1.3.A.1", "identified")]);
    expect(plan.reconfirm).toEqual(["c"]);
    expect(plan.flagged).toEqual(["i"]);
  });

  it("reports registered rows whose clause changed instead of touching them", () => {
    const plan = planReissue(changes, [
      req("reg1", "1.3.A", "registered", "sub_1"),
      req("reg2", "1.3.C", "registered", "sub_2"),
    ]);
    expect(plan.registeredChanged).toEqual([
      { requirementId: "reg1", submittalId: "sub_1", paragraphRef: "1.3.A", kind: "amended" },
      { requirementId: "reg2", submittalId: "sub_2", paragraphRef: "1.3.C", kind: "removed" },
    ]);
    expect(plan.superseded).toEqual([]);
  });

  it("leaves untouched what the reissue did not touch", () => {
    const plan = planReissue(changes, [
      req("u1", "1.3.B"),
      req("u2", null, "confirmed"),
      req("u3", "1.3.C", "not_required"),
      req("u4", "1.3.A", "superseded"),
    ]);
    expect(plan.unchanged.sort()).toEqual(["u1", "u2", "u3", "u4"]);
  });

  it("does nothing on a reissue with no clause changes", () => {
    const plan = planReissue([], [req("a", "1.3.A", "confirmed")]);
    expect(plan).toEqual({ superseded: [], reconfirm: [], flagged: [], registeredChanged: [], unchanged: ["a"] });
  });
});
