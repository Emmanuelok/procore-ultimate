/**
 * Shared types, vocabulary and small presentational helpers for the Tax &
 * Statutory Deductions workspace (spec Vol II Domain Q, #798–807, #816–820).
 *
 * The view-models mirror the API exactly. Every computed figure the API
 * returns comes with its basis — citations, warnings, assumptions, a
 * confidence — and this workspace prints those verbatim next to the number,
 * because a tax figure without its rule is an opinion.
 *
 * Honesty rules applied here:
 *  · a figure the API returned as null renders "—" (or "not computed") with
 *    the reason, never 0;
 *  · money always carries its currency and is never summed across currencies
 *    (the API buckets; the page shows the buckets);
 *  · every panel loads, fails and empties on its own.
 */
import { useCallback, useState, type ReactNode } from "react";
import { api, ApiClientError } from "../../lib/api";
import { Alert, Badge, Skeleton, cx } from "../../ui";
import type { Tone } from "../../ui/tokens";
import { useResource, type Loadable, type Paginated } from "../../layouts/project/lib";

export { useResource };
export type { Loadable, Paginated };

/* ================================= Types ================================== */

export interface RegimeSummary {
  regime: string;
  name: string;
  jurisdiction: string;
  countryCode: string;
  currency: string;
  ratesAsAt: string;
  indirectTaxKind: string;
  standardRate: number;
  domesticReverseCharge: boolean;
  withholdingScheme: string;
  withholdingName: string | null;
  levies: string[];
  returns: string[];
  peConstructionSiteDays: number;
  peServiceDays: number;
  eInvoicing: string | null;
  summary: string;
}

export interface RateOption {
  key: string;
  rate: number;
  treatment: string;
  appliesTo: string;
  citation: string;
}

export interface WithholdingRule {
  key: string;
  scheme: string;
  rate: number;
  base: string;
  supplyTypes?: string[];
  contractTypes?: string[];
  requires?: string;
  threshold?: { amount: number; note: string } | null;
  when: string;
  citation: string;
}

export interface ReturnDef {
  kind: string;
  name: string;
  cadence: string;
  periodMonths: number;
  dueDaysAfterPeriodEnd: number;
  paymentDueDaysAfterPeriodEnd: number | null;
  citation: string;
  note: string | null;
}

export interface RegimeDef {
  regime: string;
  name: string;
  jurisdiction: string;
  countryCode: string;
  currency: string;
  summary: string;
  ratesAsAt: string;
  indirectTax: {
    kind: string;
    name: string;
    standardRate: number;
    otherRates: RateOption[];
    supplyDefaults: Record<string, string>;
    registrationThreshold: { amount: number; currency: string; note: string } | null;
    citation: string;
    note: string | null;
  };
  reverseCharge: {
    domesticConstruction: {
      supplyTypes: string[];
      contractTypes: string[];
      requiresCustomerVat: boolean;
      requiresCustomerDeductionScheme: boolean;
      endUserExcluded: boolean;
      citation: string;
      summary: string;
    } | null;
    importedServices: { requiresCustomerVat: boolean; citation: string; summary: string } | null;
  };
  withholding: {
    scheme: string;
    name: string;
    summary: string;
    registrationDriven: {
      verifiedGrossRate: number;
      verifiedNetRate: number;
      unverifiedRate: number;
      base: string;
      supplyTypes: string[];
      contractTypes: string[];
      requiresCustomerScheme: boolean;
      citation: string;
      summary: string;
    } | null;
    resident: WithholdingRule[];
    nonResident: WithholdingRule[];
    certificateName: string;
    remittance: string;
    verificationValidityDays: number | null;
  } | null;
  levies: Array<{ key: string; name: string; rate: number; recoverable: boolean; citation: string }>;
  returns: ReturnDef[];
  permanentEstablishment: { constructionSiteDays: number; serviceDays: number; basis: string; citation: string };
  invoiceRequirements: string[];
  eInvoicing: string | null;
  notes: string[];
}

