/**
 * Site operations — the services the routes and the scheduler jobs share.
 *
 * Nothing here is a route handler and nothing here is a pure engine: this is
 * the layer that loads the rows, calls an engine, writes the consequences
 * (statuses, signals, notifications, ledger entries) and hands back a summary.
 * Every sweep is exposed both as a scheduler job (jobs.ts) and as a POST
 * endpoint, so an operator and the ticker run the same code.
 *
 * Idempotence is the rule that shapes this file: a sweep that runs every ten
 * minutes must not raise the same signal ten times an hour, so every signal
 * carries a dedupe key naming the record and the condition, and every status
 * change is guarded by the status it moves from.
 */
import { and, asc, count, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  assertions,
  evidence,
  projects,
  reconciliations,
  siteAccessPasses,
  siteEnvironmentalEvents,
  siteExclusionZones,
  siteDroneFlights,
  siteGateEvents,
  siteGeotechInvestigations,
  siteGroundFindings,
  siteInductions,
  siteLoneWorkerSessions,
  siteMusterCheckins,
  siteMusters,
  sitePermitEntries,
  sitePermits,
  sitePhotoTours,
  siteProgressObservations,
  siteScanDeviations,
  siteScans,
  siteSettingOutRecords,
  siteUtilityStrikes,
  siteWeatherAnalyses,
  siteWeatherBaselines,
  siteWeatherObservations,
  projectMemberships,
  signals,
} from "@constructos/db";
import { hashPayload } from "@constructos/ledger";
import { SITE_DETECTORS } from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import { newId } from "../../lib/ids.js";
import { buildRegister, type GateEventInput, type OccupancySummary } from "./engines/occupancy.js";
import { reconcileMuster, type CheckinEntry, type RegisterEntry } from "./engines/muster.js";
import { expiredPermits, loneWorkerDue, overdueEntries } from "./engines/permits.js";
import { analyseWeather, type Threshold, type WeatherReading } from "./engines/weather.js";
import { fetchArchive, type FetchLike } from "./engines/provider.js";
import {
  alreadySignalled,
  allocateReference,
  figure,
  ledger,
  notifyUsers,
  nowISO,
  raiseSignal,
  round1,
  type Figure,
} from "./shared.js";

/** How far back the on-site register folds gate events by default. A shift
 *  that started three weeks ago and never ended is an overstay, not a person
 *  the register should still be carrying. */
export const REGISTER_WINDOW_DAYS = 14;

/** Hours on site after which a still-open session is treated as an overstay. */
export const OVERSTAY_HOURS = 16;

export const OPEN_PERMIT_STATUSES = ["requested", "approved", "active", "suspended"] as const;

/** Every detector this module raises — used to count its own open signals. */
export const SITE_DETECTOR_LIST = SITE_DETECTORS;

/* ================================================================== */
/* The on-site register                                                */
/* ================================================================== */

/** Stable identity for a person across the gate feed. */
export function personKeyOf(row: {
  passId?: string | null;
  workerId?: string | null;
  badgeCode?: string | null;
  personName?: string | null;
}): string {
  if (row.passId) return `pass:${row.passId}`;
  if (row.workerId) return `worker:${row.workerId}`;
  if (row.badgeCode) return `badge:${row.badgeCode}`;
  return `name:${(row.personName ?? "unknown").trim().toLowerCase()}`;
}

export async function loadGateEvents(
  db: Db,
  companyId: string,
  projectId: string,
  fromIso: string,
  toIso: string,
  limit = 20_000,
): Promise<GateEventInput[]> {
  const rows = await db
    .select()
    .from(siteGateEvents)
    .where(
      and(
        eq(siteGateEvents.companyId, companyId),
        eq(siteGateEvents.projectId, projectId),
        gte(siteGateEvents.occurredAt, fromIso),
        lte(siteGateEvents.occurredAt, toIso),
      ),
    )
    .orderBy(asc(siteGateEvents.occurredAt))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    occurredAt: row.occurredAt,
    direction: row.direction,
    accepted: row.accepted,
    personKey: personKeyOf(row),
    personName: row.personName,
    passId: row.passId,
    workerId: row.workerId,
    vendorId: row.vendorId,
    personKind: row.personKind,
    gateName: row.gateName,
    source: row.source,
    refusalReason: row.refusalReason,
  }));
}

export interface RegisterResult extends OccupancySummary {
  windowFrom: string;
  windowTo: string;
  truncated: boolean;
  reasons: string[];
}

/**
 * Who is on site as at `asOf`, folded from the gate feed over a bounded
 * window. The window is stated in the result so nobody mistakes "nobody is on
 * site" for "nobody badged in during the last fortnight".
 */
export async function loadRegister(
  db: Db,
  companyId: string,
  projectId: string,
  asOf: string,
  options: { windowDays?: number; overstayHours?: number } = {},
): Promise<RegisterResult> {
  const windowDays = options.windowDays ?? REGISTER_WINDOW_DAYS;
  const windowFrom = new Date(Date.parse(asOf) - windowDays * 86_400_000).toISOString();
  const limit = 20_000;
  const events = await loadGateEvents(db, companyId, projectId, windowFrom, asOf, limit);
  const summary = buildRegister(events, {
    asOf,
    overstayHours: options.overstayHours ?? OVERSTAY_HOURS,
  });
  const reasons: string[] = [];
  if (events.length === 0) {
    reasons.push(
      `No gate events in the ${windowDays} days to ${asOf}. Either nobody badged, or the gate feed is not connected — the register is empty for want of data, not because the site is.`,
    );
  }
  if (events.length >= limit) {
    reasons.push(
      `The gate feed returned the maximum of ${limit} events for this window; the register may be folded from a partial stream. Narrow the window.`,
    );
  }
  return {
    ...summary,
    windowFrom,
    windowTo: asOf,
    truncated: events.length >= limit,
    reasons,
  };
}

/* ================================================================== */
/* Gate event ingestion (the machine feed)                             */
/* ================================================================== */

export interface GateEventPayload {
  badgeCode?: string | null;
  passId?: string | null;
  workerId?: string | null;
  personName?: string | null;
  personKind?: string | null;
  direction: string;
  occurredAt: string;
  gateName?: string | null;
  deviceId?: string | null;
  source?: string | null;
  accepted?: boolean;
  refusalReason?: string | null;
  zoneId?: string | null;
  lat?: number | null;
  lon?: number | null;
  externalRef?: string | null;
  raw?: Record<string, unknown> | null;
}

export interface GateIngestResult {
  accepted: number;
  refused: number;
  duplicates: number;
  unmatched: number;
  eventIds: string[];
  notes: string[];
}

/**
 * Ingest a batch from a reader.
 *
 * The reader is the source of truth for WHAT HAPPENED (a badge was presented
 * at 07:03), never for whether it should have happened. This function resolves
 * the badge to a pass, and where the pass is not valid it stores the event as
 * REFUSED with a reason rather than dropping it — a refused read at 03:00 is
 * exactly the record an investigation needs.
 */
