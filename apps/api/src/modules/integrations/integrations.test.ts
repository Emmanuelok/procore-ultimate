import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import {
  assuranceGrants,
  companyMemberships,
  oauthAccessTokens,
  oauthClients,
  webhookEndpoints,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { createRecordingWebhookClient, getDispatcher } from "./dispatcher.js";
import { deriveEndpointSecret, resolveSigningKey, secretFingerprint, verifySignature } from "./signing.js";

/**
 * Vol I §0.7 route tests: webhook endpoint custody and delivery surfaces
 * (#121), and OAuth2 machine callers going through — never around — the same
 * permission gates a person passes (#120).
 */

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let outsider: TestActor;
let memberHeaders: Record<string, string>;
let projectId: string;

const url = (p: string) => `/api/v1${p}`;
const dispatcher = () => getDispatcher(app.db)!;

async function createEndpoint(actor: TestActor, payload: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: url("/integrations/webhooks"),
    headers: actor.headers,
    payload: {
      name: "Receiver",
      url: "https://receiver.example/hook",
      eventKinds: ["nothing_real.create"],
      ...payload,
    },
  });
  return res;
}

async function createClient(actor: TestActor, scopes: string[], extra: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: url("/integrations/oauth/clients"),
    headers: actor.headers,
    payload: { name: "Machine", scopes, ...extra },
  });
}

async function issueToken(clientId: string, clientSecret: string, scope?: string) {
  const res = await app.inject({
    method: "POST",
    url: url("/oauth/token"),
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    payload: { grant_type: "client_credentials", ...(scope ? { scope } : {}) },
  });
  return res;
}

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  outsider = await registerActor(app);
  const member = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: member.userId,
    role: "member",
  });
  memberHeaders = {
    authorization: member.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };
  const project = await app.inject({
    method: "POST",
    url: url("/projects"),
    headers: owner.headers,
    payload: { name: "Integration test project" },
  });
  projectId = (project.json() as { id: string }).id;
  // deliveries in this file are never allowed near a socket
  dispatcher().configure({ autoKick: false, now: () => new Date() });
  dispatcher().setHttpClient(createRecordingWebhookClient(() => ({ status: 200, body: "ok" })));
});

afterAll(async () => {
  await built.close();
});

/* ================================================================== */
/* Webhook endpoints — secret custody                                  */
/* ================================================================== */

describe("webhook endpoint custody", () => {
  it("shows the signing secret exactly once and never stores a usable one", async () => {
    const res = await createEndpoint(owner, { name: "Once" });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      endpoint: { id: string; secretFingerprint: string };
      secret: string;
      secretWarning: string;
      signing: { stringToSign: string; keySource: { source: string; sharedCustody: boolean } };
    };
    expect(body.secret.startsWith("whsec_")).toBe(true);
    expect(body.secretWarning).toContain("exactly once");
    expect(body.signing.stringToSign).toBe("v1:{timestamp}:{deliveryId}:{rawBody}");

    // the stored row holds a fingerprint, not the secret
    const [row] = await app.db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, body.endpoint.id));
    expect(JSON.stringify(row)).not.toContain(body.secret);
    expect(row!.secretFingerprint).toBe(secretFingerprint(body.secret));

    // and no read route hands it back
    const get = await app.inject({
      method: "GET",
      url: url(`/integrations/webhooks/${body.endpoint.id}`),
      headers: owner.headers,
    });
    expect(get.statusCode).toBe(200);
    expect(get.body).not.toContain(body.secret);
    expect(get.body).not.toContain("whsec_");
    const list = await app.inject({
      method: "GET",
      url: url("/integrations/webhooks"),
      headers: owner.headers,
    });
    expect(list.body).not.toContain(body.secret);
  });

  it("stores a fingerprint that matches the HKDF-re-derived secret", async () => {
    const res = await createEndpoint(owner, { name: "Derived" });
    const body = res.json() as { endpoint: { id: string; secretFingerprint: string }; secret: string };
    const key = resolveSigningKey(app.appConfig.AUTH_SECRET, process.env);
    // re-derivation from the master key + endpoint id reproduces the secret
    expect(deriveEndpointSecret(key, body.endpoint.id)).toBe(body.secret);
    expect(body.endpoint.secretFingerprint).toBe(secretFingerprint(body.secret));

    const get = await app.inject({
      method: "GET",
      url: url(`/integrations/webhooks/${body.endpoint.id}`),
      headers: owner.headers,
    });
    const shown = get.json() as { endpoint: { secretFingerprintMatches: boolean } };
    expect(shown.endpoint.secretFingerprintMatches).toBe(true);
  });

  it("reports the AUTH_SECRET fallback honestly instead of hiding it", async () => {
    const res = await createEndpoint(owner, { name: "Custody" });
    const body = res.json() as {
      signing: { keySource: { source: string; sharedCustody: boolean; note: string } };
    };
    // the test app sets no WEBHOOK_SIGNING_KEY, so the fallback is in force
    expect(body.signing.keySource.source).toBe("AUTH_SECRET_FALLBACK");
    expect(body.signing.keySource.sharedCustody).toBe(true);
    expect(body.signing.keySource.note).toContain("shares custody");
  });

  it("warns when a receiver URL is plain http and refuses a non-http scheme", async () => {
    const insecure = await createEndpoint(owner, {
      name: "Insecure",
      url: "http://receiver.example/hook",
    });
    expect(insecure.statusCode).toBe(201);
    expect((insecure.json() as { insecureTransport: string }).insecureTransport).toContain(
      "clear text",
    );
    const bad = await createEndpoint(owner, { name: "Bad", url: "file:///etc/passwd" });
    expect(bad.statusCode).toBe(400);
  });

  it("refuses malformed event kinds", async () => {
    const res = await createEndpoint(owner, { name: "Bad kinds", eventKinds: ["not a kind!"] });
    expect(res.statusCode).toBe(400);
  });
});

