/**
 * Tenant governance: segregation of duties on assurance grants, the audit
 * viewer, retention policy, legal hold, data export and delegated
 * administration.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { assuranceGrants, companyMemberships, ledgerEntries } from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";
import { ADMIN_EXPIRY_JOB } from "./index.js";

let built: BuiltApp;
let app: FastifyInstance;
let owner: TestActor;
let admin: TestActor;
let adminHeaders: Record<string, string>;
let reviewer: TestActor;
let outsider: TestActor;
let projectId: string;

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app, { companyName: "Governance Co" });

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

  reviewer = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: reviewer.userId,
    role: "member",
  });

  outsider = await registerActor(app, { companyName: "Elsewhere Co" });

  const project = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: owner.headers,
    payload: { name: "Governance Project" },
  });
  projectId = project.json().id;
});

afterAll(async () => {
  await built.close();
});

/* ------------------------------------------------------------------ */
/* Segregation of duties                                               */
/* ------------------------------------------------------------------ */

describe("POST /assurance-grants — segregation of duties", () => {
  it("refuses a self-grant and records the attempt", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/assurance-grants",
      headers: adminHeaders,
      payload: { userId: admin.userId, role: "integrity_reviewer" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("yourself");

    const rows = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectType, "assurance_grant"),
        ),
      );
    // The refusal itself is evidence.
    expect(rows.some((r) => r.action === "access")).toBe(true);
  });

  it("refuses granting integrity_reviewer to an owner or admin", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/assurance-grants",
      headers: owner.headers,
      payload: { userId: admin.userId, role: "integrity_reviewer" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("integrity_reviewer");
  });

  it("refuses a grantee who is not a member of this company", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/assurance-grants",
      headers: owner.headers,
      payload: { userId: outsider.userId, role: "auditor" },
    });
    expect(res.statusCode).toBe(403);
    const dangling = await app.db
      .select()
      .from(assuranceGrants)
      .where(
        and(
          eq(assuranceGrants.companyId, owner.companyId),
          eq(assuranceGrants.userId, outsider.userId),
        ),
      );
    expect(dangling).toHaveLength(0);
  });

  it("allows a grant to an ordinary member", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/assurance-grants",
      headers: owner.headers,
      payload: { userId: reviewer.userId, role: "integrity_reviewer", projectId },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().role).toBe("integrity_reviewer");
  });
});

/* ------------------------------------------------------------------ */
/* Audit viewer                                                        */
/* ------------------------------------------------------------------ */

