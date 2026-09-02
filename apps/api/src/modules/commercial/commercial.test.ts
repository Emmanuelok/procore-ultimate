import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  assertions,
  boqItems,
  companyMemberships,
  contracts,
  drawingSheets,
  ledgerEntries,
  projectMemberships,
  projects,
  takeoffLines,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";

let built: BuiltApp;
let u1: TestActor; // company owner — certifier
let u2: TestActor; // member with project_admin template — applicant
let u2Headers: Record<string, string>;
let projA: string; // BoQ / hierarchy / taking-off
let projB: string; // valuations + certificates
let projC: string; // variations
let projD: string; // commercial summary
let contractA: string;
let sheetA: string;

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

  projA = newId("prj");
  projB = newId("prj");
  projC = newId("prj");
  projD = newId("prj");
  for (const [id, name] of [
    [projA, "Commercial A"],
    [projB, "Commercial B"],
    [projC, "Commercial C"],
    [projD, "Commercial D"],
  ] as const) {
    await built.app.db.insert(projects).values({ id, companyId: u1.companyId, name });
  }
  for (const projectId of [projB, projD]) {
    await built.app.db.insert(projectMemberships).values({
      id: newId("pm"),
      companyId: u1.companyId,
      projectId,
      userId: u2.userId,
      templateKey: "project_admin",
      overrides: {},
    });
  }

  contractA = newId("con");
  await built.app.db.insert(contracts).values({
    id: contractA,
    companyId: u1.companyId,
    projectId: projA,
    name: "Main works contract",
    form: "fidic_red_1999",
    // the bills raised against this contract are priced in GBP; a BoQ whose
    // currency disagrees with its contract is now refused (#178)
    currency: "GBP",
    createdBy: u1.userId,
  });
  sheetA = newId("sheet");
  await built.app.db.insert(drawingSheets).values({
    id: sheetA,
    companyId: u1.companyId,
    projectId: projA,
    number: "A-101",
    title: "Foundation plan",
  });
}, 180_000);

afterAll(async () => {
  await built.close();
});

const inject = (
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  headers: Record<string, string>,
  payload?: unknown,
) => built.app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });

/* ------------------------------------------------------------------ */
/* BoQ + hierarchy + rate build-up                                     */
/* ------------------------------------------------------------------ */

let boqA: string;
let billId: string;
let sectionId: string;
let item1: string; // qty 100 × rate 10 = 1000
let item2: string; // qty 5 × rate 20 = 100 (item directly under bill)

