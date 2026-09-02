import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * RFC 6238 (TOTP) on top of RFC 4226 (HOTP), implemented with node:crypto and
 * nothing else.
 *
 * WHY THIS FILE IS PURE
 * ---------------------
 * A second factor is worth exactly as much as the arithmetic underneath it,
 * and the arithmetic is unusual in that it has PUBLISHED ANSWERS. RFC 4226
 * Appendix D and RFC 6238 Appendix B print the digits a correct
 * implementation must produce for named keys at named instants. Those vectors
 * are the only way to know this code is right — a round-trip test ("the code
 * I generated verifies") passes just as happily against an implementation
 * that is wrong in the same direction twice, and would have shipped a factor
 * no real authenticator app could satisfy.
 *
 * So the whole of TOTP lives here, takes its clock as an argument, touches no
 * database and no config, and is checked against the RFC tables in
 * totp.test.ts. Everything stateful — seeds, lockouts, replay bookkeeping —
 * lives in service.ts on top of it.
 *
 * THREE THINGS THE RFC LEAVES TO THE IMPLEMENTER, DECIDED HERE
 * ------------------------------------------------------------
 * 1. Window. `verifyTotp` accepts exactly one step either side of the current
 *    one (three candidate codes at 30s each, so a ±30s clock skew is
 *    tolerated). Wider is a real weakening: every extra step multiplies the
 *    codes a blind guesser may hit.
 * 2. Replay. A code observed on the wire is valid for the rest of its step,
 *    so acceptance must be recorded. `lastUsedStep` is the high-water mark;
 *    any candidate step at or below it is refused as a replay even when the
 *    digits are correct. This is why the accepted STEP, not just a boolean,
 *    is part of the result.
 * 3. Comparison. Digits are compared with `timingSafeEqual` over the whole
 *    candidate window, and the scan does not short-circuit on a match, so
 *    neither the value nor the position of a match is inferable from how long
 *    the answer took.
 *
 * The result shape follows the platform's metrics discipline (see
 * modules/benchmarks/metrics.ts): when a code is not accepted the answer is
 * `step: null` plus a non-empty `reasons` array naming why, never a bare
 * false that a caller has to guess at.
 */

/** Hash functions an authenticator app may be provisioned with. */
export const TOTP_ALGORITHMS = ["SHA1", "SHA256", "SHA512"] as const;
export type TotpAlgorithm = (typeof TOTP_ALGORITHMS)[number];

export function isTotpAlgorithm(value: string): value is TotpAlgorithm {
  return (TOTP_ALGORITHMS as readonly string[]).includes(value);
}

/** The provisioning parameters a code must be checked against. */
export interface TotpParams {
  /** raw seed bytes (base32 is a transport encoding, not the key) */
  secret: Buffer;
  algorithm: TotpAlgorithm;
  digits: number;
  periodSeconds: number;
}

export interface TotpVerification {
  /** the accepted time step, or null when nothing was accepted */
  step: number | null;
  /** empty iff a step was accepted */
  reasons: string[];
}

/** Codes shorter than this are not worth generating; longer than 8 is not RFC. */
const MIN_DIGITS = 6;
const MAX_DIGITS = 8;

/* ------------------------------------------------------------------ */
/* Base32 (RFC 4648, no padding) — the wire form of a TOTP seed        */
/* ------------------------------------------------------------------ */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Decode base32, tolerating the shapes a human retypes: lower case, padding,
 * and the spaces authenticator apps insert every four characters. Throws on
 * anything that is not in the alphabet rather than silently skipping it — a
 * seed that decodes to the wrong bytes produces codes nobody can explain.
 */
