/**
 * User SSO — Google, Microsoft Entra and generic OpenID Connect, per tenant.
 *
 * NOT the same thing as modules/integrations/oauth.ts. That is a MACHINE
 * caller authenticating as itself with a client-credentials grant, whose
 * authority is a set of `tool:level` scopes. This is a PERSON authenticating
 * at their own employer's identity provider and arriving with an assertion
 * about who they are; the two share the hashed-credential idiom and nothing
 * else, and must never share a code path.
 *
 * WHAT IS IMPLEMENTED
 * -------------------
 * The full authorization code flow with PKCE (RFC 7636), server-side single-use
 * state, a nonce bound into the id_token, signature verification against the
 * provider's JWKS, and issuer / audience / azp / expiry / tenant checks. The
 * protocol lives in oidc.ts, the tenant policy in policy.ts, the in-flight
 * correlation in state.ts, and every outbound call goes through the injected
 * client in http.ts so the whole thing is exercised against fixtures.
 *
 * THE THREE RULES THAT SHAPE THE CALLBACK
 * ---------------------------------------
 *  1. Nothing is believed before the signature verifies. There is no decode
 *     path in this file at all.
 *  2. An account is never matched by an unverified email. A provider that
 *     does not assert `email_verified` (or Entra's `xms_edov`) is asserting
 *     "somebody typed this address", and treating that as identity is the
 *     single most common way an SSO integration is turned into a takeover.
 *  3. Linking a provider to an existing account requires either a bearer
 *     token proving the account holder is present, or a verified address in a
 *     domain the connection is entitled to speak for. Never one of those
 *     halves on its own.
 *
 * SAML is configurable and refuses to run — see SAML_UNSUPPORTED_REASON. An
 * assertion whose XML signature is not verified is an authentication bypass,
 * and this repository has no XML-DSIG implementation to verify it with.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { and, count, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { z } from "zod";
import {
  authSecurityEvents,
  authSessions,
  companyMemberships,
  identityProviders,
  refreshTokens,
  userIdentities,
  users,
} from "@constructos/db";
import { sha256Hex } from "@constructos/ledger";
import {
  COMPANY_ROLES,
  IDENTITY_PROVIDER_KINDS,
  SAML_BINDINGS,
  SSO_SECRET_STORAGE_MODES,
  type AuthEventKind,
  type AuthEventOutcome,
  type CompanyRole,
  type IdentityProviderKind,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import type { Db } from "../../lib/db.js";
import { appendLedger } from "../../lib/ledger.js";
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from "../../lib/errors.js";
import { buildAppUrl } from "../../lib/email.js";
import {
  createFetchSsoClient,
  getSsoHttpClient,
  registerSsoHttpClient,
  type SsoHttpClient,
} from "./http.js";
import {
  DEFAULT_JWKS_OPTIONS,
  JwksStore,
  buildAuthorizationUrl,
  createPkcePair,
  exchangeCode,
  extractIdentity,
  fetchDiscovery,
  fetchUserinfo,
  microsoftTenantOf,
  providerDefaults,
  verifyIdToken,
  type AssertedIdentity,
} from "./oidc.js";
import { signSessionAccessToken } from "../account/sessions.js";
import {
  SAML_UNSUPPORTED_REASON,
  deviceLabelFor,
  deviceSignature,
  domainAllowed,
  emailDomain,
  hasUsablePassword,
  markSsoOnlyPassword,
  normalizeDomains,
  parseGroupMappings,
  providerReadiness,
  redirectUriFor,
  resolveRole,
  safeReturnTo,
} from "./policy.js";
import {
  deriveSsoKey,
  encryptSecret,
  resolveClientSecret,
  secretFingerprint,
  timingSafeEqualString,
} from "./secrets.js";
import { getStateStore, randomToken, type SsoFlowRecord } from "./state.js";

type ProviderRow = typeof identityProviders.$inferSelect;

/** How long a half-finished sign-in stays answerable. */
const FLOW_TTL_MS = 10 * 60 * 1000;
/** How long the browser has to swap its ticket for a session. */
const TICKET_TTL_MS = 2 * 60 * 1000;
const STATE_COOKIE = "cos_sso_state";

/* ------------------------------------------------------------------ */
/* Request schemas                                                     */
/* ------------------------------------------------------------------ */

const slugPattern = /^[a-z0-9][a-z0-9-]{1,47}$/;

const groupMappingSchema = z.object({
  claimValue: z.string().min(1).max(200),
  companyRole: z.enum(COMPANY_ROLES),
  templateKey: z.string().min(1).max(80).optional(),
});

const httpsUrl = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (v) => {
      try {
        const u = new URL(v);
        return (
          u.protocol === "https:" ||
          u.hostname === "localhost" ||
          u.hostname === "127.0.0.1" ||
          u.hostname === "::1"
        );
      } catch {
        return false;
      }
    },
    { message: "must be an absolute https URL (loopback excepted)" },
  );

const providerCoreSchema = z.object({
  displayName: z.string().min(1).max(120),
  slug: z.string().regex(slugPattern, "lowercase letters, digits and hyphens").optional(),
  /** Microsoft Entra directory (tenant) id — a GUID for a single-tenant app */
  tenantId: z.string().min(1).max(120).optional(),
  issuer: z.string().min(1).max(512).optional(),
  discoveryUrl: httpsUrl.optional(),
  authorizationUrl: httpsUrl.optional(),
  tokenUrl: httpsUrl.optional(),
  userinfoUrl: httpsUrl.optional(),
  jwksUri: httpsUrl.optional(),
  clientId: z.string().min(1).max(512).optional(),
  /** write-only; never returned by any route */
  clientSecret: z.string().min(1).max(1024).optional(),
  secretStorage: z.enum(SSO_SECRET_STORAGE_MODES).optional(),
  clientSecretRef: z.string().min(1).max(512).optional(),
  scopes: z.array(z.string().min(1).max(80)).min(1).max(30).optional(),
  samlEntityId: z.string().min(1).max(512).optional(),
  samlSsoUrl: httpsUrl.optional(),
  samlBinding: z.enum(SAML_BINDINGS).optional(),
  samlCertificatePem: z.string().min(1).max(20000).optional(),
  samlWantAssertionsSigned: z.boolean().optional(),
  allowedEmailDomains: z.array(z.string().min(1).max(253)).max(50).optional(),
  autoProvision: z.boolean().optional(),
  defaultCompanyRole: z.enum(COMPANY_ROLES).optional(),
  defaultTemplateKey: z.string().min(1).max(80).optional(),
  groupClaimName: z.string().min(1).max(120).optional(),
  groupRoleMappings: z.array(groupMappingSchema).max(100).optional(),
  /**
   * WP-AUTH — projects a JIT-provisioned member is given access to, under
   * `defaultTemplateKey`. Without this the template key was resolved,
   * ledgered and applied to nothing: a provisioned user held a company
   * membership and could not open a single project.
   */
  provisionProjectIds: z.array(z.string().min(1).max(64)).max(200).optional(),
  /** WP-AUTH — does this IdP perform MFA itself? See the schema comment. */
  idpPerformsMfa: z.boolean().optional(),
  /** amr/acr values that count as a second factor, e.g. ["mfa","otp","hwk"] */
  mfaAmrValues: z.array(z.string().min(1).max(64)).max(20).optional(),
});

const createProviderSchema = providerCoreSchema.extend({
  kind: z.enum(IDENTITY_PROVIDER_KINDS),
});

const updateProviderSchema = providerCoreSchema.partial();

const startQuerySchema = z.object({
  returnTo: z.string().max(512).optional(),
  mode: z.enum(["json", "redirect"]).default("redirect"),
  loginHint: z.string().email().max(320).optional(),
  prompt: z.enum(["login", "select_account", "consent", "none"]).optional(),
});

const callbackQuerySchema = z.object({
  code: z.string().min(1).max(4096).optional(),
  state: z.string().min(1).max(512).optional(),
  error: z.string().max(200).optional(),
  error_description: z.string().max(1000).optional(),
});

const linkSchema = z.object({
  providerId: z.string().min(1).max(64),
  returnTo: z.string().max(512).optional(),
  mode: z.enum(["json", "redirect"]).default("json"),
});

/* ------------------------------------------------------------------ */

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "sso"
  );
}

