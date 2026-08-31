/**
 * The OpenID Connect authorization-code-with-PKCE engine.
 *
 * Everything protocol-shaped lives here and nothing here touches the
 * database: discovery (RFC 8414 / OIDC Discovery 1.0), the JWKS cache,
 * PKCE (RFC 7636), the authorization request, the token exchange (RFC 6749
 * §4.1.3) and — the part that actually decides who somebody is — id_token
 * verification (OIDC Core 1.0 §3.1.3.7).
 *
 * THE RULE THAT ORGANISES THIS FILE
 * ---------------------------------
 * No claim is trusted before the signature verifies. Not the issuer, not the
 * audience, not the subject, not the email. `verifyIdToken` therefore never
 * decodes-then-checks: it hands the token to `jose`, which verifies the JWS
 * against a key selected from the provider's published JWKS and only then
 * returns a payload. Every claim check in this file runs on that returned
 * payload. An id_token whose signature fails yields an error and no
 * information — in particular it never reaches the user-resolution code, which
 * is the difference between an authentication system and a decoration.
 *
 * The algorithm allowlist is asymmetric-only on purpose. `alg: none` and the
 * HMAC family are the two classic id_token forgeries — with HS256 an attacker
 * signs a token with the provider's PUBLIC key, which is by definition
 * something they have — so they are refused before key selection, not after.
 */
import { createHash, randomBytes } from "node:crypto";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import type { IdentityProviderKind } from "@constructos/shared";
import { AppError, badRequest, unauthorized } from "../../lib/errors.js";
import { timingSafeEqualString } from "./secrets.js";
import type { SsoHttpClient } from "./http.js";

/* ------------------------------------------------------------------ */
/* Well-known providers                                                */
/* ------------------------------------------------------------------ */

export const GOOGLE_DISCOVERY_URL =
  "https://accounts.google.com/.well-known/openid-configuration";
export const GOOGLE_ISSUER = "https://accounts.google.com";
export const MICROSOFT_HOST = "https://login.microsoftonline.com";

/**
 * Microsoft's tenant segment. A single-tenant Entra app registration MUST use
 * its directory (tenant) GUID: the `common` and `organizations` endpoints will
 * happily authenticate a user from ANY Entra tenant on the internet, so a
 * connection left on `organizations` and combined with auto-provisioning is a
 * standing invitation — anybody who can create a free Entra tenant with a
 * matching domain claim walks in. The domain allow-list and
 * `domains_verified_at` are the second lock on that door; the tenant GUID is
 * the first.
 */
export const MICROSOFT_DEFAULT_TENANT = "organizations";

/** Entra's multi-tenant metadata templates the issuer; a real token carries a GUID. */
export const MICROSOFT_ISSUER_TEMPLATE = `${MICROSOFT_HOST}/{tenantid}/v2.0`;

const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isTenantGuid(value: string): boolean {
  return GUID_RE.test(value);
}

export function microsoftDiscoveryUrl(tenant: string): string {
  return `${MICROSOFT_HOST}/${encodeURIComponent(tenant)}/v2.0/.well-known/openid-configuration`;
}

export function microsoftIssuer(tenant: string): string {
  return isTenantGuid(tenant)
    ? `${MICROSOFT_HOST}/${tenant}/v2.0`
    : MICROSOFT_ISSUER_TEMPLATE;
}

/** Recover the tenant segment from a stored Microsoft discovery URL or issuer. */
export function microsoftTenantOf(
  discoveryUrl: string | null,
  issuer: string | null,
): string | null {
  for (const candidate of [discoveryUrl, issuer]) {
    if (!candidate || !candidate.startsWith(`${MICROSOFT_HOST}/`)) continue;
    const segment = candidate.slice(MICROSOFT_HOST.length + 1).split("/")[0];
    if (segment && segment !== "") return decodeURIComponent(segment);
  }
  return null;
}

export interface ProviderDefaults {
  discoveryUrl: string | null;
  issuer: string | null;
  scopes: string[];
}

