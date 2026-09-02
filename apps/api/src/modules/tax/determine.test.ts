import { describe, expect, it } from "vitest";
import type { TaxRegime } from "@constructos/shared";
import {
  determine,
  DeterminationError,
  positionFromRegistrations,
  unknownParty,
  type DeterminationInput,
  type PartyTaxPosition,
} from "./determine.js";

function party(over: Partial<PartyTaxPosition> = {}): PartyTaxPosition {
  return {
    country: "GB",
    vatRegistered: true,
    deductionRegistered: true,
    deductionVerified: true,
    deductionRate: 20,
    tinOnFile: true,
    isIndividual: false,
    ...over,
  };
}

function input(over: Partial<DeterminationInput> = {}): DeterminationInput {
  return {
    regime: "uk",
    supplyType: "construction_services",
    contractType: "subcontract",
    amount: 10000,
    currency: "GBP",
    materialsAmount: 0,
    placeOfSupplyCountry: null,
    supplier: party(),
    customer: { ...party(), endUser: false },
    rateKey: null,
    treaty: null,
    custom: null,
    asOf: "2026-09-01",
    ...over,
  };
}

describe("determination engine — validation", () => {
  it("rejects impossible amounts, unknown regimes and unknown rate keys", () => {
    expect(() => determine(input({ amount: -1 }))).toThrow(DeterminationError);
    expect(() => determine(input({ materialsAmount: 20000 }))).toThrow(/materialsAmount/);
    expect(() => determine(input({ regime: "xx" as TaxRegime }))).toThrow(/Unknown tax regime/);
    expect(() => determine(input({ rateKey: "made_up" }))).toThrow(/rateKey/);
  });

  it("is deterministic", () => {
    const a = determine(input());
    const b = determine(input());
    expect(a).toEqual(b);
  });
});

