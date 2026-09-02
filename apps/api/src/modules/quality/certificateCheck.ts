/**
 * Material test certificate verification (#1089).
 *
 * A certificate in a folder is not evidence; a certificate whose numbers have
 * been compared with the specification is. This engine does that comparison
 * and stores the result as rows so it can be re-read years later without the
 * PDF: property by property, what the spec demanded, what the mill measured,
 * and whether it passes.
 *
 * The second thing it decides is whether the certificate is TRACEABLE at all.
 * An EN 10204 type 2.2 document is a test report on the product type — it is
 * not specific to the delivered cast, so no heat number on it can bind the
 * steel on site to the numbers on the page. That is not a failure of the
 * certificate, it is a failure to have specified a 3.1 or a 3.2, and the
 * register says so rather than passing it silently.
 *
 * Pure and deterministic.
 */

import type { CertificateType, CertificateVerificationStatus } from "@constructos/shared";

const EPSILON = 1e-9;
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/** Certificate types that are specific to the delivered lot. */
export const LOT_SPECIFIC_CERTIFICATE_TYPES: readonly CertificateType[] = [
  "en_10204_3_1",
  "en_10204_3_2",
  "mill_certificate",
];

/** Certificate types countersigned by somebody independent of the maker. */
export const INDEPENDENT_CERTIFICATE_TYPES: readonly CertificateType[] = ["en_10204_3_2"];

export interface RequiredProperty {
  property: string;
  min?: number | null;
  max?: number | null;
  target?: number | null;
  unit?: string | null;
  /** free-text requirements a number cannot express (e.g. "fine grain") */
  text?: string | null;
}

export interface MeasuredProperty {
  property: string;
  value?: number | null;
  text?: string | null;
  unit?: string | null;
}

export interface PropertyVerdict {
  property: string;
  required: string;
  measured: string;
  /** null when the comparison could not be made at all */
  passed: boolean | null;
  reason: string;
}

export interface CertificateVerification {
  status: CertificateVerificationStatus;
  verdicts: PropertyVerdict[];
  reasons: string[];
  /** the certificate can bind the delivered lot to the tested material */
  lotTraceable: boolean;
  independentlyWitnessed: boolean;
}

function describeRequirement(r: RequiredProperty): string {
  const unit = r.unit ? ` ${r.unit}` : "";
  if (r.text) return r.text;
  if (r.min !== null && r.min !== undefined && r.max !== null && r.max !== undefined) {
    return `${r.min}–${r.max}${unit}`;
  }
  if (r.min !== null && r.min !== undefined) return `≥ ${r.min}${unit}`;
  if (r.max !== null && r.max !== undefined) return `≤ ${r.max}${unit}`;
  if (r.target !== null && r.target !== undefined) return `${r.target}${unit}`;
  return "(not stated numerically)";
}

const normalise = (s: string): string => s.trim().toLowerCase().replace(/[\s_-]+/g, " ");

/**
 * Compare what the specification demanded with what the certificate says.
 *
 * A required property with no measurement is a FAILURE of the certificate to
 * evidence the requirement — not a pass by omission. A required property
 * expressed only as text is reported as unjudged with the text quoted, since
 * "fine grain practice" is not something arithmetic settles.
 */
