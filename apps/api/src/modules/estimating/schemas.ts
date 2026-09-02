/**
 * Wire schemas for the estimating module. Split out of index.ts so the route
 * file reads as routes; every one of these is parsed with `.parse()` so a
 * ZodError becomes a 400 before a handler ever sees the body.
 */
import { z } from "zod";
import {
  ASSEMBLY_STATUSES,
  CATALOGUE_ITEM_SOURCES,
  CATALOGUE_ITEM_STATUSES,
  COST_TYPES,
  CREW_DEFINITION_STATUSES,
  ESTIMATE_LINE_SOURCES,
  ESTIMATE_LINE_STATUSES,
  ESTIMATE_MARKUP_BASES,
  ESTIMATE_MARKUP_KINDS,
  ESTIMATE_MARKUP_METHODS,
  ESTIMATE_PROPOSAL_STATUSES,
  ESTIMATE_STATUSES,
  ESTIMATE_TYPES,
  LENGTH_UNITS,
  PRODUCTION_RATE_BASES,
  SUB_QUOTE_STATUSES,
  TAKEOFF_GEOMETRY_KINDS,
  TAKEOFF_MEASUREMENT_TYPES,
  TAKEOFF_STATUSES,
} from "@constructos/shared";
import { pageQuerySchema } from "../../lib/pagination.js";

export const idRef = z.string().min(1).max(64);
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD)");
export const money = z.number().finite();
export const nonNegative = z.number().finite().nonnegative();
export const percent = z.number().finite().min(-100).max(1000);
export const colour = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Expected a #rrggbb colour");
export const currencyCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, "Expected a 3-letter ISO 4217 currency code")
  .transform((c) => c.toUpperCase());
export const detailBag = z.record(z.string(), z.unknown());

export const rateSplitSchema = z
  .object({
    labour: money,
    material: money,
    equipment: money,
    subcontract: money,
    other: money,
  })
  .partial();

/* ------------------------------------------------------------------ */
/* Catalogue                                                           */
/* ------------------------------------------------------------------ */

export const catalogueCreateSchema = z.object({
  projectId: idRef.nullable().optional(),
  code: z.string().trim().min(1).max(80),
  description: z.string().min(1).max(500),
  longDescription: z.string().max(20000).nullable().optional(),
  unit: z.string().min(1).max(24),
  costType: z.enum(COST_TYPES).optional(),
  category: z.string().max(120).nullable().optional(),
  trade: z.string().max(120).nullable().optional(),
  currency: currencyCode.optional(),
  rates: rateSplitSchema.optional(),
  crewId: idRef.nullable().optional(),
  productionRate: nonNegative.nullable().optional(),
  productionRateBasis: z.enum(PRODUCTION_RATE_BASES).nullable().optional(),
  wastePercent: percent.optional(),
  costCodeId: idRef.nullable().optional(),
  costCode: z.string().max(80).nullable().optional(),
  source: z.enum(CATALOGUE_ITEM_SOURCES).optional(),
  sourceReference: z.string().max(500).nullable().optional(),
  region: z.string().max(80).nullable().optional(),
  rateAsAt: isoDate.nullable().optional(),
  tags: z.array(z.string().max(60)).max(30).optional(),
  detail: detailBag.optional(),
});

export const cataloguePatchSchema = catalogueCreateSchema
  .omit({ projectId: true, code: true })
  .extend({ status: z.enum(CATALOGUE_ITEM_STATUSES).optional() })
  .partial();

export const catalogueBulkSchema = z.object({
  items: z.array(catalogueCreateSchema).min(1).max(500),
  /** update an item that already carries the same code instead of failing */
  upsert: z.boolean().optional(),
});

export const catalogueListQuery = pageQuerySchema.extend({
  search: z.string().max(200).optional(),
  costType: z.enum(COST_TYPES).optional(),
  status: z.enum(CATALOGUE_ITEM_STATUSES).optional(),
  source: z.enum(CATALOGUE_ITEM_SOURCES).optional(),
  category: z.string().max(120).optional(),
  trade: z.string().max(120).optional(),
  projectId: idRef.optional(),
  /** include the company library alongside a project's own rates */
  includeCompany: z.enum(["true", "false"]).optional(),
});

/* ------------------------------------------------------------------ */
/* Assemblies, crews, production rates                                 */
/* ------------------------------------------------------------------ */

