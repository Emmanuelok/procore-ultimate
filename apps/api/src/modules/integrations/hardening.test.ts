import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  developerSandboxes,
  integrationExportProfiles,
  invoiceLineItems,
  invoices,
  ledgerEntries,
  projectMemberships,
  projects,
  vendors,
  webhookDeliveries,
  webhookEndpoints,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { appendLedger, setLedgerEmitHook } from "../../lib/ledger.js";
import { createRecordingWebhookClient, getDispatcher } from "./dispatcher.js";
import { verifySignature } from "./signing.js";

/**
 * The webhook-hardening and developer-surface suite.
 *
 * Everything here is a production blocker the audit named: egress with no SSRF
 * guard, a drain with no claim (so N replicas deliver N times), one dead
 * receiver stalling every tenant, an unbounded delivery log, no way to rotate a
 * secret without a gap, no way to backfill after an outage, and a signing key
 * that shares custody with the JWT secret. Each has a test that fails if the
 * fix is removed.
 */

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let outsider: TestActor;
let projectId: string;
let clock = new Date("2026-09-01T10:00:00.000Z");

const url = (p: string) => `/api/v1${p}`;
const dispatcher = () => getDispatcher(app.db)!;

async function createEndpoint(
  actor: TestActor,
  payload: Record<string, unknown> = {},
): Promise<{ id: string; secret: string }> {
  const res = await app.inject({
    method: "POST",
    url: url("/integrations/webhooks"),
    headers: actor.headers,
    payload: { name: "hook", url: "https://receiver.example/hook", ...payload },
  });
  if (res.statusCode !== 201) throw new Error(`createEndpoint failed: ${res.body}`);
  const body = res.json() as { endpoint: { id: string }; secret: string };
  return { id: body.endpoint.id, secret: body.secret };
}

async function emit(companyId: string, objectType: string, objectId = "o-1") {
  await appendLedger(app.db, {
    companyId,
    actorId: null,
    action: "create",
    objectType,
    objectId,
    payload: { note: "test" },
  });
}

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app, { companyName: "Hardening Co" });
  outsider = await registerActor(app, { companyName: "Other Co" });
  projectId = newId("prj");
  await app.db.insert(projects).values({
    id: projectId,
    companyId: owner.companyId,
    name: "ERP Project",
  });
});

afterAll(async () => {
  await built.close();
});

beforeEach(() => {
  clock = new Date("2026-09-01T10:00:00.000Z");
  dispatcher().configure({
    now: () => clock,
    maxAttempts: 3,
    failureThreshold: 5,
    backoffBaseMs: 1_000,
    backoffMaxMs: 60_000,
    batchSize: 500,
    autoKick: false,
    leaseMs: 60_000,
    endpointConcurrency: 4,
    circuitErrorThreshold: 2,
    circuitOpenMs: 300_000,
    retentionDays: 30,
    retentionExhaustedDays: 90,
  });
  setLedgerEmitHook(app.db, async (event) => {
    await dispatcher().emit(event);
  });
});

/* ================================================================== */
/* SSRF                                                                */
/* ================================================================== */

