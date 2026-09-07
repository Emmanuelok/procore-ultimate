/**
 * ESG disclosure assembly (#541-546) — CSRD/ESRS E1 & E5, IFRS S2, TCFD and
 * the Modern Slavery statement evidence pack.
 *
 * WHY THIS IS AN ENGINE AND NOT A REPORT TEMPLATE
 *
 * A disclosure return is an ASSERTION, and an assertion the platform cannot
 * evidence must be reported as unavailable rather than as zero. That rule is
 * the entire design here:
 *
 *  · every datapoint carries a `basis` (the arithmetic that produced it) and
 *    `sources` (the records and ledger window behind it);
 *  · a datapoint the registers cannot support carries `value: null` and an
 *    `unavailableReason` — "no deliveries have been evidenced", not "0";
 *  · the return carries DATA QUALITY alongside the numbers: the share of the
 *    footprint standing on product-specific EPDs rather than generic library
 *    factors, the share of emissions with no GHG-Protocol scope, and the
 *    share of social-value delivery with no evidence attached. A CSRD
 *    assurer's first question is not the number, it is how good the number is.
 *
 * The datapoint ids are the real ESRS / IFRS S2 references, so a preparer can
 * map them into their reporting tool without a translation table.
 *
 * Pure: the caller loads the registers and passes the aggregates in.
 */

import type { DisclosureFramework } from "@constructos/shared";

export const round2 = (n: number): number => Math.round(n * 100) / 100;
export const round6 = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;

export interface Datapoint {
  /** the framework's own datapoint reference, e.g. "E1-6_gross_scope_1" */
  id: string;
  label: string;
  value: number | string | null;
  unit: string | null;
  /** the arithmetic, in words */
  basis: string;
  /** what the figure was computed from */
  sources: string[];
  /** set when the platform cannot evidence the figure; value is then null */
  unavailableReason: string | null;
}

export interface DisclosureInputs {
  periodStart: string;
  periodEnd: string;
  carbon: {
    totalTco2e: number;
    byScope: Record<string, number>;
    byModule: Record<string, number>;
    entryCount: number;
    productSpecificTco2e: number;
    /** entries with no GHG-Protocol scope recorded */
    unscopedTco2e: number;
    /** floor area, when the project has recorded one */
    giaSqm: number | null;
    budgetTargetTco2e: number | null;
  };
  waste: {
    totalTonnes: number;
    landfillTonnes: number;
    recycledTonnes: number;
    hazardousTonnes: number;
    recordCount: number;
  };
  environment: {
    readings: number;
    exceedances: number;
    incidents: number;
    reportableIncidents: number;
    incidentsNotifiedLate: number;
  };
  socialValue: {
    commitments: number;
    proxyValueCommitted: number;
    proxyValueDelivered: number;
    deliveriesWithEvidence: number;
    deliveriesTotal: number;
    shortfallCommitments: number;
  };
  labour: {
    /** modern-slavery indicator counts from the workforce register, when present */
    indicatorCounts: Record<string, number> | null;
    workersScreened: number | null;
    grievancesRaised: number;
    grievancesResolved: number;
  };
  biodiversity: {
    baselineUnits: number | null;
    postInterventionUnits: number | null;
    netGainPercent: number | null;
  };
  ledgerSeqTo: number | null;
}

const unavailable = (
  id: string,
  label: string,
  unit: string | null,
  reason: string,
): Datapoint => ({
  id,
  label,
  value: null,
  unit,
  basis: "Not computable from the records this project holds.",
  sources: [],
  unavailableReason: reason,
});

/* ------------------------------------------------------------------ */
/* ESRS E1 — climate change                                            */
/* ------------------------------------------------------------------ */

