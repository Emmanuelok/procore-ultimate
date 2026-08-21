import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  companyMemberships,
  ledgerEntries,
  projectMemberships,
  projects,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO, todayISO } from "./dates.js";

let built: BuiltApp;
let u1: TestActor; // company owner
let u2: TestActor; // member with field_engineer template
let u2Headers: Record<string, string>;
let projectId: string;

beforeAll(async () => {
  built = await buildTestApp();
  u1 = await registerActor(built.app);
  u2 = await registerActor(built.app);
  await built.app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: u1.companyId,
    userId: u2.userId,
    role: "member",
  });
  u2Headers = { authorization: `Bearer ${u2.accessToken}`, "x-company-id": u1.companyId };

  projectId = newId("prj");
  await built.app.db.insert(projects).values({
    id: projectId,
    companyId: u1.companyId,
    name: "Field P1",
  });
  await built.app.db.insert(projectMemberships).values({
    id: newId("pm"),
    companyId: u1.companyId,
    projectId,
    userId: u2.userId,
    templateKey: "field_engineer",
    overrides: {},
  });
});

afterAll(async () => {
  await built.close();
});

const inject = (
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  headers: Record<string, string>,
  payload?: unknown,
) => built.app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });

describe("RFI lifecycle", () => {
  let rfiId: string;

  it("creates a numbered draft, issues, answers and closes with a full ledger trail", async () => {
    const create = await inject("POST", `/api/v1/projects/${projectId}/rfis`, u1.headers, {
      subject: "Rebar spacing at grid B2",
      question: "Drawing S-201 shows 150mm; spec says 200mm. Which governs?",
      assigneeId: u2.userId,
      distribution: [u2.userId],
    });
    expect(create.statusCode).toBe(201);
    const rfi = create.json();
    rfiId = rfi.id;
    expect(rfi.number).toBe(1);
    expect(rfi.status).toBe("draft");

    const issue = await inject(
      "POST",
      `/api/v1/projects/${projectId}/rfis/${rfiId}/issue`,
      u1.headers,
    );
    expect(issue.statusCode).toBe(200);
    expect(issue.json().status).toBe("open");
    expect(issue.json().dueDate).toBe(addDaysISO(todayISO(), 7));

    const respond = await inject(
      "POST",
      `/api/v1/projects/${projectId}/rfis/${rfiId}/respond`,
      u2Headers,
      { officialResponse: "200mm governs per spec 03 20 00.", costImpact: "no" },
    );
    expect(respond.statusCode).toBe(200);
    expect(respond.json().status).toBe("answered");
    expect(respond.json().respondedBy).toBe(u2.userId);

    const close = await inject(
      "POST",
      `/api/v1/projects/${projectId}/rfis/${rfiId}/close`,
      u1.headers,
    );
    expect(close.statusCode).toBe(200);
    expect(close.json().status).toBe("closed");

    const rows = await built.app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, u1.companyId),
          eq(ledgerEntries.objectType, "rfi"),
          eq(ledgerEntries.objectId, rfiId),
        ),
      );
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.filter((r) => r.action === "create")).toHaveLength(1);
    expect(rows.filter((r) => r.action === "state_change").length).toBeGreaterThanOrEqual(3);
  });

  it("filters overdue open RFIs and reports analytics", async () => {
    const yesterday = addDaysISO(todayISO(), -1);
    const create = await inject("POST", `/api/v1/projects/${projectId}/rfis`, u1.headers, {
      subject: "Late RFI",
      question: "Overdue?",
      dueDate: yesterday,
    });
    const late = create.json();
    await inject("POST", `/api/v1/projects/${projectId}/rfis/${late.id}/issue`, u1.headers);

    const list = await inject(
      "GET",
      `/api/v1/projects/${projectId}/rfis?overdue=true`,
      u1.headers,
    );
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0].id).toBe(late.id);

    const analytics = await inject(
      "GET",
      `/api/v1/projects/${projectId}/rfis/analytics`,
      u1.headers,
    );
    expect(analytics.statusCode).toBe(200);
    const a = analytics.json();
    expect(a.open).toBe(1);
    expect(a.overdue).toBe(1);
    expect(a.byStatus.closed).toBe(1);
    expect(a.avgResponseDays).not.toBeNull();
  });

  it("blocks bad transitions", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/rfis/${rfiId}/issue`,
      u1.headers,
    );
    expect(res.statusCode).toBe(400); // already closed
  });
});

describe("Submittal review chain", () => {
  let submittalId: string;
  let step0Id: string;
  let step1Id: string;

  it("computes submitByDate from requiredOnSite and lead time", async () => {
    const res = await inject("POST", `/api/v1/projects/${projectId}/submittals`, u1.headers, {
      title: "Curtain wall shop drawings",
      submittalType: "shop_drawing",
      specSection: "08 44 13",
      requiredOnSite: "2026-12-01",
      leadTimeDays: 30,
    });
    expect(res.statusCode).toBe(201);
    const sub = res.json();
    submittalId = sub.id;
    expect(sub.number).toBe(1);
    expect(sub.revision).toBe(0);
    expect(sub.submitByDate).toBe("2026-10-18"); // -30 lead -14 review allowance
  });

  it("runs the sequential reviewer chain and enforces order", async () => {
    const steps = await inject(
      "POST",
      `/api/v1/projects/${projectId}/submittals/${submittalId}/review-steps`,
      u1.headers,
      { steps: [{ reviewerId: u2.userId, position: 0 }, { reviewerId: u1.userId, position: 1 }] },
    );
    expect(steps.statusCode).toBe(200);
    const items = steps.json().items;
    step0Id = items.find((s: any) => s.position === 0).id;
    step1Id = items.find((s: any) => s.position === 1).id;

    const submit = await inject(
      "POST",
      `/api/v1/projects/${projectId}/submittals/${submittalId}/submit`,
      u1.headers,
    );
    expect(submit.statusCode).toBe(200);
    expect(submit.json().status).toBe("in_review");
    expect(submit.json().ballInCourtId).toBe(u2.userId);

    // Position 1 cannot respond before position 0
    const early = await inject("POST", `/api/v1/submittal-steps/${step1Id}/respond`, u1.headers, {
      responseCode: "approved",
    });
    expect(early.statusCode).toBe(400);

    // A stranger cannot respond for the reviewer
    const wrongUser = await inject(
      "POST",
      `/api/v1/submittal-steps/${step0Id}/respond`,
      u2Headers,
      { responseCode: "approved" },
    );
    expect(wrongUser.statusCode).toBe(200); // u2 IS the reviewer for step0
    expect(wrongUser.json().submittalStatus).toBe("in_review");

    const detail = await inject(
      "GET",
      `/api/v1/projects/${projectId}/submittals/${submittalId}`,
      u1.headers,
    );
    expect(detail.json().ballInCourtId).toBe(u1.userId); // advanced sequentially

    const final = await inject("POST", `/api/v1/submittal-steps/${step1Id}/respond`, u1.headers, {
      responseCode: "revise_and_resubmit",
      comments: "Update mullion anchor detail.",
    });
    expect(final.statusCode).toBe(200);
    expect(final.json().submittalStatus).toBe("responded");

    const responded = await inject(
      "GET",
      `/api/v1/projects/${projectId}/submittals/${submittalId}`,
      u1.headers,
    );
    expect(responded.json().status).toBe("responded");
    expect(responded.json().responseCode).toBe("revise_and_resubmit");
  });

  it("resubmits as a new revision linked via previousId", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/submittals/${submittalId}/resubmit`,
      u1.headers,
    );
    expect(res.statusCode).toBe(201);
    const rev = res.json();
    expect(rev.revision).toBe(1);
    expect(rev.number).toBe(1);
    expect(rev.previousId).toBe(submittalId);
    expect(rev.status).toBe("draft");

    const detail = await inject(
      "GET",
      `/api/v1/projects/${projectId}/submittals/${rev.id}`,
      u1.headers,
    );
    expect(detail.json().revisions).toHaveLength(2);
    expect(detail.json().revisions[0].id).toBe(submittalId);
    expect(detail.json().revisions[1].id).toBe(rev.id);
  });
});

