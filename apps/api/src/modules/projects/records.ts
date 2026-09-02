/**
 * The record-type registry.
 *
 * `watchers`, `custom_field_values`, `comments`, `tag_assignments` and
 * `record_links` all address an arbitrary record by `(recordType, recordId)`.
 * Those two strings are supplied by the caller, and a record id is not unique
 * across tenants — so before the tenant columns landed, a caller with read on
 * one project could attach to, or read from, a record belonging to another
 * company entirely.
 *
 * The tenant columns close the leak. This registry closes the rest: for the
 * record types the substrate can see, it checks that the id really does name
 * a record in THIS project before a watcher or a custom value is attached to
 * it. Types it does not know (a module that lands after this one) are allowed
 * through — the tenant columns still scope every later read — and the caller
 * is told which case applied.
 */
import { and, eq } from "drizzle-orm";
import {
  assets,
  bimModels,
  changeEvents,
  commitments,
  drawingSheets,
  equipment,
  invoices,
  meetings,
  nonConformanceReports,
  punchItems,
  rfis,
  risks,
  safetyIncidents,
  submittals,
} from "@constructos/db";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Db } from "../../lib/db.js";

interface RecordTable {
  table: PgTable;
  id: PgColumn;
  companyId: PgColumn;
  projectId: PgColumn;
}

const REGISTRY: Record<string, RecordTable> = {
  rfi: { table: rfis, id: rfis.id, companyId: rfis.companyId, projectId: rfis.projectId },
  submittal: {
    table: submittals,
    id: submittals.id,
    companyId: submittals.companyId,
    projectId: submittals.projectId,
  },
  punch: {
    table: punchItems,
    id: punchItems.id,
    companyId: punchItems.companyId,
    projectId: punchItems.projectId,
  },
  drawing_sheet: {
    table: drawingSheets,
    id: drawingSheets.id,
    companyId: drawingSheets.companyId,
    projectId: drawingSheets.projectId,
  },
  commitment: {
    table: commitments,
    id: commitments.id,
    companyId: commitments.companyId,
    projectId: commitments.projectId,
  },
  change_event: {
    table: changeEvents,
    id: changeEvents.id,
    companyId: changeEvents.companyId,
    projectId: changeEvents.projectId,
  },
  invoice: {
    table: invoices,
    id: invoices.id,
    companyId: invoices.companyId,
    projectId: invoices.projectId,
  },
  meeting: {
    table: meetings,
    id: meetings.id,
    companyId: meetings.companyId,
    projectId: meetings.projectId,
  },
  risk: { table: risks, id: risks.id, companyId: risks.companyId, projectId: risks.projectId },
  incident: {
    table: safetyIncidents,
    id: safetyIncidents.id,
    companyId: safetyIncidents.companyId,
    projectId: safetyIncidents.projectId,
  },
  ncr: {
    table: nonConformanceReports,
    id: nonConformanceReports.id,
    companyId: nonConformanceReports.companyId,
    projectId: nonConformanceReports.projectId,
  },
  equipment: {
    table: equipment,
    id: equipment.id,
    companyId: equipment.companyId,
    projectId: equipment.projectId,
  },
  asset: { table: assets, id: assets.id, companyId: assets.companyId, projectId: assets.projectId },
  bim_model: {
    table: bimModels,
    id: bimModels.id,
    companyId: bimModels.companyId,
    projectId: bimModels.projectId,
  },
};

/** Record types this registry can verify. */
export function knownRecordTypes(): string[] {
  return Object.keys(REGISTRY).sort();
}

export type RecordCheck =
  | { known: true; exists: boolean }
  | { known: false; exists: false };

/** Does `recordId` name a record of `recordType` inside this project? */
export async function checkRecord(
  db: Db,
  companyId: string,
  projectId: string,
  recordType: string,
  recordId: string,
): Promise<RecordCheck> {
  const entry = REGISTRY[recordType];
  if (!entry) return { known: false, exists: false };
  const rows = await db
    .select({ id: entry.id })
    .from(entry.table)
    .where(
      and(eq(entry.id, recordId), eq(entry.companyId, companyId), eq(entry.projectId, projectId)),
    )
    .limit(1);
  return { known: true, exists: rows.length > 0 };
}