export const assemblyComponentSchema = z.object({
  catalogueItemId: idRef.nullable().optional(),
  description: z.string().min(1).max(500),
  unit: z.string().max(24).nullable().optional(),
  costType: z.enum(COST_TYPES).optional(),
  quantityPer: money,
  wastePercent: percent.optional(),
  rates: rateSplitSchema.optional(),
  costCodeId: idRef.nullable().optional(),
  costCode: z.string().max(80).nullable().optional(),
});

export const assemblyCreateSchema = z.object({
  projectId: idRef.nullable().optional(),
  code: z.string().trim().min(1).max(80),
  name: z.string().min(1).max(300),
  description: z.string().max(20000).nullable().optional(),
  unit: z.string().min(1).max(24),
  category: z.string().max(120).nullable().optional(),
  trade: z.string().max(120).nullable().optional(),
  currency: currencyCode.optional(),
  costCodeId: idRef.nullable().optional(),
  costCode: z.string().max(80).nullable().optional(),
  components: z.array(assemblyComponentSchema).max(500).optional(),
  detail: detailBag.optional(),
});

export const assemblyPatchSchema = assemblyCreateSchema
  .omit({ projectId: true, code: true, components: true })
  .extend({ status: z.enum(ASSEMBLY_STATUSES).optional() })
  .partial();

export const assemblyComponentsSchema = z.object({
  components: z.array(assemblyComponentSchema).max(500),
});

export const assemblyListQuery = pageQuerySchema.extend({
  search: z.string().max(200).optional(),
  status: z.enum(ASSEMBLY_STATUSES).optional(),
  trade: z.string().max(120).optional(),
  projectId: idRef.optional(),
});

export const crewMemberSchema = z.object({
  trade: z.string().min(1).max(120),
  count: nonNegative,
  hourlyRate: nonNegative,
});

export const crewEquipmentSchema = z.object({
  description: z.string().min(1).max(200),
  count: nonNegative,
  hourlyRate: nonNegative,
});

export const crewCreateSchema = z.object({
  projectId: idRef.nullable().optional(),
  code: z.string().trim().min(1).max(80),
  name: z.string().min(1).max(200),
  description: z.string().max(20000).nullable().optional(),
  trade: z.string().max(120).nullable().optional(),
  currency: currencyCode.optional(),
  members: z.array(crewMemberSchema).max(60).optional(),
  equipment: z.array(crewEquipmentSchema).max(60).optional(),
  detail: detailBag.optional(),
});

export const crewPatchSchema = crewCreateSchema
  .omit({ projectId: true, code: true })
  .extend({ status: z.enum(CREW_DEFINITION_STATUSES).optional() })
  .partial();

export const productionRateCreateSchema = z.object({
  projectId: idRef.nullable().optional(),
  code: z.string().trim().min(1).max(80),
  description: z.string().min(1).max(500),
  unit: z.string().min(1).max(24),
  trade: z.string().max(120).nullable().optional(),
  crewId: idRef.nullable().optional(),
  basis: z.enum(PRODUCTION_RATE_BASES).optional(),
  value: nonNegative,
  conditions: z.string().max(20000).nullable().optional(),
  source: z.enum(CATALOGUE_ITEM_SOURCES).optional(),
  sourceReference: z.string().max(500).nullable().optional(),
  region: z.string().max(80).nullable().optional(),
  rateAsAt: isoDate.nullable().optional(),
  detail: detailBag.optional(),
});

export const productionRatePatchSchema = productionRateCreateSchema
  .omit({ projectId: true, code: true })
  .extend({ status: z.enum(CATALOGUE_ITEM_STATUSES).optional() })
  .partial();

export const libraryListQuery = pageQuerySchema.extend({
  search: z.string().max(200).optional(),
  status: z.string().max(40).optional(),
  trade: z.string().max(120).optional(),
  projectId: idRef.optional(),
});

/* ------------------------------------------------------------------ */
/* Estimates                                                           */
/* ------------------------------------------------------------------ */

export const estimateCreateSchema = z.object({
  name: z.string().min(1).max(300),
  description: z.string().max(20000).nullable().optional(),
  estimateType: z.enum(ESTIMATE_TYPES).optional(),
  currency: currencyCode.optional(),
  basis: z.string().max(20000).nullable().optional(),
  accuracyRange: z.number().finite().min(0).max(5).nullable().optional(),
  quantityBasis: money.nullable().optional(),
  quantityBasisUnit: z.string().max(24).nullable().optional(),
  sourceType: z.enum(["change_event", "bid_package", "manual"]).nullable().optional(),
  sourceId: idRef.nullable().optional(),
  notes: z.string().max(20000).nullable().optional(),
  detail: detailBag.optional(),
});

