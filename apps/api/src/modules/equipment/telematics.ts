/**
 * M23 — telematics: the dataset contract for the ingestion inlet, and the
 * reconciliation that makes the feed worth having. PURE — no I/O.
 *
 * TELEMATICS IS AN INDEPENDENT EVIDENCE STREAM (ADR 0014). The value is not
 * a map with machine icons on it. It is that an OEM feed asserting 6.2
 * engine hours and an operator's timesheet claiming 9 are two accounts of
 * the same day produced by parties who do not share a pathway — exactly the
 * shape of the ghost-worker check in `modules/workforce/reconcile.ts`, which
 * this file deliberately mirrors down to the tolerance constants and the
 * "conditions evaluated independently, worst label reported" structure.
 *
 * THE COUNTER IS CUMULATIVE. A telematics engine-hour reading is an odometer,
 * not a duration: a day's hours are the LAST reading of the day minus the
 * FIRST. One reading in a day yields no duration at all, and a counter that
 * goes backwards mid-day is a device reset — both are reported as null with
 * a reason rather than as zero hours, because "the machine did not work" and
 * "the feed cannot say" are opposite management facts.
 *
 * UNMAPPED DEVICES ARE NEVER DROPPED. `equipment_telematics_readings.
 * equipmentId` is nullable precisely so a device reporting before anyone has
 * mapped it keeps its rows. Those rows are the evidence of when the mapping
 * was wrong, and discarding them destroys the only record that a machine was
 * running while the register said it was in the yard.
 */

import type { HireRateUnit, TelematicsProvider } from "@constructos/shared";
import { TELEMATICS_PROVIDERS } from "@constructos/shared";

export const round2 = (n: number): number => Math.round(n * 100) / 100;
export const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

export type IsoDate = string;

/* ------------------------------------------------------------------ */
/* The ingestion dataset contract                                      */
/* ------------------------------------------------------------------ */

/**
 * The dataset key this module pushes under. It intentionally matches the
 * shape of `INGESTION_DATASETS` in `@constructos/shared` — see the note on
 * `TELEMATICS_PUSH_SCOPES` for why the token scope check has to accept a
 * second value today.
 */
export const TELEMATICS_DATASET = "telematics" as const;

/**
 * API-token scopes accepted by the telematics inlet.
 *
 * `telematics` is the intended scope. `evidence` is accepted as well because
 * `POST /ingestion/tokens` validates requested scopes against
 * `INGESTION_DATASETS`, which does not yet carry a telematics member — so no
 * token can be MINTED with the intended scope until that shared enum gains
 * one. Accepting the generic machine-evidence scope keeps the inlet usable
 * without widening a token to every dataset on the platform, and the check
 * starts refusing `evidence` the day `telematics` becomes mintable.
 */
export const TELEMATICS_PUSH_SCOPES: readonly string[] = [TELEMATICS_DATASET, "evidence"];

export interface TelematicsFieldIssue {
  field: string | null;
  code: string;
  message: string;
}

/** One coerced reading, ready to insert. */
export interface CoercedTelematicsRow {
  providerKey: TelematicsProvider;
  deviceId: string;
  externalId: string | null;
  recordedAt: string;
  latitude: number | null;
  longitude: number | null;
  altitudeMetres: number | null;
  headingDegrees: number | null;
  speedKph: number | null;
  engineRunning: number | null;
  engineHours: number | null;
  idleHours: number | null;
  odometerKm: number | null;
  fuelLevelPercent: number | null;
  fuelUsedLitres: number | null;
  engineLoadPercent: number | null;
  coolantTempC: number | null;
  batteryVoltage: number | null;
  defLevelPercent: number | null;
  payloadTonnes: number | null;
  faultCodes: unknown[];
  raw: Record<string, unknown>;
}

/** The fields the inlet understands, published so a vendor can be told what
 *  to send and the UI can render a mapping table without guessing. */
