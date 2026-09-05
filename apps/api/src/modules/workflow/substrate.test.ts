/**
 * The workflow engine's hard cases: transactional decision, fail-closed
 * snapshots and conditions, role-based assignment, cancellation, reassignment,
 * retroactive template updates and the escalation sweep.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  companyMemberships,
  projectMemberships,
  projects,
  rfis,
  workflowInstances,
  workflowStepInstances,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";
import { WORKFLOW_ESCALATION_JOB } from "./index.js";

let built: BuiltApp;
let app: FastifyInstance;
let owner: TestActor;
let pm: TestActor;
let pmHeaders: Record<string, string>;
let reviewer: TestActor;
let reviewerHeaders: Record<string, string>;
let stranger: TestActor;
let strangerHeaders: Record<string, string>;
let projectId: string;

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app, { companyName: "Workflow Co" });

  const join = async (actor: TestActor, role: string, templateKey?: string) => {
    await app.db.insert(companyMemberships).values({
      id: newId("cm"),
      companyId: owner.companyId,
      userId: actor.userId,
      role,
    });
    if (templateKey) {
      await app.db.insert(projectMemberships).values({
        id: newId("pm"),
        companyId: owner.companyId,
        projectId,
        userId: actor.userId,
        templateKey,
      });
    }
  };

  projectId = newId("prj");
  await app.db.insert(projects).values({
    id: projectId,
    companyId: owner.companyId,
    name: "Workflow Project",
  });

  pm = await registerActor(app);
  await join(pm, "member", "project_manager");
  pmHeaders = { authorization: pm.headers["authorization"]!, "x-company-id": owner.companyId };

  reviewer = await registerActor(app);
  await join(reviewer, "member", "project_admin");
  reviewerHeaders = {
    authorization: reviewer.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };

  stranger = await registerActor(app);
  await join(stranger, "member");
  strangerHeaders = {
    authorization: stranger.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };
});

afterAll(async () => {
  await built.close();
});

async function makeTemplate(steps: unknown[], name = "Template") {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/workflow-templates",
    headers: owner.headers,
    payload: { name, recordType: "rfi", steps },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function start(templateId: string, recordId: string, context?: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/workflows/start`,
    headers: owner.headers,
    payload: { templateId, recordType: "rfi", recordId, context },
  });
}

/* ------------------------------------------------------------------ */
/* Template validation                                                 */
/* ------------------------------------------------------------------ */