export const estimatePatchSchema = estimateCreateSchema.partial();

export const estimateListQuery = pageQuerySchema.extend({
  status: z.enum(ESTIMATE_STATUSES).optional(),
  estimateType: z.enum(ESTIMATE_TYPES).optional(),
  search: z.string().max(200).optional(),
  rootId: idRef.optional(),
  sourceType: z.string().max(40).optional(),
  sourceId: idRef.optional(),
  /** only the live head of each version chain */
  headsOnly: z.enum(["true", "false"]).optional(),
});

export const sectionCreateSchema = z.object({
  name: z.string().min(1).max(300),
  code: z.string().max(80).nullable().optional(),
  description: z.string().max(20000).nullable().optional(),
  parentId: idRef.nullable().optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
  detail: detailBag.optional(),
});

export const sectionPatchSchema = sectionCreateSchema.partial();

export const lineCreateSchema = z.object({
  sectionId: idRef.nullable().optional(),
  itemCode: z.string().max(80).nullable().optional(),
  description: z.string().min(1).max(1000),
  longDescription: z.string().max(20000).nullable().optional(),
  costCodeId: idRef.nullable().optional(),
  costCode: z.string().max(80).nullable().optional(),
  costType: z.enum(COST_TYPES).optional(),
  status: z.enum(ESTIMATE_LINE_STATUSES).optional(),
  source: z.enum(ESTIMATE_LINE_SOURCES).optional(),
  unit: z.string().max(24).nullable().optional(),
  /** the measured/entered quantity BEFORE waste */
  quantity: money.optional(),
  wastePercent: percent.optional(),
  rates: rateSplitSchema.optional(),
  catalogueItemId: idRef.nullable().optional(),
  takeoffItemId: idRef.nullable().optional(),
  subQuoteLineId: idRef.nullable().optional(),
  crewId: idRef.nullable().optional(),
  productionRate: nonNegative.nullable().optional(),
  productionRateBasis: z.enum(PRODUCTION_RATE_BASES).nullable().optional(),
  rateAsAt: isoDate.nullable().optional(),
  position: z.number().int().min(0).max(1000000).optional(),
  notes: z.string().max(20000).nullable().optional(),
  detail: detailBag.optional(),
});

export const linePatchSchema = lineCreateSchema.partial();

export const lineBulkSchema = z.object({
  lines: z.array(lineCreateSchema).min(1).max(500),
});

export const lineListQuery = pageQuerySchema.extend({
  sectionId: idRef.optional(),
  costType: z.enum(COST_TYPES).optional(),
  status: z.enum(ESTIMATE_LINE_STATUSES).optional(),
  source: z.enum(ESTIMATE_LINE_SOURCES).optional(),
  search: z.string().max(200).optional(),
});

export const fromTakeoffSchema = z.object({
  takeoffItemIds: z.array(idRef).min(1).max(200),
  sectionId: idRef.nullable().optional(),
  catalogueItemId: idRef.nullable().optional(),
  rates: rateSplitSchema.optional(),
  wastePercent: percent.optional(),
  costType: z.enum(COST_TYPES).optional(),
});

export const fromAssemblySchema = z.object({
  assemblyId: idRef,
  quantity: money,
  sectionId: idRef.nullable().optional(),
  description: z.string().max(1000).optional(),
  /** keep the components as their own lines under a parent (#191) */
  expandComponents: z.boolean().optional(),
});

export const markupCreateSchema = z.object({
  kind: z.enum(ESTIMATE_MARKUP_KINDS).optional(),
  name: z.string().min(1).max(200),
  method: z.enum(ESTIMATE_MARKUP_METHODS).optional(),
  basis: z.enum(ESTIMATE_MARKUP_BASES).optional(),
  rate: money,
  costTypes: z.array(z.enum(COST_TYPES)).max(6).optional(),
  sectionIds: z.array(idRef).max(60).optional(),
  quantity: money.nullable().optional(),
  sequence: z.number().int().min(0).max(1000).optional(),
  rationale: z.string().max(20000).nullable().optional(),
  enabled: z.boolean().optional(),
  detail: detailBag.optional(),
});

export const markupPatchSchema = markupCreateSchema.partial();

