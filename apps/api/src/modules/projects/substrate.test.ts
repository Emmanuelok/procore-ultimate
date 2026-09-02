/**
 * Integration coverage for the substrate upgrades and, deliberately, for each
 * audit finding this package was asked to close. Every `it` that names a bug
 * is a regression test: it fails against the code as it was.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  budgetLineItems,
  companyMemberships,
  costCodes,
  ledgerEntries,
  notifications,
  projectMemberships,
  projects,
  recordLinks,
  rfis,
  watchers,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";

let built: BuiltApp;
let app: FastifyInstance;
let owner: TestActor;
let member: TestActor;
let memberHeaders: Record<string, string>;
let guest: TestActor;
let guestHeaders: Record<string, string>;
let other: TestActor;
let projectA: string;
let projectB: string;

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app, { companyName: "Substrate Co" });

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

  guest = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: guest.userId,
    role: "guest",
  });
  guestHeaders = {
    authorization: guest.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };

  other = await registerActor(app, { companyName: "Unrelated Co" });

  const created = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: owner.headers,
    payload: { name: "Alpha Tower", number: "A-1", currency: "GBP" },
  });
  projectA = created.json().id;
  const createdB = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: owner.headers,
    payload: { name: "Beta Bridge", number: "B-1" },
  });
  projectB = createdB.json().id;

  // The member is a project admin on A only.
  await app.db.insert(projectMemberships).values({
    id: newId("pm"),
    companyId: owner.companyId,
    projectId: projectA,
    userId: member.userId,
    templateKey: "project_admin",
  });
});

afterAll(async () => {
  await built.close();
});

/* ------------------------------------------------------------------ */
/* Portfolio visibility (audit: GET /projects listed every project)    */
/* ------------------------------------------------------------------ */

describe("GET /projects — membership scoping", () => {
  it("shows an owner every project", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/projects", headers: owner.headers });
    expect(res.statusCode).toBe(200);
    const ids = res.json().items.map((p: { id: string }) => p.id);
    expect(ids).toContain(projectA);
    expect(ids).toContain(projectB);
  });

  it("shows a member only the projects they are on", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/projects", headers: memberHeaders });
    const ids = res.json().items.map((p: { id: string }) => p.id);
    expect(ids).toEqual([projectA]);
  });

  it("shows a guest with no memberships nothing at all", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/projects", headers: guestHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ items: [], total: 0 });
  });

  it("never leaks across tenants", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/projects", headers: other.headers });
    const ids = res.json().items.map((p: { id: string }) => p.id);
    expect(ids).not.toContain(projectA);
  });
});

/* ------------------------------------------------------------------ */
/* Lifecycle guards                                                    */
/* ------------------------------------------------------------------ */

