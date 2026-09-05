import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companyMemberships, projectMemberships, projects } from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";

let built: BuiltApp;
let owner: TestActor;
let engineer: TestActor;
let sub: TestActor;
let projectId: string;
let H: (a: TestActor) => Record<string, string>;

beforeAll(async () => {
  built = await buildTestApp();
  owner = await registerActor(built.app);
  engineer = await registerActor(built.app);
  sub = await registerActor(built.app);
  H = (a) => ({ authorization: `Bearer ${a.accessToken}`, "x-company-id": owner.companyId });
  for (const u of [engineer, sub]) {
    await built.app.db.insert(companyMemberships).values({ id: newId("cm"), companyId: owner.companyId, userId: u.userId, role: "member" });
  }
  projectId = newId("prj");
  await built.app.db.insert(projects).values({ id: projectId, companyId: owner.companyId, name: "Probe P", latitude: 51.5, longitude: -0.12 });
  for (const [u, templateKey] of [[engineer, "field_engineer"], [sub, "subcontractor"]] as Array<[TestActor, string]>) {
    await built.app.db.insert(projectMemberships).values({ id: newId("pm"), companyId: owner.companyId, projectId, userId: u.userId, templateKey, overrides: {} });
  }
});
afterAll(async () => { await built.close(); });

const inject = (method: "GET" | "POST" | "PATCH", url: string, headers: Record<string, string>, payload?: unknown) =>
  built.app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });
const api = (p: string) => `/api/v1/projects/${projectId}${p}`;

describe("probe", () => {
  it("does not leak a private RFI's subject through relatedRfiIds", async () => {
    const priv = await inject("POST", api("/rfis"), H(sub), { subject: "SECRET-SUBJECT-LINE", question: "internal", isPrivate: true });
    expect(priv.statusCode).toBe(201);
    const privId = priv.json().id as string;
    // engineer cannot see it directly
    expect((await inject("GET", api(`/rfis/${privId}`), H(engineer))).statusCode).toBe(404);
    // ... but can reference it from their own RFI
    const mine = await inject("POST", api("/rfis"), H(engineer), { subject: "Mine", question: "q", relatedRfiIds: [privId] });
    // eslint-disable-next-line no-console
    console.log("CREATE-WITH-RELATED", mine.statusCode, JSON.stringify(mine.json()).slice(0, 300));
    if (mine.statusCode === 201) {
      const detail = await inject("GET", api(`/rfis/${mine.json().id}`), H(engineer));
      // eslint-disable-next-line no-console
      console.log("RELATED-BLOCK", JSON.stringify(detail.json().related));
      expect(JSON.stringify(detail.json().related)).not.toContain("SECRET-SUBJECT-LINE");
    }
  });

  it("does not let a standard user close an RFI they have nothing to do with", async () => {
    const r = await inject("POST", api("/rfis"), H(owner), { subject: "Owner RFI", question: "q" });
    const id = r.json().id as string;
    await inject("POST", api(`/rfis/${id}/issue`), H(owner));
    const closed = await inject("POST", api(`/rfis/${id}/close`), H(sub));
    // eslint-disable-next-line no-console
    console.log("CLOSE-BY-SUB", closed.statusCode, closed.json().status ?? closed.json().message);
    expect(closed.statusCode).toBe(403);
  });
});
