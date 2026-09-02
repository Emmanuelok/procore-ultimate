import type {
  TaxContractType,
  TaxRegime,
  TaxSupplyType,
  TaxVatTreatment,
  TaxWithholdingBase,
  TaxWithholdingScheme,
} from "@constructos/shared";
import {
  findTaxRegime,
  type RateOption,
  type TaxRegimeDef,
  type WithholdingRule,
} from "./regimes.js";

/**
 * Tax determination engine — spec Vol II Domain Q #798 (VAT/GST treatment by
 * jurisdiction and supply type), #799 (reverse charge for construction),
 * #800–802 (CIS deduction rate determination), #804 (withholding on
 * cross-border payments), #805 (treaty relief), #816 (levies).
 *
 * Pure and deterministic: the same input always yields the same output, and
 * every figure in the output is traceable to a cited rule in the regime
 * library or to a tenant-supplied parameter that is named as such. The
 * engine never guesses a concession (reduced/zero rates are opt-in by
 * `rateKey`), and where an input is unknown it says what it assumed and
 * lowers its confidence instead of silently picking the convenient answer.
 *
 * Deliberately NOT done here: state/local sales taxes, surcharges/cesses,
 * annual aggregate thresholds, partial-exemption input-tax recovery — each
 * is named in the regime library note where it applies.
 */

export interface PartyTaxPosition {
  /** ISO-3166 alpha-2; null = unknown */
  country: string | null;
  /** holds an active VAT/GST/SST registration in the regime; null = unknown */
  vatRegistered: boolean | null;
  /** holds a CIS/RCT-type registration (any verification state); null = unknown */
  deductionRegistered: boolean | null;
  /** that registration has been verified with the authority */
  deductionVerified: boolean | null;
  /** authority-assigned deduction rate on the verified registration (%) */
  deductionRate: number | null;
  /** a tax identifier (TIN/ABN/PAN/W-9/IRD) is on file; null = unknown */
  tinOnFile: boolean | null;
  /** supplier is an individual / sole trader / HUF */
  isIndividual: boolean;
}

export interface CustomRules {
  vatRate?: number | null;
  vatTreatment?: TaxVatTreatment | null;
  reverseCharge?: boolean | null;
  withholdingRate?: number | null;
  withholdingBase?: TaxWithholdingBase | null;
  citation?: string | null;
}

export interface DeterminationInput {
  regime: TaxRegime;
  supplyType: TaxSupplyType;
  contractType: TaxContractType;
  /** the supply value net of VAT and before any deduction */
  amount: number;
  currency: string;
  /** the part of `amount` that is materials the supplier paid for */
  materialsAmount: number;
  /** ISO-3166 alpha-2 of where the works are performed; null = regime country */
  placeOfSupplyCountry: string | null;
  supplier: PartyTaxPosition;
  customer: PartyTaxPosition & { endUser: boolean };
  /** opt-in reduced/zero/exempt rate from the regime's `otherRates` */
  rateKey: string | null;
  /** treaty relief claimed on a cross-border payment (#805) */
  treaty: { rate: number; reference: string } | null;
  /** regime = custom only */
  custom: CustomRules | null;
  asOf: string;
}

export interface Citation {
  /** which element of the output the citation supports */
  element: "vat" | "reverse_charge" | "withholding" | "levy" | "treaty" | "threshold";
  rule: string;
  source: string;
}

export interface LevyLine {
  key: string;
  name: string;
  rate: number;
  amount: number;
  recoverable: boolean;
}

export interface DeterminationOutput {
  regime: TaxRegime;
  vatTreatment: TaxVatTreatment;
  vatRate: number;
  /** VAT the supplier charges on the invoice */
  vatAmount: number;
  /** VAT the customer must self-account for (reverse charge) */
  selfAccountedVat: number;
  reverseCharge: boolean;
  withholdingScheme: TaxWithholdingScheme;
  withholdingBase: TaxWithholdingBase;
  withholdingBaseAmount: number;
  withholdingRate: number;
  withholdingAmount: number;
  levies: LevyLine[];
  leviesAmount: number;
  /** amount + VAT charged + levies */
  grossPayable: number;
  /** grossPayable − withholding */
  netPayable: number;
  citations: Citation[];
  warnings: string[];
  assumptions: string[];
  confidence: number;
  explanation: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

const SERVICE_TYPES: ReadonlySet<TaxSupplyType> = new Set([
  "construction_services",
  "labour_only",
  "professional_services",
  "plant_hire",
  "mixed",
]);

const GOODS_TYPES: ReadonlySet<TaxSupplyType> = new Set(["goods", "materials_only"]);

function norm(country: string | null | undefined): string | null {
  if (!country) return null;
  const c = country.trim().toUpperCase();
  return c === "UK" ? "GB" : c;
}

export class DeterminationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeterminationError";
  }
}