describe("UK — VAT, domestic reverse charge and CIS", () => {
  it("applies the reverse charge and a 20% CIS deduction between registered, verified parties", () => {
    const out = determine(input({ materialsAmount: 2000 }));
    expect(out.vatTreatment).toBe("reverse_charge");
    expect(out.reverseCharge).toBe(true);
    expect(out.vatAmount).toBe(0);
    expect(out.selfAccountedVat).toBe(2000); // 20% of 10,000
    expect(out.withholdingScheme).toBe("cis");
    expect(out.withholdingBase).toBe("gross_excl_materials");
    expect(out.withholdingBaseAmount).toBe(8000);
    expect(out.withholdingRate).toBe(20);
    expect(out.withholdingAmount).toBe(1600);
    expect(out.grossPayable).toBe(10000);
    expect(out.netPayable).toBe(8400);
    expect(out.confidence).toBe(1);
    expect(out.assumptions).toEqual([]);
    expect(out.citations.some((c) => c.element === "reverse_charge" && /55A/.test(c.source))).toBe(true);
    expect(out.citations.some((c) => c.element === "withholding" && /Finance Act 2004/.test(c.source))).toBe(true);
    expect(out.citations.some((c) => /Materials of GBP 2000.00 excluded/.test(c.rule))).toBe(true);
    expect(out.explanation).toContain("Net payable GBP 8400.00");
  });

  it("gives gross payment status a 0% deduction and the unmatched subcontractor 30%", () => {
    const gross = determine(input({ supplier: party({ deductionRate: 0 }) }));
    expect(gross.withholdingRate).toBe(0);
    expect(gross.withholdingAmount).toBe(0);
    expect(gross.withholdingScheme).toBe("cis");

    const unmatched = determine(
      input({ supplier: party({ deductionRegistered: false, deductionVerified: false, deductionRate: null }) }),
    );
    expect(unmatched.withholdingRate).toBe(30);
    expect(unmatched.withholdingAmount).toBe(3000);
    expect(unmatched.warnings.some((w) => /No Construction Industry Scheme registration/.test(w))).toBe(true);

    const registeredUnverified = determine(
      input({ supplier: party({ deductionVerified: false, deductionRate: null }) }),
    );
    expect(registeredUnverified.withholdingRate).toBe(30);
    expect(registeredUnverified.warnings.some((w) => /unverified/.test(w))).toBe(true);
  });

  it("does not reverse-charge an end user and invoices VAT normally", () => {
    const out = determine(input({ customer: { ...party(), endUser: true } }));
    expect(out.vatTreatment).toBe("standard");
    expect(out.reverseCharge).toBe(false);
    expect(out.vatAmount).toBe(2000);
    expect(out.selfAccountedVat).toBe(0);
    expect(out.netPayable).toBe(10000 + 2000 - 2000); // VAT charged, 20% CIS on labour
    expect(out.citations.some((c) => /end user/.test(c.rule))).toBe(true);
  });

  it("keeps professional services and materials-only supplies outside CIS and the reverse charge", () => {
    const prof = determine(input({ supplyType: "professional_services", contractType: "consultancy" }));
    expect(prof.vatTreatment).toBe("standard");
    expect(prof.withholdingScheme).toBe("none");
    expect(prof.withholdingAmount).toBe(0);
    const mats = determine(input({ supplyType: "materials_only", contractType: "supply_only" }));
    expect(mats.withholdingScheme).toBe("none");
    expect(mats.vatAmount).toBe(2000);
  });

  it("refuses VAT from an unregistered supplier", () => {
    const out = determine(input({ supplier: party({ vatRegistered: false }) }));
    expect(out.vatTreatment).toBe("not_registered");
    expect(out.vatAmount).toBe(0);
    expect(out.warnings.some((w) => /no active VAT\/GST registration/.test(w))).toBe(true);
  });

  it("names its assumptions and lowers confidence when the parties are unknown", () => {
    const out = determine(input({ supplier: unknownParty(), customer: { ...unknownParty(), endUser: false } }));
    expect(out.assumptions.length).toBeGreaterThanOrEqual(3);
    expect(out.confidence).toBeLessThan(0.7);
    expect(out.confidence).toBeGreaterThanOrEqual(0.3);
    // unknown parties: no reverse charge, standard VAT, unmatched CIS rate
    expect(out.vatTreatment).toBe("standard");
    expect(out.withholdingRate).toBe(30);
  });

  it("honours an opt-in reduced rate, cites it and warns about the burden of proof", () => {
    const out = determine(input({ rateKey: "reduced_5", customer: { ...party(), endUser: true } }));
    expect(out.vatTreatment).toBe("reduced");
    expect(out.vatRate).toBe(5);
    expect(out.vatAmount).toBe(500);
    expect(out.warnings.some((w) => /burden of proof/.test(w))).toBe(true);
    expect(out.citations.some((c) => /Sch 7A/.test(c.source))).toBe(true);
  });

  it("does not deduct when the tenant is recorded as outside CIS, and says so", () => {
    const out = determine(input({ customer: { ...party({ deductionRegistered: false }), endUser: false } }));
    expect(out.withholdingScheme).toBe("none");
    expect(out.warnings.some((w) => /NOT registered under Construction Industry Scheme/.test(w))).toBe(true);
    // customer outside CIS also fails the reverse-charge condition
    expect(out.vatTreatment).toBe("standard");
  });

  it("self-accounts imported services from an overseas supplier", () => {
    const out = determine(
      input({ supplyType: "professional_services", contractType: "consultancy", supplier: party({ country: "DE", deductionRegistered: false }) }),
    );
    expect(out.vatTreatment).toBe("reverse_charge_import");
    expect(out.selfAccountedVat).toBe(2000);
    expect(out.vatAmount).toBe(0);
  });

  it("treats imported goods as border-taxed, not invoice-taxed", () => {
    const out = determine(
      input({ supplyType: "goods", contractType: "supply_only", supplier: party({ country: "CN" }) }),
    );
    expect(out.vatTreatment).toBe("out_of_scope");
    expect(out.warnings.some((w) => /import VAT/.test(w))).toBe(true);
  });
});