export function providerDefaults(
  kind: IdentityProviderKind,
  tenantId?: string | null,
): ProviderDefaults {
  switch (kind) {
    case "google":
      return {
        discoveryUrl: GOOGLE_DISCOVERY_URL,
        issuer: GOOGLE_ISSUER,
        scopes: ["openid", "email", "profile"],
      };
    case "microsoft": {
      const tenant = tenantId && tenantId !== "" ? tenantId : MICROSOFT_DEFAULT_TENANT;
      return {
        discoveryUrl: microsoftDiscoveryUrl(tenant),
        issuer: microsoftIssuer(tenant),
        scopes: ["openid", "email", "profile"],
      };
    }
    default:
      return { discoveryUrl: null, issuer: null, scopes: ["openid", "email", "profile"] };
  }
}

/* ------------------------------------------------------------------ */
/* PKCE — RFC 7636                                                     */
/* ------------------------------------------------------------------ */

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

/**
 * PKCE is not optional on this platform, for a public or a confidential
 * client. Without it, an authorization code intercepted anywhere between the
 * provider and this API (a hijacked custom scheme, a leaky Referer, a shared
 * device's history) can be redeemed by whoever holds it. With it, the code is
 * worthless without the verifier, which never leaves this process.
 */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url"); // 43 chars, RFC 7636 §4.1
  return { verifier, challenge: pkceChallengeFor(verifier), method: "S256" };
}

export function pkceChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

export interface DiscoveryDocument {
  issuer: string;
  authorizationUrl: string;
  tokenUrl: string;
  jwksUri: string;
  userinfoUrl: string | null;
  idTokenSigningAlgValues: string[];
  codeChallengeMethods: string[];
}

/** https, except on loopback where a local IdP (Keycloak in docker) is normal. */
function assertHttps(url: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw badRequest(`${label} is not a valid absolute URL: ${url}`);
  }
  const loopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !loopback) {
    throw badRequest(
      `${label} must be https (loopback excepted). An identity provider reached over plain ` +
        `HTTP can be impersonated by anyone on the path, which defeats the entire flow.`,
    );
  }
  return parsed;
}

/**
 * Read and validate a provider's metadata document.
 *
 * A half-read discovery document is worse than none: it is how a connection
 * ends up with an authorization endpoint and no JWKS URI, which then fails at
 * the last step of a real user's sign-in instead of here, in front of the
 * administrator who can fix it.
 */
