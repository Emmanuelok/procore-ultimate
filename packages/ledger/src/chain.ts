import { sha256Hex } from "./hash.js";

/** Sentinel previous-hash for the first entry of a company's chain. */
export const GENESIS_HASH = "0".repeat(64);

export interface ChainInput {
  companyId: string;
  actorId: string | null;
  action: string;
  objectType: string;
  objectId: string;
  payloadHash: string;
  at: string; // ISO timestamp
}

export interface ChainedEntry extends ChainInput {
  prevHash: string;
  entryHash: string;
}

/**
 * Compute the hash of a ledger entry. The entry hash covers every field plus
 * the previous entry's hash, which is what makes retroactive edits detectable:
 * changing any historical entry breaks every hash after it.
 */
export function computeEntryHash(input: ChainInput, prevHash: string): string {
  const material = [
    prevHash,
    input.companyId,
    input.actorId ?? "",
    input.action,
    input.objectType,
    input.objectId,
    input.payloadHash,
    input.at,
  ].join("\n");
  return sha256Hex(material);
}

export function appendEntry(input: ChainInput, prevHash: string | null): ChainedEntry {
  const prev = prevHash ?? GENESIS_HASH;
  return { ...input, prevHash: prev, entryHash: computeEntryHash(input, prev) };
}

export interface VerifyResult {
  valid: boolean;
  /** index of the first entry that failed verification, if any */
  brokenAt?: number;
  reason?: string;
}

/**
 * Verify a full chain (or any contiguous slice starting from a known
 * anchor hash). Returns the first break, if any.
 */
export function verifyChain(
  entries: ChainedEntry[],
  anchorPrevHash: string = GENESIS_HASH,
): VerifyResult {
  let prev = anchorPrevHash;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.prevHash !== prev) {
      return { valid: false, brokenAt: i, reason: "prevHash does not match preceding entry" };
    }
    const expected = computeEntryHash(entry, prev);
    if (entry.entryHash !== expected) {
      return { valid: false, brokenAt: i, reason: "entryHash does not match entry content" };
    }
    prev = entry.entryHash;
  }
  return { valid: true };
}
