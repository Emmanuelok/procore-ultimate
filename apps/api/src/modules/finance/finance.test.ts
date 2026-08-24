import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  companyMemberships,
  disbursements,
  evidence,
  obligations,
  projects,
  signals,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO, todayISO } from "../field/dates.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let approver: TestActor; // second admin in owner's company — SoD counterparty
let approverHeaders: Record<string, string>;
let projectId: string;

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  approver = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: approver.userId,
    role: "admin",
  });
  approverHeaders = {
    authorization: approver.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };
  projectId = newId("prj");
  await app.db.insert(projects).values({
    id: projectId,
    companyId: owner.companyId,
    name: "Disbursement Test Project",
  });
});

afterAll(async () => {
  await built.close();
});

async function makeProject(name: string): Promise<string> {
  const id = newId("prj");
  await app.db.insert(projects).values({ id, companyId: owner.companyId, name });
  return id;
}

async function insertEvidence(pid: string): Promise<string> {
  const id = newId("evd");
  await app.db.insert(evidence).values({
    id,
    companyId: owner.companyId,
    projectId: pid,
    kind: "document",
    source: "lender portal upload",
    contentHash: `hash-${id}`,
    submittedBy: owner.userId,
  });
  return id;
}

async function createFacility(pid: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/facilities`,
    headers: owner.headers,
    payload: {
      name: "DFI Loan A",
      lender: "Development Bank",
      instrument: "loan",
      committedAmount: 100000,
      ...payload,
    },
  });
}

async function createCondition(pid: string, facilityId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/facilities/${facilityId}/conditions`,
    headers: owner.headers,
    payload,
  });
}

async function createDisbursement(
  pid: string,
  facilityId: string,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/facilities/${facilityId}/disbursements`,
    headers: owner.headers,
    payload: { purpose: "Interim works payment", ...payload },
  });
}

async function submitDisbursement(pid: string, id: string) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/disbursements/${id}/submit`,
    headers: owner.headers,
    payload: {},
  });
}

/* ------------------------------------------------------------------ */
/* Facilities (#729, #739-741)                                         */
/* ------------------------------------------------------------------ */

