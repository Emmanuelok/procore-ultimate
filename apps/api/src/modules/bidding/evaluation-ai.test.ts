import { describe, expect, it } from "vitest";
import {
  buildEvaluationPrompt,
  evaluationOutputSchema,
  reconcileProposals,
  type PromptBid,
  type PromptScopeRow,
} from "./evaluation-ai.js";

const rows: PromptScopeRow[] = [
  {
    id: "bli_1",
    itemCode: "A10",
    description: "Groundworks",
    category: "base_scope",
    isMandatory: true,
    unit: "m3",
    estimatedQuantity: 400,
  },
  {
    id: "bli_2",
    itemCode: "X10",
    description: "Temporary works design",
    category: "exclusion_check",
    isMandatory: true,
    unit: null,
    estimatedQuantity: null,
  },
];

const bids: PromptBid[] = [
  {
    submissionId: "bsub_1",
    reference: "BID-0001",
    vendorName: "Alpha Groundworks Ltd",
    currency: "GBP",
    exclusions: "Temporary works design is excluded and assumed to be by others.",
    qualifications: null,
    assumptions: "Ground conditions as per the SI report.",
    lines: [
      {
        id: "bsl_1",
        itemCode: "A10",
        description: "Bulk excavation and disposal",
        amount: 100_000,
        unitRate: 250,
        quantity: 400,
        levellingItemId: null,
      },
    ],
    answeredItemIds: [],
  },
  {
    submissionId: "bsub_2",
    reference: "BID-0002",
    vendorName: "Bravo Civils Ltd",
    currency: "GBP",
    exclusions: null,
    qualifications: null,
    assumptions: null,
    lines: [],
    answeredItemIds: ["bli_1"],
  },
];

describe("buildEvaluationPrompt", () => {
  const prompt = buildEvaluationPrompt({
    packageReference: "BP-0001",
    packageTitle: "Groundworks",
    currency: "GBP",
    scopeDescription: "All groundworks to the substructure.",
    rows,
    bids,
  });

  it("puts every scope row id and every bidder in front of the model", () => {
    expect(prompt.user).toContain("bli_1");
    expect(prompt.user).toContain("bli_2");
    expect(prompt.user).toContain("bsub_1");
    expect(prompt.user).toContain("BID-0002");
  });

  it("includes the bidder's own words, which are the whole point", () => {
    expect(prompt.user).toContain("Temporary works design is excluded");
    expect(prompt.user).toContain("Ground conditions as per the SI report");
  });

  it("states 'none stated' rather than leaving a field silently empty", () => {
    expect(prompt.user).toMatch(/Qualifications: \(none stated\)/);
  });

  it("counts only the cells that are still open", () => {
    // Alpha: both rows open. Bravo: bli_1 answered, so one row open.
    expect(prompt.openCells).toBe(3);
  });

  it("names the vocabularies the API will accept", () => {
    expect(prompt.system).toContain("partially_included");
    expect(prompt.system).toContain("exclusion_priced_elsewhere");
    expect(prompt.system).toMatch(/MUST carry sourceQuote/);
  });

  it("truncates a runaway text rather than blowing the context", () => {
    const long = "x".repeat(10_000);
    const big = buildEvaluationPrompt({
      packageReference: "BP-0002",
      packageTitle: "Big",
      currency: "GBP",
      scopeDescription: null,
      rows,
      bids: [{ ...bids[0]!, exclusions: long }],
    });
    expect(big.user).toContain("[truncated at 4000 characters]");
    expect(big.user.length).toBeLessThan(long.length);
  });
});

describe("evaluationOutputSchema", () => {
  it("fills the optional fields so a partial model answer is still usable", () => {
    const parsed = evaluationOutputSchema.parse({
      proposals: [
        { levellingItemId: "bli_1", submissionId: "bsub_1", includedStatus: "included" },
      ],
    });
    expect(parsed.proposals[0]?.confidence).toBe(0.5);
    expect(parsed.proposals[0]?.adjustmentAmount).toBeNull();
    expect(parsed.complianceNotes).toEqual([]);
  });
});