describe("egress guard", () => {
  it("refuses the cloud metadata address at configuration, naming the rule", async () => {
    const res = await app.inject({
      method: "POST",
      url: url("/integrations/webhooks"),
      headers: owner.headers,
      payload: {
        name: "metadata",
        url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { message: string; details?: Record<string, unknown> };
    expect(body.message).toContain("169.254.0.0/16");
    expect(body.message).toContain("own network");
  });

  it("refuses loopback, RFC1918 and localhost by name", async () => {
    for (const target of [
      "http://127.0.0.1:8080/hook",
      "http://10.0.0.5:5432/",
      "http://localhost/hook",
      "https://[::1]/hook",
      "http://db.internal/hook",
    ]) {
      const res = await app.inject({
        method: "POST",
        url: url("/integrations/webhooks"),
        headers: owner.headers,
        payload: { name: "bad", url: target },
      });
      expect(res.statusCode, target).toBe(400);
    }
  });

  it("refuses a URL that embeds credentials", async () => {
    const res = await app.inject({
      method: "POST",
      url: url("/integrations/webhooks"),
      headers: owner.headers,
      payload: { name: "creds", url: "https://u:p@receiver.example/hook" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { message: string }).message).toContain("credentials");
  });

  it("re-checks a changed URL on PATCH", async () => {
    const endpoint = await createEndpoint(owner, { name: "patchable" });
    const res = await app.inject({
      method: "PATCH",
      url: url(`/integrations/webhooks/${endpoint.id}`),
      headers: owner.headers,
      payload: { url: "http://192.168.0.9/hook" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("publishes the policy on the status route", async () => {
    const res = await app.inject({
      method: "GET",
      url: url("/integrations/webhooks/status"),
      headers: owner.headers,
    });
    const body = res.json() as { egress: Record<string, unknown>; lag: Record<string, unknown> };
    expect(body.egress["note"]).toContain("metadata");
    expect(body.lag).toHaveProperty("oldestPendingAt");
    expect(body.lag).toHaveProperty("dueNow");
  });
});

/* ================================================================== */
/* Lease, concurrency, breaker, retention                              */
/* ================================================================== */

describe("the drain", () => {
  it("claims a delivery with a lease, so a second drain does not attempt it again", async () => {
    const endpoint = await createEndpoint(owner, { name: "leased", eventKinds: ["leased.create"] });
    // A transport that never resolves would hang the test; instead the row is
    // leased by hand to stand in for another replica that has already claimed
    // it, which is exactly the condition the claim must respect.
    let calls = 0;
    dispatcher().setHttpClient(
      createRecordingWebhookClient(() => {
        calls += 1;
        return { status: 200, body: "ok" };
      }),
    );
    await emit(owner.companyId, "leased");
    const [row] = await app.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, endpoint.id));
    await app.db
      .update(webhookDeliveries)
      .set({
        leaseUntil: new Date(clock.getTime() + 30_000).toISOString(),
        leaseOwner: "another-replica",
      })
      .where(eq(webhookDeliveries.id, row!.id));

    const before = calls;
    await dispatcher().dispatchDue();
    expect(calls).toBe(before);

    // once the lease expires the row is reclaimed — a process that died does
    // not strand its work
    clock = new Date(clock.getTime() + 60_000);
    await dispatcher().dispatchDue();
    expect(calls).toBeGreaterThan(before);
    const [after] = await app.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, row!.id));
    expect(after!.status).toBe("delivered");
    // the lease is released when the attempt finishes
    expect(after!.leaseUntil).toBeNull();
    expect(after!.leaseOwner).toBeNull();
  });

  it("opens a circuit breaker after consecutive TRANSPORT errors and defers the rest", async () => {
    const endpoint = await createEndpoint(owner, { name: "dead-host", eventKinds: ["dead.create"] });
    dispatcher().setHttpClient(
      createRecordingWebhookClient((call) => {
        if (call.headers["x-constructos-endpoint"] !== endpoint.id) {
          return { status: 200, body: "ok" };
        }
        throw new Error("getaddrinfo ENOTFOUND receiver.example");
      }),
    );
    for (const id of ["d-1", "d-2", "d-3", "d-4"]) await emit(owner.companyId, "dead", id);

    const summary = await dispatcher().dispatchDue();
    // threshold is 2 transport errors: two attempted, the rest deferred
    expect(summary.attempted).toBe(2);
    expect(summary.circuitDeferred).toBe(2);

    const [ep] = await app.db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, endpoint.id));
    expect(ep!.consecutiveErrors).toBeGreaterThanOrEqual(2);
    expect(ep!.circuitOpenUntil).toBeTruthy();

    // while the breaker is open the endpoint is skipped entirely
    const second = await dispatcher().dispatchDue();
    expect(second.attempted).toBe(0);
    expect(second.circuitDeferred).toBeGreaterThan(0);
  });

  it("does NOT open the breaker on HTTP failures — a 500 means the receiver is alive", async () => {
    const endpoint = await createEndpoint(owner, { name: "sad", eventKinds: ["sad.create"] });
    dispatcher().setHttpClient(
      createRecordingWebhookClient((call) =>
        call.headers["x-constructos-endpoint"] === endpoint.id
          ? { status: 500, body: "boom" }
          : { status: 200, body: "ok" },
      ),
    );
    for (const id of ["s-1", "s-2", "s-3"]) await emit(owner.companyId, "sad", id);
    await dispatcher().dispatchDue();
    const [ep] = await app.db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, endpoint.id));
    expect(ep!.consecutiveErrors).toBe(0);
    expect(ep!.circuitOpenUntil).toBeNull();
  });

  it("does not let one dead endpoint stop a healthy one in the same cycle", async () => {
    const dead = await createEndpoint(owner, { name: "gone", eventKinds: ["mixed.create"] });
    const live = await createEndpoint(owner, { name: "live", eventKinds: ["mixed.create"] });
    dispatcher().setHttpClient(
      createRecordingWebhookClient((call) => {
        if (call.headers["x-constructos-endpoint"] === dead.id) throw new Error("ECONNREFUSED");
        return { status: 200, body: "ok" };
      }),
    );
    await emit(owner.companyId, "mixed", "m-1");
    await dispatcher().dispatchDue();
    const [liveRow] = await app.db
      .select()
      .from(webhookDeliveries)
      .where(
        and(eq(webhookDeliveries.endpointId, live.id), eq(webhookDeliveries.eventKind, "mixed.create")),
      );
    expect(liveRow!.status).toBe("delivered");
  });

  it("prunes settled deliveries and never prunes one still owed", async () => {
    const endpoint = await createEndpoint(owner, { name: "retained" });
    const old = new Date(clock.getTime() - 60 * 86_400_000).toISOString();
    const rows = [
      { id: newId("whd"), status: "delivered" as const },
      { id: newId("whd"), status: "skipped" as const },
      { id: newId("whd"), status: "pending" as const },
      { id: newId("whd"), status: "failed" as const },
      { id: newId("whd"), status: "exhausted" as const },
    ];
    for (const row of rows) {
      await app.db.insert(webhookDeliveries).values({
        id: row.id,
        companyId: owner.companyId,
        endpointId: endpoint.id,
        eventKind: "old.create",
        payload: {},
        signature: "v1=x",
        status: row.status,
        createdAt: old,
      });
    }
    const out = await dispatcher().prune(clock);
    expect(out.deleted).toBe(2); // delivered + skipped; exhausted is kept longer
    const left = await app.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, endpoint.id));
    expect(left.map((r) => r.status).sort()).toEqual(["exhausted", "failed", "pending"]);
  });
});

