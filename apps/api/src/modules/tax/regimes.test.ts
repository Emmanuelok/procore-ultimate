import { describe, expect, it } from "vitest";
import { TAX_REGIMES, TAX_RETURN_KINDS, TAX_SUPPLY_TYPES } from "@constructos/shared";
import {
  findReturnDef,
  findTaxRegime,
  libraryCoversAllRegimes,
  regimeForCountry,
  summariseRegime,
  TAX_REGIME_LIBRARY,
} from "./regimes.js";

describe("tax regime library", () => {
  it("covers every regime exactly once, each with cited, honest reference data", () => {
    expect(libraryCoversAllRegimes()).toBe(true);
    expect(TAX_REGIME_LIBRARY.length).toBe(TAX_REGIMES.length);
    const seen = new Set<string>();
    for (const def of TAX_REGIME_LIBRARY) {
      expect(seen.has(def.regime)).toBe(false);
      seen.add(def.regime);
      expect(def.summary.length).toBeGreaterThan(60);
      expect(def.indirectTax.citation.length).toBeGreaterThan(5);
      expect(def.indirectTax.standardRate).toBeGreaterThanOrEqual(0);
      for (const r of def.indirectTax.otherRates) {
        expect(r.citation.length).toBeGreaterThan(5);
        expect(r.rate).toBeGreaterThanOrEqual(0);
      }
      for (const key of Object.values(def.indirectTax.supplyDefaults)) {
        expect(def.indirectTax.otherRates.some((r) => r.key === key)).toBe(true);
      }
      for (const ret of def.returns) {
        expect(TAX_RETURN_KINDS).toContain(ret.kind);
        expect(ret.dueDaysAfterPeriodEnd).toBeGreaterThan(0);
        expect(ret.periodMonths).toBeGreaterThan(0);
        expect(ret.citation.length).toBeGreaterThan(5);
      }
      expect(def.permanentEstablishment.constructionSiteDays).toBeGreaterThan(0);
      expect(def.permanentEstablishment.serviceDays).toBeGreaterThan(0);
      if (def.withholding) {
        for (const rule of [...def.withholding.resident, ...def.withholding.nonResident]) {
          expect(rule.rate).toBeGreaterThan(0);
          expect(rule.citation.length).toBeGreaterThan(5);
          for (const st of rule.supplyTypes ?? []) expect(TAX_SUPPLY_TYPES).toContain(st);
        }
        if (def.withholding.registrationDriven) {
          const rd = def.withholding.registrationDriven;
          expect(rd.unverifiedRate).toBeGreaterThan(rd.verifiedNetRate);
          expect(rd.verifiedGrossRate).toBe(0);
        }
      }
      for (const levy of def.levies) expect(levy.rate).toBeGreaterThan(0);
      if (def.regime !== "custom") {
        expect(def.countryCode).toMatch(/^[A-Z]{2}$/);
        expect(def.ratesAsAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it("models the headline rates the engine depends on", () => {
    expect(findTaxRegime("uk")?.indirectTax.standardRate).toBe(20);
    expect(findTaxRegime("uk")?.withholding?.registrationDriven).toMatchObject({
      verifiedGrossRate: 0,
      verifiedNetRate: 20,
      unverifiedRate: 30,
      base: "gross_excl_materials",
    });
    expect(findTaxRegime("ie")?.indirectTax.supplyDefaults.construction_services).toBe("reduced_13_5");
    expect(findTaxRegime("ie")?.withholding?.registrationDriven?.base).toBe("gross_excl_vat");
    expect(findTaxRegime("sg")?.indirectTax.standardRate).toBe(9);
    expect(findTaxRegime("au")?.indirectTax.standardRate).toBe(10);
    expect(findTaxRegime("nz")?.indirectTax.standardRate).toBe(15);
    expect(findTaxRegime("my")?.indirectTax.kind).toBe("sst");
    expect(findTaxRegime("za")?.indirectTax.standardRate).toBe(15);
    expect(findTaxRegime("ng")?.indirectTax.standardRate).toBe(7.5);
    expect(findTaxRegime("ke")?.indirectTax.standardRate).toBe(16);
    expect(findTaxRegime("gh")?.levies.map((l) => l.rate)).toEqual([2.5, 2.5]);
    expect(findTaxRegime("in")?.indirectTax.standardRate).toBe(18);
    expect(findTaxRegime("ae")?.withholding).toBeNull();
    expect(findTaxRegime("sa")?.indirectTax.standardRate).toBe(15);
    expect(findTaxRegime("us")?.indirectTax.kind).toBe("none");
    expect(findTaxRegime("us")?.withholding?.scheme).toBe("backup");
  });

  it("only the UK and Ireland carry a domestic construction reverse charge", () => {
    const withDrc = TAX_REGIME_LIBRARY.filter((d) => d.reverseCharge.domesticConstruction).map(
      (d) => d.regime,
    );
    expect(withDrc.sort()).toEqual(["ie", "uk"]);
  });

  it("maps countries (codes, names and aliases) to regimes and returns null for the unknown", () => {
    expect(regimeForCountry("GB")).toBe("uk");
    expect(regimeForCountry("uk")).toBe("uk");
    expect(regimeForCountry("United Kingdom")).toBe("uk");
    expect(regimeForCountry("IE")).toBe("ie");
    expect(regimeForCountry("India")).toBe("in");
    expect(regimeForCountry("USA")).toBe("us");
    expect(regimeForCountry("FR")).toBeNull();
    expect(regimeForCountry(null)).toBeNull();
    expect(regimeForCountry("")).toBeNull();
  });

  it("finds return definitions per regime and kind", () => {
    expect(findReturnDef("uk", "cis_monthly")?.dueDaysAfterPeriodEnd).toBe(14);
    expect(findReturnDef("uk", "vat")?.cadence).toBe("quarterly");
    expect(findReturnDef("ae", "cis_monthly")).toBeUndefined();
    expect(findReturnDef("nope", "vat")).toBeUndefined();
  });

  it("summarises a regime for the reference tab without leaking structure", () => {
    const s = summariseRegime(findTaxRegime("gh")!);
    expect(s.levies).toEqual(["National Health Insurance Levy 2.5%", "Ghana Education Trust Fund Levy 2.5%"]);
    expect(s.withholdingScheme).toBe("wht");
    expect(s.domesticReverseCharge).toBe(false);
    expect(s.peConstructionSiteDays).toBe(183);
  });
});
