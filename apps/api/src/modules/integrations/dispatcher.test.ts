import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { ledgerEntries, webhookDeliveries, webhookEndpoints } from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { appendLedger, setLedgerEmitHook } from "../../lib/ledger.js";
import { backoffMs, createRecordingWebhookClient, getDispatcher } from "./dispatcher.js";
import { canonicalBody, stringToSign, verifySignature } from "./signing.js";

/**
 * Dispatcher tests (Vol I §0.7 #121). Everything runs against an injected
 * transport and a frozen clock: success, 500-then-success, exhaustion, the
 * auto-disable run and the backoff schedule are all driven deterministically,
 * with no socket and no waiting.
 */

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let other: TestActor;
let clock = new Date("2026-08-25T10:00:00.000Z");

const url = (p: string) => `/api/v1${p}`;
const dispatcher = () => getDispatcher(app.db)!;

interface CreatedEndpoint {
  id: string;
  secret: string;
}

async function createEndpoint(
  actor: TestActor,
  payload: Record<string, unknown>,
): Promise<CreatedEndpoint> {
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

async function deliveriesFor(endpointId: string, eventKind?: string) {
  return app.db
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.endpointId, endpointId),
        eventKind ? eq(webhookDeliveries.eventKind, eventKind) : undefined,
      ),
    );
}

async function emit(
  companyId: string,
  objectType: string,
  action: "create" | "update" | "state_change" | "delete" | "access",
  extra: { projectId?: string | null; objectId?: string } = {},
) {
  await appendLedger(app.db, {
    companyId,
    actorId: null,
    action,
    objectType,
    objectId: extra.objectId ?? `${objectType}-1`,
    ...(extra.projectId !== undefined ? { projectId: extra.projectId } : {}),
    payload: { note: "test" },
  });
}

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  other = await registerActor(app);
});

afterAll(async () => {
  await built.close();
});

beforeEach(() => {
  clock = new Date("2026-08-25T10:00:00.000Z");
  dispatcher().configure({
    now: () => clock,
    maxAttempts: 3,
    failureThreshold: 2,
    backoffBaseMs: 1_000,
    backoffMaxMs: 60_000,
    responseBodyLimit: 2_048,
    batchSize: 500,
    autoKick: false,
  });
  // Restore the real emitter in case a test replaced it.
  setLedgerEmitHook(app.db, async (event) => {
    await dispatcher().emit(event);
  });
});

/* ------------------------------------------------------------------ */
/* Fan-out and isolation                                               */
/* ------------------------------------------------------------------ */

