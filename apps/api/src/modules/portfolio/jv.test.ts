import { describe, expect, it } from "vitest";
import { decideVote, venturePosition, type PartnerRow, type TransactionRow } from "./jv.js";

const partners: PartnerRow[] = [
  { id: "pa", name: "Alpha Construction", role: "lead", sharePercent: 60, committedCapital: 6_000_000, liabilityBasis: "joint_and_several", isSelf: true, status: "active" },
  { id: "pb", name: "Beta Civils", role: "partner", sharePercent: 40, committedCapital: 4_000_000, liabilityBasis: "several", isSelf: false, status: "active" },
];

const tx = (over: Partial<TransactionRow> & { id: string; partnerId: string }): TransactionRow => ({
  kind: "capital_contribution",
  currency: "GBP",
  amount: 0,
  dueDate: null,
  settledDate: null,
  status: "paid",
  ...over,
});

describe("venturePosition (#1057, #1059)", () => {
  it("nets contributions against distributions and reports our own share", () => {
    const summary = venturePosition(
      partners,
      [
        tx({ id: "t1", partnerId: "pa", amount: 3_000_000 }),
        tx({ id: "t2", partnerId: "pb", amount: 2_000_000 }),
        tx({ id: "t3", partnerId: "pa", kind: "distribution", amount: 500_000 }),
        tx({ id: "t4", partnerId: "pb", kind: "capital_call", amount: 1_000_000, status: "called", dueDate: "2026-08-01" }),
      ],
      { currency: "GBP", today: "2026-09-02" },
    );
    const alpha = summary.positions.find((p) => p.partnerId === "pa")!;
    const beta = summary.positions.find((p) => p.partnerId === "pb")!;
    expect(alpha.contributed).toBe(3_000_000);
    expect(alpha.distributed).toBe(500_000);
    expect(alpha.netPosition).toBe(2_500_000);
    expect(alpha.uncalledCommitment).toBe(3_000_000);
    expect(beta.outstandingCalls).toBe(1_000_000);
    expect(beta.overdueCalls).toBe(1);
    expect(beta.overdueAmount).toBe(1_000_000);
    expect(summary.ourSharePercent).toBe(60);
    expect(summary.ourContributed).toBe(3_000_000);
    expect(summary.sharesBalanced).toBe(true);
    expect(summary.totalOverdueAmount).toBe(1_000_000);
  });

  it("warns when shares do not total 100%", () => {
    const summary = venturePosition(
      [partners[0]!, { ...partners[1]!, sharePercent: 30 }],
      [],
      { currency: "GBP", today: "2026-09-02" },
    );
    expect(summary.shareTotalPercent).toBe(90);
    expect(summary.sharesBalanced).toBe(false);
    expect(summary.warnings.join(" ")).toMatch(/total 90%, not 100%/);
  });

  it("excludes transactions in another currency and says so", () => {
    const summary = venturePosition(
      partners,
      [tx({ id: "t1", partnerId: "pa", amount: 100 }), tx({ id: "t2", partnerId: "pa", amount: 999, currency: "EUR" })],
      { currency: "GBP", today: "2026-09-02" },
    );
    expect(summary.totalContributed).toBe(100);
    expect(summary.positions.find((p) => p.partnerId === "pa")!.currencyMismatches).toBe(1);
    expect(summary.reasons.join(" ")).toMatch(/another currency are excluded/);
  });

  it("reports that our share is unknown when no partner is flagged as us", () => {
    const summary = venturePosition(
      partners.map((p) => ({ ...p, isSelf: false })),
      [],
      { currency: "GBP", today: "2026-09-02" },
    );
    expect(summary.ourSharePercent).toBeNull();
    expect(summary.reasons.join(" ")).toMatch(/No partner is flagged as this company/);
  });

  it("leaves the uncalled commitment unknown when none was recorded", () => {
    const summary = venturePosition(
      [{ ...partners[0]!, committedCapital: null }],
      [],
      { currency: "GBP", today: "2026-09-02" },
    );
    expect(summary.positions[0]!.uncalledCommitment).toBeNull();
    expect(summary.positions[0]!.reasons.join(" ")).toMatch(/No committed capital recorded/);
  });
});

