import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { SignJWT, exportJWK, generateKeyPair, type JSONWebKeySet, type JWK } from "jose";
import {
  authSecurityEvents,
  authSessions,
  companyMemberships,
  identityProviders,
  ledgerEntries,
  refreshTokens,
  userIdentities,
  users,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { registerSsoHttpClient, type SsoHttpClient, type SsoHttpResponse } from "./http.js";
import { decryptSecret, deriveSsoKey } from "./secrets.js";
import { issuerMatches, pkceChallengeFor, verifyIdToken } from "./oidc.js";
import { safeReturnTo } from "./policy.js";

/* ================================================================== */
/* A fake OpenID Provider, built from the published specs              */
/*                                                                     */
/* This sandbox cannot reach accounts.google.com, so the wire protocol */
/* is exercised against fixtures authored from OIDC Core 1.0 §3.1,     */
/* OIDC Discovery 1.0 §3 and RFC 7636. The IdP here behaves like a     */
/* real one: it enforces PKCE, checks the redirect URI and the client  */
/* credentials, and mints RS256 id_tokens against a published JWKS.    */
/* Everything an attacker would do — a token signed with a key that is */
/* not in the JWKS, a token for another audience, a replayed nonce —   */
/* it can do on request.                                               */
/* ================================================================== */

const IDP_ORIGIN = "https://idp.test";
const DISCOVERY_URL = `${IDP_ORIGIN}/.well-known/openid-configuration`;
const CLIENT_ID = "constructos-client-id";
const CLIENT_SECRET = "s3cr3t-client-secret-value";
const REDIRECT_URI = "http://localhost:5173/api/v1/auth/sso/callback";

interface MintOptions {
  nonce: string;
  claims?: Record<string, unknown>;
  issuer?: string;
  audience?: string;
  /** seconds from now */
  expiresIn?: number;
  issuedAtOffset?: number;
  signWith?: "published" | "rogue" | "hs256";
  kid?: string;
}

interface PendingCode {
  challenge: string;
  tokenBody: string;
  status: number;
}

class FakeIdp {
  publishedKid = "idp-key-1";
  private published!: CryptoKey;
  private publishedJwk!: JWK;
  private rogue!: CryptoKey;
  private codes = new Map<string, PendingCode>();

  requests: { method: string; url: string; body: string | null }[] = [];
  jwksFetches = 0;
  /** when set, the discovery response is replaced wholesale */
  discoveryOverride: SsoHttpResponse | null = null;

  async init(): Promise<void> {
    const a = await generateKeyPair("RS256", { extractable: true });
    const b = await generateKeyPair("RS256", { extractable: true });
    this.published = a.privateKey;
    this.rogue = b.privateKey;
    const jwk = await exportJWK(a.publicKey);
    this.publishedJwk = { ...jwk, kid: this.publishedKid, alg: "RS256", use: "sig" };
  }

  jwks(): JSONWebKeySet {
    return { keys: [this.publishedJwk] };
  }

  discoveryDocument(): Record<string, unknown> {
    return {
      issuer: IDP_ORIGIN,
      authorization_endpoint: `${IDP_ORIGIN}/authorize`,
      token_endpoint: `${IDP_ORIGIN}/token`,
      jwks_uri: `${IDP_ORIGIN}/jwks`,
      userinfo_endpoint: `${IDP_ORIGIN}/userinfo`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["openid", "email", "profile"],
    };
  }

  async mintIdToken(options: MintOptions): Promise<string> {
    const nowSec = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {
      nonce: options.nonce,
      ...(options.claims ?? {}),
    };
    const jwt = new SignJWT(payload)
      .setIssuer(options.issuer ?? IDP_ORIGIN)
      .setAudience(options.audience ?? CLIENT_ID)
      .setIssuedAt(nowSec + (options.issuedAtOffset ?? 0))
      .setExpirationTime(nowSec + (options.expiresIn ?? 300));
    if (options.signWith === "hs256") {
      return jwt
        .setProtectedHeader({ alg: "HS256", kid: options.kid ?? this.publishedKid })
        .sign(new TextEncoder().encode("the-rsa-public-key-used-as-an-hmac-secret"));
    }
    return jwt
      .setProtectedHeader({ alg: "RS256", kid: options.kid ?? this.publishedKid })
      .sign(options.signWith === "rogue" ? this.rogue : this.published);
  }

  /** Register an authorization code the token endpoint will honour. */
  async grant(options: MintOptions & { challenge: string }): Promise<string> {
    const code = `code_${newId()}`;
    const idToken = await this.mintIdToken(options);
    this.codes.set(code, {
      challenge: options.challenge,
      status: 200,
      tokenBody: JSON.stringify({
        access_token: `at_${newId()}`,
        token_type: "Bearer",
        expires_in: 3600,
        id_token: idToken,
      }),
    });
    return code;
  }

  /** Register a code whose token response omits the id_token entirely. */
  grantWithoutIdToken(challenge: string): string {
    const code = `code_${newId()}`;
    this.codes.set(code, {
      challenge,
      status: 200,
      tokenBody: JSON.stringify({ access_token: "at", token_type: "Bearer" }),
    });
    return code;
  }

  client(): SsoHttpClient {
    const respond = (method: string, url: string, body: string | null): SsoHttpResponse => {
      this.requests.push({ method, url, body });
      if (url === DISCOVERY_URL) {
        return (
          this.discoveryOverride ?? {
            status: 200,
            body: JSON.stringify(this.discoveryDocument()),
          }
        );
      }
      if (url === `${IDP_ORIGIN}/jwks`) {
        this.jwksFetches += 1;
        return { status: 200, body: JSON.stringify(this.jwks()) };
      }
      if (url === `${IDP_ORIGIN}/token`) return this.token(body ?? "");
      return { status: 404, body: JSON.stringify({ error: "not_found" }) };
    };
    return {
      async get(url) {
        return respond("GET", url, null);
      },
      async post(url, body) {
        return respond("POST", url, body);
      },
    };
  }

  private token(body: string): SsoHttpResponse {
    const form = new URLSearchParams(body);
    const fail = (error: string, description: string): SsoHttpResponse => ({
      status: 400,
      body: JSON.stringify({ error, error_description: description }),
    });
    if (form.get("grant_type") !== "authorization_code") {
      return fail("unsupported_grant_type", "only authorization_code is supported");
    }
    if (form.get("client_id") !== CLIENT_ID) return fail("invalid_client", "unknown client_id");
    if (form.get("client_secret") !== CLIENT_SECRET) {
      return fail("invalid_client", "client authentication failed");
    }
    if (form.get("redirect_uri") !== REDIRECT_URI) {
      return fail("invalid_grant", "redirect_uri does not match the authorization request");
    }
    const code = form.get("code") ?? "";
    const pending = this.codes.get(code);
    if (!pending) return fail("invalid_grant", "unknown or already-redeemed code");
    const verifier = form.get("code_verifier");
    if (!verifier) return fail("invalid_grant", "code_verifier is required (PKCE)");
    if (pkceChallengeFor(verifier) !== pending.challenge) {
      return fail("invalid_grant", "code_verifier does not match code_challenge");
    }
    // Authorization codes are single-use at any provider worth the name.
    this.codes.delete(code);
    return { status: pending.status, body: pending.tokenBody };
  }
}

/* ================================================================== */

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let idp: FakeIdp;
let owner: TestActor; // creates connections
let admin2: TestActor; // second admin — verifies domains
let outsider: TestActor; // a different tenant entirely
let bobId: string; // member of owner's company, bob@acme.test

const BOB_EMAIL = "bob@acme.test";

function cookieFrom(raw: string | string[] | undefined): string | null {
  if (!raw) return null;
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (!first) return null;
  const pair = first.split(";")[0];
  return pair ?? null;
}

async function createProvider(
  actor: TestActor,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/identity-providers",
    headers: actor.headers,
    payload: {
      kind: "oidc",
      displayName: "Acme SSO",
      discoveryUrl: DISCOVERY_URL,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      allowedEmailDomains: ["acme.test"],
      ...overrides,
    },
  });
  if (res.statusCode !== 201) throw new Error(`createProvider: ${res.statusCode} ${res.body}`);
  return (res.json() as { provider: Record<string, any> }).provider;
}

