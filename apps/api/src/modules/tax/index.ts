import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, ne, or } from "drizzle-orm";
import { z } from "zod";
import {
  commitments,
  invoiceLineItems,
  invoices,
  obligations,
  peExposures,
  pePresenceEntries,
  signals,
  taxDeterminations,
  taxPeriods,
  taxProjectProfiles,
  taxRegistrations,
  vendors,
  withholdingCertificates,
} from "@constructos/db";
import {
  PE_ENTITY_TYPES,
  PE_EXPOSURE_STATUSES,
  PE_PRESENCE_SOURCES,
  TAX_CERTIFICATE_STATUSES,
  TAX_CONTRACT_TYPES,
  TAX_DETERMINATION_SOURCES,
  TAX_DETERMINATION_STATUSES,
  TAX_HOLDER_TYPES,
  TAX_PERIOD_STATUSES,
  TAX_REGIMES,
  TAX_REGISTRATION_KINDS,
  TAX_REGISTRATION_STATUSES,
  TAX_RETURN_KINDS,
  TAX_RISK_DETECTORS,
  TAX_SUPPLY_TYPES,
  TAX_VAT_TREATMENTS,
  TAX_VERIFICATION_STATUSES,
  TAX_WITHHOLDING_BASES,
  TAX_WITHHOLDING_SCHEMES,
  type TaxRegime,
  type TaxReturnKind,
  type TaxSupplyType,
  type TaxWithholdingBase,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { addDaysISO, isoDateSchema, todayISO } from "../field/dates.js";
import { pushNotifications } from "../notifications/service.js";
import { determine, DeterminationError, type DeterminationInput, type DeterminationOutput } from "./determine.js";
import { companyTaxGate } from "./gates.js";
import { addMonthsISO, daysInclusive } from "./pe.js";
import {
  countryCodeFor,
  findReturnDef,
  findTaxRegime,
  summariseRegime,
  TAX_REGIME_LIBRARY,
} from "./regimes.js";
import {
  computePeriodAggregates,
  customerPosition,
  persistDetermination,
  raiseSignalOnce,
  recomputeExposure,
  resolveRegime,
  round2,
  runDetermination,
  setObligationStatus,
  vendorPosition,
  type DeterminationRow,
} from "./service.js";
import { registerTaxJobs, runTaxRiskSweep, sweepPeExposures } from "./sweeps.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const isoTimestamp = z
  .string()
  .min(4)
  .refine((s) => !Number.isNaN(Date.parse(s)), "invalid ISO timestamp");

const countryCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, "Expected an ISO-3166 alpha-2 country code")
  .transform((c) => c.toUpperCase());

const currencyCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, "Expected a 3-letter ISO 4217 currency code")
  .transform((c) => c.toUpperCase());

const profileSchema = z.object({
  regime: z.enum(TAX_REGIMES),
  placeOfSupplyCountry: countryCode.nullable().optional(),
  customerVatRegistered: z.boolean().optional(),
  customerDeductionRegistered: z.boolean().optional(),
  endUser: z.boolean().optional(),
  defaultSupplyType: z.enum(TAX_SUPPLY_TYPES).optional(),
  defaultContractType: z.enum(TAX_CONTRACT_TYPES).optional(),
  currency: currencyCode.optional(),
  customRules: z.record(z.string(), z.unknown()).optional(),
  notes: z.string().max(20000).nullable().optional(),
});

const registrationCreateSchema = z.object({
  holderType: z.enum(TAX_HOLDER_TYPES),
  holderId: z.string().min(1).nullable().optional(),
  holderName: z.string().min(1).max(300).optional(),
  regime: z.enum(TAX_REGIMES),
  kind: z.enum(TAX_REGISTRATION_KINDS),
  number: z.string().max(100).nullable().optional(),
  status: z.enum(TAX_REGISTRATION_STATUSES).optional(),
  deductionRate: z.number().min(0).max(100).nullable().optional(),
  validFrom: isoDateSchema.nullable().optional(),
  validTo: isoDateSchema.nullable().optional(),
  country: countryCode.nullable().optional(),
  notes: z.string().max(20000).nullable().optional(),
});

const registrationPatchSchema = z.object({
  holderName: z.string().min(1).max(300).optional(),
  number: z.string().max(100).nullable().optional(),
  status: z.enum(TAX_REGISTRATION_STATUSES).optional(),
  validFrom: isoDateSchema.nullable().optional(),
  validTo: isoDateSchema.nullable().optional(),
  country: countryCode.nullable().optional(),
  notes: z.string().max(20000).nullable().optional(),
});

const registrationListQuery = pageQuerySchema.extend({
  holderType: z.enum(TAX_HOLDER_TYPES).optional(),
  holderId: z.string().min(1).optional(),
  regime: z.enum(TAX_REGIMES).optional(),
  kind: z.enum(TAX_REGISTRATION_KINDS).optional(),
  status: z.enum(TAX_REGISTRATION_STATUSES).optional(),
  verificationStatus: z.enum(TAX_VERIFICATION_STATUSES).optional(),
  search: z.string().max(200).optional(),
});

const verifySchema = z.object({
  outcome: z.enum(["verified", "failed"]),
  reference: z.string().max(300).nullable().optional(),
  /** authority-assigned deduction rate returned by the verification (CIS/RCT) */
  deductionRate: z.number().min(0).max(100).nullable().optional(),
  verifiedAt: isoTimestamp.optional(),
});

const partyOverrideSchema = z
  .object({
    country: countryCode.nullable().optional(),
    vatRegistered: z.boolean().nullable().optional(),
    deductionRegistered: z.boolean().nullable().optional(),
    deductionVerified: z.boolean().nullable().optional(),
    deductionRate: z.number().min(0).max(100).nullable().optional(),
    tinOnFile: z.boolean().nullable().optional(),
    isIndividual: z.boolean().optional(),
    endUser: z.boolean().optional(),
  })
  .strict();

const customRulesSchema = z.object({
  vatRate: z.number().min(0).max(100).nullable().optional(),
  vatTreatment: z.enum(TAX_VAT_TREATMENTS).nullable().optional(),
  reverseCharge: z.boolean().nullable().optional(),
  withholdingRate: z.number().min(0).max(100).nullable().optional(),
  withholdingBase: z.enum(TAX_WITHHOLDING_BASES).nullable().optional(),
  citation: z.string().max(1000).nullable().optional(),
});

const determineSchema = z.object({
  regime: z.enum(TAX_REGIMES).optional(),
  supplyType: z.enum(TAX_SUPPLY_TYPES).optional(),
  contractType: z.enum(TAX_CONTRACT_TYPES).optional(),
  amount: z.number().finite().nonnegative(),
  currency: currencyCode.optional(),
  materialsAmount: z.number().finite().nonnegative().optional(),
  placeOfSupplyCountry: countryCode.nullable().optional(),
  vendorId: z.string().min(1).nullable().optional(),
  supplierIsIndividual: z.boolean().optional(),
  supplier: partyOverrideSchema.optional(),
  customer: partyOverrideSchema.optional(),
  rateKey: z.string().max(60).nullable().optional(),
  treaty: z.object({ rate: z.number().min(0).max(100), reference: z.string().max(500) }).nullable().optional(),
  custom: customRulesSchema.nullable().optional(),
  persist: z.boolean().optional(),
  sourceType: z.enum(TAX_DETERMINATION_SOURCES).optional(),
  sourceId: z.string().min(1).nullable().optional(),
  sourceLineId: z.string().min(1).nullable().optional(),
  asOf: isoDateSchema.optional(),
});

const determinationListQuery = pageQuerySchema.extend({
  status: z.enum(TAX_DETERMINATION_STATUSES).optional(),
  vendorId: z.string().min(1).optional(),
  sourceType: z.enum(TAX_DETERMINATION_SOURCES).optional(),
  sourceId: z.string().min(1).optional(),
  regime: z.enum(TAX_REGIMES).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  includeSuperseded: z.enum(["true", "false"]).optional(),
});

const overrideSchema = z.object({
  vatTreatment: z.enum(TAX_VAT_TREATMENTS).optional(),
  vatRate: z.number().min(0).max(100).optional(),
  reverseCharge: z.boolean().optional(),
  withholdingScheme: z.enum(TAX_WITHHOLDING_SCHEMES).optional(),
  withholdingRate: z.number().min(0).max(100).optional(),
  withholdingBase: z.enum(TAX_WITHHOLDING_BASES).optional(),
  reason: z.string().min(10).max(4000),
  citation: z.string().max(1000).nullable().optional(),
});