describe("workflow templates", () => {
  it("refuses an assignee who is not a company member", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-templates",
      headers: owner.headers,
      payload: {
        name: "Bad",
        recordType: "rfi",
        steps: [{ name: "X", type: "approval", assigneeIds: ["u_ghost"] }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("not members of this company");
  });

  it("refuses an unknown role key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-templates",
      headers: owner.headers,
      payload: {
        name: "Bad role",
        recordType: "rfi",
        steps: [{ name: "X", type: "approval", role: "chief_wizard" }],
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* Fail-closed conditions                                              */
/* ------------------------------------------------------------------ */

describe("conditions fail closed", () => {
  it("does NOT skip a cost gate when the caller omits the field", async () => {
    const templateId = await makeTemplate(
      [
        {
          name: "Cost approval",
          type: "approval",
          assigneeIds: [pm.userId],
          condition: { field: "cost", op: "gt", value: 1000 },
        },
      ],
      "Cost gate",
    );
    const res = await start(templateId, newId("rfi"), {});
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.steps).toHaveLength(1);
    expect(body.steps[0].decision).toBe("pending");
    // And the response says the condition could not be evaluated.
    expect(body.unresolvedConditionFields).toEqual(["cost"]);
  });

  it("skips the step when the condition genuinely fails", async () => {
    const templateId = await makeTemplate(
      [
        {
          name: "Cost approval",
          type: "approval",
          assigneeIds: [pm.userId],
          condition: { field: "cost", op: "gt", value: 1000 },
        },
        { name: "Final", type: "approval", assigneeIds: [reviewer.userId] },
      ],
      "Cost gate 2",
    );
    const res = await start(templateId, newId("rfi"), { cost: 10 });
    const body = res.json();
    expect(body.steps[0].decision).toBe("skipped");
    expect(body.status).toBe("running");
    expect(body.currentPosition).toBe(1);
  });

  it("resolves the condition from the stored record, not from the caller's payload", async () => {
    const rfiId = newId("rfi");
    await app.db.insert(rfis).values({
      id: rfiId,
      companyId: owner.companyId,
      projectId,
      number: 1,
      subject: "Server resolved",
      question: "?",
      status: "open",
      createdBy: owner.userId,
    });
    const templateId = await makeTemplate(
      [
        {
          name: "Only when open",
          type: "approval",
          assigneeIds: [pm.userId],
          condition: { field: "status", op: "eq", value: "open" },
        },
      ],
      "Server context",
    );
    // The caller lies about the status; the server reads the record.
    const res = await start(templateId, rfiId, { status: "closed" });
    const body = res.json();
    expect(body.provenance.recordResolved).toBe(true);
    expect(body.provenance.serverResolved).toContain("status");
    expect(body.steps[0].decision).toBe("pending");
  });
});

/* ------------------------------------------------------------------ */
/* Transactional decision                                              */
/* ------------------------------------------------------------------ */

describe("decide is transactional", () => {
  it("refuses a second submission of the same step instead of advancing twice", async () => {
    const templateId = await makeTemplate(
      [
        { name: "One", type: "approval", assigneeIds: [pm.userId] },
        { name: "Two", type: "approval", assigneeIds: [reviewer.userId] },
      ],
      "Double submit",
    );
    const started = await start(templateId, newId("rfi"));
    const stepId = started.json().steps[0].id;

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/workflow-steps/${stepId}/decide`,
      headers: pmHeaders,
      payload: { decision: "approved" },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: "POST",
      url: `/api/v1/workflow-steps/${stepId}/decide`,
      headers: pmHeaders,
      payload: { decision: "approved" },
    });
    expect(second.statusCode).toBe(409);

    // Exactly one step row for the next group — not two.
    const rows = await app.db
      .select()
      .from(workflowStepInstances)
      .where(
        and(
          eq(workflowStepInstances.instanceId, started.json().id),
          eq(workflowStepInstances.position, 1),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it("does not duplicate the next group when two parallel approvals land together", async () => {
    const templateId = await makeTemplate(
      [
        { name: "P1", type: "approval", assigneeIds: [pm.userId], parallel: true },
        { name: "P2", type: "approval", assigneeIds: [reviewer.userId], parallel: true },
        { name: "Final", type: "approval", assigneeIds: [owner.userId] },
      ],
      "Parallel race",
    );
    const started = await start(templateId, newId("rfi"));
    const steps = started.json().steps as Array<{ id: string; assigneeId: string }>;
    const mine = steps.find((s) => s.assigneeId === pm.userId)!;
    const theirs = steps.find((s) => s.assigneeId === reviewer.userId)!;

    const [a, b] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/workflow-steps/${mine.id}/decide`,
        headers: pmHeaders,
        payload: { decision: "approved" },
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/workflow-steps/${theirs.id}/decide`,
        headers: reviewerHeaders,
        payload: { decision: "approved" },
      }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);

    // Groups are [P1+P2] then [Final]: the final group is position 1, and it
    // must exist exactly once however the two approvals interleave.
    const finalGroup = await app.db
      .select()
      .from(workflowStepInstances)
      .where(
        and(
          eq(workflowStepInstances.instanceId, started.json().id),
          eq(workflowStepInstances.position, 1),
        ),
      );
    expect(finalGroup).toHaveLength(1);
  });

  it("withdraws the rest of the group on rejection", async () => {
    const templateId = await makeTemplate(
      [
        { name: "P1", type: "approval", assigneeIds: [pm.userId], parallel: true },
        { name: "P2", type: "approval", assigneeIds: [reviewer.userId], parallel: true },
      ],
      "Reject withdraws",
    );
    const started = await start(templateId, newId("rfi"));
    const steps = started.json().steps as Array<{ id: string; assigneeId: string }>;
    const mine = steps.find((s) => s.assigneeId === pm.userId)!;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/workflow-steps/${mine.id}/decide`,
      headers: pmHeaders,
      payload: { decision: "rejected", comments: "Not acceptable" },
    });
    expect(res.json().instanceStatus).toBe("rejected");
    const rows = await app.db
      .select()
      .from(workflowStepInstances)
      .where(eq(workflowStepInstances.instanceId, started.json().id));
    expect(rows.every((r) => r.decision !== "pending")).toBe(true);
  });

  it("settles an ANY-of group on the first decision", async () => {
    const templateId = await makeTemplate(
      [
        { name: "Either", type: "approval", assigneeIds: [pm.userId, reviewer.userId], quorum: "any" },
      ],
      "Any of",
    );
    const started = await start(templateId, newId("rfi"));
    const steps = started.json().steps as Array<{ id: string; assigneeId: string }>;
    expect(steps).toHaveLength(2);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/workflow-steps/${steps[0]!.id}/decide`,
      headers: steps[0]!.assigneeId === pm.userId ? pmHeaders : reviewerHeaders,
      payload: { decision: "approved" },
    });
    expect(res.json().instanceStatus).toBe("approved");
  });
});

/* ------------------------------------------------------------------ */
/* Fail-closed snapshot                                                */
/* ------------------------------------------------------------------ */

describe("an unreadable snapshot blocks, it does not approve", () => {
  it("blocks the instance and refuses the decision", async () => {
    const templateId = await makeTemplate(
      [
        { name: "One", type: "approval", assigneeIds: [pm.userId] },
        { name: "Two", type: "approval", assigneeIds: [reviewer.userId] },
      ],
      "Corrupt snapshot",
    );
    const started = await start(templateId, newId("rfi"));
    const instanceId = started.json().id as string;
    const stepId = started.json().steps[0].id as string;

    // Simulate the schema tightening / hand-edited context the audit describes.
    await app.db
      .update(workflowInstances)
      .set({ context: { __steps: [{ nonsense: true }] } })
      .where(eq(workflowInstances.id, instanceId));

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/workflow-steps/${stepId}/decide`,
      headers: pmHeaders,
      payload: { decision: "approved" },
    });
    expect(res.statusCode).toBe(409);

    const rows = await app.db
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.id, instanceId));
    // Blocked — emphatically NOT approved.
    expect(rows[0]!.status).toBe("blocked");
    expect(rows[0]!.blockedReason).toBeTruthy();
  });

  it("says so on the graph endpoint rather than drawing an empty, finished chain", async () => {
    const templateId = await makeTemplate(
      [{ name: "Only", type: "approval", assigneeIds: [pm.userId] }],
      "Graph corrupt",
    );
    const started = await start(templateId, newId("rfi"));
    await app.db
      .update(workflowInstances)
      .set({ context: { __steps: "nonsense" } })
      .where(eq(workflowInstances.id, started.json().id));
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/workflows/${started.json().id}/graph`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().nodes).toEqual([]);
    expect(res.json().unavailable).toContain("cannot be read");
  });
});

/* ------------------------------------------------------------------ */
/* Role assignment, cancel, reassign, remind                           */
/* ------------------------------------------------------------------ */

describe("assignment, cancellation and recovery", () => {
  it("resolves a role to the project's members at activation", async () => {
    const templateId = await makeTemplate(
      [{ name: "PM approval", type: "approval", role: "project_manager" }],
      "Role based",
    );
    const started = await start(templateId, newId("rfi"));
    expect(started.statusCode).toBe(201);
    const steps = started.json().steps as Array<{ assigneeId: string; assignedVia: string }>;
    expect(steps).toHaveLength(1);
    expect(steps[0]!.assigneeId).toBe(pm.userId);
    expect(steps[0]!.assignedVia).toBe("role");
  });

  it("blocks rather than silently shortening the chain when a role resolves to nobody", async () => {
    const templateId = await makeTemplate(
      [{ name: "Nobody", type: "approval", role: "subcontractor" }],
      "Empty role",
    );
    const started = await start(templateId, newId("rfi"));
    expect(started.statusCode).toBe(201);
    expect(started.json().status).toBe("blocked");
    expect(started.json().blockedReason).toBeTruthy();
  });

  it("is idempotent: starting twice on one record returns the running instance", async () => {
    const templateId = await makeTemplate(
      [{ name: "One", type: "approval", assigneeIds: [pm.userId] }],
      "Idempotent start",
    );
    const recordId = newId("rfi");
    const first = await start(templateId, recordId);
    expect(first.statusCode).toBe(201);
    const second = await start(templateId, recordId);
    expect(second.statusCode).toBe(200);
    expect(second.json().alreadyRunning).toBe(true);
    expect(second.json().id).toBe(first.json().id);
  });

  it("cancels a stuck instance and withdraws its pending steps", async () => {
    const templateId = await makeTemplate(
      [{ name: "One", type: "approval", assigneeIds: [pm.userId] }],
      "Cancellable",
    );
    const started = await start(templateId, newId("rfi"));
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/workflows/${started.json().id}/cancel`,
      headers: owner.headers,
      payload: { reason: "Superseded by a revised RFI" },
    });
    expect(res.statusCode).toBe(200);
    const rows = await app.db
      .select()
      .from(workflowStepInstances)
      .where(eq(workflowStepInstances.instanceId, started.json().id));
    expect(rows.every((r) => r.decision === "skipped")).toBe(true);

    const again = await app.inject({
      method: "POST",
      url: `/api/v1/workflows/${started.json().id}/cancel`,
      headers: owner.headers,
      payload: { reason: "again" },
    });
    expect(again.statusCode).toBe(409);
  });

  it("reassigns a pending step to another member", async () => {
    const templateId = await makeTemplate(
      [{ name: "One", type: "approval", assigneeIds: [pm.userId] }],
      "Reassignable",
    );
    const started = await start(templateId, newId("rfi"));
    const stepId = started.json().steps[0].id;

    const foreign = await app.inject({
      method: "POST",
      url: `/api/v1/workflow-steps/${stepId}/reassign`,
      headers: owner.headers,
      payload: { toUserId: "u_ghost" },
    });
    expect(foreign.statusCode).toBe(400);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/workflow-steps/${stepId}/reassign`,
      headers: owner.headers,
      payload: { toUserId: reviewer.userId, reason: "PM on leave" },
    });
    expect(res.statusCode).toBe(200);
    const decide = await app.inject({
      method: "POST",
      url: `/api/v1/workflow-steps/${stepId}/decide`,
      headers: reviewerHeaders,
      payload: { decision: "approved" },
    });
    expect(decide.statusCode).toBe(200);
  });

  it("refuses to delegate to yourself or to the person who started the chain", async () => {
    const templateId = await makeTemplate(
      [{ name: "One", type: "approval", assigneeIds: [pm.userId] }],
      "Delegation SoD",
    );
    const started = await start(templateId, newId("rfi"));
    const stepId = started.json().steps[0].id;
    const toSelf = await app.inject({
      method: "POST",
      url: `/api/v1/workflow-steps/${stepId}/delegate`,
      headers: pmHeaders,
      payload: { toUserId: pm.userId },
    });
    expect(toSelf.statusCode).toBe(400);
    const toStarter = await app.inject({
      method: "POST",
      url: `/api/v1/workflow-steps/${stepId}/delegate`,
      headers: pmHeaders,
      payload: { toUserId: owner.userId },
    });
    expect(toStarter.statusCode).toBe(400);
    const foreign = await app.inject({
      method: "POST",
      url: `/api/v1/workflow-steps/${stepId}/delegate`,
      headers: pmHeaders,
      payload: { toUserId: "u_ghost" },
    });
    expect(foreign.statusCode).toBe(400);
  });

  it("reminds the current approvers", async () => {
    const templateId = await makeTemplate(
      [{ name: "One", type: "approval", assigneeIds: [pm.userId] }],
      "Remindable",
    );
    const started = await start(templateId, newId("rfi"));
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/workflows/${started.json().id}/remind`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reminded).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* Reading an instance                                                 */
/* ------------------------------------------------------------------ */

describe("instance visibility", () => {
  it("refuses a company member with no access to the instance's project", async () => {
    const templateId = await makeTemplate(
      [{ name: "One", type: "approval", assigneeIds: [pm.userId] }],
      "Private instance",
    );
    const started = await start(templateId, newId("rfi"), { cost: 999999 });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/workflows/${started.json().id}`,
      headers: strangerHeaders,
    });
    expect(res.statusCode).toBe(403);
  });

  it("admits the named approver even without project membership", async () => {
    const templateId = await makeTemplate(
      [{ name: "External review", type: "approval", assigneeIds: [stranger.userId] }],
      "External approver",
    );
    const started = await start(templateId, newId("rfi"));
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/workflows/${started.json().id}`,
      headers: strangerHeaders,
    });
    expect(res.statusCode).toBe(200);
    const decide = await app.inject({
      method: "POST",
      url: `/api/v1/workflow-steps/${started.json().steps[0].id}/decide`,
      headers: strangerHeaders,
      payload: { decision: "approved" },
    });
    expect(decide.statusCode).toBe(200);
  });

  it("draws a graph with one node per activation group", async () => {
    const templateId = await makeTemplate(
      [
        { name: "A", type: "approval", assigneeIds: [pm.userId] },
        { name: "B1", type: "approval", assigneeIds: [reviewer.userId], parallel: true },
        { name: "B2", type: "approval", assigneeIds: [owner.userId], parallel: true },
      ],
      "Graph",
    );
    const started = await start(templateId, newId("rfi"));
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/workflows/${started.json().id}/graph`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const nodes = res.json().nodes as Array<{ state: string; parallel: boolean; label: string }>;
    expect(nodes).toHaveLength(2);
    expect(nodes[0]!.state).toBe("active");
    expect(nodes[1]!.parallel).toBe(true);
    expect(nodes[1]!.label).toBe("B1 · B2");
  });
});

/* ------------------------------------------------------------------ */
/* Retroactive template updates (#90)                                  */
/* ------------------------------------------------------------------ */

describe("POST /workflow-templates/:id/apply-to-running", () => {
  it("migrates running instances to the current version at their position", async () => {
    const templateId = await makeTemplate(
      [
        { name: "One", type: "approval", assigneeIds: [pm.userId] },
        { name: "Two", type: "approval", assigneeIds: [reviewer.userId] },
      ],
      "Migratable",
    );
    const started = await start(templateId, newId("rfi"));
    const instanceId = started.json().id as string;

    await app.inject({
      method: "PATCH",
      url: `/api/v1/workflow-templates/${templateId}`,
      headers: owner.headers,
      payload: {
        steps: [
          { name: "One (revised)", type: "approval", assigneeIds: [reviewer.userId] },
          { name: "Two", type: "approval", assigneeIds: [reviewer.userId] },
        ],
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/workflow-templates/${templateId}/apply-to-running`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().migrated).toBe(1);

    const steps = await app.db
      .select()
      .from(workflowStepInstances)
      .where(
        and(
          eq(workflowStepInstances.instanceId, instanceId),
          eq(workflowStepInstances.position, 0),
        ),
      );
    expect(steps).toHaveLength(1);
    expect(steps[0]!.name).toBe("One (revised)");
    expect(steps[0]!.assigneeId).toBe(reviewer.userId);

    const audit = await app.inject({
      method: "GET",
      url: `/api/v1/company/audit?objectId=${instanceId}`,
      headers: owner.headers,
    });
    expect(
      (audit.json().items as Array<{ payload: unknown }>).some((e) =>
        JSON.stringify(e.payload ?? {}).includes("template_migrated"),
      ),
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Mandatory workflows (#788)                                          */
/* ------------------------------------------------------------------ */

describe("GET /projects/:projectId/workflow-required", () => {
  it("answers whether a workflow exists for the record type and whether it is satisfied", async () => {
    const recordId = newId("rfi");
    const templateId = await makeTemplate(
      [{ name: "Gate", type: "approval", assigneeIds: [pm.userId] }],
      "Mandatory",
    );
    const before = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/workflow-required?recordType=rfi&recordId=${recordId}`,
      headers: owner.headers,
    });
    expect(before.json().required).toBe(true);
    expect(before.json().satisfied).toBe(false);

    const started = await start(templateId, recordId);
    await app.inject({
      method: "POST",
      url: `/api/v1/workflow-steps/${started.json().steps[0].id}/decide`,
      headers: pmHeaders,
      payload: { decision: "approved" },
    });
    const after = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/workflow-required?recordType=rfi&recordId=${recordId}`,
      headers: owner.headers,
    });
    expect(after.json().satisfied).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Escalation sweep                                                    */
/* ------------------------------------------------------------------ */

describe("scheduler job workflow.escalations", () => {
  it("escalates an overdue step once and does not escalate it again", async () => {
    const templateId = await makeTemplate(
      [
        {
          name: "Escalating",
          type: "approval",
          assigneeIds: [pm.userId],
          dueInDays: 0,
          escalateAfterDays: 0,
        },
      ],
      "Escalation",
    );
    const started = await start(templateId, newId("rfi"));
    const stepId = started.json().steps[0].id as string;
    // Backdate so the sweep has something overdue to find.
    await app.db
      .update(workflowStepInstances)
      .set({ dueDate: "2020-01-01", escalateAt: "2020-01-01" })
      .where(eq(workflowStepInstances.id, stepId));

    const first = await app.scheduler.runNow(WORKFLOW_ESCALATION_JOB);
    expect(first.state).toBe("succeeded");
    expect((first.lastResult as { escalated: number }).escalated).toBeGreaterThanOrEqual(1);

    const rows = await app.db
      .select()
      .from(workflowStepInstances)
      .where(eq(workflowStepInstances.id, stepId));
    expect(rows[0]!.escalatedAt).toBeTruthy();

    const second = await app.scheduler.runNow(WORKFLOW_ESCALATION_JOB);
    // Idempotent: raising the same escalation twice would be the bug.
    expect((second.lastResult as { escalated: number }).escalated).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Health inputs (cross-package contract §3.5)                         */
/* ------------------------------------------------------------------ */

describe("GET /projects/:projectId/workflow/health-inputs", () => {
  it("counts what is running, pending, overdue and blocked — and refuses to invent a ratio", async () => {
    const fresh = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: owner.headers,
      payload: { name: "Health Inputs Project" },
    });
    const freshId = fresh.json().id;

    const empty = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${freshId}/workflow/health-inputs`,
      headers: owner.headers,
    });
    expect(empty.statusCode).toBe(200);
    const emptyBody = empty.json();
    expect(emptyBody.metrics.runningInstances).toBe(0);
    expect(emptyBody.metrics.pendingSteps).toBe(0);
    // No denominator: the ratio is unknowable, not zero.
    expect(emptyBody.metrics.overdueRatio).toBeNull();
    expect(emptyBody.reasons.join(" ")).toContain("No approval chain");

    // A live chain on the main project produces real counts.
    const live = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/workflow/health-inputs`,
      headers: owner.headers,
    });
    expect(live.statusCode).toBe(200);
    const body = live.json();
    expect(body.metrics.pendingSteps).toBeGreaterThanOrEqual(0);
    expect(typeof body.metrics.blockedInstances).toBe("number");
    if (body.metrics.pendingSteps > 0) {
      expect(typeof body.metrics.overdueRatio).toBe("number");
    }
  });

  it("refuses a caller with no read access to the project", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/workflow/health-inputs`,
      headers: strangerHeaders,
    });
    expect(res.statusCode).toBe(403);
  });
});