export async function fetchDiscovery(
  client: SsoHttpClient,
  discoveryUrl: string,
): Promise<DiscoveryDocument> {
  assertHttps(discoveryUrl, "discoveryUrl");
  let res;
  try {
    res = await client.get(discoveryUrl, { accept: "application/json" });
  } catch (err) {
    throw new AppError(
      502,
      `Could not reach the identity provider's discovery document at ${discoveryUrl}: ` +
        `${(err as Error).message}. Check outbound network access from the API host.`,
    );
  }
  if (res.status !== 200) {
    throw new AppError(
      502,
      `The identity provider's discovery document at ${discoveryUrl} returned HTTP ${res.status}. ` +
        `Confirm the URL — for Microsoft Entra it is ` +
        `${MICROSOFT_HOST}/<tenant-guid>/v2.0/.well-known/openid-configuration.`,
    );
  }
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    throw new AppError(
      502,
      `The identity provider's discovery document at ${discoveryUrl} was not JSON. ` +
        `A login page or an HTML error page here usually means the URL is missing the ` +
        `/.well-known/openid-configuration suffix.`,
    );
  }

  const str = (key: string): string | null => {
    const v = doc[key];
    return typeof v === "string" && v !== "" ? v : null;
  };
  const arr = (key: string): string[] => {
    const v = doc[key];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  };

  const missing: string[] = [];
  const issuer = str("issuer");
  const authorizationUrl = str("authorization_endpoint");
  const tokenUrl = str("token_endpoint");
  const jwksUri = str("jwks_uri");
  if (!issuer) missing.push("issuer");
  if (!authorizationUrl) missing.push("authorization_endpoint");
  if (!tokenUrl) missing.push("token_endpoint");
  if (!jwksUri) missing.push("jwks_uri");
  if (missing.length > 0) {
    throw new AppError(
      502,
      `The discovery document at ${discoveryUrl} is missing: ${missing.join(", ")}. ` +
        `This is not a usable OpenID Provider configuration.`,
    );
  }

  for (const [label, value] of [
    ["authorization_endpoint", authorizationUrl!],
    ["token_endpoint", tokenUrl!],
    ["jwks_uri", jwksUri!],
  ] as const) {
    assertHttps(value, `discovery ${label}`);
  }

  const codeChallengeMethods = arr("code_challenge_methods_supported");
  if (codeChallengeMethods.length > 0 && !codeChallengeMethods.includes("S256")) {
    throw new AppError(
      502,
      `The identity provider at ${issuer} does not advertise PKCE S256 ` +
        `(code_challenge_methods_supported = ${JSON.stringify(codeChallengeMethods)}). ` +
        `This platform will not run an authorization code flow without PKCE.`,
    );
  }

  return {
    issuer: issuer!,
    authorizationUrl: authorizationUrl!,
    tokenUrl: tokenUrl!,
    jwksUri: jwksUri!,
    userinfoUrl: str("userinfo_endpoint"),
    idTokenSigningAlgValues: arr("id_token_signing_alg_values_supported"),
    codeChallengeMethods,
  };
}

/* ------------------------------------------------------------------ */
/* JWKS cache                                                          */
/* ------------------------------------------------------------------ */

interface JwksEntry {
  jwks: JSONWebKeySet;
  fetchedAtMs: number;
  lastAttemptMs: number;
}

export interface JwksStoreOptions {
  /** how long a key set is served without re-reading it */
  ttlMs: number;
  /** floor between two fetches of the same URI, so an unknown `kid` cannot be
   *  turned into an outbound request amplifier by anyone who can hand us a
   *  token with a `kid` of their choosing */
  cooldownMs: number;
}

export const DEFAULT_JWKS_OPTIONS: JwksStoreOptions = { ttlMs: 600_000, cooldownMs: 60_000 };

/**
 * Caches each provider's key set and refreshes it on an unknown `kid`.
 *
 * Both halves matter. Without the cache every sign-in makes an extra outbound
 * round trip and a provider outage becomes a total sign-in outage. Without the
 * `kid`-miss refresh, a routine key rotation at the provider locks every user
 * out for the length of the TTL — which is the failure that gets SSO
 * integrations switched off in anger.
 */
export class JwksStore {
  private readonly entries = new Map<string, JwksEntry>();

  constructor(
    private readonly client: SsoHttpClient,
    private readonly options: JwksStoreOptions = DEFAULT_JWKS_OPTIONS,
  ) {}

  async resolve(jwksUri: string, kid: string | null, nowMs: number): Promise<JSONWebKeySet> {
    const cached = this.entries.get(jwksUri);
    const fresh = cached && nowMs - cached.fetchedAtMs < this.options.ttlMs;
    const known = cached ? hasKid(cached.jwks, kid) : false;
    if (cached && fresh && known) return cached.jwks;
    if (cached && !fresh) return this.fetch(jwksUri, nowMs, cached);
    if (cached && !known) {
      if (nowMs - cached.lastAttemptMs < this.options.cooldownMs) return cached.jwks;
      return this.fetch(jwksUri, nowMs, cached);
    }
    return this.fetch(jwksUri, nowMs, cached);
  }

