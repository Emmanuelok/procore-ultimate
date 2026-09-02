/**
 * Integration tests — punch list, observations and photos, including the
 * audit's segregation-of-duties and authorisation regressions.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  changeEvents,
  companyMemberships,
  contacts,
  files,
  ledgerEntries,
  locations,
  notifications,
  projectMemberships,
  projects,
  punchItems,
  safetyIncidents,
  signals,
  users,
  vendors,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO, todayISO } from "./dates.js";
import { listZip } from "./zip.js";
import { jpegWithExif, multipartBody, tinyPng } from "./testFixtures.js";

let built: BuiltApp;
let owner: TestActor;
let engineer: TestActor; // field_engineer
let pm: TestActor; // project_manager
let sub: TestActor; // subcontractor
let nobody: TestActor; // company member with no project membership
let stranger: TestActor; // another company
let projectId: string;
let vendorId: string;
let locA: string;
let locA3: string;
let H: (a: TestActor) => Record<string, string>;

beforeAll(async () => {
  built = await buildTestApp();
  owner = await registerActor(built.app);
  engineer = await registerActor(built.app);
  pm = await registerActor(built.app);
  sub = await registerActor(built.app);
  nobody = await registerActor(built.app);
  stranger = await registerActor(built.app);
  H = (a) => ({ authorization: `Bearer ${a.accessToken}`, "x-company-id": owner.companyId });
  for (const u of [engineer, pm, sub, nobody]) {
    await built.app.db.insert(companyMemberships).values({ id: newId("cm"), companyId: owner.companyId, userId: u.userId, role: "member" });
  }
  projectId = newId("prj");
  await built.app.db.insert(projects).values({ id: projectId, companyId: owner.companyId, name: "Field P2", latitude: 51.5, longitude: -0.12 });
  const templates: Array<[TestActor, string]> = [
    [engineer, "field_engineer"],
    [pm, "project_manager"],
    [sub, "subcontractor"],
  ];
  for (const [u, templateKey] of templates) {
    await built.app.db.insert(projectMemberships).values({ id: newId("pm"), companyId: owner.companyId, projectId, userId: u.userId, templateKey, overrides: {} });
  }
  vendorId = newId("ven");
  await built.app.db.insert(vendors).values({ id: vendorId, companyId: owner.companyId, name: "Sparks Electrical" });
  locA = newId("loc");
  locA3 = newId("loc");
  await built.app.db.insert(locations).values([
    { id: locA, companyId: owner.companyId, projectId, parentId: null, name: "Building A", path: locA, sortOrder: 0 },
    { id: locA3, companyId: owner.companyId, projectId, parentId: locA, name: "Level 3", path: `${locA}/${locA3}`, sortOrder: 0 },
  ]);
});

afterAll(async () => {
  await built.close();
});

const inject = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, headers: Record<string, string>, payload?: unknown) =>
  built.app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });
const api = (path: string) => `/api/v1/projects/${projectId}${path}`;

/* ------------------------------------------------------------------ */
/* Punch                                                               */
/* ------------------------------------------------------------------ */

