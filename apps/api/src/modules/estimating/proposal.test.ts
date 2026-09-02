import { describe, expect, it } from "vitest";
import {
  buildProposalDocument,
  escapeHtml,
  renderProposalHtml,
  type ProposalInput,
} from "./proposal.js";
import type { AppliedMarkup } from "./pricing.js";

/** Proposal generation (spec Vol I #205–206). */

const markup: AppliedMarkup = {
  id: "m1",
  sequence: 1,
  kind: "overhead",
  name: "Overhead and profit",
  method: "percent",
  basis: "direct_cost",
  rate: 15,
  baseAmount: 10000,
  amount: 1500,
  explanation: "15% of 10000 (direct cost) = 1500",
};

const input = (over: Partial<ProposalInput> = {}): ProposalInput => ({
  reference: "PRO-001",
  title: "Substructure works",
  clientName: "Northgate Developments",
  projectName: "Northgate Phase 2",
  estimateReference: "EST-004",
  estimateVersion: 2,
  currency: "GBP",
  detailLevel: "section",
  sections: [
    { id: "s1", code: "A", name: "Groundworks", sortOrder: 1 },
    { id: "s2", code: "B", name: "Substructure", sortOrder: 2 },
  ],
  lines: [
    { id: "l1", sectionId: "s1", itemCode: "A1", description: "Bulk excavation", unit: "m3", quantity: 400, unitRate: 15, amount: 6000, status: "active" },
    { id: "l2", sectionId: "s2", itemCode: "B1", description: "Mass fill concrete", unit: "m3", quantity: 80, unitRate: 50, amount: 4000, status: "active" },
    { id: "l3", sectionId: null, itemCode: null, description: "Site set-up", unit: "item", quantity: 1, unitRate: 0, amount: 0, status: "active" },
    { id: "l4", sectionId: "s2", itemCode: "B9", description: "Ground gas membrane", unit: "m2", quantity: 300, unitRate: 12, amount: 3600, status: "alternate" },
    { id: "l5", sectionId: "s2", itemCode: "B8", description: "Dewatering", unit: "item", quantity: 1, unitRate: 900, amount: 900, status: "excluded" },
  ],
  markups: [markup],
  generatedAt: "2026-09-02T10:00:00.000Z",
  ...over,
});

describe("buildProposalDocument", () => {
  it("groups by section and totals only the counted lines", () => {
    const doc = buildProposalDocument(input());
    expect(doc.sections.map((s) => s.name)).toEqual(["Groundworks", "Substructure", "Other works"]);
    expect(doc.sections[0]?.amount).toBe(6000);
    expect(doc.sections[1]?.amount).toBe(4000);
    expect(doc.totals.directCost).toBe(10000);
    expect(doc.totals.markupTotal).toBe(1500);
    expect(doc.totals.total).toBe(11500);
  });

  it("omits the line detail at section level and includes it at line level", () => {
    expect(buildProposalDocument(input()).sections[0]?.lines).toHaveLength(0);
    const lineLevel = buildProposalDocument(input({ detailLevel: "line" }));
    expect(lineLevel.sections[0]?.lines[0]?.description).toBe("Bulk excavation");
  });

  it("collapses to one block at summary level and says so", () => {
    const doc = buildProposalDocument(input({ detailLevel: "summary" }));
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0]?.name).toBe("Works as described");
    expect(doc.sections[0]?.amount).toBe(10000);
    expect(doc.notes.join(" ")).toMatch(/lump sum/);
  });

  it("never leaks the internal markup explanation into the document", () => {
    const doc = buildProposalDocument(input());
    expect(JSON.stringify(doc)).not.toContain("direct cost) = 1500");
    expect(doc.markupLines[0]?.name).toBe("Overhead and profit");
  });

  it("prices alternates separately and keeps them out of the total", () => {
    const doc = buildProposalDocument(input());
    expect(doc.alternates).toHaveLength(1);
    expect(doc.alternates[0]?.amount).toBe(3600);
    expect(doc.totals.total).toBe(11500);
    expect(doc.notes.join(" ")).toMatch(/not included in the total/);
  });

  it("notes a missing validity period rather than inventing one", () => {
    expect(buildProposalDocument(input()).notes.join(" ")).toMatch(/No validity period/);
    expect(
      buildProposalDocument(input({ validUntil: "2026-10-31" })).notes.join(" "),
    ).not.toMatch(/No validity period/);
  });

  it("drops zero-value markups from the document", () => {
    const doc = buildProposalDocument(input({ markups: [{ ...markup, amount: 0 }] }));
    expect(doc.markupLines).toHaveLength(0);
    expect(doc.totals.total).toBe(10000);
  });

  it("puts lines whose section no longer exists into Other works", () => {
    const doc = buildProposalDocument(
      input({
        sections: [{ id: "s1", code: "A", name: "Groundworks", sortOrder: 1 }],
      }),
    );
    const other = doc.sections.find((s) => s.name === "Other works");
    expect(other?.amount).toBe(4000);
  });
});

describe("renderProposalHtml", () => {
  it("escapes every interpolated value", () => {
    expect(escapeHtml(`<script>"&'`)).toBe("&lt;script&gt;&quot;&amp;&#39;");
    const doc = buildProposalDocument(
      input({
        title: "<script>alert(1)</script>",
        clientName: "Acme & Co <b>",
        detailLevel: "line",
      }),
    );
    const html = renderProposalHtml(doc);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Acme &amp; Co &lt;b&gt;");
  });

  it("renders a self-contained page with the total and the sections", () => {
    const html = renderProposalHtml(buildProposalDocument(input({ detailLevel: "line" })));
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toContain("<link ");
    expect(html).toContain("Groundworks");
    expect(html).toContain("Bulk excavation");
    expect(html).toContain("GBP 11,500.00");
  });

  it("renders the alternates table only when there are alternates", () => {
    const withAlts = renderProposalHtml(buildProposalDocument(input()));
    expect(withAlts).toContain("Alternates (not included in the total)");
    const withoutAlts = renderProposalHtml(
      buildProposalDocument(input({ lines: input().lines.filter((l) => l.status !== "alternate") })),
    );
    expect(withoutAlts).not.toContain("Alternates (not included in the total)");
  });

  it("renders the covering note, assumptions and exclusions as paragraphs", () => {
    const html = renderProposalHtml(
      buildProposalDocument(
        input({
          coveringNote: "Thank you for the enquiry.\n\nOur price follows.",
          assumptions: "Unrestricted site access",
          exclusions: "Statutory undertakers' charges",
        }),
      ),
    );
    expect(html).toContain("Thank you for the enquiry.");
    expect(html).toContain("Our price follows.");
    expect(html).toContain("Assumptions");
    expect(html).toContain("Statutory undertakers&#39; charges");
  });
});