describe("Ireland — 13.5% construction rate, reverse charge and RCT on the gross", () => {
  it("reverse-charges at 13.5% and deducts RCT on the full payment including materials", () => {
    const out = determine(
      input({
        regime: "ie",
        currency: "EUR",
        materialsAmount: 4000,
        supplier: party({ country: "IE", deductionRate: 20 }),
        customer: { ...party({ country: "IE" }), endUser: false },
      }),
    );
    expect(out.vatTreatment).toBe("reverse_charge");
    expect(out.vatRate).toBe(13.5);
    expect(out.selfAccountedVat).toBe(1350);
    expect(out.withholdingScheme).toBe("rct");
    expect(out.withholdingBase).toBe("gross_excl_vat");
    expect(out.withholdingBaseAmount).toBe(10000);
    expect(out.withholdingAmount).toBe(2000);
  });

  it("uses 35% for a subcontractor unknown to Revenue", () => {
    const out = determine(
      input({
        regime: "ie",
        currency: "EUR",
        supplier: party({ country: "IE", deductionRegistered: false, deductionVerified: null, deductionRate: null }),
        customer: { ...party({ country: "IE" }), endUser: false },
      }),
    );
    expect(out.withholdingRate).toBe(35);
  });

  it("applies the 13.5% rate to a main contract without the reverse charge", () => {
    const out = determine(
      input({
        regime: "ie",
        currency: "EUR",
        contractType: "main_contract",
        supplier: party({ country: "IE" }),
        customer: { ...party({ country: "IE" }), endUser: false },
      }),
    );
    expect(out.vatTreatment).toBe("reduced");
    expect(out.vatRate).toBe(13.5);
    expect(out.vatAmount).toBe(1350);
    expect(out.withholdingScheme).toBe("none"); // RCT is subcontract-only
  });
});

