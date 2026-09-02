/**
 * Correspondence — types, the letter register, the approval workflow,
 * recipients and acknowledgement, inbound email capture, the response sweep
 * and tenant isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  companyMemberships,
  contacts,
  correspondenceInboundMessages,
  correspondenceLetters,
  files,
  ledgerEntries,
  notifications,
  obligations,
  projectMemberships,
  projects,
  signals,
  vendors,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO } from "./engines/dates.js";
import { correspondenceModule } from "./index.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let approver: TestActor;
let viewerHeaders: Record<string, string>;
let stranger: TestActor;
let projectId: string;
let vendorId: string;
let contactId: string;
let fileId: string;
let letterTypeId: string;
let noticeTypeId: string;

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
  if (!app.scheduler.has("correspondence.response-due")) {
    await app.register(correspondenceModule, { prefix: "/api/v1" });
  }
  owner = await registerActor(app);

  approver = await registerActor(app);
  await app.db
    .insert(companyMemberships)
    .values({ id: newId("cm"), companyId: owner.companyId, userId: approver.userId, role: "admin" });
  approver = {
    ...approver,
    companyId: owner.companyId,
    headers: { authorization: approver.headers["authorization"]!, "x-company-id": owner.companyId },
  };

  const viewer = await registerActor(app);
  await app.db
    .insert(companyMemberships)
    .values({ id: newId("cm"), companyId: owner.companyId, userId: viewer.userId, role: "member" });
  viewerHeaders = {
    authorization: viewer.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };

  stranger = await registerActor(app);

  projectId = newId("prj");
  await app.db
    .insert(projects)
    .values({ id: projectId, companyId: owner.companyId, name: "Correspondence — letters", stage: "course_of_construction" });
  await app.db.insert(projectMemberships).values({
    id: newId("pm"),
    companyId: owner.companyId,
    projectId,
    userId: viewer.userId,
    templateKey: "read_only",
  });

  vendorId = newId("ven");
  await app.db.insert(vendors).values({ id: vendorId, companyId: owner.companyId, name: "Steelwork Ltd" });
  contactId = newId("con");
  await app.db.insert(contacts).values({
    id: contactId,
    companyId: owner.companyId,
    vendorId,
    name: "Ana Silva",
    email: "ana@steelwork.example",
  });
  fileId = newId("fil");
  await app.db.insert(files).values({
    id: fileId,
    companyId: owner.companyId,
    projectId,
    name: "notice.pdf",
    contentType: "application/pdf",
    sizeBytes: 12,
    sha256: "a".repeat(64),
    storageKey: "test/notice.pdf",
    metadata: {},
    uploadedBy: owner.userId,
  });
}, 180_000);

afterAll(async () => {
  await built.close();
}, 60_000);

/* ================================================================== */
/* Types                                                               */
/* ================================================================== */

describe("correspondence types (#440, #445)", () => {
  it("seeds the default library and is idempotent", async () => {
    const first = await post("/correspondence/types/seed");
    expect(first.statusCode).toBe(201);
    expect(first.json().created).toContain("letter");
    const again = await post("/correspondence/types/seed");
    expect(again.statusCode).toBe(200);
    expect(again.json().created).toEqual([]);
    expect(again.json().skipped).toContain("notice");

    const list = await get("/correspondence/types");
    expect(list.statusCode).toBe(200);
    const items = list.json().items as Array<{ id: string; key: string; prefix: string }>;
    letterTypeId = items.find((t) => t.key === "letter")!.id;
    noticeTypeId = items.find((t) => t.key === "notice")!.id;
    expect(items.find((t) => t.key === "eot_notice")?.prefix).toBe("EOT");
  });

  it("refuses a response-requiring type with no response period", async () => {
    const res = await post("/correspondence/types", {
      key: "bad_type",
      name: "Bad",
      prefix: "BAD",
      requiresResponse: true,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("response period");
  });

  it("refuses a duplicate key and allows an ordinary member no write", async () => {
    const dup = await post("/correspondence/types", { key: "letter", name: "Dup", prefix: "DUP" });
    expect(dup.statusCode).toBe(409);
    const asViewer = await post(
      "/correspondence/types",
      { key: "viewer_type", name: "Nope", prefix: "NOP" },
      viewerHeaders,
    );
    expect(asViewer.statusCode).toBe(403);
  });

  it("deactivates rather than deletes a type that letters already use", async () => {
    const created = await post("/correspondence/types", {
      key: "temp_type",
      name: "Temporary",
      prefix: "TMP",
    });
    expect(created.statusCode).toBe(201);
    const tempId = created.json().id as string;
    const letter = await post(`/projects/${projectId}/correspondence/letters`, {
      typeId: tempId,
      subject: "Uses the temporary type",
    });
    expect(letter.statusCode).toBe(201);
    const removed = await del(`/correspondence/types/${tempId}`);
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ deleted: false, deactivated: true, letterCount: 1 });
  });

  it("is invisible to another tenant", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/correspondence/types",
      headers: stranger.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
    const crossTenant = await app.inject({
      method: "GET",
      url: "/api/v1/correspondence/types",
      headers: { authorization: stranger.headers["authorization"]!, "x-company-id": owner.companyId },
    });
    expect(crossTenant.statusCode).toBe(403);
  });
});