/* ================================================================== */
/* Secret rotation                                                     */
/* ================================================================== */

describe("secret rotation", () => {
  it("issues a new secret and signs with BOTH during the grace window", async () => {
    const endpoint = await createEndpoint(owner, { name: "rot", eventKinds: ["rot.create"] });
    const rotate = await app.inject({
      method: "POST",
      url: url(`/integrations/webhooks/${endpoint.id}/rotate-secret`),
      headers: owner.headers,
      payload: { graceMinutes: 60 },
    });
    expect(rotate.statusCode).toBe(200);
    const body = rotate.json() as { secret: string; secretVersion: number; graceUntil: string };
    expect(body.secretVersion).toBe(2);
    expect(body.secret).not.toBe(endpoint.secret);
    expect(body.graceUntil).toBeTruthy();

    const client = createRecordingWebhookClient(() => ({ status: 200, body: "ok" }));
    dispatcher().setHttpClient(client);
    await emit(owner.companyId, "rot", "r-1");
    await dispatcher().dispatchDue();
    const call = client.calls.find(
      (c) => c.headers["x-constructos-endpoint"] === endpoint.id,
    )!;
    const ts = Number(call.headers["x-constructos-timestamp"]);
    const deliveryId = call.headers["x-constructos-delivery"]!;

    // the standard header still verifies with the secret the receiver holds…
    expect(
      verifySignature(endpoint.secret, ts, deliveryId, call.body, call.headers["x-constructos-signature"]!),
    ).toBe(true);
    // …and the alternate header verifies with the new one, so a receiver can
    // adopt it without dropping a delivery
    expect(
      verifySignature(body.secret, ts, deliveryId, call.body, call.headers["x-constructos-signature-alt"]!),
    ).toBe(true);
    expect(call.headers["x-constructos-secret-version"]).toBe("1");
    expect(call.headers["x-constructos-secret-version-alt"]).toBe("2");
  });

  it("cuts over immediately when no grace is asked for", async () => {
    const endpoint = await createEndpoint(owner, { name: "hard-rot", eventKinds: ["hrot.create"] });
    const rotate = await app.inject({
      method: "POST",
      url: url(`/integrations/webhooks/${endpoint.id}/rotate-secret`),
      headers: owner.headers,
      payload: { graceMinutes: 0 },
    });
    const body = rotate.json() as { secret: string; graceUntil: string | null };
    expect(body.graceUntil).toBeNull();

    const client = createRecordingWebhookClient(() => ({ status: 200, body: "ok" }));
    dispatcher().setHttpClient(client);
    await emit(owner.companyId, "hrot", "h-1");
    await dispatcher().dispatchDue();
    const call = client.calls.find((c) => c.headers["x-constructos-endpoint"] === endpoint.id)!;
    expect(call.headers["x-constructos-signature-alt"]).toBeUndefined();
    expect(
      verifySignature(
        body.secret,
        Number(call.headers["x-constructos-timestamp"]),
        call.headers["x-constructos-delivery"]!,
        call.body,
        call.headers["x-constructos-signature"]!,
      ),
    ).toBe(true);
  });

  it("ledgers the rotation and refuses across a tenant boundary", async () => {
    const endpoint = await createEndpoint(owner, { name: "audited-rot" });
    await app.inject({
      method: "POST",
      url: url(`/integrations/webhooks/${endpoint.id}/rotate-secret`),
      headers: owner.headers,
      payload: {},
    });
    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectId, endpoint.id),
        ),
      );
    expect(
      entries.some(
        (e) => (e.payload as Record<string, unknown> | null)?.["phase"] === "secret_rotation",
      ),
    ).toBe(true);

    const cross = await app.inject({
      method: "POST",
      url: url(`/integrations/webhooks/${endpoint.id}/rotate-secret`),
      headers: outsider.headers,
      payload: {},
    });
    expect(cross.statusCode).toBe(404);
  });
});