describe("Punch list", () => {
  it("refuses verifier == assignee, self-appointed verifiers and locks roles once ready for review", async () => {
    const same = await inject("POST", api("/punch"), H(owner), { title: "Same person", assigneeId: engineer.userId, verifierId: engineer.userId });
    expect(same.statusCode).toBe(400);
    const badLoc = await inject("POST", api("/punch"), H(owner), { title: "Bad location", locationId: "loc_ghost" });
    expect(badLoc.statusCode).toBe(400);

    const create = await inject("POST", api("/punch"), H(owner), { title: "Scratched door frame L3-301", assigneeId: engineer.userId, verifierId: pm.userId, vendorId, locationId: locA3, trade: "Joinery", priority: "high", dueDate: addDaysISO(todayISO(), -9) });
    expect(create.statusCode).toBe(201);
    const item = create.json();
    expect(item.number).toBe(1);

    // The assignee cannot make themselves the verifier (audit: punch.ts:189)
    const selfVerifier = await inject("PATCH", api(`/punch/${item.id}`), H(engineer), { verifierId: engineer.userId });
    expect(selfVerifier.statusCode).toBe(400);
    // …nor swap the verifier for the subcontractor
    const swap = await inject("PATCH", api(`/punch/${item.id}`), H(engineer), { verifierId: sub.userId });
    expect(swap.statusCode).toBe(200); // allowed while open, verifier ≠ assignee
    await inject("PATCH", api(`/punch/${item.id}`), H(owner), { verifierId: pm.userId });

    // Only the assignee (or admin) marks it ready
    const notAssignee = await inject("POST", api(`/punch/${item.id}/status`), H(sub), { status: "ready_for_review" });
    expect(notAssignee.statusCode).toBe(403);
    const ready = await inject("POST", api(`/punch/${item.id}/status`), H(engineer), { status: "ready_for_review" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().readyForReviewBy).toBe(engineer.userId);
    const locked = await inject("PATCH", api(`/punch/${item.id}`), H(engineer), { verifierId: sub.userId });
    expect(locked.statusCode).toBe(403);

    const detail = await inject("GET", api(`/punch/${item.id}`), H(engineer));
    expect(detail.json().permissions.canClose).toBe(false);
    expect(detail.json().permissions.reasons.closed).toMatch(/cannot (also )?verify/);
    const assigneeClose = await inject("POST", api(`/punch/${item.id}/status`), H(engineer), { status: "closed" });
    expect(assigneeClose.statusCode).toBe(403);
    const verifierClose = await inject("POST", api(`/punch/${item.id}/status`), H(pm), { status: "closed" });
    expect(verifierClose.statusCode).toBe(200);
    expect(verifierClose.json().closedBy).toBe(pm.userId);
    // A verified closure can never be voided (audit: punch.ts:234)
    const voidClosed = await inject("POST", api(`/punch/${item.id}/status`), H(owner), { status: "void" });
    expect(voidClosed.statusCode).toBe(400);
  });

  it("lets the creator close an unverified item, never its assignee; admin overrides are flagged by the integrity hook", async () => {
    const create = await inject("POST", api("/punch"), H(engineer), { title: "Paint touch-up stair 3", assigneeId: sub.userId, trade: "Painting" });
    const item = create.json();
    await inject("POST", api(`/punch/${item.id}/status`), H(sub), { status: "in_progress" });
    await inject("POST", api(`/punch/${item.id}/status`), H(sub), { status: "ready_for_review" });
    const byAssignee = await inject("POST", api(`/punch/${item.id}/status`), H(sub), { status: "closed" });
    expect(byAssignee.statusCode).toBe(403);
    const byCreator = await inject("POST", api(`/punch/${item.id}/status`), H(engineer), { status: "closed" });
    expect(byCreator.statusCode).toBe(200);

    // Admin assigns themselves, marks ready and closes: allowed, ledgered and flagged.
    const own = await inject("POST", api("/punch"), H(owner), { title: "Admin does it all", assigneeId: owner.userId });
    await inject("POST", api(`/punch/${own.json().id}/status`), H(owner), { status: "ready_for_review" });
    const closed = await inject("POST", api(`/punch/${own.json().id}/status`), H(owner), { status: "closed" });
    expect(closed.statusCode).toBe(200);
    const sig = await built.app.db.select().from(signals).where(and(eq(signals.companyId, owner.companyId), eq(signals.detector, "field_punch_self_verified")));
    expect(sig).toHaveLength(1);
    expect(sig[0]!.title).toContain("closed by its assignee");
  });

  it("enforces the closure gates from project settings", async () => {
    await inject("PUT", api("/field/settings"), H(pm), { punch: { requireVerifier: true, requireAfterPhoto: true } });
    const create = await inject("POST", api("/punch"), H(owner), { title: "Gated item", assigneeId: engineer.userId });
    const noVerifier = await inject("POST", api(`/punch/${create.json().id}/status`), H(engineer), { status: "ready_for_review" });
    expect(noVerifier.statusCode).toBe(400);
    expect(noVerifier.json().message).toContain("verifier");
    await inject("PATCH", api(`/punch/${create.json().id}`), H(owner), { verifierId: pm.userId });
    const noPhoto = await inject("POST", api(`/punch/${create.json().id}/status`), H(engineer), { status: "ready_for_review" });
    expect(noPhoto.statusCode).toBe(400);
    expect(noPhoto.json().message).toContain("after photo");
    await inject("PATCH", api(`/punch/${create.json().id}`), H(engineer), { afterPhotoIds: ["pho_after"] });
    const ready = await inject("POST", api(`/punch/${create.json().id}/status`), H(engineer), { status: "ready_for_review" });
    expect(ready.statusCode).toBe(200);
    await inject("PUT", api("/field/settings"), H(pm), { punch: { requireVerifier: false, requireAfterPhoto: false } });
  });

  it("bulk-creates, uses templates, groups by location, ages and exports", async () => {
    const bulk = await inject("POST", api("/punch/bulk"), H(owner), {
      defaults: { vendorId, trade: "Electrical", locationId: locA },
      items: [{ title: "Missing socket cover" }, { title: "Loose conduit", priority: "high", locationId: locA3 }, { title: "Label DB-3" }],
    });
    expect(bulk.statusCode).toBe(201);
    expect(bulk.json().created).toBe(3);
    const numbers = bulk.json().items.map((i: { number: number }) => i.number);
    expect(numbers[2] - numbers[0]).toBe(2);

    const tooMany = await inject("POST", api("/punch/bulk"), H(owner), { items: Array.from({ length: 201 }, () => ({ title: "x" })) });
    expect(tooMany.statusCode).toBe(400);

    const companyTpl = await inject("POST", api("/punch/templates"), H(engineer), { title: "Company wide", scope: "company" });
    expect(companyTpl.statusCode).toBe(403);
    const tpl = await inject("POST", api("/punch/templates"), H(engineer), { title: "Seal penetrations", trade: "Fire stopping", itemType: "deficiency", priority: "high", defaultVerifierId: pm.userId, defaultDueDays: 5 });
    expect(tpl.statusCode).toBe(201);
    const fromTpl = await inject("POST", api("/punch/from-template"), H(engineer), { templateId: tpl.json().id, locationIds: [locA, locA3], assigneeId: sub.userId });
    expect(fromTpl.statusCode).toBe(201);
    expect(fromTpl.json().created).toBe(2);
    expect(fromTpl.json().items[0].verifierId).toBe(pm.userId);
    expect(fromTpl.json().items[0].dueDate).toBe(addDaysISO(todayISO(), 5));
    const templates = await inject("GET", api("/punch/templates"), H(sub));
    expect(templates.json().items).toHaveLength(1);

    const walk = await inject("GET", api("/punch/by-location"), H(engineer));
    expect(walk.statusCode).toBe(200);
    const level3 = walk.json().groups.find((g: { locationId: string }) => g.locationId === locA3);
    expect(level3.pathLabel).toBe("Building A / Level 3");
    expect(level3.counts.open).toBeGreaterThanOrEqual(2);
    expect(walk.json().groups[walk.json().groups.length - 1].locationId).toBeNull();

    const ageing = await inject("GET", api("/punch/ageing?groupBy=vendor"), H(engineer));
    expect(ageing.json().groups.some((g: { key: string }) => g.key === "Sparks Electrical")).toBe(true);
    const byPriority = await inject("GET", api("/punch/ageing?groupBy=priority"), H(engineer));
    expect(byPriority.json().buckets["0-7"]).toBeGreaterThan(0);

    const analytics = await inject("GET", api("/punch/analytics"), H(owner));
    expect(analytics.json().completion.closed).toBe(3);
    expect(analytics.json().byTrade.some((t: { trade: string }) => t.trade === "Electrical")).toBe(true);

    const csv = await inject("GET", api("/punch/export.csv?groupBy=trade"), H(owner));
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.split("\r\n")[0]).toContain("Trade");
    expect(csv.body).toContain("Sparks Electrical");

    const list = await inject("GET", api("/punch?open=true&locationId=" + locA3), H(sub));
    expect(list.json().items.every((i: { locationId: string }) => i.locationId === locA3)).toBe(true);
    const overdue = await inject("GET", api("/punch?overdue=true"), H(sub));
    expect(overdue.json().items.every((i: { daysOverdue: number }) => i.daysOverdue > 0)).toBe(true);
  });

  it("distributes to the vendor's own people on create and on reassignment (#410)", async () => {
    // The subcontractor is reachable as a vendor contact with a login.
    const subEmail = (await built.app.db.select({ email: users.email }).from(users).where(eq(users.id, sub.userId)))[0]!.email;
    await built.app.db.insert(contacts).values({ id: newId("con"), companyId: owner.companyId, vendorId, name: "Sparks foreman", email: subEmail });

    const created = await inject("POST", api("/punch"), H(owner), { title: "Vendor distribution check", vendorId });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const notified = await built.app.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, sub.userId), eq(notifications.recordId, id)));
    expect(notified).toHaveLength(1);

    const other = await inject("POST", api("/punch"), H(owner), { title: "Reassigned later" });
    const otherId = other.json().id as string;
    expect((await inject("PATCH", api(`/punch/${otherId}`), H(owner), { vendorId })).statusCode).toBe(200);
    const reassigned = await built.app.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, sub.userId), eq(notifications.recordId, otherId)));
    expect(reassigned).toHaveLength(1);
    expect(reassigned[0]!.title).toContain("assigned to your company");
  });

  it("is tenant-scoped", async () => {
    const S = { authorization: `Bearer ${stranger.accessToken}`, "x-company-id": stranger.companyId };
    const first = (await inject("GET", api("/punch"), H(owner))).json().items[0];
    expect((await inject("GET", api(`/punch/${first.id}`), S)).statusCode).toBe(403);
    expect((await inject("POST", api(`/punch/${first.id}/status`), S, { status: "void" })).statusCode).toBe(403);
  });
});

