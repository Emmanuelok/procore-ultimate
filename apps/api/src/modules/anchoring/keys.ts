/**
 * M1 — anchor key custody.
 *
 * A seal is worth exactly as much as the answer to one question: WHO COULD
 * HAVE MADE IT? The hash chain cannot answer it at all — anyone with database
 * write access can produce a perfect chain. A signature answers it only to the
 * extent that the private key is out of reach of the party whose record is
 * under scrutiny.
 *
 * This file therefore has one job and one duty of candour:
 *
 *   JOB    load an Ed25519 private key that lives in the process environment,
 *          never in the database, and expose ONLY its public half to callers
 *          and to the `signing_keys` table.
 *
 *   DUTY   when there is no configured key and we fall back to DERIVING one
 *          from AUTH_SECRET, say so — in the key record, in every response
 *          that reports the key, and in every verification result and escrow
 *          receipt produced under it. A key derived from AUTH_SECRET is held
 *          by the same operator that runs the application: it defeats a
 *          database-only attacker and it does NOT defeat the operator. That is
 *          a real, useful, and strictly weaker property, and hiding the
 *          difference would make the whole module a decoration.
 *
 * In production the fallback is refused outright: sealing returns 503 naming
 * the command that generates a key and the variable that carries it.
 */
import {
  createPrivateKey,
  createPublicKey,
  createHash,
  hkdfSync,
  type KeyObject,
} from "node:crypto";
import { and, eq, isNull, ne, or } from "drizzle-orm";
import { signingKeys } from "@constructos/db";
import { SEAL_ALGORITHM } from "@constructos/ledger";
import { AppError } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import type { Db } from "../../lib/db.js";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type AnchorKeySource = "env" | "derived_from_auth_secret";

/** Everything about a key that is safe to serialize. There is nothing else. */
export interface AnchorKeyRecord {
  keyId: string;
  algorithm: typeof SEAL_ALGORITHM;
  publicKeyPem: string;
  /** sha256 of the SPKI DER public key — the value to compare out of band */
  fingerprint: string;
  source: AnchorKeySource;
  /** true when the key was derived from AUTH_SECRET rather than configured */
  derivedFromAuthSecret: boolean;
  /** plain-English weakening note; null only for a properly configured key */
  weakening: string | null;
}

export interface AnchorSigningKey {
  record: AnchorKeyRecord;
  /**
   * The private half. Held in process memory only. It is deliberately NOT a
   * property of `record`, so that no route can serialize it by accident: every
   * response body is built from `record`.
   */
  privateKey: KeyObject;
}

export interface AnchorKeyUnavailable {
  available: false;
  /** why sealing cannot proceed — returned to the operator verbatim */
  reason: string;
  remedy: {
    generate: string;
    variable: string;
    format: string;
    note: string;
  };
}

export type AnchorKeyState = ({ available: true } & AnchorSigningKey) | AnchorKeyUnavailable;

export interface AnchorKeyEnv {
  NODE_ENV: string;
  AUTH_SECRET: string;
  /** PKCS8 PEM (newlines may be escaped as \n), or base64 of the PEM/DER */
  ANCHOR_SIGNING_KEY?: string | undefined;
  /**
   * Comma- or whitespace-separated SHA-256 fingerprints of the public keys a
   * verifier is willing to trust. See {@link trustAnchor}.
   */
  ANCHOR_TRUSTED_FINGERPRINTS?: string | undefined;
}

/* ------------------------------------------------------------------ */
/* The trust anchor                                                    */
/* ------------------------------------------------------------------ */

export interface TrustAnchor {
  /** true when the operator has pinned the keys out of band */
  pinned: boolean;
  /** normalized lowercase hex fingerprints, empty when unpinned */
  fingerprints: string[];
  /** where a verifier's trust comes from, in one word */
  source: "env" | "database";
  /** stated on every verdict when unpinned — this is the residual hole */
  note: string;
}

