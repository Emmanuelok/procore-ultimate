import { describe, expect, it } from "vitest";
import { AUTOMATION_TEMPLATE_CATEGORIES } from "@constructos/shared";
import { referencedFields } from "./predicates.js";
import { ruleBodySchema } from "./schemas.js";
import { snapshotEntry } from "./snapshots.js";
import { RULE_TEMPLATES, ruleTemplate } from "./templates.js";

describe("rule template library", () => {
  it("has unique keys and a category from the shared vocabulary", () => {
    const keys = RULE_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(RULE_TEMPLATES.length).toBeGreaterThanOrEqual(10);
    for (const t of RULE_TEMPLATES) {
      expect(AUTOMATION_TEMPLATE_CATEGORIES).toContain(t.category);
      expect(t.spec.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(20);
    }
    expect(ruleTemplate("rfi_overdue_escalate")?.name).toContain("RFI overdue");
    expect(ruleTemplate("nope")).toBeUndefined();
  });

  it("every template is a complete rule the API would accept as-is", () => {
    for (const t of RULE_TEMPLATES) {
      const parsed = ruleBodySchema.safeParse({
        name: t.name,
        description: t.description,
        trigger: t.trigger,
        conditions: t.conditions,
        actions: t.actions,
        immediate: t.immediate,
      });
      expect(parsed.success, `${t.key}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`).toBe(true);
    }
  });

  it("only references record fields the snapshot registry can supply", () => {
    for (const t of RULE_TEMPLATES) {
      const entry = snapshotEntry(t.trigger.objectType);
      expect(entry, `${t.key} triggers on an unknown type ${t.trigger.objectType}`).toBeDefined();
      const known = new Set(entry!.fields.map((f) => f.path));
      for (const path of referencedFields(t.conditions)) {
        if (!path.startsWith("record.")) continue;
        expect(known.has(path.slice("record.".length)), `${t.key}: ${path} is not in the ${t.trigger.objectType} catalogue`).toBe(true);
      }
    }
  });

  it("the four brief-named templates exist and do what the brief says", () => {
    const rfi = ruleTemplate("rfi_overdue_escalate")!;
    expect(rfi.trigger).toMatchObject({ kind: "schedule", objectType: "rfi" });
    expect(rfi.actions.some((a) => a.type === "escalate")).toBe(true);

    const invoice = ruleTemplate("invoice_submitted_expired_insurance")!;
    expect(invoice.trigger).toMatchObject({ kind: "event", objectType: "invoice" });
    expect(referencedFields(invoice.conditions)).toContain("derived.vendorInsuranceValid");
    // the hold itself stays a human decision — no template changes a financial status
    expect(invoice.actions.map((a) => a.type).sort()).toEqual(["create_signal", "escalate", "tag"]);

    const signal = ruleTemplate("signal_critical_notify_reviewer")!;
    expect(JSON.stringify(signal.actions)).toContain("integrity_reviewer");

    const timeBar = ruleTemplate("time_bar_5_days_draft_notice")!;
    expect(timeBar.actions.some((a) => a.type === "run_agent")).toBe(true);
    expect(timeBar.actions.some((a) => a.type === "create_obligation")).toBe(true);
  });
});