export async function ingestGateEvents(
  db: Db,
  input: { companyId: string; projectId: string; actorId: string | null },
  events: readonly GateEventPayload[],
): Promise<GateIngestResult> {
  const result: GateIngestResult = {
    accepted: 0,
    refused: 0,
    duplicates: 0,
    unmatched: 0,
    eventIds: [],
    notes: [],
  };
  if (events.length === 0) return result;

  const badgeCodes = [...new Set(events.map((e) => e.badgeCode).filter((b): b is string => Boolean(b)))];
  const passIds = [...new Set(events.map((e) => e.passId).filter((p): p is string => Boolean(p)))];
  const passRows =
    badgeCodes.length + passIds.length === 0
      ? []
      : await db
          .select()
          .from(siteAccessPasses)
          .where(
            and(
              eq(siteAccessPasses.companyId, input.companyId),
              eq(siteAccessPasses.projectId, input.projectId),
              badgeCodes.length > 0 && passIds.length > 0
                ? sql`(${inArray(siteAccessPasses.badgeCode, badgeCodes)} OR ${inArray(siteAccessPasses.id, passIds)})`
                : badgeCodes.length > 0
                  ? inArray(siteAccessPasses.badgeCode, badgeCodes)
                  : inArray(siteAccessPasses.id, passIds),
            ),
          );
  const byBadge = new Map(passRows.map((p) => [p.badgeCode, p]));
  const byId = new Map(passRows.map((p) => [p.id, p]));

  const externalRefs = [...new Set(events.map((e) => e.externalRef).filter((r): r is string => Boolean(r)))];
  const existing =
    externalRefs.length === 0
      ? []
      : await db
          .select({ externalRef: siteGateEvents.externalRef })
          .from(siteGateEvents)
          .where(
            and(
              eq(siteGateEvents.projectId, input.projectId),
              inArray(siteGateEvents.externalRef, externalRefs),
            ),
          );
  const seenRefs = new Set(existing.map((r) => r.externalRef).filter((r): r is string => Boolean(r)));

  const today = new Date().toISOString().slice(0, 10);
  const rows: Array<typeof siteGateEvents.$inferInsert> = [];

  for (const event of events) {
    if (event.externalRef && seenRefs.has(event.externalRef)) {
      result.duplicates += 1;
      continue;
    }
    if (event.externalRef) seenRefs.add(event.externalRef);

    const pass = (event.passId ? byId.get(event.passId) : undefined) ?? (event.badgeCode ? byBadge.get(event.badgeCode) : undefined);
    let accepted = event.accepted === undefined ? true : event.accepted;
    let refusalReason = event.refusalReason ?? null;

    if (!pass) {
      result.unmatched += 1;
      if (event.badgeCode || event.passId) {
        accepted = false;
        refusalReason = refusalReason ?? "unknown_credential";
      }
    } else if (accepted) {
      const day = (event.occurredAt ?? nowISO()).slice(0, 10);
      if (pass.status === "revoked") {
        accepted = false;
        refusalReason = "pass_revoked";
      } else if (pass.status === "suspended") {
        accepted = false;
        refusalReason = "pass_suspended";
      } else if (pass.status === "expired" || (pass.validUntil && pass.validUntil < day)) {
        accepted = false;
        refusalReason = "pass_expired";
      } else if (pass.validFrom && pass.validFrom > day) {
        accepted = false;
        refusalReason = "pass_expired";
      }
    }

    if (accepted) result.accepted += 1;
    else result.refused += 1;

    const id = newId("gev");
    result.eventIds.push(id);
    rows.push({
      id,
      companyId: input.companyId,
      projectId: input.projectId,
      gateName: event.gateName ?? "main",
      deviceId: event.deviceId ?? null,
      passId: pass?.id ?? event.passId ?? null,
      workerId: event.workerId ?? pass?.workerId ?? null,
      badgeCode: event.badgeCode ?? pass?.badgeCode ?? null,
      personName: event.personName ?? pass?.personName ?? null,
      personKind: event.personKind ?? pass?.personKind ?? null,
      vendorId: pass?.vendorId ?? null,
      direction: event.direction,
      occurredAt: event.occurredAt,
      source: event.source ?? "turnstile",
      accepted: accepted ? 1 : 0,
      refusalReason,
      zoneId: event.zoneId ?? null,
      lat: event.lat ?? null,
      lon: event.lon ?? null,
      externalRef: event.externalRef ?? null,
      raw: event.raw ?? null,
    });
  }

  if (rows.length > 0) {
    await db.insert(siteGateEvents).values(rows);
    await ledger(db, {
      companyId: input.companyId,
      projectId: input.projectId,
      actorId: input.actorId,
      action: "create",
      objectType: "site_gate_event",
      objectId: rows[0]!.id,
      payload: {
        batch: rows.length,
        accepted: result.accepted,
        refused: result.refused,
        duplicates: result.duplicates,
        firstEventId: rows[0]!.id,
        lastEventId: rows[rows.length - 1]!.id,
        day: today,
      },
    });
  }
  if (result.unmatched > 0) {
    result.notes.push(
      `${result.unmatched} read(s) presented a credential this project does not hold. They are stored as refused reads, not discarded.`,
    );
  }
  if (result.duplicates > 0) {
    result.notes.push(
      `${result.duplicates} read(s) had an external reference already in the feed and were ignored — a replayed batch does not double the headcount.`,
    );
  }
  return result;
}

/* ================================================================== */
/* Musters                                                             */
/* ================================================================== */

export async function reconcileMusterRecord(
  db: Db,
  companyId: string,
  projectId: string,
  actorId: string | null,
  musterId: string,
): Promise<{
  muster: typeof siteMusters.$inferSelect;
  reconciliation: ReturnType<typeof reconcileMuster>;
  signalId: string | null;
}> {
  const musterRows = await db
    .select()
    .from(siteMusters)
    .where(and(eq(siteMusters.id, musterId), eq(siteMusters.companyId, companyId), eq(siteMusters.projectId, projectId)))
    .limit(1);
  const muster = musterRows[0];
  if (!muster) throw new Error(`Muster ${musterId} not found`);

  const checkinRows = await db
    .select()
    .from(siteMusterCheckins)
    .where(and(eq(siteMusterCheckins.musterId, musterId), eq(siteMusterCheckins.companyId, companyId)));

  const register: RegisterEntry[] = (muster.expectedRegister ?? []).map((p) => ({
    key: p.key,
    name: p.name,
    passId: p.passId,
    workerId: p.workerId,
    sinceAt: p.sinceAt,
  }));
  const checkins: CheckinEntry[] = checkinRows.map((c) => ({
    personKey: c.personKey,
    personName: c.personName,
    status: c.status,
    checkedInAt: c.checkedInAt,
  }));

  const reconciliation = reconcileMuster(register, checkins, { declaredAt: muster.declaredAt });

  let signalId: string | null = muster.signalId;
  if (reconciliation.unaccountedCount > 0 && !signalId) {
    const raised = await alreadySignalled(db, companyId, ["site_muster_unaccounted"], projectId);
    const key = `muster:${muster.id}`;
    if (!raised.has(key)) {
      signalId = await raiseSignal(db, companyId, projectId, actorId, {
        detector: "site_muster_unaccounted",
        severity: muster.kind === "emergency" ? "critical" : "high",
        confidence: 0.9,
        title: `${reconciliation.unaccountedCount} person(s) unaccounted for at ${muster.reference}`,
        explanation: `The on-site register held ${reconciliation.expectedCount} person(s) when ${muster.reference} was declared at ${muster.declaredAt}. ${reconciliation.accountedCount} reached the muster point or were accounted for off site. Unaccounted: ${reconciliation.unaccounted.map((p) => p.name).join(", ")}.`,
        key,
        subjectType: "site_muster",
        subjectId: muster.id,
        evidence: {
          musterId: muster.id,
          unaccounted: reconciliation.unaccounted.map((p) => ({ key: p.key, name: p.name, sinceAt: p.sinceAt })),
          unexpected: reconciliation.unexpected.map((p) => p.name),
        },
      });
    }
  }

  const [updated] = await db
    .update(siteMusters)
    .set({
      status: reconciliation.clear ? "reconciled" : muster.status === "closed" ? "closed" : "open",
      expectedCount: reconciliation.expectedCount,
      accountedCount: reconciliation.accountedCount,
      unaccountedCount: reconciliation.unaccountedCount,
      unexpectedCount: reconciliation.unexpectedCount,
      durationSeconds: reconciliation.durationSeconds,
      reconciledAt: nowISO(),
      reconciledBy: actorId,
      clearedAt: reconciliation.clear ? nowISO() : null,
      signalId,
      updatedAt: nowISO(),
    })
    .where(and(eq(siteMusters.id, musterId), eq(siteMusters.companyId, companyId)))
    .returning();

  await ledger(db, {
    companyId,
    projectId,
    actorId,
    action: "state_change",
    objectType: "site_muster",
    objectId: musterId,
    payload: {
      expected: reconciliation.expectedCount,
      accounted: reconciliation.accountedCount,
      unaccounted: reconciliation.unaccountedCount,
      unexpected: reconciliation.unexpectedCount,
      clear: reconciliation.clear,
    },
  });

  return { muster: updated ?? muster, reconciliation, signalId };
}