describe("PATCH /projects/:projectId — lifecycle guards", () => {
  it("refuses an invalid date and an inverted range", async () => {
    const bad = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectA}`,
      headers: owner.headers,
      payload: { startDate: "banana" },
    });
    expect(bad.statusCode).toBe(400);
    const inverted = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectA}`,
      headers: owner.headers,
      payload: { startDate: "2026-06-01", finishDate: "2026-01-01" },
    });
    expect(inverted.statusCode).toBe(400);
  });

  it("allows a forward stage move", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectA}`,
      headers: owner.headers,
      payload: { stage: "course_of_construction" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().stage).toBe("course_of_construction");
  });

  it("refuses a currency change while money records exist in the old currency", async () => {
    // Give the project one budget line, which is what makes its currency real.
    const budgetId = newId("bdg");
    await app.db.insert(budgetLineItems).values({
      id: newId("bli"),
      companyId: owner.companyId,
      projectId: projectA,
      budgetId,
      costCode: "02-100",
      description: "Groundworks",
      originalBudget: 1000,
      createdBy: owner.userId,
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectA}`,
      headers: owner.headers,
      payload: { currency: "EUR" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("GBP");
  });

  it("reports the stages a caller may move to", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectA}`,
      headers: owner.headers,
    });
    expect(Array.isArray(res.json().allowedNextStages)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Soft delete, recycle bin and purge (#78)                            */
/* ------------------------------------------------------------------ */

describe("project deletion is recoverable", () => {
  let doomed: string;

  it("soft-deletes rather than destroying, and hides the project everywhere", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: owner.headers,
      payload: { name: "Doomed Depot" },
    });
    doomed = created.json().id;

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${doomed}`,
      headers: owner.headers,
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().restorable).toBe(true);

    const list = await app.inject({ method: "GET", url: "/api/v1/projects", headers: owner.headers });
    expect(list.json().items.map((p: { id: string }) => p.id)).not.toContain(doomed);

    const read = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${doomed}`,
      headers: owner.headers,
    });
    expect(read.statusCode).toBe(404);

    // The row is still there — that is the point of a recycle bin.
    const rows = await app.db.select().from(projects).where(eq(projects.id, doomed));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deletedAt).toBeTruthy();
  });

  it("lists the deleted project in the recycle bin and restores it intact", async () => {
    const bin = await app.inject({
      method: "GET",
      url: "/api/v1/recycle-bin",
      headers: owner.headers,
    });
    expect(bin.json().items.some((i: { id: string }) => i.id === doomed)).toBe(true);

    const restore = await app.inject({
      method: "POST",
      url: `/api/v1/recycle-bin/projects/${doomed}/restore`,
      headers: owner.headers,
    });
    expect(restore.statusCode).toBe(200);
    const read = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${doomed}`,
      headers: owner.headers,
    });
    expect(read.statusCode).toBe(200);
  });

  it("refuses a delete while a legal hold covers the project", async () => {
    const hold = await app.inject({
      method: "POST",
      url: "/api/v1/legal-holds",
      headers: owner.headers,
      payload: { name: "Arbitration 2026", reason: "Preserve for adjudication", projectId: doomed },
    });
    expect(hold.statusCode).toBe(201);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${doomed}`,
      headers: owner.headers,
    });
    expect(del.statusCode).toBe(409);
    expect(del.json().message).toContain("Arbitration 2026");

    await app.inject({
      method: "POST",
      url: `/api/v1/legal-holds/${hold.json().id}/release`,
      headers: owner.headers,
      payload: { note: "matter closed" },
    });
    const after = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${doomed}`,
      headers: owner.headers,
    });
    expect(after.statusCode).toBe(200);
  });

  it("purges only what the substrate owns, and only for an owner", async () => {
    // A notification deep-linking at the doomed project: leaving it behind
    // produces an inbox item that can never be opened and a badge that can
    // never be cleared (audit: project delete orphaned every child row).
    await app.db.insert(notifications).values({
      id: newId("ntf"),
      companyId: owner.companyId,
      userId: owner.userId,
      projectId: doomed,
      kind: "status_change",
      title: "Something happened on the doomed project",
    });

    const asMember = await app.inject({
      method: "DELETE",
      url: `/api/v1/recycle-bin/projects/${doomed}`,
      headers: memberHeaders,
    });
    expect(asMember.statusCode).toBe(403);

    const purge = await app.inject({
      method: "DELETE",
      url: `/api/v1/recycle-bin/projects/${doomed}`,
      headers: owner.headers,
    });
    expect(purge.statusCode).toBe(200);
    expect(purge.json().purged).toBe(true);
    expect(purge.json().removed.notifications).toBe(1);
    const rows = await app.db.select().from(projects).where(eq(projects.id, doomed));
    expect(rows).toHaveLength(0);
    const left = await app.db
      .select()
      .from(notifications)
      .where(eq(notifications.projectId, doomed));
    expect(left).toHaveLength(0);

    // The purge and its ledger entry are one transaction: a purge that
    // committed without a ledger row would be the unledgered mutation the
    // ledger exists to make impossible.
    const trail = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectId, doomed),
          eq(ledgerEntries.action, "delete"),
        ),
      );
    expect(
      trail.some((e) => (e.payload as { event?: string } | null)?.event === "purged"),
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Cloning (#5)                                                        */
/* ------------------------------------------------------------------ */

describe("POST /projects/:projectId/clone", () => {
  it("deep-copies the shape with remapped ids and copies no transactions", async () => {
    const parent = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/locations`,
      headers: owner.headers,
      payload: { name: "Block A" },
    });
    const child = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/locations`,
      headers: owner.headers,
      payload: { name: "Level 1", parentId: parent.json().id },
    });
    expect(child.statusCode).toBe(201);
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/cost-codes`,
      headers: owner.headers,
      payload: { code: "02-100", title: "Site clearance" },
    });

    const clone = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/clone`,
      headers: owner.headers,
      payload: { name: "Alpha Tower Phase 2", include: ["locations", "costCodes"] },
    });
    expect(clone.statusCode).toBe(201);
    const cloneId = clone.json().id;
    expect(clone.json().copied).toMatchObject({ locations: 2, costCodes: 1 });
    expect(clone.json().clonedFromId).toBe(projectA);
    // A clone starts at the beginning of the lifecycle, not where its source is.
    expect(clone.json().stage).toBe("pre_construction");

    const locations = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${cloneId}/locations`,
      headers: owner.headers,
    });
    const tree = locations.json().tree as Array<{ id: string; children: unknown[] }>;
    expect(tree).toHaveLength(1);
    expect(tree[0]!.children).toHaveLength(1);
    // Ids are remapped, not shared with the source project.
    expect(tree[0]!.id).not.toBe(parent.json().id);
  });

  it("can produce a template that is hidden from operational views", async () => {
    const clone = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/clone`,
      headers: owner.headers,
      payload: { name: "Standard fit-out template", asTemplate: true, include: [] },
    });
    const templateId = clone.json().id;
    const operational = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: owner.headers,
    });
    expect(operational.json().items.map((p: { id: string }) => p.id)).not.toContain(templateId);
    const templates = await app.inject({
      method: "GET",
      url: "/api/v1/projects?include=templates",
      headers: owner.headers,
    });
    expect(templates.json().items.map((p: { id: string }) => p.id)).toContain(templateId);
  });
});