export function verifyProperties(
  required: RequiredProperty[],
  measured: MeasuredProperty[],
): PropertyVerdict[] {
  const measuredByName = new Map(measured.map((m) => [normalise(m.property), m] as const));
  const verdicts: PropertyVerdict[] = [];
  for (const req of required) {
    const found = measuredByName.get(normalise(req.property));
    const requirement = describeRequirement(req);
    if (!found) {
      verdicts.push({
        property: req.property,
        required: requirement,
        measured: "(not on the certificate)",
        passed: false,
        reason: `The specification requires ${req.property} ${requirement}, and the certificate does not report it. A requirement the certificate is silent on is unevidenced, which is a fail of the check rather than a pass by omission.`,
      });
      continue;
    }
    const numericRequirement =
      (req.min !== null && req.min !== undefined) ||
      (req.max !== null && req.max !== undefined) ||
      (req.target !== null && req.target !== undefined);
    if (!numericRequirement) {
      verdicts.push({
        property: req.property,
        required: requirement,
        measured: found.text ?? (found.value !== null && found.value !== undefined ? String(found.value) : "—"),
        passed: null,
        reason: `${req.property} is specified in words rather than numbers, so it is recorded for a reader to judge rather than decided arithmetically.`,
      });
      continue;
    }
    if (found.value === null || found.value === undefined || !Number.isFinite(found.value)) {
      verdicts.push({
        property: req.property,
        required: requirement,
        measured: found.text ?? "(no numeric value)",
        passed: false,
        reason: `${req.property} is required to be ${requirement} but the certificate carries no number for it${found.text ? ` (it says "${found.text}")` : ""}.`,
      });
      continue;
    }
    const value = found.value;
    const unit = req.unit ? ` ${req.unit}` : "";
    let passed = true;
    const failures: string[] = [];
    if (req.min !== null && req.min !== undefined && value < req.min - EPSILON) {
      passed = false;
      failures.push(`${round4(value)}${unit} is below the minimum ${req.min}${unit}`);
    }
    if (req.max !== null && req.max !== undefined && value > req.max + EPSILON) {
      passed = false;
      failures.push(`${round4(value)}${unit} is above the maximum ${req.max}${unit}`);
    }
    if (
      req.target !== null &&
      req.target !== undefined &&
      (req.min === null || req.min === undefined) &&
      (req.max === null || req.max === undefined) &&
      Math.abs(value - req.target) > EPSILON
    ) {
      passed = false;
      failures.push(`${round4(value)}${unit} differs from the specified ${req.target}${unit}`);
    }
    verdicts.push({
      property: req.property,
      required: requirement,
      measured: `${round4(value)}${unit}`,
      passed,
      reason: passed
        ? `${req.property} measured ${round4(value)}${unit} against a requirement of ${requirement}.`
        : `${req.property} fails: ${failures.join("; ")}.`,
    });
  }
  return verdicts;
}

/**
 * The whole certificate: property comparison plus the traceability questions
 * the type of the document settles.
 */
export function verifyCertificate(input: {
  certificateType: string;
  heatNumber: string | null;
  batchNumber: string | null;
  castNumber: string | null;
  documentFileId: string | null;
  required: RequiredProperty[];
  measured: MeasuredProperty[];
}): CertificateVerification {
  const verdicts = verifyProperties(input.required, input.measured);
  const reasons: string[] = [];
  const lotTraceable =
    (LOT_SPECIFIC_CERTIFICATE_TYPES as readonly string[]).includes(input.certificateType) &&
    Boolean(input.heatNumber || input.batchNumber || input.castNumber);
  const independentlyWitnessed = (INDEPENDENT_CERTIFICATE_TYPES as readonly string[]).includes(
    input.certificateType,
  );

  if (!(LOT_SPECIFIC_CERTIFICATE_TYPES as readonly string[]).includes(input.certificateType)) {
    reasons.push(
      `A ${input.certificateType.replace(/_/g, " ")} document is not specific to the delivered lot, so it cannot bind the material on site to the numbers on the page. Where the specification calls for EN 10204 3.1 or 3.2, this certificate does not satisfy it.`,
    );
  } else if (!input.heatNumber && !input.batchNumber && !input.castNumber) {
    reasons.push(
      "No heat, cast or batch number is recorded, so this certificate cannot be tied to any material on site. Traceability is the reason the certificate is kept at all.",
    );
  }
  if (!input.documentFileId) {
    reasons.push(
      "The certificate document itself is not attached; the register holds the transcription but not the evidence behind it.",
    );
  }
  if (input.required.length === 0) {
    reasons.push(
      "No specified properties are recorded against this certificate, so nothing has been verified — the numbers have been filed, not checked.",
    );
  }

  const failed = verdicts.filter((v) => v.passed === false);
  let status: CertificateVerificationStatus;
  if (input.required.length === 0) {
    status = "unverified";
  } else if (failed.length > 0) {
    status = "failed";
    reasons.push(
      `${failed.length} specified property(ies) are not met: ${failed.map((v) => v.property).join(", ")}. Material delivered against a failing certificate is a non-conformance before it is installed.`,
    );
  } else if (!lotTraceable) {
    status = "unverified";
  } else {
    status = "verified";
  }
  return { status, verdicts, reasons, lotTraceable, independentlyWitnessed };
}
