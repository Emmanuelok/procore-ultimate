import { and, desc, eq, gte, inArray, isNull, lte, ne } from "drizzle-orm";
import {
  invoices,
  obligations,
  peExposures,
  pePresenceEntries,
  projects,
  signals,
  taxDeterminations,
  taxPeriods,
  taxProjectProfiles,
  taxRegistrations,
  vendors,
  withholdingCertificates,
} from "@constructos/db";
import type {
  PeExposureStatus,
  TaxRegime,
  TaxReturnKind,
  TaxRiskDetector,
} from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import {
  determine,
  positionFromRegistrations,
  unknownParty,
  type DeterminationInput,
  type DeterminationOutput,
  type PartyTaxPosition,
} from "./determine.js";
import { classifyExposure, projectBreachDate, summarisePresence } from "./pe.js";
import { findTaxRegime, regimeForCountry } from "./regimes.js";

/**
 * Tax module service layer: the database-facing helpers the routes and the
 * scheduler sweeps share. Everything that decides is in determine.ts / pe.ts
 * (pure); everything here loads inputs, persists outcomes and keeps the
 * assurance tables (signals, obligations) in step.
 */

export type ProfileRow = typeof taxProjectProfiles.$inferSelect;
export type RegistrationRow = typeof taxRegistrations.$inferSelect;
export type DeterminationRow = typeof taxDeterminations.$inferSelect;
export type PeriodRow = typeof taxPeriods.$inferSelect;
export type ExposureRow = typeof peExposures.$inferSelect;

export const round2 = (n: number): number => Math.round(n * 100) / 100;

/* ------------------------------------------------------------------ */
/* Regime resolution                                                   */
/* ------------------------------------------------------------------ */

export interface RegimeResolution {
  regime: TaxRegime | null;
  source: "profile" | "project_country" | "none";
  profile: ProfileRow | null;
  project: { id: string; name: string; country: string | null; currency: string } | null;
  reasons: string[];
}

export async function resolveRegime(
  db: Db,
  companyId: string,
  projectId: string,
): Promise<RegimeResolution> {
  const [profile] = await db
    .select()
    .from(taxProjectProfiles)
    .where(and(eq(taxProjectProfiles.companyId, companyId), eq(taxProjectProfiles.projectId, projectId)))
    .limit(1);
  const [project] = await db
    .select({ id: projects.id, name: projects.name, country: projects.country, currency: projects.currency })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
    .limit(1);
  if (profile) {
    return { regime: profile.regime as TaxRegime, source: "profile", profile, project: project ?? null, reasons: [] };
  }
  const derived = regimeForCountry(project?.country ?? null);
  if (derived) {
    return {
      regime: derived,
      source: "project_country",
      profile: null,
      project: project ?? null,
      reasons: [
        `No tax profile for this project; the regime was derived from the project country (${project?.country}). The tenant's own registrations are unknown until a profile is saved.`,
      ],
    };
  }
  return {
    regime: null,
    source: "none",
    profile: null,
    project: project ?? null,
    reasons: [
      project?.country
        ? `No tax profile and no library regime for country "${project.country}". Save a profile (or use the custom regime).`
        : "No tax profile and no project country to derive a regime from. Save a profile.",
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Party positions                                                     */
/* ------------------------------------------------------------------ */

export async function registrationsFor(
  db: Db,
  companyId: string,
  holderType: "company" | "vendor" | "entity",
  holderId: string | null,
): Promise<RegistrationRow[]> {
  return db
    .select()
    .from(taxRegistrations)
    .where(
      and(
        eq(taxRegistrations.companyId, companyId),
        eq(taxRegistrations.holderType, holderType),
        holderId === null ? isNull(taxRegistrations.holderId) : eq(taxRegistrations.holderId, holderId),
      ),
    )
    .orderBy(desc(taxRegistrations.createdAt));
}

export interface VendorPosition {
  vendor: { id: string; name: string; country: string | null; taxId: string | null } | null;
  registrations: RegistrationRow[];
  position: PartyTaxPosition;
}

export async function vendorPosition(
  db: Db,
  companyId: string,
  regime: TaxRegime,
  vendorId: string | null,
  asOf: string,
  isIndividual = false,
): Promise<VendorPosition> {
  if (!vendorId) {
    return { vendor: null, registrations: [], position: unknownParty() };
  }
  const [vendor] = await db
    .select({ id: vendors.id, name: vendors.name, country: vendors.country, taxId: vendors.taxId })
    .from(vendors)
    .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, companyId)))
    .limit(1);
  if (!vendor) return { vendor: null, registrations: [], position: unknownParty() };
  const registrations = await registrationsFor(db, companyId, "vendor", vendorId);
  const position = positionFromRegistrations(regime, registrations, vendor.country, asOf, isIndividual);
  // A tax id on the directory record counts as a TIN on file when no
  // registration row says otherwise.
  if (position.tinOnFile === null && vendor.taxId && vendor.taxId.trim() !== "") {
    position.tinOnFile = true;
  }
  return { vendor, registrations, position };
}

