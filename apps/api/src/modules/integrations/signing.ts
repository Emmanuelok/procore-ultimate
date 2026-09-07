import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { canonicalize, sha256Hex } from "@constructos/ledger";

/**
 * Vol I §0.7 #121 — webhook secret custody and payload signing.
 *
 * SECRET CUSTODY
 * --------------
 * The database never holds a usable signing secret. A secret is DERIVED, with
 * HKDF-SHA256, from an environment-held master key plus the endpoint id:
 *
 *     ikm  = WEBHOOK_SIGNING_KEY (or AUTH_SECRET — see the honest note below)
 *     salt = endpoint id
 *     info = "constructos:webhook:v1"
 *     secret = "whsec_" + hex(HKDF(ikm, salt, info, 32))
 *
 * That makes the secret re-derivable at send time from material the database
 * does not contain, so `webhook_endpoints.secret_fingerprint` can hold only a
 * sha256 of it: enough for an operator to confirm the value they saved at
 * creation still matches, useless to anyone who steals the table.
 *
 * The secret is returned EXACTLY ONCE, in the 201 body of endpoint creation.
 * No route re-derives it into a response.
 *
 * HONEST NOTE ON THE FALLBACK
 * ---------------------------
 * When WEBHOOK_SIGNING_KEY is unset the derivation falls back to AUTH_SECRET
 * so a deployment works out of the box. That fallback SHARES CUSTODY WITH THE
 * APPLICATION: anyone who can read the JWT signing secret can also forge every
 * webhook signature this tenant will ever send. It is recorded — the source is
 * written into the ledger entry at creation and reported on every read of the
 * endpoint — precisely so nobody discovers it during an incident. Set
 * WEBHOOK_SIGNING_KEY to separate the two custodies.
 *
 * Rotating the master key deliberately invalidates every derived secret: the
 * fingerprint stops matching, `secretFingerprintMatches` on a GET goes false,
 * and the operator must re-create the endpoint (or restore the old key). That
 * is the price of holding no usable secret at rest, and it is the right price.
 */

export const HKDF_INFO = "constructos:webhook:v1";
export const SECRET_PREFIX = "whsec_";

export type SigningKeySource = "WEBHOOK_SIGNING_KEY" | "AUTH_SECRET_FALLBACK";

export interface SigningKey {
  ikm: string;
  source: SigningKeySource;
  /** true when the key shares custody with the application's JWT secret */
  sharedCustody: boolean;
  note: string;
}

const FALLBACK_NOTE =
  "WEBHOOK_SIGNING_KEY is not set, so webhook secrets are derived from AUTH_SECRET. " +
  "That shares custody with the application: anyone who can read the JWT signing " +
  "secret can forge webhook signatures. Set WEBHOOK_SIGNING_KEY to separate them.";

const DEDICATED_NOTE =
  "Webhook secrets are derived from WEBHOOK_SIGNING_KEY, which is held separately " +
  "from the application's JWT secret.";

/** Resolve the HKDF master key, preferring a dedicated key over AUTH_SECRET. */
export function resolveSigningKey(
  authSecret: string,
  env: NodeJS.ProcessEnv = process.env,
): SigningKey {
  const dedicated = env["WEBHOOK_SIGNING_KEY"];
  if (typeof dedicated === "string" && dedicated.length >= 16) {
    return {
      ikm: dedicated,
      source: "WEBHOOK_SIGNING_KEY",
      sharedCustody: false,
      note: DEDICATED_NOTE,
    };
  }
  return {
    ikm: authSecret,
    source: "AUTH_SECRET_FALLBACK",
    sharedCustody: true,
    note: FALLBACK_NOTE,
  };
}

/**
 * Derive an endpoint's signing secret. Deterministic for a given master key.
 *
 * SECRET ROTATION (#121). The salt is `<endpointId>` for version 1 and
 * `<endpointId>:v<N>` from version 2 on, so rotating an endpoint's secret is an
 * increment of a small integer on the row rather than a stored credential
 * changing. Version 1 keeps the bare salt so every secret issued before
 * rotation existed still derives to exactly the same value — a migration that
 * silently invalidated live secrets would be worse than no rotation at all.
 */
export function deriveEndpointSecret(
  key: SigningKey,
  endpointId: string,
  version = 1,
): string {
  const salt = version <= 1 ? endpointId : `${endpointId}:v${version}`;
  const bytes = hkdfSync("sha256", key.ikm, salt, HKDF_INFO, 32);
  return `${SECRET_PREFIX}${Buffer.from(bytes).toString("hex")}`;
}

/** What the database stores in place of the secret. */
export function secretFingerprint(secret: string): string {
  return sha256Hex(secret);
}

/* ------------------------------------------------------------------ */
/* The wire format                                                     */
/* ------------------------------------------------------------------ */

