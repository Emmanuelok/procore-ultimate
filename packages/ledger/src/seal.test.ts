import { createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appendEntry } from "./chain.js";
import { canonicalize } from "./canonical.js";
import { hashPayload, sha256Hex } from "./hash.js";
import { merkleRoot } from "./merkle.js";
import {
  buildSealBody,
  classifyChain,
  sealBodyBytes,
  sealBodyHash,
  signSealBody,
  verifySealChain,
  verifySealSignature,
  type SealRecord,
  type SealedChainEntry,
} from "./seal.js";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const KEY_ID = "key_test";

/** A second, unrelated key — the "attacker signs with their own key" case. */
const other = generateKeyPairSync("ed25519");
const OTHER_PRIVATE_PEM = other.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const COMPANY = "co_1";

function buildEntries(n: number, from = 1): SealedChainEntry[] {
  const entries: SealedChainEntry[] = [];
  let prev: string | null = null;
  for (let i = 0; i < n; i++) {
    const chained = appendEntry(
      {
        companyId: COMPANY,
        actorId: "u1",
        action: "create",
        objectType: "rfi",
        objectId: `r${from + i}`,
        payloadHash: hashPayload({ n: from + i }),
        at: new Date(Date.UTC(2026, 0, 1, 0, 0, from + i)).toISOString(),
      },
      prev,
    );
    entries.push({ ...chained, seq: from + i });
    prev = chained.entryHash;
  }
  return entries;
}

/** Seal the first `count` entries as seal number `sequence`. */
function sealOver(
  entries: SealedChainEntry[],
  count: number,
  sequence: number,
  prevSealHash: string | null,
  opts: { privatePem?: string; sealedAt?: string } = {},
): SealRecord {
  const prefix = entries.slice(0, count);
  const head = prefix[prefix.length - 1]!;
  const body = buildSealBody({
    companyId: COMPANY,
    sequence,
    fromEntrySeq: prefix[0]!.seq,
    toEntrySeq: head.seq,
    entryCount: prefix.length,
    headHash: head.entryHash,
    merkleRoot: merkleRoot(prefix.map((e) => e.entryHash)),
    prevSealHash,
    sealedAt: opts.sealedAt ?? `2026-01-0${sequence}T00:00:00.000Z`,
    keyId: KEY_ID,
  });
  return {
    ...body,
    bodyHash: sealBodyHash(body),
    signature: signSealBody(body, opts.privatePem ?? PRIVATE_PEM),
    id: `sel_${sequence}`,
  };
}

/** Three seals over a 9-entry chain, at 3 / 6 / 9 entries. */
function sealedFixture() {
  const entries = buildEntries(9);
  const s1 = sealOver(entries, 3, 1, null);
  const s2 = sealOver(entries, 6, 2, s1.bodyHash);
  const s3 = sealOver(entries, 9, 3, s2.bodyHash);
  return { entries, seals: [s1, s2, s3] };
}

const keys = { [KEY_ID]: PUBLIC_PEM };

/* ------------------------------------------------------------------ */
/* Seal body                                                           */
/* ------------------------------------------------------------------ */