export async function customerPosition(
  db: Db,
  companyId: string,
  regime: TaxRegime,
  profile: ProfileRow | null,
  asOf: string,
): Promise<PartyTaxPosition & { endUser: boolean }> {
  const rows = await registrationsFor(db, companyId, "company", null);
  const def = findTaxRegime(regime);
  const country = profile?.placeOfSupplyCountry ?? def?.countryCode ?? null;
  const pos = positionFromRegistrations(regime, rows, country, asOf);
  if (!profile) return { ...pos, endUser: false };
  return {
    ...pos,
    vatRegistered: pos.vatRegistered === true || profile.customerVatRegistered === 1 ? true : false,
    deductionRegistered:
      pos.deductionRegistered === true || profile.customerDeductionRegistered === 1 ? true : false,
    endUser: profile.endUser === 1,
  };
}

/* ------------------------------------------------------------------ */
/* Persisting determinations                                           */
/* ------------------------------------------------------------------ */

export interface PersistArgs {
  companyId: string;
  projectId: string;
  actorId: string | null;
  input: DeterminationInput;
  output: DeterminationOutput;
  sourceType: string;
  sourceId: string | null;
  sourceLineId: string | null;
  vendorId: string | null;
  vendorName: string | null;
  status?: "determined";
  overridesId?: string | null;
  overrideReason?: string | null;
}

/**
 * Insert a determination. A re-run for the same source (invoice line etc.)
 * supersedes the previous current record so the register has exactly one
 * live determination per source line, with the history still readable.
 */
export async function persistDetermination(db: Db, a: PersistArgs): Promise<DeterminationRow> {
  const id = newId("txd");
  const number = await nextRecordNumber(db, a.projectId, "tax_determination");
  if (a.sourceId && a.sourceType !== "manual") {
    await db
      .update(taxDeterminations)
      .set({ status: "superseded", supersededById: id })
      .where(
        and(
          eq(taxDeterminations.companyId, a.companyId),
          eq(taxDeterminations.projectId, a.projectId),
          eq(taxDeterminations.sourceType, a.sourceType),
          eq(taxDeterminations.sourceId, a.sourceId),
          a.sourceLineId
            ? eq(taxDeterminations.sourceLineId, a.sourceLineId)
            : isNull(taxDeterminations.sourceLineId),
          eq(taxDeterminations.status, "determined"),
        ),
      );
  }
  const o = a.output;
  const { citations, warnings, assumptions, explanation, ...rest } = o;
  await db.insert(taxDeterminations).values({
    id,
    companyId: a.companyId,
    projectId: a.projectId,
    number,
    sourceType: a.sourceType,
    sourceId: a.sourceId,
    sourceLineId: a.sourceLineId,
    vendorId: a.vendorId,
    vendorName: a.vendorName,
    regime: a.input.regime,
    supplyType: a.input.supplyType,
    contractType: a.input.contractType,
    amount: a.input.amount,
    currency: a.input.currency,
    taxPointDate: a.input.asOf,
    inputs: a.input as unknown as Record<string, unknown>,
    vatTreatment: o.vatTreatment,
    vatRate: o.vatRate,
    vatAmount: o.vatAmount,
    selfAccountedVat: o.selfAccountedVat,
    reverseCharge: o.reverseCharge ? 1 : 0,
    withholdingScheme: o.withholdingScheme,
    withholdingBase: o.withholdingBase,
    withholdingBaseAmount: o.withholdingBaseAmount,
    withholdingRate: o.withholdingRate,
    withholdingAmount: o.withholdingAmount,
    leviesAmount: o.leviesAmount,
    netPayable: o.netPayable,
    outputs: { ...rest, explanation } as unknown as Record<string, unknown>,
    citations: citations as unknown[],
    warnings,
    assumptions,
    confidence: o.confidence,
    status: a.status ?? "determined",
    overridesId: a.overridesId ?? null,
    overrideReason: a.overrideReason ?? null,
    determinedBy: a.actorId,
  });
  const [row] = await db.select().from(taxDeterminations).where(eq(taxDeterminations.id, id)).limit(1);
  return row!;
}