describe("GET /company/audit", () => {
  it("reads the tenant's ledger with filters and names the actor", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/company/audit?objectType=project",
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ objectType: string; actorName: string }>;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.objectType === "project")).toBe(true);
    expect(items[0]!.actorName).toBeTruthy();
  });

  it("filters to one record", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/company/audit?objectId=${projectId}`,
      headers: owner.headers,
    });
    const items = res.json().items as Array<{ objectId: string }>;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.objectId === projectId)).toBe(true);
  });

  it("says whether the payload was stored rather than implying nothing changed", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/company/audit",
      headers: owner.headers,
    });
    expect(res.json().items[0]).toHaveProperty("payloadStored");
    expect(res.json().items[0]).toHaveProperty("entryHash");
  });

  it("never shows another tenant's trail", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/company/audit",
      headers: outsider.headers,
    });
    const items = res.json().items as Array<{ objectId: string }>;
    expect(items.some((i) => i.objectId === projectId)).toBe(false);
  });

  it("refuses a non-admin", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/company/audit",
      headers: {
        authorization: reviewer.headers["authorization"]!,
        "x-company-id": owner.companyId,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("offers facets for the filter UI", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/company/audit/facets",
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().objectTypes.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* Retention and legal hold                                            */
/* ------------------------------------------------------------------ */

describe("retention and legal hold", () => {
  it("stores a retention policy with the basis that sets it", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/company/retention-policies/project",
      headers: owner.headers,
      payload: { retainMonths: 72, action: "retain", basis: "Limitation Act 1980 s.5" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ retainMonths: 72, action: "retain" });

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/company/retention-policies",
      headers: owner.headers,
    });
    expect(list.json().items).toHaveLength(1);
  });

  it("previews what a policy would act on and admits what it does not enforce", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/v1/company/retention-policies/document",
      headers: owner.headers,
      payload: { retainMonths: 12, action: "purge" },
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/company/retention-policies/preview",
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ objectType: string; enforced: boolean; note: string }>;
    expect(items.find((i) => i.objectType === "project")!.enforced).toBe(true);
    const documents = items.find((i) => i.objectType === "document")!;
    expect(documents.enforced).toBe(false);
    expect(documents.note).toContain("does not delete records it does not own");
  });

  it("blocks and then permits a delete around a hold's lifecycle", async () => {
    const project = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: owner.headers,
      payload: { name: "Held Project" },
    });
    const heldId = project.json().id;
    const hold = await app.inject({
      method: "POST",
      url: "/api/v1/legal-holds",
      headers: owner.headers,
      payload: { name: "Dispute 42", reason: "Adjudication", objectType: "project", objectId: heldId },
    });
    expect(hold.statusCode).toBe(201);

    const blocked = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${heldId}`,
      headers: owner.headers,
    });
    expect(blocked.statusCode).toBe(409);

    const release = await app.inject({
      method: "POST",
      url: `/api/v1/legal-holds/${hold.json().id}/release`,
      headers: owner.headers,
      payload: {},
    });
    expect(release.statusCode).toBe(200);
    // A released hold stays on the record — it is evidence in its own right.
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/legal-holds?status=released",
      headers: owner.headers,
    });
    expect(list.json().items).toHaveLength(1);

    const allowed = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${heldId}`,
      headers: owner.headers,
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("refuses to release the same hold twice", async () => {
    const hold = await app.inject({
      method: "POST",
      url: "/api/v1/legal-holds",
      headers: owner.headers,
      payload: { name: "Twice", reason: "x" },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/legal-holds/${hold.json().id}/release`,
      headers: owner.headers,
      payload: {},
    });
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/legal-holds/${hold.json().id}/release`,
      headers: owner.headers,
      payload: {},
    });
    expect(again.statusCode).toBe(409);
  });

  it("refuses an objectId with no objectType", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/legal-holds",
      headers: owner.headers,
      payload: { name: "Bad", reason: "x", objectId: "abc" },
    });
    expect(res.statusCode).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* Data export                                                         */
/* ------------------------------------------------------------------ */

describe("POST /company/exports", () => {
  it("returns the requested datasets with an honest manifest", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/company/exports",
      headers: owner.headers,
      payload: { datasets: ["projects", "users", "ledger"] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("complete");
    expect(Object.keys(body.data).sort()).toEqual(["ledger", "projects", "users"]);
    expect(body.manifest.projects).toBe(body.data.projects.length);
    expect(body.rowCount).toBeGreaterThan(0);
    // Only this tenant's rows.
    expect(
      (body.data.projects as Array<{ companyId: string }>).every(
        (p) => p.companyId === owner.companyId,
      ),
    ).toBe(true);
  });

  it("records the export in the register and in the ledger", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/company/exports",
      headers: owner.headers,
    });
    expect(list.json().items.length).toBeGreaterThan(0);
    const audit = await app.inject({
      method: "GET",
      url: "/api/v1/company/audit?objectType=company_export",
      headers: owner.headers,
    });
    expect(audit.json().items.length).toBeGreaterThan(0);
  });

  it("refuses a non-admin", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/company/exports",
      headers: {
        authorization: reviewer.headers["authorization"]!,
        "x-company-id": owner.companyId,
      },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});

/* ------------------------------------------------------------------ */
/* Delegated administration                                            */
/* ------------------------------------------------------------------ */

describe("delegated administration", () => {
  it("delegates bounded capabilities and reports them back to the delegate", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/company/admin-delegations",
      headers: owner.headers,
      payload: {
        userId: reviewer.userId,
        projectIds: [projectId],
        capabilities: ["memberships"],
        note: "Regional lead",
      },
    });
    expect(res.statusCode).toBe(201);

    const mine = await app.inject({
      method: "GET",
      url: "/api/v1/me/admin-delegations",
      headers: {
        authorization: reviewer.headers["authorization"]!,
        "x-company-id": owner.companyId,
      },
    });
    expect(mine.json().capabilities).toEqual(["memberships"]);
    expect(mine.json().projectIds).toEqual([projectId]);
  });

  it("refuses delegating to yourself and refuses a non-member", async () => {
    const self = await app.inject({
      method: "POST",
      url: "/api/v1/company/admin-delegations",
      headers: owner.headers,
      payload: { userId: owner.userId, capabilities: ["directory"] },
    });
    expect(self.statusCode).toBe(403);

    const foreign = await app.inject({
      method: "POST",
      url: "/api/v1/company/admin-delegations",
      headers: owner.headers,
      payload: { userId: outsider.userId, capabilities: ["directory"] },
    });
    expect(foreign.statusCode).toBe(400);
  });

  it("revokes a delegation", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/company/admin-delegations",
      headers: owner.headers,
    });
    const id = list.json().items[0].id;
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/company/admin-delegations/${id}`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const mine = await app.inject({
      method: "GET",
      url: "/api/v1/me/admin-delegations",
      headers: {
        authorization: reviewer.headers["authorization"]!,
        "x-company-id": owner.companyId,
      },
    });
    expect(mine.json().capabilities).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Expiry sweep                                                        */
/* ------------------------------------------------------------------ */

describe("scheduler job admin.authority-expiry", () => {
  it("retires an expired assurance grant and ledgers it", async () => {
    const expiredId = newId("ag");
    await app.db.insert(assuranceGrants).values({
      id: expiredId,
      companyId: owner.companyId,
      projectId: null,
      userId: reviewer.userId,
      role: "auditor",
      expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
      grantedBy: owner.userId,
    });

    const status = await app.scheduler.runNow(ADMIN_EXPIRY_JOB);
    expect(status.state).toBe("succeeded");

    const remaining = await app.db
      .select()
      .from(assuranceGrants)
      .where(eq(assuranceGrants.id, expiredId));
    expect(remaining).toHaveLength(0);

    // Running it again is a no-op, not a second ledger entry storm.
    const second = await app.scheduler.runNow(ADMIN_EXPIRY_JOB);
    expect(second.state).toBe("succeeded");
    expect((second.lastResult as { grants: number }).grants).toBe(0);
  });
});