/** Validates the input shape the engine relies on; throws DeterminationError. */
export function validateInput(input: DeterminationInput): void {
  if (!Number.isFinite(input.amount) || input.amount < 0) {
    throw new DeterminationError("amount must be a non-negative finite number");
  }
  if (!Number.isFinite(input.materialsAmount) || input.materialsAmount < 0) {
    throw new DeterminationError("materialsAmount must be a non-negative finite number");
  }
  if (input.materialsAmount > input.amount + 0.005) {
    throw new DeterminationError("materialsAmount cannot exceed the supply amount");
  }
  if (input.treaty && (!Number.isFinite(input.treaty.rate) || input.treaty.rate < 0)) {
    throw new DeterminationError("treaty.rate must be a non-negative number");
  }
  if (!findTaxRegime(input.regime)) {
    throw new DeterminationError(`Unknown tax regime: ${input.regime}`);
  }
}

interface Ctx {
  def: TaxRegimeDef;
  input: DeterminationInput;
  citations: Citation[];
  warnings: string[];
  assumptions: string[];
  crossBorder: boolean;
}

function pickRateOption(def: TaxRegimeDef, key: string): RateOption {
  const opt = def.indirectTax.otherRates.find((r) => r.key === key);
  if (!opt) {
    throw new DeterminationError(
      `rateKey "${key}" is not a rate the ${def.name} library offers (${def.indirectTax.otherRates.map((r) => r.key).join(", ") || "none"})`,
    );
  }
  return opt;
}

/* ------------------------------------------------------------------ */
/* Indirect tax                                                        */
/* ------------------------------------------------------------------ */

interface VatResult {
  treatment: TaxVatTreatment;
  rate: number;
  charged: number;
  selfAccounted: number;
  reverseCharge: boolean;
}