export const ssoModule: FastifyPluginAsync = async (app) => {
  const config = app.appConfig;
  const key = deriveSsoKey(config);
  const redirectUri = redirectUriFor(config);
  const secureCookies = config.APP_BASE_URL.startsWith("https://");

  // Production reaches identity providers with fetch; tests register a stub on
  // the database handle before the first call. Registering the real one only
  // when nothing is registered means a test's client is never clobbered by a
  // second app boot sharing the handle.
  if (!getSsoHttpClient(app.db)) {
    registerSsoHttpClient(app.db, createFetchSsoClient());
  }
  const httpClient = (): SsoHttpClient =>
    getSsoHttpClient(app.db) ?? createFetchSsoClient();

  // One key-set cache per HTTP client, not per app. Keying it on the client
  // means a test that swaps the stub gets a fresh cache and can never verify a
  // token against keys another fixture published.
  const jwksStores = new WeakMap<object, JwksStore>();
  const jwksStore = (): JwksStore => {
    const client = httpClient();
    let store = jwksStores.get(client);
    if (!store) {
      store = new JwksStore(client, DEFAULT_JWKS_OPTIONS);
      jwksStores.set(client, store);
    }
    return store;
  };

  const adminGate = [
    app.authenticate,
    app.requireCompany,
    app.requireCompanyRole(["owner", "admin"]),
  ];

  /**
   * The stricter per-IP budget the credential endpoints already use
   * (modules/identity). Applied to the two routes that redeem something —
   * the callback and the ticket exchange — and deliberately NOT to
   * /auth/sso/providers, which a sign-in page calls as the user types and
   * which is answered from tenant configuration alone.
   */
  const authLimited =
    config.RATE_LIMIT_ENABLED && config.NODE_ENV !== "test"
      ? {
          config: {
            rateLimit: {
              max: config.AUTH_RATE_LIMIT_MAX_PER_MINUTE,
              timeWindow: "1 minute",
            },
          },
        }
      : {};

  /* ---------------------------------------------------------------- */
  /* Small shared helpers                                              */
  /* ---------------------------------------------------------------- */

  async function recordEvent(fields: {
    kind: AuthEventKind;
    outcome?: AuthEventOutcome;
    companyId?: string | null;
    userId?: string | null;
    email?: string | null;
    sessionId?: string | null;
    providerId?: string | null;
    identityId?: string | null;
    reason?: string | null;
    metadata?: Record<string, unknown>;
    req: FastifyRequest;
  }): Promise<void> {
    // FAIL-SAFE, like recordAuthEvent (account/events.ts) and
    // recordSecurityEvent (mfa/service.ts). This one used to insert without a
    // guard, and `finishSignIn` awaits it AFTER the session row and the
    // refresh token are already written — so a transient database error turned
    // a completed sign-in into a 500 and left the user on an error page while
    // holding a live session. A trail write must never fail the request it
    // describes.
    try {
      await app.db.insert(authSecurityEvents).values({
        id: newId("ase"),
        companyId: fields.companyId ?? null,
        userId: fields.userId ?? null,
        email: fields.email ?? null,
        kind: fields.kind,
        outcome: fields.outcome ?? "success",
        sessionId: fields.sessionId ?? null,
        providerId: fields.providerId ?? null,
        identityId: fields.identityId ?? null,
        ip: fields.req.ip,
        userAgent: fields.req.headers["user-agent"] ?? null,
        reason: fields.reason ?? null,
        metadata: fields.metadata ?? {},
      });
    } catch (err) {
      fields.req.log.error({ err, kind: fields.kind }, "sso security trail write failed");
    }
  }

  function readCookie(req: FastifyRequest, name: string): string | null {
    const header = req.headers.cookie;
    if (typeof header !== "string") return null;
    for (const part of header.split(";")) {
      const idx = part.indexOf("=");
      if (idx === -1) continue;
      if (part.slice(0, idx).trim() !== name) continue;
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
    return null;
  }

  /**
   * The browser binding.
   *
   * `state` alone proves the callback quotes a flow this server started; it
   * does not prove the flow was started by the browser now presenting it.
   * Without that second half, an attacker can start a sign-in at their own
   * identity provider account and feed the resulting callback URL to a victim,
   * who is then silently signed in as the attacker — login CSRF, and it ends
   * with the victim's work sitting in the attacker's account.
   *
   * The cookie holds up to MAX_BINDINGS values, newest last, so two tabs (or a
   * back-button retry) can have flows in the air at once without invalidating
   * each other. Only the hash is stored server-side, and the used value is
   * dropped from the cookie when its flow completes.
   */
  const MAX_BINDINGS = 3;

  function writeStateCookie(reply: FastifyReply, values: readonly string[]): void {
    const parts = [
      `${STATE_COOKIE}=${values.join(".")}`,
      "Path=/api/v1/auth/sso",
      `Max-Age=${values.length === 0 ? 0 : Math.floor(FLOW_TTL_MS / 1000)}`,
      "HttpOnly",
      "SameSite=Lax",
    ];
    if (secureCookies) parts.push("Secure");
    void reply.header("set-cookie", parts.join("; "));
  }

  function readBindings(req: FastifyRequest): string[] {
    const raw = readCookie(req, STATE_COOKIE);
    if (!raw) return [];
    return raw.split(".").filter((v) => v !== "");
  }

  function addStateCookie(req: FastifyRequest, reply: FastifyReply, binding: string): void {
    const next = [...readBindings(req), binding].slice(-MAX_BINDINGS);
    writeStateCookie(reply, next);
  }

  /**
   * Why a `reference` client secret cannot be resolved on THIS process, or []
   * when it can. Readiness asks for it so that a connection pointing at an
   * unset variable is reported as not ready rather than green — the sign-in
   * that follows would 503, and a green light in front of a 503 is the
   * fabricated verdict the `{ ready, reasons }` shape exists to prevent.
   */
  const referenceReasons = (ref: string): string[] =>
    resolveClientSecret(
      { secretStorage: "reference", clientSecretCiphertext: null, clientSecretRef: ref },
      key,
    ).reasons;

  /** Everything a caller may see about a connection. Never the secret. */
  function viewProvider(row: ProviderRow, extra: { identityCount?: number } = {}) {
    const readiness = providerReadiness({
      kind: row.kind,
      clientId: row.clientId,
      issuer: row.issuer,
      discoveryUrl: row.discoveryUrl,
      authorizationUrl: row.authorizationUrl,
      tokenUrl: row.tokenUrl,
      jwksUri: row.jwksUri,
      secretStorage: row.secretStorage,
      clientSecretCiphertext: row.clientSecretCiphertext,
      clientSecretRef: row.clientSecretRef,
      allowedEmailDomains: row.allowedEmailDomains,
      autoProvision: row.autoProvision,
      domainsVerifiedAt: row.domainsVerifiedAt,
    }, referenceReasons);
    return {
      id: row.id,
      companyId: row.companyId,
      kind: row.kind as IdentityProviderKind,
      displayName: row.displayName,
      slug: row.slug,
      issuer: row.issuer,
      discoveryUrl: row.discoveryUrl,
      authorizationUrl: row.authorizationUrl,
      tokenUrl: row.tokenUrl,
      userinfoUrl: row.userinfoUrl,
      jwksUri: row.jwksUri,
      discoveryFetchedAt: row.discoveryFetchedAt,
      tenantId: row.kind === "microsoft" ? microsoftTenantOf(row.discoveryUrl, row.issuer) : null,
      clientId: row.clientId,
      secretStorage: row.secretStorage,
      clientSecretRef: row.clientSecretRef,
      clientSecretKeyId: row.clientSecretKeyId,
      clientSecretFingerprint: row.clientSecretFingerprint,
      secretConfigured:
        row.secretStorage === "none" ||
        (row.secretStorage === "reference" ? Boolean(row.clientSecretRef) : Boolean(row.clientSecretCiphertext)),
      scopes: row.scopes,
      samlEntityId: row.samlEntityId,
      samlSsoUrl: row.samlSsoUrl,
      samlBinding: row.samlBinding,
      samlWantAssertionsSigned: row.samlWantAssertionsSigned,
      allowedEmailDomains: row.allowedEmailDomains,
      domainsVerifiedAt: row.domainsVerifiedAt,
      autoProvision: row.autoProvision,
      defaultCompanyRole: row.defaultCompanyRole,
      defaultTemplateKey: row.defaultTemplateKey,
      groupClaimName: row.groupClaimName,
      groupRoleMappings: row.groupRoleMappings,
      allowPasswordLogin: row.allowPasswordLogin,
      isEnabled: row.isEnabled,
      disabledReason: row.disabledReason,
      lastUsedAt: row.lastUsedAt,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      redirectUri,
      startUrl: `/api/v1/auth/sso/${row.slug}/start`,
      identityCount: extra.identityCount ?? null,
      readiness,
    };
  }

  async function loadCompanyProvider(id: string, companyId: string): Promise<ProviderRow> {
    const rows = await app.db
      .select()
      .from(identityProviders)
      .where(and(eq(identityProviders.id, id), eq(identityProviders.companyId, companyId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("Identity provider not found in this company");
    return row;
  }

  /**
   * Ensure the endpoints exist, fetching discovery if that is what is missing.
   * Returns the row as it now stands, so a caller never works from a stale copy.
   */
  async function ensureEndpoints(row: ProviderRow): Promise<ProviderRow> {
    if (row.authorizationUrl && row.tokenUrl && row.jwksUri && row.issuer) return row;
    if (!row.discoveryUrl) {
      throw configurationError(row, [
        "No discoveryUrl, and authorizationUrl / tokenUrl / jwksUri / issuer are not all set.",
      ]);
    }
    const doc = await fetchDiscovery(httpClient(), row.discoveryUrl);
    const now = new Date().toISOString();
    const patch = {
      issuer: row.issuer ?? doc.issuer,
      authorizationUrl: doc.authorizationUrl,
      tokenUrl: doc.tokenUrl,
      jwksUri: doc.jwksUri,
      userinfoUrl: doc.userinfoUrl,
      discoveryFetchedAt: now,
      updatedAt: now,
    };
    await app.db.update(identityProviders).set(patch).where(eq(identityProviders.id, row.id));
    return { ...row, ...patch };
  }

  /**
   * The error an operator can actually act on: what is missing, which
   * environment variables govern it, and the exact redirect URI the provider
   * must have registered. Returned instead of a generic 500 every time the
   * connection is not in a state that can complete a sign-in.
   */
  function configurationError(row: ProviderRow | null, reasons: string[]): AppError {
    return new AppError(
      503,
      `This SSO connection is not ready to sign anyone in: ${reasons.join(" ")}`,
      {
        reasons,
        providerId: row?.id ?? null,
        redirectUri,
        register: {
          redirectUri,
          note:
            "Register this exact redirect URI at the identity provider. It is compared byte for " +
            "byte and is the most common cause of `redirect_uri_mismatch`.",
        },
        environment: {
          APP_BASE_URL: config.APP_BASE_URL,
          SSO_ENCRYPTION_KEY: config.SSO_ENCRYPTION_KEY
            ? "set"
            : "unset — client secrets are encrypted under a key derived from AUTH_SECRET",
        },
      },
    );
  }

  const passwordLoginAllowedForUser = (userId: string): Promise<boolean> =>
    isPasswordLoginAllowedForUser(app.db, userId);

  /**
   * Issue the platform session — the same tokens password login issues, plus
   * the `auth_sessions` row that makes "what is signed in to my account?" and
   * "sign everything else out" answerable.
   */
  async function issueSession(options: {
    user: { id: string; email: string; name: string };
    companyId: string;
    identityId: string;
    providerId: string;
    req: FastifyRequest;
  }) {
    const refreshToken = newId("rt") + newId();
    const refreshTokenId = newId("rtk");
    const nowMs = Date.now();
    await app.db.insert(refreshTokens).values({
      id: refreshTokenId,
      userId: options.user.id,
      tokenHash: sha256Hex(refreshToken),
      expiresAt: new Date(
        nowMs + config.REFRESH_TOKEN_TTL_DAYS * 24 * 3600 * 1000,
      ).toISOString(),
    });
    const userAgent = options.req.headers["user-agent"] ?? null;
    const sessionId = newId("sess");
    // The token carries `sid`, so plugins/auth.ts can re-read the session row
    // written below on every request. Minted with `app.signAccessToken` it did
    // not, and an SSO session survived its own revocation — including the
    // revoke-on-unlink this module performs — for the rest of the hour.
    const accessToken = await signSessionAccessToken(app, options.user, sessionId);
    const expiresAt = new Date(
      nowMs + config.SESSION_ABSOLUTE_TTL_DAYS * 24 * 3600 * 1000,
    ).toISOString();
    await app.db.insert(authSessions).values({
      id: sessionId,
      userId: options.user.id,
      companyId: options.companyId,
      refreshTokenId,
      identityId: options.identityId,
      providerId: options.providerId,
      authMethod: "sso",
      userAgent,
      ip: options.req.ip,
      deviceLabel: deviceLabelFor(userAgent),
      deviceFingerprint: sha256Hex(deviceSignature(userAgent, options.req.ip)),
      expiresAt,
    });
    return {
      accessToken,
      refreshToken,
      expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
      session: {
        id: sessionId,
        authMethod: "sso" as const,
        expiresAt,
        deviceLabel: deviceLabelFor(userAgent),
      },
    };
  }

  /* ---------------------------------------------------------------- */
  /* Provider configuration — owner/admin                              */
  /* ---------------------------------------------------------------- */

  app.post("/identity-providers", { preHandler: adminGate }, async (req, reply) => {
    const body = createProviderSchema.parse(req.body);
    const companyId = req.companyId!;
    const defaults = providerDefaults(body.kind, body.tenantId ?? null);

    let slug = body.slug ?? slugify(`${body.displayName}`);
    const taken = await app.db
      .select({ id: identityProviders.id })
      .from(identityProviders)
      .where(eq(identityProviders.slug, slug))
      .limit(1);
    if (taken[0]) {
      if (body.slug) throw conflict(`The slug "${slug}" is already in use`);
      slug = `${slug}-${newId().slice(0, 6)}`;
    }

    const secretStorage = body.secretStorage ?? (body.clientSecret ? "encrypted" : "encrypted");
    if (body.clientSecret && secretStorage !== "encrypted") {
      throw badRequest(
        "A clientSecret was supplied but secretStorage is not `encrypted`. Pick one: store the " +
          "secret here (encrypted), point at an external holder (reference), or declare the " +
          "connection a public PKCE client (none).",
      );
    }

    const id = newId("idp");
    const now = new Date().toISOString();
    await app.db.insert(identityProviders).values({
      id,
      companyId,
      kind: body.kind,
      displayName: body.displayName,
      slug,
      issuer: body.issuer ?? defaults.issuer,
      discoveryUrl: body.discoveryUrl ?? defaults.discoveryUrl,
      authorizationUrl: body.authorizationUrl ?? null,
      tokenUrl: body.tokenUrl ?? null,
      userinfoUrl: body.userinfoUrl ?? null,
      jwksUri: body.jwksUri ?? null,
      clientId: body.clientId ?? null,
      secretStorage,
      clientSecretCiphertext: body.clientSecret ? encryptSecret(body.clientSecret, key) : null,
      clientSecretRef: body.clientSecretRef ?? null,
      clientSecretKeyId: body.clientSecret ? key.keyId : null,
      clientSecretFingerprint: body.clientSecret ? secretFingerprint(body.clientSecret) : null,
      scopes: body.scopes ?? defaults.scopes,
      samlEntityId: body.samlEntityId ?? null,
      samlSsoUrl: body.samlSsoUrl ?? null,
      samlBinding: body.samlBinding ?? null,
      samlCertificatePem: body.samlCertificatePem ?? null,
      samlWantAssertionsSigned: body.samlWantAssertionsSigned ?? true,
      allowedEmailDomains: normalizeDomains(body.allowedEmailDomains ?? []),
      autoProvision: body.autoProvision ?? false,
      defaultCompanyRole: body.defaultCompanyRole ?? "member",
      defaultTemplateKey: body.defaultTemplateKey ?? null,
      groupClaimName: body.groupClaimName ?? "groups",
      groupRoleMappings: body.groupRoleMappings ?? [],
      provisionProjectIds: body.provisionProjectIds ?? [],
      idpPerformsMfa: body.idpPerformsMfa ?? false,
      mfaAmrValues: body.mfaAmrValues ?? [],
      isEnabled: false,
      createdBy: req.user!.id,
      createdAt: now,
      updatedAt: now,
    });

    const row = await loadCompanyProvider(id, companyId);
    await appendLedger(app.db, {
      companyId,
      actorId: req.user!.id,
      action: "create",
      objectType: "identity_provider",
      objectId: id,
      payload: { kind: body.kind, slug, displayName: body.displayName },
      storePayload: true,
    });
    await recordEvent({
      kind: "identity_provider_created",
      companyId,
      userId: req.user!.id,
      providerId: id,
      metadata: { kind: body.kind, slug },
      req,
    });
    return reply.status(201).send({ provider: viewProvider(row, { identityCount: 0 }) });
  });

  app.get("/identity-providers", { preHandler: adminGate }, async (req) => {
    const rows = await app.db
      .select()
      .from(identityProviders)
      .where(eq(identityProviders.companyId, req.companyId!))
      .orderBy(desc(identityProviders.createdAt));
    const counts = await app.db
      .select({ providerId: userIdentities.providerId, n: count() })
      .from(userIdentities)
      .where(eq(userIdentities.companyId, req.companyId!))
      .groupBy(userIdentities.providerId);
    const byProvider = new Map(counts.map((c) => [c.providerId, Number(c.n)]));
    return {
      items: rows.map((r) => viewProvider(r, { identityCount: byProvider.get(r.id) ?? 0 })),
      redirectUri,
      saml: { supported: false, reason: SAML_UNSUPPORTED_REASON },
    };
  });

  app.get("/identity-providers/:id", { preHandler: adminGate }, async (req) => {
    const { id } = req.params as { id: string };
    const row = await loadCompanyProvider(id, req.companyId!);
    const [n] = await app.db
      .select({ n: count() })
      .from(userIdentities)
      .where(eq(userIdentities.providerId, row.id));
    return { provider: viewProvider(row, { identityCount: Number(n?.n ?? 0) }) };
  });

  app.patch("/identity-providers/:id", { preHandler: adminGate }, async (req) => {
    const { id } = req.params as { id: string };
    const body = updateProviderSchema.parse(req.body);
    const row = await loadCompanyProvider(id, req.companyId!);
    const now = new Date().toISOString();

    const patch: Partial<typeof identityProviders.$inferInsert> = { updatedAt: now };
    if (body.displayName !== undefined) patch.displayName = body.displayName;
    if (body.slug !== undefined && body.slug !== row.slug) {
      const taken = await app.db
        .select({ id: identityProviders.id })
        .from(identityProviders)
        .where(eq(identityProviders.slug, body.slug))
        .limit(1);
      if (taken[0]) throw conflict(`The slug "${body.slug}" is already in use`);
      patch.slug = body.slug;
    }
    if (body.tenantId !== undefined && row.kind === "microsoft") {
      const defaults = providerDefaults("microsoft", body.tenantId);
      patch.discoveryUrl = defaults.discoveryUrl;
      patch.issuer = defaults.issuer;
      // Endpoints belonged to the previous tenant; re-read them.
      patch.authorizationUrl = null;
      patch.tokenUrl = null;
      patch.jwksUri = null;
      patch.discoveryFetchedAt = null;
    }
    if (body.issuer !== undefined) patch.issuer = body.issuer;
    if (body.discoveryUrl !== undefined && body.discoveryUrl !== row.discoveryUrl) {
      patch.discoveryUrl = body.discoveryUrl;
      patch.authorizationUrl = null;
      patch.tokenUrl = null;
      patch.jwksUri = null;
      patch.discoveryFetchedAt = null;
    }
    if (body.authorizationUrl !== undefined) patch.authorizationUrl = body.authorizationUrl;
    if (body.tokenUrl !== undefined) patch.tokenUrl = body.tokenUrl;
    if (body.userinfoUrl !== undefined) patch.userinfoUrl = body.userinfoUrl;
    if (body.jwksUri !== undefined) patch.jwksUri = body.jwksUri;
    if (body.clientId !== undefined) patch.clientId = body.clientId;
    if (body.secretStorage !== undefined) {
      patch.secretStorage = body.secretStorage;
      if (body.secretStorage === "none") {
        patch.clientSecretCiphertext = null;
        patch.clientSecretKeyId = null;
        patch.clientSecretFingerprint = null;
      }
    }
    if (body.clientSecret !== undefined) {
      const storage = body.secretStorage ?? row.secretStorage;
      if (storage !== "encrypted") {
        throw badRequest(
          `A clientSecret cannot be stored while secretStorage is \`${storage}\`.`,
        );
      }
      patch.clientSecretCiphertext = encryptSecret(body.clientSecret, key);
      patch.clientSecretKeyId = key.keyId;
      patch.clientSecretFingerprint = secretFingerprint(body.clientSecret);
    }
    if (body.clientSecretRef !== undefined) patch.clientSecretRef = body.clientSecretRef;
    if (body.scopes !== undefined) patch.scopes = body.scopes;
    if (body.samlEntityId !== undefined) patch.samlEntityId = body.samlEntityId;
    if (body.samlSsoUrl !== undefined) patch.samlSsoUrl = body.samlSsoUrl;
    if (body.samlBinding !== undefined) patch.samlBinding = body.samlBinding;
    if (body.samlCertificatePem !== undefined) patch.samlCertificatePem = body.samlCertificatePem;
    if (body.samlWantAssertionsSigned !== undefined) {
      patch.samlWantAssertionsSigned = body.samlWantAssertionsSigned;
    }
    if (body.allowedEmailDomains !== undefined) {
      const next = normalizeDomains(body.allowedEmailDomains);
      patch.allowedEmailDomains = next;
      const before = normalizeDomains(row.allowedEmailDomains);
      const widened = next.some((d) => !before.includes(d));
      // Adding a domain re-opens the question the verification answered, so
      // the confirmation is withdrawn rather than silently inherited.
      if (widened) patch.domainsVerifiedAt = null;
    }
    if (body.autoProvision !== undefined) patch.autoProvision = body.autoProvision;
    if (body.defaultCompanyRole !== undefined) patch.defaultCompanyRole = body.defaultCompanyRole;
    if (body.defaultTemplateKey !== undefined) patch.defaultTemplateKey = body.defaultTemplateKey;
    if (body.groupClaimName !== undefined) patch.groupClaimName = body.groupClaimName;
    if (body.groupRoleMappings !== undefined) patch.groupRoleMappings = body.groupRoleMappings;

    await app.db.update(identityProviders).set(patch).where(eq(identityProviders.id, row.id));
    const updated = await loadCompanyProvider(row.id, req.companyId!);
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "identity_provider",
      objectId: row.id,
      // The secret is never in the payload — the ledger stores what changed,
      // and "clientSecret" is recorded as a fact, never as a value.
      payload: { fields: Object.keys(patch).filter((k) => k !== "clientSecretCiphertext") },
      storePayload: true,
    });
    await recordEvent({
      kind: "identity_provider_updated",
      companyId: req.companyId!,
      userId: req.user!.id,
      providerId: row.id,
      req,
    });
    return { provider: viewProvider(updated) };
  });

  /** Re-read the provider's metadata document and cache its endpoints. */
  app.post("/identity-providers/:id/discovery", { preHandler: adminGate }, async (req) => {
    const { id } = req.params as { id: string };
    const row = await loadCompanyProvider(id, req.companyId!);
    if (row.kind === "saml") throw new AppError(501, SAML_UNSUPPORTED_REASON);
    if (!row.discoveryUrl) {
      throw badRequest(
        "This connection has no discoveryUrl. Set one, or configure authorizationUrl, tokenUrl " +
          "and jwksUri by hand.",
      );
    }
    const doc = await fetchDiscovery(httpClient(), row.discoveryUrl);
    const now = new Date().toISOString();
    await app.db
      .update(identityProviders)
      .set({
        issuer: doc.issuer,
        authorizationUrl: doc.authorizationUrl,
        tokenUrl: doc.tokenUrl,
        jwksUri: doc.jwksUri,
        userinfoUrl: doc.userinfoUrl,
        discoveryFetchedAt: now,
        updatedAt: now,
      })
      .where(eq(identityProviders.id, row.id));
    const updated = await loadCompanyProvider(row.id, req.companyId!);
    return {
      provider: viewProvider(updated),
      discovery: {
        issuer: doc.issuer,
        authorizationUrl: doc.authorizationUrl,
        tokenUrl: doc.tokenUrl,
        jwksUri: doc.jwksUri,
        userinfoUrl: doc.userinfoUrl,
        idTokenSigningAlgValues: doc.idTokenSigningAlgValues,
        codeChallengeMethods: doc.codeChallengeMethods,
      },
    };
  });

  /**
   * Confirm control of the connection's email domains.
   *
   * This is a VERIFICATION, so the house rule applies without exception: the
   * actor may not be the person who created the connection. One administrator
   * who can both point a connection at an identity provider and attest that
   * the company owns the domains it claims is one administrator away from
   * provisioning themselves an account in somebody else's tenant.
   */
  app.post("/identity-providers/:id/verify-domains", { preHandler: adminGate }, async (req) => {
    const { id } = req.params as { id: string };
    const row = await loadCompanyProvider(id, req.companyId!);
    if (row.allowedEmailDomains.length === 0) {
      throw badRequest(
        "There are no domains to verify. Set allowedEmailDomains to the domains this identity " +
          "provider owns first.",
      );
    }
    if (row.createdBy === req.user!.id) {
      throw badRequest(
        "The administrator who created this connection cannot also be the one who confirms it " +
          "owns these domains. Ask a second owner or admin to verify " +
          `${row.allowedEmailDomains.join(", ")} — domain control is what auto-provisioning ` +
          "trusts, and a single actor holding both halves is how a tenant gets taken over.",
      );
    }
    const now = new Date().toISOString();
    await app.db
      .update(identityProviders)
      .set({ domainsVerifiedAt: now, updatedAt: now })
      .where(eq(identityProviders.id, row.id));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "identity_provider",
      objectId: row.id,
      payload: { domainsVerifiedAt: now, domains: row.allowedEmailDomains, verifiedBy: req.user!.id },
      storePayload: true,
    });
    await recordEvent({
      kind: "identity_provider_updated",
      companyId: req.companyId!,
      userId: req.user!.id,
      providerId: row.id,
      reason: "domains verified",
      metadata: { domains: row.allowedEmailDomains },
      req,
    });
    return { provider: viewProvider(await loadCompanyProvider(row.id, req.companyId!)) };
  });

  app.post("/identity-providers/:id/enable", { preHandler: adminGate }, async (req) => {
    const { id } = req.params as { id: string };
    let row = await loadCompanyProvider(id, req.companyId!);
    if (row.kind === "saml") throw new AppError(501, SAML_UNSUPPORTED_REASON);
    // Read discovery here rather than making the administrator do it in a
    // separate call — but let the fetch's own 502 surface, because "the
    // provider's metadata is unreachable" is not the same problem as "this
    // connection is misconfigured" and must not be reported as one.
    if (row.discoveryUrl && (!row.authorizationUrl || !row.tokenUrl || !row.jwksUri)) {
      row = await ensureEndpoints(row);
    }
    const readiness = providerReadiness({
      kind: row.kind,
      clientId: row.clientId,
      issuer: row.issuer,
      discoveryUrl: row.discoveryUrl,
      authorizationUrl: row.authorizationUrl,
      tokenUrl: row.tokenUrl,
      jwksUri: row.jwksUri,
      secretStorage: row.secretStorage,
      clientSecretCiphertext: row.clientSecretCiphertext,
      clientSecretRef: row.clientSecretRef,
      allowedEmailDomains: row.allowedEmailDomains,
      autoProvision: row.autoProvision,
      domainsVerifiedAt: row.domainsVerifiedAt,
    }, referenceReasons);
    if (readiness.ready !== true) {
      throw badRequest("This connection is not ready to be enabled", {
        reasons: readiness.reasons,
        redirectUri,
      });
    }
    const now = new Date().toISOString();
    await app.db
      .update(identityProviders)
      .set({ isEnabled: true, disabledReason: null, updatedAt: now })
      .where(eq(identityProviders.id, row.id));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "identity_provider",
      objectId: row.id,
      payload: { isEnabled: true },
      storePayload: true,
    });
    await recordEvent({
      kind: "identity_provider_updated",
      companyId: req.companyId!,
      userId: req.user!.id,
      providerId: row.id,
      reason: "enabled",
      req,
    });
    return { provider: viewProvider(await loadCompanyProvider(row.id, req.companyId!)) };
  });

  app.post("/identity-providers/:id/disable", { preHandler: adminGate }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ reason: z.string().min(1).max(500).optional() }).parse(req.body ?? {});
    const row = await loadCompanyProvider(id, req.companyId!);
    const now = new Date().toISOString();
    await app.db
      .update(identityProviders)
      .set({
        isEnabled: false,
        disabledReason: body.reason ?? "Disabled by an administrator",
        // Turning the connection off while password login is off would leave
        // the tenant with no way in at all, so the safety net comes back up
        // with it. Recorded in the ledger below, never silent.
        allowPasswordLogin: true,
        updatedAt: now,
      })
      .where(eq(identityProviders.id, row.id));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "identity_provider",
      objectId: row.id,
      payload: { isEnabled: false, reason: body.reason ?? null, allowPasswordLogin: true },
      storePayload: true,
    });
    await recordEvent({
      kind: "identity_provider_disabled",
      companyId: req.companyId!,
      userId: req.user!.id,
      providerId: row.id,
      reason: body.reason ?? null,
      req,
    });
    return {
      provider: viewProvider(await loadCompanyProvider(row.id, req.companyId!)),
      passwordLoginRestored: !row.allowPasswordLogin,
    };
  });

  /**
   * The enterprise control: once SSO works, a company may require it.
   *
   * The refusal is the point. Switching password login off before anybody has
   * actually completed an SSO sign-in is the classic self-inflicted lockout —
   * the connection looks configured, nobody has proved it works, and the
   * moment the flag flips the tenant has no way in at all.
   */
  app.put("/identity-providers/:id/password-login", { preHandler: adminGate }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ allowPasswordLogin: z.boolean() }).parse(req.body);
    const row = await loadCompanyProvider(id, req.companyId!);

    const members = await app.db
      .select({ userId: companyMemberships.userId, role: companyMemberships.role })
      .from(companyMemberships)
      .where(eq(companyMemberships.companyId, req.companyId!));
    const linked = await app.db
      .select({
        userId: userIdentities.userId,
        providerId: userIdentities.providerId,
        lastLoginAt: userIdentities.lastLoginAt,
      })
      .from(userIdentities)
      .where(eq(userIdentities.companyId, req.companyId!));
    // Deliberately scoped to THIS connection. Another connection working is
    // not evidence that this one does, and it is this one the company is
    // about to depend on.
    const workingIdentities = linked.filter(
      (l) => l.providerId === row.id && l.lastLoginAt !== null,
    );

    if (!body.allowPasswordLogin) {
      const reasons: string[] = [];
      if (!row.isEnabled) {
        reasons.push("This SSO connection is not enabled, so there is nothing to sign in with.");
      }
      if (workingIdentities.length === 0) {
        reasons.push(
          `No user has completed an SSO sign-in through "${row.displayName}" yet. Turning ` +
            "password login off now would lock every member out, including you: a connection " +
            "that has never carried a real sign-in has not been shown to work.",
        );
      }
      if (reasons.length > 0) {
        throw badRequest("Refusing to disable password login", {
          reasons,
          risk: "Tenant lockout — no member would have a usable sign-in method.",
          workingSsoIdentities: workingIdentities.length,
          members: members.length,
        });
      }
    }

    const now = new Date().toISOString();
    await app.db
      .update(identityProviders)
      .set({ allowPasswordLogin: body.allowPasswordLogin, updatedAt: now })
      .where(eq(identityProviders.id, row.id));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "identity_provider",
      objectId: row.id,
      payload: { allowPasswordLogin: body.allowPasswordLogin },
      storePayload: true,
    });
    await recordEvent({
      kind: "identity_provider_updated",
      companyId: req.companyId!,
      userId: req.user!.id,
      providerId: row.id,
      reason: body.allowPasswordLogin ? "password login enabled" : "password login disabled",
      req,
    });

    const linkedIds = new Set(linked.filter((l) => l.lastLoginAt !== null).map((l) => l.userId));
    const without = members.filter((m) => !linkedIds.has(m.userId));
    return {
      provider: viewProvider(await loadCompanyProvider(row.id, req.companyId!)),
      membersWithoutWorkingSso: without.length,
      warning:
        !body.allowPasswordLogin && without.length > 0
          ? `${without.length} member(s) of this company have never signed in through SSO and ` +
            "now have no other way in. Have them sign in once, or re-enable password login."
          : null,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Sign-in — unauthenticated                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Which connections may this address use?
   *
   * THIS ENDPOINT MUST NOT BECOME A USER-ENUMERATION ORACLE, and the defence
   * is structural rather than careful: it never reads the `users` table at
   * all. The answer is a function of the DOMAIN and the tenant configuration
   * for that domain, so an address that has an account and an address that
   * does not produce byte-identical responses in indistinguishable time.
   * There is no branch here that could accidentally leak, because there is no
   * branch here that knows.
   */
  app.get("/auth/sso/providers", async (req) => {
    const query = z
      .object({ email: z.string().max(320).optional(), domain: z.string().max(253).optional() })
      .parse(req.query);
    const domain = query.domain
      ? query.domain.trim().toLowerCase()
      : query.email
        ? emailDomain(query.email.trim().toLowerCase())
        : null;

    if (!domain) {
      return {
        domain: null,
        providers: [],
        passwordLoginAllowed: true,
        reasons: ["No email domain was supplied, so no SSO connection can be matched."],
      };
    }

    const rows = await app.db
      .select()
      .from(identityProviders)
      .where(
        and(
          eq(identityProviders.isEnabled, true),
          sql`${identityProviders.allowedEmailDomains} @> ${JSON.stringify([domain])}::jsonb`,
        ),
      )
      .orderBy(identityProviders.displayName);

    const matched = rows.filter((r) => domainAllowed(r.allowedEmailDomains, `x@${domain}`));
    const providers = matched.map((r) => ({
      id: r.id,
      slug: r.slug,
      kind: r.kind as IdentityProviderKind,
      displayName: r.displayName,
      startUrl: `/api/v1/auth/sso/${r.slug}/start`,
      status: r.kind === "saml" ? ("unsupported" as const) : ("ready" as const),
      unsupportedReason: r.kind === "saml" ? SAML_UNSUPPORTED_REASON : null,
    }));

    const reasons: string[] = [];
    if (providers.length === 0) {
      reasons.push("No SSO connection is configured for this email domain.");
    }
    return {
      domain,
      providers,
      // Every matched connection must permit it, or it is off.
      passwordLoginAllowed: matched.every((r) => r.allowPasswordLogin),
      reasons,
    };
  });

  /**
   * Open a flow: mint state, PKCE and a nonce, park them server-side, bind
   * them to this browser and redirect.
   *
   * `state` is a lookup key over 256 bits of entropy and carries nothing.
   * Nothing user-supplied is encoded into it, so there is nothing in it to
   * tamper with; the record it points at is the only thing that decides what
   * the callback is allowed to do, and it is deleted the first time it is
   * used.
   */
  app.get("/auth/sso/:provider/start", async (req, reply) => {
    const { provider: handle } = req.params as { provider: string };
    const query = startQuerySchema.parse(req.query);
    const rows = await app.db
      .select()
      .from(identityProviders)
      .where(or(eq(identityProviders.id, handle), eq(identityProviders.slug, handle)))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("Unknown SSO connection");
    if (row.kind === "saml") throw new AppError(501, SAML_UNSUPPORTED_REASON);
    if (!row.isEnabled) {
      throw badRequest(
        `The SSO connection "${row.displayName}" is not enabled${
          row.disabledReason ? `: ${row.disabledReason}` : "."
        }`,
      );
    }
    const url = await beginFlow(row, {
      req,
      reply,
      mode: query.mode,
      returnTo: safeReturnTo(query.returnTo),
      linkUserId: null,
      loginHint: query.loginHint ?? null,
      prompt: query.prompt ?? null,
    });
    return reply.redirect(url, 302);
  });

  async function beginFlow(
    row: ProviderRow,
    options: {
      req: FastifyRequest;
      reply: FastifyReply;
      mode: "json" | "redirect";
      returnTo: string | null;
      linkUserId: string | null;
      loginHint?: string | null;
      prompt?: string | null;
    },
  ): Promise<string> {
    const ready = await ensureEndpoints(row);
    if (!ready.clientId) {
      throw configurationError(ready, ["clientId is not set on this connection."]);
    }
    const secret = resolveClientSecret(ready, key);
    if (secret.secret === null && ready.secretStorage !== "none") {
      throw configurationError(ready, secret.reasons);
    }

    const pkce = createPkcePair();
    const state = randomToken();
    const nonce = randomToken();
    const binding = randomToken(24);
    const nowMs = Date.now();
    const record: SsoFlowRecord = {
      providerId: ready.id,
      companyId: ready.companyId,
      nonce,
      codeVerifier: pkce.verifier,
      redirectUri,
      mode: options.mode,
      returnTo: options.returnTo,
      linkUserId: options.linkUserId,
      bindingHash: sha256Hex(binding),
      createdAtMs: nowMs,
      expiresAtMs: nowMs + FLOW_TTL_MS,
    };
    getStateStore(app.db).putFlow(state, record);
    addStateCookie(options.req, options.reply, binding);

    return buildAuthorizationUrl({
      authorizationUrl: ready.authorizationUrl!,
      clientId: ready.clientId,
      redirectUri,
      scopes: ready.scopes,
      state,
      nonce,
      challenge: pkce.challenge,
      loginHint: options.loginHint ?? null,
      prompt: options.prompt ?? null,
      responseMode: ready.kind === "microsoft" ? "query" : null,
    });
  }

  /* ---------------------------------------------------------------- */
  /* The callback                                                      */
  /* ---------------------------------------------------------------- */

  app.get("/auth/sso/callback", authLimited, async (req, reply) => {
    const query = callbackQuerySchema.parse(req.query);

    if (!query.state) {
      throw badRequest(
        "This callback carries no `state`. It did not come from a sign-in this server started.",
      );
    }
    const store = getStateStore(app.db);
    const flow = store.consumeFlow(query.state, Date.now());
    if (!flow) {
      // Single-use, and spent whether it was used or merely expired. A replayed
      // state gets exactly the same answer as an invented one.
      await recordEvent({
        kind: "sso_login_failure",
        outcome: "failure",
        reason: "state not found, already used, or expired",
        req,
      });
      throw badRequest(
        "This sign-in link is not valid any more. State is single-use and short-lived — it has " +
          "already been used, or it expired. Start the sign-in again.",
      );
    }
    const presented = readBindings(req);
    if (flow.bindingHash) {
      const matched = presented.filter((v) =>
        timingSafeEqualString(sha256Hex(v), flow.bindingHash!),
      );
      // Retire only the binding this flow used; any other tab keeps its own.
      writeStateCookie(
        reply,
        presented.filter((v) => !matched.includes(v)),
      );
      if (matched.length === 0) {
        await recordEvent({
          kind: "sso_login_failure",
          outcome: "blocked",
          providerId: flow.providerId,
          companyId: flow.companyId,
          reason: "browser binding cookie missing or mismatched",
          req,
        });
        return finishError(
          reply,
          flow,
          badRequest(
            "This sign-in did not start in this browser. The state cookie is missing or does not " +
              "match, which is what a forged callback looks like. Start the sign-in again from " +
              "this device.",
          ),
        );
      }
    }

    if (query.error) {
      await recordEvent({
        kind: "sso_login_failure",
        outcome: "failure",
        providerId: flow.providerId,
        companyId: flow.companyId,
        reason: `provider returned ${query.error}`,
        metadata: { error: query.error, description: query.error_description ?? null },
        req,
      });
      return finishError(
        reply,
        flow,
        unauthorized(
          `The identity provider refused the sign-in (${query.error})` +
            (query.error_description ? `: ${query.error_description}` : "."),
        ),
      );
    }
    if (!query.code) {
      return finishError(
        reply,
        flow,
        badRequest("The callback carried neither an authorization code nor an error."),
      );
    }

    try {
      const result = await completeFlow(flow, query.code, req);
      if (flow.mode === "json") return result;
      const ticket = randomToken();
      store.putTicket(ticket, {
        payload: result,
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + TICKET_TTL_MS,
      });
      // A refresh token must never travel in a URL — it would be written to
      // browser history, to the Referer header of the next request, and to
      // every proxy log in between. The browser carries a single-use ticket
      // instead and swaps it for the session over POST.
      return reply.redirect(
        buildAppUrl(config.APP_BASE_URL, "/auth/sso/complete", {
          ticket,
          ...(flow.returnTo ? { returnTo: flow.returnTo } : {}),
        }),
        302,
      );
    } catch (err) {
      return finishError(reply, flow, err as Error);
    }
  });

  /**
   * Finish a failed callback.
   *
   * REDIRECT MODE PUTS ITS MESSAGE IN A URL, which lands in browser history,
   * in the Referer header of the next request and in every proxy log between
   * here and the user. So only a message WRITTEN FOR A USER travels: an
   * `AppError` below 500, which is this codebase's way of saying "this text is
   * the explanation the caller is entitled to". Anything else — a decryption
   * failure, a driver error, an unexpected throw — is logged server-side with
   * a correlation id and the browser is told only that something went wrong
   * and which reference to quote. The production 5xx masking in app.ts covers
   * the JSON path; this covers the one that goes around it.
   */
  function finishError(reply: FastifyReply, flow: SsoFlowRecord, err: Error) {
    if (flow.mode === "json") throw err;
    const status = err instanceof AppError ? err.statusCode : 500;
    const safe = err instanceof AppError && err.statusCode < 500;
    const reference = safe ? null : newId("ssoerr");
    if (!safe) {
      app.log.error(
        { err, reference, providerId: flow.providerId, companyId: flow.companyId },
        "sso callback failed",
      );
    }
    return reply.redirect(
      buildAppUrl(config.APP_BASE_URL, "/auth/sso/complete", {
        error: String(status),
        message: safe
          ? err.message
          : "The sign-in could not be completed. Quote this reference to your administrator.",
        ...(reference ? { reference } : {}),
        ...(flow.returnTo ? { returnTo: flow.returnTo } : {}),
      }),
      302,
    );
  }

  /** Swap the single-use ticket from a redirect-mode callback for the session. */
  app.post("/auth/sso/ticket", authLimited, async (req) => {
    const body = z.object({ ticket: z.string().min(10).max(256) }).parse(req.body);
    const record = getStateStore(app.db).consumeTicket(body.ticket, Date.now());
    if (!record) {
      throw badRequest(
        "This sign-in ticket is not valid any more. Tickets are single-use and expire in two " +
          "minutes. Start the sign-in again.",
      );
    }
    return record.payload as Record<string, unknown>;
  });

  /**
   * Everything after a verified id_token: decide who this is, and refuse
   * clearly when the answer is "we cannot safely tell".
   */
  async function completeFlow(flow: SsoFlowRecord, code: string, req: FastifyRequest) {
    const rows = await app.db
      .select()
      .from(identityProviders)
      .where(eq(identityProviders.id, flow.providerId))
      .limit(1);
    const provider = rows[0];
    if (!provider) throw badRequest("The SSO connection used to start this sign-in no longer exists");
    if (!provider.isEnabled) {
      throw badRequest(
        `The SSO connection "${provider.displayName}" was disabled while this sign-in was in ` +
          "progress.",
      );
    }
    const ready = await ensureEndpoints(provider);
    const secret = resolveClientSecret(ready, key);
    if (secret.secret === null && ready.secretStorage !== "none") {
      throw configurationError(ready, secret.reasons);
    }
    if (!ready.clientId) throw configurationError(ready, ["clientId is not set."]);

    const tokens = await exchangeCode({
      client: httpClient(),
      tokenUrl: ready.tokenUrl!,
      code,
      redirectUri: flow.redirectUri,
      clientId: ready.clientId,
      clientSecret: secret.secret,
      codeVerifier: flow.codeVerifier,
    });
    if (!tokens.idToken) {
      throw unauthorized(
        "The identity provider's token response carried no id_token. Confirm the `openid` scope " +
          "is requested and granted for this application.",
      );
    }

    // Signature first, always. Nothing below this line reads a claim that has
    // not been through it.
    const header = readJwtHeader(tokens.idToken);
    const jwks = await jwksStore().resolve(ready.jwksUri!, header.kid, Date.now());
    const payload = await verifyIdToken({
      idToken: tokens.idToken,
      jwks,
      expectedIssuer: ready.issuer!,
      audience: ready.clientId,
      nonce: flow.nonce,
      nowMs: Date.now(),
      tenantId: ready.kind === "microsoft" ? microsoftTenantOf(ready.discoveryUrl, ready.issuer) : null,
    });

    let asserted = extractIdentity(payload, { groupClaimName: ready.groupClaimName });
    if (!asserted.email && ready.userinfoUrl && tokens.accessToken) {
      const claims = await fetchUserinfo(
        httpClient(),
        ready.userinfoUrl,
        tokens.accessToken,
        asserted.subject,
      );
      if (claims) {
        asserted = extractIdentity(
          { ...payload, ...claims, sub: asserted.subject },
          { groupClaimName: ready.groupClaimName },
        );
      }
    }

    return flow.linkUserId
      ? completeLink(flow, ready, asserted, req)
      : completeLogin(flow, ready, asserted, req);
  }

  /* ---------------------------------------------------------------- */
  /* Login                                                             */
  /* ---------------------------------------------------------------- */

  async function completeLogin(
    flow: SsoFlowRecord,
    provider: ProviderRow,
    asserted: AssertedIdentity,
    req: FastifyRequest,
  ) {
    const nowIso = new Date().toISOString();

    const existing = await app.db
      .select()
      .from(userIdentities)
      .where(
        and(
          eq(userIdentities.providerId, provider.id),
          eq(userIdentities.externalSubject, asserted.subject),
        ),
      )
      .limit(1);

    if (existing[0]) {
      const identity = existing[0];
      const userRows = await app.db
        .select()
        .from(users)
        .where(eq(users.id, identity.userId))
        .limit(1);
      const user = userRows[0];
      if (!user || !user.isActive) {
        await recordEvent({
          kind: "sso_login_failure",
          outcome: "blocked",
          companyId: provider.companyId,
          providerId: provider.id,
          identityId: identity.id,
          email: asserted.email,
          reason: "account deactivated or missing",
          req,
        });
        throw unauthorized("This account is deactivated.");
      }
      const membership = await app.db
        .select({ role: companyMemberships.role })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, provider.companyId),
            eq(companyMemberships.userId, user.id),
          ),
        )
        .limit(1);
      if (!membership[0]) {
        await recordEvent({
          kind: "sso_login_failure",
          outcome: "blocked",
          companyId: provider.companyId,
          providerId: provider.id,
          identityId: identity.id,
          userId: user.id,
          reason: "no longer a member of the company",
          req,
        });
        throw forbidden(
          "This identity is linked to an account that is no longer a member of the company that " +
            "owns this SSO connection.",
        );
      }

      await app.db
        .update(userIdentities)
        .set({
          lastLoginAt: nowIso,
          displayName: asserted.displayName ?? identity.displayName,
          rawProfile: asserted.rawProfile,
        })
        .where(eq(userIdentities.id, identity.id));
      const session = await finishSignIn({
        user,
        provider,
        identityId: identity.id,
        req,
        metadata: {
          emailAtLink: identity.emailAtLink,
          assertedEmail: asserted.email,
          emailDiverged: Boolean(asserted.email && asserted.email !== identity.emailAtLink),
        },
      });
      return {
        ...session,
        user: { id: user.id, email: user.email, name: user.name },
        company: { id: provider.companyId, role: membership[0].role },
        identity: identityView(identity.id, provider, asserted, false),
        provisioned: false,
        returnTo: flow.returnTo,
      };
    }

    // No identity yet. From here on, an email is the ONLY thing that could
    // connect this assertion to an existing account, and an email is only
    // evidence if the provider vouches for it.
    if (!asserted.email) {
      await failLogin(provider, asserted, req, "the provider asserted no email address");
      throw unauthorized(
        `This identity has never signed in here and the provider asserted no email address, so ` +
          `there is nothing to match it to. ${asserted.emailReasons.join(" ")}`,
      );
    }

    const allowed = domainAllowed(provider.allowedEmailDomains, asserted.email);
    if (!allowed) {
      await failLogin(
        provider,
        asserted,
        req,
        `domain not in the connection's allow-list (${provider.allowedEmailDomains.join(", ") || "empty"})`,
      );
      throw forbidden(
        `The address ${asserted.email} is not in a domain this SSO connection is allowed to ` +
          `speak for. Allowed: ${
            provider.allowedEmailDomains.length > 0
              ? provider.allowedEmailDomains.join(", ")
              : "(none configured)"
          }.`,
      );
    }

    if (!asserted.emailVerified) {
      await failLogin(provider, asserted, req, "email not asserted as verified");
      throw unauthorized(
        `The identity provider did not assert that ${asserted.email} is verified, so it cannot ` +
          `be used to reach an existing account or to create one. ${asserted.emailReasons.join(" ")} ` +
          "Sign in with your existing method and link this provider from your account settings " +
          "instead.",
      );
    }

    const found = await app.db
      .select()
      .from(users)
      .where(eq(users.email, asserted.email))
      .limit(1);
    const existingUser = found[0];

    if (existingUser) {
      if (!existingUser.isActive) {
        await failLogin(provider, asserted, req, "account deactivated");
        throw unauthorized("This account is deactivated.");
      }
      const membership = await app.db
        .select({ role: companyMemberships.role })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, provider.companyId),
            eq(companyMemberships.userId, existingUser.id),
          ),
        )
        .limit(1);

      let role = membership[0]?.role ?? null;
      if (!role) {
        if (!provider.autoProvision || !provider.domainsVerifiedAt) {
          await failLogin(
            provider,
            asserted,
            req,
            "account exists but is not a member of this company and the connection does not provision",
          );
          throw forbidden(
            `${asserted.email} has an account here but is not a member of the company that owns ` +
              "this SSO connection, and the connection is not permitted to add members " +
              "(autoProvision is off, or the domains are not verified). Ask an administrator for " +
              "an invitation.",
          );
        }
        const resolved = resolveRole(
          parseGroupMappings(provider.groupRoleMappings),
          asserted.groups,
          {
            companyRole: provider.defaultCompanyRole as CompanyRole,
            templateKey: provider.defaultTemplateKey,
          },
        );
        await app.db.insert(companyMemberships).values({
          id: newId("cm"),
          companyId: provider.companyId,
          userId: existingUser.id,
          role: resolved.companyRole,
        });
        role = resolved.companyRole;
        await appendLedger(app.db, {
          companyId: provider.companyId,
          actorId: existingUser.id,
          action: "create",
          objectType: "company_membership",
          objectId: existingUser.id,
          payload: {
            via: "sso",
            providerId: provider.id,
            role: resolved.companyRole,
            matchedClaimValue: resolved.matchedClaimValue,
          },
          storePayload: true,
        });
      }

      const identityId = await linkIdentity(provider, existingUser.id, asserted, req, "verified_email");
      const session = await finishSignIn({
        user: existingUser,
        provider,
        identityId,
        req,
        metadata: { matchedBy: "verified_email" },
      });
      return {
        ...session,
        user: { id: existingUser.id, email: existingUser.email, name: existingUser.name },
        company: { id: provider.companyId, role },
        identity: identityView(identityId, provider, asserted, true),
        provisioned: false,
        returnTo: flow.returnTo,
      };
    }

    /* --- nobody here by that name: provision, or refuse --- */
    if (!provider.autoProvision) {
      await failLogin(provider, asserted, req, "no account and autoProvision is off");
      throw forbidden(
        `No ConstructOS account exists for ${asserted.email}, and this SSO connection is not ` +
          "permitted to create one (autoProvision is off). Ask an administrator to invite you.",
      );
    }
    if (!provider.domainsVerifiedAt) {
      await failLogin(provider, asserted, req, "autoProvision on but domains unverified");
      throw forbidden(
        "This SSO connection may create accounts, but nobody has confirmed that the company " +
          `controls ${provider.allowedEmailDomains.join(", ")}. Until a second administrator ` +
          "verifies the domains, creating an account from this assertion would mean trusting an " +
          "unverified domain claim.",
      );
    }

    const resolved = resolveRole(parseGroupMappings(provider.groupRoleMappings), asserted.groups, {
      companyRole: provider.defaultCompanyRole as CompanyRole,
      templateKey: provider.defaultTemplateKey,
    });
    const userId = newId("u");
    const unusable = await bcrypt.hash(randomToken(24), config.BCRYPT_COST);
    await app.db.insert(users).values({
      id: userId,
      email: asserted.email,
      name: asserted.displayName ?? asserted.email,
      // Not a password: a marker plus a hash of a value nobody knows. See
      // policy.ts — it keeps `bcrypt.compare` returning false on the existing
      // login route while remaining recognisable to the unlink guard.
      passwordHash: markSsoOnlyPassword(unusable),
    });
    await app.db.insert(companyMemberships).values({
      id: newId("cm"),
      companyId: provider.companyId,
      userId,
      role: resolved.companyRole,
    });
    const identityId = await linkIdentity(provider, userId, asserted, req, "provisioned");
    await appendLedger(app.db, {
      companyId: provider.companyId,
      actorId: userId,
      action: "create",
      objectType: "user",
      objectId: userId,
      payload: {
        via: "sso",
        providerId: provider.id,
        email: asserted.email,
        role: resolved.companyRole,
        templateKey: resolved.templateKey,
        matchedClaimValue: resolved.matchedClaimValue,
      },
      storePayload: true,
    });
    await recordEvent({
      kind: "sso_user_provisioned",
      companyId: provider.companyId,
      userId,
      email: asserted.email,
      providerId: provider.id,
      identityId,
      metadata: { role: resolved.companyRole, matchedClaimValue: resolved.matchedClaimValue },
      req,
    });

    const user = { id: userId, email: asserted.email, name: asserted.displayName ?? asserted.email };
    const session = await finishSignIn({
      user,
      provider,
      identityId,
      req,
      metadata: { provisioned: true },
    });
    return {
      ...session,
      user,
      company: { id: provider.companyId, role: resolved.companyRole },
      identity: identityView(identityId, provider, asserted, true),
      provisioned: true,
      returnTo: flow.returnTo,
    };
  }

  async function failLogin(
    provider: ProviderRow,
    asserted: AssertedIdentity,
    req: FastifyRequest,
    reason: string,
  ): Promise<void> {
    await recordEvent({
      kind: "sso_login_failure",
      outcome: "blocked",
      companyId: provider.companyId,
      providerId: provider.id,
      email: asserted.email,
      reason,
      metadata: {
        subject: asserted.subject,
        emailVerified: asserted.emailVerified,
        emailReasons: asserted.emailReasons,
      },
      req,
    });
  }

  function identityView(
    id: string,
    provider: ProviderRow,
    asserted: AssertedIdentity,
    linkedNow: boolean,
  ) {
    return {
      id,
      providerId: provider.id,
      providerSlug: provider.slug,
      providerKind: provider.kind as IdentityProviderKind,
      displayName: provider.displayName,
      subject: asserted.subject,
      emailAtLink: asserted.email,
      linkedNow,
    };
  }

  async function linkIdentity(
    provider: ProviderRow,
    userId: string,
    asserted: AssertedIdentity,
    req: FastifyRequest,
    basis: "verified_email" | "authenticated_user" | "provisioned",
  ): Promise<string> {
    const identityId = newId("uid");
    await app.db.insert(userIdentities).values({
      id: identityId,
      userId,
      providerId: provider.id,
      companyId: provider.companyId,
      externalSubject: asserted.subject,
      emailAtLink: asserted.email ?? "",
      displayName: asserted.displayName,
      rawProfile: asserted.rawProfile,
    });
    await appendLedger(app.db, {
      companyId: provider.companyId,
      actorId: userId,
      action: "create",
      objectType: "user_identity",
      objectId: identityId,
      payload: {
        providerId: provider.id,
        subject: asserted.subject,
        emailAtLink: asserted.email,
        basis,
      },
      storePayload: true,
    });
    await recordEvent({
      kind: "sso_identity_linked",
      companyId: provider.companyId,
      userId,
      email: asserted.email,
      providerId: provider.id,
      identityId,
      reason: basis,
      req,
    });
    return identityId;
  }

  async function finishSignIn(options: {
    user: { id: string; email: string; name: string };
    provider: ProviderRow;
    identityId: string;
    req: FastifyRequest;
    metadata?: Record<string, unknown>;
  }) {
    const nowIso = new Date().toISOString();
    const session = await issueSession({
      user: options.user,
      companyId: options.provider.companyId,
      identityId: options.identityId,
      providerId: options.provider.id,
      req: options.req,
    });
    await app.db.update(users).set({ lastLoginAt: nowIso }).where(eq(users.id, options.user.id));
    await app.db
      .update(userIdentities)
      .set({ lastLoginAt: nowIso })
      .where(eq(userIdentities.id, options.identityId));
    await app.db
      .update(identityProviders)
      .set({ lastUsedAt: nowIso })
      .where(eq(identityProviders.id, options.provider.id));
    await recordEvent({
      kind: "sso_login_success",
      companyId: options.provider.companyId,
      userId: options.user.id,
      email: options.user.email,
      providerId: options.provider.id,
      identityId: options.identityId,
      sessionId: session.session.id,
      metadata: options.metadata ?? {},
      req: options.req,
    });
    return session;
  }

  /* ---------------------------------------------------------------- */
  /* Linking and unlinking — the signed-in user's own account          */
  /* ---------------------------------------------------------------- */

  /**
   * Start a link flow for the CURRENT user.
   *
   * The account being linked to is captured here, from a verified bearer
   * token, and stored server-side. Nothing the identity provider later
   * asserts can change it. That is the entire security property: an attacker
   * who controls an account at the provider can complete this flow only for
   * the ConstructOS account whose token they already hold — which is to say,
   * their own.
   */
  app.post("/auth/sso/link", { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = linkSchema.parse(req.body);
    const rows = await app.db
      .select()
      .from(identityProviders)
      .where(or(eq(identityProviders.id, body.providerId), eq(identityProviders.slug, body.providerId)))
      .limit(1);
    const provider = rows[0];
    if (!provider) throw notFound("Unknown SSO connection");
    if (provider.kind === "saml") throw new AppError(501, SAML_UNSUPPORTED_REASON);
    if (!provider.isEnabled) throw badRequest("That SSO connection is not enabled");

    const membership = await app.db
      .select({ role: companyMemberships.role })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, provider.companyId),
          eq(companyMemberships.userId, req.user!.id),
        ),
      )
      .limit(1);
    if (!membership[0]) {
      throw forbidden("You are not a member of the company that owns this SSO connection");
    }

    const url = await beginFlow(provider, {
      req,
      reply,
      mode: body.mode,
      returnTo: safeReturnTo(body.returnTo),
      linkUserId: req.user!.id,
    });
    return {
      authorizationUrl: url,
      redirectUri,
      expiresInSeconds: Math.floor(FLOW_TTL_MS / 1000),
      provider: { id: provider.id, slug: provider.slug, displayName: provider.displayName },
    };
  });

  async function completeLink(
    flow: SsoFlowRecord,
    provider: ProviderRow,
    asserted: AssertedIdentity,
    req: FastifyRequest,
  ) {
    const userRows = await app.db
      .select()
      .from(users)
      .where(eq(users.id, flow.linkUserId!))
      .limit(1);
    const user = userRows[0];
    if (!user || !user.isActive) throw unauthorized("The account this link was started for is not active");

    const clash = await app.db
      .select()
      .from(userIdentities)
      .where(
        and(
          eq(userIdentities.providerId, provider.id),
          eq(userIdentities.externalSubject, asserted.subject),
        ),
      )
      .limit(1);
    if (clash[0] && clash[0].userId !== user.id) {
      await recordEvent({
        kind: "sso_identity_linked",
        outcome: "blocked",
        companyId: provider.companyId,
        userId: user.id,
        providerId: provider.id,
        reason: "external subject already linked to a different account",
        req,
      });
      throw conflict(
        "That identity provider account is already linked to a different ConstructOS account.",
      );
    }
    if (clash[0]) {
      return {
        linked: true,
        alreadyLinked: true,
        identity: identityView(clash[0].id, provider, asserted, false),
        returnTo: flow.returnTo,
      };
    }

    // No verified-email requirement here, and that is deliberate: the bearer
    // token already proved the account holder is present, which is a stronger
    // proof than any email claim. The allow-list constrains what a connection
    // may assert about STRANGERS (the login path), not what a signed-in person
    // may attach to their own account.
    const identityId = await linkIdentity(provider, user.id, asserted, req, "authenticated_user");
    return {
      linked: true,
      alreadyLinked: false,
      identity: identityView(identityId, provider, asserted, true),
      emailVerifiedByProvider: asserted.emailVerified,
      returnTo: flow.returnTo,
    };
  }

  app.get("/auth/sso/identities", { preHandler: [app.authenticate] }, async (req) => {
    const rows = await app.db
      .select({
        id: userIdentities.id,
        providerId: userIdentities.providerId,
        companyId: userIdentities.companyId,
        externalSubject: userIdentities.externalSubject,
        emailAtLink: userIdentities.emailAtLink,
        displayName: userIdentities.displayName,
        linkedAt: userIdentities.linkedAt,
        lastLoginAt: userIdentities.lastLoginAt,
        providerSlug: identityProviders.slug,
        providerKind: identityProviders.kind,
        providerName: identityProviders.displayName,
      })
      .from(userIdentities)
      .innerJoin(identityProviders, eq(identityProviders.id, userIdentities.providerId))
      .where(eq(userIdentities.userId, req.user!.id))
      .orderBy(desc(userIdentities.linkedAt));

    const me = await app.db.select().from(users).where(eq(users.id, req.user!.id)).limit(1);
    const passwordPolicyAllows = await passwordLoginAllowedForUser(req.user!.id);
    const passwordUsable = hasUsablePassword(me[0]?.passwordHash) && passwordPolicyAllows;
    return {
      items: rows,
      signInMethods: {
        password: passwordUsable,
        passwordReasons: passwordUsable
          ? []
          : [
              hasUsablePassword(me[0]?.passwordHash)
                ? "A company you belong to requires SSO — password login is disabled for you."
                : "This account was created by SSO and has never had a password set.",
            ],
        identities: rows.length,
        total: (passwordUsable ? 1 : 0) + rows.length,
      },
    };
  });

  /**
   * Unlink — and refuse when it would be the last way in.
   *
   * "Remove your only sign-in method" is a request the platform must decline
   * on the user's behalf: the account does not become more secure, it becomes
   * unreachable, and the recovery path from there is a support ticket and a
   * database edit.
   */
  app.delete("/auth/sso/identities/:id", { preHandler: [app.authenticate] }, async (req) => {
    const { id } = req.params as { id: string };
    const rows = await app.db
      .select()
      .from(userIdentities)
      .where(and(eq(userIdentities.id, id), eq(userIdentities.userId, req.user!.id)))
      .limit(1);
    const identity = rows[0];
    if (!identity) throw notFound("Linked identity not found on this account");

    const remaining = await app.db
      .select({ id: userIdentities.id })
      .from(userIdentities)
      .where(and(eq(userIdentities.userId, req.user!.id), ne(userIdentities.id, identity.id)));
    const me = await app.db.select().from(users).where(eq(users.id, req.user!.id)).limit(1);
    const passwordPolicyAllows = await passwordLoginAllowedForUser(req.user!.id);
    const passwordUsable = hasUsablePassword(me[0]?.passwordHash) && passwordPolicyAllows;

    if (remaining.length === 0 && !passwordUsable) {
      const reasons: string[] = [];
      if (!hasUsablePassword(me[0]?.passwordHash)) {
        reasons.push(
          "This account was created through SSO and has never had a password set, so removing " +
            "this identity would leave it with no sign-in method at all.",
        );
      } else if (!passwordPolicyAllows) {
        reasons.push(
          "A company you belong to has disabled password login, so this linked identity is " +
            "currently your only way in.",
        );
      }
      throw conflict(
        `Refusing to remove your last sign-in method. ${reasons.join(" ")} Set a password, or ` +
          "link another provider first.",
      );
    }

    await app.db.delete(userIdentities).where(eq(userIdentities.id, identity.id));

    // Sessions authenticated by this identity die with it. Leaving them alive
    // would mean "I removed that provider" and "that provider still has a
    // live session on my account" being true at the same time.
    const nowIso = new Date().toISOString();
    const killed = await app.db
      .select({ id: authSessions.id, refreshTokenId: authSessions.refreshTokenId })
      .from(authSessions)
      .where(and(eq(authSessions.identityId, identity.id), eq(authSessions.userId, req.user!.id)));
    if (killed.length > 0) {
      await app.db
        .update(authSessions)
        .set({
          revokedAt: nowIso,
          revokedByUser: true,
          revokedBy: req.user!.id,
          revokedReason: "sso_policy_changed",
          refreshTokenId: null,
        })
        .where(eq(authSessions.identityId, identity.id));
      const tokenIds = killed
        .map((k) => k.refreshTokenId)
        .filter((t): t is string => typeof t === "string");
      if (tokenIds.length > 0) {
        await app.db
          .update(refreshTokens)
          .set({ revokedAt: nowIso })
          .where(inArray(refreshTokens.id, tokenIds));
      }
    }

    await appendLedger(app.db, {
      companyId: identity.companyId,
      actorId: req.user!.id,
      action: "delete",
      objectType: "user_identity",
      objectId: identity.id,
      payload: {
        providerId: identity.providerId,
        subject: identity.externalSubject,
        sessionsRevoked: killed.length,
      },
      storePayload: true,
    });
    await recordEvent({
      kind: "sso_identity_unlinked",
      companyId: identity.companyId,
      userId: req.user!.id,
      providerId: identity.providerId,
      identityId: identity.id,
      metadata: { sessionsRevoked: killed.length },
      req,
    });

    return {
      ok: true,
      removed: { id: identity.id, providerId: identity.providerId },
      sessionsRevoked: killed.length,
      remainingSignInMethods: {
        password: passwordUsable,
        identities: remaining.length,
        total: (passwordUsable ? 1 : 0) + remaining.length,
      },
    };
  });
};

