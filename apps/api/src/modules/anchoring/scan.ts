/**
 * Streaming chain classification — the same verdict as `classifyChain`,
 * computed in constant memory (spec Vol II Domain S #860-864, #873-874).
 *
 * WHY THIS EXISTS. `classifyChain` in @constructos/ledger takes the whole
 * chain as an array. That is right for an offline verifier holding an export,
 * and wrong for an API serving a tenant with millions of entries: every chain
 * verdict, every seal creation, every per-seal verify and every escrow
 * verification materialised the entire ledger, and the Ledger workspace fires
 * several of those on mount. Dropping the jsonb payload from the select made
 * each row smaller; it did not stop the array from being O(entries).
 *
 * WHAT CHANGES. Nothing about the verdict. This module walks the chain in
 * pages and keeps three things instead of the rows:
 *
 *   • a running previous-hash, which is all `findEntryBreak` ever needed;
 *   • a Merkle FRONTIER (the peaks of the perfect subtrees seen so far), from
 *     which the root of the prefix read so far is derivable in O(log n);
 *   • one small checkpoint per seal — the root, head hash and head seq at that
 *     seal's `entryCount`, plus the seq of the entry immediately after it,
 *     which is the only other position the classification refers to.
 *
 * The frontier reproduces `merkleRoot` exactly, including its promote-odd
 * shape (odd nodes are carried up rather than duplicated). That equivalence is
 * asserted for every length 0..64 in `scan.test.ts`, and the whole
 * classification is asserted equal to `classifyChain`'s on generated chains,
 * because a verdict that is cheaper but different is not a verdict at all.
 *
 * PURE: no database, no clock. The caller supplies a page reader.
 */
import {
  buildSealBody,
  computeEntryHash,
  sha256Hex,
  verifySealChain,
  verifySealSignature,
  type ChainClassification,
  type SealBody,
  type SealRecord,
} from "@constructos/ledger";

/** A ledger row as the chain sees it: hash columns only, no payload snapshot. */
export interface ScanEntry {
  seq: number;
  companyId: string;
  actorId: string | null;
  action: string;
  objectType: string;
  objectId: string;
  payloadHash: string;
  at: string;
  prevHash: string;
  entryHash: string;
}

/**
 * The peaks of the perfect binary subtrees over the leaves added so far.
 *
 * Adding a leaf pushes a size-1 peak and merges equal-sized neighbours, so the
 * structure holds at most log2(n) hashes however long the chain is. `root()`
 * folds the peaks right-to-left, which is exactly what the level-by-level
 * construction in `merkleRoot` produces when odd nodes are promoted.
 */
export class MerkleFrontier {
  private peaks: Array<{ hash: string; size: number }> = [];
  private n = 0;

  add(leafHash: string): void {
    let node = { hash: leafHash, size: 1 };
    for (;;) {
      const top = this.peaks[this.peaks.length - 1];
      if (!top || top.size !== node.size) break;
      this.peaks.pop();
      node = { hash: sha256Hex(top.hash + node.hash), size: top.size * 2 };
    }
    this.peaks.push(node);
    this.n += 1;
  }

  get count(): number {
    return this.n;
  }

  /** Merkle root of every leaf added so far. Does not mutate the frontier. */
  root(): string {
    if (this.peaks.length === 0) return sha256Hex("");
    let acc = this.peaks[this.peaks.length - 1]!.hash;
    for (let i = this.peaks.length - 2; i >= 0; i--) {
      acc = sha256Hex(this.peaks[i]!.hash + acc);
    }
    return acc;
  }
}

export interface ScanCheckpoint {
  /** number of entries committed at this checkpoint */
  entryCount: number;
  /** Merkle root of the first `entryCount` entry hashes */
  root: string;
  /** the entry standing at position `entryCount` */
  headSeq: number;
  headHash: string;
  /** seq of the entry immediately after the prefix, when the chain has one */
  nextSeq: number | null;
}

export interface EntryBreak {
  /** 0-based position in the chain */
  index: number;
  seq: number;
  reason: string;
}

export interface ChainScan {
  entryCount: number;
  firstSeq: number | null;
  lastSeq: number | null;
  headHash: string | null;
  /** Merkle root over the whole chain as it now stands */
  root: string;
  entryBreak: EntryBreak | null;
  checkpoints: Map<number, ScanCheckpoint>;
}

/** Read one page of the chain: entries with seq > afterSeq, ascending. */
export type ChainPageReader = (afterSeq: number, limit: number) => Promise<ScanEntry[]>;