/* ------------------------------------------------------------------ */
/* Observations                                                        */
/* ------------------------------------------------------------------ */

describe("Observations", () => {
  it("creates typed, pinned observations and converts them into punch, incident and change event", async () => {
    const mk = (extra: Record<string, unknown>) =>
      inject("POST", api("/observations"), H(engineer), { title: "Unprotected edge at L3", observationType: "safety", priority: "high", assigneeId: sub.userId, verifierId: pm.userId, locationId: locA3, pin: { sheetId: "sht_1", x: 0.25, y: 0.75 }, dueDate: addDaysISO(todayISO(), -2), ...extra });
    const a = await mk({});
    expect(a.statusCode).toBe(201);
    expect(a.json().label).toBe("OBS-001");
    expect(a.json().pinX).toBe(0.25);
    expect(a.json().daysOverdue).toBe(2);
    const notified = await built.app.db.select().from(notifications).where(and(eq(notifications.userId, sub.userId), eq(notifications.recordId, a.json().id)));
    expect(notified).toHaveLength(1);

    const toPunch = await inject("POST", api(`/observations/${a.json().id}/convert`), H(engineer), { target: "punch_item" });
    expect(toPunch.statusCode).toBe(201);
    expect(toPunch.json().target.type).toBe("punch_item");
    expect(toPunch.json().observation.status).toBe("closed");
    expect(toPunch.json().observation.convertedToId).toBe(toPunch.json().target.id);
    const punch = await inject("GET", api(`/punch/${toPunch.json().target.id}`), H(owner));
    expect(punch.json().observationId).toBe(a.json().id);
    expect(punch.json().verifierId).toBe(pm.userId);
    const twice = await inject("POST", api(`/observations/${a.json().id}/convert`), H(engineer), { target: "punch_item" });
    expect(twice.statusCode).toBe(400);

    const b = await mk({ title: "Near miss: dropped tool" });
    const toIncident = await inject("POST", api(`/observations/${b.json().id}/convert`), H(pm), { target: "incident", incidentType: "near_miss", closeObservation: false });
    expect(toIncident.statusCode).toBe(201);
    expect(toIncident.json().observation.status).toBe("open");
    const inc = (await built.app.db.select().from(safetyIncidents).where(eq(safetyIncidents.id, toIncident.json().target.id)))[0]!;
    expect(inc.reference).toMatch(/^INC-\d{4}$/);
    expect(inc.incidentType).toBe("near_miss");

    const c = await mk({ title: "Unforeseen rock at pile P12", observationType: "other" });
    const toCe = await inject("POST", api(`/observations/${c.json().id}/convert`), H(pm), { target: "change_event", eventType: "field_condition" });
    expect(toCe.statusCode).toBe(201);
    const ce = (await built.app.db.select().from(changeEvents).where(eq(changeEvents.id, toCe.json().target.id)))[0]!;
    expect(ce.originType).toBe("observation");
    expect(ce.originId).toBe(c.json().id);

    const detail = await inject("GET", api(`/observations/${c.json().id}`), H(engineer));
    expect(detail.json().links).toHaveLength(1);
    expect(detail.json().permissions.canConvert).toBe(false);
  });

  it("runs the two-hands lifecycle and reports analytics", async () => {
    const o = await inject("POST", api("/observations"), H(owner), { title: "Cracked tile", observationType: "quality", assigneeId: engineer.userId, verifierId: pm.userId });
    const id = o.json().id;
    expect((await inject("POST", api(`/observations/${id}/status`), H(sub), { status: "ready_for_review" })).statusCode).toBe(403);
    expect((await inject("POST", api(`/observations/${id}/status`), H(engineer), { status: "in_progress" })).statusCode).toBe(200);
    expect((await inject("POST", api(`/observations/${id}/status`), H(engineer), { status: "ready_for_review" })).statusCode).toBe(200);
    expect((await inject("POST", api(`/observations/${id}/status`), H(engineer), { status: "closed" })).statusCode).toBe(403);
    expect((await inject("POST", api(`/observations/${id}/status`), H(pm), { status: "closed" })).statusCode).toBe(200);
    const bad = await inject("POST", api("/observations"), H(owner), { title: "x", assigneeId: engineer.userId, verifierId: engineer.userId });
    expect(bad.statusCode).toBe(400);

    const analytics = await inject("GET", api("/observations/analytics"), H(sub));
    expect(analytics.json().total).toBe(4);
    expect(analytics.json().byType.safety).toBe(2);
    expect(analytics.json().converted.punch_item).toBe(1);
    expect(analytics.json().avgDaysToClose).not.toBeNull();
    const list = await inject("GET", api("/observations?open=true"), H(sub));
    expect(list.json().items).toHaveLength(1);
    const S = { authorization: `Bearer ${stranger.accessToken}`, "x-company-id": stranger.companyId };
    expect((await inject("GET", api(`/observations/${id}`), S)).statusCode).toBe(403);
  });

  it("converts exactly once when two requests race", async () => {
    const o = await inject("POST", api("/observations"), H(engineer), { title: "Double-click hazard", observationType: "safety", assigneeId: sub.userId, verifierId: pm.userId });
    const id = o.json().id as string;
    const [first, second] = await Promise.all([
      inject("POST", api(`/observations/${id}/convert`), H(engineer), { target: "punch_item" }),
      inject("POST", api(`/observations/${id}/convert`), H(engineer), { target: "punch_item" }),
    ]);
    const codes = [first!.statusCode, second!.statusCode].sort();
    expect(codes[0]).toBe(201);
    expect([400, 409]).toContain(codes[1]);
    const items = await built.app.db.select().from(punchItems).where(eq(punchItems.observationId, id));
    expect(items).toHaveLength(1);
    const detail = await inject("GET", api(`/observations/${id}`), H(engineer));
    expect(detail.json().convertedToId).toBe(items[0]!.id);
  });
});