function determineVat(ctx: Ctx): VatResult {
  const { def, input } = ctx;
  const tax = def.indirectTax;
  const amount = input.amount;

  if (tax.kind === "none") {
    ctx.citations.push({ element: "vat", rule: tax.name, source: tax.citation });
    if (tax.note) ctx.warnings.push(tax.note);
    return { treatment: "not_applicable", rate: 0, charged: 0, selfAccounted: 0, reverseCharge: false };
  }

  const isService = SERVICE_TYPES.has(input.supplyType);
  const isGoods = GOODS_TYPES.has(input.supplyType);

  // Cross-border supplier: services are self-accounted by the customer where
  // the regime has an imported-services rule; goods meet import VAT at the
  // border, which is not on this invoice.
  if (ctx.crossBorder) {
    if (isGoods) {
      ctx.citations.push({
        element: "vat",
        rule: "Imported goods — import VAT/duty is assessed at the border, not charged by the supplier (#814)",
        source: tax.citation,
      });
      ctx.warnings.push(
        "Goods from an overseas supplier: import VAT and customs duty are payable on entry and should be allocated to the cost (#814); no VAT is charged on this invoice.",
      );
      return { treatment: "out_of_scope", rate: 0, charged: 0, selfAccounted: 0, reverseCharge: false };
    }
    const imp = def.reverseCharge.importedServices;
    if (imp && isService) {
      const customerOk = imp.requiresCustomerVat ? input.customer.vatRegistered === true : true;
      if (customerOk) {
        ctx.citations.push({ element: "reverse_charge", rule: imp.summary, source: imp.citation });
        if (imp.requiresCustomerVat === false && input.customer.vatRegistered === null) {
          ctx.assumptions.push(
            "Customer registration status unknown; the imported-services rule applies regardless of registration in this regime.",
          );
        }
        return {
          treatment: "reverse_charge_import",
          rate: tax.standardRate,
          charged: 0,
          selfAccounted: round2((amount * tax.standardRate) / 100),
          reverseCharge: true,
        };
      }
      if (input.customer.vatRegistered === null) {
        ctx.assumptions.push(
          "Customer VAT registration unknown — imported-services reverse charge assumed to apply; confirm the tenant's registration.",
        );
        ctx.citations.push({ element: "reverse_charge", rule: imp.summary, source: imp.citation });
        return {
          treatment: "reverse_charge_import",
          rate: tax.standardRate,
          charged: 0,
          selfAccounted: round2((amount * tax.standardRate) / 100),
          reverseCharge: true,
        };
      }
      ctx.warnings.push(
        "Services from an overseas supplier to an unregistered customer: no reverse charge; the supplier may need to register locally.",
      );
      ctx.citations.push({ element: "vat", rule: "Overseas supplier, unregistered customer — out of scope for a reverse charge", source: imp.citation });
      return { treatment: "out_of_scope", rate: 0, charged: 0, selfAccounted: 0, reverseCharge: false };
    }
  }

  // A supplier known not to be registered cannot charge VAT at all.
  if (input.supplier.vatRegistered === false) {
    ctx.citations.push({
      element: "vat",
      rule: "Only a registered person may charge VAT/GST; an unregistered supplier's invoice must show none",
      source: tax.citation,
    });
    ctx.warnings.push(
      "Supplier has no active VAT/GST registration on file: no tax may be charged on this supply. Refuse an invoice that shows tax.",
    );
    return { treatment: "not_registered", rate: 0, charged: 0, selfAccounted: 0, reverseCharge: false };
  }

  // Domestic reverse charge for construction (UK s 55A; IE s 16(3)).
  const drc = def.reverseCharge.domesticConstruction;
  if (
    drc &&
    drc.supplyTypes.includes(input.supplyType) &&
    drc.contractTypes.includes(input.contractType)
  ) {
    const customerVatOk = drc.requiresCustomerVat ? input.customer.vatRegistered === true : true;
    const customerSchemeOk = drc.requiresCustomerDeductionScheme
      ? input.customer.deductionRegistered === true
      : true;
    const endUserBlocks = drc.endUserExcluded && input.customer.endUser;
    if (customerVatOk && customerSchemeOk && !endUserBlocks) {
      if (input.supplier.vatRegistered === null) {
        ctx.assumptions.push(
          "Supplier VAT registration unknown — reverse charge applied on the assumption the supplier is registered; an unregistered supplier is invoiced without VAT either way.",
        );
      }
      const rateOpt = input.rateKey ? pickRateOption(def, input.rateKey) : null;
      const defaultKey = tax.supplyDefaults[input.supplyType];
      const eff = rateOpt ?? (defaultKey ? pickRateOption(def, defaultKey) : null);
      const rate = eff ? eff.rate : tax.standardRate;
      ctx.citations.push({ element: "reverse_charge", rule: drc.summary, source: drc.citation });
      if (eff) ctx.citations.push({ element: "vat", rule: `${eff.appliesTo} — ${eff.rate}%`, source: eff.citation });
      return {
        treatment: "reverse_charge",
        rate,
        charged: 0,
        selfAccounted: round2((amount * rate) / 100),
        reverseCharge: true,
      };
    }
    if (endUserBlocks) {
      ctx.citations.push({
        element: "reverse_charge",
        rule: "Customer is an end user — the reverse charge does not apply and the supplier invoices VAT normally",
        source: drc.citation,
      });
    } else if (input.customer.vatRegistered === null || input.customer.deductionRegistered === null) {
      ctx.assumptions.push(
        "Customer VAT/deduction-scheme registration unknown — the domestic reverse charge was NOT applied. Set the project tax profile to determine it.",
      );
    } else {
      ctx.citations.push({
        element: "reverse_charge",
        rule: "Reverse charge conditions not met (customer not VAT-registered or outside the deduction scheme) — normal VAT applies",
        source: drc.citation,
      });
    }
  }

  // Ordinary domestic supply.
  if (input.supplier.vatRegistered === null) {
    ctx.assumptions.push(
      "Supplier VAT/GST registration unknown — standard treatment assumed. Verify the registration before paying tax on the invoice.",
    );
  }
  const chosen = input.rateKey
    ? pickRateOption(def, input.rateKey)
    : tax.supplyDefaults[input.supplyType]
      ? pickRateOption(def, tax.supplyDefaults[input.supplyType]!)
      : null;
  if (chosen) {
    ctx.citations.push({ element: "vat", rule: `${chosen.appliesTo} — ${chosen.rate}%`, source: chosen.citation });
    if (input.rateKey) {
      ctx.warnings.push(
        `A ${chosen.treatment} rate was claimed (${chosen.key}); the burden of proof for the concession sits with the party claiming it — retain the evidence.`,
      );
    }
    return {
      treatment: chosen.treatment,
      rate: chosen.rate,
      charged: round2((amount * chosen.rate) / 100),
      selfAccounted: 0,
      reverseCharge: false,
    };
  }
  ctx.citations.push({ element: "vat", rule: `${tax.name} standard rate ${tax.standardRate}%`, source: tax.citation });
  return {
    treatment: "standard",
    rate: tax.standardRate,
    charged: round2((amount * tax.standardRate) / 100),
    selfAccounted: 0,
    reverseCharge: false,
  };
}