/**
 * Walk the whole chain once, in pages, keeping only what a classification
 * needs. Checkpoints are requested by entry count (one per seal).
 */
export async function scanChain(
  read: ChainPageReader,
  opts: { checkpoints?: number[]; batchSize?: number } = {},
): Promise<ChainScan> {
  const wanted = new Set((opts.checkpoints ?? []).filter((n) => Number.isInteger(n) && n > 0));
  const batchSize = opts.batchSize ?? 5_000;
  const frontier = new MerkleFrontier();
  const checkpoints = new Map<number, ScanCheckpoint>();
  const pending: ScanCheckpoint[] = [];

  let cursor = 0;
  let index = 0;
  let prev: string | null = null;
  let firstSeq: number | null = null;
  let lastSeq: number | null = null;
  let headHash: string | null = null;
  let entryBreak: EntryBreak | null = null;

  for (;;) {
    const rows = await read(cursor, batchSize);
    if (rows.length === 0) break;
    for (const entry of rows) {
      // A checkpoint recorded on the previous entry needs the seq of THIS one.
      while (pending.length > 0) {
        const p = pending.pop()!;
        checkpoints.set(p.entryCount, { ...p, nextSeq: entry.seq });
      }
      if (firstSeq === null) firstSeq = entry.seq;
      if (entryBreak === null) {
        if (prev !== null && entry.prevHash !== prev) {
          entryBreak = {
            index,
            seq: entry.seq,
            reason: `entry seq ${entry.seq} does not link to its predecessor (prevHash mismatch)`,
          };
        } else if (computeEntryHash(entry, entry.prevHash) !== entry.entryHash) {
          entryBreak = {
            index,
            seq: entry.seq,
            reason: `entry seq ${entry.seq} content does not hash to its stored entryHash`,
          };
        }
      }
      prev = entry.entryHash;
      frontier.add(entry.entryHash);
      index += 1;
      lastSeq = entry.seq;
      headHash = entry.entryHash;
      if (wanted.has(index)) {
        pending.push({
          entryCount: index,
          root: frontier.root(),
          headSeq: entry.seq,
          headHash: entry.entryHash,
          nextSeq: null,
        });
      }
    }
    cursor = rows[rows.length - 1]!.seq;
    if (rows.length < batchSize) break;
  }
  // Checkpoints at the very end of the chain have no following entry.
  while (pending.length > 0) {
    const p = pending.pop()!;
    checkpoints.set(p.entryCount, p);
  }

  return {
    entryCount: index,
    firstSeq,
    lastSeq,
    headHash,
    root: frontier.root(),
    entryBreak,
    checkpoints,
  };
}

/** Convenience for tests and small chains: scan an array in one page. */
export async function scanArray(
  entries: ScanEntry[],
  checkpointCounts: number[] = [],
  batchSize = 5_000,
): Promise<ChainScan> {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  return scanChain(
    async (afterSeq, limit) =>
      sorted.filter((e) => e.seq > afterSeq).slice(0, limit),
    { checkpoints: checkpointCounts, batchSize },
  );
}

/** Every entry count a classification needs a checkpoint at. */
export function checkpointCountsFor(seals: Array<{ entryCount: number }>): number[] {
  return [...new Set(seals.map((s) => s.entryCount))];
}

function emptyResult(
  verdict: ChainClassification["verdict"],
  entryCount: number,
  sealCount: number,
  reason: string,
): ChainClassification {
  return {
    verdict,
    ok: verdict === "intact",
    entryCount,
    sealCount,
    latestSealSequence: null,
    sealedEntryCount: null,
    failedSealSequence: null,
    failedEntrySeq: null,
    suspectRange: null,
    reason,
    signaturesChecked: 0,
    unknownKeyIds: [],
    notes: [],
  };
}

/**
 * The verdict ladder of `classifyChain`, evaluated against a scan.
 *
 * The order and the wording are deliberately identical to the array version:
 * an auditor comparing an online verdict with one produced offline from an
 * export must not have to reconcile two dialects of the same finding.
 */