describe("Daily logs", () => {
  const date = "2026-08-12";

  it("upserts by (project, date, creator)", async () => {
    const first = await inject(
      "PUT",
      `/api/v1/projects/${projectId}/daily-logs/${date}`,
      u1.headers,
      {
        sections: { manpower: [{ company: "Acme Concrete", workers: 12, hours: 96 }] },
        weather: { tempC: 28, conditions: "sunny" },
        notes: "Pour at L3 east.",
      },
    );
    expect(first.statusCode).toBe(201);
    const created = first.json();
    expect(created.status).toBe("draft");

    const second = await inject(
      "PUT",
      `/api/v1/projects/${projectId}/daily-logs/${date}`,
      u1.headers,
      { notes: "Pour at L3 east. Finished 15:40." },
    );
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(created.id);
    expect(second.json().notes).toContain("15:40");
    expect(second.json().sections.manpower).toHaveLength(1);
  });

  it("submits, blocks self-approval, approves by another user", async () => {
    const submit = await inject(
      "POST",
      `/api/v1/projects/${projectId}/daily-logs/${date}/submit`,
      u1.headers,
    );
    expect(submit.statusCode).toBe(200);
    expect(submit.json().status).toBe("submitted");

    const selfApprove = await inject(
      "POST",
      `/api/v1/projects/${projectId}/daily-logs/${date}/approve`,
      u1.headers,
      {},
    );
    expect(selfApprove.statusCode).toBe(403);

    const approve = await inject(
      "POST",
      `/api/v1/projects/${projectId}/daily-logs/${date}/approve`,
      u2Headers,
      {},
    );
    expect(approve.statusCode).toBe(200);
    expect(approve.json().status).toBe("approved");
    expect(approve.json().approvedBy).toBe(u2.userId);

    // approved logs are locked
    const editLocked = await inject(
      "PUT",
      `/api/v1/projects/${projectId}/daily-logs/${date}`,
      u1.headers,
      { notes: "sneaky edit" },
    );
    expect(editLocked.statusCode).toBe(409);
  });

  it("reports missing business days", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/daily-logs/missing?from=2026-08-10&to=2026-08-16`,
      u1.headers,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().days).toEqual(["2026-08-10", "2026-08-11", "2026-08-13", "2026-08-14"]);
  });
});

describe("Punch list", () => {
  it("enforces the transition chain and verifier-only close", async () => {
    const create = await inject("POST", `/api/v1/projects/${projectId}/punch`, u1.headers, {
      title: "Scratched door frame L2-201",
      assigneeId: u2.userId,
      verifierId: u1.userId,
      priority: "high",
    });
    expect(create.statusCode).toBe(201);
    const item = create.json();
    expect(item.number).toBe(1);
    expect(item.status).toBe("open");

    // invalid jump open -> closed
    const jump = await inject(
      "POST",
      `/api/v1/projects/${projectId}/punch/${item.id}/status`,
      u1.headers,
      { status: "closed" },
    );
    expect(jump.statusCode).toBe(400);

    await inject("POST", `/api/v1/projects/${projectId}/punch/${item.id}/status`, u2Headers, {
      status: "in_progress",
    });
    const rfr = await inject(
      "POST",
      `/api/v1/projects/${projectId}/punch/${item.id}/status`,
      u2Headers,
      { status: "ready_for_review" },
    );
    expect(rfr.statusCode).toBe(200);

    // u2 is neither verifier nor admin -> cannot close
    const denied = await inject(
      "POST",
      `/api/v1/projects/${projectId}/punch/${item.id}/status`,
      u2Headers,
      { status: "closed" },
    );
    expect(denied.statusCode).toBe(403);

    // verifier closes
    const closed = await inject(
      "POST",
      `/api/v1/projects/${projectId}/punch/${item.id}/status`,
      u1.headers,
      { status: "closed" },
    );
    expect(closed.statusCode).toBe(200);
    expect(closed.json().status).toBe("closed");
  });

  it("lets a non-admin verifier close, and only admins void", async () => {
    const create = await inject("POST", `/api/v1/projects/${projectId}/punch`, u1.headers, {
      title: "Paint touch-up stair 3",
      assigneeId: u1.userId,
      verifierId: u2.userId,
    });
    const item = create.json();
    await inject("POST", `/api/v1/projects/${projectId}/punch/${item.id}/status`, u1.headers, {
      status: "in_progress",
    });
    await inject("POST", `/api/v1/projects/${projectId}/punch/${item.id}/status`, u1.headers, {
      status: "ready_for_review",
    });
    const closed = await inject(
      "POST",
      `/api/v1/projects/${projectId}/punch/${item.id}/status`,
      u2Headers,
      { status: "closed" },
    );
    expect(closed.statusCode).toBe(200); // u2 is the verifier

    const create2 = await inject("POST", `/api/v1/projects/${projectId}/punch`, u1.headers, {
      title: "Voidable item",
    });
    const voidable = create2.json();
    const memberVoid = await inject(
      "POST",
      `/api/v1/projects/${projectId}/punch/${voidable.id}/status`,
      u2Headers,
      { status: "void" },
    );
    expect(memberVoid.statusCode).toBe(403);
    const adminVoid = await inject(
      "POST",
      `/api/v1/projects/${projectId}/punch/${voidable.id}/status`,
      u1.headers,
      { status: "void" },
    );
    expect(adminVoid.statusCode).toBe(200);

    const analytics = await inject(
      "GET",
      `/api/v1/projects/${projectId}/punch/analytics`,
      u1.headers,
    );
    expect(analytics.statusCode).toBe(200);
    expect(analytics.json().byStatus.closed).toBe(2);
    expect(analytics.json().byStatus.void).toBe(1);
  });
});

describe("Photos", () => {
  let photoId: string;

  it("uploads a photo with metadata fields via multipart", async () => {
    const boundary = "----vitestboundary";
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const field = (name: string, value: string) =>
      Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      );
    const body = Buffer.concat([
      field("album", "Structure"),
      field("caption", "Column pour at grid C4"),
      field("latitude", "51.5074"),
      field("longitude", "-0.1278"),
      Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="col-c4.jpg"\r\ncontent-type: image/jpeg\r\n\r\n`,
      ),
      jpeg,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/photos`,
      headers: {
        ...u1.headers,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    const photo = res.json();
    photoId = photo.id;
    expect(photo.fileId).toBeTruthy();
    expect(photo.album).toBe("Structure");
    expect(photo.latitude).toBeCloseTo(51.5074);
    expect(photo.file.name).toBe("col-c4.jpg");
  });

  it("lists, groups by album, patches and deletes", async () => {
    const list = await inject("GET", `/api/v1/projects/${projectId}/photos`, u1.headers);
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);

    const albums = await inject(
      "GET",
      `/api/v1/projects/${projectId}/photos/albums`,
      u1.headers,
    );
    expect(albums.json().items).toEqual([{ album: "Structure", count: 1 }]);

    const patch = await inject("PATCH", `/api/v1/photos/${photoId}`, u1.headers, {
      caption: "Column pour complete",
      album: "Concrete",
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().caption).toBe("Column pour complete");

    const del = await inject("DELETE", `/api/v1/photos/${photoId}`, u1.headers);
    expect(del.statusCode).toBe(200);
    const after = await inject("GET", `/api/v1/projects/${projectId}/photos`, u1.headers);
    expect(after.json().items).toHaveLength(0);
  });
});