async function verifyDomains(id: string): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/identity-providers/${id}/verify-domains`,
    headers: { authorization: `Bearer ${admin2.accessToken}`, "x-company-id": owner.companyId },
  });
  if (res.statusCode !== 200) throw new Error(`verifyDomains: ${res.statusCode} ${res.body}`);
}

async function enableProvider(id: string): Promise<Record<string, any>> {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/identity-providers/${id}/enable`,
    headers: owner.headers,
  });
  if (res.statusCode !== 200) throw new Error(`enableProvider: ${res.statusCode} ${res.body}`);
  return (res.json() as { provider: Record<string, any> }).provider;
}

interface StartedFlow {
  state: string;
  nonce: string;
  challenge: string;
  cookie: string | null;
  authorizeUrl: URL;
}

async function startFlow(slug: string, extraQuery = ""): Promise<StartedFlow> {
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/auth/sso/${slug}/start?mode=json${extraQuery}`,
  });
  if (res.statusCode !== 302) throw new Error(`startFlow: ${res.statusCode} ${res.body}`);
  const authorizeUrl = new URL(res.headers.location as string);
  return {
    state: authorizeUrl.searchParams.get("state") ?? "",
    nonce: authorizeUrl.searchParams.get("nonce") ?? "",
    challenge: authorizeUrl.searchParams.get("code_challenge") ?? "",
    cookie: cookieFrom(res.headers["set-cookie"] as string | string[] | undefined),
    authorizeUrl,
  };
}

async function callback(flow: StartedFlow, code: string, opts: { cookie?: string | null } = {}) {
  const cookie = opts.cookie === undefined ? flow.cookie : opts.cookie;
  return app.inject({
    method: "GET",
    url: `/api/v1/auth/sso/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(flow.state)}`,
    headers: cookie ? { cookie } : {},
  });
}

/** Start → grant → callback, in one call, for the many tests that vary claims. */
async function signIn(
  slug: string,
  mint: Omit<MintOptions, "nonce"> & { nonce?: string },
) {
  const flow = await startFlow(slug);
  const code = await idp.grant({
    ...mint,
    nonce: mint.nonce ?? flow.nonce,
    challenge: flow.challenge,
  });
  return { flow, res: await callback(flow, code) };
}

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  idp = new FakeIdp();
  await idp.init();
  registerSsoHttpClient(app.db, idp.client());

  owner = await registerActor(app, { companyName: "Acme Construction" });
  admin2 = await registerActor(app);
  outsider = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: admin2.userId,
    role: "admin",
  });

  const bob = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: BOB_EMAIL, password: "password-123", name: "Bob Builder" },
  });
  bobId = (bob.json() as { user: { id: string } }).user.id;
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: bobId,
    role: "member",
  });
}, 60_000);

afterAll(async () => {
  await built.close();
});

/* ================================================================== */
describe("provider configuration", () => {
  it("fills the well-known Google endpoints and never echoes the secret", async () => {
    const provider = await createProvider(owner, {
      kind: "google",
      displayName: "Google Workspace",
      discoveryUrl: undefined,
      allowedEmailDomains: ["acme.test", "@ACME.co.uk."],
    });
    expect(provider.kind).toBe("google");
    expect(provider.discoveryUrl).toBe(
      "https://accounts.google.com/.well-known/openid-configuration",
    );
    expect(provider.issuer).toBe("https://accounts.google.com");
    expect(provider.scopes).toEqual(["openid", "email", "profile"]);
    // domains are normalised: lowercased, leading @ and trailing dot stripped
    expect(provider.allowedEmailDomains).toEqual(["acme.test", "acme.co.uk"]);
    expect(provider.isEnabled).toBe(false);
    expect(provider.redirectUri).toBe(REDIRECT_URI);

    const body = JSON.stringify(provider);
    expect(body).not.toContain(CLIENT_SECRET);
    expect(provider.clientSecretFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(provider.secretConfigured).toBe(true);
  });

  it("stores the client secret encrypted, not in the clear", async () => {
    const provider = await createProvider(owner, { displayName: "Encrypted secret check" });
    const [row] = await app.db
      .select()
      .from(identityProviders)
      .where(eq(identityProviders.id, provider.id))
      .limit(1);
    expect(row!.clientSecretCiphertext).toBeTruthy();
    expect(row!.clientSecretCiphertext).not.toContain(CLIENT_SECRET);
    expect(row!.clientSecretCiphertext!.startsWith("v1.")).toBe(true);
    // and it round-trips under the key the API derives from its own config
    const key = deriveSsoKey(app.appConfig);
    expect(decryptSecret(row!.clientSecretCiphertext!, key)).toBe(CLIENT_SECRET);
  });

  it("scopes a Microsoft connection to a single Entra tenant", async () => {
    const tenant = "11111111-2222-3333-4444-555555555555";
    const provider = await createProvider(owner, {
      kind: "microsoft",
      displayName: "Entra single tenant",
      discoveryUrl: undefined,
      tenantId: tenant,
    });
    expect(provider.discoveryUrl).toBe(
      `https://login.microsoftonline.com/${tenant}/v2.0/.well-known/openid-configuration`,
    );
    expect(provider.issuer).toBe(`https://login.microsoftonline.com/${tenant}/v2.0`);
    expect(provider.tenantId).toBe(tenant);
  });

  it("refuses provider configuration to a non-admin member", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/identity-providers",
      headers: { authorization: `Bearer ${outsider.accessToken}`, "x-company-id": owner.companyId },
      payload: { kind: "oidc", displayName: "Sneaky", discoveryUrl: DISCOVERY_URL },
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses to enable a connection that cannot work, and says why", async () => {
    const provider = await createProvider(owner, {
      displayName: "Half configured",
      clientId: undefined,
      clientSecret: undefined,
      allowedEmailDomains: [],
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/identity-providers/${provider.id}/enable`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(400);
    const reasons = (res.json() as { details: { reasons: string[] } }).details.reasons.join(" ");
    expect(reasons).toContain("clientId");
    expect(reasons).toContain("allowedEmailDomains");
  });

  it("reads and caches the discovery document through the injected client", async () => {
    const provider = await createProvider(owner, { displayName: "Discovery read" });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/identity-providers/${provider.id}/discovery`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { provider: Record<string, any>; discovery: Record<string, any> };
    expect(body.discovery.jwksUri).toBe(`${IDP_ORIGIN}/jwks`);
    expect(body.provider.tokenUrl).toBe(`${IDP_ORIGIN}/token`);
    expect(body.provider.discoveryFetchedAt).toBeTruthy();
  });

  it("refuses a discovery document that is missing a jwks_uri", async () => {
    const provider = await createProvider(owner, { displayName: "Broken discovery" });
    idp.discoveryOverride = {
      status: 200,
      body: JSON.stringify({
        issuer: IDP_ORIGIN,
        authorization_endpoint: `${IDP_ORIGIN}/authorize`,
        token_endpoint: `${IDP_ORIGIN}/token`,
      }),
    };
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/identity-providers/${provider.id}/discovery`,
      headers: owner.headers,
    });
    idp.discoveryOverride = null;
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toContain("jwks_uri");
  });

  it("will not let one administrator both configure a connection and verify its domains", async () => {
    const provider = await createProvider(owner, { displayName: "Separation of duties" });
    const self = await app.inject({
      method: "POST",
      url: `/api/v1/identity-providers/${provider.id}/verify-domains`,
      headers: owner.headers,
    });
    expect(self.statusCode).toBe(400);
    expect(self.json().message).toContain("cannot also be the one who confirms");

    const second = await app.inject({
      method: "POST",
      url: `/api/v1/identity-providers/${provider.id}/verify-domains`,
      headers: { authorization: `Bearer ${admin2.accessToken}`, "x-company-id": owner.companyId },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().provider.domainsVerifiedAt).toBeTruthy();
  });
});

/* ================================================================== */
describe("GET /auth/sso/providers — must not become an enumeration oracle", () => {
  let slug: string;

  beforeAll(async () => {
    const provider = await createProvider(owner, { displayName: "Discovery for domain" });
    await enableProvider(provider.id);
    slug = provider.slug;
  });

  it("returns the connections configured for an email domain", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/auth/sso/providers?email=${encodeURIComponent("someone@acme.test")}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { providers: { slug: string }[]; passwordLoginAllowed: boolean };
    expect(body.providers.map((p) => p.slug)).toContain(slug);
    expect(body.passwordLoginAllowed).toBe(true);
  });

  it("answers identically for an address that exists and one that does not", async () => {
    const existing = await app.inject({
      method: "GET",
      url: `/api/v1/auth/sso/providers?email=${encodeURIComponent(BOB_EMAIL)}`,
    });
    const invented = await app.inject({
      method: "GET",
      url: `/api/v1/auth/sso/providers?email=${encodeURIComponent("nobody-at-all@acme.test")}`,
    });
    expect(existing.statusCode).toBe(invented.statusCode);
    // byte-for-byte: the endpoint never reads the users table, so there is
    // nothing in the response that could differ
    expect(existing.body).toBe(invented.body);
    expect(existing.body).not.toContain("bob");
  });

  it("says nothing different about a domain with no connection", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/auth/sso/providers?email=${encodeURIComponent("someone@unconfigured.test")}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { providers: unknown[]; reasons: string[] };
    expect(body.providers).toEqual([]);
    expect(body.reasons.join(" ")).toContain("No SSO connection is configured");
  });
});

/* ================================================================== */
describe("GET /auth/sso/:provider/start", () => {
  let slug: string;

  beforeAll(async () => {
    const provider = await createProvider(owner, { displayName: "Start flow" });
    await enableProvider(provider.id);
    slug = provider.slug;
  });

  it("redirects with response_type=code, PKCE S256 and the exact redirect URI", async () => {
    const flow = await startFlow(slug);
    const q = flow.authorizeUrl.searchParams;
    expect(flow.authorizeUrl.origin + flow.authorizeUrl.pathname).toBe(`${IDP_ORIGIN}/authorize`);
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe(CLIENT_ID);
    expect(q.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(q.get("scope")).toBe("openid email profile");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("state")!.length).toBeGreaterThan(30);
    expect(q.get("nonce")!.length).toBeGreaterThan(30);
    expect(flow.cookie).toContain("cos_sso_state=");
  });

  it("mints unpredictable, unrelated state on every start", async () => {
    const a = await startFlow(slug);
    const b = await startFlow(slug);
    expect(a.state).not.toBe(b.state);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.challenge).not.toBe(b.challenge);
    // nothing user-supplied is encoded into it
    expect(a.authorizeUrl.toString()).not.toContain("returnTo");
  });

  it("refuses to carry an off-site returnTo into the flow", async () => {
    expect(safeReturnTo("https://evil.test/steal")).toBeNull();
    expect(safeReturnTo("//evil.test/steal")).toBeNull();
    expect(safeReturnTo("/projects/123?tab=rfis")).toBe("/projects/123?tab=rfis");
    const flow = await startFlow(slug, "&returnTo=https%3A%2F%2Fevil.test%2Fsteal");
    expect(flow.authorizeUrl.toString()).not.toContain("evil.test");
  });

  it("lets two tabs have sign-ins in the air at once", async () => {
    const first = await startFlow(slug);
    // the second start carries the first tab's cookie, as a browser would
    const secondRes = await app.inject({
      method: "GET",
      url: `/api/v1/auth/sso/${slug}/start?mode=json`,
      headers: first.cookie ? { cookie: first.cookie } : {},
    });
    const secondUrl = new URL(secondRes.headers.location as string);
    const second: StartedFlow = {
      state: secondUrl.searchParams.get("state")!,
      nonce: secondUrl.searchParams.get("nonce")!,
      challenge: secondUrl.searchParams.get("code_challenge")!,
      cookie: cookieFrom(secondRes.headers["set-cookie"] as string | string[] | undefined),
      authorizeUrl: secondUrl,
    };
    // the browser now holds both bindings; the FIRST tab finishing must work
    const code = await idp.grant({
      nonce: first.nonce,
      challenge: first.challenge,
      claims: { sub: "bob-two-tabs", email: BOB_EMAIL, email_verified: true },
    });
    const res = await callback(first, code, { cookie: second.cookie });
    expect(res.statusCode).toBe(200);
  });

  it("refuses to start a disabled connection", async () => {
    const provider = await createProvider(owner, { displayName: "Never enabled" });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/auth/sso/${provider.slug}/start`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("not enabled");
  });
});

