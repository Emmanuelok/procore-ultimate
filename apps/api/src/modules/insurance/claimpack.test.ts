import { describe, expect, it } from "vitest";
import {
  buildChronology,
  money,
  packGaps,
  renderClaimPack,
  type ClaimPackModel,
  type PackClaim,
  type PackPolicy,
} from "./claimpack.js";

function claim(over: Partial<PackClaim> = {}): PackClaim {
  return {
    number: "ICL-0001",
    title: "Scaffold collapse, block B",
    description: "Wind damage during storm.",
    incidentDate: "2026-05-01",
    awareDate: "2026-05-02",
    notifiedAt: "2026-05-10",
    notificationDueAt: "2026-05-16",
    status: "notified",
    quantum: 125_000,
    reserve: 90_000,
    settledAmount: null,
    currency: "GBP",
    insurerRef: "AX-991",
    lossAdjuster: "Crawford",
    ...over,
  };
}

function policy(over: Partial<PackPolicy> = {}): PackPolicy {
  return {
    number: "POL-0004",
    policyType: "contract_works",
    insurer: "Aviva",
    policyNumber: "CW-99321",
    periodStart: "2026-01-01",
    periodEnd: "2026-12-31",
    notificationDays: 14,
    limitOfIndemnity: 5_000_000,
    limitBasis: "per_occurrence",
    deductible: 10_000,
    currency: "GBP",
    territorialLimits: "United Kingdom",
    ...over,
  };
}

function model(over: Partial<ClaimPackModel> = {}): ClaimPackModel {
  const base: Omit<ClaimPackModel, "gaps"> = {
    companyName: "Acme Construction",
    projectName: "Riverside",
    claim: claim(),
    policy: policy(),
    items: [
      {
        recordType: "safety_incident",
        recordId: "sin_1",
        reference: "INC-004",
        title: "Scaffold collapse",
        occurredAt: "2026-05-01",
        note: null,
        resolution: "resolved",
      },
    ],
    requests: [],
    generatedAt: "2026-06-01T09:00:00.000Z",
    generatedByName: "A Surveyor",
    ...over,
  };
  return { ...base, gaps: over.gaps ?? packGaps(base) };
}

describe("money", () => {
  it("shows a dash rather than a fabricated zero", () => {
    expect(money(null, "GBP")).toBe("—");
    expect(money(undefined, "GBP")).toBe("—");
    expect(money(Number.NaN, "GBP")).toBe("—");
  });

  it("keeps the currency next to the number", () => {
    expect(money(1234.5, "GBP")).toBe("GBP 1,234.50");
  });
});

describe("buildChronology", () => {
  it("reports notification inside the deadline as on time, with the slack", () => {
    const c = buildChronology(claim(), policy());
    expect(c.onTime).toBe(true);
    expect(c.verdict).toContain("6 day(s) inside the deadline");
  });

  it("reports a late notification as the condition-precedent problem it is", () => {
    const c = buildChronology(claim({ notifiedAt: "2026-05-20" }), policy());
    expect(c.onTime).toBe(false);
    expect(c.verdict).toContain("AFTER the deadline");
    expect(c.verdict).toContain("condition precedent");
  });

  it("refuses to judge timeliness when no notification exists", () => {
    const c = buildChronology(claim({ notifiedAt: null }), policy());
    expect(c.onTime).toBeNull();
    expect(c.verdict).toContain("no notification has been recorded");
  });

  it("refuses to judge timeliness when no deadline was computable", () => {
    const c = buildChronology(
      claim({ notificationDueAt: null }),
      policy({ notificationDays: null }),
    );
    expect(c.onTime).toBeNull();
    expect(c.verdict).toContain("no notification deadline is recorded");
    expect(c.lines.find((l) => l.label === "Notification due")?.note).toContain(
      "gap in the policy record",
    );
  });

  it("states how long awareness lagged the incident", () => {
    const c = buildChronology(claim({ awareDate: "2026-05-08" }), policy());
    expect(c.lines[1]?.note).toBe("7 day(s) after the incident");
  });
});

