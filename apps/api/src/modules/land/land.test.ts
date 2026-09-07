import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  affectedPersons,
  companyMemberships,
  evidence,
  grievances,
  landParcels,
  ledgerEntries,
  obligations,
  projects,
  scheduleTasks,
  signals,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO, todayISO } from "../field/dates.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let stranger: TestActor; // separate tenant — isolation counterparty
/**
 * A SECOND officer inside the owner's company. Closure verification is
 * segregated from resolution — the officer who wrote a resolution cannot also
 * certify that the complainant accepted it (#573) — so the tests need someone
 * else to close a grievance the owner resolved.
 */
let verifier: TestActor;

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  stranger = await registerActor(app);
  const second = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cmb"),
    companyId: owner.companyId,
    userId: second.userId,
    role: "admin",
  });
  verifier = {
    ...second,
    companyId: owner.companyId,
    headers: {
      authorization: second.headers["authorization"]!,
      "x-company-id": owner.companyId,
    },
  };
});

afterAll(async () => {
  await built.close();
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

async function makeProject(name: string, actor: TestActor = owner): Promise<string> {
  const id = newId("prj");
  await app.db.insert(projects).values({ id, companyId: actor.companyId, name });
  return id;
}

async function insertEvidence(pid: string, actor: TestActor = owner): Promise<string> {
  const id = newId("evd");
  await app.db.insert(evidence).values({
    id,
    companyId: actor.companyId,
    projectId: pid,
    kind: "bank_transaction",
    source: "compensation disbursement account",
    contentHash: `hash-${id}`,
    submittedBy: actor.userId,
  });
  return id;
}

/**
 * Findings are raised by the scheduled detector now, not as a side effect of
 * a read. Tests that assert on a finding trigger a cycle explicitly, which is
 * exactly what the scheduler does on its interval.
 */
async function runDetectors(pid: string): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/land/detectors/run`,
    headers: owner.headers,
  });
  if (res.statusCode !== 200) {
    throw new Error(`detector run failed: ${res.statusCode} ${res.body}`);
  }
}

/** Title passes through the evidenced acquisition route, naming the basis. */
async function acquire(
  pid: string,
  parcelId: string,
  acquisitionBasis = "state_allocation",
): Promise<number> {
  const evidenceId = await insertEvidence(pid);
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/parcels/${parcelId}/acquire`,
    headers: owner.headers,
    payload: { acquisitionBasis, evidenceIds: [evidenceId] },
  });
  return res.statusCode;
}

async function insertTask(pid: string, name: string, startDate: string): Promise<string> {
  const id = newId("tsk");
  await app.db.insert(scheduleTasks).values({
    id,
    scheduleId: newId("sch"),
    projectId: pid,
    name,
    durationDays: 10,
    startDate,
  });
  return id;
}

const createParcel = (pid: string, payload: Record<string, unknown>, actor: TestActor = owner) =>
  app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/parcels`,
    headers: actor.headers,
    payload: { reference: "PLOT-001", tenureType: "freehold", ...payload },
  });

const createPap = (pid: string, payload: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/affected-persons`,
    headers: owner.headers,
    payload: {
      reference: "PAP-001",
      householdHead: "A. Household",
      displacementType: "physical",
      ...payload,
    },
  });

const createGrievance = (pid: string, payload: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/grievances`,
    headers: owner.headers,
    payload: {
      channel: "in_person",
      category: "dust",
      severity: "medium",
      description: "Dust from haul road entering the compound",
      receivedAt: todayISO(),
      ...payload,
    },
  });

const setStatus = (pid: string, parcelId: string, status: string) =>
  app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/parcels/${parcelId}/status`,
    headers: owner.headers,
    payload: { status },
  });

/* ------------------------------------------------------------------ */
/* Parcels (#547-554)                                                  */
/* ------------------------------------------------------------------ */

