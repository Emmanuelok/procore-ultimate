import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createRecordingClient,
  describeAction,
  renderTemplate,
  signWebhookBody,
  windowStart,
} from "./actions.js";
import type { EvaluationContext } from "./predicates.js";

const ctx: EvaluationContext = {
  event: { action: "create", objectType: "rfi", objectId: "rfi_1" },
  record: { subject: "Rebar spacing", number: 7, dueDate: "2026-09-04", tags: ["steel"], empty: "" },
  now: "2026-09-01T00:00:00.000Z",
};

describe("renderTemplate", () => {
  it("resolves {{path}} placeholders against the evaluation context", () => {
    expect(renderTemplate("RFI {{record.number}}: {{ record.subject }}", ctx)).toBe("RFI 7: Rebar spacing");
    expect(renderTemplate("on {{event.action}} of {{event.objectType}}", ctx)).toBe("on create of rfi");
  });

  it("renders a dash for missing or empty values and JSON for objects", () => {
    expect(renderTemplate("{{record.missing}}|{{record.empty}}", ctx)).toBe("—|—");
    expect(renderTemplate("{{record.tags}}", ctx)).toBe('["steel"]');
  });

  it("is a path lookup, never an expression", () => {
    expect(renderTemplate("{{record.number + 1}}", ctx)).toBe("{{record.number + 1}}");
    expect(renderTemplate(42, ctx)).toBe("");
  });
});

describe("signWebhookBody", () => {
  it("is HMAC-SHA256 over v1:{timestamp}:{runId}:{body}", () => {
    const expected = createHmac("sha256", "secret").update("v1:1700000000:arun_1:{}").digest("hex");
    expect(signWebhookBody("secret", 1700000000, "arun_1", "{}")).toBe(`v1=${expected}`);
    expect(signWebhookBody("other", 1700000000, "arun_1", "{}")).not.toBe(`v1=${expected}`);
  });
});

describe("describeAction", () => {
  it("gives a human sentence per action type with placeholders rendered", () => {
    expect(describeAction("notify", { to: [{ kind: "roles", roles: ["owner", "admin"] }], title: "RFI {{record.number}}" }, ctx)).toBe(
      'Notify roles owner/admin: "RFI 7"',
    );
    expect(describeAction("escalate", { raiseSignal: true, reassignTo: "usr_1" }, ctx)).toContain("raise a signal");
    expect(describeAction("create_obligation", { trigger: "Serve notice", deadlineField: "dueDate" }, ctx)).toContain("record.dueDate");
    expect(describeAction("create_signal", { severity: "high", title: "T" }, ctx)).toBe('Raise high signal "T"');
    expect(describeAction("webhook", { url: "https://x.example/h" }, ctx)).toContain("https://x.example/h");
    expect(describeAction("run_agent", { agentKind: "time_bar_notice_drafter" }, ctx)).toContain("human review");
    expect(describeAction("assign", { userField: "ballInCourtId" }, ctx)).toBe("Assign to record.ballInCourtId");
    expect(describeAction("tag", { name: "x-{{record.number}}" }, ctx)).toBe('Tag with "x-7"');
    expect(describeAction("create_task", { title: "Follow up", dueInDays: 3 }, ctx)).toBe('Create task "Follow up" due in 3 days');
    expect(describeAction("nope", {}, ctx)).toBe("Unknown action nope");
  });
});

describe("helpers", () => {
  it("windowStart subtracts the window from now", () => {
    expect(windowStart(new Date("2026-09-01T00:01:00.000Z"), 60_000)).toBe("2026-09-01T00:00:00.000Z");
  });

  it("the recording client logs every call and returns the scripted response", async () => {
    const client = createRecordingClient((call, i) => ({ status: i === 0 ? 200 : 500, body: call.url }));
    const first = await client.post("https://a.example", "{}", { "x-a": "1" });
    const second = await client.post("https://b.example", "{}", {});
    expect(first).toEqual({ status: 200, body: "https://a.example" });
    expect(second.status).toBe(500);
    expect(client.calls.map((c) => c.url)).toEqual(["https://a.example", "https://b.example"]);
  });
});
