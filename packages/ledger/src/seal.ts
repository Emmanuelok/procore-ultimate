/**
 * Chain sealing — the external commitment the hash chain cannot make for itself
 * (spec Vol II Domain S #860-861, #864, #873-874; docs/security.md §8.2 gaps 2-3).
 *
 * WHAT THE HASH CHAIN ALREADY DOES: `chain.ts` makes every entry's hash cover
 * its content plus its predecessor's hash, so editing a historical entry breaks
 * every hash after it. That is tamper-evidence against EDITS.
 *
 * WHAT IT CANNOT DO, and why this file exists:
 *
 *   (a) TAIL TRUNCATION. Delete the last N entries and what remains verifies
 *       perfectly — the chain has no idea how long it is supposed to be. The
 *       fix is a commitment to `entryCount` made at a time the entries existed.
 *
 *   (b) WHOLESALE REWRITE. Whoever controls the database can recompute every
 *       hash from genesis and produce a different history that verifies just as
 *       well. Nothing inside the database can defeat this, because the attacker
 *       controls everything inside the database. The fix is a signature made
 *       with a key whose private half is NOT in the database, over a Merkle
 *       root of the whole chain.
 *
 *   (c) SEAL REMOVAL. Once (a) and (b) are closed by sealing, the attacker's
 *       next move is to delete the inconvenient seals. So seals are themselves
 *       chained: each carries the hash of the previous seal's body and a
 *       sequence contiguous from 1, and removing one is as visible as editing
 *       an entry.
 *
 * Everything here is PURE: no database, no HTTP, no clock of its own. The seal
 * body is canonicalized with the same RFC-8785-style helper the ledger uses, so
 * the exact bytes that were signed can be reproduced years later by anyone
 * holding the receipt — including with `openssl pkeyutl -verify`.
 */
import { createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { hashPayload, sha256Hex } from "./hash.js";
import { merkleRoot } from "./merkle.js";
import { computeEntryHash, type ChainedEntry } from "./chain.js";

/** The only signature algorithm this module makes or accepts. */
export const SEAL_ALGORITHM = "ed25519";

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Verdict of verifying a chain against its seals.
 *
 * Deliberately duplicated as a literal union rather than imported: this package
 * has no dependency on @constructos/shared and must stay usable by an offline
 * verifier. `CHAIN_VERDICTS` in @constructos/shared is the same set, and the
 * API module asserts the two are mutually assignable at compile time.
 */
export type SealChainVerdict =
  | "intact"
  | "tail_truncated"
  | "entry_altered"
  | "seal_forged"
  | "seal_broken"
  | "no_seals";

/* ------------------------------------------------------------------ */
/* The seal body — the canonical object that gets signed               */
/* ------------------------------------------------------------------ */

export interface SealBodyInput {
  companyId: string;
  /** monotonic per company, starting at 1 */
  sequence: number;
  /** first ledger seq covered (the whole chain is committed, not just the delta) */
  fromEntrySeq: number;
  /** last ledger seq covered — the head at seal time */
  toEntrySeq: number;
  /** total entries in the chain at seal time: the truncation tripwire */
  entryCount: number;
  /** entryHash of the last entry at seal time */
  headHash: string;
  /** merkle root over every entry hash in the chain at seal time */
  merkleRoot: string;
  /** hash of the previous seal's canonical body; null for sequence 1 */
  prevSealHash: string | null;
  /** ISO-8601 instant; normalized here so DB round-trips cannot change the bytes */
  sealedAt: string;
  keyId: string;
  algorithm?: string;
}

export interface SealBody {
  companyId: string;
  sequence: number;
  fromEntrySeq: number;
  toEntrySeq: number;
  entryCount: number;
  headHash: string;
  merkleRoot: string;
  prevSealHash: string | null;
  sealedAt: string;
  keyId: string;
  algorithm: string;
}

/** A stored seal: its body plus the two things the body does not contain. */
export interface SealRecord extends SealBody {
  /** sha256 of the canonical body */
  bodyHash: string;
  /** base64 Ed25519 signature over the canonical body bytes */
  signature: string;
  /** optional database id, carried through for reporting only */
  id?: string;
}

function requireHex64(value: unknown, field: string): string {
  if (typeof value !== "string" || !HEX64.test(value)) {
    throw new TypeError(`seal body ${field} must be a 64-character lowercase hex sha256`);
  }
  return value;
}

function requireInt(value: unknown, field: string, min: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new TypeError(`seal body ${field} must be an integer >= ${min}`);
  }
  return value;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`seal body ${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Build the canonical seal body. Validates every field, because a seal that
 * commits to a malformed number is worse than no seal at all, and normalizes
 * `sealedAt` to ISO-8601 with milliseconds: the database stores timestamps in
 * its own textual form ("2026-08-25 10:20:00.123+00") and a signature over
 * un-normalized bytes would stop verifying the moment the row was read back.
 */
export function buildSealBody(input: SealBodyInput): SealBody {
  const algorithm = input.algorithm ?? SEAL_ALGORITHM;
  if (algorithm !== SEAL_ALGORITHM) {
    throw new TypeError(`unsupported seal algorithm "${algorithm}" (only ${SEAL_ALGORITHM})`);
  }
  const sealedAtMs = Date.parse(input.sealedAt);
  if (Number.isNaN(sealedAtMs)) {
    throw new TypeError("seal body sealedAt must be a parseable timestamp");
  }
  const entryCount = requireInt(input.entryCount, "entryCount", 1);
  const fromEntrySeq = requireInt(input.fromEntrySeq, "fromEntrySeq", 1);
  const toEntrySeq = requireInt(input.toEntrySeq, "toEntrySeq", 1);
  if (toEntrySeq < fromEntrySeq) {
    throw new TypeError("seal body toEntrySeq must be >= fromEntrySeq");
  }
  return {
    companyId: requireText(input.companyId, "companyId"),
    sequence: requireInt(input.sequence, "sequence", 1),
    fromEntrySeq,
    toEntrySeq,
    entryCount,
    headHash: requireHex64(input.headHash, "headHash"),
    merkleRoot: requireHex64(input.merkleRoot, "merkleRoot"),
    prevSealHash:
      input.prevSealHash === null || input.prevSealHash === undefined
        ? null
        : requireHex64(input.prevSealHash, "prevSealHash"),
    sealedAt: new Date(sealedAtMs).toISOString(),
    keyId: requireText(input.keyId, "keyId"),
    algorithm,
  };
}

/** The exact bytes that are signed and hashed. */
export function sealBodyBytes(body: SealBody): string {
  return canonicalize(body);
}

/** sha256 hex of the canonical seal body. This is what the next seal chains to. */
export function sealBodyHash(body: SealBody): string {
  return sha256Hex(sealBodyBytes(body));
}

/* ------------------------------------------------------------------ */
/* Signing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Ed25519 signature over the canonical body, base64.
 *
 * `privateKey` accepts a PKCS8 PEM string or a KeyObject. The caller is
 * expected to hold it in process memory only — the whole security property of
 * a seal is that this key is not reachable from the database.
 */
export function signSealBody(body: SealBody, privateKey: string | KeyObject): string {
  return cryptoSign(null, Buffer.from(sealBodyBytes(body), "utf8"), privateKey).toString("base64");
}

/**
 * Verify a base64 Ed25519 signature over the canonical body with an SPKI PEM
 * public key. Never throws: malformed keys, malformed signatures and malformed
 * bodies are all simply "does not verify", because this runs on input supplied
 * by whoever is presenting a receipt.
 */
export function verifySealSignature(
  body: SealBody,
  signature: string,
  publicKey: string | KeyObject,
): boolean {
  try {
    const key = typeof publicKey === "string" ? createPublicKey(publicKey) : publicKey;
    if (key.asymmetricKeyType !== "ed25519") return false;
    return cryptoVerify(
      null,
      Buffer.from(sealBodyBytes(body), "utf8"),
      key,
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* The seal chain                                                      */
/* ------------------------------------------------------------------ */

export interface SealChainResult {
  valid: boolean;
  /** the sequence number of the seal at which the chain broke */
  brokenAtSequence?: number;
  reason?: string;
}

/**
 * Walk seals in sequence order and check that they form an unbroken chain:
 * sequences contiguous from 1, seal 1 alone having no predecessor, and every
 * later seal's `prevSealHash` equal to the RECOMPUTED body hash of the seal
 * before it (recomputed, not the stored `bodyHash`, so a stored hash edited to
 * match a forged link does not help the attacker).
 *
 * This is the check that makes seal REMOVAL visible. Without it, an insider who
 * truncates the ledger simply deletes the seals that would have noticed.
 */
export function verifySealChain(seals: SealRecord[]): SealChainResult {
  if (seals.length === 0) return { valid: true };
  const sorted = [...seals].sort((a, b) => a.sequence - b.sequence);
  let prevBodyHash: string | null = null;
  for (let i = 0; i < sorted.length; i++) {
    const seal = sorted[i]!;
    const expectedSequence = i + 1;
    if (seal.sequence !== expectedSequence) {
      return {
        valid: false,
        brokenAtSequence: seal.sequence,
        reason:
          `seal sequence ${seal.sequence} found where ${expectedSequence} was expected — ` +
          `${expectedSequence === seal.sequence - 1 ? "a seal is" : "one or more seals are"} ` +
          "missing from the seal chain",
      };
    }
    let body: SealBody;
    try {
      body = buildSealBody(seal);
    } catch (err) {
      return {
        valid: false,
        brokenAtSequence: seal.sequence,
        reason: `seal ${seal.sequence} body is malformed: ${(err as Error).message}`,
      };
    }
    const bodyHash = sealBodyHash(body);
    if (seal.bodyHash && seal.bodyHash !== bodyHash) {
      return {
        valid: false,
        brokenAtSequence: seal.sequence,
        reason: `seal ${seal.sequence} stored bodyHash does not match its own body`,
      };
    }
    if ((seal.prevSealHash ?? null) !== prevBodyHash) {
      return {
        valid: false,
        brokenAtSequence: seal.sequence,
        reason:
          seal.sequence === 1
            ? "seal 1 must have no prevSealHash"
            : `seal ${seal.sequence} prevSealHash does not match the body hash of seal ${
                seal.sequence - 1
              }`,
      };
    }
    prevBodyHash = bodyHash;
  }
  return { valid: true };
}

/* ------------------------------------------------------------------ */
/* classifyChain — the verdict an auditor reads                        */
/* ------------------------------------------------------------------ */

/** A live ledger entry plus its database sequence number. */
export interface SealedChainEntry extends ChainedEntry {
  seq: number;
  /**
   * The stored payload SNAPSHOT, where the entry kept one.
   *
   * The chain hashes `payloadHash`, not the snapshot, so an insider who edits
   * the snapshot alone — rewriting what the record SAYS while leaving every
   * hash valid — is invisible to the chain and to every seal over it. Supply
   * it and {@link classifyChain} re-derives its hash and compares. Omit it
   * (undefined) and nothing is claimed about it either way; `null` means the
   * entry stored no snapshot, which is not a finding.
   */
  payload?: unknown;
}

export interface ClassifyChainInput {
  seals: SealRecord[];
  /** the company's live chain, ascending by seq */
  entries: SealedChainEntry[];
  /** keyId → SPKI PEM. A seal whose key is absent cannot be signature-checked. */
  publicKeys?: Record<string, string>;
}

export interface ChainClassification {
  verdict: SealChainVerdict;
  /** true only for "intact" */
  ok: boolean;
  /** entries currently in the chain */
  entryCount: number;
  sealCount: number;
  latestSealSequence: number | null;
  /** entryCount committed by the newest seal */
  sealedEntryCount: number | null;
  /** the seal whose check failed, by sequence */
  failedSealSequence: number | null;
  /** the ledger seq at which the failure was localized, when it can be */
  failedEntrySeq: number | null;
  /** the range the failure must lie in, when it cannot be localized exactly */
  suspectRange: { fromEntrySeq: number; toEntrySeq: number } | null;
  /** plain English, written for someone who has to act on it */
  reason: string;
  /** how many seals had their signature actually checked */
  signaturesChecked: number;
  /** seals whose keyId is not among the supplied public keys */
  unknownKeyIds: string[];
  notes: string[];
}

interface EntryBreak {
  index: number;
  seq: number;
  reason: string;
}

/**
 * Recompute every entry hash and every prevHash link. This is what catches a
 * content edit: the attacker who rewrites `payloadHash` on one row but does not
 * recompute the hashes leaves the entry hash no longer derivable from the entry.
 */
function findEntryBreak(entries: SealedChainEntry[]): EntryBreak | null {
  let prev: string | null = null;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (prev !== null && entry.prevHash !== prev) {
      return {
        index: i,
        seq: entry.seq,
        reason: `entry seq ${entry.seq} does not link to its predecessor (prevHash mismatch)`,
      };
    }
    if (computeEntryHash(entry, entry.prevHash) !== entry.entryHash) {
      return {
        index: i,
        seq: entry.seq,
        reason: `entry seq ${entry.seq} content does not hash to its stored entryHash`,
      };
    }
    // The snapshot, when one was supplied. The chain covers `payloadHash`; it
    // does NOT cover the snapshot the hash was taken over, so without this an
    // insider can rewrite what an entry says and leave every hash verifying.
    if (entry.payload !== undefined && entry.payload !== null) {
      if (hashPayload(entry.payload) !== entry.payloadHash) {
        return {
          index: i,
          seq: entry.seq,
          reason:
            `entry seq ${entry.seq} stores a payload snapshot that no longer hashes to its ` +
            "payloadHash — the recorded content was edited while the chain was left intact",
        };
      }
    }
    prev = entry.entryHash;
  }
  return null;
}

function emptyResult(
  verdict: SealChainVerdict,
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
 * Classify a company's chain against its seals.
 *
 * The checks run in this order, and the FIRST one to fail decides the verdict —
 * because that is the order in which an investigator would want to hear it:
 *
 *  1. no seals at all              → "no_seals"      (nothing external commits to this chain)
 *  2. a seal signature is invalid  → "seal_forged"   (someone made a seal without the key)
 *  3. seal linkage or sequence     → "seal_broken"   (a seal was removed or relinked)
 *  4. fewer entries than sealed    → "tail_truncated"(entries that were sealed are gone)
 *  5. an entry no longer hashes    → "entry_altered" (a row was edited)
 *  6. a sealed Merkle root moved   → "entry_altered" or "tail_truncated" (see below)
 *
 * Step 6 distinguishes two ways a sealed prefix can stop reproducing its root:
 * if the entry now standing at the sealed head position carries a different
 * `seq` than the seal recorded, the prefix was cut and refilled — truncation.
 * If the seq matches but the hashes do not, the range was rewritten in place.
 */
export function classifyChain(input: ClassifyChainInput): ChainClassification {
  const entries = [...input.entries].sort((a, b) => a.seq - b.seq);
  const seals = [...input.seals].sort((a, b) => a.sequence - b.sequence);
  const publicKeys = input.publicKeys ?? {};
  const notes: string[] = [];

  if (seals.length === 0) {
    return emptyResult(
      "no_seals",
      entries.length,
      0,
      `This chain has ${entries.length} entr${entries.length === 1 ? "y" : "ies"} and no seals. ` +
        "The hash chain is internally verifiable, but nothing outside the database commits to " +
        "its length or its content: the last N entries could be deleted, or the whole chain " +
        "rewritten from genesis, and it would still verify. Seal it.",
    );
  }

  const latest = seals[seals.length - 1]!;
  const base = {
    entryCount: entries.length,
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
    if (entries.length < seal.entryCount) {
      // The EARLIEST seal to notice localizes the break furthest back, which is
      // what an investigator wants. Its shortfall is not the whole loss, though
      // — the newest seal committed to more — so both numbers are stated, or
      // the prose would understate what `sealedEntryCount` already reports.
      const missing = seal.entryCount - entries.length;
      const newestMissing = latest.entryCount - entries.length;
      return {
        ...base,
        verdict: "tail_truncated",
        ok: false,
        failedSealSequence: seal.sequence,
        failedEntrySeq: entries[entries.length - 1]?.seq ?? null,
        suspectRange: {
          fromEntrySeq: entries[entries.length - 1]?.seq ?? seal.fromEntrySeq,
          toEntrySeq: seal.toEntrySeq,
        },
        reason:
          `Seal ${seal.sequence} committed to ${seal.entryCount} entries up to seq ` +
          `${seal.toEntrySeq}; the chain now holds ${entries.length}. ${missing} sealed ` +
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
  const entryBreak = findEntryBreak(entries);
  if (entryBreak) {
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
    const prefix = entries.slice(0, seal.entryCount);
    const head = prefix[prefix.length - 1];
    if (!head) {
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
    const root = merkleRoot(prefix.map((e) => e.entryHash));
    const rootMatches = root === seal.merkleRoot;
    const headMatches = head.entryHash === seal.headHash;
    if (rootMatches && headMatches) {
      lastGoodEntryCount = seal.entryCount;
      continue;
    }
    const refilled = head.seq !== seal.toEntrySeq;
    const suspectRange = {
      fromEntrySeq: entries[lastGoodEntryCount]?.seq ?? seal.fromEntrySeq,
      toEntrySeq: seal.toEntrySeq,
    };
    if (refilled) {
      return {
        ...base,
        verdict: "tail_truncated",
        ok: false,
        failedSealSequence: seal.sequence,
        failedEntrySeq: head.seq,
        suspectRange,
        reason:
          `Seal ${seal.sequence} sealed seq ${seal.toEntrySeq} at position ${seal.entryCount}; ` +
          `that position now holds seq ${head.seq}. The sealed prefix was cut and refilled — ` +
          "the current head does not extend the chain that was sealed, it replaces part of it.",
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
      failedEntrySeq: headMatches ? null : head.seq,
      suspectRange,
      reason:
        `Seal ${seal.sequence} committed ${rootMatches ? "head hash" : "Merkle root"} ` +
        `${rootMatches ? seal.headHash : seal.merkleRoot} over entries ${suspectRange.fromEntrySeq}` +
        `-${seal.toEntrySeq}; those entries now produce ` +
        `${rootMatches ? head.entryHash : root}. Every entry still hashes to its own content and ` +
        "links to its predecessor, which is what a wholesale rewrite looks like: the history in " +
        "the database is internally consistent and is not the history that was sealed.",
      signaturesChecked,
      unknownKeyIds,
      notes,
    };
  }

  if (entries.length > latest.entryCount) {
    const newer = entries.length - latest.entryCount;
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
