import {
  TAX_REGIMES,
  type TaxContractType,
  type TaxRegime,
  type TaxReturnKind,
  type TaxSupplyType,
  type TaxWithholdingBase,
  type TaxWithholdingScheme,
} from "@constructos/shared";

/**
 * Tax regime library — spec Vol II Domain Q (#798–806, #816–819).
 *
 * Code-resident reference data, like payments/regimes.ts: the rates,
 * reverse-charge conditions, deduction schemes, return cadences and
 * permanent-establishment thresholds that drive the determination engine
 * (determine.ts), the period register and the PE exposure register. Nothing
 * here is tenant data; a tenant whose facts differ uses the `custom` regime
 * or a rate-key override, and the determination records which it was.
 *
 * DOCUMENTED SIMPLIFICATIONS (deliberate, so the model stays honest):
 * - Every rate is PINNED at `ratesAsAt` and cited. Rates change by budget;
 *   the library does not track legislative history, so a determination
 *   carries the pinned figure and its date and a reviewer can challenge it.
 * - Reduced and zero rates are OPT-IN by `rateKey`: the engine never guesses
 *   that a supply qualifies for a concession, because the burden of proof for
 *   a concession sits with the party claiming it.
 * - Withholding thresholds are applied to the single payment being
 *   determined; aggregate-per-year thresholds (India s194C ₹1,00,000) are
 *   noted as an assumption rather than computed, because the platform does
 *   not hold the payee's whole-year position.
 * - Surcharges and cesses on withholding (India) and state/local sales taxes
 *   (US) are not computed; the note says so and the treatment is recorded as
 *   `not_applicable`/`out_of_scope` with the reason.
 * - Return due dates are calendar-day offsets from the period end. Weekend /
 *   public-holiday roll-forwards and electronic-filing extensions are noted
 *   in the return definition, not computed.
 * - PE thresholds are the OECD-model / domestic-law day counts for a building
 *   site; a specific treaty can shorten or lengthen them and the exposure
 *   record allows the threshold to be overridden with a stated basis.
 */

export interface RateOption {
  /** selectable key, e.g. "reduced_5" */
  key: string;
  rate: number;
  treatment: "standard" | "reduced" | "zero" | "exempt";
  appliesTo: string;
  citation: string;
}

export interface IndirectTaxDef {
  kind: "vat" | "gst" | "sst" | "sales_use" | "none";
  name: string;
  /** % — 0 when the regime has no VAT/GST */
  standardRate: number;
  otherRates: RateOption[];
  /** rate key the engine applies by default for a supply type (IE construction 13.5%) */
  supplyDefaults: Partial<Record<TaxSupplyType, string>>;
  registrationThreshold: { amount: number; currency: string; note: string } | null;
  citation: string;
  note: string | null;
}

export interface DomesticReverseChargeDef {
  supplyTypes: TaxSupplyType[];
  contractTypes: TaxContractType[];
  /** the customer must be VAT-registered */
  requiresCustomerVat: boolean;
  /** the customer must also be inside the deduction scheme (UK: CIS; IE: RCT) */
  requiresCustomerDeductionScheme: boolean;
  /** an end user / intermediary supplier is outside the reverse charge (UK) */
  endUserExcluded: boolean;
  citation: string;
  summary: string;
}

export interface ImportedServicesDef {
  requiresCustomerVat: boolean;
  citation: string;
  summary: string;
}

export interface ReverseChargeDef {
  domesticConstruction: DomesticReverseChargeDef | null;
  importedServices: ImportedServicesDef | null;
}

export interface WithholdingRule {
  key: string;
  scheme: TaxWithholdingScheme;
  rate: number;
  base: TaxWithholdingBase;
  /** undefined = any */
  supplyTypes?: TaxSupplyType[];
  contractTypes?: TaxContractType[];
  /** extra condition on the supplier */
  requires?: "no_tin" | "individual" | "company";
  /** single-payment threshold below which nothing is withheld */
  threshold?: { amount: number; note: string } | null;
  when: string;
  citation: string;
}

export interface RegistrationDrivenDef {
  /** rate for a verified holder with gross-payment status */
  verifiedGrossRate: number;
  /** rate for a verified holder with standard net status */
  verifiedNetRate: number;
  /** rate when the payee cannot be matched / is not registered */
  unverifiedRate: number;
  base: TaxWithholdingBase;
  supplyTypes: TaxSupplyType[];
  contractTypes: TaxContractType[];
  /** the customer must itself be inside the scheme to have a duty to deduct */
  requiresCustomerScheme: boolean;
  citation: string;
  summary: string;
}

export interface WithholdingDef {
  scheme: TaxWithholdingScheme;
  name: string;
  summary: string;
  registrationDriven: RegistrationDrivenDef | null;
  resident: WithholdingRule[];
  nonResident: WithholdingRule[];
  certificateName: string;
  remittance: string;
  /** days a verification stays good for before the sweep flags it (UK CIS: 2 tax years) */
  verificationValidityDays: number | null;
}

export interface LevyDef {
  key: string;
  name: string;
  rate: number;
  recoverable: boolean;
  citation: string;
}

export interface ReturnDef {
  kind: TaxReturnKind;
  name: string;
  cadence: "monthly" | "bi_monthly" | "quarterly" | "annual" | "tax_month";
  periodMonths: number;
  dueDaysAfterPeriodEnd: number;
  paymentDueDaysAfterPeriodEnd: number | null;
  citation: string;
  note: string | null;
}

export interface PeDef {
  /** OECD art 5(3)-style building-site threshold, in days */
  constructionSiteDays: number;
  /** services / individual presence threshold, in days */
  serviceDays: number;
  basis: string;
  citation: string;
}

export interface TaxRegimeDef {
  regime: TaxRegime;
  name: string;
  jurisdiction: string;
  /** ISO-3166 alpha-2 */
  countryCode: string;
  currency: string;
  /** author's plain-language summary */
  summary: string;
  ratesAsAt: string;
  indirectTax: IndirectTaxDef;
  reverseCharge: ReverseChargeDef;
  withholding: WithholdingDef | null;
  levies: LevyDef[];
  returns: ReturnDef[];
  permanentEstablishment: PeDef;
  /** what a compliant tax invoice must carry (#818) */
  invoiceRequirements: string[];
  /** e-invoicing mandate, if any (#819) */
  eInvoicing: string | null;
  notes: string[];
}

const CONSTRUCTION: TaxSupplyType[] = ["construction_services", "labour_only", "plant_hire", "mixed"];
const SERVICES: TaxSupplyType[] = [
  "construction_services",
  "labour_only",
  "professional_services",
  "plant_hire",
  "mixed",
];
const WORKS_CONTRACTS: TaxContractType[] = ["main_contract", "subcontract"];

const OECD_PE: PeDef = {
  constructionSiteDays: 365,
  serviceDays: 183,
  basis: "OECD Model art 5(3): a building site or construction/installation project is a PE only if it lasts more than twelve months; services / individual presence measured against 183 days in any twelve-month period.",
  citation: "OECD Model Tax Convention art 5(3); art 15(2)",
};