describe("land parcel register", () => {
  it("registers a parcel and rejects a duplicate cadastral reference with 409", async () => {
    const pid = await makeProject("Parcel register");
    const res = await createParcel(pid, {
      reference: "CAD/12/447",
      tenureType: "customary",
      description: "Grazing land held under customary tenure",
      areaSqm: 4200,
      ownerName: "Elders of Kibaale",
      valuationAmount: 18000,
    });
    expect(res.statusCode).toBe(201);
    const parcel = res.json();
    expect(parcel.status).toBe("identified");
    expect(parcel.tenureType).toBe("customary");
    expect(parcel.currency).toBe("USD");

    const dup = await createParcel(pid, { reference: "CAD/12/447", tenureType: "freehold" });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().message).toContain("CAD/12/447");

    // the same reference on a different project is perfectly legitimate
    const other = await makeProject("Second scheme");
    const ok = await createParcel(other, { reference: "CAD/12/447", tenureType: "freehold" });
    expect(ok.statusCode).toBe(201);
  });

  it("walks the acquisition flow and refuses illegal jumps", async () => {
    const pid = await makeProject("Acquisition flow");
    const parcel = (await createParcel(pid, { reference: "P-FLOW" })).json();

    // identified -> agreed is not a transition anyone gets to make
    const jump = await setStatus(pid, parcel.id, "agreed");
    expect(jump.statusCode).toBe(400);
    expect(jump.json().message).toContain("cannot move to agreed");

    expect((await setStatus(pid, parcel.id, "surveyed")).statusCode).toBe(200);
    expect((await setStatus(pid, parcel.id, "under_negotiation")).statusCode).toBe(200);
    const agreed = await setStatus(pid, parcel.id, "agreed");
    expect(agreed.statusCode).toBe(200);
    expect(agreed.json().status).toBe("agreed");

    // `compensated` is reachable only through the evidenced route
    const sneak = await setStatus(pid, parcel.id, "compensated");
    expect(sneak.statusCode).toBe(400);
    expect(sneak.json().message).toContain("evidenced compensation route");

    // no-op transitions are rejected rather than silently ledgered
    expect((await setStatus(pid, parcel.id, "agreed")).statusCode).toBe(400);

    // a title challenge can land on a parcel at any stage
    const disputed = await setStatus(pid, parcel.id, "disputed");
    expect(disputed.statusCode).toBe(200);
    expect(disputed.json().status).toBe("disputed");
    // `acquired` is likewise reachable only through the evidenced route, which
    // records the BASIS on which title passed — before it existed, a state or
    // donated parcel could only reach `acquired` by first being marked
    // `disputed`, manufacturing a dispute for every parcel on a road scheme
    const bySneak = await setStatus(pid, parcel.id, "acquired");
    expect(bySneak.statusCode).toBe(400);
    expect(bySneak.json().message).toContain("/acquire");

    /*
     * The register has to TELL the workspace that the evidenced route is
     * open. `acquired` is absent from allowedTransitions by design, so
     * without this flag the product would offer no way at all to mark land
     * acquired — which is how a state-owned parcel ends up routed through a
     * fictitious dispute.
     */
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/parcels/${parcel.id}`,
      headers: owner.headers,
    });
    const view = detail.json() as {
      acquirable: boolean;
      allowedTransitions: string[];
      acquisitionBases: string[];
      cashAcquisitionBases: string[];
    };
    expect(view.acquirable).toBe(true);
    expect(view.allowedTransitions).not.toContain("acquired");
    expect(view.acquisitionBases).toContain("state_allocation");
    expect(view.cashAcquisitionBases).toContain("purchase");

    // a compulsory-purchase determination settles the dispute into acquisition
    expect(await acquire(pid, parcel.id, "court_order")).toBe(200);

    const after = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/parcels/${parcel.id}`,
      headers: owner.headers,
    });
    // an acquired parcel is not acquirable again
    expect((after.json() as { acquirable: boolean }).acquirable).toBe(false);
  });

  it("will not record compensation without payment evidence", async () => {
    const pid = await makeProject("Evidenced compensation");
    const parcel = (await createParcel(pid, { reference: "P-COMP" })).json();
    await setStatus(pid, parcel.id, "surveyed");
    await setStatus(pid, parcel.id, "under_negotiation");
    await setStatus(pid, parcel.id, "agreed");

    const url = `/api/v1/projects/${pid}/parcels/${parcel.id}/compensate`;
    const noEvidence = await app.inject({
      method: "POST",
      url,
      headers: owner.headers,
      payload: { amount: 18000, paidAt: todayISO(), evidenceIds: [] },
    });
    expect(noEvidence.statusCode).toBe(400);

    const foreign = await app.inject({
      method: "POST",
      url,
      headers: owner.headers,
      payload: { amount: 18000, paidAt: todayISO(), evidenceIds: [newId("evd")] },
    });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().message).toContain("evidenceIds");

    const evidenceId = await insertEvidence(pid);
    const ok = await app.inject({
      method: "POST",
      url,
      headers: owner.headers,
      payload: { amount: 18000.005, paidAt: "2026-03-01", evidenceIds: [evidenceId] },
    });
    expect(ok.statusCode).toBe(200);
    const paid = ok.json();
    expect(paid.status).toBe("compensated");
    expect(paid.compensationAmount).toBe(18000.01);
    expect(paid.compensationPaidAt).toBe("2026-03-01");
    expect(paid.evidenceIds).toEqual([evidenceId]);

    // and only then can title pass — on a stated basis, with its own evidence
    expect(await acquire(pid, parcel.id, "purchase")).toBe(200);
  });

  /**
   * Supplementary and corrected payments are ordinary RAP practice — a
   * valuation revised on appeal, a crop missed at the survey, a court-awarded
   * top-up. Before this, /compensate refused an already-compensated parcel
   * and PATCH refused the edit, so the register was frozen on the first
   * figure and rap-progress understated what the programme had paid; the only
   * reachable path was compensated → disputed → under_negotiation, three
   * fabricated state changes including a fictitious dispute.
   */
  it("accumulates supplementary payments and restates a corrected figure", async () => {
    const pid = await makeProject("Supplementary compensation");
    const parcel = (await createParcel(pid, { reference: "P-SUPP" })).json();
    await setStatus(pid, parcel.id, "surveyed");
    await setStatus(pid, parcel.id, "under_negotiation");
    await setStatus(pid, parcel.id, "agreed");
    const url = `/api/v1/projects/${pid}/parcels/${parcel.id}/compensate`;

    const first = await app.inject({
      method: "POST",
      url,
      headers: owner.headers,
      payload: {
        amount: 10000,
        paidAt: "2026-03-01",
        evidenceIds: [await insertEvidence(pid)],
      },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().compensationAmount).toBe(10000);
    expect(first.json().compensationPayments).toHaveLength(1);
    expect(first.json().compensationPayments[0].kind).toBe("initial");

    // the frozen-after-payment PATCH names a route that actually accepts it
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/parcels/${parcel.id}`,
      headers: owner.headers,
      payload: { compensationAmount: 14000 },
    });
    expect(patched.statusCode).toBe(409);
    expect(patched.json().message).toContain("compensation-correction");

    // a supplement ADDS; it does not restate, and it does not need a
    // fictitious dispute to be recorded
    const supplement = await app.inject({
      method: "POST",
      url,
      headers: owner.headers,
      payload: {
        amount: 2500.004,
        paidAt: "2026-06-15",
        evidenceIds: [await insertEvidence(pid)],
        note: "Mango trees missed at the asset survey",
      },
    });
    expect(supplement.statusCode).toBe(200);
    const topped = supplement.json();
    expect(topped.status).toBe("compensated");
    expect(topped.compensationAmount).toBe(12500);
    // the FIRST payment date is what the possession rule reads
    expect(topped.compensationPaidAt).toBe("2026-03-01");
    expect(topped.compensationLastPaidAt).toBe("2026-06-15");
    expect(topped.compensationPayments).toHaveLength(2);
    expect(topped.compensationPayments[1].kind).toBe("supplementary");
    expect(topped.compensationPayments[1].delta).toBe(2500);
    expect(topped.evidenceIds).toHaveLength(2);
    expect(topped.compensable).toBe(true);
    expect(topped.correctable).toBe(true);

    // title passes, and a further payment afterwards does not undo it
    expect(await acquire(pid, parcel.id, "purchase")).toBe(200);
    const afterTitle = await app.inject({
      method: "POST",
      url,
      headers: owner.headers,
      payload: {
        amount: 500,
        paidAt: "2026-08-01",
        evidenceIds: [await insertEvidence(pid)],
      },
    });
    expect(afterTitle.statusCode).toBe(200);
    expect(afterTitle.json().status).toBe("acquired");
    expect(afterTitle.json().compensationAmount).toBe(13000);

    // a correction RESTATES the total, with a reason and its own evidence
    const correctionUrl = `/api/v1/projects/${pid}/parcels/${parcel.id}/compensation-correction`;
    const noReason = await app.inject({
      method: "POST",
      url: correctionUrl,
      headers: owner.headers,
      payload: { correctedAmount: 12800, reason: "typo", evidenceIds: [] },
    });
    expect(noReason.statusCode).toBe(400);

    const corrected = await app.inject({
      method: "POST",
      url: correctionUrl,
      headers: owner.headers,
      payload: {
        correctedAmount: 12800,
        reason: "Second instalment keyed twice; bank statement shows one transfer of 200 less",
        evidenceIds: [await insertEvidence(pid)],
      },
    });
    expect(corrected.statusCode).toBe(200);
    expect(corrected.json().compensationAmount).toBe(12800);
    const entries = corrected.json().compensationPayments;
    expect(entries).toHaveLength(4);
    expect(entries[3].kind).toBe("correction");
    expect(entries[3].delta).toBe(-200);

    // a no-op correction is refused rather than ledgered as a change
    const noop = await app.inject({
      method: "POST",
      url: correctionUrl,
      headers: owner.headers,
      payload: {
        correctedAmount: 12800,
        reason: "Re-keying the same figure to see what happens",
        evidenceIds: [await insertEvidence(pid)],
      },
    });
    expect(noop.statusCode).toBe(400);

    // the movement is readable from the ledger without the record beside it
    const ledger = await app.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.companyId, owner.companyId), eq(ledgerEntries.objectId, parcel.id)))
      .orderBy(ledgerEntries.seq);
    const correction = ledger.find(
      (e) => (e.payload as { event?: string } | null)?.event === "compensation_corrected",
    );
    expect(correction).toBeTruthy();
    expect(correction!.payload).toMatchObject({
      before: { compensationAmount: 13000 },
      after: { compensationAmount: 12800 },
      delta: -200,
    });
    const supplementEntry = ledger.find(
      (e) => (e.payload as { paymentKind?: string } | null)?.paymentKind === "supplementary",
    );
    expect(supplementEntry!.payload).toMatchObject({ previousTotal: 10000, totalPaid: 12500 });

    // and the RAP dashboard reports the combined figure, not the first one
    const rap = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/land/rap-progress`,
      headers: owner.headers,
    });
    expect(rap.json().compensation.parcels.paid).toBe(12800);
  });

  it("refuses a correction on a parcel that has never been paid", async () => {
    const pid = await makeProject("Correction without payment");
    const parcel = (await createParcel(pid, { reference: "P-NOPAY" })).json();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/parcels/${parcel.id}/compensation-correction`,
      headers: owner.headers,
      payload: {
        correctedAmount: 100,
        reason: "There is nothing on the register to correct",
        evidenceIds: [await insertEvidence(pid)],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("nothing to correct");
  });

  it("lists parcels with linked PAP counts and filters", async () => {
    const pid = await makeProject("Parcel listing");
    const a = (await createParcel(pid, { reference: "L-1", tenureType: "communal" })).json();
    await createParcel(pid, { reference: "L-2", tenureType: "freehold" });
    await createPap(pid, { reference: "PAP-L1", parcelId: a.id });
    await createPap(pid, { reference: "PAP-L2", parcelId: a.id });

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/parcels`,
      headers: owner.headers,
    });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.total).toBe(2);
    expect(body.items.find((p: { reference: string }) => p.reference === "L-1").papCount).toBe(2);
    expect(body.items.find((p: { reference: string }) => p.reference === "L-2").papCount).toBe(0);

    const filtered = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/parcels?tenureType=communal`,
      headers: owner.headers,
    });
    expect(filtered.json().total).toBe(1);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/parcels/${a.id}`,
      headers: owner.headers,
    });
    expect(detail.json().affectedPersons).toHaveLength(2);
    expect(detail.json().allowedTransitions).toContain("surveyed");
  });
});

