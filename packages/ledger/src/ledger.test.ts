import { describe, expect, it } from "vitest";
import { canonicalize } from "./canonical.js";
import { hashPayload, sha256Hex } from "./hash.js";
import { GENESIS_HASH, appendEntry, verifyChain, type ChainedEntry } from "./chain.js";
import { merkleProof, merkleRoot, verifyMerkleProof } from "./merkle.js";

describe("canonicalize", () => {
  it("is key-order independent", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });
  it("handles nesting, arrays, nulls and dates", () => {
    const out = canonicalize({ z: [1, null, { y: true }], d: new Date("2026-01-01T00:00:00Z") });
    expect(out).toBe('{"d":"2026-01-01T00:00:00.000Z","z":[1,null,{"y":true}]}');
  });
  it("drops undefined object members", () => {
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
  it("rejects non-finite numbers", () => {
    expect(() => canonicalize({ a: Infinity })).toThrow();
  });
});

describe("hash chain", () => {
  const base = {
    companyId: "c1",
    actorId: "u1",
    action: "create",
    objectType: "rfi",
    payloadHash: hashPayload({ subject: "test" }),
    at: "2026-08-21T00:00:00.000Z",
  };

  function buildChain(n: number): ChainedEntry[] {
    const entries: ChainedEntry[] = [];
    let prev: string | null = null;
    for (let i = 0; i < n; i++) {
      const entry = appendEntry({ ...base, objectId: `r${i}` }, prev);
      entries.push(entry);
      prev = entry.entryHash;
    }
    return entries;
  }

  it("verifies an intact chain", () => {
    expect(verifyChain(buildChain(5)).valid).toBe(true);
  });

  it("starts from the genesis hash", () => {
    const [first] = buildChain(1);
    expect(first!.prevHash).toBe(GENESIS_HASH);
  });

  it("detects payload tampering mid-chain", () => {
    const chain = buildChain(5);
    chain[2] = { ...chain[2]!, payloadHash: sha256Hex("tampered") };
    const result = verifyChain(chain);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(2);
  });

  it("detects entry removal", () => {
    const chain = buildChain(5);
    chain.splice(1, 1);
    expect(verifyChain(chain).valid).toBe(false);
  });

  it("detects re-ordering", () => {
    const chain = buildChain(5);
    [chain[1], chain[2]] = [chain[2]!, chain[1]!];
    expect(verifyChain(chain).valid).toBe(false);
  });
});

describe("merkle", () => {
  const leaves = ["a", "b", "c", "d", "e"].map((s) => sha256Hex(s));

  it("root is deterministic", () => {
    expect(merkleRoot(leaves)).toBe(merkleRoot([...leaves]));
  });

  it("root changes when any leaf changes", () => {
    const altered = [...leaves];
    altered[3] = sha256Hex("x");
    expect(merkleRoot(altered)).not.toBe(merkleRoot(leaves));
  });

  it("inclusion proofs verify for every leaf", () => {
    const root = merkleRoot(leaves);
    for (let i = 0; i < leaves.length; i++) {
      const proof = merkleProof(leaves, i);
      expect(verifyMerkleProof(leaves[i]!, proof, root)).toBe(true);
    }
  });

  it("proof fails for the wrong leaf", () => {
    const root = merkleRoot(leaves);
    const proof = merkleProof(leaves, 1);
    expect(verifyMerkleProof(sha256Hex("not-a-leaf"), proof, root)).toBe(false);
  });
});
