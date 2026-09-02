import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  otpauthUri,
  secondsRemainingInStep,
  totpAt,
  totpForStep,
  totpStep,
  verifyTotp,
  type TotpParams,
} from "./totp.js";

/**
 * The published answers.
 *
 * RFC 4226 Appendix D and RFC 6238 Appendix B print what a correct
 * implementation must produce for named keys at named instants. They are the
 * only check that means anything here: a self-consistent round trip ("the code
 * I generated verifies against my own verifier") passes just as happily
 * against an implementation that is wrong twice in the same direction, and
 * would ship a second factor that no real authenticator app could satisfy.
 *
 * RFC 6238's own text is ambiguous about the seed for the SHA256 and SHA512
 * rows — the values in its table correspond to seeds extended to the hash's
 * block size, which is what every interoperable implementation uses and what
 * is reproduced below.
 */
const RFC4226_KEY = Buffer.from("12345678901234567890", "ascii");
const RFC6238_SHA1 = RFC4226_KEY;
const RFC6238_SHA256 = Buffer.from("12345678901234567890123456789012", "ascii");
const RFC6238_SHA512 = Buffer.from(
  "1234567890123456789012345678901234567890123456789012345678901234",
  "ascii",
);

describe("RFC 4226 — HOTP test vectors (Appendix D)", () => {
  const expected = [
    "755224",
    "287082",
    "359152",
    "969429",
    "338314",
    "254676",
    "287922",
    "162583",
    "399871",
    "520489",
  ];

  it("produces the published six-digit value for counters 0 through 9", () => {
    const actual = expected.map((_, counter) => hotp(RFC4226_KEY, counter, "SHA1", 6));
    expect(actual).toEqual(expected);
  });

  it("rejects a negative or fractional counter rather than producing digits", () => {
    expect(() => hotp(RFC4226_KEY, -1, "SHA1", 6)).toThrow(/non-negative/);
    expect(() => hotp(RFC4226_KEY, 1.5, "SHA1", 6)).toThrow(/non-negative/);
  });

  it("rejects a digit count outside 6-8", () => {
    expect(() => hotp(RFC4226_KEY, 0, "SHA1", 5)).toThrow(/between 6 and 8/);
    expect(() => hotp(RFC4226_KEY, 0, "SHA1", 9)).toThrow(/between 6 and 8/);
  });
});

describe("RFC 6238 — TOTP test vectors (Appendix B)", () => {
  const seconds = [59, 1_111_111_109, 1_111_111_111, 1_234_567_890, 2_000_000_000, 20_000_000_000];

  it("matches every SHA1 row", () => {
    const params: TotpParams = {
      secret: RFC6238_SHA1,
      algorithm: "SHA1",
      digits: 8,
      periodSeconds: 30,
    };
    expect(seconds.map((s) => totpAt(params, s * 1000))).toEqual([
      "94287082",
      "07081804",
      "14050471",
      "89005924",
      "69279037",
      "65353130",
    ]);
  });

  it("matches every SHA256 row", () => {
    const params: TotpParams = {
      secret: RFC6238_SHA256,
      algorithm: "SHA256",
      digits: 8,
      periodSeconds: 30,
    };
    expect(seconds.map((s) => totpAt(params, s * 1000))).toEqual([
      "46119246",
      "68084774",
      "67062674",
      "91819424",
      "90698825",
      "77737706",
    ]);
  });

  it("matches every SHA512 row", () => {
    const params: TotpParams = {
      secret: RFC6238_SHA512,
      algorithm: "SHA512",
      digits: 8,
      periodSeconds: 30,
    };
    expect(seconds.map((s) => totpAt(params, s * 1000))).toEqual([
      "90693936",
      "25091201",
      "99943326",
      "93441116",
      "38618901",
      "47863826",
    ]);
  });

  it("derives the counter as elapsed periods since the epoch (RFC 6238 §4.2)", () => {
    // T = 1 for the 59-second row at a 30-second step; the table prints that
    // value as 0000000000000001.
    expect(totpStep(59_000, 30)).toBe(1);
    expect(totpStep(1_111_111_109_000, 30)).toBe(0x023523ec);
    expect(totpStep(20_000_000_000_000, 30)).toBe(0x27bc86aa);
  });
});

