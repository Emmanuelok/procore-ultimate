/**
 * Twin alerting: sensor thresholds, stale channels and warranty expiry
 * (spec Domain L #642-644, #659-661).
 *
 * THE RULE: one condition, one alert. A gateway that pushes a 5,000-reading
 * batch where 4,000 readings are above the maximum is ONE breach of ONE
 * sensor, not 4,000 events, 4,000 notifications and 4,000 signals. The
 * evaluation below collapses a batch into at most one alert per bound,
 * refreshes the open alert while the condition persists, and respects a
 * per-sensor cool-down so a flapping channel cannot manufacture an event
 * storm. An alert is closed by a person (acknowledge) or by the data (a full
 * batch back inside the thresholds clears it).
 */
import type { FastifyInstance } from "fastify";
import { and, eq, inArray, isNotNull, lte } from "drizzle-orm";
import {
  assets,
  events,
  obligations,
  sensorAlerts,
  sensors,
  warranties,
} from "@constructos/db";
import type { SensorAlertKind } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { forEachCompany } from "../../lib/scheduler.js";
import { pushNotifications } from "../notifications/service.js";
import { addDays, daysBetween, ledger, nowISO, raiseTwinSignal, todayISO } from "./shared.js";

/* ------------------------------------------------------------------ */
/* Pure evaluation                                                     */
/* ------------------------------------------------------------------ */

export interface ThresholdReading {
  value: number;
  at: string;
}

export interface ThresholdBounds {
  minValue: number | null;
  maxValue: number | null;
}

export interface BreachSummary {
  kind: Extract<SensorAlertKind, "min_breach" | "max_breach">;
  threshold: number;
  count: number;
  worstValue: number;
  firstAt: string;
  lastAt: string;
}

/** Collapse a batch of readings into at most one summary per breached bound. */
export function evaluateBreaches(
  readings: ThresholdReading[],
  bounds: ThresholdBounds,
): BreachSummary[] {
  const out: BreachSummary[] = [];
  const fold = (
    kind: BreachSummary["kind"],
    threshold: number,
    predicate: (value: number) => boolean,
    worse: (a: number, b: number) => number,
  ) => {
    const hits = readings.filter((r) => predicate(r.value));
    if (hits.length === 0) return;
    const sorted = [...hits].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    out.push({
      kind,
      threshold,
      count: hits.length,
      worstValue: hits.reduce((acc, r) => worse(acc, r.value), hits[0]!.value),
      firstAt: sorted[0]!.at,
      lastAt: sorted[sorted.length - 1]!.at,
    });
  };
  if (bounds.minValue !== null) {
    fold("min_breach", bounds.minValue, (v) => v < bounds.minValue!, (a, b) => Math.min(a, b));
  }
  if (bounds.maxValue !== null) {
    fold("max_breach", bounds.maxValue, (v) => v > bounds.maxValue!, (a, b) => Math.max(a, b));
  }
  return out;
}

/** Cool-down guard: has enough time passed since the last alert on this sensor? */
export function coolDownElapsed(
  lastAlertAt: string | null,
  now: string,
  cooldownMinutes: number,
): boolean {
  if (!lastAlertAt) return true;
  const elapsed = Date.parse(now) - Date.parse(lastAlertAt);
  if (!Number.isFinite(elapsed)) return true;
  return elapsed >= Math.max(0, cooldownMinutes) * 60_000;
}

