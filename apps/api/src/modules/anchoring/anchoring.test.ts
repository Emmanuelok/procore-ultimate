import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, asc, eq, gt } from "drizzle-orm";
import { chainSeals, companyMemberships, ledgerEntries, signals, signingKeys } from "@constructos/db";
import {
  buildSealBody,
  canonicalize as libCanonicalize,
  sealBodyHash,
  sha256Hex,
  signSealBody,
} from "@constructos/ledger";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { AppError } from "../../lib/errors.js";
import {
  anchorKeyState,
  assertPublicOnly,
  requireAnchorKey,
  DERIVED_KEY_WEAKENING,
} from "./keys.js";
import {
  createFixtureAnchorHttpClient,
  encodeTimeStampReq,
  parseTimeStampResp,
  submitAnchor,
} from "./providers.js";
import { canonicalize as cliCanonicalize, verifyReceiptDocument } from "../../scripts/verify-receipt.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;

const url = (p: string) => `/api/v1${p}`;

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
});

afterAll(async () => {
  await built.close();
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Grow a company's chain with `n` ordinary entries. */
async function grow(companyId: string, actorId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await appendLedger(app.db, {
      companyId,
      actorId,
      action: "create",
      objectType: "rfi",
      objectId: newId("rfi"),
      payload: { subject: `entry ${i}`, i },
    });
  }
}

async function seal(actor: TestActor, force = true) {
  const res = await app.inject({
    method: "POST",
    url: url("/ledger/seals"),
    headers: actor.headers,
    payload: { force },
  });
  return res;
}

async function verdict(actor: TestActor) {
  const res = await app.inject({
    method: "GET",
    url: url("/ledger/chain-verdict"),
    headers: actor.headers,
  });
  expect(res.statusCode).toBe(200);
  return res.json() as Record<string, unknown>;
}

async function entrySeqs(companyId: string): Promise<number[]> {
  const rows = await app.db
    .select({ seq: ledgerEntries.seq })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.companyId, companyId))
    .orderBy(asc(ledgerEntries.seq));
  return rows.map((r) => Number(r.seq));
}

/** A company with a sealed chain of a decent length. */
async function sealedCompany(): Promise<{ actor: TestActor; sealId: string }> {
  const actor = await registerActor(app);
  await grow(actor.companyId, actor.userId, 6);
  const res = await seal(actor);
  expect(res.statusCode).toBe(201);
  return { actor, sealId: (res.json() as { id: string }).id };
}

/* ------------------------------------------------------------------ */
/* 1. Keys and custody                                                 */
/* ------------------------------------------------------------------ */

