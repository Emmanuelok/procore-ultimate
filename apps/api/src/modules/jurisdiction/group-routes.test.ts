/**
 * Integration tests for the jurisdiction group / consolidation / ICV routes
 * and every jurisdiction audit bug this package fixed:
 *
 *  - FX register writable by a company guest
 *  - contractual quotes standing in for the "market" rate, hiding exposure
 *  - the exposure statement valuing a foreign-currency contract sum as
 *    though it were in the configuration's base currency
 *  - the permit status route accepting any transition
 *  - permit fileIds / ownerId stored with no tenant validation
 *  - permit + obligation created outside a transaction
 *  - read-time sweeps duplicating signals
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  companyMemberships,
  contracts,
  files,
  ledgerEntries,
  obligations,
  permits,
  projects,
  scheduleTasks,
  signals,
  users,
  vendors,
  workers,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO, todayISO } from "../field/dates.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let stranger: TestActor;

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  stranger = await registerActor(app);
});

afterAll(async () => {
  await built.close();
});

async function makeProject(name: string, actor: TestActor = owner): Promise<string> {
  const id = newId("prj");
  await app.db.insert(projects).values({ id, companyId: actor.companyId, name });
  return id;
}

async function makeTask(pid: string, name: string, startDate: string | null, extra: Record<string, unknown> = {}) {
  const id = newId("tsk");
  await app.db.insert(scheduleTasks).values({
    id,
    projectId: pid,
    name,
    durationDays: 10,
    startDate,
    ...extra,
  });
  return id;
}

/** A guest member of the owner's company — the lowest role that exists. */
async function makeGuest(): Promise<Record<string, string>> {
  const guest = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("mem"),
    companyId: owner.companyId,
    userId: guest.userId,
    role: "guest",
  });
  return { authorization: guest.headers["authorization"]!, "x-company-id": owner.companyId };
}

async function postRate(payload: Record<string, unknown>, headers = owner.headers) {
  return app.inject({ method: "POST", url: "/api/v1/fx-rates", headers, payload });
}

/* ================================================================== */
/* AUDIT BUG: FX register writable by a company guest                  */
/* ================================================================== */

describe("FX register write gate", () => {
  it("refuses a guest, who could otherwise move the rate every certificate uses", async () => {
    const guest = await makeGuest();
    const res = await postRate(
      {
        fromCurrency: "EUR",
        toCurrency: "USD",
        rate: 9.99,
        rateDate: todayISO(),
        source: "manual",
      },
      guest,
    );
    expect(res.statusCode).toBe(403);
  });

  it("still lets a guest READ the register", async () => {
    const guest = await makeGuest();
    const res = await app.inject({ method: "GET", url: "/api/v1/fx-rates", headers: guest });
    expect(res.statusCode).toBe(200);
  });

  it("allows an owner to write", async () => {
    const res = await postRate({
      fromCurrency: "GBP",
      toCurrency: "USD",
      rate: 1.27,
      rateDate: todayISO(),
      source: "central_bank",
    });
    expect(res.statusCode).toBe(201);
  });
});

/* ================================================================== */
/* AUDIT BUG: a contractual quote answering "what is the market rate?" */
/* ================================================================== */

