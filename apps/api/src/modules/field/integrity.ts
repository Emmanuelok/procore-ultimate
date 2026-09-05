/**
 * Field-record integrity hook (Vol II owner-side assurance).
 *
 * Subscribes to the ledger emit path and, for the handful of field events
 * that can defeat a control, runs the pure detectors in integrityEngine.ts
 * and persists a signal whose evidenceRefs point at the ledger sequence
 * that triggered it — the integrity reviewer dispositions the signal
 * against the exact entries, not a paraphrase.
 *
 *   rfi          answered → self-answer; update → question edited after answer
 *   punch_item   closed   → verifier == assignee / verifier == ready-marker
 *   daily_log    approved → approved within 60s of submission; co-approval pair
 *   submittal    responded → approved with no comments in < 1 business day
 *   photo        created  → EXIF date long before upload; GPS outside geofence
 *
 * Idempotent per (detector, key); never throws into the caller — appendLedger
 * guards subscribers, and this file guards itself again so one bad row cannot
 * silence the others.
 */
import type { FastifyInstance } from "fastify";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  dailyLogs,
  ledgerEntries,
  photos,
  projects,
  punchItems,
  rfis,
  signals,
  submittalReviewSteps,
  submittals,
} from "@constructos/db";
import type { Db } from "../../lib/db.js";
import { newId } from "../../lib/ids.js";
import { addLedgerEmitHook, appendLedger, type LedgerEvent } from "../../lib/ledger.js";
import {
  detectCoApprovalPattern,
  detectPhotoDateDrift,
  detectPhotoOutsideGeofence,
  detectPunchSelfVerification,
  detectRfiEditedAfterAnswer,
  detectRfiSelfAnswer,
  detectRushedDailyLogApproval,
  detectSubmittalRubberStamp,
  type Finding,
} from "./integrityEngine.js";
import { loadFieldSettings } from "./settings.js";

const FIELD_OBJECT_TYPES: ReadonlySet<string> = new Set(["rfi", "punch_item", "daily_log", "submittal", "photo"]);

/** Persist a finding as a signal unless one with the same key already exists. Returns the id or null. */
export async function raiseFieldSignal(
  db: Db,
  input: {
    companyId: string;
    projectId: string | null;
    finding: Finding;
    key: string;
    evidence: Record<string, unknown>;
    actorId?: string | null;
  },
): Promise<string | null> {
  const dup = await db
    .select({ id: signals.id })
    .from(signals)
    .where(and(eq(signals.companyId, input.companyId), eq(signals.detector, input.finding.detector), sql`${signals.evidenceRefs}->>'key' = ${input.key}`))
    .limit(1);
  if (dup.length > 0) return null;
  const id = newId("sig");
  await db.insert(signals).values({
    id,
    companyId: input.companyId,
    projectId: input.projectId,
    detector: input.finding.detector,
    severity: input.finding.severity,
    confidence: input.finding.confidence,
    title: input.finding.title,
    explanation: input.finding.explanation,
    evidenceRefs: { key: input.key, ...input.evidence },
  });
  await appendLedger(db, {
    companyId: input.companyId,
    actorId: input.actorId ?? null,
    action: "create",
    objectType: "signal",
    objectId: id,
    payload: { detector: input.finding.detector, key: input.key },
    projectId: input.projectId,
  });
  return id;
}

async function handleRfi(db: Db, event: LedgerEvent): Promise<void> {
  const rfi = (await db.select().from(rfis).where(and(eq(rfis.id, event.objectId), eq(rfis.companyId, event.companyId))).limit(1))[0];
  if (!rfi) return;
  if (event.action === "state_change") {
    const finding = detectRfiSelfAnswer(rfi);
    if (finding) {
      await raiseFieldSignal(db, {
        companyId: event.companyId,
        projectId: rfi.projectId,
        finding,
        key: `rfi_self_answer:${rfi.id}`,
        evidence: { rfiId: rfi.id, ledgerSeq: event.seq, respondedBy: rfi.respondedBy, createdBy: rfi.createdBy },
      });
    }
    return;
  }
  if (event.action === "update") {
    const entry = (await db.select({ payload: ledgerEntries.payload }).from(ledgerEntries).where(eq(ledgerEntries.seq, event.seq)).limit(1))[0];
    const payload = entry?.payload as { changed?: unknown } | null | undefined;
    const changed = Array.isArray(payload?.changed) ? payload.changed.filter((k): k is string => typeof k === "string") : [];
    const finding = detectRfiEditedAfterAnswer(rfi, changed);
    if (finding) {
      await raiseFieldSignal(db, {
        companyId: event.companyId,
        projectId: rfi.projectId,
        finding,
        key: `rfi_edited_after_answer:${rfi.id}:${event.seq}`,
        evidence: { rfiId: rfi.id, ledgerSeq: event.seq, changed, actorId: event.actorId },
      });
    }
  }
}

async function handlePunch(db: Db, event: LedgerEvent): Promise<void> {
  if (event.action !== "state_change") return;
  const item = (await db.select().from(punchItems).where(and(eq(punchItems.id, event.objectId), eq(punchItems.companyId, event.companyId))).limit(1))[0];
  if (!item || item.status !== "closed") return;
  const finding = detectPunchSelfVerification(item);
  if (!finding) return;
  await raiseFieldSignal(db, {
    companyId: event.companyId,
    projectId: item.projectId,
    finding,
    key: `punch_self_verified:${item.id}`,
    evidence: { punchItemId: item.id, ledgerSeq: event.seq, closedBy: item.closedBy, assigneeId: item.assigneeId, verifierId: item.verifierId, readyForReviewBy: item.readyForReviewBy },
  });
}