/* ================================================================== */
describe("the callback verifies the id_token before it believes anything", () => {
  let slug: string;
  let providerId: string;

  beforeAll(async () => {
    const provider = await createProvider(owner, { displayName: "Verification" });
    await enableProvider(provider.id);
    slug = provider.slug;
    providerId = provider.id;
  });

  async function identityCount(): Promise<number> {
    const rows = await app.db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.providerId, providerId));
    return rows.length;
  }

  it("signs a known member in and issues the same session shape password login does", async () => {
    const before = idp.requests.length;
    const { res } = await signIn(slug, {
      claims: { sub: "bob-subject-1", email: BOB_EMAIL, email_verified: true, name: "Bob Builder" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, any>;
    expect(body.user.id).toBe(bobId);
    expect(body.user.email).toBe(BOB_EMAIL);
    expect(body.company.id).toBe(owner.companyId);
    expect(typeof body.accessToken).toBe("string");
    expect(typeof body.refreshToken).toBe("string");
    expect(body.expiresIn).toBe(app.appConfig.ACCESS_TOKEN_TTL_SECONDS);
    expect(body.session.authMethod).toBe("sso");
    expect(body.identity.linkedNow).toBe(true);
    expect(body.provisioned).toBe(false);

    // the access token really works
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().id).toBe(bobId);

    // and a session row exists, bound to the identity and the provider
    const [session] = await app.db
      .select()
      .from(authSessions)
      .where(eq(authSessions.id, body.session.id))
      .limit(1);
    expect(session!.authMethod).toBe("sso");
    expect(session!.identityId).toBe(body.identity.id);
    expect(session!.refreshTokenId).toBeTruthy();

    // the token exchange carried a code_verifier that hashes to the challenge
    const tokenCall = idp.requests
      .slice(before)
      .find((r) => r.method === "POST" && r.url === `${IDP_ORIGIN}/token`);
    const form = new URLSearchParams(tokenCall!.body ?? "");
    expect(form.get("code_verifier")).toBeTruthy();
    expect(form.get("grant_type")).toBe("authorization_code");
  });

  it("binds the PKCE verifier to the challenge that went to the provider", async () => {
    const flow = await startFlow(slug);
    const before = idp.requests.length;
    const code = await idp.grant({
      nonce: flow.nonce,
      challenge: flow.challenge,
      claims: { sub: "bob-subject-1", email: BOB_EMAIL, email_verified: true },
    });
    const res = await callback(flow, code);
    expect(res.statusCode).toBe(200);
    const tokenCall = idp.requests
      .slice(before)
      .find((r) => r.method === "POST" && r.url === `${IDP_ORIGIN}/token`);
    const verifier = new URLSearchParams(tokenCall!.body ?? "").get("code_verifier")!;
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(flow.challenge);
  });

  it("rejects an id_token signed with a key that is not in the JWKS", async () => {
    const before = await identityCount();
    const { res } = await signIn(slug, {
      signWith: "rogue",
      claims: { sub: "forged-subject", email: BOB_EMAIL, email_verified: true },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toContain("signature did not verify");
    expect(await identityCount()).toBe(before);
  });

  it("rejects an id_token from the wrong issuer", async () => {
    const { res } = await signIn(slug, {
      issuer: "https://evil-idp.test",
      claims: { sub: "bob-subject-1", email: BOB_EMAIL, email_verified: true },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().message.toLowerCase()).toContain("issuer");
  });

  it("rejects an id_token minted for a different audience", async () => {
    const { res } = await signIn(slug, {
      audience: "some-other-application",
      claims: { sub: "bob-subject-1", email: BOB_EMAIL, email_verified: true },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().message.toLowerCase()).toContain("audience");
  });

  it("rejects an expired id_token", async () => {
    const { res } = await signIn(slug, {
      expiresIn: -3600,
      issuedAtOffset: -7200,
      claims: { sub: "bob-subject-1", email: BOB_EMAIL, email_verified: true },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toContain("expired");
  });

  it("rejects an HMAC-signed id_token (the alg-confusion forgery)", async () => {
    const { res } = await signIn(slug, {
      signWith: "hs256",
      claims: { sub: "bob-subject-1", email: BOB_EMAIL, email_verified: true },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an id_token whose nonce belongs to a different sign-in", async () => {
    const { res } = await signIn(slug, {
      nonce: "a-nonce-from-somewhere-else",
      claims: { sub: "bob-subject-1", email: BOB_EMAIL, email_verified: true },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toContain("nonce");
  });

  it("spends state on first use — a replayed callback is refused", async () => {
    const flow = await startFlow(slug);
    const first = await idp.grant({
      nonce: flow.nonce,
      challenge: flow.challenge,
      claims: { sub: "bob-subject-1", email: BOB_EMAIL, email_verified: true },
    });
    expect((await callback(flow, first)).statusCode).toBe(200);

    const second = await idp.grant({
      nonce: flow.nonce,
      challenge: flow.challenge,
      claims: { sub: "bob-subject-1", email: BOB_EMAIL, email_verified: true },
    });
    const replay = await callback(flow, second);
    expect(replay.statusCode).toBe(400);
    expect(replay.json().message).toContain("single-use");
  });

  it("refuses a callback carrying a state this server never issued", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/sso/callback?code=whatever&state=a-state-nobody-here-minted",
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a callback that did not start in this browser", async () => {
    const flow = await startFlow(slug);
    const code = await idp.grant({
      nonce: flow.nonce,
      challenge: flow.challenge,
      claims: { sub: "bob-subject-1", email: BOB_EMAIL, email_verified: true },
    });
    const res = await callback(flow, code, { cookie: "cos_sso_state=not-the-binding-value" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("did not start in this browser");
  });

  it("fails closed when the PKCE verifier is stripped in transit", async () => {
    // A downgrade attempt: something between us and the provider drops the
    // verifier. The provider enforces PKCE, so the exchange fails and no
    // session is issued — the flow degrades to refusal, never to a plain
    // authorization code exchange.
    const real = idp.client();
    registerSsoHttpClient(app.db, {
      get: real.get.bind(real),
      async post(url, body, headers) {
        const form = new URLSearchParams(body);
        form.delete("code_verifier");
        return real.post(url, form.toString(), headers);
      },
    });
    const { res } = await signIn(slug, {
      claims: { sub: "bob-subject-1", email: BOB_EMAIL, email_verified: true },
    });
    registerSsoHttpClient(app.db, idp.client());
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toContain("invalid_grant");
  });

  it("refuses a token response with no id_token instead of inventing a user", async () => {
    const flow = await startFlow(slug);
    const code = idp.grantWithoutIdToken(flow.challenge);
    const res = await callback(flow, code);
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toContain("no id_token");
  });

  it("records every refusal in the account-security trail", async () => {
    const rows = await app.db
      .select()
      .from(authSecurityEvents)
      .where(eq(authSecurityEvents.kind, "sso_login_failure"));
    expect(rows.length).toBeGreaterThan(0);
  });
});

/* ================================================================== */
describe("account linking is where SSO gets breached", () => {
  it("refuses to reach an existing account on an UNVERIFIED email claim", async () => {
    const provider = await createProvider(owner, { displayName: "Takeover attempt" });
    await enableProvider(provider.id);

    // The attacker controls an account at the identity provider and has typed
    // the victim's address into it. The provider does not vouch for it.
    const { res } = await signIn(provider.slug, {
      claims: {
        sub: "attacker-subject",
        email: BOB_EMAIL,
        email_verified: false,
        name: "Not Bob",
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toContain("did not assert");

    // nothing was linked, and Bob's account is untouched
    const identities = await app.db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.externalSubject, "attacker-subject"));
    expect(identities).toHaveLength(0);
    const [bob] = await app.db.select().from(users).where(eq(users.id, bobId)).limit(1);
    expect(bob!.email).toBe(BOB_EMAIL);
    expect(bob!.name).toBe("Bob Builder");
  });

  it("refuses an address outside the connection's allowed domains", async () => {
    const provider = await createProvider(owner, { displayName: "Domain fence" });
    await enableProvider(provider.id);
    const { res } = await signIn(provider.slug, {
      claims: {
        sub: "outsider-subject",
        email: "ceo@some-other-company.test",
        email_verified: true,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("not in a domain this SSO connection is allowed");
  });

  it("refuses when the provider asserts no email at all", async () => {
    const provider = await createProvider(owner, { displayName: "No email claim" });
    await enableProvider(provider.id);
    const { res } = await signIn(provider.slug, {
      claims: { sub: "anonymous-subject", name: "Nameless" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toContain("no email address");
  });

  it("requires authentication to start a link flow", async () => {
    const provider = await createProvider(owner, { displayName: "Link auth gate" });
    await enableProvider(provider.id);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/sso/link",
      payload: { providerId: provider.id },
    });
    expect(res.statusCode).toBe(401);
  });

  it("links on an unverified email when — and only when — the user is signed in", async () => {
    const provider = await createProvider(owner, { displayName: "Authenticated link" });
    await enableProvider(provider.id);

    const start = await app.inject({
      method: "POST",
      url: "/api/v1/auth/sso/link",
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { providerId: provider.id, mode: "json" },
    });
    expect(start.statusCode).toBe(200);
    const authorizeUrl = new URL((start.json() as { authorizationUrl: string }).authorizationUrl);
    const flow: StartedFlow = {
      state: authorizeUrl.searchParams.get("state")!,
      nonce: authorizeUrl.searchParams.get("nonce")!,
      challenge: authorizeUrl.searchParams.get("code_challenge")!,
      cookie: cookieFrom(start.headers["set-cookie"] as string | string[] | undefined),
      authorizeUrl,
    };
    const code = await idp.grant({
      nonce: flow.nonce,
      challenge: flow.challenge,
      // deliberately an unverified address, and one belonging to somebody else
      claims: { sub: "owner-google-subject", email: BOB_EMAIL, email_verified: false },
    });
    const res = await callback(flow, code);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, any>;
    expect(body.linked).toBe(true);
    expect(body.emailVerifiedByProvider).toBe(false);
    // no session is issued and, critically, the identity is bound to the
    // ACCOUNT THAT STARTED THE FLOW — not to the address that was claimed
    expect(body.accessToken).toBeUndefined();
    const [identity] = await app.db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.externalSubject, "owner-google-subject"))
      .limit(1);
    expect(identity!.userId).toBe(owner.userId);
    expect(identity!.userId).not.toBe(bobId);
  });

  it("refuses to link an identity that already belongs to another account", async () => {
    const provider = await createProvider(owner, { displayName: "Double link" });
    await enableProvider(provider.id);

    const linkFlow = async (token: string) => {
      const start = await app.inject({
        method: "POST",
        url: "/api/v1/auth/sso/link",
        headers: { authorization: `Bearer ${token}` },
        payload: { providerId: provider.id, mode: "json" },
      });
      const url = new URL((start.json() as { authorizationUrl: string }).authorizationUrl);
      return {
        state: url.searchParams.get("state")!,
        nonce: url.searchParams.get("nonce")!,
        challenge: url.searchParams.get("code_challenge")!,
        cookie: cookieFrom(start.headers["set-cookie"] as string | string[] | undefined),
        authorizeUrl: url,
      } satisfies StartedFlow;
    };

    const first = await linkFlow(owner.accessToken);
    const firstCode = await idp.grant({
      nonce: first.nonce,
      challenge: first.challenge,
      claims: { sub: "shared-subject", email: "someone@acme.test", email_verified: true },
    });
    expect((await callback(first, firstCode)).statusCode).toBe(200);

    const second = await linkFlow(admin2.accessToken);
    const secondCode = await idp.grant({
      nonce: second.nonce,
      challenge: second.challenge,
      claims: { sub: "shared-subject", email: "someone@acme.test", email_verified: true },
    });
    const res = await callback(second, secondCode);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("already linked to a different");
  });
});

/* ================================================================== */
describe("provisioning", () => {
  it("refuses to create an account when the connection may not provision", async () => {
    const provider = await createProvider(owner, { displayName: "No provisioning" });
    await enableProvider(provider.id);
    const { res } = await signIn(provider.slug, {
      claims: { sub: "newcomer-1", email: "newcomer@acme.test", email_verified: true },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("not permitted to create one");
  });

  it("refuses to provision from a domain nobody has confirmed the company controls", async () => {
    const provider = await createProvider(owner, {
      displayName: "Unverified domains",
      autoProvision: true,
    });
    // enable is refused outright while autoProvision has no verified domains
    const enable = await app.inject({
      method: "POST",
      url: `/api/v1/identity-providers/${provider.id}/enable`,
      headers: owner.headers,
    });
    expect(enable.statusCode).toBe(400);
    expect((enable.json() as any).details.reasons.join(" ")).toContain("verify-domains");
  });

  it("provisions a user, a membership and a mapped role once the domains are verified", async () => {
    const provider = await createProvider(owner, {
      displayName: "JIT provisioning",
      autoProvision: true,
      defaultCompanyRole: "member",
      groupClaimName: "groups",
      groupRoleMappings: [
        { claimValue: "construction-admins", companyRole: "admin" },
        { claimValue: "everyone", companyRole: "guest" },
      ],
    });
    await verifyDomains(provider.id);
    await enableProvider(provider.id);

    const { res } = await signIn(provider.slug, {
      claims: {
        sub: "jit-subject-1",
        email: "newhire@acme.test",
        email_verified: true,
        name: "New Hire",
        groups: ["everyone", "construction-admins"],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, any>;
    expect(body.provisioned).toBe(true);
    // first match wins, in the order the administrator wrote them
    expect(body.company.role).toBe("admin");

    const [created] = await app.db
      .select()
      .from(users)
      .where(eq(users.email, "newhire@acme.test"))
      .limit(1);
    expect(created!.name).toBe("New Hire");
    // an SSO-provisioned account has no usable password
    expect(created!.passwordHash.startsWith("sso-only:")).toBe(true);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "newhire@acme.test", password: "password-123" },
    });
    expect(login.statusCode).toBe(401);

    const membership = await app.db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, owner.companyId),
          eq(companyMemberships.userId, created!.id),
        ),
      );
    expect(membership[0]!.role).toBe("admin");

    const events = await app.db
      .select()
      .from(authSecurityEvents)
      .where(eq(authSecurityEvents.kind, "sso_user_provisioned"));
    expect(events.some((e) => e.userId === created!.id)).toBe(true);

    const ledger = await app.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.objectId, created!.id));
    expect(ledger.length).toBeGreaterThan(0);
  });

  it("signs the provisioned user back in without creating a second account", async () => {
    const before = await app.db
      .select()
      .from(users)
      .where(eq(users.email, "newhire@acme.test"));
    const provider = await app.db
      .select()
      .from(identityProviders)
      .where(eq(identityProviders.displayName, "JIT provisioning"))
      .limit(1);
    const { res } = await signIn(provider[0]!.slug, {
      claims: { sub: "jit-subject-1", email: "newhire@acme.test", email_verified: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().provisioned).toBe(false);
    const after = await app.db
      .select()
      .from(users)
      .where(eq(users.email, "newhire@acme.test"));
    expect(after.length).toBe(before.length);
  });

  it("refuses an account that exists but is not a member of the connection's company", async () => {
    const provider = await createProvider(owner, { displayName: "Stranger with an account" });
    await enableProvider(provider.id);
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "stranger@acme.test", password: "password-123", name: "Stranger" },
    });
    const { res } = await signIn(provider.slug, {
      claims: { sub: "stranger-subject", email: "stranger@acme.test", email_verified: true },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("not a member of the company");
  });
});

/* ================================================================== */
describe("unlinking cannot lock anyone out", () => {
  it("refuses to remove the last sign-in method of an SSO-only account", async () => {
    const provider = await createProvider(owner, {
      displayName: "Last method guard",
      autoProvision: true,
    });
    await verifyDomains(provider.id);
    await enableProvider(provider.id);
    const { res } = await signIn(provider.slug, {
      claims: { sub: "only-sso-subject", email: "onlysso@acme.test", email_verified: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, any>;

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/auth/sso/identities",
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(list.json().signInMethods.password).toBe(false);
    expect(list.json().signInMethods.total).toBe(1);

    const remove = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/sso/identities/${body.identity.id}`,
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(remove.statusCode).toBe(409);
    expect(remove.json().message).toContain("last sign-in method");

    const still = await app.db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.id, body.identity.id));
    expect(still).toHaveLength(1);
  });

  it("unlinks when a password remains, and kills the sessions that identity opened", async () => {
    const provider = await createProvider(owner, { displayName: "Unlink with password" });
    await enableProvider(provider.id);
    const { res } = await signIn(provider.slug, {
      claims: { sub: "bob-unlink-subject", email: BOB_EMAIL, email_verified: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, any>;

    const remove = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/sso/identities/${body.identity.id}`,
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(remove.statusCode).toBe(200);
    expect(remove.json().sessionsRevoked).toBe(1);

    const [session] = await app.db
      .select()
      .from(authSessions)
      .where(eq(authSessions.id, body.session.id))
      .limit(1);
    expect(session!.revokedAt).toBeTruthy();
    expect(session!.revokedReason).toBe("sso_policy_changed");

    // and the refresh token that session held is dead
    const refresh = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: body.refreshToken },
    });
    expect(refresh.statusCode).toBe(401);

    const unlinkEvents = await app.db
      .select()
      .from(authSecurityEvents)
      .where(eq(authSecurityEvents.kind, "sso_identity_unlinked"));
    expect(unlinkEvents.length).toBeGreaterThan(0);
  });

  it("cannot unlink an identity belonging to somebody else", async () => {
    const provider = await createProvider(owner, { displayName: "Other people's identities" });
    await enableProvider(provider.id);
    const { res } = await signIn(provider.slug, {
      claims: { sub: "bob-other-subject", email: BOB_EMAIL, email_verified: true },
    });
    const identityId = (res.json() as Record<string, any>).identity.id;
    const remove = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/sso/identities/${identityId}`,
      headers: { authorization: `Bearer ${outsider.accessToken}` },
    });
    expect(remove.statusCode).toBe(404);
  });
});

/* ================================================================== */
describe("the enterprise control: requiring SSO", () => {
  it("refuses to disable password login while no SSO sign-in has ever worked", async () => {
    const provider = await createProvider(owner, { displayName: "Premature enforcement" });
    await enableProvider(provider.id);
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/identity-providers/${provider.id}/password-login`,
      headers: owner.headers,
      payload: { allowPasswordLogin: false },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { details: { reasons: string[]; risk: string } };
    expect(body.details.reasons.join(" ")).toContain("has never carried a real sign-in");
    expect(body.details.risk).toContain("lockout");
  });

  it("allows it once somebody has actually signed in, and says so publicly", async () => {
    const provider = await createProvider(owner, {
      displayName: "Enforced SSO",
      allowedEmailDomains: ["enforced.test"],
      autoProvision: true,
    });
    await verifyDomains(provider.id);
    await enableProvider(provider.id);
    const { res: signInRes } = await signIn(provider.slug, {
      claims: { sub: "enforced-subject", email: "chief@enforced.test", email_verified: true },
    });
    expect(signInRes.statusCode).toBe(200);

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/identity-providers/${provider.id}/password-login`,
      headers: owner.headers,
      payload: { allowPasswordLogin: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().provider.allowPasswordLogin).toBe(false);
    expect(res.json().warning).toContain("no other way in");

    const publicView = await app.inject({
      method: "GET",
      url: `/api/v1/auth/sso/providers?email=${encodeURIComponent("anyone@enforced.test")}`,
    });
    expect(publicView.json().passwordLoginAllowed).toBe(false);

    // and with password login off, that user's only identity is now protected
    const identityRows = await app.db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.externalSubject, "enforced-subject"));
    const body = signInRes.json() as Record<string, any>;
    const remove = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/sso/identities/${identityRows[0]!.id}`,
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(remove.statusCode).toBe(409);

    // restore, so the shared fixtures are not left in an enforced state
    await app.inject({
      method: "POST",
      url: `/api/v1/identity-providers/${provider.id}/disable`,
      headers: owner.headers,
      payload: { reason: "test teardown" },
    });
  });
});

/* ================================================================== */
describe("SAML is configurable and honestly refuses to run", () => {
  it("stores a SAML connection but will not start, enable or link one", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/identity-providers",
      headers: owner.headers,
      payload: {
        kind: "saml",
        displayName: "Legacy SAML IdP",
        samlEntityId: "urn:acme:idp",
        samlSsoUrl: "https://idp.test/saml/sso",
        samlBinding: "http_post",
        samlCertificatePem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
        allowedEmailDomains: ["acme.test"],
      },
    });
    expect(res.statusCode).toBe(201);
    const provider = (res.json() as { provider: Record<string, any> }).provider;
    expect(provider.readiness.ready).toBeNull();
    expect(provider.readiness.reasons.join(" ")).toContain("XML Digital Signature");

    const enable = await app.inject({
      method: "POST",
      url: `/api/v1/identity-providers/${provider.id}/enable`,
      headers: owner.headers,
    });
    expect(enable.statusCode).toBe(501);
    expect(enable.json().message).toContain("authentication bypass");

    const start = await app.inject({
      method: "GET",
      url: `/api/v1/auth/sso/${provider.slug}/start`,
    });
    expect(start.statusCode).toBe(501);
    expect(start.json().message).toContain("XML-DSIG");
  });
});

/* ================================================================== */
describe("Microsoft Entra's templated issuer", () => {
  const TENANT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const OTHER_TENANT = "ffffffff-1111-2222-3333-444444444444";
  const TEMPLATE = "https://login.microsoftonline.com/{tenantid}/v2.0";

  it("matches a real tenant GUID against the metadata template", () => {
    expect(issuerMatches(TEMPLATE, `https://login.microsoftonline.com/${TENANT}/v2.0`)).toBe(true);
    expect(issuerMatches(TEMPLATE, "https://login.microsoftonline.com/evil/v2.0")).toBe(false);
    expect(issuerMatches(TEMPLATE, `https://login.microsoftonline.com.evil.test/${TENANT}/v2.0`)).toBe(
      false,
    );
    expect(issuerMatches("https://accounts.google.com", "https://accounts.google.com")).toBe(true);
    expect(issuerMatches("https://accounts.google.com", "https://accounts.google.com/")).toBe(false);
  });

  it("accepts a token from the configured tenant and refuses one from any other", async () => {
    const base = {
      jwks: idp.jwks(),
      expectedIssuer: TEMPLATE,
      audience: CLIENT_ID,
      nonce: "the-nonce",
      nowMs: Date.now(),
    };
    const good = await idp.mintIdToken({
      nonce: "the-nonce",
      issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
      claims: { sub: "entra-user", tid: TENANT, email: "a@acme.test", email_verified: true },
    });
    const payload = await verifyIdToken({ ...base, idToken: good, tenantId: TENANT });
    expect(payload["sub"]).toBe("entra-user");

    // the same, correctly signed token — but this connection is bound to a
    // different directory, and `organizations` would otherwise let ANY Entra
    // tenant on the internet sign in
    await expect(
      verifyIdToken({ ...base, idToken: good, tenantId: OTHER_TENANT }),
    ).rejects.toThrow(/tenant/i);
  });
});

/* ================================================================== */
describe("redirect mode never puts a token in a URL", () => {
  it("hands the browser a single-use ticket and swaps it for the session over POST", async () => {
    const provider = await createProvider(owner, { displayName: "Redirect mode" });
    await enableProvider(provider.id);

    const started = await app.inject({
      method: "GET",
      url: `/api/v1/auth/sso/${provider.slug}/start?mode=redirect&returnTo=%2Fprojects`,
    });
    const authorizeUrl = new URL(started.headers.location as string);
    const flow: StartedFlow = {
      state: authorizeUrl.searchParams.get("state")!,
      nonce: authorizeUrl.searchParams.get("nonce")!,
      challenge: authorizeUrl.searchParams.get("code_challenge")!,
      cookie: cookieFrom(started.headers["set-cookie"] as string | string[] | undefined),
      authorizeUrl,
    };
    const code = await idp.grant({
      nonce: flow.nonce,
      challenge: flow.challenge,
      claims: { sub: "redirect-mode-subject", email: BOB_EMAIL, email_verified: true },
    });
    const res = await callback(flow, code);
    expect(res.statusCode).toBe(302);
    const landing = new URL(res.headers.location as string);
    expect(landing.pathname).toBe("/auth/sso/complete");
    expect(landing.searchParams.get("returnTo")).toBe("/projects");
    const ticket = landing.searchParams.get("ticket")!;
    expect(ticket).toBeTruthy();
    // the redirect carries no credential of any kind
    expect(res.headers.location).not.toContain("refreshToken");
    expect(res.headers.location).not.toContain("accessToken");

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/auth/sso/ticket",
      payload: { ticket },
    });
    expect(first.statusCode).toBe(200);
    expect(typeof first.json().accessToken).toBe("string");

    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/auth/sso/ticket",
      payload: { ticket },
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().message).toContain("single-use");
  });
});