const UNPINNED_NOTE =
  "No trusted key fingerprints are pinned (ANCHOR_TRUSTED_FINGERPRINTS is unset), so signature " +
  "checking takes its trust anchor from `signing_keys` — a table inside the same database the " +
  "seal exists to police. Anyone able to write to this database can register a key of their own " +
  "and re-sign a rewritten chain under it, and the result will verify. Sealing therefore " +
  "defeats a database-only attacker who does not also register a key. Pin the fingerprints " +
  "out of band to close this: set ANCHOR_TRUSTED_FINGERPRINTS to the fingerprint(s) from " +
  "GET /api/v1/ledger/keys, held somewhere the database cannot reach.";

const PINNED_NOTE =
  "Trusted key fingerprints are pinned out of band, so a key registered in `signing_keys` by " +
  "anyone who did not also hold the pinned fingerprint cannot be used to verify a seal: seals " +
  "signed under an unpinned key are reported as forged rather than accepted.";

/** Normalize a fingerprint for comparison: lowercase hex, no colons or spaces. */
export function normalizeFingerprint(value: string): string {
  return value.trim().toLowerCase().replace(/[\s:]/g, "");
}

/**
 * Where signature verification takes its trust from.
 *
 * A seal's strength is that the PRIVATE half of its key is outside the
 * database. That only helps a verifier who already knows which PUBLIC key to
 * expect. Without a pin, the public half is read from `signing_keys` — inside
 * the database under attack — so an attacker with write access registers their
 * own key, re-signs a rewritten chain, and every signature verifies. Pinning
 * the fingerprints in the environment moves the trust anchor out of reach of
 * the store being policed, which is the only thing that actually closes it.
 */
export function trustAnchor(env: AnchorKeyEnv): TrustAnchor {
  const raw = env.ANCHOR_TRUSTED_FINGERPRINTS?.trim();
  if (!raw) {
    return { pinned: false, fingerprints: [], source: "database", note: UNPINNED_NOTE };
  }
  const fingerprints = Array.from(
    new Set(
      raw
        .split(/[,\s]+/)
        .map(normalizeFingerprint)
        .filter((f) => f.length > 0),
    ),
  );
  if (fingerprints.length === 0) {
    return { pinned: false, fingerprints: [], source: "database", note: UNPINNED_NOTE };
  }
  return { pinned: true, fingerprints, source: "env", note: PINNED_NOTE };
}

/** True when this fingerprint is one the operator pinned. Unpinned trusts all. */
export function fingerprintTrusted(anchor: TrustAnchor, fingerprint: string | null): boolean {
  if (!anchor.pinned) return true;
  if (!fingerprint) return false;
  return anchor.fingerprints.includes(normalizeFingerprint(fingerprint));
}

/* ------------------------------------------------------------------ */
/* The weakening note — one string, used everywhere                    */
/* ------------------------------------------------------------------ */

export const DERIVED_KEY_WEAKENING =
  "This seal was signed with a key DERIVED FROM AUTH_SECRET, not with a separately held " +
  "signing key. The same operator that runs this application holds AUTH_SECRET, so the " +
  "signature proves the ledger has not been altered by anyone who only has database access " +
  "— it does NOT prove anything against the operator of this deployment, who could re-derive " +
  "the key and re-sign a rewritten chain. To obtain the stronger property, generate a key " +
  "with `openssl genpkey -algorithm ed25519 -out anchor-key.pem`, set ANCHOR_SIGNING_KEY to " +
  "its contents, keep it outside the database and outside the application host, and hand the " +
  "public half to the parties who will verify.";

export const NO_KEY_IN_PRODUCTION_REASON =
  "Refusing to seal: ANCHOR_SIGNING_KEY is not set and this is a production deployment. " +
  "Sealing with a key derived from AUTH_SECRET would produce a seal that proves nothing " +
  "against the operator of this deployment, and a seal that overstates what it proves is " +
  "worse than no seal.";

const REMEDY = {
  generate: "openssl genpkey -algorithm ed25519 -out anchor-key.pem",
  variable: "ANCHOR_SIGNING_KEY",
  format:
    "The PKCS8 PEM contents of anchor-key.pem. Literal newlines or \\n escapes are both " +
    "accepted; base64 of the PEM or of the raw DER is also accepted.",
  note:
    "Store the private key in the deployment's secret manager, NOT in the database and NOT " +
    "in the repository. Distribute only the public half (GET /api/v1/ledger/keys).",
} as const;

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

/** PKCS8 prefix for a raw Ed25519 seed (RFC 8410 §7): 16 bytes then the 32-byte seed. */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