/* ================================================================== */
/* Sweeps                                                              */
/* ================================================================== */

async function projectWatchers(db: Db, companyId: string, projectId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: projectMemberships.userId })
    .from(projectMemberships)
    .where(and(eq(projectMemberships.companyId, companyId), eq(projectMemberships.projectId, projectId)))
    .limit(200);
  return rows.map((r) => r.userId);
}

/** Permits whose validity window closed while they were still open. */
export async function sweepPermitExpiry(db: Db, companyId: string, now: Date) {
  const nowIso = now.toISOString();
  const open = await db
    .select({
      id: sitePermits.id,
      projectId: sitePermits.projectId,
      reference: sitePermits.reference,
      title: sitePermits.title,
      permitType: sitePermits.permitType,
      status: sitePermits.status,
      validTo: sitePermits.validTo,
      requestedBy: sitePermits.requestedBy,
      createdBy: sitePermits.createdBy,
    })
    .from(sitePermits)
    .where(and(eq(sitePermits.companyId, companyId), inArray(sitePermits.status, ["approved", "active", "suspended"])))
    .limit(5000);

  const due = expiredPermits(open, nowIso);
  if (due.length === 0) return { expired: 0, signalsRaised: 0 };

  const raised = await alreadySignalled(db, companyId, ["site_permit_expired_open"]);
  let signalsRaised = 0;

  for (const permit of due) {
    await db
      .update(sitePermits)
      .set({ status: "expired", expiredAt: nowIso, updatedAt: nowIso })
      .where(and(eq(sitePermits.id, permit.id), eq(sitePermits.companyId, companyId), inArray(sitePermits.status, ["approved", "active", "suspended"])));
    await ledger(db, {
      companyId,
      projectId: permit.projectId,
      actorId: null,
      action: "state_change",
      objectType: "site_permit",
      objectId: permit.id,
      payload: { from: permit.status, to: "expired", validTo: permit.validTo, sweep: "site.permit-expiry" },
    });

    const key = `permit-expired:${permit.id}`;
    if (!raised.has(key)) {
      const wasActive = permit.status === "active";
      await raiseSignal(db, companyId, permit.projectId, null, {
        detector: "site_permit_expired_open",
        severity: wasActive ? "high" : "medium",
        confidence: 1,
        title: `Permit ${permit.reference} lapsed while still ${permit.status}`,
        explanation: `${permit.reference} (${permit.permitType.replace(/_/g, " ")}, "${permit.title}") was ${permit.status} when its validity ended at ${permit.validTo}. It has been set to expired. ${wasActive ? "Work under it must stop until a new permit is issued." : "It was never activated."}`,
        key,
        subjectType: "site_permit",
        subjectId: permit.id,
        evidence: { permitId: permit.id, reference: permit.reference, validTo: permit.validTo, priorStatus: permit.status },
      });
      signalsRaised += 1;
      await notifyUsers(db, {
        companyId,
        projectId: permit.projectId,
        userIds: [permit.requestedBy, permit.createdBy],
        title: `Permit ${permit.reference} expired`,
        body: `The ${permit.permitType.replace(/_/g, " ")} permit "${permit.title}" lapsed at ${permit.validTo} while ${permit.status}.`,
        recordType: "site_permit",
        recordId: permit.id,
      });
    }
  }
  return { expired: due.length, signalsRaised };
}

/** People still recorded inside a confined space past their expected exit. */
export async function sweepPermitEntries(db: Db, companyId: string, now: Date) {
  const nowIso = now.toISOString();
  const rows = await db
    .select()
    .from(sitePermitEntries)
    .where(and(eq(sitePermitEntries.companyId, companyId), eq(sitePermitEntries.status, "inside")))
    .limit(5000);
  const due = overdueEntries(
    rows.map((r) => ({
      id: r.id,
      personName: r.personName,
      enteredAt: r.enteredAt,
      expectedExitAt: r.expectedExitAt,
      status: r.status,
    })),
    nowIso,
  );
  if (due.length === 0) return { overdue: 0, signalsRaised: 0 };

  const byId = new Map(rows.map((r) => [r.id, r]));
  const raised = await alreadySignalled(db, companyId, ["site_confined_space_overdue"]);
  let signalsRaised = 0;

  for (const entry of due) {
    const row = byId.get(entry.id);
    if (!row) continue;
    const key = `entry-overdue:${row.id}`;
    let signalId = row.signalId;
    if (!raised.has(key)) {
      signalId = await raiseSignal(db, companyId, row.projectId, null, {
        detector: "site_confined_space_overdue",
        severity: entry.overdueMinutes >= 30 ? "critical" : "high",
        confidence: 1,
        title: `${entry.personName} is ${entry.overdueMinutes} minute(s) overdue out of a permitted space`,
        explanation: `${entry.personName} entered under permit at ${row.enteredAt} and was expected out at ${entry.expectedExitAt}. No exit has been recorded. They have been inside for ${entry.insideMinutes} minute(s).`,
        key,
        subjectType: "site_permit_entry",
        subjectId: row.id,
        evidence: {
          entryId: row.id,
          permitId: row.permitId,
          enteredAt: row.enteredAt,
          expectedExitAt: entry.expectedExitAt,
          overdueMinutes: entry.overdueMinutes,
        },
      });
      signalsRaised += 1;
      await notifyUsers(db, {
        companyId,
        projectId: row.projectId,
        userIds: [row.recordedBy, ...(await projectWatchers(db, companyId, row.projectId))],
        title: `${entry.personName} overdue out of a permitted space`,
        body: `Expected out at ${entry.expectedExitAt}; ${entry.overdueMinutes} minute(s) late. Attendant: ${row.attendantName ?? "not recorded"}.`,
        recordType: "site_permit_entry",
        recordId: row.id,
      });
    }
    await db
      .update(sitePermitEntries)
      .set({ status: "overdue", overdueAt: nowIso, signalId, updatedAt: nowIso })
      .where(and(eq(sitePermitEntries.id, row.id), eq(sitePermitEntries.companyId, companyId), eq(sitePermitEntries.status, "inside")));
    await ledger(db, {
      companyId,
      projectId: row.projectId,
      actorId: null,
      action: "state_change",
      objectType: "site_permit_entry",
      objectId: row.id,
      payload: { to: "overdue", overdueMinutes: entry.overdueMinutes, sweep: "site.confined-space" },
    });
  }
  return { overdue: due.length, signalsRaised };
}

