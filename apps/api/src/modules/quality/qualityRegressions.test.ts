/**
 * Regression tests for the defects the platform audit found in this module.
 *
 * Each block names the failure it prevents coming back. They are kept apart
 * from quality.test.ts because they are about the SHAPE of the controls — a
 * shared counter, a patchable status, an ungated controlled form — rather than
 * about the chain the main suite walks through.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  checklistTemplates,
  companyMemberships,
  itpActivities,
  nonConformanceReports,
  projects,
  safetyCorrectiveActions,
  vendors,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;

let owner: TestActor;
let engineer: TestActor;
let guest: TestActor;
let engineerHeaders: Record<string, string>;
let guestHeaders: Record<string, string>;
let projectId: string;
let vendorId: string;

const api = (path: string) => `/api/v1${path}`;

async function join(actor: TestActor, role: "admin" | "guest"): Promise<Record<string, string>> {
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: actor.userId,
    role,
  });
  return {
    authorization: actor.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };
}

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  engineer = await registerActor(app);
  guest = await registerActor(app);
  engineerHeaders = await join(engineer, "admin");
  guestHeaders = await join(guest, "guest");

  projectId = newId("prj");
  await app.db
    .insert(projects)
    .values({ id: projectId, companyId: owner.companyId, name: "Regression P1" });
  vendorId = newId("ven");
  await app.db
    .insert(vendors)
    .values({ id: vendorId, companyId: owner.companyId, name: "Sub Ltd" });
  // Booting an embedded PGlite and applying the full migration set is slow on
  // a loaded machine; the file-level default of 30s is not enough for it.
}, 180_000);

afterAll(async () => {
  await built.close();
});

/* ================================================================== */
/* One shared register, one counter                                    */
/* ================================================================== */

describe("corrective actions from two registers on one project", () => {
  it("allocates from the SAME counter as the safety register, so the second insert does not collide", async () => {
    const ncr = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/ncrs`),
      payload: { title: "Honeycombing to column C4", description: "Voids in the cover zone." },
      headers: owner.headers,
    });
    expect(ncr.statusCode).toBe(201);
    const ncrId = ncr.json().id as string;

    // One action raised through the SAFETY route...
    const fromSafety = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/safety/corrective-actions`),
      payload: {
        sourceType: "audit",
        sourceId: newId("aud"),
        title: "Toolbox talk on cover control",
        hierarchyOfControl: "administrative",
        ownerName: "Site manager",
        dueDate: "2030-01-31",
      },
      headers: owner.headers,
    });
    expect(fromSafety.statusCode).toBe(201);

    // ...and one through the QUALITY route, on the same project. Before the
    // fix these came from two counters into one unique index and the second
    // insert died with a Postgres unique violation, surfacing as a 500.
    const fromQuality = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/ncrs/${ncrId}/actions`),
      payload: { title: "Break out and recast the cover zone", dueDate: "2030-02-15" },
      headers: owner.headers,
    });
    expect(fromQuality.statusCode).toBe(201);

    const rows = await app.db
      .select()
      .from(safetyCorrectiveActions)
      .where(eq(safetyCorrectiveActions.projectId, projectId));
    expect(rows).toHaveLength(2);
    const numbers = rows.map((r) => r.number).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2]);
    expect(rows.every((r) => /^CA-\d{4}$/.test(r.reference))).toBe(true);

    // And a third, whichever way round, still works.
    const third = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/ncrs/${ncrId}/actions`),
      payload: { title: "Re-survey the affected pour", dueDate: "2030-03-01" },
      headers: owner.headers,
    });
    expect(third.statusCode).toBe(201);
    expect(third.json().reference).toBe("CA-0003");
  });
});

/* ================================================================== */
/* Hold-point control cannot be bypassed through PATCH                 */
/* ================================================================== */