/**
 * HEADERS SENT WITH EVERY DELIVERY
 *
 *   content-type:                 application/json
 *   user-agent:                   ConstructOS-Webhooks/1
 *   x-constructos-event:          the event kind, e.g. "rfi.create"
 *   x-constructos-delivery:       the delivery id — DEDUPE ON THIS
 *   x-constructos-endpoint:       the endpoint id
 *   x-constructos-company:        the tenant the event belongs to
 *   x-constructos-timestamp:      unix SECONDS, fixed at enqueue
 *   x-constructos-attempt:        1-based attempt counter (NOT signed)
 *   x-constructos-signature:      v1=<hex hmac-sha256>
 *
 * STRING-TO-SIGN
 *
 *   v1:{x-constructos-timestamp}:{x-constructos-delivery}:{raw request body}
 *
 * joined with literal colons, HMAC-SHA256 under the endpoint's derived secret,
 * lower-case hex, prefixed `v1=` in the header. The body is signed as the
 * exact bytes sent; it is canonical JSON (sorted keys) so it is byte-stable.
 *
 * A receiver verifies by recomputing over the raw body BEFORE parsing it, and
 * comparing in constant time. Binding the delivery id into the string-to-sign
 * means a body captured from one delivery cannot be replayed as another.
 *
 * RETRIES RE-SEND IDENTICAL BYTES AND AN IDENTICAL SIGNATURE. The timestamp is
 * fixed at enqueue, not per attempt, so the stored signature stays the truth of
 * what left the platform and a receiver's dedupe on x-constructos-delivery is
 * exact. The consequence receivers must plan for: a freshness window has to
 * cover the whole retry budget (attempts x max backoff — by default under an
 * hour), so enforce freshness generously and rely on delivery-id dedupe for
 * replay protection.
 */
export const SIGNATURE_HEADER = "x-constructos-signature";
export const TIMESTAMP_HEADER = "x-constructos-timestamp";
export const DELIVERY_HEADER = "x-constructos-delivery";
export const EVENT_HEADER = "x-constructos-event";
export const ENDPOINT_HEADER = "x-constructos-endpoint";
export const COMPANY_HEADER = "x-constructos-company";
export const ATTEMPT_HEADER = "x-constructos-attempt";
/**
 * ROTATION HEADERS. While an endpoint is inside a rotation grace window the
 * delivery carries TWO valid signatures: the primary header is signed with the
 * secret the receiver already holds (so nothing breaks the moment rotation
 * starts), and the alternate header is signed with the newly issued secret.
 * A receiver adopts the new secret by accepting EITHER header, and once the
 * grace window closes the primary header carries the new secret alone.
 */
export const ALT_SIGNATURE_HEADER = "x-constructos-signature-alt";
export const SECRET_VERSION_HEADER = "x-constructos-secret-version";
export const ALT_SECRET_VERSION_HEADER = "x-constructos-secret-version-alt";
export const SIGNATURE_VERSION = "v1";

export interface WebhookEnvelope {
  /** the delivery id — stable across retries, the receiver's dedupe key */
  id: string;
  /** event kind: `${objectType}.${action}`, or "ping" for a test delivery */
  type: string;
  companyId: string;
  projectId: string | null;
  occurredAt: string;
  endpointId: string;
  /**
   * Present and true only for a DEVELOPER SANDBOX tenant (#123). A receiver
   * that acts on webhooks — raising a payable, releasing a shipment — reads it
   * and refuses. Absent on every ordinary tenant, so the wire format for real
   * traffic is exactly what it was.
   */
  sandbox?: boolean;
  data: Record<string, unknown>;
}

/** The exact bytes signed and sent: canonical JSON, sorted keys. */
export function canonicalBody(envelope: WebhookEnvelope): string {
  return canonicalize(envelope);
}

/** Build the string-to-sign. Exported so tests and docs cannot drift from it. */
export function stringToSign(
  timestampSeconds: number,
  deliveryId: string,
  body: string,
): string {
  return `${SIGNATURE_VERSION}:${timestampSeconds}:${deliveryId}:${body}`;
}

/** `v1=<hex>` — the value of the x-constructos-signature header. */
export function signPayload(
  secret: string,
  timestampSeconds: number,
  deliveryId: string,
  body: string,
): string {
  const mac = createHmac("sha256", secret)
    .update(stringToSign(timestampSeconds, deliveryId, body))
    .digest("hex");
  return `${SIGNATURE_VERSION}=${mac}`;
}

/**
 * Constant-time verification, the way a receiver should do it. Exported both
 * for the platform's own tests and as executable documentation for integrators.
 */
export function verifySignature(
  secret: string,
  timestampSeconds: number,
  deliveryId: string,
  body: string,
  headerValue: string,
): boolean {
  const expected = signPayload(secret, timestampSeconds, deliveryId, body);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(headerValue, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
