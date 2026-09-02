/**
 * Design management — stages, packages, freezes, review cycles, comments,
 * the issue register and the decision log, end to end through the routes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  companyMemberships,
  drawingSheets,
  ledgerEntries,
  projectMemberships,
  projects,
  vendors,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { designModule } from "./index.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let reviewerActor: TestActor;
let designer: TestActor;
let viewerHeaders: Record<string, string>;
let stranger: TestActor;
let projectId: string;
let vendorId: string;
let sheetId: string;

function post(url: string, payload: unknown, headers = owner.headers) {
  return app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload });
}
function patch(url: string, payload: unknown, headers = owner.headers) {
  return app.inject({ method: "PATCH", url: `/api/v1${url}`, headers, payload });
}
function get(url: string, headers = owner.headers) {
  return app.inject({ method: "GET", url: `/api/v1${url}`, headers });
}
function del(url: string, headers = owner.headers) {
  return app.inject({ method: "DELETE", url: `/api/v1${url}`, headers });
}

const base = () => `/projects/${projectId}/design`;

async function makePackage(name = "Facade technical design") {
  const res = await post(`${base()}/packages`, { name, discipline: "facade", stageKey: "stage_4" });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; reference: string; status: string; number: number };
}

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  if (!app.scheduler.has("design.deliverables")) await app.register(designModule, { prefix: "/api/v1" });
  owner = await registerActor(app);

  const second = await registerActor(app);
  await app.db
    .insert(companyMemberships)
    .values({ id: newId("cm"), companyId: owner.companyId, userId: second.userId, role: "admin" });
  reviewerActor = {
    ...second,
    companyId: owner.companyId,
    headers: { authorization: second.headers["authorization"]!, "x-company-id": owner.companyId },
  };

  const third = await registerActor(app);
  await app.db
    .insert(companyMemberships)
    .values({ id: newId("cm"), companyId: owner.companyId, userId: third.userId, role: "admin" });
  designer = {
    ...third,
    companyId: owner.companyId,
    headers: { authorization: third.headers["authorization"]!, "x-company-id": owner.companyId },
  };

  const viewer = await registerActor(app);
  await app.db
    .insert(companyMemberships)
    .values({ id: newId("cm"), companyId: owner.companyId, userId: viewer.userId, role: "member" });
  viewerHeaders = { authorization: viewer.headers["authorization"]!, "x-company-id": owner.companyId };

  stranger = await registerActor(app);

  projectId = newId("prj");
  await app.db
    .insert(projects)
    .values({ id: projectId, companyId: owner.companyId, name: "Design — core", stage: "design" });
  await app.db.insert(projectMemberships).values({
    id: newId("pm"),
    companyId: owner.companyId,
    projectId,
    userId: viewer.userId,
    templateKey: "read_only",
  });

  vendorId = newId("ven");
  await app.db.insert(vendors).values({ id: vendorId, companyId: owner.companyId, name: "Facade Consultants Ltd", country: "GB" });

  sheetId = newId("shs");
  await app.db.insert(drawingSheets).values({
    id: sheetId,
    companyId: owner.companyId,
    projectId,
    number: "A-201",
    title: "Facade elevation",
    discipline: "architectural",
  });
});

afterAll(async () => {
  await built.close();
});

/* ================================================================== */

