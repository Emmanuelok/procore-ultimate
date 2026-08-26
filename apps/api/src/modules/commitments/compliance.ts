import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  bonds,
  commitments as commitmentsTable,
  insuranceCertificates,
  lienWaivers,
  vendors,
} from "@constructos/db";
import { BOND_TYPES, POLICY_TYPES } from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import {
  BOND_LIVE_STATUSES,
  daysBetweenISO,
  isCertificateInDate,
  isIsoDate,
  type CertificateLike,
} from "../insurance/expiry.js";
import { percentSchema, todayIso, type CommitmentRow } from "./shared.js";

/**
 * COMPLIANCE GATING — the thing that stops money leaving the building.
 *
 * A subcontractor whose general liability certificate lapsed three weeks ago
 * is uninsured today, and a payment issued to them today is the contractor's
 * exposure, not theirs. The whole point of holding a certificate register is
 * that the register is consulted at the moment of payment; a compliance
 * dashboard nobody reads at the moment of payment is decoration.
 *
 * Design rules this file keeps:
 *
 *  1. It READS the insurance module's tables (`insurance_certificates`,
 *     `bonds`) and reuses that module's own expiry predicates. Certificate
 *     validity has exactly one definition on this platform and it lives in
 *     `modules/insurance/expiry.ts`. Duplicating it here would guarantee the
 *     two drift and that the payment gate ends up disagreeing with the
 *     insurance dashboard about the same certificate.
 *
 *  2. Strictness is CONFIGURABLE PER COMMITMENT, stored on
 *     `commitments.complianceDetail`, and defaults to `warn`. A specialist
 *     trade with a $4m limit requirement and a $200 stationery PO cannot
 *     sensibly share one policy, so the policy is a property of the
 *     commitment, not of the deployment.
 *
 *  3. Not knowing is reported as NOT KNOWING. When no cover requirement is
 *     recorded, the answer is `unknown` with a note — never `compliant`,
 *     which is the dangerous default, and never `blocked`, which would make
 *     the platform unusable until someone fills in a form. This mirrors
 *     `computeCoverGaps`'s `requirementsKnown: false` contract exactly.
 */

/* ------------------------------------------------------------------ */
/* Requirements — what this commitment demands of its vendor           */
/* ------------------------------------------------------------------ */

export const COMPLIANCE_STRICTNESSES = ["off", "warn", "block"] as const;
export type ComplianceStrictness = (typeof COMPLIANCE_STRICTNESSES)[number];

/**
 * Stored on `commitments.complianceDetail`. Insurance and bond requirements
 * are expressed as the policy/bond TYPES the subcontract requires — the same
 * vocabulary the insurance module files certificates under, so the join is by
 * meaning rather than by a free-text string somebody typed twice.
 */
export const complianceRequirementsSchema = z.object({
  strictness: z.enum(COMPLIANCE_STRICTNESSES).default("warn"),
  requiredPolicyTypes: z.array(z.enum(POLICY_TYPES)).max(POLICY_TYPES.length).default([]),
  requiredBondTypes: z.array(z.enum(BOND_TYPES)).max(BOND_TYPES.length).default([]),
  /** minimum limit of indemnity the certificate must evidence, in the commitment currency */
  minimumInsuranceLimit: z.number().finite().min(0).nullable().default(null),
  /** minimum bond value as a percentage of the revised commitment sum */
  minimumBondPercent: percentSchema.nullable().default(null),
  /** an in-date certificate nobody independent has checked is not evidence */
  requireVerifiedCertificates: z.boolean().default(false),
  notes: z.string().max(4000).nullable().default(null),
});

export type ComplianceRequirements = z.infer<typeof complianceRequirementsSchema>;

export const DEFAULT_REQUIREMENTS: ComplianceRequirements = {
  strictness: "warn",
  requiredPolicyTypes: [],
  requiredBondTypes: [],
  minimumInsuranceLimit: null,
  minimumBondPercent: null,
  requireVerifiedCertificates: false,
  notes: null,
};