export function classifyScan(
  scan: ChainScan,
  sealRecords: SealRecord[],
  publicKeys: Record<string, string> = {},
): ChainClassification {
  const seals = [...sealRecords].sort((a, b) => a.sequence - b.sequence);
  const notes: string[] = [];

  if (seals.length === 0) {
    return emptyResult(
      "no_seals",
      scan.entryCount,
      0,
      `This chain has ${scan.entryCount} entr${scan.entryCount === 1 ? "y" : "ies"} and no seals. ` +
        "The hash chain is internally verifiable, but nothing outside the database commits to " +
        "its length or its content: the last N entries could be deleted, or the whole chain " +
        "rewritten from genesis, and it would still verify. Seal it.",
    );
  }

  const latest = seals[seals.length - 1]!;
  const base = {
    entryCount: scan.entryCount,
    sealCount: seals.length,
    latestSealSequence: latest.sequence,
    sealedEntryCount: latest.entryCount,
  };
  const unknownKeyIds: string[] = [];
  let signaturesChecked = 0;

  /* 2. signatures ------------------------------------------------- */
  for (const seal of seals) {
    const pem = publicKeys[seal.keyId];
    if (!pem) {
      if (!unknownKeyIds.includes(seal.keyId)) unknownKeyIds.push(seal.keyId);
      continue;
    }
    let body: SealBody;
    try {
      body = buildSealBody(seal);
    } catch (err) {
      return {
        ...base,
        verdict: "seal_forged",
        ok: false,
        failedSealSequence: seal.sequence,
        failedEntrySeq: null,
        suspectRange: null,
        reason: `Seal ${seal.sequence} has a malformed body: ${(err as Error).message}`,
        signaturesChecked,
        unknownKeyIds,
        notes,
      };
    }
    signaturesChecked += 1;
    if (!verifySealSignature(body, seal.signature, pem)) {
      return {
        ...base,
        verdict: "seal_forged",
        ok: false,
        failedSealSequence: seal.sequence,
        failedEntrySeq: null,
        suspectRange: null,
        reason:
          `Seal ${seal.sequence} does not verify under key ${seal.keyId}. Either the seal body ` +
          "was edited after signing, or the seal was produced by something that does not hold " +
          "the signing key. A seal that does not verify proves nothing about the chain it " +
          "claims to commit to.",
        signaturesChecked,
        unknownKeyIds,
        notes,
      };
    }
  }
  if (unknownKeyIds.length > 0) {
    notes.push(
      `No public key was supplied for ${unknownKeyIds.length} key id(s) (${unknownKeyIds.join(
        ", ",
      )}); the signatures of seals made under them could not be checked.`,
    );
  }

  /* 3. seal chain linkage ----------------------------------------- */
  const sealChain = verifySealChain(seals);
  if (!sealChain.valid) {
    return {
      ...base,
      verdict: "seal_broken",
      ok: false,
      failedSealSequence: sealChain.brokenAtSequence ?? null,
      failedEntrySeq: null,
      suspectRange: null,
      reason:
        `The seal chain is broken: ${sealChain.reason}. Seals are chained to each other ` +
        "precisely so that removing an inconvenient one is as visible as editing an entry.",
      signaturesChecked,
      unknownKeyIds,
      notes,
    };
  }

  /* 4. truncation by count ---------------------------------------- */
  for (const seal of seals) {
    if (scan.entryCount < seal.entryCount) {
      const missing = seal.entryCount - scan.entryCount;
      const newestMissing = latest.entryCount - scan.entryCount;
      return {
        ...base,
        verdict: "tail_truncated",
        ok: false,
        failedSealSequence: seal.sequence,
        failedEntrySeq: scan.lastSeq,
        suspectRange: {
          fromEntrySeq: scan.lastSeq ?? seal.fromEntrySeq,
          toEntrySeq: seal.toEntrySeq,
        },
        reason:
          `Seal ${seal.sequence} committed to ${seal.entryCount} entries up to seq ` +
          `${seal.toEntrySeq}; the chain now holds ${scan.entryCount}. ${missing} sealed ` +
          `entr${missing === 1 ? "y is" : "ies are"} missing` +
          (latest.sequence === seal.sequence
            ? ""
            : `, and ${newestMissing} against the newest seal ${latest.sequence}, which ` +
              `committed to ${latest.entryCount}`) +
          ". The remaining chain still " +
          "verifies internally — that is exactly the attack sealing exists to catch.",
        signaturesChecked,
        unknownKeyIds,
        notes,
      };
    }
  }

  /* 5. entry integrity -------------------------------------------- */
  if (scan.entryBreak) {
    const entryBreak = scan.entryBreak;
    const sealCovering = seals.find((s) => s.entryCount >= entryBreak.index + 1);
    if (!sealCovering) {
      notes.push(
        "The altered entry lies beyond the newest seal's range: the hash chain caught it, " +
          "not the seal. Seal the chain to bring it under external commitment.",
      );
    }
    return {
      ...base,
      verdict: "entry_altered",
      ok: false,
      failedSealSequence: sealCovering?.sequence ?? null,
      failedEntrySeq: entryBreak.seq,
      suspectRange: { fromEntrySeq: entryBreak.seq, toEntrySeq: entryBreak.seq },
      reason:
        `Ledger entry seq ${entryBreak.seq} has been altered: ${entryBreak.reason}. ` +
        (sealCovering
          ? `It falls inside the range committed by seal ${sealCovering.sequence}.`
          : "It falls after the newest seal, so only the hash chain covers it."),
      signaturesChecked,
      unknownKeyIds,
      notes,
    };
  }

  /* 6. sealed Merkle roots ---------------------------------------- */
  let lastGoodEntryCount = 0;
  for (const seal of seals) {
    const checkpoint = scan.checkpoints.get(seal.entryCount);
    if (!checkpoint) {
      return {
        ...base,
        verdict: "tail_truncated",
        ok: false,
        failedSealSequence: seal.sequence,
        failedEntrySeq: null,
        suspectRange: { fromEntrySeq: seal.fromEntrySeq, toEntrySeq: seal.toEntrySeq },
        reason: `Seal ${seal.sequence} commits to ${seal.entryCount} entries and the chain is empty.`,
        signaturesChecked,
        unknownKeyIds,
        notes,
      };
    }
    const rootMatches = checkpoint.root === seal.merkleRoot;
    const headMatches = checkpoint.headHash === seal.headHash;
    if (rootMatches && headMatches) {
      lastGoodEntryCount = seal.entryCount;
      continue;
    }
    const refilled = checkpoint.headSeq !== seal.toEntrySeq;
    const atLastGood =
      lastGoodEntryCount === 0
        ? scan.firstSeq
        : (scan.checkpoints.get(lastGoodEntryCount)?.nextSeq ?? null);
    const suspectRange = {
      fromEntrySeq: atLastGood ?? seal.fromEntrySeq,
      toEntrySeq: seal.toEntrySeq,
    };
    if (refilled) {
      return {
        ...base,
        verdict: "tail_truncated",
        ok: false,
        failedSealSequence: seal.sequence,
        failedEntrySeq: checkpoint.headSeq,
        suspectRange,
        reason:
          `Seal ${seal.sequence} sealed seq ${seal.toEntrySeq} at position ${seal.entryCount}; ` +
          `that position now holds seq ${checkpoint.headSeq}. The sealed prefix was cut and ` +
          "refilled — the current head does not extend the chain that was sealed, it replaces " +
          "part of it.",
        signaturesChecked,
        unknownKeyIds,
        notes,
      };
    }
    return {
      ...base,
      verdict: "entry_altered",
      ok: false,
      failedSealSequence: seal.sequence,
      failedEntrySeq: headMatches ? null : checkpoint.headSeq,
      suspectRange,
      reason:
        `Seal ${seal.sequence} committed ${rootMatches ? "head hash" : "Merkle root"} ` +
        `${rootMatches ? seal.headHash : seal.merkleRoot} over entries ${suspectRange.fromEntrySeq}` +
        `-${seal.toEntrySeq}; those entries now produce ` +
        `${rootMatches ? checkpoint.headHash : checkpoint.root}. Every entry still hashes to its ` +
        "own content and links to its predecessor, which is what a wholesale rewrite looks " +
        "like: the history in the database is internally consistent and is not the history " +
        "that was sealed.",
      signaturesChecked,
      unknownKeyIds,
      notes,
    };
  }

  if (scan.entryCount > latest.entryCount) {
    const newer = scan.entryCount - latest.entryCount;
    notes.push(
      `${newer} entr${newer === 1 ? "y is" : "ies are"} newer than the last seal and ` +
        `${newer === 1 ? "is" : "are"} covered only by the hash chain until the next seal.`,
    );
  }

  return {
    ...base,
    verdict: "intact",
    ok: true,
    failedSealSequence: null,
    failedEntrySeq: null,
    suspectRange: null,
    reason:
      `All ${seals.length} seal(s) verify, the seal chain is contiguous from 1, and the ` +
      `${latest.entryCount} entries committed by seal ${latest.sequence} are present, unaltered ` +
      "and reproduce the sealed Merkle root.",
    signaturesChecked,
    unknownKeyIds,
    notes,
  };
}
