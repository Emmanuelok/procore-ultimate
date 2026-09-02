import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { pushNotifications } from "./service.js";

let built: BuiltApp;
let actor: TestActor;
let other: TestActor;

beforeAll(async () => {
  built = await buildTestApp();
  actor = await registerActor(built.app);
  other = await registerActor(built.app);
  await pushNotifications(built.app.db, [
    {
      companyId: actor.companyId,
      userId: actor.userId,
      kind: "assignment",
      title: "RFI-001 assigned to you",
      recordType: "rfi",
      recordId: "rfi_x",
    },
    {
      companyId: actor.companyId,
      userId: actor.userId,
      kind: "workflow_step",
      title: "Workflow step assigned: PM review",
    },
    {
      companyId: actor.companyId,
      userId: actor.userId,
      kind: "status_change",
      title: "Punch item #4 ready for review",
    },
    // duplicate of the first — must be deduplicated within the call
    {
      companyId: actor.companyId,
      userId: actor.userId,
      kind: "assignment",
      title: "RFI-001 assigned to you",
      recordType: "rfi",
      recordId: "rfi_x",
    },
    // another tenant's notification must never leak into actor's feed
    {
      companyId: other.companyId,
      userId: other.userId,
      kind: "system",
      title: "Other tenant",
    },
  ]);
});

afterAll(async () => {
  await built.close();
});

describe("notifications", () => {
  it("lists my notifications newest first, deduplicated and tenant-scoped", async () => {
    const res = await built.app.inject({
      method: "GET",
      url: "/api/v1/notifications",
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(3);
    expect(body.items.every((n: any) => n.userId === actor.userId)).toBe(true);
  });

  it("counts unread, marks a single one read, filters unread", async () => {
    const countRes = await built.app.inject({
      method: "GET",
      url: "/api/v1/notifications/unread-count",
      headers: actor.headers,
    });
    expect(countRes.json().count).toBe(3);

    const list = await built.app.inject({
      method: "GET",
      url: "/api/v1/notifications",
      headers: actor.headers,
    });
    const first = list.json().items[0];
    const read = await built.app.inject({
      method: "POST",
      url: `/api/v1/notifications/${first.id}/read`,
      headers: actor.headers,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().readAt).toBeTruthy();

    const unread = await built.app.inject({
      method: "GET",
      url: "/api/v1/notifications?unread=true",
      headers: actor.headers,
    });
    expect(unread.json().total).toBe(2);
  });

  it("cannot read another user's notification", async () => {
    const list = await built.app.inject({
      method: "GET",
      url: "/api/v1/notifications",
      headers: other.headers,
    });
    const theirId = list.json().items[0].id;
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/notifications/${theirId}/read`,
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it("read-all clears the remainder", async () => {
    const res = await built.app.inject({
      method: "POST",
      url: "/api/v1/notifications/read-all",
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().updated).toBe(2);

    const countRes = await built.app.inject({
      method: "GET",
      url: "/api/v1/notifications/unread-count",
      headers: actor.headers,
    });
    expect(countRes.json().count).toBe(0);
  });
});