/* ------------------------------------------------------------------ */
/* Withholding                                                         */
/* ------------------------------------------------------------------ */

interface WhtResult {
  scheme: TaxWithholdingScheme;
  base: TaxWithholdingBase;
  baseAmount: number;
  rate: number;
  amount: number;
}

const NONE: WhtResult = { scheme: "none", base: "none", baseAmount: 0, rate: 0, amount: 0 };

function baseAmountFor(base: TaxWithholdingBase, input: DeterminationInput): number {
  switch (base) {
    case "gross_excl_materials":
      return round2(Math.max(0, input.amount - input.materialsAmount));
    case "labour_only":
      return round2(Math.max(0, input.amount - input.materialsAmount));
    case "gross_excl_vat":
      return round2(input.amount);
    default:
      return 0;
  }
}

function ruleMatches(rule: WithholdingRule, input: DeterminationInput): boolean {
  if (rule.supplyTypes && !rule.supplyTypes.includes(input.supplyType)) return false;
  if (rule.contractTypes && !rule.contractTypes.includes(input.contractType)) return false;
  if (rule.requires === "no_tin" && input.supplier.tinOnFile !== false) return false;
  if (rule.requires === "individual" && !input.supplier.isIndividual) return false;
  if (rule.requires === "company" && input.supplier.isIndividual) return false;
  return true;
}