describe("stage gates", () => {
  it("serves the stage library in the framework the project speaks", async () => {
    const res = await get(`${base()}/stages?framework=aia`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { library: Array<{ key: string; label: string }>; gates: unknown[] };
    expect(body.library).toHaveLength(8);
    expect(body.library.find((s) => s.key === "stage_3")?.label).toBe("Design Development");
    expect(body.gates).toEqual([]);
  });

  it("creates a gate once and refuses a duplicate for the same stage", async () => {
    const res = await post(`${base()}/stages`, {
      stageKey: "stage_3",
      framework: "riba_2020",
      plannedEnd: "2026-06-30",
      criteria: [
        { key: "coordination", label: "Model coordination signed off", met: false },
        { key: "cost", label: "Cost plan within budget", met: true },
      ],
    });
    expect(res.statusCode).toBe(201);
    const dup = await post(`${base()}/stages`, { stageKey: "stage_3" });
    expect(dup.statusCode).toBe(409);
  });

  it("refuses sign-off while a criterion is unmet and names it", async () => {
    const gates = (await get(`${base()}/stages`)).json() as {
      gates: Array<{ id: string; blockers: string[] }>;
    };
    const gate = gates.gates[0]!;
    expect(gate.blockers).toEqual(["Model coordination signed off"]);
    const res = await post(`${base()}/stages/${gate.id}/sign-off`, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("Model coordination signed off");
  });

  it("signs off once the criteria are met and records who and when", async () => {
    const gates = (await get(`${base()}/stages`)).json() as { gates: Array<{ id: string }> };
    const gate = gates.gates[0]!;
    await patch(`${base()}/stages/${gate.id}`, {
      criteria: [
        { key: "coordination", label: "Model coordination signed off", met: true },
        { key: "cost", label: "Cost plan within budget", met: true },
      ],
    });
    const res = await post(`${base()}/stages/${gate.id}/sign-off`, { notes: "RIBA 3 gate passed" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; signedOffBy: string; signedOffAt: string };
    expect(body.status).toBe("signed_off");
    expect(body.signedOffBy).toBe(owner.userId);
    expect(body.signedOffAt).toBeTruthy();
    // and it cannot be edited afterwards
    const edit = await patch(`${base()}/stages/${gate.id}`, { label: "changed" });
    expect(edit.statusCode).toBe(409);
  });

  it("records a forced sign-off with the criteria that were overridden", async () => {
    const created = await post(`${base()}/stages`, {
      stageKey: "stage_4",
      criteria: [{ key: "ifc", label: "IFC drawings complete", met: false }],
    });
    const gateId = (created.json() as { id: string }).id;
    const res = await post(`${base()}/stages/${gateId}/sign-off`, { force: true, notes: "Client instruction" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { blockersOverridden: string[] }).blockersOverridden).toEqual(["IFC drawings complete"]);
  });
});

/* ================================================================== */

describe("design packages", () => {
  it("numbers packages per project and ledgers the creation", async () => {
    const pkg = await makePackage();
    expect(pkg.reference).toMatch(/^DP-\d{3}$/);
    const rows = await app.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.companyId, owner.companyId), eq(ledgerEntries.objectId, pkg.id)));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.objectType).toBe("design_package");
  });

  it("refuses approval by the person who raised the package", async () => {
    const pkg = await makePackage("Structural frame — self approval");
    await post(`${base()}/packages/${pkg.id}/transition`, { to: "in_progress" });
    await post(`${base()}/packages/${pkg.id}/transition`, { to: "in_review" });
    const res = await post(`${base()}/packages/${pkg.id}/transition`, { to: "approved" });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("other than the person who raised it");
  });

  it("accepts approval from a different actor and clears it on reopening", async () => {
    const pkg = await makePackage("Structural frame — approved");
    await post(`${base()}/packages/${pkg.id}/transition`, { to: "in_progress" });
    await post(`${base()}/packages/${pkg.id}/transition`, { to: "in_review" });
    const approved = await post(
      `${base()}/packages/${pkg.id}/transition`,
      { to: "approved" },
      reviewerActor.headers,
    );
    expect(approved.statusCode).toBe(200);
    expect((approved.json() as { approvedBy: string }).approvedBy).toBe(reviewerActor.userId);
    const reopened = await post(`${base()}/packages/${pkg.id}/transition`, { to: "in_progress" });
    expect(reopened.statusCode).toBe(200);
    expect((reopened.json() as { approvedBy: string | null }).approvedBy).toBeNull();
  });

  it("refuses an illegal transition and says what is allowed", async () => {
    const pkg = await makePackage("Illegal transition");
    const res = await post(`${base()}/packages/${pkg.id}/transition`, { to: "approved" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("cannot move from planned to approved");
  });

  it("refuses to freeze through the transition route", async () => {
    const pkg = await makePackage("Freeze via transition");
    await post(`${base()}/packages/${pkg.id}/transition`, { to: "in_progress" });
    await post(`${base()}/packages/${pkg.id}/transition`, { to: "in_review" });
    await post(`${base()}/packages/${pkg.id}/transition`, { to: "approved" }, reviewerActor.headers);
    const res = await post(`${base()}/packages/${pkg.id}/transition`, { to: "frozen" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("design freeze");
  });

  it("refuses to edit an approved package in place", async () => {
    const pkg = await makePackage("Approved and edited");
    await post(`${base()}/packages/${pkg.id}/transition`, { to: "in_progress" });
    await post(`${base()}/packages/${pkg.id}/transition`, { to: "in_review" });
    await post(`${base()}/packages/${pkg.id}/transition`, { to: "approved" }, reviewerActor.headers);
    const res = await patch(`${base()}/packages/${pkg.id}`, { name: "renamed" });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("change notice");
  });

  it("rejects a lead vendor from another company", async () => {
    const foreign = newId("ven");
    await app.db.insert(vendors).values({ id: foreign, companyId: stranger.companyId, name: "Other Co" });
    const res = await post(`${base()}/packages`, { name: "Foreign vendor", leadVendorId: foreign });
    expect(res.statusCode).toBe(400);
  });

  it("gives a read-only member the register but not a write", async () => {
    const read = await get(`${base()}/packages`, viewerHeaders);
    expect(read.statusCode).toBe(200);
    const write = await post(`${base()}/packages`, { name: "By viewer" }, viewerHeaders);
    expect(write.statusCode).toBe(403);
  });

  it("keeps another company out entirely", async () => {
    expect((await get(`${base()}/packages`, stranger.headers)).statusCode).toBe(403);
    expect((await post(`${base()}/packages`, { name: "x" }, stranger.headers)).statusCode).toBe(403);
    expect((await get(`${base()}/summary`, stranger.headers)).statusCode).toBe(403);
  });
});

/* ================================================================== */

describe("design freeze", () => {
  it("freezes a package, refuses a second active freeze and lifts deliberately", async () => {
    const pkg = await makePackage("Frozen package");
    const created = await post(`${base()}/freezes`, {
      scope: "package",
      packageId: pkg.id,
      title: "Stage 4 freeze",
      requiredAuthorisation: "client",
    });
    expect(created.statusCode).toBe(201);
    const freezeId = (created.json() as { id: string }).id;

    const pkgAfter = (await get(`${base()}/packages/${pkg.id}`)).json() as { status: string; frozenAt: string | null };
    expect(pkgAfter.status).toBe("frozen");
    expect(pkgAfter.frozenAt).toBeTruthy();

    const dup = await post(`${base()}/freezes`, { scope: "package", packageId: pkg.id, title: "Again" });
    expect(dup.statusCode).toBe(409);

    const lifted = await post(`${base()}/freezes/${freezeId}/lift`, { reason: "Client instruction to reopen" });
    expect(lifted.statusCode).toBe(200);
    expect((lifted.json() as { status: string }).status).toBe("lifted");
    const again = await post(`${base()}/freezes/${freezeId}/lift`, { reason: "twice" });
    expect(again.statusCode).toBe(409);
  });

  it("refuses a package freeze that names no package", async () => {
    const res = await post(`${base()}/freezes`, { scope: "package", title: "Nothing frozen" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("fixes nothing");
  });
});

/* ================================================================== */

describe("review cycles", () => {
  let pkgId: string;
  let reviewId: string;

  it("opens a cycle and refuses a second one on the same package", async () => {
    const pkg = await makePackage("Reviewed package");
    pkgId = pkg.id;
    const res = await post(`${base()}/reviews`, {
      packageId: pkgId,
      title: "Stage 4 issue for comment",
      dueAt: "2026-01-15T00:00:00.000Z",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; cycleNumber: number; reference: string };
    reviewId = body.id;
    expect(body.cycleNumber).toBe(1);
    expect(body.reference).toMatch(/^DR-\d{3}$/);
    const dup = await post(`${base()}/reviews`, { packageId: pkgId, title: "Second" });
    expect(dup.statusCode).toBe(409);
  });

  it("only lets the named reviewer return their own code", async () => {
    const added = await post(`${base()}/reviews/${reviewId}/reviewers`, {
      userId: reviewerActor.userId,
      discipline: "structural",
      isRequired: true,
    });
    expect(added.statusCode).toBe(201);
    const participantId = (added.json() as { id: string }).id;
    const byOther = await post(`${base()}/reviews/${reviewId}/reviewers/${participantId}/return`, { code: "A" });
    expect(byOther.statusCode).toBe(403);
    expect(byOther.json().message).toContain("only the named reviewer");
  });

  it("blocks consolidation while a required reviewer is silent", async () => {
    await post(`${base()}/reviews/${reviewId}/reviewers`, {
      userId: designer.userId,
      discipline: "facade",
      isRequired: true,
    });
    const res = await post(`${base()}/reviews/${reviewId}/close`, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("not returned");
  });

  it("consolidates the worst code and stamps the turnaround", async () => {
    const detail = (await get(`${base()}/reviews/${reviewId}`)).json() as {
      participants: Array<{ id: string; userId: string | null }>;
    };
    const forReviewer = detail.participants.find((p) => p.userId === reviewerActor.userId)!;
    const forDesigner = detail.participants.find((p) => p.userId === designer.userId)!;

    const a = await post(
      `${base()}/reviews/${reviewId}/reviewers/${forReviewer.id}/return`,
      {
        code: "A",
        comments: [{ body: "Structural grid confirmed", category: "coordination", priority: "low" }],
      },
      reviewerActor.headers,
    );
    expect(a.statusCode).toBe(200);
    const c = await post(
      `${base()}/reviews/${reviewId}/reviewers/${forDesigner.id}/return`,
      {
        code: "C",
        summary: "Facade build-up not resolved",
        comments: [
          { body: "Cill detail clashes with slab edge", category: "buildability", priority: "high", drawingSheetId: sheetId },
        ],
      },
      designer.headers,
    );
    expect(c.statusCode).toBe(200);
    expect((c.json() as { consolidation: { code: string } }).consolidation.code).toBe("C");

    const closed = await post(`${base()}/reviews/${reviewId}/close`, {});
    expect(closed.statusCode).toBe(200);
    const body = closed.json() as {
      consolidatedCode: string;
      consolidationBasis: string;
      turnaroundDays: number | null;
      requiresResubmission: boolean;
    };
    expect(body.consolidatedCode).toBe("C");
    expect(body.consolidationBasis).toContain("Worst of");
    expect(body.turnaroundDays).not.toBeNull();
    expect(body.requiresResubmission).toBe(true);
  });

  it("refuses a duplicate return and a comment on a closed cycle", async () => {
    const detail = (await get(`${base()}/reviews/${reviewId}`)).json() as {
      participants: Array<{ id: string; userId: string | null }>;
    };
    const forReviewer = detail.participants.find((p) => p.userId === reviewerActor.userId)!;
    const again = await post(
      `${base()}/reviews/${reviewId}/reviewers/${forReviewer.id}/return`,
      { code: "A" },
      reviewerActor.headers,
    );
    expect(again.statusCode).toBe(409);
    const comment = await post(`${base()}/reviews/${reviewId}/comments`, { body: "Late thought" });
    expect(comment.statusCode).toBe(409);
    const closeAgain = await post(`${base()}/reviews/${reviewId}/close`, {});
    expect(closeAgain.statusCode).toBe(409);
  });

  it("opens the resubmission with the cycle number incremented", async () => {
    const res = await post(`${base()}/reviews`, {
      packageId: pkgId,
      title: "Stage 4 resubmission",
      previousReviewId: reviewId,
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { cycleNumber: number }).cycleNumber).toBe(2);
  });

  it("refuses a resubmission that follows a cycle from a different package", async () => {
    const other = await makePackage("Other package");
    const res = await post(`${base()}/reviews`, {
      packageId: other.id,
      title: "Mismatched",
      previousReviewId: reviewId,
    });
    expect(res.statusCode).toBe(400);
  });
});

/* ================================================================== */

describe("review comments", () => {
  let reviewId: string;
  let commentId: string;

  beforeAll(async () => {
    const pkg = await makePackage("Commented package");
    const review = await post(`${base()}/reviews`, { packageId: pkg.id, title: "Comment cycle" });
    reviewId = (review.json() as { id: string }).id;
    const comment = await post(`${base()}/reviews/${reviewId}/comments`, {
      body: "Rainwater outlet missing from the roof plan",
      category: "compliance",
      priority: "high",
      drawingSheetId: sheetId,
    });
    expect(comment.statusCode).toBe(201);
    commentId = (comment.json() as { id: string }).id;
  });

  it("refuses a comment that points at a sheet in another project", async () => {
    const res = await post(`${base()}/reviews/${reviewId}/comments`, { body: "x", drawingSheetId: newId("shs") });
    expect(res.statusCode).toBe(400);
  });

  it("refuses an answer from the person who raised the comment", async () => {
    const res = await post(`${base()}/comments/${commentId}/respond`, { response: "Fixed it myself" });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("cannot answer it");
  });

  it("accepts an answer from the designer and refuses closure by the designer", async () => {
    const responded = await post(
      `${base()}/comments/${commentId}/respond`,
      { response: "Outlet added on revision P03" },
      designer.headers,
    );
    expect(responded.statusCode).toBe(200);
    expect((responded.json() as { status: string }).status).toBe("responded");

    const closedByDesigner = await post(`${base()}/comments/${commentId}/close`, {}, designer.headers);
    expect(closedByDesigner.statusCode).toBe(403);
    expect(closedByDesigner.json().message).toContain("Only the reviewer who raised");

    const closed = await post(`${base()}/comments/${commentId}/close`, { note: "Confirmed on P03" });
    expect(closed.statusCode).toBe(200);
    expect((closed.json() as { status: string }).status).toBe("closed");
  });

  it("refuses to close a comment nobody has answered", async () => {
    const fresh = await post(`${base()}/reviews/${reviewId}/comments`, { body: "Unanswered" });
    const id = (fresh.json() as { id: string }).id;
    const res = await post(`${base()}/comments/${id}/close`, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("once it has been answered");
    const withdrawn = await post(`${base()}/comments/${id}/close`, { status: "withdrawn" });
    expect(withdrawn.statusCode).toBe(200);
  });

  it("escalates a comment into the issue register once", async () => {
    const fresh = await post(`${base()}/reviews/${reviewId}/comments`, {
      body: "Fire strategy conflicts with the stair core",
      priority: "critical",
      discipline: "fire",
    });
    const id = (fresh.json() as { id: string }).id;
    const escalated = await post(`${base()}/comments/${id}/escalate`, { assignedToUserId: designer.userId });
    expect(escalated.statusCode).toBe(201);
    const issue = escalated.json() as { reference: string; status: string; discipline: string; commentId: string };
    expect(issue.reference).toMatch(/^DI-\d{3}$/);
    expect(issue.status).toBe("assigned");
    expect(issue.discipline).toBe("fire");
    expect(issue.commentId).toBe(id);
    const again = await post(`${base()}/comments/${id}/escalate`, {});
    expect(again.statusCode).toBe(409);
  });
});

/* ================================================================== */

describe("issue register", () => {
  let issueId: string;

  it("creates an issue routed to a discipline", async () => {
    const res = await post(`${base()}/issues`, {
      title: "Riser clash between MEP and structure at grid C4",
      issueType: "clash",
      priority: "high",
      discipline: "bim_coordination",
      affectedDisciplines: ["mechanical", "structural"],
      dueDate: "2026-02-01",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; status: string; reference: string };
    issueId = body.id;
    expect(body.status).toBe("open");
  });

  it("refuses to change the assignee through the generic PATCH", async () => {
    const res = await patch(`${base()}/issues/${issueId}`, { assignedToUserId: designer.userId });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("/assign");
  });

  it("routes the issue and notifies the assignee", async () => {
    const res = await post(`${base()}/issues/${issueId}/assign`, {
      assignedToUserId: designer.userId,
      discipline: "mechanical",
      dueDate: "2026-02-10",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; discipline: string; assignedToUserId: string };
    expect(body.status).toBe("assigned");
    expect(body.discipline).toBe("mechanical");
    expect(body.assignedToUserId).toBe(designer.userId);
  });

  it("refuses an assignment that routes to nothing", async () => {
    const res = await post(`${base()}/issues/${issueId}/assign`, {});
    expect(res.statusCode).toBe(400);
  });

  it("refuses closure by the person who resolved it", async () => {
    const resolved = await post(
      `${base()}/issues/${issueId}/resolve`,
      { resolution: "Riser relocated to grid C5" },
      designer.headers,
    );
    expect(resolved.statusCode).toBe(200);
    const selfClose = await post(`${base()}/issues/${issueId}/close`, {}, designer.headers);
    expect(selfClose.statusCode).toBe(403);
    expect(selfClose.json().message).toContain("cannot be done by whoever resolved it");
    const closed = await post(`${base()}/issues/${issueId}/close`, { note: "Verified against the coordinated model" });
    expect(closed.statusCode).toBe(200);
    expect((closed.json() as { status: string }).status).toBe("closed");
  });

  it("refuses to close an issue that was never resolved", async () => {
    const created = await post(`${base()}/issues`, { title: "Unresolved" });
    const id = (created.json() as { id: string }).id;
    const res = await post(`${base()}/issues/${id}/close`, {});
    expect(res.statusCode).toBe(400);
  });

  it("reopens a closed issue and clears the resolution", async () => {
    const res = await post(`${base()}/issues/${issueId}/reopen`, { reason: "Clash returned on the next model issue" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; resolvedAt: string | null; closedAt: string | null };
    expect(body.status).toBe("assigned");
    expect(body.resolvedAt).toBeNull();
    expect(body.closedAt).toBeNull();
  });

  it("reports ball-in-court by discipline", async () => {
    const res = await get(`${base()}/issues-by-discipline`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ discipline: string; open: number; critical: number }> };
    expect(body.items.length).toBeGreaterThan(0);
    const mechanical = body.items.find((i) => i.discipline === "mechanical");
    expect(mechanical?.open).toBeGreaterThanOrEqual(1);
  });

  it("voids an issue with a reason", async () => {
    const created = await post(`${base()}/issues`, { title: "Raised in error" });
    const id = (created.json() as { id: string }).id;
    const res = await post(`${base()}/issues/${id}/void`, { reason: "Duplicate of DI-001" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe("void");
    const again = await post(`${base()}/issues/${id}/void`, { reason: "again" });
    expect(again.statusCode).toBe(409);
  });

  it("keeps another company out of the register", async () => {
    expect((await get(`${base()}/issues`, stranger.headers)).statusCode).toBe(403);
    expect((await get(`${base()}/issues/${issueId}`, stranger.headers)).statusCode).toBe(403);
  });
});

/* ================================================================== */

describe("decision log", () => {
  let decisionId: string;

  it("records the question and the options", async () => {
    const res = await post(`${base()}/decisions`, {
      title: "Facade cladding system",
      question: "Unitised or stick-built curtain walling?",
      discipline: "facade",
      options: [
        { key: "unitised", label: "Unitised", costImpact: 250_000, timeImpactDays: -20 },
        { key: "stick", label: "Stick-built", costImpact: 0, timeImpactDays: 0 },
      ],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; status: string; reference: string };
    decisionId = body.id;
    expect(body.status).toBe("proposed");
    expect(body.reference).toMatch(/^DD-\d{3}$/);
  });

  it("refuses duplicate option keys", async () => {
    const res = await post(`${base()}/decisions`, {
      title: "Bad options",
      question: "?",
      options: [
        { key: "a", label: "A" },
        { key: "a", label: "A again" },
      ],
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a decision taken by its own proposer", async () => {
    const res = await post(`${base()}/decisions/${decisionId}/decide`, {
      decision: "Unitised",
      rationale: "Programme benefit outweighs the premium",
      chosenOptionKey: "unitised",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("other than whoever proposed it");
  });

  it("refuses a chosen option that is not on the record", async () => {
    const res = await post(
      `${base()}/decisions/${decisionId}/decide`,
      { decision: "Something else", rationale: "x", chosenOptionKey: "timber" },
      reviewerActor.headers,
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("one of the recorded options");
  });

  it("takes the decision, records the authority and locks it against editing", async () => {
    const res = await post(
      `${base()}/decisions/${decisionId}/decide`,
      {
        decision: "Unitised curtain walling",
        rationale: "Twenty days of programme for a 250k premium; approved against the risk allowance.",
        chosenOptionKey: "unitised",
        authorisationLevel: "client",
        costImpact: 250_000,
        currency: "GBP",
        timeImpactDays: -20,
      },
      reviewerActor.headers,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; decidedBy: string; authorisationLevel: string };
    expect(body.status).toBe("decided");
    expect(body.decidedBy).toBe(reviewerActor.userId);
    expect(body.authorisationLevel).toBe("client");
    const edit = await patch(`${base()}/decisions/${decisionId}`, { title: "renamed" });
    expect(edit.statusCode).toBe(409);
  });

  it("supersedes the earlier decision when the replacement is taken", async () => {
    const created = await post(`${base()}/decisions`, {
      title: "Facade cladding system — revisited",
      question: "Still unitised after the value engineering exercise?",
      supersedesId: decisionId,
      options: [{ key: "stick", label: "Stick-built" }],
    });
    const newId2 = (created.json() as { id: string }).id;
    const decided = await post(
      `${base()}/decisions/${newId2}/decide`,
      { decision: "Stick-built", rationale: "Budget cut", chosenOptionKey: "stick" },
      reviewerActor.headers,
    );
    expect(decided.statusCode).toBe(200);
    const previous = (await get(`${base()}/decisions/${decisionId}`)).json() as {
      status: string;
      supersededById: string;
    };
    expect(previous.status).toBe("superseded");
    expect(previous.supersededById).toBe(newId2);
  });

  it("reverses a decision that was taken", async () => {
    const created = await post(`${base()}/decisions`, { title: "To be reversed", question: "?" });
    const id = (created.json() as { id: string }).id;
    await post(`${base()}/decisions/${id}/decide`, { decision: "Yes", rationale: "because" }, reviewerActor.headers);
    const res = await post(`${base()}/decisions/${id}/reverse`, { reason: "Client changed their mind" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe("reversed");
  });
});

/* ================================================================== */

describe("cross-tool links", () => {
  it("links a package to a drawing sheet, deduplicates and removes", async () => {
    const pkg = await makePackage("Linked package");
    const created = await post(`${base()}/links`, {
      fromType: "design_package",
      fromId: pkg.id,
      toType: "drawing_sheet",
      toId: sheetId,
    });
    expect(created.statusCode).toBe(201);
    const linkId = (created.json() as { id: string }).id;

    const again = await post(`${base()}/links`, {
      fromType: "design_package",
      fromId: pkg.id,
      toType: "drawing_sheet",
      toId: sheetId,
    });
    expect(again.statusCode).toBe(200);
    expect((again.json() as { created: boolean }).created).toBe(false);

    const listed = (await get(`${base()}/links?fromId=${pkg.id}`)).json() as { items: unknown[] };
    expect(listed.items).toHaveLength(1);

    expect((await del(`${base()}/links/${linkId}`)).statusCode).toBe(200);
  });

  it("refuses a link whose source is not in this project", async () => {
    const res = await post(`${base()}/links`, {
      fromType: "design_package",
      fromId: newId("dpk"),
      toType: "drawing_sheet",
      toId: sheetId,
    });
    expect(res.statusCode).toBe(404);
  });

  it("refuses a link to a sheet in another project", async () => {
    const pkg = await makePackage("Bad link target");
    const res = await post(`${base()}/links`, {
      fromType: "design_package",
      fromId: pkg.id,
      toType: "drawing_sheet",
      toId: newId("shs"),
    });
    expect(res.statusCode).toBe(400);
  });
});

/* ================================================================== */

describe("register reads and lifecycle edges", () => {
  it("lists comments across the project with filters", async () => {
    const all = await get(`${base()}/comments`);
    expect(all.statusCode).toBe(200);
    const body = all.json() as { items: Array<{ status: string }>; total: number };
    expect(body.total).toBeGreaterThan(0);
    const open = await get(`${base()}/comments?open=true`);
    expect(open.statusCode).toBe(200);
    const openBody = open.json() as { items: Array<{ status: string }> };
    for (const comment of openBody.items) expect(["open", "responded"]).toContain(comment.status);
    expect((await get(`${base()}/comments`, stranger.headers)).statusCode).toBe(403);
  });

  it("serves the package lookup the workspace pickers use", async () => {
    const res = await get(`${base()}/packages-lookup`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ id: string; reference: string; name: string }>; total: number };
    expect(body.total).toBeGreaterThan(0);
    expect(body.items[0]?.reference).toMatch(/^DP-\d{3}$/);
  });

  it("serves a package's review and change history", async () => {
    const pkg = await makePackage("History package");
    await post(`${base()}/reviews`, { packageId: pkg.id, title: "First issue" });
    const res = await get(`${base()}/packages/${pkg.id}/history`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { reviews: Array<{ cycleNumber: number }>; changeNotices: unknown[] };
    expect(body.reviews).toHaveLength(1);
    expect(body.changeNotices).toEqual([]);
    expect((await get(`${base()}/packages/${pkg.id}/history`, stranger.headers)).statusCode).toBe(403);
  });

  it("edits an open review cycle and refuses to edit a closed one", async () => {
    const pkg = await makePackage("Editable cycle");
    const review = await post(`${base()}/reviews`, { packageId: pkg.id, title: "Editable" });
    const reviewId = (review.json() as { id: string }).id;
    const patched = await patch(`${base()}/reviews/${reviewId}`, { title: "Renamed cycle", dueAt: "2026-05-01T00:00:00.000Z" });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { title: string }).title).toBe("Renamed cycle");

    const added = await post(`${base()}/reviews/${reviewId}/reviewers`, { userId: reviewerActor.userId, isRequired: true });
    const participantId = (added.json() as { id: string }).id;
    await post(`${base()}/reviews/${reviewId}/reviewers/${participantId}/return`, { code: "A" }, reviewerActor.headers);
    await post(`${base()}/reviews/${reviewId}/close`, {});
    const afterClose = await patch(`${base()}/reviews/${reviewId}`, { title: "Too late" });
    expect(afterClose.statusCode).toBe(409);
  });

  it("cancels a cycle that should never have been issued", async () => {
    const pkg = await makePackage("Cancelled cycle");
    const review = await post(`${base()}/reviews`, { packageId: pkg.id, title: "Issued in error" });
    const reviewId = (review.json() as { id: string }).id;
    const res = await post(`${base()}/reviews/${reviewId}/cancel`, { reason: "Issued against the wrong revision" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe("cancelled");
    const again = await post(`${base()}/reviews/${reviewId}/close`, {});
    expect(again.statusCode).toBe(409);
  });

  it("rejects a stage gate with a recorded reason", async () => {
    const created = await post(`${base()}/stages`, { stageKey: "stage_5", criteria: [] });
    const gateId = (created.json() as { id: string }).id;
    const res = await post(`${base()}/stages/${gateId}/reject`, { reason: "Coordination not complete at the gate meeting" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; rejectedReason: string };
    expect(body.status).toBe("rejected");
    expect(body.rejectedReason).toContain("Coordination");
  });

  it("keeps another company out of the stage plan and the freeze register", async () => {
    expect((await get(`${base()}/stages`, stranger.headers)).statusCode).toBe(403);
    expect((await get(`${base()}/freezes`, stranger.headers)).statusCode).toBe(403);
    expect((await post(`${base()}/freezes`, { scope: "project", title: "x" }, stranger.headers)).statusCode).toBe(403);
    expect((await get(`${base()}/decisions`, stranger.headers)).statusCode).toBe(403);
    expect((await get(`${base()}/reviews`, stranger.headers)).statusCode).toBe(403);
    expect((await get(`${base()}/links`, stranger.headers)).statusCode).toBe(403);
  });
});