describe("packGaps", () => {
  const base = (over: Partial<Omit<ClaimPackModel, "gaps">> = {}) => {
    const m = model();
    const { gaps: _gaps, ...rest } = m;
    return packGaps({ ...rest, ...over });
  };

  it("says nothing is missing only when nothing detectable is", () => {
    expect(base()).toEqual([]);
  });

  it("calls out an empty evidence index", () => {
    expect(base({ items: [] }).join(" ")).toContain("No evidence records are linked");
  });

  it("calls out records that were looked up and are gone", () => {
    const gaps = base({
      items: [
        {
          recordType: "safety_incident",
          recordId: "sin_missing",
          reference: null,
          title: null,
          occurredAt: null,
          note: null,
          resolution: "not_found",
        },
      ],
    });
    expect(gaps.join(" ")).toContain("could not be found");
  });

  it("distinguishes 'we could not check' from 'we checked and it is gone'", () => {
    const gaps = base({
      items: [
        {
          recordType: "daily_log",
          recordId: "dlg_1",
          reference: null,
          title: null,
          occurredAt: null,
          note: null,
          resolution: "not_resolvable",
        },
      ],
    });
    expect(gaps.join(" ")).toContain("cannot look up");
    expect(gaps.join(" ")).not.toContain("could not be found");
  });

  it("calls out an overdue adjuster request", () => {
    const gaps = base({
      requests: [
        {
          kind: "information_request",
          title: "Send the daily logs",
          requestedBy: "Crawford",
          dueDate: "2026-05-20",
          status: "open",
          respondedAt: null,
          overdue: true,
        },
      ],
    });
    expect(gaps.join(" ")).toContain("past their date and unanswered");
  });

  it("says the pack is not a notice when the claim was never notified", () => {
    expect(base({ claim: claim({ notifiedAt: null }) }).join(" ")).toContain("not a notice");
  });

  it("states that no policy could be read rather than omitting the terms silently", () => {
    expect(base({ policy: null }).join(" ")).toContain("could not be read");
  });

  it("states a missing notification period on the policy", () => {
    expect(base({ policy: policy({ notificationDays: null }) }).join(" ")).toContain(
      "records no notification period",
    );
  });
});

describe("renderClaimPack", () => {
  it("renders a self-contained HTML document with the claim number in the title", () => {
    const { html, contentType } = renderClaimPack(model());
    expect(contentType).toBe("text/html; charset=utf-8");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>Claim pack ICL-0001");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("http://");
  });

  it("prints the chronology verdict and the policy terms", () => {
    const html = renderClaimPack(model()).html;
    expect(html).toContain("inside the deadline");
    expect(html).toContain("CW-99321");
    expect(html).toContain("GBP 5,000,000.00");
  });

  it("escapes hostile text rather than emitting it as markup", () => {
    const html = renderClaimPack(
      model({ claim: claim({ title: '<img src=x onerror="alert(1)">' }) }),
    ).html;
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("says so, in the document, when nothing is linked", () => {
    const html = renderClaimPack(model({ items: [] })).html;
    expect(html).toContain("No evidence records are linked to this claim.");
  });

  it("marks a missing record instead of hiding it", () => {
    const html = renderClaimPack(
      model({
        items: [
          {
            recordType: "safety_incident",
            recordId: "sin_x",
            reference: null,
            title: null,
            occurredAt: null,
            note: null,
            resolution: "not_found",
          },
        ],
      }),
    ).html;
    expect(html).toContain("NOT FOUND");
  });

  it("says 'not checked' for a type it cannot look up, not 'not found'", () => {
    const html = renderClaimPack(
      model({
        items: [
          {
            recordType: "photo",
            recordId: "pho_x",
            reference: null,
            title: null,
            occurredAt: null,
            note: null,
            resolution: "not_resolvable",
          },
        ],
      }),
    ).html;
    expect(html).toContain("not checked");
    expect(html).not.toContain("NOT FOUND");
  });

  it("lists an overdue adjuster request as overdue", () => {
    const html = renderClaimPack(
      model({
        requests: [
          {
            kind: "information_request",
            title: "Send the daily logs",
            requestedBy: "Crawford",
            dueDate: "2026-05-20",
            status: "open",
            respondedAt: null,
            overdue: true,
          },
        ],
      }),
    ).html;
    expect(html).toContain("(OVERDUE)");
  });

  it("never asserts that the policy responds", () => {
    const html = renderClaimPack(model()).html;
    expect(html).toContain("whether the policy responds is the insurer's decision");
  });
});
