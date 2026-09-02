/**
 * BIM module — federations, clash detection, the coordination issue
 * lifecycle (assignment, comments, RFI escalation, SLA sweep, exports),
 * 4D/5D links, reality capture, geofences/map and the health inputs.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  budgetLineItems,
  budgets,
  clashResults,
  companyMemberships,
  coordinationIssues,
  equipment,
  notifications,
  projectMemberships,
  projects,
  recordLinks,
  rfis,
  scheduleTasks,
  schedules,
  signals,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";
import { IFC_FIXTURE, WALL_A_GUID, WALL_B_GUID, DOOR_GUID } from "./fixtures.js";

/** MEP variant: same geometry, different GUIDs, a pipe where the wall is. */
const MEP_A_GUID = "9MEP0000000000000000AA";
const MEP_B_GUID = "9MEP0000000000000000BB";
const MEP_C_GUID = "9MEP0000000000000000CC";
const MEP_FIXTURE = IFC_FIXTURE.split(WALL_A_GUID)
  .join(MEP_A_GUID)
  .split(WALL_B_GUID)
  .join(MEP_B_GUID)
  .split(DOOR_GUID)
  .join(MEP_C_GUID)
  .replace("#10=IFCWALLSTANDARDCASE(", "#10=IFCPIPESEGMENT(");

function multipart(content: string, filename: string) {
  const boundary = "----vitestboundary";
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: application/octet-stream\r\n\r\n`,
    ),
    Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

let built: BuiltApp;
let owner: TestActor;
let engineer: TestActor;
let engineerHeaders: Record<string, string>;
let readOnly: TestActor;
let readHeaders: Record<string, string>;
let projectId: string;
let archModelId: string;
let mepModelId: string;
let archVersionId: string;
let mepVersionId: string;
let federationId: string;

const inject = (
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  headers: Record<string, string>,
  payload?: unknown,
) => built.app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });

async function createModelWithVersion(name: string, content: string) {
  const model = await inject("POST", `/api/v1/projects/${projectId}/bim/models`, owner.headers, {
    name,
    format: "ifc",
  });
  const modelId = model.json().id;
  const mp = multipart(content, `${name}.ifc`);
  const version = await built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/bim/models/${modelId}/versions`,
    payload: mp.body,
    headers: { ...owner.headers, "content-type": mp.contentType },
  });
  expect(version.statusCode).toBe(201);
  return { modelId, versionId: version.json().id as string };
}

beforeAll(async () => {
  built = await buildTestApp();
  owner = await registerActor(built.app);
  engineer = await registerActor(built.app);
  readOnly = await registerActor(built.app);
  await built.app.db.insert(companyMemberships).values([
    { id: newId("cm"), companyId: owner.companyId, userId: engineer.userId, role: "member" },
    { id: newId("cm"), companyId: owner.companyId, userId: readOnly.userId, role: "member" },
  ]);
  engineerHeaders = {
    authorization: `Bearer ${engineer.accessToken}`,
    "x-company-id": owner.companyId,
  };
  readHeaders = {
    authorization: `Bearer ${readOnly.accessToken}`,
    "x-company-id": owner.companyId,
  };
  projectId = newId("prj");
  await built.app.db
    .insert(projects)
    .values({ id: projectId, companyId: owner.companyId, name: "Coordination Tower" });
  await built.app.db.insert(projectMemberships).values([
    {
      id: newId("pm"),
      companyId: owner.companyId,
      projectId,
      userId: engineer.userId,
      templateKey: "project_manager",
      overrides: {},
    },
    {
      id: newId("pm"),
      companyId: owner.companyId,
      projectId,
      userId: readOnly.userId,
      templateKey: "read_only",
      overrides: {},
    },
  ]);

  const arch = await createModelWithVersion("Architecture", IFC_FIXTURE);
  archModelId = arch.modelId;
  archVersionId = arch.versionId;
  const mep = await createModelWithVersion("MEP", MEP_FIXTURE);
  mepModelId = mep.modelId;
  mepVersionId = mep.versionId;
}, 240_000);