/**
 * Read requirements off a stored `complianceDetail` blob. Anything unparsable
 * degrades to the defaults rather than throwing: a bad blob must not make an
 * existing commitment unreadable, and the resulting `requirementsKnown: false`
 * says so out loud.
 */
export function readRequirements(detail: unknown): ComplianceRequirements {
  const parsed = complianceRequirementsSchema.safeParse(detail ?? {});
  return parsed.success ? parsed.data : { ...DEFAULT_REQUIREMENTS };
}

export function requirementsAreRecorded(r: ComplianceRequirements): boolean {
  return (
    r.requiredPolicyTypes.length > 0 ||
    r.requiredBondTypes.length > 0 ||
    r.minimumInsuranceLimit !== null ||
    r.minimumBondPercent !== null
  );
}

/* ------------------------------------------------------------------ */
/* Findings                                                            */
/* ------------------------------------------------------------------ */

export const COMPLIANCE_CODES = [
  "no_vendor",
  "vendor_inactive",
  "certificate_missing",
  "certificate_expired",
  "certificate_not_yet_effective",
  "certificate_unverified",
  "certificate_limit_below_requirement",
  "bond_missing",
  "bond_expired",
  "bond_below_requirement",
  "lien_waiver_outstanding",
  "payment_hold",
] as const;
export type ComplianceCode = (typeof COMPLIANCE_CODES)[number];

export interface ComplianceFinding {
  code: ComplianceCode;
  severity: "block" | "warn";
  message: string;
  /** the policy or bond type at issue, when the finding is about one */
  subjectType: string | null;
  /** the certificate / bond / lien waiver row the finding points at */
  subjectId: string | null;
  /** the date the evidence ran out, when there was evidence */
  expiredOn: string | null;
  daysExpired: number | null;
}

export type ComplianceStatus = "compliant" | "warning" | "blocked" | "unknown";

export interface ComplianceResult {
  status: ComplianceStatus;
  strictness: ComplianceStrictness;
  vendorId: string | null;
  asOf: string;
  /** false when no cover requirement is recorded — the honest "we cannot say" */
  requirementsKnown: boolean;
  requirements: ComplianceRequirements;
  findings: ComplianceFinding[];
  blocking: ComplianceFinding[];
  warnings: ComplianceFinding[];
  /** what the caller should do about it, in one sentence */
  note: string | null;
  /** the evidence actually consulted, so the answer is auditable */
  evidence: {
    certificatesConsidered: number;
    bondsConsidered: number;
    lienWaiversConsidered: number;
  };
}

/* ------------------------------------------------------------------ */
/* Row shapes read from the insurance module                           */
/* ------------------------------------------------------------------ */

export interface BondEvidence {
  id: string;
  bondType: string;
  status: string;
  amount: number;
  currency: string;
  expiryAt: string | null;
  principalVendorId: string | null;
}

export interface LienWaiverEvidence {
  id: string;
  status: string;
  waiverType: string;
  throughDate: string | null;
}

export interface ComplianceInput {
  commitment: Pick<
    CommitmentRow,
    | "id"
    | "vendorId"
    | "currency"
    | "revisedCommitmentSum"
    | "requiresLienWaiver"
    | "paymentHold"
    | "complianceHoldReason"
  >;
  requirements: ComplianceRequirements;
  certificates: readonly CertificateLike[];
  certificateLimits: ReadonlyMap<string, { limit: number | null; currency: string }>;
  bonds: readonly BondEvidence[];
  lienWaivers: readonly LienWaiverEvidence[];
  vendorStatus: string | null;
  asOf: string;
}

const severityFor = (s: ComplianceStrictness): "block" | "warn" =>
  s === "block" ? "block" : "warn";

/**
 * Evaluate one commitment's compliance position on `asOf`. Pure: every input
 * is passed in, so the whole matrix of expired / not-yet-effective /
 * unverified / under-limit certificates is unit-testable without a database.
 */
