import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  commitmentPayments,
  commitments,
  companyMemberships,
  invoiceLineItems,
  invoices,
  ledgerEntries,
  notifications,
  obligations,
  projectMemberships,
  projects,
  signals,
  taxPeriods,
  taxRegistrations,
  vendors,
} from "@constructos/db";
import { TAX_REGIMES } from "@constructos/shared";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO, todayISO } from "../field/dates.js";
import { taxModule } from "./index.js";

/**
 * Tax & statutory deduction — route integration tests (spec Vol II Domain Q,
 * #798–807, #816–820). Every route is exercised at least once, both scheduler
 * jobs are run on demand, the segregation-of-duties refusals are asserted,
 * and a second company is shown to see nothing.
 */

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
/** a second admin in the owner's company — the "other person" every SoD rule needs */
let admin2: TestActor;
let admin2Headers: Record<string, string>;
/** a company member with read-only rights on ONE project */
let viewer: TestActor;
let viewerHeaders: Record<string, string>;
/** a different company altogether */
let stranger: TestActor;

let ukProject: string;
let ieProject: string;
let noCountryProject: string;
let periodProject: string;
let sweepProject: string;
let permProject: string;

let subA: string; // registered + verified CIS subcontractor
let subB: string; // no registrations at all
let overseas: string; // Irish supplier

const T = todayISO();
const d = (daysAgo: number): string => addDaysISO(T, -daysAgo);

function get(url: string, headers: Record<string, string> = owner.headers) {
  return app.inject({ method: "GET", url: `/api/v1${url}`, headers });
}
function post(url: string, payload?: unknown, headers: Record<string, string> = owner.headers) {
  return app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload: payload ?? {} });
}
function put(url: string, payload: unknown, headers: Record<string, string> = owner.headers) {
  return app.inject({ method: "PUT", url: `/api/v1${url}`, headers, payload });
}
function patch(url: string, payload: unknown, headers: Record<string, string> = owner.headers) {
  return app.inject({ method: "PATCH", url: `/api/v1${url}`, headers, payload });
}
function del(url: string, headers: Record<string, string> = owner.headers) {
  return app.inject({ method: "DELETE", url: `/api/v1${url}`, headers });
}

async function makeProject(name: string, country: string | null, currency = "GBP"): Promise<string> {
  const id = newId("prj");
  await app.db.insert(projects).values({ id, companyId: owner.companyId, name, country, currency });
  return id;
}

let commitmentSeq = 100;
async function makeCommitment(projectId: string, vendorId: string, status = "approved"): Promise<string> {
  const id = newId("cmt");
  commitmentSeq += 1;
  await app.db.insert(commitments).values({
    id,
    companyId: owner.companyId,
    projectId,
    kind: "subcontract",
    number: commitmentSeq,
    reference: `SC-${commitmentSeq}`,
    title: `Subcontract ${commitmentSeq}`,
    status,
    executed: status === "approved" ? 1 : 0,
    currency: "GBP",
    vendorId,
    originalCommitmentSum: 100000,
    revisedCommitmentSum: 100000,
    createdBy: owner.userId,
  } as typeof commitments.$inferInsert);
  return id;
}

let invoiceSeq = 500;
interface LineSpec {
  source: string;
  amount: number;
  description?: string;
  detail?: Record<string, unknown>;
}
async function makeInvoice(
  projectId: string,
  a: {
    kind?: "owner_billing" | "subcontractor_invoice";
    vendorId?: string | null;
    commitmentId?: string | null;
    status?: string;
    currency?: string;
    billingDate: string;
    subtotal: number;
    taxAmount: number;
    lines?: LineSpec[];
  },
): Promise<string> {
  const id = newId("inv");
  invoiceSeq += 1;
  await app.db.insert(invoices).values({
    id,
    companyId: owner.companyId,
    projectId,
    kind: a.kind ?? "subcontractor_invoice",
    number: invoiceSeq,
    reference: `INV-${invoiceSeq}`,
    status: a.status ?? "submitted",
    vendorId: a.vendorId ?? null,
    commitmentId: a.commitmentId ?? null,
    currency: a.currency ?? "GBP",
    billingDate: a.billingDate,
    subtotal: a.subtotal,
    taxAmount: a.taxAmount,
    total: a.subtotal + a.taxAmount,
    createdBy: owner.userId,
  } as typeof invoices.$inferInsert);
  let n = 0;
  for (const line of a.lines ?? []) {
    n += 1;
    await app.db.insert(invoiceLineItems).values({
      id: newId("inl"),
      companyId: owner.companyId,
      projectId,
      invoiceId: id,
      lineNumber: String(n),
      sortOrder: n,
      description: line.description ?? `Line ${n}`,
      source: line.source,
      amount: line.amount,
      detail: line.detail ?? {},
    } as typeof invoiceLineItems.$inferInsert);
  }
  return id;
}

async function signalsFor(detector: string, projectId: string | null) {
  const rows = await app.db
    .select()
    .from(signals)
    .where(and(eq(signals.companyId, owner.companyId), eq(signals.detector, detector)));
  return rows.filter((r) => r.projectId === projectId);
}

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  // app.ts registers every module; until the orchestrator adds the tax line
  // there, mount it here so the suite exercises the real plugin either way.
  if (!app.hasRoute({ method: "GET", url: "/api/v1/tax/regimes" })) {
    await app.register(taxModule, { prefix: "/api/v1" });
  }
  owner = await registerActor(app, { companyName: "Tax Test Co" });

  admin2 = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: admin2.userId,
    role: "admin",
  });
  admin2Headers = {
    authorization: admin2.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };

  viewer = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: viewer.userId,
    role: "member",
  });
  viewerHeaders = {
    authorization: viewer.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };

  stranger = await registerActor(app);

  ukProject = await makeProject("Tax — UK works", "GB");
  ieProject = await makeProject("Tax — Irish works", "IE", "EUR");
  noCountryProject = await makeProject("Tax — no country", null, "USD");
  periodProject = await makeProject("Tax — periods", "GB");
  sweepProject = await makeProject("Tax — sweeps", "GB");
  permProject = await makeProject("Tax — permissions", "GB");

  await app.db.insert(projectMemberships).values({
    id: newId("pm"),
    companyId: owner.companyId,
    projectId: permProject,
    userId: viewer.userId,
    templateKey: "read_only",
  });

  subA = newId("ven");
  subB = newId("ven");
  overseas = newId("ven");
  await app.db.insert(vendors).values([
    { id: subA, companyId: owner.companyId, name: "Brickwork Ltd", country: "GB", taxId: "1234567890" },
    { id: subB, companyId: owner.companyId, name: "Steelwork Ltd", country: "GB" },
    { id: overseas, companyId: owner.companyId, name: "Dublin Fitout Ltd", country: "IE" },
  ]);
});

afterAll(async () => {
  await built.close();
});

/* ================================================================== */
/* Regime library                                                      */
/* ================================================================== */

describe("regime library", () => {
  it("lists every regime with a cited summary and serves a full definition", async () => {
    const res = await get("/tax/regimes");
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ regime: string; standardRate: number; summary: string }>; total: number };
    expect(body.total).toBe(TAX_REGIMES.length);
    const uk = body.items.find((r) => r.regime === "uk")!;
    expect(uk.standardRate).toBe(20);
    expect(uk.summary.length).toBeGreaterThan(60);

    const def = await get("/tax/regimes/uk");
    expect(def.statusCode).toBe(200);
    expect(def.json().indirectTax.standardRate).toBe(20);
    expect(def.json().withholding.certificateName).toBe("CIS payment and deduction statement");

    expect((await get("/tax/regimes/xx")).statusCode).toBe(404);
    const unauth = await app.inject({ method: "GET", url: "/api/v1/tax/regimes" });
    expect(unauth.statusCode).toBe(401);
  });
});