/* ------------------------------------------------------------------ */
/* Consent-to-programme dependency mapping (#591)                      */
/* ------------------------------------------------------------------ */

describe("land / schedule risk", () => {
  it("reports blocked works and raises the signal exactly once per parcel+task", async () => {
    const pid = await makeProject("Schedule risk");
    const imminent = await insertTask(pid, "Earthworks — Ch 4+200", addDaysISO(todayISO(), 12));
    const distant = await insertTask(pid, "Bridge deck", addDaysISO(todayISO(), 200));
    const soonish = await insertTask(pid, "Site clearance", addDaysISO(todayISO(), 60));

    const blocking = (
      await createParcel(pid, {
        reference: "RISK-1",
        tenureType: "customary",
        ownerName: "Kibaale Trust",
        blockingTaskIds: [imminent, distant],
      })
    ).json();
    const alsoBlocking = (
      await createParcel(pid, { reference: "RISK-2", blockingTaskIds: [soonish] })
    ).json();
    // an acquired parcel blocks nothing, even though it names a task
    const acquired = (
      await createParcel(pid, { reference: "RISK-3", blockingTaskIds: [imminent] })
    ).json();
    for (const s of ["surveyed", "under_negotiation", "agreed"]) {
      await setStatus(pid, acquired.id, s);
    }
    expect(await acquire(pid, acquired.id)).toBe(200);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/land/schedule-risk`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const risk = res.json();
    // the 200-day task is outside the 90-day default horizon
    expect(risk.blockedTasks).toBe(2);
    expect(risk.blockedParcels).toBeGreaterThanOrEqual(2);
    expect(risk.imminent).toBe(1);
    expect(risk.items[0].parcelId).toBe(blocking.id);
    expect(risk.items[0].taskName).toBe("Earthworks — Ch 4+200");
    expect(risk.items[0].daysUntilStart).toBe(12);
    expect(risk.items[1].parcelId).toBe(alsoBlocking.id);
    // the view now quantifies the exposure rather than merely listing it
    expect(risk.items[0].daysAtRisk).toBeGreaterThanOrEqual(0);
    expect(risk.items[0].expectedResolutionDate).toBeTruthy();

    // TRIGGER CONTRACT: the read ran the same consent sweep the scheduled job
    // runs, scoped to this project, so the imminent finding is already on the
    // register — exactly once. The scheduler is disabled under NODE_ENV=test,
    // so nothing else could have raised it.
    const fromRead = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.projectId, pid), eq(signals.detector, "land_blocks_programme")),
      );
    expect(fromRead).toHaveLength(1);
    expect(fromRead[0]!.severity).toBe("high");
    expect(fromRead[0]!.title).toContain("RISK-1");
    // the SYSTEM raised it, not whoever opened the page
    expect(fromRead[0]!.disposition).toBe("new");
    const [ledgered] = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(eq(ledgerEntries.objectType, "signal"), eq(ledgerEntries.objectId, fromRead[0]!.id)),
      );
    expect(ledgered!.actorId).toBeNull();

    // the scheduled detector cycle afterwards claims nothing new
    await runDetectors(pid);
    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.projectId, pid), eq(signals.detector, "land_blocks_programme")),
      );
    expect(raised).toHaveLength(1);
    expect(raised[0]!.id).toBe(fromRead[0]!.id);

    // repeated reads AND repeated detector cycles must not duplicate it
    await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/land/schedule-risk`,
      headers: owner.headers,
    });
    await runDetectors(pid);
    const again = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.projectId, pid), eq(signals.detector, "land_blocks_programme")),
      );
    expect(again).toHaveLength(1);

    // widening the horizon surfaces the distant task without a new signal
    const wide = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/land/schedule-risk?days=365`,
      headers: owner.headers,
    });
    expect(wide.json().blockedTasks).toBe(3);
  });

  it("rejects blocking task ids from another project", async () => {
    const pid = await makeProject("Task scoping A");
    const other = await makeProject("Task scoping B");
    const foreignTask = await insertTask(other, "Foreign task", todayISO());
    const res = await createParcel(pid, {
      reference: "SCOPE-1",
      blockingTaskIds: [foreignTask],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("blockingTaskIds");
  });
});

/* ------------------------------------------------------------------ */
/* PAPs, entitlements, cut-off (#555-568)                              */
/* ------------------------------------------------------------------ */

describe("project affected persons", () => {
  it("recomputes the compensation total from the entitlement matrix", async () => {
    const pid = await makeProject("Entitlements");
    const pap = (await createPap(pid, { reference: "PAP-E1", displacementType: "both" })).json();
    expect(pap.compensationTotal).toBeNull();

    const put = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${pid}/affected-persons/${pap.id}/entitlements`,
      headers: owner.headers,
      payload: {
        entitlements: [
          { item: "Replacement dwelling", basis: "Full replacement cost", amount: 12500.5 },
          { item: "Transitional allowance", basis: "3 months x local wage", amount: 900.25 },
          { item: "Crop compensation", basis: "Two seasons of maize", amount: 340 },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().compensationTotal).toBe(13740.75);
    // a censused household with a determined entitlement has moved on
    expect(put.json().status).toBe("entitlement_agreed");

    // revising the matrix recomputes rather than accumulates
    const revised = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${pid}/affected-persons/${pap.id}/entitlements`,
      headers: owner.headers,
      payload: {
        entitlements: [{ item: "Replacement dwelling", basis: "Revised valuation", amount: 15000 }],
      },
    });
    expect(revised.json().compensationTotal).toBe(15000);
    expect(revised.json().entitlements).toHaveLength(1);
  });

  it("enforces the declared cut-off date on census entries", async () => {
    const pid = await makeProject("Cut-off");
    // before declaration anything goes
    const early = await createPap(pid, { reference: "PAP-C0", censusDate: "2026-01-15" });
    expect(early.statusCode).toBe(201);

    const declare = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/land/cut-off`,
      headers: owner.headers,
      payload: { date: "2026-02-01", note: "Declared at the public disclosure meeting" },
    });
    expect(declare.statusCode).toBe(200);
    expect(declare.json().cutOffDate).toBe("2026-02-01");

    const onDate = await createPap(pid, { reference: "PAP-C1", censusDate: "2026-02-01" });
    expect(onDate.statusCode).toBe(201);

    const late = await createPap(pid, { reference: "PAP-C2", censusDate: "2026-02-02" });
    expect(late.statusCode).toBe(400);
    expect(late.json().message).toContain("encroachment");

    // a census date is optional; the rule only bites when one is given
    expect((await createPap(pid, { reference: "PAP-C3" })).statusCode).toBe(201);

    const read = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/land/cut-off`,
      headers: owner.headers,
    });
    expect(read.json().cutOffDate).toBe("2026-02-01");
    expect(read.json().declaredBy).toBe(owner.userId);
    // the household censused before declaration is now visibly out of scope
    expect(read.json().papsAfterCutOff).toBe(0);

    // patching a census date past the cut-off is refused too
    const c3 = (
      await app.inject({
        method: "GET",
        url: `/api/v1/projects/${pid}/affected-persons?status=registered`,
        headers: owner.headers,
      })
    ).json();
    const target = c3.items.find((p: { reference: string }) => p.reference === "PAP-C3");
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/affected-persons/${target.id}`,
      headers: owner.headers,
      payload: { censusDate: "2026-06-01" },
    });
    expect(patch.statusCode).toBe(400);
  });

  it("compensates a household only against determined entitlements and evidence", async () => {
    const pid = await makeProject("PAP compensation");
    const pap = (await createPap(pid, { reference: "PAP-P1" })).json();
    const evidenceId = await insertEvidence(pid);
    const url = `/api/v1/projects/${pid}/affected-persons/${pap.id}/compensate`;

    const premature = await app.inject({
      method: "POST",
      url,
      headers: owner.headers,
      payload: { paidAt: todayISO(), evidenceIds: [evidenceId] },
    });
    expect(premature.statusCode).toBe(400);
    expect(premature.json().message).toContain("Entitlements must be determined");

    await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${pid}/affected-persons/${pap.id}/entitlements`,
      headers: owner.headers,
      payload: { entitlements: [{ item: "Land-for-land", basis: "Replacement cost", amount: 5000 }] },
    });

    const unevidenced = await app.inject({
      method: "POST",
      url,
      headers: owner.headers,
      payload: { paidAt: todayISO(), evidenceIds: [] },
    });
    expect(unevidenced.statusCode).toBe(400);

    const ok = await app.inject({
      method: "POST",
      url,
      headers: owner.headers,
      payload: { paidAt: "2026-04-04", evidenceIds: [evidenceId] },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe("compensated");
    expect(ok.json().compensationPaidAt).toBe("2026-04-04");

    // paying twice, or revising the matrix afterwards, is refused
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: owner.headers,
          payload: { paidAt: "2026-04-05", evidenceIds: [evidenceId] },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/v1/projects/${pid}/affected-persons/${pap.id}/entitlements`,
          headers: owner.headers,
          payload: { entitlements: [] },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("filters the register by vulnerability and displacement type", async () => {
    const pid = await makeProject("PAP filters");
    await createPap(pid, {
      reference: "V-1",
      displacementType: "economic",
      vulnerabilities: ["female_headed", "below_poverty_line"],
    });
    await createPap(pid, { reference: "V-2", displacementType: "physical" });
    const bad = await createPap(pid, { reference: "V-3", vulnerabilities: ["wealthy"] });
    expect(bad.statusCode).toBe(400); // vulnerability flags are a closed set

    const vulnerable = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/affected-persons?vulnerable=true`,
      headers: owner.headers,
    });
    expect(vulnerable.json().total).toBe(1);
    expect(vulnerable.json().items[0].reference).toBe("V-1");
    expect(vulnerable.json().items[0].livelihoodRequired).toBe(true);

    const physical = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/affected-persons?displacementType=physical`,
      headers: owner.headers,
    });
    expect(physical.json().total).toBe(1);
    expect(physical.json().items[0].reference).toBe("V-2");
  });

  it("computes RAP progress across both registers", async () => {
    const pid = await makeProject("RAP progress");
    // 4 parcels: 2 acquired, 1 compensated, 1 identified
    const refs = ["R-1", "R-2", "R-3", "R-4"];
    const parcelIds: string[] = [];
    for (const reference of refs) {
      const p = (
        await createParcel(pid, { reference, areaSqm: 1000, valuationAmount: 1000 })
      ).json();
      parcelIds.push(p.id);
    }
    const evidenceId = await insertEvidence(pid);
    for (const parcelId of parcelIds.slice(0, 3)) {
      await setStatus(pid, parcelId, "surveyed");
      await setStatus(pid, parcelId, "under_negotiation");
      await setStatus(pid, parcelId, "agreed");
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/parcels/${parcelId}/compensate`,
        headers: owner.headers,
        payload: { amount: 1200, paidAt: "2026-05-01", evidenceIds: [evidenceId] },
      });
    }
    expect(await acquire(pid, parcelIds[0]!, "purchase")).toBe(200);
    expect(await acquire(pid, parcelIds[1]!, "purchase")).toBe(200);
    const rapAcquired = 2;

    // 4 households: 2 physical, 1 economic, 1 both; 2 vulnerable
    await createPap(pid, { reference: "RP-1", displacementType: "physical", householdSize: 5 });
    await createPap(pid, {
      reference: "RP-2",
      displacementType: "physical",
      householdSize: 3,
      vulnerabilities: ["elderly"],
    });
    const eco = (
      await createPap(pid, {
        reference: "RP-3",
        displacementType: "economic",
        householdSize: 4,
        vulnerabilities: ["landless", "elderly"],
      })
    ).json();
    const both = (
      await createPap(pid, { reference: "RP-4", displacementType: "both", householdSize: 2 })
    ).json();
    await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${pid}/affected-persons/${eco.id}/entitlements`,
      headers: owner.headers,
      payload: { entitlements: [{ item: "Livelihood grant", basis: "12 months", amount: 2000 }] },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/affected-persons/${eco.id}/compensate`,
      headers: owner.headers,
      payload: { paidAt: "2026-05-10", evidenceIds: [evidenceId] },
    });
    // one of the two livelihood-restoration households is restored. It has to
    // be compensated first: restoration is measured FROM the displacement
    // date, and PS5 para 20 puts payment before displacement.
    await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${pid}/affected-persons/${both.id}/entitlements`,
      headers: owner.headers,
      payload: {
        entitlements: [{ item: "Replacement dwelling", basis: "matrix", amount: 5000 }],
      },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/affected-persons/${both.id}/compensate`,
      headers: owner.headers,
      payload: { paidAt: "2026-05-10", evidenceIds: [evidenceId] },
    });
    const restored = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/affected-persons/${both.id}/status`,
      headers: owner.headers,
      payload: { status: "livelihood_restored" },
    });
    expect(restored.statusCode).toBe(200);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/land/rap-progress`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const rap = res.json();
    expect(rap.parcels.total).toBe(4);
    expect(rap.parcels.byStatus.acquired).toBe(rapAcquired);
    expect(rap.parcels.byStatus.compensated).toBe(1);
    expect(rap.parcels.byStatus.identified).toBe(1);
    expect(rap.parcels.byStatus.disputed).toBe(0); // zero-filled, not missing
    expect(rap.paps.total).toBe(4);
    expect(rap.paps.households).toBe(14);
    expect(rap.physicallyDisplaced).toBe(3); // physical + physical + both
    expect(rap.economicallyDisplaced).toBe(2); // economic + both
    expect(rap.vulnerableHouseholds).toBe(2);
    expect(rap.byVulnerability.elderly).toBe(2);
    expect(rap.byVulnerability.landless).toBe(1);
    // 3 parcels compensated at 1200 + 1 valued at 1000; two households
    // determined and paid — 2,000 (economic) and 5,000 (physical + economic)
    expect(rap.compensation.parcels.committed).toBe(4600);
    expect(rap.compensation.parcels.paid).toBe(3600);
    expect(rap.compensation.paps.committed).toBe(7000);
    expect(rap.compensation.paps.paid).toBe(7000);
    expect(rap.compensationCommitted).toBe(11600);
    expect(rap.compensationPaid).toBe(10600);
    expect(rap.compensationOutstanding).toBe(1000);
    // one currency in play, so the flat totals mean something and say which
    expect(rap.compensationMixedCurrency).toBe(false);
    expect(rap.compensationCurrency).toBe("USD");
    expect(rap.compensationCurrencies).toEqual(["USD"]);
    expect(rap.compensationByCurrency.USD.committed).toBe(11600);
    expect(rap.livelihoodRequired).toBe(2);
    expect(rap.livelihoodRestored).toBe(1);
    expect(rap.livelihoodRestoredPercent).toBe(50);
    expect(rap.readyForConstructionPercent).toBe(50);
  });

  /*
   * A corridor scheme crossing a border compensates in two currencies. Adding
   * them produces a figure that is not money, so the flat totals go null with
   * the reason and the per-currency breakdown carries the answer.
   */
  it("never sums compensation across currencies", async () => {
    const pid = await makeProject("Cross-border RAP");
    const usd = (
      await createParcel(pid, {
        reference: "X-USD",
        compensationAmount: 1000,
        currency: "USD",
      })
    ).json();
    const ugx = (
      await createParcel(pid, {
        reference: "X-UGX",
        compensationAmount: 4_000_000,
        currency: "UGX",
      })
    ).json();
    expect(usd.currency).toBe("USD");
    expect(ugx.currency).toBe("UGX");

    // and a household priced in the local currency
    const pap = await createPap(pid, {
      reference: "PAP-UGX",
      displacementType: "economic",
      currency: "ugx",
    });
    expect(pap.statusCode).toBe(201);
    expect(pap.json().currency).toBe("UGX");
    await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${pid}/affected-persons/${pap.json().id}/entitlements`,
      headers: owner.headers,
      payload: {
        entitlements: [
          { item: "Crop compensation", basis: "District rate schedule", amount: 500_000 },
        ],
      },
    });

    const rap = (
      await app.inject({
        method: "GET",
        url: `/api/v1/projects/${pid}/land/rap-progress`,
        headers: owner.headers,
      })
    ).json();
    expect(rap.compensationMixedCurrency).toBe(true);
    expect(rap.compensationCurrency).toBeNull();
    expect(rap.compensationCommitted).toBeNull();
    expect(rap.compensationPaid).toBeNull();
    expect(rap.compensationOutstanding).toBeNull();
    expect(rap.compensation.parcels.committed).toBeNull();
    expect(rap.compensationCurrencies).toEqual(["UGX", "USD"]);
    expect(rap.compensationByCurrency.USD.committed).toBe(1000);
    expect(rap.compensationByCurrency.UGX.committed).toBe(4_500_000);
    expect(rap.compensationByCurrency.UGX.parcels.committed).toBe(4_000_000);
    expect(rap.compensationByCurrency.UGX.paps.committed).toBe(500_000);
    expect(rap.compensationReasons[0]).toContain("UGX");
  });

  it("returns null percentages rather than a false 100% on an empty programme", async () => {
    const pid = await makeProject("Empty RAP");
    const rap = (
      await app.inject({
        method: "GET",
        url: `/api/v1/projects/${pid}/land/rap-progress`,
        headers: owner.headers,
      })
    ).json();
    expect(rap.readyForConstructionPercent).toBeNull();
    expect(rap.livelihoodRestoredPercent).toBeNull();
    expect(rap.cutOffDate).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Grievance redress (#569-574)                                        */
/* ------------------------------------------------------------------ */

describe("grievance redress mechanism", () => {
  it("computes the SLA from severity and materializes the resolve deadline as an obligation", async () => {
    const pid = await makeProject("Grievance SLA");
    const received = todayISO();
    const expected = [
      { severity: "critical", ack: 1, resolve: 7 },
      { severity: "high", ack: 2, resolve: 14 },
      { severity: "medium", ack: 3, resolve: 30 },
      { severity: "low", ack: 5, resolve: 45 },
    ];
    for (const row of expected) {
      const res = await createGrievance(pid, { severity: row.severity, receivedAt: received });
      expect(res.statusCode).toBe(201);
      const g = res.json();
      expect(g.acknowledgeDueAt).toBe(addDaysISO(received, row.ack));
      expect(g.resolveDueAt).toBe(addDaysISO(received, row.resolve));
      expect(g.status).toBe("received");
      expect(g.obligationId).toBeTruthy();
      expect(g.sla.resolveDays).toBe(row.resolve);

      const [obligation] = await app.db
        .select()
        .from(obligations)
        .where(eq(obligations.id, g.obligationId));
      expect(obligation).toBeTruthy();
      expect(obligation!.sourceClause).toBe(`Grievance redress mechanism — GRV-${g.number}`);
      expect(obligation!.deadline!.slice(0, 10)).toBe(addDaysISO(received, row.resolve));
      expect(obligation!.warnDaysBefore).toBe(2);
      expect(obligation!.status).toBe("open");
    }
    // numbering is per project and sequential
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/grievances`,
      headers: owner.headers,
    });
    expect(list.json().items.map((g: { number: number }) => g.number)).toEqual([4, 3, 2, 1]);
  });

  it("strips identifying data from an anonymous grievance", async () => {
    const pid = await makeProject("Anonymous intake");
    const flagged = (
      await createGrievance(pid, {
        isAnonymous: true,
        complainantName: "Jane Okoro",
        complainantContact: "+234 800 000 0000",
      })
    ).json();
    expect(flagged.isAnonymous).toBe(true);
    expect(flagged.complainantName).toBeNull();
    expect(flagged.complainantContact).toBeNull();

    // the anonymous CHANNEL is anonymous whatever the caller ticked
    const viaChannel = (
      await createGrievance(pid, {
        channel: "anonymous",
        complainantName: "Jane Okoro",
        complainantContact: "jane@example.test",
      })
    ).json();
    expect(viaChannel.isAnonymous).toBe(true);
    expect(viaChannel.complainantName).toBeNull();

    // a named grievance still keeps its contact details
    const named = (
      await createGrievance(pid, {
        complainantName: "Jane Okoro",
        complainantContact: "+234 800 000 0000",
      })
    ).json();
    expect(named.isAnonymous).toBe(false);
    expect(named.complainantName).toBe("Jane Okoro");

    const stored = await app.db.select().from(obligations).where(eq(obligations.projectId, pid));
    expect(stored.every((o) => !o.trigger.includes("Jane Okoro"))).toBe(true);
  });

  /**
   * A household id is identifying data on a scheme with one household per
   * parcel: the census row, the PAP drawer, the RAP indicator
   * `householdsUnderOpenGrievance` and the land health metric all name the
   * household a live complaint is about. The web form clears the field, but
   * the API is what machine tokens and MCP callers use, so the refusal has to
   * live on the server.
   */
  it("refuses to attach a household to an anonymous grievance", async () => {
    const pid = await makeProject("Anonymous household link");
    const pap = (await createPap(pid, { reference: "PAP-ANON" })).json();

    for (const payload of [
      { isAnonymous: true, papId: pap.id },
      { channel: "anonymous", papId: pap.id },
    ]) {
      const res = await createGrievance(pid, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("anonymous");
    }

    // nothing was written: no grievance, and the household is untouched
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/grievances`,
      headers: owner.headers,
    });
    expect(list.json().total).toBe(0);
    const [household] = await app.db
      .select()
      .from(affectedPersons)
      .where(eq(affectedPersons.id, pap.id));
    expect(household!.status).toBe("registered");
    expect(household!.statusBeforeGrievance).toBeNull();

    // the same grievance, named, DOES flag the household
    const named = await createGrievance(pid, { papId: pap.id });
    expect(named.statusCode).toBe(201);
    expect(named.json().papId).toBe(pap.id);
    const [flaggedHousehold] = await app.db
      .select()
      .from(affectedPersons)
      .where(eq(affectedPersons.id, pap.id));
    expect(flaggedHousehold!.status).toBe("grievance_open");
  });

  it("closes a grievance only when the complainant says it worked", async () => {
    const pid = await makeProject("Closure verification");
    const g = (await createGrievance(pid, { severity: "high" })).json();

    // closure cannot be verified before there is a resolution to verify
    const premature = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${g.id}/verify-closure`,
      headers: verifier.headers,
      payload: { complainantSatisfied: true },
    });
    expect(premature.statusCode).toBe(400);

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/projects/${pid}/grievances/${g.id}/acknowledge`,
          headers: owner.headers,
          payload: {},
        })
      ).json().status,
    ).toBe("acknowledged");

    const assigned = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${g.id}/assign`,
      headers: owner.headers,
      payload: { assigneeId: owner.userId },
    });
    expect(assigned.json().status).toBe("investigating");
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/projects/${pid}/grievances/${g.id}/assign`,
          headers: owner.headers,
          payload: { assigneeId: stranger.userId },
        })
      ).statusCode,
    ).toBe(400);

    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${g.id}/resolve`,
      headers: owner.headers,
      payload: { resolution: "Haul road watered twice daily" },
    });
    // resolving does NOT satisfy the obligation
    let [obligation] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, g.obligationId));
    expect(obligation!.status).toBe("open");

    const rejected = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${g.id}/verify-closure`,
      headers: verifier.headers,
      payload: { complainantSatisfied: false, note: "Dust unchanged after one week" },
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().status).toBe("investigating");
    expect(rejected.json().complainantSatisfied).toBe(false);
    expect(rejected.json().resolvedAt).toBeNull();
    [obligation] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, g.obligationId));
    expect(obligation!.status).toBe("open");

    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${g.id}/resolve`,
      headers: owner.headers,
      payload: { resolution: "Bowser doubled and road surfaced" },
    });
    const closed = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${g.id}/verify-closure`,
      headers: verifier.headers,
      payload: { complainantSatisfied: true },
    });
    expect(closed.json().status).toBe("closed_verified");
    expect(closed.json().complainantSatisfied).toBe(true);
    [obligation] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, g.obligationId));
    expect(obligation!.status).toBe("satisfied");
  });

  it("breaches the SLA lazily on read, once, with severity-tracking signals", async () => {
    const pid = await makeProject("SLA sweep");
    const overdueCritical = (
      await createGrievance(pid, {
        severity: "critical",
        category: "conduct",
        receivedAt: addDaysISO(todayISO(), -30),
      })
    ).json();
    const overdueMedium = (
      await createGrievance(pid, { severity: "medium", receivedAt: addDaysISO(todayISO(), -40) })
    ).json();
    const inTime = (
      await createGrievance(pid, { severity: "low", receivedAt: todayISO() })
    ).json();

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/grievances`,
      headers: owner.headers,
    });
    expect(list.statusCode).toBe(200);
    const rows = list.json().items as { id: string; overdue: boolean; daysOverdue: number }[];
    expect(rows.find((r) => r.id === overdueCritical.id)!.overdue).toBe(true);
    expect(rows.find((r) => r.id === overdueCritical.id)!.daysOverdue).toBe(23);
    expect(rows.find((r) => r.id === inTime.id)!.overdue).toBe(false);

    // TRIGGER CONTRACT: the list read ran the same grievance sweep the
    // scheduled job runs, scoped to this project, so both breaches are
    // already on the register — exactly once each, raised by the system.
    const fromRead = await app.db
      .select()
      .from(signals)
      .where(and(eq(signals.projectId, pid), eq(signals.detector, "grievance_sla_breach")));
    expect(fromRead).toHaveLength(2);
    expect(fromRead.filter((s) => s.severity === "critical")).toHaveLength(1);
    expect(fromRead.filter((s) => s.severity === "high")).toHaveLength(1);
    for (const s of fromRead) {
      const [ledgered] = await app.db
        .select()
        .from(ledgerEntries)
        .where(and(eq(ledgerEntries.objectType, "signal"), eq(ledgerEntries.objectId, s.id)));
      expect(ledgered!.actorId).toBeNull();
    }

    // the scheduled detector cycle afterwards claims nothing new
    await runDetectors(pid);
    const breached = await app.db
      .select()
      .from(signals)
      .where(and(eq(signals.projectId, pid), eq(signals.detector, "grievance_sla_breach")));
    expect(breached).toHaveLength(2);
    expect(breached.map((s) => s.id).sort()).toEqual(fromRead.map((s) => s.id).sort());

    for (const id of [overdueCritical.obligationId, overdueMedium.obligationId]) {
      const [o] = await app.db.select().from(obligations).where(eq(obligations.id, id));
      expect(o!.status).toBe("breached");
    }
    const [stillOpen] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, inTime.obligationId));
    expect(stillOpen!.status).toBe("open");

    // repeated reads (list AND detail AND analytics) must not duplicate
    await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/grievances`,
      headers: owner.headers,
    });
    await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/grievances/${overdueCritical.id}`,
      headers: owner.headers,
    });
    await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/grievances/analytics`,
      headers: owner.headers,
    });
    await runDetectors(pid);
    const again = await app.db
      .select()
      .from(signals)
      .where(and(eq(signals.projectId, pid), eq(signals.detector, "grievance_sla_breach")));
    expect(again).toHaveLength(2);

    // a late closure does not launder the breach
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${overdueCritical.id}/resolve`,
      headers: owner.headers,
      payload: { resolution: "Contractor supervisor removed from site" },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${overdueCritical.id}/verify-closure`,
      headers: verifier.headers,
      payload: { complainantSatisfied: true },
    });
    const [afterClosure] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, overdueCritical.obligationId));
    expect(afterClosure!.status).toBe("breached");

    const overdueOnly = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/grievances?overdue=true`,
      headers: owner.headers,
    });
    expect(overdueOnly.statusCode).toBe(200);
    // the medium one is still open — escalated by the detector, but escalation
    // is not settlement, so it is still an overdue case
    expect(overdueOnly.json().total).toBe(1);
  });

  /**
   * SEGREGATION OF DUTIES (PLAN §6.3, #573). A satisfied closure asserts what
   * the complainant said; letting the officer who wrote the resolution make
   * that assertion turns the SLA compliance and satisfaction rates the lender
   * reads into self-certification.
   */
  it("refuses a satisfied closure from the officer who wrote the resolution", async () => {
    const pid = await makeProject("Closure segregation");
    const g = (await createGrievance(pid, { severity: "high" })).json();
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${g.id}/resolve`,
      headers: owner.headers,
      payload: { resolution: "Compound wall repaired" },
    });
    const [resolved] = await app.db.select().from(grievances).where(eq(grievances.id, g.id));
    expect(resolved!.resolvedBy).toBe(owner.userId);

    const self = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${g.id}/verify-closure`,
      headers: owner.headers,
      payload: { complainantSatisfied: true },
    });
    expect(self.statusCode).toBe(403);
    expect(self.json().message).toContain("cannot also certify");
    const [stillResolved] = await app.db.select().from(grievances).where(eq(grievances.id, g.id));
    expect(stillResolved!.status).toBe("resolved");

    // recording that the complainant REJECTED the resolution is adverse to the
    // resolver, reopens rather than closes, and stays open to them: blocking
    // it would only encourage leaving a rejection unrecorded
    const reopened = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${g.id}/verify-closure`,
      headers: owner.headers,
      payload: { complainantSatisfied: false, note: "Wall repaired, dust unchanged" },
    });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().status).toBe("investigating");

    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${g.id}/resolve`,
      headers: owner.headers,
      payload: { resolution: "Dust suppression doubled" },
    });
    const byOther = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${g.id}/verify-closure`,
      headers: verifier.headers,
      payload: { complainantSatisfied: true },
    });
    expect(byOther.statusCode).toBe(200);
    expect(byOther.json().status).toBe("closed_verified");
    const [closed] = await app.db.select().from(grievances).where(eq(grievances.id, g.id));
    expect(closed!.verifiedBy).toBe(verifier.userId);
    expect(closed!.resolvedBy).toBe(owner.userId);
  });

  /**
   * With no resolution author on file (a grievance resolved before the column
   * existed, or one closed by a route that does not set it) the assignee is
   * the next-best proxy and is refused on the same grounds.
   */
  it("refuses a satisfied closure from the assignee when no resolver is recorded", async () => {
    const pid = await makeProject("Closure segregation fallback");
    const g = (await createGrievance(pid, { severity: "high" })).json();
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${g.id}/assign`,
      headers: owner.headers,
      payload: { assigneeId: owner.userId },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${g.id}/resolve`,
      headers: verifier.headers,
      payload: { resolution: "Access track reinstated" },
    });
    // strip the resolver, leaving only the assignee to segregate against
    await app.db.update(grievances).set({ resolvedBy: null }).where(eq(grievances.id, g.id));

    const self = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${g.id}/verify-closure`,
      headers: owner.headers,
      payload: { complainantSatisfied: true },
    });
    expect(self.statusCode).toBe(403);
    expect(self.json().message).toContain("assignee");
  });

  it("reports GRM analytics including medians, anonymous share and satisfaction", async () => {
    const pid = await makeProject("GRM analytics");
    const ten = (
      await createGrievance(pid, {
        category: "land",
        channel: "community_meeting",
        receivedAt: addDaysISO(todayISO(), -10),
      })
    ).json();
    const twenty = (
      await createGrievance(pid, {
        category: "land",
        channel: "sms",
        receivedAt: addDaysISO(todayISO(), -20),
      })
    ).json();
    await createGrievance(pid, {
      category: "noise",
      channel: "anonymous",
      severity: "high",
      receivedAt: addDaysISO(todayISO(), -60),
    });
    await createGrievance(pid, { category: "access", severity: "low", receivedAt: todayISO() });

    for (const g of [ten, twenty]) {
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/grievances/${g.id}/resolve`,
        headers: owner.headers,
        payload: { resolution: "Agreed with the household" },
      });
    }
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${ten.id}/verify-closure`,
      headers: verifier.headers,
      payload: { complainantSatisfied: true },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${twenty.id}/verify-closure`,
      headers: verifier.headers,
      payload: { complainantSatisfied: false },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/grievances/analytics`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const a = res.json();
    expect(a.total).toBe(4);
    expect(a.byCategory.land).toBe(2);
    expect(a.byCategory.noise).toBe(1);
    expect(a.byCategory.compensation).toBe(0); // zero-filled
    expect(a.bySeverity.medium).toBe(2);
    expect(a.byChannel.anonymous).toBe(1);
    expect(a.byChannel.sms).toBe(1);
    expect(a.anonymousCount).toBe(1);
    expect(a.anonymousShare).toBe(0.25);
    // The reopened grievance's resolvedAt was cleared, leaving one sample: the
    // grievance received 10 days ago and resolved just now. `daysToResolve`
    // measures from receivedAt at 00:00 UTC to the resolution INSTANT, so the
    // sample is 10 + (UTC time of day / 24) rounded to 1dp — i.e. 10.0 just
    // after midnight and 11.0 from 22:48 UTC onward. The bound is inclusive of
    // 11 for that reason; what it must exclude is the 20-day sample (~20) and a
    // median across both (~15).
    expect(a.medianDaysToResolve).toBeGreaterThanOrEqual(10);
    expect(a.medianDaysToResolve).toBeLessThanOrEqual(11);
    expect(a.verifiedClosures).toBe(2);
    expect(a.satisfactionRate).toBe(0.5);
    expect(a.reopened).toBe(1);
    // the 60-day-old high grievance is past its 14-day deadline
    expect(a.openOverdue).toBe(1);
    expect(a.byMonth[addDaysISO(todayISO(), -10).slice(0, 7)]).toBeGreaterThanOrEqual(1);
  });
});

/* ------------------------------------------------------------------ */
/* Stakeholders & engagement (#579-584)                                */
/* ------------------------------------------------------------------ */

describe("stakeholders and engagement", () => {
  it("maps the influence/interest matrix into Mendelow quadrants", async () => {
    const pid = await makeProject("Stakeholder matrix");
    const make = (name: string, influence: number, interest: number, category?: string) =>
      app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/stakeholders`,
        headers: owner.headers,
        payload: { name, influence, interest, category },
      });
    const ministry = (await make("Ministry of Works", 5, 5, "authority")).json();
    await make("District Council", 5, 2, "authority");
    await make("Affected Households Committee", 2, 5, "community");
    await make("Regional press", 2, 2, "media");
    await make("Local NGO", 4, 4, "ngo");

    expect(ministry.quadrant).toBe("manage_closely");

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/stakeholders/matrix`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const m = res.json();
    expect(m.total).toBe(5);
    expect(m.grid).toHaveLength(25); // full 5x5 lattice, empty cells included
    expect(m.quadrants).toEqual({
      manage_closely: 2,
      keep_satisfied: 1,
      keep_informed: 1,
      monitor: 1,
    });
    const topLeft = m.grid[0];
    expect(topLeft.influence).toBe(5);
    expect(topLeft.interest).toBe(1);
    expect(topLeft.quadrant).toBe("keep_satisfied");
    const cell55 = m.grid.find(
      (c: { influence: number; interest: number }) => c.influence === 5 && c.interest === 5,
    );
    expect(cell55.count).toBe(1);
    expect(cell55.stakeholders[0].name).toBe("Ministry of Works");

    const filtered = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/stakeholders?quadrant=manage_closely`,
      headers: owner.headers,
    });
    expect(filtered.json().total).toBe(2);
  });

  it("logs engagements newest-first with feedback, consent and stakeholder links", async () => {
    const pid = await makeProject("Engagement log");
    const chief = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/stakeholders`,
        headers: owner.headers,
        payload: { name: "Village Chief", influence: 4, interest: 5, category: "community" },
      })
    ).json();

    const foreign = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/engagements`,
      headers: owner.headers,
      payload: {
        title: "Bad link",
        kind: "consultation",
        engagementDate: "2026-01-10",
        stakeholderIds: [newId("stk")],
      },
    });
    expect(foreign.statusCode).toBe(400);

    for (const [title, date] of [
      ["Scoping consultation", "2026-01-10"],
      ["Disclosure of the draft RAP", "2026-03-02"],
      ["FPIC assembly", "2026-02-14"],
    ] as const) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/engagements`,
        headers: owner.headers,
        payload: {
          title,
          kind: title.startsWith("Disclosure") ? "disclosure" : "consultation",
          engagementDate: date,
          stakeholderIds: [chief.id],
          attendeeCount: 40,
          consentStatus: title.startsWith("FPIC") ? "granted" : "pending",
          feedback: [{ point: "Compensation rates too low", disposition: "Revaluation ordered" }],
        },
      });
      expect(res.statusCode).toBe(201);
    }

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/engagements`,
      headers: owner.headers,
    });
    expect(list.json().items.map((e: { title: string }) => e.title)).toEqual([
      "Disclosure of the draft RAP",
      "FPIC assembly",
      "Scoping consultation",
    ]);
    expect(list.json().items[0].stakeholderNames).toEqual(["Village Chief"]);
    expect(list.json().items[0].feedbackCount).toBe(1);

    const consented = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/engagements?consentStatus=granted`,
      headers: owner.headers,
    });
    expect(consented.json().total).toBe(1);
    expect(consented.json().items[0].title).toBe("FPIC assembly");

    // a stakeholder on the consultation record cannot be quietly removed
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${pid}/stakeholders/${chief.id}`,
      headers: owner.headers,
    });
    expect(del.statusCode).toBe(409);
  });
});