const certificateCreateSchema = z.object({
  determinationId: z.string().min(1).nullable().optional(),
  paymentId: z.string().min(1).nullable().optional(),
  invoiceId: z.string().min(1).nullable().optional(),
  vendorId: z.string().min(1).nullable().optional(),
  vendorName: z.string().min(1).max(300).optional(),
  regime: z.enum(TAX_REGIMES).optional(),
  scheme: z.enum(TAX_WITHHOLDING_SCHEMES).optional(),
  paymentDate: isoDateSchema,
  currency: currencyCode.optional(),
  grossAmount: z.number().finite().nonnegative().optional(),
  materialsAmount: z.number().finite().nonnegative().optional(),
  /** what the rate applies to; defaults to the determination's, else the scheme's */
  withholdingBase: z.enum(TAX_WITHHOLDING_BASES).optional(),
  rate: z.number().min(0).max(100).optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const certificateListQuery = pageQuerySchema.extend({
  status: z.enum(TAX_CERTIFICATE_STATUSES).optional(),
  vendorId: z.string().min(1).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

const reasonSchema = z.object({ reason: z.string().min(1).max(4000) });

const periodCreateSchema = z.object({
  regime: z.enum(TAX_REGIMES).optional(),
  returnKind: z.enum(TAX_RETURN_KINDS),
  periodStart: isoDateSchema,
  periodEnd: isoDateSchema.optional(),
  dueDate: isoDateSchema.optional(),
  paymentDueDate: isoDateSchema.nullable().optional(),
  currency: currencyCode.optional(),
  notes: z.string().max(20000).nullable().optional(),
});

const periodListQuery = pageQuerySchema.extend({
  status: z.enum(TAX_PERIOD_STATUSES).optional(),
  returnKind: z.enum(TAX_RETURN_KINDS).optional(),
});

const fileSchema = z.object({
  filingReference: z.string().min(1).max(300),
  filedAt: isoTimestamp.optional(),
  notes: z.string().max(20000).nullable().optional(),
});

const paidSchema = z.object({ paidAt: isoTimestamp.optional() });

const exposureCreateSchema = z.object({
  entityType: z.enum(PE_ENTITY_TYPES),
  entityId: z.string().min(1).nullable().optional(),
  entityName: z.string().min(1).max(300),
  homeCountry: countryCode,
  hostCountry: countryCode.optional(),
  regime: z.enum(TAX_REGIMES).optional(),
  thresholdDays: z.number().int().positive().max(3650).optional(),
  thresholdBasis: z.string().max(2000).optional(),
  windowMonths: z.number().int().min(0).max(120).optional(),
  warnFraction: z.number().min(0.1).max(1).optional(),
  notes: z.string().max(20000).nullable().optional(),
});

const exposurePatchSchema = z.object({
  entityName: z.string().min(1).max(300).optional(),
  thresholdDays: z.number().int().positive().max(3650).optional(),
  thresholdBasis: z.string().min(1).max(2000).optional(),
  windowMonths: z.number().int().min(0).max(120).optional(),
  warnFraction: z.number().min(0.1).max(1).optional(),
  notes: z.string().max(20000).nullable().optional(),
});

const exposureListQuery = pageQuerySchema.extend({
  status: z.enum(PE_EXPOSURE_STATUSES).optional(),
});

const presenceEntrySchema = z.object({
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  purpose: z.string().max(500).nullable().optional(),
  source: z.enum(PE_PRESENCE_SOURCES).optional(),
  sourceRef: z.string().max(300).nullable().optional(),
});

const mitigateSchema = z.object({ note: z.string().min(5).max(4000) });

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const OPEN_SIGNAL_DISPOSITIONS = ["new", "under_review", "confirmed", "escalated"];

/** Postgres unique_violation — the constraint decided, not our read-then-write. */
function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "23505" || (typeof code === "string" && code === "23505");
}

/**
 * What the withholding rate applies to when no determination produced the
 * figures. CIS and RCT deduct on the amount net of materials (#802): taking
 * the gross would over-withhold from the payee on every hand-recorded
 * statement.
 */
function baseForScheme(regime: TaxRegime, scheme: string): TaxWithholdingBase {
  const rd = findTaxRegime(regime)?.withholding;
  if (rd?.scheme === scheme && rd.registrationDriven) return rd.registrationDriven.base;
  return scheme === "cis" || scheme === "rct" ? "gross_excl_materials" : "gross_excl_vat";
}

function serialiseDetermination(row: DeterminationRow) {
  return { ...row, reverseCharge: row.reverseCharge === 1 };
}

/** Invoice line source → the supply type the engine reasons about. */
function supplyTypeForLine(source: string, fallback: TaxSupplyType): TaxSupplyType | null {
  switch (source) {
    case "stored_materials":
      return "materials_only";
    case "tax":
    case "credit":
      return null; // not a supply
    case "allowance":
    case "retainage_release":
    case "change_order":
    case "contract_sov":
    case "other":
    default:
      return fallback;
  }
}

/**
 * Tax & statutory deduction — spec Vol II Domain Q (#798–806, #816–820):
 * code-resident regime library, the determination engine with rule
 * citations, registrations with verification, the determinations register
 * with human overrides that never edit history, withholding certificates per
 * payment, tax periods/returns whose due dates are assurance Obligations, the
 * permanent-establishment exposure register, and the risk sweeps that raise
 * assurance Signals (missing registration, WHT not deducted, reverse charge
 * misapplied, return overdue, verification lapsed).
 *
 * Deliberately not here: payroll tax and certified payroll (#808–811, the
 * timecards module), transfer pricing documentation (#812–813), customs
 * allocation (#814, noted on imported goods), stamp duty (#815), industry
 * training levies such as CITB (#817 — an annual levy on payroll and net CIS
 * payments, not a per-supply tax; it belongs with payroll) and tax-audit
 * evidence assembly (#820 — the determinations, certificates and periods
 * carry everything a pack needs, but no assembler is built).
 */
export const taxModule: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("tax", "read")];
  const standardGate = [app.authenticate, app.requireCompany, app.requireTool("tax", "standard")];
  // Company-level tax routes carry the same tool at the same level, resolved
  // across the caller's projects (gates.ts) — `requireTool` needs a
  // `:projectId` and there is none above the projects.
  const companyReadGate = [app.authenticate, app.requireCompany, companyTaxGate(app, "read")];
  const companyWriteGate = [app.authenticate, app.requireCompany, companyTaxGate(app, "standard")];
  const companyAdminGate = [
    app.authenticate,
    app.requireCompany,
    app.requireCompanyRole(["owner", "admin"]),
  ];

  registerTaxJobs(app);

  /* ================================================================ */
  /* Regime library (reference data, not tenant data)                  */
  /* ================================================================ */

  app.get("/tax/regimes", { preHandler: [app.authenticate] }, async () => ({
    items: TAX_REGIME_LIBRARY.map(summariseRegime),
    total: TAX_REGIME_LIBRARY.length,
  }));

  app.get("/tax/regimes/:regime", { preHandler: [app.authenticate] }, async (req) => {
    const { regime } = req.params as { regime: string };
    const def = findTaxRegime(regime);
    if (!def) throw notFound("Unknown tax regime");
    return def;
  });

  /* ================================================================ */
  /* Registrations (company-level: the tenant, its vendors, entities)  */
  /* ================================================================ */

  async function fetchRegistration(id: string, companyId: string) {
    const [row] = await app.db
      .select()
      .from(taxRegistrations)
      .where(and(eq(taxRegistrations.id, id), eq(taxRegistrations.companyId, companyId)))
      .limit(1);
    if (!row) throw notFound("Tax registration not found");
    return row;
  }

  async function holderName(
    companyId: string,
    holderType: string,
    holderId: string | null,
    given: string | undefined,
  ): Promise<string> {
    if (given) return given;
    if (holderType === "company") return "This company";
    if (holderType === "vendor" && holderId) {
      const [v] = await app.db
        .select({ name: vendors.name })
        .from(vendors)
        .where(and(eq(vendors.id, holderId), eq(vendors.companyId, companyId)))
        .limit(1);
      if (!v) throw badRequest("holderId does not name a vendor in this company");
      return v.name;
    }
    throw badRequest("holderName is required for this holder");
  }

  app.get("/tax/registrations", { preHandler: companyReadGate }, async (req) => {
    const q = registrationListQuery.parse(req.query);
    const clauses = [eq(taxRegistrations.companyId, req.companyId!)];
    if (q.holderType) clauses.push(eq(taxRegistrations.holderType, q.holderType));
    if (q.holderId) clauses.push(eq(taxRegistrations.holderId, q.holderId));
    if (q.regime) clauses.push(eq(taxRegistrations.regime, q.regime));
    if (q.kind) clauses.push(eq(taxRegistrations.kind, q.kind));
    if (q.status) clauses.push(eq(taxRegistrations.status, q.status));
    if (q.verificationStatus) clauses.push(eq(taxRegistrations.verificationStatus, q.verificationStatus));
    if (q.search) clauses.push(ilike(taxRegistrations.holderName, `%${q.search}%`));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(taxRegistrations).where(where);
    const items = await app.db
      .select()
      .from(taxRegistrations)
      .where(where)
      .orderBy(asc(taxRegistrations.holderName), asc(taxRegistrations.kind))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.post("/tax/registrations", { preHandler: companyWriteGate }, async (req, reply) => {
    const body = registrationCreateSchema.parse(req.body);
    if (body.holderType !== "company" && !body.holderId) {
      throw badRequest("holderId is required for a vendor or entity registration");
    }
    if (body.validFrom && body.validTo && body.validTo < body.validFrom) {
      throw badRequest("validTo must not precede validFrom");
    }
    const holderId = body.holderType === "company" ? null : (body.holderId ?? null);
    const name = await holderName(req.companyId!, body.holderType, holderId, body.holderName);
    const id = newId("txr");
    await app.db.insert(taxRegistrations).values({
      id,
      companyId: req.companyId!,
      holderType: body.holderType,
      holderId,
      holderName: name,
      regime: body.regime,
      kind: body.kind,
      number: body.number ?? null,
      status: body.status ?? "active",
      deductionRate: body.deductionRate ?? null,
      validFrom: body.validFrom ?? null,
      validTo: body.validTo ?? null,
      country: body.country ?? findTaxRegime(body.regime)?.countryCode ?? null,
      notes: body.notes ?? null,
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "tax_registration",
      objectId: id,
      payload: { holderType: body.holderType, holderId, regime: body.regime, kind: body.kind, number: body.number ?? null },
      storePayload: true,
    });
    return reply.status(201).send(await fetchRegistration(id, req.companyId!));
  });

  app.get("/tax/registrations/:registrationId", { preHandler: companyReadGate }, async (req) => {
    const { registrationId } = req.params as { registrationId: string };
    const row = await fetchRegistration(registrationId, req.companyId!);
    return { ...row, regimeDef: findTaxRegime(row.regime) ? summariseRegime(findTaxRegime(row.regime)!) : null };
  });

  app.patch("/tax/registrations/:registrationId", { preHandler: companyWriteGate }, async (req) => {
    const { registrationId } = req.params as { registrationId: string };
    const body = registrationPatchSchema.parse(req.body);
    const row = await fetchRegistration(registrationId, req.companyId!);
    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    for (const [k, v] of Object.entries(body)) if (v !== undefined) set[k] = v;
    // A changed number invalidates the verification: what was checked is no longer what is on file.
    if (body.number !== undefined && body.number !== row.number && row.verificationStatus === "verified") {
      set["verificationStatus"] = "unverified";
      set["deductionRate"] = null;
    }
    await app.db.update(taxRegistrations).set(set).where(eq(taxRegistrations.id, registrationId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "tax_registration",
      objectId: registrationId,
      payload: { changed: Object.keys(body), verificationReset: set["verificationStatus"] === "unverified" },
    });
    return fetchRegistration(registrationId, req.companyId!);
  });

  /**
   * Verification with the authority (#801). The verifier must be a different
   * person from whoever recorded the registration: the claim and the check
   * are not authored through the same pathway.
   */
  app.post("/tax/registrations/:registrationId/verify", { preHandler: companyWriteGate }, async (req) => {
    const { registrationId } = req.params as { registrationId: string };
    const body = verifySchema.parse(req.body);
    const row = await fetchRegistration(registrationId, req.companyId!);
    if (row.createdBy === req.user!.id) {
      throw forbidden("The person who recorded a registration cannot verify it; a different user must confirm it with the authority");
    }
    const verifiedAt = body.verifiedAt ?? new Date().toISOString();
    const kindNeedsRate = row.kind === "cis" || row.kind === "rct";
    if (body.outcome === "verified" && kindNeedsRate && body.deductionRate === undefined) {
      throw badRequest("A verified CIS/RCT registration must record the deduction rate the authority returned");
    }
    await app.db
      .update(taxRegistrations)
      .set({
        verificationStatus: body.outcome,
        verifiedAt,
        verifiedBy: req.user!.id,
        verificationReference: body.reference ?? null,
        deductionRate: body.outcome === "verified" ? (body.deductionRate ?? row.deductionRate) : row.deductionRate,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(taxRegistrations.id, registrationId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "tax_registration",
      objectId: registrationId,
      payload: {
        verificationStatus: { from: row.verificationStatus, to: body.outcome },
        reference: body.reference ?? null,
        deductionRate: body.deductionRate ?? null,
        verifiedAt,
      },
      storePayload: true,
    });
    return fetchRegistration(registrationId, req.companyId!);
  });

  app.delete("/tax/registrations/:registrationId", { preHandler: companyAdminGate }, async (req, reply) => {
    const { registrationId } = req.params as { registrationId: string };
    const row = await fetchRegistration(registrationId, req.companyId!);
    await app.db.delete(taxRegistrations).where(eq(taxRegistrations.id, registrationId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "tax_registration",
      objectId: registrationId,
      payload: { holderType: row.holderType, holderId: row.holderId, regime: row.regime, kind: row.kind },
      storePayload: true,
    });
    return reply.status(204).send();
  });

  /* ================================================================ */
  /* Project tax profile                                               */
  /* ================================================================ */

  app.get("/projects/:projectId/tax/profile", { preHandler: readGate }, async (req) => {
    const res = await resolveRegime(app.db, req.companyId!, req.projectId!);
    const def = res.regime ? findTaxRegime(res.regime) : undefined;
    const customer = res.regime
      ? await customerPosition(app.db, req.companyId!, res.regime, res.profile, todayISO())
      : null;
    return {
      profile: res.profile,
      resolved: { regime: res.regime, source: res.source, reasons: res.reasons },
      project: res.project,
      regimeDef: def ? summariseRegime(def) : null,
      customerPosition: customer,
    };
  });

  app.put("/projects/:projectId/tax/profile", { preHandler: standardGate }, async (req) => {
    const body = profileSchema.parse(req.body);
    const def = findTaxRegime(body.regime)!;
    const [existing] = await app.db
      .select()
      .from(taxProjectProfiles)
      .where(and(eq(taxProjectProfiles.companyId, req.companyId!), eq(taxProjectProfiles.projectId, req.projectId!)))
      .limit(1);
    const values = {
      regime: body.regime,
      placeOfSupplyCountry: body.placeOfSupplyCountry ?? (def.countryCode || null),
      customerVatRegistered: body.customerVatRegistered ? 1 : 0,
      customerDeductionRegistered: body.customerDeductionRegistered ? 1 : 0,
      endUser: body.endUser ? 1 : 0,
      defaultSupplyType: body.defaultSupplyType ?? "construction_services",
      defaultContractType: body.defaultContractType ?? "subcontract",
      currency: body.currency ?? (def.currency || "USD"),
      customRules: body.customRules ?? {},
      notes: body.notes ?? null,
      updatedAt: new Date().toISOString(),
    };
    let id: string;
    if (existing) {
      id = existing.id;
      await app.db.update(taxProjectProfiles).set(values).where(eq(taxProjectProfiles.id, id));
    } else {
      id = newId("txp");
      await app.db.insert(taxProjectProfiles).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        createdBy: req.user!.id,
        ...values,
      });
    }
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: existing ? "update" : "create",
      objectType: "tax_project_profile",
      objectId: id,
      payload: { ...values, updatedAt: undefined },
      projectId: req.projectId!,
      storePayload: true,
    });
    const res = await resolveRegime(app.db, req.companyId!, req.projectId!);
    return {
      profile: res.profile,
      resolved: { regime: res.regime, source: res.source, reasons: res.reasons },
      project: res.project,
      regimeDef: summariseRegime(def),
      customerPosition: await customerPosition(app.db, req.companyId!, body.regime, res.profile, todayISO()),
    };
  });

  /* ================================================================ */
  /* Determination on demand (#798–802, #804–805)                     */
  /* ================================================================ */

  async function resolveOrThrow(companyId: string, projectId: string, explicit?: TaxRegime) {
    const res = await resolveRegime(app.db, companyId, projectId);
    const regime = explicit ?? res.regime;
    if (!regime) throw badRequest(res.reasons.join(" "));
    return { regime, res };
  }

  app.post("/projects/:projectId/tax/determine", { preHandler: standardGate }, async (req, reply) => {
    const body = determineSchema.parse(req.body);
    const { regime, res } = await resolveOrThrow(req.companyId!, req.projectId!, body.regime);
    const profile = res.profile;
    const def = findTaxRegime(regime)!;
    const asOf = body.asOf ?? todayISO();
    const supplierOverride = body.supplier ? { ...body.supplier } : null;
    const customerOverride = body.customer ? { ...body.customer } : null;
    let result;
    try {
      result = await runDetermination(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        regime,
        profile,
        vendorId: body.vendorId ?? null,
        supplierIsIndividual: body.supplierIsIndividual ?? false,
        asOf,
        base: {
          supplyType: body.supplyType ?? (profile?.defaultSupplyType as TaxSupplyType | undefined) ?? "construction_services",
          contractType: body.contractType ?? (profile?.defaultContractType as DeterminationInput["contractType"] | undefined) ?? "subcontract",
          amount: body.amount,
          currency: body.currency ?? profile?.currency ?? def.currency ?? "USD",
          materialsAmount: body.materialsAmount ?? 0,
          placeOfSupplyCountry: body.placeOfSupplyCountry ?? profile?.placeOfSupplyCountry ?? null,
          rateKey: body.rateKey ?? null,
          treaty: body.treaty ?? null,
          custom:
            body.custom ??
            (regime === "custom" && profile && Object.keys(profile.customRules).length > 0
              ? (profile.customRules as DeterminationInput["custom"])
              : null),
        },
        supplierOverride,
        customerOverride,
      });
    } catch (err) {
      if (err instanceof DeterminationError) throw badRequest(err.message);
      throw err;
    }
    let determination: DeterminationRow | null = null;
    if (body.persist) {
      // A persisted what-if is a MANUAL record. Accepting a caller-supplied
      // sourceType/sourceId here would let hand-typed figures supersede the
      // engine's determination for a real invoice line (persistDetermination
      // supersedes by source triple) with no override reason and no chain —
      // exactly what the override route at
      // POST …/determinations/:id/override exists to prevent (#802).
      if ((body.sourceType ?? "manual") !== "manual") {
        throw badRequest(
          "A persisted determination from this route is a manual record. Determine an invoice through " +
            "POST /projects/:projectId/tax/invoices/:invoiceId/determine, and change an existing one through " +
            "POST /projects/:projectId/tax/determinations/:determinationId/override so the reason and the chain are kept.",
        );
      }
      determination = await persistDetermination(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        input: result.input,
        output: result.output,
        sourceType: "manual",
        sourceId: body.sourceId ?? null,
        sourceLineId: body.sourceLineId ?? null,
        vendorId: result.vendor.vendor?.id ?? null,
        vendorName: result.vendor.vendor?.name ?? null,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "tax_determination",
        objectId: determination.id,
        payload: {
          number: determination.number,
          regime,
          amount: body.amount,
          currency: result.input.currency,
          vatTreatment: result.output.vatTreatment,
          withholdingAmount: result.output.withholdingAmount,
          netPayable: result.output.netPayable,
          confidence: result.output.confidence,
        },
        projectId: req.projectId!,
        storePayload: true,
      });
    }
    return reply.status(body.persist ? 201 : 200).send({
      regime,
      regimeSource: body.regime ? "explicit" : res.source,
      input: result.input,
      output: result.output,
      vendor: result.vendor.vendor,
      vendorRegistrations: result.vendor.registrations,
      determination: determination ? serialiseDetermination(determination) : null,
    });
  });

  /**
   * Bulk determination for an invoice: one determination per billable line,
   * superseding earlier runs for the same line, with the invoice's own tax
   * figure checked against what the rules say (#799 reverse charge
   * misapplied; #818 tax invoice compliance).
   */
  app.post(
    "/projects/:projectId/tax/invoices/:invoiceId/determine",
    { preHandler: standardGate },
    async (req) => {
      const { invoiceId } = req.params as { invoiceId: string };
      const [inv] = await app.db
        .select()
        .from(invoices)
        .where(
          and(
            eq(invoices.id, invoiceId),
            eq(invoices.companyId, req.companyId!),
            eq(invoices.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!inv) throw notFound("Invoice not found");
      if (inv.kind !== "subcontractor_invoice") {
        throw badRequest("Bulk determination applies to subcontractor invoices; owner billings are the tenant's own supply");
      }
      const { regime, res } = await resolveOrThrow(req.companyId!, req.projectId!);
      const profile = res.profile;
      const def = findTaxRegime(regime)!;
      let vendorId = inv.vendorId;
      let contractType: DeterminationInput["contractType"] =
        (profile?.defaultContractType as DeterminationInput["contractType"] | undefined) ?? "subcontract";
      if (inv.commitmentId) {
        const [c] = await app.db
          .select({ vendorId: commitments.vendorId, kind: commitments.kind })
          .from(commitments)
          .where(and(eq(commitments.id, inv.commitmentId), eq(commitments.companyId, req.companyId!)))
          .limit(1);
        if (c) {
          vendorId = vendorId ?? c.vendorId;
          if (c.kind === "purchase_order") contractType = "supply_only";
        }
      }
      const lines = await app.db
        .select()
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, invoiceId))
        .orderBy(asc(invoiceLineItems.sortOrder));
      const asOf = inv.billingDate ?? todayISO();
      const fallbackSupply = (profile?.defaultSupplyType as TaxSupplyType | undefined) ?? "construction_services";
      const results: Array<{
        lineId: string;
        lineNumber: string;
        description: string;
        amount: number;
        skipped: string | null;
        determinationId: string | null;
        output: DeterminationOutput | null;
      }> = [];
      const totals = { amount: 0, vatAmount: 0, selfAccountedVat: 0, withholdingAmount: 0, leviesAmount: 0, netPayable: 0 };
      let anyReverseCharge = false;
      let anyNotRegistered = false;
      let vendorName: string | null = null;
      let determined = 0;
      for (const line of lines) {
        const supplyType = supplyTypeForLine(line.source, fallbackSupply);
        if (!supplyType) {
          results.push({ lineId: line.id, lineNumber: line.lineNumber, description: line.description, amount: line.amount, skipped: `line source "${line.source}" is not a supply`, determinationId: null, output: null });
          continue;
        }
        if (!(line.amount > 0)) {
          results.push({ lineId: line.id, lineNumber: line.lineNumber, description: line.description, amount: line.amount, skipped: "nothing billed on this line", determinationId: null, output: null });
          continue;
        }
        const detailMaterials = Number((line.detail as Record<string, unknown>)["materialsAmount"]);
        const materialsAmount =
          supplyType === "materials_only"
            ? line.amount
            : Number.isFinite(detailMaterials) && detailMaterials >= 0
              ? Math.min(detailMaterials, line.amount)
              : 0;
        let run;
        try {
          run = await runDetermination(app.db, {
            companyId: req.companyId!,
            projectId: req.projectId!,
            regime,
            profile,
            vendorId,
            supplierIsIndividual: false,
            asOf,
            base: {
              supplyType,
              contractType: supplyType === "materials_only" ? "supply_only" : contractType,
              amount: round2(line.amount),
              currency: inv.currency,
              materialsAmount: round2(materialsAmount),
              placeOfSupplyCountry: profile?.placeOfSupplyCountry ?? null,
              rateKey: null,
              treaty: null,
              custom:
                regime === "custom" && profile && Object.keys(profile.customRules).length > 0
                  ? (profile.customRules as DeterminationInput["custom"])
                  : null,
            },
          });
        } catch (err) {
          if (err instanceof DeterminationError) throw badRequest(`Line ${line.lineNumber}: ${err.message}`);
          throw err;
        }
        vendorName = run.vendor.vendor?.name ?? vendorName;
        const row = await persistDetermination(app.db, {
          companyId: req.companyId!,
          projectId: req.projectId!,
          actorId: req.user!.id,
          input: run.input,
          output: run.output,
          sourceType: "invoice_line",
          sourceId: invoiceId,
          sourceLineId: line.id,
          vendorId: run.vendor.vendor?.id ?? vendorId ?? null,
          vendorName: run.vendor.vendor?.name ?? null,
        });
        determined += 1;
        const o = run.output;
        totals.amount += run.input.amount;
        totals.vatAmount += o.vatAmount;
        totals.selfAccountedVat += o.selfAccountedVat;
        totals.withholdingAmount += o.withholdingAmount;
        totals.leviesAmount += o.leviesAmount;
        totals.netPayable += o.netPayable;
        if (o.reverseCharge) anyReverseCharge = true;
        if (o.vatTreatment === "not_registered") anyNotRegistered = true;
        results.push({ lineId: line.id, lineNumber: line.lineNumber, description: line.description, amount: line.amount, skipped: null, determinationId: row.id, output: o });
      }
      for (const k of Object.keys(totals) as Array<keyof typeof totals>) totals[k] = round2(totals[k]);

      // Risk checks against what the invoice itself claims.
      const risks: Array<{ detector: string; severity: string; title: string; signalId: string; raised: boolean }> = [];
      const invoiceTax = round2(inv.taxAmount);
      // Tax on a reverse-charged invoice is only wrong when it exceeds what
      // the standard-rated lines (materials, say) may legitimately carry.
      if (anyReverseCharge && invoiceTax > totals.vatAmount + 0.005) {
        const r = await raiseSignalOnce(app.db, {
          companyId: req.companyId!,
          projectId: req.projectId!,
          detector: "tax_reverse_charge_misapplied",
          key: `rc_misapplied:${invoiceId}`,
          severity: "high",
          confidence: 0.9,
          title: `Reverse charge misapplied — invoice ${inv.reference} charges VAT on a reverse-charge supply`,
          explanation:
            `The determination for invoice ${inv.reference}${vendorName ? ` from ${vendorName}` : ""} concludes the supply is subject to the domestic reverse charge under ${def.name}, ` +
            `so the supplier must not charge VAT and the customer self-accounts; the invoice nevertheless shows ${inv.currency} ${invoiceTax.toFixed(2)} of tax against ${inv.currency} ${totals.vatAmount.toFixed(2)} allowable on its standard-rated lines. ` +
            `Paying that VAT loses input-tax recovery and leaves the customer still liable to self-account. Reject the invoice for re-issue (#799, #818).`,
          evidenceRefs: { invoiceId, invoiceTax, allowedVat: totals.vatAmount, vendorId, selfAccountedVat: totals.selfAccountedVat },
        });
        risks.push({ detector: "tax_reverse_charge_misapplied", severity: "high", title: "Reverse charge misapplied", ...r });
      }
      if (anyNotRegistered && invoiceTax > 0 && vendorId) {
        const r = await raiseSignalOnce(app.db, {
          companyId: req.companyId!,
          projectId: req.projectId!,
          detector: "tax_missing_registration",
          key: `missing_registration:${req.projectId!}:${vendorId}`,
          severity: "high",
          confidence: 0.9,
          title: `Invoice ${inv.reference} charges tax from a supplier with no registration on file`,
          explanation:
            `Invoice ${inv.reference}${vendorName ? ` from ${vendorName}` : ""} shows ${inv.currency} ${invoiceTax.toFixed(2)} of tax, but the supplier has no active ${def.indirectTax.name} registration recorded under ${def.name}. ` +
            `An unregistered supplier may not charge tax and the amount is not recoverable. Obtain and verify the registration or reject the invoice (#800–801, #818).`,
          evidenceRefs: { invoiceId, invoiceTax, vendorId },
        });
        risks.push({ detector: "tax_missing_registration", severity: "high", title: "Tax charged without a registration", ...r });
      }
      const vatMismatch = round2(invoiceTax - totals.vatAmount);
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "tax_determination_batch",
        objectId: invoiceId,
        payload: { invoiceId, regime, lines: lines.length, determined, totals, invoiceTax, vatMismatch, risks: risks.map((r) => r.detector) },
        projectId: req.projectId!,
        storePayload: true,
      });
      return {
        invoice: { id: inv.id, reference: inv.reference, currency: inv.currency, taxAmount: invoiceTax, subtotal: inv.subtotal, total: inv.total, vendorId },
        regime,
        lines: results,
        determined,
        skipped: results.filter((r) => r.skipped).length,
        totals,
        check: {
          invoiceTax,
          determinedVat: totals.vatAmount,
          mismatch: vatMismatch,
          note:
            Math.abs(vatMismatch) > 0.005
              ? `The invoice's tax figure differs from the determined VAT by ${inv.currency} ${vatMismatch.toFixed(2)}.`
              : "The invoice's tax figure agrees with the determination.",
        },
        risks,
      };
    },
  );

  /* ================================================================ */
  /* Determinations register                                           */
  /* ================================================================ */

  async function fetchDetermination(id: string, companyId: string, projectId: string) {
    const [row] = await app.db
      .select()
      .from(taxDeterminations)
      .where(
        and(
          eq(taxDeterminations.id, id),
          eq(taxDeterminations.companyId, companyId),
          eq(taxDeterminations.projectId, projectId),
        ),
      )
      .limit(1);
    if (!row) throw notFound("Tax determination not found");
    return row;
  }

  app.get("/projects/:projectId/tax/determinations", { preHandler: readGate }, async (req) => {
    const q = determinationListQuery.parse(req.query);
    const clauses = [
      eq(taxDeterminations.companyId, req.companyId!),
      eq(taxDeterminations.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(taxDeterminations.status, q.status));
    else if (q.includeSuperseded !== "true") clauses.push(ne(taxDeterminations.status, "superseded"));
    if (q.vendorId) clauses.push(eq(taxDeterminations.vendorId, q.vendorId));
    if (q.sourceType) clauses.push(eq(taxDeterminations.sourceType, q.sourceType));
    if (q.sourceId) clauses.push(eq(taxDeterminations.sourceId, q.sourceId));
    if (q.regime) clauses.push(eq(taxDeterminations.regime, q.regime));
    if (q.from) clauses.push(gte(taxDeterminations.taxPointDate, q.from));
    if (q.to) clauses.push(lte(taxDeterminations.taxPointDate, q.to));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(taxDeterminations).where(where);
    const rows = await app.db
      .select()
      .from(taxDeterminations)
      .where(where)
      .orderBy(desc(taxDeterminations.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows.map(serialiseDetermination), Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/tax/determinations/:determinationId", { preHandler: readGate }, async (req) => {
    const { determinationId } = req.params as { determinationId: string };
    const row = await fetchDetermination(determinationId, req.companyId!, req.projectId!);
    const related = [row.overriddenById, row.overridesId, row.supersededById].filter((x): x is string => Boolean(x));
    const chain = related.length
      ? await app.db
          .select({
            id: taxDeterminations.id,
            number: taxDeterminations.number,
            status: taxDeterminations.status,
            createdAt: taxDeterminations.createdAt,
            overrideReason: taxDeterminations.overrideReason,
            determinedBy: taxDeterminations.determinedBy,
          })
          .from(taxDeterminations)
          .where(and(eq(taxDeterminations.companyId, req.companyId!), inArray(taxDeterminations.id, related)))
      : [];
    const def = findTaxRegime(row.regime);
    return { ...serialiseDetermination(row), chain, regimeDef: def ? summariseRegime(def) : null };
  });

  /**
   * Human override (#802): never edits the engine's record. Writes a new
   * determination carrying the human figures and the stated reason, and
   * points the original at it.
   */
  app.post(
    "/projects/:projectId/tax/determinations/:determinationId/override",
    { preHandler: standardGate },
    async (req, reply) => {
      const { determinationId } = req.params as { determinationId: string };
      const body = overrideSchema.parse(req.body);
      const original = await fetchDetermination(determinationId, req.companyId!, req.projectId!);
      if (original.status !== "determined") {
        throw conflict(`Only the current determination can be overridden; this one is ${original.status}`);
      }
      const input = original.inputs as unknown as DeterminationInput;
      const prev = original.outputs as unknown as Omit<DeterminationOutput, "citations" | "warnings" | "assumptions">;
      const vatTreatment = body.vatTreatment ?? (original.vatTreatment as DeterminationOutput["vatTreatment"]);
      const reverseCharge =
        body.reverseCharge ?? (vatTreatment === "reverse_charge" || vatTreatment === "reverse_charge_import");
      const vatRate = body.vatRate ?? original.vatRate;
      const chargesVat = !reverseCharge && ["standard", "reduced"].includes(vatTreatment);
      const vatAmount = chargesVat ? round2((original.amount * vatRate) / 100) : 0;
      const selfAccountedVat = reverseCharge ? round2((original.amount * vatRate) / 100) : 0;
      const withholdingScheme = body.withholdingScheme ?? (original.withholdingScheme as DeterminationOutput["withholdingScheme"]);
      const withholdingRate = withholdingScheme === "none" ? 0 : (body.withholdingRate ?? original.withholdingRate);
      const withholdingBase: TaxWithholdingBase =
        withholdingScheme === "none" ? "none" : (body.withholdingBase ?? (original.withholdingBase as TaxWithholdingBase));
      const baseAmount =
        withholdingBase === "none"
          ? 0
          : withholdingBase === "gross_excl_vat"
            ? original.amount
            : round2(Math.max(0, original.amount - input.materialsAmount));
      const withholdingAmount = round2((baseAmount * withholdingRate) / 100);
      const leviesAmount = chargesVat ? original.leviesAmount : 0;
      const gross = round2(original.amount + vatAmount + leviesAmount);
      const net = round2(gross - withholdingAmount);
      const output: DeterminationOutput = {
        regime: original.regime as TaxRegime,
        vatTreatment,
        vatRate,
        vatAmount,
        selfAccountedVat,
        reverseCharge,
        withholdingScheme,
        withholdingBase,
        withholdingBaseAmount: baseAmount,
        withholdingRate,
        withholdingAmount,
        levies: chargesVat ? (prev.levies ?? []) : [],
        leviesAmount,
        grossPayable: gross,
        netPayable: net,
        citations: [
          {
            element: "vat",
            rule: `Human override of determination #${original.number}: ${body.reason}`,
            source: body.citation?.trim() || `override by user ${req.user!.id}`,
          },
        ],
        warnings: ["This determination was set by a person, not the rules engine; the engine's record is retained and linked."],
        assumptions: [],
        confidence: 1,
        explanation: `Overridden by a person. ${body.reason}`,
      };
      const row = await persistDetermination(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        input,
        output,
        sourceType: original.sourceType,
        sourceId: original.sourceId,
        sourceLineId: original.sourceLineId,
        vendorId: original.vendorId,
        vendorName: original.vendorName,
        overridesId: original.id,
        overrideReason: body.reason,
      });
      await app.db
        .update(taxDeterminations)
        .set({ status: "overridden", overriddenById: row.id })
        .where(eq(taxDeterminations.id, original.id));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "tax_determination",
        objectId: original.id,
        payload: {
          from: "determined",
          to: "overridden",
          overriddenById: row.id,
          reason: body.reason,
          changed: Object.keys(body).filter((k) => k !== "reason" && k !== "citation"),
          before: { vatTreatment: original.vatTreatment, vatRate: original.vatRate, withholdingRate: original.withholdingRate, netPayable: original.netPayable },
          after: { vatTreatment, vatRate, withholdingRate, netPayable: net },
        },
        projectId: req.projectId!,
        storePayload: true,
      });
      return reply.status(201).send(serialiseDetermination(row));
    },
  );

  /* ================================================================ */
  /* Withholding certificates (#800, #802, #804)                       */
  /* ================================================================ */

  async function fetchCertificate(id: string, companyId: string, projectId: string) {
    const [row] = await app.db
      .select()
      .from(withholdingCertificates)
      .where(
        and(
          eq(withholdingCertificates.id, id),
          eq(withholdingCertificates.companyId, companyId),
          eq(withholdingCertificates.projectId, projectId),
        ),
      )
      .limit(1);
    if (!row) throw notFound("Withholding certificate not found");
    return row;
  }

  app.get("/projects/:projectId/tax/withholding-certificates", { preHandler: readGate }, async (req) => {
    const q = certificateListQuery.parse(req.query);
    const clauses = [
      eq(withholdingCertificates.companyId, req.companyId!),
      eq(withholdingCertificates.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(withholdingCertificates.status, q.status));
    if (q.vendorId) clauses.push(eq(withholdingCertificates.vendorId, q.vendorId));
    if (q.from) clauses.push(gte(withholdingCertificates.paymentDate, q.from));
    if (q.to) clauses.push(lte(withholdingCertificates.paymentDate, q.to));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(withholdingCertificates).where(where);
    const rows = await app.db
      .select()
      .from(withholdingCertificates)
      .where(where)
      .orderBy(desc(withholdingCertificates.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows, Number(totalRow?.n ?? 0), q);
  });

  app.post("/projects/:projectId/tax/withholding-certificates", { preHandler: standardGate }, async (req, reply) => {
    const body = certificateCreateSchema.parse(req.body);
    let det: DeterminationRow | null = null;
    if (body.determinationId) {
      det = await fetchDetermination(body.determinationId, req.companyId!, req.projectId!);
      if (det.status === "superseded") throw badRequest("The determination has been superseded; use the current one");
    }
    const regime = body.regime ?? (det?.regime as TaxRegime | undefined);
    if (!regime) throw badRequest("regime is required when no determination is referenced");
    const scheme = body.scheme ?? (det?.withholdingScheme as DeterminationOutput["withholdingScheme"] | undefined);
    if (!scheme || scheme === "none") throw badRequest("A withholding certificate needs a deduction scheme (the determination found none)");
    const vendorId = body.vendorId ?? det?.vendorId ?? null;
    let vendorName = body.vendorName ?? det?.vendorName ?? null;
    if (!vendorName && vendorId) {
      const [v] = await app.db
        .select({ name: vendors.name })
        .from(vendors)
        .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, req.companyId!)))
        .limit(1);
      vendorName = v?.name ?? null;
    }
    if (!vendorName) throw badRequest("vendorId or vendorName is required");
    const currency = body.currency ?? det?.currency;
    if (!currency) throw badRequest("currency is required when no determination is referenced");
    const gross = body.grossAmount ?? det?.amount;
    if (gross === undefined) throw badRequest("grossAmount is required when no determination is referenced");
    const detInput = det ? (det.inputs as unknown as DeterminationInput) : null;
    const rate = body.rate ?? det?.withholdingRate;
    if (rate === undefined) throw badRequest("rate is required when no determination is referenced");
    // The base follows the determination when there is one and the SCHEME
    // otherwise — never a flat "gross". A hand-recorded CIS statement that
    // deducted 20% of the gross while printing "materials excluded" short-pays
    // the subcontractor and contradicts itself (#802).
    const base: TaxWithholdingBase =
      body.withholdingBase ?? (det?.withholdingBase as TaxWithholdingBase | undefined) ?? baseForScheme(regime, scheme);
    const baseExcludesMaterials = base === "gross_excl_materials" || base === "labour_only";
    if (!baseExcludesMaterials && body.materialsAmount !== undefined && body.materialsAmount > 0) {
      throw badRequest(
        `A ${scheme.toUpperCase()} deduction on this base (${base.replace(/_/g, " ")}) is computed on the whole amount, so materialsAmount must be 0 or omitted.`,
      );
    }
    const materials = baseExcludesMaterials ? (body.materialsAmount ?? detInput?.materialsAmount ?? 0) : 0;
    if (materials > gross + 0.005) throw badRequest("materialsAmount cannot exceed grossAmount");
    const baseAmount = baseExcludesMaterials ? round2(Math.max(0, gross - materials)) : base === "none" ? 0 : round2(gross);
    const withheld = round2((baseAmount * rate) / 100);
    if (withheld <= 0) throw badRequest("Nothing to certify: the computed deduction is zero");
    const number = await nextRecordNumber(app.db, req.projectId!, "withholding_certificate");
    const id = newId("whc");
    // One live statement per payment. The duplicate check and the insert run
    // in one transaction and the partial unique index decides the race
    // (schema/tax.ts): two payment runs must not both certify one payment.
    try {
      await app.db.transaction(async (tx) => {
        if (body.paymentId) {
          const [dup] = await tx
            .select({ id: withholdingCertificates.id })
            .from(withholdingCertificates)
            .where(
              and(
                eq(withholdingCertificates.paymentId, body.paymentId),
                eq(withholdingCertificates.companyId, req.companyId!),
                ne(withholdingCertificates.status, "cancelled"),
              ),
            )
            .limit(1);
          if (dup) throw conflict("A certificate already exists for this payment; cancel it before issuing another");
        }
        await tx.insert(withholdingCertificates).values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          number,
          determinationId: det?.id ?? null,
          paymentId: body.paymentId ?? null,
          invoiceId: body.invoiceId ?? (det?.sourceType === "invoice_line" || det?.sourceType === "invoice" ? det.sourceId : null),
          vendorId,
          vendorName,
          regime,
          scheme,
          paymentDate: body.paymentDate,
          currency,
          grossAmount: round2(gross),
          materialsAmount: round2(materials),
          baseAmount,
          rate,
          withheldAmount: withheld,
          netPaid: round2(gross - withheld),
          status: "draft",
          detail: body.detail ?? {},
          createdBy: req.user!.id,
        });
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw conflict("A certificate already exists for this payment; cancel it before issuing another");
      }
      throw err;
    }
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "withholding_certificate",
      objectId: id,
      payload: { number, scheme, regime, vendorId, paymentDate: body.paymentDate, currency, grossAmount: round2(gross), baseAmount, rate, withheldAmount: withheld, determinationId: det?.id ?? null, paymentId: body.paymentId ?? null },
      projectId: req.projectId!,
      storePayload: true,
    });
    return reply.status(201).send(await fetchCertificate(id, req.companyId!, req.projectId!));
  });

  app.get("/projects/:projectId/tax/withholding-certificates/:certificateId", { preHandler: readGate }, async (req) => {
    const { certificateId } = req.params as { certificateId: string };
    const row = await fetchCertificate(certificateId, req.companyId!, req.projectId!);
    const def = findTaxRegime(row.regime);
    return { ...row, certificateName: def?.withholding?.certificateName ?? null, remittance: def?.withholding?.remittance ?? null };
  });

  /** Issue: the person issuing the statement is not the person who drafted it. */
  app.post("/projects/:projectId/tax/withholding-certificates/:certificateId/issue", { preHandler: standardGate }, async (req) => {
    const { certificateId } = req.params as { certificateId: string };
    const row = await fetchCertificate(certificateId, req.companyId!, req.projectId!);
    if (row.status !== "draft") throw conflict(`A ${row.status} certificate cannot be issued`);
    if (row.createdBy === req.user!.id) {
      throw forbidden("The person who drafted a withholding certificate cannot issue it; a second person must issue");
    }
    const issuedAt = new Date().toISOString();
    const reference = `${row.scheme.toUpperCase()}-${row.paymentDate.slice(0, 7)}-${String(row.number).padStart(4, "0")}`;
    await app.db
      .update(withholdingCertificates)
      .set({ status: "issued", issuedAt, issuedBy: req.user!.id, reference, updatedAt: issuedAt })
      .where(and(eq(withholdingCertificates.id, certificateId), eq(withholdingCertificates.status, "draft")));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "withholding_certificate",
      objectId: certificateId,
      payload: { from: "draft", to: "issued", reference, withheldAmount: row.withheldAmount, currency: row.currency },
      projectId: req.projectId!,
      storePayload: true,
    });
    return fetchCertificate(certificateId, req.companyId!, req.projectId!);
  });

  app.post("/projects/:projectId/tax/withholding-certificates/:certificateId/cancel", { preHandler: standardGate }, async (req) => {
    const { certificateId } = req.params as { certificateId: string };
    const body = reasonSchema.parse(req.body);
    const row = await fetchCertificate(certificateId, req.companyId!, req.projectId!);
    if (row.status === "cancelled") throw conflict("Certificate is already cancelled");
    const at = new Date().toISOString();
    await app.db
      .update(withholdingCertificates)
      .set({ status: "cancelled", cancelledAt: at, cancelledBy: req.user!.id, cancelReason: body.reason, updatedAt: at })
      .where(eq(withholdingCertificates.id, certificateId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "withholding_certificate",
      objectId: certificateId,
      payload: { from: row.status, to: "cancelled", reason: body.reason },
      projectId: req.projectId!,
      storePayload: true,
    });
    return fetchCertificate(certificateId, req.companyId!, req.projectId!);
  });

  /* ================================================================ */
  /* Periods and returns (#803, #798)                                  */
  /* ================================================================ */

  async function fetchPeriod(id: string, companyId: string, projectId: string) {
    const [row] = await app.db
      .select()
      .from(taxPeriods)
      .where(and(eq(taxPeriods.id, id), eq(taxPeriods.companyId, companyId), eq(taxPeriods.projectId, projectId)))
      .limit(1);
    if (!row) throw notFound("Tax period not found");
    return row;
  }

  app.get("/projects/:projectId/tax/periods", { preHandler: readGate }, async (req) => {
    const q = periodListQuery.parse(req.query);
    const clauses = [eq(taxPeriods.companyId, req.companyId!), eq(taxPeriods.projectId, req.projectId!)];
    if (q.status) clauses.push(eq(taxPeriods.status, q.status));
    if (q.returnKind) clauses.push(eq(taxPeriods.returnKind, q.returnKind));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(taxPeriods).where(where);
    const rows = await app.db
      .select()
      .from(taxPeriods)
      .where(where)
      .orderBy(desc(taxPeriods.periodStart))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const today = todayISO();
    return paginate(
      rows.map((p) => ({ ...p, daysToDue: Math.round((Date.parse(`${p.dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.post("/projects/:projectId/tax/periods", { preHandler: standardGate }, async (req, reply) => {
    const body = periodCreateSchema.parse(req.body);
    const { regime, res } = await resolveOrThrow(req.companyId!, req.projectId!, body.regime);
    const def = findTaxRegime(regime)!;
    const ret = findReturnDef(regime, body.returnKind);
    if (!ret && regime !== "custom" && !(body.periodEnd && body.dueDate)) {
      throw badRequest(
        `${def.name} has no ${body.returnKind.replace(/_/g, " ")} return in the library (${def.returns.map((r) => r.kind).join(", ") || "none"}); supply periodEnd and dueDate explicitly`,
      );
    }
    const periodEnd = body.periodEnd ?? addDaysISO(addMonthsISO(body.periodStart, ret?.periodMonths ?? 1), -1);
    if (periodEnd < body.periodStart) throw badRequest("periodEnd must not precede periodStart");
    const dueDate = body.dueDate ?? addDaysISO(periodEnd, ret?.dueDaysAfterPeriodEnd ?? 30);
    const paymentDueDate =
      body.paymentDueDate !== undefined
        ? body.paymentDueDate
        : ret?.paymentDueDaysAfterPeriodEnd != null
          ? addDaysISO(periodEnd, ret.paymentDueDaysAfterPeriodEnd)
          : null;
    const currency = body.currency ?? res.profile?.currency ?? def.currency ?? "USD";
    const [dup] = await app.db
      .select({ id: taxPeriods.id })
      .from(taxPeriods)
      .where(
        and(
          eq(taxPeriods.projectId, req.projectId!),
          eq(taxPeriods.regime, regime),
          eq(taxPeriods.returnKind, body.returnKind),
          eq(taxPeriods.periodStart, body.periodStart),
        ),
      )
      .limit(1);
    if (dup) throw conflict("A period with this regime, return kind and start date already exists");

    const obligationId = newId("obl");
    const id = newId("txn");
    // Both rows or neither: the deadline obligation exists to be satisfied by
    // its period, and the duplicate check above is racy against tax_periods_uq,
    // so a losing request must not leave an open obligation nothing can close.
    try {
      await app.db.transaction(async (tx) => {
        await tx.insert(obligations).values({
          id: obligationId,
          companyId: req.companyId!,
          projectId: req.projectId!,
          sourceClause: `${def.name} — ${ret?.name ?? body.returnKind}`,
          trigger: `File ${ret?.name ?? body.returnKind} for ${body.periodStart} to ${periodEnd}`,
          deadline: `${dueDate}T23:59:59Z`,
          warnDaysBefore: 7,
          evidenceRequirement: "Filing reference / authority receipt",
          status: "open",
          createdBy: req.user!.id,
        });
        await tx.insert(taxPeriods).values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          regime,
          returnKind: body.returnKind,
          periodStart: body.periodStart,
          periodEnd,
          dueDate,
          paymentDueDate,
          currency,
          status: "open",
          obligationId,
          notes: body.notes ?? null,
          createdBy: req.user!.id,
        });
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw conflict("A period with this regime, return kind and start date already exists");
      }
      throw err;
    }
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "tax_period",
      objectId: id,
      payload: { regime, returnKind: body.returnKind, periodStart: body.periodStart, periodEnd, dueDate, paymentDueDate, currency, obligationId, citation: ret?.citation ?? null },
      projectId: req.projectId!,
      storePayload: true,
    });
    return reply.status(201).send({ ...(await fetchPeriod(id, req.companyId!, req.projectId!)), returnDef: ret ?? null });
  });

  app.get("/projects/:projectId/tax/periods/:periodId", { preHandler: readGate }, async (req) => {
    const { periodId } = req.params as { periodId: string };
    const row = await fetchPeriod(periodId, req.companyId!, req.projectId!);
    const live = await computePeriodAggregates(app.db, row);
    const [obl] = row.obligationId
      ? await app.db.select().from(obligations).where(eq(obligations.id, row.obligationId)).limit(1)
      : [undefined];
    return { ...row, live, obligation: obl ?? null, returnDef: findReturnDef(row.regime, row.returnKind as TaxReturnKind) ?? null };
  });

  /**
   * Recompute the aggregates. Refused once the return is filed or paid: the
   * determinations and certificates inside the window keep moving (a re-run
   * supersedes, a certificate is cancelled), so recomputing would quietly
   * replace the figures that were filed while filedAt, filedBy and the filing
   * reference still claim they are the submitted ones (plan §6.2). Correcting
   * a filed return goes through /reopen, which clears the filing first.
   */
  app.post("/projects/:projectId/tax/periods/:periodId/compute", { preHandler: standardGate }, async (req) => {
    const { periodId } = req.params as { periodId: string };
    const row = await fetchPeriod(periodId, req.companyId!, req.projectId!);
    if (row.status === "filed" || row.status === "paid") {
      throw conflict(
        `This return is ${row.status}${row.filingReference ? ` under reference ${row.filingReference}` : ""}; its figures are the ones submitted. Re-open it first if the return has to be corrected.`,
      );
    }
    const agg = await computePeriodAggregates(app.db, row);
    const at = new Date().toISOString();
    await app.db
      .update(taxPeriods)
      .set({ ...agg, computedAt: at, updatedAt: at })
      .where(eq(taxPeriods.id, periodId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "tax_period",
      objectId: periodId,
      payload: { computed: { outputTax: agg.outputTax, inputTax: agg.inputTax, withheldTotal: agg.withheldTotal, netPayable: agg.netPayable, excludedCount: agg.excludedCount } },
      projectId: req.projectId!,
      storePayload: true,
    });
    return fetchPeriod(periodId, req.companyId!, req.projectId!);
  });

  /**
   * Re-open a filed (or paid) return so it can be corrected: the filing is
   * cleared, not kept over new numbers, and the obligation goes back to open
   * so the deadline is live again. The reversal is ledgered with the reason.
   */
  app.post("/projects/:projectId/tax/periods/:periodId/reopen", { preHandler: standardGate }, async (req) => {
    const { periodId } = req.params as { periodId: string };
    const body = reasonSchema.parse(req.body);
    const row = await fetchPeriod(periodId, req.companyId!, req.projectId!);
    if (row.status !== "filed" && row.status !== "paid") {
      throw conflict(`Only a filed or paid return can be re-opened; this one is ${row.status}`);
    }
    const at = new Date().toISOString();
    const reopenedStatus = row.dueDate < todayISO() ? "overdue" : "open";
    await app.db
      .update(taxPeriods)
      .set({
        status: reopenedStatus,
        filedAt: null,
        filedBy: null,
        filingReference: null,
        paidAt: null,
        paidBy: null,
        updatedAt: at,
      })
      .where(eq(taxPeriods.id, periodId));
    await setObligationStatus(app.db, row.obligationId, "satisfied", reopenedStatus === "overdue" ? "breached" : "open");
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "tax_period",
      objectId: periodId,
      payload: {
        from: row.status,
        to: reopenedStatus,
        reason: body.reason,
        clearedFiling: { filingReference: row.filingReference, filedAt: row.filedAt, filedBy: row.filedBy },
        figuresAtReopen: {
          outputTax: row.outputTax,
          inputTax: row.inputTax,
          withheldTotal: row.withheldTotal,
          netPayable: row.netPayable,
        },
      },
      projectId: req.projectId!,
      storePayload: true,
    });
    return fetchPeriod(periodId, req.companyId!, req.projectId!);
  });

  app.post("/projects/:projectId/tax/periods/:periodId/file", { preHandler: standardGate }, async (req) => {
    const { periodId } = req.params as { periodId: string };
    const body = fileSchema.parse(req.body);
    const row = await fetchPeriod(periodId, req.companyId!, req.projectId!);
    if (row.status === "filed" || row.status === "paid") throw conflict(`Period is already ${row.status}`);
    if (!row.computedAt) throw badRequest("Compute the period before filing so the filed figures are on record");
    const now = new Date();
    const filedAt = body.filedAt ?? now.toISOString();
    // `filedAt` is back-entry for a return filed before it was recorded here;
    // it may not be in the future, and it never decides lateness — a late
    // return recorded with an on-time date would leave the obligation
    // "satisfied" from open instead of breached and silently contradict the
    // overdue signal.
    if (Date.parse(filedAt) > now.getTime() + 60_000) {
      throw badRequest("filedAt cannot be in the future");
    }
    const late = now.toISOString().slice(0, 10) > row.dueDate;
    await app.db
      .update(taxPeriods)
      .set({ status: "filed", filedAt, filedBy: req.user!.id, filingReference: body.filingReference, notes: body.notes ?? row.notes, updatedAt: new Date().toISOString() })
      .where(eq(taxPeriods.id, periodId));
    await setObligationStatus(app.db, row.obligationId, "open", "satisfied");
    if (late) await setObligationStatus(app.db, row.obligationId, "breached", "satisfied");
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "tax_period",
      objectId: periodId,
      payload: { from: row.status, to: "filed", filingReference: body.filingReference, filedAt, late, netPayable: row.netPayable },
      projectId: req.projectId!,
      storePayload: true,
    });
    return fetchPeriod(periodId, req.companyId!, req.projectId!);
  });

  app.post("/projects/:projectId/tax/periods/:periodId/mark-paid", { preHandler: standardGate }, async (req) => {
    const { periodId } = req.params as { periodId: string };
    const body = paidSchema.parse(req.body ?? {});
    const row = await fetchPeriod(periodId, req.companyId!, req.projectId!);
    if (row.status !== "filed") throw conflict("Only a filed period can be marked paid");
    const paidAt = body.paidAt ?? new Date().toISOString();
    await app.db
      .update(taxPeriods)
      .set({ status: "paid", paidAt, paidBy: req.user!.id, updatedAt: new Date().toISOString() })
      .where(eq(taxPeriods.id, periodId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "tax_period",
      objectId: periodId,
      payload: { from: "filed", to: "paid", paidAt, netPayable: row.netPayable, currency: row.currency },
      projectId: req.projectId!,
      storePayload: true,
    });
    return fetchPeriod(periodId, req.companyId!, req.projectId!);
  });

  /* ================================================================ */
  /* Permanent establishment exposure (#806–807)                       */
  /* ================================================================ */

  async function fetchExposure(id: string, companyId: string, projectId: string) {
    const [row] = await app.db
      .select()
      .from(peExposures)
      .where(and(eq(peExposures.id, id), eq(peExposures.companyId, companyId), eq(peExposures.projectId, projectId)))
      .limit(1);
    if (!row) throw notFound("PE exposure not found");
    return row;
  }

  app.get("/projects/:projectId/tax/pe-exposures", { preHandler: readGate }, async (req) => {
    const q = exposureListQuery.parse(req.query);
    const clauses = [eq(peExposures.companyId, req.companyId!), eq(peExposures.projectId, req.projectId!)];
    if (q.status) clauses.push(eq(peExposures.status, q.status));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(peExposures).where(where);
    const rows = await app.db
      .select()
      .from(peExposures)
      .where(where)
      .orderBy(desc(peExposures.daysInWindow))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(
      rows.map((r) => ({ ...r, percentOfThreshold: r.thresholdDays > 0 ? round2((r.daysInWindow / r.thresholdDays) * 100) : null })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.post("/projects/:projectId/tax/pe-exposures", { preHandler: standardGate }, async (req, reply) => {
    const body = exposureCreateSchema.parse(req.body);
    const res = await resolveRegime(app.db, req.companyId!, req.projectId!);
    const regime = body.regime ?? res.regime;
    const def = regime ? findTaxRegime(regime) : undefined;
    // The project's country is free text ("United Kingdom"), so it is
    // normalised through the library's alias table rather than truncated to
    // two letters — the code is written to the register and printed in the
    // signal, and "UN" is not a country.
    const hostCountry = body.hostCountry ?? (def?.countryCode || countryCodeFor(res.project?.country)) ?? null;
    if (!hostCountry || !/^[A-Z]{2}$/.test(hostCountry)) {
      throw badRequest(
        `hostCountry is required: the regime carries no country code and the project's country (${res.project?.country ?? "not set"}) is not an ISO-3166 alpha-2 code or a country the library knows.`,
      );
    }
    if (!regime) throw badRequest("regime is required when the project has no resolvable regime");
    const isPerson = body.entityType === "person";
    const thresholdDays =
      body.thresholdDays ?? (isPerson ? def!.permanentEstablishment.serviceDays : def!.permanentEstablishment.constructionSiteDays);
    const thresholdBasis =
      body.thresholdBasis ??
      `${isPerson ? "Individual presence" : "Building-site"} threshold of ${thresholdDays} days — ${def!.permanentEstablishment.basis} (${def!.permanentEstablishment.citation})`;
    const id = newId("pex");
    await app.db.insert(peExposures).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      entityType: body.entityType,
      entityId: body.entityId ?? null,
      entityName: body.entityName,
      homeCountry: body.homeCountry,
      hostCountry,
      regime,
      thresholdDays,
      windowMonths: body.windowMonths ?? (isPerson ? 12 : 0),
      warnFraction: body.warnFraction ?? 0.75,
      thresholdBasis,
      notes: body.notes ?? null,
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "pe_exposure",
      objectId: id,
      payload: { entityType: body.entityType, entityName: body.entityName, homeCountry: body.homeCountry, hostCountry, regime, thresholdDays, windowMonths: body.windowMonths ?? (isPerson ? 12 : 0) },
      projectId: req.projectId!,
      storePayload: true,
    });
    return reply.status(201).send(await fetchExposure(id, req.companyId!, req.projectId!));
  });

  app.get("/projects/:projectId/tax/pe-exposures/:exposureId", { preHandler: readGate }, async (req) => {
    const { exposureId } = req.params as { exposureId: string };
    const row = await fetchExposure(exposureId, req.companyId!, req.projectId!);
    const entries = await app.db
      .select()
      .from(pePresenceEntries)
      .where(eq(pePresenceEntries.exposureId, exposureId))
      .orderBy(desc(pePresenceEntries.startDate));
    return { ...row, percentOfThreshold: row.thresholdDays > 0 ? round2((row.daysInWindow / row.thresholdDays) * 100) : null, entries };
  });

  app.patch("/projects/:projectId/tax/pe-exposures/:exposureId", { preHandler: standardGate }, async (req) => {
    const { exposureId } = req.params as { exposureId: string };
    const body = exposurePatchSchema.parse(req.body);
    const row = await fetchExposure(exposureId, req.companyId!, req.projectId!);
    if (body.thresholdDays !== undefined && body.thresholdDays !== row.thresholdDays && !body.thresholdBasis) {
      throw badRequest("Changing the threshold requires a stated thresholdBasis (the treaty or law relied on)");
    }
    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    for (const [k, v] of Object.entries(body)) if (v !== undefined) set[k] = v;
    await app.db.update(peExposures).set(set).where(eq(peExposures.id, exposureId));
    const updated = await fetchExposure(exposureId, req.companyId!, req.projectId!);
    const rec = await recomputeExposure(app.db, updated, todayISO());
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "pe_exposure",
      objectId: exposureId,
      payload: { changed: Object.keys(body), thresholdDays: rec.row.thresholdDays, status: rec.row.status },
      projectId: req.projectId!,
    });
    return rec.row;
  });

  app.post("/projects/:projectId/tax/pe-exposures/:exposureId/entries", { preHandler: standardGate }, async (req, reply) => {
    const { exposureId } = req.params as { exposureId: string };
    const body = presenceEntrySchema.parse(req.body);
    const row = await fetchExposure(exposureId, req.companyId!, req.projectId!);
    if (row.status === "closed") throw conflict("A closed exposure does not accept presence entries");
    const days = daysInclusive(body.startDate, body.endDate);
    if (days <= 0) throw badRequest("endDate must be on or after startDate");
    const id = newId("pep");
    await app.db.insert(pePresenceEntries).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      exposureId,
      startDate: body.startDate,
      endDate: body.endDate,
      days,
      purpose: body.purpose ?? null,
      source: body.source ?? "manual",
      sourceRef: body.sourceRef ?? null,
      recordedBy: req.user!.id,
    });
    const rec = await recomputeExposure(app.db, row, todayISO());
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "pe_presence_entry",
      objectId: id,
      payload: { exposureId, startDate: body.startDate, endDate: body.endDate, days, source: body.source ?? "manual", statusAfter: rec.row.status, daysInWindow: rec.row.daysInWindow },
      projectId: req.projectId!,
      storePayload: true,
    });
    if (rec.row.status !== rec.previousStatus) {
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "pe_exposure",
        objectId: exposureId,
        payload: { from: rec.previousStatus, to: rec.row.status, daysInWindow: rec.row.daysInWindow, thresholdDays: rec.row.thresholdDays },
        projectId: req.projectId!,
      });
      if (rec.row.status === "approaching" || rec.row.status === "breached") {
        await pushNotifications(app.db, [
          {
            companyId: req.companyId!,
            userId: row.createdBy,
            projectId: req.projectId!,
            kind: "tax",
            title: `PE exposure ${rec.row.status}: ${row.entityName} in ${row.hostCountry}`,
            body: `${rec.row.daysInWindow} of ${row.thresholdDays} days.`,
            recordType: "pe_exposure",
            recordId: exposureId,
          },
        ]);
      }
    }
    return reply.status(201).send({ entry: { id, days }, exposure: rec.row });
  });

  app.delete("/projects/:projectId/tax/pe-exposures/:exposureId/entries/:entryId", { preHandler: standardGate }, async (req) => {
    const { exposureId, entryId } = req.params as { exposureId: string; entryId: string };
    const row = await fetchExposure(exposureId, req.companyId!, req.projectId!);
    const [entry] = await app.db
      .select()
      .from(pePresenceEntries)
      .where(and(eq(pePresenceEntries.id, entryId), eq(pePresenceEntries.exposureId, exposureId), eq(pePresenceEntries.companyId, req.companyId!)))
      .limit(1);
    if (!entry) throw notFound("Presence entry not found");
    await app.db.delete(pePresenceEntries).where(eq(pePresenceEntries.id, entryId));
    const rec = await recomputeExposure(app.db, row, todayISO());
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "pe_presence_entry",
      objectId: entryId,
      payload: { exposureId, startDate: entry.startDate, endDate: entry.endDate, days: entry.days, statusAfter: rec.row.status },
      projectId: req.projectId!,
      storePayload: true,
    });
    return rec.row;
  });

  app.post("/projects/:projectId/tax/pe-exposures/:exposureId/mitigate", { preHandler: standardGate }, async (req) => {
    const { exposureId } = req.params as { exposureId: string };
    const body = mitigateSchema.parse(req.body);
    const row = await fetchExposure(exposureId, req.companyId!, req.projectId!);
    if (row.status === "closed") throw conflict("A closed exposure cannot be mitigated");
    await app.db
      .update(peExposures)
      .set({ status: "mitigated", mitigationNote: body.note, updatedAt: new Date().toISOString() })
      .where(eq(peExposures.id, exposureId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "pe_exposure",
      objectId: exposureId,
      payload: { from: row.status, to: "mitigated", note: body.note },
      projectId: req.projectId!,
      storePayload: true,
    });
    return fetchExposure(exposureId, req.companyId!, req.projectId!);
  });

  app.post("/projects/:projectId/tax/pe-exposures/:exposureId/close", { preHandler: standardGate }, async (req) => {
    const { exposureId } = req.params as { exposureId: string };
    const body = reasonSchema.parse(req.body);
    const row = await fetchExposure(exposureId, req.companyId!, req.projectId!);
    if (row.status === "closed") throw conflict("Exposure is already closed");
    await app.db
      .update(peExposures)
      .set({ status: "closed", mitigationNote: body.reason, updatedAt: new Date().toISOString() })
      .where(eq(peExposures.id, exposureId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "pe_exposure",
      objectId: exposureId,
      payload: { from: row.status, to: "closed", reason: body.reason },
      projectId: req.projectId!,
      storePayload: true,
    });
    return fetchExposure(exposureId, req.companyId!, req.projectId!);
  });

  /* ================================================================ */
  /* Risks, vendors coverage, summary, health inputs                   */
  /* ================================================================ */

  app.get("/projects/:projectId/tax/risks", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema.extend({ includeClosed: z.enum(["true", "false"]).optional() }).parse(req.query);
    const clauses = [
      eq(signals.companyId, req.companyId!),
      eq(signals.projectId, req.projectId!),
      inArray(signals.detector, [...TAX_RISK_DETECTORS]),
    ];
    if (q.includeClosed !== "true") clauses.push(inArray(signals.disposition, OPEN_SIGNAL_DISPOSITIONS));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(signals).where(where);
    const rows = await app.db
      .select()
      .from(signals)
      .where(where)
      .orderBy(desc(signals.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows, Number(totalRow?.n ?? 0), q);
  });

  /**
   * On-demand scan of THIS project. The caller holds `tax` on this project and
   * may not even be a member of the next one, so the sweeps are scoped to it:
   * the company-wide fan-out belongs to the `tax.risk-sweep` scheduler job,
   * which runs as the system actor over every company (plan §6.3).
   */
  app.post("/projects/:projectId/tax/risks/scan", { preHandler: standardGate }, async (req) => {
    const now = new Date();
    const counts = await runTaxRiskSweep(app.db, req.companyId!, now, req.projectId!);
    const pe = await sweepPeExposures(app.db, req.companyId!, now, req.projectId!);
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "access",
      objectType: "tax_risk_scan",
      objectId: req.projectId!,
      payload: { ...counts, peRecomputed: pe.recomputed, peRaised: pe.raised },
      projectId: req.projectId!,
    });
    return { ...counts, peRecomputed: pe.recomputed, peSignalsRaised: pe.raised, scope: "project" as const, ranAt: now.toISOString() };
  });

  /** Vendors being paid on this project and their registration coverage under the resolved regime. */
  app.get("/projects/:projectId/tax/vendors", { preHandler: readGate }, async (req) => {
    const res = await resolveRegime(app.db, req.companyId!, req.projectId!);
    const rows = await app.db
      .select({ vendorId: commitments.vendorId, status: commitments.status, kind: commitments.kind })
      .from(commitments)
      .where(and(eq(commitments.companyId, req.companyId!), eq(commitments.projectId, req.projectId!), isNull(commitments.terminationDate)));
    const byVendor = new Map<string, { commitments: number; approved: number }>();
    for (const r of rows) {
      if (!r.vendorId) continue;
      const cur = byVendor.get(r.vendorId) ?? { commitments: 0, approved: 0 };
      cur.commitments += 1;
      if (r.status === "approved" || r.status === "complete") cur.approved += 1;
      byVendor.set(r.vendorId, cur);
    }
    const ids = [...byVendor.keys()];
    if (ids.length === 0) return { regime: res.regime, items: [], total: 0, reasons: res.reasons };
    const vs = await app.db
      .select({ id: vendors.id, name: vendors.name, country: vendors.country, taxId: vendors.taxId })
      .from(vendors)
      .where(and(eq(vendors.companyId, req.companyId!), inArray(vendors.id, ids)));
    const regs = res.regime
      ? await app.db
          .select()
          .from(taxRegistrations)
          .where(and(eq(taxRegistrations.companyId, req.companyId!), eq(taxRegistrations.holderType, "vendor"), eq(taxRegistrations.regime, res.regime), inArray(taxRegistrations.holderId, ids)))
      : [];
    const today = todayISO();
    const items = vs
      .map((v) => {
        const mine = regs.filter((r) => r.holderId === v.id);
        const live = mine.filter((r) => r.status === "active" && (!r.validTo || r.validTo >= today));
        return {
          ...v,
          ...byVendor.get(v.id)!,
          registrations: mine.map((r) => ({ id: r.id, kind: r.kind, number: r.number, status: r.status, verificationStatus: r.verificationStatus, deductionRate: r.deductionRate })),
          covered: live.length > 0,
          verified: live.some((r) => r.verificationStatus === "verified"),
        };
      })
      .sort((a, b) => Number(a.covered) - Number(b.covered) || a.name.localeCompare(b.name));
    return { regime: res.regime, items, total: items.length, reasons: res.reasons };
  });

  async function summaryFor(companyId: string, projectId: string) {
    const res = await resolveRegime(app.db, companyId, projectId);
    const dets = await app.db
      .select({
        status: taxDeterminations.status,
        currency: taxDeterminations.currency,
        withholdingAmount: taxDeterminations.withholdingAmount,
        selfAccountedVat: taxDeterminations.selfAccountedVat,
        reverseCharge: taxDeterminations.reverseCharge,
        confidence: taxDeterminations.confidence,
        sourceType: taxDeterminations.sourceType,
      })
      .from(taxDeterminations)
      .where(and(eq(taxDeterminations.companyId, companyId), eq(taxDeterminations.projectId, projectId), ne(taxDeterminations.status, "superseded")));
    const byCurrency = new Map<string, { withholdingDetermined: number; selfAccountedVat: number }>();
    let current = 0;
    let overridden = 0;
    let reverseCharged = 0;
    let lowConfidence = 0;
    for (const d of dets) {
      if (d.status === "determined") current += 1;
      if (d.status === "overridden") overridden += 1;
      if (d.reverseCharge === 1 && d.status === "determined") reverseCharged += 1;
      if (d.confidence < 0.7 && d.status === "determined") lowConfidence += 1;
      if (d.status === "determined" && d.sourceType !== "manual") {
        const b = byCurrency.get(d.currency) ?? { withholdingDetermined: 0, selfAccountedVat: 0 };
        b.withholdingDetermined = round2(b.withholdingDetermined + d.withholdingAmount);
        b.selfAccountedVat = round2(b.selfAccountedVat + d.selfAccountedVat);
        byCurrency.set(d.currency, b);
      }
    }
    const certs = await app.db
      .select({ status: withholdingCertificates.status, currency: withholdingCertificates.currency, withheldAmount: withholdingCertificates.withheldAmount })
      .from(withholdingCertificates)
      .where(and(eq(withholdingCertificates.companyId, companyId), eq(withholdingCertificates.projectId, projectId)));
    const withheldByCurrency = new Map<string, number>();
    let draftCerts = 0;
    for (const c of certs) {
      if (c.status === "draft") draftCerts += 1;
      if (c.status === "issued") withheldByCurrency.set(c.currency, round2((withheldByCurrency.get(c.currency) ?? 0) + c.withheldAmount));
    }
    const periods = await app.db
      .select({ status: taxPeriods.status, dueDate: taxPeriods.dueDate })
      .from(taxPeriods)
      .where(and(eq(taxPeriods.companyId, companyId), eq(taxPeriods.projectId, projectId)));
    const today = todayISO();
    const overduePeriods = periods.filter((p) => p.status === "overdue" || ((p.status === "open" || p.status === "closed") && p.dueDate < today)).length;
    const dueSoon = periods.filter((p) => (p.status === "open" || p.status === "closed") && p.dueDate >= today && p.dueDate <= addDaysISO(today, 14)).length;
    const exposures = await app.db
      .select({ status: peExposures.status })
      .from(peExposures)
      .where(and(eq(peExposures.companyId, companyId), eq(peExposures.projectId, projectId)));
    const [riskRow] = await app.db
      .select({ n: count() })
      .from(signals)
      .where(and(eq(signals.companyId, companyId), eq(signals.projectId, projectId), inArray(signals.detector, [...TAX_RISK_DETECTORS]), inArray(signals.disposition, OPEN_SIGNAL_DISPOSITIONS)));
    return {
      regime: res.regime,
      regimeSource: res.source,
      reasons: res.reasons,
      determinations: { current, overridden, reverseCharged, lowConfidence },
      byCurrency: [...byCurrency.entries()].map(([currency, v]) => ({ currency, ...v, withheldIssued: withheldByCurrency.get(currency) ?? 0 })),
      certificates: { total: certs.length, draft: draftCerts, issued: certs.filter((c) => c.status === "issued").length },
      periods: { total: periods.length, open: periods.filter((p) => p.status === "open").length, overdue: overduePeriods, dueSoon, filed: periods.filter((p) => p.status === "filed" || p.status === "paid").length },
      peExposures: {
        total: exposures.length,
        approaching: exposures.filter((e) => e.status === "approaching").length,
        breached: exposures.filter((e) => e.status === "breached").length,
      },
      openRiskSignals: Number(riskRow?.n ?? 0),
    };
  }

  app.get("/projects/:projectId/tax/summary", { preHandler: readGate }, async (req) => summaryFor(req.companyId!, req.projectId!));

  /** Health inputs for the intelligence layer (plan §3.5). */
  app.get("/projects/:projectId/tax/health-inputs", { preHandler: readGate }, async (req) => {
    const s = await summaryFor(req.companyId!, req.projectId!);
    const reasons: string[] = [...s.reasons];
    if (s.determinations.current === 0) reasons.push("No tax determinations have been run on this project yet.");
    return {
      metrics: {
        openTaxRiskSignals: s.openRiskSignals,
        overdueReturns: s.periods.overdue,
        returnsDueWithin14Days: s.periods.dueSoon,
        peExposuresBreached: s.peExposures.breached,
        peExposuresApproaching: s.peExposures.approaching,
        determinationsOverridden: s.determinations.overridden,
        lowConfidenceDeterminations: s.determinations.lowConfidence,
        draftCertificates: s.certificates.draft,
        regimeResolved: s.regime ? 1 : 0,
      },
      reasons,
    };
  });

  // Company-level rollup of open tax signals with no project (verification lapses).
  app.get("/tax/company-signals", { preHandler: companyReadGate }, async (req) => {
    const rows = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, req.companyId!),
          isNull(signals.projectId),
          inArray(signals.detector, [...TAX_RISK_DETECTORS]),
          or(...OPEN_SIGNAL_DISPOSITIONS.map((d) => eq(signals.disposition, d))),
        ),
      )
      .orderBy(desc(signals.createdAt))
      .limit(200);
    return { items: rows, total: rows.length };
  });
};
