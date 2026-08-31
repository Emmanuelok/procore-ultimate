import { describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import {
  assessPassword,
  hashPassword,
  needsRehash,
  passwordHashCost,
  PASSWORD_HASH_COST_FLOOR,
  PASSWORD_MIN_LENGTH,
  verifyPassword,
} from "./password.js";
import { evaluateLockout, progressiveDelayMs } from "./lockout.js";
import { mintToken, hashToken, timingSafeEqualHex } from "./tokens.js";

/**
 * The arithmetic, without a database.
 *
 * Policy, work factor and lockout are pure functions precisely so that their
 * boundaries can be tested at the boundary — 4 failures versus 5, the
 * millisecond before a lock lapses versus the millisecond after — instead of
 * being approximated by sleeping in an integration test.
 */

describe("password policy", () => {
  it("refuses a password shorter than the floor, and states the floor", () => {
    const result = assessPassword("Sh0rt-pass");
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toContain(String(PASSWORD_MIN_LENGTH));
  });

  it("accepts a long, unremarkable passphrase", () => {
    expect(assessPassword("scaffold-tower-brick").ok).toBe(true);
  });

  it("refuses the most common passwords even when they are long enough", () => {
    for (const weak of ["123456789012", "abcdefghijkl", "password1234", "welcome123"]) {
      const result = assessPassword(weak);
      expect(result.ok, weak).toBe(false);
      expect(result.reasons.some((r) => r.includes("commonly used"))).toBe(true);
    }
  });

  it("matches the common list exactly, not as a substring", () => {
    // "password" is refused; a passphrase that merely CONTAINS it is not —
    // a substring rule rejects strong passwords and trains people to pick
    // worse ones.
    expect(assessPassword("password").ok).toBe(false);
    expect(assessPassword("horse-password-staple").ok).toBe(true);
  });

  it("refuses a password containing the email local part, in any case", () => {
    const result = assessPassword("Jane.Doe-2026-site", { email: "jane.doe@acme.test" });
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("email address"))).toBe(true);
  });

  it("ignores a local part too short to be distinctive", () => {
    // "ann" would otherwise ban every password containing those three letters.
    expect(assessPassword("annualscaffolding", { email: "ann@acme.test" }).ok).toBe(true);
  });

  it("returns every reason at once rather than one per round trip", () => {
    const result = assessPassword("password", { email: "password@acme.test" });
    expect(result.ok).toBe(false);
    expect(result.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it("refuses the account holder's own name", () => {
    expect(assessPassword("marcusbrightwell", { name: "Marcus Brightwell" }).ok).toBe(false);
  });
});

describe("work factor", () => {
  it("caps the cost under test and floors it everywhere else", () => {
    expect(passwordHashCost({ BCRYPT_COST: 10, NODE_ENV: "test" })).toBe(10);
    expect(passwordHashCost({ BCRYPT_COST: 14, NODE_ENV: "test" })).toBe(10);
    expect(passwordHashCost({ BCRYPT_COST: 10, NODE_ENV: "production" })).toBe(
      PASSWORD_HASH_COST_FLOOR,
    );
    expect(passwordHashCost({ BCRYPT_COST: 14, NODE_ENV: "production" })).toBe(14);
  });

  it("marks a hash written at an older cost for rehashing, and a current one not", async () => {
    const old = await bcrypt.hash("scaffold-tower-brick", 6);
    expect(needsRehash(old, 10)).toBe(true);
    const current = await hashPassword({ BCRYPT_COST: 10, NODE_ENV: "test" }, "scaffold-tower-brick");
    expect(needsRehash(current, 10)).toBe(false);
  });

  it("never treats an unparseable hash as upgradeable, and never throws on one", async () => {
    // SSO-provisioned accounts store `sso-only:<id>` so no password can match.
    expect(needsRehash("sso-only:u_123", 12)).toBe(false);
    expect(await verifyPassword("anything-at-all", "sso-only:u_123")).toBe(false);
  });
});

describe("single-use tokens", () => {
  it("mints 256 bits, stores only the digest, and keeps a usable prefix", () => {
    const token = mintToken();
    expect(token.raw.length).toBeGreaterThanOrEqual(40);
    expect(token.hash).toHaveLength(64);
    expect(token.hash).not.toContain(token.raw);
    expect(token.raw.startsWith(token.prefix)).toBe(true);
    expect(hashToken(token.raw)).toBe(token.hash);
  });

  it("compares digests in constant time, and survives a length mismatch", () => {
    const a = hashToken("one");
    expect(timingSafeEqualHex(a, a)).toBe(true);
    expect(timingSafeEqualHex(a, hashToken("two"))).toBe(false);
    expect(timingSafeEqualHex(a, "short")).toBe(false);
  });
});

describe("lockout arithmetic", () => {
  const policy = { maxAttempts: 5, windowMs: 15 * 60_000, lockoutMs: 15 * 60_000 };
  const now = Date.UTC(2026, 7, 31, 12, 0, 0);
  const failuresAt = (...offsets: number[]) =>
    offsets.map((o) => ({ kind: "login_failure", at: new Date(now + o).toISOString() }));

  it("does not lock at the threshold minus one", () => {
    const events = failuresAt(-4000, -3000, -2000, -1000); // 4 failures
    const state = evaluateLockout(events.reverse(), policy, now);
    expect(state.locked).toBe(false);
    expect(state.failures).toBe(4);
  });

  it("locks exactly at the threshold", () => {
    const events = failuresAt(-5000, -4000, -3000, -2000, -1000);
    const state = evaluateLockout(events.reverse(), policy, now);
    expect(state.locked).toBe(true);
    expect(state.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("is still locked one millisecond before the lock expires, and free at it", () => {
    const last = now - policy.lockoutMs + 1;
    const events = [
      { kind: "login_failure", at: new Date(last).toISOString() },
      { kind: "login_failure", at: new Date(last - 1000).toISOString() },
      { kind: "login_failure", at: new Date(last - 2000).toISOString() },
      { kind: "login_failure", at: new Date(last - 3000).toISOString() },
      { kind: "login_failure", at: new Date(last - 4000).toISOString() },
    ];
    expect(evaluateLockout(events, policy, now).locked).toBe(true);
    expect(evaluateLockout(events, policy, now + 1).locked).toBe(false);
  });

  it("spends the failures that armed a lapsed lock instead of re-locking instantly", () => {
    const long = { ...policy, windowMs: 60 * 60_000, lockoutMs: 60_000 };
    const base = now - 30 * 60_000;
    const events = [0, 1, 2, 3, 4]
      .map((i) => ({ kind: "login_failure", at: new Date(base + i * 1000).toISOString() }))
      .reverse();
    const state = evaluateLockout(events, long, now);
    expect(state.locked).toBe(false);
    expect(state.failures).toBe(0);
  });

  it("counts only failures since the last success when the scope resets", () => {
    const events = [
      { kind: "login_failure", at: new Date(now - 1000).toISOString() },
      { kind: "login_success", at: new Date(now - 2000).toISOString() },
      ...failuresAt(-3000, -4000, -5000, -6000, -7000),
    ];
    expect(evaluateLockout(events, policy, now).locked).toBe(false);
    // The IP scope does not reset on somebody's success — an attacker holds an
    // account of their own.
    expect(evaluateLockout(events, policy, now, { resetOnSuccess: false }).locked).toBe(true);
  });

  it("delays nothing for the first two failures, then doubles up to the cap", () => {
    expect(progressiveDelayMs(1, 250)).toBe(0);
    expect(progressiveDelayMs(2, 250)).toBe(0);
    expect(progressiveDelayMs(3, 250)).toBe(250);
    expect(progressiveDelayMs(4, 250)).toBe(500);
    expect(progressiveDelayMs(9, 250)).toBe(4000);
    // and nothing at all under test, so the suite is arithmetic, not sleeping
    expect(progressiveDelayMs(9, 0)).toBe(0);
  });
});