describe("base32 (RFC 4648) — the wire form of a seed", () => {
  it("encodes the RFC key to its published base32 spelling", () => {
    expect(base32Encode(RFC4226_KEY)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  it("round-trips arbitrary bytes", () => {
    for (const len of [1, 2, 3, 4, 5, 10, 20, 32, 64]) {
      const bytes = Buffer.from(Array.from({ length: len }, (_, i) => (i * 37 + 11) % 256));
      expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    }
  });

  it("accepts the shapes a human retypes: lower case, spaces, dashes, padding", () => {
    const canonical = base32Encode(RFC4226_KEY);
    const mangled = `${canonical.toLowerCase().replace(/(.{4})/g, "$1 ").trim()}======`;
    expect(base32Decode(mangled).equals(RFC4226_KEY)).toBe(true);
  });

  it("throws on a character outside the alphabet instead of silently skipping it", () => {
    // Silently dropping "1" would decode to different bytes and produce six
    // digits nobody could explain.
    expect(() => base32Decode("GEZDGNBV1")).toThrow(/Invalid base32/);
    expect(() => base32Decode("   ")).toThrow(/empty/);
  });

  it("generates a 160-bit seed, distinct every time", () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(a)).toHaveLength(20);
    expect(a).not.toBe(b);
  });
});

describe("verifyTotp — window, replay and malformed input", () => {
  const params: TotpParams = {
    secret: base32Decode(generateTotpSecret()),
    algorithm: "SHA1",
    digits: 6,
    periodSeconds: 30,
  };
  const atMs = 1_700_000_000_000;
  const step = totpStep(atMs, 30);

  it("accepts the current step", () => {
    const result = verifyTotp(params, totpForStep(params, step), { atMs });
    expect(result.step).toBe(step);
    expect(result.reasons).toEqual([]);
  });

  it("accepts exactly one step either side — and no further", () => {
    expect(verifyTotp(params, totpForStep(params, step - 1), { atMs }).step).toBe(step - 1);
    expect(verifyTotp(params, totpForStep(params, step + 1), { atMs }).step).toBe(step + 1);

    const twoBack = verifyTotp(params, totpForStep(params, step - 2), { atMs });
    const twoOn = verifyTotp(params, totpForStep(params, step + 2), { atMs });
    expect(twoBack.step).toBeNull();
    expect(twoOn.step).toBeNull();
    expect(twoBack.reasons[0]).toMatch(/does not match/);
  });

  it("refuses a code at or below the replay high-water mark", () => {
    const code = totpForStep(params, step);
    // First presentation is accepted and would advance last_used_step.
    expect(verifyTotp(params, code, { atMs }).step).toBe(step);
    // Second presentation of the SAME code inside the SAME window is a replay.
    const replay = verifyTotp(params, code, { atMs, lastUsedStep: step });
    expect(replay.step).toBeNull();
    expect(replay.reasons[0]).toMatch(/already been used/);
  });

  it("still refuses an older step once a newer one has been spent", () => {
    // The high-water mark is a ceiling, not an equality test: a code captured
    // from the previous step must not become usable again.
    const previous = verifyTotp(params, totpForStep(params, step - 1), {
      atMs,
      lastUsedStep: step,
    });
    expect(previous.step).toBeNull();
    expect(previous.reasons[0]).toMatch(/already been used/);
    // …while the next step is still available.
    expect(verifyTotp(params, totpForStep(params, step + 1), { atMs, lastUsedStep: step }).step).toBe(
      step + 1,
    );
  });

  it("distinguishes a malformed code from a wrong one, with a reason for each", () => {
    expect(verifyTotp(params, "12345", { atMs }).reasons[0]).toMatch(/exactly 6 digits/);
    expect(verifyTotp(params, "abcdef", { atMs }).reasons[0]).toMatch(/exactly 6 digits/);
    expect(verifyTotp(params, "", { atMs }).reasons[0]).toMatch(/exactly 6 digits/);
    expect(verifyTotp(params, "1234567", { atMs }).reasons[0]).toMatch(/exactly 6 digits/);
  });

  it("tolerates the spaces an authenticator app shows between digit groups", () => {
    const code = totpForStep(params, step);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(verifyTotp(params, spaced, { atMs }).step).toBe(step);
  });

  it("never accepts a code produced from a different seed", () => {
    const other: TotpParams = { ...params, secret: base32Decode(generateTotpSecret()) };
    const result = verifyTotp(params, totpForStep(other, step), { atMs });
    expect(result.step).toBeNull();
  });
});

describe("provisioning", () => {
  it("builds an otpauth:// URI an authenticator app can read", () => {
    const uri = otpauthUri({
      issuer: "ConstructOS",
      account: "site.manager@example.com",
      secret: "GEZDGNBVGY3TQOJQ",
      algorithm: "SHA1",
      digits: 6,
      periodSeconds: 30,
    });
    expect(uri.startsWith("otpauth://totp/ConstructOS:site.manager%40example.com?")).toBe(true);
    const query = new URL(uri).searchParams;
    expect(query.get("secret")).toBe("GEZDGNBVGY3TQOJQ");
    expect(query.get("issuer")).toBe("ConstructOS");
    expect(query.get("algorithm")).toBe("SHA1");
    expect(query.get("digits")).toBe("6");
    expect(query.get("period")).toBe("30");
  });

  it("percent-encodes a label that would otherwise break the URI", () => {
    const uri = otpauthUri({
      issuer: "Acme / Sub Co",
      account: "a b@example.com",
      secret: "GEZDGNBV",
      algorithm: "SHA256",
      digits: 8,
      periodSeconds: 60,
    });
    expect(uri).toContain("Acme%20%2F%20Sub%20Co:a%20b%40example.com");
    expect(uri).not.toContain(" ");
  });

  it("reports how long the displayed code has left", () => {
    expect(secondsRemainingInStep(0, 30)).toBe(30);
    expect(secondsRemainingInStep(1_000, 30)).toBe(29);
    expect(secondsRemainingInStep(29_000, 30)).toBe(1);
    expect(secondsRemainingInStep(30_000, 30)).toBe(30);
  });
});
