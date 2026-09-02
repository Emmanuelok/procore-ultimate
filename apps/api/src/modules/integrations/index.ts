import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { and, count, desc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import {
  oauthAccessTokens,
  oauthClients,
  projects,
  webhookDeliveries,
  webhookEndpoints,
} from "@constructos/db";
import { sha256Hex } from "@constructos/ledger";
import { OAUTH_GRANT_TYPES, WEBHOOK_DELIVERY_STATUSES } from "@constructos/shared";
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
  dispatcher.start();
  app.addHook("onClose", async () => {
    dispatcher.stop();
    setLedgerEmitHook(app.db, null);
  });

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
    // works and this is where they find out.
    secretFingerprintMatches:
      secretFingerprint(deriveEndpointSecret(signingKey, row.id)) === row.secretFingerprint,
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
        "delete the endpoint and create another.",
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
        // Re-enabling is an explicit statement that the receiver is fixed, so
        // it clears the consecutive-failure run and the disabled reason with it.
        ...(reactivating ? { failureCount: 0, disabledReason: null } : {}),
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
      emitter: dispatcher.getHealth(),
      signing: signingContract(),
      delivery: {
        maxAttempts: opts.maxAttempts,
        backoffBaseMs: opts.backoffBaseMs,
        backoffMaxMs: opts.backoffMaxMs,
        failureThreshold: opts.failureThreshold,
        responseBodyLimit: opts.responseBodyLimit,
        requestTimeoutMs: opts.requestTimeoutMs,
        dispatchIntervalMs: opts.intervalMs,
        mode:
          opts.intervalMs > 0
            ? "in-process interval timer (no external scheduler)"
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
      },
    };
  });

  /** The subscribable vocabulary, derived from this tenant's own ledger. */
  app.get("/integrations/events", { preHandler: memberGate }, async (req) => {
    return eventCatalogue(app.db, req.companyId!);
  });

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
};

export { WebhookDispatcher, getDispatcher } from "./dispatcher.js";