export interface RunArgs {
  companyId: string;
  projectId: string;
  regime: TaxRegime;
  profile: ProfileRow | null;
  vendorId: string | null;
  supplierIsIndividual: boolean;
  asOf: string;
  base: Omit<DeterminationInput, "regime" | "supplier" | "customer" | "asOf">;
  /** explicit overrides on the derived positions */
  supplierOverride?: Partial<PartyTaxPosition> | null;
  customerOverride?: Partial<PartyTaxPosition & { endUser: boolean }> | null;
}

export interface RunResult {
  input: DeterminationInput;
  output: DeterminationOutput;
  vendor: VendorPosition;
}

/** Build the engine input from stored facts (plus overrides) and run it. */
export async function runDetermination(db: Db, a: RunArgs): Promise<RunResult> {
  const vendor = await vendorPosition(db, a.companyId, a.regime, a.vendorId, a.asOf, a.supplierIsIndividual);
  const customer = await customerPosition(db, a.companyId, a.regime, a.profile, a.asOf);
  const supplier: PartyTaxPosition = { ...vendor.position, ...(a.supplierOverride ?? {}) };
  if (a.supplierIsIndividual) supplier.isIndividual = true;
  const input: DeterminationInput = {
    ...a.base,
    regime: a.regime,
    supplier,
    customer: { ...customer, ...(a.customerOverride ?? {}) },
    asOf: a.asOf,
  };
  const output = determine(input);
  return { input, output, vendor };
}

/* ------------------------------------------------------------------ */
/* Signals — raised once per key                                       */
/* ------------------------------------------------------------------ */

export interface RaiseSignalArgs {
  companyId: string;
  projectId: string | null;
  detector: TaxRiskDetector;
  /** idempotency key stored in evidenceRefs.key */
  key: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  confidence: number;
  title: string;
  explanation: string;
  evidenceRefs: Record<string, unknown>;
}

const OPEN_DISPOSITIONS = ["new", "under_review", "confirmed", "escalated"];

async function existingSignal(
  db: Db,
  companyId: string,
  projectId: string | null,
  detector: string,
  key: string,
): Promise<{ id: string; disposition: string } | null> {
  const rows = await db
    .select({ id: signals.id, refs: signals.evidenceRefs, disposition: signals.disposition })
    .from(signals)
    .where(
      and(
        eq(signals.companyId, companyId),
        projectId ? eq(signals.projectId, projectId) : isNull(signals.projectId),
        eq(signals.detector, detector),
      ),
    );
  for (const r of rows) {
    const refs = r.refs as { key?: unknown } | null;
    if (refs && refs.key === key) return { id: r.id, disposition: r.disposition };
  }
  return null;
}

/** Raise a signal unless one with the same key already exists (any disposition). */
export async function raiseSignalOnce(
  db: Db,
  a: RaiseSignalArgs,
): Promise<{ raised: boolean; signalId: string }> {
  const existing = await existingSignal(db, a.companyId, a.projectId, a.detector, a.key);
  if (existing) return { raised: false, signalId: existing.id };
  const id = newId("sig");
  await db.insert(signals).values({
    id,
    companyId: a.companyId,
    projectId: a.projectId,
    detector: a.detector,
    severity: a.severity,
    confidence: a.confidence,
    title: a.title,
    explanation: a.explanation,
    evidenceRefs: { key: a.key, ...a.evidenceRefs },
  });
  return { raised: true, signalId: id };
}

/** Close an open signal by key when the condition has cleared (auto-resolution). */
export async function closeSignalByKey(
  db: Db,
  companyId: string,
  projectId: string | null,
  detector: TaxRiskDetector,
  key: string,
  note: string,
): Promise<boolean> {
  const existing = await existingSignal(db, companyId, projectId, detector, key);
  if (!existing || !OPEN_DISPOSITIONS.includes(existing.disposition)) return false;
  await db
    .update(signals)
    .set({ disposition: "closed", reviewerNotes: note })
    .where(eq(signals.id, existing.id));
  return true;
}

/* ------------------------------------------------------------------ */
/* Period aggregates                                                   */
/* ------------------------------------------------------------------ */