export function evaluateCompliance(input: ComplianceInput): ComplianceResult {
  const { commitment, requirements, certificates, bonds: bondRows, asOf } = input;
  const sev = severityFor(requirements.strictness);
  const findings: ComplianceFinding[] = [];
  const push = (
    code: ComplianceCode,
    message: string,
    extra: Partial<ComplianceFinding> = {},
  ): void => {
    findings.push({
      code,
      severity: extra.severity ?? sev,
      message,
      subjectType: extra.subjectType ?? null,
      subjectId: extra.subjectId ?? null,
      expiredOn: extra.expiredOn ?? null,
      daysExpired: extra.daysExpired ?? null,
    });
  };

  const evidence = {
    certificatesConsidered: certificates.length,
    bondsConsidered: bondRows.length,
    lienWaiversConsidered: input.lienWaivers.length,
  };

  /*
   * An explicit hold is not a compliance opinion, it is an instruction. It
   * blocks at every strictness including "off", because somebody typed a
   * reason into the record on purpose and no configuration setting should be
   * able to overrule that quietly.
   */
  if (commitment.paymentHold === 1) {
    push("payment_hold", commitment.complianceHoldReason ?? "Payment is on hold on this commitment.", {
      severity: "block",
    });
  }

  if (!commitment.vendorId) {
    push(
      "no_vendor",
      "No vendor is bound to this commitment, so no insurance, bond or lien-waiver " +
        "position can be established for it.",
      { severity: "warn" },
    );
    return finish(commitment, requirements, findings, evidence, asOf, false);
  }
  if (input.vendorStatus && input.vendorStatus !== "active") {
    push("vendor_inactive", `The bound vendor is ${input.vendorStatus}, not active.`, {
      severity: "warn",
    });
  }

  const known = requirementsAreRecorded(requirements);

  /* ---------------- insurance certificates ---------------- */
  for (const policyType of requirements.requiredPolicyTypes) {
    const forType = certificates.filter(
      (c) => c.vendorId === commitment.vendorId && c.policyType === policyType,
    );
    const inDate = forType.filter((c) => isCertificateInDate(c, asOf));
    if (inDate.length === 0) {
      const latest = latestByValidTo(forType);
      if (!latest) {
        push("certificate_missing", `No ${label(policyType)} certificate is on file for this vendor.`, {
          subjectType: policyType,
        });
        continue;
      }
      const notYet = isIsoDate(latest.validFrom) && daysBetweenISO(asOf, latest.validFrom) > 0;
      if (notYet) {
        push(
          "certificate_not_yet_effective",
          `The ${label(policyType)} certificate on file does not take effect until ${latest.validFrom}.`,
          { subjectType: policyType, subjectId: latest.id },
        );
      } else {
        const days = isIsoDate(latest.validTo) ? -daysBetweenISO(asOf, latest.validTo) : null;
        push(
          "certificate_expired",
          `The ${label(policyType)} certificate expired on ${latest.validTo}` +
            (days !== null ? ` (${days} day${days === 1 ? "" : "s"} ago)` : "") +
            " — the vendor is uninsured for this cover today.",
          {
            subjectType: policyType,
            subjectId: latest.id,
            expiredOn: latest.validTo,
            daysExpired: days,
          },
        );
      }
      continue;
    }
    if (requirements.requireVerifiedCertificates && !inDate.some((c) => c.verifiedAt !== null)) {
      const latest = latestByValidTo(inDate);
      push(
        "certificate_unverified",
        `The ${label(policyType)} certificate is in date but has never been independently ` +
          "verified against the insurer.",
        { subjectType: policyType, subjectId: latest?.id ?? null },
      );
    }
    if (requirements.minimumInsuranceLimit !== null) {
      /*
       * Limits are only comparable inside one currency. A certificate written
       * in EUR against a USD requirement is reported as UNVERIFIABLE, never
       * converted at an invented rate and never silently passed.
       */
      const comparable = inDate.filter((c) => {
        const meta = input.certificateLimits.get(c.id);
        return meta != null && meta.currency.toUpperCase() === commitment.currency.toUpperCase();
      });
      const best = comparable.reduce<number | null>((max, c) => {
        const limit = input.certificateLimits.get(c.id)?.limit ?? null;
        if (limit === null) return max;
        return max === null || limit > max ? limit : max;
      }, null);
      if (best === null) {
        push(
          "certificate_limit_below_requirement",
          `The ${label(policyType)} certificate records no limit of indemnity in ` +
            `${commitment.currency}, so it cannot be tested against the ` +
            `${requirements.minimumInsuranceLimit} minimum this commitment requires.`,
          { subjectType: policyType, severity: "warn" },
        );
      } else if (best < requirements.minimumInsuranceLimit) {
        push(
          "certificate_limit_below_requirement",
          `The ${label(policyType)} limit of ${best} ${commitment.currency} is below the ` +
            `${requirements.minimumInsuranceLimit} ${commitment.currency} this commitment requires.`,
          { subjectType: policyType, subjectId: latestByValidTo(comparable)?.id ?? null },
        );
      }
    }
  }

  /* ---------------- bonds ---------------- */
  for (const bondType of requirements.requiredBondTypes) {
    const forType = bondRows.filter(
      (b) => b.principalVendorId === commitment.vendorId && b.bondType === bondType,
    );
    const live = forType.filter(
      (b) =>
        (BOND_LIVE_STATUSES as readonly string[]).includes(b.status) &&
        (!isIsoDate(b.expiryAt) || daysBetweenISO(asOf, b.expiryAt as string) >= 0),
    );
    if (live.length === 0) {
      const lapsed = forType.find((b) => isIsoDate(b.expiryAt));
      if (!lapsed) {
        push("bond_missing", `No ${label(bondType)} bond is on file for this vendor.`, {
          subjectType: bondType,
        });
      } else {
        push(
          "bond_expired",
          `The ${label(bondType)} bond expired on ${lapsed.expiryAt} and no live bond replaces it.`,
          { subjectType: bondType, subjectId: lapsed.id, expiredOn: lapsed.expiryAt },
        );
      }
      continue;
    }
    if (requirements.minimumBondPercent !== null) {
      const required = (requirements.minimumBondPercent / 100) * commitment.revisedCommitmentSum;
      const sameCurrency = live.filter(
        (b) => b.currency.toUpperCase() === commitment.currency.toUpperCase(),
      );
      const best = sameCurrency.reduce((max, b) => Math.max(max, b.amount), 0);
      if (sameCurrency.length === 0) {
        push(
          "bond_below_requirement",
          `The ${label(bondType)} bond is not written in ${commitment.currency}, so it cannot ` +
            "be tested against the required percentage of the commitment sum.",
          { subjectType: bondType, severity: "warn" },
        );
      } else if (best + 0.005 < required) {
        push(
          "bond_below_requirement",
          `The ${label(bondType)} bond of ${best} ${commitment.currency} is below the ` +
            `${requirements.minimumBondPercent}% of the revised commitment sum ` +
            `(${Math.round(required * 100) / 100} ${commitment.currency}) this commitment requires.`,
          { subjectType: bondType, subjectId: sameCurrency[0]?.id ?? null },
        );
      }
    }
  }

  /* ---------------- lien waivers ---------------- */
  if (commitment.requiresLienWaiver === 1) {
    const satisfied = input.lienWaivers.some(
      (w) => w.status === "received" || w.status === "verified" || w.status === "not_required",
    );
    if (!satisfied) {
      push(
        "lien_waiver_outstanding",
        "This commitment requires a lien waiver and none has been received or verified.",
        { severity: sev },
      );
    }
  }

  return finish(commitment, requirements, findings, evidence, asOf, known);
}