/* ------------------------------------------------------------------ */
/* Cross-tenant attachment leaks                                       */
/* ------------------------------------------------------------------ */

describe("watchers and custom values are tenant-scoped", () => {
  let foreignRecordId: string;

  beforeAll(async () => {
    // A record belonging to the OTHER tenant, plus a watcher on it.
    foreignRecordId = newId("rfi");
    await app.db.insert(watchers).values({
      id: newId("wch"),
      companyId: other.companyId,
      projectId: null,
      recordType: "rfi",
      recordId: foreignRecordId,
      userId: other.userId,
    });
  });

  it("does not return another tenant's watchers for a record id", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectA}/records/rfi/${foreignRecordId}/watchers`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
  });

  it("refuses to watch a record that is not in this project", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/records/rfi/${foreignRecordId}/watchers`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(400);
  });

  it("stamps the tenant on a watcher it does create", async () => {
    const rfiId = newId("rfi");
    await app.db.insert(rfis).values({
      id: rfiId,
      companyId: owner.companyId,
      projectId: projectA,
      number: 901,
      subject: "Watched RFI",
      question: "?",
      createdBy: owner.userId,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/records/rfi/${rfiId}/watchers`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(201);
    const rows = await app.db
      .select()
      .from(watchers)
      .where(and(eq(watchers.recordType, "rfi"), eq(watchers.recordId, rfiId)));
    expect(rows[0]).toMatchObject({ companyId: owner.companyId, projectId: projectA });
  });
});

/* ------------------------------------------------------------------ */
/* Custom field validation (#63)                                       */
/* ------------------------------------------------------------------ */

describe("custom field values are typed", () => {
  let defId: string;
  let rfiId: string;

  beforeAll(async () => {
    const def = await app.inject({
      method: "POST",
      url: "/api/v1/custom-field-defs",
      headers: owner.headers,
      payload: {
        projectId: projectA,
        tool: "rfis",
        key: "zone",
        label: "Zone",
        fieldType: "dropdown",
        options: ["North", "South"],
      },
    });
    defId = def.json().id;
    rfiId = newId("rfi");
    await app.db.insert(rfis).values({
      id: rfiId,
      companyId: owner.companyId,
      projectId: projectA,
      number: 902,
      subject: "Custom field RFI",
      question: "?",
      createdBy: owner.userId,
    });
  });

  it("refuses a dropdown value that is not one of its options", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectA}/records/rfi/${rfiId}/custom-values`,
      headers: owner.headers,
      payload: { values: { [defId]: "West" } },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain("Zone");
  });

  it("accepts a valid value and stores the tenant columns", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectA}/records/rfi/${rfiId}/custom-values`,
      headers: owner.headers,
      payload: { values: { [defId]: "North" } },
    });
    expect(res.statusCode).toBe(200);
    const read = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectA}/records/rfi/${rfiId}/custom-values`,
      headers: owner.headers,
    });
    expect(read.json().items[0]).toMatchObject({ value: "North", key: "zone" });
  });

  it("refuses a field belonging to a different tool", async () => {
    const def = await app.inject({
      method: "POST",
      url: "/api/v1/custom-field-defs",
      headers: owner.headers,
      payload: {
        projectId: projectA,
        tool: "budget",
        key: "fund",
        label: "Fund",
        fieldType: "text",
      },
    });
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectA}/records/rfi/${rfiId}/custom-values`,
      headers: owner.headers,
      payload: { values: { [def.json().id]: "Capital" } },
    });
    expect(res.statusCode).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* Reference guards on locations and cost codes                        */
/* ------------------------------------------------------------------ */

describe("deleting substrate records refuses to orphan references", () => {
  it("refuses to delete a cost code a budget line still uses, and suggests deactivating", async () => {
    const code = await app.inject({
      method: "POST",
      url: "/api/v1/cost-codes",
      headers: owner.headers,
      payload: { code: "01-000", title: "Preliminaries" },
    });
    const codeId = code.json().id;
    await app.db.insert(budgetLineItems).values({
      id: newId("bli"),
      companyId: owner.companyId,
      projectId: projectA,
      budgetId: newId("bdg"),
      costCode: "01-000",
      description: "Prelims",
      costCodeId: codeId,
      originalBudget: 500,
      createdBy: owner.userId,
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/cost-codes/${codeId}`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("budget lines");

    // Deactivating is the supported path and keeps the history intact.
    const deactivate = await app.inject({
      method: "PATCH",
      url: `/api/v1/cost-codes/${codeId}`,
      headers: owner.headers,
      payload: { isActive: false },
    });
    expect(deactivate.statusCode).toBe(200);
  });

  it("refuses an unknown or foreign cost-code parent", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cost-codes",
      headers: owner.headers,
      payload: { code: "09-999", title: "Orphan", parentId: "cc_does_not_exist" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses to delete a location that records still reference", async () => {
    const loc = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/locations`,
      headers: owner.headers,
      payload: { name: "Occupied Room" },
    });
    const locationId = loc.json().id;
    await app.db.insert(rfis).values({
      id: newId("rfi"),
      companyId: owner.companyId,
      projectId: projectA,
      number: 903,
      subject: "Located RFI",
      question: "?",
      locationId,
      createdBy: owner.userId,
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectA}/locations/${locationId}`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("RFIs");
  });
});

