import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import { sha256Hex } from "@constructos/ledger";

/**
 * The two reversible secrets and the one-way ones, kept apart on purpose.
 *
 * packages/db/src/schema/auth.ts states the rule this file implements: a TOTP
 * SEED cannot be hashed, because every challenge has to re-derive the expected
 * six digits from it, so it is held as AES-256-GCM ciphertext under a key that
 * lives in the environment and not in the database. A RECOVERY CODE has the
 * opposite property — it is only ever CHECKED — so it keeps the platform's
 * hash-only rule and is stored as a sha256 hex digest with the raw value shown
 * exactly once, at generation.
 *
 * KEY DERIVATION. HKDF-SHA256 over SSO_ENCRYPTION_KEY, falling back to
 * AUTH_SECRET, with a per-purpose `info` string. The purpose separation is not
 * decoration: the same input keying material also protects identity-provider
 * client secrets and signs MFA challenge tokens, and deriving each use from a
 * distinct info string means a weakness or a leak in one never yields the key
 * for another. Ciphertext records `secret_key_id` so a rotation is a
 * re-encrypt pass rather than an outage.
 *
 * ENVELOPE FORMAT. `v1.<iv>.<tag>.<ciphertext>`, each part base64. The version
 * prefix is what makes rotation and algorithm change possible later without
 * guessing at what an existing column holds.
 */

const ENVELOPE_VERSION = "v1";
const HKDF_SALT = Buffer.from("constructos/mfa/v1", "utf8");
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** What a derived key is for. One info string per purpose, never shared. */
export const KEY_PURPOSE = {
  /** encrypts `user_mfa.secret_ciphertext` */
  totpSeed: "constructos:mfa:totp-seed:v1",
  /** HMAC key for the short-lived MFA challenge token */
  challengeToken: "constructos:mfa:challenge-token:v1",
} as const;
export type KeyPurpose = (typeof KEY_PURPOSE)[keyof typeof KEY_PURPOSE];

export interface KeyMaterialConfig {
  AUTH_SECRET: string;
  SSO_ENCRYPTION_KEY?: string | undefined;
}

/**
 * The input keying material, and an honest note about what it defends.
 *
 * With SSO_ENCRYPTION_KEY set, a stolen database dump yields nothing: the key
 * is not in it. Unset, the key is derived from AUTH_SECRET, which still
 * defeats a dump on its own but NOT an attacker who also holds the JWT
 * secret — .env.example says so plainly and this repeats it where the code is.
 */
export function keyMaterial(config: KeyMaterialConfig): Buffer {
  const ikm = config.SSO_ENCRYPTION_KEY?.trim();
  return Buffer.from(ikm && ikm.length > 0 ? ikm : config.AUTH_SECRET, "utf8");
}

export function deriveKey(config: KeyMaterialConfig, purpose: KeyPurpose): Buffer {
  return Buffer.from(
    hkdfSync("sha256", keyMaterial(config), HKDF_SALT, Buffer.from(purpose, "utf8"), 32),
  );
}

/**
 * A stable, non-secret label for the key that produced a ciphertext. Truncated
 * sha256 of the derived key: enough to tell "this row was encrypted under the
 * key we are holding" from "this row predates a rotation", and useless to
 * anyone who reads it.
 */
export function keyId(key: Buffer): string {
  return `${ENVELOPE_VERSION}:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

export function sealSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENVELOPE_VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ct.toString("base64"),
  ].join(".");
}

/**
 * Open an envelope. Throws on ANY tampering — GCM authenticates the
 * ciphertext, so a flipped bit is an exception rather than a plausible-looking
 * wrong seed that would produce six digits nobody can explain.
 */
export function openSecret(envelope: string, key: Buffer): string {
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw new Error("Unrecognised secret envelope");
  }
  const iv = Buffer.from(parts[1]!, "base64");
  const tag = Buffer.from(parts[2]!, "base64");
  const ct = Buffer.from(parts[3]!, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("Secret envelope has a malformed IV or tag");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/* ------------------------------------------------------------------ */
/* Recovery codes                                                      */
/* ------------------------------------------------------------------ */

/**
 * Crockford-style alphabet with the characters people mistranscribe removed:
 * no I, L, O, U and no 0 or 1. A recovery code is read off paper under stress,
 * often by someone locked out of their own account, and "was that a zero or an
 * oh" is a support ticket the alphabet can simply prevent.
 */
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const RECOVERY_GROUPS = 4;
const RECOVERY_GROUP_SIZE = 4;

/** 16 characters from a 30-symbol alphabet ≈ 78 bits. */
export function generateRecoveryCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < RECOVERY_GROUPS; g += 1) {
    let group = "";
    for (let i = 0; i < RECOVERY_GROUP_SIZE; i += 1) {
      group += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    }
    groups.push(group);
  }
  return groups.join("-");
}

/**
 * Codes are compared after normalisation, so a user may type them with or
 * without the dashes, in either case, with stray spaces. The stored hash is
 * always of the normalised form.
 */
export function normalizeRecoveryCode(raw: string): string {
  return raw.replace(/[^0-9a-zA-Z]/g, "").toUpperCase();
}

export function hashRecoveryCode(raw: string): string {
  return sha256Hex(normalizeRecoveryCode(raw));
}

/** A distinct, non-colliding set. Duplicates inside one batch would make the
 *  "codes remaining" count lie, and the unique index on `code_hash` would
 *  reject the batch halfway through. */
export function generateRecoveryCodes(count: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  while (out.length < count) {
    const code = generateRecoveryCode();
    const normalized = normalizeRecoveryCode(code);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(code);
  }
  return out;
}

/** Constant-time string comparison for anything secret. */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