describe("Bills of Quantities", () => {
  it("creates a BoQ and validates the contract reference", async () => {
    const bad = await inject("POST", `/api/v1/projects/${projA}/boqs`, u1.headers, {
      name: "Bad",
      method: "nrm2",
      contractId: newId("con"),
    });
    expect(bad.statusCode).toBe(400);

    const res = await inject("POST", `/api/v1/projects/${projA}/boqs`, u1.headers, {
      name: "Main BQ",
      method: "nrm2",
      currency: "GBP",
      contractId: contractA,
    });
    expect(res.statusCode).toBe(201);
    const boq = res.json();
    boqA = boq.id;
    expect(boq.status).toBe("draft");
    expect(boq.method).toBe("nrm2");
    expect(boq.contractId).toBe(contractA);
  });

  it("enforces bill > section > item hierarchy with materialized paths", async () => {
    const bill = await inject("POST", `/api/v1/boqs/${boqA}/items`, u1.headers, {
      level: "bill",
      code: "1",
      description: "Substructure",
    });
    expect(bill.statusCode).toBe(201);
    billId = bill.json().id;
    expect(bill.json().path).toBe(billId);

    // a bill cannot sit under a parent; a section requires a bill parent
    const badBill = await inject("POST", `/api/v1/boqs/${boqA}/items`, u1.headers, {
      level: "bill",
      code: "2",
      description: "Nested bill",
      parentId: billId,
    });
    expect(badBill.statusCode).toBe(400);
    const rootSection = await inject("POST", `/api/v1/boqs/${boqA}/items`, u1.headers, {
      level: "section",
      code: "1.1",
      description: "Orphan section",
    });
    expect(rootSection.statusCode).toBe(400);

    const section = await inject("POST", `/api/v1/boqs/${boqA}/items`, u1.headers, {
      level: "section",
      code: "1.1",
      description: "Excavation",
      parentId: billId,
    });
    expect(section.statusCode).toBe(201);
    sectionId = section.json().id;
    expect(section.json().path).toBe(`${billId}/${sectionId}`);

    const sectionUnderSection = await inject("POST", `/api/v1/boqs/${boqA}/items`, u1.headers, {
      level: "section",
      code: "1.1.1",
      description: "Bad nesting",
      parentId: sectionId,
    });
    expect(sectionUnderSection.statusCode).toBe(400);

    const item = await inject("POST", `/api/v1/boqs/${boqA}/items`, u1.headers, {
      level: "item",
      code: "1.1.A",
      description: "Excavate to reduce level",
      parentId: sectionId,
      unit: "m3",
      quantity: 100,
      rate: 10,
    });
    expect(item.statusCode).toBe(201);
    item1 = item.json().id;
    expect(item.json().path).toBe(`${billId}/${sectionId}/${item1}`);
    expect(item.json().amount).toBe(1000);

    // small-BQ relaxation: an item may hang directly off a bill
    const itemUnderBill = await inject("POST", `/api/v1/boqs/${boqA}/items`, u1.headers, {
      level: "item",
      code: "1.B",
      description: "Disposal off site",
      parentId: billId,
      unit: "m3",
      quantity: 5,
      rate: 20,
    });
    expect(itemUnderBill.statusCode).toBe(201);
    item2 = itemUnderBill.json().id;
  });

  it("computes the rate from a build-up sheet and 400s a mismatched explicit rate", async () => {
    const mismatch = await inject("POST", `/api/v1/boqs/${boqA}/items`, u1.headers, {
      level: "item",
      code: "1.1.B",
      description: "Concrete grade C30",
      parentId: sectionId,
      quantity: 4,
      rate: 30,
      rateBuildUp: [
        { kind: "labour", description: "Gang", qty: 2, rate: 10 },
        { kind: "material", description: "Concrete", qty: 1, rate: 5.5 },
      ],
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().message).toMatch(/does not match/);

    const ok = await inject("POST", `/api/v1/boqs/${boqA}/items`, u1.headers, {
      level: "item",
      code: "1.1.B",
      description: "Concrete grade C30",
      parentId: sectionId,
      unit: "m3",
      quantity: 4,
      itemType: "provisional_defined",
      rateBuildUp: [
        { kind: "labour", description: "Gang", qty: 2, rate: 10 },
        { kind: "material", description: "Concrete", qty: 1, rate: 5.5 },
      ],
    });
    expect(ok.statusCode).toBe(201);
    const item = ok.json();
    expect(item.rate).toBe(25.5); // 2×10 + 1×5.5
    expect(item.amount).toBe(102); // 4 × 25.5
    expect(item.rateBuildUp[0].amount).toBe(20);
    expect(item.rateBuildUp[1].amount).toBe(5.5);
  });

  it("lists BoQs with aggregates, assembles the item tree and rolls up the summary", async () => {
    const list = await inject("GET", `/api/v1/projects/${projA}/boqs`, u1.headers);
    expect(list.statusCode).toBe(200);
    const row = list.json().items.find((b: { id: string }) => b.id === boqA);
    expect(row.itemCount).toBe(5); // bill + section + 3 items
    expect(row.totalAmount).toBe(1202); // 1000 + 100 + 102

    const one = await inject("GET", `/api/v1/boqs/${boqA}`, u1.headers);
    expect(one.statusCode).toBe(200);
    const tree = one.json().items;
    expect(tree).toHaveLength(1); // one root bill
    expect(tree[0].id).toBe(billId);
    const section = tree[0].children.find((c: { id: string }) => c.id === sectionId);
    expect(section.children.map((c: { id: string }) => c.id)).toContain(item1);
    expect(one.json().totalAmount).toBe(1202);

    const summary = await inject("GET", `/api/v1/boqs/${boqA}/summary`, u1.headers);
    expect(summary.statusCode).toBe(200);
    const byType = Object.fromEntries(
      summary.json().byItemType.map((t: { itemType: string; amount: number }) => [
        t.itemType,
        t.amount,
      ]),
    );
    expect(byType["measured"]).toBe(1100);
    expect(byType["provisional_defined"]).toBe(102);
    expect(summary.json().byBill).toEqual([
      expect.objectContaining({ id: billId, amount: 1202 }),
    ]);
    expect(summary.json().total).toBe(1202);
  });

  it("moves BoQ status forward only and freezes items once agreed", async () => {
    const create = await inject("POST", `/api/v1/projects/${projA}/boqs`, u1.headers, {
      name: "Lockdown BQ",
      method: "smm7",
    });
    const lockId = create.json().id;
    const bill = await inject("POST", `/api/v1/boqs/${lockId}/items`, u1.headers, {
      level: "bill",
      code: "1",
      description: "Bill",
    });
    const item = await inject("POST", `/api/v1/boqs/${lockId}/items`, u1.headers, {
      level: "item",
      code: "1.A",
      description: "Item",
      parentId: bill.json().id,
      quantity: 1,
      rate: 100,
    });

    const issue = await inject("PATCH", `/api/v1/boqs/${lockId}`, u1.headers, {
      status: "issued",
    });
    expect(issue.statusCode).toBe(200);
    expect(issue.json().status).toBe("issued");

    const back = await inject("PATCH", `/api/v1/boqs/${lockId}`, u1.headers, {
      status: "draft",
    });
    expect(back.statusCode).toBe(400);

    const agree = await inject("PATCH", `/api/v1/boqs/${lockId}`, u1.headers, {
      status: "agreed",
    });
    expect(agree.json().status).toBe("agreed");

    const editItem = await inject("PATCH", `/api/v1/boq-items/${item.json().id}`, u1.headers, {
      rate: 120,
    });
    expect(editItem.statusCode).toBe(400);
    const addItem = await inject("POST", `/api/v1/boqs/${lockId}/items`, u1.headers, {
      level: "item",
      code: "1.B",
      description: "Late item",
      parentId: bill.json().id,
    });
    expect(addItem.statusCode).toBe(400);
    const del = await inject("DELETE", `/api/v1/boqs/${lockId}`, u1.headers);
    expect(del.statusCode).toBe(400); // not draft

    // state_change entries were ledgered
    const rows = await built.app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, u1.companyId),
          eq(ledgerEntries.objectType, "boq"),
          eq(ledgerEntries.objectId, lockId),
          eq(ledgerEntries.action, "state_change"),
        ),
      );
    expect(rows).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* Taking-off (#135-140)                                               */
/* ------------------------------------------------------------------ */

describe("Taking-off", () => {
  it("computes quantities from dimensions, validates the drawing sheet, allows manual override", async () => {
    const noDims = await inject("POST", `/api/v1/boq-items/${item1}/takeoff`, u1.headers, {
      description: "Nothing measurable",
    });
    expect(noDims.statusCode).toBe(400);

    const badSheet = await inject("POST", `/api/v1/boq-items/${item1}/takeoff`, u1.headers, {
      description: "Pit 1",
      length: 3,
      drawingSheetId: newId("sheet"),
    });
    expect(badSheet.statusCode).toBe(400);

    const computed = await inject("POST", `/api/v1/boq-items/${item1}/takeoff`, u1.headers, {
      description: "Pit 1",
      timesing: 2,
      length: 3,
      width: 2,
      depth: 0.5,
      drawingSheetId: sheetA,
    });
    expect(computed.statusCode).toBe(201);
    expect(computed.json().quantity).toBe(6); // 2 × 3 × 2 × 0.5
    expect(computed.json().isManual).toBe(0);
    expect(computed.json().drawingSheetId).toBe(sheetA);

    const manual = await inject("POST", `/api/v1/boq-items/${item1}/takeoff`, u1.headers, {
      description: "Surveyor's figure",
      quantity: 12.5,
    });
    expect(manual.statusCode).toBe(201);
    expect(manual.json().quantity).toBe(12.5);
    expect(manual.json().isManual).toBe(1);

    const list = await inject("GET", `/api/v1/boq-items/${item1}/takeoff`, u1.headers);
    expect(list.json().items).toHaveLength(2);
    expect(list.json().total).toBe(18.5);
  });

  it("applies the dimension sheet to the item quantity with ledgered provenance", async () => {
    const apply = await inject("POST", `/api/v1/boq-items/${item1}/takeoff/apply`, u1.headers);
    expect(apply.statusCode).toBe(200);
    expect(apply.json().quantity).toBe(18.5);
    expect(apply.json().amount).toBe(185); // 18.5 × rate 10

    const trail = await built.app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, u1.companyId),
          eq(ledgerEntries.objectType, "boq_item"),
          eq(ledgerEntries.objectId, item1),
          eq(ledgerEntries.action, "update"),
        ),
      );
    expect(trail.length).toBeGreaterThanOrEqual(1);
  });
});