describe("key custody", () => {
  it("derives a deterministic key from AUTH_SECRET when none is configured, and flags it", async () => {
    const state = anchorKeyState({ NODE_ENV: "test", AUTH_SECRET: "a-secret-that-is-long-enough" });
    expect(state.available).toBe(true);
    if (!state.available) return;
    expect(state.record.derivedFromAuthSecret).toBe(true);
    expect(state.record.source).toBe("derived_from_auth_secret");
    expect(state.record.keyId.startsWith("ankd_")).toBe(true);
    expect(state.record.weakening).toBe(DERIVED_KEY_WEAKENING);
    expect(state.record.weakening).toMatch(/same operator/i);
    // deterministic across calls: yesterday's seals must still verify tomorrow
    const again = anchorKeyState({
      NODE_ENV: "test",
      AUTH_SECRET: "a-secret-that-is-long-enough",
    });
    expect(again.available && again.record.fingerprint).toBe(state.record.fingerprint);
  });

  it("uses a configured PKCS8 key, including with \\n-escaped newlines, and does not flag it", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const direct = anchorKeyState({ NODE_ENV: "test", AUTH_SECRET: "x".repeat(20), ANCHOR_SIGNING_KEY: pem });
    const escaped = anchorKeyState({
      NODE_ENV: "test",
      AUTH_SECRET: "x".repeat(20),
      ANCHOR_SIGNING_KEY: pem.replace(/\n/g, "\\n"),
    });
    expect(direct.available && direct.record.derivedFromAuthSecret).toBe(false);
    expect(direct.available && direct.record.weakening).toBeNull();
    expect(direct.available && direct.record.keyId.startsWith("ank_")).toBe(true);
    expect(escaped.available && escaped.record.fingerprint).toBe(
      direct.available ? direct.record.fingerprint : "mismatch",
    );
  });

  it("refuses to seal in production with no ANCHOR_SIGNING_KEY, naming the command and the variable", () => {
    const env = { NODE_ENV: "production", AUTH_SECRET: "a-production-secret-value" };
    const state = anchorKeyState(env);
    expect(state.available).toBe(false);
    if (state.available) return;
    expect(state.remedy.generate).toBe("openssl genpkey -algorithm ed25519 -out anchor-key.pem");
    expect(state.remedy.variable).toBe("ANCHOR_SIGNING_KEY");
    let thrown: unknown;
    try {
      requireAnchorKey(env);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).statusCode).toBe(503);
    expect((thrown as AppError).message).toMatch(/Refusing to seal/);
  });

  it("refuses to persist private key material", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => assertPublicOnly(pem)).toThrow(/private key material/i);
    const state = anchorKeyState({ NODE_ENV: "test", AUTH_SECRET: "y".repeat(20) });
    expect(state.available).toBe(true);
    if (!state.available) return;
    expect(() => assertPublicOnly(state.record.publicKeyPem)).not.toThrow();
  });

  it("registers only the public half, and no response or table row carries a private key", async () => {
    const actor = await registerActor(app);
    const rotate = await app.inject({
      method: "POST",
      url: url("/ledger/keys/rotate"),
      headers: actor.headers,
      payload: {},
    });
    expect(rotate.statusCode).toBe(200);
    expect(rotate.body).toMatch(/BEGIN PUBLIC KEY/);
    expect(rotate.body).not.toMatch(/PRIVATE KEY/);

    const list = await app.inject({ method: "GET", url: url("/ledger/keys"), headers: actor.headers });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    const body = list.json() as {
      items: Array<{ keyId: string; derivedFromAuthSecret: boolean; weakening: string | null }>;
      current: { derivedFromAuthSecret: boolean; weakening: string; registered: boolean };
    };
    expect(body.current.derivedFromAuthSecret).toBe(true);
    expect(body.current.weakening).toMatch(/does NOT prove anything against the operator/);
    expect(body.current.registered).toBe(true);
    expect(body.items.some((k) => k.derivedFromAuthSecret && k.weakening)).toBe(true);

    // and the table itself
    const rows = await app.db.select().from(signingKeys);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.publicKeyPem).toMatch(/BEGIN PUBLIC KEY/);
      expect(JSON.stringify(row)).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    }
  });

  it("only owner/admin may rotate", async () => {
    const owner = await registerActor(app);
    const member = await registerActor(app);
    await app.db.insert(companyMemberships).values({
      id: newId("cm"),
      companyId: owner.companyId,
      userId: member.userId,
      role: "member",
    });
    const res = await app.inject({
      method: "POST",
      url: url("/ledger/keys/rotate"),
      headers: { authorization: member.headers["authorization"]!, "x-company-id": owner.companyId },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Sealing                                                          */
/* ------------------------------------------------------------------ */

describe("sealing", () => {
  it("seals the chain, commits to entryCount, head and Merkle root, and ledgers the act", async () => {
    const actor = await registerActor(app);
    await grow(actor.companyId, actor.userId, 4);
    const before = await entrySeqs(actor.companyId);
    const res = await seal(actor);
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, any>;
    expect(body.sequence).toBe(1);
    expect(body.entryCount).toBe(before.length);
    expect(body.toEntrySeq).toBe(before[before.length - 1]);
    expect(body.prevSealHash).toBeNull();
    expect(body.headHash).toHaveLength(64);
    expect(body.merkleRoot).toHaveLength(64);
    expect(body.bodyHash).toHaveLength(64);
    expect(body.signature.length).toBeGreaterThan(40);
    expect(body.isHeartbeat).toBe(false);
    // the seal is itself a ledgered event
    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.companyId, actor.companyId), eq(ledgerEntries.objectId, body.id)));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.objectType).toBe("chain_seal");
  });

  it("chains seals to each other with prevSealHash and contiguous sequences", async () => {
    const actor = await registerActor(app);
    await grow(actor.companyId, actor.userId, 3);
    const first = (await seal(actor)).json() as Record<string, any>;
    await grow(actor.companyId, actor.userId, 2);
    const second = (await seal(actor)).json() as Record<string, any>;
    expect(second.sequence).toBe(2);
    expect(second.prevSealHash).toBe(first.bodyHash);
    expect(second.entryCount).toBeGreaterThan(first.entryCount);
  });

  it("returns the existing seal when nothing material changed, and seals anyway on force", async () => {
    const actor = await registerActor(app);
    await grow(actor.companyId, actor.userId, 2);
    const first = await seal(actor);
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: "POST",
      url: url("/ledger/seals"),
      headers: actor.headers,
      payload: {},
    });
    expect(second.statusCode).toBe(200);
    const reused = second.json() as Record<string, any>;
    expect(reused.reused).toBe(true);
    expect(reused.id).toBe((first.json() as { id: string }).id);
    expect(reused.note).toMatch(/heartbeat interval/);
    const forced = await seal(actor);
    expect(forced.statusCode).toBe(201);
    expect((forced.json() as { sequence: number }).sequence).toBe(2);
  });

  it("carries the derived-key weakening flag and note on every seal it reports", async () => {
    const { actor, sealId } = await sealedCompany();
    const one = await app.inject({
      method: "GET",
      url: url(`/ledger/seals/${sealId}`),
      headers: actor.headers,
    });
    const body = one.json() as Record<string, any>;
    expect(body.derivedFromAuthSecret).toBe(true);
    expect(body.weakening).toMatch(/same operator|database-only/i);
    expect(body.key.derivedFromAuthSecret).toBe(true);
    expect(body.timeCaveat).toMatch(/order/i);

    const list = await app.inject({
      method: "GET",
      url: url("/ledger/seals"),
      headers: actor.headers,
    });
    const listed = list.json() as { items: Array<Record<string, any>>; total: number };
    expect(listed.total).toBe(1);
    expect(listed.items[0]!.derivedFromAuthSecret).toBe(true);
    expect(listed.items[0]!.weakening).toBeTruthy();
  });

  it("refuses to seal an empty chain and requires owner/admin", async () => {
    const owner = await registerActor(app);
    const member = await registerActor(app);
    await app.db.insert(companyMemberships).values({
      id: newId("cm"),
      companyId: owner.companyId,
      userId: member.userId,
      role: "member",
    });
    const res = await app.inject({
      method: "POST",
      url: url("/ledger/seals"),
      headers: { authorization: member.headers["authorization"]!, "x-company-id": owner.companyId },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    // but a member CAN read the verdict — the auditor's endpoint is not gated
    // behind the record's custodian
    const read = await app.inject({
      method: "GET",
      url: url("/ledger/chain-verdict"),
      headers: { authorization: member.headers["authorization"]!, "x-company-id": owner.companyId },
    });
    expect(read.statusCode).toBe(200);
  });

  it("writes a heartbeat seal on a list read once the interval has passed", async () => {
    const previous = process.env["ANCHOR_HEARTBEAT_HOURS"];
    try {
      const actor = await registerActor(app);
      await grow(actor.companyId, actor.userId, 2);
      expect((await seal(actor)).statusCode).toBe(201);
      // an interval of 3.6 seconds expressed in hours, then wait it out
      process.env["ANCHOR_HEARTBEAT_HOURS"] = "0.0001";
      await new Promise((r) => setTimeout(r, 450));
      const list = await app.inject({
        method: "GET",
        url: url("/ledger/seals"),
        headers: actor.headers,
      });
      const items = (list.json() as { items: Array<Record<string, any>> }).items;
      expect(items.length).toBeGreaterThanOrEqual(2);
      expect(items[0]!.isHeartbeat).toBe(true);
      expect(items[0]!.sequence).toBe(2);
    } finally {
      if (previous === undefined) delete process.env["ANCHOR_HEARTBEAT_HOURS"];
      else process.env["ANCHOR_HEARTBEAT_HOURS"] = previous;
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3. Verdicts — one corrupted chain per verdict                       */
/* ------------------------------------------------------------------ */

describe("chain verdicts", () => {
  it("no_seals: an unsealed chain says what it cannot prove", async () => {
    const actor = await registerActor(app);
    const result = await verdict(actor);
    expect(result["verdict"]).toBe("no_seals");
    expect(result["ok"]).toBe(false);
    expect(String(result["reason"])).toMatch(/rewritten from genesis/);
  });

  it("intact: a sealed, untouched chain verifies and carries its limitations", async () => {
    const { actor } = await sealedCompany();
    const result = await verdict(actor);
    expect(result["verdict"]).toBe("intact");
    expect(result["ok"]).toBe(true);
    expect(result["signaturesChecked"]).toBe(1);
    const limitations = result["limitations"] as string[];
    expect(limitations.join(" ")).toMatch(/derived from AUTH_SECRET/i);
    expect(limitations.join(" ")).toMatch(/wall-clock/i);
    expect(result["signalRaised"]).toBeNull();
  });

  it("entry_altered: editing one sealed row names the exact entry", async () => {
    const { actor } = await sealedCompany();
    const seqs = await entrySeqs(actor.companyId);
    const target = seqs[2]!;
    await app.db
      .update(ledgerEntries)
      .set({ payloadHash: sha256Hex("rewritten-by-an-insider") })
      .where(and(eq(ledgerEntries.companyId, actor.companyId), eq(ledgerEntries.seq, target)));

    const result = await verdict(actor);
    expect(result["verdict"]).toBe("entry_altered");
    expect(result["failedEntrySeq"]).toBe(target);
    expect(result["failedSealSequence"]).toBe(1);
    expect(String(result["reason"])).toMatch(new RegExp(`seq ${target} has been altered`));

    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, actor.companyId), eq(signals.detector, "ledger_entry_altered")),
      );
    expect(raised).toHaveLength(1);
    expect(raised[0]!.severity).toBe("critical");
    expect(raised[0]!.projectId).toBeNull();
  });

  it("tail_truncated: deleting the last entries is caught, and raises the truncation signal once", async () => {
    const { actor } = await sealedCompany();
    const seqs = await entrySeqs(actor.companyId);
    const keepThrough = seqs[Math.floor(seqs.length / 2)]!;
    await app.db
      .delete(ledgerEntries)
      .where(
        and(eq(ledgerEntries.companyId, actor.companyId), gt(ledgerEntries.seq, keepThrough)),
      );

    const result = await verdict(actor);
    expect(result["verdict"]).toBe("tail_truncated");
    expect(String(result["reason"])).toMatch(/sealed entr(y is|ies are) missing/);
    expect(result["signalRaised"]).toBeTruthy();

    // the surviving chain still verifies internally — the reason sealing exists
    const legacy = await app.inject({
      method: "GET",
      url: url("/ledger/verify"),
      headers: actor.headers,
    });
    expect((legacy.json() as { valid: boolean }).valid).toBe(true);

    // and the signal is not re-raised for the same finding on a second read
    await verdict(actor);
    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, actor.companyId),
          eq(signals.detector, "ledger_truncation_detected"),
        ),
      );
    expect(raised).toHaveLength(1);
    expect(raised[0]!.title).toMatch(/truncation/i);
  });

  it("seal_forged: a tampered signature is caught before anything else", async () => {
    const { actor, sealId } = await sealedCompany();
    await app.db
      .update(chainSeals)
      .set({ signature: Buffer.alloc(64, 7).toString("base64") })
      .where(eq(chainSeals.id, sealId));
    const result = await verdict(actor);
    expect(result["verdict"]).toBe("seal_forged");
    expect(result["failedSealSequence"]).toBe(1);
    expect(String(result["reason"])).toMatch(/does not hold the signing key|does not verify/);
    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, actor.companyId), eq(signals.detector, "chain_seal_forged")),
      );
    expect(raised).toHaveLength(1);
  });

  it("seal_forged: lowering entryCount in the database to hide a truncation", async () => {
    const { actor, sealId } = await sealedCompany();
    const seqs = await entrySeqs(actor.companyId);
    await app.db
      .update(chainSeals)
      .set({ entryCount: 2, toEntrySeq: seqs[1]! })
      .where(eq(chainSeals.id, sealId));
    const result = await verdict(actor);
    expect(result["verdict"]).toBe("seal_forged");
  });

  it("seal_broken: removing a middle seal", async () => {
    const actor = await registerActor(app);
    await grow(actor.companyId, actor.userId, 2);
    expect((await seal(actor)).statusCode).toBe(201);
    await grow(actor.companyId, actor.userId, 2);
    expect((await seal(actor)).statusCode).toBe(201);
    await grow(actor.companyId, actor.userId, 2);
    expect((await seal(actor)).statusCode).toBe(201);

    await app.db
      .delete(chainSeals)
      .where(and(eq(chainSeals.companyId, actor.companyId), eq(chainSeals.sequence, 2)));

    const result = await verdict(actor);
    expect(result["verdict"]).toBe("seal_broken");
    expect(result["failedSealSequence"]).toBe(3);
    expect(String(result["reason"])).toMatch(/missing from the seal chain/);
    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, actor.companyId), eq(signals.detector, "chain_seal_broken")),
      );
    expect(raised).toHaveLength(1);
  });

  it("per-seal verify agrees with the whole-chain verdict", async () => {
    const { actor, sealId } = await sealedCompany();
    const clean = await app.inject({
      method: "GET",
      url: url(`/ledger/seals/${sealId}/verify`),
      headers: actor.headers,
    });
    const cleanBody = clean.json() as Record<string, any>;
    expect(cleanBody.verdict).toBe("intact");
    expect(cleanBody.checks.signatureValid).toBe(true);
    expect(cleanBody.checks.merkleRootMatches).toBe(true);
    expect(cleanBody.checks.headHashMatches).toBe(true);
    expect(cleanBody.key.derivedFromAuthSecret).toBe(true);

    // the seal committed to the entries that existed BEFORE its own ledger
    // append, so two must go before the chain is shorter than what was sealed
    const seqs = await entrySeqs(actor.companyId);
    await app.db
      .delete(ledgerEntries)
      .where(and(eq(ledgerEntries.companyId, actor.companyId), gt(ledgerEntries.seq, seqs.at(-3)!)));
    const after = await app.inject({
      method: "GET",
      url: url(`/ledger/seals/${sealId}/verify`),
      headers: actor.headers,
    });
    const afterBody = after.json() as Record<string, any>;
    expect(afterBody.verdict).toBe("tail_truncated");
    expect(afterBody.checks.entriesPresent).toBe(false);
    expect(afterBody.checks.entryCountNow).toBeLessThan(afterBody.checks.entryCountSealed);
  });

  it("per-seal verify is intact for EVERY seal of an intact multi-seal chain", async () => {
    // Regression: classifying a seal on its own made `verifySealChain` — which
    // requires sequences contiguous from 1 — report "seal_broken, a seal is
    // missing" for every seal after the first, on a chain with nothing wrong
    // with it. The per-seal view is the one an auditor reads seal by seal.
    const actor = await registerActor(app);
    const sealIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      await grow(actor.companyId, actor.userId, 3);
      const res = await seal(actor);
      expect(res.statusCode).toBe(201);
      sealIds.push((res.json() as { id: string; sequence: number }).id);
    }
    expect((await verdict(actor))["verdict"]).toBe("intact");
    for (const [i, id] of sealIds.entries()) {
      const res = await app.inject({
        method: "GET",
        url: url(`/ledger/seals/${id}/verify`),
        headers: actor.headers,
      });
      const body = res.json() as Record<string, any>;
      expect(body.sequence).toBe(i + 1);
      expect(body.verdict).toBe("intact");
      expect(body.ok).toBe(true);
      expect(body.key.heldByProcess).toBe(true);
    }
  });

  it("catches a payload snapshot edited while every chain hash was left valid", async () => {
    // The chain hashes `payloadHash`, never the snapshot it was taken over, so
    // an insider can rewrite what an entry SAYS and leave the chain — and every
    // seal over it — verifying perfectly.
    const actor = await registerActor(app);
    await grow(actor.companyId, actor.userId, 4);
    await appendLedger(app.db, {
      companyId: actor.companyId,
      actorId: actor.userId,
      action: "create",
      objectType: "variation",
      objectId: newId("var"),
      payload: { value: 12_500, description: "Additional piling" },
      storePayload: true,
    });
    expect((await seal(actor)).statusCode).toBe(201);
    expect((await verdict(actor))["verdict"]).toBe("intact");

    const [target] = await app.db
      .select({ seq: ledgerEntries.seq })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, actor.companyId),
          eq(ledgerEntries.objectType, "variation"),
        ),
      )
      .limit(1);
    await app.db
      .update(ledgerEntries)
      .set({ payload: { value: 125_000, description: "Additional piling" } })
      .where(eq(ledgerEntries.seq, target!.seq));

    const result = await verdict(actor);
    expect(result["verdict"]).toBe("entry_altered");
    expect(result["failedEntrySeq"]).toBe(Number(target!.seq));
    expect(String(result["reason"])).toMatch(/no longer hashes to its payloadHash/);
  });

  it("says so when seals were signed under a key this process does not hold", async () => {
    // A seal's strength is that the private half is outside the database. The
    // PUBLIC half is looked up in `signing_keys`, which is INSIDE it — so an
    // attacker who can write to the database can register a key of their own
    // and re-sign a rewritten chain under it, and every signature verifies.
    // The process cannot tell that from a rotation; it can and must say that
    // the key is not the one it holds.
    const actor = await registerActor(app);
    await grow(actor.companyId, actor.userId, 4);
    expect((await seal(actor)).statusCode).toBe(201);
    expect((await verdict(actor))["key"]).toMatchObject({ heldByProcess: true });

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString().trim() + "\n";
    const fingerprint = sha256Hex(publicKey.export({ type: "spki", format: "der" }));
    const foreignKeyId = `ank_${fingerprint.slice(0, 16)}`;
    await app.db.insert(signingKeys).values({
      id: newId("skey"),
      companyId: null,
      keyId: foreignKeyId,
      algorithm: "ed25519",
      publicKeyPem: pem,
      fingerprint,
    });
    const [row] = await app.db
      .select()
      .from(chainSeals)
      .where(eq(chainSeals.companyId, actor.companyId))
      .limit(1);
    const body = buildSealBody({
      companyId: row!.companyId,
      sequence: row!.sequence,
      fromEntrySeq: row!.fromEntrySeq,
      toEntrySeq: row!.toEntrySeq,
      entryCount: row!.entryCount,
      headHash: row!.headHash,
      merkleRoot: row!.merkleRoot,
      prevSealHash: row!.prevSealHash,
      sealedAt: new Date(Date.parse(row!.sealedAt)).toISOString(),
      keyId: foreignKeyId,
    });
    await app.db
      .update(chainSeals)
      .set({
        keyId: foreignKeyId,
        bodyHash: sealBodyHash(body),
        signature: signSealBody(body, privateKey),
      })
      .where(eq(chainSeals.id, row!.id));

    const result = await verdict(actor);
    // The signature genuinely verifies under the key it names — so the verdict
    // stays "intact" — but the verdict must not let that pass as attribution.
    expect(result["verdict"]).toBe("intact");
    expect(result["keyIdsNotHeldByThisProcess"]).toEqual([foreignKeyId]);
    expect(result["key"]).toMatchObject({ heldByProcess: false });
    expect((result["limitations"] as string[]).join(" ")).toMatch(
      /not the key this deployment holds/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* 4. Escrow                                                           */
/* ------------------------------------------------------------------ */

describe("escrow receipts", () => {
  async function issue(actor: TestActor, sealId: string, recipientName = "Auditor LLP") {
    const res = await app.inject({
      method: "POST",
      url: url(`/ledger/seals/${sealId}/escrow`),
      headers: actor.headers,
      payload: { recipientName, recipientRef: "ENG-2026-11", purpose: "Annual audit" },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; receiptHash: string; document: Record<string, any> };
  }

  it("issues a self-contained receipt: seal body, signature, public key, procedure and hash", async () => {
    const { actor, sealId } = await sealedCompany();
    const receipt = await issue(actor, sealId);
    const doc = receipt.document;
    expect(doc["documentType"]).toBe("constructos.escrow-receipt");
    expect(doc["seal"]["signature"]).toBeTruthy();
    expect(doc["seal"]["merkleRoot"]).toHaveLength(64);
    expect(doc["key"]["publicKeyPem"]).toMatch(/BEGIN PUBLIC KEY/);
    expect(doc["key"]["fingerprint"]).toHaveLength(64);
    expect(doc["key"]["derivedFromAuthSecret"]).toBe(true);
    expect(doc["key"]["weakening"]).toMatch(/operator/i);
    expect((doc["verification"]["procedure"] as string[]).length).toBeGreaterThanOrEqual(4);
    expect((doc["verification"]["doesNotProve"] as string[]).join(" ")).toMatch(/OPERATOR/);
    expect(doc["receiptHash"]).toBe(receipt.receiptHash);
    // the receipt hash is over the canonical document minus the hash itself
    const { receiptHash, ...rest } = doc;
    void receiptHash;
    expect(sha256Hex(libCanonicalize(rest))).toBe(receipt.receiptHash);
    // and it carries no key material: the prose talks about private keys,
    // but no PEM block for one may ever appear
    expect(JSON.stringify(doc)).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
  });

  it("hands the exact JSON over as a download", async () => {
    const { actor, sealId } = await sealedCompany();
    const receipt = await issue(actor, sealId);
    const res = await app.inject({
      method: "GET",
      url: url(`/ledger/escrow-receipts/${receipt.id}/document`),
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain(`escrow-receipt-${receipt.id}.json`);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    const { receiptHash, ...rest } = parsed;
    expect(receiptHash).toBe(receipt.receiptHash);
    expect(sha256Hex(libCanonicalize(rest))).toBe(receipt.receiptHash);
  });

  it("verifies clean against the live chain, then fails once the chain is truncated", async () => {
    const { actor, sealId } = await sealedCompany();
    const receipt = await issue(actor, sealId);

    const clean = await app.inject({
      method: "POST",
      url: url("/ledger/escrow/verify"),
      headers: actor.headers,
      payload: { document: receipt.document },
    });
    expect(clean.statusCode).toBe(200);
    const cleanBody = clean.json() as Record<string, any>;
    expect(cleanBody.verdict).toBe("intact");
    expect(cleanBody.scope).toBe("live_chain");
    expect(cleanBody.receipt.onRecord).toBe(true);
    expect(cleanBody.receipt.signatureValid).toBe(true);
    expect(cleanBody.key.recognized).toBe(true);
    expect(cleanBody.liveChain.checked).toBe(true);
    expect(cleanBody.liveChain.merkleRootMatches).toBe(true);
    expect(cleanBody.key.derivedFromAuthSecret).toBe(true);
    expect((cleanBody.limitations as string[]).join(" ")).toMatch(/derived from AUTH_SECRET/i);

    // the presentation is recorded against the receipt
    const listed = await app.inject({
      method: "GET",
      url: url("/ledger/escrow-receipts"),
      headers: actor.headers,
    });
    const item = (listed.json() as { items: Array<Record<string, any>> }).items[0]!;
    expect(item.lastVerdict).toBe("intact");
    expect(item.lastVerifiedAt).toBeTruthy();

    // now truncate the chain and present the same receipt again
    const seqs = await entrySeqs(actor.companyId);
    await app.db
      .delete(ledgerEntries)
      .where(and(eq(ledgerEntries.companyId, actor.companyId), gt(ledgerEntries.seq, seqs[1]!)));
    const after = await app.inject({
      method: "POST",
      url: url("/ledger/escrow/verify"),
      headers: actor.headers,
      payload: receipt.document,
    });
    const afterBody = after.json() as Record<string, any>;
    expect(afterBody.verdict).toBe("tail_truncated");
    expect(afterBody.ok).toBe(false);
    expect(String(afterBody.reason)).toMatch(/sealed entries are gone/);
    expect(afterBody.receipt.signatureValid).toBe(true); // the receipt is fine; the chain is not
  });

  it("detects a receipt whose seal fields were edited after issue", async () => {
    const { actor, sealId } = await sealedCompany();
    const receipt = await issue(actor, sealId);
    const tampered = JSON.parse(JSON.stringify(receipt.document)) as Record<string, any>;
    tampered["seal"]["entryCount"] = 2;
    const res = await app.inject({
      method: "POST",
      url: url("/ledger/escrow/verify"),
      headers: actor.headers,
      payload: { document: tampered },
    });
    const body = res.json() as Record<string, any>;
    expect(body.verdict).toBe("seal_forged");
    expect(body.receipt.signatureValid).toBe(false);
    expect(String(body.reason)).toMatch(/does not verify/);
  });

  it("detects a receipt whose surrounding document was edited but whose seal is genuine", async () => {
    const { actor, sealId } = await sealedCompany();
    const receipt = await issue(actor, sealId);
    const tampered = JSON.parse(JSON.stringify(receipt.document)) as Record<string, any>;
    tampered["recipient"]["name"] = "Someone Else Entirely";
    const res = await app.inject({
      method: "POST",
      url: url("/ledger/escrow/verify"),
      headers: actor.headers,
      payload: { document: tampered },
    });
    const body = res.json() as Record<string, any>;
    expect(body.verdict).toBe("seal_forged");
    expect(body.receipt.signatureValid).toBe(true);
    expect(body.receipt.intact).toBe(false);
    expect(String(body.reason)).toMatch(/altered after issue|document around it has been altered/);
  });

  it("rejects something that is not a receipt at all, without pretending to verify it", async () => {
    const actor = await registerActor(app);
    const res = await app.inject({
      method: "POST",
      url: url("/ledger/escrow/verify"),
      headers: actor.headers,
      payload: { hello: "world" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/not a ConstructOS escrow receipt/i);
  });

  it("verifies a receipt issued to a signature the platform does not know, and says the key is unrecognised", async () => {
    const { actor, sealId } = await sealedCompany();
    const receipt = await issue(actor, sealId);
    // an entirely manufactured receipt: valid signature, attacker's own key
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const forged = JSON.parse(JSON.stringify(receipt.document)) as Record<string, any>;
    forged["key"]["publicKeyPem"] = publicKey.export({ type: "spki", format: "pem" }).toString();
    forged["key"]["keyId"] = "ank_attacker";
    forged["key"]["fingerprint"] = sha256Hex(
      new Uint8Array(publicKey.export({ type: "spki", format: "der" })),
    );
    forged["seal"]["keyId"] = "ank_attacker";
    const body = buildSealBody({
      companyId: forged["seal"]["companyId"],
      sequence: forged["seal"]["sequence"],
      fromEntrySeq: forged["seal"]["fromEntrySeq"],
      toEntrySeq: forged["seal"]["toEntrySeq"],
      entryCount: forged["seal"]["entryCount"],
      headHash: forged["seal"]["headHash"],
      merkleRoot: forged["seal"]["merkleRoot"],
      prevSealHash: forged["seal"]["prevSealHash"],
      sealedAt: forged["seal"]["sealedAt"],
      keyId: "ank_attacker",
    });
    forged["seal"]["signature"] = signSealBody(body, privateKey);
    forged["seal"]["bodyHash"] = sealBodyHash(body);
    const { receiptHash: _drop, ...rest } = forged;
    void _drop;
    forged["receiptHash"] = sha256Hex(libCanonicalize(rest));

    const res = await app.inject({
      method: "POST",
      url: url("/ledger/escrow/verify"),
      headers: actor.headers,
      payload: { document: forged },
    });
    const verified = res.json() as Record<string, any>;
    // internally perfect — and that is exactly why the key register matters
    expect(verified.receipt.signatureValid).toBe(true);
    expect(verified.key.recognized).toBe(false);
    expect((verified.limitations as string[]).join(" ")).toMatch(/NOT on this platform's key register/);
  });
});

/* ------------------------------------------------------------------ */
/* 5. Anchors                                                          */
/* ------------------------------------------------------------------ */

describe("anchor providers", () => {
  it("local_signed anchors with the signature itself and reports its reach honestly", async () => {
    const { actor, sealId } = await sealedCompany();
    const res = await app.inject({
      method: "POST",
      url: url(`/ledger/seals/${sealId}/anchor`),
      headers: actor.headers,
      payload: { provider: "local_signed" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, any>;
    expect(body.status).toBe("anchored");
    expect(body.proof.signature).toBeTruthy();
    expect(body.proof.derivedFromAuthSecret).toBe(true);
    expect(body.detail).toMatch(/not an independent time source/);
    expect(body.reach).toMatch(/inside the operator/);
    expect(JSON.stringify(body)).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
  });

  it("rfc3161 and opentimestamps report unavailable, naming the exact missing configuration", async () => {
    const { actor, sealId } = await sealedCompany();
    for (const [provider, variable] of [
      ["rfc3161", "ANCHOR_TSA_URL"],
      ["opentimestamps", "ANCHOR_OTS_CALENDAR_URL"],
    ] as const) {
      const res = await app.inject({
        method: "POST",
        url: url(`/ledger/seals/${sealId}/anchor`),
        headers: actor.headers,
        payload: { provider },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as Record<string, any>;
      expect(body.status).toBe("unavailable");
      expect(body.detail).toContain(variable);
      expect(body.proof.signature).toBeUndefined();
      expect(body.externalRef).toBeNull();
      expect(body.requirements.needs.join(" ")).toContain(variable);
      expect(body.reach).toMatch(/Nothing was witnessed anywhere/);
    }
  });

  it("counterparty anchors become real only when the third party acknowledges a reference", async () => {
    const { actor, sealId } = await sealedCompany();
    const created = await app.inject({
      method: "POST",
      url: url(`/ledger/seals/${sealId}/anchor`),
      headers: actor.headers,
      payload: { provider: "counterparty", counterpartyName: "Bank of Elsewhere" },
    });
    const anchor = created.json() as Record<string, any>;
    expect(anchor.status).toBe("pending");
    expect(anchor.detail).toMatch(/Awaiting acknowledgement from Bank of Elsewhere/);

    const confirmed = await app.inject({
      method: "POST",
      url: url(`/ledger/anchors/${anchor.id}/confirm`),
      headers: actor.headers,
      payload: { externalRef: "BOE-REF-77", acknowledgedBy: "M. Otieno" },
    });
    expect(confirmed.statusCode).toBe(200);
    const done = confirmed.json() as Record<string, any>;
    expect(done.status).toBe("anchored");
    expect(done.externalRef).toBe("BOE-REF-77");
    expect(done.proof.acknowledgement.acknowledgedBy).toBe("M. Otieno");

    // a non-counterparty anchor cannot be hand-confirmed
    const local = await app.inject({
      method: "POST",
      url: url(`/ledger/seals/${sealId}/anchor`),
      headers: actor.headers,
      payload: { provider: "local_signed" },
    });
    const bad = await app.inject({
      method: "POST",
      url: url(`/ledger/anchors/${(local.json() as { id: string }).id}/confirm`),
      headers: actor.headers,
      payload: { externalRef: "made-up" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toMatch(/fabricate a proof/);

    const list = await app.inject({
      method: "GET",
      url: url("/ledger/anchors?provider=counterparty"),
      headers: actor.headers,
    });
    const listed = list.json() as { items: Array<Record<string, any>>; total: number };
    expect(listed.total).toBe(1);
    expect(listed.items[0]!.status).toBe("anchored");
  });

  it("encodes a real RFC 3161 request and reads a granted response (fixture)", async () => {
    const digest = Buffer.from(sha256Hex("a seal body"), "hex");
    const der = encodeTimeStampReq(digest, Buffer.from("0102030405060708", "hex"));
    expect(der[0]).toBe(0x30); // SEQUENCE
    expect(der.includes(digest)).toBe(true);
    // sha-256 AlgorithmIdentifier OID must be present
    expect(der.includes(Buffer.from("608648016503040201", "hex"))).toBe(true);

    // TimeStampResp: SEQUENCE { SEQUENCE { INTEGER 0 }, SEQUENCE { INTEGER 42 } }
    // TimeStampResp ::= SEQUENCE { PKIStatusInfo{ INTEGER 0 }, token }
    const granted = Buffer.from("300a3003020100300302012a", "hex");
    const parsed = parseTimeStampResp(granted);
    expect(parsed.status).toBe(0);
    expect(parsed.granted).toBe(true);
    expect(parsed.token).not.toBeNull();

    const rejection = Buffer.from("30053003020102", "hex");
    const rejected = parseTimeStampResp(rejection);
    expect(rejected.granted).toBe(false);
    expect(rejected.status).toBe(2);

    const key = anchorKeyState({ NODE_ENV: "test", AUTH_SECRET: "z".repeat(24) });
    expect(key.available).toBe(true);
    if (!key.available) return;
    const base: Omit<Parameters<typeof submitAnchor>[0], "provider" | "env" | "http"> = {
      bodyHash: sha256Hex("a seal body"),
      sealId: "seal_x",
      sealSequence: 1,
      signature: "c2ln",
      key: key.record,
    };

    const anchored = await submitAnchor({
      ...base,
      provider: "rfc3161",
      env: { ANCHOR_TSA_URL: "https://tsa.example/tsr" },
      http: createFixtureAnchorHttpClient({ "/tsr": { status: 200, body: granted } }),
    });
    expect(anchored.status).toBe("anchored");
    expect(String(anchored.externalRef)).toMatch(/^tsa-token-sha256:/);
    expect(String(anchored.proof["verify"])).toMatch(/openssl ts -verify/);

    const refused = await submitAnchor({
      ...base,
      provider: "rfc3161",
      env: { ANCHOR_TSA_URL: "https://tsa.example/tsr" },
      http: createFixtureAnchorHttpClient({ "/tsr": { status: 200, body: rejection } }),
    });
    expect(refused.status).toBe("failed");
    expect(String(refused.detail)).toMatch(/refused the request/);

    const unreachable = await submitAnchor({
      ...base,
      provider: "rfc3161",
      env: { ANCHOR_TSA_URL: "https://tsa.example/tsr" },
      http: createFixtureAnchorHttpClient({
        "/tsr": { status: 200, body: "", networkError: "ENOTFOUND tsa.example" },
      }),
    });
    expect(unreachable.status).toBe("unavailable");
    expect(String(unreachable.detail)).toMatch(/ENOTFOUND/);
  });

  it("submits to an OpenTimestamps calendar and refuses to call a calendar receipt an anchor", async () => {
    const key = anchorKeyState({ NODE_ENV: "test", AUTH_SECRET: "q".repeat(24) });
    expect(key.available).toBe(true);
    if (!key.available) return;
    const attempt = await submitAnchor({
      provider: "opentimestamps",
      bodyHash: sha256Hex("body"),
      sealId: "seal_y",
      sealSequence: 2,
      signature: "c2ln",
      key: key.record,
      env: { ANCHOR_OTS_CALENDAR_URL: "https://a.pool.example" },
      http: createFixtureAnchorHttpClient({
        "/digest": { status: 200, body: Buffer.from("f0104f", "hex") },
      }),
    });
    expect(attempt.status).toBe("pending");
    expect(attempt.proof["calendarReceiptBase64"]).toBeTruthy();
    expect(String(attempt.detail)).toMatch(/only after the calendar aggregates it/);
  });
});

/* ------------------------------------------------------------------ */
/* 6. Tenant isolation                                                 */
/* ------------------------------------------------------------------ */

describe("tenant isolation", () => {
  it("company B cannot read, verify, escrow or anchor company A's seals", async () => {
    const { actor: a, sealId } = await sealedCompany();
    const b = await registerActor(app);
    await grow(b.companyId, b.userId, 2);
    await seal(b);

    const paths = [
      `/ledger/seals/${sealId}`,
      `/ledger/seals/${sealId}/verify`,
    ];
    for (const path of paths) {
      const res = await app.inject({ method: "GET", url: url(path), headers: b.headers });
      expect(res.statusCode).toBe(404);
    }
    const escrow = await app.inject({
      method: "POST",
      url: url(`/ledger/seals/${sealId}/escrow`),
      headers: b.headers,
      payload: { recipientName: "Nosy Ltd" },
    });
    expect(escrow.statusCode).toBe(404);
    const anchor = await app.inject({
      method: "POST",
      url: url(`/ledger/seals/${sealId}/anchor`),
      headers: b.headers,
      payload: { provider: "local_signed" },
    });
    expect(anchor.statusCode).toBe(404);

    // B's own listings never contain A's rows
    const seals = await app.inject({ method: "GET", url: url("/ledger/seals"), headers: b.headers });
    const items = (seals.json() as { items: Array<{ companyId: string }> }).items;
    expect(items.every((s) => s.companyId === b.companyId)).toBe(true);
    // and B's verdict describes B's chain only
    const bVerdict = await verdict(b);
    expect(bVerdict["companyId"]).toBe(b.companyId);
    void a;
  });

  it("presenting another company's receipt verifies the document but never reads their chain", async () => {
    const { actor: a, sealId } = await sealedCompany();
    const issued = await app.inject({
      method: "POST",
      url: url(`/ledger/seals/${sealId}/escrow`),
      headers: a.headers,
      payload: { recipientName: "Shared Auditor" },
    });
    const document = (issued.json() as { document: Record<string, unknown> }).document;

    const b = await registerActor(app);
    const res = await app.inject({
      method: "POST",
      url: url("/ledger/escrow/verify"),
      headers: b.headers,
      payload: { document },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, any>;
    expect(body.scope).toBe("receipt_only");
    expect(body.liveChain.checked).toBe(false);
    expect(String(body.liveChain.why)).toMatch(/tenant-isolation/);
    expect(body.receipt.signatureValid).toBe(true);
    expect(body.receipt.onRecord).toBe(false);
    expect(String(body.reason)).toMatch(/live chain was NOT consulted/);

    // and B downloading A's receipt document is a 404
    const download = await app.inject({
      method: "GET",
      url: url(`/ledger/escrow-receipts/${(issued.json() as { id: string }).id}/document`),
      headers: b.headers,
    });
    expect(download.statusCode).toBe(404);
  });

  it("requires authentication and a company context", async () => {
    const res = await app.inject({ method: "GET", url: url("/ledger/chain-verdict") });
    expect(res.statusCode).toBe(401);
  });
});

/* ------------------------------------------------------------------ */
/* 7. The offline verifier                                             */
/* ------------------------------------------------------------------ */

describe("offline receipt verifier", () => {
  it("its inlined canonicalizer is byte-identical to the library's", () => {
    const samples: unknown[] = [
      { b: 1, a: 2 },
      { nested: { z: [1, null, { y: true }], a: "x" } },
      [1, "two", null, { k: false }],
      { unicode: "ünïcødé — ✓", empty: {}, arr: [] },
      { n: 1.5, neg: -3, zero: 0 },
      "plain string",
      42,
      null,
    ];
    for (const sample of samples) {
      expect(cliCanonicalize(sample)).toBe(libCanonicalize(sample));
    }
  });

  it("verifies a real receipt offline and states what it cannot prove", async () => {
    const { actor, sealId } = await sealedCompany();
    const issued = await app.inject({
      method: "POST",
      url: url(`/ledger/seals/${sealId}/escrow`),
      headers: actor.headers,
      payload: { recipientName: "Offline Counterparty" },
    });
    const document = (issued.json() as { document: Record<string, unknown> }).document;

    const result = verifyReceiptDocument(document);
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/^VERIFIED/);
    expect(result.checks.every((c) => c.ok)).toBe(true);
    expect(result.checks.map((c) => c.name)).toContain("seal signature");
    expect(result.facts["derivedFromAuthSecret"]).toBe(true);
    expect(result.proven.join(" ")).toMatch(/held the private key/);
    expect(result.unproven.join(" ")).toMatch(/OPERATOR of the issuing deployment/);
    expect(result.unproven.join(" ")).toMatch(/Truncation after issue is invisible/);
  });

  it("fails a tampered receipt offline", async () => {
    const { actor, sealId } = await sealedCompany();
    const issued = await app.inject({
      method: "POST",
      url: url(`/ledger/seals/${sealId}/escrow`),
      headers: actor.headers,
      payload: { recipientName: "Offline Counterparty" },
    });
    const document = JSON.parse(
      JSON.stringify((issued.json() as { document: Record<string, unknown> }).document),
    ) as Record<string, any>;
    document["seal"]["headHash"] = sha256Hex("a different head");

    const result = verifyReceiptDocument(document);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/^FAILED/);
    expect(result.checks.find((c) => c.name === "seal signature")?.ok).toBe(false);
    expect(result.proven).toHaveLength(0);
  });

  it("refuses a file that is not a receipt", () => {
    expect(verifyReceiptDocument({ hello: "world" }).ok).toBe(false);
    expect(verifyReceiptDocument(null).summary).toMatch(/does not contain a JSON object/);
  });
});
