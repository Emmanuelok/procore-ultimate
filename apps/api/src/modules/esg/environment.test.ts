/**
 * Unit tests for the pure ESG environment engines: consent-limit checking,
 * biodiversity units and net gain, the marginal abatement cost curve,
 * transport carbon and disclosure assembly.
 */
import { describe, expect, it } from "vitest";
import {
  STATUTORY_NET_GAIN_PERCENT,
  TRANSPORT_FACTORS,
  biodiversityUnits,
  buildMacc,
  checkLimit,
  computeNetGain,
  computeTransportLeg,
  conditionScoreFor,
  transportFactorFor,
  type OptionInput,
} from "./environment.js";
import { assembleDisclosure, type DisclosureInputs } from "./disclosure.js";

/* ================================================================== */
/* Consent limits                                                      */
/* ================================================================== */

describe("checkLimit", () => {
  it("treats a ceiling as a ceiling", () => {
    const over = checkLimit(55, 50, "max", "µg/m³");
    expect(over.exceedance).toBe(true);
    expect(over.exceedanceBy).toBe(5);
    expect(over.percentOfLimit).toBe(110);
    const under = checkLimit(45, 50, "max", "µg/m³");
    expect(under.exceedance).toBe(false);
    expect(under.exceedanceBy).toBe(0);
  });

  it("treats a floor as a floor — a dissolved-oxygen limit bites downward", () => {
    const under = checkLimit(4, 5, "min", "mg/l");
    expect(under.exceedance).toBe(true);
    expect(under.exceedanceBy).toBe(1);
    expect(under.basis).toContain("below");
    expect(checkLimit(6, 5, "min", "mg/l").exceedance).toBe(false);
  });

  it("draws no compliance conclusion from a point with no limit", () => {
    const r = checkLimit(999, null, "max", "dB");
    expect(r.exceedance).toBe(false);
    expect(r.exceedanceBy).toBeNull();
    expect(r.percentOfLimit).toBeNull();
    expect(r.basis).toContain("baseline observation");
  });

  it("does not divide by a zero limit", () => {
    expect(checkLimit(1, 0, "max", "x").percentOfLimit).toBeNull();
  });

  it("exactly at the limit is not an exceedance", () => {
    expect(checkLimit(50, 50, "max", "u").exceedance).toBe(false);
    expect(checkLimit(50, 50, "min", "u").exceedance).toBe(false);
  });
});

/* ================================================================== */
/* Biodiversity                                                        */
/* ================================================================== */

describe("biodiversity units and net gain", () => {
  it("multiplies area × distinctiveness × condition × strategic significance", () => {
    expect(
      biodiversityUnits({
        areaHectares: 2,
        distinctiveness: 4,
        conditionScore: 3,
        strategicSignificance: 1.15,
      }),
    ).toBe(27.6);
  });

  it("maps condition bands, defaulting an unknown band to the lowest", () => {
    expect(conditionScoreFor("good")).toBe(3);
    expect(conditionScoreFor("poor")).toBe(1);
    expect(conditionScoreFor("nonsense")).toBe(1);
  });

  it("measures gain against the statutory test when no target is recorded", () => {
    const r = computeNetGain({ baselineUnits: 100, postInterventionUnits: 111 });
    expect(r.netChangeUnits).toBe(11);
    expect(r.netGainPercent).toBe(11);
    expect(r.meetsTarget).toBe(true);
    expect(r.basis).toContain(`${STATUTORY_NET_GAIN_PERCENT}%`);
    expect(computeNetGain({ baselineUnits: 100, postInterventionUnits: 105 }).meetsTarget).toBe(
      false,
    );
  });

  it("uses a recorded contractual target in preference to the statutory one", () => {
    const r = computeNetGain({
      baselineUnits: 100,
      postInterventionUnits: 118,
      targetUnits: 120,
    });
    expect(r.meetsTarget).toBe(false);
    expect(r.basis).toContain("recorded target");
  });

  it("reports a net LOSS distinctly", () => {
    const r = computeNetGain({ baselineUnits: 100, postInterventionUnits: 80 });
    expect(r.netLoss).toBe(true);
    expect(r.netGainPercent).toBe(-20);
  });

  it("cannot compute gain with no baseline, and says so rather than reporting zero", () => {
    const r = computeNetGain({ baselineUnits: 0, postInterventionUnits: 50 });
    expect(r.netGainPercent).toBeNull();
    expect(r.meetsTarget).toBeNull();
    expect(r.basis).toContain("cannot be computed");
  });
});

/* ================================================================== */
/* Marginal abatement cost (#502-504)                                  */
/* ================================================================== */