export const TELEMATICS_FIELDS = [
  { key: "deviceId", required: true, type: "string", label: "Device / unit identifier" },
  { key: "recordedAt", required: true, type: "timestamp", label: "Reading timestamp (ISO 8601)" },
  { key: "providerKey", required: false, type: "enum", label: "Telematics provider" },
  { key: "externalId", required: false, type: "string", label: "Provider's own row id" },
  { key: "latitude", required: false, type: "number", label: "Latitude" },
  { key: "longitude", required: false, type: "number", label: "Longitude" },
  { key: "altitudeMetres", required: false, type: "number", label: "Altitude (m)" },
  { key: "headingDegrees", required: false, type: "number", label: "Heading (deg)" },
  { key: "speedKph", required: false, type: "number", label: "Speed (km/h)" },
  { key: "engineRunning", required: false, type: "boolean", label: "Engine running" },
  { key: "engineHours", required: false, type: "number", label: "Cumulative engine hours" },
  { key: "idleHours", required: false, type: "number", label: "Cumulative idle hours" },
  { key: "odometerKm", required: false, type: "number", label: "Odometer (km)" },
  { key: "fuelLevelPercent", required: false, type: "number", label: "Fuel level (%)" },
  { key: "fuelUsedLitres", required: false, type: "number", label: "Fuel used (l)" },
  { key: "engineLoadPercent", required: false, type: "number", label: "Engine load (%)" },
  { key: "coolantTempC", required: false, type: "number", label: "Coolant temperature (C)" },
  { key: "batteryVoltage", required: false, type: "number", label: "Battery voltage" },
  { key: "defLevelPercent", required: false, type: "number", label: "DEF level (%)" },
  { key: "payloadTonnes", required: false, type: "number", label: "Payload (t)" },
  { key: "faultCodes", required: false, type: "array", label: "Active fault codes" },
] as const;

function num(
  raw: unknown,
  field: string,
  issues: TelematicsFieldIssue[],
  bounds?: { min?: number; max?: number },
): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) {
    issues.push({ field, code: "not_a_number", message: `${field}: "${String(raw)}" is not a number` });
    return null;
  }
  if (bounds?.min !== undefined && n < bounds.min) {
    issues.push({ field, code: "out_of_range", message: `${field}: ${n} is below ${bounds.min}` });
    return null;
  }
  if (bounds?.max !== undefined && n > bounds.max) {
    issues.push({ field, code: "out_of_range", message: `${field}: ${n} is above ${bounds.max}` });
    return null;
  }
  return n;
}

/**
 * Coerce one raw vendor record. Returns the typed row, or the precise
 * reasons it cannot be accepted — never a partially-populated row that would
 * read as a real reading with holes in it.
 *
 * `raw` retains the vendor payload verbatim whatever the mapper made of it,
 * which is the whole reason that column exists.
 */