describe("rule-list withholding regimes", () => {
  const nr = (regime: TaxRegime, cur: string, supplierCountry: string, over: Partial<DeterminationInput> = {}) =>
    determine(
      input({
        regime,
        currency: cur,
        supplier: party({ country: supplierCountry, deductionRegistered: null, deductionVerified: null, deductionRate: null }),
        customer: { ...party({ country: supplierCountry }), endUser: false },
        ...over,
      }),
    );

  it("Singapore: 9% GST, no withholding on residents, 17% on services by a non-resident company", () => {
    const res = nr("sg", "SGD", "SG");
    expect(res.vatRate).toBe(9);
    expect(res.vatAmount).toBe(900);
    expect(res.withholdingScheme).toBe("none");
    const foreign = determine(
      input({ regime: "sg", currency: "SGD", supplier: party({ country: "MY" }), customer: { ...party({ country: "SG" }), endUser: false } }),
    );
    expect(foreign.vatTreatment).toBe("reverse_charge_import");
    expect(foreign.withholdingRate).toBe(17);
    expect(foreign.withholdingAmount).toBe(1700);
  });

  it("Australia: 47% no-ABN withholding, 5% foreign-resident works withholding, $75 threshold", () => {
    const noAbn = nr("au", "AUD", "AU", { supplier: party({ country: "AU", tinOnFile: false }) });
    expect(noAbn.withholdingScheme).toBe("backup");
    expect(noAbn.withholdingRate).toBe(47);
    const tiny = nr("au", "AUD", "AU", { amount: 50, supplier: party({ country: "AU", tinOnFile: false }) });
    expect(tiny.withholdingAmount).toBe(0);
    expect(tiny.citations.some((c) => c.element === "threshold")).toBe(true);
    const fr = determine(
      input({ regime: "au", currency: "AUD", supplier: party({ country: "NZ" }), customer: { ...party({ country: "AU" }), endUser: false } }),
    );
    expect(fr.withholdingRate).toBe(5);
    expect(fr.withholdingAmount).toBe(500);
  });

  it("New Zealand: labour-only schedular payments at 20%, 45% without a notification, 15% NRCT", () => {
    const lab = nr("nz", "NZD", "NZ", { supplyType: "labour_only" });
    expect(lab.withholdingRate).toBe(20);
    const noNotice = nr("nz", "NZD", "NZ", { supplyType: "labour_only", supplier: party({ country: "NZ", tinOnFile: false }) });
    expect(noNotice.withholdingRate).toBe(45);
    const fullService = nr("nz", "NZD", "NZ");
    expect(fullService.withholdingScheme).toBe("none");
    const nrct = determine(
      input({ regime: "nz", currency: "NZD", supplier: party({ country: "AU" }), customer: { ...party({ country: "NZ" }), endUser: false } }),
    );
    expect(nrct.withholdingRate).toBe(15);
  });

  it("Malaysia: 6% service tax on construction, 13% s107A on non-resident contractors, goods not taxable", () => {
    const res = nr("my", "MYR", "MY");
    expect(res.vatRate).toBe(6);
    expect(res.withholdingScheme).toBe("none");
    const goods = nr("my", "MYR", "MY", { supplyType: "goods", contractType: "supply_only" });
    expect(goods.vatTreatment).toBe("exempt");
    expect(goods.vatAmount).toBe(0);
    const foreign = determine(
      input({ regime: "my", currency: "MYR", supplier: party({ country: "SG" }), customer: { ...party({ country: "MY" }), endUser: false } }),
    );
    expect(foreign.withholdingRate).toBe(13);
  });

  it("South Africa: 15% VAT and no withholding on contractor payments", () => {
    const out = nr("za", "ZAR", "ZA");
    expect(out.vatRate).toBe(15);
    expect(out.withholdingScheme).toBe("none");
    const foreign = determine(
      input({ regime: "za", currency: "ZAR", supplier: party({ country: "GB" }), customer: { ...party({ country: "ZA" }), endUser: false } }),
    );
    expect(foreign.withholdingScheme).toBe("none");
  });

  it("Nigeria: 7.5% VAT, 2% construction WHT, 5% professional, 10% non-resident", () => {
    expect(nr("ng", "NGN", "NG").withholdingRate).toBe(2);
    expect(nr("ng", "NGN", "NG", { supplyType: "professional_services", contractType: "consultancy" }).withholdingRate).toBe(5);
    expect(nr("ng", "NGN", "NG").vatRate).toBe(7.5);
    const foreign = determine(
      input({ regime: "ng", currency: "NGN", supplier: party({ country: "GB" }), customer: { ...party({ country: "NG" }), endUser: false } }),
    );
    expect(foreign.withholdingRate).toBe(10);
  });

  it("Kenya: 3% contractual fees, 5% professional, 20% non-resident, KES 24,000 threshold", () => {
    expect(nr("ke", "KES", "KE", { amount: 500000 }).withholdingRate).toBe(3);
    expect(nr("ke", "KES", "KE", { amount: 500000, supplyType: "professional_services", contractType: "consultancy" }).withholdingRate).toBe(5);
    expect(nr("ke", "KES", "KE", { amount: 10000 }).withholdingAmount).toBe(0);
    const foreign = determine(
      input({ regime: "ke", currency: "KES", amount: 500000, supplier: party({ country: "IN" }), customer: { ...party({ country: "KE" }), endUser: false } }),
    );
    expect(foreign.withholdingRate).toBe(20);
  });

  it("Ghana: VAT plus two 2.5% levies on the same base, 5% works WHT, 20% non-resident", () => {
    const out = nr("gh", "GHS", "GH");
    expect(out.vatAmount).toBe(1500);
    expect(out.levies.map((l) => l.amount)).toEqual([250, 250]);
    expect(out.leviesAmount).toBe(500);
    expect(out.withholdingRate).toBe(5);
    expect(out.grossPayable).toBe(12000);
    expect(out.netPayable).toBe(11500);
    expect(out.citations.filter((c) => c.element === "levy").length).toBe(2);
    // levies do not ride on a reverse-charged import
    const imp = determine(
      input({ regime: "gh", currency: "GHS", supplier: party({ country: "GB" }), customer: { ...party({ country: "GH" }), endUser: false } }),
    );
    expect(imp.levies).toEqual([]);
    expect(imp.withholdingRate).toBe(20);
  });

  it("India: 18% GST; s194C 2% for companies, 1% for individuals, 20% without a PAN, ₹30,000 threshold, base excludes GST", () => {
    const co = nr("in", "INR", "IN", { amount: 100000 });
    expect(co.vatRate).toBe(18);
    expect(co.withholdingScheme).toBe("tds");
    expect(co.withholdingRate).toBe(2);
    expect(co.withholdingBaseAmount).toBe(100000);
    expect(co.withholdingAmount).toBe(2000);
    expect(co.assumptions.some((a) => /aggregate/.test(a))).toBe(true);
    const indiv = nr("in", "INR", "IN", { amount: 100000, supplier: party({ country: "IN", isIndividual: true }) });
    expect(indiv.withholdingRate).toBe(1);
    const noPan = nr("in", "INR", "IN", { amount: 100000, supplier: party({ country: "IN", tinOnFile: false }) });
    expect(noPan.withholdingRate).toBe(20);
    const small = nr("in", "INR", "IN", { amount: 25000 });
    expect(small.withholdingAmount).toBe(0);
    const fts = determine(
      input({ regime: "in", currency: "INR", amount: 100000, supplyType: "professional_services", contractType: "consultancy", supplier: party({ country: "GB" }), customer: { ...party({ country: "IN" }), endUser: false } }),
    );
    expect(fts.withholdingRate).toBe(10);
  });

  it("UAE: 5% VAT and no withholding of any kind", () => {
    const out = nr("ae", "AED", "AE");
    expect(out.vatRate).toBe(5);
    expect(out.withholdingScheme).toBe("none");
    expect(out.citations.some((c) => /No withholding/.test(c.rule))).toBe(true);
  });

  it("Saudi Arabia: 15% VAT, 5% on non-resident services, 20% on intercompany management fees", () => {
    expect(nr("sa", "SAR", "SA").withholdingScheme).toBe("none");
    const svc = determine(
      input({ regime: "sa", currency: "SAR", supplier: party({ country: "AE" }), customer: { ...party({ country: "SA" }), endUser: false } }),
    );
    expect(svc.withholdingRate).toBe(5);
    const mgmt = determine(
      input({ regime: "sa", currency: "SAR", contractType: "intercompany", supplier: party({ country: "AE" }), customer: { ...party({ country: "SA" }), endUser: false } }),
    );
    expect(mgmt.withholdingRate).toBe(20);
  });

  it("United States: no VAT, 24% backup withholding without a W-9, 30% on foreign persons", () => {
    const ok = nr("us", "USD", "US");
    expect(ok.vatTreatment).toBe("not_applicable");
    expect(ok.vatAmount).toBe(0);
    expect(ok.withholdingScheme).toBe("none");
    expect(ok.warnings.some((w) => /sales & use tax/.test(w))).toBe(true);
    const noW9 = nr("us", "USD", "US", { supplier: party({ country: "US", tinOnFile: false }) });
    expect(noW9.withholdingScheme).toBe("backup");
    expect(noW9.withholdingRate).toBe(24);
    const foreign = determine(
      input({ regime: "us", currency: "USD", supplier: party({ country: "MX" }), customer: { ...party({ country: "US" }), endUser: false } }),
    );
    expect(foreign.withholdingRate).toBe(30);
    expect(foreign.vatTreatment).toBe("not_applicable");
  });
});