function finish(
  commitment: ComplianceInput["commitment"],
  requirements: ComplianceRequirements,
  findings: ComplianceFinding[],
  evidence: ComplianceResult["evidence"],
  asOf: string,
  requirementsKnown: boolean,
): ComplianceResult {
  const blocking = findings.filter((f) => f.severity === "block");
  const warnings = findings.filter((f) => f.severity === "warn");
  let status: ComplianceStatus;
  let note: string | null = null;
  if (blocking.length > 0) {
    status = "blocked";
    note =
      `${blocking.length} blocking compliance ${blocking.length === 1 ? "finding" : "findings"} ` +
      "must be cleared before payment can be issued against this commitment.";
  } else if (warnings.length > 0) {
    status = "warning";
    note =
      `${warnings.length} compliance ${warnings.length === 1 ? "warning" : "warnings"} — payment ` +
      "is permitted but the exposure is recorded against the payment.";
  } else if (!requirementsKnown) {
    status = "unknown";
    note =
      "No insurance or bond requirement is recorded on this commitment, so its compliance " +
      "position cannot be asserted. Record the policy and bond types the subcontract requires " +
      "before relying on this gate. Payments are permitted meanwhile and carry this note.";
  } else {
    status = "compliant";
  }
  return {
    status,
    strictness: requirements.strictness,
    vendorId: commitment.vendorId,
    asOf,
    requirementsKnown,
    requirements,
    findings,
    blocking,
    warnings,
    note,
    evidence,
  };
}

