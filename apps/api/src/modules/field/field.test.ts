/**
 * Integration tests — RFIs, submittals, daily logs, field settings, the
 * escalation ladder, the integrity hook and health inputs. Punch,
 * observations and photos live in field-punch-photos.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  companyMemberships,
  fieldEscalations,
  ledgerEntries,
  notifications,
  projectMemberships,
  projects,
  signals,
  submittalReviewSteps,
  submittals,
  timecards,
  vendors,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO, todayISO } from "./dates.js";

let built: BuiltApp;
let owner: TestActor;
let engineer: TestActor; // field_engineer: rfis/daily_logs/punch/photos standard, submittals read
let pm: TestActor; // project_manager: admin on field tools
let sub: TestActor; // subcontractor: standard on field tools
let stranger: TestActor; // another company
let projectId: string;
let H: (a: TestActor) => Record<string, string>;

beforeAll(async () => {
  built = await buildTestApp();
  owner = await registerActor(built.app);
  engineer = await registerActor(built.app);
  pm = await registerActor(built.app);
  sub = await registerActor(built.app);
  stranger = await registerActor(built.app);
  H = (a) => ({ authorization: `Bearer ${a.accessToken}`, "x-company-id": owner.companyId });
  for (const u of [engineer, pm, sub]) {
    await built.app.db.insert(companyMemberships).values({ id: newId("cm"), companyId: owner.companyId, userId: u.userId, role: "member" });
  }
  projectId = newId("prj");
  await built.app.db.insert(projects).values({ id: projectId, companyId: owner.companyId, name: "Field P1", latitude: 51.5, longitude: -0.12 });
  const templates: Array<[TestActor, string]> = [
    [engineer, "field_engineer"],
    [pm, "project_manager"],
    [sub, "subcontractor"],
  ];
  for (const [u, templateKey] of templates) {
    await built.app.db.insert(projectMemberships).values({ id: newId("pm"), companyId: owner.companyId, projectId, userId: u.userId, templateKey, overrides: {} });
  }
});

afterAll(async () => {
  await built.close();
});

const inject = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, headers: Record<string, string>, payload?: unknown) =>
  built.app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });

const api = (path: string) => `/api/v1/projects/${projectId}${path}`;

/* ------------------------------------------------------------------ */
/* RFIs                                                                */
/* ------------------------------------------------------------------ */

