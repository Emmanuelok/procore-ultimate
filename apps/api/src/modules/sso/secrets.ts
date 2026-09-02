/**
 * The one secret on this platform that cannot be hashed.
 *
 * An OIDC client secret has to be replayed verbatim to the provider's token
 * endpoint on every single sign-in, so the SHA-256-and-forget idiom used for
 * refresh tokens, ingestion tokens and OAuth client secrets is unavailable
 * here. `packages/db/src/schema/auth.ts` sets out the compensating design and
 * this file implements it:
 *
 *   encrypted   AES-256-GCM, `v1.<iv>.<tag>.<ct>` (each part base64url), under
 *               a key derived with HKDF-SHA256 from SSO_ENCRYPTION_KEY, or
 *               from AUTH_SECRET when that is unset. A stolen database dump
 *               yields ciphertext; it does not yield a usable secret.
 *   reference   nothing secret is stored at all — `client_secret_ref` names an
 *               external holder (`env:OKTA_CLIENT_SECRET`) resolved per
 *               request. The strongest option, and the one a real deployment
 *               should take.
 *   none        a public client using PKCE, which has no secret. Recorded
 *               explicitly so "no secret" is never mistaken for "secret not
 *               configured yet".
 *
 * Nothing here ever returns a plaintext secret to an API caller. The only
 * value a caller can see is `clientSecretFingerprint`, which confirms a match
 * and reveals nothing: it is a truncated hash, and truncation is deliberate —
 * a full hash of a low-entropy secret is a dictionary attack waiting to
 * happen.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { sha256Hex } from "@constructos/ledger";
import type { Config } from "../../config.js";
import { badRequest } from "../../lib/errors.js";

const HKDF_SALT = "constructos/sso/v1";
const HKDF_INFO = "identity-provider-client-secret";
const ENVELOPE_VERSION = "v1";

export interface SsoKey {
  /** 32 raw bytes */
  bytes: Buffer;
  /** short, non-secret identifier so a rotation is visible in the row */
  keyId: string;
  /** which env var the key came from — named in operator-facing errors */
  source: "SSO_ENCRYPTION_KEY" | "AUTH_SECRET";
}

export function deriveSsoKey(config: Config): SsoKey {
  const source = config.SSO_ENCRYPTION_KEY ? "SSO_ENCRYPTION_KEY" : "AUTH_SECRET";
  const ikm = config.SSO_ENCRYPTION_KEY ?? config.AUTH_SECRET;
  const bytes = Buffer.from(
    hkdfSync("sha256", Buffer.from(ikm, "utf8"), Buffer.from(HKDF_SALT), Buffer.from(HKDF_INFO), 32),
  );
  return { bytes, keyId: `k1_${sha256Hex(bytes).slice(0, 12)}`, source };
}

export function encryptSecret(plaintext: string, key: SsoKey): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key.bytes, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENVELOPE_VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ct.toString("base64url"),
  ].join(".");
}

/**
 * Decrypt, or throw. There is no "best effort" here: a client secret that
 * decrypts to garbage would be sent to the provider's token endpoint, and the
 * resulting `invalid_client` is an unreadable symptom of a readable cause
 * (usually SSO_ENCRYPTION_KEY was rotated without re-encrypting).
 */
export function decryptSecret(envelope: string, key: SsoKey): string {
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw badRequest(
      "Stored client secret is not a recognised v1 envelope — it cannot be decrypted.",
    );
  }
  try {
    const iv = Buffer.from(parts[1]!, "base64url");
    const tag = Buffer.from(parts[2]!, "base64url");
    const ct = Buffer.from(parts[3]!, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key.bytes, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    throw badRequest(
      `Stored client secret failed authenticated decryption. It was encrypted under a different ` +
        `key — re-enter the client secret, or restore the ${key.source} value it was saved with.`,
    );
  }
}

/** Confirms a match; reveals nothing. Truncated on purpose — see the header. */
export function secretFingerprint(plaintext: string): string {
  return sha256Hex(plaintext).slice(0, 16);
}

/**
 * Constant-time string equality.
 *
 * `===` on secrets leaks their prefix through timing. Lengths are compared
 * first and unequal lengths short-circuit — that much is unavoidable and
 * uninteresting, since every secret compared here is a fixed-length hash or a
 * fixed-length random token.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface ResolvedClientSecret {
  /** null when the connection is a public PKCE client with no secret */
  secret: string | null;
  /** why there is no secret, when there is none and there should be one */
  reasons: string[];
}

/**
 * Produce the secret to present at the token endpoint, for whichever storage
 * mode the connection uses. A missing secret is NEVER guessed at or defaulted
 * to the empty string: it comes back null with the reason named, and the
 * caller refuses the sign-in rather than sending a blank credential and
 * reporting the provider's rejection as the user's fault.
 */
export function resolveClientSecret(
  provider: {
    secretStorage: string;
    clientSecretCiphertext: string | null;
    clientSecretRef: string | null;
  },
  key: SsoKey,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedClientSecret {
  if (provider.secretStorage === "none") return { secret: null, reasons: [] };

  if (provider.secretStorage === "reference") {
    const ref = provider.clientSecretRef;
    if (!ref) {
      return {
        secret: null,
        reasons: [
          "secretStorage is `reference` but clientSecretRef is empty — set it to `env:<VAR_NAME>`.",
        ],
      };
    }
    const [scheme, ...rest] = ref.split(":");
    const target = rest.join(":");
    if (scheme !== "env" || target === "") {
      return {
        secret: null,
        reasons: [
          `clientSecretRef "${scheme ?? ""}:…" is not resolvable by this deployment. ` +
            "Only `env:<VAR_NAME>` is supported; aws-sm: and vault: need a resolver this build " +
            "does not ship.",
        ],
      };
    }
    const value = env[target];
    if (!value) {
      return {
        secret: null,
        reasons: [`Environment variable ${target} is not set on the API process.`],
      };
    }
    return { secret: value, reasons: [] };
  }

  if (!provider.clientSecretCiphertext) {
    return {
      secret: null,
      reasons: [
        "No client secret is stored for this connection — PATCH the provider with `clientSecret`, " +
          "or set secretStorage to `none` if the provider is registered as a public PKCE client.",
      ],
    };
  }
  return { secret: decryptSecret(provider.clientSecretCiphertext, key), reasons: [] };
}
