import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import {
  companyMemberships,
  ingestedRecords,
  ingestionMappingTemplates,
  ingestionRuns,
  ledgerEntries,
  projects,
  schedules,
  scheduleDependencies,
  scheduleTasks,
  vendors,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";

/**
 * Ingestion upgrade suite: the programme importers (#349-350), saved mapping
 * templates, reconcile mode and the transitions a failed run must still have.
 *
 * The production blocker under test is the first one: without an XER/MSP inlet
 * the only schedules the platform can hold are hand-typed, and Domain D — which
 * is arithmetic over a logic network — has nothing to reason about.
 */

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let outsider: TestActor;
let memberHeaders: Record<string, string>;
let csvSourceId: string;
let projectId: string;

const url = (p: string) => `/api/v1${p}`;

const XER = [
  "ERMHDR\t19.12\t2026-08-01\tProject\tadmin",
  "%T\tPROJECT",
  "%F\tproj_id\tproj_short_name",
  "%R\t1001\tHarbour Works",
  "%T\tTASK",
  "%F\ttask_id\ttask_code\ttask_name\ttarget_drtn_hr_cnt\tearly_start_date",
  "%R\t1\tA100\tSite setup\t40\t2026-01-05 08:00",
  "%R\t2\tA110\tExcavation\t80\t2026-01-12 08:00",
  "%R\t3\tA120\tFoundations\t120\t2026-01-26 08:00",
  "%T\tTASKPRED",
  "%F\ttask_pred_id\ttask_id\tpred_task_id\tpred_type\tlag_hr_cnt",
  "%R\t1\t2\t1\tPR_FS\t0",
  "%R\t2\t3\t2\tPR_FS\t16",
  "%E",
].join("\n");

function multipart(
  body: string,
  fields: Record<string, string>,
  filename: string,
  contentType: string,
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
      `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: ${contentType}\r\n\r\n`,
    ),
  );
  parts.push(Buffer.from(body), Buffer.from(`\r\n--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app, { companyName: "Ingestion Upgrade Co" });
  outsider = await registerActor(app, { companyName: "Other Co" });
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
  const source = await app.inject({
    method: "POST",
    url: url("/ingestion/sources"),
    headers: owner.headers,
    payload: { name: "Contractor exports", kind: "csv" },
  });
  csvSourceId = (source.json() as { id: string }).id;

  projectId = newId("prj");
  await app.db.insert(projects).values({
    id: projectId,
    companyId: owner.companyId,
    name: "Harbour Works",
  });
});

afterAll(async () => {
  await built.close();
});

/* ================================================================== */
/* Programme import                                                    */
/* ================================================================== */

describe("programme import", () => {
  it("stages a P6 XER with its logic, and commits it into a scheduled programme", async () => {
    await app.db.insert(schedules).values({
      id: newId("sch"),
      companyId: owner.companyId,
      projectId,
      name: "Master programme",
      projectStart: "2026-01-05",
      isActive: 1,
      createdBy: owner.userId,
    });

    const upload = multipart(
      XER,
      { sourceId: csvSourceId, projectId },
      "programme.xer",
      "text/plain",
    );
    const res = await app.inject({
      method: "POST",
      url: url("/ingestion/runs/programme"),
      headers: { ...owner.headers, ...upload.headers },
      payload: upload.payload,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      run: { id: string; parser: string; stagedCount: number; columnMap: Record<string, string> };
      parser: string;
      programmeName: string;
      activities: number;
      caveats: string[];
    };
    expect(body.parser).toBe("p6_xer");
    expect(body.programmeName).toBe("Harbour Works");
    expect(body.activities).toBe(3);
    expect(body.run.stagedCount).toBe(3);
    // the run records WHICH parser produced its rows, and its map is explicit
    expect(body.run.parser).toBe("p6_xer");
    expect(body.run.columnMap["predecessors"]).toBe("predecessors");
    // the caveats travel with the import rather than living in a doc nobody reads
    expect(body.caveats.join(" ")).toContain("Calendars were not imported");

    const validated = await app.inject({
      method: "POST",
      url: url(`/ingestion/runs/${body.run.id}/validate`),
      headers: owner.headers,
    });
    expect(validated.statusCode).toBe(200);
    expect((validated.json() as { run: { rejectedCount: number } }).run.rejectedCount).toBe(0);

    const committed = await app.inject({
      method: "POST",
      url: url(`/ingestion/runs/${body.run.id}/commit`),
      headers: owner.headers,
    });
    expect(committed.statusCode).toBe(200);
    const outcome = committed.json() as {
      committed: number;
      schedule?: Record<string, unknown>;
    };
    expect(outcome.committed).toBe(3);

    const tasks = await app.db
      .select()
      .from(scheduleTasks)
      .where(eq(scheduleTasks.projectId, projectId))
      .orderBy(asc(scheduleTasks.name));
    expect(tasks.map((t) => t.name)).toEqual(["Excavation", "Foundations", "Site setup"]);
    // THE POINT OF THE IMPORT: the logic came with it…
    const [schedule] = await app.db
      .select()
      .from(schedules)
      .where(eq(schedules.projectId, projectId))
      .limit(1);
    const deps = await app.db
      .select()
      .from(scheduleDependencies)
      .where(eq(scheduleDependencies.scheduleId, schedule!.id));
    expect(deps.length).toBeGreaterThanOrEqual(2);
    // …and the tasks are scheduled, not left as an unscheduled list
    expect(tasks.every((t) => t.startDate !== null && t.finishDate !== null)).toBe(true);
    expect(outcome.schedule).toBeTruthy();
  });

  it("refuses a file that is neither format, and says what to do about a .mpp", async () => {
    const upload = multipart(
      "name,duration\nA,1\n",
      { sourceId: csvSourceId, projectId },
      "programme.csv",
      "text/csv",
    );
    const res = await app.inject({
      method: "POST",
      url: url("/ingestion/runs/programme"),
      headers: { ...owner.headers, ...upload.headers },
      payload: upload.payload,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { message: string }).message).toContain(".mpp");
  });

  it("refuses a programme with no activities rather than staging an empty run", async () => {
    const upload = multipart(
      "ERMHDR\t19.12\n%T\tPROJECT\n%F\tproj_id\n%R\t1\n%E\n",
      { sourceId: csvSourceId, projectId },
      "empty.xer",
      "text/plain",
    );
    const res = await app.inject({
      method: "POST",
      url: url("/ingestion/runs/programme"),
      headers: { ...owner.headers, ...upload.headers },
      payload: upload.payload,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { message: string }).message).toContain("no activities");
  });

  it("requires a project, and refuses one from another tenant", async () => {
    const noProject = multipart(XER, { sourceId: csvSourceId }, "p.xer", "text/plain");
    const res = await app.inject({
      method: "POST",
      url: url("/ingestion/runs/programme"),
      headers: { ...owner.headers, ...noProject.headers },
      payload: noProject.payload,
    });
    expect(res.statusCode).toBe(400);

    const crossTenant = multipart(
      XER,
      { sourceId: csvSourceId, projectId },
      "p.xer",
      "text/plain",
    );
    const cross = await app.inject({
      method: "POST",
      url: url("/ingestion/runs/programme"),
      headers: { ...outsider.headers, ...crossTenant.headers },
      payload: crossTenant.payload,
    });
    // the source belongs to the other tenant, so it is not found there
    expect([400, 403, 404]).toContain(cross.statusCode);
  });

  it("is admin-only: a plain member cannot import a programme", async () => {
    const upload = multipart(XER, { sourceId: csvSourceId, projectId }, "p.xer", "text/plain");
    const res = await app.inject({
      method: "POST",
      url: url("/ingestion/runs/programme"),
      headers: { ...memberHeaders, ...upload.headers },
      payload: upload.payload,
    });
    expect(res.statusCode).toBe(403);
  });

  it("ledgers the upload with the file hash, the parser and the caveats", async () => {
    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectType, "ingestion_run"),
        ),
      );
    const upload = entries.find(
      (e) => (e.payload as Record<string, unknown> | null)?.["phase"] === "programme_upload",
    );
    expect(upload).toBeTruthy();
    const payload = upload!.payload as Record<string, unknown>;
    expect(payload["parser"]).toBe("p6_xer");
    expect(typeof payload["fileSha256"]).toBe("string");
    expect(Array.isArray(payload["caveats"])).toBe(true);
  });
});

/* ================================================================== */
/* Mapping templates                                                   */
/* ================================================================== */

describe("mapping templates", () => {
  let templateId: string;

  it("saves a map, refuses one naming a field the dataset does not have", async () => {
    const created = await app.inject({
      method: "POST",
      url: url("/ingestion/mapping-templates"),
      headers: owner.headers,
      payload: {
        name: "Legacy vendor export",
        dataset: "vendors",
        columnMap: { name: "Supplier", email: "Contact Email" },
      },
    });
    expect(created.statusCode).toBe(201);
    templateId = (created.json() as { id: string }).id;

    const bad = await app.inject({
      method: "POST",
      url: url("/ingestion/mapping-templates"),
      headers: owner.headers,
      payload: {
        name: "Broken",
        dataset: "vendors",
        columnMap: { notAField: "Whatever" },
      },
    });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { message: string }).message).toContain("notAField");
  });

  it("is adopted by a run instead of restating the map, and counts the adoption", async () => {
    const csv = "Supplier,Contact Email\nAcme Ltd,ops@acme.test\n";
    const upload = multipart(
      csv,
      { sourceId: csvSourceId, dataset: "vendors" },
      "vendors.csv",
      "text/csv",
    );
    const created = await app.inject({
      method: "POST",
      url: url("/ingestion/runs"),
      headers: { ...owner.headers, ...upload.headers },
      payload: upload.payload,
    });
    const runId = (created.json() as { run: { id: string } }).run.id;

    const mapped = await app.inject({
      method: "POST",
      url: url(`/ingestion/runs/${runId}/map`),
      headers: owner.headers,
      payload: { templateId },
    });
    expect(mapped.statusCode).toBe(200);
    const body = mapped.json() as { staged: number; templateId: string };
    expect(body.staged).toBe(1);
    expect(body.templateId).toBe(templateId);

    const [tpl] = await app.db
      .select()
      .from(ingestionMappingTemplates)
      .where(eq(ingestionMappingTemplates.id, templateId));
    expect(tpl!.useCount).toBe(1);
  });

  it("refuses a template written for another dataset", async () => {
    const csv = "task,dur\nA,1\n";
    const upload = multipart(
      csv,
      { sourceId: csvSourceId, dataset: "schedule_tasks", projectId },
      "tasks.csv",
      "text/csv",
    );
    const created = await app.inject({
      method: "POST",
      url: url("/ingestion/runs"),
      headers: { ...owner.headers, ...upload.headers },
      payload: upload.payload,
    });
    const runId = (created.json() as { run: { id: string } }).run.id;
    const mapped = await app.inject({
      method: "POST",
      url: url(`/ingestion/runs/${runId}/map`),
      headers: owner.headers,
      payload: { templateId },
    });
    expect(mapped.statusCode).toBe(400);
    expect((mapped.json() as { message: string }).message).toContain("vendors");
  });

  it("insists on exactly one of columnMap or templateId", async () => {
    const csv = "Supplier\nAcme\n";
    const upload = multipart(
      csv,
      { sourceId: csvSourceId, dataset: "vendors" },
      "v.csv",
      "text/csv",
    );
    const created = await app.inject({
      method: "POST",
      url: url("/ingestion/runs"),
      headers: { ...owner.headers, ...upload.headers },
      payload: upload.payload,
    });
    const runId = (created.json() as { run: { id: string } }).run.id;
    for (const payload of [{}, { templateId, columnMap: { name: "Supplier" } }]) {
      const res = await app.inject({
        method: "POST",
        url: url(`/ingestion/runs/${runId}/map`),
        headers: owner.headers,
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("does not leak templates across a tenant boundary", async () => {
    const list = await app.inject({
      method: "GET",
      url: url("/ingestion/mapping-templates"),
      headers: outsider.headers,
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { items: unknown[] }).items).toHaveLength(0);

    const del = await app.inject({
      method: "DELETE",
      url: url(`/ingestion/mapping-templates/${templateId}`),
      headers: outsider.headers,
    });
    expect(del.statusCode).toBe(404);
  });
});

/* ================================================================== */
/* Reconcile mode                                                      */
/* ================================================================== */

describe("reconcile mode", () => {
  it("matches a re-presented record, diffs it, and applies the operator's decision", async () => {
    const csv = "ref,name,email\nV-1,Reconcile Works Ltd,ops@acme.test\n";
    const first = multipart(
      csv,
      { sourceId: csvSourceId, dataset: "vendors" },
      "v1.csv",
      "text/csv",
    );
    const created = await app.inject({
      method: "POST",
      url: url("/ingestion/runs"),
      headers: { ...owner.headers, ...first.headers },
      payload: first.payload,
    });
    const runId = (created.json() as { run: { id: string } }).run.id;
    await app.inject({
      method: "POST",
      url: url(`/ingestion/runs/${runId}/map`),
      headers: owner.headers,
      payload: { columnMap: { externalId: "ref", name: "name", email: "email" } },
    });
    await app.inject({
      method: "POST",
      url: url(`/ingestion/runs/${runId}/validate`),
      headers: owner.headers,
    });
    const committed = await app.inject({
      method: "POST",
      url: url(`/ingestion/runs/${runId}/commit`),
      headers: owner.headers,
    });
    expect(committed.statusCode).toBe(200);

    // the same vendor, restated with a new email
    const restated = "ref,name,email\nV-1,Reconcile Works Ltd,accounts@acme.test\n";
    const second = multipart(
      restated,
      { sourceId: csvSourceId, dataset: "vendors", mode: "reconcile" },
      "v2.csv",
      "text/csv",
    );
    const run2 = await app.inject({
      method: "POST",
      url: url("/ingestion/runs"),
      headers: { ...owner.headers, ...second.headers },
      payload: second.payload,
    });
    const run2Id = (run2.json() as { run: { id: string; mode: string } }).run.id;
    expect((run2.json() as { run: { mode: string } }).run.mode).toBe("reconcile");
    await app.inject({
      method: "POST",
      url: url(`/ingestion/runs/${run2Id}/map`),
      headers: owner.headers,
      payload: { columnMap: { externalId: "ref", name: "name", email: "email" } },
    });
    const validated = await app.inject({
      method: "POST",
      url: url(`/ingestion/runs/${run2Id}/validate`),
      headers: owner.headers,
    });
    expect(validated.statusCode).toBe(200);

    const [staged] = await app.db
      .select()
      .from(ingestedRecords)
      .where(eq(ingestedRecords.runId, run2Id));
    // an insert-mode run would have rejected this as a duplicate; reconcile
    // treats it as a restatement and shows what changed
    expect(staged!.matchedRecordId).toBeTruthy();
    expect(JSON.stringify(staged!.diff)).toContain("accounts@acme.test");

    const decision = await app.inject({
      method: "POST",
      url: url(`/ingestion/runs/${run2Id}/records/${staged!.id}/resolution`),
      headers: owner.headers,
      payload: { resolution: "update" },
    });
    expect(decision.statusCode).toBe(200);
    expect((decision.json() as { resolution: string }).resolution).toBe("update");

    const applied = await app.inject({
      method: "POST",
      url: url(`/ingestion/runs/${run2Id}/commit`),
      headers: owner.headers,
    });
    expect(applied.statusCode).toBe(200);
    const rows = await app.db
      .select()
      .from(vendors)
      .where(and(eq(vendors.companyId, owner.companyId), eq(vendors.name, "Reconcile Works Ltd")));
    // ONE vendor, updated — not a second copy
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toBe("accounts@acme.test");
  });

  it("refuses a resolution on a row that restates nothing", async () => {
    const csv = "ref,name\nV-99,Brand New Ltd\n";
    const upload = multipart(
      csv,
      { sourceId: csvSourceId, dataset: "vendors", mode: "reconcile" },
      "v3.csv",
      "text/csv",
    );
    const created = await app.inject({
      method: "POST",
      url: url("/ingestion/runs"),
      headers: { ...owner.headers, ...upload.headers },
      payload: upload.payload,
    });
    const runId = (created.json() as { run: { id: string } }).run.id;
    await app.inject({
      method: "POST",
      url: url(`/ingestion/runs/${runId}/map`),
      headers: owner.headers,
      payload: { columnMap: { externalId: "ref", name: "name" } },
    });
    await app.inject({
      method: "POST",
      url: url(`/ingestion/runs/${runId}/validate`),
      headers: owner.headers,
    });
    const [row] = await app.db
      .select()
      .from(ingestedRecords)
      .where(eq(ingestedRecords.runId, runId));
    const res = await app.inject({
      method: "POST",
      url: url(`/ingestion/runs/${runId}/records/${row!.id}/resolution`),
      headers: owner.headers,
      payload: { resolution: "skip" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { message: string }).message).toContain("nothing to reconcile");
  });
});

/* ================================================================== */
/* A refused commit must not strand the run                            */
/* ================================================================== */

describe("commit refusal", () => {
  it("returns a run to `validated` when a precondition refuses it", async () => {
    const noScheduleProject = newId("prj");
    await app.db.insert(projects).values({
      id: noScheduleProject,
      companyId: owner.companyId,
      name: "No schedule here",
    });
    const upload = multipart(
      "task,dur\nMobilise,5\n",
      { sourceId: csvSourceId, dataset: "schedule_tasks", projectId: noScheduleProject },
      "tasks.csv",
      "text/csv",
    );
    const created = await app.inject({
      method: "POST",
      url: url("/ingestion/runs"),
      headers: { ...owner.headers, ...upload.headers },
      payload: upload.payload,
    });
    const runId = (created.json() as { run: { id: string } }).run.id;
    await app.inject({
      method: "POST",
      url: url(`/ingestion/runs/${runId}/map`),
      headers: owner.headers,
      payload: { columnMap: { name: "task", durationDays: "dur" } },
    });
    await app.inject({
      method: "POST",
      url: url(`/ingestion/runs/${runId}/validate`),
      headers: owner.headers,
    });
    const refused = await app.inject({
      method: "POST",
      url: url(`/ingestion/runs/${runId}/commit`),
      headers: owner.headers,
    });
    expect(refused.statusCode).toBe(400);

    // The claim that makes concurrent commits safe must not leave the run in
    // `committing`, a state no transition accepts.
    const [after] = await app.db
      .select()
      .from(ingestionRuns)
      .where(eq(ingestionRuns.id, runId));
    expect(after!.status).toBe("validated");

    // …and the operator can act on it again
    const retry = await app.inject({
      method: "POST",
      url: url(`/ingestion/runs/${runId}/discard`),
      headers: owner.headers,
    });
    expect(retry.statusCode).toBe(200);
  });
});