function latestByValidTo<T extends { validTo: string }>(rows: readonly T[]): T | null {
  let best: T | null = null;
  for (const r of rows) {
    if (!best || r.validTo > best.validTo) best = r;
  }
  return best;
}

function label(code: string): string {
  return code.replace(/_/g, " ");
}

/* ------------------------------------------------------------------ */
/* Database reader                                                     */
/* ------------------------------------------------------------------ */

/**
 * Gather the evidence for one commitment and evaluate it. The insurance
 * tables are read directly and read-only — this module never writes a
 * certificate, a bond or a lien waiver, it only consults them.
 */
export async function assessCommitment(
  db: Db,
  commitment: CommitmentRow,
  asOf: string = todayIso(),
): Promise<ComplianceResult> {
  const requirements = readRequirements(commitment.complianceDetail);
  if (!commitment.vendorId) {
    return evaluateCompliance({
      commitment,
      requirements,
      certificates: [],
      certificateLimits: new Map(),
      bonds: [],
      lienWaivers: [],
      vendorStatus: null,
      asOf,
    });
  }

  const [certRows, bondRows, waiverRows, vendorRows] = await Promise.all([
    db
      .select()
      .from(insuranceCertificates)
      .where(
        and(
          eq(insuranceCertificates.companyId, commitment.companyId),
          eq(insuranceCertificates.vendorId, commitment.vendorId),
        ),
      ),
    db
      .select()
      .from(bonds)
      .where(
        and(
          eq(bonds.companyId, commitment.companyId),
          eq(bonds.principalVendorId, commitment.vendorId),
        ),
      ),
    db
      .select()
      .from(lienWaivers)
      .where(
        and(
          eq(lienWaivers.companyId, commitment.companyId),
          eq(lienWaivers.commitmentId, commitment.id),
          inArray(lienWaivers.status, ["received", "verified", "not_required"]),
        ),
      ),
    db
      .select({ status: vendors.status })
      .from(vendors)
      .where(and(eq(vendors.id, commitment.vendorId), eq(vendors.companyId, commitment.companyId)))
      .limit(1),
  ]);

  /*
   * A certificate scoped to a DIFFERENT project is not evidence for this one;
   * a company-wide certificate (projectId null) is. This is the same rule the
   * insurance module applies when it decides which certificates a project's
   * cover-gap analysis may rely on.
   */
  const relevant = certRows.filter(
    (c) => c.projectId === null || c.projectId === commitment.projectId,
  );
  const certificates: CertificateLike[] = relevant.map((c) => ({
    id: c.id,
    projectId: c.projectId,
    policyId: c.policyId,
    vendorId: c.vendorId,
    subjectName: c.subjectName,
    policyType: c.policyType,
    validFrom: c.validFrom,
    validTo: c.validTo,
    status: c.status,
    verifiedAt: c.verifiedAt,
  }));
  const certificateLimits = new Map(
    relevant.map((c) => [c.id, { limit: c.limitOfIndemnity, currency: c.currency }] as const),
  );

  return evaluateCompliance({
    commitment,
    requirements,
    certificates,
    certificateLimits,
    bonds: bondRows.map((b) => ({
      id: b.id,
      bondType: b.bondType,
      status: b.status,
      amount: b.amount,
      currency: b.currency,
      expiryAt: b.expiryAt,
      principalVendorId: b.principalVendorId,
    })),
    lienWaivers: waiverRows.map((w) => ({
      id: w.id,
      status: w.status,
      waiverType: w.waiverType,
      throughDate: w.throughDate,
    })),
    vendorStatus: vendorRows[0]?.status ?? null,
    asOf,
  });
}