describe("buildMacc", () => {
  const opts = (...rows: OptionInput[]) => rows;

  it("ranks by cost per tonne abated against the baseline", () => {
    const m = buildMacc(
      opts(
        { id: "a", name: "Baseline slab", isBaseline: true, tco2e: 100, cost: 1_000_000 },
        { id: "b", name: "GGBS 50%", isBaseline: false, tco2e: 70, cost: 1_030_000 },
        { id: "c", name: "Post-tensioned", isBaseline: false, tco2e: 60, cost: 1_200_000 },
      ),
    );
    expect(m.baselineId).toBe("a");
    const b = m.rows.find((r) => r.id === "b")!;
    expect(b.abatementTco2e).toBe(30);
    expect(b.costDelta).toBe(30_000);
    expect(b.abatementCostPerTonne).toBe(1000);
    const c = m.rows.find((r) => r.id === "c")!;
    expect(c.abatementCostPerTonne).toBe(5000);
    expect(m.bestValueId).toBe("b");
  });

  it("identifies no-regret options — cheaper AND cleaner", () => {
    const m = buildMacc(
      opts(
        { id: "a", name: "Baseline", isBaseline: true, tco2e: 100, cost: 1_000_000 },
        { id: "b", name: "Less concrete", isBaseline: false, tco2e: 80, cost: 950_000 },
      ),
    );
    expect(m.noRegretIds).toEqual(["b"]);
    expect(m.rows.find((r) => r.id === "b")!.abatementCostPerTonne).toBe(-2500);
  });

  it("never ranks an unpriced option as though it were free", () => {
    const m = buildMacc(
      opts(
        { id: "a", name: "Baseline", isBaseline: true, tco2e: 100, cost: 1_000_000 },
        { id: "b", name: "Unpriced", isBaseline: false, tco2e: 50, cost: null },
      ),
    );
    const b = m.rows.find((r) => r.id === "b")!;
    expect(b.abatementTco2e).toBe(50);
    expect(b.abatementCostPerTonne).toBeNull();
    expect(b.unavailableReason).toContain("no cost");
    expect(m.bestValueId).toBeNull();
    expect(m.note).toContain("could not be priced");
  });

  it("refuses to compute abatement with no baseline and says why", () => {
    const m = buildMacc(
      opts({ id: "b", name: "Option", isBaseline: false, tco2e: 50, cost: 1 }),
    );
    expect(m.baselineId).toBeNull();
    expect(m.rows[0]!.abatementTco2e).toBeNull();
    expect(m.note).toContain("baseline");
  });

  it("reports an option that abates nothing rather than dividing by zero", () => {
    const m = buildMacc(
      opts(
        { id: "a", name: "Baseline", isBaseline: true, tco2e: 100, cost: 100 },
        { id: "b", name: "Same carbon", isBaseline: false, tco2e: 100, cost: 200 },
      ),
    );
    const b = m.rows.find((r) => r.id === "b")!;
    expect(b.abatementCostPerTonne).toBeNull();
    expect(b.unavailableReason).toContain("abates nothing");
  });
});

/* ================================================================== */
/* Transport carbon                                                    */
/* ================================================================== */

describe("computeTransportLeg", () => {
  it("computes tonne-km × factor ÷ 1000, multiplied by trips", () => {
    const factor = transportFactorFor("rigid_truck")!;
    const r = computeTransportLeg({
      mode: "rigid_truck",
      distanceKm: 100,
      payloadTonnes: 10,
      trips: 3,
    })!;
    expect(r.tonneKm).toBe(3000);
    expect(r.factorKgCo2ePerTonneKm).toBe(factor.kgCo2ePerTonneKm);
    expect(r.tco2e).toBeCloseTo((3000 * factor.kgCo2ePerTonneKm) / 1000, 6);
    expect(r.factorSource).toBe(factor.source);
  });

  it("attributes a project-supplied factor to the project, not the library", () => {
    const r = computeTransportLeg({
      mode: "rail",
      distanceKm: 500,
      payloadTonnes: 20,
      factorOverride: 0.02,
      factorSourceOverride: "Client-published factor set 2026",
    })!;
    expect(r.factorKgCo2ePerTonneKm).toBe(0.02);
    expect(r.factorSource).toBe("Client-published factor set 2026");
    expect(r.tco2e).toBe(0.2);
  });

  it("returns null for an unknown mode rather than estimating from nothing", () => {
    expect(
      computeTransportLeg({ mode: "teleport", distanceKm: 1, payloadTonnes: 1 }),
    ).toBeNull();
  });

  it("publishes a factor and a source for every declared mode", () => {
    for (const f of TRANSPORT_FACTORS) {
      expect(f.kgCo2ePerTonneKm, f.mode).toBeGreaterThan(0);
      expect(f.source.length, f.mode).toBeGreaterThan(0);
    }
    // air freight is by far the worst; that ordering must not silently invert
    const air = transportFactorFor("air_freight")!;
    const sea = transportFactorFor("sea_container")!;
    expect(air.kgCo2ePerTonneKm).toBeGreaterThan(sea.kgCo2ePerTonneKm * 10);
  });
});

