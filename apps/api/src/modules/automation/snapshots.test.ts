import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { rfis, scheduleTasks, vendors } from "@constructos/db";
import { newId } from "../../lib/ids.js";
import {
  assignRecord,
  knownObjectTypes,
  loadSnapshot,
  scanCandidates,
  snapshotCatalogue,
  snapshotEntry,
} from "./snapshots.js";
import {
  buildAutomationApp,
  createProject,
  createRfi,
  registerActor,
  type AutomationTestApp,
  type TestActor,
} from "./test-utils.js";

let t: AutomationTestApp;
let owner: TestActor;
let outsider: TestActor;
let projectId: string;
let otherProjectId: string;
let rfiOpen: string;
let rfiClosed: string;

beforeAll(async () => {
  t = await buildAutomationApp();
  owner = await registerActor(t.app);
  outsider = await registerActor(t.app);
  projectId = await createProject(t.app, owner, "Snapshot project");
  otherProjectId = await createProject(t.app, owner, "Other project");
  rfiOpen = (await createRfi(t.app, owner, projectId, { subject: "Open one", assigneeId: owner.userId })).id;
  rfiClosed = (await createRfi(t.app, owner, projectId, { subject: "Closed one" })).id;
  await createRfi(t.app, owner, otherProjectId, { subject: "Elsewhere" });
  await t.app.db.update(rfis).set({ status: "closed" }).where(eq(rfis.id, rfiClosed));
}, 120_000);

afterAll(async () => {
  await t.close();
});

describe("snapshot catalogue", () => {
  it("describes every known type for the builder", () => {
    const cat = snapshotCatalogue();
    expect(knownObjectTypes()).toContain("rfi");
    const rfi = cat.find((c) => c.objectType === "rfi")!;
    expect(rfi.projectScoped).toBe(true);
    expect(rfi.assignField).toBe("assigneeId");
    expect(rfi.dueField).toBe("dueDate");
    expect(rfi.fields.map((f) => f.path)).toEqual(expect.arrayContaining(["status", "dueDate", "ballInCourtId", "createdAt"]));
    expect(rfi.fields.find((f) => f.path === "status")?.options).toContain("open");
    const vendor = cat.find((c) => c.objectType === "vendor")!;
    expect(vendor.projectScoped).toBe(false);
    expect(snapshotEntry("widget")).toBeUndefined();
  });
});

describe("loadSnapshot", () => {
  it("loads a record with its project and title, tenant-checked", async () => {
    const snap = await loadSnapshot(t.app.db, owner.companyId, "rfi", rfiOpen);
    expect(snap).not.toBeNull();
    expect(snap!.projectId).toBe(projectId);
    expect(snap!.title).toBe("Open one");
    expect(snap!.record["status"]).toBe("draft");
  });

  it("never returns another tenant's record, an unknown type, or a missing row", async () => {
    expect(await loadSnapshot(t.app.db, outsider.companyId, "rfi", rfiOpen)).toBeNull();
    expect(await loadSnapshot(t.app.db, owner.companyId, "widget", rfiOpen)).toBeNull();
    expect(await loadSnapshot(t.app.db, owner.companyId, "rfi", "rfi_nope")).toBeNull();
  });

  it("checks tenancy through the project for tables without a company column", async () => {
    const taskId = newId("task");
    await t.app.db.insert(scheduleTasks).values({ id: taskId, scheduleId: newId("sch"), projectId, name: "Pour slab" });
    const mine = await loadSnapshot(t.app.db, owner.companyId, "schedule_task", taskId);
    expect(mine?.projectId).toBe(projectId);
    expect(mine?.title).toBe("Pour slab");
    expect(await loadSnapshot(t.app.db, outsider.companyId, "schedule_task", taskId)).toBeNull();
  });
});

describe("scanCandidates", () => {
  it("returns only live records of this company, bounded and optionally per project", async () => {
    const all = await scanCandidates(t.app.db, owner.companyId, "rfi", null);
    const ids = all.map((c) => c.record["id"]);
    expect(ids).toContain(rfiOpen);
    expect(ids).not.toContain(rfiClosed);
    expect(all.length).toBe(2);
    const scoped = await scanCandidates(t.app.db, owner.companyId, "rfi", projectId);
    expect(scoped.map((c) => c.record["id"])).toEqual([rfiOpen]);
    expect(await scanCandidates(t.app.db, owner.companyId, "rfi", null, 1)).toHaveLength(1);
    expect(await scanCandidates(t.app.db, outsider.companyId, "rfi", null)).toHaveLength(0);
    expect(await scanCandidates(t.app.db, owner.companyId, "widget", null)).toHaveLength(0);
  });

  it("scans company-level types per company and refuses to scan them per project", async () => {
    await t.app.db.insert(vendors).values({ id: newId("vnd"), companyId: owner.companyId, name: "Acme Steel" });
    const perCompany = await scanCandidates(t.app.db, owner.companyId, "vendor", null);
    expect(perCompany.map((c) => c.title)).toContain("Acme Steel");
    expect(await scanCandidates(t.app.db, owner.companyId, "vendor", projectId)).toEqual([]);
  });

  it("bounds a no-company-column type to this company's projects", async () => {
    const mine = await scanCandidates(t.app.db, owner.companyId, "schedule_task", null);
    expect(mine.map((c) => c.title)).toContain("Pour slab");
    expect(await scanCandidates(t.app.db, outsider.companyId, "schedule_task", null)).toEqual([]);
  });
});

describe("assignRecord", () => {
  it("writes the type's assign column inside the tenant only", async () => {
    const ok = await assignRecord(t.app.db, owner.companyId, "rfi", rfiOpen, outsider.userId);
    expect(ok).toEqual({ ok: true, field: "assigneeId" });
    const [row] = await t.app.db.select({ assigneeId: rfis.assigneeId }).from(rfis).where(eq(rfis.id, rfiOpen));
    expect(row?.assigneeId).toBe(outsider.userId);
    const foreign = await assignRecord(t.app.db, outsider.companyId, "rfi", rfiOpen, outsider.userId);
    expect(foreign.ok).toBe(false);
    expect(foreign.reason).toContain("not found in this company");
  });

  it("reports types without an assignable field instead of failing", async () => {
    const r = await assignRecord(t.app.db, owner.companyId, "invoice", "inv_x", owner.userId);
    expect(r.ok).toBe(false);
    expect(r.field).toBeNull();
    expect(r.reason).toContain("no assignable field");
    expect((await assignRecord(t.app.db, owner.companyId, "widget", "w", owner.userId)).ok).toBe(false);
  });
});