export function coerceTelematicsRow(
  record: Record<string, unknown>,
  defaults: { providerKey: TelematicsProvider },
): { row: CoercedTelematicsRow; issues: [] } | { row: null; issues: TelematicsFieldIssue[] } {
  const issues: TelematicsFieldIssue[] = [];

  const deviceRaw = record["deviceId"] ?? record["device_id"] ?? record["unitId"];
  const deviceId = typeof deviceRaw === "string" ? deviceRaw.trim() : "";
  if (deviceId === "") {
    issues.push({
      field: "deviceId",
      code: "required",
      message: "deviceId is required — a reading with no device cannot ever be mapped to a machine",
    });
  }

  const recordedRaw = record["recordedAt"] ?? record["recorded_at"] ?? record["timestamp"];
  let recordedAt = "";
  if (typeof recordedRaw !== "string" && typeof recordedRaw !== "number") {
    issues.push({ field: "recordedAt", code: "required", message: "recordedAt is required" });
  } else {
    const parsed = Date.parse(String(recordedRaw));
    if (!Number.isFinite(parsed)) {
      issues.push({
        field: "recordedAt",
        code: "invalid_timestamp",
        message: `recordedAt: "${String(recordedRaw)}" is not an ISO timestamp`,
      });
    } else {
      recordedAt = new Date(parsed).toISOString();
    }
  }

  const providerRaw = record["providerKey"] ?? record["provider"] ?? defaults.providerKey;
  const providerKey = String(providerRaw).trim().toLowerCase();
  if (!(TELEMATICS_PROVIDERS as readonly string[]).includes(providerKey)) {
    issues.push({
      field: "providerKey",
      code: "unknown_enum",
      message: `providerKey "${providerKey}" is not one of: ${TELEMATICS_PROVIDERS.join(", ")}`,
    });
  }

  const engineRunningRaw = record["engineRunning"] ?? record["engine_running"];
  let engineRunning: number | null = null;
  if (engineRunningRaw !== undefined && engineRunningRaw !== null && engineRunningRaw !== "") {
    if (typeof engineRunningRaw === "boolean") engineRunning = engineRunningRaw ? 1 : 0;
    else {
      const s = String(engineRunningRaw).trim().toLowerCase();
      if (["1", "true", "on", "yes", "running"].includes(s)) engineRunning = 1;
      else if (["0", "false", "off", "no", "stopped"].includes(s)) engineRunning = 0;
      else
        issues.push({
          field: "engineRunning",
          code: "unknown_enum",
          message: `engineRunning: "${s}" is neither true nor false`,
        });
    }
  }

  const externalRaw = record["externalId"] ?? record["external_id"] ?? record["id"];
  const externalId =
    typeof externalRaw === "string" && externalRaw.trim() !== "" ? externalRaw.trim() : null;

  const latitude = num(record["latitude"] ?? record["lat"], "latitude", issues, { min: -90, max: 90 });
  const longitude = num(record["longitude"] ?? record["lon"] ?? record["lng"], "longitude", issues, {
    min: -180,
    max: 180,
  });
  const engineHours = num(record["engineHours"] ?? record["engine_hours"], "engineHours", issues, {
    min: 0,
  });
  const idleHours = num(record["idleHours"] ?? record["idle_hours"], "idleHours", issues, { min: 0 });
  const odometerKm = num(record["odometerKm"] ?? record["odometer_km"], "odometerKm", issues, {
    min: 0,
  });
  const fuelLevelPercent = num(
    record["fuelLevelPercent"] ?? record["fuel_level_percent"],
    "fuelLevelPercent",
    issues,
    { min: 0, max: 100 },
  );
  const faultCodesRaw = record["faultCodes"] ?? record["fault_codes"];
  const faultCodes = Array.isArray(faultCodesRaw) ? faultCodesRaw : [];
  if (faultCodesRaw !== undefined && faultCodesRaw !== null && !Array.isArray(faultCodesRaw)) {
    issues.push({
      field: "faultCodes",
      code: "not_an_array",
      message: "faultCodes must be an array of { code, description, severity, activeSince }",
    });
  }

  if (issues.length > 0) return { row: null, issues };

  return {
    row: {
      providerKey: providerKey as TelematicsProvider,
      deviceId,
      externalId,
      recordedAt,
      latitude,
      longitude,
      altitudeMetres: num(record["altitudeMetres"], "altitudeMetres", issues),
      headingDegrees: num(record["headingDegrees"], "headingDegrees", issues),
      speedKph: num(record["speedKph"] ?? record["speed_kph"], "speedKph", issues),
      engineRunning,
      engineHours,
      idleHours,
      odometerKm,
      fuelLevelPercent,
      fuelUsedLitres: num(record["fuelUsedLitres"] ?? record["fuel_used_litres"], "fuelUsedLitres", issues),
      engineLoadPercent: num(record["engineLoadPercent"], "engineLoadPercent", issues),
      coolantTempC: num(record["coolantTempC"], "coolantTempC", issues),
      batteryVoltage: num(record["batteryVoltage"], "batteryVoltage", issues),
      defLevelPercent: num(record["defLevelPercent"], "defLevelPercent", issues),
      payloadTonnes: num(record["payloadTonnes"], "payloadTonnes", issues),
      faultCodes,
      raw: record,
    },
    issues: [],
  };
}

/** The idempotency key. `(providerKey, deviceId, recordedAt)` is a UNIQUE
 *  index on the table, so a replayed push collides rather than doubling —
 *  this function exists so the in-batch dedupe uses the identical key. */
export function telematicsKey(providerKey: string, deviceId: string, recordedAt: string): string {
  return `${providerKey} ${deviceId} ${new Date(recordedAt).toISOString()}`;
}

/* ------------------------------------------------------------------ */
/* Cumulative-counter arithmetic                                       */
/* ------------------------------------------------------------------ */