/* ================================================================== */
/* Disclosure assembly (#541-546)                                      */
/* ================================================================== */

const inputs = (over: Partial<DisclosureInputs> = {}): DisclosureInputs => ({
  periodStart: "2026-01-01",
  periodEnd: "2026-12-31",
  carbon: {
    totalTco2e: 1000,
    byScope: { scope_1: 100, scope_2: 50, scope_3: 800 },
    byModule: { "A1-A3": 900, A4: 100 },
    entryCount: 42,
    productSpecificTco2e: 300,
    unscopedTco2e: 50,
    giaSqm: 5000,
    budgetTargetTco2e: 900,
  },
  waste: {
    totalTonnes: 200,
    landfillTonnes: 20,
    recycledTonnes: 150,
    hazardousTonnes: 5,
    recordCount: 12,
  },
  environment: {
    readings: 100,
    exceedances: 3,
    incidents: 2,
    reportableIncidents: 1,
    incidentsNotifiedLate: 1,
  },
  socialValue: {
    commitments: 5,
    proxyValueCommitted: 500_000,
    proxyValueDelivered: 300_000,
    deliveriesWithEvidence: 8,
    deliveriesTotal: 10,
    shortfallCommitments: 1,
  },
  labour: {
    indicatorCounts: null,
    workersScreened: 40,
    grievancesRaised: 6,
    grievancesResolved: 4,
  },
  biodiversity: { baselineUnits: 100, postInterventionUnits: 90, netGainPercent: -10 },
  ledgerSeqTo: 4242,
  ...over,
});

describe("assembleDisclosure", () => {
  it("builds every declared framework and carries the ledger sequence", () => {
    for (const framework of [
      "esrs_e1_climate",
      "esrs_e5_circular",
      "esrs_s1_workforce",
      "ifrs_s2_climate",
      "tcfd",
      "modern_slavery_statement",
      "ghg_protocol",
    ] as const) {
      const r = assembleDisclosure(framework, inputs());
      expect(r.framework, framework).toBe(framework);
      expect(r.datapoints.length, framework).toBeGreaterThan(0);
      expect(r.ledgerSeqTo, framework).toBe(4242);
      for (const d of r.datapoints) {
        // the core honesty rule: a value with no source is unavailable,
        // never zero, and it says why
        if (d.value === null) expect(d.unavailableReason, `${framework}/${d.id}`).toBeTruthy();
        expect(d.basis.length, `${framework}/${d.id}`).toBeGreaterThan(0);
      }
    }
  });

  it("reports data quality shares, not raw counts alone", () => {
    const r = assembleDisclosure("esrs_e1_climate", inputs());
    expect(r.dataQuality.productSpecificSharePercent).toBe(30);
    expect(r.dataQuality.unscopedSharePercent).toBe(5);
    expect(r.dataQuality.evidencedDeliverySharePercent).toBe(80);
    expect(r.dataQuality.incidentsNotifiedLate).toBe(1);
  });

  it("marks every climate datapoint unavailable when there are no carbon entries", () => {
    const r = assembleDisclosure(
      "esrs_e1_climate",
      inputs({
        carbon: {
          totalTco2e: 0,
          byScope: {},
          byModule: {},
          entryCount: 0,
          productSpecificTco2e: 0,
          unscopedTco2e: 0,
          giaSqm: null,
          budgetTargetTco2e: null,
        },
      }),
    );
    expect(r.dataQuality.unavailableDatapoints).toBeGreaterThan(0);
    expect(r.dataQuality.notes.join(" ")).toContain("No carbon entries");
    expect(r.dataQuality.productSpecificSharePercent).toBeNull();
  });

  it("calls out a biodiversity net loss in the notes", () => {
    const r = assembleDisclosure("esrs_e1_climate", inputs());
    expect(r.dataQuality.notes.join(" ")).toContain("net LOSS");
  });

  it("flags unscoped emissions that sit in the total but in no scope split", () => {
    const r = assembleDisclosure("ghg_protocol", inputs());
    expect(r.dataQuality.notes.join(" ")).toContain("no GHG-Protocol scope");
  });
});
