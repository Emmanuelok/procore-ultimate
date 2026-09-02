/**
 * Insurance, bond and guarantee clause compliance (spec Vol II Domain C
 * #251-253).
 *
 * A standard form does not just say "insure"; it says what cover, for how
 * much, in whose names, and until when. This file carries that requirement set
 * per form as code-resident templates, and evaluates each requirement against
 * the evidence the platform actually holds (an insurance policy row, a bond
 * row) — producing compliant / expiring / non-compliant / unknown with the
 * reason spelled out. `unknown` is a first-class answer: no evidence is not
 * the same as bad evidence, and pretending otherwise is how compliance
 * theatre starts.
 */
import type {
  ContractComplianceKind,
  ContractComplianceStatus,
  ContractForm,
} from "@constructos/shared";

export interface ComplianceTemplate {
  kind: ContractComplianceKind;
  clauseRef: string;
  requirement: string;
  /** percent of the contract sum, where the form states one */
  percentOfContractSum?: number;
  /** cover must run at least to this milestone */
  until?: "completion" | "defects_end" | "contract_end";
}

const FIDIC_2017: ComplianceTemplate[] = [
  {
    kind: "bond",
    clauseRef: "4.2",
    requirement:
      "Performance Security in the amount and currencies stated in the Contract Data, delivered within 28 days of the Letter of Acceptance and valid until the Works are completed and any defects remedied.",
    percentOfContractSum: 10,
    until: "defects_end",
  },
  {
    kind: "insurance",
    clauseRef: "19.2(a)",
    requirement:
      "Insurance of the Works and Contractor's Documents for not less than the full reinstatement cost including profit, in the joint names of the Parties, until the Taking-Over Certificate is issued.",
    percentOfContractSum: 110,
    until: "completion",
  },
  {
    kind: "insurance",
    clauseRef: "19.2(d)",
    requirement:
      "Insurance against injury to persons and damage to property (third-party liability) for not less than the amount stated in the Contract Data, in the joint names of the Parties.",
    until: "defects_end",
  },
  {
    kind: "insurance",
    clauseRef: "19.2(e)",
    requirement:
      "Insurance against injury to and death of the Contractor's Personnel, as required by applicable law.",
    until: "completion",
  },
];

const NEC: ComplianceTemplate[] = [
  {
    kind: "insurance",
    clauseRef: "84.1",
    requirement:
      "Insurances stated in the Insurance Table: loss of or damage to the works, plant and materials; loss of or damage to equipment; liability for death or injury to third parties and damage to their property; liability for death or injury to employees.",
    until: "defects_end",
  },
  {
    kind: "bond",
    clauseRef: "X13",
    requirement:
      "Performance bond from a bank or insurer accepted by the Project Manager, for the amount stated in the Contract Data, provided before the starting date.",
    percentOfContractSum: 10,
    until: "completion",
  },
  {
    kind: "guarantee",
    clauseRef: "X4",
    requirement:
      "Ultimate holding company guarantee in the form set out in the Scope, provided before the starting date.",
    until: "contract_end",
  },
];

const JCT: ComplianceTemplate[] = [
  {
    kind: "insurance",
    clauseRef: "6.4.1",
    requirement:
      "Contractor's public liability insurance for not less than the sum stated in the Contract Particulars, maintained until the end of the Rectification Period.",
    until: "defects_end",
  },
  {
    kind: "insurance",
    clauseRef: "6.7 / Schedule 3",
    requirement:
      "All Risks insurance of the Works (Option A, B or C as stated) in joint names, for the full reinstatement value plus percentage for professional fees, until practical completion.",
    percentOfContractSum: 100,
    until: "completion",
  },
  {
    kind: "bond",
    clauseRef: "Part 2 of the Contract Particulars",
    requirement:
      "Performance bond and/or parent company guarantee where required by the Contract Particulars, in the agreed form.",
    percentOfContractSum: 10,
    until: "completion",
  },
];

const BY_FORM: Record<ContractForm, ComplianceTemplate[]> = {
  fidic_red_2017: FIDIC_2017,
  fidic_yellow_2017: FIDIC_2017,
  fidic_silver_2017: FIDIC_2017,
  fidic_red_1999: FIDIC_2017.map((t) =>
    t.clauseRef.startsWith("19")
      ? { ...t, clauseRef: t.clauseRef.replace("19", "18") }
      : t,
  ),
  nec4_ecc: NEC,
  nec3_ecc: NEC.filter((t) => t.clauseRef !== "X4"),
  jct_sbc_2016: JCT,
  jct_db_2016: JCT,
  bespoke: [],
};