const HKDF_SALT = "constructos/ledger-anchor/v1";
const HKDF_INFO = "ed25519-seal-signing-key";

/** Process-lifetime cache keyed by the exact material the key derives from. */
const cache = new Map<string, AnchorSigningKey>();

function parseConfiguredKey(raw: string): KeyObject {
  const unescaped = raw.replace(/\\n/g, "\n").trim();
  const attempts: Array<() => KeyObject> = [];
  if (unescaped.includes("-----BEGIN")) {
    attempts.push(() => createPrivateKey({ key: unescaped, format: "pem" }));
  } else {
    const decoded = Buffer.from(unescaped, "base64");
    const asText = decoded.toString("utf8");
    if (asText.includes("-----BEGIN")) {
      attempts.push(() => createPrivateKey({ key: asText, format: "pem" }));
    }
    attempts.push(() => createPrivateKey({ key: decoded, format: "der", type: "pkcs8" }));
  }
  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      return attempt();
    } catch (err) {
      lastError = err;
    }
  }
  throw new AppError(
    503,
    "ANCHOR_SIGNING_KEY is set but could not be read as an Ed25519 private key: " +
      `${(lastError as Error | undefined)?.message ?? "unrecognised encoding"}. Nothing was ` +
      "sealed. Sealing with the AUTH_SECRET fallback was NOT attempted, because silently " +
      "downgrading a configured key would hide the weaker guarantee.",
    { remedy: REMEDY },
  );
}

/**
 * Derive a deterministic Ed25519 key from AUTH_SECRET.
 *
 * HKDF-SHA256 gives a 32-byte seed, which is wrapped in the fixed 16-byte
 * RFC 8410 PKCS8 prefix and handed to node:crypto. Deterministic matters:
 * restarts, replicas and re-deployments must all produce the same key, or
 * yesterday's seals would stop verifying for a reason that has nothing to do
 * with the ledger.
 */
function deriveKeyFromAuthSecret(authSecret: string): KeyObject {
  const seed = Buffer.from(
    hkdfSync("sha256", Buffer.from(authSecret, "utf8"), HKDF_SALT, HKDF_INFO, 32),
  );
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

function buildKey(privateKey: KeyObject, source: AnchorKeySource): AnchorSigningKey {
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new AppError(
      503,
      `The configured anchor signing key is ${privateKey.asymmetricKeyType ?? "of unknown type"}, ` +
        "not ed25519. Nothing was sealed.",
      { remedy: REMEDY },
    );
  }
  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString().trim() + "\n";
  const fingerprint = createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  const derived = source === "derived_from_auth_secret";
  return {
    privateKey,
    record: {
      // The key id is a function of the public key, so the same key always has
      // the same id across restarts and replicas, and two different keys can
      // never collide on it.
      keyId: `${derived ? "ankd" : "ank"}_${fingerprint.slice(0, 16)}`,
      algorithm: SEAL_ALGORITHM,
      publicKeyPem,
      fingerprint,
      source,
      derivedFromAuthSecret: derived,
      weakening: derived ? DERIVED_KEY_WEAKENING : null,
    },
  };
}

/**
 * Resolve the signing key for this deployment, or explain why there is none.
 * Never throws for a missing key — callers that must seal use
 * {@link requireAnchorKey}; callers that merely report status use this.
 */
export function anchorKeyState(env: AnchorKeyEnv): AnchorKeyState {
  const configured = env.ANCHOR_SIGNING_KEY?.trim();
  if (configured) {
    const cacheKey = `env:${createHash("sha256").update(configured).digest("hex")}`;
    const hit = cache.get(cacheKey);
    if (hit) return { available: true, ...hit };
    const key = buildKey(parseConfiguredKey(configured), "env");
    cache.set(cacheKey, key);
    return { available: true, ...key };
  }
  if (env.NODE_ENV === "production") {
    return { available: false, reason: NO_KEY_IN_PRODUCTION_REASON, remedy: REMEDY };
  }
  const cacheKey = `derived:${createHash("sha256").update(env.AUTH_SECRET).digest("hex")}`;
  const hit = cache.get(cacheKey);
  if (hit) return { available: true, ...hit };
  const key = buildKey(deriveKeyFromAuthSecret(env.AUTH_SECRET), "derived_from_auth_secret");
  cache.set(cacheKey, key);
  return { available: true, ...key };
}

