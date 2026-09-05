import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  assetElementLinks,
  assets,
  changeEvents,
  companyMemberships,
  ledgerEntries,
  locations,
  materialDeliveries,
  nonConformanceReports,
  projects,
  punchItems,
  safetyCorrectiveActions,
  signals,
  vendors,
  warranties,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;

/** the contractor's QA lead: creates plans, performs checklists, submits */
let owner: TestActor;
/** the engineer / client's representative: approves, releases, verifies, accepts */
let engineer: TestActor;
/** a site inspector who fills forms in */
let inspector: TestActor;

let engineerHeaders: Record<string, string>;
let inspectorHeaders: Record<string, string>;

let projectId: string;
let vendorId: string;
/** the asset checklists and their NCRs attach to */
let assetChecklistId: string;
/** the asset the commissioning system hands over */
let assetSystemId: string;
let locationId: string;
/** the NCR raised by the failed critical measurement, shared across blocks */
let ncrUnderTest: string;
/** the commissioning deficiency that blocks turnover, shared across blocks */
let turnoverBlockingPunchNumber: number;
let turnoverSystemId: string;

const api = (path: string) => `/api/v1${path}`;

async function join(actor: TestActor): Promise<Record<string, string>> {
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: actor.userId,
    role: "admin",
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
  inspector = await registerActor(app);
  engineerHeaders = await join(engineer);
  inspectorHeaders = await join(inspector);

  projectId = newId("prj");
  await app.db
    .insert(projects)
    .values({ id: projectId, companyId: owner.companyId, name: "Quality P1" });

  vendorId = newId("ven");
  await app.db
    .insert(vendors)
    .values({ id: vendorId, companyId: owner.companyId, name: "Concrete Sub Ltd" });

  locationId = newId("loc");
  await app.db.insert(locations).values({
    id: locationId,
    companyId: owner.companyId,
    projectId,
    name: "Level 3 — East",
    path: locationId,
  });

  assetChecklistId = newId("ast");
  await app.db.insert(assets).values({
    id: assetChecklistId,
    companyId: owner.companyId,
    projectId,
    tagCode: "SLAB-L3",
    name: "Level 3 slab",
    createdBy: owner.userId,
  });

  assetSystemId = newId("ast");
  await app.db.insert(assets).values({
    id: assetSystemId,
    companyId: owner.companyId,
    projectId,
    tagCode: "AHU-01",
    name: "Air handling unit 01",
    createdBy: owner.userId,
  });
  // Booting an embedded PGlite and applying the full migration set takes well
  // over the file-level 30s default when other workers are doing the same on a
  // shared machine — the suite then fails at the FILE level with a hook
  // timeout rather than on an assertion, which reads like a broken module and
  // is not one. The sibling files in this module carry the same allowance.
}, 180_000);

afterAll(async () => {
  await built.close();
});

/* ================================================================== */
/* Inspection and test plans                                           */
/* ================================================================== */