/* ------------------------------------------------------------------ */
/* Photos                                                              */
/* ------------------------------------------------------------------ */

describe("Photos", () => {
  let photoId: string;

  async function upload(actor: TestActor, fields: Record<string, string>, data: Buffer, filename = "site.jpg", declared = "image/jpeg") {
    const { body, contentType } = multipartBody(fields, [{ name: "file", filename, contentType: declared, data }]);
    return built.app.inject({ method: "POST", url: api("/photos"), headers: { ...H(actor), "content-type": contentType }, payload: body });
  }

  it("uploads by content (not by name), extracts EXIF, and refuses non-media and multi-file uploads", async () => {
    const res = await upload(engineer, { album: "Structure", caption: "Column pour at C4", tags: "Concrete, pour ,concrete" }, jpegWithExif(), "col-c4.bin", "application/octet-stream");
    expect(res.statusCode).toBe(201);
    const photo = res.json();
    photoId = photo.id;
    expect(photo.file.contentType).toBe("image/jpeg");
    expect(new Date(photo.takenAt).toISOString()).toBe("2026-08-12T14:30:15.000Z");
    expect(photo.latitude).toBeCloseTo(51.5);
    expect(photo.longitude).toBeCloseTo(-0.1277);
    expect(photo.exif.make).toBe("Canon");
    expect(photo.tags).toEqual(["concrete", "pour"]);
    expect(photo.aiStatus).toBe("skipped");
    expect(photo.aiError).toContain("not configured");

    const pdf = await upload(engineer, {}, Buffer.from("%PDF-1.4 hello world hello world", "latin1"), "plan.jpg");
    expect(pdf.statusCode).toBe(415);
    const empty = await upload(engineer, {}, Buffer.alloc(0), "empty.jpg");
    expect(empty.statusCode).toBe(400);
    const two = multipartBody({}, [
      { name: "file", filename: "a.png", contentType: "image/png", data: tinyPng() },
      { name: "file", filename: "b.png", contentType: "image/png", data: tinyPng() },
    ]);
    const multi = await built.app.inject({ method: "POST", url: api("/photos"), headers: { ...H(engineer), "content-type": two.contentType }, payload: two.body });
    expect(multi.statusCode).toBe(400);
    const badPin = await upload(engineer, { pin: '{"sheetId":"s","x":2,"y":0}' }, tinyPng(), "p.png");
    expect(badPin.statusCode).toBe(400);
    const orphanFiles = await built.app.db.select().from(files).where(and(eq(files.companyId, owner.companyId), eq(files.projectId, projectId)));
    expect(orphanFiles).toHaveLength(1); // only the accepted upload left a file row

    // EXIF date 20+ days before the upload: the integrity hook flags date drift.
    const drift = await built.app.db.select().from(signals).where(and(eq(signals.companyId, owner.companyId), eq(signals.detector, "field_photo_date_drift")));
    expect(drift).toHaveLength(1);
  });

  it("refuses a photo over the size cap without buffering it", async () => {
    // 51 MB of JPEG: past the 50 MB photo cap, so the request must be rejected
    // by size, not accepted and then choked on.
    const head = jpegWithExif();
    const oversize = Buffer.concat([head, Buffer.alloc(51 * 1024 * 1024 - head.length, 0x20)]);
    const res = await upload(owner, {}, oversize, "huge.jpg");
    expect(res.statusCode).toBe(413);
    expect(res.json().message).toContain("MB limit");
  });

  it("gates record-level PATCH/DELETE by the photo's project tool level", async () => {
    // Company member with NO project membership: 403 (audit: photos.ts:175)
    const noProject = await inject("PATCH", `/api/v1/photos/${photoId}`, H(nobody), { caption: "hijack" });
    expect(noProject.statusCode).toBe(403);
    const noProjectDelete = await inject("DELETE", `/api/v1/photos/${photoId}`, H(nobody));
    expect(noProjectDelete.statusCode).toBe(403);
    // Another company: 404
    const foreign = await inject("PATCH", `/api/v1/photos/${photoId}`, { authorization: `Bearer ${stranger.accessToken}`, "x-company-id": stranger.companyId }, { caption: "x" });
    expect(foreign.statusCode).toBe(404);
    // A project member with standard access may edit…
    const ok = await inject("PATCH", api(`/photos/${photoId}`), H(sub), { caption: "Column pour complete", is360: true, tags: ["concrete", "column"], pin: { sheetId: "sht_1", x: 0.5, y: 0.5 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().is360).toBe(1);
    expect(ok.json().pin).toEqual({ sheetId: "sht_1", x: 0.5, y: 0.5 });
    // …but not delete someone else's upload
    const del = await inject("DELETE", api(`/photos/${photoId}`), H(sub));
    expect(del.statusCode).toBe(403);
  });

  it("serves content without ledger noise, filters unfiled/tags/GPS, and honours album privacy", async () => {
    const content = await inject("GET", api(`/photos/${photoId}/content`), H(engineer));
    expect(content.statusCode).toBe(200);
    expect(content.headers["content-type"]).toBe("image/jpeg");
    expect(content.headers["etag"]).toBeTruthy();
    // No access-log noise on the chain: content fetches are not ledgered (downloads still are).
    const accessEntries = await built.app.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.objectType, "photo"), eq(ledgerEntries.objectId, photoId), eq(ledgerEntries.action, "access")));
    expect(accessEntries).toHaveLength(0);

    await upload(engineer, { caption: "Unfiled one" }, tinyPng(), "u1.png");
    const unfiled = await inject("GET", api("/photos?unfiled=true"), H(engineer));
    expect(unfiled.json().total).toBe(1);
    expect(unfiled.json().items[0].album).toBeNull();
    const tagged = await inject("GET", api("/photos?tag=column"), H(engineer));
    expect(tagged.json().items.map((p: { id: string }) => p.id)).toEqual([photoId]);
    const gps = await inject("GET", api("/photos?hasGps=true"), H(engineer));
    expect(gps.json().total).toBe(1);
    const tags = await inject("GET", api("/photos/tags"), H(engineer));
    expect(tags.json().items.find((t: { tag: string }) => t.tag === "concrete").manual).toBe(1);

    const album = await inject("POST", api("/photos/albums"), H(owner), { name: "Owner eyes only", isPrivate: true, allowedUserIds: [pm.userId] });
    expect(album.statusCode).toBe(201);
    const secret = await upload(owner, { album: "Owner eyes only", caption: "Confidential" }, tinyPng(), "secret.png");
    expect(secret.statusCode).toBe(201);
    const asEngineer = await inject("GET", api("/photos"), H(engineer));
    expect(asEngineer.json().items.some((p: { id: string }) => p.id === secret.json().id)).toBe(false);
    expect((await inject("GET", api(`/photos/${secret.json().id}`), H(engineer))).statusCode).toBe(404);
    const asPm = await inject("GET", api(`/photos/${secret.json().id}`), H(pm));
    expect(asPm.statusCode).toBe(200);
    const albums = await inject("GET", api("/photos/albums"), H(engineer));
    expect(albums.json().items.some((a: { album: string }) => a.album === "Owner eyes only")).toBe(false);
    const albumsAdmin = await inject("GET", api("/photos/albums"), H(owner));
    expect(albumsAdmin.json().items.find((a: { album: string }) => a.album === "Owner eyes only").isPrivate).toBe(true);
    const intoPrivate = await upload(engineer, { album: "Owner eyes only" }, tinyPng(), "sneak.png");
    expect(intoPrivate.statusCode).toBe(403);
    const rename = await inject("PATCH", api(`/photos/albums/${album.json().id}`), H(owner), { name: "Board pack" });
    expect(rename.statusCode).toBe(200);
    expect((await inject("GET", api(`/photos/${secret.json().id}`), H(owner))).json().album).toBe("Board pack");
  });

  it("bulk-downloads a ZIP of the visible selection and reports AI as skipped when disabled", async () => {
    const all = (await inject("GET", api("/photos?pageSize=50"), H(owner))).json().items.map((p: { id: string }) => p.id);
    const zip = await built.app.inject({ method: "POST", url: api("/photos/bulk-download"), headers: H(engineer), payload: { photoIds: all } });
    expect(zip.statusCode).toBe(200);
    expect(zip.headers["content-type"]).toBe("application/zip");
    const entries = listZip(zip.rawPayload);
    expect(entries).toHaveLength(2); // the private one is not visible to the engineer
    expect(entries.map((e) => e.name).sort()).toEqual(["col-c4.bin", "u1.png"]);

    const analyse = await inject("POST", api(`/photos/${photoId}/analyse`), H(engineer));
    expect(analyse.statusCode).toBe(200);
    expect(analyse.json().status).toBe("skipped");
    expect(analyse.json().aiEnabled).toBe(false);

    const del = await inject("DELETE", `/api/v1/photos/${photoId}`, H(engineer)); // uploader
    expect(del.statusCode).toBe(200);
    expect((await inject("GET", api(`/photos/${photoId}`), H(engineer))).statusCode).toBe(404);
  });
});
