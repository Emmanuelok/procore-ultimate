import { describe, expect, it } from "vitest";
import {
  computeTicketTotals,
  formatMoney,
  priceTmLine,
  signatureEvidence,
  type SignatureColumns,
  type TmLineInput,
} from "./tm.js";

const line = (over: Partial<TmLineInput> = {}): TmLineInput => ({
  lineKind: "labour",
  description: "Steel fixer",
  hours: 8,
  rate: 45,
  currency: "USD",
  ...over,
});

describe("priceTmLine", () => {
  it("prefers a stated amount, then hours × rate, then quantity × rate", () => {
    expect(priceTmLine(line({ amount: 500 }), 1)).toMatchObject({ amount: 500, basis: "stated" });
    expect(priceTmLine(line(), 1)).toMatchObject({ amount: 360, basis: "hours_x_rate" });
    expect(
      priceTmLine(line({ hours: null, quantity: 12, unit: "m3", rate: 25 }), 1),
    ).toMatchObject({ amount: 300, basis: "quantity_x_rate" });
  });

  it("leaves a line with hours but no rate UNPRICED rather than valuing it at zero", () => {
    const r = priceTmLine(line({ rate: null }), 3);
    expect(r.amount).toBeNull();
    expect(r.basis).toBe("unpriced");
    expect(r.reasons.join(" ")).toContain('Line 3 ("Steel fixer") records 8 hour(s) but no rate');
    expect(r.reasons.join(" ")).toContain("to be agreed");
  });
});

describe("computeTicketTotals", () => {
  it("totals the four categories, applies the markup and states the grand total", () => {
    const t = computeTicketTotals({
      currency: "USD",
      markupPercent: 15,
      lines: [
        line({ hours: 8, rate: 45 }),
        line({ lineKind: "labour", description: "Labourer", hours: 8, rate: 30 }),
        line({ lineKind: "equipment", description: "20t excavator", hours: 6, rate: 90, quantity: null }),
        line({ lineKind: "material", description: "Rebar", quantity: 1.2, unit: "t", rate: 900, hours: null }),
        line({ lineKind: "subcontract", description: "Coring", amount: 750, hours: null, rate: null }),
      ],
    });
    expect(t.labourTotal.value).toBe(600);
    expect(t.equipmentTotal.value).toBe(540);
    expect(t.materialTotal.value).toBe(1080);
    expect(t.subcontractTotal.value).toBe(750);
    expect(t.netTotal.value).toBe(2970);
    expect(t.markupTotal.value).toBe(445.5);
    expect(t.total.value).toBe(3415.5);
    expect(t.totalLabourHours).toBe(16);
    expect(t.totalEquipmentHours).toBe(6);
    expect(t.lineCount).toBe(5);
    expect(t.total.reasons).toEqual([]);
  });

  it("keeps the hours and refuses the total when a line is unpriced", () => {
    const t = computeTicketTotals({
      currency: "USD",
      markupPercent: 10,
      lines: [line({ hours: 8, rate: 45 }), line({ description: "Foreman", hours: 8, rate: null })],
    });
    // the hours are the claim, and they survive
    expect(t.totalLabourHours).toBe(16);
    expect(t.unpricedLineCount).toBe(1);
    // the money does not
    expect(t.labourTotal.value).toBeNull();
    expect(t.netTotal.value).toBeNull();
    expect(t.markupTotal.value).toBeNull();
    expect(t.total.value).toBeNull();
    expect(t.total.reasons.join(" ")).toContain('Line 2 ("Foreman")');
    // an untouched category is still stateable
    expect(t.materialTotal.value).toBe(0);
  });

  it("treats an absent markup percentage as no markup and says so in a note", () => {
    const t = computeTicketTotals({ currency: "USD", lines: [line({ hours: 10, rate: 50 })] });
    expect(t.markupPercent).toBeNull();
    expect(t.markupTotal.value).toBe(0);
    expect(t.total.value).toBe(500);
    expect(t.notes.join(" ")).toContain("No markup percentage is recorded");
    expect(t.total.reasons).toEqual([]);
  });

  it("never sums money across currencies", () => {
    const t = computeTicketTotals({
      currency: "USD",
      markupPercent: 10,
      lines: [line({ hours: 8, rate: 45 }), line({ description: "Crane hire", amount: 900, currency: "EUR" })],
    });
    expect(t.total.value).toBeNull();
    expect(t.labourTotal.value).toBeNull();
    expect(t.total.reasons.join(" ")).toContain("EUR");
    expect(t.total.reasons.join(" ")).toContain("never summed across currencies");
  });

  it("carries the claimed total and the agreed total apart when the client strikes a line", () => {
    const t = computeTicketTotals({
      currency: "USD",
      markupPercent: 10,
      lines: [
        line({ hours: 8, rate: 45 }),
        line({ description: "Standby time", hours: 4, rate: 45, isDisputed: true, agreedAmount: 90 }),
      ],
    });
    expect(t.total.value).toBe(594); // (360 + 180) × 1.10
    expect(t.agreedTotal.value).toBe(495); // (360 + 90) × 1.10
    expect(t.disputedLineCount).toBe(1);
  });

  it("refuses an agreed total when a struck line carries no agreed amount", () => {
    const t = computeTicketTotals({
      currency: "USD",
      lines: [line({ hours: 8, rate: 45 }), line({ description: "Standby", hours: 4, rate: 45, isDisputed: true })],
    });
    expect(t.total.value).toBe(540);
    expect(t.agreedTotal.value).toBeNull();
    expect(t.agreedTotal.reasons.join(" ")).toContain("not zero and it is not the claim");
  });
});

