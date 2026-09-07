/**
 * Gate evidence packs (spec Vol II Domain G #410-411).
 *
 * WHY A PACK
 * A gate review used to record findings as free text: "criterion met, yes".
 * Six months later nobody can say WHAT the reviewer saw, and the decision is
 * unreproducible — which is the one thing an assurance decision has to be.
 * At review time the criteria marked `evidenceRequired` must each be linked
 * to real evidence or files, and those content hashes are frozen into a
 * Merkle-rooted pack stored on the review. The root is what makes the
 * decision checkable: recompute it later and either the pack is the same
 * pack or it is not.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It does not copy the bytes. The pack commits to content hashes, so a file
 * deleted from storage afterwards shows up as an unresolvable item rather
 * than a silently different one. And it does not judge sufficiency — whether
 * three photographs discharge a criterion is the reviewer's call, recorded
 * as a finding.
 */
import { hashPayload, merkleProof, merkleRoot } from "@constructos/ledger";

export interface PackItemInput {
  criterionId: string;
  criterionText: string;
  kind: "evidence" | "file";
  id: string;
  /** content hash of the underlying artefact */
  sha256: string;
  title: string;
}

export interface PackItem extends PackItemInput {
  /** Merkle inclusion proof for this leaf against the pack root */
  proof: unknown;
}

export interface GateEvidencePack {
  root: string;
  builtAt: string;
  itemCount: number;
  items: PackItem[];
  /** criteria that required evidence and got none — named, not hidden */
  unevidencedCriteria: { criterionId: string; text: string }[];
  statement: string;
}

/**
 * Freeze the pack. Leaves are hashed over `{kind, id, sha256}` rather than
 * the raw sha256 so a file and an evidence record that happen to share a
 * content hash are distinct leaves.
 */
export function buildGateEvidencePack(
  items: PackItemInput[],
  unevidencedCriteria: { criterionId: string; text: string }[],
  builtAt: string,
): GateEvidencePack {
  const leaves = items.map((i) => hashPayload({ kind: i.kind, id: i.id, sha256: i.sha256 }));
  const root = merkleRoot(leaves);
  return {
    root,
    builtAt,
    itemCount: items.length,
    items: items.map((i, idx) => ({ ...i, proof: merkleProof(leaves, idx) })),
    unevidencedCriteria,
    statement:
      `This pack commits ${items.length} evidence item(s) to Merkle root ${root} as at ${builtAt}. ` +
      `Each item carries an inclusion proof, so any single item can be shown to have been in the ` +
      `pack the decision was made on. ` +
      (unevidencedCriteria.length > 0
        ? `${unevidencedCriteria.length} criterion(s) that require evidence carry none and are listed on the pack.`
        : `Every criterion requiring evidence carries at least one item.`) +
      ` The pack commits to content hashes, not to the bytes: an artefact deleted from storage ` +
      `afterwards will fail to resolve rather than resolve to something different.`,
  };
}

export interface EvidenceLink {
  criterionId: string;
  evidenceIds?: string[];
  fileIds?: string[];
}

/**
 * Which `evidenceRequired` criteria have no link at all. Returned as data so
 * the route can refuse the review with a list the reviewer can act on rather
 * than a single unhelpful message.
 */
export function missingEvidenceLinks(
  criteria: { id: string; text: string; evidenceRequired: boolean }[],
  links: EvidenceLink[],
): { criterionId: string; text: string }[] {
  const linked = new Map<string, EvidenceLink>();
  for (const l of links) linked.set(l.criterionId, l);
  return criteria
    .filter((c) => c.evidenceRequired)
    .filter((c) => {
      const l = linked.get(c.id);
      return !l || ((l.evidenceIds?.length ?? 0) === 0 && (l.fileIds?.length ?? 0) === 0);
    })
    .map((c) => ({ criterionId: c.id, text: c.text }));
}

/**
 * A gate review's decision → the gate's status. The old code set `decided`
 * for every decision value, so a HELD gate displayed a green "Decided"
 * badge next to an amber "Hold" chip — two contradictory statements on one
 * screen. A hold is not a decision; it is a review still in progress.
 */
export function gateStatusForDecision(decision: string): "pending" | "in_review" | "decided" {
  switch (decision) {
    case "hold":
      return "in_review";
    case "proceed":
    case "proceed_with_conditions":
    case "stop":
      return "decided";
    default:
      return "pending";
  }
}