describe("market rate selection excludes contractual quotes (#599)", () => {
  async function makeConfig(pid: string, contractId: string | null, baseCurrency = "USD") {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/currency-configs`,
      headers: owner.headers,
      payload: {
        contractId,
        baseCurrency,
        baseDate: addDaysISO(todayISO(), -180),
        portions: [
          { currency: baseCurrency, proportionPercent: 50, baseRate: 1 },
          { currency: "EUR", proportionPercent: 50, baseRate: 0.9 },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string };
  }

  it("does not let a contractual rate report zero exposure", async () => {
    const pid = await makeProject("FX exposure");
    // the register carries BOTH: the contractual base-date rate and a real
    // market rate that has moved a long way since
    await postRate({
      fromCurrency: "USD",
      toCurrency: "EUR",
      rate: 0.9,
      rateDate: addDaysISO(todayISO(), -180),
      source: "contractual",
    });
    await postRate({
      fromCurrency: "USD",
      toCurrency: "EUR",
      rate: 0.72,
      rateDate: todayISO(),
      source: "central_bank",
    });
    const config = await makeConfig(pid, null);
    const split = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/currency-configs/${config.id}/split`,
      headers: owner.headers,
      payload: { amount: 1_000_000 },
    });
    expect(split.statusCode).toBe(200);
    const body = split.json() as {
      lines: { currency: string; marketRate: number | null; marketRateSource: string | null; fxVariance: number | null }[];
    };
    const eur = body.lines.find((l) => l.currency === "EUR")!;
    expect(eur.marketRateSource).toBe("central_bank");
    expect(eur.marketRate).toBe(0.72);
    // 500,000 base at contractual 0.9 = 450,000 EUR; at market 0.72 = 360,000
    expect(eur.fxVariance).toBe(-90_000);
  });

  it("leaves a portion unpriced when the ONLY quote is contractual", async () => {
    const pid = await makeProject("FX only contractual");
    await postRate({
      fromCurrency: "USD",
      toCurrency: "CHF",
      rate: 0.88,
      rateDate: addDaysISO(todayISO(), -180),
      source: "contractual",
    });
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/currency-configs`,
      headers: owner.headers,
      payload: {
        baseCurrency: "USD",
        baseDate: addDaysISO(todayISO(), -180),
        portions: [
          { currency: "USD", proportionPercent: 50, baseRate: 1 },
          { currency: "CHF", proportionPercent: 50, baseRate: 0.88 },
        ],
      },
    });
    const config = created.json() as { id: string };
    const split = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/currency-configs/${config.id}/split`,
      headers: owner.headers,
      payload: { amount: 100_000 },
    });
    const body = split.json() as {
      lines: { currency: string; marketRate: number | null }[];
      totals: { missingRates: string[] };
    };
    // the contractual quote must NOT masquerade as the market: unpriced,
    // with the currency named, is the honest answer
    expect(body.lines.find((l) => l.currency === "CHF")!.marketRate).toBeNull();
    expect(body.totals.missingRates).toContain("CHF");
  });
});

/* ================================================================== */
/* AUDIT BUG: exposure valued a foreign contract sum as base currency  */
/* ================================================================== */

describe("exposure statement contract currency", () => {
  async function makeContract(pid: string, currency: string, contractSum: number) {
    const id = newId("ctr");
    await app.db.insert(contracts).values({
      id,
      companyId: owner.companyId,
      projectId: pid,
      name: `${currency} works contract`,
      form: "fidic_red",
      currency,
      contractSum,
      createdBy: owner.userId,
    });
    return id;
  }

  it("converts the contract sum into the base currency and says it did", async () => {
    const pid = await makeProject("Exposure conversion");
    const baseDate = addDaysISO(todayISO(), -180);
    await postRate({
      fromCurrency: "EUR",
      toCurrency: "USD",
      rate: 1.1,
      rateDate: baseDate,
      source: "central_bank",
    });
    const contractId = await makeContract(pid, "EUR", 12_000_000);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/currency-configs`,
      headers: owner.headers,
      payload: {
        contractId,
        baseCurrency: "USD",
        baseDate,
        portions: [{ currency: "USD", proportionPercent: 100, baseRate: 1 }],
      },
    });
    expect(created.statusCode).toBe(201);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/fx/exposure`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const item = (
      res.json() as {
        items: {
          contractCurrency: string | null;
          conversionRate: number | null;
          contractSum: number | null;
          notes: string[];
        }[];
      }
    ).items[0]!;
    expect(item.contractCurrency).toBe("EUR");
    expect(item.conversionRate).toBe(1.1);
    expect(item.contractSum).toBe(13_200_000);
    expect(item.notes.join(" ")).toContain("denominated in EUR");
  });

  it("leaves the item UNPRICED when no conversion rate exists, rather than mis-stating it", async () => {
    const pid = await makeProject("Exposure unpriced");
    const baseDate = addDaysISO(todayISO(), -180);
    const contractId = await makeContract(pid, "JPY", 900_000_000);
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/currency-configs`,
      headers: owner.headers,
      payload: {
        contractId,
        baseCurrency: "USD",
        baseDate,
        portions: [{ currency: "USD", proportionPercent: 100, baseRate: 1 }],
      },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/fx/exposure`,
      headers: owner.headers,
    });
    const body = res.json() as {
      items: { contractSum: number | null; contractualValue: number | null; notes: string[] }[];
      unpriced: number;
    };
    expect(body.items[0]!.contractSum).toBeNull();
    expect(body.items[0]!.contractualValue).toBeNull();
    expect(body.items[0]!.notes.join(" ")).toContain("as though it were");
    expect(body.unpriced).toBe(1);
  });

  it("leaves a same-currency contract untouched", async () => {
    const pid = await makeProject("Exposure same currency");
    const contractId = await makeContract(pid, "USD", 5_000_000);
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/currency-configs`,
      headers: owner.headers,
      payload: {
        contractId,
        baseCurrency: "USD",
        baseDate: addDaysISO(todayISO(), -30),
        portions: [{ currency: "USD", proportionPercent: 100, baseRate: 1 }],
      },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/fx/exposure`,
      headers: owner.headers,
    });
    const item = (
      res.json() as { items: { contractSum: number; conversionRate: number | null }[] }
    ).items[0]!;
    expect(item.contractSum).toBe(5_000_000);
    expect(item.conversionRate).toBeNull();
  });
});

