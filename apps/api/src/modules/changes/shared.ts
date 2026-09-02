import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from "fastify";
import {
  changeEvents,
  changeLineItems,
  changeOrderPackages,
  changeOrderRequests,
  changeQuoteRequests,
  changeStatusHistory,
  contractEvents,
  dailyLogs,
  drawingRevisions,
  drawingSheets,
  files,
  potentialChangeOrders,
  punchItems,
  rfis,
  scheduleTasks,
  submittals,
} from "@constructos/db";
import { COST_TYPES, MARKUP_KINDS, type ChangeEventOriginKind, type LedgerAction } from "@constructos/shared";
import { AppError, badRequest, conflict, notFound } from "../../lib/errors.js";
import { appendLedger } from "../../lib/ledger.js";
import { newId } from "../../lib/ids.js";
import type { Db } from "../../lib/db.js";
import { deriveChangeLine, MARKUP_BASES, type MarkupRule } from "./arithmetic.js";

/* ------------------------------------------------------------------ */
/* Small primitives                                                    */
/* ------------------------------------------------------------------ */

export const nowIso = (): string => new Date().toISOString();
export const todayIso = (): string => new Date().toISOString().slice(0, 10);
export const pad3 = (n: number): string => String(n).padStart(3, "0");

/** ISO calendar date (YYYY-MM-DD). Dates on this module are legally load-bearing. */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected an ISO date (YYYY-MM-DD)")
  .refine((s) => !Number.isNaN(Date.parse(s)), "not a real calendar date");

export const idSchema = z.string().min(1).max(64);
export const moneySchema = z.number().finite();
export const detailSchema = z.record(z.string(), z.unknown());

export type ActorRequest = FastifyRequest & {
  companyId?: string;
  projectId?: string;
  user?: { id: string };
};

export const actorOf = (req: FastifyRequest): string => (req as ActorRequest).user!.id;
export const companyOf = (req: FastifyRequest): string => (req as ActorRequest).companyId!;
export const projectOf = (req: FastifyRequest): string => (req as ActorRequest).projectId!;

/* ------------------------------------------------------------------ */
/* Gates                                                               */
/* ------------------------------------------------------------------ */

export interface ChangeGates {
  read: preHandlerHookHandler[];
  standard: preHandlerHookHandler[];
  admin: preHandlerHookHandler[];
}

/**
 * `change_management` is one tool key across the whole chain. Reading a change
 * log is `read`; raising and pricing anything is `standard`; EXECUTING a
 * package — the act that moves three ledgers at once — is `admin`, because it
 * is the only operation in the module that a mistake cannot be edited out of.
 */
export function changeGates(app: FastifyInstance): ChangeGates {
  return {
    read: [app.authenticate, app.requireCompany, app.requireTool("change_management", "read")],
    standard: [
      app.authenticate,
      app.requireCompany,
      app.requireTool("change_management", "standard"),
    ],
    admin: [app.authenticate, app.requireCompany, app.requireTool("change_management", "admin")],
  };
}

/* ------------------------------------------------------------------ */
/* Ledger                                                              */
/* ------------------------------------------------------------------ */

export async function ledgerChange(
  db: Db,
  req: FastifyRequest,
  action: LedgerAction,
  objectType: string,
  objectId: string,
  payload: Record<string, unknown>,
  options: { storePayload?: boolean } = {},
): Promise<void> {
  await appendLedger(db, {
    companyId: companyOf(req),
    actorId: actorOf(req),
    action,
    objectType,
    objectId,
    projectId: projectOf(req),
    payload: { projectId: projectOf(req), ...payload },
    storePayload: options.storePayload ?? false,
  });
  /*
   * Every status transition on the chain is ALSO materialised for the ageing
   * and cycle-time analytics (#560–562). One hook point, so a transition
   * cannot be ledgered without being dated here.
   */
  if (action === "state_change" && typeof payload["to"] === "string" && CHAIN_OBJECT_TYPES.has(objectType)) {
    await db.insert(changeStatusHistory).values({
      id: newId("csh"),
      companyId: companyOf(req),
      projectId: projectOf(req),
      objectType,
      objectId,
      fromStatus: typeof payload["from"] === "string" ? (payload["from"] as string) : null,
      toStatus: payload["to"] as string,
      actorId: actorOf(req),
    });
  }
}