describe("decideVote (#1058)", () => {
  it("carries an ordinary matter on a simple majority of the shares present", () => {
    const out = decideVote(partners, [
      { partnerId: "pa", vote: "for" },
      { partnerId: "pb", vote: "against" },
    ], { quorumPercent: 75, thresholdPercent: null, decisionType: "ordinary" });
    expect(out.sharePresentPercent).toBe(100);
    expect(out.shareForPercent).toBe(60);
    expect(out.quorumMet).toBe(true);
    expect(out.thresholdMet).toBe(true);
    expect(out.outcome).toBe("approved");
    expect(out.reasons.join(" ")).toMatch(/simple majority/);
  });

  it("requires unanimity of those present for a reserved matter with no stated threshold", () => {
    const out = decideVote(partners, [
      { partnerId: "pa", vote: "for" },
      { partnerId: "pb", vote: "against" },
    ], { quorumPercent: null, thresholdPercent: null, decisionType: "reserved_matter" });
    expect(out.thresholdPercent).toBe(100);
    expect(out.outcome).toBe("rejected");
    expect(out.reasons.join(" ")).toMatch(/unanimity of the shares present/);
  });

  it("returns not_quorate when the quorum is not met, whatever the vote", () => {
    const out = decideVote(partners, [{ partnerId: "pa", vote: "for" }], {
      quorumPercent: 75,
      thresholdPercent: 50,
      decisionType: "ordinary",
    });
    expect(out.sharePresentPercent).toBe(60);
    expect(out.quorumMet).toBe(false);
    expect(out.outcome).toBe("not_quorate");
    // the outcome carries its own arithmetic, so a minute can be read on its own
    expect(out.reasons.join(" ")).toMatch(/Not quorate: 60% of the shares were present/);
  });

  it("counts an abstention as present but not in favour", () => {
    const out = decideVote(partners, [
      { partnerId: "pa", vote: "abstain" },
      { partnerId: "pb", vote: "for" },
    ], { quorumPercent: 50, thresholdPercent: 50, decisionType: "ordinary" });
    expect(out.shareAbstainPercent).toBe(60);
    expect(out.shareForPercent).toBe(40);
    expect(out.outcome).toBe("rejected");
    expect(out.reasons.join(" ")).toMatch(/Not carried: 40% of the shares voted in favour/);
  });

  it("ignores votes from parties that are not active partners and names them", () => {
    const out = decideVote(partners, [
      { partnerId: "pa", vote: "for" },
      { partnerId: "ghost", vote: "for" },
    ], { quorumPercent: null, thresholdPercent: 50, decisionType: "ordinary" });
    expect(out.unknownVoters).toEqual(["ghost"]);
    expect(out.sharePresentPercent).toBe(60);
    expect(out.reasons.join(" ")).toMatch(/not active partners/);
  });

  it("takes the last vote when a partner appears twice and records the fact", () => {
    const out = decideVote(partners, [
      { partnerId: "pa", vote: "for" },
      { partnerId: "pa", vote: "against" },
      { partnerId: "pb", vote: "for" },
    ], { quorumPercent: null, thresholdPercent: 50, decisionType: "ordinary" });
    expect(out.shareAgainstPercent).toBe(60);
    expect(out.reasons.join(" ")).toMatch(/appears more than once/);
  });

  it("defers when nobody voted", () => {
    const out = decideVote(partners, [], { quorumPercent: null, thresholdPercent: 0, decisionType: "ordinary" });
    expect(out.sharePresentPercent).toBe(0);
    expect(out.outcome).toBe("deferred");
  });
});
