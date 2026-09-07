/**
 * The streaming classifier must agree with the array classifier, always.
 *
 * `classifyScan` is an optimisation of `classifyChain`, and an optimisation of
 * a verdict is only worth having if it produces the same verdict. These tests
 * generate chains, corrupt them in each of the ways the ladder distinguishes,
 * and assert the two agree field for field — including the prose, because an
 * auditor comparing an online verdict with one produced offline from an export
 * must not have to reconcile two dialects of the same finding.
 */
import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  buildSealBody,
  classifyChain,
  computeEntryHash,
  merkleRoot,
  sealBodyHash,
  signSealBody,
  GENESIS_HASH,
  type SealRecord,
} from "@constructos/ledger";
import { MerkleFrontier, classifyScan, scanArray, type ScanEntry } from "./scan.js";

/* ------------------------------------------------------------------ */
/* The frontier must reproduce merkleRoot exactly                      */
/* ------------------------------------------------------------------ */

describe("MerkleFrontier", () => {
  it("reproduces merkleRoot for every prefix length 0..64", () => {
    const leaves = Array.from({ length: 64 }, (_, i) =>
      computeEntryHash(
        {
          companyId: "c",
          actorId: null,
          action: "create",
          objectType: "t",
          objectId: `o${i}`,
          payloadHash: "0".repeat(64),
          at: new Date(1_700_000_000_000 + i).toISOString(),
        },
        GENESIS_HASH,
      ),
    );
    const frontier = new MerkleFrontier();
    expect(frontier.root()).toBe(merkleRoot([]));
    for (let n = 1; n <= leaves.length; n++) {
      frontier.add(leaves[n - 1]!);
      expect(frontier.count).toBe(n);
      expect(frontier.root()).toBe(merkleRoot(leaves.slice(0, n)));
    }
  });

  it("agrees with merkleRoot at awkward lengths (odd promotion)", () => {
    const leaves = Array.from({ length: 200 }, (_, i) => `${i}`.padStart(64, "0"));
    for (const n of [1, 2, 3, 5, 7, 9, 11, 13, 17, 31, 33, 63, 65, 100, 127, 128, 129, 200]) {
      const f = new MerkleFrontier();
      for (const leaf of leaves.slice(0, n)) f.add(leaf);
      expect(f.root()).toBe(merkleRoot(leaves.slice(0, n)));
    }
  });
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const KEY_ID = "ank_test";

function buildChain(n: number, companyId = "co_1"): ScanEntry[] {
  const out: ScanEntry[] = [];
  let prev = GENESIS_HASH;
  for (let i = 0; i < n; i++) {
    const input = {
      companyId,
      actorId: i % 3 === 0 ? null : `u_${i}`,
      action: "create",
      objectType: "thing",
      objectId: `o_${i}`,
      payloadHash: `${i}`.padStart(64, "a"),
      at: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    };
    const entryHash = computeEntryHash(input, prev);
    out.push({ ...input, seq: i + 1, prevHash: prev, entryHash });
    prev = entryHash;
  }
  return out;
}

function sealOver(
  entries: ScanEntry[],
  sequence: number,
  prevSealHash: string | null,
  companyId = "co_1",
): SealRecord {
  const head = entries[entries.length - 1]!;
  const body = buildSealBody({
    companyId,
    sequence,
    fromEntrySeq: entries[0]!.seq,
    toEntrySeq: head.seq,
    entryCount: entries.length,
    headHash: head.entryHash,
    merkleRoot: merkleRoot(entries.map((e) => e.entryHash)),
    prevSealHash,
    sealedAt: new Date(1_700_000_900_000 + sequence).toISOString(),
    keyId: KEY_ID,
  });
  return {
    ...body,
    bodyHash: sealBodyHash(body),
    signature: signSealBody(body, privateKey),
    id: `seal_${sequence}`,
  };
}

async function bothVerdicts(entries: ScanEntry[], seals: SealRecord[]) {
  const scan = await scanArray(
    entries,
    seals.map((s) => s.entryCount),
    3, // deliberately tiny pages: the paging boundary must not change anything
  );
  const streamed = classifyScan(scan, seals, { [KEY_ID]: publicKeyPem });
  const array = classifyChain({ entries, seals, publicKeys: { [KEY_ID]: publicKeyPem } });
  return { streamed, array, scan };
}

/* ------------------------------------------------------------------ */
/* Equivalence across the whole verdict ladder                         */
/* ------------------------------------------------------------------ */

describe("classifyScan agrees with classifyChain", () => {
  it("on an intact chain with several seals", async () => {
    const entries = buildChain(11);
    const s1 = sealOver(entries.slice(0, 4), 1, null);
    const s2 = sealOver(entries.slice(0, 9), 2, s1.bodyHash);
    const { streamed, array } = await bothVerdicts(entries, [s1, s2]);
    expect(streamed.verdict).toBe("intact");
    expect(streamed).toEqual(array);
  });

  it("when there are no seals at all", async () => {
    const entries = buildChain(5);
    const { streamed, array } = await bothVerdicts(entries, []);
    expect(streamed.verdict).toBe("no_seals");
    expect(streamed).toEqual(array);
  });

  it("when the tail has been truncated below a seal's entry count", async () => {
    const entries = buildChain(10);
    const seal = sealOver(entries, 1, null);
    const { streamed, array } = await bothVerdicts(entries.slice(0, 6), [seal]);
    expect(streamed.verdict).toBe("tail_truncated");
    expect(streamed).toEqual(array);
  });

  it("when an entry in the middle has been edited", async () => {
    const entries = buildChain(9);
    const seal = sealOver(entries, 1, null);
    const tampered = entries.map((e, i) =>
      i === 4 ? { ...e, payloadHash: "f".repeat(64) } : e,
    );
    const { streamed, array } = await bothVerdicts(tampered, [seal]);
    expect(streamed.verdict).toBe("entry_altered");
    expect(streamed.failedEntrySeq).toBe(5);
    expect(streamed).toEqual(array);
  });

  it("when a sealed prefix was rewritten in place (same seqs, new hashes)", async () => {
    const entries = buildChain(8);
    const seal = sealOver(entries.slice(0, 5), 1, null);
    // Rebuild the chain with different content but the SAME seq numbers, so
    // every hash links and only the seal notices.
    const rewritten = buildChain(8).map((e) => ({
      ...e,
      objectId: `rewritten_${e.seq}`,
    }));
    let prev = GENESIS_HASH;
    for (const e of rewritten) {
      e.prevHash = prev;
      e.entryHash = computeEntryHash(e, prev);
      prev = e.entryHash;
    }
    const { streamed, array } = await bothVerdicts(rewritten, [seal]);
    expect(streamed.verdict).toBe("entry_altered");
    expect(streamed).toEqual(array);
  });

  it("when the sealed prefix was cut and refilled (position holds a new seq)", async () => {
    const entries = buildChain(10);
    const seal = sealOver(entries.slice(0, 6), 1, null);
    // Drop two early entries and re-link: position 6 now holds seq 8.
    const survivors = entries.filter((e) => e.seq !== 2 && e.seq !== 3);
    let prev = GENESIS_HASH;
    for (const e of survivors) {
      e.prevHash = prev;
      e.entryHash = computeEntryHash(e, prev);
      prev = e.entryHash;
    }
    const { streamed, array } = await bothVerdicts(survivors, [seal]);
    expect(streamed.verdict).toBe("tail_truncated");
    expect(streamed).toEqual(array);
  });

  it("when a seal has been removed from the middle of the seal chain", async () => {
    const entries = buildChain(12);
    const s1 = sealOver(entries.slice(0, 4), 1, null);
    const s2 = sealOver(entries.slice(0, 8), 2, s1.bodyHash);
    const s3 = sealOver(entries, 3, s2.bodyHash);
    const { streamed, array } = await bothVerdicts(entries, [s1, s3]);
    expect(streamed.verdict).toBe("seal_broken");
    expect(streamed).toEqual(array);
  });

  it("when a seal signature does not verify", async () => {
    const entries = buildChain(6);
    const seal = sealOver(entries, 1, null);
    const forged: SealRecord = { ...seal, headHash: "e".repeat(64) };
    const { streamed, array } = await bothVerdicts(entries, [forged]);
    expect(streamed.verdict).toBe("seal_forged");
    expect(streamed).toEqual(array);
  });

  it("when the seal's key is unknown, both leave the same note", async () => {
    const entries = buildChain(4);
    const seal = sealOver(entries, 1, null);
    const scan = await scanArray(entries, [seal.entryCount]);
    const streamed = classifyScan(scan, [seal], {});
    const array = classifyChain({ entries, seals: [seal], publicKeys: {} });
    expect(streamed.unknownKeyIds).toEqual([KEY_ID]);
    expect(streamed).toEqual(array);
  });

  it("notes entries appended since the last seal, identically", async () => {
    const entries = buildChain(9);
    const seal = sealOver(entries.slice(0, 5), 1, null);
    const { streamed, array } = await bothVerdicts(entries, [seal]);
    expect(streamed.verdict).toBe("intact");
    expect(streamed.notes.join(" ")).toMatch(/newer than the last seal/);
    expect(streamed).toEqual(array);
  });
});

/* ------------------------------------------------------------------ */
/* The scan itself                                                     */
/* ------------------------------------------------------------------ */

describe("scanChain", () => {
  it("reads the chain in pages and never holds more than the frontier", async () => {
    const entries = buildChain(37);
    let pages = 0;
    let widest = 0;
    const scan = await scanArray(entries, [10, 20], 5);
    expect(scan.entryCount).toBe(37);
    expect(scan.firstSeq).toBe(1);
    expect(scan.lastSeq).toBe(37);
    expect(scan.headHash).toBe(entries[36]!.entryHash);
    expect(scan.root).toBe(merkleRoot(entries.map((e) => e.entryHash)));
    expect(scan.checkpoints.get(10)!.root).toBe(
      merkleRoot(entries.slice(0, 10).map((e) => e.entryHash)),
    );
    expect(scan.checkpoints.get(10)!.headSeq).toBe(10);
    expect(scan.checkpoints.get(10)!.nextSeq).toBe(11);
    expect(scan.checkpoints.get(20)!.headHash).toBe(entries[19]!.entryHash);
    // and the reader really is called page by page
    await (async () => {
      const sorted = [...entries];
      const s = await (
        await import("./scan.js")
      ).scanChain(
        async (after, limit) => {
          pages += 1;
          const page = sorted.filter((e) => e.seq > after).slice(0, limit);
          widest = Math.max(widest, page.length);
          return page;
        },
        { checkpoints: [], batchSize: 5 },
      );
      expect(s.entryCount).toBe(37);
    })();
    expect(pages).toBeGreaterThan(5);
    expect(widest).toBeLessThanOrEqual(5);
  });

  it("has no checkpoint beyond the end of a truncated chain", async () => {
    const entries = buildChain(4);
    const scan = await scanArray(entries, [9]);
    expect(scan.checkpoints.has(9)).toBe(false);
    expect(scan.entryCount).toBe(4);
  });

  it("records a checkpoint at the very last entry with no nextSeq", async () => {
    const entries = buildChain(6);
    const scan = await scanArray(entries, [6]);
    expect(scan.checkpoints.get(6)!.nextSeq).toBeNull();
  });
});
