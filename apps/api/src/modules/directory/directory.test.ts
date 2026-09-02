import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, and } from "drizzle-orm";
import { contacts, ledgerEntries } from "@constructos/db";
import type { BuiltApp } from "../../app.js";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";

describe("directory", () => {
  let built: BuiltApp;
  let actor: TestActor;

  beforeAll(async () => {
    built = await buildTestApp();
    actor = await registerActor(built.app, { companyName: "Directory Co" });
  });

  afterAll(async () => {
    await built.close();
  });

  describe("vendors", () => {
    let vendorA = "";
    let vendorB = "";
    let contactId = "";

    it("creates vendors", async () => {
      const resA = await built.app.inject({
        method: "POST",
        url: "/api/v1/vendors",
        headers: actor.headers,
        payload: {
          name: "Alpha Electrical Ltd",
          tradeCodes: ["26-electrical"],
          city: "London",
          email: "office@alpha-electrical.test",
        },
      });
      expect(resA.statusCode).toBe(201);
      vendorA = (resA.json() as { id: string }).id;

      const resB = await built.app.inject({
        method: "POST",
        url: "/api/v1/vendors",
        headers: actor.headers,
        payload: { name: "Alpha Electrical (duplicate entry)", tradeCodes: ["26-electrical"] },
      });
      expect(resB.statusCode).toBe(201);
      vendorB = (resB.json() as { id: string }).id;
    });

    it("lists with search and tradeCode filter", async () => {
      const bySearch = await built.app.inject({
        method: "GET",
        url: "/api/v1/vendors?search=alpha",
        headers: actor.headers,
      });
      expect(bySearch.statusCode).toBe(200);
      expect((bySearch.json() as { total: number }).total).toBe(2);

      const byTrade = await built.app.inject({
        method: "GET",
        url: "/api/v1/vendors?tradeCode=26-electrical",
        headers: actor.headers,
      });
      expect((byTrade.json() as { total: number }).total).toBe(2);

      const noMatch = await built.app.inject({
        method: "GET",
        url: "/api/v1/vendors?tradeCode=22-plumbing",
        headers: actor.headers,
      });
      expect((noMatch.json() as { total: number }).total).toBe(0);
    });

    it("reads and updates a vendor", async () => {
      const patch = await built.app.inject({
        method: "PATCH",
        url: `/api/v1/vendors/${vendorA}`,
        headers: actor.headers,
        payload: { phone: "+44 20 7946 0000", status: "active" },
      });
      expect(patch.statusCode).toBe(200);
      expect((patch.json() as { phone: string }).phone).toBe("+44 20 7946 0000");

      const get = await built.app.inject({
        method: "GET",
        url: `/api/v1/vendors/${vendorA}`,
        headers: actor.headers,
      });
      expect(get.statusCode).toBe(200);
    });

    it("does not leak vendors across tenants", async () => {
      const other = await registerActor(built.app);
      const res = await built.app.inject({
        method: "GET",
        url: `/api/v1/vendors/${vendorA}`,
        headers: other.headers,
      });
      expect(res.statusCode).toBe(404);
    });

    it("merges vendor B into vendor A, reassigning contacts", async () => {
      const contactRes = await built.app.inject({
        method: "POST",
        url: "/api/v1/contacts",
        headers: actor.headers,
        payload: { name: "Bob Sparks", vendorId: vendorB, email: "bob@dup.test" },
      });
      expect(contactRes.statusCode).toBe(201);
      contactId = (contactRes.json() as { id: string }).id;

      const selfMerge = await built.app.inject({
        method: "POST",
        url: `/api/v1/vendors/${vendorB}/merge`,
        headers: actor.headers,
        payload: { intoVendorId: vendorB },
      });
      expect(selfMerge.statusCode).toBe(400);

      const merge = await built.app.inject({
        method: "POST",
        url: `/api/v1/vendors/${vendorB}/merge`,
        headers: actor.headers,
        payload: { intoVendorId: vendorA },
      });
      expect(merge.statusCode).toBe(200);
      const merged = merge.json() as { status: string; mergedIntoId: string };
      expect(merged.status).toBe("merged");
      expect(merged.mergedIntoId).toBe(vendorA);

      // contact reassigned to the surviving vendor
      const [contact] = await built.app.db
        .select()
        .from(contacts)
        .where(eq(contacts.id, contactId));
      expect(contact!.vendorId).toBe(vendorA);

      // merged vendor excluded from the default list, included on demand
      const dflt = await built.app.inject({
        method: "GET",
        url: "/api/v1/vendors",
        headers: actor.headers,
      });
      const dfltIds = (dflt.json() as { items: { id: string }[] }).items.map((v) => v.id);
      expect(dfltIds).not.toContain(vendorB);
      const all = await built.app.inject({
        method: "GET",
        url: "/api/v1/vendors?includeMerged=true",
        headers: actor.headers,
      });
      const allIds = (all.json() as { items: { id: string }[] }).items.map((v) => v.id);
      expect(allIds).toContain(vendorB);

      // a merged vendor can no longer be edited or re-merged
      const editMerged = await built.app.inject({
        method: "PATCH",
        url: `/api/v1/vendors/${vendorB}`,
        headers: actor.headers,
        payload: { notes: "nope" },
      });
      expect(editMerged.statusCode).toBe(409);

      // ledger entries exist for both sides of the merge
      const entries = await built.app.db
        .select()
        .from(ledgerEntries)
        .where(
          and(eq(ledgerEntries.companyId, actor.companyId), eq(ledgerEntries.objectType, "vendor")),
        );
      const ids = entries.map((e) => e.objectId);
      expect(ids).toContain(vendorA);
      expect(ids).toContain(vendorB);
      expect(entries.some((e) => e.action === "state_change" && e.objectId === vendorB)).toBe(true);
    });

    it("deletes a vendor (owner/admin only)", async () => {
      const res = await built.app.inject({
        method: "POST",
        url: "/api/v1/vendors",
        headers: actor.headers,
        payload: { name: "Short-lived Vendor" },
      });
      const id = (res.json() as { id: string }).id;
      const del = await built.app.inject({
        method: "DELETE",
        url: `/api/v1/vendors/${id}`,
        headers: actor.headers,
      });
      expect(del.statusCode).toBe(200);
      const get = await built.app.inject({
        method: "GET",
        url: `/api/v1/vendors/${id}`,
        headers: actor.headers,
      });
      expect(get.statusCode).toBe(404);
    });
  });

  describe("contacts", () => {
    it("CRUDs a contact and filters by vendorId", async () => {
      const create = await built.app.inject({
        method: "POST",
        url: "/api/v1/contacts",
        headers: actor.headers,
        payload: { name: "Carla Mason", email: "carla@site.test", title: "QS" },
      });
      expect(create.statusCode).toBe(201);
      const id = (create.json() as { id: string }).id;

      const badVendor = await built.app.inject({
        method: "POST",
        url: "/api/v1/contacts",
        headers: actor.headers,
        payload: { name: "Ghost", vendorId: "vnd_doesnotexist000000000" },
      });
      expect(badVendor.statusCode).toBe(400);

      const patch = await built.app.inject({
        method: "PATCH",
        url: `/api/v1/contacts/${id}`,
        headers: actor.headers,
        payload: { title: "Senior QS" },
      });
      expect(patch.statusCode).toBe(200);
      expect((patch.json() as { title: string }).title).toBe("Senior QS");

      const list = await built.app.inject({
        method: "GET",
        url: "/api/v1/contacts?search=carla",
        headers: actor.headers,
      });
      expect((list.json() as { total: number }).total).toBe(1);

      const del = await built.app.inject({
        method: "DELETE",
        url: `/api/v1/contacts/${id}`,
        headers: actor.headers,
      });
      expect(del.statusCode).toBe(200);
    });
  });

  describe("distribution groups", () => {
    let groupId = "";

    it("creates a group and rejects duplicates", async () => {
      const create = await built.app.inject({
        method: "POST",
        url: "/api/v1/distribution-groups",
        headers: actor.headers,
        payload: { name: "Site Team" },
      });
      expect(create.statusCode).toBe(201);
      groupId = (create.json() as { id: string }).id;

      const dup = await built.app.inject({
        method: "POST",
        url: "/api/v1/distribution-groups",
        headers: actor.headers,
        payload: { name: "Site Team" },
      });
      expect(dup.statusCode).toBe(409);
    });

    it("adds and removes members of each shape", async () => {
      const contactRes = await built.app.inject({
        method: "POST",
        url: "/api/v1/contacts",
        headers: actor.headers,
        payload: { name: "Distribution Contact" },
      });
      const contactId = (contactRes.json() as { id: string }).id;

      const byUser = await built.app.inject({
        method: "POST",
        url: `/api/v1/distribution-groups/${groupId}/members`,
        headers: actor.headers,
        payload: { userId: actor.userId },
      });
      expect(byUser.statusCode).toBe(201);

      const byContact = await built.app.inject({
        method: "POST",
        url: `/api/v1/distribution-groups/${groupId}/members`,
        headers: actor.headers,
        payload: { contactId },
      });
      expect(byContact.statusCode).toBe(201);

      const byEmail = await built.app.inject({
        method: "POST",
        url: `/api/v1/distribution-groups/${groupId}/members`,
        headers: actor.headers,
        payload: { email: "external@partner.test" },
      });
      expect(byEmail.statusCode).toBe(201);
      const memberId = (byEmail.json() as { id: string }).id;

      const both = await built.app.inject({
        method: "POST",
        url: `/api/v1/distribution-groups/${groupId}/members`,
        headers: actor.headers,
        payload: { userId: actor.userId, email: "two@things.test" },
      });
      expect(both.statusCode).toBe(400);

      const detail = await built.app.inject({
        method: "GET",
        url: `/api/v1/distribution-groups/${groupId}`,
        headers: actor.headers,
      });
      expect((detail.json() as { members: unknown[] }).members).toHaveLength(3);

      const list = await built.app.inject({
        method: "GET",
        url: "/api/v1/distribution-groups",
        headers: actor.headers,
      });
      const listed = (list.json() as { items: { id: string; memberCount: number }[] }).items;
      expect(listed.find((g) => g.id === groupId)?.memberCount).toBe(3);

      const remove = await built.app.inject({
        method: "DELETE",
        url: `/api/v1/distribution-groups/${groupId}/members/${memberId}`,
        headers: actor.headers,
      });
      expect(remove.statusCode).toBe(200);
    });

    it("renames and deletes a group", async () => {
      const patch = await built.app.inject({
        method: "PATCH",
        url: `/api/v1/distribution-groups/${groupId}`,
        headers: actor.headers,
        payload: { name: "Site Team (Weekly)" },
      });
      expect(patch.statusCode).toBe(200);
      const del = await built.app.inject({
        method: "DELETE",
        url: `/api/v1/distribution-groups/${groupId}`,
        headers: actor.headers,
      });
      expect(del.statusCode).toBe(200);
    });
  });

  describe("company users & invites", () => {
    const invitedEmail = `invitee-${Date.now()}@test.dev`;
    let invitedUserId = "";
    let tempPassword = "";

    it("lists company users with roles", async () => {
      const res = await built.app.inject({
        method: "GET",
        url: "/api/v1/company/users",
        headers: actor.headers,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: { id: string; role: string }[] };
      expect(body.items.some((u) => u.id === actor.userId && u.role === "owner")).toBe(true);
    });

    it("invites a brand-new user and returns a temp password once", async () => {
      const res = await built.app.inject({
        method: "POST",
        url: "/api/v1/company/users/invite",
        headers: actor.headers,
        payload: { email: invitedEmail, name: "New Invitee", role: "member" },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as {
        user: { id: string };
        tempPassword?: string;
        existingUser: boolean;
      };
      expect(body.existingUser).toBe(false);
      expect(body.tempPassword).toBeTruthy();
      expect(body.tempPassword!.length).toBe(16);
      invitedUserId = body.user.id;
      tempPassword = body.tempPassword!;

      // the temp password actually works
      const login = await built.app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: invitedEmail, password: tempPassword },
      });
      expect(login.statusCode).toBe(200);
    });

    it("re-inviting the same user to the same company conflicts", async () => {
      const res = await built.app.inject({
        method: "POST",
        url: "/api/v1/company/users/invite",
        headers: actor.headers,
        payload: { email: invitedEmail, name: "New Invitee", role: "member" },
      });
      expect(res.statusCode).toBe(409);
    });

    it("inviting an existing user to another company adds a membership without a temp password", async () => {
      const other = await registerActor(built.app, { companyName: "Second Co" });
      const res = await built.app.inject({
        method: "POST",
        url: "/api/v1/company/users/invite",
        headers: other.headers,
        payload: { email: invitedEmail, name: "Ignored", role: "guest" },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { existingUser: boolean; tempPassword?: string };
      expect(body.existingUser).toBe(true);
      expect(body.tempPassword).toBeUndefined();

      const list = await built.app.inject({
        method: "GET",
        url: "/api/v1/company/users",
        headers: other.headers,
      });
      const items = (list.json() as { items: { id: string; role: string }[] }).items;
      expect(items.some((u) => u.id === invitedUserId && u.role === "guest")).toBe(true);
    });

    it("members can write directory records, guests cannot", async () => {
      const login = await built.app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: invitedEmail, password: tempPassword },
      });
      const { accessToken } = login.json() as { accessToken: string };
      const memberHeaders = {
        authorization: `Bearer ${accessToken}`,
        "x-company-id": actor.companyId,
      };
      const asMember = await built.app.inject({
        method: "POST",
        url: "/api/v1/vendors",
        headers: memberHeaders,
        payload: { name: "Member-created Vendor" },
      });
      expect(asMember.statusCode).toBe(201);

      // member cannot use owner/admin surfaces
      const invite = await built.app.inject({
        method: "POST",
        url: "/api/v1/company/users/invite",
        headers: memberHeaders,
        payload: { email: "x@y.test", name: "X", role: "member" },
      });
      expect(invite.statusCode).toBe(403);
    });

    it("protects the last owner from demotion and removal", async () => {
      const demote = await built.app.inject({
        method: "PATCH",
        url: `/api/v1/company/users/${actor.userId}/role`,
        headers: actor.headers,
        payload: { role: "member" },
      });
      expect(demote.statusCode).toBe(409);

      const remove = await built.app.inject({
        method: "DELETE",
        url: `/api/v1/company/users/${actor.userId}`,
        headers: actor.headers,
      });
      expect(remove.statusCode).toBe(409);

      // promote the invited member to owner, then demotion of the original owner is allowed
      const promote = await built.app.inject({
        method: "PATCH",
        url: `/api/v1/company/users/${invitedUserId}/role`,
        headers: actor.headers,
        payload: { role: "owner" },
      });
      expect(promote.statusCode).toBe(200);

      const demote2 = await built.app.inject({
        method: "PATCH",
        url: `/api/v1/company/users/${actor.userId}/role`,
        headers: actor.headers,
        payload: { role: "admin" },
      });
      expect(demote2.statusCode).toBe(200);

      // now the invited user is the last owner
      const removeLast = await built.app.inject({
        method: "DELETE",
        url: `/api/v1/company/users/${invitedUserId}`,
        headers: actor.headers,
      });
      expect(removeLast.statusCode).toBe(409);
    });
  });
});