describe("ITPs and hold points", () => {
  let itpId: string;
  let holdPointId: string;
  let witnessPointId: string;

  it("creates a plan and refuses a hold point that names nobody to release it", async () => {
    const created = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/itps`),
      payload: {
        title: "Level 3 slab — reinforcement and pour",
        discipline: "structural",
        vendorId,
        locationId,
        standardsReferences: ["BS EN 13670", "BS 8500-1"],
      },
      headers: owner.headers,
    });
    expect(created.statusCode).toBe(201);
    itpId = created.json().id;
    expect(created.json().reference).toBe("ITP-001");
    expect(created.json().status).toBe("draft");

    const nameless = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/itps/${itpId}/activities`),
      payload: { activity: "Pre-pour inspection", interventionPoint: "hold_point" },
      headers: owner.headers,
    });
    expect(nameless.statusCode).toBe(400);
    expect(nameless.json().message).toContain("must name at least one verifying party");
  });

  it("adds activities in sequence, each with its intervention point and notice period", async () => {
    const hold = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/itps/${itpId}/activities`),
      payload: {
        activity: "Pre-pour reinforcement inspection",
        activityCode: "A-020",
        interventionPoint: "hold_point",
        noticePeriodHours: 24,
        plannedDate: "2099-06-01",
        acceptanceCriteria: "Cover 40mm ±5, laps per drawing S-201",
        recordRequired: "Signed pre-pour checklist",
        verifyingParties: [{ party: "engineer", userId: engineer.userId, name: "A. Engineer" }],
      },
      headers: owner.headers,
    });
    expect(hold.statusCode).toBe(201);
    holdPointId = hold.json().id;
    expect(hold.json().mayProceed.allowed).toBe(false);

    const witness = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/itps/${itpId}/activities`),
      payload: {
        activity: "Concrete pour — witness",
        activityCode: "A-030",
        interventionPoint: "witness_point",
        noticePeriodHours: 4,
        plannedDate: "2099-06-02",
        verifyingParties: [{ party: "client", name: "Owner's Rep" }],
      },
      headers: owner.headers,
    });
    expect(witness.statusCode).toBe(201);
    witnessPointId = witness.json().id;

    const detail = await app.inject({
      method: "GET",
      url: api(`/projects/${projectId}/itps/${itpId}`),
      headers: owner.headers,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().activityCount).toBe(2);
    expect(detail.json().holdPointCount).toBe(1);
    expect(detail.json().openHoldPointCount).toBe(1);
    expect(detail.json().activities.map((a: { id: string }) => a.id)).toEqual([
      holdPointId,
      witnessPointId,
    ]);
  });

  it("refuses approval by the author and accepts it from the approval authority", async () => {
    const submitted = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/itps/${itpId}/submit`),
      headers: owner.headers,
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json().status).toBe("submitted");

    const selfApproval = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/itps/${itpId}/approve`),
      payload: { decision: "approved", approvalAuthority: "Contractor QA" },
      headers: owner.headers,
    });
    expect(selfApproval.statusCode).toBe(403);
    expect(selfApproval.json().message).toContain("someone other than");

    const approved = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/itps/${itpId}/approve`),
      payload: { decision: "approved", approvalAuthority: "Engineer of Record" },
      headers: engineerHeaders,
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe("approved");
    expect(approved.json().approvedBy).toBe(engineer.userId);

    const active = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/itps/${itpId}/activate`),
      headers: owner.headers,
    });
    expect(active.json().status).toBe("active");
  });

  it("records who was notified, when, and by what method", async () => {
    const notified = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/itps/${itpId}/activities/${holdPointId}/notify`),
      payload: { method: "email to engineer@eor.example", note: "Pour booked for 08:00" },
      headers: owner.headers,
    });
    expect(notified.statusCode).toBe(200);
    expect(notified.json().status).toBe("notified");
    expect(notified.json().notifiedBy).toBe(owner.userId);
    expect(notified.json().notificationMethod).toContain("email");
    expect(notified.json().notice.served).toBe(true);
    expect(notified.json().notice.noticeExpiresAt).toBeTruthy();
    // notice served is not permission to proceed past a HOLD point
    expect(notified.json().mayProceed.allowed).toBe(false);
  });

  it("refuses a hold-point release by anyone but the nominated verifying party", async () => {
    const wrongParty = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/itps/${itpId}/activities/${holdPointId}/release`),
      payload: { note: "looks fine to me" },
      headers: owner.headers,
    });
    expect(wrongParty.statusCode).toBe(403);
    expect(wrongParty.json().message).toContain("reserved to the nominated verifying party");
    expect(wrongParty.json().message).toContain("engineer");
  });

  it("releases a hold point for the nominated party and lets work proceed", async () => {
    const released = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/itps/${itpId}/activities/${holdPointId}/release`),
      payload: { note: "Cover and laps verified against S-201" },
      headers: engineerHeaders,
    });
    expect(released.statusCode).toBe(200);
    expect(released.json().status).toBe("released");
    expect(released.json().releasedBy).toBe(engineer.userId);
    expect(released.json().mayProceed.allowed).toBe(true);

    const again = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/itps/${itpId}/activities/${holdPointId}/release`),
      payload: {},
      headers: engineerHeaders,
    });
    expect(again.statusCode).toBe(400);
    expect(again.json().message).toContain("already released");
  });

  it("requires a written reason to waive a point", async () => {
    const noReason = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/itps/${itpId}/activities/${witnessPointId}/waive`),
      payload: { reason: "" },
      headers: engineerHeaders,
    });
    expect(noReason.statusCode).toBe(400);

    const waived = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/itps/${itpId}/activities/${witnessPointId}/waive`),
      payload: { reason: "Client confirmed by email they would not attend the pour." },
      headers: engineerHeaders,
    });
    expect(waived.statusCode).toBe(200);
    expect(waived.json().status).toBe("waived");
    expect(waived.json().waiverReason).toContain("would not attend");
  });

  it("revises the plan by superseding it rather than editing it", async () => {
    const revised = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/itps/${itpId}/revise`),
      payload: { reason: "Client added a hold point at strike of formwork" },
      headers: owner.headers,
    });
    expect(revised.statusCode).toBe(201);
    expect(revised.json().revision).toBe(1);
    expect(revised.json().supersedesId).toBe(itpId);
    expect(revised.json().activities).toHaveLength(2);

    const prior = await app.inject({
      method: "GET",
      url: api(`/projects/${projectId}/itps/${itpId}`),
      headers: owner.headers,
    });
    expect(prior.json().status).toBe("superseded");
    expect(prior.json().supersededById).toBe(revised.json().id);

    const edit = await app.inject({
      method: "PATCH",
      url: api(`/projects/${projectId}/itps/${itpId}`),
      payload: { title: "rewritten" },
      headers: owner.headers,
    });
    expect(edit.statusCode).toBe(400);
    expect(edit.json().message).toContain("issue a revision");
  });

  it("lists every intervention point on the project with its standing", async () => {
    const res = await app.inject({
      method: "GET",
      url: api(`/projects/${projectId}/hold-points`),
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBeGreaterThanOrEqual(4);
    const items = res.json().items as { mayProceed: { allowed: boolean } }[];
    expect(items.some((i) => i.mayProceed.allowed === false)).toBe(true);
  });
});

/* ================================================================== */
/* Checklist templates and execution                                   */
/* ================================================================== */

describe("checklist templates and execution", () => {
  let templateId: string;
  let checklistId: string;
  let measurementItemId: string;
  let ncrFromChecklistId: string;

  it("refuses a template item the platform could never judge", async () => {
    const res = await app.inject({
      method: "POST",
      url: api("/companies/current/checklist-templates"),
      payload: {
        reference: "BAD-01",
        name: "Unjudgeable form",
        items: [{ text: "Slump", itemType: "measurement", targetValue: 100 }],
      },
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("neither a tolerance nor a min/max");
  });

  it("creates a typed template and refuses approval by its own author", async () => {
    const created = await app.inject({
      method: "POST",
      url: api("/companies/current/checklist-templates"),
      payload: {
        reference: "QA-PREPOUR",
        name: "Pre-pour inspection",
        category: "pre_pour",
        scoringMethod: "percentage",
        passThreshold: 80,
        items: [
          {
            itemNumber: "1",
            text: "Cover to reinforcement",
            itemType: "measurement",
            unit: "mm",
            targetValue: 40,
            tolerancePlus: 5,
            toleranceMinus: 5,
            isCritical: true,
            raisesNcrOnFail: true,
            ncrSeverity: "major",
          },
          {
            itemNumber: "2",
            text: "Formwork clean and free of debris",
            itemType: "pass_fail",
          },
          {
            itemNumber: "3",
            text: "Embedded services positioned per M&E drawings",
            itemType: "pass_fail",
            isCritical: true,
          },
          { itemNumber: "4", text: "Inspector's notes", itemType: "long_text", required: false },
        ],
      },
      headers: owner.headers,
    });
    expect(created.statusCode).toBe(201);
    templateId = created.json().id;
    expect(created.json().itemCount).toBe(4);
    measurementItemId = created
      .json()
      .items.find((i: { itemNumber: string }) => i.itemNumber === "1").id;

    const selfApprove = await app.inject({
      method: "POST",
      url: api(`/companies/current/checklist-templates/${templateId}/approve`),
      headers: owner.headers,
    });
    expect(selfApprove.statusCode).toBe(403);

    const approved = await app.inject({
      method: "POST",
      url: api(`/companies/current/checklist-templates/${templateId}/approve`),
      headers: engineerHeaders,
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe("active");
  });

  it("materialises the form when a checklist is taken from the issued template", async () => {
    const created = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/checklists`),
      payload: {
        templateId,
        locationId,
        assetId: assetChecklistId,
        vendorId,
        performedByName: "S. Inspector",
      },
      headers: inspectorHeaders,
    });
    expect(created.statusCode).toBe(201);
    checklistId = created.json().id;
    expect(created.json().reference).toBe("CL-0001");
    expect(created.json().templateVersion).toBe(1);
    expect(created.json().responses).toHaveLength(4);
    expect(created.json().responses[0].questionText).toBe("Cover to reinforcement");
  });

  it("judges a measurement against its tolerance at the boundary and outside it", async () => {
    const responses = await app.inject({
      method: "GET",
      url: api(`/projects/${projectId}/checklists/${checklistId}`),
      headers: inspectorHeaders,
    });
    const responseId = responses
      .json()
      .responses.find((r: { templateItemId: string }) => r.templateItemId === measurementItemId).id;

    const onBoundary = await app.inject({
      method: "PUT",
      url: api(`/projects/${projectId}/checklists/${checklistId}/responses/${responseId}`),
      payload: { numericValue: 35, instrumentSerial: "CVR-77" },
      headers: inspectorHeaders,
    });
    expect(onBoundary.statusCode).toBe(200);
    expect(onBoundary.json().evaluation.isPass).toBe(true);

    const outside = await app.inject({
      method: "PUT",
      url: api(`/projects/${projectId}/checklists/${checklistId}/responses/${responseId}`),
      payload: { numericValue: 28, note: "Chairs displaced during service installation" },
      headers: inspectorHeaders,
    });
    expect(outside.statusCode).toBe(200);
    expect(outside.json().evaluation.isPass).toBe(false);
    expect(outside.json().evaluation.criticalFailure).toBe(true);
  });

  it("rejects an answer that does not fit the item's type", async () => {
    const detail = await app.inject({
      method: "GET",
      url: api(`/projects/${projectId}/checklists/${checklistId}`),
      headers: inspectorHeaders,
    });
    const item2 = detail
      .json()
      .responses.find((r: { itemNumber: string }) => r.itemNumber === "2").id;
    const res = await app.inject({
      method: "PUT",
      url: api(`/projects/${projectId}/checklists/${checklistId}/responses/${item2}`),
      payload: { response: "probably" },
      headers: inspectorHeaders,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("pass / fail");
  });

  it("refuses to complete while a required item is unanswered, naming it", async () => {
    const res = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/checklists/${checklistId}/complete`),
      payload: {},
      headers: inspectorHeaders,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("unanswered required item");
    expect(res.json().message).toContain("Formwork clean");
  });

  it("raises exactly one NCR for the failed critical item, a punch item for the snag, and names what it deliberately did not raise", async () => {
    const detail = await app.inject({
      method: "GET",
      url: api(`/projects/${projectId}/checklists/${checklistId}`),
      headers: inspectorHeaders,
    });
    const byNumber = (n: string) =>
      detail.json().responses.find((r: { itemNumber: string }) => r.itemNumber === n).id;

    const bulk = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/checklists/${checklistId}/responses`),
      payload: {
        answers: [
          { responseId: byNumber("2"), response: "fail", note: "Sawdust in the base of the pour" },
          { responseId: byNumber("3"), response: "fail", note: "Conduit 60mm out of position" },
        ],
      },
      headers: inspectorHeaders,
    });
    expect(bulk.statusCode).toBe(200);
    expect(bulk.json().scoring.criticalFailureCount).toBe(2);

    const completed = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/checklists/${checklistId}/complete`),
      payload: { ncrResponseDueDate: "2099-01-01" },
      headers: inspectorHeaders,
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().status).toBe("failed");
    expect(completed.json().result).toBe("fail");
    // item 1 is critical AND declares raisesNcrOnFail → exactly one NCR
    expect(completed.json().raised.ncrs).toHaveLength(1);
    // item 2 is a non-critical failure the template did not mark → punch item
    expect(completed.json().raised.punchItems).toHaveLength(1);
    // item 3 is critical but the template declares no NCR → reported, not invented
    expect(completed.json().raised.unraised).toHaveLength(1);
    expect(completed.json().raised.unraised[0].reason).toContain("does not declare raisesNcrOnFail");
    ncrFromChecklistId = completed.json().raised.ncrs[0].ncrId;
    ncrUnderTest = ncrFromChecklistId;

    const persisted = await app.db
      .select()
      .from(nonConformanceReports)
      .where(eq(nonConformanceReports.checklistId, checklistId));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.severity).toBe("major");
    expect(persisted[0]!.sourceType).toBe("checklist");
    expect(persisted[0]!.assetId).toBe(assetChecklistId);
    expect(persisted[0]!.raisedAgainstVendorId).toBe(vendorId);
  });

  it("refuses a second completion, so a failure cannot raise a second NCR", async () => {
    const again = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/checklists/${checklistId}/complete`),
      payload: {},
      headers: inspectorHeaders,
    });
    expect(again.statusCode).toBe(400);
    expect(again.json().message).toContain("would raise a second NCR");

    const persisted = await app.db
      .select()
      .from(nonConformanceReports)
      .where(eq(nonConformanceReports.checklistId, checklistId));
    expect(persisted).toHaveLength(1);
  });

  it("refuses a witness signature from the person who performed the inspection", async () => {
    const self = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/checklists/${checklistId}/witness`),
      payload: { name: "S. Inspector" },
      headers: inspectorHeaders,
    });
    expect(self.statusCode).toBe(403);

    const witnessed = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/checklists/${checklistId}/witness`),
      payload: { name: "A. Engineer" },
      headers: engineerHeaders,
    });
    expect(witnessed.statusCode).toBe(200);
    expect(witnessed.json().witnessedBy).toBe(engineer.userId);
  });

  it("refuses to record work against a template that has not been issued", async () => {
    const draft = await app.inject({
      method: "POST",
      url: api("/companies/current/checklist-templates"),
      payload: {
        reference: "QA-DRAFT",
        name: "Draft form",
        items: [{ text: "Anything", itemType: "pass_fail" }],
      },
      headers: owner.headers,
    });
    const res = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/checklists`),
      payload: { templateId: draft.json().id },
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("approve the template first");
  });
});

/* ================================================================== */
/* Non-conformance reports                                             */
/* ================================================================== */

describe("non-conformance reports", () => {
  let concessionNcrId: string;
  let actionId: string;

  it("raises an NCR from a delivery with its provenance resolved", async () => {
    const deliveryId = newId("mdl");
    await app.db.insert(materialDeliveries).values({
      id: deliveryId,
      companyId: owner.companyId,
      projectId,
      number: 1,
      reference: "DEL-001",
      createdBy: owner.userId,
    });
    const bogus = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/ncrs`),
      payload: {
        title: "Wrong grade delivered",
        description: "C30 delivered against a C40 order.",
        deliveryId: "not-a-delivery",
      },
      headers: owner.headers,
    });
    expect(bogus.statusCode).toBe(400);

    const created = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/ncrs`),
      payload: {
        title: "Wrong grade delivered",
        description: "C30 delivered against a C40 order; 6m3 placed before it was noticed.",
        category: "material",
        severity: "major",
        deliveryId,
        raisedAgainstVendorId: vendorId,
        quantityAffected: 6,
        unit: "m3",
      },
      headers: owner.headers,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().sourceType).toBe("delivery");
    expect(created.json().sourceId).toBe(deliveryId);
    concessionNcrId = created.json().id;
  });

  it("refuses a use-as-is disposition approved by the person who proposed it", async () => {
    const proposed = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/ncrs/${concessionNcrId}/disposition/propose`),
      payload: {
        disposition: "use_as_is",
        justification:
          "Structural check shows C30 is adequate for this pour; removal would damage adjacent work.",
        costImpact: 4200,
      },
      headers: owner.headers,
    });
    expect(proposed.statusCode).toBe(200);
    expect(proposed.json().status).toBe("disposition_proposed");
    expect(proposed.json().dispositionProposedBy).toBe(owner.userId);

    const selfApproved = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/ncrs/${concessionNcrId}/disposition/approve`),
      payload: { decision: "approve", concessionReference: "CON-001" },
      headers: owner.headers,
    });
    expect(selfApproved.statusCode).toBe(403);
    expect(selfApproved.json().message).toContain("proposed");
  });

  it("requires a designer's concession before a use-as-is is approved", async () => {
    const noConcession = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/ncrs/${concessionNcrId}/disposition/approve`),
      payload: { decision: "approve" },
      headers: engineerHeaders,
    });
    expect(noConcession.statusCode).toBe(400);
    expect(noConcession.json().message).toContain("concession");

    const approved = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/ncrs/${concessionNcrId}/disposition/approve`),
      payload: { decision: "approve", concessionReference: "CON-001", comments: "Accepted." },
      headers: engineerHeaders,
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe("disposition_approved");
    expect(approved.json().dispositionApprovedBy).toBe(engineer.userId);
    expect(approved.json().concessionReference).toBe("CON-001");
  });

  it("puts corrective actions in the shared safety register, not a second one", async () => {
    const proposed = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/ncrs/${ncrUnderTest}/disposition/propose`),
      payload: {
        disposition: "rework",
        justification: "Break out and recast the affected bay to restore cover.",
        costImpact: 11_500,
        scheduleImpactDays: 3,
      },
      headers: inspectorHeaders,
    });
    expect(proposed.statusCode).toBe(200);

    const approved = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/ncrs/${ncrUnderTest}/disposition/approve`),
      payload: { decision: "approve" },
      headers: engineerHeaders,
    });
    expect(approved.statusCode).toBe(200);

    const action = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/ncrs/${ncrUnderTest}/actions`),
      payload: {
        title: "Brief steelfixers on chair spacing before every pour",
        actionKind: "preventive",
        hierarchyOfControl: "administrative",
        ownerId: inspector.userId,
        dueDate: "2099-02-01",
      },
      headers: owner.headers,
    });
    expect(action.statusCode).toBe(201);
    actionId = action.json().id;

    const rows = await app.db
      .select()
      .from(safetyCorrectiveActions)
      .where(
        and(
          eq(safetyCorrectiveActions.sourceType, "ncr"),
          eq(safetyCorrectiveActions.sourceId, ncrUnderTest),
        ),
      );
    expect(rows).toHaveLength(1);
    // The shared register's format, allocated from the shared counter — see
    // the regression test in qualityRegressions.test.ts for why that matters.
    expect(rows[0]!.reference).toMatch(/^CA-\d{4}$/);
  });

  it("refuses closeout while a corrective action is still open, naming it", async () => {
    const res = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/ncrs/${ncrUnderTest}/close`),
      payload: { closeoutEvidenceDescription: "Bay recast." },
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("Brief steelfixers");
  });

  it("refuses verification by the person who submitted the closeout", async () => {
    await app.db
      .update(safetyCorrectiveActions)
      .set({ status: "closed" })
      .where(eq(safetyCorrectiveActions.id, actionId));

    const closed = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/ncrs/${ncrUnderTest}/close`),
      payload: {
        closeoutEvidenceDescription: "Affected bay broken out and recast; cover re-surveyed.",
        closeoutEvidenceFileIds: ["file-survey-1"],
      },
      headers: owner.headers,
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().status).toBe("verification_pending");
    expect(closed.json().closedBy).toBe(owner.userId);

    const selfVerify = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/ncrs/${ncrUnderTest}/verify`),
      payload: { verificationMethod: "Re-survey" },
      headers: owner.headers,
    });
    expect(selfVerify.statusCode).toBe(403);

    const verified = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/ncrs/${ncrUnderTest}/verify`),
      payload: { verificationMethod: "Independent cover meter survey of the recast bay" },
      headers: engineerHeaders,
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().status).toBe("closed");
    expect(verified.json().verifiedBy).toBe(engineer.userId);
  });

  it("refuses closeout of an NCR whose disposition nobody has approved", async () => {
    const fresh = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/ncrs`),
      payload: { title: "Undecided", description: "Nothing decided yet." },
      headers: owner.headers,
    });
    const res = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/ncrs/${fresh.json().id}/close`),
      payload: { closeoutEvidenceDescription: "Sorted it." },
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("disposition");
  });

  it("backcharges the responsible subcontractor through a change event", async () => {
    const res = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/ncrs/${ncrUnderTest}/backcharge`),
      payload: { amount: 11_500, backchargeReference: "BC-001" },
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isBackcharged).toBe(1);
    expect(res.json().changeEvent.eventType).toBe("backcharge");
    expect(res.json().changeEvent.originId).toBe(ncrUnderTest);
    expect(res.json().changeEvent.roughOrderOfMagnitude).toBe(11_500);

    const events = await app.db
      .select()
      .from(changeEvents)
      .where(eq(changeEvents.originId, ncrUnderTest));
    expect(events).toHaveLength(1);
  });

  it("refuses a backcharge when no responsible vendor is recorded", async () => {
    const orphan = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/ncrs`),
      payload: { title: "Nobody's fault", description: "Cause unknown." },
      headers: owner.headers,
    });
    const res = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/ncrs/${orphan.json().id}/backcharge`),
      payload: { amount: 100 },
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("nobody to backcharge");
  });

  it("appends every consequential mutation to the ledger", async () => {
    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectId, ncrUnderTest),
        ),
      );
    const actions = entries.map((e) => `${e.action}`);
    expect(entries.length).toBeGreaterThanOrEqual(5); // create, propose, approve, close, verify, backcharge
    expect(actions.filter((a) => a === "state_change").length).toBeGreaterThanOrEqual(4);
  });
});

/* ================================================================== */
/* Commissioning                                                       */
/* ================================================================== */

describe("commissioning", () => {
  let parentSystemId: string;
  let systemId: string;
  let prefunctionalId: string;
  let functionalId: string;
  let deficiencyPunchNumber: number;

  it("builds a system hierarchy with a materialised path", async () => {
    const parent = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/commissioning/systems`),
      payload: { systemCode: "HVAC", name: "HVAC", discipline: "mechanical", level: "system" },
      headers: owner.headers,
    });
    expect(parent.statusCode).toBe(201);
    parentSystemId = parent.json().id;
    expect(parent.json().path).toBe(parentSystemId);

    const child = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/commissioning/systems`),
      payload: {
        systemCode: "HVAC-L3-AHU01",
        name: "AHU-01, Level 3",
        parentId: parentSystemId,
        level: "equipment",
        assetId: assetSystemId,
        ifcGlobalIds: ["1AHU000000000000000001"],
        cxAgentId: owner.userId,
        vendorId,
        plannedCompletionDate: "2099-09-01",
      },
      headers: owner.headers,
    });
    expect(child.statusCode).toBe(201);
    systemId = child.json().id;
    turnoverSystemId = systemId;
    expect(child.json().path).toBe(`${parentSystemId}/${systemId}`);
    expect(child.json().level).toBe("equipment");

    const dupe = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/commissioning/systems`),
      payload: { systemCode: "HVAC-L3-AHU01", name: "Duplicate" },
      headers: owner.headers,
    });
    expect(dupe.statusCode).toBe(409);
  });

  it("refuses a functional test before the pre-functional checks exist, and says why", async () => {
    const res = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/commissioning/test-records`),
      payload: {
        systemId,
        testKind: "functional_performance",
        title: "AHU-01 functional performance test",
      },
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("No pre-functional test record exists");

    const readiness = await app.inject({
      method: "GET",
      url: api(`/projects/${projectId}/commissioning/systems/${systemId}/readiness`),
      headers: owner.headers,
    });
    expect(readiness.json().functionalTestingAllowed).toBe(false);
    expect(readiness.json().blockers.length).toBeGreaterThan(0);
  });

  it("refuses a pass recorded on an out-of-calibration instrument", async () => {
    const created = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/commissioning/test-records`),
      payload: {
        systemId,
        testKind: "prefunctional_checklist",
        title: "AHU-01 static completion checks",
        instruments: [
          { name: "Anemometer", serial: "AN-01", calibrationDueDate: "2020-01-01" },
        ],
      },
      headers: owner.headers,
    });
    expect(created.statusCode).toBe(201);
    prefunctionalId = created.json().id;
    expect(created.json().phase).toBe("prefunctional");

    const stale = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/commissioning/test-records/${prefunctionalId}/result`),
      payload: { result: "pass", performedAt: "2026-05-01T10:00:00.000Z" },
      headers: owner.headers,
    });
    expect(stale.statusCode).toBe(400);
    expect(stale.json().message).toContain("out-of-calibration");
    expect(stale.json().message).toContain("AN-01");

    const passed = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/commissioning/test-records/${prefunctionalId}/result`),
      payload: {
        result: "pass",
        performedAt: "2026-05-01T10:00:00.000Z",
        instruments: [
          { name: "Anemometer", serial: "AN-02", calibrationDueDate: "2099-01-01" },
        ],
      },
      headers: owner.headers,
    });
    expect(passed.statusCode).toBe(200);
    expect(passed.json().status).toBe("complete");
  });

  it("judges readings against their tolerance and raises deficiencies as punch items", async () => {
    const created = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/commissioning/test-records`),
      payload: {
        systemId,
        testKind: "functional_performance",
        title: "AHU-01 functional performance test",
      },
      headers: owner.headers,
    });
    expect(created.statusCode).toBe(201);
    functionalId = created.json().id;

    const impossiblePass = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/commissioning/test-records/${functionalId}/result`),
      payload: {
        result: "pass",
        readings: [{ point: "Supply air flow", expected: 2000, tolerance: 100, measured: 1750, unit: "l/s" }],
      },
      headers: owner.headers,
    });
    expect(impossiblePass.statusCode).toBe(400);
    expect(impossiblePass.json().message).toContain("outside their acceptance window");

    const recorded = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/commissioning/test-records/${functionalId}/result`),
      payload: {
        result: "pass_with_deficiencies",
        readings: [
          { point: "Supply air flow", expected: 2000, tolerance: 100, measured: 1950, unit: "l/s" },
          { point: "Return air flow", expected: 1800, tolerance: 100, measured: 1650, unit: "l/s" },
        ],
        instruments: [{ name: "Anemometer", serial: "AN-02", calibrationDueDate: "2099-01-01" }],
        deficiencies: [
          {
            description: "Return air damper linkage binding at 60% open",
            raiseAs: "punch_item",
            ownerVendorId: vendorId,
          },
        ],
      },
      headers: owner.headers,
    });
    expect(recorded.statusCode).toBe(200);
    expect(recorded.json().judgedReadings[0].pass).toBe(true);
    expect(recorded.json().judgedReadings[1].pass).toBe(false);
    expect(recorded.json().raised.punchItems).toHaveLength(1);
    deficiencyPunchNumber = recorded.json().raised.punchItems[0].number;
    turnoverBlockingPunchNumber = deficiencyPunchNumber;

    const system = await app.inject({
      method: "GET",
      url: api(`/projects/${projectId}/commissioning/systems/${systemId}`),
      headers: owner.headers,
    });
    expect(system.json().openDeficiencies.count).toBe(1);
    expect(system.json().prefunctionalTestCount).toBe(1);
    expect(system.json().functionalTestCount).toBe(1);
  });

  it("records a witness, including a third party with no platform account", async () => {
    const self = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/commissioning/test-records/${functionalId}/witness`),
      payload: { witnessedByName: "Me" },
      headers: owner.headers,
    });
    expect(self.statusCode).toBe(403);

    const thirdParty = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/commissioning/test-records/${functionalId}/witness`),
      payload: {
        thirdPartyWitness: "BSRIA — J. Fielding",
        witnessedByOrganisation: "BSRIA",
      },
      headers: owner.headers,
    });
    expect(thirdParty.statusCode).toBe(200);
    expect(thirdParty.json().thirdPartyWitness).toContain("BSRIA");
    expect(thirdParty.json().witnessedAt).toBeTruthy();
  });

  it("links a retest to the record it retests", async () => {
    const retest = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/commissioning/test-records/${functionalId}/retest`),
      payload: { reason: "Damper linkage adjusted; re-measure return air flow." },
      headers: owner.headers,
    });
    expect(retest.statusCode).toBe(201);
    expect(retest.json().retestOfId).toBe(functionalId);
    expect(retest.json().phase).toBe("functional");

    const original = await app.inject({
      method: "GET",
      url: api(`/projects/${projectId}/commissioning/test-records/${functionalId}`),
      headers: owner.headers,
    });
    expect(original.json().retestCount).toBe(1);
    expect(original.json().retests).toHaveLength(1);
  });

  it("refuses acceptance of a system by the commissioning agent who tested it", async () => {
    const advanced = await app.inject({
      method: "PATCH",
      url: api(`/projects/${projectId}/commissioning/systems/${systemId}`),
      payload: { status: "functional_complete" },
      headers: owner.headers,
    });
    expect(advanced.statusCode).toBe(200);

    const backwards = await app.inject({
      method: "PATCH",
      url: api(`/projects/${projectId}/commissioning/systems/${systemId}`),
      payload: { status: "not_started" },
      headers: owner.headers,
    });
    expect(backwards.statusCode).toBe(400);
    expect(backwards.json().message).toContain("forward-only");

    const selfAccept = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/commissioning/systems/${systemId}/accept`),
      payload: {},
      headers: owner.headers,
    });
    expect(selfAccept.statusCode).toBe(403);

    const accepted = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/commissioning/systems/${systemId}/accept`),
      payload: { beneficialUseDate: "2026-06-01", warrantyStartDate: "2026-06-01" },
      headers: engineerHeaders,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().status).toBe("accepted");
    expect(accepted.json().acceptedBy).toBe(engineer.userId);
  });
});

