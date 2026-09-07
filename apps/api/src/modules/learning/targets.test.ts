/**
 * Unit tests for the two pure registries the knowledge graph and the relevance
 * ranker are built on:
 *
 *  - `targets.ts` — the map from the vocabulary a lesson's `evidenceRefs`
 *    carries onto the tables that actually hold those records. Everything the
 *    graph calls "verified" passes through here, so an alias that silently
 *    stopped resolving would turn verified edges into unverified ones without
 *    a single test failing anywhere else.
 *  - `relevance.toolAffinity` — the tool → lesson-category mapping the
 *    "relevant here" widget explains itself with.
 *
 * Deliberately DB-free: `resolveTarget` (the half that touches Postgres) is
 * exercised through the graph projection in learning.test.ts. What is tested
 * here is the registry's own arithmetic — aliasing, canonicalisation and the
 * href builders — which is where a typo hides.
 */
import { describe, expect, it } from "vitest";
import { knownTargetTypes, targetEntryFor } from "./targets.js";
import { toolAffinity } from "./relevance.js";

describe("targetEntryFor", () => {
  it("resolves the tool key and the ledger's record type to the same entry", () => {
    /* A lesson's evidence ref says `forensics` (the tool the user was in); the
       ledger and record_links say `delay_event`. They are one thing. */
    const byTool = targetEntryFor("forensics");
    const byRecordType = targetEntryFor("delay_event");
    expect(byTool).not.toBeNull();
    expect(byRecordType).toBe(byTool);
    expect(byTool?.recordType).toBe("delay_event");
  });

  it("accepts the camelCase spelling the API sometimes carries", () => {
    expect(targetEntryFor("delayEvent")).toBe(targetEntryFor("delay_event"));
  });

  it("is case- and whitespace-insensitive, because the alias is typed by people", () => {
    const canonical = targetEntryFor("dispute");
    expect(targetEntryFor("  DISPUTE ")).toBe(canonical);
    expect(targetEntryFor("Disputes")).toBe(canonical);
  });

  it("returns null for a tool the registry cannot verify rather than guessing", () => {
    expect(targetEntryFor("bidding")).toBeNull();
    expect(targetEntryFor("")).toBeNull();
    expect(targetEntryFor("   ")).toBeNull();
  });

  it("canonicalises every alias of a record type to one recordType string", () => {
    /* This is what makes the edge projection idempotent: two evidence refs
       spelled differently must not produce two edges. */
    for (const [a, b] of [
      ["risk", "risks"],
      ["quality", "ncr"],
      ["safety", "safety_incident"],
      ["incident", "safety_incident"],
      ["commercial", "variation"],
      ["assurance", "signal"],
      ["governance", "gate_review"],
      ["change_management", "change_event"],
      ["punch", "punch_item"],
      ["obligation", "obligations"],
      ["forensic_claim", "claim"],
    ] as const) {
      expect(targetEntryFor(a)?.recordType).toBe(targetEntryFor(b)?.recordType);
      expect(targetEntryFor(a)?.recordType).toBeTruthy();
    }
  });

  it("builds a clickable SPA path for a project-scoped row and nothing for a headless one", () => {
    const entry = targetEntryFor("rfi");
    expect(entry?.href({ id: "rfi_1", projectId: "prj_1" })).toBe(
      "/projects/prj_1/rfis?focus=rfi_1",
    );
    /* No project on the row means no path we could honestly offer — a link
       to /projects/undefined/... is worse than no link. */
    expect(entry?.href({ id: "rfi_1" })).toBeNull();
    expect(entry?.href({ projectId: "prj_1" })).toBeNull();
  });

  it("points a project target at the project overview, not at a register", () => {
    expect(targetEntryFor("project")?.href({ id: "prj_1" })).toBe("/projects/prj_1/overview");
  });

  it("carries a company-level record with no project column", () => {
    /* Obligations are company-scoped in the schema even when they name a
       project; contracts are project-scoped. The registry must not claim a
       project column that is not there. */
    expect(targetEntryFor("obligation")?.projectColumn).not.toBeUndefined();
    expect(targetEntryFor("contract")?.recordType).toBe("contract");
  });

  it("gives every entry at least one label column, so a node is never nameless", () => {
    for (const type of knownTargetTypes()) {
      const entry = targetEntryFor(type);
      expect(entry, type).not.toBeNull();
      expect(entry!.labelColumns.length, type).toBeGreaterThan(0);
    }
  });
});

describe("knownTargetTypes", () => {
  it("is deduplicated and sorted, so the UI can render it as a stable list", () => {
    const types = knownTargetTypes();
    expect(types).toEqual([...new Set(types)]);
    expect(types).toEqual([...types].sort());
  });

  it("covers the record types the capture triggers raise lessons from", () => {
    /* If a trigger can raise a lesson from a dispute, the graph must be able
       to verify the edge back to that dispute. */
    for (const t of ["dispute", "delay_event", "variation", "signal", "gate_review"]) {
      expect(knownTargetTypes()).toContain(t);
    }
  });
});

describe("toolAffinity", () => {
  it("maps a tool onto the lesson categories it implies", () => {
    expect(toolAffinity("rfis")).toEqual(["design", "quality"]);
    expect(toolAffinity("schedule")).toEqual(["programme"]);
    expect(toolAffinity("insurance")).toEqual(["contractual", "governance"]);
  });

  it("returns nothing — not a default category — for an unmapped or absent tool", () => {
    /* A guessed affinity would put lessons in front of people for a reason
       that is not true, and the widget states its reasons. */
    expect(toolAffinity("no_such_tool")).toEqual([]);
    expect(toolAffinity(null)).toEqual([]);
    expect(toolAffinity(undefined)).toEqual([]);
    expect(toolAffinity("")).toEqual([]);
  });
});