/** Which notification horizon (days) should fire for an expiry, if any. */
export function expiryHorizon(daysLeft: number, alreadyNotified: number | null): number | null {
  const horizons = [90, 30, 7, 0];
  for (const h of horizons) {
    if (daysLeft <= h && (alreadyNotified === null || h < alreadyNotified)) return h;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

export interface AlertOutcome {
  raised: number;
  refreshed: number;
  suppressed: number;
  cleared: number;
}

/**
 * Apply a batch's breaches to the alert register. Returns what actually
 * happened so the ingest route can report it instead of guessing.
 */
export async function applyBreaches(
  app: FastifyInstance,
  sensor: typeof sensors.$inferSelect,
  breaches: BreachSummary[],
  actorId: string | null,
  now = nowISO(),
): Promise<AlertOutcome> {
  const outcome: AlertOutcome = { raised: 0, refreshed: 0, suppressed: 0, cleared: 0 };
  const open = await app.db
    .select()
    .from(sensorAlerts)
    .where(
      and(
        eq(sensorAlerts.sensorId, sensor.id),
        inArray(sensorAlerts.status, ["open", "acknowledged"]),
      ),
    );

  // a batch with no breach on a bound clears the alert that bound holds
  for (const alert of open) {
    if (alert.kind === "stale") continue;
    if (breaches.some((b) => b.kind === alert.kind)) continue;
    await app.db
      .update(sensorAlerts)
      .set({ status: "cleared", clearedAt: now, updatedAt: now })
      .where(eq(sensorAlerts.id, alert.id));
    outcome.cleared += 1;
  }

  for (const breach of breaches) {
    const existing = open.find((a) => a.kind === breach.kind);
    if (existing) {
      await app.db
        .update(sensorAlerts)
        .set({
          breachCount: existing.breachCount + breach.count,
          value: breach.worstValue,
          lastBreachAt: breach.lastAt,
          updatedAt: now,
        })
        .where(eq(sensorAlerts.id, existing.id));
      outcome.refreshed += 1;
      continue;
    }
    if (!coolDownElapsed(sensor.lastAlertAt, now, sensor.cooldownMinutes)) {
      outcome.suppressed += 1;
      continue;
    }

    const alertId = newId("sal");
    const eventId = newId("evt");
    await app.db.insert(events).values({
      id: eventId,
      companyId: sensor.companyId,
      projectId: sensor.projectId,
      type: "sensor_threshold_breach",
      occurredAt: breach.firstAt,
      detectedOrReported: "detected",
      payload: {
        sensorId: sensor.id,
        kind: breach.kind,
        threshold: breach.threshold,
        worstValue: breach.worstValue,
        readings: breach.count,
      },
      createdBy: actorId,
    });

    // the asset lookup is company-scoped: an asset bound from another tenant
    // must never be read here, let alone notified
    const assetRows = sensor.assetId
      ? await app.db
          .select({
            id: assets.id,
            name: assets.name,
            ownerId: assets.ownerId,
            createdBy: assets.createdBy,
            criticality: assets.criticality,
          })
          .from(assets)
          .where(and(eq(assets.id, sensor.assetId), eq(assets.companyId, sensor.companyId)))
          .limit(1)
      : [];
    const asset = assetRows[0];

    const signalId = await raiseTwinSignal(
      app.db,
      sensor.companyId,
      sensor.projectId,
      actorId,
      {
        detector: "twin_sensor_threshold",
        severity: asset?.criticality === "critical" ? "high" : "medium",
        confidence: 1,
        title: `${sensor.name} breached its ${breach.kind === "min_breach" ? "minimum" : "maximum"}`,
        explanation: `${breach.count} reading(s) between ${breach.firstAt} and ${breach.lastAt} breached the ${
          breach.kind === "min_breach" ? "minimum" : "maximum"
        } of ${breach.threshold} ${sensor.unit}; worst value ${breach.worstValue} ${sensor.unit}${
          asset ? ` on asset ${asset.name}` : ""
        }.`,
        key: `twin_sensor_threshold:${sensor.id}:${breach.kind}:${breach.firstAt}`,
        evidence: {
          sensorId: sensor.id,
          eventId,
          threshold: breach.threshold,
          worstValue: breach.worstValue,
          readings: breach.count,
        },
        subjectType: "sensor",
        subjectId: sensor.id,
      },
    );

    await app.db.insert(sensorAlerts).values({
      id: alertId,
      companyId: sensor.companyId,
      projectId: sensor.projectId,
      sensorId: sensor.id,
      assetId: asset?.id ?? null,
      kind: breach.kind,
      status: "open",
      value: breach.worstValue,
      threshold: breach.threshold,
      breachCount: breach.count,
      firstBreachAt: breach.firstAt,
      lastBreachAt: breach.lastAt,
      eventId,
      signalId,
    });

    const recipient = sensor.ownerId ?? asset?.ownerId ?? asset?.createdBy ?? null;
    if (recipient) {
      await pushNotifications(app.db, [
        {
          companyId: sensor.companyId,
          userId: recipient,
          projectId: sensor.projectId,
          kind: "signal",
          title: `Sensor threshold breach: ${sensor.name}`,
          body: `${breach.count} reading(s) breached ${breach.threshold} ${sensor.unit}${
            asset ? ` on ${asset.name}` : ""
          }`,
          recordType: "sensor",
          recordId: sensor.id,
        },
      ]);
    }

    await app.db
      .update(sensors)
      .set({ lastAlertAt: now })
      .where(eq(sensors.id, sensor.id));
    sensor.lastAlertAt = now;
    outcome.raised += 1;

    await ledger(app.db, {
      companyId: sensor.companyId,
      projectId: sensor.projectId,
      actorId,
      action: "create",
      objectType: "sensor_alert",
      objectId: alertId,
      payload: { sensorId: sensor.id, kind: breach.kind, threshold: breach.threshold },
      storePayload: true,
    });
  }

  return outcome;
}

/* ------------------------------------------------------------------ */
/* Sweeps                                                              */
/* ------------------------------------------------------------------ */

/** Sensors that have stopped reporting (#661 data completeness). */
export async function sweepStaleSensors(
  app: FastifyInstance,
  companyId: string,
  now: Date,
): Promise<{ checked: number; stale: number }> {
  const rows = await app.db
    .select()
    .from(sensors)
    .where(
      and(
        eq(sensors.companyId, companyId),
        eq(sensors.isActive, "true"),
        isNotNull(sensors.staleAfterMinutes),
      ),
    )
    .limit(2000);
  let stale = 0;
  for (const sensor of rows) {
    const limitMs = (sensor.staleAfterMinutes ?? 0) * 60_000;
    if (limitMs <= 0) continue;
    const last = sensor.lastReadingAt ? Date.parse(sensor.lastReadingAt) : null;
    const silentFor = last === null ? Infinity : now.getTime() - last;
    if (silentFor < limitMs) continue;
    const existing = await app.db
      .select({ id: sensorAlerts.id })
      .from(sensorAlerts)
      .where(
        and(
          eq(sensorAlerts.sensorId, sensor.id),
          eq(sensorAlerts.kind, "stale"),
          inArray(sensorAlerts.status, ["open", "acknowledged"]),
        ),
      )
      .limit(1);
    if (existing[0]) continue;
    const alertId = newId("sal");
    const signalId = await raiseTwinSignal(app.db, companyId, sensor.projectId, null, {
      detector: "twin_sensor_stale",
      severity: "low",
      confidence: 1,
      title: `${sensor.name} has stopped reporting`,
      explanation:
        last === null
          ? `${sensor.name} has never reported a reading, and is configured to report at least every ${sensor.staleAfterMinutes} minutes.`
          : `${sensor.name} last reported at ${sensor.lastReadingAt}, more than the configured ${sensor.staleAfterMinutes} minutes ago.`,
      key: `twin_sensor_stale:${sensor.id}:${sensor.lastReadingAt ?? "never"}`,
      evidence: { sensorId: sensor.id, lastReadingAt: sensor.lastReadingAt },
      subjectType: "sensor",
      subjectId: sensor.id,
    });
    await app.db.insert(sensorAlerts).values({
      id: alertId,
      companyId,
      projectId: sensor.projectId,
      sensorId: sensor.id,
      assetId: sensor.assetId,
      kind: "stale",
      status: "open",
      value: null,
      threshold: sensor.staleAfterMinutes,
      breachCount: 1,
      firstBreachAt: now.toISOString(),
      lastBreachAt: now.toISOString(),
      signalId,
    });
    stale += 1;
  }
  return { checked: rows.length, stale };
}

/**
 * Warranty expiry (#642-644): every active warranty gets an obligation so the
 * platform owns the deadline, notifications fire once per 90/30/7-day
 * horizon, and an expired warranty is marked expired rather than lingering as
 * "active" for ever.
 */
export async function sweepWarrantyExpiry(
  app: FastifyInstance,
  companyId: string,
  today = todayISO(),
): Promise<{ obligationsCreated: number; notified: number; expired: number }> {
  const horizonDate = addDays(today, 90);
  const rows = await app.db
    .select({ warranty: warranties, asset: assets })
    .from(warranties)
    .innerJoin(assets, eq(assets.id, warranties.assetId))
    .where(
      and(
        eq(warranties.companyId, companyId),
        eq(warranties.status, "active"),
        lte(warranties.endDate, horizonDate),
      ),
    )
    .limit(2000);

  let obligationsCreated = 0;
  let notified = 0;
  let expired = 0;

  for (const { warranty, asset } of rows) {
    const daysLeft = daysBetween(today, warranty.endDate);
    if (!Number.isFinite(daysLeft)) continue;

    if (!warranty.obligationId) {
      const obligationId = newId("obl");
      await app.db.insert(obligations).values({
        id: obligationId,
        companyId,
        projectId: warranty.projectId,
        sourceClause: `Warranty — ${warranty.provider}`,
        trigger: `Warranty on ${asset.name} (${asset.tagCode}) expires ${warranty.endDate}`,
        deadline: `${warranty.endDate}T23:59:59Z`,
        warnDaysBefore: 30,
        evidenceRequirement: "Renewal, extension or a closed defects list before expiry",
        status: "open",
        createdBy: warranty.createdBy ?? asset.createdBy,
      });
      await app.db
        .update(warranties)
        .set({ obligationId })
        .where(eq(warranties.id, warranty.id));
      warranty.obligationId = obligationId;
      obligationsCreated += 1;
      await ledger(app.db, {
        companyId,
        projectId: warranty.projectId,
        actorId: null,
        action: "create",
        objectType: "obligation",
        objectId: obligationId,
        payload: { warrantyId: warranty.id, assetId: asset.id, deadline: warranty.endDate },
        storePayload: true,
      });
    }

    const horizon = expiryHorizon(daysLeft, warranty.notifiedDays);
    if (horizon !== null) {
      const recipient = asset.ownerId ?? asset.createdBy;
      await pushNotifications(app.db, [
        {
          companyId,
          userId: recipient,
          projectId: warranty.projectId,
          kind: daysLeft <= 0 ? "overdue" : "due_soon",
          title:
            daysLeft <= 0
              ? `Warranty expired: ${asset.name}`
              : `Warranty expires in ${daysLeft} day(s): ${asset.name}`,
          body: `${warranty.provider} warranty on ${asset.tagCode} ends ${warranty.endDate}`,
          recordType: "warranty",
          recordId: warranty.id,
        },
      ]);
      await app.db
        .update(warranties)
        .set({ notifiedDays: horizon })
        .where(eq(warranties.id, warranty.id));
      notified += 1;
      if (daysLeft <= 30) {
        await raiseTwinSignal(app.db, companyId, warranty.projectId, null, {
          detector: "twin_warranty_expiring",
          severity: daysLeft <= 0 ? "medium" : "low",
          confidence: 1,
          title:
            daysLeft <= 0
              ? `Warranty expired on ${asset.name}`
              : `Warranty on ${asset.name} expires in ${daysLeft} days`,
          explanation: `${warranty.provider} warranty for ${asset.tagCode} ends ${warranty.endDate}. Confirm renewal or close outstanding defects before the liability transfers.`,
          key: `twin_warranty_expiring:${warranty.id}`,
          evidence: { warrantyId: warranty.id, assetId: asset.id, endDate: warranty.endDate },
          subjectType: "warranty",
          subjectId: warranty.id,
        });
      }
    }

    if (daysLeft < 0) {
      await app.db
        .update(warranties)
        .set({ status: "expired" })
        .where(eq(warranties.id, warranty.id));
      expired += 1;
    }
  }

  return { obligationsCreated, notified, expired };
}

/* ------------------------------------------------------------------ */
/* Scheduler registration                                              */
/* ------------------------------------------------------------------ */

export function registerTwinJobs(app: FastifyInstance): void {
  app.scheduler.register({
    name: "twin.warranty-expiry",
    description: "Raise warranty obligations, notify at 90/30/7 days and mark expired warranties",
    everyMs: 6 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) =>
      forEachCompany(db, (companyId) =>
        sweepWarrantyExpiry(app, companyId, now.toISOString().slice(0, 10)),
      ),
  });

  app.scheduler.register({
    name: "twin.sensor-stale",
    description: "Open an alert for sensors that stopped reporting within their expected interval",
    everyMs: 30 * 60_000,
    run: async ({ db, now }) => forEachCompany(db, (companyId) => sweepStaleSensors(app, companyId, now)),
  });
}

/** Exported for the manual "run now" endpoint and the tests. */
export async function runTwinSweeps(
  app: FastifyInstance,
  companyId: string,
  now: Date,
): Promise<Record<string, unknown>> {
  const warranty = await sweepWarrantyExpiry(app, companyId, now.toISOString().slice(0, 10));
  const stale = await sweepStaleSensors(app, companyId, now);
  return { warranty, stale };
}
