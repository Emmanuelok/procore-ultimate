/**
 * Transmittals — issue with a purpose, item revisions frozen from the
 * register that owns them, per-recipient acknowledgement, the ack sweep and
 * tenant isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  companyMemberships,
  contacts,
  drawingRevisions,
  drawingSets,
  drawingSheets,
  files,
  obligations,
  projectMemberships,
  projects,
  signals,
  transmittals,
  vendors,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO } from "./engines/dates.js";
import { correspondenceModule } from "./index.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let recipientUser: TestActor;
let stranger: TestActor;
let viewerHeaders: Record<string, string>;
let projectId: string;
let fileId: string;
let sheetId: string;
let contactId: string;
let vendorId: string;

const today = new Date().toISOString().slice(0, 10);

const post = (url: string, payload?: unknown, headers = owner.headers) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload: payload ?? {} });
const patch = (url: string, payload: unknown, headers = owner.headers) =>
  app.inject({ method: "PATCH", url: `/api/v1${url}`, headers, payload });
const get = (url: string, headers = owner.headers) =>
  app.inject({ method: "GET", url: `/api/v1${url}`, headers });
const del = (url: string, headers = owner.headers) =>
  app.inject({ method: "DELETE", url: `/api/v1${url}`, headers });

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  if (!app.scheduler.has("correspondence.ack-due")) {
    await app.register(correspondenceModule, { prefix: "/api/v1" });
  }
  owner = await registerActor(app);

  recipientUser = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: recipientUser.userId,
    role: "member",
  });
  recipientUser = {
    ...recipientUser,
    companyId: owner.companyId,
    headers: {
      authorization: recipientUser.headers["authorization"]!,
      "x-company-id": owner.companyId,
    },
  };

  stranger = await registerActor(app);

  projectId = newId("prj");
  await app.db.insert(projects).values({
    id: projectId,
    companyId: owner.companyId,
    name: "Correspondence — transmittals",
    stage: "course_of_construction",
  });
  await app.db.insert(projectMemberships).values({
    id: newId("pm"),
    companyId: owner.companyId,
    projectId,
    userId: recipientUser.userId,
    templateKey: "read_only",
  });
  viewerHeaders = recipientUser.headers;

  vendorId = newId("ven");
  await app.db.insert(vendors).values({ id: vendorId, companyId: owner.companyId, name: "Cladding Co" });
  contactId = newId("con");
  await app.db.insert(contacts).values({
    id: contactId,
    companyId: owner.companyId,
    vendorId,
    name: "Ravi Patel",
    email: "ravi@cladding.example",
  });

  fileId = newId("fil");
  await app.db.insert(files).values({
    id: fileId,
    companyId: owner.companyId,
    projectId,
    name: "cladding-spec.pdf",
    contentType: "application/pdf",
    sizeBytes: 20,
    sha256: "b".repeat(64),
    storageKey: "test/cladding.pdf",
    revisionLabel: "P02",
    metadata: {},
    uploadedBy: owner.userId,
  });

  const setId = newId("dst");
  await app.db.insert(drawingSets).values({
    id: setId,
    companyId: owner.companyId,
    projectId,
    name: "Construction issue",
    uploadedBy: owner.userId,
  });
  sheetId = newId("dsh");
  await app.db.insert(drawingSheets).values({
    id: sheetId,
    companyId: owner.companyId,
    projectId,
    number: "A-201",
    title: "Level 2 general arrangement",
    discipline: "architectural",
  });
  const revisionId = newId("drv");
  await app.db.insert(drawingRevisions).values({
    id: revisionId,
    sheetId,
    setId,
    revision: "C",
    fileId,
    uploadedBy: owner.userId,
  });
  await app.db
    .update(drawingSheets)
    .set({ currentRevisionId: revisionId })
    .where(eq(drawingSheets.id, sheetId));

  await post("/correspondence/types/seed");
}, 180_000);

afterAll(async () => {
  await built.close();
}, 60_000);

let transmittalId: string;
let reference: string;

describe("transmittals (#442)", () => {
  it("numbers a transmittal and copies each item's revision from the register that owns it", async () => {
    const res = await post(`/projects/${projectId}/correspondence/transmittals`, {
      subject: "Level 2 cladding package",
      purpose: "for_construction",
      method: "portal",
      ackDueDate: addDaysISO(today, 5),
      items: [
        { itemType: "drawing_sheet", itemId: sheetId },
        { itemType: "file", itemId: fileId },
        { itemType: "other", title: "Hard copy sample board", copies: 2 },
      ],
      recipients: [
        { partyType: "contact", partyId: contactId, name: "Ravi Patel", acknowledgementRequired: true },
        { partyType: "user", partyId: recipientUser.userId, name: "Site engineer", acknowledgementRequired: true },
        { partyType: "external", name: "Building control", acknowledgementRequired: false, kind: "cc" },
      ],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    transmittalId = body.id;
    reference = body.reference;
    expect(reference).toMatch(/^TR-\d{3}$/);
    expect(body.status).toBe("draft");
    expect(body.items).toHaveLength(3);
    const sheetItem = body.items.find((i: { itemType: string }) => i.itemType === "drawing_sheet");
    expect(sheetItem.title).toBe("A-201 — Level 2 general arrangement");
    expect(sheetItem.revision).toBe("C");
    const fileItem = body.items.find((i: { itemType: string }) => i.itemType === "file");
    expect(fileItem.revision).toBe("P02");
  });

  it("refuses an item that belongs to another project", async () => {
    const res = await post(`/projects/${projectId}/correspondence/transmittals/${transmittalId}/items`, {
      items: [{ itemType: "drawing_sheet", itemId: "dsh_nope" }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("not found in this project");
  });

  it("refuses to issue a transmittal with no items", async () => {
    const empty = await post(`/projects/${projectId}/correspondence/transmittals`, {
      subject: "Nothing attached",
      recipients: [{ partyType: "external", name: "Someone" }],
    });
    const res = await post(
      `/projects/${projectId}/correspondence/transmittals/${empty.json().id}/issue`,
      {},
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("no items");
  });

  it("issues it, opens an acknowledgement obligation and marks recipients sent", async () => {
    const res = await post(
      `/projects/${projectId}/correspondence/transmittals/${transmittalId}/issue`,
      { issueDate: today },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("issued");
    expect(res.json().position.required).toBe(2);
    expect(res.json().position.acknowledged).toBe(0);

    const record = (
      await app.db.select().from(transmittals).where(eq(transmittals.id, transmittalId))
    )[0];
    expect(record?.obligationId).toBeTruthy();
    const obligation = (
      await app.db.select().from(obligations).where(eq(obligations.id, record!.obligationId!))
    )[0];
    expect(obligation?.status).toBe("open");

    const detail = await get(`/projects/${projectId}/correspondence/transmittals/${transmittalId}`);
    expect(
      detail.json().recipients.every((r: { deliveryStatus: string }) => r.deliveryStatus === "sent"),
    ).toBe(true);
  });

  it("freezes contents after issue but still lets the ack deadline move", async () => {
    const frozen = await patch(
      `/projects/${projectId}/correspondence/transmittals/${transmittalId}`,
      { subject: "Rewritten" },
    );
    expect(frozen.statusCode).toBe(409);
    expect(frozen.json().message).toContain("frozen");

    const items = await post(
      `/projects/${projectId}/correspondence/transmittals/${transmittalId}/items`,
      { items: [{ itemType: "other", title: "Late addition" }] },
    );
    expect(items.statusCode).toBe(409);

    const extended = await patch(
      `/projects/${projectId}/correspondence/transmittals/${transmittalId}`,
      { ackDueDate: addDaysISO(today, 10) },
    );
    expect(extended.statusCode).toBe(200);
    expect(extended.json().ackDueDate).toBe(addDaysISO(today, 10));
  });

  it("tracks acknowledgement per recipient and walks the status", async () => {
    const detail = await get(`/projects/${projectId}/correspondence/transmittals/${transmittalId}`);
    const required = detail
      .json()
      .recipients.filter((r: { acknowledgementRequired: number }) => r.acknowledgementRequired === 1);
    expect(required).toHaveLength(2);

    await post(`/projects/${projectId}/correspondence/recipients/${required[0].id}/acknowledge`, {
      note: "Received",
    });
    const partial = await get(
      `/projects/${projectId}/correspondence/transmittals/${transmittalId}/acknowledgement`,
    );
    expect(partial.json().position.acknowledged).toBe(1);
    expect(partial.json().position.percent).toBe(50);
    expect(partial.json().position.outstandingNames).toHaveLength(1);

    // The engine's derived status lands on the record via the sweep/sync path.
    await post(`/projects/${projectId}/correspondence/sweeps/run`, {});
    const afterPartial = (
      await app.db.select().from(transmittals).where(eq(transmittals.id, transmittalId))
    )[0];
    expect(afterPartial?.status).toBe("partially_acknowledged");

    await post(`/projects/${projectId}/correspondence/recipients/${required[1].id}/acknowledge`, {});
    await post(`/projects/${projectId}/correspondence/sweeps/run`, {});
    const complete = (
      await app.db.select().from(transmittals).where(eq(transmittals.id, transmittalId))
    )[0];
    expect(complete?.status).toBe("acknowledged");
    expect(complete?.acknowledgedCount).toBe(2);
    // the acknowledgement obligation is settled the moment everyone answers
    expect(complete?.obligationId).toBeNull();
  });

  it("reports the acknowledgement rate as null when nobody was asked", async () => {
    const created = await post(`/projects/${projectId}/correspondence/transmittals`, {
      subject: "For information only",
      purpose: "for_information",
      ackRequired: false,
      items: [{ itemType: "other", title: "Meeting pack" }],
      recipients: [{ partyType: "external", name: "Everyone", acknowledgementRequired: false }],
    });
    const id = created.json().id as string;
    await post(`/projects/${projectId}/correspondence/transmittals/${id}/issue`, {});
    const res = await get(
      `/projects/${projectId}/correspondence/transmittals/${id}/acknowledgement`,
    );
    expect(res.json().position.percent).toBeNull();
    expect(res.json().position.reasons[0]).toContain("no acknowledgement rate");
  });
});

describe("acknowledgement sweep (#443)", () => {
  let lateId: string;

  it("raises one signal for an overdue acknowledgement and never a second", async () => {
    const created = await post(`/projects/${projectId}/correspondence/transmittals`, {
      subject: "Issued for construction, nobody replied",
      purpose: "for_construction",
      ackDueDate: addDaysISO(today, -6),
      items: [{ itemType: "drawing_sheet", itemId: sheetId }],
      recipients: [
        { partyType: "external", name: "Silent subcontractor", acknowledgementRequired: true },
      ],
    });
    lateId = created.json().id;
    await post(`/projects/${projectId}/correspondence/transmittals/${lateId}/issue`, {
      issueDate: addDaysISO(today, -14),
      ackDueDate: addDaysISO(today, -6),
    });

    const first = await post(`/projects/${projectId}/correspondence/sweeps/run`, {});
    expect(first.json().acknowledgements.raised).toBe(1);
    const second = await post(`/projects/${projectId}/correspondence/sweeps/run`, {});
    expect(second.json().acknowledgements.raised).toBe(0);
    expect(second.json().acknowledgements.notified).toBe(0);

    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "correspondence_ack_overdue")),
      );
    expect(raised).toHaveLength(1);
    expect(raised[0]?.severity).toBe("high");
    expect(raised[0]?.explanation).toContain("Silent subcontractor");
  });

  it("runs from the scheduler", async () => {
    const status = await app.scheduler.runNow("correspondence.ack-due");
    expect(status.state).toBe("succeeded");
  });

  it("flags outstanding acknowledgements in the register listing and the summary", async () => {
    const list = await get(
      `/projects/${projectId}/correspondence/transmittals?outstandingOnly=true&pageSize=100`,
    );
    expect(list.statusCode).toBe(200);
    expect(list.json().items.some((t: { id: string }) => t.id === lateId)).toBe(true);
    expect(list.json().items.find((t: { id: string }) => t.id === lateId).overdue).toBe(true);

    const summary = await get(`/projects/${projectId}/correspondence/summary`);
    expect(summary.json().transmittals.overdueAcks).toBeGreaterThanOrEqual(1);
    expect(summary.json().transmittals.acknowledgementRate.value).not.toBeNull();
  });

  it("closes a transmittal and waives the obligation when acknowledgements are missing", async () => {
    const before = (
      await app.db.select().from(transmittals).where(eq(transmittals.id, lateId))
    )[0];
    const res = await post(
      `/projects/${projectId}/correspondence/transmittals/${lateId}/close`,
      {},
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("closed");
    if (before?.obligationId) {
      const obligation = (
        await app.db.select().from(obligations).where(eq(obligations.id, before.obligationId))
      )[0];
      expect(obligation?.status).toBe("waived");
    }
  });
});

describe("tenant isolation", () => {
  it("refuses a stranger every transmittal route", async () => {
    const read = await get(`/projects/${projectId}/correspondence/transmittals`, stranger.headers);
    expect(read.statusCode).toBe(403);
    const detail = await get(
      `/projects/${projectId}/correspondence/transmittals/${transmittalId}`,
      stranger.headers,
    );
    expect(detail.statusCode).toBe(403);
    const write = await post(
      `/projects/${projectId}/correspondence/transmittals`,
      { subject: "Not yours" },
      stranger.headers,
    );
    expect(write.statusCode).toBe(403);
  });

  it("lets a read-only member read but not issue", async () => {
    const read = await get(`/projects/${projectId}/correspondence/transmittals`, viewerHeaders);
    expect(read.statusCode).toBe(200);
    const issue = await post(
      `/projects/${projectId}/correspondence/transmittals/${transmittalId}/close`,
      {},
      viewerHeaders,
    );
    expect(issue.statusCode).toBe(403);
  });

  it("does not let a stranger delete a recipient", async () => {
    const detail = await get(`/projects/${projectId}/correspondence/transmittals/${transmittalId}`);
    const recipientId = detail.json().recipients[0].id as string;
    const res = await del(
      `/projects/${projectId}/correspondence/recipients/${recipientId}`,
      stranger.headers,
    );
    expect(res.statusCode).toBe(403);
  });
});
