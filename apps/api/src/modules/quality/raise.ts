/**
 * Raising records from quality findings.
 *
 * A failed checklist item, a failed commissioning test and a rejected
 * delivery all end in the same two places: a non-conformance report, or a
 * punch item. Both are created here rather than in each route, so the
 * provenance columns (`sourceType`, `sourceId`, `checklistResponseId`,
 * `testRecordId`) are filled the same way every time and the "where did this
 * NCR come from" question has one answer.
 *
 * A PUNCH ITEM AND AN NCR ARE NOT THE SAME THING, and the platform keeps both
 * (field/punch.ts owns punch). A punch item is a snag: finish it, tick it,
 * done, and the person who does the work usually closes it out. An NCR is a
 * departure from the specification: it has a DISPOSITION that a second party
 * must approve, a root cause, corrective actions in the shared register, and
 * a closure that somebody other than the closer verifies. Sending a genuine
 * non-conformance to the punch list is how it disappears; sending a snag to
 * the NCR register is how the register stops being read. The template's
 * `isCritical` / `raisesNcrOnFail` flags are the declaration of which is
 * which, made before anybody had an interest in the answer.
 */

import { eq } from "drizzle-orm";
import { nonConformanceReports, punchItems } from "@constructos/db";
import type { NcrCategory, NcrSeverity, NcrSource } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import type { Db } from "../../lib/db.js";
import { allocateReference, ledger, nowISO } from "./shared.js";

export interface NcrDraft {
  companyId: string;
  projectId: string;
  actorId: string;
  title: string;
  description: string;
  category?: NcrCategory;
  severity?: NcrSeverity;
  sourceType: NcrSource;
  sourceId?: string | null;
  checklistId?: string | null;
  checklistResponseId?: string | null;
  itpActivityId?: string | null;
  testRecordId?: string | null;
  deliveryId?: string | null;
  raisedAgainstVendorId?: string | null;
  commitmentId?: string | null;
  raisedByOrganisation?: string | null;
  specSectionId?: string | null;
  specClauseRef?: string | null;
  drawingSheetId?: string | null;
  drawingReference?: string | null;
  locationId?: string | null;
  locationText?: string | null;
  assetId?: string | null;
  materialItemId?: string | null;
  quantityAffected?: number | null;
  unit?: string | null;
  detectedAt?: string | null;
  responseDueDate?: string | null;
  photoFileIds?: string[];
  attachmentFileIds?: string[];
  detail?: Record<string, unknown>;
}

export async function createNcr(db: Db, draft: NcrDraft) {
  const { number, reference } = await allocateReference(db, draft.projectId, "ncr", "NCR");
  const id = newId("ncr");
  const [created] = await db
    .insert(nonConformanceReports)
    .values({
      id,
      companyId: draft.companyId,
      projectId: draft.projectId,
      number,
      reference,
      title: draft.title,
      description: draft.description,
      category: draft.category ?? "workmanship",
      severity: draft.severity ?? "minor",
      status: "open",
      sourceType: draft.sourceType,
      sourceId: draft.sourceId ?? null,
      checklistId: draft.checklistId ?? null,
      checklistResponseId: draft.checklistResponseId ?? null,
      itpActivityId: draft.itpActivityId ?? null,
      testRecordId: draft.testRecordId ?? null,
      deliveryId: draft.deliveryId ?? null,
      raisedAgainstVendorId: draft.raisedAgainstVendorId ?? null,
      commitmentId: draft.commitmentId ?? null,
      raisedByOrganisation: draft.raisedByOrganisation ?? null,
      specSectionId: draft.specSectionId ?? null,
      specClauseRef: draft.specClauseRef ?? null,
      drawingSheetId: draft.drawingSheetId ?? null,
      drawingReference: draft.drawingReference ?? null,
      locationId: draft.locationId ?? null,
      locationText: draft.locationText ?? null,
      assetId: draft.assetId ?? null,
      materialItemId: draft.materialItemId ?? null,
      quantityAffected: draft.quantityAffected ?? null,
      unit: draft.unit ?? null,
      detectedAt: draft.detectedAt ?? nowISO(),
      responseDueDate: draft.responseDueDate ?? null,
      photoFileIds: draft.photoFileIds ?? [],
      attachmentFileIds: draft.attachmentFileIds ?? [],
      detail: draft.detail ?? {},
      createdBy: draft.actorId,
    })
    .returning();
  await ledger(db, {
    companyId: draft.companyId,
    projectId: draft.projectId,
    actorId: draft.actorId,
    action: "create",
    objectType: "non_conformance_report",
    objectId: id,
    payload: created,
    storePayload: true,
  });
  return created!;
}

export interface PunchDraft {
  companyId: string;
  projectId: string;
  actorId: string;
  title: string;
  description?: string | null;
  itemType?: string | null;
  assigneeId?: string | null;
  verifierId?: string | null;
  vendorId?: string | null;
  locationId?: string | null;
  dueDate?: string | null;
  priority?: "low" | "medium" | "high";
  beforePhotoIds?: string[];
}

/**
 * Create a punch item in the FIELD register (field/punch.ts) — quality does
 * not keep a second snag list. The numbering counter key is the same one the
 * punch module uses, so a quality-raised snag takes its place in the project's
 * single punch sequence.
 */
export async function createPunchItemFor(db: Db, draft: PunchDraft) {
  const number = await nextRecordNumber(db, draft.projectId, "punch");
  const id = newId("pun");
  const [created] = await db
    .insert(punchItems)
    .values({
      id,
      companyId: draft.companyId,
      projectId: draft.projectId,
      number,
      title: draft.title,
      description: draft.description ?? null,
      status: "open",
      itemType: draft.itemType ?? "quality",
      assigneeId: draft.assigneeId ?? null,
      verifierId: draft.verifierId ?? null,
      vendorId: draft.vendorId ?? null,
      locationId: draft.locationId ?? null,
      dueDate: draft.dueDate ?? null,
      priority: draft.priority ?? "medium",
      beforePhotoIds: draft.beforePhotoIds ?? [],
      afterPhotoIds: [],
      createdBy: draft.actorId,
    })
    .returning();
  await ledger(db, {
    companyId: draft.companyId,
    projectId: draft.projectId,
    actorId: draft.actorId,
    action: "create",
    objectType: "punch_item",
    objectId: id,
    payload: { number, title: draft.title, raisedBy: "quality", itemType: draft.itemType ?? "quality" },
  });
  return created!;
}

/** Bump the NCR's open corrective-action count from the shared register. */
export async function setOpenActionCount(db: Db, ncrId: string, openCount: number) {
  await db
    .update(nonConformanceReports)
    .set({ openActionCount: openCount, updatedAt: nowISO() })
    .where(eq(nonConformanceReports.id, ncrId));
}