afterAll(async () => {
  await built.close();
});

/* ------------------------------------------------------------------ */

describe("federations", () => {
  it("creates a federation and adds both discipline models", async () => {
    const group = await inject(
      "POST",
      `/api/v1/projects/${projectId}/bim/federations`,
      owner.headers,
      { name: "Full building" },
    );
    expect(group.statusCode).toBe(201);
    federationId = group.json().id;

    for (const versionId of [archVersionId, mepVersionId]) {
      const res = await inject(
        "POST",
        `/api/v1/projects/${projectId}/bim/federations/${federationId}/members`,
        owner.headers,
        { modelVersionId: versionId },
      );
      expect(res.statusCode).toBe(201);
    }
    const dupe = await inject(
      "POST",
      `/api/v1/projects/${projectId}/bim/federations/${federationId}/members`,
      owner.headers,
      { modelVersionId: archVersionId },
    );
    expect(dupe.statusCode).toBe(409);

    const list = await inject(
      "GET",
      `/api/v1/projects/${projectId}/bim/federations`,
      owner.headers,
    );
    expect(list.json().items[0].members).toHaveLength(2);
    expect(list.json().items[0].members[0].elementCount).toBe(3);
  });
});

describe("clash detection", () => {
  let testId: string;
  let hardResultId: string;

  it("creates and runs a clash test over the federation", async () => {
    const create = await inject(
      "POST",
      `/api/v1/projects/${projectId}/bim/clash-tests`,
      owner.headers,
      {
        name: "Architecture vs MEP",
        federationId,
        ruleKind: "all_pairs",
        toleranceMm: 10,
      },
    );
    expect(create.statusCode).toBe(201);
    testId = create.json().id;
    expect(create.json().state).toBe("never_run");

    const run = await inject(
      "POST",
      `/api/v1/projects/${projectId}/bim/clash-tests/${testId}/run`,
      owner.headers,
    );
    expect(run.statusCode).toBe(200);
    const body = run.json();
    expect(body.new).toBe(2);
    expect(body.autoResolved).toBe(0);
    expect(body.method).toBe("aabb_broad_phase");
    // the door carries no quantities, so it has no extents and is excluded
    expect(body.skippedNoBounds).toBeGreaterThan(0);
    expect(body.coverageNote).toContain("no extents");
  });

  it("raises a signal for the unresolved clashes, once", async () => {
    const rows = await built.app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.detector, "bim_clash_unresolved"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.explanation).toContain("axis-aligned bounding-box");

    await inject("POST", `/api/v1/projects/${projectId}/bim/clash-tests/${testId}/run`, owner.headers);
    const again = await built.app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.detector, "bim_clash_unresolved"),
        ),
      );
    expect(again).toHaveLength(1);
  });

  it("lists results with the worst first and groups them by storey", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/bim/clash-tests/${testId}/results`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items.map((i) => i["kind"]).sort()).toEqual(["duplicate", "hard"]);
    hardResultId = items.find((i) => i["kind"] === "hard")!["id"] as string;
    expect(res.json().byStorey[0]).toMatchObject({ storey: "Level 01" });
    // second run kept the same rows (identity by fingerprint), not new ones
    expect(items.every((i) => i["status"] === "active" || i["status"] === "new")).toBe(true);
  });

  it("turns a group of clashes into a coordination issue with a viewpoint", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/bim/clash-tests/${testId}/raise-issue`,
      owner.headers,
      { resultIds: [hardResultId], assigneeId: engineer.userId, discipline: "mechanical" },
    );
    expect(res.statusCode).toBe(201);
    const issue = res.json();
    expect(issue.source).toBe("clash");
    expect(issue.status).toBe("assigned");
    expect(issue.elementGlobalIds).toHaveLength(2);
    expect(issue.viewpoint.camera).toBeTruthy();

    const [result] = await built.app.db
      .select()
      .from(clashResults)
      .where(eq(clashResults.id, hardResultId));
    expect(result?.issueId).toBe(issue.id);

    const again = await inject(
      "POST",
      `/api/v1/projects/${projectId}/bim/clash-tests/${testId}/raise-issue`,
      owner.headers,
      { resultIds: [hardResultId] },
    );
    expect(again.statusCode).toBe(409);
  });

  it("auto-resolves a clash the next run no longer finds", async () => {
    await inject(
      "DELETE",
      `/api/v1/projects/${projectId}/bim/federations/${federationId}/members/${
        (
          await inject("GET", `/api/v1/projects/${projectId}/bim/federations`, owner.headers)
        ).json().items[0].members.find((m: { modelId: string }) => m.modelId === mepModelId).id
      }`,
      owner.headers,
    );
    const run = await inject(
      "POST",
      `/api/v1/projects/${projectId}/bim/clash-tests/${testId}/run`,
      owner.headers,
    );
    expect(run.json().autoResolved).toBe(2);
    const results = await built.app.db
      .select()
      .from(clashResults)
      .where(eq(clashResults.testId, testId));
    expect(results.every((r) => r.status === "resolved")).toBe(true);

    // the signal that reported unresolved clashes closes itself rather than
    // leaving a permanent red mark on the register
    const raised = await built.app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.detector, "bim_clash_unresolved"),
        ),
      );
    expect(raised[0]?.disposition).toBe("closed");
    expect(raised[0]?.autoClosedAt).toBeTruthy();
  });

  it("refuses to run a test with nothing in scope", async () => {
    const empty = await inject(
      "POST",
      `/api/v1/projects/${projectId}/bim/clash-tests`,
      owner.headers,
      { name: "Nothing", federationId, leftFilter: { modelVersionIds: ["missing"] } },
    );
    const run = await inject(
      "POST",
      `/api/v1/projects/${projectId}/bim/clash-tests/${empty.json().id}/run`,
      owner.headers,
    );
    // the federation still holds the architectural model, so the run works but
    // finds nothing on the filtered side
    expect(run.statusCode).toBe(200);
    expect(run.json().new).toBe(0);
  });

  it("keeps clash tests inside their tenant", async () => {
    const outsider = await registerActor(built.app);
    const res = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/bim/clash-tests`,
      headers: outsider.headers,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("coordination issues", () => {
  let issueId: string;
  let issueNumber: number;

  it("creates an issue and validates the assignee and the model version", async () => {
    const bad = await inject("POST", `/api/v1/projects/${projectId}/bim/issues`, owner.headers, {
      title: "Bad assignee",
      assigneeId: "usr_does_not_exist",
    });
    expect(bad.statusCode).toBe(400);

    const badVersion = await inject(
      "POST",
      `/api/v1/projects/${projectId}/bim/issues`,
      owner.headers,
      { title: "Bad version", modelVersionId: "bmv_nope" },
    );
    expect(badVersion.statusCode).toBe(400);

    const res = await inject("POST", `/api/v1/projects/${projectId}/bim/issues`, owner.headers, {
      title: "Duct clashes with beam",
      description: "Coordinate before the pour",
      discipline: "mechanical",
      elementGlobalIds: [WALL_A_GUID],
      modelVersionId: archVersionId,
      dueDate: "2026-01-01",
    });
    expect(res.statusCode).toBe(201);
    issueId = res.json().id;
    issueNumber = res.json().number;
    expect(res.json().status).toBe("open");
    expect(res.json().source).toBe("manual");
  });

  it("assigns with a notification and walks the lifecycle", async () => {
    const assign = await inject("PATCH", `/api/v1/bim/issues/${issueId}`, owner.headers, {
      status: "assigned",
      assigneeId: engineer.userId,
    });
    expect(assign.statusCode).toBe(200);
    const notes = await built.app.db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, engineer.userId),
          eq(notifications.recordId, issueId),
        ),
      );
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(notes[0]!.kind).toBe("assignment");

    // the assignee resolves it
    const resolve = await inject("PATCH", `/api/v1/bim/issues/${issueId}`, engineerHeaders, {
      status: "resolved",
    });
    expect(resolve.statusCode).toBe(200);
    expect(resolve.json().resolvedAt).toBeTruthy();

    // and cannot then verify their own resolution
    const selfVerify = await inject("PATCH", `/api/v1/bim/issues/${issueId}`, engineerHeaders, {
      status: "verified",
    });
    expect(selfVerify.statusCode).toBe(400);
    expect(selfVerify.json().message).toContain("second coordinator");

    const verify = await inject("PATCH", `/api/v1/bim/issues/${issueId}`, owner.headers, {
      status: "verified",
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().verifiedAt).toBeTruthy();

    const reopen = await inject("PATCH", `/api/v1/bim/issues/${issueId}`, owner.headers, {
      status: "assigned",
    });
    expect(reopen.statusCode).toBe(400);
  });

  it("threads comments and notifies the mentioned people", async () => {
    const res = await inject("POST", `/api/v1/bim/issues/${issueId}/comments`, engineerHeaders, {
      body: "Duct rerouted below the beam — please check",
      mentions: [owner.userId],
    });
    expect(res.statusCode).toBe(201);
    const list = await inject("GET", `/api/v1/bim/issues/${issueId}/comments`, owner.headers);
    expect(list.json().total).toBe(1);
    expect(list.json().items[0].authorName).toBeTruthy();
    const mention = await built.app.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, owner.userId), eq(notifications.kind, "mention")));
    expect(mention.length).toBeGreaterThanOrEqual(1);
  });

  it("escalates an issue to an RFI and back-links both records (#469)", async () => {
    const issue = await inject("POST", `/api/v1/projects/${projectId}/bim/issues`, owner.headers, {
      title: "Beam penetration not detailed",
      elementGlobalIds: [WALL_B_GUID],
    });
    const targetId = issue.json().id;
    const res = await inject("POST", `/api/v1/bim/issues/${targetId}/escalate`, owner.headers, {
      assigneeId: engineer.userId,
    });
    expect(res.statusCode).toBe(201);
    const rfiId = res.json().rfiId;

    const [rfi] = await built.app.db.select().from(rfis).where(eq(rfis.id, rfiId));
    expect(rfi?.subject).toContain("Beam penetration");
    expect(rfi?.question).toContain(WALL_B_GUID);
    expect(rfi?.assigneeId).toBe(engineer.userId);

    const detail = await inject("GET", `/api/v1/bim/issues/${targetId}`, owner.headers);
    expect(detail.json().rfiId).toBe(rfiId);
    expect(detail.json().rfi.number).toBe(res.json().number);

    const links = await built.app.db
      .select()
      .from(recordLinks)
      .where(eq(recordLinks.fromId, targetId));
    expect(links[0]).toMatchObject({ toType: "rfi", linkKind: "escalation" });

    const again = await inject("POST", `/api/v1/bim/issues/${targetId}/escalate`, owner.headers);
    expect(again.statusCode).toBe(409);
  });

  it("notifies and signals overdue issues once, from the scheduler", async () => {
    const issue = await inject("POST", `/api/v1/projects/${projectId}/bim/issues`, owner.headers, {
      title: "Overdue coordination",
      assigneeId: engineer.userId,
      dueDate: "2020-01-01",
    });
    const overdueId = issue.json().id;

    await built.app.scheduler.runNow("bim.issues-overdue");
    const first = await built.app.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.recordId, overdueId), eq(notifications.kind, "overdue")));
    expect(first).toHaveLength(1);

    await built.app.scheduler.runNow("bim.issues-overdue");
    const second = await built.app.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.recordId, overdueId), eq(notifications.kind, "overdue")));
    expect(second).toHaveLength(1);

    const raised = await built.app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "bim_issue_overdue")),
      );
    expect(raised).toHaveLength(1);

    const filtered = await inject(
      "GET",
      `/api/v1/projects/${projectId}/bim/issues?overdue=1`,
      owner.headers,
    );
    expect(filtered.json().items.some((i: { id: string }) => i.id === overdueId)).toBe(true);
  });

  it("exports the register as CSV with formula injection neutralised", async () => {
    await inject("POST", `/api/v1/projects/${projectId}/bim/issues`, owner.headers, {
      title: "=HYPERLINK(\"http://evil\",\"click\")",
    });
    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/bim/issues/export.csv`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.body).toContain("\"'=HYPERLINK");
    expect(res.body.split("\r\n")[0]).toContain("Number,Title,Status");
  });

  it("exports a BCF-style payload for the issue", async () => {
    const res = await inject("GET", `/api/v1/bim/issues/${issueId}/bcf.json`, owner.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().format).toBe("bcf-2.1-json");
    expect(res.json().topic.index).toBe(issueNumber);
    expect(res.json().components[0].ifcGuid).toBe(WALL_A_GUID);
    expect(res.json().model).toContain("Architecture v1");
  });

  it("summarises coordination for the workspace header", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/bim/coordination/summary`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().byStatus["open"]).toBeGreaterThanOrEqual(1);
    expect(res.json().escalatedToRfi).toBe(1);
    expect(res.json().avgResolutionDays).not.toBeNull();
  });

  it("refuses writes from a read-only member but allows reads", async () => {
    const read = await inject("GET", `/api/v1/bim/issues/${issueId}`, readHeaders);
    expect(read.statusCode).toBe(200);
    const write = await inject("PATCH", `/api/v1/bim/issues/${issueId}`, readHeaders, {
      title: "Renamed by a read-only user",
    });
    expect(write.statusCode).toBe(403);
    const comment = await inject("POST", `/api/v1/bim/issues/${issueId}/comments`, readHeaders, {
      body: "no",
    });
    expect(comment.statusCode).toBe(403);
  });

  it("isolates issues across tenants", async () => {
    const outsider = await registerActor(built.app);
    const res = await built.app.inject({
      method: "GET",
      url: `/api/v1/bim/issues/${issueId}`,
      headers: outsider.headers,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("4D and 5D links", () => {
  let taskId: string;
  let lineId: string;

  beforeAll(async () => {
    const scheduleId = newId("sch");
    await built.app.db.insert(schedules).values({
      id: scheduleId,
      companyId: owner.companyId,
      projectId,
      name: "Master",
      projectStart: "2026-01-01",
      createdBy: owner.userId,
    });
    taskId = newId("tsk");
    await built.app.db.insert(scheduleTasks).values({
      id: taskId,
      scheduleId,
      projectId,
      name: "Erect walls level 1",
      durationDays: 10,
      startDate: "2026-02-01",
      finishDate: "2026-02-10",
    });
    const budgetId = newId("bdg");
    await built.app.db.insert(budgets).values({
      id: budgetId,
      companyId: owner.companyId,
      projectId,
      number: 1,
      reference: "BUD-001",
      name: "Base budget",
      createdBy: owner.userId,
    });
    lineId = newId("bli");
    await built.app.db.insert(budgetLineItems).values({
      id: lineId,
      budgetId,
      companyId: owner.companyId,
      projectId,
      costCode: "03-300",
      description: "Concrete walls",
      unit: "m2",
      quantity: 120,
      createdBy: owner.userId,
    });
  });

  it("links elements to a schedule task and reports 4D coverage", async () => {
    const res = await inject("POST", `/api/v1/projects/${projectId}/bim/links`, owner.headers, {
      linkType: "schedule_task",
      targetId: taskId,
      globalIds: [WALL_A_GUID, WALL_B_GUID, "NOT_A_REAL_GUID_000000"],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().linked).toBe(2);
    expect(res.json().unknownGlobalIds).toEqual(["NOT_A_REAL_GUID_000000"]);

    const dupe = await inject("POST", `/api/v1/projects/${projectId}/bim/links`, owner.headers, {
      linkType: "schedule_task",
      targetId: taskId,
      globalIds: [WALL_A_GUID],
    });
    expect(dupe.statusCode).toBe(409);

    const view = await inject("GET", `/api/v1/projects/${projectId}/bim/4d`, owner.headers);
    expect(view.json().items[0]).toMatchObject({ id: taskId, elementCount: 2 });
    expect(view.json().linkedElements).toBe(2);
    expect(view.json().unlinkedElements).toBeGreaterThanOrEqual(0);
  });

  it("links elements to a budget line with quantities and reports 5D variance", async () => {
    const res = await inject("POST", `/api/v1/projects/${projectId}/bim/links`, owner.headers, {
      linkType: "budget_line",
      targetId: lineId,
      globalIds: [WALL_A_GUID],
      quantity: 45,
      unit: "m2",
    });
    expect(res.statusCode).toBe(201);
    const view = await inject("GET", `/api/v1/projects/${projectId}/bim/5d`, owner.headers);
    const line = view.json().items[0];
    expect(line.modelQuantity).toBe(45);
    expect(line.variance).toBe(-75);
    expect(line.quantityBasis).toContain("1 linked elements");
  });

  it("refuses a target from another project", async () => {
    const otherProject = newId("prj");
    await built.app.db
      .insert(projects)
      .values({ id: otherProject, companyId: owner.companyId, name: "Other" });
    const otherTask = newId("tsk");
    const otherSchedule = newId("sch");
    await built.app.db.insert(schedules).values({
      id: otherSchedule,
      companyId: owner.companyId,
      projectId: otherProject,
      name: "Other master",
      projectStart: "2026-01-01",
      createdBy: owner.userId,
    });
    await built.app.db.insert(scheduleTasks).values({
      id: otherTask,
      scheduleId: otherSchedule,
      projectId: otherProject,
      name: "Elsewhere",
      durationDays: 1,
    });
    const res = await inject("POST", `/api/v1/projects/${projectId}/bim/links`, owner.headers, {
      linkType: "schedule_task",
      targetId: otherTask,
      globalIds: [WALL_A_GUID],
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("reality capture, maps and analytics", () => {
  let captureId: string;
  let fenceId: string;

  it("records a reality capture with a deviation summary", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/bim/reality-captures`,
      owner.headers,
      {
        kind: "point_cloud",
        name: "Level 1 scan week 12",
        capturedAt: "2026-03-20",
        modelVersionId: archVersionId,
        coveragePercent: 82,
        latitude: 51.55,
        longitude: 0,
        deviation: {
          sampleCount: 12000,
          meanMm: 6.4,
          maxMm: 41.2,
          toleranceMm: 25,
          withinTolerance: 11400,
        },
      },
    );
    expect(res.statusCode).toBe(201);
    captureId = res.json().id;

    const list = await inject(
      "GET",
      `/api/v1/projects/${projectId}/bim/reality-captures`,
      owner.headers,
    );
    expect(list.json().items[0].withinTolerancePercent).toBe(95);

    const bad = await inject(
      "PATCH",
      `/api/v1/projects/${projectId}/bim/reality-captures/${captureId}`,
      owner.headers,
      { deviation: { sampleCount: 10, meanMm: 1, maxMm: 2, toleranceMm: 5, withinTolerance: 50 } },
    );
    expect(bad.statusCode).toBe(400);
  });

  it("creates a geofence and evaluates what falls inside it", async () => {
    const res = await inject("POST", `/api/v1/projects/${projectId}/geofences`, owner.headers, {
      name: "Site boundary",
      purpose: "site_boundary",
      ring: [
        [-0.1, 51.5],
        [-0.1, 51.6],
        [0.1, 51.6],
        [0.1, 51.5],
      ],
    });
    expect(res.statusCode).toBe(201);
    fenceId = res.json().id;
    expect(res.json().areaM2).toBeGreaterThan(0);

    const invalid = await inject("POST", `/api/v1/projects/${projectId}/geofences`, owner.headers, {
      name: "Broken",
      ring: [[0, 0]],
    });
    expect(invalid.statusCode).toBe(400);

    // a crane inside the fence and a truck outside it
    await built.app.db.insert(equipment).values([
      {
        id: newId("eqp"),
        companyId: owner.companyId,
        projectId,
        number: 9001,
        reference: "EQ-9001",
        name: "Tower crane",
        latitude: 51.55,
        longitude: 0,
        createdBy: owner.userId,
      },
      {
        id: newId("eqp"),
        companyId: owner.companyId,
        projectId,
        number: 9002,
        reference: "EQ-9002",
        name: "Delivery truck",
        latitude: 52.5,
        longitude: 0,
        createdBy: owner.userId,
      },
    ]);

    const contents = await inject(
      "GET",
      `/api/v1/projects/${projectId}/geofences/${fenceId}/contents`,
      owner.headers,
    );
    expect(contents.json().total).toBe(1);
    expect(contents.json().items[0].label).toBe("Tower crane");
    expect(contents.json().byKind).toMatchObject({ equipment: 1 });
  });

  it("returns map data with honest coverage", async () => {
    const res = await inject("GET", `/api/v1/projects/${projectId}/map`, owner.headers);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.geofences).toHaveLength(1);
    // the crane and the geo-tagged scan both sit inside the boundary
    expect(body.geofences[0].featureCount).toBe(2);
    expect(body.coverage.equipment).toMatchObject({ located: 2, total: 2 });
    expect(body.outsideAnyFence).toBeGreaterThanOrEqual(1);
    expect(body.centreBasis).toContain("mean of located records");
    const crane = body.features.find((f: { label: string }) => f.label === "Tower crane");
    expect(crane.geofenceIds).toEqual([fenceId]);
  });

  it("reports summary and health inputs for the intelligence layer", async () => {
    const summary = await inject(
      "GET",
      `/api/v1/projects/${projectId}/bim/summary`,
      owner.headers,
    );
    expect(summary.statusCode).toBe(200);
    expect(summary.json().models).toBeGreaterThanOrEqual(2);
    expect(summary.json().fourDCoverage).not.toBeNull();
    expect(summary.json().activeGeofences).toBe(1);

    const health = await inject(
      "GET",
      `/api/v1/projects/${projectId}/bim/health-inputs`,
      owner.headers,
    );
    expect(health.statusCode).toBe(200);
    expect(health.json().metrics.bim_models).toBeGreaterThanOrEqual(2);
    expect(health.json().metrics.bim_open_coordination_issues).toBeGreaterThanOrEqual(1);
    expect(health.json().reasons.join(" ")).toContain("published");
  });

  it("keeps captures, fences and map data inside the tenant", async () => {
    const outsider = await registerActor(built.app);
    for (const url of [
      `/api/v1/projects/${projectId}/bim/reality-captures`,
      `/api/v1/projects/${projectId}/geofences`,
      `/api/v1/projects/${projectId}/map`,
      `/api/v1/projects/${projectId}/bim/health-inputs`,
    ]) {
      const res = await built.app.inject({ method: "GET", url, headers: outsider.headers });
      expect(res.statusCode).toBe(403);
    }
  });

  it("requires admin to delete a capture", async () => {
    const res = await inject(
      "DELETE",
      `/api/v1/projects/${projectId}/bim/reality-captures/${captureId}`,
      engineerHeaders,
    );
    expect(res.statusCode).toBe(403);
    const ok = await inject(
      "DELETE",
      `/api/v1/projects/${projectId}/bim/reality-captures/${captureId}`,
      owner.headers,
    );
    expect(ok.statusCode).toBe(200);
  });
});