  private async fetch(
    jwksUri: string,
    nowMs: number,
    previous: JwksEntry | undefined,
  ): Promise<JSONWebKeySet> {
    let res;
    try {
      res = await this.client.get(jwksUri, { accept: "application/json" });
    } catch (err) {
      if (previous) {
        // A live key set already in hand beats failing every sign-in because
        // the provider's CDN blipped. Record the attempt so the cooldown holds.
        previous.lastAttemptMs = nowMs;
        return previous.jwks;
      }
      throw new AppError(
        502,
        `Could not reach the identity provider's JWKS at ${jwksUri}: ${(err as Error).message}.`,
      );
    }
    if (res.status !== 200) {
      if (previous) {
        previous.lastAttemptMs = nowMs;
        return previous.jwks;
      }
      throw new AppError(
        502,
        `The identity provider's JWKS at ${jwksUri} returned HTTP ${res.status}. ` +
          `Without its public keys no id_token can be verified, so sign-in is refused.`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      parsed = null;
    }
    const keys =
      parsed && typeof parsed === "object" && Array.isArray((parsed as JSONWebKeySet).keys)
        ? (parsed as JSONWebKeySet)
        : null;
    if (!keys || keys.keys.length === 0) {
      if (previous) {
        previous.lastAttemptMs = nowMs;
        return previous.jwks;
      }
      throw new AppError(
        502,
        `The JWKS at ${jwksUri} contained no keys. Sign-in is refused rather than accepting an ` +
          `unverifiable token.`,
      );
    }
    this.entries.set(jwksUri, { jwks: keys, fetchedAtMs: nowMs, lastAttemptMs: nowMs });
    return keys;
  }
}

function hasKid(jwks: JSONWebKeySet, kid: string | null): boolean {
  if (!kid) return jwks.keys.length > 0;
  return jwks.keys.some((k) => k.kid === kid);
}

/* ------------------------------------------------------------------ */
/* Authorization request                                               */
/* ------------------------------------------------------------------ */

export interface AuthorizationRequest {
  authorizationUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  nonce: string;
  challenge: string;
  loginHint?: string | null;
  /** Microsoft wants an explicit response_mode; harmless elsewhere */
  responseMode?: string | null;
  prompt?: string | null;
}

export function buildAuthorizationUrl(req: AuthorizationRequest): string {
  const url = new URL(req.authorizationUrl);
  const params = url.searchParams;
  params.set("response_type", "code");
  params.set("client_id", req.clientId);
  params.set("redirect_uri", req.redirectUri);
  params.set("scope", req.scopes.join(" "));
  params.set("state", req.state);
  params.set("nonce", req.nonce);
  params.set("code_challenge", req.challenge);
  params.set("code_challenge_method", "S256");
  if (req.responseMode) params.set("response_mode", req.responseMode);
  if (req.loginHint) params.set("login_hint", req.loginHint);
  if (req.prompt) params.set("prompt", req.prompt);
  return url.toString();
}

/* ------------------------------------------------------------------ */
/* Token exchange — RFC 6749 §4.1.3                                    */
/* ------------------------------------------------------------------ */

export interface TokenExchangeInput {
  client: SsoHttpClient;
  tokenUrl: string;
  code: string;
  redirectUri: string;
  clientId: string;
  /** null for a public PKCE client */
  clientSecret: string | null;
  codeVerifier: string;
}

export interface TokenResponse {
  idToken: string | null;
  accessToken: string | null;
  tokenType: string | null;
  expiresIn: number | null;
}

export async function exchangeCode(input: TokenExchangeInput): Promise<TokenResponse> {
  const form = new URLSearchParams();
  form.set("grant_type", "authorization_code");
  form.set("code", input.code);
  form.set("redirect_uri", input.redirectUri);
  form.set("client_id", input.clientId);
  // The verifier is what makes the code useless to an interceptor. It is
  // always sent; a flow that reached here without one is a bug, not a
  // fallback, and is refused above rather than degraded to a plain exchange.
  form.set("code_verifier", input.codeVerifier);
  if (input.clientSecret) form.set("client_secret", input.clientSecret);

  let res;
  try {
    res = await input.client.post(input.tokenUrl, form.toString(), {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    });
  } catch (err) {
    throw new AppError(
      502,
      `Could not reach the identity provider's token endpoint at ${input.tokenUrl}: ` +
        `${(err as Error).message}.`,
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    body = {};
  }

  if (res.status !== 200) {
    const code = typeof body["error"] === "string" ? body["error"] : `http_${res.status}`;
    const description =
      typeof body["error_description"] === "string" ? body["error_description"] : "";
    throw unauthorized(
      `The identity provider refused the authorization code (${code})` +
        (description ? `: ${description}` : "") +
        `. Common causes: the redirect URI registered at the provider does not exactly match ` +
        `${input.redirectUri}, the client secret is wrong, or the code was already used.`,
    );
  }

  const str = (key: string): string | null => {
    const v = body[key];
    return typeof v === "string" && v !== "" ? v : null;
  };
  const expiresRaw = body["expires_in"];
  return {
    idToken: str("id_token"),
    accessToken: str("access_token"),
    tokenType: str("token_type"),
    expiresIn: typeof expiresRaw === "number" ? expiresRaw : null,
  };
}

/* ------------------------------------------------------------------ */
/* id_token verification — OIDC Core §3.1.3.7                          */
/* ------------------------------------------------------------------ */

/** Asymmetric only. See the file header for why HS* and `none` are absent. */
export const ALLOWED_ID_TOKEN_ALGS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
] as const;

export interface VerifyIdTokenInput {
  idToken: string;
  jwks: JSONWebKeySet;
  /** may carry Entra's `{tenantid}` placeholder */
  expectedIssuer: string;
  audience: string;
  nonce: string;
  nowMs: number;
  clockToleranceSec?: number;
  /** when set and a GUID, the token's `tid` must match it */
  tenantId?: string | null;
}

export function issuerMatches(expected: string, actual: string): boolean {
  if (!expected.includes("{tenantid}")) return expected === actual;
  const escaped = expected
    .split("{tenantid}")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}");
  return new RegExp(`^${escaped}$`).test(actual);
}