/* ================================================================== */
/* Registrations                                                       */
/* ================================================================== */

describe("registrations (#800–801)", () => {
  let cisRegId: string;

  it("requires a holder for vendor registrations and resolves the vendor's name", async () => {
    const missing = await post("/tax/registrations", { holderType: "vendor", regime: "uk", kind: "vat" });
    expect(missing.statusCode).toBe(400);

    const vat = await post("/tax/registrations", {
      holderType: "vendor",
      holderId: subA,
      regime: "uk",
      kind: "vat",
      number: "GB123456789",
    });
    expect(vat.statusCode).toBe(201);
    expect(vat.json().holderName).toBe("Brickwork Ltd");
    expect(vat.json().country).toBe("GB");
    expect(vat.json().verificationStatus).toBe("unverified");

    const cis = await post("/tax/registrations", {
      holderType: "vendor",
      holderId: subA,
      regime: "uk",
      kind: "cis",
      number: "1234567890",
    });
    expect(cis.statusCode).toBe(201);
    cisRegId = cis.json().id as string;

    const company = await post("/tax/registrations", { holderType: "company", regime: "uk", kind: "cis", number: "CIS-CONTRACTOR" });
    expect(company.statusCode).toBe(201);
    expect(company.json().holderName).toBe("This company");
    expect(company.json().holderId).toBeNull();

    const unknownVendor = await post("/tax/registrations", { holderType: "vendor", holderId: "ven_nope", regime: "uk", kind: "vat" });
    expect(unknownVendor.statusCode).toBe(400);
  });

  it("refuses verification by the person who recorded the registration, and requires a CIS rate", async () => {
    const self = await post(`/tax/registrations/${cisRegId}/verify`, { outcome: "verified", deductionRate: 20 });
    expect(self.statusCode).toBe(403);

    const noRate = await post(`/tax/registrations/${cisRegId}/verify`, { outcome: "verified" }, admin2Headers);
    expect(noRate.statusCode).toBe(400);

    const ok = await post(
      `/tax/registrations/${cisRegId}/verify`,
      { outcome: "verified", deductionRate: 20, reference: "V1234567890" },
      admin2Headers,
    );
    expect(ok.statusCode).toBe(200);
    expect(ok.json().verificationStatus).toBe("verified");
    expect(ok.json().deductionRate).toBe(20);
    expect(ok.json().verifiedBy).toBe(admin2.userId);

    const ledger = await app.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.objectType, "tax_registration"), eq(ledgerEntries.objectId, cisRegId)));
    expect(ledger.some((l) => l.action === "state_change")).toBe(true);
  });

  it("resets a verification when the registered number changes", async () => {
    const reg = await post("/tax/registrations", { holderType: "vendor", holderId: subA, regime: "ie", kind: "rct", number: "IE111" });
    const id = reg.json().id as string;
    const verified = await post(`/tax/registrations/${id}/verify`, { outcome: "verified", deductionRate: 0 }, admin2Headers);
    expect(verified.json().verificationStatus).toBe("verified");

    const notes = await patch(`/tax/registrations/${id}`, { notes: "checked" });
    expect(notes.json().verificationStatus).toBe("verified");

    const renumbered = await patch(`/tax/registrations/${id}`, { number: "IE222" });
    expect(renumbered.statusCode).toBe(200);
    expect(renumbered.json().verificationStatus).toBe("unverified");
    expect(renumbered.json().deductionRate).toBeNull();

    const bad = await post("/tax/registrations", { holderType: "vendor", holderId: subA, regime: "uk", kind: "tin", validFrom: "2026-05-01", validTo: "2026-04-01" });
    expect(bad.statusCode).toBe(400);
  });

  it("lists with filters and search, serves a detail with the regime summary", async () => {
    const list = await get("/tax/registrations?holderType=vendor&kind=cis&regime=uk");
    expect(list.statusCode).toBe(200);
    expect(list.json().items.every((r: { kind: string }) => r.kind === "cis")).toBe(true);
    expect(list.json().total).toBeGreaterThanOrEqual(1);

    const search = await get("/tax/registrations?search=brick");
    expect(search.json().items.every((r: { holderName: string }) => /brick/i.test(r.holderName))).toBe(true);

    const detail = await get(`/tax/registrations/${cisRegId}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().regimeDef.regime).toBe("uk");
  });

  it("only an owner/admin deletes; a stranger sees nothing", async () => {
    const reg = await post("/tax/registrations", { holderType: "vendor", holderId: subB, regime: "sg", kind: "vat" });
    const id = reg.json().id as string;
    expect((await del(`/tax/registrations/${id}`, viewerHeaders)).statusCode).toBe(403);
    expect((await get(`/tax/registrations/${id}`, stranger.headers)).statusCode).toBe(404);
    expect((await get("/tax/registrations", stranger.headers)).json().total).toBe(0);
    expect((await del(`/tax/registrations/${id}`)).statusCode).toBe(204);
    expect((await get(`/tax/registrations/${id}`)).statusCode).toBe(404);
  });
});

/* ================================================================== */
/* Project profile                                                     */
/* ================================================================== */

describe("project tax profile", () => {
  it("derives the regime from the project country and says what it does not know", async () => {
    const uk = await get(`/projects/${ukProject}/tax/profile`);
    expect(uk.statusCode).toBe(200);
    expect(uk.json().profile).toBeNull();
    expect(uk.json().resolved.regime).toBe("uk");
    expect(uk.json().resolved.source).toBe("project_country");
    expect(uk.json().resolved.reasons.length).toBeGreaterThan(0);

    const none = await get(`/projects/${noCountryProject}/tax/profile`);
    expect(none.json().resolved.regime).toBeNull();
    expect(none.json().resolved.source).toBe("none");
    expect(none.json().regimeDef).toBeNull();
  });

  it("saves the tenant's position and re-resolves from it", async () => {
    const saved = await put(`/projects/${ukProject}/tax/profile`, {
      regime: "uk",
      customerVatRegistered: true,
      customerDeductionRegistered: true,
      endUser: false,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().resolved.source).toBe("profile");
    expect(saved.json().profile.currency).toBe("GBP");
    expect(saved.json().customerPosition.vatRegistered).toBe(true);
    expect(saved.json().customerPosition.deductionRegistered).toBe(true);

    const again = await put(`/projects/${ukProject}/tax/profile`, { regime: "uk", customerVatRegistered: true, customerDeductionRegistered: true, notes: "updated" });
    expect(again.json().profile.notes).toBe("updated");
    expect(again.json().profile.id).toBe(saved.json().profile.id);

    expect((await put(`/projects/${ukProject}/tax/profile`, { regime: "mars" })).statusCode).toBe(400);
    expect((await put(`/projects/${ukProject}/tax/profile`, { regime: "uk" }, viewerHeaders)).statusCode).toBe(403);
    expect([403, 404]).toContain((await get(`/projects/${ukProject}/tax/profile`, stranger.headers)).statusCode);
  });
});

/* ================================================================== */
/* Determination on demand                                             */
/* ================================================================== */

describe("determination on demand (#798–802, #804)", () => {
  let persistedId: string;

  it("applies the UK reverse charge and a verified 20% CIS deduction net of materials, with citations", async () => {
    const res = await post(`/projects/${ukProject}/tax/determine`, {
      amount: 10000,
      materialsAmount: 2000,
      vendorId: subA,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.regime).toBe("uk");
    expect(body.regimeSource).toBe("profile");
    expect(body.determination).toBeNull();
    const o = body.output;
    expect(o.vatTreatment).toBe("reverse_charge");
    expect(o.reverseCharge).toBe(true);
    expect(o.vatAmount).toBe(0);
    expect(o.selfAccountedVat).toBe(2000);
    expect(o.withholdingScheme).toBe("cis");
    expect(o.withholdingRate).toBe(20);
    expect(o.withholdingBaseAmount).toBe(8000);
    expect(o.withholdingAmount).toBe(1600);
    expect(o.netPayable).toBe(8400);
    expect(o.citations.length).toBeGreaterThanOrEqual(3);
    expect(o.citations.some((c: { element: string }) => c.element === "reverse_charge")).toBe(true);
    expect(o.confidence).toBe(1);
    expect(body.vendorRegistrations.length).toBeGreaterThanOrEqual(2);
  });

  it("persists a determination to the register with a ledger entry", async () => {
    const res = await post(`/projects/${ukProject}/tax/determine`, {
      amount: 10000,
      materialsAmount: 2000,
      vendorId: subA,
      persist: true,
      asOf: "2026-04-20",
    });
    expect(res.statusCode).toBe(201);
    const det = res.json().determination;
    expect(det.number).toBe(1);
    expect(det.status).toBe("determined");
    expect(det.sourceType).toBe("manual");
    expect(det.reverseCharge).toBe(true);
    expect(det.taxPointDate).toBe("2026-04-20");
    expect(det.vendorName).toBe("Brickwork Ltd");
    persistedId = det.id as string;

    const ledger = await app.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.objectType, "tax_determination"), eq(ledgerEntries.objectId, persistedId)));
    expect(ledger.length).toBe(1);
    expect(ledger[0]!.action).toBe("create");
  });

  it("refuses when no regime can be resolved, accepts an explicit one, and needs rules for `custom`", async () => {
    const none = await post(`/projects/${noCountryProject}/tax/determine`, { amount: 1000 });
    expect(none.statusCode).toBe(400);
    expect(none.json().message).toMatch(/profile/i);

    const sg = await post(`/projects/${noCountryProject}/tax/determine`, { amount: 1000, regime: "sg", currency: "SGD" });
    expect(sg.statusCode).toBe(200);
    expect(sg.json().regimeSource).toBe("explicit");
    expect(sg.json().output.vatRate).toBe(9);
    expect(sg.json().output.vatAmount).toBe(90);
    expect(sg.json().output.withholdingScheme).toBe("none");

    const custom = await post(`/projects/${noCountryProject}/tax/determine`, { amount: 1000, regime: "custom" });
    expect(custom.statusCode).toBe(400);

    const customOk = await post(`/projects/${noCountryProject}/tax/determine`, {
      amount: 1000,
      regime: "custom",
      currency: "USD",
      custom: { vatRate: 12, withholdingRate: 3, citation: "Tenant memo TX-1" },
    });
    expect(customOk.statusCode).toBe(200);
    expect(customOk.json().output.vatAmount).toBe(120);
    expect(customOk.json().output.withholdingAmount).toBe(30);
    expect(customOk.json().output.confidence).toBeLessThan(1);

    const bad = await post(`/projects/${ukProject}/tax/determine`, { amount: 100, materialsAmount: 200 });
    expect(bad.statusCode).toBe(400);
  });

  it("treats an Irish supplier on a UK project as cross-border", async () => {
    const res = await post(`/projects/${ukProject}/tax/determine`, {
      amount: 5000,
      vendorId: overseas,
      supplyType: "professional_services",
      contractType: "consultancy",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().output.vatTreatment).toBe("reverse_charge_import");
    expect(res.json().output.selfAccountedVat).toBe(1000);
  });

  it("is gated: a read-only member and a stranger cannot determine", async () => {
    expect((await post(`/projects/${permProject}/tax/determine`, { amount: 1 }, viewerHeaders)).statusCode).toBe(403);
    expect([403, 404]).toContain((await post(`/projects/${ukProject}/tax/determine`, { amount: 1 }, stranger.headers)).statusCode);
  });

  describe("register, overrides and certificates built on the persisted determination", () => {
    let overrideId: string;
    let certificateId: string;

    it("lists and details determinations with their chain", async () => {
      const list = await get(`/projects/${ukProject}/tax/determinations`);
      expect(list.statusCode).toBe(200);
      expect(list.json().total).toBe(1);
      expect(list.json().items[0].id).toBe(persistedId);

      const detail = await get(`/projects/${ukProject}/tax/determinations/${persistedId}`);
      expect(detail.statusCode).toBe(200);
      expect(detail.json().chain).toEqual([]);
      expect(detail.json().regimeDef.regime).toBe("uk");
      expect(detail.json().citations.length).toBeGreaterThan(0);

      expect((await get(`/projects/${ieProject}/tax/determinations/${persistedId}`)).statusCode).toBe(404);
    });

    it("overrides by writing a new record and pointing the original at it (#802)", async () => {
      const short = await post(`/projects/${ukProject}/tax/determinations/${persistedId}/override`, { withholdingRate: 0, reason: "short" });
      expect(short.statusCode).toBe(400);

      const res = await post(`/projects/${ukProject}/tax/determinations/${persistedId}/override`, {
        withholdingRate: 0,
        reason: "HMRC verification V1234567890 returned gross payment status on 2026-04-21.",
        citation: "FA 2004 s 63 (gross payment status)",
      });
      expect(res.statusCode).toBe(201);
      const ov = res.json();
      overrideId = ov.id as string;
      expect(ov.status).toBe("determined");
      expect(ov.overridesId).toBe(persistedId);
      expect(ov.withholdingAmount).toBe(0);
      expect(ov.netPayable).toBe(10000);
      expect(ov.reverseCharge).toBe(true);
      expect(ov.selfAccountedVat).toBe(2000);
      expect(ov.number).toBe(2);

      const original = await get(`/projects/${ukProject}/tax/determinations/${persistedId}`);
      expect(original.json().status).toBe("overridden");
      expect(original.json().overriddenById).toBe(overrideId);
      expect(original.json().chain.map((c: { id: string }) => c.id)).toContain(overrideId);

      const again = await post(`/projects/${ukProject}/tax/determinations/${persistedId}/override`, { withholdingRate: 0, reason: "trying to override an overridden record" });
      expect(again.statusCode).toBe(409);

      const list = await get(`/projects/${ukProject}/tax/determinations?status=overridden`);
      expect(list.json().items.map((i: { id: string }) => i.id)).toEqual([persistedId]);
    });

    it("drafts a withholding certificate from a determination and refuses a zero deduction", async () => {
      const zero = await post(`/projects/${ukProject}/tax/withholding-certificates`, { determinationId: overrideId, paymentDate: "2026-04-25" });
      expect(zero.statusCode).toBe(400);

      const res = await post(`/projects/${ukProject}/tax/withholding-certificates`, {
        determinationId: persistedId,
        paymentDate: "2026-04-25",
        paymentId: "pay_manual_1",
      });
      expect(res.statusCode).toBe(201);
      const c = res.json();
      certificateId = c.id as string;
      expect(c.status).toBe("draft");
      expect(c.scheme).toBe("cis");
      expect(c.grossAmount).toBe(10000);
      expect(c.materialsAmount).toBe(2000);
      expect(c.baseAmount).toBe(8000);
      expect(c.rate).toBe(20);
      expect(c.withheldAmount).toBe(1600);
      expect(c.netPaid).toBe(8400);
      expect(c.vendorName).toBe("Brickwork Ltd");

      const dup = await post(`/projects/${ukProject}/tax/withholding-certificates`, { determinationId: persistedId, paymentDate: "2026-04-25", paymentId: "pay_manual_1" });
      expect(dup.statusCode).toBe(409);

      const noRegime = await post(`/projects/${ukProject}/tax/withholding-certificates`, { paymentDate: "2026-04-25", vendorName: "X" });
      expect(noRegime.statusCode).toBe(400);
    });

    it("issues only through a second person and assigns a printed reference", async () => {
      const self = await post(`/projects/${ukProject}/tax/withholding-certificates/${certificateId}/issue`);
      expect(self.statusCode).toBe(403);

      const issued = await post(`/projects/${ukProject}/tax/withholding-certificates/${certificateId}/issue`, {}, admin2Headers);
      expect(issued.statusCode).toBe(200);
      expect(issued.json().status).toBe("issued");
      expect(issued.json().reference).toBe("CIS-2026-04-0001");
      expect(issued.json().issuedBy).toBe(admin2.userId);

      const again = await post(`/projects/${ukProject}/tax/withholding-certificates/${certificateId}/issue`, {}, admin2Headers);
      expect(again.statusCode).toBe(409);

      const detail = await get(`/projects/${ukProject}/tax/withholding-certificates/${certificateId}`);
      expect(detail.json().certificateName).toBe("CIS payment and deduction statement");

      const ledger = await app.db
        .select()
        .from(ledgerEntries)
        .where(and(eq(ledgerEntries.objectType, "withholding_certificate"), eq(ledgerEntries.objectId, certificateId)));
      expect(ledger.map((l) => l.action).sort()).toEqual(["create", "state_change"]);
    });

    it("filters the certificate register by payment date in SQL and cancels with a reason", async () => {
      const other = await post(`/projects/${ukProject}/tax/withholding-certificates`, {
        regime: "uk",
        scheme: "cis",
        vendorName: "Cash Labour Co",
        paymentDate: "2026-06-10",
        currency: "GBP",
        grossAmount: 1000,
        rate: 30,
      });
      expect(other.statusCode).toBe(201);
      expect(other.json().withheldAmount).toBe(300);

      const inApril = await get(`/projects/${ukProject}/tax/withholding-certificates?from=2026-04-01&to=2026-04-30`);
      expect(inApril.json().total).toBe(1);
      expect(inApril.json().items[0].id).toBe(certificateId);
      const inJune = await get(`/projects/${ukProject}/tax/withholding-certificates?from=2026-06-01&pageSize=1`);
      expect(inJune.json().total).toBe(1);
      expect(inJune.json().items[0].id).toBe(other.json().id);

      const cancelled = await post(`/projects/${ukProject}/tax/withholding-certificates/${other.json().id}/cancel`, { reason: "duplicate entry" });
      expect(cancelled.json().status).toBe("cancelled");
      expect(cancelled.json().cancelReason).toBe("duplicate entry");
      expect((await post(`/projects/${ukProject}/tax/withholding-certificates/${other.json().id}/cancel`, { reason: "again" })).statusCode).toBe(409);

      const byStatus = await get(`/projects/${ukProject}/tax/withholding-certificates?status=cancelled`);
      expect(byStatus.json().total).toBe(1);
    });
  });
});

/* ================================================================== */
/* Bulk determination for an invoice                                   */
/* ================================================================== */

describe("invoice bulk determination (#799, #818)", () => {
  let invoiceId: string;

  it("determines each billable line, skips non-supplies, checks the invoice's own tax figure and raises a signal", async () => {
    const commitmentId = await makeCommitment(ukProject, subA);
    invoiceId = await makeInvoice(ukProject, {
      vendorId: subA,
      commitmentId,
      billingDate: "2026-05-10",
      subtotal: 8000,
      taxAmount: 2000,
      lines: [
        { source: "contract_sov", amount: 6000, description: "Brickwork to GF" },
        { source: "stored_materials", amount: 2000, description: "Bricks on site" },
        { source: "tax", amount: 2000, description: "VAT @ 20%" },
        { source: "credit", amount: -500, description: "Credit" },
      ],
    });
    const res = await post(`/projects/${ukProject}/tax/invoices/${invoiceId}/determine`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.determined).toBe(2);
    expect(body.skipped).toBe(2);
    const works = body.lines[0];
    expect(works.output.reverseCharge).toBe(true);
    expect(works.output.withholdingAmount).toBe(1200);
    const materials = body.lines[1];
    expect(materials.output.vatTreatment).toBe("standard");
    expect(materials.output.vatAmount).toBe(400);
    expect(materials.output.withholdingScheme).toBe("none");
    expect(body.totals).toEqual({ amount: 8000, vatAmount: 400, selfAccountedVat: 1200, withholdingAmount: 1200, leviesAmount: 0, netPayable: 7200 });
    expect(body.check.invoiceTax).toBe(2000);
    expect(body.check.mismatch).toBe(1600);
    expect(body.risks.map((r: { detector: string }) => r.detector)).toContain("tax_reverse_charge_misapplied");
    expect(body.risks[0].raised).toBe(true);

    const sigs = await signalsFor("tax_reverse_charge_misapplied", ukProject);
    expect(sigs.length).toBe(1);
    expect(sigs[0]!.severity).toBe("high");

    const register = await get(`/projects/${ukProject}/tax/determinations?sourceType=invoice_line&sourceId=${invoiceId}`);
    expect(register.json().total).toBe(2);
    expect(register.json().items.every((i: { taxPointDate: string }) => i.taxPointDate === "2026-05-10")).toBe(true);
  });

  it("re-running supersedes the previous line determinations and does not duplicate the signal", async () => {
    const res = await post(`/projects/${ukProject}/tax/invoices/${invoiceId}/determine`);
    expect(res.statusCode).toBe(200);
    expect(res.json().risks[0].raised).toBe(false);

    const current = await get(`/projects/${ukProject}/tax/determinations?sourceId=${invoiceId}`);
    expect(current.json().total).toBe(2);
    const all = await get(`/projects/${ukProject}/tax/determinations?sourceId=${invoiceId}&includeSuperseded=true`);
    expect(all.json().total).toBe(4);
    const superseded = all.json().items.filter((i: { status: string }) => i.status === "superseded");
    expect(superseded.length).toBe(2);
    expect(superseded.every((i: { supersededById: string | null }) => i.supersededById !== null)).toBe(true);
    expect((await signalsFor("tax_reverse_charge_misapplied", ukProject)).length).toBe(1);
  });

  it("does not flag a mixed invoice whose tax is exactly what its standard-rated lines may carry", async () => {
    const mixed = await makeInvoice(ukProject, {
      vendorId: subA,
      billingDate: "2026-05-12",
      subtotal: 8000,
      taxAmount: 400, // 20% on the 2,000 of materials only; the works line is reverse-charged
      lines: [
        { source: "contract_sov", amount: 6000 },
        { source: "stored_materials", amount: 2000 },
      ],
    });
    const res = await post(`/projects/${ukProject}/tax/invoices/${mixed}/determine`);
    expect(res.statusCode).toBe(200);
    expect(res.json().check.mismatch).toBe(0);
    expect(res.json().risks).toEqual([]);
    expect((await signalsFor("tax_reverse_charge_misapplied", ukProject)).length).toBe(1);
  });

  it("refuses owner billings and invoices from another project", async () => {
    const ob = await makeInvoice(ukProject, { kind: "owner_billing", billingDate: "2026-05-01", subtotal: 100, taxAmount: 20, status: "approved" });
    expect((await post(`/projects/${ukProject}/tax/invoices/${ob}/determine`)).statusCode).toBe(400);
    expect((await post(`/projects/${ieProject}/tax/invoices/${invoiceId}/determine`)).statusCode).toBe(404);
    expect((await post(`/projects/${ukProject}/tax/invoices/inv_nope/determine`)).statusCode).toBe(404);
  });
});

/* ================================================================== */
/* Periods and returns                                                 */
/* ================================================================== */

describe("periods and returns (#803)", () => {
  let cisPeriodId: string;
  let vatPeriodId: string;
  let overdueId: string;

  beforeAll(async () => {
    await put(`/projects/${periodProject}/tax/profile`, { regime: "uk", customerVatRegistered: true, customerDeductionRegistered: true });
  });

  it("derives the period end and due dates from the regime library and opens an obligation", async () => {
    const res = await post(`/projects/${periodProject}/tax/periods`, { returnKind: "cis_monthly", periodStart: "2026-04-06" });
    expect(res.statusCode).toBe(201);
    const p = res.json();
    cisPeriodId = p.id as string;
    expect(p.periodEnd).toBe("2026-05-05");
    expect(p.dueDate).toBe("2026-05-19");
    expect(p.paymentDueDate).toBe("2026-05-22");
    expect(p.currency).toBe("GBP");
    expect(p.status).toBe("open");
    expect(p.outputTax).toBeNull();
    expect(p.withheldTotal).toBeNull();
    expect(p.returnDef.kind).toBe("cis_monthly");

    const [obl] = await app.db.select().from(obligations).where(eq(obligations.id, p.obligationId as string));
    expect(obl?.status).toBe("open");
    expect(obl?.deadline?.slice(0, 10)).toBe("2026-05-19");

    expect((await post(`/projects/${periodProject}/tax/periods`, { returnKind: "cis_monthly", periodStart: "2026-04-06" })).statusCode).toBe(409);
    expect((await post(`/projects/${periodProject}/tax/periods`, { returnKind: "tds", periodStart: "2026-04-01" })).statusCode).toBe(400);
    const explicit = await post(`/projects/${periodProject}/tax/periods`, { returnKind: "tds", periodStart: "2026-04-01", periodEnd: "2026-04-30", dueDate: "2026-05-07" });
    expect(explicit.statusCode).toBe(201);
    expect((await post(`/projects/${periodProject}/tax/periods`, { returnKind: "vat", periodStart: "2026-04-01", periodEnd: "2026-03-01" })).statusCode).toBe(400);
  });

  it("aggregates a deduction period from issued certificates in the window, bucketed by currency", async () => {
    const gbp = await post(`/projects/${periodProject}/tax/withholding-certificates`, {
      regime: "uk", scheme: "cis", vendorId: subA, paymentDate: "2026-04-20", currency: "GBP", grossAmount: 8000, rate: 20,
    });
    expect(gbp.statusCode).toBe(201);
    await post(`/projects/${periodProject}/tax/withholding-certificates/${gbp.json().id}/issue`, {}, admin2Headers);
    const usd = await post(`/projects/${periodProject}/tax/withholding-certificates`, {
      regime: "uk", scheme: "cis", vendorName: "Dollar Sub", paymentDate: "2026-04-21", currency: "USD", grossAmount: 1000, rate: 20,
    });
    await post(`/projects/${periodProject}/tax/withholding-certificates/${usd.json().id}/issue`, {}, admin2Headers);
    const draft = await post(`/projects/${periodProject}/tax/withholding-certificates`, {
      regime: "uk", scheme: "cis", vendorName: "Draft Sub", paymentDate: "2026-04-22", currency: "GBP", grossAmount: 1000, rate: 20,
    });
    expect(draft.json().status).toBe("draft");
    const outside = await post(`/projects/${periodProject}/tax/withholding-certificates`, {
      regime: "uk", scheme: "cis", vendorName: "May Sub", paymentDate: "2026-05-20", currency: "GBP", grossAmount: 1000, rate: 20,
    });
    await post(`/projects/${periodProject}/tax/withholding-certificates/${outside.json().id}/issue`, {}, admin2Headers);

    const computed = await post(`/projects/${periodProject}/tax/periods/${cisPeriodId}/compute`);
    expect(computed.statusCode).toBe(200);
    expect(computed.json().withheldTotal).toBe(1600);
    expect(computed.json().certificateCount).toBe(1);
    expect(computed.json().excludedCount).toBe(1);
    expect(computed.json().netPayable).toBe(1600);
    expect(computed.json().outputTax).toBeNull();
    expect(computed.json().computedAt).not.toBeNull();
    expect(computed.json().computeBasis.currency).toBe("GBP");

    const detail = await get(`/projects/${periodProject}/tax/periods/${cisPeriodId}`);
    expect(detail.json().live.withheldTotal).toBe(1600);
    expect(detail.json().obligation.status).toBe("open");
  });

  it("aggregates a VAT quarter: output tax from owner billings + self-accounted VAT, input tax from determinations at their tax point", async () => {
    const res = await post(`/projects/${periodProject}/tax/periods`, { returnKind: "vat", periodStart: "2026-07-01" });
    expect(res.statusCode).toBe(201);
    vatPeriodId = res.json().id as string;
    expect(res.json().periodEnd).toBe("2026-09-30");
    expect(res.json().dueDate).toBe("2026-11-06");

    const commitmentId = await makeCommitment(periodProject, subA);
    const inv = await makeInvoice(periodProject, {
      vendorId: subA, commitmentId, billingDate: "2026-08-10", subtotal: 6000, taxAmount: 0,
      lines: [{ source: "contract_sov", amount: 6000 }],
    });
    const run = await post(`/projects/${periodProject}/tax/invoices/${inv}/determine`);
    expect(run.json().totals.selfAccountedVat).toBe(1200);
    expect(run.json().risks.length).toBe(0);
    // an invoice with a tax point outside the quarter must not count
    const early = await makeInvoice(periodProject, {
      vendorId: subA, commitmentId, billingDate: "2026-06-10", subtotal: 1000, taxAmount: 0,
      lines: [{ source: "contract_sov", amount: 1000 }],
    });
    await post(`/projects/${periodProject}/tax/invoices/${early}/determine`);

    await makeInvoice(periodProject, { kind: "owner_billing", status: "approved", billingDate: "2026-08-15", subtotal: 20000, taxAmount: 4000 });
    await makeInvoice(periodProject, { kind: "owner_billing", status: "draft", billingDate: "2026-08-16", subtotal: 5000, taxAmount: 1000 });
    await makeInvoice(periodProject, { kind: "owner_billing", status: "approved", currency: "USD", billingDate: "2026-08-17", subtotal: 5000, taxAmount: 1000 });

    const computed = await post(`/projects/${periodProject}/tax/periods/${vatPeriodId}/compute`);
    expect(computed.statusCode).toBe(200);
    expect(computed.json().outputTax).toBe(5200);
    expect(computed.json().inputTax).toBe(1200);
    expect(computed.json().selfAccountedTax).toBe(1200);
    expect(computed.json().netPayable).toBe(4000);
    expect(computed.json().determinationCount).toBe(1);
    expect(computed.json().excludedCount).toBe(1);
    expect(computed.json().computeBasis.ownerBillings).toBe(1);
  });

  it("files only after computing, satisfies the obligation, and marks paid only once filed", async () => {
    const list = await get(`/projects/${periodProject}/tax/periods?returnKind=cis_monthly`);
    expect(list.json().total).toBe(1);
    expect(typeof list.json().items[0].daysToDue).toBe("number");

    expect((await post(`/projects/${periodProject}/tax/periods/${cisPeriodId}/mark-paid`)).statusCode).toBe(409);

    const unfiled = await post(`/projects/${periodProject}/tax/periods`, { returnKind: "cis_monthly", periodStart: "2026-05-06" });
    expect((await post(`/projects/${periodProject}/tax/periods/${unfiled.json().id}/file`, { filingReference: "X" })).statusCode).toBe(400);

    const filed = await post(`/projects/${periodProject}/tax/periods/${cisPeriodId}/file`, { filingReference: "CIS300-2026-04", filedAt: "2026-05-15T10:00:00Z" });
    expect(filed.statusCode).toBe(200);
    expect(filed.json().status).toBe("filed");
    expect(filed.json().filingReference).toBe("CIS300-2026-04");
    const [obl] = await app.db.select().from(obligations).where(eq(obligations.id, filed.json().obligationId as string));
    expect(obl?.status).toBe("satisfied");
    expect((await post(`/projects/${periodProject}/tax/periods/${cisPeriodId}/file`, { filingReference: "again" })).statusCode).toBe(409);

    const paid = await post(`/projects/${periodProject}/tax/periods/${cisPeriodId}/mark-paid`, { paidAt: "2026-05-20T10:00:00Z" });
    expect(paid.json().status).toBe("paid");
    expect(paid.json().paidBy).toBe(owner.userId);
    expect((await get(`/projects/${periodProject}/tax/periods/${cisPeriodId}`, viewerHeaders)).statusCode).toBe(403);
    expect((await get(`/projects/${ieProject}/tax/periods/${cisPeriodId}`)).statusCode).toBe(404);
  });

  it("the scheduled sweep flips an unfiled period past its due date to overdue, breaches the obligation and raises one signal", async () => {
    const res = await post(`/projects/${periodProject}/tax/periods`, {
      returnKind: "cis_monthly", periodStart: d(60), periodEnd: d(31), dueDate: d(10),
    });
    expect(res.statusCode).toBe(201);
    overdueId = res.json().id as string;

    const status = await app.scheduler.runNow("tax.risk-sweep");
    expect(status.state).toBe("succeeded");

    const [period] = await app.db.select().from(taxPeriods).where(eq(taxPeriods.id, overdueId));
    expect(period?.status).toBe("overdue");
    const [obl] = await app.db.select().from(obligations).where(eq(obligations.id, period!.obligationId!));
    expect(obl?.status).toBe("breached");
    // earlier fixtures on this project are also past due (their dates are in
    // the past on purpose), so assert on THIS period's signal and on the
    // sweep being idempotent overall.
    const forPeriod = (rows: Awaited<ReturnType<typeof signalsFor>>) =>
      rows.filter((r) => (r.evidenceRefs as { periodId?: string }).periodId === overdueId);
    const sigs = await signalsFor("tax_return_overdue", periodProject);
    expect(forPeriod(sigs).length).toBe(1);
    expect(forPeriod(sigs)[0]!.severity).toBe("high");
    const notes = await app.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, owner.userId), eq(notifications.kind, "tax"), eq(notifications.recordId, overdueId)));
    expect(notes.length).toBe(1);

    await app.scheduler.runNow("tax.risk-sweep");
    expect((await signalsFor("tax_return_overdue", periodProject)).length).toBe(sigs.length);

    // late filing still satisfies the (breached) obligation, and the ledger says it was late
    await post(`/projects/${periodProject}/tax/periods/${overdueId}/compute`);
    const filed = await post(`/projects/${periodProject}/tax/periods/${overdueId}/file`, { filingReference: "LATE-1" });
    expect(filed.json().status).toBe("filed");
    const [after] = await app.db.select().from(obligations).where(eq(obligations.id, period!.obligationId!));
    expect(after?.status).toBe("satisfied");
    const ledger = await app.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.objectType, "tax_period"), eq(ledgerEntries.objectId, overdueId)));
    expect(ledger.some((l) => l.action === "state_change" && l.actorId === null)).toBe(true);

    const summary = await get(`/projects/${periodProject}/tax/summary`);
    expect(summary.json().periods.filed).toBeGreaterThanOrEqual(2);
  });
});

/* ================================================================== */
/* Permanent establishment                                             */
/* ================================================================== */

describe("permanent-establishment exposure (#806–807)", () => {
  let personId: string;
  let siteId: string;

  it("creates exposures with the regime's thresholds and basis", async () => {
    const person = await post(`/projects/${ukProject}/tax/pe-exposures`, {
      entityType: "person", entityName: "A. Sharma", homeCountry: "IN",
    });
    expect(person.statusCode).toBe(201);
    personId = person.json().id as string;
    expect(person.json().hostCountry).toBe("GB");
    expect(person.json().regime).toBe("uk");
    expect(person.json().thresholdDays).toBe(183);
    expect(person.json().windowMonths).toBe(12);
    expect(person.json().status).toBe("monitoring");
    expect(person.json().thresholdBasis).toMatch(/183 days/);

    const site = await post(`/projects/${ukProject}/tax/pe-exposures`, {
      entityType: "vendor", entityId: overseas, entityName: "Dublin Fitout Ltd", homeCountry: "IE",
    });
    expect(site.statusCode).toBe(201);
    siteId = site.json().id as string;
    expect(site.json().thresholdDays).toBe(365);
    expect(site.json().windowMonths).toBe(0);

    const noRegime = await post(`/projects/${noCountryProject}/tax/pe-exposures`, { entityType: "person", entityName: "X", homeCountry: "US" });
    expect(noRegime.statusCode).toBe(400);
    const explicit = await post(`/projects/${noCountryProject}/tax/pe-exposures`, { entityType: "person", entityName: "X", homeCountry: "US", hostCountry: "SG", regime: "sg", thresholdDays: 90, thresholdBasis: "Treaty art 14" });
    expect(explicit.statusCode).toBe(201);
    expect(explicit.json().thresholdDays).toBe(90);
  });

  it("counts merged presence days inside the rolling window and escalates through approaching to breached with signals", async () => {
    const a = await post(`/projects/${ukProject}/tax/pe-exposures/${personId}/entries`, { startDate: d(240), endDate: d(151), purpose: "Mobilisation" });
    expect(a.statusCode).toBe(201);
    expect(a.json().entry.days).toBe(90);
    expect(a.json().exposure.daysInWindow).toBe(90);
    expect(a.json().exposure.status).toBe("monitoring");

    const b = await post(`/projects/${ukProject}/tax/pe-exposures/${personId}/entries`, { startDate: d(165), endDate: d(121), source: "travel" });
    expect(b.json().exposure.daysInWindow).toBe(120); // overlap not double-counted
    expect(b.json().exposure.status).toBe("monitoring");

    const bad = await post(`/projects/${ukProject}/tax/pe-exposures/${personId}/entries`, { startDate: d(10), endDate: d(20) });
    expect(bad.statusCode).toBe(400);

    const c = await post(`/projects/${ukProject}/tax/pe-exposures/${personId}/entries`, { startDate: d(120), endDate: d(90) });
    expect(c.json().exposure.daysInWindow).toBe(151);
    expect(c.json().exposure.status).toBe("approaching");
    expect(c.json().exposure.projectedBreachDate).not.toBeNull();
    expect(c.json().exposure.projectedBreachDate > T).toBe(true);
    let sigs = await signalsFor("tax_pe_threshold", ukProject);
    expect(sigs.length).toBe(1);
    expect(sigs[0]!.severity).toBe("high");
    const notes = await app.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, owner.userId), eq(notifications.kind, "tax"), eq(notifications.recordId, personId)));
    expect(notes.length).toBe(1);

    const dd = await post(`/projects/${ukProject}/tax/pe-exposures/${personId}/entries`, { startDate: d(89), endDate: d(45) });
    expect(dd.json().exposure.daysInWindow).toBe(196);
    expect(dd.json().exposure.status).toBe("breached");
    expect(dd.json().exposure.projectedBreachDate).toBeNull();
    sigs = await signalsFor("tax_pe_threshold", ukProject);
    expect(sigs.length).toBe(2);
    expect(sigs.some((s) => s.severity === "critical")).toBe(true);

    const detail = await get(`/projects/${ukProject}/tax/pe-exposures/${personId}`);
    expect(detail.json().entries.length).toBe(4);
    expect(detail.json().percentOfThreshold).toBeGreaterThan(100);
    expect(detail.json().daysTotal).toBe(196);

    const list = await get(`/projects/${ukProject}/tax/pe-exposures?status=breached`);
    expect(list.json().items.map((e: { id: string }) => e.id)).toEqual([personId]);
  });

  it("removing an entry recomputes; a changed threshold needs a stated basis", async () => {
    const detail = await get(`/projects/${ukProject}/tax/pe-exposures/${personId}`);
    const last = detail.json().entries.find((e: { days: number }) => e.days === 45) as { id: string };
    const removed = await del(`/projects/${ukProject}/tax/pe-exposures/${personId}/entries/${last.id}`);
    expect(removed.statusCode).toBe(200);
    expect(removed.json().daysInWindow).toBe(151);
    expect(removed.json().status).toBe("approaching");
    expect((await del(`/projects/${ukProject}/tax/pe-exposures/${personId}/entries/pep_nope`)).statusCode).toBe(404);

    expect((await patch(`/projects/${ukProject}/tax/pe-exposures/${personId}`, { thresholdDays: 120 })).statusCode).toBe(400);
    const patched = await patch(`/projects/${ukProject}/tax/pe-exposures/${personId}`, { thresholdDays: 120, thresholdBasis: "UK–India DTC art 5(2)(k): 90 days in any 12-month period" });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().thresholdDays).toBe(120);
    expect(patched.json().status).toBe("breached");
  });

  it("mitigation and closure are sticky human dispositions; a closed exposure refuses entries", async () => {
    const mitigated = await post(`/projects/${ukProject}/tax/pe-exposures/${siteId}/mitigate`, { note: "Site supervision moved to the local subsidiary" });
    expect(mitigated.json().status).toBe("mitigated");
    const entry = await post(`/projects/${ukProject}/tax/pe-exposures/${siteId}/entries`, { startDate: d(30), endDate: d(1) });
    expect(entry.json().exposure.status).toBe("mitigated");

    const closed = await post(`/projects/${ukProject}/tax/pe-exposures/${siteId}/close`, { reason: "Entity withdrew from the project" });
    expect(closed.json().status).toBe("closed");
    expect((await post(`/projects/${ukProject}/tax/pe-exposures/${siteId}/entries`, { startDate: d(3), endDate: d(1) })).statusCode).toBe(409);
    expect((await post(`/projects/${ukProject}/tax/pe-exposures/${siteId}/mitigate`, { note: "too late now" })).statusCode).toBe(409);
    expect((await post(`/projects/${ukProject}/tax/pe-exposures/${siteId}/close`, { reason: "again" })).statusCode).toBe(409);

    const job = await app.scheduler.runNow("tax.pe-exposure");
    expect(job.state).toBe("succeeded");
    const after = await get(`/projects/${ukProject}/tax/pe-exposures/${siteId}`);
    expect(after.json().status).toBe("closed");
    expect([403, 404]).toContain((await get(`/projects/${ukProject}/tax/pe-exposures/${personId}`, stranger.headers)).statusCode);
  });
});

/* ================================================================== */
/* Risk sweeps                                                         */
/* ================================================================== */

describe("tax risk sweeps and signals", () => {
  let sweepInvoice: string;

  beforeAll(async () => {
    await put(`/projects/${sweepProject}/tax/profile`, { regime: "uk", customerVatRegistered: true, customerDeductionRegistered: true });
    await makeCommitment(sweepProject, subA);
    await makeCommitment(sweepProject, subB);
    await makeCommitment(sweepProject, overseas, "draft"); // not paying yet: must not be flagged
  });

  it("flags a paying vendor with no registration and clears the signal once one is recorded", async () => {
    const coverage = await get(`/projects/${sweepProject}/tax/vendors`);
    expect(coverage.statusCode).toBe(200);
    expect(coverage.json().regime).toBe("uk");
    const rowB = coverage.json().items.find((v: { id: string }) => v.id === subB);
    const rowA = coverage.json().items.find((v: { id: string }) => v.id === subA);
    expect(rowB.covered).toBe(false);
    expect(rowA.covered).toBe(true);
    expect(rowA.verified).toBe(true);

    const status = await app.scheduler.runNow("tax.risk-sweep");
    expect(status.state).toBe("succeeded");
    let sigs = await signalsFor("tax_missing_registration", sweepProject);
    expect(sigs.length).toBe(1);
    expect((sigs[0]!.evidenceRefs as { vendorId: string }).vendorId).toBe(subB);

    const risks = await get(`/projects/${sweepProject}/tax/risks`);
    expect(risks.json().items.some((s: { detector: string }) => s.detector === "tax_missing_registration")).toBe(true);

    await post("/tax/registrations", { holderType: "vendor", holderId: subB, regime: "uk", kind: "vat", number: "GB999" });
    await app.scheduler.runNow("tax.risk-sweep");
    sigs = await signalsFor("tax_missing_registration", sweepProject);
    expect(sigs.length).toBe(1);
    expect(sigs[0]!.disposition).toBe("closed");
    const open = await get(`/projects/${sweepProject}/tax/risks`);
    expect(open.json().items.some((s: { detector: string }) => s.detector === "tax_missing_registration")).toBe(false);
    const all = await get(`/projects/${sweepProject}/tax/risks?includeClosed=true`);
    expect(all.json().items.some((s: { detector: string }) => s.detector === "tax_missing_registration")).toBe(true);
  });

  it("flags a payment issued without a deduction certificate when the vendor's current determination requires one", async () => {
    const [cmt] = await app.db
      .select({ id: commitments.id })
      .from(commitments)
      .where(and(eq(commitments.projectId, sweepProject), eq(commitments.vendorId, subA)));
    sweepInvoice = await makeInvoice(sweepProject, {
      vendorId: subA, commitmentId: cmt!.id, billingDate: d(20), subtotal: 6000, taxAmount: 0,
      lines: [{ source: "contract_sov", amount: 6000 }],
    });
    const run = await post(`/projects/${sweepProject}/tax/invoices/${sweepInvoice}/determine`);
    expect(run.json().totals.withholdingAmount).toBe(1200);
    expect(run.json().risks.length).toBe(0);

    const paymentId = newId("pay");
    await app.db.insert(commitmentPayments).values({
      id: paymentId,
      companyId: owner.companyId,
      projectId: sweepProject,
      commitmentId: cmt!.id,
      invoiceId: sweepInvoice,
      vendorId: subA,
      number: 1,
      reference: "PAY-001",
      status: "issued",
      amount: 6000,
      currency: "GBP",
      paymentDate: d(10),
      createdBy: owner.userId,
    } as typeof commitmentPayments.$inferInsert);

    await app.scheduler.runNow("tax.risk-sweep");
    const sigs = await signalsFor("tax_wht_not_deducted", sweepProject);
    expect(sigs.length).toBe(1);
    expect((sigs[0]!.evidenceRefs as { paymentId: string }).paymentId).toBe(paymentId);

    // a certificate against the payment: no further signal on the next sweep
    const cert = await post(`/projects/${sweepProject}/tax/withholding-certificates`, {
      determinationId: run.json().lines[0].determinationId, paymentId, paymentDate: d(10),
    });
    expect(cert.statusCode).toBe(201);
    await app.scheduler.runNow("tax.risk-sweep");
    expect((await signalsFor("tax_wht_not_deducted", sweepProject)).length).toBe(1);
  });

  it("catches an invoice that started charging VAT after its reverse-charge determination ran", async () => {
    expect((await signalsFor("tax_reverse_charge_misapplied", sweepProject)).length).toBe(0);
    await app.db.update(invoices).set({ taxAmount: 500, total: 6500 }).where(eq(invoices.id, sweepInvoice));
    await app.scheduler.runNow("tax.risk-sweep");
    const sigs = await signalsFor("tax_reverse_charge_misapplied", sweepProject);
    expect(sigs.length).toBe(1);
    expect((sigs[0]!.evidenceRefs as { invoiceId: string }).invoiceId).toBe(sweepInvoice);
    await app.scheduler.runNow("tax.risk-sweep");
    expect((await signalsFor("tax_reverse_charge_misapplied", sweepProject)).length).toBe(1);
  });

  it("expires a CIS verification after two tax years and raises a company-level signal", async () => {
    const regId = newId("txr");
    await app.db.insert(taxRegistrations).values({
      id: regId,
      companyId: owner.companyId,
      holderType: "entity",
      holderId: "ent_old",
      holderName: "Old Groundworks",
      regime: "uk",
      kind: "cis",
      status: "active",
      verificationStatus: "verified",
      verifiedAt: new Date(Date.now() - 800 * 86_400_000).toISOString(),
      verifiedBy: admin2.userId,
      deductionRate: 20,
      createdBy: owner.userId,
    });
    await app.scheduler.runNow("tax.risk-sweep");
    const [reg] = await app.db.select().from(taxRegistrations).where(eq(taxRegistrations.id, regId));
    expect(reg?.verificationStatus).toBe("expired");
    const sigs = await signalsFor("tax_verification_expired", null);
    expect(sigs.length).toBe(1);
    const company = await get("/tax/company-signals");
    expect(company.statusCode).toBe(200);
    expect(company.json().items.some((s: { detector: string }) => s.detector === "tax_verification_expired")).toBe(true);
    expect((await get("/tax/company-signals", stranger.headers)).json().total).toBe(0);
  });

  it("runs the whole scan on demand and reports what it did", async () => {
    const res = await post(`/projects/${sweepProject}/tax/risks/scan`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    for (const k of ["overduePeriods", "verificationsExpired", "missingRegistrations", "whtNotDeducted", "reverseChargeMisapplied", "signalsRaised", "peRecomputed"]) {
      expect(typeof body[k]).toBe("number");
    }
    expect(typeof body.ranAt).toBe("string");
    expect((await post(`/projects/${permProject}/tax/risks/scan`, {}, viewerHeaders)).statusCode).toBe(403);
  });
});

/* ================================================================== */
/* Summary, health inputs, permissions                                 */
/* ================================================================== */

describe("summary, health inputs and access", () => {
  it("summarises without summing across currencies and exposes health inputs", async () => {
    const s = await get(`/projects/${ukProject}/tax/summary`);
    expect(s.statusCode).toBe(200);
    const body = s.json();
    expect(body.regime).toBe("uk");
    expect(body.determinations.overridden).toBe(1);
    expect(body.byCurrency.every((b: { currency: string }) => typeof b.currency === "string")).toBe(true);
    expect(body.certificates.issued).toBeGreaterThanOrEqual(1);
    expect(body.peExposures.total).toBe(2);
    expect(body.openRiskSignals).toBeGreaterThanOrEqual(1);

    const h = await get(`/projects/${ukProject}/tax/health-inputs`);
    expect(h.statusCode).toBe(200);
    expect(h.json().metrics.regimeResolved).toBe(1);
    expect(h.json().metrics.determinationsOverridden).toBe(1);
    expect(typeof h.json().metrics.openTaxRiskSignals).toBe("number");
    expect(Array.isArray(h.json().reasons)).toBe(true);

    const empty = await get(`/projects/${noCountryProject}/tax/health-inputs`);
    expect(empty.json().metrics.regimeResolved).toBe(0);
    expect(empty.json().reasons.length).toBeGreaterThan(0);
  });

  it("a read-only member reads its project and nothing else; a stranger is shut out", async () => {
    expect((await get(`/projects/${permProject}/tax/summary`, viewerHeaders)).statusCode).toBe(200);
    expect((await get(`/projects/${permProject}/tax/determinations`, viewerHeaders)).statusCode).toBe(200);
    expect((await get(`/projects/${permProject}/tax/pe-exposures`, viewerHeaders)).statusCode).toBe(200);
    expect((await get(`/projects/${ukProject}/tax/summary`, viewerHeaders)).statusCode).toBe(403);
    expect((await post(`/projects/${permProject}/tax/periods`, { returnKind: "vat", periodStart: "2026-01-01" }, viewerHeaders)).statusCode).toBe(403);
    expect((await post(`/projects/${permProject}/tax/pe-exposures`, { entityType: "person", entityName: "X", homeCountry: "US" }, viewerHeaders)).statusCode).toBe(403);

    for (const url of [
      `/projects/${ukProject}/tax/summary`,
      `/projects/${ukProject}/tax/determinations`,
      `/projects/${ukProject}/tax/withholding-certificates`,
      `/projects/${ukProject}/tax/periods`,
      `/projects/${ukProject}/tax/risks`,
      `/projects/${ukProject}/tax/vendors`,
    ]) {
      expect([403, 404]).toContain((await get(url, stranger.headers)).statusCode);
    }
    expect((await app.inject({ method: "GET", url: `/api/v1/projects/${ukProject}/tax/summary` })).statusCode).toBe(401);
  });
});