/** Lone workers who have missed a check-in. */
export async function sweepLoneWorkers(db: Db, companyId: string, now: Date) {
  const nowIso = now.toISOString();
  const rows = await db
    .select()
    .from(siteLoneWorkerSessions)
    .where(and(eq(siteLoneWorkerSessions.companyId, companyId), inArray(siteLoneWorkerSessions.status, ["active", "overdue"])))
    .limit(5000);
  const verdicts = loneWorkerDue(
    rows.map((r) => ({
      id: r.id,
      personName: r.personName,
      status: r.status,
      nextDueAt: r.nextDueAt,
      intervalMinutes: r.intervalMinutes,
      missedCount: r.missedCount,
      expectedEndAt: r.expectedEndAt,
    })),
    nowIso,
  );
  if (verdicts.length === 0) return { overdue: 0, escalated: 0, signalsRaised: 0 };

  const byId = new Map(rows.map((r) => [r.id, r]));
  const raised = await alreadySignalled(db, companyId, ["site_lone_worker_overdue"]);
  let signalsRaised = 0;
  let escalated = 0;

  for (const verdict of verdicts) {
    const row = byId.get(verdict.id);
    if (!row) continue;
    if (verdict.action === "escalate") {
      escalated += 1;
      const key = `lone-worker:${row.id}`;
      let signalId = row.escalationSignalId;
      if (!raised.has(key)) {
        signalId = await raiseSignal(db, companyId, row.projectId, null, {
          detector: "site_lone_worker_overdue",
          severity: "critical",
          confidence: 1,
          title: `${row.personName} has missed a lone-working check-in`,
          explanation: `${verdict.reason} Activity: ${row.activity}. Last known position: ${row.locationDescription ?? (row.lat !== null && row.lon !== null ? `${row.lat}, ${row.lon}` : "not recorded")}. Emergency contact: ${row.contactName ?? "not recorded"} ${row.contactPhone ?? ""}`.trim(),
          key,
          subjectType: "site_lone_worker_session",
          subjectId: row.id,
          evidence: {
            sessionId: row.id,
            nextDueAt: verdict.nextDueAt,
            lateMinutes: verdict.lateMinutes,
            lat: row.lat,
            lon: row.lon,
          },
        });
        signalsRaised += 1;
      }
      await db
        .update(siteLoneWorkerSessions)
        .set({
          status: "escalated",
          escalatedAt: row.escalatedAt ?? nowIso,
          escalationSignalId: signalId,
          missedCount: row.missedCount + 1,
          updatedAt: nowIso,
        })
        .where(and(eq(siteLoneWorkerSessions.id, row.id), eq(siteLoneWorkerSessions.companyId, companyId), inArray(siteLoneWorkerSessions.status, ["active", "overdue"])));
      await notifyUsers(db, {
        companyId,
        projectId: row.projectId,
        userIds: [row.createdBy, ...row.watcherUserIds, ...(await projectWatchers(db, companyId, row.projectId))],
        kind: "escalation",
        title: `Lone worker check-in missed: ${row.personName}`,
        body: verdict.reason,
        recordType: "site_lone_worker_session",
        recordId: row.id,
      });
      await ledger(db, {
        companyId,
        projectId: row.projectId,
        actorId: null,
        action: "state_change",
        objectType: "site_lone_worker_session",
        objectId: row.id,
        payload: { to: "escalated", lateMinutes: verdict.lateMinutes, sweep: "site.lone-worker" },
      });
    } else if (row.status === "active") {
      await db
        .update(siteLoneWorkerSessions)
        .set({ status: "overdue", updatedAt: nowIso })
        .where(and(eq(siteLoneWorkerSessions.id, row.id), eq(siteLoneWorkerSessions.companyId, companyId), eq(siteLoneWorkerSessions.status, "active")));
      await notifyUsers(db, {
        companyId,
        projectId: row.projectId,
        userIds: [row.createdBy, ...row.watcherUserIds],
        kind: "overdue",
        title: `Lone worker check-in overdue: ${row.personName}`,
        body: verdict.reason,
        recordType: "site_lone_worker_session",
        recordId: row.id,
      });
      await ledger(db, {
        companyId,
        projectId: row.projectId,
        actorId: null,
        action: "state_change",
        objectType: "site_lone_worker_session",
        objectId: row.id,
        payload: { to: "overdue", lateMinutes: verdict.lateMinutes, sweep: "site.lone-worker" },
      });
    }
  }
  return { overdue: verdicts.length, escalated, signalsRaised };
}

/** Expire passes and inductions whose validity has run out, and flag any live
 *  pass standing on an induction that no longer is. */
export async function sweepAccessCredentials(db: Db, companyId: string, now: Date) {
  const today = now.toISOString().slice(0, 10);
  const nowIso = now.toISOString();

  const expiredInductions = await db
    .update(siteInductions)
    .set({ status: "expired", updatedAt: nowIso })
    .where(
      and(
        eq(siteInductions.companyId, companyId),
        eq(siteInductions.status, "valid"),
        sql`${siteInductions.validUntil} is not null`,
        lte(siteInductions.validUntil, today),
      ),
    )
    .returning({ id: siteInductions.id, projectId: siteInductions.projectId, personName: siteInductions.personName });

  for (const row of expiredInductions) {
    await ledger(db, {
      companyId,
      projectId: row.projectId,
      actorId: null,
      action: "state_change",
      objectType: "site_induction",
      objectId: row.id,
      payload: { to: "expired", sweep: "site.access-credentials" },
    });
  }

  const expiredPasses = await db
    .update(siteAccessPasses)
    .set({ status: "expired", updatedAt: nowIso })
    .where(
      and(
        eq(siteAccessPasses.companyId, companyId),
        eq(siteAccessPasses.status, "active"),
        sql`${siteAccessPasses.validUntil} is not null`,
        lte(siteAccessPasses.validUntil, today),
      ),
    )
    .returning({ id: siteAccessPasses.id, projectId: siteAccessPasses.projectId, personName: siteAccessPasses.personName, badgeCode: siteAccessPasses.badgeCode });

  for (const row of expiredPasses) {
    await ledger(db, {
      companyId,
      projectId: row.projectId,
      actorId: null,
      action: "state_change",
      objectType: "site_access_pass",
      objectId: row.id,
      payload: { to: "expired", sweep: "site.access-credentials" },
    });
  }

  // Live passes whose induction is not valid.
  const suspect = await db
    .select({
      passId: siteAccessPasses.id,
      projectId: siteAccessPasses.projectId,
      personName: siteAccessPasses.personName,
      badgeCode: siteAccessPasses.badgeCode,
      inductionId: siteAccessPasses.inductionId,
      inductionStatus: siteInductions.status,
      createdBy: siteAccessPasses.createdBy,
    })
    .from(siteAccessPasses)
    .leftJoin(siteInductions, eq(siteAccessPasses.inductionId, siteInductions.id))
    .where(and(eq(siteAccessPasses.companyId, companyId), eq(siteAccessPasses.status, "active")))
    .limit(5000);

  const raised = await alreadySignalled(db, companyId, ["site_pass_without_induction"]);
  let signalsRaised = 0;
  for (const row of suspect) {
    const ok = row.inductionId !== null && row.inductionStatus === "valid";
    if (ok) continue;
    const key = `pass-induction:${row.passId}`;
    if (raised.has(key)) continue;
    await raiseSignal(db, companyId, row.projectId, null, {
      detector: "site_pass_without_induction",
      severity: "high",
      confidence: 0.95,
      title: `Active site pass for ${row.personName} with no valid induction`,
      explanation:
        row.inductionId === null
          ? `Badge ${row.badgeCode} is active but is not linked to any induction record. Nobody can show this person was inducted.`
          : `Badge ${row.badgeCode} is active but its induction is ${row.inductionStatus ?? "missing"}, not valid.`,
      key,
      subjectType: "site_access_pass",
      subjectId: row.passId,
      evidence: { passId: row.passId, badgeCode: row.badgeCode, inductionId: row.inductionId, inductionStatus: row.inductionStatus },
    });
    signalsRaised += 1;
    await notifyUsers(db, {
      companyId,
      projectId: row.projectId,
      userIds: [row.createdBy],
      kind: "compliance",
      title: `Site pass without a valid induction: ${row.personName}`,
      body: `Badge ${row.badgeCode} is active. Suspend the pass or record a valid induction.`,
      recordType: "site_access_pass",
      recordId: row.passId,
    });
  }

  return {
    inductionsExpired: expiredInductions.length,
    passesExpired: expiredPasses.length,
    signalsRaised,
  };
}

