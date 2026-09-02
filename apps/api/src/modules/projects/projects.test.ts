import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  assets,
  bimModels,
  companyMemberships,
  drawingSheets,
  ledgerEntries,
  notifications,
  punchItems,
  rfis,
  signals,
  submittals,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";

let built: BuiltApp;
let actor: TestActor;

/** register a bare user (no company) and add them to actor's company. */
async function addCompanyUser(role: "member" | "guest"): Promise<{
  userId: string;
  headers: Record<string, string>;
}> {
  const email = `extra-${newId().slice(0, 10)}@test.dev`;
  const res = await built.app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, password: "password-123", name: `Extra ${role}` },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { user: { id: string }; accessToken: string };
  await built.app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: actor.companyId,
    userId: body.user.id,
    role,
  });
  return {
    userId: body.user.id,
    headers: {
      authorization: `Bearer ${body.accessToken}`,
      "x-company-id": actor.companyId,
    },
  };
}

async function createProject(
  headers: Record<string, string>,
  name = "Test Project",
): Promise<{ id: string }> {
  const res = await built.app.inject({
    method: "POST",
    url: "/api/v1/projects",
    payload: { name },
    headers,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

beforeAll(async () => {
  built = await buildTestApp();
  actor = await registerActor(built.app);
});

afterAll(async () => {
  await built.close();
});

describe("projects CRUD + stages", () => {
  it("creates, lists (filter/search), reads, patches stage, deletes", async () => {
    const created = await createProject(actor.headers, "Riverside Tower");
    expect(created.id).toMatch(/^prj_/);

    // search + stage filter
    const list = await built.app.inject({
      method: "GET",
      url: "/api/v1/projects?search=riverside&stage=pre_construction",
      headers: actor.headers,
    });
    expect(list.statusCode).toBe(200);
    const listBody = list.json() as { items: { id: string }[]; total: number };
    expect(listBody.items.some((p) => p.id === created.id)).toBe(true);

    const get = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${created.id}`,
      headers: actor.headers,
    });
    expect(get.statusCode).toBe(200);

    // stage transition -> state_change ledger entry
    const patch = await built.app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${created.id}`,
      payload: { stage: "course_of_construction" },
      headers: actor.headers,
    });
    expect(patch.statusCode).toBe(200);
    expect((patch.json() as { stage: string }).stage).toBe("course_of_construction");

    const entries = await built.app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, actor.companyId),
          eq(ledgerEntries.objectId, created.id),
          eq(ledgerEntries.action, "state_change"),
        ),
      );
    expect(entries.length).toBe(1);

    // invalid stage rejected
    const bad = await built.app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${created.id}`,
      payload: { stage: "definitely_not_a_stage" },
      headers: actor.headers,
    });
    expect(bad.statusCode).toBe(400);

    const del = await built.app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${created.id}`,
      headers: actor.headers,
    });
    expect(del.statusCode).toBe(200);
    const gone = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${created.id}`,
      headers: actor.headers,
    });
    // requireTool 403s because the project no longer exists in the tenant
    expect(gone.statusCode).toBe(403);
  });
});

describe("membership template on create", () => {
  it("creator (plain member) passes requireTool via project_admin template; outsider does not", async () => {
    const member = await addCompanyUser("member");
    const other = await addCompanyUser("member");

    const created = await createProject(member.headers, "Member Project");

    // creator can read + admin their project (template project_admin)
    const ok = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${created.id}`,
      headers: member.headers,
    });
    expect(ok.statusCode).toBe(200);
    const okAdmin = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${created.id}/summary`,
      headers: member.headers,
    });
    expect(okAdmin.statusCode).toBe(200);

    // a member with no project membership is refused
    const refused = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${created.id}`,
      headers: other.headers,
    });
    expect(refused.statusCode).toBe(403);
  });
});