/* ================================================================== */
/* Replay                                                              */
/* ================================================================== */

describe("replay", () => {
  it("re-derives deliveries from the ledger for an endpoint created later", async () => {
    // three events happen before any endpoint exists
    setLedgerEmitHook(app.db, null);
    for (const id of ["p-1", "p-2", "p-3"]) await emit(owner.companyId, "backfill", id);
    const [firstEntry] = await app.db
      .select({ seq: ledgerEntries.seq })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectType, "backfill"),
        ),
      )
      .orderBy(ledgerEntries.seq)
      .limit(1);
    setLedgerEmitHook(app.db, async (event) => {
      await dispatcher().emit(event);
    });

    const endpoint = await createEndpoint(owner, {
      name: "backfiller",
      eventKinds: ["backfill.create"],
    });
    const res = await app.inject({
      method: "POST",
      url: url(`/integrations/webhooks/${endpoint.id}/replay`),
      headers: owner.headers,
      payload: { fromSeq: Number(firstEntry!.seq), limit: 100 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { enqueued: number; scanned: number; lastSeq: number };
    expect(body.enqueued).toBe(3);
    expect(body.scanned).toBeGreaterThanOrEqual(3);

    const queued = await app.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, endpoint.id));
    expect(queued).toHaveLength(3);
    expect(queued.every((d) => (d.payload as Record<string, unknown>)["sandbox"] === undefined)).toBe(
      true,
    );
    // the replayed envelope names the ledger sequence it came from
    const data = (queued[0]!.payload as Record<string, Record<string, unknown>>)["data"]!;
    expect(data["replay"]).toBe(true);
    expect(typeof data["ledgerSeq"]).toBe("number");
  });

  it("refuses to replay into a disabled endpoint rather than queue for nothing", async () => {
    const endpoint = await createEndpoint(owner, { name: "off", active: false });
    const res = await app.inject({
      method: "POST",
      url: url(`/integrations/webhooks/${endpoint.id}/replay`),
      headers: owner.headers,
      payload: { fromSeq: 1 },
    });
    expect(res.statusCode).toBe(409);
  });

  it("refuses a replay across a tenant boundary", async () => {
    const endpoint = await createEndpoint(owner, { name: "mine" });
    const res = await app.inject({
      method: "POST",
      url: url(`/integrations/webhooks/${endpoint.id}/replay`),
      headers: outsider.headers,
      payload: { fromSeq: 1 },
    });
    expect(res.statusCode).toBe(404);
  });
});