/* ------------------------------------------------------------------ */
/* Link deletion authority                                             */
/* ------------------------------------------------------------------ */

describe("DELETE /links/:linkId", () => {
  it("refuses a caller with no standard access to the link's project", async () => {
    const link = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectB}/links`,
      headers: owner.headers,
      payload: { fromType: "rfi", fromId: "r1", toType: "drawing_sheet", toId: "d1" },
    });
    expect(link.statusCode).toBe(201);
    const linkId = link.json().id;

    // The member is on project A, not B — company membership alone used to be
    // enough to delete any link in the tenant.
    const refused = await app.inject({
      method: "DELETE",
      url: `/api/v1/links/${linkId}`,
      headers: memberHeaders,
    });
    expect(refused.statusCode).toBe(403);
    const stillThere = await app.db.select().from(recordLinks).where(eq(recordLinks.id, linkId));
    expect(stillThere).toHaveLength(1);

    const allowed = await app.inject({
      method: "DELETE",
      url: `/api/v1/links/${linkId}`,
      headers: owner.headers,
    });
    expect(allowed.statusCode).toBe(200);
  });
});

/* ------------------------------------------------------------------ */
/* Mentions                                                            */
/* ------------------------------------------------------------------ */

describe("comments and mentions", () => {
  it("does not notify a company member who cannot open the project", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectB}/records/rfi/r-mention/comments`,
      headers: owner.headers,
      payload: { body: "Commercially sensitive detail", mentions: [guest.userId] },
    });
    expect(res.statusCode).toBe(201);
    // The guest is a company member but is on no project: named, not notified.
    expect(res.json().notNotified).toContain(guest.userId);

    const inbox = await app.inject({
      method: "GET",
      url: "/api/v1/notifications",
      headers: guestHeaders,
    });
    expect(inbox.json().items).toHaveLength(0);
  });

  it("notifies a mention who IS on the project", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/records/rfi/r-mention-2/comments`,
      headers: owner.headers,
      payload: { body: "Please look at this", mentions: [member.userId] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().notNotified).toEqual([]);
    const inbox = await app.inject({
      method: "GET",
      url: "/api/v1/notifications?unread=true",
      headers: memberHeaders,
    });
    expect(inbox.json().items.some((n: { kind: string }) => n.kind === "mention")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Saved views (#75)                                                   */
/* ------------------------------------------------------------------ */

describe("saved views", () => {
  let viewId: string;

  it("saves a private view and returns it to its owner only", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/saved-views",
      headers: owner.headers,
      payload: { tableId: "projects", name: "My live jobs", state: { stage: "warranty" } },
    });
    expect(res.statusCode).toBe(201);
    viewId = res.json().id;

    const mine = await app.inject({
      method: "GET",
      url: "/api/v1/saved-views?tableId=projects",
      headers: owner.headers,
    });
    expect(mine.json().items.map((v: { id: string }) => v.id)).toContain(viewId);

    const theirs = await app.inject({
      method: "GET",
      url: "/api/v1/saved-views?tableId=projects",
      headers: memberHeaders,
    });
    expect(theirs.json().items.map((v: { id: string }) => v.id)).not.toContain(viewId);
  });

  it("shares a view with the company when its scope says so", async () => {
    await app.inject({
      method: "PATCH",
      url: `/api/v1/saved-views/${viewId}`,
      headers: owner.headers,
      payload: { scope: "company" },
    });
    const theirs = await app.inject({
      method: "GET",
      url: "/api/v1/saved-views?tableId=projects",
      headers: memberHeaders,
    });
    const found = theirs.json().items.find((v: { id: string }) => v.id === viewId);
    expect(found).toBeTruthy();
    expect(found.mine).toBe(false);
  });

  it("refuses an edit by somebody who does not own the view", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/saved-views/${viewId}`,
      headers: memberHeaders,
      payload: { name: "Hijacked" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses a duplicate name on the same table for the same owner", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/saved-views",
      headers: owner.headers,
      payload: { tableId: "projects", name: "My live jobs", state: {} },
    });
    expect(res.statusCode).toBe(409);
  });
});