export interface PeriodAggregates {
  outputTax: number | null;
  inputTax: number | null;
  selfAccountedTax: number | null;
  withheldTotal: number | null;
  netPayable: number | null;
  determinationCount: number;
  certificateCount: number;
  excludedCount: number;
  computeBasis: Record<string, unknown>;
}

const SCHEME_FOR_KIND: Record<string, string[]> = {
  cis_monthly: ["cis"],
  rct_monthly: ["rct"],
  wht: ["wht", "backup", "custom"],
  tds: ["tds"],
  other: ["cis", "rct", "wht", "backup", "custom", "tds"],
};

/**
 * Aggregate a period from the determinations and certificates inside it.
 * Bucketed strictly by the period's currency: anything else is counted as
 * excluded and named in the basis — never converted, never summed across.
 */
export async function computePeriodAggregates(db: Db, period: PeriodRow): Promise<PeriodAggregates> {
  const kind = period.returnKind as TaxReturnKind;
  const basis: Record<string, unknown> = {
    window: { from: period.periodStart, to: period.periodEnd },
    currency: period.currency,
    method: kind === "vat" ? "output_minus_input" : "withheld_total",
  };

  if (kind === "vat") {
    const dets = await db
      .select({
        currency: taxDeterminations.currency,
        vatAmount: taxDeterminations.vatAmount,
        selfAccountedVat: taxDeterminations.selfAccountedVat,
        reverseCharge: taxDeterminations.reverseCharge,
      })
      .from(taxDeterminations)
      .where(
        and(
          eq(taxDeterminations.companyId, period.companyId),
          eq(taxDeterminations.projectId, period.projectId),
          eq(taxDeterminations.status, "determined"),
          eq(taxDeterminations.regime, period.regime),
          ne(taxDeterminations.sourceType, "manual"),
          gte(taxDeterminations.taxPointDate, period.periodStart),
          lte(taxDeterminations.taxPointDate, period.periodEnd),
        ),
      );
    let excluded = 0;
    let input = 0;
    let self = 0;
    let n = 0;
    for (const d of dets) {
      if (d.currency !== period.currency) {
        excluded += 1;
        continue;
      }
      n += 1;
      input += d.vatAmount + d.selfAccountedVat;
      self += d.selfAccountedVat;
    }
    // Output tax: VAT we charged on our own owner billings in the window,
    // plus what we self-account under reverse charges.
    const sales = await db
      .select({ currency: invoices.currency, taxAmount: invoices.taxAmount, status: invoices.status })
      .from(invoices)
      .where(
        and(
          eq(invoices.companyId, period.companyId),
          eq(invoices.projectId, period.projectId),
          eq(invoices.kind, "owner_billing"),
          gte(invoices.billingDate, period.periodStart),
          lte(invoices.billingDate, period.periodEnd),
        ),
      );
    let salesVat = 0;
    let salesCount = 0;
    for (const s of sales) {
      if (s.status === "draft" || s.status === "void") continue;
      if (s.currency !== period.currency) {
        excluded += 1;
        continue;
      }
      salesCount += 1;
      salesVat += s.taxAmount;
    }
    const outputTax = round2(salesVat + self);
    const inputTax = round2(input);
    basis["ownerBillings"] = salesCount;
    basis["inputTaxAssumesFullRecovery"] = true;
    basis["note"] =
      "Input tax = supplier VAT charged + self-accounted reverse-charge VAT on determinations whose tax point falls in the window (full recovery assumed); output tax = VAT on owner billings dated in the window + self-accounted reverse-charge VAT. Manual what-if determinations are excluded.";
    return {
      outputTax,
      inputTax,
      selfAccountedTax: round2(self),
      withheldTotal: null,
      netPayable: round2(outputTax - inputTax),
      determinationCount: n,
      certificateCount: 0,
      excludedCount: excluded,
      computeBasis: basis,
    };
  }

  const schemes = SCHEME_FOR_KIND[kind] ?? SCHEME_FOR_KIND["other"]!;
  const certs = await db
    .select({
      currency: withholdingCertificates.currency,
      withheldAmount: withholdingCertificates.withheldAmount,
      scheme: withholdingCertificates.scheme,
    })
    .from(withholdingCertificates)
    .where(
      and(
        eq(withholdingCertificates.companyId, period.companyId),
        eq(withholdingCertificates.projectId, period.projectId),
        eq(withholdingCertificates.status, "issued"),
        eq(withholdingCertificates.regime, period.regime),
        inArray(withholdingCertificates.scheme, schemes),
        gte(withholdingCertificates.paymentDate, period.periodStart),
        lte(withholdingCertificates.paymentDate, period.periodEnd),
      ),
    );
  let excluded = 0;
  let withheld = 0;
  let n = 0;
  for (const c of certs) {
    if (c.currency !== period.currency) {
      excluded += 1;
      continue;
    }
    n += 1;
    withheld += c.withheldAmount;
  }
  basis["schemes"] = schemes;
  basis["note"] = "Withheld total = issued withholding certificates with a payment date inside the window.";
  return {
    outputTax: null,
    inputTax: null,
    selfAccountedTax: null,
    withheldTotal: round2(withheld),
    netPayable: round2(withheld),
    determinationCount: 0,
    certificateCount: n,
    excludedCount: excluded,
    computeBasis: basis,
  };
}