describe("ITP activity status is not patchable", () => {
  let itpId: string;
  let activityId: string;

  beforeAll(async () => {
    const itp = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/itps`),
      payload: { title: "Piling ITP", discipline: "civils" },
      headers: owner.headers,
    });
    itpId = itp.json().id;
    const activity = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/itps/${itpId}/activities`),
      payload: {
        activity: "Pre-pour reinforcement inspection",
        activityCode: "A-010",
        interventionPoint: "hold_point",
        noticePeriodHours: 24,
        plannedDate: "2030-01-10",
        verifyingParties: [{ party: "engineer", userId: engineer.userId }],
      },
      headers: owner.headers,
    });
    expect(activity.statusCode).toBe(201);
    activityId = activity.json().id;
  });

  it("ignores a status sent through PATCH — an unreleased hold point stays open", async () => {
    const patched = await app.inject({
      method: "PATCH",
      url: api(`/projects/${projectId}/itps/${itpId}/activities/${activityId}`),
      payload: { status: "closed", actualDate: "2030-01-10" },
      headers: owner.headers,
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().status).toBe("pending");
    const [row] = await app.db
      .select()
      .from(itpActivities)
      .where(eq(itpActivities.id, activityId));
    expect(row!.status).toBe("pending");
  });

  it("refuses to close an unreleased hold point through the explicit route", async () => {
    const closed = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/itps/${itpId}/activities/${activityId}/close`),
      headers: owner.headers,
    });
    expect(closed.statusCode).toBe(400);
    expect(closed.json().message).toContain("released by its verifying party");
  });

  it("refuses `not applicable` from the person who raised the point, and demands a reason", async () => {
    const noReason = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/itps/${itpId}/activities/${activityId}/not-applicable`),
      payload: {},
      headers: owner.headers,
    });
    expect(noReason.statusCode).toBe(400);

    const selfServed = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/itps/${itpId}/activities/${activityId}/not-applicable`),
      payload: { reason: "Piling redesigned; this point no longer applies." },
      headers: owner.headers,
    });
    expect(selfServed.statusCode).toBe(403);
    expect(selfServed.json().message).toContain("someone other than");
  });

  it("records a failure, and a reopen clears the release columns it used to leave behind", async () => {
    const failed = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/itps/${itpId}/activities/${activityId}/fail`),
      payload: { reason: "Cover short on the north face." },
      headers: engineerHeaders,
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json().status).toBe("failed");

    const reopened = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/itps/${itpId}/activities/${activityId}/reopen`),
      payload: { reason: "Reinforcement corrected; re-inspection booked." },
      headers: owner.headers,
    });
    expect(reopened.statusCode).toBe(200);
    expect(["pending", "notified"]).toContain(reopened.json().status);

    const released = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/itps/${itpId}/activities/${activityId}/release`),
      payload: { note: "Verified on site." },
      headers: engineerHeaders,
    });
    expect(released.statusCode).toBe(200);
    expect(released.json().releasedBy).toBe(engineer.userId);

    const reopenedAgain = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/itps/${itpId}/activities/${activityId}/reopen`),
      payload: { reason: "Release given against the wrong pour." },
      headers: owner.headers,
    });
    expect(reopenedAgain.statusCode).toBe(200);
    expect(reopenedAgain.json().releasedBy).toBeNull();
    expect(reopenedAgain.json().releasedAt).toBeNull();
  });

  it("refuses to close a plan that was never agreed", async () => {
    const draft = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/itps`),
      payload: { title: "Never-agreed plan" },
      headers: owner.headers,
    });
    const closed = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/itps/${draft.json().id}/close`),
      headers: owner.headers,
    });
    expect(closed.statusCode).toBe(400);
    expect(closed.json().message).toContain("has nothing to close");
  });
});

/* ================================================================== */
/* Controlled forms are not editable by a guest                        */
/* ================================================================== */

describe("checklist template authoring", () => {
  it("lets a guest read the forms but not author, approve or retire them", async () => {
    const read = await app.inject({
      method: "GET",
      url: api("/companies/current/checklist-templates"),
      headers: guestHeaders,
    });
    expect(read.statusCode).toBe(200);

    const created = await app.inject({
      method: "POST",
      url: api("/companies/current/checklist-templates"),
      payload: {
        reference: "GUEST-01",
        name: "A form a guest should not be able to issue",
        items: [{ text: "Anything", itemType: "pass_fail" }],
      },
      headers: guestHeaders,
    });
    expect(created.statusCode).toBe(403);

    const rows = await app.db
      .select()
      .from(checklistTemplates)
      .where(
        and(
          eq(checklistTemplates.companyId, owner.companyId),
          eq(checklistTemplates.reference, "GUEST-01"),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  it("still lets a member author one, and rolls back the items when one is invalid", async () => {
    const ok = await app.inject({
      method: "POST",
      url: api("/companies/current/checklist-templates"),
      payload: {
        reference: "QA-WELD",
        name: "Weld visual inspection",
        items: [{ itemNumber: "1", text: "Profile and undercut", itemType: "pass_fail" }],
      },
      headers: owner.headers,
    });
    expect(ok.statusCode).toBe(201);

    const partial = await app.inject({
      method: "POST",
      url: api("/companies/current/checklist-templates"),
      payload: {
        reference: "QA-PARTIAL",
        name: "Half a form",
        items: [
          { itemNumber: "1", text: "Fine", itemType: "pass_fail" },
          { itemNumber: "2", text: "Slump", itemType: "measurement", targetValue: 100 },
        ],
      },
      headers: owner.headers,
    });
    expect(partial.statusCode).toBe(400);
    const rows = await app.db
      .select()
      .from(checklistTemplates)
      .where(
        and(
          eq(checklistTemplates.companyId, owner.companyId),
          eq(checklistTemplates.reference, "QA-PARTIAL"),
        ),
      );
    expect(rows).toHaveLength(0);
  });
});

/* ================================================================== */
/* Money is never summed across currencies                             */
/* ================================================================== */

describe("cost of non-conformance", () => {
  it("reports one figure per currency and refuses a mixed total", async () => {
    const mixedProject = newId("prj");
    await app.db
      .insert(projects)
      .values({ id: mixedProject, companyId: owner.companyId, name: "Mixed currency" });
    for (const [currency, cost] of [
      ["GBP", 1200],
      ["USD", 800],
    ] as const) {
      const created = await app.inject({
        method: "POST",
        url: api(`/projects/${mixedProject}/ncrs`),
        payload: { title: `${currency} defect`, description: "Cost recorded in its own currency." },
        headers: owner.headers,
      });
      await app.inject({
        method: "PATCH",
        url: api(`/projects/${mixedProject}/ncrs/${created.json().id}`),
        payload: { costImpact: cost, currency },
        headers: owner.headers,
      });
    }
    const summary = await app.inject({
      method: "GET",
      url: api(`/projects/${mixedProject}/quality/summary`),
      headers: owner.headers,
    });
    expect(summary.statusCode).toBe(200);
    const ncrs = summary.json().ncrs;
    expect(ncrs.totalCostImpact.value).toBeNull();
    expect(ncrs.totalCostImpact.reasons.join(" ")).toContain("invented number");
    const byCurrency = ncrs.costByCurrency as Array<{ value: number; unit: string }>;
    expect(byCurrency.map((f) => f.unit).sort()).toEqual(["GBP", "USD"]);
    expect(byCurrency.find((f) => f.unit === "GBP")!.value).toBe(1200);
  });

  it("still reports a single-currency total as a number", async () => {
    const single = newId("prj");
    await app.db
      .insert(projects)
      .values({ id: single, companyId: owner.companyId, name: "Single currency" });
    const created = await app.inject({
      method: "POST",
      url: api(`/projects/${single}/ncrs`),
      payload: { title: "One currency", description: "Only USD here." },
      headers: owner.headers,
    });
    await app.inject({
      method: "PATCH",
      url: api(`/projects/${single}/ncrs/${created.json().id}`),
      payload: { costImpact: 500, currency: "USD" },
      headers: owner.headers,
    });
    const summary = await app.inject({
      method: "GET",
      url: api(`/projects/${single}/quality/summary`),
      headers: owner.headers,
    });
    expect(summary.json().ncrs.totalCostImpact.value).toBe(500);
  });
});

/* ================================================================== */
/* NCR status transitions are explicit                                 */
/* ================================================================== */

describe("NCR status", () => {
  it("cannot be walked backwards through PATCH, and voiding clears the approval", async () => {
    const created = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/ncrs`),
      payload: { title: "Wrong grade bolts", description: "8.8 where 10.9 specified." },
      headers: owner.headers,
    });
    const ncrId = created.json().id as string;
    await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/ncrs/${ncrId}/disposition/propose`),
      payload: { disposition: "repair", justification: "Replace with the specified grade." },
      headers: owner.headers,
    });
    const approved = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/ncrs/${ncrId}/disposition/approve`),
      payload: { decision: "approve", concessionReference: "CON-REPAIR-1" },
      headers: engineerHeaders,
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe("disposition_approved");

    // The old PATCH could set status back to `open` while leaving
    // dispositionApprovedBy populated, so the close route's gate still passed.
    const patched = await app.inject({
      method: "PATCH",
      url: api(`/projects/${projectId}/ncrs/${ncrId}`),
      payload: { status: "open" },
      headers: owner.headers,
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().status).toBe("disposition_approved");

    const sentBack = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/ncrs/${ncrId}/send-back`),
      payload: { reason: "The designer wants a different repair detail." },
      headers: engineerHeaders,
    });
    expect(sentBack.statusCode).toBe(200);
    expect(sentBack.json().status).toBe("under_review");
    expect(sentBack.json().dispositionApprovedBy).toBeNull();
    expect(sentBack.json().disposition).toBe("pending");

    const closeAttempt = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/ncrs/${ncrId}/close`),
      payload: { closeoutEvidenceDescription: "Bolts replaced." },
      headers: owner.headers,
    });
    expect(closeAttempt.statusCode).toBe(400);
    expect(closeAttempt.json().message).toContain("disposition");

    const voided = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/ncrs/${ncrId}/void`),
      payload: { reason: "Raised against the wrong bolt schedule." },
      headers: owner.headers,
    });
    expect(voided.statusCode).toBe(200);
    expect(voided.json().status).toBe("void");
    const [row] = await app.db
      .select()
      .from(nonConformanceReports)
      .where(eq(nonConformanceReports.id, ncrId));
    expect(row!.dispositionApprovedBy).toBeNull();
  });

  it("filters overdue NCRs in SQL, so a page is a full page and the total is the total", async () => {
    const p = newId("prj");
    await app.db.insert(projects).values({ id: p, companyId: owner.companyId, name: "Overdue" });
    for (const [title, due] of [
      ["Overdue one", "2020-01-01"],
      ["Overdue two", "2020-02-01"],
      ["Not due", "2099-01-01"],
    ] as const) {
      await app.inject({
        method: "POST",
        url: api(`/projects/${p}/ncrs`),
        payload: { title, description: "…", responseDueDate: due },
        headers: owner.headers,
      });
    }
    const page = await app.inject({
      method: "GET",
      url: api(`/projects/${p}/ncrs?overdueOnly=true&page=1&pageSize=1`),
      headers: owner.headers,
    });
    expect(page.statusCode).toBe(200);
    expect(page.json().total).toBe(2);
    expect(page.json().items).toHaveLength(1);

    const secondPage = await app.inject({
      method: "GET",
      url: api(`/projects/${p}/ncrs?overdueOnly=true&page=2&pageSize=1`),
      headers: owner.headers,
    });
    expect(secondPage.json().items).toHaveLength(1);
  });
});

/* ================================================================== */
/* Completion, witnessing and re-recording                             */
/* ================================================================== */

describe("checklist completion and witnessing", () => {
  let templateId: string;

  beforeAll(async () => {
    const template = await app.inject({
      method: "POST",
      url: api("/companies/current/checklist-templates"),
      payload: {
        reference: "QA-CONCURRENCY",
        name: "Single critical item",
        items: [
          {
            itemNumber: "1",
            text: "Bolt torque",
            itemType: "pass_fail",
            isCritical: true,
            raisesNcrOnFail: true,
          },
        ],
      },
      headers: owner.headers,
    });
    templateId = template.json().id;
    await app.inject({
      method: "POST",
      url: api(`/companies/current/checklist-templates/${templateId}/approve`),
      headers: engineerHeaders,
    });
  });

  it("raises exactly one NCR when the same completion is submitted twice at once", async () => {
    const p = newId("prj");
    await app.db.insert(projects).values({ id: p, companyId: owner.companyId, name: "Concurrent" });
    const checklist = await app.inject({
      method: "POST",
      url: api(`/projects/${p}/checklists`),
      payload: { templateId },
      headers: owner.headers,
    });
    const checklistId = checklist.json().id as string;
    const responseId = checklist.json().responses[0].id as string;
    const answered = await app.inject({
      method: "PUT",
      url: api(`/projects/${p}/checklists/${checklistId}/responses/${responseId}`),
      payload: { response: "fail", note: "Torque short on four bolts." },
      headers: owner.headers,
    });
    expect(answered.statusCode).toBe(200);

    const [first, second] = await Promise.all([
      app.inject({
        method: "POST",
        url: api(`/projects/${p}/checklists/${checklistId}/complete`),
        payload: {},
        headers: owner.headers,
      }),
      app.inject({
        method: "POST",
        url: api(`/projects/${p}/checklists/${checklistId}/complete`),
        payload: {},
        headers: owner.headers,
      }),
    ]);
    const codes = [first.statusCode, second.statusCode].sort();
    expect(codes[0]).toBe(200);
    expect(codes[1]).toBeGreaterThanOrEqual(400);

    const ncrs = await app.db
      .select()
      .from(nonConformanceReports)
      .where(eq(nonConformanceReports.projectId, p));
    expect(ncrs).toHaveLength(1);
  });

  it("refuses a witness on a record nobody has performed", async () => {
    const p = newId("prj");
    await app.db.insert(projects).values({ id: p, companyId: owner.companyId, name: "Witness" });
    const checklist = await app.inject({
      method: "POST",
      url: api(`/projects/${p}/checklists`),
      payload: { templateId },
      headers: owner.headers,
    });
    const witness = await app.inject({
      method: "POST",
      url: api(`/projects/${p}/checklists/${checklist.json().id}/witness`),
      payload: { name: "A. Witness" },
      headers: engineerHeaders,
    });
    expect(witness.statusCode).toBe(400);
    expect(witness.json().message).toContain("performed");
  });
});

describe("commissioning test records", () => {
  let systemId: string;
  let recordId: string;
  let p: string;

  beforeAll(async () => {
    p = newId("prj");
    await app.db.insert(projects).values({ id: p, companyId: owner.companyId, name: "Cx" });
    const system = await app.inject({
      method: "POST",
      url: api(`/projects/${p}/commissioning/systems`),
      payload: { systemCode: "AHU-01", name: "Air handling unit" },
      headers: owner.headers,
    });
    systemId = system.json().id;
    const record = await app.inject({
      method: "POST",
      url: api(`/projects/${p}/commissioning/test-records`),
      payload: { systemId, testKind: "prefunctional_checklist", title: "Static checks" },
      headers: owner.headers,
    });
    recordId = record.json().id;
  });

  it("refuses a witness before the test has been performed", async () => {
    const witness = await app.inject({
      method: "POST",
      url: api(`/projects/${p}/commissioning/test-records/${recordId}/witness`),
      payload: { witnessedByName: "Cx agent" },
      headers: engineerHeaders,
    });
    expect(witness.statusCode).toBe(400);
    expect(witness.json().message).toContain("has not been performed");
  });

  it("refuses a second result rather than raising every deficiency twice", async () => {
    const first = await app.inject({
      method: "POST",
      url: api(`/projects/${p}/commissioning/test-records/${recordId}/result`),
      payload: {
        result: "pass_with_deficiencies",
        deficiencies: [{ description: "Filter gauge not fitted", raiseAs: "punch_item" }],
      },
      headers: owner.headers,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().raised.punchItems).toHaveLength(1);

    const second = await app.inject({
      method: "POST",
      url: api(`/projects/${p}/commissioning/test-records/${recordId}/result`),
      payload: {
        result: "pass_with_deficiencies",
        deficiencies: [{ description: "Filter gauge not fitted", raiseAs: "punch_item" }],
      },
      headers: owner.headers,
    });
    expect(second.statusCode).toBe(400);
    expect(second.json().message).toContain("retest");

    const record = await app.inject({
      method: "GET",
      url: api(`/projects/${p}/commissioning/test-records/${recordId}`),
      headers: owner.headers,
    });
    expect(record.json().deficiencyRecordIds).toHaveLength(1);
  });

  /*
   * The sequential guard above is a read; two submissions arriving together
   * both passed it and both ran the deficiency loop, so one defect reached the
   * field register twice. The result is claimed with a conditional UPDATE now,
   * and the loser is refused.
   */
  it("raises a deficiency once when the same result is submitted twice at once", async () => {
    const second = await app.inject({
      method: "POST",
      url: api(`/projects/${p}/commissioning/test-records`),
      payload: { systemId, testKind: "functional_performance", title: "Functional run" },
      headers: owner.headers,
    });
    const id = second.json().id as string;

    const payload = {
      result: "pass_with_deficiencies" as const,
      deficiencies: [{ description: "Damper actuator stalls", raiseAs: "punch_item" as const }],
    };
    const [a, b] = await Promise.all([
      app.inject({
        method: "POST",
        url: api(`/projects/${p}/commissioning/test-records/${id}/result`),
        payload,
        headers: owner.headers,
      }),
      app.inject({
        method: "POST",
        url: api(`/projects/${p}/commissioning/test-records/${id}/result`),
        payload,
        headers: owner.headers,
      }),
    ]);
    const codes = [a!.statusCode, b!.statusCode].sort();
    expect(codes[0]).toBe(200);
    expect(codes[1]).toBeGreaterThanOrEqual(400);

    const after = await app.inject({
      method: "GET",
      url: api(`/projects/${p}/commissioning/test-records/${id}`),
      headers: owner.headers,
    });
    expect(after.json().deficiencyRecordIds).toHaveLength(1);
  });

  it("refuses to mark a test complete or accepted by editing it", async () => {
    const created = await app.inject({
      method: "POST",
      url: api(`/projects/${p}/commissioning/test-records`),
      payload: { systemId, testKind: "pressure_test", title: "Pressure test PT-01" },
      headers: owner.headers,
    });
    const id = created.json().id as string;
    for (const status of ["complete", "accepted"]) {
      const patched = await app.inject({
        method: "PATCH",
        url: api(`/projects/${p}/commissioning/test-records/${id}`),
        payload: { status },
        headers: owner.headers,
      });
      expect(patched.statusCode).toBe(400);
      expect(patched.json().message).toContain("result");
    }
    const after = await app.inject({
      method: "GET",
      url: api(`/projects/${p}/commissioning/test-records/${id}`),
      headers: owner.headers,
    });
    expect(after.json().status).toBe("scheduled");
    expect(after.json().result).toBeNull();
  });

  it("refuses a result on a void record rather than reading against a withdrawn test", async () => {
    const created = await app.inject({
      method: "POST",
      url: api(`/projects/${p}/commissioning/test-records`),
      payload: { systemId, testKind: "loop_check", title: "Loop check LC-01" },
      headers: owner.headers,
    });
    const id = created.json().id as string;
    const voided = await app.inject({
      method: "PATCH",
      url: api(`/projects/${p}/commissioning/test-records/${id}`),
      payload: { status: "void" },
      headers: owner.headers,
    });
    expect(voided.statusCode).toBe(200);

    const result = await app.inject({
      method: "POST",
      url: api(`/projects/${p}/commissioning/test-records/${id}/result`),
      payload: { result: "pass" },
      headers: owner.headers,
    });
    expect(result.statusCode).toBe(400);
    expect(result.json().message).toContain("void");
  });
});
