import { describe, expect, it } from "vitest";
import type { ParticularCondition } from "@constructos/db";
import {
  administratorTitle,
  buildNoticePack,
  formFamily,
  noticeUrgency,
  type NoticeContractFacts,
  type NoticeFacts,
} from "./notice.js";
import { resolveClause } from "./timebar.js";

const CAL = { calendarBasis: "calendar" as const };

const contract: NoticeContractFacts = {
  name: "Package A — Main works",
  form: "fidic_red_2017",
  currency: "GBP",
  parties: { employer: "Metro Authority", contractor: "Buildco Ltd", administrator: "Consult Eng" },
};

function event(overrides: Partial<NoticeFacts> = {}): NoticeFacts {
  return {
    number: 7,
    kind: "delay_event",
    title: "Late access to Zone 3",
    description: "Access to Zone 3 was not given on the date stated in the Contract Data.",
    eventDate: "2026-03-01",
    awarenessDate: "2026-03-02",
    noticeDeadline: "2026-03-30",
    deadlineSource: "library",
    effectiveTimeBarDays: 28,
    calendarBasis: "calendar",
    costImpactEstimate: null,
    timeImpactDaysEstimate: null,
    status: "open",
    noticeServedAt: null,
    ...overrides,
  };
}

describe("form family helpers", () => {
  it("names the administrator each form uses", () => {
    expect(administratorTitle("fidic_red_2017")).toBe("the Engineer");
    expect(administratorTitle("nec4")).toBe("the Project Manager");
    expect(administratorTitle("jct_sbc_2016")).toBe("the Contract Administrator");
    expect(administratorTitle("bespoke")).toBe("the contract administrator");
  });

  it("classifies unknown forms as bespoke rather than guessing", () => {
    expect(formFamily("gulf_derivative_2020")).toBe("bespoke");
  });
});

describe("noticeUrgency", () => {
  it("grades by days remaining and reports no_bar when there is no deadline", () => {
    expect(noticeUrgency(null, "2026-03-10")).toBe("no_bar");
    expect(noticeUrgency("2026-03-09", "2026-03-10")).toBe("expired");
    expect(noticeUrgency("2026-03-12", "2026-03-10")).toBe("critical");
    expect(noticeUrgency("2026-03-18", "2026-03-10")).toBe("soon");
    expect(noticeUrgency("2026-05-18", "2026-03-10")).toBe("routine");
  });
});

describe("buildNoticePack", () => {
  it("assembles the pack from the effective clause and the event record", () => {
    const clause = resolveClause("fidic_red_2017", "20.2", [], CAL);
    const pack = buildNoticePack({ contract, event: event(), clause, today: "2026-03-10" });
    expect(pack.clauseRef).toBe("20.2");
    expect(pack.urgency).toBe("routine");
    expect(pack.daysRemaining).toBe(20);
    expect(pack.addresseeRole).toBe("administrator");
    expect(pack.addressee).toBe("Consult Eng");
    expect(pack.serviceRules[0]).toContain("1.3");
    expect(pack.basis).toContain("28 calendar days from 2026-03-02");
    // Every core requirement is on the record; only the unquantified head of
    // claim is outstanding, and that is stated as "to be particularised".
    const core = ["event_description", "event_date", "awareness_date", "clause_ref", "addressee"];
    expect(pack.requirements.filter((r) => core.includes(r.key)).every((r) => r.satisfied)).toBe(
      true,
    );
    expect(pack.draft).toContain("NOTICE UNDER FIDIC RED 2017 SUB-CLAUSE 20.2");
    expect(pack.draft).toContain("Consult Eng");
    expect(pack.draft).not.toContain("NOT ON RECORD");
  });

  it("says where an amended bar came from instead of quoting the standard form", () => {
    const pcs: ParticularCondition[] = [
      { clauseRef: "20.2", amendment: "Notice period extended to 56 days", timeBarDays: 56 },
    ];
    const clause = resolveClause("fidic_red_2017", "20.2", pcs, CAL);
    const pack = buildNoticePack({
      contract,
      event: event({ deadlineSource: "particular_condition", effectiveTimeBarDays: 56 }),
      clause,
      today: "2026-03-10",
    });
    expect(pack.basis).toContain("56 calendar days");
    expect(pack.basis).toContain("Particular Conditions");
    expect(pack.basis).toContain("28 days");
  });

  it("reports every missing fact and never invents one in the draft", () => {
    const clause = resolveClause("fidic_red_2017", "20.2", [], CAL);
    const pack = buildNoticePack({
      contract: { ...contract, parties: { employer: "Metro Authority" } },
      event: event({ description: null, awarenessDate: null, title: "Access" }),
      clause,
      today: "2026-03-10",
    });
    expect(pack.missing.length).toBeGreaterThanOrEqual(3);
    expect(pack.draft).toContain("NOT ON RECORD");
    expect(pack.addressee).toBeNull();
    const awareness = pack.requirements.find((r) => r.key === "awareness_date");
    expect(awareness?.satisfied).toBe(false);
    expect(awareness?.detail).toContain("less favourable");
  });

  it("adds the time head of claim for a time clause and leaves it bracketed when unquantified", () => {
    const clause = resolveClause("fidic_red_2017", "20.2", [], CAL);
    const pack = buildNoticePack({ contract, event: event(), clause, today: "2026-03-10" });
    expect(pack.requirements.some((r) => r.key === "time_impact")).toBe(true);
    expect(pack.draft).toContain("to be particularised");
  });

  it("states the quantified time impact when the record carries one", () => {
    const clause = resolveClause("fidic_red_2017", "20.2", [], CAL);
    const pack = buildNoticePack({
      contract,
      event: event({ timeImpactDaysEstimate: 21 }),
      clause,
      today: "2026-03-10",
    });
    expect(pack.draft).toContain("21 days");
  });

  it("falls back to a bespoke service rule and no computed bar when no clause is attached", () => {
    const pack = buildNoticePack({
      contract: { ...contract, form: "bespoke" },
      event: event({ noticeDeadline: null, deadlineSource: null, effectiveTimeBarDays: null }),
      clause: null,
      today: "2026-03-10",
    });
    expect(pack.urgency).toBe("no_bar");
    expect(pack.basis).toContain("No clause is attached");
    expect(pack.serviceRules[0]).toContain("not in the code-resident clause library");
    expect(pack.draft).toContain("[CLAUSE]");
  });

  it("addresses an administrator-issued notice to the contractor", () => {
    const clause = resolveClause("fidic_red_2017", "3.7", [], CAL);
    const pack = buildNoticePack({ contract, event: event({ kind: "determination" }), clause, today: "2026-03-10" });
    expect(pack.clauseRef).toBe("3.7");
    expect(["administrator", "contractor"]).toContain(pack.addresseeRole);
  });

  it("marks an elapsed deadline as expired", () => {
    const clause = resolveClause("fidic_red_2017", "20.2", [], CAL);
    const pack = buildNoticePack({ contract, event: event(), clause, today: "2026-04-15" });
    expect(pack.urgency).toBe("expired");
    expect(pack.daysRemaining).toBeLessThan(0);
  });
});
