import { sha256Hex } from "./hash.js";

/**
 * Merkle root over a list of leaf hashes. Used to notarise evidence packs:
 * the root commits to every document in the pack, and a single hash can be
 * escrowed with a third party or anchored externally.
 *
 * Odd nodes are promoted (Bitcoin-style duplication is deliberately avoided
 * so a leaf cannot appear to be included twice).
 */
export function merkleRoot(leafHashes: string[]): string {
  if (leafHashes.length === 0) return sha256Hex("");
  let level = [...leafHashes];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        next.push(sha256Hex(level[i]! + level[i + 1]!));
      } else {
        next.push(level[i]!);
      }
    }
    level = next;
  }
  return level[0]!;
}

export interface MerkleProofStep {
  hash: string;
  position: "left" | "right";
}

/** Produce an inclusion proof for the leaf at `index`. */
export function merkleProof(leafHashes: string[], index: number): MerkleProofStep[] {
  if (index < 0 || index >= leafHashes.length) {
    throw new RangeError("leaf index out of range");
  }
  const proof: MerkleProofStep[] = [];
  let level = [...leafHashes];
  let i = index;
  while (level.length > 1) {
    const next: string[] = [];
    for (let j = 0; j < level.length; j += 2) {
      if (j + 1 < level.length) {
        next.push(sha256Hex(level[j]! + level[j + 1]!));
      } else {
        next.push(level[j]!);
      }
    }
    const isLeft = i % 2 === 0;
    const siblingIndex = isLeft ? i + 1 : i - 1;
    if (siblingIndex < level.length) {
      proof.push({
        hash: level[siblingIndex]!,
        position: isLeft ? "right" : "left",
      });
    }
    i = Math.floor(i / 2);
    level = next;
  }
  return proof;
}

export function verifyMerkleProof(
  leafHash: string,
  proof: MerkleProofStep[],
  root: string,
): boolean {
  let hash = leafHash;
  for (const step of proof) {
    hash = step.position === "right" ? sha256Hex(hash + step.hash) : sha256Hex(step.hash + hash);
  }
  return hash === root;
}