function esrsE1(i: DisclosureInputs): Datapoint[] {
  const c = i.carbon;
  const scope1 = c.byScope["scope_1"] ?? 0;
  const scope2 = c.byScope["scope_2"] ?? 0;
  const scope3 = c.byScope["scope_3"] ?? 0;
  const sourceNote = `${c.entryCount} carbon entries, ${i.periodStart}–${i.periodEnd}`;
  const out: Datapoint[] = [];

  if (c.entryCount === 0) {
    return [
      unavailable(
        "E1-6_gross_scope_1",
        "Gross Scope 1 GHG emissions",
        "tCO2e",
        "No carbon entries are recorded for this project",
      ),
      unavailable(
        "E1-6_gross_scope_2",
        "Gross Scope 2 GHG emissions (location-based)",
        "tCO2e",
        "No carbon entries are recorded for this project",
      ),
      unavailable(
        "E1-6_gross_scope_3",
        "Gross Scope 3 GHG emissions",
        "tCO2e",
        "No carbon entries are recorded for this project",
      ),
    ];
  }

  out.push(
    {
      id: "E1-6_gross_scope_1",
      label: "Gross Scope 1 GHG emissions",
      value: round6(scope1),
      unit: "tCO2e",
      basis: `Sum of carbon entries attributed to GHG-Protocol scope 1.`,
      sources: [sourceNote],
      unavailableReason: null,
    },
    {
      id: "E1-6_gross_scope_2",
      label: "Gross Scope 2 GHG emissions (location-based)",
      value: round6(scope2),
      unit: "tCO2e",
      basis: `Sum of carbon entries attributed to GHG-Protocol scope 2.`,
      sources: [sourceNote],
      unavailableReason: null,
    },
    {
      id: "E1-6_gross_scope_3",
      label: "Gross Scope 3 GHG emissions",
      value: round6(scope3),
      unit: "tCO2e",
      basis:
        `Sum of carbon entries attributed to GHG-Protocol scope 3 — on a construction ` +
        `project this is dominated by EN 15978 module A1-A3 product emissions.`,
      sources: [sourceNote],
      unavailableReason: null,
    },
    {
      id: "E1-6_total_ghg",
      label: "Total GHG emissions",
      value: round6(c.totalTco2e),
      unit: "tCO2e",
      basis:
        `Sum of every carbon entry, whether or not a scope was attributed; ` +
        `${round6(c.unscopedTco2e)} tCO2e carry no scope and are therefore in this total but ` +
        `in none of the three scope figures above.`,
      sources: [sourceNote],
      unavailableReason: null,
    },
  );

  out.push(
    c.giaSqm && c.giaSqm > 0
      ? {
          id: "E1-6_ghg_intensity",
          label: "GHG intensity per m² gross internal area",
          value: round2((c.totalTco2e * 1000) / c.giaSqm),
          unit: "kgCO2e/m²",
          basis: `${round6(c.totalTco2e)} tCO2e × 1000 ÷ ${c.giaSqm} m² GIA (RICS reporting unit).`,
          sources: [sourceNote, "Project carbon settings: gross internal area"],
          unavailableReason: null,
        }
      : unavailable(
          "E1-6_ghg_intensity",
          "GHG intensity per m² gross internal area",
          "kgCO2e/m²",
          "No gross internal area is recorded on the project, so the RICS reporting unit " +
            "cannot be computed",
        ),
  );

  out.push(
    c.budgetTargetTco2e != null && c.budgetTargetTco2e > 0
      ? {
          id: "E1-4_target_vs_actual",
          label: "Emissions against carbon budget target",
          value: round2((c.totalTco2e / c.budgetTargetTco2e) * 100),
          unit: "% of target",
          basis: `${round6(c.totalTco2e)} tCO2e against a budget target of ${c.budgetTargetTco2e} tCO2e.`,
          sources: ["Carbon budgets register"],
          unavailableReason: null,
        }
      : unavailable(
          "E1-4_target_vs_actual",
          "Emissions against carbon budget target",
          "% of target",
          "No carbon budget target is recorded for this project",
        ),
  );

  return out;
}

/* ------------------------------------------------------------------ */
/* ESRS E5 — resource use and circular economy                         */
/* ------------------------------------------------------------------ */

function esrsE5(i: DisclosureInputs): Datapoint[] {
  const w = i.waste;
  if (w.recordCount === 0) {
    return [
      unavailable(
        "E5-5_total_waste",
        "Total waste generated",
        "t",
        "No waste movements are recorded for this project",
      ),
      unavailable(
        "E5-5_diverted_from_disposal",
        "Waste diverted from disposal",
        "%",
        "No waste movements are recorded for this project",
      ),
    ];
  }
  const diverted = Math.max(0, w.totalTonnes - w.landfillTonnes);
  const source = `${w.recordCount} waste movements, ${i.periodStart}–${i.periodEnd}`;
  return [
    {
      id: "E5-5_total_waste",
      label: "Total waste generated",
      value: round2(w.totalTonnes),
      unit: "t",
      basis: "Sum of tonnage on every recorded waste movement in the period.",
      sources: [source],
      unavailableReason: null,
    },
    {
      id: "E5-5_diverted_from_disposal",
      label: "Waste diverted from disposal",
      value: w.totalTonnes > 0 ? round2((diverted / w.totalTonnes) * 100) : null,
      unit: "%",
      basis: `${round2(diverted)} t not sent to landfill ÷ ${round2(w.totalTonnes)} t total.`,
      sources: [source],
      unavailableReason: w.totalTonnes > 0 ? null : "No tonnage recorded",
    },
    {
      id: "E5-5_hazardous_waste",
      label: "Hazardous waste generated",
      value: round2(w.hazardousTonnes),
      unit: "t",
      basis: "Sum of tonnage on movements of the hazardous stream.",
      sources: [source],
      unavailableReason: null,
    },
    {
      id: "E5-5_recycled",
      label: "Waste sent for recycling",
      value: round2(w.recycledTonnes),
      unit: "t",
      basis: "Sum of tonnage recorded with a recycled destination.",
      sources: [source],
      unavailableReason: null,
    },
  ];
}