/* ================================================================== */
/* Webhook CRUD, gates and tenant isolation                            */
/* ================================================================== */

describe("webhook endpoint routes", () => {
  it("refuses creation by a plain company member", async () => {
    const res = await app.inject({
      method: "POST",
      url: url("/integrations/webhooks"),
      headers: memberHeaders,
      payload: { name: "Nope", url: "https://receiver.example/hook" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("never lets one company see or touch another's endpoint", async () => {
    const mine = (await createEndpoint(owner, { name: "Mine" })).json() as {
      endpoint: { id: string };
    };
    for (const [method, path] of [
      ["GET", ""],
      ["PATCH", ""],
      ["DELETE", ""],
      ["POST", "/test"],
      ["GET", "/deliveries"],
    ] as const) {
      const res = await app.inject({
        method,
        url: url(`/integrations/webhooks/${mine.endpoint.id}${path}`),
        headers: outsider.headers,
        ...(method === "PATCH" ? { payload: { name: "stolen" } } : {}),
      });
      expect([403, 404]).toContain(res.statusCode);
    }
    const list = await app.inject({
      method: "GET",
      url: url("/integrations/webhooks"),
      headers: outsider.headers,
    });
    expect(list.body).not.toContain(mine.endpoint.id);
  });

  it("updates url, subscriptions and active state, clearing a disabled reason on re-enable", async () => {
    const created = (await createEndpoint(owner, { name: "Editable" })).json() as {
      endpoint: { id: string };
    };
    const id = created.endpoint.id;
    await app.db
      .update(webhookEndpoints)
      .set({ isActive: 0, failureCount: 4, disabledReason: "Auto-disabled after 4" })
      .where(eq(webhookEndpoints.id, id));

    const res = await app.inject({
      method: "PATCH",
      url: url(`/integrations/webhooks/${id}`),
      headers: owner.headers,
      payload: {
        url: "https://receiver.example/v2",
        eventKinds: ["rfi.*"],
        active: true,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      url: string;
      eventKinds: string[];
      isActive: boolean;
      failureCount: number;
      disabledReason: string | null;
    };
    expect(body.url).toBe("https://receiver.example/v2");
    expect(body.eventKinds).toEqual(["rfi.*"]);
    expect(body.isActive).toBe(true);
    expect(body.failureCount).toBe(0);
    expect(body.disabledReason).toBeNull();
  });

  it("deletes an endpoint and its delivery log together", async () => {
    const created = (await createEndpoint(owner, { name: "Doomed", eventKinds: [] })).json() as {
      endpoint: { id: string };
    };
    await app.inject({
      method: "POST",
      url: url(`/integrations/webhooks/${created.endpoint.id}/test`),
      headers: owner.headers,
    });
    const res = await app.inject({
      method: "DELETE",
      url: url(`/integrations/webhooks/${created.endpoint.id}`),
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { deleted: boolean; deliveriesDeleted: number };
    expect(body.deleted).toBe(true);
    expect(body.deliveriesDeleted).toBeGreaterThanOrEqual(1);
    const after = await app.inject({
      method: "GET",
      url: url(`/integrations/webhooks/${created.endpoint.id}`),
      headers: owner.headers,
    });
    expect(after.statusCode).toBe(404);
  });
});

/* ================================================================== */
/* Test ping, deliveries and retry                                     */
/* ================================================================== */

describe("test ping, delivery log and retry", () => {
  it("sends a synthetic ping whose signature verifies with the shown secret", async () => {
    const created = (await createEndpoint(owner, { name: "Pingable" })).json() as {
      endpoint: { id: string };
      secret: string;
    };
    const client = createRecordingWebhookClient(() => ({ status: 200, body: "pong" }));
    dispatcher().setHttpClient(client);
    const res = await app.inject({
      method: "POST",
      url: url(`/integrations/webhooks/${created.endpoint.id}/test`),
      headers: owner.headers,
      payload: { note: "checking" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { delivery: { status: string; eventKind: string; id: string } };
    expect(body.delivery.status).toBe("delivered");
    expect(body.delivery.eventKind).toBe("ping");

    const call = client.calls.find((c) => c.headers["x-constructos-delivery"] === body.delivery.id)!;
    expect(call).toBeDefined();
    expect(
      verifySignature(
        created.secret,
        Number(call.headers["x-constructos-timestamp"]),
        body.delivery.id,
        call.body,
        call.headers["x-constructos-signature"]!,
      ),
    ).toBe(true);
  });

  it("refuses a test ping on a disabled endpoint rather than silently queueing", async () => {
    const created = (await createEndpoint(owner, { name: "Sleeping" })).json() as {
      endpoint: { id: string };
    };
    await app.inject({
      method: "PATCH",
      url: url(`/integrations/webhooks/${created.endpoint.id}`),
      headers: owner.headers,
      payload: { active: false },
    });
    const res = await app.inject({
      method: "POST",
      url: url(`/integrations/webhooks/${created.endpoint.id}/test`),
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(409);
  });

  it("lists deliveries with a status filter", async () => {
    const created = (await createEndpoint(owner, { name: "Logged" })).json() as {
      endpoint: { id: string };
    };
    dispatcher().setHttpClient(createRecordingWebhookClient(() => ({ status: 200, body: "ok" })));
    await app.inject({
      method: "POST",
      url: url(`/integrations/webhooks/${created.endpoint.id}/test`),
      headers: owner.headers,
    });
    const all = await app.inject({
      method: "GET",
      url: url(`/integrations/webhooks/${created.endpoint.id}/deliveries`),
      headers: owner.headers,
    });
    expect(all.statusCode).toBe(200);
    expect((all.json() as { total: number }).total).toBe(1);
    const filtered = await app.inject({
      method: "GET",
      url: url(`/integrations/webhooks/${created.endpoint.id}/deliveries?status=exhausted`),
      headers: owner.headers,
    });
    expect((filtered.json() as { total: number }).total).toBe(0);
  });

  it("retries a failed delivery on demand and refuses to duplicate a delivered one", async () => {
    const created = (await createEndpoint(owner, { name: "Retryable" })).json() as {
      endpoint: { id: string };
    };
    dispatcher().setHttpClient(createRecordingWebhookClient(() => ({ status: 500, body: "bad" })));
    const ping = await app.inject({
      method: "POST",
      url: url(`/integrations/webhooks/${created.endpoint.id}/test`),
      headers: owner.headers,
    });
    const deliveryId = (ping.json() as { delivery: { id: string; status: string } }).delivery.id;
    expect((ping.json() as { delivery: { status: string } }).delivery.status).toBe("failed");

    dispatcher().setHttpClient(createRecordingWebhookClient(() => ({ status: 200, body: "ok" })));
    const retry = await app.inject({
      method: "POST",
      url: url(`/integrations/webhooks/deliveries/${deliveryId}/retry`),
      headers: owner.headers,
    });
    expect(retry.statusCode).toBe(200);
    expect((retry.json() as { delivery: { status: string } }).delivery.status).toBe("delivered");

    const again = await app.inject({
      method: "POST",
      url: url(`/integrations/webhooks/deliveries/${deliveryId}/retry`),
      headers: owner.headers,
    });
    expect(again.statusCode).toBe(409);
  });

  it("will not retry another tenant's delivery", async () => {
    const created = (await createEndpoint(owner, { name: "Private" })).json() as {
      endpoint: { id: string };
    };
    dispatcher().setHttpClient(createRecordingWebhookClient(() => ({ status: 500, body: "bad" })));
    const ping = await app.inject({
      method: "POST",
      url: url(`/integrations/webhooks/${created.endpoint.id}/test`),
      headers: owner.headers,
    });
    const deliveryId = (ping.json() as { delivery: { id: string } }).delivery.id;
    const res = await app.inject({
      method: "POST",
      url: url(`/integrations/webhooks/deliveries/${deliveryId}/retry`),
      headers: outsider.headers,
    });
    expect(res.statusCode).toBe(404);
    dispatcher().setHttpClient(createRecordingWebhookClient(() => ({ status: 200, body: "ok" })));
  });

  it("reports dispatcher health and configuration for operators", async () => {
    const res = await app.inject({
      method: "GET",
      url: url("/integrations/webhooks/status"),
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      queue: Record<string, number>;
      emitter: { eventsSeen: number };
      delivery: { maxAttempts: number; mode: string };
    };
    expect(body.emitter.eventsSeen).toBeGreaterThan(0);
    expect(body.delivery.maxAttempts).toBeGreaterThan(0);
    expect(body.delivery.mode).toContain("test mode");
  });
});

/* ================================================================== */
/* Event catalogue                                                     */
/* ================================================================== */

describe("event catalogue", () => {
  it("is derived from the tenant's own ledger, not a hand-kept list", async () => {
    const res = await app.inject({
      method: "GET",
      url: url("/integrations/events"),
      headers: memberHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      events: { eventKind: string; count: number; lastSeenAt: string | null }[];
      objectTypes: string[];
      wildcards: string[];
      derivedFrom: string;
    };
    expect(body.derivedFrom).toBe("ledger_entries");
    const kinds = body.events.map((e) => e.eventKind);
    // these exist only because this test file actually created them
    expect(kinds).toContain("webhook_endpoint.create");
    expect(kinds).toContain("project.create");
    expect(body.objectTypes).toContain("webhook_endpoint");
    expect(body.wildcards).toContain("webhook_endpoint.*");
    expect(body.events.find((e) => e.eventKind === "webhook_endpoint.create")!.count).toBeGreaterThan(
      0,
    );
  });

  it("scopes the catalogue to the caller's tenant", async () => {
    const res = await app.inject({
      method: "GET",
      url: url("/integrations/events"),
      headers: outsider.headers,
    });
    const body = res.json() as { events: { eventKind: string }[] };
    expect(body.events.map((e) => e.eventKind)).not.toContain("webhook_endpoint.create");
  });
});

/* ================================================================== */
/* OAuth2 clients                                                      */
/* ================================================================== */

describe("oauth clients", () => {
  it("returns clientId and secret once, storing only a hash", async () => {
    const res = await createClient(owner, ["rfis:read"]);
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      client: { id: string; clientId: string };
      clientId: string;
      clientSecret: string;
      tokenEndpoint: string;
    };
    expect(body.clientSecret.startsWith("cos_")).toBe(true);
    expect(body.tokenEndpoint).toBe("/api/v1/oauth/token");
    const [row] = await app.db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.id, body.client.id));
    expect(JSON.stringify(row)).not.toContain(body.clientSecret);

    const get = await app.inject({
      method: "GET",
      url: url(`/integrations/oauth/clients/${body.clientId}`),
      headers: owner.headers,
    });
    expect(get.statusCode).toBe(200);
    expect(get.body).not.toContain(body.clientSecret);
    expect(get.body).not.toContain("clientSecretHash");
  });

  it("rejects scopes outside the tool:level vocabulary", async () => {
    const res = await createClient(owner, ["rfis:read", "not_a_tool:read", "rfis:wizard"]);
    expect(res.statusCode).toBe(400);
    const body = res.json() as { message: string; details: { invalid: string[] } };
    expect(body.details.invalid).toEqual(["not_a_tool:read", "rfis:wizard"]);
    expect(body.message).toContain("tool:level");
  });

  it("refuses to grant a client more than its creator holds", async () => {
    // an owner bypasses tool checks but does NOT hold `assurance` — that is
    // granted, never inherited from a company role
    const refused = await createClient(owner, ["assurance:read"]);
    expect(refused.statusCode).toBe(403);
    const body = refused.json() as {
      message: string;
      details: { refused: { scope: string; creatorHolds: string }[] };
    };
    expect(body.message).toContain("more than its creator holds");
    expect(body.details.refused).toEqual([{ scope: "assurance:read", creatorHolds: "none" }]);

    // grant the creator an assurance role and the same request succeeds
    await app.db.insert(assuranceGrants).values({
      id: newId("agr"),
      companyId: owner.companyId,
      projectId: null,
      userId: owner.userId,
      role: "auditor",
      grantedBy: owner.userId,
    });
    const allowed = await createClient(owner, ["assurance:read"], { name: "Auditor bot" });
    expect(allowed.statusCode).toBe(201);
    await app.db.delete(assuranceGrants).where(eq(assuranceGrants.userId, owner.userId));
  });

  it("applies the same ceiling when scopes are edited later", async () => {
    const created = (await createClient(owner, ["rfis:read"])).json() as {
      client: { id: string };
    };
    const res = await app.inject({
      method: "PATCH",
      url: url(`/integrations/oauth/clients/${created.client.id}`),
      headers: owner.headers,
      payload: { scopes: ["rfis:read", "assurance:standard"] },
    });
    expect(res.statusCode).toBe(403);
  });

  it("is closed to plain members and to other tenants", async () => {
    const member = await app.inject({
      method: "POST",
      url: url("/integrations/oauth/clients"),
      headers: memberHeaders,
      payload: { name: "Nope", scopes: ["rfis:read"] },
    });
    expect(member.statusCode).toBe(403);

    const mine = (await createClient(owner, ["rfis:read"])).json() as { client: { id: string } };
    const theirs = await app.inject({
      method: "GET",
      url: url(`/integrations/oauth/clients/${mine.client.id}`),
      headers: outsider.headers,
    });
    expect(theirs.statusCode).toBe(404);
  });

  it("publishes the scope catalogue a UI needs", async () => {
    const res = await app.inject({
      method: "GET",
      url: url("/integrations/oauth/scopes"),
      headers: memberHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tools: string[]; levels: string[]; format: string };
    expect(body.format).toBe("tool:level");
    expect(body.tools).toContain("rfis");
    expect(body.levels).not.toContain("none");
  });
});

/* ================================================================== */
/* The token endpoint                                                  */
/* ================================================================== */

describe("POST /oauth/token", () => {
  it("issues a token for HTTP Basic credentials", async () => {
    const created = (await createClient(owner, ["rfis:read", "documents:read"])).json() as {
      clientId: string;
      clientSecret: string;
    };
    const res = await issueToken(created.clientId, created.clientSecret);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      access_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
    };
    expect(body.token_type).toBe("Bearer");
    expect(body.access_token.startsWith("cot_")).toBe(true);
    expect(body.expires_in).toBe(3600);
    expect(body.scope.split(" ").sort()).toEqual(["documents:read", "rfis:read"]);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("accepts credentials in a JSON body and in a form body", async () => {
    const created = (await createClient(owner, ["rfis:read"])).json() as {
      clientId: string;
      clientSecret: string;
    };
    const json = await app.inject({
      method: "POST",
      url: url("/oauth/token"),
      payload: {
        grant_type: "client_credentials",
        client_id: created.clientId,
        client_secret: created.clientSecret,
      },
    });
    expect(json.statusCode).toBe(200);

    const form = await app.inject({
      method: "POST",
      url: url("/oauth/token"),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: created.clientId,
        client_secret: created.clientSecret,
      }).toString(),
    });
    expect(form.statusCode).toBe(200);
    expect((form.json() as { token_type: string }).token_type).toBe("Bearer");
  });

  it("returns RFC 6749 error bodies for a bad secret, a bad grant and an over-wide scope", async () => {
    const created = (await createClient(owner, ["rfis:read"])).json() as {
      clientId: string;
      clientSecret: string;
    };

    const badSecret = await issueToken(created.clientId, "cos_wrong");
    expect(badSecret.statusCode).toBe(401);
    expect((badSecret.json() as { error: string }).error).toBe("invalid_client");
    expect(badSecret.headers["www-authenticate"]).toContain("Basic");

    const unknownClient = await issueToken("cli_nope", "cos_nope");
    expect(unknownClient.statusCode).toBe(401);
    // an unknown client is indistinguishable from a wrong secret
    expect((unknownClient.json() as { error: string }).error).toBe("invalid_client");

    const badGrant = await app.inject({
      method: "POST",
      url: url("/oauth/token"),
      payload: {
        grant_type: "password",
        client_id: created.clientId,
        client_secret: created.clientSecret,
      },
    });
    expect(badGrant.statusCode).toBe(400);
    expect((badGrant.json() as { error: string }).error).toBe("unsupported_grant_type");

    const wideScope = await issueToken(created.clientId, created.clientSecret, "rfis:admin");
    expect(wideScope.statusCode).toBe(400);
    const scopeBody = wideScope.json() as { error: string; error_description: string };
    expect(scopeBody.error).toBe("invalid_scope");
    expect(scopeBody.error_description).toContain("rfis:admin");
  });

  it("narrows the issued token to the requested subset", async () => {
    const created = (await createClient(owner, ["rfis:read", "documents:read"])).json() as {
      clientId: string;
      clientSecret: string;
    };
    const res = await issueToken(created.clientId, created.clientSecret, "rfis:read");
    expect((res.json() as { scope: string }).scope).toBe("rfis:read");
  });
});

/* ================================================================== */
/* Machine callers through the real permission gates                   */
/* ================================================================== */

describe("machine callers", () => {
  async function machine(scopes: string[]) {
    const created = (await createClient(owner, scopes)).json() as {
      client: { id: string };
      clientId: string;
      clientSecret: string;
    };
    const token = (await issueToken(created.clientId, created.clientSecret)).json() as {
      access_token: string;
    };
    return {
      rowId: created.client.id,
      clientId: created.clientId,
      clientSecret: created.clientSecret,
      token: token.access_token,
      headers: { authorization: `Bearer ${token.access_token}` },
    };
  }

  it("authenticates on a normal tool route with a sufficient scope", async () => {
    const m = await machine(["rfis:read"]);
    const res = await app.inject({
      method: "GET",
      url: url(`/projects/${projectId}/rfis`),
      headers: m.headers,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { items: unknown[] }).items).toEqual([]);
  });

  it("is refused a level its scopes do not reach — no owner/admin bypass for machines", async () => {
    const m = await machine(["rfis:read"]);
    const res = await app.inject({
      method: "POST",
      url: url(`/projects/${projectId}/rfis`),
      headers: m.headers,
      payload: { subject: "Machine RFI", question: "May I?" },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { message: string }).message).toContain("rfis:standard");
  });

  it("is refused a tool absent from its scopes entirely", async () => {
    const m = await machine(["documents:read"]);
    const res = await app.inject({
      method: "GET",
      url: url(`/projects/${projectId}/rfis`),
      headers: m.headers,
    });
    expect(res.statusCode).toBe(403);
  });

  it("cannot reach another company's project even with the right scope", async () => {
    const m = await machine(["rfis:read"]);
    const foreign = await app.inject({
      method: "POST",
      url: url("/projects"),
      headers: outsider.headers,
      payload: { name: "Foreign" },
    });
    const foreignId = (foreign.json() as { id: string }).id;
    const res = await app.inject({
      method: "GET",
      url: url(`/projects/${foreignId}/rfis`),
      headers: m.headers,
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses a mistargeted x-company-id rather than quietly reading the wrong tenant", async () => {
    const m = await machine(["rfis:read"]);
    const res = await app.inject({
      method: "GET",
      url: url(`/projects/${projectId}/rfis`),
      headers: { ...m.headers, "x-company-id": outsider.companyId },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { message: string }).message).toContain("not issued for the requested company");
  });

  it("can never mint or revoke credentials, even with the widest scopes", async () => {
    // Two independent defences stop this: credential routes carry no tool
    // gate (so a machine is refused before anything else), and they also
    // require a company role, which a machine does not have.
    const m = await machine(["integrations:admin", "admin:admin", "rfis:read"]);
    const create = await app.inject({
      method: "POST",
      url: url("/integrations/oauth/clients"),
      headers: { ...m.headers, "x-company-id": owner.companyId },
      payload: { name: "Child", scopes: ["rfis:read"] },
    });
    expect(create.statusCode).toBe(403);
    const hooks = await app.inject({
      method: "POST",
      url: url("/integrations/webhooks"),
      headers: { ...m.headers, "x-company-id": owner.companyId },
      payload: { name: "Machine hook", url: "https://receiver.example/hook" },
    });
    expect(hooks.statusCode).toBe(403);
    const revoke = await app.inject({
      method: "POST",
      url: url(`/integrations/oauth/clients/${m.rowId}/revoke`),
      headers: { ...m.headers, "x-company-id": owner.companyId },
    });
    expect(revoke.statusCode).toBe(403);
    // the credential still works for what it WAS granted
    const allowed = await app.inject({
      method: "GET",
      url: url(`/projects/${projectId}/rfis`),
      headers: m.headers,
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("is refused on routes that carry no tool gate at all", async () => {
    const m = await machine(["rfis:read", "projects:admin", "ingestion:admin"]);
    // `GET /projects` and `GET /ingestion/datasets` are gated by company
    // membership alone. A machine is not a member, and there is no tool there
    // to check its scopes against, so it is refused however wide its scopes.
    for (const path of ["/projects", "/ingestion/datasets"]) {
      const res = await app.inject({
        method: "GET",
        url: url(path),
        headers: { ...m.headers, "x-company-id": owner.companyId },
      });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { message: string }).message).toContain("not tool-scoped");
    }
    // a human member reaches the same routes normally
    const human = await app.inject({ method: "GET", url: url("/projects"), headers: memberHeaders });
    expect(human.statusCode).toBe(200);
  });

  it("is refused on routes gated by authenticate ALONE — it cannot create a company", async () => {
    // Regression: the tool-gate check lived in the machine branch of
    // `requireCompany`, so a route gated `[authenticate]` on its own never
    // reached it. `POST /companies` is exactly that shape: a client with one
    // narrow read scope could create tenants and be written into
    // `company_memberships` as their OWNER — a company-level write performed
    // with no scope at all. The check now runs in `authenticate` itself.
    const m = await machine(["rfis:read"]);
    const created = await app.inject({
      method: "POST",
      url: url("/companies"),
      headers: m.headers,
      payload: { name: "Machine Made Tenant" },
    });
    expect(created.statusCode).toBe(403);
    expect((created.json() as { message: string }).message).toContain("not tool-scoped");

    for (const path of ["/me", "/companies", "/contract-forms"]) {
      const res = await app.inject({ method: "GET", url: url(path), headers: m.headers });
      expect(res.statusCode).toBe(403);
    }
    // and the route it IS scoped for still answers
    const allowed = await app.inject({
      method: "GET",
      url: url(`/projects/${projectId}/rfis`),
      headers: m.headers,
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("stamps lastUsedAt on both the token and the client", async () => {
    const m = await machine(["rfis:read"]);
    await app.inject({
      method: "GET",
      url: url(`/projects/${projectId}/rfis`),
      headers: m.headers,
    });
    const [client] = await app.db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.id, m.rowId));
    const [token] = await app.db
      .select()
      .from(oauthAccessTokens)
      .where(eq(oauthAccessTokens.clientId, m.rowId));
    expect(client!.lastUsedAt).toBeTruthy();
    expect(token!.lastUsedAt).toBeTruthy();
  });

  it("is refused once the token has expired", async () => {
    const m = await machine(["rfis:read"]);
    await app.db
      .update(oauthAccessTokens)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(oauthAccessTokens.clientId, m.rowId));
    const res = await app.inject({
      method: "GET",
      url: url(`/projects/${projectId}/rfis`),
      headers: m.headers,
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { message: string }).message).toContain("expired");
  });

  it("is refused the instant its client is revoked, along with its live tokens", async () => {
    const m = await machine(["rfis:read"]);
    const before = await app.inject({
      method: "GET",
      url: url(`/projects/${projectId}/rfis`),
      headers: m.headers,
    });
    expect(before.statusCode).toBe(200);

    const revoke = await app.inject({
      method: "POST",
      url: url(`/integrations/oauth/clients/${m.rowId}/revoke`),
      headers: owner.headers,
    });
    expect(revoke.statusCode).toBe(200);
    expect((revoke.json() as { tokensRevoked: number }).tokensRevoked).toBeGreaterThanOrEqual(1);

    const after = await app.inject({
      method: "GET",
      url: url(`/projects/${projectId}/rfis`),
      headers: m.headers,
    });
    expect(after.statusCode).toBe(401);
    // and no new token can be minted from the revoked client
    const reissue = await issueToken(m.clientId, m.clientSecret);
    expect(reissue.statusCode).toBe(401);
  });

  it("is refused after a single token is revoked by id", async () => {
    const m = await machine(["rfis:read"]);
    const [token] = await app.db
      .select()
      .from(oauthAccessTokens)
      .where(eq(oauthAccessTokens.clientId, m.rowId));
    const res = await app.inject({
      method: "POST",
      url: url(`/integrations/oauth/tokens/${token!.id}/revoke`),
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const after = await app.inject({
      method: "GET",
      url: url(`/projects/${projectId}/rfis`),
      headers: m.headers,
    });
    expect(after.statusCode).toBe(401);
    expect((after.json() as { message: string }).message).toContain("revoked");
  });

  it("supports RFC 7009 self-service revocation by the client itself", async () => {
    const m = await machine(["rfis:read"]);
    const res = await app.inject({
      method: "POST",
      url: url("/oauth/revoke"),
      headers: {
        authorization: `Basic ${Buffer.from(`${m.clientId}:${m.clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: new URLSearchParams({ token: m.token }).toString(),
    });
    expect(res.statusCode).toBe(200);
    const after = await app.inject({
      method: "GET",
      url: url(`/projects/${projectId}/rfis`),
      headers: m.headers,
    });
    expect(after.statusCode).toBe(401);
  });

  it("introspects a live token and answers `inactive` across a tenant boundary", async () => {
    const m = await machine(["rfis:read"]);
    const live = await app.inject({
      method: "POST",
      url: url("/integrations/oauth/introspect"),
      headers: owner.headers,
      payload: { token: m.token },
    });
    expect(live.statusCode).toBe(200);
    const body = live.json() as { active: boolean; scope: string; client_id: string };
    expect(body.active).toBe(true);
    expect(body.scope).toBe("rfis:read");
    expect(body.client_id).toBe(m.clientId);

    const foreign = await app.inject({
      method: "POST",
      url: url("/integrations/oauth/introspect"),
      headers: outsider.headers,
      payload: { token: m.token },
    });
    expect(foreign.json()).toEqual({ active: false });

    const nonsense = await app.inject({
      method: "POST",
      url: url("/integrations/oauth/introspect"),
      headers: owner.headers,
      payload: { token: "cot_not_a_real_token" },
    });
    expect(nonsense.json()).toEqual({ active: false });
  });

  it("lists a client's tokens without ever exposing a hash", async () => {
    const m = await machine(["rfis:read"]);
    const res = await app.inject({
      method: "GET",
      url: url(`/integrations/oauth/clients/${m.rowId}/tokens`),
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("tokenHash");
    expect(res.body).not.toContain(m.token);
    expect((res.json() as { total: number }).total).toBeGreaterThanOrEqual(1);
  });

  it("leaves a human JWT working exactly as before", async () => {
    const res = await app.inject({
      method: "GET",
      url: url(`/projects/${projectId}/rfis`),
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const garbage = await app.inject({
      method: "GET",
      url: url(`/projects/${projectId}/rfis`),
      headers: { authorization: "Bearer not-a-jwt", "x-company-id": owner.companyId },
    });
    expect(garbage.statusCode).toBe(401);
  });
});