describe("reconcileProposals", () => {
  const base = {
    levellingItemId: "bli_2",
    submissionId: "bsub_1",
    includedStatus: "excluded",
    adjustmentAmount: 8_000,
    adjustmentReason: "scope_gap",
    sourceQuote: "Temporary works design is excluded",
    rationale: "The bidder excludes it, so the comparable price must carry it.",
    clarificationQuestion: null,
    confidence: 0.9,
  };

  const run = (over: Record<string, unknown> = {}, notes: unknown[] = []) =>
    reconcileProposals(
      evaluationOutputSchema.parse({ proposals: [{ ...base, ...over }], complianceNotes: notes }),
      rows,
      bids,
    );

  it("accepts a well-formed, quoted proposal and builds the body that applies it", () => {
    const res = run();
    expect(res.dropped).toEqual([]);
    expect(res.proposals).toHaveLength(1);
    const p = res.proposals[0]!;
    expect(p.itemCode).toBe("X10");
    expect(p.vendorName).toBe("Alpha Groundworks Ltd");
    expect(p.apply["levellingItemId"]).toBe("bli_2");
    expect(p.apply["adjustmentReason"]).toBe("scope_gap");
    expect(String(p.apply["adjustmentNote"])).toContain("Temporary works design is excluded");
  });

  it("drops a proposal against a scope row that was never supplied", () => {
    const res = run({ levellingItemId: "bli_invented" });
    expect(res.proposals).toEqual([]);
    expect(res.dropped[0]?.reason).toBe("unknown_scope_row");
  });

  it("drops a proposal against a bid that was never supplied", () => {
    const res = run({ submissionId: "bsub_invented" });
    expect(res.proposals).toEqual([]);
    expect(res.dropped[0]?.reason).toBe("unknown_submission");
  });

  it("never overwrites a cell a human has already answered", () => {
    const res = run({ submissionId: "bsub_2", levellingItemId: "bli_1" });
    expect(res.proposals).toEqual([]);
    expect(res.dropped[0]?.reason).toBe("cell_already_answered");
  });

  it("drops a proposal that quotes nothing", () => {
    const res = run({ sourceQuote: "" });
    expect(res.proposals).toEqual([]);
    expect(res.dropped[0]?.reason).toBe("no_source_quote");
  });

  it("drops an inclusion status the platform does not recognise", () => {
    const res = run({ includedStatus: "probably_included" });
    expect(res.proposals).toEqual([]);
    expect(res.dropped[0]?.reason).toBe("unknown_inclusion_status");
  });

  it("drops an adjustment reason the platform does not recognise", () => {
    const res = run({ adjustmentReason: "vibes" });
    expect(res.proposals).toEqual([]);
    expect(res.dropped[0]?.reason).toBe("unknown_adjustment_reason");
  });

  it("drops an adjustment with no reason — the levelling route would refuse it anyway", () => {
    const res = run({ adjustmentReason: null, adjustmentAmount: 8_000 });
    expect(res.proposals).toEqual([]);
    expect(res.dropped[0]?.reason).toBe("adjustment_without_reason");
  });

  it("keeps a zero-adjustment proposal with no reason", () => {
    const res = run({ adjustmentReason: null, adjustmentAmount: 0 });
    expect(res.proposals).toHaveLength(1);
    expect(res.proposals[0]?.apply["adjustmentAmount"]).toBeUndefined();
  });

  it("discards a duplicate proposal for the same cell", () => {
    const res = reconcileProposals(
      evaluationOutputSchema.parse({ proposals: [base, { ...base, confidence: 0.1 }] }),
      rows,
      bids,
    );
    expect(res.proposals).toHaveLength(1);
    expect(res.dropped[0]?.reason).toBe("duplicate_proposal");
  });

  it("keeps a compliance note about a real bid and drops one about a phantom", () => {
    const res = run({}, [
      { submissionId: "bsub_1", note: "Excludes temporary works design.", sourceQuote: "excluded" },
      { submissionId: "bsub_nope", note: "Anything.", sourceQuote: "x" },
    ]);
    expect(res.complianceNotes).toHaveLength(1);
    expect(res.complianceNotes[0]?.reference).toBe("BID-0001");
    expect(res.dropped.some((d) => d.reason === "unknown_submission")).toBe(true);
  });
});
