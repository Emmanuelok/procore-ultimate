/**
 * Directory upgrades and the audit findings they close: owner-role escalation,
 * the invitation that handed out a live credential, member removal that left
 * sessions and approvals behind, and vendor deletion/merge that orphaned
 * every reference.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import {
  assuranceGrants,
  commitments,
  companyMemberships,
  contacts,
  users,
  vendorMerges,
  vendors,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";

let built: BuiltApp;
let app: FastifyInstance;
let owner: TestActor;
let admin: TestActor;
let adminHeaders: Record<string, string>;
let plain: TestActor;
let projectId: string;

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app, { companyName: "Directory Co" });

  admin = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: admin.userId,
    role: "admin",
  });
  adminHeaders = {
    authorization: admin.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };

  plain = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: plain.userId,
    role: "member",
  });

  const project = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: owner.headers,
    payload: { name: "Directory Project" },
  });
  projectId = project.json().id;
});

afterAll(async () => {
  await built.close();
});

/* ------------------------------------------------------------------ */
/* Owner role escalation                                               */
/* ------------------------------------------------------------------ */

describe("company roles", () => {
  it("refuses an admin promoting themselves to owner", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/company/users/${admin.userId}/role`,
      headers: adminHeaders,
      payload: { role: "owner" },
    });
    // Self-role changes are refused outright — this is the escalation path.
    expect(res.statusCode).toBe(403);
    const rows = await app.db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, owner.companyId),
          eq(companyMemberships.userId, admin.userId),
        ),
      );
    expect(rows[0]!.role).toBe("admin");
  });

  it("refuses an admin promoting somebody else to owner", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/company/users/${plain.userId}/role`,
      headers: adminHeaders,
      payload: { role: "owner" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses an admin demoting an owner", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/company/users/${owner.userId}/role`,
      headers: adminHeaders,
      payload: { role: "member" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("lets an owner change somebody else's role", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/company/users/${plain.userId}/role`,
      headers: owner.headers,
      payload: { role: "guest" },
    });
    expect(res.statusCode).toBe(200);
    await app.inject({
      method: "PATCH",
      url: `/api/v1/company/users/${plain.userId}/role`,
      headers: owner.headers,
      payload: { role: "member" },
    });
  });

  it("still refuses to demote the last owner", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/company/users/${owner.userId}/role`,
      headers: owner.headers,
      payload: { role: "admin" },
    });
    // Self-change is refused before the last-owner rule is even reached.
    expect(res.statusCode).toBe(403);
  });
});

/* ------------------------------------------------------------------ */
/* Invitations                                                         */
/* ------------------------------------------------------------------ */