export interface CounterReading {
  recordedAt: string;
  engineHours: number | null;
}

export interface CounterDelta {
  hours: number | null;
  firstAt: string | null;
  lastAt: string | null;
  samples: number;
  reasons: string[];
}

/**
 * Engine hours worked across a set of readings — last minus first, because
 * the field is a cumulative counter.
 *
 * Returns null with a reason for the three cases that are NOT zero hours:
 * no readings at all, a single reading (no interval to measure), and a
 * counter that decreased (a device reset or a swapped unit — real hours
 * were worked and the feed can no longer say how many).
 */
export function engineHoursFromCounter(readings: CounterReading[]): CounterDelta {
  const withHours = readings
    .filter((r): r is CounterReading & { engineHours: number } => r.engineHours !== null)
    .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
  if (withHours.length === 0) {
    return {
      hours: null,
      firstAt: null,
      lastAt: null,
      samples: 0,
      reasons: ["no telematics reading in the period carried an engine-hour counter"],
    };
  }
  const first = withHours[0]!;
  const last = withHours[withHours.length - 1]!;
  if (withHours.length === 1) {
    return {
      hours: null,
      firstAt: first.recordedAt,
      lastAt: last.recordedAt,
      samples: 1,
      reasons: [
        "only one engine-hour reading in the period — a cumulative counter needs two points " +
          "before it can state a duration",
      ],
    };
  }
  const delta = round4(last.engineHours - first.engineHours);
  if (delta < 0) {
    return {
      hours: null,
      firstAt: first.recordedAt,
      lastAt: last.recordedAt,
      samples: withHours.length,
      reasons: [
        `the engine-hour counter fell from ${first.engineHours} to ${last.engineHours} — the unit ` +
          "was reset or replaced, so the hours actually worked cannot be recovered from this feed",
      ],
    };
  }
  return {
    hours: delta,
    firstAt: first.recordedAt,
    lastAt: last.recordedAt,
    samples: withHours.length,
    reasons: [],
  };
}

/* ------------------------------------------------------------------ */
/* Reconciliation — telematics against manual (ADR 0014)               */
/* ------------------------------------------------------------------ */

/**
 * Absolute head-room, in hours, before a day's difference is treated as a
 * variance. Covers the boundary between a shift and a calendar day, warm-up
 * and shutdown, and a counter sampled a few minutes either side of midnight.
 */
export const TELEMATICS_TOLERANCE_HOURS = 1;

/**
 * Proportional head-room on top of the absolute one — claimed hours may
 * exceed telematics hours by 15% before the claim is treated as
 * unsupported. The same 1.15 the workforce reconciliation uses, and for the
 * same reason: the two streams measure adjacent, not identical, things.
 */
export const TELEMATICS_OVERCLAIM_TOLERANCE = 1.15;

/** Days of variance before it stops being noise and becomes a Signal. */
export const TELEMATICS_PERSISTENT_DAYS = 3;

export type VarianceClassification =
  | "unsupported_hours"
  | "under_reported"
  | "no_telematics"
  | "no_manual_record"
  | "ok";

export interface TelematicsDayInput {
  date: IsoDate;
  /** hours a person typed onto the utilisation row; null = no row that day */
  manualWorkingHours: number | null;
  /** engine hours from the counter delta; null = the feed cannot say */
  telematicsEngineHours: number | null;
  telematicsReasons?: string[];
}

export interface DayVariance extends TelematicsDayInput {
  varianceHours: number | null;
  ratio: number | null;
  classification: VarianceClassification;
  reason: string;
}

export interface EquipmentReconcileInput {
  equipmentId: string;
  reference: string;
  name: string;
  currency: string;
  hireRateAmount: number | null;
  hireRateUnit: HireRateUnit | null;
  operatorRateAmount: number | null;
  days: TelematicsDayInput[];
}

export interface EquipmentReconciliation {
  equipmentId: string;
  reference: string;
  name: string;
  currency: string;
  daysCompared: number;
  daysUnsupported: number;
  daysWithoutTelematics: number;
  daysWithoutManual: number;
  manualHours: number;
  telematicsHours: number;
  /** manual − telematics across the comparable days */
  varianceHours: number | null;
  ratio: number | null;
  /** true when the variance recurs across enough days to not be noise */
  persistent: boolean;
  /** money attached to the unsupported hours, null when no hourly rate exists */
  valueAtRisk: number | null;
  days: DayVariance[];
  reasons: string[];
}

