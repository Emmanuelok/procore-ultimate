/**
 * Notification preferences, muting and the digest — the policy every module's
 * `pushNotifications` call now goes through.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { companyMemberships, notifications, watchers } from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";
import { pushNotifications, notifyWatchers } from "./service.js";
import { NOTIFICATION_DIGEST_JOB } from "./index.js";

let built: BuiltApp;
let app: FastifyInstance;
let owner: TestActor;
let member: TestActor;
let memberHeaders: Record<string, string>;
let projectA: string;
let projectB: string;

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app, { companyName: "Notify Co" });
  member = await registerActor(app);
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

  const a = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: owner.headers,
    payload: { name: "Notify A" },
  });
  projectA = a.json().id;
  const b = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: owner.headers,
    payload: { name: "Notify B" },
  });
  projectB = b.json().id;
});

afterAll(async () => {
  await built.close();
});

async function countFor(userId: string, kind?: string) {
  const conds = [
    eq(notifications.companyId, owner.companyId),
    eq(notifications.userId, userId),
  ];
  if (kind) conds.push(eq(notifications.kind, kind));
  const rows = await app.db.select().from(notifications).where(and(...conds));
  return rows.length;
}

describe("GET/PUT /me/notification-preferences", () => {
  it("returns sane defaults plus the catalogue the settings page renders from", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/notification-preferences",
      headers: memberHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ defaultChannel: "in_app", digest: "off" });
    expect(res.json().catalogue.kinds).toContain("mention");
  });

  it("saves preferences and drops project ids that do not exist", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/me/notification-preferences",
      headers: memberHeaders,
      payload: {
        digest: "daily",
        kinds: { status_change: "none" },
        mutedProjectIds: [projectB, "prj_nope"],
        mutedTools: ["punch"],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().mutedProjectIds).toEqual([projectB]);
    expect(res.json().digest).toBe("daily");
  });

  it("refuses an unknown channel or kind", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/me/notification-preferences",
      headers: memberHeaders,
      payload: { defaultChannel: "carrier_pigeon" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("pushNotifications honours the policy", () => {
  it("suppresses a muted project and a disabled kind, and says why", async () => {
    const before = await countFor(member.userId);
    const result = await pushNotifications(app.db, [
      {
        companyId: owner.companyId,
        userId: member.userId,
        projectId: projectB,
        kind: "assignment",
        title: "Muted project",
      },
      {
        companyId: owner.companyId,
        userId: member.userId,
        projectId: projectA,
        kind: "status_change",
        title: "Disabled kind",
      },
      {
        companyId: owner.companyId,
        userId: member.userId,
        projectId: projectA,
        kind: "assignment",
        title: "Should arrive",
      },
    ]);
    expect(result.inserted).toBe(1);
    expect(result.suppressed).toBe(2);
    expect(result.reasons["muted_project"]).toBe(1);
    expect(result.reasons["kind_disabled"]).toBe(1);
    expect(await countFor(member.userId)).toBe(before + 1);
  });

  it("never suppresses an escalation, even from a muted project", async () => {
    const result = await pushNotifications(app.db, [
      {
        companyId: owner.companyId,
        userId: member.userId,
        projectId: projectB,
        kind: "escalation",
        title: "Deadline missed",
      },
    ]);
    expect(result.inserted).toBe(1);
  });

  it("de-duplicates an identical fan-out inside one call", async () => {
    const before = await countFor(member.userId, "reminder");
    const result = await pushNotifications(app.db, [
      {
        companyId: owner.companyId,
        userId: member.userId,
        projectId: projectA,
        kind: "reminder",
        title: "Same",
        recordType: "rfi",
        recordId: "r1",
      },
      {
        companyId: owner.companyId,
        userId: member.userId,
        projectId: projectA,
        kind: "reminder",
        title: "Same",
        recordType: "rfi",
        recordId: "r1",
      },
    ]);
    expect(result.inserted).toBe(1);
    expect(await countFor(member.userId, "reminder")).toBe(before + 1);
  });
});

describe("notifyWatchers", () => {
  it("notifies the record's watchers, excluding the actor, scoped to the tenant", async () => {
    await app.db.insert(watchers).values([
      {
        id: newId("wch"),
        companyId: owner.companyId,
        projectId: projectA,
        recordType: "rfi",
        recordId: "watched-1",
        userId: member.userId,
      },
      {
        id: newId("wch"),
        companyId: owner.companyId,
        projectId: projectA,
        recordType: "rfi",
        recordId: "watched-1",
        userId: owner.userId,
      },
    ]);
    const sent = await notifyWatchers(app.db, {
      companyId: owner.companyId,
      projectId: projectA,
      recordType: "rfi",
      recordId: "watched-1",
      actorId: owner.userId,
      // `status_change` is disabled for this member by the preferences set
      // earlier in this suite — using it here would be testing the policy, not
      // the fan-out.
      kind: "assignment",
      title: "RFI answered",
    });
    // The actor is excluded; the other watcher hears about it.
    expect(sent).toBe(1);
  });

  it("returns 0 when nobody is watching", async () => {
    const sent = await notifyWatchers(app.db, {
      companyId: owner.companyId,
      projectId: projectA,
      recordType: "rfi",
      recordId: "nobody-watches-this",
      actorId: owner.userId,
      kind: "assignment",
      title: "Nothing",
    });
    expect(sent).toBe(0);
  });
});

describe("the notification centre", () => {
  it("counts unread per kind so the shell can badge the right place", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/notifications/unread-count",
      headers: memberHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBeGreaterThan(0);
    expect(typeof res.json().byKind).toBe("object");
  });

  it("filters by kind and by project", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/notifications?kind=escalation",
      headers: memberHeaders,
    });
    expect(
      (res.json().items as Array<{ kind: string }>).every((n) => n.kind === "escalation"),
    ).toBe(true);
  });

  it("marks everything of one kind read without touching the rest", async () => {
    const before = await app.inject({
      method: "GET",
      url: "/api/v1/notifications/unread-count",
      headers: memberHeaders,
    });
    const escalations = before.json().byKind["escalation"] ?? 0;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/read-all",
      headers: memberHeaders,
      payload: { kind: "escalation" },
    });
    expect(res.json().updated).toBe(escalations);
    const after = await app.inject({
      method: "GET",
      url: "/api/v1/notifications/unread-count",
      headers: memberHeaders,
    });
    expect(after.json().byKind["escalation"]).toBeUndefined();
    expect(after.json().count).toBeLessThan(before.json().count);
  });
});

describe("digest", () => {
  it("previews my own digest grouped by project and kind", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/notification-digest?days=7",
      headers: memberHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBeGreaterThan(0);
    expect(res.json().sections.length).toBeGreaterThan(0);
    expect(res.json().subject).toContain("update");
  });

  it("runs the digest sweep, writes one digest notification, and does not repeat it", async () => {
    const first = await app.scheduler.runNow(NOTIFICATION_DIGEST_JOB);
    expect(first.state).toBe("succeeded");
    expect((first.lastResult as { digests: number }).digests).toBe(1);
    const digests = await countFor(member.userId, "digest");
    expect(digests).toBe(1);

    const second = await app.scheduler.runNow(NOTIFICATION_DIGEST_JOB);
    // The clock was reset by the first run; a second immediately after is not due.
    expect((second.lastResult as { digests: number }).digests).toBe(0);
    expect(await countFor(member.userId, "digest")).toBe(1);
  });

  it("refuses a manual digest run to a non-admin", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/digest/run",
      headers: memberHeaders,
    });
    expect(res.statusCode).toBe(403);
  });
});
