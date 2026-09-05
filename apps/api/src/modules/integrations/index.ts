import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import {
  developerSandboxes,
  integrationExportProfiles,
  invoiceLineItems,
  invoices,
  oauthAccessTokens,
  oauthClients,
  projects,
  vendors,
  webhookDeliveries,
  webhookEndpoints,
} from "@constructos/db";
import { sha256Hex } from "@constructos/ledger";
import {
  ERP_EXPORT_FORMATS,
  ERP_FEEDS,
  OAUTH_GRANT_TYPES,
  WEBHOOK_DELIVERY_STATUSES,
  type ErpFeed,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger, setLedgerEmitHook } from "../../lib/ledger.js";
import { AppError, badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { eventCatalogue, isValidSubscription } from "./events.js";
import {
  WebhookDispatcher,
  defaultDispatcherOptions,
  getDispatcher,
  registerDispatcher,
} from "./dispatcher.js";
import {
  ATTEMPT_HEADER,
  COMPANY_HEADER,
  DELIVERY_HEADER,
  ENDPOINT_HEADER,
  EVENT_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  deriveEndpointSecret,
  resolveSigningKey,
  secretFingerprint,
} from "./signing.js";
import {
  checkEscalation,
  creatorScopeCeiling,
  formatScope,
  parseScopes,
  epochMs,
  isExpired,
  scopeCatalogue,
  splitScopeString,
} from "./oauth.js";
import {
  newAccessTokenValue,
  newClientIdValue,
  newClientSecretValue,
} from "./machine-auth.js";
import { checkWebhookUrl, policyFor, type SsrfPolicy } from "./ssrf.js";
import {
  applyFieldMap,
  currenciesIn,
  FEED_FIELDS,
  identityFieldMap,
  STARTER_PROFILES,
  toCsv,
  validateFieldMap,
  type CanonicalRow,
  type FieldMapEntry,
} from "./erp.js";
import { buildOpenApiDocument, parseRouteTree } from "./openapi.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

/** http(s) only. A webhook target is a URL we will POST to unattended. */
const deliverableUrl = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }, "url must be an absolute http:// or https:// URL");

const eventKindList = z
  .array(z.string().min(1).max(120))
  .max(200)
  .refine((list) => list.every(isValidSubscription), {
    message:
      'eventKinds entries must be "objectType.action", "objectType.*", "*.action" or "*" ' +
      "(see GET /integrations/events)",
  });

const endpointCreateSchema = z.object({
  name: z.string().min(1).max(200),
  url: deliverableUrl,
  eventKinds: eventKindList.optional(),
  projectId: z.string().min(1).max(64).nullable().optional(),
  active: z.boolean().optional(),
});

const endpointPatchSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    url: deliverableUrl.optional(),
    eventKinds: eventKindList.optional(),
    projectId: z.string().min(1).max(64).nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "no fields to update");

const deliveriesQuery = pageQuerySchema.extend({
  status: z.enum(WEBHOOK_DELIVERY_STATUSES).optional(),
});

const testPingSchema = z
  .object({ note: z.string().max(500).optional() })
  .optional()
  .default({});

const clientCreateSchema = z.object({
  name: z.string().min(1).max(200),
  scopes: z.array(z.string().min(3).max(120)).min(1).max(200),
  tokenTtlSeconds: z.coerce.number().int().min(60).max(86_400).optional(),
  grantTypes: z.array(z.enum(OAUTH_GRANT_TYPES)).min(1).optional(),
});

const clientPatchSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    scopes: z.array(z.string().min(3).max(120)).min(1).max(200).optional(),
    tokenTtlSeconds: z.coerce.number().int().min(60).max(86_400).optional(),
    active: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "no fields to update");

const introspectSchema = z.object({ token: z.string().min(1).max(4096) });

const rotateSecretSchema = z
  .object({
    /** how long BOTH secrets stay valid; 0 cuts over immediately */
    graceMinutes: z.number().int().min(0).max(10_080).optional(),
  })
  .optional()
  .default({});

const replaySchema = z.object({
  fromSeq: z.number().int().min(0),
  toSeq: z.number().int().min(0).nullable().optional(),
  limit: z.number().int().min(1).max(1_000).optional(),
});

const fieldMapEntrySchema = z
  .object({
    target: z.string().min(1).max(120),
    source: z.string().min(1).max(120).optional(),
    constant: z.string().max(200).optional(),
  })
  .strict();

const profileCreateSchema = z.object({
  name: z.string().min(1).max(200),
  system: z.string().min(2).max(40),
  feed: z.enum(ERP_FEEDS),
  fieldMap: z.array(fieldMapEntrySchema).min(1).max(120).optional(),
  format: z.enum(ERP_EXPORT_FORMATS).optional(),
  notes: z.string().max(2000).nullable().optional(),
  /** clone one of the built-in starters instead of writing the map by hand */
  starter: z.string().min(2).max(60).optional(),
});

const profilePatchSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    fieldMap: z.array(fieldMapEntrySchema).min(1).max(120).optional(),
    format: z.enum(ERP_EXPORT_FORMATS).optional(),
    notes: z.string().max(2000).nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "no fields to update");

const erpExportQuery = z.object({
  feed: z.enum(ERP_FEEDS).optional(),
  profileId: z.string().min(1).max(64).optional(),
  format: z.enum(ERP_EXPORT_FORMATS).optional(),
  /** ISO dates bounding the billing period end */
  periodFrom: z.string().min(4).max(40).optional(),
  periodTo: z.string().min(4).max(40).optional(),
  status: z.string().min(2).max(40).optional(),
  limit: z.coerce.number().int().min(1).max(5_000).optional(),
});

const sandboxSchema = z.object({ purpose: z.string().max(500).nullable().optional() });

/* ------------------------------------------------------------------ */
/* Module                                                              */
/* ------------------------------------------------------------------ */

type EndpointRow = typeof webhookEndpoints.$inferSelect;
type ClientRow = typeof oauthClients.$inferSelect;

/**
 * Vol I §0.7 — the integration surface: webhooks sourced from the ledger
 * append path (#121) and OAuth2 client credentials for machine callers (#120).
 *
 * Both halves lean on something the platform already has rather than inventing
 * a parallel world. Webhooks subscribe to the hash-chained ledger, which
 * already observes every consequential mutation, so the event catalogue cannot
 * drift from the record. Machine callers carry `tool:level` scopes from the
 * same vocabulary humans are governed by, so they pass through `requireTool`
 * rather than around it.
 *
 * Everything under /integrations is owner/admin — these are credential and
 * egress-configuration surfaces, and the delivery log is a running index of
 * every mutation in the tenant. The one exception is GET /integrations/events,
 * which any member may read to discover what is subscribable.
 */