/** Exclusion zones whose active window has closed. */
export async function sweepExclusionZones(db: Db, companyId: string, now: Date) {
  const nowIso = now.toISOString();
  const lifted = await db
    .update(siteExclusionZones)
    .set({ status: "lifted", liftedAt: nowIso, updatedAt: nowIso })
    .where(
      and(
        eq(siteExclusionZones.companyId, companyId),
        eq(siteExclusionZones.status, "active"),
        sql`${siteExclusionZones.activeTo} is not null`,
        lte(siteExclusionZones.activeTo, nowIso),
      ),
    )
    .returning({ id: siteExclusionZones.id, projectId: siteExclusionZones.projectId, name: siteExclusionZones.name });
  for (const row of lifted) {
    await ledger(db, {
      companyId,
      projectId: row.projectId,
      actorId: null,
      action: "state_change",
      objectType: "site_exclusion_zone",
      objectId: row.id,
      payload: { to: "lifted", sweep: "site.exclusion-zones" },
    });
  }
  return { lifted: lifted.length };
}

/** Anyone the register still holds on site after a full working day and more. */
export async function sweepOverstays(db: Db, companyId: string, now: Date) {
  const nowIso = now.toISOString();
  const projectRows = await db
    .selectDistinct({ projectId: siteGateEvents.projectId })
    .from(siteGateEvents)
    .where(
      and(
        eq(siteGateEvents.companyId, companyId),
        gte(siteGateEvents.occurredAt, new Date(now.getTime() - REGISTER_WINDOW_DAYS * 86_400_000).toISOString()),
      ),
    );

  const raised = await alreadySignalled(db, companyId, ["site_overstay"]);
  let signalsRaised = 0;
  let overstays = 0;

  for (const { projectId } of projectRows) {
    const register = await loadRegister(db, companyId, projectId, nowIso);
    for (const person of register.overstays) {
      overstays += 1;
      const key = `overstay:${projectId}:${person.personKey}:${person.sinceAt ?? ""}`;
      if (raised.has(key)) continue;
      await raiseSignal(db, companyId, projectId, null, {
        detector: "site_overstay",
        severity: "medium",
        confidence: 0.8,
        title: `${person.personName} has been on the register for ${Math.round((person.openMinutes ?? 0) / 60)} hours`,
        explanation: `The gate feed records an entry at ${person.sinceAt} with no exit. Either the person is still on site well beyond a shift, or an exit read was missed. The platform does not invent the exit.`,
        key,
        subjectType: "site_access_pass",
        subjectId: person.passId ?? person.personKey,
        evidence: { personKey: person.personKey, sinceAt: person.sinceAt, openMinutes: person.openMinutes },
      });
      signalsRaised += 1;
    }
  }
  return { overstays, signalsRaised };
}

/* ================================================================== */
/* Weather                                                             */
/* ================================================================== */

export function toWeatherReading(row: typeof siteWeatherObservations.$inferSelect): WeatherReading {
  return {
    observedOn: row.observedOn,
    precipitationMm: row.precipitationMm,
    snowfallMm: row.snowfallMm,
    tempMinC: row.tempMinC,
    tempMaxC: row.tempMaxC,
    windMeanKph: row.windMeanKph,
    windGustKph: row.windGustKph,
    humidityPct: row.humidityPct,
    visibilityM: row.visibilityM,
    seaStateM: row.seaStateM,
    workStopped: row.workStopped,
    hoursLost: row.hoursLost,
  };
}

/**
 * Run the exceptional-weather comparison and store it as a numbered analysis.
 * Every observation inside the window is stamped with its adverse verdict and
 * the reasons, so the archive itself carries the finding, not just the report.
 */
export async function runWeatherAnalysis(
  db: Db,
  companyId: string,
  projectId: string,
  actorId: string | null,
  input: { baselineId: string; periodStart: string; periodEnd: string; notes?: string | null },
) {
  const baselineRows = await db
    .select()
    .from(siteWeatherBaselines)
    .where(
      and(
        eq(siteWeatherBaselines.id, input.baselineId),
        eq(siteWeatherBaselines.companyId, companyId),
        eq(siteWeatherBaselines.projectId, projectId),
      ),
    )
    .limit(1);
  const baseline = baselineRows[0];
  if (!baseline) throw new Error(`Weather baseline ${input.baselineId} not found in this project`);

  const observationRows = await db
    .select()
    .from(siteWeatherObservations)
    .where(
      and(
        eq(siteWeatherObservations.companyId, companyId),
        eq(siteWeatherObservations.projectId, projectId),
        gte(siteWeatherObservations.observedOn, input.periodStart),
        lte(siteWeatherObservations.observedOn, input.periodEnd),
      ),
    )
    .orderBy(asc(siteWeatherObservations.observedOn))
    .limit(5000);

  const thresholds = (baseline.thresholds ?? []) as Threshold[];
  const analysis = analyseWeather(observationRows.map(toWeatherReading), thresholds, {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    monthlyExpectedAdverseDays: baseline.monthlyExpectedAdverseDays ?? {},
  });

  // Stamp the archive with the verdict for each day so the register itself
  // carries the finding, not only the report.
  const adverseByDate = new Map(analysis.adverseDayDetail.map((d) => [d.date, d.reasons]));
  for (const row of observationRows) {
    const reasons = adverseByDate.get(row.observedOn);
    const adverse = reasons ? 1 : 0;
    if (row.adverse === adverse && JSON.stringify(row.adverseReasons ?? []) === JSON.stringify(reasons ?? [])) continue;
    await db
      .update(siteWeatherObservations)
      .set({ adverse, adverseReasons: reasons ?? [], updatedAt: nowISO() })
      .where(and(eq(siteWeatherObservations.id, row.id), eq(siteWeatherObservations.companyId, companyId)));
  }

  const { number, reference } = await allocateReference(db, projectId, "site_weather_analysis", "WX");
  const id = newId("wxa");
  const [saved] = await db
    .insert(siteWeatherAnalyses)
    .values({
      id,
      companyId,
      projectId,
      number,
      reference,
      baselineId: baseline.id,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      status: "draft",
      daysInPeriod: analysis.daysInPeriod,
      daysObserved: analysis.daysObserved,
      observedAdverseDays: analysis.observedAdverseDays,
      baselineAdverseDays: analysis.baselineAdverseDays,
      exceptionalDays: analysis.exceptionalDays,
      hoursLost: analysis.hoursLost,
      coveragePercent: analysis.coveragePercent,
      byMonth: analysis.byMonth,
      adverseDayDetail: analysis.adverseDayDetail,
      reasons: analysis.reasons,
      notes: input.notes ?? null,
      generatedBy: actorId ?? "system",
    })
    .returning();

  await ledger(db, {
    companyId,
    projectId,
    actorId,
    action: "create",
    objectType: "site_weather_analysis",
    objectId: id,
    payload: {
      reference,
      baselineId: baseline.id,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      observedAdverseDays: analysis.observedAdverseDays,
      exceptionalDays: analysis.exceptionalDays,
    },
  });

  return { analysis: saved!, engine: analysis, baseline };
}

