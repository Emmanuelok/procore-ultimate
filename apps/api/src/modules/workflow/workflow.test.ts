import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companyMemberships, ledgerEntries, projects } from "@constructos/db";
import { and, eq } from "drizzle-orm";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";

let built: BuiltApp;
let u1: TestActor; // company owner, workflow starter
let u2: TestActor; // member of u1's company
let u2Headers: Record<string, string>;
let projectId: string;
let templateId: string;

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
    name: "Workflow P1",
  });
});

afterAll(async () => {
  await built.close();
});

function makeSteps() {
  return [
    { name: "PM review", type: "review", assigneeIds: [u1.userId] },
    {
      name: "Cost check",
      type: "approval",
      assigneeIds: [u1.userId],
      parallel: true,
      dueInDays: 3,
      condition: { field: "cost", op: "gt", value: 1000 },
    },
    { name: "Ops check", type: "approval", assigneeIds: [u2.userId], parallel: true },
  ];
}

async function startInstance(cost: number): Promise<{ id: string; steps: any[] }> {
  const res = await built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/workflows/start`,
    headers: u1.headers,
    payload: {
      templateId,
      recordType: "rfi",
      recordId: newId("rfi"),
      context: { cost },
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function decide(stepId: string, headers: Record<string, string>, decision: string) {
  return built.app.inject({
    method: "POST",
    url: `/api/v1/workflow-steps/${stepId}/decide`,
    headers,
    payload: { decision },
  });
}

async function getInstance(id: string) {
  const res = await built.app.inject({
    method: "GET",
    url: `/api/v1/workflows/${id}`,
    headers: u1.headers,
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe("workflow templates", () => {
  it("creates a company-wide template and bumps version on edit", async () => {
    const res = await built.app.inject({
      method: "POST",
      url: "/api/v1/workflow-templates",
      headers: u1.headers,
      payload: { name: "RFI approval", recordType: "rfi", steps: makeSteps() },
    });
    expect(res.statusCode).toBe(201);
    const tpl = res.json();
    templateId = tpl.id;
    expect(tpl.version).toBe(1);

    const patch = await built.app.inject({
      method: "PATCH",
      url: `/api/v1/workflow-templates/${templateId}`,
      headers: u1.headers,
      payload: { name: "RFI approval v2" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().version).toBe(2);
  });

  it("rejects invalid step definitions", async () => {
    const res = await built.app.inject({
      method: "POST",
      url: "/api/v1/workflow-templates",
      headers: u1.headers,
      payload: { name: "Bad", recordType: "rfi", steps: [{ name: "X", type: "approval", assigneeIds: [] }] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("workflow run with condition skip and rejection", () => {
  it("materializes only the first group at start", async () => {
    const inst = await startInstance(500);
    expect(inst.steps).toHaveLength(1);
    expect(inst.steps[0].decision).toBe("pending");
    expect(inst.steps[0].assigneeId).toBe(u1.userId);

    // A non-assignee cannot decide
    const forbidden = await decide(inst.steps[0].id, u2Headers, "approved");
    expect(forbidden.statusCode).toBe(403);

    // Approve group 0 → group 1 activates; cost condition (gt 1000) fails → skipped
    const ok = await decide(inst.steps[0].id, u1.headers, "approved");
    expect(ok.statusCode).toBe(200);
    expect(ok.json().instanceStatus).toBe("running");

    const detail = await getInstance(inst.id);
    expect(detail.currentPosition).toBe(1);
    expect(detail.steps).toHaveLength(3);
    const skipped = detail.steps.find((s: any) => s.name === "Cost check");
    const pending = detail.steps.find((s: any) => s.name === "Ops check");
    expect(skipped.decision).toBe("skipped");
    expect(pending.decision).toBe("pending");
    expect(pending.assigneeId).toBe(u2.userId);

    // u2 sees the step in their inbox
    const inbox = await built.app.inject({
      method: "GET",
      url: "/api/v1/me/workflow-inbox",
      headers: u2Headers,
    });
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json().items.some((i: any) => i.id === pending.id)).toBe(true);

    // Rejection terminates the instance
    const rej = await decide(pending.id, u2Headers, "rejected");
    expect(rej.statusCode).toBe(200);
    expect(rej.json().instanceStatus).toBe("rejected");
    const after = await getInstance(inst.id);
    expect(after.status).toBe("rejected");
    expect(after.completedAt).toBeTruthy();
  });
});

describe("workflow parallel group approval", () => {
  it("waits for every step of a parallel group before completing", async () => {
    const inst = await startInstance(5000);
    const first = inst.steps[0];
    await decide(first.id, u1.headers, "approved");

    const mid = await getInstance(inst.id);
    const groupSteps = mid.steps.filter((s: any) => s.position === 1);
    expect(groupSteps).toHaveLength(2);
    expect(groupSteps.every((s: any) => s.decision === "pending")).toBe(true);
    const mine = groupSteps.find((s: any) => s.assigneeId === u1.userId);
    const theirs = groupSteps.find((s: any) => s.assigneeId === u2.userId);
    expect(mine.dueDate).toBeTruthy(); // dueInDays materialized

    const r1 = await decide(mine.id, u1.headers, "approved");
    expect(r1.json().instanceStatus).toBe("running");

    const r2 = await decide(theirs.id, u2Headers, "approved");
    expect(r2.json().instanceStatus).toBe("approved");

    const done = await getInstance(inst.id);
    expect(done.status).toBe("approved");
  });

  it("supports delegation by the assignee", async () => {
    const inst = await startInstance(5000);
    const step = inst.steps[0];

    const notAssignee = await built.app.inject({
      method: "POST",
      url: `/api/v1/workflow-steps/${step.id}/delegate`,
      headers: u2Headers,
      payload: { toUserId: u2.userId },
    });
    expect(notAssignee.statusCode).toBe(403);

    const del = await built.app.inject({
      method: "POST",
      url: `/api/v1/workflow-steps/${step.id}/delegate`,
      headers: u1.headers,
      payload: { toUserId: u2.userId },
    });
    expect(del.statusCode).toBe(200);

    const decideRes = await decide(step.id, u2Headers, "approved");
    expect(decideRes.statusCode).toBe(200);
  });

  it("lists instances with steps and writes ledger entries", async () => {
    const list = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/workflows?status=approved`,
      headers: u1.headers,
    });
    expect(list.statusCode).toBe(200);
    const bodyJson = list.json();
    expect(bodyJson.items.length).toBeGreaterThan(0);
    expect(bodyJson.items[0].steps.length).toBeGreaterThan(0);

    const rows = await built.app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, u1.companyId),
          eq(ledgerEntries.objectType, "workflow_instance"),
        ),
      );
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.some((r) => r.action === "create")).toBe(true);
    expect(rows.some((r) => r.action === "state_change")).toBe(true);
  });
});