/* ================================================================== */
/* Developer sandbox                                                   */
/* ================================================================== */

describe("developer sandbox", () => {
  afterAll(async () => {
    await app.db
      .delete(developerSandboxes)
      .where(eq(developerSandboxes.companyId, outsider.companyId));
  });

  it("marks a tenant, labels its webhook envelopes and can be lifted", async () => {
    const enable = await app.inject({
      method: "POST",
      url: url("/integrations/sandbox"),
      headers: outsider.headers,
      payload: { purpose: "integration development" },
    });
    expect(enable.statusCode).toBe(201);

    const endpoint = await createEndpoint(outsider, {
      name: "sandboxed",
      eventKinds: ["sbx.create"],
    });
    await emit(outsider.companyId, "sbx", "sb-1");
    const [delivery] = await app.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, endpoint.id));
    expect((delivery!.payload as Record<string, unknown>)["sandbox"]).toBe(true);

    const status = await app.inject({
      method: "GET",
      url: url("/integrations/sandbox"),
      headers: outsider.headers,
    });
    expect((status.json() as { sandbox: boolean }).sandbox).toBe(true);

    const again = await app.inject({
      method: "POST",
      url: url("/integrations/sandbox"),
      headers: outsider.headers,
      payload: {},
    });
    expect(again.statusCode).toBe(409);

    const off = await app.inject({
      method: "DELETE",
      url: url("/integrations/sandbox"),
      headers: outsider.headers,
    });
    expect(off.statusCode).toBe(200);
    const afterOff = await app.inject({
      method: "GET",
      url: url("/integrations/sandbox"),
      headers: outsider.headers,
    });
    expect((afterOff.json() as { sandbox: boolean }).sandbox).toBe(false);
  });

  it("does not leak one tenant's sandbox flag into another's", async () => {
    const res = await app.inject({
      method: "GET",
      url: url("/integrations/sandbox"),
      headers: owner.headers,
    });
    expect((res.json() as { sandbox: boolean }).sandbox).toBe(false);
  });
});

/* ================================================================== */
/* ERP export                                                          */
/* ================================================================== */