/* ================================================================== */
/* AUDIT BUG: permit status route accepted any transition              */
/* ================================================================== */

describe("permit state machine", () => {
  async function makePermit(pid: string, extra: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/permits`,
      headers: owner.headers,
      payload: {
        kind: "environmental",
        title: "Discharge consent",
        authority: "Environment Agency",
        appliedAt: todayISO(),
        expectedDays: 56,
        ...extra,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; status: string; obligationId: string | null };
  }

  it("refuses granted → applied, which used to freeze the overdue sweep", async () => {
    const pid = await makeProject("Permit ladder");
    const permit = await makePermit(pid);
    const granted = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/permits/${permit.id}/status`,
      headers: owner.headers,
      payload: { status: "granted", expiresAt: addDaysISO(todayISO(), 365) },
    });
    expect(granted.statusCode).toBe(200);
    const back = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/permits/${permit.id}/status`,
      headers: owner.headers,
      payload: { status: "applied" },
    });
    expect(back.statusCode).toBe(400);
    expect(back.json().message).toContain("cannot move to applied");
  });

  it("refuses not_started → expired, the lapse of a consent never granted", async () => {
    const pid = await makeProject("Permit expire without grant");
    const permit = await makePermit(pid, { appliedAt: null, expectedDays: null });
    expect(permit.status).toBe("not_started");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/permits/${permit.id}/status`,
      headers: owner.headers,
      payload: { status: "expired" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("opens a FRESH determination clock on re-application after a refusal", async () => {
    const pid = await makeProject("Permit re-application");
    const permit = await makePermit(pid);
    const refused = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/permits/${permit.id}/status`,
      headers: owner.headers,
      payload: { status: "refused" },
    });
    expect(refused.statusCode).toBe(200);
    const reapplied = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/permits/${permit.id}/status`,
      headers: owner.headers,
      payload: { status: "applied" },
    });
    expect(reapplied.statusCode).toBe(200);
    const body = reapplied.json() as {
      status: string;
      appliedAt: string;
      grantedAt: string | null;
      obligationId: string;
      dueAt: string;
    };
    expect(body.status).toBe("applied");
    expect(body.grantedAt).toBeNull();
    expect(body.appliedAt).toBe(todayISO());
    expect(body.dueAt).toBe(addDaysISO(todayISO(), 56));
    // a NEW obligation, not the discharged one
    expect(body.obligationId).not.toBe(permit.obligationId);
    const [fresh] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, body.obligationId));
    expect(fresh!.status).toBe("open");
    expect(fresh!.trigger).toContain("Re-application");
  });

  it("returns allowedTransitions so the UI can drive its buttons", async () => {
    const pid = await makeProject("Permit transitions");
    const permit = await makePermit(pid);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/permits/${permit.id}`,
      headers: owner.headers,
    });
    const body = res.json() as { allowedTransitions: string[] };
    expect(body.allowedTransitions).toEqual(["in_review", "granted", "refused"]);
  });

  it("refuses a no-op transition", async () => {
    const pid = await makeProject("Permit no-op");
    const permit = await makePermit(pid);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/permits/${permit.id}/status`,
      headers: owner.headers,
      payload: { status: "applied" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("already applied");
  });
});