async function handleDailyLog(db: Db, event: LedgerEvent): Promise<void> {
  if (event.action !== "state_change") return;
  const log = (await db.select().from(dailyLogs).where(and(eq(dailyLogs.id, event.objectId), eq(dailyLogs.companyId, event.companyId))).limit(1))[0];
  if (!log || log.status !== "approved") return;
  const rushed = detectRushedDailyLogApproval(log);
  if (rushed) {
    await raiseFieldSignal(db, {
      companyId: event.companyId,
      projectId: log.projectId,
      finding: rushed,
      key: `daily_log_rushed:${log.id}`,
      evidence: { dailyLogId: log.id, ledgerSeq: event.seq, submittedAt: log.submittedAt, approvedAt: log.approvedAt, approvedBy: log.approvedBy },
    });
  }
  const recent = await db
    .select({ createdBy: dailyLogs.createdBy, approvedBy: dailyLogs.approvedBy })
    .from(dailyLogs)
    .where(and(eq(dailyLogs.companyId, event.companyId), eq(dailyLogs.projectId, log.projectId), eq(dailyLogs.status, "approved")))
    .orderBy(desc(dailyLogs.logDate))
    .limit(50);
  const pattern = detectCoApprovalPattern(recent);
  if (pattern) {
    await raiseFieldSignal(db, {
      companyId: event.companyId,
      projectId: log.projectId,
      finding: pattern,
      key: `daily_log_co_approval:${log.projectId}:${log.createdBy}:${log.approvedBy}`,
      evidence: { projectId: log.projectId, ledgerSeq: event.seq, sample: recent.length, creator: log.createdBy, approver: log.approvedBy },
    });
  }
}

async function handleSubmittal(db: Db, event: LedgerEvent): Promise<void> {
  if (event.action !== "state_change") return;
  const sub = (await db.select().from(submittals).where(and(eq(submittals.id, event.objectId), eq(submittals.companyId, event.companyId))).limit(1))[0];
  if (!sub || sub.status !== "responded") return;
  const steps = await db.select({ comments: submittalReviewSteps.comments, responseCode: submittalReviewSteps.responseCode }).from(submittalReviewSteps).where(eq(submittalReviewSteps.submittalId, sub.id));
  const finding = detectSubmittalRubberStamp(sub, steps);
  if (!finding) return;
  await raiseFieldSignal(db, {
    companyId: event.companyId,
    projectId: sub.projectId,
    finding,
    key: `submittal_rubber_stamp:${sub.id}`,
    evidence: { submittalId: sub.id, ledgerSeq: event.seq, submittedAt: sub.submittedAt, respondedAt: sub.respondedAt, steps: steps.length },
  });
}

async function handlePhoto(db: Db, event: LedgerEvent): Promise<void> {
  if (event.action !== "create") return;
  const photo = (await db.select().from(photos).where(and(eq(photos.id, event.objectId), eq(photos.companyId, event.companyId))).limit(1))[0];
  if (!photo) return;
  const drift = detectPhotoDateDrift(photo);
  if (drift) {
    await raiseFieldSignal(db, {
      companyId: event.companyId,
      projectId: photo.projectId,
      finding: drift,
      key: `photo_date_drift:${photo.id}`,
      evidence: { photoId: photo.id, ledgerSeq: event.seq, takenAt: photo.takenAt, createdAt: photo.createdAt, uploadedBy: photo.uploadedBy },
    });
  }
  if (photo.latitude !== null && photo.longitude !== null) {
    const project = (await db.select({ latitude: projects.latitude, longitude: projects.longitude }).from(projects).where(eq(projects.id, photo.projectId)).limit(1))[0];
    if (project) {
      const settings = await loadFieldSettings(db, event.companyId, photo.projectId);
      const outside = detectPhotoOutsideGeofence(photo, project, settings.photos.geofenceKm);
      if (outside) {
        await raiseFieldSignal(db, {
          companyId: event.companyId,
          projectId: photo.projectId,
          finding: outside,
          key: `photo_outside_geofence:${photo.id}`,
          evidence: { photoId: photo.id, ledgerSeq: event.seq, latitude: photo.latitude, longitude: photo.longitude, radiusKm: settings.photos.geofenceKm },
        });
      }
    }
  }
}

/** Dispatch one ledger event to the detector that cares about it. Exported for tests. */
export async function handleFieldLedgerEvent(db: Db, event: LedgerEvent): Promise<void> {
  if (!FIELD_OBJECT_TYPES.has(event.objectType)) return;
  switch (event.objectType) {
    case "rfi":
      return handleRfi(db, event);
    case "punch_item":
      return handlePunch(db, event);
    case "daily_log":
      return handleDailyLog(db, event);
    case "submittal":
      return handleSubmittal(db, event);
    case "photo":
      return handlePhoto(db, event);
    default:
      return;
  }
}

export function registerFieldIntegrity(app: FastifyInstance): void {
  const unsubscribe = addLedgerEmitHook(app.db, async (event) => {
    try {
      await handleFieldLedgerEvent(app.db, event);
    } catch (err) {
      app.log.warn({ err, seq: event.seq, objectType: event.objectType }, "field integrity detector failed");
    }
  });
  app.addHook("onClose", async () => {
    unsubscribe();
  });
}