describe("buildSealBody", () => {
  const good = {
    companyId: COMPANY,
    sequence: 1,
    fromEntrySeq: 1,
    toEntrySeq: 3,
    entryCount: 3,
    headHash: sha256Hex("head"),
    merkleRoot: sha256Hex("root"),
    prevSealHash: null,
    sealedAt: "2026-01-01T00:00:00.000Z",
    keyId: KEY_ID,
  };

  it("produces the same canonical bytes regardless of key insertion order", () => {
    const a = buildSealBody(good);
    const b = buildSealBody({ keyId: KEY_ID, sealedAt: good.sealedAt, ...good });
    expect(sealBodyBytes(a)).toBe(sealBodyBytes(b));
    expect(sealBodyHash(a)).toBe(sealBodyHash(b));
  });

  it("canonicalizes with the shared helper (bytes reproducible by any verifier)", () => {
    const body = buildSealBody(good);
    expect(sealBodyBytes(body)).toBe(canonicalize(body));
    expect(sealBodyHash(body)).toBe(sha256Hex(canonicalize(body)));
  });

  it("defaults the algorithm to ed25519 and rejects any other", () => {
    expect(buildSealBody(good).algorithm).toBe("ed25519");
    expect(() => buildSealBody({ ...good, algorithm: "rsa" })).toThrow(/unsupported/i);
  });

  it("normalizes sealedAt so a database round-trip cannot change the signed bytes", () => {
    // exactly what Postgres/PGlite hands back for a timestamptz column
    const fromDb = buildSealBody({ ...good, sealedAt: "2026-01-01 00:00:00.000+00" });
    expect(fromDb.sealedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(sealBodyHash(fromDb)).toBe(sealBodyHash(buildSealBody(good)));
  });

  it("rejects malformed hashes, counts and timestamps", () => {
    expect(() => buildSealBody({ ...good, headHash: "nope" })).toThrow(/headHash/);
    expect(() => buildSealBody({ ...good, merkleRoot: "ABC" })).toThrow(/merkleRoot/);
    expect(() => buildSealBody({ ...good, entryCount: 0 })).toThrow(/entryCount/);
    expect(() => buildSealBody({ ...good, sequence: 0 })).toThrow(/sequence/);
    expect(() => buildSealBody({ ...good, sealedAt: "not-a-date" })).toThrow(/sealedAt/);
    expect(() => buildSealBody({ ...good, toEntrySeq: 0 })).toThrow(/toEntrySeq/);
  });
});

/* ------------------------------------------------------------------ */
/* Signing                                                             */
/* ------------------------------------------------------------------ */

describe("seal signatures", () => {
  const body = buildSealBody({
    companyId: COMPANY,
    sequence: 1,
    fromEntrySeq: 1,
    toEntrySeq: 3,
    entryCount: 3,
    headHash: sha256Hex("head"),
    merkleRoot: sha256Hex("root"),
    prevSealHash: null,
    sealedAt: "2026-01-01T00:00:00.000Z",
    keyId: KEY_ID,
  });

  it("round-trips sign → verify", () => {
    expect(verifySealSignature(body, signSealBody(body, PRIVATE_PEM), PUBLIC_PEM)).toBe(true);
  });

  it("accepts a KeyObject as well as a PEM", () => {
    const sig = signSealBody(body, createPrivateKey(PRIVATE_PEM));
    expect(verifySealSignature(body, sig, PUBLIC_PEM)).toBe(true);
  });

  it("fails when any field of the body changes", () => {
    const sig = signSealBody(body, PRIVATE_PEM);
    expect(verifySealSignature({ ...body, entryCount: 4 }, sig, PUBLIC_PEM)).toBe(false);
    expect(verifySealSignature({ ...body, sealedAt: "2026-01-02T00:00:00.000Z" }, sig, PUBLIC_PEM)).toBe(
      false,
    );
  });

  it("fails for a signature made with a different key", () => {
    const sig = signSealBody(body, OTHER_PRIVATE_PEM);
    expect(verifySealSignature(body, sig, PUBLIC_PEM)).toBe(false);
  });

  it("returns false rather than throwing on garbage input", () => {
    expect(verifySealSignature(body, "not-base64!!", PUBLIC_PEM)).toBe(false);
    expect(verifySealSignature(body, signSealBody(body, PRIVATE_PEM), "not-a-pem")).toBe(false);
  });

  it("verifies a key derived deterministically from a secret (the derived-key mode)", () => {
    const seed = Buffer.from(
      hkdfSync("sha256", Buffer.from("some-auth-secret"), Buffer.from("salt"), Buffer.from("info"), 32),
    );
    const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
    const derived = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    const derivedPub = createPublicKey(derived).export({ type: "spki", format: "pem" }).toString();
    expect(verifySealSignature(body, signSealBody(body, derived), derivedPub)).toBe(true);
    // and the derivation is deterministic: same secret, same key, same signature
    const again = createPrivateKey({
      key: Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        Buffer.from(
          hkdfSync(
            "sha256",
            Buffer.from("some-auth-secret"),
            Buffer.from("salt"),
            Buffer.from("info"),
            32,
          ),
        ),
      ]),
      format: "der",
      type: "pkcs8",
    });
    expect(signSealBody(body, again)).toBe(signSealBody(body, derived));
  });
});

/* ------------------------------------------------------------------ */
/* Seal chain                                                          */
/* ------------------------------------------------------------------ */

describe("verifySealChain", () => {
  it("accepts an empty set and a well-formed chain", () => {
    expect(verifySealChain([]).valid).toBe(true);
    expect(verifySealChain(sealedFixture().seals).valid).toBe(true);
  });

  it("is order-independent (sorts by sequence)", () => {
    const { seals } = sealedFixture();
    expect(verifySealChain([seals[2]!, seals[0]!, seals[1]!]).valid).toBe(true);
  });

  it("rejects a missing middle seal", () => {
    const { seals } = sealedFixture();
    const result = verifySealChain([seals[0]!, seals[2]!]);
    expect(result.valid).toBe(false);
    expect(result.brokenAtSequence).toBe(3);
  });

  it("rejects a relinked prevSealHash", () => {
    const { seals } = sealedFixture();
    const tampered = [seals[0]!, { ...seals[1]!, prevSealHash: sha256Hex("elsewhere") }, seals[2]!];
    const result = verifySealChain(tampered);
    expect(result.valid).toBe(false);
    expect(result.brokenAtSequence).toBe(2);
  });

  it("rejects a first seal that claims a predecessor", () => {
    const { seals } = sealedFixture();
    // recompute the stored bodyHash too, so the linkage rule is what fires
    const relinked = { ...seals[0]!, prevSealHash: sha256Hex("x") };
    relinked.bodyHash = sealBodyHash(buildSealBody(relinked));
    const result = verifySealChain([relinked]);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/no prevSealHash/);
  });

  it("rejects a stored bodyHash that does not match its own body", () => {
    const { seals } = sealedFixture();
    const result = verifySealChain([{ ...seals[0]!, bodyHash: sha256Hex("lie") }]);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/bodyHash/);
  });
});