/* ------------------------------------------------------------------ */
/* Valuations + certificates (#162-167, #179-180)                      */
/* ------------------------------------------------------------------ */

let boqV: string;
let vItem1: string; // qty 100 × 10 = 1000
let vItem2: string; // qty 50 × 20 = 1000
let val1: string;
let val2: string;
let cert1: { id: string; netCertified: number };

describe("Valuations and payment certificates", () => {
  beforeAll(async () => {
    const boq = await inject("POST", `/api/v1/projects/${projB}/boqs`, u1.headers, {
      name: "Valuation BQ",
      method: "nrm2",
    });
    boqV = boq.json().id;
    const bill = await inject("POST", `/api/v1/boqs/${boqV}/items`, u1.headers, {
      level: "bill",
      code: "1",
      description: "Works",
    });
    const mk = async (code: string, qty: number, rate: number) => {
      const r = await inject("POST", `/api/v1/boqs/${boqV}/items`, u1.headers, {
        level: "item",
        code,
        description: `Item ${code}`,
        parentId: bill.json().id,
        quantity: qty,
        rate,
      });
      return r.json().id as string;
    };
    vItem1 = await mk("1.A", 100, 10);
    vItem2 = await mk("1.B", 50, 20);
    await inject("PATCH", `/api/v1/boqs/${boqV}`, u1.headers, { status: "issued" });
  });

  it("seeds draft lines for every leaf item with zero previous on the first application", async () => {
    const res = await inject("POST", `/api/v1/projects/${projB}/valuations`, u2Headers, {
      boqId: boqV,
      valuationDate: "2026-08-01",
      basis: "remeasure",
      retentionPercent: 5,
    });
    expect(res.statusCode).toBe(201);
    const val = res.json();
    val1 = val.id;
    expect(val.number).toBe(1);
    expect(val.status).toBe("draft");
    expect(val.lines).toHaveLength(2);
    for (const line of val.lines) {
      expect(line.previousAmount).toBe(0);
      expect(line.amountToDate).toBe(0);
    }
    expect(val.workDoneToDate).toBe(0);
    expect(val.previousNet).toBe(0);
    expect(val.netDue).toBe(0);
  });

  it("computes remeasure and percent line math, retention and net due", async () => {
    const both = await inject("PUT", `/api/v1/valuations/${val1}/lines`, u2Headers, {
      lines: [{ boqItemId: vItem1, qtyToDate: 40, percentToDate: 50 }],
    });
    expect(both.statusCode).toBe(400);

    const res = await inject("PUT", `/api/v1/valuations/${val1}/lines`, u2Headers, {
      lines: [
        { boqItemId: vItem1, qtyToDate: 40 }, // remeasure: 40 × 10 = 400
        { boqItemId: vItem2, percentToDate: 50 }, // percent: 50% × 1000 = 500
      ],
    });
    expect(res.statusCode).toBe(200);
    const val = res.json();
    const l1 = val.lines.find((l: { boqItemId: string }) => l.boqItemId === vItem1);
    const l2 = val.lines.find((l: { boqItemId: string }) => l.boqItemId === vItem2);
    expect(l1.amountToDate).toBe(400);
    expect(l1.thisPeriod).toBe(400);
    expect(l2.amountToDate).toBe(500);
    expect(val.workDoneToDate).toBe(900);

    const patched = await inject("PATCH", `/api/v1/valuations/${val1}`, u2Headers, {
      materialsOnSite: 100,
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().retentionHeld).toBe(50); // 5% × (900 + 100)
    expect(patched.json().netDue).toBe(950); // 1000 − 50 − 0
  });

  it("certifies with separation of duties, variance statement and an assurance assertion", async () => {
    const submit = await inject("POST", `/api/v1/valuations/${val1}/submit`, u2Headers);
    expect(submit.statusCode).toBe(200);
    expect(submit.json().status).toBe("submitted");
    expect(submit.json().submittedBy).toBe(u2.userId);

    // the applicant cannot certify their own application
    const selfCertify = await inject("POST", `/api/v1/valuations/${val1}/certify`, u2Headers, {});
    expect(selfCertify.statusCode).toBe(403);

    const res = await inject("POST", `/api/v1/valuations/${val1}/certify`, u1.headers, {
      certifiedWorkDone: 800,
      varianceReason: "Overmeasure on excavation",
    });
    expect(res.statusCode).toBe(201);
    const cert = res.json();
    cert1 = cert;
    expect(cert.number).toBe(1);
    expect(cert.certifiedWorkDone).toBe(800);
    expect(cert.certifiedMaterials).toBe(100); // defaults to the application's materials
    expect(cert.retentionHeld).toBe(45); // 5% × 900
    expect(cert.previousCertified).toBe(0);
    expect(cert.netCertified).toBe(855); // 800 + 100 − 45
    expect(cert.varianceFromApplication).toBe(-95); // 855 − 950
    expect(cert.varianceReason).toBe("Overmeasure on excavation");

    const val = await inject("GET", `/api/v1/valuations/${val1}`, u1.headers);
    expect(val.json().status).toBe("certified");

    // the certified value became a reconcilable Assertion
    const asserted = await built.app.db
      .select()
      .from(assertions)
      .where(and(eq(assertions.sourceType, "payment_certificate"), eq(assertions.sourceId, cert.id)));
    expect(asserted).toHaveLength(1);
    expect(asserted[0]!.kind).toBe("cost");
    expect(asserted[0]!.value).toBe(855);
    expect(asserted[0]!.claimantId).toBe(u1.userId);
    expect(asserted[0]!.basis).toBe("payment certificate 1");

    // certificate ledgered with stored payload
    const trail = await built.app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.objectType, "payment_certificate"),
          eq(ledgerEntries.objectId, cert.id),
        ),
      );
    expect(trail).toHaveLength(1);
    expect((trail[0]!.payload as { netCertified: number }).netCertified).toBe(855);
  });

  it("carries the certified position into the next valuation and chains previousNet", async () => {
    const res = await inject("POST", `/api/v1/projects/${projB}/valuations`, u2Headers, {
      boqId: boqV,
      valuationDate: "2026-09-01",
      basis: "remeasure",
      retentionPercent: 5,
    });
    expect(res.statusCode).toBe(201);
    const val = res.json();
    val2 = val.id;
    expect(val.number).toBe(2);
    const l1 = val.lines.find((l: { boqItemId: string }) => l.boqItemId === vItem1);
    const l2 = val.lines.find((l: { boqItemId: string }) => l.boqItemId === vItem2);
    expect(l1.previousAmount).toBe(400); // from certified valuation 1's lines
    expect(l2.previousAmount).toBe(500);
    expect(val.previousNet).toBe(855); // certificate 1
    expect(val.workDoneToDate).toBe(900);
    expect(val.netDue).toBe(0); // 900 − 45 retention − 855

    const put = await inject("PUT", `/api/v1/valuations/${val2}/lines`, u2Headers, {
      lines: [
        { boqItemId: vItem1, qtyToDate: 100 }, // 1000
        { boqItemId: vItem2, percentToDate: 100 }, // 1000
      ],
    });
    const updated = put.json();
    const u1l = updated.lines.find((l: { boqItemId: string }) => l.boqItemId === vItem1);
    expect(u1l.thisPeriod).toBe(600); // 1000 − 400
    expect(updated.workDoneToDate).toBe(2000);
    expect(updated.retentionHeld).toBe(100);
    expect(updated.netDue).toBe(1045); // 2000 − 100 − 855

    await inject("POST", `/api/v1/valuations/${val2}/submit`, u2Headers);
    const certRes = await inject("POST", `/api/v1/valuations/${val2}/certify`, u1.headers, {});
    expect(certRes.statusCode).toBe(201);
    const cert = certRes.json();
    expect(cert.number).toBe(2);
    expect(cert.certifiedWorkDone).toBe(2000); // defaults to the application
    expect(cert.certifiedMaterials).toBe(0);
    expect(cert.retentionHeld).toBe(100);
    expect(cert.previousCertified).toBe(855); // cert 1's net
    expect(cert.netCertified).toBe(1045);
    expect(cert.varianceFromApplication).toBe(0);
  });

  it("locks lines and header once a valuation leaves draft", async () => {
    const put = await inject("PUT", `/api/v1/valuations/${val2}/lines`, u2Headers, {
      lines: [{ boqItemId: vItem1, qtyToDate: 10 }],
    });
    expect(put.statusCode).toBe(400);
    const patch = await inject("PATCH", `/api/v1/valuations/${val2}`, u2Headers, {
      materialsOnSite: 5,
    });
    expect(patch.statusCode).toBe(400);
    const resubmit = await inject("POST", `/api/v1/valuations/${val2}/submit`, u2Headers);
    expect(resubmit.statusCode).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* Variations (#168-171)                                               */
/* ------------------------------------------------------------------ */

let wItem: string; // BQ item, rate 10
let var1: string;

describe("Variations", () => {
  beforeAll(async () => {
    const boq = await inject("POST", `/api/v1/projects/${projC}/boqs`, u1.headers, {
      name: "Variation BQ",
      method: "cesmm4",
    });
    const bill = await inject("POST", `/api/v1/boqs/${boq.json().id}/items`, u1.headers, {
      level: "bill",
      code: "2",
      description: "Earthworks",
    });
    const item = await inject("POST", `/api/v1/boqs/${boq.json().id}/items`, u1.headers, {
      level: "item",
      code: "2.A",
      description: "Excavation",
      parentId: bill.json().id,
      quantity: 5,
      rate: 10,
    });
    wItem = item.json().id;
  });

  it("walks the lifecycle with instruction gating and terminal locking", async () => {
    const res = await inject("POST", `/api/v1/projects/${projC}/variations`, u1.headers, {
      title: "Extra footings",
      basis: "bq_rates",
      costEstimate: 500,
      boqItemRefs: [wItem],
    });
    expect(res.statusCode).toBe(201);
    var1 = res.json().id;
    expect(res.json().number).toBe(1);
    expect(res.json().status).toBe("proposed");

    const skipToValued = await inject(
      "POST",
      `/api/v1/variations/${var1}/status`,
      u1.headers,
      { status: "valued" },
    );
    expect(skipToValued.statusCode).toBe(400);

    const noRef = await inject("POST", `/api/v1/variations/${var1}/status`, u1.headers, {
      status: "instructed",
    });
    expect(noRef.statusCode).toBe(400);

    const instructed = await inject("POST", `/api/v1/variations/${var1}/status`, u1.headers, {
      status: "instructed",
      instructionRef: "AI-005",
      instructedAt: "2026-08-10",
    });
    expect(instructed.statusCode).toBe(200);
    expect(instructed.json().status).toBe("instructed");

    const skipToAgreed = await inject("POST", `/api/v1/variations/${var1}/status`, u1.headers, {
      status: "agreed",
    });
    expect(skipToAgreed.statusCode).toBe(400);
  });

  it("rejects bq_rates build-ups whose rate departs from the BQ rate", async () => {
    const wrongRate = await inject("POST", `/api/v1/variations/${var1}/value`, u1.headers, {
      basis: "bq_rates",
      buildUp: [{ boqItemId: wItem, description: "Extra excavation", qty: 10, rate: 12 }],
    });
    expect(wrongRate.statusCode).toBe(400);
    expect(wrongRate.json().message).toMatch(/star_rate/);

    const noItemRef = await inject("POST", `/api/v1/variations/${var1}/value`, u1.headers, {
      basis: "bq_rates",
      buildUp: [{ description: "Free line", qty: 1, rate: 50 }],
    });
    expect(noItemRef.statusCode).toBe(400);

    const ok = await inject("POST", `/api/v1/variations/${var1}/value`, u1.headers, {
      basis: "bq_rates",
      buildUp: [{ boqItemId: wItem, description: "Extra excavation", qty: 10, rate: 10 }],
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().agreedValue).toBe(100);
    expect(ok.json().status).toBe("valued"); // instructed → valued on valuation

    const agreed = await inject("POST", `/api/v1/variations/${var1}/status`, u1.headers, {
      status: "agreed",
    });
    expect(agreed.json().status).toBe("agreed");

    const patchTerminal = await inject("PATCH", `/api/v1/variations/${var1}`, u1.headers, {
      title: "Renamed",
    });
    expect(patchTerminal.statusCode).toBe(400);
  });

  it("values star_rate build-ups freely and requires refs for bq_rates/pro_rata", async () => {
    const star = await inject("POST", `/api/v1/projects/${projC}/variations`, u1.headers, {
      title: "Dayworks attendance",
      basis: "star_rate",
    });
    const starId = star.json().id;
    const valued = await inject("POST", `/api/v1/variations/${starId}/value`, u1.headers, {
      basis: "star_rate",
      buildUp: [{ description: "Gang of 4, 8h", qty: 8, rate: 55 }],
    });
    expect(valued.statusCode).toBe(200);
    expect(valued.json().agreedValue).toBe(440);
    expect(valued.json().status).toBe("proposed"); // no instruction yet

    const rejected = await inject("POST", `/api/v1/variations/${starId}/status`, u1.headers, {
      status: "rejected",
    });
    expect(rejected.json().status).toBe("rejected");
    const valueRejected = await inject("POST", `/api/v1/variations/${starId}/value`, u1.headers, {
      basis: "star_rate",
      agreedValue: 10,
    });
    expect(valueRejected.statusCode).toBe(400);

    const noRefs = await inject("POST", `/api/v1/projects/${projC}/variations`, u1.headers, {
      title: "Pro-rata without refs",
      basis: "pro_rata",
      costEstimate: 250,
    });
    const noRefsValue = await inject(
      "POST",
      `/api/v1/variations/${noRefs.json().id}/value`,
      u1.headers,
      { basis: "pro_rata", agreedValue: 100 },
    );
    expect(noRefsValue.statusCode).toBe(400);
    expect(noRefsValue.json().message).toMatch(/BQ item references/);
  });

  it("returns register-wide value totals on the list", async () => {
    const list = await inject("GET", `/api/v1/projects/${projC}/variations`, u1.headers);
    expect(list.statusCode).toBe(200);
    expect(list.json().total).toBe(3);
    expect(list.json().totals.agreed).toBe(100); // var1
    expect(list.json().totals.pending).toBe(250); // the un-valued pro_rata estimate
    const filtered = await inject(
      "GET",
      `/api/v1/projects/${projC}/variations?status=agreed`,
      u1.headers,
    );
    expect(filtered.json().items).toHaveLength(1);
    expect(filtered.json().totals.agreed).toBe(100); // totals stay register-wide
  });
});

/* ------------------------------------------------------------------ */
/* Commercial summary — the CVR seed (#184)                            */
/* ------------------------------------------------------------------ */

describe("Commercial summary", () => {
  it("aggregates BoQ, certified, retention and variation positions into the forecast", async () => {
    const boq = await inject("POST", `/api/v1/projects/${projD}/boqs`, u1.headers, {
      name: "Summary BQ",
      method: "nrm2",
    });
    const boqId = boq.json().id;
    const bill = await inject("POST", `/api/v1/boqs/${boqId}/items`, u1.headers, {
      level: "bill",
      code: "1",
      description: "Works",
    });
    const item = await inject("POST", `/api/v1/boqs/${boqId}/items`, u1.headers, {
      level: "item",
      code: "1.A",
      description: "Structure",
      parentId: bill.json().id,
      quantity: 10,
      rate: 100,
    });
    await inject("PATCH", `/api/v1/boqs/${boqId}`, u1.headers, { status: "issued" });

    const val = await inject("POST", `/api/v1/projects/${projD}/valuations`, u2Headers, {
      boqId,
      valuationDate: "2026-08-15",
      basis: "remeasure",
      retentionPercent: 5,
    });
    await inject("PUT", `/api/v1/valuations/${val.json().id}/lines`, u2Headers, {
      lines: [{ boqItemId: item.json().id, qtyToDate: 5 }], // 500
    });
    await inject("POST", `/api/v1/valuations/${val.json().id}/submit`, u2Headers);
    const cert = await inject("POST", `/api/v1/valuations/${val.json().id}/certify`, u1.headers, {});
    expect(cert.statusCode).toBe(201);
    expect(cert.json().netCertified).toBe(475); // 500 − 25 retention

    // one agreed variation (200) and one pending estimate (100)
    const vAgreed = await inject("POST", `/api/v1/projects/${projD}/variations`, u1.headers, {
      title: "Agreed extra",
      basis: "star_rate",
      costEstimate: 200,
    });
    await inject("POST", `/api/v1/variations/${vAgreed.json().id}/status`, u1.headers, {
      status: "instructed",
      instructionRef: "AI-001",
      instructedAt: "2026-08-16",
    });
    await inject("POST", `/api/v1/variations/${vAgreed.json().id}/value`, u1.headers, {
      basis: "star_rate",
      agreedValue: 200,
    });
    await inject("POST", `/api/v1/variations/${vAgreed.json().id}/status`, u1.headers, {
      status: "agreed",
    });
    await inject("POST", `/api/v1/projects/${projD}/variations`, u1.headers, {
      title: "Pending extra",
      basis: "star_rate",
      costEstimate: 100,
    });

    const res = await inject("GET", `/api/v1/projects/${projD}/commercial/summary`, u1.headers);
    expect(res.statusCode).toBe(200);
    const summary = res.json() as {
      currency: string | null;
      boqTotal: number | null;
      certifiedToDate: number | null;
      retentionHeld: number | null;
      variationsAgreed: number | null;
      variationsPending: number | null;
      forecastFinal: number | null;
      byCurrency: Array<{ currency: string; boqTotal: number; forecastFinal: number }>;
      reasons: string[];
    };
    // one currency on this project, so the flat totals are populated
    expect(summary.currency).toBe("USD");
    expect(summary.boqTotal).toBe(1000);
    expect(summary.certifiedToDate).toBe(475);
    expect(summary.retentionHeld).toBe(25);
    expect(summary.variationsAgreed).toBe(200);
    expect(summary.variationsPending).toBe(100);
    expect(summary.forecastFinal).toBe(1300); // 1000 + 200 + 100
    expect(summary.byCurrency).toHaveLength(1);
    expect(summary.byCurrency[0]).toMatchObject({ currency: "USD", boqTotal: 1000, forecastFinal: 1300 });
    expect(summary.reasons).toEqual([]);
  });

  it("refuses to add money across currencies and says why", async () => {
    // a second bill on the same project, priced in AED
    const aed = await inject("POST", `/api/v1/projects/${projD}/boqs`, u1.headers, {
      name: "AED package",
      method: "nrm2",
      currency: "AED",
    });
    const aedId = aed.json().id as string;
    const bill = await inject("POST", `/api/v1/boqs/${aedId}/items`, u1.headers, {
      level: "bill",
      code: "1",
      description: "Works",
    });
    await inject("POST", `/api/v1/boqs/${aedId}/items`, u1.headers, {
      level: "item",
      code: "1.A",
      description: "Imported facade",
      parentId: bill.json().id,
      quantity: 10,
      rate: 470,
    });
    await inject("PATCH", `/api/v1/boqs/${aedId}`, u1.headers, { status: "issued" });

    const res = await inject("GET", `/api/v1/projects/${projD}/commercial/summary`, u1.headers);
    const summary = res.json() as {
      currency: string | null;
      boqTotal: number | null;
      byCurrency: Array<{ currency: string; boqTotal: number }>;
      reasons: string[];
    };
    // 1,000 USD + 4,700 AED is not 5,700 of anything
    expect(summary.boqTotal).toBeNull();
    expect(summary.currency).toBeNull();
    expect(summary.byCurrency).toHaveLength(2);
    expect(summary.byCurrency.find((c) => c.currency === "AED")?.boqTotal).toBe(4700);
    expect(summary.byCurrency.find((c) => c.currency === "USD")?.boqTotal).toBe(1000);
    expect(summary.reasons.join(" ")).toContain("2 currencies");
  });
});

/* ------------------------------------------------------------------ */
/* Destructive paths                                                   */
/* ------------------------------------------------------------------ */

describe("Deletion rules", () => {
  it("cascades a draft BoQ delete and blocks parent-item deletion while children exist", async () => {
    const boq = await inject("POST", `/api/v1/projects/${projA}/boqs`, u1.headers, {
      name: "Scratch BQ",
      method: "custom",
    });
    const boqId = boq.json().id;
    const bill = await inject("POST", `/api/v1/boqs/${boqId}/items`, u1.headers, {
      level: "bill",
      code: "1",
      description: "Bill",
    });
    const item = await inject("POST", `/api/v1/boqs/${boqId}/items`, u1.headers, {
      level: "item",
      code: "1.A",
      description: "Item",
      parentId: bill.json().id,
      quantity: 2,
      rate: 5,
    });
    await inject("POST", `/api/v1/boq-items/${item.json().id}/takeoff`, u1.headers, {
      description: "Line",
      length: 4,
    });

    const delParent = await inject("DELETE", `/api/v1/boq-items/${bill.json().id}`, u1.headers);
    expect(delParent.statusCode).toBe(400); // childless rule

    const delBoq = await inject("DELETE", `/api/v1/boqs/${boqId}`, u1.headers);
    expect(delBoq.statusCode).toBe(200);
    const items = await built.app.db.select().from(boqItems).where(eq(boqItems.boqId, boqId));
    expect(items).toHaveLength(0);
    const lines = await built.app.db
      .select()
      .from(takeoffLines)
      .where(eq(takeoffLines.boqItemId, item.json().id));
    expect(lines).toHaveLength(0);
    const gone = await inject("GET", `/api/v1/boqs/${boqId}`, u1.headers);
    expect(gone.statusCode).toBe(404);
  });
});
