import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  aiReviewQueue,
  aiRuns,
  dailyLogs,
  drawingSheets,
  ledgerEntries,
  projects,
  rfis,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";
import { escapeLike, extractJson, renderSnippets, snippetAround } from "./service.js";

// The module must run in DISABLED mode for these tests regardless of the
// host environment.
delete process.env.ANTHROPIC_API_KEY;

let built: BuiltApp;
let actor: TestActor;
let projectId: string;

beforeAll(async () => {
  built = await buildTestApp();
  actor = await registerActor(built.app);
  projectId = newId("prj");
  await built.app.db.insert(projects).values({
    id: projectId,
    companyId: actor.companyId,
    name: "P1",
  });
});

afterAll(async () => {
  await built.close();
});

describe("pure helpers", () => {
  it("extractJson parses a bare object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("extractJson strips ```json fences", () => {
    expect(extractJson('```json\n{"answer":"yes"}\n```')).toEqual({ answer: "yes" });
  });

  it("extractJson strips bare ``` fences", () => {
    expect(extractJson('```\n{"x": [1,2]}\n```')).toEqual({ x: [1, 2] });
  });

  it("extractJson tolerates prose around the object", () => {
    expect(extractJson('Here is the result:\n{"ok":true}\nHope that helps!')).toEqual({
      ok: true,
    });
  });

  it("extractJson throws on malformed output", () => {
    expect(() => extractJson("no json here at all")).toThrow();
    expect(() => extractJson('{"unterminated": ')).toThrow();
  });

  it("snippetAround centres on the match and collapses whitespace", () => {
    const text = `${"x".repeat(500)}  THE   NEEDLE ${"y".repeat(500)}`;
    const snip = snippetAround(text, "needle", 100);
    expect(snip.length).toBeLessThanOrEqual(100);
    expect(snip.toLowerCase()).toContain("needle");
  });

  it("snippetAround falls back to the head when there is no match", () => {
    expect(snippetAround("abcdef", "zzz", 4)).toBe("abcd");
  });

  it("escapeLike escapes ILIKE metacharacters", () => {
    expect(escapeLike("50%_done\\x")).toBe("50\\%\\_done\\\\x");
  });

  it("renderSnippets numbers candidates with their provenance", () => {
    const out = renderSnippets([
      { type: "rfi", id: "rfi_1", label: "RFI #1", snippet: "window head detail" },
      { type: "file", id: "fil_2", label: "File spec.pdf", snippet: "spec.pdf" },
    ]);
    expect(out).toContain("[1] type=rfi id=rfi_1");
    expect(out).toContain("[2] type=file id=fil_2");
  });
});