/* ------------------------------------------------------------------ */
/* ESRS S1 — own workforce & social value                              */
/* ------------------------------------------------------------------ */

function esrsS1(i: DisclosureInputs): Datapoint[] {
  const s = i.socialValue;
  const l = i.labour;
  const out: Datapoint[] = [];
  out.push(
    s.commitments > 0
      ? {
          id: "S1-17_social_value_delivered",
          label: "Social value delivered against tender commitments",
          value: s.proxyValueCommitted > 0
            ? round2((s.proxyValueDelivered / s.proxyValueCommitted) * 100)
            : null,
          unit: "% of proxy value",
          basis:
            `Proxy financial value delivered ${round2(s.proxyValueDelivered)} ÷ committed ` +
            `${round2(s.proxyValueCommitted)}, over ${s.commitments} commitments. Only ` +
            `commitments carrying a proxy value per unit are comparable across measures.`,
          sources: ["Social value register"],
          unavailableReason:
            s.proxyValueCommitted > 0
              ? null
              : "No commitment carries a proxy financial value per unit",
        }
      : unavailable(
          "S1-17_social_value_delivered",
          "Social value delivered against tender commitments",
          "% of proxy value",
          "No social value commitments are recorded for this project",
        ),
  );
  out.push({
    id: "S1-17_commitments_in_shortfall",
    label: "Tender commitments in shortfall",
    value: s.shortfallCommitments,
    unit: "commitments",
    basis: "Commitments past their due date with delivery short of target.",
    sources: ["Social value register"],
    unavailableReason: null,
  });
  out.push({
    id: "S1-16_community_grievances",
    label: "Community grievances raised and resolved",
    value: `${l.grievancesResolved}/${l.grievancesRaised}`,
    unit: "resolved/raised",
    basis: "Counts from the grievance redress register over the whole project life.",
    sources: ["Grievance register"],
    unavailableReason: null,
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* IFRS S2 / TCFD                                                      */
/* ------------------------------------------------------------------ */

function ifrsS2(i: DisclosureInputs): Datapoint[] {
  const base = esrsE1(i).filter((d) => d.id.startsWith("E1-6"));
  return base.map((d) => ({
    ...d,
    id: d.id.replace("E1-6", "IFRS_S2_29a"),
    basis: `${d.basis} IFRS S2 para 29(a) requires absolute gross GHG emissions by scope.`,
  }));
}

function tcfd(i: DisclosureInputs): Datapoint[] {
  const metrics = ifrsS2(i);
  const e = i.environment;
  return [
    ...metrics,
    {
      id: "TCFD_metrics_targets_exceedances",
      label: "Environmental limit exceedances in period",
      value: e.exceedances,
      unit: "readings",
      basis: `${e.exceedances} of ${e.readings} recorded readings breached their consent limit.`,
      sources: ["Environmental monitoring register"],
      unavailableReason: e.readings > 0 ? null : "No environmental readings are recorded",
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Modern slavery statement evidence                                   */
/* ------------------------------------------------------------------ */

function modernSlavery(i: DisclosureInputs): Datapoint[] {
  const l = i.labour;
  const out: Datapoint[] = [];
  if (l.indicatorCounts == null) {
    out.push(
      unavailable(
        "MSA_s54_indicators",
        "Forced-labour indicators identified",
        "workers",
        "The workforce register holds no labour-risk indicator data for this project",
      ),
    );
  } else {
    const total = Object.values(l.indicatorCounts).reduce((s, n) => s + n, 0);
    out.push({
      id: "MSA_s54_indicators",
      label: "Forced-labour indicators identified",
      value: total,
      unit: "workers",
      basis:
        `Sum of the workforce register's labour-risk indicators: ` +
        Object.entries(l.indicatorCounts)
          .filter(([, n]) => n > 0)
          .map(([k, n]) => `${k}=${n}`)
          .join(", ") || "no indicator was raised against any worker",
      sources: ["Workforce register — labour risk indicators"],
      unavailableReason: null,
    });
  }
  out.push(
    l.workersScreened != null
      ? {
          id: "MSA_s54_workers_screened",
          label: "Workers screened for recruitment-fee and document-retention risk",
          value: l.workersScreened,
          unit: "workers",
          basis: "Count of workers on the register carrying a completed risk screening.",
          sources: ["Workforce register"],
          unavailableReason: null,
        }
      : unavailable(
          "MSA_s54_workers_screened",
          "Workers screened for recruitment-fee and document-retention risk",
          "workers",
          "The workforce register is not populated for this project",
        ),
  );
  out.push({
    id: "MSA_s54_grievance_channel",
    label: "Worker and community grievance channel in operation",
    value: l.grievancesRaised > 0 ? "operating" : "no cases recorded",
    unit: null,
    basis:
      `${l.grievancesRaised} grievances raised, ${l.grievancesResolved} resolved. A channel ` +
      `with no cases at all is reported as such rather than as evidence of compliance — zero ` +
      `grievances more often means an unused channel than an untroubled workforce.`,
    sources: ["Grievance register"],
    unavailableReason: null,
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* GHG Protocol summary                                                */
/* ------------------------------------------------------------------ */

function ghgProtocol(i: DisclosureInputs): Datapoint[] {
  return esrsE1(i).filter((d) => d.id.startsWith("E1-6"));
}

/* ------------------------------------------------------------------ */
/* Assembly                                                            */
/* ------------------------------------------------------------------ */

export interface DataQuality {
  /** share of the footprint standing on a product-specific EPD (#498) */
  productSpecificSharePercent: number | null;
  /** share of the footprint with no GHG-Protocol scope attributed */
  unscopedSharePercent: number | null;
  /** share of social value deliveries with evidence attached */
  evidencedDeliverySharePercent: number | null;
  /** reportable environmental incidents notified after the statutory window */
  incidentsNotifiedLate: number;
  /** number of datapoints in this return the platform could not evidence */
  unavailableDatapoints: number;
  notes: string[];
}

export interface DisclosureResult {
  framework: DisclosureFramework;
  periodStart: string;
  periodEnd: string;
  datapoints: Datapoint[];
  dataQuality: DataQuality;
  ledgerSeqTo: number | null;
}

const BUILDERS: Record<DisclosureFramework, (i: DisclosureInputs) => Datapoint[]> = {
  esrs_e1_climate: esrsE1,
  esrs_e5_circular: esrsE5,
  esrs_s1_workforce: esrsS1,
  ifrs_s2_climate: ifrsS2,
  tcfd,
  modern_slavery_statement: modernSlavery,
  ghg_protocol: ghgProtocol,
};

export function assembleDisclosure(
  framework: DisclosureFramework,
  inputs: DisclosureInputs,
): DisclosureResult {
  const datapoints = BUILDERS[framework](inputs);
  const c = inputs.carbon;
  const sv = inputs.socialValue;
  const notes: string[] = [];
  if (c.entryCount === 0) notes.push("No carbon entries: every climate datapoint is unavailable.");
  if (c.unscopedTco2e > 0) {
    notes.push(
      `${round6(c.unscopedTco2e)} tCO2e carry no GHG-Protocol scope; they are in the total but ` +
        `in none of the scope splits.`,
    );
  }
  if (inputs.biodiversity.netGainPercent != null && inputs.biodiversity.netGainPercent < 0) {
    notes.push("Biodiversity accounting shows a net LOSS of habitat units for this project.");
  }
  return {
    framework,
    periodStart: inputs.periodStart,
    periodEnd: inputs.periodEnd,
    datapoints,
    dataQuality: {
      productSpecificSharePercent:
        c.totalTco2e > 0 ? round2((c.productSpecificTco2e / c.totalTco2e) * 100) : null,
      unscopedSharePercent: c.totalTco2e > 0 ? round2((c.unscopedTco2e / c.totalTco2e) * 100) : null,
      evidencedDeliverySharePercent:
        sv.deliveriesTotal > 0
          ? round2((sv.deliveriesWithEvidence / sv.deliveriesTotal) * 100)
          : null,
      incidentsNotifiedLate: inputs.environment.incidentsNotifiedLate,
      unavailableDatapoints: datapoints.filter((d) => d.unavailableReason != null).length,
      notes,
    },
    ledgerSeqTo: inputs.ledgerSeqTo,
  };
}