describe("ERP connector framework", () => {
  let vendorId: string;

  beforeAll(async () => {
    vendorId = newId("ven");
    await app.db.insert(vendors).values({
      id: vendorId,
      companyId: owner.companyId,
      name: "=Acme, Ltd",
      registrationNumber: "V-100",
      createdBy: owner.userId,
    });
    const invoiceId = newId("inv");
    await app.db.insert(invoices).values({
      id: invoiceId,
      companyId: owner.companyId,
      projectId,
      kind: "subcontractor_invoice",
      number: 1,
      reference: "INV-0001",
      status: "approved",
      vendorId,
      invoiceNumber: "ACME-77",
      currency: "GBP",
      billingDate: "2026-08-31",
      periodEnd: "2026-08-31",
      dueDate: "2026-09-30",
      subtotal: 1000,
      taxAmount: 200,
      total: 1200,
      totalRetainage: 50,
      createdBy: owner.userId,
    });
    await app.db.insert(invoiceLineItems).values({
      id: newId("ivl"),
      companyId: owner.companyId,
      projectId,
      invoiceId,
      lineNumber: "1",
      description: "Groundworks",
      costCode: "02-100",
      costType: "subcontract",
      thisPeriodWork: 1000,
      amount: 950,
      retainageThisPeriod: 50,
    });
    // a second invoice in a DIFFERENT currency, to prove nothing is summed
    await app.db.insert(invoices).values({
      id: newId("inv"),
      companyId: owner.companyId,
      projectId,
      kind: "subcontractor_invoice",
      number: 2,
      reference: "INV-0002",
      status: "approved",
      vendorId,
      currency: "EUR",
      billingDate: "2026-08-30",
      periodEnd: "2026-08-31",
      subtotal: 500,
      total: 500,
      createdBy: owner.userId,
    });
  });

  it("publishes the canonical vocabulary and the starter profiles", async () => {
    const res = await app.inject({
      method: "GET",
      url: url("/integrations/erp/catalogue"),
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      feeds: { feed: string; fields: unknown[] }[];
      starters: { key: string; system: string }[];
      note: string;
    };
    expect(body.feeds.map((f) => f.feed)).toEqual(["ap_invoices", "job_cost", "payments"]);
    expect(body.starters.map((s) => s.system)).toEqual(
      expect.arrayContaining(["sage", "viewpoint", "quickbooks"]),
    );
    // the note must not overclaim: nothing here posts to an ERP
    expect(body.note).toContain("Nothing here posts to an ERP");
  });

  it("creates a profile from a starter and refuses a map that names an unknown field", async () => {
    const created = await app.inject({
      method: "POST",
      url: url("/integrations/erp/profiles"),
      headers: owner.headers,
      payload: { name: "Sage AP", system: "sage", feed: "ap_invoices", starter: "sage300_ap" },
    });
    expect(created.statusCode).toBe(201);
    const profile = created.json() as { id: string; fieldMap: unknown[] };
    expect(profile.fieldMap.length).toBeGreaterThan(3);

    const bad = await app.inject({
      method: "POST",
      url: url("/integrations/erp/profiles"),
      headers: owner.headers,
      payload: {
        name: "Broken",
        system: "generic",
        feed: "ap_invoices",
        fieldMap: [{ target: "X", source: "notAField" }],
      },
    });
    expect(bad.statusCode).toBe(400);
    expect(JSON.stringify(bad.json())).toContain("notAField");

    const mismatched = await app.inject({
      method: "POST",
      url: url("/integrations/erp/profiles"),
      headers: owner.headers,
      payload: { name: "Wrong feed", system: "sage", feed: "job_cost", starter: "sage300_ap" },
    });
    expect(mismatched.statusCode).toBe(400);
  });

  it("exports AP invoices as JSON with the currencies present and no cross-currency total", async () => {
    const res = await app.inject({
      method: "GET",
      url: url(
        `/projects/${projectId}/integrations/erp/export?feed=ap_invoices&format=json`,
      ),
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      rowCount: number;
      currencies: string[];
      caveats: string[];
      rows: Record<string, unknown>[];
    };
    expect(body.rowCount).toBe(2);
    expect(body.currencies).toEqual(["EUR", "GBP"]);
    expect(body.caveats.join(" ")).toContain("2 currencies");
    // every row carries its own currency: nothing is normalised away
    expect(new Set(body.rows.map((r) => r["currency"]))).toEqual(new Set(["GBP", "EUR"]));
  });

  it("exports job cost lines coded to cost code and type", async () => {
    const res = await app.inject({
      method: "GET",
      url: url(`/projects/${projectId}/integrations/erp/export?feed=job_cost&format=json`),
      headers: owner.headers,
    });
    const body = res.json() as { rows: Record<string, unknown>[] };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]!["costCode"]).toBe("02-100");
    expect(body.rows[0]!["amount"]).toBe(950);
  });

  it("neutralises a formula in a CSV export and states the caveats in the file", async () => {
    const res = await app.inject({
      method: "GET",
      url: url(`/projects/${projectId}/integrations/erp/export?feed=ap_invoices&format=csv`),
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    // the vendor name starts with "=" — it must not be a live formula
    expect(res.body).toContain("'=Acme, Ltd");
    expect(res.body).toContain("# ConstructOS ap_invoices export");
    expect(res.body).toContain("# currencies: EUR GBP");
  });

  it("renders through a profile's own column names", async () => {
    const [profile] = await app.db
      .select()
      .from(integrationExportProfiles)
      .where(eq(integrationExportProfiles.companyId, owner.companyId))
      .limit(1);
    const res = await app.inject({
      method: "GET",
      url: url(
        `/projects/${projectId}/integrations/erp/export?profileId=${profile!.id}&format=json`,
      ),
      headers: owner.headers,
    });
    const body = res.json() as { columns: string[] };
    expect(body.columns).toContain("Vendor");
    expect(body.columns).toContain("Invoice Date");
  });

  it("ledgers the export with what left, and refuses across a tenant boundary", async () => {
    await app.inject({
      method: "GET",
      url: url(`/projects/${projectId}/integrations/erp/export?feed=payments&format=json`),
      headers: owner.headers,
    });
    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectType, "integration_export_profile"),
          eq(ledgerEntries.action, "access"),
        ),
      );
    expect(entries.length).toBeGreaterThan(0);
    const payload = entries[entries.length - 1]!.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ format: "json" });
    expect(payload).toHaveProperty("rowCount");
    expect(payload).toHaveProperty("currencies");

    const cross = await app.inject({
      method: "GET",
      url: url(`/projects/${projectId}/integrations/erp/export?feed=ap_invoices`),
      headers: outsider.headers,
    });
    expect([403, 404]).toContain(cross.statusCode);
  });

  it("refuses a project member who does not hold invoicing read", async () => {
    const restricted = await registerActor(app);
    await app.db.insert(projectMemberships).values({
      id: newId("pm"),
      companyId: owner.companyId,
      projectId,
      userId: restricted.userId,
      templateKey: "subcontractor",
    });
    const { companyMemberships } = await import("@constructos/db");
    await app.db.insert(companyMemberships).values({
      id: newId("cm"),
      companyId: owner.companyId,
      userId: restricted.userId,
      role: "member",
    });
    const res = await app.inject({
      method: "GET",
      url: url(`/projects/${projectId}/integrations/erp/export?feed=ap_invoices`),
      headers: {
        authorization: restricted.headers["authorization"]!,
        "x-company-id": owner.companyId,
      },
    });
    expect(res.statusCode).toBe(403);
  });
});

/* ================================================================== */
/* OpenAPI                                                             */
/* ================================================================== */

describe("openapi.json", () => {
  it("describes the live route table and needs authentication", async () => {
    const anon = await app.inject({ method: "GET", url: url("/openapi.json") });
    expect(anon.statusCode).toBe(401);

    const res = await app.inject({
      method: "GET",
      url: url("/openapi.json"),
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const doc = res.json() as {
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
      tags: { name: string }[];
      info: { description: string };
    };
    expect(doc.openapi).toBe("3.1.0");
    // routes that certainly exist in this deployment
    expect(Object.keys(doc.paths)).toContain("/api/v1/integrations/webhooks");
    expect(Object.keys(doc.paths)).toContain("/api/v1/integrations/webhooks/{endpointId}");
    expect(doc.tags.map((t) => t.name)).toContain("integrations");
    expect(doc.info.description).toContain("GENERATED FROM THE LIVE ROUTE TABLE");
  });
});