/* ================================================================== */
/* Letters                                                             */
/* ================================================================== */

let letterId: string;
let letterReference: string;

describe("letters (#441, #444, #446)", () => {
  it("numbers a letter per type and derives the response date from the type", async () => {
    const res = await post(`/projects/${projectId}/correspondence/letters`, {
      typeId: noticeTypeId,
      subject: "Notice of delay to the steel frame",
      body: "Delivery of the primary steel slipped by two weeks.",
      letterDate: today,
      fileIds: [fileId],
      recipients: [
        { partyType: "contact", partyId: contactId, kind: "to", acknowledgementRequired: true },
        { partyType: "user", partyId: approver.userId, kind: "cc" },
      ],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    letterId = body.id;
    letterReference = body.reference;
    expect(body.reference).toMatch(/^NOT-\d{3}$/);
    expect(body.status).toBe("draft");
    expect(body.isContractual).toBe(1);
    expect(body.responseRequired).toBe(1);
    expect(body.responseDueDate).toBe(addDaysISO(today, 7));
    expect(body.threadId).toBe(body.id);
    expect(body.recipients).toHaveLength(2);
    // the contact's name and address were taken from the directory, not typed
    expect(body.recipients[0].name).toBe("Ana Silva");
    expect(body.recipients[0].email).toBe("ana@steelwork.example");
  });

  it("ledgers the creation", async () => {
    const rows = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectType, "correspondence_letter"),
          eq(ledgerEntries.objectId, letterId),
        ),
      );
    expect(rows.length).toBeGreaterThan(0);
  });

  it("rejects a file that belongs to nobody", async () => {
    const res = await post(`/projects/${projectId}/correspondence/letters`, {
      typeId: letterTypeId,
      subject: "Bad attachment",
      fileIds: ["fil_does_not_exist"],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("not found in this company");
  });

  it("refuses to issue a letter with no recipients", async () => {
    const draft = await post(`/projects/${projectId}/correspondence/letters`, {
      typeId: letterTypeId,
      subject: "Nobody is listening",
    });
    const res = await post(
      `/projects/${projectId}/correspondence/letters/${draft.json().id}/issue`,
      {},
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("no recipients");
  });

  it("issues the letter, opens an obligation for the response and notifies user recipients", async () => {
    const res = await post(`/projects/${projectId}/correspondence/letters/${letterId}/issue`, {
      issueDate: today,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("issued");
    expect(body.obligationId).toBeTruthy();

    const obligation = (
      await app.db.select().from(obligations).where(eq(obligations.id, body.obligationId))
    )[0];
    expect(obligation?.status).toBe("open");
    expect(obligation?.deadline?.slice(0, 10)).toBe(addDaysISO(today, 7));

    const notified = await app.db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.userId, approver.userId), eq(notifications.recordId, letterId)),
      );
    expect(notified.length).toBeGreaterThan(0);
  });

  it("freezes an issued letter against edits", async () => {
    const res = await patch(`/projects/${projectId}/correspondence/letters/${letterId}`, {
      subject: "Rewriting history",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("contractual act");
  });

  it("records an acknowledgement and a read receipt, and moves the letter to acknowledged", async () => {
    const detail = await get(`/projects/${projectId}/correspondence/letters/${letterId}`);
    const recipient = detail.json().recipients.find((r: { kind: string }) => r.kind === "to");
    const read = await post(`/projects/${projectId}/correspondence/recipients/${recipient.id}/read`);
    expect(read.statusCode).toBe(200);
    expect(read.json().readCount).toBe(1);
    expect(read.json().deliveryStatus).toBe("delivered");

    const ack = await post(
      `/projects/${projectId}/correspondence/recipients/${recipient.id}/acknowledge`,
      { note: "Received, under review." },
    );
    expect(ack.statusCode).toBe(200);
    expect(ack.json().acknowledgedAt).toBeTruthy();

    const again = await post(
      `/projects/${projectId}/correspondence/recipients/${recipient.id}/acknowledge`,
      {},
    );
    expect(again.statusCode).toBe(409);

    const after = await get(`/projects/${projectId}/correspondence/letters/${letterId}`);
    expect(after.json().status).toBe("acknowledged");
    expect(after.json().assessment.ballInCourt).toBe("recipient");

    const removal = await del(`/projects/${projectId}/correspondence/recipients/${recipient.id}`);
    expect(removal.statusCode).toBe(409);
    expect(removal.json().message).toContain("acknowledged");
  });

  it("records a response, settles the obligation and stops chasing", async () => {
    const before = await get(`/projects/${projectId}/correspondence/letters/${letterId}`);
    const obligationId = before.json().obligationId as string;
    const res = await post(`/projects/${projectId}/correspondence/letters/${letterId}/respond`, {
      note: "Answered by telephone, confirmed in writing.",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("responded");
    const obligation = (
      await app.db.select().from(obligations).where(eq(obligations.id, obligationId))
    )[0];
    expect(obligation?.status).toBe("satisfied");

    const after = await get(`/projects/${projectId}/correspondence/letters/${letterId}`);
    expect(after.json().assessment.awaitingResponse).toBe(false);
    expect(after.json().assessment.ballInCourt).toBe("none");
  });

  it("creates a reply on the same thread with the direction flipped", async () => {
    const res = await post(`/projects/${projectId}/correspondence/letters/${letterId}/reply`, {
      body: "Our position on the delay.",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().threadId).toBe(letterId);
    expect(res.json().inReplyToId).toBe(letterId);
    expect(res.json().direction).toBe("inbound");
    expect(res.json().subject).toBe(`Re: Notice of delay to the steel frame`);

    const detail = await get(`/projects/${projectId}/correspondence/letters/${letterId}`);
    expect(detail.json().thread.length).toBeGreaterThanOrEqual(2);
  });

  it("filters the register and exports it", async () => {
    const contractual = await get(
      `/projects/${projectId}/correspondence/letters?contractualOnly=true&pageSize=100`,
    );
    expect(contractual.statusCode).toBe(200);
    const items = contractual.json().items as Array<{ isContractual: number }>;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.isContractual === 1)).toBe(true);

    const search = await get(
      `/projects/${projectId}/correspondence/letters?q=${encodeURIComponent("steel frame")}`,
    );
    expect(search.json().items.length).toBeGreaterThan(0);

    const csv = await get(`/projects/${projectId}/correspondence/register`);
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.split("\n")[0]).toContain("ball_in_court");
    expect(csv.body).toContain(letterReference);
  });

  it("voids a letter with a reason and refuses a second void", async () => {
    const draft = await post(`/projects/${projectId}/correspondence/letters`, {
      typeId: letterTypeId,
      subject: "Sent in error",
      recipients: [{ partyType: "external", name: "Site agent", email: "agent@x.example" }],
    });
    const id = draft.json().id as string;
    await post(`/projects/${projectId}/correspondence/letters/${id}/issue`, {});
    const voided = await post(`/projects/${projectId}/correspondence/letters/${id}/void`, {
      reason: "Issued to the wrong party",
    });
    expect(voided.statusCode).toBe(200);
    expect(voided.json().status).toBe("void");
    const again = await post(`/projects/${projectId}/correspondence/letters/${id}/void`, {
      reason: "again",
    });
    expect(again.statusCode).toBe(409);
  });
});

/* ================================================================== */
/* Approval workflow                                                   */
/* ================================================================== */

describe("configurable approval workflow (#445)", () => {
  let workflowTypeId: string;
  let workflowLetterId: string;

  it("creates a type with an approval step", async () => {
    const res = await post("/correspondence/types", {
      key: "instruction_approved",
      name: "Approved instruction",
      prefix: "AIN",
      requiresResponse: true,
      responseDays: 5,
      isContractual: true,
      approvalSteps: [{ name: "Commercial manager", role: "admin" }],
    });
    expect(res.statusCode).toBe(201);
    workflowTypeId = res.json().id;
  });

  it("refuses to submit a type with no workflow", async () => {
    const draft = await post(`/projects/${projectId}/correspondence/letters`, {
      typeId: letterTypeId,
      subject: "No workflow here",
    });
    const res = await post(
      `/projects/${projectId}/correspondence/letters/${draft.json().id}/submit`,
      {},
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("no approval workflow");
  });

  it("blocks issue while an approval is outstanding", async () => {
    const draft = await post(`/projects/${projectId}/correspondence/letters`, {
      typeId: workflowTypeId,
      subject: "Instruction to open up the works",
      recipients: [{ partyType: "vendor", partyId: vendorId, name: "Steelwork Ltd" }],
    });
    workflowLetterId = draft.json().id;
    const submitted = await post(
      `/projects/${projectId}/correspondence/letters/${workflowLetterId}/submit`,
      {},
    );
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json().status).toBe("pending_approval");

    const issue = await post(
      `/projects/${projectId}/correspondence/letters/${workflowLetterId}/issue`,
      {},
    );
    expect(issue.statusCode).toBe(409);
    expect(issue.json().message).toContain("approval step");
  });

  it("refuses an approval by the letter's own author", async () => {
    const detail = await get(`/projects/${projectId}/correspondence/letters/${workflowLetterId}`);
    const approvalId = detail.json().approvals[0].id as string;
    const res = await post(
      `/projects/${projectId}/correspondence/letters/${workflowLetterId}/approvals/${approvalId}/decide`,
      { decision: "approved" },
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("cannot approve it");
  });

  it("accepts an approval by a different admin and then issues", async () => {
    const detail = await get(`/projects/${projectId}/correspondence/letters/${workflowLetterId}`);
    const approvalId = detail.json().approvals[0].id as string;
    const decided = await post(
      `/projects/${projectId}/correspondence/letters/${workflowLetterId}/approvals/${approvalId}/decide`,
      { decision: "approved", comment: "Content agreed." },
      approver.headers,
    );
    expect(decided.statusCode).toBe(200);
    expect(decided.json().readyToIssue).toBe(true);

    const issue = await post(
      `/projects/${projectId}/correspondence/letters/${workflowLetterId}/issue`,
      {},
    );
    expect(issue.statusCode).toBe(200);
    expect(issue.json().status).toBe("issued");
  });

  it("sends a rejected letter back to draft and clears the pending steps", async () => {
    const draft = await post(`/projects/${projectId}/correspondence/letters`, {
      typeId: workflowTypeId,
      subject: "Instruction that will be rejected",
      recipients: [{ partyType: "external", name: "Site agent" }],
    });
    const id = draft.json().id as string;
    await post(`/projects/${projectId}/correspondence/letters/${id}/submit`, {});
    const detail = await get(`/projects/${projectId}/correspondence/letters/${id}`);
    const approvalId = detail.json().approvals[0].id as string;
    const rejected = await post(
      `/projects/${projectId}/correspondence/letters/${id}/approvals/${approvalId}/decide`,
      { decision: "rejected", comment: "Wrong clause cited." },
      approver.headers,
    );
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().letterStatus).toBe("draft");
    const after = await get(`/projects/${projectId}/correspondence/letters/${id}`);
    expect(after.json().status).toBe("draft");
    expect(after.json().approvals.filter((a: { status: string }) => a.status === "pending")).toHaveLength(0);
  });
});

/* ================================================================== */
/* Inbound email (#99)                                                 */
/* ================================================================== */

describe("inbound email capture (#99)", () => {
  let targetId: string;
  let targetReference: string;

  beforeAll(async () => {
    const created = await post(`/projects/${projectId}/correspondence/letters`, {
      typeId: letterTypeId,
      subject: "Request for the revised programme",
      recipients: [{ partyType: "contact", partyId: contactId, acknowledgementRequired: false }],
    });
    targetId = created.json().id;
    targetReference = created.json().reference;
    await post(`/projects/${projectId}/correspondence/letters/${targetId}/issue`, {});
  }, 180_000);

  it("routes a reply onto the thread it quotes and answers the letter", async () => {
    const res = await post(`/projects/${projectId}/correspondence/inbound`, {
      email: {
        from: "Ana Silva <ana@steelwork.example>",
        to: ["pm@main.example"],
        subject: `RE: ${targetReference} Request for the revised programme`,
        text: "Programme attached.\n\nOn 1 Sep 2026, PM wrote:\n> please send it",
        messageId: "<reply-1@mail>",
        attachments: [{ fileId, filename: "programme.pdf" }],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.action).toBe("reply");
    expect(body.target.reference).toBe(targetReference);
    expect(body.senderResolved).toBe("contact");

    const created = (
      await app.db.select().from(correspondenceLetters).where(eq(correspondenceLetters.id, body.letterId))
    )[0];
    expect(created?.source).toBe("inbound_email");
    expect(created?.direction).toBe("inbound");
    expect(created?.threadId).toBe(targetId);
    expect(created?.body).toBe("Programme attached.");
    expect(created?.fileIds).toEqual([fileId]);

    const target = (
      await app.db.select().from(correspondenceLetters).where(eq(correspondenceLetters.id, targetId))
    )[0];
    expect(target?.status).toBe("responded");
    expect(target?.responseLetterId).toBe(body.letterId);
  });

  it("is idempotent on a redelivered message id", async () => {
    const before = await app.db
      .select()
      .from(correspondenceInboundMessages)
      .where(eq(correspondenceInboundMessages.projectId, projectId));
    const res = await post(`/projects/${projectId}/correspondence/inbound`, {
      email: {
        from: "ana@steelwork.example",
        subject: `RE: ${targetReference} Request for the revised programme`,
        text: "again",
        messageId: "<reply-1@mail>",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().action).toBe("duplicate");
    const after = await app.db
      .select()
      .from(correspondenceInboundMessages)
      .where(eq(correspondenceInboundMessages.projectId, projectId));
    expect(after.length).toBe(before.length);
  });

  it("flags a quoted reference this project never issued and still files the message", async () => {
    const res = await post(`/projects/${projectId}/correspondence/inbound`, {
      email: {
        from: "unknown@elsewhere.example",
        subject: "Re: LTR-987 something we never sent",
        text: "Are you still there?",
        messageId: "<orphan@mail>",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().action).toBe("unmatched");
    expect(res.json().reason).toContain("no such record");
    expect(res.json().letterId).toBeTruthy();
    expect(res.json().senderResolved).toBe("external");

    const register = await get(`/projects/${projectId}/correspondence/inbound?status=unmatched`);
    expect(register.json().items.length).toBeGreaterThan(0);
  });

  it("captures a brand new inbound letter when there is no reference at all", async () => {
    const res = await post(`/projects/${projectId}/correspondence/inbound`, {
      email: {
        from: "Site Manager <sm@sub.example>",
        subject: "Access to level 3 next week",
        html: "<p>We need the hoist from Monday.</p>",
        messageId: "<fresh@mail>",
      },
      signatureVerified: true,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().action).toBe("new");
    const message = (
      await app.db
        .select()
        .from(correspondenceInboundMessages)
        .where(eq(correspondenceInboundMessages.id, res.json().messageId))
    )[0];
    expect(message?.signatureVerified).toBe(1);
    expect(message?.bodyText).toBe("We need the hoist from Monday.");
    expect(message?.status).toBe("created");
  });

  it("refuses an inbound message from another tenant", async () => {
    const res = await post(
      `/projects/${projectId}/correspondence/inbound`,
      { email: { from: "x@y.z", subject: "hello", text: "hi" } },
      stranger.headers,
    );
    expect(res.statusCode).toBe(403);
  });
});

/* ================================================================== */
/* Response sweep                                                      */
/* ================================================================== */

describe("response-due sweep (#446)", () => {
  let overdueId: string;

  it("raises exactly one signal for an overdue response and chases once", async () => {
    const created = await post(`/projects/${projectId}/correspondence/letters`, {
      typeId: noticeTypeId,
      subject: "Notice requiring an urgent answer",
      letterDate: addDaysISO(today, -30),
      responseDueDate: addDaysISO(today, -20),
      recipients: [{ partyType: "external", name: "Employer's agent", email: "ea@x.example" }],
    });
    overdueId = created.json().id;
    await post(`/projects/${projectId}/correspondence/letters/${overdueId}/issue`, {
      issueDate: addDaysISO(today, -30),
      responseDueDate: addDaysISO(today, -20),
    });

    const first = await post(`/projects/${projectId}/correspondence/sweeps/run`, {});
    expect(first.statusCode).toBe(200);
    expect(first.json().responses.raised).toBeGreaterThanOrEqual(1);

    const second = await post(`/projects/${projectId}/correspondence/sweeps/run`, {});
    expect(second.json().responses.raised).toBe(0);
    expect(second.json().responses.notified).toBe(0);

    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.detector, "correspondence_response_overdue"),
        ),
      );
    expect(raised).toHaveLength(1);
    expect(raised[0]?.title).toContain("20 days");
  });

  it("exposes the signal on the module's own endpoint", async () => {
    const res = await get(`/projects/${projectId}/correspondence/signals`);
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBeGreaterThan(0);
  });

  it("runs from the scheduler with the system actor", async () => {
    expect(app.scheduler.has("correspondence.response-due")).toBe(true);
    const status = await app.scheduler.runNow("correspondence.response-due");
    expect(status.state).toBe("succeeded");
  });

  it("summarises the register and reports health inputs honestly", async () => {
    const summary = await get(`/projects/${projectId}/correspondence/summary`);
    expect(summary.statusCode).toBe(200);
    const body = summary.json();
    expect(body.letters.total).toBeGreaterThan(0);
    expect(body.letters.overdue).toBeGreaterThanOrEqual(1);
    expect(body.inbound.captured).toBeGreaterThan(0);

    const health = await get(`/projects/${projectId}/correspondence/health-inputs`);
    expect(health.statusCode).toBe(200);
    expect(health.json().metrics.lettersOverdue).toBeGreaterThanOrEqual(1);
    expect(health.json().metrics).toHaveProperty("averageResponseDays");
  });
});

/* ================================================================== */
/* Tenant isolation                                                    */
/* ================================================================== */

describe("tenant isolation", () => {
  it("refuses every project route to a stranger", async () => {
    for (const url of [
      `/projects/${projectId}/correspondence/letters`,
      `/projects/${projectId}/correspondence/summary`,
      `/projects/${projectId}/correspondence/register`,
      `/projects/${projectId}/correspondence/health-inputs`,
    ]) {
      const res = await get(url, stranger.headers);
      expect(res.statusCode).toBe(403);
    }
    const write = await post(
      `/projects/${projectId}/correspondence/letters`,
      { typeId: letterTypeId, subject: "Not yours" },
      stranger.headers,
    );
    expect(write.statusCode).toBe(403);
  });

  it("hides another tenant's letter from an id-scoped read", async () => {
    const otherProject = newId("prj");
    await app.db
      .insert(projects)
      .values({ id: otherProject, companyId: stranger.companyId, name: "Their project", stage: "planning" });
    const res = await get(
      `/projects/${otherProject}/correspondence/letters/${letterId}`,
      stranger.headers,
    );
    expect(res.statusCode).toBe(404);
  });

  it("lets a read-only member read but not write", async () => {
    const read = await get(`/projects/${projectId}/correspondence/letters`, viewerHeaders);
    expect(read.statusCode).toBe(200);
    const write = await post(
      `/projects/${projectId}/correspondence/letters`,
      { typeId: letterTypeId, subject: "Read-only should fail" },
      viewerHeaders,
    );
    expect(write.statusCode).toBe(403);
  });
});