describe("locations", () => {
  it("builds a tree, moves a subtree (paths recomputed) and refuses deleting a parent", async () => {
    const prj = await createProject(actor.headers, "Location Project");
    const mk = async (name: string, parentId?: string) => {
      const res = await built.app.inject({
        method: "POST",
        url: `/api/v1/projects/${prj.id}/locations`,
        payload: parentId ? { name, parentId } : { name },
        headers: actor.headers,
      });
      expect(res.statusCode).toBe(201);
      return res.json() as { id: string; path: string };
    };
    const a = await mk("Building A");
    const b = await mk("Level 1", a.id);
    const c = await mk("Zone North", b.id);
    const d = await mk("Building B");

    expect(b.path).toBe(`${a.path}/${b.id}`);
    expect(c.path).toBe(`${a.path}/${b.id}/${c.id}`);

    // move b (and its subtree) under d
    const move = await built.app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${prj.id}/locations/${b.id}`,
      payload: { parentId: d.id },
      headers: actor.headers,
    });
    expect(move.statusCode).toBe(200);
    expect((move.json() as { path: string }).path).toBe(`${d.id}/${b.id}`);

    const list = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${prj.id}/locations`,
      headers: actor.headers,
    });
    const { items, tree } = list.json() as {
      items: { id: string; path: string }[];
      tree: { id: string; children: unknown[] }[];
    };
    const cRow = items.find((l) => l.id === c.id)!;
    expect(cRow.path).toBe(`${d.id}/${b.id}/${c.id}`);
    // tree roots: a and d
    expect(tree.map((t) => t.id).sort()).toEqual([a.id, d.id].sort());

    // cycle guard: cannot move d under its descendant c
    const cycle = await built.app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${prj.id}/locations/${d.id}`,
      payload: { parentId: c.id },
      headers: actor.headers,
    });
    expect(cycle.statusCode).toBe(400);

    // delete with children rejected
    const delParent = await built.app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${prj.id}/locations/${b.id}`,
      headers: actor.headers,
    });
    expect(delParent.statusCode).toBe(409);

    const delLeaf = await built.app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${prj.id}/locations/${c.id}`,
      headers: actor.headers,
    });
    expect(delLeaf.statusCode).toBe(200);
  });
});

describe("cost codes", () => {
  it("merges the standard list with project overrides (override wins)", async () => {
    const prj = await createProject(actor.headers, "Cost Code Project");

    const std1 = await built.app.inject({
      method: "POST",
      url: "/api/v1/cost-codes",
      payload: { code: "03-100", title: "Concrete Formwork", costType: "material" },
      headers: actor.headers,
    });
    expect(std1.statusCode).toBe(201);
    const std2 = await built.app.inject({
      method: "POST",
      url: "/api/v1/cost-codes",
      payload: { code: "03-200", title: "Rebar" },
      headers: actor.headers,
    });
    expect(std2.statusCode).toBe(201);

    // project override of 03-100
    const ovr = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${prj.id}/cost-codes`,
      payload: { code: "03-100", title: "Formwork (project rate)" },
      headers: actor.headers,
    });
    expect(ovr.statusCode).toBe(201);

    const merged = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${prj.id}/cost-codes`,
      headers: actor.headers,
    });
    expect(merged.statusCode).toBe(200);
    const items = (merged.json() as {
      items: { code: string; title: string; source: string }[];
    }).items;
    const c100 = items.filter((i) => i.code === "03-100");
    expect(c100.length).toBe(1);
    expect(c100[0]!.title).toBe("Formwork (project rate)");
    expect(c100[0]!.source).toBe("project");
    expect(items.find((i) => i.code === "03-200")?.source).toBe("standard");

    // duplicate at same level rejected
    const dup = await built.app.inject({
      method: "POST",
      url: "/api/v1/cost-codes",
      payload: { code: "03-100", title: "Duplicate" },
      headers: actor.headers,
    });
    expect(dup.statusCode).toBe(409);

    // company standard list only contains projectId=null rows
    const std = await built.app.inject({
      method: "GET",
      url: "/api/v1/cost-codes",
      headers: actor.headers,
    });
    const stdItems = (std.json() as { items: { code: string; projectId: string | null }[] })
      .items;
    expect(stdItems.every((i) => i.projectId === null)).toBe(true);
  });
});

describe("record links", () => {
  it("creates a link and finds it from both directions", async () => {
    const prj = await createProject(actor.headers, "Link Project");
    const rfiId = newId("rfi");
    const sheetId = newId("sheet");
    const created = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${prj.id}/links`,
      payload: { fromType: "rfi", fromId: rfiId, toType: "drawing_sheet", toId: sheetId },
      headers: actor.headers,
    });
    expect(created.statusCode).toBe(201);
    const link = created.json() as { id: string };

    const fromSide = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${prj.id}/links?recordType=rfi&recordId=${rfiId}`,
      headers: actor.headers,
    });
    expect((fromSide.json() as { total: number }).total).toBe(1);

    const toSide = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${prj.id}/links?recordType=drawing_sheet&recordId=${sheetId}`,
      headers: actor.headers,
    });
    expect((toSide.json() as { total: number }).total).toBe(1);

    const del = await built.app.inject({
      method: "DELETE",
      url: `/api/v1/links/${link.id}`,
      headers: actor.headers,
    });
    expect(del.statusCode).toBe(200);

    const after = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${prj.id}/links?recordType=rfi&recordId=${rfiId}`,
      headers: actor.headers,
    });
    expect((after.json() as { total: number }).total).toBe(0);
  });
});

describe("comments, mentions, watchers, tags", () => {
  it("comment with @mention creates a mention notification", async () => {
    const prj = await createProject(actor.headers, "Comment Project");
    const member = await addCompanyUser("member");
    const rfiId = newId("rfi");

    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${prj.id}/records/rfi/${rfiId}/comments`,
      payload: { body: "Please review @member", mentions: [member.userId, "u_notamember"] },
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { mentions: string[] }).mentions).toEqual([member.userId]);

    const rows = await built.app.db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.userId, member.userId), eq(notifications.kind, "mention")),
      );
    expect(rows.length).toBe(1);
    expect(rows[0]!.recordId).toBe(rfiId);

    const list = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${prj.id}/records/rfi/${rfiId}/comments`,
      headers: actor.headers,
    });
    const listBody = list.json() as { total: number; items: { authorName: string }[] };
    expect(listBody.total).toBe(1);
    expect(listBody.items[0]!.authorName).toBeTruthy();
  });

  it("watcher toggle is idempotent per user", async () => {
    const prj = await createProject(actor.headers, "Watch Project");
    const recUrl = `/api/v1/projects/${prj.id}/records/submittal/${newId("sub")}/watchers`;

    const on = await built.app.inject({ method: "POST", url: recUrl, headers: actor.headers });
    expect(on.statusCode).toBe(201);
    const again = await built.app.inject({ method: "POST", url: recUrl, headers: actor.headers });
    expect((again.json() as { watching: boolean }).watching).toBe(true);

    const list = await built.app.inject({ method: "GET", url: recUrl, headers: actor.headers });
    const listBody = list.json() as { total: number; watching: boolean };
    expect(listBody.total).toBe(1);
    expect(listBody.watching).toBe(true);

    const off = await built.app.inject({ method: "DELETE", url: recUrl, headers: actor.headers });
    expect((off.json() as { watching: boolean }).watching).toBe(false);
  });

  it("assigns a tag created on the fly and lists company tags", async () => {
    const prj = await createProject(actor.headers, "Tag Project");
    const recUrl = `/api/v1/projects/${prj.id}/records/punch_item/${newId("pi")}/tags`;

    const assign = await built.app.inject({
      method: "POST",
      url: recUrl,
      payload: { name: "hot-work" },
      headers: actor.headers,
    });
    expect(assign.statusCode).toBe(201);
    const { tagId } = assign.json() as { tagId: string };

    // same name again = same tag, idempotent assignment
    const re = await built.app.inject({
      method: "POST",
      url: recUrl,
      payload: { name: "hot-work" },
      headers: actor.headers,
    });
    expect((re.json() as { tagId: string }).tagId).toBe(tagId);

    const recTags = await built.app.inject({ method: "GET", url: recUrl, headers: actor.headers });
    expect((recTags.json() as { total: number }).total).toBe(1);

    const all = await built.app.inject({
      method: "GET",
      url: "/api/v1/tags",
      headers: actor.headers,
    });
    expect(
      (all.json() as { items: { name: string }[] }).items.some((t) => t.name === "hot-work"),
    ).toBe(true);

    const unassign = await built.app.inject({
      method: "DELETE",
      url: `${recUrl}/${tagId}`,
      headers: actor.headers,
    });
    expect(unassign.statusCode).toBe(200);
    const empty = await built.app.inject({ method: "GET", url: recUrl, headers: actor.headers });
    expect((empty.json() as { total: number }).total).toBe(0);
  });
});

describe("custom fields", () => {
  it("defines fields (company + project scope), upserts and reads values", async () => {
    const prj = await createProject(actor.headers, "Custom Field Project");

    const def1 = await built.app.inject({
      method: "POST",
      url: "/api/v1/custom-field-defs",
      payload: { tool: "rfis", key: "permit_no", label: "Permit No", fieldType: "text" },
      headers: actor.headers,
    });
    expect(def1.statusCode).toBe(201);
    const d1 = def1.json() as { id: string };

    const def2 = await built.app.inject({
      method: "POST",
      url: "/api/v1/custom-field-defs",
      payload: {
        projectId: prj.id,
        tool: "rfis",
        key: "zone_class",
        label: "Zone Class",
        fieldType: "dropdown",
        options: ["A", "B"],
      },
      headers: actor.headers,
    });
    expect(def2.statusCode).toBe(201);
    const d2 = def2.json() as { id: string };

    const rfiId = newId("rfi");
    const put = await built.app.inject({
      method: "PUT",
      url: `/api/v1/projects/${prj.id}/records/rfi/${rfiId}/custom-values`,
      payload: { values: { [d1.id]: "PRM-778", [d2.id]: "B" } },
      headers: actor.headers,
    });
    expect(put.statusCode).toBe(200);

    // upsert overwrites
    const put2 = await built.app.inject({
      method: "PUT",
      url: `/api/v1/projects/${prj.id}/records/rfi/${rfiId}/custom-values`,
      payload: { values: { [d1.id]: "PRM-779" } },
      headers: actor.headers,
    });
    expect(put2.statusCode).toBe(200);

    const get = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${prj.id}/records/rfi/${rfiId}/custom-values`,
      headers: actor.headers,
    });
    const values = (get.json() as {
      items: { fieldDefId: string; value: unknown }[];
      total: number;
    });
    expect(values.total).toBe(2);
    expect(values.items.find((v) => v.fieldDefId === d1.id)?.value).toBe("PRM-779");

    // unknown def rejected
    const badPut = await built.app.inject({
      method: "PUT",
      url: `/api/v1/projects/${prj.id}/records/rfi/${rfiId}/custom-values`,
      payload: { values: { cfd_bogus: 1 } },
      headers: actor.headers,
    });
    expect(badPut.statusCode).toBe(400);
  });
});

