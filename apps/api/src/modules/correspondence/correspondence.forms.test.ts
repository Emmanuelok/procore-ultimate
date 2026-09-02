/**
 * Forms — the template library with show/hide logic and a PDF field mapping,
 * publication, assignment, completion with a signature, review by a second
 * person, the CSV register export, the overdue sweep and tenant isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  companyMemberships,
  files,
  formAssignments,
  locations,
  projectMemberships,
  projects,
  signals,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO } from "./engines/dates.js";
import { correspondenceModule } from "./index.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let inspector: TestActor;
let reviewer: TestActor;
let stranger: TestActor;
let projectId: string;
let locationId: string;
let fileId: string;
let templateId: string;

const today = new Date().toISOString().slice(0, 10);

const post = (url: string, payload?: unknown, headers = owner.headers) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload: payload ?? {} });
const patch = (url: string, payload: unknown, headers = owner.headers) =>
  app.inject({ method: "PATCH", url: `/api/v1${url}`, headers, payload });
const get = (url: string, headers = owner.headers) =>
  app.inject({ method: "GET", url: `/api/v1${url}`, headers });

const FIELDS = [
  { key: "area", label: "Area inspected", type: "text", required: true },
  {
    key: "outcome",
    label: "Outcome",
    type: "select",
    required: true,
    options: [
      { value: "pass", label: "Pass" },
      { value: "fail", label: "Fail" },
    ],
  },
  {
    key: "defect",
    label: "Defect description",
    type: "textarea",
    required: true,
    visibleWhen: { all: [{ field: "outcome", operator: "eq", value: "fail" }] },
  },
  {
    key: "severity",
    label: "Severity",
    type: "number",
    min: 1,
    max: 5,
    visibleWhen: { all: [{ field: "defect", operator: "not_empty" }] },
  },
  { key: "checked", label: "Checked on site", type: "checkbox" },
];

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  if (!app.scheduler.has("correspondence.form-due")) {
    await app.register(correspondenceModule, { prefix: "/api/v1" });
  }
  owner = await registerActor(app);

  const makeMember = async (role: "admin" | "member"): Promise<TestActor> => {
    const actor = await registerActor(app);
    await app.db
      .insert(companyMemberships)
      .values({ id: newId("cm"), companyId: owner.companyId, userId: actor.userId, role });
    return {
      ...actor,
      companyId: owner.companyId,
      headers: { authorization: actor.headers["authorization"]!, "x-company-id": owner.companyId },
    };
  };
  inspector = await makeMember("admin");
  reviewer = await makeMember("admin");
  stranger = await registerActor(app);

  projectId = newId("prj");
  await app.db.insert(projects).values({
    id: projectId,
    companyId: owner.companyId,
    name: "Correspondence — forms",
    stage: "course_of_construction",
  });
  await app.db.insert(projectMemberships).values({
    id: newId("pm"),
    companyId: owner.companyId,
    projectId,
    userId: inspector.userId,
    templateKey: "project_manager",
  });

  locationId = newId("loc");
  await app.db.insert(locations).values({
    id: locationId,
    companyId: owner.companyId,
    projectId,
    name: "Plant room",
    path: locationId,
  });

  fileId = newId("fil");
  await app.db.insert(files).values({
    id: fileId,
    companyId: owner.companyId,
    projectId,
    name: "signature.png",
    contentType: "image/png",
    sizeBytes: 40,
    sha256: "d".repeat(64),
    storageKey: "test/signature.png",
    metadata: {},
    uploadedBy: owner.userId,
  });
}, 180_000);

afterAll(async () => {
  await built.close();
}, 60_000);

/* ================================================================== */
/* Templates (#457–#459, #464)                                         */
/* ================================================================== */