interface JoseLikeError {
  code?: unknown;
  claim?: unknown;
  message?: unknown;
}

export async function verifyIdToken(input: VerifyIdTokenInput): Promise<JWTPayload> {
  const templated = input.expectedIssuer.includes("{tenantid}");
  const keys = createLocalJWKSet(input.jwks);

  let payload: JWTPayload;
  try {
    const result = await jwtVerify(input.idToken, keys, {
      algorithms: [...ALLOWED_ID_TOKEN_ALGS],
      audience: input.audience,
      // Entra's multi-tenant metadata cannot state a concrete issuer, so the
      // check moves below — onto the payload jose has already authenticated,
      // never onto an unverified decode.
      ...(templated ? {} : { issuer: input.expectedIssuer }),
      clockTolerance: input.clockToleranceSec ?? 60,
      currentDate: new Date(input.nowMs),
      requiredClaims: ["iss", "sub", "aud", "exp", "iat"],
    });
    payload = result.payload;
  } catch (err) {
    throw translateJoseError(err as JoseLikeError, input);
  }

  if (templated && !issuerMatches(input.expectedIssuer, String(payload["iss"] ?? ""))) {
    throw unauthorized(
      `The id_token issuer "${String(payload["iss"] ?? "")}" does not match the pattern this ` +
        `connection expects (${input.expectedIssuer}).`,
    );
  }

  // OIDC Core §3.1.3.7 rule 5: if `azp` is present it MUST be the client id.
  // A token minted for a different client of the same provider is a valid
  // token — just not one addressed to us, and treating it as ours is a
  // cross-client confused-deputy.
  const azp = payload["azp"];
  if (typeof azp === "string" && azp !== "" && !timingSafeEqualString(azp, input.audience)) {
    throw unauthorized(
      "The id_token was issued for a different client of this identity provider (azp mismatch).",
    );
  }

  const nonce = payload["nonce"];
  if (typeof nonce !== "string" || !timingSafeEqualString(nonce, input.nonce)) {
    throw unauthorized(
      "The id_token nonce does not match the sign-in that started this flow. The response has " +
        "been replayed or belongs to a different attempt; sign in again.",
    );
  }

  const sub = payload["sub"];
  if (typeof sub !== "string" || sub === "") {
    throw unauthorized("The id_token carries no subject (`sub`), so it identifies nobody.");
  }

  if (input.tenantId && isTenantGuid(input.tenantId)) {
    const tid = payload["tid"];
    if (typeof tid !== "string" || !timingSafeEqualString(tid, input.tenantId)) {
      throw unauthorized(
        `This connection is restricted to Microsoft Entra tenant ${input.tenantId}, and the ` +
          `id_token was issued by tenant "${typeof tid === "string" ? tid : "unknown"}".`,
      );
    }
  }

  return payload;
}