export interface TelematicsReconciliationSummary {
  periodStart: IsoDate;
  periodEnd: IsoDate;
  machines: number;
  machinesWithVariance: number;
  machinesPersistent: number;
  /** bucketed by currency — never one cross-currency number */
  valueAtRiskByCurrency: Record<string, number>;
  totals: {
    manualHours: number;
    telematicsHours: number;
    varianceHours: number;
    daysCompared: number;
  };
  rows: EquipmentReconciliation[];
}

/**
 * Classify one machine-day. Conditions are evaluated independently and the
 * worst one is reported, exactly as `reconcileWorker` does:
 *
 *  - `no_manual_record`   — the machine ran (telematics says so) and nobody
 *                           filled in a utilisation row. Not a variance in
 *                           money terms, but it is missing evidence.
 *  - `no_telematics`      — hours were claimed and the feed is silent. This
 *                           is NOT evidence of an overclaim: absence of a
 *                           reading is absence of a reading.
 *  - `unsupported_hours`  — claimed hours exceed engine hours beyond both
 *                           tolerances. This is the one that costs money.
 *  - `under_reported`     — the machine ran materially longer than anyone
 *                           claimed: unbilled time, or an unauthorised user.
 */
export function classifyDay(day: TelematicsDayInput): DayVariance {
  const manual = day.manualWorkingHours;
  const tele = day.telematicsEngineHours;
  const base: Omit<DayVariance, "classification" | "reason" | "varianceHours" | "ratio"> = { ...day };

  if (manual === null && tele === null) {
    return {
      ...base,
      varianceHours: null,
      ratio: null,
      classification: "no_manual_record",
      reason: "neither stream has anything to say about this day",
    };
  }
  if (manual === null) {
    return {
      ...base,
      varianceHours: null,
      ratio: null,
      classification: "no_manual_record",
      reason:
        `telematics reports ${tele} engine hour(s) and no utilisation row was entered — the ` +
        "machine worked and nobody recorded it, so the cost has no cost code",
    };
  }
  if (tele === null) {
    return {
      ...base,
      varianceHours: null,
      ratio: null,
      classification: "no_telematics",
      reason:
        `${manual} hour(s) claimed with no engine-hour evidence for the day` +
        (day.telematicsReasons?.length ? ` (${day.telematicsReasons.join("; ")})` : "") +
        " — unverified, not disproved",
    };
  }
  const varianceHours = round2(manual - tele);
  const ratio = tele > 0 ? round2(manual / tele) : null;
  const overAbsolute = varianceHours > TELEMATICS_TOLERANCE_HOURS;
  const overRatio = tele > 0 ? manual > tele * TELEMATICS_OVERCLAIM_TOLERANCE : manual > 0;
  if (overAbsolute && overRatio) {
    return {
      ...base,
      varianceHours,
      ratio,
      classification: "unsupported_hours",
      reason:
        `${manual} hour(s) claimed against ${tele} engine hour(s) from the machine itself — ` +
        `${varianceHours} unsupported (tolerance ${TELEMATICS_TOLERANCE_HOURS}h and ` +
        `${TELEMATICS_OVERCLAIM_TOLERANCE}×)`,
    };
  }
  if (-varianceHours > TELEMATICS_TOLERANCE_HOURS && tele > manual * TELEMATICS_OVERCLAIM_TOLERANCE) {
    return {
      ...base,
      varianceHours,
      ratio,
      classification: "under_reported",
      reason:
        `the machine logged ${tele} engine hour(s) against ${manual} claimed — ` +
        `${round2(-varianceHours)} hour(s) were worked and never billed, or the machine was used ` +
        "by somebody who did not book it",
    };
  }
  return {
    ...base,
    varianceHours,
    ratio,
    classification: "ok",
    reason: `${manual} hour(s) claimed against ${tele} engine hour(s) — within tolerance`,
  };
}