/* ================================================================== */
/* AUDIT BUG: permit fileIds / ownerId stored unvalidated              */
/* ================================================================== */

describe("permit referential validation", () => {
  it("refuses a file id from another tenant", async () => {
    const pid = await makeProject("Permit files");
    const foreignProject = await makeProject("Foreign", stranger);
    const foreignFile = newId("fil");
    await app.db.insert(files).values({
      id: foreignFile,
      companyId: stranger.companyId,
      projectId: foreignProject,
      name: "secret.pdf",
      contentType: "application/pdf",
      sizeBytes: 10,
      storageKey: `k/${foreignFile}`,
      checksum: "abc",
      uploadedBy: stranger.userId,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/permits`,
      headers: owner.headers,
      payload: {
        kind: "planning",
        title: "Planning permission",
        authority: "Council",
        fileIds: [foreignFile],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("fileIds");
  });

  it("refuses an owner who is not a member of the company", async () => {
    const pid = await makeProject("Permit owner");
    const outsider = newId("usr");
    await app.db.insert(users).values({
      id: outsider,
      email: `${outsider}@nowhere.test`,
      name: "Outsider",
      passwordHash: "x",
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/permits`,
      headers: owner.headers,
      payload: {
        kind: "planning",
        title: "Planning permission",
        authority: "Council",
        ownerId: outsider,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("ownerId");
  });

  it("accepts a file in the same project and a member owner", async () => {
    const pid = await makeProject("Permit valid refs");
    const fileId = newId("fil");
    await app.db.insert(files).values({
      id: fileId,
      companyId: owner.companyId,
      projectId: pid,
      name: "application.pdf",
      contentType: "application/pdf",
      sizeBytes: 10,
      storageKey: `k/${fileId}`,
      checksum: "abc",
      uploadedBy: owner.userId,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/permits`,
      headers: owner.headers,
      payload: {
        kind: "planning",
        title: "Planning permission",
        authority: "Council",
        fileIds: [fileId],
        ownerId: owner.userId,
      },
    });
    expect(res.statusCode).toBe(201);
  });
});

/* ================================================================== */
/* AUDIT BUG: permit + obligation created outside a transaction        */
/* ================================================================== */

describe("permit creation is atomic", () => {
  it("leaves no orphan obligation when creation fails", async () => {
    const pid = await makeProject("Permit atomicity");
    const before = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.projectId, pid));
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/permits`,
      headers: owner.headers,
      payload: {
        kind: "planning",
        title: "Planning permission",
        authority: "Council",
        appliedAt: todayISO(),
        expectedDays: 56,
        blockingTaskIds: ["tsk_does_not_exist"],
      },
    });
    expect(res.statusCode).toBe(400);
    const after = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.projectId, pid));
    expect(after.length).toBe(before.length);
    const created = await app.db.select().from(permits).where(eq(permits.projectId, pid));
    expect(created).toHaveLength(0);
  });
});

/* ================================================================== */
/* AUDIT BUG: read-time sweeps duplicated signals                      */
/* ================================================================== */

describe("jurisdiction detectors run from the scheduler", () => {
  it("writes nothing on parallel workspace reads", async () => {
    const pid = await makeProject("Jurisdiction parallel reads");
    const task = await makeTask(pid, "Discharge works", addDaysISO(todayISO(), 5));
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/permits`,
      headers: owner.headers,
      payload: {
        kind: "environmental",
        title: "Consent",
        authority: "EA",
        blockingTaskIds: [task],
      },
    });
    await Promise.all([
      app.inject({
        method: "GET",
        url: `/api/v1/projects/${pid}/permits`,
        headers: owner.headers,
      }),
      app.inject({
        method: "GET",
        url: `/api/v1/projects/${pid}/permits/schedule-risk`,
        headers: owner.headers,
      }),
    ]);
    const rows = await app.db.select().from(signals).where(eq(signals.projectId, pid));
    expect(rows).toHaveLength(0);
  });

  it("raises the determination-overdue finding exactly once, as the system", async () => {
    const pid = await makeProject("Permit overdue");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/permits`,
      headers: owner.headers,
      payload: {
        kind: "environmental",
        title: "Overdue consent",
        authority: "EA",
        appliedAt: addDaysISO(todayISO(), -100),
        expectedDays: 56,
      },
    });
    const permit = res.json() as { id: string; obligationId: string };
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/jurisdiction/detectors/run`,
      headers: owner.headers,
    });
    expect(first.statusCode).toBe(200);
    expect((first.json() as { raised: number }).raised).toBeGreaterThan(0);
    const second = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/jurisdiction/detectors/run`,
      headers: owner.headers,
    });
    expect((second.json() as { raised: number }).raised).toBe(0);

    const rows = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.projectId, pid), eq(signals.detector, "permit_determination_overdue")),
      );
    expect(rows).toHaveLength(1);
    const [obl] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, permit.obligationId));
    expect(obl!.status).toBe("breached");

    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectType, "permit"),
          eq(ledgerEntries.action, "create"),
        ),
      );
    const systemRaised = entries.filter((e) => e.actorId === null);
    expect(systemRaised.length).toBeGreaterThan(0);
  });

  it("is registered with the platform scheduler", () => {
    expect(app.scheduler.has("jurisdiction.detectors")).toBe(true);
  });
});

