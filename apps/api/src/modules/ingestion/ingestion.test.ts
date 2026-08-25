import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  companyMemberships,
  contracts,
  fxRates,
  ingestionRuns,
  ledgerEntries,
  paymentCertificates,
  projects,
  rfis,
  schedules,
  scheduleTasks,
  signals,
  siteAccessRecords,
  valuations,
  variations,
  vendors,
  workers,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { coerceRow, DATASET_REGISTRY, parseCsv } from "./datasets.js";
import {
  createFixtureHttpClient,
  mapAconexMail,
  mapAconexOrganization,
  mapProcoreRfi,
  mapProcoreVendor,
  ProcoreConnector,
} from "./connectors.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let outsider: TestActor;
let memberHeaders: Record<string, string>;
let csvSourceId: string;

const url = (p: string) => `/api/v1${p}`;

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  outsider = await registerActor(app);
  const member = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: member.userId,
    role: "member",
  });
  memberHeaders = {
    authorization: member.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };
  const res = await app.inject({
    method: "POST",
    url: url("/ingestion/sources"),
    headers: owner.headers,
    payload: { name: "Legacy spreadsheets", kind: "csv" },
  });
  expect(res.statusCode).toBe(201);
  csvSourceId = (res.json() as { id: string }).id;
});

afterAll(async () => {
  await built.close();
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

async function makeProject(name: string): Promise<string> {
  const id = newId("prj");
  await app.db.insert(projects).values({ id, companyId: owner.companyId, name });
  return id;
}

async function makeWorker(projectId: string, reference: string): Promise<string> {
  const id = newId("wkr");
  await app.db.insert(workers).values({
    id,
    companyId: owner.companyId,
    projectId,
    reference,
    fullName: `Worker ${reference}`,
    createdBy: owner.userId,
  });
  return id;
}

function csvUpload(
  csv: string,
  fields: Record<string, string>,
  filename = "data.csv",
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----vitestboundary";
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: text/csv\r\n\r\n`,
    ),
  );
  parts.push(Buffer.from(csv), Buffer.from(`\r\n--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

interface RunView {
  id: string;
  status: string;
  totalRows: number;
  stagedCount: number;
  committedCount: number;
  rejectedCount: number;
  skippedCount: number;
  fileSha256: string | null;
  report: unknown[];
  startedBy: string;
}

async function uploadRun(
  csv: string,
  fields: Record<string, string>,
): Promise<{ run: RunView; columns: string[]; preview: string[][] }> {
  const { payload, headers } = csvUpload(csv, fields);
  const res = await app.inject({
    method: "POST",
    url: url("/ingestion/runs"),
    headers: { ...owner.headers, ...headers },
    payload,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { run: RunView; columns: string[]; preview: string[][] };
}

async function mapRun(runId: string, columnMap: Record<string, string>) {
  return app.inject({
    method: "POST",
    url: url(`/ingestion/runs/${runId}/map`),
    headers: owner.headers,
    payload: { columnMap },
  });
}

async function validateRun(runId: string) {
  return app.inject({
    method: "POST",
    url: url(`/ingestion/runs/${runId}/validate`),
    headers: owner.headers,
  });
}

async function commitRun(runId: string) {
  return app.inject({
    method: "POST",
    url: url(`/ingestion/runs/${runId}/commit`),
    headers: owner.headers,
  });
}

async function createToken(scopes: string[], expiresAt?: string) {
  const res = await app.inject({
    method: "POST",
    url: url("/ingestion/tokens"),
    headers: owner.headers,
    payload: { name: `tok ${newId()}`, scopes, ...(expiresAt ? { expiresAt } : {}) },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; token: string; tokenPrefix: string };
}

async function push(dataset: string, token: string, body: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: url(`/ingestion/push/${dataset}`),
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

/* ------------------------------------------------------------------ */
/* CSV parser                                                          */
/* ------------------------------------------------------------------ */

describe("parseCsv", () => {
  it("handles quoted fields, escaped quotes, CRLF and embedded newlines", () => {
    const csv =
      'name,notes\r\n"Acme, Ltd","He said ""go"""\r\n"Multi\nline",plain\r\n';
    expect(parseCsv(csv)).toEqual([
      ["name", "notes"],
      ["Acme, Ltd", 'He said "go"'],
      ["Multi\nline", "plain"],
    ]);
  });

  it("strips a BOM, drops fully blank rows and survives a missing final newline", () => {
    const csv = "﻿a,b\n1,2\n\n,,\n3,4";
    expect(parseCsv(csv)).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* Registry coercion                                                   */
/* ------------------------------------------------------------------ */

describe("coerceRow", () => {
  it("reports every problem on a row, not just the first", () => {
    const { issues } = coerceRow(DATASET_REGISTRY.fx_rates, {
      toCurrency: "EUR",
      rate: "not-a-number",
      rateDate: "31/01/2026",
    });
    const codes = issues.map((i) => `${i.field}:${i.code}`).sort();
    expect(codes).toEqual([
      "fromCurrency:required_missing",
      "rate:type_invalid",
      "rateDate:type_invalid",
    ]);
  });

  it("coerces CSV strings to typed values and lower-cases enums", () => {
    const { value, issues } = coerceRow(DATASET_REGISTRY.site_access, {
      workerReference: " W-1 ",
      accessDate: "2026-02-03",
      hoursOnSite: "8.5",
      source: "Biometric",
    });
    expect(issues).toEqual([]);
    expect(value).toEqual({
      workerReference: "W-1",
      accessDate: "2026-02-03",
      hoursOnSite: 8.5,
      source: "biometric",
    });
  });

  it("runs cross-field checks: payroll arithmetic must add up", () => {
    const base = {
      workerReference: "W-1",
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      daysClaimed: "20",
      grossPay: "2000",
      deductions: "100",
      netPay: "1500",
    };
    const bad = coerceRow(DATASET_REGISTRY.payroll, base);
    expect(bad.issues).toHaveLength(1);
    expect(bad.issues[0]!.code).toBe("row_invalid");
    expect(bad.issues[0]!.message).toContain("netPay 1500");
    const good = coerceRow(DATASET_REGISTRY.payroll, { ...base, netPay: "1900" });
    expect(good.issues).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Connector mapping functions (fixture-backed)                        */
/* ------------------------------------------------------------------ */

describe("connector mappings", () => {
  it("maps Procore vendors and RFIs from recorded payload shapes", () => {
    expect(
      mapProcoreVendor({
        id: 42,
        name: "Steel Co",
        city: "Leeds",
        country_code: "GB",
        email_address: "hi@steel.co",
        trades: [{ name: "05 12 00" }, { name: "05 50 00" }],
      }),
    ).toEqual({
      name: "Steel Co",
      city: "Leeds",
      country: "GB",
      email: "hi@steel.co",
      tradeCodes: "05 12 00;05 50 00",
      externalId: "42",
    });
    expect(
      mapProcoreRfi({
        id: 7,
        subject: "Rebar clash",
        status: "Open",
        due_date: "2026-03-01",
        questions: [{ plain_text_body: "Which detail governs?" }],
      }),
    ).toEqual({
      subject: "Rebar clash",
      question: "Which detail governs?",
      status: "open",
      dueDate: "2026-03-01",
      externalId: "7",
    });
  });

  it("maps Aconex organizations and RFI mail", () => {
    expect(
      mapAconexOrganization({ OrganizationId: "org9", OrganizationName: "Pipes Pty", City: "Perth" }),
    ).toEqual({ name: "Pipes Pty", city: "Perth", externalId: "org9" });
    expect(
      mapAconexMail({ MailId: "m1", Subject: "RFI 12", Body: "Confirm invert level" }),
    ).toEqual({ subject: "RFI 12", question: "Confirm invert level", externalId: "m1" });
  });

  it("pulls through the injected HTTP client (fixture fake)", async () => {
    const http = createFixtureHttpClient({
      "/rest/v1.0/vendors?company_id=c1": [{ id: 1, name: "Alpha" }],
    });
    const connector = new ProcoreConnector(
      http,
      { baseUrl: "https://api.procore.example", procoreCompanyId: "c1" },
      "fake-token",
    );
    expect(await connector.pullVendors()).toEqual([{ name: "Alpha", externalId: "1" }]);
    // an unknown URL is a hard error, not silently empty
    const empty = new ProcoreConnector(
      createFixtureHttpClient({}),
      { baseUrl: "https://api.procore.example", procoreCompanyId: "c1" },
      "fake-token",
    );
    await expect(empty.pullVendors()).rejects.toThrow(/failed \(404\)/);
  });
});

/* ------------------------------------------------------------------ */
/* Sources, registry endpoint, gates                                   */
/* ------------------------------------------------------------------ */

describe("sources & dataset registry", () => {
  it("GET /ingestion/datasets describes all 8 datasets with typed fields", async () => {
    const res = await app.inject({
      method: "GET",
      url: url("/ingestion/datasets"),
      headers: memberHeaders, // reads are open to any company member
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      datasets: { dataset: string; fields: { key: string; required: boolean }[] }[];
    };
    expect(body.datasets.map((d) => d.dataset).sort()).toEqual([
      "cost_assertions",
      "evidence",
      "fx_rates",
      "payroll",
      "rfis",
      "schedule_tasks",
      "site_access",
      "vendors",
    ]);
    const vendorsDef = body.datasets.find((d) => d.dataset === "vendors")!;
    expect(vendorsDef.fields.find((f) => f.key === "name")!.required).toBe(true);
  });

  it("refuses credential-looking keys in source config, at any depth", async () => {
    const res = await app.inject({
      method: "POST",
      url: url("/ingestion/sources"),
      headers: owner.headers,
      payload: {
        name: "Procore",
        kind: "procore",
        config: { baseUrl: "https://api.procore.com", nested: { client_secret: "sssh" } },
      },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { message: string }).message).toContain("nested.client_secret");
  });

  it("mutations need owner/admin; reads work for a plain member", async () => {
    const write = await app.inject({
      method: "POST",
      url: url("/ingestion/sources"),
      headers: memberHeaders,
      payload: { name: "Nope", kind: "csv" },
    });
    expect(write.statusCode).toBe(403);
    const read = await app.inject({
      method: "GET",
      url: url("/ingestion/sources"),
      headers: memberHeaders,
    });
    expect(read.statusCode).toBe(200);
    expect((read.json() as { total: number }).total).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* Migration wizard                                                    */
/* ------------------------------------------------------------------ */

describe("CSV migration wizard", () => {
  it("upload → map → validate → commit lands real vendors with full provenance", async () => {
    const csv =
      "Vendor Name,Trades,Town,Ref\r\n" +
      '"Acme, Ltd","03 30 00; 03 45 00",Leeds,V-1\r\n' +
      "Beta Build,,York,V-2\r\n";
    const { run, columns, preview } = await uploadRun(csv, {
      sourceId: csvSourceId,
      dataset: "vendors",
    });
    expect(run.status).toBe("staging");
    expect(run.totalRows).toBe(2);
    expect(run.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(columns).toEqual(["Vendor Name", "Trades", "Town", "Ref"]);
    expect(preview).toHaveLength(2);
    expect(preview[0]).toEqual(["Acme, Ltd", "03 30 00; 03 45 00", "Leeds", "V-1"]);

    const mapped = await mapRun(run.id, {
      name: "Vendor Name",
      tradeCodes: "Trades",
      city: "Town",
      externalId: "Ref",
    });
    expect(mapped.statusCode).toBe(200);
    expect((mapped.json() as { staged: number }).staged).toBe(2);

    const validated = await validateRun(run.id);
    expect(validated.statusCode).toBe(200);
    const vrun = (validated.json() as { run: RunView }).run;
    expect(vrun.status).toBe("validated");
    expect(vrun.stagedCount).toBe(2);
    expect(vrun.rejectedCount).toBe(0);

    const committed = await commitRun(run.id);
    expect(committed.statusCode).toBe(200);
    const crun = (committed.json() as { run: RunView }).run;
    expect(crun.status).toBe("committed");
    expect(crun.committedCount).toBe(2);

    const created = await app.db
      .select()
      .from(vendors)
      .where(and(eq(vendors.companyId, owner.companyId), eq(vendors.name, "Acme, Ltd")));
    expect(created).toHaveLength(1);
    expect(created[0]!.tradeCodes).toEqual(["03 30 00", "03 45 00"]);

    // per-row provenance: every committed staged row forward-links its record
    const records = await app.inject({
      method: "GET",
      url: url(`/ingestion/runs/${run.id}/records?status=committed`),
      headers: memberHeaders,
    });
    const items = (records.json() as { items: { committedRecordId: string | null }[] }).items;
    expect(items).toHaveLength(2);
    expect(items.every((r) => r.committedRecordId)).toBe(true);

    // the commit is ledgered once, with the file hash and the counts
    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(eq(ledgerEntries.companyId, owner.companyId), eq(ledgerEntries.objectId, run.id)),
      );
    const commitEntries = entries.filter(
      (e) => (e.payload as { phase?: string } | null)?.phase === "commit",
    );
    expect(commitEntries).toHaveLength(1);
    expect(commitEntries[0]!.payload).toMatchObject({
      fileSha256: run.fileSha256,
      committed: 2,
      dataset: "vendors",
    });
  });

  it("validation leaves rejected rows behind with reasons; commit takes only clean rows", async () => {
    const projectId = await makeProject("Assertions import");
    const csv =
      "kind,value,basis\n" +
      "quantity,100,BQ item 3.1\n" + // clean
      "not_a_kind,5,basis\n" + // bad enum
      "cost,abc,basis\n" + // bad number
      "cost,7,\n"; // missing required basis
    const { run } = await uploadRun(csv, {
      sourceId: csvSourceId,
      dataset: "cost_assertions",
      projectId,
    });
    await mapRun(run.id, { kind: "kind", value: "value", basis: "basis" });
    const validated = (await validateRun(run.id)).json() as {
      run: RunView;
      report: { row: number; code: string }[];
    };
    expect(validated.run.status).toBe("validated");
    expect(validated.run.stagedCount).toBe(1);
    expect(validated.run.rejectedCount).toBe(3);
    expect(validated.report.map((r) => r.code).sort()).toEqual([
      "enum_invalid",
      "required_missing",
      "type_invalid",
    ]);

    const rejected = await app.inject({
      method: "GET",
      url: url(`/ingestion/runs/${run.id}/records?status=rejected`),
      headers: owner.headers,
    });
    const rejectedItems = (rejected.json() as { items: { reason: string | null }[] }).items;
    expect(rejectedItems).toHaveLength(3);
    expect(rejectedItems.every((r) => r.reason)).toBe(true);

    const committed = (await commitRun(run.id)).json() as { committed: number; run: RunView };
    expect(committed.committed).toBe(1);
    expect(committed.run.rejectedCount).toBe(3);
  });

  it("rejects duplicate externalIds in-run, and replays against committed rows raise a signal", async () => {
    const csv1 = "name,ref\nGamma,DUP-1\nDelta,DUP-2\n";
    const { run: run1 } = await uploadRun(csv1, { sourceId: csvSourceId, dataset: "vendors" });
    await mapRun(run1.id, { name: "name", externalId: "ref" });
    await validateRun(run1.id);
    await commitRun(run1.id);

    // in-run duplicate + replay of an already-committed id
    const csv2 = "name,ref\nEpsilon,DUP-3\nEpsilon2,DUP-3\nGamma again,DUP-1\n";
    const { run: run2 } = await uploadRun(csv2, { sourceId: csvSourceId, dataset: "vendors" });
    await mapRun(run2.id, { name: "name", externalId: "ref" });
    const validated = (await validateRun(run2.id)).json() as {
      run: RunView;
      report: { code: string }[];
    };
    expect(validated.run.stagedCount).toBe(1); // only the first DUP-3 row survives
    expect(validated.run.rejectedCount).toBe(2);
    expect(validated.report.map((r) => r.code).sort()).toEqual([
      "duplicate_committed",
      "duplicate_in_run",
    ]);

    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.detector, "ingestion_duplicate_replay"),
        ),
      );
    expect(raised.length).toBeGreaterThanOrEqual(1);
    expect(raised[0]!.evidenceRefs).toMatchObject({ duplicateExternalIds: ["DUP-1"] });
  });

  it("commits RFIs with sequential auto-numbering and module defaults", async () => {
    const projectId = await makeProject("RFI import");
    const csv =
      "subject,question,status\n" +
      "Clash A,Which governs?,open\n" +
      "Clash B,Confirm level,\n";
    const { run } = await uploadRun(csv, { sourceId: csvSourceId, dataset: "rfis", projectId });
    await mapRun(run.id, { subject: "subject", question: "question", status: "status" });
    await validateRun(run.id);
    const res = (await commitRun(run.id)).json() as { committed: number };
    expect(res.committed).toBe(2);
    const created = await app.db
      .select()
      .from(rfis)
      .where(eq(rfis.projectId, projectId))
      .orderBy(rfis.number);
    expect(created.map((r) => r.number)).toEqual([1, 2]);
    expect(created[0]!.status).toBe("open");
    expect(created[1]!.status).toBe("draft"); // module default when the file is silent
    expect(created[0]!.createdBy).toBe(owner.userId);
  });

  it("schedule_tasks refuses to commit without an active schedule, then succeeds against one", async () => {
    const projectId = await makeProject("Schedule import");
    const csv = "task,dur\nMobilise,5\nPiling,20\n";
    const { run } = await uploadRun(csv, {
      sourceId: csvSourceId,
      dataset: "schedule_tasks",
      projectId,
    });
    await mapRun(run.id, { name: "task", durationDays: "dur" });
    await validateRun(run.id);

    const refused = await commitRun(run.id);
    expect(refused.statusCode).toBe(400);
    expect((refused.json() as { message: string }).message).toContain("no active schedule");
    // a refused commit leaves the run exactly as it was
    const [after] = await app.db
      .select()
      .from(ingestionRuns)
      .where(eq(ingestionRuns.id, run.id));
    expect(after!.status).toBe("validated");

    const scheduleId = newId("sch");
    await app.db.insert(schedules).values({
      id: scheduleId,
      companyId: owner.companyId,
      projectId,
      name: "Master",
      projectStart: "2026-01-05",
      isActive: 1,
      createdBy: owner.userId,
    });
    const res = (await commitRun(run.id)).json() as { committed: number };
    expect(res.committed).toBe(2);
    const tasks = await app.db
      .select()
      .from(scheduleTasks)
      .where(eq(scheduleTasks.scheduleId, scheduleId))
      .orderBy(scheduleTasks.sortOrder);
    expect(tasks.map((t) => [t.name, t.durationDays, t.sortOrder])).toEqual([
      ["Mobilise", 5, 0],
      ["Piling", 20, 1],
    ]);
  });

  it("site_access commits known workers, skips unknown ones, and upserts per (worker, date)", async () => {
    const projectId = await makeProject("Access import");
    const workerId = await makeWorker(projectId, "W-100");

    const csv1 = "ref,date,hours\nW-100,2026-02-02,8\nW-999,2026-02-02,8\n";
    const { run: run1 } = await uploadRun(csv1, {
      sourceId: csvSourceId,
      dataset: "site_access",
      projectId,
    });
    await mapRun(run1.id, { workerReference: "ref", accessDate: "date", hoursOnSite: "hours" });
    await validateRun(run1.id);
    const res1 = (await commitRun(run1.id)).json() as {
      committed: number;
      skipped: number;
      run: RunView;
    };
    expect(res1.committed).toBe(1);
    expect(res1.skipped).toBe(1); // unknown worker is a skip, not a lost file
    expect(res1.run.skippedCount).toBe(1);

    // a re-ingested feed for the same day refreshes the row, not duplicates it
    const csv2 = "ref,date,hours\nW-100,2026-02-02,9.5\n";
    const { run: run2 } = await uploadRun(csv2, {
      sourceId: csvSourceId,
      dataset: "site_access",
      projectId,
    });
    await mapRun(run2.id, { workerReference: "ref", accessDate: "date", hoursOnSite: "hours" });
    await validateRun(run2.id);
    await commitRun(run2.id);

    const rows = await app.db
      .select()
      .from(siteAccessRecords)
      .where(
        and(eq(siteAccessRecords.workerId, workerId), eq(siteAccessRecords.accessDate, "2026-02-02")),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hoursOnSite).toBe(9.5);
  });

  it("enforces the run lifecycle: no commit before validate, no re-map or discard after commit", async () => {
    const csv = "name\nLifecycle Co\n";
    const { run } = await uploadRun(csv, { sourceId: csvSourceId, dataset: "vendors" });
    const early = await commitRun(run.id);
    expect(early.statusCode).toBe(409);

    await mapRun(run.id, { name: "name" });
    await validateRun(run.id);
    await commitRun(run.id);

    const remap = await mapRun(run.id, { name: "name" });
    expect(remap.statusCode).toBe(409);
    const discard = await app.inject({
      method: "POST",
      url: url(`/ingestion/runs/${run.id}/discard`),
      headers: owner.headers,
    });
    expect(discard.statusCode).toBe(409);
  });

  it("discards an uncommitted run and lists runs with dataset/status filters", async () => {
    const csv = "name\nDiscard Co\n";
    const { run } = await uploadRun(csv, { sourceId: csvSourceId, dataset: "vendors" });
    const discarded = await app.inject({
      method: "POST",
      url: url(`/ingestion/runs/${run.id}/discard`),
      headers: owner.headers,
    });
    expect(discarded.statusCode).toBe(200);
    expect((discarded.json() as RunView).status).toBe("discarded");

    const list = await app.inject({
      method: "GET",
      url: url("/ingestion/runs?dataset=vendors&status=discarded"),
      headers: memberHeaders,
    });
    const body = list.json() as { items: RunView[] };
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items.every((r) => r.status === "discarded")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* API tokens & the machine push inlet (ADR 0014)                      */
/* ------------------------------------------------------------------ */

describe("API tokens & push", () => {
  it("returns the raw token exactly once and stores only hash + prefix", async () => {
    const created = await createToken(["site_access"]);
    expect(created.token).toMatch(/^cok_[0-9a-f]{40}$/);
    expect(created.tokenPrefix).toBe(created.token.slice(0, 8));

    const list = await app.inject({
      method: "GET",
      url: url("/ingestion/tokens"),
      headers: owner.headers,
    });
    const items = (list.json() as { items: Record<string, unknown>[] }).items;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item).not.toHaveProperty("token");
      expect(item).not.toHaveProperty("tokenHash");
      expect(String(item["tokenPrefix"])).toMatch(/^cok_[0-9a-f]{4}$/);
    }
  });

  it("push stages, validates and commits in one pass through the token pathway", async () => {
    const projectId = await makeProject("Turnstile feed");
    const workerId = await makeWorker(projectId, "W-200");
    const { id: tokenId, token } = await createToken(["site_access"]);

    const res = await push("site_access", token, {
      projectId,
      records: [
        { workerReference: "W-200", accessDate: "2026-03-01", hoursOnSite: 8, source: "turnstile" },
        { workerReference: "W-200", accessDate: "not-a-date" }, // rejected in validation
        { workerReference: "W-404", accessDate: "2026-03-01" }, // skipped at commit
      ],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      runId: string;
      received: number;
      staged: number;
      rejected: number;
      committed: number;
      skipped: number;
      report: { code: string }[];
    };
    expect(body.received).toBe(3);
    expect(body.staged).toBe(2);
    expect(body.rejected).toBe(1);
    expect(body.committed).toBe(1);
    expect(body.skipped).toBe(1);
    expect(body.report[0]!.code).toBe("type_invalid");

    const access = await app.db
      .select()
      .from(siteAccessRecords)
      .where(
        and(eq(siteAccessRecords.workerId, workerId), eq(siteAccessRecords.accessDate, "2026-03-01")),
      );
    expect(access).toHaveLength(1);

    // the implicit run records the TOKEN as its initiator, not a person
    const [run] = await app.db
      .select()
      .from(ingestionRuns)
      .where(eq(ingestionRuns.id, body.runId));
    expect(run!.startedBy).toBe(tokenId);
    expect(run!.status).toBe("committed");
  });

  it("rejects missing, invalid, out-of-scope, revoked and expired tokens", async () => {
    const projectId = await makeProject("Push auth");
    const record = { workerReference: "W-1", accessDate: "2026-03-02" };

    const noHeader = await app.inject({
      method: "POST",
      url: url("/ingestion/push/site_access"),
      payload: { projectId, records: [record] },
    });
    expect(noHeader.statusCode).toBe(401);

    const badToken = await push("site_access", `cok_${"0".repeat(40)}`, {
      projectId,
      records: [record],
    });
    expect(badToken.statusCode).toBe(401);

    const scoped = await createToken(["payroll"]);
    const outOfScope = await push("site_access", scoped.token, { projectId, records: [record] });
    expect(outOfScope.statusCode).toBe(403);

    const revokable = await createToken(["site_access"]);
    const revoke = await app.inject({
      method: "POST",
      url: url(`/ingestion/tokens/${revokable.id}/revoke`),
      headers: owner.headers,
    });
    expect(revoke.statusCode).toBe(200);
    const revoked = await push("site_access", revokable.token, { projectId, records: [record] });
    expect(revoked.statusCode).toBe(401);

    const expired = await createToken(["site_access"], "2020-01-01T00:00:00.000Z");
    const expiredRes = await push("site_access", expired.token, { projectId, records: [record] });
    expect(expiredRes.statusCode).toBe(401);

    const unknownDataset = await push("not_a_dataset", revokable.token, { records: [record] });
    expect(unknownDataset.statusCode).toBe(400);
  });

  it("fx_rates push commits company-scoped rows and skips exact duplicates on replay", async () => {
    const { token } = await createToken(["fx_rates"]);
    const records = [
      { fromCurrency: "usd", toCurrency: "kes", rate: 129.5, rateDate: "2026-01-15" },
      { fromCurrency: "usd", toCurrency: "kes", rate: 129.5, rateDate: "2026-01-15" }, // in-run dup
    ];
    const first = (await push("fx_rates", token, { records })).json() as {
      committed: number;
      skipped: number;
    };
    expect(first.committed).toBe(1);
    expect(first.skipped).toBe(1);

    const replay = (await push("fx_rates", token, { records: [records[0]!] })).json() as {
      committed: number;
      skipped: number;
    };
    expect(replay.committed).toBe(0);
    expect(replay.skipped).toBe(1);

    const rows = await app.db
      .select()
      .from(fxRates)
      .where(and(eq(fxRates.companyId, owner.companyId), eq(fxRates.rateDate, "2026-01-15")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fromCurrency).toBe("USD"); // normalized upper-case
  });
});

/* ------------------------------------------------------------------ */
/* Connector pull — honest 501                                         */
/* ------------------------------------------------------------------ */

describe("connector pull", () => {
  it("returns 501 for procore/aconex naming exactly what a real pull needs", async () => {
    const create = await app.inject({
      method: "POST",
      url: url("/ingestion/sources"),
      headers: owner.headers,
      payload: { name: "Procore live", kind: "procore", config: { baseUrl: "https://api.procore.com" } },
    });
    const sourceId = (create.json() as { id: string }).id;
    const res = await app.inject({
      method: "POST",
      url: url(`/ingestion/sources/${sourceId}/pull`),
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(501);
    const body = res.json() as {
      message: string;
      details: { required: { credentials: string[]; config: string[] } };
    };
    expect(body.message).toContain("Nothing was fetched");
    expect(body.details.required.credentials.join(" ")).toContain("OAuth");
    expect(body.details.required.config.join(" ")).toContain("procoreCompanyId");
  });

  it("tells csv sources to use the upload route instead", async () => {
    const res = await app.inject({
      method: "POST",
      url: url(`/ingestion/sources/${csvSourceId}/pull`),
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { message: string }).message).toContain("POST /ingestion/runs");
  });
});

/* ------------------------------------------------------------------ */
/* OCDS export                                                         */
/* ------------------------------------------------------------------ */

describe("OCDS export", () => {
  it("builds a 1.1 release package from real contracts/variations/certificates with an honest scope note", async () => {
    const projectId = await makeProject("OCDS project");
    const contractId = newId("ctr");
    await app.db.insert(contracts).values({
      id: contractId,
      companyId: owner.companyId,
      projectId,
      name: "Main works",
      form: "fidic_red",
      parties: { employer: "Highways Agency", contractor: "BuildCo JV" },
      currency: "GBP",
      contractSum: 5_000_000,
      status: "executed",
      createdBy: owner.userId,
    });
    await app.db.insert(variations).values({
      id: newId("var"),
      companyId: owner.companyId,
      projectId,
      contractId,
      number: 1,
      title: "Extra drainage",
      status: "instructed",
      agreedValue: 120_000,
      createdBy: owner.userId,
    });
    const valuationId = newId("val");
    await app.db.insert(valuations).values({
      id: valuationId,
      companyId: owner.companyId,
      projectId,
      contractId,
      boqId: newId("boq"),
      number: 1,
      valuationDate: "2026-01-31",
      createdBy: owner.userId,
    });
    await app.db.insert(paymentCertificates).values({
      id: newId("cert"),
      companyId: owner.companyId,
      projectId,
      valuationId,
      number: 1,
      netCertified: 400_000,
      issuedBy: owner.userId,
    });
    // an unlinked variation must be disclosed as omitted, not silently dropped
    await app.db.insert(variations).values({
      id: newId("var"),
      companyId: owner.companyId,
      projectId,
      contractId: null,
      number: 2,
      title: "Orphan variation",
      createdBy: owner.userId,
    });

    const res = await app.inject({
      method: "GET",
      url: url(`/projects/${projectId}/export/ocds`),
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const pkg = res.json() as {
      version: string;
      x_scopeNote: string;
      releases: {
        ocid: string;
        parties: { roles: string[] }[];
        contracts: {
          status: string;
          value: { amount: number; currency: string };
          amendments: { rationale: string }[];
          implementation: { transactions: { value: { amount: number } }[] };
        }[];
      }[];
    };
    expect(pkg.version).toBe("1.1");
    expect(pkg.x_scopeNote).toContain("NOT registered");
    expect(pkg.x_scopeNote).toContain("1 variation(s)");
    expect(pkg.releases).toHaveLength(1);
    const release = pkg.releases[0]!;
    expect(release.ocid).toContain("ocds-unreg1-");
    expect(release.parties.flatMap((p) => p.roles).sort()).toEqual(["buyer", "supplier"]);
    const contract = release.contracts[0]!;
    expect(contract.status).toBe("active"); // executed → active
    expect(contract.value).toEqual({ amount: 5_000_000, currency: "GBP" });
    expect(contract.amendments.map((a) => a.rationale)).toEqual(["Extra drainage"]);
    expect(contract.implementation.transactions[0]!.value.amount).toBe(400_000);
  });

  it("is not reachable across tenants", async () => {
    const projectId = await makeProject("Private OCDS");
    const res = await app.inject({
      method: "GET",
      url: url(`/projects/${projectId}/export/ocds`),
      headers: outsider.headers,
    });
    expect(res.statusCode).toBe(403);
  });
});
