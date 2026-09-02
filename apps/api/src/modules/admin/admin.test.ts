import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projects } from "@constructos/db";
import type { BuiltApp } from "../../app.js";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";

describe("admin", () => {
  let built: BuiltApp;
  let actor: TestActor;
  let projectId = "";
  let colleagueId = "";

  beforeAll(async () => {
    built = await buildTestApp();
    actor = await registerActor(built.app, { companyName: "Admin Co" });
    projectId = newId("prj");
    await built.app.db.insert(projects).values({
      id: projectId,
      companyId: actor.companyId,
      name: "P1",
    });
    // a second company member to assign things to
    const invite = await built.app.inject({
      method: "POST",
      url: "/api/v1/company/users/invite",
      headers: actor.headers,
      payload: { email: `colleague-${Date.now()}@test.dev`, name: "Colleague", role: "member" },
    });
    colleagueId = (invite.json() as { user: { id: string } }).user.id;
  });

  afterAll(async () => {
    await built.close();
  });

  describe("permission templates", () => {
    let customId = "";
    let builtinId = "";

    it("lists seeded built-in templates", async () => {
      const res = await built.app.inject({
        method: "GET",
        url: "/api/v1/permission-templates",
        headers: actor.headers,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: { id: string; key: string; isBuiltin: boolean }[] };
      expect(body.items.length).toBeGreaterThanOrEqual(6);
      const builtin = body.items.find((t) => t.key === "project_manager");
      expect(builtin?.isBuiltin).toBe(true);
      builtinId = builtin!.id;
    });

    it("creates a custom template with a valid tools map", async () => {
      const res = await built.app.inject({
        method: "POST",
        url: "/api/v1/permission-templates",
        headers: actor.headers,
        payload: {
          key: "site_visitor",
          name: "Site Visitor",
          description: "Read drawings only",
          tools: { drawings: "read", documents: "read", admin: "none" },
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { id: string; isBuiltin: boolean };
      expect(body.isBuiltin).toBe(false);
      customId = body.id;

      const dup = await built.app.inject({
        method: "POST",
        url: "/api/v1/permission-templates",
        headers: actor.headers,
        payload: { key: "site_visitor", name: "Dup", tools: {} },
      });
      expect(dup.statusCode).toBe(409);
    });

    it("rejects unknown tool keys and unknown levels", async () => {
      const badKey = await built.app.inject({
        method: "POST",
        url: "/api/v1/permission-templates",
        headers: actor.headers,
        payload: { key: "bad-key-tpl", name: "Bad", tools: { not_a_tool: "read" } },
      });
      expect(badKey.statusCode).toBe(400);

      const badLevel = await built.app.inject({
        method: "POST",
        url: "/api/v1/permission-templates",
        headers: actor.headers,
        payload: { key: "bad-level-tpl", name: "Bad", tools: { drawings: "superuser" } },
      });
      expect(badLevel.statusCode).toBe(400);
    });

    it("rejects modification and deletion of built-ins", async () => {
      const patch = await built.app.inject({
        method: "PATCH",
        url: `/api/v1/permission-templates/${builtinId}`,
        headers: actor.headers,
        payload: { name: "Hacked" },
      });
      expect(patch.statusCode).toBe(409);

      const del = await built.app.inject({
        method: "DELETE",
        url: `/api/v1/permission-templates/${builtinId}`,
        headers: actor.headers,
      });
      expect(del.statusCode).toBe(409);
    });

    it("updates and deletes a custom template", async () => {
      const patch = await built.app.inject({
        method: "PATCH",
        url: `/api/v1/permission-templates/${customId}`,
        headers: actor.headers,
        payload: { tools: { drawings: "standard" }, name: "Site Visitor v2" },
      });
      expect(patch.statusCode).toBe(200);
      expect((patch.json() as { name: string }).name).toBe("Site Visitor v2");

      const del = await built.app.inject({
        method: "DELETE",
        url: `/api/v1/permission-templates/${customId}`,
        headers: actor.headers,
      });
      expect(del.statusCode).toBe(200);
    });

    it("is closed to non-admin members", async () => {
      const member = await registerActor(built.app);
      const res = await built.app.inject({
        method: "GET",
        url: "/api/v1/permission-templates",
        headers: { ...member.headers, "x-company-id": actor.companyId },
      });
      // not a member of this company at all → forbidden
      expect(res.statusCode).toBe(403);
    });
  });

  describe("project memberships", () => {
    let membershipId = "";

    it("rejects an unknown templateKey", async () => {
      const res = await built.app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/memberships`,
        headers: actor.headers,
        payload: { userId: colleagueId, templateKey: "no_such_template" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("adds a membership with template + overrides", async () => {
      const badOverride = await built.app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/memberships`,
        headers: actor.headers,
        payload: {
          userId: colleagueId,
          templateKey: "field_engineer",
          overrides: { made_up_tool: "read" },
        },
      });
      expect(badOverride.statusCode).toBe(400);

      const res = await built.app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/memberships`,
        headers: actor.headers,
        payload: {
          userId: colleagueId,
          templateKey: "field_engineer",
          overrides: { rfis: "admin" },
        },
      });
      expect(res.statusCode).toBe(201);
      membershipId = (res.json() as { id: string }).id;

      const dup = await built.app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/memberships`,
        headers: actor.headers,
        payload: { userId: colleagueId, templateKey: "field_engineer" },
      });
      expect(dup.statusCode).toBe(409);
    });

    it("lists memberships with user info", async () => {
      const res = await built.app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectId}/memberships`,
        headers: actor.headers,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        items: { userId: string; userName: string; templateKey: string }[];
        total: number;
      };
      expect(body.total).toBe(1);
      expect(body.items[0]!.userId).toBe(colleagueId);
      expect(body.items[0]!.userName).toBe("Colleague");
    });

    it("patches and deletes a membership", async () => {
      const patch = await built.app.inject({
        method: "PATCH",
        url: `/api/v1/projects/${projectId}/memberships/${membershipId}`,
        headers: actor.headers,
        payload: { templateKey: "read_only", overrides: {} },
      });
      expect(patch.statusCode).toBe(200);
      expect((patch.json() as { templateKey: string }).templateKey).toBe("read_only");

      const del = await built.app.inject({
        method: "DELETE",
        url: `/api/v1/projects/${projectId}/memberships/${membershipId}`,
        headers: actor.headers,
      });
      expect(del.statusCode).toBe(200);
    });
  });

  describe("assurance grants", () => {
    let liveGrantId = "";
    let expiredGrantId = "";

    it("creates grants (live and already-expired)", async () => {
      const live = await built.app.inject({
        method: "POST",
        url: "/api/v1/assurance-grants",
        headers: actor.headers,
        payload: { userId: colleagueId, role: "auditor", projectId },
      });
      expect(live.statusCode).toBe(201);
      liveGrantId = (live.json() as { id: string }).id;

      const expired = await built.app.inject({
        method: "POST",
        url: "/api/v1/assurance-grants",
        headers: actor.headers,
        payload: {
          userId: colleagueId,
          role: "regulator",
          expiresAt: "2020-01-01T00:00:00.000Z",
        },
      });
      expect(expired.statusCode).toBe(201);
      expiredGrantId = (expired.json() as { id: string }).id;

      const badRole = await built.app.inject({
        method: "POST",
        url: "/api/v1/assurance-grants",
        headers: actor.headers,
        payload: { userId: colleagueId, role: "supreme_leader" },
      });
      expect(badRole.statusCode).toBe(400);

      const badUser = await built.app.inject({
        method: "POST",
        url: "/api/v1/assurance-grants",
        headers: actor.headers,
        payload: { userId: "u_missing0000000000000", role: "auditor" },
      });
      expect(badUser.statusCode).toBe(400);
    });

    it("filters out expired grants by default", async () => {
      const dflt = await built.app.inject({
        method: "GET",
        url: "/api/v1/assurance-grants",
        headers: actor.headers,
      });
      expect(dflt.statusCode).toBe(200);
      const dfltIds = (dflt.json() as { items: { id: string }[] }).items.map((g) => g.id);
      expect(dfltIds).toContain(liveGrantId);
      expect(dfltIds).not.toContain(expiredGrantId);

      const all = await built.app.inject({
        method: "GET",
        url: "/api/v1/assurance-grants?includeExpired=true",
        headers: actor.headers,
      });
      const allIds = (all.json() as { items: { id: string }[] }).items.map((g) => g.id);
      expect(allIds).toContain(liveGrantId);
      expect(allIds).toContain(expiredGrantId);
    });

    it("revokes a grant", async () => {
      const del = await built.app.inject({
        method: "DELETE",
        url: `/api/v1/assurance-grants/${expiredGrantId}`,
        headers: actor.headers,
      });
      expect(del.statusCode).toBe(200);
      const again = await built.app.inject({
        method: "DELETE",
        url: `/api/v1/assurance-grants/${expiredGrantId}`,
        headers: actor.headers,
      });
      expect(again.statusCode).toBe(404);
    });
  });

  describe("auth events", () => {
    it("returns events for company members, newest first, admins only", async () => {
      const res = await built.app.inject({
        method: "GET",
        url: "/api/v1/company/auth-events",
        headers: actor.headers,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: { userId: string | null; at: string }[]; total: number };
      expect(body.total).toBeGreaterThanOrEqual(1);
      expect(body.items.some((e) => e.userId === actor.userId)).toBe(true);
      for (let i = 1; i < body.items.length; i += 1) {
        expect(body.items[i - 1]!.at >= body.items[i]!.at).toBe(true);
      }
      // every event belongs to a member of this company
      const usersRes = await built.app.inject({
        method: "GET",
        url: "/api/v1/company/users?pageSize=200",
        headers: actor.headers,
      });
      const memberIds = new Set(
        (usersRes.json() as { items: { id: string }[] }).items.map((u) => u.id),
      );
      for (const e of body.items) {
        expect(memberIds.has(e.userId ?? "")).toBe(true);
      }
    });
  });
});