describe("form templates", () => {
  it("creates a template with branching logic and a PDF field mapping", async () => {
    const res = await post("/correspondence/form-templates", {
      key: "plant_inspection",
      name: "Plant room inspection",
      category: "quality",
      fields: FIELDS,
      signatureRequired: true,
      pdfFileId: fileId,
      pdfFieldMap: { "Form.Area": "area", "Form.Ghost": "nosuchfield" },
    });
    expect(res.statusCode).toBe(201);
    templateId = res.json().id;
    expect(res.json().status).toBe("draft");
    expect(res.json().version).toBe(1);

    const detail = await get(`/correspondence/form-templates/${templateId}`);
    expect(detail.json().problems).toEqual([]);
    expect(detail.json().pdfMapping.mapped["Form.Area"]).toBe("area");
    expect(detail.json().pdfMapping.danglingPdfFields).toEqual(["Form.Ghost"]);
    expect(detail.json().pdfMapping.unmappedFields).toContain("outcome");
    // With no answers, everything behind a branch is hidden.
    expect(detail.json().initialVisibility.hidden).toEqual(["defect", "severity"]);
  });

  it("refuses a broken template", async () => {
    const res = await post("/correspondence/form-templates", {
      key: "broken",
      name: "Broken",
      fields: [
        { key: "a", label: "A", type: "select" },
        { key: "a", label: "A again", type: "text" },
      ],
    });
    expect(res.statusCode).toBe(400);
    const problems = res.json().details?.problems ?? res.json().problems ?? [];
    expect(JSON.stringify(problems)).toContain("used more than once");
  });

  it("refuses to assign a form that is not published", async () => {
    const res = await post(`/projects/${projectId}/correspondence/form-assignments`, {
      templateId,
      assigneeUserId: inspector.userId,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("draft");
  });

  it("publishes it", async () => {
    const res = await post(`/correspondence/form-templates/${templateId}/publish`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("published");
    expect(res.json().publishedBy).toBe(owner.userId);
    const again = await post(`/correspondence/form-templates/${templateId}/publish`, {});
    expect(again.statusCode).toBe(409);
  });

  it("does not empty the form when only its name is patched", async () => {
    // Regression: `.partial()` keeps zod defaults, so a PATCH parsed through it
    // would have reset `fields`, `logic` and `pdfFieldMap` to their defaults.
    const before = await get(`/correspondence/form-templates/${templateId}`);
    const fieldCount = before.json().fields.length as number;
    const res = await patch(`/correspondence/form-templates/${templateId}`, {
      name: "Plant room inspection (rev A)",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("Plant room inspection (rev A)");
    expect(res.json().fields).toHaveLength(fieldCount);
    expect(res.json().signatureRequired).toBe(1);
    expect(Object.keys(res.json().pdfFieldMap)).toContain("Form.Area");
    expect(res.json().version).toBe(before.json().version);
  });

  it("refuses a structural edit that would leave the form with no fields", async () => {
    const res = await patch(`/correspondence/form-templates/${templateId}`, { fields: [] });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain("at least one field");
  });

  it("bumps the version when a published template's questions change", async () => {
    const res = await patch(`/correspondence/form-templates/${templateId}`, {
      fields: [...FIELDS, { key: "notes", label: "Notes", type: "textarea" }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().version).toBe(2);
  });

  it("keeps the library invisible to another tenant", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/correspondence/form-templates",
      headers: stranger.headers,
    });
    expect(res.json().items).toEqual([]);
  });
});

/* ================================================================== */
/* Assignments and responses                                           */
/* ================================================================== */

let assignmentId: string;
let responseId: string;

describe("assignment, completion and review (#460–#462)", () => {
  it("assigns the form with a due date and notifies the assignee", async () => {
    const res = await post(`/projects/${projectId}/correspondence/form-assignments`, {
      templateId,
      assigneeUserId: inspector.userId,
      locationId,
      dueDate: addDaysISO(today, 3),
      instructions: "Walk the plant room before the commissioning start.",
    });
    expect(res.statusCode).toBe(201);
    assignmentId = res.json().id;
    expect(res.json().assigneeName).toBeTruthy();
    expect(res.json().templateVersion).toBe(2);
    expect(res.json().status).toBe("assigned");
  });

  it("starts a response against the assignment and validates as it goes", async () => {
    const res = await post(
      `/projects/${projectId}/correspondence/form-responses`,
      { assignmentId, values: { area: "Plant room L1" } },
      inspector.headers,
    );
    expect(res.statusCode).toBe(201);
    responseId = res.json().id;
    expect(res.json().reference).toMatch(/^FR-\d{3}$/);
    expect(res.json().status).toBe("draft");
    // outcome is unanswered, so the branch below it is hidden
    expect(res.json().hiddenFields).toEqual(["defect", "severity"]);

    const assignment = (
      await app.db.select().from(formAssignments).where(eq(formAssignments.id, assignmentId))
    )[0];
    expect(assignment?.status).toBe("in_progress");
  });

  it("rejects answers that do not fit the form", async () => {
    const res = await patch(
      `/projects/${projectId}/correspondence/form-responses/${responseId}`,
      { values: { area: "Plant room L1", outcome: "maybe" } },
      inspector.headers,
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain("not one of the offered options");
  });

  it("saves a draft answer and keeps the hidden branch out of the record", async () => {
    const res = await patch(
      `/projects/${projectId}/correspondence/form-responses/${responseId}`,
      { values: { area: "Plant room L1", outcome: "pass" }, title: "Weekly walk" },
      inspector.headers,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().title).toBe("Weekly walk");
    expect(res.json().values.outcome).toBe("pass");
    // the defect branch is closed again, so its answers are not on the record
    expect(res.json().hiddenFields).toEqual(["defect", "severity"]);
    expect(res.json().values.defect).toBeUndefined();
  });

  it("refuses to submit an incomplete form and an unsigned one", async () => {
    const incomplete = await post(
      `/projects/${projectId}/correspondence/form-responses/${responseId}/submit`,
      { values: { area: "Plant room L1", outcome: "fail" } },
      inspector.headers,
    );
    expect(incomplete.statusCode).toBe(400);
    expect(JSON.stringify(incomplete.json())).toContain("is required");

    const unsigned = await post(
      `/projects/${projectId}/correspondence/form-responses/${responseId}/submit`,
      { values: { area: "Plant room L1", outcome: "fail", defect: "Pipework unsupported", severity: 4 } },
      inspector.headers,
    );
    expect(unsigned.statusCode).toBe(400);
    expect(JSON.stringify(unsigned.json())).toContain("must be signed");
  });

  it("accepts a complete, signed submission and completes the assignment", async () => {
    const res = await post(
      `/projects/${projectId}/correspondence/form-responses/${responseId}/submit`,
      {
        values: {
          area: "Plant room L1",
          outcome: "fail",
          defect: "Pipework unsupported over 3m",
          severity: 4,
          checked: true,
        },
        signature: { name: "I. Inspector", method: "typed", statement: "Observed personally." },
      },
      inspector.headers,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("submitted");
    expect(res.json().signature.name).toBe("I. Inspector");
    expect(res.json().signature.signedAt).toBeTruthy();
    expect(res.json().values.severity).toBe(4);
    expect(res.json().hiddenFields).toEqual([]);

    const assignment = (
      await app.db.select().from(formAssignments).where(eq(formAssignments.id, assignmentId))
    )[0];
    expect(assignment?.status).toBe("completed");
    expect(assignment?.responseId).toBe(responseId);
  });

  it("freezes a submitted response against edits", async () => {
    const res = await patch(
      `/projects/${projectId}/correspondence/form-responses/${responseId}`,
      { values: { area: "Rewritten" } },
      inspector.headers,
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("record of what was observed");
  });

  it("does not let the submitter review their own form", async () => {
    const res = await post(
      `/projects/${projectId}/correspondence/form-responses/${responseId}/review`,
      { decision: "approved" },
      inspector.headers,
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("cannot review it");
  });

  it("accepts a review by a second person", async () => {
    const res = await post(
      `/projects/${projectId}/correspondence/form-responses/${responseId}/review`,
      { decision: "approved", note: "Raised as a punch item." },
      reviewer.headers,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("approved");
    expect(res.json().reviewedBy).toBe(reviewer.userId);
  });

  it("shows that the template moved on since the response was captured", async () => {
    await patch(`/correspondence/form-templates/${templateId}`, {
      fields: [...FIELDS, { key: "notes", label: "Notes", type: "textarea" }, { key: "extra", label: "Extra", type: "text" }],
    });
    const res = await get(`/projects/${projectId}/correspondence/form-responses/${responseId}`);
    expect(res.json().templateDrifted).toBe(true);
    expect(res.json().templateVersion).toBe(2);
  });

  it("exports the register as CSV (#463)", async () => {
    const res = await get(
      `/projects/${projectId}/correspondence/form-responses/export?templateId=${templateId}`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const [header, firstRow] = res.body.split("\n");
    expect(header).toContain("area");
    expect(header).toContain("signed_by");
    expect(firstRow).toContain("I. Inspector");
    expect(firstRow).toContain("Pipework unsupported over 3m");
  });

  it("refuses to archive a template with open assignments", async () => {
    const open = await post(`/projects/${projectId}/correspondence/form-assignments`, {
      templateId,
      assigneeUserId: inspector.userId,
      dueDate: addDaysISO(today, 7),
    });
    expect(open.statusCode).toBe(201);
    const res = await post(`/correspondence/form-templates/${templateId}/archive`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("still open");
    await post(
      `/projects/${projectId}/correspondence/form-assignments/${open.json().id}/cancel`,
      { reason: "Duplicate of the first walk." },
    );
    const after = await post(`/correspondence/form-templates/${templateId}/archive`, {});
    expect(after.statusCode).toBe(200);
    expect(after.json().status).toBe("archived");
  });
});

/* ================================================================== */
/* Overdue sweep                                                       */
/* ================================================================== */

describe("overdue form sweep (#460)", () => {
  it("raises exactly one signal for an overdue assignment", async () => {
    const template = await post("/correspondence/form-templates", {
      key: "daily_check",
      name: "Daily plant check",
      fields: [{ key: "ok", label: "All in order", type: "checkbox" }],
    });
    const templateKeyId = template.json().id as string;
    await post(`/correspondence/form-templates/${templateKeyId}/publish`, {});
    const assignment = await post(`/projects/${projectId}/correspondence/form-assignments`, {
      templateId: templateKeyId,
      assigneeUserId: inspector.userId,
      dueDate: addDaysISO(today, -9),
    });
    expect(assignment.statusCode).toBe(201);

    const first = await post(`/projects/${projectId}/correspondence/sweeps/run`, {});
    expect(first.json().forms.raised).toBe(1);
    const second = await post(`/projects/${projectId}/correspondence/sweeps/run`, {});
    expect(second.json().forms.raised).toBe(0);

    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.detector, "correspondence_form_overdue"),
        ),
      );
    expect(raised).toHaveLength(1);
    expect(raised[0]?.severity).toBe("medium");
    expect(raised[0]?.title).toContain("9 days overdue");
  });

  it("runs from the scheduler", async () => {
    const status = await app.scheduler.runNow("correspondence.form-due");
    expect(status.state).toBe("succeeded");
  });

  it("reports forms in the summary and health inputs", async () => {
    const summary = await get(`/projects/${projectId}/correspondence/summary`);
    expect(summary.json().forms.templates).toBeGreaterThanOrEqual(2);
    expect(summary.json().forms.published).toBeGreaterThanOrEqual(1);
    expect(summary.json().forms.overdueAssignments).toBe(1);
    expect(summary.json().forms.submitted).toBe(1);

    const health = await get(`/projects/${projectId}/correspondence/health-inputs`);
    expect(health.json().metrics.formAssignmentsOverdue).toBe(1);
    expect(Array.isArray(health.json().reasons)).toBe(true);
  });
});

describe("tenant isolation", () => {
  it("refuses a stranger every form route", async () => {
    for (const url of [
      `/projects/${projectId}/correspondence/form-assignments`,
      `/projects/${projectId}/correspondence/form-responses`,
      `/projects/${projectId}/correspondence/form-responses/export?templateId=${templateId}`,
    ]) {
      const res = await get(url, stranger.headers);
      expect(res.statusCode).toBe(403);
    }
    const write = await post(
      `/projects/${projectId}/correspondence/form-responses`,
      { templateId, values: {} },
      stranger.headers,
    );
    expect(write.statusCode).toBe(403);
  });

  it("hides another tenant's response behind their own project route", async () => {
    const otherProject = newId("prj");
    await app.db
      .insert(projects)
      .values({ id: otherProject, companyId: stranger.companyId, name: "Theirs", stage: "planning" });
    const res = await get(
      `/projects/${otherProject}/correspondence/form-responses/${responseId}`,
      stranger.headers,
    );
    expect(res.statusCode).toBe(404);
  });

  it("refuses a template that belongs to another company", async () => {
    const theirTemplate = await app.inject({
      method: "POST",
      url: "/api/v1/correspondence/form-templates",
      headers: stranger.headers,
      payload: { key: "theirs", name: "Theirs", fields: [{ key: "a", label: "A", type: "text" }] },
    });
    expect(theirTemplate.statusCode).toBe(201);
    const res = await post(`/projects/${projectId}/correspondence/form-assignments`, {
      templateId: theirTemplate.json().id,
      assigneeUserId: inspector.userId,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("not found in this company");
  });
});