describe("facilities", () => {
  it("creates a facility with server-assigned category ids and validates the limit total", async () => {
    const res = await createFacility(projectId, {
      currency: "USD",
      availabilityEndDate: addDaysISO(todayISO(), 30),
      categories: [
        { name: "Civil works", limit: 60000 },
        { name: "Equipment", limit: 30000 },
      ],
    });
    expect(res.statusCode).toBe(201);
    const fac = res.json() as {
      id: string;
      categories: { id: string; name: string; limit: number }[];
    };
    expect(fac.categories.length).toBe(2);
    for (const c of fac.categories) expect(c.id).toMatch(/^fct_/);
    expect(fac.categories[0]!.name).toBe("Civil works");
    expect(fac.categories[0]!.limit).toBe(60000);

    // Σ category limits may not exceed the committed amount (#739)
    const over = await createFacility(projectId, {
      categories: [
        { name: "A", limit: 80000 },
        { name: "B", limit: 40000 },
      ],
    });
    expect(over.statusCode).toBe(400);
    expect((over.json() as { message: string }).message).toContain("exceeding the committed");

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/facilities`,
      headers: owner.headers,
    });
    expect(list.statusCode).toBe(200);
    const item = (
      list.json() as {
        items: {
          id: string;
          disbursed: number;
          undisbursed: number;
          openConditions: number;
          daysToClosing: number | null;
        }[];
      }
    ).items.find((f) => f.id === fac.id)!;
    expect(item.disbursed).toBe(0);
    expect(item.undisbursed).toBe(100000);
    expect(item.openConditions).toBe(0);
    expect(item.daysToClosing).toBe(30);
  });

  it("PATCH refuses removing a category that disbursement requests reference", async () => {
    const pid = await makeProject("Category Guard Project");
    const fac = (
      await createFacility(pid, {
        committedAmount: 20000,
        categories: [{ name: "Works", limit: 10000 }],
      })
    ).json() as { id: string; categories: { id: string }[] };
    const catId = fac.categories[0]!.id;
    await createDisbursement(pid, fac.id, { amount: 500, categoryId: catId });

    const removal = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/facilities/${fac.id}`,
      headers: owner.headers,
      payload: { categories: [] },
    });
    expect(removal.statusCode).toBe(400);
    expect((removal.json() as { message: string }).message).toContain("Cannot remove");

    // renaming / re-limiting in place (same id) is fine
    const rename = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/facilities/${fac.id}`,
      headers: owner.headers,
      payload: { name: "DFI Loan A (amended)", categories: [{ id: catId, name: "Works pkg 1", limit: 12000 }] },
    });
    expect(rename.statusCode).toBe(200);
    const updated = rename.json() as { name: string; categories: { id: string; name: string }[] };
    expect(updated.name).toBe("DFI Loan A (amended)");
    expect(updated.categories[0]!.id).toBe(catId);
    expect(updated.categories[0]!.name).toBe("Works pkg 1");

    const unknownId = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/facilities/${fac.id}`,
      headers: owner.headers,
      payload: { categories: [{ id: "fct_doesnotexist", name: "X", limit: 1 }] },
    });
    expect(unknownId.statusCode).toBe(400);

    const overLimit = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/facilities/${fac.id}`,
      headers: owner.headers,
      payload: { categories: [{ id: catId, name: "Works", limit: 25000 }] },
    });
    expect(overLimit.statusCode).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* Conditions (#730-731)                                               */
/* ------------------------------------------------------------------ */

describe("facility conditions", () => {
  it("materializes an assurance obligation and satisfies only with in-project evidence", async () => {
    const pid = await makeProject("Conditions Project");
    const fac = (await createFacility(pid, { name: "Tranche 1 Loan" })).json() as { id: string };
    const res = await createCondition(pid, fac.id, {
      kind: "precedent",
      reference: "CP-01",
      description: "Executed direct agreement delivered to the lender",
      dueDate: addDaysISO(todayISO(), 10),
    });
    expect(res.statusCode).toBe(201);
    const cond = res.json() as { id: string; status: string; obligationId: string };
    expect(cond.status).toBe("open");
    expect(cond.obligationId).toBeTruthy();

    const [obl] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, cond.obligationId));
    expect(obl).toBeDefined();
    expect(obl!.status).toBe("open");
    expect(obl!.sourceClause).toBe("Tranche 1 Loan — condition precedent");
    expect(obl!.trigger).toContain("direct agreement");
    expect(Date.parse(obl!.deadline!)).toBe(
      Date.parse(`${addDaysISO(todayISO(), 10)}T23:59:59Z`),
    );

    // evidence is mandatory — an empty list fails validation
    const noEvidence = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/facility-conditions/${cond.id}/satisfy`,
      headers: owner.headers,
      payload: { evidenceIds: [] },
    });
    expect(noEvidence.statusCode).toBe(400);

    // evidence from another project is refused
    const foreignEvidence = await insertEvidence(projectId);
    const wrongProject = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/facility-conditions/${cond.id}/satisfy`,
      headers: owner.headers,
      payload: { evidenceIds: [foreignEvidence] },
    });
    expect(wrongProject.statusCode).toBe(400);

    const evidenceId = await insertEvidence(pid);
    const satisfied = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/facility-conditions/${cond.id}/satisfy`,
      headers: owner.headers,
      payload: { evidenceIds: [evidenceId] },
    });
    expect(satisfied.statusCode).toBe(200);
    const body = satisfied.json() as {
      status: string;
      evidenceIds: string[];
      satisfiedAt: string;
      satisfiedBy: string;
    };
    expect(body.status).toBe("satisfied");
    expect(body.evidenceIds).toEqual([evidenceId]);
    expect(body.satisfiedAt).toBeTruthy();
    expect(body.satisfiedBy).toBe(owner.userId);
    const [after] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, cond.obligationId));
    expect(after!.status).toBe("satisfied");
    expect(after!.satisfiedEvidenceId).toBe(evidenceId);

    // a satisfied condition cannot be satisfied again
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/facility-conditions/${cond.id}/satisfy`,
      headers: owner.headers,
      payload: { evidenceIds: [evidenceId] },
    });
    expect(again.statusCode).toBe(400);
  });

  it("waives a condition (admin) and the backing obligation with it", async () => {
    const pid = await makeProject("Waiver Project");
    const fac = (await createFacility(pid, {})).json() as { id: string };
    const cond = (
      await createCondition(pid, fac.id, {
        kind: "subsequent",
        description: "Post-closing insurance endorsement",
      })
    ).json() as { id: string; obligationId: string };
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/facility-conditions/${cond.id}/waive`,
      headers: approverHeaders,
      payload: { reason: "Lender confirmed the endorsement is no longer required" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe("waived");
    const [obl] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, cond.obligationId));
    expect(obl!.status).toBe("waived");
  });

  it("sweeps overdue open conditions on facility reads: breached + obligation + one high signal", async () => {
    const pid = await makeProject("Overdue Sweep Project");
    const fac = (await createFacility(pid, {})).json() as { id: string };
    const cond = (
      await createCondition(pid, fac.id, {
        kind: "precedent",
        reference: "CP-09",
        description: "Environmental permit issued",
        dueDate: addDaysISO(todayISO(), -1),
      })
    ).json() as { id: string; obligationId: string };

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/facilities/${fac.id}`,
      headers: owner.headers,
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as {
      openConditions: number;
      conditions: { id: string; status: string }[];
    };
    expect(body.conditions.find((c) => c.id === cond.id)!.status).toBe("breached");
    // breached-but-unresolved still counts as outstanding for the lender
    expect(body.openConditions).toBe(1);

    const [obl] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, cond.obligationId));
    expect(obl!.status).toBe("breached");
    const sigs = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.projectId, pid), eq(signals.detector, "facility_condition_overdue")),
      );
    expect(sigs.length).toBe(1);
    expect(sigs[0]!.severity).toBe("high");
    expect(sigs[0]!.title).toContain("CP-09");

    // idempotent: a second read raises no second signal
    await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/facilities/${fac.id}/conditions`,
      headers: owner.headers,
    });
    const sigsAfter = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.projectId, pid), eq(signals.detector, "facility_condition_overdue")),
      );
    expect(sigsAfter.length).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* Conditionality gate (#733-734) + headroom (#739-740)                */
/* ------------------------------------------------------------------ */

describe("disbursement conditionality gate", () => {
  it("blocks submission while a condition precedent is open and clears once satisfied", async () => {
    const pid = await makeProject("CP Gate Project");
    const fac = (await createFacility(pid, {})).json() as { id: string };
    const cp = (
      await createCondition(pid, fac.id, {
        kind: "precedent",
        reference: "CP-02",
        description: "Insurance policy naming the lender as co-insured",
      })
    ).json() as { id: string };
    // a condition SUBSEQUENT must not block submission
    await createCondition(pid, fac.id, {
      kind: "subsequent",
      description: "Audited accounts within 180 days of closing",
    });
    const d = (
      await createDisbursement(pid, fac.id, { amount: 10000 })
    ).json() as { id: string };

    const blocked = await submitDisbursement(pid, d.id);
    expect(blocked.statusCode).toBe(409);
    const body = blocked.json() as {
      message: string;
      openConditions: { id: string; reference: string | null; description: string }[];
    };
    expect(body.message).toContain("condition(s) precedent");
    expect(body.openConditions.length).toBe(1);
    expect(body.openConditions[0]!.id).toBe(cp.id);
    expect(body.openConditions[0]!.reference).toBe("CP-02");

    // still draft, with the failed verification snapshotted (#733)
    const [row] = await app.db.select().from(disbursements).where(eq(disbursements.id, d.id));
    expect(row!.status).toBe("draft");
    const snapshot = row!.conditionality as {
      verifiedAt: string;
      openConditions: unknown[];
    };
    expect(snapshot.verifiedAt).toBeTruthy();
    expect(snapshot.openConditions.length).toBe(1);

    const evidenceId = await insertEvidence(pid);
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/facility-conditions/${cp.id}/satisfy`,
      headers: owner.headers,
      payload: { evidenceIds: [evidenceId] },
    });
    const cleared = await submitDisbursement(pid, d.id);
    expect(cleared.statusCode).toBe(200);
    const submitted = cleared.json() as {
      status: string;
      submittedBy: string;
      conditionality: { openConditions: unknown[] };
    };
    expect(submitted.status).toBe("submitted");
    expect(submitted.submittedBy).toBe(owner.userId);
    expect(submitted.conditionality.openConditions.length).toBe(0);
  });

  it("refuses submissions over the undisbursed balance or category allocation with 409", async () => {
    const pid = await makeProject("Headroom Project");
    const fac = (
      await createFacility(pid, {
        committedAmount: 50000,
        categories: [{ name: "Plant", limit: 20000 }],
      })
    ).json() as { id: string; categories: { id: string }[] };
    const catId = fac.categories[0]!.id;

    const overBalance = (
      await createDisbursement(pid, fac.id, { amount: 60000 })
    ).json() as { id: string };
    const res1 = await submitDisbursement(pid, overBalance.id);
    expect(res1.statusCode).toBe(409);
    expect((res1.json() as { message: string }).message).toContain("undisbursed balance");

    const overCategory = (
      await createDisbursement(pid, fac.id, { amount: 25000, categoryId: catId })
    ).json() as { id: string };
    const res2 = await submitDisbursement(pid, overCategory.id);
    expect(res2.statusCode).toBe(409);
    expect((res2.json() as { message: string }).message).toContain("remaining allocation");

    const ok = (
      await createDisbursement(pid, fac.id, { amount: 15000, categoryId: catId })
    ).json() as { id: string };
    expect((await submitDisbursement(pid, ok.id)).statusCode).toBe(200);

    // the submitted pipeline consumes category headroom: 15000 + 10000 > 20000
    const overflow = (
      await createDisbursement(pid, fac.id, { amount: 10000, categoryId: catId })
    ).json() as { id: string };
    const res3 = await submitDisbursement(pid, overflow.id);
    expect(res3.statusCode).toBe(409);
    expect((res3.json() as { message: string }).message).toContain("remaining allocation");

    // an out-of-facility category is refused at creation time
    const badCat = await createDisbursement(pid, fac.id, {
      amount: 100,
      categoryId: "fct_nope",
    });
    expect(badCat.statusCode).toBe(400);
  });

  it("enforces separation of duties on approval and completes the lifecycle to disbursed", async () => {
    const pid = await makeProject("SoD Project");
    const fac = (await createFacility(pid, {})).json() as { id: string };
    const d = (
      await createDisbursement(pid, fac.id, { amount: 20000 })
    ).json() as { id: string };
    expect((await submitDisbursement(pid, d.id)).statusCode).toBe(200);

    // creator (company owner, so tool-level is not the barrier) → 403 SoD
    const self = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/disbursements/${d.id}/approve`,
      headers: owner.headers,
      payload: {},
    });
    expect(self.statusCode).toBe(403);
    expect((self.json() as { message: string }).message).toContain("Separation of duties");

    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/disbursements/${d.id}/approve`,
      headers: approverHeaders,
      payload: {},
    });
    expect(approved.statusCode).toBe(200);
    const ap = approved.json() as { status: string; approvedBy: string };
    expect(ap.status).toBe("approved");
    expect(ap.approvedBy).toBe(approver.userId);

    // disburse requires approved; a second approve is refused
    const reApprove = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/disbursements/${d.id}/approve`,
      headers: approverHeaders,
      payload: {},
    });
    expect(reApprove.statusCode).toBe(400);

    const disbursed = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/disbursements/${d.id}/disburse`,
      headers: owner.headers,
      payload: { disbursedAt: `${todayISO()}T12:00:00Z` },
    });
    expect(disbursed.statusCode).toBe(200);
    expect((disbursed.json() as { status: string }).status).toBe("disbursed");

    // reject path with reason
    const d2 = (
      await createDisbursement(pid, fac.id, { amount: 5000 })
    ).json() as { id: string };
    await submitDisbursement(pid, d2.id);
    const rejected = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/disbursements/${d2.id}/reject`,
      headers: approverHeaders,
      payload: { reason: "Insufficient expenditure evidence for eligibility review" },
    });
    expect(rejected.statusCode).toBe(200);
    const rj = rejected.json() as { status: string; rejectionReason: string };
    expect(rj.status).toBe("rejected");
    expect(rj.rejectionReason).toContain("eligibility");
  });

  it("feeds the project finance summary with lifecycle results (#739-742)", async () => {
    const pid = await makeProject("Summary Project");
    const fac = (
      await createFacility(pid, {
        committedAmount: 100000,
        categories: [
          { name: "Works", limit: 60000 },
          { name: "Supervision", limit: 40000 },
        ],
      })
    ).json() as { id: string; categories: { id: string; name: string }[] };
    const works = fac.categories[0]!.id;
    const supervision = fac.categories[1]!.id;

    const d1 = (
      await createDisbursement(pid, fac.id, { amount: 40000, categoryId: works })
    ).json() as { id: string };
    await submitDisbursement(pid, d1.id);
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/disbursements/${d1.id}/approve`,
      headers: approverHeaders,
      payload: {},
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/disbursements/${d1.id}/disburse`,
      headers: owner.headers,
      payload: {},
    });
    const d2 = (
      await createDisbursement(pid, fac.id, { amount: 15000, categoryId: supervision })
    ).json() as { id: string };
    await submitDisbursement(pid, d2.id);

    // one open condition subsequent + a compliant covenant reading
    await createCondition(pid, fac.id, {
      kind: "subsequent",
      description: "Counterpart funding confirmation",
    });
    const cov = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/facilities/${fac.id}/covenants`,
        headers: owner.headers,
        payload: { name: "DSCR", operator: "gte", threshold: 1.2, unit: "x" },
      })
    ).json() as { id: string };
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/covenants/${cov.id}/readings`,
      headers: owner.headers,
      payload: { readingDate: todayISO(), value: 1.4 },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/finance/summary`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const s = res.json() as {
      committed: number;
      disbursed: number;
      undisbursed: number;
      pendingRequests: number;
      openConditions: number;
      covenantStatus: string;
      byCategory: { name: string; limit: number; disbursed: number; remaining: number }[];
    };
    expect(s.committed).toBe(100000);
    expect(s.disbursed).toBe(40000);
    expect(s.undisbursed).toBe(60000);
    expect(s.pendingRequests).toBe(1);
    expect(s.openConditions).toBe(1);
    expect(s.covenantStatus).toBe("compliant");
    const worksCat = s.byCategory.find((c) => c.name === "Works")!;
    expect(worksCat).toMatchObject({ limit: 60000, disbursed: 40000, remaining: 20000 });
    const supCat = s.byCategory.find((c) => c.name === "Supervision")!;
    expect(supCat).toMatchObject({ limit: 40000, disbursed: 0, remaining: 40000 });

    // a breach reading flips covenantStatus to the worst case
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/covenants/${cov.id}/readings`,
      headers: owner.headers,
      payload: { readingDate: addDaysISO(todayISO(), 1), value: 1.0 },
    });
    const after = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/finance/summary`,
      headers: owner.headers,
    });
    expect((after.json() as { covenantStatus: string }).covenantStatus).toBe("breached");
  });
});

/* ------------------------------------------------------------------ */
/* Covenants (#742-743)                                                */
/* ------------------------------------------------------------------ */

describe("covenants", () => {
  it("signs headroom toward compliance for both operators and signals breaches critically", async () => {
    const pid = await makeProject("Covenant Project");
    const fac = (await createFacility(pid, {})).json() as { id: string };
    const dscr = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/facilities/${fac.id}/covenants`,
        headers: owner.headers,
        payload: { name: "DSCR", operator: "gte", threshold: 1.2, unit: "x" },
      })
    ).json() as { id: string };
    const gearing = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/facilities/${fac.id}/covenants`,
        headers: owner.headers,
        payload: { name: "Gearing", operator: "lte", threshold: 0.8 },
      })
    ).json() as { id: string };

    // gte compliant: headroom = value − threshold > 0, no signal
    const ok = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/covenants/${dscr.id}/readings`,
        headers: owner.headers,
        payload: { readingDate: todayISO(), value: 1.5 },
      })
    ).json() as { compliant: number; headroom: number };
    expect(ok.compliant).toBe(1);
    expect(ok.headroom).toBe(0.3);

    // gte breach: negative headroom + critical signal naming value/threshold
    const breach = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/covenants/${dscr.id}/readings`,
        headers: owner.headers,
        payload: { readingDate: addDaysISO(todayISO(), 1), value: 1.0 },
      })
    ).json() as { compliant: number; headroom: number };
    expect(breach.compliant).toBe(0);
    expect(breach.headroom).toBe(-0.2);

    // lte: headroom = threshold − value (positive = compliant margin)
    const lteOk = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/covenants/${gearing.id}/readings`,
        headers: owner.headers,
        payload: { readingDate: todayISO(), value: 0.7 },
      })
    ).json() as { compliant: number; headroom: number };
    expect(lteOk.compliant).toBe(1);
    expect(lteOk.headroom).toBe(0.1);
    const lteBreach = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/covenants/${gearing.id}/readings`,
        headers: owner.headers,
        payload: { readingDate: addDaysISO(todayISO(), 1), value: 0.9 },
      })
    ).json() as { compliant: number; headroom: number };
    expect(lteBreach.compliant).toBe(0);
    expect(lteBreach.headroom).toBe(-0.1);

    const sigs = await app.db
      .select()
      .from(signals)
      .where(and(eq(signals.projectId, pid), eq(signals.detector, "covenant_breach")));
    expect(sigs.length).toBe(2);
    for (const sig of sigs) expect(sig.severity).toBe("critical");
    const dscrSig = sigs.find((s) => s.title.includes("DSCR"))!;
    expect(dscrSig.title).toContain("1 ");
    expect(dscrSig.title).toContain("1.2");

    // list expands the latest reading; the series endpoint is date-ordered
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/facilities/${fac.id}/covenants`,
      headers: owner.headers,
    });
    const items = (
      list.json() as {
        items: { name: string; compliant: boolean | null; headroom: number | null }[];
      }
    ).items;
    expect(items.find((c) => c.name === "DSCR")!.compliant).toBe(false);
    expect(items.find((c) => c.name === "DSCR")!.headroom).toBe(-0.2);

    const series = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/covenants/${dscr.id}/readings`,
      headers: owner.headers,
    });
    const seriesBody = series.json() as { items: { value: number }[]; total: number };
    expect(seriesBody.total).toBe(2);
    expect(seriesBody.items.map((r) => r.value)).toEqual([1.5, 1.0]);
  });
});

/* ------------------------------------------------------------------ */
/* Statement of expenditure (#735, #769)                               */
/* ------------------------------------------------------------------ */

describe("statement of expenditure", () => {
  it("renders CSV with header, escaped rows and trailer totals; JSON statement matches", async () => {
    const pid = await makeProject("Statement Project");
    const fac = (
      await createFacility(pid, {
        committedAmount: 50000,
        categories: [{ name: "Civil works", limit: 50000 }],
      })
    ).json() as { id: string; categories: { id: string }[] };
    const catId = fac.categories[0]!.id;

    const d1 = (
      await createDisbursement(pid, fac.id, {
        amount: 20000,
        categoryId: catId,
        purpose: "Bulk earthworks, phase 1",
      })
    ).json() as { id: string };
    await submitDisbursement(pid, d1.id);
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/disbursements/${d1.id}/approve`,
      headers: approverHeaders,
      payload: {},
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/disbursements/${d1.id}/disburse`,
      headers: owner.headers,
      payload: {},
    });
    const d2 = (
      await createDisbursement(pid, fac.id, { amount: 5000, purpose: "Site supervision" })
    ).json() as { id: string };
    await submitDisbursement(pid, d2.id);

    const csv = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/facilities/${fac.id}/statement.csv`,
      headers: owner.headers,
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    const lines = csv.body.trim().split("\n");
    expect(lines[0]).toBe("number,date,amount,category,purpose,status");
    expect(lines.length).toBe(1 + 2 + 3); // header + 2 rows + 3 trailer lines
    expect(lines[1]).toContain(`1,${todayISO()},20000,Civil works,"Bulk earthworks, phase 1",disbursed`);
    expect(lines[2]).toContain(`5000,,Site supervision,submitted`);
    expect(lines[3]).toBe("TOTAL REQUESTED,,25000,,,");
    expect(lines[4]).toBe("TOTAL DISBURSED,,20000,,,");
    expect(lines[5]).toBe("UNDISBURSED,,30000,,,");

    const json = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/facilities/${fac.id}/statement`,
      headers: owner.headers,
    });
    const body = json.json() as {
      facility: { name: string };
      rows: { number: number; status: string }[];
      totals: { requested: number; disbursed: number; undisbursed: number; rows: number };
    };
    expect(body.rows.length).toBe(2);
    expect(body.totals).toEqual({
      requested: 25000,
      disbursed: 20000,
      undisbursed: 30000,
      rows: 2,
    });
  });

  it("numbers disbursements sequentially per project across facilities", async () => {
    const pid = await makeProject("Numbering Project");
    const facA = (await createFacility(pid, { name: "Facility A" })).json() as { id: string };
    const facB = (await createFacility(pid, { name: "Facility B" })).json() as { id: string };
    const d1 = (await createDisbursement(pid, facA.id, { amount: 100 })).json() as {
      number: number;
    };
    const d2 = (await createDisbursement(pid, facB.id, { amount: 200 })).json() as {
      number: number;
    };
    const d3 = (await createDisbursement(pid, facA.id, { amount: 300 })).json() as {
      number: number;
    };
    expect(d1.number).toBe(1);
    expect(d2.number).toBe(2);
    expect(d3.number).toBe(3);
  });
});

/* ------------------------------------------------------------------ */
/* Tenant isolation                                                    */
/* ------------------------------------------------------------------ */

describe("isolation", () => {
  it("denies a stranger company access to project facilities", async () => {
    const stranger = await registerActor(app);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/facilities`,
      headers: stranger.headers,
    });
    expect(res.statusCode).toBe(403);

    const write = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/facilities`,
      headers: stranger.headers,
      payload: {
        name: "Injected",
        lender: "X",
        instrument: "loan",
        committedAmount: 1,
      },
    });
    expect(write.statusCode).toBe(403);
  });
});