describe("disabled mode (no ANTHROPIC_API_KEY)", () => {
  it("POST /ai/search returns 503 AiDisabled", async () => {
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/ai/search`,
      headers: actor.headers,
      payload: { query: "window head detail" },
    });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.error).toBe("AiDisabled");
    expect(body.statusCode).toBe(503);
    expect(body.message).toContain("ANTHROPIC_API_KEY");
  });

  it("other AI-invoking endpoints also return 503", async () => {
    for (const [url, payload] of [
      [`/api/v1/projects/${projectId}/ai/daily-log-draft`, { date: "2026-08-20" }],
      [`/api/v1/projects/${projectId}/ai/rfi-evaluate`, { rfiId: "rfi_x" }],
      [`/api/v1/projects/${projectId}/ai/submittal-review`, { submittalId: "sub_x" }],
      [`/api/v1/projects/${projectId}/ai/sheet-name`, { revisionId: "rev_x" }],
      [`/api/v1/projects/${projectId}/ai/photo-intel`, { photoId: "pho_x" }],
      [`/api/v1/projects/${projectId}/ai/assist`, { message: "hi" }],
      ["/api/v1/ai/assist", { message: "hi" }],
    ] as const) {
      const res = await built.app.inject({
        method: "POST",
        url,
        headers: actor.headers,
        payload,
      });
      expect(res.statusCode, url).toBe(503);
      expect(res.json().error, url).toBe("AiDisabled");
    }
  });

  it("list/review endpoints still work while disabled", async () => {
    const review = await built.app.inject({
      method: "GET",
      url: "/api/v1/ai/review?status=pending",
      headers: actor.headers,
    });
    expect(review.statusCode).toBe(200);
    expect(review.json().items).toEqual([]);

    const runs = await built.app.inject({
      method: "GET",
      url: "/api/v1/ai/runs",
      headers: actor.headers,
    });
    expect(runs.statusCode).toBe(200);
  });
});

describe("review queue approve/reject", () => {
  async function seedRun(agentKind: string): Promise<string> {
    const runId = newId("airun");
    await built.app.db.insert(aiRuns).values({
      id: runId,
      companyId: actor.companyId,
      projectId,
      agentKind,
      model: "test-model",
      requestedBy: actor.userId,
      inputRefs: [],
      status: "succeeded",
    });
    return runId;
  }

  it("approves a drawing_sheet rename: applies it, ledgers it, closes the queue row", async () => {
    const sheetId = newId("sht");
    await built.app.db.insert(drawingSheets).values({
      id: sheetId,
      companyId: actor.companyId,
      projectId,
      number: "TEMP-1",
      title: "Untitled",
      discipline: "other",
      needsReview: 1,
    });
    const runId = await seedRun("sheet_naming");
    const reviewId = newId("airev");
    await built.app.db.insert(aiReviewQueue).values({
      id: reviewId,
      companyId: actor.companyId,
      projectId,
      runId,
      targetType: "drawing_sheet",
      targetId: sheetId,
      proposal: { number: "A-101", title: "Floor Plan Level 1", discipline: "architectural" },
      summary: "Rename TEMP-1 to A-101",
      confidence: 0.92,
      status: "pending",
    });

    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/ai/review/${reviewId}/approve`,
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("approved");
    expect(res.json().applied.sheetId).toBe(sheetId);

    const [sheet] = await built.app.db
      .select()
      .from(drawingSheets)
      .where(eq(drawingSheets.id, sheetId));
    expect(sheet!.number).toBe("A-101");
    expect(sheet!.title).toBe("Floor Plan Level 1");
    expect(sheet!.discipline).toBe("architectural");
    expect(sheet!.needsReview).toBe(0);

    const [queueRow] = await built.app.db
      .select()
      .from(aiReviewQueue)
      .where(eq(aiReviewQueue.id, reviewId));
    expect(queueRow!.status).toBe("approved");
    expect(queueRow!.reviewerId).toBe(actor.userId);
    expect(queueRow!.reviewedAt).toBeTruthy();

    const entries = await built.app.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.companyId, actor.companyId));
    expect(entries.some((e) => e.objectType === "drawing_sheet" && e.objectId === sheetId)).toBe(
      true,
    );
    expect(
      entries.some(
        (e) =>
          e.objectType === "ai_review" && e.objectId === reviewId && e.action === "state_change",
      ),
    ).toBe(true);

    // re-approving is a conflict
    const again = await built.app.inject({
      method: "POST",
      url: `/api/v1/ai/review/${reviewId}/approve`,
      headers: actor.headers,
    });
    expect(again.statusCode).toBe(409);
  });

  it("approves an rfi_response: sets the official response and answers the RFI", async () => {
    const rfiId = newId("rfi");
    await built.app.db.insert(rfis).values({
      id: rfiId,
      companyId: actor.companyId,
      projectId,
      number: 1,
      subject: "Window head detail",
      question: "Which detail governs at grid 5?",
      status: "open",
      createdBy: actor.userId,
    });
    const runId = await seedRun("rfi_evaluation");
    const reviewId = newId("airev");
    await built.app.db.insert(aiReviewQueue).values({
      id: reviewId,
      companyId: actor.companyId,
      projectId,
      runId,
      targetType: "rfi_response",
      targetId: rfiId,
      proposal: {
        suggestedResponse: "Use detail 5/A-501 at grid 5.",
        costImpact: "no",
        scheduleImpact: "no",
      },
      summary: "Suggested response for RFI #1",
      status: "pending",
    });

    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/ai/review/${reviewId}/approve`,
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);

    const [rfi] = await built.app.db.select().from(rfis).where(eq(rfis.id, rfiId));
    expect(rfi!.status).toBe("answered");
    expect(rfi!.officialResponse).toBe("Use detail 5/A-501 at grid 5.");
    expect(rfi!.respondedBy).toBe(actor.userId);
    expect(rfi!.costImpact).toBe("no");
  });

  it("approves a daily_log draft: creates an aiDrafted draft log for the reviewer", async () => {
    const runId = await seedRun("daily_log_draft");
    const reviewId = newId("airev");
    await built.app.db.insert(aiReviewQueue).values({
      id: reviewId,
      companyId: actor.companyId,
      projectId,
      runId,
      targetType: "daily_log",
      targetId: "2026-08-20",
      proposal: {
        summary: "Concrete pour level 2",
        sections: { manpower: [{ company: "Acme Concrete", workers: 8 }] },
        notes: "Pour completed by 15:00.",
      },
      summary: "Draft daily log for 2026-08-20",
      status: "pending",
    });

    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/ai/review/${reviewId}/approve`,
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    const logId = res.json().applied.dailyLogId as string;

    const [log] = await built.app.db.select().from(dailyLogs).where(eq(dailyLogs.id, logId));
    expect(log!.logDate).toBe("2026-08-20");
    expect(log!.status).toBe("draft");
    expect(log!.aiDrafted).toBe(1);
    expect(log!.createdBy).toBe(actor.userId);
    expect((log!.sections as { manpower?: unknown[] }).manpower).toHaveLength(1);
  });

  it("rejects a pending item with a reason", async () => {
    const runId = await seedRun("submittal_review");
    const reviewId = newId("airev");
    await built.app.db.insert(aiReviewQueue).values({
      id: reviewId,
      companyId: actor.companyId,
      projectId,
      runId,
      targetType: "submittal_review",
      targetId: newId("sub"),
      proposal: { recommendation: "revise_and_resubmit", findings: [] },
      summary: "Advisory submittal review",
      status: "pending",
    });

    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/ai/review/${reviewId}/reject`,
      headers: actor.headers,
      payload: { reason: "Not enough evidence" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("rejected");

    const [queueRow] = await built.app.db
      .select()
      .from(aiReviewQueue)
      .where(eq(aiReviewQueue.id, reviewId));
    expect(queueRow!.status).toBe("rejected");
    expect(queueRow!.reviewerId).toBe(actor.userId);
  });

  it("does not leak review items across tenants", async () => {
    const stranger = await registerActor(built.app);
    const rows = await built.app.db
      .select()
      .from(aiReviewQueue)
      .where(eq(aiReviewQueue.companyId, actor.companyId));
    expect(rows.length).toBeGreaterThan(0);
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/ai/review/${rows[0]!.id}/approve`,
      headers: stranger.headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it("lists review items company-wide and per project", async () => {
    const company = await built.app.inject({
      method: "GET",
      url: "/api/v1/ai/review",
      headers: actor.headers,
    });
    expect(company.statusCode).toBe(200);
    expect(company.json().total).toBeGreaterThanOrEqual(4);

    const project = await built.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/ai/review?status=approved`,
      headers: actor.headers,
    });
    expect(project.statusCode).toBe(200);
    for (const item of project.json().items as { status: string; projectId: string }[]) {
      expect(item.status).toBe("approved");
      expect(item.projectId).toBe(projectId);
    }
  });
});

describe("runs audit surface", () => {
  it("lists runs newest-first with agentKind filtering", async () => {
    const res = await built.app.inject({
      method: "GET",
      url: "/api/v1/ai/runs?agentKind=sheet_naming",
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBeGreaterThanOrEqual(1);
    for (const run of body.items as { agentKind: string; companyId: string }[]) {
      expect(run.agentKind).toBe("sheet_naming");
      expect(run.companyId).toBe(actor.companyId);
    }
  });
});