function determineWithholding(ctx: Ctx): WhtResult {
  const { def, input } = ctx;
  const wht = def.withholding;
  if (!wht) {
    ctx.citations.push({ element: "withholding", rule: "No withholding or deduction scheme in this regime", source: def.name });
    return NONE;
  }

  // Registration-driven schemes (UK CIS, IE RCT): the rate is what the
  // authority told the customer about THIS supplier.
  const rd = wht.registrationDriven;
  if (rd) {
    const inScope =
      rd.supplyTypes.includes(input.supplyType) && rd.contractTypes.includes(input.contractType);
    if (!inScope) {
      ctx.citations.push({
        element: "withholding",
        rule: `${wht.name}: this supply type / contract type is outside the scheme — no deduction`,
        source: rd.citation,
      });
      return NONE;
    }
    if (rd.requiresCustomerScheme && input.customer.deductionRegistered === false) {
      ctx.citations.push({
        element: "withholding",
        rule: `${wht.name}: the paying party is not registered in the scheme, so it has no duty to deduct`,
        source: rd.citation,
      });
      ctx.warnings.push(
        `The tenant is recorded as NOT registered under ${wht.name}. A business paying for construction operations above the deemed-contractor threshold must register; confirm the profile.`,
      );
      return NONE;
    }
    if (rd.requiresCustomerScheme && input.customer.deductionRegistered === null) {
      ctx.assumptions.push(
        `Tenant's ${wht.name} status unknown — deduction computed as if the tenant is a registered contractor/principal.`,
      );
    }
    let rate: number;
    let basis: string;
    if (input.supplier.deductionVerified === true && input.supplier.deductionRate !== null) {
      rate = input.supplier.deductionRate;
      basis =
        rate === rd.verifiedGrossRate
          ? `Verified: gross payment status — ${rate}%`
          : `Verified by the authority at ${rate}%`;
    } else if (input.supplier.deductionRegistered === true) {
      rate = rd.unverifiedRate;
      basis = `Registered but not verified with the authority — higher rate ${rate}% applies until verified`;
      ctx.warnings.push(
        `Supplier's ${wht.name} registration is on file but unverified: the ${rate}% unmatched rate applies. Verify before paying (#801).`,
      );
    } else {
      rate = rd.unverifiedRate;
      basis = `No ${wht.name} registration on file — unmatched rate ${rate}%`;
      ctx.warnings.push(
        `No ${wht.name} registration on file for the supplier: deduct at ${rate}% and verify with the authority (#801).`,
      );
      if (input.supplier.deductionRegistered === null) {
        ctx.assumptions.push("Supplier deduction-scheme registration unknown; treated as unmatched.");
      }
    }
    const baseAmount = baseAmountFor(rd.base, input);
    ctx.citations.push({ element: "withholding", rule: `${rd.summary} ${basis}.`, source: rd.citation });
    if (rd.base === "gross_excl_materials" && input.materialsAmount > 0) {
      ctx.citations.push({
        element: "withholding",
        rule: `Materials of ${input.currency} ${input.materialsAmount.toFixed(2)} excluded from the deduction base`,
        source: rd.citation,
      });
    }
    return {
      scheme: wht.scheme,
      base: rd.base,
      baseAmount,
      rate,
      amount: round2((baseAmount * rate) / 100),
    };
  }

  // Rule-list schemes: first matching rule wins, resident vs non-resident.
  const list = ctx.crossBorder ? wht.nonResident : wht.resident;
  const rule = list.find((r) => ruleMatches(r, input));
  if (!rule) {
    ctx.citations.push({
      element: "withholding",
      rule: `${wht.name}: no withholding rule applies to a ${ctx.crossBorder ? "non-resident" : "resident"} ${input.supplyType.replace(/_/g, " ")} supply`,
      source: def.name,
    });
    return NONE;
  }
  if (rule.threshold && input.amount < rule.threshold.amount) {
    ctx.citations.push({
      element: "threshold",
      rule: `${rule.threshold.note}: this payment of ${input.currency} ${input.amount.toFixed(2)} is below the threshold — nothing withheld`,
      source: rule.citation,
    });
    if (/aggregate|annual|month/i.test(rule.threshold.note)) {
      ctx.assumptions.push(
        "Threshold applied to this payment alone; the payee's aggregate for the period is not tracked here.",
      );
    }
    return NONE;
  }
  const baseAmount = baseAmountFor(rule.base, input);
  ctx.citations.push({ element: "withholding", rule: `${rule.when} — ${rule.rate}%`, source: rule.citation });
  if (rule.threshold) {
    ctx.assumptions.push(
      "Threshold applied to this payment alone; the payee's aggregate for the period is not tracked here.",
    );
  }
  return {
    scheme: rule.scheme,
    base: rule.base,
    baseAmount,
    rate: rule.rate,
    amount: round2((baseAmount * rule.rate) / 100),
  };
}

function applyTreaty(ctx: Ctx, wht: WhtResult): WhtResult {
  const { input } = ctx;
  if (!input.treaty || !ctx.crossBorder || wht.rate === 0) {
    if (input.treaty && !ctx.crossBorder) {
      ctx.warnings.push("Treaty relief was claimed on a domestic payment; ignored.");
    }
    return wht;
  }
  if (input.treaty.rate >= wht.rate) {
    ctx.citations.push({
      element: "treaty",
      rule: `Treaty rate ${input.treaty.rate}% is not lower than the domestic rate ${wht.rate}% — domestic rate retained`,
      source: input.treaty.reference || "treaty reference not supplied",
    });
    return wht;
  }
  if (!input.treaty.reference.trim()) {
    ctx.warnings.push(
      "Treaty relief claimed without a treaty article / residence certificate reference: relief applied but unevidenced (#805).",
    );
  }
  ctx.citations.push({
    element: "treaty",
    rule: `Treaty relief: withholding reduced from ${wht.rate}% to ${input.treaty.rate}% (#805)`,
    source: input.treaty.reference.trim() || "tenant claim, unreferenced",
  });
  return {
    ...wht,
    rate: input.treaty.rate,
    amount: round2((wht.baseAmount * input.treaty.rate) / 100),
  };
}

/* ------------------------------------------------------------------ */
/* Custom regime                                                       */
/* ------------------------------------------------------------------ */