export const versionCreateSchema = z.object({
  name: z.string().min(1).max(300).optional(),
  notes: z.string().max(20000).nullable().optional(),
  basis: z.string().max(20000).nullable().optional(),
  estimateType: z.enum(ESTIMATE_TYPES).optional(),
});

export const compareQuery = z.object({
  against: idRef,
  includeUnchanged: z.enum(["true", "false"]).optional(),
});

export const approveSchema = z.object({
  note: z.string().max(20000).nullable().optional(),
});

export const rejectSchema = z.object({
  reason: z.string().min(1).max(20000),
});

export const convertSchema = z.object({
  budgetName: z.string().min(1).max(200).optional(),
  markupTreatment: z.enum(["separate_lines", "prorate", "exclude"]).optional(),
  uncodedCostCode: z.string().max(80).optional(),
  markupCostCodePrefix: z.string().max(40).optional(),
  includeAlternates: z.boolean().optional(),
  makeActive: z.boolean().optional(),
  /** preview only — return the plan without writing anything */
  dryRun: z.boolean().optional(),
});

export const pushChangeEventSchema = z.object({
  changeEventId: idRef,
  field: z.enum(["estimated", "latest", "both"]).optional(),
});

/* ------------------------------------------------------------------ */
/* Takeoff                                                             */
/* ------------------------------------------------------------------ */

export const layerCreateSchema = z.object({
  name: z.string().min(1).max(200),
  colour: colour.optional(),
  description: z.string().max(20000).nullable().optional(),
  costCodeId: idRef.nullable().optional(),
  costCode: z.string().max(80).nullable().optional(),
  measurementType: z.enum(TAKEOFF_MEASUREMENT_TYPES).nullable().optional(),
  unit: z.string().max(24).nullable().optional(),
  visible: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
  detail: detailBag.optional(),
});

export const layerPatchSchema = layerCreateSchema.partial();

export const pointSchema = z.object({ x: z.number().finite(), y: z.number().finite() });

export const geometrySchema = z.object({
  kind: z.enum(TAKEOFF_GEOMETRY_KINDS),
  points: z.array(pointSchema).max(5000),
  radius: z.number().finite().positive().optional(),
  closed: z.boolean().optional(),
});

export const takeoffCreateSchema = z.object({
  estimateId: idRef.nullable().optional(),
  layerId: idRef.nullable().optional(),
  name: z.string().min(1).max(300),
  description: z.string().max(20000).nullable().optional(),
  measurementType: z.enum(TAKEOFF_MEASUREMENT_TYPES),
  sheetId: idRef.nullable().optional(),
  sheetNumber: z.string().max(120).nullable().optional(),
  revisionId: idRef.nullable().optional(),
  pageNumber: z.number().int().min(1).max(10000).optional(),
  pixelsPerUnit: z.number().finite().positive().nullable().optional(),
  scaleUnit: z.enum(LENGTH_UNITS).nullable().optional(),
  scaleLabel: z.string().max(120).nullable().optional(),
  geometry: geometrySchema.nullable().optional(),
  depth: money.nullable().optional(),
  height: money.nullable().optional(),
  deduction: money.optional(),
  multiplier: money.optional(),
  manualRawValue: money.nullable().optional(),
  unit: z.string().max(24).nullable().optional(),
  costCodeId: idRef.nullable().optional(),
  costCode: z.string().max(80).nullable().optional(),
  colour: colour.nullable().optional(),
  notes: z.string().max(20000).nullable().optional(),
  status: z.enum(TAKEOFF_STATUSES).optional(),
  detail: detailBag.optional(),
});

export const takeoffPatchSchema = takeoffCreateSchema.partial();

export const takeoffListQuery = pageQuerySchema.extend({
  estimateId: idRef.optional(),
  layerId: idRef.optional(),
  sheetId: idRef.optional(),
  status: z.enum(TAKEOFF_STATUSES).optional(),
  measurementType: z.enum(TAKEOFF_MEASUREMENT_TYPES).optional(),
  search: z.string().max(200).optional(),
  /** only measurements no estimate line references */
  unpricedOnly: z.enum(["true", "false"]).optional(),
});

export const measurePreviewSchema = takeoffCreateSchema
  .pick({
    measurementType: true,
    geometry: true,
    pixelsPerUnit: true,
    scaleUnit: true,
    depth: true,
    height: true,
    deduction: true,
    multiplier: true,
    manualRawValue: true,
    unit: true,
  })
  .extend({ measurementType: z.enum(TAKEOFF_MEASUREMENT_TYPES) });