export const TAX_REGIME_LIBRARY: TaxRegimeDef[] = [
  /* ---------------------------------------------------------------- */
  {
    regime: "uk",
    name: "United Kingdom — VAT, domestic reverse charge and CIS",
    jurisdiction: "United Kingdom",
    countryCode: "GB",
    currency: "GBP",
    ratesAsAt: "2025-04-06",
    summary:
      "VAT at 20% on construction services, with the domestic reverse charge shifting the " +
      "VAT accounting to a VAT- and CIS-registered customer that is not an end user. Under the " +
      "Construction Industry Scheme a contractor deducts 20% (verified), 30% (unmatched) or 0% " +
      "(gross payment status) from the labour element of payments to subcontractors and " +
      "reports monthly.",
    indirectTax: {
      kind: "vat",
      name: "Value Added Tax",
      standardRate: 20,
      otherRates: [
        {
          key: "reduced_5",
          rate: 5,
          treatment: "reduced",
          appliesTo:
            "Qualifying residential conversions, renovations of dwellings empty 2+ years, certain energy-saving materials",
          citation: "VATA 1994 Sch 7A Groups 6–7",
        },
        {
          key: "zero_new_dwelling",
          rate: 0,
          treatment: "zero",
          appliesTo: "Construction of new dwellings and relevant residential/charitable buildings",
          citation: "VATA 1994 Sch 8 Group 5",
        },
        {
          key: "exempt",
          rate: 0,
          treatment: "exempt",
          appliesTo: "Exempt supplies (e.g. certain interests in land)",
          citation: "VATA 1994 Sch 9 Group 1",
        },
      ],
      supplyDefaults: {},
      registrationThreshold: {
        amount: 90000,
        currency: "GBP",
        note: "Taxable turnover in any rolling 12 months (from 1 April 2024)",
      },
      citation: "Value Added Tax Act 1994 s 2 (20% standard rate)",
      note: null,
    },
    reverseCharge: {
      domesticConstruction: {
        supplyTypes: CONSTRUCTION,
        contractTypes: WORKS_CONTRACTS,
        requiresCustomerVat: true,
        requiresCustomerDeductionScheme: true,
        endUserExcluded: true,
        citation:
          "VATA 1994 s 55A; VAT (Section 55A) (Specified Services and Excepted Supplies) Order 2019 (SI 2019/892), in force 1 March 2021",
        summary:
          "Specified construction services supplied between VAT-registered businesses that are " +
          "both reported under CIS: the supplier does not charge VAT; the customer accounts for " +
          "it as output tax and recovers it as input tax. End users and intermediary suppliers " +
          "who notify their status are excluded and are invoiced normally.",
      },
      importedServices: {
        requiresCustomerVat: true,
        citation: "VATA 1994 s 8 (reverse charge on services received from abroad)",
        summary:
          "A VAT-registered UK customer receiving services from an overseas supplier accounts for the VAT itself.",
      },
    },
    withholding: {
      scheme: "cis",
      name: "Construction Industry Scheme",
      summary:
        "Contractors (including deemed contractors) verify each subcontractor with HMRC and " +
        "deduct at the rate HMRC states from the payment less the cost of materials and VAT.",
      registrationDriven: {
        verifiedGrossRate: 0,
        verifiedNetRate: 20,
        unverifiedRate: 30,
        base: "gross_excl_materials",
        supplyTypes: CONSTRUCTION,
        contractTypes: WORKS_CONTRACTS,
        requiresCustomerScheme: true,
        citation:
          "Finance Act 2004 Part 3 Ch 3 ss 57–77; Income Tax (Construction Industry Scheme) Regulations 2005 (SI 2005/2045) reg 6 (verification)",
        summary:
          "20% for a subcontractor HMRC has verified for net payment; 30% where HMRC cannot " +
          "match the subcontractor; 0% (gross) where gross payment status has been granted. " +
          "Materials the subcontractor paid for are excluded from the deduction base.",
      },
      resident: [],
      nonResident: [],
      certificateName: "CIS payment and deduction statement",
      remittance:
        "Deductions are paid to HMRC by the 22nd of the month following the tax month (19th by post) together with the CIS300 monthly return, due by the 19th.",
      verificationValidityDays: 730,
    },
    levies: [],
    returns: [
      {
        kind: "vat",
        name: "VAT return",
        cadence: "quarterly",
        periodMonths: 3,
        dueDaysAfterPeriodEnd: 37,
        paymentDueDaysAfterPeriodEnd: 37,
        citation: "VAT Regulations 1995 reg 25 (one month and seven days)",
        note: "Modelled as 37 calendar days; direct-debit payers get three further working days.",
      },
      {
        kind: "cis_monthly",
        name: "CIS300 monthly return",
        cadence: "tax_month",
        periodMonths: 1,
        dueDaysAfterPeriodEnd: 14,
        paymentDueDaysAfterPeriodEnd: 17,
        citation: "SI 2005/2045 reg 4 (return by the 19th of the month after the tax month ending on the 5th)",
        note: "Tax months run 6th–5th; the return is due on the 19th and electronic payment by the 22nd.",
      },
    ],
    permanentEstablishment: {
      constructionSiteDays: 365,
      serviceDays: 183,
      basis:
        "Domestic law follows the OECD model: a building site or construction project is a PE if it lasts more than 12 months (CTA 2010 s 1141 as read with treaties); an individual becomes UK-resident under the statutory residence test at 183 days.",
      citation: "CTA 2010 s 1141; FA 2013 Sch 45 para 7 (183 days)",
    },
    invoiceRequirements: [
      "Supplier VAT number, invoice number and date, customer name/address",
      "Rate and amount of VAT per line — or the legend 'Reverse charge: customer to pay the VAT to HMRC' with the VAT amount or rate shown",
      "Under CIS: the gross amount, cost of materials and the deduction, on the payment and deduction statement",
    ],
    eInvoicing: null,
    notes: [
      "Professional services (architects, surveyors, consultants) and materials-only supplies are outside CIS.",
      "The reverse charge does not apply to supplies to end users or intermediary suppliers who have confirmed their status in writing.",
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    regime: "ie",
    name: "Ireland — VAT, construction reverse charge and RCT",
    jurisdiction: "Ireland",
    countryCode: "IE",
    currency: "EUR",
    ratesAsAt: "2025-01-01",
    summary:
      "Construction services are generally at the 13.5% reduced VAT rate. Between a principal " +
      "contractor and a subcontractor within RCT the VAT is reverse-charged to the principal. " +
      "Relevant Contracts Tax obliges the principal to notify each payment to Revenue and to " +
      "deduct 0%, 20% or 35% as Revenue determines for that subcontractor.",
    indirectTax: {
      kind: "vat",
      name: "Value-Added Tax",
      standardRate: 23,
      otherRates: [
        {
          key: "reduced_13_5",
          rate: 13.5,
          treatment: "reduced",
          appliesTo:
            "Construction services, including development of immovable goods (the two-thirds rule can push a supply to the standard rate)",
          citation: "VAT Consolidation Act 2010 Sch 3 Part 2 para 14",
        },
        {
          key: "reduced_9",
          rate: 9,
          treatment: "reduced",
          appliesTo: "Second reduced rate (specific supplies; not construction)",
          citation: "VATCA 2010 s 46(1)(ca)",
        },
        {
          key: "zero",
          rate: 0,
          treatment: "zero",
          appliesTo: "Zero-rated supplies (Schedule 2)",
          citation: "VATCA 2010 Sch 2",
        },
      ],
      supplyDefaults: {
        construction_services: "reduced_13_5",
        labour_only: "reduced_13_5",
        mixed: "reduced_13_5",
      },
      registrationThreshold: {
        amount: 42500,
        currency: "EUR",
        note: "Services threshold in any continuous 12 months (from 1 January 2025); €85,000 for goods",
      },
      citation: "VAT Consolidation Act 2010 s 46(1)(a) (23% standard rate)",
      note: "Two-thirds rule: where the VAT-exclusive cost of goods supplied exceeds two-thirds of the total charge, the whole supply takes the goods rate.",
    },
    reverseCharge: {
      domesticConstruction: {
        supplyTypes: CONSTRUCTION,
        contractTypes: ["subcontract"],
        requiresCustomerVat: true,
        requiresCustomerDeductionScheme: true,
        endUserExcluded: false,
        citation: "VATCA 2010 s 16(3) (construction services to a principal contractor)",
        summary:
          "Where RCT applies to the contract, the subcontractor issues an invoice without VAT " +
          "bearing 'VAT on this supply to be accounted for by the principal contractor' and the " +
          "principal self-accounts.",
      },
      importedServices: {
        requiresCustomerVat: true,
        citation: "VATCA 2010 s 12 (received services)",
        summary: "Services received from abroad are self-accounted by an accountable person.",
      },
    },
    withholding: {
      scheme: "rct",
      name: "Relevant Contracts Tax",
      summary:
        "The principal must notify the contract and every payment to Revenue through ROS before " +
        "paying; Revenue returns the deduction rate for that subcontractor (0%, 20% or 35%). " +
        "Deduction applies to the full payment excluding VAT — materials are NOT excluded.",
      registrationDriven: {
        verifiedGrossRate: 0,
        verifiedNetRate: 20,
        unverifiedRate: 35,
        base: "gross_excl_vat",
        supplyTypes: CONSTRUCTION,
        contractTypes: ["subcontract"],
        requiresCustomerScheme: true,
        citation: "Taxes Consolidation Act 1997 Part 18 Ch 2 ss 530–531; s 530F (rates of deduction)",
        summary:
          "0% for a fully compliant subcontractor, 20% standard, 35% where the subcontractor is " +
          "unknown to Revenue or seriously non-compliant.",
      },
      resident: [],
      nonResident: [],
      certificateName: "RCT deduction authorisation / payment notification acknowledgement",
      remittance:
        "Deductions are returned on the monthly (or quarterly) deduction summary and paid by the 23rd of the following month via ROS.",
      verificationValidityDays: null,
    },
    levies: [],
    returns: [
      {
        kind: "vat",
        name: "VAT3 return",
        cadence: "bi_monthly",
        periodMonths: 2,
        dueDaysAfterPeriodEnd: 23,
        paymentDueDaysAfterPeriodEnd: 23,
        citation: "VATCA 2010 s 76 (19th; 23rd for ROS filers)",
        note: "Modelled on the ROS date (23rd).",
      },
      {
        kind: "rct_monthly",
        name: "RCT deduction summary",
        cadence: "monthly",
        periodMonths: 1,
        dueDaysAfterPeriodEnd: 23,
        paymentDueDaysAfterPeriodEnd: 23,
        citation: "TCA 1997 s 530K; Income Tax (RCT) Regulations 2012",
        note: null,
      },
    ],
    permanentEstablishment: OECD_PE,
    invoiceRequirements: [
      "Supplier VAT number; sequential invoice number; date; customer name and address",
      "Reverse-charge legend: 'VAT on this supply to be accounted for by the Principal Contractor'",
      "RCT: payment notification acknowledgement reference from ROS",
    ],
    eInvoicing: null,
    notes: [
      "A payment made without a payment notification attracts a penalty on the principal even if the subcontractor's rate is 0%.",
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    regime: "sg",
    name: "Singapore — GST",
    jurisdiction: "Singapore",
    countryCode: "SG",
    currency: "SGD",
    ratesAsAt: "2024-01-01",
    summary:
      "GST at 9% on construction services supplied in Singapore. No domestic construction " +
      "reverse charge and no withholding on payments to resident contractors; services " +
      "performed in Singapore by non-resident companies attract withholding at the prevailing " +
      "corporate rate.",
    indirectTax: {
      kind: "gst",
      name: "Goods and Services Tax",
      standardRate: 9,
      otherRates: [
        {
          key: "zero_export",
          rate: 0,
          treatment: "zero",
          appliesTo: "Exports and international services",
          citation: "GST Act 1993 s 21",
        },
      ],
      supplyDefaults: {},
      registrationThreshold: {
        amount: 1000000,
        currency: "SGD",
        note: "Taxable turnover over a calendar year",
      },
      citation: "Goods and Services Tax Act 1993 s 16; rate 9% from 1 January 2024",
      note: null,
    },
    reverseCharge: {
      domesticConstruction: null,
      importedServices: {
        requiresCustomerVat: true,
        citation: "GST Act 1993 s 14 (reverse charge on imported services, from 1 January 2020)",
        summary:
          "A GST-registered customer that is not entitled to full input tax credit self-accounts for GST on imported services; fully taxable businesses are outside it — the determination flags, it does not assume.",
      },
    },
    withholding: {
      scheme: "wht",
      name: "Withholding tax on payments to non-residents",
      summary:
        "No withholding on payments to Singapore-resident contractors. Services rendered in " +
        "Singapore by a non-resident company are subject to withholding at the prevailing " +
        "corporate tax rate; treaty relief on a certificate of residence.",
      registrationDriven: null,
      resident: [],
      nonResident: [
        {
          key: "nr_services",
          scheme: "wht",
          rate: 17,
          base: "gross_excl_vat",
          supplyTypes: SERVICES,
          when: "Services performed in Singapore by a non-resident company",
          citation: "Income Tax Act 1947 s 45A read with s 43(1) (prevailing corporate rate 17%)",
        },
      ],
      certificateName: "Form IR37 withholding tax filing",
      remittance: "Withheld tax is filed and paid to IRAS by the 15th of the second month following the payment date.",
      verificationValidityDays: null,
    },
    levies: [],
    returns: [
      {
        kind: "vat",
        name: "GST F5 return",
        cadence: "quarterly",
        periodMonths: 3,
        dueDaysAfterPeriodEnd: 30,
        paymentDueDaysAfterPeriodEnd: 30,
        citation: "GST Act 1993 s 41 (one month after the end of the accounting period)",
        note: null,
      },
    ],
    permanentEstablishment: {
      constructionSiteDays: 183,
      serviceDays: 183,
      basis:
        "Domestic law lists a building site or construction/installation project as a PE without a minimum duration; most Singapore treaties apply a six-month (183-day) threshold, which is the figure modelled.",
      citation: "Income Tax Act 1947 s 2(1) 'permanent establishment'; typical treaty art 5(3)",
    },
    invoiceRequirements: [
      "The words 'Tax Invoice', supplier GST registration number, invoice number and date",
      "GST-exclusive amount, GST amount and rate, total",
    ],
    eInvoicing: "InvoiceNow (Peppol) mandatory for newly GST-registered businesses from 1 November 2025.",
    notes: [],
  },

  /* ---------------------------------------------------------------- */
  {
    regime: "au",
    name: "Australia — GST, no-ABN and foreign-resident works withholding",
    jurisdiction: "Australia",
    countryCode: "AU",
    currency: "AUD",
    ratesAsAt: "2025-07-01",
    summary:
      "GST at 10%. A payer must withhold 47% where the supplier does not quote an ABN, and " +
      "5% from payments to foreign residents for construction and related activities. " +
      "Businesses in building and construction report contractor payments annually (TPAR).",
    indirectTax: {
      kind: "gst",
      name: "Goods and Services Tax",
      standardRate: 10,
      otherRates: [
        {
          key: "gst_free",
          rate: 0,
          treatment: "zero",
          appliesTo: "GST-free supplies (exports, certain going concerns)",
          citation: "A New Tax System (GST) Act 1999 Div 38",
        },
      ],
      supplyDefaults: {},
      registrationThreshold: {
        amount: 75000,
        currency: "AUD",
        note: "GST turnover",
      },
      citation: "A New Tax System (GST) Act 1999 s 9-70 (10%)",
      note: null,
    },
    reverseCharge: {
      domesticConstruction: null,
      importedServices: {
        requiresCustomerVat: true,
        citation: "GST Act 1999 Div 84 (offshore supplies, reverse charge)",
        summary: "A registered recipient not entitled to full input tax credits self-assesses GST on imported services.",
      },
    },
    withholding: {
      scheme: "wht",
      name: "PAYG withholding (no-ABN and foreign-resident payments)",
      summary:
        "47% no-ABN withholding when a supplier fails to quote an ABN on an invoice over $75; " +
        "5% from payments to foreign residents for works and related activities.",
      registrationDriven: null,
      resident: [
        {
          key: "no_abn",
          scheme: "backup",
          rate: 47,
          base: "gross_excl_vat",
          requires: "no_tin",
          threshold: { amount: 75, note: "Payments of $75 or less (excluding GST) are exempt" },
          when: "The supplier has not quoted an ABN",
          citation: "Taxation Administration Act 1953 Sch 1 s 12-190; rate = top marginal rate + Medicare levy",
        },
      ],
      nonResident: [
        {
          key: "fr_works",
          scheme: "wht",
          rate: 5,
          base: "gross_excl_vat",
          supplyTypes: CONSTRUCTION,
          when: "Payment to a foreign resident for works or related activities (construction, installation, upgrading of buildings, plant and fixtures)",
          citation: "TAA 1953 Sch 1 s 12-317; Taxation Administration Regulations 2017 reg 44",
        },
        {
          key: "fr_no_abn",
          scheme: "backup",
          rate: 47,
          base: "gross_excl_vat",
          requires: "no_tin",
          when: "Foreign resident supplier with no ABN on a non-works supply",
          citation: "TAA 1953 Sch 1 s 12-190",
        },
      ],
      certificateName: "PAYG payment summary — withholding where ABN not quoted / foreign resident withholding",
      remittance:
        "Reported and paid on the activity statement; TPAR for contractor payments due 28 August each year.",
      verificationValidityDays: null,
    },
    levies: [],
    returns: [
      {
        kind: "vat",
        name: "Business activity statement (GST)",
        cadence: "quarterly",
        periodMonths: 3,
        dueDaysAfterPeriodEnd: 28,
        paymentDueDaysAfterPeriodEnd: 28,
        citation: "GST Act 1999 s 31-10 (28th day after the tax period)",
        note: "Quarterly modelled; large withholders lodge monthly (21st).",
      },
      {
        kind: "wht",
        name: "Taxable payments annual report (TPAR)",
        cadence: "annual",
        periodMonths: 12,
        dueDaysAfterPeriodEnd: 59,
        paymentDueDaysAfterPeriodEnd: null,
        citation: "TAA 1953 Sch 1 s 396-55 (28 August following the financial year)",
        note: "Financial year ends 30 June; 28 August is 59 days later.",
      },
    ],
    permanentEstablishment: {
      constructionSiteDays: 183,
      serviceDays: 183,
      basis:
        "Australian treaties commonly treat a building site lasting more than six months as a PE (nine or twelve in some); domestic law has no minimum. Six months modelled.",
      citation: "ITAA 1936 s 6(1) 'permanent establishment'; typical treaty art 5(3)",
    },
    invoiceRequirements: [
      "'Tax invoice', supplier identity and ABN, date, description, GST amount or statement that the total includes GST",
      "Recipient identity/ABN for invoices of $1,000 or more",
    ],
    eInvoicing: "Peppol e-invoicing supported; Commonwealth agencies must accept it. Not yet mandated for business-to-business.",
    notes: [],
  },

  /* ---------------------------------------------------------------- */
  {
    regime: "nz",
    name: "New Zealand — GST and schedular payments",
    jurisdiction: "New Zealand",
    countryCode: "NZ",
    currency: "NZD",
    ratesAsAt: "2025-04-01",
    summary:
      "GST at 15%. Labour-only building contractors are paid under schedular payment rules " +
      "with tax withheld at their elected rate (20% standard, 45% with no tax rate " +
      "notification). Non-resident contractors are subject to non-resident contractors' tax.",
    indirectTax: {
      kind: "gst",
      name: "Goods and Services Tax",
      standardRate: 15,
      otherRates: [
        {
          key: "zero",
          rate: 0,
          treatment: "zero",
          appliesTo: "Zero-rated supplies (exports, certain land transactions between registered persons)",
          citation: "Goods and Services Tax Act 1985 s 11",
        },
      ],
      supplyDefaults: {},
      registrationThreshold: {
        amount: 60000,
        currency: "NZD",
        note: "Turnover in any 12-month period",
      },
      citation: "Goods and Services Tax Act 1985 s 8(1) (15%)",
      note: null,
    },
    reverseCharge: {
      domesticConstruction: null,
      importedServices: {
        requiresCustomerVat: true,
        citation: "GST Act 1985 s 8(4B) (imported services reverse charge)",
        summary: "A registered person that makes less than 95% taxable supplies self-accounts for GST on imported services.",
      },
    },
    withholding: {
      scheme: "wht",
      name: "Schedular payments / non-resident contractors' tax",
      summary:
        "Labour-only contracts in the building industry are schedular payments: tax is withheld " +
        "at the contractor's notified rate (default 20%) or 45% where no IR330C is provided. " +
        "Non-resident contractors: 15% NRCT (45% with no notification).",
      registrationDriven: null,
      resident: [
        {
          key: "labour_only_no_notification",
          scheme: "wht",
          rate: 45,
          base: "gross_excl_vat",
          supplyTypes: ["labour_only"],
          requires: "no_tin",
          when: "Labour-only building contractor with no tax rate notification (IR330C)",
          citation: "Income Tax Act 2007 Sch 4 Part C; s RD 8; no-notification rate 45%",
        },
        {
          key: "labour_only",
          scheme: "wht",
          rate: 20,
          base: "gross_excl_vat",
          supplyTypes: ["labour_only"],
          when: "Labour-only building contractor (schedular payment) at the standard notified rate",
          citation: "Income Tax Act 2007 Sch 4 Part C (labour-only contracts in the building industry: 20%)",
        },
      ],
      nonResident: [
        {
          key: "nrct_no_notification",
          scheme: "wht",
          rate: 45,
          base: "gross_excl_vat",
          requires: "no_tin",
          when: "Non-resident contractor with no tax rate notification",
          citation: "Income Tax Act 2007 Sch 4 Part A; s RD 8",
        },
        {
          key: "nrct",
          scheme: "wht",
          rate: 15,
          base: "gross_excl_vat",
          supplyTypes: SERVICES,
          when: "Non-resident contractor performing contract activities in New Zealand",
          citation: "Income Tax Act 2007 Sch 4 Part A (non-resident contractors: 15%)",
        },
      ],
      certificateName: "Schedular payment / NRCT deduction record (employment information filing)",
      remittance: "Withheld amounts are filed with payday / employment information and paid by the 20th of the following month.",
      verificationValidityDays: null,
    },
    levies: [],
    returns: [
      {
        kind: "vat",
        name: "GST return",
        cadence: "bi_monthly",
        periodMonths: 2,
        dueDaysAfterPeriodEnd: 28,
        paymentDueDaysAfterPeriodEnd: 28,
        citation: "GST Act 1985 s 16 (28th of the month following the taxable period)",
        note: "Two-monthly modelled; six-monthly and monthly filing exist.",
      },
      {
        kind: "wht",
        name: "Schedular payment filing",
        cadence: "monthly",
        periodMonths: 1,
        dueDaysAfterPeriodEnd: 20,
        paymentDueDaysAfterPeriodEnd: 20,
        citation: "Tax Administration Act 1994 s 23E; ITA 2007 s RD 4",
        note: null,
      },
    ],
    permanentEstablishment: OECD_PE,
    invoiceRequirements: [
      "'Tax invoice' (or taxable supply information from 1 April 2023), supplier GST number, date, description, GST-inclusive or exclusive amount with the GST",
    ],
    eInvoicing: "Peppol e-invoicing available; mandatory for large government agencies to receive from 2026.",
    notes: [],
  },

  /* ---------------------------------------------------------------- */
  {
    regime: "my",
    name: "Malaysia — Sales and Service Tax and s 107A withholding",
    jurisdiction: "Malaysia",
    countryCode: "MY",
    currency: "MYR",
    ratesAsAt: "2025-07-01",
    summary:
      "Service tax at 6% applies to construction works services from 1 July 2025 (registration " +
      "threshold RM1.5 million); sales tax at 10% applies to taxable goods at manufacture/import. " +
      "Payments to non-resident contractors for services performed in Malaysia bear 13% " +
      "withholding (10% + 3%) under s 107A.",
    indirectTax: {
      kind: "sst",
      name: "Service Tax (construction works services)",
      standardRate: 6,
      otherRates: [
        {
          key: "sales_tax_goods",
          rate: 10,
          treatment: "standard",
          appliesTo: "Taxable goods (sales tax, levied at manufacturer/importer level, not by a services supplier)",
          citation: "Sales Tax Act 2018; Sales Tax (Rates of Tax) Order 2022",
        },
        {
          key: "service_tax_8",
          rate: 8,
          treatment: "standard",
          appliesTo: "Other taxable services at the general 8% rate (from 1 March 2024)",
          citation: "Service Tax (Rate of Tax) (Amendment) Order 2024",
        },
        {
          key: "not_taxable",
          rate: 0,
          treatment: "exempt",
          appliesTo: "Residential building works and non-taxable services",
          citation: "Service Tax (Amendment) Regulations 2025, Group L exemptions",
        },
      ],
      supplyDefaults: {
        goods: "not_taxable",
        materials_only: "not_taxable",
      },
      registrationThreshold: {
        amount: 1500000,
        currency: "MYR",
        note: "Construction works services taxable turnover in 12 months",
      },
      citation: "Service Tax Act 2018; Service Tax (Amendment) Regulations 2025 (construction works services, Group L, 6% from 1 July 2025)",
      note: "SST is a single-stage tax: there is no input tax credit and no output-vs-input return; the period register tracks the SST-02 remittance.",
    },
    reverseCharge: {
      domesticConstruction: null,
      importedServices: {
        requiresCustomerVat: false,
        citation: "Service Tax Act 2018 s 26A (imported taxable services)",
        summary: "A Malaysian business receiving imported taxable services self-accounts for service tax whether or not registered.",
      },
    },
    withholding: {
      scheme: "wht",
      name: "Section 107A contract payments to non-resident contractors",
      summary:
        "Payments to non-resident contractors for services under a contract performed in Malaysia: " +
        "10% on account of the contractor's tax and 3% on account of its employees' tax. No " +
        "withholding on payments to resident contractors.",
      registrationDriven: null,
      resident: [],
      nonResident: [
        {
          key: "s107a",
          scheme: "wht",
          rate: 13,
          base: "gross_excl_vat",
          supplyTypes: CONSTRUCTION,
          when: "Contract payment to a non-resident contractor for services performed in Malaysia (10% + 3%)",
          citation: "Income Tax Act 1967 s 107A(1)(a)–(b)",
        },
        {
          key: "s109b_technical",
          scheme: "wht",
          rate: 10,
          base: "gross_excl_vat",
          supplyTypes: ["professional_services"],
          when: "Technical / management fees to a non-resident (special classes of income)",
          citation: "Income Tax Act 1967 s 109B read with s 4A",
        },
      ],
      certificateName: "Form CP37A / CP37D withholding tax receipt",
      remittance: "Withheld tax must be remitted to LHDN within one month of paying or crediting the non-resident.",
      verificationValidityDays: null,
    },
    levies: [],
    returns: [
      {
        kind: "vat",
        name: "SST-02 return",
        cadence: "bi_monthly",
        periodMonths: 2,
        dueDaysAfterPeriodEnd: 30,
        paymentDueDaysAfterPeriodEnd: 30,
        citation: "Service Tax Act 2018 s 26 (last day of the month following the taxable period)",
        note: "Modelled as 30 days; the statutory date is the last day of the following month.",
      },
    ],
    permanentEstablishment: {
      constructionSiteDays: 183,
      serviceDays: 183,
      basis: "Malaysian treaties commonly apply a six-month building-site threshold; domestic law (s 12(3)–(4) ITA 1967) deems a site PE without a minimum.",
      citation: "Income Tax Act 1967 s 12(3)–(4); typical treaty art 5(3)",
    },
    invoiceRequirements: [
      "Supplier service tax registration number, invoice number and date, description, service tax rate and amount",
    ],
    eInvoicing:
      "MyInvois e-invoicing mandatory in phases from 1 August 2024 (turnover > RM100m) through 2026 (all businesses above RM500k).",
    notes: [],
  },

  /* ---------------------------------------------------------------- */
  {
    regime: "za",
    name: "South Africa — VAT",
    jurisdiction: "South Africa",
    countryCode: "ZA",
    currency: "ZAR",
    ratesAsAt: "2025-05-01",
    summary:
      "VAT at 15% on construction services. No domestic construction reverse charge and no " +
      "withholding on payments to resident or non-resident contractors for services (the " +
      "proposed service-fee withholding was withdrawn); royalties and interest to non-residents " +
      "are withheld at 15%.",
    indirectTax: {
      kind: "vat",
      name: "Value-Added Tax",
      standardRate: 15,
      otherRates: [
        {
          key: "zero",
          rate: 0,
          treatment: "zero",
          appliesTo: "Zero-rated supplies (exports, certain foodstuffs)",
          citation: "Value-Added Tax Act 89 of 1991 s 11",
        },
        {
          key: "exempt",
          rate: 0,
          treatment: "exempt",
          appliesTo: "Exempt supplies (residential letting, financial services)",
          citation: "VAT Act 89 of 1991 s 12",
        },
      ],
      supplyDefaults: {},
      registrationThreshold: {
        amount: 1000000,
        currency: "ZAR",
        note: "Taxable supplies in any 12-month period",
      },
      citation: "Value-Added Tax Act 89 of 1991 s 7(1) (15%)",
      note: "The 2025 Budget's proposed increase to 15.5% was withdrawn; 15% is the rate in force.",
    },
    reverseCharge: {
      domesticConstruction: null,
      importedServices: {
        requiresCustomerVat: false,
        citation: "VAT Act 89 of 1991 s 7(1)(c) and s 14 (imported services)",
        summary: "VAT on imported services is payable by the recipient to the extent the services are not used for taxable supplies.",
      },
    },
    withholding: {
      scheme: "wht",
      name: "Withholding on payments to non-residents",
      summary:
        "No withholding on contractor or service payments. Withholding applies to royalties (15%) " +
        "and interest (15%) paid to non-residents — outside the scope of a construction payment.",
      registrationDriven: null,
      resident: [],
      nonResident: [],
      certificateName: "n/a — no withholding on service payments",
      remittance: "n/a",
      verificationValidityDays: null,
    },
    levies: [],
    returns: [
      {
        kind: "vat",
        name: "VAT201 return",
        cadence: "bi_monthly",
        periodMonths: 2,
        dueDaysAfterPeriodEnd: 25,
        paymentDueDaysAfterPeriodEnd: 25,
        citation: "VAT Act 89 of 1991 s 28 (25th of the month after the tax period; last business day for eFiling)",
        note: "Category A/B two-monthly modelled; monthly categories exist for large vendors.",
      },
    ],
    permanentEstablishment: OECD_PE,
    invoiceRequirements: [
      "'Tax invoice', supplier name/address/VAT number, recipient name/address/VAT number (over R5,000), serial number, date, description, VAT amount or rate",
    ],
    eInvoicing: null,
    notes: [],
  },

  /* ---------------------------------------------------------------- */
  {
    regime: "ng",
    name: "Nigeria — VAT and withholding tax",
    jurisdiction: "Nigeria",
    countryCode: "NG",
    currency: "NGN",
    ratesAsAt: "2025-01-01",
    summary:
      "VAT at 7.5%. Withholding tax on payments to resident companies: 2% for construction of " +
      "roads, bridges, buildings and power plants, 5% for other contracts and services under " +
      "the 2024 Regulations; non-residents bear 10% on services (final tax unless a treaty " +
      "reduces it).",
    indirectTax: {
      kind: "vat",
      name: "Value Added Tax",
      standardRate: 7.5,
      otherRates: [
        {
          key: "zero",
          rate: 0,
          treatment: "zero",
          appliesTo: "Zero-rated goods and services (exports, basic food items)",
          citation: "VAT Act Cap V1 LFN 2004 First Schedule Part III (as amended by Finance Act 2019/2020)",
        },
        {
          key: "exempt",
          rate: 0,
          treatment: "exempt",
          appliesTo: "Exempt goods and services (First Schedule)",
          citation: "VAT Act First Schedule Parts I–II",
        },
      ],
      supplyDefaults: {},
      registrationThreshold: {
        amount: 25000000,
        currency: "NGN",
        note: "Small companies under ₦25m turnover are outside VAT (Finance Act 2019)",
      },
      citation: "Value Added Tax Act s 4 (7.5% from 1 February 2020, Finance Act 2019)",
      note: null,
    },
    reverseCharge: {
      domesticConstruction: null,
      importedServices: {
        requiresCustomerVat: false,
        citation: "VAT Act s 10(3) (self-account for VAT on supplies by non-residents)",
        summary: "A Nigerian recipient of services from a non-resident self-accounts for the VAT and remits it to FIRS.",
      },
    },
    withholding: {
      scheme: "wht",
      name: "Withholding tax (Deduction of Tax at Source Regulations 2024)",
      summary:
        "Deducted at source from qualifying payments and remitted to FIRS; a credit against " +
        "the payee's income tax (final for non-residents without a Nigerian PE).",
      registrationDriven: null,
      resident: [
        {
          key: "construction",
          scheme: "wht",
          rate: 2,
          base: "gross_excl_vat",
          supplyTypes: CONSTRUCTION,
          when: "Construction of roads, bridges, buildings and power plants by a resident company",
          citation: "Deduction of Tax at Source (Withholding) Regulations 2024, Schedule (construction 2%)",
        },
        {
          key: "services",
          scheme: "wht",
          rate: 5,
          base: "gross_excl_vat",
          supplyTypes: ["professional_services"],
          when: "Professional, consultancy, technical and management services by a resident company",
          citation: "Deduction of Tax at Source (Withholding) Regulations 2024, Schedule (5%)",
        },
        {
          key: "supply_goods",
          scheme: "wht",
          rate: 2,
          base: "gross_excl_vat",
          supplyTypes: ["goods", "materials_only"],
          when: "Supply of goods by a resident company (2% where the supplier is not the manufacturer)",
          citation: "Deduction of Tax at Source (Withholding) Regulations 2024, Schedule",
        },
        {
          key: "other_contracts",
          scheme: "wht",
          rate: 5,
          base: "gross_excl_vat",
          when: "All other contracts and agency arrangements with a resident company",
          citation: "Deduction of Tax at Source (Withholding) Regulations 2024, Schedule",
        },
      ],
      nonResident: [
        {
          key: "nr_services",
          scheme: "wht",
          rate: 10,
          base: "gross_excl_vat",
          when: "Payments to a non-resident for services or contracts (treaty rate may apply)",
          citation: "Companies Income Tax Act s 78–81; 2024 Regulations (non-resident 10%)",
        },
      ],
      certificateName: "WHT credit note issued by FIRS on remittance",
      remittance: "Remit to FIRS by the 21st day of the month following deduction; VAT likewise by the 21st.",
      verificationValidityDays: null,
    },
    levies: [],
    returns: [
      {
        kind: "vat",
        name: "VAT return (Form 002)",
        cadence: "monthly",
        periodMonths: 1,
        dueDaysAfterPeriodEnd: 21,
        paymentDueDaysAfterPeriodEnd: 21,
        citation: "VAT Act s 15 (21st day of the month following)",
        note: null,
      },
      {
        kind: "wht",
        name: "WHT remittance schedule",
        cadence: "monthly",
        periodMonths: 1,
        dueDaysAfterPeriodEnd: 21,
        paymentDueDaysAfterPeriodEnd: 21,
        citation: "Deduction of Tax at Source (Withholding) Regulations 2024 reg 9",
        note: null,
      },
    ],
    permanentEstablishment: {
      constructionSiteDays: 183,
      serviceDays: 183,
      basis: "A non-resident with a fixed base or a building site lasting beyond the treaty period (commonly six months) is taxable on the profits attributable; services over 183 days in a 12-month period likewise.",
      citation: "Companies Income Tax Act s 13(2); Nigerian treaties art 5",
    },
    invoiceRequirements: [
      "Supplier TIN and VAT registration number, invoice number/date, description, VAT rate and amount",
    ],
    eInvoicing: "FIRS Merchant Buyer Solution (e-invoicing) mandatory for large taxpayers from August 2025.",
    notes: [],
  },

  /* ---------------------------------------------------------------- */
  {
    regime: "ke",
    name: "Kenya — VAT and withholding tax",
    jurisdiction: "Kenya",
    countryCode: "KE",
    currency: "KES",
    ratesAsAt: "2025-07-01",
    summary:
      "VAT at 16%. Withholding on contractual fees for building, civil and engineering works " +
      "at 3% (residents), management and professional fees at 5% (residents); 20% on " +
      "contractual and professional fees paid to non-residents.",
    indirectTax: {
      kind: "vat",
      name: "Value Added Tax",
      standardRate: 16,
      otherRates: [
        {
          key: "zero",
          rate: 0,
          treatment: "zero",
          appliesTo: "Zero-rated supplies (Second Schedule)",
          citation: "VAT Act 2013 Second Schedule",
        },
        {
          key: "exempt",
          rate: 0,
          treatment: "exempt",
          appliesTo: "Exempt supplies (First Schedule)",
          citation: "VAT Act 2013 First Schedule",
        },
      ],
      supplyDefaults: {},
      registrationThreshold: {
        amount: 5000000,
        currency: "KES",
        note: "Taxable supplies in 12 months",
      },
      citation: "Value Added Tax Act 2013 s 5(2) (16%)",
      note: null,
    },
    reverseCharge: {
      domesticConstruction: null,
      importedServices: {
        requiresCustomerVat: true,
        citation: "VAT Act 2013 s 10 (imported services — reverse charge for registered persons not making wholly taxable supplies)",
        summary: "A registered person accounts for VAT on imported services to the extent it makes exempt supplies.",
      },
    },
    withholding: {
      scheme: "wht",
      name: "Withholding tax",
      summary:
        "Deducted by the payer from specified payments and remitted to KRA within five working days.",
      registrationDriven: null,
      resident: [
        {
          key: "contractual_fees",
          scheme: "wht",
          rate: 3,
          base: "gross_excl_vat",
          supplyTypes: CONSTRUCTION,
          threshold: { amount: 24000, note: "Contractual fees under KES 24,000 per month are not subject to withholding" },
          when: "Contractual fees for building, civil or engineering works paid to a resident",
          citation: "Income Tax Act Cap 470 s 35(3)(f); Third Schedule para 5(f) (3%)",
        },
        {
          key: "professional_fees",
          scheme: "wht",
          rate: 5,
          base: "gross_excl_vat",
          supplyTypes: ["professional_services"],
          threshold: { amount: 24000, note: "Fees under KES 24,000 per month are not subject to withholding" },
          when: "Management, professional or consultancy fees paid to a resident",
          citation: "Income Tax Act Cap 470 s 35(3)(f); Third Schedule para 5(f) (5%)",
        },
      ],
      nonResident: [
        {
          key: "nr_fees",
          scheme: "wht",
          rate: 20,
          base: "gross_excl_vat",
          supplyTypes: SERVICES,
          when: "Contractual, management or professional fees paid to a non-resident",
          citation: "Income Tax Act Cap 470 s 35(1); Third Schedule para 3 (20%)",
        },
      ],
      certificateName: "iTax withholding certificate",
      remittance: "Withheld tax is remitted within five working days of deduction (Finance Act 2023).",
      verificationValidityDays: null,
    },
    levies: [],
    returns: [
      {
        kind: "vat",
        name: "VAT3 return",
        cadence: "monthly",
        periodMonths: 1,
        dueDaysAfterPeriodEnd: 20,
        paymentDueDaysAfterPeriodEnd: 20,
        citation: "VAT Act 2013 s 44 (20th day of the following month)",
        note: null,
      },
      {
        kind: "wht",
        name: "Withholding tax return",
        cadence: "monthly",
        periodMonths: 1,
        dueDaysAfterPeriodEnd: 5,
        paymentDueDaysAfterPeriodEnd: 5,
        citation: "Income Tax Act s 35(5) (five working days)",
        note: "Modelled as five calendar days from the month end for the register; the statutory clock runs from each deduction.",
      },
    ],
    permanentEstablishment: {
      constructionSiteDays: 183,
      serviceDays: 91,
      basis: "Domestic law: a building site or construction/installation project lasting more than 183 days; services furnished for more than 91 days in any 12-month period (Finance Act 2021 definition).",
      citation: "Income Tax Act Cap 470 s 2 'permanent establishment' (as amended by Finance Act 2021)",
    },
    invoiceRequirements: [
      "eTIMS-generated tax invoice with KRA PIN of supplier and buyer, control unit serial and invoice number, VAT rate and amount",
    ],
    eInvoicing: "eTIMS electronic tax invoices mandatory for all VAT-registered persons; non-eTIMS invoices are not deductible.",
    notes: [],
  },

  /* ---------------------------------------------------------------- */
  {
    regime: "gh",
    name: "Ghana — VAT, NHIL/GETFund levies and withholding tax",
    jurisdiction: "Ghana",
    countryCode: "GH",
    currency: "GHS",
    ratesAsAt: "2025-01-01",
    summary:
      "VAT at 15% plus the National Health Insurance Levy (2.5%) and GETFund Levy (2.5%), " +
      "charged on the same base and not recoverable as input tax. Withholding on residents: " +
      "3% goods, 5% works, 7.5% services; 20% on payments to non-residents for works and services.",
    indirectTax: {
      kind: "vat",
      name: "Value Added Tax",
      standardRate: 15,
      otherRates: [
        {
          key: "flat_rate_3",
          rate: 3,
          treatment: "reduced",
          appliesTo: "VAT flat rate scheme retailers (not construction)",
          citation: "VAT Act 2013 (Act 870) s 3(2) as amended",
        },
        {
          key: "zero",
          rate: 0,
          treatment: "zero",
          appliesTo: "Zero-rated supplies (exports)",
          citation: "VAT Act 2013 (Act 870) Schedule 2",
        },
        {
          key: "exempt",
          rate: 0,
          treatment: "exempt",
          appliesTo: "Exempt supplies (Schedule 1)",
          citation: "VAT Act 2013 (Act 870) Schedule 1",
        },
      ],
      supplyDefaults: {},
      registrationThreshold: {
        amount: 200000,
        currency: "GHS",
        note: "Taxable supplies over 12 months",
      },
      citation: "Value Added Tax Act 2013 (Act 870) s 3 as amended by Act 1087 (15% from 1 January 2023)",
      note: "The 1% COVID-19 Health Recovery Levy (2021–2025) is not applied; a tenant still liable for it models it under the custom regime.",
    },
    reverseCharge: {
      domesticConstruction: null,
      importedServices: {
        requiresCustomerVat: false,
        citation: "VAT Act 2013 (Act 870) s 6 (imported services)",
        summary: "The recipient of an imported service accounts for VAT and the levies.",
      },
    },
    withholding: {
      scheme: "wht",
      name: "Withholding tax on payments to residents and non-residents",
      summary:
        "Deducted at source and remitted to the GRA within 15 days after the month of deduction; " +
        "creditable for residents, final for non-residents.",
      registrationDriven: null,
      resident: [
        {
          key: "works",
          scheme: "wht",
          rate: 5,
          base: "gross_excl_vat",
          supplyTypes: CONSTRUCTION,
          threshold: { amount: 2000, note: "Contracts under GHS 2,000 are not subject to withholding" },
          when: "Supply of works by a resident",
          citation: "Income Tax Act 2015 (Act 896) s 116; First Schedule para 8 (works 5%)",
        },
        {
          key: "services",
          scheme: "wht",
          rate: 7.5,
          base: "gross_excl_vat",
          supplyTypes: ["professional_services"],
          threshold: { amount: 2000, note: "Contracts under GHS 2,000 are not subject to withholding" },
          when: "Supply of services by a resident",
          citation: "Income Tax Act 2015 (Act 896) s 116; First Schedule para 8 (services 7.5%)",
        },
        {
          key: "goods",
          scheme: "wht",
          rate: 3,
          base: "gross_excl_vat",
          supplyTypes: ["goods", "materials_only"],
          threshold: { amount: 2000, note: "Contracts under GHS 2,000 are not subject to withholding" },
          when: "Supply of goods by a resident",
          citation: "Income Tax Act 2015 (Act 896) s 116; First Schedule para 8 (goods 3%)",
        },
      ],
      nonResident: [
        {
          key: "nr_works_services",
          scheme: "wht",
          rate: 20,
          base: "gross_excl_vat",
          supplyTypes: SERVICES,
          when: "Payment to a non-resident for works or services (final tax)",
          citation: "Income Tax Act 2015 (Act 896) s 116(1)(b); First Schedule para 8 (20%)",
        },
      ],
      certificateName: "GRA withholding tax credit certificate",
      remittance: "Remit within 15 days after the end of the month of deduction.",
      verificationValidityDays: null,
    },
    levies: [
      {
        key: "nhil",
        name: "National Health Insurance Levy",
        rate: 2.5,
        recoverable: false,
        citation: "National Health Insurance Act 2012 (Act 852) s 47 as amended by Act 971",
      },
      {
        key: "getfund",
        name: "Ghana Education Trust Fund Levy",
        rate: 2.5,
        recoverable: false,
        citation: "GETFund Act 2000 (Act 581) s 3A as inserted by Act 972",
      },
    ],
    returns: [
      {
        kind: "vat",
        name: "VAT and levies return",
        cadence: "monthly",
        periodMonths: 1,
        dueDaysAfterPeriodEnd: 30,
        paymentDueDaysAfterPeriodEnd: 30,
        citation: "VAT Act 2013 (Act 870) s 31 (last working day of the following month)",
        note: "Modelled as 30 days.",
      },
      {
        kind: "wht",
        name: "Withholding tax return",
        cadence: "monthly",
        periodMonths: 1,
        dueDaysAfterPeriodEnd: 15,
        paymentDueDaysAfterPeriodEnd: 15,
        citation: "Income Tax Act 2015 (Act 896) s 117(2)",
        note: null,
      },
    ],
    permanentEstablishment: {
      constructionSiteDays: 183,
      serviceDays: 183,
      basis: "OECD-model building-site test in Ghana's treaties, modelled at six months; domestic law treats a construction site as a Ghanaian PE without a minimum duration.",
      citation: "Income Tax Act 2015 (Act 896) s 109; treaty art 5(3)",
    },
    invoiceRequirements: [
      "Supplier TIN and VAT number, invoice number and date, VAT (15%) and the NHIL/GETFund levies shown separately",
    ],
    eInvoicing: "GRA E-VAT (certified invoicing system) mandatory for large and medium taxpayers, phased from 2022.",
    notes: [],
  },

  /* ---------------------------------------------------------------- */
  {
    regime: "in",
    name: "India — GST and TDS under section 194C",
    jurisdiction: "India",
    countryCode: "IN",
    currency: "INR",
    ratesAsAt: "2025-04-01",
    summary:
      "Works contracts attract GST at 18%. A payer deducts TDS under s 194C from payments to " +
      "resident contractors — 1% for individuals/HUFs, 2% for others — on single payments " +
      "over ₹30,000 (or ₹1,00,000 aggregate in the year), computed on the value excluding GST. " +
      "Payments to non-residents fall under s 195.",
    indirectTax: {
      kind: "gst",
      name: "Goods and Services Tax",
      standardRate: 18,
      otherRates: [
        {
          key: "gst_12_affordable",
          rate: 12,
          treatment: "reduced",
          appliesTo: "Certain affordable-housing works contracts (as notified)",
          citation: "Notification 11/2017-Central Tax (Rate) as amended",
        },
        {
          key: "gst_5",
          rate: 5,
          treatment: "reduced",
          appliesTo: "Specific notified works (e.g. certain earthwork-heavy government contracts)",
          citation: "Notification 11/2017-Central Tax (Rate) Sl. 3(vii)",
        },
        {
          key: "exempt",
          rate: 0,
          treatment: "exempt",
          appliesTo: "Exempt services (Notification 12/2017)",
          citation: "Notification 12/2017-Central Tax (Rate)",
        },
      ],
      supplyDefaults: {},
      registrationThreshold: {
        amount: 2000000,
        currency: "INR",
        note: "Aggregate turnover for services (₹20 lakh; ₹10 lakh in special-category states)",
      },
      citation: "CGST Act 2017 s 9 read with Notification 11/2017-Central Tax (Rate) Sl. 3 (works contract 18% from 18 July 2022)",
      note: "GST-TDS at 2% is deducted by government / PSU recipients on contracts over ₹2.5 lakh (CGST Act s 51) — not modelled for a private payer.",
    },
    reverseCharge: {
      domesticConstruction: null,
      importedServices: {
        requiresCustomerVat: true,
        citation: "IGST Act 2017 s 5(3); Notification 10/2017-Integrated Tax (Rate) (import of services)",
        summary: "A registered recipient pays IGST on imported services under reverse charge.",
      },
    },
    withholding: {
      scheme: "tds",
      name: "Tax deducted at source — s 194C (contractors) and s 195 (non-residents)",
      summary:
        "Deducted at payment or credit, deposited by the 7th of the following month, reported " +
        "quarterly on Form 26Q; the payee receives Form 16A.",
      registrationDriven: null,
      resident: [
        {
          key: "s194c_individual",
          scheme: "tds",
          rate: 1,
          base: "gross_excl_vat",
          requires: "individual",
          threshold: { amount: 30000, note: "Single payment over ₹30,000; the ₹1,00,000 annual aggregate is not tracked here" },
          when: "Payment to a resident individual or HUF contractor",
          citation: "Income-tax Act 1961 s 194C(1)(i); CBDT Circular 23/2017 (TDS on amount excluding GST)",
        },
        {
          key: "s194c_no_pan",
          scheme: "tds",
          rate: 20,
          base: "gross_excl_vat",
          requires: "no_tin",
          threshold: { amount: 30000, note: "Single payment over ₹30,000" },
          when: "Contractor has not furnished a PAN",
          citation: "Income-tax Act 1961 s 206AA (20% where no PAN)",
        },
        {
          key: "s194c_other",
          scheme: "tds",
          rate: 2,
          base: "gross_excl_vat",
          threshold: { amount: 30000, note: "Single payment over ₹30,000; the ₹1,00,000 annual aggregate is not tracked here" },
          when: "Payment to a resident contractor other than an individual/HUF",
          citation: "Income-tax Act 1961 s 194C(1)(ii); CBDT Circular 23/2017",
        },
      ],
      nonResident: [
        {
          key: "s195_fts",
          scheme: "tds",
          rate: 10,
          base: "gross_excl_vat",
          supplyTypes: ["professional_services"],
          when: "Fees for technical services to a non-resident (plus surcharge and cess, not modelled; treaty relief on TRC and Form 10F)",
          citation: "Income-tax Act 1961 s 195 read with s 115A(1)(b) (10%)",
        },
        {
          key: "s195_other",
          scheme: "tds",
          rate: 20,
          base: "gross_excl_vat",
          when: "Other sums chargeable to tax paid to a non-resident at the rates in force (modelled at 20%; obtain a s 195(2)/197 certificate for a lower rate)",
          citation: "Income-tax Act 1961 s 195(1); Finance Act rates in force",
        },
      ],
      certificateName: "Form 16A TDS certificate",
      remittance: "Deposit by the 7th of the month following deduction (30 April for March); quarterly Form 26Q.",
      verificationValidityDays: null,
    },
    levies: [],
    returns: [
      {
        kind: "vat",
        name: "GSTR-3B",
        cadence: "monthly",
        periodMonths: 1,
        dueDaysAfterPeriodEnd: 20,
        paymentDueDaysAfterPeriodEnd: 20,
        citation: "CGST Rules 2017 r 61(1) (20th of the following month)",
        note: null,
      },
      {
        kind: "tds",
        name: "TDS deposit (challan 281) and Form 26Q",
        cadence: "quarterly",
        periodMonths: 3,
        dueDaysAfterPeriodEnd: 31,
        paymentDueDaysAfterPeriodEnd: 7,
        citation: "Income-tax Rules 1962 r 30 (deposit by the 7th) and r 31A (26Q by the 31st of the month after the quarter; 31 May for Q4)",
        note: "Deposit is monthly by the 7th; the quarterly statement is due on the 31st of the month after the quarter.",
      },
    ],
    permanentEstablishment: {
      constructionSiteDays: 183,
      serviceDays: 90,
      basis: "Indian treaties commonly treat a building site lasting more than 183 days (some 6 or 9 months) as a PE; service PE at 90 days in a 12-month period under many treaties. Domestic law taxes a 'business connection' without a day count.",
      citation: "Income-tax Act 1961 s 9(1)(i); Explanation 2A; typical treaty art 5(2)(k)–(l)",
    },
    invoiceRequirements: [
      "Supplier GSTIN, consecutive invoice number, date, recipient GSTIN, HSN/SAC code, taxable value, rate and amount of CGST/SGST or IGST, place of supply",
    ],
    eInvoicing: "e-Invoicing (IRN) mandatory for businesses with aggregate turnover above ₹5 crore.",
    notes: [],
  },

  /* ---------------------------------------------------------------- */
  {
    regime: "ae",
    name: "United Arab Emirates — VAT",
    jurisdiction: "United Arab Emirates",
    countryCode: "AE",
    currency: "AED",
    ratesAsAt: "2025-01-01",
    summary:
      "VAT at 5% on construction services. No withholding tax. Corporate tax (9%) treats a " +
      "building site lasting more than six months as a permanent establishment.",
    indirectTax: {
      kind: "vat",
      name: "Value Added Tax",
      standardRate: 5,
      otherRates: [
        {
          key: "zero_new_residential",
          rate: 0,
          treatment: "zero",
          appliesTo: "First supply of a new residential building within three years of completion",
          citation: "Federal Decree-Law No. 8 of 2017 art 45(9)",
        },
        {
          key: "zero_export",
          rate: 0,
          treatment: "zero",
          appliesTo: "Exports of goods and services outside the GCC implementing states",
          citation: "Federal Decree-Law No. 8 of 2017 art 45(1)",
        },
        {
          key: "exempt",
          rate: 0,
          treatment: "exempt",
          appliesTo: "Exempt supplies (subsequent residential supplies, bare land)",
          citation: "Federal Decree-Law No. 8 of 2017 art 46",
        },
      ],
      supplyDefaults: {},
      registrationThreshold: {
        amount: 375000,
        currency: "AED",
        note: "Mandatory registration threshold",
      },
      citation: "Federal Decree-Law No. 8 of 2017 art 3 (5%)",
      note: null,
    },
    reverseCharge: {
      domesticConstruction: null,
      importedServices: {
        requiresCustomerVat: true,
        citation: "Federal Decree-Law No. 8 of 2017 art 48 (reverse charge on imported services)",
        summary: "A registered recipient of services from abroad accounts for the VAT itself.",
      },
    },
    withholding: null,
    levies: [],
    returns: [
      {
        kind: "vat",
        name: "VAT return (VAT201)",
        cadence: "quarterly",
        periodMonths: 3,
        dueDaysAfterPeriodEnd: 28,
        paymentDueDaysAfterPeriodEnd: 28,
        citation: "Cabinet Decision No. 52 of 2017 art 62 (28th day following the end of the tax period)",
        note: "Quarterly modelled; monthly periods are assigned to larger businesses.",
      },
    ],
    permanentEstablishment: {
      constructionSiteDays: 183,
      serviceDays: 183,
      basis: "Federal Corporate Tax Law: a building site, construction project or installation lasting more than six months is a PE.",
      citation: "Federal Decree-Law No. 47 of 2022 art 14(2)(g)",
    },
    invoiceRequirements: [
      "'Tax Invoice', supplier name/address/TRN, recipient TRN where registered, sequential number, date, description, unit price, VAT rate and amount in AED",
    ],
    eInvoicing: "UAE e-invoicing (Peppol PINT-AE) mandatory for B2B/B2G from July 2026.",
    notes: [],
  },

  /* ---------------------------------------------------------------- */
  {
    regime: "sa",
    name: "Saudi Arabia — VAT and non-resident withholding",
    jurisdiction: "Kingdom of Saudi Arabia",
    countryCode: "SA",
    currency: "SAR",
    ratesAsAt: "2025-01-01",
    summary:
      "VAT at 15% on construction services. Payments to non-residents bear withholding at 5% " +
      "(technical, consulting and other services) or 20% (management fees); no withholding on " +
      "residents. FATOORA e-invoicing is mandatory.",
    indirectTax: {
      kind: "vat",
      name: "Value Added Tax",
      standardRate: 15,
      otherRates: [
        {
          key: "zero_export",
          rate: 0,
          treatment: "zero",
          appliesTo: "Exports and international transport",
          citation: "VAT Implementing Regulations art 32–34",
        },
        {
          key: "exempt",
          rate: 0,
          treatment: "exempt",
          appliesTo: "Exempt supplies (residential rent, certain financial services)",
          citation: "VAT Implementing Regulations art 29–30",
        },
      ],
      supplyDefaults: {},
      registrationThreshold: {
        amount: 375000,
        currency: "SAR",
        note: "Mandatory registration threshold",
      },
      citation: "VAT Law (Royal Decree M/113) art 2; rate 15% from 1 July 2020",
      note: null,
    },
    reverseCharge: {
      domesticConstruction: null,
      importedServices: {
        requiresCustomerVat: true,
        citation: "VAT Implementing Regulations art 47 (reverse charge on services received from non-residents)",
        summary: "A registered customer self-accounts for VAT on services from a non-resident supplier.",
      },
    },
    withholding: {
      scheme: "wht",
      name: "Withholding tax on payments to non-residents",
      summary:
        "A resident payer withholds from payments to non-residents for services performed " +
        "wholly or partly in the Kingdom and remits monthly to ZATCA.",
      registrationDriven: null,
      resident: [],
      nonResident: [
        {
          key: "nr_management",
          scheme: "wht",
          rate: 20,
          base: "gross_excl_vat",
          contractTypes: ["intercompany"],
          when: "Management fees paid to a non-resident (modelled where the contract is intercompany)",
          citation: "Income Tax Law art 68; Implementing Regulations art 63(a)(1) (20%)",
        },
        {
          key: "nr_services",
          scheme: "wht",
          rate: 5,
          base: "gross_excl_vat",
          supplyTypes: SERVICES,
          when: "Technical, consulting or other services performed in the Kingdom by a non-resident",
          citation: "Income Tax Law art 68; Implementing Regulations art 63(a)(2)–(3) (5%)",
        },
      ],
      certificateName: "ZATCA withholding tax certificate",
      remittance: "File and pay the monthly WHT return within the first 10 days of the following month.",
      verificationValidityDays: null,
    },
    levies: [],
    returns: [
      {
        kind: "vat",
        name: "VAT return",
        cadence: "quarterly",
        periodMonths: 3,
        dueDaysAfterPeriodEnd: 30,
        paymentDueDaysAfterPeriodEnd: 30,
        citation: "VAT Implementing Regulations art 62 (last day of the month following the tax period)",
        note: "Quarterly for turnover under SAR 40m; monthly above.",
      },
      {
        kind: "wht",
        name: "Monthly WHT return",
        cadence: "monthly",
        periodMonths: 1,
        dueDaysAfterPeriodEnd: 10,
        paymentDueDaysAfterPeriodEnd: 10,
        citation: "Income Tax Implementing Regulations art 63(d)",
        note: null,
      },
    ],
    permanentEstablishment: {
      constructionSiteDays: 183,
      serviceDays: 183,
      basis: "Domestic law: a building site, construction or assembly project lasting more than six months is a PE; a non-resident furnishing services for more than 183 days likewise.",
      citation: "Income Tax Law art 4(b)",
    },
    invoiceRequirements: [
      "FATOORA-compliant e-invoice with QR code, seller VAT number, buyer VAT number (standard invoices), UUID, cryptographic stamp for cleared invoices",
    ],
    eInvoicing: "FATOORA e-invoicing mandatory (generation phase from December 2021; integration phase in waves).",
    notes: [],
  },

  /* ---------------------------------------------------------------- */
  {
    regime: "us",
    name: "United States — no VAT; backup and Chapter 3 withholding",
    jurisdiction: "United States (federal)",
    countryCode: "US",
    currency: "USD",
    ratesAsAt: "2026-01-01",
    summary:
      "There is no federal VAT or GST; state and local sales and use taxes apply to materials " +
      "and vary by state and are NOT computed here. Backup withholding at 24% applies where a " +
      "payee fails to furnish a TIN (Form W-9); payments to foreign persons for services " +
      "performed in the US are subject to 30% withholding unless a treaty applies.",
    indirectTax: {
      kind: "none",
      name: "No federal VAT/GST (state and local sales & use tax applies to tangible property)",
      standardRate: 0,
      otherRates: [],
      supplyDefaults: {},
      registrationThreshold: null,
      citation: "No federal statute — sales & use tax is imposed by state law; contractors are generally the consumer of materials they install",
      note: "State/local sales & use tax on materials is out of scope for this determination and must be handled in the estimate and PO tax fields.",
    },
    reverseCharge: { domesticConstruction: null, importedServices: null },
    withholding: {
      scheme: "backup",
      name: "Backup withholding and withholding on foreign persons",
      summary:
        "24% backup withholding where the payee has not provided a TIN; 30% on US-source " +
        "service payments to foreign persons (Form W-8BEN-E; treaty may reduce). Reported on " +
        "Form 1099-NEC (residents) or 1042-S (foreign persons).",
      registrationDriven: null,
      resident: [
        {
          key: "backup_no_tin",
          scheme: "backup",
          rate: 24,
          base: "gross_excl_vat",
          requires: "no_tin",
          threshold: { amount: 2000, note: "1099-NEC reporting threshold ($2,000 for payments made after 31 December 2025)" },
          when: "Payee has not furnished a TIN on Form W-9",
          citation: "IRC §3406(a); rate under §3406(a)(1) (fourth-lowest rate, 24%)",
        },
      ],
      nonResident: [
        {
          key: "ch3_services",
          scheme: "wht",
          rate: 30,
          base: "gross_excl_vat",
          supplyTypes: SERVICES,
          when: "US-source compensation for services performed in the US paid to a foreign person (treaty relief on Form W-8BEN-E)",
          citation: "IRC §1441–1442; Treas. Reg. §1.1441-1",
        },
      ],
      certificateName: "Form 1099-NEC (residents) / Form 1042-S (foreign persons)",
      remittance: "Deposit backup withholding on the Form 945 schedule; Chapter 3 withholding on Form 1042 deposit rules.",
      verificationValidityDays: null,
    },
    levies: [],
    returns: [
      {
        kind: "wht",
        name: "Form 1099-NEC / Form 945 annual return",
        cadence: "annual",
        periodMonths: 12,
        dueDaysAfterPeriodEnd: 31,
        paymentDueDaysAfterPeriodEnd: 31,
        citation: "IRC §6041A; Treas. Reg. §1.6041-2 (31 January following the calendar year)",
        note: null,
      },
    ],
    permanentEstablishment: OECD_PE,
    invoiceRequirements: [
      "No federal invoice-content statute; sales tax invoices follow state law. Contractor should hold a W-9 (residents) or W-8 (foreign persons) before first payment.",
    ],
    eInvoicing: null,
    notes: [
      "Certified payroll (Davis-Bacon) and prevailing-wage compliance (#809–810) live in the timecards module.",
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    regime: "custom",
    name: "Custom — tenant-supplied parameters",
    jurisdiction: "As stated by the tenant",
    countryCode: "",
    currency: "",
    ratesAsAt: "",
    summary:
      "No rule is assumed. The tenant supplies the VAT rate, whether the supply is " +
      "reverse-charged, the withholding rate and base, and the citation; the determination " +
      "records them as tenant-supplied and its confidence reflects that no library rule was applied.",
    indirectTax: {
      kind: "vat",
      name: "Tenant-supplied indirect tax",
      standardRate: 0,
      otherRates: [],
      supplyDefaults: {},
      registrationThreshold: null,
      citation: "Tenant-supplied",
      note: "Every figure must be supplied on the request; nothing is defaulted.",
    },
    reverseCharge: { domesticConstruction: null, importedServices: null },
    withholding: {
      scheme: "custom",
      name: "Tenant-supplied withholding",
      summary: "Rate and base supplied per determination.",
      registrationDriven: null,
      resident: [],
      nonResident: [],
      certificateName: "Withholding certificate (tenant format)",
      remittance: "As stated by the tenant",
      verificationValidityDays: null,
    },
    levies: [],
    returns: [
      {
        kind: "other",
        name: "Tenant-defined return",
        cadence: "monthly",
        periodMonths: 1,
        dueDaysAfterPeriodEnd: 30,
        paymentDueDaysAfterPeriodEnd: 30,
        citation: "Tenant-supplied",
        note: "Due dates on a custom period should be set explicitly.",
      },
    ],
    permanentEstablishment: OECD_PE,
    invoiceRequirements: [],
    eInvoicing: null,
    notes: [],
  },
];

const byRegime = new Map<string, TaxRegimeDef>(TAX_REGIME_LIBRARY.map((d) => [d.regime, d]));

export function findTaxRegime(regime: string): TaxRegimeDef | undefined {
  return byRegime.get(regime);
}

export function libraryCoversAllRegimes(): boolean {
  return TAX_REGIMES.every((r) => byRegime.has(r));
}

/** ISO-3166 alpha-2 → default regime (null when the library has no regime for it). */
export function regimeForCountry(country: string | null | undefined): TaxRegime | null {
  if (!country) return null;
  const c = country.trim().toUpperCase();
  const aliases: Record<string, string> = {
    UK: "GB",
    "UNITED KINGDOM": "GB",
    "GREAT BRITAIN": "GB",
    ENGLAND: "GB",
    SCOTLAND: "GB",
    WALES: "GB",
    IRELAND: "IE",
    SINGAPORE: "SG",
    AUSTRALIA: "AU",
    "NEW ZEALAND": "NZ",
    MALAYSIA: "MY",
    "SOUTH AFRICA": "ZA",
    NIGERIA: "NG",
    KENYA: "KE",
    GHANA: "GH",
    INDIA: "IN",
    UAE: "AE",
    "UNITED ARAB EMIRATES": "AE",
    "SAUDI ARABIA": "SA",
    KSA: "SA",
    USA: "US",
    "UNITED STATES": "US",
    "UNITED STATES OF AMERICA": "US",
  };
  const code = aliases[c] ?? c;
  for (const def of TAX_REGIME_LIBRARY) {
    if (def.countryCode && def.countryCode === code) return def.regime;
  }
  return null;
}

/** A regime's return definition for a return kind, if it files one. */
export function findReturnDef(regime: string, kind: TaxReturnKind): ReturnDef | undefined {
  return findTaxRegime(regime)?.returns.find((r) => r.kind === kind);
}

/** Wire-safe summary rows for the regimes reference tab. */
export function summariseRegime(def: TaxRegimeDef) {
  return {
    regime: def.regime,
    name: def.name,
    jurisdiction: def.jurisdiction,
    countryCode: def.countryCode,
    currency: def.currency,
    ratesAsAt: def.ratesAsAt,
    indirectTaxKind: def.indirectTax.kind,
    standardRate: def.indirectTax.standardRate,
    domesticReverseCharge: def.reverseCharge.domesticConstruction !== null,
    withholdingScheme: def.withholding?.scheme ?? "none",
    withholdingName: def.withholding?.name ?? null,
    levies: def.levies.map((l) => `${l.name} ${l.rate}%`),
    returns: def.returns.map((r) => `${r.name} (${r.cadence})`),
    peConstructionSiteDays: def.permanentEstablishment.constructionSiteDays,
    peServiceDays: def.permanentEstablishment.serviceDays,
    eInvoicing: def.eInvoicing,
    summary: def.summary,
  };
}