/* ------------------------------------------------------------------ */
/* classifyChain — one deliberately corrupted fixture per verdict      */
/* ------------------------------------------------------------------ */

describe("classifyChain", () => {
  it("no_seals: an unsealed chain is honest about what it cannot prove", () => {
    const result = classifyChain({ seals: [], entries: buildEntries(4), publicKeys: keys });
    expect(result.verdict).toBe("no_seals");
    expect(result.ok).toBe(false);
    expect(result.entryCount).toBe(4);
    expect(result.reason).toMatch(/rewritten from genesis/);
  });

  it("intact: a sealed, untouched chain", () => {
    const { entries, seals } = sealedFixture();
    const result = classifyChain({ entries, seals, publicKeys: keys });
    expect(result.verdict).toBe("intact");
    expect(result.ok).toBe(true);
    expect(result.signaturesChecked).toBe(3);
    expect(result.sealedEntryCount).toBe(9);
    expect(result.failedSealSequence).toBeNull();
  });

  it("intact: entries appended after the newest seal are noted, not faulted", () => {
    const { entries, seals } = sealedFixture();
    const grown = [...entries];
    const extra = appendEntry(
      {
        companyId: COMPANY,
        actorId: "u1",
        action: "create",
        objectType: "rfi",
        objectId: "r10",
        payloadHash: hashPayload({ n: 10 }),
        at: "2026-01-01T00:00:10.000Z",
      },
      entries[entries.length - 1]!.entryHash,
    );
    grown.push({ ...extra, seq: 10 });
    const result = classifyChain({ entries: grown, seals, publicKeys: keys });
    expect(result.verdict).toBe("intact");
    expect(result.notes.join(" ")).toMatch(/newer than the last seal/);
  });

  it("tail_truncated: deleting the last entries is caught by entryCount", () => {
    const { entries, seals } = sealedFixture();
    const result = classifyChain({ entries: entries.slice(0, 6), seals, publicKeys: keys });
    expect(result.verdict).toBe("tail_truncated");
    expect(result.failedSealSequence).toBe(3);
    expect(result.reason).toMatch(/3 sealed entries are missing/);
    // the surviving prefix still verifies internally — the whole point
    expect(classifyChain({ entries: entries.slice(0, 6), seals: [], publicKeys: keys }).verdict).toBe(
      "no_seals",
    );
  });

  it("tail_truncated: cutting the tail and refilling it is caught by position", () => {
    const { entries, seals } = sealedFixture();
    // drop entries 7-9, append three fresh ones with new seq numbers
    const kept = entries.slice(0, 6);
    let prev = kept[kept.length - 1]!.entryHash;
    for (let i = 0; i < 3; i++) {
      const replacement = appendEntry(
        {
          companyId: COMPANY,
          actorId: "attacker",
          action: "create",
          objectType: "rfi",
          objectId: `fake${i}`,
          payloadHash: hashPayload({ fake: i }),
          at: "2026-02-01T00:00:00.000Z",
        },
        prev,
      );
      kept.push({ ...replacement, seq: 20 + i });
      prev = replacement.entryHash;
    }
    const result = classifyChain({ entries: kept, seals, publicKeys: keys });
    expect(result.verdict).toBe("tail_truncated");
    expect(result.failedSealSequence).toBe(3);
    expect(result.reason).toMatch(/cut and refilled/);
  });

  it("entry_altered: editing one row names the exact entry seq", () => {
    const { entries, seals } = sealedFixture();
    const tampered = [...entries];
    tampered[4] = { ...tampered[4]!, payloadHash: sha256Hex("rewritten") };
    const result = classifyChain({ entries: tampered, seals, publicKeys: keys });
    expect(result.verdict).toBe("entry_altered");
    expect(result.failedEntrySeq).toBe(5);
    expect(result.failedSealSequence).toBe(2);
    expect(result.reason).toMatch(/seq 5 has been altered/);
  });

  it("entry_altered: a wholesale rewrite from genesis is caught by the Merkle root", () => {
    const { seals } = sealedFixture();
    // An internally PERFECT chain of the same length with the same seq
    // numbers and different content — exactly what a database owner who
    // recomputes every hash from genesis produces. `verifyChain` is happy
    // with it; only the sealed Merkle root notices.
    const chain: SealedChainEntry[] = [];
    let prev: string | null = null;
    for (let i = 0; i < 9; i++) {
      const linked = appendEntry(
        {
          companyId: COMPANY,
          actorId: "u1",
          action: "create",
          objectType: "rfi",
          objectId: `rewritten${i}`,
          payloadHash: hashPayload({ rewritten: i }),
          at: new Date(Date.UTC(2026, 0, 1, 0, 0, i + 1)).toISOString(),
        },
        prev,
      );
      chain.push({ ...linked, seq: i + 1 });
      prev = linked.entryHash;
    }
    const result = classifyChain({ entries: chain, seals, publicKeys: keys });
    expect(result.verdict).toBe("entry_altered");
    expect(result.failedSealSequence).toBe(1);
    expect(result.reason).toMatch(/wholesale rewrite/);
  });

  it("seal_forged: a seal signed with the wrong key", () => {
    const { entries } = sealedFixture();
    const s1 = sealOver(entries, 3, 1, null);
    const forged = sealOver(entries, 6, 2, s1.bodyHash, { privatePem: OTHER_PRIVATE_PEM });
    const result = classifyChain({ entries, seals: [s1, forged], publicKeys: keys });
    expect(result.verdict).toBe("seal_forged");
    expect(result.failedSealSequence).toBe(2);
    expect(result.reason).toMatch(/does not hold the signing key/);
  });

  it("seal_forged: a seal body edited after signing (entryCount lowered to hide a truncation)", () => {
    const { entries, seals } = sealedFixture();
    const shrunk = { ...seals[2]!, entryCount: 6, toEntrySeq: 6 };
    const result = classifyChain({
      entries: entries.slice(0, 6),
      seals: [seals[0]!, seals[1]!, shrunk],
      publicKeys: keys,
    });
    expect(result.verdict).toBe("seal_forged");
    expect(result.failedSealSequence).toBe(3);
  });

  it("seal_broken: removing a middle seal", () => {
    const { entries, seals } = sealedFixture();
    const result = classifyChain({ entries, seals: [seals[0]!, seals[2]!], publicKeys: keys });
    expect(result.verdict).toBe("seal_broken");
    expect(result.failedSealSequence).toBe(3);
    expect(result.reason).toMatch(/missing from the seal chain/);
  });

  it("seal_broken: deleting the first seal so the chain no longer starts at 1", () => {
    const { entries, seals } = sealedFixture();
    const result = classifyChain({ entries, seals: [seals[1]!, seals[2]!], publicKeys: keys });
    expect(result.verdict).toBe("seal_broken");
  });

  it("reports seals it could not signature-check instead of silently passing them", () => {
    const { entries, seals } = sealedFixture();
    const result = classifyChain({ entries, seals, publicKeys: {} });
    expect(result.verdict).toBe("intact");
    expect(result.signaturesChecked).toBe(0);
    expect(result.unknownKeyIds).toEqual([KEY_ID]);
    expect(result.notes.join(" ")).toMatch(/could not be checked/);
  });

  it("catches a payload snapshot that no longer hashes to its payloadHash", () => {
    // The chain covers `payloadHash`, not the snapshot the hash was taken
    // over: rewrite the snapshot alone and every entry hash, every prevHash
    // link and every sealed Merkle root still verifies. Supplying `payload`
    // is what closes that.
    const { entries, seals } = sealedFixture();
    const honest = entries.map((e) => ({ ...e, payload: { n: e.seq } }));
    expect(classifyChain({ entries: honest, seals, publicKeys: keys }).verdict).toBe("intact");

    const doctored = honest.map((e, i) => (i === 2 ? { ...e, payload: { n: 9999 } } : e));
    const result = classifyChain({ entries: doctored, seals, publicKeys: keys });
    expect(result.verdict).toBe("entry_altered");
    expect(result.failedEntrySeq).toBe(doctored[2]!.seq);
    expect(result.reason).toMatch(/no longer hashes to its payloadHash/);

    // an entry that simply stored no snapshot is not a finding
    const unstored = honest.map((e, i) => (i === 2 ? { ...e, payload: null } : e));
    expect(classifyChain({ entries: unstored, seals, publicKeys: keys }).verdict).toBe("intact");
  });

  it("is input-order independent", () => {
    const { entries, seals } = sealedFixture();
    const shuffledEntries = [entries[3]!, entries[0]!, ...entries.slice(1, 3), ...entries.slice(4)];
    const result = classifyChain({
      entries: shuffledEntries,
      seals: [seals[2]!, seals[0]!, seals[1]!],
      publicKeys: keys,
    });
    expect(result.verdict).toBe("intact");
  });
});