describe("wbs + portfolios", () => {
  it("wbs segment CRUD", async () => {
    const prj = await createProject(actor.headers, "WBS Project");
    const created = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${prj.id}/wbs`,
      payload: { name: "Cost Code", segmentType: "cost_code", position: 0 },
      headers: actor.headers,
    });
    expect(created.statusCode).toBe(201);
    const seg = created.json() as { id: string };

    const patched = await built.app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${prj.id}/wbs/${seg.id}`,
      payload: { position: 2 },
      headers: actor.headers,
    });
    expect((patched.json() as { position: number }).position).toBe(2);

    const list = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${prj.id}/wbs`,
      headers: actor.headers,
    });
    expect((list.json() as { total: number }).total).toBe(1);

    const del = await built.app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${prj.id}/wbs/${seg.id}`,
      headers: actor.headers,
    });
    expect(del.statusCode).toBe(200);
  });

  it("portfolio CRUD + project assignment", async () => {
    const pf = await built.app.inject({
      method: "POST",
      url: "/api/v1/portfolios",
      payload: { name: "Northern Region", programme: "Infrastructure 2030" },
      headers: actor.headers,
    });
    expect(pf.statusCode).toBe(201);
    const portfolio = pf.json() as { id: string };

    const prj = await createProject(actor.headers, "Portfolio Project");
    const assign = await built.app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${prj.id}`,
      payload: { portfolioId: portfolio.id },
      headers: actor.headers,
    });
    expect((assign.json() as { portfolioId: string }).portfolioId).toBe(portfolio.id);

    const filtered = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects?portfolioId=${portfolio.id}`,
      headers: actor.headers,
    });
    expect((filtered.json() as { total: number }).total).toBe(1);

    const del = await built.app.inject({
      method: "DELETE",
      url: `/api/v1/portfolios/${portfolio.id}`,
      headers: actor.headers,
    });
    expect(del.statusCode).toBe(200);

    // project detached, not deleted
    const after = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${prj.id}`,
      headers: actor.headers,
    });
    expect((after.json() as { portfolioId: string | null }).portfolioId).toBeNull();
  });
});

describe("project summary", () => {
  it("counts open records across tools", async () => {
    const prj = await createProject(actor.headers, "Summary Project");
    const db = built.app.db;
    const base = { companyId: actor.companyId, projectId: prj.id };

    await db.insert(rfis).values([
      {
        ...base,
        id: newId("rfi"),
        number: 1,
        subject: "Open one",
        question: "?",
        status: "open",
        createdBy: actor.userId,
      },
      {
        ...base,
        id: newId("rfi"),
        number: 2,
        subject: "Closed one",
        question: "?",
        status: "closed",
        createdBy: actor.userId,
      },
    ]);
    await db.insert(submittals).values({
      ...base,
      id: newId("sub"),
      number: 1,
      title: "Rebar shop drawings",
      status: "in_review",
      createdBy: actor.userId,
    });
    await db.insert(punchItems).values({
      ...base,
      id: newId("pi"),
      number: 1,
      title: "Paint touch-up",
      status: "open",
      createdBy: actor.userId,
    });
    await db.insert(drawingSheets).values({
      ...base,
      id: newId("sht"),
      number: "A-101",
      title: "Floor Plan",
    });
    await db.insert(bimModels).values({
      ...base,
      id: newId("bim"),
      name: "Arch model",
      format: "ifc",
      createdBy: actor.userId,
    });
    await db.insert(assets).values({
      ...base,
      id: newId("ast"),
      tagCode: "AHU-01",
      name: "Air handler",
      createdBy: actor.userId,
    });
    await db.insert(signals).values([
      {
        ...base,
        id: newId("sig"),
        detector: "quantity_check",
        severity: "high",
        title: "Quantity variance",
        explanation: "claimed > measured",
      },
      {
        ...base,
        id: newId("sig"),
        detector: "quantity_check",
        severity: "low",
        title: "Closed signal",
        explanation: "resolved",
        disposition: "closed",
      },
    ]);

    const res = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${prj.id}/summary`,
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      rfisOpen: 1,
      submittalsOpen: 1,
      punchOpen: 1,
      sheets: 1,
      models: 1,
      assets: 1,
      signalsOpen: 1,
    });
  });
});