/* ================================================================== */
/* Turnover and the hand-over into the twin                            */
/* ================================================================== */

describe("turnover packages", () => {
  let packageId: string;

  it("surfaces the artefact gap by name", async () => {
    const created = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/turnover-packages`),
      payload: {
        name: "AHU-01 turnover",
        packageType: "system",
        systemId: turnoverSystemId,
        vendorId,
        contents: [
          { kind: "as_built_drawings", required: true },
          { kind: "o_and_m_manual", required: true },
          { kind: "test_records", required: true, present: true, fileId: "file-tests" },
          { kind: "software_licences", required: false },
        ],
      },
      headers: owner.headers,
    });
    expect(created.statusCode).toBe(201);
    packageId = created.json().id;
    expect(created.json().requiredArtefactCount).toBe(3);
    expect(created.json().presentArtefactCount).toBe(1);

    const readiness = await app.inject({
      method: "GET",
      url: api(`/projects/${projectId}/turnover-packages/${packageId}/readiness`),
      headers: owner.headers,
    });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json().artefacts.gap).toBe(2);
    expect(readiness.json().artefacts.missingKinds).toEqual([
      "as_built_drawings",
      "o_and_m_manual",
    ]);
    expect(readiness.json().strictness).toBe("block");
    expect(readiness.json().canSubmit).toBe(false);
  });

  it("blocks submission on an open punch item and names it", async () => {
    for (const kind of ["as_built_drawings", "o_and_m_manual"]) {
      const marked = await app.inject({
        method: "POST",
        url: api(`/projects/${projectId}/turnover-packages/${packageId}/contents/${kind}`),
        payload: { present: true, fileId: `file-${kind}` },
        headers: owner.headers,
      });
      expect(marked.statusCode).toBe(200);
    }

    const blocked = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/turnover-packages/${packageId}/submit`),
      payload: {},
      headers: owner.headers,
    });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().message).toContain(`Punch item #${turnoverBlockingPunchNumber}`);
    expect(blocked.json().message).toContain("Return air damper linkage");
  });

  it("rejects an unknown artefact kind rather than storing it", async () => {
    const res = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/turnover-packages/${packageId}/contents/free_beer`),
      payload: { present: true },
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("not a turnover artefact kind");
  });

  it("submits once the blocking records are closed, and refuses acceptance by the submitter", async () => {
    await app.db
      .update(punchItems)
      .set({ status: "closed" })
      .where(
        and(eq(punchItems.projectId, projectId), eq(punchItems.number, turnoverBlockingPunchNumber)),
      );

    const submitted = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/turnover-packages/${packageId}/submit`),
      payload: { note: "All artefacts assembled." },
      headers: owner.headers,
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json().status).toBe("submitted");
    expect(submitted.json().warnings).toEqual([]);

    const selfAccept = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/turnover-packages/${packageId}/accept`),
      payload: {},
      headers: owner.headers,
    });
    expect(selfAccept.statusCode).toBe(403);
    expect(selfAccept.json().message).toContain("someone other than");
  });

  it("hands over into the twin on acceptance: assets, IFC bindings, warranty and timestamps", async () => {
    const accepted = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/turnover-packages/${packageId}/accept`),
      payload: {
        cobieFileId: "file-cobie-001",
        warrantyStartDate: "2026-06-01",
        warrantyEndDate: "2028-06-01",
        warrantyProvider: "Concrete Sub Ltd",
        note: "Owner accepts AHU-01.",
      },
      headers: engineerHeaders,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().status).toBe("handed_over");
    expect(accepted.json().acceptedBy).toBe(engineer.userId);
    expect(accepted.json().handedOverAt).toBeTruthy();
    expect(accepted.json().assetHandoverCompletedAt).toBeTruthy();
    expect(accepted.json().cobieFileId).toBe("file-cobie-001");
    expect(accepted.json().handover.assetIds).toContain(assetSystemId);
    expect(accepted.json().handover.assetCount).toBe(1);
    expect(accepted.json().handover.elementLinksCreated).toEqual([
      { assetId: assetSystemId, globalId: "1AHU000000000000000001" },
    ]);
    expect(accepted.json().handover.warrantyIds).toHaveLength(1);
    expect(accepted.json().handover.systemsTurnedOver).toEqual(["HVAC-L3-AHU01"]);

    // the twin itself, not a copy of it
    const [asset] = await app.db.select().from(assets).where(eq(assets.id, assetSystemId));
    expect(asset!.status).toBe("operational");
    expect(asset!.warrantyStart).toBe("2026-06-01");

    const links = await app.db
      .select()
      .from(assetElementLinks)
      .where(eq(assetElementLinks.assetId, assetSystemId));
    expect(links).toHaveLength(1);
    expect(links[0]!.globalId).toBe("1AHU000000000000000001");

    const warrantyRows = await app.db
      .select()
      .from(warranties)
      .where(eq(warranties.assetId, assetSystemId));
    expect(warrantyRows).toHaveLength(1);
    expect(warrantyRows[0]!.endDate).toBe("2028-06-01");
  });

  it("reports a missing COBie file rather than pretending one was handed over", async () => {
    const system = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/commissioning/systems`),
      payload: { systemCode: "ELEC-L1", name: "Level 1 distribution" },
      headers: owner.headers,
    });
    const pkg = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/turnover-packages`),
      payload: {
        name: "Level 1 distribution turnover",
        systemId: system.json().id,
        contents: [{ kind: "as_built_drawings", required: true, present: true, fileId: "f1" }],
        blockingStrictness: "warn",
      },
      headers: owner.headers,
    });
    await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/turnover-packages/${pkg.json().id}/submit`),
      payload: {},
      headers: owner.headers,
    });
    const accepted = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/turnover-packages/${pkg.json().id}/accept`),
      payload: {},
      headers: engineerHeaders,
    });
    expect(accepted.statusCode).toBe(200);
    const reasons = (accepted.json().handover.reasons as string[]).join(" ");
    expect(reasons).toContain("No COBie export file");
    expect(reasons).toContain("carry no twin asset");
    expect(accepted.json().handover.assetIds).toEqual([]);
  });

  it("summarises the artefact gap across every package, with a null completeness where there is no denominator", async () => {
    const res = await app.inject({
      method: "GET",
      url: api(`/projects/${projectId}/turnover-packages-summary`),
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totals.packages).toBeGreaterThanOrEqual(2);
    expect(res.json().totals.completeness.value).toBeGreaterThan(0);

    const emptyProject = newId("prj");
    await app.db
      .insert(projects)
      .values({ id: emptyProject, companyId: owner.companyId, name: "Nothing yet" });
    const empty = await app.inject({
      method: "GET",
      url: api(`/projects/${emptyProject}/turnover-packages-summary`),
      headers: owner.headers,
    });
    expect(empty.json().totals.completeness.value).toBeNull();
    expect(empty.json().totals.completeness.reasons[0]).toContain("no denominator");
  });
});