/** The requirement set a form imposes, ready to be seeded onto a contract. */
export function complianceTemplatesForForm(form: ContractForm): ComplianceTemplate[] {
  return BY_FORM[form] ?? [];
}

export interface ComplianceEvidence {
  /** insurance_policy | bond */
  evidenceType: string;
  evidenceId: string;
  amount: number | null;
  currency: string;
  expiry: string | null;
  status: string;
  label: string;
}

export interface ComplianceCheckInput {
  requirement: string;
  kind: ContractComplianceKind;
  requiredAmount: number | null;
  currency: string;
  requiredUntil: string | null;
  evidence: ComplianceEvidence | null;
  today: string;
  /** raise "expiring" this many days before the cover runs out */
  expiryWarningDays?: number;
}

export interface ComplianceCheckResult {
  status: ContractComplianceStatus;
  reason: string;
}

const DEAD_EVIDENCE_STATUSES = new Set([
  "expired",
  "cancelled",
  "lapsed",
  "released",
  "void",
  "draft",
]);

/**
 * Evaluate one requirement. The order of the tests is the order a reviewer
 * would apply them: is there evidence at all, is it live, is it big enough,
 * does it run long enough.
 */
export function evaluateCompliance(input: ComplianceCheckInput): ComplianceCheckResult {
  const warnDays = input.expiryWarningDays ?? 30;
  const ev = input.evidence;
  if (!ev) {
    return {
      status: "unknown",
      reason:
        "No policy or bond is linked to this requirement, so compliance cannot be established. Link the evidence to answer it.",
    };
  }
  if (DEAD_EVIDENCE_STATUSES.has(ev.status)) {
    return {
      status: "non_compliant",
      reason: `${ev.label} is ${ev.status}, so it does not satisfy the requirement.`,
    };
  }
  if (ev.currency !== input.currency && input.requiredAmount != null) {
    return {
      status: "unknown",
      reason: `${ev.label} is denominated in ${ev.currency} but the requirement is in ${input.currency}; the amounts are not comparable without an agreed rate.`,
    };
  }
  if (input.requiredAmount != null) {
    if (ev.amount == null) {
      return {
        status: "unknown",
        reason: `${ev.label} carries no amount, so it cannot be tested against the required ${input.requiredAmount} ${input.currency}.`,
      };
    }
    if (ev.amount + 0.005 < input.requiredAmount) {
      return {
        status: "non_compliant",
        reason: `${ev.label} provides ${ev.amount} ${ev.currency} against a requirement of ${input.requiredAmount} ${input.currency} — short by ${Math.round((input.requiredAmount - ev.amount) * 100) / 100}.`,
      };
    }
  }
  if (input.requiredUntil) {
    if (!ev.expiry) {
      return {
        status: "unknown",
        reason: `${ev.label} has no recorded expiry, so cover to ${input.requiredUntil} cannot be confirmed.`,
      };
    }
    if (ev.expiry < input.requiredUntil) {
      return {
        status: "non_compliant",
        reason: `${ev.label} expires on ${ev.expiry}, before the required ${input.requiredUntil}.`,
      };
    }
  }
  if (ev.expiry) {
    if (ev.expiry < input.today) {
      return {
        status: "non_compliant",
        reason: `${ev.label} expired on ${ev.expiry}.`,
      };
    }
    const daysLeft = Math.round(
      (Date.parse(`${ev.expiry}T00:00:00Z`) - Date.parse(`${input.today}T00:00:00Z`)) / 86_400_000,
    );
    if (daysLeft <= warnDays) {
      return {
        status: "expiring",
        reason: `${ev.label} expires on ${ev.expiry}, in ${daysLeft} day${daysLeft === 1 ? "" : "s"}. Renewal evidence is needed before then.`,
      };
    }
  }
  return {
    status: "compliant",
    reason:
      `${ev.label} satisfies the requirement` +
      (input.requiredAmount != null ? ` (${ev.amount} ${ev.currency} ≥ ${input.requiredAmount})` : "") +
      (ev.expiry ? ` and runs to ${ev.expiry}` : "") +
      ".",
  };
}
