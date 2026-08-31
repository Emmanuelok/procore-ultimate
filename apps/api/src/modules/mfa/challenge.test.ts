import { describe, expect, it } from "vitest";
import {
  challengeEnvelope,
  mintChallengeToken,
  verifyChallengeToken,
} from "./challenge.js";
import {
  constantTimeEquals,
  deriveKey,
  generateRecoveryCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  keyId,
  KEY_PURPOSE,
  normalizeRecoveryCode,
  openSecret,
  sealSecret,
} from "./secrets.js";

const CONFIG = { AUTH_SECRET: "test-secret-test-secret-test-secret" };
const OTHER = { AUTH_SECRET: "a-completely-different-auth-secret-value" };

describe("TOTP seed encryption", () => {
  it("round-trips a seed through the AES-256-GCM envelope", () => {
    const key = deriveKey(CONFIG, KEY_PURPOSE.totpSeed);
    const sealed = sealSecret("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", key);
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain("GEZDGNBV");
    expect(openSecret(sealed, key)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  it("produces a different envelope every time (fresh IV), same plaintext", () => {
    const key = deriveKey(CONFIG, KEY_PURPOSE.totpSeed);
    const a = sealSecret("SEED", key);
    const b = sealSecret("SEED", key);
    expect(a).not.toBe(b);
    expect(openSecret(a, key)).toBe(openSecret(b, key));
  });

  it("throws on a tampered ciphertext rather than returning a plausible seed", () => {
    const key = deriveKey(CONFIG, KEY_PURPOSE.totpSeed);
    const sealed = sealSecret("GEZDGNBVGY3TQOJQ", key);
    const parts = sealed.split(".");
    const ct = Buffer.from(parts[3]!, "base64");
    ct[0] = ct[0]! ^ 0xff;
    const tampered = [parts[0], parts[1], parts[2], ct.toString("base64")].join(".");
    // GCM authenticates: a flipped bit is an exception, not six digits nobody
    // can explain.
    expect(() => openSecret(tampered, key)).toThrow();
  });

  it("refuses an envelope sealed under a different key", () => {
    const sealed = sealSecret("SEED", deriveKey(CONFIG, KEY_PURPOSE.totpSeed));
    expect(() => openSecret(sealed, deriveKey(OTHER, KEY_PURPOSE.totpSeed))).toThrow();
  });

  it("refuses a malformed envelope", () => {
    const key = deriveKey(CONFIG, KEY_PURPOSE.totpSeed);
    expect(() => openSecret("not-an-envelope", key)).toThrow(/Unrecognised/);
    expect(() => openSecret("v2.a.b.c", key)).toThrow(/Unrecognised/);
    expect(() => openSecret("v1.AAAA.BBBB.CCCC", key)).toThrow(/malformed IV or tag/);
  });

  it("derives a DIFFERENT key per purpose from the same material", () => {
    const seedKey = deriveKey(CONFIG, KEY_PURPOSE.totpSeed);
    const tokenKey = deriveKey(CONFIG, KEY_PURPOSE.challengeToken);
    expect(seedKey.equals(tokenKey)).toBe(false);
    // Purpose separation is load-bearing: a leak of one must not yield the
    // other. A seed sealed for storage must not open under the token key.
    expect(() => openSecret(sealSecret("SEED", seedKey), tokenKey)).toThrow();
  });

  it("labels the key without revealing it, and the label follows the key", () => {
    const a = keyId(deriveKey(CONFIG, KEY_PURPOSE.totpSeed));
    const again = keyId(deriveKey(CONFIG, KEY_PURPOSE.totpSeed));
    const other = keyId(deriveKey(OTHER, KEY_PURPOSE.totpSeed));
    expect(a).toBe(again);
    expect(a).not.toBe(other);
    expect(a.startsWith("v1:")).toBe(true);
    expect(a).not.toContain(CONFIG.AUTH_SECRET);
  });

  it("prefers SSO_ENCRYPTION_KEY over AUTH_SECRET when it is set", () => {
    const derived = deriveKey(
      { AUTH_SECRET: CONFIG.AUTH_SECRET, SSO_ENCRYPTION_KEY: "an-explicit-encryption-key" },
      KEY_PURPOSE.totpSeed,
    );
    expect(derived.equals(deriveKey(CONFIG, KEY_PURPOSE.totpSeed))).toBe(false);
  });
});

describe("recovery codes", () => {
  it("uses an alphabet with no transcription traps", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateRecoveryCode()).toMatch(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}(-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}){3}$/);
    }
  });

  it("normalises the way a person types a code off paper", () => {
    const code = "abcd-2345-EFGH-6789";
    expect(normalizeRecoveryCode(code)).toBe("ABCD2345EFGH6789");
    expect(normalizeRecoveryCode(" a b c d 2345efgh6789 ")).toBe("ABCD2345EFGH6789");
    expect(hashRecoveryCode(code)).toBe(hashRecoveryCode("ABCD 2345 EFGH 6789"));
  });

  it("hashes rather than stores, and the hash is not the code", () => {
    const code = generateRecoveryCode();
    const hash = hashRecoveryCode(code);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(normalizeRecoveryCode(code));
  });

  it("issues a batch with no duplicates", () => {
    const codes = generateRecoveryCodes(10);
    expect(codes).toHaveLength(10);
    expect(new Set(codes.map(normalizeRecoveryCode)).size).toBe(10);
  });

  it("compares in constant time and still gets the answer right", () => {
    expect(constantTimeEquals("abc", "abc")).toBe(true);
    expect(constantTimeEquals("abc", "abd")).toBe(false);
    expect(constantTimeEquals("abc", "abcd")).toBe(false);
    expect(constantTimeEquals("", "")).toBe(true);
  });
});

