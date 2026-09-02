import { randomBytes, timingSafeEqual } from "node:crypto";
import { sha256Hex } from "@constructos/ledger";

/**
 * Single-use credentials: verification links, reset links, invitation links.
 *
 * THE RULE. The raw token exists in exactly two places — the response of the
 * call that minted it, and the message body composed from it. What is stored
 * is `sha256(raw)`. A database dump therefore yields nothing presentable, and
 * a lookup is a lookup BY HASH, so the query itself never compares secrets.
 *
 * 32 bytes of `randomBytes` is 256 bits. That is far beyond what an online
 * guessing attack could reach even without the rate limits in front of it,
 * which is what lets these tokens be sent by email at all.
 */

/** How much of the raw token is safe to keep for support identification. */
export const TOKEN_PREFIX_LENGTH = 8;

export interface MintedToken {
  /** shown once, never stored */
  raw: string;
  /** what goes in the table */
  hash: string;
  /** identification without capability — the `api_tokens` idiom */
  prefix: string;
}

export function mintToken(bytes = 32): MintedToken {
  const raw = randomBytes(bytes).toString("base64url");
  return { raw, hash: sha256Hex(raw), prefix: raw.slice(0, TOKEN_PREFIX_LENGTH) };
}

export function hashToken(raw: string): string {
  return sha256Hex(raw);
}

/**
 * Constant-time comparison of two hex digests.
 *
 * Lookups here are by unique index on the hash, so this is defence in depth
 * rather than the primary guard — but wherever application code does compare a
 * computed digest against a stored one, it compares in constant time. A
 * `===` on a secret leaks its prefix through the length of the loop.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    // Still spend a comparison so the mismatch length is not itself a signal.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}