export const calibrateSchema = z.union([
  z.object({
    mode: z.literal("reference"),
    drawnLength: z.number().finite().positive(),
    realLength: z.number().finite().positive(),
    unit: z.enum(LENGTH_UNITS),
  }),
  z.object({
    mode: z.literal("ratio"),
    ratio: z.number().finite().positive(),
    unit: z.enum(LENGTH_UNITS),
    paperUnitsPerMm: z.number().finite().positive().optional(),
  }),
]);

/* ------------------------------------------------------------------ */
/* Sub-quotes                                                          */
/* ------------------------------------------------------------------ */

export const subQuoteLineSchema = z.object({
  itemCode: z.string().max(80).nullable().optional(),
  description: z.string().min(1).max(1000),
  scopeKey: z.string().max(200).nullable().optional(),
  unit: z.string().max(24).nullable().optional(),
  quantity: money.nullable().optional(),
  unitRate: money.nullable().optional(),
  amount: money.optional(),
  costCodeId: idRef.nullable().optional(),
  costCode: z.string().max(80).nullable().optional(),
  costType: z.enum(COST_TYPES).optional(),
  excluded: z.boolean().optional(),
  note: z.string().max(20000).nullable().optional(),
});

export const subQuoteCreateSchema = z.object({
  estimateId: idRef.nullable().optional(),
  vendorId: idRef.nullable().optional(),
  vendorName: z.string().min(1).max(300),
  tradePackage: z.string().min(1).max(200),
  currency: currencyCode.optional(),
  quotedTotal: money.optional(),
  adjustmentAmount: money.optional(),
  quoteDate: isoDate.nullable().optional(),
  validUntil: isoDate.nullable().optional(),
  inclusions: z.string().max(20000).nullable().optional(),
  exclusions: z.string().max(20000).nullable().optional(),
  qualifications: z.string().max(20000).nullable().optional(),
  notes: z.string().max(20000).nullable().optional(),
  documentIds: z.array(idRef).max(50).optional(),
  lines: z.array(subQuoteLineSchema).max(500).optional(),
  detail: detailBag.optional(),
});

export const subQuotePatchSchema = subQuoteCreateSchema
  .omit({ lines: true })
  .extend({ status: z.enum(SUB_QUOTE_STATUSES).optional() })
  .partial();

export const subQuoteLinesSchema = z.object({
  lines: z.array(subQuoteLineSchema).max(500),
});

export const subQuoteListQuery = pageQuerySchema.extend({
  estimateId: idRef.optional(),
  status: z.enum(SUB_QUOTE_STATUSES).optional(),
  tradePackage: z.string().max(200).optional(),
  vendorId: idRef.optional(),
  search: z.string().max(200).optional(),
});

export const importBidSchema = z.object({
  submissionId: idRef,
  estimateId: idRef.nullable().optional(),
  tradePackage: z.string().max(200).optional(),
});

export const levellingQuery = z.object({
  tradePackage: z.string().max(200).optional(),
  estimateId: idRef.optional(),
  includeExpired: z.enum(["true", "false"]).optional(),
});

export const acceptQuoteSchema = z.object({
  estimateId: idRef,
  sectionId: idRef.nullable().optional(),
  /** only these quote lines; omit for every non-excluded line */
  lineIds: z.array(idRef).max(500).optional(),
});

/* ------------------------------------------------------------------ */
/* Proposals                                                           */
/* ------------------------------------------------------------------ */

export const proposalCreateSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  clientName: z.string().max(300).nullable().optional(),
  detailLevel: z.enum(["summary", "section", "line"]).optional(),
  validUntil: isoDate.nullable().optional(),
  coveringNote: z.string().max(50000).nullable().optional(),
  exclusions: z.string().max(50000).nullable().optional(),
  assumptions: z.string().max(50000).nullable().optional(),
  detail: detailBag.optional(),
});

export const proposalListQuery = pageQuerySchema.extend({
  estimateId: idRef.optional(),
  status: z.enum(ESTIMATE_PROPOSAL_STATUSES).optional(),
});

export const proposalStatusSchema = z.object({
  status: z.enum(["issued", "accepted", "declined", "superseded"]),
  note: z.string().max(20000).nullable().optional(),
});

export const benchmarkQuery = z.object({
  costCode: z.string().max(80).optional(),
  search: z.string().max(200).optional(),
  unit: z.string().max(24).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const riskListQuery = pageQuerySchema.extend({
  includeClosed: z.enum(["true", "false"]).optional(),
});