export function base32Decode(input: string): Buffer {
  const cleaned = input.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (cleaned.length === 0) throw new Error("Base32 secret is empty");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`Invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh seed. 20 bytes = 160 bits, the RFC 4226 recommendation. */
export function generateTotpSecret(byteLength = 20): string {
  return base32Encode(randomBytes(byteLength));
}

/* ------------------------------------------------------------------ */
/* HOTP / TOTP                                                         */
/* ------------------------------------------------------------------ */

/**
 * RFC 4226 §5.3. The counter is a 64-bit big-endian integer; the dynamic
 * truncation offset comes from the low nibble of the last byte, and the high
 * bit of the selected word is masked off so the result is sign-agnostic
 * across languages.
 */
export function hotp(
  key: Buffer,
  counter: number,
  algorithm: TotpAlgorithm = "SHA1",
  digits = 6,
): string {
  if (!Number.isInteger(counter) || counter < 0) {
    throw new Error("HOTP counter must be a non-negative integer");
  }
  if (digits < MIN_DIGITS || digits > MAX_DIGITS) {
    throw new Error(`HOTP digits must be between ${MIN_DIGITS} and ${MAX_DIGITS}`);
  }
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(algorithm.toLowerCase(), key).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const truncated =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(truncated % 10 ** digits).padStart(digits, "0");
}

/** RFC 6238 §4.2 — the counter is elapsed periods since the Unix epoch. */
export function totpStep(atMs: number, periodSeconds: number): number {
  if (periodSeconds <= 0) throw new Error("TOTP period must be positive");
  return Math.floor(atMs / 1000 / periodSeconds);
}

/** The code an authenticator app displays at `atMs`. */
export function totpAt(params: TotpParams, atMs: number): string {
  return hotp(params.secret, totpStep(atMs, params.periodSeconds), params.algorithm, params.digits);
}

/** The code for an explicit step — used by the tests and by replay reasoning. */
export function totpForStep(params: TotpParams, step: number): string {
  return hotp(params.secret, step, params.algorithm, params.digits);
}

/** Seconds until the current step rolls over, for a "code expires in" hint. */
export function secondsRemainingInStep(atMs: number, periodSeconds: number): number {
  const elapsed = Math.floor(atMs / 1000) % periodSeconds;
  return periodSeconds - elapsed;
}

export interface VerifyTotpOptions {
  /** clock, injectable so the RFC vectors and the replay tests are exact */
  atMs?: number;
  /** steps accepted either side of the current one; the platform uses 1 */
  window?: number;
  /** high-water mark: any candidate step <= this is a replay */
  lastUsedStep?: number | null;
}

/** A candidate code must be exactly `digits` ASCII digits. */
function normalizeCode(raw: string): string {
  return raw.replace(/[\s-]/g, "");
}

function digitsOnly(value: string, digits: number): boolean {
  if (value.length !== digits) return false;
  for (const ch of value) {
    if (ch < "0" || ch > "9") return false;
  }
  return true;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Verify a submitted code against the seed.
 *
 * The scan runs every candidate step in the window even after a match, so the
 * duration of a rejection does not reveal how close the guess was. Replay is
 * checked AFTER the digits match, which is what makes a replay distinguishable
 * from a wrong code in the reasons — the caller needs that difference to
 * decide whether to count a failed attempt against the lockout budget.
 */
export function verifyTotp(
  params: TotpParams,
  submitted: string,
  options: VerifyTotpOptions = {},
): TotpVerification {
  const atMs = options.atMs ?? Date.now();
  const window = options.window ?? 1;
  const lastUsedStep = options.lastUsedStep ?? null;

  const code = normalizeCode(submitted);
  if (!digitsOnly(code, params.digits)) {
    return { step: null, reasons: [`Code must be exactly ${params.digits} digits.`] };
  }
  if (window < 0) return { step: null, reasons: ["Verification window must not be negative."] };

  const current = totpStep(atMs, params.periodSeconds);
  let matched: number | null = null;
  for (let offset = -window; offset <= window; offset += 1) {
    const step = current + offset;
    if (step < 0) continue;
    const expected = hotp(params.secret, step, params.algorithm, params.digits);
    // No early exit: every candidate is compared, so the time taken is the
    // same whether the first candidate matched, the last one did, or none.
    if (constantTimeEquals(expected, code) && matched === null) matched = step;
  }

  if (matched === null) {
    return { step: null, reasons: ["Code does not match this authenticator at the current time."] };
  }
  if (lastUsedStep !== null && matched <= lastUsedStep) {
    return {
      step: null,
      reasons: [
        "Code has already been used. Wait for the authenticator to show the next code.",
      ],
    };
  }
  return { step: matched, reasons: [] };
}

/* ------------------------------------------------------------------ */
/* Provisioning                                                        */
/* ------------------------------------------------------------------ */

export interface OtpAuthParams {
  /** the product name shown in the authenticator app */
  issuer: string;
  /** which account it is, normally the email address */
  account: string;
  /** base32 seed */
  secret: string;
  algorithm: TotpAlgorithm;
  digits: number;
  periodSeconds: number;
}

/**
 * The `otpauth://` URI every authenticator app understands.
 *
 * DELIBERATELY NOT A QR IMAGE. Rendering the QR is the client's job: adding a
 * QR encoder here would put a dependency in the API for a picture only a
 * browser ever looks at, and — worse — would mean the seed is rendered into a
 * bitmap the server could log or cache. The API returns the URI and the
 * individual parameters; the client draws it.
 */
export function otpauthUri(params: OtpAuthParams): string {
  const label = `${encodeURIComponent(params.issuer)}:${encodeURIComponent(params.account)}`;
  const query = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: params.algorithm,
    digits: String(params.digits),
    period: String(params.periodSeconds),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