const CHAIN_OBJECT_TYPES = new Set([
  "change_event",
  "potential_change_order",
  "change_quote_request",
  "change_order_request",
  "change_order_package",
]);

/* ------------------------------------------------------------------ */
/* Segregation of duties (ADR 0004)                                    */
/* ------------------------------------------------------------------ */

/**
 * The approver may be neither the author, nor the submitter, nor the
 * requester. Enforced at the route rather than in an editable workflow
 * template, because self-approval is the single most common financial control
 * failure on a construction project and the control is worthless if the
 * controlled party can configure it away.
 */
export function assertSegregation(
  actorId: string,
  parties: {
    createdBy?: string | null;
    submittedBy?: string | null;
    requestedBy?: string | null;
    approvedBy?: string | null;
  },
  what: string,
): void {
  const checks: Array<[string | null | undefined, string, string]> = [
    [parties.createdBy, "created_by", `the author of this ${what} may not approve it`],
    [parties.submittedBy, "submitted_by", `the person who submitted this ${what} may not approve it`],
    [parties.requestedBy, "requested_by", `the person who requested this ${what} may not approve it`],
  ];
  for (const [party, role, message] of checks) {
    if (party && party === actorId) {
      throw new AppError(403, `Segregation of duties: ${message}.`, {
        control: "no_self_approval",
        role,
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Status transitions                                                  */
/* ------------------------------------------------------------------ */

/** Refuse a transition rather than silently no-op it. */
export function assertTransition(
  current: string,
  allowedFrom: readonly string[],
  what: string,
  action: string,
): void {
  if (!allowedFrom.includes(current)) {
    throw conflict(
      `Cannot ${action} a ${what} that is "${current}" — only ${allowedFrom
        .map((s) => `"${s}"`)
        .join(", ")}.`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Currency discipline                                                 */
/* ------------------------------------------------------------------ */

/**
 * Two records only participate in the same arithmetic if they are denominated
 * in the same currency. There is no FX in this module by design: a change
 * order that crosses currencies is a commercial decision someone has to make
 * explicitly, not a multiplication we make quietly.
 */
export function assertSameCurrency(
  parts: ReadonlyArray<{ label: string; currency: string }>,
): string {
  const seen = new Map<string, string[]>();
  for (const part of parts) {
    const cur = part.currency.toUpperCase();
    const list = seen.get(cur) ?? [];
    list.push(part.label);
    seen.set(cur, list);
  }
  if (seen.size <= 1) return [...seen.keys()][0] ?? "USD";
  const description = [...seen.entries()]
    .map(([cur, labels]) => `${cur} (${labels.join(", ")})`)
    .join(" vs ");
  throw badRequest(
    `This change spans more than one currency — ${description}. Money is never summed across ` +
      "currencies here; raise a separate change on each contract.",
  );
}

/* ------------------------------------------------------------------ */
/* Origin provenance                                                   */
/* ------------------------------------------------------------------ */

export interface OriginVerification {
  originType: ChangeEventOriginKind;
  originId: string | null;
  /** true when the platform holds the record and it belongs to this project */
  verified: boolean;
  /** a human label for the source record, when we could read one */
  label: string | null;
  /** why it could not be verified */
  reasons: string[];
}

/**
 * Prove the provenance link, or say plainly that we could not.
 *
 * A change event's whole evidential value is that it points at the record that
 * caused it — an answered RFI, a superseded drawing, a daily log. So the link
 * is CHECKED: the id must exist and must belong to this project. Origin kinds
 * the platform holds no table for (a meeting minute, an inspection report) are
 * accepted but marked unverified rather than silently blessed.
 */
export async function verifyOrigin(
  db: Db,
  companyId: string,
  projectId: string,
  originType: ChangeEventOriginKind,
  originId: string | null,
): Promise<OriginVerification> {
  const base: OriginVerification = { originType, originId, verified: false, label: null, reasons: [] };
  if (originType === "manual") {
    return { ...base, verified: true, label: "Raised manually", reasons: [] };
  }
  if (!originId) {
    return {
      ...base,
      reasons: [
        `originType "${originType}" claims this change came from a record, so originId is ` +
          "required. Use \"manual\" for a change nobody can point at a document for.",
      ],
    };
  }

  const found = async <T extends { id: string }>(
    rows: T[],
    label: (row: T) => string,
  ): Promise<OriginVerification> => {
    const row = rows[0];
    if (!row) {
      return {
        ...base,
        reasons: [
          `No ${originType.replace(/_/g, " ")} with id ${originId} exists on this project. A ` +
            "provenance link that does not resolve is worse than none.",
        ],
      };
    }
    return { ...base, verified: true, label: label(row) };
  };

  switch (originType) {
    case "rfi": {
      const rows = await db
        .select({ id: rfis.id, number: rfis.number, subject: rfis.subject, status: rfis.status })
        .from(rfis)
        .where(and(eq(rfis.id, originId), eq(rfis.companyId, companyId), eq(rfis.projectId, projectId)))
        .limit(1);
      return found(rows, (r) => `RFI-${pad3(r.number)} ${r.subject}`);
    }
    case "submittal": {
      const rows = await db
        .select({ id: submittals.id, number: submittals.number, title: submittals.title })
        .from(submittals)
        .where(
          and(
            eq(submittals.id, originId),
            eq(submittals.companyId, companyId),
            eq(submittals.projectId, projectId),
          ),
        )
        .limit(1);
      return found(rows, (r) => `SUB-${pad3(r.number)} ${r.title}`);
    }
    case "daily_log": {
      const rows = await db
        .select({ id: dailyLogs.id, logDate: dailyLogs.logDate })
        .from(dailyLogs)
        .where(
          and(
            eq(dailyLogs.id, originId),
            eq(dailyLogs.companyId, companyId),
            eq(dailyLogs.projectId, projectId),
          ),
        )
        .limit(1);
      return found(rows, (r) => `Daily log ${r.logDate}`);
    }
    case "punch_item": {
      const rows = await db
        .select({ id: punchItems.id, number: punchItems.number, title: punchItems.title })
        .from(punchItems)
        .where(
          and(
            eq(punchItems.id, originId),
            eq(punchItems.companyId, companyId),
            eq(punchItems.projectId, projectId),
          ),
        )
        .limit(1);
      return found(rows, (r) => `Punch ${pad3(r.number)} ${r.title}`);
    }
    case "drawing_revision": {
      // drawing_revisions carries no project column — the sheet does.
      const rows = await db
        .select({
          id: drawingRevisions.id,
          revision: drawingRevisions.revision,
          number: drawingSheets.number,
          title: drawingSheets.title,
        })
        .from(drawingRevisions)
        .innerJoin(drawingSheets, eq(drawingSheets.id, drawingRevisions.sheetId))
        .where(
          and(
            eq(drawingRevisions.id, originId),
            eq(drawingSheets.companyId, companyId),
            eq(drawingSheets.projectId, projectId),
          ),
        )
        .limit(1);
      return found(rows, (r) => `${r.number} rev ${r.revision} — ${r.title}`);
    }
    case "schedule_task": {
      const rows = await db
        .select({ id: scheduleTasks.id, name: scheduleTasks.name })
        .from(scheduleTasks)
        .where(and(eq(scheduleTasks.id, originId), eq(scheduleTasks.projectId, projectId)))
        .limit(1);
      return found(rows, (r) => `Task ${r.name}`);
    }
    case "contract_event": {
      const rows = await db
        .select({ id: contractEvents.id, number: contractEvents.number, title: contractEvents.title })
        .from(contractEvents)
        .where(
          and(
            eq(contractEvents.id, originId),
            eq(contractEvents.companyId, companyId),
            eq(contractEvents.projectId, projectId),
          ),
        )
        .limit(1);
      return found(rows, (r) => `Contract event ${pad3(r.number)} — ${r.title}`);
    }
    case "document": {
      const rows = await db
        .select({ id: files.id, name: files.name })
        .from(files)
        .where(and(eq(files.id, originId), eq(files.companyId, companyId)))
        .limit(1);
      return found(rows, (r) => r.name);
    }
    default:
      // observation / specification / meeting / inspection — no table on the
      // platform yet. Recorded, flagged, never silently blessed.
      return {
        ...base,
        verified: false,
        reasons: [
          `The platform holds no ${originType.replace(/_/g, " ")} register, so this provenance ` +
            "link is recorded but unverified.",
        ],
      };
  }
}

/* ------------------------------------------------------------------ */
/* Change lines                                                        */
/* ------------------------------------------------------------------ */

export const CHANGE_LINE_PARENTS = [
  "change_event",
  "potential_change_order",
  "change_quote_request",
  "change_order_request",
  "change_order_package",
  "prime_contract_change",
  "commitment_change",
] as const;
export type ChangeLineParent = (typeof CHANGE_LINE_PARENTS)[number];

export type ChangeLineRow = typeof changeLineItems.$inferSelect;

export const changeLineSchema = z.object({
  lineNumber: z.string().min(1).max(40).nullable().optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
  costCodeId: idSchema.nullable().optional(),
  costCode: z.string().min(1).max(60).nullable().optional(),
  costType: z.enum(COST_TYPES).optional(),
  budgetLineItemId: idSchema.nullable().optional(),
  description: z.string().min(1).max(2000),
  unit: z.string().max(30).nullable().optional(),
  quantity: moneySchema.nullable().optional(),
  unitRate: moneySchema.nullable().optional(),
  costAmount: moneySchema.nullable().optional(),
  revenueAmount: moneySchema.nullable().optional(),
  markupKind: z.enum(MARKUP_KINDS).nullable().optional(),
  markupPercent: moneySchema.nullable().optional(),
  markupAmount: moneySchema.nullable().optional(),
  taxPercent: moneySchema.nullable().optional(),
  taxAmount: moneySchema.nullable().optional(),
  vendorId: idSchema.nullable().optional(),
  commitmentSovLineId: idSchema.nullable().optional(),
  primeContractSovLineId: idSchema.nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  detail: detailSchema.optional(),
});
export type ChangeLineInputBody = z.infer<typeof changeLineSchema>;

export const markupRuleSchema = z.object({
  kind: z.enum(MARKUP_KINDS),
  label: z.string().min(1).max(80),
  basis: z.enum(MARKUP_BASES),
  rate: moneySchema,
  costTypes: z.array(z.enum(COST_TYPES)).max(COST_TYPES.length).nullable().optional(),
  maxAmount: moneySchema.nullable().optional(),
  sequence: z.number().int().min(0).max(1000).nullable().optional(),
});

/** Read markups off a stored jsonb column without trusting their shape. */
export function readMarkups(stored: unknown): MarkupRule[] {
  if (!Array.isArray(stored)) return [];
  const out: MarkupRule[] = [];
  for (const raw of stored) {
    const parsed = markupRuleSchema.safeParse(raw);
    if (parsed.success) {
      out.push({
        kind: parsed.data.kind,
        label: parsed.data.label,
        basis: parsed.data.basis,
        rate: parsed.data.rate,
        costTypes: parsed.data.costTypes ?? null,
        maxAmount: parsed.data.maxAmount ?? null,
        sequence: parsed.data.sequence ?? null,
      });
    }
  }
  return out;
}

export async function loadLines(
  db: Db,
  parentType: ChangeLineParent,
  parentId: string,
): Promise<ChangeLineRow[]> {
  return db
    .select()
    .from(changeLineItems)
    .where(and(eq(changeLineItems.parentType, parentType), eq(changeLineItems.parentId, parentId)))
    .orderBy(asc(changeLineItems.sortOrder), asc(changeLineItems.createdAt));
}

export async function loadLinesForParents(
  db: Db,
  parentType: ChangeLineParent,
  parentIds: readonly string[],
): Promise<ChangeLineRow[]> {
  if (parentIds.length === 0) return [];
  return db
    .select()
    .from(changeLineItems)
    .where(
      and(
        eq(changeLineItems.parentType, parentType),
        inArray(changeLineItems.parentId, [...parentIds]),
      ),
    )
    .orderBy(asc(changeLineItems.sortOrder), asc(changeLineItems.createdAt));
}

export interface LineContext {
  companyId: string;
  projectId: string;
  changeEventId: string | null;
  createdBy: string;
}

/** Build the insert row for one change line, refusing an ambiguous price. */
export function buildLineRow(
  ctx: LineContext,
  parentType: ChangeLineParent,
  parentId: string,
  body: ChangeLineInputBody,
  fallbackSort: number,
): typeof changeLineItems.$inferInsert {
  const derivation = deriveChangeLine({
    quantity: body.quantity ?? null,
    unitRate: body.unitRate ?? null,
    costAmount: body.costAmount ?? null,
    revenueAmount: body.revenueAmount ?? null,
    markupKind: body.markupKind ?? null,
    markupPercent: body.markupPercent ?? null,
    markupAmount: body.markupAmount ?? null,
    taxPercent: body.taxPercent ?? null,
    taxAmount: body.taxAmount ?? null,
  });
  if (!derivation.ok) throw badRequest(derivation.error);
  const line = derivation.line;
  return {
    id: newId("cli"),
    companyId: ctx.companyId,
    projectId: ctx.projectId,
    parentType,
    parentId,
    changeEventId: ctx.changeEventId,
    lineNumber: body.lineNumber ?? null,
    sortOrder: body.sortOrder ?? fallbackSort,
    costCodeId: body.costCodeId ?? null,
    costCode: body.costCode ?? null,
    costType: body.costType ?? "other",
    budgetLineItemId: body.budgetLineItemId ?? null,
    description: body.description,
    unit: body.unit ?? null,
    quantity: body.quantity ?? null,
    unitRate: body.unitRate ?? null,
    costAmount: line.costAmount,
    revenueAmount: line.revenueAmount,
    markupKind: body.markupKind ?? null,
    markupPercent: body.markupPercent ?? null,
    markupAmount: line.markupAmount,
    taxPercent: body.taxPercent ?? null,
    taxAmount: line.taxAmount,
    vendorId: body.vendorId ?? null,
    commitmentSovLineId: body.commitmentSovLineId ?? null,
    primeContractSovLineId: body.primeContractSovLineId ?? null,
    notes: body.notes ?? null,
    detail: body.detail ?? {},
    createdBy: ctx.createdBy,
  };
}

/**
 * Copy a set of lines forward to the next stage of the chain. Provenance is
 * kept in `detail.copiedFrom` so a COR line can be traced back to the PCO line
 * and, through it, to the quote that priced it — which is exactly what an
 * owner asks for when they challenge a number.
 */
export function copyLineRow(
  source: ChangeLineRow,
  ctx: LineContext,
  parentType: ChangeLineParent,
  parentId: string,
  sortOrder: number,
): typeof changeLineItems.$inferInsert {
  return {
    id: newId("cli"),
    companyId: ctx.companyId,
    projectId: ctx.projectId,
    parentType,
    parentId,
    changeEventId: ctx.changeEventId ?? source.changeEventId,
    lineNumber: source.lineNumber,
    sortOrder,
    costCodeId: source.costCodeId,
    costCode: source.costCode,
    costType: source.costType,
    budgetLineItemId: source.budgetLineItemId,
    description: source.description,
    unit: source.unit,
    quantity: source.quantity,
    unitRate: source.unitRate,
    costAmount: source.costAmount,
    revenueAmount: source.revenueAmount,
    markupKind: source.markupKind,
    markupPercent: source.markupPercent,
    markupAmount: source.markupAmount,
    taxPercent: source.taxPercent,
    taxAmount: source.taxAmount,
    vendorId: source.vendorId,
    commitmentSovLineId: source.commitmentSovLineId,
    primeContractSovLineId: source.primeContractSovLineId,
    notes: source.notes,
    detail: {
      ...(source.detail ?? {}),
      copiedFrom: { lineId: source.id, parentType: source.parentType, parentId: source.parentId },
    },
    createdBy: ctx.createdBy,
  };
}

/* ------------------------------------------------------------------ */
/* Fetch helpers                                                       */
/* ------------------------------------------------------------------ */

export type EventRowT = typeof changeEvents.$inferSelect;
export type PcoRowT = typeof potentialChangeOrders.$inferSelect;
export type QuoteRowT = typeof changeQuoteRequests.$inferSelect;
export type CorRowT = typeof changeOrderRequests.$inferSelect;
export type PackageRowT = typeof changeOrderPackages.$inferSelect;

export async function fetchEvent(
  db: Db,
  id: string,
  companyId: string,
  projectId: string,
): Promise<EventRowT> {
  const rows = await db
    .select()
    .from(changeEvents)
    .where(
      and(
        eq(changeEvents.id, id),
        eq(changeEvents.companyId, companyId),
        eq(changeEvents.projectId, projectId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound("Change event not found on this project");
  return rows[0];
}

export async function fetchPco(
  db: Db,
  id: string,
  companyId: string,
  projectId: string,
): Promise<PcoRowT> {
  const rows = await db
    .select()
    .from(potentialChangeOrders)
    .where(
      and(
        eq(potentialChangeOrders.id, id),
        eq(potentialChangeOrders.companyId, companyId),
        eq(potentialChangeOrders.projectId, projectId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound("Potential change order not found on this project");
  return rows[0];
}

export async function fetchQuote(
  db: Db,
  id: string,
  companyId: string,
  projectId: string,
): Promise<QuoteRowT> {
  const rows = await db
    .select()
    .from(changeQuoteRequests)
    .where(
      and(
        eq(changeQuoteRequests.id, id),
        eq(changeQuoteRequests.companyId, companyId),
        eq(changeQuoteRequests.projectId, projectId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound("Quote request not found on this project");
  return rows[0];
}

export async function fetchCor(
  db: Db,
  id: string,
  companyId: string,
  projectId: string,
): Promise<CorRowT> {
  const rows = await db
    .select()
    .from(changeOrderRequests)
    .where(
      and(
        eq(changeOrderRequests.id, id),
        eq(changeOrderRequests.companyId, companyId),
        eq(changeOrderRequests.projectId, projectId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound("Change order request not found on this project");
  return rows[0];
}

export async function fetchPackage(
  db: Db,
  id: string,
  companyId: string,
  projectId: string,
): Promise<PackageRowT> {
  const rows = await db
    .select()
    .from(changeOrderPackages)
    .where(
      and(
        eq(changeOrderPackages.id, id),
        eq(changeOrderPackages.companyId, companyId),
        eq(changeOrderPackages.projectId, projectId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound("Change order package not found on this project");
  return rows[0];
}