describe("RFIs", () => {
  let rfiId: string;

  it("creates, issues, restricts the official response to the ball-in-court holder and adopts a draft", async () => {
    const create = await inject("POST", api("/rfis"), H(owner), {
      subject: "Rebar spacing at grid B2",
      question: "Drawing S-201 shows 150mm; spec says 200mm. Which governs?",
      assigneeId: engineer.userId,
      distribution: [pm.userId],
      relatedRfiIds: [],
    });
    expect(create.statusCode).toBe(201);
    const rfi = create.json();
    rfiId = rfi.id;
    expect(rfi.number).toBe(1);
    expect(rfi.status).toBe("draft");
    expect(rfi.ballInCourtId).toBe(engineer.userId);

    const issue = await inject("POST", api(`/rfis/${rfiId}/issue`), H(owner));
    expect(issue.statusCode).toBe(200);
    expect(issue.json().status).toBe("open");
    expect(issue.json().issuedAt).toBeTruthy();
    expect(issue.json().dueDate).toBe(addDaysISO(todayISO(), 7));

    // A subcontractor with standard rfis access is NOT the ball in court: no official answer.
    const wrong = await inject("POST", api(`/rfis/${rfiId}/respond`), H(sub), { officialResponse: "200mm" });
    expect(wrong.statusCode).toBe(403);

    // …but may propose a draft response (#311)
    const draft = await inject("POST", api(`/rfis/${rfiId}/responses`), H(sub), { body: "200mm governs per spec 03 20 00.", costImpact: "no" });
    expect(draft.statusCode).toBe(201);
    const draftId = draft.json().id;

    // The question is locked once issued
    const lock = await inject("PATCH", api(`/rfis/${rfiId}`), H(owner), { question: "changed" });
    expect(lock.statusCode).toBe(400);
    const okPatch = await inject("PATCH", api(`/rfis/${rfiId}`), H(owner), { costImpact: "tbd", dueDate: addDaysISO(todayISO(), 10) });
    expect(okPatch.statusCode).toBe(200);
    const updateEntry = await built.app.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.objectId, rfiId), eq(ledgerEntries.action, "update")));
    expect((updateEntry[0]?.payload as { changed: string[] }).changed.sort()).toEqual(["costImpact", "dueDate"]);

    // Creator adopts the subcontractor's draft as the official answer
    const adopt = await inject("POST", api(`/rfis/${rfiId}/responses/${draftId}/adopt`), H(owner));
    expect(adopt.statusCode).toBe(200);
    expect(adopt.json().status).toBe("answered");
    expect(adopt.json().respondedBy).toBe(sub.userId);
    expect(adopt.json().officialResponse).toContain("200mm");
    expect(adopt.json().responses.find((r: { id: string }) => r.id === draftId).status).toBe("adopted");

    const close = await inject("POST", api(`/rfis/${rfiId}/close`), H(owner));
    expect(close.json().status).toBe("closed");
  });

  it("validates referenced users, restricts void to creator/admin, and hides private drafts", async () => {
    const bad = await inject("POST", api("/rfis"), H(owner), { subject: "x", question: "y", assigneeId: "usr_nobody" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toContain("usr_nobody");

    const priv = await inject("POST", api("/rfis"), H(sub), { subject: "Private draft", question: "internal", isPrivate: true });
    expect(priv.statusCode).toBe(201);
    const privId = priv.json().id;
    const hidden = await inject("GET", api(`/rfis/${privId}`), H(engineer));
    expect(hidden.statusCode).toBe(404);
    const listed = await inject("GET", api("/rfis?status=draft"), H(engineer));
    expect(listed.json().items.some((r: { id: string }) => r.id === privId)).toBe(false);
    const asAdmin = await inject("GET", api(`/rfis/${privId}`), H(owner));
    expect(asAdmin.statusCode).toBe(200);

    const voidByOther = await inject("POST", api(`/rfis/${privId}/void`), H(engineer));
    expect(voidByOther.statusCode).toBe(404); // cannot even see it
    const open = await inject("POST", api("/rfis"), H(owner), { subject: "Voidable", question: "q" });
    const voidBySub = await inject("POST", api(`/rfis/${open.json().id}/void`), H(sub));
    expect(voidBySub.statusCode).toBe(403);
    const voidByCreator = await inject("POST", api(`/rfis/${open.json().id}/void`), H(owner));
    expect(voidByCreator.statusCode).toBe(200);
  });

  it("reports analytics measured from issue, ageing buckets and ball in court", async () => {
    const late = await inject("POST", api("/rfis"), H(owner), { subject: "Late RFI", question: "Overdue?", dueDate: addDaysISO(todayISO(), -12), assigneeId: pm.userId });
    await inject("POST", api(`/rfis/${late.json().id}/issue`), H(owner));
    const list = await inject("GET", api("/rfis?overdue=true"), H(owner));
    expect(list.json().items.map((r: { id: string }) => r.id)).toEqual([late.json().id]);
    expect(list.json().items[0].daysOverdue).toBe(12);

    const analytics = await inject("GET", api("/rfis/analytics"), H(owner));
    expect(analytics.statusCode).toBe(200);
    const a = analytics.json();
    expect(a.overdue).toBe(1);
    expect(a.cycleTimeBasis).toContain("Issued");
    expect(a.answeredCount).toBe(1);
    expect(a.ballInCourt.find((b: { userId: string }) => b.userId === pm.userId).overdue).toBe(1);

    const ageing = await inject("GET", api("/rfis/ageing?groupBy=ballInCourt"), H(engineer));
    expect(ageing.statusCode).toBe(200);
    expect(ageing.json().total).toBe(1);
    expect(ageing.json().groups[0].key).toBe(pm.userId);
  });

  it("ingests inbound email as a draft RFI and as a draft response to an existing one", async () => {
    const created = await inject("POST", api("/rfis/inbound"), H(owner), {
      email: { from: "Site Agent <agent@example.com>", subject: "Fwd: Slab edge detail at C4", text: "Please confirm the slab edge detail.\n\nOn Tue wrote:\n> old stuff", messageId: "<m1@example.com>" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().action).toBe("created_rfi");
    expect(created.json().rfi.source).toBe("email");
    expect(created.json().rfi.subject).toBe("Slab edge detail at C4");
    expect(created.json().rfi.question).not.toContain("old stuff");

    const open = await inject("POST", api("/rfis"), H(owner), { subject: "Anchor bolts", question: "Grade?", assigneeId: engineer.userId });
    await inject("POST", api(`/rfis/${open.json().id}/issue`), H(owner));
    const reply = await inject("POST", api("/rfis/inbound"), H(owner), {
      email: { from: "eng@example.com", subject: `RE: RFI-${String(open.json().number).padStart(3, "0")} Anchor bolts`, text: "Grade 8.8 per spec." },
    });
    expect(reply.statusCode).toBe(201);
    expect(reply.json().action).toBe("draft_response");
    const detail = await inject("GET", api(`/rfis/${open.json().id}`), H(owner));
    expect(detail.json().responses).toHaveLength(1);
  });

  it("is tenant-scoped: another company cannot read this project's RFIs", async () => {
    const res = await inject("GET", api(`/rfis/${rfiId}`), { authorization: `Bearer ${stranger.accessToken}`, "x-company-id": stranger.companyId });
    expect([403, 404]).toContain(res.statusCode);
  });
});

/* ------------------------------------------------------------------ */
/* Submittals                                                          */
/* ------------------------------------------------------------------ */

describe("Submittals", () => {
  let submittalId: string;

  it("back-computes submit-by, runs a parallel-then-sequential chain with explicit code precedence", async () => {
    const res = await inject("POST", api("/submittals"), H(owner), {
      title: "Curtain wall shop drawings",
      submittalType: "shop_drawing",
      specSection: "08 44 13",
      requiredOnSite: "2026-12-01",
      leadTimeDays: 30,
      distribution: [engineer.userId],
    });
    expect(res.statusCode).toBe(201);
    submittalId = res.json().id;
    expect(res.json().submitByDate).toBe("2026-10-18");

    const steps = await inject("POST", api(`/submittals/${submittalId}/review-steps`), H(owner), {
      steps: [
        { reviewerId: engineer.userId, position: 0, isParallel: true },
        { reviewerId: pm.userId, position: 0, isParallel: true },
        { reviewerId: sub.userId, position: 1 },
      ],
    });
    expect(steps.statusCode).toBe(200);
    const byReviewer = (id: string) => steps.json().items.find((s: { reviewerId: string }) => s.reviewerId === id).id;

    const submit = await inject("POST", api(`/submittals/${submittalId}/submit`), H(owner));
    expect(submit.json().status).toBe("in_review");
    expect(submit.json().ballInCourtId).toBe(engineer.userId);

    // Position 1 cannot respond before the parallel group at position 0 is done
    const early = await inject("POST", `/api/v1/submittal-steps/${byReviewer(sub.userId)}/respond`, H(sub), { responseCode: "approved" });
    expect(early.statusCode).toBe(400);
    // A reviewer with read-only access to the tool may still respond to their own step
    const first = await inject("POST", `/api/v1/submittal-steps/${byReviewer(engineer.userId)}/respond`, H(engineer), { responseCode: "approved_as_noted", comments: "Fix mullion anchor." });
    expect(first.statusCode).toBe(200);
    expect(first.json().submittalStatus).toBe("in_review");
    // Not the reviewer, not admin
    const impostor = await inject("POST", `/api/v1/submittal-steps/${byReviewer(pm.userId)}/respond`, H(sub), { responseCode: "approved" });
    expect(impostor.statusCode).toBe(403);
    const second = await inject("POST", api(`/submittals/${submittalId}/steps/${byReviewer(pm.userId)}/respond`), H(pm), { responseCode: "approved" });
    expect(second.json().ballInCourtId).toBe(sub.userId);
    const unknown = await inject("POST", `/api/v1/submittal-steps/${byReviewer(sub.userId)}/respond`, H(sub), { responseCode: "not_a_code" });
    expect(unknown.statusCode).toBe(400);
    const last = await inject("POST", `/api/v1/submittal-steps/${byReviewer(sub.userId)}/respond`, H(sub), { responseCode: "for_record" });
    expect(last.json().submittalStatus).toBe("responded");
    // approved_as_noted outranks approved and for_record
    expect(last.json().finalCode).toBe("approved_as_noted");

    const notified = await built.app.db.select().from(notifications).where(and(eq(notifications.userId, engineer.userId), eq(notifications.recordId, submittalId)));
    expect(notified.some((n) => n.title.includes("responded"))).toBe(true);
  });

  it("keeps a pure for_record chain as for_record and resubmits exactly once, superseding the parent", async () => {
    const res = await inject("POST", api("/submittals"), H(owner), { title: "Mock-up photos", submittalType: "mock_up" });
    const id = res.json().id;
    await inject("POST", api(`/submittals/${id}/review-steps`), H(owner), { steps: [{ reviewerId: pm.userId, position: 0 }] });
    await inject("POST", api(`/submittals/${id}/submit`), H(owner));
    const stepId = (await inject("GET", api(`/submittals/${id}`), H(owner))).json().reviewSteps[0].id;
    const fr = await inject("POST", `/api/v1/submittal-steps/${stepId}/respond`, H(pm), { responseCode: "for_record" });
    expect(fr.json().finalCode).toBe("for_record");
    const noResubmit = await inject("POST", api(`/submittals/${id}/resubmit`), H(owner));
    expect(noResubmit.statusCode).toBe(400);

    const rr = await inject("POST", api("/submittals"), H(owner), { title: "Steel shop drawings", submittalType: "shop_drawing", specSection: "05 12 00", fileIds: ["fil_a"] });
    const rrId = rr.json().id;
    await inject("POST", api(`/submittals/${rrId}/review-steps`), H(owner), { steps: [{ reviewerId: pm.userId, position: 0 }] });
    await inject("POST", api(`/submittals/${rrId}/submit`), H(owner));
    const rrStep = (await inject("GET", api(`/submittals/${rrId}`), H(owner))).json().reviewSteps[0].id;
    await inject("POST", `/api/v1/submittal-steps/${rrStep}/respond`, H(pm), { responseCode: "revise_and_resubmit", comments: "Update anchors." });
    const rev1 = await inject("POST", api(`/submittals/${rrId}/resubmit`), H(owner), { copyFiles: true, copyReviewChain: true });
    expect(rev1.statusCode).toBe(201);
    expect(rev1.json().revision).toBe(1);
    expect(rev1.json().fileIds).toEqual(["fil_a"]);
    expect((await inject("GET", api(`/submittals/${rev1.json().id}`), H(owner))).json().reviewSteps).toHaveLength(1);
    const again = await inject("POST", api(`/submittals/${rrId}/resubmit`), H(owner));
    expect(again.statusCode).toBe(409);
    const parent = await inject("GET", api(`/submittals/${rrId}`), H(owner));
    expect(parent.json().status).toBe("superseded");
    expect(parent.json().supersededById).toBe(rev1.json().id);
    expect(parent.json().revisions.map((r: { revision: number }) => r.revision)).toEqual([0, 1]);
  });

  it("recomputes ball-in-court when the pending chain is replaced mid-review and repairs a stranded record", async () => {
    const res = await inject("POST", api("/submittals"), H(owner), { title: "Sample tiles", submittalType: "sample" });
    const id = res.json().id;
    await inject("POST", api(`/submittals/${id}/review-steps`), H(owner), { steps: [{ reviewerId: engineer.userId, position: 0 }] });
    await inject("POST", api(`/submittals/${id}/submit`), H(owner));
    const replaced = await inject("POST", api(`/submittals/${id}/review-steps`), H(owner), { steps: [{ reviewerId: pm.userId, position: 0 }, { reviewerId: sub.userId, position: 1 }] });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().ballInCourtId).toBe(pm.userId);
    const pmNotified = await built.app.db.select().from(notifications).where(and(eq(notifications.userId, pm.userId), eq(notifications.recordId, id)));
    expect(pmNotified.length).toBeGreaterThan(0);

    // Strand it the way the old race did: every step answered, status still in_review.
    await built.app.db.update(submittalReviewSteps).set({ responseCode: "approved", respondedAt: new Date().toISOString() }).where(eq(submittalReviewSteps.submittalId, id));
    const detail = await inject("GET", api(`/submittals/${id}`), H(owner));
    expect(detail.json().stranded).toBe(true);
    const repair = await inject("POST", api(`/submittals/${id}/recompute`), H(owner));
    expect(repair.json().action).toBe("finalised");
    expect(repair.json().submittal.status).toBe("responded");
    expect(repair.json().submittal.responseCode).toBe("approved");
  });

  it("generates a schedule from spec sections, segregates closeout and reports analytics", async () => {
    const preview = await inject("POST", api("/submittals/schedule"), H(owner), {
      items: [
        { specSection: "01 78 23", title: "O&M manuals", submittalType: "o_and_m", requiredOnSite: "2027-03-01" },
        { specSection: "09 91 00", title: "Paint samples", submittalType: "sample" },
      ],
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().preview).toBe(true);
    expect(preview.json().items[1].reason).toContain("No required-on-site");
    const created = await inject("POST", api("/submittals/schedule"), H(owner), { items: preview.json().items, create: true });
    expect(created.statusCode).toBe(201);
    expect(created.json().items).toHaveLength(2);
    const closeout = await inject("GET", api("/submittals/closeout"), H(engineer));
    expect(closeout.json().byType.o_and_m.total).toBe(1);
    const filtered = await inject("GET", api("/submittals?closeout=true"), H(owner));
    expect(filtered.json().items.every((s: { isCloseout: number }) => s.isCloseout === 1)).toBe(true);

    const analytics = await inject("GET", api("/submittals/analytics"), H(owner));
    expect(analytics.statusCode).toBe(200);
    const a = analytics.json();
    expect(a.byStatus.responded).toBeGreaterThanOrEqual(2);
    expect(a.reviewers.find((r: { reviewerId: string }) => r.reviewerId === pm.userId).responded).toBeGreaterThanOrEqual(2);
    expect(a.resubmissionBySpecSection.find((r: { specSection: string }) => r.specSection === "05 12 00").revisions).toBe(1);
    expect(a.basis).toContain("activatedAt");
  });

  it("lets a company admin configure the response-code set and rejects a set without a resubmit code", async () => {
    const bad = await inject("PUT", "/api/v1/submittal-response-codes", H(owner), { codes: [{ code: "ok", label: "OK", isApproval: true }] });
    expect(bad.statusCode).toBe(400);
    const notAdmin = await inject("PUT", "/api/v1/submittal-response-codes", H(engineer), { codes: [{ code: "ok", label: "OK", isApproval: true }, { code: "redo", label: "Redo", isResubmit: true }] });
    expect(notAdmin.statusCode).toBe(403);
    const ok = await inject("PUT", "/api/v1/submittal-response-codes", H(owner), {
      codes: [{ code: "no_exceptions", label: "No exceptions taken", isApproval: true }, { code: "redo", label: "Redo", isResubmit: true }],
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().custom).toBe(true);
    const codes = await inject("GET", "/api/v1/submittal-response-codes", H(sub));
    expect(codes.json().items.map((c: { code: string }) => c.code)).toEqual(["no_exceptions", "redo"]);
    // built-in code is no longer accepted once a custom set exists
    const res = await inject("POST", api("/submittals"), H(owner), { title: "Custom code chain" });
    await inject("POST", api(`/submittals/${res.json().id}/review-steps`), H(owner), { steps: [{ reviewerId: pm.userId, position: 0 }] });
    await inject("POST", api(`/submittals/${res.json().id}/submit`), H(owner));
    const stepId = (await inject("GET", api(`/submittals/${res.json().id}`), H(owner))).json().reviewSteps[0].id;
    const legacy = await inject("POST", `/api/v1/submittal-steps/${stepId}/respond`, H(pm), { responseCode: "approved" });
    expect(legacy.statusCode).toBe(400);
    const custom = await inject("POST", `/api/v1/submittal-steps/${stepId}/respond`, H(pm), { responseCode: "no_exceptions" });
    expect(custom.json().finalCode).toBe("no_exceptions");
  });

  it("is tenant-scoped for id-addressed step responses", async () => {
    const row = (await built.app.db.select().from(submittalReviewSteps).limit(1))[0]!;
    const res = await inject("POST", `/api/v1/submittal-steps/${row.id}/respond`, { authorization: `Bearer ${stranger.accessToken}`, "x-company-id": stranger.companyId }, { responseCode: "approved" });
    expect(res.statusCode).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/* Daily logs                                                          */
/* ------------------------------------------------------------------ */

describe("Daily logs", () => {
  const date = "2026-08-12"; // a Wednesday
  let logId: string;

  it("merges sections by key instead of replacing them, and clears with null", async () => {
    const first = await inject("PUT", api(`/daily-logs/${date}`), H(engineer), {
      sections: { manpower: [{ company: "Acme Concrete", workers: 12, hours: 96 }], visitors: [{ name: "Inspector Jane", company: "City" }] },
      weather: { tempC: 28, conditions: "sunny" },
      notes: "Pour at L3 east.",
    });
    expect(first.statusCode).toBe(201);
    logId = first.json().id;
    expect(first.json().weatherSource).toBe("manual");

    const second = await inject("PUT", api(`/daily-logs/${date}`), H(engineer), { sections: { delays: [{ cause: "Weather", description: "Wind stopped crane", hoursLost: 2 }] }, notes: "Finished 15:40." });
    expect(second.statusCode).toBe(200);
    expect(second.json().sections.manpower).toHaveLength(1);
    expect(second.json().sections.visitors).toHaveLength(1);
    expect(second.json().sections.delays).toHaveLength(1);

    const cleared = await inject("PUT", api(`/daily-logs/${date}`), H(engineer), { sections: { visitors: null } });
    expect(cleared.json().sections.visitors).toBeUndefined();
    expect(cleared.json().sections.manpower).toHaveLength(1);

    const fractional = await inject("PUT", api(`/daily-logs/${date}`), H(engineer), { sections: { manpower: [{ company: "X", workers: 2.5, hours: 1 }] } });
    expect(fractional.statusCode).toBe(400);
    const future = await inject("PUT", api(`/daily-logs/${addDaysISO(todayISO(), 3)}`), H(engineer), { notes: "tomorrow" });
    expect(future.statusCode).toBe(400);
  });

  it("never shows another user's draft as the caller's own", async () => {
    const asOwner = await inject("GET", api(`/daily-logs/${date}`), H(owner));
    expect(asOwner.statusCode).toBe(200);
    expect(asOwner.json().log).toBeNull();
    expect(asOwner.json().isMine).toBe(false);
    expect(asOwner.json().hasOwn).toBe(false);
    expect(asOwner.json().logs).toHaveLength(1);
    const theirs = await inject("GET", api(`/daily-logs/${date}?createdBy=${engineer.userId}`), H(owner));
    expect(theirs.json().log.id).toBe(logId);
    expect(theirs.json().isMine).toBe(false);
    const mine = await inject("GET", api(`/daily-logs/${date}`), H(engineer));
    expect(mine.json().isMine).toBe(true);
  });

  it("submits, refuses non-admin and self approval, approves with distribution and exports HTML", async () => {
    await inject("PUT", "/api/v1" + `/projects/${projectId}/field/settings`, H(owner), { dailyLog: { distribution: [pm.userId], weatherAuto: true, reconciliationThresholdPct: 15 } });
    const submit = await inject("POST", api(`/daily-logs/${date}/submit`), H(engineer));
    expect(submit.statusCode).toBe(200);
    expect(submit.json().submittedAt).toBeTruthy();
    const notAdmin = await inject("POST", api(`/daily-logs/${date}/approve`), H(sub), {});
    expect(notAdmin.statusCode).toBe(403);
    // engineer holds standard, not admin, on daily_logs — and is the creator
    const self = await inject("POST", api(`/daily-logs/${date}/approve`), H(engineer), {});
    expect(self.statusCode).toBe(403);
    const approve = await inject("POST", api(`/daily-logs/${date}/approve`), H(pm), { createdBy: engineer.userId });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().status).toBe("approved");
    expect(approve.json().distributedTo).toContain(engineer.userId);
    const locked = await inject("PUT", api(`/daily-logs/${date}`), H(engineer), { notes: "sneaky" });
    expect(locked.statusCode).toBe(409);

    // The integrity hook flags an approval seconds after submission.
    const rushed = await built.app.db.select().from(signals).where(and(eq(signals.companyId, owner.companyId), eq(signals.detector, "field_daily_log_rushed_approval")));
    expect(rushed).toHaveLength(1);

    const html = await inject("GET", api(`/daily-logs/${date}/export?createdBy=${engineer.userId}`), H(owner));
    expect(html.statusCode).toBe(200);
    expect(html.headers["content-type"]).toContain("text/html");
    expect(html.body).toContain("Acme Concrete");
  });

  it("consolidates the site day, applies templates on first save and carries structure forward", async () => {
    const other = await inject("PUT", api(`/daily-logs/${date}`), H(sub), { logKind: "subcontractor", sections: { manpower: [{ company: "Acme Concrete", workers: 3, hours: 24 }] } });
    expect(other.statusCode).toBe(400); // subcontractor log must name its vendor
    const vendorId = newId("ven");
    await built.app.db.insert(vendors).values({ id: vendorId, companyId: owner.companyId, name: "Acme Concrete" });
    const ok = await inject("PUT", api(`/daily-logs/${date}`), H(sub), { logKind: "subcontractor", vendorId, sections: { manpower: [{ company: "Acme Concrete", workers: 3, hours: 24 }] } });
    expect(ok.statusCode).toBe(201);
    await inject("POST", api(`/daily-logs/${date}/submit`), H(sub));
    const day = await inject("GET", api(`/daily-logs/${date}/consolidated`), H(owner));
    expect(day.statusCode).toBe(200);
    expect(day.json().logs).toHaveLength(2);
    expect(day.json().totalWorkers).toBe(15);
    expect(day.json().manpower[0].sources).toBe(2);

    const tpl = await inject("POST", api("/daily-logs/templates"), H(pm), { name: "Standard crews", isDefault: true, sections: { manpower: [{ company: "Acme Concrete", workers: 0, hours: 0 }, { company: "Sparks Electrical", workers: 0, hours: 0 }] } });
    expect(tpl.statusCode).toBe(201);
    const nextDay = "2026-08-13";
    const seeded = await inject("PUT", api(`/daily-logs/${nextDay}`), H(engineer), { notes: "Template day" });
    expect(seeded.statusCode).toBe(201);
    expect(seeded.json().templateId).toBe(tpl.json().id);
    expect(seeded.json().sections.manpower).toHaveLength(2);

    const carried = await inject("POST", api(`/daily-logs/2026-08-14/carry-forward`), H(engineer));
    expect(carried.statusCode).toBe(201);
    expect(carried.json().from).toBe(date);
    expect(carried.json().log.sections.manpower[0]).toEqual({ company: "Acme Concrete", workers: 0, hours: 0 });

    const templates = await inject("GET", api("/daily-logs/templates"), H(engineer));
    expect(templates.json().items).toHaveLength(1);
    const del = await inject("DELETE", api(`/daily-logs/templates/${tpl.json().id}`), H(pm));
    expect(del.json().deleted).toBe(true);
  });

  it("reports missing days and per-creator compliance", async () => {
    const missing = await inject("GET", api("/daily-logs/missing?from=2026-08-10&to=2026-08-16"), H(owner));
    expect(missing.json().days).toEqual(["2026-08-10", "2026-08-11", "2026-08-13", "2026-08-14"]);
    const compliance = await inject("GET", api("/daily-logs/compliance?from=2026-08-10&to=2026-08-14"), H(owner));
    expect(compliance.statusCode).toBe(200);
    const row = compliance.json().items.find((r: { createdBy: string }) => r.createdBy === engineer.userId);
    expect(row.expected).toBe(5);
    expect(row.submitted).toBe(1);
    expect(row.pct).toBe(20);
  });

  it("reconciles logged manpower against timecards and raises a signal on variance", async () => {
    const none = await inject("GET", api(`/daily-logs/${date}/reconciliation`), H(owner));
    expect(none.json().variances).toEqual([]);
    expect(none.json().reasons[0]).toContain("No timecards");
    const vendorId = (await built.app.db.select().from(vendors).where(eq(vendors.companyId, owner.companyId)).limit(1))[0]!.id;
    await built.app.db.insert(timecards).values({
      id: newId("tc"),
      companyId: owner.companyId,
      projectId,
      number: 1,
      reference: "TC-0001",
      workerId: "wrk_1",
      vendorId,
      workDate: date,
      regularHours: 40,
      totalHours: 40,
      status: "approved",
      createdBy: owner.userId,
    });
    const notAdmin = await inject("POST", api(`/daily-logs/${date}/reconcile`), H(engineer), {});
    expect(notAdmin.statusCode).toBe(403);
    const rec = await inject("POST", api(`/daily-logs/${date}/reconcile`), H(pm), {});
    expect(rec.statusCode).toBe(200);
    const acme = rec.json().variances.find((v: { key: string }) => v.key === "acme concrete");
    expect(acme.loggedHours).toBe(120);
    expect(acme.timecardHours).toBe(40);
    expect(acme.flagged).toBe(true);
    expect(rec.json().signalsRaised).toBe(1);
    const again = await inject("POST", api(`/daily-logs/${date}/reconcile`), H(pm), {});
    expect(again.json().signalsRaised).toBe(0);
  });

  it("captures weather honestly: disabled in tests, so it reports the reason", async () => {
    const res = await inject("POST", api(`/daily-logs/2026-08-13/weather`), H(engineer));
    expect(res.statusCode).toBe(200);
    expect(res.json().captured).toBe(false);
    expect(res.json().reason).toContain("disabled");
  });
});

/* ------------------------------------------------------------------ */
/* Settings, escalation ladder, integrity, health                      */
/* ------------------------------------------------------------------ */

describe("Field settings, escalations, integrity and health", () => {
  it("stores per-project settings with validated users and admin-only writes", async () => {
    const defaults = await inject("GET", api("/field/settings"), H(engineer));
    expect(defaults.json().settings.escalation.stepDays).toBe(3);
    const denied = await inject("PUT", api("/field/settings"), H(engineer), { escalation: { stepDays: 2 } });
    expect(denied.statusCode).toBe(403);
    const bad = await inject("PUT", api("/field/settings"), H(pm), { escalation: { pmUserIds: ["usr_ghost"] } });
    expect(bad.statusCode).toBe(400);
    const ok = await inject("PUT", api("/field/settings"), H(pm), { escalation: { stepDays: 3, pmUserIds: [pm.userId] }, punch: { requireVerifier: true } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().settings.punch.requireVerifier).toBe(true);
  });

  it("climbs the ladder once per rung and raises one signal, idempotently, via the scheduler", async () => {
    const before = (await built.app.db.select().from(fieldEscalations).where(eq(fieldEscalations.projectId, projectId))).length;
    const status = await built.app.scheduler.runNow("field.overdue-escalation");
    expect(status.state).toBe("succeeded");
    const rows = await built.app.db.select().from(fieldEscalations).where(eq(fieldEscalations.projectId, projectId));
    expect(rows.length).toBeGreaterThan(before);
    // The 12-days-overdue RFI is past 2×stepDays: all three rungs fire.
    const lateRfi = (await inject("GET", api("/rfis?overdue=true"), H(owner))).json().items[0];
    const ladder = rows.filter((r) => r.recordType === "rfi" && r.recordId === lateRfi.id).map((r) => r.level).sort();
    expect(ladder).toEqual([1, 2, 3]);
    const overdueNotice = await built.app.db.select().from(notifications).where(and(eq(notifications.userId, pm.userId), eq(notifications.kind, "overdue")));
    expect(overdueNotice.length).toBeGreaterThan(0);
    const sig = await built.app.db.select().from(signals).where(and(eq(signals.companyId, owner.companyId), eq(signals.detector, "field_overdue_escalation")));
    expect(sig.length).toBeGreaterThanOrEqual(1);
    // Missing business days produce daily_log rungs for the PMs.
    expect(rows.some((r) => r.recordType === "daily_log")).toBe(true);

    const again = await inject("POST", api("/field/escalations/run"), H(pm));
    expect(again.statusCode).toBe(200);
    const after = await built.app.db.select().from(fieldEscalations).where(eq(fieldEscalations.projectId, projectId));
    expect(after.length).toBe(rows.length);
    const list = await inject("GET", api("/field/escalations"), H(engineer));
    expect(list.json().byLevel["3"]).toBeGreaterThanOrEqual(1);
    const denied = await inject("POST", api("/field/escalations/run"), H(engineer));
    expect(denied.statusCode).toBe(403);
  });

  it("flags an RFI answered by its own author through the ledger hook", async () => {
    const res = await inject("POST", api("/rfis"), H(owner), { subject: "Self answer", question: "q", assigneeId: owner.userId });
    await inject("POST", api(`/rfis/${res.json().id}/issue`), H(owner));
    const answer = await inject("POST", api(`/rfis/${res.json().id}/respond`), H(owner), { officialResponse: "I answer myself" });
    expect(answer.statusCode).toBe(200);
    const sig = await built.app.db.select().from(signals).where(and(eq(signals.companyId, owner.companyId), eq(signals.detector, "field_rfi_self_answered")));
    expect(sig).toHaveLength(1);
    expect((sig[0]!.evidenceRefs as { rfiId: string }).rfiId).toBe(res.json().id);
  });

  it("exposes health inputs with reasons instead of fabricated zeros", async () => {
    const res = await inject("GET", api("/field/health-inputs"), H(engineer));
    expect(res.statusCode).toBe(200);
    expect(res.json().metrics.rfisOverdue).toBe(1);
    expect(res.json().metrics.submittalsOpen).toBeGreaterThan(0);
    expect(typeof res.json().metrics.dailyLogMissingDays14).toBe("number");
    const fresh = newId("prj");
    await built.app.db.insert(projects).values({ id: fresh, companyId: owner.companyId, name: "Empty" });
    const empty = await inject("GET", `/api/v1/projects/${fresh}/field/health-inputs`, H(owner));
    expect(empty.json().metrics.dailyLogMissingDays14).toBeNull();
    expect(empty.json().reasons.length).toBeGreaterThan(0);
  });

  it("keeps the stranger out of every field route on this project", async () => {
    const S = { authorization: `Bearer ${stranger.accessToken}`, "x-company-id": stranger.companyId };
    for (const path of ["/field/settings", "/field/escalations", "/field/health-inputs", "/daily-logs", "/submittals/analytics"]) {
      const res = await inject("GET", api(path), S);
      expect([403, 404]).toContain(res.statusCode);
    }
    const write = await inject("PUT", api("/field/settings"), S, { escalation: { stepDays: 1 } });
    expect([403, 404]).toContain(write.statusCode);
    expect((await built.app.db.select().from(submittals).where(eq(submittals.companyId, stranger.companyId))).length).toBe(0);
  });
});