/* ------------------------------------------------------------------ */
/* Project-wide sweep                                                  */
/* ------------------------------------------------------------------ */

export interface CommitmentComplianceEntry {
  commitmentId: string;
  reference: string;
  kind: string;
  title: string;
  status: string;
  vendorId: string | null;
  vendorName: string | null;
  revisedCommitmentSum: number;
  currency: string;
  compliance: ComplianceResult;
}

export interface ProjectComplianceReport {
  projectId: string;
  asOf: string;
  entries: CommitmentComplianceEntry[];
  summary: {
    total: number;
    blocked: number;
    warning: number;
    compliant: number;
    unknown: number;
    /** commitments whose payments are stopped right now */
    paymentBlocked: number;
  };
  notes: string[];
}

/**
 * Assess every live commitment on a project in a fixed number of queries.
 *
 * Per-commitment assessment is four round trips; a project with two hundred
 * subcontracts would be eight hundred. This reads the certificate, bond,
 * waiver and vendor sets ONCE and evaluates in memory, so the compliance
 * register stays a page a project manager will actually open every morning.
 */
export async function assessProjectCommitments(
  db: Db,
  companyId: string,
  projectId: string,
  asOf: string = todayIso(),
): Promise<ProjectComplianceReport> {
  const commitmentRows = await db
    .select()
    .from(commitmentsTable)
    .where(
      and(eq(commitmentsTable.companyId, companyId), eq(commitmentsTable.projectId, projectId)),
    );
  const live = commitmentRows.filter((c) => c.status !== "void");
  const vendorIds = [...new Set(live.map((c) => c.vendorId).filter((v): v is string => v !== null))];

  const [certRows, bondRows, waiverRows, vendorRows] = await Promise.all([
    vendorIds.length > 0
      ? db
          .select()
          .from(insuranceCertificates)
          .where(
            and(
              eq(insuranceCertificates.companyId, companyId),
              inArray(insuranceCertificates.vendorId, vendorIds),
            ),
          )
      : Promise.resolve([] as (typeof insuranceCertificates.$inferSelect)[]),
    vendorIds.length > 0
      ? db
          .select()
          .from(bonds)
          .where(and(eq(bonds.companyId, companyId), inArray(bonds.principalVendorId, vendorIds)))
      : Promise.resolve([] as (typeof bonds.$inferSelect)[]),
    db
      .select()
      .from(lienWaivers)
      .where(and(eq(lienWaivers.companyId, companyId), eq(lienWaivers.projectId, projectId))),
    vendorIds.length > 0
      ? db
          .select({ id: vendors.id, name: vendors.name, status: vendors.status })
          .from(vendors)
          .where(and(eq(vendors.companyId, companyId), inArray(vendors.id, vendorIds)))
      : Promise.resolve([] as { id: string; name: string; status: string }[]),
  ]);

  const certsByVendor = new Map<string, typeof certRows>();
  for (const c of certRows) {
    if (!c.vendorId) continue;
    if (c.projectId !== null && c.projectId !== projectId) continue;
    const list = certsByVendor.get(c.vendorId) ?? [];
    list.push(c);
    certsByVendor.set(c.vendorId, list);
  }
  const bondsByVendor = new Map<string, BondEvidence[]>();
  for (const b of bondRows) {
    if (!b.principalVendorId) continue;
    const list = bondsByVendor.get(b.principalVendorId) ?? [];
    list.push({
      id: b.id,
      bondType: b.bondType,
      status: b.status,
      amount: b.amount,
      currency: b.currency,
      expiryAt: b.expiryAt,
      principalVendorId: b.principalVendorId,
    });
    bondsByVendor.set(b.principalVendorId, list);
  }
  const waiversByCommitment = new Map<string, LienWaiverEvidence[]>();
  for (const w of waiverRows) {
    if (!w.commitmentId) continue;
    if (w.status !== "received" && w.status !== "verified" && w.status !== "not_required") continue;
    const list = waiversByCommitment.get(w.commitmentId) ?? [];
    list.push({ id: w.id, status: w.status, waiverType: w.waiverType, throughDate: w.throughDate });
    waiversByCommitment.set(w.commitmentId, list);
  }
  const vendorById = new Map(vendorRows.map((v) => [v.id, v]));

  const entries: CommitmentComplianceEntry[] = live.map((commitment) => {
    const certs = commitment.vendorId ? (certsByVendor.get(commitment.vendorId) ?? []) : [];
    const compliance = evaluateCompliance({
      commitment,
      requirements: readRequirements(commitment.complianceDetail),
      certificates: certs.map((c) => ({
        id: c.id,
        projectId: c.projectId,
        policyId: c.policyId,
        vendorId: c.vendorId,
        subjectName: c.subjectName,
        policyType: c.policyType,
        validFrom: c.validFrom,
        validTo: c.validTo,
        status: c.status,
        verifiedAt: c.verifiedAt,
      })),
      certificateLimits: new Map(
        certs.map((c) => [c.id, { limit: c.limitOfIndemnity, currency: c.currency }] as const),
      ),
      bonds: commitment.vendorId ? (bondsByVendor.get(commitment.vendorId) ?? []) : [],
      lienWaivers: waiversByCommitment.get(commitment.id) ?? [],
      vendorStatus: commitment.vendorId
        ? (vendorById.get(commitment.vendorId)?.status ?? null)
        : null,
      asOf,
    });
    return {
      commitmentId: commitment.id,
      reference: commitment.reference,
      kind: commitment.kind,
      title: commitment.title,
      status: commitment.status,
      vendorId: commitment.vendorId,
      vendorName: commitment.vendorId
        ? (vendorById.get(commitment.vendorId)?.name ?? null)
        : null,
      revisedCommitmentSum: commitment.revisedCommitmentSum,
      currency: commitment.currency,
      compliance,
    };
  });

  entries.sort((a, b) => {
    const rank = (s: ComplianceStatus): number =>
      s === "blocked" ? 0 : s === "warning" ? 1 : s === "unknown" ? 2 : 3;
    return (
      rank(a.compliance.status) - rank(b.compliance.status) ||
      a.reference.localeCompare(b.reference)
    );
  });

  const count = (s: ComplianceStatus): number =>
    entries.filter((e) => e.compliance.status === s).length;
  const notes: string[] = [];
  const unknownCount = count("unknown");
  if (unknownCount > 0) {
    notes.push(
      `${unknownCount} commitment(s) record no insurance or bond requirement, so no compliance ` +
        "position can be asserted for them. They are reported as unknown, not as compliant.",
    );
  }
  return {
    projectId,
    asOf,
    entries,
    summary: {
      total: entries.length,
      blocked: count("blocked"),
      warning: count("warning"),
      compliant: count("compliant"),
      unknown: unknownCount,
      paymentBlocked: entries.filter((e) => e.compliance.blocking.length > 0).length,
    },
    notes,
  };
}