/* ------------------------------------------------------------------ */
/* Ledger fidelity on the remaining PATCH routes                        */
/* ------------------------------------------------------------------ */

describe("patch ledger payloads", () => {
  /**
   * Influence and interest drive the Mendelow quadrant and therefore the
   * engagement plan a community gets. A silent re-score from high/high to
   * low/low used to be auditable only as the words "influence, interest",
   * with storePayload unset so nothing was stored at all.
   */
  it("stores the before and after values of a stakeholder re-score", async () => {
    const pid = await makeProject("Stakeholder ledger");
    const s0 = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/stakeholders`,
        headers: owner.headers,
        payload: { name: "Riverside Committee", influence: 5, interest: 5, category: "community" },
      })
    ).json();
    expect(s0.quadrant).toBe("manage_closely");

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/stakeholders/${s0.id}`,
      headers: owner.headers,
      payload: { influence: 1, interest: 1 },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().quadrant).toBe("monitor");

    const [entry] = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.objectType, "stakeholder"),
          eq(ledgerEntries.objectId, s0.id),
          eq(ledgerEntries.action, "update"),
        ),
      )
      .orderBy(ledgerEntries.seq);
    expect(entry!.payload).toMatchObject({
      before: { influence: 5, interest: 5 },
      after: { influence: 1, interest: 1 },
    });
  });

  it("stores the before and after values of an engagement edit", async () => {
    const pid = await makeProject("Engagement ledger");
    const e0 = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/engagements`,
        headers: owner.headers,
        payload: {
          title: "FPIC assembly",
          kind: "consultation",
          engagementDate: todayISO(),
          consentStatus: "pending",
          summary: "Consent not reached; reconvene",
        },
      })
    ).json();

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/engagements/${e0.id}`,
      headers: owner.headers,
      payload: { consentStatus: "granted", summary: "Consent recorded by show of hands" },
    });
    expect(patched.statusCode).toBe(200);

    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.objectType, "engagement"), eq(ledgerEntries.objectId, e0.id)))
      .orderBy(ledgerEntries.seq);
    const update = entries.find((e) => e.action === "update");
    expect(update!.payload).toMatchObject({
      before: { consentStatus: "pending", summary: "Consent not reached; reconvene" },
      after: { consentStatus: "granted", summary: "Consent recorded by show of hands" },
    });
  });
});