/* ================================================================== */
/* Sweeps and the summary                                              */
/* ================================================================== */

describe("sweeps and signals", () => {
  it("raises a signal for an unreleased hold point past its date and an overdue NCR, exactly once", async () => {
    const itp = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/itps`),
      payload: { title: "Facade — sealant works" },
      headers: owner.headers,
    });
    await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/itps/${itp.json().id}/activities`),
      payload: {
        activity: "Adhesion test witness",
        interventionPoint: "hold_point",
        plannedDate: "2020-01-01",
        noticePeriodHours: 48,
        verifyingParties: [{ party: "engineer", userId: engineer.userId }],
      },
      headers: owner.headers,
    });
    await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/ncrs`),
      payload: {
        title: "Sealant adhesion failure",
        description: "Peel test failed on 3 of 10 samples.",
        responseDueDate: "2020-02-01",
        severity: "critical",
      },
      headers: owner.headers,
    });

    const first = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/quality/sweep`),
      payload: {},
      headers: owner.headers,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().byDetector["quality_hold_point_unreleased"]).toBeGreaterThanOrEqual(1);
    expect(first.json().byDetector["quality_ncr_response_overdue"]).toBeGreaterThanOrEqual(1);

    const before = await app.db
      .select()
      .from(signals)
      .where(eq(signals.companyId, owner.companyId));

    const second = await app.inject({
      method: "POST",
      url: api(`/projects/${projectId}/quality/sweep`),
      payload: {},
      headers: owner.headers,
    });
    expect(second.json().raised).toBe(0);

    const after = await app.db
      .select()
      .from(signals)
      .where(eq(signals.companyId, owner.companyId));
    expect(after.length).toBe(before.length);

    const holdSignal = after.find((s) => s.detector === "quality_hold_point_unreleased");
    expect(holdSignal).toBeTruthy();
    expect(holdSignal!.explanation).toContain("Adhesion test witness");
    expect(holdSignal!.explanation).toContain("2020-01-01");
  });

  /*
   * The read-path sweep keeps an open page honest; the scheduler job is what
   * makes a hold point nobody looks at still get raised. They share one
   * implementation so they cannot drift, and the job must therefore add
   * nothing on top of what the manual sweep already raised.
   */
  it("runs the same detectors on the platform scheduler without double-raising", async () => {
    const before = await app.db
      .select()
      .from(signals)
      .where(eq(signals.companyId, owner.companyId));

    const status = await app.scheduler.runNow("quality.sweeps");
    expect(status.lastError).toBeNull();
    await app.scheduler.runNow("quality.sweeps");

    const after = await app.db
      .select()
      .from(signals)
      .where(eq(signals.companyId, owner.companyId));
    expect(after.length).toBe(before.length);
  });

  it("does not re-raise on the lazy sweep that runs on a list read", async () => {
    const before = await app.db
      .select()
      .from(signals)
      .where(eq(signals.companyId, owner.companyId));
    await app.inject({
      method: "GET",
      url: api(`/projects/${projectId}/ncrs`),
      headers: owner.headers,
    });
    await app.inject({
      method: "GET",
      url: api(`/projects/${projectId}/itps`),
      headers: owner.headers,
    });
    const after = await app.db
      .select()
      .from(signals)
      .where(eq(signals.companyId, owner.companyId));
    expect(after.length).toBe(before.length);
  });

  it("reports figures it can compute and nulls with reasons for the ones it cannot", async () => {
    const res = await app.inject({
      method: "GET",
      url: api(`/projects/${projectId}/quality/summary`),
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.checklists.firstTimePassRate.value).toBe(0); // one checklist, and it failed
    expect(body.checklists.firstTimePassRate.inputs.judgedChecklists).toBe(1);
    expect(body.ncrs.medianClosureDays.value).not.toBeNull();
    expect(body.holdPoints.overdue).toBeGreaterThanOrEqual(1);
    expect(body.turnover.assetsHandedOver).toBeGreaterThanOrEqual(1);
    expect(body.commissioning.systemsWithoutTwinAsset).toContain("HVAC");

    const emptyProject = newId("prj");
    await app.db
      .insert(projects)
      .values({ id: emptyProject, companyId: owner.companyId, name: "Empty" });
    const empty = await app.inject({
      method: "GET",
      url: api(`/projects/${emptyProject}/quality/summary`),
      headers: owner.headers,
    });
    expect(empty.json().checklists.firstTimePassRate.value).toBeNull();
    expect(empty.json().checklists.firstTimePassRate.reasons[0]).toContain(
      "no first-time-pass rate",
    );
    expect(empty.json().ncrs.totalCostImpact.value).toBeNull();
    expect(empty.json().ncrs.totalCostImpact.reasons[0]).toContain("It is not zero");
  });
});
