/**
 * Server-resolved workflow context.
 *
 * A step condition such as `cost gt 50000` used to be evaluated against a
 * JSON blob the CALLER supplied at start. That is not a control: the client
 * that wants to avoid the approval simply sends `{ cost: 1 }`, or omits the
 * field entirely. The values a condition branches on must come from the
 * stored record.
 *
 * This is the registry that does it: recordType → a loader that reads the
 * record inside the caller's tenant and project and returns its decision-
 * relevant fields. Anything a loader returns OVERRIDES the client-supplied
 * context; fields the loader does not know about are kept from the caller
 * (so a bespoke record type still works) but marked, so the response can say
 * which values were taken on trust.
 *
 * Covers the audit's "server-resolved context" upgrade and the fail-closed
 * half of #82.
 */
import { and, eq } from "drizzle-orm";
import {
  changeEvents,
  commitments,
  invoices,
  punchItems,
  rfis,
  submittals,
} from "@constructos/db";
import type { Db } from "../../lib/db.js";

export interface ResolvedContext {
  /** the merged context conditions evaluate against */
  context: Record<string, unknown>;
  /** true when the record type has a loader and the record was found */
  recordResolved: boolean;
  /** field names taken from the caller because nothing on the server knew them */
  clientSupplied: string[];
  /** field names the server resolved (these override the caller) */
  serverResolved: string[];
}

type Loader = (
  db: Db,
  args: { companyId: string; projectId: string; recordId: string },
) => Promise<Record<string, unknown> | null>;

const loaders: Record<string, Loader> = {
  rfi: async (db, a) => {
    const rows = await db
      .select({
        status: rfis.status,
        number: rfis.number,
        subject: rfis.subject,
        costImpact: rfis.costImpact,
        scheduleImpact: rfis.scheduleImpact,
        scheduleImpactDays: rfis.scheduleImpactDays,
        assigneeId: rfis.assigneeId,
        dueDate: rfis.dueDate,
      })
      .from(rfis)
      .where(and(eq(rfis.id, a.recordId), eq(rfis.companyId, a.companyId), eq(rfis.projectId, a.projectId)))
      .limit(1);
    return rows[0] ?? null;
  },
  submittal: async (db, a) => {
    const rows = await db
      .select({
        status: submittals.status,
        number: submittals.number,
        title: submittals.title,
        specSection: submittals.specSection,
        submittalType: submittals.submittalType,
        requiredOnSite: submittals.requiredOnSite,
      })
      .from(submittals)
      .where(
        and(
          eq(submittals.id, a.recordId),
          eq(submittals.companyId, a.companyId),
          eq(submittals.projectId, a.projectId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  commitment: async (db, a) => {
    const rows = await db
      .select({
        status: commitments.status,
        reference: commitments.reference,
        title: commitments.title,
        vendorId: commitments.vendorId,
        currency: commitments.currency,
        cost: commitments.revisedCommitmentSum,
        originalCommitmentSum: commitments.originalCommitmentSum,
        kind: commitments.kind,
      })
      .from(commitments)
      .where(
        and(
          eq(commitments.id, a.recordId),
          eq(commitments.companyId, a.companyId),
          eq(commitments.projectId, a.projectId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  invoice: async (db, a) => {
    const rows = await db
      .select({
        status: invoices.status,
        reference: invoices.reference,
        currency: invoices.currency,
        cost: invoices.total,
        currentPaymentDue: invoices.currentPaymentDue,
        vendorId: invoices.vendorId,
        kind: invoices.kind,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.id, a.recordId),
          eq(invoices.companyId, a.companyId),
          eq(invoices.projectId, a.projectId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  change_event: async (db, a) => {
    const rows = await db
      .select({
        status: changeEvents.status,
        reference: changeEvents.reference,
        title: changeEvents.title,
        cost: changeEvents.latestCost,
        estimatedCost: changeEvents.estimatedCost,
        scheduleImpactDays: changeEvents.scheduleImpactDays,
        eventType: changeEvents.eventType,
      })
      .from(changeEvents)
      .where(
        and(
          eq(changeEvents.id, a.recordId),
          eq(changeEvents.companyId, a.companyId),
          eq(changeEvents.projectId, a.projectId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  punch: async (db, a) => {
    const rows = await db
      .select({
        status: punchItems.status,
        number: punchItems.number,
        title: punchItems.title,
        priority: punchItems.priority,
        assigneeId: punchItems.assigneeId,
        vendorId: punchItems.vendorId,
      })
      .from(punchItems)
      .where(
        and(
          eq(punchItems.id, a.recordId),
          eq(punchItems.companyId, a.companyId),
          eq(punchItems.projectId, a.projectId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
};

/** Record types whose fields the server can resolve for itself. */
export function resolvableRecordTypes(): string[] {
  return Object.keys(loaders).sort();
}

export async function resolveWorkflowContext(
  db: Db,
  args: {
    companyId: string;
    projectId: string;
    recordType: string;
    recordId: string;
    clientContext: Record<string, unknown>;
  },
): Promise<ResolvedContext> {
  const loader = loaders[args.recordType];
  const client = { ...args.clientContext };
  if (!loader) {
    return {
      context: client,
      recordResolved: false,
      clientSupplied: Object.keys(client).sort(),
      serverResolved: [],
    };
  }
  const record = await loader(db, {
    companyId: args.companyId,
    projectId: args.projectId,
    recordId: args.recordId,
  });
  if (!record) {
    return {
      context: client,
      recordResolved: false,
      clientSupplied: Object.keys(client).sort(),
      serverResolved: [],
    };
  }
  const server: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    server[key] = value;
  }
  const serverKeys = Object.keys(server);
  const merged = { ...client, ...server };
  return {
    context: merged,
    recordResolved: true,
    clientSupplied: Object.keys(client)
      .filter((k) => !serverKeys.includes(k))
      .sort(),
    serverResolved: serverKeys.sort(),
  };
}
