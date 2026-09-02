import { describe, expect, it } from "vitest";
import {
  canReleaseLeg,
  chainSummary,
  isLegTerminal,
  legLabel,
  nextLeg,
  type ReleaseLegLike,
} from "./releaseChain.js";

const leg = (over: Partial<ReleaseLegLike> & { id: string; position: number }): ReleaseLegLike => ({
  party: "contractor",
  required: 1,
  userId: null,
  organisation: null,
  contactName: null,
  status: "pending",
  releasedBy: null,
  releasedAt: null,
  ...over,
});

const chain = (): ReleaseLegLike[] => [
  leg({ id: "l1", position: 1, party: "contractor", userId: "u-qc" }),
  leg({ id: "l2", position: 2, party: "engineer", userId: "u-eng" }),
  leg({ id: "l3", position: 3, party: "third_party", organisation: "Notified Body", required: 0 }),
];

describe("chainSummary", () => {
  it("names whose turn it is and refuses to call the chain complete", () => {
    const summary = chainSummary(chain());
    expect(summary.nextLegId).toBe("l1");
    expect(summary.complete).toBe(false);
    expect(summary.requiredCount).toBe(2);
    expect(summary.reasons.join(" ")).toContain("Waiting on 2 required leg");
  });

  it("is complete once every required leg is signed, optional legs notwithstanding", () => {
    const legs = chain();
    legs[0]!.status = "released";
    legs[1]!.status = "waived";
    const summary = chainSummary(legs);
    expect(summary.complete).toBe(true);
    expect(summary.nextLegId).toBeNull();
  });

  it("reports a rejection as a refusal rather than a delay", () => {
    const legs = chain();
    legs[0]!.status = "released";
    legs[1]!.status = "rejected";
    const summary = chainSummary(legs);
    expect(summary.rejected).toBe(true);
    expect(summary.complete).toBe(false);
    expect(summary.reasons.join(" ")).toContain("refusal to certify");
  });

  it("says plainly when no chain is recorded at all", () => {
    const summary = chainSummary([]);
    expect(summary.complete).toBe(false);
    expect(summary.reasons.join(" ")).toContain("No sign-off chain is recorded");
  });
});

describe("canReleaseLeg", () => {
  it("lets the nominated user sign their own leg when it is their turn", () => {
    const decision = canReleaseLeg(chain(), "l1", { actorId: "u-qc", raisedBy: "u-author" });
    expect(decision.allowed).toBe(true);
  });

  it("refuses a leg signed out of sequence and names what is ahead of it", () => {
    const decision = canReleaseLeg(chain(), "l2", { actorId: "u-eng", raisedBy: "u-author" });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("out_of_sequence");
    expect(decision.reasons.join(" ")).toContain("still outstanding");
  });

  it("refuses a user who is not the nominated one", () => {
    const decision = canReleaseLeg(chain(), "l1", { actorId: "u-someone", raisedBy: "u-author" });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("wrong_party");
  });

  it("refuses the person who raised the point on an organisation-only leg", () => {
    const legs = [leg({ id: "l1", position: 1, organisation: "ACME QA" })];
    const decision = canReleaseLeg(legs, "l1", { actorId: "u-author", raisedBy: "u-author" });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("self_release");
  });

  it("refuses one human standing in for two independent parties", () => {
    const legs = chain();
    legs[0]!.status = "released";
    legs[0]!.releasedBy = "u-eng";
    legs[1]!.userId = "u-eng";
    const decision = canReleaseLeg(legs, "l2", { actorId: "u-eng", raisedBy: "u-author" });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("duplicate_actor");
    expect(decision.reasons.join(" ")).toContain("two independent parties");
  });

  it("refuses a leg that is already terminal", () => {
    const legs = chain();
    legs[0]!.status = "released";
    legs[0]!.releasedBy = "u-qc";
    const decision = canReleaseLeg(legs, "l1", { actorId: "u-qc", raisedBy: "u-author" });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("terminal");
  });

  it("allows a rejection out of sequence, because a refusal does not wait its turn", () => {
    const decision = canReleaseLeg(chain(), "l2", {
      actorId: "u-eng",
      raisedBy: "u-author",
      enforceSequence: false,
    });
    expect(decision.allowed).toBe(true);
  });

  it("refuses a leg that is not part of the chain", () => {
    expect(canReleaseLeg(chain(), "nope", { actorId: "u-qc", raisedBy: null }).code).toBe("no_legs");
  });

  it("skips optional legs when deciding whose turn it is", () => {
    const legs = [
      leg({ id: "l1", position: 1, required: 0, userId: "u-a" }),
      leg({ id: "l2", position: 2, userId: "u-b" }),
    ];
    expect(nextLeg(legs)?.id).toBe("l2");
    expect(canReleaseLeg(legs, "l2", { actorId: "u-b", raisedBy: null }).allowed).toBe(true);
  });
});

describe("small helpers", () => {
  it("knows which statuses end a leg", () => {
    expect(isLegTerminal("released")).toBe(true);
    expect(isLegTerminal("notified")).toBe(false);
  });
  it("labels a leg with its organisation where there is one", () => {
    expect(legLabel(leg({ id: "l", position: 1, party: "third_party", organisation: "Lloyd's" }))).toBe(
      "third party (Lloyd's)",
    );
  });
});