/* ------------------------------------------------------------------ */
/* Tenancy                                                             */
/* ------------------------------------------------------------------ */

describe("tenant isolation", () => {
  it("keeps every land register inside its own tenant", async () => {
    const pid = await makeProject("Isolation host");
    const parcel = (await createParcel(pid, { reference: "ISO-1" })).json();
    const pap = (await createPap(pid, { reference: "ISO-PAP" })).json();
    const grievance = (await createGrievance(pid, {})).json();

    for (const url of [
      `/api/v1/projects/${pid}/parcels`,
      `/api/v1/projects/${pid}/parcels/${parcel.id}`,
      `/api/v1/projects/${pid}/affected-persons/${pap.id}`,
      `/api/v1/projects/${pid}/grievances/${grievance.id}`,
      `/api/v1/projects/${pid}/land/rap-progress`,
      `/api/v1/projects/${pid}/land/schedule-risk`,
      `/api/v1/projects/${pid}/stakeholders/matrix`,
    ]) {
      const res = await app.inject({ method: "GET", url, headers: stranger.headers });
      // the project-tool gate refuses before a single land row is touched
      expect(res.statusCode).toBe(403);
    }

    const write = await createParcel(pid, { reference: "ISO-2" }, stranger);
    expect(write.statusCode).toBe(403);

    // the stranger's own project cannot reach the host tenant's rows either
    const theirs = await makeProject("Isolation guest", stranger);
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${theirs}/parcels`,
      headers: stranger.headers,
    });
    expect(list.json().total).toBe(0);

    const rows = await app.db
      .select()
      .from(landParcels)
      .where(eq(landParcels.companyId, stranger.companyId));
    expect(rows).toHaveLength(0);
    const paps = await app.db
      .select()
      .from(affectedPersons)
      .where(eq(affectedPersons.companyId, stranger.companyId));
    expect(paps).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Company-wide search (contract §3.3)                                 */
/* ------------------------------------------------------------------ */

describe("search sources", () => {
  it("finds parcels and grievances from the company search, and isolates tenants", async () => {
    const pid = await makeProject("Searchable land");
    const created = await createParcel(pid, {
      reference: "CAD-KIBAALE-447",
      ownerName: "Elders of Kibaale",
    });
    expect(created.statusCode).toBe(201);
    const grievance = await createGrievance(pid, {
      description: "Blasting vibration cracked the Kibaale schoolhouse wall",
    });
    expect(grievance.statusCode).toBe(201);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/search?q=${encodeURIComponent("Kibaale")}&limit=20`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: { type: string; id: string; href: string; title: string }[];
      coverage: string[];
    };
    expect(body.coverage).toContain("land_parcel");
    expect(body.coverage).toContain("grievance");
    const parcelHit = body.items.find((i) => i.type === "land_parcel");
    expect(parcelHit?.id).toBe(created.json().id);
    expect(parcelHit?.href).toBe(`/projects/${pid}/land?tab=parcels`);
    const grievanceHit = body.items.find((i) => i.type === "grievance");
    expect(grievanceHit?.id).toBe(grievance.json().id);
    expect(grievanceHit?.href).toBe(`/projects/${pid}/land?tab=grievances`);

    // another tenant searching the same words finds nothing of ours
    const foreign = await app.inject({
      method: "GET",
      url: `/api/v1/search?q=${encodeURIComponent("Kibaale")}&limit=20`,
      headers: stranger.headers,
    });
    expect(foreign.statusCode).toBe(200);
    expect(
      (foreign.json() as { items: { id: string }[] }).items.map((i) => i.id),
    ).not.toContain(created.json().id);
  });
});