describe("treaty relief (#805)", () => {
  it("reduces a cross-border withholding to the treaty rate and cites the reference", () => {
    const out = determine(
      input({
        regime: "ke",
        currency: "KES",
        amount: 500000,
        supplier: party({ country: "GB" }),
        customer: { ...party({ country: "KE" }), endUser: false },
        treaty: { rate: 12.5, reference: "UK–Kenya DTA art 14; certificate of residence 2026" },
      }),
    );
    expect(out.withholdingRate).toBe(12.5);
    expect(out.withholdingAmount).toBe(62500);
    expect(out.citations.some((c) => c.element === "treaty" && /UK–Kenya/.test(c.source))).toBe(true);
    expect(out.warnings.some((w) => /unevidenced/.test(w))).toBe(false);
  });

  it("warns when the relief is unreferenced, and ignores treaty claims on domestic or higher rates", () => {
    const unref = determine(
      input({
        regime: "ke",
        currency: "KES",
        amount: 500000,
        supplier: party({ country: "GB" }),
        customer: { ...party({ country: "KE" }), endUser: false },
        treaty: { rate: 10, reference: "" },
      }),
    );
    expect(unref.withholdingRate).toBe(10);
    expect(unref.warnings.some((w) => /unevidenced/.test(w))).toBe(true);
    const higher = determine(
      input({
        regime: "ke",
        currency: "KES",
        amount: 500000,
        supplier: party({ country: "GB" }),
        customer: { ...party({ country: "KE" }), endUser: false },
        treaty: { rate: 25, reference: "x" },
      }),
    );
    expect(higher.withholdingRate).toBe(20);
    const domestic = determine(input({ treaty: { rate: 5, reference: "x" } }));
    expect(domestic.withholdingRate).toBe(20);
    expect(domestic.warnings.some((w) => /domestic payment/.test(w))).toBe(true);
  });
});