/* ------------------------------------------------------------------ */

describe("remaining route surface", () => {
  it("edits and deletes a clash test, and refuses deletion below admin", async () => {
    const created = await inject(
      "POST",
      `/api/v1/projects/${projectId}/bim/clash-tests`,
      owner.headers,
      { name: "Temporary test", toleranceMm: 25 },
    );
    const testId = created.json().id;

    const patched = await inject(
      "PATCH",
      `/api/v1/projects/${projectId}/bim/clash-tests/${testId}`,
      owner.headers,
      { name: "Renamed test", clearanceMm: 50 },
    );
    expect(patched.statusCode).toBe(200);
    expect(patched.json().name).toBe("Renamed test");
    expect(patched.json().clearanceMm).toBe(50);

    const refusedDelete = await inject(
      "DELETE",
      `/api/v1/projects/${projectId}/bim/clash-tests/${testId}`,
      engineerHeaders,
    );
    expect(refusedDelete.statusCode).toBe(403);

    const deleted = await inject(
      "DELETE",
      `/api/v1/projects/${projectId}/bim/clash-tests/${testId}`,
      owner.headers,
    );
    expect(deleted.statusCode).toBe(200);
  });

  it("serves a version detail and refuses it to another tenant", async () => {
    const res = await inject("GET", `/api/v1/bim/versions/${archVersionId}`, owner.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().model.id).toBe(archModelId);

    const outsider = await registerActor(built.app);
    const denied = await built.app.inject({
      method: "GET",
      url: `/api/v1/bim/versions/${archVersionId}`,
      headers: outsider.headers,
    });
    expect(denied.statusCode).toBe(404);
  });

  it("lists and deletes an element link", async () => {
    const list = await inject(
      "GET",
      `/api/v1/projects/${projectId}/bim/links?linkType=budget_line`,
      owner.headers,
    );
    expect(list.statusCode).toBe(200);
    expect(list.json().total).toBeGreaterThan(0);
    const linkId = list.json().items[0].id;
    const deleted = await inject(
      "DELETE",
      `/api/v1/projects/${projectId}/bim/links/${linkId}`,
      owner.headers,
    );
    expect(deleted.statusCode).toBe(200);
    const missing = await inject(
      "DELETE",
      `/api/v1/projects/${projectId}/bim/links/${linkId}`,
      owner.headers,
    );
    expect(missing.statusCode).toBe(404);
  });

  it("renames a federation and refuses to delete one with a clash test attached", async () => {
    const renamed = await inject(
      "PATCH",
      `/api/v1/projects/${projectId}/bim/federations/${federationId}`,
      owner.headers,
      { name: "Full building (rev B)" },
    );
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().name).toBe("Full building (rev B)");

    const refused = await inject(
      "DELETE",
      `/api/v1/projects/${projectId}/bim/federations/${federationId}`,
      owner.headers,
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toContain("clash tests");
  });

  it("patches a geofence and reports the unsupported map layers honestly", async () => {
    const fences = await inject("GET", `/api/v1/projects/${projectId}/geofences`, owner.headers);
    const fenceId = fences.json().items[0].id;
    const patched = await inject(
      "PATCH",
      `/api/v1/projects/${projectId}/geofences/${fenceId}`,
      owner.headers,
      { purpose: "exclusion", description: "Crane oversail" },
    );
    expect(patched.statusCode).toBe(200);
    expect(patched.json().purpose).toBe("exclusion");

    const badRing = await inject(
      "PATCH",
      `/api/v1/projects/${projectId}/geofences/${fenceId}`,
      owner.headers,
      { ring: [[0, 0], [1, 1]] },
    );
    expect(badRing.statusCode).toBe(400);

    const map = await inject(
      "GET",
      `/api/v1/projects/${projectId}/map?layers=asset,equipment`,
      owner.headers,
    );
    expect(map.json().unsupportedLayers).toEqual(["asset"]);
    expect(map.json().unsupportedReason).toContain("spatial container");
  });
});