function determineCustom(ctx: Ctx): DeterminationOutput {
  const { input, def } = ctx;
  const c = input.custom;
  if (!c) throw new DeterminationError("The custom regime requires `custom` rules on every determination");
  const cite = c.citation?.trim() || "tenant-supplied, uncited";
  if (!c.citation?.trim()) ctx.warnings.push("Custom rules were supplied without a citation.");
  const rc = c.reverseCharge === true;
  const vatRate = c.vatRate ?? 0;
  if (c.vatRate === undefined || c.vatRate === null) {
    ctx.assumptions.push("No custom VAT rate supplied — 0% recorded.");
  }
  const treatment: TaxVatTreatment = rc
    ? "reverse_charge"
    : (c.vatTreatment ?? (vatRate > 0 ? "standard" : "out_of_scope"));
  ctx.citations.push({ element: "vat", rule: `Custom indirect tax ${vatRate}% (${treatment})`, source: cite });
  const charged = rc ? 0 : round2((input.amount * vatRate) / 100);
  const selfAccounted = rc ? round2((input.amount * vatRate) / 100) : 0;
  const whtRate = c.withholdingRate ?? 0;
  const base: TaxWithholdingBase = whtRate > 0 ? (c.withholdingBase ?? "gross_excl_vat") : "none";
  const baseAmount = baseAmountFor(base, input);
  const whtAmount = round2((baseAmount * whtRate) / 100);
  if (whtRate > 0) {
    ctx.citations.push({ element: "withholding", rule: `Custom withholding ${whtRate}% on ${base.replace(/_/g, " ")}`, source: cite });
  }
  const gross = round2(input.amount + charged);
  const net = round2(gross - whtAmount);
  return finalise(ctx, {
    regime: def.regime,
    vatTreatment: treatment,
    vatRate,
    vatAmount: charged,
    selfAccountedVat: selfAccounted,
    reverseCharge: rc,
    withholdingScheme: whtRate > 0 ? "custom" : "none",
    withholdingBase: base,
    withholdingBaseAmount: baseAmount,
    withholdingRate: whtRate,
    withholdingAmount: whtAmount,
    levies: [],
    leviesAmount: 0,
    grossPayable: gross,
    netPayable: net,
  });
}

/* ------------------------------------------------------------------ */
/* Assembly                                                            */
/* ------------------------------------------------------------------ */

type Draft = Omit<DeterminationOutput, "citations" | "warnings" | "assumptions" | "confidence" | "explanation">;

function finalise(ctx: Ctx, d: Draft): DeterminationOutput {
  const assumptions = [...new Set(ctx.assumptions)];
  const warnings = [...new Set(ctx.warnings)];
  const confidence = Math.max(0.3, round2(1 - assumptions.length * 0.15 - (ctx.def.regime === "custom" ? 0.2 : 0)));
  const cur = ctx.input.currency;
  const parts: string[] = [];
  parts.push(`${ctx.def.name}.`);
  switch (d.vatTreatment) {
    case "reverse_charge":
      parts.push(`Domestic reverse charge: supplier charges no ${ctx.def.indirectTax.name}; customer self-accounts ${cur} ${d.selfAccountedVat.toFixed(2)} at ${d.vatRate}%.`);
      break;
    case "reverse_charge_import":
      parts.push(`Imported service: customer self-accounts ${cur} ${d.selfAccountedVat.toFixed(2)} at ${d.vatRate}%.`);
      break;
    case "not_registered":
      parts.push("Supplier not registered — no tax may be charged.");
      break;
    case "not_applicable":
      parts.push("No VAT/GST in this regime.");
      break;
    case "out_of_scope":
      parts.push("Supply outside the scope of the regime's VAT on this invoice.");
      break;
    default:
      parts.push(`${d.vatTreatment} rate ${d.vatRate}%: ${cur} ${d.vatAmount.toFixed(2)} charged.`);
  }
  if (d.leviesAmount > 0) {
    parts.push(`Levies ${d.levies.map((l) => `${l.name} ${l.rate}%`).join(", ")}: ${cur} ${d.leviesAmount.toFixed(2)}.`);
  }
  if (d.withholdingAmount > 0) {
    parts.push(`Withhold ${d.withholdingRate}% of ${cur} ${d.withholdingBaseAmount.toFixed(2)} (${d.withholdingBase.replace(/_/g, " ")}) under ${d.withholdingScheme.toUpperCase()}: ${cur} ${d.withholdingAmount.toFixed(2)}.`);
  } else {
    parts.push("No withholding.");
  }
  parts.push(`Net payable ${cur} ${d.netPayable.toFixed(2)}.`);
  if (assumptions.length > 0) parts.push(`${assumptions.length} assumption(s) lowered confidence to ${confidence}.`);
  return {
    ...d,
    citations: ctx.citations,
    warnings,
    assumptions,
    confidence,
    explanation: parts.join(" "),
  };
}