function translateJoseError(err: JoseLikeError, input: VerifyIdTokenInput): AppError {
  const code = typeof err.code === "string" ? err.code : "";
  switch (code) {
    case "ERR_JWS_SIGNATURE_VERIFICATION_FAILED":
      return unauthorized(
        "The id_token signature did not verify against the identity provider's published keys. " +
          "The token was not issued by this provider, or it has been altered in transit.",
      );
    case "ERR_JWKS_NO_MATCHING_KEY":
      return unauthorized(
        "No key in the identity provider's JWKS matches the id_token header, so its signature " +
          "cannot be verified. Sign-in is refused rather than trusting an unverified token.",
      );
    case "ERR_JWKS_MULTIPLE_MATCHING_KEYS":
      return unauthorized(
        "The identity provider's JWKS offers several keys matching this id_token header and the " +
          "correct one is ambiguous. Sign-in is refused.",
      );
    case "ERR_JOSE_ALG_NOT_ALLOWED":
      return unauthorized(
        `The id_token is signed with an algorithm this platform refuses. Only asymmetric ` +
          `signatures are accepted (${ALLOWED_ID_TOKEN_ALGS.join(", ")}); \`none\` and the HMAC ` +
          `family are rejected because the verifying key would be public.`,
      );
    case "ERR_JWT_EXPIRED":
      return unauthorized(
        "The id_token has expired. If this happens to everyone, the API host's clock is wrong.",
      );
    case "ERR_JWT_CLAIM_VALIDATION_FAILED": {
      const claim = typeof err.claim === "string" ? err.claim : "";
      if (claim === "iss") {
        return unauthorized(
          `The id_token issuer does not match this connection's configured issuer ` +
            `(${input.expectedIssuer}).`,
        );
      }
      if (claim === "aud") {
        return unauthorized(
          "The id_token audience is not this connection's client id — the token was issued for a " +
            "different application.",
        );
      }
      if (claim === "nbf") {
        return unauthorized("The id_token is not valid yet (nbf is in the future).");
      }
      return unauthorized(
        `The id_token failed claim validation${claim ? ` on \`${claim}\`` : ""}.`,
      );
    }
    case "ERR_JWT_INVALID":
    case "ERR_JWS_INVALID":
      return unauthorized("The id_token is not a well-formed signed JWT.");
    default:
      return unauthorized(
        `The id_token could not be verified: ${
          typeof err.message === "string" ? err.message : "unknown verification failure"
        }`,
      );
  }
}

/* ------------------------------------------------------------------ */
/* Claims                                                              */
/* ------------------------------------------------------------------ */

export interface AssertedIdentity {
  subject: string;
  email: string | null;
  /**
   * TRUE only when the provider itself vouches for the address. This single
   * boolean is what stands between an account and a takeover, so it is
   * computed from explicit claims and never inferred from the shape of the
   * address or the reputation of the provider.
   */
  emailVerified: boolean;
  /** why the address is not treated as verified — operator-actionable prose */
  emailReasons: string[];
  displayName: string | null;
  groups: string[];
  tenantId: string | null;
  rawProfile: Record<string, unknown>;
}

const PROFILE_DROP = new Set(["at_hash", "c_hash", "nonce"]);

function truthy(value: unknown): boolean {
  return value === true || value === "true";
}

export function extractIdentity(
  payload: JWTPayload,
  options: { groupClaimName: string },
): AssertedIdentity {
  const emailClaim = payload["email"];
  const preferred = payload["preferred_username"];
  const upn = payload["upn"];
  const rawEmail =
    typeof emailClaim === "string" && emailClaim.includes("@")
      ? emailClaim
      : typeof preferred === "string" && preferred.includes("@")
        ? preferred
        : typeof upn === "string" && upn.includes("@")
          ? upn
          : null;
  const email = rawEmail ? rawEmail.trim().toLowerCase() : null;

  const emailReasons: string[] = [];
  // `xms_edov` is Entra's optional "email domain owner verified" claim — the
  // only signal Microsoft publishes that is equivalent to `email_verified`.
  // Without one of the two we do not know that the tenant owns the address,
  // and Entra will happily mint a token for an unverified personal address in
  // a tenant somebody created ten minutes ago.
  const emailVerified = truthy(payload["email_verified"]) || truthy(payload["xms_edov"]);
  if (!email) {
    emailReasons.push(
      "The id_token carries no email address. Request the `email` scope, and for Microsoft Entra " +
        "add the `email` optional claim to the app registration's token configuration.",
    );
  } else if (!emailVerified) {
    emailReasons.push(
      "The identity provider did not assert that this address is verified " +
        "(`email_verified` is absent or false). For Microsoft Entra, enable the `xms_edov` " +
        "optional claim on the app registration; without it an address cannot be trusted to " +
        "match an existing account.",
    );
  }

  const nameClaim = payload["name"];
  const given = payload["given_name"];
  const family = payload["family_name"];
  const displayName =
    typeof nameClaim === "string" && nameClaim.trim() !== ""
      ? nameClaim.trim()
      : [given, family].every((p) => typeof p === "string" && p !== "")
        ? `${String(given)} ${String(family)}`
        : null;

  const groupsRaw = payload[options.groupClaimName];
  const groups = Array.isArray(groupsRaw)
    ? groupsRaw.filter((g): g is string => typeof g === "string")
    : typeof groupsRaw === "string"
      ? groupsRaw.split(/[\s,]+/).filter((g) => g !== "")
      : [];

  const tid = payload["tid"];
  const rawProfile: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!PROFILE_DROP.has(key)) rawProfile[key] = value;
  }

  return {
    subject: String(payload["sub"]),
    email,
    emailVerified,
    emailReasons,
    displayName,
    groups,
    tenantId: typeof tid === "string" ? tid : null,
    rawProfile,
  };
}

/* ------------------------------------------------------------------ */
/* userinfo — OIDC Core §5.3                                           */
/* ------------------------------------------------------------------ */

/**
 * Last resort for an email address, used only when the id_token has none.
 *
 * The subject check is not optional and is the reason this is a function
 * rather than three inline lines: OIDC Core §5.3.2 requires the client to
 * verify that the `sub` in the userinfo response matches the `sub` in the
 * id_token. Skipping it lets a provider (or anything that can answer for its
 * userinfo endpoint) substitute a different person's profile onto an
 * authenticated session.
 */
export async function fetchUserinfo(
  client: SsoHttpClient,
  userinfoUrl: string,
  accessToken: string,
  expectedSubject: string,
): Promise<Record<string, unknown> | null> {
  let res;
  try {
    res = await client.get(userinfoUrl, {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    });
  } catch {
    return null;
  }
  if (res.status !== 200) return null;
  let body: unknown;
  try {
    body = JSON.parse(res.body);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const claims = body as Record<string, unknown>;
  const sub = claims["sub"];
  if (typeof sub !== "string" || !timingSafeEqualString(sub, expectedSubject)) {
    throw unauthorized(
      "The identity provider's userinfo response describes a different subject than the " +
        "id_token. Sign-in is refused.",
    );
  }
  return claims;
}