export interface Registration {
  id: string;
  companyId: string;
  holderType: string;
  holderId: string | null;
  holderName: string;
  regime: string;
  kind: string;
  number: string | null;
  status: string;
  verificationStatus: string;
  verifiedAt: string | null;
  verifiedBy: string | null;
  verificationReference: string | null;
  deductionRate: number | null;
  validFrom: string | null;
  validTo: string | null;
  country: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface RegistrationDetail extends Registration {
  regimeDef: RegimeSummary | null;
}

export interface PartyPosition {
  country: string | null;
  vatRegistered: boolean | null;
  deductionRegistered: boolean | null;
  deductionVerified: boolean | null;
  deductionRate: number | null;
  tinOnFile: boolean | null;
  isIndividual: boolean;
  endUser?: boolean;
}

export interface Profile {
  id: string;
  projectId: string;
  regime: string;
  placeOfSupplyCountry: string | null;
  customerVatRegistered: number;
  customerDeductionRegistered: number;
  endUser: number;
  defaultSupplyType: string;
  defaultContractType: string;
  currency: string;
  customRules: Record<string, unknown>;
  notes: string | null;
  updatedAt: string;
}

export interface ProfileResponse {
  profile: Profile | null;
  resolved: { regime: string | null; source: "profile" | "project_country" | "none"; reasons: string[] };
  project: { id: string; name: string; country: string | null; currency: string } | null;
  regimeDef: RegimeSummary | null;
  customerPosition: PartyPosition | null;
}

export interface Citation {
  element: string;
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
  regime: string;
  vatTreatment: string;
  vatRate: number;
  vatAmount: number;
  selfAccountedVat: number;
  reverseCharge: boolean;
  withholdingScheme: string;
  withholdingBase: string;
  withholdingBaseAmount: number;
  withholdingRate: number;
  withholdingAmount: number;
  levies: LevyLine[];
  leviesAmount: number;
  grossPayable: number;
  netPayable: number;
  citations: Citation[];
  warnings: string[];
  assumptions: string[];
  confidence: number;
  explanation: string;
}

export interface DeterminationRow {
  id: string;
  number: number;
  sourceType: string;
  sourceId: string | null;
  sourceLineId: string | null;
  vendorId: string | null;
  vendorName: string | null;
  regime: string;
  supplyType: string;
  contractType: string;
  amount: number;
  currency: string;
  taxPointDate: string | null;
  inputs: Record<string, unknown>;
  vatTreatment: string;
  vatRate: number;
  vatAmount: number;
  selfAccountedVat: number;
  reverseCharge: boolean;
  withholdingScheme: string;
  withholdingBase: string;
  withholdingBaseAmount: number;
  withholdingRate: number;
  withholdingAmount: number;
  leviesAmount: number;
  netPayable: number;
  outputs: Record<string, unknown>;
  citations: Citation[];
  warnings: string[];
  assumptions: string[];
  confidence: number;
  status: string;
  overriddenById: string | null;
  overridesId: string | null;
  overrideReason: string | null;
  supersededById: string | null;
  determinedBy: string | null;
  createdAt: string;
}

export interface DeterminationDetail extends DeterminationRow {
  chain: Array<{
    id: string;
    number: number;
    status: string;
    createdAt: string;
    overrideReason: string | null;
    determinedBy: string | null;
  }>;
  regimeDef: RegimeSummary | null;
}

export interface DetermineResponse {
  regime: string;
  regimeSource: string;
  input: Record<string, unknown>;
  output: DeterminationOutput;
  vendor: { id: string; name: string; country: string | null; taxId: string | null } | null;
  vendorRegistrations: Registration[];
  determination: DeterminationRow | null;
}

export interface InvoiceDetermineResponse {
  invoice: { id: string; reference: string; currency: string; taxAmount: number; subtotal: number; total: number; vendorId: string | null };
  regime: string;
  lines: Array<{
    lineId: string;
    lineNumber: string;
    description: string;
    amount: number;
    skipped: string | null;
    determinationId: string | null;
    output: DeterminationOutput | null;
  }>;
  determined: number;
  skipped: number;
  totals: { amount: number; vatAmount: number; selfAccountedVat: number; withholdingAmount: number; leviesAmount: number; netPayable: number };
  check: { invoiceTax: number; determinedVat: number; mismatch: number; note: string };
  risks: Array<{ detector: string; severity: string; title: string; signalId: string; raised: boolean }>;
}

export interface Certificate {
  id: string;
  number: number;
  reference: string | null;
  determinationId: string | null;
  paymentId: string | null;
  invoiceId: string | null;
  vendorId: string | null;
  vendorName: string;
  regime: string;
  scheme: string;
  paymentDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  currency: string;
  grossAmount: number;
  materialsAmount: number;
  baseAmount: number;
  rate: number;
  withheldAmount: number;
  netPaid: number;
  status: string;
  issuedAt: string | null;
  issuedBy: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  detail: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
}

export interface CertificateDetail extends Certificate {
  certificateName: string | null;
  remittance: string | null;
}

export interface Period {
  id: string;
  regime: string;
  returnKind: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  paymentDueDate: string | null;
  currency: string;
  status: string;
  outputTax: number | null;
  inputTax: number | null;
  selfAccountedTax: number | null;
  withheldTotal: number | null;
  netPayable: number | null;
  determinationCount: number;
  certificateCount: number;
  excludedCount: number;
  computedAt: string | null;
  computeBasis: Record<string, unknown>;
  obligationId: string | null;
  filedAt: string | null;
  filedBy: string | null;
  filingReference: string | null;
  paidAt: string | null;
  paidBy: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  daysToDue?: number;
}

export interface PeriodDetail extends Period {
  live: {
    outputTax: number | null;
    inputTax: number | null;
    selfAccountedTax: number | null;
    withheldTotal: number | null;
    netPayable: number | null;
    determinationCount: number;
    certificateCount: number;
    excludedCount: number;
    computeBasis: Record<string, unknown>;
  };
  obligation: { id: string; status: string; deadline: string | null; trigger: string } | null;
  returnDef: ReturnDef | null;
}

export interface Exposure {
  id: string;
  entityType: string;
  entityId: string | null;
  entityName: string;
  homeCountry: string;
  hostCountry: string;
  regime: string;
  thresholdDays: number;
  windowMonths: number;
  warnFraction: number;
  thresholdBasis: string;
  daysInWindow: number;
  daysTotal: number;
  firstPresenceDate: string | null;
  lastPresenceDate: string | null;
  projectedBreachDate: string | null;
  status: string;
  mitigationNote: string | null;
  lastComputedAt: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  percentOfThreshold?: number | null;
}

export interface PresenceEntry {
  id: string;
  startDate: string;
  endDate: string;
  days: number;
  purpose: string | null;
  source: string;
  sourceRef: string | null;
  recordedBy: string;
  createdAt: string;
}

export interface ExposureDetail extends Exposure {
  entries: PresenceEntry[];
}

export interface TaxSignal {
  id: string;
  projectId: string | null;
  detector: string;
  severity: string;
  confidence: number;
  title: string;
  explanation: string;
  evidenceRefs: unknown;
  disposition: string;
  createdAt: string;
}

export interface VendorCoverage {
  id: string;
  name: string;
  country: string | null;
  taxId: string | null;
  commitments: number;
  approved: number;
  registrations: Array<{ id: string; kind: string; number: string | null; status: string; verificationStatus: string; deductionRate: number | null }>;
  covered: boolean;
  verified: boolean;
}

export interface VendorsCoverageResponse {
  regime: string | null;
  items: VendorCoverage[];
  total: number;
  reasons: string[];
}

export interface TaxSummary {
  regime: string | null;
  regimeSource: string;
  reasons: string[];
  determinations: { current: number; overridden: number; reverseCharged: number; lowConfidence: number };
  byCurrency: Array<{ currency: string; withholdingDetermined: number; selfAccountedVat: number; withheldIssued: number }>;
  certificates: { total: number; draft: number; issued: number };
  periods: { total: number; open: number; overdue: number; dueSoon: number; filed: number };
  peExposures: { total: number; approaching: number; breached: number };
  openRiskSignals: number;
}

export interface ScanResult {
  overduePeriods: number;
  verificationsExpired: number;
  missingRegistrations: number;
  missingRegistrationsCleared: number;
  whtNotDeducted: number;
  reverseChargeMisapplied: number;
  signalsRaised: number;
  peRecomputed: number;
  peSignalsRaised: number;
  ranAt: string;
}

export interface VendorLite {
  id: string;
  name: string;
  country: string | null;
}

export interface InvoiceLite {
  id: string;
  reference: string;
  kind: string;
  status: string;
  vendorId: string | null;
  currency: string;
  billingDate: string | null;
  taxAmount: number;
  total: number;
}

/* ============================== Vocabulary ================================ */

export const SUPPLY_TYPES = [
  "construction_services",
  "labour_only",
  "professional_services",
  "plant_hire",
  "materials_only",
  "goods",
  "mixed",
] as const;

export const CONTRACT_TYPES = ["main_contract", "subcontract", "supply_only", "consultancy", "intercompany"] as const;

export const HOLDER_TYPES = ["company", "vendor", "entity"] as const;

export const REGISTRATION_KINDS = ["vat", "cis", "rct", "wht", "tin", "other"] as const;

export const REGISTRATION_STATUSES = ["active", "pending", "lapsed", "deregistered"] as const;

export const VERIFICATION_STATUSES = ["unverified", "verified", "failed", "expired"] as const;

export const VAT_TREATMENTS = [
  "standard",
  "reduced",
  "zero",
  "exempt",
  "out_of_scope",
  "reverse_charge",
  "reverse_charge_import",
  "not_registered",
  "not_applicable",
] as const;

export const WITHHOLDING_SCHEMES = ["none", "cis", "rct", "wht", "tds", "backup", "custom"] as const;

export const WITHHOLDING_BASES = ["gross_excl_vat", "gross_excl_materials", "labour_only", "none"] as const;

export const RETURN_KINDS = ["vat", "cis_monthly", "rct_monthly", "wht", "tds", "other"] as const;

export const PE_ENTITY_TYPES = ["company", "vendor", "entity", "person"] as const;

export const PRESENCE_SOURCES = ["manual", "timecards", "site_access", "travel"] as const;

export const DETECTOR_LABEL: Record<string, string> = {
  tax_missing_registration: "Missing registration",
  tax_wht_not_deducted: "Withholding not deducted",
  tax_reverse_charge_misapplied: "Reverse charge misapplied",
  tax_pe_threshold: "PE threshold",
  tax_return_overdue: "Return overdue",
  tax_verification_expired: "Verification lapsed",
};

/* ================================ Helpers ================================= */

export const DASH = "—";

export function titleCase(value: string | null | undefined): string {
  if (!value) return DASH;
  return value
    .split(/[_\s]+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Money never appears without its currency; a missing value is a dash. */
export function money(value: number | null | undefined, currency: string | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  const cur = currency && /^[A-Z]{3}$/.test(currency) ? currency : null;
  try {
    return cur
      ? new Intl.NumberFormat(undefined, { style: "currency", currency: cur, maximumFractionDigits: 2 }).format(value)
      : value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch {
    return `${cur ?? ""} ${value.toFixed(2)}`.trim();
  }
}

export function pct(value: number | null | undefined, dp = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return `${value.toFixed(dp)}%`;
}

export function isoDate(value: string | null | undefined): string {
  if (!value) return DASH;
  return value.slice(0, 10);
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return DASH;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function count(n: number | null | undefined): string {
  if (n === null || n === undefined) return DASH;
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export function errorMessage(err: unknown, fallback = "The request failed."): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

export function treatmentTone(treatment: string): Tone {
  switch (treatment) {
    case "reverse_charge":
    case "reverse_charge_import":
      return "info";
    case "not_registered":
      return "danger";
    case "reduced":
    case "zero":
    case "exempt":
      return "accent";
    case "standard":
      return "neutral";
    default:
      return "neutral";
  }
}

export function determinationTone(status: string): Tone {
  if (status === "determined") return "success";
  if (status === "overridden") return "warning";
  return "neutral";
}

export function verificationTone(status: string): Tone {
  if (status === "verified") return "success";
  if (status === "failed") return "danger";
  if (status === "expired") return "warning";
  return "neutral";
}

export function certificateTone(status: string): Tone {
  if (status === "issued") return "success";
  if (status === "cancelled") return "danger";
  return "warning";
}

export function periodTone(status: string): Tone {
  switch (status) {
    case "overdue":
      return "danger";
    case "filed":
    case "paid":
      return "success";
    case "closed":
      return "info";
    default:
      return "warning";
  }
}

export function exposureTone(status: string): Tone {
  switch (status) {
    case "breached":
      return "danger";
    case "approaching":
      return "warning";
    case "mitigated":
      return "info";
    case "closed":
      return "neutral";
    default:
      return "success";
  }
}

export function severityTone(severity: string): Tone {
  switch (severity) {
    case "critical":
      return "danger";
    case "high":
      return "danger";
    case "medium":
      return "warning";
    case "low":
      return "info";
    default:
      return "neutral";
  }
}

/** Confidence as the engine produced it: a fraction, printed as a percent with a tone. */
export function ConfidenceBadge({ value }: { value: number }) {
  const tone: Tone = value >= 0.85 ? "success" : value >= 0.6 ? "warning" : "danger";
  return (
    <Badge tone={tone} size="xs" title="Confidence falls with every assumption the engine had to make">
      {Math.round(value * 100)}% confidence
    </Badge>
  );
}

/* ============================ Panel primitives ============================ */

export function ReasonList({ reasons, className }: { reasons: readonly string[]; className?: string }) {
  if (reasons.length === 0) return null;
  return (
    <ul className={cx("space-y-1", className)}>
      {reasons.map((reason, index) => (
        <li key={index} className="flex items-start gap-1.5 text-meta text-content-muted">
          <span aria-hidden className="mt-0.5 shrink-0 text-content-disabled">
            ▪
          </span>
          <span>{reason}</span>
        </li>
      ))}
    </ul>
  );
}

export function LoadError({ message, onRetry, title = "This panel could not be loaded" }: { message: string; onRetry?: () => void; title?: string }) {
  return (
    <Alert
      tone="danger"
      title={title}
      actions={
        onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md border border-danger-border bg-surface-raised px-2.5 py-1 text-meta font-medium text-content hover:bg-surface-hover"
          >
            Retry
          </button>
        ) : undefined
      }
    >
      {message}
    </Alert>
  );
}

export function LoadingBlock({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

/** A label/value row inside a drawer. */
export function Row({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <dt className="shrink-0 text-meta text-content-subtle">{label}</dt>
      <dd className="min-w-0 text-right text-meta text-content">
        <div>{children}</div>
        {hint ? <div className="text-2xs text-content-subtle">{hint}</div> : null}
      </dd>
    </div>
  );
}

/** The engine's own words: citations, warnings and assumptions, verbatim. */
export function Basis({ output }: { output: Pick<DeterminationOutput, "citations" | "warnings" | "assumptions" | "explanation" | "confidence"> }) {
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border bg-surface-sunken p-3 text-meta text-content">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-2xs font-semibold uppercase tracking-wide text-content-subtle">Explanation</span>
          <ConfidenceBadge value={output.confidence} />
        </div>
        {output.explanation}
      </div>
      {output.warnings.length > 0 ? (
        <Alert tone="warning" title={`${output.warnings.length} warning${output.warnings.length === 1 ? "" : "s"}`} size="sm">
          <ReasonList reasons={output.warnings} />
        </Alert>
      ) : null}
      {output.assumptions.length > 0 ? (
        <Alert tone="info" title={`${output.assumptions.length} assumption${output.assumptions.length === 1 ? "" : "s"} lowered confidence`} size="sm">
          <ReasonList reasons={output.assumptions} />
        </Alert>
      ) : null}
      <div>
        <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">Rules cited</div>
        {output.citations.length === 0 ? (
          <div className="text-meta text-content-subtle">No rule was cited — this is a human figure, not the engine's.</div>
        ) : (
          <ol className="space-y-1.5">
            {output.citations.map((c, i) => (
              <li key={i} className="rounded-md border border-border px-2.5 py-1.5 text-meta">
                <div className="flex items-center gap-2">
                  <Badge tone="neutral" size="xs">
                    {titleCase(c.element)}
                  </Badge>
                  <span className="text-content">{c.rule}</span>
                </div>
                <div className="mt-0.5 text-2xs text-content-subtle">Source: {c.source}</div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

/* ================================= Hooks ================================== */

/** One mutation at a time, with its refusal printed rather than swallowed. */
export function useAction(): {
  busy: string | null;
  error: string | null;
  clear: () => void;
  run: <T>(key: string, fn: () => Promise<T>) => Promise<T | null>;
} {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(key);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(errorMessage(err));
      return null;
    } finally {
      setBusy(null);
    }
  }, []);
  const clear = useCallback(() => setError(null), []);
  return { busy, error, clear, run };
}

export function useVendors(): Loadable<Paginated<VendorLite>> {
  return useResource<Paginated<VendorLite>>("/api/v1/vendors?page=1&pageSize=200");
}

export function useRegimes(): Loadable<{ items: RegimeSummary[]; total: number }> {
  return useResource<{ items: RegimeSummary[]; total: number }>("/api/v1/tax/regimes");
}

export function useRegimeDef(regime: string | null): Loadable<RegimeDef> {
  return useResource<RegimeDef>(regime ? `/api/v1/tax/regimes/${regime}` : null);
}

export function useProfile(projectId: string): Loadable<ProfileResponse> {
  return useResource<ProfileResponse>(`/api/v1/projects/${projectId}/tax/profile`);
}

export function useSummary(projectId: string): Loadable<TaxSummary> {
  return useResource<TaxSummary>(`/api/v1/projects/${projectId}/tax/summary`);
}

export const taxApi = {
  determine: (projectId: string, body: Record<string, unknown>) =>
    api.post<DetermineResponse>(`/api/v1/projects/${projectId}/tax/determine`, body),
  determineInvoice: (projectId: string, invoiceId: string) =>
    api.post<InvoiceDetermineResponse>(`/api/v1/projects/${projectId}/tax/invoices/${invoiceId}/determine`, {}),
  override: (projectId: string, id: string, body: Record<string, unknown>) =>
    api.post<DeterminationRow>(`/api/v1/projects/${projectId}/tax/determinations/${id}/override`, body),
  createCertificate: (projectId: string, body: Record<string, unknown>) =>
    api.post<Certificate>(`/api/v1/projects/${projectId}/tax/withholding-certificates`, body),
  issueCertificate: (projectId: string, id: string) =>
    api.post<Certificate>(`/api/v1/projects/${projectId}/tax/withholding-certificates/${id}/issue`, {}),
  cancelCertificate: (projectId: string, id: string, reason: string) =>
    api.post<Certificate>(`/api/v1/projects/${projectId}/tax/withholding-certificates/${id}/cancel`, { reason }),
  createPeriod: (projectId: string, body: Record<string, unknown>) =>
    api.post<Period>(`/api/v1/projects/${projectId}/tax/periods`, body),
  computePeriod: (projectId: string, id: string) =>
    api.post<Period>(`/api/v1/projects/${projectId}/tax/periods/${id}/compute`, {}),
  filePeriod: (projectId: string, id: string, body: Record<string, unknown>) =>
    api.post<Period>(`/api/v1/projects/${projectId}/tax/periods/${id}/file`, body),
  markPeriodPaid: (projectId: string, id: string) =>
    api.post<Period>(`/api/v1/projects/${projectId}/tax/periods/${id}/mark-paid`, {}),
  createExposure: (projectId: string, body: Record<string, unknown>) =>
    api.post<Exposure>(`/api/v1/projects/${projectId}/tax/pe-exposures`, body),
  patchExposure: (projectId: string, id: string, body: Record<string, unknown>) =>
    api.patch<Exposure>(`/api/v1/projects/${projectId}/tax/pe-exposures/${id}`, body),
  addEntry: (projectId: string, id: string, body: Record<string, unknown>) =>
    api.post<{ entry: { id: string; days: number }; exposure: Exposure }>(`/api/v1/projects/${projectId}/tax/pe-exposures/${id}/entries`, body),
  deleteEntry: (projectId: string, id: string, entryId: string) =>
    api.del<Exposure>(`/api/v1/projects/${projectId}/tax/pe-exposures/${id}/entries/${entryId}`),
  mitigate: (projectId: string, id: string, note: string) =>
    api.post<Exposure>(`/api/v1/projects/${projectId}/tax/pe-exposures/${id}/mitigate`, { note }),
  closeExposure: (projectId: string, id: string, reason: string) =>
    api.post<Exposure>(`/api/v1/projects/${projectId}/tax/pe-exposures/${id}/close`, { reason }),
  scan: (projectId: string) => api.post<ScanResult>(`/api/v1/projects/${projectId}/tax/risks/scan`, {}),
  saveProfile: (projectId: string, body: Record<string, unknown>) =>
    api.put<ProfileResponse>(`/api/v1/projects/${projectId}/tax/profile`, body),
  createRegistration: (body: Record<string, unknown>) => api.post<Registration>("/api/v1/tax/registrations", body),
  patchRegistration: (id: string, body: Record<string, unknown>) => api.patch<Registration>(`/api/v1/tax/registrations/${id}`, body),
  verifyRegistration: (id: string, body: Record<string, unknown>) =>
    api.post<Registration>(`/api/v1/tax/registrations/${id}/verify`, body),
  deleteRegistration: (id: string) => api.del<void>(`/api/v1/tax/registrations/${id}`),
};