/** The signing key, or a 503 that tells the operator exactly what to do. */
export function requireAnchorKey(env: AnchorKeyEnv): AnchorSigningKey {
  const state = anchorKeyState(env);
  if (!state.available) {
    throw new AppError(503, state.reason, { remedy: state.remedy });
  }
  return { record: state.record, privateKey: state.privateKey };
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

/**
 * Guard against the single mistake that would void the whole design: writing
 * private key material into `signing_keys`. Cheap, absolute, and asserted in
 * the module's tests.
 */
export function assertPublicOnly(pem: string): void {
  if (/PRIVATE KEY/i.test(pem) || /BEGIN [A-Z ]*PRIVATE/i.test(pem)) {
    throw new Error(
      "refusing to persist private key material: signing_keys holds public halves only",
    );
  }
}

export type SigningKeyRow = typeof signingKeys.$inferSelect;

/**
 * Register the current key's PUBLIC half, if it is not already on record.
 *
 * Keys are stored platform-wide (`companyId` null) because the private half is
 * a property of the DEPLOYMENT, not of a tenant: one process, one env var, one
 * key, and `signing_keys.key_id` is globally unique. Tenants read it to verify;
 * no tenant owns it.
 */
export async function registerPublicKey(
  db: Db,
  record: AnchorKeyRecord,
): Promise<{ row: SigningKeyRow; created: boolean }> {
  assertPublicOnly(record.publicKeyPem);
  const existing = await db
    .select()
    .from(signingKeys)
    .where(eq(signingKeys.keyId, record.keyId))
    .limit(1);
  if (existing[0]) return { row: existing[0], created: false };
  const id = newId("skey");
  // ON CONFLICT DO NOTHING closes the select-then-insert race on
  // `signing_keys_key_id_idx`. The first seal of a deployment registers the
  // key opportunistically, so two concurrent first seals both read "absent"
  // and both insert — one of them used to surface as an unhandled unique
  // violation (a 500) on an operation that had, in fact, succeeded.
  const inserted = await db
    .insert(signingKeys)
    .values({
      id,
      companyId: null,
      keyId: record.keyId,
      algorithm: record.algorithm,
      publicKeyPem: record.publicKeyPem,
      fingerprint: record.fingerprint,
    })
    .onConflictDoNothing({ target: signingKeys.keyId })
    .returning({ id: signingKeys.id });
  if (inserted.length === 0) {
    // The other writer won. Their row is the row.
    const raced = await db
      .select()
      .from(signingKeys)
      .where(eq(signingKeys.keyId, record.keyId))
      .limit(1);
    if (raced[0]) return { row: raced[0], created: false };
  }
  const rows = await db.select().from(signingKeys).where(eq(signingKeys.id, id)).limit(1);
  return { row: rows[0]!, created: true };
}

/**
 * Mark every other platform-wide key retired. Rotation is a deployment-level
 * fact (the env var changed), so it applies to every tenant at once. Retirement
 * is informational only: seals already made under a retired key still verify,
 * and verification looks keys up by `keyId` regardless of `retiredAt` — a key
 * that stops verifying old seals would defeat the purpose of keeping it.
 */
export async function retireOtherKeys(db: Db, keepKeyId: string): Promise<number> {
  const rows = await db
    .select({ id: signingKeys.id })
    .from(signingKeys)
    .where(and(isNull(signingKeys.companyId), ne(signingKeys.keyId, keepKeyId), isNull(signingKeys.retiredAt)));
  if (rows.length === 0) return 0;
  await db
    .update(signingKeys)
    .set({ retiredAt: new Date().toISOString() })
    .where(and(isNull(signingKeys.companyId), ne(signingKeys.keyId, keepKeyId), isNull(signingKeys.retiredAt)));
  return rows.length;
}

/** Public keys visible to a tenant: the platform-wide ones plus its own, if any. */
export async function listVisibleKeys(db: Db, companyId: string): Promise<SigningKeyRow[]> {
  return db
    .select()
    .from(signingKeys)
    .where(or(isNull(signingKeys.companyId), eq(signingKeys.companyId, companyId)));
}