/* ------------------------------------------------------------------ */
/* PE exposure recompute                                               */
/* ------------------------------------------------------------------ */

export interface ExposureRecompute {
  row: ExposureRow;
  previousStatus: PeExposureStatus;
  signalRaised: boolean;
}

export async function recomputeExposure(db: Db, exposure: ExposureRow, asOf: string): Promise<ExposureRecompute> {
  const entries = await db
    .select({ startDate: pePresenceEntries.startDate, endDate: pePresenceEntries.endDate })
    .from(pePresenceEntries)
    .where(eq(pePresenceEntries.exposureId, exposure.id));
  const summary = summarisePresence(entries, asOf, exposure.windowMonths);
  const previous = exposure.status as PeExposureStatus;
  const status = classifyExposure(summary.daysInWindow, exposure.thresholdDays, exposure.warnFraction, previous);
  const projected = projectBreachDate(summary, exposure.thresholdDays, asOf);
  await db
    .update(peExposures)
    .set({
      daysInWindow: summary.daysInWindow,
      daysTotal: summary.daysTotal,
      firstPresenceDate: summary.firstPresenceDate,
      lastPresenceDate: summary.lastPresenceDate,
      projectedBreachDate: projected,
      status,
      lastComputedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(peExposures.id, exposure.id));

  let signalRaised = false;
  if (status === "approaching" || status === "breached") {
    const severity = status === "breached" ? "critical" : "high";
    const res = await raiseSignalOnce(db, {
      companyId: exposure.companyId,
      projectId: exposure.projectId,
      detector: "tax_pe_threshold",
      key: `pe:${exposure.id}:${status}`,
      severity,
      confidence: 1,
      title:
        status === "breached"
          ? `Permanent establishment threshold reached — ${exposure.entityName} in ${exposure.hostCountry}`
          : `Permanent establishment threshold approaching — ${exposure.entityName} in ${exposure.hostCountry}`,
      explanation:
        `${exposure.entityName} (${exposure.entityType}, home ${exposure.homeCountry}) has ${summary.daysInWindow} presence days in ${exposure.hostCountry} ` +
        `${exposure.windowMonths > 0 ? `in the ${exposure.windowMonths}-month window ending ${asOf}` : "over the project"} against a threshold of ${exposure.thresholdDays} days. ` +
        `Basis: ${exposure.thresholdBasis}. ` +
        (projected ? `At the current run-rate the threshold is crossed on ${projected}. ` : "") +
        (status === "breached"
          ? "A taxable presence is likely: obtain advice on registration, profit attribution and payroll withholding in the host country."
          : "Plan rotations or a structure review before the threshold is crossed."),
      evidenceRefs: {
        exposureId: exposure.id,
        daysInWindow: summary.daysInWindow,
        thresholdDays: exposure.thresholdDays,
        projectedBreachDate: projected,
      },
    });
    signalRaised = res.raised;
  }
  const [row] = await db.select().from(peExposures).where(eq(peExposures.id, exposure.id)).limit(1);
  return { row: row!, previousStatus: previous, signalRaised };
}

/* ------------------------------------------------------------------ */
/* Obligations                                                         */
/* ------------------------------------------------------------------ */

export async function setObligationStatus(
  db: Db,
  obligationId: string | null,
  from: string,
  to: string,
): Promise<void> {
  if (!obligationId) return;
  await db
    .update(obligations)
    .set({ status: to })
    .where(and(eq(obligations.id, obligationId), eq(obligations.status, from)));
}
