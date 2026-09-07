import { describe, expect, it } from "vitest";
import { escapeHtml, renderClaimPackageHtml, type ClaimPackage } from "./submission.js";

function pkg(overrides: Partial<ClaimPackage> = {}): ClaimPackage {
  return {
    claim: {
      number: 7,
      title: "Delayed access to the east wing",
      kind: "delay",
      status: "submitted",
      currency: "GBP",
      clauseRef: "Cl. 20.1",
      daysClaimed: 24,
      amountClaimed: 180000,
      daysAssessed: null,
      amountAssessed: null,
      quantumBest: 120000,
      quantumLikely: 160000,
      quantumWorst: 200000,
      successProbability: 0.65,
      provisionAmount: 104000,
      chain: {
        cause: "Access to the east wing was withheld until 14 March.",
        effect: "Piling could not start; the critical path moved 24 days.",
        entitlement: "Cl. 20.1 — employer's risk event, notice served 18 March.",
        quantum: "Prolongation at the priced time-related preliminaries rate.",
      },
      createdAt: "2026-03-20T10:00:00.000Z",
      ...(overrides.claim ?? {}),
    },
    delayEvents: [
      {
        number: 3,
        title: "Access withheld",
        cause: "client_change",
        status: "open",
        party: "owner",
        excusable: 1,
        compensable: 1,
        startDate: "2026-02-18",
        durationDays: 24,
        noticeDueDate: "2026-03-04",
        contractEventId: "ce_1",
      },
    ],
    analyses: [
      {
        title: "Windows analysis of Q1",
        method: "windows",
        mipCode: "3.4",
        sclReference: "SCL Protocol Guidance Part B, §11",
        resultDays: 24,
        rationale: "Contemporaneous updates exist for every window.",
        summary: "3 windows analysed; completion moved 24 days.",
        createdAt: "2026-03-21T09:00:00.000Z",
      },
    ],
    quantumCalculations: [
      {
        method: "hudson",
        currency: "GBP",
        amount: 96000,
        formula: "contract sum × HO% ÷ contract period × delay",
        workings: "GBP 12,000,000 × 4% ÷ 120 weeks × 3.43 weeks = GBP 96,000",
        assumptions: ["The tendered head-office percentage reflects actual overhead recovery."],
        createdAt: "2026-03-21T10:00:00.000Z",
      },
    ],
    disruptionAnalyses: [],
    // Both are stored on the claim as plain arrays of rows.
    chronology: [
      { date: "2026-02-18", source: "delay_event", ref: "DE-3", title: "Access withheld" },
      { date: "2026-03-18", source: "contract_event", ref: "CE-9", title: "Notice served" },
    ],
    sufficiency: { overallScore: 0.72 },
    scottSchedule: [
      {
        item: 1,
        reference: "DE-3",
        description: "Access withheld",
        claimantContention: "24 days of compensable delay attributable to the owner.",
        evidenceRefs: ["ev_1", "ev_2"],
        daysClaimed: 24,
        amountClaimed: 96000,
        respondentResponse: "",
        daysAdmitted: null,
        amountAdmitted: null,
        tribunalFinding: "",
        daysAwarded: null,
        amountAwarded: null,
      },
    ],
    completeness: { ready: true, missing: [] },
    generatedAt: "2026-03-22T08:30:00.000Z",
    ...overrides,
  };
}

describe("claim submission package HTML", () => {
  it("renders one self-contained document with no external references", () => {
    const html = renderClaimPackageHtml(pkg());
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>Claim CL-7 — Delayed access to the east wing</title>");
    // A bundle document must render on a machine with no network.
    expect(html).not.toMatch(/<link\s/i);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("prints every section, with the analysis basis and the quantum workings", () => {
    const html = renderClaimPackageHtml(pkg());
    for (const heading of [
      "Position",
      "Cause, effect, entitlement, quantum",
      "Delay events relied on",
      "Delay analysis",
      "Quantum",
      "Disruption",
      "Chronology",
      "Scott Schedule",
    ]) {
      expect(html).toContain(heading);
    }
    expect(html).toContain("AACE 29R-03 MIP 3.4");
    expect(html).toContain("SCL Protocol Guidance Part B");
    expect(html).toContain("Method selected because: Contemporaneous updates exist");
    expect(html).toContain("GBP 12,000,000 × 4% ÷ 120 weeks");
    expect(html).toContain("The tendered head-office percentage");
    expect(html).toContain("DE-3");
    expect(html).toContain("CE-9");
    expect(html).toContain("24 days of compensable delay attributable to the owner.");
    expect(html).toContain("ev_1, ev_2");
  });

  it("accepts the stored array form and the endpoint envelope form alike", () => {
    const base = pkg();
    const wrapped = renderClaimPackageHtml({
      ...base,
      chronology: { entries: base.chronology as unknown[] },
      scottSchedule: { rows: base.scottSchedule as unknown[] },
    });
    expect(wrapped).toContain("Access withheld");
    expect(wrapped).not.toContain("No chronology has been assembled");
    expect(wrapped).not.toContain("No Scott Schedule has been generated");
  });

  it("leads with what is missing rather than hiding it", () => {
    const html = renderClaimPackageHtml(
      pkg({
        completeness: {
          ready: false,
          missing: ["no delay analysis has been recorded against this claim"],
        },
      }),
    );
    expect(html).toContain("Not yet complete");
    expect(html).toContain("no delay analysis has been recorded");
    // and the missing block comes before the position table
    expect(html.indexOf("Not yet complete")).toBeLessThan(html.indexOf("Days claimed"));
  });

  it("prints an absent figure as 'not available', never as zero", () => {
    const base = pkg();
    const html = renderClaimPackageHtml({
      ...base,
      claim: {
        ...base.claim,
        amountClaimed: null,
        daysClaimed: null,
        provisionAmount: null,
        successProbability: null,
      },
    });
    expect(html).toContain("not available");
    expect(html).not.toMatch(/GBP 0\.00/);
  });

  it("says so when a component is absent instead of printing an empty table", () => {
    const base = pkg();
    const html = renderClaimPackageHtml({
      ...base,
      delayEvents: [],
      analyses: [],
      quantumCalculations: [],
      chronology: null,
      scottSchedule: null,
    });
    expect(html).toContain("No delay events are linked to this claim.");
    expect(html).toContain("No delay analysis has been recorded against this claim.");
    expect(html).toContain("No quantum calculation is linked to this claim.");
    expect(html).toContain("No chronology has been assembled for this claim.");
    expect(html).toContain("No Scott Schedule has been generated for this claim.");
  });

  it("escapes user text so a claim title cannot inject markup", () => {
    const base = pkg();
    const html = renderClaimPackageHtml({
      ...base,
      claim: { ...base.claim, title: '<img src=x onerror="alert(1)">' },
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
    expect(escapeHtml(null)).toBe("");
  });

  it("names an unwritten chain limb rather than leaving a blank", () => {
    const base = pkg();
    const html = renderClaimPackageHtml({
      ...base,
      claim: { ...base.claim, chain: { cause: "Access withheld." } },
    });
    expect(html).toContain("This limb has not been written.");
  });
});