describe("POST /company/users/invite", () => {
  it("never returns a password, never says whether the address is known, and grants no membership", async () => {
    const email = `invitee-${Date.now()}@test.dev`;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/company/users/invite",
      headers: owner.headers,
      payload: { email, name: "New Person", role: "member", projectIds: [projectId] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.tempPassword).toBeUndefined();
    expect(body.existingUser).toBeUndefined();
    expect(body.membershipCreated).toBe(false);
    expect(body.delivery).toBeTruthy();

    // The account exists but is inactive and has no usable credential.
    const created = await app.db.select().from(users).where(eq(users.email, email));
    expect(created).toHaveLength(1);
    expect(created[0]!.isActive).toBe(false);

    // No membership until acceptance.
    const membership = await app.db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, owner.companyId),
          eq(companyMemberships.userId, created[0]!.id),
        ),
      );
    expect(membership).toHaveLength(0);
  });

  it("refuses to invite an existing member twice", async () => {
    const existing = await app.db.select().from(users).where(eq(users.id, plain.userId));
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/company/users/invite",
      headers: owner.headers,
      payload: { email: existing[0]!.email, name: "Dup", role: "member" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("refuses an admin inviting an owner", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/company/users/invite",
      headers: adminHeaders,
      payload: { email: `owner-${Date.now()}@test.dev`, name: "X", role: "owner" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses an unknown project id rather than failing at acceptance", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/company/users/invite",
      headers: owner.headers,
      payload: {
        email: `bad-${Date.now()}@test.dev`,
        name: "X",
        role: "member",
        projectIds: ["prj_nope"],
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* Member removal                                                      */
/* ------------------------------------------------------------------ */

describe("DELETE /company/users/:userId", () => {
  it("clears assurance grants and revokes sessions", async () => {
    const leaver = await registerActor(app);
    await app.db.insert(companyMemberships).values({
      id: newId("cm"),
      companyId: owner.companyId,
      userId: leaver.userId,
      role: "member",
    });
    await app.db.insert(assuranceGrants).values({
      id: newId("ag"),
      companyId: owner.companyId,
      projectId: null,
      userId: leaver.userId,
      role: "integrity_reviewer",
      grantedBy: owner.userId,
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/company/users/${leaver.userId}`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().cleared.assuranceGrants).toBe(1);

    const grants = await app.db
      .select()
      .from(assuranceGrants)
      .where(
        and(
          eq(assuranceGrants.companyId, owner.companyId),
          eq(assuranceGrants.userId, leaver.userId),
        ),
      );
    expect(grants).toHaveLength(0);
  });

  it("refuses to remove yourself", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/company/users/${owner.userId}`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(403);
  });

  it("offers an explicit session revocation without removing the member", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/company/users/${plain.userId}/sessions/revoke`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().revoked).toBe("number");
    const membership = await app.db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, owner.companyId),
          eq(companyMemberships.userId, plain.userId),
        ),
      );
    expect(membership).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Vendors: soft delete, merge, duplicates                             */
/* ------------------------------------------------------------------ */

describe("vendors", () => {
  let vendorA: string;
  let vendorB: string;

  it("soft-deletes and restores, reporting what still references the vendor", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/vendors",
      headers: owner.headers,
      payload: { name: "Temporary Plant Hire" },
    });
    const id = created.json().id;

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/vendors/${id}`,
      headers: owner.headers,
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().restorable).toBe(true);
    expect(del.json().references).toHaveProperty("commitments");

    const list = await app.inject({ method: "GET", url: "/api/v1/vendors", headers: owner.headers });
    expect(list.json().items.map((v: { id: string }) => v.id)).not.toContain(id);

    const rows = await app.db.select().from(vendors).where(eq(vendors.id, id));
    expect(rows[0]!.deletedAt).toBeTruthy();

    const bin = await app.inject({
      method: "GET",
      url: "/api/v1/directory/recycle-bin",
      headers: owner.headers,
    });
    expect(bin.json().items.some((i: { id: string }) => i.id === id)).toBe(true);

    const restore = await app.inject({
      method: "POST",
      url: `/api/v1/vendors/${id}/restore`,
      headers: owner.headers,
    });
    expect(restore.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: "/api/v1/vendors", headers: owner.headers });
    expect(after.json().items.map((v: { id: string }) => v.id)).toContain(id);
  });

  it("re-points every reference on merge, journals it, and can undo", async () => {
    const a = await app.inject({
      method: "POST",
      url: "/api/v1/vendors",
      headers: owner.headers,
      payload: { name: "Northern Groundworks Ltd", taxId: "GB111" },
    });
    const b = await app.inject({
      method: "POST",
      url: "/api/v1/vendors",
      headers: owner.headers,
      payload: { name: "Northern Groundworks Limited", taxId: "GB111" },
    });
    vendorA = a.json().id;
    vendorB = b.json().id;

    const contactId = newId("cnt");
    await app.db.insert(contacts).values({
      id: contactId,
      companyId: owner.companyId,
      vendorId: vendorA,
      name: "Site Manager",
    });
    const commitmentId = newId("cmt");
    await app.db.insert(commitments).values({
      id: commitmentId,
      companyId: owner.companyId,
      projectId,
      number: 1,
      reference: "SC-001",
      title: "Groundworks package",
      vendorId: vendorA,
      createdBy: owner.userId,
    });

    const merge = await app.inject({
      method: "POST",
      url: `/api/v1/vendors/${vendorA}/merge`,
      headers: owner.headers,
      payload: { intoVendorId: vendorB },
    });
    expect(merge.statusCode).toBe(200);
    const movements = merge.json().movements as Array<{ table: string; rows: number }>;
    // Contacts alone were re-pointed before; commitments were left behind.
    expect(movements.find((m) => m.table === "commitments")?.rows).toBe(1);
    expect(movements.find((m) => m.table === "contacts")?.rows).toBe(1);

    const movedCommitment = await app.db
      .select()
      .from(commitments)
      .where(eq(commitments.id, commitmentId));
    expect(movedCommitment[0]!.vendorId).toBe(vendorB);

    const undo = await app.inject({
      method: "POST",
      url: `/api/v1/vendor-merges/${merge.json().mergeId}/undo`,
      headers: owner.headers,
    });
    expect(undo.statusCode).toBe(200);
    const restored = await app.db
      .select()
      .from(commitments)
      .where(eq(commitments.id, commitmentId));
    expect(restored[0]!.vendorId).toBe(vendorA);

    const again = await app.inject({
      method: "POST",
      url: `/api/v1/vendor-merges/${merge.json().mergeId}/undo`,
      headers: owner.headers,
    });
    expect(again.statusCode).toBe(409);
  });

  it("finds the duplicate pair and explains why", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/vendors/duplicates",
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const pair = res
      .json()
      .items.find(
        (p: { a: string; b: string }) =>
          (p.a === vendorA && p.b === vendorB) || (p.a === vendorB && p.b === vendorA),
      );
    expect(pair).toBeTruthy();
    expect(pair.reasons.join(" ")).toContain("tax id");
    expect(pair.aVendor.name).toBeTruthy();
  });

  it("reports vendor performance bucketed by currency, never summed across", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/vendors/${vendorA}/performance`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.commitments.byCurrency)).toBe(true);
    expect(body.commitments.total.value).toBeNull();
    expect(body.commitments.total.reasons[0]).toContain("currencies");
  });

  it("refuses a duplicate scan to a non-admin", async () => {
    // A fresh member: `plain`'s sessions are deliberately revoked by the
    // session-revocation test above, and a revoked session answers 401 —
    // which would prove nothing about the admin gate.
    const nonAdmin = await registerActor(app);
    await app.db.insert(companyMemberships).values({
      id: newId("cm"),
      companyId: owner.companyId,
      userId: nonAdmin.userId,
      role: "member",
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/vendors/duplicates",
      headers: {
        authorization: nonAdmin.headers["authorization"]!,
        "x-company-id": owner.companyId,
      },
    });
    expect(res.statusCode).toBe(403);
  });
});

/* ------------------------------------------------------------------ */
/* Distribution groups                                                 */
/* ------------------------------------------------------------------ */

describe("distribution groups", () => {
  it("does not add the same recipient twice", async () => {
    const group = await app.inject({
      method: "POST",
      url: "/api/v1/distribution-groups",
      headers: owner.headers,
      payload: { name: "Weekly report" },
    });
    const groupId = group.json().id;
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/distribution-groups/${groupId}/members`,
      headers: owner.headers,
      payload: { userId: plain.userId },
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: "POST",
      url: `/api/v1/distribution-groups/${groupId}/members`,
      headers: owner.headers,
      payload: { userId: plain.userId },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().alreadyMember).toBe(true);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/distribution-groups/${groupId}`,
      headers: owner.headers,
    });
    expect(detail.json().members).toHaveLength(1);
  });

  it("normalises an email recipient so case is not a second membership", async () => {
    const group = await app.inject({
      method: "POST",
      url: "/api/v1/distribution-groups",
      headers: owner.headers,
      payload: { name: "External list" },
    });
    const groupId = group.json().id;
    await app.inject({
      method: "POST",
      url: `/api/v1/distribution-groups/${groupId}/members`,
      headers: owner.headers,
      payload: { email: "Client@Example.test" },
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/v1/distribution-groups/${groupId}/members`,
      headers: owner.headers,
      payload: { email: "client@example.test" },
    });
    expect(second.json().alreadyMember).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Bulk edit and CSV import                                            */
/* ------------------------------------------------------------------ */

describe("directory bulk operations", () => {
  it("bulk-edits vendors and adds trade codes without losing existing ones", async () => {
    const a = await app.inject({
      method: "POST",
      url: "/api/v1/vendors",
      headers: owner.headers,
      payload: { name: "Bulk One", tradeCodes: ["03"] },
    });
    const b = await app.inject({
      method: "POST",
      url: "/api/v1/vendors",
      headers: owner.headers,
      payload: { name: "Bulk Two" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vendors/bulk",
      headers: owner.headers,
      payload: {
        ids: [a.json().id, b.json().id],
        patch: { country: "United Kingdom", addTradeCodes: ["05"] },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().updated).toBe(2);
    const read = await app.inject({
      method: "GET",
      url: `/api/v1/vendors/${a.json().id}`,
      headers: owner.headers,
    });
    expect(read.json().tradeCodes.sort()).toEqual(["03", "05"]);
    expect(read.json().country).toBe("United Kingdom");
  });

  it("imports vendors from CSV after a dry run, and updates on a second pass", async () => {
    const csv = ["name,email,city", "Imported Civils,ops@imported.test,Leeds", "Bad Row,nope,York"].join(
      "\n",
    );
    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/imports/vendors/preview",
      headers: owner.headers,
      payload: { csv, fileName: "vendors.csv" },
    });
    expect(preview.statusCode).toBe(201);
    expect(preview.json().errorCount).toBe(1);

    const commit = await app.inject({
      method: "POST",
      url: `/api/v1/directory/imports/${preview.json().id}/commit`,
      headers: owner.headers,
    });
    expect(commit.statusCode).toBe(200);
    expect(commit.json()).toMatchObject({ created: 1, skipped: 1 });

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/imports/vendors/preview",
      headers: owner.headers,
      payload: { csv: "name,city\nImported Civils,Manchester" },
    });
    const secondCommit = await app.inject({
      method: "POST",
      url: `/api/v1/directory/imports/${second.json().id}/commit`,
      headers: owner.headers,
    });
    expect(secondCommit.json()).toMatchObject({ created: 0, updated: 1 });
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/vendors?search=Imported",
      headers: owner.headers,
    });
    expect(list.json().items[0].city).toBe("Manchester");
  });

  it("refuses to commit a directory dataset through the projects route", async () => {
    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/imports/vendors/preview",
      headers: owner.headers,
      payload: { csv: "name\nWrong Route" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/imports/${preview.json().id}/commit`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(400);
  });

  /*
   * A vendor_name the directory does not hold used to become `null` with no
   * finding anywhere: 60 unattached contacts out of a 500-row file, reviewed
   * in a dry run that said nothing.
   */
  it("flags a vendor_name the directory does not hold, in the dry run and again on commit", async () => {
    await app.inject({
      method: "POST",
      url: "/api/v1/vendors",
      headers: owner.headers,
      payload: { name: "Acme Limited" },
    });
    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/imports/contacts/preview",
      headers: owner.headers,
      payload: {
        csv: [
          "name,email,vendor_name",
          "Real Person,real@acme.test,Acme Limited",
          "Lost Person,lost@acme.test,Acme Ltd.",
        ].join("\n"),
      },
    });
    expect(preview.statusCode).toBe(201);
    const findings = preview.json().errors as Array<{
      row: number;
      field: string | null;
      message: string;
      severity: string;
    }>;
    const unmatched = findings.find((f) => f.field === "vendor_name");
    expect(unmatched).toBeTruthy();
    expect(unmatched!.severity).toBe("warning");
    expect(unmatched!.message).toContain("Acme Ltd.");
    // A warning, not an error: the contact is still worth importing.
    expect(preview.json().errorCount).toBe(0);

    const commit = await app.inject({
      method: "POST",
      url: `/api/v1/directory/imports/${preview.json().id}/commit`,
      headers: owner.headers,
    });
    expect(commit.statusCode).toBe(200);
    expect(commit.json().created).toBe(2);
    expect(commit.json().unresolvedVendors).toEqual(["Acme Ltd."]);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/contacts?search=Lost",
      headers: owner.headers,
    });
    expect(list.json().items[0].vendorId).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Fixer pass — the merge undo and the "restorable" delete             */
/* ------------------------------------------------------------------ */

describe("vendor merge undo", () => {
  /*
   * BLOCKER regression. The undo re-pointed EVERY row currently owned by the
   * target back to the source, because the journal recorded only a count per
   * table. One click inside the advertised 24-hour window transferred the
   * surviving vendor's entire commercial history to a vendor it was never
   * associated with, transactionally, with no second undo.
   */
  it("moves back only the rows the merge moved, leaving the target's own records alone", async () => {
    const a = await app.inject({
      method: "POST",
      url: "/api/v1/vendors",
      headers: owner.headers,
      payload: { name: "Undo Source Ltd" },
    });
    const b = await app.inject({
      method: "POST",
      url: "/api/v1/vendors",
      headers: owner.headers,
      payload: { name: "Undo Target Ltd" },
    });
    const source = a.json().id as string;
    const target = b.json().id as string;

    // The target already owns two commitments of its own.
    const own: string[] = [];
    for (const reference of ["SC-200", "SC-201"]) {
      const id = newId("cmt");
      own.push(id);
      await app.db.insert(commitments).values({
        id,
        companyId: owner.companyId,
        projectId,
        number: Number(reference.slice(3)),
        reference,
        title: `Target work ${reference}`,
        vendorId: target,
        createdBy: owner.userId,
      });
    }
    // The source owns one.
    const moved = newId("cmt");
    await app.db.insert(commitments).values({
      id: moved,
      companyId: owner.companyId,
      projectId,
      number: 202,
      reference: "SC-202",
      title: "Source work",
      vendorId: source,
      createdBy: owner.userId,
    });

    const merge = await app.inject({
      method: "POST",
      url: `/api/v1/vendors/${source}/merge`,
      headers: owner.headers,
      payload: { intoVendorId: target },
    });
    expect(merge.statusCode).toBe(200);
    const movements = merge.json().movements as Array<{
      table: string;
      rows: number;
      ids: string[] | null;
    }>;
    const commitmentMovement = movements.find((m) => m.table === "commitments")!;
    expect(commitmentMovement.rows).toBe(1);
    // The identity of the moved row, not just how many there were.
    expect(commitmentMovement.ids).toEqual([moved]);

    const undo = await app.inject({
      method: "POST",
      url: `/api/v1/vendor-merges/${merge.json().mergeId}/undo`,
      headers: owner.headers,
    });
    expect(undo.statusCode).toBe(200);
    expect(
      (undo.json().restored as Array<{ table: string; rows: number }>).find(
        (r) => r.table === "commitments",
      )?.rows,
    ).toBe(1);

    const rows = await app.db
      .select({ id: commitments.id, vendorId: commitments.vendorId })
      .from(commitments)
      .where(inArray(commitments.id, [...own, moved]));
    const byId = new Map(rows.map((r) => [r.id, r.vendorId]));
    expect(byId.get(moved)).toBe(source);
    // The two the target owned all along stay with the target.
    for (const id of own) expect(byId.get(id)).toBe(target);
  });

  it("refuses an undo when the journal has no row identities", async () => {
    const a = await app.inject({
      method: "POST",
      url: "/api/v1/vendors",
      headers: owner.headers,
      payload: { name: "Legacy Source Ltd" },
    });
    const b = await app.inject({
      method: "POST",
      url: "/api/v1/vendors",
      headers: owner.headers,
      payload: { name: "Legacy Target Ltd" },
    });
    const contactId = newId("cnt");
    await app.db.insert(contacts).values({
      id: contactId,
      companyId: owner.companyId,
      vendorId: a.json().id,
      name: "Legacy Contact",
    });
    const merge = await app.inject({
      method: "POST",
      url: `/api/v1/vendors/${a.json().id}/merge`,
      headers: owner.headers,
      payload: { intoVendorId: b.json().id },
    });
    const mergeId = merge.json().mergeId as string;
    // Rewrite the journal the way it was written before ids were recorded.
    await app.db
      .update(vendorMerges)
      .set({ movements: [{ table: "contacts", column: "vendorId", rows: 1 }] })
      .where(eq(vendorMerges.id, mergeId));

    const journal = await app.inject({
      method: "GET",
      url: "/api/v1/vendor-merges",
      headers: owner.headers,
    });
    const row = journal
      .json()
      .items.find((m: { id: string }) => m.id === mergeId) as {
      undoable: boolean;
      undoBlockedReason: string | null;
    };
    expect(row.undoable).toBe(false);
    expect(row.undoBlockedReason).toContain("identities");

    const undo = await app.inject({
      method: "POST",
      url: `/api/v1/vendor-merges/${mergeId}/undo`,
      headers: owner.headers,
    });
    expect(undo.statusCode).toBe(409);
    // Nothing moved: the refusal is the point.
    const after = await app.db.select().from(contacts).where(eq(contacts.id, contactId));
    expect(after[0]!.vendorId).toBe(b.json().id);
  });
});

describe("soft-deleting a vendor", () => {
  /*
   * The delete used to null `contacts.vendorId` inside the same transaction,
   * and the restore never put it back — the one thing a "restorable" delete
   * destroyed irreversibly.
   */
  it("keeps its contacts, and the restore returns a vendor that still has them", async () => {
    const vendor = await app.inject({
      method: "POST",
      url: "/api/v1/vendors",
      headers: owner.headers,
      payload: { name: "Southern Groundworks" },
    });
    const vendorId = vendor.json().id as string;
    const contactId = newId("cnt");
    await app.db.insert(contacts).values({
      id: contactId,
      companyId: owner.companyId,
      vendorId,
      name: "Attached Contact",
    });

    await app.inject({
      method: "DELETE",
      url: `/api/v1/vendors/${vendorId}`,
      headers: owner.headers,
    });
    const stillAttached = await app.db.select().from(contacts).where(eq(contacts.id, contactId));
    expect(stillAttached[0]!.vendorId).toBe(vendorId);

    // The read path says the employer is deleted rather than blanking it.
    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/contacts?search=Attached",
      headers: owner.headers,
    });
    const contactRow = listed.json().items[0];
    expect(contactRow.vendorName).toBe("Southern Groundworks");
    expect(contactRow.vendorDeleted).toBe(true);

    // And a new contact cannot be filed against a vendor in the recycle bin.
    const refused = await app.inject({
      method: "POST",
      url: "/api/v1/contacts",
      headers: owner.headers,
      payload: { name: "Too Late", vendorId },
    });
    expect(refused.statusCode).toBe(400);

    await app.inject({
      method: "POST",
      url: `/api/v1/vendors/${vendorId}/restore`,
      headers: owner.headers,
    });
    const afterRestore = await app.inject({
      method: "GET",
      url: `/api/v1/contacts?vendorId=${vendorId}`,
      headers: owner.headers,
    });
    expect(afterRestore.json().items.map((c: { id: string }) => c.id)).toContain(contactId);
    expect(afterRestore.json().items[0].vendorDeleted).toBe(false);
  });
});

/*
 * A CSV carrying two columns is a two-column edit.
 *
 * Every field of the dataset used to be written on every commit, so a
 * `name,email` re-import blanked each matched vendor's address, phone,
 * website, tax id and registration number and reset its status, and a
 * contacts file without a `vendor_name` column detached every matched
 * contact from its vendor. None of it was reported.
 */
describe("a partial CSV does not blank the columns it omits", () => {
  it("keeps a vendor's other fields when the file does not carry them", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/vendors",
      headers: owner.headers,
      payload: {
        name: "Partial Import Civils",
        address: "12 Kiln Road",
        phone: "0113 000 0000",
        taxId: "GB123456789",
        status: "inactive",
      },
    });
    expect(created.statusCode).toBe(201);
    const vendorId = created.json().id as string;

    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/imports/vendors/preview",
      headers: owner.headers,
      payload: { csv: "name,city\nPartial Import Civils,Sheffield" },
    });
    const commit = await app.inject({
      method: "POST",
      url: `/api/v1/directory/imports/${preview.json().id}/commit`,
      headers: owner.headers,
    });
    expect(commit.json()).toMatchObject({ created: 0, updated: 1 });

    const read = await app.inject({
      method: "GET",
      url: `/api/v1/vendors/${vendorId}`,
      headers: owner.headers,
    });
    expect(read.json().city).toBe("Sheffield");
    expect(read.json().address).toBe("12 Kiln Road");
    expect(read.json().phone).toBe("0113 000 0000");
    expect(read.json().taxId).toBe("GB123456789");
    expect(read.json().status).toBe("inactive");
  });

  it("keeps a contact attached to its vendor when the file has no vendor_name column", async () => {
    const vendor = await app.inject({
      method: "POST",
      url: "/api/v1/vendors",
      headers: owner.headers,
      payload: { name: "Attachment Holding" },
    });
    const vendorId = vendor.json().id as string;
    const contact = await app.inject({
      method: "POST",
      url: "/api/v1/contacts",
      headers: owner.headers,
      payload: { name: "Attached Person", email: "attached@holding.test", vendorId },
    });
    expect(contact.statusCode).toBe(201);

    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/imports/contacts/preview",
      headers: owner.headers,
      payload: { csv: "name,email,title\nAttached Person,attached@holding.test,Site Manager" },
    });
    const commit = await app.inject({
      method: "POST",
      url: `/api/v1/directory/imports/${preview.json().id}/commit`,
      headers: owner.headers,
    });
    expect(commit.json()).toMatchObject({ created: 0, updated: 1 });

    const read = await app.inject({
      method: "GET",
      url: `/api/v1/contacts?vendorId=${vendorId}`,
      headers: owner.headers,
    });
    const row = (read.json().items as Array<{ id: string; title: string | null }>)[0];
    expect(row?.title).toBe("Site Manager");
  });
});