/**
 * Pull provider observations for a window and store what came back. Existing
 * rows for (date, provider) are updated rather than duplicated; a manual
 * observation for the same date is never overwritten, because a person on the
 * site outranks a model of it.
 */
export async function captureWeather(
  db: Db,
  companyId: string,
  projectId: string,
  actorId: string | null,
  input: { from: string; to: string },
  options: { fetchImpl?: FetchLike; enabled?: boolean } = {},
) {
  const projectRows = await db
    .select({ id: projects.id, latitude: projects.latitude, longitude: projects.longitude })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
    .limit(1);
  const project = projectRows[0];
  if (!project) throw new Error(`Project ${projectId} not found`);

  const result = await fetchArchive(
    { latitude: project.latitude, longitude: project.longitude, from: input.from, to: input.to },
    options,
  );

  if (result.readings.length === 0) {
    return { inserted: 0, updated: 0, provider: result.provider, reasons: result.reasons };
  }

  const existing = await db
    .select({ id: siteWeatherObservations.id, observedOn: siteWeatherObservations.observedOn })
    .from(siteWeatherObservations)
    .where(
      and(
        eq(siteWeatherObservations.companyId, companyId),
        eq(siteWeatherObservations.projectId, projectId),
        eq(siteWeatherObservations.source, "provider"),
        gte(siteWeatherObservations.observedOn, input.from),
        lte(siteWeatherObservations.observedOn, input.to),
      ),
    );
  const byDate = new Map(existing.map((r) => [r.observedOn, r.id]));

  let inserted = 0;
  let updated = 0;
  for (const reading of result.readings) {
    const values = {
      tempMinC: reading.tempMinC,
      tempMaxC: reading.tempMaxC,
      tempMeanC: reading.tempMeanC,
      precipitationMm: reading.precipitationMm,
      snowfallMm: reading.snowfallMm,
      windMeanKph: reading.windMeanKph,
      windGustKph: reading.windGustKph,
      conditions: reading.conditions,
      provider: result.provider,
      raw: reading.raw,
      updatedAt: nowISO(),
    };
    const existingId = byDate.get(reading.observedOn);
    if (existingId) {
      await db
        .update(siteWeatherObservations)
        .set(values)
        .where(and(eq(siteWeatherObservations.id, existingId), eq(siteWeatherObservations.companyId, companyId)));
      updated += 1;
    } else {
      const id = newId("wxo");
      await db.insert(siteWeatherObservations).values({
        id,
        companyId,
        projectId,
        observedOn: reading.observedOn,
        source: "provider",
        recordedBy: actorId,
        ...values,
      });
      inserted += 1;
    }
  }

  await ledger(db, {
    companyId,
    projectId,
    actorId,
    action: "create",
    objectType: "site_weather_observation",
    objectId: `${projectId}:${input.from}:${input.to}`,
    payload: { provider: result.provider, inserted, updated, from: input.from, to: input.to },
  });

  return { inserted, updated, provider: result.provider, reasons: result.reasons };
}

/* ================================================================== */
/* Progress determination — the assurance primitives                   */
/* ================================================================== */

export interface ProgressRecordInput {
  zoneName: string;
  locationId?: string | null;
  scheduleTaskId?: string | null;
  workPackageRef?: string | null;
  claimedPercent: number;
  observedPercent: number;
  method: string;
  observedAt: string;
  claimSourceType: string;
  claimSourceId?: string | null;
  claimantId: string;
  claimantKind: string;
  claimedAt?: string | null;
  scanId?: string | null;
  droneFlightId?: string | null;
  fileIds: string[];
  notes?: string | null;
  tolerancePercent?: number;
}

/**
 * Write the Assertion / Evidence / Reconciliation triple for one progress
 * observation and the site record that points at all three.
 *
 * The caller has already run `assessProgress` (which enforces the
 * different-actor rule and refuses a self-verified claim), so this function
 * only persists — it never decides.
 */
export async function recordProgressObservation(
  db: Db,
  companyId: string,
  projectId: string,
  observer: { userId: string; vendorId?: string | null },
  input: ProgressRecordInput,
  assessment: {
    variancePercent: number;
    result: string;
    confidence: number;
    independenceScore: number;
    independenceBasis: string[];
    overclaim: boolean;
    reasons: string[];
  },
) {
  const { number, reference } = await allocateReference(db, projectId, "site_progress_observation", "PRG");
  const at = nowISO();

  const assertionId = newId("asr");
  await db.insert(assertions).values({
    id: assertionId,
    companyId,
    projectId,
    kind: "progress_percent",
    claimantId: input.claimantId,
    claimantKind: input.claimantKind,
    value: input.claimedPercent,
    unit: "percent",
    basis: `${input.claimSourceType.replace(/_/g, " ")} claim of ${input.claimedPercent}% for ${input.zoneName}`,
    sourceType: input.claimSourceType,
    sourceId: input.claimSourceId ?? null,
    assertedAt: input.claimedAt ?? input.observedAt,
    createdBy: observer.userId,
  });

  const evidenceId = newId("evd");
  const contentHash = hashPayload({
    zone: input.zoneName,
    observedPercent: input.observedPercent,
    method: input.method,
    observedAt: input.observedAt,
    observedBy: observer.userId,
    scanId: input.scanId ?? null,
    droneFlightId: input.droneFlightId ?? null,
    fileIds: [...input.fileIds].sort(),
  });
  await db.insert(evidence).values({
    id: evidenceId,
    companyId,
    projectId,
    kind: input.method === "scan" || input.method === "drone" ? "reality_capture" : input.method === "photo" ? "photograph" : input.method === "survey" ? "survey" : "inspection",
    source: `site observation (${input.method})`,
    contentHash,
    fileId: input.fileIds[0] ?? null,
    capturedAt: input.observedAt,
    independenceScore: assessment.independenceScore,
    provenance: {
      observedBy: observer.userId,
      observerVendorId: observer.vendorId ?? null,
      claimantId: input.claimantId,
      method: input.method,
      basis: assessment.independenceBasis,
      scanId: input.scanId ?? null,
      droneFlightId: input.droneFlightId ?? null,
    },
    metadata: {
      zoneName: input.zoneName,
      observedPercent: input.observedPercent,
      fileIds: input.fileIds,
    },
    submittedBy: observer.userId,
  });

  const reconciliationId = newId("rec");
  await db.insert(reconciliations).values({
    id: reconciliationId,
    companyId,
    projectId,
    assertionId,
    evidenceIds: [evidenceId],
    method: `progress_${input.method}`,
    result: assessment.result,
    variance: Math.round((input.claimedPercent - input.observedPercent) * 100) / 100,
    variancePercent: assessment.variancePercent,
    confidence: assessment.confidence,
    notes: assessment.reasons.join(" "),
    createdBy: observer.userId,
  });

  const id = newId("spo");
  const [saved] = await db
    .insert(siteProgressObservations)
    .values({
      id,
      companyId,
      projectId,
      number,
      reference,
      zoneName: input.zoneName,
      locationId: input.locationId ?? null,
      scheduleTaskId: input.scheduleTaskId ?? null,
      workPackageRef: input.workPackageRef ?? null,
      claimedPercent: input.claimedPercent,
      observedPercent: input.observedPercent,
      variancePercent: assessment.variancePercent,
      method: input.method,
      observedAt: input.observedAt,
      observedBy: observer.userId,
      claimSourceType: input.claimSourceType,
      claimSourceId: input.claimSourceId ?? null,
      claimantId: input.claimantId,
      claimantKind: input.claimantKind,
      claimedAt: input.claimedAt ?? null,
      scanId: input.scanId ?? null,
      droneFlightId: input.droneFlightId ?? null,
      fileIds: input.fileIds,
      assertionId,
      evidenceId,
      reconciliationId,
      result: assessment.result,
      confidence: assessment.confidence,
      independenceScore: assessment.independenceScore,
      notes: input.notes ?? null,
      createdBy: observer.userId,
    })
    .returning();

  for (const [objectType, objectId] of [
    ["assertion", assertionId],
    ["evidence", evidenceId],
    ["reconciliation", reconciliationId],
    ["site_progress_observation", id],
  ] as const) {
    await ledger(db, {
      companyId,
      projectId,
      actorId: observer.userId,
      action: "create",
      objectType,
      objectId,
      payload: {
        reference,
        zone: input.zoneName,
        claimedPercent: input.claimedPercent,
        observedPercent: input.observedPercent,
        result: assessment.result,
        at,
      },
    });
  }

  return { record: saved!, assertionId, evidenceId, reconciliationId };
}