/* ================================================================== */
/* Reporting entities & consolidation (#600-606)                       */
/* ================================================================== */

describe("reporting entities and consolidation", () => {
  async function makeEntity(payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/v1/reporting-entities",
      headers: owner.headers,
      payload: {
        country: "DE",
        functionalCurrency: "EUR",
        presentationCurrency: "USD",
        ...payload,
      },
    });
  }

  it("refuses a hyperinflationary entity with no price index", async () => {
    const res = await makeEntity({
      name: `Hyper ${newId("x")}`,
      country: "AR",
      functionalCurrency: "ARS",
      hyperinflationary: true,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("IAS 29");
  });

  it("refuses a duplicate name and a self-parent", async () => {
    const name = `OpCo ${newId("x")}`;
    const first = await makeEntity({ name });
    expect(first.statusCode).toBe(201);
    const dup = await makeEntity({ name });
    expect(dup.statusCode).toBe(409);
    const id = (first.json() as { id: string }).id;
    const self = await app.inject({
      method: "PATCH",
      url: `/api/v1/reporting-entities/${id}`,
      headers: owner.headers,
      payload: { parentEntityId: id },
    });
    expect(self.statusCode).toBe(400);
  });

  it("consolidates at the closing rate, restating IAS 29 entities first", async () => {
    const asOf = todayISO();
    await postRate({
      fromCurrency: "EUR",
      toCurrency: "USD",
      rate: 1.1,
      rateDate: asOf,
      source: "central_bank",
    });
    const opco = await makeEntity({ name: `OpCo DE ${newId("x")}`, ownershipPercent: 60 });
    const hyper = await makeEntity({
      name: `OpCo AR ${newId("x")}`,
      country: "AR",
      functionalCurrency: "EUR",
      hyperinflationary: true,
      priceIndex: [
        { period: "2025-01", index: 100 },
        { period: "2026-01", index: 300 },
      ],
    });
    expect(hyper.statusCode).toBe(201);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/consolidations",
      headers: owner.headers,
      payload: {
        asOf,
        presentationCurrency: "USD",
        method: "closing_rate",
        amounts: [
          { entityId: (opco.json() as { id: string }).id, amount: 1_000_000 },
          {
            entityId: (hyper.json() as { id: string }).id,
            amount: 500_000,
            amountPeriod: "2025-01",
          },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      lines: {
        entityId: string;
        groupShareAmount: number;
        restatementFactor: number;
        translatedAmount: number | null;
      }[];
      totals: { presentationTotal: number; ias29Entities: number };
    };
    const opcoLine = body.lines.find(
      (l) => l.entityId === (opco.json() as { id: string }).id,
    )!;
    expect(opcoLine.groupShareAmount).toBe(600_000);
    expect(opcoLine.translatedAmount).toBe(660_000);
    const hyperLine = body.lines.find(
      (l) => l.entityId === (hyper.json() as { id: string }).id,
    )!;
    expect(hyperLine.restatementFactor).toBe(3);
    expect(hyperLine.translatedAmount).toBe(1_650_000);
    expect(body.totals.ias29Entities).toBe(1);
  });

  it("EXCLUDES an entity with no rate rather than guessing, and says so", async () => {
    const asOf = todayISO();
    const entity = await makeEntity({
      name: `NGN Co ${newId("x")}`,
      country: "NG",
      functionalCurrency: "NGN",
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/consolidations",
      headers: owner.headers,
      payload: {
        asOf,
        presentationCurrency: "USD",
        amounts: [{ entityId: (entity.json() as { id: string }).id, amount: 1_000 }],
      },
    });
    const body = res.json() as {
      unpriced: { reason: string }[];
      totals: { presentationTotal: number; byFunctionalCurrency: { currency: string }[] };
    };
    expect(body.unpriced).toHaveLength(1);
    expect(body.unpriced[0]!.reason).toContain("guessed rate");
    expect(body.totals.presentationTotal).toBe(0);
    expect(body.totals.byFunctionalCurrency.map((b) => b.currency)).toContain("NGN");
  });

  it("links entities to a project with a share and reports whether it balances", async () => {
    const pid = await makeProject("JV shares");
    const a = await makeEntity({ name: `JV A ${newId("x")}` });
    const b = await makeEntity({ name: `JV B ${newId("x")}` });
    for (const [entity, share] of [
      [a, 60],
      [b, 40],
    ] as const) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/reporting-entities`,
        headers: owner.headers,
        payload: { entityId: (entity.json() as { id: string }).id, sharePercent: share },
      });
      expect(res.statusCode).toBe(201);
    }
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/reporting-entities`,
      headers: owner.headers,
    });
    const body = list.json() as { shareSum: number; shareBalanced: boolean; total: number };
    expect(body.total).toBe(2);
    expect(body.shareSum).toBe(100);
    expect(body.shareBalanced).toBe(true);
  });

  it("refuses a foreign tenant's entity list", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/reporting-entities",
      headers: stranger.headers,
    });
    // a different company sees its own (empty) register, never the owner's
    expect(res.statusCode).toBe(200);
    expect((res.json() as { total: number }).total).toBe(0);
  });

  it("refuses consolidation over an entity from another company", async () => {
    const mine = await makeEntity({ name: `Mine ${newId("x")}` });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/consolidations",
      headers: stranger.headers,
      payload: {
        presentationCurrency: "USD",
        amounts: [{ entityId: (mine.json() as { id: string }).id, amount: 1 }],
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

/* ================================================================== */
/* ICV certificates (#612-615)                                         */
/* ================================================================== */

describe("ICV certificate register", () => {
  async function makeCert(pid: string, extra: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/icv-certificates`,
      headers: owner.headers,
      payload: {
        entityName: "Gulf Contracting LLC",
        jurisdiction: "AE",
        issuer: "ADNOC ICV Certifier",
        certificateNumber: `ICV-${newId("x").slice(-6)}`,
        score: 41.2,
        issuedAt: addDaysISO(todayISO(), -300),
        expiresAt: addDaysISO(todayISO(), 30),
        ...extra,
      },
    });
  }

  it("opens an expiry obligation and warns ahead of the date", async () => {
    const pid = await makeProject("ICV");
    const res = await makeCert(pid);
    expect(res.statusCode).toBe(201);
    const cert = res.json() as { id: string; obligationId: string };
    expect(cert.obligationId).toBeTruthy();

    const run = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/jurisdiction/detectors/run`,
      headers: owner.headers,
    });
    expect(run.statusCode).toBe(200);
    const rows = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.projectId, pid), eq(signals.detector, "icv_certificate_expiring")),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.severity).toBe("medium");
  });

  it("flips to expired and breaches the obligation once the date passes", async () => {
    const pid = await makeProject("ICV expired");
    const res = await makeCert(pid, { expiresAt: addDaysISO(todayISO(), -1) });
    const cert = res.json() as { id: string; obligationId: string };
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/jurisdiction/detectors/run`,
      headers: owner.headers,
    });
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/icv-certificates`,
      headers: owner.headers,
    });
    const item = (list.json() as { items: { status: string; daysToExpiry: number }[] }).items[0]!;
    expect(item.status).toBe("expired");
    expect(item.daysToExpiry).toBe(-1);
    const [obl] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, cert.obligationId));
    expect(obl!.status).toBe("breached");
  });

  it("refuses a duplicate certificate number from the same issuer", async () => {
    const pid = await makeProject("ICV duplicate");
    const number = `ICV-${newId("x").slice(-6)}`;
    expect((await makeCert(pid, { certificateNumber: number })).statusCode).toBe(201);
    expect((await makeCert(pid, { certificateNumber: number })).statusCode).toBe(409);
  });

  it("refuses an expiry before the issue date and a foreign vendor", async () => {
    const pid = await makeProject("ICV guards");
    const bad = await makeCert(pid, { expiresAt: addDaysISO(todayISO(), -400) });
    expect(bad.statusCode).toBe(400);
    const foreignVendor = newId("ven");
    await app.db.insert(vendors).values({
      id: foreignVendor,
      companyId: stranger.companyId,
      name: "Foreign vendor",
    });
    const res = await makeCert(pid, { vendorId: foreignVendor });
    expect(res.statusCode).toBe(400);
  });

  it("supersedes a certificate and satisfies its obligation", async () => {
    const pid = await makeProject("ICV supersede");
    const oldCert = (await makeCert(pid)).json() as { id: string; obligationId: string };
    const newCert = (await makeCert(pid)).json() as { id: string };
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/icv-certificates/${oldCert.id}/status`,
      headers: owner.headers,
      payload: { status: "superseded", supersededById: newCert.id },
    });
    expect(res.statusCode).toBe(200);
    const [obl] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, oldCert.obligationId));
    expect(obl!.status).toBe("satisfied");
  });
});

/* ================================================================== */
/* Local content derivation and corrections (#612-613)                 */
/* ================================================================== */

describe("local content computation", () => {
  async function makeTarget(pid: string, extra: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/local-content-targets`,
      headers: owner.headers,
      payload: {
        name: "Nigerian content — headcount",
        jurisdiction: "Nigeria",
        metric: "local_headcount_percent",
        targetValue: 80,
        ...extra,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string };
  }

  it("derives a headcount reading from the worker register with the arithmetic recorded", async () => {
    const pid = await makeProject("Local content headcount");
    const target = await makeTarget(pid);
    for (const [i, nationality] of ["Nigeria", "Nigeria", "India"].entries()) {
      await app.db.insert(workers).values({
        id: newId("wkr"),
        companyId: owner.companyId,
        projectId: pid,
        reference: `W-${i}`,
        fullName: `Worker ${i}`,
        nationality,
      });
    }
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/local-content-targets/${target.id}/compute`,
      headers: owner.headers,
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      value: number;
      compliant: boolean;
      basis: string;
      inputs: Record<string, unknown>;
      committed: boolean;
    };
    expect(body.value).toBe(66.67);
    expect(body.compliant).toBe(false);
    expect(body.basis).toContain("2 of 3");
    expect(body.inputs["localWorkers"]).toBe(2);
    expect(body.committed).toBe(true);
  });

  it("previews without committing when asked", async () => {
    const pid = await makeProject("Local content preview");
    const target = await makeTarget(pid);
    await app.db.insert(workers).values({
      id: newId("wkr"),
      companyId: owner.companyId,
      projectId: pid,
      reference: "W-P",
      fullName: "Worker",
      nationality: "Nigeria",
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/local-content-targets/${target.id}/compute`,
      headers: owner.headers,
      payload: { commit: false },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { committed: boolean }).committed).toBe(false);
    const readings = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/local-content-targets/${target.id}/readings`,
      headers: owner.headers,
    });
    expect((readings.json() as { total: number }).total).toBe(0);
  });

  it("returns a REASON, not a zero, when there is nothing to measure", async () => {
    const pid = await makeProject("Local content empty");
    const target = await makeTarget(pid);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/local-content-targets/${target.id}/compute`,
      headers: owner.headers,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { value: number | null; unavailableReason: string };
    expect(body.value).toBeNull();
    expect(body.unavailableReason).toContain("No active workers");
  });

  it("refuses to compute a metric the platform does not derive", async () => {
    const pid = await makeProject("Local content ICV metric");
    const target = await makeTarget(pid, { metric: "icv_score", targetValue: 40 });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/local-content-targets/${target.id}/compute`,
      headers: owner.headers,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("not derivable");
  });

  it("supersedes a reading rather than editing it", async () => {
    const pid = await makeProject("Local content supersede");
    const target = await makeTarget(pid);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/local-content-targets/${target.id}/readings`,
      headers: owner.headers,
      payload: { readingDate: todayISO(), value: 50, basis: "Manual count" },
    });
    expect(created.statusCode).toBe(201);
    const reading = created.json() as { id: string };
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/local-content-readings/${reading.id}/supersede`,
      headers: owner.headers,
      payload: {
        readingDate: todayISO(),
        value: 85,
        basis: "Recount after payroll reconciliation",
        reason: "Original count omitted the night shift",
      },
    });
    expect(res.statusCode).toBe(201);
    const corrected = res.json() as { id: string; supersedesId: string; compliant: number };
    expect(corrected.supersedesId).toBe(reading.id);
    expect(corrected.compliant).toBe(1);

    // and superseding again is refused
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/local-content-readings/${reading.id}/supersede`,
      headers: owner.headers,
      payload: { readingDate: todayISO(), value: 1, basis: "x", reason: "y" },
    });
    expect(again.statusCode).toBe(409);

    // the summary uses only the live reading
    const summary = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/local-content/summary`,
      headers: owner.headers,
    });
    const body = summary.json() as {
      items: { value: number; compliant: boolean }[];
      breaching: number;
    };
    expect(body.items[0]!.value).toBe(85);
    expect(body.breaching).toBe(0);
  });

  it("refuses to delete a target with a measurement history", async () => {
    const pid = await makeProject("Local content delete");
    const target = await makeTarget(pid);
    const empty = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${pid}/local-content-targets/${target.id}`,
      headers: owner.headers,
    });
    expect(empty.statusCode).toBe(204);

    const withHistory = await makeTarget(pid, { name: "With history" });
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/local-content-targets/${withHistory.id}/readings`,
      headers: owner.headers,
      payload: { readingDate: todayISO(), value: 50 },
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${pid}/local-content-targets/${withHistory.id}`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("not deletable");
  });

  it("patches a target and ledgers before/after", async () => {
    const pid = await makeProject("Local content patch");
    const target = await makeTarget(pid);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/local-content-targets/${target.id}`,
      headers: owner.headers,
      payload: { targetValue: 90 },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { targetValue: number }).targetValue).toBe(90);
    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(eq(ledgerEntries.objectId, target.id), eq(ledgerEntries.action, "update")),
      );
    const payload = entries.at(-1)!.payload as { before: Record<string, unknown> };
    expect(payload.before["targetValue"]).toBe(80);
  });

  it("reports an unmeasured target as unknown, not compliant", async () => {
    const pid = await makeProject("Local content unmeasured");
    await makeTarget(pid);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/local-content/summary`,
      headers: owner.headers,
    });
    const body = res.json() as {
      items: { compliant: boolean | null; unavailableReason: string | null }[];
      compliancePercent: number | null;
    };
    expect(body.items[0]!.compliant).toBeNull();
    expect(body.items[0]!.unavailableReason).toContain("No reading");
    expect(body.compliancePercent).toBeNull();
  });
});

/* ================================================================== */
/* Cross-tenant isolation                                              */
/* ================================================================== */

describe("cross-tenant isolation across the new jurisdiction routes", () => {
  it("refuses every project route to a foreign tenant", async () => {
    const pid = await makeProject("Jurisdiction isolation");
    const routes = [
      `/api/v1/projects/${pid}/icv-certificates`,
      `/api/v1/projects/${pid}/local-content/summary`,
      `/api/v1/projects/${pid}/reporting-entities`,
      `/api/v1/projects/${pid}/jurisdiction/health-inputs`,
    ];
    for (const url of routes) {
      const res = await app.inject({ method: "GET", url, headers: stranger.headers });
      expect([403, 404], url).toContain(res.statusCode);
    }
  });

  it("exposes health inputs with reasons", async () => {
    const pid = await makeProject("Jurisdiction health inputs");
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/jurisdiction/health-inputs`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { metrics: Record<string, number | null>; reasons: string[] };
    expect(body.metrics["localContentTargets"]).toBe(0);
    expect(Array.isArray(body.reasons)).toBe(true);
  });
});
