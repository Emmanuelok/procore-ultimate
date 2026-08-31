import { createHmac, randomBytes } from "node:crypto";
import { constantTimeEquals, deriveKey, KEY_PURPOSE, type KeyMaterialConfig } from "./secrets.js";

/**
 * The half-authenticated state between "the password was right" and "you are
 * signed in".
 *
 * THE ONE PROPERTY THIS TYPE EXISTS TO GUARANTEE: a challenge token is NOT an
 * access token and can never be mistaken for one. Two independent things
 * enforce that, because one would be a single edit away from failing:
 *
 *  1. FORMAT. It is `mfachal_v1.<payload>.<mac>`. plugins/auth.ts hands the
 *     bearer value to `jwtVerify`, which parses the first dot-separated
 *     segment as a base64url JWT header — `mfachal_v1` is not one, so the
 *     token is rejected before any signature is considered.
 *  2. KEY. The MAC key is HKDF-derived from the same input keying material
 *     with a DIFFERENT info string (see secrets.ts). Even if a future change
 *     made the formats converge, the signature would not verify under the JWT
 *     secret, and a JWT would not verify under this one.
 *
 * There is a test for exactly this: a challenge token presented as
 * `Authorization: Bearer …` to an authenticated route gets a 401.
 *
 * WHY IT IS STATELESS, AND WHAT THAT COSTS
 * ----------------------------------------
 * There is no `mfa_challenges` table in the schema this module builds against,
 * and this module does not own the schema. So the token carries its own claims
 * under a MAC instead of naming a row. The honest consequence: within its
 * short life (MFA_CHALLENGE_TTL_MINUTES, default 10) the same token can be
 * presented more than once.
 *
 * That is bounded to almost nothing by the rest of the design, and it is worth
 * being precise about why rather than waving at it. Presenting the token
 * achieves nothing on its own — it is only ever exchanged WITH a second
 * factor, and a TOTP code is single-use per step (`last_used_step`) while a
 * recovery code is single-use for ever. So an attacker holding a stolen
 * challenge token must ALSO hold a code that has not been spent, and an
 * attacker with a live code and the token has, by then, everything the token
 * could have added. What statelessness genuinely costs is server-side
 * revocation of a challenge in flight; a ten-minute expiry is the mitigation,
 * and the ledger of attempts is in `auth_security_events` either way.
 */

const TOKEN_PREFIX = "mfachal_v1";

/**
 * What the challenge is asking the holder to do.
 *
 * `verify` — the account has a confirmed factor; produce a code from it.
 * `enrol`  — company policy requires MFA and this account has no confirmed
 *            factor. The password was correct, so refusing with a bare 403
 *            would strand a legitimate user with no way forward; instead the
 *            challenge carries the authority to enrol, and confirming the new
 *            factor is what completes the sign-in.
 */
export const CHALLENGE_SCOPES = ["verify", "enrol"] as const;
export type ChallengeScope = (typeof CHALLENGE_SCOPES)[number];

export interface ChallengeClaims {
  v: 1;
  /** purpose separation inside the payload as well as in the key */
  pur: "mfa_challenge";
  scope: ChallengeScope;
  /** the user this challenge belongs to */
  uid: string;
  /** unique id, echoed into the security trail so attempts can be correlated */
  jti: string;
  /** issued-at, epoch ms */
  iat: number;
  /** expiry, epoch ms */
  exp: number;
}

export interface MintedChallenge {
  token: string;
  claims: ChallengeClaims;
}

export interface ChallengeVerification {
  claims: ChallengeClaims | null;
  reasons: string[];
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function mac(key: Buffer, signingInput: string): string {
  return b64url(createHmac("sha256", key).update(signingInput).digest());
}

export interface MintChallengeInput {
  userId: string;
  scope: ChallengeScope;
  ttlMinutes: number;
  atMs?: number;
}

export function mintChallengeToken(
  config: KeyMaterialConfig,
  input: MintChallengeInput,
): MintedChallenge {
  const now = input.atMs ?? Date.now();
  const claims: ChallengeClaims = {
    v: 1,
    pur: "mfa_challenge",
    scope: input.scope,
    uid: input.userId,
    jti: `mch_${randomBytes(12).toString("hex")}`,
    iat: now,
    exp: now + Math.max(1, input.ttlMinutes) * 60_000,
  };
  const payload = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  const signingInput = `${TOKEN_PREFIX}.${payload}`;
  const key = deriveKey(config, KEY_PURPOSE.challengeToken);
  return { token: `${signingInput}.${mac(key, signingInput)}`, claims };
}

/**
 * Verify and decode. Every rejection names its reason, in the platform's
 * `reasons` idiom, so the route can distinguish "expired, ask them to sign in
 * again" from "forged, record a security event" — a bare boolean would collapse
 * a routine timeout and an attack into the same log line.
 */
export function verifyChallengeToken(
  config: KeyMaterialConfig,
  token: string,
  options: { atMs?: number } = {},
): ChallengeVerification {
  const atMs = options.atMs ?? Date.now();
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
    return { claims: null, reasons: ["Challenge token is not in the expected format."] };
  }
  const signingInput = `${parts[0]}.${parts[1]}`;
  const key = deriveKey(config, KEY_PURPOSE.challengeToken);
  if (!constantTimeEquals(mac(key, signingInput), parts[2]!)) {
    return { claims: null, reasons: ["Challenge token signature is invalid."] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return { claims: null, reasons: ["Challenge token payload is not readable."] };
  }
  if (!isChallengeClaims(parsed)) {
    return { claims: null, reasons: ["Challenge token payload is not a challenge."] };
  }
  // Instant comparison, never a string one — see lib/time.ts. These claims are
  // already epoch milliseconds precisely so no spelling of a timestamp is
  // involved in the decision.
  if (parsed.exp <= atMs) {
    return { claims: null, reasons: ["Challenge has expired. Sign in again."] };
  }
  return { claims: parsed, reasons: [] };
}

function isChallengeClaims(value: unknown): value is ChallengeClaims {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    c["v"] === 1 &&
    c["pur"] === "mfa_challenge" &&
    typeof c["scope"] === "string" &&
    (CHALLENGE_SCOPES as readonly string[]).includes(c["scope"]) &&
    typeof c["uid"] === "string" &&
    c["uid"].length > 0 &&
    typeof c["jti"] === "string" &&
    typeof c["iat"] === "number" &&
    typeof c["exp"] === "number"
  );
}

/** The public shape a login response hands back. Carries no secret. */
export interface ChallengeEnvelope {
  challengeToken: string;
  challengeId: string;
  scope: ChallengeScope;
  expiresAt: string;
  /** what the client should ask for next */
  methods: ("totp" | "recovery_code")[];
  /** true when the holder must enrol a factor before the session exists */
  enrolmentRequired: boolean;
}

export function challengeEnvelope(minted: MintedChallenge): ChallengeEnvelope {
  const enrolmentRequired = minted.claims.scope === "enrol";
  return {
    challengeToken: minted.token,
    challengeId: minted.claims.jti,
    scope: minted.claims.scope,
    expiresAt: new Date(minted.claims.exp).toISOString(),
    methods: enrolmentRequired ? ["totp"] : ["totp", "recovery_code"],
    enrolmentRequired,
  };
}
