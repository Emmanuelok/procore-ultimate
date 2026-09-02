/**
 * TRACEABILITY ENGINE (spec #945–947; Vol I #721, #724–725).
 *
 * The chain a structural sign-off needs: an IDENTIFIER (heat, batch, lot or
 * serial) → a CERTIFICATE that vouches for it (mill cert, test cert,
 * declaration of conformity, CE/UKCA marking) → the LOCATION it went into.
 * `chainCompleteness` names every missing link so the gap is a to-do, not a
 * surprise at handover.
 */
import type { TraceCertificateKind } from "@constructos/shared";

export interface TraceCertificate {
  id: string;
  kind: TraceCertificateKind | string;
  reference: string;
  fileId?: string | null;
  issuedBy?: string | null;
  issuedAt?: string | null;
  verifiedBy?: string | null;
  verifiedAt?: string | null;
}

export interface TraceRecordInput {
  heatNumber: string | null;
  batchNumber: string | null;
  lotNumber: string | null;
  serialNumber: string | null;
  certificates: TraceCertificate[];
  status: string;
  installedLocationId: string | null;
  installedAt: string | null;
  supplierNodeId: string | null;
  vendorId: string | null;
  manufacturer: string | null;
  originCountry: string | null;
  conformityMarking: string | null;
  /** whether the product needs a CE/UKCA marking (structural steel, cables …) */
  requiresConformityMarking?: boolean;
}

export interface ChainCompleteness {
  complete: boolean;
  /** 0..100 — the share of links present */
  score: number;
  gaps: string[];
  links: {
    identifier: boolean;
    provenance: boolean;
    certificate: boolean;
    certificateVerified: boolean;
    conformityMarking: boolean | null;
    installed: boolean;
  };
}

const VOUCHING_KINDS: ReadonlySet<string> = new Set([
  "mill_certificate",
  "test_certificate",
  "declaration_of_conformity",
  "ce_ukca_marking",
]);

export function chainCompleteness(record: TraceRecordInput): ChainCompleteness {
  const gaps: string[] = [];
  const identifier = Boolean(record.heatNumber || record.batchNumber || record.lotNumber || record.serialNumber);
  if (!identifier) gaps.push("No heat, batch, lot or serial number: the lot cannot be traced back to a certificate.");

  const provenance = Boolean(record.supplierNodeId || record.vendorId || record.manufacturer);
  if (!provenance) gaps.push("No supplier, vendor or manufacturer recorded.");

  const vouching = record.certificates.filter((c) => VOUCHING_KINDS.has(c.kind));
  const certificate = vouching.length > 0;
  if (!certificate) gaps.push("No mill/test certificate or declaration of conformity attached.");
  const certificateVerified = vouching.some((c) => Boolean(c.verifiedBy));
  if (certificate && !certificateVerified) gaps.push("Certificate attached but not verified by a second person.");

  let conformityMarking: boolean | null = null;
  if (record.requiresConformityMarking) {
    conformityMarking = Boolean(record.conformityMarking) || record.certificates.some((c) => c.kind === "ce_ukca_marking");
    if (!conformityMarking) gaps.push("Product needs a CE/UKCA marking reference and none is recorded.");
  }

  const installed = record.status === "installed" && Boolean(record.installedLocationId);
  if (record.status === "installed" && !record.installedLocationId) gaps.push("Marked installed with no location.");
  if (record.status !== "installed" && record.status !== "rejected") gaps.push("Not yet installed: the chain ends at the compound.");

  const checks: boolean[] = [identifier, provenance, certificate, certificateVerified, installed];
  if (conformityMarking !== null) checks.push(conformityMarking);
  const present = checks.filter(Boolean).length;
  const score = Math.round((present / checks.length) * 100);
  return {
    complete: gaps.length === 0,
    score,
    gaps,
    links: { identifier, provenance, certificate, certificateVerified, conformityMarking, installed },
  };
}

export interface TraceCoverage {
  records: number;
  complete: number;
  installed: number;
  installedWithoutCertificate: number;
  completenessPercent: number | null;
  reasons: string[];
}

export function traceCoverage(rows: Array<{ chainComplete: number; status: string; certificateCount: number }>): TraceCoverage {
  const records = rows.length;
  const complete = rows.filter((r) => r.chainComplete === 1).length;
  const installed = rows.filter((r) => r.status === "installed").length;
  const installedWithoutCertificate = rows.filter((r) => r.status === "installed" && r.certificateCount === 0).length;
  return {
    records,
    complete,
    installed,
    installedWithoutCertificate,
    completenessPercent: records > 0 ? Math.round((complete / records) * 1000) / 10 : null,
    reasons: records === 0 ? ["No traceability records yet."] : [],
  };
}