describe("custom regime", () => {
  it("uses only tenant-supplied parameters, records them as such and caps confidence", () => {
    const out = determine(
      input({
        regime: "custom",
        currency: "XAF",
        custom: { vatRate: 19.25, reverseCharge: false, withholdingRate: 5.5, withholdingBase: "gross_excl_vat", citation: "CGI art 225" },
      }),
    );
    expect(out.vatRate).toBe(19.25);
    expect(out.vatAmount).toBe(1925);
    expect(out.withholdingScheme).toBe("custom");
    expect(out.withholdingAmount).toBe(550);
    expect(out.netPayable).toBe(11375);
    expect(out.confidence).toBeLessThanOrEqual(0.8);
    expect(out.citations.every((c) => c.source === "CGI art 225")).toBe(true);
  });

  it("refuses a custom determination without rules and warns when uncited", () => {
    expect(() => determine(input({ regime: "custom" }))).toThrow(/custom/);
    const out = determine(input({ regime: "custom", custom: { vatRate: 10, reverseCharge: true } }));
    expect(out.reverseCharge).toBe(true);
    expect(out.selfAccountedVat).toBe(1000);
    expect(out.warnings.some((w) => /without a citation/.test(w))).toBe(true);
  });
});

describe("positionFromRegistrations", () => {
  const asOf = "2026-09-01";
  it("reads an active, verified CIS registration as verified with its rate", () => {
    const pos = positionFromRegistrations(
      "uk",
      [
        { regime: "uk", kind: "vat", status: "active", verificationStatus: "unverified", deductionRate: null, validTo: null },
        { regime: "uk", kind: "cis", status: "active", verificationStatus: "verified", deductionRate: 0, validTo: null },
      ],
      "GB",
      asOf,
    );
    expect(pos).toMatchObject({ vatRegistered: true, deductionRegistered: true, deductionVerified: true, deductionRate: 0, tinOnFile: true });
  });

  it("treats a lapsed or expired registration as absent, and no rows at all as unknown", () => {
    const lapsed = positionFromRegistrations(
      "uk",
      [{ regime: "uk", kind: "vat", status: "lapsed", verificationStatus: "verified", deductionRate: null, validTo: null }],
      "GB",
      asOf,
    );
    expect(lapsed.vatRegistered).toBe(false);
    const expired = positionFromRegistrations(
      "uk",
      [{ regime: "uk", kind: "vat", status: "active", verificationStatus: "verified", deductionRate: null, validTo: "2025-01-01" }],
      "GB",
      asOf,
    );
    expect(expired.vatRegistered).toBe(false);
    const none = positionFromRegistrations("uk", [], "GB", asOf);
    expect(none.vatRegistered).toBeNull();
    expect(none.deductionRegistered).toBeNull();
    // registrations under another regime say nothing about this one
    const other = positionFromRegistrations(
      "uk",
      [{ regime: "ie", kind: "vat", status: "active", verificationStatus: "verified", deductionRate: null, validTo: null }],
      "GB",
      asOf,
    );
    expect(other.vatRegistered).toBeNull();
  });
});