describe("emit — what an endpoint is and is not told", () => {
  it("delivers only the event kinds an endpoint subscribed to", async () => {
    const narrow = await createEndpoint(owner, { eventKinds: ["widget.create"] });
    await emit(owner.companyId, "widget", "create");
    await emit(owner.companyId, "widget", "update");
    await emit(owner.companyId, "gadget", "create");
    const rows = await deliveriesFor(narrow.id);
    expect(rows.map((r) => r.eventKind)).toEqual(["widget.create"]);
  });

  it("treats an empty eventKinds list as every kind, and honours wildcards", async () => {
    const all = await createEndpoint(owner, { name: "all", eventKinds: [] });
    const byType = await createEndpoint(owner, { name: "type", eventKinds: ["sprocket.*"] });
    const byAction = await createEndpoint(owner, { name: "action", eventKinds: ["*.delete"] });
    await emit(owner.companyId, "sprocket", "update");
    await emit(owner.companyId, "cog", "delete");
    const allKinds = (await deliveriesFor(all.id)).map((r) => r.eventKind);
    expect(allKinds).toContain("sprocket.update");
    expect(allKinds).toContain("cog.delete");
    expect((await deliveriesFor(byType.id)).map((r) => r.eventKind)).toEqual(["sprocket.update"]);
    expect((await deliveriesFor(byAction.id)).map((r) => r.eventKind)).toEqual(["cog.delete"]);
  });

  it("never crosses a tenant boundary — the leak that would matter most", async () => {
    const mine = await createEndpoint(owner, { name: "mine", eventKinds: ["secret.create"] });
    const theirs = await createEndpoint(other, { name: "theirs", eventKinds: ["secret.create"] });
    await emit(owner.companyId, "secret", "create", { objectId: "only-mine" });
    const mineRows = await deliveriesFor(mine.id, "secret.create");
    const theirRows = await deliveriesFor(theirs.id, "secret.create");
    expect(mineRows).toHaveLength(1);
    expect(theirRows).toHaveLength(0);
    expect(mineRows[0]!.companyId).toBe(owner.companyId);
  });

  it("respects an endpoint narrowed to one project", async () => {
    const scoped = await createEndpoint(owner, {
      name: "scoped",
      eventKinds: ["scoped_thing.create"],
      projectId: null,
    });
    // narrow it by hand: the route validates the project exists, and this test
    // is about the matcher, not the route
    await app.db
      .update(webhookEndpoints)
      .set({ projectId: "prj_alpha" })
      .where(eq(webhookEndpoints.id, scoped.id));
    await emit(owner.companyId, "scoped_thing", "create", { projectId: "prj_beta" });
    expect(await deliveriesFor(scoped.id, "scoped_thing.create")).toHaveLength(0);
    await emit(owner.companyId, "scoped_thing", "create", { projectId: "prj_alpha" });
    expect(await deliveriesFor(scoped.id, "scoped_thing.create")).toHaveLength(1);
  });

  it("queues nothing for a disabled endpoint", async () => {
    const off = await createEndpoint(owner, { name: "off", eventKinds: ["quiet.create"] });
    await app.db
      .update(webhookEndpoints)
      .set({ isActive: 0, disabledReason: "operator disabled" })
      .where(eq(webhookEndpoints.id, off.id));
    await emit(owner.companyId, "quiet", "create");
    expect(await deliveriesFor(off.id, "quiet.create")).toHaveLength(0);
  });

  it("takes the project from the ledger payload when the caller did not name one", async () => {
    const scoped = await createEndpoint(owner, { name: "payload-scoped", eventKinds: ["pl.create"] });
    await app.db
      .update(webhookEndpoints)
      .set({ projectId: "prj_from_payload" })
      .where(eq(webhookEndpoints.id, scoped.id));
    await appendLedger(app.db, {
      companyId: owner.companyId,
      actorId: null,
      action: "create",
      objectType: "pl",
      objectId: "pl-1",
      payload: { projectId: "prj_from_payload" },
    });
    expect(await deliveriesFor(scoped.id, "pl.create")).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* The ledger contract                                                 */
/* ------------------------------------------------------------------ */

describe("the ledger append is never at risk", () => {
  it("still writes the entry when the emitter throws, and records the failure", async () => {
    setLedgerEmitHook(app.db, () => {
      throw new Error("emitter exploded");
    });
    await expect(
      appendLedger(app.db, {
        companyId: owner.companyId,
        actorId: null,
        action: "create",
        objectType: "resilient",
        objectId: "r-1",
        payload: {},
      }),
    ).resolves.toBeUndefined();
    const rows = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectType, "resilient"),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it("records an enqueue failure on the emitter's health rather than propagating it", async () => {
    const before = dispatcher().getHealth().enqueueFailures;
    // an endpoint row whose eventKinds column holds something the matcher
    // cannot iterate — the shape a bad migration or a hand-edit would leave
    const broken = await createEndpoint(owner, { name: "broken", eventKinds: [] });
    await app.db
      .update(webhookEndpoints)
      .set({ eventKinds: {} as unknown as string[] })
      .where(eq(webhookEndpoints.id, broken.id));
    await expect(
      appendLedger(app.db, {
        companyId: owner.companyId,
        actorId: null,
        action: "create",
        objectType: "health_probe",
        objectId: "h-1",
        payload: {},
      }),
    ).resolves.toBeUndefined();
    const health = dispatcher().getHealth();
    expect(health.enqueueFailures).toBe(before + 1);
    expect(health.lastEnqueueError).toBeTruthy();
    await app.db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, broken.id));
  });
});

/* ------------------------------------------------------------------ */
/* Signing                                                             */
/* ------------------------------------------------------------------ */

describe("signature", () => {
  it("verifies over the documented string-to-sign and fails on tampering", async () => {
    const endpoint = await createEndpoint(owner, { name: "signed", eventKinds: ["signed.create"] });
    const client = createRecordingWebhookClient(() => ({ status: 200, body: "ok" }));
    dispatcher().setHttpClient(client);
    await emit(owner.companyId, "signed", "create");
    await dispatcher().dispatchDue();

    const call = client.calls.find(
      (c) =>
        c.headers["x-constructos-endpoint"] === endpoint.id &&
        c.headers["x-constructos-event"] === "signed.create",
    )!;
    expect(call).toBeDefined();
    const timestamp = Number(call.headers["x-constructos-timestamp"]);
    const deliveryId = call.headers["x-constructos-delivery"]!;
    const signature = call.headers["x-constructos-signature"]!;

    // exactly what an integrator would do
    expect(verifySignature(endpoint.secret, timestamp, deliveryId, call.body, signature)).toBe(true);
    expect(signature.startsWith("v1=")).toBe(true);
    expect(stringToSign(timestamp, deliveryId, call.body)).toBe(
      `v1:${timestamp}:${deliveryId}:${call.body}`,
    );

    // every axis of tampering is rejected
    expect(
      verifySignature(endpoint.secret, timestamp, deliveryId, `${call.body} `, signature),
    ).toBe(false);
    expect(verifySignature(endpoint.secret, timestamp + 1, deliveryId, call.body, signature)).toBe(
      false,
    );
    expect(verifySignature(endpoint.secret, timestamp, "whd_other", call.body, signature)).toBe(
      false,
    );
    expect(verifySignature("whsec_wrong", timestamp, deliveryId, call.body, signature)).toBe(false);
  });

  it("sends the documented headers and a canonical body", async () => {
    const endpoint = await createEndpoint(owner, { name: "headers", eventKinds: ["hdr.create"] });
    const client = createRecordingWebhookClient(() => ({ status: 204, body: "" }));
    dispatcher().setHttpClient(client);
    await emit(owner.companyId, "hdr", "create");
    await dispatcher().dispatchDue();
    const call = client.calls.find(
      (c) =>
        c.headers["x-constructos-endpoint"] === endpoint.id &&
        c.headers["x-constructos-event"] === "hdr.create",
    )!;
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.headers["x-constructos-endpoint"]).toBe(endpoint.id);
    expect(call.headers["x-constructos-company"]).toBe(owner.companyId);
    expect(call.headers["x-constructos-attempt"]).toBe("1");
    const envelope = JSON.parse(call.body) as Record<string, unknown>;
    expect(canonicalBody(envelope as never)).toBe(call.body);
    // identity and hashes travel; the ledger payload does not
    const data = envelope["data"] as Record<string, unknown>;
    expect(data["objectType"]).toBe("hdr");
    expect(typeof data["payloadHash"]).toBe("string");
    expect(envelope).not.toHaveProperty("payload");
  });
});

/* ------------------------------------------------------------------ */
/* Retry, exhaustion, auto-disable                                     */
/* ------------------------------------------------------------------ */

describe("delivery state machine", () => {
  it("marks a 2xx delivered and stores a truncated response body", async () => {
    dispatcher().configure({ responseBodyLimit: 10 });
    const endpoint = await createEndpoint(owner, { name: "ok", eventKinds: ["ok.create"] });
    dispatcher().setHttpClient(
      createRecordingWebhookClient((call) => ({
        status: 200,
        body: call.headers["x-constructos-endpoint"] === endpoint.id ? "x".repeat(50) : "ok",
      })),
    );
    await emit(owner.companyId, "ok", "create");
    await dispatcher().dispatchDue();
    const [row] = await deliveriesFor(endpoint.id, "ok.create");
    expect(row!.status).toBe("delivered");
    expect(row!.responseStatus).toBe(200);
    expect(row!.responseBody).toBe(`${"x".repeat(10)}…[truncated 40 chars]`);
    expect(row!.deliveredAt).toBeTruthy();
    expect(row!.nextAttemptAt).toBeNull();
  });

  it("retries after a 500 and succeeds on the second attempt", async () => {
    const endpoint = await createEndpoint(owner, { name: "flaky", eventKinds: ["flaky.create"] });
    let n = 0;
    dispatcher().setHttpClient(
      createRecordingWebhookClient((call) => {
        if (call.headers["x-constructos-endpoint"] !== endpoint.id) {
          return { status: 200, body: "ok" };
        }
        n += 1;
        return n === 1 ? { status: 500, body: "boom" } : { status: 200, body: "ok" };
      }),
    );
    await emit(owner.companyId, "flaky", "create");

    await dispatcher().dispatchDue();
    let [row] = await deliveriesFor(endpoint.id, "flaky.create");
    expect(row!.status).toBe("failed");
    expect(row!.attempts).toBe(1);
    expect(row!.error).toContain("500");
    const scheduled = Date.parse(row!.nextAttemptAt!);
    expect(scheduled).toBeGreaterThan(clock.getTime());

    // not yet due — a drain now must not touch it
    await dispatcher().dispatchDue();
    [row] = await deliveriesFor(endpoint.id, "flaky.create");
    expect(row!.attempts).toBe(1);

    clock = new Date(scheduled + 1);
    await dispatcher().dispatchDue();
    [row] = await deliveriesFor(endpoint.id, "flaky.create");
    expect(row!.status).toBe("delivered");
    expect(row!.attempts).toBe(2);
    expect(n).toBe(2);
  });

  it("backs off exponentially and stops growing at the cap", () => {
    const opts = { backoffBaseMs: 1_000, backoffMaxMs: 8_000 };
    const at = (attempt: number) => backoffMs(opts, "whd_fixed", attempt);
    expect(at(1)).toBeGreaterThanOrEqual(1_000);
    expect(at(2)).toBeGreaterThan(at(1));
    expect(at(3)).toBeGreaterThan(at(2));
    // capped: attempt 6 would be 32s uncapped. Both it and attempt 7 sit
    // inside the cap plus at most 20% jitter, and neither grows past it.
    for (const attempt of [6, 7, 12]) {
      expect(at(attempt)).toBeGreaterThanOrEqual(8_000);
      expect(at(attempt)).toBeLessThanOrEqual(8_000 * 1.2);
    }
    // deterministic for a given (delivery, attempt) pair
    expect(backoffMs(opts, "whd_a", 2)).toBe(backoffMs(opts, "whd_a", 2));
  });

  it("exhausts after the attempt budget and stops rescheduling", async () => {
    const endpoint = await createEndpoint(owner, { name: "dead", eventKinds: ["dead.create"] });
    dispatcher().setHttpClient(
      createRecordingWebhookClient((call) =>
        call.headers["x-constructos-endpoint"] === endpoint.id
          ? { status: 503, body: "down" }
          : { status: 200, body: "ok" },
      ),
    );
    await emit(owner.companyId, "dead", "create");
    for (let i = 0; i < 3; i += 1) {
      await dispatcher().dispatchDue();
      const [row] = await deliveriesFor(endpoint.id, "dead.create");
      if (row!.nextAttemptAt) clock = new Date(Date.parse(row!.nextAttemptAt) + 1);
    }
    const [row] = await deliveriesFor(endpoint.id, "dead.create");
    expect(row!.status).toBe("exhausted");
    expect(row!.attempts).toBe(3);
    expect(row!.nextAttemptAt).toBeNull();
    const [ep] = await app.db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, endpoint.id));
    expect(ep!.failureCount).toBe(1);
    expect(ep!.lastStatus).toBe("exhausted");
    expect(ep!.isActive).toBe(1);
  });

  it("auto-disables after a run of consecutive exhausted deliveries", async () => {
    const endpoint = await createEndpoint(owner, { name: "gone", eventKinds: ["gone.create"] });
    dispatcher().setHttpClient(
      createRecordingWebhookClient((call) =>
        call.headers["x-constructos-endpoint"] === endpoint.id
          ? { status: 500, body: "" }
          : { status: 200, body: "ok" },
      ),
    );

    const drainOne = async (objectId: string) => {
      await emit(owner.companyId, "gone", "create", { objectId });
      for (let i = 0; i < 3; i += 1) {
        await dispatcher().dispatchDue();
        clock = new Date(clock.getTime() + 120_000);
      }
    };
    await drainOne("g-1");
    await drainOne("g-2");

    const [ep] = await app.db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, endpoint.id));
    expect(ep!.failureCount).toBeGreaterThanOrEqual(2);
    expect(ep!.isActive).toBe(0);
    expect(ep!.disabledReason).toContain("Auto-disabled");
    expect(ep!.disabledReason).toContain("consecutive");
  });

  it("clears the failure run on a success", async () => {
    const endpoint = await createEndpoint(owner, { name: "recover", eventKinds: ["rec.create"] });
    await app.db
      .update(webhookEndpoints)
      .set({ failureCount: 1 })
      .where(eq(webhookEndpoints.id, endpoint.id));
    dispatcher().setHttpClient(createRecordingWebhookClient(() => ({ status: 200, body: "ok" })));
    await emit(owner.companyId, "rec", "create");
    await dispatcher().dispatchDue();
    const [ep] = await app.db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, endpoint.id));
    expect(ep!.failureCount).toBe(0);
    expect(ep!.lastStatus).toBe("delivered");
  });

  it("skips a delivery whose endpoint was disabled after it was queued", async () => {
    const endpoint = await createEndpoint(owner, { name: "later-off", eventKinds: ["late.create"] });
    dispatcher().setHttpClient(createRecordingWebhookClient(() => ({ status: 200, body: "ok" })));
    await emit(owner.companyId, "late", "create");
    await app.db
      .update(webhookEndpoints)
      .set({ isActive: 0, disabledReason: "operator disabled" })
      .where(eq(webhookEndpoints.id, endpoint.id));
    await dispatcher().dispatchDue();
    const [row] = await deliveriesFor(endpoint.id, "late.create");
    expect(row!.status).toBe("skipped");
    expect(row!.error).toContain("operator disabled");
  });

  it("records a transport failure as an error rather than a status", async () => {
    const endpoint = await createEndpoint(owner, { name: "dns", eventKinds: ["dns.create"] });
    dispatcher().setHttpClient(
      createRecordingWebhookClient((call) => {
        if (call.headers["x-constructos-endpoint"] !== endpoint.id) {
          return { status: 200, body: "ok" };
        }
        throw new Error("getaddrinfo ENOTFOUND receiver.example");
      }),
    );
    await emit(owner.companyId, "dns", "create");
    await dispatcher().dispatchDue();
    const [row] = await deliveriesFor(endpoint.id, "dns.create");
    expect(row!.status).toBe("failed");
    expect(row!.responseStatus).toBeNull();
    expect(row!.error).toContain("transport error");
    expect(row!.error).toContain("ENOTFOUND");
  });
});