/**
 * Is password login still permitted for this user?
 *
 * Exported deliberately. The enterprise control — "once SSO works, a company
 * may require it" — is enforced everywhere THIS module decides something, but
 * `POST /auth/v1/auth/login` belongs to modules/identity and this module does
 * not write there. Fastify hooks are plugin-encapsulated and identity is
 * registered first, so nothing here can reach that route either. One call at
 * the top of the login handler closes the gap:
 *
 *     if (!(await isPasswordLoginAllowedForUser(app.db, user.id))) {
 *       // auth_security_events kind: "login_blocked_password_disabled"
 *       throw unauthorized("Your company requires single sign-on.");
 *     }
 *
 * The strictest tenant wins: a user who belongs to a company that has switched
 * password login off does not keep it because another company they are in
 * still allows it.
 */
export async function isPasswordLoginAllowedForUser(db: Db, userId: string): Promise<boolean> {
  const memberships = await db
    .select({ companyId: companyMemberships.companyId })
    .from(companyMemberships)
    .where(eq(companyMemberships.userId, userId));
  if (memberships.length === 0) return true;
  const rows = await db
    .select({ allow: identityProviders.allowPasswordLogin })
    .from(identityProviders)
    .where(
      and(
        inArray(
          identityProviders.companyId,
          memberships.map((m) => m.companyId),
        ),
        eq(identityProviders.isEnabled, true),
      ),
    );
  return !rows.some((r) => !r.allow);
}

/**
 * Read the JOSE header for its `kid` so the right key can be selected from
 * the JWKS. This is NOT trusting the token: nothing from here reaches a
 * decision, it only picks which public key the signature is checked against,
 * and a wrong or absent `kid` ends in a verification failure either way.
 */
function readJwtHeader(token: string): { kid: string | null; alg: string | null } {
  const dot = token.indexOf(".");
  if (dot <= 0) return { kid: null, alg: null };
  try {
    const raw = Buffer.from(token.slice(0, dot), "base64url").toString("utf8");
    const header = JSON.parse(raw) as Record<string, unknown>;
    return {
      kid: typeof header["kid"] === "string" ? header["kid"] : null,
      alg: typeof header["alg"] === "string" ? header["alg"] : null,
    };
  } catch {
    return { kid: null, alg: null };
  }
}