export const integrationsModule: FastifyPluginAsync = async (app) => {
  const memberGate = [app.authenticate, app.requireCompany];
  const adminGate = [
    app.authenticate,
    app.requireCompany,
    app.requireCompanyRole(["owner", "admin"]),
  ];

  const isTest = app.appConfig.NODE_ENV === "test";
  const signingKey = resolveSigningKey(app.appConfig.AUTH_SECRET, process.env);

  /*
   * Wiring the emitter: one dispatcher per database handle, registered on the
   * handle so tests can reach it through plugin encapsulation, and hooked into
   * appendLedger. `setLedgerEmitHook` is scoped to this app's Db, so two apps
   * in one process never cross-deliver.
   */
  const dispatcher =
    getDispatcher(app.db) ??
    new WebhookDispatcher(
      app.db,
      signingKey,
      defaultDispatcherOptions(process.env, isTest),
      app.log,
    );
  registerDispatcher(app.db, dispatcher);
  setLedgerEmitHook(app.db, async (event) => {
    await dispatcher.emit(event);
  });

  /*
   * EGRESS POLICY. Webhook targets are checked when they are configured and
   * again immediately before every send. In production that means https only
   * and a DNS resolution whose every answer must be a public address; in
   * development and test the literal-address rules still apply but no name
   * server is consulted, so a suite never depends on DNS and a developer can
   * point a hook at a local tunnel. See ./ssrf.ts for what each rule refuses.
   */
  const ssrfPolicy: SsrfPolicy = policyFor({
    NODE_ENV: app.appConfig.NODE_ENV,
    ...(process.env["WEBHOOK_ALLOW_HOSTS"]
      ? { WEBHOOK_ALLOW_HOSTS: process.env["WEBHOOK_ALLOW_HOSTS"] }
      : {}),
  });
  dispatcher.setSsrfPolicy(ssrfPolicy);

  /*
   * SANDBOX LABELLING. The emit path runs inside the ledger append hook and
   * may not add a query per event, so the sandbox set is cached and refreshed
   * lazily. A tenant that becomes (or stops being) a sandbox is reflected
   * immediately by the routes below, which invalidate the cache on write.
   */
  const sandboxCache = { at: 0, ids: new Set<string>() };
  const SANDBOX_TTL_MS = 60_000;
  async function refreshSandboxCache(force = false): Promise<Set<string>> {
    if (!force && Date.now() - sandboxCache.at < SANDBOX_TTL_MS) return sandboxCache.ids;
    const rows = await app.db
      .select({ companyId: developerSandboxes.companyId })
      .from(developerSandboxes)
      .limit(5_000);
    sandboxCache.ids = new Set(rows.map((r) => r.companyId));
    sandboxCache.at = Date.now();
    return sandboxCache.ids;
  }
  dispatcher.setSandboxCheck((companyId) => sandboxCache.ids.has(companyId));
  void refreshSandboxCache(true).catch(() => {});

  dispatcher.start();
  app.addHook("onClose", async () => {
    dispatcher.stop();
    setLedgerEmitHook(app.db, null);
  });

  /*
   * RETENTION. The delivery log is per endpoint per ledger entry and nothing
   * used to remove a row, so a busy tenant's table grew without bound. Settled
   * rows are pruned on the platform scheduler rather than opportunistically on
   * a page read, because a table that only shrinks when somebody opens the
   * integrations screen is a table that never shrinks on the deployments that
   * need it most.
   */
  app.scheduler.register({
    name: "integrations.webhook-retention",
    description:
      "Prune settled webhook deliveries (delivered/skipped after WEBHOOK_RETENTION_DAYS, " +
      "exhausted after WEBHOOK_RETENTION_EXHAUSTED_DAYS). Pending and failed rows are never " +
      "pruned — they are still owed to a receiver.",
    everyMs: 6 * 60 * 60_000,
    runOnBoot: false,
    run: async ({ now }) => dispatcher.prune(now),
  });

  /**
   * Validate a webhook target against the egress policy, and refuse with the
   * rule that rejected it. A refusal an operator cannot act on is a bug report
   * waiting to happen, so the reason names the range or the rule by name.
   */
  async function assertDeliverable(url: string): Promise<string | null> {
    const verdict = await checkWebhookUrl(url, ssrfPolicy);
    if (!verdict.ok) {
      throw badRequest(`Webhook target refused: ${verdict.reason}`, {
        code: verdict.code,
        guard: "webhook-egress",
      });
    }
    return verdict.addresses[0] ?? null;
  }

  /**
   * A signing secret that shares custody with the JWT secret is forgeable by
   * anyone holding that secret. That is a documented trade-off in development;
   * in production it is a defect, and the moment it would matter is the moment
   * somebody creates an endpoint. So creation is refused there rather than
   * quietly issuing a secret nobody should trust.
   */
  function assertSigningCustody(): void {
    if (signingKey.sharedCustody && app.appConfig.NODE_ENV === "production") {
      throw conflict(
        "WEBHOOK_SIGNING_KEY is not set, so webhook secrets would be derived from AUTH_SECRET " +
          "and anyone holding the JWT signing secret could forge a signature. Set " +
          "WEBHOOK_SIGNING_KEY (32+ random bytes, held separately) before creating endpoints in " +
          "production. Setting it later invalidates existing endpoint secrets, which is why this " +
          "is refused now rather than after integrators have adopted them.",
      );
    }
  }

  /**
   * OAuth2 token requests arrive form-encoded far more often than as JSON, and
   * @fastify/formbody is not a dependency we are adding for six lines. The
   * parser is registered inside this plugin's encapsulation context, so it
   * applies to these routes and changes nothing elsewhere in the API.
   */
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        const out: Record<string, string> = {};
        for (const [key, value] of new URLSearchParams(body as string)) out[key] = value;
        done(null, out);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  /** Strict per-IP limit on the token endpoint, matching the auth routes. */
  const tokenLimited =
    app.appConfig.RATE_LIMIT_ENABLED && app.appConfig.NODE_ENV !== "test"
      ? {
          config: {
            rateLimit: {
              max: app.appConfig.AUTH_RATE_LIMIT_MAX_PER_MINUTE,
              timeWindow: "1 minute",
            },
          },
        }
      : {};

  /* ---------------------------------------------------------------- */
  /* Fetch helpers                                                     */
  /* ---------------------------------------------------------------- */

  async function fetchEndpoint(endpointId: string, companyId: string): Promise<EndpointRow> {
    const [row] = await app.db
      .select()
      .from(webhookEndpoints)
      .where(
        and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.companyId, companyId)),
      )
      .limit(1);
    if (!row) throw notFound("Webhook endpoint not found");
    return row;
  }

  async function fetchDelivery(deliveryId: string, companyId: string) {
    const [row] = await app.db
      .select()
      .from(webhookDeliveries)
      .where(
        and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.companyId, companyId)),
      )
      .limit(1);
    if (!row) throw notFound("Webhook delivery not found");
    return row;
  }

  /** Accepts either the row id or the public client_id — both are unique. */
  async function fetchClient(idOrClientId: string, companyId: string): Promise<ClientRow> {
    const [row] = await app.db
      .select()
      .from(oauthClients)
      .where(
        and(
          eq(oauthClients.companyId, companyId),
          or(eq(oauthClients.id, idOrClientId), eq(oauthClients.clientId, idOrClientId)),
        ),
      )
      .limit(1);
    if (!row) throw notFound("OAuth client not found");
    return row;
  }

  async function assertProjectInCompany(projectId: string, companyId: string) {
    const [row] = await app.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .limit(1);
    if (!row) throw badRequest("projectId is not a project in this company");
  }

  /** The signing contract, repeated on every response an integrator will read. */
  const signingContract = () => ({
    algorithm: "HMAC-SHA256",
    signatureVersion: "v1",
    headers: {
      signature: SIGNATURE_HEADER,
      timestamp: TIMESTAMP_HEADER,
      delivery: DELIVERY_HEADER,
      event: EVENT_HEADER,
      endpoint: ENDPOINT_HEADER,
      company: COMPANY_HEADER,
      attempt: ATTEMPT_HEADER,
    },
    stringToSign: "v1:{timestamp}:{deliveryId}:{rawBody}",
    signatureHeaderFormat: "v1=<lowercase hex hmac-sha256>",
    verify:
      "Recompute the HMAC over the RAW body before parsing it, join with literal colons, and " +
      "compare in constant time. Dedupe on the delivery header: a retry re-sends identical " +
      "bytes and an identical signature, so a freshness window must cover the whole retry " +
      "budget rather than a few seconds.",
    keySource: dispatcher.keySource(),
  });

  const viewEndpoint = (row: EndpointRow) => ({
    ...row,
    isActive: row.isActive === 1,
    // Re-derive and compare: if the master key was rotated or the fallback
    // swapped for a dedicated key, the secret an operator holds no longer
    // works and this is where they find out. The endpoint's CURRENT secret
    // version is what the fingerprint was taken over — deriving version 1 here
    // would report every rotated endpoint as unreproducible and tell its owner
    // to delete it.
    secretFingerprintMatches:
      secretFingerprint(deriveEndpointSecret(signingKey, row.id, row.secretVersion)) ===
      row.secretFingerprint,
  });

  const viewClient = (row: ClientRow) => {
    const { clientSecretHash, ...rest } = row;
    void clientSecretHash;
    return { ...rest, isActive: rest.isActive === 1 };
  };

  /* ================================================================ */
  /* WEBHOOKS                                                          */
  /* ================================================================ */

  app.post("/integrations/webhooks", { preHandler: adminGate }, async (req, reply) => {
    const body = endpointCreateSchema.parse(req.body);
    if (body.projectId) await assertProjectInCompany(body.projectId, req.companyId!);
    assertSigningCustody();
    const verifiedHost = await assertDeliverable(body.url);

    const id = newId("whe");
    // The secret is derived, not generated: HKDF(masterKey, salt=id) means the
    // database can hold a fingerprint alone and the send path can still sign.
    const secret = deriveEndpointSecret(signingKey, id);
    const fingerprint = secretFingerprint(secret);
    await app.db.insert(webhookEndpoints).values({
      id,
      companyId: req.companyId!,
      name: body.name,
      url: body.url,
      eventKinds: body.eventKinds ?? [],
      projectId: body.projectId ?? null,
      isActive: body.active === false ? 0 : 1,
      secretFingerprint: fingerprint,
      verifiedHost,
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "webhook_endpoint",
      objectId: id,
      projectId: body.projectId ?? null,
      payload: {
        name: body.name,
        url: body.url,
        eventKinds: body.eventKinds ?? [],
        projectId: body.projectId ?? null,
        secretFingerprint: fingerprint,
        // Recorded, not merely computed: which custody this endpoint's secret
        // was derived under is a fact about the deployment at this instant.
        signingKeySource: signingKey.source,
        signingKeySharedCustody: signingKey.sharedCustody,
      },
      storePayload: true,
    });

    return reply.status(201).send({
      endpoint: viewEndpoint(await fetchEndpoint(id, req.companyId!)),
      secret,
      secretWarning:
        "This signing secret is shown exactly once. It is not stored — the database holds only " +
        "its sha256 fingerprint — and no route will return it again. Save it now; to replace it, " +
        "POST .../rotate-secret, which issues a new one and signs with both for a grace window.",
      signing: signingContract(),
      insecureTransport: body.url.startsWith("http://")
        ? "This endpoint is http://, so signed payloads travel in clear text. The signature " +
          "proves origin and integrity but not confidentiality — use https:// in production."
        : null,
    });
  });

  app.get("/integrations/webhooks", { preHandler: adminGate }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    const where = eq(webhookEndpoints.companyId, req.companyId!);
    const [totalRow] = await app.db.select({ n: count() }).from(webhookEndpoints).where(where);
    const items = await app.db
      .select()
      .from(webhookEndpoints)
      .where(where)
      .orderBy(desc(webhookEndpoints.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items.map(viewEndpoint), Number(totalRow?.n ?? 0), q);
  });

  app.get("/integrations/webhooks/:endpointId", { preHandler: adminGate }, async (req) => {
    const { endpointId } = req.params as { endpointId: string };
    const row = await fetchEndpoint(endpointId, req.companyId!);
    const [totalRow] = await app.db
      .select({ n: count() })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, row.id));
    return {
      endpoint: viewEndpoint(row),
      deliveryCount: Number(totalRow?.n ?? 0),
      signing: signingContract(),
    };
  });

  app.patch("/integrations/webhooks/:endpointId", { preHandler: adminGate }, async (req) => {
    const { endpointId } = req.params as { endpointId: string };
    const body = endpointPatchSchema.parse(req.body);
    const existing = await fetchEndpoint(endpointId, req.companyId!);
    if (body.projectId) await assertProjectInCompany(body.projectId, req.companyId!);
    // A URL change is a new egress target: it is checked exactly as a new
    // endpoint's is. Re-enabling re-checks the existing URL too, because the
    // endpoint may have been disabled BY the guard.
    let verifiedHost = existing.verifiedHost;
    if (body.url !== undefined || body.active === true) {
      verifiedHost = await assertDeliverable(body.url ?? existing.url);
    }

    const reactivating = body.active === true && existing.isActive !== 1;
    await app.db
      .update(webhookEndpoints)
      .set({
        name: body.name ?? existing.name,
        url: body.url ?? existing.url,
        eventKinds: body.eventKinds ?? existing.eventKinds,
        projectId: body.projectId === undefined ? existing.projectId : body.projectId,
        isActive:
          body.active === undefined ? existing.isActive : body.active ? 1 : 0,
        verifiedHost,
        // Re-enabling is an explicit statement that the receiver is fixed, so
        // it clears the consecutive-failure run, the breaker and the disabled
        // reason with it.
        ...(reactivating
          ? {
              failureCount: 0,
              disabledReason: null,
              consecutiveErrors: 0,
              circuitOpenUntil: null,
            }
          : {}),
        ...(body.active === false
          ? { disabledReason: `Disabled by ${req.user!.id} on ${new Date().toISOString()}` }
          : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(webhookEndpoints.id, endpointId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "webhook_endpoint",
      objectId: endpointId,
      payload: { changed: Object.keys(body), reactivated: reactivating },
    });
    return viewEndpoint(await fetchEndpoint(endpointId, req.companyId!));
  });

  app.delete("/integrations/webhooks/:endpointId", { preHandler: adminGate }, async (req) => {
    const { endpointId } = req.params as { endpointId: string };
    const existing = await fetchEndpoint(endpointId, req.companyId!);
    const [countRow] = await app.db
      .select({ n: count() })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, existing.id));
    await app.db
      .delete(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, existing.id));
    await app.db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, existing.id));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "webhook_endpoint",
      objectId: endpointId,
      payload: {
        name: existing.name,
        url: existing.url,
        deliveriesDeleted: Number(countRow?.n ?? 0),
      },
      storePayload: true,
    });
    return {
      deleted: true,
      endpointId,
      deliveriesDeleted: Number(countRow?.n ?? 0),
    };
  });

  app.post("/integrations/webhooks/:endpointId/test", { preHandler: adminGate }, async (req) => {
    const { endpointId } = req.params as { endpointId: string };
    testPingSchema.parse(req.body ?? {});
    const endpoint = await fetchEndpoint(endpointId, req.companyId!);
    if (endpoint.isActive !== 1) {
      throw conflict(
        `Endpoint is disabled (${endpoint.disabledReason ?? "deactivated"}) — re-enable it ` +
          "before sending a test ping.",
      );
    }
    const deliveryId = await dispatcher.enqueueTest(endpoint, req.user!.id);
    // A test ping is attempted synchronously: an operator pressing "test" is
    // asking a question and deserves the answer in the response, not in a log.
    const delivery = await dispatcher.dispatchOne(deliveryId);
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "webhook_endpoint",
      objectId: endpoint.id,
      payload: { phase: "test_ping", deliveryId, status: delivery?.status ?? "unknown" },
    });
    return { delivery, signing: signingContract() };
  });

  app.get(
    "/integrations/webhooks/:endpointId/deliveries",
    { preHandler: adminGate },
    async (req) => {
      const { endpointId } = req.params as { endpointId: string };
      const q = deliveriesQuery.parse(req.query);
      const endpoint = await fetchEndpoint(endpointId, req.companyId!);
      const where = and(
        eq(webhookDeliveries.endpointId, endpoint.id),
        // Belt and braces: the endpoint is already tenant-checked, but the
        // company predicate keeps a mis-scoped index scan from ever leaking.
        eq(webhookDeliveries.companyId, req.companyId!),
        q.status ? eq(webhookDeliveries.status, q.status) : undefined,
      );
      const [totalRow] = await app.db.select({ n: count() }).from(webhookDeliveries).where(where);
      const items = await app.db
        .select()
        .from(webhookDeliveries)
        .where(where)
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      return paginate(items, Number(totalRow?.n ?? 0), q);
    },
  );

  app.post(
    "/integrations/webhooks/deliveries/:deliveryId/retry",
    { preHandler: adminGate },
    async (req) => {
      const { deliveryId } = req.params as { deliveryId: string };
      const delivery = await fetchDelivery(deliveryId, req.companyId!);
      if (delivery.status === "delivered") {
        throw conflict("Delivery already succeeded — retrying would duplicate it");
      }
      const previousAttempts = delivery.attempts;
      // A manual retry re-arms the full attempt budget. The count it replaces
      // is preserved in the ledger entry below, so the history is not lost.
      await app.db
        .update(webhookDeliveries)
        .set({
          status: "pending",
          attempts: 0,
          nextAttemptAt: new Date().toISOString(),
          error: null,
        })
        .where(eq(webhookDeliveries.id, delivery.id));
      const after = await dispatcher.dispatchOne(delivery.id);
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "webhook_delivery",
        objectId: delivery.id,
        payload: {
          phase: "manual_retry",
          previousStatus: delivery.status,
          previousAttempts,
          status: after?.status ?? "unknown",
        },
      });
      return { delivery: after };
    },
  );

  app.get("/integrations/webhooks/status", { preHandler: adminGate }, async (req) => {
    const opts = dispatcher.options;
    return {
      queue: await dispatcher.queueDepth(req.companyId!),
      // Depth alone cannot tell "fifty events arrived this second" from "one
      // event has been stuck for six hours", and only the second is an
      // incident — so the lag is reported next to it.
      lag: await dispatcher.queueLag(req.companyId!),
      emitter: dispatcher.getHealth(),
      signing: signingContract(),
      egress: {
        requireHttps: ssrfPolicy.requireHttps,
        resolvesHostnames: ssrfPolicy.resolve !== null,
        allowHosts: ssrfPolicy.allowHosts ?? [],
        note:
          "Every webhook target is checked when it is configured AND immediately before each " +
          "send. Loopback, link-local (including cloud metadata), RFC 1918, carrier-grade NAT, " +
          "unique-local, multicast and reserved ranges are refused, as are host names that only " +
          "name something inside the deployment. A target that starts resolving privately is " +
          "refused at send time and the endpoint is disabled.",
      },
      delivery: {
        maxAttempts: opts.maxAttempts,
        backoffBaseMs: opts.backoffBaseMs,
        backoffMaxMs: opts.backoffMaxMs,
        failureThreshold: opts.failureThreshold,
        responseBodyLimit: opts.responseBodyLimit,
        requestTimeoutMs: opts.requestTimeoutMs,
        dispatchIntervalMs: opts.intervalMs,
        leaseMs: opts.leaseMs,
        endpointConcurrency: opts.endpointConcurrency,
        circuitErrorThreshold: opts.circuitErrorThreshold,
        circuitOpenMs: opts.circuitOpenMs,
        retentionDays: opts.retentionDays,
        retentionExhaustedDays: opts.retentionExhaustedDays,
        mode:
          opts.intervalMs > 0
            ? "in-process interval timer; rows are claimed with a lease so replicas share the " +
              "queue instead of duplicating it, endpoints are attempted concurrently under a " +
              "bounded pool, and a per-endpoint circuit breaker keeps one dead receiver from " +
              "consuming the cycle"
            : "manual drain only (test mode)",
      },
      env: {
        WEBHOOK_SIGNING_KEY: "HKDF master key; falls back to AUTH_SECRET (shared custody)",
        WEBHOOK_MAX_ATTEMPTS: opts.maxAttempts,
        WEBHOOK_BACKOFF_BASE_MS: opts.backoffBaseMs,
        WEBHOOK_BACKOFF_MAX_MS: opts.backoffMaxMs,
        WEBHOOK_FAILURE_THRESHOLD: opts.failureThreshold,
        WEBHOOK_RESPONSE_BODY_LIMIT: opts.responseBodyLimit,
        WEBHOOK_DISPATCH_INTERVAL_MS: opts.intervalMs,
        WEBHOOK_TIMEOUT_MS: opts.requestTimeoutMs,
        WEBHOOK_BATCH_SIZE: opts.batchSize,
        WEBHOOK_LEASE_MS: opts.leaseMs,
        WEBHOOK_ENDPOINT_CONCURRENCY: opts.endpointConcurrency,
        WEBHOOK_CIRCUIT_ERRORS: opts.circuitErrorThreshold,
        WEBHOOK_CIRCUIT_OPEN_MS: opts.circuitOpenMs,
        WEBHOOK_RETENTION_DAYS: opts.retentionDays,
        WEBHOOK_RETENTION_EXHAUSTED_DAYS: opts.retentionExhaustedDays,
        WEBHOOK_ALLOW_HOSTS: (ssrfPolicy.allowHosts ?? []).join(",") || "(none)",
      },
    };
  });

  /**
   * The subscribable vocabulary, derived from this tenant's own ledger.
   *
   * The derivation is a GROUP BY over every ledger entry the company holds,
   * which on a tenant with millions of entries is a multi-second scan — and
   * the integrations page fetched it on mount for every member. It is cached
   * per company for a short window: the catalogue describes which KINDS have
   * been seen, and a kind that first appears thirty seconds later is not a
   * fact anyone is waiting on.
   */
  const catalogueCache = new Map<string, { at: number; value: Awaited<ReturnType<typeof eventCatalogue>> }>();
  const CATALOGUE_TTL_MS = 30_000;

  app.get("/integrations/events", { preHandler: memberGate }, async (req) => {
    const companyId = req.companyId!;
    const cached = catalogueCache.get(companyId);
    const now = Date.now();
    if (cached && now - cached.at < CATALOGUE_TTL_MS) {
      return { ...cached.value, cached: true, cacheTtlMs: CATALOGUE_TTL_MS };
    }
    const value = await eventCatalogue(app.db, companyId);
    catalogueCache.set(companyId, { at: now, value });
    // Bounded: a long-lived process serving many tenants must not accumulate a
    // catalogue per tenant for ever.
    if (catalogueCache.size > 200) {
      const oldest = [...catalogueCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) catalogueCache.delete(oldest[0]);
    }
    return { ...value, cached: false, cacheTtlMs: CATALOGUE_TTL_MS };
  });

  /* ---------------------------------------------------------------- */
  /* Secret rotation                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * Rotate an endpoint's signing secret WITHOUT dropping a delivery.
   *
   * Before this, the only way to change a secret was to delete the endpoint
   * and create another — which loses the delivery history and guarantees a gap.
   * Rotation increments a version on the row (the secret is HKDF(masterKey,
   * `id:vN`), so nothing secret is stored either way) and opens a grace window
   * during which every delivery carries TWO valid signatures: the standard
   * header signed with the secret the receiver already holds, and an alternate
   * header signed with the new one. The receiver adopts the new secret by
   * accepting either header; when the window closes the standard header
   * carries the new secret alone.
   */
  app.post(
    "/integrations/webhooks/:endpointId/rotate-secret",
    { preHandler: adminGate },
    async (req) => {
      const { endpointId } = req.params as { endpointId: string };
      const body = rotateSecretSchema.parse(req.body ?? {});
      const existing = await fetchEndpoint(endpointId, req.companyId!);
      const graceMinutes = body.graceMinutes ?? 60 * 24;
      const now = new Date();
      const nextVersion = existing.secretVersion + 1;
      const graceUntil =
        graceMinutes > 0
          ? new Date(now.getTime() + graceMinutes * 60_000).toISOString()
          : null;
      const secret = dispatcher.secretFor(endpointId, nextVersion);
      await app.db
        .update(webhookEndpoints)
        .set({
          secretVersion: nextVersion,
          previousSecretVersion: graceUntil ? existing.secretVersion : null,
          secretGraceUntil: graceUntil,
          secretFingerprint: secretFingerprint(secret),
          updatedAt: now.toISOString(),
        })
        .where(eq(webhookEndpoints.id, endpointId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "webhook_endpoint",
        objectId: endpointId,
        payload: {
          phase: "secret_rotation",
          fromVersion: existing.secretVersion,
          toVersion: nextVersion,
          graceMinutes,
          graceUntil,
          secretFingerprint: secretFingerprint(secret),
        },
        storePayload: true,
      });
      return {
        endpoint: viewEndpoint(await fetchEndpoint(endpointId, req.companyId!)),
        secret,
        secretVersion: nextVersion,
        graceUntil,
        secretWarning:
          "This is the new signing secret and it is shown exactly once. Nothing is stored but " +
          "its fingerprint.",
        rotation: graceUntil
          ? {
              headers: {
                current: "x-constructos-signature (old secret, until the grace window closes)",
                next: "x-constructos-signature-alt (the new secret, valid now)",
                version: "x-constructos-secret-version / x-constructos-secret-version-alt",
              },
              note:
                `Until ${graceUntil} every delivery carries both signatures. Accept EITHER ` +
                "header while you switch; after that instant the standard header carries the " +
                "new secret alone and the alternate header stops being sent.",
            }
          : {
              note:
                "graceMinutes was 0, so the cutover is immediate: the very next delivery is " +
                "signed with the new secret only. Any receiver still holding the old one will " +
                "reject it.",
            },
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Replay                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Re-derive deliveries from the ledger for one endpoint (#121).
   *
   * A receiver that was down past its retry budget, or an integrator adding a
   * subscription to a platform that has been running for months, previously had
   * no way to catch up: the queue only ever held what was emitted while the
   * endpoint existed and was active. Replay reads the hash-chained ledger — the
   * platform's own record of what happened — from a sequence number forward and
   * enqueues exactly the entries the endpoint's subscription selects.
   */
  app.post(
    "/integrations/webhooks/:endpointId/replay",
    { preHandler: adminGate },
    async (req) => {
      const { endpointId } = req.params as { endpointId: string };
      const body = replaySchema.parse(req.body ?? {});
      const endpoint = await fetchEndpoint(endpointId, req.companyId!);
      if (endpoint.isActive !== 1) {
        throw conflict(
          "Endpoint is disabled — re-enable it before replaying, or the replayed deliveries " +
            "would be queued only to be skipped.",
        );
      }
      const limit = body.limit ?? 200;
      const outcome = await dispatcher.enqueueReplay(endpoint, {
        fromSeq: body.fromSeq,
        toSeq: body.toSeq ?? null,
        limit,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "webhook_endpoint",
        objectId: endpointId,
        payload: { phase: "replay", ...body, ...outcome },
        storePayload: true,
      });
      return {
        ...outcome,
        endpointId,
        limit,
        note:
          "Replayed deliveries are ordinary deliveries with new ids, so a receiver that dedupes " +
          "on x-constructos-delivery will process each event once per replay. `scanned` counts " +
          "ledger entries read; `enqueued` counts those the subscription selected. Continue " +
          `from fromSeq=${(outcome.lastSeq ?? body.fromSeq) + 1} to page through more. A ` +
          "project-narrowed endpoint replays only entries whose stored payload names its " +
          "project, because ledger_entries does not carry a project column.",
      };
    },
  );

  /* ================================================================ */
  /* OAUTH2 — client management                                        */
  /* ================================================================ */

  app.get("/integrations/oauth/scopes", { preHandler: memberGate }, async () => scopeCatalogue());

  app.post("/integrations/oauth/clients", { preHandler: adminGate }, async (req, reply) => {
    const body = clientCreateSchema.parse(req.body);
    const parsed = parseScopes(body.scopes);
    if (!parsed.ok) {
      throw badRequest(
        `Invalid scope(s): ${parsed.invalid.join(", ")}. Scopes are "tool:level" pairs — ` +
          "see GET /integrations/oauth/scopes.",
        { invalid: parsed.invalid },
      );
    }
    const ceiling = await creatorScopeCeiling(app.db, {
      companyId: req.companyId!,
      userId: req.user!.id,
      companyRole: req.companyRole,
    });
    const escalation = checkEscalation(parsed.scopes, ceiling);
    if (!escalation.ok) {
      throw new AppError(
        403,
        "A machine client may not be granted more than its creator holds. Refused: " +
          escalation.refused
            .map((r) => `${r.scope} (you hold ${r.creatorHolds})`)
            .join(", "),
        { refused: escalation.refused, ceilingBasis: ceiling.basis },
      );
    }

    const id = newId("oac");
    const clientId = newClientIdValue();
    const clientSecret = newClientSecretValue();
    const scopeStrings = parsed.scopes.map(formatScope);
    await app.db.insert(oauthClients).values({
      id,
      companyId: req.companyId!,
      name: body.name,
      clientId,
      // sha256 only — the same custody rule the ingestion API tokens follow.
      clientSecretHash: sha256Hex(clientSecret),
      scopes: scopeStrings,
      grantTypes: body.grantTypes ?? ["client_credentials"],
      tokenTtlSeconds: body.tokenTtlSeconds ?? 3600,
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "oauth_client",
      objectId: id,
      payload: {
        name: body.name,
        clientId,
        scopes: scopeStrings,
        tokenTtlSeconds: body.tokenTtlSeconds ?? 3600,
        ceilingBasis: ceiling.basis,
      },
      storePayload: true,
    });

    const created = await fetchClient(id, req.companyId!);
    return reply.status(201).send({
      client: viewClient(created),
      clientId,
      clientSecret,
      secretWarning:
        "This client secret is shown exactly once — only its sha256 is stored and no route " +
        "will return it again. If it is lost, revoke this client and create another.",
      tokenEndpoint: "/api/v1/oauth/token",
      grantType: "client_credentials",
      example:
        "curl -u '<client_id>:<client_secret>' -d grant_type=client_credentials " +
        "https://<host>/api/v1/oauth/token",
    });
  });

  app.get("/integrations/oauth/clients", { preHandler: adminGate }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    const where = eq(oauthClients.companyId, req.companyId!);
    const [totalRow] = await app.db.select({ n: count() }).from(oauthClients).where(where);
    const items = await app.db
      .select()
      .from(oauthClients)
      .where(where)
      .orderBy(desc(oauthClients.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items.map(viewClient), Number(totalRow?.n ?? 0), q);
  });

  app.get("/integrations/oauth/clients/:clientId", { preHandler: adminGate }, async (req) => {
    const { clientId } = req.params as { clientId: string };
    const client = await fetchClient(clientId, req.companyId!);
    const [totalRow] = await app.db
      .select({ n: count() })
      .from(oauthAccessTokens)
      .where(eq(oauthAccessTokens.clientId, client.id));
    return { client: viewClient(client), tokenCount: Number(totalRow?.n ?? 0) };
  });

  app.patch("/integrations/oauth/clients/:clientId", { preHandler: adminGate }, async (req) => {
    const { clientId } = req.params as { clientId: string };
    const body = clientPatchSchema.parse(req.body);
    const client = await fetchClient(clientId, req.companyId!);
    let scopeStrings = client.scopes as string[];
    if (body.scopes) {
      const parsed = parseScopes(body.scopes);
      if (!parsed.ok) {
        throw badRequest(`Invalid scope(s): ${parsed.invalid.join(", ")}`, {
          invalid: parsed.invalid,
        });
      }
      const ceiling = await creatorScopeCeiling(app.db, {
        companyId: req.companyId!,
        userId: req.user!.id,
        companyRole: req.companyRole,
      });
      const escalation = checkEscalation(parsed.scopes, ceiling);
      if (!escalation.ok) {
        throw new AppError(
          403,
          "A machine client may not be granted more than the person editing it holds. Refused: " +
            escalation.refused.map((r) => `${r.scope} (you hold ${r.creatorHolds})`).join(", "),
          { refused: escalation.refused, ceilingBasis: ceiling.basis },
        );
      }
      scopeStrings = parsed.scopes.map(formatScope);
    }
    await app.db
      .update(oauthClients)
      .set({
        name: body.name ?? client.name,
        scopes: scopeStrings,
        tokenTtlSeconds: body.tokenTtlSeconds ?? client.tokenTtlSeconds,
        isActive: body.active === undefined ? client.isActive : body.active ? 1 : 0,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(oauthClients.id, client.id));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "oauth_client",
      objectId: client.id,
      payload: { changed: Object.keys(body), scopes: scopeStrings },
      storePayload: true,
    });
    return viewClient(await fetchClient(client.id, req.companyId!));
  });

  app.post(
    "/integrations/oauth/clients/:clientId/revoke",
    { preHandler: adminGate },
    async (req) => {
      const { clientId } = req.params as { clientId: string };
      const client = await fetchClient(clientId, req.companyId!);
      if (client.revokedAt) throw conflict("OAuth client is already revoked");
      const now = new Date().toISOString();
      await app.db
        .update(oauthClients)
        .set({ revokedAt: now, isActive: 0, updatedAt: now })
        .where(eq(oauthClients.id, client.id));
      // Revoking a client revokes its live tokens in the same breath: a
      // credential that keeps working for another hour is not revoked.
      const tokensRevoked = await app.db
        .update(oauthAccessTokens)
        .set({ revokedAt: now })
        .where(
          and(
            eq(oauthAccessTokens.clientId, client.id),
            isNull(oauthAccessTokens.revokedAt),
          ),
        )
        .returning({ id: oauthAccessTokens.id });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "oauth_client",
        objectId: client.id,
        payload: {
          revoked: true,
          clientId: client.clientId,
          tokensRevoked: tokensRevoked.length,
        },
        storePayload: true,
      });
      return {
        client: viewClient(await fetchClient(client.id, req.companyId!)),
        tokensRevoked: tokensRevoked.length,
      };
    },
  );

  app.get(
    "/integrations/oauth/clients/:clientId/tokens",
    { preHandler: adminGate },
    async (req) => {
      const { clientId } = req.params as { clientId: string };
      const q = pageQuerySchema.parse(req.query);
      const client = await fetchClient(clientId, req.companyId!);
      const where = and(
        eq(oauthAccessTokens.clientId, client.id),
        eq(oauthAccessTokens.companyId, req.companyId!),
      );
      const [totalRow] = await app.db.select({ n: count() }).from(oauthAccessTokens).where(where);
      const items = await app.db
        .select({
          id: oauthAccessTokens.id,
          companyId: oauthAccessTokens.companyId,
          clientId: oauthAccessTokens.clientId,
          scopes: oauthAccessTokens.scopes,
          expiresAt: oauthAccessTokens.expiresAt,
          revokedAt: oauthAccessTokens.revokedAt,
          lastUsedAt: oauthAccessTokens.lastUsedAt,
          issuedAt: oauthAccessTokens.issuedAt,
        })
        .from(oauthAccessTokens)
        .where(where)
        .orderBy(desc(oauthAccessTokens.issuedAt))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      return paginate(items, Number(totalRow?.n ?? 0), q);
    },
  );

  app.post(
    "/integrations/oauth/tokens/:tokenId/revoke",
    { preHandler: adminGate },
    async (req) => {
      const { tokenId } = req.params as { tokenId: string };
      const [row] = await app.db
        .select()
        .from(oauthAccessTokens)
        .where(
          and(
            eq(oauthAccessTokens.id, tokenId),
            eq(oauthAccessTokens.companyId, req.companyId!),
          ),
        )
        .limit(1);
      if (!row) throw notFound("Access token not found");
      if (row.revokedAt) throw conflict("Access token is already revoked");
      const now = new Date().toISOString();
      await app.db
        .update(oauthAccessTokens)
        .set({ revokedAt: now })
        .where(eq(oauthAccessTokens.id, row.id));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "oauth_access_token",
        objectId: row.id,
        payload: { revoked: true, clientId: row.clientId },
      });
      return { id: row.id, revokedAt: now, active: false };
    },
  );

  /**
   * RFC 7662-shaped introspection for an operator, not for the client. It is
   * an admin surface deliberately: it answers "is this credential live and
   * what can it do", which is an incident-response question.
   */
  app.post("/integrations/oauth/introspect", { preHandler: adminGate }, async (req) => {
    const body = introspectSchema.parse(req.body);
    const [row] = await app.db
      .select()
      .from(oauthAccessTokens)
      .where(eq(oauthAccessTokens.tokenHash, sha256Hex(body.token.trim())))
      .limit(1);
    const inactive = { active: false as const };
    // A token belonging to another tenant is reported exactly as an unknown
    // token: introspection must not be an oracle for other companies.
    if (!row || row.companyId !== req.companyId) return inactive;
    if (row.revokedAt || isExpired(row.expiresAt, Date.now())) return inactive;
    const [client] = await app.db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.id, row.clientId))
      .limit(1);
    if (!client || client.isActive !== 1 || client.revokedAt) return inactive;
    return {
      active: true,
      scope: (row.scopes as string[]).join(" "),
      client_id: client.clientId,
      client_name: client.name,
      token_type: "Bearer",
      exp: Math.floor((epochMs(row.expiresAt) ?? 0) / 1000),
      iat: Math.floor((epochMs(row.issuedAt) ?? 0) / 1000),
      company_id: row.companyId,
      last_used_at: row.lastUsedAt,
      token_id: row.id,
    };
  });

  /* ================================================================ */
  /* OAUTH2 — the token endpoint                                       */
  /* ================================================================ */

  interface ClientCredentials {
    clientId: string;
    clientSecret: string;
    via: "basic" | "body";
  }

  function readCredentials(req: FastifyRequest): ClientCredentials | null {
    const header = req.headers.authorization;
    if (header?.toLowerCase().startsWith("basic ")) {
      const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      if (idx === -1) return null;
      // RFC 6749 §2.3.1 form-urlencodes the two halves before base64.
      const safeDecode = (v: string) => {
        try {
          return decodeURIComponent(v.replace(/\+/g, " "));
        } catch {
          return v;
        }
      };
      return {
        clientId: safeDecode(decoded.slice(0, idx)),
        clientSecret: safeDecode(decoded.slice(idx + 1)),
        via: "basic",
      };
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = body["client_id"];
    const secret = body["client_secret"];
    if (typeof id === "string" && typeof secret === "string" && id && secret) {
      return { clientId: id, clientSecret: secret, via: "body" };
    }
    return null;
  }

  /** RFC 6749 §5.2 error bodies, which are not the platform's usual shape. */
  function oauthError(
    reply: FastifyReply,
    status: number,
    error: string,
    description: string,
    challenge = false,
  ) {
    if (challenge) void reply.header("www-authenticate", 'Basic realm="constructos"');
    return reply
      .status(status)
      .header("cache-control", "no-store")
      .header("pragma", "no-cache")
      .send({ error, error_description: description });
  }

  app.post("/oauth/token", tokenLimited, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const grantType = typeof body["grant_type"] === "string" ? body["grant_type"] : "";
    if (grantType !== "client_credentials") {
      return oauthError(
        reply,
        400,
        grantType === "" ? "invalid_request" : "unsupported_grant_type",
        grantType === ""
          ? "grant_type is required and must be client_credentials"
          : `grant_type "${grantType}" is not supported; this deployment issues ` +
            "client_credentials only",
      );
    }
    const creds = readCredentials(req);
    if (!creds) {
      return oauthError(
        reply,
        401,
        "invalid_client",
        "Client authentication required: send HTTP Basic credentials, or client_id and " +
          "client_secret in the request body",
        true,
      );
    }

    const [client] = await app.db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, creds.clientId))
      .limit(1);
    // One indistinguishable answer for unknown client, wrong secret, revoked
    // and deactivated: a token endpoint must not be a client-id oracle.
    const badClient = () =>
      oauthError(
        reply,
        401,
        "invalid_client",
        "Client authentication failed",
        creds.via === "basic",
      );
    if (!client) return badClient();
    if (sha256Hex(creds.clientSecret) !== client.clientSecretHash) return badClient();
    if (client.isActive !== 1 || client.revokedAt) return badClient();
    if (!(client.grantTypes as string[]).includes("client_credentials")) {
      return oauthError(
        reply,
        400,
        "unauthorized_client",
        "This client is not configured for the client_credentials grant",
      );
    }

    const granted = client.scopes as string[];
    let issuedScopes = granted;
    const requested = body["scope"];
    if (typeof requested === "string" && requested.trim() !== "") {
      const wanted = splitScopeString(requested);
      const excess = wanted.filter((s) => !granted.includes(s));
      if (excess.length > 0) {
        return oauthError(
          reply,
          400,
          "invalid_scope",
          `Requested scope exceeds what this client was granted: ${excess.join(" ")}. ` +
            `Granted: ${granted.join(" ") || "none"}`,
        );
      }
      issuedScopes = wanted;
    }
    if (issuedScopes.length === 0) {
      return oauthError(
        reply,
        400,
        "invalid_scope",
        "This client holds no scopes, so no useful token can be issued",
      );
    }

    const token = newAccessTokenValue();
    const ttl = client.tokenTtlSeconds;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    const tokenRowId = newId("oat");
    await app.db.insert(oauthAccessTokens).values({
      id: tokenRowId,
      companyId: client.companyId,
      clientId: client.id,
      tokenHash: sha256Hex(token),
      // The token carries its own scopes: later narrowing of the client must
      // not retroactively widen a token, nor widening silently upgrade one.
      scopes: issuedScopes,
      expiresAt,
    });
    await app.db
      .update(oauthClients)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(oauthClients.id, client.id));
    await appendLedger(app.db, {
      companyId: client.companyId,
      // No human authored this; the ledger says so rather than borrowing the
      // creator's identity.
      actorId: null,
      action: "create",
      objectType: "oauth_access_token",
      objectId: tokenRowId,
      payload: {
        via: "client_credentials",
        clientId: client.clientId,
        scopes: issuedScopes,
        expiresAt,
      },
      storePayload: true,
    });

    return reply
      .status(200)
      .header("cache-control", "no-store")
      .header("pragma", "no-cache")
      .send({
        access_token: token,
        token_type: "Bearer",
        expires_in: ttl,
        scope: issuedScopes.join(" "),
      });
  });

  /** RFC 7009 revocation, authenticated as the client that owns the token. */
  app.post("/oauth/revoke", tokenLimited, async (req, reply) => {
    const creds = readCredentials(req);
    if (!creds) {
      return oauthError(reply, 401, "invalid_client", "Client authentication required", true);
    }
    const [client] = await app.db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, creds.clientId))
      .limit(1);
    if (!client || sha256Hex(creds.clientSecret) !== client.clientSecretHash) {
      return oauthError(
        reply,
        401,
        "invalid_client",
        "Client authentication failed",
        creds.via === "basic",
      );
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const token = typeof body["token"] === "string" ? body["token"].trim() : "";
    if (token === "") {
      return oauthError(reply, 400, "invalid_request", "token parameter is required");
    }
    const [row] = await app.db
      .select()
      .from(oauthAccessTokens)
      .where(
        and(
          eq(oauthAccessTokens.tokenHash, sha256Hex(token)),
          eq(oauthAccessTokens.clientId, client.id),
        ),
      )
      .limit(1);
    // RFC 7009: an unknown or already-invalid token is still a 200.
    if (row && !row.revokedAt) {
      const now = new Date().toISOString();
      await app.db
        .update(oauthAccessTokens)
        .set({ revokedAt: now })
        .where(eq(oauthAccessTokens.id, row.id));
      await appendLedger(app.db, {
        companyId: client.companyId,
        actorId: null,
        action: "state_change",
        objectType: "oauth_access_token",
        objectId: row.id,
        payload: { revoked: true, via: "rfc7009", clientId: client.clientId },
      });
    }
    return reply.status(200).header("cache-control", "no-store").send({ revoked: true });
  });

  /* ================================================================ */
  /* ERP CONNECTOR FRAMEWORK (#130-133, #582)                          */
  /* ================================================================ */

  /**
   * The canonical vocabulary an ERP profile maps FROM. Published so an
   * integrator can build a profile without reading the source, and so the web
   * profile builder has something real to offer instead of a free-text box.
   */
  app.get("/integrations/erp/catalogue", { preHandler: memberGate }, async () => ({
    feeds: ERP_FEEDS.map((feed) => ({
      feed,
      fields: FEED_FIELDS[feed],
    })),
    formats: ERP_EXPORT_FORMATS,
    starters: STARTER_PROFILES.map((p) => ({
      key: p.key,
      system: p.system,
      feed: p.feed,
      name: p.name,
      notes: p.notes,
      fieldMap: p.fieldMap,
    })),
    note:
      "ConstructOS speaks ONE canonical shape per feed; a profile renames and reorders it into " +
      "the columns a given ERP imports. A profile may hold a field back and may supply a " +
      "constant; it can never invent a figure. The starters follow each product's published " +
      "import template and are a starting point, not a certification — confirm the vendor and " +
      "cost-code columns against the customer's own chart of accounts before the first import. " +
      "Nothing here posts to an ERP: the output is a file, because a write-back integration " +
      "needs credentials, idempotency and a partial-failure story the read path has to earn first.",
  }));

  async function fetchProfile(profileId: string, companyId: string) {
    const [row] = await app.db
      .select()
      .from(integrationExportProfiles)
      .where(
        and(
          eq(integrationExportProfiles.id, profileId),
          eq(integrationExportProfiles.companyId, companyId),
        ),
      )
      .limit(1);
    if (!row) throw notFound("Export profile not found");
    return row;
  }

  app.post("/integrations/erp/profiles", { preHandler: adminGate }, async (req, reply) => {
    const body = profileCreateSchema.parse(req.body);
    let fieldMap: FieldMapEntry[];
    if (body.starter) {
      const starter = STARTER_PROFILES.find((p) => p.key === body.starter);
      if (!starter) {
        throw badRequest(`Unknown starter "${body.starter}"`, {
          allowed: STARTER_PROFILES.map((p) => p.key),
        });
      }
      if (starter.feed !== body.feed) {
        throw badRequest(
          `Starter "${starter.key}" is for the ${starter.feed} feed, not ${body.feed}`,
        );
      }
      fieldMap = starter.fieldMap;
    } else {
      fieldMap = (body.fieldMap ?? identityFieldMap(body.feed)) as FieldMapEntry[];
    }
    const problems = validateFieldMap(body.feed, fieldMap);
    if (problems.length > 0) {
      throw badRequest("Field map is not valid for this feed", { problems });
    }
    const id = newId("iep");
    await app.db.insert(integrationExportProfiles).values({
      id,
      companyId: req.companyId!,
      name: body.name,
      system: body.system,
      feed: body.feed,
      fieldMap,
      format: body.format ?? "csv",
      notes: body.notes ?? null,
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "integration_export_profile",
      objectId: id,
      payload: { name: body.name, system: body.system, feed: body.feed, columns: fieldMap.length },
      storePayload: true,
    });
    return reply.status(201).send(await fetchProfile(id, req.companyId!));
  });

  app.get("/integrations/erp/profiles", { preHandler: memberGate }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    const where = eq(integrationExportProfiles.companyId, req.companyId!);
    const [totalRow] = await app.db
      .select({ n: count() })
      .from(integrationExportProfiles)
      .where(where);
    const items = await app.db
      .select()
      .from(integrationExportProfiles)
      .where(where)
      .orderBy(desc(integrationExportProfiles.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(
      items.map((r) => ({ ...r, isActive: r.isActive === 1 })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.patch("/integrations/erp/profiles/:profileId", { preHandler: adminGate }, async (req) => {
    const { profileId } = req.params as { profileId: string };
    const body = profilePatchSchema.parse(req.body);
    const existing = await fetchProfile(profileId, req.companyId!);
    const fieldMap = (body.fieldMap ?? existing.fieldMap) as FieldMapEntry[];
    const problems = validateFieldMap(existing.feed, fieldMap);
    if (problems.length > 0) {
      throw badRequest("Field map is not valid for this feed", { problems });
    }
    await app.db
      .update(integrationExportProfiles)
      .set({
        name: body.name ?? existing.name,
        fieldMap,
        format: body.format ?? existing.format,
        notes: body.notes === undefined ? existing.notes : body.notes,
        isActive: body.active === undefined ? existing.isActive : body.active ? 1 : 0,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(integrationExportProfiles.id, profileId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "integration_export_profile",
      objectId: profileId,
      payload: { changed: Object.keys(body) },
    });
    const after = await fetchProfile(profileId, req.companyId!);
    return { ...after, isActive: after.isActive === 1 };
  });

  app.delete(
    "/integrations/erp/profiles/:profileId",
    { preHandler: adminGate },
    async (req, reply) => {
      const { profileId } = req.params as { profileId: string };
      const existing = await fetchProfile(profileId, req.companyId!);
      await app.db
        .delete(integrationExportProfiles)
        .where(eq(integrationExportProfiles.id, profileId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "integration_export_profile",
        objectId: profileId,
        payload: { name: existing.name, system: existing.system, feed: existing.feed },
      });
      return reply.status(204).send();
    },
  );

  /**
   * Build the canonical rows for a feed on one project.
   *
   * Every figure comes from the invoice record itself; nothing is recomputed
   * and nothing is converted. Amounts carry the invoice's own currency and the
   * export header declares which currencies are present, because an ERP import
   * that silently mixes them is worse than one that refuses.
   */
  async function canonicalRows(
    companyId: string,
    projectId: string,
    feed: ErpFeed,
    filters: { periodFrom?: string; periodTo?: string; status?: string; limit: number },
  ): Promise<CanonicalRow[]> {
    const clauses = [
      eq(invoices.companyId, companyId),
      eq(invoices.projectId, projectId),
      filters.status ? eq(invoices.status, filters.status) : undefined,
      filters.periodFrom ? gte(invoices.periodEnd, filters.periodFrom) : undefined,
      filters.periodTo ? lte(invoices.periodEnd, filters.periodTo) : undefined,
      feed === "payments" ? gt(invoices.amountPaid, 0) : undefined,
    ].filter((c) => c !== undefined);

    const invoiceRows = await app.db
      .select()
      .from(invoices)
      .where(and(...clauses))
      .orderBy(desc(invoices.billingDate), asc(invoices.number))
      .limit(filters.limit);
    if (invoiceRows.length === 0) return [];

    const vendorIds = [
      ...new Set(invoiceRows.map((i) => i.vendorId).filter((v): v is string => Boolean(v))),
    ];
    const vendorRows = vendorIds.length
      ? await app.db
          .select({
            id: vendors.id,
            name: vendors.name,
            // The vendor's ERP code: registrationNumber is the identifier a
            // finance system keys on more often than the tax id, and both are
            // offered so a profile can pick either.
            reference: vendors.registrationNumber,
            taxId: vendors.taxId,
          })
          .from(vendors)
          .where(and(eq(vendors.companyId, companyId), inArray(vendors.id, vendorIds)))
      : [];
    const vendorById = new Map(vendorRows.map((v) => [v.id, v]));
    const [projectRow] = await app.db
      .select({ name: projects.name })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .limit(1);
    const projectName = projectRow?.name ?? projectId;

    if (feed === "job_cost") {
      const invoiceById = new Map(invoiceRows.map((i) => [i.id, i]));
      const lineRows = await app.db
        .select()
        .from(invoiceLineItems)
        .where(
          and(
            eq(invoiceLineItems.companyId, companyId),
            inArray(
              invoiceLineItems.invoiceId,
              invoiceRows.map((i) => i.id),
            ),
          ),
        )
        .orderBy(asc(invoiceLineItems.invoiceId), asc(invoiceLineItems.sortOrder));
      return lineRows.map((line) => {
        const inv = invoiceById.get(line.invoiceId);
        return {
          lineId: line.id,
          invoiceId: line.invoiceId,
          reference: inv?.reference ?? null,
          projectId,
          costCode: line.costCode ?? null,
          costType: line.costType ?? null,
          description: line.description,
          currency: inv?.currency ?? null,
          periodEnd: inv?.periodEnd ?? null,
          quantity: line.quantity ?? null,
          unitRate: line.unitRate ?? null,
          thisPeriodWork: line.thisPeriodWork,
          thisPeriodStoredMaterials: line.thisPeriodStoredMaterials,
          retainageThisPeriod: line.retainageThisPeriod,
          taxAmount: line.taxAmount,
          amount: line.amount,
        } satisfies CanonicalRow;
      });
    }

    return invoiceRows.map((inv) => {
      const vendor = inv.vendorId ? vendorById.get(inv.vendorId) : undefined;
      const base = {
        invoiceId: inv.id,
        reference: inv.reference,
        vendorInvoiceNumber: inv.invoiceNumber ?? null,
        vendorId: inv.vendorId ?? null,
        vendorName: vendor?.name ?? null,
        vendorReference: vendor?.reference ?? vendor?.taxId ?? null,
        projectId,
        projectName,
        status: inv.status,
        currency: inv.currency,
        billingDate: inv.billingDate ?? null,
        periodStart: inv.periodStart ?? null,
        periodEnd: inv.periodEnd ?? null,
        dueDate: inv.dueDate ?? null,
        subtotal: inv.subtotal,
        taxAmount: inv.taxAmount,
        retainage: inv.totalRetainage,
        retainageReleased: inv.retainageReleased,
        total: inv.total,
        amountPaid: inv.amountPaid,
        currentPaymentDue: inv.currentPaymentDue,
        approvedAt: inv.approvedAt ?? null,
        paidDate: inv.paidDate ?? null,
      } satisfies CanonicalRow;
      return base;
    });
  }

  /**
   * The AP/AR extract (#582). Gated on `invoicing` at read, not on
   * `integrations`: this is a read of the invoice register through a different
   * door, and a door is never allowed to be wider than the room it opens onto.
   */
  app.get(
    "/projects/:projectId/integrations/erp/export",
    {
      preHandler: [app.authenticate, app.requireCompany, app.requireTool("invoicing", "read")],
    },
    async (req, reply) => {
      const q = erpExportQuery.parse(req.query);
      const profile = q.profileId ? await fetchProfile(q.profileId, req.companyId!) : null;
      const feed = (profile?.feed ?? q.feed ?? "ap_invoices") as ErpFeed;
      if (profile && q.feed && profile.feed !== q.feed) {
        throw badRequest(
          `Profile "${profile.name}" renders the ${profile.feed} feed, not ${q.feed}`,
        );
      }
      const format = (q.format ?? profile?.format ?? "csv") as "csv" | "json";
      const limit = q.limit ?? 1_000;
      const rows = await canonicalRows(req.companyId!, req.projectId!, feed, {
        ...(q.periodFrom ? { periodFrom: q.periodFrom } : {}),
        ...(q.periodTo ? { periodTo: q.periodTo } : {}),
        ...(q.status ? { status: q.status } : {}),
        limit,
      });
      const entries = (profile?.fieldMap as FieldMapEntry[] | undefined) ?? identityFieldMap(feed);
      const mapped = applyFieldMap(rows, entries);
      const currencies = currenciesIn(rows);
      const sandbox = await isSandbox(req.companyId!);

      // An export leaving the platform is a ledgered access event, and the
      // entry records what left: which feed, which profile, how many rows,
      // which currencies and whether the extract was truncated.
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "access",
        objectType: "integration_export_profile",
        objectId: profile?.id ?? `builtin:${feed}`,
        projectId: req.projectId!,
        payload: {
          feed,
          format,
          profileId: profile?.id ?? null,
          system: profile?.system ?? "canonical",
          rowCount: rows.length,
          truncated: rows.length >= limit,
          currencies,
          periodFrom: q.periodFrom ?? null,
          periodTo: q.periodTo ?? null,
        },
        storePayload: true,
      });

      const header = {
        feed,
        format,
        generatedAt: new Date().toISOString(),
        profile: profile
          ? { id: profile.id, name: profile.name, system: profile.system, notes: profile.notes }
          : { id: null, name: "Canonical (unmapped)", system: "constructos", notes: null },
        projectId: req.projectId!,
        rowCount: rows.length,
        truncated: rows.length >= limit,
        currencies,
        sandbox,
        caveats: [
          ...(currencies.length > 1
            ? [
                `This extract contains ${currencies.length} currencies (${currencies.join(", ")}). ` +
                  "Nothing has been converted or summed across them — split the file before " +
                  "importing into a ledger that holds one currency per batch.",
              ]
            : []),
          ...(rows.length >= limit
            ? [`Truncated at ${limit} rows — narrow the period or raise limit to export the rest.`]
            : []),
          ...(sandbox ? ["SANDBOX TENANT — these figures are not a record of real trade."] : []),
        ],
      };

      if (format === "json") {
        return { ...header, columns: mapped.columns, rows: mapped.rows };
      }
      // The CSV carries the caveats as comment lines: a file that leaves the
      // platform must state what it is even when nobody reads the response body.
      const comments = [
        `# ConstructOS ${feed} export — ${header.generatedAt}`,
        `# profile: ${header.profile.name} (${header.profile.system})`,
        `# currencies: ${currencies.length ? currencies.join(" ") : "(none)"}`,
        ...header.caveats.map((c) => `# ${c.replace(/\n/g, " ")}`),
      ].join("\n");
      const safeName = `${feed}-${req.projectId!}`.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
      return reply
        .type("text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="${safeName}.csv"`)
        .header("x-export-rows", String(rows.length))
        .header("x-export-truncated", String(header.truncated))
        .send(`${comments}\n${toCsv(mapped.columns, mapped.rows)}`);
    },
  );

  /* ================================================================ */
  /* DEVELOPER SANDBOX TENANTS (#123)                                  */
  /* ================================================================ */

  /** Is this tenant marked as a developer sandbox? */
  async function isSandbox(companyId: string): Promise<boolean> {
    const ids = await refreshSandboxCache();
    return ids.has(companyId);
  }

  app.get("/integrations/sandbox", { preHandler: memberGate }, async (req) => {
    const [row] = await app.db
      .select()
      .from(developerSandboxes)
      .where(eq(developerSandboxes.companyId, req.companyId!))
      .limit(1);
    return {
      sandbox: Boolean(row),
      record: row ?? null,
      effects: [
        "Exports carry a SANDBOX caveat in their header.",
        "Webhook envelopes carry sandbox:true, so a receiver can refuse to act on them.",
        "The tenant may not contribute samples to the cross-tenant benchmark pool.",
      ],
      note:
        "A sandbox is a place to exercise the API without the consequence landing somewhere " +
        "real. It is a LABEL, not a separate database: the same tables, the same gates, the same " +
        "ledger. Marking a tenant that holds real projects as a sandbox would make its exports " +
        "say something false about real trade, which is why the flag is ledgered both ways.",
    };
  });

  app.post("/integrations/sandbox", { preHandler: adminGate }, async (req, reply) => {
    const body = sandboxSchema.parse(req.body ?? {});
    const existing = await isSandbox(req.companyId!);
    if (existing) throw conflict("This tenant is already marked as a developer sandbox");
    await app.db.insert(developerSandboxes).values({
      companyId: req.companyId!,
      purpose: body.purpose ?? null,
      enabledBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "developer_sandbox",
      objectId: req.companyId!,
      payload: { sandbox: true, purpose: body.purpose ?? null },
      storePayload: true,
    });
    await refreshSandboxCache(true);
    return reply.status(201).send({ sandbox: true, purpose: body.purpose ?? null });
  });

  app.delete("/integrations/sandbox", { preHandler: adminGate }, async (req) => {
    if (!(await isSandbox(req.companyId!))) {
      throw notFound("This tenant is not marked as a developer sandbox");
    }
    await app.db
      .delete(developerSandboxes)
      .where(eq(developerSandboxes.companyId, req.companyId!));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "developer_sandbox",
      objectId: req.companyId!,
      payload: { sandbox: false },
      storePayload: true,
    });
    await refreshSandboxCache(true);
    return { sandbox: false };
  });

  /* ================================================================ */
  /* OPENAPI (#122)                                                    */
  /* ================================================================ */

  /**
   * The machine-readable description of this API, generated from the live
   * route table. Authenticated (it enumerates the platform's whole surface)
   * but not company-scoped: it describes the API, not a tenant's data.
   */
  app.get("/openapi.json", { preHandler: [app.authenticate] }, async (req, reply) => {
    const routes = parseRouteTree(app.printRoutes({ commonPrefix: false }));
    const doc = buildOpenApiDocument({
      title: "ConstructOS API",
      version: "1",
      prefix: "/api/v1",
      serverUrl: `${req.protocol}://${req.hostname}`,
      description:
        "ConstructOS — construction delivery and owner-side assurance. Every consequential " +
        "state change appends to a hash-chained ledger, and the webhook feed is a subscription " +
        "to that ledger rather than to a hand-maintained event taxonomy.",
      routes,
    });
    return reply.header("cache-control", "public, max-age=60").send(doc);
  });
};

export { WebhookDispatcher, getDispatcher } from "./dispatcher.js";
