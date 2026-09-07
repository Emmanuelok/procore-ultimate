/**
 * Unit tests for the gate evidence pack engine (spec Vol II Domain G
 * #410-411) and the decision → gate status mapping.
 *
 * What matters here is that the pack is CHECKABLE: the root commits to the
 * exact set of artefacts the reviewer saw, every item carries an inclusion
 * proof that verifies against that root, and swapping an artefact for a
 * different one changes the root. Everything else about a gate decision is
 * narrative; this is the part a third party can test.
 *
 * The route-level behaviour (refusing a decision when an evidence-required
 * criterion carries nothing, freezing the pack onto the review) lives in
 * upgrade.test.ts; this file only exercises the pure functions.
 */
import { describe, expect, it } from "vitest";
import { hashPayload, verifyMerkleProof, type MerkleProofStep } from "@constructos/ledger";
import {
  buildGateEvidencePack,
  gateStatusForDecision,
  missingEvidenceLinks,
  type PackItemInput,
} from "./pack.js";

const item = (over: Partial<PackItemInput> = {}): PackItemInput => ({
  criterionId: "c1",
  criterionText: "Benefits case independently reviewed",
  kind: "evidence",
  id: "evd_1",
  sha256: "a".repeat(64),
  title: "Assurance review report",
  ...over,
});

const leafOf = (i: PackItemInput): string =>
  hashPayload({ kind: i.kind, id: i.id, sha256: i.sha256 });

describe("buildGateEvidencePack", () => {
  it("commits every item to a root each item can prove membership of", () => {
    const items = [
      item(),
      item({ criterionId: "c2", id: "evd_2", sha256: "b".repeat(64), title: "Cost model" }),
      item({ criterionId: "c3", kind: "file", id: "fil_3", sha256: "c".repeat(64), title: "Plan" }),
    ];
    const pack = buildGateEvidencePack(items, [], "2026-04-01T09:00:00.000Z");

    expect(pack.root).toMatch(/^[0-9a-f]{64}$/);
    expect(pack.itemCount).toBe(3);
    for (const packed of pack.items) {
      const ok = verifyMerkleProof(
        leafOf(packed),
        packed.proof as MerkleProofStep[],
        pack.root,
      );
      expect(ok).toBe(true);
    }
  });

  it("changes the root when an artefact is swapped for a different one", () => {
    const before = buildGateEvidencePack([item()], [], "2026-04-01T09:00:00.000Z");
    const after = buildGateEvidencePack(
      [item({ sha256: "d".repeat(64) })],
      [],
      "2026-04-01T09:00:00.000Z",
    );
    expect(after.root).not.toBe(before.root);
  });

  it("distinguishes a file from an evidence record with the same content hash", () => {
    const asEvidence = buildGateEvidencePack(
      [item({ kind: "evidence", id: "x1" })],
      [],
      "2026-04-01T09:00:00.000Z",
    );
    const asFile = buildGateEvidencePack(
      [item({ kind: "file", id: "x1" })],
      [],
      "2026-04-01T09:00:00.000Z",
    );
    expect(asFile.root).not.toBe(asEvidence.root);
  });

  it("names the criteria that required evidence and got none rather than hiding them", () => {
    const pack = buildGateEvidencePack(
      [item()],
      [{ criterionId: "c9", text: "Deliverability assessed" }],
      "2026-04-01T09:00:00.000Z",
    );
    expect(pack.unevidencedCriteria).toEqual([
      { criterionId: "c9", text: "Deliverability assessed" },
    ]);
    expect(pack.statement).toContain("1 criterion(s)");
    expect(pack.statement).toContain(pack.root);
  });

  it("still produces a stable, provable root for an empty pack", () => {
    const pack = buildGateEvidencePack([], [], "2026-04-01T09:00:00.000Z");
    expect(pack.root).toMatch(/^[0-9a-f]{64}$/);
    expect(pack.itemCount).toBe(0);
    expect(pack.items).toEqual([]);
    // an empty pack is a real commitment: two of them agree
    expect(buildGateEvidencePack([], [], "2026-05-01T09:00:00.000Z").root).toBe(pack.root);
  });
});

describe("missingEvidenceLinks", () => {
  const criteria = [
    { id: "c1", text: "Benefits reviewed", evidenceRequired: true },
    { id: "c2", text: "Risk register current", evidenceRequired: true },
    { id: "c3", text: "Sponsor briefed", evidenceRequired: false },
  ];

  it("reports a required criterion with no link at all", () => {
    expect(missingEvidenceLinks(criteria, [{ criterionId: "c1", evidenceIds: ["e1"] }])).toEqual([
      { criterionId: "c2", text: "Risk register current" },
    ]);
  });

  it("treats an empty link as no link — an empty array is not evidence", () => {
    const missing = missingEvidenceLinks(criteria, [
      { criterionId: "c1", evidenceIds: [], fileIds: [] },
      { criterionId: "c2", fileIds: ["f1"] },
    ]);
    expect(missing).toEqual([{ criterionId: "c1", text: "Benefits reviewed" }]);
  });

  it("never demands evidence for a criterion that does not require it", () => {
    const missing = missingEvidenceLinks(criteria, [
      { criterionId: "c1", evidenceIds: ["e1"] },
      { criterionId: "c2", evidenceIds: ["e2"] },
    ]);
    expect(missing).toEqual([]);
  });
});

describe("gateStatusForDecision", () => {
  it("a hold leaves the gate in review — it is not a decision", () => {
    expect(gateStatusForDecision("hold")).toBe("in_review");
  });

  it("proceed, proceed with conditions and stop all decide the gate", () => {
    expect(gateStatusForDecision("proceed")).toBe("decided");
    expect(gateStatusForDecision("proceed_with_conditions")).toBe("decided");
    expect(gateStatusForDecision("stop")).toBe("decided");
  });

  it("an unknown decision leaves the gate pending rather than guessing", () => {
    expect(gateStatusForDecision("nonsense")).toBe("pending");
  });
});