/* ================================================================== */
/* Summary and health inputs                                           */
/* ================================================================== */

export interface SiteSummary {
  asOf: string;
  register: {
    headcount: number;
    windowFrom: string;
    overstays: number;
    anomalies: number;
    refusedEvents: number;
    reasons: string[];
  };
  access: { activePasses: number; validInductions: number; expiringPasses: number };
  permits: { open: number; active: number; expired: number; byType: Record<string, number> };
  entries: { inside: number; overdue: number };
  loneWorkers: { active: number; overdue: number; escalated: number };
  zones: { active: number };
  weather: { observations: number; lastObservedOn: string | null; analyses: number; lastExceptionalDays: number | null };
  capture: { flights: number; scans: number; deviationsOutOfTolerance: number; toursPublished: number };
  ground: { investigations: number; openFindings: number; strikes: number; nearMisses: number };
  environmental: { open: number; exceedances: number };
  progress: { observations: number; overclaims: number; worstVariance: Figure };
  settingOut: { awaitingCheck: number };
  signals: { open: number };
}

export async function siteSummary(
  db: Db,
  companyId: string,
  projectId: string,
  asOf: string,
): Promise<SiteSummary> {
  const today = asOf.slice(0, 10);
  const soon = new Date(Date.parse(`${today}T00:00:00.000Z`) + 30 * 86_400_000).toISOString().slice(0, 10);
  const LIMIT = 20_000;

  const [
    register,
    passRows,
    inductionRows,
    permitRows,
    entryRows,
    loneRows,
    zoneRows,
    weatherRows,
    analysisRows,
    flightRows,
    scanRows,
    deviationRows,
    tourRows,
    strikeRows,
    investigationRows,
    findingRows,
    envRows,
    progressRows,
    settingOutRows,
    openSignals,
  ] = await Promise.all([
    loadRegister(db, companyId, projectId, asOf),
    db
      .select({ status: siteAccessPasses.status, validUntil: siteAccessPasses.validUntil })
      .from(siteAccessPasses)
      .where(and(eq(siteAccessPasses.companyId, companyId), eq(siteAccessPasses.projectId, projectId)))
      .limit(LIMIT),
    db
      .select({ status: siteInductions.status })
      .from(siteInductions)
      .where(and(eq(siteInductions.companyId, companyId), eq(siteInductions.projectId, projectId)))
      .limit(LIMIT),
    db
      .select({ status: sitePermits.status, permitType: sitePermits.permitType })
      .from(sitePermits)
      .where(and(eq(sitePermits.companyId, companyId), eq(sitePermits.projectId, projectId)))
      .limit(LIMIT),
    db
      .select({ status: sitePermitEntries.status })
      .from(sitePermitEntries)
      .where(and(eq(sitePermitEntries.companyId, companyId), eq(sitePermitEntries.projectId, projectId)))
      .limit(LIMIT),
    db
      .select({ status: siteLoneWorkerSessions.status })
      .from(siteLoneWorkerSessions)
      .where(and(eq(siteLoneWorkerSessions.companyId, companyId), eq(siteLoneWorkerSessions.projectId, projectId)))
      .limit(LIMIT),
    db
      .select({ status: siteExclusionZones.status })
      .from(siteExclusionZones)
      .where(and(eq(siteExclusionZones.companyId, companyId), eq(siteExclusionZones.projectId, projectId)))
      .limit(LIMIT),
    db
      .select({ observedOn: siteWeatherObservations.observedOn })
      .from(siteWeatherObservations)
      .where(and(eq(siteWeatherObservations.companyId, companyId), eq(siteWeatherObservations.projectId, projectId)))
      .orderBy(desc(siteWeatherObservations.observedOn))
      .limit(LIMIT),
    db
      .select({ exceptionalDays: siteWeatherAnalyses.exceptionalDays })
      .from(siteWeatherAnalyses)
      .where(and(eq(siteWeatherAnalyses.companyId, companyId), eq(siteWeatherAnalyses.projectId, projectId)))
      .orderBy(desc(siteWeatherAnalyses.generatedAt))
      .limit(500),
    db
      .select({ status: siteDroneFlights.status })
      .from(siteDroneFlights)
      .where(and(eq(siteDroneFlights.companyId, companyId), eq(siteDroneFlights.projectId, projectId)))
      .limit(LIMIT),
    db
      .select({ status: siteScans.status })
      .from(siteScans)
      .where(and(eq(siteScans.companyId, companyId), eq(siteScans.projectId, projectId)))
      .limit(LIMIT),
    db
      .select({ verdict: siteScanDeviations.verdict })
      .from(siteScanDeviations)
      .where(and(eq(siteScanDeviations.companyId, companyId), eq(siteScanDeviations.projectId, projectId)))
      .limit(LIMIT),
    db
      .select({ status: sitePhotoTours.status })
      .from(sitePhotoTours)
      .where(and(eq(sitePhotoTours.companyId, companyId), eq(sitePhotoTours.projectId, projectId)))
      .limit(LIMIT),
    db
      .select({ severity: siteUtilityStrikes.severity, status: siteUtilityStrikes.status })
      .from(siteUtilityStrikes)
      .where(and(eq(siteUtilityStrikes.companyId, companyId), eq(siteUtilityStrikes.projectId, projectId)))
      .limit(LIMIT),
    db
      .select({ status: siteGeotechInvestigations.status })
      .from(siteGeotechInvestigations)
      .where(and(eq(siteGeotechInvestigations.companyId, companyId), eq(siteGeotechInvestigations.projectId, projectId)))
      .limit(LIMIT),
    db
      .select({ status: siteGroundFindings.status })
      .from(siteGroundFindings)
      .where(and(eq(siteGroundFindings.companyId, companyId), eq(siteGroundFindings.projectId, projectId)))
      .limit(LIMIT),
    db
      .select({ status: siteEnvironmentalEvents.status, exceeded: siteEnvironmentalEvents.exceededThreshold })
      .from(siteEnvironmentalEvents)
      .where(and(eq(siteEnvironmentalEvents.companyId, companyId), eq(siteEnvironmentalEvents.projectId, projectId)))
      .limit(LIMIT),
    db
      .select({ result: siteProgressObservations.result, variancePercent: siteProgressObservations.variancePercent })
      .from(siteProgressObservations)
      .where(and(eq(siteProgressObservations.companyId, companyId), eq(siteProgressObservations.projectId, projectId)))
      .limit(LIMIT),
    db
      .select({ status: siteSettingOutRecords.status })
      .from(siteSettingOutRecords)
      .where(and(eq(siteSettingOutRecords.companyId, companyId), eq(siteSettingOutRecords.projectId, projectId)))
      .limit(LIMIT),
    db
      .select({ n: count() })
      .from(signals)
      .where(
        and(
          eq(signals.companyId, companyId),
          eq(signals.projectId, projectId),
          inArray(signals.detector, [...SITE_DETECTOR_LIST]),
          inArray(signals.disposition, ["new", "under_review", "escalated"]),
        ),
      ),
  ]);

  const byType: Record<string, number> = {};
  let permitsOpen = 0;
  let permitsActive = 0;
  let permitsExpired = 0;
  for (const p of permitRows) {
    if ((OPEN_PERMIT_STATUSES as readonly string[]).includes(p.status)) {
      permitsOpen += 1;
      byType[p.permitType] = (byType[p.permitType] ?? 0) + 1;
    }
    if (p.status === "active") permitsActive += 1;
    if (p.status === "expired") permitsExpired += 1;
  }

  const overclaims = progressRows.filter(
    (r) => r.result === "unsupported" || r.result === "contradicted" || r.result === "partially_supported",
  );
  const worstVariance = overclaims.reduce<number | null>(
    (m, r) => (m === null || r.variancePercent > m ? r.variancePercent : m),
    null,
  );

  return {
    asOf,
    register: {
      headcount: register.headcount,
      windowFrom: register.windowFrom,
      overstays: register.overstays.length,
      anomalies: register.anomalyCount,
      refusedEvents: register.refusedEvents,
      reasons: register.reasons,
    },
    access: {
      activePasses: passRows.filter((p) => p.status === "active").length,
      validInductions: inductionRows.filter((i) => i.status === "valid").length,
      expiringPasses: passRows.filter((p) => p.status === "active" && p.validUntil !== null && p.validUntil <= soon).length,
    },
    permits: { open: permitsOpen, active: permitsActive, expired: permitsExpired, byType },
    entries: {
      inside: entryRows.filter((e) => e.status === "inside").length,
      overdue: entryRows.filter((e) => e.status === "overdue").length,
    },
    loneWorkers: {
      active: loneRows.filter((l) => l.status === "active").length,
      overdue: loneRows.filter((l) => l.status === "overdue").length,
      escalated: loneRows.filter((l) => l.status === "escalated").length,
    },
    zones: { active: zoneRows.filter((z) => z.status === "active").length },
    weather: {
      observations: weatherRows.length,
      lastObservedOn: weatherRows[0]?.observedOn ?? null,
      analyses: analysisRows.length,
      lastExceptionalDays: analysisRows[0]?.exceptionalDays ?? null,
    },
    capture: {
      flights: flightRows.length,
      scans: scanRows.length,
      deviationsOutOfTolerance: deviationRows.filter((d) => d.verdict === "out_of_tolerance").length,
      toursPublished: tourRows.filter((t) => t.status === "published").length,
    },
    ground: {
      investigations: investigationRows.length,
      openFindings: findingRows.filter((f) => f.status === "open").length,
      strikes: strikeRows.length,
      nearMisses: strikeRows.filter((s) => s.severity === "near_miss").length,
    },
    environmental: {
      open: envRows.filter((e) => e.status !== "closed").length,
      exceedances: envRows.filter((e) => e.exceeded === 1).length,
    },
    progress: {
      observations: progressRows.length,
      overclaims: overclaims.length,
      worstVariance:
        worstVariance === null
          ? figure(null, "percentage points", { observations: progressRows.length }, [
              "No progress observation has found an overclaim.",
            ])
          : figure(round1(worstVariance), "percentage points", { observations: progressRows.length }),
    },
    settingOut: { awaitingCheck: settingOutRows.filter((s) => s.status === "set_out").length },
    signals: { open: openSignals[0]?.n ?? 0 },
  };
}