/* ------------------------------------------------------------------ */
/* Bulk edit (#76)                                                     */
/* ------------------------------------------------------------------ */

describe("POST /projects/bulk", () => {
  it("updates every project the caller may see and reports what it refused", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/projects/bulk",
      headers: owner.headers,
      payload: { ids: [projectA, projectB, "prj_nonexistent"], patch: { department: "Civils" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().updated).toBe(2);
    expect(res.json().refused).toEqual(["prj_nonexistent"]);
    const read = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectB}`,
      headers: owner.headers,
    });
    expect(read.json().department).toBe("Civils");
  });

  it("refuses an empty patch", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/projects/bulk",
      headers: owner.headers,
      payload: { ids: [projectA], patch: {} },
    });
    expect(res.statusCode).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* CSV import (#77)                                                    */
/* ------------------------------------------------------------------ */

describe("CSV import", () => {
  it("offers a template, previews without writing, then commits", async () => {
    const template = await app.inject({
      method: "GET",
      url: "/api/v1/imports/cost_codes/template",
      headers: owner.headers,
    });
    expect(template.statusCode).toBe(200);
    expect(template.body.split("\n")[0]).toContain("code");

    const csv = ["code,title,parent_code", "07-000,Thermal protection,", "07-100,Insulation,07-000", "invalid,,"].join("\n");
    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/imports/cost_codes/preview",
      headers: owner.headers,
      payload: { csv, fileName: "codes.csv" },
    });
    expect(preview.statusCode).toBe(201);
    const job = preview.json();
    expect(job.rowCount).toBe(3);
    expect(job.errorCount).toBeGreaterThan(0);

    // Nothing was written by the preview.
    const beforeCommit = await app.db
      .select()
      .from(costCodes)
      .where(and(eq(costCodes.companyId, owner.companyId), eq(costCodes.code, "07-000")));
    expect(beforeCommit).toHaveLength(0);

    const commit = await app.inject({
      method: "POST",
      url: `/api/v1/imports/${job.id}/commit`,
      headers: owner.headers,
    });
    expect(commit.statusCode).toBe(200);
    expect(commit.json()).toMatchObject({ status: "committed", created: 2, skipped: 1 });

    const rows = await app.db
      .select()
      .from(costCodes)
      .where(and(eq(costCodes.companyId, owner.companyId), eq(costCodes.code, "07-100")));
    expect(rows).toHaveLength(1);
    // The parent link was resolved in the second pass.
    expect(rows[0]!.parentId).toBeTruthy();
  });

  it("refuses to commit the same job twice", async () => {
    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/imports/cost_codes/preview",
      headers: owner.headers,
      payload: { csv: "code,title\n08-000,Openings" },
    });
    const jobId = preview.json().id;
    await app.inject({
      method: "POST",
      url: `/api/v1/imports/${jobId}/commit`,
      headers: owner.headers,
    });
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/imports/${jobId}/commit`,
      headers: owner.headers,
    });
    expect(again.statusCode).toBe(409);
  });

  it("builds a location hierarchy from a path column", async () => {
    const csv = ["path,sort_order", "Tower > Level 2 > Room 201,1", "Tower > Level 2 > Room 202,2"].join("\n");
    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/imports/locations/preview",
      headers: owner.headers,
      payload: { csv, projectId: projectA },
    });
    expect(preview.statusCode).toBe(201);
    const commit = await app.inject({
      method: "POST",
      url: `/api/v1/imports/${preview.json().id}/commit`,
      headers: owner.headers,
    });
    expect(commit.statusCode).toBe(200);
    // Tower, Level 2, Room 201, Room 202 — the shared ancestors are created once.
    expect(commit.json().created).toBe(4);
  });

  it("refuses a location import with no project", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/imports/locations/preview",
      headers: owner.headers,
      payload: { csv: "path\nA" },
    });
    expect(res.statusCode).toBe(400);
  });
});