describe("challenge token", () => {
  it("mints and verifies, preserving the scope and the user", () => {
    const minted = mintChallengeToken(CONFIG, {
      userId: "u_123",
      scope: "verify",
      ttlMinutes: 10,
    });
    const verified = verifyChallengeToken(CONFIG, minted.token);
    expect(verified.reasons).toEqual([]);
    expect(verified.claims?.uid).toBe("u_123");
    expect(verified.claims?.scope).toBe("verify");
    expect(verified.claims?.pur).toBe("mfa_challenge");
  });

  it("is not a JWT and does not look like one", () => {
    const { token } = mintChallengeToken(CONFIG, { userId: "u_1", scope: "verify", ttlMinutes: 10 });
    // plugins/auth.ts hands the bearer value to jwtVerify, which parses the
    // first segment as a base64url JWT header. `mfachal_v1` is not one.
    expect(token.startsWith("mfachal_v1.")).toBe(true);
    expect(token.split(".")).toHaveLength(3);
  });

  it("rejects a token signed with different key material", () => {
    const { token } = mintChallengeToken(CONFIG, { userId: "u_1", scope: "verify", ttlMinutes: 10 });
    const verified = verifyChallengeToken(OTHER, token);
    expect(verified.claims).toBeNull();
    expect(verified.reasons[0]).toMatch(/signature is invalid/);
  });

  it("rejects a tampered payload — the scope cannot be upgraded in flight", () => {
    const { token } = mintChallengeToken(CONFIG, { userId: "u_1", scope: "verify", ttlMinutes: 10 });
    const [prefix, payload, mac] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    claims["uid"] = "u_someone_else";
    const forged = [
      prefix,
      Buffer.from(JSON.stringify(claims), "utf8").toString("base64url"),
      mac,
    ].join(".");
    expect(verifyChallengeToken(CONFIG, forged).claims).toBeNull();
  });

  it("expires, and says so", () => {
    const minted = mintChallengeToken(CONFIG, {
      userId: "u_1",
      scope: "verify",
      ttlMinutes: 10,
      atMs: 1_000_000,
    });
    expect(verifyChallengeToken(CONFIG, minted.token, { atMs: 1_000_000 + 9 * 60_000 }).claims)
      .not.toBeNull();
    const late = verifyChallengeToken(CONFIG, minted.token, { atMs: 1_000_000 + 11 * 60_000 });
    expect(late.claims).toBeNull();
    expect(late.reasons[0]).toMatch(/expired/);
  });

  it("rejects garbage without throwing", () => {
    for (const junk of ["", "abc", "a.b.c", "mfachal_v1.zzz.zzz", "mfachal_v1..", "x".repeat(500)]) {
      const verified = verifyChallengeToken(CONFIG, junk);
      expect(verified.claims).toBeNull();
      expect(verified.reasons.length).toBeGreaterThan(0);
    }
  });

  it("gives every challenge a distinct id so attempts can be correlated", () => {
    const a = mintChallengeToken(CONFIG, { userId: "u_1", scope: "verify", ttlMinutes: 10 });
    const b = mintChallengeToken(CONFIG, { userId: "u_1", scope: "verify", ttlMinutes: 10 });
    expect(a.claims.jti).not.toBe(b.claims.jti);
    expect(a.token).not.toBe(b.token);
  });

  it("describes an enrol challenge as enrolment-required and offers no recovery route", () => {
    const enrol = challengeEnvelope(
      mintChallengeToken(CONFIG, { userId: "u_1", scope: "enrol", ttlMinutes: 10 }),
    );
    expect(enrol.enrolmentRequired).toBe(true);
    expect(enrol.methods).toEqual(["totp"]);

    const verify = challengeEnvelope(
      mintChallengeToken(CONFIG, { userId: "u_1", scope: "verify", ttlMinutes: 10 }),
    );
    expect(verify.enrolmentRequired).toBe(false);
    expect(verify.methods).toEqual(["totp", "recovery_code"]);
    expect(verify.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