/* ================================================================== */
/* Health inputs (contract 3.5)                                        */
/* ================================================================== */

export interface HealthInputs {
  metrics: Record<string, number | null>;
  reasons: string[];
}

/**
 * What the intelligence layer reads from site operations. Every metric that
 * cannot be derived is `null` with a reason — a project with no gate feed has
 * an UNKNOWN headcount, not a headcount of zero, and a health score built on
 * a fabricated zero would be worse than no score.
 */
export async function siteHealthInputs(
  db: Db,
  companyId: string,
  projectId: string,
  asOf: string,
): Promise<HealthInputs> {
  const summary = await siteSummary(db, companyId, projectId, asOf);
  const reasons: string[] = [...summary.register.reasons];
  const hasGateFeed = summary.register.headcount > 0 || summary.register.refusedEvents > 0 || summary.register.anomalies > 0;

  const metrics: Record<string, number | null> = {
    siteHeadcount: hasGateFeed ? summary.register.headcount : null,
    siteOverstays: hasGateFeed ? summary.register.overstays : null,
    sitePermitsActive: summary.permits.active,
    sitePermitsExpiredOpen: summary.permits.expired,
    siteConfinedSpaceOverdue: summary.entries.overdue,
    siteLoneWorkerEscalated: summary.loneWorkers.escalated,
    sitePassesWithoutInduction: Math.max(0, summary.access.activePasses - summary.access.validInductions),
    siteOpenGroundFindings: summary.ground.openFindings,
    siteUtilityStrikes: summary.ground.strikes,
    siteEnvironmentalExceedances: summary.environmental.exceedances,
    siteProgressOverclaims: summary.progress.observations > 0 ? summary.progress.overclaims : null,
    siteWorstProgressVariance: summary.progress.worstVariance.value,
    siteScanDeviationsOutOfTolerance: summary.capture.deviationsOutOfTolerance,
    siteExceptionalWeatherDays: summary.weather.lastExceptionalDays,
    siteSettingOutAwaitingCheck: summary.settingOut.awaitingCheck,
    siteOpenSignals: summary.signals.open,
  };

  if (!hasGateFeed) {
    reasons.push("Headcount and overstay figures are not available: this project has no gate feed.");
  }
  if (summary.progress.observations === 0) {
    reasons.push("No independent progress observation has been recorded, so claimed progress is untested here.");
  }
  if (summary.weather.lastExceptionalDays === null) {
    reasons.push("No exceptional-weather analysis has been run, so weather entitlement is not quantified.");
  }
  return { metrics, reasons };
}