export function determine(input: DeterminationInput): DeterminationOutput {
  validateInput(input);
  const def = findTaxRegime(input.regime)!;
  const supplierCountry = norm(input.supplier.country);
  const ctx: Ctx = {
    def,
    input,
    citations: [],
    warnings: [],
    assumptions: [],
    crossBorder: false,
  };

  if (def.regime === "custom") {
    ctx.crossBorder = supplierCountry !== null && supplierCountry !== norm(input.customer.country);
    return determineCustom(ctx);
  }

  if (supplierCountry === null) {
    ctx.assumptions.push("Supplier country unknown — treated as resident in the regime.");
    ctx.crossBorder = false;
  } else {
    ctx.crossBorder = supplierCountry !== def.countryCode;
  }
  const place = norm(input.placeOfSupplyCountry);
  if (place && place !== def.countryCode) {
    ctx.warnings.push(
      `Place of supply ${place} differs from the regime country ${def.countryCode}: the works may be taxable where performed, not under this regime.`,
    );
  }

  const vat = determineVat(ctx);

  // Levies ride on a domestically charged supply at the same base.
  const levies: LevyLine[] = [];
  if (vat.treatment === "standard" || vat.treatment === "reduced") {
    for (const l of def.levies) {
      const amount = round2((input.amount * l.rate) / 100);
      levies.push({ key: l.key, name: l.name, rate: l.rate, amount, recoverable: l.recoverable });
      ctx.citations.push({ element: "levy", rule: `${l.name} ${l.rate}%${l.recoverable ? "" : " (not recoverable as input tax)"}`, source: l.citation });
    }
  }
  const leviesAmount = round2(levies.reduce((s, l) => s + l.amount, 0));

  const wht = applyTreaty(ctx, determineWithholding(ctx));

  const gross = round2(input.amount + vat.charged + leviesAmount);
  const net = round2(gross - wht.amount);

  return finalise(ctx, {
    regime: def.regime,
    vatTreatment: vat.treatment,
    vatRate: vat.rate,
    vatAmount: vat.charged,
    selfAccountedVat: vat.selfAccounted,
    reverseCharge: vat.reverseCharge,
    withholdingScheme: wht.scheme,
    withholdingBase: wht.base,
    withholdingBaseAmount: wht.baseAmount,
    withholdingRate: wht.rate,
    withholdingAmount: wht.amount,
    levies,
    leviesAmount,
    grossPayable: gross,
    netPayable: net,
  });
}

/** A neutral party position: everything unknown. */
export function unknownParty(country: string | null = null): PartyTaxPosition {
  return {
    country,
    vatRegistered: null,
    deductionRegistered: null,
    deductionVerified: null,
    deductionRate: null,
    tinOnFile: null,
    isIndividual: false,
  };
}

/**
 * Derive a party's position from its registration rows (the shape stored in
 * tax_registrations). Pure so the route layer stays thin and the rule is
 * unit-testable: an ACTIVE registration counts; verification is read from
 * the deduction-scheme registration only.
 */
export interface RegistrationLike {
  regime: string;
  kind: string;
  status: string;
  verificationStatus: string;
  deductionRate: number | null;
  validTo: string | null;
}

export function positionFromRegistrations(
  regime: TaxRegime,
  rows: RegistrationLike[],
  country: string | null,
  asOf: string,
  isIndividual = false,
): PartyTaxPosition {
  const live = rows.filter(
    (r) => r.regime === regime && r.status === "active" && (!r.validTo || r.validTo >= asOf),
  );
  const any = rows.some((r) => r.regime === regime);
  const vat = live.find((r) => r.kind === "vat");
  const ded = live.find((r) => r.kind === "cis" || r.kind === "rct");
  const tin = live.find((r) => r.kind === "tin" || r.kind === "vat" || r.kind === "wht");
  return {
    country,
    vatRegistered: vat ? true : any ? false : null,
    deductionRegistered: ded ? true : any ? false : null,
    deductionVerified: ded ? ded.verificationStatus === "verified" : null,
    deductionRate: ded && ded.verificationStatus === "verified" ? ded.deductionRate : null,
    tinOnFile: tin ? true : any ? false : null,
    isIndividual,
  };
}
