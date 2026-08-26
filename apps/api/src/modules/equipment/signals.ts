/**
 * M23 — the detector catalogue and the certificate/maintenance sweep
 * inputs. Kept out of `index.ts` so the detector keys, their severities and
 * the prose that goes into each Signal are readable in one place, and so the
 * "which certificate types are statutory" judgement is a constant somebody
 * can argue with rather than an inline condition.
 */

import type { EquipmentCertificateType, SignalSeverity } from "@constructos/shared";

/** Every detector this module raises. Listed so the module summary can
 *  report a zero count for a detector that has never fired, rather than
 *  silently omitting it — an absent detector and a clean one look identical
 *  otherwise. */
export const EQUIPMENT_DETECTORS = [
  "equipment_certificate_expired_in_service",
  "equipment_certificate_expired",
  "equipment_maintenance_overdue_critical",
  "equipment_idle_on_hire",
  "equipment_meter_anomaly",
  "equipment_telematics_variance",
  "material_stock_negative",
] as const;
export type EquipmentDetector = (typeof EQUIPMENT_DETECTORS)[number];

/**
 * Certificate types whose lapse makes OPERATION UNLAWFUL rather than merely
 * non-compliant with our own procedure. This is the list that turns an
 * expired certificate on assigned plant into a critical Signal: a crane
 * whose thorough examination lapsed yesterday is not "overdue paperwork",
 * it is an uninsured, illegal lift.
 *
 * `insurance`, `conformity_declaration` and `calibration` are deliberately
 * NOT here: their lapse is serious and is still reported, but at high rather
 * than critical, because the machine may lawfully be operated while it is
 * chased.
 */
export const STATUTORY_CERTIFICATE_TYPES: readonly EquipmentCertificateType[] = [
  "thorough_examination",
  "statutory_inspection",
  "puwer_inspection",
  "crane_test_certificate",
  "pressure_vessel",
  "electrical_pat",
  "road_worthiness",
  "operator_licence",
  "lifting_plan_approval",
];

export function isStatutoryCertificate(certificateType: string): boolean {
  return (STATUTORY_CERTIFICATE_TYPES as readonly string[]).includes(certificateType);
}

/** Assignment statuses that mean the machine is on a project right now —
 *  the difference between an expired certificate in the yard and one on a
 *  machine that is lifting today. */
export const IN_SERVICE_ASSIGNMENT_STATUSES = [
  "approved",
  "mobilising",
  "on_site",
  "demobilising",
] as const;

/** How many days ahead a certificate flips to `expiring`. Four weeks is the
 *  shortest notice a competent-person inspection can usually be booked at. */
export const CERTIFICATE_EXPIRING_WINDOW_DAYS = 28;

export interface CertificateVerdict {
  status: "pending" | "valid" | "expiring" | "expired";
  daysToExpiry: number;
  severity: SignalSeverity | null;
  detector: EquipmentDetector | null;
}

const MS_PER_DAY = 86_400_000;

export function daysBetweenISO(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / MS_PER_DAY);
}

/**
 * The derived state of one certificate as at `asOf`.
 *
 * A certificate is expired the day AFTER its `validTo` — a certificate valid
 * to the 30th is valid on the 30th. Getting that boundary wrong condemns a
 * lawful machine or clears an unlawful one, so it is stated once, here.
 */
export function certificateVerdict(input: {
  validTo: string;
  validFrom: string | null;
  certificateType: string;
  inService: boolean;
  asOf: string;
}): CertificateVerdict {
  const daysToExpiry = daysBetweenISO(input.asOf, input.validTo);
  if (input.validFrom && input.validFrom > input.asOf) {
    return { status: "pending", daysToExpiry, severity: null, detector: null };
  }
  if (daysToExpiry < 0) {
    const statutory = isStatutoryCertificate(input.certificateType);
    return {
      status: "expired",
      daysToExpiry,
      severity: input.inService && statutory ? "critical" : "high",
      detector:
        input.inService && statutory
          ? "equipment_certificate_expired_in_service"
          : "equipment_certificate_expired",
    };
  }
  if (daysToExpiry <= CERTIFICATE_EXPIRING_WINDOW_DAYS) {
    return { status: "expiring", daysToExpiry, severity: null, detector: null };
  }
  return { status: "valid", daysToExpiry, severity: null, detector: null };
}
