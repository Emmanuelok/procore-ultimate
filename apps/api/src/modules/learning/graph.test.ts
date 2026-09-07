import { describe, expect, it } from "vitest";
import {
  desiredEdges,
  diffEdges,
  edgeKey,
  normaliseTag,
  parseEvidenceRefs,
  selectOnboardingPack,
  valueBand,
  type GraphLesson,
  type PackCandidate,
  type PackProject,
} from "./graph.js";
import {
  buildTfIdfIndex,
  documentTerms,
  semanticMatches,
  similarLessons,
  tokenizeAll,
  type SearchableLesson,
} from "./relevance.js";

/* ------------------------------------------------------------------ */
/* Evidence refs                                                       */
/* ------------------------------------------------------------------ */

describe("parseEvidenceRefs", () => {
  it("drops anything that cannot be a reference rather than inventing one", () => {
    const out = parseEvidenceRefs([
      { tool: "disputes", recordId: "d1", label: "D-004" },
      { tool: "disputes" },
      { recordId: "x" },
      null,
      "disputes/d1",
      42,
      { tool: "  ", recordId: "d2" },
    ]);
    expect(out).toEqual([{ tool: "disputes", recordId: "d1", label: "D-004" }]);
  });

  it("keeps the first of a duplicated (tool, record) pair", () => {
    const out = parseEvidenceRefs([
      { tool: "risk", recordId: "r1", label: "first" },
      { tool: "risk", recordId: "r1", label: "second" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.label).toBe("first");
  });
});

describe("normaliseTag", () => {
  it("collapses the three spellings of one tag into one node", () => {
    expect(normaliseTag("Ground Conditions")).toBe("ground-conditions");
    expect(normaliseTag("  ground_conditions ")).toBe("ground-conditions");
    expect(normaliseTag("ground--conditions!")).toBe("ground-conditions");
  });

  it("returns an empty string for a tag that is only punctuation", () => {
    expect(normaliseTag("!!!")).toBe("");
  });
});

/* ------------------------------------------------------------------ */
/* Desired edges                                                       */
/* ------------------------------------------------------------------ */

function lesson(over: Partial<GraphLesson> = {}): GraphLesson {
  return {
    id: "les1",
    number: "LL-0001",
    title: "Piling in made ground",
    tags: ["Ground Conditions", "piling"],
    originProjectId: "p1",
    createdBy: "u-author",
    submittedBy: "u-author",
    validatedBy: "u-validator",
    supersededById: null,
    evidenceRefs: [
      { tool: "disputes", recordId: "d1", label: "D-004" },
      { tool: "forensics", recordId: "de1", label: "DE-2" },
    ],
    ...over,
  };
}

describe("desiredEdges", () => {
  it("labels the first evidence ref the origin and the rest evidence", () => {
    const edges = desiredEdges(lesson());
    const origin = edges.find((e) => e.role === "origin")!;
    const evidence = edges.find((e) => e.role === "evidence")!;
    expect(origin.targetId).toBe("d1");
    expect(evidence.targetId).toBe("de1");
    expect(origin.targetProjectId).toBe("p1");
  });

  it("records the people who can be asked about the lesson", () => {
    const edges = desiredEdges(lesson());
    const people = edges.filter((e) => e.edgeKind === "person");
    expect(people.map((p) => p.role).sort()).toEqual(["author", "validator"]);
    expect(people.every((p) => p.targetType === "user")).toBe(true);
  });

  it("normalises tags into one node per vocabulary term and keeps the typed label", () => {
    const edges = desiredEdges(lesson({ tags: ["Ground Conditions", "ground_conditions"] }));
    const tags = edges.filter((e) => e.edgeKind === "tag");
    expect(tags).toHaveLength(1);
    expect(tags[0]!.targetId).toBe("ground-conditions");
    expect(tags[0]!.targetLabel).toBe("Ground Conditions");
  });

  it("edges an applied lesson to the record it was applied to and to who applied it", () => {
    const edges = desiredEdges(lesson(), [
      {
        id: "app1",
        projectId: "p2",
        tool: "rfis",
        recordId: "rfi9",
        label: "RFI-9",
        appliedBy: "u-applier",
      },
    ]);
    const applied = edges.find((e) => e.role === "applied_to")!;
    expect(applied.targetType).toBe("rfis");
    expect(applied.targetProjectId).toBe("p2");
    expect(edges.some((e) => e.role === "applier" && e.targetId === "u-applier")).toBe(true);
  });

  it("keeps a superseded lesson pointing somewhere instead of dead-ending", () => {
    const edges = desiredEdges(lesson({ supersededById: "les2" }));
    expect(edges.some((e) => e.role === "superseded_by" && e.targetId === "les2")).toBe(true);
  });

  it("carries the similarity in the see-also label and never edges a lesson to itself", () => {
    const edges = desiredEdges(lesson(), [], [
      { lessonId: "les1", similarity: 0.99 },
      { lessonId: "les3", similarity: 0.42 },
    ]);
    const seeAlso = edges.filter((e) => e.role === "see_also");
    expect(seeAlso).toHaveLength(1);
    expect(seeAlso[0]!.targetId).toBe("les3");
    expect(seeAlso[0]!.targetLabel).toBe("semantic similarity: 0.42");
  });

  it("canonicalises the record type BEFORE the dedupe, so the projection is re-runnable", () => {
    /*
     * The store keeps the canonical type ("dispute"); users type the tool
     * ("disputes"). Canonicalising only at write time made the next diff see
     * a stored "dispute" and a desired "disputes" as different rows, and the
     * insert collided with the unique index — a 500 on the second run.
     */
    const canon = (t: string) => (t === "disputes" ? "dispute" : t);
    const edges = desiredEdges(
      lesson({
        evidenceRefs: [
          { tool: "disputes", recordId: "d1" },
          { tool: "dispute", recordId: "d1" },
        ],
      }),
      [],
      [],
      { normaliseType: canon },
    );
    const records = edges.filter((e) => e.edgeKind === "record");
    expect(records.every((e) => e.targetType === "dispute")).toBe(true);
    // both refs collapse onto one identity once the alias is resolved
    expect(new Set(records.map(edgeKey)).size).toBe(records.length);
    expect(records).toHaveLength(2); // origin + evidence, same target, two roles
  });

  it("is deterministic and deduplicated on the unique-index identity", () => {
    const a = desiredEdges(lesson());
    const b = desiredEdges(lesson());
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(new Set(a.map(edgeKey)).size).toBe(a.length);
  });
});

/* ------------------------------------------------------------------ */
/* Diff                                                                */
/* ------------------------------------------------------------------ */

describe("diffEdges", () => {
  it("writes nothing the second time — the projection is idempotent", () => {
    const desired = desiredEdges(lesson());
    const stored = desired.map((d, i) => ({ id: `e${i}`, ...d }));
    const diff = diffEdges(desired, stored);
    expect(diff.toInsert).toEqual([]);
    expect(diff.toDeleteIds).toEqual([]);
    expect(diff.unchanged).toBe(desired.length);
  });

  it("removes an edge whose evidence ref was deleted from the lesson", () => {
    const before = desiredEdges(lesson());
    const stored = before.map((d, i) => ({ id: `e${i}`, ...d }));
    const after = desiredEdges(lesson({ evidenceRefs: [{ tool: "disputes", recordId: "d1" }] }));
    const diff = diffEdges(after, stored);
    expect(diff.toDeleteIds.length).toBe(1);
    const removed = stored.find((s) => s.id === diff.toDeleteIds[0])!;
    expect(removed.targetId).toBe("de1");
  });

  it("inserts only what is new", () => {
    const stored = desiredEdges(lesson()).map((d, i) => ({ id: `e${i}`, ...d }));
    const after = desiredEdges(lesson({ tags: ["Ground Conditions", "piling", "sheet-piles"] }));
    const diff = diffEdges(after, stored);
    expect(diff.toInsert).toHaveLength(1);
    expect(diff.toInsert[0]!.targetId).toBe("sheet-piles");
  });
});

/* ------------------------------------------------------------------ */
/* tf-idf retrieval                                                    */
/* ------------------------------------------------------------------ */

function searchable(over: Partial<SearchableLesson> & { id: string }): SearchableLesson {
  return {
    number: "LL-0001",
    title: "",
    category: "construction",
    phase: null,
    tags: [],
    impactValue: null,
    impactCurrency: null,
    impactDays: null,
    publishedAt: "2026-01-01T00:00:00.000Z",
    originProjectId: "p1",
    applicationCount: 0,
    context: null,
    whatHappened: "",
    rootCause: null,
    recommendation: "",
    ...over,
  };
}

const REGISTER: SearchableLesson[] = [
  searchable({
    id: "l-piling",
    title: "Piling rig sank in made ground",
    whatHappened: "The piling rig sank because the made ground was never probed before mobilisation",
    recommendation: "Probe made ground before mobilising a piling rig",
    tags: ["piling", "ground"],
  }),
  searchable({
    id: "l-cladding",
    title: "Cladding fixings corroded",
    whatHappened: "Cladding fixings specified in the wrong grade corroded within a year",
    recommendation: "Check fixing grade against the exposure category",
    tags: ["cladding", "facade"],
  }),
  searchable({
    id: "l-payment",
    title: "Payment notice served late",
    whatHappened: "The pay less notice was served one day late and the full application became due",
    recommendation: "Diarise the payment notice dates from the contract",
    tags: ["payment"],
  }),
];

describe("tf-idf retrieval", () => {
  it("counts term frequency, unlike the presence-only keyword tokenizer", () => {
    expect(tokenizeAll("piling piling rig")).toEqual(["piling", "piling", "rig"]);
    const terms = documentTerms(REGISTER[0]!);
    expect(terms.get("piling")).toBeGreaterThan(terms.get("probed") ?? 0);
  });

  it("ranks the lesson about the thing you are describing first", () => {
    const index = buildTfIdfIndex(REGISTER);
    const hits = semanticMatches(index, "rig sinking in made ground during piling");
    expect(hits[0]!.lessonId).toBe("l-piling");
    expect(hits[0]!.similarity).toBeGreaterThan(0.1);
    expect(hits[0]!.terms).toContain("piling");
  });

  it("returns nothing when the query shares no vocabulary with the register", () => {
    const index = buildTfIdfIndex(REGISTER);
    expect(semanticMatches(index, "quantum chromodynamics")).toEqual([]);
  });

  it("similarity is bounded by one and identical text scores near it", () => {
    const index = buildTfIdfIndex(REGISTER);
    const hits = semanticMatches(index, REGISTER[2]!.whatHappened);
    expect(hits[0]!.lessonId).toBe("l-payment");
    expect(hits[0]!.similarity).toBeLessThanOrEqual(1);
    expect(hits[0]!.similarity).toBeGreaterThan(0.3);
  });

  it("is deterministic and totally ordered", () => {
    const index = buildTfIdfIndex(REGISTER);
    const a = semanticMatches(index, "ground piling cladding payment");
    const b = semanticMatches(buildTfIdfIndex([...REGISTER].reverse()), "ground piling cladding payment");
    expect(b.map((h) => h.lessonId)).toEqual(a.map((h) => h.lessonId));
  });

  it("finds see-also lessons without ever matching a lesson to itself", () => {
    const near = searchable({
      id: "l-piling-2",
      title: "Piling rig bogged in made ground again",
      whatHappened: "Made ground under the piling platform was not probed",
      recommendation: "Probe made ground",
      tags: ["piling"],
    });
    const index = buildTfIdfIndex([...REGISTER, near]);
    const hits = similarLessons(index, "l-piling", { limit: 2 });
    expect(hits.map((h) => h.lessonId)).not.toContain("l-piling");
    expect(hits[0]!.lessonId).toBe("l-piling-2");
  });

  it("an empty register produces no matches rather than dividing by zero", () => {
    const index = buildTfIdfIndex([]);
    expect(index.documents).toBe(0);
    expect(semanticMatches(index, "anything")).toEqual([]);
    expect(similarLessons(index, "nope")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Onboarding packs                                                    */
/* ------------------------------------------------------------------ */

describe("valueBand", () => {
  it("bands by order of magnitude and never compares across currencies", () => {
    expect(valueBand(2_000_000, "GBP")).toBe("GBP:1e6");
    expect(valueBand(3_500_000, "GBP")).toBe("GBP:1e6");
    expect(valueBand(3_500_000, "EUR")).not.toBe(valueBand(3_500_000, "GBP"));
    expect(valueBand(200_000_000, "GBP")).not.toBe(valueBand(2_000_000, "GBP"));
  });

  it("has no band for a value nobody recorded", () => {
    expect(valueBand(null, "GBP")).toBeNull();
    expect(valueBand(0, "GBP")).toBeNull();
  });
});

describe("selectOnboardingPack", () => {
  const target: PackProject = {
    id: "p-new",
    name: "New hospital",
    projectType: "healthcare",
    stage: "construction",
    contractValue: 4_000_000,
    currency: "GBP",
  };
  const origins = new Map<string, PackProject>([
    [
      "p-old",
      {
        id: "p-old",
        name: "Old hospital",
        projectType: "healthcare",
        stage: "closeout",
        contractValue: 6_000_000,
        currency: "GBP",
      },
    ],
    [
      "p-road",
      {
        id: "p-road",
        name: "Bypass",
        projectType: "highways",
        stage: "closeout",
        contractValue: 900_000_000,
        currency: "GBP",
      },
    ],
  ]);

  function candidate(over: Partial<PackCandidate> & { lessonId: string }): PackCandidate {
    return {
      originProjectId: "p-old",
      category: "construction",
      phase: "construction",
      impactValue: null,
      impactCurrency: null,
      applicationCount: 0,
      similarity: null,
      ...over,
    };
  }

  it("prefers lessons from the same kind of project at the same order of value", () => {
    const picks = selectOnboardingPack(target, origins, [
      candidate({ lessonId: "same-type" }),
      candidate({ lessonId: "other-type", originProjectId: "p-road", phase: null }),
    ]);
    expect(picks[0]!.lessonId).toBe("same-type");
    expect(picks[0]!.reasons.join(" ")).toContain("healthcare");
    expect(picks[0]!.reasons.join(" ")).toContain("same order of value");
  });

  it("drops a candidate that has no reason to be in the pack", () => {
    const picks = selectOnboardingPack(
      { ...target, projectType: null, stage: null },
      new Map(),
      [candidate({ lessonId: "nothing", originProjectId: null, phase: null })],
    );
    expect(picks).toEqual([]);
  });

  it("states the semantic similarity as a number in the reason", () => {
    const picks = selectOnboardingPack(target, origins, [
      candidate({ lessonId: "semantic", similarity: 0.82 }),
    ]);
    expect(picks[0]!.reasons.join(" ")).toContain("Semantic similarity: 0.82");
  });

  it("honours the limit and orders deterministically", () => {
    const picks = selectOnboardingPack(
      target,
      origins,
      [1, 2, 3, 4, 5].map((i) => candidate({ lessonId: `l${i}` })),
      { limit: 2 },
    );
    expect(picks).toHaveLength(2);
    expect(picks.map((p) => p.lessonId)).toEqual(["l1", "l2"]);
  });
});