/** Reconcile one machine across a period. */
export function reconcileEquipment(input: EquipmentReconcileInput): EquipmentReconciliation {
  const days = [...input.days]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(classifyDay);
  const comparable = days.filter((d) => d.varianceHours !== null);
  const manualHours = round2(
    comparable.reduce((s, d) => s + (d.manualWorkingHours ?? 0), 0),
  );
  const telematicsHours = round2(
    comparable.reduce((s, d) => s + (d.telematicsEngineHours ?? 0), 0),
  );
  const varianceHours = comparable.length > 0 ? round2(manualHours - telematicsHours) : null;
  const ratio = telematicsHours > 0 ? round2(manualHours / telematicsHours) : null;
  const daysUnsupported = days.filter((d) => d.classification === "unsupported_hours").length;
  const reasons: string[] = [];

  let valueAtRisk: number | null = null;
  const unsupportedHours = round2(
    days
      .filter((d) => d.classification === "unsupported_hours")
      .reduce((s, d) => s + (d.varianceHours ?? 0), 0),
  );
  if (unsupportedHours > 0) {
    if (input.hireRateUnit === "hour" && input.hireRateAmount !== null) {
      valueAtRisk = round2(
        unsupportedHours * (input.hireRateAmount + (input.operatorRateAmount ?? 0)),
      );
      if (input.operatorRateAmount === null) {
        reasons.push(
          "no operator rate is recorded, so the value at risk covers plant hire only — the " +
            "operator hours behind the same claim are not priced",
        );
      }
    } else {
      reasons.push(
        input.hireRateAmount === null
          ? "no hire rate is recorded on this machine, so the unsupported hours cannot be priced"
          : `hire is priced per ${input.hireRateUnit}, not per hour — unsupported HOURS cannot be ` +
            "converted to money without an hourly rate, and a guess here would be a fabricated figure",
      );
    }
  }
  if (comparable.length === 0) {
    reasons.push(
      "no day in the period had both a utilisation row and a usable engine-hour delta — there is " +
        "nothing to reconcile yet",
    );
  }

  return {
    equipmentId: input.equipmentId,
    reference: input.reference,
    name: input.name,
    currency: input.currency,
    daysCompared: comparable.length,
    daysUnsupported,
    daysWithoutTelematics: days.filter((d) => d.classification === "no_telematics").length,
    daysWithoutManual: days.filter((d) => d.classification === "no_manual_record").length,
    manualHours,
    telematicsHours,
    varianceHours,
    ratio,
    persistent: daysUnsupported >= TELEMATICS_PERSISTENT_DAYS,
    valueAtRisk,
    days,
    reasons,
  };
}

/** Reconcile a fleet. Worst first; money bucketed by currency, never summed. */
export function reconcileTelematics(
  inputs: EquipmentReconcileInput[],
  period: { periodStart: IsoDate; periodEnd: IsoDate },
): TelematicsReconciliationSummary {
  const rows = inputs.map(reconcileEquipment);
  rows.sort(
    (a, b) =>
      Number(b.persistent) - Number(a.persistent) ||
      b.daysUnsupported - a.daysUnsupported ||
      (b.varianceHours ?? 0) - (a.varianceHours ?? 0) ||
      a.reference.localeCompare(b.reference),
  );
  const valueAtRiskByCurrency: Record<string, number> = {};
  for (const r of rows) {
    if (r.valueAtRisk === null) continue;
    valueAtRiskByCurrency[r.currency] = round2(
      (valueAtRiskByCurrency[r.currency] ?? 0) + r.valueAtRisk,
    );
  }
  return {
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    machines: rows.length,
    machinesWithVariance: rows.filter((r) => r.daysUnsupported > 0).length,
    machinesPersistent: rows.filter((r) => r.persistent).length,
    valueAtRiskByCurrency,
    totals: {
      manualHours: round2(rows.reduce((s, r) => s + r.manualHours, 0)),
      telematicsHours: round2(rows.reduce((s, r) => s + r.telematicsHours, 0)),
      varianceHours: round2(rows.reduce((s, r) => s + (r.varianceHours ?? 0), 0)),
      daysCompared: rows.reduce((s, r) => s + r.daysCompared, 0),
    },
    rows,
  };
}