describe("formatMoney", () => {
  it("groups thousands and keeps two decimals on both signs", () => {
    expect(formatMoney(1234567.5)).toBe("1,234,567.50");
    expect(formatMoney(-45.5)).toBe("-45.50");
  });
});

/* ------------------------------------------------------------------ */
/* The signature block                                                 */
/* ------------------------------------------------------------------ */

const sig = (over: Partial<SignatureColumns> = {}): SignatureColumns => ({
  signedAt: null,
  signedByName: null,
  signatureMethod: "none",
  signedUnderProtest: 0,
  refusedToSign: 0,
  protestNote: null,
  refusalNote: null,
  ...over,
});

describe("signatureEvidence", () => {
  it("reports an unsigned ticket as unsigned, with no client response", () => {
    const e = signatureEvidence(sig());
    expect(e.state).toBe("unsigned");
    expect(e.isSigned).toBe(false);
    expect(e.hasClientResponse).toBe(false);
    expect(e.summary).toContain("no site signature and no recorded refusal");
  });

  it("reports a clean signature as signed", () => {
    const e = signatureEvidence(
      sig({ signedAt: "2026-03-04T16:20:00.000Z", signedByName: "J. Smith", signatureMethod: "on_device" }),
    );
    expect(e.state).toBe("signed");
    expect(e.isSigned).toBe(true);
    expect(e.summary).toContain("J. Smith");
    expect(e.summary).toContain("on_device");
  });

  it("keeps a signature under protest distinct and NEVER reports it as signed", () => {
    const e = signatureEvidence(
      sig({
        signedAt: "2026-03-04T16:20:00.000Z",
        signedByName: "J. Smith",
        signatureMethod: "wet_ink_scanned",
        signedUnderProtest: 1,
        protestNote: "Signed for record of hours only, without prejudice to liability.",
      }),
    );
    expect(e.state).toBe("signed_under_protest");
    expect(e.isSigned).toBe(false);
    expect(e.hasClientResponse).toBe(true);
    expect(e.note).toContain("without prejudice");
    expect(e.summary).toContain("UNDER PROTEST");
    expect(e.summary).toContain("does not admit liability");
  });

  it("keeps a refusal to sign distinct, and a refusal outranks any signature column", () => {
    const e = signatureEvidence(
      sig({ refusedToSign: 1, signedByName: "K. Otieno", refusalNote: "Disputes the instruction was given." }),
    );
    expect(e.state).toBe("refused_to_sign");
    expect(e.isSigned).toBe(false);
    expect(e.hasClientResponse).toBe(true);
    expect(e.note).toContain("Disputes the instruction");
    expect(e.summary).toContain("REFUSED to sign");

    // a stray signedAt must not resurrect a refused ticket as signed
    const contradictory = signatureEvidence(
      sig({ refusedToSign: 1, signedAt: "2026-03-04T16:20:00.000Z", refusalNote: "no" }),
    );
    expect(contradictory.state).toBe("refused_to_sign");
    expect(contradictory.isSigned).toBe(false);
  });
});
